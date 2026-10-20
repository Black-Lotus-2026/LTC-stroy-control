"""Stream real local video through strict equipment17/MOCS13 semantic experts.

No checkpoint download, backend deployment, frame extraction or machine-count
claim. GT scores require explicit class scope and video SHA; upstream VATIC GT
requires a separate opt-in. Scores are fixed-threshold diagnostics, never mAP.
"""

from __future__ import annotations

import argparse
import json
import math
import time
from collections import Counter
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

from construction_ensemble import MAPPINGS, ConstructionEnsemble
from evaluate_construction_video import metrics, score_frame, sha256

SEMANTIC_CLASSES = tuple(
    sorted({v for mapping in MAPPINGS.values() for v in mapping.values()})
)


def package_version(name):
    try:
        return version(name)
    except PackageNotFoundError:
        return None


def load_scoped_gt(
    path, video_hash, allowed_classes, width, height, allow_upstream=False
):
    if path is None:
        return None
    data = json.loads(Path(path).read_text())
    kind = data.get("annotation_type")
    if kind != "human_verified_complete_frame_boxes":
        if kind != "upstream_vatic_interpolated_boxes" or not allow_upstream:
            raise ValueError(
                "Only human complete-frame GT, or explicit --allow-upstream-gt author VATIC GT"
            )
        if not data.get("source_provenance"):
            raise ValueError("Upstream GT requires source_provenance")
    scope = data.get("evaluation_classes")
    if (
        not isinstance(scope, list)
        or not scope
        or any(not isinstance(v, str) for v in scope)
        or len(set(scope)) != len(scope)
        or not set(scope) <= set(allowed_classes)
    ):
        raise ValueError(
            "GT requires explicit unique evaluation_classes supported by the selected expert mode"
        )
    if data.get("video_sha256") != video_hash:
        raise ValueError("GT SHA256 does not match this exact video")
    if not isinstance(data.get("frames"), list) or not data["frames"]:
        raise ValueError(
            "GT requires a nonempty frames list; complete negative frames may have boxes=[]"
        )
    frames = {}
    for row in data["frames"]:
        index = row.get("frame_index")
        if type(index) is not int or index < 0 or index in frames:
            raise ValueError(
                "GT requires unique nonnegative zero-based integer frame_index"
            )
        if not isinstance(row.get("boxes"), list):
            raise ValueError(
                "Every annotated frame must explicitly include its boxes list"
            )
        for box in row["boxes"]:
            xyxy = box.get("xyxy")
            if (
                box.get("class_name") not in scope
                or not isinstance(xyxy, list)
                or len(xyxy) != 4
                or any(
                    type(v) not in (float, int) or not math.isfinite(v) for v in xyxy
                )
                or not 0 <= xyxy[0] < xyxy[2] <= width
                or not 0 <= xyxy[1] < xyxy[3] <= height
            ):
                raise ValueError(
                    "GT has an out-of-scope label or invalid original-pixel box"
                )
        frames[index] = row["boxes"]
    return {
        "frames": frames,
        "evaluation_classes": scope,
        "annotation_type": kind,
        "source_provenance": data.get("source_provenance"),
        "limitations": data.get("limitations", []),
    }


def draw_frame(bgr, result):
    """All semantic categories, English text; never combine broad/narrow boxes."""
    import cv2

    output = bgr.copy()
    for detection in result.detections:
        index = (SEMANTIC_CLASSES + ("backhoe_loader", "crawler_crane")).index(
            detection.semantic_class
        )
        color = (
            (index * 67 + 80) % 220 + 35,
            (index * 113 + 20) % 220 + 35,
            (index * 41 + 110) % 220 + 35,
        )
        x1, y1, x2, y2 = [round(v) for v in detection.xyxy]
        cv2.rectangle(output, (x1, y1), (x2, y2), color, 2)
        label = f"{detection.semantic_class} {detection.confidence:.2f} [{detection.expert}]"
        if any("presence_only" in caveat for caveat in detection.caveats):
            label += " *"
        cv2.putText(
            output,
            label,
            (x1, max(14, y1 - 4)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.45,
            color,
            1,
            cv2.LINE_AA,
        )
    return output


def load_profile(args, model_factory=None):
    if args.mode == "partial":
        from construction_partial_inference import ConstructionPartial

        model = ConstructionPartial(
            args.weights,
            args.weights_sha256,
            args.mapping,
            args.deployment_manifest,
            device=args.device,
            model_factory=model_factory,
            nms_iou=args.semantic_nms_iou,
            proposal_iou=args.proposal_iou,
            parent_support_iou=getattr(args, "parent_support_iou", None),
        )
        path = Path(args.weights).resolve()
        provenance = {
            model.expert: {
                "path": str(path),
                "sha256": sha256(path),
                **model.provenance,
            }
        }
        adapter = (
            Path(__file__).resolve().parents[1]
            / "backend/app/services/construction_partial.py"
        )
        return (
            model,
            provenance,
            {model.expert: model.contract["decoder"]},
            model.semantic_classes,
            adapter,
        )
    experts = list(MAPPINGS) if args.mode == "ensemble" else [args.mode]
    if any(expert not in MAPPINGS for expert in experts):
        raise ValueError("Unknown expert mode")
    weights = {"equipment17": args.equipment_weights, "mocs13": args.mocs_weights}
    weights = {
        key: Path(weights[key]).resolve(strict=True) if weights[key] else None
        for key in experts
    }
    if not all(path and path.is_file() for path in weights.values()):
        raise ValueError(
            "Supply explicit existing local weights for every selected expert; no fallback/download"
        )
    provenance = {
        expert: {"path": str(path), "sha256": sha256(path)}
        for expert, path in weights.items()
    }
    ensemble = ConstructionEnsemble(
        weights.get("equipment17"),
        weights.get("mocs13"),
        device=args.device,
        nms_iou=args.semantic_nms_iou,
        proposal_iou=args.proposal_iou,
        model_factory=model_factory,
    )
    allowed = sorted(
        {semantic for expert in experts for semantic in MAPPINGS[expert].values()}
    )
    return (
        ensemble,
        provenance,
        {e: MAPPINGS[e] for e in experts},
        allowed,
        Path(__file__).with_name("construction_ensemble.py"),
    )


def run(args, *, model_factory=None):
    """Injection is for unit tests only; injected results are marked synthetic."""
    import cv2
    import numpy as np
    from PIL import Image

    if (
        not math.isfinite(args.sample_fps)
        or args.sample_fps < 0
        or args.imgsz <= 0
        or args.max_frames < 0
        or not math.isfinite(args.max_seconds)
        or args.max_seconds < 0
    ):
        raise ValueError("Invalid sampling, image dimensions or frame/time limits")
    if not all(
        0 < value <= 1
        for value in (
            args.conf,
            args.semantic_nms_iou,
            args.proposal_iou,
            args.match_iou,
        )
    ):
        raise ValueError("Confidence/IoU thresholds must be in (0,1]")
    video = Path(args.video).resolve(strict=True)
    if not video.is_file():
        raise ValueError("Expected local video file")
    output = Path(args.output).resolve()
    if output.exists():
        raise FileExistsError(
            "Use a new output directory; existing artifacts are never overwritten"
        )
    ensemble, provenance, source_mappings, allowed, adapter_path = load_profile(
        args, model_factory
    )
    capture = cv2.VideoCapture(str(video))
    writer = None
    try:
        if not capture.isOpened():
            raise ValueError("Input is not a decodable video")
        fps = capture.get(cv2.CAP_PROP_FPS)
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        if not math.isfinite(fps) or fps <= 0 or min(width, height) <= 0:
            raise ValueError("Video needs valid metadata FPS and dimensions")
        stride = max(1, round(fps / args.sample_fps)) if args.sample_fps else 1
        video_hash = sha256(video)
        gt = load_scoped_gt(
            args.ground_truth,
            video_hash,
            allowed,
            width,
            height,
            args.allow_upstream_gt,
        )
        scope = gt["evaluation_classes"] if gt else []
        counts = {name: Counter(tp=0, fp=0, fn=0) for name in scope}
        presence = {name: Counter(tp=0, fp=0, fn=0, tn=0) for name in scope}
        observations, raw_observations, ignored = Counter(), Counter(), Counter()
        ungated_observations = Counter()
        timings, scored_indices = [], []
        frame_index = processed = 0
        output.mkdir(parents=True, exist_ok=False)
        start = time.perf_counter()
        with (output / "predictions.jsonl").open("w") as stream:
            while capture.grab():
                timestamp = frame_index / fps
                if args.max_seconds and timestamp >= args.max_seconds:
                    break
                if frame_index % stride:
                    frame_index += 1
                    continue
                ok, bgr = capture.retrieve()
                if not ok:
                    raise ValueError(f"Frame decode failed at index {frame_index}")
                # OpenCV is BGR; PIL explicitly carries RGB into Ultralytics.
                rgb = Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
                before = time.perf_counter()
                result = ensemble.predict(
                    rgb,
                    mode=args.mode,
                    confidence=args.conf,
                    imgsz=args.imgsz,
                    frame_id=frame_index,
                )
                timings.append(time.perf_counter() - before)
                stream.write(
                    json.dumps(
                        {
                            "frame_index": frame_index,
                            "timestamp_seconds": timestamp,
                            **result.to_dict(),
                        }
                    )
                    + "\n"
                )
                observations.update(d.semantic_class for d in result.detections)
                ungated_observations.update(
                    d.semantic_class
                    for d in getattr(result, "ungated_detections", result.detections)
                )
                raw_observations.update(
                    f"{d.expert}:{d.raw_class}" for d in result.raw_detections
                )
                if gt is not None and frame_index in gt["frames"]:
                    predictions = [
                        {
                            "class_name": d.semantic_class,
                            "confidence": d.confidence,
                            "xyxy": d.xyxy,
                        }
                        for d in result.detections
                    ]
                    score_frame(
                        predictions,
                        gt["frames"][frame_index],
                        counts,
                        presence,
                        args.match_iou,
                    )
                    ignored.update(
                        p["class_name"]
                        for p in predictions
                        if p["class_name"] not in scope
                    )
                    scored_indices.append(frame_index)
                if args.annotated:
                    if writer is None:
                        writer = cv2.VideoWriter(
                            str(output / "annotated.mp4"),
                            cv2.VideoWriter_fourcc(*"mp4v"),
                            fps / stride,
                            (width, height),
                        )
                        if not writer.isOpened():
                            raise RuntimeError("Annotated MP4 writer unavailable")
                    writer.write(draw_frame(bgr, result))
                processed += 1
                frame_index += 1
                if args.max_frames and processed >= args.max_frames:
                    break
        elapsed = time.perf_counter() - start
        if not processed:
            raise ValueError("No sampled video frames were decoded")
        warmed = timings[1:]
        summary = {
            "profile": "construction_partial"
            if args.mode == "partial"
            else "construction_ensemble",
            "mode": args.mode,
            "synthetic_mock_predictors": model_factory is not None,
            "video": str(video),
            "video_sha256": video_hash,
            "weights": provenance,
            "runtime_versions": {
                "ultralytics": package_version("ultralytics"),
                "torch": package_version("torch"),
                "numpy": np.__version__,
                "opencv": cv2.__version__,
            },
            "runner_sha256": sha256(Path(__file__)),
            "semantic_adapter_sha256": sha256(adapter_path),
            "source_model_names": ensemble.names,
            "source_semantic_mappings": source_mappings,
            "semantic_classes": allowed,
            "video_width": width,
            "video_height": height,
            "source_fps": fps,
            "sampling_stride": stride,
            "effective_sample_fps": fps / stride,
            "processed_frames": processed,
            "timing_assumption": "CFR metadata FPS; not original camera timing if source was re-encoded/exported at an unknown playback rate",
            "physical_machine_count": None,
            "confidence_calibrated": False,
            "detection_observations_after_semantic_nms": dict(observations),
            "ungated_semantic_detection_observations": dict(ungated_observations),
            "research_parent_support_iou": getattr(args, "parent_support_iou", None)
            if args.mode == "partial"
            else None,
            "raw_expert_detection_observations": dict(raw_observations),
            "observation_warning": "Repeated frame boxes/components/proposals are not unique physical machines; no tracking accuracy claim",
            "nms_policy": "Same semantic and compatible annotation scope only; highest uncalibrated representative; all originals retained in JSONL",
            "presence_extent_warning": "MOCS tower_crane and concrete_pump can be machine components; broad truck/mobile_crane never narrowed by overlap",
            "latency_scope": "Selected model(s) plus semantic postprocessing, excluding frame decode, RGB conversion, overlay and disk IO; first frame separate",
            "inference_seconds_first": timings[0],
            "inference_seconds_p50_after_first": float(np.percentile(warmed, 50))
            if warmed
            else None,
            "inference_seconds_p95_after_first": float(np.percentile(warmed, 95))
            if warmed
            else None,
            "elapsed_processing_seconds": elapsed,
            "processed_frames_per_wall_second": processed / elapsed,
            "parameters": {
                key: str(value) if isinstance(value, Path) else value
                for key, value in vars(args).items()
            },
            "quality_metrics": None,
        }
        if gt is not None:
            summary["quality_metrics"] = {
                "scope": "Explicit annotated classes/reached frames only; fixed confidence and IoU; not mAP, full model-taxonomy or tracking validation",
                "annotation_type": gt["annotation_type"],
                "evaluation_classes": scope,
                "source_provenance": gt["source_provenance"],
                "annotation_limitations": gt["limitations"],
                "ground_truth_sha256": sha256(Path(args.ground_truth)),
                "scored_frame_indices": scored_indices,
                "unscored_gt_frame_indices": sorted(
                    set(gt["frames"]) - set(scored_indices)
                ),
                "ignored_predictions_for_unannotated_classes": dict(ignored),
                "object_detection": metrics(counts),
                "frame_class_presence": metrics(presence),
            }
        (output / "summary.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=2) + "\n"
        )
        return summary
    finally:
        capture.release()
        if writer is not None:
            writer.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--equipment-weights", type=Path)
    parser.add_argument("--mocs-weights", type=Path)
    parser.add_argument(
        "--mode",
        choices=("ensemble", "equipment17", "mocs13", "partial"),
        default="ensemble",
    )
    parser.add_argument(
        "--weights",
        type=Path,
        help="Standard partial24/28 deployment checkpoint for --mode partial",
    )
    parser.add_argument(
        "--weights-sha256", help="Explicit independently trusted checkpoint SHA"
    )
    parser.add_argument("--mapping", type=Path, help="Reviewed24/28 semantic mapping")
    parser.add_argument(
        "--deployment-manifest",
        type=Path,
        help="Trained bundle JSON; initialization artifacts forbidden",
    )
    parser.add_argument(
        "--parent-support-iou",
        type=float,
        help="Optional partial child-proposal research filter; default off, no calibration",
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--imgsz", type=int, default=960)
    parser.add_argument("--conf", type=float, default=0.25)
    parser.add_argument("--semantic-nms-iou", type=float, default=0.55)
    parser.add_argument("--proposal-iou", type=float, default=0.5)
    parser.add_argument(
        "--sample-fps", type=float, default=2.0, help="0 processes all source frames"
    )
    parser.add_argument("--max-frames", type=int, default=0)
    parser.add_argument("--max-seconds", type=float, default=0.0)
    parser.add_argument(
        "--annotated",
        action="store_true",
        help="Write sampled no-audio MP4 with all semantic classes",
    )
    parser.add_argument("--ground-truth", type=Path)
    parser.add_argument("--allow-upstream-gt", action="store_true")
    parser.add_argument("--match-iou", type=float, default=0.5)
    args = parser.parse_args()
    print(json.dumps(run(args), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
