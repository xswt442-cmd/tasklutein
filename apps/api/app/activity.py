"""Activity creation and workspace-scoped activity queries."""
from uuid import UUID

from fastapi import Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .auth import Principal
from .models import Activity, AgentToken, Task, User
from .schemas import ActivityActorType, ActivityEventType, ActivityView


def record_activity(
    db: Session,
    request: Request,
    principal: Principal,
    task: Task,
    event_type: ActivityEventType,
    summary: dict[str, object],
) -> None:
    request_id = getattr(request.state, "request_id", None)
    if not isinstance(request_id, str):
        raise RuntimeError("API request ID is required for task activity")

    db.add(
        Activity(
            workspace_id=principal.workspace_id,
            task_id=task.id,
            event_type=event_type,
            actor_type=principal.actor_type,
            actor_user_id=principal.user_id,
            agent_token_id=principal.agent_token_id,
            request_id=UUID(request_id),
            summary=summary,
        )
    )


def activity_page(
    db: Session,
    workspace_id: UUID,
    *,
    event_type: ActivityEventType | None = None,
    source: ActivityActorType | None = None,
    task_id: UUID | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, object]:
    filters = [Activity.workspace_id == workspace_id]
    if event_type is not None:
        filters.append(Activity.event_type == event_type)
    if source is not None:
        filters.append(Activity.actor_type == source)
    if task_id is not None:
        filters.append(Activity.task_id == task_id)

    total = db.scalar(select(func.count(Activity.id)).where(*filters)) or 0
    rows = db.execute(
        select(Activity, Task.title, User.email, AgentToken.name)
        .join(Task, Activity.task_id == Task.id)
        .outerjoin(User, Activity.actor_user_id == User.id)
        .outerjoin(AgentToken, Activity.agent_token_id == AgentToken.id)
        .where(*filters)
        .order_by(Activity.occurred_at.desc(), Activity.id.desc())
        .offset(offset)
        .limit(limit)
    ).all()
    activities = [
        ActivityView(
            id=activity.id,
            task_id=activity.task_id,
            task_title=task_title,
            event_type=activity.event_type,
            actor_type=activity.actor_type,
            actor_user_id=activity.actor_user_id,
            agent_token_id=activity.agent_token_id,
            actor_name=agent_name if activity.actor_type == "agent" else user_email,
            request_id=activity.request_id,
            summary=activity.summary,
            occurred_at=activity.occurred_at,
        )
        for activity, task_title, user_email, agent_name in rows
    ]
    return {"activities": activities, "total": total, "limit": limit, "offset": offset}
