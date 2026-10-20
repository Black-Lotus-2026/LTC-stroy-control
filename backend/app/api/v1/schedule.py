"""API endpoints for Schedule and Gantt Management."""

from __future__ import annotations

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, File, HTTPException, UploadFile
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession
from app.models.enums import ScheduleTaskStatus
from app.models.schedule import ScheduleTask
from app.schemas.stroy_control import (
    CascadeShiftRequest,
    CascadeShiftResponse,
    MachineryProbabilityItem,
    ScheduleImportResponse,
    StageItem,
    StageMachineryOverrideRequest,
    StageProbabilityResponse,
    StageUpdateRequest,
)
from app.services.detector import MACHINERY_CLASSES
from app.services.legacy_access import require_full_project_read
from app.services.management.context import require_project
from app.services.schedule_engine import ScheduleEngine
from app.services.stage_matcher import StageMachineryService
from app.services.machinery_rules import BY_CODE, code_for_name, current_probability, set_probability

router = APIRouter(prefix="/schedule", tags=["Календарный план"])


def _parse_uuid(val: Any) -> uuid.UUID | None:
    if not val:
        return None
    if isinstance(val, uuid.UUID):
        return val
    try:
        return uuid.UUID(str(val))
    except (ValueError, AttributeError):
        return None


def _project_scope(db, project_id, user, *, write=False):
    parsed = _parse_uuid(project_id)
    if parsed is None:
        raise HTTPException(422, "Выберите объект строительства")
    require_project(
        db, parsed, user, write=True, lock=True
    ) if write else require_full_project_read(db, parsed, user)
    return parsed


@router.get("/stages", response_model=list[StageItem])
def get_stages(
    db: DbSession, user: CurrentUser, project_id: str | None = None
) -> list[StageItem]:
    """Получить список этапов СМР для отображения на диаграмме Ганта."""
    parsed_id = _project_scope(db, project_id, user)
    query = (
        select(ScheduleTask)
        .where(ScheduleTask.status != ScheduleTaskStatus.CANCELLED)
        .order_by(ScheduleTask.order_index)
    )
    if parsed_id:
        query = query.where(ScheduleTask.project_id == parsed_id)

    stages = db.scalars(query).all()
    return [
        StageItem(
            id=s.id,
            project_id=s.project_id,
            name=s.name,
            order_index=s.order_index,
            planned_start=s.planned_start,
            planned_end=s.planned_end,
            duration_days=s.duration_days,
            matched_catalog_name=s.matched_catalog_name,
            catalog_similarity=s.catalog_similarity,
            status=s.status.value if hasattr(s.status, "value") else str(s.status),
        )
        for s in stages
    ]


@router.delete("/stages", status_code=200)
@router.post("/clear", status_code=200)
def clear_stages(
    db: DbSession, user: CurrentUser, project_id: str | None = None
) -> dict[str, Any]:
    """Очистить календарный план (все этапы или конкретного объекта)."""
    parsed_id = _project_scope(db, project_id, user, write=True)
    rows = list(
        db.scalars(
            select(ScheduleTask).where(
                ScheduleTask.project_id == parsed_id,
                ScheduleTask.status != ScheduleTaskStatus.CANCELLED,
            )
        )
    )
    for stage in rows:
        stage.status = ScheduleTaskStatus.CANCELLED
    _audit_schedule(db, parsed_id, user, "schedule.archived", len(rows))
    db.commit()
    return {
        "message": "Календарный план архивирован; исторические этапы сохранены",
        "deleted_count": 0,
        "archived_count": len(rows),
    }


@router.post("/load-demo", response_model=ScheduleImportResponse)
def load_demo(
    db: DbSession, user: CurrentUser, project_id: str | None = None
) -> ScheduleImportResponse:
    """Загрузить эталонный демо-файл календарного плана 'Многоквартирный жилой дом'."""
    parsed_id = _project_scope(db, project_id, user, write=True)
    engine = ScheduleEngine(db)
    stages = engine.load_demo_schedule(parsed_id, commit=False)
    _audit_schedule(db, parsed_id, user, "schedule.imported", len(stages))
    db.commit()
    items = [
        StageItem(
            id=s.id,
            project_id=s.project_id,
            name=s.name,
            order_index=s.order_index,
            planned_start=s.planned_start,
            planned_end=s.planned_end,
            duration_days=s.duration_days,
            matched_catalog_name=s.matched_catalog_name,
            catalog_similarity=s.catalog_similarity,
            status=s.status.value if hasattr(s.status, "value") else str(s.status),
        )
        for s in stages
    ]
    return ScheduleImportResponse(
        project_id=stages[0].project_id if stages else (parsed_id or uuid.uuid4()),
        total_stages_imported=len(stages),
        matched_catalog_count=sum(1 for s in stages if s.matched_catalog_name),
        stages=items,
    )


@router.post("/upload", response_model=ScheduleImportResponse)
async def upload_schedule(
    db: DbSession,
    user: CurrentUser,
    file: Annotated[UploadFile, File()],
    project_id: str | None = None,
) -> ScheduleImportResponse:
    """Загрузить пользовательский файл графика СМР (.xlsx или .csv)."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="Имя файла не указано")

    ext = file.filename.lower().split(".")[-1]
    if ext not in ("xlsx", "csv"):
        raise HTTPException(
            status_code=400,
            detail="Неподдерживаемый формат файла. Поддерживаются только .xlsx и .csv",
        )

    content = await file.read()
    parsed_id = _project_scope(db, project_id, user, write=True)
    engine = ScheduleEngine(db)
    try:
        stages = engine.import_schedule_bytes(
            content, file.filename, parsed_id, commit=False
        )
        _audit_schedule(db, parsed_id, user, "schedule.imported", len(stages))
        db.commit()
    except Exception as e:
        raise HTTPException(
            status_code=422, detail=f"Ошибка разбора файла графика: {e}"
        ) from e

    items = [
        StageItem(
            id=s.id,
            project_id=s.project_id,
            name=s.name,
            order_index=s.order_index,
            planned_start=s.planned_start,
            planned_end=s.planned_end,
            duration_days=s.duration_days,
            matched_catalog_name=s.matched_catalog_name,
            catalog_similarity=s.catalog_similarity,
            status=s.status.value if hasattr(s.status, "value") else str(s.status),
        )
        for s in stages
    ]
    return ScheduleImportResponse(
        project_id=stages[0].project_id if stages else (parsed_id or uuid.uuid4()),
        total_stages_imported=len(stages),
        matched_catalog_count=sum(1 for s in stages if s.matched_catalog_name),
        stages=items,
    )


@router.put("/stages/{stage_id}", response_model=StageItem)
def update_stage(
    stage_id: str,
    payload: StageUpdateRequest,
    db: DbSession,
    user: CurrentUser,
) -> StageItem:
    """Обновить название, даты и длительность этапа."""
    stage = _owned_stage(stage_id, db, user, write=True)

    if payload.name is not None:
        stage.name = payload.name
    if payload.planned_start is not None:
        stage.planned_start = payload.planned_start
    if payload.planned_end is not None:
        stage.planned_end = payload.planned_end
    if payload.duration_days is not None:
        stage.duration_days = payload.duration_days

    _audit_schedule(db, stage.project_id, user, "schedule.changed", stage.id)
    db.commit()
    db.refresh(stage)

    return StageItem(
        id=stage.id,
        project_id=stage.project_id,
        name=stage.name,
        order_index=stage.order_index,
        planned_start=stage.planned_start,
        planned_end=stage.planned_end,
        duration_days=stage.duration_days,
        matched_catalog_name=stage.matched_catalog_name,
        catalog_similarity=stage.catalog_similarity,
        status=stage.status.value
        if hasattr(stage.status, "value")
        else str(stage.status),
    )


@router.post("/cascade-shift", response_model=CascadeShiftResponse)
def cascade_shift(
    payload: CascadeShiftRequest,
    db: DbSession,
    user: CurrentUser,
) -> CascadeShiftResponse:
    """Сдвинуть все последующие этапы на N дней при отставании текущего этапа."""
    _owned_stage(str(payload.delayed_stage_id), db, user, write=True)
    engine = ScheduleEngine(db)
    try:
        result = engine.cascade_shift(
            payload.delayed_stage_id, payload.delay_days, commit=False
        )
        stage = _owned_stage(str(payload.delayed_stage_id), db, user, write=True)
        _audit_schedule(
            db, stage.project_id, user, "schedule.shifted", payload.delay_days
        )
        db.commit()
        return result
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


def _find_stage(stage_id: str, db: DbSession) -> ScheduleTask | None:
    target = _parse_uuid(stage_id)
    return db.get(ScheduleTask, target) if target else None


def _owned_stage(stage_id, db, user, *, write=False):
    stage = _find_stage(stage_id, db)
    if stage is None:
        raise HTTPException(404, "Этап не найден")
    require_project(
        db, stage.project_id, user, write=True
    ) if write else require_full_project_read(db, stage.project_id, user)
    return stage


def _build_stage_probability_response(
    stage: ScheduleTask | None,
    db=None,
) -> StageProbabilityResponse:
    matcher = StageMachineryService()
    stage_name = stage.name if stage else "Общестроительные работы"
    prob_profile = matcher.estimate_machinery_probabilities(stage_name)
    overrides = (stage.machinery_probabilities or {}) if stage else {}
    sources = (stage.machinery_rule_sources or {}) if stage else {}

    status_to_prob = {
        "MANDATORY": 0.95,
        "RECOMMENDED": 0.75,
        "NEUTRAL": 0.40,
        "UNCHARACTERISTIC": 0.05,
        "ОБЯЗАТЕЛЬНАЯ": 0.95,
        "РЕКОМЕНДОВАННАЯ": 0.75,
        "ДОПУСТИМАЯ": 0.40,
        "НЕ ДОПУСКАЕТСЯ": 0.05,
    }

    items: list[MachineryProbabilityItem] = []
    # Map all 10 specialized classes
    for _cls_id, (raw_label, label_ru, code) in MACHINERY_CLASSES.items():
        override_val = next(
            (overrides[key] for key in (code, raw_label, label_ru) if key in overrides),
            None,
        )
        if override_val is not None:
            if (
                isinstance(override_val, str)
                and override_val.strip().upper() in status_to_prob
            ):
                prob = status_to_prob[override_val.strip().upper()]
            else:
                try:
                    prob = float(override_val)
                except (ValueError, TypeError):
                    prob = 0.5
        else:
            # Match probability from StageMachineryService output
            prob = prob_profile.probabilities.get(raw_label, 0.0)
            if prob == 0.0:
                prob = prob_profile.probabilities.get(label_ru.lower(), 0.0)

        # Classification rule thresholds
        if prob > 0.8:
            cls = "MANDATORY"
            level = "Обязательная"
        elif prob >= 0.6:
            cls = "RECOMMENDED"
            level = "Рекомендованная"
        elif prob < 0.15:
            cls = "UNCHARACTERISTIC"
            level = "Не допускается"
        else:
            cls = "NEUTRAL"
            level = "Допустимая"

        items.append(
            MachineryProbabilityItem(
                machinery_code=code,
                machinery_name_ru=label_ru,
                probability=round(prob, 2),
                classification=cls,
                requirement_level=level,
                source=sources.get(code, {}).get("source", "catalog"),
            )
        )

    ppr_revision = ""
    if db is not None and stage is not None:
        from app.services.ppr_rules import resolve_ppr_rules
        from app.services.rule_engine import to_russian_machinery_name

        rules, ppr_revision = resolve_ppr_rules(db, stage.project_id, stage)
        for code in rules:
            label = to_russian_machinery_name(code)
            if not any(item.machinery_name_ru == label for item in items):
                items.append(
                    MachineryProbabilityItem(
                        machinery_code="MACHINERY_" + code.upper(),
                        machinery_name_ru=label,
                        probability=0.5,
                        classification="NEUTRAL",
                        requirement_level="Допустимая",
                    )
                )
        for item in items:
            rule = next(
                (
                    value
                    for code, value in rules.items()
                    if to_russian_machinery_name(code) == item.machinery_name_ru
                ),
                None,
            )
            if rule:
                item.probability = rule["probability"]
                item.basis = "ppr_conflict" if rule["conflict"] else "ppr"
                item.ppr_requirements = rule["citations"]
                item.classification = (
                    "NEUTRAL"
                    if rule["conflict"]
                    else ("MANDATORY" if rule["probability"] == 1 else "UNCHARACTERISTIC")
                )
                item.requirement_level = (
                    "Конфликт ППР · требуется проверка"
                    if rule["conflict"]
                    else (
                        "Обязательная по ППР"
                        if rule["probability"] == 1
                        else "Запрещена по ППР"
                    )
                )

    # Sort items by probability descending
    items.sort(key=lambda x: x.probability, reverse=True)
    top_machinery = [it.machinery_name_ru for it in items if it.probability >= 0.6]

    return StageProbabilityResponse(
        ppr_revision=ppr_revision,
        stage_id=stage.id if stage else uuid.uuid4(),
        stage_name=stage.name if stage else stage_name,
        matched_catalog_stage=stage.matched_catalog_name
        if stage
        else "Общестроительные работы",
        similarity_confidence=stage.catalog_similarity
        if (stage and stage.catalog_similarity is not None)
        else 0.95,
        probabilities=items,
        top_machinery=top_machinery,
        has_custom_override=bool(sources),
    )


@router.get("/stages/{stage_id}/probabilities", response_model=StageProbabilityResponse)
def get_stage_probabilities(
    stage_id: str, db: DbSession, user: CurrentUser
) -> StageProbabilityResponse:
    """Получить распределение вероятностей техники для детального экрана этапа."""
    stage = _owned_stage(stage_id, db, user)
    return _build_stage_probability_response(stage, db)


@router.put("/stages/{stage_id}/probabilities", response_model=StageProbabilityResponse)
def update_stage_probabilities(
    stage_id: str,
    payload: StageMachineryOverrideRequest,
    db: DbSession,
    user: CurrentUser,
) -> StageProbabilityResponse:
    """Ручная настройка статуса/вероятности техники на этапе."""
    stage = _owned_stage(stage_id, db, user, write=True)

    current_overrides = dict(stage.machinery_probabilities or {})
    origins = dict(stage.machinery_rule_sources or {})
    for key, value in payload.overrides.items():
        code = key if key in BY_CODE else code_for_name(key)
        if code:
            probability = current_probability({code: value}, code)
            if probability is None or not 0 <= probability <= 1:
                raise HTTPException(422, "Некорректное значение вероятности")
            current_overrides = set_probability(current_overrides, code, probability)
            origins[code] = {"source": "manual"}
        else:
            current_overrides[key] = value
    stage.machinery_probabilities = current_overrides
    stage.machinery_rule_sources = origins
    _audit_schedule(db, stage.project_id, user, "schedule.changed", stage.id)
    db.commit()
    db.refresh(stage)
    return _build_stage_probability_response(stage, db)


@router.delete(
    "/stages/{stage_id}/probabilities", response_model=StageProbabilityResponse
)
def reset_stage_probabilities(
    stage_id: str,
    db: DbSession,
    user: CurrentUser,
) -> StageProbabilityResponse:
    """Сбросить ручные настройки техники к расчётам по справочнику/AI."""
    stage = _owned_stage(stage_id, db, user, write=True)

    stage.machinery_probabilities = StageMachineryService().estimate_machinery_probabilities(stage.name).probabilities
    stage.machinery_rule_sources = {}
    _audit_schedule(db, stage.project_id, user, "schedule.changed", stage.id)
    db.commit()
    db.refresh(stage)
    return _build_stage_probability_response(stage, db)


def _audit_schedule(db, project_id, user, event_type, detail):
    from app.services.access_policy import resolve_context
    from app.services.incident_workflow import audit

    ctx = resolve_context(db, project_id, user, "project.manage", write=True, lock=True)
    return audit(db, ctx, event_type, project_id, str(detail))
