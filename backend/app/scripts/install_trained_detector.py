"""Install the private trained artifact from an authenticated local download.

Usage: python -m app.scripts.install_trained_detector /secure/best-deployment.pt
No credentials or private model bytes are distributed through the public repo.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import tempfile
from pathlib import Path

from app.services.trained_taxonomy import MODEL_FILENAME, MODEL_SHA256


def install(source: Path, destination: Path) -> Path:
    with source.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != MODEL_SHA256:
            raise ValueError(
                "Expected the exact completed construction-yolov8m-v2 checkpoint"
            )
    if destination.exists():
        with destination.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() == MODEL_SHA256:
                return destination
        raise ValueError(
            "Destination contains a different artifact; move it aside explicitly"
        )
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as output:
            temporary = Path(output.name)
            with source.open("rb") as incoming:
                shutil.copyfileobj(incoming, output, length=1024 * 1024)
        with temporary.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != MODEL_SHA256:
                raise ValueError("Copied artifact did not retain the expected checksum")
        # Link atomically without overwriting a concurrently installed destination.
        os.link(temporary, destination)
        return destination
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("source", type=Path)
    p.add_argument(
        "--destination",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "weights" / MODEL_FILENAME,
    )
    args = p.parse_args()
    install(args.source, args.destination)
    print(
        "Verified trained checkpoint installed: "
        + MODEL_FILENAME
        + " SHA256="
        + MODEL_SHA256
    )


if __name__ == "__main__":
    main()
