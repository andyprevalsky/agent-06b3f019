#!/usr/bin/env python3
"""Replay fix commits through select_affected_tests.py and measure recall.

For each non-merge fix/RCA commit that changed both product code and at least
one lane test file, the test files it touched are the regression tests that
fail on the pre-fix code. The selector is run on the commit's tree with ONLY
the non-test changes as input; recall requires every touched test unit to be
selected. Selection ratio = selected units / total units per lane.

  scripts/test-map/replay_history.py --since 2026-10-01 --limit 150 --jobs 4 \
      --out /tmp/replay.jsonl
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import select_affected_tests as sat  # noqa: E402  (script-relative import)

ROOT = sat.ROOT
FIX_RE = re.compile(r"\b(fix|fixes|fixed|rca|regression|repro)\b", re.I)


def git(*args: str) -> str | bytes:
    # NUL-delimited Git path records are byte identities, not UTF-8 text.
    return subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True, text="-z" not in args).stdout


def candidates(since: str, ref: str, limit: int, until: str = "") -> list[tuple[str, str, list[str]]]:
    window = [f"--since={since}"] + ([f"--until={until}"] if until else [])
    out = git("log", "--no-merges", *window, "--format=%H%x01%s", ref)
    rows = []
    for line in out.splitlines():
        sha, _, subject = line.partition("\x01")
        if not FIX_RE.search(subject):
            continue
        raw = git("diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "--no-renames", "-z", sha)
        files = [name.decode("utf-8", "surrogateescape") for name in raw.split(b"\0") if name]
        tests = [f for f in files if sat.is_test_file(f)]
        product = [f for f in files if not sat.is_test_file(f) and not f.startswith(sat.EXCLUDED_TOP)]
        if tests and product:
            rows.append((sha, subject, files))
    return rows[:limit]


def replay(row: tuple[str, str, list[str]]) -> dict:
    sha, subject, files = row
    sat.SRC = sat.Source(sha)
    selector = sat.Selector()
    tests_changed = {f for f in files if sat.is_test_file(f)}
    product = [f for f in files if not sat.is_test_file(f) and not f.startswith(sat.EXCLUDED_TOP)]
    expected: dict[str, set[str]] = {}
    for lane in selector.lanes.values():
        for unit in lane.units:
            if any(r in tests_changed for r in unit.roots if sat.is_test_file(r)):
                expected.setdefault(lane.name, set()).add(unit.name)
    sel = selector.select(product)
    missed = {lane: sorted(names - sel.selected[lane]) for lane, names in expected.items()}
    missed = {k: v for k, v in missed.items() if v}
    return {
        "sha": sha,
        "subject": subject[:120],
        "product_changed": product,
        "all": sel.all_lanes,
        "reasons": sel.reasons[:5],
        "expected": {k: sorted(v) for k, v in expected.items()},
        "missed": missed,
        "selected_counts": {k: len(v) for k, v in sel.selected.items()},
        "totals": sel.totals,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--since", default="2026-10-01")
    parser.add_argument("--ref", default="main")
    parser.add_argument("--until", default="")
    parser.add_argument("--limit", type=int, default=150)
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--out", required=True)
    parser.add_argument("--sha", action="append", default=[])
    args = parser.parse_args()
    rows = candidates(args.since, args.ref, 100000, args.until)
    if args.sha:
        rows = [r for r in rows if any(r[0].startswith(s) for s in args.sha)]
    elif len(rows) > args.limit:
        step = len(rows) / args.limit
        rows = [rows[int(i * step)] for i in range(args.limit)]
    print(f"replaying {len(rows)} commits", file=sys.stderr)
    with open(args.out, "w") as out, ProcessPoolExecutor(args.jobs) as pool:
        for result in pool.map(replay, rows):
            out.write(json.dumps(result) + "\n")
            out.flush()
            flag = "MISS" if result["missed"] else ("ALL " if result["all"] else "ok  ")
            print(f"{flag} {result['sha'][:9]} {result['subject'][:70]} {result['missed'] or ''}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
