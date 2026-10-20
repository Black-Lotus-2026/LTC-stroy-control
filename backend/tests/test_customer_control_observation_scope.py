"""Source observations survive ambiguity without inventing an attributable case."""

import copy
import hashlib
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import func, select

from app.models import Incident
from app.models.customer_control import (
    AuditEvent,
    ControlRelease,
    ControlReleaseItem,
    CoverageConfiguration,
    EvidenceDisclosure,
    IncidentBasis,
    IncidentObservation,
    IncidentRequirementLink,
    ReleaseStatus,
    ResponsibilityArea,
)
from app.models.safety import SafetyEvent, SafetyZone
from app.schemas.recording_analysis import RecordingAnalysisResultDTO
from app.services import recording_analysis as analysis
from app.services.observation_basis import (
    link_pending_safety_events,
    link_safety_incident,
)
from app.workers import recording_tasks
from tests import test_customer_control_http, test_recording_analysis
from tests.customer_control_testdata import approved_requirement
from tests.test_camera_view import jpeg, scene

customer_http = test_customer_control_http.customer_http
env = test_recording_analysis.env
FixtureDetector = test_recording_analysis.FixtureDetector


def test_positive_without_unique_area_is_a_durable_typed_source_result(env, monkeypatch):
    control = approved_requirement(
        env.db,
        env.project,
        env.at,
        zone=env.camera.zone,
        area=env.control.area,
        kind="equipment_forbidden",
        grants=env.control.grants,
    )
    control.revision.area_id = None
    env.asset.area_id = None
    env.db.add(
        ResponsibilityArea(
            project_id=env.project.id,
            zone_id=env.camera.zone_id,
            name="Ambiguous second responsibility area",
        )
    )
    env.db.commit()

    @contextmanager
    def session():
        yield env.db

    monkeypatch.setattr(recording_tasks, "SessionLocal", session)
    monkeypatch.setattr(analysis, "get_detector", lambda: FixtureDetector(present=True))
    result = recording_tasks.analyze_saved_recording_task.run(str(env.asset.id))
    assert result["status"] == "partial" and result["created"] == 0
    assert env.db.scalar(select(func.count()).select_from(Incident)) == 0
    typed = RecordingAnalysisResultDTO.model_validate(env.asset.analysis_result)
    assert typed.technical_observations
    positive = typed.technical_observations[0]
    assert positive.reason == "missing_responsibility_area"
    assert positive.discrepancy_type == "UNCHARACTERISTIC_PRESENT"
    assert (
        positive.source_sha256
        == hashlib.sha256(Path(env.asset.storage_key).read_bytes()).hexdigest()
    )
    assert (
        positive.model_sha256 is None
    )  # A synthetic detector is never assigned a made-up hash.
    assert positive.last_offset_seconds > positive.first_offset_seconds
    assert "Область ответственности" in env.asset.analysis_error


def test_recording_windows_append_once_and_preserve_the_original_basis(env):
    analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=30
    )
    incident = env.db.scalar(select(Incident))
    basis = env.db.scalar(
        select(IncidentBasis).where(IncidentBasis.incident_id == incident.id)
    )
    original = copy.deepcopy(basis.snapshot), basis.sha256
    assert env.db.scalar(select(func.count()).select_from(IncidentRequirementLink)) == 1
    assert env.db.scalar(select(func.count()).select_from(IncidentObservation)) == 1
    analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=60
    )
    observations = list(
        env.db.scalars(
            select(IncidentObservation).order_by(IncidentObservation.observed_until)
        )
    )
    count = len(observations)
    assert count > 1
    assert observations[-1].snapshot["sources"][0]["last_offset_seconds"] == 60
    analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=60
    )
    assert env.db.scalar(select(func.count()).select_from(IncidentObservation)) == count
    assert (basis.snapshot, basis.sha256) == original


@pytest.mark.parametrize("coverage_changes", [False, True])
def test_later_release_observations_use_capture_policy_without_rewriting_the_case_basis(
    env,
    coverage_changes,
):
    transition = env.at + timedelta(seconds=40)
    first_release = env.control.release
    first_release.status = ReleaseStatus.RETIRED
    first_release.effective_until = transition
    current_revision = env.control.revision
    if coverage_changes:
        updated = approved_requirement(
            env.db,
            env.project,
            transition + timedelta(days=1, seconds=-2),
            zone=env.camera.zone,
            area=env.control.area,
            grants=env.control.grants,
        )
        updated.revision.area_id = None
        current_revision, second = updated.revision, updated.release
    else:
        second = ControlRelease(
            project_id=env.project.id,
            sequence=first_release.sequence + 1,
            status=ReleaseStatus.ACTIVE,
            base_release_id=first_release.id,
            submitted_by=env.control.grants.user.id,
            submitted_assignment_id=env.control.grants.assignment.id,
            approved_by=env.control.grants.user.id,
            approved_assignment_id=env.control.grants.assignment.id,
            approved_at=transition,
            effective_from=transition,
            manifest_sha256="c" * 64,
        )
        env.db.add(second)
        env.db.flush()
        env.db.add(
            ControlReleaseItem(release_id=second.id, revision_id=current_revision.id)
        )
    later_coverage = env.coverage
    if coverage_changes:
        env.coverage.effective_until = transition
        later_coverage = CoverageConfiguration(
            project_id=env.project.id,
            area_id=env.control.area.id,
            camera_ids=[str(env.camera.id)],
            approved_by=env.control.grants.user.id,
            effective_from=transition,
            policy_sha256="d" * 64,
        )
        env.db.add(later_coverage)
    env.db.commit()
    analysis.analyze_recording(
        env.db,
        env.asset.id,
        detector=FixtureDetector(),
        max_duration_seconds=30,
    )
    incident = env.db.scalar(select(Incident))
    basis = env.db.scalar(
        select(IncidentBasis).where(IncidentBasis.incident_id == incident.id)
    )
    initial = copy.deepcopy(basis.snapshot), basis.sha256
    assert initial[0]["release_id"] == str(first_release.id)
    assert initial[0]["coverage"]["configuration_id"] == str(env.coverage.id)
    result = analysis.analyze_recording(
        env.db,
        env.asset.id,
        detector=FixtureDetector(),
        max_duration_seconds=80,
    )
    assert result["created"] == 0
    assert env.db.scalar(select(func.count()).select_from(Incident)) == 1
    rows = list(
        env.db.scalars(
            select(IncidentObservation).order_by(IncidentObservation.observed_until)
        )
    )
    later = [row for row in rows if analysis.aware(row.observed_from) >= transition]
    assert later
    assert all(row.snapshot["release_id"] == str(second.id) for row in later)
    assert all(row.snapshot["manifest_sha256"] == second.manifest_sha256 for row in later)
    assert all(
        row.snapshot["coverage"]["configuration_id"] == str(later_coverage.id)
        for row in later
    )
    assert all(
        row.snapshot["citations"][0]["requirement_revision_id"]
        == str(current_revision.id)
        for row in later
    )
    assert all(row.snapshot["sources"][0]["first_offset_seconds"] >= 40 for row in later)
    count = len(rows)
    analysis.analyze_recording(
        env.db,
        env.asset.id,
        detector=FixtureDetector(),
        max_duration_seconds=80,
    )
    assert env.db.scalar(select(func.count()).select_from(IncidentObservation)) == count
    assert (
        env.db.get(IncidentRequirementLink, (incident.id, current_revision.id))
        is not None
    )
    assert env.db.scalar(select(func.count()).select_from(IncidentRequirementLink)) == (
        2 if coverage_changes else 1
    )
    assert env.db.scalar(select(func.count()).select_from(EvidenceDisclosure)) == 0
    assert (basis.snapshot, basis.sha256) == initial


def test_safety_raw_event_is_retained_and_linked_once_after_scope_is_resolved(
    customer_http,
):
    s = customer_http
    at = datetime.now(UTC)
    first, last = jpeg(scene(42)), jpeg(scene(43))
    with s.sessions() as db:
        zone = SafetyZone(
            project_id=s.projects["a"].id,
            camera_id=s.camera.id,
            name="Approved danger area",
            scenario="worker_danger_zone",
            polygon=[[0.1, 0.1], [0.8, 0.1], [0.8, 0.8]],
            site_basis="Original approved plan",
            responsible_user_id=s.users["foreman1"].id,
            created_by=s.users["manager"].id,
        )
        ambiguous = ResponsibilityArea(
            project_id=s.projects["a"].id,
            zone_id=s.zone.id,
            name="Ambiguous area",
        )
        db.add_all([zone, ambiguous])
        db.flush()
        approval = AuditEvent(
            project_id=s.projects["a"].id,
            organization_id=s.participations["customer_a"].organization_id,
            actor_user_id=s.users["manager"].id,
            actor_assignment_id=s.assignments["manager"].id,
            event_type="safety.policy.approved",
            resource_id=zone.id,
            reason="a" * 64,
            occurred_at=at - timedelta(minutes=1),
        )
        db.add(approval)
        db.flush()
        event = SafetyEvent(
            project_id=s.projects["a"].id,
            camera_id=s.camera.id,
            zone_id=zone.id,
            scenario=zone.scenario,
            source_id="verified-source",
            first_position_ms=1000,
            last_position_ms=5000,
            model_sha256="b" * 64,
            evidence_sha256=hashlib.sha256(last).hexdigest(),
            evidence_jpeg=last,
            first_evidence_jpeg=first,
            snapshot={
                "capture_schema_version": 1,
                "policy_event_id": str(approval.id),
                "policy_sha256": approval.reason,
                "observed_from": at.isoformat(),
                "observed_until": (at + timedelta(seconds=4)).isoformat(),
                "observations": 2,
            },
        )
        db.add(event)
        db.flush()
        assert (
            link_safety_incident(
                db,
                event,
                observed_from=at,
                observed_until=at + timedelta(seconds=4),
                policy_event=approval,
            )
            is None
        )
        db.commit()
        assert db.get(SafetyEvent, event.id).evidence_jpeg == last
        assert (
            db.scalar(select(Incident).where(Incident.source_safety_event_id == event.id))
            is None
        )
        db.delete(ambiguous)
        db.commit()
        assert link_pending_safety_events(db) == {"linked": 1}
        db.commit()
        assert link_pending_safety_events(db) == {"linked": 0}
        incident = db.scalar(
            select(Incident).where(Incident.source_safety_event_id == event.id)
        )
        assert incident.area_id == s.area.id
        basis = db.scalar(
            select(IncidentBasis).where(IncidentBasis.incident_id == incident.id)
        )
        assert basis.snapshot["policy_revision_id"] == str(approval.id)
        assert datetime.fromisoformat(basis.snapshot["observed_from"]) == at
        assert db.get(SafetyEvent, event.id).evidence_jpeg == last
