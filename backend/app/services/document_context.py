"""PTO sees the document basis of a related case, never the operational case payload."""

from __future__ import annotations

from sqlalchemy import exists, select

from app.models import Incident, PprDocument, PprRequirement
from app.models.customer_control import (
    EvidenceDisclosure,
    IncidentRequirementLink,
    RequirementRevision,
)
from app.services.access_policy import resource_query


def document_incident_query(db, ctx):
    documents = resource_query(db, ctx, "document", PprDocument).with_only_columns(
        PprDocument.id
    )
    linked = (
        select(IncidentRequirementLink.incident_id)
        .join(
            RequirementRevision,
            RequirementRevision.id == IncidentRequirementLink.revision_id,
        )
        .where(
            RequirementRevision.project_id == ctx.project.id,
            RequirementRevision.requirement_id.in_(
                select(PprRequirement.id).where(PprRequirement.document_id.in_(documents))
            ),
        )
    )
    query = select(Incident).where(
        Incident.project_id == ctx.project.id, Incident.id.in_(linked)
    )
    if ctx.assignment.scope_kind == "areas":
        query = query.where(Incident.area_id.in_(ctx.area_ids))
    if ctx.side == "contractor":
        query = query.where(
            Incident.responsible_participation_id == ctx.participation.id,
            exists(
                select(EvidenceDisclosure.id).where(
                    EvidenceDisclosure.incident_id == Incident.id,
                    EvidenceDisclosure.participation_id == ctx.participation.id,
                    EvidenceDisclosure.revision_id.is_not(None),
                    EvidenceDisclosure.active.is_(True),
                )
            ),
        )
    return query
