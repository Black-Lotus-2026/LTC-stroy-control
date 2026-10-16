"""Tests for Stage-to-Machinery Matcher and Probability Estimator."""

from __future__ import annotations

import time

import pytest

from app.schemas.stage_matcher import (
    MachineryProbabilityProfile,
    StageMatchResult,
)
from app.services.stage_matcher import (
    StageMachineryService,
    normalize_stage_text,
)


@pytest.fixture(scope="module")
def service() -> StageMachineryService:
    """Fixture providing initialized StageMachineryService."""
    return StageMachineryService()


# ---------------------------------------------------------------------------
# Text Normalization Tests
# ---------------------------------------------------------------------------


def test_normalize_stage_text() -> None:
    """Test Cyrillic text normalization utility."""
    raw = "  Устройство   КОТЛОВАНА... в т.ч. под ж/б плиту!  "
    normalized = normalize_stage_text(raw)
    assert normalized == "устройство котлована в т ч под ж б плиту"

    assert normalize_stage_text("Жильё и Монтаж") == "жилье и монтаж"
    assert normalize_stage_text("") == ""
    assert normalize_stage_text("   ") == ""


# ---------------------------------------------------------------------------
# Phase 3: User Story 1 - Similarity-Based Stage Matching (Mode 1)
# ---------------------------------------------------------------------------


def test_match_stage_exact_match(service: StageMachineryService) -> None:
    """Exact stage name matches canonical stage with confidence ~1.0."""
    result = service.match_stage("Подготовка территории")
    assert isinstance(result, StageMatchResult)
    assert result.is_matched is True
    assert result.matched_stage == "Подготовка территории"
    assert result.confidence >= 0.99
    assert len(result.machinery) > 0
    equipment_names = {item.equipment for item in result.machinery}
    assert "бульдозер" in equipment_names


def test_match_stage_word_order_permutation(service: StageMachineryService) -> None:
    """Inverted word order successfully maps to canonical stage."""
    result = service.match_stage("котлован разработка")
    assert result.is_matched is True
    assert result.matched_stage == "Разработка грунта котлована"
    assert result.confidence >= 0.70
    equipment_names = {item.equipment for item in result.machinery}
    assert "экскаватор" in equipment_names
    assert "самосвал" in equipment_names
    assert "бульдозер" in equipment_names


def test_match_stage_inflection_and_preposition(service: StageMachineryService) -> None:
    """Schedule stage with prepositions matches canonical earthwork stage."""
    result = service.match_stage("Разработка грунта в котловане")
    assert result.is_matched is True
    assert result.matched_stage in (
        "Разработка грунта котлована",
        "Выемка грунта котлована",
        "Устройство котлована",
    )
    assert result.confidence >= 0.70
    assert any(m.equipment == "экскаватор" for m in result.machinery)


def test_match_stage_low_confidence_unmatched(service: StageMachineryService) -> None:
    """Completely unrelated text results in is_matched=False and empty machinery."""
    result = service.match_stage("покраска забора художественной акварелью")
    assert result.is_matched is False
    assert result.confidence < 0.60
    assert result.machinery == []
    assert result.alternative_matches == []


def test_match_stage_empty_input_raises_value_error(
    service: StageMachineryService,
) -> None:
    """Empty or whitespace-only queries raise ValueError."""
    with pytest.raises(ValueError, match="Stage query cannot be empty or whitespace"):
        service.match_stage("")

    with pytest.raises(ValueError, match="Stage query cannot be empty or whitespace"):
        service.match_stage("   \t\n  ")


def test_match_stage_custom_threshold(service: StageMachineryService) -> None:
    """Per-query custom threshold overrides service default."""
    query = "котлован разработка"
    # With a very high threshold (0.99), partial match fails
    strict_res = service.match_stage(query, threshold=0.99)
    assert strict_res.is_matched is False
    assert strict_res.machinery == []

    # With normal threshold, it passes
    lenient_res = service.match_stage(query, threshold=0.70)
    assert lenient_res.is_matched is True


def test_match_stage_object_category_filter(service: StageMachineryService) -> None:
    """Specifying object_category filters machinery requirements."""
    res = service.match_stage("Устройство котлована", object_category="Жильё")
    assert res.is_matched is True
    assert len(res.machinery) > 0
    for req in res.machinery:
        assert req.object_category == "Жильё"


# ---------------------------------------------------------------------------
# Phase 4: User Story 2 - Comprehensive Machinery Probability Distribution (Mode 2)
# ---------------------------------------------------------------------------


def test_predict_probabilities_completeness_and_bounds(
    service: StageMachineryService,
) -> None:
    """Mode 2 produces all 27 machinery classes bounded in [0.0, 1.0]."""
    profile = service.predict_probabilities("Планировка площадки")
    assert isinstance(profile, MachineryProbabilityProfile)
    assert profile.query == "Планировка площадки"
    assert profile.matched_stage is not None
    assert 0.0 <= profile.confidence <= 1.0

    # Exactly 27 equipment classes
    assert len(profile.probabilities) == 27
    for eq, prob in profile.probabilities.items():
        assert isinstance(eq, str)
        assert 0.0 <= prob <= 1.0


def test_predict_probabilities_domain_ranking(service: StageMachineryService) -> None:
    """Earthwork stages score earthmoving equipment high and cranes low."""
    profile = service.predict_probabilities("Планировка площадки")
    # Earthmoving equipment should score high
    assert profile.probabilities["бульдозер"] >= 0.60

    # Unrelated equipment (e.g. tower crane, asphalt spreader) should score low
    assert profile.probabilities["башенный кран"] < 0.15
    assert profile.probabilities["асфальтоукладчик"] < 0.15


def test_predict_probabilities_empty_input_raises_value_error(
    service: StageMachineryService,
) -> None:
    """Empty input raises ValueError in Mode 2 as well."""
    with pytest.raises(ValueError, match="Stage query cannot be empty or whitespace"):
        service.predict_probabilities("")


# ---------------------------------------------------------------------------
# Phase 5: User Story 3 - Batch Processing of Schedule Stages (Mode 3)
# ---------------------------------------------------------------------------


def test_batch_match_preserves_order_and_handles_invalid(
    service: StageMachineryService,
) -> None:
    """Batch matching preserves ordering and gracefully isolates invalid items."""
    stages = [
        "Подготовка территории",
        "",  # Invalid: empty string
        "   ",  # Invalid: whitespace
        "Выемка грунта котлована",
        "несуществующая работа космического масштаба",  # Low confidence
    ]
    results = service.match_stages_batch(stages)
    assert len(results) == len(stages)
    assert results[0].is_matched is True
    assert results[0].matched_stage == "Подготовка территории"

    # Invalid empty items isolate without crashing
    assert results[1].is_matched is False
    assert results[1].confidence == 0.0
    assert results[2].is_matched is False

    # Valid item after invalid ones succeeds
    assert results[3].is_matched is True
    assert results[3].matched_stage == "Выемка грунта котлована"

    # Out of domain item is unmatched
    assert results[4].is_matched is False


def test_batch_predict_probabilities_preserves_order_and_completeness(
    service: StageMachineryService,
) -> None:
    """Batch probability estimation preserves order and outputs all classes."""
    stages = [
        "Устройство монолитных ж/б колонн",
        "",
        "Планировка грунта",
    ]
    profiles = service.predict_probabilities_batch(stages)
    assert len(profiles) == len(stages)
    assert len(profiles[0].probabilities) == 27
    assert len(profiles[1].probabilities) == 27
    assert len(profiles[2].probabilities) == 27
    assert profiles[1].confidence == 0.0


def test_batch_performance_under_3_seconds(service: StageMachineryService) -> None:
    """100 stages must be evaluated in under 3.0 seconds in-process."""
    sample_queries = [
        "Разработка грунта в котловане",
        "Устройство фундаментной плиты",
        "Монтаж колонн и перекрытий",
        "Обратная засыпка пазух котлована",
        "Планировка земляного полотна",
    ] * 20  # 100 queries

    start = time.perf_counter()
    match_results = service.match_stages_batch(sample_queries)
    prob_results = service.predict_probabilities_batch(sample_queries)
    elapsed = time.perf_counter() - start

    assert len(match_results) == 100
    assert len(prob_results) == 100
    assert elapsed < 3.0, f"Batch execution took {elapsed:.2f}s, exceeding 3.0s limit"


# ---------------------------------------------------------------------------
# Fallback Similarity Algorithm Verification
# ---------------------------------------------------------------------------


def test_fallback_similarity_without_rapidfuzz(
    monkeypatch: pytest.MonkeyPatch, service: StageMachineryService
) -> None:
    """Verify fallback algorithm logic when rapidfuzz is not available."""
    monkeypatch.setattr("app.services.stage_matcher._HAS_RAPIDFUZZ", False)

    # Identical strings
    assert service._compute_similarity("котлован", "котлован") == 1.0

    # Overlapping strings
    sim = service._compute_similarity("разработка котлована", "выемка котлована")
    assert 0.0 < sim < 1.0
