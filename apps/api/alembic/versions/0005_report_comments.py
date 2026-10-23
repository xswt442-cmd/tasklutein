"""Add workspace-scoped comments to progress reports."""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0005_report_comments"
down_revision = "0004_task_history"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "report_comments",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("report_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("source", sa.String(length=12), nullable=False),
        sa.Column("actor_user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("agent_token_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("source IN ('user', 'agent')", name="report_comments_source_check"),
        sa.ForeignKeyConstraint(
            ["report_id"], ["reports.id"], name="fk_report_comments_report_id_reports", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["actor_user_id"], ["users.id"], name="fk_report_comments_actor_user_id_users", ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["agent_token_id"],
            ["agent_tokens.id"],
            name="fk_report_comments_agent_token_id_agent_tokens",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_report_comments_report_created",
        "report_comments",
        ["report_id", "created_at", "id"],
    )


def downgrade() -> None:
    raise RuntimeError("Report comments cannot be removed without an explicit data and rollback review.")
