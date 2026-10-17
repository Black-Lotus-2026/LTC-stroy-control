"""Журнал наблюдений, отчёты и расписания

Revision ID: 7f4a2b9c1d20
Revises: 18e5ce302b0c
Create Date: 2026-09-17 10:30:00+00:00
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "7f4a2b9c1d20"
down_revision: Union[str, None] = "18e5ce302b0c"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "observation_logs",
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("zone_id", sa.UUID(), nullable=True),
        sa.Column("camera_id", sa.UUID(), nullable=True),
        sa.Column(
            "source",
            sa.Enum(
                "cctv",
                "cv",
                "vlc",
                "manual",
                "system",
                name="observationsource",
                native_enum=False,
                length=32,
            ),
            nullable=False,
        ),
        sa.Column(
            "category",
            sa.Enum(
                "safety",
                "ppe",
                "equipment",
                "camera",
                "progress",
                "data",
                "system",
                name="observationcategory",
                native_enum=False,
                length=32,
            ),
            nullable=False,
        ),
        sa.Column("event_type", sa.String(length=64), nullable=False),
        sa.Column(
            "severity",
            sa.Enum(
                "info",
                "warning",
                "critical",
                name="observationseverity",
                native_enum=False,
                length=32,
            ),
            nullable=False,
        ),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("title", sa.String(length=256), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "payload",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.ForeignKeyConstraint(
            ["camera_id"],
            ["cameras.id"],
            name=op.f("fk_observation_logs_camera_id_cameras"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["projects.id"],
            name=op.f("fk_observation_logs_project_id_projects"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["zone_id"],
            ["zones.id"],
            name=op.f("fk_observation_logs_zone_id_zones"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_observation_logs")),
    )
    op.create_index(
        op.f("ix_observation_logs_category"),
        "observation_logs",
        ["category"],
        unique=False,
    )
    op.create_index(
        op.f("ix_observation_logs_event_type"),
        "observation_logs",
        ["event_type"],
        unique=False,
    )
    op.create_index(
        op.f("ix_observation_logs_occurred_at"),
        "observation_logs",
        ["occurred_at"],
        unique=False,
    )
    op.create_index(
        op.f("ix_observation_logs_project_id"),
        "observation_logs",
        ["project_id"],
        unique=False,
    )
    op.create_index(
        "ix_observation_logs_project_category",
        "observation_logs",
        ["project_id", "category"],
        unique=False,
    )
    op.create_index(
        "ix_observation_logs_project_occurred",
        "observation_logs",
        ["project_id", "occurred_at"],
        unique=False,
    )

    op.create_table(
        "report_schedules",
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column(
            "frequency",
            sa.Enum(
                "hourly",
                "daily",
                "weekly",
                name="reportschedulefrequency",
                native_enum=False,
                length=32,
            ),
            nullable=False,
        ),
        sa.Column(
            "report_period",
            sa.Enum(
                "hour",
                "day",
                "week",
                "custom",
                name="reportperiod",
                native_enum=False,
                length=32,
            ),
            nullable=False,
        ),
        sa.Column("timezone", sa.String(length=64), nullable=False),
        sa.Column("run_at_local", sa.Time(), nullable=False),
        sa.Column("weekday", sa.Integer(), nullable=True),
        sa.Column("enabled", sa.Boolean(), server_default="true", nullable=False),
        sa.Column("next_run_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["projects.id"],
            name=op.f("fk_report_schedules_project_id_projects"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_report_schedules")),
    )
    op.create_index(
        "ix_report_schedules_due",
        "report_schedules",
        ["enabled", "next_run_at"],
        unique=False,
    )
    op.create_index(
        op.f("ix_report_schedules_next_run_at"),
        "report_schedules",
        ["next_run_at"],
        unique=False,
    )
    op.create_index(
        op.f("ix_report_schedules_project_id"),
        "report_schedules",
        ["project_id"],
        unique=False,
    )

    op.create_table(
        "generated_reports",
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("schedule_id", sa.UUID(), nullable=True),
        sa.Column("requested_by_user_id", sa.UUID(), nullable=True),
        sa.Column(
            "period",
            sa.Enum(
                "hour",
                "day",
                "week",
                "custom",
                name="reportperiod",
                native_enum=False,
                length=32,
            ),
            nullable=False,
        ),
        sa.Column("range_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("range_end", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "status",
            sa.Enum(
                "pending",
                "generating",
                "completed",
                "failed",
                name="reportstatus",
                native_enum=False,
                length=32,
            ),
            nullable=False,
        ),
        sa.Column("agent_name", sa.String(length=64), nullable=False),
        sa.Column("agent_version", sa.String(length=32), nullable=False),
        sa.Column("title", sa.String(length=256), nullable=False),
        sa.Column("executive_summary", sa.Text(), nullable=True),
        sa.Column(
            "content",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column("source_log_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["projects.id"],
            name=op.f("fk_generated_reports_project_id_projects"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["requested_by_user_id"],
            ["users.id"],
            name=op.f("fk_generated_reports_requested_by_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["schedule_id"],
            ["report_schedules.id"],
            name=op.f("fk_generated_reports_schedule_id_report_schedules"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_generated_reports")),
    )
    op.create_index(
        "ix_generated_reports_project_range",
        "generated_reports",
        ["project_id", "range_end"],
        unique=False,
    )
    op.create_index(
        op.f("ix_generated_reports_project_id"),
        "generated_reports",
        ["project_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_generated_reports_range_end"),
        "generated_reports",
        ["range_end"],
        unique=False,
    )
    op.create_index(
        op.f("ix_generated_reports_range_start"),
        "generated_reports",
        ["range_start"],
        unique=False,
    )
    op.create_index(
        op.f("ix_generated_reports_status"),
        "generated_reports",
        ["status"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_table("generated_reports")
    op.drop_table("report_schedules")
    op.drop_table("observation_logs")
