"""Immutable engineer revisions and full project releases approved by the customer."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from sqlalchemy import and_, exists, func, or_, select

from app.models import PprAnalysis, PprDocument, PprPage, PprRequirement, ScheduleTask
from app.models.customer_control import (
    ControlRelease,
    ControlReleaseItem,
    DocumentShare,
    ProjectAssignment,
    ProjectOrganization,
    ReleaseStatus,
    RequirementRevision,
    ResponsibilityArea,
)
from app.schemas.customer_control import (
    CitationDTO,
    ControlReleaseDTO,
    RequirementRevisionDTO,
)
from app.services.access_policy import (
    fail,
    has_contractor_conflict,
    require_area,
    resolve_context,
    resource_visible,
)
from app.services.incident_workflow import (
    audit,
    aware,
    check_version,
    digest,
    receipt,
    save_receipt,
    values,
)
from app.services.ppr_documents import original_path
from app.services.ppr_extraction import (
    ExtractedRequirement,
    quote_matches,
    requires_stage_binding,
    supported_requirement,
    text_hash,
)


def latest_release(db, project_id):
    return db.scalar(
        select(ControlRelease)
        .where(
            ControlRelease.project_id == project_id,
            ControlRelease.approved_at.is_not(None),
            ControlRelease.status != ReleaseStatus.CANCELLED,
        )
        .order_by(ControlRelease.sequence.desc())
    )


def release_at(db, project_id, at):
    return db.scalar(
        select(ControlRelease)
        .where(
            ControlRelease.project_id == project_id,
            ControlRelease.approved_at.is_not(None),
            ControlRelease.effective_from <= aware(at),
            or_(
                ControlRelease.effective_until.is_(None),
                ControlRelease.effective_until > aware(at),
            ),
            ControlRelease.status != ReleaseStatus.CANCELLED,
        )
        .order_by(ControlRelease.sequence.desc())
    )


def release_revisions(db, release):
    return (
        list(
            db.scalars(
                select(RequirementRevision)
                .join(
                    ControlReleaseItem,
                    ControlReleaseItem.revision_id == RequirementRevision.id,
                )
                .where(ControlReleaseItem.release_id == release.id)
            )
        )
        if release
        else []
    )


def revision_query(db, ctx):
    from app.models.customer_control import ProjectRole

    query = select(RequirementRevision).where(
        RequirementRevision.project_id == ctx.project.id
    )
    if ctx.is_demo:
        from app.services.demo_publication import demo_ids

        return query.where(
            RequirementRevision.requirement_id.in_(
                select(PprRequirement.id).where(
                    PprRequirement.document_id.in_(demo_ids(ctx.project, "document"))
                )
            )
        )
    if ctx.side == "customer" and ctx.assignment.scope_kind == "project":
        return query
    if ctx.side == "customer":
        return query.where(RequirementRevision.area_id.in_(ctx.area_ids))
    approved = exists(
        select(ControlReleaseItem.release_id)
        .join(ControlRelease, ControlRelease.id == ControlReleaseItem.release_id)
        .where(
            ControlReleaseItem.revision_id == RequirementRevision.id,
            ControlRelease.approved_at.is_not(None),
            ControlRelease.status != ReleaseStatus.CANCELLED,
        )
    )
    shared = exists(
        select(DocumentShare.id)
        .join(PprRequirement, PprRequirement.document_id == DocumentShare.document_id)
        .where(
            PprRequirement.id == RequirementRevision.requirement_id,
            DocumentShare.participation_id == ctx.participation.id,
            DocumentShare.project_id == ctx.project.id,
            DocumentShare.active.is_(True),
            DocumentShare.area_id.in_(ctx.area_ids),
            DocumentShare.read_kind.in_(["full", "requirements"]),
        )
    )
    own = RequirementRevision.owner_participation_id == ctx.participation.id
    scope = or_(
        RequirementRevision.area_id.in_(ctx.area_ids),
        RequirementRevision.area_id.is_(None),
    )
    return query.where(
        scope,
        or_(
            and_(own, True if ctx.role == ProjectRole.PTO_ENGINEER else approved),
            and_(shared, approved),
        ),
    )


def revision_visible(db, ctx, revision):
    return (
        db.scalar(
            revision_query(db, ctx)
            .with_only_columns(RequirementRevision.id)
            .where(RequirementRevision.id == revision.id)
        )
        is not None
    )


def revision_dto(revision):
    return RequirementRevisionDTO(
        **values(
            revision,
            (
                "id requirement_id revision_no area_id kind equipment_class quote "
                "review_status check_mode row_version citation"
            ),
        )
    )


def release_dto(db, ctx, release):
    revisions = release_revisions(db, release)
    visible = [r for r in revisions if revision_visible(db, ctx, r)]
    limited = ctx.side == "contractor" or ctx.is_demo
    data = values(
        release,
        (
            "id project_id sequence row_version status base_release_id "
            "effective_from effective_until"
        ),
    )
    if (
        release.status == ReleaseStatus.SCHEDULED
        and aware(release.effective_from) <= datetime.now(UTC)
        and (
            release.effective_until is None
            or aware(release.effective_until) > datetime.now(UTC)
        )
    ):
        data["status"] = ReleaseStatus.ACTIVE
    return ControlReleaseDTO(
        **data,
        requirement_revision_ids=[r.id for r in visible],
        manifest_sha256=None if limited else release.manifest_sha256,
        approved_by=None if limited else release.approved_by,
        approved_at=aware(release.approved_at),
        limitations=["Показана доступная часть выпуска"]
        if limited
        else release.limitations,
        note=None if limited else release.note,
    )


def create_revision(db, requirement_id, user, command, key):
    row = db.get(PprRequirement, requirement_id)
    if not row:
        fail("RESOURCE_NOT_FOUND", 404)
    ctx = resolve_context(
        db, row.project_id, user, "requirement.edit", write=True, lock=True
    )
    if not resource_visible(db, ctx, "document", row.document_id):
        fail("RESOURCE_NOT_FOUND", 404)
    doc = db.get(PprDocument, row.document_id)
    if ctx.side == "contractor" and doc.owner_participation_id != ctx.participation.id:
        fail("ACTION_FORBIDDEN", 403, "Редактируется только собственный документ")
    route, payload = f"requirements/{row.id}/revisions", command.model_dump(mode="json")
    replay, key, context_id = receipt(db, ctx, route, key, payload)
    if replay:
        return db.get(RequirementRevision, replay.resource_id)
    area = None
    if command.area_id:
        area = require_area(db, ctx, command.area_id)
        if (
            row.stage_id
            and area.schedule_task_id
            and area.schedule_task_id != row.stage_id
        ):
            fail("VALIDATION_ERROR", 422, "Требование относится к другому этапу")
    elif ctx.side == "contractor" or ctx.assignment.scope_kind == "areas":
        fail("VALIDATION_ERROR", 422, "Укажите область требования")
    page = db.scalar(
        select(PprPage).where(
            PprPage.analysis_id == row.analysis_id, PprPage.page_number == row.page_number
        )
    )
    analysis = db.get(PprAnalysis, row.analysis_id)
    quote = command.quote if command.quote is not None else row.quote
    kind = command.kind or (
        row.type
        if row.type in {"equipment_required", "equipment_forbidden"}
        else "manual"
    )
    equipment_class = (
        command.equipment_class
        if "equipment_class" in command.model_fields_set
        else row.equipment_class
    )
    from app.services.ppr_extraction import ALLOWED_CLASSES

    if kind == "manual":
        equipment_class = None
    elif equipment_class not in ALLOWED_CLASSES:
        fail("VALIDATION_ERROR", 422, "Выберите класс существующего каталога")
    if (
        not page
        or not analysis
        or analysis.status not in {"COMPLETED", "PARTIAL"}
        or page.status != "COMPLETED"
        or page.text_sha256 != text_hash(page.text)
        or not quote_matches(quote, page.text)
        or doc.sha256 != row.document_sha256
        or analysis.document_sha256 != doc.sha256
    ):
        fail(
            "VALIDATION_ERROR",
            422,
            "Цитата или страница не подтверждены исходным документом",
        )
    if not page.preview_key:
        fail("VALIDATION_ERROR", 422, "Оригинал страницы ещё не подготовлен")
    import hashlib

    page_hash = hashlib.sha256(original_path(page.preview_key).read_bytes()).hexdigest()
    if page.artifact_sha256 and page.artifact_sha256 != page_hash:
        fail("VALIDATION_ERROR", 422, "Изменились bytes страницы")
    page.artifact_sha256 = page_hash
    revision_id = uuid.uuid4()
    extracted = ExtractedRequirement(
        title=row.title,
        type=kind if kind != "manual" else "other",
        equipment_class=equipment_class,
        quote=quote,
        scope_text=row.scope_text,
        stage_name=row.stage_name,
        applicability=row.applicability,
    )
    supported = supported_requirement(extracted)
    if (
        supported
        and requires_stage_binding(extracted)
        and (not area or not area.schedule_task_id)
    ):
        fail("VALIDATION_ERROR", 422, "Привяжите метод работ к конкретному этапу")
    citation = CitationDTO(
        requirement_revision_id=revision_id,
        document_id=doc.id,
        analysis_id=analysis.id,
        document_sha256=doc.sha256,
        page_number=page.page_number,
        page_artifact_sha256=page_hash,
        quote=quote,
        source_kind=page.extraction_method
        if page.extraction_method in {"native_pdf", "converted_pdf", "vision_ocr"}
        else "image",
    )
    revision = RequirementRevision(
        id=revision_id,
        project_id=row.project_id,
        requirement_id=row.id,
        revision_no=(
            db.scalar(
                select(func.max(RequirementRevision.revision_no)).where(
                    RequirementRevision.requirement_id == row.id
                )
            )
            or 0
        )
        + 1,
        owner_participation_id=doc.owner_participation_id or ctx.participation.id,
        author_user_id=user.id,
        author_assignment_id=ctx.assignment.id,
        area_id=command.area_id,
        kind=kind,
        equipment_class=equipment_class,
        quote=quote,
        review_status=command.review_status,
        check_mode="automated" if supported and kind != "manual" else "manual",
        citation=citation.model_dump(mode="json"),
    )
    db.add(revision)
    event = audit(db, ctx, "requirement.revision_created", revision.id, command.note)
    save_receipt(db, ctx, route, key, context_id, payload, revision.id, event.id)
    db.commit()
    return revision


def create_release(db, project_id, user, command, key):
    ctx = resolve_context(db, project_id, user, "control.submit", write=True, lock=True)
    route, payload = (
        f"projects/{project_id}/control-releases",
        command.model_dump(mode="json"),
    )
    replay, key, context_id = receipt(db, ctx, route, key, payload)
    if replay:
        return ctx, db.get(ControlRelease, replay.resource_id)
    base = latest_release(db, project_id)
    if command.base_release_id != (base.id if base else None):
        fail("VERSION_CONFLICT", 409, "Изменился исходный выпуск; обновите сравнение")
    selected = []
    for revision_id in dict.fromkeys(command.requirement_revision_ids):
        revision = db.get(RequirementRevision, revision_id)
        if not revision or not revision_visible(db, ctx, revision):
            fail("RESOURCE_NOT_FOUND", 404)
        if revision.submitted:
            # A returned packet requires a new revision, never edits an old snapshot.
            fail(
                "VERSION_CONFLICT", 409, "Создайте новую редакцию для повторной отправки"
            )
        selected.append(revision)
    changed = {r.requirement_id for r in selected}
    selected_docs = [
        db.get(PprDocument, uuid.UUID(r.citation["document_id"])) for r in selected
    ]
    replacements = {d.series_id: d.version_no for d in selected_docs if d.series_id}
    full = []
    for r in release_revisions(db, base):
        if r.requirement_id in changed:
            continue
        old_doc = db.get(PprDocument, uuid.UUID(r.citation["document_id"]))
        if (
            old_doc.series_id in replacements
            and old_doc.version_no < replacements[old_doc.series_id]
            and revision_visible(db, ctx, r)
        ):
            continue
        full.append(r)
    full.extend(r for r in selected if r.review_status == "verified")
    if not full:
        fail("VALIDATION_ERROR", 422, "Нет проверенных требований для выпуска")
    if len({r.requirement_id for r in full}) != len(full):
        fail("VALIDATION_ERROR", 422, "В пакете две редакции одного требования")
    release = ControlRelease(
        id=uuid.uuid4(),
        project_id=project_id,
        sequence=(
            db.scalar(
                select(func.max(ControlRelease.sequence)).where(
                    ControlRelease.project_id == project_id
                )
            )
            or 0
        )
        + 1,
        base_release_id=base.id if base else None,
        submitted_by=user.id,
        submitted_assignment_id=ctx.assignment.id,
        manifest_sha256=digest(
            sorted(
                [
                    r.citation
                    | {
                        "area_id": str(r.area_id) if r.area_id else None,
                        "kind": r.kind,
                        "equipment_class": r.equipment_class,
                        "check_mode": r.check_mode,
                    }
                    for r in full
                ],
                key=lambda i: i["requirement_revision_id"],
            )
        ),
        limitations=command.limitations,
    )
    # Partial extraction must be an explicit limitation, not a checked document label.
    if (
        any(
            db.get(PprAnalysis, uuid.UUID(r.citation["analysis_id"])).status == "PARTIAL"
            for r in full
        )
        and not command.limitations
    ):
        fail("VALIDATION_ERROR", 422, "Укажите ограничения частичного разбора")
    db.add(release)
    for r in full:
        db.add(ControlReleaseItem(release_id=release.id, revision_id=r.id))
    event = audit(db, ctx, "control.draft_created", release.id)
    save_receipt(db, ctx, route, key, context_id, payload, release.id, event.id)
    db.commit()
    return ctx, release


def overlaps(db, a, b):
    if not a.area_id or not b.area_id:
        return True
    x, y = db.get(ResponsibilityArea, a.area_id), db.get(ResponsibilityArea, b.area_id)
    if x.zone_id and y.zone_id and x.zone_id != y.zone_id:
        return False
    if (
        x.schedule_task_id
        and y.schedule_task_id
        and x.schedule_task_id != y.schedule_task_id
    ):
        tx, ty = (
            db.get(ScheduleTask, x.schedule_task_id),
            db.get(ScheduleTask, y.schedule_task_id),
        )
        return aware(tx.planned_start) < aware(ty.planned_end) and aware(
            ty.planned_start
        ) < aware(tx.planned_end)
    for zone_area, task_area in ((x, y), (y, x)):
        if zone_area.zone_id and task_area.schedule_task_id:
            task = db.get(ScheduleTask, task_area.schedule_task_id)
            if task.zone_id and task.zone_id != zone_area.zone_id:
                return False
    return True


def release_command(db, release_id, user, action, command, key):
    customer_self_review = False
    release = db.get(ControlRelease, release_id)
    if not release:
        fail("RESOURCE_NOT_FOUND", 404)
    permission = (
        "control.retire"
        if action == "retire"
        else (
            "control.approve"
            if action in {"approve", "return", "cancel"}
            else "control.submit"
        )
    )
    ctx = resolve_context(db, release.project_id, user, permission, write=True, lock=True)
    db.refresh(release)
    if ctx.side == "contractor" and release.submitted_assignment_id != ctx.assignment.id:
        fail("RESOURCE_NOT_FOUND", 404)
    route, payload = (
        f"control-releases/{release.id}/{action}",
        command.model_dump(mode="json"),
    )
    replay, key, context_id = receipt(db, ctx, route, key, payload)
    if replay:
        return ctx, release
    check_version(release, command.expected_version)
    if action in {"cancel", "retire"} and release.approved_at:
        head = latest_release(db, ctx.project.id)
        if not head or head.id != release.id:
            fail("STALE_BASE", 409, "Выпуск уже заменён более новым решением")
    if action == "submit":
        if release.status != ReleaseStatus.DRAFT:
            fail("INVALID_TRANSITION", 409)
        release.status = ReleaseStatus.IN_REVIEW
        for revision in release_revisions(db, release):
            revision.submitted = True
    elif action in {"return", "approve"}:
        if release.status != ReleaseStatus.IN_REVIEW:
            fail("INVALID_TRANSITION", 409)
        if action == "return":
            release.status = ReleaseStatus.CHANGES_REQUESTED
            release.note = command.note
        else:
            revisions = release_revisions(db, release)
            if has_contractor_conflict(db, ctx):
                fail("SELF_REVIEW_FORBIDDEN", 409)
            submitted_assignment = db.get(
                ProjectAssignment, release.submitted_assignment_id
            )
            submitted_party = db.get(
                ProjectOrganization, submitted_assignment.participation_id
            )
            if submitted_party.side == "contractor" and release.submitted_by == user.id:
                fail("SELF_REVIEW_FORBIDDEN", 409)
            for r in revisions:
                author = db.get(ProjectAssignment, r.author_assignment_id)
                party = db.get(ProjectOrganization, author.participation_id)
                if r.author_user_id == user.id and party.side == "contractor":
                    fail("SELF_REVIEW_FORBIDDEN", 409)
                doc = db.get(PprDocument, uuid.UUID(r.citation["document_id"]))
                owner = (
                    db.get(ProjectOrganization, doc.owner_participation_id)
                    if doc.owner_participation_id
                    else None
                )
                if (
                    owner
                    and owner.side == "contractor"
                    and doc.uploaded_by_user_id == user.id
                ):
                    fail("SELF_REVIEW_FORBIDDEN", 409)
                if (
                    r.author_user_id == user.id
                    or release.submitted_by == user.id
                    or doc.uploaded_by_user_id == user.id
                ):
                    customer_self_review = True
            base = latest_release(db, release.project_id)
            if release.base_release_id != (base.id if base else None):
                fail("VERSION_CONFLICT", 409, "Исходный выпуск изменился")
            now = datetime.now(UTC)
            # Small request latency allowed, historical policy publication forbidden.
            if command.effective_from < now.replace(microsecond=0) - timedelta(
                seconds=30
            ):
                fail("VALIDATION_ERROR", 422, "Выпуск нельзя включить задним числом")
            if base and command.effective_from <= aware(base.effective_from):
                fail(
                    "VERSION_CONFLICT",
                    409,
                    "Начало выпуска должно быть позже предыдущего",
                )
            if command.manifest_sha256 != release.manifest_sha256:
                fail("VERSION_CONFLICT", 409, "Изменился manifest")
            for i, a in enumerate(revisions):
                for b in revisions[i + 1 :]:
                    if (
                        a.equipment_class
                        and a.equipment_class == b.equipment_class
                        and {a.kind, b.kind}
                        == {"equipment_required", "equipment_forbidden"}
                        and overlaps(db, a, b)
                    ):
                        fail(
                            "RULE_CONFLICT",
                            409,
                            (
                                "В пересекающейся области техника одновременно "
                                "обязательна и запрещена"
                            ),
                        )
            release.approved_by, release.approved_assignment_id, release.approved_at = (
                user.id,
                ctx.assignment.id,
                now,
            )
            release.effective_from, release.note = command.effective_from, command.note
            release.status = (
                ReleaseStatus.ACTIVE
                if command.effective_from <= now
                else ReleaseStatus.SCHEDULED
            )
            if base:
                base.effective_until = command.effective_from
                if release.status == ReleaseStatus.ACTIVE:
                    base.status = ReleaseStatus.RETIRED
    elif action == "cancel":
        if release.status not in {
            ReleaseStatus.DRAFT,
            ReleaseStatus.IN_REVIEW,
            ReleaseStatus.CHANGES_REQUESTED,
            ReleaseStatus.SCHEDULED,
        }:
            fail("INVALID_TRANSITION", 409)
        if release.status == ReleaseStatus.SCHEDULED:
            if aware(release.effective_from) <= datetime.now(UTC):
                fail("INVALID_TRANSITION", 409)
            base = (
                db.get(ControlRelease, release.base_release_id)
                if release.base_release_id
                else None
            )
            if base:
                base.effective_until = None
                base.status = ReleaseStatus.ACTIVE
        release.status = ReleaseStatus.CANCELLED
    elif action == "retire":
        if release.status not in {ReleaseStatus.ACTIVE, ReleaseStatus.SCHEDULED}:
            fail("INVALID_TRANSITION", 409)
        if has_contractor_conflict(db, ctx):
            fail("SELF_REVIEW_FORBIDDEN", 409)
        now = datetime.now(UTC)
        if aware(release.effective_from) > now:
            release.status = ReleaseStatus.CANCELLED
            base = (
                db.get(ControlRelease, release.base_release_id)
                if release.base_release_id
                else None
            )
            if base:
                base.effective_until = None
                base.status = ReleaseStatus.ACTIVE
        else:
            release.status, release.effective_until = ReleaseStatus.RETIRED, now
        release.note = command.note
    else:
        fail("VALIDATION_ERROR", 422)
    release.row_version += 1
    audit_reason = getattr(command, "note", "")
    if action == "approve" and customer_self_review:
        audit_reason += (
            " [customer_self_review: совмещение ПТО и управляющего заказчика; "
            "собственные материалы от подрядчика отсутствуют]"
        )
    event = audit(
        db,
        ctx,
        f'control.{"approved" if action == "approve" else action}',
        release.id,
        audit_reason,
        command.expected_version,
        release.row_version,
    )
    save_receipt(db, ctx, route, key, context_id, payload, release.id, event.id)
    db.commit()
    return ctx, release


def active_equipment_revisions(db, project_id, stage=None, observed_at=None):
    release = release_at(db, project_id, observed_at or datetime.now(UTC))
    result = []
    for revision in release_revisions(db, release):
        if (
            revision.review_status != "verified"
            or revision.check_mode != "automated"
            or revision.kind not in {"equipment_required", "equipment_forbidden"}
        ):
            continue
        if revision.area_id:
            area = db.get(ResponsibilityArea, revision.area_id)
            if (
                stage is None
                or (area.schedule_task_id and area.schedule_task_id != stage.id)
                or (area.zone_id and area.zone_id != stage.zone_id)
            ):
                continue
        # Adapter preserves detector interface while the source is the immutable revision.
        result.append(
            SimpleNamespace(
                id=revision.requirement_id,
                equipment_class=revision.equipment_class,
                type=revision.kind,
                activated_at=aware(release.effective_from),
                created_at=aware(revision.created_at),
                revision=revision,
                release=release,
            )
        )
    return result
