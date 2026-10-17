"""Получение и сохранение прогноза Open-Meteo на семь местных календарных дней."""

from __future__ import annotations

import logging
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.project import Project
from app.models.weather import WeatherForecast

logger = logging.getLogger(__name__)
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
DAILY_FIELDS = (
    "weather_code,temperature_2m_max,temperature_2m_min,"
    "precipitation_sum,snowfall_sum,wind_gusts_10m_max"
)


class WeatherProviderError(Exception):
    """Провайдер недоступен или вернул неполный прогноз."""


def describe_weather(code: int | None) -> list[str]:
    if code is None:
        return []
    if code == 0:
        return ["Ясно"]
    if code in (1, 2, 3):
        return ["Облачно"]
    if code in (45, 48):
        return ["Туман"]
    if code in (51, 53, 55, 56, 57):
        return ["Морось"]
    if code in (61, 63, 65, 66, 67, 80, 81, 82):
        return ["Дождь"]
    if code in (71, 73, 75, 77, 85, 86):
        return ["Снег"]
    if code in (95, 96, 97, 99):
        return ["Гроза"]
    return [f"Погодный код WMO {code}"]


def weather_warnings(
    code: int | None, temperature_min_c: float | None,
    precipitation_mm: float | None, snowfall_cm: float | None,
    wind_gust_kmh: float | None,
) -> list[str]:
    warnings = []
    if code in (95, 96, 97, 99):
        warnings.append("Гроза")
    if code in (45, 48):
        warnings.append("Туман")
    if precipitation_mm is not None and precipitation_mm >= 20:
        warnings.append("Сильные осадки")
    if snowfall_cm is not None and snowfall_cm >= 5:
        warnings.append("Сильный снегопад")
    if wind_gust_kmh is not None and wind_gust_kmh >= 54:
        warnings.append("Сильный ветер")
    if temperature_min_c is not None and temperature_min_c <= 0:
        warnings.append("Заморозки")
    return warnings


def fetch_forecast(project: Project, *, client: httpx.Client | None = None) -> list[dict]:
    if project.latitude is None or project.longitude is None:
        raise ValueError("Для прогноза задайте широту и долготу объекта")
    params = {
        "latitude": project.latitude,
        "longitude": project.longitude,
        "daily": DAILY_FIELDS,
        "forecast_days": 7,
        "timezone": project.timezone,
    }
    try:
        if client is None:
            with httpx.Client(timeout=10) as own_client:
                response = own_client.get(FORECAST_URL, params=params)
        else:
            response = client.get(FORECAST_URL, params=params)
        response.raise_for_status()
        daily = response.json()["daily"]
        field_names = (
            "time", "weather_code", "temperature_2m_max", "temperature_2m_min",
            "precipitation_sum", "snowfall_sum", "wind_gusts_10m_max",
        )
        if any(not isinstance(daily.get(name), list) or len(daily[name]) != 7 for name in field_names):
            raise ValueError("Неполный семидневный прогноз")
        today = datetime.now(ZoneInfo(project.timezone)).date()
        dates = [date.fromisoformat(value) for value in daily["time"]]
        if dates != [today + timedelta(days=offset) for offset in range(7)]:
            raise ValueError("Даты прогноза не соответствуют ближайшим семи дням")
        result = []
        for index, forecast_date in enumerate(dates):
            code = daily["weather_code"][index]
            minimum = daily["temperature_2m_min"][index]
            maximum = daily["temperature_2m_max"][index]
            precipitation = daily["precipitation_sum"][index]
            snow = daily["snowfall_sum"][index]
            gust = daily["wind_gusts_10m_max"][index]
            result.append({
                "forecast_date": forecast_date,
                "weather_code": code,
                "temperature_min_c": minimum,
                "temperature_max_c": maximum,
                "precipitation_mm": precipitation,
                "snowfall_cm": snow,
                "wind_gust_kmh": gust,
                "conditions": describe_weather(code),
                "warnings": weather_warnings(code, minimum, precipitation, snow, gust),
            })
        return result
    except (httpx.HTTPError, KeyError, TypeError, ValueError) as exc:
        raise WeatherProviderError("Не удалось получить полный прогноз погоды") from exc


def save_forecast(db: Session, project: Project, *, client: httpx.Client | None = None) -> list[WeatherForecast]:
    location = (project.latitude, project.longitude, project.timezone)
    days = fetch_forecast(project, client=client)
    # Сериализуем ручное и плановое обновления одного объекта до поиска строк.
    db.refresh(project, with_for_update=True)
    if location != (project.latitude, project.longitude, project.timezone):
        raise ValueError("Координаты объекта изменились во время запроса прогноза")
    fetched_at = datetime.now(UTC)
    existing = {
        row.forecast_date: row
        for row in db.scalars(
            select(WeatherForecast).where(WeatherForecast.project_id == project.id)
        )
    }
    saved = []
    for day in days:
        row = existing.get(day["forecast_date"])
        if row is None:
            row = WeatherForecast(project_id=project.id)
            db.add(row)
        for key, value in day.items():
            setattr(row, key, value)
        row.fetched_at = fetched_at
        row.provider = "open-meteo"
        saved.append(row)
    db.flush()
    return saved


def run_weather_refresh(db: Session, *, client: httpx.Client | None = None) -> dict[str, int]:
    counts = {"updated": 0, "skipped": 0, "failed": 0}
    projects = db.scalars(select(Project).where(Project.status == "active")).all()
    for project in projects:
        if project.latitude is None or project.longitude is None:
            counts["skipped"] += 1
            continue
        try:
            with db.begin_nested():
                save_forecast(db, project, client=client)
            db.commit()
            counts["updated"] += 1
        except (WeatherProviderError, ValueError):
            counts["failed"] += 1
            logger.warning("Weather refresh failed for project %s", project.id, exc_info=True)
    return counts
