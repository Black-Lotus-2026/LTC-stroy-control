"""Общие приспособления тестов.

Часть проверок обходится без базы — они ловят ошибки импорта и расхождения
контракта, и обязаны проходить на машине, где ничего не поднято. Остальным
нужен настоящий PostgreSQL: запросы с фильтрами, сортировкой и постраничной
выборкой на заглушке не проверить, а именно в них живут ошибки.

Чтобы одно не мешало другому, тесты с базой пропускаются, если её нет.
Когда база есть (`make up` или `make test`), они выполняются в отдельной
схеме `test_api` — рабочие данные площадки при этом не трогаются.
"""

from __future__ import annotations

from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import Session

from app.api.deps import DbSession  # noqa: F401 - импорт проверяет сборку зависимостей
from app.core.config import settings
from app.db.base import Base
from app.db.session import get_db
from app.main import app

TEST_SCHEMA = "test_api"


@pytest.fixture(scope="session")
def engine() -> Generator[Engine, None, None]:
    probe = create_engine(settings.database_url, future=True)
    try:
        with probe.connect() as connection:
            connection.execute(text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001 - причина не важна, важен факт
        probe.dispose()
        pytest.skip(f"PostgreSQL недоступен ({exc.__class__.__name__}), пропуск")

    with probe.begin() as connection:
        connection.execute(text(f"DROP SCHEMA IF EXISTS {TEST_SCHEMA} CASCADE"))
        connection.execute(text(f"CREATE SCHEMA {TEST_SCHEMA}"))

    # Таблицы создаются из моделей, а не миграцией: миграция уже проверена
    # тем, что она применилась к рабочей базе, а здесь нужна схема ровно та,
    # которую видит код. Соответствие списка таблиц проверяет test_models.py.
    scoped = create_engine(
        settings.database_url,
        future=True,
        connect_args={"options": f"-csearch_path={TEST_SCHEMA}"},
    )
    Base.metadata.create_all(scoped)

    yield scoped

    scoped.dispose()
    with probe.begin() as connection:
        connection.execute(text(f"DROP SCHEMA IF EXISTS {TEST_SCHEMA} CASCADE"))
    probe.dispose()


@pytest.fixture
def db(engine: Engine) -> Generator[Session, None, None]:
    """Сессия, откатываемая после теста.

    Внешняя транзакция открыта на соединении, а сессия присоединяется к ней
    через точки сохранения (`create_savepoint`). Поэтому `db.commit()` внутри
    сервисов работает по-настоящему — а после теста всё откатывается одним
    движением, и следующий тест начинает с пустой схемы.
    """
    connection = engine.connect()
    transaction = connection.begin()
    session = Session(
        bind=connection,
        join_transaction_mode="create_savepoint",
        expire_on_commit=False,
    )
    try:
        yield session
    finally:
        session.close()
        transaction.rollback()
        connection.close()


@pytest.fixture
def client(db: Session) -> Generator[TestClient, None, None]:
    """HTTP-клиент, работающий в той же откатываемой транзакции."""
    app.dependency_overrides[get_db] = lambda: db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
