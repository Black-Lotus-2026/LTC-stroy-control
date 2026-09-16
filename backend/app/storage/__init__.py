"""Выбор реализации хранилища по настройкам."""

from functools import lru_cache

from app.core.config import settings
from app.storage.base import Storage
from app.storage.local import LocalStorage

__all__ = ["Storage", "LocalStorage", "get_storage"]


@lru_cache
def get_storage() -> Storage:
    if settings.storage_backend == "local":
        return LocalStorage()
    raise ValueError(f"Неизвестный backend хранилища: {settings.storage_backend}")
