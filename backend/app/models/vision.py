"""Кадры, запуски распознавания и детекции."""

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

from app.db.base import Base, UUIDPrimaryKeyMixin, utcnow
from app.db.types import enum_column
from app.models.enums import AnalysisStatus, FrameSource, FrameStatus, PPEStatus
from app.models.project import Camera, Project, Zone
from app.models.reference import ObjectClass


class Frame(UUIDPrimaryKeyMixin, Base):
    """Единица обработки: один кадр.

    Намеренно не «изображение»: источником может быть и видеопоток, и
    загруженный файл, и папка датасета. После приёма источник значения не
    имеет — дальше по конвейеру все кадры равны.
    """

    __tablename__ = "frames"

    project_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    camera_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("cameras.id", ondelete="SET NULL"), default=None
    )
    # Дублирует зону камеры намеренно: камеру могут перевесить, а привязка
    # уже снятого кадра к зоне должна остаться прежней.
    zone_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("zones.id", ondelete="SET NULL"), default=None
    )

    # Сам файл лежит в хранилище, в базе только ключ.
    storage_key: Mapped[str] = mapped_column(Text)
    thumbnail_key: Mapped[str | None] = mapped_column(Text, default=None)

    # Время съёмки и время приёма различаются: пакетный импорт и потоки с
    # задержкой дают заметный разрыв, а правила опираются на время съёмки.
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    width: Mapped[int | None] = mapped_column(Integer, default=None)
    height: Mapped[int | None] = mapped_column(Integer, default=None)

    source: Mapped[FrameSource] = mapped_column(
        enum_column(FrameSource), default=FrameSource.UPLOAD
    )
    status: Mapped[FrameStatus] = mapped_column(
        enum_column(FrameStatus), default=FrameStatus.PENDING
    )

    # Сведения об источнике: имя файла, позиция в видео, идентификатор датасета.
    meta: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")

    project: Mapped[Project] = relationship()
    camera: Mapped[Camera | None] = relationship()
    zone: Mapped[Zone | None] = relationship()
    detections: Mapped[list[Detection]] = relationship(
        back_populates="frame", cascade="all, delete-orphan"
    )

    __table_args__ = (
        # Основной шаблон запросов: «кадры такой-то камеры за интервал».
        Index("ix_frames_camera_captured", "camera_id", "captured_at"),
    )

    def __repr__(self) -> str:
        return f"<Frame {self.id} {self.captured_at:%Y-%m-%d %H:%M:%S}>"


class AnalysisRun(UUIDPrimaryKeyMixin, Base):
    """Один запуск распознавания на кадре.

    Хранится отдельно от детекций, чтобы результат был воспроизводим: видно,
    какая модель и какой версии его получила. Один кадр можно переобработать
    новой моделью, не теряя прежний результат.
    """

    __tablename__ = "analysis_runs"

    frame_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("frames.id", ondelete="CASCADE"), index=True
    )

    model_name: Mapped[str] = mapped_column(String(64))
    model_version: Mapped[str] = mapped_column(String(32))
    params: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")

    status: Mapped[AnalysisStatus] = mapped_column(
        enum_column(AnalysisStatus), default=AnalysisStatus.QUEUED
    )
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )
    # Длительность в миллисекундах — показатель скорости обработки,
    # который нужен и для оценки решения, и для поиска узких мест.
    duration_ms: Mapped[int | None] = mapped_column(Integer, default=None)

    detection_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    error: Mapped[str | None] = mapped_column(Text, default=None)

    frame: Mapped[Frame] = relationship()
    detections: Mapped[list[Detection]] = relationship(
        back_populates="analysis_run", cascade="all, delete-orphan"
    )


class Detection(UUIDPrimaryKeyMixin, Base):
    """Объект, найденный на кадре.

    Факт наблюдения, а не суждение: детекция никогда не означает нарушение.
    Решение принимает движок правил, сопоставляя набор детекций за окно
    времени с планом работ.

    Координаты рамки нормализованы (0..1 от ширины и высоты кадра): это
    избавляет интерфейс от пересчёта под разрешение и делает данные
    сравнимыми между камерами.

    Зона определяется по камере, а не по координатам рамки: перевод координат
    кадра в координаты плана площадки требует калибровки камер, которой на
    исходных данных нет. Ограничение зафиксировано осознанно.
    """

    __tablename__ = "detections"

    analysis_run_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("analysis_runs.id", ondelete="CASCADE")
    )
    frame_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("frames.id", ondelete="CASCADE"), index=True
    )

    object_class_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("object_classes.id", ondelete="SET NULL"),
        default=None,
    )
    # Исходная метка модели до сопоставления со справочником. Сохраняется,
    # чтобы можно было найти классы, которые модель выдаёт, а справочник ещё
    # не знает.
    raw_label: Mapped[str | None] = mapped_column(String(64), default=None)

    confidence: Mapped[float] = mapped_column(Float)

    x1: Mapped[float] = mapped_column(Float)
    y1: Mapped[float] = mapped_column(Float)
    x2: Mapped[float] = mapped_column(Float)
    y2: Mapped[float] = mapped_column(Float)

    # Идентификатор трека при обработке видео: позволяет отличить три кадра
    # одного самосвала от трёх разных самосвалов. Без него счёт единиц
    # техники по правилам вида «min_count: 3» считался бы неверно.
    track_id: Mapped[str | None] = mapped_column(String(64), default=None, index=True)

    # Связь «каска → человек»: рамка СИЗ ссылается на рамку человека.
    parent_detection_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("detections.id", ondelete="SET NULL"),
        default=None,
    )

    # Состояние СИЗ у человека. Заполняется только для детекций людей.
    # Три значения, потому что «каска не видна» и «каски нет» — разные
    # утверждения, и система не должна выдавать первое за второе.
    ppe_status: Mapped[PPEStatus | None] = mapped_column(
        enum_column(PPEStatus), default=None
    )

    # Сырой ответ модели целиком: маска, ключевые точки, дополнительные поля.
    raw_result: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, index=True
    )

    analysis_run: Mapped[AnalysisRun] = relationship(back_populates="detections")
    frame: Mapped[Frame] = relationship(back_populates="detections")
    object_class: Mapped[ObjectClass | None] = relationship()

    def __repr__(self) -> str:
        return f"<Detection {self.raw_label} {self.confidence:.2f}>"
