"""Validate and preserve original documents without executing their contents."""

from __future__ import annotations

import hashlib
import os
import re
import tempfile
import warnings
import zipfile
from pathlib import Path
from xml.etree import ElementTree

from fastapi import HTTPException, UploadFile
from PIL import Image
from pypdf import PdfReader

from app.core.config import settings

FORMATS = {
    ".pdf": ("application/pdf", "pdf"),
    ".docx": (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "text",
    ),
    ".png": ("image/png", "image"),
    ".jpg": ("image/jpeg", "image"),
    ".jpeg": ("image/jpeg", "image"),
}
MAX_XML_BYTES = 20 * 1024 * 1024


def safe_filename(name: str | None) -> str:
    name = (name or "").replace("\\", "/").split("/")[-1]
    name = "".join(c for c in name if c >= " " and c not in "\x7f")
    if not name or len(name) > 255:
        raise HTTPException(422, "Имя документа должно содержать от 1 до 255 символов")
    return name


def private_root() -> Path:
    root = settings.ppr_storage_root.resolve()
    public = settings.storage_local_root.resolve()
    if root == public or public in root.parents:
        raise HTTPException(503, "Закрытое хранилище документов настроено неверно")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    return root


def original_path(storage_key: str) -> Path:
    root = private_root()
    path = (root / storage_key).resolve()
    if root not in path.parents or not path.is_file():
        raise HTTPException(404, "Исходный документ недоступен")
    return path


def validate_document(path: Path, suffix: str) -> str | None:
    try:
        if suffix == ".pdf":
            with path.open("rb") as stream:
                if stream.read(5) != b"%PDF-":
                    raise ValueError("PDF signature")
                stream.seek(0)
                reader = PdfReader(stream, strict=True)
                if reader.is_encrypted:
                    raise ValueError("Encrypted PDF cannot be previewed")
                if not 1 <= len(reader.pages) <= 10000:
                    raise ValueError("Invalid PDF pages")
            return None
        if suffix == ".docx":
            with zipfile.ZipFile(path) as archive:
                entries = archive.infolist()
                if (
                    len(entries) > 2000
                    or sum(i.file_size for i in entries) > 100 * 1024 * 1024
                ):
                    raise ValueError("Archive limits")
                if any(
                    i.flag_bits & 1
                    or i.filename.startswith("/")
                    or ".." in i.filename.split("/")
                    for i in entries
                ):
                    raise ValueError("Unsafe archive")
                if "[Content_Types].xml" not in archive.namelist():
                    raise ValueError("Not an OOXML document")
                info = archive.getinfo("word/document.xml")
                if info.file_size > MAX_XML_BYTES:
                    raise ValueError("Document text too large")
                content_types = archive.read("[Content_Types].xml")
                if b"macroEnabled" in content_types or any(
                    i.filename.endswith("vbaProject.bin") for i in entries
                ):
                    raise ValueError("Macros are not supported")
                xml = archive.read(info)
                if re.search(rb"<!\s*(DOCTYPE|ENTITY)", xml, re.I):
                    raise ValueError("XML entities are not supported")
                root = ElementTree.fromstring(xml)
                ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
                if root.tag != ns + "document":
                    raise ValueError("Not a Word document")
                paragraphs = ["".join(p.itertext()) for p in root.iter(ns + "p")]
                return "\n\n".join(paragraphs)
        expected = "PNG" if suffix == ".png" else "JPEG"
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as image:
                if image.format != expected:
                    raise ValueError("Image type mismatch")
                image.verify()
        return None
    except Exception as exc:
        raise HTTPException(
            422,
            "Документ повреждён, защищён паролем или не соответствует выбранному формату",
        ) from exc


async def stage_upload(
    file: UploadFile,
) -> tuple[Path, str, int, str, str, str, str | None]:
    filename = safe_filename(file.filename)
    suffix = Path(filename).suffix.lower()
    if suffix not in FORMATS:
        raise HTTPException(422, "Загрузите ППР в PDF, DOCX, PNG или JPEG")
    root = private_root()
    fd, raw_path = tempfile.mkstemp(prefix=".upload-", dir=root)
    path = Path(raw_path)
    digest = hashlib.sha256()
    size = 0
    try:
        with os.fdopen(fd, "wb") as target:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > settings.max_ppr_upload_bytes:
                    raise HTTPException(
                        413, "Размер документа превышает допустимый предел"
                    )
                digest.update(chunk)
                target.write(chunk)
        if not size:
            raise HTTPException(422, "Документ пуст")
        text = validate_document(path, suffix)
        media_type, preview_kind = FORMATS[suffix]
        return path, filename, size, digest.hexdigest(), media_type, preview_kind, text
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    finally:
        await file.close()
