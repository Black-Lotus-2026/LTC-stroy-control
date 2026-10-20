"""Isolated HTTP/persistence/worker checks. No real broker, LLM, or user database."""

from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace
from uuid import UUID, uuid4, uuid5

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, func, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_current_user
from app.api.v1.alerts import router as alerts_router
from app.api.v1.incidents import router as incident_router
from app.api.v1.management import router
from app.api.v1.schedule import router as schedule_router
from app.db.base import Base, utcnow
from app.db.session import get_db
from app.models import (
    AnalysisRun,
    AnalysisStatus,
    Camera,
    CostRate,
    Detection,
    Frame,
    Incident,
    IncidentEvent,
    ObjectCategory,
    ObjectClass,
    Project,
    RuleKind,
    RuleSet,
    ScheduleTask,
    User,
    UserRole,
    WorkRequirement,
    WorkType,
    Zone,
)
from app.models.customer_control import (
    ProjectAssignment,
    ProjectDeadlinePolicy,
    ProjectRole,
)
from app.models.management import ManagementRun, ManagementRunStep, TaskDependency
from app.services.alert_service import assign_initial_alert, request_verification
from app.services.management.agents.provider import OpenRouterProvider
from app.services.management.demo import AS_OF, make_demo_snapshot
from app.services.management.orchestrator import execute_run
from app.workers.management_tasks import analyze_management_run
from tests.customer_control_testdata import customer_grant


@compiles(JSONB, "sqlite")
def compile_jsonb_sqlite(type_, compiler, **kw):
    return "JSON"


@pytest.fixture
def api(monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )

    @event.listens_for(engine, "connect")
    def foreign_keys(connection, record):
        connection.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as db:
        owner = User(
            id=uuid4(), username="management-owner", name="Owner", role=UserRole.MANAGER
        )
        outsider = User(
            id=uuid4(),
            username="management-outsider",
            name="Outsider",
            role=UserRole.MANAGER,
        )
        db.add_all([owner, outsider])
        db.flush()
        projects = [
            Project(
                id=uuid4(),
                code=f"management-test-{i}",
                name=f"Project {i}",
                owner_username=owner.username if i < 2 else outsider.username,
            )
            for i in range(3)
        ]
        db.add_all(projects)
        db.flush()
        for index, project in enumerate(projects):
            grant = customer_grant(db, project, owner if index < 2 else outsider)
            db.add(
                ProjectDeadlinePolicy(
                    project_id=project.id,
                    version=1,
                    approved_by=grant.user.id,
                    approved_assignment_id=grant.assignment.id,
                    effective_from=AS_OF,
                    reaction_minutes=60,
                    remediation_minutes=120,
                    review_minutes=180,
                    reason="Explicit synthetic policy for isolated tests",
                )
            )
        zones, cameras, frames = [], [], []
        for index, project in enumerate(projects):
            zone = Zone(
                id=uuid5(project.id, "management-demo-zone"),
                project_id=project.id,
                code=f"zone-{index}",
                name=f"Zone {index}",
            )
            db.add(zone)
            db.flush()
            camera = Camera(
                id=uuid5(project.id, "management-demo-camera-1"),
                project_id=project.id,
                zone_id=zone.id,
                code=f"camera-{index}",
                name=f"Camera {index}",
            )
            db.add(camera)
            db.flush()
            frame = Frame(
                id=uuid4(),
                project_id=project.id,
                camera_id=camera.id,
                zone_id=zone.id,
                storage_key=f"test-only/{index}.jpg",
                captured_at=AS_OF - timedelta(minutes=5),
                received_at=AS_OF,
            )
            db.add(frame)
            zones.append(zone)
            cameras.append(camera)
            frames.append(frame)
        work_type = WorkType(id=uuid4(), code="earthworks", name="Earthworks")
        object_class = ObjectClass(
            id=uuid4(),
            code="dump_truck",
            name="Dump truck",
            category=ObjectCategory.EQUIPMENT,
            detector_labels=["truck"],
            default_confidence_threshold=0.5,
        )
        db.add_all([work_type, object_class])
        db.flush()
        saved_tasks, rule_sets, cost_rates = [], [], []
        for index, project in enumerate(projects):
            task = ScheduleTask(
                id=uuid4(),
                project_id=project.id,
                zone_id=zones[index].id,
                work_type_id=work_type.id,
                name=f"Saved task {index}",
                planned_start=AS_OF - timedelta(days=1),
                planned_end=AS_OF + timedelta(days=1),
            )
            rule_set = RuleSet(
                id=uuid4(),
                project_id=project.id,
                name=f"Rules {index}",
                version="stored-v2",
                is_active=True,
            )
            rate = CostRate(
                id=uuid4(),
                project_id=project.id,
                object_class_id=object_class.id,
                rate_per_hour=Decimal("4321.00"),
                currency="RUB",
                valid_from=AS_OF - timedelta(days=1),
            )
            db.add_all([task, rule_set, rate])
            db.flush()
            requirement = WorkRequirement(
                rule_set_id=rule_set.id,
                work_type_id=work_type.id,
                object_class_id=object_class.id,
                kind=RuleKind.REQUIRED,
                min_count=1,
                confidence_threshold=0.9,
            )
            db.add(requirement)
            saved_tasks.append(task)
            rule_sets.append(rule_set)
            cost_rates.append(rate)
        db.commit()
    state = SimpleNamespace(
        factory=factory,
        owner=owner,
        outsider=outsider,
        current_user=owner,
        projects=projects,
        zones=zones,
        cameras=cameras,
        frames=frames,
        foreign_task=saved_tasks[2],
        saved_tasks=saved_tasks,
        rule_sets=rule_sets,
        cost_rates=cost_rates,
        object_class=object_class,
        dispatched=[],
    )
    app = FastAPI()
    app.include_router(router, prefix="/api/v1")
    app.include_router(incident_router, prefix="/api/v1")
    app.include_router(alerts_router, prefix="/api/v1")
    app.include_router(schedule_router, prefix="/api/v1")

    def database():
        with factory() as db:
            yield db

    app.dependency_overrides[get_db] = database
    app.dependency_overrides[get_current_user] = lambda: state.current_user

    def dispatch(*, args, **kwargs):
        state.dispatched.append(args[0])
        return execute_run(args[0], session_factory=factory)

    async def forbidden_provider(*args, **kwargs):
        pytest.fail("Real LLM access is forbidden in isolated API tests")

    monkeypatch.setattr(analyze_management_run, "apply_async", dispatch)
    monkeypatch.setattr(OpenRouterProvider, "complete", forbidden_provider)
    with TestClient(app) as client:
        state.client = client
        state.app = app
        yield state
    engine.dispose()


def request_body(api, *, index=0, key=None, episode="baseline"):
    return {
        "snapshot": make_demo_snapshot(api.projects[index].id, episode).model_dump(
            mode="json"
        ),
        "mode": "deterministic",
        "idempotency_key": key or str(uuid4()),
    }


def start(api, body=None):
    response = api.client.post("/api/v1/management/runs", json=body or request_body(api))
    assert response.status_code == 202, response.text
    return response.json()


def user_body(api, index=0):
    body = request_body(api, index=index)
    snapshot = body["snapshot"]
    snapshot["data_mode"] = "user"
    snapshot["tasks"][0]["schedule_task_id"] = str(api.saved_tasks[index].id)
    snapshot["rule"]["source_ref"] = f"rule.{api.rule_sets[index].id}"
    snapshot["rule"]["version"] = api.rule_sets[index].version
    for resource in snapshot["resources"]:
        for rate in resource["rates"]:
            rate["confirmation"] = "user_assumption"
            rate["source"] = "Isolated API test input, not a market rate"
    for rate in snapshot["extension_rates"]:
        rate["confirmation"] = "user_assumption"
        rate["source"] = "Isolated API test extension input"
    evidence = snapshot["evidence"][0]
    evidence.update(
        origin="persisted_frame",
        source_ref=f"frame.{api.frames[index].id}",
        camera_id=str(api.cameras[index].id),
        image_url="https://untrusted.invalid/fake.jpg",
        captured_at=(AS_OF + timedelta(days=500)).isoformat(),
        detected_classes=["fake-truck"],
        model_status="valid",
    )
    snapshot["evidence"] = [evidence]
    snapshot["source_refs"].append(evidence["source_ref"])
    return body


def test_complete_saved_path_reloads_and_keeps_incident_uuid(api):
    result = start(api)
    assert result["status"] == "completed", result
    assert result["effective_mode"] == "deterministic"
    assert result["llm_calls"] == 0
    assert [r["total_cost"] for r in result["results"]] == [
        "44000.00",
        "68000.00",
        "112000.00",
    ]
    assert result["comparison"]["net_avoidable_cost"] == "68000.00"
    assert result["comparison"]["is_actual_saving"] is False
    assert UUID(result["incident"]["id"]) == UUID(result["incident_id"])
    assert result["project_id"] == str(api.projects[0].id)
    assert result["snapshot"]["incident_id"] == result["incident_id"]
    loaded = api.client.get(f"/api/v1/management/runs/{result['id']}").json()
    assert loaded == result
    assert [s["role"] for s in loaded["steps"]] == [
        "evidence",
        "calculation",
        "actions",
        "reviewer",
    ]
    assert [s["status"] for s in loaded["steps"]] == [
        "skipped",
        "completed",
        "skipped",
        "skipped",
    ]
    assert all(s["generation"] == "deterministic" for s in loaded["steps"])
    trace = api.client.get(f"/api/v1/management/runs/{result['id']}/trace")
    assert trace.status_code == 200
    assert trace.json()["input_hash"] == result["input_hash"]


def test_case_curve_uses_its_saved_snapshot_and_has_no_llm_or_mutations(api):
    saved = start(api)
    before_dispatch = list(api.dispatched)
    response = api.client.get(f"/api/v1/incidents/{saved['incident_id']}/inaction-cost")
    assert response.status_code == 200, response.text
    curve = response.json()
    assert curve["incident_code"] == saved["incident"]["code"]
    assert curve["project_owner"] == api.owner.username
    assert curve["observed_since"]
    assert curve["points"][-1]["basis"]
    assert curve["run_id"] == saved["id"]
    assert curve["input_hash"] == saved["input_hash"]
    assert curve["points"][-1]["cost"] == "112000.00"
    assert api.dispatched == before_dispatch
    assert api.client.get(f"/api/v1/management/runs/{saved['id']}").json() == saved
    api.current_user = api.outsider
    assert (
        api.client.get(
            f"/api/v1/incidents/{saved['incident_id']}/inaction-cost"
        ).status_code
        == 404
    )


def test_case_curve_does_not_use_another_cases_project_profile(api):
    saved = start(api)
    with api.factory() as db:
        run = db.get(ManagementRun, UUID(saved["id"]))
        db.delete(run)
        db.commit()
    body = request_body(api)
    body["snapshot"]["incident_id"] = None
    response = api.client.put(
        f"/api/v1/projects/{api.projects[0].id}/management/profile",
        json={"snapshot": body["snapshot"]},
    )
    assert response.status_code == 200
    response = api.client.get(f"/api/v1/incidents/{saved['incident_id']}/inaction-cost")
    assert response.status_code == 200
    assert response.json()["status"] == "unavailable"
    assert response.json()["points"] == []
    assert response.json()["needs"] == [
        "Привязанные к случаю ресурсы и ставки простоя",
        "График работ и срок восстановления",
    ]
    assert response.json()["project_owner"] == api.owner.username
    body["snapshot"]["incident_id"] = saved["incident_id"]
    response = api.client.put(
        f"/api/v1/projects/{api.projects[0].id}/management/profile",
        json={"snapshot": body["snapshot"]},
    )
    assert response.status_code == 200
    curve = api.client.get(
        f"/api/v1/incidents/{saved['incident_id']}/inaction-cost"
    ).json()
    assert curve["status"] == "complete"
    assert curve["run_id"] is None
    assert curve["points"][-1]["cost"] == "112000.00"


def test_case_curve_and_case_card_show_the_saved_responsible_person(api):
    saved = start(api)
    with api.factory() as db:
        incident = db.get(Incident, UUID(saved["incident_id"]))
        incident.assigned_user_id = api.owner.id
        db.commit()
    curve = api.client.get(
        f"/api/v1/incidents/{saved['incident_id']}/inaction-cost"
    ).json()
    assert curve["responsible"] == api.owner.name
    cases = api.client.get(
        "/api/v1/incidents", params={"project_id": str(api.projects[0].id)}
    ).json()
    card = next(case for case in cases if case["id"] == saved["incident_id"])
    assert card["assignee_name"] == api.owner.name


def test_auth_and_foreign_project_profile_run_trace_are_denied(api):
    own = start(api)
    foreign = str(api.projects[2].id)
    for suffix in (
        "management/demo",
        "management/profile",
        "management/risks",
        "schedule/dependencies",
    ):
        assert api.client.get(f"/api/v1/projects/{foreign}/{suffix}").status_code == 404
    assert (
        api.client.post(
            "/api/v1/management/runs", json=request_body(api, index=2)
        ).status_code
        == 404
    )
    api.current_user = api.outsider
    assert api.client.get(f"/api/v1/management/runs/{own['id']}").status_code == 404
    assert api.client.get(f"/api/v1/management/runs/{own['id']}/trace").status_code == 404
    assert (
        api.client.put(
            f"/api/v1/projects/{api.projects[0].id}/management/profile",
            json={"snapshot": request_body(api)["snapshot"]},
        ).status_code
        == 404
    )
    api.app.dependency_overrides.pop(get_current_user)
    assert (
        api.client.get(f"/api/v1/projects/{foreign}/management/demo").status_code == 401
    )


def test_viewer_reads_owned_project_but_cannot_mutate(api):
    with api.factory() as db:
        for assignment in db.scalars(select(ProjectAssignment)):
            assignment.role = ProjectRole.PROJECT_VIEWER
        db.commit()
    assert (
        api.client.get(
            f"/api/v1/projects/{api.projects[0].id}/management/demo"
        ).status_code
        == 200
    )
    assert (
        api.client.post("/api/v1/management/runs", json=request_body(api)).status_code
        == 403
    )
    assert (
        api.client.put(
            f"/api/v1/projects/{api.projects[0].id}/management/profile",
            json={"snapshot": request_body(api)["snapshot"]},
        ).status_code
        == 403
    )


def test_foreign_incident_task_parent_and_evidence_are_rejected(api):
    api.current_user = api.outsider
    foreign_run = start(api, request_body(api, index=2))
    api.current_user = api.owner
    body = request_body(api)
    body["snapshot"]["incident_id"] = foreign_run["incident_id"]
    assert api.client.post("/api/v1/management/runs", json=body).status_code == 422
    body = request_body(api)
    body["snapshot"]["tasks"][0]["schedule_task_id"] = str(api.foreign_task.id)
    assert api.client.post("/api/v1/management/runs", json=body).status_code == 422
    body = request_body(api)
    body["parent_run_id"] = foreign_run["id"]
    assert api.client.post("/api/v1/management/runs", json=body).status_code == 404
    body = user_body(api)
    body["snapshot"]["evidence"][0]["source_ref"] = f"frame.{api.frames[2].id}"
    assert api.client.post("/api/v1/management/runs", json=body).status_code == 422
    other_owned_run = start(api, request_body(api, index=1))
    body = request_body(api)
    body["parent_run_id"] = other_owned_run["id"]
    assert api.client.post("/api/v1/management/runs", json=body).status_code == 422


def test_idempotency_and_duplicate_worker_do_not_repeat_analysis_or_incident(api):
    body = request_body(api, key="same-request-key")
    first = start(api, body)
    again = start(api, body)
    assert first == again
    assert len(api.dispatched) == 1
    assert execute_run(first["id"], session_factory=api.factory) == {
        "id": first["id"],
        "claimed": False,
    }
    body["snapshot"]["scenarios"][0]["recovery_work_hours"] = "3"
    assert api.client.post("/api/v1/management/runs", json=body).status_code == 409
    with api.factory() as db:
        assert db.scalar(select(func.count()).select_from(ManagementRun)) == 1
        assert db.scalar(select(func.count()).select_from(ManagementRunStep)) == 4
        assert db.scalar(select(func.count()).select_from(Incident)) == 1
    updated = request_body(api)
    updated["parent_run_id"] = first["id"]
    second = start(api, updated)
    assert second["id"] != first["id"]
    assert second["incident_id"] == first["incident_id"]


def test_active_snapshot_conflict_and_expired_lease(api, monkeypatch):
    monkeypatch.setattr(analyze_management_run, "apply_async", lambda **kwargs: None)
    first = start(api)
    assert first["status"] == "queued"
    assert (
        api.client.post("/api/v1/management/runs", json=request_body(api)).status_code
        == 409
    )
    with api.factory() as db:
        row = db.get(ManagementRun, UUID(first["id"]))
        row.lease_expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    assert execute_run(first["id"], session_factory=api.factory)["claimed"] is False
    expired = api.client.get(f"/api/v1/management/runs/{first['id']}").json()
    assert expired["status"] == "failed"
    assert expired["error"] == "worker_lease_expired"
    assert all(s["status"] == "failed" for s in expired["steps"])
    newer = start(api)
    assert newer["id"] != first["id"]


def test_failed_broker_is_persisted_without_false_success_or_get_retry(api, monkeypatch):
    def fail(**kwargs):
        raise ConnectionError("test broker offline")

    monkeypatch.setattr(analyze_management_run, "apply_async", fail)
    body = request_body(api)
    result = start(api, body)
    assert result["status"] == "failed"
    assert result["error"] == "queue_unavailable"
    assert all(s["status"] == "skipped" for s in result["steps"])
    assert start(api, body)["id"] == result["id"]
    assert (
        api.client.get(f"/api/v1/management/runs/{result['id']}").json()["status"]
        == "failed"
    )


def test_profile_and_new_version_do_not_mutate_saved_inputs_or_results(api):
    body = request_body(api)
    old = start(api, body)
    profile_path = f"/api/v1/projects/{api.projects[0].id}/management/profile"
    body["snapshot"]["resources"][0]["rates"][0]["amount"] = "9000"
    saved = api.client.put(profile_path, json={"snapshot": body["snapshot"]})
    assert saved.status_code == 200
    assert (
        api.client.get(profile_path).json()["snapshot"]["resources"][0]["rates"][0][
            "amount"
        ]
        == "9000"
    )
    body["idempotency_key"] = str(uuid4())
    body["parent_run_id"] = old["id"]
    new = start(api, body)
    assert new["results"][0]["total_cost"] == "46000.00"
    assert new["input_hash"] != old["input_hash"]
    assert api.client.get(f"/api/v1/management/runs/{old['id']}").json() == old
    with api.factory() as db:
        assert db.scalar(select(func.count()).select_from(TaskDependency)) == 4


def test_missing_rates_persist_null_and_no_full_economic_effect(api):
    body = request_body(api)
    body["snapshot"]["resources"][0]["rates"][0]["amount"] = None
    result = start(api, body)
    assert result["status"] in ("partial", "needs_input")
    assert all(
        r["total_cost"] is None and r["idle_cost"] is None for r in result["results"]
    )
    assert all(r["missing_inputs"] for r in result["results"])
    assert result["comparison"]["net_avoidable_cost"] is None
    assert (
        api.client.get(f"/api/v1/management/runs/{result['id']}").json()["results"]
        == result["results"]
    )


def test_persisted_evidence_replaces_claimed_capture_time_and_model_success(api):
    body = user_body(api)
    path = f"/api/v1/projects/{api.projects[0].id}/management/profile"
    response = api.client.put(path, json={"snapshot": body["snapshot"]})
    assert response.status_code == 200, response.text
    evidence = response.json()["snapshot"]["evidence"][0]
    assert evidence["captured_at"] == "2026-10-16T04:55:00Z"
    assert evidence["model_status"] == "unavailable"
    assert evidence["camera_status"] == "unknown"
    assert evidence["detected_classes"] == []
    assert "untrusted.invalid" not in evidence["image_url"]
    result = start(api, body)
    assert result["status"] == "needs_input"
    assert result["assessment"]["verdict"] == "insufficient_evidence"


def test_bad_graph_is_rejected_before_persistence_or_queue(api):
    body = request_body(api)
    body["snapshot"]["dependencies"].append({"predecessor_id": "M", "successor_id": "A"})
    response = api.client.post("/api/v1/management/runs", json=body)
    assert response.status_code == 422
    assert api.dispatched == []
    with api.factory() as db:
        assert db.scalar(select(func.count()).select_from(ManagementRun)) == 0


def test_empty_evidence_remains_empty_and_requires_input(api):
    body = request_body(api)
    body["snapshot"]["evidence"] = []
    result = start(api, body)
    assert result["snapshot"]["evidence"] == []
    assert result["status"] == "needs_input"
    assert result["assessment"]["verdict"] == "insufficient_evidence"


def test_legacy_status_cannot_bypass_versioned_customer_workflow(api):
    saved = start(api)
    incident_id = saved["incident_id"]
    url = f"/api/v1/incidents/{incident_id}/status"
    for status in ("confirmed", "resolved", "typo-status"):
        response = api.client.patch(url, json={"status": status})
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "WORKFLOW_UPGRADE_REQUIRED"
    loaded = api.client.get(f"/api/v1/management/runs/{saved['id']}").json()
    assert loaded["incident"]["status"] == "pending"
    with api.factory() as db:
        assert db.scalar(select(func.count()).select_from(IncidentEvent)) == 0
    api.current_user = api.outsider
    assert api.client.patch(url, json={"status": "resolved"}).status_code == 404
    assert api.client.get(f"/api/v1/incidents/{incident_id}/album").status_code == 404


def test_browser_authored_detection_cannot_create_or_duplicate_a_server_case(api):
    # Capture time/model success in a browser payload are not server provenance.
    body = {
        "project_id": str(api.projects[0].id),
        "zone_id": str(api.zones[0].id),
        "camera_id": str(api.cameras[0].id),
        "captured_at": (AS_OF - timedelta(minutes=4)).isoformat(),
        "title": "Synthetic observation",
        "description": "Explicit isolated test",
        "machinery_type": "dump_truck",
        "model_status": "unavailable",
        "observation_key": "same-receipt",
    }
    for model_status in ("unavailable", "valid", "valid"):
        body["model_status"] = model_status
        response = api.client.post("/api/v1/incidents", json=body)
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "WORKFLOW_UPGRADE_REQUIRED"
    with api.factory() as db:
        assert db.scalar(select(func.count()).select_from(Incident)) == 0
    api.current_user = api.outsider
    assert (
        api.client.get(f"/api/v1/incidents?project_id={api.projects[0].id}").status_code
        == 404
    )


@pytest.mark.parametrize("linked_class", [False, True])
def test_canonical_truck_class_from_persisted_detector_prevents_false_absence(
    api, linked_class
):
    with api.factory() as db:
        run = AnalysisRun(
            id=uuid4(),
            frame_id=api.frames[0].id,
            model_name="isolated-test",
            model_version="fixture-v1",
            status=AnalysisStatus.COMPLETED,
            started_at=AS_OF - timedelta(minutes=4),
        )
        db.add(run)
        db.flush()
        db.add(
            Detection(
                analysis_run_id=run.id,
                frame_id=api.frames[0].id,
                object_class_id=api.object_class.id if linked_class else None,
                raw_label="truck",
                confidence=0.95,
                x1=0,
                y1=0,
                x2=1,
                y2=1,
            )
        )
        db.commit()
    body = user_body(api)
    path = f"/api/v1/projects/{api.projects[0].id}/management/profile"
    response = api.client.put(path, json={"snapshot": body["snapshot"]})
    assert response.status_code == 200, response.text
    evidence = response.json()["snapshot"]["evidence"][0]
    assert evidence["model_status"] == "valid"
    assert evidence["detected_classes"] == ["dump_truck"]
    result = start(api, body)
    assert result["assessment"]["verdict"] != "supported_risk"


def test_stored_requirement_confidence_threshold_controls_detected_classes(api):
    with api.factory() as db:
        run = AnalysisRun(
            id=uuid4(),
            frame_id=api.frames[0].id,
            model_name="isolated-test",
            model_version="fixture-v1",
            status=AnalysisStatus.COMPLETED,
            started_at=AS_OF - timedelta(minutes=4),
        )
        db.add(run)
        db.flush()
        db.add(
            Detection(
                analysis_run_id=run.id,
                frame_id=api.frames[0].id,
                raw_label="truck",
                confidence=0.85,
                x1=0,
                y1=0,
                x2=1,
                y2=1,
            )
        )
        db.commit()
    body = user_body(api)
    path = f"/api/v1/projects/{api.projects[0].id}/management/profile"
    response = api.client.put(path, json={"snapshot": body["snapshot"]})
    assert response.status_code == 200, response.text
    assert response.json()["snapshot"]["evidence"][0]["detected_classes"] == []


def test_saved_rule_normalizes_version_scope_and_freshness_removes_forged_refs(api):
    body = user_body(api)
    snapshot = body["snapshot"]
    snapshot["rule"].update(
        version="fake-version",
        applicable_task_ids=["D"],
        max_frame_age_minutes=1440,
        max_camera_skew_seconds=3600,
    )
    snapshot["source_refs"].extend(["invented:proof", f"frame.{api.frames[2].id}"])
    snapshot["tasks"][0]["planned_start"] = (AS_OF + timedelta(days=500)).isoformat()
    snapshot["tasks"][0]["planned_end"] = (AS_OF + timedelta(days=501)).isoformat()
    path = f"/api/v1/projects/{api.projects[0].id}/management/profile"
    response = api.client.put(path, json={"snapshot": snapshot})
    assert response.status_code == 200, response.text
    saved = response.json()["snapshot"]
    assert saved["rule"]["version"] == "stored-v2"
    assert saved["rule"]["applicable_task_ids"] == ["A"]
    assert saved["rule"]["max_frame_age_minutes"] == 15
    assert saved["rule"]["max_camera_skew_seconds"] == 120
    assert saved["tasks"][0]["planned_start"] == "2026-10-15T05:00:00Z"
    assert set(saved["source_refs"]) == {
        "user:profile",
        "user:confirmation",
        f"rule.{api.rule_sets[0].id}",
        f"frame.{api.frames[0].id}",
    }


def test_unknown_required_class_and_foreign_or_missing_rules_are_rejected(api):
    path = f"/api/v1/projects/{api.projects[0].id}/management/profile"
    body = user_body(api)
    body["snapshot"]["rule"]["required_class"] = "invented_class"
    assert api.client.put(path, json={"snapshot": body["snapshot"]}).status_code == 422
    for source in (f"rule.{api.rule_sets[2].id}", f"rule.{uuid4()}", "invented:rule"):
        body = user_body(api)
        body["snapshot"]["rule"]["source_ref"] = source
        assert (
            api.client.put(path, json={"snapshot": body["snapshot"]}).status_code == 422
        )


@pytest.mark.parametrize("category", ["resource", "extension"])
def test_foreign_cost_rate_cannot_be_used_for_resource_or_extension(api, category):
    body = user_body(api)
    snapshot = body["snapshot"]
    rate = (
        snapshot["resources"][0]["rates"][0]
        if category == "resource"
        else snapshot["extension_rates"][0]
    )
    rate["source"] = f"cost_rate.{api.cost_rates[2].id}"
    path = f"/api/v1/projects/{api.projects[0].id}/management/profile"
    response = api.client.put(path, json={"snapshot": snapshot})
    assert response.status_code == 422, response.text


@pytest.mark.parametrize("category", ["resource", "extension"])
def test_owned_saved_cost_rate_is_authoritative_and_allowlisted(api, category):
    body = user_body(api)
    snapshot = body["snapshot"]
    rate = (
        snapshot["resources"][0]["rates"][0]
        if category == "resource"
        else snapshot["extension_rates"][0]
    )
    rate.update(
        source=f"cost_rate.{api.cost_rates[0].id}",
        amount="999999",
        currency="USD",
        unit="calendar_day",
    )
    path = f"/api/v1/projects/{api.projects[0].id}/management/profile"
    response = api.client.put(path, json={"snapshot": snapshot})
    assert response.status_code == 200, response.text
    saved = response.json()["snapshot"]
    saved_rate = (
        saved["resources"][0]["rates"][0]
        if category == "resource"
        else saved["extension_rates"][0]
    )
    assert Decimal(saved_rate["amount"]) == Decimal("4321")
    assert saved_rate["currency"] == "RUB"
    assert saved_rate["unit"] == "work_hour"
    assert saved_rate["confirmation"] == "confirmed"
    assert f"cost_rate.{api.cost_rates[0].id}" in saved["source_refs"]


@pytest.mark.parametrize("category", ["resource", "extension"])
def test_demo_tariffs_require_demo_mode_in_every_rate_category(api, category):
    body = user_body(api)
    snapshot = body["snapshot"]
    rate = (
        snapshot["resources"][0]["rates"][0]
        if category == "resource"
        else snapshot["extension_rates"][0]
    )
    rate["confirmation"] = "demo"
    path = f"/api/v1/projects/{api.projects[0].id}/management/profile"
    assert api.client.put(path, json={"snapshot": snapshot}).status_code == 422


def test_unknown_timezone_returns_validation_error_not_internal_error(api):
    body = request_body(api)
    body["snapshot"]["calendar"]["timezone"] = "invented/timezone"
    assert api.client.post("/api/v1/management/runs", json=body).status_code == 422


def test_saved_invalid_rate_is_revalidated_after_resolution(api):
    body = user_body(api)
    with api.factory() as db:
        rate = db.get(CostRate, api.cost_rates[0].id)
        rate.rate_per_hour = Decimal("-1")
        db.commit()
    body["snapshot"]["resources"][0]["rates"][0]["source"] = (
        f"cost_rate.{api.cost_rates[0].id}"
    )
    response = api.client.post("/api/v1/management/runs", json=body)
    assert response.status_code == 422


def test_incident_task_must_match_blocked_schedule_task(api):
    body = user_body(api)
    with api.factory() as db:
        incident = Incident(
            code="MISMATCH-TASK",
            project_id=api.projects[0].id,
            zone_id=api.zones[0].id,
            schedule_task_id=api.saved_tasks[0].id,
            category="equipment",
            type="equipment_missing",
            title="Test",
            dedup_key="mismatch",
            first_seen_at=AS_OF,
            last_seen_at=AS_OF,
        )
        db.add(incident)
        db.commit()
        body["snapshot"]["incident_id"] = str(incident.id)
    body["snapshot"]["tasks"][0]["schedule_task_id"] = None
    response = api.client.post("/api/v1/management/runs", json=body)
    assert response.status_code == 422


def test_schedule_writes_require_exact_owned_stage_and_never_fall_back(api):
    own_id = str(api.saved_tasks[0].id)
    foreign_id = str(api.saved_tasks[2].id)
    with api.factory() as db:
        before = db.get(ScheduleTask, api.saved_tasks[0].id).machinery_probabilities
    for stage_id in ("stage-1", str(uuid4()), foreign_id):
        path = f"/api/v1/schedule/stages/{stage_id}/probabilities"
        assert api.client.get(path).status_code == 404
        assert (
            api.client.put(
                path, json={"overrides": {"excavator": "MANDATORY"}}
            ).status_code
            == 404
        )
        assert api.client.delete(path).status_code == 404
        assert (
            api.client.put(
                f"/api/v1/schedule/stages/{stage_id}", json={"name": "forbidden"}
            ).status_code
            == 404
        )
    with api.factory() as db:
        assert (
            db.get(ScheduleTask, api.saved_tasks[0].id).machinery_probabilities == before
        )
    response = api.client.get(f"/api/v1/schedule/stages/{own_id}/probabilities")
    assert response.status_code == 200
    assert response.json()["stage_id"] == own_id


def test_schedule_clear_is_scoped_and_viewer_cannot_write(api):
    assert api.client.post("/api/v1/schedule/clear").status_code == 422
    assert (
        api.client.get(
            "/api/v1/schedule/stages", params={"project_id": str(api.projects[2].id)}
        ).status_code
        == 404
    )
    with api.factory() as db:
        viewer = db.get(User, api.owner.id)
        for assignment in db.scalars(select(ProjectAssignment)):
            assignment.role = ProjectRole.PROJECT_VIEWER
        db.commit()
        api.current_user = viewer
    own_id = str(api.saved_tasks[0].id)
    assert (
        api.client.put(
            f"/api/v1/schedule/stages/{own_id}/probabilities", json={"overrides": {}}
        ).status_code
        == 403
    )
    assert (
        api.client.post(
            "/api/v1/schedule/clear", params={"project_id": str(api.projects[0].id)}
        ).status_code
        == 403
    )
    assert (
        api.client.get(f"/api/v1/schedule/stages/{own_id}/probabilities").status_code
        == 200
    )


def test_merged_alert_verification_keeps_case_cost_and_notification_scope(api):
    saved = start(api)
    incident_id = saved["incident_id"]
    curve_url = f"/api/v1/incidents/{incident_id}/inaction-cost"
    before = api.client.get(curve_url).json()
    with api.factory() as db:
        incident = db.get(Incident, UUID(incident_id))
        project = db.get(Project, incident.project_id)
        assign_initial_alert(db, incident, project)
        db.commit()
    inbox = api.client.get(
        "/api/v1/alerts", params={"project_id": str(api.projects[0].id)}
    )
    assert inbox.status_code == 200
    alert = inbox.json()[0]
    assert alert["incident_id"] == incident_id
    assert alert["sla_deadline"]
    response = api.client.patch(
        f"/api/v1/incidents/{incident_id}/status", json={"status": "resolved"}
    )
    assert response.status_code == 409
    with api.factory() as db:
        incident = db.get(Incident, UUID(incident_id))
        request_verification(db, incident, db.get(User, api.owner.id))
        db.commit()
        assert incident.status.value != "resolved"
        assert incident.verification_status == "queued"
    after = api.client.get(curve_url).json()
    assert after["points"] == before["points"]
    assert api.client.get(f"/api/v1/incidents/{incident_id}/events").status_code == 200
    assert api.client.patch(f"/api/v1/alerts/{alert['id']}/read").status_code == 200
    api.current_user = api.outsider
    assert (
        api.client.get(
            "/api/v1/alerts", params={"project_id": str(api.projects[0].id)}
        ).status_code
        == 404
    )
    assert api.client.patch(f"/api/v1/alerts/{alert['id']}/read").status_code == 404
    assert api.client.get(f"/api/v1/incidents/{incident_id}/events").status_code == 404
