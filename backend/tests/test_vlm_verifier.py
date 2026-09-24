"""Unit tests for Google Gemini Vision VLM verification service."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest

import app.services.vlm_verifier as vlm_module
from app.services.vlm_verifier import (
    GeminiVlmVerifier,
    VlmConfig,
    VlmVerificationOutcome,
)


@pytest.mark.anyio
async def test_vlm_verifier_fallback_when_no_api_key() -> None:
    # Verifier with explicit None api_key should fallback gracefully
    verifier = GeminiVlmVerifier(api_key="")
    verifier.api_key = None

    outcome = await verifier.verify_incident(
        image_bytes=b"dummy_jpeg_bytes",
        stage_name="Выемка грунта котлована",
        discrepancy_type="MISSING_MANDATORY",
        target_machinery="Экскаватор",
        stage_probability=0.92,
    )

    assert isinstance(outcome, VlmVerificationOutcome)
    assert outcome.fallback_used is True
    assert outcome.is_violation_confirmed is True
    assert "Экскаватор" in outcome.compact_alert_text
    assert "Выемка грунта" in outcome.compact_alert_text
    assert outcome.latency_ms >= 0
    assert outcome.status == "disabled"


@pytest.mark.anyio
async def test_disabled_vlm_never_calls_provider() -> None:
    verifier = GeminiVlmVerifier(
        api_key="must-not-be-used",
        config=VlmConfig(enabled=False),
    )

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as post:
        outcome = await verifier.verify_incident(
            image_bytes=b"frame",
            stage_name="Монолитные работы",
            discrepancy_type="MISSING_MANDATORY",
            target_machinery="Автокран",
            stage_probability=0.9,
        )

    post.assert_not_awaited()
    assert outcome.status == "disabled"
    assert outcome.fallback_used is True


@pytest.mark.anyio
async def test_vlm_verifier_successful_mocked_response() -> None:
    vlm_module._last_request_started_at = 0.0
    verifier = GeminiVlmVerifier(
        api_key="mock-api-key",
        config=VlmConfig(enabled=True, min_request_interval_seconds=60),
    )

    mock_gemini_json = {
        "candidates": [
            {
                "content": {
                    "parts": [
                        {
                            "text": json.dumps(
                                {
                                    "is_violation_confirmed": True,
                                    "is_occluded": False,
                                    "confidence": 0.95,
                                    "reasoning": (
                                        "Экскаватор в зоне земляных работ "
                                        "не зафиксирован."
                                    ),
                                    "compact_alert_text": (
                                        "На этапе «Выемка грунта» отсутствует "
                                        "обязательный экскаватор."
                                    ),
                                }
                            )
                        }
                    ]
                }
            }
        ]
    }

    mock_response = AsyncMock()
    mock_response.status_code = 200
    mock_response.json = lambda: mock_gemini_json

    with patch("httpx.AsyncClient.post", return_value=mock_response):
        outcome = await verifier.verify_incident(
            image_bytes=b"dummy_bytes",
            stage_name="Выемка грунта",
            discrepancy_type="MISSING_MANDATORY",
            target_machinery="Экскаватор",
            stage_probability=0.95,
        )

        assert outcome.fallback_used is False
        assert outcome.is_violation_confirmed is True
        assert outcome.is_occluded is False
        assert outcome.confidence == 0.95
        assert "отсутствует обязательный экскаватор" in outcome.compact_alert_text
        assert outcome.status == "completed"


@pytest.mark.anyio
async def test_vlm_rate_limit_skips_second_provider_request() -> None:
    vlm_module._last_request_started_at = 0.0
    verifier = GeminiVlmVerifier(
        api_key="mock-api-key",
        config=VlmConfig(enabled=True, min_request_interval_seconds=60),
    )
    mock_response = AsyncMock()
    mock_response.status_code = 500
    mock_response.text = "provider error"

    with patch("httpx.AsyncClient.post", return_value=mock_response) as post:
        await verifier.verify_incident(
            b"frame", "Этап", "MISSING_MANDATORY", "Экскаватор", 0.9
        )
        second = await verifier.verify_incident(
            b"frame", "Этап", "MISSING_MANDATORY", "Экскаватор", 0.9
        )

    assert post.await_count == 1
    assert second.status == "rate_limited"
