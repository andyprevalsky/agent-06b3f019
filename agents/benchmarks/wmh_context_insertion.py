"""Per-run WMH context insertion: operator-set event base rates for one simulated world.

The returned state is a normal ``--wmh-initial-state-file`` override. Native
sessions copy their seed into ``initial_context``, so the rates sit in the stable
task prefix of every world-model request. The execution policy is unchanged; the
model still writes its own outcome distribution and is only told these world
base rates. Nothing is inserted into any agent's trajectory.
"""

from __future__ import annotations

import argparse
import json
import math
from copy import deepcopy
from pathlib import Path
from typing import Any

from benchmarks.long_horizon import validate_wmh_initial_state

EVENT_PROBABILITIES_KEY = "simulation_event_probabilities"
CALIBRATION_TEXT = (
    "Simulation calibration for this run (operator-set world base rates, listed in "
    f"structured.{EVENT_PROBABILITIES_KEY}): when a possible result of an action is one of "
    "these events, give that outcome the stated probability and distribute the remainder "
    "across the other plausible results. These rates describe this simulated world only; "
    "an event still requires its causal preconditions."
)


def insert_event_probabilities(state: dict[str, Any], events: list[dict[str, Any]], *, item_id: str) -> dict[str, Any]:
    """Return a copy of ``state`` carrying the validated event base rates once."""
    if not isinstance(events, list) or not events:
        raise ValueError("Event probabilities must be a nonempty list")
    rates = []
    seen = set()
    for entry in events:
        if not isinstance(entry, dict) or set(entry) - {"event", "probability", "applies_when"}:
            raise ValueError("Each entry needs event and probability, with optional applies_when")
        event = entry.get("event")
        probability = entry.get("probability")
        if not isinstance(event, str) or not event.strip():
            raise ValueError("Each event needs a nonempty description")
        if isinstance(probability, bool) or not isinstance(probability, (int, float)):
            raise ValueError(f"{event}: probability must be a number")
        if not math.isfinite(probability) or not 0 <= probability <= 1:
            raise ValueError(f"{event}: probability must be between 0 and 1")
        key = event.strip().casefold()
        if key in seen:
            raise ValueError(f"{event}: duplicate event")
        seen.add(key)
        rate = {"event": event.strip(), "probability": float(probability)}
        if entry.get("applies_when") is not None:
            if not isinstance(entry["applies_when"], str) or not entry["applies_when"].strip():
                raise ValueError(f"{event}: applies_when must be a nonempty string")
            rate["applies_when"] = entry["applies_when"].strip()
        rates.append(rate)
    result = deepcopy(validate_wmh_initial_state(state, item_id))
    if EVENT_PROBABILITIES_KEY in result["structured"] or CALIBRATION_TEXT in result["scratchpad"]:
        raise ValueError(f"{item_id}: event probabilities were already inserted")
    result["structured"][EVENT_PROBABILITIES_KEY] = rates
    result["scratchpad"] = (result["scratchpad"].rstrip() + "\n\n" + CALIBRATION_TEXT).strip()
    return validate_wmh_initial_state(result, item_id)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task", required=True, help="Catalog task whose wmh_initial_state is the base")
    parser.add_argument("--events", required=True, type=Path, help="JSON list of {event, probability[, applies_when]}")
    parser.add_argument("--out", required=True, type=Path, help="Per-run --wmh-initial-state-file to write")
    args = parser.parse_args(argv)
    from benchmarks.benchmark_tasks import get_task_by_name

    task = get_task_by_name(args.task)
    if task is None or not task.wmh_initial_state:
        raise SystemExit(f"{args.task}: no catalog wmh_initial_state to extend")
    state = insert_event_probabilities(
        task.wmh_initial_state, json.loads(args.events.read_text(encoding="utf-8")), item_id=args.task
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
