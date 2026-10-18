#!/usr/bin/env python3
"""A/B a world model on exact recorded requests: no calibration vs. researched outcome examples.

usage (from the repo's agents/ directory, with its venv active and .env loaded):
  PYTHONPATH=. python <skill>/scripts/calibration-replay.py --wmh-root DIR --session ID \
      --record PREFIX [--record PREFIX ...] --examples examples.json --out results.json

Each record is a ``rose.wmh_native_prediction.v1`` file in
``<wmh root>/native-predictions/<session>/``. Both arms reuse the record's exact
system prompt and evidence; only the seeded world state differs, exactly as a
run seeds it (initial context and the current state). Calls go through the same
Rose pool as serving, with no DEMO cache. Paid: two predictions per record.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from copy import deepcopy
from pathlib import Path

from wmh.providers.base import Message

from benchmarks.wmh_context_insertion import EXAMPLES_TEXT, OUTCOME_EXAMPLES_KEY, validated_outcome_examples
from benchmarks.wmh_outcomes import parse_distribution
from benchmarks.wmh_rose_provider import _to_rose_messages
from providers.rose import RoseClient

# Earlier soft event-rate insertions (October 10 runs) are removed for the control arm.
_LEGACY_KEY = "simulation_event_probabilities"
_LEGACY_TEXT = "Simulation calibration for this run"


def _without_calibration(world: dict) -> dict:
    world = deepcopy(world)
    structured = world.get("structured")
    if isinstance(structured, dict):
        structured.pop(_LEGACY_KEY, None)
        structured.pop(OUTCOME_EXAMPLES_KEY, None)
    if isinstance(world.get("scratchpad"), str):
        world["scratchpad"] = "\n\n".join(
            part for part in world["scratchpad"].split("\n\n") if not part.startswith(_LEGACY_TEXT)
        ).strip()
    return world


def _with_examples(world: dict, examples: list) -> dict:
    # A live world also carries runtime root fields, so insert exactly as
    # wmh_context_insertion does, without the catalog-seed validator.
    world = _without_calibration(world)
    world["structured"][OUTCOME_EXAMPLES_KEY] = validated_outcome_examples(examples)
    world["scratchpad"] = (world.get("scratchpad", "").rstrip() + "\n\n" + EXAMPLES_TEXT).strip()
    return world


async def _predict(system: str, evidence: dict, namespace: str, gate: asyncio.Semaphore) -> dict:
    call_ids = tuple(call["call_id"] for call in evidence["candidate_response"]["tool_calls"])
    messages = _to_rose_messages(system, [Message(role="user", content=json.dumps(evidence, ensure_ascii=False))])
    async with gate:
        response = await RoseClient().collect(
            pool="rose-wmh-gpt61",
            messages=messages,
            call_site="wmh_calibration_replay",
            dump_context=False,
            cache_namespace=namespace,
            result_required=True,
            max_tokens=16384,
        )
    try:
        distribution = parse_distribution(response.content, base_state=evidence["environment_state"], expected_call_ids=call_ids)
    except (ValueError, TypeError, KeyError) as exc:
        return {"error": str(exc)[:300], "actual_model": response.actual_model}
    return {
        "actual_model": response.actual_model,
        "outcomes": [
            {"id": o["id"], "probability": o["probability"], "description": o["description"][:200]}
            for o in distribution["outcomes"]
        ],
    }


def _recorded(record: dict) -> list:
    try:
        return [
            {"id": o["id"], "probability": o["probability"], "description": o["description"][:200]}
            for o in json.loads(record["response"]["content"])["outcomes"]
        ]
    except (KeyError, TypeError, ValueError):
        return []


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--wmh-root", required=True, type=Path)
    parser.add_argument("--session", required=True)
    parser.add_argument("--record", action="append", required=True, help="Prediction file name prefix")
    parser.add_argument("--examples", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--concurrency", type=int, default=8)
    args = parser.parse_args()
    examples = json.loads(args.examples.read_text())
    directory = args.wmh_root / "native-predictions" / args.session
    gate = asyncio.Semaphore(args.concurrency)
    cases = []
    for prefix in args.record:
        matches = sorted(directory.glob(f"{prefix}*.json"))
        if len(matches) != 1:
            raise SystemExit(f"{prefix}: expected exactly one record, found {len(matches)}")
        record = json.loads(matches[0].read_text())
        system, user = record["request"]["messages"][0]["content"], record["request"]["messages"][1]["content"]
        evidence = json.loads(user)
        control, treatment = deepcopy(evidence), deepcopy(evidence)
        for key in ("environment_state",):
            control[key] = _without_calibration(evidence[key])
            treatment[key] = _with_examples(evidence[key], examples)
        control["task"]["initial_context"] = _without_calibration(evidence["task"]["initial_context"])
        treatment["task"]["initial_context"] = _with_examples(evidence["task"]["initial_context"], examples)
        call = evidence["candidate_response"]["tool_calls"][0]
        cases.append((prefix, call, record, system, control, treatment))

    async def run(case):
        prefix, call, record, system, control, treatment = case
        arms = await asyncio.gather(
            _predict(system, control, f"wmh:replay:{prefix}:control", gate),
            _predict(system, treatment, f"wmh:replay:{prefix}:examples", gate),
        )
        goal = json.dumps(call.get("arguments"), ensure_ascii=False)
        return {
            "record": prefix,
            "tool": call["name"],
            "goal": goal[:600],
            "recorded_as_run": _recorded(record),
            "control_no_calibration": arms[0],
            "treatment_researched_examples": arms[1],
        }

    results = await asyncio.gather(*(run(case) for case in cases))
    args.out.write_text(json.dumps({"session": args.session, "cases": results}, indent=1) + "\n")
    for case in results:
        print(f"\n## {case['record']} {case['tool']}")
        for arm in ("recorded_as_run", "control_no_calibration", "treatment_researched_examples"):
            value = case[arm]
            outcomes = value if isinstance(value, list) else value.get("outcomes") or [{"id": value.get("error"), "probability": 0}]
            print(f"  {arm}: " + ", ".join(f"{o['id']} {o['probability']:.3g}" for o in outcomes))


if __name__ == "__main__":
    asyncio.run(main())
