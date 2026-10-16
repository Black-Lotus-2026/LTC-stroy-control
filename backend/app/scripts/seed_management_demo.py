"""Provision a disposable local fixture, never a customer database.

Run after migrations: python -m app.scripts.seed_management_demo --allow-local-demo
The public fixture password is not a credential for any external service.
"""

import argparse

from sqlalchemy import select

from app.core.config import settings
from app.core.security import hash_password
from app.db.session import SessionLocal
from app.models import Project, User, UserRole


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--allow-local-demo", action="store_true", required=True)
    parser.parse_args()
    if (
        settings.environment != "local"
        or settings.postgres_host not in ("localhost", "127.0.0.1")
        or settings.postgres_db != "management_demo"
    ):
        raise SystemExit(
            "Fixture creation requires local PostgreSQL database management_demo"
        )
    with SessionLocal() as db:
        user = db.scalars(select(User).where(User.username == "management_demo")).first()
        if user is None:
            user = User(
                username="management_demo",
                name="Демо инженер",
                hashed_password=hash_password("management-demo-local"),
                role=UserRole.MANAGER,
                is_active=True,
            )
            db.add(user)
            db.flush()
        project = db.scalars(
            select(Project).where(Project.code == "MANAGEMENT-DEMO")
        ).first()
        if project is None:
            project = Project(
                code="MANAGEMENT-DEMO",
                name="Демонстрационный объект · земляные работы",
                owner_username=user.username,
            )
            db.add(project)
        db.commit()
        print("Local fixture ready: management_demo / management-demo-local")
        print("Project:", project.id)


if __name__ == "__main__":
    main()
