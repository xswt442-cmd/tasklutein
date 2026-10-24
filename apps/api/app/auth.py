"""Request principals derived from the trusted Worker identity or Agent keys."""
import hmac
import os
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from hashlib import sha256
from typing import Literal
from uuid import UUID

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .database import get_db
from .models import AgentToken, User, Workspace, WorkspaceMember

ActorType = Literal["user", "agent"]
security = HTTPBearer(auto_error=False)
_EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


@dataclass(frozen=True)
class AccessIdentity:
    issuer: str
    subject: str
    email: str


@dataclass(frozen=True)
class Principal:
    actor_type: ActorType
    user_id: UUID
    workspace_id: UUID
    agent_token_id: UUID | None
    agent_token_name: str | None
    email: str
    workspace_role: Literal["owner", "member"]


def provision_user_workspace(db: Session, identity: AccessIdentity) -> tuple[User, Workspace]:
    user = db.scalar(
        select(User).where(
            User.access_issuer == identity.issuer,
            User.access_subject == identity.subject,
        )
    )
    if user is None:
        user = User(
            access_issuer=identity.issuer,
            access_subject=identity.subject,
            email=identity.email,
        )
        db.add(user)
        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            user = db.scalar(
                select(User).where(
                    User.access_issuer == identity.issuer,
                    User.access_subject == identity.subject,
                )
            )
            if user is None:
                raise

    if user.disabled_at is not None:
        db.rollback()
        raise HTTPException(status_code=403, detail="user_disabled")

    workspace = db.scalar(
        select(Workspace).where(Workspace.owner_id == user.id, Workspace.kind == "personal")
    )
    if workspace is None:
        workspace = Workspace(owner_id=user.id, name="Personal workspace", kind="personal")
        db.add(workspace)
        try:
            db.flush()
            db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role="owner"))
            db.flush()
        except IntegrityError as exc:
            db.rollback()
            user = db.scalar(
                select(User).where(
                    User.access_issuer == identity.issuer,
                    User.access_subject == identity.subject,
                )
            )
            if user is None:
                raise
            if user.disabled_at is not None:
                raise HTTPException(status_code=403, detail="user_disabled") from exc
            workspace = db.scalar(select(Workspace).where(Workspace.owner_id == user.id))
            if workspace is None:
                raise
    membership = db.get(WorkspaceMember, (workspace.id, user.id))
    if membership is None:
        membership = WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role="owner")
        db.add(membership)

    if user.email != identity.email:
        user.email = identity.email
    db.commit()
    db.refresh(user)
    db.refresh(workspace)
    return user, workspace


def require_access_identity(request: Request) -> AccessIdentity:
    if not getattr(request.state, "gateway_verified", False):
        raise HTTPException(status_code=403, detail="invalid_gateway")

    issuer = request.headers.get("X-Tasklutein-Access-Issuer", "")
    subject = request.headers.get("X-Tasklutein-Access-Subject", "")
    email = request.headers.get("X-Tasklutein-Access-Email", "").strip().lower()
    if (
        not issuer.startswith("https://")
        or len(issuer) > 512
        or not subject
        or len(subject) > 255
        or not _EMAIL.fullmatch(email)
        or len(email) > 320
    ):
        raise HTTPException(status_code=401, detail="unauthorized")

    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        allowed_origins = {
            origin.strip()
            for origin in os.getenv("WEB_ORIGINS", "http://localhost:5173").split(",")
            if origin.strip()
        }
        if request.headers.get("Origin") not in allowed_origins:
            raise HTTPException(status_code=403, detail="origin_not_allowed")

    return AccessIdentity(issuer=issuer, subject=subject, email=email)


def _user_principal(db: Session, identity: AccessIdentity, request: Request) -> Principal:
    user = db.scalar(
        select(User).where(
            User.access_issuer == identity.issuer,
            User.access_subject == identity.subject,
        )
    )
    if user is None:
        raise HTTPException(status_code=401, detail="session_bootstrap_required")
    if user.disabled_at is not None:
        raise HTTPException(status_code=403, detail="user_disabled")

    selected = request.headers.get("X-Tasklutein-Workspace-ID")
    if selected:
        try:
            workspace_id = UUID(selected)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid_workspace_id") from exc
        membership = db.get(WorkspaceMember, (workspace_id, user.id))
        workspace = db.get(Workspace, workspace_id) if membership is not None else None
        if workspace is None:
            raise HTTPException(status_code=404, detail="workspace_not_found")
    else:
        workspace = db.scalar(
            select(Workspace)
            .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
            .where(WorkspaceMember.user_id == user.id, Workspace.kind == "personal")
        )
        membership = db.get(WorkspaceMember, (workspace.id, user.id)) if workspace is not None else None
        if workspace is None or membership is None:
            raise HTTPException(status_code=403, detail="workspace_not_configured")
    return Principal(
        actor_type="user",
        user_id=user.id,
        workspace_id=workspace.id,
        agent_token_id=None,
        agent_token_name=None,
        email=user.email,
        workspace_role=membership.role,
    )


def _agent_principal(db: Session, token: str) -> Principal:
    digest = sha256(token.encode("utf-8")).digest()
    token_hash = digest.hex()
    agent_token = db.scalar(select(AgentToken).where(AgentToken.token_hash == token_hash))
    if agent_token is None:
        raise HTTPException(status_code=401, detail="unauthorized", headers={"WWW-Authenticate": "Bearer"})

    try:
        stored_digest = bytes.fromhex(agent_token.token_hash)
    except ValueError:
        stored_digest = b""
    if len(stored_digest) != len(digest) or not hmac.compare_digest(stored_digest, digest):
        raise HTTPException(status_code=401, detail="unauthorized", headers={"WWW-Authenticate": "Bearer"})

    now = datetime.now(UTC)
    expires_at = agent_token.expires_at
    if expires_at is not None and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=UTC)
    if agent_token.revoked_at is not None or (expires_at is not None and expires_at <= now):
        raise HTTPException(status_code=401, detail="unauthorized", headers={"WWW-Authenticate": "Bearer"})

    user = db.get(User, agent_token.created_by)
    workspace = db.get(Workspace, agent_token.workspace_id)
    membership = db.get(WorkspaceMember, (agent_token.workspace_id, agent_token.created_by))
    if user is None or workspace is None or membership is None:
        raise HTTPException(status_code=401, detail="unauthorized", headers={"WWW-Authenticate": "Bearer"})
    if user.disabled_at is not None:
        raise HTTPException(status_code=403, detail="user_disabled")

    return Principal(
        actor_type="agent",
        user_id=user.id,
        workspace_id=workspace.id,
        agent_token_id=agent_token.id,
        agent_token_name=agent_token.name,
        email=user.email,
        workspace_role=membership.role,
    )


def require_principal(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    db: Session = Depends(get_db),
) -> Principal:
    if credentials is not None:
        if credentials.scheme.lower() != "bearer":
            raise HTTPException(status_code=401, detail="unauthorized")
        principal = _agent_principal(db, credentials.credentials)
        selected = request.headers.get("X-Tasklutein-Workspace-ID")
        if selected:
            try:
                workspace_id = UUID(selected)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail="invalid_workspace_id") from exc
            if workspace_id != principal.workspace_id:
                raise HTTPException(status_code=404, detail="workspace_not_found")
        return principal
    return _user_principal(db, require_access_identity(request), request)


def require_user_principal(principal: Principal = Depends(require_principal)) -> Principal:
    if principal.actor_type != "user":
        raise HTTPException(status_code=403, detail="user_identity_required")
    return principal


def require_agent_principal(principal: Principal = Depends(require_principal)) -> Principal:
    if principal.actor_type != "agent":
        raise HTTPException(status_code=401, detail="agent_key_required", headers={"WWW-Authenticate": "Bearer"})
    return principal
