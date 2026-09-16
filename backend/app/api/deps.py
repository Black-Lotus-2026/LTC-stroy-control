"""Общие зависимости HTTP-слоя.

Псевдонимы через Annotated вместо `Depends(...)` в значениях по умолчанию:
так тип аргумента остаётся честным, а обработчик читается как обычная функция.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends
from sqlalchemy.orm import Session

from app.db.session import get_db

DbSession = Annotated[Session, Depends(get_db)]
