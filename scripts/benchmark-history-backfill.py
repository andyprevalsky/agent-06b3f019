#!/usr/bin/env python3
"""Backfill the benchmark attempts ledger with runs of merged code recorded elsewhere.

CLAUDE.md: every run of code merged into main lands in
agents/benchmarks/history/task_attempts.jsonl (passes also in
task_durations.jsonl), wherever it ran; pre-merge iterations land latest-only
and runs of never-merged code stay out.

Sources:
  hub        prod Benchmark Hub run index (GET /api/benchmarks/runs, read-only).
             A row is eligible only when its run, or its campaign group, carries
             a `code` identity `<ref>@<sha> (clean | pinned; local patch excluded)`
             whose sha is merged into --base. `+patch` runs executed unmerged
             bytes. Rows without a source identity are reported as UNBOUND and
             left out; the Hub does not record which source produced them.
  main-loss  rows that were on --base's first-parent history and were dropped by
             a later merge commit (conflict resolution that took one side's file).
  branch     rows committed on other refs by a commit that only touched history
             files on top of a merged commit (the run executed merged code).

A run whose sha is on --base's first-parent line is a main run (append-only).
A run of a branch commit that later merged belongs to that landing merge; per
landing merge and task only the latest run (plus overlapping concurrent copies)
lands, and a later row the merge already landed supersedes it.

    python3 scripts/benchmark-history-backfill.py                 # dry run, prints counts
    python3 scripts/benchmark-history-backfill.py --write         # append missing rows
    python3 scripts/benchmark-history-backfill.py --hub-index F   # use a saved index
"""

from __future__ import annotations

import argparse
import bisect
import collections
import functools
import importlib.util
import json
import os
import re
import subprocess
import sys
import urllib.request
from datetime import timedelta
from pathlib import Path

HISTORY_DIR = Path("agents/benchmarks/history")
ATTEMPTS = HISTORY_DIR / "task_attempts.jsonl"
DURATIONS = HISTORY_DIR / "task_durations.jsonl"
DEFAULT_HUB_URL = "https://api.roselabs.ai"
CODE_RE = re.compile(r"^(?P<ref>.+?)@(?P<sha>[0-9a-f]{7,40})(?P<state>.*)$")

_spec = importlib.util.spec_from_file_location(
    "history_latest_only", Path(__file__).resolve().parent / "benchmark-history-latest-only.py"
)
latest_only = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = latest_only
_spec.loader.exec_module(latest_only)
parse_time = latest_only._parse_time


def git(repo: Path, *args: str, check: bool = True) -> str:
    return subprocess.run(
        ("git", "-C", str(repo), *args), capture_output=True, text=True, check=check
    ).stdout


def is_ancestor(repo: Path, a: str, b: str) -> bool:
    return subprocess.run(
        ("git", "-C", str(repo), "merge-base", "--is-ancestor", a, b), capture_output=True
    ).returncode == 0


def row_key(row: dict) -> tuple:
    return (row.get("task"), row.get("agent_id") or "", row.get("timestamp"))


def load_rows(path: Path) -> list[dict]:
    rows = []
    if path.is_file():
        for line in path.read_text().splitlines():
            row = latest_only._row(line.encode()) if line.strip() else None
            if row is not None:
                rows.append(row)
    return rows


def env_value(repo: Path, name: str) -> str | None:
    if os.environ.get(name):
        return os.environ[name]
    for rel in ("agents/.env", "back-end/.env"):
        path = repo / rel
        if not path.is_file():
            continue
        for line in path.read_text(errors="replace").splitlines():
            key, sep, value = line.strip().partition("=")
            if sep and key.removeprefix("export ").strip() == name:
                return value.strip().strip("'\"") or None
    return None


def fetch_hub_index(repo: Path, url: str) -> list[dict]:
    key = env_value(repo, "BACKEND_API_KEY")
    if not key:
        raise SystemExit("BACKEND_API_KEY is required (env, agents/.env or back-end/.env)")
    request = urllib.request.Request(f"{url.rstrip('/')}/api/benchmarks/runs", headers={"X-API-Key": key})
    with urllib.request.urlopen(request, timeout=300) as response:
        return json.load(response)["runs"]


class Landing:
    """Map a merged sha to the first-parent commit of --base that brought it in."""

    def __init__(self, repo: Path, base: str):
        self.repo, self.base = repo, base
        self.line = git(repo, "rev-list", "--first-parent", "--reverse", base).split()
        self.position = {sha: i for i, sha in enumerate(self.line)}
        self.cache: dict[str, str | None] = {}

    def resolve(self, sha: str) -> str | None:
        full = git(self.repo, "rev-parse", "--verify", "--quiet", f"{sha}^{{commit}}", check=False).strip()
        return full or None

    def of(self, full: str) -> str | None:
        if full in self.cache:
            return self.cache[full]
        landing = None
        if full in self.position:
            landing = full
        elif is_ancestor(self.repo, full, self.base):
            index = bisect.bisect_left(
                range(len(self.line)), True, key=lambda i: is_ancestor(self.repo, full, self.line[i])
            )
            landing = self.line[index] if index < len(self.line) else None
        self.cache[full] = landing
        return landing


def first_parent_history(repo: Path, base: str) -> tuple[dict, list[dict]]:
    """Rows each first-parent commit added, and rows merges dropped from the line."""
    out = git(repo, "log", base, "--first-parent", "-m", "--format=C %H %P", "-p", "--unified=0",
              "--no-renames", "--", str(ATTEMPTS))
    landed: dict[tuple[str, str], list[tuple]] = collections.defaultdict(list)
    dropped: list[dict] = []
    commit, merge = None, False
    for line in out.splitlines():
        if line.startswith("C "):
            parts = line.split()
            commit, merge = parts[1], len(parts) > 3
        elif line.startswith("+{") or line.startswith("-{"):
            row = latest_only._row(line[1:].encode())
            if row is None or not row.get("task"):
                continue
            if line[0] == "+":
                window = latest_only._window(row)
                if window:
                    landed[(commit, str(row["task"]))].append(window)
            elif merge:
                dropped.append(row)
    return landed, dropped


def branch_rows(repo: Path, base_keys: set) -> list[tuple[dict, set[str]]]:
    """Ledger rows ever committed on any ref but absent from --base, with their adding commits."""
    proc = subprocess.Popen(
        ("git", "-C", str(repo), "log", "--all", "--format=C %H", "-p", "--unified=0", "--no-renames",
         "--", str(ATTEMPTS)), stdout=subprocess.PIPE, text=True, errors="replace")
    found: dict[tuple, tuple[dict, set[str]]] = {}
    parsed: dict[str, tuple | None] = {}  # rewrites repeat the same lines many times
    commit = None
    for line in proc.stdout:
        if line.startswith("C "):
            commit = line.split()[1]
        elif line.startswith("+{"):
            if line not in parsed:
                row = latest_only._row(line[1:].encode())
                keep = row is not None and row.get("task") and row_key(row) not in base_keys
                parsed[line] = (row_key(row), row) if keep else None
            entry = parsed[line]
            if entry is not None:
                found.setdefault(entry[0], (entry[1], set()))[1].add(commit)
    proc.wait()
    return list(found.values())


@functools.lru_cache(maxsize=None)
def history_only(repo: Path, commit: str) -> bool:
    files = git(repo, "diff-tree", "--no-commit-id", "--name-only", "-r", commit).split()
    return bool(files) and all(f.startswith(f"{HISTORY_DIR}/") for f in files)


def hub_ledger_row(run: dict, task: dict, source: str) -> dict | None:
    start = parse_time(run.get("timestamp"))
    duration = task.get("duration_seconds")
    if start is None or not isinstance(duration, (int, float)):
        return None
    passed = task.get("passed") is True
    row = {
        "task": task["name"],
        "passed": passed,
        "status": task.get("status"),
        "duration_seconds": round(float(duration), 1),
        "cost_cents": round(float(task.get("cost_cents") or 0.0), 2),
        "timestamp": (start + timedelta(seconds=float(duration))).isoformat(),
        "agent_id": task.get("agent_id") or "",
        "failure_reason": (task.get("failure_reason") or "")[:200] or None,
        "fast_mode_cache": task.get("fast_mode") is True,
        "counts_for_deploy_eligibility": False,
        "suite": run.get("suite") or run.get("source"),
        "run_id": str(run.get("run_id"))[:128],
        "outcome_class": "passed" if passed else "failed",
        "backfill_source": source,
    }
    if run.get("group_run_id"):
        row["group_run_id"] = str(run["group_run_id"])[:128]
    return row


def plan(repo: Path, base: str, hub_runs: list[dict] | None, scan_branches: bool = True) -> dict:
    attempts = load_rows(repo / ATTEMPTS)
    durations = load_rows(repo / DURATIONS)
    have_agents = {r.get("agent_id") for r in attempts if r.get("agent_id")}
    have_keys = {row_key(r) for r in attempts}
    have_runs = {(r.get("task"), r.get("run_id")) for r in attempts if r.get("run_id")}
    base_keys = {row_key(r) for r in (latest_only._row(l.encode()) for l in
                 git(repo, "show", f"{base}:{ATTEMPTS}", check=False).splitlines()) if r}
    landing = Landing(repo, base)
    landed, dropped = first_parent_history(repo, base)
    counts: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    gaps: collections.Counter = collections.Counter()
    # (landing, task) -> candidate rows; landing None means a main run (append-only)
    grouped: dict[tuple, list[dict]] = collections.defaultdict(list)
    main_runs: list[dict] = []

    def duplicate(row: dict) -> bool:
        agent = row.get("agent_id")
        return (bool(agent) and agent in have_agents) or row_key(row) in have_keys or (
            row.get("run_id") and (row.get("task"), row.get("run_id")) in have_runs)

    def admit(source: str, row: dict, sha: str | None) -> None:
        counts[source]["found"] += 1
        full = landing.resolve(sha) if sha else None
        where = landing.of(full) if full else None
        if duplicate(row):
            counts[source]["duplicate"] += 1
            if where and where != full:
                window = latest_only._window(row)
                if window:  # an already-recorded run still supersedes older iterations
                    landed[(where, row["task"])].append(window)
            return
        if full is None:
            counts[source]["unbound"] += 1
        elif where is None:
            counts[source]["never_merged"] += 1
        elif where == full:
            main_runs.append(row)
        else:
            grouped[(where, row["task"])].append(row)

    # main-loss: rows a merge dropped from the first-parent line
    present = {row_key(r) for r in attempts}
    lost = {row_key(row) for row in dropped}
    for row in dropped:
        if row_key(row) in present:
            continue
        counts["main-loss"]["found"] += 1
        present.add(row_key(row))
        restored = {**row, "counts_for_deploy_eligibility": False, "backfill_source": "main-loss"}
        if duplicate(restored):
            counts["main-loss"]["duplicate"] += 1
        else:
            main_runs.append(restored)

    if scan_branches:
        merged = set(git(repo, "rev-list", base).split())
        for row, commits in branch_rows(repo, base_keys):
            if row_key(row) in lost:
                continue  # a main-loss row
            row = {**row, "counts_for_deploy_eligibility": False, "backfill_source": "branch"}
            if any(c in merged for c in commits):
                counts["branch"]["found"] += 1
                counts["branch"]["superseded_pre_merge"] += 1  # dropped by latest-only before merge
                continue
            parent = next((c for c in sorted(commits) if history_only(repo, c)), None)
            if parent is None:
                counts["branch"]["found"] += 1
                counts["branch"]["never_merged"] += 1  # committed with unmerged code changes
                continue
            admit("branch", row, git(repo, "rev-parse", f"{parent}^1").strip())

    if hub_runs is not None:
        group_code: dict[str, set] = collections.defaultdict(set)
        for run in hub_runs:
            if run.get("code") and run.get("group_run_id"):
                group_code[run["group_run_id"]].add(run["code"])
        seen_agents: set = set()
        for run in sorted(hub_runs, key=lambda r: bool(r.get("live"))):  # final bundles first
            for task in run.get("tasks") or []:
                if task.get("status") not in ("passed", "failed") or not isinstance(task.get("passed"), bool):
                    if not run.get("live"):
                        gaps["hub rows without a verdict (infra/queued/error)"] += 1
                    continue
                agent = task.get("agent_id")
                if agent and agent in seen_agents:
                    continue
                seen_agents.add(agent)
                row = hub_ledger_row(run, task, f"hub:{run.get('source') or 'unknown'}")
                if row is None:
                    gaps["hub rows without a duration or timestamp"] += 1
                    continue
                code = run.get("code")
                if not code and len(group_code.get(run.get("group_run_id") or "", ())) == 1:
                    code = next(iter(group_code[run["group_run_id"]]))
                match = CODE_RE.match(code or "")
                if match and "+patch" in match.group("state"):
                    counts["hub"]["found"] += 1
                    if duplicate(row):
                        counts["hub"]["duplicate"] += 1
                    else:
                        counts["hub"]["never_merged"] += 1  # executed uncommitted bytes
                    continue
                admit("hub", row, match.group("sha") if match else None)

    added = list(main_runs)
    for (where, task), rows in grouped.items():
        windows = [(latest_only._window(r), r) for r in rows]
        prior = [(w, None) for w in landed.get((where, task), [])]
        everything = [item for item in windows + prior if item[0]]
        latest_start, latest_end = max(everything, key=lambda item: item[0][1])[0]
        for window, row in windows:
            if window and window[0] <= latest_end and window[1] >= latest_start:
                added.append(row)
            else:
                source = row["backfill_source"].split(":")[0]
                counts[source]["superseded_pre_merge"] += 1

    # one row per agent even when two sources found it
    unique, agents = [], set()
    for row in sorted(added, key=lambda r: str(r.get("timestamp"))):
        agent = row.get("agent_id")
        if agent and agent in agents:
            continue
        agents.add(agent)
        unique.append(row)
        counts[row["backfill_source"].split(":")[0]]["added"] += 1

    duration_agents = {r.get("agent_id") for r in durations if r.get("agent_id")}
    duration_keys = {(r.get("task"), r.get("timestamp")) for r in durations}
    new_durations = [
        {"task": r["task"], "duration_seconds": r["duration_seconds"], "cost_cents": r["cost_cents"],
         "timestamp": r["timestamp"], "agent_id": r.get("agent_id") or "",
         "backfill_source": r["backfill_source"]}
        for r in unique
        if r.get("passed") is True
        and not (r.get("agent_id") and r["agent_id"] in duration_agents)
        and (r["task"], r["timestamp"]) not in duration_keys
    ]
    return {"attempts": unique, "durations": new_durations, "counts": counts, "gaps": gaps}


def write(repo: Path, result: dict) -> None:
    for rel, rows in ((ATTEMPTS, result["attempts"]), (DURATIONS, result["durations"])):
        if rows:
            with open(repo / rel, "a") as handle:
                handle.writelines(json.dumps(row) + "\n" for row in rows)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--base", default="origin/main")
    parser.add_argument("--hub-url", default=DEFAULT_HUB_URL)
    parser.add_argument("--hub-index", type=Path, help="saved GET /api/benchmarks/runs response")
    parser.add_argument("--no-hub", action="store_true")
    parser.add_argument("--no-branches", action="store_true", help="skip the all-refs ledger scan")
    parser.add_argument("--report", type=Path, help="write counts and gaps as JSON")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", default=True)
    mode.add_argument("--write", action="store_true")
    args = parser.parse_args(argv)
    repo = args.repo.resolve()
    hub_runs = None
    if not args.no_hub:
        if args.hub_index:
            loaded = json.loads(args.hub_index.read_text())
            hub_runs = loaded["runs"] if isinstance(loaded, dict) else loaded
        else:
            hub_runs = fetch_hub_index(repo, args.hub_url)
    result = plan(repo, args.base, hub_runs, scan_branches=not args.no_branches)
    for source, counter in sorted(result["counts"].items()):
        print(f"{source:10} " + " ".join(f"{k}={v}" for k, v in sorted(counter.items())))
    for gap, count in sorted(result["gaps"].items()):
        print(f"gap: {gap}: {count}")
    print(f"{'write' if args.write else 'dry-run'}: {len(result['attempts'])} attempt rows, "
          f"{len(result['durations'])} duration rows")
    if args.report:
        args.report.write_text(json.dumps({
            "counts": {k: dict(v) for k, v in result["counts"].items()},
            "gaps": dict(result["gaps"]),
            "attempts": len(result["attempts"]),
            "durations": len(result["durations"]),
        }, indent=2))
    if args.write:
        write(repo, result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
