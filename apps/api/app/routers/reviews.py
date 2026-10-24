"""Human review records for workspace progress reports."""
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from ..auth import Principal, require_principal, require_user_principal
from ..database import get_db
from ..models import AgentToken, Report, ReportReview, Task, User
from ..schemas import ReportReviewCreate

router = APIRouter(prefix="/api/reports", tags=["report reviews"])
inbox_router = APIRouter(prefix="/api", tags=["inbox"])


def _report_and_task(db: Session, report_id: UUID, workspace_id: UUID, *, lock: bool = False):
    statement = (
        select(Report, Task)
        .join(Task, Task.id == Report.task_id)
        .where(Report.id == report_id, Task.workspace_id == workspace_id)
    )
    if lock:
        statement = statement.with_for_update(of=Task)
    row = db.execute(statement).first()
    if row is None:
        raise HTTPException(status_code=404, detail="report_not_found")
    return row


def _review_view(review: ReportReview, email: str) -> dict[str, object]:
    return {
        "id": str(review.id),
        "report_id": str(review.report_id),
        "reviewer_user_id": str(review.reviewer_user_id),
        "reviewer_email": email,
        "score": review.score,
        "verdict": review.verdict,
        "note": review.note,
        "created_at": review.created_at,
        "updated_at": review.updated_at,
    }


def _reviews(db: Session, report_id: UUID) -> list[dict[str, object]]:
    rows = db.execute(
        select(ReportReview, User.email)
        .join(User, User.id == ReportReview.reviewer_user_id)
        .where(ReportReview.report_id == report_id)
        .order_by(ReportReview.updated_at.desc(), ReportReview.id)
    ).all()
    return [_review_view(review, email) for review, email in rows]


@router.get("/{report_id}/reviews")
def list_reviews(
    report_id: UUID,
    principal: Principal = Depends(require_principal),
    db: Session = Depends(get_db),
):
    _report_and_task(db, report_id, principal.workspace_id)
    reviews = _reviews(db, report_id)
    return {
        "reviews": reviews,
        "my_review": next((review for review in reviews if review["reviewer_user_id"] == str(principal.user_id)), None),
    }


@router.put("/{report_id}/review")
def upsert_review(
    report_id: UUID,
    payload: ReportReviewCreate,
    principal: Principal = Depends(require_user_principal),
    db: Session = Depends(get_db),
):
    report, task = _report_and_task(db, report_id, principal.workspace_id, lock=True)
    if task.archived_at is not None:
        raise HTTPException(status_code=404, detail="report_not_found")
    review = db.scalar(
        select(ReportReview)
        .where(ReportReview.report_id == report.id, ReportReview.reviewer_user_id == principal.user_id)
        .with_for_update()
    )
    now = datetime.now(UTC)
    if review is None:
        review = ReportReview(
            report_id=report.id,
            reviewer_user_id=principal.user_id,
            score=payload.score,
            verdict=payload.verdict,
            note=payload.note,
            created_at=now,
            updated_at=now,
        )
        db.add(review)
    else:
        review.score = payload.score
        review.verdict = payload.verdict
        review.note = payload.note
        review.updated_at = now
    db.commit()
    db.refresh(review)
    reviews = _reviews(db, report_id)
    return {
        "review": next(item for item in reviews if item["reviewer_user_id"] == str(principal.user_id)),
        "reviews": reviews,
    }


@inbox_router.get("/inbox")
def list_inbox(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    principal: Principal = Depends(require_user_principal),
    db: Session = Depends(get_db),
):
    assigned = db.execute(
        select(Task, User.email)
        .join(User, User.id == Task.assignee_user_id)
        .where(
            Task.workspace_id == principal.workspace_id,
            Task.assignee_user_id == principal.user_id,
            Task.archived_at.is_(None),
        )
        .order_by(Task.updated_at.desc(), Task.id.desc())
        .limit(limit + offset)
    ).all()

    latest_reports = (
        select(
            Report.id.label("report_id"),
            Report.task_id.label("task_id"),
            Report.content.label("content"),
            Report.source.label("source"),
            Report.actor_user_id.label("actor_user_id"),
            Report.agent_token_id.label("agent_token_id"),
            Report.created_at.label("updated_at"),
            func.row_number().over(partition_by=Report.task_id, order_by=(Report.created_at.desc(), Report.id.desc())).label("rank"),
        )
        .join(Task, Task.id == Report.task_id)
        .where(
            Task.workspace_id == principal.workspace_id,
            Task.archived_at.is_(None),
            Report.actor_user_id.is_distinct_from(principal.user_id),
        )
        .subquery()
    )
    report_filter = (
        latest_reports.c.rank == 1,
        ~select(ReportReview.id)
        .where(
            ReportReview.report_id == latest_reports.c.report_id,
            ReportReview.reviewer_user_id == principal.user_id,
        )
        .exists(),
    )
    report_rows = db.execute(
        select(
            latest_reports,
            Task.title,
            case(
                (latest_reports.c.source == "agent", AgentToken.name),
                else_=User.email,
            ).label("actor_name"),
        )
        .join(Task, Task.id == latest_reports.c.task_id)
        .outerjoin(User, User.id == latest_reports.c.actor_user_id)
        .outerjoin(AgentToken, AgentToken.id == latest_reports.c.agent_token_id)
        .where(*report_filter)
        .order_by(latest_reports.c.updated_at.desc(), latest_reports.c.report_id.desc())
        .limit(limit + offset)
    ).all()

    items: list[dict[str, object]] = []
    for task, assignee_email in assigned:
        items.append({
            "kind": "task",
            "updated_at": task.updated_at,
            "task": {
                "id": str(task.id), "title": task.title, "description": task.description,
                "status": task.status, "created_at": task.created_at,
                "assignee_user_id": str(task.assignee_user_id), "assignee_name": assignee_email,
                "version": task.version, "updated_at": task.updated_at,
            },
            "report": None,
        })
    for report in report_rows:
        items.append({
            "kind": "report_review",
            "updated_at": report.updated_at,
            "task": {"id": str(report.task_id), "title": report.title},
            "report": {
                "id": str(report.report_id), "task_id": str(report.task_id),
                "content": report.content, "source": report.source,
                "actor_user_id": str(report.actor_user_id) if report.actor_user_id else None,
                "actor_name": report.actor_name,
                "created_at": report.updated_at,
            },
        })
    items.sort(key=lambda item: (item["updated_at"], item["task"]["id"]), reverse=True)
    assigned_total = db.scalar(
        select(func.count(Task.id)).where(
            Task.workspace_id == principal.workspace_id,
            Task.assignee_user_id == principal.user_id,
            Task.archived_at.is_(None),
        )
    ) or 0
    report_total = db.scalar(select(func.count()).select_from(latest_reports).where(*report_filter)) or 0
    total = assigned_total + report_total
    page = items[offset : offset + limit]
    tasks = [item["task"] for item in page if item["kind"] == "task"]
    reports = [
        {"report": item["report"], "task_id": item["task"]["id"], "task_title": item["task"]["title"]}
        for item in page
        if item["kind"] == "report_review"
    ]
    return {"tasks": tasks, "reports": reports, "total": total, "limit": limit, "offset": offset}
