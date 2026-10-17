"""Семидневный прогноз сохраняется и переживает сбой провайдера."""

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.api.v1.weather import get_weather, refresh_weather
from app.api.v1.projects import update_project
from app.db.base import Base
from app.models.enums import UserRole
from app.models.geocoding import GeocodingThrottle
from app.models.project import Project
from app.models.user import User
from app.models.weather import WeatherForecast
from app.schemas.stroy_control import ProjectUpdate
from app.services.geocoding import LocationNotFound, geocode_address
from app.services.weather_service import (
    WeatherProviderError,
    describe_weather,
    run_weather_refresh,
    save_forecast,
    weather_warnings,
)


@compiles(JSONB, "sqlite")
def compile_jsonb_sqlite(type_, compiler, **kw):
    return "JSON"


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()


def client_for(*, incomplete=False, rain=25):
    today = datetime.now(ZoneInfo("Europe/Moscow")).date()

    def reply(request):
        assert request.url.params["forecast_days"] == "7"
        assert request.url.params["timezone"] == "Europe/Moscow"
        assert request.url.params["latitude"] == "55.75"
        count = 6 if incomplete else 7
        return httpx.Response(200, json={"daily": {
            "time": [(today + timedelta(days=n)).isoformat() for n in range(count)],
            "weather_code": [95, 3, 45, 0, 71, 0, 0][:count],
            "temperature_2m_min": [2, 4, 5, 6, -2, 7, 8][:count],
            "temperature_2m_max": [10] * count,
            "precipitation_sum": [rain] + [0] * (count - 1),
            "snowfall_sum": [0, 0, 0, 0, 6, 0, 0][:count],
            "wind_gusts_10m_max": [55] + [10] * (count - 1),
        }})

    return httpx.Client(transport=httpx.MockTransport(reply))


def setup(db):
    owner = User(username="weather-owner", name="Владелец", role=UserRole.MANAGER)
    outsider = User(username="weather-outsider", name="Другой", role=UserRole.MANAGER)
    project = Project(
        code="PRJ-WEATHER", name="Объект", owner_username=owner.username,
        address="Москва, Красная площадь, 1", geocoded_address="Москва, Красная площадь, 1",
        weather_location_name="Красная площадь, Москва", latitude=55.75, longitude=37.61,
    )
    db.add_all([owner, outsider, project])
    db.commit()
    return project, owner, outsider


def test_forecast_persists_seven_days_and_updates_existing_rows(db):
    project, owner, outsider = setup(db)
    with client_for() as client:
        save_forecast(db, project, client=client)
    db.commit()
    result = get_weather(project.id, db, owner)
    assert len(result.days) == 7
    assert result.days[0].warnings == ["Гроза", "Сильные осадки", "Сильный ветер"]
    assert result.days[2].warnings == ["Туман"]
    assert result.days[4].warnings == ["Сильный снегопад", "Заморозки"]
    assert result.days[0].conditions == ["Гроза"]
    assert result.days[0].provider == "open-meteo"
    assert result.resolved_address == "Красная площадь, Москва"
    first_id = db.scalar(select(WeatherForecast).order_by(WeatherForecast.forecast_date)).id

    with client_for(rain=0) as client:
        save_forecast(db, project, client=client)
    db.commit()
    assert db.scalar(select(WeatherForecast).order_by(WeatherForecast.forecast_date)).id == first_id
    assert len(db.scalars(select(WeatherForecast)).all()) == 7
    assert get_weather(project.id, db, owner).days[0].warnings == ["Гроза", "Сильный ветер"]
    with pytest.raises(HTTPException) as denied:
        get_weather(project.id, db, outsider)
    assert denied.value.status_code == 404


def test_incomplete_forecast_preserves_saved_data(db):
    project, owner, _ = setup(db)
    with client_for() as client:
        save_forecast(db, project, client=client)
    db.commit()
    with client_for(incomplete=True) as client, pytest.raises(WeatherProviderError):
        save_forecast(db, project, client=client)
    assert len(get_weather(project.id, db, owner).days) == 7


def test_forecast_for_unresolved_address_is_not_shown(db):
    project, owner, _ = setup(db)
    with client_for() as client:
        save_forecast(db, project, client=client)
    db.commit()
    project.geocoded_address = None
    db.commit()
    result = get_weather(project.id, db, owner)
    assert result.location_configured is True
    assert result.resolved_address is None
    assert result.days == []


def test_scheduled_refresh_skips_unconfigured_projects(db):
    project, _, _ = setup(db)
    db.add(Project(code="PRJ-NO-LOCATION", name="Без координат"))
    db.commit()
    with client_for() as client:
        assert run_weather_refresh(db, client=client) == {"updated": 1, "skipped": 1, "failed": 0}
    db.commit()
    assert db.scalar(select(WeatherForecast).where(WeatherForecast.project_id == project.id))


def test_changing_address_removes_forecast_and_cached_location(db):
    project, owner, _ = setup(db)
    with client_for() as client:
        save_forecast(db, project, client=client)
    db.commit()

    updated = update_project(project.id, ProjectUpdate(address="Москва, Тверская улица, 1"), db)
    assert updated.address == "Москва, Тверская улица, 1"
    assert project.latitude is None
    assert project.geocoded_address is None
    assert get_weather(project.id, db, owner).days == []
    assert db.scalars(select(WeatherForecast)).all() == []


def test_heavy_thunderstorm_wmo_code_is_warning():
    assert describe_weather(97) == ["Гроза"]
    assert weather_warnings(97, None, None, None, None) == ["Гроза"]


def test_address_is_geocoded_once_and_cached(db):
    project, owner, _ = setup(db)
    project.latitude = None
    project.longitude = None
    project.geocoded_address = None
    project.weather_location_name = None
    db.commit()
    calls = []
    forecast_client = client_for()

    def reply(request):
        calls.append(request.url.host)
        if request.url.host == "nominatim.openstreetmap.org":
            assert request.url.params["q"] == project.address
            assert "LTC-stroy-control" in request.headers["user-agent"]
            return httpx.Response(200, json=[{
                "lat": "55.75", "lon": "37.61", "display_name": "Красная площадь, Москва",
            }])
        return forecast_client.get(str(request.url))

    with httpx.Client(transport=httpx.MockTransport(reply)) as client:
        assert run_weather_refresh(db, client=client) == {"updated": 1, "skipped": 0, "failed": 0}
        save_forecast(db, project, client=client)
        db.commit()
    forecast_client.close()
    assert calls.count("nominatim.openstreetmap.org") == 1
    assert calls.count("api.open-meteo.com") == 2
    assert get_weather(project.id, db, owner).resolved_address == "Красная площадь, Москва"


def test_missing_address_is_reported_before_provider_call(db):
    project, owner, _ = setup(db)
    project.address = None
    db.commit()
    with pytest.raises(HTTPException) as error:
        refresh_weather(project.id, db, owner)
    assert error.value.status_code == 422


def test_geocoding_requests_obey_shared_rate_limit(db, monkeypatch):
    from datetime import UTC

    db.add(GeocodingThrottle(id=1, last_requested_at=datetime.now(UTC)))
    db.commit()
    pauses = []
    monkeypatch.setattr("app.services.geocoding.time.sleep", pauses.append)
    with httpx.Client(transport=httpx.MockTransport(
        lambda request: httpx.Response(200, json=[])
    )) as client, pytest.raises(LocationNotFound):
        geocode_address(db, "Неизвестная улица", client=client)
    db.commit()
    assert len(pauses) == 1
    assert 14 <= pauses[0] <= 15
    assert db.get(GeocodingThrottle, 1).last_requested_at is not None
