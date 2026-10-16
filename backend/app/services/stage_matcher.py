"""Stage-to-Machinery Matcher and Probability Estimator service.

Correlates freeform construction schedule work stage descriptions with
canonical reference stages from the catalog and computes continuous
probability distributions across 27 recognized construction machinery types.
"""

from __future__ import annotations

import csv
import difflib
import logging
import os
import re
from collections.abc import Sequence
from pathlib import Path

try:
    from rapidfuzz import fuzz

    _HAS_RAPIDFUZZ = True
except ImportError:  # pragma: no cover
    _HAS_RAPIDFUZZ = False

from app.schemas.stage_matcher import (
    MachineryProbabilityProfile,
    MachineryRequirement,
    RequirementSeverity,
    StageCandidateMatch,
    StageMatchResult,
)

logger = logging.getLogger(__name__)

DEFAULT_SIMILARITY_THRESHOLD = 0.60


def normalize_stage_text(text: str) -> str:
    """Normalize Cyrillic stage text for robust fuzzy similarity comparison.

    Converts to lowercase, replaces 'ё' with 'е', strips punctuation,
    and collapses multiple whitespaces.
    """
    if not text:
        return ""
    lowered = text.lower().replace("ё", "е")
    # Replace punctuation and non-alphanumeric symbols (except whitespace) with space
    cleaned = re.sub(r"[^\w\s]", " ", lowered)
    # Collapse multiple whitespaces and strip
    return " ".join(cleaned.split())


def _find_default_csv_path() -> Path | None:
    """Locate info/final_pars.csv across multiple repository and container roots."""
    candidates = [
        Path("/app/info/final_pars.csv"),
        Path("/app/data/final_pars.csv"),
        Path("/info/final_pars.csv"),
        Path(__file__).resolve().parent.parent / "data" / "final_pars.csv",
        Path(__file__).resolve().parent.parent / "info" / "final_pars.csv",
        Path(__file__).resolve().parents[2] / "info" / "final_pars.csv",
        Path(__file__).resolve().parents[3] / "info" / "final_pars.csv",
        Path.cwd() / "info" / "final_pars.csv",
        Path.cwd() / "data" / "final_pars.csv",
        Path.cwd().parent / "info" / "final_pars.csv",
    ]
    env_path = os.getenv("STAGE_CATALOG_CSV_PATH")
    if env_path:
        candidates.insert(0, Path(env_path))
    for path in candidates:
        if path.is_file():
            return path
    return None


class StageCatalogIndex:
    """In-memory indexed reference catalog parsed from info/final_pars.csv."""

    def __init__(self, csv_path: str | Path | None = None) -> None:
        self.csv_path = Path(csv_path) if csv_path else _find_default_csv_path()
        self.equipment_classes: list[str] = []
        self.canonical_stages: list[str] = []
        self.normalized_stages: list[tuple[str, str]] = []
        self._stage_requirements: dict[str, list[MachineryRequirement]] = {}
        self._stage_requirements_by_object: dict[
            str, dict[str, list[MachineryRequirement]]
        ] = {}
        self._stage_weights: dict[str, dict[str, float]] = {}
        self._stage_weights_by_object: dict[str, dict[str, dict[str, float]]] = {}
        self._load_catalog()

    def _load_fallback_catalog(self) -> None:
        """Load default construction machinery requirements when CSV is not accessible."""
        fallback_data = [
            ("Подготовительный этап", ["бульдозер", "экскаватор", "самосвал"]),
            ("Земляные работы", ["экскаватор", "самосвал", "бульдозер", "каток"]),
            ("Устройство оснований и фундаментов", ["буровая установка", "бетононасос", "автобетоносмеситель", "автокран"]),
            ("Возведение монолитных конструкций", ["башенный кран", "автобетоносмеситель", "бетононасос", "автокран"]),
            ("Монтаж металлоконструкций", ["автокран", "башенный кран", "подъемник строительный"]),
            ("Монтаж сборных железобетонных конструкций", ["башенный кран", "автокран", "панелевоз"]),
            ("Устройство кровли", ["автокран", "подъемник строительный"]),
            ("Фасадные и отделочные работы", ["фасадный подъемник", "автовышка", "строительные леса"]),
            ("Благоустройство территории", ["асфальтоукладчик", "каток", "погрузчик", "самосвал"]),
        ]
        unique_equipment: set[str] = set()
        unique_stages: set[str] = set()
        for stage, eq_list in fallback_data:
            unique_stages.add(stage)
            self._stage_requirements[stage] = []
            self._stage_weights[stage] = {}
            for eq in eq_list:
                unique_equipment.add(eq)
                self._stage_requirements[stage].append(
                    MachineryRequirement(equipment=eq, severity=RequirementSeverity.MANDATORY)
                )
                self._stage_weights[stage][eq] = 1.0
        self.equipment_classes = sorted(unique_equipment)
        self.canonical_stages = sorted(unique_stages)
        self.normalized_stages = [
            (stage, normalize_stage_text(stage)) for stage in self.canonical_stages
        ]

    def _load_catalog(self) -> None:
        if not self.csv_path or not self.csv_path.is_file():
            logger.warning(
                "Reference catalog file not found (tried: %s). Initializing with default catalog.",
                self.csv_path,
            )
            self._load_fallback_catalog()
            return

        unique_equipment: set[str] = set()
        unique_stages: set[str] = set()

        # Temporary aggregators: stage -> equipment -> max_severity, max_weight
        stage_eq_agg: dict[str, dict[str, tuple[RequirementSeverity, float]]] = {}
        stage_obj_eq_agg: dict[
            str, dict[str, dict[str, tuple[RequirementSeverity, float]]]
        ] = {}

        with open(self.csv_path, encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            for row in reader:
                stage = (row.get("stage") or "").strip()
                equipment = (row.get("equipment") or "").strip().lower()
                obj_cat = (row.get("object") or "").strip()
                mandatory_raw = (row.get("mandatory") or "").strip().lower()

                if not stage or not equipment:
                    continue

                unique_stages.add(stage)
                unique_equipment.add(equipment)

                is_mandatory = "обязательн" in mandatory_raw
                severity = (
                    RequirementSeverity.MANDATORY
                    if is_mandatory
                    else RequirementSeverity.OPTIONAL
                )
                weight = 1.0 if is_mandatory else 0.5

                # Global stage aggregation
                if stage not in stage_eq_agg:
                    stage_eq_agg[stage] = {}
                existing_sev, existing_weight = stage_eq_agg[stage].get(
                    equipment, (RequirementSeverity.OPTIONAL, 0.0)
                )
                if weight > existing_weight:
                    stage_eq_agg[stage][equipment] = (severity, weight)

                # Object-specific aggregation
                if stage not in stage_obj_eq_agg:
                    stage_obj_eq_agg[stage] = {}
                if obj_cat not in stage_obj_eq_agg[stage]:
                    stage_obj_eq_agg[stage][obj_cat] = {}
                ex_obj_sev, ex_obj_wt = stage_obj_eq_agg[stage][obj_cat].get(
                    equipment, (RequirementSeverity.OPTIONAL, 0.0)
                )
                if weight > ex_obj_wt:
                    stage_obj_eq_agg[stage][obj_cat][equipment] = (severity, weight)

        self.equipment_classes = sorted(unique_equipment)
        self.canonical_stages = sorted(unique_stages)
        self.normalized_stages = [
            (stage, normalize_stage_text(stage)) for stage in self.canonical_stages
        ]

        # Convert aggregated dicts to models
        for stage, eq_dict in stage_eq_agg.items():
            self._stage_requirements[stage] = [
                MachineryRequirement(equipment=eq, severity=sev)
                for eq, (sev, _) in eq_dict.items()
            ]
            self._stage_weights[stage] = {
                eq: weight for eq, (_, weight) in eq_dict.items()
            }

        for stage, obj_dict in stage_obj_eq_agg.items():
            self._stage_requirements_by_object[stage] = {}
            self._stage_weights_by_object[stage] = {}
            for obj_cat, eq_dict in obj_dict.items():
                self._stage_requirements_by_object[stage][obj_cat] = [
                    MachineryRequirement(
                        equipment=eq, severity=sev, object_category=obj_cat
                    )
                    for eq, (sev, _) in eq_dict.items()
                ]
                self._stage_weights_by_object[stage][obj_cat] = {
                    eq: weight for eq, (_, weight) in eq_dict.items()
                }

    def get_requirements(
        self, stage_name: str, object_category: str | None = None
    ) -> list[MachineryRequirement]:
        """Return expected machinery requirements for a canonical stage."""
        if (
            object_category
            and stage_name in self._stage_requirements_by_object
            and object_category in self._stage_requirements_by_object[stage_name]
        ):
            return self._stage_requirements_by_object[stage_name][object_category]
        return self._stage_requirements.get(stage_name, [])

    def get_equipment_weights(
        self, stage_name: str, object_category: str | None = None
    ) -> dict[str, float]:
        """Return equipment weight map (1.0 mandatory, 0.5 optional) for stage."""
        if (
            object_category
            and stage_name in self._stage_weights_by_object
            and object_category in self._stage_weights_by_object[stage_name]
        ):
            return self._stage_weights_by_object[stage_name][object_category]
        return self._stage_weights.get(stage_name, {})


# Mapping of catalog freeform equipment to specialized 10 YOLO classes
CATALOG_TO_YOLO_MAP: dict[str, str] = {
    "автобетоносмеситель": "concrete_mixer",
    "автобетононасос": "concrete_pump",
    "бетононасос": "concrete_pump",
    "растворонасос": "concrete_pump",
    "бетономешалка": "concrete_mixer",
    "машина для подачи раствора": "concrete_mixer",
    "растворосмеситель": "concrete_mixer",
    "бетонолитное оборудование": "concrete_mixer",
    "самосвал": "dump_truck",
    "автосамосвал": "dump_truck",
    "автомобиль-самосвал": "dump_truck",
    "грузовик": "dump_truck",
    "бортовой автомобиль": "dump_truck",
    "автокран": "truck_crane",
    "кран стреловой": "truck_crane",
    "кран гусеничный": "truck_crane",
    "кран-манипулятор": "truck_crane",
    "бурильно-крановая машина": "truck_crane",
    "башенный кран": "tower_crane",
    "экскаватор": "excavator",
    "экскаватор с грейфером": "excavator",
    "бульдозер": "bulldozer",
    "погрузчик": "loader",
    "фронтальный погрузчик": "loader",
    "вилочный погрузчик": "loader",
    "каток": "roller",
    "каток малогабаритный": "roller",
    "асфальтоукладчик": "roller",
    "виброплита": "roller",
    "вибропогружатель": "roller",
    "вибротрамбовка": "roller",
    "электротрамбовка": "roller",
    "автогрейдер": "grader",
    "экскаватор-погрузчик": "backhoe_loader",
}

YOLO_RAW_TO_RU: dict[str, str] = {
    "excavator": "экскаватор",
    "bulldozer": "бульдозер",
    "dump_truck": "самосвал",
    "truck_crane": "автокран",
    "tower_crane": "башенный кран",
    "concrete_mixer": "автобетоносмеситель",
    "loader": "погрузчик",
    "roller": "каток",
    "grader": "автогрейдер",
    "backhoe_loader": "экскаватор-погрузчик",
    "concrete_pump": "бетононасос",
}

STAGE_DOMAIN_PRIORS: list[tuple[list[str], dict[str, float]]] = [
    # Masonry, brickwork, partitions, external walls:
    (["кладк", "перегород", "каменн", "кирпич", "блок"], {
        "tower_crane": 0.95,
        "concrete_mixer": 0.90,
        "loader": 0.80,
        "dump_truck": 0.72,
        "truck_crane": 0.65,
    }),
    # Monolithic structures, frame, columns, floors:
    (["монолит", "каркас", "перекрыти", "колонн", "пилон", "лестниц"], {
        "tower_crane": 0.96,
        "concrete_mixer": 0.94,
        "concrete_pump": 0.92,
        "truck_crane": 0.65,
        "dump_truck": 0.60,
        "loader": 0.55,
    }),
    # Earthworks, pit excavation, soil:
    (["котлован", "выемк", "грунт", "землян", "разработк"], {
        "excavator": 0.96,
        "dump_truck": 0.94,
        "bulldozer": 0.88,
        "loader": 0.72,
        "backhoe_loader": 0.68,
    }),
    # Site preparation:
    (["подготовк.*площад", "подготовк.*территор", "подготовительн"], {
        "bulldozer": 0.88,
        "loader": 0.80,
        "roller": 0.75,
        "dump_truck": 0.70,
        "excavator": 0.60,
    }),
    # Foundations, base slab:
    (["фундамент", "бетонн.*подготовк", "плит.*основан"], {
        "concrete_mixer": 0.94,
        "concrete_pump": 0.94,
        "truck_crane": 0.82,
        "tower_crane": 0.78,
        "dump_truck": 0.65,
        "loader": 0.60,
    }),
    # Roof and insulation:
    (["кровл", "крыш", "гидроизоляц"], {
        "tower_crane": 0.88,
        "truck_crane": 0.82,
        "loader": 0.62,
        "dump_truck": 0.50,
    }),
    # Facade and windows:
    (["фасад", "окон", "витраж", "проем"], {
        "truck_crane": 0.82,
        "loader": 0.76,
        "tower_crane": 0.65,
        "dump_truck": 0.50,
    }),
    # Landscaping, roads, paving:
    (["благоустройств", "проезд", "тротуар", "асфальт", "дорог"], {
        "roller": 0.92,
        "grader": 0.88,
        "dump_truck": 0.86,
        "loader": 0.82,
        "backhoe_loader": 0.78,
    }),
]


class StageMachineryService:
    """In-process service for correlating work stages with expected machinery."""

    def __init__(
        self,
        catalog: StageCatalogIndex | None = None,
        default_threshold: float = DEFAULT_SIMILARITY_THRESHOLD,
    ) -> None:
        self.catalog = catalog or StageCatalogIndex()
        self.default_threshold = default_threshold

    def _compute_similarity(self, query_norm: str, candidate_norm: str) -> float:
        """Compute string similarity score in range [0.0, 1.0]."""
        if query_norm == candidate_norm:
            return 1.0
        if _HAS_RAPIDFUZZ:
            ts_score = float(fuzz.token_set_ratio(query_norm, candidate_norm))
            sort_score = float(fuzz.token_sort_ratio(query_norm, candidate_norm))
            return (ts_score + sort_score) / 200.0

        # Standard library fallback
        tokens_q = set(query_norm.split())
        tokens_c = set(candidate_norm.split())
        jaccard = (
            len(tokens_q & tokens_c) / len(tokens_q | tokens_c)
            if (tokens_q | tokens_c)
            else 0.0
        )
        seq_ratio = difflib.SequenceMatcher(None, query_norm, candidate_norm).ratio()
        return float(max(jaccard, seq_ratio))

    def match_stage(
        self,
        stage_name: str,
        *,
        object_category: str | None = None,
        threshold: float | None = None,
    ) -> StageMatchResult:
        """Match an input stage name to the closest canonical reference stage.

        Args:
            stage_name: Freeform work stage name from schedule.
            object_category: Optional building typology to filter requirements.
            threshold: Minimum similarity threshold (overrides default).

        Returns:
            StageMatchResult containing matched equipment and confidence.

        Raises:
            ValueError: If stage_name is empty or contains only whitespace.
        """
        if not stage_name or not stage_name.strip():
            raise ValueError("Stage query cannot be empty or whitespace.")

        query_norm = normalize_stage_text(stage_name)
        if not query_norm:
            raise ValueError("Stage query cannot be empty or whitespace.")

        effective_threshold = (
            threshold if threshold is not None else self.default_threshold
        )

        candidates: list[tuple[str, float]] = []
        for canonical, norm in self.catalog.normalized_stages:
            sim = self._compute_similarity(query_norm, norm)
            candidates.append((canonical, sim))

        candidates.sort(key=lambda x: x[1], reverse=True)

        if not candidates:
            return StageMatchResult(
                query=stage_name,
                matched_stage=None,
                confidence=0.0,
                is_matched=False,
                machinery=[],
                alternative_matches=[],
            )

        best_stage, best_score = candidates[0]
        confidence = round(best_score, 4)
        is_matched = confidence >= effective_threshold

        if not is_matched:
            return StageMatchResult(
                query=stage_name,
                matched_stage=best_stage,
                confidence=confidence,
                is_matched=False,
                machinery=[],
                alternative_matches=[],
            )

        machinery = self.catalog.get_requirements(
            best_stage, object_category=object_category
        )
        alternatives = [
            StageCandidateMatch(stage_name=stage, similarity=round(score, 4))
            for stage, score in candidates[1:]
            if score >= effective_threshold
        ]

        return StageMatchResult(
            query=stage_name,
            matched_stage=best_stage,
            confidence=confidence,
            is_matched=True,
            machinery=machinery,
            alternative_matches=alternatives,
        )

    def predict_probabilities(
        self,
        stage_name: str,
        *,
        object_category: str | None = None,
        top_k: int = 5,
        include_yolo: bool = False,
    ) -> MachineryProbabilityProfile:
        """Estimate likelihood for all 27 machinery types on a given stage.

        Args:
            stage_name: Freeform work stage text.
            object_category: Optional building typology.
            top_k: Number of top similar reference stages for aggregation.
            include_yolo: Whether to map and include the 10 specialized YOLO classes.

        Returns:
            MachineryProbabilityProfile with probabilities for equipment types.

        Raises:
            ValueError: If stage_name is empty or whitespace-only.
        """
        if not stage_name or not stage_name.strip():
            raise ValueError("Stage query cannot be empty or whitespace.")

        query_norm = normalize_stage_text(stage_name)
        if not query_norm:
            raise ValueError("Stage query cannot be empty or whitespace.")

        candidates: list[tuple[str, float]] = []
        for canonical, norm in self.catalog.normalized_stages:
            sim = self._compute_similarity(query_norm, norm)
            candidates.append((canonical, sim))

        candidates.sort(key=lambda x: x[1], reverse=True)

        best_stage, best_score = candidates[0] if candidates else (None, 0.0)
        confidence = round(best_score, 4)

        probabilities = {eq: 0.0 for eq in self.catalog.equipment_classes}
        top_candidates = candidates[: max(1, top_k)]

        for stage, sim in top_candidates:
            weights = self.catalog.get_equipment_weights(
                stage, object_category=object_category
            )
            for eq, weight in weights.items():
                prob = round(sim * weight, 4)
                if prob > probabilities.get(eq, 0.0):
                    probabilities[eq] = prob

        if include_yolo:
            # Map catalog equipment to specialized 10 YOLO classes
            yolo_probs: dict[str, float] = {k: 0.0 for k in YOLO_RAW_TO_RU}
            for eq, prob in list(probabilities.items()):
                eq_lower = eq.lower()
                if eq_lower in CATALOG_TO_YOLO_MAP:
                    raw_k = CATALOG_TO_YOLO_MAP[eq_lower]
                    if prob > yolo_probs[raw_k]:
                        yolo_probs[raw_k] = prob
                elif eq_lower in yolo_probs and prob > yolo_probs[eq_lower]:
                    yolo_probs[eq_lower] = prob

            # Apply construction domain priors based on stage query
            query_l = stage_name.lower()
            for keywords, priors in STAGE_DOMAIN_PRIORS:
                if any(re.search(kw, query_l) for kw in keywords):
                    for raw_k, prior_prob in priors.items():
                        if prior_prob > yolo_probs.get(raw_k, 0.0):
                            yolo_probs[raw_k] = prior_prob

            # Ensure both raw labels (e.g. 'tower_crane') and RU labels (e.g. 'башенный кран') are populated
            for raw_k, ru_k in YOLO_RAW_TO_RU.items():
                val = yolo_probs[raw_k]
                probabilities[raw_k] = val
                if val > probabilities.get(ru_k, 0.0):
                    probabilities[ru_k] = val

        return MachineryProbabilityProfile(
            query=stage_name,
            matched_stage=best_stage,
            confidence=confidence,
            probabilities=probabilities,
        )

    def estimate_machinery_probabilities(
        self,
        stage_name: str,
        *,
        object_category: str | None = None,
        top_k: int = 5,
        include_yolo: bool = True,
    ) -> MachineryProbabilityProfile:
        """Estimate likelihood with the 10 specialized YOLO classes for UI & analytics."""
        return self.predict_probabilities(
            stage_name,
            object_category=object_category,
            top_k=top_k,
            include_yolo=include_yolo,
        )

    def match_stages_batch(
        self,
        stage_names: Sequence[str],
        *,
        object_category: str | None = None,
        threshold: float | None = None,
    ) -> list[StageMatchResult]:
        """Batch match multiple stage names efficiently (Mode 1 batch)."""
        results: list[StageMatchResult] = []
        for stage_name in stage_names:
            if not stage_name or not stage_name.strip():
                results.append(
                    StageMatchResult(
                        query=stage_name,
                        matched_stage=None,
                        confidence=0.0,
                        is_matched=False,
                        machinery=[],
                        alternative_matches=[],
                    )
                )
                continue
            try:
                result = self.match_stage(
                    stage_name,
                    object_category=object_category,
                    threshold=threshold,
                )
                results.append(result)
            except ValueError:
                results.append(
                    StageMatchResult(
                        query=stage_name,
                        matched_stage=None,
                        confidence=0.0,
                        is_matched=False,
                        machinery=[],
                        alternative_matches=[],
                    )
                )
        return results

    def predict_probabilities_batch(
        self,
        stage_names: Sequence[str],
        *,
        object_category: str | None = None,
        top_k: int = 5,
    ) -> list[MachineryProbabilityProfile]:
        """Batch probability estimation across multiple stage names (Mode 2 batch)."""
        results: list[MachineryProbabilityProfile] = []
        empty_probs = {eq: 0.0 for eq in self.catalog.equipment_classes}
        for stage_name in stage_names:
            if not stage_name or not stage_name.strip():
                results.append(
                    MachineryProbabilityProfile(
                        query=stage_name,
                        matched_stage=None,
                        confidence=0.0,
                        probabilities=dict(empty_probs),
                    )
                )
                continue
            try:
                result = self.predict_probabilities(
                    stage_name,
                    object_category=object_category,
                    top_k=top_k,
                )
                results.append(result)
            except ValueError:
                results.append(
                    MachineryProbabilityProfile(
                        query=stage_name,
                        matched_stage=None,
                        confidence=0.0,
                        probabilities=dict(empty_probs),
                    )
                )
        return results
