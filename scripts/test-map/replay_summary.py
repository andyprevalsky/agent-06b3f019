#!/usr/bin/env python3
"""Summarize replay_history.py output: recall and per-lane selection ratio.

Samples whose only non-test changes are declared inert (docs/markdown) are
test-only fixes, not change->test cases, and are excluded from recall.
`--not-regression sha:reason` excludes a manually triaged sample (moved or
environment-only test edits) and reports it.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import re
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import select_affected_tests as sat  # noqa: E402  (script-relative import)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("replay")
    parser.add_argument("--not-regression", action="append", default=[])
    args = parser.parse_args()
    inert = sat.load_edges()["no_tests"]
    triaged = dict(item.split(":", 1) for item in args.not_regression)
    rows = [json.loads(line) for line in open(args.replay)]
    valid, test_only, excluded = [], [], []
    for row in rows:
        product = row["product_changed"]
        if all(any(fnmatch.fnmatch(p, pat) for pat in inert) for p in product):
            test_only.append(row)
        elif any(row["sha"].startswith(s) for s in triaged):
            excluded.append(row)
        else:
            valid.append(row)
    expected = sum(len(v) for r in valid for v in r["expected"].values())
    missed = sum(len(v) for r in valid for v in r["missed"].values())
    commits_missed = [r for r in valid if r["missed"]]
    print(f"samples: {len(rows)} replayed; {len(valid)} valid; {len(test_only)} test-only (docs-only product change); "
          f"{len(excluded)} triaged not-regression")
    print(f"recall (test units): {expected - missed}/{expected} = {100 * (expected - missed) / max(expected, 1):.1f}%")
    print(f"recall (commits): {len(valid) - len(commits_missed)}/{len(valid)}")
    for r in commits_missed:
        print(f"  MISS {r['sha'][:9]} {r['subject'][:70]} {r['missed']}")
    for r in excluded:
        print(f"  excluded {r['sha'][:9]} ({triaged[next(s for s in triaged if r['sha'].startswith(s))]}) {r['missed']}")
    all_runs = [r for r in valid if r["all"]]
    print(f"fallback ALL: {len(all_runs)}/{len(valid)} = {100 * len(all_runs) / max(len(valid), 1):.0f}% of valid diffs")
    lanes = valid[0]["totals"].keys() if valid else []
    print(f"{'lane':26s} {'mean sel% (all diffs)':>22s} {'median':>7s} {'mean sel% (non-ALL)':>20s} {'lane skipped%':>14s}")
    for lane in lanes:
        ratios = [r["selected_counts"][lane] / max(r["totals"][lane], 1) for r in valid]
        narrowed = [r["selected_counts"][lane] / max(r["totals"][lane], 1) for r in valid if not r["all"]]
        skipped = sum(1 for r in valid if r["selected_counts"][lane] == 0)
        print(f"{lane:26s} {100 * statistics.mean(ratios):21.1f}% {100 * statistics.median(ratios):6.1f}% "
              f"{100 * statistics.mean(narrowed) if narrowed else 0:19.1f}% {100 * skipped / len(valid):13.0f}%")
    total_units = [sum(r["selected_counts"].values()) / sum(r["totals"].values()) for r in valid]
    print(f"overall unit selection: mean {100 * statistics.mean(total_units):.1f}%, median {100 * statistics.median(total_units):.1f}%")

    # Compare with today's /deploy path gating (Step 0 CHANGED_* lane skips) on the same input.
    base_units = sel_units = 0
    gate_expected = gate_missed = 0
    for r in valid:
        gated = path_gated_lanes(r["product_changed"])
        base_units += sum(r["totals"][lane] for lane in gated)
        sel_units += sum(r["selected_counts"].values())
        for lane, names in r["expected"].items():
            gate_expected += len(names)
            if lane not in gated:
                gate_missed += len(names)
    print(f"today's path gating on product-only diffs: {base_units} units, recall "
          f"{gate_expected - gate_missed}/{gate_expected}; selector: {sel_units} units "
          f"({100 * sel_units / max(base_units, 1):.0f}% of path gating)")
    return 0


def path_gated_lanes(changed: list[str]) -> set[str]:
    """Lanes /deploy Step 0 runs for this change set today (deploy.md)."""
    lanes = {"backend-structural", "deploy-structural-gates"}
    if any(p.startswith("back-end/") or p == "scripts/run-bench-hub-poller" for p in changed):
        lanes |= {"backend-blackbox", "backend-unit"}
    if any(p.startswith("agents/") for p in changed):
        lanes |= {"agents-blackbox", "agents-pytest"}
    if any(p.startswith("front-end/") for p in changed):
        lanes.add("frontend-vitest")
    if any(p.startswith("mac-app/") for p in changed):
        lanes.add("mac-app-vitest")
    cloud = re.compile(
        r"^(scripts/(run\.sh|setup-db\.sh|run-in-new-session\.py|run-bench|run-bench-cloud|run-bench-fleet|"
        r"run-predeploy-(cloud|local)|create-worktree-patch\.sh|cloudbench-|lib/cloudbench-env\.sh|tests/cloudbench-)|"
        r"agents/benchmarks/(cloud_batch_cleanup_test|cloudbench_(dependency_sync|recovery_review)_test|run_benchmark|"
        r"wall_clock_backstop_test)\.py)"
    )
    if any(cloud.match(p) for p in changed):
        lanes.add("cloudbench-controller")
    return lanes


if __name__ == "__main__":
    sys.exit(main())
