"""Incident deadlines, verification results and durable notifications.

Revision ID: 20261016_1300
Revises: 20261016_1200
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20261016_1300"
down_revision: Union[str, None] = "20261016_1200"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("projects", sa.Column("alert_error_deadline_minutes", sa.Integer(), server_default="120", nullable=False))
    op.add_column("projects", sa.Column("alert_warning_deadline_minutes", sa.Integer(), server_default="1440", nullable=False))
    op.add_column("projects", sa.Column("escalation_user_id", sa.UUID(), nullable=True))
    op.create_foreign_key("fk_projects_escalation_user_id_users", "projects", "users", ["escalation_user_id"], ["id"], ondelete="SET NULL")

    op.add_column("incidents", sa.Column("verification_status", sa.String(length=32), server_default="pending", nullable=False))
    op.add_column("incidents", sa.Column("verification_requested_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("incidents", sa.Column("last_checked_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("incidents", sa.Column("escalated_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("incidents", sa.Column("verification_details", postgresql.JSONB(), server_default="{}", nullable=False))
    op.create_index("ix_incidents_sla_escalation", "incidents", ["sla_deadline", "escalated_at"])

    op.create_table(
        "alert_notifications",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("incident_id", sa.UUID(), nullable=False),
        sa.Column("recipient_user_id", sa.UUID(), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("title", sa.String(length=256), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("email_status", sa.String(length=16), server_default="pending", nullable=False),
        sa.Column("email_attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("email_sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("email_error", sa.String(length=256), nullable=True),
        sa.ForeignKeyConstraint(["incident_id"], ["incidents.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["recipient_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("incident_id", "recipient_user_id", "kind", name="uq_alert_delivery"),
    )
    op.create_index("ix_alert_notifications_incident_id", "alert_notifications", ["incident_id"])
    op.create_index("ix_alert_notifications_recipient_user_id", "alert_notifications", ["recipient_user_id"])


def downgrade() -> None:
    op.drop_index("ix_alert_notifications_recipient_user_id", table_name="alert_notifications")
    op.drop_index("ix_alert_notifications_incident_id", table_name="alert_notifications")
    op.drop_table("alert_notifications")
    op.drop_index("ix_incidents_sla_escalation", table_name="incidents")
    op.drop_column("incidents", "verification_details")
    op.drop_column("incidents", "escalated_at")
    op.drop_column("incidents", "last_checked_at")
    op.drop_column("incidents", "verification_requested_at")
    op.drop_column("incidents", "verification_status")
    op.drop_constraint("fk_projects_escalation_user_id_users", "projects", type_="foreignkey")
    op.drop_column("projects", "escalation_user_id")
    op.drop_column("projects", "alert_warning_deadline_minutes")
    op.drop_column("projects", "alert_error_deadline_minutes")
