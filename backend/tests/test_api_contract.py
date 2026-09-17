"""Проверки контракта с фронтендом по схеме OpenAPI.

Базы не требуют. Ловят то, что ломает вторую команду молча: исчезнувшую
ручку, список без конверта `items`/`pagination`, действие, превращённое
в PATCH. Правила — docs/decisions/0006-api-contract.md
"""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)
schema = app.openapi()
paths = schema["paths"]

# Ручки, на которых уже строится интерфейс. Удаление любой — несовместимое
# изменение, и обнаружиться оно должно здесь, а не на демонстрации.
PROMISED = {
    "/api/v1/meta/dictionaries": {"get"},
    "/api/v1/projects": {"get"},
    "/api/v1/projects/{project_id}": {"get"},
    "/api/v1/zones": {"get"},
    "/api/v1/zones/{zone_id}": {"get"},
    "/api/v1/cameras": {"get"},
    "/api/v1/cameras/{camera_id}": {"get"},
    "/api/v1/users": {"get"},
    "/api/v1/incidents": {"get"},
    "/api/v1/incidents/{incident_id}": {"get"},
    "/api/v1/incidents/by-code/{code}": {"get"},
    "/api/v1/incidents/{incident_id}/assign": {"post"},
    "/api/v1/incidents/{incident_id}/status": {"post"},
    "/api/v1/incidents/{incident_id}/comment": {"post"},
}

LIST_ENDPOINTS = [
    "/api/v1/projects",
    "/api/v1/zones",
    "/api/v1/cameras",
    "/api/v1/users",
    "/api/v1/incidents",
]


def _response_schema(path: str, method: str) -> dict:
    content = paths[path][method]["responses"]["200"]["content"]
    ref = content["application/json"]["schema"]["$ref"]
    return schema["components"]["schemas"][ref.rsplit("/", 1)[-1]]


def test_promised_endpoints_exist() -> None:
    for path, methods in PROMISED.items():
        assert path in paths, f"пропала ручка {path}"
        for method in methods:
            assert method in paths[path], f"у {path} пропал метод {method}"


def test_list_endpoints_return_page_envelope() -> None:
    """Голый массив в корне сломал бы фронтенд при добавлении счётчика."""
    for path in LIST_ENDPOINTS:
        body = _response_schema(path, "get")
        assert set(body["properties"]) == {"items", "pagination"}, path


def test_list_endpoints_accept_pagination() -> None:
    for path in LIST_ENDPOINTS:
        names = {p["name"] for p in paths[path]["get"]["parameters"]}
        assert {"page", "page_size"} <= names, path


def test_incident_actions_are_not_patch() -> None:
    """Действия пишут историю, поэтому это POST на подресурс, а не правка полей."""
    assert "patch" not in paths["/api/v1/incidents/{incident_id}"]


def test_reject_reason_is_documented_as_conditional() -> None:
    """Причина отклонения обязательна только для false_positive — из схемы
    это видно лишь описанием, и оно не должно потеряться."""
    ref = paths["/api/v1/incidents/{incident_id}/status"]["post"]["requestBody"][
        "content"
    ]["application/json"]["schema"]["$ref"]
    body = schema["components"]["schemas"][ref.rsplit("/", 1)[-1]]
    assert "false_positive" in body["properties"]["reject_reason"]["description"]


def test_errors_share_one_format() -> None:
    """У ошибок тот же конверт, что у всего остального: фронтенд разбирает
    только error.code."""
    error = schema["components"]["schemas"]["ErrorResponse"]
    assert set(error["properties"]) == {"error"}
    detail = schema["components"]["schemas"]["ErrorDetail"]
    assert {"code", "message", "details"} <= set(detail["properties"])

    for path in ("/api/v1/projects/{project_id}", "/api/v1/incidents/{incident_id}"):
        assert "404" in paths[path]["get"]["responses"], path


def test_unknown_path_returns_error_envelope() -> None:
    response = client.get("/api/v1/incidents/не-uuid")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
