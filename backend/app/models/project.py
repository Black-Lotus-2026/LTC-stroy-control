"""Площадка, её зоны и камеры."""

from __future__ import annotations

import uuid
from datetime import datetime, time

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    Time,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.db.types import enum_column
from app.models.enums import CameraStatus, ZoneRiskLevel


class Project(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Строительная площадка."""

    __tablename__ = "projects"

    code: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(256))
    address: Mapped[str | None] = mapped_column(Text, default=None)

    # Часовой пояс площадки. В базе всё время хранится в UTC, этот пояс
    # используется при переводе на границе API и при разборе календарного плана.
    timezone: Mapped[str] = mapped_column(String(64), default="Europe/Moscow")

    # Границы смены: вне смены отсутствие техники — это норма, а не отклонение.
    shift_start: Mapped[time] = mapped_column(Time, default=time(8, 0))
    shift_end: Mapped[time] = mapped_column(Time, default=time(20, 0))

    # Тип объекта («Жильё», «Образование», ...). Связан со справочником видов
    # работ: он размечен применимостью к типам объектов.
    object_kind: Mapped[str | None] = mapped_column(String(64), default=None)

    status: Mapped[str] = mapped_column(String(32), default="active")

    zones: Mapped[list[Zone]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    cameras: Mapped[list[Camera]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    settings: Mapped[ProjectSettings | None] = relationship(
        back_populates="project", cascade="all, delete-orphan", uselist=False
    )

    def __repr__(self) -> str:
        return f"<Project {self.code}>"


class ProjectSettings(TimestampMixin, Base):
    """Параметры автоматического наблюдения для площадки.

    Вынесены в отдельную таблицу, а не в колонки проекта: это настройки
    работы алгоритма, они меняются чаще и читаются другим кодом.
    """

    __tablename__ = "project_settings"

    project_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"),
        primary_key=True,
    )

    observation_enabled: Mapped[bool] = mapped_column(
        Boolean, default=True, server_default="true"
    )

    # Порог уверенности, ниже которого детекция не учитывается правилами.
    default_confidence_threshold: Mapped[float] = mapped_column(
        Float, default=0.5, server_default="0.5"
    )

    # Окно, за которое движок правил собирает наблюдения перед выводом.
    # Один кадр решения не принимает — см. docs/decisions/0002-celery.md
    matching_window_minutes: Mapped[int] = mapped_column(
        Integer, default=15, server_default="15"
    )

    # Сколько последовательных проверок подряд должны не найти технику,
    # прежде чем будет создан инцидент.
    min_consecutive_misses: Mapped[int] = mapped_column(
        Integer, default=3, server_default="3"
    )

    # Срок реакции на событие по умолчанию, от него считается SLA.
    default_sla_minutes: Mapped[int] = mapped_column(
        Integer, default=60, server_default="60"
    )

    # Сколько минут без видимого изменения положения техники считать
    # предполагаемым простоем.
    idle_threshold_minutes: Mapped[int] = mapped_column(
        Integer, default=20, server_default="20"
    )

    extra: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")

    project: Mapped[Project] = relationship(back_populates="settings")


class Zone(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Участок площадки: котлован, складирование, корпус и т.п."""

    __tablename__ = "zones"

    project_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )

    code: Mapped[str] = mapped_column(String(32), index=True)
    name: Mapped[str] = mapped_column(String(128))
    description: Mapped[str | None] = mapped_column(Text, default=None)

    # Контур зоны на схеме площадки в нормализованных координатах 0..1.
    # Это координаты плана, а не кадра: связать рамку на кадре с зоной по
    # ним нельзя — см. примечание к модели Detection.
    geometry: Mapped[dict | None] = mapped_column(JSONB, default=None)

    risk_level: Mapped[ZoneRiskLevel] = mapped_column(
        enum_column(ZoneRiskLevel), default=ZoneRiskLevel.NORMAL
    )
    status: Mapped[str] = mapped_column(String(32), default="active")

    project: Mapped[Project] = relationship(back_populates="zones")
    cameras: Mapped[list[Camera]] = relationship(back_populates="zone")

    def __repr__(self) -> str:
        return f"<Zone {self.code}>"


class Camera(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Камера видеонаблюдения."""

    __tablename__ = "cameras"

    project_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    zone_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("zones.id", ondelete="SET NULL"), default=None
    )

    code: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128))

    status: Mapped[CameraStatus] = mapped_column(
        enum_column(CameraStatus), default=CameraStatus.OFFLINE
    )

    # Какую долю рабочей зоны камера реально видит. Используется в объяснении
    # предупреждений: при низком значении вывод «техники нет» недостоверен.
    visibility_percent: Mapped[int] = mapped_column(
        Integer, default=100, server_default="100"
    )

    stream_url: Mapped[str | None] = mapped_column(Text, default=None)
    archive_url: Mapped[str | None] = mapped_column(Text, default=None)

    # Как часто снимать кадр из потока.
    capture_interval_seconds: Mapped[int] = mapped_column(
        Integer, default=30, server_default="30"
    )

    last_frame_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )
    last_heartbeat_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )

    project: Mapped[Project] = relationship(back_populates="cameras")
    zone: Mapped[Zone | None] = relationship(back_populates="cameras")

    def __repr__(self) -> str:
        return f"<Camera {self.code}>"


class CameraHealthEvent(UUIDPrimaryKeyMixin, Base):
    """История состояний камеры.

    Нужна, чтобы отвечать на вопрос «с какого времени камера вне сети»,
    а не только «вне сети сейчас», и чтобы считать долю доступного времени.
    """

    __tablename__ = "camera_health_events"

    camera_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("cameras.id", ondelete="CASCADE"), index=True
    )
    status: Mapped[CameraStatus] = mapped_column(enum_column(CameraStatus))

    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    # NULL означает, что состояние длится до сих пор.
    ended_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )

    reason: Mapped[str | None] = mapped_column(Text, default=None)

    camera: Mapped[Camera] = relationship()
