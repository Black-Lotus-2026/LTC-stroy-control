"""Safety request boundary. Polygons use fixed-camera normalized frame coordinates."""

from __future__ import annotations

import math
import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.services.trained_taxonomy import SEMANTIC_NAMES

Scenario = Literal[
    "worker_danger_zone", "vehicle_blocks_passage", "vehicle_restricted_zone"
]


def cross(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


class ZoneInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    camera_id: uuid.UUID
    name: str = Field(min_length=1, max_length=128)
    scenario: Scenario
    polygon: list[tuple[float, float]] = Field(min_length=3, max_length=32)
    site_basis: str = Field(min_length=10, max_length=4000)
    responsible_user_id: uuid.UUID
    min_duration_seconds: float = Field(default=3, ge=1, le=300, allow_inf_nan=False)
    confidence_threshold: float = Field(default=0.5, ge=0.5, le=0.99, allow_inf_nan=False)
    allowed_classes: list[str] = Field(default_factory=list, max_length=24)
    enabled: bool = True

    @field_validator("name", "site_basis")
    @classmethod
    def nonblank(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("Не допускается пустое значение")
        return value

    @field_validator("allowed_classes")
    @classmethod
    def valid_classes(cls, values):
        if any(
            v not in SEMANTIC_NAMES or v in {"worker", "hanging_head", "grader"}
            for v in values
        ):
            raise ValueError("Нужны поддерживаемые классы техники")
        return sorted(set(values))

    @field_validator("polygon")
    @classmethod
    def valid_polygon(cls, points):
        if any(not math.isfinite(v) or not 0 <= v <= 1 for p in points for v in p):
            raise ValueError("Координаты должны быть в пределах 0..1")
        if len(set(points)) != len(points):
            raise ValueError("Вершины должны различаться")
        n = len(points)
        area = (
            abs(
                sum(
                    points[i][0] * points[(i + 1) % n][1]
                    - points[(i + 1) % n][0] * points[i][1]
                    for i in range(n)
                )
            )
            / 2
        )
        if area < 0.0001:
            raise ValueError("Площадь зоны слишком мала")
        for i in range(n):
            a, b = points[i], points[(i + 1) % n]
            for j in range(i + 1, n):
                if j == i or j == (i + 1) % n or (j + 1) % n == i:
                    continue
                c, d = points[j], points[(j + 1) % n]
                if (
                    max(min(a[0], b[0]), min(c[0], d[0]))
                    <= min(max(a[0], b[0]), max(c[0], d[0]))
                    and max(min(a[1], b[1]), min(c[1], d[1]))
                    <= min(max(a[1], b[1]), max(c[1], d[1]))
                    and cross(a, b, c) * cross(a, b, d) <= 0
                    and cross(c, d, a) * cross(c, d, b) <= 0
                ):
                    raise ValueError("Контур не должен пересекать себя")
        return points

    @model_validator(mode="after")
    def basis_length(self):
        if len(self.site_basis) < 10:
            raise ValueError("Укажите документ площадки и основание зоны")
        return self


class ReviewInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    decision: Literal["confirmed", "rejected"]
    comment: str = Field(min_length=5, max_length=4000)

    @field_validator("comment")
    @classmethod
    def meaningful(cls, value):
        if len(value.strip()) < 5:
            raise ValueError("Нужно обоснование решения")
        return value.strip()
