"""Pydantic schemas for authentication and registration."""

from __future__ import annotations

import uuid
from datetime import datetime
from pydantic import BaseModel, Field, field_validator


class UserRegisterRequest(BaseModel):
    """Registration request: username + password + confirm_password."""

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
    created_at: datetime


class TokenResponse(BaseModel):
    """JWT Token with user profile."""

    access_token: str
    token_type: str = "bearer"
    user: UserResponse
