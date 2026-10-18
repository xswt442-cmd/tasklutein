"""Read archived task snapshots and clear one task's business history."""
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi import status as http_status
from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from ..auth import Principal, require_principal, require_user_principal
from ..database import get_db
from ..models import Activity, Report, Task
from ..report_views import report_page
from ..schemas import ArchivedTaskList, ArchivedTaskView, ReportList

router = APIRouter(prefix="/api/history/tasks", tags=["history"])


def find_archived_task(db: Session, task_id: UUID, workspace_id: UUID) -> Task:
    task = db.scalar(
        select(Task).where(
            Task.id == task_id,
            Task.workspace_id == workspace_id,
            Task.archived_at.is_not(None),
        )
    )
    if task is None:
        raise HTTPException(status_code=404, detail="task_not_found")
    return task


@router.get("", response_model=ArchivedTaskList)
def list_archived_tasks(
    q: str | None = Query(default=None, max_length=200),
    limit: int = Query(default=25, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    principal: Principal = Depends(require_principal),
):
    filters = [Task.workspace_id == principal.workspace_id, Task.archived_at.is_not(None)]
    if q and q.strip():
        search = q.strip()
        filters.append(
            or_(Task.title.icontains(search, autoescape=True), Task.description.icontains(search, autoescape=True))
        )
    tasks = db.scalars(
        select(Task)
        .where(*filters)
        .order_by(Task.archived_at.desc(), Task.id.desc())
        .offset(offset)
        .limit(limit)
    ).all()
    total = db.scalar(select(func.count(Task.id)).where(*filters)) or 0
    return {"tasks": tasks, "total": total, "limit": limit, "offset": offset}


@router.get("/{task_id}", response_model=dict)
def get_archived_task(
    task_id: UUID,
    db: Session = Depends(get_db),
    principal: Principal = Depends(require_principal),
):
    task = find_archived_task(db, task_id, principal.workspace_id)
    return {"task": ArchivedTaskView.model_validate(task)}


@router.get("/{task_id}/reports", response_model=ReportList)
def list_archived_reports(
    task_id: UUID,
    limit: int = Query(default=100, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    principal: Principal = Depends(require_principal),
):
    task = find_archived_task(db, task_id, principal.workspace_id)
    return report_page(db, task.id, limit=limit, offset=offset)


@router.delete("/{task_id}", status_code=http_status.HTTP_204_NO_CONTENT)
def clear_task_history(
    task_id: UUID,
    db: Session = Depends(get_db),
    principal: Principal = Depends(require_user_principal),
):
    task = db.scalar(
        select(Task)
        .where(Task.id == task_id, Task.workspace_id == principal.workspace_id)
        .with_for_update()
    )
    if task is None:
        raise HTTPException(status_code=404, detail="task_not_found")

    if task.archived_at is not None:
        db.delete(task)
    else:
        db.execute(delete(Report).where(Report.task_id == task.id))
        db.execute(delete(Activity).where(Activity.task_id == task.id, Activity.workspace_id == principal.workspace_id))
    db.commit()
    return Response(status_code=http_status.HTTP_204_NO_CONTENT)
