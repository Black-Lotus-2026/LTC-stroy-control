"""Project-scoped POS/PPR agent: retrieve, reason, validate, compare, persist."""

from __future__ import annotations

import re
import uuid
from types import SimpleNamespace

from sqlalchemy import select

from app.db.base import utcnow
from app.db.session import SessionLocal
from app.models.document import DocumentAnalysisRun, DocumentChunk
from app.services.document_application import auto_apply_ready
from app.services.document_search import build_chain, search_machinery
from app.services.machinery_rules import BY_CODE, code_for_name, current_probability
from app.services.stage_matcher import StageMachineryService


def explicit_requirement(quote: str) -> str:
    text = quote.lower().replace("ё", "е")
    if re.search(r"\bне\s+(?:треб|нуж|примен|использ|предусмотр)", text):
        return "mentioned"
    if "рекоменд" in text:
        return "recommended"
    if re.search(r"необходим|требу|предусмотр|должн|нужн|обязател", text):
        return "required"
    return "mentioned"


def stage_proposals(stage: dict, findings: list[dict]) -> tuple[list[dict], list[dict]]:
    """Convert model claims to reviewable suggestions; never infer absence."""
    values = stage.get("probabilities") or {}
    sources = stage.get("sources") or {}
    baseline = (
        StageMachineryService()
        .estimate_machinery_probabilities(stage["name"])
        .probabilities
    )
    enriched, grouped = [], {}
    from app.services.trained_detector import TrainedConstructionDetector

    for finding in findings:
        item = dict(finding)
        lexical_code = code_for_name(item["name"])
        hinted = item.get("suggested_code")
        generic = item["name"].strip().lower().replace("ё", "е") in {
            "кран",
            "машина",
            "техника",
            "транспорт",
            "автомобиль",
            "подъемник",
        }
        code = lexical_code or (hinted if hinted in BY_CODE and not generic else None)
        cue = explicit_requirement(item["quote"])
        claimed_requirement = item.get("requirement")
        requirement = cue if claimed_requirement == cue else "mentioned"
        item["class_code"] = code
        item["mapping_method"] = (
            "catalog" if lexical_code else "agent" if code else "unmapped"
        )
        item["requirement"] = requirement
        if code is None:
            item["review_status"] = "unmapped"
        elif hinted and hinted != code:
            item["review_status"] = "mapping_conflict"
        elif requirement == "mentioned":
            item["review_status"] = (
                "requirement_conflict"
                if cue != claimed_requirement
                else "no_explicit_requirement"
            )
        elif BY_CODE[code][0] not in TrainedConstructionDetector.supported_classes:
            item["review_status"] = "cv_unsupported"
        else:
            item["review_status"] = "cited"
            grouped.setdefault(code, []).append(item)
        enriched.append(item)

    proposals = []
    for code, evidence in grouped.items():
        levels = {item["requirement"] for item in evidence}
        target = (
            0.95
            if levels == {"required"}
            else 0.75
            if levels == {"recommended"}
            else None
        )
        current = current_probability(values, code)
        base = current_probability(baseline, code)
        origin = sources.get(code, {})
        legacy_manual = (
            not origin
            and current is not None
            and base is not None
            and abs(current - base) > 0.001
        )
        status = (
            "conflict"
            if target is None
            else "manual_override"
            if origin.get("source") == "manual" or legacy_manual
            else "unchanged"
            if current is not None and abs(current - target) < 0.001
            else "ready"
        )
        proposals.append(
            {
                "class_code": code,
                "class_name": BY_CODE[code][1],
                "current_probability": current,
                "baseline_probability": base,
                "proposed_probability": target,
                "status": status,
                "source": origin.get("source", "manual" if legacy_manual else "catalog"),
                "evidence": evidence,
            }
        )
    proposals.sort(key=lambda row: row["class_name"])
    return enriched, proposals


async def execute_document_run(
    run_id: str, *, chain=None, session_factory=SessionLocal
) -> dict:
    """A durable sequential agent run; one failed stage does not hide others."""
    parsed = uuid.UUID(run_id)
    with session_factory() as db:
        run = db.scalar(
            select(DocumentAnalysisRun)
            .where(DocumentAnalysisRun.id == parsed)
            .with_for_update()
        )
        if run is None or run.status != "queued":
            return {"claimed": False}
        run.status = "running"
        run.started_at = utcnow()
        db.commit()
        snapshot = run.snapshot
        doc_ids = [uuid.UUID(item["id"]) for item in snapshot["documents"]]
        chunks = db.scalars(
            select(DocumentChunk)
            .where(DocumentChunk.document_id.in_(doc_ids))
            .order_by(DocumentChunk.document_id, DocumentChunk.ordinal)
        ).all()
        chunk_inputs = [
            SimpleNamespace(
                id=c.id,
                document_id=c.document_id,
                ordinal=c.ordinal,
                locator=c.locator,
                text=c.text,
            )
            for c in chunks
        ]
        doc_names = {item["id"]: item for item in snapshot["documents"]}
        db.rollback()

    try:
        chain = chain or build_chain()
        results = []
        for stage in snapshot["stages"]:
            try:
                response = await search_machinery(
                    SimpleNamespace(
                        name=stage["name"],
                        matched_catalog_name=stage.get("matched_catalog_name"),
                    ),
                    chunk_inputs,
                    chain=chain,
                )
                findings = []
                for finding in response.items:
                    doc = doc_names[str(finding["document_id"])]
                    findings.append(
                        {
                            **finding,
                            "document_id": str(finding["document_id"]),
                            "chunk_id": str(finding["chunk_id"]),
                            "document_name": doc["filename"],
                            "document_kind": doc["kind"],
                        }
                    )
                enriched, proposals = stage_proposals(stage, findings)
                outcome = {
                    "stage_id": stage["id"],
                    "stage_name": stage["name"],
                    "summary": response.summary,
                    "reviewed_chunks": response.reviewed_chunks,
                    "status": "completed",
                    "findings": enriched,
                    "proposals": proposals,
                    "trace": [
                        *response.trace,
                        {"step": "map_and_compare", "proposals": len(proposals)},
                    ],
                }
            except Exception as exc:
                outcome = {
                    "stage_id": stage["id"],
                    "stage_name": stage["name"],
                    "summary": "Анализ этапа не завершён",
                    "reviewed_chunks": 0,
                    "status": "failed",
                    "error": type(exc).__name__,
                    "findings": [],
                    "proposals": [],
                }
            results.append(outcome)
            with session_factory() as db:
                row = db.get(DocumentAnalysisRun, parsed)
                row.result = {"stages": results, "applied": row.result.get("applied", [])}
                row.completed_count = len(results)
                db.commit()
        with session_factory() as db:
            row = db.scalar(
                select(DocumentAnalysisRun)
                .where(DocumentAnalysisRun.id == parsed)
                .with_for_update()
            )
            auto_apply = auto_apply_ready(row, db)
            row.status = (
                "partial"
                if any(item["status"] == "failed" for item in results)
                else "completed"
            )
            row.finished_at = utcnow()
            db.commit()
        return {
            "claimed": True,
            "completed": len(results),
            "applied": auto_apply["applied_count"],
        }
    except Exception as exc:
        with session_factory() as db:
            row = db.get(DocumentAnalysisRun, parsed)
            row.status = "failed"
            row.error = type(exc).__name__
            row.finished_at = utcnow()
            db.commit()
        return {"claimed": True, "error": type(exc).__name__}
