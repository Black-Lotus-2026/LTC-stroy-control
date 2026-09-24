"""Pydantic v2 schemas and validation models for Stroy-Control Platform.

Defines schemas for:
- Schedule upload, Gantt tasks, cascade delay shift
- Video upload with absolute recording start timestamp and playback synchronization
- Stage machinery probability profiles from StageMachineryService
- Incident reports, multi-tier discrepancy rule evaluations, and Gemini VLM alerts
"""

from __future__ import annotations

import uuid
from datetime import datetime
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field


class IncidentSeverity(str, Enum):
    ERROR = "ERROR"
    WARNING = "WARNING"
    NEUTRAL = "NEUTRAL"


class DiscrepancyType(str, Enum):
    MISSING_MANDATORY = "MISSING_MANDATORY"
    MISSING_RECOMMENDED = "MISSING_RECOMMENDED"
    UNCHARACTERISTIC_PRESENT = "UNCHARACTERISTIC_PRESENT"
    NEUTRAL_INFO = "NEUTRAL_INFO"


class VideoStatus(str, Enum):
    UPLOADED = "UPLOADED"
    PROCESSING = "PROCESSING"
    READY = "READY"
    FAILED = "FAILED"


# ---------------------------------------------------------------------------
# Schedule & Gantt Models
# ---------------------------------------------------------------------------


class StageItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    name: str = Field(..., description="Наименование этапа")
    order_index: int = Field(default=0, description="Порядковый номер в очереди графика")
    planned_start: datetime = Field(..., description="Плановое начало")
    planned_end: datetime = Field(..., description="Плановое окончание")
    duration_days: int = Field(default=1, ge=1, description="Длительность (дней)")
    matched_catalog_name: str | None = Field(
        None, description="Эталонный вид работ из справочника"
    )
    catalog_similarity: float | None = Field(
        None, description="Степень соответствия [0.0, 1.0]"
    )
    status: str = Field(default="PLANNED")


class StageUpdateRequest(BaseModel):
    name: str | None = Field(None, max_length=512)
    planned_start: datetime | None = None
    planned_end: datetime | None = None
    duration_days: int | None = Field(None, ge=1)


class CascadeShiftRequest(BaseModel):
    delayed_stage_id: str = Field(..., description="ID задержанного этапа")
    delay_days: int = Field(..., gt=0, description="Количество дней задержки")


class CascadeShiftResponse(BaseModel):
    delayed_stage_id: str
    delay_days: int
    shifted_stage_count: int
    updated_stages: list[StageItem]
    message: str


class ScheduleImportResponse(BaseModel):
    project_id: uuid.UUID
    total_stages_imported: int
    matched_catalog_count: int
    stages: list[StageItem]


# ---------------------------------------------------------------------------
# Video Assets & Synchronization Models
# ---------------------------------------------------------------------------


class VideoUploadResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    video_id: uuid.UUID
    filename: str
    start_timestamp: datetime
    duration_seconds: float
    fps: float = 25.0
    status: VideoStatus = VideoStatus.READY
    message: str = "Видеозапись успешно зарегистрирована"


class VideoSyncStatusResponse(BaseModel):
    video_id: uuid.UUID
    playback_seconds: float
    current_timestamp: datetime
    active_stage_id: uuid.UUID | None = None
    active_stage_name: str | None = None
    is_out_of_schedule: bool = False


# ---------------------------------------------------------------------------
# Machinery Probability Analytics Models
# ---------------------------------------------------------------------------


class MachineryProbabilityItem(BaseModel):
    machinery_code: str
    machinery_name_ru: str
    probability: float = Field(..., ge=0.0, le=1.0)
    classification: str = Field(
        ..., description="MANDATORY, RECOMMENDED, NEUTRAL, UNCHARACTERISTIC"
    )
    requirement_level: str = Field(
        ..., description="Обязательная / Рекомендованная / Допустимая / Не допускается"
    )


class StageProbabilityResponse(BaseModel):
    stage_id: uuid.UUID
    stage_name: str
    matched_catalog_stage: str | None = None
    similarity_confidence: float = 0.0
    probabilities: list[MachineryProbabilityItem]
    top_machinery: list[str]


# ---------------------------------------------------------------------------
# Incidents & VLM Verification Models
# ---------------------------------------------------------------------------


class IncidentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    code: str
    project_id: uuid.UUID
    stage_id: uuid.UUID | None = None
    stage_name: str | None = None
    severity: IncidentSeverity
    discrepancy_type: DiscrepancyType
    machinery_type: str
    stage_probability: float
    observed_count: int = 0
    frame_snapshot_url: str | None = None
    is_vlm_verified: bool = False
    vlm_summary: str | None = None
    created_at: datetime


class VlmVerificationResponse(BaseModel):
    incident_id: uuid.UUID
    is_violation_confirmed: bool
    is_occluded: bool
    confidence: float
    reasoning: str
    compact_alert_text: str
    fallback_used: bool = False
    latency_ms: int = 0
    status: str = "completed"


# ---------------------------------------------------------------------------
# Project, Construction Site (Zone), and Camera Models
# ---------------------------------------------------------------------------


class ZoneCreate(BaseModel):
    name: str = Field(..., description="Название стройплощадки/участка")
    code: str | None = Field(None, description="Код участка, например 'A-01'")
    description: str | None = Field(None, description="Описание или назначение зоны")


class ZoneItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    code: str
    name: str
    description: str | None = None
    status: str = "active"


class CameraCreate(BaseModel):
    name: str = Field(..., description="Название камеры")
    code: str | None = Field(None, description="Код камеры, например 'CAM-01'")
    stream_url: str | None = Field(None, description="RTSP/HLS или IP поток")
    zone_id: uuid.UUID | None = Field(None, description="Привязка к стройплощадке")


class CameraUpdate(BaseModel):
    name: str | None = Field(None, description="Название камеры")
    code: str | None = Field(None, description="Код камеры")
    stream_url: str | None = Field(None, description="RTSP/HLS или IP поток")
    zone_id: uuid.UUID | None = Field(None, description="Привязка к стройплощадке")
    status: str | None = Field(None, description="Статус камеры (online/offline)")


class CameraItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    zone_id: uuid.UUID | None = None
    code: str
    name: str
    stream_url: str | None = None
    status: str = "offline"


class ProjectCreate(BaseModel):
    name: str = Field(..., description="Название объекта строительства")
    code: str | None = Field(None, description="Уникальный код объекта")
    address: str | None = Field(None, description="Адрес объекта")
    object_kind: str | None = Field("Жильё", description="Категория/тип объекта")


class ProjectItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    code: str
    name: str
    address: str | None = None
    object_kind: str | None = None
    status: str = "active"
    zones: list[ZoneItem] = Field(default_factory=list)
    cameras: list[CameraItem] = Field(default_factory=list)
    stages_count: int = 0


class DetectionBoxItem(BaseModel):
    class_id: int
    raw_label: str
    label_ru: str
    canonical_code: str
    confidence: float
    x1: float  # Normalized 0.0 - 1.0
    y1: float
    x2: float
    y2: float
    top: float  # Percentage 0 - 100 for direct CSS
    left: float
    width: float
    height: float


class FrameDetectionResponse(BaseModel):
    timestamp: str
    active_stage: str | None = None
    model_ready: bool = True
    detector_status: str = "ready"
    message: str | None = None
    count: int
    detections: list[DetectionBoxItem]
