"""Merge report-agent and platform migration branches.

Revision ID: 20261016_1200
Revises: 7f4a2b9c1d20, 20260928_2230
"""

from typing import Sequence, Union

revision: str = "20261016_1200"
down_revision: Union[str, Sequence[str], None] = (
    "7f4a2b9c1d20",
    "20260928_2230",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
