"""Create a portable, read-only-by-convention catalogue SQLite snapshot.

This is a catalogue export, not a replacement for the application's PostgreSQL.
Server installation uses Alembic migrations, including its frozen catalogue seed.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path

from app.services.safety_catalog import DOCUMENTS, REQUIREMENTS, SANCTIONS


def export(destination: Path) -> dict[str, int]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Refuse replacement of an existing export or an operational database.
    with destination.open("xb"):
        pass
    try:
        with sqlite3.connect(destination) as db:
            for table, rows in [
                ("documents", DOCUMENTS),
                ("requirements", REQUIREMENTS),
                ("sanctions", SANCTIONS),
            ]:
                db.execute(
                    f"CREATE TABLE {table} (id TEXT PRIMARY KEY, "
                    "data TEXT NOT NULL CHECK(json_valid(data)))"
                )
                db.executemany(
                    f"INSERT INTO {table} VALUES (?, ?)",
                    [(r["id"], json.dumps(r, ensure_ascii=False)) for r in rows],
                )
            db.execute(
                "CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
            )
            db.executemany(
                "INSERT INTO metadata VALUES (?, ?)",
                [
                    ("checked_at", "2026-10-19"),
                    ("purpose", "Reference catalogue; not operational application DB"),
                    ("migration", "20261019_1600"),
                ],
            )
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    return {
        "documents": len(DOCUMENTS),
        "requirements": len(REQUIREMENTS),
        "sanctions": len(SANCTIONS),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    print(json.dumps(export(args.destination)))


if __name__ == "__main__":
    main()
