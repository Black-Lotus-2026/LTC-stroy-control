"""Real OpenCV decoding/storage/DB, with explicitly synthetic detector fixtures."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import cv2
import numpy as np
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.base import Base
from app.models.customer_control import CoverageConfiguration
from app.models.enums import IncidentPriority, IncidentStatus
from app.models.incident import Incident
from app.models.project import Camera, Project, Zone
from app.models.schedule import ScheduleTask
from app.models.video import VideoAsset
from app.services import recording_analysis as analysis
from app.services.rule_engine import RuleEngine
from app.storage.local import LocalStorage
from tests.customer_control_testdata import approved_requirement


@compiles(JSONB, "sqlite")
def jsonb_sqlite(*args, **kwargs):
    return "JSON"


@pytest.fixture
def env(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    storage = LocalStorage(tmp_path / "media", "/media")
    monkeypatch.setattr(settings, "storage_local_root", tmp_path / "media")
    monkeypatch.setattr(settings, "ppr_storage_root", tmp_path / "private-ppr")
    monkeypatch.setattr(analysis, "get_storage", lambda: storage)
    monkeypatch.setattr("app.storage.get_storage", lambda: storage)
    # This decoder/dedup suite supplies an explicit synthetic reference validator;
    # real view/loop quality is independently covered by camera/HTTP regressions.
    monkeypatch.setattr(analysis, "camera_frame_quality", lambda *args: True)
    with Session(engine, expire_on_commit=False) as db:
        project = Project(code="MANAGEMENT-DEMO", name="Synthetic integration fixture")
        db.add(project)
        db.flush()
        zone = Zone(project_id=project.id, code="TEST", name="Fixture zone")
        db.add(zone)
        db.flush()
        camera = Camera(
            project_id=project.id, zone_id=zone.id, code="TEST", name="Fixture camera"
        )
        db.add(camera)
        db.flush()
        at = datetime(2026, 10, 19, 7, 19, 26, tzinfo=UTC)
        stage = ScheduleTask(
            project_id=project.id,
            zone_id=zone.id,
            name="Fixture stage",
            planned_start=at - timedelta(days=1),
            planned_end=at + timedelta(days=1),
            machinery_probabilities={"Экскаватор": 0.95, "Автогрейдер": 0.99},
        )
        db.add(stage)
        path = tmp_path / "fixture.avi"
        writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), 1, (64, 48))
        assert writer.isOpened()
        for value in range(81):
            writer.write(np.full((48, 64, 3), value, dtype=np.uint8))
        writer.release()
        asset = VideoAsset(
            project_id=project.id,
            camera_id=camera.id,
            filename="fixture.avi",
            storage_key=str(path),
            start_timestamp=at,
            status="READY",
            fps=1,
            frame_count=81,
            duration_seconds=81,
        )
        db.add(asset)
        db.flush()
        control = approved_requirement(db, project, at, zone=zone)
        control.revision.area_id = None  # The fixture quote applies to the whole project.
        asset.area_id = control.area.id
        coverage = CoverageConfiguration(
            project_id=project.id,
            area_id=control.area.id,
            camera_ids=[str(camera.id)],
            approved_by=control.grants.user.id,
            effective_from=at - timedelta(days=1),
            policy_sha256="a" * 64,
        )
        db.add(coverage)
        db.commit()
        yield SimpleNamespace(
            db=db,
            asset=asset,
            project=project,
            camera=camera,
            stage=stage,
            at=at,
            storage=storage,
            control=control,
            coverage=coverage,
        )
    engine.dispose()


class FixtureDetector:
    is_ready = True
    compliance_enabled = True
    sha256 = "explicit-test-double-not-real-model"

    def __init__(self, present=False, failure_at=None):
        self.present = present
        self.failure_at = failure_at
        self.calls = 0

    def detect_frame(self, jpeg):
        self.calls += 1
        if self.calls == self.failure_at:
            raise RuntimeError("Explicit fixture inference failure")
        return ["excavator"] if self.present else []

    def can_evaluate(self, name):
        return name in {"Экскаватор", "excavator"}

    def evaluate_rules(self, probabilities, detections):
        return [
            RuleEngine().evaluate_single_equipment(name, value, int(bool(detections)))
            for name, value in probabilities.items()
            if self.can_evaluate(name)
        ]


def incidents(env):
    return list(env.db.scalars(select(Incident)))


def test_actual_decode_window_persistence_evidence_and_idempotence(env):
    short = analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=20
    )
    assert short["samples"] == 3 and short["created"] == 0 and short["prefix_only"]
    result = analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=30
    )
    assert result["created"] == 1
    item = incidents(env)[0]
    assert item.status == IncidentStatus.PENDING
    assert item.priority == IncidentPriority.MEDIUM
    assert analysis.aware(item.first_seen_at) == env.at
    assert analysis.aware(item.last_seen_at) == env.at + timedelta(seconds=30)
    assert item.camera_id == env.camera.id and item.zone_id == env.camera.zone_id
    assert item.explanation["quality_verified"] is False
    assert item.explanation["review_required"] is True
    assert len(item.explanation["album_photos"]) == 2
    for photo in item.explanation["album_photos"]:
        contents = env.storage.load(photo["url"].removeprefix("/media/"))
        assert contents.startswith(b"\xff\xd8")
    before = item.observation_count
    repeat = analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=30
    )
    assert repeat["created"] == 0 and len(incidents(env)) == 1
    assert item.observation_count == before
    analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=60
    )
    assert len(incidents(env)) == 1
    assert item.priority == IncidentPriority.CRITICAL
    assert item.explanation["severity"] == "error"
    assert analysis.aware(item.last_seen_at) == env.at + timedelta(seconds=60)


def test_inference_failure_breaks_absence_window_but_success_empty_can_create(env):
    result = analysis.analyze_recording(
        env.db,
        env.asset.id,
        detector=FixtureDetector(failure_at=3),
        max_duration_seconds=50,
    )
    assert result["failed_samples"] == 1 and result["status"] == "partial"
    assert incidents(env) == []
    result = analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=30
    )
    assert result["created"] == 1


def test_actual_decode_failure_breaks_absence_window(env, monkeypatch):
    original = cv2.VideoCapture

    class Capture:
        def __init__(self, path):
            self.real = original(path)
            self.n = 0

        def __getattr__(self, key):
            return getattr(self.real, key)

        def read(self):
            self.n += 1
            if self.n == 3:
                return False, None
            return self.real.read()

    monkeypatch.setattr(cv2, "VideoCapture", Capture)
    result = analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=50
    )
    assert result["failed_samples"] == 1 and incidents(env) == []


def test_presence_prevents_missing_and_persistent_unexpected_creates(env):
    detector = FixtureDetector(present=True)
    assert (
        analysis.analyze_recording(
            env.db, env.asset.id, detector=detector, max_duration_seconds=60
        )["created"]
        == 0
    )
    env.stage.machinery_probabilities = {"Экскаватор": 0.01}
    env.control = approved_requirement(
        env.db,
        env.project,
        env.at,
        area=env.control.area,
        grants=env.control.grants,
        kind="equipment_forbidden",
    )
    env.db.commit()
    assert (
        analysis.analyze_recording(
            env.db, env.asset.id, detector=detector, max_duration_seconds=30
        )["created"]
        == 1
    )
    assert incidents(env)[0].discrepancy_type == "UNCHARACTERISTIC_PRESENT"


@pytest.mark.parametrize(
    "mode", ["disabled", "outside_shift", "unsupported", "stage_boundary", "wrong_camera"]
)
def test_permissions_and_temporal_context_fail_closed(env, mode):
    detector = FixtureDetector()
    if mode == "disabled":
        detector.compliance_enabled = False
    elif mode == "outside_shift":
        env.asset.start_timestamp = env.at.replace(hour=0)
    elif mode == "unsupported":
        env.stage.machinery_probabilities = {"Автогрейдер": 0.99}
        detector.can_evaluate = lambda name: False
    elif mode == "stage_boundary":
        env.stage.planned_end = env.at + timedelta(seconds=20)
        env.db.add(
            ScheduleTask(
                project_id=env.project.id,
                name="Second fixture stage",
                planned_start=env.at + timedelta(seconds=21),
                planned_end=env.at + timedelta(seconds=120),
                machinery_probabilities={"Экскаватор": 0.99},
            )
        )
    elif mode == "wrong_camera":
        other = Project(code="OTHER", name="Other fixture")
        env.db.add(other)
        env.db.flush()
        env.camera.project_id = other.id
    env.db.commit()
    if mode == "wrong_camera":
        with pytest.raises(ValueError, match="camera"):
            analysis.analyze_recording(env.db, env.asset.id, detector=detector)
    else:
        analysis.analyze_recording(
            env.db, env.asset.id, detector=detector, max_duration_seconds=40
        )
    assert incidents(env) == []


def test_pending_scanner_claims_once_and_recovers_publish_failure(env, monkeypatch):
    from app.workers.recording_tasks import enqueue_pending_recordings

    monkeypatch.setattr(settings, "construction_policy", "enforce")
    monkeypatch.setattr(settings, "construction_approved_classes", ["excavator"])
    sent = []
    assert enqueue_pending_recordings(env.db, sent.append) == {"queued": 1}
    assert env.asset.analysis_status == "QUEUED"
    assert enqueue_pending_recordings(env.db, sent.append) == {"queued": 0}
    assert sent == [str(env.asset.id)]
    env.asset.analysis_status = "PENDING"
    env.db.commit()

    def failed_publish(_):
        raise ConnectionError("Explicit fixture broker failure")

    assert enqueue_pending_recordings(env.db, failed_publish) == {"queued": 0}
    assert env.asset.analysis_status == "PENDING"


def test_task_prefix_is_pending_full_is_completed_and_failure_is_durable(
    env, monkeypatch
):
    from contextlib import contextmanager

    from app.workers import recording_tasks

    @contextmanager
    def session():
        yield env.db

    monkeypatch.setattr(recording_tasks, "SessionLocal", session)
    monkeypatch.setattr(analysis, "get_detector", FixtureDetector)
    result = recording_tasks.analyze_saved_recording_task.run(str(env.asset.id), 30)
    assert result["prefix_only"] is True
    assert env.asset.analysis_status == "PENDING"
    assert env.asset.analyzed_at is None
    result = recording_tasks.analyze_saved_recording_task.run(str(env.asset.id))
    assert result["prefix_only"] is False
    assert env.asset.analysis_status == "COMPLETED"
    assert env.asset.analyzed_at is not None
    assert recording_tasks.analyze_saved_recording_task.run(str(env.asset.id)) == {
        "status": "already_claimed"
    }
    env.asset.analysis_status = "PENDING"
    env.asset.storage_key = "/nonexistent-explicit-test-recording"
    env.db.commit()
    with pytest.raises(ValueError, match="missing"):
        recording_tasks.analyze_saved_recording_task.run(str(env.asset.id))
    assert env.asset.analysis_status == "FAILED"
    assert env.asset.analysis_error == "Ошибка обработки записи: ValueError"


def test_scanner_recovers_stale_running_lease_but_leaves_active_claim(env, monkeypatch):
    from app.workers.recording_tasks import enqueue_pending_recordings

    monkeypatch.setattr(settings, "construction_policy", "enforce")
    monkeypatch.setattr(settings, "construction_approved_classes", ["excavator"])
    env.asset.analysis_status = "RUNNING"
    env.asset.analysis_updated_at = datetime.now(UTC)
    env.db.commit()
    sent = []
    assert enqueue_pending_recordings(env.db, sent.append) == {"queued": 0}
    env.asset.analysis_updated_at = datetime.now(UTC) - timedelta(minutes=16)
    env.db.commit()
    assert enqueue_pending_recordings(env.db, sent.append) == {"queued": 1}
    assert env.asset.analysis_status == "QUEUED"


def add_companion(env, *, missing=False, required=True):
    camera = Camera(
        project_id=env.project.id,
        zone_id=env.camera.zone_id,
        code="SECOND",
        name="Second synthetic viewpoint",
    )
    env.db.add(camera)
    env.db.flush()
    asset = VideoAsset(
        project_id=env.project.id,
        camera_id=camera.id,
        filename="second-fixture.avi",
        storage_key="/missing-explicit-companion" if missing else env.asset.storage_key,
        start_timestamp=env.asset.start_timestamp,
        status="READY",
        duration_seconds=env.asset.duration_seconds,
        fps=1,
        frame_count=81,
    )
    env.db.add(asset)
    if required:
        env.coverage.camera_ids = [*env.coverage.camera_ids, str(camera.id)]
    env.db.commit()
    return asset


def test_companion_presence_prevents_false_missing_on_other_viewpoint(env):
    add_companion(env)

    class CompanionPresent(FixtureDetector):
        def detect_frame(self, jpeg):
            self.calls += 1
            # First view empty; the second view actually supplies the fixture observation.
            return ["excavator"] if self.calls % 2 == 0 else []

    result = analysis.analyze_recording(
        env.db, env.asset.id, detector=CompanionPresent(), max_duration_seconds=60
    )
    assert result["failed_samples"] == 0
    assert incidents(env) == []


@pytest.mark.parametrize("failure", ["file", "inference"])
def test_failed_companion_never_authorizes_absence_but_positive_can_persist(env, failure):
    add_companion(env, missing=failure == "file")

    class CompanionFailure(FixtureDetector):
        def detect_frame(self, jpeg):
            self.calls += 1
            if failure == "inference" and self.calls % 2 == 0:
                raise RuntimeError("Explicit companion inference failure")
            return ["excavator"] if self.present else []

    result = analysis.analyze_recording(
        env.db, env.asset.id, detector=CompanionFailure(), max_duration_seconds=40
    )
    assert result["status"] == "partial" and result["failed_samples"] > 0
    assert incidents(env) == []
    env.stage.machinery_probabilities = {"Экскаватор": 0.01}
    env.control = approved_requirement(
        env.db,
        env.project,
        env.at,
        area=env.control.area,
        grants=env.control.grants,
        kind="equipment_forbidden",
    )
    env.db.commit()
    positive = analysis.analyze_recording(
        env.db,
        env.asset.id,
        detector=CompanionFailure(present=True),
        max_duration_seconds=30,
    )
    assert positive["created"] == 1
    assert incidents(env)[0].discrepancy_type == "UNCHARACTERISTIC_PRESENT"


def test_all_views_empty_valid_window_creates_multi_angle_evidence(env):
    other = add_companion(env)
    result = analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=30
    )
    assert result["created"] == 1 and result["failed_samples"] == 0
    item = incidents(env)[0]
    assert len(item.explanation["album_photos"]) == 4
    assert set(item.explanation["sources_evaluated"]) == {
        env.asset.filename,
        other.filename,
    }
    for photo in item.explanation["album_photos"]:
        assert env.storage.load(photo["url"].removeprefix("/media/")).startswith(
            b"\xff\xd8"
        )
    repeat_other = analysis.analyze_recording(
        env.db, other.id, detector=FixtureDetector(), max_duration_seconds=30
    )
    assert repeat_other["created"] == 0 and len(incidents(env)) == 1


def test_staggered_companion_start_cannot_borrow_prior_single_view_coverage(env):
    other = add_companion(env)
    other.start_timestamp = env.at + timedelta(seconds=20)
    env.db.commit()
    short = analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=40
    )
    assert short["created"] == 0
    mature = analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=50
    )
    assert mature["created"] == 1
    item = incidents(env)[0]
    assert analysis.aware(item.first_seen_at) == env.at + timedelta(seconds=20)
    assert set(item.explanation["sources_evaluated"]) == {
        env.asset.filename,
        other.filename,
    }


def test_other_zone_viewpoint_cannot_hide_missing_machine_in_this_zone(env):
    other = add_companion(env, required=False)
    zone = Zone(project_id=env.project.id, code="OTHER", name="Other fixture zone")
    env.db.add(zone)
    env.db.flush()
    env.db.get(Camera, other.camera_id).zone_id = zone.id
    env.db.commit()
    result = analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=30
    )
    assert result["created"] == 1
    assert incidents(env)[0].explanation["sources_evaluated"] == [env.asset.filename]


def test_unlinked_upload_cannot_infer_absence_without_approved_camera_coverage(env):
    env.asset.camera_id = None
    env.db.commit()
    result = analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=30
    )
    assert result["created"] == 0
    assert result["insufficient_samples"] > 0
    assert incidents(env) == []


def test_human_resolved_episode_stays_closed_when_same_recording_is_replayed(env):
    analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=30
    )
    item = incidents(env)[0]
    identifier = item.id
    before_count = item.observation_count
    before_photos = [dict(photo) for photo in item.explanation["album_photos"]]
    item.status = IncidentStatus.RESOLVED
    env.db.commit()
    repeated = analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=60
    )
    assert repeated["created"] == 0
    assert [row.id for row in incidents(env)] == [identifier]
    assert item.status == IncidentStatus.RESOLVED
    assert item.observation_count == before_count
    assert item.explanation["album_photos"] == before_photos
    assert analysis.aware(item.last_seen_at) == env.at + timedelta(seconds=30)


def test_clear_positive_gap_allows_later_new_absence_after_resolved_episode(env):
    analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=30
    )
    first = incidents(env)[0]
    first.status = IncidentStatus.RESOLVED
    env.db.commit()

    class GapDetector(FixtureDetector):
        def detect_frame(self, jpeg):
            self.calls += 1
            return ["excavator"] if self.calls == 5 else []  # Positive at second 40.

    repeated = analysis.analyze_recording(
        env.db, env.asset.id, detector=GapDetector(), max_duration_seconds=80
    )
    assert repeated["created"] == 1 and len(incidents(env)) == 2
    new = next(row for row in incidents(env) if row.id != first.id)
    assert new.status == IncidentStatus.PENDING
    assert analysis.aware(new.first_seen_at) == env.at + timedelta(seconds=50)
    assert first.status == IncidentStatus.RESOLVED


def test_both_passes_count_unique_samples_and_confirmation_never_regresses(env):
    other = add_companion(env)
    analysis.analyze_recording(
        env.db, other.id, detector=FixtureDetector(), max_duration_seconds=60
    )
    item = incidents(env)[0]
    assert item.observation_count == 7
    photos = [dict(photo) for photo in item.explanation["album_photos"]]
    analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=30
    )
    assert item.observation_count == 7
    assert datetime.fromisoformat(
        item.explanation["last_confirmed_at"]
    ) == env.at + timedelta(seconds=60)
    assert item.explanation["album_photos"] == photos
    analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=70
    )
    assert item.observation_count == 8
    assert len(incidents(env)) == 1


@pytest.mark.parametrize("damage", ["missing", "corrupt", "wrong_hash"])
def test_existing_evidence_repair_uses_real_frames_and_preserves_healthy_photo(
    env, damage
):
    analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=30
    )
    item = incidents(env)[0]
    explanation = dict(item.explanation)
    photos = [dict(photo) for photo in explanation["album_photos"]]
    healthy_photo = dict(photos[0])
    healthy_key = healthy_photo["url"].removeprefix("/media/")
    healthy_bytes = env.storage.load(healthy_key)
    broken_key = photos[1]["url"].removeprefix("/media/")
    if damage == "missing":
        env.storage.delete(broken_key)
    elif damage == "corrupt":
        env.storage.save(broken_key, b"explicit corrupt fixture; not an image")
    else:
        photos[1]["sha256"] = "wrong fixture hash"
    explanation["album_photos"] = photos
    item.explanation = explanation
    env.db.commit()
    result = analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=30
    )
    assert result["created"] == 0 and len(incidents(env)) == 1
    assert env.storage.load(healthy_key) == healthy_bytes
    assert any(
        photo["url"] == healthy_photo["url"] for photo in item.explanation["album_photos"]
    )
    assert all(
        analysis._healthy_photo(photo, env.storage)
        for photo in item.explanation["album_photos"]
    )
    assert any(
        photo["url"] == item.explanation["snapshot_url"]
        for photo in item.explanation["album_photos"]
    )
    assert item.explanation["evidence_repaired_at"]


def test_album_can_be_restored_on_existing_closed_card_without_reopening(env):
    analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=30
    )
    item = incidents(env)[0]
    item.status = IncidentStatus.FALSE_POSITIVE
    exp = dict(item.explanation)
    exp["album_photos"] = []
    exp["snapshot_url"] = None
    item.explanation = exp
    env.db.commit()
    analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=30
    )
    assert len(incidents(env)) == 1 and item.status == IncidentStatus.FALSE_POSITIVE
    assert len(item.explanation["album_photos"]) == 2


def test_cached_session_refreshes_other_pass_buckets_and_human_decision(env):
    other = add_companion(env)
    analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=30
    )
    item = incidents(env)[
        0
    ]  # Keep this ORM identity cached across another session's commit.
    assert item.observation_count == 4
    with Session(env.db.get_bind(), expire_on_commit=False) as second:
        analysis.analyze_recording(
            second, other.id, detector=FixtureDetector(), max_duration_seconds=40
        )
    assert (
        item.observation_count == 4
    )  # Deliberately stale before refreshed locking query.
    analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=30
    )
    assert item.observation_count == 5
    with Session(env.db.get_bind(), expire_on_commit=False) as second:
        changed = second.get(Incident, item.id)
        changed.status = IncidentStatus.RESOLVED
        second.commit()
    assert item.status == IncidentStatus.PENDING  # Cached identity is still stale.
    replay = analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=30
    )
    assert replay["created"] == 0
    assert item.status == IncidentStatus.RESOLVED
    assert len(incidents(env)) == 1


def test_healthy_single_view_album_adds_missing_real_companion_once(env):
    other = add_companion(env)
    analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=30
    )
    item = incidents(env)[0]
    exp = dict(item.explanation)
    primary = next(
        dict(photo)
        for photo in exp["album_photos"]
        if photo["camera_name"] == env.asset.filename and photo["is_primary"]
    )
    exp["album_photos"] = [primary]
    exp["snapshot_url"] = primary["url"]
    item.explanation = exp
    env.db.commit()
    primary_bytes = env.storage.load(primary["url"].removeprefix("/media/"))
    analysis.analyze_recording(
        env.db, other.id, detector=FixtureDetector(), max_duration_seconds=30
    )
    assert {photo["camera_name"] for photo in item.explanation["album_photos"]} == {
        env.asset.filename,
        other.filename,
    }
    assert any(
        photo["url"] == primary["url"] for photo in item.explanation["album_photos"]
    )
    assert env.storage.load(primary["url"].removeprefix("/media/")) == primary_bytes
    repaired = [dict(photo) for photo in item.explanation["album_photos"]]
    analysis.analyze_recording(
        env.db, other.id, detector=FixtureDetector(), max_duration_seconds=30
    )
    assert item.explanation["album_photos"] == repaired
