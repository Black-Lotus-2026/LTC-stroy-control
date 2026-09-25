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
    "crane_manipulator": "truck_crane",
    "tower_crane": "tower_crane",
    "concrete_mixer": "concrete_mixer",
    "concrete_truck": "concrete_mixer",
    "cement_mixer": "concrete_mixer",
    "mixer": "concrete_mixer",
    "loader": "loader",
    "wheel_loader": "loader",
    "bucket_loader": "loader",
    "bucket_loader_big": "loader",
    "bucket_loader_standard": "loader",
    "forklift": "loader",
    "forklift_standard": "loader",
    "forklift_giraffe": "loader",
    "roller": "roller",
    "compactor": "roller",
    "grader": "grader",
    "motor_grader": "grader",
    "backhoe_loader": "backhoe_loader",
    "backhoe": "backhoe_loader",
    "telehandler": "loader",
    "skid_steer": "loader",
    "crawler_crane": "truck_crane",
    "mobile_crane": "truck_crane",
}


def _box_iou(box_a: tuple[float, float, float, float], box_b: tuple[float, float, float, float]) -> float:
    """Compute IoU between two normalized boxes (x1, y1, x2, y2)."""
    xa1, ya1, xa2, ya2 = box_a
    xb1, yb1, xb2, yb2 = box_b
    inter_x1 = max(xa1, xb1)
    inter_y1 = max(ya1, yb1)
    inter_x2 = min(xa2, xb2)
    inter_y2 = min(ya2, yb2)
    if inter_x2 <= inter_x1 or inter_y2 <= inter_y1:
        return 0.0
    inter_area = (inter_x2 - inter_x1) * (inter_y2 - inter_y1)
    area_a = (xa2 - xa1) * (ya2 - ya1)
    area_b = (xb2 - xb1) * (yb2 - yb1)
    union_area = area_a + area_b - inter_area
    return inter_area / union_area if union_area > 0 else 0.0


def _nms(detections: list[DetectionResult], iou_threshold: float = 0.45) -> list[DetectionResult]:
    """Non-maximum suppression across combined full-frame and tiled slice detections."""
    if not detections:
        return []
    sorted_dets = sorted(detections, key=lambda d: d.confidence, reverse=True)
    kept: list[DetectionResult] = []
    for cand in sorted_dets:
        cand_box = (cand.x1, cand.y1, cand.x2, cand.y2)
        should_keep = True
        for exist in kept:
            exist_box = (exist.x1, exist.y1, exist.x2, exist.y2)
            iou = _box_iou(cand_box, exist_box)
            if cand.canonical_code == exist.canonical_code and iou > iou_threshold:
                should_keep = False
                break
            # Suppress if candidate box is substantially enveloped by existing same-category box
            if cand.canonical_code == exist.canonical_code:
                cand_area = (cand.x2 - cand.x1) * (cand.y2 - cand.y1)
                inter_x1 = max(cand.x1, exist.x1)
                inter_y1 = max(cand.y1, exist.y1)
                inter_x2 = min(cand.x2, exist.x2)
                inter_y2 = min(cand.y2, exist.y2)
                if inter_x2 > inter_x1 and inter_y2 > inter_y1 and cand_area > 0:
                    inter_area = (inter_x2 - inter_x1) * (inter_y2 - inter_y1)
                    if (inter_area / cand_area) > 0.85:
                        should_keep = False
                        break
        if should_keep:
            kept.append(cand)
    return kept


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
        self, weights_path: Path | str | None = None, conf_threshold: float = 0.20
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
        if env_path and Path(env_path).exists():
            return Path(env_path)

        # Standard direct weights location in app/backend
        app_weights = Path(__file__).resolve().parents[2] / "weights" / "construction_machinery.pt"
        if app_weights.exists():
            return app_weights

        # Standard cache location in storage
        base_dir = Path(__file__).resolve().parents[2] / "var" / "storage" / "weights"
        base_dir.mkdir(parents=True, exist_ok=True)
        custom_weights = base_dir / "construction_machinery.pt"
        if custom_weights.exists():
            return custom_weights

        best_weights = base_dir / "best.pt"
        if best_weights.exists():
            return best_weights

        # Fallback to env path even if not yet created
        if env_path:
            return Path(env_path)

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
        self,
        image_input: Any,
        stage_name: str | None = None,
        enable_slicing: bool = True,
    ) -> list[DetectionResult]:
        """Run YOLO inference with adaptive tiled slicing (SAHI) for detecting small/distant machinery."""
        del stage_name
        if self.model is None:
            return []

        try:
            import io
            from PIL import Image

            img: Image.Image | None = None
            if isinstance(image_input, (bytes, bytearray)):
                try:
                    img = Image.open(io.BytesIO(image_input)).convert("RGB")
                except Exception as decode_err:
                    logger.debug("Image bytes decoding skipped: %s", decode_err)
                    img = None
            elif isinstance(image_input, Image.Image):
                img = image_input.convert("RGB")

            if img is None:
                # Direct prediction on source
                results = self.model.predict(
                    source=image_input, conf=self.conf_threshold, verbose=False
                )
                return self._extract_detections(results[0]) if results else []

            w, h = img.size

            # Adaptive tiled slicing (2x2 grid with ~16% overlap) for high-res frames to catch small objects
            if enable_slicing and w >= 600 and h >= 450:
                tw = int(w * 0.58)
                th = int(h * 0.58)
                slices_meta = [
                    (img, 0, 0, w, h),  # full frame for large machinery
                    (img.crop((0, 0, tw, th)), 0, 0, tw, th),  # top-left
                    (img.crop((w - tw, 0, w, th)), w - tw, 0, tw, th),  # top-right
                    (img.crop((0, h - th, tw, h)), 0, h - th, tw, th),  # bottom-left
                    (img.crop((w - tw, h - th, w, h)), w - tw, h - th, tw, th),  # bottom-right
                ]

                # Batched prediction for maximum speed in single tensor pass
                batch_images = [s[0] for s in slices_meta]
                batch_results = self.model.predict(
                    source=batch_images,
                    batch=len(batch_images),
                    conf=self.conf_threshold,
                    verbose=False,
                )

                all_detections: list[DetectionResult] = []
                for idx, res in enumerate(batch_results):
                    _, off_x, off_y, crop_w, crop_h = slices_meta[idx]
                    boxes = res.boxes
                    if boxes is None:
                        continue
                    for box in boxes:
                        source_class_id = int(box.cls[0].item())
                        meta = self._class_metadata(res, source_class_id)
                        if meta is None:
                            continue
                        class_id, raw_label, label_ru, canonical_code = meta
                        confidence = float(box.conf[0].item())
                        xyxyn = box.xyxyn[0].tolist()
                        bx1, by1, bx2, by2 = xyxyn

                        # Map back to global frame coordinates
                        abs_x1 = off_x + bx1 * crop_w
                        abs_y1 = off_y + by1 * crop_h
                        abs_x2 = off_x + bx2 * crop_w
                        abs_y2 = off_y + by2 * crop_h

                        gx1 = max(0.0, min(1.0, abs_x1 / w))
                        gy1 = max(0.0, min(1.0, abs_y1 / h))
                        gx2 = max(0.0, min(1.0, abs_x2 / w))
                        gy2 = max(0.0, min(1.0, abs_y2 / h))

                        if gx2 <= gx1 or gy2 <= gy1:
                            continue

                        all_detections.append(
                            DetectionResult(
                                class_id=class_id,
                                raw_label=raw_label,
                                label_ru=label_ru,
                                canonical_code=canonical_code,
                                confidence=confidence,
                                x1=gx1,
                                y1=gy1,
                                x2=gx2,
                                y2=gy2,
                            )
                        )

                # Merge duplicates using Non-Maximum Suppression
                detections = _nms(all_detections, iou_threshold=0.45)
            else:
                results = self.model.predict(
                    source=img, conf=self.conf_threshold, verbose=False
                )
                detections = self._extract_detections(results[0]) if results else []

            self.status = "ready"
            self.status_message = None
            return detections
        except Exception as error:
            self.status = "inference_error"
            self.status_message = f"YOLO inference failed: {error}"
            logger.exception(self.status_message)
            return []

    def _extract_detections(self, result: Any) -> list[DetectionResult]:
        detections: list[DetectionResult] = []
        boxes = getattr(result, "boxes", None)
        if boxes is None:
            return detections

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
        return detections

    def export_onnx(self) -> Path | None:
        """Export model to ONNX format for lightweight CPU inference."""
        if self.model is not None and self.weights_path.exists():
            try:
                onnx_path = self.model.export(format="onnx")
                return Path(onnx_path)
            except Exception as e:
                logger.error("Failed to export ONNX model: %s", e)
        return None
