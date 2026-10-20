"""Camera view: frame comparison, approval by an administrator, planned moves and rechecks."""

from __future__ import annotations

import base64
import io
import random
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from PIL import Image, ImageDraw, ImageEnhance
from sqlalchemy import create_engine, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

import app.api.v1.incidents as incidents_api
import app.services.camera_view as cv
from app.api.v1 import camera_views as views_api
from app.api.v1.incidents import create_incident, update_incident_status
from app.db.base import Base
from app.models.alert import AlertNotification
from app.models.camera_view import CameraViewEvent
from app.models.enums import IncidentStatus, UserRole
from app.models.incident import Incident
from app.models.project import Camera, Project
from app.models.user import User
from app.schemas.camera_view import ViewMoveRequest, ViewNote, ViewReferenceRequest
from app.schemas.stroy_control import IncidentCreateRequest, IncidentStatusUpdateRequest
from app.services.alert_service import run_due_verifications, verify_incident
from app.storage.local import LocalStorage


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


@pytest.fixture(autouse=True)
def storage(tmp_path, monkeypatch):
    local = LocalStorage(root=tmp_path, public_url="http://test/media")
    monkeypatch.setattr(cv, "get_storage", lambda: local)
    monkeypatch.setattr(incidents_api, "get_storage", lambda: local)
    return local


def scene(seed: int, width: int = 1280, height: int = 720) -> Image.Image:
    """A synthetic site: ground, buildings, a crane and machines as plain shapes."""
    rnd = random.Random(seed)
    im = Image.new("RGB", (width, height), (150, 160, 170))
    d = ImageDraw.Draw(im)
    d.rectangle([0, int(height * 0.6), width, height], fill=(110, 95, 80))
    for _ in range(40):
        x, y = rnd.randrange(width), rnd.randrange(height)
        w, h = rnd.randrange(30, 260), rnd.randrange(20, 200)
        c = tuple(rnd.randrange(20, 235) for _ in range(3))
        if rnd.random() < 0.6:
            d.rectangle([x, y, x + w, y + h], fill=c)
        else:
            d.line([x, y, x + w, y - h], fill=c, width=rnd.randrange(3, 12))
    return im


def jpeg(im: Image.Image) -> bytes:
    out = io.BytesIO()
    im.save(out, "JPEG", quality=85)
    return out.getvalue()


def f(im: Image.Image) -> cv.ViewFeatures:
    return cv.features_from_image(jpeg(im))


# --- comparison ---

def test_same_view_matches_despite_light_and_jpeg() -> None:
    ref = scene(1)
    darker = ImageEnhance.Contrast(ImageEnhance.Brightness(ref).enhance(0.55)).enhance(0.8)
    m = cv.compare(f(ref), f(darker))
    assert m.match >= cv.MATCH_OK
    assert (m.dx, m.dy) == (0, 0)


def test_turned_camera_is_found_with_its_direction() -> None:
    wide = scene(2, width=1600)
    ref = wide.crop((100, 0, 1380, 720))
    turned_right = wide.crop((220, 0, 1500, 720))  # the picture moves left
    m = cv.compare(f(ref), f(turned_right))
    assert m.match < cv.MATCH_BAD
    assert m.best >= cv.MATCH_OK
    assert m.dx < 0 and abs(m.dy) <= 1


def with_clock(im: Image.Image, text: str) -> Image.Image:
    """Cameras burn their name and a clock into a fixed corner of every frame."""
    im = im.copy()
    d = ImageDraw.Draw(im)
    d.rectangle([20, 20, 300, 56], fill=(0, 0, 0))
    d.text((30, 28), f"CAM-01 {text}", fill=(255, 255, 255))
    return im


def test_clock_overlay_does_not_hide_a_turn_and_a_truck_does_not_raise_one() -> None:
    wide = scene(6, width=1700)
    ref = with_clock(wide.crop((0, 0, 1280, 720)), "12:00:00")
    turned = with_clock(wide.crop((260, 0, 1540, 720)), "12:00:02")
    assert cv.compare(f(ref), f(turned)).match < cv.MATCH_BAD

    truck = with_clock(wide.crop((0, 0, 1280, 720)), "12:00:04")
    ImageDraw.Draw(truck).rectangle([0, 250, 450, 720], fill=(200, 30, 20))
    assert cv.compare(f(ref), f(truck)).match >= cv.MATCH_OK


def test_other_scene_or_covered_lens_do_not_match() -> None:
    ref = f(scene(3))
    assert cv.compare(ref, f(scene(4))).match < cv.MATCH_BAD
    covered = Image.new("RGB", (1280, 720), (12, 10, 9))
    assert cv.compare(ref, f(covered)).match < cv.MATCH_BAD


def test_snapshot_is_checked_and_reencoded() -> None:
    raw = "data:image/png;base64," + base64.b64encode(jpeg(scene(5))).decode()
    data = cv.decode_snapshot(raw)
    assert data[:2] == b"\xff\xd8"
    with pytest.raises(cv.ViewError):
        cv.decode_snapshot(base64.b64encode(b"<svg onload=alert(1)>").decode())


# --- approval and moves ---

def setup(db: Session) -> tuple[Project, Camera, User, User]:
    owner = User(username="foreman", name="Прораб Петров", role=UserRole.MANAGER)
    chief = User(username="chief", name="Иванов", role=UserRole.ADMIN)
    db.add_all([owner, chief])
    db.flush()
    project = Project(code="PRJ-VIEW", name="Объект", owner_username=owner.username, escalation_user_id=chief.id)
    db.add(project)
    db.flush()
    camera = Camera(project_id=project.id, code="CAM-V1", name="Камера 1", stream_url="http://cam/1")
    db.add(camera)
    db.commit()
    return project, camera, owner, chief


def b64(im: Image.Image) -> str:
    return base64.b64encode(jpeg(im)).decode()


def view_incident(db: Session, project: Project, camera: Camera, user: User) -> Incident:
    res = create_incident(
        IncidentCreateRequest(
            project_id=project.id, camera_id=camera.id, camera_name=camera.name,
            discrepancy_type="VIEW_CHANGED", severity="ERROR",
            title="Ракурс камеры изменён: Камера 1", description="Наблюдение: совпадение 21 %",
            album_snapshots=[{"camera_name": "Камера 1 · сейчас", "snapshot_base64": b64(scene(9)), "is_primary": True}],
        ),
        db, user,
    )
    return db.get(Incident, res.id)


def test_foreman_proposes_and_only_admin_approves(db: Session) -> None:
    project, camera, owner, chief = setup(db)
    state = views_api.submit_reference(project.id, camera.id, ViewReferenceRequest(snapshot_base64=b64(scene(1)), note="кран Б"), db, owner)
    assert state.reference is None and state.proposal and state.proposal.by == "Прораб Петров"

    with pytest.raises(HTTPException) as denied:
        views_api.approve_reference(project.id, camera.id, db, owner)
    assert denied.value.status_code == 403

    state = views_api.approve_reference(project.id, camera.id, db, chief)
    assert state.reference and state.reference.by == "Иванов" and state.proposal is None
    assert [h.kind for h in state.history] == ["reference_set", "reference_proposed"]


def test_viewer_cannot_change_the_view(db: Session) -> None:
    project, camera, *_ = setup(db)
    viewer = User(username="watch", name="Наблюдатель", role=UserRole.VIEWER)
    db.add(viewer)
    project.owner_username = viewer.username
    db.commit()
    with pytest.raises(HTTPException) as denied:
        views_api.submit_reference(project.id, camera.id, ViewReferenceRequest(snapshot_base64=b64(scene(1))), db, viewer)
    assert denied.value.status_code == 403


def test_view_event_needs_reference_and_belongs_to_its_camera(db: Session, storage: LocalStorage) -> None:
    project, camera, owner, chief = setup(db)
    with pytest.raises(HTTPException) as no_ref:
        view_incident(db, project, camera, owner)
    assert no_ref.value.status_code == 422

    views_api.submit_reference(project.id, camera.id, ViewReferenceRequest(snapshot_base64=b64(scene(1))), db, chief)
    other = Camera(project_id=project.id, code="CAM-V2", name="Камера 2", stream_url="http://cam/2")
    db.add(other)
    db.commit()
    views_api.submit_reference(project.id, other.id, ViewReferenceRequest(snapshot_base64=b64(scene(2))), db, chief)

    first = view_incident(db, project, camera, owner)
    second = view_incident(db, project, other, owner)
    assert first.id != second.id
    assert first.assigned_user_id == owner.id
    names = [p["camera_name"] for p in first.explanation["album_photos"]]
    assert names == ["Камера 1 · сейчас", "Камера 1 · утверждённый ракурс"]


def test_new_reference_closes_view_events_as_agreed(db: Session) -> None:
    project, camera, owner, chief = setup(db)
    views_api.submit_reference(project.id, camera.id, ViewReferenceRequest(snapshot_base64=b64(scene(1))), db, chief)
    incident = view_incident(db, project, camera, owner)

    views_api.submit_reference(project.id, camera.id, ViewReferenceRequest(snapshot_base64=b64(scene(9)), note="камера на мачте Б"), db, owner)
    db.refresh(incident)
    assert incident.status == IncidentStatus.PENDING  # a proposal decides nothing

    views_api.approve_reference(project.id, camera.id, db, chief)
    db.refresh(incident)
    assert incident.status == IncidentStatus.RESOLVED
    assert incident.verification_details["resolution"] == "accepted"
    kinds = {n.kind for n in db.scalars(select(AlertNotification))}
    assert "view_accepted" in kinds


def test_agreed_move_suppresses_view_events_and_expires_into_a_task(db: Session) -> None:
    project, camera, owner, chief = setup(db)
    views_api.submit_reference(project.id, camera.id, ViewReferenceRequest(snapshot_base64=b64(scene(1))), db, chief)
    until = datetime.now(UTC) + timedelta(hours=2)
    state = views_api.request_move(project.id, camera.id, ViewMoveRequest(until=until, reason="кран переставили"), db, owner)
    assert state.move and state.move.status == "requested"

    with pytest.raises(HTTPException):
        views_api.approve_move(project.id, camera.id, db, owner)
    state = views_api.approve_move(project.id, camera.id, db, chief)
    assert state.move.status == "approved" and state.move.approved_by == "Иванов"

    with pytest.raises(HTTPException) as agreed:
        view_incident(db, project, camera, owner)
    assert agreed.value.status_code == 409

    assert cv.expire_moves(db, now=until + timedelta(minutes=1)) == 1
    db.commit()
    overdue = db.scalars(select(Incident).where(Incident.discrepancy_type == "VIEW_MOVE_OVERDUE")).one()
    assert overdue.assigned_user_id == owner.id and overdue.camera_id == camera.id
    assert camera.view_move_status is None
    assert db.scalars(select(CameraViewEvent.kind).where(CameraViewEvent.kind == "move_expired")).one()


def test_reject_and_cancel(db: Session) -> None:
    project, camera, owner, chief = setup(db)
    views_api.submit_reference(project.id, camera.id, ViewReferenceRequest(snapshot_base64=b64(scene(1))), db, owner)
    state = views_api.reject_reference(project.id, camera.id, ViewNote(note="не тот ракурс"), db, chief)
    assert state.proposal is None and state.history[0].note == "не тот ракурс"

    until = datetime.now(UTC) + timedelta(hours=1)
    views_api.request_move(project.id, camera.id, ViewMoveRequest(until=until, reason="перенос на мачту"), db, owner)
    state = views_api.cancel_move(project.id, camera.id, db, owner)
    assert state.move is None
    with pytest.raises(HTTPException) as past:
        views_api.request_move(project.id, camera.id, ViewMoveRequest(until=datetime.now(UTC) - timedelta(minutes=1), reason="поздно"), db, owner)
    assert past.value.status_code == 422


# --- the server's recheck ---

def test_recheck_compares_fresh_frames_with_the_reference(db: Session, monkeypatch) -> None:
    project, camera, owner, chief = setup(db)
    views_api.submit_reference(project.id, camera.id, ViewReferenceRequest(snapshot_base64=b64(scene(1))), db, chief)
    incident = view_incident(db, project, camera, owner)

    turned = cv.verify_view_incident(db, incident, capture=lambda _c: jpeg(scene(9)), pause=0)
    assert turned.outcome == "failed"
    back = cv.verify_view_incident(db, incident, capture=lambda _c: jpeg(scene(1)), pause=0)
    assert back.outcome == "passed" and back.details["resolution"] == "restored"
    dark = cv.verify_view_incident(db, incident, capture=lambda _c: None, pause=0)
    assert dark.outcome == "unavailable"

    # the server's recheck of a camera view is this comparison, not a machinery check
    monkeypatch.setattr(cv, "verify_view_incident", lambda _db, _inc, **_kw: turned)
    assert verify_incident(db, incident).outcome == "failed"

    # «камера возвращена — проверить» rechecks at once, without waiting for beat
    monkeypatch.setattr(incidents_api, "verify_view_incident", lambda _db, _inc, **_kw: turned)
    update_incident_status(incident.id, IncidentStatusUpdateRequest(status="resolved"), db, owner)
    assert incident.status == IncidentStatus.IN_PROGRESS and incident.verification_status == "failed"
    monkeypatch.setattr(incidents_api, "verify_view_incident", lambda _db, _inc, **_kw: back)
    update_incident_status(incident.id, IncidentStatusUpdateRequest(status="resolved"), db, owner)
    assert incident.status == IncidentStatus.RESOLVED
    assert incident.verification_details["resolution"] == "restored"


def test_http_camera_frame_is_read_without_opencv(monkeypatch) -> None:
    body = b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpeg(scene(1)) + b"\r\n--frame\r\n"

    def transport(request):
        import httpx

        if request.url.path == "/snap.jpg":
            return httpx.Response(200, headers={"content-type": "image/jpeg"}, content=jpeg(scene(2)))
        return httpx.Response(200, headers={"content-type": "multipart/x-mixed-replace; boundary=frame"}, content=body)

    import httpx

    real = httpx.Client
    monkeypatch.setattr(cv.httpx, "Client", lambda **kw: real(transport=httpx.MockTransport(transport), **kw))
    assert cv.capture_http_frame("http://cam/snap.jpg")[:2] == b"\xff\xd8"
    frame = cv.capture_http_frame("http://cam/mjpeg")
    assert frame[:2] == b"\xff\xd8" and frame[-2:] == b"\xff\xd9"


def test_deadline_does_not_close_a_still_turned_camera(db: Session) -> None:
    project, camera, owner, chief = setup(db)
    project.alert_error_deadline_minutes = 1
    db.commit()
    views_api.submit_reference(project.id, camera.id, ViewReferenceRequest(snapshot_base64=b64(scene(1))), db, chief)
    incident = view_incident(db, project, camera, owner)
    later = datetime.now(UTC) + timedelta(minutes=5)
    result = run_due_verifications(
        db, now=later, verifier=lambda d, i: cv.verify_view_incident(d, i, capture=lambda _c: jpeg(scene(9)), pause=0)
    )
    db.commit()
    assert result == {"checked": 1, "resolved": 0, "escalated": 1}
    assert incident.status == IncidentStatus.PENDING
