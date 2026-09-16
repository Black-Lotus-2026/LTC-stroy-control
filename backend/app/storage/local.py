"""Хранилище на локальном диске.

Выбрано для прототипа: на один контейнер меньше, чем MinIO, а внешний
контракт (`Storage`) от этого не зависит. Файлы раздаёт сам API как
статику по префиксу /media.
"""

from __future__ import annotations

from pathlib import Path

from app.core.config import settings
from app.storage.base import Storage


class LocalStorage(Storage):
    def __init__(self, root: Path | None = None, public_url: str | None = None) -> None:
        self.root = Path(root or settings.storage_local_root).resolve()
        self.public_url_base = (public_url or settings.storage_public_url).rstrip("/")
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        # Защита от выхода за пределы корня хранилища через "../" в ключе.
        path = (self.root / key).resolve()
        if not path.is_relative_to(self.root):
            raise ValueError(f"Некорректный ключ хранилища: {key!r}")
        return path

    def save(self, key: str, data: bytes, content_type: str = "image/jpeg") -> str:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return key

    def load(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def exists(self, key: str) -> bool:
        return self._path(key).is_file()

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)

    def public_url(self, key: str) -> str:
        return f"{self.public_url_base}/{key.lstrip('/')}"
