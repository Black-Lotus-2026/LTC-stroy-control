"""Explicit demo publication also closes dependencies of immutable case bases."""

import pytest

from app.models import Incident, Project
from app.services.demo_publication import validate_demo_manifest
from tests import test_customer_control_http

customer_http = test_customer_control_http.customer_http


def test_demo_case_with_unknown_document_is_hidden_until_dependencies_are_published(
    customer_http,
):
    s = customer_http
    project_id, incident_id = s.projects["a"].id, s.incidents["k1"].id
    document_id = s.documents["k1"].id
    photo = s.root / "storage" / "old-private.jpg"
    photo.write_bytes(b"Unknown historical photograph")
    with s.sessions() as db:
        project = db.get(Project, project_id)
        project.kind = "shared_demo"
        row = db.get(Incident, incident_id)
        row.explanation = {
            "ppr_requirements": [{"document_id": str(document_id)}],
            "snapshot_url": "/media/old-private.jpg",
        }
        project.demo_manifest = {
            "zone_ids": [str(s.zone.id)],
            "incident_ids": [str(incident_id)],
        }
        db.commit()
    headers = s.headers("unassigned")
    prefix = f"/api/v1/customer-control/projects/{project_id}/incidents"
    assert s.client.get(prefix + "?limit=1", headers=headers).json() == []
    assert (
        s.client.get(
            f"/api/v1/customer-control/incidents/{incident_id}", headers=headers
        ).status_code
        == 404
    )
    with s.sessions() as db:
        project = db.get(Project, project_id)
        manifest = {**project.demo_manifest, "document_ids": [str(document_id)]}
        project.demo_manifest = validate_demo_manifest(db, project, manifest).model_dump(
            mode="json"
        )
        db.commit()
    response = s.client.get(prefix + "?limit=1", headers=headers)
    assert response.status_code == 200, response.text
    assert [row["id"] for row in response.json()] == [str(incident_id)]
    original = f"/api/v1/projects/{project_id}/ppr-documents/{document_id}/original"
    assert s.client.get(original, headers=headers).status_code == 200
    assert (
        s.client.get(
            f"/api/v1/projects/{project_id}/ppr-documents/{s.documents['k2'].id}/original",
            headers=headers,
        ).status_code
        == 404
    )
    assert s.client.get("/media/old-private.jpg", headers=headers).status_code == 404


def test_operator_manifest_rejects_cross_project_resources(customer_http):
    s = customer_http
    with s.sessions() as db:
        project = db.get(Project, s.projects["demo"].id)
        with pytest.raises(ValueError, match="foreign document"):
            validate_demo_manifest(
                db, project, {"document_ids": [str(s.documents["k1"].id)]}
            )
        assert project.demo_manifest is None
