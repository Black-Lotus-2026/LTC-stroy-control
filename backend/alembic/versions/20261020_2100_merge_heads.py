"""Merge document agent and demo manifest migration branches.

Revision ID: 20261020_2100
Revises: 20261020_1100, 20261020_2000
Create Date: 2026-10-20 23:10:00.000000
"""

from typing import Sequence, Union


# revision identifiers, used by Alembic.
revision: str = "20261020_2100"
down_revision: Union[str, Sequence[str], None] = ("20261020_1100", "20261020_2000")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
