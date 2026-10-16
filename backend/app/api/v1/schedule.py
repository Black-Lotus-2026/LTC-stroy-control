"""API endpoints for Schedule and Gantt Management."""

from __future__ import annotations

import re
from typing import Any
import uuid

from fastapi import APIRouter, File, HTTPException, UploadFile
from sqlalchemy import select

from app.api.deps import DbSession
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
from app.services.schedule_engine import ScheduleEngine
from app.services.stage_matcher import StageMachineryService

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


@router.get("/stages", response_model=list[StageItem])
def get_stages(db: DbSession, project_id: str | None = None) -> list[StageItem]:
    """Получить список этапов СМР для отображения на диаграмме Ганта."""
    parsed_id = _parse_uuid(project_id)
    query = select(ScheduleTask).order_by(ScheduleTask.order_index)
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
def clear_stages(db: DbSession, project_id: str | None = None) -> dict[str, Any]:
    """Очистить календарный план (все этапы или конкретного объекта)."""
    from sqlalchemy import delete

    parsed_id = _parse_uuid(project_id)
    stmt = delete(ScheduleTask)
    if parsed_id:
        stmt = stmt.where(ScheduleTask.project_id == parsed_id)
    res = db.execute(stmt)
    db.commit()
    return {"message": "Календарный план успешно очищен", "deleted_count": res.rowcount}


@router.post("/load-demo", response_model=ScheduleImportResponse)
def load_demo(
    db: DbSession, project_id: str | None = None
) -> ScheduleImportResponse:
    """Загрузить эталонный демо-файл календарного плана 'Многоквартирный жилой дом'."""
    parsed_id = _parse_uuid(project_id)
    engine = ScheduleEngine(db)
    stages = engine.load_demo_schedule(parsed_id)
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
    file: UploadFile = File(...),
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
    parsed_id = _parse_uuid(project_id)
    engine = ScheduleEngine(db)
    try:
        stages = engine.import_schedule_bytes(content, file.filename, parsed_id)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Ошибка разбора файла графика: {e}")

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
) -> StageItem:
    """Обновить параметры этапа (название, даты, длительность) при ручном редактировании или drag-and-drop."""
    target_uuid = None
    try:
        target_uuid = uuid.UUID(stage_id)
    except ValueError:
        pass

    stage = db.get(ScheduleTask, target_uuid) if target_uuid else None
    if not stage:
        idx_match = re.search(r"\d+", stage_id)
        if idx_match:
            target_idx = int(idx_match.group())
            all_stages = db.scalars(
                select(ScheduleTask).where(ScheduleTask.order_index == target_idx)
            ).all()
            if all_stages:
                stage = all_stages[0]

    if not stage:
        raise HTTPException(status_code=404, detail="Этап не найден")

    if payload.name is not None:
        stage.name = payload.name
    if payload.planned_start is not None:
        stage.planned_start = payload.planned_start
    if payload.planned_end is not None:
        stage.planned_end = payload.planned_end
    if payload.duration_days is not None:
        stage.duration_days = payload.duration_days

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
) -> CascadeShiftResponse:
    """Сдвинуть все последующие этапы на N дней при отставании текущего этапа."""
    engine = ScheduleEngine(db)
    try:
        return engine.cascade_shift(payload.delayed_stage_id, payload.delay_days)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


def _find_stage(stage_id: str, db: DbSession) -> ScheduleTask | None:
    target_uuid = None
    try:
        target_uuid = uuid.UUID(stage_id)
    except ValueError:
        pass

    stage = db.get(ScheduleTask, target_uuid) if target_uuid else None
    if not stage:
        idx_match = re.search(r"\d+", stage_id)
        if idx_match:
            target_idx = int(idx_match.group())
            all_stages = db.scalars(
                select(ScheduleTask).where(ScheduleTask.order_index == target_idx)
            ).all()
            if all_stages:
                stage = all_stages[0]
    return stage


def _build_stage_probability_response(stage: ScheduleTask | None) -> StageProbabilityResponse:
    matcher = StageMachineryService()
    stage_name = stage.name if stage else "Общестроительные работы"
    prob_profile = matcher.estimate_machinery_probabilities(stage_name)
    overrides = (stage.machinery_probabilities or {}) if stage else {}

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
    for cls_id, (raw_label, label_ru, code) in MACHINERY_CLASSES.items():
        override_val = overrides.get(code) or overrides.get(raw_label) or overrides.get(label_ru)
        if override_val is not None:
            if isinstance(override_val, str) and override_val.strip().upper() in status_to_prob:
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
            )
        )

    # Sort items by probability descending
    items.sort(key=lambda x: x.probability, reverse=True)
    top_machinery = [it.machinery_name_ru for it in items if it.probability >= 0.6]

    return StageProbabilityResponse(
        stage_id=stage.id if stage else uuid.uuid4(),
        stage_name=stage.name if stage else stage_name,
        matched_catalog_stage=stage.matched_catalog_name if stage else "Общестроительные работы",
        similarity_confidence=stage.catalog_similarity if (stage and stage.catalog_similarity is not None) else 0.95,
        probabilities=items,
        top_machinery=top_machinery,
        has_custom_override=bool(overrides and len(overrides) > 0),
    )


@router.get("/stages/{stage_id}/probabilities", response_model=StageProbabilityResponse)
def get_stage_probabilities(
    stage_id: str, db: DbSession
) -> StageProbabilityResponse:
    """Получить распределение вероятностей техники для детального экрана этапа."""
    stage = _find_stage(stage_id, db)
    if not stage:
        stage = db.scalars(select(ScheduleTask).order_by(ScheduleTask.order_index)).first()
    return _build_stage_probability_response(stage)


@router.put("/stages/{stage_id}/probabilities", response_model=StageProbabilityResponse)
def update_stage_probabilities(
    stage_id: str,
    payload: StageMachineryOverrideRequest,
    db: DbSession,
) -> StageProbabilityResponse:
    """Ручная настройка статуса/вероятности техники на этапе."""
    stage = _find_stage(stage_id, db)
    if not stage:
        stage = db.scalars(select(ScheduleTask).order_by(ScheduleTask.order_index)).first()
    if not stage:
        raise HTTPException(status_code=404, detail="Этап не найден")

    current_overrides = dict(stage.machinery_probabilities or {})
    current_overrides.update(payload.overrides)
    stage.machinery_probabilities = current_overrides
    db.commit()
    db.refresh(stage)
    return _build_stage_probability_response(stage)


@router.delete("/stages/{stage_id}/probabilities", response_model=StageProbabilityResponse)
def reset_stage_probabilities(
    stage_id: str,
    db: DbSession,
) -> StageProbabilityResponse:
    """Сбросить ручные настройки техники к расчётам по справочнику/AI."""
    stage = _find_stage(stage_id, db)
    if not stage:
        stage = db.scalars(select(ScheduleTask).order_by(ScheduleTask.order_index)).first()
    if not stage:
        raise HTTPException(status_code=404, detail="Этап не найден")

    stage.machinery_probabilities = {}
    db.commit()
    db.refresh(stage)
    return _build_stage_probability_response(stage)
