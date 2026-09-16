"""Справочники: классы распознаваемых объектов и виды строительных работ."""

from __future__ import annotations

import uuid

from sqlalchemy import Boolean, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.db.types import enum_column
from app.models.enums import ObjectCategory


class ObjectClass(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Класс объекта, который умеет распознавать система.

    Один справочник на технику, людей и СИЗ: правила, детекции и статистика
    ссылаются сюда, поэтому добавление нового класса не требует изменений
    в схеме — достаточно строки в таблице.
    """

    __tablename__ = "object_classes"

    code: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128))
    category: Mapped[ObjectCategory] = mapped_column(enum_column(ObjectCategory))

    # Метки, которыми этот класс называет модель распознавания. Нужны, чтобы
    # смена или дообучение модели («excavator», «ekskavator», «class_3»)
    # не требовали правок в коде: соответствие настраивается данными.
    detector_labels: Mapped[list[str]] = mapped_column(
        JSONB, default=list, server_default="[]"
    )

    # Порог уверенности по умолчанию для этого класса. Мелкую или редкую
    # технику имеет смысл принимать с иным порогом, чем крупную.
    default_confidence_threshold: Mapped[float | None] = mapped_column(default=None)

    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    sort_order: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    def __repr__(self) -> str:
        return f"<ObjectClass {self.code}>"


class WorkType(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Вид работ из справочника организаторов.

    Справочник иерархический, при этом в исходном файле код заполнен не у
    всех строк, поэтому `code` допускает NULL, а уровень вложенности хранится
    отдельным полем — восстановленный импортёром, а не выведенный из кода.
    """

    __tablename__ = "work_types"

    code: Mapped[str | None] = mapped_column(String(32), index=True, default=None)
    name: Mapped[str] = mapped_column(String(512))

    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("work_types.id", ondelete="CASCADE"),
        default=None,
    )
    level: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    sort_order: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    description: Mapped[str | None] = mapped_column(Text, default=None)

    # Типы объектов, к которым применим вид работ («Жильё», «Образование»
    # и т.д.) — это колонки-галочки исходного файла. Хранятся списком, потому
    # что используются как признак для фильтрации, а не как ключ соединения.
    applicable_to: Mapped[list[str]] = mapped_column(
        JSONB, default=list, server_default="[]"
    )

    # Номер строки исходного файла: позволяет объяснить происхождение записи
    # и повторно проверить импорт, не открывая xlsx вручную.
    source_row: Mapped[int | None] = mapped_column(Integer, default=None)

    parent: Mapped[WorkType | None] = relationship(
        remote_side="WorkType.id", back_populates="children"
    )
    children: Mapped[list[WorkType]] = relationship(
        back_populates="parent", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:
        return f"<WorkType {self.code or '-'} {self.name[:40]}>"
