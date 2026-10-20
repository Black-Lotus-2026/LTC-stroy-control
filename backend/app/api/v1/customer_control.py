"""Typed commands; all selectors are verified against current database grants."""

from __future__ import annotations

import hashlib
import io
import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, File, Form, Header, Query, UploadFile
from fastapi.responses import FileResponse
from PIL import Image
from sqlalchemy import func, select

from app.api.deps import CurrentUser, DbSession
from app.models import (
    Incident,
    IncidentEvent,
    IncidentEventType,
    IncidentStatus,
    User,
)
from app.models.customer_control import (
    AssignmentArea,
    AuditEvent,
    ControlRelease,
    EvidenceAsset,
    EvidenceDisclosure,
    IncidentEvidenceLink,
    Organization,
    OrganizationMembership,
    ProjectAssignment,
    ProjectOrganization,
    ProjectRole,
    RequirementRevision,
    ResponsibilityArea,
)
from app.schemas.customer_control import (
    ApproveControlCommand,
    AssignIncidentCommand,
    AssignmentOptionDTO,
    AuditEventDTO,
    CommandResultDTO,
    ContextDTO,
    ControlReleaseDTO,
    CreateReleaseCommand,
    CreateRevisionCommand,
    DeadlineCommand,
    DecideDisputeCommand,
    DisputeDTO,
    EvidenceDTO,
    IncidentCommandDTO,
    IncidentDetailDTO,
    IncidentDTO,
    MetricsDTO,
    NamedOptionDTO,
    OpenDisputeCommand,
    ParticipantOptionsDTO,
    PublishEvidenceCommand,
    RequirementRevisionDTO,
    ReturnControlCommand,
    VersionedCommand,
)
from app.services.access_policy import (
    assignment_query,
    fail,
    incident_query,
    resolve_context,
)
from app.services.control_releases import (
    create_release,
    create_revision,
    release_command,
    release_dto,
    revision_dto,
)
from app.services.incident_workflow import (
    OPEN,
    audit,
    aware,
    check_version,
    decide_dispute,
    detail_dto,
    evidence_dto,
    execute_command,
    incident_dto,
    load_incident,
    open_dispute,
    receipt,
    save_receipt,
    validate_assets,
    validate_assignment,
    values,
    visible_evidence_query,
)
from app.services.ppr_documents import original_path, private_root

router = APIRouter(prefix="/customer-control", tags=["Контроль заказчика"])
contexts_router = APIRouter(tags=["Рабочие назначения"])
Key = Annotated[uuid.UUID | None, Header(alias="Idempotency-Key")]


def context_dto(db, ctx):
    org = db.get(Organization, ctx.membership.organization_id) if ctx.membership else None
    return ContextDTO(
        organization_id=org.id if org else None,
        membership_id=ctx.membership.id if ctx.membership else None,
        project_id=ctx.project.id,
        participation_id=ctx.participation.id if ctx.participation else None,
        assignment_id=ctx.assignment.id if ctx.assignment else None,
        organization_name=org.name if org else "Общая демонстрация",
        project_name=ctx.project.name,
        role=ctx.role,
        side=ctx.side,
        scope={"kind": "project"}
        if ctx.is_demo or ctx.assignment.scope_kind == "project"
        else {"kind": "areas", "area_ids": list(ctx.area_ids)},
        authorization_version=ctx.project.authorization_version,
        effective_permissions=sorted(ctx.permissions),
        is_demo=ctx.is_demo,
        lifecycle=ctx.project.lifecycle,
    )


@contexts_router.get("/auth/contexts", response_model=list[ContextDTO])
def contexts(db: DbSession, user: CurrentUser):
    from app.models import Project

    original = db.info.pop("assignment_id", None)
    original_membership = db.info.pop("membership_id", None)
    result = []
    try:
        for a, p, _m in db.execute(assignment_query(user)):
            db.info["assignment_id"] = a.id
            try:
                ctx = resolve_context(db, p.project_id, user)
            except __import__("fastapi").HTTPException:
                continue
            result.append(context_dto(db, ctx))
        db.info.pop("assignment_id", None)
        for project in db.scalars(select(Project).where(Project.kind == "shared_demo")):
            result.append(context_dto(db, resolve_context(db, project.id, user)))
    finally:
        db.info.pop("assignment_id", None)
        if original:
            db.info["assignment_id"] = original
        if original_membership:
            db.info["membership_id"] = original_membership
    return result


@router.get("/projects/{project_id}/context", response_model=ContextDTO)
def project_context(project_id: uuid.UUID, db: DbSession, user: CurrentUser):
    return context_dto(db, resolve_context(db, project_id, user))


@router.get("/projects/{project_id}/participants", response_model=ParticipantOptionsDTO)
def participants(project_id: uuid.UUID, db: DbSession, user: CurrentUser):
    ctx = resolve_context(db, project_id, user)
    if ctx.is_demo:
        return ParticipantOptionsDTO(participations=[], assignments=[], areas=[])
    manager = ctx.role == ProjectRole.CUSTOMER_MANAGER
    parties = select(ProjectOrganization).where(
        ProjectOrganization.project_id == project_id,
        ProjectOrganization.status == "active",
    )
    areas = select(ResponsibilityArea).where(ResponsibilityArea.project_id == project_id)
    if not manager:
        parties = parties.where(ProjectOrganization.id == ctx.participation.id)
        if ctx.assignment.scope_kind != "project":
            areas = areas.where(ResponsibilityArea.id.in_(ctx.area_ids))
    party_list = list(db.scalars(parties))
    assignments = []
    if manager:
        for a, _m, person in db.execute(
            select(ProjectAssignment, OrganizationMembership, User)
            .join(
                OrganizationMembership,
                ProjectAssignment.membership_id == OrganizationMembership.id,
            )
            .join(User, User.id == OrganizationMembership.user_id)
            .where(
                ProjectAssignment.participation_id.in_([p.id for p in party_list]),
                ProjectAssignment.status == "active",
                OrganizationMembership.status == "active",
                User.is_active.is_(True),
            )
        ):
            assignments.append(
                AssignmentOptionDTO(
                    id=a.id,
                    name=person.name,
                    role=a.role,
                    participation_id=a.participation_id,
                    area_ids=list(
                        db.scalars(
                            select(AssignmentArea.area_id).where(
                                AssignmentArea.assignment_id == a.id
                            )
                        )
                    ),
                )
            )
    return ParticipantOptionsDTO(
        participations=[
            NamedOptionDTO(id=p.id, name=organization.name)
            for p in party_list
            if (organization := db.get(Organization, p.organization_id))
        ],
        assignments=assignments,
        areas=[NamedOptionDTO(id=a.id, name=a.name) for a in db.scalars(areas)],
    )


@router.get("/projects/{project_id}/incidents", response_model=list[IncidentDTO])
def incidents(
    project_id: uuid.UUID,
    db: DbSession,
    user: CurrentUser,
    status: IncidentStatus | None = None,
    limit: int = Query(100, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    ctx = resolve_context(db, project_id, user, "incident.read")
    query = incident_query(db, ctx)
    if status:
        query = query.where(Incident.status == status)
    return [
        incident_dto(db, ctx, row)
        for row in db.scalars(
            query.order_by(Incident.first_seen_at.desc(), Incident.id)
            .offset(offset)
            .limit(limit)
        )
    ]


@router.get("/incidents/{incident_id}", response_model=IncidentDetailDTO)
def incident_detail(incident_id: uuid.UUID, db: DbSession, user: CurrentUser):
    ctx, row = load_incident(db, incident_id, user)
    return detail_dto(db, ctx, row)


@router.post("/incidents/{incident_id}/commands", response_model=CommandResultDTO)
def incident_command(
    incident_id: uuid.UUID,
    data: IncidentCommandDTO,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    return execute_command(db, incident_id, user, data, idempotency_key)


@router.post("/incidents/{incident_id}/assignments", response_model=IncidentDTO)
def assign_incident(
    incident_id: uuid.UUID,
    data: AssignIncidentCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    ctx, row = load_incident(db, incident_id, user, "incident.assign", True)
    route, payload = f"incidents/{row.id}/assignments", data.model_dump(mode="json")
    replay, key, cid = receipt(db, ctx, route, idempotency_key, payload)
    if not replay:
        check_version(row, data.expected_version)
        if row.status not in OPEN:
            fail("INVALID_TRANSITION", 409)
        old_party = row.responsible_participation_id
        validate_assignment(
            db,
            ctx,
            row,
            data.responsible_participation_id,
            data.assignee_assignment_id,
            data.area_id,
        )
        if (
            row.status == IncidentStatus.REMEDIATION_SUBMITTED
            and old_party != row.responsible_participation_id
        ):
            row.status = IncidentStatus.CONFIRMED
            row.review_due_at = None
        row.row_version += 1
        audit_event = audit(
            db,
            ctx,
            "incident.assigned",
            row.id,
            f"{old_party} → {row.responsible_participation_id}: {data.note}",
        )
        save_receipt(db, ctx, route, key, cid, payload, row.id, audit_event.id)
        db.add(
            IncidentEvent(
                incident_id=row.id,
                event_type=IncidentEventType.ASSIGNED,
                user_id=user.id,
                comment=data.note,
            )
        )
        db.commit()
    return incident_dto(db, ctx, row)


@router.post("/incidents/{incident_id}/deadline-changes", response_model=IncidentDTO)
def change_deadline(
    incident_id: uuid.UUID,
    data: DeadlineCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    ctx, row = load_incident(db, incident_id, user, "incident.deadline", True)
    route, payload = f"incidents/{row.id}/deadline-changes", data.model_dump(mode="json")
    replay, key, cid = receipt(db, ctx, route, idempotency_key, payload)
    if not replay:
        check_version(row, data.expected_version)
        if row.status not in OPEN or data.remediation_due_at <= datetime.now(UTC):
            fail("INVALID_TRANSITION", 409)
        event = audit(
            db,
            ctx,
            "incident.deadline_changed",
            row.id,
            f"{aware(row.remediation_due_at)} → {data.remediation_due_at}: {data.reason}",
        )
        row.remediation_due_at = data.remediation_due_at
        row.row_version += 1
        save_receipt(db, ctx, route, key, cid, payload, row.id, event.id)
        db.commit()
    return incident_dto(db, ctx, row)


@router.post(
    "/incidents/{incident_id}/evidence", response_model=EvidenceDTO, status_code=201
)
async def append_evidence(
    incident_id: uuid.UUID,
    db: DbSession,
    user: CurrentUser,
    file: Annotated[UploadFile, File()],
    expected_version: Annotated[int, Form(ge=1)],
    idempotency_key: Key = None,
):
    ctx, row = load_incident(db, incident_id, user, "evidence.append", True)
    raw = await file.read(20 * 1024 * 1024 + 1)
    if len(raw) > 20 * 1024 * 1024:
        fail("UPLOAD_TOO_LARGE", 413)
    mime: str | None
    if raw.startswith(b"%PDF-"):
        from pypdf import PdfReader

        try:
            PdfReader(io.BytesIO(raw), strict=True)
        except Exception:
            fail("UNSUPPORTED_MEDIA_TYPE", 415, "Повреждённый PDF")
        mime = "application/pdf"
    else:
        try:
            with Image.open(io.BytesIO(raw)) as image:
                mime = Image.MIME.get(image.format)
                image.verify()
            if mime not in {"image/png", "image/jpeg", "image/webp"}:
                fail("UNSUPPORTED_MEDIA_TYPE", 415)
        except (OSError, ValueError):
            fail("UNSUPPORTED_MEDIA_TYPE", 415, "Нужны JPEG, PNG, WebP или PDF")
    sha = hashlib.sha256(raw).hexdigest()
    route, payload = (
        f"incidents/{row.id}/evidence",
        {"sha256": sha, "expected_version": expected_version},
    )
    replay, key, cid = receipt(db, ctx, route, idempotency_key, payload)
    if replay:
        return evidence_dto(db.get(EvidenceAsset, replay.resource_id), ctx)
    check_version(row, expected_version)
    if row.status not in OPEN:
        fail(
            "INVALID_TRANSITION",
            409,
            "Закрытые дела сохраняются без изменения доказательств",
        )
    storage_key = f"evidence/{row.project_id}/{sha}"
    destination = private_root() / storage_key
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if destination.exists():
        if hashlib.sha256(destination.read_bytes()).hexdigest() != sha:
            fail("VALIDATION_ERROR", 422, "Нарушена целостность файла")
    else:
        with destination.open("xb") as output:
            output.write(raw)
    asset = EvidenceAsset(
        id=uuid.uuid4(),
        project_id=row.project_id,
        owner_participation_id=ctx.participation.id,
        storage_key=storage_key,
        sha256=sha,
        media_type=mime,
        size_bytes=len(raw),
        uploaded_by=user.id,
        source="upload",
        integrity="verified",
        captured_at=None,
        received_at=datetime.now(UTC),
    )
    db.add(asset)
    db.flush()
    db.add(
        IncidentEvidenceLink(
            incident_id=row.id,
            asset_id=asset.id,
            kind="after" if ctx.side == "contractor" else "context",
        )
    )
    row.row_version += 1
    event = audit(db, ctx, "evidence.appended", asset.id)
    save_receipt(db, ctx, route, key, cid, payload, asset.id, event.id)
    db.commit()
    return evidence_dto(asset, ctx)


@router.head("/evidence/{asset_id}/file", include_in_schema=False)
@router.get("/evidence/{asset_id}/file")
def evidence_file(asset_id: uuid.UUID, db: DbSession, user: CurrentUser):
    asset = db.get(EvidenceAsset, asset_id)
    if not asset:
        fail("RESOURCE_NOT_FOUND", 404)
    ctx = resolve_context(db, asset.project_id, user, "evidence.read")
    query = incident_query(db, ctx)
    if ctx.role == ProjectRole.PTO_ENGINEER:
        from app.services.document_context import document_incident_query

        query = document_incident_query(db, ctx)
    cases = db.scalars(
        query.where(
            Incident.id.in_(
                select(IncidentEvidenceLink.incident_id).where(
                    IncidentEvidenceLink.asset_id == asset_id
                )
            )
        )
    )
    visible = any(
        db.scalar(
            visible_evidence_query(db, ctx, case)
            .with_only_columns(EvidenceAsset.id)
            .where(EvidenceAsset.id == asset_id)
        )
        for case in cases
    )
    if not visible:
        fail("RESOURCE_NOT_FOUND", 404)
    from app.api.protected_media import evidence_response

    return evidence_response(db, asset)


@router.post("/incidents/{incident_id}/disclosures", response_model=IncidentDTO)
def disclose(
    incident_id: uuid.UUID,
    data: PublishEvidenceCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    ctx, row = load_incident(db, incident_id, user, "evidence.publish", True)
    party = db.get(ProjectOrganization, data.participation_id)
    if (
        not party
        or party.project_id != row.project_id
        or party.status != "active"
        or party.id != row.responsible_participation_id
    ):
        fail("RESOURCE_NOT_FOUND", 404)
    route, payload = f"incidents/{row.id}/disclosures", data.model_dump(mode="json")
    replay, key, cid = receipt(db, ctx, route, idempotency_key, payload)
    if not replay:
        check_version(row, data.expected_version)
        validate_assets(db, ctx, row, data.evidence_ids)
        # A card grant is explicit and separate from each disclosed byte/page.
        db.add(
            EvidenceDisclosure(
                project_id=row.project_id,
                participation_id=party.id,
                area_id=row.area_id,
                incident_id=row.id,
            )
        )
        for asset_id in data.evidence_ids:
            db.add(
                EvidenceDisclosure(
                    project_id=row.project_id,
                    participation_id=party.id,
                    area_id=row.area_id,
                    incident_id=row.id,
                    asset_id=asset_id,
                )
            )
        from app.models.customer_control import IncidentBasis

        basis = db.scalar(
            select(IncidentBasis).where(IncidentBasis.incident_id == row.id)
        )
        source_revision_ids = {
            c["requirement_revision_id"]
            for c in (basis.snapshot.get("citations", []) if basis else [])
        }
        for revision_id in data.revision_ids:
            if str(revision_id) not in source_revision_ids:
                fail("RESOURCE_NOT_FOUND", 404)
            db.add(
                EvidenceDisclosure(
                    project_id=row.project_id,
                    participation_id=party.id,
                    area_id=row.area_id,
                    incident_id=row.id,
                    revision_id=revision_id,
                )
            )
        row.row_version += 1
        event = audit(db, ctx, "evidence.disclosed", row.id)
        save_receipt(db, ctx, route, key, cid, payload, row.id, event.id)
        db.commit()
    return incident_dto(db, ctx, row)


@router.post(
    "/incidents/{incident_id}/disputes", response_model=DisputeDTO, status_code=201
)
def dispute_open(
    incident_id: uuid.UUID,
    data: OpenDisputeCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    row = open_dispute(db, incident_id, user, data, idempotency_key)
    return DisputeDTO(
        **values(
            row,
            (
                "id incident_id author_assignment_id reason note evidence_ids "
                "status row_version opened_at"
            ),
        )
    )


@router.post("/disputes/{dispute_id}/decide", response_model=DisputeDTO)
def dispute_decide(
    dispute_id: uuid.UUID,
    data: DecideDisputeCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    row = decide_dispute(db, dispute_id, user, data, idempotency_key)
    return DisputeDTO(
        **values(
            row,
            (
                "id incident_id author_assignment_id reason note evidence_ids "
                "status row_version opened_at"
            ),
        )
    )


@router.post("/disputes/{dispute_id}/withdraw", response_model=DisputeDTO)
def dispute_withdraw(
    dispute_id: uuid.UUID,
    data: ReturnControlCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    row = decide_dispute(db, dispute_id, user, data, idempotency_key, withdraw=True)
    return DisputeDTO(
        **values(
            row,
            (
                "id incident_id author_assignment_id reason note evidence_ids "
                "status row_version opened_at"
            ),
        )
    )


@router.get(
    "/projects/{project_id}/requirement-revisions",
    response_model=list[RequirementRevisionDTO],
)
def revisions(project_id: uuid.UUID, db: DbSession, user: CurrentUser):
    ctx = resolve_context(db, project_id, user, "document.read")
    from app.services.control_releases import revision_query

    query = revision_query(db, ctx)
    return [
        revision_dto(r)
        for r in db.scalars(
            query.order_by(
                RequirementRevision.created_at, RequirementRevision.revision_no
            )
        )
    ]


@router.post(
    "/requirements/{requirement_id}/revisions",
    response_model=RequirementRevisionDTO,
    status_code=201,
)
def revision_create(
    requirement_id: uuid.UUID,
    data: CreateRevisionCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    return revision_dto(create_revision(db, requirement_id, user, data, idempotency_key))


@router.get(
    "/projects/{project_id}/control-releases", response_model=list[ControlReleaseDTO]
)
def releases(project_id: uuid.UUID, db: DbSession, user: CurrentUser):
    ctx = resolve_context(db, project_id, user, "document.read")
    query = select(ControlRelease).where(ControlRelease.project_id == project_id)
    if ctx.is_demo:
        from app.models.customer_control import ControlReleaseItem
        from app.services.control_releases import revision_query

        query = query.where(
            ControlRelease.approved_at.is_not(None),
            ControlRelease.id.in_(
                select(ControlReleaseItem.release_id).where(
                    ControlReleaseItem.revision_id.in_(
                        revision_query(db, ctx).with_only_columns(RequirementRevision.id)
                    )
                )
            ),
        )
    if ctx.side == "contractor":
        from app.models.customer_control import ControlReleaseItem

        own = (
            select(ControlReleaseItem.release_id)
            .join(
                RequirementRevision,
                RequirementRevision.id == ControlReleaseItem.revision_id,
            )
            .where(
                RequirementRevision.owner_participation_id == ctx.participation.id,
                RequirementRevision.area_id.in_(ctx.area_ids),
            )
        )
        query = query.where(
            ControlRelease.id.in_(own),
            (ControlRelease.submitted_assignment_id == ctx.assignment.id)
            | ControlRelease.approved_at.is_not(None),
        )
    return [
        release_dto(db, ctx, r)
        for r in db.scalars(query.order_by(ControlRelease.sequence.desc()))
    ]


@router.post(
    "/projects/{project_id}/control-releases",
    response_model=ControlReleaseDTO,
    status_code=201,
)
def release_create(
    project_id: uuid.UUID,
    data: CreateReleaseCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    ctx, release = create_release(db, project_id, user, data, idempotency_key)
    return release_dto(db, ctx, release)


@router.post("/control-releases/{release_id}/submit", response_model=ControlReleaseDTO)
def release_submit(
    release_id: uuid.UUID,
    data: VersionedCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    ctx, release = release_command(db, release_id, user, "submit", data, idempotency_key)
    return release_dto(db, ctx, release)


@router.post("/control-releases/{release_id}/approve", response_model=ControlReleaseDTO)
def release_approve(
    release_id: uuid.UUID,
    data: ApproveControlCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    ctx, release = release_command(db, release_id, user, "approve", data, idempotency_key)
    return release_dto(db, ctx, release)


@router.post("/control-releases/{release_id}/return", response_model=ControlReleaseDTO)
def release_return(
    release_id: uuid.UUID,
    data: ReturnControlCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    ctx, release = release_command(db, release_id, user, "return", data, idempotency_key)
    return release_dto(db, ctx, release)


@router.post("/control-releases/{release_id}/cancel", response_model=ControlReleaseDTO)
def release_cancel(
    release_id: uuid.UUID,
    data: VersionedCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    ctx, release = release_command(db, release_id, user, "cancel", data, idempotency_key)
    return release_dto(db, ctx, release)


@router.get("/incidents/{incident_id}/ppr-sources/{revision_id}")
def incident_source(
    incident_id: uuid.UUID, revision_id: uuid.UUID, db: DbSession, user: CurrentUser
):
    from app.models import PprPage
    from app.models.customer_control import IncidentBasis

    ctx, case = load_incident(db, incident_id, user)
    basis = db.scalar(select(IncidentBasis).where(IncidentBasis.incident_id == case.id))
    citation = (
        next(
            (
                c
                for c in basis.snapshot.get("citations", [])
                if c["requirement_revision_id"] == str(revision_id)
            ),
            None,
        )
        if basis
        else None
    )
    if not citation:
        fail("RESOURCE_NOT_FOUND", 404)
    if ctx.is_demo:
        from app.services.demo_publication import demo_ids

        if uuid.UUID(citation["document_id"]) not in demo_ids(ctx.project, "document"):
            fail("RESOURCE_NOT_FOUND", 404)
    if ctx.side == "contractor" and not db.scalar(
        select(EvidenceDisclosure.id).where(
            EvidenceDisclosure.incident_id == case.id,
            EvidenceDisclosure.revision_id == revision_id,
            EvidenceDisclosure.participation_id == ctx.participation.id,
            EvidenceDisclosure.active.is_(True),
        )
    ):
        fail("RESOURCE_NOT_FOUND", 404)
    page = db.scalar(
        select(PprPage).where(
            PprPage.analysis_id == uuid.UUID(citation["analysis_id"]),
            PprPage.page_number == citation["page_number"],
        )
    )
    if not page or not page.preview_key:
        fail("RESOURCE_NOT_FOUND", 404)
    path = original_path(page.preview_key)
    if hashlib.sha256(path.read_bytes()).hexdigest() != citation["page_artifact_sha256"]:
        fail("RESOURCE_NOT_FOUND", 404, "Нарушена целостность закреплённой страницы")
    return FileResponse(
        path,
        media_type=page.preview_media_type,
        headers={
            "Cache-Control": "private, no-store",
            "X-PPR-Page": str(page.page_number),
            "X-PPR-Document-SHA256": citation["document_sha256"],
            "Content-Security-Policy": "sandbox",
        },
    )


@router.post("/control-releases/{release_id}/retire", response_model=ControlReleaseDTO)
def release_retire(
    release_id: uuid.UUID,
    data: ReturnControlCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    ctx, release = release_command(db, release_id, user, "retire", data, idempotency_key)
    return release_dto(db, ctx, release)


@router.get("/projects/{project_id}/metrics", response_model=MetricsDTO)
def metrics(project_id: uuid.UUID, db: DbSession, user: CurrentUser):
    ctx = resolve_context(db, project_id, user, "incident.read")
    scoped = incident_query(db, ctx).subquery()
    counts = {s: 0 for s in IncidentStatus}
    for status, count in db.execute(
        select(scoped.c.status, func.count()).group_by(scoped.c.status)
    ):
        counts[status] = count
    accepted = (
        db.scalar(
            select(func.count())
            .select_from(scoped)
            .where(scoped.c.resolution_origin == "customer_accepted")
        )
        or 0
    )
    return MetricsDTO(
        as_of=datetime.now(UTC),
        project_id=project_id,
        kind=ctx.project.kind,
        counts=counts,
        customer_accepted=accepted,
        sample_size=sum(counts.values()),
    )


@router.get("/projects/{project_id}/audit", response_model=list[AuditEventDTO])
def audit_list(
    project_id: uuid.UUID,
    db: DbSession,
    user: CurrentUser,
    limit: int = Query(100, ge=1, le=200),
):
    ctx = resolve_context(db, project_id, user, "audit.read")
    if ctx.is_demo:
        return []
    query = select(AuditEvent).where(AuditEvent.project_id == project_id)
    if ctx.side != "customer" or ctx.role != ProjectRole.CUSTOMER_MANAGER:
        query = query.where(AuditEvent.actor_assignment_id == ctx.assignment.id)
    return [
        AuditEventDTO(
            **values(
                e, "id event_type resource_id old_version new_version reason occurred_at"
            )
        )
        for e in db.scalars(query.order_by(AuditEvent.occurred_at.desc()).limit(limit))
    ]
