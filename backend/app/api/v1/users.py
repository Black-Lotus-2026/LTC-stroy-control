"""Пользователи.

Нужны интерфейсу для одного: выбрать ответственного за инцидент.
Аутентификации в прототипе нет — см. docs/decisions/0006-api-contract.md
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query
from sqlalchemy import select

from app.api.deps import DbSession, PageParams
from app.models.enums import UserRole
from app.models.user import User
from app.schemas.common import Page
from app.schemas.user import UserRead
from app.services.pagination import paginate

router = APIRouter(prefix="/users", tags=["Пользователи"])


@router.get("", response_model=Page[UserRead], summary="Список пользователей")
def list_users(
    db: DbSession,
    page: PageParams,
    role: Annotated[list[UserRole] | None, Query()] = None,
    is_active: Annotated[bool | None, Query()] = None,
) -> Page[UserRead]:
    stmt = select(User).order_by(User.name)
    if role:
        stmt = stmt.where(User.role.in_(list(role)))
    if is_active is not None:
        stmt = stmt.where(User.is_active.is_(is_active))
    items, total = paginate(db, stmt, page=page.page, page_size=page.page_size)
    return Page.of(
        [UserRead.model_validate(item) for item in items],
        total,
        page=page.page,
        page_size=page.page_size,
    )
