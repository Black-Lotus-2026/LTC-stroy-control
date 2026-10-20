"""Critical R1 relational guards require PostgreSQL, not SQLite substitutes."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError

from app.models import Incident, PprDocument, PprPage
from app.models.customer_control import (
    ControlRelease,
    ControlReleaseItem,
    DeadlinePause,
    IncidentComment,
    IncidentObservation,
    ProjectAssignment,
    ProjectDeadlinePolicy,
    ProjectOrganization,
    ProjectRole,
)
from app.models.enums import (
    IncidentCategory,
    IncidentPriority,
    IncidentStatus,
    IncidentType,
)
from tests import (
    test_customer_control_http,
    test_customer_control_migration,
    test_customer_control_ppr,
)

customer_http = test_customer_control_http.customer_http
migration_postgres = test_customer_control_migration.migration_postgres


@pytest.mark.parametrize("customer_http", ["postgres"], indirect=True)
def test_postgres_original_and_completed_page_provenance_cannot_be_rewritten(
    customer_http,
):
    s = customer_http
    candidate, _ = test_customer_control_ppr._candidate(s)
    with s.sessions() as db:
        page = db.scalar(
            select(PprPage).where(PprPage.analysis_id == candidate.analysis_id)
        )
        for values in (
            {"sha256": "f" * 64},
            {"storage_key": "another.pdf"},
            {"version_no": 10},
            {"series_id": s.documents["k2"].series_id},
        ):
            with pytest.raises(IntegrityError):
                db.execute(
                    update(PprDocument)
                    .where(PprDocument.id == candidate.document_id)
                    .values(**values)
                )
                db.commit()
            db.rollback()
        page_id = page.id
        for values in (
            {"text": "A different exact quotation"},
            {"text_sha256": "a" * 64},
            {"preview_key": "replacement-page.pdf"},
            {"artifact_sha256": "b" * 64},
            {"status": "PENDING"},
        ):
            with pytest.raises(IntegrityError):
                db.execute(update(PprPage).where(PprPage.id == page_id).values(**values))
                db.commit()
            db.rollback()
        with pytest.raises(IntegrityError):
            db.execute(delete(PprPage).where(PprPage.id == page_id))
            db.commit()
        db.rollback()


@pytest.mark.parametrize("customer_http", ["postgres"], indirect=True)
def test_postgres_completed_page_artifact_hash_may_be_backfilled_only_once(customer_http):
    s = customer_http
    candidate, _ = test_customer_control_ppr._candidate(s)
    with s.sessions() as db:
        page = PprPage(
            analysis_id=candidate.analysis_id,
            page_number=3,
            status="COMPLETED",
            text="Synthetic immutable page awaiting first artifact digest",
            text_sha256="c" * 64,
            preview_key="legacy-page.pdf",
            preview_media_type="application/pdf",
            artifact_sha256=None,
        )
        db.add(page)
        db.commit()
        page.artifact_sha256 = "d" * 64
        db.commit()
        page_id = page.id
        with pytest.raises(IntegrityError):
            db.execute(
                update(PprPage).where(PprPage.id == page_id).values(artifact_sha256=None)
            )
            db.commit()
        db.rollback()


@pytest.mark.parametrize("customer_http", ["postgres"], indirect=True)
def test_postgres_submitted_manifest_is_pinned_while_customer_may_approve(customer_http):
    from uuid import UUID

    s = customer_http
    candidate, _ = test_customer_control_ppr._candidate(s)
    revision = test_customer_control_ppr._revision(s, candidate)
    packet = test_customer_control_ppr._packet(s, revision)
    release_id = UUID(packet["id"])
    with s.sessions() as db:
        for statement in (
            update(ControlRelease)
            .where(ControlRelease.id == release_id)
            .values(manifest_sha256="e" * 64),
            update(ControlRelease)
            .where(ControlRelease.id == release_id)
            .values(status="draft"),
            update(ControlReleaseItem)
            .where(ControlReleaseItem.release_id == release_id)
            .values(revision_id=UUID(revision["id"])),
            delete(ControlReleaseItem).where(ControlReleaseItem.release_id == release_id),
        ):
            with pytest.raises(IntegrityError):
                db.execute(statement)
                db.commit()
            db.rollback()
        assert (
            db.scalar(
                select(func.count())
                .select_from(ControlReleaseItem)
                .where(ControlReleaseItem.release_id == release_id)
            )
            == 1
        )
    approved = test_customer_control_ppr._post(
        s,
        "manager",
        f"/control-releases/{release_id}/approve",
        test_customer_control_ppr._approval(s, packet),
    )
    assert approved.status_code == 200, approved.text


def _duplicate(s, key):
    at = datetime.now(UTC)
    return Incident(
        id=uuid4(),
        code="PG-" + uuid4().hex[:20],
        project_id=s.projects["a"].id,
        zone_id=s.zone.id,
        area_id=s.area.id,
        title="Synthetic concurrent event",
        category=IncidentCategory.EQUIPMENT,
        type=IncidentType.EQUIPMENT_MISSING,
        status=IncidentStatus.PENDING,
        priority=IncidentPriority.MEDIUM,
        dedup_key=key,
        first_seen_at=at,
        last_seen_at=at,
        responsible_participation_id=s.participations["k1"].id,
    )


@pytest.mark.parametrize("customer_http", ["postgres"], indirect=True)
def test_postgres_concurrent_observations_cannot_create_two_open_cases(customer_http):
    s = customer_http
    key = "concurrent-r1-" + uuid4().hex

    def insert(_):
        with s.sessions() as db:
            db.add(_duplicate(s, key))
            try:
                db.commit()
                return "created"
            except IntegrityError:
                db.rollback()
                return "deduplicated"

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(insert, range(2)))
    assert sorted(outcomes) == ["created", "deduplicated"]
    with s.sessions() as db:
        assert (
            db.scalar(
                select(func.count())
                .select_from(Incident)
                .where(Incident.dedup_key == key)
            )
            == 1
        )


@pytest.mark.parametrize("customer_http", ["postgres"], indirect=True)
def test_postgres_waiting_for_acceptance_remains_part_of_open_case_deduplication(
    customer_http,
):
    s = customer_http
    with s.sessions() as db:
        original = db.get(Incident, s.incidents["k1"].id)
        original.status = IncidentStatus.REMEDIATION_SUBMITTED
        key = original.dedup_key
        db.commit()
        db.add(_duplicate(s, key))
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()


@pytest.mark.parametrize("customer_http", ["postgres"], indirect=True)
def test_postgres_assignment_membership_and_participation_must_have_same_organization(
    customer_http,
):
    s = customer_http
    with s.sessions() as db:
        db.add(
            ProjectAssignment(
                participation_id=s.participations["k2"].id,
                membership_id=s.memberships["foreman1"].id,
                role=ProjectRole.PTO_ENGINEER,
                scope_kind="areas",
            )
        )
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()


@pytest.mark.parametrize("customer_http", ["postgres"], indirect=True)
def test_postgres_contractor_cannot_receive_customer_manager_role(customer_http):
    s = customer_http
    with s.sessions() as db:
        db.add(
            ProjectAssignment(
                participation_id=s.participations["k1"].id,
                membership_id=s.memberships["foreman1"].id,
                role=ProjectRole.CUSTOMER_MANAGER,
                scope_kind="areas",
            )
        )
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()


@pytest.mark.parametrize("customer_http", ["postgres"], indirect=True)
def test_postgres_project_has_one_customer_participation(customer_http):
    s = customer_http
    with s.sessions() as db:
        db.add(
            ProjectOrganization(
                project_id=s.projects["a"].id,
                organization_id=s.participations["customer_b"].organization_id,
                side="customer",
            )
        )
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()


@pytest.mark.parametrize("customer_http", ["postgres"], indirect=True)
def test_postgres_comments_deadline_policies_and_observations_are_append_only(
    customer_http,
):
    s = customer_http
    at = datetime.now(UTC)
    with s.sessions() as db:
        rows = [
            IncidentComment(
                incident_id=s.incidents["k1"].id,
                author_user_id=s.users["manager"].id,
                author_assignment_id=s.assignments["manager"].id,
                participation_id=s.participations["customer_a"].id,
                document_context=False,
                note="Preserved comment",
            ),
            DeadlinePause(
                incident_id=s.incidents["k1"].id,
                actor_assignment_id=s.assignments["manager"].id,
                reason="Preserved pause",
                started_at=at,
                until=at + timedelta(hours=1),
            ),
            ProjectDeadlinePolicy(
                project_id=s.projects["a"].id,
                version=1,
                approved_by=s.users["manager"].id,
                approved_assignment_id=s.assignments["manager"].id,
                reaction_minutes=60,
                remediation_minutes=1440,
                review_minutes=1440,
                reason="Preserved policy",
            ),
            IncidentObservation(
                project_id=s.projects["a"].id,
                incident_id=s.incidents["k1"].id,
                source_receipt="a" * 64,
                observed_from=at,
                observed_until=at,
                snapshot={"source": "synthetic"},
            ),
        ]
        db.add_all(rows)
        db.commit()
        for row, changed in zip(
            rows,
            (
                {"note": "Modified"},
                {"reason": "Modified"},
                {"reason": "Modified"},
                {"snapshot": {"source": "modified"}},
            ),
            strict=True,
        ):
            with pytest.raises(IntegrityError):
                db.execute(
                    update(type(row)).where(type(row).id == row.id).values(**changed)
                )
                db.commit()
            db.rollback()


@pytest.mark.parametrize("customer_http", ["postgres"], indirect=True)
def test_postgres_observations_cannot_link_a_foreign_project(customer_http):
    s = customer_http
    at = datetime.now(UTC)
    with s.sessions() as db:
        db.add(
            IncidentObservation(
                project_id=s.projects["b"].id,
                incident_id=s.incidents["k1"].id,
                source_receipt="b" * 64,
                observed_from=at,
                observed_until=at,
                snapshot={"source": "synthetic"},
            )
        )
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()
