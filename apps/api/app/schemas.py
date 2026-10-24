"""HTTP request and response contracts."""
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

TaskStatus = Literal["todo", "in_progress", "done"]
TaskSort = Literal["updated_desc", "created_desc"]
ActivityEventType = Literal[
    "task.created",
    "task.updated",
    "task.status_changed",
    "task.deleted",
    "report.created",
]
ActivityActorType = Literal["user", "agent"]


class TaskCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=4000)
    status: TaskStatus = "todo"

    @field_validator("title")
    @classmethod
    def clean_title(cls, title: str) -> str:
        title = title.strip()
        if not title:
            raise ValueError("title must not be blank")
        return title


class TaskUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=4000)
    status: TaskStatus | None = None
    assignee_user_id: UUID | None = None
    expected_version: int | None = Field(default=None, ge=1)

    @field_validator("title")
    @classmethod
    def clean_title(cls, title: str | None) -> str | None:
        if title is not None and not title.strip():
            raise ValueError("title must not be blank")
        return title.strip() if title is not None else None

    @model_validator(mode="after")
    def at_least_one_field(self):
        changes = self.model_fields_set - {"expected_version"}
        if self.expected_version is not None and not changes:
            raise ValueError("supply at least one field to update")
        if any(getattr(self, name) is None for name in changes - {"assignee_user_id"}):
            raise ValueError("supply at least one non-null field")
        return self


class TaskView(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    title: str
    description: str
    status: TaskStatus
    assignee_user_id: UUID | None = None
    assignee_name: str | None = None
    version: int
    created_at: datetime
    updated_at: datetime


class ReportCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    content: str = Field(min_length=1, max_length=8000)

    @field_validator("content")
    @classmethod
    def clean_content(cls, content: str) -> str:
        if not content.strip():
            raise ValueError("content must not be blank")
        return content.strip()


class ReportView(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    task_id: UUID
    content: str
    source: Literal["user", "agent"]
    actor_name: str | None = None
    created_at: datetime


class WorkspaceCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=120)

    @field_validator("name")
    @classmethod
    def clean_name(cls, name: str) -> str:
        name = name.strip()
        if not name:
            raise ValueError("name must not be blank")
        return name


class WorkspaceInvitationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: str = Field(min_length=3, max_length=320)

    @field_validator("email")
    @classmethod
    def clean_email(cls, email: str) -> str:
        email = email.strip().lower()
        if "@" not in email or any(character.isspace() for character in email):
            raise ValueError("email must be valid")
        return email


class ReportReviewCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    score: int = Field(ge=1, le=5)
    verdict: Literal["approved", "needs_work"]
    note: str | None = Field(default=None, max_length=1000)

    @field_validator("note")
    @classmethod
    def clean_note(cls, note: str | None) -> str | None:
        if note is None:
            return None
        note = note.strip()
        return note or None


class TaskList(BaseModel):
    tasks: list[TaskView]
    total: int
    limit: int
    offset: int


class ArchivedTaskView(TaskView):
    archived_at: datetime


class ArchivedTaskList(BaseModel):
    tasks: list[ArchivedTaskView]
    total: int
    limit: int
    offset: int


class ActivityView(BaseModel):
    id: UUID
    task_id: UUID
    task_title: str
    event_type: ActivityEventType
    actor_type: ActivityActorType
    actor_user_id: UUID | None
    agent_token_id: UUID | None
    actor_name: str | None
    request_id: UUID
    summary: dict[str, object]
    occurred_at: datetime


class ActivityList(BaseModel):
    activities: list[ActivityView]
    total: int
    limit: int
    offset: int


class ReportList(BaseModel):
    reports: list[ReportView]
    total: int
    limit: int
    offset: int


class ReportCommentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    content: str = Field(min_length=1, max_length=2000)

    @field_validator("content")
    @classmethod
    def clean_content(cls, content: str) -> str:
        content = content.strip()
        if not content:
            raise ValueError("content must not be blank")
        return content


class ReportCommentView(BaseModel):
    id: UUID
    report_id: UUID
    content: str
    source: Literal["user", "agent"]
    actor_name: str | None = None
    created_at: datetime


class ReportCommentList(BaseModel):
    comments: list[ReportCommentView]
    total: int
    limit: int
    offset: int


class AgentTokenCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=80)
    expires_at: datetime | None = None

    @field_validator("name")
    @classmethod
    def clean_name(cls, name: str) -> str:
        name = name.strip()
        if not name:
            raise ValueError("name must not be blank")
        return name

    @field_validator("expires_at")
    @classmethod
    def validate_expiration(cls, expires_at: datetime | None) -> datetime | None:
        if expires_at is None:
            return None
        if expires_at.tzinfo is None or expires_at.utcoffset() is None:
            raise ValueError("expires_at must include a timezone")
        if expires_at <= datetime.now(UTC):
            raise ValueError("expires_at must be in the future")
        return expires_at.astimezone(UTC)


class AgentTokenUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=80)
    expires_at: datetime | None = None

    @field_validator("name")
    @classmethod
    def clean_name(cls, name: str | None) -> str | None:
        if name is not None and not name.strip():
            raise ValueError("name must not be blank")
        return name.strip() if name is not None else None

    @field_validator("expires_at")
    @classmethod
    def validate_expiration(cls, expires_at: datetime | None) -> datetime | None:
        if expires_at is None:
            return None
        if expires_at.tzinfo is None or expires_at.utcoffset() is None:
            raise ValueError("expires_at must include a timezone")
        if expires_at <= datetime.now(UTC):
            raise ValueError("expires_at must be in the future")
        return expires_at.astimezone(UTC)

    @model_validator(mode="after")
    def require_update_field(self):
        if not self.model_fields_set or ("name" in self.model_fields_set and self.name is None):
            raise ValueError("supply a non-null name or an expiration value")
        return self
