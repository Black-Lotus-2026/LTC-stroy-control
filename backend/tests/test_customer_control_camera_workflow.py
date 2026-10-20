"""Camera control is scoped, explicit, versioned and separate from acceptance."""

from __future__ import annotations

import base64
import hashlib
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.api.v1.camera_workflow import expire_move_requests
from app.models import Camera, Incident, IncidentStatus
from app.models.customer_control import (
    AuditEvent,
    CameraMoveRequest,
    CameraShare,
    IncidentBasis,
    IncidentEvidenceLink,
)
from app.models.safety import SafetyZone
from app.schemas.customer_control import IncidentBasisDTO
from app.services.observation_basis import approved_coverage
from app.services.safety_catalog import seed_catalog
from tests import test_customer_control_http
from tests.test_camera_view import jpeg, scene

customer_http = test_customer_control_http.customer_http


def _post(state, path, actor, data, key=None):
    return state.client.post(
        path,
        json=data,
        headers={**state.headers(actor), "Idempotency-Key": key or str(uuid.uuid4())},
    )


def _share_camera(state):
    with state.sessions() as db:
        db.add(
            CameraShare(
                project_id=state.projects["a"].id,
                participation_id=state.participations["k1"].id,
                area_id=state.area.id,
                camera_id=state.camera.id,
            )
        )
        db.commit()


def test_move_cycle_requires_customer_decision_fresh_reference_and_explicit_completion(
    customer_http,
):
    state = customer_http
    _share_camera(state)
    now = datetime.now(UTC)
    path = (
        f"/api/v1/customer-control/projects/{state.projects['a'].id}"
        f"/cameras/{state.camera.id}/move-requests"
    )
    data = {
        "requested_from": (now - timedelta(seconds=1)).isoformat(),
        "requested_until": (now + timedelta(hours=1)).isoformat(),
        "reason": "Перенос после монтажа",
        "coverage_plan": "Другая камера сохраняет обзор прохода",
    }
    key = str(uuid.uuid4())
    result = _post(state, path, "foreman1", data, key)
    assert result.status_code == 201, result.text
    move = result.json()
    assert _post(state, path, "foreman1", data, key).json()["id"] == move["id"]
    command_path = f"/api/v1/customer-control/camera-move-requests/{move['id']}/commands"

    def command(actor, action):
        return _post(
            state,
            command_path,
            actor,
            {
                "expected_version": move["row_version"],
                "action": action,
                "note": "Синтетическое решение",
            },
        )

    assert command("foreman1", "approve").status_code == 403
    response = command("manager", "approve")
    assert response.status_code == 200, response.text
    move = response.json()
    assert move["status"] == "approved"
    response = command("foreman1", "start")
    assert response.status_code == 200, response.text
    move = response.json()
    reference_path = (
        f"/api/v1/projects/{state.projects['a'].id}"
        f"/cameras/{state.camera.id}/view/reference"
    )
    proposed = state.client.put(
        reference_path,
        json={
            "snapshot_base64": base64.b64encode(jpeg(scene(24))).decode(),
            "note": "Новый ракурс после монтажа",
        },
        headers=state.headers("foreman1"),
    )
    assert proposed.status_code == 200, proposed.text
    response = command("foreman1", "propose_reference")
    assert response.status_code == 200, response.text
    move = response.json()
    assert command("foreman1", "complete").status_code == 403
    assert command("manager", "complete").status_code == 409
    approved = state.client.post(
        reference_path + "/approve",
        headers={
            **state.headers("manager"),
            "If-Match": proposed.json()["proposal"]["sha256"],
        },
    )
    assert approved.status_code == 200, approved.text
    response = command("manager", "complete")
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "completed"
    assert response.json()["reference_revision_id"]
    with state.sessions() as db:
        assert db.get(Camera, state.camera.id).view_move_status is None
        assert db.get(Incident, state.incidents["k1"].id).resolved_at is None


def test_coverage_is_explicit_and_move_expiration_creates_one_typed_case(customer_http):
    state = customer_http
    _share_camera(state)
    now = datetime.now(UTC)
    coverage_path = (
        f"/api/v1/customer-control/projects/{state.projects['a'].id}"
        "/coverage-configurations"
    )
    data = {
        "area_id": str(state.area.id),
        "camera_ids": [str(state.camera.id)],
        "effective_from": now.isoformat(),
        "reason": "Проверено покрытие зоны",
    }
    assert _post(state, coverage_path, "foreman1", data).status_code == 403
    response = _post(state, coverage_path, "manager", data)
    assert response.status_code == 201, response.text
    with state.sessions() as db:
        assert approved_coverage(db, state.projects["a"].id, state.area, now, []) is None
        assert approved_coverage(
            db, state.projects["a"].id, state.area, now, [state.camera.id]
        )
    path = (
        f"/api/v1/customer-control/projects/{state.projects['a'].id}"
        f"/cameras/{state.camera.id}/move-requests"
    )
    result = _post(
        state,
        path,
        "foreman1",
        {
            "requested_from": now.isoformat(),
            "requested_until": (now + timedelta(minutes=1)).isoformat(),
            "reason": "Перенос",
            "coverage_plan": "Резервная камера",
        },
    )
    assert result.status_code == 201, result.text
    move = result.json()
    response = _post(
        state,
        f"/api/v1/customer-control/camera-move-requests/{move['id']}/commands",
        "manager",
        {
            "expected_version": move["row_version"],
            "action": "approve",
            "note": "Окно согласовано",
        },
    )
    assert response.status_code == 200, response.text
    with state.sessions() as db:
        assert expire_move_requests(db, now + timedelta(minutes=2)) == 1
        db.commit()
        assert expire_move_requests(db, now + timedelta(minutes=3)) == 0
        incident = db.scalar(
            select(Incident).where(Incident.dedup_key == f"camera-move:{move['id']}")
        )
        basis = db.scalar(
            select(IncidentBasis).where(IncidentBasis.incident_id == incident.id)
        )
        IncidentBasisDTO.model_validate(basis.snapshot)
        assert incident.case_kind == "control_integrity"
        assert basis.snapshot["provenance"] == "camera_policy"
    detail = state.client.get(
        f"/api/v1/customer-control/incidents/{incident.id}",
        headers=state.headers("manager"),
    )
    assert detail.status_code == 200, detail.text
    # Restoration remains possible after expiry, with the same strict reference
    # approval and a final customer command. The historical case stays open.
    reference_path = (
        f"/api/v1/projects/{state.projects['a'].id}"
        f"/cameras/{state.camera.id}/view/reference"
    )
    proposed = state.client.put(
        reference_path,
        headers=state.headers("foreman1"),
        json={"snapshot_base64": base64.b64encode(jpeg(scene(19))).decode()},
    )
    assert proposed.status_code == 200, proposed.text
    with state.sessions() as db:
        request = db.get(CameraMoveRequest, uuid.UUID(move["id"]))
        version = request.row_version
        assert (
            len(
                list(
                    db.scalars(
                        select(AuditEvent).where(
                            AuditEvent.resource_id == request.id,
                            AuditEvent.event_type == "camera.move.expired",
                        )
                    )
                )
            )
            == 1
        )
    command_path = f"/api/v1/customer-control/camera-move-requests/{move['id']}/commands"
    restore = _post(
        state,
        command_path,
        "foreman1",
        {
            "expected_version": version,
            "action": "propose_reference",
            "note": "Новый ракурс после завершения окна",
        },
    )
    assert restore.status_code == 200, restore.text
    with state.sessions() as db:
        assert expire_move_requests(db, now + timedelta(minutes=4)) == 0
    approved = state.client.post(
        reference_path + "/approve",
        headers={
            **state.headers("manager"),
            "If-Match": proposed.json()["proposal"]["sha256"],
        },
    )
    assert approved.status_code == 200, approved.text
    completed = _post(
        state,
        command_path,
        "manager",
        {
            "expected_version": restore.json()["row_version"],
            "action": "complete",
            "note": "Контроль восстановлен после проверки нового эталона",
        },
    )
    assert completed.status_code == 200, completed.text
    assert completed.json()["status"] == "completed"
    with state.sessions() as db:
        assert db.get(Incident, incident.id).status == IncidentStatus.PENDING


def test_safety_candidate_has_one_canonical_case_and_original_evidence(customer_http):
    state = customer_http
    with state.sessions() as db:
        seed_catalog(db)
        db.commit()
    payload = {
        "camera_id": str(state.camera.id),
        "name": "Проход",
        "scenario": "worker_danger_zone",
        "polygon": [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]],
        "site_basis": "Утвержденная схема опасной зоны",
        "responsible_user_id": str(state.users["foreman1"].id),
        "min_duration_seconds": 3,
    }
    response = state.client.post(
        f"/api/v1/safety/projects/{state.projects['a'].id}/zones",
        json=payload,
        headers=state.headers("manager"),
    )
    assert response.status_code == 201, response.text
    from app.api.v1.safety import evaluate

    at = datetime.now(UTC)
    first, last = jpeg(scene(26)), jpeg(scene(27))
    detections = [
        {
            "raw_label": "worker",
            "confidence": 0.99,
            "x1": 0.2,
            "x2": 0.4,
            "y1": 0.2,
            "y2": 0.6,
        }
    ]
    with state.sessions() as db:
        zone = db.get(SafetyZone, uuid.UUID(response.json()["id"]))
        assert (
            evaluate(
                db,
                zone,
                "verified-camera",
                1000,
                hashlib.sha256(first).hexdigest(),
                first,
                detections,
                "a" * 64,
                observed_at=at,
            )[0]
            is None
        )
        event, status = evaluate(
            db,
            zone,
            "verified-camera",
            5000,
            hashlib.sha256(last).hexdigest(),
            last,
            detections,
            "a" * 64,
            observed_at=at + timedelta(seconds=4),
        )
        assert status == "candidate"
        db.commit()
        case = db.scalar(
            select(Incident).where(Incident.source_safety_event_id == event.id)
        )
        basis = db.scalar(
            select(IncidentBasis).where(IncidentBasis.incident_id == case.id)
        )
        assert (
            IncidentBasisDTO.model_validate(basis.snapshot).provenance == "safety_policy"
        )
        assert (
            db.scalar(
                select(Incident).where(Incident.source_safety_event_id == event.id)
            ).id
            == case.id
        )
        asset_id = db.scalar(
            select(IncidentEvidenceLink.asset_id).where(
                IncidentEvidenceLink.incident_id == case.id
            )
        )
    detail = state.client.get(
        f"/api/v1/customer-control/incidents/{case.id}", headers=state.headers("manager")
    )
    assert detail.status_code == 200, detail.text
    proof = state.client.get(
        f"/api/v1/customer-control/evidence/{asset_id}/file",
        headers=state.headers("manager"),
    )
    assert proof.status_code == 200, proof.text
    assert proof.content in (first, last)
