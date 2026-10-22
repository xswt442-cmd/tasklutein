"""Workspace-scoped comments on progress reports."""
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi import status as http_status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth import Principal, require_principal, require_user_principal
from ..database import get_db
from ..models import AgentToken, Report, ReportComment, Task, User
from ..schemas import ReportCommentCreate, ReportCommentList, ReportCommentView

router = APIRouter(prefix="/api/reports/{report_id}/comments", tags=["report comments"])


def _report_query(report_id: UUID, workspace_id: UUID):
    return select(Report).join(Task, Report.task_id == Task.id).where(
        Report.id == report_id,
        Task.workspace_id == workspace_id,
    )


def _lock_current_report(db: Session, report_id: UUID, workspace_id: UUID) -> Report:
    task_id = db.scalar(
        select(Report.task_id).join(Task, Report.task_id == Task.id).where(
            Report.id == report_id,
            Task.workspace_id == workspace_id,
        )
    )
    if task_id is None:
        raise HTTPException(status_code=404, detail="report_not_found")

    task = db.scalar(
        select(Task)
        .where(Task.id == task_id, Task.workspace_id == workspace_id)
        .with_for_update()
    )
    if task is None:
        raise HTTPException(status_code=404, detail="report_not_found")
    if task.archived_at is not None:
        raise HTTPException(status_code=404, detail="report_not_found")

    # Re-read after obtaining the parent lock so history cleanup cannot race a
    # stale report snapshot into a comment insert or delete.
    report = db.scalar(select(Report).where(Report.id == report_id, Report.task_id == task.id))
    if report is None:
        raise HTTPException(status_code=404, detail="report_not_found")
    return report


def _comment_view(
    comment: ReportComment,
    user_email: str | None,
    agent_name: str | None,
) -> ReportCommentView:
    return ReportCommentView(
        id=comment.id,
        report_id=comment.report_id,
        content=comment.content,
        source=comment.source,
        actor_name=agent_name if comment.source == "agent" else user_email,
        created_at=comment.created_at,
    )


@router.get("", response_model=ReportCommentList)
def list_report_comments(
    report_id: UUID,
    limit: int = Query(default=25, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    principal: Principal = Depends(require_principal),
):
    report = db.scalar(_report_query(report_id, principal.workspace_id))
    if report is None:
        raise HTTPException(status_code=404, detail="report_not_found")

    rows = db.execute(
        select(ReportComment, User.email, AgentToken.name)
        .outerjoin(User, ReportComment.actor_user_id == User.id)
        .outerjoin(AgentToken, ReportComment.agent_token_id == AgentToken.id)
        .where(ReportComment.report_id == report_id)
        .order_by(ReportComment.created_at, ReportComment.id)
        .offset(offset)
        .limit(limit)
    ).all()
    comments = [_comment_view(comment, user_email, agent_name) for comment, user_email, agent_name in rows]
    total = db.scalar(
        select(func.count(ReportComment.id)).where(ReportComment.report_id == report_id)
    ) or 0
    return {"comments": comments, "total": total, "limit": limit, "offset": offset}


@router.post("", response_model=dict, status_code=http_status.HTTP_201_CREATED)
def create_report_comment(
    report_id: UUID,
    payload: ReportCommentCreate,
    db: Session = Depends(get_db),
    principal: Principal = Depends(require_principal),
):
    report = _lock_current_report(db, report_id, principal.workspace_id)
    comment = ReportComment(
        report_id=report.id,
        content=payload.content,
        source=principal.actor_type,
        actor_user_id=principal.user_id,
        agent_token_id=principal.agent_token_id,
    )
    db.add(comment)
    db.commit()
    db.refresh(comment)
    actor_name = principal.agent_token_name if principal.actor_type == "agent" else principal.email
    return {"comment": _comment_view(comment, actor_name if principal.actor_type == "user" else None,
                                      actor_name if principal.actor_type == "agent" else None)}


@router.delete("/{comment_id}", status_code=http_status.HTTP_204_NO_CONTENT)
def delete_report_comment(
    report_id: UUID,
    comment_id: UUID,
    db: Session = Depends(get_db),
    principal: Principal = Depends(require_user_principal),
):
    report = _lock_current_report(db, report_id, principal.workspace_id)
    comment = db.scalar(
        select(ReportComment).where(
            ReportComment.id == comment_id,
            ReportComment.report_id == report.id,
        )
    )
    if comment is None:
        raise HTTPException(status_code=404, detail="report_comment_not_found")
    db.delete(comment)
    db.commit()
    return Response(status_code=http_status.HTTP_204_NO_CONTENT)
