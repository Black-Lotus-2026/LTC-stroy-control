"""Safe projections for legacy endpoints which return a whole project dataset."""

from fastapi import HTTPException

from app.services.access_policy import resolve_context


def require_full_project_read(db, project_id, user):
    ctx = resolve_context(db, project_id, user)
    if ctx.is_demo:
        raise HTTPException(
            409,
            detail={
                "code": "DEMO_PUBLICATION_REQUIRED",
                "message": (
                    "Откройте опубликованные материалы "
                    "в рабочем пространстве демонстрации"
                ),
            },
        )
    if not (
        ctx.side == "customer"
        and ctx.role in {"customer_manager", "project_viewer"}
        and ctx.assignment.scope_kind == "project"
    ):
        raise HTTPException(
            403,
            detail={
                "code": "ACTION_FORBIDDEN",
                "message": "Полная сводка доступна представителю заказчика",
            },
        )
    return ctx
