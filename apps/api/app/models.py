"""Database models; the initial production schema is in apps/api/migrations/0001_init.sql."""
from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import (
    JSON,
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    desc,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utc_now() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        UniqueConstraint("access_issuer", "access_subject", name="uq_users_access_identity"),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    access_issuer: Mapped[str] = mapped_column(String(512), nullable=False)
    access_subject: Mapped[str] = mapped_column(String(255), nullable=False)
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now())
    disabled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Workspace(Base):
    __tablename__ = "workspaces"
    __table_args__ = (
        CheckConstraint("kind IN ('personal', 'team')", name="workspaces_kind_check"),
        Index(
            "uq_workspaces_personal_owner_id",
            "owner_id",
            unique=True,
            postgresql_where=text("kind = 'personal'"),
            sqlite_where=text("kind = 'personal'"),
        ),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    owner_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    kind: Mapped[str] = mapped_column(String(12), nullable=False, default="personal", server_default=text("'personal'"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now())


class WorkspaceMember(Base):
    __tablename__ = "workspace_members"
    __table_args__ = (
        CheckConstraint("role IN ('owner', 'member')", name="workspace_members_role_check"),
    )

    workspace_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    role: Mapped[str] = mapped_column(String(12), nullable=False)
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now())


class WorkspaceInvitation(Base):
    __tablename__ = "workspace_invitations"
    __table_args__ = (
        CheckConstraint("status IN ('pending', 'accepted', 'declined')", name="workspace_invitations_status_check"),
        Index(
            "uq_workspace_invitations_pending",
            "workspace_id",
            "invitee_user_id",
            unique=True,
            postgresql_where=text("status = 'pending'"),
            sqlite_where=text("status = 'pending'"),
        ),
        Index("idx_workspace_invitations_invitee", "invitee_user_id", "status"),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    workspace_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False)
    invitee_user_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    invited_by_user_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="pending", server_default=text("'pending'"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now())
    responded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AgentToken(Base):
    __tablename__ = "agent_tokens"
    __table_args__ = (
        Index("idx_agent_tokens_workspace_created", "workspace_id", desc("created_at")),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    workspace_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("workspaces.id", name="agent_tokens_workspace_id_fkey", ondelete="RESTRICT"),
        nullable=False,
    )
    created_by: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    prefix: Mapped[str] = mapped_column(String(16), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now())
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Task(Base):
    __tablename__ = "tasks"
    __table_args__ = (
        CheckConstraint("status IN ('todo', 'in_progress', 'done')", name="tasks_status_check"),
        Index("idx_tasks_updated", desc("updated_at")),
        Index("idx_tasks_workspace_updated", "workspace_id", desc("updated_at"), desc("id")),
        Index("idx_tasks_workspace_archived", "workspace_id", desc("archived_at"), desc("id")),
        Index("idx_tasks_workspace_assignee", "workspace_id", "assignee_user_id", desc("updated_at")),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    workspace_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("workspaces.id", ondelete="RESTRICT"), nullable=False)
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default=text("''"))
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="todo", server_default=text("'todo'"))
    assignee_user_id: Mapped[UUID | None] = mapped_column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    version: Mapped[int] = mapped_column(BigInteger, nullable=False, default=1, server_default=text("1"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now())
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reports: Mapped[list["Report"]] = relationship(back_populates="task", cascade="all, delete-orphan", passive_deletes=True)
    activities: Mapped[list["Activity"]] = relationship(back_populates="task", cascade="all, delete-orphan", passive_deletes=True)
    assignee: Mapped[User | None] = relationship(foreign_keys=[assignee_user_id])

    @property
    def assignee_name(self) -> str | None:
        return self.assignee.email if self.assignee is not None else None


class Report(Base):
    __tablename__ = "reports"
    __table_args__ = (
        CheckConstraint("source IN ('user', 'agent')", name="reports_source_check"),
        Index("idx_reports_task_created", "task_id", desc("created_at")),
        Index("idx_reports_actor_user", "actor_user_id"),
        Index("idx_reports_agent_token", "agent_token_id"),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    task_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str] = mapped_column(String(12), nullable=False)
    actor_user_id: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("users.id", name="fk_reports_actor_user_id_users", ondelete="RESTRICT"),
    )
    agent_token_id: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("agent_tokens.id", name="fk_reports_agent_token_id_agent_tokens", ondelete="SET NULL"),
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now())
    task: Mapped[Task] = relationship(back_populates="reports")
    comments: Mapped[list["ReportComment"]] = relationship(
        back_populates="report", cascade="all, delete-orphan", passive_deletes=True
    )
    reviews: Mapped[list["ReportReview"]] = relationship(
        back_populates="report", cascade="all, delete-orphan", passive_deletes=True
    )


class ReportReview(Base):
    __tablename__ = "report_reviews"
    __table_args__ = (
        CheckConstraint("score BETWEEN 1 AND 5", name="report_reviews_score_check"),
        CheckConstraint("verdict IN ('approved', 'needs_work')", name="report_reviews_verdict_check"),
        UniqueConstraint("report_id", "reviewer_user_id", name="uq_report_reviews_reviewer"),
        Index("idx_report_reviews_reviewer_updated", "reviewer_user_id", desc("updated_at")),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    report_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("reports.id", ondelete="CASCADE"), nullable=False)
    reviewer_user_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    score: Mapped[int] = mapped_column(Integer, nullable=False)
    verdict: Mapped[str] = mapped_column(String(16), nullable=False)
    note: Mapped[str | None] = mapped_column(String(1000))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now())
    report: Mapped[Report] = relationship(back_populates="reviews")


class ReportComment(Base):
    __tablename__ = "report_comments"
    __table_args__ = (
        CheckConstraint("source IN ('user', 'agent')", name="report_comments_source_check"),
        Index("idx_report_comments_report_created", "report_id", "created_at", "id"),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    report_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("reports.id", name="fk_report_comments_report_id_reports", ondelete="CASCADE"),
        nullable=False,
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str] = mapped_column(String(12), nullable=False)
    actor_user_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("users.id", name="fk_report_comments_actor_user_id_users", ondelete="RESTRICT"),
        nullable=False,
    )
    agent_token_id: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("agent_tokens.id", name="fk_report_comments_agent_token_id_agent_tokens", ondelete="SET NULL"),
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now()
    )
    report: Mapped[Report] = relationship(back_populates="comments")


class Activity(Base):
    __tablename__ = "activities"
    __table_args__ = (
        CheckConstraint(
            "event_type IN ('task.created', 'task.updated', 'task.status_changed', 'task.deleted', 'report.created')",
            name="activities_event_type_check",
        ),
        CheckConstraint("actor_type IN ('user', 'agent')", name="activities_actor_type_check"),
        Index("idx_activities_workspace_occurred", "workspace_id", desc("occurred_at"), desc("id")),
        Index("idx_activities_task_occurred", "task_id", desc("occurred_at"), desc("id")),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    workspace_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False
    )
    task_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False)
    event_type: Mapped[str] = mapped_column(String(32), nullable=False)
    actor_type: Mapped[str] = mapped_column(String(12), nullable=False)
    actor_user_id: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    agent_token_id: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("agent_tokens.id", ondelete="SET NULL")
    )
    request_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    summary: Mapped[dict[str, object]] = mapped_column(JSON().with_variant(JSONB, "postgresql"), nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now()
    )
    task: Mapped[Task] = relationship(back_populates="activities")
