#!/usr/bin/env python3
"""Wait for CodeRabbit on one exact pull-request HEAD.

Unlike ``gh pr checks --watch``, this watches only CodeRabbit. The PR HEAD is
validated on every poll, so a success from an older commit can never satisfy
the wait. Both GitHub CheckRun and legacy StatusContext payloads are supported;
neither requires a timestamp to prove freshness because statuses are scoped to
the exact commit SHA.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Callable


PENDING_STATES = {
    "EXPECTED",
    "IN_PROGRESS",
    "PENDING",
    "QUEUED",
    "REQUESTED",
    "WAITING",
}
SUCCESS_STATES = {"NEUTRAL", "SKIPPED", "SUCCESS"}
FAILURE_STATES = {
    "ACTION_REQUIRED",
    "CANCELLED",
    "ERROR",
    "FAILURE",
    "STALE",
    "STARTUP_FAILURE",
    "TIMED_OUT",
}


class ReviewWaitError(RuntimeError):
    """Raised when the requested review cannot safely complete."""


@dataclass(frozen=True)
class ReviewStatus:
    state: str
    terminal: bool
    successful: bool
    kind: str
    raw: dict[str, object]


def coderabbit_entry(payload: dict[str, object]) -> dict[str, object] | None:
    entries = payload.get("statusCheckRollup")
    if not isinstance(entries, list):
        raise ReviewWaitError("GitHub response is missing statusCheckRollup")
    matches = [
        entry
        for entry in entries
        if isinstance(entry, dict)
        and str(entry.get("name") or entry.get("context") or "").lower()
        == "coderabbit"
    ]
    return matches[-1] if matches else None


def normalize_status(entry: dict[str, object]) -> ReviewStatus:
    kind = str(entry.get("__typename") or "unknown")
    status = str(entry.get("status") or "").upper()
    state = str(entry.get("state") or "").upper()
    conclusion = str(entry.get("conclusion") or "").upper()

    # CheckRun exposes status=COMPLETED plus a conclusion. StatusContext exposes
    # its terminal result directly as state=SUCCESS/FAILURE and has no startedAt.
    normalized = conclusion if status == "COMPLETED" and conclusion else state or status
    if normalized in SUCCESS_STATES:
        return ReviewStatus(normalized, True, True, kind, entry)
    if normalized in FAILURE_STATES:
        return ReviewStatus(normalized, True, False, kind, entry)
    if normalized in PENDING_STATES or not normalized:
        return ReviewStatus(normalized or "MISSING", False, False, kind, entry)
    return ReviewStatus(normalized, False, False, kind, entry)


def _gh_json(command: list[str]) -> object:
    completed = subprocess.run(command, check=False, capture_output=True, text=True)
    if completed.returncode != 0:
        raise ReviewWaitError(completed.stderr.strip() or "gh command failed")
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise ReviewWaitError("gh command returned invalid JSON") from error


def _repo_slug(repo: str | None) -> str:
    if repo:
        return repo
    payload = _gh_json(["gh", "repo", "view", "--json", "nameWithOwner"])
    if not isinstance(payload, dict) or not isinstance(payload.get("nameWithOwner"), str):
        raise ReviewWaitError("could not resolve OWNER/REPO for REST status fallback")
    return payload["nameWithOwner"]


def _rest_status_payload(pr: str, repo: str | None, expected_hint: str | None = None) -> dict[str, object]:
    """Build a statusCheckRollup-shaped payload from the REST commit status API.

    Fine-grained tokens often can read REST statuses but not GraphQL
    ``statusCheckRollup`` (the field ``gh pr view --json statusCheckRollup``
    queries). Prefer GraphQL; fall back here so cloud deploys are not blocked.
    """
    pr_payload = _gh_json(
        (["gh", "pr", "view", pr, "--repo", repo] if repo else ["gh", "pr", "view", pr])
        + ["--json", "headRefOid"]
    )
    if not isinstance(pr_payload, dict):
        raise ReviewWaitError("gh pr view returned a non-object payload")
    head = str(pr_payload.get("headRefOid") or "")
    if not head:
        raise ReviewWaitError("gh pr view returned no headRefOid")
    slug = _repo_slug(repo)
    status_payload = _gh_json(["gh", "api", f"repos/{slug}/commits/{head}/status"])
    if not isinstance(status_payload, dict):
        raise ReviewWaitError("REST commit status returned a non-object payload")
    rollup: list[dict[str, object]] = []
    for entry in status_payload.get("statuses") or []:
        if not isinstance(entry, dict):
            continue
        rollup.append(
            {
                "__typename": "StatusContext",
                "context": entry.get("context"),
                "state": str(entry.get("state") or "").upper(),
                "description": entry.get("description"),
            }
        )
    return {"headRefOid": head, "statusCheckRollup": rollup}


def gh_payload(pr: str, repo: str | None = None) -> dict[str, object]:
    command = ["gh", "pr", "view", pr]
    if repo:
        command.extend(["--repo", repo])
    command.extend(["--json", "headRefOid,statusCheckRollup"])
    completed = subprocess.run(command, check=False, capture_output=True, text=True)
    if completed.returncode == 0:
        try:
            payload = json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise ReviewWaitError("gh pr view returned invalid JSON") from error
        if not isinstance(payload, dict):
            raise ReviewWaitError("gh pr view returned a non-object payload")
        return payload
    err = completed.stderr.strip() or "gh pr view failed"
    # GraphQL statusCheckRollup is frequently inaccessible to fine-grained PATs.
    if "statusCheckRollup" in err or "Resource not accessible" in err:
        return _rest_status_payload(pr, repo)
    raise ReviewWaitError(err)


def wait_for_review(
    *,
    pr: str,
    expected_head: str,
    repo: str | None,
    timeout_seconds: float,
    poll_seconds: float,
    loader: Callable[[str, str | None], dict[str, object]] = gh_payload,
    sleeper: Callable[[float], None] = time.sleep,
    progress: Callable[[str], None] | None = None,
) -> ReviewStatus:
    deadline = time.monotonic() + timeout_seconds
    last_message = ""
    while True:
        payload = loader(pr, repo)
        actual_head = str(payload.get("headRefOid") or "")
        if actual_head != expected_head:
            raise ReviewWaitError(
                "PR HEAD changed while waiting: "
                f"expected {expected_head}, got {actual_head or 'missing'}"
            )

        entry = coderabbit_entry(payload)
        status = (
            normalize_status(entry)
            if entry is not None
            else ReviewStatus("MISSING", False, False, "missing", {})
        )
        message = f"CodeRabbit {status.state} on {expected_head[:12]}"
        if progress is not None and message != last_message:
            progress(message)
            last_message = message
        if status.terminal:
            return status
        if time.monotonic() >= deadline:
            raise TimeoutError(
                f"CodeRabbit did not reach a terminal state on {expected_head[:12]} "
                f"within {timeout_seconds:g}s (last state: {status.state})"
            )
        sleeper(max(0.0, poll_seconds))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pr", required=True, help="pull-request number or URL")
    parser.add_argument("--head", required=True, help="exact full PR HEAD SHA")
    parser.add_argument("--repo", help="OWNER/REPO, when not inferable by gh")
    parser.add_argument("--timeout", type=float, default=600.0)
    parser.add_argument("--poll", type=float, default=5.0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        status = wait_for_review(
            pr=args.pr,
            expected_head=args.head,
            repo=args.repo,
            timeout_seconds=args.timeout,
            poll_seconds=args.poll,
            progress=lambda message: print(message, file=sys.stderr, flush=True),
        )
    except (ReviewWaitError, TimeoutError) as error:
        print(str(error), file=sys.stderr)
        return 2

    print(
        json.dumps(
            {
                "head": args.head,
                "kind": status.kind,
                "state": status.state,
                "successful": status.successful,
            },
            separators=(",", ":"),
        )
    )
    return 0 if status.successful else 1


if __name__ == "__main__":
    raise SystemExit(main())
