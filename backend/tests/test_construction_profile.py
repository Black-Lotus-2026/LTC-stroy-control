"""Deployment boundaries with fake checkpoints/predictors; no network or GPU."""

from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from app.services import detector_provider as provider
from app.services.construction_semantics import EQUIPMENT17, MOCS13
from tests import test_customer_control_http

customer_http = test_customer_control_http.customer_http


def make_detector(tmp_path, *, rows=None, policy="shadow", approved=()):
    rows = rows or {}
    calls = []
    paths = {}
    for expert in ("equipment17", "mocs13"):
        paths[expert] = tmp_path / f"{expert}.pt"
        paths[expert].write_bytes(b"mock-checkpoint")

    def factory(path):
        expert = next(key for key, value in paths.items() if str(value) == path)
        calls.append(expert)
        names = dict(enumerate(EQUIPMENT17 if expert == "equipment17" else MOCS13))
        ids = {name: index for index, name in names.items()}

        def predict(**kwargs):
            selected = rows.get(expert, [])
            boxes = SimpleNamespace(
                xyxy=[row[1] for row in selected],
                conf=[row[2] for row in selected],
                cls=[ids[row[0]] for row in selected],
            )
            return [SimpleNamespace(boxes=boxes)]

        return SimpleNamespace(names=names, predict=predict)

    detector = provider.ConstructionDetector(
        paths["equipment17"],
        paths["mocs13"],
        model_factory=factory,
        policy=policy,
        approved_classes=approved,
    )
    return detector, calls


def test_models_initialized_once_for_multiple_frames(tmp_path):
    detector, calls = make_detector(tmp_path)
    for _ in range(3):
        detector.detect_frame_detailed(Image.new("RGB", (100, 80)))
    assert calls == ["equipment17", "mocs13"]


def test_broad_truck_and_crane_never_become_narrow_types(tmp_path):
    rows = {"mocs13": [("truck", [0, 0, 50, 50], 0.9), ("crane", [50, 0, 100, 70], 0.9)]}
    detector, _ = make_detector(tmp_path, rows=rows)
    frame = Image.new("RGB", (100, 80))
    detailed = detector.detect_frame_detailed(frame)
    assert [d.semantic_class for d in detailed.detections] == ["truck", "mobile_crane"]
    assert [d.raw_class for d in detailed.raw_detections] == ["truck", "crane"]
    assert detector.detect_frame(frame) == []
    assert "crawler_crane" not in detector.supported_classes


def test_component_presence_and_pile_metadata_retained(tmp_path):
    rows = {
        "mocs13": [
            ("static_crane", [0, 0, 10, 60], 0.8),
            ("static_crane", [20, 0, 90, 10], 0.8),
            ("pile_driving", [40, 20, 60, 70], 0.9),
        ]
    }
    detector, _ = make_detector(tmp_path, rows=rows)
    detailed = detector.detect_frame_detailed(Image.new("RGB", (100, 80)))
    towers = [d for d in detailed.detections if d.semantic_class == "tower_crane"]
    assert len(towers) == 2
    assert all("presence_only" in d.caveats[0] for d in towers)
    pile = next(
        d
        for d in detector.detect_frame(Image.new("RGB", (100, 80)))
        if d.raw_label == "pile_driving"
    )
    assert pile.class_id == 11 and pile.canonical_code == "MACHINERY_PILE_DRIVING"
    assert pile.x1 == 0.4 and pile.y2 == 0.875


def test_missing_weight_never_loads_or_downloads(tmp_path):
    detector = provider.ConstructionDetector(
        tmp_path / "missing.pt",
        tmp_path / "also-missing.pt",
        model_factory=lambda _: pytest.fail("must not load"),
    )
    assert not detector.is_ready and detector.status == "weights_missing"
    assert detector.detect_frame(b"invalid") == []


def test_taxonomy_mismatch_is_fail_closed(tmp_path):
    path = tmp_path / "mock.pt"
    path.write_bytes(b"mock")
    detector = provider.ConstructionDetector(
        path, path, model_factory=lambda _: SimpleNamespace(names={0: "truck"})
    )
    assert not detector.is_ready and detector.status == "model_error"


@pytest.mark.parametrize("policy,approved", [("shadow", ["excavator"]), ("enforce", [])])
def test_no_rule_evaluation_without_both_enforce_and_allowlist(
    tmp_path, policy, approved
):
    detector, _ = make_detector(tmp_path, policy=policy, approved=approved)
    assert detector.evaluate_rules({"excavator": 1.0, "backhoe_loader": 1.0}, []) == []


def test_enforce_only_approved_semantics_binary_presence_no_machine_count(tmp_path):
    rows = {
        "mocs13": [
            ("static_crane", [0, 0, 10, 60], 0.9),
            ("static_crane", [20, 0, 90, 10], 0.9),
        ]
    }
    detector, _ = make_detector(
        tmp_path, rows=rows, policy="enforce", approved=["tower_crane"]
    )
    predictions = detector.detect_frame(Image.new("RGB", (100, 80)))
    evaluations = detector.evaluate_rules(
        {"tower_crane": 1.0, "backhoe_loader": 1.0, "crawler_crane": 1.0}, predictions
    )
    assert len(evaluations) == 1
    assert not evaluations[0].is_violation and evaluations[0].observed_count == 1
    assert "количество физических машин не определялось" in evaluations[0].description


@pytest.mark.parametrize(
    "name", ["crawler_crane", "backhoe_loader", "truck", "mobile_crane"]
)
def test_unavailable_or_broad_class_cannot_be_approved(tmp_path, name):
    with pytest.raises(ValueError):
        make_detector(tmp_path, approved=[name])


def test_provider_ignores_legacy_selection_and_caches_only_trained_model(monkeypatch):
    provider._cached_detector.cache_clear()
    monkeypatch.setattr(provider.settings, "detector_profile", "legacy")
    calls = []
    instance = object()
    from app.services import trained_detector

    monkeypatch.setattr(
        trained_detector,
        "TrainedConstructionDetector",
        lambda *args, **kwargs: calls.append(True) or instance,
    )
    monkeypatch.setattr(
        provider, "MachineryDetector", lambda: pytest.fail("Legacy model is forbidden")
    )
    try:
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: provider.get_detector(), range(32)))
        assert all(result is instance for result in results)
        assert calls == [True]
    finally:
        provider._cached_detector.cache_clear()


def test_numpy_rgb_input_is_not_mutated(tmp_path):
    detector, _ = make_detector(tmp_path)
    image = np.zeros((10, 20, 3), dtype=np.uint8)
    image[:, :, 0] = 255
    saved = image.copy()
    detector.detect_frame_detailed(image)
    assert np.array_equal(image, saved)


def test_worker_shadow_does_not_evaluate_or_write_incidents(monkeypatch):
    from app.workers import cv_tasks

    # Unauthenticated legacy single frames have no capture-time provenance.
    # They cannot enter the compliance pipeline, even under an approved model.
    monkeypatch.setattr(
        cv_tasks,
        "get_detector",
        lambda: pytest.fail("untrusted frame inference"),
        raising=False,
    )
    monkeypatch.setattr(
        cv_tasks,
        "RuleEngine",
        lambda: pytest.fail("shadow must not evaluate"),
        raising=False,
    )
    stage = SimpleNamespace(project_id="project")
    db = SimpleNamespace(
        get=lambda model, identity: stage if identity == "stage" else object(),
        commit=lambda: pytest.fail("shadow must not write"),
    )
    assert cv_tasks.process_video_frame_sync(b"frame", "stage", "project", db=db) == []


def test_shadow_recheck_never_passes_or_fails_incident(monkeypatch):
    import uuid

    from app.services import alert_service

    monkeypatch.setattr(
        alert_service, "_detector", lambda: SimpleNamespace(compliance_enabled=False)
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
    incident = SimpleNamespace(
        project_id=uuid.uuid4(),
        discrepancy_type="MISSING_MANDATORY",
        machinery_type="Экскаватор",
    )
    result = alert_service.verify_incident(db, incident)
    assert result.outcome == "unavailable"
    assert result.details["reason"] == "construction_shadow_or_unapproved_class"


def test_future_partial24_decoder_cannot_narrow_generic_channels():
    from app.services.construction_semantics import validate_partial24_decoder

    expected = {
        semantic: semantic
        for mapping in (EQUIPMENT17, MOCS13)
        for raw, semantic in mapping.items()
        if raw != "truck"
    }
    expected.update(equipment_truck="truck", mocs_truck="truck")
    names = sorted(expected)
    assert len(names) == 24
    assert validate_partial24_decoder(names, expected)["mocs_truck"] == "truck"
    for channel, narrow in [
        ("mocs_truck", "dump_truck"),
        ("mobile_crane", "truck_crane"),
    ]:
        wrong = {**expected, channel: narrow}
        with pytest.raises(ValueError):
            validate_partial24_decoder(names, wrong)


def test_backend_source_mapping_matches_reviewed_offline_contract():
    import json
    from pathlib import Path

    from app.services.construction_semantics import MAPPINGS

    manifest = (
        Path(__file__).resolve().parents[2] / "data/construction/semantic-mapping.json"
    )
    if not manifest.is_file():
        pytest.skip(
            "Repository audit artifact is not packaged in backend-only Docker image"
        )
    reviewed = json.loads(manifest.read_text())
    assert {
        expert: {row["raw_class"]: row["semantic_class"] for row in rows}
        for expert, rows in reviewed["experts"].items()
    } == MAPPINGS


def test_enforce_recheck_inference_failure_is_unavailable(monkeypatch):
    import uuid

    from app.services import alert_service

    def fail(frame):
        raise RuntimeError("simulated predictor failure")

    monkeypatch.setattr(
        alert_service,
        "_detector",
        lambda: SimpleNamespace(
            compliance_enabled=True,
            is_ready=True,
            can_evaluate=lambda name: True,
            detect_frame=fail,
        ),
    )
    monkeypatch.setattr(alert_service, "_capture_frame", lambda camera: b"frame")
    monkeypatch.setattr(alert_service.time, "sleep", lambda seconds: None)
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
    incident = SimpleNamespace(
        project_id=uuid.uuid4(),
        discrepancy_type="UNCHARACTERISTIC_PRESENT",
        machinery_type="Экскаватор",
    )
    result = alert_service.verify_incident(db, incident)
    assert result.outcome == "unavailable"
    assert result.details["reason"] == "construction_inference_failed"


def test_compat_api_preserves_semantics_without_physical_count_or_vlm(
    monkeypatch, customer_http
):
    from io import BytesIO

    from app.api.v1 import videos
    from app.services.detector import DetectionResult

    # Production compat API consumes the sole trained detector's projected
    # semantics, not the historical ensemble's canonical13-filtered wrapper.
    detector = SimpleNamespace(
        is_ready=True,
        status="ready",
        status_message="Synthetic trained detector fixture",
        compliance_enabled=False,
        detect_frame=lambda *args: [
            DetectionResult(
                15,
                "mobile_crane",
                "Мобильный кран",
                "MACHINERY_MOBILE_CRANE",
                0.91,
                0.01,
                0.025,
                0.1,
                0.25,
            )
        ],
    )
    monkeypatch.setattr(videos, "get_machinery_detector", lambda: detector)

    def no_vlm():
        pytest.fail("Compatibility frame uploads must never initialize photo VLM")

    monkeypatch.setattr(videos, "get_photo_vlm", no_vlm)
    image = BytesIO()
    Image.new("RGB", (100, 80)).save(image, format="PNG")
    image.seek(0)
    response = customer_http.client.post(
        "/api/v1/videos/construction-frame",
        params={"project_id": str(customer_http.projects["a"].id)},
        headers=customer_http.headers("manager"),
        files={"file": ("frame.png", image, "image/png")},
    )
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["physical_machine_count"] is None
    assert result["confidence_calibrated"] is False
    assert result["profile"] == "construction_trained"
    assert result["source"] == "yolo"
    assert result["fallback_status"] == "not_requested"
    assert result["count"] == 1
    detection = result["detections"][0]
    assert detection["raw_label"] == "mobile_crane"
    assert detection["canonical_code"] == "MACHINERY_MOBILE_CRANE"
    assert detection["confidence"] == 0.91
    assert (
        detection["x1"],
        detection["y1"],
        detection["x2"],
        detection["y2"],
    ) == pytest.approx((0.01, 0.025, 0.1, 0.25))
