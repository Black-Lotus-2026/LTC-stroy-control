"""Cheap object-wide revision polling, independent of stage profile computation."""

import hashlib
import json
import uuid

from fastapi import APIRouter
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession
from app.models.ppr_analysis import PprAnalysis

router = APIRouter(tags=["Требования ППР"])


@router.get("/projects/{project_id}/ppr-control-revision")
def control_revision(project_id: uuid.UUID, db: DbSession, user: CurrentUser):
    from datetime import UTC, datetime

    from app.services.access_policy import resolve_context
    from app.services.control_releases import (
        release_at,
        release_revisions,
        revision_visible,
    )

    ctx = resolve_context(db, project_id, user, "document.read")
    release = release_at(db, project_id, datetime.now(UTC))
    rows = [
        r.citation | {"area_id": str(r.area_id), "kind": r.kind}
        for r in release_revisions(db, release)
        if revision_visible(db, ctx, r)
    ]
    revision = (
        hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()[:24]
        if rows
        else ""
    )
    return {"revision": revision}


def snapshot_source(db, project_id, citations, requirement_id):
    """Event viewers receive exactly its cited page, never a whole private library."""
    from fastapi import HTTPException
    from fastapi.responses import FileResponse

    from app.models.ppr_analysis import PprPage
    from app.models.ppr_document import PprDocument
    from app.services.ppr_documents import original_path

    citation = next(
        (c for c in citations if c.get("requirement_id") == str(requirement_id)), None
    )
    if not citation:
        raise HTTPException(404, "Источник вывода не найден")
    try:
        document_id = uuid.UUID(citation["document_id"])
        number = int(citation["page_number"])
    except (ValueError, TypeError, KeyError):
        raise HTTPException(404, "Источник вывода не найден") from None
    document = db.get(PprDocument, document_id)
    if (
        not document
        or document.project_id != project_id
        or document.sha256 != citation.get("document_sha256")
    ):
        raise HTTPException(404, "Исходный документ недоступен")
    pages = list(
        db.scalars(
            select(PprPage)
            .join(PprAnalysis)
            .where(
                PprAnalysis.document_id == document_id,
                PprPage.page_number == number,
                *(
                    [PprAnalysis.id == uuid.UUID(citation["analysis_id"])]
                    if citation.get("analysis_id")
                    else []
                ),
            )
            .limit(2)
        )
    )
    if len(pages) != 1:
        raise HTTPException(404, "Исторический источник нельзя определить однозначно")
    page = pages[0]
    if not page or not page.preview_key:
        raise HTTPException(404, "Исходная страница недоступна")
    path = original_path(page.preview_key)
    if (
        citation.get("page_artifact_sha256")
        and hashlib.sha256(path.read_bytes()).hexdigest()
        != citation["page_artifact_sha256"]
    ):
        raise HTTPException(404, "Нарушена целостность закреплённой страницы")
    return FileResponse(
        path,
        media_type=page.preview_media_type,
        filename=f"PPR-page-{number}.pdf"
        if page.preview_media_type == "application/pdf"
        else f"PPR-page-{number}.png",
        content_disposition_type="inline",
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",
            "X-PPR-Document-SHA256": document.sha256,
            "X-PPR-Page": str(number),
        },
    )


@router.get("/incidents/{incident_id}/ppr-sources/{requirement_id}")
def incident_source(
    incident_id: uuid.UUID, requirement_id: uuid.UUID, db: DbSession, user: CurrentUser
):
    from app.api.v1.incidents import _incident_for_user

    incident = _incident_for_user(db, incident_id, user)
    from app.models.customer_control import EvidenceDisclosure
    from app.services.access_policy import fail, resolve_context

    ctx = resolve_context(db, incident.project_id, user)
    citations = (incident.explanation or {}).get("ppr_requirements", [])
    citation = next(
        (c for c in citations if c.get("requirement_id") == str(requirement_id)), None
    )
    if ctx.is_demo:
        from app.services.demo_publication import demo_ids

        if not citation or citation.get("document_id") not in {
            str(identifier) for identifier in demo_ids(ctx.project, "document")
        }:
            fail("RESOURCE_NOT_FOUND", 404)
    if ctx.side == "contractor":
        revision_id = citation.get("requirement_revision_id") if citation else None
        if not revision_id or not db.scalar(
            select(EvidenceDisclosure.id).where(
                EvidenceDisclosure.incident_id == incident.id,
                EvidenceDisclosure.revision_id == uuid.UUID(revision_id),
                EvidenceDisclosure.participation_id == ctx.participation.id,
                EvidenceDisclosure.active.is_(True),
            )
        ):
            fail("RESOURCE_NOT_FOUND", 404)
    return snapshot_source(
        db,
        incident.project_id,
        (incident.explanation or {}).get("ppr_requirements", []),
        requirement_id,
    )


@router.get("/safety/events/{event_id}/ppr-sources/{requirement_id}")
def safety_source(
    event_id: uuid.UUID, requirement_id: uuid.UUID, db: DbSession, user: CurrentUser
):
    from fastapi import HTTPException

    from app.api.v1.safety import event_access
    from app.models.safety import SafetyEvent

    event = db.get(SafetyEvent, event_id)
    if event is None:
        raise HTTPException(404, "Событие не найдено")
    event_access(db, event, user)
    from app.services.access_policy import fail, resolve_context

    ctx = resolve_context(db, event.project_id, user)
    if ctx.is_demo:
        from app.services.demo_publication import demo_ids

        citation = next(
            (
                c
                for c in (event.snapshot or {}).get("ppr_requirements", [])
                if c.get("requirement_id") == str(requirement_id)
            ),
            None,
        )
        if not citation or citation.get("document_id") not in {
            str(identifier) for identifier in demo_ids(ctx.project, "document")
        }:
            fail("RESOURCE_NOT_FOUND", 404)
    return snapshot_source(
        db,
        event.project_id,
        (event.snapshot or {}).get("ppr_requirements", []),
        requirement_id,
    )
