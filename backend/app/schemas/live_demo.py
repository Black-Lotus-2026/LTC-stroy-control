"""Ephemeral live-demo responses share the established detection contract."""

from typing import Annotated, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

from app.schemas.stroy_control import FrameDetectionResponse

Channel = Annotated[int, Field(ge=0, le=1023)]


class LiveDemoCameraDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    channel: Channel
    name: str = Field(min_length=1, max_length=128)


class LiveDemoConfigDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool
    cameras: list[LiveDemoCameraDTO] = Field(max_length=1024)
    analysis_interval_ms: int = Field(ge=2000, le=60000)


class LiveDemoObservationDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    channel: Channel
    captured_at: AwareDatetime
    frame: str = Field(pattern=r"^data:image/jpeg;base64,[A-Za-z0-9+/]+={0,2}$")
    analysis: FrameDetectionResponse | None
    analysis_error: str | None
    inference_ms: int = Field(ge=0)


class LiveDemoSessionDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    media_url: str = Field(
        pattern=(
            r"^/[^\s?#]+/live-demo/[0-9]{1,4}/stream\?project_id="
            r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
            r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
        )
    )
    expires_in: Literal[300]
