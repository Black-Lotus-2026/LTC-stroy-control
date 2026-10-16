"""Tests for authentication: registration, login, and JWT verification."""

import uuid
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_register_and_login_flow():
    unique_username = f"user_{uuid.uuid4().hex[:8]}"
    password = "SecretPassword123"

    # 1. Register new user
    reg_res = client.post(
        "/api/v1/auth/register",
        json={
            "username": unique_username,
            "password": password,
            "confirm_password": password,
        },
    )
    assert reg_res.status_code == 201
    data = reg_res.json()
    assert "access_token" in data
    assert data["token_type"] == "bearer"
    assert data["user"]["username"] == unique_username
    token = data["access_token"]

    # 2. Duplicate registration fails with 409
    dup_res = client.post(
        "/api/v1/auth/register",
        json={
            "username": unique_username,
            "password": password,
            "confirm_password": password,
        },
    )
    assert dup_res.status_code == 409

    # 3. Password mismatch validation
    mismatch_res = client.post(
        "/api/v1/auth/register",
        json={
            "username": f"{unique_username}_2",
            "password": password,
            "confirm_password": "DifferentPassword",
        },
    )
    assert mismatch_res.status_code == 422

    # 4. Login with correct credentials
    login_res = client.post(
        "/api/v1/auth/login",
        json={
            "username": unique_username,
            "password": password,
        },
    )
    assert login_res.status_code == 200
    login_data = login_res.json()
    assert "access_token" in login_data
    assert login_data["user"]["username"] == unique_username

    # 5. Login with invalid password
    bad_login_res = client.post(
        "/api/v1/auth/login",
        json={
            "username": unique_username,
            "password": "WrongPassword",
        },
    )
    assert bad_login_res.status_code == 401

    # 6. Get profile /auth/me with valid Bearer token
    me_res = client.get(
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert me_res.status_code == 200
    me_data = me_res.json()
    assert me_data["username"] == unique_username

    # 7. /auth/me without token fails with 401
    unauth_res = client.get("/api/v1/auth/me")
    assert unauth_res.status_code == 401
