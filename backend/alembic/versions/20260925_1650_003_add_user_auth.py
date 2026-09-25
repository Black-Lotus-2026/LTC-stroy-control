"""003-add-user-auth migration

Revision ID: 20260925_1650
Revises: 20260924_1200
Create Date: 2026-09-25 16:50:00.000000+00:00
"""

from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "20260925_1650"
down_revision: Union[str, None] = "20260924_1200"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("username", sa.String(length=64), nullable=True))
    op.add_column("users", sa.Column("hashed_password", sa.String(length=256), nullable=True))
    op.create_index("ix_users_username", "users", ["username"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_users_username", table_name="users")
    op.drop_column("users", "hashed_password")
    op.drop_column("users", "username")
