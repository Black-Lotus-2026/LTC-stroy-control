"""Conservative, standalone adapter for equipment17 and MOCS13 YOLO experts.

Models are loaded once. Frames stay in memory. No backend imports or aliases.
NMS only compares identical semantic classes; broad/narrow overlaps are review
proposals, never automatic subclass labels or machine counts.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass, field
import json
import math
from pathlib import Path
from typing import Any, Callable


EQUIPMENT17 = {
    "dump_truck": "dump_truck", "excavator": "excavator", "motor_grader": "grader",
    "roller": "roller", "crane_manipulator": "crane_manipulator", "gazelle": "gazelle",
    "forklift_standart": "forklift_standart", "bucket_loader_big": "loader",
    "mixer": "concrete_mixer", "tanker": "tanker", "bulldozer": "bulldozer",
    "cleaning_equipment": "cleaning_equipment", "truck": "truck", "trailer": "trailer",
    "forklift_giraffe": "forklift_giraffe", "bucket_loader_standart": "loader",
    "autocran": "truck_crane",
}
MOCS13 = {
    "worker": "worker", "static_crane": "tower_crane", "hanging_head": "hanging_head",
    "crane": "mobile_crane", "roller": "roller", "bulldozer": "bulldozer",
    "excavator": "excavator", "truck": "truck", "loader": "loader",
    "pump_truck": "concrete_pump", "concrete_mixer": "concrete_mixer",
    "pile_driving": "pile_driving", "other_vehicle": "other_vehicle",
}
MAPPINGS = {"equipment17": EQUIPMENT17, "mocs13": MOCS13}
LABELS_RU = {
    "excavator": "Экскаватор", "bulldozer": "Бульдозер", "dump_truck": "Самосвал",
    "truck_crane": "Автокран", "tower_crane": "Башенный кран",
    "concrete_mixer": "Бетоносмеситель", "loader": "Ковшовый погрузчик",
    "roller": "Дорожный каток", "grader": "Автогрейдер",
    "backhoe_loader": "Экскаватор-погрузчик", "concrete_pump": "Бетононасос / система подачи бетона",
    "pile_driving": "Буровая / сваебойная установка",
    "mobile_crane": "Мобильный кран (шасси не определено)",
    "crane_manipulator": "Кран-манипулятор", "gazelle": "Малотоннажный автомобиль (gazelle)",
    "forklift_standart": "Вилочный погрузчик (исходный класс)",
    "forklift_giraffe": "Погрузчик с выдвижной стрелой (исходный класс)",
    "tanker": "Автоцистерна", "cleaning_equipment": "Уборочная техника",
    "truck": "Грузовик (тип кузова не определён)", "trailer": "Прицеп",
    "worker": "Работник", "hanging_head": "Крюк / подвесной элемент крана",
    "other_vehicle": "Прочее транспортное средство",
}
CANONICAL12 = (
    "excavator", "bulldozer", "dump_truck", "truck_crane", "tower_crane", "concrete_mixer",
    "loader", "roller", "grader", "backhoe_loader", "concrete_pump", "pile_driving",
)
CAVEATS = {
    ("equipment17", "bucket_loader_big"): ["coarse loader source visibly includes backhoe-style machines; subtype unresolved"],
    ("equipment17", "bucket_loader_standart"): ["coarse loader source; do not infer or exclude a separate backhoe subtype"],
    ("mocs13", "static_crane"): ["presence_only: source may box mast and jib separately; boxes are not machine counts"],
    ("mocs13", "crane"): ["broad_mobile_crane: truck/crawler subtype unresolved; source label conflicts may exist"],
    ("mocs13", "pump_truck"): ["presence_only: source can box boom or delivery hose without visible pump vehicle"],
    ("mocs13", "loader"): ["loader subtype not established globally; do not infer backhoe_loader"],
    ("mocs13", "pile_driving"): ["foundation rig; exact drilling/piling mechanism unresolved"],
    ("mocs13", "truck"): ["generic truck; do not infer dump_truck"],
    ("equipment17", "truck"): ["generic truck; do not infer dump_truck"],
    ("equipment17", "crane_manipulator"): ["distinct source class; do not collapse into truck_crane"],
    ("equipment17", "forklift_giraffe"): ["source terminology retained; do not infer bucket loader or backhoe"],
}
PARENT_NARROW = {("truck", "dump_truck"), ("mobile_crane", "truck_crane")}


@dataclass
class Detection:
    detection_id: str
    raw_class: str
    raw_class_id: int
    semantic_class: str
    label_ru: str
    confidence: float
    xyxy: list[float]
    expert: str
    canonical: bool
    caveats: list[str] = field(default_factory=list)


@dataclass
class FrameDetections:
    detections: list[Detection]
    raw_detections: list[Detection]
    suppressed: list[dict]
    proposals: list[dict]
    experts: list[str]
    width: int
    height: int
    frame_id: str | int | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def box_iou(a: list[float], b: list[float]) -> float:
    intersection = max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - intersection
    return intersection / union if union > 0 else 0.0


def semantic_nms(detections: list[Detection], threshold: float) -> tuple[list[Detection], list[dict]]:
    """Highest-confidence representative, keeping every original in raw_detections."""
    kept, suppressed = [], []
    for candidate in sorted(detections, key=lambda d: (-d.confidence, d.detection_id)):
        match = next((d for d in kept if d.semantic_class == candidate.semantic_class
                      and box_iou(d.xyxy, candidate.xyxy) > threshold), None)
        if match is None:
            kept.append(candidate)
        else:
            suppressed.append({"detection_id": candidate.detection_id, "kept_detection_id": match.detection_id,
                               "semantic_class": candidate.semantic_class, "iou": box_iou(match.xyxy, candidate.xyxy),
                               "reason": "exact_same_semantic_class_nms"})
    return kept, suppressed


def overlap_proposals(detections: list[Detection], threshold: float) -> list[dict]:
    proposals = []
    for i, left in enumerate(detections):
        for right in detections[i + 1:]:
            pair = (left.semantic_class, right.semantic_class)
            if pair not in PARENT_NARROW and pair[::-1] not in PARENT_NARROW:
                continue
            overlap = box_iou(left.xyxy, right.xyxy)
            if overlap >= threshold:
                parent, narrow = (left, right) if pair in PARENT_NARROW else (right, left)
                proposals.append({"type": "parent_narrow_overlap_review", "parent_detection_id": parent.detection_id,
                                  "narrow_detection_id": narrow.detection_id, "parent_class": parent.semantic_class,
                                  "narrow_class": narrow.semantic_class, "iou": overlap,
                                  "action": "retain_both_pending_review", "automatic_collapse": False,
                                  "caveat": "IoU alone does not prove same object; source extents and calibration differ"})
    return proposals


class ConstructionEnsemble:
    """PIL or numpy RGB frame adapter; instantiate once outside a video loop.

    mode='equipment17'/'mocs13' selects one initialized expert; 'ensemble' runs
    all supplied experts. Model factory injection enables dependency-free mocks.
    Unknown model taxonomies are rejected rather than passed through aliases.
    """

    def __init__(self, equipment_weights: str | Path | None = None,
                 mocs_weights: str | Path | None = None, *, device: str | int | None = None,
                 model_factory: Callable[[str], Any] | None = None,
                 nms_iou: float = 0.55, proposal_iou: float = 0.5):
        if not equipment_weights and not mocs_weights:
            raise ValueError("Supply equipment_weights, mocs_weights, or both")
        if not 0 < nms_iou <= 1 or not 0 < proposal_iou <= 1:
            raise ValueError("IoU thresholds must be in (0, 1]")
        if model_factory is None:
            from ultralytics import YOLO
            model_factory = YOLO
        self.device, self.nms_iou, self.proposal_iou = device, nms_iou, proposal_iou
        self.models: dict[str, Any] = {}
        self.names: dict[str, dict[int, str]] = {}
        for expert, weights in (("equipment17", equipment_weights), ("mocs13", mocs_weights)):
            if weights is None:
                continue
            model = model_factory(str(weights))
            names = dict(enumerate(model.names)) if isinstance(model.names, (list, tuple)) else {int(k): v for k, v in model.names.items()}
            expected = set(MAPPINGS[expert])
            if set(names.values()) != expected or len(names) != len(expected):
                raise ValueError(f"{expert} checkpoint taxonomy mismatch: expected exact {sorted(expected)}, got {names}")
            self.models[expert], self.names[expert] = model, names

    def predict(self, frame: Any, *, mode: str = "ensemble", confidence: float = 0.2,
                imgsz: int = 960, frame_id: str | int | None = None) -> FrameDetections:
        import numpy as np
        from PIL import Image

        if isinstance(frame, Image.Image):
            # PIL input is RGB; Ultralytics ndarray inputs are BGR. Convert only
            # ndarrays below, never mutate the caller's array or write frames.
            source = frame.convert("RGB")
            width, height = source.size
        elif isinstance(frame, np.ndarray):
            if frame.ndim != 3 or frame.shape[2] != 3 or frame.dtype != np.uint8:
                raise ValueError("numpy frames must be HxWx3 uint8 RGB; convert OpenCV BGR explicitly")
            height, width = frame.shape[:2]
            source = np.ascontiguousarray(frame[:, :, ::-1])
        else:
            raise TypeError("Supply a PIL image or numpy uint8 RGB frame; disk frame paths are not accepted")
        if width <= 0 or height <= 0 or not 0 <= confidence <= 1 or imgsz <= 0:
            raise ValueError("Invalid frame dimensions, confidence or imgsz")
        experts = list(self.models) if mode == "ensemble" else [mode]
        if any(expert not in self.models for expert in experts):
            raise ValueError(f"Requested expert unavailable: {mode}; initialized: {list(self.models)}")
        raw = []
        for expert in experts:
            kwargs = {"source": source, "conf": confidence, "imgsz": imgsz,
                      "verbose": False, "stream": False, "agnostic_nms": False}
            if self.device is not None:
                kwargs["device"] = self.device
            results = list(self.models[expert].predict(**kwargs))
            if len(results) != 1:
                raise ValueError("Expected exactly one inference result per frame/expert")
            boxes = results[0].boxes
            if boxes is None:
                continue
            coords = _list(boxes.xyxy)
            scores, classes = _list(boxes.conf), _list(boxes.cls)
            if not len(coords) == len(scores) == len(classes):
                raise ValueError("Model box tensors have inconsistent lengths")
            for ordinal, (xyxy, score, class_id) in enumerate(zip(coords, scores, classes)):
                score, numeric_id = float(score), float(class_id)
                if not math.isfinite(numeric_id) or not numeric_id.is_integer():
                    raise ValueError("Model produced a non-integral class ID")
                class_id = int(numeric_id)
                if class_id not in self.names[expert]:
                    raise ValueError(f"Model produced unknown class ID: {class_id}")
                if len(xyxy) != 4 or not all(math.isfinite(float(v)) for v in xyxy) or not math.isfinite(score) or not 0 <= score <= 1:
                    raise ValueError("Model produced malformed coordinates/confidence")
                if score < confidence:
                    continue
                xyxy = list(map(float, xyxy))
                clipped = [max(0., min(float(width), xyxy[0])), max(0., min(float(height), xyxy[1])),
                           max(0., min(float(width), xyxy[2])), max(0., min(float(height), xyxy[3]))]
                if clipped[2] <= clipped[0] or clipped[3] <= clipped[1]:
                    raise ValueError("Model produced empty/reversed box after clipping")
                name = self.names[expert][class_id]
                semantic = MAPPINGS[expert][name]
                caveats = list(CAVEATS.get((expert, name), []))
                if clipped != xyxy:
                    caveats.append("coordinates_clipped_to_frame")
                raw.append(Detection(f"{expert}:{ordinal}", name, class_id, semantic,
                                     LABELS_RU[semantic], score, clipped, expert,
                                     semantic in CANONICAL12, caveats))
        kept, suppressed = semantic_nms(raw, self.nms_iou)
        return FrameDetections(kept, raw, suppressed, overlap_proposals(kept, self.proposal_iou),
                               experts, width, height, frame_id)


def _list(value: Any) -> list:
    if hasattr(value, "detach"):
        value = value.detach()
    if hasattr(value, "cpu"):
        value = value.cpu()
    return value.tolist() if hasattr(value, "tolist") else list(value)


def mapping_manifest() -> dict:
    return {"schema_version": 1, "review_status": "pending_root_review",
            "canonical12": list(CANONICAL12), "semantic_labels_ru": LABELS_RU,
            "experts": {expert: [{"raw_class": raw, "semantic_class": semantic,
                                   "canonical": semantic in CANONICAL12,
                                   "caveats": CAVEATS.get((expert, raw), [])}
                                  for raw, semantic in mapping.items()]
                        for expert, mapping in MAPPINGS.items()},
            "nms_policy": "identical semantic class only; retain raw_detections and suppression provenance",
            "parent_narrow_policy": "IoU review proposals only; retain both, never automatic narrowing",
            "confidence_policy": "uncalibrated expert scores, not fused probabilities",
            "unsupported_canonical_classes": ["backhoe_loader"],
            "machine_count_warning": "MOCS tower_crane/concrete_pump boxes can be components, not complete machines"}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    parser.add_argument("--equipment-weights", type=Path)
    parser.add_argument("--mocs-weights", type=Path)
    parser.add_argument("--mode", choices=("ensemble", "equipment17", "mocs13"), default="ensemble")
    parser.add_argument("--device", help="cpu, mps, cuda:0 or GPU index")
    parser.add_argument("--confidence", type=float, default=.2)
    parser.add_argument("--imgsz", type=int, default=960)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--annotated", type=Path, help="Optional image overlay, separate from original")
    args = parser.parse_args()
    if args.annotated and args.annotated.resolve() == args.image.resolve():
        parser.error("Annotated output must not overwrite input image")
    if args.output.resolve() == args.image.resolve():
        parser.error("JSON output must not overwrite input image")
    from PIL import Image, ImageDraw
    with Image.open(args.image) as incoming:
        image = incoming.convert("RGB")
    ensemble = ConstructionEnsemble(args.equipment_weights, args.mocs_weights, device=args.device)
    result = ensemble.predict(image, mode=args.mode, confidence=args.confidence, imgsz=args.imgsz)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result.to_dict(), ensure_ascii=False, indent=2) + "\n")
    if args.annotated:
        draw = ImageDraw.Draw(image)
        for detection in result.detections:
            draw.rectangle(detection.xyxy, outline="cyan", width=2)
            draw.text((detection.xyxy[0], max(0, detection.xyxy[1] - 15)),
                      f"{detection.semantic_class} {detection.confidence:.2f} [{detection.expert}]", fill="cyan")
        args.annotated.parent.mkdir(parents=True, exist_ok=True)
        image.save(args.annotated)


if __name__ == "__main__":
    main()
