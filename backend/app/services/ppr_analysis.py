"""Durable page analysis and authoritative, project-scoped requirement provenance."""

from __future__ import annotations

import asyncio
import hashlib
import os
import tempfile
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from pypdf import PdfReader
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.models import PprAnalysis, PprDocument, PprPage, PprRequirement
from app.services.management.agents.provider import ProviderError
from app.services.ppr_documents import original_path, private_root
from app.services.ppr_extraction import (
    MAX_PAGES,
    explicit_project_scope,
    extract_page,
    make_provider,
    quote_matches,
    render_page,
    single_pdf_page,
    source_pdf,
    supported_requirement,
    text_hash,
    vision_ocr,
)


class LeaseLost(Exception):
    pass


def ensure_analysis(db, document, *, commit=True):
    existing = db.scalar(
        select(PprAnalysis)
        .where(PprAnalysis.document_id == document.id)
        .order_by(PprAnalysis.run_no.desc())
    )
    if existing:
        return existing
    row = PprAnalysis(
        id=uuid.uuid4(),
        document_id=document.id,
        project_id=document.project_id,
        document_sha256=document.sha256,
        status="PENDING",
    )
    db.add(row)
    try:
        db.commit() if commit else db.flush()
    except IntegrityError:
        db.rollback()
        row = db.scalar(select(PprAnalysis).where(PprAnalysis.document_id == document.id))
        if row is None:
            raise
    db.refresh(row)
    return row


def request_analysis(db, document, *, commit=True):
    row = ensure_analysis(db, document, commit=commit)
    row = db.scalar(
        select(PprAnalysis)
        .where(PprAnalysis.id == row.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row.status in {"FAILED", "PARTIAL", "COMPLETED"}:
        row = PprAnalysis(
            id=uuid.uuid4(),
            document_id=document.id,
            project_id=document.project_id,
            document_sha256=document.sha256,
            run_no=row.run_no + 1,
            status="PENDING",
        )
        db.add(row)
        db.commit() if commit else db.flush()
    return row


def analysis_detail(db, analysis):
    pages = list(
        db.scalars(
            select(PprPage)
            .where(PprPage.analysis_id == analysis.id)
            .order_by(PprPage.page_number)
        )
    )
    requirements = list(
        db.scalars(
            select(PprRequirement)
            .where(PprRequirement.analysis_id == analysis.id)
            .order_by(PprRequirement.page_number, PprRequirement.created_at)
        )
    )
    fields = {
        k: getattr(analysis, k)
        for k in (
            "id",
            "document_id",
            "document_sha256",
            "status",
            "error_code",
            "pages_total",
            "pages_processed",
            "attempts",
            "provider",
            "model",
            "updated_at",
        )
    }
    fields["pages"] = [
        {
            k: getattr(p, k)
            for k in (
                "page_number",
                "status",
                "error_code",
                "extraction_method",
                "text_sha256",
            )
        }
        | {"preview_available": bool(p.preview_key)}
        for p in pages
    ]
    fields["requirements"] = requirements
    return fields


def claim_analysis(db, analysis_id):
    row = db.scalar(
        select(PprAnalysis).where(PprAnalysis.id == analysis_id).with_for_update()
    )
    if row is None or row.status != "PENDING":
        db.rollback()
        return None
    from app.services.observation_basis import writable_project

    if not writable_project(db, row.project_id, lock=True):
        db.rollback()
        return None
    row.status = "RUNNING"
    row.lease_token = uuid.uuid4().hex
    row.lease_updated_at = datetime.now(UTC)
    row.attempts += 1
    row.error_code = None
    provider = make_provider()
    row.provider = provider.name
    row.model = provider.model
    db.commit()
    return row.lease_token


def _lease(db, analysis_id, token):
    row = db.scalar(
        select(PprAnalysis)
        .where(PprAnalysis.id == analysis_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None or row.status != "RUNNING" or row.lease_token != token:
        db.rollback()
        raise LeaseLost()
    from app.services.observation_basis import writable_project

    if not writable_project(db, row.project_id, lock=True):
        db.rollback()
        raise LeaseLost()
    row.lease_updated_at = datetime.now(UTC)
    return row


def _save_page_preview(document, page, contents, media_type):
    suffix = "pdf" if media_type == "application/pdf" else "png"
    key = f"analyses/{document.id}/pages/{page.page_number}.{suffix}"
    path = private_root() / key
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=".page-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as target:
            target.write(contents)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    page.preview_key = key
    page.preview_media_type = media_type


def _persist_requirements(db, analysis, page, items):
    for item in items:
        if not quote_matches(item.quote, page.text):
            raise ProviderError("quote_not_found")
        fingerprint = text_hash(
            f"{page.page_number}|{item.type}|{item.equipment_class}|{item.quote}"
        )
        if db.scalar(
            select(PprRequirement.id).where(
                PprRequirement.analysis_id == analysis.id,
                PprRequirement.fingerprint == fingerprint,
            )
        ):
            continue
        digital = page.extraction_method in {"native_pdf", "converted_pdf"}
        supported = supported_requirement(item)
        automatic = digital and explicit_project_scope(item, page.text)
        row = PprRequirement(
            id=uuid.uuid5(analysis.id, fingerprint),
            analysis_id=analysis.id,
            project_id=analysis.project_id,
            document_id=analysis.document_id,
            document_sha256=analysis.document_sha256,
            page_number=page.page_number,
            fingerprint=fingerprint,
            title=item.title,
            type=item.type,
            equipment_class=item.equipment_class,
            scope_text=item.scope_text,
            quote=item.quote,
            quote_verified=digital,
            detector_supported=supported,
            active=False,
            applicability="project" if automatic else "manual",
            stage_name=item.stage_name,
            stage_id=None,
            extraction_method=page.extraction_method,
            human_confirmed=False,
            activated_at=None,
        )
        db.add(row)


def process_analysis(db, analysis_id, token, *, extractor=None, ocr=None):
    def heartbeat():
        _lease(db, analysis_id, token)
        db.commit()

    extractor = extractor or (
        lambda text: asyncio.run(extract_page(text, heartbeat=heartbeat))
    )
    ocr = ocr or (lambda raw, mime: asyncio.run(vision_ocr(raw, mime)))
    analysis = _lease(db, analysis_id, token)
    document = db.get(PprDocument, analysis.document_id)
    if (
        not document
        or document.project_id != analysis.project_id
        or document.sha256 != analysis.document_sha256
    ):
        raise ProviderError("document_integrity_error")
    original = original_path(document.storage_key)
    if hashlib.sha256(original.read_bytes()).hexdigest() != document.sha256:
        raise ProviderError("document_integrity_error")
    image_source = document.preview_kind == "image"
    if image_source:
        pdf_path = None
        method = "vision_ocr"
        count = 1
        reader = None
    else:
        pdf_path, method = source_pdf(document, analysis)
        reader = PdfReader(pdf_path, strict=True)
        count = len(reader.pages)
    if not 1 <= count <= MAX_PAGES:
        raise ProviderError("page_limit_exceeded")
    analysis.pages_total = count
    for number in range(1, count + 1):
        if (
            db.scalar(
                select(PprPage.id).where(
                    PprPage.analysis_id == analysis.id, PprPage.page_number == number
                )
            )
            is None
        ):
            db.add(
                PprPage(
                    analysis_id=analysis.id,
                    page_number=number,
                    status="PENDING",
                    extraction_method=method,
                )
            )
    db.commit()
    for number in range(1, count + 1):
        analysis = _lease(db, analysis_id, token)
        page = db.scalar(
            select(PprPage).where(
                PprPage.analysis_id == analysis_id, PprPage.page_number == number
            )
        )
        if page.status == "COMPLETED":
            db.commit()
            continue
        page.status = "PENDING"
        page.error_code = None
        db.commit()
        try:
            text = (reader.pages[number - 1].extract_text() or "") if reader else ""
            if image_source:
                raw = original.read_bytes()
                mime = document.media_type
                # A PNG preview is derived from the exact image original.
                import io

                from PIL import Image

                with Image.open(io.BytesIO(raw)) as im:
                    im.load()
                    im.thumbnail((2000, 2000))
                    buf = io.BytesIO()
                    im.convert("RGB").save(buf, format="PNG")
                    preview = buf.getvalue()
                _save_page_preview(document, page, preview, "image/png")
            else:
                _save_page_preview(
                    document,
                    page,
                    single_pdf_page(pdf_path, number - 1),
                    "application/pdf",
                )
            if not text.strip():
                page.extraction_method = "vision_ocr"
                if not image_source:
                    raw = render_page(pdf_path, number - 1)
                    mime = "image/png"
                else:
                    raw = preview
                    mime = "image/png"
                text = ocr(raw, mime)
            else:
                page.extraction_method = method
            _lease(db, analysis_id, token)
            page.text = text
            page.text_sha256 = text_hash(text)
            # Page text/source survive provider failures and explicit retries.
            db.commit()
            result = extractor(text)
            analysis = _lease(db, analysis_id, token)
            page = db.scalar(
                select(PprPage)
                .where(PprPage.analysis_id == analysis_id, PprPage.page_number == number)
                .execution_options(populate_existing=True)
            )
            _persist_requirements(db, analysis, page, result.requirements)
            page.status = "COMPLETED"
            page.error_code = None
            db.flush()
            analysis.pages_processed = db.scalar(
                select(func.count())
                .select_from(PprPage)
                .where(PprPage.analysis_id == analysis_id, PprPage.status == "COMPLETED")
            )
            db.commit()
        except LeaseLost:
            raise
        except Exception as exc:
            db.rollback()
            analysis = _lease(db, analysis_id, token)
            page = db.scalar(
                select(PprPage).where(
                    PprPage.analysis_id == analysis_id, PprPage.page_number == number
                )
            )
            page.status = "FAILED"
            page.error_code = (
                exc.code if isinstance(exc, ProviderError) else "page_analysis_failed"
            )
            analysis.error_code = page.error_code
            db.commit()
    analysis = _lease(db, analysis_id, token)
    pages = list(db.scalars(select(PprPage).where(PprPage.analysis_id == analysis_id)))
    failed = [p for p in pages if p.status == "FAILED"]
    analysis.pages_processed = sum(p.status == "COMPLETED" for p in pages)
    analysis.status = (
        ("FAILED" if analysis.pages_processed == 0 else "PARTIAL")
        if failed
        else "COMPLETED"
    )
    analysis.error_code = failed[0].error_code if failed else None
    analysis.lease_token = None
    analysis.lease_updated_at = None
    db.commit()
    return analysis.status


def safe_fail_analysis(db, analysis_id, token, exc):
    db.rollback()
    try:
        row = _lease(db, analysis_id, token)
    except LeaseLost:
        return
    row.status = "FAILED"
    row.error_code = exc.code if isinstance(exc, ProviderError) else "analysis_failed"
    row.lease_token = None
    row.lease_updated_at = None
    db.commit()


def pending_analysis_ids(db):
    from app.models import Project

    allowed_projects = select(Project.id).where(
        Project.kind != "shared_demo", Project.lifecycle == "active"
    )
    now = datetime.now(UTC)
    stale = list(
        db.scalars(
            select(PprAnalysis)
            .where(
                PprAnalysis.status == "RUNNING",
                PprAnalysis.project_id.in_(allowed_projects),
                PprAnalysis.lease_updated_at < now - timedelta(minutes=10),
            )
            .with_for_update(skip_locked=True)
        )
    )
    for row in stale:
        row.status = "PENDING"
        row.lease_token = None
        row.error_code = "worker_lease_expired"
    db.commit()
    return list(
        db.scalars(
            select(PprAnalysis.id)
            .where(
                PprAnalysis.status == "PENDING",
                PprAnalysis.project_id.in_(allowed_projects),
            )
            .order_by(PprAnalysis.created_at)
            .limit(20)
        )
    )


def verified_requirement(db, row):
    document = db.get(PprDocument, row.document_id)
    analysis = db.get(PprAnalysis, row.analysis_id)
    page = db.scalar(
        select(PprPage).where(
            PprPage.analysis_id == row.analysis_id, PprPage.page_number == row.page_number
        )
    )
    return bool(
        document
        and analysis
        and page
        and analysis.status in {"COMPLETED", "PARTIAL"}
        and document.project_id == row.project_id == analysis.project_id
        and document.sha256 == row.document_sha256 == analysis.document_sha256
        and page.status == "COMPLETED"
        and page.text_sha256 == text_hash(page.text)
        and quote_matches(row.quote, page.text)
        and row.quote_verified
        and (
            page.extraction_method in {"native_pdf", "converted_pdf"}
            or row.human_confirmed
        )
    )


def requirement_citation(db, row):
    if hasattr(row, "revision"):
        citation = dict(row.revision.citation)
        document = db.get(PprDocument, uuid.UUID(citation["document_id"]))
        return citation | {
            "requirement_id": str(row.id),
            "filename": document.filename,
            "scope_area_id": str(row.revision.area_id) if row.revision.area_id else None,
            "title": db.get(PprRequirement, row.id).title,
            "kind": row.type,
            "equipment_class": row.equipment_class,
            "scope_text": "",
            "release_id": str(row.release.id),
            "manifest_sha256": row.release.manifest_sha256,
            "activated_at": row.activated_at.isoformat(),
            "source_url": (
                f"/api/v1/projects/{row.revision.project_id}/ppr-documents/{document.id}"
                f'/pages/{citation["page_number"]}/original'
                f'?analysis_id={citation["analysis_id"]}'
            ),
        }
    document = db.get(PprDocument, row.document_id)
    analysis = db.get(PprAnalysis, row.analysis_id)
    if not document or not analysis or not verified_requirement(db, row):
        raise ValueError("unverified_requirement")
    activated_at = row.activated_at or row.created_at
    if activated_at.tzinfo is None:
        activated_at = activated_at.replace(tzinfo=UTC)
    return {
        "requirement_id": str(row.id),
        "document_id": str(row.document_id),
        "document_sha256": row.document_sha256,
        "filename": document.filename,
        "page_number": row.page_number,
        "quote": row.quote,
        "title": row.title,
        "kind": row.type,
        "equipment_class": row.equipment_class,
        "scope_text": row.scope_text,
        "source_kind": row.extraction_method,
        "analysis_id": str(row.analysis_id),
        "analysis_model": analysis.model,
        "source_url": (
            f"/api/v1/projects/{row.project_id}/ppr-documents/"
            f"{row.document_id}/pages/{row.page_number}/original"
        ),
        "activated_at": activated_at.astimezone(UTC).isoformat(),
    }


def get_active_equipment_requirements(db, project_id, stage=None, observed_at=None):
    from app.services.control_releases import active_equipment_revisions

    return active_equipment_revisions(db, project_id, stage, observed_at)


def update_requirement(db, document, row, data, user):
    if row.document_id != document.id or row.project_id != document.project_id:
        raise HTTPException(404, "Требование не найдено")
    raise HTTPException(
        409,
        {
            "code": "WORKFLOW_UPGRADE_REQUIRED",
            "message": "Создайте редакцию требования и утвердите выпуск",
        },
    )
