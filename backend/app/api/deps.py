"""Общие зависимости HTTP-слоя.

Псевдонимы через Annotated вместо `Depends(...)` в значениях по умолчанию:
так тип аргумента остаётся честным, а обработчик читается как обычная функция.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import decode_access_token
from app.db.session import get_db
from app.models.user import User

DbSession = Annotated[Session, Depends(get_db)]

security_scheme = HTTPBearer(auto_error=False)


def get_current_user_optional(
    auth: Annotated[HTTPAuthorizationCredentials | None, Depends(security_scheme)],
    db: DbSession,
) -> User | None:
    """Extract and verify user from JWT Bearer token if present."""
    if not auth or not auth.credentials:
        return None
    payload = decode_access_token(auth.credentials)
    if not payload or "sub" not in payload:
        return None
    user = db.scalars(select(User).where(User.username == payload["sub"])).first()
    return user


def get_current_user(
    auth: Annotated[HTTPAuthorizationCredentials | None, Depends(security_scheme)],
    db: DbSession,
) -> User:
    """Require valid authenticated user."""
    user = get_current_user_optional(auth, db)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Необходима авторизация",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]
OptionalUser = Annotated[User | None, Depends(get_current_user_optional)]

