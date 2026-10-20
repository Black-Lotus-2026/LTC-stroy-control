"""Apply cited document rules with provenance and reversible prior values."""

from __future__ import annotations

import uuid

from sqlalchemy import select

from app.db.base import utcnow
from app.models.document import DocumentAnalysisRun, ProjectDocument
from app.models.schedule import ScheduleTask
from app.services.machinery_rules import aliases_for, current_probability, set_probability


def documents_unchanged(run: DocumentAnalysisRun, db) -> bool:
    for source in run.snapshot["documents"]:
        document = db.get(ProjectDocument, uuid.UUID(source["id"]))
        if (
            document is None
            or document.project_id != run.project_id
            or document.sha256 != source["sha256"]
        ):
            return False
    return True


def apply_document_rule(
    run: DocumentAnalysisRun,
    stage: ScheduleTask,
    proposal: dict,
    *,
    actor_id: uuid.UUID,
    mode: str,
) -> dict:
    """Mutate a locked stage and return its audit record; caller commits."""
    code = proposal["class_code"]
    values = stage.machinery_probabilities or {}
    previous_values = {key: values[key] for key in aliases_for(code) if key in values}
    sources = dict(stage.machinery_rule_sources or {})
    previous_source = sources.get(code)
    stage.machinery_probabilities = set_probability(
        values, code, proposal["proposed_probability"]
    )
    sources[code] = {
        "source": "document",
        "change_kind": proposal.get("change_kind", "document_requirement"),
        "run_id": str(run.id),
        "evidence": [
            {
                "document_id": evidence["document_id"],
                "chunk_id": evidence["chunk_id"],
                "locator": evidence["locator"],
            }
            for evidence in proposal["evidence"]
        ],
        "previous_values": previous_values,
        "previous_source": previous_source,
    }
    stage.machinery_rule_sources = sources
    return {
        "stage_id": str(stage.id),
        "class_code": code,
        "applied_by": str(actor_id),
        "applied_at": utcnow().isoformat(),
        "mode": mode,
        "change_kind": proposal.get("change_kind", "document_requirement"),
        "previous_probability": proposal["current_probability"],
        "new_probability": proposal["proposed_probability"],
    }


def auto_apply_ready(run: DocumentAnalysisRun, db) -> dict:
    """Apply ready suggestions once, skipping stale or manually edited rules."""
    applied = list(run.result.get("applied", []))
    skipped = []
    if not documents_unchanged(run, db):
        outcome = {
            "applied_count": 0,
            "skipped": [{"reason": "documents_changed"}],
            "finished_at": utcnow().isoformat(),
        }
        run.result = {**run.result, "auto_apply": outcome}
        return outcome

    for row in run.result.get("stages", []):
        if row.get("status") != "completed":
            continue
        for proposal in row.get("proposals", []):
            if proposal.get("status") != "ready":
                continue
            code = proposal["class_code"]
            stage_id = row["stage_id"]
            stage = db.scalar(
                select(ScheduleTask)
                .where(ScheduleTask.id == uuid.UUID(stage_id))
                .with_for_update()
            )
            reason = None
            if (
                stage is None
                or stage.project_id != run.project_id
                or stage.name != row["stage_name"]
            ):
                reason = "stage_changed"
            elif any(
                item["stage_id"] == stage_id
                and item["class_code"] == code
                and not item.get("reverted_at")
                for item in applied
            ):
                reason = "already_applied"
            elif (stage.machinery_rule_sources or {}).get(code, {}).get(
                "source"
            ) == "manual":
                reason = "manual_override"
            else:
                current = current_probability(stage.machinery_probabilities or {}, code)
                previous = proposal["current_probability"]
                if (current is None) != (previous is None) or (
                    current is not None and abs(current - previous) > 0.001
                ):
                    reason = "rule_changed"
            if reason:
                skipped.append(
                    {"stage_id": stage_id, "class_code": code, "reason": reason}
                )
                continue
            applied.append(
                apply_document_rule(
                    run, stage, proposal, actor_id=run.created_by, mode="automatic"
                )
            )

    outcome = {
        "applied_count": sum(
            item.get("mode") == "automatic" and not item.get("reverted_at")
            for item in applied
        ),
        "skipped": skipped,
        "finished_at": utcnow().isoformat(),
    }
    run.result = {**run.result, "applied": applied, "auto_apply": outcome}
    return outcome
