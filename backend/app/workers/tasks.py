"""Celery-задачи.

Соглашение проекта: вся логика живёт в обычных функциях (в `app.services`
или рядом), а `@shared_task` — тонкая обёртка, которая только вызывает их.
Это значит, что любой шаг пайплайна можно запустить синхронно: из теста,
из скрипта, из консоли — без брокера и воркера.
См. docs/decisions/0002-celery.md
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from celery import shared_task

logger = logging.getLogger(__name__)


def heartbeat() -> dict[str, str]:
    """Проверка живости воркера: пишет отметку времени в лог.

    Существует, чтобы `docker compose up` можно было проверить целиком —
    включая beat и воркер, — ещё до появления реального пайплайна.
    """
    now = datetime.now(UTC).isoformat()
    logger.info("heartbeat: воркер жив, %s", now)
    return {"status": "ok", "timestamp": now}


@shared_task(name="system.heartbeat")
def heartbeat_task() -> dict[str, str]:
    return heartbeat()
