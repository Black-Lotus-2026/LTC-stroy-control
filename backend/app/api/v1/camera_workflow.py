"""Scoped camera moves and approved observation coverage."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Header
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession
from app.models import Camera, Incident, Project, ScheduleTask
from app.models.camera_view import CameraViewEvent
from app.models.customer_control import (
    AuditEvent,
    CameraMoveRequest,
    CoverageConfiguration,
)
from app.models.enums import (
    IncidentCategory,
    IncidentPriority,
    IncidentStatus,
    IncidentType,
)
from app.schemas.customer_control import (
    CameraMoveCommand,
    CameraMoveDecisionCommand,
    CameraMoveRequestDTO,
    CoverageCommand,
    CoverageConfigurationDTO,
)
from app.services import camera_view as cv
from app.services.access_policy import (
    fail,
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
from app.services.observation_basis import snapshot_basis

router = APIRouter(prefix="/customer-control", tags=["Переносы и покрытие"])
Key = Annotated[uuid.UUID | None, Header(alias="Idempotency-Key")]
ACTIVE = {"requested", "approved", "in_progress", "awaiting_reference", "expired"}


def move_dto(row):
    return CameraMoveRequestDTO(
        **values(
            row,
            "id camera_id status requested_from requested_until reason "
            "coverage_plan reference_revision_id row_version",
        )
    )


def coverage_dto(row):
    return CoverageConfigurationDTO(
        **values(
            row, "id area_id camera_ids effective_from effective_until policy_sha256"
        )
    )


def checked_camera(db, ctx, camera_id):
    camera = db.get(Camera, camera_id)
    if (
        not camera
        or camera.project_id != ctx.project.id
        or not resource_visible(db, ctx, "camera", camera.id)
    ):
        fail("RESOURCE_NOT_FOUND", 404)
    return camera


@router.get(
    "/projects/{project_id}/cameras/{camera_id}/move-requests",
    response_model=list[CameraMoveRequestDTO],
)
def list_moves(
    project_id: uuid.UUID, camera_id: uuid.UUID, db: DbSession, user: CurrentUser
):
    ctx = resolve_context(db, project_id, user, "camera.read")
    checked_camera(db, ctx, camera_id)
    query = select(CameraMoveRequest).where(
        CameraMoveRequest.project_id == project_id,
        CameraMoveRequest.camera_id == camera_id,
    )
    if ctx.side == "contractor":
        query = query.where(CameraMoveRequest.author_user_id == user.id)
    return [
        move_dto(row)
        for row in db.scalars(query.order_by(CameraMoveRequest.created_at.desc()))
    ]


@router.post(
    "/projects/{project_id}/cameras/{camera_id}/move-requests",
    response_model=CameraMoveRequestDTO,
    status_code=201,
)
def request_move(
    project_id: uuid.UUID,
    camera_id: uuid.UUID,
    data: CameraMoveCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    ctx = resolve_context(
        db, project_id, user, "camera.move.request", write=True, lock=True
    )
    camera = checked_camera(db, ctx, camera_id)
    route, payload = f"cameras/{camera.id}/move-requests", data.model_dump(mode="json")
    replay, key, context_id = receipt(db, ctx, route, idempotency_key, payload)
    if replay:
        return move_dto(db.get(CameraMoveRequest, replay.resource_id))
    now = datetime.now(UTC)
    if (
        data.requested_from < now - timedelta(seconds=30)
        or data.requested_until <= data.requested_from
        or data.requested_until - data.requested_from > timedelta(days=7)
    ):
        fail("VALIDATION_ERROR", 422, "Нужно будущее окно переноса не дольше семи дней")
    active = db.scalar(
        select(CameraMoveRequest.id).where(
            CameraMoveRequest.camera_id == camera.id, CameraMoveRequest.status.in_(ACTIVE)
        )
    )
    if active or camera.view_move_status:
        fail("VERSION_CONFLICT", 409, "У камеры уже есть незавершённый перенос")
    row = CameraMoveRequest(
        id=uuid.uuid4(),
        project_id=project_id,
        camera_id=camera.id,
        author_user_id=user.id,
        requested_from=data.requested_from,
        requested_until=data.requested_until,
        reason=data.reason,
        coverage_plan=data.coverage_plan,
    )
    db.add(row)
    event = audit(db, ctx, "camera.move.requested", row.id, data.reason)
    save_receipt(db, ctx, route, key, context_id, payload, row.id, event.id)
    db.commit()
    return move_dto(row)


@router.post(
    "/camera-move-requests/{request_id}/commands", response_model=CameraMoveRequestDTO
)
def decide_move(
    request_id: uuid.UUID,
    data: CameraMoveDecisionCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    row = db.get(CameraMoveRequest, request_id)
    if not row:
        fail("RESOURCE_NOT_FOUND", 404)
    permission = (
        "camera.move.restore"
        if data.action == "complete"
        else "camera.move.decide"
        if data.action in {"approve", "reject"}
        else "camera.move.request"
    )
    ctx = resolve_context(db, row.project_id, user, permission, write=True, lock=True)
    db.refresh(row, with_for_update=True)
    camera = checked_camera(db, ctx, row.camera_id)
    if ctx.side == "contractor" and row.author_user_id != user.id:
        fail("RESOURCE_NOT_FOUND", 404)
    route, payload = (
        f"camera-move-requests/{row.id}/commands",
        data.model_dump(mode="json"),
    )
    replay, key, context_id = receipt(db, ctx, route, idempotency_key, payload)
    if replay:
        return move_dto(row)
    check_version(row, data.expected_version)
    now = datetime.now(UTC)
    if row.status not in ACTIVE:
        fail("INVALID_TRANSITION", 409, "Заявка уже завершена")
    if (
        data.action not in {"reject", "cancel", "propose_reference", "complete"}
        and aware(row.requested_until) <= now
    ):
        fail("INVALID_TRANSITION", 409, "Окно переноса истекло")
    if data.action == "approve":
        if row.status != "requested":
            fail("INVALID_TRANSITION", 409)
        row.status = "approved"
        camera.view_move_status = "approved"
        camera.view_move_at = row.requested_from
        camera.view_move_until = row.requested_until
        camera.view_move_reason = row.reason
        camera.view_move_by = row.author_user_id
        camera.view_move_approved_by = user.id
        camera.view_move_approved_at = now
        cv._log(
            db,
            camera,
            "move_approved",
            user,
            until=row.requested_until,
            now=aware(row.requested_from),
        )
    elif data.action == "reject":
        if row.status != "requested":
            fail("INVALID_TRANSITION", 409)
        row.status = "rejected"
    elif data.action == "cancel":
        if row.status in {"in_progress", "awaiting_reference", "expired"}:
            fail(
                "INVALID_TRANSITION",
                409,
                "Восстановите контроль свежим утверждённым ракурсом",
            )
        if row.status != "requested":
            resolve_context(
                db, row.project_id, user, "camera.move.decide", write=True, lock=True
            )
        row.status = "cancelled"
        cv._clear_move(camera)
        cv._log(db, camera, "move_cancelled", user, note=data.note, now=now)
    elif data.action == "start":
        if row.status != "approved" or aware(row.requested_from) > now:
            fail(
                "INVALID_TRANSITION",
                409,
                "Перенос ещё не согласован или окно не началось",
            )
        row.status = "in_progress"
    elif data.action == "propose_reference":
        if (
            row.status not in {"in_progress", "expired"}
            or not camera.view_proposal_key
            or aware(camera.view_proposal_at) < aware(row.requested_from)
        ):
            fail(
                "INVALID_TRANSITION",
                409,
                "Сначала предложите свежий ракурс после монтажа",
            )
        row.status = "awaiting_reference"
    elif data.action == "complete":
        if (
            row.status != "awaiting_reference"
            or not camera.view_reference_key
            or aware(camera.view_reference_at) < aware(row.requested_from)
            or camera.view_proposal_key
        ):
            fail("INVALID_TRANSITION", 409, "Заказчик должен утвердить свежий ракурс")
        reference = db.scalar(
            select(CameraViewEvent)
            .where(
                CameraViewEvent.camera_id == camera.id,
                CameraViewEvent.kind == "reference_set",
                CameraViewEvent.snapshot_key == camera.view_reference_key,
            )
            .order_by(CameraViewEvent.created_at.desc())
        )
        if not reference:
            fail("INVALID_TRANSITION", 409)
        row.reference_revision_id = reference.id
        row.status = "completed"
        cv._clear_move(camera)
        cv._log(db, camera, "move_completed", user, note=data.note, now=now)
    row.row_version += 1
    event = audit(
        db,
        ctx,
        {
            "approve": "camera.move.approved",
            "reject": "camera.move.rejected",
            "cancel": "camera.move.cancelled",
            "start": "camera.move.started",
            "propose_reference": "camera.move.reference_proposed",
            "complete": "camera.move.completed",
        }[data.action],
        row.id,
        data.note,
        data.expected_version,
        row.row_version,
    )
    save_receipt(db, ctx, route, key, context_id, payload, row.id, event.id)
    db.commit()
    return move_dto(row)


@router.get(
    "/projects/{project_id}/coverage-configurations",
    response_model=list[CoverageConfigurationDTO],
)
def list_coverage(project_id: uuid.UUID, db: DbSession, user: CurrentUser):
    ctx = resolve_context(db, project_id, user, "camera.read")
    query = select(CoverageConfiguration).where(
        CoverageConfiguration.project_id == project_id
    )
    if not ctx.is_demo and ctx.assignment.scope_kind == "areas":
        query = query.where(CoverageConfiguration.area_id.in_(ctx.area_ids))
    rows = db.scalars(query.order_by(CoverageConfiguration.effective_from.desc()))
    return [
        coverage_dto(row)
        for row in rows
        if all(
            resource_visible(db, ctx, "camera", uuid.UUID(ident))
            for ident in row.camera_ids
        )
    ]


@router.post(
    "/projects/{project_id}/coverage-configurations",
    response_model=CoverageConfigurationDTO,
    status_code=201,
)
def approve_coverage(
    project_id: uuid.UUID,
    data: CoverageCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    ctx = resolve_context(db, project_id, user, "camera.configure", write=True, lock=True)
    area = require_area(db, ctx, data.area_id)
    route, payload = (
        f"projects/{project_id}/coverage-configurations",
        data.model_dump(mode="json"),
    )
    replay, key, context_id = receipt(db, ctx, route, idempotency_key, payload)
    if replay:
        return coverage_dto(db.get(CoverageConfiguration, replay.resource_id))
    if data.effective_from < datetime.now(UTC) - timedelta(seconds=30):
        fail("VALIDATION_ERROR", 422, "Покрытие нельзя утверждать задним числом")
    stage = db.get(ScheduleTask, area.schedule_task_id) if area.schedule_task_id else None
    zone_id = area.zone_id or (stage.zone_id if stage else None)
    camera_ids = sorted(set(data.camera_ids))
    for camera_id in camera_ids:
        camera = checked_camera(db, ctx, camera_id)
        if zone_id and camera.zone_id != zone_id:
            fail(
                "VALIDATION_ERROR",
                422,
                "Камеры покрытия должны относиться к зоне области",
            )
    previous = db.scalar(
        select(CoverageConfiguration)
        .where(
            CoverageConfiguration.project_id == project_id,
            CoverageConfiguration.area_id == area.id,
        )
        .order_by(CoverageConfiguration.effective_from.desc())
        .with_for_update()
    )
    if previous:
        if data.effective_from <= aware(previous.effective_from):
            fail(
                "VERSION_CONFLICT",
                409,
                "Новая конфигурация должна начинаться позже предыдущей",
            )
        previous.effective_until = data.effective_from
    row = CoverageConfiguration(
        id=uuid.uuid4(),
        project_id=project_id,
        area_id=area.id,
        camera_ids=[str(ident) for ident in camera_ids],
        approved_by=user.id,
        effective_from=data.effective_from,
        policy_sha256=digest(payload),
    )
    db.add(row)
    event = audit(db, ctx, "camera.coverage.approved", row.id, data.reason)
    save_receipt(db, ctx, route, key, context_id, payload, row.id, event.id)
    db.commit()
    return coverage_dto(row)


def expire_move_requests(db, now=None):
    now = now or datetime.now(UTC)
    requests = list(
        db.scalars(
            select(CameraMoveRequest)
            .join(Project, Project.id == CameraMoveRequest.project_id)
            .where(
                Project.kind != "shared_demo",
                Project.lifecycle == "active",
                CameraMoveRequest.status.in_(
                    {"approved", "in_progress", "awaiting_reference"}
                ),
                CameraMoveRequest.requested_until <= now,
                ~select(AuditEvent.id)
                .where(
                    AuditEvent.resource_id == CameraMoveRequest.id,
                    AuditEvent.event_type == "camera.move.expired",
                )
                .exists(),
            )
            .with_for_update(skip_locked=True)
        )
    )
    for row in requests:
        camera = db.get(Camera, row.camera_id)
        project = db.get(Project, row.project_id)
        if not db.scalar(
            select(Incident.id).where(Incident.dedup_key == f"camera-move:{row.id}")
        ):
            incident = Incident(
                id=uuid.uuid4(),
                project_id=row.project_id,
                camera_id=row.camera_id,
                zone_id=camera.zone_id,
                case_kind="control_integrity",
                code=f"INC-{uuid.uuid4().hex[:8].upper()}",
                category=IncidentCategory.CAMERA,
                type=IncidentType.CAMERA_VISIBILITY,
                status=IncidentStatus.PENDING,
                priority=IncidentPriority.HIGH,
                title="Контроль камеры не восстановлен после переноса",
                description=row.reason,
                discrepancy_type="VIEW_MOVE_OVERDUE",
                dedup_key=f"camera-move:{row.id}",
                first_seen_at=row.requested_until,
                last_seen_at=now,
                explanation={"origin": "camera_policy", "move_request_id": str(row.id)},
            )
            db.add(incident)
            db.flush()
            snapshot_basis(
                db,
                incident,
                kind="camera",
                observed_from=row.requested_until,
                observed_until=now,
                policy={
                    "provenance": "camera_policy",
                    "approval_event_id": str(row.id),
                    "sha256": digest(
                        {
                            "requested_from": row.requested_from,
                            "requested_until": row.requested_until,
                            "coverage_plan": row.coverage_plan,
                        }
                    ),
                },
                sources=[{"camera_id": str(row.camera_id)}],
            )
            from app.services.alert_service import assign_initial_alert

            assign_initial_alert(db, incident, project)
        previous_version = row.row_version
        row.status = "expired"
        row.row_version += 1
        db.add(
            AuditEvent(
                project_id=row.project_id,
                organization_id=project.customer_organization_id,
                actor_user_id=None,
                actor_membership_id=None,
                actor_assignment_id=None,
                event_type="camera.move.expired",
                resource_id=row.id,
                old_version=previous_version,
                new_version=row.row_version,
                reason="Утверждённое окно переноса истекло без восстановления контроля",
            )
        )
        cv._log(db, camera, "move_expired", None, until=row.requested_until, now=now)
        cv._clear_move(camera)
    return len(requests)
