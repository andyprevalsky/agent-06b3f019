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
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Callable


def _trusted_github_host() -> str:
    """Host gh should talk to (GH_HOST override, else github.com)."""
    return (os.environ.get("GH_HOST") or "github.com").strip() or "github.com"


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
        description = " ".join(
            str(entry.get(key) or "")
            for key in ("description", "title", "output", "summary")
        ).lower()
        if "review skipped" in description:
            return ReviewStatus("REVIEW_SKIPPED", True, False, kind, entry)
        return ReviewStatus(normalized, True, True, kind, entry)
    if normalized in FAILURE_STATES:
        return ReviewStatus(normalized, True, False, kind, entry)
    if normalized in PENDING_STATES or not normalized:
        return ReviewStatus(normalized or "MISSING", False, False, kind, entry)
    return ReviewStatus(normalized, False, False, kind, entry)


def _gh_json(command: list[str], *, timeout: float | None = None) -> object:
    try:
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as error:
        raise ReviewWaitError(
            f"gh timed out after {timeout:g}s: {' '.join(command)}"
        ) from error
    if completed.returncode != 0:
        raise ReviewWaitError(completed.stderr.strip() or " ".join(command) + " failed")
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise ReviewWaitError("gh returned invalid JSON") from error


def _parse_repo_ref(repo: str) -> tuple[str | None, str]:
    """Split optional ``HOST/OWNER/REPO`` into ``(hostname, OWNER/REPO)``."""
    parts = [part for part in repo.split("/") if part]
    if len(parts) == 2:
        return None, "/".join(parts)
    if len(parts) >= 3:
        return parts[0], "/".join(parts[-2:])
    raise ReviewWaitError(f"repo must be OWNER/REPO or HOST/OWNER/REPO, got {repo!r}")


def _repo_slug(repo: str | None, *, timeout: float | None = None) -> str:
    if repo:
        _hostname, slug = _parse_repo_ref(repo)
        del _hostname
        return slug
    payload = _gh_json(["gh", "repo", "view", "--json", "nameWithOwner"], timeout=timeout)
    if not isinstance(payload, dict) or not payload.get("nameWithOwner"):
        raise ReviewWaitError("could not resolve OWNER/REPO for commit status fallback")
    return str(payload["nameWithOwner"])


def _gh_api_json(
    endpoint: str,
    *,
    repo: str | None = None,
    timeout: float | None = None,
    paginate: bool = False,
) -> object:
    hostname: str | None = None
    if repo:
        hostname, _slug = _parse_repo_ref(repo)
    if hostname and hostname != _trusted_github_host():
        raise ReviewWaitError(
            f"refusing untrusted GitHub host {hostname!r}; "
            f"expected {_trusted_github_host()!r}"
        )
    command = ["gh", "api"]
    if hostname:
        command.extend(["--hostname", hostname])
    if paginate:
        command.append("--paginate")
    command.append(endpoint)
    return _gh_json(command, timeout=timeout)


def gh_commit_status_rollup(
    head: str,
    repo: str | None = None,
    *,
    timeout: float | None = None,
) -> list[dict[str, object]]:
    """Build a StatusContext-shaped rollup from the REST commit status API.

    Some cloud-agent tokens can read ``gh pr view --json headRefOid`` and
    ``/commits/{sha}/status``, but GraphQL ``statusCheckRollup`` and the
    Checks API return 403. Commit statuses remain sufficient for CodeRabbit.
    """
    deadline = None if timeout is None else time.monotonic() + float(timeout)

    def _remaining() -> float | None:
        if deadline is None:
            return None
        left = deadline - time.monotonic()
        if left <= 0:
            raise ReviewWaitError("commit status fallback exceeded its time budget")
        return left

    slug = _repo_slug(repo, timeout=_remaining())
    endpoint = f"repos/{slug}/commits/{head}/status?per_page=100"
    # ``gh api --paginate`` concatenates JSON arrays; for the combined status
    # object we walk Link headers by requesting pages until statuses empty.
    rollup: list[dict[str, object]] = []
    page = 1
    max_pages = 20
    while page <= max_pages:
        page_endpoint = f"{endpoint}&page={page}"
        payload = _gh_api_json(page_endpoint, repo=repo, timeout=_remaining())
        if not isinstance(payload, dict):
            raise ReviewWaitError("commit status API returned a non-object payload")
        statuses = payload.get("statuses")
        if not isinstance(statuses, list) or not statuses:
            break
        for entry in statuses:
            if not isinstance(entry, dict):
                continue
            context = entry.get("context")
            state = entry.get("state")
            if not context or not state:
                continue
            mapped: dict[str, object] = {
                "__typename": "StatusContext",
                "context": context,
                "state": str(state).upper(),
            }
            # Preserve description when present so callers can detect
            # non-substantive CodeRabbit successes ("Review skipped", etc.).
            if entry.get("description") is not None:
                mapped["description"] = entry.get("description")
            rollup.append(mapped)
        if len(statuses) < 100:
            break
        page += 1
    # GitHub returns statuses newest-first; coderabbit_entry uses matches[-1]
    # so reverse so the newest status is last.
    rollup.reverse()
    return rollup


def _validate_repo_ref(repo: str | None) -> None:
    """Reject untrusted HOST/OWNER/REPO refs before any gh invocation."""
    if not repo:
        return
    hostname, _slug = _parse_repo_ref(repo)
    if hostname and hostname != _trusted_github_host():
        raise ReviewWaitError(
            f"refusing untrusted GitHub host {hostname!r}; "
            f"expected {_trusted_github_host()!r}"
        )


def gh_payload(
    pr: str,
    repo: str | None = None,
    *,
    timeout: float | None = None,
) -> dict[str, object]:
    deadline = None if timeout is None else time.monotonic() + float(timeout)

    def _remaining() -> float | None:
        if deadline is None:
            return None
        left = deadline - time.monotonic()
        if left <= 0:
            raise ReviewWaitError("gh_payload exceeded its time budget")
        return left

    _validate_repo_ref(repo)

    command = ["gh", "pr", "view", pr]
    if repo:
        command.extend(["--repo", repo])
    command.extend(["--json", "headRefOid,statusCheckRollup"])
    try:
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=_remaining(),
        )
    except subprocess.TimeoutExpired as error:
        raise ReviewWaitError("gh timed out: gh pr view") from error
    if completed.returncode == 0:
        try:
            payload = json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise ReviewWaitError("gh pr view returned invalid JSON") from error
        if not isinstance(payload, dict):
            raise ReviewWaitError("gh pr view returned a non-object payload")
        return payload

    stderr = completed.stderr.strip()
    # Limited tokens often fail only on statusCheckRollup; recover HEAD alone
    # and synthesize the rollup from the REST commit status endpoint.
    if "statusCheckRollup" not in stderr and "Resource not accessible" not in stderr:
        raise ReviewWaitError(stderr or "gh pr view failed")

    head_command = ["gh", "pr", "view", pr]
    if repo:
        head_command.extend(["--repo", repo])
    head_command.extend(["--json", "headRefOid"])
    head_payload = _gh_json(head_command, timeout=_remaining())
    if not isinstance(head_payload, dict):
        raise ReviewWaitError("gh pr view headRefOid returned a non-object payload")
    head = str(head_payload.get("headRefOid") or "")
    if not head:
        raise ReviewWaitError("gh pr view did not return headRefOid")
    return {
        "headRefOid": head,
        "statusCheckRollup": gh_commit_status_rollup(head, repo, timeout=_remaining()),
    }


def wait_for_review(
    *,
    pr: str,
    expected_head: str,
    repo: str | None,
    timeout_seconds: float,
    poll_seconds: float,
    loader: Callable[[str, str | None], dict[str, object]] | None = None,
    sleeper: Callable[[float], None] = time.sleep,
    progress: Callable[[str], None] | None = None,
) -> ReviewStatus:
    deadline = time.monotonic() + timeout_seconds
    last_message = ""

    def default_loader(pr_number: str, repo_name: str | None) -> dict[str, object]:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(
                f"CodeRabbit did not reach a terminal state on {expected_head[:12]} "
                f"within {timeout_seconds:g}s (last state: MISSING)"
            )
        return gh_payload(pr_number, repo_name, timeout=remaining)

    active_loader = loader or default_loader

    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(
                f"CodeRabbit did not reach a terminal state on {expected_head[:12]} "
                f"within {timeout_seconds:g}s (last state: MISSING)"
            )
        payload = active_loader(pr, repo)
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
        sleeper(max(0.0, min(poll_seconds, deadline - time.monotonic())))


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
