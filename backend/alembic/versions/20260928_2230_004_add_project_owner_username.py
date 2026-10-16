"""004-add-project-owner-username migration

Revision ID: 20260928_2230
Revises: 20260925_1650
Create Date: 2026-09-28 22:30:00.000000+00:00
"""

from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "20260928_2230"
down_revision: Union[str, None] = "20260925_1650"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("projects", sa.Column("owner_username", sa.String(length=64), nullable=True))
    op.create_index("ix_projects_owner_username", "projects", ["owner_username"])


def downgrade() -> None:
    op.drop_index("ix_projects_owner_username", table_name="projects")
    op.drop_column("projects", "owner_username")
