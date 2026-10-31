"""Конфигурация Celery.

Две очереди с разными свойствами:

* `cv`      — детекция на кадрах. Тяжёлая, модель держится в памяти воркера,
              параллелизм низкий.
* `default` — правила, импорт, отчёты. Лёгкая и быстрая.

Разделение нужно, чтобы генерация отчёта не ждала в очереди за десятком
кадров. См. docs/decisions/0002-celery.md
"""

from __future__ import annotations

from celery import Celery
from celery.schedules import crontab

from app.core.config import settings

celery_app = Celery(
    "stroy_control",
    broker=settings.celery_broker_url,
    backend=settings.celery_result_backend,
    include=[
        "app.workers.tasks",
        "app.workers.cv_tasks",
        "app.workers.management_tasks",
        "app.workers.document_tasks",
        "app.workers.recording_tasks",
        "app.workers.ppr_tasks",
        "app.workers.safety_tasks",
    ],
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    # Задача считается взятой только после успешного выполнения: при падении
    # воркера кадр не потеряется, а уйдёт другому воркеру.
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    task_track_started=True,
    result_expires=3600,
    task_default_queue="default",
    task_routes={
        "cv.*": {"queue": "cv"},
        "recording.*": {"queue": "cv"},
        "ppr.*": {"queue": "ppr"},
    },
    # Аварийный синхронный режим: задачи выполняются прямо в вызывающем
    # процессе. Включается настройкой CELERY_EAGER=true.
    task_always_eager=settings.celery_eager,
    task_eager_propagates=settings.celery_eager,
    broker_connection_timeout=3,
    task_publish_retry=False,
)

# Периодические задачи. Расписание заполняется по мере появления пайплайна:
# опрос камер (ingest) и прогон правил (evaluate) живут здесь.
celery_app.conf.beat_schedule = {
    "link-pending-safety": {"task": "safety.link_pending", "schedule": 60.0},
    "analyze-pending-ppr": {"task": "ppr.dispatch_pending", "schedule": 30.0},
    "analyze-pending-recordings": {
        "task": "recording.enqueue_pending",
        "schedule": 60.0,
    },
    "management-reap-expired": {
        "task": "management.reap_expired",
        "schedule": 60.0,
    },
    "heartbeat": {
        "task": "system.heartbeat",
        "schedule": crontab(minute="*"),
    },
    "generate-due-reports": {
        "task": "reports.generate_due",
        "schedule": crontab(minute="*"),
    },
    "verify-due-incidents": {
        "task": "alerts.verify_due",
        "schedule": crontab(minute="*"),
    },
    "deliver-alert-emails": {
        "task": "alerts.deliver_emails",
        "schedule": crontab(minute="*"),
    },
    "refresh-weather-forecast": {
        "task": "weather.refresh_all",
        "schedule": crontab(hour=3, minute=0),
    },
    "expire-camera-moves": {
        "task": "cameras.expire_moves",
        "schedule": crontab(minute="*"),
    },
}
