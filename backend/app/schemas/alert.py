"""Responses for the user's alert inbox and incident audit trail."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel


class AlertNotificationItem(BaseModel):
    id: uuid.UUID
    incident_id: uuid.UUID
    project_id: uuid.UUID
    incident_code: str
    incident_status: str
    assignee_name: str | None = None
    sla_deadline: datetime | None = None
    verification_status: str
    escalated_at: datetime | None = None
    kind: str
    title: str
    body: str
    created_at: datetime
    read_at: datetime | None = None
    email_status: str


class IncidentEventItem(BaseModel):
    id: uuid.UUID
    event_type: str
    comment: str | None
    created_at: datetime
    user_id: uuid.UUID | None
