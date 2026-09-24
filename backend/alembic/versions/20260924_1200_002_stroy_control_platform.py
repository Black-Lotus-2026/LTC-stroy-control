"""002-stroy-control-platform migration

Revision ID: 20260924_1200
Revises: 18e5ce302b0c
Create Date: 2026-09-24 12:00:00.000000+00:00
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "20260924_1200"
down_revision: Union[str, None] = "18e5ce302b0c"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Extend schedule_tasks
    op.add_column("schedule_tasks", sa.Column("order_index", sa.Integer(), server_default="0", nullable=False))
    op.add_column("schedule_tasks", sa.Column("duration_days", sa.Integer(), server_default="1", nullable=False))
    op.add_column("schedule_tasks", sa.Column("matched_catalog_name", sa.String(length=512), nullable=True))
    op.add_column("schedule_tasks", sa.Column("catalog_similarity", sa.Float(), nullable=True))
    op.add_column(
        "schedule_tasks",
        sa.Column(
            "machinery_probabilities",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
    )
    op.create_index("ix_schedule_tasks_order_index", "schedule_tasks", ["order_index"])

    # 2. Extend incidents
    op.add_column("incidents", sa.Column("discrepancy_type", sa.String(length=64), nullable=True))
    op.add_column("incidents", sa.Column("machinery_type", sa.String(length=64), nullable=True))
    op.add_column("incidents", sa.Column("stage_probability", sa.Float(), nullable=True))
    op.add_column("incidents", sa.Column("is_vlm_verified", sa.Boolean(), server_default="false", nullable=False))
    op.add_column("incidents", sa.Column("vlm_summary", sa.String(length=512), nullable=True))

    # 3. Create video_assets
    op.create_table(
        "video_assets",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("camera_id", sa.UUID(), nullable=True),
        sa.Column("filename", sa.String(length=256), nullable=False),
        sa.Column("storage_key", sa.Text(), nullable=False),
        sa.Column("start_timestamp", sa.DateTime(timezone=True), nullable=False),
        sa.Column("duration_seconds", sa.Float(), server_default="0.0", nullable=False),
        sa.Column("fps", sa.Float(), server_default="25.0", nullable=False),
        sa.Column("frame_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("status", sa.String(length=32), server_default="UPLOADED", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["camera_id"], ["cameras.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_video_assets_project_id", "video_assets", ["project_id"])
    op.create_index("ix_video_assets_start_timestamp", "video_assets", ["start_timestamp"])

    # 4. Create vlm_verifications
    op.create_table(
        "vlm_verifications",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("incident_id", sa.UUID(), nullable=False),
        sa.Column("frame_id", sa.UUID(), nullable=True),
        sa.Column("prompt_sent", sa.Text(), server_default="", nullable=False),
        sa.Column("is_violation_confirmed", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("is_occluded", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("confidence", sa.Float(), server_default="0.0", nullable=False),
        sa.Column("reasoning", sa.Text(), server_default="", nullable=False),
        sa.Column("compact_alert_text", sa.String(length=512), server_default="", nullable=False),
        sa.Column("latency_ms", sa.Integer(), server_default="0", nullable=False),
        sa.Column("status", sa.String(length=32), server_default="COMPLETED", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["frame_id"], ["frames.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["incident_id"], ["incidents.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_vlm_verifications_incident_id", "vlm_verifications", ["incident_id"])


def downgrade() -> None:
    op.drop_table("vlm_verifications")
    op.drop_table("video_assets")

    op.drop_column("incidents", "vlm_summary")
    op.drop_column("incidents", "is_vlm_verified")
    op.drop_column("incidents", "stage_probability")
    op.drop_column("incidents", "machinery_type")
    op.drop_column("incidents", "discrepancy_type")

    op.drop_index("ix_schedule_tasks_order_index", table_name="schedule_tasks")
    op.drop_column("schedule_tasks", "machinery_probabilities")
    op.drop_column("schedule_tasks", "catalog_similarity")
    op.drop_column("schedule_tasks", "matched_catalog_name")
    op.drop_column("schedule_tasks", "duration_days")
    op.drop_column("schedule_tasks", "order_index")
