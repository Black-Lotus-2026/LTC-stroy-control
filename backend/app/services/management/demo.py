"""Explicitly synthetic replay: no photographs, live detections or market rates."""

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import UUID, uuid5

from app.schemas.management import (
    DependencyInput,
    EvidenceInput,
    ExplicitCost,
    ManagementSnapshot,
    RateInput,
    ResourceInput,
    RuleSnapshot,
    ScenarioInput,
    TaskInput,
    WorkCalendar,
)
from app.services.management.calendar import add_work_hours

EPISODES = ("baseline", "camera_unavailable", "slack", "expensive_action")
DEMO_PROJECT_ID = UUID("00000000-0000-4000-8000-000000000001")
AS_OF = datetime(2026, 10, 16, 5, tzinfo=UTC)


def make_demo_snapshot(
    project_id: UUID | str, episode: str = "baseline"
) -> ManagementSnapshot:
    if episode not in EPISODES:
        raise ValueError(f"Unknown demo episode: {episode}")
    project_id = UUID(str(project_id))
    zone_id = str(uuid5(project_id, "management-demo-zone"))
    calendar = WorkCalendar()
    b_start = Decimal(16 if episode == "slack" else 12)
    tasks = []
    for key, name, duration, earliest, ref_start in (
        ("A", "Земляные работы", 8, 0, Decimal(0)),
        ("B", "Подготовка следующего этапа", 8, b_start, b_start),
        ("C", "Следующий этап", 8, 0, b_start + 8),
        ("D", "Параллельные работы", 24, 0, Decimal(0)),
        ("M", "Контрольная точка", 0, 0, b_start + 16),
    ):
        tasks.append(
            TaskInput(
                id=key,
                project_id=project_id,
                name=name,
                remaining_work_hours=Decimal(duration),
                earliest_start_work_hours=Decimal(earliest),
                planned_start=add_work_hours(AS_OF, ref_start, calendar),
                planned_end=add_work_hours(AS_OF, ref_start + duration, calendar),
            )
        )
    def rate(key, amount):
        return RateInput(
            id=key,
            amount=Decimal(amount),
            unit="work_hour",
            source="demo:rates — условные входы контрольного примера",
            confirmation="demo",
        )
    scenarios = []
    for key, title, recovery in (
        ("fast", "Быстрое вмешательство", 2),
        ("late", "Более позднее вмешательство", 4),
        ("no_action", "Без дополнительного действия", 8),
    ):
        intervention = []
        if key != "no_action":
            intervention.append(
                ExplicitCost(
                    id="mobilization",
                    title="Условная ускоренная мобилизация",
                    amount=Decimal(150000 if episode == "expensive_action" else 20000),
                    cost_group="mobilization",
                    source="demo:action — условная разовая стоимость",
                )
            )
        scenarios.append(
            ScenarioInput(
                id=key,
                title=title,
                recovery_work_hours=Decimal(recovery),
                intervention_costs=intervention,
                assumptions=[
                    f"demo:scenario:{key}: восстановление через {recovery} рабочих часа "
                    "задано для сравнения, не является прогнозом наличия техники."
                ],
            )
        )
    evidence = []
    for index in (1, 2):
        unavailable = episode == "camera_unavailable" and index == 2
        evidence.append(
            EvidenceInput(
                source_ref=f"demo:camera:{index}",
                project_id=project_id,
                zone_id=zone_id,
                camera_id=str(uuid5(project_id, f"management-demo-camera-{index}")),
                captured_at=AS_OF - timedelta(minutes=3 - index),
                model_status="unavailable" if unavailable else "valid",
                camera_status="offline" if unavailable else "online",
                detected_classes=[] if unavailable else ["excavator", "person"],
                image_url=f"/demo_management/camera-{index}.svg",
                origin="demo_replay",
            )
        )
    refs = [
        "demo:schedule",
        "demo:rates",
        "demo:action",
        "demo:human-confirmation",
        "demo:rule:v1",
        "demo:camera:1",
        "demo:camera:2",
        "demo:scenario:fast",
        "demo:scenario:late",
        "demo:scenario:no_action",
    ]
    return ManagementSnapshot(
        project_id=project_id,
        as_of=AS_OF,
        data_mode="demo",
        zone_id=zone_id,
        schedule_version=f"demo-schedule-v1:{episode}",
        profile_version=f"demo-profile-v1:{episode}",
        calendar=calendar,
        tasks=tasks,
        dependencies=[
            DependencyInput(predecessor_id=a, successor_id=b)
            for a, b in (("A", "B"), ("B", "C"), ("C", "M"), ("D", "M"))
        ],
        blocked_task_id="A",
        milestone_task_id="M",
        agreed_deadline_at=add_work_hours(AS_OF, b_start + 16, calendar),
        blockage_confirmation="hypothesis"
        if episode == "camera_unavailable"
        else "human_confirmed",
        confirmation_source=None
        if episode == "camera_unavailable"
        else "demo:human-confirmation — условное подтверждение в демо эпизоде",
        rule=RuleSnapshot(
            version="demo-rule-v1",
            source_ref="demo:rule:v1",
            required_class="dump_truck",
            applicable_task_ids=["A"],
        ),
        evidence=evidence,
        resources=[
            ResourceInput(
                resource_id="excavator",
                name="Экскаватор (условный оплачиваемый ресурс)",
                paid_and_affected=True,
                rates=[rate("excavator-hour", 8000)],
                cost_group="excavator_idle",
                source="demo:rates",
            ),
            ResourceInput(
                resource_id="crew",
                name="Бригада (условный оплачиваемый ресурс)",
                paid_and_affected=True,
                rates=[rate("crew-hour", 4000)],
                cost_group="crew_idle",
                source="demo:rates",
            ),
        ],
        extension_rates=[rate("extension-hour", 4000)],
        extension_cost_group="site_overhead",
        extension_excludes_resource_costs=True,
        scenarios=scenarios,
        no_action_scenario_id="no_action",
        source_refs=refs,
        assumptions=[
            "ДЕМОНСТРАЦИЯ: наблюдения двух камер заданы синтетически; "
            "реальные снимки и CV-модель в эпизоде не использованы.",
            "Изображения — иллюстративные схемы. Присутствие техники тестовое, "
            "а не результат фактического детектора.",
            "Все денежные входы условные. Результат — сценарные дополнительные затраты, "
            "не фактическая экономия.",
            "Источник demo:rates: 8000 и 4000 RUB/рабочий час простоя; "
            "4000 RUB/рабочий час продления, исключая экскаватор и бригаду.",
            "Задача A полностью заблокирована до заданного восстановления; "
            "оставшиеся длительности введены явно.",
        ],
    )
