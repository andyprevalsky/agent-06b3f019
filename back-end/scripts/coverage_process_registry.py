#!/usr/bin/env python3
"""Serialize and validate process groups owned by a coverage run."""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class RegisteredProcessGroup:
    pgid: int
    identity_pid: int
    start_identity: str


def process_start_identity(pid: int) -> str | None:
    """Return a start-time identity that survives exec but not PID reuse."""

    # Linux exposes the session leader's precise start tick. The command name
    # can contain spaces and parentheses, so split only after the final ')'.
    try:
        stat = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
        fields_after_command = stat[stat.rfind(")") + 2 :].split()
        if len(fields_after_command) > 19:
            return f"proc-start-ticks:{fields_after_command[19]}"
    except (OSError, ValueError):
        pass

    # macOS has no /proc. `lstart` is the process creation time and is stable
    # across the exec performed by coverage-process-group.py.
    try:
        result = subprocess.run(
            ["ps", "-o", "lstart=", "-p", str(pid)],
            check=False,
            capture_output=True,
            text=True,
            timeout=1,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    value = " ".join(result.stdout.split())
    return f"ps-lstart:{value}" if result.returncode == 0 and value else None


def serialize_process_group(group: RegisteredProcessGroup) -> str:
    return json.dumps(
        {
            "identity_pid": group.identity_pid,
            "pgid": group.pgid,
            "start_identity": group.start_identity,
        },
        separators=(",", ":"),
        sort_keys=True,
    )


# os.killpg raises OverflowError for ids beyond a C int, which would abort the
# guardian before it cleaned up the remaining registered groups.
MAX_PROCESS_ID = (1 << 31) - 1


def parse_process_group(value: str) -> RegisteredProcessGroup | None:
    try:
        record = json.loads(value)
    except (json.JSONDecodeError, ValueError, RecursionError):
        # An oversized integer literal raises ValueError (not JSONDecodeError)
        # under CPython's int/str conversion limit, and a deeply nested line
        # raises RecursionError. Either would otherwise abort the whole registry
        # snapshot before the valid process groups were terminated.
        return None
    if not isinstance(record, dict):
        return None
    pgid = record.get("pgid")
    identity_pid = record.get("identity_pid")
    start_identity = record.get("start_identity")
    if (
        isinstance(pgid, bool)
        or not isinstance(pgid, int)
        or pgid <= 0
        or pgid > MAX_PROCESS_ID
        or isinstance(identity_pid, bool)
        or not isinstance(identity_pid, int)
        or identity_pid <= 0
        or identity_pid > MAX_PROCESS_ID
        or not isinstance(start_identity, str)
        or not start_identity
    ):
        return None
    return RegisteredProcessGroup(
        pgid=pgid,
        identity_pid=identity_pid,
        start_identity=start_identity,
    )
