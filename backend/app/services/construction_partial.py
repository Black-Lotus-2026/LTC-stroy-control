"""Strict trusted deployment bundles for standard partial24/partial28 YOLO heads.

SHA/JSON/static-pickle checks precede deserialization; exact standard model,
head and decoder checks precede inference. This is not an untrusted-pickle sandbox.
Only independently trusted own checkpoint SHA values may be configured.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import pickletools
import threading
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

from app.services.construction_semantics import (
    CANONICAL13,
    LABELS_RU,
    MAPPINGS,
    Detection,
    FrameDetections,
    box_iou,
    semantic_nms,
)

os.environ.setdefault("YOLO_AUTOINSTALL", "false")


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def reviewed_contract(mapping):
    """Known public scopes and optional complete target13; reject custom aliases."""
    if not isinstance(mapping, dict) or not str(
        mapping.get("review_status", "")
    ).startswith("reviewed"):
        raise ValueError("An explicitly reviewed semantic mapping is required")
    experts = mapping.get("experts", {})
    if set(experts) not in (
        {"equipment17", "mocs13"},
        {"equipment17", "mocs13", "target13"},
    ):
        raise ValueError("Unknown source in partial mapping")
    decoder, scopes, caveats = {}, {}, {}
    for source, rows in experts.items():
        if not isinstance(rows, list) or len({row["raw_class"] for row in rows}) != len(
            rows
        ):
            raise ValueError("Repeated/malformed source classes")
        observed = {row["raw_class"]: row["semantic_class"] for row in rows}
        expected = (
            MAPPINGS[source]
            if source in MAPPINGS
            else {name: name for name in CANONICAL13}
        )
        if observed != expected:
            raise ValueError(
                "Source semantics differ from the reviewed inventory; no "
                "broad-to-narrow aliases"
            )
        for row in rows:
            raw, semantic = row["raw_class"], row["semantic_class"]
            channel = row.get("training_class", semantic)
            expected_channel = (
                source.replace("17", "").replace("13", "") + "_truck"
                if raw == "truck"
                else "target_loader"
                if source == "target13" and raw == "loader"
                else "target_concrete_pump"
                if source == "target13" and raw == "concrete_pump"
                else semantic
            )
            if channel != expected_channel:
                raise ValueError(
                    "Source Truck and target loader/pump channel scopes must "
                    "remain separate"
                )
            if channel in decoder and decoder[channel] != semantic:
                raise ValueError("Conflicting channel decoder")
            decoder[channel] = semantic
            scopes.setdefault(channel, []).append({"source": source, "raw_class": raw})
            caveats.setdefault(channel, set()).update(row.get("caveats", []))
    size = 28 if "target13" in experts else 24
    if len(decoder) != size or len(set(decoder.values())) != (25 if size == 28 else 23):
        raise ValueError("Unexpected reviewed head/semantic count")
    return {
        "names": sorted(decoder),
        "decoder": decoder,
        "scopes": scopes,
        "caveats": {key: sorted(value) for key, value in caveats.items()},
    }


# Standard YOLOv8 export globals only. A new architecture/runtime needs a review;
# neither __main__ custom training classes nor executable builtins are accepted.
_STANDARD_GLOBALS = {
    "__builtin__ set",
    "builtins set",
    "collections OrderedDict",
    "torch FloatStorage",
    "torch HalfStorage",
    "torch LongStorage",
    "torch Size",
    "torch._utils _rebuild_parameter",
    "torch._utils _rebuild_tensor_v2",
    "torch.nn.modules.activation SiLU",
    "torch.nn.modules.batchnorm BatchNorm2d",
    "torch.nn.modules.container ModuleList",
    "torch.nn.modules.container Sequential",
    "torch.nn.modules.conv Conv2d",
    "torch.nn.modules.pooling MaxPool2d",
    "torch.nn.modules.upsampling Upsample",
    "ultralytics.nn.modules.block Bottleneck",
    "ultralytics.nn.modules.block C2f",
    "ultralytics.nn.modules.block DFL",
    "ultralytics.nn.modules.block SPPF",
    "ultralytics.nn.modules.conv Concat",
    "ultralytics.nn.modules.conv Conv",
    "ultralytics.nn.modules.head Detect",
    "ultralytics.nn.tasks DetectionModel",
}


def preflight_pickle(path):
    if not zipfile.is_zipfile(path):
        raise ValueError("Require standard ZIP-format torch checkpoint")
    with zipfile.ZipFile(path) as package:
        entries = [
            item for item in package.infolist() if item.filename.endswith("/data.pkl")
        ]
        if len(entries) != 1 or entries[0].file_size > 32 * 1024 * 1024:
            raise ValueError("Unexpected checkpoint pickle layout/size")
        globals_found = set()
        for op, arg, _position in pickletools.genops(package.read(entries[0])):
            if op.name == "GLOBAL":
                globals_found.add(arg)
                if arg not in _STANDARD_GLOBALS:
                    raise ValueError(f"Unreviewed/custom pickle global: {arg}")
            elif op.name in {"STACK_GLOBAL", "INST", "OBJ", "EXT1", "EXT2", "EXT4"}:
                raise ValueError("Unsupported dynamic pickle global/opcode")
    if "ultralytics.nn.tasks DetectionModel" not in globals_found:
        raise ValueError("Checkpoint does not declare the standard DetectionModel")
    return sorted(globals_found)


def validate_bundle(weights, expected_sha256, mapping_path, manifest_path):
    weights, mapping_path, manifest_path = (
        Path(p).resolve(strict=True) for p in (weights, mapping_path, manifest_path)
    )
    if not all(path.is_file() for path in (weights, mapping_path, manifest_path)):
        raise ValueError("Deployment bundle paths must be explicit local files")
    if (
        not isinstance(expected_sha256, str)
        or len(expected_sha256) != 64
        or any(c not in "0123456789abcdef" for c in expected_sha256)
    ):
        raise ValueError("Require explicit trusted lowercase checkpoint SHA256")
    if digest(weights) != expected_sha256:
        raise ValueError("Checkpoint SHA mismatch; no deserialization performed")
    manifest = json.loads(manifest_path.read_text())
    if (
        manifest.get("artifact_type") != "trained_standard_partial_yolo"
        or manifest.get("training_completed") is not True
        or manifest.get("initialization_only") is not False
    ):
        raise ValueError(
            "Initialization/untrained/unknown artifact is not a deployment model"
        )
    if manifest.get("checkpoint_sha256") != expected_sha256 or manifest.get(
        "mapping_sha256"
    ) != digest(mapping_path):
        raise ValueError("Deployment manifest SHA does not match checkpoint/mapping")
    if type(manifest.get("quality_verified")) is not bool:
        raise ValueError(
            "Manifest must explicitly declare quality_verified; this is not calibration"
        )
    contract = reviewed_contract(json.loads(mapping_path.read_text()))
    if (
        manifest.get("head_channels") != len(contract["names"])
        or manifest.get("names") != contract["names"]
        or manifest.get("training_to_semantic") != contract["decoder"]
    ):
        raise ValueError("Deployment JSON head inventory/decoder mismatch")
    preflight_pickle(weights)
    provenance = {
        "checkpoint_sha256": expected_sha256,
        "mapping_sha256": digest(mapping_path),
        "deployment_manifest_sha256": digest(manifest_path),
        "quality_verified": manifest["quality_verified"],
        "confidence_calibrated": False,
        "head_channels": len(contract["names"]),
        "initialization_only": False,
    }
    return weights, contract, provenance


def ordered_names(names):
    if isinstance(names, dict):
        if set(names) != set(range(len(names))):
            raise ValueError("Checkpoint head IDs must be contiguous ordered integers")
        return [names[i] for i in range(len(names))]
    if isinstance(names, list | tuple):
        return list(names)
    raise ValueError("Checkpoint names missing")


@dataclass
class PartialDetection(Detection):
    source_scopes: list[dict] = field(default_factory=list)
    confidence_calibrated: bool = False


@dataclass
class PartialFrameDetections(FrameDetections):
    model_provenance: dict = field(default_factory=dict)
    ungated_detections: list[PartialDetection] = field(default_factory=list)
    parent_support_gating: dict = field(default_factory=dict)


def decode_partial_result(
    result,
    names,
    contract,
    *,
    nms_iou=0.55,
    proposal_iou=0.5,
    confidence=0.0,
    provenance=None,
    frame_id=None,
    parent_support_iou=None,
):
    if not 0 < nms_iou <= 1 or not 0 < proposal_iou <= 1 or not 0 <= confidence <= 1:
        raise ValueError("Invalid confidence/IoU threshold")
    names = ordered_names(names)
    if any(name not in contract["decoder"] for name in names):
        raise ValueError("Unknown training channel")
    height, width = result.orig_shape
    if min(height, width) <= 0:
        raise ValueError("Invalid frame dimensions")
    raw = []
    expert = f'partial{len(contract["names"])}'
    if result.boxes is not None:
        from app.services.construction_semantics import _list

        coordinates, scores, classes = (
            _list(value)
            for value in (result.boxes.xyxy, result.boxes.conf, result.boxes.cls)
        )
        if not len(coordinates) == len(scores) == len(classes):
            raise ValueError("Inconsistent prediction tensor lengths")
        for i, (xyxy, score, class_id) in enumerate(
            zip(coordinates, scores, classes, strict=False)
        ):
            if (
                not math.isfinite(float(class_id))
                or not float(class_id).is_integer()
                or not 0 <= int(class_id) < len(names)
                or not math.isfinite(float(score))
                or not 0 <= score <= 1
                or len(xyxy) != 4
                or any(not math.isfinite(float(value)) for value in xyxy)
            ):
                raise ValueError("Malformed model prediction")
            if score < confidence:
                continue
            channel = names[int(class_id)]
            semantic = contract["decoder"][channel]
            clipped = [
                max(0.0, min(float(width), float(xyxy[0]))),
                max(0.0, min(float(height), float(xyxy[1]))),
                max(0.0, min(float(width), float(xyxy[2]))),
                max(0.0, min(float(height), float(xyxy[3]))),
            ]
            if clipped[2] <= clipped[0] or clipped[3] <= clipped[1]:
                raise ValueError("Empty/reversed model box")
            caveats = list(contract["caveats"][channel])
            if channel in {"equipment_truck", "mocs_truck"}:
                caveats.append("source-specific generic truck, not dump_truck")
            if channel in {"backhoe_loader", "crawler_crane"}:
                caveats.append(
                    "Explicit fine target head; confidence uncalibrated and "
                    "quality approval is separate"
                )
            if clipped != list(map(float, xyxy)):
                caveats.append("coordinates_clipped_to_frame")
            raw.append(
                PartialDetection(
                    f"{expert}:{i}",
                    channel,
                    int(class_id),
                    semantic,
                    LABELS_RU[semantic],
                    float(score),
                    clipped,
                    expert,
                    semantic in CANONICAL13,
                    caveats,
                    contract["scopes"][channel],
                )
            )
    # Different annotation scopes must not erase one another merely because
    # they decode to the same semantic display label (target pump != hose).
    kept, suppressed = [], []
    for is_target in (False, True):
        group = [d for d in raw if d.raw_class.startswith("target_") == is_target]
        selected, removed = semantic_nms(group, nms_iou)
        kept.extend(selected)
        suppressed.extend(removed)
    proposals = []
    pairs = {
        ("truck", "dump_truck"),
        ("mobile_crane", "truck_crane"),
        ("mobile_crane", "crawler_crane"),
        ("loader", "backhoe_loader"),
    }
    for i, left in enumerate(kept):
        for right in kept[i + 1 :]:
            pair = (left.semantic_class, right.semantic_class)
            if (
                left.semantic_class == right.semantic_class
                and left.raw_class.startswith("target_")
                != right.raw_class.startswith("target_")
                and box_iou(left.xyxy, right.xyxy) >= proposal_iou
            ):
                proposals.append(
                    {
                        "type": "annotation_scope_overlap_review",
                        "detection_ids": [left.detection_id, right.detection_id],
                        "semantic_class": left.semantic_class,
                        "automatic_collapse": False,
                        "action": "retain_both_pending_review",
                    }
                )
            if pair not in pairs and pair[::-1] not in pairs:
                continue
            overlap = box_iou(left.xyxy, right.xyxy)
            if overlap < proposal_iou:
                continue
            parent, narrow = (left, right) if pair in pairs else (right, left)
            proposals.append(
                {
                    "type": "semantic_scope_overlap_review",
                    "parent_detection_id": parent.detection_id,
                    "narrow_detection_id": narrow.detection_id,
                    "parent_class": parent.semantic_class,
                    "narrow_class": narrow.semantic_class,
                    "iou": overlap,
                    "automatic_collapse": False,
                    "action": "retain_both_pending_review",
                    "caveat": (
                        "No parent gating or subtype inference; scores are "
                        "uncalibrated"
                    ),
                }
            )
    ungated = list(kept)
    parent_channels = {
        "backhoe_loader": "loader",
        "crawler_crane": "mobile_crane",
        "target_loader": "loader",
        "target_concrete_pump": "concrete_pump",
    }
    gating = {
        "enabled": parent_support_iou is not None,
        "iou_threshold": parent_support_iou,
        "child_to_parent_channels": parent_channels,
        "decisions": [],
        "warning": (
            "Research candidate filter only; preserves raw/ungated outputs, does "
            "not calibrate confidence or establish correctness/absence"
        ),
    }
    if parent_support_iou is not None:
        if not 0 < parent_support_iou <= 1:
            raise ValueError("Parent support IoU must be in(0,1]")
        emitted = []
        for child in kept:
            if child.raw_class not in parent_channels:
                emitted.append(child)
                continue
            candidates = [
                p for p in raw if p.raw_class == parent_channels[child.raw_class]
            ]
            support = max(
                candidates, key=lambda p: box_iou(child.xyxy, p.xyxy), default=None
            )
            overlap = box_iou(child.xyxy, support.xyxy) if support else 0.0
            accepted = bool(support and overlap >= parent_support_iou)
            gating["decisions"].append(
                {
                    "detection_id": child.detection_id,
                    "raw_channel": child.raw_class,
                    "required_parent_channel": parent_channels[child.raw_class],
                    "support_detection_id": support.detection_id if support else None,
                    "support_iou": overlap,
                    "emitted": accepted,
                    "confidence_changed": False,
                }
            )
            if accepted:
                emitted.append(child)
        kept = emitted
    return PartialFrameDetections(
        kept,
        raw,
        suppressed,
        proposals,
        [expert],
        int(width),
        int(height),
        frame_id,
        provenance or {},
        ungated,
        gating,
    )


class ConstructionPartial:
    def __init__(
        self,
        weights,
        expected_sha256,
        mapping,
        deployment_manifest,
        *,
        device=None,
        model_factory=None,
        nms_iou=0.55,
        proposal_iou=0.5,
        parent_support_iou=None,
    ):
        if parent_support_iou is not None and not 0 < parent_support_iou <= 1:
            raise ValueError("Parent support IoU must be in(0,1]")
        weights, self.contract, self.provenance = validate_bundle(
            weights, expected_sha256, mapping, deployment_manifest
        )
        injected_factory = model_factory is not None
        if model_factory is None:
            from ultralytics import YOLO

            model_factory = YOLO
        self.yolo = model_factory(str(weights))
        from ultralytics.nn.tasks import DetectionModel

        model = self.yolo.model
        if type(model) is not DetectionModel or getattr(model, "end2end", False):
            raise ValueError(
                "Only a standard non-end2end DetectionModel deployment export is accepted"
            )
        ckpt = getattr(self.yolo, "ckpt", {})
        if (
            ckpt.get("initialization_only") is True
            or ckpt.get("expansion", {}).get("initialization_only") is True
            or getattr(model, "initialization_only", False) is True
            or ckpt.get("partial_source_training") is not True
        ):
            raise ValueError(
                "Initialization-only or unrecognized untrained checkpoint; "
                "inference forbidden"
            )
        head = model.model[-1]
        if (
            ordered_names(model.names) != self.contract["names"]
            or getattr(model, "training_to_semantic", None) != self.contract["decoder"]
            or getattr(head, "nc", None) != len(self.contract["names"])
            or not hasattr(head, "cv3")
            or any(
                branch[-1].out_channels != len(self.contract["names"])
                or branch[-1].weight.shape[0] != len(self.contract["names"])
                or branch[-1].bias is None
                or branch[-1].bias.shape[0] != len(self.contract["names"])
                for branch in head.cv3
            )
        ):
            raise ValueError(
                "Standard checkpoint real head/names/decoder differs from reviewed bundle"
            )
        self.expert = f'partial{len(self.contract["names"])}'
        self.names = {self.expert: dict(enumerate(self.contract["names"]))}
        self.semantic_classes = sorted(set(self.contract["decoder"].values()))
        self.provenance["synthetic_mock_predictor"] = injected_factory
        self.provenance["research_parent_support_iou"] = parent_support_iou
        self.parent_support_iou = parent_support_iou
        self.device, self.nms_iou, self.proposal_iou = device, nms_iou, proposal_iou
        self._lock = threading.RLock()

    def predict(self, frame, *, mode=None, confidence=0.2, imgsz=960, frame_id=None):
        import numpy as np
        from PIL import Image

        if isinstance(frame, np.ndarray):
            if frame.ndim != 3 or frame.shape[2] != 3 or frame.dtype != np.uint8:
                raise ValueError("Expected uint8 RGB HxWx3")
            frame = Image.fromarray(frame)
        if not isinstance(frame, Image.Image) or min(frame.size) <= 0:
            raise ValueError("Expected PIL RGB or numpy RGB frame")
        if not 0 <= confidence <= 1 or imgsz <= 0:
            raise ValueError("Invalid confidence/imgsz")
        kwargs = {
            "source": frame.convert("RGB"),
            "conf": confidence,
            "imgsz": imgsz,
            "verbose": False,
            "stream": False,
            "agnostic_nms": False,
        }
        if self.device is not None:
            kwargs["device"] = self.device
        with self._lock:
            results = list(self.yolo.predict(**kwargs))
            if len(results) != 1:
                raise ValueError("Expected exactly one frame result")
            if tuple(results[0].orig_shape) != (frame.height, frame.width):
                raise ValueError("Prediction dimensions differ from input")
            return decode_partial_result(
                results[0],
                self.names[self.expert],
                self.contract,
                nms_iou=self.nms_iou,
                proposal_iou=self.proposal_iou,
                confidence=confidence,
                provenance=self.provenance,
                frame_id=frame_id,
                parent_support_iou=self.parent_support_iou,
            )
