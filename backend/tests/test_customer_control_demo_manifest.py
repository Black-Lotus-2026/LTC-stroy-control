"""Shared demo publication uses exact reviewed IDs, never all historical rows."""

from __future__ import annotations

import hashlib
import io
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from PIL import Image
from sqlalchemy import func, select

from app.core.config import settings
from app.models import Incident, Project
from app.models.customer_control import EvidenceAsset, IncidentBasis, IncidentEvidenceLink
from app.models.enums import (
    IncidentCategory,
    IncidentPriority,
    IncidentStatus,
    IncidentType,
)
from app.schemas.customer_control import DemoManifestDTO, IncidentBasisDTO
from app.services.incident_workflow import digest
from tests import test_customer_control_http

customer_http = test_customer_control_http.customer_http


@pytest.fixture
def demo_sources(customer_http):
    s = customer_http
    rows = {}
    with s.sessions() as db:
        for name, color in (("reviewed", "green"), ("unknown", "orange")):
            at = datetime.now(UTC)
            incident = Incident(
                project_id=s.projects["demo"].id,
                code="SYNTHETIC-DEMO-" + uuid4().hex[:8],
                title="Synthetic shared demo " + name,
                category=IncidentCategory.CAMERA,
                type=IncidentType.CAMERA_VISIBILITY,
                case_kind="control_integrity",
                status=IncidentStatus.PENDING,
                priority=IncidentPriority.LOW,
                confidence=0,
                dedup_key="demo-" + uuid4().hex,
                first_seen_at=at,
                last_seen_at=at,
            )
            db.add(incident)
            db.flush()
            content = io.BytesIO()
            Image.new("RGB", (100, 80), color).save(content, format="PNG")
            key = "demo/" + uuid4().hex + ".png"
            path = settings.storage_local_root / key
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content.getvalue())
            asset = EvidenceAsset(
                project_id=incident.project_id,
                storage_key=key,
                media_type="image/png",
                size_bytes=path.stat().st_size,
                sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                source="legacy",
                integrity="verified",
                captured_at=at,
            )
            db.add(asset)
            db.flush()
            db.add(
                IncidentEvidenceLink(
                    incident_id=incident.id, asset_id=asset.id, kind="context"
                )
            )
            snapshot = IncidentBasisDTO(
                project_id=incident.project_id,
                observed_from=at,
                observed_until=at,
                provenance="legacy",
                source_evidence_ids=[asset.id],
                coverage={"status": "unknown", "reasons": ["unknown_geometry"]},
                limitations=["Synthetic test fixture; no real detection"],
            ).model_dump(mode="json")
            db.add(
                IncidentBasis(
                    incident_id=incident.id, snapshot=snapshot, sha256=digest(snapshot)
                )
            )
            rows[name] = (incident.id, asset.id, path.read_bytes())
        db.commit()
    return s, rows


def test_unknown_shared_demo_rows_stay_private_until_exact_operator_publication(
    demo_sources,
):
    s, rows = demo_sources
    headers = s.headers("unassigned")
    prefix = "/api/v1/customer-control"
    listing = f"{prefix}/projects/{s.projects['demo'].id}/incidents"
    assert s.client.get(listing, headers=headers).json() == []
    for incident_id, evidence_id, _ in rows.values():
        assert (
            s.client.get(f"{prefix}/incidents/{incident_id}", headers=headers).status_code
            == 404
        )
        assert (
            s.client.get(
                f"{prefix}/evidence/{evidence_id}/file", headers=headers
            ).status_code
            == 404
        )
    reviewed, evidence_id, raw = rows["reviewed"]
    with s.sessions() as db:
        db.get(Project, s.projects["demo"].id).demo_manifest = DemoManifestDTO(
            incident_ids=[reviewed],
            evidence_ids=[evidence_id],
        ).model_dump(mode="json")
        db.commit()
    response = s.client.get(listing, headers=headers)
    assert response.status_code == 200 and [r["id"] for r in response.json()] == [
        str(reviewed)
    ]
    detail = s.client.get(f"{prefix}/incidents/{reviewed}", headers=headers)
    assert detail.status_code == 200, detail.text
    assert detail.json()["incident"]["allowed_actions"] == []
    file_url = f"{prefix}/evidence/{evidence_id}/file"
    assert s.client.get(file_url, headers=headers).content == raw
    assert s.client.get(file_url).status_code == 401
    assert s.client.head(file_url, headers={"Range": "bytes=0-9"}).status_code == 401
    unknown_case, unknown_asset, _ = rows["unknown"]
    assert (
        s.client.get(f"{prefix}/incidents/{unknown_case}", headers=headers).status_code
        == 404
    )
    assert (
        s.client.get(
            f"{prefix}/evidence/{unknown_asset}/file", headers=headers
        ).status_code
        == 404
    )
    command = s.client.post(
        f"{prefix}/incidents/{reviewed}/commands",
        headers={**headers, "Idempotency-Key": str(uuid4())},
        json={"action": "start", "expected_version": 1},
    )
    assert command.status_code == 403, command.text
    with s.sessions() as db:
        db.get(
            Project, s.projects["demo"].id
        ).demo_manifest = DemoManifestDTO().model_dump(mode="json")
        db.commit()
    for method in (s.client.get, s.client.head):
        assert (
            method(file_url, headers={**headers, "Range": "bytes=0-9"}).status_code == 404
        )
    with s.sessions() as db:
        assert (
            db.scalar(
                select(func.count())
                .select_from(Incident)
                .where(Incident.project_id == s.projects["demo"].id)
            )
            == 2
        )
        assert db.get(Incident, unknown_case) is not None
