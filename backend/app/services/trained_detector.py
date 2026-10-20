"""Only production YOLO: verified completed 28-channel construction checkpoint.

Missing/corrupt weights are an availability error, never another YOLO download.
One process-local model and lock serve still photographs and video frames alike.
"""

from __future__ import annotations

import hashlib
import logging
import math
import threading
from io import BytesIO
from pathlib import Path

from app.services.construction_semantics import LABELS_RU
from app.services.detection_consolidation import consolidate_detections
from app.services.detector import DetectionResult
from app.services.trained_taxonomy import (
    HEAD_NAMES,
    MODEL_SHA256,
    RUNTIME_VERSION,
    SEMANTIC_NAMES,
    TRAINING_TO_SEMANTIC,
)

logger = logging.getLogger(__name__)


class DetectorUnavailable(RuntimeError):
    pass


class DetectorInferenceError(RuntimeError):
    pass


def decode_image(contents: bytes):
    """Reject undecodable/oversized images before YOLO or an external provider."""
    from PIL import Image, ImageOps, UnidentifiedImageError

    try:
        with Image.open(BytesIO(contents)) as opened:
            if opened.width * opened.height > 40_000_000:
                raise ValueError("Image exceeds 40 megapixels")
            if getattr(opened, "n_frames", 1) != 1:
                raise ValueError("Expected one still frame, not an animated image")
            opened.load()
            return ImageOps.exif_transpose(opened).convert("RGB")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValueError("Expected a decodable image") from exc


def as_detection(row: dict) -> DetectionResult:
    name = row["class"]
    x1, y1, x2, y2 = row["xyxy"]
    code = (
        "PERSON_WORKER"
        if name == "worker"
        else "OBJECT_HANGING_HEAD"
        if name == "hanging_head"
        else "MACHINERY_" + name.upper()
    )
    return DetectionResult(
        SEMANTIC_NAMES.index(name),
        name,
        LABELS_RU[name],
        code,
        row["confidence"],
        x1,
        y1,
        x2,
        y2,
    )


class TrainedConstructionDetector:
    profile = "construction_trained"
    policy = "shadow"
    quality_verified = False
    unsupported_classes = ["grader"]
    supported_classes = [name for name in SEMANTIC_NAMES if name != "grader"]
    trained_classes = list(SEMANTIC_NAMES)
    held_classes = {
        "grader": "Ошибки исходной разметки класса; требуется отдельная проверка"
    }
    sha256 = MODEL_SHA256

    def __init__(
        self,
        weights,
        *,
        device=None,
        confidence=0.5,
        imgsz=960,
        policy="shadow",
        approved_classes=(),
    ):
        from app.services.construction_semantics import CANONICAL13

        if policy not in {"shadow", "enforce"}:
            raise ValueError("Unknown construction policy")
        self.policy = policy
        self.approved_classes = frozenset(approved_classes)
        if not self.approved_classes <= set(CANONICAL13) - {"grader"}:
            raise ValueError("Unsupported class in construction rule allowlist")
        self.weights_path = Path(weights).resolve()
        self.weight_paths = {"trained": self.weights_path.name}
        self.conf_threshold, self.imgsz = confidence, imgsz
        self._lock = threading.RLock()
        self.model = None
        self.status, self.status_message = (
            "weights_missing",
            "Обученные веса YOLO не установлены",
        )
        self.device = device
        if not self.weights_path.is_file():
            return
        try:
            with self.weights_path.open("rb") as f:
                if hashlib.file_digest(f, "sha256").hexdigest() != MODEL_SHA256:
                    raise ValueError("checkpoint_sha256_mismatch")
            import torch
            from ultralytics import YOLO, __version__
            from ultralytics.nn.tasks import DetectionModel

            if __version__ != RUNTIME_VERSION:
                raise ValueError("unsupported_runtime_version")
            # Bytes are pinned to our own completed export before deserialization.
            yolo = YOLO(str(self.weights_path))
            model, checkpoint = yolo.model, yolo.ckpt
            if type(model) is not DetectionModel or getattr(model, "end2end", False):
                raise ValueError("unsupported_checkpoint_architecture")
            if [model.names[i] for i in range(len(model.names))] != HEAD_NAMES:
                raise ValueError("checkpoint_class_order_mismatch")
            epochs = checkpoint.get("training_epochs_recorded")
            if (
                checkpoint.get("initialization_only") is not False
                or checkpoint.get("partial_source_training") is not True
                or getattr(model, "initialization_only", None) is not False
                or checkpoint.get("training_to_semantic") != TRAINING_TO_SEMANTIC
                or getattr(model, "training_to_semantic", None) != TRAINING_TO_SEMANTIC
                or not isinstance(epochs, list)
                or not epochs
                or not all(
                    isinstance(e, int | float) and math.isfinite(e) and e >= 0
                    for e in epochs
                )
            ):
                raise ValueError("checkpoint_is_not_completed_training")
            head = model.model[-1]
            if (
                head.nc != 28
                or any(branch[-1].out_channels != 28 for branch in head.cv3)
                or sorted(int(s) for s in head.stride) != [8, 16, 32]
            ):
                raise ValueError("checkpoint_head_mismatch")
            self.device = device or (
                "cuda:0"
                if torch.cuda.is_available()
                else "mps"
                if torch.backends.mps.is_available()
                else "cpu"
            )
            torch.set_num_threads(4)
            self.model = model.to(self.device).float().eval()
            self.status, self.status_message = (
                "ready",
                "Обученная YOLOv8m: 24 активные категории, грейдер временно отключён",
            )
        except Exception:
            # No secondary model, remote download, API key or sensitive path in status.
            self.model = None
            self.status, self.status_message = (
                "model_error",
                "Не удалось проверить или загрузить обученные веса YOLO",
            )
            logger.error("Trained YOLO initialization rejected", exc_info=False)

    @property
    def is_ready(self):
        return self.model is not None

    @property
    def compliance_enabled(self):
        return self.is_ready and self.policy == "enforce" and bool(self.approved_classes)

    @property
    def evaluable_classes(self):
        return sorted(self.approved_classes) if self.compliance_enabled else []

    def detect_frame(self, frame, stage_name=None, enable_slicing=True):
        del stage_name, enable_slicing
        if not self.is_ready:
            raise DetectorUnavailable(self.status_message)
        from PIL import Image

        if isinstance(frame, bytes | bytearray):
            frame = decode_image(bytes(frame))
        if not isinstance(frame, Image.Image):
            raise ValueError("Expected RGB image or encoded image bytes")
        with self._lock:
            try:
                rows = self._predict(frame)
                # No score relabeling: grouped duplicates keep their best original box.
                grouped = consolidate_detections(rows)
                return [as_detection(d) for d in grouped]
            except Exception as exc:
                logger.error("Trained YOLO inference failed: %s", type(exc).__name__)
                raise DetectorInferenceError(
                    "Не удалось выполнить распознавание YOLO"
                ) from exc

    def _predict(self, image):
        import numpy as np
        import torch
        from ultralytics.data.augment import LetterBox
        from ultralytics.utils.nms import non_max_suppression
        from ultralytics.utils.ops import scale_boxes

        rgb = np.asarray(image.convert("RGB"))
        lb = LetterBox((self.imgsz, self.imgsz), auto=False, scaleup=True, center=True)(
            image=rgb
        )
        x = (
            torch.from_numpy(np.ascontiguousarray(lb.transpose(2, 0, 1)))
            .unsqueeze(0)
            .to(self.device)
            .float()
            / 255
        )
        with torch.inference_mode():
            output = self.model(x, augment=False)
            raw = output[0] if isinstance(output, tuple) else output
            if raw.ndim != 3 or raw.shape[1] != 32 or not torch.isfinite(raw).all():
                raise ValueError("Invalid decoded detector output")
            scores = [
                raw[
                    :,
                    [
                        4 + i
                        for i, n in enumerate(HEAD_NAMES)
                        if TRAINING_TO_SEMANTIC[n] == name
                    ],
                    :,
                ].amax(1, keepdim=True)
                for name in SEMANTIC_NAMES
            ]
            decoded = torch.cat([raw[:, :4], *scores], dim=1)
            # Hold the ambiguous source label BEFORE class winner selection/NMS.
            # Merely filtering output grader boxes would erase valid loader scores.
            decoded[:, 4 + SEMANTIC_NAMES.index("grader"), :] = 0
            boxes = non_max_suppression(
                decoded.clone(),
                conf_thres=self.conf_threshold,
                iou_thres=0.7,
                nc=25,
                agnostic=False,
                multi_label=False,
                max_det=300,
                max_nms=30000,
                max_time_img=60.0,
            )[0]
            if len(boxes):
                scale_boxes((self.imgsz, self.imgsz), boxes[:, :4], rgb.shape[:2])
            values = boxes.detach().cpu().tolist()
        h, w = rgb.shape[:2]
        rows = []
        for x1, y1, x2, y2, score, c in values:
            if x2 <= x1 or y2 <= y1:
                continue
            rows.append(
                {
                    "class": SEMANTIC_NAMES[int(c)],
                    "confidence": score,
                    "xyxy": [
                        max(0.0, x1 / w),
                        max(0.0, y1 / h),
                        min(1.0, x2 / w),
                        min(1.0, y2 / h),
                    ],
                }
            )
        return rows

    def can_evaluate(self, machinery_name):
        return self.compliance_enabled and self._rule_class(machinery_name) is not None

    def _rule_class(self, name):
        from app.services.rule_engine import to_russian_machinery_name

        clean = (name or "").strip().casefold()
        for code in self.approved_classes:
            aliases = {
                code,
                "MACHINERY_" + code.upper(),
                LABELS_RU[code],
                to_russian_machinery_name(code),
            }
            if clean in {alias.casefold() for alias in aliases}:
                return code
        return None

    def evaluate_rules(self, probabilities, detections):
        from app.services.rule_engine import RuleEngine, to_russian_machinery_name

        if not self.compliance_enabled:
            return []
        # Normalize aliases once: duplicate Russian/raw keys must not produce
        # duplicate incidents, and unrelated detections cannot satisfy a rule.
        normalized = {}
        for name, probability in probabilities.items():
            code = self._rule_class(name)
            if code is not None and (code not in normalized or name == code):
                normalized[code] = probability
        observed = {
            d.raw_label
            for d in detections
            if d.raw_label in self.approved_classes
            and d.confidence >= self.conf_threshold
        }
        engine = RuleEngine()
        return [
            engine.evaluate_single_equipment(
                to_russian_machinery_name(code), probability, int(code in observed)
            )
            for code, probability in normalized.items()
        ]
