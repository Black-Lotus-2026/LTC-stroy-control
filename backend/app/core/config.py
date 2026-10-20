"""Конфигурация приложения.

Все настройки читаются из переменных окружения (или файла .env) один раз
при старте процесса. И API, и Celery-воркер используют один и тот же объект
`settings`, поэтому расхождений между ними быть не может.
"""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, computed_field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Приложение ---
    app_name: str = "Строй-контроль API"
    api_v1_prefix: str = "/api/v1"
    environment: Literal["local", "docker", "prod"] = "local"
    debug: bool = True

    # --- База данных ---
    postgres_host: str = "localhost"
    postgres_port: int = 5432
    postgres_user: str = "stroy"
    postgres_password: str = "stroy"
    postgres_db: str = "stroy_control"

    # --- Redis / Celery ---
    redis_host: str = "localhost"
    redis_port: int = 6379
    redis_broker_db: int = 0
    redis_result_db: int = 1

    # Аварийный переключатель: при True задачи выполняются синхронно в том же
    # процессе, без брокера. Нужен, чтобы демонстрация не зависела от Redis
    # и чтобы тесты не поднимали воркер. См. docs/decisions/0002-celery.md
    celery_eager: bool = False

    # Management uses a separate adapter; never expose credentials in API or logs.
    openrouter_api_key: SecretStr = SecretStr("")
    openrouter_model: str = "openai/gpt-4o-mini"
    management_queue_timeout_seconds: int = 300
    management_run_timeout_seconds: int = 90

    # --- Хранилище кадров ---
    storage_backend: Literal["local"] = "local"
    storage_local_root: Path = Path("./var/storage")
    # Базовый URL, по которому отдаются файлы хранилища наружу.
    storage_public_url: str = "http://localhost:8000/media"

    # --- Часовой пояс проекта по умолчанию ---
    default_timezone: str = "Europe/Moscow"

    # --- LLM-формулировки для отчётов ---
    # Ключ не является полем Settings: ChatOpenAI читает OPENAI_API_KEY
    # из окружения, а мы не рискуем вывести его при сериализации.
    report_llm_enabled: bool = False
    report_llm_model: str = "gpt-5.5"
    report_llm_reasoning_effort: Literal[
        "none", "minimal", "low", "medium", "high", "xhigh"
    ] = "low"
    report_llm_timeout_seconds: float = Field(default=30.0, gt=0, le=120)
    report_llm_max_retries: int = Field(default=2, ge=0, le=5)

    # --- CORS: адреса, с которых ходит фронтенд ---
    cors_origins: list[str] = Field(
        default=[
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:4173",
            "http://127.0.0.1:4173",
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://localhost:8000",
            "http://127.0.0.1:8000",
        ]
    )

    # --- JWT Authentication ---
    jwt_secret_key: str = "stroy-control-super-secure-jwt-secret-key-2026-production"
    jwt_algorithm: str = "HS256"
    jwt_access_token_expire_days: int = 30

    # --- Контроль нарушений спецтехники ---
    # Период проверки и фиксации нарушений (в секундах).
    # Если за это время не появилась обязательная/рекомендованная техника или обнаружена лишняя — фиксируется нарушение.
    violation_evaluation_window_seconds: int = 30

    # Production always uses the one pinned trained checkpoint. Historical profile
    # names remain parseable for old environments but never select another YOLO.
    detector_profile: Literal[
        "construction_trained",
        "legacy",
        "construction_ensemble",
        "construction_partial24",
        "construction_partial",
    ] = "construction_trained"
    yolo_weights_path: Path = (
        Path(__file__).resolve().parents[2] / "weights" / "construction-yolov8m-v2.pt"
    )
    photo_vlm_enabled: bool = True
    photo_vlm_model: str = "openai/gpt-4o-mini"
    photo_vlm_timeout_seconds: float = Field(default=20, gt=0, le=60)
    max_image_upload_bytes: int = Field(default=20 * 1024 * 1024, gt=0)
    max_video_upload_bytes: int = Field(default=4 * 1024 * 1024 * 1024, gt=0)
    construction_policy: Literal["shadow", "enforce"] = "shadow"
    construction_equipment_weights: Path | None = None
    construction_mocs_weights: Path | None = None
    construction_partial_weights: Path | None = None
    construction_partial_sha256: str | None = None
    construction_partial_mapping: Path | None = None
    construction_partial_manifest: Path | None = None
    construction_partial_parent_support_iou: float | None = Field(
        default=None, gt=0, le=1
    )
    construction_device: str | None = None
    construction_imgsz: int = Field(default=960, ge=32, le=4096)
    construction_confidence: float = Field(default=0.5, gt=0, lt=1)
    # Only independently validated semantic classes may drive rules in enforce.
    construction_approved_classes: list[str] = Field(default_factory=list)

    # Optional SMTP delivery. In-app notifications work without these values.
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_username: str | None = None
    smtp_password: SecretStr | None = None
    smtp_from: str | None = None
    smtp_starttls: bool = True

    @computed_field  # type: ignore[prop-decorator]
    @property
    def database_url(self) -> str:
        return (
            f"postgresql+psycopg://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @computed_field  # type: ignore[prop-decorator]
    @property
    def celery_broker_url(self) -> str:
        return f"redis://{self.redis_host}:{self.redis_port}/{self.redis_broker_db}"

    @computed_field  # type: ignore[prop-decorator]
    @property
    def celery_result_backend(self) -> str:
        return f"redis://{self.redis_host}:{self.redis_port}/{self.redis_result_db}"


@lru_cache
def get_settings() -> Settings:
    """Настройки кешируются: объект создаётся один раз на процесс."""
    return Settings()


settings = get_settings()
