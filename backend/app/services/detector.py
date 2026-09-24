"""Specialized Construction Machinery YOLO Detector.

Loads explicitly supplied Ultralytics YOLO weights and maps supported model
labels to 10 canonical classes of specialized construction equipment:
1. Экскаватор (Excavator)
2. Бульдозер (Bulldozer)
3. Самосвал (Dump truck)
4. Автокран (Truck crane)
5. Башенный кран (Tower crane)
6. Бетономешалка / Автобетоносмеситель (Concrete mixer truck)
7. Погрузчик (Loader / Wheel loader)
8. Каток (Roller / Compactor)
9. Автогрейдер (Grader)
10. Экскаватор-погрузчик (Backhoe loader)
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Canonical mapping of the 10 specialized machinery classes
MACHINERY_CLASSES: dict[int, tuple[str, str, str]] = {
    0: ("excavator", "Экскаватор", "MACHINERY_EXCAVATOR"),
    1: ("bulldozer", "Бульдозер", "MACHINERY_BULLDOZER"),
    2: ("dump_truck", "Самосвал", "MACHINERY_DUMP_TRUCK"),
    3: ("truck_crane", "Автокран", "MACHINERY_TRUCK_CRANE"),
    4: ("tower_crane", "Башенный кран", "MACHINERY_TOWER_CRANE"),
    5: ("concrete_mixer", "Автобетоносмеситель", "MACHINERY_CONCRETE_MIXER"),
    6: ("loader", "Погрузчик", "MACHINERY_LOADER"),
    7: ("roller", "Каток", "MACHINERY_ROLLER"),
    8: ("grader", "Автогрейдер", "MACHINERY_GRADER"),
    9: ("backhoe_loader", "Экскаватор-погрузчик", "MACHINERY_BACKHOE_LOADER"),
}

CLASS_BY_RAW_LABEL = {
    meta[0]: (class_id, *meta) for class_id, meta in MACHINERY_CLASSES.items()
}

MODEL_LABEL_ALIASES: dict[str, str] = {
    "excavator": "excavator",
    "digger": "excavator",
    "small_digger": "excavator",
    "smalldigger": "excavator",
    "shovel": "excavator",
    "bulldozer": "bulldozer",
    "dozer": "bulldozer",
    "dump_truck": "dump_truck",
    "dumptruck": "dump_truck",
    "truck": "dump_truck",
    "lorry": "dump_truck",
    "truck_crane": "truck_crane",
    "crane_truck": "truck_crane",
    "crane": "truck_crane",
    "autocran": "truck_crane",
    "tower_crane": "tower_crane",
    "concrete_mixer": "concrete_mixer",
    "concrete_truck": "concrete_mixer",
    "cement_mixer": "concrete_mixer",
    "mixer": "concrete_mixer",
    "loader": "loader",
    "wheel_loader": "loader",
    "bucket_loader": "loader",
    "roller": "roller",
    "compactor": "roller",
    "grader": "grader",
    "motor_grader": "grader",
    "backhoe_loader": "backhoe_loader",
    "backhoe": "backhoe_loader",
}


@dataclass
class DetectionResult:
    """Single detected object bounding box on a video frame."""

    class_id: int
    raw_label: str
    label_ru: str
    canonical_code: str
    confidence: float
    x1: float  # Normalized 0.0 - 1.0
    y1: float
    x2: float
    y2: float


class MachineryDetector:
    """YOLO-based detection service for specialized construction machinery."""

    def __init__(
        self, weights_path: Path | str | None = None, conf_threshold: float = 0.25
    ):
        self.conf_threshold = conf_threshold
        self._custom_weights_requested = weights_path is not None
        self.weights_path = self._resolve_weights_path(weights_path)
        self.model = None
        self.status = "initializing"
        self.status_message: str | None = None
        self._load_model()

    @property
    def is_ready(self) -> bool:
        return self.model is not None

    def _resolve_weights_path(self, custom_path: Path | str | None) -> Path:
        if custom_path:
            return Path(custom_path)

        env_path = os.getenv("YOLO_WEIGHTS_PATH")
        if env_path:
            return Path(env_path)

        # Standard cache location in storage
        base_dir = Path(__file__).resolve().parents[2] / "var" / "storage" / "weights"
        base_dir.mkdir(parents=True, exist_ok=True)
        custom_weights = base_dir / "construction_machinery.pt"
        if custom_weights.exists():
            return custom_weights

        # Standard fallback to yolov8n.pt in storage, app or backend root
        storage_yolo = base_dir / "yolov8n.pt"
        if storage_yolo.exists():
            return storage_yolo

        app_yolo = Path("/app/yolov8n.pt")
        if app_yolo.exists():
            return app_yolo

        root_yolo = Path(__file__).resolve().parents[2] / "yolov8n.pt"
        if root_yolo.exists():
            return root_yolo

        return custom_weights

    def _load_model(self) -> None:
        """Load YOLO weights or expose an explicit status."""
        try:
            from ultralytics import YOLO  # type: ignore

            if self.weights_path.exists():
                logger.info("Loading YOLO weights from %s", self.weights_path)
                self.model = YOLO(str(self.weights_path))
                self.status = "ready"
                self.status_message = f"YOLO weights loaded: {self.weights_path.name}"
            elif self._custom_weights_requested:
                self.status = "weights_missing"
                self.status_message = (
                    f"YOLO weights not found: {self.weights_path}. "
                    "Set YOLO_WEIGHTS_PATH to trained construction-machinery weights."
                )
                logger.warning(self.status_message)
                self.model = None
            else:
                logger.info(
                    "Custom weights not found at %s. Initializing with yolov8n.pt",
                    self.weights_path,
                )
                self.model = YOLO("yolov8n.pt")
                self.status = "ready"
                self.status_message = "YOLO model loaded: yolov8n.pt (COCO mapped to machinery)"
        except ImportError as error:
            self.status = "runtime_missing"
            self.status_message = "ultralytics is not installed"
            logger.warning(
                "%s: %s", self.status_message, error
            )
            self.model = None
        except Exception as error:
            self.status = "load_error"
            self.status_message = f"Failed to load YOLO weights: {error}"
            logger.exception(self.status_message)
            self.model = None

    @staticmethod
    def _normalize_model_label(label: str) -> str:
        return "_".join(label.strip().lower().replace("-", " ").split())

    def _class_metadata(
        self, result: Any, class_id: int
    ) -> tuple[int, str, str, str] | None:
        names = getattr(result, "names", None) or getattr(self.model, "names", {})
        if isinstance(names, dict):
            model_label = str(names.get(class_id, ""))
        elif isinstance(names, (list, tuple)) and 0 <= class_id < len(names):
            model_label = str(names[class_id])
        else:
            model_label = ""

        normalized = self._normalize_model_label(model_label)
        canonical_label = MODEL_LABEL_ALIASES.get(normalized)
        if canonical_label is None:
            logger.warning(
                "Ignoring unsupported YOLO class %r (id=%d)", model_label, class_id
            )
            return None
        return CLASS_BY_RAW_LABEL[canonical_label]

    def detect_frame(
        self, image_input: Any, stage_name: str | None = None
    ) -> list[DetectionResult]:
        """Run YOLO only; never synthesize detections when the model is unavailable."""
        del stage_name  # Construction stage must not influence visual classification.
        if self.model is None:
            return []

        try:
            import io
            from PIL import Image

            if isinstance(image_input, (bytes, bytearray)):
                try:
                    image_input = Image.open(io.BytesIO(image_input)).convert("RGB")
                except Exception as decode_err:
                    logger.debug("Image bytes decoding skipped: %s", decode_err)

            results = self.model.predict(
                source=image_input, conf=self.conf_threshold, verbose=False
            )
            detections: list[DetectionResult] = []

            for result in results:
                boxes = result.boxes
                if boxes is None:
                    continue

                for box in boxes:
                    source_class_id = int(box.cls[0].item())
                    meta = self._class_metadata(result, source_class_id)
                    if meta is None:
                        continue
                    class_id, raw_label, label_ru, canonical_code = meta
                    confidence = float(box.conf[0].item())
                    xyxyn = box.xyxyn[0].tolist()
                    x1, y1, x2, y2 = (max(0.0, min(1.0, float(v))) for v in xyxyn)
                    if x2 <= x1 or y2 <= y1:
                        continue

                    detections.append(
                        DetectionResult(
                            class_id=class_id,
                            raw_label=raw_label,
                            label_ru=label_ru,
                            canonical_code=canonical_code,
                            confidence=confidence,
                            x1=x1,
                            y1=y1,
                            x2=x2,
                            y2=y2,
                        )
                    )

            self.status = "ready"
            self.status_message = None
            return detections
        except Exception as error:
            self.status = "inference_error"
            self.status_message = f"YOLO inference failed: {error}"
            logger.exception(self.status_message)
            return []

    def export_onnx(self) -> Path | None:
        """Export model to ONNX format for lightweight CPU inference."""
        if self.model is not None and self.weights_path.exists():
            try:
                onnx_path = self.model.export(format="onnx")
                return Path(onnx_path)
            except Exception as e:
                logger.error("Failed to export ONNX model: %s", e)
        return None
