"""Benchmark history ledgers: a frozen base file plus per-writer shard files.

``task_attempts.jsonl`` and ``task_durations.jsonl`` used to receive every
writer's rows. A PR that appended rows edited the same end of file that main
also appended to, and GitHub's mergeability check ignores ``.gitattributes``
merge drivers (``merge=union`` only helps local merges). The PR therefore
turned CONFLICTING whenever main gained rows, and the deploy had to sync main
and rerun its full gates.

A canonical ledger is now its base file plus shard files
``<stem>.<YYYYMMDD>.<writer>.jsonl`` in the same directory. Every writer (a
branch checkout) appends only to its own shard, so concurrent PRs add distinct
files and never modify a shared path. Readers see the union: base rows in file
order (the historical order every reader already used), then shard rows in
recorded order (timestamp, then shard name and line). Task names remain the
row key; nothing is renamed or rewritten.

Only the canonical file names are sharded. A ledger at any other name (tests
and one-off diagnostics that point a writer at a scratch file) keeps the
single-file contract, as ``span_history`` does for explicit paths.

Stdlib only: agents modules import it, and scripts load it by path.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from datetime import datetime, timezone
from glob import glob
from typing import List, Optional

ATTEMPTS_NAME = "task_attempts.jsonl"
DURATIONS_NAME = "task_durations.jsonl"
SHARDED_NAMES = (ATTEMPTS_NAME, DURATIONS_NAME)
# Explicit shard owner, e.g. a detached CI checkout that still publishes rows.
WRITER_ENV = "BENCHMARK_HISTORY_WRITER"
DETACHED_WRITER = "detached"


def is_sharded(ledger_path: "str | os.PathLike[str]") -> bool:
    return os.path.basename(os.fspath(ledger_path)) in SHARDED_NAMES


def _stem(ledger_path: "str | os.PathLike[str]") -> str:
    return os.path.basename(os.fspath(ledger_path))[: -len(".jsonl")]


def is_shard_name(name: str, ledger_name: str) -> bool:
    """Whether ``name`` (a basename) is a shard of the canonical ``ledger_name``."""
    if ledger_name not in SHARDED_NAMES:
        return False
    stem = ledger_name[: -len(".jsonl")]
    return name.startswith(stem + ".") and name.endswith(".jsonl") and name != ledger_name


def ledger_of(name: str) -> Optional[str]:
    """The canonical ledger name that ``name`` (a basename) belongs to, if any."""
    for ledger_name in SHARDED_NAMES:
        if name == ledger_name or is_shard_name(name, ledger_name):
            return ledger_name
    return None


def shard_files(ledger_path: "str | os.PathLike[str]") -> List[str]:
    """The ledger's shard files, sorted by name (date first, then writer)."""
    path = os.fspath(ledger_path)
    if not is_sharded(path):
        return []
    pattern = os.path.join(glob_escape(os.path.dirname(path)), f"{_stem(path)}.*.jsonl")
    return sorted(p for p in glob(pattern) if os.path.isfile(p))


def glob_escape(text: str) -> str:
    return re.sub(r"([*?[])", r"[\1]", text)


def ledger_files(ledger_path: "str | os.PathLike[str]") -> List[str]:
    """The base file followed by its shards; the base is listed even when absent."""
    path = os.fspath(ledger_path)
    return [path, *shard_files(path)]


def _sort_time(line: str) -> datetime:
    try:
        row = json.loads(line)
        value = row.get("timestamp") if isinstance(row, dict) else None
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00")) if value else None
    except (ValueError, TypeError):
        parsed = None
    if parsed is None:
        return datetime.min.replace(tzinfo=timezone.utc)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _read(path: str) -> List[str]:
    try:
        with open(path, errors="replace") as handle:
            return [line.rstrip("\n") for line in handle if line.strip()]
    except OSError:
        return []


def read_lines(ledger_path: "str | os.PathLike[str]") -> List[str]:
    """Non-blank rows of the ledger and its shards, in reader order.

    Base rows keep file order. Shard rows follow, ordered by their recorded
    timestamp (rows without one first), then shard name and line, so
    "the most recent N rows" means the same thing across writers."""
    path = os.fspath(ledger_path)
    lines = _read(path)
    shard_rows = []
    for file_index, shard in enumerate(shard_files(path)):
        for line_index, line in enumerate(_read(shard)):
            shard_rows.append((_sort_time(line), file_index, line_index, line))
    shard_rows.sort(key=lambda item: item[:3])
    lines.extend(item[3] for item in shard_rows)
    return lines


def read_rows(ledger_path: "str | os.PathLike[str]") -> List[dict]:
    """Parsed JSON-object rows of :func:`read_lines`; malformed rows are skipped."""
    rows = []
    for line in read_lines(ledger_path):
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def writer_key(directory: "str | os.PathLike[str]") -> str:
    """Slug of the shard owner: ``BENCHMARK_HISTORY_WRITER`` or the checkout's branch."""
    explicit = os.environ.get(WRITER_ENV, "").strip()
    branch = explicit
    if not branch:
        try:
            branch = subprocess.run(
                ["git", "symbolic-ref", "--short", "-q", "HEAD"],
                cwd=os.fspath(directory),
                capture_output=True,
                text=True,
                timeout=5,
            ).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            branch = ""
    slug = re.sub(r"[^a-z0-9]+", "-", branch.lower()).strip("-")[:64]
    return slug or DETACHED_WRITER


def shard_path(
    ledger_path: "str | os.PathLike[str]",
    *,
    writer: Optional[str] = None,
    now: Optional[datetime] = None,
) -> str:
    """This writer's shard of ``ledger_path`` for the given UTC day."""
    path = os.fspath(ledger_path)
    directory = os.path.dirname(path) or "."
    if writer is None:
        probe = directory
        while probe and not os.path.isdir(probe):
            parent = os.path.dirname(probe)
            if parent == probe:
                break
            probe = parent
        writer = writer_key(probe or ".")
    day = (now or datetime.now(timezone.utc)).strftime("%Y%m%d")
    return os.path.join(directory, f"{_stem(path)}.{day}.{writer}.jsonl")


def append_target(ledger_path: "str | os.PathLike[str]") -> str:
    """Where a new row of ``ledger_path`` is appended: this writer's shard of a
    canonical ledger, otherwise the explicitly named file itself."""
    path = os.fspath(ledger_path)
    return shard_path(path) if is_sharded(path) else path
