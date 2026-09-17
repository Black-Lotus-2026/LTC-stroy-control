"""Контракты площадки, зон и камер.

Краткие формы (`*Brief`) существуют отдельно от полных не ради экономии
трафика, а ради устойчивости: список инцидентов показывает зону и камеру
парой «код — название», и он не должен ломаться, когда у камеры появится
новое поле.
"""

from __future__ import annotations

import uuid
from datetime import datetime, time

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import CameraStatus, ZoneRiskLevel


class ZoneBrief(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    code: str = Field(description="Код зоны для человека, например A-03")
    name: str


class CameraBrief(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    code: str = Field(description="Код камеры для человека, например CAM-03")
    name: str
    status: CameraStatus


class ProjectBrief(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    code: str
    name: str


class ProjectSettingsRead(BaseModel):
    """Параметры автоматического наблюдения.

    Показываются на экране настроек и объясняют поведение системы: почему
    инцидент появился после третьего наблюдения, а не после первого.
    """

    model_config = ConfigDict(from_attributes=True)

    observation_enabled: bool
    default_confidence_threshold: float = Field(
        ge=0, le=1, description="Порог уверенности детекции, доля от 0 до 1"
    )
    matching_window_minutes: int
    min_consecutive_misses: int
    default_sla_minutes: int
    idle_threshold_minutes: int


class ProjectRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    code: str
    name: str
    address: str | None
    timezone: str = Field(description="Часовой пояс площадки; время в API — UTC")
    shift_start: time
    shift_end: time
    object_kind: str | None
    status: str
    created_at: datetime


class ProjectDetail(ProjectRead):
    """Площадка с параметрами наблюдения и составом.

    Счётчики зон и камер отданы здесь, чтобы обзорный экран не делал три
    запроса ради трёх чисел.
    """

    settings: ProjectSettingsRead | None
    zone_count: int
    camera_count: int


class ZoneRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    code: str
    name: str
    description: str | None
    risk_level: ZoneRiskLevel
    status: str
    geometry: dict | None = Field(
        default=None,
        description="Контур зоны на схеме площадки в долях 0..1 от её габаритов",
    )
    camera_count: int = 0


class CameraRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    code: str
    name: str
    status: CameraStatus
    visibility_percent: int = Field(
        ge=0, le=100, description="Какую долю рабочей зоны камера реально видит"
    )
    capture_interval_seconds: int
    stream_url: str | None
    archive_url: str | None
    last_frame_at: datetime | None = Field(
        default=None,
        description="Время последнего кадра; «8 сек назад» считает интерфейс",
    )
    last_heartbeat_at: datetime | None = None
    zone: ZoneBrief | None = None
