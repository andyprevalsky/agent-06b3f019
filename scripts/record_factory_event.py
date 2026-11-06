#!/usr/bin/env python3
"""Emit a validated, durable workflow event for factory timing reports."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

REVIEW_PROVIDERS = {"coderabbit", "claude", "codex", "human"}
VALID_EVENTS = {
    "deploy": {
        "approval-request": {
            "prompt-approval",
            "agent-behavior-approval",
            "llm-trajectory-injection-approval",
            "combined",
        },
        "approval-decision": {"approved", "rejected"},
        "stage-start": {
            "runtime-blackbox",
            "code-review",
            "production-verify",
            "cooperative-cutover",
        },
        "stage-finish": {
            "runtime-blackbox",
            "code-review",
            "production-verify",
            "cooperative-cutover",
        },
        "production-start": {
            "vercel",
            "render",
            "fly",
            "mac-release",
            "backend-probes",
            "semantic",
            "agentcard",
        },
        "production-finish": {
            "vercel",
            "render",
            "fly",
            "mac-release",
            "backend-probes",
            "semantic",
            "agentcard",
        },
        "outcome": {"completed", "blocked"},
        # Review providers: request when the review is asked for, arrival when
        # its verdict lands; their difference is review wait, not agent time.
        "review-request": REVIEW_PROVIDERS,
        "review-arrival": REVIEW_PROVIDERS,
    },
    "rca": {
        "stage": {"evidence-trace", "reproduce-diagnose", "verify-handoff"},
        # One event per local repro run; detail repro_attempt=N counts them.
        "repro-attempt": {"reproduced", "not-reproduced", "fix-verified", "fix-failed"},
        "outcome": {"fixed", "diagnosis-ready", "blocked"},
    },
    "descend": {
        "outcome": {"completed", "failed", "blocked", "interrupted"},
    },
    "update-prompts": {
        "stage": {"localize-replay", "propose-edit", "verify-summary"},
        "outcome": {"iterated", "blocked"},
    },
}
DESCEND_STEP_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
ACTIVITY_EVENTS = {
    "work-start": {"implementation", "diagnosis", "coordination", "reporting"},
    "work-finish": {"implementation", "diagnosis", "coordination", "reporting"},
    "wait-start": {"user", "credits", "provider", "queue", "dependency", "inactive"},
    "wait-finish": {"user", "credits", "provider", "queue", "dependency", "inactive"},
}
for _events in VALID_EVENTS.values():
    _events.update(ACTIVITY_EVENTS)


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


def active_deploy_run_id() -> str | None:
    """Use the timing lifecycle's identity even after Git changes branches."""
    root = Path(git_value("rev-parse", "--show-toplevel") or Path.cwd())
    run_root = Path(os.environ.get("DEPLOY_RUN_ROOT", str(root / ".context/deploy-runs")))
    for pointer in ("factory-current", "current"):
        try:
            run_id = (run_root / pointer).read_text().splitlines()[0]
            if run_id in {".", ".."} or not re.fullmatch(r"[A-Za-z0-9._-]+", run_id):
                continue
            run = json.loads((run_root / run_id / "metadata.json").read_text())
            allowed = {"active", "finishing", "completed"} if pointer == "factory-current" else {"active", "finishing"}
            if run.get("run_id") == run_id and run.get("status") in allowed:
                return run_id
        except (OSError, ValueError, IndexError, AttributeError):
            continue
    return None


def finish_deploy_context(run_id: str) -> None:
    root = Path(git_value("rev-parse", "--show-toplevel") or Path.cwd())
    run_root = Path(os.environ.get("DEPLOY_RUN_ROOT", str(root / ".context/deploy-runs")))
    with (run_root / ".lifecycle.lock").open("a+") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        pointer = run_root / "factory-current"
        if pointer.exists() and pointer.read_text().strip() == run_id:
            pointer.unlink()


def append_event(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(payload, separators=(",", ":")) + "\n").encode()
    descriptor = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o644)
    try:
        os.write(descriptor, encoded)
    finally:
        os.close(descriptor)


def validate_event(workflow: str, event: str, value: str) -> None:
    if workflow == "descend" and event in {"stage-start", "stage-finish"}:
        if DESCEND_STEP_RE.fullmatch(value):
            return
        raise ValueError(
            "invalid descend stage value; expected an uppercase state name"
        )
    if (
        workflow in {"deploy", "rca", "update-prompts"}
        and event == "metadata"
        and value == "snapshot"
    ):
        return
    allowed_values = VALID_EVENTS.get(workflow, {}).get(event)
    if allowed_values is not None and value in allowed_values:
        return
    expected = ", ".join(
        f"{event_name}={allowed_value}"
        for event_name, values in VALID_EVENTS.get(workflow, {}).items()
        for allowed_value in sorted(values)
    )
    if workflow == "descend":
        expected = f"stage-start=<STATE>, stage-finish=<STATE>, {expected}"
    raise ValueError(
        f"invalid {workflow} factory event: {event}={value}; "
        f"expected one of: {expected}"
    )


def factory_event_payload(
    workflow: str,
    event: str,
    value: str,
    *,
    recorded_epoch: float | None = None,
    metadata: dict[str, object] | None = None,
    detail: dict[str, object] | None = None,
) -> dict[str, object]:
    """Build the canonical factory-event envelope with optional dimensions."""
    from factory_metadata import load_metadata, normalize_metadata

    validate_event(workflow, event, value)
    if event in ACTIVITY_EVENTS and not all(
        isinstance((detail or {}).get(key), str) and (detail or {})[key].strip()
        for key in ("request_id", "reason")
    ):
        raise ValueError("activity events require detail request_id and reason")
    metadata = dict(metadata or {})
    metadata["telemetry"] = (
        normalize_metadata(metadata["telemetry"])
        if "telemetry" in metadata else load_metadata()
    )
    epoch = time.time() if recorded_epoch is None else recorded_epoch
    payload: dict[str, object] = {
        "schema_version": 1,
        "workflow": workflow,
        "event": event,
        "value": value,
        "recorded_at": datetime.fromtimestamp(epoch, timezone.utc).isoformat(),
        "recorded_epoch": epoch,
        "workspace": Path.cwd().name,
        "git_sha": git_value("rev-parse", "HEAD"),
        "branch": git_value("branch", "--show-current"),
    }
    if workflow == "deploy" and (run_id := active_deploy_run_id()) is not None:
        payload["run_id"] = run_id
    for key, metadata_value in (metadata or {}).items():
        if key in payload:
            raise ValueError(f"metadata cannot override canonical field {key!r}")
        payload[key] = metadata_value
    if detail:
        payload["detail"] = detail
    return payload


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workflow", choices=sorted(VALID_EVENTS))
    parser.add_argument("event")
    parser.add_argument("value")
    parser.add_argument(
        "--metadata-file",
        help="Allowlisted evidence-backed JSON; defaults to FACTORY_METADATA_FILE",
    )
    parser.add_argument(
        "--detail",
        action="append",
        default=[],
        metavar="KEY=VALUE",
        help="Allowlisted outcome detail (see factory_detail.EVENT_DETAIL_FIELDS); repeatable",
    )
    return parser.parse_args()


def main() -> int:
    from factory_detail import parse_event_detail
    from factory_metadata import load_metadata

    args = parse_args()
    try:
        payload = factory_event_payload(
            args.workflow,
            args.event,
            args.value,
            metadata={"telemetry": load_metadata(args.metadata_file)},
            detail=parse_event_detail(args.detail),
        )
    except ValueError as error:
        raise SystemExit(str(error)) from error
    event_log = Path(
        os.environ.get("FACTORY_EVENT_LOG", str(default_event_log()))
    ).expanduser()
    append_event(event_log, payload)
    if (args.workflow == "deploy" and args.event == "outcome" and args.value == "completed"
            and payload.get("run_id")):
        finish_deploy_context(str(payload["run_id"]))
    print("FACTORY_EVENT " + json.dumps(payload, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
