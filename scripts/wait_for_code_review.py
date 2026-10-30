#!/usr/bin/env python3
"""Wait for CodeRabbit on one exact pull-request HEAD.

Unlike ``gh pr checks --watch``, this watches only CodeRabbit. The PR HEAD is
validated on every poll, so a success from an older commit can never satisfy
the wait. Both GitHub CheckRun and legacy StatusContext payloads are supported;
neither requires a timestamp to prove freshness because statuses are scoped to
the exact commit SHA.

A manual ``@coderabbitai review`` / ``full review`` comment supersedes an
unsuccessful status (skip, rate limit, failure) that started before it, so the
wait keeps polling for the triggered review instead of returning the stale
skip. Successful reviews of the exact HEAD are accepted regardless of timing.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


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
REVIEW_TRIGGER = re.compile(r"^\s*@coderabbitai\s+(full\s+)?review\b", re.IGNORECASE)
# What CodeRabbit posts for the push itself when review-on-push is disabled. It
# is never the result of a `@coderabbitai review` command, and it can land
# after the command and before the commanded review starts (PR 1415: command
# 02:27:32Z, this skip 02:28:06Z, "Review in progress" 02:28:43Z).
PUSH_AUTO_SKIP = "incremental reviews are disabled"


class ReviewWaitError(RuntimeError):
    """Raised when the requested review cannot safely complete."""


class GhCommandError(ReviewWaitError):
    """A gh call failed or timed out; the next poll may succeed.

    Cloud-agent GitHub tokens rotate on a schedule and can be rejected for
    minutes before the replacement lands, so one failed poll must not end a
    review wait that still has time left.
    """


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
        # GraphQL rollup often reports SUCCESS for non-reviews. Treat quota /
        # skip outcomes as unsuccessful so /deploy cannot false-green on them.
        if "review skipped" in description:
            return ReviewStatus("REVIEW_SKIPPED", True, False, kind, entry)
        if (
            "rate limited" in description
            or "review limit reached" in description
            or "usage spending cap" in description
            or "spending cap" in description
        ):
            return ReviewStatus("REVIEW_RATE_LIMITED", True, False, kind, entry)
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
        raise GhCommandError(
            f"gh timed out after {timeout:g}s: {' '.join(command)}"
        ) from error
    if completed.returncode != 0:
        raise GhCommandError(completed.stderr.strip() or " ".join(command) + " failed")
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
            if entry.get("created_at"):
                mapped["startedAt"] = entry.get("created_at")
            rollup.append(mapped)
        if len(statuses) < 100:
            break
        page += 1
    # GitHub returns statuses newest-first; coderabbit_entry uses matches[-1]
    # so reverse so the newest status is last.
    rollup.reverse()
    return rollup


def parse_github_time(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None


def _pr_number(pr: str) -> str:
    match = re.search(r"(\d+)/*$", pr.strip())
    if not match:
        raise ReviewWaitError(f"could not parse a pull-request number from {pr!r}")
    return match.group(1)


def latest_review_trigger_at(
    pr: str,
    repo: str | None = None,
    *,
    timeout: float | None = None,
) -> datetime | None:
    """Return when the newest ``@coderabbitai review`` comment was posted."""
    deadline = None if timeout is None else time.monotonic() + float(timeout)

    def _remaining() -> float | None:
        if deadline is None:
            return None
        left = deadline - time.monotonic()
        if left <= 0:
            raise ReviewWaitError("review trigger lookup exceeded its time budget")
        return left

    _validate_repo_ref(repo)
    slug = _repo_slug(repo, timeout=_remaining())
    endpoint = f"repos/{slug}/issues/{_pr_number(pr)}/comments?per_page=100"
    newest: datetime | None = None
    max_pages = 20
    for page in range(1, max_pages + 1):
        comments = _gh_api_json(f"{endpoint}&page={page}", repo=repo, timeout=_remaining())
        if not isinstance(comments, list):
            raise ReviewWaitError("issue comments API returned a non-list payload")
        for comment in comments:
            if not isinstance(comment, dict):
                continue
            if not REVIEW_TRIGGER.match(str(comment.get("body") or "")):
                continue
            created = parse_github_time(comment.get("created_at"))
            if created is not None and (newest is None or created > newest):
                newest = created
        if len(comments) < 100:
            break
    return newest


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
        raise GhCommandError("gh timed out: gh pr view") from error
    if completed.returncode == 0:
        try:
            payload = json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise ReviewWaitError("gh pr view returned invalid JSON") from error
        if not isinstance(payload, dict):
            raise ReviewWaitError("gh pr view returned a non-object payload")
        return _enrich_coderabbit_description(payload, repo, timeout=_remaining())

    stderr = completed.stderr.strip()
    # Limited tokens often fail only on statusCheckRollup; recover HEAD alone
    # and synthesize the rollup from the REST commit status endpoint.
    if "statusCheckRollup" not in stderr and "Resource not accessible" not in stderr:
        raise GhCommandError(stderr or "gh pr view failed")

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


def _enrich_coderabbit_description(
    payload: dict[str, object],
    repo: str | None,
    *,
    timeout: float | None = None,
) -> dict[str, object]:
    """Copy REST StatusContext.description onto GraphQL CodeRabbit successes.

    ``gh pr view --json statusCheckRollup`` omits description, so
    ``Review skipped: incremental reviews are disabled`` looks like a real
    SUCCESS and /deploy false-greens. REST ``/commits/{sha}/status`` still
    has the skip text.
    """
    entry = coderabbit_entry(payload)
    if entry is None or entry.get("description"):
        return payload
    head = str(payload.get("headRefOid") or "")
    if not head:
        return payload
    rest = gh_commit_status_rollup(head, repo, timeout=timeout)
    rest_entry = coderabbit_entry({"statusCheckRollup": rest})
    if rest_entry and rest_entry.get("description") is not None:
        entry["description"] = rest_entry["description"]
    return payload


def _is_push_auto_skip(status: ReviewStatus) -> bool:
    """Whether a skip is the push's own rather than the result of a command."""
    description = str(status.raw.get("description") or "").lower()
    return status.state == "REVIEW_SKIPPED" and PUSH_AUTO_SKIP in description


def _awaiting_triggered_review(status: ReviewStatus, triggered_at: datetime) -> bool:
    """Whether a terminal non-success still predates the commanded review.

    The push's auto-skip is never a command's result, whenever it was posted,
    so it never ends a commanded wait. CodeRabbit has taken from one to seven
    minutes to start a commanded review (PR 1415: 71s, PR 1348: 391s), and no
    shorter cut-off can tell a slow start from a command it ignored; an ignored
    command ends at the wait's own timeout, which routes to the fallback. Any
    other result counts only if it was posted after the command.
    """
    if _is_push_auto_skip(status):
        return True
    started = parse_github_time(status.raw.get("startedAt"))
    return started is None or started < triggered_at


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
    triggered_at: datetime | None = None,
) -> ReviewStatus:
    deadline = time.monotonic() + timeout_seconds
    last_message = ""
    last_state = "MISSING"

    def timed_out() -> TimeoutError:
        return TimeoutError(
            f"CodeRabbit did not reach a terminal state on {expected_head[:12]} "
            f"within {timeout_seconds:g}s (last state: {last_state})"
        )

    def default_loader(pr_number: str, repo_name: str | None) -> dict[str, object]:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise timed_out()
        try:
            return gh_payload(pr_number, repo_name, timeout=remaining)
        except ReviewWaitError as error:
            if deadline - time.monotonic() <= 0:
                raise timed_out() from error
            raise

    active_loader = loader or default_loader

    def _report(message: str) -> None:
        nonlocal last_message
        if progress is not None and message != last_message:
            progress(message)
            last_message = message

    while True:
        if deadline - time.monotonic() <= 0:
            raise timed_out()
        try:
            payload = active_loader(pr, repo)
        except GhCommandError as error:
            last_state = f"gh error: {error}"
            _report(f"gh failed while waiting on {expected_head[:12]}; retrying: {error}")
            sleeper(max(0.0, min(poll_seconds, deadline - time.monotonic())))
            continue
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
        if (
            triggered_at is not None
            and status.terminal
            and not status.successful
            and _awaiting_triggered_review(status, triggered_at)
        ):
            status = ReviewStatus(
                "AWAITING_TRIGGERED_REVIEW", False, False, status.kind, status.raw
            )
        last_state = status.state
        _report(f"CodeRabbit {status.state} on {expected_head[:12]}")
        if status.terminal:
            return status
        if time.monotonic() >= deadline:
            raise timed_out()
        sleeper(max(0.0, min(poll_seconds, deadline - time.monotonic())))


def record_review_event(event: str, epoch: float, pr: str, state: str | None = None) -> None:
    """Best-effort factory event so reviews can separate review wait from work."""
    try:
        from factory_detail import parse_event_detail
        from record_factory_event import append_event, default_event_log, factory_event_payload

        pairs = [f"pr_number={_pr_number(pr)}"]
        if state:
            pairs.append(f"reason={state}")
        payload = factory_event_payload(
            "deploy", event, "coderabbit", recorded_epoch=epoch, detail=parse_event_detail(pairs)
        )
        append_event(Path(os.environ.get("FACTORY_EVENT_LOG", str(default_event_log()))), payload)
    except (ImportError, OSError, ValueError, ReviewWaitError) as error:
        print(f"warning: could not record review {event}: {error}", file=sys.stderr)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pr", required=True, help="pull-request number or URL")
    parser.add_argument("--head", required=True, help="exact full PR HEAD SHA")
    parser.add_argument("--repo", help="OWNER/REPO, when not inferable by gh")
    parser.add_argument("--timeout", type=float, default=600.0)
    parser.add_argument("--poll", type=float, default=5.0)
    return parser.parse_args()


def _record_review_window(triggered_at: datetime | None, waiter_started: float, pr: str, state: str) -> None:
    # A trigger's GitHub time remains stable across re-waits; automatic reviews
    # are measured from waiter startup. Record the same pair on every exit.
    requested = triggered_at.timestamp() if triggered_at is not None else waiter_started
    reason = "manual-trigger" if triggered_at is not None else "waiter-start"
    record_review_event("review-request", requested, pr, reason)
    record_review_event("review-arrival", time.time(), pr, state)


def main() -> int:
    args = parse_args()
    waiter_started = time.time()
    triggered_at = None
    try:
        triggered_at = latest_review_trigger_at(
            args.pr, args.repo, timeout=min(60.0, args.timeout)
        )
        status = wait_for_review(
            pr=args.pr,
            expected_head=args.head,
            repo=args.repo,
            timeout_seconds=args.timeout,
            poll_seconds=args.poll,
            progress=lambda message: print(message, file=sys.stderr, flush=True),
            triggered_at=triggered_at,
        )
    except (ReviewWaitError, TimeoutError) as error:
        print(str(error), file=sys.stderr)
        _record_review_window(triggered_at, waiter_started, args.pr,
                              "timeout" if isinstance(error, TimeoutError) else "error")
        return 2
    _record_review_window(triggered_at, waiter_started, args.pr, status.state)

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
