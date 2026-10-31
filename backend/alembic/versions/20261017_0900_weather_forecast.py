"""Project coordinates and persisted seven-day weather forecast.

Revision ID: 20261017_0900
Revises: 20261016_1300
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20261017_0900"
down_revision: Union[str, None] = "20261016_1300"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("projects", sa.Column("latitude", sa.Float(), nullable=True))
    op.add_column("projects", sa.Column("longitude", sa.Float(), nullable=True))
    op.create_table(
        "weather_forecasts",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("forecast_date", sa.Date(), nullable=False),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("weather_code", sa.Integer(), nullable=True),
        sa.Column("temperature_min_c", sa.Float(), nullable=True),
        sa.Column("temperature_max_c", sa.Float(), nullable=True),
        sa.Column("precipitation_mm", sa.Float(), nullable=True),
        sa.Column("snowfall_cm", sa.Float(), nullable=True),
        sa.Column("wind_gust_kmh", sa.Float(), nullable=True),
        sa.Column("conditions", postgresql.JSONB(), nullable=False),
        sa.Column("warnings", postgresql.JSONB(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "forecast_date", name="uq_weather_project_date"),
    )
    op.create_index("ix_weather_forecasts_project_id", "weather_forecasts", ["project_id"])
    op.create_index("ix_weather_forecasts_forecast_date", "weather_forecasts", ["forecast_date"])


def downgrade() -> None:
    op.drop_index("ix_weather_forecasts_forecast_date", table_name="weather_forecasts")
    op.drop_index("ix_weather_forecasts_project_id", table_name="weather_forecasts")
    op.drop_table("weather_forecasts")
    op.drop_column("projects", "longitude")
    op.drop_column("projects", "latitude")
