"""HTTP-контракт отчётного агента."""

from __future__ import annotations

import uuid
from datetime import datetime, time
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models.enums import (
    ReportPeriod,
    ReportScheduleFrequency,
    ReportStatus,
)


class ReportGenerateRequest(BaseModel):
    project_id: uuid.UUID
    period: ReportPeriod = ReportPeriod.DAY
    range_start: datetime | None = None
    range_end: datetime | None = None

    @model_validator(mode="after")
    def validate_custom_period(self) -> ReportGenerateRequest:
        if self.period == ReportPeriod.CUSTOM and self.range_start is None:
            raise ValueError("range_start обязателен для периода custom")
        return self


class ReportMetric(BaseModel):
    key: str
    label: str
    value: int | float | str
    unit: str | None = None


class ReportItem(BaseModel):
    timestamp: datetime
    title: str
    details: str | None = None
    category: str
    severity: str
    source: str
    camera: str | None = None
    zone: str | None = None
    evidence_url: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class ReportSection(BaseModel):
    key: str
    title: str
    summary: str
    items: list[ReportItem] = Field(default_factory=list)


class ReportContent(BaseModel):
    metrics: list[ReportMetric] = Field(default_factory=list)
    sections: list[ReportSection] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)
    manager_actions: list[str] = Field(default_factory=list)
    trace: dict[str, Any] = Field(default_factory=dict)


class GeneratedReportResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    schedule_id: uuid.UUID | None
    period: ReportPeriod
    range_start: datetime
    range_end: datetime
    status: ReportStatus
    agent_name: str
    agent_version: str
    title: str
    executive_summary: str | None
    content: ReportContent
    source_log_count: int
    started_at: datetime | None
    completed_at: datetime | None
    error: str | None
    created_at: datetime


class ReportScheduleCreate(BaseModel):
    project_id: uuid.UUID
    name: str = Field(min_length=1, max_length=128)
    frequency: ReportScheduleFrequency
    report_period: ReportPeriod | None = None
    timezone: str | None = None
    run_at_local: time = time(20, 5)
    weekday: int | None = Field(default=None, ge=0, le=6)
    enabled: bool = True

    @model_validator(mode="after")
    def validate_schedule(self) -> ReportScheduleCreate:
        if self.report_period == ReportPeriod.CUSTOM:
            raise ValueError("custom нельзя использовать в автоматическом расписании")
        if self.frequency == ReportScheduleFrequency.WEEKLY and self.weekday is None:
            self.weekday = 0
        return self


class ReportScheduleUpdate(BaseModel):
    enabled: bool | None = None
    run_at_local: time | None = None
    weekday: int | None = Field(default=None, ge=0, le=6)


class ReportScheduleResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    name: str
    frequency: ReportScheduleFrequency
    report_period: ReportPeriod
    timezone: str
    run_at_local: time
    weekday: int | None
    enabled: bool
    next_run_at: datetime
    last_run_at: datetime | None
    created_at: datetime
    updated_at: datetime
