"""Google Gemini Vision VLM Incident Verification Service.

Routes flagged ERROR and WARNING incidents to Google Gemini 1.5 Flash
for secondary scene verification (occlusion, genuine absence, foreign machinery)
and generates concise 1-2 sentence operator notifications.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import time
from dataclasses import dataclass

import httpx

logger = logging.getLogger(__name__)


@dataclass
class VlmVerificationOutcome:
    is_violation_confirmed: bool
    is_occluded: bool
    confidence: float
    reasoning: str
    compact_alert_text: str
    fallback_used: bool = False
    latency_ms: int = 0


class GeminiVlmVerifier:
    """Secondary AI inspector using Google Gemini Vision VLM."""

    def __init__(self, api_key: str | None = None):
        self.api_key = api_key or os.getenv("GEMINI_API_KEY")
        self.model = os.getenv("GEMINI_MODEL", "gemini-1.5-flash")
        self.endpoint_url = f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:generateContent"

    async def verify_incident(
        self,
        image_bytes: bytes,
        stage_name: str,
        discrepancy_type: str,
        target_machinery: str,
        stage_probability: float,
        detected_summary: str = "",
    ) -> VlmVerificationOutcome:
        """Analyze image and context with Gemini VLM; fallback gracefully on error."""
        start_time = time.time()

        if not self.api_key:
            logger.warning(
                "GEMINI_API_KEY not configured. Falling back to autonomous rule engine."
            )
            return self._build_fallback_outcome(
                stage_name,
                discrepancy_type,
                target_machinery,
                stage_probability,
                start_time,
            )

        prompt = (
            "Ты — эксперт по видеоконтролю стройплощадки и охране труда.\n"
            f"Текущий этап: «{stage_name}».\n"
            f"Отклонение: {discrepancy_type}\n"
            f"Техника: «{target_machinery}», P={stage_probability:.2f}.\n"
            f"Детекции: {detected_summary or 'Спецтехника не обнаружена'}.\n\n"
            "Задача:\n"
            f"1. Есть ли «{target_machinery}» на кадре? Есть ли перекрытия?\n"
            "2. Подтверди или опровергни нарушение.\n"
            "3. Краткое заключение на русском (1-2 предложения) для оператора.\n\n"
            "Верни ответ ТОЛЬКО в формате JSON:\n"
            '{"is_violation_confirmed": true/false, "is_occluded": true/false, '
            '"confidence": 0.0-1.0, "reasoning": "...", "compact_alert_text": "..."}'
        )

        b64_image = base64.b64encode(image_bytes).decode("utf-8")

        payload = {
            "contents": [
                {
                    "parts": [
                        {"text": prompt},
                        {
                            "inline_data": {
                                "mime_type": "image/jpeg",
                                "data": b64_image,
                            }
                        },
                    ]
                }
            ],
            "generationConfig": {
                "response_mime_type": "application/json",
                "temperature": 0.1,
            },
        }

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(
                    f"{self.endpoint_url}?key={self.api_key}",
                    json=payload,
                    headers={"Content-Type": "application/json"},
                )

                latency = int((time.time() - start_time) * 1000)

                if resp.status_code != 200:
                    logger.error("Gemini API error %d: %s", resp.status_code, resp.text)
                    return self._build_fallback_outcome(
                        stage_name,
                        discrepancy_type,
                        target_machinery,
                        stage_probability,
                        start_time,
                    )

                data = resp.json()
                text_part = data["candidates"][0]["content"]["parts"][0]["text"]
                parsed = json.loads(text_part)

                return VlmVerificationOutcome(
                    is_violation_confirmed=bool(
                        parsed.get("is_violation_confirmed", True)
                    ),
                    is_occluded=bool(parsed.get("is_occluded", False)),
                    confidence=float(parsed.get("confidence", 0.9)),
                    reasoning=str(parsed.get("reasoning", "")),
                    compact_alert_text=str(parsed.get("compact_alert_text", "")),
                    fallback_used=False,
                    latency_ms=latency,
                )
        except Exception as e:
            logger.error("Failed to query Gemini VLM: %s", e)
            return self._build_fallback_outcome(
                stage_name,
                discrepancy_type,
                target_machinery,
                stage_probability,
                start_time,
            )

    def _build_fallback_outcome(
        self,
        stage_name: str,
        discrepancy_type: str,
        target_machinery: str,
        stage_probability: float,
        start_time: float,
    ) -> VlmVerificationOutcome:
        latency = int((time.time() - start_time) * 1000)
        if discrepancy_type == "MISSING_MANDATORY":
            msg = (
                f"На этапе «{stage_name}» отсутствует обязательный {target_machinery}. "
                "Нарушение подтверждено правилом СМР."
            )
        elif discrepancy_type == "UNCHARACTERISTIC_PRESENT":
            msg = (
                f"На этапе «{stage_name}» обнаружен нехарактерный {target_machinery}. "
                "Техника не предусмотрена регламентом."
            )
        else:
            msg = (
                f"На этапе «{stage_name}» не зафиксирован "
                f"рекомендованный {target_machinery}."
            )

        return VlmVerificationOutcome(
            is_violation_confirmed=True,
            is_occluded=False,
            confidence=0.85,
            reasoning=(
                "VLM недоступен или API-ключ не задан. "
                "Автономный вердикт на основе правил СМР."
            ),
            compact_alert_text=msg,
            fallback_used=True,
            latency_ms=latency,
        )
