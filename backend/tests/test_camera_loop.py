"""A camera feeding a recording in a loop: one event per camera, closed only by an administrator."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.api.v1.incidents import create_incident, update_incident_status
from app.db.base import Base
from app.models.alert import AlertNotification
from app.models.enums import IncidentCategory, IncidentStatus, IncidentType, UserRole
from app.models.incident import Incident, IncidentEvent
from app.models.project import Camera, Project
from app.models.user import User
from app.schemas.stroy_control import IncidentCreateRequest, IncidentStatusUpdateRequest
from app.services.alert_service import run_due_verifications, verify_incident


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


def setup(db: Session) -> tuple[Project, Camera, Camera, User, User]:
    owner = User(username="foreman", name="Прораб", role=UserRole.MANAGER)
    chief = User(username="chief", name="Иванов", role=UserRole.ADMIN)
    db.add_all([owner, chief])
    db.flush()
    project = Project(code="PRJ-LOOP", name="Объект", owner_username=owner.username, escalation_user_id=chief.id)
    db.add(project)
    db.flush()
    a = Camera(project_id=project.id, code="CAM-L1", name="Камера 1", stream_url="http://cam/1")
    b = Camera(project_id=project.id, code="CAM-L2", name="Камера 2", stream_url="http://cam/2")
    db.add_all([a, b])
    db.commit()
    return project, a, b, owner, chief


def loop_event(db: Session, project: Project, camera: Camera | None, user: User) -> Incident:
    res = create_incident(
        IncidentCreateRequest(
            project_id=project.id, camera_id=camera.id if camera else None, camera_name=camera.name if camera else None,
            discrepancy_type="STREAM_LOOP", severity="ERROR",
            title="Видео повторяется", description="Наблюдение: период 40 с",
        ),
        db, user,
    )
    return db.get(Incident, res.id)


def test_loop_event_belongs_to_its_camera(db: Session) -> None:
    project, a, b, owner, _ = setup(db)
    with pytest.raises(HTTPException) as no_camera:
        loop_event(db, project, None, owner)
    assert no_camera.value.status_code == 422

    first = loop_event(db, project, a, owner)
    again = loop_event(db, project, a, owner)
    other = loop_event(db, project, b, owner)
    assert first.id == again.id and first.id != other.id
    assert first.category == IncidentCategory.CAMERA and first.type == IncidentType.CAMERA_VISIBILITY
    assert first.assigned_user_id == owner.id


def test_server_never_closes_a_loop_by_itself_and_escalates_it(db: Session) -> None:
    project, a, _, owner, chief = setup(db)
    project.alert_error_deadline_minutes = 1
    db.commit()
    incident = loop_event(db, project, a, owner)
    assert verify_incident(db, incident).outcome == "unavailable"

    result = run_due_verifications(db, now=datetime.now(UTC) + timedelta(minutes=5))
    db.commit()
    assert result == {"checked": 1, "resolved": 0, "escalated": 1}
    assert incident.status == IncidentStatus.PENDING
    assert ("escalated", chief.id) in {(n.kind, n.recipient_user_id) for n in db.scalars(select(AlertNotification))}


def test_only_admin_confirms_the_video_is_live(db: Session) -> None:
    project, a, _, owner, chief = setup(db)
    incident = loop_event(db, project, a, owner)
    with pytest.raises(HTTPException) as denied:
        update_incident_status(incident.id, IncidentStatusUpdateRequest(status="resolved"), db, owner)
    assert denied.value.status_code == 403
    assert incident.status == IncidentStatus.PENDING

    update_incident_status(incident.id, IncidentStatusUpdateRequest(status="resolved"), db, chief)
    assert incident.status == IncidentStatus.RESOLVED
    assert incident.verification_details["resolution"] == "admin_confirmed_live"
    comments = [e.comment for e in db.scalars(select(IncidentEvent).where(IncidentEvent.incident_id == incident.id))]
    assert any("вживую" in (c or "") for c in comments)
