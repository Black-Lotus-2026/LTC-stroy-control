"""Словари перечислений для интерфейса.

Значения перечислений уезжают в API латиницей (`pending`, `false_positive`),
потому что на них завязаны фильтры и условия. Подписи для человека живут
здесь и отдаются ручкой `/meta/dictionaries`: новый статус, добавленный в
`app/models/enums.py`, появляется в интерфейсе без правок фронтенда.
Обоснование — docs/decisions/0006-api-contract.md

Порядок ключей в словаре подписей — это порядок отображения. Поэтому
приоритеты перечислены от критического к низкому, а не так, как объявлены
в перечислении.
"""

from __future__ import annotations

from enum import StrEnum

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

# Перечисление -> (имя в API, заголовок для интерфейса, подписи значений).
# Имя в API — snake_case от имени класса: фронтенд обращается к
# `dictionaries.incident_status`, а не к `IncidentStatus`.
_DICTIONARIES: dict[str, tuple[str, type[StrEnum], dict[StrEnum, str]]] = {
    "incident_status": (
        "Статус инцидента",
        IncidentStatus,
        {
            IncidentStatus.PENDING: "Требует проверки",
            IncidentStatus.CONFIRMED: "Подтверждено",
            IncidentStatus.IN_PROGRESS: "В работе",
            IncidentStatus.RESOLVED: "Устранено",
            IncidentStatus.FALSE_POSITIVE: "Ложное срабатывание",
        },
    ),
    "incident_priority": (
        "Приоритет",
        IncidentPriority,
        {
            IncidentPriority.CRITICAL: "Критический",
            IncidentPriority.HIGH: "Высокий",
            IncidentPriority.MEDIUM: "Средний",
            IncidentPriority.LOW: "Низкий",
        },
    ),
    "incident_category": (
        "Категория события",
        IncidentCategory,
        {
            IncidentCategory.EQUIPMENT: "Техника",
            IncidentCategory.PPE: "Средства защиты",
            IncidentCategory.SAFETY: "Безопасность",
            IncidentCategory.CAMERA: "Камера",
            IncidentCategory.PROGRESS: "Ход работ",
            IncidentCategory.DATA: "Данные",
        },
    ),
    "incident_type": (
        "Тип отклонения",
        IncidentType,
        {
            IncidentType.EQUIPMENT_MISSING: "Ожидаемая техника не найдена",
            IncidentType.EQUIPMENT_INSUFFICIENT: "Техники меньше, чем требуется",
            IncidentType.EQUIPMENT_UNEXPECTED: "Техника не соответствует этапу",
            IncidentType.PPE_MISSING: "Нет средств защиты",
            IncidentType.CAMERA_OFFLINE: "Камера вне сети",
            IncidentType.CAMERA_VISIBILITY: "Обзор камеры ограничен",
            IncidentType.PROGRESS_DELAY: "Отставание от плана",
            IncidentType.IDLE_SUSPECTED: "Предполагаемый простой",
            IncidentType.OTHER: "Прочее",
        },
    ),
    "incident_event_type": (
        "Событие в истории инцидента",
        IncidentEventType,
        {
            IncidentEventType.DETECTED: "Выявлено системой",
            IncidentEventType.UPDATED: "Обновлено новым наблюдением",
            IncidentEventType.ASSIGNED: "Назначен ответственный",
            IncidentEventType.STATUS_CHANGED: "Изменён статус",
            IncidentEventType.COMMENTED: "Комментарий",
            IncidentEventType.REJECTED: "Отклонено как ошибка",
            IncidentEventType.AUTO_RESOLVED: "Закрыто автоматически",
        },
    ),
    "reject_reason": (
        "Причина отклонения",
        RejectReason,
        {
            RejectReason.WRONG_DETECTION: "Распознано неверно",
            RejectReason.LOW_IMAGE_QUALITY: "Плохое качество кадра",
            RejectReason.NOT_AN_INCIDENT: "Не является отклонением",
        },
    ),
    "camera_status": (
        "Состояние камеры",
        CameraStatus,
        {
            CameraStatus.ONLINE: "В сети",
            CameraStatus.DEGRADED: "С перебоями",
            CameraStatus.OFFLINE: "Вне сети",
        },
    ),
    "zone_risk_level": (
        "Уровень риска зоны",
        ZoneRiskLevel,
        {
            ZoneRiskLevel.CRITICAL: "Критический",
            ZoneRiskLevel.ATTENTION: "Повышенное внимание",
            ZoneRiskLevel.NORMAL: "Обычный",
        },
    ),
    "schedule_task_status": (
        "Статус работы по плану",
        ScheduleTaskStatus,
        {
            ScheduleTaskStatus.PLANNED: "Запланирована",
            ScheduleTaskStatus.ACTIVE: "Идёт",
            ScheduleTaskStatus.COMPLETED: "Завершена",
            ScheduleTaskStatus.DELAYED: "С отставанием",
            ScheduleTaskStatus.CANCELLED: "Отменена",
        },
    ),
    "object_category": (
        "Категория объекта",
        ObjectCategory,
        {
            ObjectCategory.EQUIPMENT: "Техника",
            ObjectCategory.PERSON: "Человек",
            ObjectCategory.PPE: "Средство защиты",
        },
    ),
    "ppe_status": (
        "Средство защиты",
        PPEStatus,
        {
            PPEStatus.PRESENT: "Есть",
            PPEStatus.NOT_VISIBLE: "Не видно на кадре",
            PPEStatus.ABSENT: "Отсутствует",
        },
    ),
    "rule_kind": (
        "Роль класса в правиле",
        RuleKind,
        {
            RuleKind.REQUIRED: "Обязательна",
            RuleKind.ALLOWED: "Допустима",
            RuleKind.FORBIDDEN: "Запрещена",
        },
    ),
    "frame_source": (
        "Источник кадра",
        FrameSource,
        {
            FrameSource.STREAM: "Видеопоток",
            FrameSource.UPLOAD: "Загружен вручную",
            FrameSource.DATASET: "Импорт из датасета",
        },
    ),
    "frame_status": (
        "Состояние кадра",
        FrameStatus,
        {
            FrameStatus.PENDING: "В очереди",
            FrameStatus.PROCESSING: "Обрабатывается",
            FrameStatus.ANALYZED: "Обработан",
            FrameStatus.FAILED: "Ошибка обработки",
        },
    ),
    "analysis_status": (
        "Состояние распознавания",
        AnalysisStatus,
        {
            AnalysisStatus.QUEUED: "В очереди",
            AnalysisStatus.RUNNING: "Выполняется",
            AnalysisStatus.COMPLETED: "Завершено",
            AnalysisStatus.FAILED: "Ошибка",
        },
    ),
    "evidence_kind": (
        "Роль кадра-доказательства",
        EvidenceKind,
        {
            EvidenceKind.PRIMARY: "Основной",
            EvidenceKind.BEFORE: "До",
            EvidenceKind.AFTER: "После",
            EvidenceKind.CONTEXT: "Контекст",
        },
    ),
    "user_role": (
        "Роль пользователя",
        UserRole,
        {
            UserRole.ADMIN: "Администратор",
            UserRole.MANAGER: "Руководитель",
            UserRole.INSPECTOR: "Инспектор",
            UserRole.VIEWER: "Наблюдатель",
        },
    ),
}


def missing_labels() -> dict[str, list[str]]:
    """Значения перечислений, для которых не написана подпись.

    Вызывается тестом: забытая подпись означает, что в интерфейсе появится
    голое `equipment_insufficient`, и заметит это только зритель демонстрации.
    """
    gaps: dict[str, list[str]] = {}
    for name, (_, enum_cls, labels) in _DICTIONARIES.items():
        absent = [m.value for m in enum_cls if m not in labels]
        if absent:
            gaps[name] = absent
    return gaps


def build_dictionaries() -> dict[str, dict]:
    """Собрать словари в том виде, в котором их ждёт интерфейс."""
    result: dict[str, dict] = {}
    for name, (title, enum_cls, labels) in _DICTIONARIES.items():
        # Значения без подписи всё равно отдаём — лучше показать машинное
        # значение, чем потерять вариант фильтра.
        ordered = list(labels) + [m for m in enum_cls if m not in labels]
        result[name] = {
            "title": title,
            "values": [
                {"value": member.value, "label": labels.get(member, member.value)}
                for member in ordered
            ],
        }
    return result
