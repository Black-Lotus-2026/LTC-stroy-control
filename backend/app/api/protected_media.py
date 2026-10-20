"""Authenticated gateway; historical attribution never grants file access."""

from __future__ import annotations

from pathlib import Path
from urllib.parse import unquote, urlsplit

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from sqlalchemy import Text, cast, or_, select

from app.api.deps import CurrentUser, DbSession
from app.core.config import settings
from app.models import Frame, Incident, VideoAsset
from app.models.customer_control import (
    EvidenceAsset,
    EvidenceDisclosure,
    IncidentEvidenceLink,
)
from app.services.access_policy import (
    can_read_incident,
    resolve_context,
    visible_project_ids,
)
from app.services.demo_publication import demo_ids
from app.services.legacy_access import require_full_project_read

router = APIRouter()


def _not_found():
    raise HTTPException(404, detail={"code": "RESOURCE_NOT_FOUND"})


def _key(raw: str) -> str | None:
    path = unquote(urlsplit(raw).path)
    if path.startswith("/media/"):
        return path.removeprefix("/media/")
    return None


def _contains_key(value, key: str) -> bool:
    if isinstance(value, str):
        return _key(value) == key
    if isinstance(value, dict):
        return any(_contains_key(item, key) for item in value.values())
    if isinstance(value, list):
        return any(_contains_key(item, key) for item in value)
    return False


def _evidence_allowed(db, ctx, asset) -> bool:
    if ctx.is_demo and asset.id not in demo_ids(ctx.project, "evidence"):
        return False
    links = db.scalars(
        select(IncidentEvidenceLink.incident_id).where(
            IncidentEvidenceLink.asset_id == asset.id
        )
    )
    for incident_id in links:
        incident = db.get(Incident, incident_id)
        if not incident or not can_read_incident(db, ctx, incident):
            continue
        if ctx.side == "customer":
            return True
        disclosure = db.scalar(
            select(EvidenceDisclosure.id).where(
                EvidenceDisclosure.project_id == ctx.project.id,
                EvidenceDisclosure.incident_id == incident.id,
                EvidenceDisclosure.asset_id == asset.id,
                EvidenceDisclosure.participation_id == ctx.participation.id,
                EvidenceDisclosure.active.is_(True),
                or_(
                    EvidenceDisclosure.area_id.is_(None),
                    EvidenceDisclosure.area_id.in_(ctx.area_ids),
                ),
            )
        )
        if disclosure:
            return True
    return False


@router.api_route(
    "/media/{storage_key:path}", methods=["GET", "HEAD"], include_in_schema=False
)
def protected_media(storage_key: str, db: DbSession, user: CurrentUser):
    root = settings.storage_local_root.resolve()
    path = (root / storage_key).resolve()
    if not path.is_relative_to(root):
        _not_found()
    normalized = path.relative_to(root).as_posix()
    asset = db.scalar(
        select(VideoAsset).where(VideoAsset.storage_key.in_([normalized, str(path)]))
    )
    if asset:
        if not path.is_file():
            _not_found()
        from app.api.v1.videos import _video_for_user

        _video_for_user(db, asset, user)
        return _response(path)
    evidence = db.scalar(
        select(EvidenceAsset).where(
            EvidenceAsset.storage_key.in_([normalized, str(path)])
        )
    )
    if evidence:
        ctx = resolve_context(db, evidence.project_id, user, permission="evidence.read")
        if _evidence_allowed(db, ctx, evidence):
            return evidence_response(db, evidence)
        _not_found()
    frame = db.scalar(
        select(Frame).where(
            or_(
                Frame.storage_key.in_([normalized, str(path)]),
                Frame.thumbnail_key.in_([normalized, str(path)]),
            )
        )
    )
    if frame:
        if not path.is_file():
            _not_found()
        # Unpublished historical frames remain in the customer evidence library.
        require_full_project_read(db, frame.project_id, user)
        return _response(path)
    if not path.is_file():
        _not_found()
    # Old photographs were stored as URLs in immutable incident JSON. Resolve an
    # exact match within a currently authorized customer projection, never by path alone.
    candidates = db.scalars(
        select(Incident).where(
            Incident.project_id.in_(visible_project_ids(db, user)),
            cast(Incident.explanation, Text).contains(normalized),
        )
    )
    for incident in candidates:
        try:
            ctx = resolve_context(
                db, incident.project_id, user, permission="incident.read"
            )
            if ctx.is_demo:
                # Demo photographs require a vetted EvidenceAsset publication;
                # a historical URL embedded in case text is not a file grant.
                continue
            if not ctx.is_demo:
                require_full_project_read(db, incident.project_id, user)
        except HTTPException:
            continue
        if can_read_incident(db, ctx, incident) and _contains_key(
            incident.explanation, normalized
        ):
            return _response(path)
    _not_found()


def _response(path: Path):
    return FileResponse(
        path,
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",
        },
    )


def evidence_response(db, asset):
    """Return verified canonical bytes after the caller checks current visibility."""
    import hashlib
    import uuid

    if asset.source == "camera" and asset.storage_key.startswith("safety/"):
        from app.models.safety import SafetyEvent

        parts = asset.storage_key.split("/")
        try:
            event = db.get(SafetyEvent, uuid.UUID(parts[1]))
        except (ValueError, IndexError):
            _not_found()
        if (
            not event
            or event.project_id != asset.project_id
            or parts[-1] not in {"first.jpg", "last.jpg"}
        ):
            _not_found()
        contents = (
            event.first_evidence_jpeg if parts[-1] == "first.jpg" else event.evidence_jpeg
        )
        if hashlib.sha256(contents).hexdigest() != asset.sha256:
            _not_found()
        return Response(
            contents,
            media_type=asset.media_type,
            headers={
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
            },
        )
    if asset.source in {"recording", "camera", "legacy"}:
        root = settings.storage_local_root.resolve()
        raw = Path(asset.storage_key)
        path = raw.resolve() if raw.is_absolute() else (root / raw).resolve()
        if not path.is_relative_to(root):
            _not_found()
    else:
        from app.services.ppr_documents import original_path

        path = original_path(asset.storage_key)
    if (
        not path.is_file()
        or hashlib.sha256(path.read_bytes()).hexdigest() != asset.sha256
    ):
        _not_found()
    return FileResponse(
        path,
        media_type=asset.media_type,
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",
        },
    )
