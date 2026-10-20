"""Private project documents and searchable text fragments.

Revision ID: 20261018_1100
Revises: 20261017_1000
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "20261018_1100"
down_revision = "20261017_1000"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "project_documents",
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
        sa.Column("kind", sa.String(3), nullable=False),
        sa.Column("filename", sa.String(255), nullable=False),
        sa.Column("content_type", sa.String(128), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("content", sa.LargeBinary(), nullable=False),
        sa.UniqueConstraint(
            "project_id", "sha256", "kind", name="uq_document_project_hash_kind"
        ),
    )
    op.create_index(
        "ix_project_documents_project_id", "project_documents", ["project_id"]
    )
    op.create_table(
        "document_chunks",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "document_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("project_documents.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("locator", sa.String(128), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.UniqueConstraint("document_id", "ordinal", name="uq_document_chunk_ordinal"),
    )
    op.create_index("ix_document_chunks_document_id", "document_chunks", ["document_id"])


def downgrade() -> None:
    op.drop_table("document_chunks")
    op.drop_table("project_documents")
