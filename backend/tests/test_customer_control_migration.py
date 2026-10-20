"""R1 migration rehearsal against an explicitly supplied disposable PostgreSQL.

No configured application database or .env is used. Every test owns a random
schema. The optional URL must name a test database; production names are refused.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
from datetime import UTC, datetime, time, timedelta
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import MetaData, Table, create_engine, func, select, text
from sqlalchemy.engine import make_url

BACKEND = Path(__file__).resolve().parents[1]
LEGACY_HEAD = "20261020_1600"


@pytest.fixture
def migration_postgres(tmp_path):
    raw = os.getenv("CUSTOMER_CONTROL_TEST_DATABASE_URL")
    if not raw:
        pytest.skip(
            "An explicit disposable CUSTOMER_CONTROL_TEST_DATABASE_URL is required"
        )
    url = make_url(raw)
    database = url.database or ""
    if url.get_backend_name() != "postgresql" or not (
        database.startswith("test_") or database.endswith("_test")
    ):
        pytest.fail("Refusing a PostgreSQL database without a test_/_test name")
    schema = "customer_control_" + uuid4().hex
    admin = create_engine(url)
    with admin.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_engine(url, connect_args={"options": f"-csearch_path={schema}"})
    # An allowlist prevents the caller's provider keys and application .env from
    # reaching the migration process. Its cwd and every storage root are private.
    environ = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "PYTHONPATH": str(BACKEND),
        "POSTGRES_HOST": url.host or "127.0.0.1",
        "POSTGRES_PORT": str(url.port or 5432),
        "POSTGRES_USER": url.username or "",
        "POSTGRES_PASSWORD": url.password or "",
        "POSTGRES_DB": database,
        "PGOPTIONS": f"-csearch_path={schema}",
        "PGPASSWORD": url.password or "",
        "STORAGE_LOCAL_ROOT": str(tmp_path / "media"),
        "PPR_STORAGE_ROOT": str(tmp_path / "documents"),
        "CAMERA_VIEW_STORAGE_ROOT": str(tmp_path / "camera-views"),
        "CELERY_EAGER": "true",
        "PHOTO_VLM_ENABLED": "false",
        "REPORT_LLM_ENABLED": "false",
    }

    def migrate(target: str):
        code = (
            "from alembic.config import Config; from alembic import command; "
            f"cfg=Config({str(BACKEND / 'alembic.ini')!r}); "
            f"cfg.set_main_option('script_location', {str(BACKEND / 'alembic')!r}); "
            f"command.upgrade(cfg, {target!r})"
        )
        result = subprocess.run(
            [sys.executable, "-c", code],
            cwd=tmp_path,
            env=environ,
            text=True,
            capture_output=True,
            check=False,
            timeout=90,
        )
        assert result.returncode == 0, result.stdout + result.stderr

    try:
        yield SimpleNamespace(
            engine=engine,
            admin=admin,
            url=url,
            schema=schema,
            migrate=migrate,
            environ=environ,
            root=tmp_path,
        )
    finally:
        engine.dispose()
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        admin.dispose()


def _table(connection, name):
    return Table(name, MetaData(), autoload_with=connection)


def _seed_legacy(state):
    at = datetime(2026, 10, 19, 10, tzinfo=UTC)
    owner, viewer, orphan = uuid4(), uuid4(), uuid4()
    private, readonly, holding, demo = uuid4(), uuid4(), uuid4(), uuid4()
    document, video, incident = uuid4(), uuid4(), uuid4()
    demo_document, demo_video = uuid4(), uuid4()
    duplicate_ids = [uuid4(), uuid4()]
    original = state.root / "immutable-original.pdf"
    original.write_bytes(b"%PDF-1.4\nExplicit synthetic migration original\n")
    digest = hashlib.sha256(original.read_bytes()).hexdigest()
    with state.engine.begin() as connection:
        connection.execute(
            _table(connection, "users").insert(),
            [
                {
                    "id": owner,
                    "username": "migration-owner",
                    "name": "Owner",
                    "role": "admin",
                },
                {
                    "id": viewer,
                    "username": "migration-viewer",
                    "name": "Viewer",
                    "role": "viewer",
                },
                {
                    "id": orphan,
                    "username": "unassigned-admin",
                    "name": "Unassigned",
                    "role": "admin",
                },
            ],
        )
        projects = [
            (private, "MIGRATION-PRIVATE", "migration-owner"),
            (readonly, "MIGRATION-VIEWER", "migration-viewer"),
            (holding, "MIGRATION-HOLDING", None),
            (demo, "MANAGEMENT-DEMO", None),
        ]
        connection.execute(
            _table(connection, "projects").insert(),
            [
                {
                    "id": project,
                    "code": code,
                    "name": code,
                    "owner_username": username,
                    "timezone": "Europe/Moscow",
                    "shift_start": time(8),
                    "shift_end": time(20),
                    "status": "active",
                }
                for project, code, username in projects
            ],
        )
        connection.execute(
            _table(connection, "ppr_documents")
            .insert()
            .values(
                id=document,
                project_id=private,
                filename="original.pdf",
                media_type="application/pdf",
                size_bytes=original.stat().st_size,
                sha256=digest,
                storage_key="immutable-original.pdf",
                uploaded_by="Owner",
                preview_kind="pdf",
            )
        )
        connection.execute(
            _table(connection, "video_assets")
            .insert()
            .values(
                id=video,
                project_id=private,
                filename="missing-legacy.mp4",
                storage_key="missing-legacy.mp4",
                start_timestamp=at,
                status="READY",
            )
        )
        connection.execute(
            _table(connection, "ppr_documents")
            .insert()
            .values(
                id=demo_document,
                project_id=demo,
                filename="unknown-legacy-demo-upload.pdf",
                media_type="application/pdf",
                size_bytes=original.stat().st_size,
                sha256=digest,
                storage_key="immutable-original.pdf",
                uploaded_by="Unknown historical demo uploader",
                preview_kind="pdf",
            )
        )
        connection.execute(
            _table(connection, "video_assets")
            .insert()
            .values(
                id=demo_video,
                project_id=demo,
                filename="unknown-legacy-demo-recording.mp4",
                storage_key="unknown-legacy-demo-recording.mp4",
                start_timestamp=at,
                status="READY",
            )
        )
        connection.execute(
            _table(connection, "incidents")
            .insert()
            .values(
                id=incident,
                project_id=private,
                code="MIGRATION-INCIDENT",
                category="equipment",
                type="equipment_missing",
                title="Legacy resolved",
                status="resolved",
                priority="medium",
                confidence=0.8,
                dedup_key="preserve-this-legacy-key",
                first_seen_at=at,
                last_seen_at=at,
                resolved_at=at,
                explanation={"source": "synthetic", "sha256": digest},
            )
        )
        for index, duplicate_id in enumerate(duplicate_ids):
            connection.execute(
                _table(connection, "incidents")
                .insert()
                .values(
                    id=duplicate_id,
                    project_id=private,
                    code=f"MIGRATION-OPEN-{index}",
                    category="equipment",
                    type="equipment_missing",
                    title="Existing duplicate retained without inventing a decision",
                    status="confirmed" if index == 0 else "in_progress",
                    priority="medium",
                    confidence=0.5,
                    dedup_key="existing-open-duplicate-key",
                    first_seen_at=at + timedelta(minutes=index),
                    last_seen_at=at + timedelta(minutes=index),
                    explanation={"source": "legacy-synthetic", "duplicate": index},
                )
            )
    return SimpleNamespace(
        owner=owner,
        viewer=viewer,
        orphan=orphan,
        private=private,
        readonly=readonly,
        holding=holding,
        demo=demo,
        document=document,
        video=video,
        incident=incident,
        original=original,
        digest=digest,
        duplicate_ids=duplicate_ids,
        demo_document=demo_document,
        demo_video=demo_video,
    )


def _legacy_snapshot(state):
    columns = {
        "users": ("id", "username", "role"),
        "projects": ("id", "code", "owner_username"),
        "ppr_documents": ("id", "project_id", "sha256", "storage_key", "size_bytes"),
        "video_assets": ("id", "project_id", "storage_key", "start_timestamp"),
        "incidents": (
            "id",
            "project_id",
            "status",
            "dedup_key",
            "explanation",
            "first_seen_at",
            "last_seen_at",
            "resolved_at",
        ),
    }
    snapshot = {}
    with state.engine.connect() as connection:
        for name, names in columns.items():
            table = _table(connection, name)
            snapshot[name] = [
                dict(row)
                for row in connection.execute(
                    select(*(table.c[column] for column in names)).order_by(table.c.id)
                ).mappings()
            ]
    return snapshot


def test_upgrade_and_backup_restore_preserve_legacy_ids_hashes_and_roles(
    migration_postgres,
):
    state = migration_postgres
    state.migrate(LEGACY_HEAD)
    fixture = _seed_legacy(state)
    before = _legacy_snapshot(state)
    state.migrate("head")
    assert _legacy_snapshot(state) == before
    assert hashlib.sha256(fixture.original.read_bytes()).hexdigest() == fixture.digest
    _restore_snapshot(state, before, fixture)


def test_backfill_keeps_viewer_and_orphan_admin_restricted_with_honest_provenance(
    migration_postgres,
):
    state = migration_postgres
    state.migrate(LEGACY_HEAD)
    fixture = _seed_legacy(state)
    state.migrate("head")
    with state.engine.connect() as connection:
        assignments = _table(connection, "project_assignments")
        memberships = _table(connection, "organization_memberships")
        participations = _table(connection, "project_organizations")
        organizations = _table(connection, "organizations")
        projects = _table(connection, "projects")
        incidents = _table(connection, "incidents")
        ledger = _table(connection, "migration_ledger")
        grants = (
            select(
                assignments.c.role,
                assignments.c.scope_kind,
                assignments.c.status,
                memberships.c.can_create_projects,
                memberships.c.can_manage_members,
            )
            .join(memberships, memberships.c.id == assignments.c.membership_id)
            .join(
                participations,
                participations.c.id == assignments.c.participation_id,
            )
        )
        owner = (
            connection.execute(
                grants.where(
                    memberships.c.user_id == fixture.owner,
                    participations.c.project_id == fixture.private,
                )
            )
            .mappings()
            .all()
        )
        assert len(owner) == 1
        assert owner[0]["role"] == "customer_manager"
        viewer = (
            connection.execute(
                grants.where(
                    memberships.c.user_id == fixture.viewer,
                    participations.c.project_id == fixture.readonly,
                )
            )
            .mappings()
            .all()
        )
        assert len(viewer) == 1
        assert viewer[0]["role"] == "project_viewer"
        assert viewer[0]["can_create_projects"] is False
        assert viewer[0]["can_manage_members"] is False
        assert (
            connection.scalar(
                select(func.count())
                .select_from(assignments)
                .join(
                    memberships,
                    memberships.c.id == assignments.c.membership_id,
                )
                .where(memberships.c.user_id == fixture.orphan)
            )
            == 0
        )
        demo = (
            connection.execute(select(projects).where(projects.c.id == fixture.demo))
            .mappings()
            .one()
        )
        assert demo["kind"] == "shared_demo"
        # Upgrade never guesses which historic demo uploads were intended for
        # public access. Their IDs and bytes remain, but no manifest is inferred.
        assert demo["demo_manifest"] is None
        for name, source_id in (
            ("ppr_documents", fixture.demo_document),
            ("video_assets", fixture.demo_video),
        ):
            source = _table(connection, name)
            assert (
                connection.scalar(select(source.c.id).where(source.c.id == source_id))
                == source_id
            )
        holding = (
            connection.execute(select(projects).where(projects.c.id == fixture.holding))
            .mappings()
            .one()
        )
        assert holding["kind"] != "shared_demo"
        org = (
            connection.execute(
                select(organizations).where(
                    organizations.c.id == holding["customer_organization_id"],
                )
            )
            .mappings()
            .one()
        )
        assert (
            connection.scalar(
                select(func.count())
                .select_from(memberships)
                .where(
                    memberships.c.organization_id == org["id"],
                )
            )
            == 0
        )
        resolved = (
            connection.execute(
                select(incidents).where(incidents.c.id == fixture.incident)
            )
            .mappings()
            .one()
        )
        assert resolved["status"] == "resolved"
        assert resolved["resolution_origin"] == "legacy_unverified"
        duplicates = (
            connection.execute(
                select(incidents)
                .where(incidents.c.id.in_(fixture.duplicate_ids))
                .order_by(incidents.c.first_seen_at)
            )
            .mappings()
            .all()
        )
        assert len(duplicates) == 2
        assert [row["legacy_duplicate"] for row in duplicates] == [False, True]
        assert [row["status"] for row in duplicates] == ["confirmed", "in_progress"]
        retained = (
            connection.execute(
                select(ledger).where(ledger.c.legacy_kind == "legacy_open_duplicate")
            )
            .mappings()
            .all()
        )
        assert [row["legacy_id"] for row in retained] == [fixture.duplicate_ids[1]]
        assert retained[0]["confidence"] == "legacy_unverified"
        entries = (
            connection.execute(
                select(ledger).where(
                    ledger.c.legacy_id.in_(
                        [fixture.private, fixture.readonly, fixture.holding, fixture.demo]
                    ),
                )
            )
            .mappings()
            .all()
        )
        assert {row["legacy_id"] for row in entries} == {
            fixture.private,
            fixture.readonly,
            fixture.holding,
            fixture.demo,
        }
        assert all(row["basis"] and row["confidence"] for row in entries)


def _restore_snapshot(state, before, fixture):
    pg_dump, pg_restore = shutil.which("pg_dump"), shutil.which("pg_restore")
    if not pg_dump or not pg_restore:
        pytest.fail("pg_dump and pg_restore are required for the PostgreSQL rehearsal")
    backup = state.root / "customer-control.dump"
    flags = [
        "-h",
        state.url.host or "127.0.0.1",
        "-p",
        str(state.url.port or 5432),
        "-U",
        state.url.username or "",
        "-d",
        state.url.database or "",
    ]
    subprocess.run(
        [pg_dump, *flags, "-Fc", "--schema", state.schema, "-f", str(backup)],
        cwd=state.root,
        env=state.environ,
        check=True,
        capture_output=True,
        timeout=60,
    )
    # Drop only the random schema this fixture created, then restore its backup.
    state.engine.dispose()
    with state.admin.begin() as connection:
        connection.execute(text(f'DROP SCHEMA "{state.schema}" CASCADE'))
    subprocess.run(
        [pg_restore, *flags, "--exit-on-error", "--no-owner", str(backup)],
        cwd=state.root,
        env=state.environ,
        check=True,
        capture_output=True,
        timeout=60,
    )
    assert _legacy_snapshot(state) == before
    assert hashlib.sha256(fixture.original.read_bytes()).hexdigest() == fixture.digest
