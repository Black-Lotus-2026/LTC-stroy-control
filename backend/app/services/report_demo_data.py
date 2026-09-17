"""Повторяемые mock-данные для демонстрации отчётного агента."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.models import (
    Camera,
    CameraStatus,
    GeneratedReport,
    ObservationCategory,
    ObservationLog,
    ObservationSeverity,
    ObservationSource,
    Project,
    ReportPeriod,
    ReportSchedule,
    ReportScheduleFrequency,
    Zone,
    ZoneRiskLevel,
)
from app.services.report_service import calculate_next_run


@dataclass(frozen=True)
class DemoSeedResult:
    project_id: str
    logs_created: int
    schedules_created: int


def seed_report_demo(db: Session, *, now: datetime | None = None) -> DemoSeedResult:
    current = (now or datetime.now(UTC)).astimezone(UTC).replace(second=0, microsecond=0)
    project = db.scalar(select(Project).where(Project.code == "DEMO-NORTH"))
    if project is None:
        project = Project(
            code="DEMO-NORTH",
            name="ЖК «Северный», корпус 2",
            address="Москва, ул. Полярная, 18",
            timezone="Europe/Moscow",
            object_kind="housing",
        )
        db.add(project)
        db.flush()

    zones: dict[str, Zone] = {}
    for code, name, risk in (
        ("A-03", "Котлован", ZoneRiskLevel.ATTENTION),
        ("B-01", "Складирование", ZoneRiskLevel.NORMAL),
        ("C-02", "Корпус 2", ZoneRiskLevel.CRITICAL),
        ("D-01", "Периметр", ZoneRiskLevel.NORMAL),
    ):
        zone = db.scalar(
            select(Zone).where(Zone.project_id == project.id, Zone.code == code)
        )
        if zone is None:
            zone = Zone(project_id=project.id, code=code, name=name, risk_level=risk)
            db.add(zone)
            db.flush()
        zones[code] = zone

    cameras: dict[str, Camera] = {}
    for code, name, zone_code, camera_status, visibility in (
        ("CAM-03", "Кран, север", "A-03", CameraStatus.ONLINE, 72),
        ("CAM-07", "Въезд", "B-01", CameraStatus.ONLINE, 91),
        ("CAM-02", "Корпус, восток", "C-02", CameraStatus.DEGRADED, 48),
        ("CAM-05", "Бытовой городок", "D-01", CameraStatus.ONLINE, 86),
        ("CAM-09", "Склад, запад", "B-01", CameraStatus.OFFLINE, 0),
    ):
        camera = db.scalar(select(Camera).where(Camera.code == code))
        if camera is None:
            camera = Camera(
                project_id=project.id,
                zone_id=zones[zone_code].id,
                code=code,
                name=name,
                status=camera_status,
                visibility_percent=visibility,
                last_frame_at=current - timedelta(minutes=2),
            )
            db.add(camera)
            db.flush()
        cameras[code] = camera

    # Старые demo-отчёты ссылаются на прежние log ids в trace, поэтому при
    # повторном seed удаляем их вместе с временной шкалой.
    db.execute(delete(GeneratedReport).where(GeneratedReport.project_id == project.id))
    db.execute(delete(ObservationLog).where(ObservationLog.project_id == project.id))
    event_specs: list[
        tuple[
            int,
            str,
            str,
            ObservationSource,
            ObservationCategory,
            str,
            ObservationSeverity,
            str,
            str,
            dict[str, object],
        ]
    ] = [
        (
            -8,
            "CAM-02",
            "C-02",
            ObservationSource.CV,
            ObservationCategory.PPE,
            "ppe_missing",
            ObservationSeverity.WARNING,
            "Рабочий без каски",
            "Три последовательные детекции.",
            {
                "status": "confirmed",
                "confidence": 0.94,
                "visibility_percent": 48,
                "evidence_url": "/media/demo/ppe-001.jpg",
            },
        ),
        (
            -18,
            "CAM-03",
            "A-03",
            ObservationSource.CV,
            ObservationCategory.EQUIPMENT,
            "equipment_missing",
            ObservationSeverity.WARNING,
            "Ожидаемая техника не найдена",
            "Экскаватор не найден в трёх наблюдениях.",
            {
                "status": "in_progress",
                "confidence": 0.68,
                "visibility_percent": 72,
                "evidence_url": "/media/demo/equipment-001.jpg",
            },
        ),
        (
            -35,
            "CAM-03",
            "A-03",
            ObservationSource.CCTV,
            ObservationCategory.SAFETY,
            "danger_zone_entry",
            ObservationSeverity.CRITICAL,
            "Вход в опасную зону",
            "Человек пересёк границу работы экскаватора.",
            {
                "status": "confirmed",
                "confidence": 0.97,
                "evidence_url": "/media/demo/safety-001.jpg",
            },
        ),
        (
            -52,
            "CAM-02",
            "C-02",
            ObservationSource.CV,
            ObservationCategory.PROGRESS,
            "progress_delay",
            ObservationSeverity.WARNING,
            "Возможное отставание армирования",
            "Наблюдаемый прогресс 68% при плане 75%.",
            {
                "status": "confirmed",
                "planned_progress": 0.75,
                "actual_progress": 0.68,
                "visibility_percent": 48,
            },
        ),
        (
            -75,
            "CAM-09",
            "B-01",
            ObservationSource.SYSTEM,
            ObservationCategory.CAMERA,
            "camera_offline",
            ObservationSeverity.WARNING,
            "Камера вне сети",
            "Не поступают кадры и heartbeat.",
            {"status": "in_progress", "visibility_percent": 0},
        ),
        (
            -130,
            "CAM-02",
            "C-02",
            ObservationSource.VLC,
            ObservationCategory.EQUIPMENT,
            "idle_suspected",
            ObservationSeverity.INFO,
            "Предполагаемый простой крана",
            "Положение техники не менялось 28 минут.",
            {
                "status": "resolved",
                "confidence": 0.81,
                "evidence_url": "/media/demo/idle-001.jpg",
            },
        ),
        (
            -260,
            "CAM-05",
            "D-01",
            ObservationSource.CV,
            ObservationCategory.PPE,
            "vest_missing",
            ObservationSeverity.WARNING,
            "Нет сигнального жилета",
            "Нарушение подтверждено и устранено.",
            {"status": "resolved", "confidence": 0.91},
        ),
        (
            -420,
            "CAM-02",
            "C-02",
            ObservationSource.SYSTEM,
            ObservationCategory.DATA,
            "low_visibility",
            ObservationSeverity.WARNING,
            "Недостаточно данных о зоне",
            "Обзор перекрыт складируемыми материалами.",
            {"status": "confirmed", "visibility_percent": 48},
        ),
        (
            -900,
            "CAM-03",
            "A-03",
            ObservationSource.CCTV,
            ObservationCategory.SAFETY,
            "unsafe_distance",
            ObservationSeverity.CRITICAL,
            "Опасное сближение с техникой",
            "Расстояние до самосвала менее трёх метров.",
            {
                "status": "resolved",
                "confidence": 0.96,
                "evidence_url": "/media/demo/safety-002.jpg",
            },
        ),
        (
            -1500,
            "CAM-07",
            "B-01",
            ObservationSource.CV,
            ObservationCategory.EQUIPMENT,
            "unexpected_equipment",
            ObservationSeverity.INFO,
            "Несоответствующая техника",
            "Манипулятор находился вне согласованного окна.",
            {"status": "resolved", "confidence": 0.88},
        ),
        (
            -2880,
            "CAM-02",
            "C-02",
            ObservationSource.CV,
            ObservationCategory.PROGRESS,
            "progress_checkpoint",
            ObservationSeverity.INFO,
            "Зафиксирован этап армирования",
            "Кадр пригоден для сравнения прогресса.",
            {
                "status": "confirmed",
                "actual_progress": 0.64,
                "evidence_url": "/media/demo/progress-001.jpg",
            },
        ),
        (
            -4320,
            "CAM-03",
            "A-03",
            ObservationSource.SYSTEM,
            ObservationCategory.CAMERA,
            "camera_recovered",
            ObservationSeverity.INFO,
            "Связь с камерой восстановлена",
            "Перерыв передачи составил 11 минут.",
            {"status": "resolved", "visibility_percent": 72},
        ),
        (
            -7200,
            "CAM-05",
            "D-01",
            ObservationSource.MANUAL,
            ObservationCategory.SAFETY,
            "manual_inspection",
            ObservationSeverity.INFO,
            "Ручной обход завершён",
            "Замечаний по периметру нет.",
            {"status": "confirmed"},
        ),
        (
            -9360,
            "CAM-09",
            "B-01",
            ObservationSource.SYSTEM,
            ObservationCategory.DATA,
            "archive_gap",
            ObservationSeverity.WARNING,
            "Пробел в видеоархиве",
            "Отсутствует 17 минут видеозаписи.",
            {"status": "confirmed"},
        ),
    ]
    for (
        minutes,
        camera_code,
        zone_code,
        source,
        category,
        event_type,
        severity,
        title,
        description,
        payload,
    ) in event_specs:
        db.add(
            ObservationLog(
                project_id=project.id,
                camera_id=cameras[camera_code].id,
                zone_id=zones[zone_code].id,
                source=source,
                category=category,
                event_type=event_type,
                severity=severity,
                occurred_at=current + timedelta(minutes=minutes),
                title=title,
                description=description,
                payload={"demo": True, **payload},
            )
        )

    schedules_created = 0
    for name, frequency, period, run_at, weekday in (
        (
            "Сводка за смену",
            ReportScheduleFrequency.DAILY,
            ReportPeriod.DAY,
            time(20, 5),
            None,
        ),
        (
            "Еженедельный отчёт прораба",
            ReportScheduleFrequency.WEEKLY,
            ReportPeriod.WEEK,
            time(8, 0),
            0,
        ),
    ):
        schedule = db.scalar(
            select(ReportSchedule).where(
                ReportSchedule.project_id == project.id,
                ReportSchedule.name == name,
            )
        )
        if schedule is None:
            schedule = ReportSchedule(
                project_id=project.id,
                name=name,
                frequency=frequency,
                report_period=period,
                timezone=project.timezone,
                run_at_local=run_at,
                weekday=weekday,
                next_run_at=calculate_next_run(
                    frequency, project.timezone, run_at, weekday, now=current
                ),
            )
            db.add(schedule)
            schedules_created += 1

    db.flush()
    return DemoSeedResult(
        project_id=str(project.id),
        logs_created=len(event_specs),
        schedules_created=schedules_created,
    )
