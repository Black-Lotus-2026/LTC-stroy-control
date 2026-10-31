"""Cache resolved weather address and rate-limit public geocoding requests.

Revision ID: 20261017_1000
Revises: 20261017_0900
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20261017_1000"
down_revision: Union[str, None] = "20261017_0900"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("projects", sa.Column("geocoded_address", sa.Text(), nullable=True))
    op.add_column("projects", sa.Column("weather_location_name", sa.Text(), nullable=True))
    op.create_table(
        "geocoding_throttle",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("last_requested_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.execute("INSERT INTO geocoding_throttle (id) VALUES (1)")


def downgrade() -> None:
    op.drop_table("geocoding_throttle")
    op.drop_column("projects", "weather_location_name")
    op.drop_column("projects", "geocoded_address")
