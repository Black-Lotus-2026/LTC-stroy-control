"""Immutable inputs/results and durable budgets for management analysis."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, Numeric, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class TaskDependency(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "task_dependencies"
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    schedule_version: Mapped[str] = mapped_column(String(120))
    predecessor_id: Mapped[str] = mapped_column(String(120))
    successor_id: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(8), default="FS")
    lag_work_hours: Mapped[float] = mapped_column(Numeric(16, 6), default=0)
    __table_args__ = (
        UniqueConstraint(
            "project_id", "schedule_version", "predecessor_id", "successor_id"
        ),
    )


class ManagementRun(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "management_runs"
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    incident_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("incidents.id", ondelete="SET NULL")
    )
    created_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id")
    )
    parent_run_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("management_runs.id")
    )
    as_of: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    mode: Mapped[str] = mapped_column(String(24))
    effective_mode: Mapped[str] = mapped_column(String(24), default="deterministic")
    status: Mapped[str] = mapped_column(String(24), default="queued", index=True)
    idempotency_key: Mapped[str] = mapped_column(String(120))
    request_hash: Mapped[str] = mapped_column(String(64))
    input_hash: Mapped[str] = mapped_column(String(64))
    # Released on terminal state. Unique NULL permits historical runs while
    # preventing two workers analyzing the same active input (even across users).
    active_key: Mapped[str | None] = mapped_column(String(64), unique=True)
    snapshot: Mapped[dict] = mapped_column(JSONB)
    results: Mapped[list] = mapped_column(JSONB, default=list)
    assessment: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    proposal: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    review: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    comparison: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    error: Mapped[str | None] = mapped_column(String(2000))
    llm_calls: Mapped[int] = mapped_column(Integer, default=0)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (UniqueConstraint("created_by", "project_id", "idempotency_key"),)


class ManagementRunStep(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "management_run_steps"
    run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("management_runs.id", ondelete="CASCADE"),
        index=True,
    )
    role: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(24), default="pending")
    generation: Mapped[str] = mapped_column(String(24), default="deterministic")
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    result: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    error: Mapped[str | None] = mapped_column(String(2000))
    provider: Mapped[str | None] = mapped_column(String(120))
    model: Mapped[str | None] = mapped_column(String(120))
    prompt_version: Mapped[str | None] = mapped_column(String(120))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    llm_calls: Mapped[int] = mapped_column(Integer, default=0)
    usage: Mapped[dict] = mapped_column(JSONB, default=dict)
    tool_refs: Mapped[list] = mapped_column(JSONB, default=list)
    __table_args__ = (UniqueConstraint("run_id", "role"),)
