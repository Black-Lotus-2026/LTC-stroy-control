"""Executable workflow for stage-specific document machinery analysis."""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.document import DocumentChunk, ProjectDocument
from app.models.schedule import ScheduleTask
from app.models.user import User
from app.services.document_search import search_machinery
from app.services.management.context import require_project


@dataclass(frozen=True)
class StageSnapshot:
    name: str
    matched_catalog_name: str | None


@dataclass(frozen=True)
class ChunkSnapshot:
    id: uuid.UUID
    document_id: uuid.UUID
    ordinal: int
    locator: str
    text: str


@dataclass(frozen=True)
class DocumentSnapshot:
    name: str
    kind: str


class DocumentMachineryWorkflow:
    """Authorize → load evidence → retrieve → LangChain → verify citations.

    Database rows are copied into immutable snapshots before the LLM request.
    This releases the read transaction while a local model is generating.
    """

    def __init__(self, db: Session, *, chain=None):
        self.db = db
        self.chain = chain

    async def run(
        self, *, project_id: uuid.UUID, stage_id: uuid.UUID, user: User
    ) -> dict:
        require_project(self.db, project_id, user)
        stage = self.db.get(ScheduleTask, stage_id)
        if stage is None or stage.project_id != project_id:
            raise HTTPException(404, "Этап не найден на этом объекте")

        documents = self.db.scalars(
            select(ProjectDocument).where(ProjectDocument.project_id == project_id)
        ).all()
        if not documents:
            raise HTTPException(422, "Сначала загрузите ПОС, ППР или ТЕР для объекта")

        chunks = self.db.scalars(
            select(DocumentChunk)
            .join(ProjectDocument)
            .where(ProjectDocument.project_id == project_id)
        ).all()
        stage_input = StageSnapshot(stage.name, stage.matched_catalog_name)
        document_inputs = {
            doc.id: DocumentSnapshot(doc.filename, doc.kind) for doc in documents
        }
        chunk_inputs = [
            ChunkSnapshot(
                chunk.id, chunk.document_id, chunk.ordinal, chunk.locator, chunk.text
            )
            for chunk in chunks
        ]
        self.db.rollback()

        result = await search_machinery(stage_input, chunk_inputs, chain=self.chain)
        return {
            "stage_id": stage_id,
            "summary": result.summary,
            "reviewed_chunks": result.reviewed_chunks,
            "document_count": len(document_inputs),
            "items": [
                {
                    **item,
                    "document_name": document_inputs[item["document_id"]].name,
                    "document_kind": document_inputs[item["document_id"]].kind,
                }
                for item in result.items
            ],
        }
