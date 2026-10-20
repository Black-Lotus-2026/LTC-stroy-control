"""Server evidence replay must suppress absence and remain idempotent."""

from datetime import UTC, datetime

from sqlalchemy import select

from app.models import Incident
from app.models.customer_control import IncidentBasis
from app.schemas.customer_control import IncidentBasisDTO
from app.services.recording_integrity import SequenceReplay, record_replay_signal
from tests import test_customer_control_http
from tests.test_camera_view import jpeg, scene

customer_http = test_customer_control_http.customer_http


def test_exact_distinct_sequence_is_detected_and_static_frame_is_only_unknown():
    sequence = SequenceReplay()
    for offset, image in enumerate((b"one", b"two", b"three")):
        assert sequence.observe(image, offset * 10)[1] is None
    assert sequence.observe(b"one", 30)[0]
    assert sequence.observe(b"two", 40)[1] is None
    assert sequence.observe(b"three", 50) == (True, 20)
    static = SequenceReplay()
    assert static.observe(b"static", 0) == (False, None)
    assert static.observe(b"static", 10) == (True, None)
    assert static.observe(b"static", 20) == (True, None)


def test_replay_signal_is_one_canonical_case_with_immutable_source_offsets(customer_http):
    state = customer_http
    at = datetime.now(UTC)
    with state.sessions() as db:
        asset = db.merge(state.videos["k1"])
        camera = db.merge(state.camera)
        identifier = record_replay_signal(db, asset, camera, at, 20, 50, jpeg(scene(78)))
        assert (
            record_replay_signal(db, asset, camera, at, 20, 50, jpeg(scene(78)))
            == identifier
        )
        row = db.get(Incident, identifier)
        basis = db.scalar(
            select(IncidentBasis).where(IncidentBasis.incident_id == identifier)
        )
        typed = IncidentBasisDTO.model_validate(basis.snapshot)
        assert row.case_kind == "control_integrity" and row.resolved_at is None
        assert typed.sources[0].video_id == asset.id
        assert typed.sources[0].first_offset_seconds == 20
        assert typed.sources[0].last_offset_seconds == 50
    response = state.client.get(
        f"/api/v1/customer-control/incidents/{identifier}",
        headers=state.headers("manager"),
    )
    assert response.status_code == 200, response.text
