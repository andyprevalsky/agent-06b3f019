#!/usr/bin/env python3
"""Resolve `run-bench full`: every cloud benchmark whose last 3 runs passed, at k copies.

Eligibility reuses the predeploy selector's cloud rules (ready status, not
production-only, not local-only) and the sharded operator's own cloud-root
manifest rule (no rootless SMS, Mac relay or unassigned phone tasks). History is every recorded attempt in the
attempts ledger, newest last. When eligible tasks x k copies exceed the
measured CLI capacity, the tasks most relevant to this branch's changes are
kept: a task scores one point per changed file whose path triggers one of its
deploy categories. Ties keep smoke tasks first, then catalog order.

Capacity is the sharded operator's own admission: simultaneous copies stay
within the provider rate-limit registry cap (`cloudbench-provider-capacity.py`),
and free Fly organization Machine slots (`capacity_snapshot`, read-only) must
cover copies + controllers + canaries (`capacity_demand` over `plan_shards`). Names go to stdout, one per
line; the selection report goes to stderr.
"""
from __future__ import annotations

import argparse
import json
import os
import runpy
import sys
import tempfile
from pathlib import Path
from typing import Callable, Sequence

ROOT = Path(__file__).resolve().parents[1]
PASS_STREAK = 3
DEFAULT_RUNS = 2


def _history_ledger():
    """agents/benchmarks/history_ledger.py: a ledger is its base file plus per-writer shards."""
    import importlib.util

    source = Path(__file__).resolve().parents[1] / "agents" / "benchmarks" / "history_ledger.py"
    spec = importlib.util.spec_from_file_location("benchmark_history_ledger", source)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _predeploy():
    sys.path.insert(0, str(ROOT / "agents"))
    from benchmarks import select_predeploy_benches as spb

    return spb


def last_runs_passed(attempts_file: Path, streak: int = PASS_STREAK) -> set[str]:
    """Tasks whose last `streak` recorded attempts (all suites) all passed."""
    rows: dict[str, list[tuple[str, int, bool]]] = {}
    for index, line in enumerate(_history_ledger().read_lines(attempts_file)):  # base + shards
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        task = entry.get("task") if isinstance(entry, dict) else None
        if isinstance(task, str) and task:
            rows.setdefault(task, []).append(
                (str(entry.get("timestamp") or ""), index, bool(entry.get("passed")))
            )
    qualified = set()
    for task, attempts in rows.items():
        attempts.sort()
        if len(attempts) >= streak and all(passed for _, _, passed in attempts[-streak:]):
            qualified.add(task)
    return qualified


def relevance(task, changed_files: Sequence[str], spb) -> int:
    categories = spb.categories_for_task(task)
    return sum(
        1 for path in changed_files if categories & set(spb.categories_triggered_by_paths([path]))
    )


def max_tasks_within(free_slots: int, max_copies: int, runs: int, tasks: Sequence[str], coordinator) -> int:
    """Largest prefix of `tasks` within the provider copy cap whose sharded plan fits the free slots."""
    best = 0
    for count in range(1, len(tasks) + 1):
        plan = coordinator["plan_shards"](list(tasks[:count]), runs)
        if plan["copies"] > max_copies or coordinator["capacity_demand"](plan["copies"], plan["controllers"]) > free_slots:
            break
        best = count
    return best


def provider_copy_cap() -> int:
    """Maximum concurrent benches the provider rate-limit registry admits for this fleet's browser provider.

    Provider-scoped rows (Tilion's one shared account) bind only fleets on that provider, exactly as
    the capacity check that admits the fleet applies them.
    """
    capacity = runpy.run_path(str(ROOT / "scripts/cloudbench-provider-capacity.py"))
    registry = capacity["for_browser_provider"](capacity["load_registry"](), capacity["resolve_browser_provider"]())
    return int(registry["cap"])


def operator_eligible(repo_root: Path = ROOT) -> set[str]:
    """Names the sharded operator admits in a manifest (its `eligible_pool` cloud-root rule)."""
    sys.path.insert(0, str(repo_root / "scripts"))
    try:
        sample = runpy.run_path(str(repo_root / "scripts/fleet_infra_sample.py"))
        return set(sample["eligible_pool"](repo_root, None, require_cloud_root=True))
    finally:
        sys.path.remove(str(repo_root / "scripts"))


def measure_free_slots(agents_env: Path) -> int:
    operator = runpy.run_path(str(ROOT / "scripts/run-original600-controller.py"))
    capture = runpy.run_path(str(ROOT / "scripts/cloudbench-original-volume-capture.py"))
    token = operator["token_from_agents"](agents_env.read_bytes())
    previous = os.environ.get("FLY_API_TOKEN")
    os.environ["FLY_API_TOKEN"] = token  # the operator's flyctl app inventory reads it, as in its admission
    try:
        with tempfile.TemporaryDirectory(prefix="run-bench-full-capacity-") as directory:
            snapshot = operator["capacity_snapshot"](capture["Fly"], token, "personal", Path(directory), 1, summary=True)
    finally:
        if previous is None:
            os.environ.pop("FLY_API_TOKEN", None)
        else:
            os.environ["FLY_API_TOKEN"] = previous
    return int(snapshot["available_slots_conservative"])


def select_full(
    catalog: Path,
    attempts: Path,
    runs: int,
    changed_files: Sequence[str],
    free_slots: Callable[[], int],
    report=sys.stderr,
    admitted: Callable[[], set[str]] = operator_eligible,
    copy_cap: Callable[[], int] = provider_copy_cap,
) -> list[str]:
    spb = _predeploy()
    coordinator = runpy.run_path(str(ROOT / "scripts/cloudbench-shard-coordinator.py"))
    passed = last_runs_passed(attempts)
    tasks = spb.load_tasks(catalog)
    allowed = admitted()
    eligible = [t for t in tasks if t.name in passed and spb._eligible(t, "cloud", for_deploy=False) and t.name in allowed]
    excluded = sorted(passed - {t.name for t in eligible})
    order = {t.name: i for i, t in enumerate(tasks)}
    ranked = sorted(
        eligible,
        key=lambda t: (-relevance(t, changed_files, spb), not t.is_smoke, order[t.name]),
    )
    names = [t.name for t in ranked]
    cap = copy_cap()
    slots = free_slots()
    capacity = max_tasks_within(slots, cap, runs, names, coordinator)
    selected = names[:capacity]
    print(
        f"FULL: {len(eligible)} cloud task(s) passed their last {PASS_STREAK} runs; "
        f"k={runs}; capacity {capacity} task(s) ({cap} concurrent benches provider cap, "
        f"{slots} free Machine slots)",
        file=report,
    )
    if excluded:
        print(f"FULL: not cloud-eligible (status/local-only/production-only/rootless): {', '.join(excluded)}", file=report)
    if len(selected) < len(names):
        print(
            f"FULL: capacity binds; kept the {len(selected)} most relevant to {len(changed_files)} changed file(s); "
            f"dropped: {', '.join(names[len(selected):])}",
            file=report,
        )
    if not selected:
        raise SystemExit(
            f"FULL: no capacity for even one task at k={runs} ({cap} provider cap, {slots} free Machine slots)"
        )
    return selected


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--catalog", type=Path, default=ROOT / "agents/benchmarks/tasks.json")
    parser.add_argument("--attempts", type=Path, default=ROOT / "agents/benchmarks/history/task_attempts.jsonl")
    parser.add_argument("--runs", type=int, default=DEFAULT_RUNS)
    parser.add_argument("--agents-env", type=Path, default=ROOT / "agents/.env")
    parser.add_argument("--free-slots", type=int, help="use this measured free-slot count instead of reading Fly")
    parser.add_argument("--changed-file", action="append", help="override the branch diff (repeatable)")
    args = parser.parse_args(argv)
    if args.runs < 1:
        parser.error("--runs must be positive")
    changed = _predeploy().discover_changed_files(ROOT, args.changed_file)
    measure = (lambda: args.free_slots) if args.free_slots is not None else (lambda: measure_free_slots(args.agents_env))
    for name in select_full(args.catalog, args.attempts, args.runs, changed, measure):
        print(name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
