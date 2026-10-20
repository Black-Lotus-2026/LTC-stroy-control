"""Plan-wide agent proposals must stay cited, scoped and reversible."""

import asyncio
import json
import uuid
from datetime import UTC, datetime

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker

from app.api.v1.documents import (
    ProposalSelection,
    SelectionRequest,
    analyze_plan,
    apply_analysis,
    get_analysis,
    revert_analysis,
)
from app.api.v1.schedule import update_stage_probabilities
from app.db.base import Base
from app.models.document import DocumentAnalysisRun, DocumentChunk, ProjectDocument
from app.models.enums import UserRole
from app.models.project import Project
from app.models.schedule import ScheduleTask
from app.models.user import User
from app.schemas.stroy_control import StageMachineryOverrideRequest
from app.services.document_plan_agent import execute_document_run, stage_proposals
from app.services.machinery_rules import code_for_name, effective_cv_probabilities


@compiles(JSONB, "sqlite")
def compile_jsonb_sqlite(type_, compiler, **kw):
    return "JSON"


@pytest.fixture
def state():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as db:
        owner = User(username="agent-owner", name="Owner", role=UserRole.MANAGER)
        outsider = User(username="agent-outsider", name="Outsider", role=UserRole.MANAGER)
        project = Project(code="AGENT-ONE", name="One", owner_username=owner.username)
        stage = ScheduleTask(
            project=project,
            name="Разработка грунта",
            order_index=1,
            planned_start=datetime.now(UTC),
            planned_end=datetime.now(UTC),
            machinery_probabilities={},
            machinery_rule_sources={},
        )
        db.add_all([owner, outsider, project, stage])
        db.flush()
        document = ProjectDocument(
            project_id=project.id,
            kind="PPR",
            filename="ППР.txt",
            content_type="text/plain",
            size_bytes=50,
            sha256="a" * 64,
            content=b"source",
        )
        document.chunks = [
            DocumentChunk(
                ordinal=0,
                locator="абзац 4",
                text="Разработка грунта: требуется экскаватор.",
            )
        ]
        db.add(document)
        db.flush()
        run = DocumentAnalysisRun(
            project_id=project.id,
            created_by=owner.id,
            status="queued",
            stage_count=1,
            completed_count=0,
            snapshot={
                "stages": [
                    {
                        "id": str(stage.id),
                        "name": stage.name,
                        "matched_catalog_name": None,
                        "probabilities": {},
                        "sources": {},
                    }
                ],
                "documents": [
                    {
                        "id": str(document.id),
                        "filename": document.filename,
                        "kind": document.kind,
                        "sha256": document.sha256,
                    }
                ],
            },
            result={"stages": [], "applied": []},
        )
        db.add(run)
        db.commit()
        yield db, factory, owner, outsider, project, stage, document, run
    engine.dispose()


class CitedAgent:
    async def ainvoke(self, payload):
        context = json.loads(payload["facts_json"])
        fragment = context["fragments"][0]
        return {
            "items": [
                {
                    "name": "Экскаватор",
                    "purpose": "разработка грунта",
                    "chunk_id": fragment["id"],
                    "quote": "требуется экскаватор",
                    "requirement": "required",
                    "suggested_code": "MACHINERY_EXCAVATOR",
                }
            ],
            "summary": "Найдена техника",
        }


def test_agent_run_apply_and_revert(state):
    db, factory, owner, _, project, stage, _, run = state
    result = asyncio.run(
        execute_document_run(str(run.id), chain=CitedAgent(), session_factory=factory)
    )
    assert result == {"claimed": True, "completed": 1}
    db.expire_all()
    payload = get_analysis(project.id, run.id, db, owner)
    proposal = payload["result"]["stages"][0]["proposals"][0]
    assert proposal["status"] == "ready"
    assert proposal["evidence"][0]["quote"] == "требуется экскаватор"
    choice = SelectionRequest(
        selections=[
            ProposalSelection(stage_id=stage.id, class_code="MACHINERY_EXCAVATOR")
        ]
    )
    applied = apply_analysis(project.id, run.id, choice, db, owner)
    assert applied["result"]["applied"][0]["class_code"] == "MACHINERY_EXCAVATOR"
    db.refresh(stage)
    assert effective_cv_probabilities(stage.machinery_probabilities)["excavator"] == 0.95
    assert stage.machinery_rule_sources["MACHINERY_EXCAVATOR"]["source"] == "document"
    reverted = revert_analysis(project.id, run.id, choice, db, owner)
    assert reverted["result"]["applied"][0]["reverted_at"]
    db.refresh(stage)
    assert stage.machinery_probabilities == {}
    assert stage.machinery_rule_sources == {}


def test_manual_change_after_analysis_blocks_application(state):
    db, factory, owner, _, project, stage, _, run = state
    asyncio.run(
        execute_document_run(str(run.id), chain=CitedAgent(), session_factory=factory)
    )
    db.expire_all()
    stage.machinery_rule_sources = {"MACHINERY_EXCAVATOR": {"source": "manual"}}
    db.commit()
    choice = SelectionRequest(
        selections=[
            ProposalSelection(stage_id=stage.id, class_code="MACHINERY_EXCAVATOR")
        ]
    )
    with pytest.raises(HTTPException) as error:
        apply_analysis(project.id, run.id, choice, db, owner)
    assert error.value.status_code == 409


def test_other_project_cannot_read_agent_run(state):
    db, _, _, outsider, project, _, _, run = state
    with pytest.raises(HTTPException) as error:
        get_analysis(project.id, run.id, db, outsider)
    assert error.value.status_code == 404


def test_plan_endpoint_queues_durable_run(state, monkeypatch):
    db, _, owner, _, project, stage, _, _ = state
    queued = []
    monkeypatch.setattr("app.api.v1.documents.build_chain", lambda: object())
    monkeypatch.setattr(
        "app.workers.document_tasks.analyze_document_plan.apply_async",
        lambda args, retry: queued.append(args[0]),
    )
    response = analyze_plan(project.id, db, owner)
    assert response["status"] == "queued"
    assert response["stage_count"] == 1
    assert queued == [str(response["id"])]
    stored = db.get(DocumentAnalysisRun, response["id"])
    assert stored.snapshot["stages"][0]["id"] == str(stage.id)


def test_no_evidence_or_ambiguous_machine_never_becomes_rule():
    stage = {"name": "Разработка грунта", "probabilities": {}, "sources": {}}
    assert stage_proposals(stage, [])[1] == []
    findings, proposals = stage_proposals(
        stage,
        [
            {
                "name": "Кран",
                "quote": "требуется кран",
                "suggested_code": "MACHINERY_TRUCK_CRANE",
                "document_id": str(uuid.uuid4()),
                "chunk_id": str(uuid.uuid4()),
            }
        ],
    )
    assert findings[0]["review_status"] == "unmapped"
    assert proposals == []
    assert code_for_name("экскаватор-погрузчик") == "MACHINERY_BACKHOE_LOADER"


def test_agent_semantic_mapping_is_marked_for_human_review():
    stage = {"name": "Разработка грунта", "probabilities": {}, "sources": {}}
    findings, proposals = stage_proposals(
        stage,
        [
            {
                "name": "ковшовый погрузочно-транспортный агрегат",
                "quote": "требуется ковшовый погрузочно-транспортный агрегат",
                "requirement": "required",
                "suggested_code": "MACHINERY_LOADER",
                "document_id": str(uuid.uuid4()),
                "chunk_id": str(uuid.uuid4()),
            }
        ],
    )
    assert findings[0]["mapping_method"] == "agent"
    assert proposals[0]["status"] == "ready"
    assert proposals[0]["class_code"] == "MACHINERY_LOADER"


def test_conflicting_document_requirements_are_not_applicable():
    stage = {"name": "Разработка грунта", "probabilities": {}, "sources": {}}
    findings = [
        {
            "name": "Экскаватор",
            "quote": "требуется экскаватор",
            "requirement": "required",
            "suggested_code": "MACHINERY_EXCAVATOR",
            "document_id": str(uuid.uuid4()),
            "chunk_id": str(uuid.uuid4()),
        },
        {
            "name": "Экскаватор",
            "quote": "рекомендуется экскаватор",
            "requirement": "recommended",
            "suggested_code": "MACHINERY_EXCAVATOR",
            "document_id": str(uuid.uuid4()),
            "chunk_id": str(uuid.uuid4()),
        },
    ]
    _, proposals = stage_proposals(stage, findings)
    assert proposals[0]["status"] == "conflict"
    assert proposals[0]["proposed_probability"] is None


def test_agent_requirement_must_agree_with_citation():
    stage = {"name": "Разработка грунта", "probabilities": {}, "sources": {}}
    findings, proposals = stage_proposals(
        stage,
        [
            {
                "name": "Экскаватор",
                "quote": "требуется экскаватор",
                "requirement": "recommended",
                "suggested_code": "MACHINERY_EXCAVATOR",
            }
        ],
    )
    assert findings[0]["review_status"] == "requirement_conflict"
    assert proposals == []


def test_manual_rule_sets_provenance_and_one_effective_cv_key(state):
    db, _, owner, _, _, stage, _, _ = state
    response = update_stage_probabilities(
        str(stage.id),
        StageMachineryOverrideRequest(overrides={"MACHINERY_EXCAVATOR": "MANDATORY"}),
        db,
        owner,
    )
    assert (
        next(
            item
            for item in response.probabilities
            if item.machinery_code == "MACHINERY_EXCAVATOR"
        ).source
        == "manual"
    )
    db.refresh(stage)
    assert effective_cv_probabilities(stage.machinery_probabilities) == {
        "excavator": 0.95
    }


def test_one_failed_stage_keeps_other_agent_results(state):
    db, factory, _, _, project, _, document, run = state
    second = ScheduleTask(
        project_id=project.id,
        name="Монтаж конструкций",
        order_index=2,
        planned_start=datetime.now(UTC),
        planned_end=datetime.now(UTC),
        machinery_probabilities={},
        machinery_rule_sources={},
    )
    db.add(second)
    db.flush()
    db.add(
        DocumentChunk(
            document_id=document.id,
            ordinal=1,
            locator="абзац 5",
            text="Монтаж конструкций: требуется автокран",
        )
    )
    snapshot = dict(run.snapshot)
    snapshot["stages"] = [
        *snapshot["stages"],
        {
            "id": str(second.id),
            "name": second.name,
            "matched_catalog_name": None,
            "probabilities": {},
            "sources": {},
        },
    ]
    run.snapshot = snapshot
    run.stage_count = 2
    db.commit()

    class PartlyUnavailable(CitedAgent):
        async def ainvoke(self, payload):
            context = json.loads(payload["facts_json"])
            if context["stage"] == "Монтаж конструкций":
                raise RuntimeError("provider unavailable")
            return await super().ainvoke(payload)

    asyncio.run(
        execute_document_run(
            str(run.id), chain=PartlyUnavailable(), session_factory=factory
        )
    )
    db.expire_all()
    assert run.status == "partial"
    assert run.completed_count == 2
    assert [item["status"] for item in run.result["stages"]] == ["completed", "failed"]
