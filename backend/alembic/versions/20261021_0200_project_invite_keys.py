"""Create project invite keys table for automatic role-based project onboarding.

Revision ID: 20261021_0200
Revises: 20261020_2100
Create Date: 2026-10-21 02:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "20261021_0200"
down_revision: Union[str, Sequence[str], None] = "20261020_2100"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "project_invite_keys",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("key", sa.String(64), nullable=False),
        sa.Column("role", sa.String(32), nullable=False),
        sa.Column(
            "created_by_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("max_uses", sa.Integer(), nullable=True),
        sa.Column("uses_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp()"),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_project_invite_keys_project_id", "project_invite_keys", ["project_id"]
    )
    op.create_index(
        "ix_project_invite_keys_key", "project_invite_keys", ["key"], unique=True
    )


def downgrade() -> None:
    op.drop_index("ix_project_invite_keys_key", table_name="project_invite_keys")
    op.drop_index("ix_project_invite_keys_project_id", table_name="project_invite_keys")
    op.drop_table("project_invite_keys")
