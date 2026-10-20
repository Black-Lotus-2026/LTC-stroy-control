"""Append-only observations, document comments, deadline policy and scoped reports.

This revision only expands the schema. Existing reports and business sources keep
their IDs and bytes. Roll back with a compatible protected build or verified backup.
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "20261020_1800"
down_revision = "20261020_1700"
branch_labels = None
depends_on = None


def _foreign_key(column, table):
    return sa.ForeignKeyConstraint(
        [column],
        [f"{table}.id"],
        ondelete="RESTRICT",
    )


def upgrade():
    # Keep table-specific record access inside its own branch: PostgreSQL must
    # never resolve OLD.submitted for append tables without that column.
    op.execute("""
        CREATE OR REPLACE FUNCTION customer_control_immutable() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
          IF TG_TABLE_NAME='requirement_revisions' THEN
            IF TG_OP='UPDATE' THEN
              IF NOT OLD.submitted THEN RETURN NEW; END IF;
            END IF;
          END IF;
          RAISE EXCEPTION 'Immutable customer-control record' USING ERRCODE='23514';
        END $$
    """)
    op.create_table(
        "incident_comments",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("incident_id", sa.UUID(), nullable=False),
        sa.Column("author_user_id", sa.UUID(), nullable=False),
        sa.Column("author_assignment_id", sa.UUID(), nullable=False),
        sa.Column("participation_id", sa.UUID(), nullable=False),
        sa.Column("document_context", sa.Boolean(), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        _foreign_key("incident_id", "incidents"),
        _foreign_key("author_user_id", "users"),
        _foreign_key("author_assignment_id", "project_assignments"),
        _foreign_key("participation_id", "project_organizations"),
    )
    op.create_index(
        "ix_incident_comments_incident_id", "incident_comments", ["incident_id"]
    )
    op.create_table(
        "deadline_pauses",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("incident_id", sa.UUID(), nullable=False),
        sa.Column("actor_assignment_id", sa.UUID(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("until", sa.DateTime(timezone=True), nullable=False),
        _foreign_key("incident_id", "incidents"),
        _foreign_key("actor_assignment_id", "project_assignments"),
        sa.CheckConstraint('"until" > started_at', name="pause_interval"),
    )
    op.create_index("ix_deadline_pauses_incident_id", "deadline_pauses", ["incident_id"])
    op.create_table(
        "project_deadline_policies",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("approved_by", sa.UUID(), nullable=False),
        sa.Column("approved_assignment_id", sa.UUID(), nullable=False),
        sa.Column("effective_from", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reaction_minutes", sa.Integer(), nullable=False),
        sa.Column("remediation_minutes", sa.Integer(), nullable=False),
        sa.Column("review_minutes", sa.Integer(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        _foreign_key("project_id", "projects"),
        _foreign_key("approved_by", "users"),
        _foreign_key("approved_assignment_id", "project_assignments"),
        sa.UniqueConstraint("project_id", "version"),
        sa.CheckConstraint("version > 0", name="positive_version"),
        sa.CheckConstraint(
            "reaction_minutes > 0 AND remediation_minutes > 0 AND review_minutes > 0",
            name="positive_deadlines",
        ),
    )
    op.create_index(
        "ix_project_deadline_policies_project_id",
        "project_deadline_policies",
        ["project_id"],
    )
    op.create_table(
        "incident_observations",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("incident_id", sa.UUID(), nullable=False),
        sa.Column("source_receipt", sa.String(64), nullable=False),
        sa.Column("observed_from", sa.DateTime(timezone=True), nullable=False),
        sa.Column("observed_until", sa.DateTime(timezone=True), nullable=False),
        sa.Column("snapshot", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        _foreign_key("project_id", "projects"),
        _foreign_key("incident_id", "incidents"),
        sa.UniqueConstraint("project_id", "source_receipt"),
        sa.CheckConstraint(
            "observed_until >= observed_from", name="observation_interval"
        ),
    )
    op.create_index(
        "ix_incident_observations_project_id",
        "incident_observations",
        ["project_id"],
    )
    op.create_index(
        "ix_incident_observations_incident_id",
        "incident_observations",
        ["incident_id"],
    )
    op.create_table(
        "incident_requirement_links",
        sa.Column("incident_id", sa.UUID(), primary_key=True),
        sa.Column("revision_id", sa.UUID(), primary_key=True),
        _foreign_key("incident_id", "incidents"),
        _foreign_key("revision_id", "requirement_revisions"),
    )
    op.execute("""
        INSERT INTO incident_requirement_links(incident_id,revision_id)
        SELECT b.incident_id,r.id FROM incident_basis b
          JOIN incidents i ON i.id=b.incident_id
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(b.snapshot->'citations')='array'
              THEN b.snapshot->'citations' ELSE '[]'::jsonb END) AS citation
          JOIN requirement_revisions r
            ON r.id::text=citation->>'requirement_revision_id'
            AND r.project_id=i.project_id
        ON CONFLICT DO NOTHING
    """)
    for column in (
        sa.Column("requester_assignment_id", sa.UUID(), nullable=True),
        sa.Column("scope_authorization_version", sa.Integer(), nullable=True),
        sa.Column("report_kind", sa.String(16), nullable=True),
        sa.Column("source_scope", postgresql.JSONB(), nullable=True),
    ):
        op.add_column("generated_reports", column)
    op.create_foreign_key(
        op.f("fk_generated_reports_requester_assignment_id_project_assignments"),
        "generated_reports",
        "project_assignments",
        ["requester_assignment_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    _relation_guards()
    for table in (
        "incident_comments",
        "deadline_pauses",
        "project_deadline_policies",
        "incident_observations",
        "incident_requirement_links",
    ):
        op.execute(
            f"CREATE TRIGGER immutable_{table} BEFORE UPDATE OR DELETE ON {table} "
            "FOR EACH ROW EXECUTE FUNCTION customer_control_immutable()"
        )


def _relation_guards():
    op.execute("""
        CREATE FUNCTION customer_control_append_relations() RETURNS trigger
        LANGUAGE plpgsql AS $$
        DECLARE actor_project uuid; actor_user uuid;
                actor_party uuid; target_project uuid;
        BEGIN
          IF TG_TABLE_NAME='incident_requirement_links' THEN
            SELECT project_id INTO target_project FROM incidents WHERE id=NEW.incident_id;
            SELECT project_id INTO actor_project
              FROM requirement_revisions WHERE id=NEW.revision_id;
            IF target_project IS DISTINCT FROM actor_project THEN
              RAISE EXCEPTION 'Incident requirement mismatch' USING ERRCODE='23514';
            END IF;
            RETURN NEW;
          END IF;
          IF TG_TABLE_NAME='incident_observations' THEN
            SELECT project_id INTO target_project FROM incidents WHERE id=NEW.incident_id;
            IF target_project IS DISTINCT FROM NEW.project_id THEN
              RAISE EXCEPTION 'Observation project mismatch' USING ERRCODE='23514';
            END IF;
            RETURN NEW;
          END IF;
          IF TG_TABLE_NAME='incident_comments' THEN
            SELECT p.project_id,m.user_id,p.id INTO actor_project,actor_user,actor_party
              FROM project_assignments a
              JOIN project_organizations p ON p.id=a.participation_id
              JOIN organization_memberships m ON m.id=a.membership_id
              WHERE a.id=NEW.author_assignment_id;
            SELECT project_id INTO target_project FROM incidents WHERE id=NEW.incident_id;
            IF actor_project IS DISTINCT FROM target_project
              OR actor_user IS DISTINCT FROM NEW.author_user_id
              OR actor_party IS DISTINCT FROM NEW.participation_id THEN
              RAISE EXCEPTION 'Comment author context mismatch' USING ERRCODE='23514';
            END IF;
            RETURN NEW;
          END IF;
          IF TG_TABLE_NAME='deadline_pauses' THEN
            SELECT p.project_id INTO actor_project FROM project_assignments a
              JOIN project_organizations p ON p.id=a.participation_id
              WHERE a.id=NEW.actor_assignment_id;
            SELECT project_id INTO target_project FROM incidents WHERE id=NEW.incident_id;
            IF actor_project IS DISTINCT FROM target_project THEN
              RAISE EXCEPTION 'Deadline pause project mismatch' USING ERRCODE='23514';
            END IF;
            RETURN NEW;
          END IF;
          IF TG_TABLE_NAME='project_deadline_policies' THEN
            SELECT p.project_id,m.user_id INTO actor_project,actor_user
              FROM project_assignments a
              JOIN project_organizations p ON p.id=a.participation_id
              JOIN organization_memberships m ON m.id=a.membership_id
              WHERE a.id=NEW.approved_assignment_id;
            IF actor_project IS DISTINCT FROM NEW.project_id
              OR actor_user IS DISTINCT FROM NEW.approved_by THEN
              RAISE EXCEPTION 'Deadline policy actor mismatch' USING ERRCODE='23514';
            END IF;
            RETURN NEW;
          END IF;
          IF TG_TABLE_NAME='generated_reports'
            AND NEW.requester_assignment_id IS NOT NULL THEN
            SELECT p.project_id,m.user_id INTO actor_project,actor_user
              FROM project_assignments a
              JOIN project_organizations p ON p.id=a.participation_id
              JOIN organization_memberships m ON m.id=a.membership_id
              WHERE a.id=NEW.requester_assignment_id;
            IF actor_project IS DISTINCT FROM NEW.project_id
              OR actor_user IS DISTINCT FROM NEW.requested_by_user_id THEN
              RAISE EXCEPTION 'Report requester context mismatch' USING ERRCODE='23514';
            END IF;
          END IF;
          RETURN NEW;
        END $$
    """)
    for table in (
        "incident_comments",
        "deadline_pauses",
        "project_deadline_policies",
        "incident_observations",
        "incident_requirement_links",
        "generated_reports",
    ):
        op.execute(
            f"CREATE TRIGGER ck_{table}_append_relations "
            f"BEFORE INSERT OR UPDATE ON {table} "
            "FOR EACH ROW EXECUTE FUNCTION customer_control_append_relations()"
        )


def downgrade():
    raise RuntimeError(
        "R1 contains immutable observations and decisions; use a compatible rollback "
        "build or restore a verified backup rather than deleting business records"
    )
