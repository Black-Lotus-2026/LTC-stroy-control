"""Camera view comparison, customer approval, planned moves and rechecks."""

from __future__ import annotations

import base64
import io
import random
import uuid
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
from app.api.v1.camera_workflow import decide_move, request_move
from app.db.base import Base
from app.models.alert import AlertNotification
from app.models.camera_view import CameraViewEvent
from app.models.customer_control import ProjectRole
from app.models.enums import IncidentStatus, UserRole
from app.models.incident import Incident
from app.models.project import Camera, Project
from app.models.user import User
from app.schemas.camera_view import ViewNote, ViewReferenceRequest
from app.schemas.customer_control import CameraMoveCommand, CameraMoveDecisionCommand
from app.services.alert_service import (
    apply_verification,
    request_verification,
    run_due_verifications,
    verify_incident,
)
from app.storage.local import LocalStorage
from tests.customer_control_fixtures import contractor, customer, system_camera_incident


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
    monkeypatch.setattr(cv.settings, "camera_view_storage_root", tmp_path / "private")
    local = LocalStorage(root=tmp_path, public_url="http://test/media")
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
    darker = ImageEnhance.Contrast(ImageEnhance.Brightness(ref).enhance(0.55)).enhance(
        0.8
    )
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
    project = Project(
        code="PRJ-VIEW",
        name="Объект",
        owner_username=owner.username,
        escalation_user_id=chief.id,
    )
    db.add(project)
    db.flush()
    camera = Camera(
        project_id=project.id, code="CAM-V1", name="Камера 1", stream_url="http://cam/1"
    )
    db.add(camera)
    db.flush()
    customer(db, project, chief)
    contractor(db, project, owner)
    db.commit()
    return project, camera, owner, chief


def b64(im: Image.Image) -> str:
    return base64.b64encode(jpeg(im)).decode()


def view_incident(db: Session, project: Project, camera: Camera, user: User) -> Incident:
    return system_camera_incident(db, project, camera)


def set_reference(project_id, camera_id, body, db, manager):
    views_api.submit_reference(project_id, camera_id, body, db, manager)
    return approve_reference(project_id, camera_id, db, manager)


def test_foreman_proposes_and_only_admin_approves(db: Session) -> None:
    project, camera, owner, chief = setup(db)
    state = views_api.submit_reference(
        project.id,
        camera.id,
        ViewReferenceRequest(snapshot_base64=b64(scene(1)), note="кран Б"),
        db,
        owner,
    )
    assert (
        state.reference is None
        and state.proposal
        and state.proposal.by == "Прораб Петров"
    )

    with pytest.raises(HTTPException) as denied:
        approve_reference(project.id, camera.id, db, owner)
    assert denied.value.status_code == 403

    state = approve_reference(project.id, camera.id, db, chief)
    assert state.reference and state.reference.by == "Иванов" and state.proposal is None
    assert [h.kind for h in state.history] == ["reference_set", "reference_proposed"]


def test_viewer_cannot_change_the_view(db: Session) -> None:
    project, camera, *_ = setup(db)
    viewer = User(username="watch", name="Наблюдатель", role=UserRole.VIEWER)
    db.add(viewer)
    project.owner_username = viewer.username
    customer(db, project, viewer, role=ProjectRole.PROJECT_VIEWER)
    db.commit()
    with pytest.raises(HTTPException) as denied:
        views_api.submit_reference(
            project.id,
            camera.id,
            ViewReferenceRequest(snapshot_base64=b64(scene(1))),
            db,
            viewer,
        )
    assert denied.value.status_code == 403


def test_view_event_needs_reference_and_belongs_to_its_camera(
    db: Session, storage: LocalStorage
) -> None:
    project, camera, owner, chief = setup(db)
    with pytest.raises(HTTPException) as no_ref:
        view_incident(db, project, camera, owner)
    assert no_ref.value.status_code == 422

    set_reference(
        project.id,
        camera.id,
        ViewReferenceRequest(snapshot_base64=b64(scene(1))),
        db,
        chief,
    )
    other = Camera(
        project_id=project.id, code="CAM-V2", name="Камера 2", stream_url="http://cam/2"
    )
    db.add(other)
    db.commit()
    set_reference(
        project.id,
        other.id,
        ViewReferenceRequest(snapshot_base64=b64(scene(2))),
        db,
        chief,
    )

    first = view_incident(db, project, camera, owner)
    second = view_incident(db, project, other, owner)
    assert first.id != second.id
    assert first.assigned_user_id == chief.id
    names = [p["camera_name"] for p in first.explanation["album_photos"]]
    assert names == ["Камера 1 · сейчас", "Камера 1 · утверждённый ракурс"]


def test_new_reference_does_not_accept_historical_view_events(db: Session) -> None:
    project, camera, owner, chief = setup(db)
    set_reference(
        project.id,
        camera.id,
        ViewReferenceRequest(snapshot_base64=b64(scene(1))),
        db,
        chief,
    )
    incident = view_incident(db, project, camera, owner)

    views_api.submit_reference(
        project.id,
        camera.id,
        ViewReferenceRequest(snapshot_base64=b64(scene(9)), note="камера на мачте Б"),
        db,
        owner,
    )
    db.refresh(incident)
    assert incident.status == IncidentStatus.PENDING  # a proposal decides nothing

    approve_reference(project.id, camera.id, db, chief)
    db.refresh(incident)
    assert incident.status == IncidentStatus.PENDING
    assert incident.resolved_at is None
    kinds = {n.kind for n in db.scalars(select(AlertNotification))}
    assert "view_accepted" not in kinds


def test_agreed_move_suppresses_view_events_and_expires_into_a_task(db: Session) -> None:
    project, camera, owner, chief = setup(db)
    set_reference(
        project.id,
        camera.id,
        ViewReferenceRequest(snapshot_base64=b64(scene(1))),
        db,
        chief,
    )
    until = datetime.now(UTC) + timedelta(hours=2)
    move = request_move(
        project.id,
        camera.id,
        CameraMoveCommand(
            requested_from=datetime.now(UTC) - timedelta(seconds=1),
            requested_until=until,
            reason="Кран переставили",
            coverage_plan="Резервный ракурс",
        ),
        db,
        owner,
        uuid.uuid4(),
    )
    assert move.status == "requested"
    with pytest.raises(HTTPException):
        decide_move(
            move.id,
            CameraMoveDecisionCommand(
                expected_version=move.row_version, action="approve", note="Нельзя самому"
            ),
            db,
            owner,
            uuid.uuid4(),
        )
    move = decide_move(
        move.id,
        CameraMoveDecisionCommand(
            expected_version=move.row_version,
            action="approve",
            note="Согласовано заказчиком",
        ),
        db,
        chief,
        uuid.uuid4(),
    )
    assert move.status == "approved" and cv.move_active(camera)
    with pytest.raises(HTTPException) as agreed:
        view_incident(db, project, camera, owner)
    assert agreed.value.status_code == 409
    assert cv.expire_moves(db, now=until + timedelta(minutes=1)) == 1
    db.commit()
    overdue = db.scalars(
        select(Incident).where(Incident.discrepancy_type == "VIEW_MOVE_OVERDUE")
    ).one()
    assert overdue.assigned_user_id == chief.id and overdue.camera_id == camera.id
    assert camera.view_move_status is None
    assert db.scalars(
        select(CameraViewEvent.kind).where(CameraViewEvent.kind == "move_expired")
    ).one()


def test_reject_and_cancel(db: Session) -> None:
    project, camera, owner, chief = setup(db)
    views_api.submit_reference(
        project.id,
        camera.id,
        ViewReferenceRequest(snapshot_base64=b64(scene(1))),
        db,
        owner,
    )
    state = views_api.reject_reference(
        project.id, camera.id, ViewNote(note="Не тот ракурс"), db, chief
    )
    assert state.proposal is None and state.history[0].note == "Не тот ракурс"
    now = datetime.now(UTC)
    move = request_move(
        project.id,
        camera.id,
        CameraMoveCommand(
            requested_from=now,
            requested_until=now + timedelta(hours=1),
            reason="Перенос",
            coverage_plan="Резерв",
        ),
        db,
        owner,
        uuid.uuid4(),
    )
    move = decide_move(
        move.id,
        CameraMoveDecisionCommand(
            expected_version=move.row_version,
            action="cancel",
            note="Отменён до решения заказчика",
        ),
        db,
        owner,
        uuid.uuid4(),
    )
    assert move.status == "cancelled" and camera.view_move_status is None
    with pytest.raises(HTTPException) as past:
        request_move(
            project.id,
            camera.id,
            CameraMoveCommand(
                requested_from=now,
                requested_until=now - timedelta(minutes=1),
                reason="Поздно",
                coverage_plan="Резерв",
            ),
            db,
            owner,
            uuid.uuid4(),
        )
    assert past.value.status_code == 422


# --- the server's recheck ---


def test_recheck_compares_fresh_frames_with_the_reference(
    db: Session, monkeypatch
) -> None:
    project, camera, owner, chief = setup(db)
    set_reference(
        project.id,
        camera.id,
        ViewReferenceRequest(snapshot_base64=b64(scene(1))),
        db,
        chief,
    )
    incident = view_incident(db, project, camera, owner)

    turned = cv.verify_view_incident(
        db, incident, capture=lambda _c: jpeg(scene(9)), pause=0
    )
    assert turned.outcome == "failed"
    back = cv.verify_view_incident(
        db, incident, capture=lambda _c: jpeg(scene(1)), pause=0
    )
    assert back.outcome == "passed" and back.details["resolution"] == "restored"
    dark = cv.verify_view_incident(db, incident, capture=lambda _c: None, pause=0)
    assert dark.outcome == "unavailable"

    # the server's recheck of a camera view is this comparison, not a machinery check
    monkeypatch.setattr(cv, "verify_view_incident", lambda _db, _inc, **_kw: turned)
    assert verify_incident(db, incident).outcome == "failed"

    # Technical verification records supporting evidence; it cannot accept work.
    request_verification(db, incident, chief)
    apply_verification(db, incident, turned)
    assert (
        incident.status == IncidentStatus.PENDING
        and incident.verification_status == "failed"
    )
    apply_verification(db, incident, back)
    assert incident.status == IncidentStatus.PENDING
    assert incident.resolved_at is None
    assert incident.verification_details["resolution"] == "restored"


def test_http_camera_frame_is_read_without_opencv(monkeypatch) -> None:
    monkeypatch.setattr(
        cv.socket, "getaddrinfo", lambda *args, **kwargs: [(2, 1, 6, "", ("8.8.8.8", 80))]
    )
    body = (
        b"--frame\r\nContent-Type: image/jpeg\r\n\r\n"
        + jpeg(scene(1))
        + b"\r\n--frame\r\n"
    )

    def transport(request):
        import httpx

        if request.url.path == "/snap.jpg":
            return httpx.Response(
                200, headers={"content-type": "image/jpeg"}, content=jpeg(scene(2))
            )
        return httpx.Response(
            200,
            headers={"content-type": "multipart/x-mixed-replace; boundary=frame"},
            content=body,
        )

    import httpx

    real = httpx.Client
    monkeypatch.setattr(
        cv.httpx,
        "Client",
        lambda **kw: real(transport=httpx.MockTransport(transport), **kw),
    )
    assert cv.capture_http_frame("http://cam/snap.jpg")[:2] == b"\xff\xd8"
    frame = cv.capture_http_frame("http://cam/mjpeg")
    assert frame[:2] == b"\xff\xd8" and frame[-2:] == b"\xff\xd9"


def test_deadline_does_not_close_a_still_turned_camera(db: Session) -> None:
    project, camera, owner, chief = setup(db)
    project.alert_error_deadline_minutes = 1
    db.commit()
    set_reference(
        project.id,
        camera.id,
        ViewReferenceRequest(snapshot_base64=b64(scene(1))),
        db,
        chief,
    )
    incident = view_incident(db, project, camera, owner)
    later = datetime.now(UTC) + timedelta(minutes=5)
    result = run_due_verifications(
        db,
        now=later,
        verifier=lambda d, i: cv.verify_view_incident(
            d, i, capture=lambda _c: jpeg(scene(9)), pause=0
        ),
    )
    db.commit()
    assert result == {"checked": 0, "resolved": 0, "escalated": 0}
    assert incident.status == IncidentStatus.PENDING
    assert incident.reaction_due_at is None
    assert incident.remediation_due_at is None


def test_view_recheck_requires_majority_of_requested_frames(db):
    project, camera, owner, chief = setup(db)
    set_reference(
        project.id,
        camera.id,
        ViewReferenceRequest(snapshot_base64=b64(scene(1))),
        db,
        chief,
    )
    incident = view_incident(db, project, camera, owner)
    frames = iter([jpeg(scene(1)), None, None])
    result = cv.verify_view_incident(
        db, incident, capture=lambda _: next(frames), pause=0
    )
    assert result.outcome == "unavailable"
    assert result.details["reason"] == "insufficient_frames"
    frames = iter([jpeg(scene(1)), jpeg(scene(1)), None])
    assert (
        cv.verify_view_incident(
            db, incident, capture=lambda _: next(frames), pause=0
        ).outcome
        == "passed"
    )


def test_view_images_are_private_and_authorized(db, storage):
    project, camera, owner, chief = setup(db)
    set_reference(
        project.id,
        camera.id,
        ViewReferenceRequest(snapshot_base64=b64(scene(1))),
        db,
        chief,
    )
    key = camera.view_reference_key
    assert not storage.exists(key)
    assert cv._view_path(key).is_file()
    state = cv.view_state(db, camera)
    assert state["reference"]["url"].startswith(
        f"/api/v1/projects/{project.id}/cameras/{camera.id}/view/assets/"
    )
    asset = state["reference"]["url"].rsplit("/", 1)[1]
    result = views_api.view_asset(project.id, camera.id, asset, db, owner)
    assert result.body == cv.load_view_image(key)
    assert result.headers["cache-control"] == "private, no-store"
    outsider = User(username="private-outsider", name="Outsider", role=UserRole.MANAGER)
    db.add(outsider)
    db.commit()
    with pytest.raises(HTTPException) as failure:
        views_api.view_asset(project.id, camera.id, asset, db, outsider)
    assert failure.value.status_code == 404
    with pytest.raises(HTTPException) as failure:
        views_api.view_asset(project.id, camera.id, "unknown", db, owner)
    assert failure.value.status_code == 404
    second = Camera(project_id=project.id, code="UNCITED-REFERENCE", name="Other camera")
    db.add(second)
    db.commit()
    with pytest.raises(HTTPException) as failure:
        views_api.view_asset(project.id, second.id, asset, db, owner)
    assert failure.value.status_code == 404
    project.kind = "shared_demo"
    project.code = "MANAGEMENT-DEMO"
    project.owner_username = None
    viewer = User(username="shared-viewer", name="Viewer", role=UserRole.VIEWER)
    db.add(viewer)
    db.commit()
    with pytest.raises(HTTPException) as quarantined:
        views_api.view_asset(project.id, camera.id, asset, db, viewer)
    assert quarantined.value.status_code == 404
    project.demo_manifest = {"camera_ids": [str(camera.id)]}
    db.commit()
    assert (
        views_api.view_asset(project.id, camera.id, asset, db, viewer).body == result.body
    )
    with pytest.raises(HTTPException) as failure:
        views_api.submit_reference(
            project.id,
            camera.id,
            ViewReferenceRequest(snapshot_base64=b64(scene(2))),
            db,
            viewer,
        )
    assert failure.value.status_code == 403


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/x",
        "http://169.254.169.254/x",
        "rtsp://[::1]/x",
        "http://10.1.2.3/x",
        "file:///etc/passwd",
        "ftp://8.8.8.8/x",
    ],
)
def test_fresh_capture_rejects_non_network_and_unconfigured_private_targets(
    monkeypatch, url
):
    monkeypatch.setattr(cv.settings, "camera_allowed_networks", [])
    monkeypatch.setattr(
        cv.socket, "getaddrinfo", lambda host, *a, **kw: [(2, 1, 6, "", (host, 80))]
    )
    assert cv.capture_frame(type("Camera", (), {"stream_url": url})()) is None


def test_capture_dns_is_pinned_and_private_networks_require_explicit_allowlist(
    monkeypatch,
):
    import httpx

    monkeypatch.setattr(
        cv.socket, "getaddrinfo", lambda *a, **kw: [(2, 1, 6, "", ("192.168.1.5", 80))]
    )
    monkeypatch.setattr(cv.settings, "camera_allowed_networks", ["192.168.1.0/24"])
    seen = []

    def respond(request):
        seen.append(request)
        return httpx.Response(
            200, headers={"content-type": "image/jpeg"}, content=jpeg(scene(1))
        )

    original = httpx.Client
    monkeypatch.setattr(
        cv.httpx,
        "Client",
        lambda **kw: original(transport=httpx.MockTransport(respond), **kw),
    )
    assert cv.capture_http_frame("https://camera.example/frame.jpg")
    assert seen[0].url.host == "192.168.1.5"
    assert seen[0].headers["host"] == "camera.example"
    assert seen[0].extensions["sni_hostname"] == "camera.example"
    monkeypatch.setattr(cv.settings, "camera_allowed_networks", ["0.0.0.0/0"])
    monkeypatch.setattr(
        cv.socket,
        "getaddrinfo",
        lambda *a, **kw: [(2, 1, 6, "", ("169.254.169.254", 80))],
    )
    assert cv.capture_http_frame("http://camera.example/") is None
    assert len(seen) == 1


def test_slow_http_stream_has_total_deadline_and_redirects_are_not_followed(monkeypatch):
    import httpx

    monkeypatch.setattr(
        cv.socket, "getaddrinfo", lambda *a, **kw: [(2, 1, 6, "", ("8.8.8.8", 80))]
    )
    elapsed = [0.0]
    yielded = []
    monkeypatch.setattr(cv.time, "monotonic", lambda: elapsed[0])

    class SlowStream(httpx.SyncByteStream):
        def __iter__(self):
            for index in range(100):
                elapsed[0] += 0.6
                yielded.append(index)
                yield b"x"

    def respond(request):
        if request.url.path == "/redirect":
            return httpx.Response(302, headers={"location": "http://127.0.0.1/"})
        return httpx.Response(
            200,
            headers={"content-type": "multipart/x-mixed-replace"},
            stream=SlowStream(),
        )

    original = httpx.Client
    monkeypatch.setattr(
        cv.httpx,
        "Client",
        lambda **kw: original(transport=httpx.MockTransport(respond), **kw),
    )
    assert cv.capture_http_frame("http://camera.example/slow", timeout=1) is None
    assert len(yielded) == 2
    assert cv.capture_http_frame("http://camera.example/redirect") is None


def test_rtsp_capture_is_disabled_by_default_and_requires_operator_trusted_network(
    monkeypatch,
):
    from types import SimpleNamespace

    import cv2

    monkeypatch.setattr(
        cv.socket, "getaddrinfo", lambda *a, **kw: [(2, 1, 6, "", ("192.168.1.8", 554))]
    )
    monkeypatch.setattr(
        cv,
        "settings",
        SimpleNamespace(
            camera_allow_rtsp_capture=False, camera_allowed_networks=["192.168.1.0/24"]
        ),
    )
    camera = SimpleNamespace(stream_url="rtsp://operator:secret@camera.example/live")
    assert cv.capture_frame(camera) is None
    cv.settings.camera_allow_rtsp_capture = True
    cv.settings.camera_allowed_networks = []
    assert cv.capture_frame(camera) is None
    cv.settings.camera_allowed_networks = ["192.168.1.0/24"]
    captured = []

    class Capture:
        def isOpened(self):
            return False

        def release(self):
            pass

    monkeypatch.setattr(
        cv2, "VideoCapture", lambda url, *args: captured.append(url) or Capture()
    )
    assert cv.capture_frame(camera) is None
    assert captured == ["rtsp://operator:secret@192.168.1.8/live"]


@pytest.mark.parametrize("condition", ["move", "changed_view", "loop"])
def test_equipment_recheck_fails_closed_for_invalid_camera_context(
    db, monkeypatch, condition
):
    from types import SimpleNamespace

    from app.services import alert_service

    project, camera, owner, chief = setup(db)
    set_reference(
        project.id,
        camera.id,
        ViewReferenceRequest(snapshot_base64=b64(scene(1))),
        db,
        chief,
    )
    incident = view_incident(db, project, camera, owner)
    incident.discrepancy_type = "UNCHARACTERISTIC_PRESENT"
    incident.machinery_type = "Экскаватор"
    if condition == "move":
        camera.view_move_status = "approved"
        camera.view_move_until = datetime.now(UTC) + timedelta(hours=1)
    elif condition == "loop":
        incident.discrepancy_type = "STREAM_LOOP"
        db.flush()
        second = view_incident(db, project, camera, owner)
        second.discrepancy_type = "UNCHARACTERISTIC_PRESENT"
        second.machinery_type = "Экскаватор"
        incident = second
    db.commit()
    monkeypatch.setattr(alert_service, "_capture_frame", lambda _: jpeg(scene(9)))
    monkeypatch.setattr(
        alert_service,
        "_detector",
        lambda: SimpleNamespace(
            is_ready=True,
            compliance_enabled=True,
            can_evaluate=lambda _: True,
            detect_frame=lambda _: [],
        ),
    )
    monkeypatch.setattr(alert_service.time, "sleep", lambda _: None)
    assert alert_service.verify_incident(db, incident).outcome == "unavailable"


def approve_reference(project_id, camera_id, db, manager):
    camera = db.get(Camera, camera_id)
    expected = cv.view_state(db, camera)["proposal"]["sha256"]
    return views_api.approve_reference(project_id, camera_id, db, manager, expected)
