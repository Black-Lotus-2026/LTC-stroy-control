"""Process-local detector profiles. New construction profiles require explicit local weights.

Shadow observations never enter compliance rules. No model download/fallback is
permitted for a requested construction profile; partial initialization is unusable.
"""

from __future__ import annotations

import threading
from functools import lru_cache
from io import BytesIO
from pathlib import Path

from app.core.config import settings
from app.services.construction_semantics import CANONICAL13, ConstructionEnsemble
from app.services.detector import CLASS_BY_RAW_LABEL, DetectionResult, MachineryDetector
from app.services.rule_engine import RuleEngine, to_russian_machinery_name


class ConstructionDetector:
    profile = "construction_ensemble"

    def __init__(
        self,
        equipment_weights,
        mocs_weights,
        *,
        device=None,
        imgsz=960,
        confidence=0.2,
        policy="shadow",
        approved_classes=(),
        model_factory=None,
    ):
        self.policy, self.imgsz, self.conf_threshold = policy, imgsz, confidence
        self.approved_classes = frozenset(approved_classes)
        if policy not in {"shadow", "enforce"}:
            raise ValueError("Unknown construction policy")
        if not self.approved_classes <= set(CANONICAL13) - {
            "backhoe_loader",
            "crawler_crane",
        }:
            raise ValueError(
                "Approved classes include unsupported or noncanonical semantics"
            )
        self.weights_path = None  # This profile has two independent checkpoints.
        self.weight_paths = {
            "equipment17": str(equipment_weights or ""),
            "mocs13": str(mocs_weights or ""),
        }
        self._lock = threading.RLock()  # Ultralytics predictors mutate internal state.
        self.ensemble = None
        self.status, self.status_message = (
            "weights_missing",
            "Both explicit local expert checkpoints are required",
        )
        if not all(
            value and Path(value).is_file() for value in self.weight_paths.values()
        ):
            return
        try:
            self.ensemble = ConstructionEnsemble(
                equipment_weights,
                mocs_weights,
                device=device,
                model_factory=model_factory,
            )
        except Exception as exc:
            self.status, self.status_message = (
                "model_error",
                f"Construction checkpoint validation failed: {type(exc).__name__}",
            )
            return
        self.status = "ready"
        self.status_message = (
            "Shadow: observations only; compliance disabled"
            if policy == "shadow"
            else "Enforce: approved classes only; observations indicate presence, not machine counts"
        )

    @property
    def is_ready(self):
        return self.ensemble is not None

    @property
    def compliance_enabled(self):
        return self.is_ready and self.policy == "enforce" and bool(self.approved_classes)

    @property
    def supported_classes(self):
        return (
            sorted(set(CANONICAL13) - {"backhoe_loader", "crawler_crane"})
            if self.is_ready
            else []
        )

    @property
    def unsupported_classes(self):
        return sorted(set(CANONICAL13) - set(self.supported_classes))

    def detect_frame_detailed(self, frame, stage_name=None, enable_slicing=True):
        if not self.is_ready:
            raise RuntimeError(self.status_message)
        from PIL import Image

        if isinstance(frame, bytes):
            with Image.open(BytesIO(frame)) as image:
                frame = image.convert("RGB")
        # Full frames only: source component extents and confidence are preserved.
        with self._lock:
            return self.ensemble.predict(
                frame, confidence=self.conf_threshold, imgsz=self.imgsz
            )

    def detect_frame(self, frame, stage_name=None, enable_slicing=True):
        if not self.is_ready:
            return []
        result = self.detect_frame_detailed(frame, stage_name, enable_slicing)
        output = []
        for detection in result.detections:
            name = detection.semantic_class
            if name not in CANONICAL13:
                continue
            metadata = CLASS_BY_RAW_LABEL.get(name)
            class_id = CANONICAL13.index(name)
            label_ru = metadata[2] if metadata else detection.label_ru
            code = metadata[3] if metadata else "MACHINERY_" + name.upper()
            x1, y1, x2, y2 = detection.xyxy
            output.append(
                DetectionResult(
                    class_id,
                    name,
                    label_ru,
                    code,
                    detection.confidence,
                    x1 / result.width,
                    y1 / result.height,
                    x2 / result.width,
                    y2 / result.height,
                )
            )
        return output

    def can_evaluate(self, machinery_name):
        wanted = to_russian_machinery_name(machinery_name)
        for name in self.approved_classes:
            metadata = CLASS_BY_RAW_LABEL.get(name)
            ru = metadata[2] if metadata else self._extended_ru(name)
            if machinery_name in {name, "MACHINERY_" + name.upper()} or wanted == ru:
                return True
        return False

    @staticmethod
    def _extended_ru(name):
        from app.services.construction_semantics import LABELS_RU

        return LABELS_RU[name]

    def evaluate_rules(self, probabilities, detections):
        if not self.compliance_enabled:
            return []
        # Restrict BOTH probabilities and observations: unsupported absence must
        # not become a missing-machine incident, nor an unconfigured extra label.
        counts = {
            d.raw_label: 1 for d in detections if d.raw_label in self.approved_classes
        }
        engine, results = RuleEngine(), []
        for name, probability in probabilities.items():
            if not self.can_evaluate(name):
                continue
            observed = any(
                self.can_evaluate(d.raw_label)
                and (
                    name in {d.raw_label, d.canonical_code, d.label_ru}
                    or to_russian_machinery_name(name) == d.label_ru
                )
                for d in detections
                if d.raw_label in counts
            )
            result = engine.evaluate_single_equipment(name, probability, int(observed))
            result.description = result.description.replace(
                "в количестве 1 ед.", "(присутствие подтверждено)."
            )
            result.description += (
                " Оценка присутствия; количество физических машин не определялось."
            )
            results.append(result)
        return results


class ConstructionPartialDetector(ConstructionDetector):
    """Single cached standard24/28 model; same shadow/rule boundaries as ensemble."""

    profile = "construction_partial"

    def __init__(
        self,
        weights,
        expected_sha256,
        mapping,
        deployment_manifest,
        *,
        device=None,
        imgsz=960,
        confidence=0.2,
        policy="shadow",
        approved_classes=(),
        model_factory=None,
        parent_support_iou=None,
    ):
        self.policy, self.imgsz, self.conf_threshold = policy, imgsz, confidence
        self.approved_classes = frozenset(approved_classes)
        if policy not in {"shadow", "enforce"} or not self.approved_classes <= set(
            CANONICAL13
        ):
            raise ValueError("Invalid partial policy or approved semantic classes")
        self.weights_path = Path(weights) if weights else None
        self.weight_paths = {"partial": str(weights or "")}
        self._lock = threading.RLock()
        self.ensemble = None
        self.status, self.status_message = (
            "weights_missing",
            "Partial profile requires local weights, trusted SHA, mapping and deployment JSON",
        )
        if not expected_sha256 or not all(
            p and Path(p).is_file() for p in (weights, mapping, deployment_manifest)
        ):
            return
        try:
            from app.services.construction_partial import ConstructionPartial

            candidate = ConstructionPartial(
                weights,
                expected_sha256,
                mapping,
                deployment_manifest,
                device=device,
                model_factory=model_factory,
                parent_support_iou=parent_support_iou,
            )
            if not self.approved_classes <= set(candidate.semantic_classes):
                raise ValueError("Approved fine class absent from actual checkpoint head")
            if policy == "enforce" and not candidate.provenance["quality_verified"]:
                raise ValueError(
                    "Enforce requires independently reviewed quality marker plus class allowlist"
                )
            self.ensemble = candidate
        except Exception as exc:
            self.status, self.status_message = (
                "model_error",
                f"Partial deployment rejected: {exc}",
            )
            return
        self.status = "ready"
        self.status_message = (
            "Shadow: raw partial observations only; uncalibrated confidence"
            if policy == "shadow"
            else "Enforce: approved semantic presence only; no physical machine counts"
        )

    @property
    def supported_classes(self):
        return (
            sorted(set(CANONICAL13) & set(self.ensemble.semantic_classes))
            if self.is_ready
            else []
        )


_initialization_lock = threading.RLock()


def get_detector():
    # lru_cache alone can call its factory twice during simultaneous cache misses.
    with _initialization_lock:
        return _cached_detector()


@lru_cache(maxsize=1)
def _cached_detector():
    """One initialized profile per API/Celery process; restart after config/weight changes.

    Celery prefork loads lazily inside the child, avoiding inherited CUDA state.
    A worker process and the API process intentionally have separate model caches.
    """
    from app.services.trained_detector import TrainedConstructionDetector

    return TrainedConstructionDetector(
        settings.yolo_weights_path,
        device=settings.construction_device,
        imgsz=settings.construction_imgsz,
        confidence=settings.construction_confidence,
    )
