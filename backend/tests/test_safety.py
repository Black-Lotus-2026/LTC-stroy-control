"""Safety integration tests: real ASGI/multipart/db, synthetic local detector only."""

import uuid
from datetime import UTC, datetime, timedelta
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.deps import get_current_user
from app.api.v1 import videos
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models import Camera, Project, User, UserRole
from app.services.detector import DetectionResult
from app.services.safety_catalog import seed_catalog
from tests.customer_control_fixtures import contractor, customer


@compiles(JSONB, "sqlite")
def compile_jsonb(type_, compiler, **kw):
    return "JSON"


@pytest.fixture
def env(monkeypatch):
    engine = create_engine(
        "sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False}
    )
    Base.metadata.create_all(engine)
    state = {
        "label": "worker",
        "confidence": 0.9,
        "box": (0.25, 0.2, 0.45, 0.6),
        "ready": True,
        "error": False,
    }
    with Session(engine) as db:
        owner = User(username="owner", name="Owner", role=UserRole.VIEWER)
        other = User(username="other", name="Other", role=UserRole.MANAGER)
        responsible = User(
            username="inspector", name="Inspector", role=UserRole.INSPECTOR
        )
        db.add_all([owner, other, responsible])
        db.flush()
        project = Project(code="P", name="Project", owner_username="owner")
        db.add(project)
        db.flush()
        camera = Camera(project_id=project.id, code="C", name="Camera")
        db.add(camera)
        db.flush()
        customer(db, project, owner)
        responsible_grant = contractor(db, project, responsible)
        ids_responsible_membership = responsible_grant.membership.id
        seed_catalog(db)
        db.commit()
        ids = dict(
            owner=owner.id,
            other=other.id,
            responsible=responsible.id,
            project=project.id,
            camera=camera.id,
            responsible_membership=ids_responsible_membership,
        )
    state["actor"] = "owner"
    state["server_position"] = 0
    state["server_raw"] = None
    base = datetime.now(UTC) + timedelta(seconds=1)

    class SyntheticServerClock(datetime):
        @classmethod
        def now(cls, tz=None):
            current = base + timedelta(milliseconds=state["server_position"])
            return current if tz else current.replace(tzinfo=None)

    monkeypatch.setattr("app.api.v1.safety.datetime", SyntheticServerClock)
    monkeypatch.setattr(
        "app.services.camera_view.capture_frame", lambda camera: state["server_raw"]
    )
    monkeypatch.setattr(
        "app.services.observation_basis.camera_frame_quality", lambda *args: True
    )

    def session():
        with Session(engine) as db:
            yield db

    def actor():
        with Session(engine) as db:
            return db.get(User, ids[state["actor"]])

    app.dependency_overrides[get_db] = session
    app.dependency_overrides[get_current_user] = actor

    class Detector:
        is_ready = True
        status = "ready"
        status_message = "ok"
        sha256 = "a" * 64
        compliance_enabled = False

        def detect_frame(self, *args):
            if state["error"]:
                raise RuntimeError("secret")
            if state["label"] is None:
                return []
            return [
                DetectionResult(
                    0,
                    state["label"],
                    "Объект",
                    "MACHINERY",
                    state["confidence"],
                    *state["box"],
                )
            ]

    monkeypatch.setattr(videos, "get_machinery_detector", lambda: Detector())
    app.state.safety_test_state = state
    with TestClient(app) as client:
        yield client, ids, state, engine
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    engine.dispose()


def zone_payload(ids, **overrides):
    payload = dict(
        camera_id=str(ids["camera"]),
        name="Опасная зона",
        scenario="worker_danger_zone",
        polygon=[[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]],
        site_basis="ППР № 12, утвержденная опасная зона",
        responsible_user_id=str(ids["responsible"]),
        min_duration_seconds=3,
    )
    return {**payload, **overrides}


def create(client, ids, **overrides):
    result = client.post(
        f"/api/v1/safety/projects/{ids['project']}/zones",
        json=zone_payload(ids, **overrides),
    )
    assert result.status_code == 201, result.text
    return result.json()


def frame(client, ids, position, color=1, source="source", **extra):
    stream = BytesIO()
    Image.new("RGB", (40, 30), (color, 30, 70)).save(stream, format="PNG")
    # Only the mocked server capture/clock selects authoritative pixels and time.
    state = client.app.state.safety_test_state
    state["server_raw"] = stream.getvalue()
    state["server_position"] = position
    return client.post(
        f"/api/v1/safety/projects/{ids['project']}/analyze-frame",
        data=dict(
            camera_id=str(ids["camera"]), source_id=source, position_ms=position, **extra
        ),
        files={"file": ("frame.png", stream.getvalue(), "image/png")},
    )


def event_list(client, ids):
    return client.get(f"/api/v1/safety/projects/{ids['project']}/events").json()


def test_candidate_evidence_review_snapshot_and_audit(env):
    client, ids, state, engine = env
    zone = create(client, ids)
    assert frame(client, ids, 1730000000000).json()["safety"]["events"] == []
    result = frame(client, ids, 1730000004000, color=2)
    assert result.status_code == 200, result.text
    event = result.json()["safety"]["events"][0]
    assert event["status"] == "candidate" and event["snapshot"]["observations"] == 2
    assert (
        len(event["snapshot"]["requirements"]) == 2
        and len(event["snapshot"]["sanctions"]) == 3
    )
    assert event["model_sha256"] == "a" * 64
    for kind in ["first", "last"]:
        proof = client.get(event["evidence_url"], params={"kind": kind})
        assert proof.status_code == 200
        assert Image.open(BytesIO(proof.content)).format == "JPEG"
        assert proof.headers["cache-control"] == "private, no-store"
    assert (
        client.post(
            f"/api/v1/safety/events/{event['id']}/review",
            json={"decision": "confirmed", "comment": "Проверено по схеме площадки"},
        ).status_code
        == 409
    )
    assert (
        client.post(
            f"/api/v1/safety/events/{event['id']}/review",
            json={"decision": "rejected", "comment": "Повторное решение"},
        ).status_code
        == 409
    )
    assert frame(client, ids, 1730000008000, color=3).json()["safety"]["events"] == []
    updated = zone_payload(ids, name="Новая зона")
    assert (
        client.patch(f"/api/v1/safety/zones/{zone['id']}", json=updated).status_code
        == 200
    )
    saved = event_list(client, ids)[0]
    assert saved["snapshot"]["zone"]["name"] == "Опасная зона"
    assert (
        saved["reviewed_by"] is None
    )  # Review belongs to the linked canonical Incident.


@pytest.mark.parametrize(
    "scenario,label",
    [
        ("worker_danger_zone", "worker"),
        ("vehicle_blocks_passage", "loader"),
        ("vehicle_restricted_zone", "excavator"),
    ],
)
def test_three_scenarios(env, scenario, label):
    client, ids, state, _ = env
    state["label"] = label
    create(client, ids, scenario=scenario)
    frame(client, ids, 0)
    result = frame(client, ids, 4000, color=2)
    assert result.json()["safety"]["events"][0]["scenario"] == scenario


@pytest.mark.parametrize(
    "mode",
    [
        "duplicate",
        "out_of_order",
        "gap",
        "other_source",
        "outside",
        "confidence",
        "other_object",
        "empty",
    ],
)
def test_non_continuous_evidence_never_creates_candidate(env, mode):
    client, ids, state, _ = env
    create(client, ids)
    frame(client, ids, 1000)
    position = 5000
    color = 2
    source = "source"
    if mode == "duplicate":
        color = 1
    if mode == "out_of_order":
        position = 500
    if mode == "gap":
        position = 20000
    if mode == "other_source":
        source = "different"
    if mode == "outside":
        state["box"] = (0.91, 0.91, 0.99, 0.99)
    if mode == "confidence":
        state["confidence"] = 0.49
    if mode == "other_object":
        state["box"] = (0.7, 0.2, 0.8, 0.6)
    if mode == "empty":
        state["label"] = None
    response = frame(client, ids, position, color, source)
    assert response.status_code == 200, response.text
    if mode == "other_source":
        # A caller cannot split a real camera timeline by inventing a source ID.
        assert len(event_list(client, ids)) == 1
    else:
        assert event_list(client, ids) == []


def test_clear_then_reentry_creates_second_candidate(env):
    client, ids, state, _ = env
    create(client, ids)
    frame(client, ids, 0)
    frame(client, ids, 4000, 2)
    state["label"] = None
    frame(client, ids, 5000, 3)
    state["label"] = "worker"
    frame(client, ids, 6000, 4)
    frame(client, ids, 10000, 5)
    assert len(event_list(client, ids)) == 2


def test_allowed_vehicle_worker_hook_no_unsafe_alias(env):
    client, ids, state, _ = env
    create(client, ids, scenario="vehicle_restricted_zone", allowed_classes=["loader"])
    for i, label in enumerate(["loader", "worker", "hanging_head", "grader"]):
        state["label"] = label
        frame(client, ids, i * 8000, i * 2 + 1)
        frame(client, ids, i * 8000 + 4000, i * 2 + 2)
    assert event_list(client, ids) == []


def test_project_rbac_and_assigned_inspector_cannot_review(env):
    client, ids, state, _ = env
    zone = create(client, ids)
    frame(client, ids, 0)
    frame(client, ids, 4000, 2)
    event = event_list(client, ids)[0]
    state["actor"] = "other"
    assert (
        client.get(f"/api/v1/safety/projects/{ids['project']}/events").status_code == 404
    )
    assert client.get(event["evidence_url"]).status_code == 404
    state["actor"] = "responsible"
    assert (
        client.get(f"/api/v1/safety/projects/{ids['project']}/events").status_code == 403
    )
    assert client.delete(f"/api/v1/safety/zones/{zone['id']}").status_code == 403
    assert (
        client.post(
            f"/api/v1/safety/events/{event['id']}/review",
            json={
                "decision": "rejected",
                "comment": "Не могу принять собственное событие",
            },
        ).status_code
        == 403
    )


@pytest.mark.parametrize(
    "override",
    [
        {"polygon": [[0, 0], [1, 1], [0, 1], [1, 0]]},
        {"polygon": [[0, 0], [0, 0], [1, 1]]},
        {"polygon": [[0, 0], [1.1, 0], [1, 1]]},
        {"site_basis": "          "},
        {"camera_id": str(uuid.uuid4())},
        {"responsible_user_id": str(uuid.uuid4())},
        {"allowed_classes": ["worker"]},
        {"min_duration_seconds": 0},
        {"confidence_threshold": 0.1},
    ],
)
def test_invalid_zone_rejected(env, override):
    client, ids, _, _ = env
    response = client.post(
        f"/api/v1/safety/projects/{ids['project']}/zones",
        json=zone_payload(ids, **override),
    )
    assert response.status_code == 422, response.text


def test_disabled_zone_and_delete_preserves_evidence(env):
    client, ids, state, _ = env
    zone = create(client, ids)
    frame(client, ids, 0)
    frame(client, ids, 4000, 2)
    event = event_list(client, ids)[0]
    assert client.delete(f"/api/v1/safety/zones/{zone['id']}").status_code == 204
    assert frame(client, ids, 8000, 3).json()["safety"]["zones_evaluated"] == 0
    assert client.get(event["evidence_url"]).status_code == 200


def test_model_failure_invalid_image_and_client_boxes(env):
    client, ids, state, _ = env
    create(client, ids)
    state["error"] = True
    assert frame(client, ids, 0).status_code == 502
    state["error"] = False
    state["server_raw"] = b"broken server source"
    assert (
        client.post(
            f"/api/v1/safety/projects/{ids['project']}/analyze-frame",
            data={"camera_id": str(ids["camera"]), "source_id": "x", "position_ms": 0},
            files={"file": ("x.png", b"broken", "image/png")},
        ).status_code
        == 400
    )
    assert event_list(client, ids) == []


def test_migration_seed_is_portable_and_reversible():
    import importlib.util
    from pathlib import Path

    from sqlalchemy import inspect, text

    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    safety_tables = [
        table for table in Base.metadata.sorted_tables if table.name.startswith("safety_")
    ]
    with engine.begin() as connection:
        for table in reversed(safety_tables):
            table.drop(connection)
        path = Path(__file__).parents[1] / "alembic/versions/20261019_1600_safety.py"
        spec = importlib.util.spec_from_file_location("safety_migration", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with Operations.context(MigrationContext.configure(connection)):
            module.upgrade()
            for table in safety_tables:
                actual = {
                    column["name"]
                    for column in inspect(connection).get_columns(table.name)
                }
                assert actual == set(table.columns.keys()), table.name
            assert connection.scalar(text("SELECT count(*) FROM safety_documents")) == 2
            assert (
                connection.scalar(text("SELECT count(*) FROM safety_requirements")) == 5
            )
            assert connection.scalar(text("SELECT count(*) FROM safety_sanctions")) == 3
            module.downgrade()
            assert not any(
                name.startswith("safety_")
                for name in inspect(connection).get_table_names()
            )
    engine.dispose()


def test_authentication_is_required(env):
    client, ids, _, _ = env
    override = app.dependency_overrides.pop(get_current_user)
    try:
        assert client.get("/api/v1/safety/catalog").status_code == 401
        assert (
            client.get(f"/api/v1/safety/projects/{ids['project']}/events").status_code
            == 401
        )
    finally:
        app.dependency_overrides[get_current_user] = override


def test_historical_responsible_and_revoked_membership_never_grant_access(env):
    from app.models.customer_control import OrganizationMembership

    client, ids, state, engine = env
    zone = create(client, ids)
    frame(client, ids, 0)
    frame(client, ids, 4000, 2)
    event = event_list(client, ids)[0]
    assert event["can_review"] is False
    assert (
        client.patch(
            f"/api/v1/safety/zones/{zone['id']}",
            json=zone_payload(ids, responsible_user_id=str(ids["owner"])),
        ).status_code
        == 200
    )
    state["actor"] = "responsible"
    assert client.get(event["evidence_url"]).status_code == 403
    assert client.get(f"/api/v1/safety/events/{event['id']}").status_code == 403
    with Session(engine) as db:
        db.get(OrganizationMembership, ids["responsible_membership"]).status = "revoked"
        db.commit()
    assert client.get(event["evidence_url"]).status_code == 404
    assert client.get(f"/api/v1/safety/events/{event['id']}").status_code == 404
    assert (
        client.post(
            f"/api/v1/safety/events/{event['id']}/review",
            json={
                "decision": "confirmed",
                "comment": "Старое назначение не является правом",
            },
        ).status_code
        == 404
    )


def test_valid_concave_polygon_is_accepted(env):
    client, ids, _, _ = env
    create(
        client,
        ids,
        polygon=[
            [0, 0],
            [0.4, 0],
            [0.4, 0.4],
            [0.6, 0.4],
            [0.6, 0],
            [1, 0],
            [1, 1],
            [0, 1],
        ],
    )


def test_state_cache_is_bounded_without_deleting_event(env):
    from datetime import UTC, datetime, timedelta

    from app.api.v1.safety import prune_state
    from app.models.safety import SafetyEvent, SafetyFrameReceipt, SafetyTrack, SafetyZone

    client, ids, _, engine = env
    zone = create(client, ids)
    frame(client, ids, 0)
    frame(client, ids, 4000, 2)
    with Session(engine) as db:
        z = db.get(SafetyZone, uuid.UUID(zone["id"]))
        for i in range(205):
            db.add(
                SafetyFrameReceipt(
                    zone_id=z.id,
                    source_id="source",
                    image_sha256=str(i).zfill(64),
                    position_ms=5000 + i,
                )
            )
        for i in range(25):
            db.add(
                SafetyTrack(
                    zone_id=z.id,
                    source_id=f"old{i}",
                    state={},
                    touched_at=datetime.now(UTC) - timedelta(days=1),
                )
            )
        prune_state(db, z, "source")
        db.commit()
        assert db.query(SafetyTrack).count() == 20
        assert db.query(SafetyFrameReceipt).filter_by(source_id="source").count() == 200
        assert db.query(SafetyEvent).count() == 1
