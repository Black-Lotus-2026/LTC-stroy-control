"""Authentication endpoints: registration, login, and current user profile."""

from __future__ import annotations

import logging
from fastapi import APIRouter, HTTPException, status
from sqlalchemy import func, select

from app.api.deps import CurrentUser, DbSession
from app.core.security import create_access_token, hash_password, verify_password
from app.models.enums import UserRole
from app.models.user import User
from app.schemas.auth import TokenResponse, UserLoginRequest, UserRegisterRequest, UserResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["Аутентификация и пользователи"])


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
def register_user(data: UserRegisterRequest, db: DbSession) -> TokenResponse:
    """Регистрация нового пользователя по логину и паролю.
    
    Логин может быть любой строкой (не обязательно email).
    Пароль задается дважды при регистрации.
    """
    clean_username = data.username.strip()

    # Проверка уникальности логина (без учета регистра)
    existing = db.scalars(
        select(User).where(func.lower(User.username) == clean_username.lower())
    ).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Пользователь с логином «{clean_username}» уже существует",
        )

    # Проверяем, есть ли уже пользователи: если это первый пользователь, делаем его администратором
    user_count = db.scalar(select(func.count(User.id))) or 0
    role = UserRole.ADMIN if user_count == 0 else UserRole.MANAGER

    new_user = User(
        username=clean_username,
        name=clean_username,
        hashed_password=hash_password(data.password),
        role=role,
        is_active=True,
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    logger.info("Зарегистрирован новый пользователь: %s (роль: %s)", new_user.username, new_user.role)

    # Генерируем JWT токен
    token = create_access_token(data={"sub": new_user.username, "uid": str(new_user.id), "role": str(new_user.role.value)})

    return TokenResponse(
        access_token=token,
        token_type="bearer",
        user=UserResponse(
            id=new_user.id,
            username=new_user.username,
            name=new_user.name,
            role=str(new_user.role.value) if hasattr(new_user.role, "value") else str(new_user.role),
            created_at=new_user.created_at,
        ),
    )


@router.post("/login", response_model=TokenResponse)
def login_user(data: UserLoginRequest, db: DbSession) -> TokenResponse:
    """Авторизация пользователя по логину и паролю с возвратом JWT-токена."""
    clean_username = data.username.strip()

    user = db.scalars(
        select(User).where(func.lower(User.username) == clean_username.lower())
    ).first()

    if not user or not verify_password(data.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Неверный логин или пароль",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Учетная запись отключена",
        )

    token = create_access_token(data={"sub": user.username, "uid": str(user.id), "role": str(user.role.value)})

    return TokenResponse(
        access_token=token,
        token_type="bearer",
        user=UserResponse(
            id=user.id,
            username=user.username or user.name,
            name=user.name,
            role=str(user.role.value) if hasattr(user.role, "value") else str(user.role),
            created_at=user.created_at,
        ),
    )


@router.get("/me", response_model=UserResponse)
def get_current_user_profile(current_user: CurrentUser) -> UserResponse:
    """Получение профиля текущего авторизованного пользователя."""
    return UserResponse(
        id=current_user.id,
        username=current_user.username or current_user.name,
        name=current_user.name,
        role=str(current_user.role.value) if hasattr(current_user.role, "value") else str(current_user.role),
        created_at=current_user.created_at,
    )
