"""Recreate explicit demonstration fixtures; no database or network access."""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app.services.management.demo import (  # noqa: E402
    DEMO_PROJECT_ID,
    EPISODES,
    make_demo_snapshot,
)
from app.services.management.economic_adapter import (  # noqa: E402
    compare_scenarios,
    get_calculator,
)


def generate():
    expected = {}
    for episode in EPISODES:
        snapshot = make_demo_snapshot(DEMO_PROJECT_ID, episode)
        destination = Path(__file__).parent / f"{episode}.json"
        destination.write_text(
            snapshot.model_dump_json(indent=2) + "\n", encoding="utf-8"
        )
        results = [get_calculator().calculate(snapshot, s) for s in snapshot.scenarios]
        expected[episode] = {
            "input_hash": results[0].input_hash,
            "results": [
                r.model_dump(
                    mode="json",
                    include={
                        "scenario_id",
                        "status",
                        "idle_cost",
                        "extension_cost",
                        "intervention_cost",
                        "total_cost",
                        "incremental_delay_work_hours",
                    },
                )
                for r in results
            ],
            "conditional_avoidable_fast_vs_no_action": str(
                compare_scenarios(results[2], results[0])
            ),
        }
    (Path(__file__).parent / "expected_results.json").write_text(
        json.dumps(expected, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    generate()
