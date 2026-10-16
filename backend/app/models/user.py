"""Пользователи системы.

Минимальная модель: ответственный за инцидент и роль. Аутентификация в
прототип не входит — пользователи нужны как адресаты назначений.
"""

from __future__ import annotations

from sqlalchemy import Boolean, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.db.types import enum_column
from app.models.enums import UserRole


class User(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "users"

    username: Mapped[str | None] = mapped_column(String(64), unique=True, index=True, default=None)
    hashed_password: Mapped[str | None] = mapped_column(String(256), default=None)
    name: Mapped[str] = mapped_column(String(128))
    email: Mapped[str | None] = mapped_column(String(256), unique=True, default=None)
    position: Mapped[str | None] = mapped_column(String(128), default=None)

    role: Mapped[UserRole] = mapped_column(enum_column(UserRole), default=UserRole.VIEWER)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")

    def __repr__(self) -> str:
        return f"<User {self.name}>"
