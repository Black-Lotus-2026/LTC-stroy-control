"""Purpose-specific publication links. A camera share never follows a case citation."""

from __future__ import annotations

import uuid
from typing import Literal, cast

from fastapi import APIRouter
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession
from app.api.v1.customer_control import Key
from app.models import Camera, PprDocument, VideoAsset
from app.models.customer_control import (
    CameraShare,
    DocumentShare,
    ProjectOrganization,
    VideoShare,
)
from app.schemas.customer_control import ShareCommand, ShareDTO
from app.services.access_policy import fail, require_area, resolve_context
from app.services.incident_workflow import audit, receipt, save_receipt

router = APIRouter(prefix="/customer-control", tags=["Публикация источников"])


@router.post(
    "/projects/{project_id}/sources/{kind}/{resource_id}/shares", response_model=ShareDTO
)
def share_source(
    project_id: uuid.UUID,
    kind: Literal["document", "camera", "video"],
    resource_id: uuid.UUID,
    data: ShareCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    ctx = resolve_context(db, project_id, user, "evidence.publish", write=True, lock=True)
    model: type[PprDocument] | type[Camera] | type[VideoAsset]
    share_model: type[DocumentShare] | type[CameraShare] | type[VideoShare]
    if kind == "document":
        model, share_model, fk = PprDocument, DocumentShare, "document_id"
    elif kind == "camera":
        model, share_model, fk = Camera, CameraShare, "camera_id"
    else:
        model, share_model, fk = VideoAsset, VideoShare, "video_id"
    resource = cast(PprDocument | Camera | VideoAsset | None, db.get(model, resource_id))
    party = db.get(ProjectOrganization, data.participation_id)
    if (
        not resource
        or resource.project_id != project_id
        or not party
        or party.project_id != project_id
        or party.status != "active"
        or party.side != "contractor"
    ):
        fail("RESOURCE_NOT_FOUND", 404)
    area = require_area(db, ctx, data.area_id) if data.area_id else None
    if area is None:
        fail("VALIDATION_ERROR", 422, "Укажите область раскрытия источника")
    if isinstance(resource, Camera) and area.zone_id and area.zone_id != resource.zone_id:
        fail("VALIDATION_ERROR", 422, "Камера не относится к указанной зоне")
    if isinstance(resource, Camera) and area.schedule_task_id:
        from app.models import ScheduleTask

        task = db.get(ScheduleTask, area.schedule_task_id)
        if not task or not task.zone_id or task.zone_id != resource.zone_id:
            fail("VALIDATION_ERROR", 422, "Камера не соответствует зоне этапа")
    if (
        isinstance(resource, VideoAsset | PprDocument)
        and resource.area_id
        and resource.area_id != area.id
    ):
        fail("VALIDATION_ERROR", 422, "Источник относится к другой области")
    if kind != "document" and data.read_kind != "full":
        fail("VALIDATION_ERROR", 422)
    route, payload = (
        f"projects/{project_id}/sources/{kind}/{resource_id}/shares",
        data.model_dump(mode="json"),
    )
    replay, key, cid = receipt(db, ctx, route, idempotency_key, payload)
    if replay:
        row = cast(
            DocumentShare | CameraShare | VideoShare | None,
            db.get(share_model, replay.resource_id),
        )
    else:
        row = cast(
            DocumentShare | CameraShare | VideoShare | None,
            db.scalar(
                select(share_model).where(
                    getattr(share_model, fk) == resource_id,
                    share_model.participation_id == party.id,
                    share_model.area_id == area.id,
                )
            ),
        )
        if row:
            row.active = data.active
            row.read_kind = data.read_kind
        else:
            row = cast(
                DocumentShare | CameraShare | VideoShare,
                share_model(
                    id=uuid.uuid4(),
                    project_id=project_id,
                    participation_id=party.id,
                    area_id=area.id,
                    active=data.active,
                    read_kind=data.read_kind,
                    **{fk: resource_id},
                ),
            )
            db.add(row)
        ctx.project.authorization_version += 1
        event = audit(
            db,
            ctx,
            "source.disclosed" if data.active else "source.disclosure_revoked",
            resource_id,
        )
        save_receipt(db, ctx, route, key, cid, payload, row.id, event.id)
        db.commit()
    if not row:
        fail("RESOURCE_NOT_FOUND", 404)
    return ShareDTO(id=row.id, active=row.active)
