"""Pydantic models for Weaveflow."""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Literal

from pydantic import AliasChoices, BaseModel, Field


def utc_now_iso() -> str:
    """Return a human-readable UTC timestamp."""
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


class TaskStatus(str, Enum):
    DRAFT = "draft"
    PLANNED = "planned"
    BRIEFED = "briefed"
    RESULT_ATTACHED = "result_attached"
    VERIFYING = "verifying"
    VERIFIED = "verified"
    COMPLETED = "completed"
    BLOCKED = "blocked"
    FAILED = "failed"


class ProjectConfig(BaseModel):
    name: str = Field(
        default="Weaveflow",
        validation_alias=AliasChoices("name", "project_name"),
    )
    version: int = Field(
        default=1,
        validation_alias=AliasChoices("version", "workspace_version"),
    )
    created_at: str = Field(default_factory=utc_now_iso)


class TaskSpec(BaseModel):
    id: str
    title: str
    user_request: str
    status: TaskStatus = TaskStatus.DRAFT
    created_at: str = Field(default_factory=utc_now_iso)
    updated_at: str = Field(default_factory=utc_now_iso)
    success_criteria: list[str] = Field(
        default_factory=lambda: [
            "Task is understood and structured",
            "A plan can be generated",
            "A Codex worker brief can be generated",
        ]
    )
    constraints: list[str] = Field(
        default_factory=lambda: [
            "Do not perform destructive operations without explicit approval",
            "Do not call external APIs in this MVP",
            "Do not make unrelated changes",
        ]
    )
    notes: list[str] = Field(default_factory=list)


class TaskListItem(BaseModel):
    id: str
    title: str
    status: str
    created_at: str
    updated_at: str


class PlanNode(BaseModel):
    id: str
    title: str
    type: str
    depends_on: list[str] = Field(default_factory=list)
    instructions: list[str]
    expected_output: str


class Plan(BaseModel):
    task_id: str
    created_at: str = Field(default_factory=utc_now_iso)
    nodes: list[PlanNode]


class Artifact(BaseModel):
    id: str
    task_id: str
    type: str
    path: str
    created_at: str = Field(default_factory=utc_now_iso)
    summary: str


class VerificationCommand(BaseModel):
    command: str
    status: str
    note: str


class VerificationRecord(BaseModel):
    task_id: str
    status: str
    created_at: str = Field(default_factory=utc_now_iso)
    commands: list[VerificationCommand] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)
    remaining_risks: list[str] = Field(default_factory=list)


class MemoryDiff(BaseModel):
    task_id: str
    created_at: str = Field(default_factory=utc_now_iso)
    add: list[str] = Field(default_factory=list)
    update: list[str] = Field(default_factory=list)
    deprecate: list[str] = Field(default_factory=list)
    do_not_store: list[str] = Field(default_factory=list)
    evidence: list[str] = Field(default_factory=list)


class DoctorCheck(BaseModel):
    name: str
    level: Literal["ok", "warn", "error"]
    message: str
    path: str | None = None


class DoctorReport(BaseModel):
    checks: list[DoctorCheck] = Field(default_factory=list)
    ok_count: int = 0
    warn_count: int = 0
    error_count: int = 0
    healthy: bool = True

    @classmethod
    def from_checks(cls, checks: list[DoctorCheck]) -> "DoctorReport":
        ok_count = sum(1 for check in checks if check.level == "ok")
        warn_count = sum(1 for check in checks if check.level == "warn")
        error_count = sum(1 for check in checks if check.level == "error")
        return cls(
            checks=checks,
            ok_count=ok_count,
            warn_count=warn_count,
            error_count=error_count,
            healthy=error_count == 0,
        )
