"""Transactional human workflow. Camera verification never accepts remediation."""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select

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
    CommandReceipt,
    Dispute,
    DisputeDecision,
    EvidenceAsset,
    EvidenceDisclosure,
    IncidentBasis,
    IncidentEvidenceLink,
    OrganizationMembership,
    ProjectAssignment,
    ProjectOrganization,
    ProjectRole,
    RemediationReview,
    RemediationSubmission,
)
from app.schemas.customer_control import (
    CommandResultDTO,
    ContractorIncidentDTO,
    CustomerIncidentDTO,
    DisputeDTO,
    EvidenceBasisProjectionDTO,
    EvidenceDTO,
    IncidentDetailDTO,
    ReviewDTO,
    SubmissionDTO,
)
from app.services.access_policy import (
    can_read_incident,
    fail,
    has_contractor_conflict,
    incident_query,
    require_area,
    resolve_context,
)

OPEN = {
    IncidentStatus.PENDING,
    IncidentStatus.CONFIRMED,
    IncidentStatus.IN_PROGRESS,
    IncidentStatus.REMEDIATION_SUBMITTED,
}


def aware(value):
    if value is None:
        return None
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def digest(payload):
    return hashlib.sha256(
        json.dumps(
            payload,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            default=str,
        ).encode()
    ).hexdigest()


def values(obj, fields):
    return {
        k: aware(v) if isinstance(v := getattr(obj, k), datetime) else v
        for k in fields.split()
    }


def check_version(row, expected):
    if row.row_version != expected:
        fail(
            "VERSION_CONFLICT",
            409,
            "Данные изменены другим участником; обновите карточку",
        )


def receipt(db, ctx, route, key, payload):
    if key is None:
        fail("VALIDATION_ERROR", 422, "Требуется Idempotency-Key")
    try:
        key = uuid.UUID(str(key))
    except ValueError:
        fail("VALIDATION_ERROR", 422, "Idempotency-Key должен быть UUID")
    context_id = ctx.assignment.id if ctx.assignment else ctx.membership.id
    row = db.scalar(
        select(CommandReceipt).where(
            CommandReceipt.user_id == ctx.user.id,
            CommandReceipt.context_id == context_id,
            CommandReceipt.route == route,
            CommandReceipt.key == key,
        )
    )
    if row and row.payload_sha256 != digest(payload):
        fail("IDEMPOTENCY_CONFLICT", 409, "Ключ уже использован для другой команды")
    return row, key, context_id


def save_receipt(db, ctx, route, key, context_id, payload, resource_id, event_id=None):
    row = CommandReceipt(
        id=uuid.uuid4(),
        user_id=ctx.user.id,
        context_id=context_id,
        route=route,
        key=key,
        payload_sha256=digest(payload),
        resource_id=resource_id,
        event_id=event_id,
    )
    db.add(row)
    return row


def audit(
    db, ctx, event_type, resource_id, reason="", old_version=None, new_version=None
):
    db.flush()
    event = AuditEvent(
        id=uuid.uuid4(),
        project_id=ctx.project.id,
        organization_id=ctx.project.customer_organization_id,
        actor_user_id=ctx.user.id,
        actor_membership_id=ctx.membership.id,
        actor_assignment_id=ctx.assignment.id,
        event_type=event_type,
        resource_id=resource_id,
        old_version=old_version,
        new_version=new_version,
        reason=reason,
    )
    db.add(event)
    db.flush()
    from app.services.customer_notifications import publish_audit_notifications

    publish_audit_notifications(db, event)
    return event


def load_incident(db, incident_id, user, permission="incident.read", write=False):
    # Initial lookup returns no private fields until the context/resource check succeeds.
    row = db.get(Incident, incident_id)
    if not row:
        fail("RESOURCE_NOT_FOUND", 404)
    ctx = resolve_context(db, row.project_id, user, permission, write=write, lock=write)
    if ctx.role == ProjectRole.PTO_ENGINEER and permission in {
        "dispute.open",
        "evidence.append",
        "incident.comment",
        "document.read",
    }:
        from app.services.document_context import document_incident_query

        query = document_incident_query(db, ctx).where(Incident.id == incident_id)
        if write:
            query = query.with_for_update()
        row = db.scalar(query)
        if not row:
            fail("RESOURCE_NOT_FOUND", 404)
        return ctx, row
    row = (
        db.scalar(
            incident_query(db, ctx)
            .where(Incident.id == incident_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if write
        else row
    )
    if not row or not can_read_incident(db, ctx, row):
        fail("RESOURCE_NOT_FOUND", 404)
    return ctx, row


def visible_evidence_query(db, ctx, row):
    q = (
        select(EvidenceAsset)
        .join(IncidentEvidenceLink, IncidentEvidenceLink.asset_id == EvidenceAsset.id)
        .where(
            IncidentEvidenceLink.incident_id == row.id,
            EvidenceAsset.project_id == row.project_id,
        )
    )
    if ctx.is_demo:
        from app.services.demo_publication import demo_ids

        q = q.where(EvidenceAsset.id.in_(demo_ids(ctx.project, "evidence")))
    if ctx.role == ProjectRole.PTO_ENGINEER:
        q = q.where(
            (EvidenceAsset.source == "page") | (EvidenceAsset.uploaded_by == ctx.user.id)
        )
    if ctx.side == "contractor":
        published = select(EvidenceDisclosure.asset_id).where(
            EvidenceDisclosure.incident_id == row.id,
            EvidenceDisclosure.participation_id == ctx.participation.id,
            EvidenceDisclosure.active.is_(True),
            EvidenceDisclosure.project_id == row.project_id,
        )
        q = q.where(
            (EvidenceAsset.owner_participation_id == ctx.participation.id)
            | EvidenceAsset.id.in_(published)
        )
    return q


def incident_dto(db, ctx, row):
    data = values(
        row,
        (
            "id project_id code title case_kind status row_version area_id "
            "responsible_participation_id assignee_assignment_id detected_at "
            "first_seen_at reaction_due_at remediation_due_at review_due_at "
            "resolution_origin verification_status"
        ),
    )
    actions = set()
    if not ctx.is_demo and ctx.project.lifecycle == "active":
        if row.status == IncidentStatus.PENDING:
            actions.update({"incident.confirm", "incident.dismiss"})
        if row.status in OPEN:
            actions.update(
                {
                    "incident.assign",
                    "incident.deadline",
                    "evidence.append",
                    "evidence.publish",
                    "incident.comment",
                }
            )
        if (
            row.status in {IncidentStatus.CONFIRMED, IncidentStatus.IN_PROGRESS}
            and row.assignee_assignment_id == ctx.assignment.id
        ):
            actions.add("remediation.submit")
            if row.status == IncidentStatus.CONFIRMED:
                actions.add("incident.start")
        if row.status == IncidentStatus.REMEDIATION_SUBMITTED:
            actions.update({"remediation.accept", "remediation.return"})
        if ctx.side == "contractor":
            actions.add("dispute.open")
        dispute = db.scalar(
            select(Dispute).where(Dispute.incident_id == row.id, Dispute.status == "open")
        )
        if dispute:
            actions.discard("remediation.accept")
            if ctx.user.id not in {
                dispute.author_user_id,
                row.confirmed_by,
            } and not has_contractor_conflict(db, ctx, row.responsible_participation_id):
                actions.add("dispute.decide")
    data["allowed_actions"] = sorted(actions.intersection(ctx.permissions))
    from app.models.customer_control import DeadlinePause

    data["deadline_paused_until"] = aware(
        db.scalar(
            select(func.max(DeadlinePause.until)).where(
                DeadlinePause.incident_id == row.id,
                DeadlinePause.until > datetime.now(UTC),
            )
        )
    )
    data["open_dispute_count"] = (
        db.scalar(
            select(func.count())
            .select_from(Dispute)
            .where(Dispute.incident_id == row.id, Dispute.status == "open")
        )
        or 0
    )
    basis = db.scalar(select(IncidentBasis).where(IncidentBasis.incident_id == row.id))
    if ctx.side == "customer":
        return CustomerIncidentDTO(
            **data,
            origin_participation_id=row.origin_participation_id,
            basis=basis.snapshot if basis else None,
        )
    citations = []
    from app.models import PprDocument
    from app.models.customer_control import RequirementRevision

    for revision in db.scalars(
        select(RequirementRevision)
        .join(
            EvidenceDisclosure, EvidenceDisclosure.revision_id == RequirementRevision.id
        )
        .where(
            EvidenceDisclosure.incident_id == row.id,
            EvidenceDisclosure.participation_id == ctx.participation.id,
            EvidenceDisclosure.active.is_(True),
        )
    ):
        doc = db.get(PprDocument, uuid.UUID(revision.citation["document_id"]))
        citations.append(
            dict(
                requirement_revision_id=revision.id,
                document_title=doc.filename,
                document_sha256=revision.citation["document_sha256"],
                page_number=revision.citation["page_number"],
                quote=revision.quote,
            )
        )
    projection = EvidenceBasisProjectionDTO(
        source_access="partial" if citations else "restricted",
        observed_from=aware(row.first_seen_at),
        observed_until=aware(row.last_seen_at),
        visible_evidence_ids=[
            a.id for a in db.scalars(visible_evidence_query(db, ctx, row))
        ],
        visible_citations=citations,
        coverage_status=basis.snapshot["coverage"]["status"] if basis else "unknown",
        limitations=["Доступны только материалы, опубликованные для вашей организации"],
    )
    return ContractorIncidentDTO(**data, basis=projection)


def evidence_dto(asset, ctx=None):
    return EvidenceDTO(
        can_submit=bool(
            ctx
            and asset.uploaded_by == ctx.user.id
            and asset.source == "upload"
            and asset.integrity == "verified"
        ),
        **values(
            asset,
            (
                "id project_id sha256 media_type size_bytes captured_at "
                "received_at source integrity"
            ),
        ),
    )


def detail_dto(db, ctx, row):
    assets = list(db.scalars(visible_evidence_query(db, ctx, row)))
    allowed = {str(a.id) for a in assets}
    submissions = []
    for s in db.scalars(
        select(RemediationSubmission)
        .where(RemediationSubmission.incident_id == row.id)
        .order_by(RemediationSubmission.sequence)
    ):
        if ctx.side == "contractor":
            author_assignment = db.get(ProjectAssignment, s.author_assignment_id)
            if author_assignment.participation_id != ctx.participation.id:
                continue
        review = db.scalar(
            select(RemediationReview).where(RemediationReview.submission_id == s.id)
        )
        submissions.append(
            SubmissionDTO(
                **values(s, "id sequence note submitted_at"),
                evidence_ids=[a for a in s.evidence_ids if a in allowed],
                review=ReviewDTO(
                    **values(review, "id submission_id outcome note decided_at")
                )
                if review
                else None,
            )
        )
    disputes = [
        DisputeDTO(
            **values(
                d,
                (
                    "id incident_id author_assignment_id reason note status "
                    "row_version opened_at"
                ),
            ),
            evidence_ids=[a for a in d.evidence_ids if a in allowed],
        )
        for d in db.scalars(select(Dispute).where(Dispute.incident_id == row.id))
        if ctx.side == "customer"
        or db.get(ProjectAssignment, d.author_assignment_id).participation_id
        == ctx.participation.id
    ]
    # Legacy comments may contain non-disclosed names/links: customer-only history.
    history = (
        [
            e.comment or e.event_type.value
            for e in db.scalars(
                select(IncidentEvent)
                .where(IncidentEvent.incident_id == row.id)
                .order_by(IncidentEvent.created_at)
            )
        ]
        if ctx.side == "customer"
        else []
    )
    return IncidentDetailDTO(
        incident=incident_dto(db, ctx, row),
        evidence=[evidence_dto(a, ctx) for a in assets],
        submissions=submissions,
        disputes=disputes,
        history=history,
    )


def validate_assignment(db, ctx, row, participation_id, assignment_id, area_id):
    party = db.get(ProjectOrganization, participation_id)
    if not party or party.project_id != ctx.project.id or party.status != "active":
        fail("RESOURCE_NOT_FOUND", 404)
    if row.case_kind == "construction" and party.side != "contractor":
        fail("VALIDATION_ERROR", 422, "Строительное дело назначается подрядчику")
    if area_id is not None:
        area = require_area(db, ctx, area_id)
        if (area.zone_id and area.zone_id != row.zone_id) or (
            area.schedule_task_id and area.schedule_task_id != row.schedule_task_id
        ):
            fail("VALIDATION_ERROR", 422, "Область не соответствует наблюдению")
    elif not (
        row.case_kind == "control_integrity"
        and party.side == "customer"
        and row.camera_id
    ):
        fail("VALIDATION_ERROR", 422, "Укажите область работ")
    if assignment_id:
        assignment = db.get(ProjectAssignment, assignment_id)
        membership = (
            db.get(OrganizationMembership, assignment.membership_id)
            if assignment
            else None
        )
        expected_role = (
            ProjectRole.CONTRACTOR_FOREMAN
            if party.side == "contractor"
            else ProjectRole.CUSTOMER_MANAGER
        )
        if (
            not assignment
            or assignment.status != "active"
            or assignment.participation_id != party.id
            or assignment.role != expected_role
            or not membership
            or membership.status != "active"
            or membership.organization_id != party.organization_id
        ):
            fail("VALIDATION_ERROR", 422, "Исполнитель не имеет действующего назначения")
        person = db.get(User, membership.user_id)
        if not person or not person.is_active:
            fail("VALIDATION_ERROR", 422)
        if assignment.scope_kind == "areas" and not db.get(
            AssignmentArea, (assignment.id, area_id)
        ):
            fail("VALIDATION_ERROR", 422, "Исполнитель не назначен на область")
    row.responsible_participation_id = party.id
    row.assignee_assignment_id = assignment_id
    row.area_id = area_id


def validate_assets(db, ctx, row, ids):
    available = {a.id: a for a in db.scalars(visible_evidence_query(db, ctx, row))}
    for asset_id in ids:
        asset = available.get(asset_id)
        if not asset:
            fail("RESOURCE_NOT_FOUND", 404)
        if asset.integrity != "verified":
            fail("VALIDATION_ERROR", 422, "Доказательство не прошло проверку целостности")
    return available


def execute_command(db, incident_id, user, command, key):
    permissions = {
        "confirm": "incident.confirm",
        "dismiss": "incident.dismiss",
        "start": "incident.start",
        "submit_remediation": "remediation.submit",
        "accept_remediation": "remediation.accept",
        "return_remediation": "remediation.return",
    }
    ctx, row = load_incident(db, incident_id, user, permissions[command.action], True)
    route = f"incidents/{row.id}/commands"
    payload = command.model_dump(mode="json")
    replay, key, context_id = receipt(db, ctx, route, key, payload)
    if replay:
        return CommandResultDTO(
            command_id=replay.id,
            event_id=replay.event_id,
            replayed=True,
            incident=incident_dto(db, ctx, row),
        )
    check_version(row, command.expected_version)
    old_status = row.status
    now = datetime.now(UTC)
    note = getattr(command, "note", "")
    if command.action == "confirm":
        if row.status != IncidentStatus.PENDING:
            fail("INVALID_TRANSITION", 409)
        validate_assignment(
            db,
            ctx,
            row,
            command.responsible_participation_id,
            command.assignee_assignment_id,
            command.area_id,
        )
        if command.remediation_due_at <= now:
            fail("VALIDATION_ERROR", 422, "Срок должен быть в будущем")
        row.status = IncidentStatus.CONFIRMED
        row.confirmed_at, row.confirmed_by = now, user.id
        row.remediation_due_at = command.remediation_due_at
        if row.origin_participation_id is None:
            row.origin_participation_id = row.responsible_participation_id
    elif command.action == "dismiss":
        if row.status != IncidentStatus.PENDING:
            fail("INVALID_TRANSITION", 409)
        row.status, row.resolved_at = IncidentStatus.FALSE_POSITIVE, now
        note = f"{command.reason}: {note}"
    elif command.action in {"start", "submit_remediation"}:
        if row.status not in {IncidentStatus.CONFIRMED, IncidentStatus.IN_PROGRESS}:
            fail("INVALID_TRANSITION", 409)
        if row.assignee_assignment_id != ctx.assignment.id:
            fail("ACTION_FORBIDDEN", 403, "Действие доступно назначенному исполнителю")
        if ctx.side == "customer" and row.case_kind != "control_integrity":
            fail("ACTION_FORBIDDEN")
        if command.action == "start":
            if row.status != IncidentStatus.CONFIRMED:
                fail("INVALID_TRANSITION", 409)
            row.status = IncidentStatus.IN_PROGRESS
        else:
            available = validate_assets(db, ctx, row, command.evidence_ids)
            if any(
                available[a].uploaded_by != user.id or available[a].source != "upload"
                for a in command.evidence_ids
            ):
                fail(
                    "VALIDATION_ERROR", 422, "Приложите собственные материалы устранения"
                )
            sequence = (
                db.scalar(
                    select(func.max(RemediationSubmission.sequence)).where(
                        RemediationSubmission.incident_id == row.id
                    )
                )
                or 0
            ) + 1
            db.add(
                RemediationSubmission(
                    id=uuid.uuid4(),
                    incident_id=row.id,
                    sequence=sequence,
                    author_user_id=user.id,
                    author_assignment_id=ctx.assignment.id,
                    note=command.note,
                    evidence_ids=[str(i) for i in dict.fromkeys(command.evidence_ids)],
                    submitted_at=now,
                )
            )
            row.status = IncidentStatus.REMEDIATION_SUBMITTED
            from app.services.deadlines import policy_at

            policy = policy_at(db, row.project_id, now)
            row.review_due_at = (
                now + timedelta(minutes=policy.review_minutes) if policy else None
            )
            from app.services.alert_service import request_verification

            request_verification(db, row, user)
            row.verification_status = "queued"
    else:
        if row.status != IncidentStatus.REMEDIATION_SUBMITTED:
            fail("INVALID_TRANSITION", 409)
        submission = db.scalar(
            select(RemediationSubmission)
            .where(RemediationSubmission.incident_id == row.id)
            .order_by(RemediationSubmission.sequence.desc())
        )
        if not submission or submission.id != command.submission_id:
            fail("VERSION_CONFLICT", 409, "Выбрана не последняя подача")
        submission_assignment = db.get(ProjectAssignment, submission.author_assignment_id)
        if submission_assignment.participation_id != row.responsible_participation_id:
            fail(
                "VERSION_CONFLICT",
                409,
                "После передачи дела требуется новая подача ответственной стороны",
            )
        if submission.author_user_id == user.id or has_contractor_conflict(
            db, ctx, row.responsible_participation_id
        ):
            fail("SELF_REVIEW_FORBIDDEN", 409)
        if command.action == "accept_remediation" and db.scalar(
            select(Dispute.id).where(
                Dispute.incident_id == row.id, Dispute.status == "open"
            )
        ):
            fail("OPEN_DISPUTE", 409)
        outcome = "accepted" if command.action == "accept_remediation" else "returned"
        db.add(
            RemediationReview(
                submission_id=submission.id,
                reviewer_user_id=user.id,
                reviewer_assignment_id=ctx.assignment.id,
                outcome=outcome,
                note=note,
                decided_at=now,
            )
        )
        if outcome == "accepted":
            row.status, row.resolved_at, row.resolution_origin = (
                IncidentStatus.RESOLVED,
                now,
                "customer_accepted",
            )
        else:
            row.status = IncidentStatus.IN_PROGRESS
            if command.new_remediation_due_at:
                if command.new_remediation_due_at <= now:
                    fail("VALIDATION_ERROR", 422)
                audit(
                    db,
                    ctx,
                    "incident.deadline_changed",
                    row.id,
                    f"{aware(row.remediation_due_at)} → "
                    f"{command.new_remediation_due_at}: {note}",
                )
                row.remediation_due_at = command.new_remediation_due_at
    row.row_version += 1
    event = IncidentEvent(
        id=uuid.uuid4(),
        incident_id=row.id,
        event_type=IncidentEventType.STATUS_CHANGED,
        old_status=old_status,
        new_status=row.status,
        user_id=user.id,
        comment=note,
    )
    db.add(event)
    audit(
        db,
        ctx,
        "incident.workflow_changed",
        row.id,
        note,
        command.expected_version,
        row.row_version,
    )
    saved = save_receipt(db, ctx, route, key, context_id, payload, row.id, event.id)
    db.commit()
    return CommandResultDTO(
        command_id=saved.id,
        event_id=event.id,
        replayed=False,
        incident=incident_dto(db, ctx, row),
    )


def open_dispute(db, incident_id, user, command, key):
    ctx, row = load_incident(db, incident_id, user, "dispute.open", True)
    route, payload = f"incidents/{row.id}/disputes", command.model_dump(mode="json")
    replay, key, context_id = receipt(db, ctx, route, key, payload)
    if replay:
        return db.get(Dispute, replay.resource_id)
    check_version(row, command.expected_version)
    if db.scalar(
        select(Dispute.id).where(Dispute.incident_id == row.id, Dispute.status == "open")
    ):
        fail("OPEN_DISPUTE", 409)
    validate_assets(db, ctx, row, command.evidence_ids)
    dispute = Dispute(
        id=uuid.uuid4(),
        incident_id=row.id,
        author_user_id=user.id,
        author_assignment_id=ctx.assignment.id,
        reason=command.reason,
        note=command.note,
        evidence_ids=[str(i) for i in command.evidence_ids],
    )
    db.add(dispute)
    row.row_version += 1
    event = audit(db, ctx, "dispute.opened", dispute.id, command.note)
    save_receipt(db, ctx, route, key, context_id, payload, dispute.id, event.id)
    db.commit()
    return dispute


def decide_dispute(db, dispute_id, user, command, key, *, withdraw=False):
    dispute = db.get(Dispute, dispute_id)
    if not dispute:
        fail("RESOURCE_NOT_FOUND", 404)
    ctx, row = load_incident(
        db,
        dispute.incident_id,
        user,
        "dispute.open" if withdraw else "dispute.decide",
        True,
    )
    route, payload = (
        f'disputes/{dispute.id}/{"withdraw" if withdraw else "decide"}',
        command.model_dump(mode="json"),
    )
    replay, key, context_id = receipt(db, ctx, route, key, payload)
    if replay:
        return dispute
    check_version(dispute, command.expected_version)
    if dispute.status != "open":
        fail("INVALID_TRANSITION", 409)
    if withdraw:
        if dispute.author_user_id != user.id:
            fail("ACTION_FORBIDDEN")
        dispute.status = "withdrawn"
    else:
        check_version(row, command.incident_expected_version)
        if user.id in {
            dispute.author_user_id,
            row.confirmed_by,
        } or has_contractor_conflict(db, ctx, row.responsible_participation_id):
            fail("SELF_REVIEW_FORBIDDEN", 409)
        dispute.status = command.outcome
        if command.outcome == "rejected" and command.correction != "none":
            fail("VALIDATION_ERROR", 422)
        if command.correction == "dismiss_incident" and row.status in OPEN:
            row.status, row.resolved_at = IncidentStatus.FALSE_POSITIVE, datetime.now(UTC)
        # Closed cases keep their original decision; this is a review request.
        db.add(
            DisputeDecision(
                dispute_id=dispute.id,
                reviewer_user_id=user.id,
                outcome=command.outcome,
                correction=command.correction,
                note=command.note,
            )
        )
    dispute.row_version += 1
    row.row_version += 1
    event = audit(
        db,
        ctx,
        "dispute.withdrawn" if withdraw else "dispute.decided",
        dispute.id,
        command.note,
    )
    save_receipt(db, ctx, route, key, context_id, payload, dispute.id, event.id)
    db.commit()
    return dispute
