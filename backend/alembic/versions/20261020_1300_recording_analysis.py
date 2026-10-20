"""Durable saved-recording analysis queue and completion state."""

import sqlalchemy as sa

from alembic import op

revision = "20261020_1300"
down_revision = "20261019_1600"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "video_assets",
        sa.Column(
            "analysis_status", sa.String(32), server_default="PENDING", nullable=False
        ),
    )
    op.add_column("video_assets", sa.Column("analysis_error", sa.Text(), nullable=True))
    op.add_column(
        "video_assets",
        sa.Column("analyzed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "video_assets",
        sa.Column("analysis_updated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_video_assets_analysis_status", "video_assets", ["analysis_status"]
    )


def downgrade():
    op.drop_index("ix_video_assets_analysis_status", table_name="video_assets")
    for name in (
        "analysis_updated_at",
        "analyzed_at",
        "analysis_error",
        "analysis_status",
    ):
        op.drop_column("video_assets", name)
