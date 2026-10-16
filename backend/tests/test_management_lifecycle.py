"""Lifecycle regression checks in isolated databases; providers are always fake.

PostgreSQL concurrency is opt-in with MANAGEMENT_TEST_DATABASE_URL. Its database
name must start with test_ or end with _test, and each test owns a random schema.
Application configuration and demo/customer databases are never used here.
"""

import os
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, event, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine import make_url
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker

from app.api.v1.management import ROLES, expire_run
from app.db.base import Base, utcnow
from app.models import Project, User, UserRole
from app.models.management import ManagementRun, ManagementRunStep
from app.services.management.agents.actions import deterministic_proposal
from app.services.management.agents.evidence import deterministic_assessment
from app.services.management.agents.provider import ProviderReply
from app.services.management.agents.reviewer import deterministic_review
from app.services.management.context import canonical_hash
from app.services.management.demo import make_demo_snapshot
from app.services.management.economic_adapter import get_calculator
from app.services.management.orchestrator import execute_run


@compiles(JSONB, "sqlite")
def _jsonb_for_sqlite(type_, compiler, **kwargs):
    return "JSON"


def _seed(factory):
    with factory() as db:
        owner = User(
            id=uuid4(),
            username=f"lifecycle-{uuid4().hex}",
            name="Lifecycle test",
            role=UserRole.MANAGER,
        )
        db.add(owner)
        db.flush()
        project = Project(
            id=uuid4(),
            code=f"lifecycle-{uuid4().hex[:12]}",
            name="Isolated lifecycle fixture",
            owner_username=owner.username,
        )
        db.add(project)
        db.commit()
    return SimpleNamespace(factory=factory, owner=owner, project=project)


@pytest.fixture
def lifecycle_db(tmp_path):
    engine = create_engine(
        "sqlite:///" + str(tmp_path / "lifecycle.sqlite"),
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(engine, "connect")
    def enforce_foreign_keys(connection, record):
        connection.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(engine)
    try:
        yield _seed(sessionmaker(bind=engine, expire_on_commit=False))
    finally:
        engine.dispose()


@pytest.fixture
def postgres_lifecycle_db():
    raw = os.getenv("MANAGEMENT_TEST_DATABASE_URL")
    if not raw:
        pytest.skip("Explicit isolated PostgreSQL test URL was not provided")
    url = make_url(raw)
    database = url.database or ""
    if url.get_backend_name() != "postgresql" or not (
        database.startswith("test_") or database.endswith("_test")
    ):
        pytest.fail("Refusing database without an explicit test_ prefix or _test suffix")
    schema = "lifecycle_" + uuid4().hex
    # Only this random schema is created/dropped. No configured production URL.
    admin = create_engine(url)
    with admin.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_engine(
        url, execution_options={"schema_translate_map": {None: schema}}
    )
    try:
        Base.metadata.create_all(engine)
        yield _seed(sessionmaker(bind=engine, expire_on_commit=False))
    finally:
        engine.dispose()
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()


def _run(state, *, status="queued", mode="llm", calls=0, expired=False):
    snapshot = make_demo_snapshot(state.project.id)
    body = snapshot.model_dump(mode="json")
    digest = canonical_hash(body)
    with state.factory() as db:
        run = ManagementRun(
            id=uuid4(),
            project_id=state.project.id,
            created_by=state.owner.id,
            as_of=snapshot.as_of,
            mode=mode,
            status=status,
            idempotency_key=uuid4().hex,
            request_hash=digest,
            input_hash=digest,
            active_key=digest,
            snapshot=body,
            llm_calls=calls,
            lease_expires_at=utcnow() + timedelta(seconds=-1 if expired else 120),
        )
        db.add(run)
        db.flush()
        for role in ROLES:
            db.add(ManagementRunStep(run_id=run.id, role=role, status="pending"))
        db.commit()
    return run.id, snapshot


def _replies(snapshot):
    scenarios = [get_calculator().calculate(snapshot, s) for s in snapshot.scenarios]
    evidence = deterministic_assessment(snapshot)
    proposal = deterministic_proposal(snapshot, scenarios, evidence)
    review = deterministic_review(snapshot, scenarios, evidence, [])
    return [evidence, proposal, review]


class DurableProvider:
    name = "isolated-fake"
    model = "fixture-model"
    available = True

    def __init__(self, state, run_id, snapshot, *, initial_calls=0, duplicate=False):
        self.state, self.run_id = state, run_id
        self.replies = iter(_replies(snapshot))
        self.calls = 0
        self.initial_calls = initial_calls
        self.duplicate = duplicate

    async def complete(self, **kwargs):
        self.calls += 1
        with self.state.factory() as observer:
            saved = observer.get(ManagementRun, self.run_id)
            assert saved.llm_calls == self.initial_calls + self.calls
            assert saved.status == "running"
            step_calls = sum(
                observer.scalars(
                    select(ManagementRunStep.llm_calls).where(
                        ManagementRunStep.run_id == self.run_id,
                    )
                )
            )
            assert step_calls == self.calls
        if self.duplicate:
            assert execute_run(
                str(self.run_id),
                session_factory=self.state.factory,
                provider=self,
            ) == {"id": str(self.run_id), "claimed": False}
        return ProviderReply(next(self.replies).model_dump_json(), {"total_tokens": 10})


def test_stale_expiry_cannot_overwrite_completed_result(lifecycle_db):
    run_id, _ = _run(lifecycle_db, status="running", expired=True)
    with lifecycle_db.factory() as stale, lifecycle_db.factory() as worker:
        old = stale.get(ManagementRun, run_id)
        current = worker.get(ManagementRun, run_id)
        current.status = "completed"
        current.results = [{"preserve": "saved-calculation"}]
        current.active_key = None
        current.finished_at = utcnow()
        worker.commit()
        expire_run(stale, old)
        assert old.status == "completed"
        assert old.results == [{"preserve": "saved-calculation"}]
    with lifecycle_db.factory() as db:
        saved = db.get(ManagementRun, run_id)
        assert saved.status == "completed" and saved.error is None


def test_expiry_marks_only_unfinished_steps_and_preserves_results(lifecycle_db):
    run_id, _ = _run(lifecycle_db, status="running", expired=True)
    with lifecycle_db.factory() as db:
        run = db.get(ManagementRun, run_id)
        run.results = [{"total_cost": "44000.00"}]
        steps = {
            s.role: s
            for s in db.scalars(
                select(ManagementRunStep).where(
                    ManagementRunStep.run_id == run_id,
                )
            )
        }
        steps["evidence"].status = "completed"
        steps["evidence"].result = {"preserve": "assessment"}
        steps["calculation"].status = "completed"
        steps["actions"].status = "running"
        db.commit()
        expire_run(db, run)
    with lifecycle_db.factory() as db:
        saved = db.get(ManagementRun, run_id)
        assert saved.status == "partial" and saved.active_key is None
        assert saved.error == "worker_lease_expired" and saved.finished_at
        assert saved.results == [{"total_cost": "44000.00"}]
        steps = {
            s.role: s
            for s in db.scalars(
                select(ManagementRunStep).where(
                    ManagementRunStep.run_id == run_id,
                )
            )
        }
        assert steps["evidence"].status == "completed"
        assert steps["evidence"].result == {"preserve": "assessment"}
        for role in ("actions", "reviewer"):
            assert steps[role].status == "failed"
            assert steps[role].finished_at and steps[role].error == "worker_lease_expired"


def test_expired_queue_is_never_claimed_or_charged(lifecycle_db):
    run_id, snapshot = _run(lifecycle_db, expired=True)
    provider = DurableProvider(lifecycle_db, run_id, snapshot)
    assert execute_run(
        str(run_id), session_factory=lifecycle_db.factory, provider=provider
    ) == {
        "id": str(run_id),
        "claimed": False,
    }
    with lifecycle_db.factory() as db:
        run = db.get(ManagementRun, run_id)
        expire_run(db, run)
        assert run.status == "failed" and run.llm_calls == 0
        assert all(s.status == "failed" for s in db.scalars(select(ManagementRunStep)))
    assert provider.calls == 0


def test_duplicate_delivery_during_provider_and_after_completion_never_charges(
    lifecycle_db,
):
    run_id, snapshot = _run(lifecycle_db)
    provider = DurableProvider(lifecycle_db, run_id, snapshot, duplicate=True)
    result = execute_run(
        str(run_id), session_factory=lifecycle_db.factory, provider=provider
    )
    assert result["status"] == "completed" and result["llm_calls"] == 3
    assert provider.calls == 3
    assert execute_run(
        str(run_id), session_factory=lifecycle_db.factory, provider=provider
    ) == {
        "id": str(run_id),
        "claimed": False,
    }
    with lifecycle_db.factory() as db:
        assert db.get(ManagementRun, run_id).llm_calls == 3
        assert len(list(db.scalars(select(ManagementRunStep)))) == 4
    assert provider.calls == 3


@pytest.mark.parametrize("existing_calls", [5, 6])
def test_durable_counter_never_resets_on_worker_delivery(lifecycle_db, existing_calls):
    run_id, snapshot = _run(lifecycle_db, calls=existing_calls)
    provider = DurableProvider(
        lifecycle_db,
        run_id,
        snapshot,
        initial_calls=existing_calls,
    )
    result = execute_run(
        str(run_id), session_factory=lifecycle_db.factory, provider=provider
    )
    assert result["status"] == "partial" and result["llm_calls"] == 6
    assert provider.calls == 6 - existing_calls
    with lifecycle_db.factory() as db:
        assert db.get(ManagementRun, run_id).active_key is None
        steps = list(db.scalars(select(ManagementRunStep)))
        assert sum(s.llm_calls for s in steps) == provider.calls
        assert any(s.error == "llm_call_budget_exhausted" for s in steps)


def test_worker_cannot_resurrect_run_expired_during_provider_call(lifecycle_db):
    run_id, snapshot = _run(lifecycle_db)

    class ExpiringProvider(DurableProvider):
        async def complete(self, **kwargs):
            reply = await super().complete(**kwargs)
            with self.state.factory() as reaper:
                run = reaper.get(ManagementRun, run_id)
                run.lease_expires_at = utcnow() - timedelta(seconds=1)
                reaper.commit()
                expire_run(reaper, run)
            return reply

    provider = ExpiringProvider(lifecycle_db, run_id, snapshot)
    result = execute_run(
        str(run_id), session_factory=lifecycle_db.factory, provider=provider
    )
    assert result["status"] == "failed" and result["error"] == "worker_lease_expired"
    assert provider.calls == 1
    with lifecycle_db.factory() as db:
        run = db.get(ManagementRun, run_id)
        assert run.llm_calls == 1 and run.active_key is None
        assert run.assessment is None and run.results == []
        assert all(s.status == "failed" for s in db.scalars(select(ManagementRunStep)))


def test_postgres_concurrent_deliveries_make_only_one_run(postgres_lifecycle_db):
    state = postgres_lifecycle_db
    run_id, snapshot = _run(state)
    provider = DurableProvider(state, run_id, snapshot)
    barrier = threading.Barrier(2)

    def launch():
        barrier.wait(timeout=5)
        return execute_run(str(run_id), session_factory=state.factory, provider=provider)

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(launch) for _ in range(2)]
        outcomes = [future.result(timeout=10) for future in futures]
    assert sum(o.get("claimed") is False for o in outcomes) == 1
    assert sum(o.get("status") == "completed" for o in outcomes) == 1
    assert provider.calls == 3
    with state.factory() as db:
        assert db.get(ManagementRun, run_id).llm_calls == 3


def test_postgres_expiry_waits_for_terminal_transition(postgres_lifecycle_db):
    state = postgres_lifecycle_db
    run_id, _ = _run(state, status="running", expired=True)
    stale_loaded = threading.Event()
    worker_locked = threading.Event()
    expire_started = threading.Event()

    def expire_stale():
        with state.factory() as db:
            run = db.get(ManagementRun, run_id)
            stale_loaded.set()
            assert worker_locked.wait(timeout=5)
            expire_started.set()
            expire_run(db, run)
            return run.status

    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(expire_stale)
        assert stale_loaded.wait(timeout=5)
        with state.factory() as worker:
            run = worker.get(ManagementRun, run_id, with_for_update=True)
            run.status = "completed"
            run.results = [{"preserve": "completed"}]
            run.active_key = None
            worker_locked.set()
            assert expire_started.wait(timeout=5)
            worker.commit()
        assert future.result(timeout=5) == "completed"
    with state.factory() as db:
        run = db.get(ManagementRun, run_id)
        assert run.status == "completed" and run.error is None
