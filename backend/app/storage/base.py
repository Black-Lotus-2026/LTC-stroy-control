"""Интерфейс хранилища кадров.

Кадры не хранятся в базе — в БД лежит только метаданные и `storage_key`.
Конкретная реализация подменяется целиком (локальный диск сейчас, S3/MinIO
позже) без изменений в коде, который этим хранилищем пользуется.
"""

from __future__ import annotations

from abc import ABC, abstractmethod


class Storage(ABC):
    """Минимальный набор операций, нужный пайплайну обработки кадров."""

    @abstractmethod
    def save(self, key: str, data: bytes, content_type: str = "image/jpeg") -> str:
        """Сохранить объект и вернуть его ключ."""

    @abstractmethod
    def load(self, key: str) -> bytes:
        """Прочитать объект по ключу."""

    @abstractmethod
    def exists(self, key: str) -> bool:
        """Проверить наличие объекта."""

    @abstractmethod
    def delete(self, key: str) -> None:
        """Удалить объект. Отсутствие объекта не считается ошибкой."""

    @abstractmethod
    def public_url(self, key: str) -> str:
        """URL, по которому объект доступен фронтенду."""
