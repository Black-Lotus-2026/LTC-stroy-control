"""Camera settings CRUD tests."""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session, sessionmaker

from app.api.v1.projects import delete_camera, update_camera
from app.db.base import Base
from app.models.project import Camera, Project, Zone
from app.schemas.stroy_control import CameraUpdate


@compiles(JSONB, "sqlite")
def compile_jsonb_sqlite(type_, compiler, **kw):
    return "JSON"


@pytest.fixture
def sqlite_session() -> Session:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()


def test_update_camera_and_remove_zone(sqlite_session: Session) -> None:
    project = Project(code="PRJ-CAM", name="Объект")
    sqlite_session.add(project)
    sqlite_session.flush()
    zone = Zone(project_id=project.id, code="ZN-1", name="Котлован")
    sqlite_session.add(zone)
    sqlite_session.flush()
    camera = Camera(
        project_id=project.id,
        zone_id=zone.id,
        code="CAM-01",
        name="Старая камера",
        stream_url="http://old/video",
    )
    sqlite_session.add(camera)
    sqlite_session.commit()

    result = update_camera(
        project.id,
        camera.id,
        CameraUpdate(
            name="Камера котлована",
            stream_url="https://192.168.1.106:8080/video",
            zone_id=None,
        ),
        sqlite_session,
    )

    assert result.name == "Камера котлована"
    assert result.stream_url == "https://192.168.1.106:8080/video"
    assert result.zone_id is None


def test_camera_cannot_be_changed_or_deleted_through_another_project(
    sqlite_session: Session,
) -> None:
    owner = Project(code="PRJ-OWNER", name="Владелец")
    other = Project(code="PRJ-OTHER", name="Другой объект")
    sqlite_session.add_all([owner, other])
    sqlite_session.flush()
    camera = Camera(project_id=owner.id, code="CAM-02", name="Камера")
    sqlite_session.add(camera)
    sqlite_session.commit()

    with pytest.raises(HTTPException) as update_error:
        update_camera(
            other.id,
            camera.id,
            CameraUpdate(name="Чужое изменение"),
            sqlite_session,
        )
    assert update_error.value.status_code == 404

    with pytest.raises(HTTPException) as delete_error:
        delete_camera(other.id, camera.id, sqlite_session)
    assert delete_error.value.status_code == 404
    assert sqlite_session.get(Camera, camera.id) is not None


def test_delete_camera(sqlite_session: Session) -> None:
    project = Project(code="PRJ-DELETE", name="Объект")
    sqlite_session.add(project)
    sqlite_session.flush()
    camera = Camera(project_id=project.id, code="CAM-03", name="Удаляемая")
    sqlite_session.add(camera)
    sqlite_session.commit()
    camera_id = camera.id

    delete_camera(project.id, camera_id, sqlite_session)

    assert sqlite_session.get(Camera, camera_id) is None
