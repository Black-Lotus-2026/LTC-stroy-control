"""One current database context per request; historical attribution is never a grant."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import NoReturn

from fastapi import HTTPException
from sqlalchemy import and_, exists, or_, select
from sqlalchemy.orm import Session

from app.models import Incident, Project, User
from app.models.customer_control import (
    AssignmentArea,
    CameraShare,
    DocumentShare,
    EvidenceDisclosure,
    Organization,
    OrganizationMembership,
    ProjectAssignment,
    ProjectOrganization,
    ProjectRole,
    ResponsibilityArea,
    VideoShare,
)
from app.services.demo_publication import demo_ids

MANAGER = frozenset(
    """project.read project.create project.manage membership.manage
participation.manage assignment.manage camera.read camera.configure
camera.reference.propose camera.reference.approve camera.move.request
camera.move.decide camera.move.restore video.read video.upload video.analyze
document.read document.upload document.analyze requirement.edit control.submit
control.approve control.publish control.retire incident.read incident.confirm
incident.dismiss incident.assign incident.deadline incident.start
incident.comment remediation.submit remediation.accept remediation.return
dispute.decide evidence.read evidence.append evidence.publish report.read
report.create audit.read""".split()
)
FOREMAN = frozenset(
    """project.read camera.read camera.reference.propose camera.move.request
video.read video.upload video.analyze document.read incident.read
incident.start incident.comment remediation.submit dispute.open evidence.read
evidence.append report.read audit.read""".split()
)
FOREMAN = FOREMAN | {"report.create"}
PTO = frozenset(
    """project.read document.read document.upload document.analyze requirement.edit
control.submit incident.comment evidence.read evidence.append audit.read""".split()
)
PTO = PTO | {"report.read", "report.create"}
VIEWER = frozenset(
    (
        "project.read camera.read video.read document.read incident.read "
        "evidence.read report.read audit.read"
    ).split()
)


def fail(code: str, status: int = 403, message: str = "Действие недоступно") -> NoReturn:
    raise HTTPException(status, {"code": code, "message": message})


@dataclass(frozen=True)
class AccessContext:
    project: Project
    user: User
    assignment: ProjectAssignment | None
    participation: ProjectOrganization | None
    membership: OrganizationMembership | None
    area_ids: tuple[uuid.UUID, ...] = ()
    is_demo: bool = False

    @property
    def role(self):
        return self.assignment.role if self.assignment else ProjectRole.PROJECT_VIEWER

    @property
    def side(self):
        return self.participation.side if self.participation else "customer"

    @property
    def permissions(self):
        if self.is_demo:
            return VIEWER
        if self.role == ProjectRole.CUSTOMER_MANAGER and self.side == "customer":
            permissions = set(MANAGER)
            if not self.membership.can_manage_members:
                permissions.discard("membership.manage")
            if not self.membership.can_create_projects:
                permissions.discard("project.create")
            return frozenset(permissions)
        if self.role == ProjectRole.CONTRACTOR_FOREMAN and self.side == "contractor":
            return FOREMAN
        if self.role == ProjectRole.PTO_ENGINEER:
            return PTO | ({"dispute.open"} if self.side == "contractor" else set())
        return VIEWER if self.role == ProjectRole.PROJECT_VIEWER else frozenset()


def assignment_query(user):
    return (
        select(ProjectAssignment, ProjectOrganization, OrganizationMembership)
        .join(
            ProjectOrganization,
            ProjectOrganization.id == ProjectAssignment.participation_id,
        )
        .join(
            OrganizationMembership,
            OrganizationMembership.id == ProjectAssignment.membership_id,
        )
        .join(Organization, Organization.id == OrganizationMembership.organization_id)
        .where(
            OrganizationMembership.user_id == user.id,
            OrganizationMembership.organization_id == ProjectOrganization.organization_id,
            OrganizationMembership.status == "active",
            ProjectAssignment.status == "active",
            ProjectOrganization.status == "active",
            Organization.status == "active",
        )
    )


def visible_project_ids(db, user):
    assigned = assignment_query(user).with_only_columns(ProjectOrganization.project_id)
    if selector := db.info.get("assignment_id"):
        assigned = assigned.where(ProjectAssignment.id == selector)
    if membership := db.info.get("membership_id"):
        assigned = assigned.where(OrganizationMembership.id == membership)
    return select(Project.id).where(
        or_(Project.id.in_(assigned), Project.kind == "shared_demo")
    )


def resolve_context(
    db: Session, project_id, user, permission="project.read", *, write=False, lock=False
):
    if not user or not user.is_active:
        fail("AUTH_REQUIRED", 401)
    query = select(Project).where(Project.id == project_id)
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    project = db.scalar(query)
    if not project:
        fail("RESOURCE_NOT_FOUND", 404, "Ресурс недоступен")
    if project.kind == "shared_demo":
        ctx = AccessContext(project, user, None, None, None, is_demo=True)
    else:
        query = assignment_query(user).where(ProjectOrganization.project_id == project.id)
        if membership := db.info.get("membership_id"):
            query = query.where(OrganizationMembership.id == membership)
        selector = db.info.get("assignment_id")
        if selector:
            try:
                selector = uuid.UUID(str(selector))
            except ValueError:
                fail("RESOURCE_NOT_FOUND", 404)
            query = query.where(ProjectAssignment.id == selector)
        rows = db.execute(query.execution_options(populate_existing=True)).all()
        if len(rows) != 1:
            fail("RESOURCE_NOT_FOUND", 404, "Выберите доступное назначение")
        assignment, participation, membership = rows[0]
        if lock:
            # project lock serializes grants/revocations and domain mutations.
            db.refresh(assignment, with_for_update=True)
            db.refresh(membership, with_for_update=True)
            if assignment.status != "active" or membership.status != "active":
                fail("ACCESS_REVOKED", 404)
        areas = tuple(
            db.scalars(
                select(AssignmentArea.area_id)
                .join(ResponsibilityArea, ResponsibilityArea.id == AssignmentArea.area_id)
                .where(
                    AssignmentArea.assignment_id == assignment.id,
                    ResponsibilityArea.project_id == project.id,
                )
            )
        )
        if assignment.scope_kind != "project" and not areas:
            fail("RESOURCE_NOT_FOUND", 404)
        if participation.side == "contractor" and (
            assignment.scope_kind != "areas" or not areas
        ):
            fail("RESOURCE_NOT_FOUND", 404)
        if (
            participation.side == "customer"
            and participation.organization_id != project.customer_organization_id
        ):
            fail("RESOURCE_NOT_FOUND", 404)
        ctx = AccessContext(project, user, assignment, participation, membership, areas)
    if write:
        if ctx.is_demo:
            fail("DEMO_READ_ONLY", 403, "Общая демонстрация доступна только для чтения")
        if project.lifecycle != "active":
            fail("PROJECT_ARCHIVED", 409, "Объект архивирован")
        if ctx.role == ProjectRole.PROJECT_VIEWER:
            fail("ACTION_FORBIDDEN")
    if permission not in ctx.permissions:
        fail("ACTION_FORBIDDEN", 403, "Недостаточно полномочий выбранного назначения")
    return ctx


def incident_query(db, ctx):
    query = select(Incident).where(Incident.project_id == ctx.project.id)
    if ctx.is_demo:
        from app.services.demo_publication import published_incident_ids

        return query.where(Incident.id.in_(published_incident_ids(db, ctx.project)))
    if (
        ctx.side == "customer"
        and ctx.role in {ProjectRole.CUSTOMER_MANAGER, ProjectRole.PROJECT_VIEWER}
        and ctx.assignment
        and ctx.assignment.scope_kind == "project"
    ):
        return query
    if ctx.role == ProjectRole.PTO_ENGINEER:
        return query.where(False)  # document context has a separate narrow projection
    query = query.where(Incident.area_id.in_(ctx.area_ids))
    if ctx.side == "contractor":
        query = query.where(
            Incident.responsible_participation_id == ctx.participation.id,
            exists(
                select(EvidenceDisclosure.id).where(
                    EvidenceDisclosure.incident_id == Incident.id,
                    EvidenceDisclosure.participation_id == ctx.participation.id,
                    EvidenceDisclosure.project_id == ctx.project.id,
                    EvidenceDisclosure.active.is_(True),
                )
            ),
        )
    return query


def can_read_incident(db, ctx, incident):
    return (
        db.scalar(
            incident_query(db, ctx)
            .with_only_columns(Incident.id)
            .where(Incident.id == incident.id)
        )
        is not None
    )


def resource_query(db, ctx, kind, model):
    query = select(model).where(model.project_id == ctx.project.id)
    if ctx.is_demo:
        singular = {"cameras": "camera", "videos": "video", "documents": "document"}
        return query.where(model.id.in_(demo_ids(ctx.project, singular.get(kind, kind))))
    if ctx.side == "customer" and ctx.assignment.scope_kind == "project":
        return query
    if kind in {"camera", "cameras"}:
        share, column = CameraShare, CameraShare.camera_id
    elif kind in {"video", "videos"}:
        share, column = VideoShare, VideoShare.video_id
    elif kind in {"document", "documents"}:
        share, column = DocumentShare, DocumentShare.document_id
    else:
        return query.where(False)
    published = exists(
        select(share.id).where(
            column == model.id,
            share.project_id == ctx.project.id,
            share.participation_id == ctx.participation.id,
            share.active.is_(True),
            share.read_kind == "full",
            or_(
                share.area_id.in_(ctx.area_ids),
                and_(share.area_id.is_(None), _resource_area_condition(ctx, model)),
            ),
        )
    )
    own = False
    if hasattr(model, "owner_participation_id"):
        own = and_(
            model.owner_participation_id == ctx.participation.id,
            model.area_id.in_(ctx.area_ids),
        )
        if (
            model.__tablename__ == "ppr_documents"
            and ctx.role != ProjectRole.PTO_ENGINEER
        ):
            own = False
    if ctx.side == "customer":
        if hasattr(model, "area_id"):
            return query.where(model.area_id.in_(ctx.area_ids))
        if hasattr(model, "zone_id"):
            zones = select(ResponsibilityArea.zone_id).where(
                ResponsibilityArea.id.in_(ctx.area_ids)
            )
            return query.where(model.zone_id.in_(zones))
    return query.where(or_(published, own), _resource_area_condition(ctx, model))


def _resource_area_condition(ctx, model):
    if hasattr(model, "area_id"):
        if model.__tablename__ == "ppr_documents":
            return or_(model.area_id.in_(ctx.area_ids), model.area_id.is_(None))
        return model.area_id.in_(ctx.area_ids)
    if hasattr(model, "zone_id"):
        from app.models import ScheduleTask

        zones = select(ResponsibilityArea.zone_id).where(
            ResponsibilityArea.id.in_(ctx.area_ids)
        )
        task_zones = (
            select(ScheduleTask.zone_id)
            .join(
                ResponsibilityArea, ResponsibilityArea.schedule_task_id == ScheduleTask.id
            )
            .where(ResponsibilityArea.id.in_(ctx.area_ids))
        )
        return or_(model.zone_id.in_(zones), model.zone_id.in_(task_zones))
    return False


def resource_visible(
    db, ctx, kind, resource_id, area_id=None, owner_participation_id=None
):
    from app.models import Camera, PprDocument, VideoAsset

    models = {"camera": Camera, "video": VideoAsset, "document": PprDocument}
    model = models.get(kind.rstrip("s"))
    if model is None:
        return False
    return (
        db.scalar(
            resource_query(db, ctx, kind, model)
            .with_only_columns(model.id)
            .where(model.id == resource_id)
        )
        is not None
    )


def require_area(db, ctx, area_id):
    area = db.get(ResponsibilityArea, area_id) if area_id else None
    if not area or area.project_id != ctx.project.id:
        fail("RESOURCE_NOT_FOUND", 404, "Область недоступна")
    if ctx.assignment.scope_kind == "areas" and area.id not in ctx.area_ids:
        fail("RESOURCE_NOT_FOUND", 404)
    return area


def has_contractor_conflict(db, ctx, participation_id=None):
    q = assignment_query(ctx.user).where(
        ProjectOrganization.project_id == ctx.project.id,
        ProjectOrganization.side == "contractor",
    )
    if participation_id:
        q = q.where(ProjectOrganization.id == participation_id)
    return db.execute(q).first() is not None
