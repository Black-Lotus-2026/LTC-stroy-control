import uuid
from datetime import UTC, datetime
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db.base import Base
from app.models.ppr_document import PprDocument
from app.models.ppr_analysis import PprAnalysis, PprRequirement
from app.models.project import Project
from app.models.schedule import ScheduleTask
from app.models.user import User
from app.models.enums import UserRole
from app.services.ppr_analysis import (
    stage_matches_requirement,
    sync_ppr_requirements_with_schedule,
    sync_stage_with_ppr_requirements,
)


def test_stage_matches_requirement():
    stage1 = ScheduleTask(name="Разработка котлована под фундамент")
    stage2 = ScheduleTask(name="Монтаж сборных ж/б конструкций")

    req1 = PprRequirement(
        stage_name="Разработка грунта котлована",
        title="Разработка грунта котлована гидравлическими экскаваторами",
        quote="разработка грунта котлована гидравлическими экскаваторами",
    )
    req2 = PprRequirement(
        stage_name="Монтаж конструкций",
        title="Монтаж сборных железобетонных колонн краном",
        quote="монтаж сборных железобетонных колонн производить автокраном",
    )

    sc1_1 = stage_matches_requirement(stage1, req1)
    sc1_2 = stage_matches_requirement(stage2, req1)
    assert sc1_1 >= 0.75
    assert sc1_1 > sc1_2

    sc2_2 = stage_matches_requirement(stage2, req2)
    sc2_1 = stage_matches_requirement(stage1, req2)
    assert sc2_2 >= 0.75
    assert sc2_2 > sc2_1


def test_sync_ppr_requirements_with_schedule():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)

    with factory() as db:
        user = User(username="manager1", name="Manager", role=UserRole.MANAGER)
        project = Project(code="PPR-PRJ", name="Test PPR Project", owner_username="manager1")
        db.add_all([user, project])
        db.flush()

        task = ScheduleTask(
            project_id=project.id,
            name="Разработка котлована",
            order_index=1,
            planned_start=datetime.now(UTC),
            planned_end=datetime.now(UTC),
            machinery_probabilities={"excavator": 0.5, "dump_truck": 0.1},
            machinery_rule_sources={},
        )
        db.add(task)
        db.flush()

        doc = PprDocument(
            id=uuid.uuid4(),
            project_id=project.id,
            filename="ППР_Земляные_работы.docx",
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            size_bytes=1000,
            sha256="abc123sha",
            storage_key="test/key",
            uploaded_by="manager1",
            preview_kind="text",
        )
        db.add(doc)
        db.flush()

        analysis = PprAnalysis(
            id=uuid.uuid4(),
            document_id=doc.id,
            project_id=project.id,
            document_sha256=doc.sha256,
            status="COMPLETED",
        )
        db.add(analysis)
        db.flush()

        req_excavator = PprRequirement(
            id=uuid.uuid4(),
            analysis_id=analysis.id,
            project_id=project.id,
            document_id=doc.id,
            document_sha256=doc.sha256,
            page_number=1,
            fingerprint="fp1",
            title="Разработка котлована экскаватором",
            type="equipment_required",
            equipment_class="excavator",
            scope_text="",
            quote="разработка грунта котлована гидравлическими экскаваторами",
            quote_verified=True,
            detector_supported=True,
            active=False,
            applicability="manual",
            stage_name="Разработка грунта котлована",
            stage_id=None,
            extraction_method="converted_pdf",
        )
        req_dump_truck = PprRequirement(
            id=uuid.uuid4(),
            analysis_id=analysis.id,
            project_id=project.id,
            document_id=doc.id,
            document_sha256=doc.sha256,
            page_number=1,
            fingerprint="fp2",
            title="Вывоз грунта самосвалами",
            type="equipment_required",
            equipment_class="dump_truck",
            scope_text="",
            quote="погрузка грунта в автосамосвалы для вывоза",
            quote_verified=True,
            detector_supported=True,
            active=False,
            applicability="manual",
            stage_name="Разработка котлована",
            stage_id=None,
            extraction_method="converted_pdf",
        )
        db.add_all([req_excavator, req_dump_truck])
        db.commit()

        # Execute reconciliation
        sync_ppr_requirements_with_schedule(db, analysis)
        db.commit()

        # Verify
        db.refresh(task)
        db.refresh(req_excavator)
        db.refresh(req_dump_truck)

        assert req_excavator.stage_id == task.id
        assert req_dump_truck.stage_id == task.id
        assert req_excavator.applicability == "stage"

        # Discrepancies resolved in accordance with PPR
        assert task.machinery_probabilities["excavator"] == 0.95
        assert task.machinery_probabilities["dump_truck"] == 0.95
        assert task.machinery_rule_sources["MACHINERY_EXCAVATOR"]["source"] == "ppr"
        assert task.machinery_rule_sources["MACHINERY_DUMP_TRUCK"]["source"] == "ppr"
        assert task.machinery_rule_sources["MACHINERY_EXCAVATOR"]["rule"] == "equipment_required"
        assert task.machinery_rule_sources["MACHINERY_EXCAVATOR"]["document_name"] == "ППР_Земляные_работы.docx"


def test_sync_stage_with_ppr_requirements_on_schedule_creation():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)

    with factory() as db:
        user = User(username="manager1", name="Manager", role=UserRole.MANAGER)
        project = Project(code="PPR-PRJ2", name="Test PPR Project 2", owner_username="manager1")
        db.add_all([user, project])
        db.flush()

        doc = PprDocument(
            id=uuid.uuid4(),
            project_id=project.id,
            filename="ППР_Фундаменты.docx",
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            size_bytes=1000,
            sha256="abc456sha",
            storage_key="test/key2",
            uploaded_by="manager1",
            preview_kind="text",
        )
        db.add(doc)
        db.flush()

        analysis = PprAnalysis(
            id=uuid.uuid4(),
            document_id=doc.id,
            project_id=project.id,
            document_sha256=doc.sha256,
            status="COMPLETED",
        )
        db.add(analysis)
        db.flush()

        req_crane = PprRequirement(
            id=uuid.uuid4(),
            analysis_id=analysis.id,
            project_id=project.id,
            document_id=doc.id,
            document_sha256=doc.sha256,
            page_number=2,
            fingerprint="fp3",
            title="Монтаж фундаментов автокраном",
            type="equipment_required",
            equipment_class="truck_crane",
            scope_text="",
            quote="монтаж фундаментных блоков производить стреловым автокраном",
            quote_verified=True,
            detector_supported=True,
            active=False,
            applicability="manual",
            stage_name="Монтаж блоков фундамента",
            stage_id=None,
            extraction_method="converted_pdf",
        )
        db.add(req_crane)
        db.commit()

        # Now create new stage
        new_task = ScheduleTask(
            project_id=project.id,
            name="Монтаж блоков фундамента",
            order_index=1,
            planned_start=datetime.now(UTC),
            planned_end=datetime.now(UTC),
            machinery_probabilities={"truck_crane": 0.3},
            machinery_rule_sources={},
        )
        db.add(new_task)
        sync_stage_with_ppr_requirements(db, new_task)
        db.commit()

        db.refresh(new_task)
        db.refresh(req_crane)

        assert req_crane.stage_id == new_task.id
        assert new_task.machinery_probabilities["truck_crane"] == 0.95
        assert new_task.machinery_rule_sources["MACHINERY_TRUCK_CRANE"]["source"] == "ppr"
