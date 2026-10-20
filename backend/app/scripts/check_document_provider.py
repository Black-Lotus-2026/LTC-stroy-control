"""Exercise the configured document agent without exposing its credentials."""

from __future__ import annotations

import asyncio
import json
import uuid

from app.services.document_search import (
    MachineryAnswer,
    agent_configuration_status,
    build_chain,
)


async def check() -> bool:
    status = agent_configuration_status()
    print(f"provider={status['provider']} model={status['model']}")
    if not status["configured"]:
        print("configuration=missing")
        return False
    facts = {
        "stage": "Разработка грунта",
        "catalog_stage": None,
        "cv_classes": [
            {
                "code": "MACHINERY_EXCAVATOR",
                "name": "Экскаватор",
                "raw_label": "excavator",
            }
        ],
        "fragments": [
            {
                "id": str(uuid.uuid4()),
                "text": "Для этапа разработки грунта требуется экскаватор.",
            }
        ],
    }
    try:
        response = await build_chain().ainvoke(
            {"facts_json": json.dumps(facts, ensure_ascii=False)}
        )
        answer = MachineryAnswer.model_validate(response)
    except Exception as exc:
        print(f"request=failed error_type={type(exc).__name__}")
        return False
    print(f"request=ok valid_answer=true findings={len(answer.items)}")
    return True


if __name__ == "__main__":
    raise SystemExit(0 if asyncio.run(check()) else 1)
