"""Persist technical recording observations and pin submitted source provenance.

Only additive DDL and guards. Existing business rows and media are retained.
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "20261020_1900"
down_revision = "20261020_1800"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "video_assets", sa.Column("analysis_result", postgresql.JSONB(), nullable=True)
    )
    op.execute("""
        CREATE FUNCTION customer_control_release_items_immutable() RETURNS trigger
        LANGUAGE plpgsql AS $$
        DECLARE release_row record; old_id uuid; new_id uuid;
        BEGIN
          IF TG_OP <> 'INSERT' THEN old_id := OLD.release_id; END IF;
          IF TG_OP <> 'DELETE' THEN new_id := NEW.release_id; END IF;
          FOR release_row IN
            SELECT id, status FROM control_releases
            WHERE id = old_id OR id = new_id ORDER BY id FOR UPDATE
          LOOP
            IF release_row.status <> 'draft' THEN
              RAISE EXCEPTION 'Submitted control-release manifest is immutable'
                USING ERRCODE='23514';
            END IF;
          END LOOP;
          IF TG_OP='DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END $$
    """)
    op.execute("""
        CREATE TRIGGER immutable_control_release_items
        BEFORE INSERT OR UPDATE OR DELETE ON control_release_items
        FOR EACH ROW EXECUTE FUNCTION customer_control_release_items_immutable()
    """)
    op.execute("""
        CREATE FUNCTION customer_control_release_manifest_immutable() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
          IF TG_OP='DELETE' THEN
            IF OLD.status <> 'draft' THEN
              RAISE EXCEPTION 'Submitted control release is immutable'
                USING ERRCODE='23514';
            END IF;
            RETURN OLD;
          END IF;
          IF OLD.status <> 'draft' AND ROW(
            NEW.project_id, NEW.sequence, NEW.base_release_id, NEW.submitted_by,
            NEW.submitted_assignment_id, NEW.manifest_sha256, NEW.limitations
          ) IS DISTINCT FROM ROW(
            OLD.project_id, OLD.sequence, OLD.base_release_id, OLD.submitted_by,
            OLD.submitted_assignment_id, OLD.manifest_sha256, OLD.limitations
          ) THEN
            RAISE EXCEPTION 'Submitted control-release provenance is immutable'
              USING ERRCODE='23514';
          END IF;
          IF OLD.status <> 'draft' AND NEW.status='draft' THEN
            RAISE EXCEPTION 'Submitted control release cannot return to draft'
              USING ERRCODE='23514';
          END IF;
          RETURN NEW;
        END $$
    """)
    op.execute("""
        CREATE TRIGGER immutable_control_release_manifest
        BEFORE UPDATE OR DELETE ON control_releases
        FOR EACH ROW EXECUTE FUNCTION customer_control_release_manifest_immutable()
    """)
    op.execute("""
        CREATE FUNCTION customer_control_document_original_immutable() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
          IF ROW(NEW.project_id, NEW.sha256, NEW.storage_key,
                 NEW.series_id, NEW.version_no, NEW.supersedes_id)
             IS DISTINCT FROM
             ROW(OLD.project_id, OLD.sha256, OLD.storage_key,
                 OLD.series_id, OLD.version_no, OLD.supersedes_id) THEN
            RAISE EXCEPTION 'Original document provenance is immutable'
              USING ERRCODE='23514';
          END IF;
          RETURN NEW;
        END $$
    """)
    op.execute("""
        CREATE TRIGGER immutable_document_original BEFORE UPDATE ON ppr_documents
        FOR EACH ROW EXECUTE FUNCTION customer_control_document_original_immutable()
    """)
    op.execute("""
        CREATE FUNCTION customer_control_completed_page_immutable() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
          IF OLD.status='COMPLETED' THEN
            IF TG_OP='DELETE' THEN
              RAISE EXCEPTION 'Completed document page is immutable'
                USING ERRCODE='23514';
            END IF;
            IF ROW(NEW.analysis_id, NEW.page_number, NEW.status, NEW.text,
                   NEW.text_sha256, NEW.preview_key, NEW.preview_media_type,
                   NEW.extraction_method, NEW.error_code)
               IS DISTINCT FROM
               ROW(OLD.analysis_id, OLD.page_number, OLD.status, OLD.text,
                   OLD.text_sha256, OLD.preview_key, OLD.preview_media_type,
                   OLD.extraction_method, OLD.error_code)
               OR (OLD.artifact_sha256 IS NOT NULL AND
                   NEW.artifact_sha256 IS DISTINCT FROM OLD.artifact_sha256) THEN
              RAISE EXCEPTION 'Completed document page provenance is immutable'
                USING ERRCODE='23514';
            END IF;
          END IF;
          IF TG_OP='DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END $$
    """)
    op.execute("""
        CREATE TRIGGER immutable_completed_ppr_page
        BEFORE UPDATE OR DELETE ON ppr_pages
        FOR EACH ROW EXECUTE FUNCTION customer_control_completed_page_immutable()
    """)


def downgrade():
    raise RuntimeError(
        "R1 contains immutable source provenance; use a compatible rollback build "
        "or restore a verified backup instead of dropping business history"
    )
