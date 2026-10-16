"""YOLO detector behavior without synthetic visual fallbacks."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from app.services.detector import MachineryDetector


class Scalar:
    def __init__(self, value: float):
        self.value = value

    def item(self) -> float:
        return self.value


class Coordinates:
    def __init__(self, values: list[float]):
        self.values = values

    def tolist(self) -> list[float]:
        return self.values


def test_missing_weights_produce_no_fake_detections() -> None:
    detector = MachineryDetector(
        weights_path=Path("var/storage/weights/definitely-missing-test.pt")
    )

    assert detector.is_ready is False
    assert detector.detect_frame(b"not-an-image") == []


def test_model_class_name_is_mapped_instead_of_assuming_class_order() -> None:
    box = SimpleNamespace(
        cls=[Scalar(17)],
        conf=[Scalar(0.91)],
        xyxyn=[Coordinates([0.1, 0.2, 0.5, 0.7])],
    )
    result = SimpleNamespace(boxes=[box], names={17: "Excavator"})
    model = SimpleNamespace(predict=lambda **_: [result], names=result.names)
    detector = MachineryDetector.__new__(MachineryDetector)
    detector.conf_threshold = 0.25
    detector.model = model
    detector.status = "ready"
    detector.status_message = None

    detections = detector.detect_frame(b"frame")

    assert len(detections) == 1
    assert detections[0].class_id == 0
    assert detections[0].raw_label == "excavator"
    assert detections[0].label_ru == "Экскаватор"


def test_model_class_concrete_pump_mapping() -> None:
    box = SimpleNamespace(
        cls=[Scalar(42)],
        conf=[Scalar(0.88)],
        xyxyn=[Coordinates([0.2, 0.3, 0.6, 0.8])],
    )
    result = SimpleNamespace(boxes=[box], names={42: "concrete_pump"})
    model = SimpleNamespace(predict=lambda **_: [result], names=result.names)
    detector = MachineryDetector.__new__(MachineryDetector)
    detector.conf_threshold = 0.25
    detector.model = model
    detector.status = "ready"
    detector.status_message = None

    detections = detector.detect_frame(b"frame")

    assert len(detections) == 1
    assert detections[0].class_id == 10
    assert detections[0].raw_label == "concrete_pump"
    assert detections[0].label_ru == "Бетононасос"
    assert detections[0].canonical_code == "MACHINERY_CONCRETE_PUMP"
