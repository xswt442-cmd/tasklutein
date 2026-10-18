"""HTTP request and response contracts."""
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

TaskStatus = Literal["todo", "in_progress", "done"]
TaskSort = Literal["updated_desc", "created_desc"]


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

    @field_validator("title")
    @classmethod
    def clean_title(cls, title: str | None) -> str | None:
        if title is not None and not title.strip():
            raise ValueError("title must not be blank")
        return title.strip() if title is not None else None

    @model_validator(mode="after")
    def at_least_one_field(self):
        if not self.model_fields_set or any(getattr(self, name) is None for name in self.model_fields_set):
            raise ValueError("supply at least one non-null field")
        return self


class TaskView(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    title: str
    description: str
    status: TaskStatus
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
    created_at: datetime


class TaskList(BaseModel):
    tasks: list[TaskView]
    total: int
    limit: int
    offset: int


class ReportList(BaseModel):
    reports: list[ReportView]
    total: int
    limit: int
    offset: int
