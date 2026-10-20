"""Partial deployment gates with explicit synthetic bundles; no quality claims."""

import json
import pickle
import zipfile
from copy import deepcopy
from functools import lru_cache
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from app.services.construction_partial import (
    ConstructionPartial,
    digest,
    reviewed_contract,
)
from app.services.construction_semantics import CANONICAL13, MAPPINGS
from app.services.detector_provider import ConstructionPartialDetector


def fixture_mapping(size):
    experts = {}
    for source, mapping in MAPPINGS.items():
        experts[source] = [
            {
                "raw_class": raw,
                "semantic_class": semantic,
                "training_class": source.replace("17", "").replace("13", "") + "_truck"
                if raw == "truck"
                else semantic,
                "caveats": ["presence_only: source component extent"]
                if source == "mocs13" and raw in {"static_crane", "pump_truck"}
                else [],
            }
            for raw, semantic in mapping.items()
        ]
    if size == 28:
        experts["target13"] = [
            {
                "raw_class": name,
                "semantic_class": name,
                "training_class": "target_loader"
                if name == "loader"
                else "target_concrete_pump"
                if name == "concrete_pump"
                else name,
                "caveats": ["Synthetic fixture target scope, no ground truth claim"],
            }
            for name in CANONICAL13
        ]
    return {"review_status": "reviewed_synthetic_unit_test_contract", "experts": experts}


@lru_cache(maxsize=2)
def standard_fixture_model(size):
    # Actual standard architecture/head shapes, never claimed to be trained.
    from ultralytics.nn.tasks import DetectionModel

    return DetectionModel("yolov8n.yaml", nc=size, verbose=False)


def make_bundle(tmp_path, size=28, *, quality=False, rows=None, ckpt_override=None):
    from ultralytics.nn.tasks import DetectionModel

    mapping = fixture_mapping(size)
    contract = reviewed_contract(mapping)
    mapping_path = tmp_path / "mapping.json"
    mapping_path.write_text(json.dumps(mapping))
    weights = tmp_path / "MOCK-NOT-A-REAL-CHECKPOINT.pt"
    # Deliberately synthetic ZIP, read only by injected predictor factory.
    with zipfile.ZipFile(weights, "w") as z:
        z.writestr("archive/data.pkl", pickle.dumps(DetectionModel, protocol=2))
    manifest = {
        "artifact_type": "trained_standard_partial_yolo",
        "checkpoint_sha256": digest(weights),
        "mapping_sha256": digest(mapping_path),
        "training_completed": True,
        "initialization_only": False,
        "quality_verified": quality,
        "head_channels": size,
        "names": contract["names"],
        "training_to_semantic": contract["decoder"],
    }
    manifest_path = tmp_path / "deployment.json"
    manifest_path.write_text(json.dumps(manifest))
    initialized = []
    predicted = []

    def factory(path):
        initialized.append(path)
        model = deepcopy(standard_fixture_model(size))
        model.names = dict(enumerate(contract["names"]))
        model.training_to_semantic = contract["decoder"]

        def predict(**kwargs):
            image = kwargs["source"]
            assert isinstance(image, Image.Image) and image.mode == "RGB"
            predicted.append(image.getpixel((0, 0)))
            channels = contract["names"] if rows is None else rows
            boxes = SimpleNamespace(
                xyxy=[[2.0, 2.0, 40.0, 40.0] for _ in channels],
                conf=[0.9] * len(channels),
                cls=[contract["names"].index(name) for name in channels],
            )
            return [SimpleNamespace(orig_shape=(image.height, image.width), boxes=boxes)]

        return SimpleNamespace(
            model=model,
            ckpt={"partial_source_training": True, **(ckpt_override or {})},
            predict=predict,
        )

    return (
        {
            "weights": weights,
            "expected_sha256": manifest["checkpoint_sha256"],
            "mapping": mapping_path,
            "deployment_manifest": manifest_path,
            "model_factory": factory,
        },
        initialized,
        predicted,
    )


@pytest.mark.parametrize("size,semantics", [(24, 23), (28, 25)])
def test_exact_old_and_new_head_contract_and_raw_scope(tmp_path, size, semantics):
    bundle, initialized, predicted = make_bundle(tmp_path, size)
    model = ConstructionPartial(**bundle)
    for _ in range(2):
        result = model.predict(Image.new("RGB", (64, 64), (255, 0, 0)))
    assert len(initialized) == 1 and predicted == [(255, 0, 0)] * 2
    assert len(model.semantic_classes) == semantics and len(result.raw_detections) == size
    assert result.model_provenance["synthetic_mock_predictor"] is True
    assert all(not d.confidence_calibrated for d in result.raw_detections)
    generic = [
        d
        for d in result.raw_detections
        if d.raw_class in {"equipment_truck", "mocs_truck"}
    ]
    assert len(generic) == 2 and {d.semantic_class for d in generic} == {"truck"}
    assert all(d.source_scopes for d in result.raw_detections)
    if size == 28:
        assert {"backhoe_loader", "crawler_crane"} <= {
            d.semantic_class for d in result.detections
        }
        assert (
            len([d for d in result.detections if d.semantic_class == "concrete_pump"])
            == 2
        )
        assert any(
            p["type"] == "annotation_scope_overlap_review" for p in result.proposals
        )
        assert any(
            p.get("parent_class") == "mobile_crane"
            and p.get("narrow_class") == "crawler_crane"
            for p in result.proposals
        )
    else:
        assert not {"backhoe_loader", "crawler_crane"} & set(model.semantic_classes)


@pytest.mark.parametrize(
    "which",
    ["sha", "manifest_init", "untrained", "json_decoder", "json_names", "custom_pickle"],
)
def test_preflight_rejects_before_model_factory(tmp_path, which):
    bundle, initialized, _ = make_bundle(tmp_path)
    path = bundle["deployment_manifest"]
    m = json.loads(path.read_text())
    if which == "sha":
        bundle["expected_sha256"] = "0" * 64
    elif which == "manifest_init":
        m["initialization_only"] = True
    elif which == "untrained":
        m["training_completed"] = False
    elif which == "json_decoder":
        m["training_to_semantic"]["mocs_truck"] = "dump_truck"
    elif which == "json_names":
        m["names"] = list(reversed(m["names"]))
    else:
        with zipfile.ZipFile(bundle["weights"], "w") as z:
            z.writestr("archive/data.pkl", b"\x80\x02c__main__\nCustomTrainingModel\n.")
        m["checkpoint_sha256"] = bundle["expected_sha256"] = digest(bundle["weights"])
    path.write_text(json.dumps(m))
    with pytest.raises(ValueError):
        ConstructionPartial(**bundle)
    assert initialized == []


@pytest.mark.parametrize("which", ["truck_narrow", "loader_channel", "unknown_source"])
def test_reviewed_mapping_semantic_guards(tmp_path, which):
    mapping = fixture_mapping(28)
    if which == "truck_narrow":
        next(r for r in mapping["experts"]["mocs13"] if r["raw_class"] == "truck")[
            "semantic_class"
        ] = "dump_truck"
    elif which == "loader_channel":
        next(r for r in mapping["experts"]["target13"] if r["raw_class"] == "loader")[
            "training_class"
        ] = "loader"
    else:
        mapping["experts"]["unknown_camera_source"] = []
    with pytest.raises(ValueError):
        reviewed_contract(mapping)


@pytest.mark.parametrize(
    "flag",
    [
        {"initialization_only": True},
        {"expansion": {"initialization_only": True}},
        {"partial_source_training": False},
    ],
)
def test_checkpoint_flags_rejected_before_inference(tmp_path, flag):
    bundle, _, predicted = make_bundle(tmp_path, ckpt_override=flag)
    with pytest.raises(ValueError, match="inference forbidden"):
        ConstructionPartial(**bundle)
    assert predicted == []


def test_real_serialized_standard_initialization_checkpoint_rejected(tmp_path):
    import torch

    bundle, _, _ = make_bundle(tmp_path)
    contract = reviewed_contract(fixture_mapping(28))
    model = deepcopy(standard_fixture_model(28))
    model.names = dict(enumerate(contract["names"]))
    model.training_to_semantic = contract["decoder"]
    model.args = {}
    torch.save(
        {
            "model": model,
            "ema": None,
            "epoch": -1,
            "train_args": {},
            "version": "8.3.203",
            "initialization_only": True,
            "quality_verified": False,
            "partial_source_training": True,
        },
        bundle["weights"],
    )
    manifest = json.loads(bundle["deployment_manifest"].read_text())
    manifest["checkpoint_sha256"] = bundle["expected_sha256"] = digest(bundle["weights"])
    bundle["deployment_manifest"].write_text(json.dumps(manifest))
    bundle.pop("model_factory")
    with pytest.raises(ValueError, match="inference forbidden"):
        ConstructionPartial(**bundle)


def test_real_head_rows_are_checked_not_names_only(tmp_path):
    bundle, _, _ = make_bundle(tmp_path)
    original = bundle["model_factory"]

    def wrong(path):
        yolo = original(path)
        yolo.model.model[-1].cv3[0][-1].out_channels = 24
        return yolo

    bundle["model_factory"] = wrong
    with pytest.raises(ValueError, match="real head"):
        ConstructionPartial(**bundle)


def test_gate_default_off_and_explicit_research_filter_preserve_raw(tmp_path):
    children = [
        "backhoe_loader",
        "crawler_crane",
        "target_loader",
        "target_concrete_pump",
    ]
    bundle, _, _ = make_bundle(tmp_path, rows=children)
    image = Image.new("RGB", (64, 64))
    default = ConstructionPartial(**bundle).predict(image)
    gated = ConstructionPartial(**bundle, parent_support_iou=0.5).predict(image)
    assert len(default.detections) == 4 and not default.parent_support_gating["enabled"]
    assert (
        len(gated.detections) == 0
        and len(gated.raw_detections) == len(gated.ungated_detections) == 4
    )
    assert all(
        not d["emitted"] and not d["confidence_changed"]
        for d in gated.parent_support_gating["decisions"]
    )
    assert {d.confidence for d in gated.raw_detections} == {0.9}


def test_gate_keeps_supported_children_without_narrowing_coarse(tmp_path):
    rows = [
        "loader",
        "mobile_crane",
        "concrete_pump",
        "backhoe_loader",
        "crawler_crane",
        "target_loader",
        "target_concrete_pump",
    ]
    bundle, _, _ = make_bundle(tmp_path, rows=rows)
    result = ConstructionPartial(**bundle, parent_support_iou=0.5).predict(
        Image.new("RGB", (64, 64))
    )
    assert len(result.detections) == 7 and len(result.raw_detections) == 7
    assert len(result.parent_support_gating["decisions"]) == 4
    assert all(
        d["emitted"] and d["support_iou"] == 1
        for d in result.parent_support_gating["decisions"]
    )


def test_backend_fine_capability_and_enforce_require_reviewed_quality(tmp_path):
    bundle, _, _ = make_bundle(tmp_path, quality=False)
    detector = ConstructionPartialDetector(
        **bundle, policy="shadow", approved_classes=["crawler_crane"]
    )
    assert detector.is_ready and "crawler_crane" in detector.supported_classes
    assert (
        not detector.compliance_enabled
        and detector.evaluate_rules({"crawler_crane": 1.0}, []) == []
    )
    enforce = ConstructionPartialDetector(
        **bundle, policy="enforce", approved_classes=["crawler_crane"]
    )
    assert not enforce.is_ready and "quality marker" in enforce.status_message
    m = json.loads(bundle["deployment_manifest"].read_text())
    m["quality_verified"] = True
    bundle["deployment_manifest"].write_text(json.dumps(m))
    approved = ConstructionPartialDetector(
        **bundle, policy="enforce", approved_classes=["crawler_crane"]
    )
    assert approved.compliance_enabled and approved.can_evaluate("Гусеничный кран")
    detections = approved.detect_frame(Image.new("RGB", (64, 64)))
    assert any(d.class_id == 12 and d.raw_label == "crawler_crane" for d in detections)
    assert (
        len(approved.evaluate_rules({"crawler_crane": 1.0, "unknown": 1.0}, detections))
        == 1
    )


def test_backend24_cannot_approve_absent_fine_class(tmp_path):
    bundle, _, _ = make_bundle(tmp_path, 24, quality=True)
    detector = ConstructionPartialDetector(
        **bundle, policy="enforce", approved_classes=["backhoe_loader"]
    )
    assert not detector.is_ready and "actual checkpoint head" in detector.status_message


def test_actual_repository_target_contract_has25_semantics_when_present():
    path = (
        Path(__file__).resolve().parents[2]
        / "data/construction/semantic-mapping-target.json"
    )
    if not path.exists():
        pytest.skip("Repository mapping not packaged in backend-only image")
    contract = reviewed_contract(json.loads(path.read_text()))
    assert len(contract["names"]) == 28 and len(set(contract["decoder"].values())) == 25
    assert contract["decoder"]["crawler_crane"] == "crawler_crane"


def test_partial_provider_concurrent_cache_single_model(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor

    from app.services import detector_provider as provider

    bundle, initialized, _ = make_bundle(tmp_path)
    from app.services import trained_detector

    sole = SimpleNamespace(is_ready=True)
    calls = []
    monkeypatch.setattr(provider.settings, "detector_profile", "construction_partial")
    for key, value in [
        ("construction_partial_weights", bundle["weights"]),
        ("construction_partial_sha256", bundle["expected_sha256"]),
        ("construction_partial_mapping", bundle["mapping"]),
        ("construction_partial_manifest", bundle["deployment_manifest"]),
        ("construction_policy", "shadow"),
        ("construction_approved_classes", []),
    ]:
        monkeypatch.setattr(provider.settings, key, value)
    monkeypatch.setattr(
        trained_detector,
        "TrainedConstructionDetector",
        lambda *args, **kwargs: calls.append(True) or sole,
    )
    monkeypatch.setattr(
        provider,
        "ConstructionPartialDetector",
        lambda *args, **kwargs: pytest.fail(
            "Historical partial profile must not select a model"
        ),
    )
    provider._cached_detector.cache_clear()
    try:
        with ThreadPoolExecutor(max_workers=8) as pool:
            models = list(pool.map(lambda _: provider.get_detector(), range(32)))
        assert all(model is models[0] for model in models) and models[0].is_ready
        assert calls == [True] and initialized == []
    finally:
        provider._cached_detector.cache_clear()


def test_partial_inference_lock_serializes_shared_predictor(tmp_path):
    import threading
    import time
    from concurrent.futures import ThreadPoolExecutor

    bundle, _, _ = make_bundle(tmp_path)
    detector = ConstructionPartialDetector(**bundle)
    original = detector.ensemble.yolo.predict
    active = 0
    counter_lock = threading.Lock()

    def checked(**kwargs):
        nonlocal active
        with counter_lock:
            active += 1
            assert active == 1
        try:
            time.sleep(0.005)
            return original(**kwargs)
        finally:
            with counter_lock:
                active -= 1

    detector.ensemble.yolo.predict = checked
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(
            pool.map(
                lambda _: detector.detect_frame_detailed(Image.new("RGB", (64, 64))),
                range(6),
            )
        )
    assert len(results) == 6 and active == 0


def test_partial_worker_and_recheck_support_real_fine_head_after_explicit_review(
    tmp_path, monkeypatch
):
    import uuid
    from io import BytesIO

    from app.services import alert_service
    from app.workers import cv_tasks

    bundle, _, _ = make_bundle(tmp_path, quality=True)
    detector = ConstructionPartialDetector(
        **bundle, policy="enforce", approved_classes=["crawler_crane"]
    )
    assert detector.can_evaluate("Гусеничный кран") and not detector.can_evaluate(
        "backhoe_loader"
    )
    image = BytesIO()
    Image.new("RGB", (64, 64)).save(image, format="PNG")
    frame = image.getvalue()
    monkeypatch.setattr(
        cv_tasks,
        "get_detector",
        lambda: pytest.fail("untrusted legacy frame inference"),
        raising=False,
    )
    stage = SimpleNamespace(
        project_id="project",
        machinery_probabilities={"crawler_crane": 1.0, "backhoe_loader": 1.0},
    )
    commits = []
    db = SimpleNamespace(
        get=lambda model, identity: stage if identity == "stage" else object(),
        commit=lambda: commits.append(True),
    )
    assert (
        cv_tasks.process_video_frame_sync(frame, "stage", "project", db=db) == []
        and commits == []
    )
    monkeypatch.setattr(alert_service, "_detector", lambda: detector)
    monkeypatch.setattr(alert_service, "_capture_frame", lambda camera: frame)
    monkeypatch.setattr(alert_service.time, "sleep", lambda seconds: None)
    incident = SimpleNamespace(
        project_id=uuid.uuid4(),
        discrepancy_type="MISSING_MANDATORY",
        machinery_type="Гусеничный кран",
    )
    camera = SimpleNamespace(
        id=uuid.uuid4(),
        view_move_status=None,
        view_move_until=None,
        view_reference_key=None,
    )
    db = SimpleNamespace(
        scalars=lambda query: SimpleNamespace(all=lambda: [camera]),
        scalar=lambda query: None,
    )
    assert alert_service.verify_incident(db, incident).outcome == "passed"
    incident.machinery_type = "backhoe_loader"
    assert alert_service.verify_incident(db, incident).outcome == "unavailable"


def test_partial_streaming_video25_and_optional_gate_comparison(tmp_path):
    import sys
    from argparse import Namespace

    import cv2
    import numpy as np

    scripts = Path(__file__).resolve().parents[2] / "scripts"
    if not scripts.exists():
        pytest.skip("Repository CLI not packaged in backend-only image")
    sys.path.insert(0, str(scripts))
    from evaluate_construction_ensemble_video import run

    bundle, initialized, predicted = make_bundle(tmp_path)
    video = tmp_path / "synthetic-partial25.mp4"
    writer = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*"mp4v"), 4.0, (64, 64))
    assert writer.isOpened()
    for _ in range(4):
        image = np.zeros((64, 64, 3), np.uint8)
        image[:, :, 2] = 255
        writer.write(image)
    writer.release()
    args = Namespace(
        video=video,
        mode="partial",
        weights=bundle["weights"],
        weights_sha256=bundle["expected_sha256"],
        mapping=bundle["mapping"],
        deployment_manifest=bundle["deployment_manifest"],
        output=tmp_path / "video-run",
        device="cpu",
        imgsz=64,
        conf=0.25,
        semantic_nms_iou=0.55,
        proposal_iou=0.5,
        sample_fps=0.0,
        max_frames=0,
        max_seconds=0.0,
        annotated=True,
        ground_truth=None,
        allow_upstream_gt=False,
        match_iou=0.5,
        parent_support_iou=None,
    )
    summary = run(args, model_factory=bundle["model_factory"])
    assert len(initialized) == 1 and len(predicted) == 4
    assert all(red > 240 and green < 10 and blue < 10 for red, green, blue in predicted)
    assert (
        summary["profile"] == "construction_partial"
        and len(summary["semantic_classes"]) == 25
    )
    assert (
        summary["quality_metrics"] is None and summary["physical_machine_count"] is None
    )
    rows = [
        json.loads(line)
        for line in (args.output / "predictions.jsonl").read_text().splitlines()
    ]
    assert len(rows) == 4 and len(rows[0]["raw_detections"]) == 28
    assert len({d["semantic_class"] for d in rows[0]["detections"]}) == 25
    capture = cv2.VideoCapture(str(args.output / "annotated.mp4"))
    decoded = 0
    while capture.read()[0]:
        decoded += 1
    capture.release()
    assert decoded == 4
    args.output = tmp_path / "gated-run"
    args.parent_support_iou = 0.5
    summary = run(args, model_factory=bundle["model_factory"])
    assert summary["research_parent_support_iou"] == 0.5
    assert (
        summary["ungated_semantic_detection_observations"]
        == summary["detection_observations_after_semantic_nms"]
    )
    row = json.loads((args.output / "predictions.jsonl").read_text().splitlines()[0])
    assert (
        len(row["parent_support_gating"]["decisions"]) == 4
        and len(row["ungated_detections"]) == 27
    )
