"""The single explicitly designated shared demo; all other projects stay private."""

from app.models.project import Project

SHARED_DEMO_CODE = "MANAGEMENT-DEMO"


def is_shared_demo(project: Project) -> bool:
    return project.code == SHARED_DEMO_CODE and project.owner_username is None
