"""Ракурс камер: утверждённый эталон, предложения нового ракурса и перенос камеры.

Читать может тот, кому доступен объект. Предложить ракурс или попросить перенос —
ответственный (роль наблюдателя не может). Утвердить и согласовать — администратор.
"""

from __future__ import annotations

import hashlib
import uuid
from collections.abc import Callable
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import Response

from app.api.deps import CurrentUser, DbSession
from app.models.project import Camera
from app.models.user import User
from app.schemas.camera_view import (
    CameraViewState,
    ViewMoveRequest,
    ViewNote,
    ViewReferenceRequest,
)
from app.services import camera_view as cv
from app.services.access_policy import resolve_context, resource_query, resource_visible

router = APIRouter(prefix="/projects", tags=["Ракурс камер"])


@router.get("/{project_id}/cameras/{camera_id}/view/assets/{asset}")
def view_asset(
    project_id: uuid.UUID,
    camera_id: uuid.UUID,
    asset: str,
    db: DbSession,
    user: CurrentUser,
):
    camera = _camera(db, project_id, camera_id, user, write=False)
    key = cv.view_asset_key(db, camera, asset)
    if key is None:
        raise HTTPException(404, "Снимок ракурса не найден")
    try:
        image = cv.load_view_image(key)
    except (OSError, ValueError):
        raise HTTPException(404, "Снимок ракурса не найден") from None
    return Response(
        image,
        media_type="image/jpeg",
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


def _camera(
    db: DbSession,
    project_id: uuid.UUID,
    camera_id: uuid.UUID,
    user: User,
    *,
    write: bool,
    permission: str = "camera.read",
) -> Camera:
    ctx = resolve_context(
        db, project_id, user, permission=permission, write=write, lock=write
    )
    camera = db.get(Camera, camera_id)
    if camera is None or camera.project_id != project_id:
        raise HTTPException(404, "Камера не найдена")
    if not resource_visible(db, ctx, "camera", camera.id):
        raise HTTPException(404, detail={"code": "RESOURCE_NOT_FOUND"})
    return camera


def _apply(
    db: DbSession, camera: Camera, user: User, action: Callable[[], None]
) -> CameraViewState:
    old_reference, old_move = camera.view_reference_key, camera.view_move_status
    try:
        action()
    except cv.ViewError as exc:
        db.rollback()
        raise HTTPException(exc.status, str(exc)) from exc
    from app.services.incident_workflow import audit
    from app.services.observation_basis import digest

    ctx = resolve_context(db, camera.project_id, user, write=True, lock=True)
    if camera.view_reference_key != old_reference:
        event_type = "camera.reference.approved"
    elif camera.view_move_status == "approved" and old_move != "approved":
        event_type = "camera.move.approved"
    else:
        event_type = "camera.policy.changed"
    audit(
        db,
        ctx,
        event_type,
        camera.id,
        digest(
            {
                "reference_key": camera.view_reference_key,
                "move_status": camera.view_move_status,
                "move_until": camera.view_move_until,
                "move_by": camera.view_move_by,
            }
        ),
    )
    db.commit()
    db.refresh(camera)
    return CameraViewState.model_validate(cv.view_state(db, camera))


@router.get("/{project_id}/camera-views", response_model=list[CameraViewState])
def list_camera_views(
    project_id: uuid.UUID, db: DbSession, user: CurrentUser
) -> list[CameraViewState]:
    ctx = resolve_context(db, project_id, user, permission="camera.read")
    cameras = db.scalars(
        resource_query(db, ctx, "camera", Camera).order_by(Camera.created_at.asc())
    ).all()
    return [
        CameraViewState.model_validate(cv.view_state(db, c))
        for c in cameras
        if resource_visible(db, ctx, "camera", c.id)
    ]


@router.put(
    "/{project_id}/cameras/{camera_id}/view/reference", response_model=CameraViewState
)
def submit_reference(
    project_id: uuid.UUID,
    camera_id: uuid.UUID,
    body: ViewReferenceRequest,
    db: DbSession,
    user: CurrentUser,
) -> CameraViewState:
    """Предложить ракурс на отдельное утверждение заказчиком."""
    camera = _camera(
        db, project_id, camera_id, user, write=True, permission="camera.reference.propose"
    )
    try:
        image = cv.decode_snapshot(body.snapshot_base64)
    except cv.ViewError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
    return _apply(
        db, camera, user, lambda: cv.submit_reference(db, camera, user, image, body.note)
    )


@router.post(
    "/{project_id}/cameras/{camera_id}/view/reference/approve",
    response_model=CameraViewState,
)
def approve_reference(
    project_id: uuid.UUID,
    camera_id: uuid.UUID,
    db: DbSession,
    user: CurrentUser,
    if_match: Annotated[str | None, Header(alias="If-Match")] = None,
) -> CameraViewState:
    camera = _camera(
        db, project_id, camera_id, user, write=True, permission="camera.reference.approve"
    )
    if not if_match:
        raise HTTPException(
            409,
            detail={
                "code": "WORKFLOW_UPGRADE_REQUIRED",
                "message": "Укажите sha256 просмотренного предложения в If-Match",
            },
        )
    if not camera.view_proposal_key:
        raise HTTPException(409, detail={"code": "VERSION_CONFLICT"})
    try:
        actual = hashlib.sha256(cv.load_view_image(camera.view_proposal_key)).hexdigest()
    except (OSError, ValueError):
        raise HTTPException(404, detail={"code": "RESOURCE_NOT_FOUND"}) from None
    if if_match.strip('"') != actual:
        raise HTTPException(
            409,
            detail={
                "code": "VERSION_CONFLICT",
                "message": "Снимок предложения изменился; проверьте новый ракурс",
            },
        )
    return _apply(db, camera, user, lambda: cv.approve_proposal(db, camera, user))


@router.post(
    "/{project_id}/cameras/{camera_id}/view/reference/reject",
    response_model=CameraViewState,
)
def reject_reference(
    project_id: uuid.UUID,
    camera_id: uuid.UUID,
    body: ViewNote,
    db: DbSession,
    user: CurrentUser,
) -> CameraViewState:
    camera = _camera(
        db, project_id, camera_id, user, write=True, permission="camera.reference.approve"
    )
    return _apply(
        db, camera, user, lambda: cv.reject_proposal(db, camera, user, body.note)
    )


@router.post(
    "/{project_id}/cameras/{camera_id}/view/move", response_model=CameraViewState
)
def request_move(
    project_id: uuid.UUID,
    camera_id: uuid.UUID,
    body: ViewMoveRequest,
    db: DbSession,
    user: CurrentUser,
) -> CameraViewState:
    """Перенос камеры: администратор согласует сразу, ответственный — просит."""
    camera = _camera(
        db, project_id, camera_id, user, write=True, permission="camera.move.request"
    )
    return _apply(
        db, camera, user, lambda: cv.plan_move(db, camera, user, body.until, body.reason)
    )


@router.post(
    "/{project_id}/cameras/{camera_id}/view/move/approve", response_model=CameraViewState
)
def approve_move(
    project_id: uuid.UUID, camera_id: uuid.UUID, db: DbSession, user: CurrentUser
) -> CameraViewState:
    camera = _camera(
        db, project_id, camera_id, user, write=True, permission="camera.move.decide"
    )
    return _apply(db, camera, user, lambda: cv.approve_move(db, camera, user))


@router.post(
    "/{project_id}/cameras/{camera_id}/view/move/reject", response_model=CameraViewState
)
def reject_move(
    project_id: uuid.UUID,
    camera_id: uuid.UUID,
    body: ViewNote,
    db: DbSession,
    user: CurrentUser,
) -> CameraViewState:
    camera = _camera(
        db, project_id, camera_id, user, write=True, permission="camera.move.decide"
    )
    return _apply(db, camera, user, lambda: cv.reject_move(db, camera, user, body.note))


@router.delete(
    "/{project_id}/cameras/{camera_id}/view/move", response_model=CameraViewState
)
def cancel_move(
    project_id: uuid.UUID, camera_id: uuid.UUID, db: DbSession, user: CurrentUser
) -> CameraViewState:
    camera = _camera(
        db, project_id, camera_id, user, write=True, permission="camera.move.request"
    )
    return _apply(db, camera, user, lambda: cv.cancel_move(db, camera, user))
