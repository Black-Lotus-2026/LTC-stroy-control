"""Explicit demo manifest; unknown legacy demo uploads remain private.

No source is selected, deleted, moved, or published by this migration. A reviewed
manifest must be supplied separately through an authorized deployment workflow.
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "20261020_2000"
down_revision = "20261020_1900"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "projects", sa.Column("demo_manifest", postgresql.JSONB(), nullable=True)
    )


def downgrade():
    raise RuntimeError(
        "Demo manifests contain explicit publication decisions; use a compatible "
        "protected build or restore a verified backup without dropping source rows"
    )
