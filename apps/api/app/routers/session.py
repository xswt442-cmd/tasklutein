"""Browser session provisioning and current-account details."""
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from ..auth import (
    Principal,
    provision_user_workspace,
    require_access_identity,
    require_user_principal,
)
from ..database import get_db
from ..models import User, Workspace

router = APIRouter(prefix="/api", tags=["session"])


def session_view(user: User, workspace: Workspace) -> dict[str, object]:
    return {
        "user": {
            "id": str(user.id),
            "email": user.email,
            "created_at": user.created_at,
        },
        "workspace": {
            "id": str(workspace.id),
            "name": workspace.name,
            "created_at": workspace.created_at,
        },
    }


@router.post("/session/bootstrap")
def bootstrap_session(
    request: Request,
    db: Session = Depends(get_db),
):
    user, workspace = provision_user_workspace(db, require_access_identity(request))
    return session_view(user, workspace)


@router.get("/me")
def get_current_user(
    principal: Principal = Depends(require_user_principal),
    db: Session = Depends(get_db),
):
    user = db.get(User, principal.user_id)
    workspace = db.get(Workspace, principal.workspace_id)
    if user is None or workspace is None:
        raise HTTPException(status_code=401, detail="session_bootstrap_required")
    return session_view(user, workspace)
