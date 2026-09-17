"""Лента инцидентов и действия над ними.

Главное правило этого модуля: любое изменение инцидента добавляет строку в
историю (`incident_events`). История не перезаписывается — она и лента для
интерфейса, и доказательство того, что отклонение довели до устранения.
Поэтому менять поля инцидента в обход этих функций нельзя.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import Select, case, or_, select
from sqlalchemy.orm import Session, selectinload

from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.db.base import utcnow
from app.models.enums import (
    IncidentCategory,
    IncidentEventType,
    IncidentPriority,
    IncidentStatus,
    IncidentType,
    RejectReason,
)
from app.models.incident import Incident, IncidentEvent, IncidentEvidence
from app.models.user import User
from app.services.pagination import paginate

# Статусы, в которых инцидент считается закрытым.
CLOSED_STATUSES = (IncidentStatus.RESOLVED, IncidentStatus.FALSE_POSITIVE)

# Порядок важности для сортировки. В базе приоритет — строка, поэтому
# «сначала критические» без такого отображения превратилось бы в сортировку
# по алфавиту, где critical идёт перед low по случайности, а high — нет.
_PRIORITY_WEIGHT = {
    IncidentPriority.CRITICAL: 4,
    IncidentPriority.HIGH: 3,
    IncidentPriority.MEDIUM: 2,
    IncidentPriority.LOW: 1,
}

SORT_FIELDS = (
    "-first_seen_at",
    "first_seen_at",
    "-last_seen_at",
    "-priority",
    "-confidence",
    "-sla_deadline",
)


@dataclass
class IncidentFilters:
    """Набор фильтров ленты.

    Собран в один объект, чтобы сигнатура `list_incidents` не разрасталась
    до десятка аргументов и чтобы тот же набор можно было передать в отчёты.
    """

    project_id: uuid.UUID | None = None
    zone_id: uuid.UUID | None = None
    camera_id: uuid.UUID | None = None
    assigned_user_id: uuid.UUID | None = None
    statuses: Sequence[IncidentStatus] = field(default_factory=tuple)
    categories: Sequence[IncidentCategory] = field(default_factory=tuple)
    types: Sequence[IncidentType] = field(default_factory=tuple)
    priorities: Sequence[IncidentPriority] = field(default_factory=tuple)
    date_from: datetime | None = None
    date_to: datetime | None = None
    query: str | None = None
    only_open: bool = False


def _list_options() -> tuple:
    """Что подгружать для карточки в ленте.

    `selectinload` вместо ленивой загрузки: без него список из 50 инцидентов
    даёт 150 дополнительных запросов, по три на строку.
    """
    return (
        selectinload(Incident.zone),
        selectinload(Incident.camera),
        selectinload(Incident.assignee),
    )


def _detail_options() -> tuple:
    return (
        *_list_options(),
        selectinload(Incident.schedule_task),
        selectinload(Incident.events).selectinload(IncidentEvent.user),
        selectinload(Incident.evidence).selectinload(IncidentEvidence.frame),
    )


def _apply_filters(stmt: Select, filters: IncidentFilters) -> Select:
    if filters.project_id is not None:
        stmt = stmt.where(Incident.project_id == filters.project_id)
    if filters.zone_id is not None:
        stmt = stmt.where(Incident.zone_id == filters.zone_id)
    if filters.camera_id is not None:
        stmt = stmt.where(Incident.camera_id == filters.camera_id)
    if filters.assigned_user_id is not None:
        stmt = stmt.where(Incident.assigned_user_id == filters.assigned_user_id)
    if filters.statuses:
        stmt = stmt.where(Incident.status.in_(list(filters.statuses)))
    if filters.categories:
        stmt = stmt.where(Incident.category.in_(list(filters.categories)))
    if filters.types:
        stmt = stmt.where(Incident.type.in_(list(filters.types)))
    if filters.priorities:
        stmt = stmt.where(Incident.priority.in_(list(filters.priorities)))
    if filters.only_open:
        stmt = stmt.where(Incident.status.notin_(list(CLOSED_STATUSES)))
    # Интервал задаётся по времени первого наблюдения: именно оно отвечает
    # на вопрос «что произошло за смену», а last_seen_at у длящегося
    # инцидента продолжает расти и вытаскивал бы его в любой период.
    if filters.date_from is not None:
        stmt = stmt.where(Incident.first_seen_at >= filters.date_from)
    if filters.date_to is not None:
        stmt = stmt.where(Incident.first_seen_at <= filters.date_to)
    if filters.query:
        pattern = f"%{filters.query.strip()}%"
        stmt = stmt.where(
            or_(Incident.code.ilike(pattern), Incident.title.ilike(pattern))
        )
    return stmt


def _apply_sort(stmt: Select, sort: str) -> Select:
    if sort == "first_seen_at":
        return stmt.order_by(Incident.first_seen_at.asc())
    if sort == "-last_seen_at":
        return stmt.order_by(Incident.last_seen_at.desc())
    if sort == "-confidence":
        return stmt.order_by(Incident.confidence.desc(), Incident.first_seen_at.desc())
    if sort == "-sla_deadline":
        # Инциденты без срока уходят в конец, а не всплывают наверх как NULL.
        return stmt.order_by(
            Incident.sla_deadline.asc().nullslast(), Incident.first_seen_at.desc()
        )
    if sort == "-priority":
        weight = case(_PRIORITY_WEIGHT, value=Incident.priority, else_=0)
        return stmt.order_by(weight.desc(), Incident.first_seen_at.desc())
    return stmt.order_by(Incident.first_seen_at.desc())


def list_incidents(
    db: Session,
    filters: IncidentFilters,
    *,
    page: int,
    page_size: int,
    sort: str = "-first_seen_at",
) -> tuple[list[Incident], int]:
    stmt = _apply_sort(_apply_filters(select(Incident), filters), sort)
    return paginate(db, stmt.options(*_list_options()), page=page, page_size=page_size)


def get_incident(db: Session, incident_id: uuid.UUID) -> Incident:
    stmt = (
        select(Incident).options(*_detail_options()).where(Incident.id == incident_id)
    )
    incident = db.scalars(stmt).unique().first()
    if incident is None:
        raise NotFoundError(
            f"Инцидент {incident_id} не найден", code="INCIDENT_NOT_FOUND"
        )
    return incident


def get_incident_by_code(db: Session, code: str) -> Incident:
    """Поиск по коду вида INC-247: его называют люди, а не интерфейс."""
    stmt = select(Incident).options(*_detail_options()).where(Incident.code == code)
    incident = db.scalars(stmt).unique().first()
    if incident is None:
        raise NotFoundError(f"Инцидент {code} не найден", code="INCIDENT_NOT_FOUND")
    return incident


def _reload(db: Session, incident_id: uuid.UUID) -> Incident:
    """Перечитать инцидент после изменения.

    `expire_all` здесь обязателен. Сессия создаётся с `expire_on_commit=False`
    (иначе каждое обращение к полю после коммита било бы в базу), поэтому
    объект остаётся в карте идентичности и повторный запрос возвращает его
    прежнюю версию — вместе с прежним составом истории и прежним
    ответственным. Без этой строки ответ на действие отставал бы на один шаг:
    интерфейс показывал бы состояние до нажатия кнопки.
    """
    db.expire_all()
    return get_incident(db, incident_id)


def _require_user(db: Session, user_id: uuid.UUID | None) -> User | None:
    if user_id is None:
        return None
    user = db.get(User, user_id)
    if user is None:
        raise NotFoundError(
            f"Пользователь {user_id} не найден", code="USER_NOT_FOUND"
        )
    return user


def assign_incident(
    db: Session,
    incident_id: uuid.UUID,
    *,
    user_id: uuid.UUID,
    actor_user_id: uuid.UUID | None = None,
    comment: str | None = None,
) -> Incident:
    """Назначить ответственного."""
    incident = get_incident(db, incident_id)
    assignee = _require_user(db, user_id)
    actor = _require_user(db, actor_user_id)
    assert assignee is not None  # user_id обязателен, _require_user вернёт объект

    # Повторное назначение того же человека без комментария историю не
    # засоряет: двойной щелчок в интерфейсе не должен порождать запись.
    unchanged = incident.assigned_user_id == assignee.id and not comment
    incident.assigned_user_id = assignee.id

    if not unchanged:
        db.add(
            IncidentEvent(
                incident_id=incident.id,
                event_type=IncidentEventType.ASSIGNED,
                user_id=actor.id if actor else None,
                comment=comment or f"Назначен ответственный: {assignee.name}",
            )
        )
    db.commit()
    return _reload(db, incident_id)


def change_status(
    db: Session,
    incident_id: uuid.UUID,
    *,
    status: IncidentStatus,
    actor_user_id: uuid.UUID | None = None,
    comment: str | None = None,
    reject_reason: RejectReason | None = None,
) -> Incident:
    """Перевести инцидент в другой статус.

    Причина отклонения обязательна ровно для `false_positive` и запрещена в
    остальных случаях: накопленные причины — материал для дообучения модели,
    и смысла у причины при переводе в «устранено» нет.
    """
    incident = get_incident(db, incident_id)
    actor = _require_user(db, actor_user_id)

    if status is IncidentStatus.FALSE_POSITIVE and reject_reason is None:
        raise ValidationError(
            "Отклонение инцидента требует указания причины",
            {"field": "reject_reason"},
            code="REJECT_REASON_REQUIRED",
        )
    if status is not IncidentStatus.FALSE_POSITIVE and reject_reason is not None:
        raise ValidationError(
            "Причина отклонения указывается только при переводе в "
            "«ложное срабатывание»",
            {"field": "reject_reason"},
            code="REJECT_REASON_NOT_ALLOWED",
        )
    if incident.status is status:
        raise ConflictError(
            f"Инцидент уже находится в статусе «{status.value}»",
            {"status": status.value},
            code="INCIDENT_STATUS_UNCHANGED",
        )

    now = utcnow()
    old_status = incident.status
    incident.status = status
    incident.reject_reason = reject_reason
    # resolved_at отражает именно устранение. Отклонённый инцидент тоже
    # закрыт, но устранённым не считается — иначе статистика «сколько
    # нарушений исправлено» включала бы ошибки распознавания.
    incident.resolved_at = now if status is IncidentStatus.RESOLVED else None

    db.add(
        IncidentEvent(
            incident_id=incident.id,
            event_type=(
                IncidentEventType.REJECTED
                if status is IncidentStatus.FALSE_POSITIVE
                else IncidentEventType.STATUS_CHANGED
            ),
            old_status=old_status,
            new_status=status,
            user_id=actor.id if actor else None,
            comment=comment,
        )
    )
    db.commit()
    return _reload(db, incident_id)


def add_comment(
    db: Session,
    incident_id: uuid.UUID,
    *,
    text: str,
    actor_user_id: uuid.UUID | None = None,
) -> Incident:
    incident = get_incident(db, incident_id)
    actor = _require_user(db, actor_user_id)
    db.add(
        IncidentEvent(
            incident_id=incident.id,
            event_type=IncidentEventType.COMMENTED,
            user_id=actor.id if actor else None,
            comment=text,
        )
    )
    db.commit()
    return _reload(db, incident_id)
