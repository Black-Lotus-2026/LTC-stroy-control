"""Конфигурация приложения.

Все настройки читаются из переменных окружения (или файла .env) один раз
при старте процесса. И API, и Celery-воркер используют один и тот же объект
`settings`, поэтому расхождений между ними быть не может.
"""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, computed_field
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
        default=["http://localhost:5173", "http://localhost:4173"]
    )

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
