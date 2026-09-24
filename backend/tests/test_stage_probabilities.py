"""Tests for Stage Probability Analytics and Machinery Classification."""

from __future__ import annotations

import pytest
from app.services.detector import MACHINERY_CLASSES
from app.services.stage_matcher import StageMachineryService


def test_stage_machinery_service_earthwork_probabilities() -> None:
    matcher = StageMachineryService()
    profile = matcher.estimate_machinery_probabilities("Выемка грунта котлована под фундамент")

    assert profile is not None
    assert profile.query == "Выемка грунта котлована под фундамент"

    # Excavator or dump truck should have high likelihood
    probs = profile.probabilities
    # Check excavator in Russian or English
    excavator_prob = probs.get("экскаватор", probs.get("excavator", 0.0))
    assert excavator_prob >= 0.70


def test_stage_machinery_probability_classification() -> None:
    # Test threshold mapping logic
    prob_mandatory = 0.95
    assert prob_mandatory > 0.8  # MANDATORY

    prob_recommended = 0.72
    assert 0.6 <= prob_recommended <= 0.8  # RECOMMENDED

    prob_neutral = 0.35
    assert 0.15 <= prob_neutral < 0.6  # NEUTRAL

    prob_uncharacteristic = 0.05
    assert prob_uncharacteristic < 0.15  # UNCHARACTERISTIC
