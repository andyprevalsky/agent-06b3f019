"""Per-run WMH context insertion: researched outcome distribution examples for one simulated world.

The returned state is a normal ``--wmh-initial-state-file`` override. Native
sessions copy their seed into ``initial_context``, so the examples sit in the
session-constant task evidence of every world-model request (the cached system
prefix on Azure). They are reference examples the model reasons from, never
enforced: the execution policy is unchanged and the model still writes its own
outcome distribution. Every example must cite the research it rests on. Nothing
is inserted into any agent's trajectory.
"""

from __future__ import annotations

import argparse
import json
import math
from copy import deepcopy
from pathlib import Path
from typing import Any

from benchmarks.long_horizon import validate_wmh_initial_state

OUTCOME_EXAMPLES_KEY = "outcome_distribution_examples"
EXAMPLES_TEXT = (
    "Outcome distribution examples for this run (researched base rates with their sources, listed in "
    f"structured.{OUTCOME_EXAMPLES_KEY}): when a candidate action resembles an example, use its "
    "distribution as a reference and reason from there about the current state and evidence. They are "
    "examples, not constraints; every outcome still requires its causal preconditions."
)
_EXAMPLE_KEYS = {"action", "applies_when", "typical_time", "outcomes", "sources"}


def _text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a nonempty string")
    return value.strip()


def _example(entry: Any) -> dict[str, Any]:
    if not isinstance(entry, dict) or set(entry) - _EXAMPLE_KEYS or not {"action", "outcomes", "sources"} <= set(entry):
        raise ValueError("Each example needs action, outcomes and sources, with optional applies_when and typical_time")
    action = _text(entry["action"], "Example action")
    sources = entry["sources"]
    if not isinstance(sources, list) or not sources:
        raise ValueError(f"{action}: cite at least one research source")
    outcomes, seen = [], set()
    if not isinstance(entry["outcomes"], list) or not entry["outcomes"]:
        raise ValueError(f"{action}: outcomes must be a nonempty list")
    for outcome in entry["outcomes"]:
        if not isinstance(outcome, dict) or set(outcome) != {"outcome", "probability"}:
            raise ValueError(f"{action}: each outcome needs exactly outcome and probability")
        name = _text(outcome["outcome"], f"{action}: outcome")
        probability = outcome["probability"]
        if isinstance(probability, bool) or not isinstance(probability, (int, float)):
            raise ValueError(f"{action}: {name} probability must be a number")
        if not math.isfinite(probability) or not 0 <= probability <= 1:
            raise ValueError(f"{action}: {name} probability must be between 0 and 1")
        if name.casefold() in seen:
            raise ValueError(f"{action}: duplicate outcome {name}")
        seen.add(name.casefold())
        outcomes.append({"outcome": name, "probability": float(probability)})
    if not math.isclose(math.fsum(o["probability"] for o in outcomes), 1.0, rel_tol=0, abs_tol=1e-6):
        raise ValueError(f"{action}: outcome probabilities must sum to 1")
    example = {"action": action}
    for key in ("applies_when", "typical_time"):
        if entry.get(key) is not None:
            example[key] = _text(entry[key], f"{action}: {key}")
    example["outcomes"] = outcomes
    example["sources"] = [_text(source, f"{action}: source") for source in sources]
    return example


def validated_outcome_examples(examples: list[Any]) -> list[dict[str, Any]]:
    """Normalize sourced outcome examples; each action once, each distribution summing to 1."""
    if not isinstance(examples, list) or not examples:
        raise ValueError("Outcome examples must be a nonempty list")
    validated = [_example(entry) for entry in examples]
    actions = [example["action"].casefold() for example in validated]
    if len(set(actions)) != len(actions):
        raise ValueError("Each action may have only one outcome example")
    return validated


def insert_outcome_examples(state: dict[str, Any], examples: list[Any], *, item_id: str) -> dict[str, Any]:
    """Return a copy of ``state`` carrying the validated, sourced outcome examples once."""
    validated = validated_outcome_examples(examples)
    result = deepcopy(validate_wmh_initial_state(state, item_id))
    if OUTCOME_EXAMPLES_KEY in result["structured"] or EXAMPLES_TEXT in result["scratchpad"]:
        raise ValueError(f"{item_id}: outcome examples were already inserted")
    result["structured"][OUTCOME_EXAMPLES_KEY] = validated
    result["scratchpad"] = (result["scratchpad"].rstrip() + "\n\n" + EXAMPLES_TEXT).strip()
    return validate_wmh_initial_state(result, item_id)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task", required=True, help="Catalog task whose wmh_initial_state is the base")
    parser.add_argument(
        "--examples",
        required=True,
        type=Path,
        help="JSON list of {action, outcomes: [{outcome, probability}], sources[, applies_when, typical_time]}",
    )
    parser.add_argument("--out", required=True, type=Path, help="Per-run --wmh-initial-state-file to write")
    args = parser.parse_args(argv)
    from benchmarks.benchmark_tasks import get_task_by_name

    task = get_task_by_name(args.task)
    if task is None or not task.wmh_initial_state:
        raise SystemExit(f"{args.task}: no catalog wmh_initial_state to extend")
    state = insert_outcome_examples(
        task.wmh_initial_state, json.loads(args.examples.read_text(encoding="utf-8")), item_id=args.task
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
