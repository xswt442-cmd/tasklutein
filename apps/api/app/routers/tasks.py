"""Task CRUD endpoints."""
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi import status as http_status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..auth import Principal, require_principal
from ..database import get_db
from ..models import Task
from ..schemas import TaskCreate, TaskList, TaskSort, TaskStatus, TaskUpdate, TaskView

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


def find_task(db: Session, task_id: UUID, workspace_id: UUID) -> Task:
    task = db.scalar(select(Task).where(Task.id == task_id, Task.workspace_id == workspace_id))
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
    filters = [Task.workspace_id == principal.workspace_id]
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
    db: Session = Depends(get_db),
    principal: Principal = Depends(require_principal),
):
    task = Task(**payload.model_dump(), workspace_id=principal.workspace_id)
    db.add(task)
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
    db: Session = Depends(get_db),
    principal: Principal = Depends(require_principal),
):
    task = find_task(db, task_id, principal.workspace_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(task, field, value)
    task.updated_at = datetime.now(UTC)
    db.commit()
    db.refresh(task)
    return {"task": TaskView.model_validate(task)}


@router.delete("/{task_id}", status_code=http_status.HTTP_204_NO_CONTENT)
def delete_task(
    task_id: UUID,
    db: Session = Depends(get_db),
    principal: Principal = Depends(require_principal),
):
    task = find_task(db, task_id, principal.workspace_id)
    db.delete(task)
    db.commit()
    return Response(status_code=http_status.HTTP_204_NO_CONTENT)
