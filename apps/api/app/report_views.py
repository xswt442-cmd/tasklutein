"""Build report response views with verified actor names when attribution exists."""
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .models import AgentToken, Report, User
from .schemas import ReportView


def report_view(report: Report, actor_name: str | None = None) -> ReportView:
    return ReportView.model_validate(report).model_copy(update={"actor_name": actor_name})


def report_page(db: Session, task_id: UUID, *, limit: int, offset: int) -> dict[str, object]:
    rows = db.execute(
        select(Report, User.email, AgentToken.name)
        .outerjoin(User, Report.actor_user_id == User.id)
        .outerjoin(AgentToken, Report.agent_token_id == AgentToken.id)
        .where(Report.task_id == task_id)
        .order_by(Report.created_at.desc(), Report.id.desc())
        .offset(offset)
        .limit(limit)
    ).all()
    reports = [
        report_view(report, agent_name if report.source == "agent" else user_email)
        for report, user_email, agent_name in rows
    ]
    total = db.scalar(select(func.count(Report.id)).where(Report.task_id == task_id)) or 0
    return {"reports": reports, "total": total, "limit": limit, "offset": offset}
