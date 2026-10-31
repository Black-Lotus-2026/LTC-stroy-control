"""Pydantic schemas for authentication and registration."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from app.models.enums import UserRole


class UserRegisterRequest(BaseModel):
    """Registration request: username + password + confirm_password + role."""

    username: str = Field(
        ...,
        min_length=3,
        max_length=50,
        description="Придуманный логин пользователя (не обязательно email)",
    )
    password: str = Field(
        ...,
        min_length=4,
        max_length=128,
        description="Придуманный пароль",
    )
    confirm_password: str = Field(
        ...,
        min_length=4,
        max_length=128,
        description="Повтор пароля",
    )
    role: UserRole = Field(
        default=UserRole.VIEWER,
        description="Роль пользователя в системе (admin, manager, inspector, viewer)",
    )

    @field_validator("username")
    @classmethod
    def validate_username(cls, v: str) -> str:
        cleaned = v.strip()
        if len(cleaned) < 3:
            raise ValueError("Логин должен содержать не менее 3 символов")
        return cleaned

    @field_validator("confirm_password")
    @classmethod
    def passwords_match(cls, v: str, info) -> str:
        if "password" in info.data and v != info.data["password"]:
            raise ValueError("Пароли не совпадают")
        return v


class UserLoginRequest(BaseModel):
    """Login request: username + password."""

    username: str = Field(..., description="Логин")
    password: str = Field(..., description="Пароль")


class UserResponse(BaseModel):
    """Public user profile information."""

    id: uuid.UUID
    username: str
    name: str
    role: str
    email: str | None = None
    created_at: datetime


class UserEmailUpdate(BaseModel):
    email: str | None = Field(None, max_length=256)

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        clean = value.strip().lower()
        if (
            "@" not in clean
            or " " in clean
            or clean.startswith("@")
            or clean.endswith("@")
        ):
            raise ValueError("Введите корректный email")
        return clean


class AdminRecipient(BaseModel):
    id: uuid.UUID
    username: str
    name: str


class TokenResponse(BaseModel):
    """JWT Token with user profile."""

    access_token: str
    token_type: str = "bearer"
    user: UserResponse
