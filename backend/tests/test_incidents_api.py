"""Поведение ручек инцидентов на настоящей базе.

Пропускаются, когда PostgreSQL недоступен (см. tests/conftest.py).
Фильтры, сортировка и постраничная выборка на заглушке не проверяются —
именно поэтому здесь нужна база, а не подмена сессии.
"""

from __future__ import annotations

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.db.base import utcnow
from app.models import (
    Camera,
    CameraStatus,
    Incident,
    IncidentCategory,
    IncidentPriority,
    IncidentStatus,
    IncidentType,
    Project,
    User,
    UserRole,
    Zone,
)

NOW = utcnow()


@pytest.fixture
def scene(db: Session) -> dict:
    """Минимальная площадка: зона, камера, два инцидента, один человек."""
    project = Project(code="TEST", name="Тестовая площадка")
    db.add(project)
    db.flush()

    zone = Zone(project_id=project.id, code="A-03", name="Котлован")
    db.add(zone)
    db.flush()

    camera = Camera(
        project_id=project.id,
        zone_id=zone.id,
        code="CAM-03",
        name="Кран, север",
        status=CameraStatus.ONLINE,
        visibility_percent=72,
    )
    user = User(name="Алексей Морозов", role=UserRole.INSPECTOR)
    db.add_all([camera, user])
    db.flush()

    overdue = Incident(
        code="INC-247",
        project_id=project.id,
        zone_id=zone.id,
        camera_id=camera.id,
        category=IncidentCategory.EQUIPMENT,
        type=IncidentType.EQUIPMENT_MISSING,
        title="Ожидаемая техника не найдена",
        explanation={
            "summary": "Экскаватор не найден в трёх наблюдениях подряд",
            "factors": ["По плану активна работа «Разработка грунта»"],
            "limitations": ["Камера видит 72% рабочей зоны"],
        },
        status=IncidentStatus.PENDING,
        priority=IncidentPriority.MEDIUM,
        confidence=0.68,
        dedup_key="equipment_missing:A-03",
        first_seen_at=NOW - timedelta(minutes=22),
        last_seen_at=NOW,
        observation_count=3,
        sla_deadline=NOW - timedelta(minutes=5),
    )
    critical = Incident(
        code="INC-245",
        project_id=project.id,
        zone_id=zone.id,
        camera_id=camera.id,
        category=IncidentCategory.SAFETY,
        type=IncidentType.OTHER,
        title="Вход в опасную зону",
        explanation={"summary": "Человек пересёк границу активной зоны"},
        status=IncidentStatus.RESOLVED,
        priority=IncidentPriority.CRITICAL,
        confidence=0.97,
        dedup_key="safety:A-03",
        first_seen_at=NOW - timedelta(minutes=49),
        last_seen_at=NOW,
        sla_deadline=NOW - timedelta(hours=2),
    )
    db.add_all([overdue, critical])
    db.commit()
    return {
        "project": str(project.id),
        "zone": str(zone.id),
        "camera": str(camera.id),
        "user": str(user.id),
        "overdue": str(overdue.id),
        "resolved": str(critical.id),
    }


def test_incident_list_shows_zone_and_camera(client: TestClient, scene: dict) -> None:
    """Карточка ленты обязана нести зону и камеру: без них строка
    в интерфейсе не собирается, а отдельный запрос на каждую — 150 запросов
    на страницу."""
    body = client.get("/api/v1/incidents").json()
    item = next(i for i in body["items"] if i["code"] == "INC-247")
    assert item["zone"]["code"] == "A-03"
    assert item["camera"]["code"] == "CAM-03"
    assert item["observation_count"] == 3


def test_overdue_is_computed_by_server(client: TestClient, scene: dict) -> None:
    items = {i["code"]: i for i in client.get("/api/v1/incidents").json()["items"]}
    assert items["INC-247"]["is_overdue"] is True
    # Закрытый инцидент просроченным не считается, даже если срок давно прошёл:
    # иначе счётчик «просрочено» рос бы вечно.
    assert items["INC-245"]["is_overdue"] is False


def test_only_open_hides_closed(client: TestClient, scene: dict) -> None:
    body = client.get("/api/v1/incidents", params={"only_open": True}).json()
    assert [i["code"] for i in body["items"]] == ["INC-247"]


def test_sort_by_priority_puts_critical_first(
    client: TestClient, scene: dict
) -> None:
    """В базе приоритет — строка; без отображения в вес это была бы
    сортировка по алфавиту."""
    body = client.get("/api/v1/incidents", params={"sort": "-priority"}).json()
    assert [i["code"] for i in body["items"]] == ["INC-245", "INC-247"]


def test_pagination_reports_total_not_page_size(
    client: TestClient, scene: dict
) -> None:
    body = client.get("/api/v1/incidents", params={"page_size": 1}).json()
    assert len(body["items"]) == 1
    assert body["pagination"]["total"] == 2


def test_detail_carries_explanation_limitations(
    client: TestClient, scene: dict
) -> None:
    """Ограничения наблюдения — обязательная часть вывода, а не украшение."""
    body = client.get(f"/api/v1/incidents/{scene['overdue']}").json()
    assert body["explanation"]["limitations"] == ["Камера видит 72% рабочей зоны"]


def test_action_response_is_current_state(client: TestClient, scene: dict) -> None:
    """Ответ на действие — состояние ПОСЛЕ него.

    Сессия живёт с expire_on_commit=False, поэтому повторный запрос легко
    возвращает объект из карты идентичности — прежний. Тогда интерфейс
    показывает состояние до нажатия кнопки, и ошибка выглядит как «кнопка
    не сработала».
    """
    response = client.post(
        f"/api/v1/incidents/{scene['overdue']}/assign",
        json={"user_id": scene["user"]},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["assignee"]["name"] == "Алексей Морозов"
    assert [e["event_type"] for e in body["events"]] == ["assigned"]

    body = client.post(
        f"/api/v1/incidents/{scene['overdue']}/comment",
        json={"text": "Проверил на месте"},
    ).json()
    assert body["events"][-1]["comment"] == "Проверил на месте"


def test_repeated_assign_does_not_pollute_history(
    client: TestClient, scene: dict
) -> None:
    """Двойной щелчок в интерфейсе не должен порождать вторую запись."""
    url = f"/api/v1/incidents/{scene['overdue']}/assign"
    client.post(url, json={"user_id": scene["user"]})
    body = client.post(url, json={"user_id": scene["user"]}).json()
    assert [e["event_type"] for e in body["events"]] == ["assigned"]


def test_status_change_writes_history(client: TestClient, scene: dict) -> None:
    body = client.post(
        f"/api/v1/incidents/{scene['overdue']}/status",
        json={"status": "confirmed"},
    ).json()
    assert body["status"] == "confirmed"
    event = body["events"][-1]
    assert (event["old_status"], event["new_status"]) == ("pending", "confirmed")


def test_same_status_twice_is_a_conflict(client: TestClient, scene: dict) -> None:
    url = f"/api/v1/incidents/{scene['overdue']}/status"
    client.post(url, json={"status": "confirmed"})
    response = client.post(url, json={"status": "confirmed"})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "INCIDENT_STATUS_UNCHANGED"


def test_rejection_requires_a_reason(client: TestClient, scene: dict) -> None:
    """Накопленные причины отклонений — материал для дообучения модели,
    поэтому отклонить без причины нельзя."""
    response = client.post(
        f"/api/v1/incidents/{scene['overdue']}/status",
        json={"status": "false_positive"},
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "REJECT_REASON_REQUIRED"


def test_reason_without_rejection_is_refused(client: TestClient, scene: dict) -> None:
    response = client.post(
        f"/api/v1/incidents/{scene['overdue']}/status",
        json={"status": "resolved", "reject_reason": "wrong_detection"},
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "REJECT_REASON_NOT_ALLOWED"


def test_rejected_incident_is_not_counted_as_resolved(
    client: TestClient, scene: dict
) -> None:
    """Отклонённый инцидент закрыт, но не устранён: иначе статистика
    «сколько нарушений исправлено» включала бы ошибки распознавания."""
    body = client.post(
        f"/api/v1/incidents/{scene['overdue']}/status",
        json={"status": "false_positive", "reject_reason": "wrong_detection"},
    ).json()
    assert body["status"] == "false_positive"
    assert body["resolved_at"] is None
    assert body["events"][-1]["event_type"] == "rejected"


def test_assign_to_unknown_user_is_not_found(client: TestClient, scene: dict) -> None:
    """Код ошибки должен отличать пропавшего пользователя от пропавшего
    инцидента: HTTP-код у них один, а реакция интерфейса разная."""
    response = client.post(
        f"/api/v1/incidents/{scene['overdue']}/assign",
        json={"user_id": "00000000-0000-0000-0000-000000000000"},
    )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "USER_NOT_FOUND"


def test_zone_list_carries_camera_count(client: TestClient, scene: dict) -> None:
    body = client.get("/api/v1/zones", params={"project_id": scene["project"]}).json()
    assert body["items"][0]["camera_count"] == 1


def test_project_detail_has_settings_and_counts(
    client: TestClient, scene: dict
) -> None:
    body = client.get(f"/api/v1/projects/{scene['project']}").json()
    assert body["zone_count"] == 1
    assert body["camera_count"] == 1
    # Площадка заведена без параметров наблюдения — это допустимо,
    # интерфейс обязан пережить пустое значение.
    assert body["settings"] is None
