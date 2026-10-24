"""Add team workspaces, report reviews, and optimistic task versions."""
from alembic import op
import sqlalchemy as sa

revision = "0007_team_review_concurrency"
down_revision = "0006_agent_token_hard_delete"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "workspaces",
        sa.Column("kind", sa.String(length=12), server_default="personal", nullable=False),
    )
    op.create_check_constraint("workspaces_kind_check", "workspaces", "kind IN ('personal', 'team')")
    op.drop_constraint("uq_workspaces_owner_id", "workspaces", type_="unique")
    op.create_index(
        "uq_workspaces_personal_owner_id",
        "workspaces",
        ["owner_id"],
        unique=True,
        postgresql_where=sa.text("kind = 'personal'"),
    )

    op.create_table(
        "workspace_members",
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("role", sa.String(length=12), nullable=False),
        sa.Column("joined_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("role IN ('owner', 'member')", name="workspace_members_role_check"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("workspace_id", "user_id"),
    )
    op.execute(
        "INSERT INTO workspace_members (workspace_id, user_id, role) "
        "SELECT id, owner_id, 'owner' FROM workspaces"
    )

    op.create_table(
        "workspace_invitations",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("invitee_user_id", sa.Uuid(), nullable=False),
        sa.Column("invited_by_user_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(length=12), server_default="pending", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("responded_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("status IN ('pending', 'accepted', 'declined')", name="workspace_invitations_status_check"),
        sa.ForeignKeyConstraint(["invitee_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["invited_by_user_id"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "uq_workspace_invitations_pending",
        "workspace_invitations",
        ["workspace_id", "invitee_user_id"],
        unique=True,
        postgresql_where=sa.text("status = 'pending'"),
    )
    op.create_index("idx_workspace_invitations_invitee", "workspace_invitations", ["invitee_user_id", "status"])

    op.add_column("tasks", sa.Column("assignee_user_id", sa.Uuid(), nullable=True))
    op.add_column("tasks", sa.Column("version", sa.BigInteger(), server_default="1", nullable=False))
    op.create_foreign_key(
        "fk_tasks_assignee_user_id_users", "tasks", "users", ["assignee_user_id"], ["id"], ondelete="SET NULL"
    )
    op.create_index("idx_tasks_workspace_assignee", "tasks", ["workspace_id", "assignee_user_id", sa.text("updated_at DESC")])

    op.create_table(
        "report_reviews",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("report_id", sa.Uuid(), nullable=False),
        sa.Column("reviewer_user_id", sa.Uuid(), nullable=False),
        sa.Column("score", sa.Integer(), nullable=False),
        sa.Column("verdict", sa.String(length=16), nullable=False),
        sa.Column("note", sa.String(length=1000), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("score BETWEEN 1 AND 5", name="report_reviews_score_check"),
        sa.CheckConstraint("verdict IN ('approved', 'needs_work')", name="report_reviews_verdict_check"),
        sa.ForeignKeyConstraint(["report_id"], ["reports.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["reviewer_user_id"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("report_id", "reviewer_user_id", name="uq_report_reviews_reviewer"),
    )
    op.create_index("idx_report_reviews_reviewer_updated", "report_reviews", ["reviewer_user_id", sa.text("updated_at DESC")])


def downgrade() -> None:
    bind = op.get_bind()
    has_team_workspaces = bind.scalar(sa.text("SELECT count(*) FROM workspaces WHERE kind = 'team'"))
    has_reviews = bind.scalar(sa.text("SELECT count(*) FROM report_reviews"))
    has_assigned_tasks = bind.scalar(sa.text("SELECT count(*) FROM tasks WHERE assignee_user_id IS NOT NULL"))
    if has_team_workspaces or has_reviews or has_assigned_tasks:
        raise RuntimeError("Cannot downgrade while team, review, or task-assignee data exists")
    op.drop_index("idx_report_reviews_reviewer_updated", table_name="report_reviews")
    op.drop_table("report_reviews")
    op.drop_index("idx_tasks_workspace_assignee", table_name="tasks")
    op.drop_constraint("fk_tasks_assignee_user_id_users", "tasks", type_="foreignkey")
    op.drop_column("tasks", "version")
    op.drop_column("tasks", "assignee_user_id")
    op.drop_index("idx_workspace_invitations_invitee", table_name="workspace_invitations")
    op.drop_index("uq_workspace_invitations_pending", table_name="workspace_invitations")
    op.drop_table("workspace_invitations")
    op.drop_table("workspace_members")
    op.drop_index("uq_workspaces_personal_owner_id", table_name="workspaces")
    op.create_unique_constraint("uq_workspaces_owner_id", "workspaces", ["owner_id"])
    op.drop_constraint("workspaces_kind_check", "workspaces", type_="check")
    op.drop_column("workspaces", "kind")
