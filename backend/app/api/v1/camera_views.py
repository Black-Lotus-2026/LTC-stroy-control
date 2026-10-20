"""Ракурс камер: утверждённый эталон, предложения нового ракурса и перенос камеры.

Читать может тот, кому доступен объект. Предложить ракурс или попросить перенос —
ответственный (роль наблюдателя не может). Утвердить и согласовать — администратор.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable

from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession
from app.models.project import Camera
from app.models.user import User
from app.schemas.camera_view import CameraViewState, ViewMoveRequest, ViewNote, ViewReferenceRequest
from app.services import camera_view as cv
from app.services.management.context import require_project

router = APIRouter(prefix="/projects", tags=["Ракурс камер"])


def _camera(db: DbSession, project_id: uuid.UUID, camera_id: uuid.UUID, user: User, *, write: bool) -> Camera:
    require_project(db, project_id, user, write=write)
    camera = db.get(Camera, camera_id)
    if camera is None or camera.project_id != project_id:
        raise HTTPException(404, "Камера не найдена")
    return camera


def _apply(db: DbSession, camera: Camera, action: Callable[[], None]) -> CameraViewState:
    try:
        action()
    except cv.ViewError as exc:
        db.rollback()
        raise HTTPException(exc.status, str(exc)) from exc
    db.commit()
    db.refresh(camera)
    return CameraViewState.model_validate(cv.view_state(db, camera))


@router.get("/{project_id}/camera-views", response_model=list[CameraViewState])
def list_camera_views(project_id: uuid.UUID, db: DbSession, user: CurrentUser) -> list[CameraViewState]:
    require_project(db, project_id, user)
    # a move that ran out becomes an event even when beat is not running
    if cv.expire_moves(db, project_id=project_id):
        db.commit()
    cameras = db.scalars(
        select(Camera).where(Camera.project_id == project_id).order_by(Camera.created_at.asc())
    ).all()
    return [CameraViewState.model_validate(cv.view_state(db, c)) for c in cameras]


@router.put("/{project_id}/cameras/{camera_id}/view/reference", response_model=CameraViewState)
def submit_reference(
    project_id: uuid.UUID, camera_id: uuid.UUID, body: ViewReferenceRequest, db: DbSession, user: CurrentUser
) -> CameraViewState:
    """Администратор утверждает ракурс сразу, ответственный отправляет его на согласование."""
    camera = _camera(db, project_id, camera_id, user, write=True)
    try:
        image = cv.decode_snapshot(body.snapshot_base64)
    except cv.ViewError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
    return _apply(db, camera, lambda: cv.submit_reference(db, camera, user, image, body.note))


@router.post("/{project_id}/cameras/{camera_id}/view/reference/approve", response_model=CameraViewState)
def approve_reference(project_id: uuid.UUID, camera_id: uuid.UUID, db: DbSession, user: CurrentUser) -> CameraViewState:
    camera = _camera(db, project_id, camera_id, user, write=True)
    return _apply(db, camera, lambda: cv.approve_proposal(db, camera, user))


@router.post("/{project_id}/cameras/{camera_id}/view/reference/reject", response_model=CameraViewState)
def reject_reference(
    project_id: uuid.UUID, camera_id: uuid.UUID, body: ViewNote, db: DbSession, user: CurrentUser
) -> CameraViewState:
    camera = _camera(db, project_id, camera_id, user, write=True)
    return _apply(db, camera, lambda: cv.reject_proposal(db, camera, user, body.note))


@router.post("/{project_id}/cameras/{camera_id}/view/move", response_model=CameraViewState)
def request_move(
    project_id: uuid.UUID, camera_id: uuid.UUID, body: ViewMoveRequest, db: DbSession, user: CurrentUser
) -> CameraViewState:
    """Перенос камеры: администратор согласует сразу, ответственный — просит."""
    camera = _camera(db, project_id, camera_id, user, write=True)
    return _apply(db, camera, lambda: cv.plan_move(db, camera, user, body.until, body.reason))


@router.post("/{project_id}/cameras/{camera_id}/view/move/approve", response_model=CameraViewState)
def approve_move(project_id: uuid.UUID, camera_id: uuid.UUID, db: DbSession, user: CurrentUser) -> CameraViewState:
    camera = _camera(db, project_id, camera_id, user, write=True)
    return _apply(db, camera, lambda: cv.approve_move(db, camera, user))


@router.post("/{project_id}/cameras/{camera_id}/view/move/reject", response_model=CameraViewState)
def reject_move(
    project_id: uuid.UUID, camera_id: uuid.UUID, body: ViewNote, db: DbSession, user: CurrentUser
) -> CameraViewState:
    camera = _camera(db, project_id, camera_id, user, write=True)
    return _apply(db, camera, lambda: cv.reject_move(db, camera, user, body.note))


@router.delete("/{project_id}/cameras/{camera_id}/view/move", response_model=CameraViewState)
def cancel_move(project_id: uuid.UUID, camera_id: uuid.UUID, db: DbSession, user: CurrentUser) -> CameraViewState:
    camera = _camera(db, project_id, camera_id, user, write=True)
    return _apply(db, camera, lambda: cv.cancel_move(db, camera, user))
