from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, Field


class RequirementSeverity(StrEnum):
    """Criticality of equipment requirement on a work stage."""

    MANDATORY = "mandatory"
    OPTIONAL = "optional"


class MachineryRequirement(BaseModel):
    """Specific equipment requirement for a work stage."""

    equipment: str = Field(description="Equipment class name, e.g., 'экскаватор'")
    severity: RequirementSeverity = Field(
        default=RequirementSeverity.MANDATORY,
        description="Whether equipment is mandatory or optional",
    )
    object_category: str | None = Field(
        default=None,
        description="Specific building/facility category if applicable",
    )


class StageCandidateMatch(BaseModel):
    """A candidate reference stage evaluated during fuzzy matching."""

    stage_name: str
    similarity: float = Field(ge=0.0, le=1.0)


class StageMatchResult(BaseModel):
    """Result of matching a query stage against reference catalog (Mode 1)."""

    query: str
    matched_stage: str | None = None
    confidence: float = Field(ge=0.0, le=1.0)
    is_matched: bool
    machinery: list[MachineryRequirement] = Field(default_factory=list)
    alternative_matches: list[StageCandidateMatch] = Field(default_factory=list)


class MachineryProbabilityProfile(BaseModel):
    """Multi-label probability distribution across all machinery classes (Mode 2)."""

    query: str
    matched_stage: str | None = None
    confidence: float = Field(ge=0.0, le=1.0)
    probabilities: dict[str, float] = Field(
        description="Probability [0.0, 1.0] for every recognized equipment class"
    )
