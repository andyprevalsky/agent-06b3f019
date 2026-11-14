#!/usr/bin/env python3
"""THE single full-suite benchmark entrypoint (see CLAUDE.md "Benchmarks" and agents/benchmarks/README.md).

Runs every `status == "ready"` benchmark entry in the unified catalog
(agents/benchmarks/tasks.json) through one run_benchmark.py invocation
(expected tools, receipts, approvals, timeouts).

`status == "incomplete"` entries are listed as skipped so the holding set is
always visible in the output — no silent truncation.

Usage:
    python benchmarks/run_eval_suite.py --port 3001          # full suite
    python benchmarks/run_eval_suite.py --list               # holding set only
    python benchmarks/run_eval_suite.py --only test-mass-agent-run-0,browser-agent
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from benchmarks.benchmark_tasks import BenchmarkTask, all_tasks
from benchmarks.long_horizon import validate_catalog
from benchmarks.polar_catalog import POLAR_GROUP, is_polar_bench_task

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def _print_holding_set(tasks: list[BenchmarkTask]) -> None:
    # retired tasks are dead — never run, never listed (history-only names)
    tasks = [t for t in tasks if t.status != "retired"]
    polar = [t for t in tasks if is_polar_bench_task(t)]
    non_polar = [t for t in tasks if not is_polar_bench_task(t)]
    rose = [t for t in non_polar if t.bench == "rose-bench"]
    pipeline = [t for t in non_polar if t.bench == "pipeline-e2e"]
    incomplete = [t for t in non_polar if t.status == "incomplete"]
    print(f"\nEval catalog: {len(tasks)} entries (tasks.json + polar/)")
    print(f"\n  ROSE BENCH ({len(rose)}) — harness-independent capability evals:")
    for t in rose:
        flag = "" if t.status == "ready" else f"  [{t.status}]"
        print(f"    {t.name:<40} {t.title}{flag}")
    print(f"\n  PIPELINE E2E ({len(pipeline)}) — harness plumbing tests:")
    for t in pipeline:
        flag = "" if t.status == "ready" else f"  [{t.status}]"
        print(f"    {t.name:<40} {t.title}{flag}")
    print(
        f"\n  POLAR BENCH ({len(polar)}) — Odysseys + BU Bench V1 "
        f"(opt-in via --suite {POLAR_GROUP}; excluded from default suite runs):"
    )
    for t in polar[:12]:
        flag = "" if t.status == "ready" else f"  [{t.status}]"
        print(f"    {t.name:<40} {t.title}{flag}")
    if len(polar) > 12:
        print(f"    … +{len(polar) - 12} more (run: python benchmarks/run_benchmark.py --suite {POLAR_GROUP} --list)")
    print(f"\n  INCOMPLETE ({len(incomplete)}) — missing fixtures/evaluators, excluded from suite runs:")
    for t in incomplete:
        todo = ""
        if t.environment and t.environment.get("context_notes", "").startswith("TODO"):
            todo = " — " + t.environment["context_notes"].split(".")[0]
        print(f"    {t.name:<40} {t.title}{todo}")
    print()


def _run_agent_tasks(names: list[str], args: argparse.Namespace) -> bool:
    """Run agent evals through run_benchmark.py (the only agent-eval executor)."""
    # Default suite excludes polar-bench; keep the ready-name set aligned so
    # `--suite all` / exclude-task math does not accidentally pull Odysseys/BU in.
    ready_agent_names = {
        t.name for t in all_tasks() if t.status == "ready" and not is_polar_bench_task(t)
    }
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
    parser.add_argument("--only", help="Comma-separated benchmark task names to run")
    parser.add_argument(
        "--bench",
        choices=["rose-bench", "pipeline-e2e", "process-bench"],
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
        # Polar-bench is opt-in (`--suite polar-bench` / explicit --only names).
        selected = [t for t in tasks if t.status == "ready" and not is_polar_bench_task(t)]

    if args.bench:
        selected = [t for t in selected if "process" in t.tags] if args.bench == "process-bench" else [
            t for t in selected if t.bench == args.bench
        ]
    skipped = [t for t in tasks if t.status == "incomplete"]
    agent_names = [t.name for t in selected]

    results: dict[str, bool] = {}
    if agent_names:
        results["agent-suite"] = _run_agent_tasks(agent_names, args)

    print("\n" + "=" * 60)
    print("  EVAL SUITE SUMMARY")
    for name, passed in results.items():
        print(f"    {'PASS' if passed else 'FAIL'}  {name}")
    if skipped and not args.only:
        print(f"    SKIP  {len(skipped)} incomplete evals (run --list for the holding set)")
    print("=" * 60)
    return 0 if all(results.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
