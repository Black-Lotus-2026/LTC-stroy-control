"""Authenticated POS/PPR/TER upload, download and stage analysis."""

from __future__ import annotations

import hashlib
import uuid
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import quote

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.api.deps import CurrentUser, DbSession
from app.core.config import settings
from app.db.base import utcnow
from app.models.document import DocumentAnalysisRun, DocumentChunk, ProjectDocument
from app.models.schedule import ScheduleTask
from app.services.document_application import apply_document_rule, documents_unchanged
from app.services.document_search import (
    MAX_FILE_BYTES,
    AgentFailed,
    AgentUnavailable,
    DocumentParseError,
    agent_configuration_status,
    build_chain,
    extract_chunks,
)
from app.services.document_workflow import DocumentMachineryWorkflow
from app.services.machinery_rules import aliases_for, current_probability
from app.services.management.context import require_project

router = APIRouter(prefix="/projects/{project_id}/documents", tags=["Документы объекта"])

MIME = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".txt": "text/plain; charset=utf-8",
}


class DocumentInfo(BaseModel):
    id: uuid.UUID
    kind: Literal["POS", "PPR", "TER"]
    filename: str
    size_bytes: int
    created_at: str
    chunk_count: int


class AnalysisRequest(BaseModel):
    stage_id: uuid.UUID


class ProposalSelection(BaseModel):
    stage_id: uuid.UUID
    class_code: str


class SelectionRequest(BaseModel):
    selections: list[ProposalSelection]


def _info(doc: ProjectDocument, count: int) -> DocumentInfo:
    return DocumentInfo(
        id=doc.id,
        kind=doc.kind,
        filename=doc.filename,
        size_bytes=doc.size_bytes,
        created_at=doc.created_at.isoformat(),
        chunk_count=count,
    )


@router.get("", response_model=list[DocumentInfo])
def list_documents(project_id: uuid.UUID, db: DbSession, user: CurrentUser):
    require_project(db, project_id, user)
    documents = db.scalars(
        select(ProjectDocument)
        .where(ProjectDocument.project_id == project_id)
        .order_by(ProjectDocument.created_at.desc())
    ).all()
    return [_info(doc, len(doc.chunks)) for doc in documents]


@router.get("/agent-status")
def agent_status(project_id: uuid.UUID, db: DbSession, user: CurrentUser):
    require_project(db, project_id, user)
    return agent_configuration_status()


@router.post("", response_model=DocumentInfo, status_code=201)
async def upload_document(
    project_id: uuid.UUID,
    db: DbSession,
    user: CurrentUser,
    file: Annotated[UploadFile, File()],
    kind: Annotated[Literal["POS", "PPR", "TER"], Form()],
):
    require_project(db, project_id, user, write=True)
    filename = Path((file.filename or "").replace("\\", "/")).name.strip()
    if not filename or len(filename) > 255:
        raise HTTPException(422, "Некорректное имя файла")
    extension = Path(filename).suffix.lower()
    if extension not in MIME:
        raise HTTPException(422, "Поддерживаются PDF, DOCX, XLSX и TXT")
    content = await file.read(MAX_FILE_BYTES + 1)
    if len(content) > MAX_FILE_BYTES:
        raise HTTPException(413, "Файл больше 10 МБ")
    digest = hashlib.sha256(content).hexdigest()
    duplicate = db.scalar(
        select(ProjectDocument.id).where(
            ProjectDocument.project_id == project_id,
            ProjectDocument.sha256 == digest,
            ProjectDocument.kind == kind,
        )
    )
    if duplicate:
        raise HTTPException(409, "Этот документ уже загружен для объекта")
    try:
        fragments = extract_chunks(content, extension)
    except DocumentParseError as exc:
        raise HTTPException(422, str(exc)) from exc
    doc = ProjectDocument(
        project_id=project_id,
        kind=kind,
        filename=filename,
        content_type=MIME[extension],
        size_bytes=len(content),
        sha256=digest,
        content=content,
    )
    doc.chunks = [
        DocumentChunk(ordinal=index, locator=place, text=text)
        for index, (place, text) in enumerate(fragments)
    ]
    db.add(doc)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "Этот документ уже загружен для объекта") from exc
    db.refresh(doc)
    return _info(doc, len(fragments))


def _owned_document(
    project_id: uuid.UUID, document_id: uuid.UUID, db, user, *, write=False
):
    require_project(db, project_id, user, write=write)
    doc = db.get(ProjectDocument, document_id)
    if doc is None or doc.project_id != project_id:
        raise HTTPException(404, "Документ не найден")
    return doc


@router.get("/{document_id}/file")
def download_document(
    project_id: uuid.UUID, document_id: uuid.UUID, db: DbSession, user: CurrentUser
):
    doc = _owned_document(project_id, document_id, db, user)
    disposition = f"attachment; filename*=UTF-8''{quote(doc.filename)}"
    return Response(
        content=doc.content,
        media_type=doc.content_type,
        headers={
            "Content-Disposition": disposition,
            "Cache-Control": "private, no-store",
        },
    )


@router.delete("/{document_id}", status_code=204)
def delete_document(
    project_id: uuid.UUID, document_id: uuid.UUID, db: DbSession, user: CurrentUser
):
    doc = _owned_document(project_id, document_id, db, user, write=True)
    db.delete(doc)
    db.commit()
    return Response(status_code=204)


@router.post("/analyze")
async def analyze_stage(
    project_id: uuid.UUID, payload: AnalysisRequest, db: DbSession, user: CurrentUser
):
    try:
        return await DocumentMachineryWorkflow(db).run(
            project_id=project_id, stage_id=payload.stage_id, user=user
        )
    except AgentUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    except AgentFailed as exc:
        raise HTTPException(502, str(exc)) from exc


def _run_payload(run: DocumentAnalysisRun) -> dict:
    return {
        "id": run.id,
        "project_id": run.project_id,
        "status": run.status,
        "stage_count": run.stage_count,
        "completed_count": run.completed_count,
        "created_at": run.created_at,
        "started_at": run.started_at,
        "finished_at": run.finished_at,
        "error": run.error,
        "result": run.result,
    }


def _owned_run(project_id: uuid.UUID, run_id: uuid.UUID, db, user, *, write=False):
    require_project(db, project_id, user, write=write)
    query = select(DocumentAnalysisRun).where(DocumentAnalysisRun.id == run_id)
    run = db.scalar(query.with_for_update() if write else query)
    if run is None or run.project_id != project_id:
        raise HTTPException(404, "Анализ не найден")
    return run


@router.post("/analyze-plan", status_code=202)
def analyze_plan(project_id: uuid.UUID, db: DbSession, user: CurrentUser):
    require_project(db, project_id, user, write=True)
    try:
        build_chain()  # Configuration only; no external request occurs here.
    except AgentUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    stages = db.scalars(
        select(ScheduleTask)
        .where(ScheduleTask.project_id == project_id)
        .order_by(ScheduleTask.order_index)
    ).all()
    if not stages:
        raise HTTPException(422, "Сначала загрузите календарный план")
    documents = db.scalars(
        select(ProjectDocument)
        .where(ProjectDocument.project_id == project_id)
        .order_by(ProjectDocument.created_at)
    ).all()
    if not documents:
        raise HTTPException(422, "Сначала загрузите ПОС или ППР")
    if not any(doc.kind in {"POS", "PPR"} for doc in documents):
        raise HTTPException(422, "Для анализа нужен хотя бы один ПОС или ППР")
    run = DocumentAnalysisRun(
        project_id=project_id,
        created_by=user.id,
        status="queued",
        stage_count=len(stages),
        completed_count=0,
        snapshot={
            "stages": [
                {
                    "id": str(stage.id),
                    "name": stage.name,
                    "matched_catalog_name": stage.matched_catalog_name,
                    "probabilities": stage.machinery_probabilities or {},
                    "sources": stage.machinery_rule_sources or {},
                }
                for stage in stages
            ],
            "documents": [
                {
                    "id": str(doc.id),
                    "filename": doc.filename,
                    "kind": doc.kind,
                    "sha256": doc.sha256,
                }
                for doc in documents
            ],
            "provider": settings.document_llm_provider,
            "model": agent_configuration_status()["model"],
        },
        result={"stages": [], "applied": []},
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    from app.workers.document_tasks import analyze_document_plan

    try:
        analyze_document_plan.apply_async(args=[str(run.id)], retry=False)
    except Exception:
        run.status = "failed"
        run.error = "queue_unavailable"
        run.finished_at = utcnow()
        db.commit()
    return _run_payload(run)


@router.get("/analysis-runs/latest")
def latest_analysis(project_id: uuid.UUID, db: DbSession, user: CurrentUser):
    require_project(db, project_id, user)
    run = db.scalar(
        select(DocumentAnalysisRun)
        .where(DocumentAnalysisRun.project_id == project_id)
        .order_by(DocumentAnalysisRun.created_at.desc(), DocumentAnalysisRun.id.desc())
    )
    return _run_payload(run) if run else None


@router.get("/analysis-runs")
def list_analyses(project_id: uuid.UUID, db: DbSession, user: CurrentUser):
    require_project(db, project_id, user)
    runs = db.scalars(
        select(DocumentAnalysisRun)
        .where(DocumentAnalysisRun.project_id == project_id)
        .order_by(DocumentAnalysisRun.created_at.desc(), DocumentAnalysisRun.id.desc())
        .limit(20)
    ).all()
    return [_run_payload(run) for run in runs]


@router.get("/analysis-runs/{run_id}")
def get_analysis(
    project_id: uuid.UUID, run_id: uuid.UUID, db: DbSession, user: CurrentUser
):
    return _run_payload(_owned_run(project_id, run_id, db, user))


def _validate_run_sources(run: DocumentAnalysisRun, db) -> None:
    if not documents_unchanged(run, db):
        raise HTTPException(409, "Документы изменились. Запустите анализ заново")


@router.post("/analysis-runs/{run_id}/apply")
def apply_analysis(
    project_id: uuid.UUID,
    run_id: uuid.UUID,
    payload: SelectionRequest,
    db: DbSession,
    user: CurrentUser,
):
    run = _owned_run(project_id, run_id, db, user, write=True)
    if run.status not in {"completed", "partial"}:
        raise HTTPException(409, "Анализ ещё не завершён")
    if not payload.selections or len(payload.selections) > 500:
        raise HTTPException(422, "Выберите предложения для применения")
    selected = [(str(item.stage_id), item.class_code) for item in payload.selections]
    if len(set(selected)) != len(selected):
        raise HTTPException(422, "Предложения повторяются")
    _validate_run_sources(run, db)
    results = {
        (row["stage_id"], p["class_code"]): (row, p)
        for row in run.result.get("stages", [])
        for p in row.get("proposals", [])
    }
    snapshot_stages = {row["id"]: row for row in run.snapshot["stages"]}
    applied = list(run.result.get("applied", []))
    changes = []
    for stage_id, code in selected:
        pair = results.get((stage_id, code))
        if (
            pair is None
            or pair[1]["status"] != "ready"
            or pair[0]["status"] != "completed"
        ):
            raise HTTPException(422, "Выбрано предложение без подтверждённого требования")
        if any(
            row["stage_id"] == stage_id
            and row["class_code"] == code
            and not row.get("reverted_at")
            for row in applied
        ):
            raise HTTPException(409, "Предложение уже применено")
        stage = db.get(ScheduleTask, uuid.UUID(stage_id))
        if (
            stage is None
            or stage.project_id != project_id
            or stage.name != pair[0]["stage_name"]
        ):
            raise HTTPException(409, "Этап изменился. Запустите анализ заново")
        current = current_probability(stage.machinery_probabilities or {}, code)
        old = pair[1]["current_probability"]
        if (current is None) != (old is None) or (
            current is not None and abs(current - old) > 0.001
        ):
            raise HTTPException(409, "Правило этапа изменилось. Запустите анализ заново")
        origin = (stage.machinery_rule_sources or {}).get(code)
        snapshot_origin = (
            snapshot_stages.get(stage_id, {}).get("sources") or {}
        ).get(code)
        if origin != snapshot_origin:
            raise HTTPException(409, "Правило этапа изменилось. Запустите анализ заново")
        changes.append((stage, code, pair[1]))
    for stage, _code, proposal in changes:
        applied.append(
            apply_document_rule(run, stage, proposal, actor_id=user.id, mode="manual")
        )
    run.result = {**run.result, "applied": applied}
    db.commit()
    db.refresh(run)
    return _run_payload(run)


@router.post("/analysis-runs/{run_id}/revert")
def revert_analysis(
    project_id: uuid.UUID,
    run_id: uuid.UUID,
    payload: SelectionRequest,
    db: DbSession,
    user: CurrentUser,
):
    run = _owned_run(project_id, run_id, db, user, write=True)
    # JSONB does not track edits to nested dicts already referenced by run.result.
    # Copy records before marking the audit entry as reverted.
    applied = [dict(row) for row in run.result.get("applied", [])]
    if not payload.selections or len(payload.selections) > 500:
        raise HTTPException(422, "Выберите изменения для отмены")
    selected = [(str(item.stage_id), item.class_code) for item in payload.selections]
    if len(set(selected)) != len(selected):
        raise HTTPException(422, "Изменения повторяются")
    for selection in payload.selections:
        stage = db.get(ScheduleTask, selection.stage_id)
        if stage is None or stage.project_id != project_id:
            raise HTTPException(404, "Этап не найден")
        code = selection.class_code
        origin = (stage.machinery_rule_sources or {}).get(code)
        if (
            not origin
            or origin.get("source") != "document"
            or origin.get("run_id") != str(run.id)
        ):
            raise HTTPException(409, "Правило уже изменено; отмена недоступна")
        record = next(
            (
                row
                for row in applied
                if row["stage_id"] == str(stage.id)
                and row["class_code"] == code
                and not row.get("reverted_at")
            ),
            None,
        )
        if record is None:
            raise HTTPException(409, "Применение не найдено")
        values = dict(stage.machinery_probabilities or {})
        for alias in aliases_for(code):
            values.pop(alias, None)
        values.update(origin.get("previous_values") or {})
        stage.machinery_probabilities = values
        sources = dict(stage.machinery_rule_sources or {})
        if origin.get("previous_source"):
            sources[code] = origin["previous_source"]
        else:
            sources.pop(code, None)
        stage.machinery_rule_sources = sources
        record["reverted_at"] = utcnow().isoformat()
        record["reverted_by"] = str(user.id)
    run.result = {**run.result, "applied": applied}
    db.commit()
    db.refresh(run)
    return _run_payload(run)
