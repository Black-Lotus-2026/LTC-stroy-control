"""Canonical CV machinery keys and effective per-stage probabilities."""

from __future__ import annotations

import re

from app.services.detector import MACHINERY_CLASSES

BY_CODE = {code: (raw, ru) for raw, ru, code in MACHINERY_CLASSES.values()}
BY_RAW = {raw: code for code, (raw, _ru) in BY_CODE.items()}

ALIASES: tuple[tuple[str, str], ...] = (
    (r"экскаватор[ -]?погрузчик|backhoe[ _-]?loader", "MACHINERY_BACKHOE_LOADER"),
    (r"башенн\w*\s+кран|tower[ _-]?crane", "MACHINERY_TOWER_CRANE"),
    (r"автокран|автомобильн\w*\s+кран|truck[ _-]?crane", "MACHINERY_TRUCK_CRANE"),
    (r"автобетоносмесител|бетономешалк|concrete[ _-]?mixer", "MACHINERY_CONCRETE_MIXER"),
    (r"бетононасос|concrete[ _-]?pump", "MACHINERY_CONCRETE_PUMP"),
    (r"автогрейдер|грейдер|grader", "MACHINERY_GRADER"),
    (r"самосвал|dump[ _-]?truck", "MACHINERY_DUMP_TRUCK"),
    (r"бульдозер|bulldozer", "MACHINERY_BULLDOZER"),
    (r"экскаватор|excavator", "MACHINERY_EXCAVATOR"),
    (r"погрузчик|loader", "MACHINERY_LOADER"),
    (r"каток|roller", "MACHINERY_ROLLER"),
)


def code_for_name(name: str) -> str | None:
    """Return only an unambiguous class supported by the product catalogue."""
    normalized = name.lower().replace("ё", "е").strip()
    if normalized.upper() in BY_CODE:
        return normalized.upper()
    for code, (raw, ru) in BY_CODE.items():
        if normalized in {raw, ru.lower().replace("ё", "е")}:
            return code
    for pattern, code in ALIASES:
        if re.search(pattern, normalized):
            return code
    return None


def aliases_for(code: str) -> tuple[str, str, str, str]:
    raw, ru = BY_CODE[code]
    return code, raw, ru, ru.lower()


def current_probability(values: dict, code: str) -> float | None:
    for key in aliases_for(code):
        value = values.get(key)
        if value is not None:
            if isinstance(value, str):
                value = {
                    "MANDATORY": 0.95,
                    "RECOMMENDED": 0.75,
                    "NEUTRAL": 0.4,
                    "UNCHARACTERISTIC": 0.05,
                }.get(value.upper(), value)
            try:
                return float(value)
            except (TypeError, ValueError):
                return None
    return None


def set_probability(values: dict, code: str, probability: float) -> dict:
    result = dict(values)
    for alias in aliases_for(code):
        result.pop(alias, None)
    result[BY_CODE[code][0]] = probability
    return result


def effective_cv_probabilities(values: dict) -> dict[str, float]:
    """One raw-label value per CV class; code overrides win over old aliases."""
    result = {}
    for code, (raw, _ru) in BY_CODE.items():
        probability = current_probability(values, code)
        if probability is not None:
            result[raw] = probability
    return result
