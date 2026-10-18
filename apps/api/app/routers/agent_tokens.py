"""Per-user Agent keys and the MCP identity endpoint."""
import secrets
from datetime import UTC, datetime
from hashlib import sha256
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import Principal, require_agent_principal, require_user_principal
from ..database import get_db
from ..models import AgentToken
from ..schemas import AgentTokenCreate, AgentTokenUpdate

router = APIRouter(prefix="/api", tags=["agent credentials"])
DISPLAY_PREFIX_LENGTH = len("tlu_") + 3


def token_view(token: AgentToken) -> dict[str, object]:
    return {
        "id": str(token.id),
        "name": token.name,
        "prefix": token.prefix[:DISPLAY_PREFIX_LENGTH],
        "created_at": token.created_at,
        "expires_at": token.expires_at,
        "revoked_at": token.revoked_at,
    }


@router.get("/agent-tokens")
def list_agent_tokens(
    principal: Principal = Depends(require_user_principal),
    db: Session = Depends(get_db),
):
    tokens = db.scalars(
        select(AgentToken)
        .where(AgentToken.workspace_id == principal.workspace_id)
        .order_by(AgentToken.created_at.desc(), AgentToken.id.desc())
    ).all()
    return {"tokens": [token_view(token) for token in tokens]}


@router.post("/agent-tokens", status_code=201)
def create_agent_token(
    payload: AgentTokenCreate,
    principal: Principal = Depends(require_user_principal),
    db: Session = Depends(get_db),
):
    secret = "tlu_" + secrets.token_urlsafe(32)
    token = AgentToken(
        workspace_id=principal.workspace_id,
        created_by=principal.user_id,
        name=payload.name,
        token_hash=sha256(secret.encode("utf-8")).hexdigest(),
        prefix=secret[:DISPLAY_PREFIX_LENGTH],
        expires_at=payload.expires_at,
    )
    db.add(token)
    db.commit()
    db.refresh(token)
    return {"token": token_view(token), "secret": secret}


@router.patch("/agent-tokens/{token_id}")
def update_agent_token(
    token_id: UUID,
    payload: AgentTokenUpdate,
    principal: Principal = Depends(require_user_principal),
    db: Session = Depends(get_db),
):
    token = db.scalar(
        select(AgentToken)
        .where(
            AgentToken.id == token_id,
            AgentToken.workspace_id == principal.workspace_id,
        )
        .with_for_update()
    )
    if token is None:
        raise HTTPException(status_code=404, detail="agent_token_not_found")
    if token.revoked_at is not None:
        raise HTTPException(status_code=409, detail="agent_token_revoked")

    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(token, field, value)
    db.commit()
    db.refresh(token)
    return {"token": token_view(token)}


@router.delete("/agent-tokens/{token_id}", status_code=204)
def revoke_agent_token(
    token_id: UUID,
    principal: Principal = Depends(require_user_principal),
    db: Session = Depends(get_db),
):
    token = db.scalar(
        select(AgentToken).where(
            AgentToken.id == token_id,
            AgentToken.workspace_id == principal.workspace_id,
        )
    )
    if token is None:
        raise HTTPException(status_code=404, detail="agent_token_not_found")
    if token.revoked_at is None:
        token.revoked_at = datetime.now(UTC)
        db.commit()
    return Response(status_code=204)


@router.get("/agent/whoami")
def agent_whoami(principal: Principal = Depends(require_agent_principal)):
    return {
        "user_id": str(principal.user_id),
        "workspace_id": str(principal.workspace_id),
        "agent_token_id": str(principal.agent_token_id),
        "agent_token_name": principal.agent_token_name,
    }
