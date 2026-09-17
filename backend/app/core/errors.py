"""Ошибки приложения и их преобразование в HTTP-ответы.

Любая ожидаемая ошибка бросается как `AppError` с машинным кодом; формат
ответа один на всё API (см. `app.schemas.common.ErrorResponse`), поэтому
фронтенду не приходится разбирать разные формы ошибок.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


class AppError(Exception):
    """Базовая ошибка домена."""

    status_code: int = status.HTTP_400_BAD_REQUEST
    code: str = "APP_ERROR"

    def __init__(self, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details or {}


class NotFoundError(AppError):
    status_code = status.HTTP_404_NOT_FOUND
    code = "NOT_FOUND"


class ConflictError(AppError):
    status_code = status.HTTP_409_CONFLICT
    code = "CONFLICT"


class ValidationError(AppError):
    status_code = status.HTTP_422_UNPROCESSABLE_CONTENT
    code = "VALIDATION_ERROR"


def _error_body(code: str, message: str, details: dict[str, Any]) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "details": details}}


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def handle_app_error(_: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=_error_body(exc.code, exc.message, exc.details),
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(
        _: Request, exc: RequestValidationError
    ) -> JSONResponse:
        # Ошибки валидации Pydantic приводим к тому же формату, что и остальные.
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            content=_error_body(
                "VALIDATION_ERROR",
                "Некорректные параметры запроса",
                # jsonable_encoder нужен: в ctx ошибок Pydantic попадают объекты
                # исключений, которые JSONResponse сам сериализовать не умеет.
                {"errors": jsonable_encoder(exc.errors())},
            ),
        )
