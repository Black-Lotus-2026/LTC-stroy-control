"""Original document integrity, safe previews, duplicates and object authorization."""

import hashlib
import io
import zipfile
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
from pypdf import PdfWriter
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_current_user
from app.api.v1.ppr_documents import router
from app.core.config import settings
from app.db.base import Base
from app.db.session import get_db
from app.models import PprDocument, Project, User, UserRole
from tests.customer_control_testdata import customer_grant
from tests.test_video_service import compile_jsonb_sqlite  # noqa: F401


def pdf_bytes():
    stream = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    writer.write(stream)
    return stream.getvalue()


def docx_bytes(text="ППР: монтаж крана"):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as z:
        z.writestr(
            "[Content_Types].xml",
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
        )
        z.writestr(
            "word/document.xml",
            f'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>',
        )
    return stream.getvalue()


@pytest.fixture
def context(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "ppr_storage_root", tmp_path / "private")
    monkeypatch.setattr(settings, "storage_local_root", tmp_path / "public")
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine, expire_on_commit=False)
    with sessions() as db:
        owner = User(username="a", name="A", role=UserRole.MANAGER)
        other = User(username="b", name="B", role=UserRole.MANAGER)
        viewer = User(username="v", name="V", role=UserRole.VIEWER)
        admin = User(username="admin", name="Admin", role=UserRole.ADMIN)
        own = Project(code="A", name="A", owner_username="a")
        private = Project(code="B", name="B", owner_username="b")
        demo = Project(code="MANAGEMENT-DEMO", name="Демо", kind="shared_demo")
        db.add_all([owner, other, viewer, admin, own, private, demo])
        db.flush()
        customer_grant(db, own, owner)
        customer_grant(db, private, other)
        customer_grant(db, own, admin)
        db.commit()
    app = FastAPI()
    app.include_router(router, prefix="/api/v1")

    def session():
        with sessions() as db:
            yield db

    app.dependency_overrides[get_db] = session
    with TestClient(app) as client:
        client.event_hooks["request"].append(
            lambda request: request.headers.setdefault("Idempotency-Key", str(uuid4()))
        )
        yield client, app, sessions, owner, other, viewer, admin, own, private, demo
    engine.dispose()


def test_original_integrity_authorization_shared_demo_and_duplicates(context):
    client, app, sessions, owner, other, viewer, admin, own, private, demo = context
    base = f"/api/v1/projects/{own.id}/ppr-documents"
    assert client.get(base).status_code == 401
    app.dependency_overrides[get_current_user] = lambda: owner
    raw = pdf_bytes()
    response = client.post(base, files={"file": ("../../ППР.pdf", raw, "text/html")})
    assert response.status_code == 201, response.text
    item = response.json()
    assert item["filename"] == "ППР.pdf"
    assert item["sha256"] == hashlib.sha256(raw).hexdigest()
    assert item["size_bytes"] == len(raw)
    assert item["media_type"] == "application/pdf"
    assert "storage_key" not in item
    assert "display_text" not in item
    url = f'{base}/{item["id"]}'
    assert client.get(url).json()["preview_kind"] == "pdf"
    original = client.get(url + "/original")
    assert original.content == raw
    assert original.headers["content-disposition"].startswith("inline;")
    assert (
        client.get(url + "/original?download=true")
        .headers["content-disposition"]
        .startswith("attachment;")
    )
    assert (
        client.post(base, files={"file": ("newname.pdf", raw)}).json()["id"] == item["id"]
    )
    assert len(client.get(base).json()) == 1
    wrong_base = f"/api/v1/projects/{private.id}/ppr-documents"
    assert client.get(wrong_base).status_code == 404
    assert client.post(wrong_base, files={"file": ("x.pdf", raw)}).status_code == 404
    demo_base = f"/api/v1/projects/{demo.id}/ppr-documents"
    assert client.post(demo_base, files={"file": ("shared.pdf", raw)}).status_code == 403
    # Shared demo is prepared as an immutable fixture, never via user uploads.
    demo_key = f"demo/{hashlib.sha256(raw).hexdigest()}"
    demo_path = settings.ppr_storage_root / demo_key
    demo_path.parent.mkdir(parents=True)
    demo_path.write_bytes(raw)
    with sessions() as db:
        prepared = PprDocument(
            project_id=demo.id,
            filename="shared.pdf",
            media_type="application/pdf",
            size_bytes=len(raw),
            sha256=hashlib.sha256(raw).hexdigest(),
            storage_key=demo_key,
            uploaded_by="Public fixture",
            preview_kind="pdf",
        )
        db.add(prepared)
        db.commit()
        demo_item = {"id": str(prepared.id)}
    # Being in the shared demo is not publication. Only an explicitly reviewed
    # fixture manifest discloses this source; unknown historical rows stay private.
    assert client.get(demo_base).json() == []
    assert client.get(f'{demo_base}/{demo_item["id"]}/original').status_code == 404
    with sessions() as db:
        from app.schemas.customer_control import DemoManifestDTO

        db.get(Project, demo.id).demo_manifest = DemoManifestDTO(
            document_ids=[prepared.id]
        ).model_dump(mode="json")
        db.commit()
    assert demo_item["id"] != item["id"]
    app.dependency_overrides[get_current_user] = lambda: admin
    assert client.get(url + "/original").content == raw
    for user in (other, viewer, admin):
        app.dependency_overrides[get_current_user] = lambda u=user: u
        assert len(client.get(demo_base).json()) == 1
        assert client.get(f'{demo_base}/{demo_item["id"]}/original').content == raw
    app.dependency_overrides[get_current_user] = lambda: viewer
    assert client.post(demo_base, files={"file": ("x.pdf", raw)}).status_code == 403
    assert client.get(url).status_code == 404
    assert client.get(url + "/original").status_code == 404
    app.dependency_overrides[get_current_user] = lambda: other
    assert client.get(wrong_base + "/" + item["id"] + "/original").status_code == 404
    # Even a corrupt database storage key cannot escape the protected directory.
    app.dependency_overrides[get_current_user] = lambda: owner
    with sessions() as db:
        row = db.get(PprDocument, __import__("uuid").UUID(item["id"]))
        row.storage_key = "../../outside.pdf"
        db.commit()
    assert client.get(url + "/original").status_code == 404


def test_docx_text_and_scan_preview(context):
    client, app, _, owner, _, _, _, own, _, _ = context
    app.dependency_overrides[get_current_user] = lambda: owner
    base = f"/api/v1/projects/{own.id}/ppr-documents"
    raw = docx_bytes()
    item = client.post(base, files={"file": ("ППР.docx", raw)}).json()
    detail = client.get(f'{base}/{item["id"]}').json()
    assert detail["display_text"] == "ППР: монтаж крана"
    original = client.get(f'{base}/{item["id"]}/original')
    assert original.content == raw
    assert original.headers["content-disposition"].startswith("attachment;")
    image = io.BytesIO()
    Image.new("RGB", (8, 8), "white").save(image, format="PNG")
    raw_image = image.getvalue()
    response = client.post(base, files={"file": ("scan.png", raw_image)})
    assert response.status_code == 201
    assert response.json()["preview_kind"] == "image"
    assert client.get(f'{base}/{response.json()["id"]}/original').content == raw_image


@pytest.mark.parametrize(
    "filename,raw",
    [
        ("x.pdf", b"%PDF-fake"),
        ("x.pdf", b"<html>bad</html>"),
        ("x.html", b"<html>bad</html>"),
        ("x.docx", b"PKfake"),
        ("x.png", b"fake"),
        ("x.pdf", b""),
    ],
)
def test_rejects_invalid_and_unsupported_without_retaining_files(context, filename, raw):
    client, app, _, owner, _, _, _, own, _, _ = context
    app.dependency_overrides[get_current_user] = lambda: owner
    base = f"/api/v1/projects/{own.id}/ppr-documents"
    assert client.post(base, files={"file": (filename, raw)}).status_code == 422
    assert client.get(base).json() == []
    assert not list(settings.ppr_storage_root.glob(".upload-*"))


def test_upload_limit_and_xml_entities(context, monkeypatch):
    client, app, _, owner, _, _, _, own, _, _ = context
    app.dependency_overrides[get_current_user] = lambda: owner
    base = f"/api/v1/projects/{own.id}/ppr-documents"
    monkeypatch.setattr(settings, "max_ppr_upload_bytes", 8)
    assert client.post(base, files={"file": ("x.pdf", pdf_bytes())}).status_code == 413
    monkeypatch.setattr(settings, "max_ppr_upload_bytes", 50 * 1024 * 1024)
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr(
            "word/document.xml",
            '<!DOCTYPE foo [<!ENTITY x SYSTEM "file:///etc/passwd">]><foo>&x;</foo>',
        )
    assert (
        client.post(base, files={"file": ("x.docx", stream.getvalue())}).status_code
        == 422
    )
    assert client.get(base).json() == []
    assert not list(settings.ppr_storage_root.glob(".upload-*"))
