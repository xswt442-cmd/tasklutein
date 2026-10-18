"""Workspace-scoped activity history."""
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from fastapi import status as http_status
from fastapi.exceptions import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..activity import activity_page
from ..auth import Principal, require_principal, require_user_principal
from ..database import get_db
from ..models import Activity
from ..schemas import ActivityActorType, ActivityEventType, ActivityList

router = APIRouter(prefix="/api/activity", tags=["activity"])


@router.get("", response_model=ActivityList)
def list_activities(
    event_type: ActivityEventType | None = None,
    source: ActivityActorType | None = None,
    task_id: UUID | None = None,
    limit: int = Query(default=100, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    principal: Principal = Depends(require_principal),
):
    return activity_page(
        db,
        principal.workspace_id,
        event_type=event_type,
        source=source,
        task_id=task_id,
        limit=limit,
        offset=offset,
    )


@router.delete("/{event_id}", status_code=http_status.HTTP_204_NO_CONTENT)
def delete_activity(
    event_id: UUID,
    db: Session = Depends(get_db),
    principal: Principal = Depends(require_user_principal),
):
    activity = db.scalar(
        select(Activity).where(Activity.id == event_id, Activity.workspace_id == principal.workspace_id)
    )
    if activity is None:
        raise HTTPException(status_code=404, detail="activity_not_found")
    db.delete(activity)
    db.commit()
    return Response(status_code=http_status.HTTP_204_NO_CONTENT)
