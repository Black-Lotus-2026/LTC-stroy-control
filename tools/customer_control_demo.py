"""Run a disposable local jury workspace with real authentication and R1 policy.

Usage: backend/.venv/bin/python tools/customer_control_demo.py --port 8991
New runs create a SQLite database and private storage in /private/tmp.
Use --resume-root to retain an existing disposable workspace after code changes.
The server binds only 127.0.0.1. No repository .env or production DB is loaded.
All people, source documents and observations are explicitly synthetic QA data.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8991)
    parser.add_argument("--seed-only", action="store_true")
    parser.add_argument(
        "--myvms-demo", action="store_true",
        help="Publish live demo cameras using backend/var/myvms-demo.env",
    )
    parser.add_argument(
        "--resume-root",
        type=Path,
        help="Resume only a previous disposable /private/tmp QA workspace",
    )
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("Use an unprivileged local port between 1024 and 65535")
    repo = Path(__file__).resolve().parents[1]
    if args.myvms_demo:
        from dotenv import dotenv_values

        live_env = repo / "backend" / "var" / "myvms-demo.env"
        if not live_env.is_file():
            parser.error("Create backend/var/myvms-demo.env; see docs/myvms-live-demo.md")
        allowed = {
            "MYVMS_DEMO_ENABLED", "MYVMS_BASE_URL", "MYVMS_USERNAME",
            "MYVMS_PASSWORD", "MYVMS_DEMO_CHANNELS",
        }
        os.environ.update({
            key: value for key, value in dotenv_values(live_env).items()
            if key in allowed and value is not None
        })
    if args.resume_root:
        root = args.resume_root.resolve()
        if (
            root.parent != Path("/private/tmp")
            or not root.name.startswith("ltc-customer-qa.")
            or not (root / "qa-state.json").is_file()
            or not (root / "jury.sqlite").is_file()
        ):
            parser.error(
                "Resume requires an existing disposable ltc-customer-qa workspace"
            )
    else:
        root = Path(tempfile.mkdtemp(prefix="ltc-customer-qa.", dir="/private/tmp"))
    secret_path = root / ".qa-jwt-secret"
    if secret_path.exists():
        jwt_secret = secret_path.read_text()
    else:
        jwt_secret = "local-disposable-qa-" + uuid4().hex
        secret_path.write_text(jwt_secret)
        secret_path.chmod(0o600)
    # Pydantic reads .env relative to cwd. Change BEFORE importing application code.
    os.chdir(root)
    sys.path.insert(0, str(repo / "backend"))
    os.environ.update(
        {
            "POSTGRES_HOST": "127.0.0.1",
            "POSTGRES_PORT": "9",
            "POSTGRES_USER": "disabled",
            "POSTGRES_PASSWORD": "disabled",
            "POSTGRES_DB": "test_disabled",
            "REDIS_HOST": "127.0.0.1",
            "REDIS_PORT": "9",
            "CELERY_EAGER": "true",
            "DEBUG": "false",
            "STORAGE_LOCAL_ROOT": str(root / "storage"),
            "PPR_STORAGE_ROOT": str(root / "documents"),
            "CAMERA_VIEW_STORAGE_ROOT": str(root / "camera-views"),
            "STORAGE_PUBLIC_URL": f"http://127.0.0.1:{args.port}/media",
            "PPR_PROVIDER": "ollama",
            "PPR_OLLAMA_URL": "http://127.0.0.1:9",
            "PHOTO_VLM_ENABLED": "false",
            "REPORT_LLM_ENABLED": "false",
            "OPENROUTER_API_KEY": "",
            "OPENAI_API_KEY": "",
            "CAMERA_ALLOWED_NETWORKS": "[]",
            "CAMERA_ALLOW_RTSP_CAPTURE": "false",
            "JWT_SECRET_KEY": jwt_secret,
        }
    )
    from sqlalchemy import create_engine, event
    from sqlalchemy.dialects.postgresql import JSONB
    from sqlalchemy.ext.compiler import compiles
    from sqlalchemy.orm import sessionmaker

    @compiles(JSONB, "sqlite")
    def _jsonb_sqlite(type_, compiler, **kwargs):
        return "JSON"

    import app.db.session as application_db
    from app.core.config import settings
    from app.db.base import Base

    engine = create_engine(
        "sqlite:///" + str(root / "jury.sqlite"),
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(engine, "connect")
    def _foreign_keys(connection, record):
        connection.execute("PRAGMA foreign_keys=ON")

    application_db.engine.dispose()
    application_db.engine = engine
    application_db.SessionLocal = sessionmaker(
        bind=engine,
        autoflush=False,
        expire_on_commit=False,
    )
    # SMTP may have been supplied through the invoking shell; QA never sends mail.
    settings.smtp_host = None
    settings.smtp_username = None
    settings.smtp_password = None
    from app.main import app

    Base.metadata.create_all(engine)
    if args.resume_root:
        _expand_disposable_schema(engine)
    with application_db.SessionLocal() as db:
        if args.resume_root:
            state = json.loads((root / "qa-state.json").read_text())
            _restore_qa_source_links(db, state)
        else:
            state = seed(db, root)
        _seed_shared_example(db, root, state)
        db.commit()
    state.update(
        {
            "root": str(root),
            "api": f"http://127.0.0.1:{args.port}",
            "notice": "Synthetic local QA. No external AI, SMTP or production database.",
        }
    )
    (root / "qa-state.json").write_text(json.dumps(state, ensure_ascii=False, indent=2))
    print(json.dumps(state, ensure_ascii=False, indent=2), flush=True)
    if not args.seed_only:
        import uvicorn

        uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="info")


def _expand_disposable_schema(engine):
    """Only nullable R1 additions in this disposable SQLite, never production."""
    from sqlalchemy import inspect, text

    additions = {
        "generated_reports": {
            "requester_assignment_id": "UUID REFERENCES project_assignments(id)",
            "scope_authorization_version": "INTEGER",
            "report_kind": "VARCHAR(16)",
            "source_scope": "JSON",
        },
        "video_assets": {"analysis_result": "JSON"},
        "projects": {"demo_manifest": "JSON"},
    }
    with engine.begin() as connection:
        for table, columns in additions.items():
            present = {column["name"] for column in inspect(engine).get_columns(table)}
            for column, declaration in columns.items():
                if column not in present:
                    connection.execute(
                        text(f"ALTER TABLE {table} ADD COLUMN {column} {declaration}")
                    )


def _restore_qa_source_links(db, state):
    from uuid import UUID

    from app.models import Incident, Project, User
    from app.models.customer_control import (
        IncidentBasis,
        IncidentRequirementLink,
        OrganizationMembership,
        ProjectAssignment,
        ProjectDeadlinePolicy,
        ProjectOrganization,
        RequirementRevision,
    )
    from sqlalchemy import select

    # This fixture's separate shared demo was intentionally empty. Its manifest
    # is never expanded from a database query, so unexpected files stay private.
    demo = db.get(Project, UUID(state["shared_demo_id"]))
    if demo and demo.kind == "shared_demo" and demo.demo_manifest is None:
        demo.demo_manifest = _empty_demo_manifest()
    for basis in db.scalars(select(IncidentBasis)):
        incident = db.get(Incident, basis.incident_id)
        for citation in basis.snapshot.get("citations", []):
            revision_id = UUID(citation["requirement_revision_id"])
            revision = db.get(RequirementRevision, revision_id)
            if (
                revision
                and incident
                and revision.project_id == incident.project_id
                and db.get(IncidentRequirementLink, (incident.id, revision_id)) is None
            ):
                db.add(
                    IncidentRequirementLink(
                        incident_id=incident.id, revision_id=revision_id
                    )
                )
    manager = db.scalar(select(User).where(User.username == "qa_manager"))
    if manager:
        for project in db.scalars(select(Project).where(Project.kind == "jury")):
            if db.scalar(
                select(ProjectDeadlinePolicy.id).where(
                    ProjectDeadlinePolicy.project_id == project.id
                )
            ):
                continue
            assignment = db.scalar(
                select(ProjectAssignment)
                .join(
                    ProjectOrganization,
                    ProjectOrganization.id == ProjectAssignment.participation_id,
                )
                .join(
                    OrganizationMembership,
                    OrganizationMembership.id == ProjectAssignment.membership_id,
                )
                .where(
                    ProjectOrganization.project_id == project.id,
                    ProjectAssignment.role == "customer_manager",
                    OrganizationMembership.user_id == manager.id,
                )
            )
            if assignment:
                db.add(
                    ProjectDeadlinePolicy(
                        project_id=project.id,
                        version=1,
                        approved_by=manager.id,
                        approved_assignment_id=assignment.id,
                        reaction_minutes=60,
                        remediation_minutes=1440,
                        review_minutes=1440,
                        reason="Явно подготовленная политика синтетического локального QA",
                    )
                )


def _empty_demo_manifest():
    from app.schemas.customer_control import DemoManifestDTO

    return DemoManifestDTO().model_dump(mode="json")


def _seed_shared_example(db, root: Path, state):
    """Publish only a new, separately created synthetic common-demo example."""
    from uuid import UUID

    from PIL import Image, ImageDraw, ImageFont

    from app.models import Incident, Project, Zone
    from app.models.customer_control import (
        EvidenceAsset,
        IncidentBasis,
        IncidentEvidenceLink,
    )
    from app.models.enums import (
        IncidentCategory,
        IncidentPriority,
        IncidentStatus,
        IncidentType,
    )
    from app.schemas.customer_control import DemoManifestDTO, IncidentBasisDTO
    from app.services.incident_workflow import digest

    # A resumed fixture uses its persisted exact IDs, never a query of all rows.
    if state.get("shared_demo_case_id"):
        return
    demo = db.get(Project, UUID(state["shared_demo_id"]))
    if demo is None or demo.kind != "shared_demo":
        raise RuntimeError("Disposable QA demo identity does not match its saved state")
    at = datetime.now(UTC)
    zone = Zone(
        project_id=demo.id,
        code="QA-COMMON-" + uuid4().hex[:8],
        name="Синтетическая общая демонстрация",
    )
    db.add(zone)
    db.flush()
    incident = Incident(
        project_id=demo.id,
        zone_id=zone.id,
        code="QA-COMMON-" + uuid4().hex[:6],
        title="Учебное обнаружение · отдельная общая демонстрация",
        description="Синтетический пример интерфейса. Не реальный вывод о строительстве.",
        category=IncidentCategory.CAMERA,
        type=IncidentType.CAMERA_VISIBILITY,
        case_kind="control_integrity",
        status=IncidentStatus.PENDING,
        priority=IncidentPriority.LOW,
        dedup_key="qa-common-synthetic-" + uuid4().hex,
        first_seen_at=at,
        last_seen_at=at,
        detected_at=at,
        confidence=0,
    )
    db.add(incident)
    db.flush()
    key = "evidence/shared-demo-" + uuid4().hex + ".png"
    path = root / "storage" / key
    path.parent.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGB", (1100, 650), "#e8f1f4")
    font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 36)
    ImageDraw.Draw(image).multiline_text(
        (45, 100),
        "СИНТЕТИЧЕСКАЯ ОБЩАЯ ДЕМОНСТРАЦИЯ\n"
        "Не реальное обнаружение\nОтдельный пример · только просмотр",
        fill="#183748",
        font=font,
        spacing=34,
    )
    image.save(path)
    evidence = EvidenceAsset(
        project_id=demo.id,
        storage_key=key,
        media_type="image/png",
        size_bytes=path.stat().st_size,
        sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
        source="legacy",
        integrity="verified",
        captured_at=at,
    )
    db.add(evidence)
    db.flush()
    db.add(
        IncidentEvidenceLink(
            incident_id=incident.id, asset_id=evidence.id, kind="context"
        )
    )
    snapshot = IncidentBasisDTO(
        project_id=demo.id,
        observed_from=at,
        observed_until=at,
        provenance="legacy",
        source_evidence_ids=[evidence.id],
        coverage={"status": "unknown", "reasons": ["unknown_geometry"]},
        limitations=["Отдельная синтетическая общая демонстрация, не результат YOLO."],
    ).model_dump(mode="json")
    db.add(
        IncidentBasis(
            incident_id=incident.id, snapshot=snapshot, sha256=digest(snapshot)
        )
    )
    demo.demo_manifest = DemoManifestDTO(
        zone_ids=[zone.id],
        incident_ids=[incident.id],
        evidence_ids=[evidence.id],
    ).model_dump(mode="json")
    state["shared_demo_case_id"] = str(incident.id)
    state["shared_demo_evidence_id"] = str(evidence.id)


def seed(db, root: Path) -> dict:
    from app.core.security import hash_password
    from app.models import (
        Camera,
        Incident,
        IncidentEvent,
        IncidentEventType,
        PprAnalysis,
        PprDocument,
        PprPage,
        PprRequirement,
        Project,
        User,
        UserRole,
        Zone,
    )
    from app.models.customer_control import (
        AssignmentArea,
        ControlRelease,
        ControlReleaseItem,
        DocumentSeries,
        EvidenceAsset,
        EvidenceDisclosure,
        IncidentBasis,
        IncidentEvidenceLink,
        IncidentRequirementLink,
        Organization,
        OrganizationMembership,
        ParticipationPeriod,
        ProjectAssignment,
        ProjectDeadlinePolicy,
        ProjectOrganization,
        ProjectRole,
        ReleaseStatus,
        RequirementRevision,
        ResponsibilityArea,
    )
    from app.models.enums import (
        IncidentCategory,
        IncidentPriority,
        IncidentStatus,
        IncidentType,
    )
    from app.schemas.customer_control import IncidentBasisDTO
    from app.services.incident_workflow import digest
    from app.services.ppr_extraction import text_hash
    from PIL import Image, ImageDraw, ImageFont

    password = "LocalQa2026!"
    users = {}
    user_specs = {
        "manager": "QA · Управляющий заказчика",
        "manager2": "QA · Второй управляющий",
        "foreman": "QA · Прораб подрядчика 1",
        "foreman2": "QA · Прораб подрядчика 2",
        "pto": "QA · Инженер ПТО подрядчика 1",
        "viewer": "QA · Наблюдатель",
    }
    for key, name in user_specs.items():
        users[key] = User(
            username="qa_" + key,
            name=name,
            role=UserRole.VIEWER,
            hashed_password=hash_password(password),
        )
    organizations = {
        key: Organization(name=name)
        for key, name in {
            "customer": "QA · Заказчик",
            "k1": "QA · Подрядчик 1",
            "k2": "QA · Подрядчик 2",
        }.items()
    }
    db.add_all([*users.values(), *organizations.values()])
    db.flush()
    project = Project(
        code="QA-JURY-" + uuid4().hex[:8],
        name="Локальный объект жюри · синтетический QA",
        customer_organization_id=organizations["customer"].id,
        kind="jury",
        authorization_version=2,
    )
    demo = Project(
        code="MANAGEMENT-DEMO",
        name="Общая демонстрация · только чтение",
        kind="shared_demo",
        authorization_version=2,
        demo_manifest=_empty_demo_manifest(),
    )
    db.add_all([project, demo])
    db.flush()
    parties = {
        key: ProjectOrganization(
            project_id=project.id,
            organization_id=organization.id,
            side="customer" if key == "customer" else "contractor",
        )
        for key, organization in organizations.items()
    }
    db.add_all(parties.values())
    zone = Zone(
        project_id=project.id,
        code="QA-ZONE-" + uuid4().hex[:8],
        name="Учебная зона работ · общий участок",
    )
    db.add(zone)
    db.flush()
    area = ResponsibilityArea(
        project_id=project.id,
        zone_id=zone.id,
        name="Учебная область работ · назначена двум подрядчикам",
    )
    db.add(area)
    db.flush()
    assignments = {}
    specs = {
        "manager": ("customer", ProjectRole.CUSTOMER_MANAGER),
        "manager2": ("customer", ProjectRole.CUSTOMER_MANAGER),
        "foreman": ("k1", ProjectRole.CONTRACTOR_FOREMAN),
        "foreman2": ("k2", ProjectRole.CONTRACTOR_FOREMAN),
        "pto": ("k1", ProjectRole.PTO_ENGINEER),
        "viewer": ("customer", ProjectRole.PROJECT_VIEWER),
    }
    for key, (party_key, role) in specs.items():
        member = OrganizationMembership(
            organization_id=organizations[party_key].id,
            user_id=users[key].id,
            can_manage_members=key in {"manager", "manager2"},
            can_create_projects=key in {"manager", "manager2"},
        )
        db.add(member)
        db.flush()
        assignment = ProjectAssignment(
            participation_id=parties[party_key].id,
            membership_id=member.id,
            role=role,
            scope_kind="project" if party_key == "customer" else "areas",
        )
        db.add(assignment)
        db.flush()
        if party_key != "customer":
            db.add(AssignmentArea(assignment_id=assignment.id, area_id=area.id))
        assignments[key] = assignment
    for party in parties.values():
        db.add(ParticipationPeriod(participation_id=party.id))
    db.add(
        ProjectDeadlinePolicy(
            project_id=project.id,
            version=1,
            approved_by=users["manager"].id,
            approved_assignment_id=assignments["manager"].id,
            reaction_minutes=60,
            remediation_minutes=1440,
            review_minutes=1440,
            reason="Явно подготовленная политика синтетического локального QA",
        )
    )

    font_path = "/System/Library/Fonts/Supplemental/Arial.ttf"
    font = ImageFont.truetype(font_path, 46)
    small = ImageFont.truetype(font_path, 34)
    quote = "На всей строительной площадке обязательно наличие экскаватора."
    original = Image.new("RGB", (1800, 1350), "white")
    draw = ImageDraw.Draw(original)
    lines = [
        "СИНТЕТИЧЕСКИЙ ППР ДЛЯ ЛОКАЛЬНОГО QA",
        "Учебный документ. Не рабочий проект.",
        "Страница 1",
        "",
        "Проверяемое требование:",
        "На всей строительной площадке",
        "обязательно наличие экскаватора.",
        "",
        "Источник подготовлен локально для проверки ролей,",
        "точных страниц, подачи и приёмки.",
        "ИИ и реальная камера в этой фикстуре не использованы.",
    ]
    y = 85
    for index, line in enumerate(lines):
        draw.text(
            (90, y), line, fill="#183748", font=font if index in {0, 4} else small
        )
        y += 88
    document_key = "qa/ppr-original.png"
    path = root / "documents" / document_key
    path.parent.mkdir(parents=True)
    original.save(path)
    document_hash = hashlib.sha256(path.read_bytes()).hexdigest()
    series = DocumentSeries(
        project_id=project.id,
        owner_participation_id=parties["k1"].id,
        title="Синтетический ППР · учебная версия",
    )
    db.add(series)
    db.flush()
    document = PprDocument(
        project_id=project.id,
        series_id=series.id,
        owner_participation_id=parties["k1"].id,
        area_id=area.id,
        filename="Синтетический ППР для QA.png",
        media_type="image/png",
        size_bytes=path.stat().st_size,
        sha256=document_hash,
        storage_key=document_key,
        uploaded_by=users["pto"].username,
        uploaded_by_user_id=users["pto"].id,
        preview_kind="image",
    )
    db.add(document)
    db.flush()
    analysis = PprAnalysis(
        document_id=document.id,
        project_id=project.id,
        document_sha256=document_hash,
        status="COMPLETED",
        pages_total=1,
        pages_processed=1,
        provider="synthetic-fixture",
        model="explicit-local-qa-seed",
    )
    db.add(analysis)
    db.flush()
    page = PprPage(
        analysis_id=analysis.id,
        page_number=1,
        status="COMPLETED",
        extraction_method="vision_ocr",
        text="СИНТЕТИЧЕСКИЙ ППР ДЛЯ ЛОКАЛЬНОГО QA\n" + quote,
        text_sha256=text_hash("СИНТЕТИЧЕСКИЙ ППР ДЛЯ ЛОКАЛЬНОГО QA\n" + quote),
        preview_key=document_key,
        preview_media_type="image/png",
        artifact_sha256=document_hash,
    )
    requirement = PprRequirement(
        analysis_id=analysis.id,
        project_id=project.id,
        document_id=document.id,
        document_sha256=document_hash,
        page_number=1,
        fingerprint="a" * 64,
        title="Учебное требование об экскаваторе",
        type="equipment_required",
        equipment_class="excavator",
        quote=quote,
        quote_verified=False,
        detector_supported=True,
        active=False,
        extraction_method="vision_ocr",
    )
    db.add_all([page, requirement])
    db.flush()
    at = datetime.now(UTC)
    revision_id = uuid4()
    citation = {
        "requirement_revision_id": str(revision_id),
        "document_id": str(document.id),
        "analysis_id": str(analysis.id),
        "document_sha256": document_hash,
        "page_number": 1,
        "page_artifact_sha256": document_hash,
        "quote": quote,
        "source_kind": "vision_ocr",
    }
    revision = RequirementRevision(
        id=revision_id,
        project_id=project.id,
        requirement_id=requirement.id,
        revision_no=1,
        owner_participation_id=parties["k1"].id,
        author_user_id=users["pto"].id,
        author_assignment_id=assignments["pto"].id,
        area_id=area.id,
        kind="equipment_required",
        equipment_class="excavator",
        quote=quote,
        review_status="verified",
        check_mode="automated",
        citation=citation,
        submitted=True,
    )
    release = ControlRelease(
        project_id=project.id,
        sequence=1,
        status=ReleaseStatus.ACTIVE,
        submitted_by=users["pto"].id,
        submitted_assignment_id=assignments["pto"].id,
        manifest_sha256=digest(citation),
        approved_by=users["manager"].id,
        approved_assignment_id=assignments["manager"].id,
        approved_at=at - timedelta(days=1),
        effective_from=at - timedelta(days=1),
        limitations=["Синтетическая фикстура локального QA"],
        note="Учебное утверждение при подготовке локальной фикстуры",
    )
    db.add_all([revision, release])
    db.flush()
    db.add(ControlReleaseItem(release_id=release.id, revision_id=revision.id))
    camera = Camera(
        project_id=project.id,
        zone_id=zone.id,
        code="QA-CAMERA-" + uuid4().hex[:8],
        name="Учебная камера · поток не подключён",
    )
    db.add(camera)
    db.flush()
    cases = {}
    for party_key, actor in (("k1", "foreman"), ("k2", "foreman2")):
        incident = Incident(
            project_id=project.id,
            zone_id=zone.id,
            area_id=area.id,
            camera_id=camera.id,
            code="QA-" + party_key.upper() + "-" + uuid4().hex[:6],
            title="Учебная задача подрядчика " + party_key[-1] + " · синтетический QA",
            description="Явно подготовленное учебное событие. Не результат реального YOLO.",
            category=IncidentCategory.EQUIPMENT,
            type=IncidentType.EQUIPMENT_MISSING,
            status=IncidentStatus.CONFIRMED,
            priority=IncidentPriority.MEDIUM,
            dedup_key="qa-synthetic-" + party_key,
            first_seen_at=at - timedelta(minutes=20),
            last_seen_at=at - timedelta(minutes=19),
            detected_at=at - timedelta(minutes=20),
            confirmed_at=at - timedelta(minutes=10),
            confirmed_by=users["manager"].id,
            origin_participation_id=parties[party_key].id,
            responsible_participation_id=parties[party_key].id,
            assignee_assignment_id=assignments[actor].id,
            assigned_user_id=users[actor].id,
            reaction_due_at=at + timedelta(hours=1),
            remediation_due_at=at + timedelta(days=1),
            explanation={
                "summary": "Синтетическая задача для локального QA",
                "ppr_requirements": [
                    citation
                    | {
                        "requirement_id": str(requirement.id),
                        "filename": document.filename,
                        "title": requirement.title,
                        "kind": "equipment_required",
                        "equipment_class": "excavator",
                        "release_id": str(release.id),
                        "manifest_sha256": release.manifest_sha256,
                        "source_url": f"/api/v1/projects/{project.id}/ppr-documents/{document.id}/pages/1/original?analysis_id={analysis.id}",
                    }
                ],
            },
        )
        db.add(incident)
        db.flush()
        db.add(
            IncidentRequirementLink(incident_id=incident.id, revision_id=revision.id)
        )
        picture = Image.new("RGB", (1280, 720), "#ecf3f7")
        ImageDraw.Draw(picture).multiline_text(
            (65, 100),
            "СИНТЕТИЧЕСКОЕ ДОКАЗАТЕЛЬСТВО QA\nУчебная задача "
            + party_key
            + "\nРеальная камера не использована",
            fill="#183748",
            font=small,
            spacing=38,
        )
        key = "evidence/" + party_key + ".png"
        evidence_path = root / "storage" / key
        evidence_path.parent.mkdir(parents=True, exist_ok=True)
        picture.save(evidence_path)
        evidence = EvidenceAsset(
            project_id=project.id,
            owner_participation_id=parties["customer"].id,
            storage_key=key,
            media_type="image/png",
            size_bytes=evidence_path.stat().st_size,
            sha256=hashlib.sha256(evidence_path.read_bytes()).hexdigest(),
            uploaded_by=users["manager"].id,
            source="legacy",
            integrity="verified",
            captured_at=at,
        )
        db.add(evidence)
        db.flush()
        db.add(
            IncidentEvidenceLink(
                incident_id=incident.id, asset_id=evidence.id, kind="context"
            )
        )
        db.add(
            EvidenceDisclosure(
                project_id=project.id,
                participation_id=parties[party_key].id,
                area_id=area.id,
                incident_id=incident.id,
                asset_id=evidence.id,
            )
        )
        db.add(
            EvidenceDisclosure(
                project_id=project.id,
                participation_id=parties[party_key].id,
                area_id=area.id,
                incident_id=incident.id,
                revision_id=revision.id,
            )
        )
        snapshot = IncidentBasisDTO(
            project_id=project.id,
            observed_from=at - timedelta(minutes=20),
            observed_until=at - timedelta(minutes=19),
            provenance="release",
            release_id=release.id,
            manifest_sha256=release.manifest_sha256,
            source_evidence_ids=[evidence.id],
            citations=[citation],
            coverage={"status": "unknown", "reasons": ["unknown_geometry"]},
            limitations=[
                "Синтетический QA. Реальный детектор и видеопоток не использованы."
            ],
        ).model_dump(mode="json")
        db.add(
            IncidentBasis(
                incident_id=incident.id, snapshot=snapshot, sha256=digest(snapshot)
            )
        )
        db.add(
            IncidentEvent(
                incident_id=incident.id,
                event_type=IncidentEventType.DETECTED,
                user_id=users["manager"].id,
                comment="Синтетическая фикстура локального QA",
            )
        )
        cases[party_key] = str(incident.id)
    db.flush()
    return {
        "project_id": str(project.id),
        "shared_demo_id": str(demo.id),
        "document_id": str(document.id),
        "requirement_id": str(requirement.id),
        "cases": cases,
        "accounts": {
            key: {
                "username": user.username,
                "password": password,
                "assignment_id": str(assignments[key].id),
            }
            for key, user in users.items()
        },
    }


if __name__ == "__main__":
    main()
