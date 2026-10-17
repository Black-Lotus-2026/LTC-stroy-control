"""Проверки каркаса: приложение собирается и отвечает.

Тест намеренно не трогает базу и брокер — он должен проходить на машине,
где ничего не поднято, и ловить ошибки импорта и конфигурации.
"""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_returns_ok() -> None:
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_root_points_to_docs() -> None:
    response = client.get("/")
    assert response.status_code == 200
    assert response.json()["docs"] == "/docs"


def test_openapi_schema_is_generated() -> None:
    """OpenAPI — наш контракт с фронтендом, он обязан собираться всегда."""
    response = client.get("/openapi.json")
    assert response.status_code == 200
    assert "/api/v1/health" in response.json()["paths"]
    assert "/api/v1/reports/generate" in response.json()["paths"]
    assert "/api/v1/reports/schedules" in response.json()["paths"]
