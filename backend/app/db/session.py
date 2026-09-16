"""Подключение к БД и выдача сессий.

Используется синхронный SQLAlchemy: Celery-воркер синхронен по природе,
и один и тот же слой доступа к данным работает и в API, и в задачах.
Обоснование выбора — docs/decisions/0003-sync-sqlalchemy.md
"""

from __future__ import annotations

from collections.abc import Generator
from contextlib import contextmanager

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings

engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,  # молча переоткрывает соединение, оборванное простоем
    echo=False,
    future=True,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Generator[Session, None, None]:
    """Зависимость FastAPI: сессия на один HTTP-запрос."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def session_scope() -> Generator[Session, None, None]:
    """Сессия для кода вне HTTP-запроса (Celery-задачи, скрипты, сиды).

    Коммитит при успехе, откатывает при исключении.
    """
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
