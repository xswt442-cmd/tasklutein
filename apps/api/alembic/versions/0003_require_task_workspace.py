"""Assign legacy tasks to an explicitly chosen account and require a workspace."""
import os

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0003_task_workspace_required"
down_revision = "0002_identity_workspace"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    unassigned = bind.scalar(sa.text("SELECT count(*) FROM tasks WHERE workspace_id IS NULL")) or 0

    if unassigned:
        issuer = os.getenv("TASKLUTEIN_LEGACY_OWNER_ISSUER", "").strip()
        subject = os.getenv("TASKLUTEIN_LEGACY_OWNER_SUBJECT", "").strip()
        email = os.getenv("TASKLUTEIN_LEGACY_OWNER_EMAIL", "").strip().lower()
        confirmation = os.getenv("TASKLUTEIN_LEGACY_TASKS_CONFIRM", "")
        if (
            not issuer.startswith("https://")
            or not subject
            or not email
            or confirmation != "assign-existing-tasks"
        ):
            raise RuntimeError(
                "Unassigned tasks require an explicit legacy owner identity and "
                "TASKLUTEIN_LEGACY_TASKS_CONFIRM=assign-existing-tasks"
            )

        owner_id = bind.scalar(
            sa.text(
                "SELECT id FROM users "
                "WHERE access_issuer = :issuer AND access_subject = :subject "
                "AND lower(email) = :email AND disabled_at IS NULL"
            ),
            {"issuer": issuer, "subject": subject, "email": email},
        )
        if owner_id is None:
            raise RuntimeError("The selected legacy task owner must first sign in and bootstrap a workspace")

        workspace_id = bind.scalar(
            sa.text("SELECT id FROM workspaces WHERE owner_id = :owner_id"),
            {"owner_id": owner_id},
        )
        if workspace_id is None:
            raise RuntimeError("The selected legacy task owner does not have a workspace")

        bind.execute(
            sa.text("UPDATE tasks SET workspace_id = :workspace_id WHERE workspace_id IS NULL"),
            {"workspace_id": workspace_id},
        )
        remaining = bind.scalar(sa.text("SELECT count(*) FROM tasks WHERE workspace_id IS NULL")) or 0
        if remaining:
            raise RuntimeError("Legacy task assignment left tasks without a workspace")

    op.alter_column(
        "tasks",
        "workspace_id",
        existing_type=postgresql.UUID(as_uuid=True),
        nullable=False,
    )


def downgrade() -> None:
    op.alter_column(
        "tasks",
        "workspace_id",
        existing_type=postgresql.UUID(as_uuid=True),
        nullable=True,
    )
