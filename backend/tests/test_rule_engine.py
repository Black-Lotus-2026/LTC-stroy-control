"""Tests for Multi-Tier Discrepancy Rule Engine and Detector Class Mapping."""

from __future__ import annotations

import pytest
from app.services.detector import MACHINERY_CLASSES
from app.services.rule_engine import RuleEngine


def test_machinery_classes_count_and_mapping() -> None:
    """Verify specialized machinery classes are present in detector taxonomy."""
    assert len(MACHINERY_CLASSES) >= 11
    classes = [v[1] for v in MACHINERY_CLASSES.values()]
    assert "Экскаватор" in classes
    assert "Бульдозер" in classes
    assert "Самосвал" in classes
    assert "Автокран" in classes
    assert "Башенный кран" in classes
    assert "Автобетоносмеситель" in classes
    assert "Погрузчик" in classes
    assert "Каток" in classes
    assert "Автогрейдер" in classes
    assert "Экскаватор-погрузчик" in classes
    assert "Бетононасос" in classes


def test_rule_threshold_tier1_mandatory_missing() -> None:
    engine = RuleEngine()
    # P > 0.8: Missing excavator
    res = engine.evaluate_single_equipment("Экскаватор", probability=0.92, observed_count=0)
    assert res.is_violation is True
    assert res.severity == "ERROR"
    assert res.discrepancy_type == "MISSING_MANDATORY"


def test_rule_threshold_tier1_mandatory_present() -> None:
    engine = RuleEngine()
    # P > 0.8: Present excavator
    res = engine.evaluate_single_equipment("Экскаватор", probability=0.92, observed_count=1)
    assert res.is_violation is False
    assert res.severity == "NEUTRAL"


def test_rule_threshold_tier2_recommended_missing() -> None:
    engine = RuleEngine()
    # 0.6 <= P <= 0.8: Missing loader
    res = engine.evaluate_single_equipment("Погрузчик", probability=0.70, observed_count=0)
    assert res.is_violation is True
    assert res.severity == "WARNING"
    assert res.discrepancy_type == "MISSING_RECOMMENDED"


def test_rule_threshold_tier3_prohibited_present() -> None:
    engine = RuleEngine()
    # P < 0.15: Uncharacteristic grader present
    res = engine.evaluate_single_equipment("Автогрейдер", probability=0.05, observed_count=1)
    assert res.is_violation is True
    assert res.severity == "ERROR"
    assert res.discrepancy_type == "UNCHARACTERISTIC_PRESENT"


def test_rule_threshold_tier4_neutral() -> None:
    engine = RuleEngine()
    # 0.15 <= P < 0.6: Neutral auxiliary equipment
    res = engine.evaluate_single_equipment("Каток", probability=0.35, observed_count=0)
    assert res.is_violation is False
    assert res.severity == "NEUTRAL"
    assert res.discrepancy_type == "NEUTRAL_INFO"
