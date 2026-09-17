"""Контракт пользователя.

Аутентификации в прототипе нет — пользователи нужны как адресаты
назначений и как подписи в истории инцидента.
"""

from __future__ import annotations

import uuid

from pydantic import BaseModel, ConfigDict

from app.models.enums import UserRole


class UserBrief(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    role: UserRole


class UserRead(UserBrief):
    email: str | None
    position: str | None
    is_active: bool
