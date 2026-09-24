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
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)

_rate_limit_lock = threading.Lock()
_last_request_started_at = 0.0


@dataclass(frozen=True)
class VlmConfig:
    enabled: bool = False
    provider: str = "gemini"
    model: str = "gemini-1.5-flash"
    min_request_interval_seconds: float = 60.0
    request_timeout_seconds: float = 10.0


def load_vlm_config(path: Path | str | None = None) -> VlmConfig:
    candidates: list[Path] = []
    if path:
        candidates.append(Path(path))
    env_path = os.getenv("VLM_CONFIG_PATH")
    if env_path:
        candidates.append(Path(env_path))

    backend_dir = Path(__file__).resolve().parents[2]
    root_dir = backend_dir.parent

    candidates.extend([
        root_dir / "config" / "vlm_config.yaml",
        backend_dir / "config" / "vlm_config.yaml",
        root_dir / "config" / "vlm.json",
        backend_dir / "config" / "vlm.json",
    ])

    config_path = next((c for c in candidates if c.exists()), candidates[-1])
    try:
        text = config_path.read_text(encoding="utf-8")
        if config_path.suffix in (".yaml", ".yml"):
            import yaml

            payload = yaml.safe_load(text) or {}
        else:
            payload = json.loads(text)

        return VlmConfig(
            enabled=bool(payload.get("enabled", False)),
            provider=str(payload.get("provider", "gemini")),
            model=str(payload.get("model", "gemini-1.5-flash")),
            min_request_interval_seconds=max(
                1.0, float(payload.get("min_request_interval_seconds", 60.0))
            ),
            request_timeout_seconds=max(
                1.0, float(payload.get("request_timeout_seconds", 15.0))
            ),
        )
    except Exception as error:
        logger.error(
            "Failed to load VLM config %s: %s. VLM is disabled.",
            config_path,
            error,
        )
        return VlmConfig()


@dataclass
class VlmVerificationOutcome:
    is_violation_confirmed: bool
    is_occluded: bool
    confidence: float
    reasoning: str
    compact_alert_text: str
    fallback_used: bool = False
    latency_ms: int = 0
    status: str = "completed"


class GeminiVlmVerifier:
    """Secondary AI inspector using Google Gemini Vision VLM."""

    def __init__(
        self,
        api_key: str | None = None,
        config: VlmConfig | None = None,
    ):
        self.config = config or load_vlm_config()
        self.api_key = api_key or os.getenv("GEMINI_API_KEY")
        self.model = os.getenv("GEMINI_MODEL", self.config.model)
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

        if not self.config.enabled:
            logger.info("VLM processing is disabled by configuration")
            return self._build_fallback_outcome(
                stage_name,
                discrepancy_type,
                target_machinery,
                stage_probability,
                start_time,
                status="disabled",
                reason="VLM отключена в конфигурации и не выполняла внешний запрос.",
            )

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
                status="not_configured",
            )

        global _last_request_started_at
        with _rate_limit_lock:
            now = time.monotonic()
            elapsed = now - _last_request_started_at
            if elapsed < self.config.min_request_interval_seconds:
                retry_after = self.config.min_request_interval_seconds - elapsed
                logger.warning("VLM request rate-limited for %.1f seconds", retry_after)
                return self._build_fallback_outcome(
                    stage_name,
                    discrepancy_type,
                    target_machinery,
                    stage_probability,
                    start_time,
                    status="rate_limited",
                    reason=(
                        "VLM-запрос пропущен: действует ограничение частоты "
                        f"{self.config.min_request_interval_seconds:.0f} секунд."
                    ),
                )
            _last_request_started_at = now

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
            async with httpx.AsyncClient(
                timeout=self.config.request_timeout_seconds
            ) as client:
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
                    status="completed",
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
        status: str = "fallback",
        reason: str | None = None,
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
                reason
                or "VLM недоступен или API-ключ не задан. "
                "Автономный вердикт на основе правил СМР."
            ),
            compact_alert_text=msg,
            fallback_used=True,
            latency_ms=latency,
            status=status,
        )
