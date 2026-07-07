#!/usr/bin/env python3
"""THE single full-suite eval entrypoint (see CLAUDE.md "Eval Suite").

Runs every `status == "ready"` entry in the unified catalog
(agents/benchmarks/tasks.json), dispatching by runner:

  - runner == "agent"  → one run_benchmark.py invocation (its built-in
    evaluation: expected tools, receipts, approvals, timeouts)
  - runner == "vitest" → the entry's back-end blackbox script via `npx tsx`

`status == "incomplete"` entries are listed as skipped so the holding set is
always visible in the output — no silent truncation.

Usage:
    python benchmarks/run_eval_suite.py --port 3001          # full suite
    python benchmarks/run_eval_suite.py --list               # holding set only
    python benchmarks/run_eval_suite.py --only load-test-sias,smoke-backend-sms-supervisor
    python benchmarks/run_eval_suite.py --agent-only         # skip vitest smokes
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from benchmarks.benchmark_tasks import BenchmarkTask, all_tasks  # noqa: E402
from benchmarks.long_horizon import validate_catalog  # noqa: E402

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_BACKEND_DIR = _REPO_ROOT / "back-end"


def _print_holding_set(tasks: list[BenchmarkTask]) -> None:
    rose = [t for t in tasks if t.bench == "rose-bench"]
    pipeline = [t for t in tasks if t.bench == "pipeline-e2e"]
    incomplete = [t for t in tasks if t.status == "incomplete"]
    print(f"\nEval catalog: {len(tasks)} entries (agents/benchmarks/tasks.json)")
    print(f"\n  ROSE BENCH ({len(rose)}) — harness-independent capability evals:")
    for t in rose:
        flag = "" if t.status == "ready" else f"  [{t.status}]"
        print(f"    {t.name:<40} {t.title}{flag}")
    print(f"\n  PIPELINE E2E ({len(pipeline)}) — harness plumbing tests:")
    for t in pipeline:
        flag = "" if t.status == "ready" and t.runner == "agent" else f"  [{t.runner}:{t.status}]"
        print(f"    {t.name:<40} {t.title}{flag}")
    print(f"\n  INCOMPLETE ({len(incomplete)}) — missing fixtures/evaluators, excluded from suite runs:")
    for t in incomplete:
        todo = ""
        if t.environment and t.environment.get("context_notes", "").startswith("TODO"):
            todo = " — " + t.environment["context_notes"].split(".")[0]
        print(f"    {t.name:<40} {t.title}{todo}")
    print()


def _vitest_script_path(task: BenchmarkTask) -> Path:
    for evaluator in task.evaluators:
        for check in evaluator.get("checks", []):
            if check.get("type") == "vitest" and check.get("file"):
                return _REPO_ROOT / check["file"]
    raise ValueError(f"vitest task '{task.name}' declares no checks[].file")


def _run_vitest_task(task: BenchmarkTask, args: argparse.Namespace) -> bool:
    script = _vitest_script_path(task)
    rel = script.relative_to(_BACKEND_DIR)
    print(f"\n=== {task.name}: npx tsx {rel} ===")
    env = os.environ.copy()
    if args.url:
        env["TEST_BASE_URL"] = args.url.rstrip("/")
    elif args.port:
        env["TEST_BASE_URL"] = f"http://localhost:{args.port}"
    result = subprocess.run(["npx", "tsx", str(rel)], cwd=_BACKEND_DIR, timeout=task.timeout_seconds + 60, env=env)
    passed = result.returncode == 0
    print(f"=== {task.name}: {'PASS' if passed else 'FAIL'} (exit {result.returncode}) ===")
    return passed


def _run_agent_tasks(names: list[str], args: argparse.Namespace) -> bool:
    """Run agent evals through run_benchmark.py (the only agent-eval executor)."""
    ready_agent_names = {t.name for t in all_tasks() if t.runner == "agent" and t.status == "ready"}
    command = [sys.executable, str(Path(__file__).resolve().parent / "run_benchmark.py")]
    if set(names) == ready_agent_names:
        command += ["--suite", "all"]
    elif len(names) == 1:
        command += ["--task", names[0]]
    else:
        # run_benchmark's suite selection minus the complement keeps one process
        # (shared warmup, one results JSON) for arbitrary subsets.
        excluded = sorted(ready_agent_names - set(names))
        command += ["--suite", "all", "--exclude-task", ",".join(excluded)]
    if args.port:
        command += ["--port", str(args.port)]
    if args.url:
        command += ["--url", args.url]
    print(f"\n=== agent evals: {' '.join(command)} ===")
    result = subprocess.run(command, cwd=_REPO_ROOT / "agents")
    return result.returncode == 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, help="Local backend port (passed to run_benchmark.py)")
    parser.add_argument("--url", help="Backend base URL (passed to run_benchmark.py)")
    parser.add_argument("--list", action="store_true", help="Print the holding set and exit")
    parser.add_argument("--only", help="Comma-separated task names to run (any runner)")
    parser.add_argument("--agent-only", action="store_true", help="Skip external vitest smokes")
    parser.add_argument(
        "--bench",
        choices=["rose-bench", "pipeline-e2e"],
        help="Run only one bench axis (rose-bench = capability, pipeline-e2e = plumbing)",
    )
    args = parser.parse_args()

    validate_catalog()  # fail fast on a malformed catalog before spending anything
    tasks = all_tasks()

    if args.list:
        _print_holding_set(tasks)
        return 0

    by_name = {t.name: t for t in tasks}
    if args.only:
        names = [n.strip() for n in args.only.split(",") if n.strip()]
        unknown = sorted(set(names) - set(by_name))
        if unknown:
            print(f"Unknown task name(s): {', '.join(unknown)}")
            return 2
        selected = [by_name[n] for n in names]
    else:
        selected = [t for t in tasks if t.status == "ready"]

    if args.bench:
        selected = [t for t in selected if t.bench == args.bench]
    if args.agent_only:
        selected = [t for t in selected if t.runner == "agent"]

    skipped = [t for t in tasks if t.status == "incomplete"]
    agent_names = [t.name for t in selected if t.runner == "agent"]
    vitest_tasks = [t for t in selected if t.runner == "vitest"]

    results: dict[str, bool] = {}
    if agent_names:
        results["agent-suite"] = _run_agent_tasks(agent_names, args)
    for task in vitest_tasks:
        results[task.name] = _run_vitest_task(task, args)

    print("\n" + "=" * 60)
    print("  EVAL SUITE SUMMARY")
    for name, passed in results.items():
        print(f"    {'PASS' if passed else 'FAIL'}  {name}")
    if skipped and not args.only:
        print(f"    SKIP  {len(skipped)} incomplete evals (run --list for the holding set)")
    print("=" * 60)
    return 0 if all(results.values()) else 1


if __name__ == "__main__":
    os.environ.setdefault("PYTHONUNBUFFERED", "1")
    sys.exit(main())
