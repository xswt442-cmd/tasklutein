"""Add task archive timestamps and workspace-scoped activity records."""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0004_task_history"
down_revision = "0003_task_workspace_required"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("tasks", sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index(
        "idx_tasks_workspace_archived",
        "tasks",
        ["workspace_id", sa.text("archived_at DESC"), sa.text("id DESC")],
    )

    op.create_table(
        "activities",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("workspace_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("task_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("event_type", sa.String(length=32), nullable=False),
        sa.Column("actor_type", sa.String(length=12), nullable=False),
        sa.Column("actor_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("agent_token_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("request_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("summary", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint(
            "event_type IN ('task.created', 'task.updated', 'task.status_changed', 'task.deleted', 'report.created')",
            name="activities_event_type_check",
        ),
        sa.CheckConstraint("actor_type IN ('user', 'agent')", name="activities_actor_type_check"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["actor_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["agent_token_id"], ["agent_tokens.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_activities_workspace_occurred",
        "activities",
        ["workspace_id", sa.text("occurred_at DESC"), sa.text("id DESC")],
    )
    op.create_index(
        "idx_activities_task_occurred",
        "activities",
        ["task_id", sa.text("occurred_at DESC"), sa.text("id DESC")],
    )


def downgrade() -> None:
    raise RuntimeError("Task history cannot be removed without an explicit data and rollback review.")
