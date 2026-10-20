"""Общие зависимости HTTP-слоя.

Псевдонимы через Annotated вместо `Depends(...)` в значениях по умолчанию:
так тип аргумента остаётся честным, а обработчик читается как обычная функция.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import Depends, Header, HTTPException, status
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
    assignment_selector: Annotated[
        str | None, Header(alias="X-Project-Assignment")
    ] = None,
    membership_selector: Annotated[
        str | None, Header(alias="X-Organization-Membership")
    ] = None,
) -> User | None:
    """Extract and verify user from JWT Bearer token if present."""
    # Request context IDs are selectors, never grants. Resolve all grants from DB.
    for key, raw in (
        ("assignment_id", assignment_selector),
        ("membership_id", membership_selector),
    ):
        db.info.pop(key, None)
        if raw:
            try:
                db.info[key] = uuid.UUID(raw)
            except (ValueError, TypeError):
                raise HTTPException(422, "Некорректный контекст доступа") from None
    if not auth or not auth.credentials:
        return None
    payload = decode_access_token(auth.credentials)
    if (
        not payload
        or "sub" not in payload
        or payload.get("purpose", "access") != "access"
    ):
        return None
    user = db.scalars(select(User).where(User.username == payload["sub"])).first()
    return user if user and user.is_active else None


def get_current_user(
    auth: Annotated[HTTPAuthorizationCredentials | None, Depends(security_scheme)],
    db: DbSession,
    assignment_selector: Annotated[
        str | None, Header(alias="X-Project-Assignment")
    ] = None,
    membership_selector: Annotated[
        str | None, Header(alias="X-Organization-Membership")
    ] = None,
) -> User:
    """Require valid authenticated user."""
    user = get_current_user_optional(auth, db, assignment_selector, membership_selector)
    if not user or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Необходима авторизация",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]
OptionalUser = Annotated[User | None, Depends(get_current_user_optional)]
