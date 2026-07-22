#!/usr/bin/env python3
"""Emit a validated, durable workflow event for factory timing reports."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path


VALID_EVENTS = {
    "deploy": {
        "approval-request": {
            "prompt-approval",
            "agent-behavior-approval",
            "combined",
        },
        "approval-decision": {"approved", "rejected"},
        "stage-start": {
            "runtime-blackbox",
            "code-review",
            "production-verify",
        },
        "stage-finish": {
            "runtime-blackbox",
            "code-review",
            "production-verify",
        },
        "outcome": {"completed", "blocked"},
    },
    "rca": {
        "stage": {"evidence-trace", "reproduce-diagnose", "verify-handoff"},
        "outcome": {"fixed", "diagnosis-ready", "blocked"},
    },
}


def git_value(*args: str) -> str:
    try:
        return subprocess.run(
            ["git", *args],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def default_event_log() -> Path:
    root = git_value("rev-parse", "--show-toplevel")
    base = Path(root) if root else Path.cwd()
    return base / ".context" / "factory-events.jsonl"


def append_event(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(payload, separators=(",", ":")) + "\n").encode()
    descriptor = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o644)
    try:
        os.write(descriptor, encoded)
    finally:
        os.close(descriptor)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workflow", choices=sorted(VALID_EVENTS))
    parser.add_argument("event")
    parser.add_argument("value")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    allowed_values = VALID_EVENTS[args.workflow].get(args.event)
    if allowed_values is None or args.value not in allowed_values:
        expected = ", ".join(
            f"{event}={value}"
            for event, values in VALID_EVENTS[args.workflow].items()
            for value in sorted(values)
        )
        raise SystemExit(
            f"invalid {args.workflow} factory event: {args.event}={args.value}; "
            f"expected one of: {expected}"
        )

    epoch = time.time()
    payload: dict[str, object] = {
        "schema_version": 1,
        "workflow": args.workflow,
        "event": args.event,
        "value": args.value,
        "recorded_at": datetime.fromtimestamp(epoch, timezone.utc).isoformat(),
        "recorded_epoch": epoch,
        "workspace": Path.cwd().name,
        "git_sha": git_value("rev-parse", "HEAD"),
        "branch": git_value("branch", "--show-current"),
    }
    event_log = Path(
        os.environ.get("FACTORY_EVENT_LOG", str(default_event_log()))
    ).expanduser()
    append_event(event_log, payload)
    print("FACTORY_EVENT " + json.dumps(payload, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
