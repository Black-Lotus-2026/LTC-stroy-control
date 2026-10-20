"""Protected per-project original PPR library."""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "20261020_1400"
down_revision = "20261020_1300"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "ppr_documents",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("filename", sa.String(255), nullable=False),
        sa.Column("media_type", sa.String(100), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("storage_key", sa.String(200), nullable=False),
        sa.Column("uploaded_by", sa.String(128), nullable=False),
        sa.Column("preview_kind", sa.String(16), nullable=False),
        sa.Column("display_text", sa.Text(), nullable=True),
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
        sa.UniqueConstraint("project_id", "sha256", name="uq_ppr_documents_project_id"),
    )
    op.create_index("ix_ppr_documents_project_id", "ppr_documents", ["project_id"])


def downgrade():
    op.drop_index("ix_ppr_documents_project_id", table_name="ppr_documents")
    op.drop_table("ppr_documents")
