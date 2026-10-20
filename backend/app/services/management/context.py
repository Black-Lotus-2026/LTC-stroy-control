"""Resolve authorized inputs before any calculator or model sees them."""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, datetime

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    AnalysisRun,
    AnalysisStatus,
    Camera,
    CameraStatus,
    CostRate,
    Detection,
    Frame,
    Incident,
    IncidentCategory,
    IncidentPriority,
    IncidentStatus,
    IncidentType,
    ObjectClass,
    Project,
    ProjectSettings,
    RuleKind,
    RuleSet,
    ScheduleTask,
    User,
    WorkRequirement,
    Zone,
)
from app.schemas.management import ManagementSnapshot
from app.storage import get_storage


def canonical_hash(value: dict) -> str:
    return hashlib.sha256(
        json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode()
    ).hexdigest()


def aware(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def require_project(
    db: Session,
    project_id: uuid.UUID,
    user: User,
    *,
    write=False,
    lock=False,
    permission: str | None = None,
) -> Project:
    from app.services.access_policy import resolve_context

    return resolve_context(
        db,
        project_id,
        user,
        permission=permission or ("project.manage" if write else "project.read"),
        write=write,
        lock=lock,
    ).project


def _owned(db: Session, model, raw_id: str, project_id: uuid.UUID):
    try:
        item = db.get(model, uuid.UUID(raw_id))
    except ValueError:
        item = None
    if item is None or item.project_id != project_id:
        raise HTTPException(
            422, "Вложенный объект отсутствует или принадлежит другому проекту"
        )
    return item


def validate_snapshot(db: Session, snapshot: ManagementSnapshot) -> ManagementSnapshot:
    """Never trust caller-supplied detector status, timestamps or image URLs.

    Demo replay is a separate explicitly labeled path. A user snapshot only
    accepts persisted frames; missing video ingestion remains visible as missing
    evidence, rather than client-authored 'successful detection'.
    """
    snapshot = snapshot.model_copy(deep=True)

    def validated():
        try:
            return ManagementSnapshot.model_validate(snapshot.model_dump(mode="json"))
        except ValidationError as exc:
            raise HTTPException(
                422, "Сохранённые данные нарушают контракт расчёта"
            ) from exc

    if snapshot.incident_id:
        inc = _owned(db, Incident, str(snapshot.incident_id), snapshot.project_id)
        if inc.zone_id and str(inc.zone_id) != snapshot.zone_id:
            raise HTTPException(422, "Зона расчёта не совпадает с зоной инцидента")
        if (
            snapshot.data_mode == "user"
            and (inc.explanation or {}).get("data_mode") == "demo"
        ):
            raise HTTPException(422, "Демонстрационный инцидент требует режима demo")
        blocked = next(t for t in snapshot.tasks if t.id == snapshot.blocked_task_id)
        if inc.schedule_task_id and inc.schedule_task_id != blocked.schedule_task_id:
            raise HTTPException(
                422, "Заблокированная задача не совпадает с этапом инцидента"
            )
    for task in snapshot.tasks:
        if task.schedule_task_id:
            saved = _owned(
                db, ScheduleTask, str(task.schedule_task_id), snapshot.project_id
            )
            if saved.zone_id and str(saved.zone_id) != snapshot.zone_id:
                raise HTTPException(422, "Задача привязана к другой зоне")
            task.planned_start = aware(saved.planned_start)
            task.planned_end = aware(saved.planned_end)
    if snapshot.data_mode == "demo":
        if any(e.origin != "demo_replay" for e in snapshot.evidence):
            raise HTTPException(
                422, "Демонстрационный профиль не смешивается с рабочими наблюдениями"
            )
        allowed_cameras = {
            str(uuid.uuid5(snapshot.project_id, f"management-demo-camera-{i}"))
            for i in (1, 2)
        }
        for evidence in snapshot.evidence:
            if (
                evidence.camera_id not in allowed_cameras
                or evidence.zone_id != snapshot.zone_id
            ):
                raise HTTPException(422, "Неизвестная камера демонстрационного профиля")
            if evidence.image_url not in (
                None,
                "/demo_management/camera-1.svg",
                "/demo_management/camera-2.svg",
            ):
                raise HTTPException(
                    422, "Неизвестная иллюстрация демонстрационного профиля"
                )
        return validated()
    _owned(db, Zone, snapshot.zone_id, snapshot.project_id)
    # User-provided refs do not become authorized just because they are strings
    # in an input list. Rebuild the allowlist from resolved sources.
    snapshot.source_refs = ["user:profile"]
    if snapshot.blockage_confirmation == "human_confirmed":
        snapshot.source_refs.append("user:confirmation")
    requirement = None
    target_class = None
    if snapshot.evidence:
        try:
            rule_id = uuid.UUID(snapshot.rule.source_ref.removeprefix("rule."))
            rule_set = db.get(RuleSet, rule_id)
        except ValueError:
            rule_set = None
        if not rule_set or rule_set.project_id not in (None, snapshot.project_id):
            raise HTTPException(
                422,
                "Для наблюдений требуется сохранённое правило rule.UUID этого объекта",
            )
        if snapshot.incident_id:
            inc = db.get(Incident, snapshot.incident_id)
            if inc.rule_set_id and inc.rule_set_id != rule_set.id:
                raise HTTPException(422, "Правило не совпадает с методикой инцидента")
        blocked = next(t for t in snapshot.tasks if t.id == snapshot.blocked_task_id)
        saved_task = (
            db.get(ScheduleTask, blocked.schedule_task_id)
            if blocked.schedule_task_id
            else None
        )
        if not saved_task or not saved_task.work_type_id:
            raise HTTPException(
                422,
                "Для проверки правила свяжите работу с сохранённым этапом и видом работ",
            )
        target_class = db.scalars(
            select(ObjectClass).where(
                ObjectClass.code == snapshot.rule.required_class,
                ObjectClass.is_active.is_(True),
            )
        ).first()
        if target_class:
            requirement = db.scalars(
                select(WorkRequirement).where(
                    WorkRequirement.rule_set_id == rule_set.id,
                    WorkRequirement.work_type_id == saved_task.work_type_id,
                    WorkRequirement.object_class_id == target_class.id,
                    WorkRequirement.kind == RuleKind.REQUIRED,
                )
            ).first()
        if not requirement or requirement.min_count != 1:
            raise HTTPException(
                422,
                "Требуется правило наличия класса; "
                "количественный дефицит не поддерживается",
            )
        snapshot.rule.version = rule_set.version
        snapshot.rule.source_ref = f"rule.{rule_set.id}"
        snapshot.rule.applicable_task_ids = [blocked.id]
        # Stored monitoring settings are authoritative for frame freshness.
        project_settings = db.get(ProjectSettings, snapshot.project_id)
        snapshot.rule.max_frame_age_minutes = max(
            1,
            min(
                1440, project_settings.matching_window_minutes if project_settings else 15
            ),
        )
        snapshot.rule.max_camera_skew_seconds = 120
        snapshot.source_refs.append(snapshot.rule.source_ref)
    else:
        snapshot.rule.source_ref = "user:rule-assumption"
        snapshot.source_refs.append(snapshot.rule.source_ref)
    for rate_list in [
        *(resource.rates for resource in snapshot.resources),
        snapshot.extension_rates,
    ]:
        for rate in rate_list:
            if rate.source.startswith("cost_rate."):
                try:
                    saved_rate = db.get(
                        CostRate, uuid.UUID(rate.source.removeprefix("cost_rate."))
                    )
                except ValueError:
                    saved_rate = None
                if not saved_rate or saved_rate.project_id not in (
                    None,
                    snapshot.project_id,
                ):
                    raise HTTPException(422, "Ставка недоступна")
                rate.amount = saved_rate.rate_per_hour
                rate.currency = saved_rate.currency
                rate.unit = "work_hour"
                rate.valid_from = aware(saved_rate.valid_from)
                rate.valid_to = (
                    aware(saved_rate.valid_to) if saved_rate.valid_to else None
                )
                rate.confirmation = "confirmed"
                snapshot.source_refs.append(rate.source)
            elif rate.confirmation == "demo":
                raise HTTPException(422, "Демонстрационная ставка требует режима demo")
    for evidence in snapshot.evidence:
        if evidence.origin != "persisted_frame" or not evidence.source_ref.startswith(
            "frame."
        ):
            raise HTTPException(
                422, "Наблюдение должно ссылаться на сохранённый кадр frame.UUID"
            )
        frame = _owned(
            db, Frame, evidence.source_ref.removeprefix("frame."), snapshot.project_id
        )
        camera = _owned(db, Camera, str(frame.camera_id), snapshot.project_id)
        if (
            str(frame.zone_id) != snapshot.zone_id
            or str(camera.zone_id) != snapshot.zone_id
        ):
            raise HTTPException(422, "Камера и кадр должны относиться к выбранной зоне")
        evidence.zone_id = str(frame.zone_id)
        evidence.camera_id = str(camera.id)
        evidence.captured_at = aware(frame.captured_at)
        evidence.image_url = get_storage().public_url(frame.storage_key)
        run = db.scalars(
            select(AnalysisRun)
            .where(AnalysisRun.frame_id == frame.id)
            .order_by(AnalysisRun.started_at.desc())
        ).first()
        valid = run is not None and run.status == AnalysisStatus.COMPLETED
        evidence.model_status = "valid" if valid else "unavailable"
        # Camera status NOW does not prove availability at capture time.
        # A successfully captured and analyzed archived frame is usable replay.
        evidence.camera_status = "online" if valid else "unknown"
        evidence.detected_classes = []
        if valid:
            detections = db.scalars(
                select(Detection).where(Detection.analysis_run_id == run.id)
            ).all()
            project_settings = db.get(ProjectSettings, snapshot.project_id)
            threshold = (
                requirement.confidence_threshold
                if requirement.confidence_threshold is not None
                else target_class.default_confidence_threshold
                if target_class.default_confidence_threshold is not None
                else project_settings.default_confidence_threshold
                if project_settings
                else 0.5
            )
            labels = set()
            for detection in detections:
                if detection.confidence < threshold:
                    continue
                canonical = (
                    detection.object_class.code if detection.object_class else None
                )
                if canonical:
                    labels.add(canonical)
                elif detection.raw_label in [
                    target_class.code,
                    *target_class.detector_labels,
                ]:
                    labels.add(target_class.code)
                elif detection.raw_label:
                    labels.add(detection.raw_label)
            evidence.detected_classes = sorted(labels)
        if evidence.captured_at < aware(
            saved_task.planned_start
        ) or evidence.captured_at > aware(saved_task.planned_end):
            snapshot.rule.applicable_task_ids = []
        snapshot.source_refs.append(evidence.source_ref)
    return validated()


def ensure_demo_incident(db: Session, snapshot: ManagementSnapshot) -> uuid.UUID:
    """Explicit demo action only, under the project's transaction lock.

    Stable ids and key consolidate reruns. No model result is presented as an
    actual observation; historical replay time stays separate from creation time.
    """
    if snapshot.incident_id:
        return snapshot.incident_id
    zone_id = uuid.uuid5(snapshot.project_id, "management-demo-zone")
    if snapshot.zone_id != str(zone_id):
        raise HTTPException(422, "Неизвестная зона демонстрационного профиля")
    if db.get(Zone, zone_id) is None:
        db.add(
            Zone(
                id=zone_id,
                project_id=snapshot.project_id,
                code="DEMO-EARTH",
                name="Демо · земляные работы",
            )
        )
        db.flush()
    for index in (1, 2):
        camera_id = uuid.uuid5(snapshot.project_id, f"management-demo-camera-{index}")
        if db.get(Camera, camera_id) is None:
            db.add(
                Camera(
                    id=camera_id,
                    project_id=snapshot.project_id,
                    zone_id=zone_id,
                    code=f"DEMO-{snapshot.project_id.hex[:12]}-{index}",
                    name=f"Демо · ракурс {index} (схема)",
                    status=CameraStatus.OFFLINE,
                )
            )
    key = (
        f"management-demo:{snapshot.project_id}:"
        f"{snapshot.zone_id}:{snapshot.as_of.isoformat()}"
    )
    incident = db.scalars(
        select(Incident).where(
            Incident.project_id == snapshot.project_id, Incident.dedup_key == key
        )
    ).first()
    if incident is None:
        incident = Incident(
            id=uuid.uuid4(),
            code=f"DEMO-{uuid.uuid4().hex[:12].upper()}",
            project_id=snapshot.project_id,
            zone_id=zone_id,
            category=IncidentCategory.EQUIPMENT,
            type=IncidentType.EQUIPMENT_MISSING,
            priority=IncidentPriority.MEDIUM,
            status=IncidentStatus.PENDING,
            title="Демо · проверка подачи самосвалов",
            description="Условный эпизод для сравнения сценариев. Не полевое наблюдение.",
            dedup_key=key,
            first_seen_at=snapshot.as_of,
            last_seen_at=snapshot.as_of,
            explanation={
                "data_mode": "demo",
                "rule_version": snapshot.rule.version,
                "summary": (
                    "Иллюстративные наблюдения, условные ставки " "и сроки восстановления"
                ),
            },
        )
        db.add(incident)
        db.flush()
    return incident.id
