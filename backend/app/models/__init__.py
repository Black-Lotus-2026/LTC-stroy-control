"""Модели данных.

Импортируются здесь все до одной: Alembic строит миграции по
`Base.metadata`, а она наполняется только теми классами, которые
успели импортироваться. Пропущенная модель — молча потерянная таблица.
"""

from app.models.enums import (
    AnalysisStatus,
    CameraStatus,
    EvidenceKind,
    FrameSource,
    FrameStatus,
    IncidentCategory,
    IncidentEventType,
    IncidentPriority,
    IncidentStatus,
    IncidentType,
    ObjectCategory,
    PPEStatus,
    RejectReason,
    RuleKind,
    ScheduleTaskStatus,
    UserRole,
    ZoneRiskLevel,
)
from app.models.incident import Incident, IncidentEvent, IncidentEvidence, VlmVerification
from app.models.project import (
    Camera,
    CameraHealthEvent,
    Project,
    ProjectSettings,
    Zone,
)
from app.models.reference import ObjectClass, WorkType
from app.models.rules import CostRate, RuleSet, WorkRequirement
from app.models.schedule import ScheduleTask
from app.models.user import User
from app.models.video import VideoAsset
from app.models.vision import AnalysisRun, Detection, Frame

__all__ = [
    # Справочники
    "ObjectClass",
    "WorkType",
    # Площадка
    "Project",
    "ProjectSettings",
    "Zone",
    "Camera",
    "CameraHealthEvent",
    # План и методика
    "ScheduleTask",
    "RuleSet",
    "WorkRequirement",
    "CostRate",
    # Распознавание
    "Frame",
    "AnalysisRun",
    "Detection",
    # События
    "Incident",
    "IncidentEvent",
    "IncidentEvidence",
    "VlmVerification",
    "VideoAsset",
    "User",
    # Перечисления
    "AnalysisStatus",
    "CameraStatus",
    "EvidenceKind",
    "FrameSource",
    "FrameStatus",
    "IncidentCategory",
    "IncidentEventType",
    "IncidentPriority",
    "IncidentStatus",
    "IncidentType",
    "ObjectCategory",
    "PPEStatus",
    "RejectReason",
    "RuleKind",
    "ScheduleTaskStatus",
    "UserRole",
    "ZoneRiskLevel",
]
