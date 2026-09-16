"""Методика сопоставления: правила «этап работ → техника» и ставки стоимости."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.db.types import enum_column
from app.models.enums import RuleKind
from app.models.reference import ObjectClass, WorkType


class RuleSet(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Версия методики сопоставления.

    Правила собраны в именованные версии, и каждый инцидент ссылается на ту,
    по которой он был создан. Благодаря этому вывод системы воспроизводим:
    видно не только «какая модель распознавания», но и «по каким правилам».
    Правка правил задним числом не меняет смысл уже созданных событий.
    """

    __tablename__ = "rule_sets"

    project_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        default=None,
        index=True,
    )

    name: Mapped[str] = mapped_column(String(128))
    version: Mapped[str] = mapped_column(String(32))
    description: Mapped[str | None] = mapped_column(Text, default=None)

    # Активный набор ровно один на площадку; проверка — в сервисном слое,
    # чтобы смена версии была явной операцией, а не побочным эффектом.
    is_active: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )

    requirements: Mapped[list[WorkRequirement]] = relationship(
        back_populates="rule_set", cascade="all, delete-orphan"
    )

    __table_args__ = (UniqueConstraint("project_id", "version"),)

    def __repr__(self) -> str:
        return f"<RuleSet {self.name} v{self.version}>"


class WorkRequirement(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Требование к составу объектов на этапе работ.

    Центральная таблица бизнес-логики: связь «вид работ → класс объектов»
    с количеством. Отклонения выводятся сравнением этой таблицы с тем, что
    фактически наблюдалось за окно времени.
    """

    __tablename__ = "work_requirements"

    rule_set_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("rule_sets.id", ondelete="CASCADE"), index=True
    )
    work_type_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("work_types.id", ondelete="CASCADE"), index=True
    )
    object_class_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("object_classes.id", ondelete="CASCADE")
    )

    kind: Mapped[RuleKind] = mapped_column(
        enum_column(RuleKind), default=RuleKind.REQUIRED
    )

    min_count: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    # NULL — верхнего предела нет.
    max_count: Mapped[int | None] = mapped_column(Integer, default=None)

    # Порог уверенности для этого правила; при NULL берётся порог класса,
    # затем порог площадки. Позволяет ужесточить редкие классы точечно.
    confidence_threshold: Mapped[float | None] = mapped_column(Float, default=None)

    # Текстовое обоснование правила — попадает в объяснение предупреждения,
    # чтобы пользователь видел не только «нарушено правило №12».
    rationale: Mapped[str | None] = mapped_column(Text, default=None)

    rule_set: Mapped[RuleSet] = relationship(back_populates="requirements")
    work_type: Mapped[WorkType] = relationship()
    object_class: Mapped[ObjectClass] = relationship()

    __table_args__ = (
        UniqueConstraint("rule_set_id", "work_type_id", "object_class_id"),
    )

    def __repr__(self) -> str:
        return f"<WorkRequirement {self.kind} x{self.min_count}>"


class CostRate(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Ставка стоимости единицы техники или бригады.

    Нужна для оценки потерь от простоя. Система измеряет длительность, ставку
    задаёт заказчик — поэтому сумма в отчёте опирается на введённые данные,
    а не на выдуманный коэффициент. Рассчитанные суммы в базе не хранятся:
    они вычисляются при формировании отчёта из длительности и ставки,
    действовавшей в тот период.
    """

    __tablename__ = "cost_rates"

    # NULL в project_id — ставка по умолчанию для всех площадок.
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        default=None,
        index=True,
    )
    object_class_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("object_classes.id", ondelete="CASCADE"),
        default=None,
    )

    # Numeric, а не float: деньги не должны накапливать ошибку округления.
    rate_per_hour: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    currency: Mapped[str] = mapped_column(String(3), default="RUB")

    # Ставки меняются во времени; период действия позволяет считать прошлые
    # периоды по тем ставкам, что действовали тогда.
    valid_from: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    valid_to: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )

    note: Mapped[str | None] = mapped_column(Text, default=None)

    object_class: Mapped[ObjectClass | None] = relationship()

    def __repr__(self) -> str:
        return f"<CostRate {self.rate_per_hour} {self.currency}/ч>"
