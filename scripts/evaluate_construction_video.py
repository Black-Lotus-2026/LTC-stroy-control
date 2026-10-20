"""Stream a local site video through explicit YOLO weights; optional manual-GT P/R.

Predictions are never treated as ground truth. No frames are extracted to disk.
Tracking uses Ultralytics ByteTrack and requires its optional `lap` dependency.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import math
import os
from pathlib import Path
import time

os.environ.setdefault("YOLO_AUTOINSTALL", "false")

CANONICAL = (
    "excavator", "bulldozer", "dump_truck", "truck_crane", "tower_crane",
    "concrete_mixer", "loader", "roller", "grader", "backhoe_loader", "concrete_pump",
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def iou(a, b) -> float:
    intersection = max(0.0, min(a[2], b[2])-max(a[0], b[0])) * max(0.0, min(a[3], b[3])-max(a[1], b[1]))
    union = (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - intersection
    return intersection / union if union > 0 else 0.0


def load_ground_truth(path: Path | None, video_hash: str, allow_upstream=False):
    if path is None:
        return None
    payload = json.loads(path.read_text())
    annotation_type = payload.get("annotation_type")
    if annotation_type != "human_verified_complete_frame_boxes":
        if not (allow_upstream and annotation_type == "upstream_vatic_interpolated_boxes"):
            raise ValueError("GT must be human-verified, or explicit --allow-upstream-gt for provenance-marked author VATIC annotations")
        if not payload.get("source_provenance") or not payload.get("evaluation_classes"):
            raise ValueError("Upstream GT requires source provenance and an explicit class scope")
    evaluation_classes = payload.get("evaluation_classes", list(CANONICAL))
    if not evaluation_classes or not set(evaluation_classes).issubset(CANONICAL):
        raise ValueError("GT evaluation_classes must be a nonempty subset of canonical classes")
    if payload.get("video_sha256") != video_hash:
        raise ValueError("Ground-truth video SHA256 does not match the input video")
    frames = {}
    for frame in payload["frames"]:
        index = frame["frame_index"]
        if not isinstance(index, int) or index < 0 or index in frames:
            raise ValueError("GT requires unique nonnegative zero-based frame_index")
        for box in frame["boxes"]:
            xyxy = box["xyxy"]
            if box["class_name"] not in evaluation_classes or len(xyxy) != 4:
                raise ValueError("GT class/box is invalid")
            if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in xyxy):
                raise ValueError("GT box must contain finite pixel coordinates")
            if xyxy[0] < 0 or xyxy[1] < 0 or xyxy[2] <= xyxy[0] or xyxy[3] <= xyxy[1]:
                raise ValueError("GT box coordinates are invalid")
        frames[index] = frame["boxes"]
    return {"frames": frames, "evaluation_classes": evaluation_classes,
            "annotation_type": annotation_type, "source_provenance": payload.get("source_provenance"),
            "limitations": payload.get("limitations", [])}


def score_frame(predictions, truth, counts, presence, threshold):
    """Confidence-ordered one-to-one class-specific IoU matches, at one cutoff."""
    for name in counts:
        predicted = sorted((p for p in predictions if p["class_name"] == name), key=lambda p: p["confidence"], reverse=True)
        targets = [t for t in truth if t["class_name"] == name]
        available = set(range(len(targets)))
        for prediction in predicted:
            candidate = max(available, key=lambda j: iou(prediction["xyxy"], targets[j]["xyxy"]), default=None)
            if candidate is not None and iou(prediction["xyxy"], targets[candidate]["xyxy"]) >= threshold:
                counts[name]["tp"] += 1
                available.remove(candidate)
            else:
                counts[name]["fp"] += 1
        counts[name]["fn"] += len(available)
        state = "tp" if predicted and targets else "fp" if predicted else "fn" if targets else "tn"
        presence[name][state] += 1


def metrics(counts):
    result = {}
    for name, c in counts.items():
        precision = c["tp"] / (c["tp"]+c["fp"]) if c["tp"]+c["fp"] else None
        recall = c["tp"] / (c["tp"]+c["fn"]) if c["tp"]+c["fn"] else None
        result[name] = {**dict(c), "precision": precision, "recall": recall}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video", required=True, type=Path)
    parser.add_argument("--weights", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path, help="New output directory")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--imgsz", type=int, default=960)
    parser.add_argument("--conf", type=float, default=0.25)
    parser.add_argument("--nms-iou", type=float, default=0.7)
    parser.add_argument("--sample-fps", type=float, default=2.0, help="0 means all frames")
    parser.add_argument("--max-frames", type=int, default=0, help="0 means no limit")
    parser.add_argument("--max-seconds", type=float, default=0, help="0 means no limit")
    parser.add_argument("--track", action="store_true")
    parser.add_argument("--annotated", action="store_true", help="Write sampled annotated.mp4; no audio")
    parser.add_argument("--mapping", type=Path, help="Reviewed JSON source-name to canonical-name crosswalk")
    parser.add_argument("--ground-truth", type=Path)
    parser.add_argument("--allow-upstream-gt", action="store_true", help="Evaluate provenance-marked author VATIC GT within its declared classes; not manually verified full taxonomy")
    parser.add_argument("--match-iou", type=float, default=0.5)
    args = parser.parse_args()
    if args.sample_fps < 0 or args.imgsz <= 0 or args.max_frames < 0 or args.max_seconds < 0:
        parser.error("Sampling, dimensions and limits must be nonnegative (imgsz positive)")
    if not all(0 < v <= 1 for v in (args.conf, args.nms_iou, args.match_iou)):
        parser.error("Confidence and IoU thresholds must be in (0,1]")
    args.video, args.weights = args.video.resolve(strict=True), args.weights.resolve(strict=True)
    if not args.video.is_file() or not args.weights.is_file():
        parser.error("Video and weights must be local files")
    import cv2
    import numpy as np
    import ultralytics
    from ultralytics import YOLO

    capture = cv2.VideoCapture(str(args.video))
    if not capture.isOpened():
        raise ValueError(f"Not a decodable video: {args.video}")
    fps = capture.get(cv2.CAP_PROP_FPS)
    width, height = (int(capture.get(p)) for p in (cv2.CAP_PROP_FRAME_WIDTH, cv2.CAP_PROP_FRAME_HEIGHT))
    if not math.isfinite(fps) or fps <= 0 or min(width, height) <= 0:
        capture.release()
        raise ValueError("Video has invalid FPS/dimensions; transcode with explicit timestamps first")
    stride = max(1, round(fps / args.sample_fps)) if args.sample_fps else 1
    video_hash = sha256(args.video)
    ground_truth = load_ground_truth(args.ground_truth, video_hash, args.allow_upstream_gt)
    truth = ground_truth["frames"] if ground_truth else None
    evaluation_classes = ground_truth["evaluation_classes"] if ground_truth else CANONICAL
    if truth is not None:
        for boxes in truth.values():
            if any(b["xyxy"][2] > width or b["xyxy"][3] > height for b in boxes):
                raise ValueError("GT boxes extend outside original video dimensions")
    mapping = {name: name for name in CANONICAL}
    if args.mapping:
        extra = json.loads(args.mapping.read_text())
        if not isinstance(extra, dict) or any(v not in CANONICAL for v in extra.values()):
            raise ValueError("Mapping values must be canonical machinery names")
        mapping.update(extra)
    model = YOLO(str(args.weights))
    names = model.names
    names = dict(enumerate(names)) if isinstance(names, list) else names
    supported = {i: mapping[name] for i, name in names.items() if name in mapping}
    if not supported:
        raise ValueError("Weights have no exact canonical classes; supply a reviewed --mapping")
    args.output.mkdir(parents=True, exist_ok=False)
    writer = None
    class_counts, track_ids = Counter(), {name: set() for name in CANONICAL}
    counts = {name: Counter(tp=0, fp=0, fn=0) for name in evaluation_classes}
    presence = {name: Counter(tp=0, fp=0, fn=0, tn=0) for name in evaluation_classes}
    ignored_unannotated_class_predictions = Counter()
    scored_indices, timings = [], []
    frame_index = processed = 0
    start = time.perf_counter()
    try:
        with (args.output / "predictions.jsonl").open("w") as stream:
            while capture.grab():
                timestamp = frame_index / fps
                if args.max_seconds and timestamp >= args.max_seconds:
                    break
                if frame_index % stride:
                    frame_index += 1
                    continue
                ok, image = capture.retrieve()
                if not ok:
                    raise ValueError(f"Decode failed at frame {frame_index}")
                before = time.perf_counter()
                options = dict(conf=args.conf, iou=args.nms_iou, imgsz=args.imgsz, device=args.device,
                               classes=list(supported), verbose=False)
                result = (model.track(image, persist=True, tracker="bytetrack.yaml", **options) if args.track
                          else model.predict(image, **options))[0]
                timings.append(time.perf_counter() - before)
                predictions = []
                if result.boxes is not None:
                    boxes = result.boxes
                    identities = boxes.id.int().cpu().tolist() if boxes.id is not None else [None] * len(boxes)
                    for source_id, confidence, xyxy, identity in zip(boxes.cls.int().cpu().tolist(), boxes.conf.cpu().tolist(), boxes.xyxy.cpu().tolist(), identities):
                        name = supported[source_id]
                        item = dict(class_name=name, canonical_id=CANONICAL.index(name), source_class_id=source_id,
                                    confidence=confidence, xyxy=xyxy, track_id=identity)
                        predictions.append(item)
                        class_counts[name] += 1
                        if identity is not None:
                            track_ids[name].add(identity)
                stream.write(json.dumps(dict(frame_index=frame_index, timestamp_seconds=timestamp, detections=predictions)) + "\n")
                if truth is not None and frame_index in truth:
                    score_frame(predictions, truth[frame_index], counts, presence, args.match_iou)
                    ignored_unannotated_class_predictions.update(p["class_name"] for p in predictions if p["class_name"] not in evaluation_classes)
                    scored_indices.append(frame_index)
                if args.annotated:
                    if writer is None:
                        writer = cv2.VideoWriter(str(args.output / "annotated.mp4"), cv2.VideoWriter_fourcc(*"mp4v"), fps / stride, (width, height))
                        if not writer.isOpened():
                            raise RuntimeError("Cannot create annotated MP4")
                    writer.write(result.plot())
                processed += 1
                frame_index += 1
                if args.max_frames and processed >= args.max_frames:
                    break
    finally:
        capture.release()
        if writer is not None:
            writer.release()
    elapsed = time.perf_counter() - start
    if not processed:
        raise ValueError("Video contained no decodable sampled frames")
    summary = dict(
        video=str(args.video), video_sha256=video_hash, weights=str(args.weights), weights_sha256=sha256(args.weights),
        ultralytics_version=ultralytics.__version__, video_width=width, video_height=height, source_fps=fps,
        timing_assumption="constant frame rate; timestamp = zero-based frame index / metadata FPS",
        sampling_stride=stride, effective_sample_fps=fps / stride, processed_frames=processed,
        source_model_classes=names, canonical_mapping={str(i): name for i, name in supported.items()},
        unsupported_model_classes={str(i): name for i, name in names.items() if i not in supported},
        detection_observations=dict(class_counts), distinct_predicted_track_ids={name: len(ids) for name, ids in track_ids.items()} if args.track else None,
        tracking_warning="Predicted IDs are associations, not unique physical object ground truth; sparse sampling can break tracks" if args.track else None,
        elapsed_processing_seconds=elapsed, processed_frames_per_wall_second=processed / elapsed,
        inference_seconds_first=timings[0], inference_seconds_median_after_first=float(np.median(timings[1:])) if len(timings) > 1 else None,
        inference_seconds_p95_after_first=float(np.percentile(timings[1:], 95)) if len(timings) > 1 else None,
        parameters={k: str(v) if isinstance(v, Path) else v for k, v in vars(args).items()},
        quality_metrics=None,
    )
    if truth is not None:
        summary["quality_metrics"] = dict(
            scope="Declared annotated classes and reached frames only; fixed confidence/IoU, not mAP, tracking accuracy or full multiclass validation",
            annotation_type=ground_truth["annotation_type"], evaluation_classes=evaluation_classes,
            source_provenance=ground_truth["source_provenance"], annotation_limitations=ground_truth["limitations"],
            ignored_predictions_for_unannotated_classes=dict(ignored_unannotated_class_predictions),
            scored_frame_indices=scored_indices, unscored_gt_frame_indices=sorted(set(truth)-set(scored_indices)),
            object_detection=metrics(counts), frame_class_presence=metrics(presence), ground_truth_sha256=sha256(args.ground_truth),
        )
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
