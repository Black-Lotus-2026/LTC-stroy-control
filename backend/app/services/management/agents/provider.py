"""Small OpenRouter adapter. No model-directed tools, URLs or HTTP retries."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Protocol

import httpx


class ProviderError(Exception):
    """Only stable error codes may escape; never response bodies or credentials."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass
class ProviderReply:
    content: str
    usage: dict[str, int] = field(default_factory=dict)


class Provider(Protocol):
    name: str
    model: str
    available: bool

    async def complete(
        self, *, system: str, context: dict, schema: dict, timeout: float
    ) -> ProviderReply: ...


class OpenRouterProvider:
    name = "openrouter"
    endpoint = "https://openrouter.ai/api/v1/chat/completions"

    def __init__(
        self,
        *,
        api_key: str | None = None,
        model: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self._api_key = (
            api_key if api_key is not None else os.getenv("OPENROUTER_API_KEY", "")
        )
        self.model = model if model is not None else os.getenv("OPENROUTER_MODEL", "")
        self.available = bool(self._api_key and self.model)
        self._transport = transport

    async def complete(
        self, *, system: str, context: dict, schema: dict, timeout: float = 20
    ) -> ProviderReply:
        if not self.available:
            raise ProviderError("provider_unavailable")
        payload = {
            "model": self.model,
            "messages": [
                {
                    "role": "system",
                    "content": system + "\nReturn one JSON object matching "
                    "this schema exactly:\n" + json.dumps(schema, ensure_ascii=False),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {"untrusted_data": context}, ensure_ascii=False
                    ),
                },
            ],
            "temperature": 0,
            "max_tokens": 1500,
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "management_role",
                    "strict": True,
                    "schema": schema,
                },
            },
            "provider": {"require_parameters": True},
        }
        try:
            async with (
                httpx.AsyncClient(
                    timeout=httpx.Timeout(min(20.0, timeout), connect=min(3.0, timeout)),
                    transport=self._transport,
                    follow_redirects=False,
                ) as client,
                client.stream(
                    "POST",
                    self.endpoint,
                    json=payload,
                    headers={
                        "Authorization": "Bearer " + self._api_key,
                        "Content-Type": "application/json",
                    },
                ) as response,
            ):
                if response.status_code >= 300:
                    if response.status_code == 401:
                        raise ProviderError("provider_auth_error")
                    if response.status_code == 403:
                        raise ProviderError("provider_access_denied")
                    if response.status_code == 429:
                        raise ProviderError("provider_rate_limited")
                    raise ProviderError("provider_http_error")
                chunks = bytearray()
                async for chunk in response.aiter_bytes():
                    chunks.extend(chunk)
                    if len(chunks) > 65536:
                        raise ProviderError("provider_response_too_large")
            data = json.loads(chunks)
            choice = data["choices"][0]
            if choice.get("finish_reason") != "stop":
                raise ProviderError("provider_incomplete_response")
            message = choice["message"]
            if message.get("tool_calls") or message.get("refusal"):
                raise ProviderError("provider_invalid_response")
            content = message["content"]
            if not isinstance(content, str) or not content.strip():
                raise ProviderError("provider_empty_response")
            usage = {
                key: value
                for key, value in (data.get("usage") or {}).items()
                if key in {"prompt_tokens", "completion_tokens", "total_tokens"}
                and isinstance(value, int)
                and not isinstance(value, bool)
                and value >= 0
            }
            return ProviderReply(content=content, usage=usage)
        except httpx.TimeoutException:
            raise ProviderError("provider_timeout") from None
        except httpx.HTTPError:
            raise ProviderError("provider_network_error") from None
        except (ValueError, KeyError, IndexError, TypeError):
            raise ProviderError("provider_invalid_response") from None
