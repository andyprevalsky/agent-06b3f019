#!/usr/bin/env python3
"""A/B the world model's predictions: canonical snapshot layout vs. the append-only wire stream.

usage (from the repo's agents/ directory, with its venv active and .env loaded):
  PYTHONPATH=. python <skill>/scripts/layout-ab.py --wmh-root DIR --session ID \
      [--count 8] [--concurrency 8] --out results.json

Replays the session's recorded native requests in order through a fresh
world StreamBook (render only), then picks the requests whose streams carry the
most world-change operations plus unused reference items: the hardest cases for
change-based state and a shared reference library. For each it
calls the same Rose pool three times: snapshot layout, the snapshot layout
again (natural variation), and the stream. Reports patch validity against the
true current state, outcome counts, top outcomes and the probability-weighted
overlap of predicted patch targets between arms. Paid: 3 predictions per request.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from wmh.providers.base import Message

from benchmarks.wmh_outcomes import parse_distribution
from benchmarks.wmh_rose_provider import _to_rose_messages
from benchmarks.wmh_wire_stream import STREAM_GUIDE, StreamBook
from providers.rose import RoseClient


def _targets(distribution: dict) -> dict:
    """Probability mass per top-level patch target, e.g. /structured/investor_outreach."""
    mass: dict = {}
    for outcome in distribution["outcomes"]:
        for op in outcome.get("state_patch") or [{"path": "(no change)"}]:
            target = "/".join(op["path"].split("/")[:3])
            mass[target] = mass.get(target, 0) + outcome["probability"]
    total = sum(mass.values()) or 1
    return {key: value / total for key, value in mass.items()}


def _overlap(a: dict, b: dict) -> float:
    return sum(min(a.get(k, 0), b.get(k, 0)) for k in set(a) | set(b))


async def _predict(messages, evidence, namespace, gate):
    call_ids = tuple(call["call_id"] for call in evidence["candidate_response"]["tool_calls"])
    async with gate:
        try:
            response = await RoseClient().collect(
                pool="rose-wmh-gpt61", messages=messages, call_site="wmh_layout_ab", dump_context=False,
                cache_namespace=namespace, result_required=True, max_tokens=16384,
            )
        except Exception as exc:  # A transport failure voids this arm, not the comparison.
            return {"valid": False, "transport_error": f"{type(exc).__name__}: {str(exc)[:200]}"}
    usage = response.usage or {}
    result = {"actual_model": response.actual_model, "input": usage.get("prompt_tokens"),
              "cached": usage.get("cache_read_input_tokens"), "written": usage.get("cache_creation_input_tokens")}
    try:
        distribution = parse_distribution(response.content, base_state=evidence["environment_state"],
                                          expected_call_ids=call_ids, timed="elapsed_ms" in response.content)
    except (ValueError, TypeError, KeyError) as exc:
        return {**result, "valid": False, "error": str(exc)[:300]}
    outcomes = sorted(distribution["outcomes"], key=lambda o: -o["probability"])
    return {**result, "valid": True, "outcomes": len(outcomes), "targets": _targets(distribution),
            "top": [{"id": o["id"], "p": round(o["probability"], 3), "description": o["description"][:160]}
                    for o in outcomes[:3]]}


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--wmh-root", required=True, type=Path)
    parser.add_argument("--session", required=True)
    parser.add_argument("--count", type=int, default=8)
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    directory = args.wmh_root / "native-predictions" / args.session
    records = sorted(
        (json.loads(path.read_text()) for path in directory.glob("*.json")),
        key=lambda record: record.get("started_at_ms", 0),
    )
    records = [r for r in records if r.get("schema") == "rose.wmh_native_prediction.v1" and "request" in r]
    book, candidates = StreamBook(), []
    for record in records:
        system, user = record["request"]["messages"][0]["content"], record["request"]["messages"][1]["content"]
        evidence = json.loads(user)
        agent = evidence["candidate_response"]["tool_calls"][0].get("arguments", {}).get("agent_id") or "-"
        # One stream per world, as the provider renders it.
        rendered = await book.render("ab:world", evidence)
        if rendered is None:
            continue
        units, final = rendered
        changes = sum(len(json.loads(u).get("environment_state_changes", [])) for u in units)
        # Reference items present in the stream that this call does not use.
        library = set()
        for u in units:
            material = json.loads(u).get("reference_material") or {}
            library |= set(material.get("grounding_contexts", {})) | {e["transition_id"] for e in material.get("grounded_examples", [])}
        used = set(evidence.get("grounding_contexts", {})) | {e["transition_id"] for e in evidence.get("grounded_examples", [])}
        changes += len(library - used)
        stream = [{"role": "system", "content": system + STREAM_GUIDE}]
        stream += [{"role": "user", "content": [{"type": "text", "text": u, "cache_breakpoint": True}]} for u in units]
        stream.append({"role": "user", "content": final})
        canonical = _to_rose_messages(system, [Message(role="user", content=user)])
        candidates.append((changes, record["prediction_id"], agent, evidence, canonical, stream))
    picked = sorted(candidates, key=lambda c: -c[0])[: args.count]
    gate = asyncio.Semaphore(args.concurrency)

    async def run(case):
        changes, prediction_id, agent, evidence, canonical, stream = case
        arms = await asyncio.gather(
            _predict(canonical, evidence, f"wmh:session:ab-{prediction_id}-a", gate),
            _predict(canonical, evidence, f"wmh:session:ab-{prediction_id}-b", gate),
            _predict(stream, evidence, f"wmh:session:ab-{prediction_id}-s", gate),
        )
        snapshot, repeat, streamed = arms
        both = lambda x, y: round(_overlap(x["targets"], y["targets"]), 3) if x["valid"] and y["valid"] else None
        return {"prediction_id": prediction_id, "agent": agent, "stream_change_ops": changes,
                "snapshot": snapshot, "snapshot_repeat": repeat, "stream": streamed,
                "overlap_snapshot_vs_repeat": both(snapshot, repeat),
                "overlap_snapshot_vs_stream": both(snapshot, streamed),
                "overlap_repeat_vs_stream": both(repeat, streamed)}

    results = []

    async def run_and_save(case):
        result = await run(case)
        results.append(result)
        # Keep finished cases even if the process is interrupted later.
        args.out.write_text(json.dumps({"session": args.session, "cases": results}, indent=1) + "\n")
        return result

    results = await asyncio.gather(*(run_and_save(case) for case in picked))
    args.out.write_text(json.dumps({"session": args.session, "cases": results}, indent=1) + "\n")
    for case in results:
        print(f"\n## {case['prediction_id'][:8]} agent {case['agent'][:8]} stream changes + unused refs {case['stream_change_ops']}")
        for arm in ("snapshot", "snapshot_repeat", "stream"):
            value = case[arm]
            print(f"  {arm:16s} valid={value['valid']} outcomes={value.get('outcomes')} top="
                  + "; ".join(f"{o['id']} {o['p']}" for o in value.get("top", []))
                  + (f" ERROR {value.get('error') or value.get('transport_error')}" if not value["valid"] else ""))
        print(f"  overlap: snapshot~repeat {case['overlap_snapshot_vs_repeat']}  snapshot~stream "
              f"{case['overlap_snapshot_vs_stream']}  repeat~stream {case['overlap_repeat_vs_stream']}")


if __name__ == "__main__":
    asyncio.run(main())
