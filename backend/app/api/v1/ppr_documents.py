"""Authenticated original PPR document library scoped to each construction object."""

from __future__ import annotations

import hashlib
import os
import uuid
from typing import Annotated

from fastapi import APIRouter, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.api.deps import CurrentUser, DbSession
from app.models.customer_control import DocumentSeries, ProjectRole, RequirementRevision
from app.models.ppr_analysis import PprAnalysis, PprPage, PprRequirement
from app.models.ppr_document import PprDocument
from app.schemas.ppr_documents import (
    PprAnalysisDetail,
    PprDocumentDetail,
    PprDocumentItem,
    PprPageDetail,
    PprRequirementItem,
    PprRequirementUpdate,
)
from app.services.access_policy import (
    fail,
    require_area,
    resolve_context,
    resource_query,
    resource_visible,
)
from app.services.incident_workflow import audit, receipt, save_receipt
from app.services.ppr_analysis import (
    analysis_detail,
    ensure_analysis,
    request_analysis,
)
from app.services.ppr_documents import original_path, private_root, stage_upload

project_requirements_router = APIRouter(tags=["Требования ППР"])

router = APIRouter(prefix="/projects/{project_id}/ppr-documents", tags=["Документы ППР"])


def require_document(db, project_id, document_id, user):
    ctx = resolve_context(db, project_id, user, "document.read")
    document = db.get(PprDocument, document_id)
    if (
        document is None
        or document.project_id != project_id
        or not resource_visible(db, ctx, "document", document_id)
    ):
        raise HTTPException(404, "Документ ППР не найден")
    return document


@router.get("", response_model=list[PprDocumentItem])
def list_documents(project_id: uuid.UUID, db: DbSession, current_user: CurrentUser):
    ctx = resolve_context(db, project_id, current_user, "document.read")
    return db.scalars(
        resource_query(db, ctx, "document", PprDocument).order_by(
            PprDocument.created_at.desc(), PprDocument.id
        )
    ).all()


@router.post("", response_model=PprDocumentItem, status_code=201)
async def upload_document(
    project_id: uuid.UUID,
    db: DbSession,
    current_user: CurrentUser,
    file: Annotated[UploadFile, File()],
    area_id: Annotated[uuid.UUID | None, Form()] = None,
    series_id: Annotated[uuid.UUID | None, Form()] = None,
    idempotency_key: Annotated[uuid.UUID | None, Header(alias="Idempotency-Key")] = None,
):
    ctx = resolve_context(
        db, project_id, current_user, "document.upload", write=True, lock=True
    )
    if area_id:
        require_area(db, ctx, area_id)
    elif ctx.side == "contractor" or ctx.assignment.scope_kind == "areas":
        fail("VALIDATION_ERROR", 422, "Выберите область документа")
    path, filename, size, sha, media_type, preview_kind, text = await stage_upload(file)
    try:
        payload = dict(
            sha256=sha,
            filename=filename,
            area_id=str(area_id) if area_id else None,
            series_id=str(series_id) if series_id else None,
        )
        route = f"projects/{project_id}/ppr-documents"
        replay, key_id, context_id = receipt(db, ctx, route, idempotency_key, payload)
        if replay:
            return require_document(db, project_id, replay.resource_id, current_user)
        series = db.get(DocumentSeries, series_id) if series_id else None
        if series_id and (
            not series
            or series.project_id != project_id
            or series.owner_participation_id != ctx.participation.id
        ):
            fail("RESOURCE_NOT_FOUND", 404)
        own_query = select(PprDocument).where(
            PprDocument.project_id == project_id,
            PprDocument.owner_participation_id == ctx.participation.id,
            PprDocument.area_id == area_id,
            PprDocument.sha256 == sha,
        )
        if series:
            own_query = own_query.where(PprDocument.series_id == series.id)
        existing = db.scalar(own_query)
        if existing:
            save_receipt(db, ctx, route, key_id, context_id, payload, existing.id)
            db.commit()
            return existing
        if not series:
            series = DocumentSeries(
                id=uuid.uuid4(),
                project_id=project_id,
                owner_participation_id=ctx.participation.id,
                title=filename,
            )
            db.add(series)
        previous = db.scalar(
            select(PprDocument)
            .where(PprDocument.series_id == series.id)
            .order_by(PprDocument.version_no.desc())
        )
        # Content-addressed immutable originals; untrusted filenames never become paths.
        key = f"{project_id}/{sha}"
        destination = private_root() / key
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if destination.exists():
            import hashlib

            if hashlib.sha256(destination.read_bytes()).hexdigest() != sha:
                fail("VALIDATION_ERROR", 422, "Повреждён сохранённый оригинал")
        else:
            os.replace(path, destination)
        document = PprDocument(
            id=uuid.uuid4(),
            series_id=series.id,
            version_no=previous.version_no + 1 if previous else 1,
            supersedes_id=previous.id if previous else None,
            area_id=area_id,
            owner_participation_id=ctx.participation.id,
            uploaded_by_user_id=current_user.id,
            project_id=project_id,
            filename=filename,
            media_type=media_type,
            size_bytes=size,
            sha256=sha,
            storage_key=key,
            uploaded_by=current_user.username or current_user.name,
            preview_kind=preview_kind,
            display_text=text,
        )
        db.add(document)
        event = audit(db, ctx, "document.uploaded", document.id)
        save_receipt(db, ctx, route, key_id, context_id, payload, document.id, event.id)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(
                409,
                {
                    "code": "VERSION_CONFLICT",
                    "message": "Загрузка уже обработана; обновите библиотеку",
                },
            ) from None
        db.refresh(document)
        analysis = ensure_analysis(db, document)
        try:
            from app.workers.ppr_tasks import analyze_ppr_task
            analyze_ppr_task.delay(str(analysis.id))
        except Exception:
            pass
        return document
    finally:
        path.unlink(missing_ok=True)


@router.get("/{document_id}", response_model=PprDocumentDetail)
def document_detail(
    project_id: uuid.UUID,
    document_id: uuid.UUID,
    db: DbSession,
    current_user: CurrentUser,
):
    return require_document(db, project_id, document_id, current_user)


@router.head("/{document_id}/original", include_in_schema=False)
@router.get("/{document_id}/original")
def document_original(
    project_id: uuid.UUID,
    document_id: uuid.UUID,
    db: DbSession,
    current_user: CurrentUser,
    download: bool = Query(False),
):
    document = require_document(db, project_id, document_id, current_user)
    path = original_path(document.storage_key)
    if hashlib.sha256(path.read_bytes()).hexdigest() != document.sha256:
        fail("RESOURCE_NOT_FOUND", 404, "Нарушена целостность оригинала ППР")
    # DOCX is downloadable only; its safe extracted text is served via detail.
    disposition = (
        "attachment" if download or document.preview_kind == "text" else "inline"
    )
    return FileResponse(
        path,
        media_type=document.media_type,
        filename=document.filename,
        content_disposition_type=disposition,
        headers={
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store",
            "Content-Security-Policy": "sandbox",
        },
    )


@router.post("/{document_id}/analyze", response_model=PprAnalysisDetail, status_code=202)
def start_analysis(
    project_id: uuid.UUID,
    document_id: uuid.UUID,
    db: DbSession,
    current_user: CurrentUser,
    idempotency_key: Annotated[uuid.UUID | None, Header(alias="Idempotency-Key")] = None,
):
    ctx = resolve_context(
        db, project_id, current_user, "document.analyze", write=True, lock=True
    )
    document = require_document(db, project_id, document_id, current_user)
    route = f"ppr-documents/{document_id}/analyze"
    if (
        ctx.side == "contractor"
        and document.owner_participation_id != ctx.participation.id
    ):
        fail("ACTION_FORBIDDEN", 403, "Разбор чужого документа недоступен")
    replay, key, context_id = receipt(db, ctx, route, idempotency_key, {})
    if replay:
        return analysis_detail(db, db.get(PprAnalysis, replay.resource_id))
    analysis = request_analysis(db, document, commit=False)
    # Commit the durable run and receipt together under the project lock.
    save_receipt(db, ctx, route, key, context_id, {}, analysis.id)
    db.commit()
    try:
        from app.workers.ppr_tasks import analyze_ppr_task
        analyze_ppr_task.delay(str(analysis.id))
    except Exception:
        pass
    return analysis_detail(db, analysis)


@router.get("/{document_id}/analysis", response_model=PprAnalysisDetail)
def get_analysis(
    project_id: uuid.UUID,
    document_id: uuid.UUID,
    db: DbSession,
    current_user: CurrentUser,
):
    resolve_context(db, project_id, current_user, "document.analyze")
    require_document(db, project_id, document_id, current_user)
    analysis = db.scalar(
        select(PprAnalysis)
        .where(
            PprAnalysis.document_id == document_id, PprAnalysis.project_id == project_id
        )
        .order_by(PprAnalysis.run_no.desc())
    )
    if analysis is None:
        raise HTTPException(404, "Документ ещё не анализировался")
    return analysis_detail(db, analysis)


def require_page(db, project_id, document_id, number, user, analysis_id=None):
    document = require_document(db, project_id, document_id, user)
    page = db.scalar(
        select(PprPage)
        .join(PprAnalysis, PprPage.analysis_id == PprAnalysis.id)
        .where(
            PprAnalysis.document_id == document_id,
            PprAnalysis.project_id == project_id,
            PprPage.page_number == number,
            *([PprAnalysis.id == analysis_id] if analysis_id else []),
        )
        .order_by(PprAnalysis.run_no.desc())
    )
    if page is None:
        raise HTTPException(404, "Страница ещё не подготовлена")
    return document, page


@router.get("/{document_id}/pages/{page_number}", response_model=PprPageDetail)
def get_page(
    project_id: uuid.UUID,
    document_id: uuid.UUID,
    page_number: int,
    db: DbSession,
    current_user: CurrentUser,
):
    document, page = require_page(db, project_id, document_id, page_number, current_user)
    return {
        k: getattr(page, k)
        for k in (
            "page_number",
            "status",
            "error_code",
            "extraction_method",
            "text_sha256",
            "text",
        )
    } | {"document_sha256": document.sha256, "preview_available": bool(page.preview_key)}


@router.head("/{document_id}/pages/{page_number}/original", include_in_schema=False)
@router.get("/{document_id}/pages/{page_number}/original")
def get_source_page(
    project_id: uuid.UUID,
    document_id: uuid.UUID,
    page_number: int,
    db: DbSession,
    current_user: CurrentUser,
    analysis_id: Annotated[uuid.UUID | None, Query()] = None,
):
    document, page = require_page(
        db, project_id, document_id, page_number, current_user, analysis_id
    )
    if not page.preview_key:
        raise HTTPException(404, "Изображение страницы ещё не подготовлено")
    return FileResponse(
        original_path(page.preview_key),
        media_type=page.preview_media_type,
        filename=f"PPR-page-{page_number}.pdf"
        if page.preview_media_type == "application/pdf"
        else f"PPR-page-{page_number}.png",
        content_disposition_type="inline",
        headers={
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store",
            "X-PPR-Document-SHA256": document.sha256,
            "X-PPR-Page": str(page_number),
            "Content-Security-Policy": "sandbox",
        },
    )


@router.patch(
    "/{document_id}/requirements/{requirement_id}", response_model=PprRequirementItem
)
def patch_requirement(
    project_id: uuid.UUID,
    document_id: uuid.UUID,
    requirement_id: uuid.UUID,
    data: PprRequirementUpdate,
    db: DbSession,
    current_user: CurrentUser,
):
    resolve_context(db, project_id, current_user, "requirement.edit", write=True)
    require_document(db, project_id, document_id, current_user)
    row = db.get(PprRequirement, requirement_id)
    if row is None:
        raise HTTPException(404, "Требование не найдено")
    raise HTTPException(
        409,
        {
            "code": "WORKFLOW_UPGRADE_REQUIRED",
            "message": "Создайте редакцию и отправьте выпуск на утверждение заказчику",
        },
    )


@project_requirements_router.get(
    "/projects/{project_id}/ppr-requirements", response_model=list[PprRequirementItem]
)
def project_requirements(project_id: uuid.UUID, db: DbSession, current_user: CurrentUser):
    ctx = resolve_context(db, project_id, current_user, "document.read")
    query = select(PprRequirement)
    if ctx.side == "contractor" and ctx.role != ProjectRole.PTO_ENGINEER:
        from app.services.control_releases import revision_query

        query = query.where(
            PprRequirement.id.in_(
                revision_query(db, ctx).with_only_columns(
                    RequirementRevision.requirement_id
                )
            )
        )
    return db.scalars(
        query.join(PprAnalysis, PprRequirement.analysis_id == PprAnalysis.id)
        .where(
            PprRequirement.project_id == project_id,
            PprRequirement.document_id.in_(
                resource_query(db, ctx, "document", PprDocument).with_only_columns(
                    PprDocument.id
                )
            ),
            PprAnalysis.status.in_(["COMPLETED", "PARTIAL"]),
        )
        .order_by(PprRequirement.created_at)
    ).all()
