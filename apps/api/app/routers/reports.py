"""Progress reports associated with tasks."""
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth import Actor, require_actor
from ..database import get_db
from ..models import Report
from ..schemas import ReportCreate, ReportList, ReportView
from .tasks import find_task

router = APIRouter(prefix="/api/tasks/{task_id}/reports", tags=["reports"])


@router.get("", response_model=ReportList)
def list_reports(
    task_id: UUID,
    limit: int | None = Query(default=None, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    _actor: Actor = Depends(require_actor),
):
    find_task(db, task_id)
    effective_limit = limit if limit is not None else 100
    statement = select(Report).where(Report.task_id == task_id)
    records = db.scalars(
        statement
        .order_by(Report.created_at.desc(), Report.id.desc())
        .offset(offset)
        .limit(effective_limit)
    ).all()
    total = db.scalar(select(func.count(Report.id)).where(Report.task_id == task_id)) or 0
    return {"reports": records, "total": total, "limit": effective_limit, "offset": offset}


@router.post("", response_model=dict, status_code=201)
def create_report(
    task_id: UUID,
    payload: ReportCreate,
    db: Session = Depends(get_db),
    actor: Actor = Depends(require_actor),
):
    find_task(db, task_id)
    report = Report(task_id=task_id, content=payload.content, source=actor)
    db.add(report)
    db.commit()
    db.refresh(report)
    return {"report": ReportView.model_validate(report)}
