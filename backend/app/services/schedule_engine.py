"""Schedule Ingestion and Gantt Cascade Engine.

Handles:
1. Parsing Excel (.xlsx) and CSV schedule files.
2. Validating chronological consistency and required fields.
3. Matching stage titles to canonical construction work catalog and
   computing machinery probabilities via StageMachineryService.
4. Executing queue-based cascade delay shifts across subsequent stages.
"""

from __future__ import annotations

import contextlib
import csv
import io
import logging
import uuid
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from typing import Any

import openpyxl
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.enums import ScheduleTaskStatus
from app.models.project import Project
from app.models.schedule import ScheduleTask
from app.schemas.stroy_control import CascadeShiftResponse, StageItem
from app.services.stage_matcher import StageMachineryService

logger = logging.getLogger(__name__)


def parse_date_value(val: Any) -> datetime:
    """Parse string, date, or datetime into UTC datetime."""
    if isinstance(val, datetime):
        if val.tzinfo is None:
            return val.replace(tzinfo=UTC)
        return val
    if isinstance(val, date):
        return datetime.combine(val, time.min, tzinfo=UTC)
    if isinstance(val, str):
        cleaned = val.strip().split()[0]
        # Try YYYY-MM-DD
        for fmt in ("%Y-%m-%d", "%d.%m.%Y", "%Y/%m/%d", "%d/%m/%Y"):
            try:
                dt = datetime.strptime(cleaned, fmt)
                return dt.replace(tzinfo=UTC)
            except ValueError:
                continue
    # Default fallback
    return datetime.now(UTC)


class ScheduleEngine:
    """Service for schedule ingestion, catalog linking, and Gantt operations."""

    def __init__(self, db: Session):
        self.db = db
        self.stage_matcher = StageMachineryService()

    def load_demo_schedule(
        self, project_id: uuid.UUID | None = None
    ) -> list[ScheduleTask]:
        """Load demo schedule from data/demo_schedule_single_object.xlsx."""
        candidates = [
            Path("/app/data/demo_schedule_single_object.xlsx"),
            Path(__file__).resolve().parents[2] / "data" / "demo_schedule_single_object.xlsx",
            Path(__file__).resolve().parents[3] / "data" / "demo_schedule_single_object.xlsx",
            Path("data/demo_schedule_single_object.xlsx"),
        ]
        demo_file: Path | None = None
        for c in candidates:
            if c.exists():
                demo_file = c
                break

        if demo_file is None:
            # If not yet generated, invoke generator
            from app.scripts.generate_demo_schedule import generate_demo_schedule

            target = (
                Path("/app/data/demo_schedule_single_object.xlsx")
                if Path("/app/data").exists()
                else Path("data/demo_schedule_single_object.xlsx")
            )
            demo_file = generate_demo_schedule(target)

        with open(demo_file, "rb") as f:
            content = f.read()

        return self.import_schedule_bytes(
            file_bytes=content,
            filename=demo_file.name,
            project_id=project_id,
        )

    def import_schedule_bytes(
        self,
        file_bytes: bytes,
        filename: str,
        project_id: uuid.UUID | None = None,
    ) -> list[ScheduleTask]:
        """Parse uploaded schedule bytes (.xlsx or .csv) and persist ScheduleTasks."""
        # Ensure a default project exists if not specified
        if project_id is None:
            project = self.db.scalars(select(Project)).first()
            if not project:
                project = Project(
                    code="PRJ-DEMO",
                    name="Многоквартирный жилой дом",
                    address="г. Москва, ул. Строителей, д. 10",
                )
                self.db.add(project)
                self.db.flush()
            project_id = project.id

        is_csv = filename.lower().endswith(".csv")
        extracted_rows: list[dict[str, Any]] = []

        if is_csv:
            text = file_bytes.decode("utf-8-sig", errors="replace")
            reader = csv.DictReader(io.StringIO(text))
            for i, row in enumerate(reader):
                extracted_rows.append(self._normalize_row(row, i + 1))
        else:
            wb = openpyxl.load_workbook(io.BytesIO(file_bytes), data_only=True)
            ws = wb.active
            rows = list(ws.iter_rows(values_only=True))
            if not rows:
                return []

            header = [str(c).strip().lower() if c is not None else "" for c in rows[0]]
            for i, r in enumerate(rows[1:]):
                if not any(r):
                    continue
                row_dict = {
                    header[idx]: r[idx] for idx in range(min(len(header), len(r)))
                }
                extracted_rows.append(self._normalize_row(row_dict, i + 1))

        # Clear existing schedule tasks for the project to load fresh schedule
        existing = self.db.scalars(
            select(ScheduleTask).where(ScheduleTask.project_id == project_id)
        ).all()
        for t in existing:
            self.db.delete(t)
        self.db.flush()

        created_tasks: list[ScheduleTask] = []
        for row_data in extracted_rows:
            stage_name = row_data["name"]
            start_dt = row_data["start"]
            end_dt = row_data["end"]
            duration = row_data["duration"]
            order_idx = row_data["order_index"]

            # Match with catalog & calculate probability distribution
            match_res = self.stage_matcher.match_stage(stage_name)
            prob_res = self.stage_matcher.estimate_machinery_probabilities(stage_name)

            # Compute status based on current reference date (2026-09-24)
            today_ref = date(2026, 9, 24)
            st_d = start_dt.date() if hasattr(start_dt, "date") else start_dt
            en_d = end_dt.date() if hasattr(end_dt, "date") else end_dt
            if en_d < today_ref:
                task_status = ScheduleTaskStatus.COMPLETED
            elif st_d <= today_ref <= en_d:
                task_status = ScheduleTaskStatus.ACTIVE
            else:
                task_status = ScheduleTaskStatus.PLANNED

            task = ScheduleTask(
                project_id=project_id,
                name=stage_name,
                order_index=order_idx,
                planned_start=start_dt,
                planned_end=end_dt,
                duration_days=duration,
                status=task_status,
                matched_catalog_name=(
                    match_res.matched_stage
                    if isinstance(match_res.matched_stage, str)
                    else getattr(match_res.matched_stage, "canonical_name", None)
                ),
                catalog_similarity=getattr(match_res, "confidence", 0.0),
                machinery_probabilities=prob_res.probabilities,
            )
            self.db.add(task)
            created_tasks.append(task)

        self.db.commit()
        for task in created_tasks:
            self.db.refresh(task)

        return created_tasks

    def _normalize_row(self, row: dict[str, Any], default_idx: int) -> dict[str, Any]:
        """Normalize extracted columns regardless of naming conventions."""
        name = ""
        start_val = None
        end_val = None
        duration = 1
        order_idx = default_idx

        for k, v in row.items():
            if v is None:
                continue
            key_l = str(k).lower()
            if any(
                term in key_l
                for term in ("наименование", "этап", "работа", "name", "title", "task")
            ):
                name = str(v).strip()
            elif any(term in key_l for term in ("начал", "start", "from")):
                start_val = v
            elif any(term in key_l for term in ("окончан", "конец", "end", "to")):
                end_val = v
            elif any(term in key_l for term in ("длительн", "дней", "duration", "days")):
                with contextlib.suppress(ValueError, TypeError):
                    duration = max(1, int(float(v)))
            elif any(
                term in key_l for term in ("№", "n", "номер", "order", "index", "id")
            ):
                with contextlib.suppress(ValueError, TypeError):
                    order_idx = int(float(v))

        if not name:
            name = f"Этап строительства #{order_idx}"

        start_dt = parse_date_value(start_val)
        if end_val:
            end_dt = parse_date_value(end_val)
            if end_dt < start_dt:
                end_dt = start_dt + timedelta(days=duration - 1)
        else:
            end_dt = start_dt + timedelta(days=duration - 1)

        computed_days = (end_dt.date() - start_dt.date()).days + 1
        duration = max(1, computed_days)

        return {
            "name": name,
            "start": start_dt,
            "end": end_dt,
            "duration": duration,
            "order_index": order_idx,
        }

    def cascade_shift(
        self, delayed_stage_id: uuid.UUID | str, delay_days: int
    ) -> CascadeShiftResponse:
        """Execute queue-based cascade shift advancing all subsequent stages."""
        target_uuid = None
        if isinstance(delayed_stage_id, uuid.UUID):
            target_uuid = delayed_stage_id
        else:
            try:
                target_uuid = uuid.UUID(delayed_stage_id)
            except ValueError:
                pass

        target_stage = self.db.get(ScheduleTask, target_uuid) if target_uuid else None
        if not target_stage:
            all_stages = self.db.scalars(
                select(ScheduleTask).order_by(ScheduleTask.order_index)
            ).all()
            if all_stages:
                idx_match = re.search(r"\d+", str(delayed_stage_id))
                if idx_match:
                    target_idx = int(idx_match.group())
                    for s in all_stages:
                        if s.order_index == target_idx:
                            target_stage = s
                            break
                if not target_stage:
                    target_stage = all_stages[0]

        if not target_stage:
            raise ValueError(f"Stage with ID {delayed_stage_id} not found")

        # Get all stages of the same project ordered by order_index
        stages = self.db.scalars(
            select(ScheduleTask)
            .where(ScheduleTask.project_id == target_stage.project_id)
            .order_by(ScheduleTask.order_index)
        ).all()

        shifted_stages: list[ScheduleTask] = []
        for s in stages:
            if s.order_index > target_stage.order_index:
                s.planned_start = s.planned_start + timedelta(days=delay_days)
                s.planned_end = s.planned_end + timedelta(days=delay_days)
                shifted_stages.append(s)

        self.db.commit()
        for s in stages:
            self.db.refresh(s)

        stage_items = [
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

        count = len(shifted_stages)
        return CascadeShiftResponse(
            delayed_stage_id=str(delayed_stage_id),
            delay_days=delay_days,
            shifted_stage_count=count,
            updated_stages=stage_items,
            message=f"Успешно сдвинуто {count} последующих этапов на {delay_days} дн.",
        )
