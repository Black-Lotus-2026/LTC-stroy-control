"""Explicit onboarding and publication never replace project assignments."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select

from app.models import Project, User, UserRole, Zone
from app.models.customer_control import (
    Invitation,
    OrganizationMembership,
    ResponsibilityArea,
)
from tests import test_customer_control_http

customer_http = test_customer_control_http.customer_http


def _post(s, path, data, *, actor="manager", headers=None):
    return s.client.post(
        "/api/v1/customer-control" + path,
        headers={**(headers or s.headers(actor)), "Idempotency-Key": str(uuid4())},
        json=data,
    )


def test_registration_grants_no_projects_until_explicit_new_organization_onboarding(
    customer_http,
):
    s = customer_http
    username = "onboarding-" + uuid4().hex
    response = s.client.post(
        "/api/v1/auth/register",
        json={
            "username": username,
            "password": "IsolatedQa2026!",
            "confirm_password": "IsolatedQa2026!",
        },
    )
    assert response.status_code == 201, response.text
    assert response.json()["user"]["role"] == "viewer"
    headers = {"Authorization": "Bearer " + response.json()["access_token"]}
    contexts = s.client.get("/api/v1/auth/contexts", headers=headers)
    assert contexts.status_code == 200
    assert all(context["is_demo"] for context in contexts.json())
    organization = _post(
        s, "/organizations", {"name": "Explicit new isolated customer"}, headers=headers
    )
    assert organization.status_code == 201, organization.text
    members = s.client.get("/api/v1/customer-control/memberships", headers=headers).json()
    member = next(
        row for row in members if row["organization_id"] == organization.json()["id"]
    )
    headers["X-Organization-Membership"] = member["id"]
    response = _post(
        s,
        "/projects",
        {
            "name": "Explicit new jury project",
            "kind": "jury",
            "reaction_minutes": 30,
            "remediation_minutes": 1440,
            "review_minutes": 720,
        },
        headers=headers,
    )
    assert response.status_code == 201, response.text
    created = response.json()
    contexts = s.client.get("/api/v1/auth/contexts", headers=headers).json()
    selected = next(row for row in contexts if row["project_id"] == created["id"])
    assert selected["role"] == "customer_manager"
    assert (
        s.client.get(
            f"/api/v1/projects/{s.projects['a'].id}", headers=headers
        ).status_code
        == 404
    )
    with s.sessions() as db:
        assert (
            db.scalar(select(User).where(User.username == username)).role
            == UserRole.VIEWER
        )
        project = db.get(Project, UUID(created["id"]))
        assert project.kind == "jury"
        assert project.customer_organization_id == UUID(organization.json()["id"])


def test_membership_invitation_is_single_use_and_never_creates_project_authority(
    customer_http,
):
    s = customer_http
    with s.sessions() as db:
        db.get(
            OrganizationMembership, s.memberships["foreman1"].id
        ).can_manage_members = True
        db.commit()
    org = s.participations["k1"].organization_id
    invitation = _post(
        s,
        f"/organizations/{org}/invitations",
        {
            "recipient_user_id": str(s.users["unassigned"].id),
            "expires_at": (datetime.now(UTC) + timedelta(days=1)).isoformat(),
        },
        actor="foreman1",
    )
    assert invitation.status_code == 201, invitation.text
    value = invitation.json()
    token = value["token"]
    assert token
    with s.sessions() as db:
        stored = db.get(Invitation, UUID(value["id"]))
        assert stored.token_sha256 == hashlib.sha256(token.encode()).hexdigest()
        assert stored.token_sha256 != token
    path = f"/invitations/{token}/accept"
    assert _post(s, path, {}, actor="manager").status_code == 404
    accepted = _post(s, path, {}, actor="unassigned")
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["status"] == "accepted"
    assert _post(s, path, {}, actor="unassigned").status_code == 200
    assert (
        s.client.get(
            f"/api/v1/projects/{s.projects['a'].id}", headers=s.headers("unassigned")
        ).status_code
        == 404
    )
    with s.sessions() as db:
        assert (
            db.scalar(
                select(func.count())
                .select_from(OrganizationMembership)
                .where(
                    OrganizationMembership.organization_id == org,
                    OrganizationMembership.user_id == s.users["unassigned"].id,
                )
            )
            == 1
        )


@pytest.mark.parametrize("kind", ["document", "video"])
def test_source_publication_and_revocation_recheck_the_specific_file(customer_http, kind):
    s = customer_http
    resource = s.documents["k2"] if kind == "document" else s.videos["k2"]
    private = (
        f"/api/v1/projects/{s.projects['a'].id}/ppr-documents/{resource.id}/original"
        if kind == "document"
        else f"/api/v1/videos/{resource.id}/media"
    )
    foreman = s.headers("foreman1")
    assert s.client.get(private, headers=foreman).status_code == 404
    path = f"/projects/{s.projects['a'].id}/sources/{kind}/{resource.id}/shares"
    payload = {
        "participation_id": str(s.participations["k1"].id),
        "area_id": str(s.area.id),
        "active": True,
    }
    assert _post(s, path, payload, actor="foreman1").status_code == 403
    published = _post(s, path, payload)
    assert published.status_code == 200, published.text
    assert s.client.get(private, headers=foreman).status_code == 200
    revoked = _post(s, path, {**payload, "active": False})
    assert revoked.status_code == 200, revoked.text
    assert (
        s.client.get(private, headers={**foreman, "Range": "bytes=0-9"}).status_code
        == 404
    )


def test_publication_cannot_label_a_private_document_with_another_area(customer_http):
    s = customer_http
    with s.sessions() as db:
        zone = Zone(
            project_id=s.projects["a"].id,
            code="OTHER-" + uuid4().hex[:8],
            name="Other private work zone",
        )
        db.add(zone)
        db.flush()
        other_area = ResponsibilityArea(
            project_id=s.projects["a"].id, zone_id=zone.id, name="Other private area"
        )
        db.add(other_area)
        db.commit()
    resource = s.documents["k2"]
    response = _post(
        s,
        f"/projects/{s.projects['a'].id}/sources/document/{resource.id}/shares",
        {
            "participation_id": str(s.participations["k1"].id),
            "area_id": str(other_area.id),
            "active": True,
        },
    )
    assert response.status_code in {404, 422}, response.text
