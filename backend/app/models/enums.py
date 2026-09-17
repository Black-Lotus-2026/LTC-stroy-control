"""Перечисления домена.

Все перечисления хранятся в базе обычными строками, а не нативным типом
PostgreSQL. Причина: добавление значения в нативный enum требует отдельной
миграции с блокировкой таблицы, а набор статусов у нас меняется почти
каждый день. Корректность значений проверяет приложение (SQLAlchemy не
даст записать строку вне перечисления), поэтому новый статус — это правка
кода без миграции. См. docs/decisions/0004-data-model.md
"""

from __future__ import annotations

from enum import StrEnum


class ObjectCategory(StrEnum):
    """Категория распознаваемого класса.

    Техника — обязательная часть задачи; люди и СИЗ добавлены как
    отдельные категории того же справочника, а не как вторая подсистема.
    """

    EQUIPMENT = "equipment"
    PERSON = "person"
    PPE = "ppe"


class PPEStatus(StrEnum):
    """Состояние средства защиты у человека.

    Трёхзначное намеренно: по одному кадру «не видно каски» и «каски нет» —
    разные утверждения, и система не должна выдавать первое за второе.
    """

    PRESENT = "present"
    NOT_VISIBLE = "not_visible"
    ABSENT = "absent"


class CameraStatus(StrEnum):
    ONLINE = "online"
    DEGRADED = "degraded"
    OFFLINE = "offline"


class ZoneRiskLevel(StrEnum):
    NORMAL = "normal"
    ATTENTION = "attention"
    CRITICAL = "critical"


class ScheduleTaskStatus(StrEnum):
    PLANNED = "planned"
    ACTIVE = "active"
    COMPLETED = "completed"
    DELAYED = "delayed"
    CANCELLED = "cancelled"


class RuleKind(StrEnum):
    """Роль класса объектов в правиле для конкретного вида работ.

    REQUIRED  — должен присутствовать (отсутствие = отклонение);
    ALLOWED   — допустим, отклонением не считается;
    FORBIDDEN — не должен присутствовать на этом этапе.

    Класс, не упомянутый ни в одном правиле этапа, считается посторонним:
    именно так обнаруживается «техника, не соответствующая текущему этапу».
    """

    REQUIRED = "required"
    ALLOWED = "allowed"
    FORBIDDEN = "forbidden"


class FrameSource(StrEnum):
    """Откуда пришёл кадр. Дальше по конвейеру источник не имеет значения."""

    STREAM = "stream"  # выборка из видеопотока камеры
    UPLOAD = "upload"  # ручная загрузка через интерфейс
    DATASET = "dataset"  # пакетный импорт из папки с изображениями


class FrameStatus(StrEnum):
    PENDING = "pending"
    PROCESSING = "processing"
    ANALYZED = "analyzed"
    FAILED = "failed"


class AnalysisStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class IncidentCategory(StrEnum):
    """Крупная группа события — то, что показывается в колонке «Категория»."""

    EQUIPMENT = "equipment"
    PPE = "ppe"
    SAFETY = "safety"
    CAMERA = "camera"
    PROGRESS = "progress"
    DATA = "data"


class IncidentType(StrEnum):
    """Конкретное правило, породившее событие."""

    EQUIPMENT_MISSING = "equipment_missing"
    EQUIPMENT_INSUFFICIENT = "equipment_insufficient"
    EQUIPMENT_UNEXPECTED = "equipment_unexpected"
    PPE_MISSING = "ppe_missing"
    CAMERA_OFFLINE = "camera_offline"
    CAMERA_VISIBILITY = "camera_visibility"
    PROGRESS_DELAY = "progress_delay"
    IDLE_SUSPECTED = "idle_suspected"
    OTHER = "other"


class IncidentStatus(StrEnum):
    PENDING = "pending"  # требует проверки
    CONFIRMED = "confirmed"  # подтверждено человеком
    IN_PROGRESS = "in_progress"  # взято в работу
    RESOLVED = "resolved"  # устранено
    FALSE_POSITIVE = "false_positive"  # отклонено как ошибка распознавания


class IncidentPriority(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class RejectReason(StrEnum):
    LOW_IMAGE_QUALITY = "low_image_quality"
    WRONG_DETECTION = "wrong_detection"
    NOT_AN_INCIDENT = "not_an_incident"


class IncidentEventType(StrEnum):
    DETECTED = "detected"  # создано движком правил
    UPDATED = "updated"  # обновлено новым наблюдением
    ASSIGNED = "assigned"
    STATUS_CHANGED = "status_changed"
    COMMENTED = "commented"
    REJECTED = "rejected"
    AUTO_RESOLVED = "auto_resolved"  # закрыто самой системой


class EvidenceKind(StrEnum):
    PRIMARY = "primary"
    BEFORE = "before"
    AFTER = "after"
    CONTEXT = "context"


class UserRole(StrEnum):
    ADMIN = "admin"
    MANAGER = "manager"
    INSPECTOR = "inspector"
    VIEWER = "viewer"


class ObservationSource(StrEnum):
    """Источник нормализованной записи в журнале площадки."""

    CCTV = "cctv"
    CV = "cv"
    VLC = "vlc"
    MANUAL = "manual"
    SYSTEM = "system"


class ObservationCategory(StrEnum):
    SAFETY = "safety"
    PPE = "ppe"
    EQUIPMENT = "equipment"
    CAMERA = "camera"
    PROGRESS = "progress"
    DATA = "data"
    SYSTEM = "system"


class ObservationSeverity(StrEnum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


class ReportPeriod(StrEnum):
    HOUR = "hour"
    DAY = "day"
    WEEK = "week"
    CUSTOM = "custom"


class ReportStatus(StrEnum):
    PENDING = "pending"
    GENERATING = "generating"
    COMPLETED = "completed"
    FAILED = "failed"


class ReportScheduleFrequency(StrEnum):
    HOURLY = "hourly"
    DAILY = "daily"
    WEEKLY = "weekly"
