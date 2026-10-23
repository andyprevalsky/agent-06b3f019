"""Merge several local benchmark run contexts into one scorecard run context.

A suite sometimes has to run as more than one local invocation (for example a
selection that mixes guest-checkout tasks with tasks that need saved sign-ins:
one stack cannot serve both, see spawn_contract.tasks_require_disabled_saved_browser_auth).
This writes one run context that ``scripts/run-bench scorecard <out-dir>`` renders:

* ``report-card.json`` — every task once; a task in a later run dir replaces the
  same task from an earlier one. Costs add up across every run, superseded ones
  included, because every attempt was paid for.
* ``run.json`` — the per-task rows (agent id, failure reason) of the kept results,
  plus every superseded row with the run it came from.
* ``assembled-from.json`` + ``sources/<run>/`` — each run's own stack and benchmark
  cleanup receipts, copied unchanged, so the scorecard marks the merged run released
  only when every source stack recorded a clean cleanup.

Nothing is typed in: values come from the source run contexts, and anything they
did not record stays absent.

    python -m benchmarks.merge_run_contexts --out <dir> --label <name> <run-dir> [<run-dir> ...]
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional

_RECEIPTS = ("local-stack-owner.json", "local-stack-cleanup.status", "local-benchmark-owner.json")
_COST_KEYS = ("agents_llm_usd", "wmh_grounding_usd", "infra_usd")


def _read(path: Path) -> Dict[str, Any]:
    try:
        value = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _sum_or_none(values: List[Any]) -> Optional[float]:
    """Sum when every source recorded the value; otherwise no claim."""
    if not values or any(not isinstance(v, (int, float)) or isinstance(v, bool) for v in values):
        return None
    return round(sum(float(v) for v in values), 4)


def merge_run_contexts(out_dir: Path, run_dirs: List[Path], *, label: str = "") -> Path:
    if not run_dirs:
        raise ValueError("at least one run dir is required")
    cards = []
    for run_dir in run_dirs:
        card = _read(run_dir / "report-card.json")
        if not card.get("per_task"):
            raise ValueError(f"{run_dir}: no report-card.json with per_task rows")
        run = _read(run_dir / "run.json")
        if not run.get("tasks"):
            # A run whose final upload failed may not write run.json; its run record
            # (result-<stamp>_<id>_<task>.json, same schema) still holds every task row.
            records = sorted(run_dir.glob("result-*.json"))
            run = _read(records[-1]) if len(records) == 1 else run
        cards.append((run_dir, card, run))

    kept: Dict[str, Dict[str, Any]] = {}
    kept_run: Dict[str, Dict[str, Any]] = {}
    superseded: List[Dict[str, Any]] = []
    for run_dir, card, run in cards:
        run_tasks = {str(t.get("name")): t for t in run.get("tasks") or [] if isinstance(t, dict)}
        for row in card["per_task"]:
            name = str(row.get("name"))
            if name in kept:
                superseded.append({"task": name, "from_run": kept[name]["_source"], **{
                    k: kept[name].get(k) for k in ("status", "agent_id", "agent_url", "duration_s")},
                    "failure_reason": (kept_run.get(name) or {}).get("failure_reason")})
            kept[name] = {**row, "_source": run_dir.name}
            kept_run[name] = {**run_tasks.get(name, {"name": name}), "source_run": run_dir.name}

    per_task = [{k: v for k, v in row.items() if k != "_source"} for row in kept.values()]
    statuses = [row.get("status") for row in per_task]
    passed = statuses.count("passed")
    failed = sum(1 for s in statuses if s in ("failed", "error"))
    starts = [c.get("started_at") for _, c, _ in cards if isinstance(c.get("started_at"), (int, float))]
    ends = [c.get("finished_at") for _, c, _ in cards if isinstance(c.get("finished_at"), (int, float))]
    shas = {c.get("source_sha") for _, c, _ in cards}
    sha = next(iter(shas)) if len(shas) == 1 else None
    cost = {key: _sum_or_none([(c.get("cost") or {}).get(key) for _, c, _ in cards]) for key in _COST_KEYS}
    cost["total_usd"] = _sum_or_none([(c.get("cost") or {}).get("total_usd") for _, c, _ in cards])
    cost["fast_cache_hit_rate"] = None
    merged = {
        "run_id": label or out_dir.name,
        "source_sha": sha if isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{40}", sha) else None,
        "started_at": min(starts) if starts else None,
        "finished_at": max(ends) if ends else None,
        "elapsed_s": round(max(ends) - min(starts), 1) if starts and ends else None,
        "tasks": {
            "total": len(per_task),
            "running": statuses.count("running"),
            "completed": sum(1 for s in statuses if s in ("passed", "failed", "transient", "skipped", "error")),
            "queued": statuses.count("queued"),
        },
        "results": {
            "passed": passed,
            "failed": failed,
            "transient": statuses.count("transient"),
            "success_rate": round(passed / (passed + failed), 3) if passed + failed else 0.0,
        },
        "cost": cost,
        "per_task": per_task,
        "merged_from": [str(run_dir) for run_dir, _, _ in cards],
    }

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "report-card.json").write_text(json.dumps(merged, indent=2))
    (out_dir / "run.json").write_text(json.dumps(
        {"run_id": merged["run_id"], "tasks": list(kept_run.values()), "superseded": superseded}, indent=2))
    stacks = []
    for run_dir, _, _ in cards:
        target = out_dir / "sources" / run_dir.name
        target.mkdir(parents=True, exist_ok=True)
        names = [*_RECEIPTS, *(p.name for p in run_dir.glob("benchmark-cleanup-*.status"))]
        copied = False
        for name in names:
            source = run_dir / name
            if source.is_file() and not source.is_symlink():
                shutil.copy2(source, target / name)
                copied = True
        stacks.append({"lane": label or "local", "stack_run_id": run_dir.name,
                       "receipts": str(target.relative_to(out_dir)) if copied else None})
    (out_dir / "assembled-from.json").write_text(json.dumps({"stacks": stacks}, indent=1))
    return out_dir / "report-card.json"


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", required=True, help="new run context directory to write")
    parser.add_argument("--label", default="", help="run id / lane label shown on the scorecard")
    parser.add_argument("run_dirs", nargs="+", help="source run contexts, oldest first (later runs replace earlier tasks)")
    args = parser.parse_args(argv)
    card = merge_run_contexts(Path(args.out), [Path(d) for d in args.run_dirs], label=args.label)
    print(json.dumps({"report_card": str(card)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
