"""Сохранённый прогноз объекта и ручное обновление."""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession
from app.models.enums import UserRole
from app.models.project import Project
from app.models.weather import WeatherForecast
from app.services.geocoding import GeocodingUnavailable, LocationNotFound
from app.services.weather_service import WeatherProviderError, save_forecast

router = APIRouter(prefix="/projects/{project_id}/weather", tags=["Прогноз погоды"])


class WeatherDay(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    forecast_date: date
    fetched_at: datetime
    provider: str
    weather_code: int | None
    temperature_min_c: float | None
    temperature_max_c: float | None
    precipitation_mm: float | None
    snowfall_cm: float | None
    wind_gust_kmh: float | None
    conditions: list[str]
    warnings: list[str]


class WeatherResponse(BaseModel):
    project_id: uuid.UUID
    timezone: str
    location_configured: bool
    resolved_address: str | None
    days: list[WeatherDay]


def require_project(db: DbSession, project_id: uuid.UUID, current_user: CurrentUser) -> Project:
    project = db.get(Project, project_id)
    if not project or (
        current_user.role != UserRole.ADMIN
        and project.owner_username != current_user.username
    ):
        raise HTTPException(404, "Объект не найден")
    return project


def response_for(db: DbSession, project: Project) -> WeatherResponse:
    today = datetime.now(ZoneInfo(project.timezone)).date()
    address_resolved = bool(project.address and project.geocoded_address == project.address.strip())
    rows = (
        db.scalars(
            select(WeatherForecast)
            .where(
                WeatherForecast.project_id == project.id,
                WeatherForecast.forecast_date >= today,
                WeatherForecast.forecast_date < today + timedelta(days=7),
            )
            .order_by(WeatherForecast.forecast_date)
        ).all()
        if address_resolved else []
    )
    return WeatherResponse(
        project_id=project.id,
        timezone=project.timezone,
        location_configured=bool(project.address and project.address.strip()),
        resolved_address=(
            project.weather_location_name
            if address_resolved else None
        ),
        days=[WeatherDay.model_validate(row) for row in rows],
    )


@router.get("", response_model=WeatherResponse)
def get_weather(project_id: uuid.UUID, db: DbSession, current_user: CurrentUser) -> WeatherResponse:
    return response_for(db, require_project(db, project_id, current_user))


@router.post("/refresh", response_model=WeatherResponse)
def refresh_weather(project_id: uuid.UUID, db: DbSession, current_user: CurrentUser) -> WeatherResponse:
    project = require_project(db, project_id, current_user)
    if not project.address or not project.address.strip():
        raise HTTPException(422, "Для прогноза укажите адрес объекта")
    try:
        save_forecast(db, project)
        db.commit()
    except WeatherProviderError as exc:
        db.commit()  # Найденный адрес остаётся в кеше и при сбое прогноза.
        raise HTTPException(502, str(exc)) from exc
    except LocationNotFound as exc:
        db.commit()  # Сохраняем метку запроса для ограничения частоты.
        raise HTTPException(422, str(exc)) from exc
    except GeocodingUnavailable as exc:
        db.commit()
        raise HTTPException(502, str(exc)) from exc
    except ValueError as exc:
        db.rollback()
        raise HTTPException(409, str(exc)) from exc
    return response_for(db, project)
