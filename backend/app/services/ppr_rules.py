"""Resolve immutable, project-scoped PPR evidence into supported equipment rules.

PPR is an explicit requirement, not an estimated stage probability. The numeric
values are only the existing detector adapter's mandatory/prohibited transport.
Contradictions suppress that class until responsible users resolve them.
"""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from datetime import UTC

from app.services.rule_engine import to_russian_machinery_name


def resolve_ppr_rules(db, project_id, stage=None, observed_at=None):
    from app.services.ppr_analysis import (
        get_active_equipment_requirements,
        requirement_citation,
    )

    grouped = defaultdict(list)
    for requirement in get_active_equipment_requirements(
        db, project_id, stage, observed_at
    ):
        grouped[requirement.equipment_class].append(requirement)
    rules = {}
    for code, requirements in sorted(grouped.items()):
        kinds = {r.type for r in requirements}
        conflict = len(kinds) != 1
        citations = []
        for requirement in sorted(requirements, key=lambda r: str(r.id)):
            citation = requirement_citation(db, requirement)
            citation["rule_activated_at"] = (
                requirement.activated_at.replace(tzinfo=UTC).isoformat()
                if requirement.activated_at and requirement.activated_at.tzinfo is None
                else requirement.activated_at.astimezone(UTC).isoformat()
                if requirement.activated_at
                else None
            )
            citations.append(citation)
        rules[code] = {
            "probability": 0.5
            if conflict
            else (1.0 if kinds == {"equipment_required"} else 0.0),
            "conflict": conflict,
            "citations": citations,
        }
    revision = (
        hashlib.sha256(
            json.dumps(rules, sort_keys=True, ensure_ascii=False, default=str).encode()
        ).hexdigest()[:24]
        if rules
        else ""
    )
    return rules, revision


def ppr_evaluations(base, rules, detections, detector):
    """Replace only governed classes, retaining unrelated calendar requirements."""
    governed = {to_russian_machinery_name(code) for code in rules}
    result = [
        e for e in base if to_russian_machinery_name(e.machinery_name) not in governed
    ]
    probabilities = {
        code: r["probability"] for code, r in rules.items() if not r["conflict"]
    }
    for evaluation in detector.evaluate_rules(probabilities, detections):
        code = next(
            (
                code
                for code in rules
                if to_russian_machinery_name(code) == evaluation.machinery_name
            ),
            None,
        )
        if code is None:
            continue
        evaluation.ppr_requirements = rules[code]["citations"]
        if evaluation.is_violation:
            observation = (
                "не распознана обязательная"
                if evaluation.discrepancy_type.startswith("MISSING_")
                else "распознана запрещённая"
            )
            evaluation.description = (
                f"По требованиям ППР {observation} техника "
                f"«{evaluation.machinery_name}» в доступных ракурсах. "
                "Требуется проверка человеком."
            )
        result.append(evaluation)
    return result


def citations_for_incident(db, project_id, stage, machinery_name, discrepancy_type):
    """Resolve on the server; client-provided citations cannot authorize a verdict."""
    rules, revision = resolve_ppr_rules(db, project_id, stage)
    for code, rule in rules.items():
        if to_russian_machinery_name(code) != to_russian_machinery_name(
            machinery_name or ""
        ):
            continue
        if rule["conflict"]:
            return [], revision, "conflict"
        wanted_missing = rule["probability"] == 1.0
        if wanted_missing != discrepancy_type.startswith("MISSING_"):
            return [], revision, "contradiction"
        return rule["citations"], citation_revision(rule["citations"]), None
    return [], "", None


def citation_revision(citations):
    from app.services.ppr_extraction import normalize

    # Publishing an unrelated class must not split every ongoing episode.
    semantic = sorted(
        [
            {
                "kind": c.get("kind"),
                "equipment_class": c.get("equipment_class"),
                "quote": normalize(c.get("quote", "")),
                "scope_area_id": c.get("scope_area_id"),
            }
            for c in citations
        ],
        key=lambda c: json.dumps(c, sort_keys=True),
    )
    return hashlib.sha256(
        json.dumps(semantic, sort_keys=True, ensure_ascii=False, default=str).encode()
    ).hexdigest()[:24]
