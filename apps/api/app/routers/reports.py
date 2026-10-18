"""Progress reports associated with tasks."""
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from ..activity import record_activity
from ..auth import Principal, require_principal
from ..database import get_db
from ..models import Report
from ..report_views import report_page, report_view
from ..schemas import ReportCreate, ReportList
from .tasks import find_task

router = APIRouter(prefix="/api/tasks/{task_id}/reports", tags=["reports"])


@router.get("", response_model=ReportList)
def list_reports(
    task_id: UUID,
    limit: int | None = Query(default=None, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    principal: Principal = Depends(require_principal),
):
    find_task(db, task_id, principal.workspace_id)
    effective_limit = limit if limit is not None else 100
    return report_page(db, task_id, limit=effective_limit, offset=offset)


@router.post("", response_model=dict, status_code=201)
def create_report(
    task_id: UUID,
    payload: ReportCreate,
    request: Request,
    db: Session = Depends(get_db),
    principal: Principal = Depends(require_principal),
):
    task = find_task(db, task_id, principal.workspace_id, lock=True)
    report = Report(
        task_id=task_id,
        content=payload.content,
        source=principal.actor_type,
        actor_user_id=principal.user_id,
        agent_token_id=principal.agent_token_id,
    )
    db.add(report)
    db.flush()
    record_activity(db, request, principal, task, "report.created", {"report_id": str(report.id)})
    db.commit()
    db.refresh(report)
    actor_name = principal.agent_token_name if principal.actor_type == "agent" else principal.email
    return {"report": report_view(report, actor_name)}
