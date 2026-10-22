#!/usr/bin/env python3
"""Keep only each task's most recent branch run in the benchmark history ledgers.

A branch deploy iterates: run a bench, fix, rerun. The append-only ledgers in
agents/benchmarks/history/ then hold every superseded attempt, so failures of
code that never merged land on main and break pass streaks of the merged code.
Before a branch commits its ledger rows, this tool drops every branch row that
belongs to a superseded run and keeps each task's most recent run (its latest
attempt plus attempts that overlap it in time, i.e. concurrent copies of the
same run). The latest run is kept even when it failed: it describes the code
that actually merges. Rows already on the base ref are never touched.

  python3 scripts/benchmark-history-latest-only.py            # report only
  python3 scripts/benchmark-history-latest-only.py --write    # rewrite ledgers
  python3 scripts/benchmark-history-latest-only.py --check    # exit 1 if stale rows remain
"""
from __future__ import annotations

import argparse
import collections
import json
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

HISTORY_DIR = "agents/benchmarks/history"
ATTEMPTS = "task_attempts.jsonl"
DURATIONS = "task_durations.jsonl"
SPAN_PREFIX = "span_durations"
# Span rows of the kept run can be stamped slightly before its attempt start.
SPAN_SLACK = timedelta(seconds=60)


def _git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(("git", "-C", str(repo), *args), capture_output=True, check=check)


def _parse_time(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _row(line: bytes) -> dict | None:
    try:
        value = json.loads(line)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


@dataclass
class Ledger:
    path: Path
    lines: list[bytes]
    branch: list[bool]  # True when the line is not on the base ref
    keep: list[bool] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.keep = [True] * len(self.lines)


def _changed_ledgers(repo: Path, base: str) -> list[str]:
    tracked = _git(repo, "diff", "--name-only", base, "--", HISTORY_DIR).stdout.decode().split()
    untracked = _git(
        repo, "ls-files", "--others", "--exclude-standard", "--", HISTORY_DIR
    ).stdout.decode().split()
    names = sorted(set(tracked) | set(untracked))
    return [n for n in names if n.endswith(".jsonl") and (repo / n).is_file()]


def _load(repo: Path, base: str, rel: str) -> Ledger:
    path = repo / rel
    lines = path.read_bytes().splitlines()
    shown = _git(repo, "show", f"{base}:{rel}", check=False)
    remaining = collections.Counter(shown.stdout.splitlines() if shown.returncode == 0 else [])
    branch = []
    for line in lines:
        if remaining[line] > 0:
            remaining[line] -= 1
            branch.append(False)
        else:
            branch.append(True)
    return Ledger(path, lines, branch)


def _window(row: dict) -> tuple[datetime, datetime] | None:
    end = _parse_time(row.get("timestamp"))
    if end is None:
        return None
    try:
        duration = max(float(row.get("duration_seconds") or 0.0), 0.0)
    except (TypeError, ValueError):
        duration = 0.0
    return end - timedelta(seconds=duration), end


def select_attempts(ledger: Ledger) -> tuple[set[str], set[str], dict[str, datetime]]:
    """Mark superseded branch attempts; return kept/dropped agent ids and kept run starts."""
    by_task: dict[str, list[tuple[int, dict, tuple[datetime, datetime]]]] = collections.defaultdict(list)
    for index, line in enumerate(ledger.lines):
        if not ledger.branch[index]:
            continue
        row = _row(line)
        window = _window(row) if row else None
        if row is None or window is None or not row.get("task"):
            continue  # unparseable rows are left exactly as written
        by_task[str(row["task"])].append((index, row, window))
    kept_ids: set[str] = set()
    dropped_ids: set[str] = set()
    kept_start: dict[str, datetime] = {}
    for task, attempts in by_task.items():
        _, _, (latest_start, latest_end) = max(attempts, key=lambda item: item[2][1])
        run = [a for a in attempts if a[2][0] <= latest_end and a[2][1] >= latest_start]
        kept_start[task] = min(a[2][0] for a in run)
        run_indexes = {a[0] for a in run}
        for index, row, _ in attempts:
            agent_id = str(row.get("agent_id") or "")
            if index in run_indexes:
                if agent_id:
                    kept_ids.add(agent_id)
            else:
                ledger.keep[index] = False
                if agent_id:
                    dropped_ids.add(agent_id)
    return kept_ids, dropped_ids - kept_ids, kept_start


def select_dependents(
    ledger: Ledger,
    task_key: str,
    kept_ids: set[str],
    dropped_ids: set[str],
    kept_start: dict[str, datetime],
    slack: timedelta,
) -> None:
    """Drop durations/span rows that belong to a superseded run."""
    for index, line in enumerate(ledger.lines):
        if not ledger.branch[index]:
            continue
        row = _row(line)
        if row is None:
            continue
        agent_id = str(row.get("agent_id") or "")
        if agent_id in kept_ids:
            continue
        if agent_id in dropped_ids:
            ledger.keep[index] = False
            continue
        start = kept_start.get(str(row.get(task_key) or ""))
        stamp = _parse_time(row.get("timestamp"))
        if start is not None and stamp is not None and stamp < start - slack:
            ledger.keep[index] = False


def run(repo: Path, base: str, write: bool) -> int:
    rels = _changed_ledgers(repo, base)
    ledgers = {rel: _load(repo, base, rel) for rel in rels}
    attempts = ledgers.get(f"{HISTORY_DIR}/{ATTEMPTS}")
    if attempts is None:
        print(f"no branch rows in {HISTORY_DIR}/{ATTEMPTS} relative to {base}")
        return 0
    kept_ids, dropped_ids, kept_start = select_attempts(attempts)
    for rel, ledger in ledgers.items():
        name = Path(rel).name
        if name == DURATIONS:
            select_dependents(ledger, "task", kept_ids, dropped_ids, kept_start, timedelta(0))
        elif name.startswith(SPAN_PREFIX):
            select_dependents(ledger, "benchmark", kept_ids, dropped_ids, kept_start, SPAN_SLACK)
    dropped_total = 0
    for rel, ledger in ledgers.items():
        dropped = ledger.keep.count(False)
        if not dropped:
            continue
        dropped_total += dropped
        added = sum(ledger.branch)
        print(f"{rel}: drop {dropped} superseded of {added} branch rows")
        if write:
            kept = [line for line, keep in zip(ledger.lines, ledger.keep) if keep]
            shown = _git(repo, "cat-file", "-e", f"{base}:{rel}", check=False)
            if not kept and shown.returncode != 0:
                ledger.path.unlink()
            else:
                ledger.path.write_bytes(b"".join(line + b"\n" for line in kept))
    if dropped_total == 0:
        print(f"benchmark history holds only each task's most recent branch run (base {base})")
    elif write:
        print(f"removed {dropped_total} superseded branch rows")
    return dropped_total


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--base", default="origin/main", help="ref whose ledger rows are never touched")
    parser.add_argument("--repo", default=".", help="repository root")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--write", action="store_true", help="rewrite the ledgers in place")
    mode.add_argument("--check", action="store_true", help="exit 1 when superseded rows remain")
    args = parser.parse_args(argv)
    repo = Path(_git(Path(args.repo), "rev-parse", "--show-toplevel").stdout.decode().strip())
    if _git(repo, "rev-parse", "--verify", "--quiet", f"{args.base}^{{commit}}", check=False).returncode:
        print(f"base ref {args.base!r} not found; fetch it first", file=sys.stderr)
        return 2
    dropped = run(repo, args.base, args.write)
    return 1 if args.check and dropped else 0


if __name__ == "__main__":
    sys.exit(main())
