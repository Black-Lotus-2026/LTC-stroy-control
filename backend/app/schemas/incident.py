"""Контракты инцидента: чтение, история, доказательства и действия.

Сборка ответа вынесена в методы `from_model`, а не оставлена на
`from_attributes`, из-за двух полей, которых в базе нет: `is_overdue`
считается от текущего момента на сервере, а `image_url` формирует слой
хранилища (сегодня диск, завтра S3 — контракт при этом не меняется).
"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import (
    IncidentCategory,
    IncidentEventType,
    IncidentPriority,
    IncidentStatus,
    IncidentType,
    RejectReason,
)
from app.models.incident import Incident, IncidentEvidence
from app.schemas.project import CameraBrief, ZoneBrief
from app.schemas.schedule import ScheduleTaskBrief
from app.schemas.user import UserBrief
from app.storage import get_storage


class IncidentExplanation(BaseModel):
    """Объяснение вывода: почему система считает это отклонением.

    `limitations` — обязательная часть, а не украшение. Отсутствие техники
    на кадре не равно её отсутствию на площадке, и интерфейс обязан
    показывать это рядом с выводом. Форма поля зафиксирована в
    docs/decisions/0006-api-contract.md
    """

    summary: str = ""
    factors: list[str] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)


class IncidentEventRead(BaseModel):
    """Запись в истории. `user` пуст, если действие выполнила система."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    event_type: IncidentEventType
    old_status: IncidentStatus | None
    new_status: IncidentStatus | None
    comment: str | None
    created_at: datetime
    user: UserBrief | None


class IncidentEvidenceRead(BaseModel):
    id: uuid.UUID
    kind: str
    frame_id: uuid.UUID
    captured_at: datetime
    image_url: str
    thumbnail_url: str | None
    detection_ids: list[str] = Field(
        default_factory=list,
        description="Какие именно рамки на кадре относятся к делу",
    )

    @classmethod
    def from_model(cls, evidence: IncidentEvidence) -> IncidentEvidenceRead:
        storage = get_storage()
        frame = evidence.frame
        return cls(
            id=evidence.id,
            kind=str(evidence.kind),
            frame_id=frame.id,
            captured_at=frame.captured_at,
            image_url=storage.public_url(frame.storage_key),
            thumbnail_url=(
                storage.public_url(frame.thumbnail_key)
                if frame.thumbnail_key
                else None
            ),
            detection_ids=list(evidence.detection_ids or []),
        )


class IncidentRead(BaseModel):
    """Инцидент в ленте: всё, что нужно карточке списка."""

    id: uuid.UUID
    code: str = Field(description="Код для человека, например INC-247")
    project_id: uuid.UUID

    category: IncidentCategory
    type: IncidentType
    title: str

    status: IncidentStatus
    priority: IncidentPriority
    confidence: float = Field(
        ge=0, le=1, description="Уверенность в выводе, доля от 0 до 1"
    )

    observation_count: int = Field(
        description="Из скольких наблюдений склеен инцидент"
    )
    first_seen_at: datetime
    last_seen_at: datetime

    sla_deadline: datetime | None
    is_overdue: bool = Field(
        description="Срок реакции истёк. Считает сервер: часы клиента могут "
        "расходиться с серверными"
    )
    resolved_at: datetime | None
    reject_reason: RejectReason | None

    zone: ZoneBrief | None
    camera: CameraBrief | None
    assignee: UserBrief | None

    @classmethod
    def from_model(cls, incident: Incident, *, now: datetime) -> IncidentRead:
        return cls(
            id=incident.id,
            code=incident.code,
            project_id=incident.project_id,
            category=incident.category,
            type=incident.type,
            title=incident.title,
            status=incident.status,
            priority=incident.priority,
            confidence=incident.confidence,
            observation_count=incident.observation_count,
            first_seen_at=incident.first_seen_at,
            last_seen_at=incident.last_seen_at,
            sla_deadline=incident.sla_deadline,
            is_overdue=is_overdue(incident, now=now),
            resolved_at=incident.resolved_at,
            reject_reason=incident.reject_reason,
            zone=ZoneBrief.model_validate(incident.zone) if incident.zone else None,
            camera=(
                CameraBrief.model_validate(incident.camera)
                if incident.camera
                else None
            ),
            assignee=(
                UserBrief.model_validate(incident.assignee)
                if incident.assignee
                else None
            ),
        )


class IncidentDetail(IncidentRead):
    """Инцидент целиком: с объяснением, историей и кадрами-доказательствами."""

    description: str | None
    explanation: IncidentExplanation
    schedule_task: ScheduleTaskBrief | None
    rule_set_id: uuid.UUID | None
    events: list[IncidentEventRead]
    evidence: list[IncidentEvidenceRead]

    @classmethod
    def from_model(cls, incident: Incident, *, now: datetime) -> IncidentDetail:
        base = IncidentRead.from_model(incident, now=now).model_dump()
        return cls(
            **base,
            description=incident.description,
            explanation=IncidentExplanation.model_validate(
                incident.explanation or {}
            ),
            schedule_task=(
                ScheduleTaskBrief.model_validate(incident.schedule_task)
                if incident.schedule_task
                else None
            ),
            rule_set_id=incident.rule_set_id,
            events=[
                IncidentEventRead.model_validate(event) for event in incident.events
            ],
            evidence=[
                IncidentEvidenceRead.from_model(item) for item in incident.evidence
            ],
        )


def is_overdue(incident: Incident, *, now: datetime) -> bool:
    """Просрочен ли срок реакции.

    Закрытые инциденты просроченными не считаются, даже если срок прошёл:
    иначе счётчик «просрочено» рос бы вечно и перестал бы что-либо значить.
    """
    if incident.sla_deadline is None:
        return False
    if incident.status in (IncidentStatus.RESOLVED, IncidentStatus.FALSE_POSITIVE):
        return False
    return incident.sla_deadline < now


# --- Тела запросов на действия ---------------------------------------------
# Действия — отдельные ручки, а не PATCH: каждое пишет строку в историю и
# имеет свои обязательные параметры. См. docs/decisions/0006-api-contract.md


class ActorRequest(BaseModel):
    """Общая часть: кто совершает действие.

    Поле необязательное, потому что аутентификации в прототипе нет; пустое
    значение означает «система». Когда появится вход по паролю, поле
    исчезнет из тела запроса, а не поменяет смысл.
    """

    actor_user_id: uuid.UUID | None = None


class IncidentAssignRequest(ActorRequest):
    user_id: uuid.UUID = Field(description="Кому назначается инцидент")
    comment: str | None = None


class IncidentStatusChangeRequest(ActorRequest):
    status: IncidentStatus
    comment: str | None = None
    reject_reason: RejectReason | None = Field(
        default=None,
        description=(
            "Обязательна при переводе в false_positive и запрещена в "
            "остальных случаях: накопленные причины — материал для "
            "дообучения модели"
        ),
    )


class IncidentCommentRequest(ActorRequest):
    text: str = Field(min_length=1, max_length=4000)
