"""Protected PPR library response contracts."""

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict


class PprDocumentItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    project_id: uuid.UUID
    filename: str
    media_type: str
    size_bytes: int
    sha256: str
    uploaded_by: str
    created_at: datetime
    preview_kind: Literal["pdf", "image", "text"]
    series_id: uuid.UUID | None = None
    version_no: int = 1
    supersedes_id: uuid.UUID | None = None
    area_id: uuid.UUID | None = None
    owner_participation_id: uuid.UUID | None = None


class PprDocumentDetail(PprDocumentItem):
    display_text: str | None = None


class PprRequirementItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    analysis_id: uuid.UUID
    project_id: uuid.UUID
    document_id: uuid.UUID
    document_sha256: str
    page_number: int
    title: str
    type: str
    equipment_class: str | None
    scope_text: str
    quote: str
    quote_verified: bool
    detector_supported: bool
    active: bool
    applicability: Literal["project", "stage", "manual"]
    stage_name: str | None
    stage_id: uuid.UUID | None
    extraction_method: str
    human_confirmed: bool
    activated_at: datetime | None
    reviewed_by: str | None
    reviewed_at: datetime | None


class PprRequirementUpdate(BaseModel):
    active: bool
    applicability: Literal["project", "stage"] = "project"
    stage_id: uuid.UUID | None = None
    human_confirmed: bool = False


class PprPageItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    page_number: int
    status: str
    error_code: str | None
    extraction_method: str
    text_sha256: str
    preview_available: bool


class PprPageDetail(PprPageItem):
    text: str
    document_sha256: str


class PprAnalysisDetail(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    document_id: uuid.UUID
    document_sha256: str
    status: str
    error_code: str | None
    pages_total: int
    pages_processed: int
    attempts: int
    provider: str | None
    model: str | None
    updated_at: datetime
    pages: list[PprPageItem]
    requirements: list[PprRequirementItem]
