"""Task CRUD endpoints."""
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi import status as http_status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import Actor, require_actor
from ..database import get_db
from ..models import Task
from ..schemas import TaskCreate, TaskList, TaskStatus, TaskUpdate, TaskView

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


def find_task(db: Session, task_id: UUID) -> Task:
    task = db.get(Task, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task_not_found")
    return task


@router.get("", response_model=TaskList)
def list_tasks(
    status: TaskStatus | None = None,
    db: Session = Depends(get_db),
    _actor: Actor = Depends(require_actor),
):
    statement = select(Task).order_by(Task.updated_at.desc()).limit(200)
    if status is not None:
        statement = statement.where(Task.status == status)
    return {"tasks": db.scalars(statement).all()}


@router.post("", response_model=dict, status_code=http_status.HTTP_201_CREATED)
def create_task(
    payload: TaskCreate,
    db: Session = Depends(get_db),
    _actor: Actor = Depends(require_actor),
):
    task = Task(**payload.model_dump())
    db.add(task)
    db.commit()
    db.refresh(task)
    return {"task": TaskView.model_validate(task)}


@router.get("/{task_id}", response_model=dict)
def get_task(
    task_id: UUID,
    db: Session = Depends(get_db),
    _actor: Actor = Depends(require_actor),
):
    return {"task": TaskView.model_validate(find_task(db, task_id))}


@router.patch("/{task_id}", response_model=dict)
def update_task(
    task_id: UUID,
    payload: TaskUpdate,
    db: Session = Depends(get_db),
    _actor: Actor = Depends(require_actor),
):
    task = find_task(db, task_id)
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
    _actor: Actor = Depends(require_actor),
):
    task = find_task(db, task_id)
    db.delete(task)
    db.commit()
    return Response(status_code=http_status.HTTP_204_NO_CONTENT)
