"""Typed saved-source analysis, including observations without case attribution."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

Sha256 = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]


class TechnicalObservationDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: Literal["missing_responsibility_area"]
    video_id: UUID
    observed_from: AwareDatetime
    observed_until: AwareDatetime
    first_offset_seconds: float = Field(ge=0)
    last_offset_seconds: float = Field(ge=0)
    source_sha256: Sha256 | None
    model_sha256: Sha256 | None
    machinery_name: str = Field(min_length=1, max_length=128)
    discrepancy_type: Literal[
        "MISSING_MANDATORY", "MISSING_RECOMMENDED", "UNCHARACTERISTIC_PRESENT"
    ]
    limitation: str = Field(min_length=1, max_length=512)


class RecordingAnalysisResultDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    video_id: UUID
    status: Literal["complete", "partial", "disabled"]
    reason: Literal["project_read_only"] | None = None
    samples: int = Field(ge=0)
    failed_samples: int = Field(ge=0)
    insufficient_samples: int = Field(ge=0)
    created: int = Field(ge=0)
    incident_ids: list[UUID]
    analyzed_until_seconds: float = Field(ge=0)
    duration_seconds: float | None = Field(default=None, ge=0)
    prefix_only: bool
    technical_observations: list[TechnicalObservationDTO] = Field(default_factory=list)


class SavedRecordingDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    video_id: UUID
    camera_id: UUID | None
    filename: str
    start_timestamp: AwareDatetime
    duration_seconds: float = Field(ge=0)
    media_url: str
    analysis_status: Literal["PENDING", "QUEUED", "RUNNING", "COMPLETED", "FAILED"]
    analysis_error: str | None
    analyzed_at: AwareDatetime | None
    analysis_result: RecordingAnalysisResultDTO | None = None


class PlaybackSessionDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    media_url: str
    expires_at: AwareDatetime


class PlaybackClaims(BaseModel):
    model_config = ConfigDict(extra="forbid")

    purpose: Literal["video_playback"]
    aud: Literal["video-media"]
    sub: str
    user_id: UUID
    assignment_id: UUID | None
    project_id: UUID
    video_id: UUID
    request_key: UUID
    exp: int
    iat: int
