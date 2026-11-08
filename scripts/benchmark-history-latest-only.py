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
  python3 scripts/benchmark-history-latest-only.py --apply-parked --write
      # first replay the deploy smoke lane's parked rows
      # (.context/deploy-ledger-park, see run-predeploy-local) into the
      # tracked ledgers, then keep only each task's most recent run
  python3 scripts/benchmark-history-latest-only.py --write --qualify TASK=5
      # a qualification streak: keep TASK's 5 most recent deploy-eligible
      # branch attempts (not just the latest run) and exit 1, touching nothing,
      # unless all 5 exist and passed. A later predeploy attempt (eligibility
      # false) stays the task's ordinary latest run. Other tasks, and TASK's
      # attempts before those 5, are filtered exactly as without the flag.

A deploy's local smoke lane records its rows under .context/deploy-ledger-park
(BENCHMARK_HISTORY_PARK_DIR) so the tracked ledgers stay unchanged while the
other gates fingerprint the worktree. `--apply-parked` first checks that every
parked row parses (a truncated row refuses the publish before any ledger is
touched), then appends the parked attempt and duration rows to the tracked
ledgers byte-for-byte, replays the parked span rows through the normal
segmented span append, marks the parked files applied, and runs the
latest-only filter over the result. Rows an interrupted publish already
appended are skipped, so replaying the same park twice is a no-op.

Attempt and duration rows land in this branch's shard of each ledger
(`task_attempts.<YYYYMMDD>.<branch>.jsonl`, see
agents/benchmarks/history_ledger.py), never in the shared base files: GitHub's
mergeability check ignores merge=union, so two PRs appending to one shared file
conflict and force a main sync plus a full gate rerun. `--write` also moves any
branch row found in a shared base file into the shard (restoring the base file
to its base-ref rows), and `--check` fails while one remains.
"""
from __future__ import annotations

import argparse
import collections
import importlib.util
import json
import os
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

HISTORY_DIR = "agents/benchmarks/history"
ATTEMPTS = "task_attempts.jsonl"
DURATIONS = "task_durations.jsonl"
SPAN_PREFIX = "span_durations"
SPANS = f"{SPAN_PREFIX}.jsonl"
PARK_DIR = ".context/deploy-ledger-park"
PARK_DIR_ENV = "BENCHMARK_HISTORY_PARK_DIR"
SPAN_HISTORY_MODULE = Path("agents/benchmarks/span_history.py")
HISTORY_LEDGER_MODULE = Path("agents/benchmarks/history_ledger.py")
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
            # benchmark-history-backfill.py rows are merged history it already
            # selected latest-only per landing merge, not this branch's iterations
            row = _row(line) if b'"backfill_source"' in line else None
            branch.append(not (row and row.get("backfill_source")))
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


def qualified_attempts(ledger: Ledger, qualify: dict[str, int]) -> tuple[set[int], list[str]]:
    """Line indexes of each qualified task's latest N eligible branch attempts, and unmet qualifications.

    Only attempts that count for deploy eligibility are streak candidates (the history
    gate in select_predeploy_benches.py reads exactly those rows); a later predeploy
    attempt (eligibility false) is the task's ordinary latest run and never displaces
    the streak. A qualification is met when at least N eligible attempts exist and the
    latest N all passed.
    """
    by_task: dict[str, list[tuple[datetime, int, dict]]] = collections.defaultdict(list)
    for index, line in enumerate(ledger.lines):
        row = _row(line) if ledger.branch[index] else None
        window = _window(row) if row else None
        if (
            row is not None
            and window is not None
            and row.get("task") in qualify
            and row.get("counts_for_deploy_eligibility") is True
        ):
            by_task[str(row["task"])].append((window[1], index, row))
    protected: set[int] = set()
    problems: list[str] = []
    for task, need in qualify.items():
        latest = sorted(by_task.get(task, []), key=lambda a: (a[0], a[1]))[-need:]
        protected.update(index for _, index, _ in latest)
        if len(latest) < need:
            problems.append(f"{task}: {len(latest)} deploy-eligible branch attempt(s), qualification needs {need}")
            continue
        unmet = [str(row.get("agent_id") or index) for _, index, row in latest if row.get("passed") is not True]
        if unmet:
            problems.append(f"{task}: {len(unmet)} of its latest {need} eligible attempts did not pass ({', '.join(unmet)})")
    return protected, problems


def select_attempts(
    ledger: Ledger, protected: frozenset[int] | set[int] = frozenset()
) -> tuple[set[str], set[str], dict[str, datetime]]:
    """Mark superseded branch attempts; return kept/dropped agent ids and kept run starts.

    ``protected`` line indexes (a qualification streak) join their task's kept run.
    """
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
        run = [
            a for a in attempts if (a[2][0] <= latest_end and a[2][1] >= latest_start) or a[0] in protected
        ]
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


def _load_history_ledger(repo: Path):
    """The ledger shard helper of ``repo`` (this script's copy when absent, as for spans)."""
    source = repo / HISTORY_LEDGER_MODULE
    if not source.is_file():
        source = Path(__file__).resolve().parents[1] / HISTORY_LEDGER_MODULE
    spec = importlib.util.spec_from_file_location("benchmark_history_ledger", source)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _shard_rel(repo: Path, name: str) -> str:
    """This branch's shard of the canonical ledger ``name``, relative to ``repo``."""
    shard = _load_history_ledger(repo).shard_path(str(repo / HISTORY_DIR / name))
    return str(Path(shard).relative_to(repo))


def _ledger_name(repo: Path, rel: str) -> str | None:
    """ATTEMPTS / DURATIONS for a base file or one of its shards, else None."""
    return _load_history_ledger(repo).ledger_of(Path(rel).name)


def _load_span_history(repo: Path):
    """The span ledger writer, bound to ``repo``'s tracked history directory.

    The repository being published normally ships the module; a repository
    without it (tests) uses this script's own copy. Either way every path the
    module derives comes from the rebound HISTORY_DIR, never from this script's
    checkout."""
    source = repo / SPAN_HISTORY_MODULE
    if not source.is_file():
        source = Path(__file__).resolve().parents[1] / SPAN_HISTORY_MODULE
    spec = importlib.util.spec_from_file_location("benchmark_history_span_writer", source)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    module.HISTORY_DIR = str(repo / HISTORY_DIR)
    module.HISTORY_FILE = os.path.join(module.HISTORY_DIR, SPANS)
    return module


def _parked_rows(path: Path) -> list[bytes]:
    """The non-blank rows of one parked file, each verified to parse as a JSON
    object. A truncated or otherwise unparseable row (the smoke lane died
    mid-write) fails the whole publish before any ledger is touched: skipping
    it would mark the file applied while the tracked ledger lacks the row."""
    rows: list[bytes] = []
    for number, line in enumerate(path.read_bytes().splitlines(), start=1):
        if not line.strip():
            continue
        if _row(line) is None:
            raise RuntimeError(f"{path}:{number}: unparseable parked ledger row; nothing was applied")
        rows.append(line)
    return rows


def _published_rows(repo: Path, base: str) -> set[bytes]:
    """Every row of a tracked attempt, duration or span ledger that this branch
    changed relative to ``base``. A publish interrupted between the append and
    the rename (SIGKILL, power loss) leaves its rows in exactly these files, so
    the next replay can skip them instead of appending them again. Ledgers
    unchanged since ``base`` received nothing from the park and are not read."""
    published: set[bytes] = set()
    for rel in _changed_ledgers(repo, base):
        name = Path(rel).name
        if _ledger_name(repo, rel) or name.startswith(SPAN_PREFIX):
            published.update(line for line in (repo / rel).read_bytes().splitlines() if line.strip())
    return published


def apply_parked(repo: Path, park: Path, base: str) -> dict[str, int]:
    """Replay the smoke lane's parked rows into the tracked ledgers.

    Every parked file is parsed first; one bad row refuses the publish before
    any ledger changes. Attempt and duration rows are then appended
    byte-for-byte; span rows go through the segmented span append (90 MiB
    segments per branch and day) exactly as a direct write would have. Each
    applied parked file is renamed ``<name>.applied-<utc>`` so a second
    publish cannot apply it again, and a row that an interrupted publish
    already appended (present verbatim in a ledger this branch changed) is
    skipped, so replaying the same park twice yields the same ledgers.
    Returns the number of rows applied per ledger."""
    # The publish itself must never be redirected back into the park.
    os.environ.pop(PARK_DIR_ENV, None)
    applied: dict[str, int] = {}
    if not park.is_dir():
        print(f"no parked ledger rows under {park}")
        return applied
    parked = {name: _parked_rows(park / name) for name in (ATTEMPTS, DURATIONS, SPANS) if (park / name).is_file()}
    if not parked:
        print(f"no parked ledger rows under {park}")
        return applied
    published = _published_rows(repo, base)
    history = repo / HISTORY_DIR
    history.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    for name, lines in parked.items():
        fresh = [line for line in lines if line not in published]
        target = f"{HISTORY_DIR}/{name}"
        if name == SPANS:
            rows = [_row(line) for line in fresh]
            written = _load_span_history(repo).record_span_observations(rows) if rows else 0
            if written != len(rows):
                raise RuntimeError(f"{park / name}: applied {written} of {len(rows)} parked span rows")
        else:
            # Attempts/durations go to this branch's own shard, never the shared base file.
            target = _shard_rel(repo, name)
            if fresh:
                with (repo / target).open("ab") as handle:
                    handle.write(b"".join(line + b"\n" for line in fresh))
        applied[name] = len(fresh)
        (park / name).rename(park / f"{name}.applied-{stamp}")
        skipped = len(lines) - len(fresh)
        note = f" ({skipped} already applied by an interrupted publish)" if skipped else ""
        print(f"{target}: applied {len(fresh)} parked row(s) from {park}{note}")
    return applied


def _combined(ledgers: list[Ledger]) -> Ledger:
    """One ledger's base file and shards as a single sequence (a lone file is used as is)."""
    if len(ledgers) == 1:
        return ledgers[0]
    return Ledger(Path(), [line for ledger in ledgers for line in ledger.lines],
                  [flag for ledger in ledgers for flag in ledger.branch])


def _split_keep(combined: Ledger, ledgers: list[Ledger]) -> None:
    """Hand the combined keep flags back to the base file and each shard."""
    if len(ledgers) == 1:
        return
    offset = 0
    for ledger in ledgers:
        ledger.keep = combined.keep[offset:offset + len(ledger.lines)]
        offset += len(ledger.lines)


def _move_to_shards(repo: Path, ledgers: dict[str, Ledger], write: bool) -> int:
    """Move kept branch rows out of the shared base files into this branch's shards.

    The base file returns to exactly its base-ref rows, so the PR does not
    modify a path main also appends to. Rows are moved byte-for-byte; a row an
    interrupted move already wrote to the shard is not written twice."""
    moved_total = 0
    for name in (ATTEMPTS, DURATIONS):
        rel = f"{HISTORY_DIR}/{name}"
        ledger = ledgers.get(rel)
        if ledger is None:
            continue
        moving = [line for line, keep, branch in zip(ledger.lines, ledger.keep, ledger.branch) if keep and branch]
        if not moving:
            continue
        moved_total += len(moving)
        shard_rel = _shard_rel(repo, name)
        print(f"{rel}: move {len(moving)} branch row(s) to {shard_rel}")
        if not write:
            continue
        shard_path = repo / shard_rel
        shard = ledgers.get(shard_rel)
        existing = ([line for line, keep in zip(shard.lines, shard.keep) if keep] if shard is not None
                    else shard_path.read_bytes().splitlines() if shard_path.is_file() else [])
        present = set(existing)
        lines = existing + [line for line in moving if line not in present]
        shard_path.write_bytes(b"".join(line + b"\n" for line in lines))
        if shard is not None:
            shard.lines, shard.keep = lines, [True] * len(lines)
            shard.branch = [True] * len(lines)
        else:
            ledgers[shard_rel] = Ledger(shard_path, lines, [True] * len(lines))
        ledger.keep = [keep and not branch for keep, branch in zip(ledger.keep, ledger.branch)]
        ledger.path.write_bytes(b"".join(line + b"\n" for line, keep in zip(ledger.lines, ledger.keep) if keep))
        ledger.lines = [line for line, keep in zip(ledger.lines, ledger.keep) if keep]
        ledger.branch = [False] * len(ledger.lines)
        ledger.keep = [True] * len(ledger.lines)
    return moved_total


def run(repo: Path, base: str, write: bool, qualify: dict[str, int] | None = None) -> tuple[int, list[str]]:
    """(superseded rows found plus branch rows still in a shared base file, unmet qualifications).

    The attempts ledger is its base file plus per-writer shards, filtered as one
    sequence. Nothing is written while a qualification is unmet."""
    rels = _changed_ledgers(repo, base)
    ledgers = {rel: _load(repo, base, rel) for rel in rels}
    attempts = [ledger for rel, ledger in ledgers.items() if _ledger_name(repo, rel) == ATTEMPTS]
    if attempts:
        combined = _combined(attempts)
        protected, problems = qualified_attempts(combined, qualify or {})
        for problem in problems:
            print(f"qualification not met: {problem}")
        if problems:
            write = False
        kept_ids, dropped_ids, kept_start = select_attempts(combined, protected)
        _split_keep(combined, attempts)
        for rel, ledger in ledgers.items():
            name = Path(rel).name
            if _ledger_name(repo, rel) == DURATIONS:
                select_dependents(ledger, "task", kept_ids, dropped_ids, kept_start, timedelta(0))
            elif name.startswith(SPAN_PREFIX):
                select_dependents(ledger, "benchmark", kept_ids, dropped_ids, kept_start, SPAN_SLACK)
    else:
        print(f"no branch rows in {HISTORY_DIR}/{ATTEMPTS} or its shards relative to {base}")
        problems = [f"{task}: no branch rows, qualification needs {n}" for task, n in (qualify or {}).items()]
        if problems:
            return 0, problems
        # Nothing to filter; a duration row left in the shared base file still moves to the shard.
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
            ledger.lines, ledger.branch = kept, [b for b, k in zip(ledger.branch, ledger.keep) if k]
            ledger.keep = [True] * len(kept)
    moved = _move_to_shards(repo, ledgers, write)
    if dropped_total == 0 and moved == 0:
        print(f"benchmark history holds only each task's most recent branch run, in branch shards (base {base})")
    elif write:
        print(f"removed {dropped_total} superseded branch rows; moved {moved} to branch shards")
    return dropped_total + moved, problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--base", default="origin/main", help="ref whose ledger rows are never touched")
    parser.add_argument("--repo", default=".", help="repository root")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--write", action="store_true", help="rewrite the ledgers in place")
    mode.add_argument("--check", action="store_true", help="exit 1 when superseded rows remain")
    parser.add_argument(
        "--apply-parked", nargs="?", const=PARK_DIR, default=None, metavar="DIR",
        help=f"first replay the deploy smoke lane's parked rows (default {PARK_DIR} under the repo) "
             "into the tracked ledgers; requires --write",
    )
    parser.add_argument(
        "--qualify", action="append", default=[], metavar="TASK=N",
        help="keep TASK's N most recent deploy-eligible branch attempts as a qualification streak; exit 1 "
             "unless all N exist and passed (repeatable)",
    )
    args = parser.parse_args(argv)
    qualify: dict[str, int] = {}
    for spec in args.qualify:
        task, _, count = spec.rpartition("=")
        if not task or not count.isdigit() or int(count) < 1 or task in qualify:
            parser.error(f"--qualify expects one TASK=N (N >= 1) per task, got {spec!r}")
        qualify[task] = int(count)
    if args.apply_parked is not None and not args.write:
        parser.error("--apply-parked changes the tracked ledgers and requires --write")
    repo = Path(_git(Path(args.repo), "rev-parse", "--show-toplevel").stdout.decode().strip())
    if _git(repo, "rev-parse", "--verify", "--quiet", f"{args.base}^{{commit}}", check=False).returncode:
        print(f"base ref {args.base!r} not found; fetch it first", file=sys.stderr)
        return 2
    if args.apply_parked is not None:
        park = Path(args.apply_parked)
        apply_parked(repo, park if park.is_absolute() else repo / park, args.base)
    dropped, problems = run(repo, args.base, args.write, qualify)
    return 1 if problems or (args.check and dropped) else 0


if __name__ == "__main__":
    sys.exit(main())
