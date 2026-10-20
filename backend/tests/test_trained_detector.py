"""Independent production detector guards and actual dense-output/NMS mechanics.

Synthetic tiny architecture tests exercise the real constructor/head checks and
CPU postprocessing; they are not trained-weight quality evaluation.
"""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from types import SimpleNamespace

import pytest
from PIL import Image

from app.services import trained_detector as production
from app.services.trained_taxonomy import HEAD_NAMES, SEMANTIC_NAMES, TRAINING_TO_SEMANTIC


def test_unknown_checkpoint_sha_rejected_before_yolo_constructor(tmp_path, monkeypatch):
    import ultralytics

    calls = []
    monkeypatch.setattr(ultralytics, "YOLO", lambda path: calls.append(path))
    path = tmp_path / "untrusted.pt"
    path.write_bytes(b"not the approved completed checkpoint")
    model = production.TrainedConstructionDetector(path, device="cpu")
    assert not model.is_ready and model.status == "model_error" and calls == []
    with pytest.raises(production.DetectorUnavailable):
        model.detect_frame(b"anything")


def test_missing_weights_unavailable_without_loader_or_download(tmp_path, monkeypatch):
    import ultralytics

    calls = []
    monkeypatch.setattr(ultralytics, "YOLO", lambda path: calls.append(path))
    model = production.TrainedConstructionDetector(tmp_path / "missing.pt")
    assert model.status == "weights_missing" and not model.is_ready and calls == []


@pytest.fixture
def constructor_fixture(tmp_path, monkeypatch):
    import ultralytics
    from ultralytics.nn.tasks import DetectionModel

    path = tmp_path / "synthetic-constructor-fixture-not-real-weights.pt"
    path.write_bytes(b"explicit synthetic bytes; hash injection scoped to fixture")
    model = DetectionModel("yolov8n.yaml", nc=28, verbose=False)
    model.names = dict(enumerate(HEAD_NAMES))
    model.initialization_only = False
    model.training_to_semantic = dict(TRAINING_TO_SEMANTIC)
    checkpoint = {
        "initialization_only": False,
        "partial_source_training": True,
        "training_epochs_recorded": [0, 1],
        "training_to_semantic": dict(TRAINING_TO_SEMANTIC),
    }
    calls = []

    def factory(value):
        calls.append(value)
        return SimpleNamespace(model=model, ckpt=checkpoint)

    monkeypatch.setattr(ultralytics, "YOLO", factory)
    monkeypatch.setattr(
        production.hashlib,
        "file_digest",
        lambda *a, **kw: SimpleNamespace(hexdigest=lambda: production.MODEL_SHA256),
    )
    return path, model, checkpoint, calls


def test_constructor_accepts_exact_standard_head_and_metadata(constructor_fixture):
    path, _, _, calls = constructor_fixture
    detector = production.TrainedConstructionDetector(path, device="cpu")
    assert detector.is_ready and detector.status == "ready" and len(calls) == 1
    assert (
        detector.trained_classes == SEMANTIC_NAMES and len(detector.trained_classes) == 25
    )
    assert detector.supported_classes == [n for n in SEMANTIC_NAMES if n != "grader"]
    assert detector.quality_verified is False and detector.compliance_enabled is False


@pytest.mark.parametrize(
    "mutation", ["order", "initialization", "decoder", "epochs", "nc"]
)
def test_constructor_rejects_semantically_wrong_head_or_completion(
    constructor_fixture, mutation
):
    path, model, checkpoint, _ = constructor_fixture
    if mutation == "order":
        model.names[0], model.names[1] = model.names[1], model.names[0]
    elif mutation == "initialization":
        checkpoint["initialization_only"] = True
    elif mutation == "decoder":
        model.training_to_semantic["mocs_truck"] = "dump_truck"
    elif mutation == "epochs":
        checkpoint["training_epochs_recorded"] = [float("nan")]
    else:
        model.model[-1].nc = 24
    detector = production.TrainedConstructionDetector(path, device="cpu")
    assert not detector.is_ready and detector.status == "model_error"


def test_provider_concurrent_calls_initialize_one_sole_trained_model(monkeypatch):
    from app.core.config import settings
    from app.services import detector_provider

    calls = []
    sentinel = object()

    def construct(*args, **kwargs):
        calls.append((args, kwargs))
        time.sleep(0.015)
        return sentinel

    monkeypatch.setattr(production, "TrainedConstructionDetector", construct)
    # Even historical selector configuration cannot choose an alternative model.
    monkeypatch.setattr(settings, "detector_profile", "legacy")
    monkeypatch.setattr(
        detector_provider,
        "MachineryDetector",
        lambda: pytest.fail("Legacy constructor must not run"),
    )
    detector_provider._cached_detector.cache_clear()
    try:
        with ThreadPoolExecutor(max_workers=12) as pool:
            results = list(
                pool.map(lambda _: detector_provider.get_detector(), range(36))
            )
        assert all(x is sentinel for x in results) and len(calls) == 1
        assert calls[0][0][0] == settings.yolo_weights_path
    finally:
        detector_provider._cached_detector.cache_clear()


def dense_detector(raw):
    detector = object.__new__(production.TrainedConstructionDetector)
    detector.model = lambda x, augment=False: raw
    detector.device = "cpu"
    detector.imgsz = 64
    detector.conf_threshold = 0.5
    detector._lock = threading.RLock()
    return detector


def test_actual25_projection_max_channels_no_truck_or_crane_narrowing_and_grader_pre_nms(
    monkeypatch,
):
    import torch
    from ultralytics.utils import nms

    raw = torch.zeros((1, 32, 3))
    for anchor, center in enumerate((10, 32, 54)):
        raw[0, :4, anchor] = torch.tensor([center, 32, 8, 8])

    def put(name, anchor, score):
        raw[0, 4 + HEAD_NAMES.index(name), anchor] = score

    put("grader", 0, 0.99)
    put("loader", 0, 0.55)
    put("target_loader", 0, 0.8)
    put("equipment_truck", 1, 0.74)
    put("mocs_truck", 1, 0.82)
    put("dump_truck", 1, 0.3)
    put("mobile_crane", 2, 0.77)
    put("truck_crane", 2, 0.2)
    original = raw.clone()
    observed = []
    real_nms = nms.non_max_suppression

    def capture(tensor, **kwargs):
        observed.append(tensor.clone())
        return real_nms(tensor, **kwargs)

    monkeypatch.setattr(nms, "non_max_suppression", capture)
    detections = dense_detector(raw).detect_frame(Image.new("RGB", (64, 64)))
    assert set(d.raw_label for d in detections) == {"loader", "truck", "mobile_crane"}
    assert observed[0].shape == (1, 29, 3)
    assert torch.equal(observed[0][:, :4], original[:, :4])
    assert observed[0][0, 4 + SEMANTIC_NAMES.index("grader")].count_nonzero() == 0
    assert observed[0][0, 4 + SEMANTIC_NAMES.index("loader"), 0] == pytest.approx(0.8)
    assert observed[0][0, 4 + SEMANTIC_NAMES.index("truck"), 1] == pytest.approx(0.82)
    assert torch.equal(raw, original)
    assert all(0 <= d.x1 < d.x2 <= 1 and 0 <= d.y1 < d.y2 <= 1 for d in detections)


def test_worker_not_swallowed_by_duplicate_machine_and_anchor_geometry_preserved():
    rows = [
        {"class": "backhoe_loader", "confidence": 0.9, "xyxy": [0.1, 0.1, 0.9, 0.9]},
        {"class": "loader", "confidence": 0.8, "xyxy": [0.15, 0.15, 0.85, 0.85]},
        {"class": "worker", "confidence": 0.75, "xyxy": [0.2, 0.2, 0.3, 0.4]},
    ]
    detector = dense_detector(None)
    detector._predict = lambda image: rows
    results = detector.detect_frame(Image.new("RGB", (64, 64)))
    assert [d.raw_label for d in results] == ["backhoe_loader", "worker"]
    assert (results[0].x1, results[0].y1, results[0].x2, results[0].y2) == (
        0.1,
        0.1,
        0.9,
        0.9,
    )
    assert results[1].canonical_code == "PERSON_WORKER"
    assert rows[0]["xyxy"] == [0.1, 0.1, 0.9, 0.9]


@pytest.mark.parametrize("raw", [None, "bad_shape", "nan"])
def test_actual_model_failure_or_invalid_dense_output_raises_not_empty(raw):
    import torch

    if raw == "bad_shape":
        value = torch.zeros(1, 31, 3)
    elif raw == "nan":
        value = torch.full((1, 32, 3), float("nan"))
    else:

        def fail(*a, **k):
            raise RuntimeError("synthetic forward failure")

        value = fail
    detector = dense_detector(value)
    if raw is None:
        detector.model = value
    with pytest.raises(production.DetectorInferenceError):
        detector.detect_frame(Image.new("RGB", (64, 64)))


def test_decode_exif_and_rgba_are_rgb_and_oriented_before_inference():
    image = Image.new("RGB", (3, 2), (250, 10, 30))
    exif = image.getexif()
    exif[274] = 6
    stream = BytesIO()
    image.save(stream, format="JPEG", exif=exif)
    decoded = production.decode_image(stream.getvalue())
    assert decoded.mode == "RGB" and decoded.size == (2, 3)
    rgba = BytesIO()
    Image.new("RGBA", (4, 5), (10, 20, 30, 70)).save(rgba, format="PNG")
    assert production.decode_image(rgba.getvalue()).mode == "RGB"


def test_decode_rejects_animation_oversize_and_corruption():
    animation = BytesIO()
    Image.new("RGB", (3, 2), "red").save(
        animation,
        format="GIF",
        save_all=True,
        append_images=[Image.new("RGB", (3, 2), "blue")],
    )
    with pytest.raises(ValueError, match="animated"):
        production.decode_image(animation.getvalue())
    big = BytesIO()
    Image.new("1", (10000, 4001)).save(big, format="PNG")
    with pytest.raises(ValueError, match="40 megapixels"):
        production.decode_image(big.getvalue())
    with pytest.raises(ValueError):
        production.decode_image(b"not an image")


def test_all25_semantics_have_fixed_order_and_actual_dense_projection():
    import torch

    expected = [
        "backhoe_loader",
        "bulldozer",
        "cleaning_equipment",
        "concrete_mixer",
        "concrete_pump",
        "crane_manipulator",
        "crawler_crane",
        "dump_truck",
        "excavator",
        "forklift_giraffe",
        "forklift_standart",
        "gazelle",
        "grader",
        "hanging_head",
        "loader",
        "mobile_crane",
        "other_vehicle",
        "pile_driving",
        "roller",
        "tanker",
        "tower_crane",
        "trailer",
        "truck",
        "truck_crane",
        "worker",
    ]
    assert expected == SEMANTIC_NAMES
    raw = torch.zeros((1, 32, len(expected)))
    for i, semantic in enumerate(expected):
        source = next(n for n in HEAD_NAMES if TRAINING_TO_SEMANTIC[n] == semantic)
        raw[0, :4, i] = torch.tensor([2 + i * 2, 32, 1, 4])
        raw[0, 4 + HEAD_NAMES.index(source), i] = 0.8
    rows = dense_detector(raw)._predict(Image.new("RGB", (64, 64)))
    assert {d["class"] for d in rows} == set(expected) - {"grader"}
    assert len(rows) == 24
    for row in rows:
        # Fixed anchor position proves output index maps to its own semantic name.
        i = expected.index(row["class"])
        assert row["xyxy"] == pytest.approx(
            [(1.5 + 2 * i) / 64, 30 / 64, (2.5 + 2 * i) / 64, 34 / 64]
        )


def test_explicit_enforcement_uses_allowlist_without_claiming_quality(
    constructor_fixture,
):
    path, _, _, _ = constructor_fixture
    detector = production.TrainedConstructionDetector(
        path, device="cpu", policy="enforce", approved_classes=["excavator", "loader"]
    )
    assert detector.compliance_enabled and not detector.quality_verified
    assert detector.evaluable_classes == ["excavator", "loader"]
    assert all(
        detector.can_evaluate(n)
        for n in [
            "excavator",
            "Экскаватор",
            "MACHINERY_EXCAVATOR",
            "Ковшовый погрузчик",
            "Погрузчик",
        ]
    )
    assert not any(
        detector.can_evaluate(n) for n in ["grader", "worker", "truck", "tower_crane"]
    )
    rows = [
        production.as_detection(
            {"class": "loader", "xyxy": [0.1, 0.1, 0.2, 0.2], "confidence": 0.9}
        )
    ]
    result = detector.evaluate_rules(
        {
            "excavator": 0.95,
            "Экскаватор": 0.95,
            "loader": 0.05,
            "grader": 0.99,
            "worker": 0.99,
        },
        rows,
    )
    assert len(result) == 2
    assert {(r.machinery_name, r.discrepancy_type, r.observed_count) for r in result} == {
        ("Экскаватор", "MISSING_MANDATORY", 0),
        ("Погрузчик", "UNCHARACTERISTIC_PRESENT", 1),
    }
    detector.model = None
    assert not detector.compliance_enabled and detector.evaluable_classes == []
    assert detector.evaluate_rules({"excavator": 0.95}, []) == []


def test_enforcement_does_not_enable_unsupported_or_unconfigured_classes(
    constructor_fixture,
):
    path, _, _, _ = constructor_fixture
    for bad in ["grader", "worker", "other_vehicle", "not_a_class"]:
        with pytest.raises(ValueError):
            production.TrainedConstructionDetector(
                path, policy="enforce", approved_classes=[bad]
            )
    detector = production.TrainedConstructionDetector(
        path, device="cpu", policy="enforce"
    )
    assert not detector.compliance_enabled
    assert detector.evaluate_rules({"excavator": 0.99}, []) == []
