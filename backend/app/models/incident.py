"""Инциденты: выявленные отклонения, их история и доказательства."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin, utcnow
from app.db.types import enum_column
from app.models.enums import (
    EvidenceKind,
    IncidentCategory,
    IncidentEventType,
    IncidentPriority,
    IncidentStatus,
    IncidentType,
    RejectReason,
)
from app.models.project import Camera, Zone
from app.models.rules import RuleSet
from app.models.schedule import ScheduleTask
from app.models.user import User
from app.models.vision import Frame


class Incident(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Отклонение, выявленное движком правил.

    Создаётся не по кадру, а по окну наблюдений, поэтому у инцидента есть
    время первого и последнего подтверждения и счётчик наблюдений — он же
    показывается в интерфейсе как «объединено из N наблюдений».
    """

    __tablename__ = "incidents"

    # Короткий код для людей: он же показывается в интерфейсе и называется
    # в разговоре («проверь INC-247»). Внутренние связи идут по id.
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True)

    project_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    zone_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("zones.id", ondelete="SET NULL"), default=None
    )
    camera_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("cameras.id", ondelete="SET NULL"), default=None
    )
    schedule_task_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("schedule_tasks.id", ondelete="SET NULL"),
        default=None,
    )
    # Версия методики, по которой сделан вывод. Без неё нельзя объяснить,
    # почему месяц назад система решила иначе.
    rule_set_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("rule_sets.id", ondelete="SET NULL"),
        default=None,
    )

    category: Mapped[IncidentCategory] = mapped_column(enum_column(IncidentCategory))
    type: Mapped[IncidentType] = mapped_column(enum_column(IncidentType))

    title: Mapped[str] = mapped_column(String(256))
    description: Mapped[str | None] = mapped_column(Text, default=None)

    # Структурированное объяснение вывода: что ожидалось, что наблюдалось,
    # какие ограничения у наблюдения. Поле обязано заполняться движком, а не
    # человеком — на нём держится проверяемость предупреждений.
    # Ожидаемая форма: {"summary": str, "factors": [...], "limitations": [...]}
    explanation: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")

    status: Mapped[IncidentStatus] = mapped_column(
        enum_column(IncidentStatus), default=IncidentStatus.PENDING, index=True
    )
    priority: Mapped[IncidentPriority] = mapped_column(
        enum_column(IncidentPriority), default=IncidentPriority.MEDIUM
    )

    # Уверенность в выводе (0..1) — не уверенность детектора, а агрегат:
    # учитывает число подтверждений и качество обзора камеры.
    confidence: Mapped[float] = mapped_column(Float, default=0.0)

    # Ключ склейки повторов: пока инцидент открыт, новые наблюдения того же
    # отклонения обновляют его, а не плодят одинаковые карточки. Без этого
    # лента событий забивается дублями за минуты работы.
    dedup_key: Mapped[str] = mapped_column(String(256), index=True)

    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    observation_count: Mapped[int] = mapped_column(
        Integer, default=1, server_default="1"
    )

    assigned_user_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), default=None
    )

    sla_deadline: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )
    resolved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )
    # Заполняется при отклонении наблюдения как ошибочного. Накопленные
    # причины — материал для дообучения модели.
    reject_reason: Mapped[RejectReason | None] = mapped_column(
        enum_column(RejectReason), default=None
    )

    zone: Mapped[Zone | None] = relationship()
    camera: Mapped[Camera | None] = relationship()
    schedule_task: Mapped[ScheduleTask | None] = relationship()
    rule_set: Mapped[RuleSet | None] = relationship()
    assignee: Mapped[User | None] = relationship()

    events: Mapped[list[IncidentEvent]] = relationship(
        back_populates="incident",
        cascade="all, delete-orphan",
        order_by="IncidentEvent.created_at",
    )
    evidence: Mapped[list[IncidentEvidence]] = relationship(
        back_populates="incident", cascade="all, delete-orphan"
    )

    __table_args__ = (
        # Лента инцидентов площадки за период — самый частый запрос интерфейса.
        Index("ix_incidents_project_first_seen", "project_id", "first_seen_at"),
        # Поиск открытого инцидента по ключу склейки при каждом прогоне правил.
        Index("ix_incidents_dedup_status", "dedup_key", "status"),
    )

    def __repr__(self) -> str:
        return f"<Incident {self.code} {self.type}>"


class IncidentEvent(UUIDPrimaryKeyMixin, Base):
    """Запись в истории инцидента.

    История не перезаписывается: каждое изменение статуса, назначение и
    комментарий добавляют строку. Это и лента для интерфейса, и доказательство
    того, что отклонение было доведено до устранения.
    """

    __tablename__ = "incident_events"

    incident_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("incidents.id", ondelete="CASCADE"), index=True
    )
    event_type: Mapped[IncidentEventType] = mapped_column(
        enum_column(IncidentEventType)
    )

    old_status: Mapped[IncidentStatus | None] = mapped_column(
        enum_column(IncidentStatus), default=None
    )
    new_status: Mapped[IncidentStatus | None] = mapped_column(
        enum_column(IncidentStatus), default=None
    )

    # NULL означает, что действие выполнила система, а не человек.
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), default=None
    )

    comment: Mapped[str | None] = mapped_column(Text, default=None)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow
    )

    incident: Mapped[Incident] = relationship(back_populates="events")
    user: Mapped[User | None] = relationship()


class IncidentEvidence(UUIDPrimaryKeyMixin, Base):
    """Кадр, подтверждающий инцидент.

    Предупреждение без кадра проверить нельзя, поэтому доказательство —
    обязательная часть события, а не приложение к нему.
    """

    __tablename__ = "incident_evidence"

    incident_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("incidents.id", ondelete="CASCADE"), index=True
    )
    frame_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("frames.id", ondelete="CASCADE")
    )

    kind: Mapped[EvidenceKind] = mapped_column(
        enum_column(EvidenceKind), default=EvidenceKind.PRIMARY
    )

    # Какие именно рамки на кадре относятся к делу: интерфейс подсвечивает
    # их, а не все детекции подряд.
    detection_ids: Mapped[list[str]] = mapped_column(
        JSONB, default=list, server_default="[]"
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow
    )

    incident: Mapped[Incident] = relationship(back_populates="evidence")
    frame: Mapped[Frame] = relationship()
