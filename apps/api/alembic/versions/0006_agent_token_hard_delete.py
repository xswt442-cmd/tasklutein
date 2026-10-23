"""Allow permanent Agent-key deletion without removing history."""
from alembic import op

revision = "0006_agent_token_hard_delete"
down_revision = "0005_report_comments"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("fk_reports_agent_token_id_agent_tokens", "reports", type_="foreignkey")
    op.create_foreign_key(
        "fk_reports_agent_token_id_agent_tokens",
        "reports",
        "agent_tokens",
        ["agent_token_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.drop_constraint("fk_report_comments_agent_token_id_agent_tokens", "report_comments", type_="foreignkey")
    op.create_foreign_key(
        "fk_report_comments_agent_token_id_agent_tokens",
        "report_comments",
        "agent_tokens",
        ["agent_token_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_report_comments_agent_token_id_agent_tokens", "report_comments", type_="foreignkey")
    op.create_foreign_key(
        "fk_report_comments_agent_token_id_agent_tokens",
        "report_comments",
        "agent_tokens",
        ["agent_token_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.drop_constraint("fk_reports_agent_token_id_agent_tokens", "reports", type_="foreignkey")
    op.create_foreign_key(
        "fk_reports_agent_token_id_agent_tokens",
        "reports",
        "agent_tokens",
        ["agent_token_id"],
        ["id"],
        ondelete="RESTRICT",
    )
