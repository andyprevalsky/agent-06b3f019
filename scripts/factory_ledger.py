#!/usr/bin/env python3
"""Publish local /deploy, /RCA, /update-prompts and /descend timestamps to main.

`run-deploy-stage` and `record_factory_event.py` write their timestamps under
`.context/`, which is gitignored and local to one machine; /descend appends to
its tracked ledger in the working tree. `publish` builds one commit on top of
the remote main that appends every row main does not already hold, then pushes
it, retrying when main moves. It never touches the working tree or the current
branch, so every /deploy (completed or blocked) can run it. Re-running is
idempotent. `scripts/factory_review.py` rebuilds timing from these ledgers.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any, Iterable


SCHEMA_VERSION = 1
LEDGER_RELATIVE = Path("agents/benchmarks/history/factory_events.jsonl")
DESCEND_RELATIVE = Path("agents/benchmarks/history/descend_steps.jsonl")
PUSH_ATTEMPTS = 5
SYNCED_WORKFLOWS = frozenset({"deploy", "rca", "update-prompts"})
STAGE_FIELDS = (
    "run_id",
    "stage",
    "started_at",
    "finished_at",
    "started_epoch",
    "finished_epoch",
    "duration_seconds",
    "status",
    "exit_code",
    "telemetry",
)
RUN_FIELDS = ("git_sha", "branch")
EVENT_FIELDS = (
    "run_id",
    "workflow",
    "event",
    "value",
    "recorded_at",
    "recorded_epoch",
    "workspace",
    "git_sha",
    "branch",
    "telemetry",
)


def repo_root() -> Path:
    try:
        root = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return Path.cwd()
    return Path(root) if root else Path.cwd()


def read_jsonl(path: Path) -> Iterable[dict[str, Any]]:
    try:
        text = path.read_text()
    except OSError:
        return
    yield from parse_jsonl(text)


def parse_jsonl(text: str) -> Iterable[dict[str, Any]]:
    for line in text.splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            yield row


def row_key(row: dict[str, Any]) -> tuple[Any, ...]:
    if row.get("kind") == "deploy-stage":
        return (
            "deploy-stage",
            row.get("run_id"),
            row.get("stage"),
            round(float(row.get("started_epoch") or 0.0), 3),
        )
    if row.get("event") == "metadata" and row.get("value") == "snapshot":
        return (
            "factory-metadata",
            row.get("workflow"),
            row.get("workspace"),
            row.get("recorded_epoch"),
            json.dumps(row.get("telemetry"), sort_keys=True, separators=(",", ":")),
        )
    return (
        "factory-event",
        row.get("workflow"),
        row.get("event"),
        row.get("value"),
        round(float(row.get("recorded_epoch") or 0.0), 3),
        row.get("workspace"),
    )


def stage_rows(root: Path) -> Iterable[dict[str, Any]]:
    for stages_path in sorted(root.glob("deploy-runs/*/stages.jsonl")):
        try:
            metadata = json.loads((stages_path.parent / "metadata.json").read_text())
        except (OSError, json.JSONDecodeError):
            metadata = {}
        for row in read_jsonl(stages_path):
            if not row.get("run_id") or not row.get("stage"):
                continue
            if row.get("started_epoch") is None or row.get("finished_epoch") is None:
                continue
            record: dict[str, Any] = {"schema_version": SCHEMA_VERSION, "kind": "deploy-stage"}
            record.update({field: row.get(field) for field in STAGE_FIELDS})
            record.update({field: metadata.get(field) for field in RUN_FIELDS})
            if record.get("telemetry") is None and metadata.get("telemetry") is not None:
                record["telemetry"] = metadata["telemetry"]
            if isinstance(row.get("detail"), dict):
                record["detail"] = row["detail"]
            yield record


def event_rows(root: Path) -> Iterable[dict[str, Any]]:
    for row in read_jsonl(root / "factory-events.jsonl"):
        if row.get("workflow") not in SYNCED_WORKFLOWS:
            continue
        if row.get("recorded_epoch") is None or not row.get("event"):
            continue
        record: dict[str, Any] = {"schema_version": SCHEMA_VERSION, "kind": "factory-event"}
        record.update({field: row.get(field) for field in EVENT_FIELDS})
        if isinstance(row.get("detail"), dict):
            record["detail"] = row["detail"]
        yield record


def row_epoch(row: dict[str, Any]) -> float:
    return float(row.get("started_epoch") or row.get("recorded_epoch") or 0.0)


def is_identity_enrichment(old: dict[str, Any], new: dict[str, Any]) -> bool:
    """An append-only run link cannot alter an event's native facts."""
    if old.get("kind") != "factory-event" or old.get("run_id"):
        return False
    if not isinstance(new.get("run_id"), str) or not new["run_id"]:
        return False
    ignored = {"run_id"}
    return all(old.get(key) == new.get(key) for key in (old.keys() | new.keys()) - ignored)


def encode_rows(rows: Iterable[dict[str, Any]]) -> str:
    return "".join(
        json.dumps(row, separators=(",", ":"), sort_keys=True) + "\n"
        for row in sorted(rows, key=row_epoch)
    )


def pending_rows(existing_text: str, roots: Iterable[Path]) -> list[dict[str, Any]]:
    """Local stage records and factory events that `existing_text` lacks."""
    existing = {row_key(row): row for row in parse_jsonl(existing_text)}
    pending: dict[tuple[Any, ...], dict[str, Any]] = {}
    for root in roots:
        for row in (*stage_rows(root), *event_rows(root)):
            key = row_key(row)
            if key not in existing or is_identity_enrichment(existing[key], row):
                if key not in pending or is_identity_enrichment(pending[key], row):
                    pending[key] = row
    return sorted(pending.values(), key=row_epoch)


def pending_descend_lines(existing_text: str, local_text: str) -> list[str]:
    """/descend ledger lines whose record_id `existing_text` lacks."""
    known = {row.get("record_id") for row in parse_jsonl(existing_text)}
    lines = []
    for line in local_text.splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        record = row.get("record_id") if isinstance(row, dict) else None
        if isinstance(record, str) and record not in known:
            known.add(record)
            lines.append(line + "\n")
    return lines


def _git(repo: Path, *args: str, stdin: str | None = None, env: dict[str, str] | None = None) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=repo,
        input=stdin,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def _show(repo: Path, ref: str, path: Path) -> str:
    try:
        return subprocess.run(
            ["git", "show", f"{ref}:{path.as_posix()}"],
            cwd=repo,
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    except subprocess.CalledProcessError:
        return ""


def _appended(text: str, addition: str) -> str:
    if text and not text.endswith("\n"):
        text += "\n"
    return text + addition


def _commit_on(repo: Path, base: str, updates: dict[Path, str], message: str) -> str:
    with tempfile.TemporaryDirectory() as scratch:
        env = {**os.environ, "GIT_INDEX_FILE": str(Path(scratch) / "index")}
        _git(repo, "read-tree", base, env=env)
        for path, text in updates.items():
            blob = _git(repo, "hash-object", "-w", "--stdin", stdin=text)
            _git(repo, "update-index", "--add", "--cacheinfo", f"100644,{blob},{path.as_posix()}", env=env)
        tree = _git(repo, "write-tree", env=env)
    return _git(repo, "commit-tree", tree, "-p", base, "-m", message)


def publish(
    repo: Path,
    roots: Iterable[Path],
    *,
    remote: str = "origin",
    branch: str = "main",
    dry_run: bool = False,
    before_push: Callable[[int], None] | None = None,
) -> int:
    """Append unpublished rows to the remote branch in one commit; return the row count."""
    roots = list(roots)
    local_descend = ""
    try:
        local_descend = (repo / DESCEND_RELATIVE).read_text()
    except OSError:
        pass
    for attempt in range(PUSH_ATTEMPTS):
        _git(repo, "fetch", "--quiet", remote, branch)
        base = _git(repo, "rev-parse", "FETCH_HEAD")
        main_events = _show(repo, base, LEDGER_RELATIVE)
        main_descend = _show(repo, base, DESCEND_RELATIVE)
        rows = pending_rows(main_events, roots)
        descend_lines = pending_descend_lines(main_descend, local_descend)
        count = len(rows) + len(descend_lines)
        if count == 0 or dry_run:
            return count
        updates: dict[Path, str] = {}
        if rows:
            updates[LEDGER_RELATIVE] = _appended(main_events, encode_rows(rows))
        if descend_lines:
            updates[DESCEND_RELATIVE] = _appended(main_descend, "".join(descend_lines))
        commit = _commit_on(
            repo,
            base,
            updates,
            f"chore(factory-history): record {count} factory timing row(s)",
        )
        if before_push is not None:
            before_push(attempt)
        pushed = subprocess.run(
            ["git", "push", "--quiet", remote, f"{commit}:refs/heads/{branch}"],
            cwd=repo,
            capture_output=True,
            text=True,
        )
        if pushed.returncode == 0:
            return count
    raise SystemExit(
        f"factory ledger: {remote}/{branch} kept moving; nothing lost, rerun publish "
        f"(last push error: {pushed.stderr.strip()})"
    )


def sync(ledger: Path, roots: Iterable[Path]) -> int:
    """Append unrecorded rows to a local ledger file (tests and offline backfill)."""
    try:
        existing = ledger.read_text()
    except OSError:
        existing = ""
    rows = pending_rows(existing, roots)
    if rows:
        ledger.parent.mkdir(parents=True, exist_ok=True)
        ledger.write_text(_appended(existing, encode_rows(rows)))
    return len(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    publish_parser = sub.add_parser("publish", help="append unpublished rows to the remote main")
    publish_parser.add_argument(
        "--source-root",
        action="append",
        type=Path,
        default=[],
        help="directory holding deploy-runs/ and/or factory-events.jsonl "
        "(default: <repo>/.context; repeatable)",
    )
    publish_parser.add_argument("--remote", default="origin")
    publish_parser.add_argument("--branch", default="main")
    publish_parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    root = repo_root()
    roots = args.source_root or [root / ".context"]
    count = publish(root, roots, remote=args.remote, branch=args.branch, dry_run=args.dry_run)
    verb = "would publish" if args.dry_run else "published"
    print(f"factory ledger: {verb} {count} row(s) to {args.remote}/{args.branch}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
