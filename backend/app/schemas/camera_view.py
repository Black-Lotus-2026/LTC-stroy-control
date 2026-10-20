"""Схемы ракурса камеры: эталон, предложение, перенос и история."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class ViewPhoto(BaseModel):
    url: str
    at: datetime | None = None
    by: str | None = None
    by_id: uuid.UUID | None = None
    note: str | None = None


class ViewMove(BaseModel):
    status: Literal["requested", "approved"]
    until: datetime
    reason: str
    by: str | None = None
    by_id: uuid.UUID | None = None
    at: datetime | None = None
    approved_by: str | None = None
    approved_at: datetime | None = None


class ViewHistoryItem(BaseModel):
    kind: str
    at: datetime
    by: str | None = None
    note: str | None = None
    url: str | None = None
    until: datetime | None = None


class CameraViewState(BaseModel):
    camera_id: uuid.UUID
    camera_name: str
    reference: ViewPhoto | None = None
    proposal: ViewPhoto | None = None
    move: ViewMove | None = None
    history: list[ViewHistoryItem] = Field(default_factory=list)
    match_ok: float
    match_bad: float


class ViewReferenceRequest(BaseModel):
    snapshot_base64: str = Field(..., min_length=16, max_length=6_000_000)
    note: str | None = Field(None, max_length=500)


class ViewMoveRequest(BaseModel):
    until: datetime
    reason: str = Field(..., min_length=3, max_length=500)


class ViewNote(BaseModel):
    note: str | None = Field(None, max_length=500)
