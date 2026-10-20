"""Scoped document context, comments, SLA policy and exports using existing reports."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter
from sqlalchemy import func, select

from app.api.deps import CurrentUser, DbSession
from app.api.v1.customer_control import Key
from app.models import (
    GeneratedReport,
    Incident,
    IncidentStatus,
    PprDocument,
    ReportPeriod,
    ReportStatus,
)
from app.models.customer_control import (
    DeadlinePause,
    Dispute,
    IncidentComment,
    IncidentRequirementLink,
    ProjectDeadlinePolicy,
    ProjectRole,
    RequirementRevision,
)
from app.schemas.customer_control import (
    CommentCommand,
    CommentDTO,
    DeadlinePauseCommand,
    DeadlinePolicyCommand,
    DeadlinePolicyDTO,
    IncidentDocumentContextDTO,
    ScopedReportCommand,
    ScopedReportDTO,
    VisibleCitationDTO,
)
from app.services.access_policy import (
    fail,
    incident_query,
    resolve_context,
)
from app.services.control_releases import revision_dto, revision_query, revision_visible
from app.services.document_context import document_incident_query
from app.services.incident_workflow import (
    audit,
    aware,
    check_version,
    incident_dto,
    load_incident,
    receipt,
    save_receipt,
    values,
)

router = APIRouter(prefix="/customer-control", tags=["Взаимодействие и отчёты"])


def document_context_dto(db, ctx, row):
    query = (
        select(RequirementRevision)
        .join(
            IncidentRequirementLink,
            IncidentRequirementLink.revision_id == RequirementRevision.id,
        )
        .where(IncidentRequirementLink.incident_id == row.id)
    )
    if ctx.side == "contractor":
        from app.models.customer_control import EvidenceDisclosure

        query = query.where(
            RequirementRevision.id.in_(
                select(EvidenceDisclosure.revision_id).where(
                    EvidenceDisclosure.incident_id == row.id,
                    EvidenceDisclosure.participation_id == ctx.participation.id,
                    EvidenceDisclosure.active.is_(True),
                )
            )
        )
    citations = []
    for revision in db.scalars(query):
        if not revision_visible(db, ctx, revision):
            continue
        document = db.get(PprDocument, uuid.UUID(revision.citation["document_id"]))
        citations.append(
            VisibleCitationDTO(
                requirement_revision_id=revision.id,
                document_title=document.filename,
                document_sha256=document.sha256,
                page_number=revision.citation["page_number"],
                quote=revision.quote,
            )
        )
    comments = select(IncidentComment).where(
        IncidentComment.incident_id == row.id, IncidentComment.document_context.is_(True)
    )
    if ctx.side == "contractor":
        comments = comments.where(
            IncidentComment.participation_id == ctx.participation.id
        )
    return IncidentDocumentContextDTO(
        id=row.id,
        code=row.code,
        row_version=row.row_version,
        visible_citations=citations,
        comments=[
            CommentDTO(**values(c, "id note created_at")) for c in db.scalars(comments)
        ],
        can_dispute="dispute.open" in ctx.permissions
        and not db.scalar(
            select(Dispute.id).where(
                Dispute.incident_id == row.id, Dispute.status == "open"
            )
        ),
    )


@router.get(
    "/projects/{project_id}/document-cases",
    response_model=list[IncidentDocumentContextDTO],
)
def document_cases(project_id: uuid.UUID, db: DbSession, user: CurrentUser):
    ctx = resolve_context(db, project_id, user, "document.read")
    if ctx.is_demo:
        return []
    return [
        document_context_dto(db, ctx, c)
        for c in db.scalars(
            document_incident_query(db, ctx)
            .order_by(Incident.first_seen_at.desc())
            .limit(200)
        )
    ]


@router.get(
    "/incidents/{incident_id}/document-context", response_model=IncidentDocumentContextDTO
)
def document_case(incident_id: uuid.UUID, db: DbSession, user: CurrentUser):
    ctx, row = load_incident(db, incident_id, user, "document.read")
    return document_context_dto(db, ctx, row)


@router.post(
    "/incidents/{incident_id}/comments", response_model=CommentDTO, status_code=201
)
def comment(
    incident_id: uuid.UUID,
    data: CommentCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    ctx, row = load_incident(db, incident_id, user, "incident.comment", True)
    route, payload = f"incidents/{row.id}/comments", data.model_dump(mode="json")
    replay, key, cid = receipt(db, ctx, route, idempotency_key, payload)
    if replay:
        saved = db.get(IncidentComment, replay.resource_id)
    else:
        check_version(row, data.expected_version)
        saved = IncidentComment(
            id=uuid.uuid4(),
            incident_id=row.id,
            author_user_id=user.id,
            author_assignment_id=ctx.assignment.id,
            participation_id=ctx.participation.id,
            document_context=ctx.role == ProjectRole.PTO_ENGINEER,
            note=data.note,
        )
        db.add(saved)
        row.row_version += 1
        event = audit(db, ctx, "incident.commented", saved.id)
        save_receipt(db, ctx, route, key, cid, payload, saved.id, event.id)
        db.commit()
    return CommentDTO(**values(saved, "id note created_at"))


@router.get(
    "/projects/{project_id}/deadline-policies", response_model=list[DeadlinePolicyDTO]
)
def deadline_policies(project_id: uuid.UUID, db: DbSession, user: CurrentUser):
    resolve_context(db, project_id, user)
    return [
        DeadlinePolicyDTO(
            **values(
                p,
                (
                    "id version effective_from reaction_minutes "
                    "remediation_minutes review_minutes reason"
                ),
            )
        )
        for p in db.scalars(
            select(ProjectDeadlinePolicy)
            .where(ProjectDeadlinePolicy.project_id == project_id)
            .order_by(ProjectDeadlinePolicy.version.desc())
        )
    ]


@router.post(
    "/projects/{project_id}/deadline-policies",
    response_model=DeadlinePolicyDTO,
    status_code=201,
)
def approve_deadline_policy(
    project_id: uuid.UUID,
    data: DeadlinePolicyCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    ctx = resolve_context(db, project_id, user, "project.manage", write=True, lock=True)
    route, payload = (
        f"projects/{project_id}/deadline-policies",
        data.model_dump(mode="json"),
    )
    replay, key, cid = receipt(db, ctx, route, idempotency_key, payload)
    if replay:
        policy = db.get(ProjectDeadlinePolicy, replay.resource_id)
    else:
        policy = ProjectDeadlinePolicy(
            id=uuid.uuid4(),
            project_id=project_id,
            version=(
                db.scalar(
                    select(func.max(ProjectDeadlinePolicy.version)).where(
                        ProjectDeadlinePolicy.project_id == project_id
                    )
                )
                or 0
            )
            + 1,
            approved_by=user.id,
            approved_assignment_id=ctx.assignment.id,
            effective_from=datetime.now(UTC),
            **payload,
        )
        db.add(policy)
        event = audit(db, ctx, "deadline_policy.approved", policy.id, data.reason)
        save_receipt(db, ctx, route, key, cid, payload, policy.id, event.id)
        db.commit()
    return DeadlinePolicyDTO(
        **values(
            policy,
            (
                "id version effective_from reaction_minutes remediation_minutes "
                "review_minutes reason"
            ),
        )
    )


@router.post("/incidents/{incident_id}/deadline-pauses")
def pause_deadline(
    incident_id: uuid.UUID,
    data: DeadlinePauseCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    ctx, row = load_incident(db, incident_id, user, "incident.deadline", True)
    route, payload = f"incidents/{row.id}/deadline-pauses", data.model_dump(mode="json")
    replay, key, cid = receipt(db, ctx, route, idempotency_key, payload)
    if not replay:
        check_version(row, data.expected_version)
        now = datetime.now(UTC)
        if (
            row.status not in {IncidentStatus.CONFIRMED, IncidentStatus.IN_PROGRESS}
            or not row.remediation_due_at
        ):
            fail("INVALID_TRANSITION", 409)
        if not now < data.until <= now + timedelta(days=30):
            fail("VALIDATION_ERROR", 422, "Период приостановки не больше 30 дней")
        if db.scalar(
            select(DeadlinePause.id).where(
                DeadlinePause.incident_id == row.id, DeadlinePause.until > now
            )
        ):
            fail("INVALID_TRANSITION", 409, "Срок уже приостановлен")
        pause = DeadlinePause(
            id=uuid.uuid4(),
            incident_id=row.id,
            actor_assignment_id=ctx.assignment.id,
            reason=data.reason,
            started_at=now,
            until=data.until,
        )
        db.add(pause)
        original_due = aware(row.remediation_due_at)
        row.remediation_due_at = original_due + (data.until - now)
        row.row_version += 1
        event = audit(
            db,
            ctx,
            "incident.deadline_paused",
            row.id,
            f"{original_due.isoformat()} → "
            f"{row.remediation_due_at.isoformat()}; {data.reason}",
        )
        save_receipt(db, ctx, route, key, cid, payload, row.id, event.id)
        db.commit()
    return incident_dto(db, ctx, row)


@router.post(
    "/projects/{project_id}/reports", response_model=ScopedReportDTO, status_code=201
)
def create_scoped_report(
    project_id: uuid.UUID,
    data: ScopedReportCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    ctx = resolve_context(db, project_id, user, "report.create", write=True, lock=True)
    if data.from_at >= data.until_at:
        fail("VALIDATION_ERROR", 422)
    if (ctx.role == ProjectRole.PTO_ENGINEER) != (
        data.kind == "documents"
    ) and ctx.role != ProjectRole.CUSTOMER_MANAGER:
        fail("ACTION_FORBIDDEN")
    route, payload = f"projects/{project_id}/reports", data.model_dump(mode="json")
    replay, key, cid = receipt(db, ctx, route, idempotency_key, payload)
    if replay:
        return read_scoped_report(replay.resource_id, db, user)
    now, report_id = datetime.now(UTC), uuid.uuid4()
    cases, requirements = [], []
    if data.kind == "operations":
        cases = [
            incident_dto(db, ctx, c)
            for c in db.scalars(
                incident_query(db, ctx)
                .where(
                    Incident.first_seen_at >= data.from_at,
                    Incident.first_seen_at < data.until_at,
                )
                .order_by(Incident.first_seen_at, Incident.id)
            )
        ]
    else:
        query = revision_query(db, ctx).where(
            RequirementRevision.created_at >= data.from_at,
            RequirementRevision.created_at < data.until_at,
        )
        requirements = [revision_dto(r) for r in db.scalars(query)]
    snapshot = ScopedReportDTO(
        id=report_id,
        project_id=project_id,
        kind=data.kind,
        from_at=data.from_at,
        until_at=data.until_at,
        as_of=now,
        incidents=cases,
        requirements=requirements,
    )
    row = GeneratedReport(
        id=report_id,
        project_id=project_id,
        requester_assignment_id=ctx.assignment.id,
        requested_by_user_id=user.id,
        scope_authorization_version=ctx.project.authorization_version,
        source_scope={
            "schema_version": 1,
            "organization_id": str(ctx.membership.organization_id),
            "area_ids": [str(a) for a in ctx.area_ids],
        },
        report_kind=data.kind,
        period=ReportPeriod.CUSTOM,
        range_start=data.from_at,
        range_end=data.until_at,
        status=ReportStatus.COMPLETED,
        title="Реестр документов"
        if data.kind == "documents"
        else "Работы в доступной области",
        content=snapshot.model_dump(mode="json"),
        source_log_count=len(cases) + len(requirements),
        started_at=now,
        completed_at=now,
    )
    db.add(row)
    event = audit(db, ctx, "report.completed", row.id)
    save_receipt(db, ctx, route, key, cid, payload, row.id, event.id)
    db.commit()
    return snapshot


@router.get("/reports/{report_id}", response_model=ScopedReportDTO)
def read_scoped_report(report_id: uuid.UUID, db: DbSession, user: CurrentUser):
    row = db.get(GeneratedReport, report_id)
    if not row or not row.report_kind:
        fail("RESOURCE_NOT_FOUND", 404)
    ctx = resolve_context(db, row.project_id, user, "report.read")
    if (
        row.requester_assignment_id != ctx.assignment.id
        or row.scope_authorization_version != ctx.project.authorization_version
    ):
        fail("RESOURCE_NOT_FOUND", 404, "Область изменилась; сформируйте новый отчёт")
    snapshot = ScopedReportDTO.model_validate(row.content)
    visible = set(db.scalars(incident_query(db, ctx).with_only_columns(Incident.id)))
    if any(c.id not in visible for c in snapshot.incidents):
        fail("RESOURCE_NOT_FOUND", 404)
    for old in snapshot.incidents:
        current = incident_dto(db, ctx, db.get(Incident, old.id))
        if old.view == "contractor" and (
            not set(old.basis.visible_evidence_ids)
            <= set(current.basis.visible_evidence_ids)
            or not {c.requirement_revision_id for c in old.basis.visible_citations}
            <= {c.requirement_revision_id for c in current.basis.visible_citations}
        ):
            fail("RESOURCE_NOT_FOUND", 404)
    for revision in snapshot.requirements:
        live = db.get(RequirementRevision, revision.id)
        if not live or not revision_visible(db, ctx, live):
            fail("RESOURCE_NOT_FOUND", 404)
    return snapshot
