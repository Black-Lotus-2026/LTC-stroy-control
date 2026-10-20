"""Persist plan-wide document agent runs and rule provenance.

Revision ID: 20261020_1000
Revises: 20261020_0900
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "20261020_1000"
down_revision = "20261020_0900"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "schedule_tasks",
        sa.Column(
            "machinery_rule_sources",
            postgresql.JSONB(),
            server_default="{}",
            nullable=False,
        ),
    )
    op.create_table(
        "document_analysis_runs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("stage_count", sa.Integer(), nullable=False),
        sa.Column("completed_count", sa.Integer(), nullable=False),
        sa.Column("snapshot", postgresql.JSONB(), nullable=False),
        sa.Column("result", postgresql.JSONB(), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_document_analysis_runs_project_id", "document_analysis_runs", ["project_id"]
    )
    op.create_index(
        "ix_document_analysis_runs_status", "document_analysis_runs", ["status"]
    )


def downgrade() -> None:
    op.drop_index("ix_document_analysis_runs_status", table_name="document_analysis_runs")
    op.drop_index(
        "ix_document_analysis_runs_project_id", table_name="document_analysis_runs"
    )
    op.drop_table("document_analysis_runs")
    op.drop_column("schedule_tasks", "machinery_rule_sources")
