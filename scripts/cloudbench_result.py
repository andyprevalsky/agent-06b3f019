#!/usr/bin/env python3
"""Validate that a cloud benchmark artifact belongs to the requested run."""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CLAUDE_CODE_CREDENTIAL_SKIP_REASON = (
    "Claude Code credentials unavailable: no synced Claude token and no available pool token"
)


def _claude_code_task_names() -> set[str]:
    tasks_path = ROOT / "agents" / "benchmarks" / "tasks.json"
    try:
        tasks = json.loads(tasks_path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return set()
    if isinstance(tasks, dict):
        raw_tasks = tasks.get("tasks", [])
    else:
        raw_tasks = tasks
    names: set[str] = set()
    if isinstance(raw_tasks, list):
        for task in raw_tasks:
            if isinstance(task, dict) and task.get("requires_claude_code") is True:
                name = task.get("name") or task.get("id")
                if isinstance(name, str) and name:
                    names.add(name)
    return names


def _is_allowed_claude_code_credential_skip(task: object, claude_code_names: set[str]) -> bool:
    if not isinstance(task, dict):
        return False
    name = task.get("name")
    return (
        isinstance(name, str)
        and name in claude_code_names
        and task.get("status") == "SKIPPED"
        and task.get("failure_reason") == CLAUDE_CODE_CREDENTIAL_SKIP_REASON
    )


def _parse_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    normalized = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def validate_run_document(
    document: object,
    expected_tasks: list[str],
    *,
    require_pass: bool = False,
    allow_claude_code_credential_skip: bool = False,
    not_before_epoch: float | None = None,
) -> list[str]:
    """Return contract violations for a run artifact.

    Identity and freshness are always enforced. Passing status is optional so a
    fresh failed run can still be preserved for diagnosis.
    """
    errors: list[str] = []
    if not isinstance(document, dict):
        return ["run artifact must be a JSON object"]
    if not expected_tasks:
        return ["at least one expected task is required"]

    tasks = document.get("tasks")
    if not isinstance(tasks, list):
        return ["run artifact tasks must be a list"]

    actual_names = [str(task.get("name") or "") for task in tasks if isinstance(task, dict)]
    if len(actual_names) != len(tasks):
        errors.append("every task result must be an object")
    if Counter(actual_names) != Counter(expected_tasks):
        errors.append(f"task identity mismatch: expected {expected_tasks!r}, got {actual_names!r}")

    if not_before_epoch is not None:
        timestamp = _parse_timestamp(document.get("timestamp"))
        threshold = datetime.fromtimestamp(not_before_epoch, tz=timezone.utc)
        if timestamp is None:
            errors.append("run artifact timestamp is missing or invalid")
        elif timestamp < threshold:
            errors.append(
                "run artifact predates this invocation: "
                f"timestamp={timestamp.isoformat()} not_before={threshold.isoformat()}"
            )

    summary = document.get("summary")
    if not isinstance(summary, dict):
        errors.append("run artifact summary must be an object")
        summary = {}
    if summary.get("total") != len(expected_tasks):
        errors.append(f"summary total mismatch: expected {len(expected_tasks)}, got {summary.get('total')!r}")

    if require_pass:
        claude_code_names = _claude_code_task_names() if allow_claude_code_credential_skip else set()
        allowed_skip_count = sum(
            1 for task in tasks if _is_allowed_claude_code_credential_skip(task, claude_code_names)
        )
        required_pass_count = len(expected_tasks) - allowed_skip_count
        failed_tasks = [
            str(task.get("name") or "")
            for task in tasks
            if (
                not isinstance(task, dict)
                or (
                    task.get("passed") is not True
                    and not _is_allowed_claude_code_credential_skip(task, claude_code_names)
                )
            )
        ]
        if failed_tasks:
            errors.append(f"task results are not all passing: {failed_tasks!r}")
        if summary.get("passed") != required_pass_count:
            errors.append(
                f"summary passed mismatch: expected {required_pass_count}, got {summary.get('passed')!r}"
            )
        if summary.get("failed") != 0:
            errors.append(f"summary failed must be 0, got {summary.get('failed')!r}")
        if allowed_skip_count and summary.get("skipped") != allowed_skip_count:
            errors.append(
                f"summary skipped mismatch: expected {allowed_skip_count}, got {summary.get('skipped')!r}"
            )
        if allowed_skip_count == 0 and summary.get("pass_rate") not in (1, 1.0):
            errors.append(f"summary pass_rate must be 1, got {summary.get('pass_rate')!r}")

    return errors


def validate_run_file(
    path: Path,
    expected_tasks: list[str],
    *,
    require_pass: bool = False,
    allow_claude_code_credential_skip: bool = False,
    not_before_epoch: float | None = None,
) -> list[str]:
    try:
        document: Any = json.loads(path.read_text())
    except FileNotFoundError:
        return [f"run artifact does not exist: {path}"]
    except json.JSONDecodeError as exc:
        return [f"run artifact is not valid JSON: {exc}"]
    return validate_run_document(
        document,
        expected_tasks,
        require_pass=require_pass,
        allow_claude_code_credential_skip=allow_claude_code_credential_skip,
        not_before_epoch=not_before_epoch,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("run_json", type=Path)
    parser.add_argument("--expected-task", action="append", required=True, dest="expected_tasks")
    parser.add_argument("--require-pass", action="store_true")
    parser.add_argument("--allow-claude-code-credential-skip", action="store_true")
    parser.add_argument("--not-before-epoch", type=float)
    args = parser.parse_args()

    errors = validate_run_file(
        args.run_json,
        args.expected_tasks,
        require_pass=args.require_pass,
        allow_claude_code_credential_skip=args.allow_claude_code_credential_skip,
        not_before_epoch=args.not_before_epoch,
    )
    if errors:
        for error in errors:
            print(f"cloudbench result rejected: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
