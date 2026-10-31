"""Tests for project invite key generation and auto-onboarding."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.models import Project, User, UserRole, Zone
from app.models.customer_control import ProjectAssignment, ProjectRole
from app.models.project import ProjectInviteKey
from tests import test_customer_control_http

customer_http = test_customer_control_http.customer_http


def test_project_invite_key_flow(customer_http):
    s = customer_http
    project_id = str(s.projects["a"].id)

    # 1. Manager generates invite key for contractor_foreman
    res = s.client.post(
        f"/api/v1/projects/{project_id}/invites",
        headers=s.headers("manager"),
        json={"role": "contractor_foreman", "expires_in_days": 7},
    )
    assert res.status_code == 201, res.text
    invite_foreman = res.json()
    assert invite_foreman["key"].startswith("PRJ-")
    assert invite_foreman["role"] == "contractor_foreman"
    assert invite_foreman["is_active"] is True

    # 2. Manager generates invite key for pto_engineer
    res = s.client.post(
        f"/api/v1/projects/{project_id}/invites",
        headers=s.headers("manager"),
        json={"role": "pto_engineer", "expires_in_days": 7},
    )
    assert res.status_code == 201, res.text
    invite_pto = res.json()
    assert invite_pto["role"] == "pto_engineer"

    # 3. Manager lists invites
    res = s.client.get(
        f"/api/v1/projects/{project_id}/invites",
        headers=s.headers("manager"),
    )
    assert res.status_code == 200
    invites_list = res.json()
    assert len(invites_list) >= 2

    # 4. A new user registers and joins by foreman key
    foreman_user = f"foreman-{uuid.uuid4().hex[:6]}"
    res = s.client.post(
        "/api/v1/auth/register",
        json={
            "username": foreman_user,
            "password": "StrongPassword123!",
            "confirm_password": "StrongPassword123!",
        },
    )
    assert res.status_code == 201
    foreman_token = res.json()["access_token"]
    foreman_headers = {"Authorization": f"Bearer {foreman_token}"}

    # Join by foreman key
    res = s.client.post(
        "/api/v1/projects/join-by-key",
        headers=foreman_headers,
        json={"key": invite_foreman["key"]},
    )
    assert res.status_code == 200, res.text
    join_data = res.json()
    assert join_data["success"] is True
    assert join_data["role"] == "contractor_foreman"
    assert join_data["side"] == "contractor"

    # Verify user's contexts
    res = s.client.get("/api/v1/auth/contexts", headers=foreman_headers)
    assert res.status_code == 200
    contexts = res.json()
    foreman_ctx = next(c for c in contexts if c["project_id"] == project_id)
    assert foreman_ctx["role"] == "contractor_foreman"
    assert foreman_ctx["side"] == "contractor"

    # 5. Another new user registers and joins by PTO key
    pto_user = f"pto-{uuid.uuid4().hex[:6]}"
    res = s.client.post(
        "/api/v1/auth/register",
        json={
            "username": pto_user,
            "password": "StrongPassword123!",
            "confirm_password": "StrongPassword123!",
        },
    )
    assert res.status_code == 201
    pto_token = res.json()["access_token"]
    pto_headers = {"Authorization": f"Bearer {pto_token}"}

    res = s.client.post(
        "/api/v1/projects/join-by-key",
        headers=pto_headers,
        json={"key": invite_pto["key"]},
    )
    assert res.status_code == 200, res.text
    assert res.json()["role"] == "pto_engineer"

    res = s.client.get("/api/v1/auth/contexts", headers=pto_headers)
    assert res.status_code == 200
    pto_ctx = next(c for c in res.json() if c["project_id"] == project_id)
    assert pto_ctx["role"] == "pto_engineer"

    # 6. Deactivate invite key and test rejection
    res = s.client.delete(
        f"/api/v1/projects/{project_id}/invites/{invite_pto['id']}",
        headers=s.headers("manager"),
    )
    assert res.status_code == 200

    res = s.client.post(
        "/api/v1/projects/join-by-key",
        headers=foreman_headers,
        json={"key": invite_pto["key"]},
    )
    assert res.status_code == 404

    # 7. Test max_uses limit
    res = s.client.post(
        f"/api/v1/projects/{project_id}/invites",
        headers=s.headers("manager"),
        json={"role": "project_viewer", "max_uses": 1},
    )
    assert res.status_code == 201
    single_use_key = res.json()["key"]

    viewer_user = f"viewer-{uuid.uuid4().hex[:6]}"
    res = s.client.post(
        "/api/v1/auth/register",
        json={
            "username": viewer_user,
            "password": "StrongPassword123!",
            "confirm_password": "StrongPassword123!",
        },
    )
    viewer_token = res.json()["access_token"]
    viewer_headers = {"Authorization": f"Bearer {viewer_token}"}

    # First use succeeds
    res = s.client.post(
        "/api/v1/projects/join-by-key",
        headers=viewer_headers,
        json={"key": single_use_key},
    )
    assert res.status_code == 200
    assert res.json()["role"] == "project_viewer"

    # Second use fails because max_uses reached
    res = s.client.post(
        "/api/v1/projects/join-by-key",
        headers=foreman_headers,
        json={"key": single_use_key},
    )
    assert res.status_code == 400
    assert "максимальное" in res.json()["detail"].lower()

