"""Initial Tasklutein PostgreSQL schema baseline."""
from alembic import op
import sqlalchemy as sa

revision = "0001_baseline"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "tasks",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("title", sa.String(length=120), nullable=False),
        sa.Column("description", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("status", sa.String(length=24), server_default=sa.text("'todo'"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("status IN ('todo', 'in_progress', 'done')", name="tasks_status_check"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_tasks_updated", "tasks", [sa.desc("updated_at")])

    op.create_table(
        "reports",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("task_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("source", sa.String(length=12), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("source IN ('user', 'agent')", name="reports_source_check"),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_reports_task_created", "reports", ["task_id", sa.desc("created_at")])


def downgrade() -> None:
    op.drop_index("idx_reports_task_created", table_name="reports")
    op.drop_table("reports")
    op.drop_index("idx_tasks_updated", table_name="tasks")
    op.drop_table("tasks")
