"""Multi-Tier Discrepancy Rule Engine for Construction Compliance.

Evaluates detected machinery on video frames against active stage probability thresholds:
- Tier 1: P > 0.8 -> MANDATORY. If absent -> status ERROR (MISSING_MANDATORY)
- Tier 2: 0.6 <= P <= 0.8 -> RECOMMENDED. If absent -> WARNING
  (MISSING_RECOMMENDED).
- Tier 3: P < 0.15 -> PROHIBITED/UNCHARACTERISTIC. If present -> ERROR
  (UNCHARACTERISTIC_PRESENT).
- Tier 4: 0.15 <= P < 0.6 -> NEUTRAL. No violation.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)


MACHINERY_NAME_RU_MAP: dict[str, str] = {
    "dump_truck": "Самосвал",
    "excavator": "Экскаватор",
    "bulldozer": "Бульдозер",
    "loader": "Погрузчик",
    "wheel_loader": "Погрузчик",
    "roller": "Каток",
    "backhoe_loader": "Экскаватор-погрузчик",
    "truck_crane": "Автокран",
    "concrete_mixer": "Автобетоносмеситель",
    "tower_crane": "Башенный кран",
    "grader": "Автогрейдер",
    "concrete_pump": "Бетононасос",
    "pile_driving": "Сваебойная установка",
    "crawler_crane": "Гусеничный кран",
    "aerial_lift": "Автогидроподъемник",
    "asphalt_paver": "Асфальтоукладчик",
    "MACHINERY_DUMP_TRUCK": "Самосвал",
    "MACHINERY_EXCAVATOR": "Экскаватор",
    "MACHINERY_BULLDOZER": "Бульдозер",
    "MACHINERY_LOADER": "Погрузчик",
    "MACHINERY_WHEEL_LOADER": "Погрузчик",
    "MACHINERY_ROLLER": "Каток",
    "MACHINERY_BACKHOE_LOADER": "Экскаватор-погрузчик",
    "MACHINERY_TRUCK_CRANE": "Автокран",
    "MACHINERY_CONCRETE_MIXER": "Автобетоносмеситель",
    "MACHINERY_TOWER_CRANE": "Башенный кран",
    "MACHINERY_GRADER": "Автогрейдер",
    "MACHINERY_CONCRETE_PUMP": "Бетононасос",
    "MACHINERY_PILE_DRIVING": "Сваебойная установка",
    "MACHINERY_CRAWLER_CRANE": "Гусеничный кран",
    "MACHINERY_AERIAL_LIFT": "Автогидроподъемник",
    "MACHINERY_ASPHALT_PAVER": "Асфальтоукладчик",
}


def to_russian_machinery_name(name: str) -> str:
    """Нормализовать английские или кодовые названия техники в русский язык."""
    clean = name.strip()
    if clean in MACHINERY_NAME_RU_MAP:
        return MACHINERY_NAME_RU_MAP[clean]
    lower = clean.lower()
    if lower in MACHINERY_NAME_RU_MAP:
        return MACHINERY_NAME_RU_MAP[lower]
    stripped = lower.removeprefix("machinery_")
    if stripped in MACHINERY_NAME_RU_MAP:
        return MACHINERY_NAME_RU_MAP[stripped]
    return clean


@dataclass
class RuleEvaluationResult:
    machinery_name: str
    stage_probability: float
    observed_count: int
    severity: str  # "ERROR", "WARNING", "NEUTRAL"
    # MISSING_MANDATORY, MISSING_RECOMMENDED, UNCHARACTERISTIC_PRESENT, NEUTRAL_INFO
    discrepancy_type: str
    is_violation: bool
    description: str


class RuleEngine:
    """Evaluates observations against probabilistic requirements."""

    def evaluate_stage_machinery(
        self,
        probabilities: dict[str, float],
        detected_counts: dict[str, int],
    ) -> list[RuleEvaluationResult]:
        """Evaluate a full set of detected machinery against stage probabilities."""
        results: list[RuleEvaluationResult] = []

        # Iterate over all equipment present in either probabilities or detections
        all_equipment = set(probabilities.keys()) | set(detected_counts.keys())

        for equip in sorted(all_equipment):
            prob = probabilities.get(equip, 0.0)
            count = detected_counts.get(equip, 0)
            res = self.evaluate_single_equipment(equip, prob, count)
            results.append(res)

        return results

    def evaluate_stage_machinery_unified(
        self,
        probabilities: dict[str, float],
        unified_detected_classes: set[str],
    ) -> list[RuleEvaluationResult]:
        (
            "Evaluate a unified set of detected machinery across all connected "
            "cameras against stage probabilities."
        )
        detected_counts = {cls_name: 1 for cls_name in unified_detected_classes}
        return self.evaluate_stage_machinery(probabilities, detected_counts)

    def evaluate_single_equipment(
        self,
        machinery_name: str,
        probability: float,
        observed_count: int,
    ) -> RuleEvaluationResult:
        """Evaluate a single machine according to multi-tier thresholds."""
        machinery_name = to_russian_machinery_name(machinery_name)
        p = round(probability, 2)

        # Tier 1: Mandatory
        if p > 0.8:
            if observed_count == 0:
                return RuleEvaluationResult(
                    machinery_name=machinery_name,
                    stage_probability=p,
                    observed_count=0,
                    severity="ERROR",
                    discrepancy_type="MISSING_MANDATORY",
                    is_violation=True,
                    description=(
                        "Отсутствует обязательная техника «"
                        f"{machinery_name}"
                        "» (вероятность этапа P="
                        f"{p:.2f}"
                        " > 0.80)."
                    ),
                )
            return RuleEvaluationResult(
                machinery_name=machinery_name,
                stage_probability=p,
                observed_count=observed_count,
                severity="NEUTRAL",
                discrepancy_type="NEUTRAL_INFO",
                is_violation=False,
                description=(
                    "Обязательная техника «"
                    f"{machinery_name}"
                    "» зафиксирована на площадке в количестве "
                    f"{observed_count}"
                    " ед."
                ),
            )

        # Tier 2: Recommended
        if 0.6 <= p <= 0.8:
            if observed_count == 0:
                return RuleEvaluationResult(
                    machinery_name=machinery_name,
                    stage_probability=p,
                    observed_count=0,
                    severity="WARNING",
                    discrepancy_type="MISSING_RECOMMENDED",
                    is_violation=True,
                    description=(
                        "Отсутствует рекомендованная техника «"
                        f"{machinery_name}"
                        "» (вероятность этапа P="
                        f"{p:.2f}"
                        ")."
                    ),
                )
            return RuleEvaluationResult(
                machinery_name=machinery_name,
                stage_probability=p,
                observed_count=observed_count,
                severity="NEUTRAL",
                discrepancy_type="NEUTRAL_INFO",
                is_violation=False,
                description=(
                    "Рекомендованная техника «"
                    f"{machinery_name}"
                    "» присутствует на площадке."
                ),
            )

        # Tier 3: Prohibited / Uncharacteristic
        if p < 0.15:
            if observed_count > 0:
                return RuleEvaluationResult(
                    machinery_name=machinery_name,
                    stage_probability=p,
                    observed_count=observed_count,
                    severity="ERROR",
                    discrepancy_type="UNCHARACTERISTIC_PRESENT",
                    is_violation=True,
                    description=(
                        "Зафиксирована нехарактерная техника «"
                        f"{machinery_name}"
                        "» (P="
                        f"{p:.2f}"
                        " < 0.15). Нарушение регламента работ."
                    ),
                )
            return RuleEvaluationResult(
                machinery_name=machinery_name,
                stage_probability=p,
                observed_count=0,
                severity="NEUTRAL",
                discrepancy_type="NEUTRAL_INFO",
                is_violation=False,
                description=(
                    "Нехарактерная техника «"
                    f"{machinery_name}"
                    "» отсутствует на площадке."
                ),
            )

        # Tier 4: Neutral informational (0.15 <= P < 0.6)
        return RuleEvaluationResult(
            machinery_name=machinery_name,
            stage_probability=p,
            observed_count=observed_count,
            severity="NEUTRAL",
            discrepancy_type="NEUTRAL_INFO",
            is_violation=False,
            description=(
                "Вспомогательная техника «"
                f"{machinery_name}"
                "» (P="
                f"{p:.2f}"
                "): нейтральный статус."
            ),
        )
