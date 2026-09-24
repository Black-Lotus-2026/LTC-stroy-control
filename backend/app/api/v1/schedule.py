"""API endpoints for Schedule and Gantt Management."""

from __future__ import annotations

import re
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
    StageProbabilityResponse,
    StageUpdateRequest,
)
from app.services.detector import MACHINERY_CLASSES
from app.services.schedule_engine import ScheduleEngine
from app.services.stage_matcher import StageMachineryService

router = APIRouter(prefix="/schedule", tags=["Календарный план"])


@router.get("/stages", response_model=list[StageItem])
def get_stages(db: DbSession, project_id: uuid.UUID | None = None) -> list[StageItem]:
    """Получить список этапов СМР для отображения на диаграмме Ганта."""
    query = select(ScheduleTask).order_by(ScheduleTask.order_index)
    if project_id:
        query = query.where(ScheduleTask.project_id == project_id)

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
def clear_stages(db: DbSession, project_id: uuid.UUID | None = None) -> dict[str, Any]:
    """Очистить календарный план (все этапы или конкретного объекта)."""
    from sqlalchemy import delete

    stmt = delete(ScheduleTask)
    if project_id:
        stmt = stmt.where(ScheduleTask.project_id == project_id)
    res = db.execute(stmt)
    db.commit()
    return {"message": "Календарный план успешно очищен", "deleted_count": res.rowcount}


@router.post("/load-demo", response_model=ScheduleImportResponse)
def load_demo(
    db: DbSession, project_id: uuid.UUID | None = None
) -> ScheduleImportResponse:
    """Загрузить эталонный демо-файл календарного плана 'Многоквартирный жилой дом'."""
    engine = ScheduleEngine(db)
    stages = engine.load_demo_schedule(project_id)
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
        project_id=stages[0].project_id if stages else uuid.uuid4(),
        total_stages_imported=len(stages),
        matched_catalog_count=sum(1 for s in stages if s.matched_catalog_name),
        stages=items,
    )


@router.post("/upload", response_model=ScheduleImportResponse)
async def upload_schedule(
    db: DbSession,
    file: UploadFile = File(...),
    project_id: uuid.UUID | None = None,
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
    engine = ScheduleEngine(db)
    try:
        stages = engine.import_schedule_bytes(content, file.filename, project_id)
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
        project_id=stages[0].project_id if stages else uuid.uuid4(),
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


@router.get("/stages/{stage_id}/probabilities", response_model=StageProbabilityResponse)
def get_stage_probabilities(
    stage_id: str, db: DbSession
) -> StageProbabilityResponse:
    """Получить распределение вероятностей техники для детального экрана этапа."""
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

    matcher = StageMachineryService()
    stage_name = stage.name if stage else "Общестроительные работы"
    prob_profile = matcher.estimate_machinery_probabilities(stage_name)

    items: list[MachineryProbabilityItem] = []
    # Map all 10 specialized classes
    for cls_id, (raw_label, label_ru, code) in MACHINERY_CLASSES.items():
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
    )
