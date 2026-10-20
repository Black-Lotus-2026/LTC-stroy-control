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
    ObservationCategory,
    ObservationSeverity,
    ObservationSource,
    PPEStatus,
    RejectReason,
    ReportPeriod,
    ReportScheduleFrequency,
    ReportStatus,
    RuleKind,
    ScheduleTaskStatus,
    UserRole,
    ZoneRiskLevel,
)
from app.models.alert import AlertNotification
from app.models.geocoding import GeocodingThrottle
from app.models.incident import Incident, IncidentEvent, IncidentEvidence
from app.models.management import ManagementRun, ManagementRunStep, TaskDependency
from app.models.project import (
    Camera,
    CameraHealthEvent,
    Project,
    ProjectSettings,
    Zone,
)
from app.models.reference import ObjectClass, WorkType
from app.models.report import GeneratedReport, ObservationLog, ReportSchedule
from app.models.rules import CostRate, RuleSet, WorkRequirement
from app.models.safety import (
    SafetyDocument,
    SafetyRequirement,
    SafetySanction,
    SafetyZone,
    SafetyTrack,
    SafetyFrameReceipt,
    SafetyEvent,
)  # noqa: F401
from app.models.schedule import ScheduleTask
from app.models.user import User
from app.models.video import VideoAsset
from app.models.vision import AnalysisRun, Detection, Frame
from app.models.weather import WeatherForecast

__all__ = [
    "SafetyDocument",
    "SafetyRequirement",
    "SafetySanction",
    "SafetyZone",
    "SafetyTrack",
    "SafetyFrameReceipt",
    "SafetyEvent",
    "ManagementRun",
    "ManagementRunStep",
    "TaskDependency",
    # Справочники
    "ObjectClass",
    "WorkType",
    # Площадка
    "Project",
    "ProjectSettings",
    "Zone",
    "Camera",
    "CameraHealthEvent",
    "WeatherForecast",
    "GeocodingThrottle",
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
    "AlertNotification",
    "VideoAsset",
    "User",
    # Временная шкала и отчёты
    "ObservationLog",
    "ReportSchedule",
    "GeneratedReport",
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
    "ObservationCategory",
    "ObservationSeverity",
    "ObservationSource",
    "PPEStatus",
    "RejectReason",
    "ReportPeriod",
    "ReportScheduleFrequency",
    "ReportStatus",
    "RuleKind",
    "ScheduleTaskStatus",
    "UserRole",
    "ZoneRiskLevel",
]
