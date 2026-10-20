"""Approved camera view, view proposals, planned camera moves and their history.

Revision ID: 20261018_1200
Revises: 20261019_1600
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20261018_1200"
down_revision: Union[str, None] = "20261019_1600"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

USER_COLUMNS = ("view_reference_by", "view_proposal_by", "view_move_by", "view_move_approved_by")


def upgrade() -> None:
    op.add_column("cameras", sa.Column("view_reference_key", sa.String(length=512), nullable=True))
    op.add_column("cameras", sa.Column("view_reference_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("cameras", sa.Column("view_reference_by", sa.UUID(), nullable=True))
    op.add_column("cameras", sa.Column("view_proposal_key", sa.String(length=512), nullable=True))
    op.add_column("cameras", sa.Column("view_proposal_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("cameras", sa.Column("view_proposal_by", sa.UUID(), nullable=True))
    op.add_column("cameras", sa.Column("view_proposal_note", sa.Text(), nullable=True))
    op.add_column("cameras", sa.Column("view_move_status", sa.String(length=16), nullable=True))
    op.add_column("cameras", sa.Column("view_move_until", sa.DateTime(timezone=True), nullable=True))
    op.add_column("cameras", sa.Column("view_move_reason", sa.Text(), nullable=True))
    op.add_column("cameras", sa.Column("view_move_by", sa.UUID(), nullable=True))
    op.add_column("cameras", sa.Column("view_move_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("cameras", sa.Column("view_move_approved_by", sa.UUID(), nullable=True))
    op.add_column("cameras", sa.Column("view_move_approved_at", sa.DateTime(timezone=True), nullable=True))
    for column in USER_COLUMNS:
        op.create_foreign_key(f"fk_cameras_{column}_users", "cameras", "users", [column], ["id"], ondelete="SET NULL")

    op.create_table(
        "camera_view_events",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("camera_id", sa.UUID(), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("snapshot_key", sa.String(length=512), nullable=True),
        sa.Column("until", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["camera_id"], ["cameras.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_camera_view_events_camera_id", "camera_view_events", ["camera_id"])


def downgrade() -> None:
    op.drop_index("ix_camera_view_events_camera_id", table_name="camera_view_events")
    op.drop_table("camera_view_events")
    for column in USER_COLUMNS:
        op.drop_constraint(f"fk_cameras_{column}_users", "cameras", type_="foreignkey")
    for column in (
        "view_move_approved_at", "view_move_approved_by", "view_move_at", "view_move_by",
        "view_move_reason", "view_move_until", "view_move_status", "view_proposal_note",
        "view_proposal_by", "view_proposal_at", "view_proposal_key", "view_reference_by",
        "view_reference_at", "view_reference_key",
    ):
        op.drop_column("cameras", column)
