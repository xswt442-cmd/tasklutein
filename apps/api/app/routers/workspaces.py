"""Workspace selection, membership, and invitation operations."""
from dataclasses import replace
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..activity import record_activity
from ..auth import Principal, require_user_principal
from ..database import get_db
from ..models import Task, User, Workspace, WorkspaceInvitation, WorkspaceMember
from ..schemas import WorkspaceCreate, WorkspaceInvitationCreate

router = APIRouter(prefix="/api", tags=["workspaces"])


def _membership(db: Session, workspace_id: UUID, user_id: UUID) -> WorkspaceMember:
    membership = db.get(WorkspaceMember, (workspace_id, user_id))
    if membership is None:
        raise HTTPException(status_code=404, detail="workspace_not_found")
    return membership


def _team_workspace(db: Session, workspace_id: UUID) -> Workspace:
    workspace = db.get(Workspace, workspace_id)
    if workspace is None or workspace.kind != "team":
        raise HTTPException(status_code=404, detail="workspace_not_found")
    return workspace


def _owner(db: Session, workspace_id: UUID, user_id: UUID) -> Workspace:
    workspace = _team_workspace(db, workspace_id)
    if _membership(db, workspace_id, user_id).role != "owner":
        raise HTTPException(status_code=404, detail="workspace_not_found")
    return workspace


def _invitation_view(db: Session, invitation: WorkspaceInvitation) -> dict[str, object]:
    workspace = db.get(Workspace, invitation.workspace_id)
    invitee = db.get(User, invitation.invitee_user_id)
    inviter = db.get(User, invitation.invited_by_user_id)
    return {
        "id": str(invitation.id),
        "workspace_id": str(invitation.workspace_id),
        "workspace_name": workspace.name if workspace else "",
        "invitee_user_id": str(invitation.invitee_user_id),
        "invitee_email": invitee.email if invitee else "",
        "invited_by_email": inviter.email if inviter else "",
        "status": invitation.status,
        "created_at": invitation.created_at,
        "responded_at": invitation.responded_at,
    }


@router.get("/workspaces")
def list_workspaces(
    principal: Principal = Depends(require_user_principal),
    db: Session = Depends(get_db),
):
    rows = db.execute(
        select(Workspace, WorkspaceMember.role)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .where(WorkspaceMember.user_id == principal.user_id)
        .order_by(Workspace.kind, Workspace.name, Workspace.id)
    ).all()
    return {
        "workspaces": [
            {
                "id": str(workspace.id),
                "name": workspace.name,
                "kind": workspace.kind,
                "role": role,
            }
            for workspace, role in rows
        ],
        "current_workspace_id": str(principal.workspace_id),
    }


@router.post("/workspaces", status_code=201)
def create_workspace(
    payload: WorkspaceCreate,
    principal: Principal = Depends(require_user_principal),
    db: Session = Depends(get_db),
):
    workspace = Workspace(owner_id=principal.user_id, name=payload.name, kind="team")
    db.add(workspace)
    db.flush()
    db.add(WorkspaceMember(workspace_id=workspace.id, user_id=principal.user_id, role="owner"))
    db.commit()
    db.refresh(workspace)
    return {
        "workspace": {
            "id": str(workspace.id),
            "name": workspace.name,
            "kind": workspace.kind,
            "role": "owner",
        }
    }


@router.get("/workspaces/{workspace_id}/members")
def list_members(
    workspace_id: UUID,
    principal: Principal = Depends(require_user_principal),
    db: Session = Depends(get_db),
):
    _membership(db, workspace_id, principal.user_id)
    _team_workspace(db, workspace_id)
    rows = db.execute(
        select(WorkspaceMember, User.email)
        .join(User, User.id == WorkspaceMember.user_id)
        .where(WorkspaceMember.workspace_id == workspace_id)
        .order_by(WorkspaceMember.role, User.email, User.id)
    ).all()
    return {
        "members": [
            {
                "user_id": str(member.user_id),
                "email": email,
                "role": member.role,
                "joined_at": member.joined_at,
            }
            for member, email in rows
        ]
    }


@router.get("/workspaces/{workspace_id}/invitations")
def list_workspace_invitations(
    workspace_id: UUID,
    principal: Principal = Depends(require_user_principal),
    db: Session = Depends(get_db),
):
    _owner(db, workspace_id, principal.user_id)
    invitations = db.scalars(
        select(WorkspaceInvitation)
        .where(WorkspaceInvitation.workspace_id == workspace_id)
        .order_by(WorkspaceInvitation.created_at.desc(), WorkspaceInvitation.id.desc())
    ).all()
    return {"invitations": [_invitation_view(db, invitation) for invitation in invitations]}


@router.post("/workspaces/{workspace_id}/invitations", status_code=201)
def create_invitation(
    workspace_id: UUID,
    payload: WorkspaceInvitationCreate,
    principal: Principal = Depends(require_user_principal),
    db: Session = Depends(get_db),
):
    _owner(db, workspace_id, principal.user_id)
    invitee = db.scalar(select(User).where(func.lower(User.email) == payload.email))
    if invitee is None:
        raise HTTPException(status_code=404, detail="registered_user_not_found")
    if invitee.id == principal.user_id or db.get(WorkspaceMember, (workspace_id, invitee.id)) is not None:
        raise HTTPException(status_code=409, detail="user_already_member")
    invitation = WorkspaceInvitation(
        workspace_id=workspace_id,
        invitee_user_id=invitee.id,
        invited_by_user_id=principal.user_id,
    )
    db.add(invitation)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="invitation_already_pending") from exc
    db.refresh(invitation)
    return {"invitation": _invitation_view(db, invitation)}


@router.get("/invitations")
def list_my_invitations(
    principal: Principal = Depends(require_user_principal),
    db: Session = Depends(get_db),
):
    invitations = db.scalars(
        select(WorkspaceInvitation)
        .where(WorkspaceInvitation.invitee_user_id == principal.user_id)
        .order_by(WorkspaceInvitation.created_at.desc(), WorkspaceInvitation.id.desc())
    ).all()
    return {"invitations": [_invitation_view(db, invitation) for invitation in invitations]}


def _respond_to_invitation(
    invitation_id: UUID,
    status: str,
    principal: Principal,
    db: Session,
) -> dict[str, object]:
    invitation = db.scalar(
        select(WorkspaceInvitation)
        .where(
            WorkspaceInvitation.id == invitation_id,
            WorkspaceInvitation.invitee_user_id == principal.user_id,
            WorkspaceInvitation.status == "pending",
        )
        .with_for_update()
    )
    if invitation is None:
        raise HTTPException(status_code=404, detail="invitation_not_found")
    if db.get(WorkspaceMember, (invitation.workspace_id, principal.user_id)) is not None:
        raise HTTPException(status_code=409, detail="user_already_member")
    if status == "accepted":
        _team_workspace(db, invitation.workspace_id)
        db.add(WorkspaceMember(workspace_id=invitation.workspace_id, user_id=principal.user_id, role="member"))
    invitation.status = status
    invitation.responded_at = datetime.now(UTC)
    db.commit()
    return {"invitation": _invitation_view(db, invitation)}


@router.post("/invitations/{invitation_id}/accept")
def accept_invitation(
    invitation_id: UUID,
    principal: Principal = Depends(require_user_principal),
    db: Session = Depends(get_db),
):
    return _respond_to_invitation(invitation_id, "accepted", principal, db)


@router.post("/invitations/{invitation_id}/decline")
def decline_invitation(
    invitation_id: UUID,
    principal: Principal = Depends(require_user_principal),
    db: Session = Depends(get_db),
):
    return _respond_to_invitation(invitation_id, "declined", principal, db)


@router.delete("/workspaces/{workspace_id}/members/{user_id}", status_code=204)
def remove_member(
    workspace_id: UUID,
    user_id: UUID,
    request: Request,
    principal: Principal = Depends(require_user_principal),
    db: Session = Depends(get_db),
):
    _owner(db, workspace_id, principal.user_id)
    if user_id == principal.user_id:
        raise HTTPException(status_code=409, detail="workspace_owner_cannot_leave")
    member = db.scalar(
        select(WorkspaceMember)
        .where(
            WorkspaceMember.workspace_id == workspace_id,
            WorkspaceMember.user_id == user_id,
        )
        .with_for_update()
    )
    if member is None or member.role != "member":
        raise HTTPException(status_code=404, detail="workspace_member_not_found")
    tasks = db.scalars(
        select(Task)
        .where(Task.workspace_id == workspace_id, Task.assignee_user_id == user_id)
        .order_by(Task.id)
        .with_for_update()
    ).all()
    now = datetime.now(UTC)
    activity_principal = replace(principal, workspace_id=workspace_id, workspace_role="owner")
    for task in tasks:
        task.assignee_user_id = None
        task.version += 1
        task.updated_at = now
        record_activity(
            db,
            request,
            activity_principal,
            task,
            "task.updated",
            {"changed_fields": ["assignee_user_id"]},
        )
    db.delete(member)
    db.commit()
    return Response(status_code=204)
