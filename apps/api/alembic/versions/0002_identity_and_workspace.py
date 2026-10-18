"""Add user identity, personal workspaces, and Agent key metadata."""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0002_identity_workspace"
down_revision = "0001_baseline"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("access_issuer", sa.String(length=512), nullable=False),
        sa.Column("access_subject", sa.String(length=255), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("disabled_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("access_issuer", "access_subject", name="uq_users_access_identity"),
    )
    op.create_table(
        "workspaces",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("owner_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("owner_id", name="uq_workspaces_owner_id"),
    )
    op.create_table(
        "agent_tokens",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("workspace_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("prefix", sa.String(length=16), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token_hash"),
    )
    op.create_index(
        "idx_agent_tokens_workspace_created",
        "agent_tokens",
        ["workspace_id", sa.text("created_at DESC")],
    )

    op.add_column("tasks", sa.Column("workspace_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.create_foreign_key(
        "fk_tasks_workspace_id_workspaces",
        "tasks",
        "workspaces",
        ["workspace_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_index(
        "idx_tasks_workspace_updated",
        "tasks",
        ["workspace_id", sa.text("updated_at DESC"), sa.text("id DESC")],
    )

    op.add_column("reports", sa.Column("actor_user_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column("reports", sa.Column("agent_token_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.create_foreign_key(
        "fk_reports_actor_user_id_users",
        "reports",
        "users",
        ["actor_user_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_reports_agent_token_id_agent_tokens",
        "reports",
        "agent_tokens",
        ["agent_token_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_index("idx_reports_actor_user", "reports", ["actor_user_id"])
    op.create_index("idx_reports_agent_token", "reports", ["agent_token_id"])


def downgrade() -> None:
    raise RuntimeError(
        "The identity and workspace schema cannot be downgraded to shared-workspace access."
    )
