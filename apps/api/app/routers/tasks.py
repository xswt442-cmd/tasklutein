"""Task CRUD endpoints."""
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi import status as http_status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..activity import record_activity
from ..auth import Principal, require_principal, require_user_principal
from ..database import get_db
from ..models import Task, utc_now
from ..schemas import TaskCreate, TaskList, TaskSort, TaskStatus, TaskUpdate, TaskView

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


def find_task(db: Session, task_id: UUID, workspace_id: UUID, *, lock: bool = False) -> Task:
    statement = select(Task).where(
        Task.id == task_id,
        Task.workspace_id == workspace_id,
        Task.archived_at.is_(None),
    )
    if lock:
        statement = statement.with_for_update()
    task = db.scalar(statement)
    if task is None:
        raise HTTPException(status_code=404, detail="task_not_found")
    return task


@router.get("", response_model=TaskList)
def list_tasks(
    status: TaskStatus | None = None,
    q: str | None = Query(default=None, max_length=200),
    sort: TaskSort = "updated_desc",
    limit: int | None = Query(default=None, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    principal: Principal = Depends(require_principal),
):
    filters = [Task.workspace_id == principal.workspace_id, Task.archived_at.is_(None)]
    if status is not None:
        filters.append(Task.status == status)
    if q and q.strip():
        search = q.strip()
        filters.append(
            or_(Task.title.icontains(search, autoescape=True), Task.description.icontains(search, autoescape=True))
        )
    effective_limit = limit if limit is not None else 200
    order = Task.updated_at.desc() if sort == "updated_desc" else Task.created_at.desc()
    tasks = db.scalars(
        select(Task)
        .where(*filters)
        .order_by(order, Task.id.desc())
        .offset(offset)
        .limit(effective_limit)
    ).all()
    total = db.scalar(select(func.count(Task.id)).where(*filters)) or 0
    return {"tasks": tasks, "total": total, "limit": effective_limit, "offset": offset}


@router.post("", response_model=dict, status_code=http_status.HTTP_201_CREATED)
def create_task(
    payload: TaskCreate,
    request: Request,
    db: Session = Depends(get_db),
    principal: Principal = Depends(require_principal),
):
    task = Task(**payload.model_dump(), workspace_id=principal.workspace_id)
    db.add(task)
    db.flush()
    record_activity(
        db,
        request,
        principal,
        task,
        "task.created",
        {"changed_fields": ["title", "description", "status"], "status_after": task.status},
    )
    db.commit()
    db.refresh(task)
    return {"task": TaskView.model_validate(task)}


@router.get("/{task_id}", response_model=dict)
def get_task(
    task_id: UUID,
    db: Session = Depends(get_db),
    principal: Principal = Depends(require_principal),
):
    return {"task": TaskView.model_validate(find_task(db, task_id, principal.workspace_id))}


@router.patch("/{task_id}", response_model=dict)
def update_task(
    task_id: UUID,
    payload: TaskUpdate,
    request: Request,
    db: Session = Depends(get_db),
    principal: Principal = Depends(require_principal),
):
    task = find_task(db, task_id, principal.workspace_id, lock=True)
    requested = payload.model_dump(exclude_unset=True)
    changed_fields = [
        field for field in ("title", "description", "status")
        if field in requested and getattr(task, field) != requested[field]
    ]
    if not changed_fields:
        return {"task": TaskView.model_validate(task)}

    status_before = task.status
    for field in changed_fields:
        setattr(task, field, requested[field])
    task.updated_at = datetime.now(UTC)
    if task.status != status_before:
        event_type = "task.status_changed"
        summary = {
            "changed_fields": changed_fields,
            "status_before": status_before,
            "status_after": task.status,
        }
    else:
        event_type = "task.updated"
        summary = {"changed_fields": changed_fields}
    record_activity(db, request, principal, task, event_type, summary)
    db.commit()
    db.refresh(task)
    return {"task": TaskView.model_validate(task)}


@router.delete("/{task_id}", status_code=http_status.HTTP_204_NO_CONTENT)
def delete_task(
    task_id: UUID,
    request: Request,
    history: Literal["keep", "delete"] = Query(default="delete"),
    db: Session = Depends(get_db),
    principal: Principal = Depends(require_user_principal),
):
    task = find_task(db, task_id, principal.workspace_id, lock=True)
    if history == "keep":
        task.archived_at = utc_now()
        record_activity(db, request, principal, task, "task.deleted", {"status": task.status})
    else:
        db.delete(task)
    db.commit()
    return Response(status_code=http_status.HTTP_204_NO_CONTENT)
