"""Однократное определение координат по адресу объекта через Nominatim."""

from __future__ import annotations

import math
import time
from datetime import UTC, datetime

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.geocoding import GeocodingThrottle

GEOCODING_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "LTC-stroy-control/1.0 (+https://github.com/Black-Lotus-2026/LTC-stroy-control)"
GEOCODING_INTERVAL_SECONDS = 15  # Плановые запросы: не чаще 4 в минуту.


class LocationNotFound(Exception):
    """Адрес не удалось сопоставить с местом."""


class GeocodingUnavailable(Exception):
    """Сервис поиска адреса недоступен или ответ некорректен."""


def geocode_address(
    db: Session, address: str, *, client: httpx.Client | None = None,
) -> tuple[float, float, str]:
    """Общий DB lock ограничивает все процессы четырьмя запросами в минуту."""
    throttle = db.scalar(select(GeocodingThrottle).where(GeocodingThrottle.id == 1).with_for_update())
    if throttle is None:
        # Строка создаётся миграцией; эта ветка нужна для create_all в тестах.
        throttle = GeocodingThrottle(id=1)
        db.add(throttle)
        db.flush()
    now = datetime.now(UTC)
    if throttle.last_requested_at is not None:
        previous = throttle.last_requested_at
        if previous.tzinfo is None:
            previous = previous.replace(tzinfo=UTC)
        wait_seconds = GEOCODING_INTERVAL_SECONDS - (now - previous).total_seconds()
        if wait_seconds > 0:
            time.sleep(wait_seconds)
    throttle.last_requested_at = datetime.now(UTC)
    db.flush()

    params = {"q": address, "format": "jsonv2", "limit": 1, "accept-language": "ru"}
    try:
        if client is None:
            with httpx.Client(timeout=10) as own_client:
                response = own_client.get(GEOCODING_URL, params=params, headers={"User-Agent": USER_AGENT})
        else:
            response = client.get(GEOCODING_URL, params=params, headers={"User-Agent": USER_AGENT})
        response.raise_for_status()
        results = response.json()
        if not isinstance(results, list):
            raise ValueError("Некорректный ответ сервиса")
        if not results:
            raise LocationNotFound("Адрес не найден. Уточните населённый пункт, улицу и номер дома")
        latitude = float(results[0]["lat"])
        longitude = float(results[0]["lon"])
        name = str(results[0]["display_name"])
        if not (math.isfinite(latitude) and -90 <= latitude <= 90
                and math.isfinite(longitude) and -180 <= longitude <= 180 and name):
            raise ValueError("Некорректные координаты")
        return latitude, longitude, name
    except LocationNotFound:
        raise
    except (httpx.HTTPError, KeyError, TypeError, ValueError) as exc:
        raise GeocodingUnavailable("Не удалось определить местоположение по адресу") from exc
