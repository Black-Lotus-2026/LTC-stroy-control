"""Page-grounded durable PPR analyses and verified requirements."""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "20261020_1500"
down_revision = "20261020_1400"
branch_labels = None
depends_on = None


def _common():
    return [
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
    ]


def _ref(name, table, nullable=False):
    return sa.Column(
        name,
        postgresql.UUID(as_uuid=True),
        sa.ForeignKey(table + ".id", ondelete="SET NULL" if nullable else "CASCADE"),
        nullable=nullable,
    )


def _string(name, length, nullable=False):
    return sa.Column(name, sa.String(length), nullable=nullable)


def upgrade():
    op.create_table(
        "ppr_analyses",
        *_common(),
        _ref("document_id", "ppr_documents"),
        _ref("project_id", "projects"),
        _string("document_sha256", 64),
        _string("status", 20),
        _string("error_code", 80, True),
        sa.Column("pages_total", sa.Integer(), nullable=False),
        sa.Column("pages_processed", sa.Integer(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        _string("provider", 50, True),
        _string("model", 128, True),
        _string("lease_token", 40, True),
        sa.Column("lease_updated_at", sa.DateTime(timezone=True), nullable=True),
        _string("rendered_pdf_key", 200, True),
        sa.UniqueConstraint("document_id", name="uq_ppr_analyses_document_id"),
    )
    for field in ("project_id", "status"):
        op.create_index("ix_ppr_analyses_" + field, "ppr_analyses", [field])
    op.create_table(
        "ppr_pages",
        *_common(),
        _ref("analysis_id", "ppr_analyses"),
        sa.Column("page_number", sa.Integer(), nullable=False),
        _string("status", 20),
        _string("error_code", 80, True),
        _string("extraction_method", 30),
        sa.Column("text", sa.Text(), nullable=False),
        _string("text_sha256", 64),
        _string("preview_key", 200, True),
        _string("preview_media_type", 100, True),
        sa.UniqueConstraint(
            "analysis_id", "page_number", name="uq_ppr_pages_analysis_id"
        ),
    )
    op.create_index("ix_ppr_pages_analysis_id", "ppr_pages", ["analysis_id"])
    op.create_table(
        "ppr_requirements",
        *_common(),
        _ref("analysis_id", "ppr_analyses"),
        _ref("project_id", "projects"),
        _ref("document_id", "ppr_documents"),
        _string("document_sha256", 64),
        sa.Column("page_number", sa.Integer(), nullable=False),
        _string("fingerprint", 64),
        _string("title", 500),
        _string("type", 40),
        _string("equipment_class", 80, True),
        sa.Column("scope_text", sa.Text(), nullable=False),
        sa.Column("quote", sa.Text(), nullable=False),
        sa.Column("quote_verified", sa.Boolean(), nullable=False),
        sa.Column("detector_supported", sa.Boolean(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        _string("applicability", 20),
        _string("stage_name", 500, True),
        _ref("stage_id", "schedule_tasks", True),
        _string("extraction_method", 30),
        sa.Column("human_confirmed", sa.Boolean(), nullable=False),
        sa.Column("activated_at", sa.DateTime(timezone=True), nullable=True),
        _string("reviewed_by", 128, True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint(
            "analysis_id", "fingerprint", name="uq_ppr_requirements_analysis_id"
        ),
    )
    for field in ("analysis_id", "project_id", "document_id"):
        op.create_index("ix_ppr_requirements_" + field, "ppr_requirements", [field])


def downgrade():
    op.drop_table("ppr_requirements")
    op.drop_table("ppr_pages")
    op.drop_table("ppr_analyses")
