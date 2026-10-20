"""Independent DB/decoder integration checks for project-grounded PPR rules."""

import copy
import hashlib
import uuid
from datetime import timedelta

import pytest
from sqlalchemy import select

from app.models import (
    PprDocument,
    PprRequirement,
    Project,
    User,
    UserRole,
)
from app.models.customer_control import ResponsibilityArea
from app.models.incident import Incident
from app.services import recording_analysis
from app.services.ppr_rules import (
    citations_for_incident,
    ppr_evaluations,
    resolve_ppr_rules,
)
from app.services.rule_engine import RuleEngine
from tests import test_customer_control_http, test_recording_analysis
from tests.customer_control_testdata import approved_requirement, customer_grant

customer_http = test_customer_control_http.customer_http
FixtureDetector = test_recording_analysis.FixtureDetector
env = test_recording_analysis.env


def requirement(db, project, at, *, kind="equipment_required", **overrides):
    from app.models import Zone

    zone = db.scalar(select(Zone).where(Zone.project_id == project.id))
    if zone is None:
        zone = Zone(
            project_id=project.id,
            code="PPR-" + uuid.uuid4().hex[:8],
            name="Synthetic source zone",
        )
        db.add(zone)
        db.flush()
    stage_id = overrides.get("stage_id")
    area = db.scalar(
        select(ResponsibilityArea).where(
            ResponsibilityArea.project_id == project.id,
            ResponsibilityArea.zone_id == zone.id,
            ResponsibilityArea.schedule_task_id == stage_id,
        )
    )
    if area is None:
        area = ResponsibilityArea(
            project_id=project.id,
            name="Synthetic approved PPR scope",
            zone_id=zone.id,
            schedule_task_id=stage_id,
        )
        db.add(area)
        db.flush()
    append = overrides.pop("_append_to_release", False)
    prepared = approved_requirement(
        db, project, at, area=area, kind=kind, replace=not append
    )
    if stage_id is None:
        prepared.revision.area_id = None  # Explicit project-wide synthetic requirement.
    row, page, document = prepared.requirement, prepared.page, prepared.document
    for key, value in overrides.items():
        setattr(row, key, value)
    db.commit()
    return row, page, document


def test_db_project_stage_scope_and_integrity_are_enforced(env):
    db = env.db
    other = Project(code="PRIVATE-PPR", name="Other project")
    db.add(other)
    db.commit()
    requirement(db, other, env.at)
    stage_req, page, _ = requirement(
        db, env.project, env.at, applicability="stage", stage_id=env.stage.id
    )
    assert resolve_ppr_rules(db, env.project.id, None) == ({}, "")
    rules, revision = resolve_ppr_rules(db, env.project.id, env.stage)
    assert set(rules) == {"excavator"}
    assert rules["excavator"]["citations"][0]["requirement_id"] == str(stage_req.id)
    assert revision
    preserved_quote = rules["excavator"]["citations"][0]["quote"]
    page.text = "Несоответствующий текущий кандидат"
    db.commit()
    assert (
        resolve_ppr_rules(db, env.project.id, env.stage)[0]["excavator"]["citations"][0][
            "quote"
        ]
        == preserved_quote
    )
    page.text = stage_req.quote
    page.text_sha256 = hashlib.sha256(page.text.encode()).hexdigest()
    stage_req.project_id = (
        other.id
    )  # An inconsistent foreign project cannot borrow this page.
    db.commit()
    assert (
        resolve_ppr_rules(db, env.project.id, env.stage)[0]["excavator"]["citations"][0][
            "quote"
        ]
        == preserved_quote
    )


def test_conflicting_ppr_suppresses_calendar_rule_but_preserves_other_classes(env):
    requirement(env.db, env.project, env.at)
    requirement(
        env.db, env.project, env.at, kind="equipment_forbidden", _append_to_release=True
    )
    rules, _ = resolve_ppr_rules(env.db, env.project.id, env.stage)
    assert rules["excavator"]["conflict"] is True
    calendar = [
        RuleEngine().evaluate_single_equipment("excavator", 0.95, 0),
        RuleEngine().evaluate_single_equipment("loader", 0.95, 0),
    ]
    evaluated = ppr_evaluations(calendar, rules, [], FixtureDetector())
    assert [item.machinery_name for item in evaluated] == ["Погрузчик"]
    citations, _, error = citations_for_incident(
        env.db, env.project.id, env.stage, "Экскаватор", "MISSING_MANDATORY"
    )
    assert citations == [] and error == "conflict"
    result = recording_analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=60
    )
    assert result["created"] == 0
    assert list(env.db.scalars(select(Incident))) == []


def test_actual_recording_uses_ppr_without_schedule_and_citations_survive_changes(env):
    req, _, _ = requirement(env.db, env.project, env.at)
    env.db.delete(env.stage)
    env.db.commit()
    result = recording_analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=30
    )
    assert result["created"] == 1
    incident = env.db.scalar(select(Incident))
    assert incident.schedule_task_id is None
    assert incident.machinery_type == "Экскаватор"
    citation = incident.explanation["ppr_requirements"][0]
    assert citation["requirement_id"] == str(req.id)
    assert citation["page_number"] == 1 and citation["quote"] == req.quote
    assert f"/projects/{env.project.id}/" in citation["source_url"]
    assert len(incident.explanation["album_photos"]) == 2
    saved = copy.deepcopy(incident.explanation["ppr_requirements"])
    replay = recording_analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=30
    )
    assert replay["created"] == 0
    assert len(list(env.db.scalars(select(Incident)))) == 1
    req.active = False
    req.title = "Изменённое текущее требование"
    env.db.commit()
    recording_analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=30
    )
    env.db.refresh(incident)
    assert incident.explanation["ppr_requirements"] == saved


def test_live_and_worker_share_ppr_dedup_signature(env):
    from app.api.v1.incidents import create_incident
    from app.schemas.stroy_control import IncidentCreateRequest

    requirement(env.db, env.project, env.at)
    recording_analysis.analyze_recording(
        env.db, env.asset.id, detector=FixtureDetector(), max_duration_seconds=30
    )
    stored = env.db.scalar(select(Incident))
    _, revision = resolve_ppr_rules(env.db, env.project.id, env.stage)
    user = User(username="ppr-test", name="PPR test", role=UserRole.ADMIN)
    env.db.add(user)
    env.db.flush()
    customer_grant(env.db, env.project, user)
    env.db.commit()
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as denied:
        create_incident(
            IncidentCreateRequest(
                project_id=env.project.id,
                zone_id=env.camera.zone_id,
                camera_id=env.camera.id,
                stage_id=env.stage.id,
                machinery_type="Экскаватор",
                discrepancy_type="MISSING_MANDATORY",
                title="Explicit fixture observation",
                description="Synthetic fixture",
                captured_at=env.at + timedelta(seconds=30),
                ppr_revision=revision,
                observation_key="independent-live-observation",
            ),
            env.db,
            user,
        )
    assert denied.value.status_code == 409
    assert len(list(env.db.scalars(select(Incident)))) == 1
    saved = copy.deepcopy(stored.explanation["ppr_requirements"])
    assert saved[0]["source_url"].startswith(f"/api/v1/projects/{env.project.id}/")
    assert "analysis_id=" in saved[0]["source_url"]


def test_forbidden_ppr_replaces_mandatory_calendar_with_observed_prohibition(env):
    req, _, _ = requirement(env.db, env.project, env.at, kind="equipment_forbidden")
    result = recording_analysis.analyze_recording(
        env.db,
        env.asset.id,
        detector=FixtureDetector(present=True),
        max_duration_seconds=30,
    )
    assert result["created"] == 1
    incident = env.db.scalar(select(Incident))
    assert incident.discrepancy_type == "UNCHARACTERISTIC_PRESENT"
    assert incident.explanation["ppr_requirements"][0]["requirement_id"] == str(req.id)
    assert "запрещённая" in incident.description


def test_ppr_absence_never_borrows_across_failed_inference(env):
    requirement(env.db, env.project, env.at)
    env.db.delete(env.stage)
    env.db.commit()
    result = recording_analysis.analyze_recording(
        env.db,
        env.asset.id,
        detector=FixtureDetector(failure_at=3),
        max_duration_seconds=50,
    )
    assert result["failed_samples"] == 1
    assert result["created"] == 0
    assert list(env.db.scalars(select(Incident))) == []


@pytest.mark.parametrize(
    "change", ["deactivated", "missing_revision", "outdated_revision"]
)
def test_live_stale_ppr_observations_are_rejected_without_creating_generic_events(
    env, change
):
    from fastapi import HTTPException

    from app.api.v1.incidents import create_incident
    from app.schemas.stroy_control import IncidentCreateRequest

    row, _, _ = requirement(env.db, env.project, env.at)
    _, previous_revision = resolve_ppr_rules(env.db, env.project.id, env.stage)
    user = User(username="revision-admin", name="Revision test", role=UserRole.ADMIN)
    env.db.add(user)
    env.db.flush()
    customer_grant(env.db, env.project, user)
    if change == "deactivated":
        row.active = False
    env.db.commit()
    revision = (
        None
        if change == "missing_revision"
        else "outdated"
        if change == "outdated_revision"
        else previous_revision
    )
    request = IncidentCreateRequest(
        project_id=env.project.id,
        zone_id=env.camera.zone_id,
        camera_id=env.camera.id,
        stage_id=env.stage.id,
        machinery_type="Экскаватор",
        discrepancy_type="MISSING_MANDATORY",
        title="Stale fixture must not persist",
        description="Synthetic fixture",
        captured_at=env.at + timedelta(seconds=30),
        ppr_revision=revision,
    )
    with pytest.raises(HTTPException) as error:
        create_incident(request, env.db, user)
    assert error.value.status_code == 409
    assert list(env.db.scalars(select(Incident))) == []
    assert not env.db.new


def test_assigned_event_source_grants_exact_page_without_private_library_access(
    customer_http,
):
    from app.models.customer_control import EvidenceDisclosure
    from app.services.control_releases import active_equipment_revisions
    from app.services.ppr_analysis import requirement_citation

    state = customer_http
    with state.sessions() as db:
        project = db.get(Project, state.projects["a"].id)
        grants = customer_grant(db, project, db.get(User, state.users["manager"].id))
        prepared = approved_requirement(
            db,
            project,
            state.incidents["k1"].first_seen_at,
            area=db.get(ResponsibilityArea, state.area.id),
            grants=grants,
        )
        prepared.revision.area_id = None
        db.flush()
        adapter = active_equipment_revisions(db, project.id)[0]
        citation = requirement_citation(db, adapter)
        incident = db.get(Incident, state.incidents["k1"].id)
        incident.explanation = {"ppr_requirements": [citation]}
        db.add(
            EvidenceDisclosure(
                project_id=project.id,
                participation_id=state.participations["k1"].id,
                incident_id=incident.id,
                revision_id=prepared.revision.id,
                area_id=state.area.id,
            )
        )
        db.commit()
        document, req, page = prepared.document, prepared.requirement, prepared.page
    source_bytes = (state.root / "documents" / page.preview_key).read_bytes()
    base = f"/api/v1/projects/{project.id}/ppr-documents"
    source = f"/api/v1/incidents/{incident.id}/ppr-sources/{req.id}"
    revision = f"/api/v1/projects/{project.id}/ppr-control-revision"
    assert state.client.get(source).status_code == 401
    headers = state.headers("foreman1")
    response = state.client.get(source, headers=headers)
    assert response.status_code == 200, response.text
    assert response.content == source_bytes
    assert response.headers["x-ppr-page"] == "1"
    assert response.headers["x-ppr-document-sha256"] == document.sha256
    assert response.headers["cache-control"] == "private, no-store"
    library = state.client.get(base, headers=headers)
    assert library.status_code == 200
    assert str(document.id) not in {item["id"] for item in library.json()}
    assert (
        state.client.get(f"{base}/{document.id}/original", headers=headers).status_code
        == 404
    )
    assert (
        state.client.get(
            f"{base}/{document.id}/pages/2/original", headers=headers
        ).status_code
        == 404
    )
    assert (
        state.client.get(
            source.replace(str(req.id), str(uuid.uuid4())), headers=headers
        ).status_code
        == 404
    )
    assert state.client.get(source, headers=state.headers("foreman2")).status_code == 404
    customer = state.headers("manager")
    first_revision = state.client.get(revision, headers=customer)
    assert first_revision.status_code == 200 and first_revision.json()["revision"]
    with state.sessions() as db:
        db.get(PprRequirement, req.id).active = False
        db.commit()
    assert state.client.get(revision, headers=customer).json() == first_revision.json()
    assert state.client.get(source, headers=headers).content == source_bytes
    with state.sessions() as db:
        disclosure = db.scalar(
            select(EvidenceDisclosure).where(
                EvidenceDisclosure.incident_id == incident.id,
                EvidenceDisclosure.revision_id == prepared.revision.id,
            )
        )
        disclosure.active = False
        db.commit()
    assert state.client.get(source, headers=headers).status_code == 404
    with state.sessions() as db:
        db.get(EvidenceDisclosure, disclosure.id).active = True
        db.commit()
    page_path = state.root / "documents" / page.preview_key
    page_path.write_bytes(b"%PDF-1.4\nsynthetic altered historical page")
    assert state.client.get(source, headers=headers).status_code == 404
    page_path.write_bytes(source_bytes)
    assert state.client.get(source, headers=headers).content == source_bytes
    with state.sessions() as db:
        db.get(PprDocument, document.id).sha256 = "0" * 64
        db.commit()
    assert state.client.get(source, headers=headers).status_code == 404
