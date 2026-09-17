"""Контракты календарного плана."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.models.enums import ScheduleTaskStatus


class ScheduleTaskBrief(BaseModel):
    """Работа плана в карточке инцидента: с чем именно сопоставляли."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    planned_start: datetime
    planned_end: datetime
    status: ScheduleTaskStatus
