"""Workspace overview metrics."""
from datetime import UTC, datetime

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth import Principal, require_principal
from ..database import get_db
from ..models import Task
from ..schemas import TaskStatus

router = APIRouter(prefix="/api/overview", tags=["overview"])


@router.get("")
def get_overview(
    db: Session = Depends(get_db),
    principal: Principal = Depends(require_principal),
):
    by_status = {status: 0 for status in TaskStatus.__args__}
    counts = db.execute(
        select(Task.status, func.count(Task.id))
        .where(Task.workspace_id == principal.workspace_id)
        .group_by(Task.status)
    ).all()
    for status, count in counts:
        by_status[status] = count
    return {
        "total": sum(by_status.values()),
        "by_status": by_status,
        "generated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
    }
