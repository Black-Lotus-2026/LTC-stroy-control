"""Read-only Devline adapter, restricted to operator-configured demo channels."""

from contextlib import asynccontextmanager
from urllib.parse import urlsplit

import anyio
import httpx
from fastapi import HTTPException

from app.core.config import settings
from app.services.camera_view import validated_capture_url

MAX_FRAME_BYTES = 8 * 1024 * 1024


def configured() -> bool:
    return bool(
        settings.myvms_demo_enabled
        and settings.myvms_base_url
        and settings.myvms_username
        and settings.myvms_password.get_secret_value()
    )


def channels() -> list[int]:
    return sorted({i for i in settings.myvms_demo_channels if 0 <= i <= 1023})


def require_channel(channel: int):
    if not configured() or channel not in channels():
        raise HTTPException(404, "Live-камера не опубликована")


@asynccontextmanager
async def open_resource(channel: int, resource: str):
    require_channel(channel)
    parsed = urlsplit(settings.myvms_base_url)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise HTTPException(503, "Некорректная настройка сервера MyVMS")
    url = settings.myvms_base_url.rstrip("/") + f"/cameras/{channel}/{resource}"
    try:
        pinned, host, hostname = await anyio.to_thread.run_sync(
            validated_capture_url, url
        )
        async with (
            httpx.AsyncClient(
                auth=httpx.BasicAuth(
                    settings.myvms_username, settings.myvms_password.get_secret_value()
                ),
                follow_redirects=False,
                trust_env=False,
                timeout=httpx.Timeout(15, connect=4),
            ) as client,
            client.stream(
                "GET",
                pinned,
                headers={"Host": host},
                extensions={"sni_hostname": hostname},
            ) as response,
        ):
            if response.status_code in {401, 403}:
                raise HTTPException(502, "MyVMS отклонил серверную авторизацию")
            if response.status_code != 200:
                raise HTTPException(502, "Камера MyVMS сейчас недоступна")
            yield response
    except (httpx.HTTPError, OSError, ValueError):
        raise HTTPException(502, "Нет связи с сервером MyVMS") from None


async def capture(channel: int) -> bytes:
    try:
        with anyio.fail_after(8):
            async with open_resource(channel, "image") as response:
                if not response.headers.get("content-type", "").startswith("image/"):
                    raise HTTPException(502, "MyVMS не вернул изображение")
                data = bytearray()
                async for part in response.aiter_bytes():
                    data.extend(part)
                    if len(data) > MAX_FRAME_BYTES:
                        raise HTTPException(502, "Кадр MyVMS превышает 8 МБ")
                if not data.startswith(b"\xff\xd8") or not data.endswith(b"\xff\xd9"):
                    raise HTTPException(502, "MyVMS вернул неполный JPEG-кадр")
                return bytes(data)
    except TimeoutError:
        raise HTTPException(504, "MyVMS не прислал кадр за 8 секунд") from None
