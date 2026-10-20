"""Explicit isolated onboarding; membership and project access are separate grants."""

from __future__ import annotations

import hashlib
import hmac
import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from fastapi import APIRouter
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession
from app.api.v1.customer_control import Key
from app.core.config import settings
from app.models import Project, ProjectSettings, User
from app.models.customer_control import (
    AuditEvent,
    Invitation,
    Organization,
    OrganizationMembership,
    ParticipationPeriod,
    ProjectAssignment,
    ProjectDeadlinePolicy,
    ProjectOrganization,
    ProjectRole,
)
from app.schemas.customer_control import (
    CreateOrganizationCommand,
    CreateProjectCommand,
    InvitationCommand,
    InvitationDTO,
    InviteParticipationCommand,
    MembershipDTO,
    NamedMembershipDTO,
    OrganizationDTO,
    ProjectDTO,
)
from app.services.access_policy import fail, resolve_context
from app.services.incident_workflow import audit, aware, receipt, save_receipt, values

router = APIRouter(prefix="/customer-control", tags=["Организации"])


def membership_context(
    db, user, organization_id=None, *, manage=False, create=False, lock=True
):
    q = (
        select(OrganizationMembership)
        .join(Organization, Organization.id == OrganizationMembership.organization_id)
        .where(
            OrganizationMembership.user_id == user.id,
            OrganizationMembership.status == "active",
            Organization.status == "active",
        )
    )
    if db.info.get("membership_id"):
        q = q.where(OrganizationMembership.id == db.info["membership_id"])
    if organization_id:
        q = q.where(OrganizationMembership.organization_id == organization_id)
    rows = list(db.scalars(q.with_for_update() if lock else q))
    if len(rows) != 1:
        fail("RESOURCE_NOT_FOUND", 404, "Выберите действующее членство организации")
    member = rows[0]
    if (manage and not member.can_manage_members) or (
        create and not member.can_create_projects
    ):
        fail("ACTION_FORBIDDEN")
    return member


def member_ctx(user, member):
    return SimpleNamespace(user=user, membership=member, assignment=None)


def org_audit(db, user, member, event_type, resource_id):
    db.flush()
    event = AuditEvent(
        id=uuid.uuid4(),
        organization_id=member.organization_id,
        actor_user_id=user.id,
        actor_membership_id=member.id,
        event_type=event_type,
        resource_id=resource_id,
        reason="",
    )
    db.add(event)
    return event


@router.get("/organizations", response_model=list[OrganizationDTO])
def organizations(db: DbSession, user: CurrentUser):
    return list(
        db.scalars(
            select(Organization)
            .join(
                OrganizationMembership,
                OrganizationMembership.organization_id == Organization.id,
            )
            .where(
                OrganizationMembership.user_id == user.id,
                OrganizationMembership.status == "active",
            )
        )
    )


@router.get("/memberships", response_model=list[MembershipDTO])
def memberships(db: DbSession, user: CurrentUser):
    return list(
        db.scalars(
            select(OrganizationMembership).where(
                OrganizationMembership.user_id == user.id,
                OrganizationMembership.status == "active",
            )
        )
    )


@router.get(
    "/organizations/{organization_id}/members", response_model=list[NamedMembershipDTO]
)
def organization_members(organization_id: uuid.UUID, db: DbSession, user: CurrentUser):
    membership_context(db, user, organization_id, manage=True, lock=False)
    return [
        NamedMembershipDTO(
            **values(
                m,
                (
                    "id organization_id user_id status can_manage_members "
                    "can_create_projects"
                ),
            ),
            name=u.name,
        )
        for m, u in db.execute(
            select(OrganizationMembership, User)
            .join(User, User.id == OrganizationMembership.user_id)
            .where(OrganizationMembership.organization_id == organization_id)
        )
    ]


@router.post("/organizations", response_model=OrganizationDTO, status_code=201)
def create_org(
    data: CreateOrganizationCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    # Explicit self-onboarding creates a new organization, never joins an existing one.
    db.refresh(user, with_for_update=True)
    ctx = member_ctx(user, SimpleNamespace(id=user.id))
    route, payload = "organizations", data.model_dump(mode="json")
    replay, key, cid = receipt(db, ctx, route, idempotency_key, payload)
    if replay:
        if not db.scalar(
            select(OrganizationMembership.id).where(
                OrganizationMembership.organization_id == replay.resource_id,
                OrganizationMembership.user_id == user.id,
                OrganizationMembership.status == "active",
            )
        ):
            fail("RESOURCE_NOT_FOUND", 404)
        return db.get(Organization, replay.resource_id)
    org = Organization(
        id=uuid.uuid4(), name=data.name.strip(), status="active", needs_confirmation=False
    )
    member = OrganizationMembership(
        id=uuid.uuid4(),
        organization_id=org.id,
        user_id=user.id,
        status="active",
        can_manage_members=True,
        can_create_projects=True,
    )
    db.add(org)
    db.flush()
    db.add(member)
    db.flush()
    event = org_audit(db, user, member, "organization.created", org.id)
    save_receipt(db, ctx, route, key, cid, payload, org.id, event.id)
    db.commit()
    return org


@router.post("/projects", response_model=ProjectDTO, status_code=201)
def create_project(
    data: CreateProjectCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    member = membership_context(db, user, create=True)
    ctx = member_ctx(user, member)
    route, payload = "projects", data.model_dump(mode="json")
    replay, key, cid = receipt(db, ctx, route, idempotency_key, payload)
    if replay:
        resolve_context(db, replay.resource_id, user)
        return db.get(Project, replay.resource_id)
    project = Project(
        id=uuid.uuid4(),
        code="PRJ-" + uuid.uuid4().hex[:16].upper(),
        name=data.name.strip(),
        customer_organization_id=member.organization_id,
        kind=data.kind,
        lifecycle="active",
        owner_username=user.username,
    )
    db.add(project)
    db.flush()
    party = ProjectOrganization(
        id=uuid.uuid4(),
        project_id=project.id,
        organization_id=member.organization_id,
        side="customer",
        status="active",
    )
    db.add(party)
    db.flush()
    new_assignment = ProjectAssignment(
        id=uuid.uuid4(),
        participation_id=party.id,
        membership_id=member.id,
        role=ProjectRole.CUSTOMER_MANAGER,
        scope_kind="project",
        status="active",
    )
    db.add(new_assignment)
    db.flush()
    db.add_all(
        [
            ParticipationPeriod(participation_id=party.id),
            ProjectSettings(project_id=project.id, observation_enabled=False),
        ]
    )
    db.add(
        ProjectDeadlinePolicy(
            project_id=project.id,
            version=1,
            approved_by=user.id,
            approved_assignment_id=new_assignment.id,
            effective_from=datetime.now(UTC),
            reaction_minutes=data.reaction_minutes,
            remediation_minutes=data.remediation_minutes,
            review_minutes=data.review_minutes,
            reason="Сроки явно заданы заказчиком при создании объекта",
        )
    )
    event = org_audit(db, user, member, "project.created", project.id)
    save_receipt(db, ctx, route, key, cid, payload, project.id, event.id)
    db.commit()
    return project


def invitation_token(invitation_id):
    signature = hmac.new(
        settings.jwt_secret_key.encode(),
        f"customer-control-invitation:{invitation_id}".encode(),
        hashlib.sha256,
    ).hexdigest()
    return f"{invitation_id}.{signature}"


def invitation_dto(db, row, token=None):
    org = db.get(Organization, row.organization_id)
    project = db.get(Project, row.project_id) if row.project_id else None
    return InvitationDTO(
        **values(row, "id organization_id status expires_at"),
        token=token,
        organization_name=org.name,
        project_name=project.name if project else None,
    )


def issue_invitation(db, organization_id, data, user, project_id=None):
    now = datetime.now(UTC)
    if not now < data.expires_at <= now + timedelta(days=30):
        fail("VALIDATION_ERROR", 422, "Приглашение действует не дольше 30 дней")
    person = db.get(User, data.recipient_user_id)
    if not person or not person.is_active:
        fail("RESOURCE_NOT_FOUND", 404)
    row_id = uuid.uuid4()
    token = invitation_token(row_id)
    row = Invitation(
        id=row_id,
        organization_id=organization_id,
        project_id=project_id,
        recipient_user_id=person.id,
        issued_by=user.id,
        token_sha256=hashlib.sha256(token.encode()).hexdigest(),
        expires_at=data.expires_at,
        status="pending",
    )
    db.add(row)
    return row, token


@router.get("/invitations", response_model=list[InvitationDTO])
def invitations(db: DbSession, user: CurrentUser):
    return [
        invitation_dto(db, i, invitation_token(i.id))
        for i in db.scalars(
            select(Invitation).where(
                Invitation.recipient_user_id == user.id,
                Invitation.status == "pending",
                Invitation.expires_at > datetime.now(UTC),
            )
        )
    ]


@router.post(
    "/organizations/{organization_id}/invitations",
    response_model=InvitationDTO,
    status_code=201,
)
def invite_member(
    organization_id: uuid.UUID,
    data: InvitationCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    member = membership_context(db, user, organization_id, manage=True)
    ctx = member_ctx(user, member)
    route, payload = (
        f"organizations/{organization_id}/invitations",
        data.model_dump(mode="json"),
    )
    replay, key, cid = receipt(db, ctx, route, idempotency_key, payload)
    if replay:
        row = db.get(Invitation, replay.resource_id)
        if not row:
            fail("RESOURCE_NOT_FOUND", 404)
        return invitation_dto(db, row, invitation_token(row.id))
    row, token = issue_invitation(db, organization_id, data, user)
    event = org_audit(db, user, member, "membership.invited", row.id)
    save_receipt(db, ctx, route, key, cid, payload, row.id, event.id)
    db.commit()
    return invitation_dto(db, row, token)


@router.post(
    "/projects/{project_id}/participations", response_model=InvitationDTO, status_code=201
)
def invite_contractor(
    project_id: uuid.UUID,
    data: InviteParticipationCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    ctx = resolve_context(
        db, project_id, user, "participation.manage", write=True, lock=True
    )
    admin = db.scalar(
        select(OrganizationMembership).where(
            OrganizationMembership.organization_id == data.organization_id,
            OrganizationMembership.user_id == data.recipient_user_id,
            OrganizationMembership.status == "active",
            OrganizationMembership.can_manage_members.is_(True),
        )
    )
    if data.organization_id == ctx.project.customer_organization_id or not admin:
        fail(
            "RESOURCE_NOT_FOUND", 404, "Укажите подтверждённого администратора подрядчика"
        )
    route, payload = f"projects/{project_id}/participations", data.model_dump(mode="json")
    replay, key, cid = receipt(db, ctx, route, idempotency_key, payload)
    if replay:
        row = db.get(Invitation, replay.resource_id)
        if not row:
            fail("RESOURCE_NOT_FOUND", 404)
        return invitation_dto(db, row, invitation_token(row.id))
    party = db.scalar(
        select(ProjectOrganization).where(
            ProjectOrganization.project_id == project_id,
            ProjectOrganization.organization_id == data.organization_id,
        )
    )
    if party and party.status == "active":
        fail("INVALID_TRANSITION", 409, "Подрядчик уже участвует в объекте")
    if not party:
        db.add(
            ProjectOrganization(
                id=uuid.uuid4(),
                project_id=project_id,
                organization_id=data.organization_id,
                side="contractor",
                status="invited",
            )
        )
    row, token = issue_invitation(db, data.organization_id, data, user, project_id)
    event = audit(db, ctx, "participation.invited", row.id)
    save_receipt(db, ctx, route, key, cid, payload, row.id, event.id)
    db.commit()
    return invitation_dto(db, row, token)


@router.post("/invitations/{token}/accept", response_model=InvitationDTO)
def accept_invitation(
    token: str, db: DbSession, user: CurrentUser, idempotency_key: Key = None
):
    if not idempotency_key:
        fail("VALIDATION_ERROR", 422, "Требуется Idempotency-Key")
    row = db.scalar(
        select(Invitation).where(
            Invitation.token_sha256 == hashlib.sha256(token.encode()).hexdigest()
        )
    )
    if not row or row.recipient_user_id != user.id:
        fail("RESOURCE_NOT_FOUND", 404)
    # Discover the parent without a lock, then follow the same project → member →
    # invitation lock order as revocations. Re-read the invitation after locking.
    project = None
    if row.project_id:
        project = db.scalar(
            select(Project).where(Project.id == row.project_id).with_for_update()
        )
        if not project or project.kind == "shared_demo" or project.lifecycle != "active":
            fail("PROJECT_ARCHIVED", 409)
    org = db.get(Organization, row.organization_id)
    if not org or org.status != "active":
        fail("RESOURCE_NOT_FOUND", 404)
    member = db.scalar(
        select(OrganizationMembership)
        .where(
            OrganizationMembership.organization_id == org.id,
            OrganizationMembership.user_id == user.id,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    db.refresh(row, with_for_update=True)
    if row.status == "accepted":
        if not member or member.status != "active":
            fail("RESOURCE_NOT_FOUND", 404)
        if project and not db.scalar(
            select(ProjectOrganization.id).where(
                ProjectOrganization.project_id == project.id,
                ProjectOrganization.organization_id == org.id,
                ProjectOrganization.status == "active",
            )
        ):
            fail("RESOURCE_NOT_FOUND", 404)
        return invitation_dto(db, row)
    if row.status != "pending" or aware(row.expires_at) <= datetime.now(UTC):
        fail("INVALID_TRANSITION", 409, "Приглашение больше не действует")
    if project:
        if not member or member.status != "active" or not member.can_manage_members:
            fail("ACTION_FORBIDDEN")
        party = db.scalar(
            select(ProjectOrganization).where(
                ProjectOrganization.project_id == project.id,
                ProjectOrganization.organization_id == org.id,
            )
        )
        if not party:
            fail("RESOURCE_NOT_FOUND", 404)
        if party.status != "active":
            party.status = "active"
            db.add(ParticipationPeriod(participation_id=party.id))
            project.authorization_version += 1
    else:
        if member:
            member.status = "active"
        else:
            member = OrganizationMembership(
                id=uuid.uuid4(),
                organization_id=org.id,
                user_id=user.id,
                status="active",
                can_manage_members=False,
                can_create_projects=False,
            )
            db.add(member)
            db.flush()
    row.status, row.accepted_at = "accepted", datetime.now(UTC)
    org_audit(
        db,
        user,
        member,
        "participation.started" if row.project_id else "membership.accepted",
        row.id,
    )
    db.commit()
    return invitation_dto(db, row)
