"""Independent HTTP upload boundary tests; never contact VLM/cloud/model servers.

Uses real PNG bytes + multipart ASGI requests and asserts fallback call counts,
error separation and geometry. Detector outputs are explicit synthetic fixtures.
"""

from __future__ import annotations

from contextlib import suppress
from io import BytesIO
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.api.v1 import videos
from app.main import app
from app.services.detector import DetectionResult
from tests import test_customer_control_http

customer_http = test_customer_control_http.customer_http

SEMANTICS25 = [
    "backhoe_loader",
    "bulldozer",
    "cleaning_equipment",
    "concrete_mixer",
    "concrete_pump",
    "crane_manipulator",
    "crawler_crane",
    "dump_truck",
    "excavator",
    "forklift_giraffe",
    "forklift_standart",
    "gazelle",
    "grader",
    "hanging_head",
    "loader",
    "mobile_crane",
    "other_vehicle",
    "pile_driving",
    "roller",
    "tanker",
    "tower_crane",
    "trailer",
    "truck",
    "truck_crane",
    "worker",
]


def png():
    stream = BytesIO()
    Image.new("RGB", (100, 60), (180, 40, 20)).save(stream, format="PNG")
    return stream.getvalue()


def box(label="backhoe_loader", idx=0):
    return DetectionResult(
        idx, label, label, "MACHINERY_" + label.upper(), 0.876, 0.1, 0.2, 0.7, 0.8
    )


@pytest.fixture
def boundary(monkeypatch, customer_http):
    state = {
        "yolo_calls": [],
        "vlm_calls": [],
        "yolo_rows": [],
        "yolo_error": None,
        "ready": True,
        "vlm_status": "used",
        "vlm_rows": [box("excavator")],
        "vlm_error": None,
        "vlm_factory_calls": 0,
    }

    class Detector:
        profile = "construction_trained28"
        policy = "observe"
        weights_path = "LOCAL_SHA_PINNED.pt"
        weight_paths = {"trained": "LOCAL_SHA_PINNED.pt"}
        supported_classes = SEMANTICS25
        unsupported_classes = []
        compliance_enabled = False

        @property
        def is_ready(self):
            return state["ready"]

        @property
        def status(self):
            return "ready" if state["ready"] else "weights_missing"

        @property
        def status_message(self):
            return (
                "Synthetic HTTP fixture"
                if state["ready"]
                else "Pinned weights missing/invalid"
            )

        def detect_frame(self, image, stage_name=None, enable_slicing=True):
            state["yolo_calls"].append({"image": image, "stage": stage_name})
            if state["yolo_error"]:
                raise state["yolo_error"]
            return state["yolo_rows"]

    class VLM:
        async def detect(self, image):
            state["vlm_calls"].append(image)
            if state["vlm_error"]:
                raise state["vlm_error"]
            return SimpleNamespace(
                detections=state["vlm_rows"],
                status=state["vlm_status"],
                message="Explicit synthetic fallback result",
                confidence_calibrated=False,
            )

    def factory():
        state["vlm_factory_calls"] += 1
        return VLM()

    monkeypatch.setattr(videos, "get_machinery_detector", lambda: Detector())
    monkeypatch.setattr(videos, "get_photo_vlm", factory, raising=False)
    state["demo_id"] = str(customer_http.projects["demo"].id)
    with TestClient(app, raise_server_exceptions=False) as client:
        client.headers.update(customer_http.headers())
        client.params = {"project_id": str(customer_http.projects["a"].id)}
        yield state, client


def post(client, endpoint, contents=None):
    return client.post(
        "/api/v1/videos/" + endpoint,
        files={
            "file": ("frame.png", png() if contents is None else contents, "image/png")
        },
    )


def assert_empty_error_scope(state, response, code):
    assert response.status_code == code, response.text
    assert state["vlm_factory_calls"] == 0 and not state["vlm_calls"]


@pytest.mark.parametrize("label", ["backhoe_loader", "worker", "other_vehicle"])
def test_photo_nonempty_yolo_never_enters_fallback(boundary, label):
    state, client = boundary
    state["yolo_rows"] = [box(label)]
    response = post(client, "detect-photo")
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["source"] == "yolo" and data["fallback_status"] == "not_needed"
    assert data["count"] == 1 and data["detections"][0]["raw_label"] == label
    assert len(state["yolo_calls"]) == 1 and state["vlm_factory_calls"] == 0


def test_photo_empty_only_then_vlm_success_and_css_geometry(boundary):
    state, client = boundary
    response = post(client, "detect-photo")
    assert response.status_code == 200, response.text
    data = response.json()
    assert (
        data["source"] == "vlm"
        and data["fallback_status"] == "used"
        and data["count"] == 1
    )
    assert len(state["yolo_calls"]) == len(state["vlm_calls"]) == 1
    d = data["detections"][0]
    assert (d["x1"], d["y1"], d["x2"], d["y2"]) == pytest.approx((0.1, 0.2, 0.7, 0.8))
    assert (d["left"], d["top"], d["width"], d["height"]) == pytest.approx(
        (10, 20, 60, 60)
    )
    assert d["raw_label"] == "excavator" and d["confidence"] == pytest.approx(0.88)


@pytest.mark.parametrize("status", ["empty", "unavailable", "timeout", "error"])
def test_photo_empty_fallback_outcomes_are_explicit_not_yolo_failures(boundary, status):
    state, client = boundary
    state["vlm_status"] = status
    state["vlm_rows"] = []
    response = post(client, "detect-photo")
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["source"] == "yolo" and data["fallback_status"] == status
    assert data["detections"] == [] and data["count"] == 0 and data["message"]
    assert len(state["yolo_calls"]) == len(state["vlm_calls"]) == 1


@pytest.mark.parametrize("endpoint", ["detect-photo", "detect-frame"])
@pytest.mark.parametrize("contents", [b"", b"not an image", b"\x89PNG\r\n\x1a\ncorrupt"])
def test_bad_payload_rejected_before_any_inference(boundary, endpoint, contents):
    state, client = boundary
    response = post(client, endpoint, contents)
    assert_empty_error_scope(state, response, 400)
    assert not state["yolo_calls"]


@pytest.mark.parametrize("endpoint", ["detect-photo", "detect-frame"])
def test_oversize_upload_rejected_without_inference_or_fallback(boundary, endpoint):
    state, client = boundary
    response = post(client, endpoint, b"x" * (20 * 1024 * 1024 + 1))
    assert_empty_error_scope(state, response, 413)
    assert not state["yolo_calls"]


@pytest.mark.parametrize("endpoint", ["detect-photo", "detect-frame"])
def test_missing_or_rejected_weights_is_503_not_empty_fallback(boundary, endpoint):
    state, client = boundary
    state["ready"] = False
    response = post(client, endpoint)
    assert_empty_error_scope(state, response, 503)
    assert not state["yolo_calls"]


@pytest.mark.parametrize("endpoint", ["detect-photo", "detect-frame"])
@pytest.mark.parametrize(
    "error", [RuntimeError("model forward failed"), ValueError("head/geometry invalid")]
)
def test_inference_exception_is_502_never_photo_fallback(boundary, endpoint, error):
    state, client = boundary
    state["yolo_error"] = error
    response = post(client, endpoint)
    assert_empty_error_scope(state, response, 502)
    assert len(state["yolo_calls"]) == 1


@pytest.mark.parametrize("rows", [[], [box("loader")]])
def test_video_frame_path_never_calls_vlm_even_empty(boundary, rows):
    state, client = boundary
    state["yolo_rows"] = rows
    response = post(client, "detect-frame")
    assert response.status_code == 200, response.text
    data = response.json()
    assert (
        data["source"] == "yolo"
        and data["fallback_status"] == "not_requested"
        and data["count"] == len(rows)
    )
    assert len(state["yolo_calls"]) == 1 and state["vlm_factory_calls"] == 0


def test_full_actual25_semantic_inventory_is_not_silently_reduced_to_11_or13(boundary):
    state, client = boundary
    state["yolo_rows"] = [box(name, i) for i, name in enumerate(SEMANTICS25)]
    response = post(client, "detect-frame")
    assert response.status_code == 200, response.text
    data = response.json()
    assert (
        data["count"] == 25
        and [d["raw_label"] for d in data["detections"]] == SEMANTICS25
    )
    assert not state["vlm_calls"]


@pytest.fixture
def upload_db(tmp_path, monkeypatch):
    from sqlalchemy import create_engine
    from sqlalchemy.dialects.postgresql import JSONB
    from sqlalchemy.ext.compiler import compiles
    from sqlalchemy.orm import Session
    from sqlalchemy.pool import StaticPool

    from app.api.deps import get_current_user
    from app.core.config import settings
    from app.db.base import Base
    from app.models.customer_control import (
        Organization,
        OrganizationMembership,
        ProjectAssignment,
        ProjectOrganization,
        ProjectRole,
    )
    from app.models.enums import UserRole
    from app.models.project import Project
    from app.models.user import User

    monkeypatch.setattr(settings, "storage_local_root", tmp_path / "media")

    @compiles(JSONB, "sqlite")
    def sqlite_json(type_, compiler, **kw):
        return "JSON"

    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        user = User(username="upload-owner", name="Upload owner", role=UserRole.MANAGER)
        project = Project(
            code="REAL-UPLOAD-QA",
            name="Isolated upload fixture",
            owner_username=user.username,
        )
        db.add_all([user, project])
        organization = Organization(name="Explicit isolated upload customer")
        db.add(organization)
        db.flush()
        project.customer_organization_id = organization.id
        project.authorization_version = 2
        membership = OrganizationMembership(
            organization_id=organization.id, user_id=user.id
        )
        participation = ProjectOrganization(
            project_id=project.id, organization_id=organization.id, side="customer"
        )
        db.add_all([membership, participation])
        db.flush()
        db.add(
            ProjectAssignment(
                participation_id=participation.id,
                membership_id=membership.id,
                role=ProjectRole.CUSTOMER_MANAGER,
                scope_kind="project",
            )
        )
        db.commit()
        app.dependency_overrides[get_current_user] = lambda: user
        try:
            yield db, project
        finally:
            app.dependency_overrides.pop(get_current_user, None)
    engine.dispose()


@pytest.fixture
def native_mp4(tmp_path):
    import cv2
    import numpy as np

    file = tmp_path / "native-6frames.mp4"
    writer = cv2.VideoWriter(str(file), cv2.VideoWriter_fourcc(*"mp4v"), 3.0, (80, 48))
    assert writer.isOpened(), "Local MP4 codec unavailable; cannot claim real upload test"
    for k in range(6):
        writer.write(np.full((48, 80, 3), (k * 20, 35, 150), dtype=np.uint8))
    writer.release()
    return file.read_bytes()


def test_real_video_upload_probes_native_metadata_not_120s_placeholder(
    upload_db, native_mp4
):
    from pathlib import Path

    from app.db.session import get_db
    from app.models.video import VideoAsset

    db, project = upload_db
    app.dependency_overrides[get_db] = lambda: db
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            response = client.post(
                "/api/v1/videos/upload",
                params={"project_id": str(project.id)},
                files={"file": ("native.mp4", native_mp4, "video/mp4")},
                data={"start_timestamp": "2026-10-19T10:00:00Z"},
            )
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["duration_seconds"] == pytest.approx(2.0, abs=0.05)
        assert result["fps"] == pytest.approx(3.0, abs=0.01)
        asset = db.get(VideoAsset, __import__("uuid").UUID(result["video_id"]))
        assert asset.frame_count == 6 and asset.project_id == project.id
        assert Path(asset.storage_key).is_file()
        # Remove only this test's newly created disposable upload, never user data.
        Path(asset.storage_key).unlink()
    finally:
        app.dependency_overrides.pop(get_db, None)


def test_corrupt_video_not_registered_as_ready(upload_db):
    from sqlalchemy import func, select

    from app.db.session import get_db
    from app.models.video import VideoAsset

    db, project = upload_db
    app.dependency_overrides[get_db] = lambda: db
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            response = client.post(
                "/api/v1/videos/upload",
                params={"project_id": str(project.id)},
                files={"file": ("fake.mp4", b"not a real MP4", "video/mp4")},
                data={"start_timestamp": "2026-10-19T10:00:00Z"},
            )
        assert response.status_code == 400, response.text
        assert db.scalar(select(func.count()).select_from(VideoAsset)) == 0
    finally:
        app.dependency_overrides.pop(get_db, None)


def test_legacy_untrusted_frame_worker_preserves_no_compliance_scope(
    upload_db, monkeypatch
):
    from datetime import UTC, datetime

    from sqlalchemy import func, select

    from app.models.incident import Incident
    from app.models.schedule import ScheduleTask
    from app.workers import cv_tasks

    db, project = upload_db
    stage = ScheduleTask(
        project_id=project.id,
        name="Frame worker fixture",
        order_index=1,
        planned_start=datetime(2026, 10, 19, tzinfo=UTC),
        planned_end=datetime(2026, 10, 20, tzinfo=UTC),
        duration_days=1,
        machinery_probabilities={"Экскаватор": 0.99},
    )
    db.add(stage)
    db.commit()
    calls = []
    image = png()
    detector = SimpleNamespace(
        is_ready=True,
        compliance_enabled=False,
        detect_frame=lambda frame: calls.append(frame) or [box("worker")],
    )
    monkeypatch.setattr(cv_tasks, "get_detector", lambda: detector, raising=False)
    assert cv_tasks.process_video_frame_sync(image, stage.id, project.id, db=db) == []
    assert calls == [] and db.scalar(select(func.count()).select_from(Incident)) == 0

    def fail(frame):
        raise RuntimeError("real unavailable state must not become absence")

    detector.detect_frame = fail
    detector.is_ready = False
    with suppress(RuntimeError):
        cv_tasks.process_video_frame_sync(image, stage.id, project.id, db=db)
    assert db.scalar(select(func.count()).select_from(Incident)) == 0


@pytest.mark.parametrize("where", ["factory", "detect"])
def test_unexpected_vlm_adapter_failure_does_not_destroy_valid_empty_yolo_result(
    boundary, monkeypatch, where
):
    state, client = boundary
    secret = "PRIVATE_KEY_should_never_appear_in_response"
    if where == "detect":
        state["vlm_error"] = RuntimeError(secret)
    else:

        def fail_factory():
            raise RuntimeError(secret)

        monkeypatch.setattr(videos, "get_photo_vlm", fail_factory)
    response = post(client, "detect-photo")
    assert response.status_code == 200, response.text
    data = response.json()
    assert (
        data["source"] == "yolo"
        and data["fallback_status"] == "error"
        and data["count"] == 0
        and data["detections"] == []
    )
    assert secret not in response.text and len(state["yolo_calls"]) == 1


@pytest.mark.parametrize(
    "outcome", ["all25", "empty", "unavailable", "inference", "invalid"]
)
def test_construction_frame_compatibility_uses_same_yolo_only_boundary(boundary, outcome):
    state, client = boundary
    if outcome == "all25":
        state["yolo_rows"] = [box(name, i) for i, name in enumerate(SEMANTICS25)]
    elif outcome == "unavailable":
        state["ready"] = False
    elif outcome == "inference":
        state["yolo_error"] = RuntimeError("Synthetic model failure must not use VLM")
    response = post(
        client, "construction-frame", b"invalid image" if outcome == "invalid" else None
    )
    expected = {"unavailable": 503, "inference": 502, "invalid": 400}.get(outcome, 200)
    assert_empty_error_scope(state, response, expected)
    if expected != 200:
        assert len(state["yolo_calls"]) == int(outcome == "inference")
        return
    data = response.json()
    assert data["profile"] == "construction_trained"
    assert data["physical_machine_count"] is None
    assert data["source"] == "yolo" and data["fallback_status"] == "not_requested"
    assert data["model_ready"] is True and data["compliance_enabled"] is False
    assert data["confidence_calibrated"] is False and data["evaluable_classes"] == []
    assert len(state["yolo_calls"]) == 1
    assert data["count"] == (25 if outcome == "all25" else 0)
    assert [d["raw_label"] for d in data["detections"]] == (
        SEMANTICS25 if outcome == "all25" else []
    )
    if outcome == "all25":
        for i, detection in enumerate(data["detections"]):
            assert detection["class_id"] == i
            assert (
                detection["x1"],
                detection["y1"],
                detection["x2"],
                detection["y2"],
            ) == pytest.approx((0.1, 0.2, 0.7, 0.8))


def test_frame_and_status_agree_on_enabled_rule_classes(boundary, monkeypatch):
    state, client = boundary
    original = videos.get_machinery_detector()
    original.compliance_enabled = True
    original.evaluable_classes = ["excavator", "loader"]
    monkeypatch.setattr(videos, "get_machinery_detector", lambda: original)
    status = client.get("/api/v1/videos/detector-status").json()
    frame = post(client, "detect-frame").json()
    assert status["compliance_enabled"] and frame["compliance_enabled"]
    assert (
        status["evaluable_classes"]
        == frame["evaluable_classes"]
        == ["excavator", "loader"]
    )
    # A VLM-only photo result never authorizes absence rules from YOLO.
    photo = post(client, "detect-photo").json()
    assert photo["source"] == "vlm" and not photo["compliance_enabled"]
    assert photo["evaluable_classes"] == []


def test_detect_frame_and_photo_without_project_id_succeeds(boundary):
    state, client = boundary
    client.params = {}
    response = post(client, "detect-frame")
    assert response.status_code == 200
    assert response.json()["model_ready"] is True

    photo_response = post(client, "detect-photo")
    assert photo_response.status_code == 200
    assert photo_response.json()["model_ready"] is True


def test_detect_frame_with_demo_project_id_is_not_blocked(boundary):
    state, client = boundary
    client.params = {"project_id": state["demo_id"]}
    response = post(client, "detect-frame")
    assert response.status_code == 200
    assert response.json()["model_ready"] is True

    photo_response = post(client, "detect-photo")
    assert photo_response.status_code == 200
