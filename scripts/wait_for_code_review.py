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

``--after-rate-limit`` handles CodeRabbit's per-account review quota, which
concurrent deploys share: it reads the window from CodeRabbit's rate-limit
comment naming the exact HEAD, sleeps until it reopens (bounded by
``--rate-limit-max-wait``), posts exactly one ``@coderabbitai review`` for that
HEAD (an O_EXCL receipt in ``--receipt-dir`` makes a restart never post twice)
and keeps waiting for the review. Without a parseable window inside the bound
it exits 3 without posting.
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
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from deploy_review_cycle import REVIEW_BOT, names_head


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
# CodeRabbit's per-account quota comments name the HEAD's commit range and the
# time left, e.g. PR 1656 (2026-10-31): "## Review limit reached ... Next included
# review available in 9 minutes." and "## Rate limit exceeded ... Please wait
# **29 minutes and 46 seconds** before requesting another review."
RATE_LIMIT_WORDING = re.compile(
    r"review limit reached|rate limit exceeded|rate limited|usage spending cap|spending cap",
    re.IGNORECASE,
)
RATE_LIMIT_WINDOW = re.compile(
    r"(?:available in|please wait)\s+(?:about\s+)?"
    r"(?P<span>\d+\s*[a-z]+(?:\s*(?:,|and)?\s*\d+\s*[a-z]+)*)",
    re.IGNORECASE,
)
WINDOW_PART = re.compile(r"(\d+)\s*([a-z]+)", re.IGNORECASE)
WINDOW_UNIT_SECONDS = {
    "second": 1, "sec": 1, "s": 1,
    "minute": 60, "min": 60, "m": 60,
    "hour": 3600, "hr": 3600, "h": 3600,
    "day": 86400, "d": 86400,
}
# CodeRabbit rounds the time left down to whole minutes; post a minute later.
RATE_LIMIT_GRACE_SECONDS = 60.0
RE_REQUEST_BODY = "@coderabbitai review"
WINDOW_UNAVAILABLE_EXIT = 3


class ReviewWaitError(RuntimeError):
    """Raised when the requested review cannot safely complete."""


class GhCommandError(ReviewWaitError):
    """A gh call failed or timed out; the next poll may succeed.

    Cloud-agent GitHub tokens rotate on a schedule and can be rejected for
    minutes before the replacement lands, so one failed poll must not end a
    review wait that still has time left.
    """


class WindowUnavailable(ReviewWaitError):
    """No re-request is safe: no parseable window, it is too far away, or one was already spent."""


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


# ``gh api --include`` marks a conditional poll; see _gh_conditional_json.
CONDITIONAL_FLAG = "--include"
HTTP_STATUS_LINE = re.compile(r"^HTTP/\S+\s+(\d{3})")
# Request (minus If-None-Match) -> (ETag, payload) of its last 200 response.
_CONDITIONAL_CACHE: dict[tuple[str, ...], tuple[str, object]] = {}
_RESOLVED_SLUG: list[str] = []


def _gh_json(command: list[str], *, timeout: float | None = None) -> object:
    if CONDITIONAL_FLAG in command:
        return _gh_conditional_json(command, timeout=timeout)
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


def _gh_conditional_json(command: list[str], *, timeout: float | None = None) -> object:
    """A repeated REST poll sent with If-None-Match; a 304 reuses the cached payload.

    GitHub does not count a 304 against the primary REST rate limit, which
    every deploy and thread sharing the token spends. ``gh api --include``
    prints the status line and headers before the body and exits 1 on a 304
    ("gh: HTTP 304"), so the status line, not the exit code, decides.
    """
    key = tuple(command)
    cached = _CONDITIONAL_CACHE.get(key)
    sent = list(command)
    if cached is not None:
        sent[-1:-1] = ["-H", f"If-None-Match: {cached[0]}"]
    try:
        completed = subprocess.run(sent, check=False, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        raise GhCommandError(f"gh timed out after {timeout:g}s: {' '.join(command)}") from error
    parts = re.split(r"\r?\n\r?\n", completed.stdout, maxsplit=1)
    head, body = (parts[0], parts[1]) if len(parts) == 2 else (completed.stdout, "")
    status = HTTP_STATUS_LINE.match(head)
    if status and status.group(1) == "304" and cached is not None:
        return cached[1]
    if completed.returncode != 0:
        raise GhCommandError(completed.stderr.strip() or " ".join(command) + " failed")
    try:
        payload = json.loads(body if status else completed.stdout)
    except json.JSONDecodeError as error:
        raise ReviewWaitError("gh returned invalid JSON") from error
    etag = next((line.split(":", 1)[1].strip() for line in head.splitlines()[1:]
                 if line.lower().startswith("etag:")), "") if status else ""
    if etag:
        _CONDITIONAL_CACHE[key] = (etag, payload)
    return payload


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
    if _RESOLVED_SLUG:
        # The checkout's repository cannot change mid-wait; resolve it once, not on every poll.
        return _RESOLVED_SLUG[0]
    payload = _gh_json(["gh", "repo", "view", "--json", "nameWithOwner"], timeout=timeout)
    if not isinstance(payload, dict) or not payload.get("nameWithOwner"):
        raise ReviewWaitError("could not resolve OWNER/REPO for commit status fallback")
    _RESOLVED_SLUG.append(str(payload["nameWithOwner"]))
    return _RESOLVED_SLUG[0]


def _gh_api_json(
    endpoint: str,
    *,
    repo: str | None = None,
    timeout: float | None = None,
    paginate: bool = False,
    conditional: bool = False,
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
    if conditional:
        command.append(CONDITIONAL_FLAG)
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
        # Re-read on every poll while CodeRabbit is pending: conditional, so an unchanged page is a free 304.
        payload = _gh_api_json(page_endpoint, repo=repo, timeout=_remaining(), conditional=True)
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


def issue_comments(
    pr: str,
    repo: str | None = None,
    *,
    timeout: float | None = None,
) -> list[dict[str, object]]:
    """Every issue comment on the PR (bounded pages, one shared time budget)."""
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
    collected: list[dict[str, object]] = []
    max_pages = 20
    for page in range(1, max_pages + 1):
        comments = _gh_api_json(f"{endpoint}&page={page}", repo=repo, timeout=_remaining())
        if not isinstance(comments, list):
            raise ReviewWaitError("issue comments API returned a non-list payload")
        collected.extend(comment for comment in comments if isinstance(comment, dict))
        if len(comments) < 100:
            break
    return collected


def newest_review_trigger(comments: list[dict[str, object]]) -> datetime | None:
    newest: datetime | None = None
    for comment in comments:
        if not REVIEW_TRIGGER.match(str(comment.get("body") or "")):
            continue
        created = parse_github_time(comment.get("created_at"))
        if created is not None and (newest is None or created > newest):
            newest = created
    return newest


def latest_review_trigger_at(
    pr: str,
    repo: str | None = None,
    *,
    timeout: float | None = None,
) -> datetime | None:
    """Return when the newest ``@coderabbitai review`` comment was posted."""
    return newest_review_trigger(issue_comments(pr, repo, timeout=timeout))


def parse_window_seconds(text: str) -> float | None:
    """Seconds named by "available in 9 minutes" / "please wait 29 minutes and 46 seconds"."""
    match = RATE_LIMIT_WINDOW.search(re.sub(r"[*_`]", "", text))
    if not match:
        return None
    total = 0.0
    for amount, unit in WINDOW_PART.findall(match.group("span")):
        unit = unit.lower()
        seconds = WINDOW_UNIT_SECONDS.get(unit) or WINDOW_UNIT_SECONDS.get(unit.removesuffix("s"))
        if seconds is None:
            return None
        total += int(amount) * seconds
    return total or None


@dataclass(frozen=True)
class RateLimitWindow:
    comment_id: object
    written_at: datetime
    window_seconds: float
    opens_at: datetime


def rate_limit_window(comments: list[dict[str, object]], head: str) -> RateLimitWindow | None:
    """The newest CodeRabbit rate-limit comment naming ``head`` with a parseable window.

    The overview comment is rewritten in place, so its ``updated_at`` is when
    the quoted time-left was written.
    """
    found: list[RateLimitWindow] = []
    for comment in comments:
        user = comment.get("user")
        body = str(comment.get("body") or "")
        if not (isinstance(user, dict) and user.get("login") == REVIEW_BOT):
            continue
        if not (names_head(body, head) and RATE_LIMIT_WORDING.search(body)):
            continue
        written = parse_github_time(comment.get("updated_at") or comment.get("created_at"))
        seconds = parse_window_seconds(body)
        if written is None or seconds is None:
            continue
        opens = written + timedelta(seconds=seconds + RATE_LIMIT_GRACE_SECONDS)
        found.append(RateLimitWindow(comment.get("id"), written, seconds, opens))
    return max(found, key=lambda window: window.written_at) if found else None


def _utc(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def rerequest_receipt_path(receipt_dir: Path, pr: str, head: str) -> Path:
    return receipt_dir / f"coderabbit-rerequest-pr{_pr_number(pr)}-{head}.json"


def rerequest_after_rate_limit(
    *,
    pr: str,
    head: str,
    max_wait_seconds: float,
    receipt_dir: Path,
    comments_loader: Callable[[], list[dict[str, object]]],
    head_loader: Callable[[], str],
    poster: Callable[[], None],
    clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    sleeper: Callable[[float], None] = time.sleep,
    progress: Callable[[str], None] = lambda _message: None,
) -> datetime:
    """Wait out CodeRabbit's quota window, then spend exactly one re-request on ``head``.

    Returns the time the wait for the triggered review starts from. Raises
    ``WindowUnavailable`` (no post) when the window cannot be parsed, is beyond
    ``max_wait_seconds``, or the one re-request for this HEAD was already spent
    and rate-limited again.
    """
    receipt = rerequest_receipt_path(receipt_dir, pr, head)
    comments = comments_loader()
    window = rate_limit_window(comments, head)
    if receipt.is_file():
        record = json.loads(receipt.read_text())
        intent = parse_github_time(record.get("intent_at"))
        if intent is None:
            raise WindowUnavailable(f"unreadable re-request receipt {receipt}")
        if record.get("status") == "failed":
            raise WindowUnavailable(
                f"the one re-request for {head[:12]} failed to post at {_utc(intent)} "
                f"({record.get('error')}); not retried so no second review is spent"
            )
        if window is not None and window.written_at > intent:
            raise WindowUnavailable(
                f"the one re-request for {head[:12]} (receipt {receipt.name}, {_utc(intent)}) was "
                "rate-limited again; not posting a second one"
            )
        progress(f"CodeRabbit re-request for {head[:12]} already posted at {_utc(intent)} "
                 f"(receipt {receipt.name}); waiting for its review without posting again")
        return intent
    if window is None:
        raise WindowUnavailable(
            f"no CodeRabbit rate-limit comment naming {head[:12]} has a parseable review window"
        )
    existing = newest_review_trigger(comments)
    if existing is not None and existing > window.written_at:
        progress(f"a `@coderabbitai review` for {head[:12]} was already posted at {_utc(existing)}, "
                 "after the rate limit; waiting for it without posting again")
        return existing
    wait = (window.opens_at - clock()).total_seconds()
    if wait > max_wait_seconds:
        raise WindowUnavailable(
            f"CodeRabbit's next review window for {head[:12]} opens at {_utc(window.opens_at)} "
            f"({wait:.0f}s away), beyond --rate-limit-max-wait {max_wait_seconds:g}s"
        )
    progress(f"CodeRabbit rate-limited {head[:12]} (comment {window.comment_id}: "
             f"{window.window_seconds:g}s from {_utc(window.written_at)}); waiting until "
             f"{_utc(window.opens_at)} ({max(wait, 0):.0f}s, max {max_wait_seconds:g}s), "
             f"then posting one `{RE_REQUEST_BODY}`")
    if wait > 0:
        sleeper(wait)
    actual = head_loader()
    if actual != head:
        raise ReviewWaitError(
            f"PR HEAD changed while waiting for the review window: expected {head}, got {actual or 'missing'}"
        )
    intent = clock()
    record = {"pr": _pr_number(pr), "head": head, "intent_at": _utc(intent), "status": "posting",
              "comment_id": window.comment_id, "window_seconds": window.window_seconds,
              "opens_at": _utc(window.opens_at)}
    receipt_dir.mkdir(parents=True, exist_ok=True)
    try:
        # O_EXCL: of two concurrent or restarted waiters, only one may ever post.
        handle = os.open(receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        progress(f"another waiter already claimed the re-request for {head[:12]}; not posting again")
        claimed = parse_github_time(json.loads(receipt.read_text()).get("intent_at"))
        return claimed or intent
    with os.fdopen(handle, "w") as stream:
        stream.write(json.dumps(record) + "\n")
    try:
        poster()
    except (ReviewWaitError, OSError, subprocess.SubprocessError) as error:
        _rewrite_receipt(receipt, {**record, "status": "failed", "error": str(error)[:400]})
        raise WindowUnavailable(
            f"posting `{RE_REQUEST_BODY}` for {head[:12]} failed ({error}); not retried so no second "
            "review is spent"
        ) from error
    _rewrite_receipt(receipt, {**record, "status": "posted", "posted_at": _utc(clock())})
    progress(f"posted `{RE_REQUEST_BODY}` for {head[:12]} at {_utc(intent)}; waiting for its review")
    return intent


def _rewrite_receipt(receipt: Path, record: dict[str, object]) -> None:
    temporary = receipt.with_name(f".{receipt.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(record) + "\n")
    temporary.replace(receipt)


def gh_post_rerequest(pr: str, repo: str | None) -> None:
    command = ["gh", "pr", "comment", pr, "--body", RE_REQUEST_BODY]
    if repo:
        command.extend(["--repo", repo])
    try:
        completed = subprocess.run(command, check=False, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired as error:
        raise GhCommandError("gh pr comment timed out") from error
    if completed.returncode != 0:
        raise GhCommandError(completed.stderr.strip() or "gh pr comment failed")


def gh_pr_head(pr: str, repo: str | None) -> str:
    command = ["gh", "pr", "view", pr]
    if repo:
        command.extend(["--repo", repo])
    command.extend(["--json", "headRefOid"])
    payload = _gh_json(command, timeout=60)
    return str(payload.get("headRefOid") or "") if isinstance(payload, dict) else ""


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
    parser.add_argument("--after-rate-limit", action="store_true",
                        help="the check on HEAD was rate-limited: wait out the window, re-request once, wait again")
    parser.add_argument("--rate-limit-max-wait", type=float, default=0.0,
                        help="longest window (seconds) --after-rate-limit will wait for; beyond it exit 3")
    parser.add_argument("--receipt-dir", type=Path,
                        help="directory for the one-per-HEAD re-request receipt (required with --after-rate-limit)")
    args = parser.parse_args()
    if args.after_rate_limit and (args.receipt_dir is None or args.rate_limit_max_wait <= 0):
        parser.error("--after-rate-limit needs --receipt-dir and a positive --rate-limit-max-wait")
    return args


def _record_review_window(triggered_at: datetime | None, waiter_started: float, pr: str, state: str) -> None:
    # A trigger's GitHub time remains stable across re-waits; automatic reviews
    # are measured from waiter startup. Record the same pair on every exit.
    requested = triggered_at.timestamp() if triggered_at is not None else waiter_started
    reason = "manual-trigger" if triggered_at is not None else "waiter-start"
    record_review_event("review-request", requested, pr, reason)
    record_review_event("review-arrival", time.time(), pr, state)


def _report(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def main() -> int:
    args = parse_args()
    waiter_started = time.time()
    triggered_at = None
    try:
        if args.after_rate_limit:
            _validate_repo_ref(args.repo)
            triggered_at = rerequest_after_rate_limit(
                pr=args.pr,
                head=args.head,
                max_wait_seconds=args.rate_limit_max_wait,
                receipt_dir=args.receipt_dir,
                comments_loader=lambda: issue_comments(args.pr, args.repo, timeout=60.0),
                head_loader=lambda: gh_pr_head(args.pr, args.repo),
                poster=lambda: gh_post_rerequest(args.pr, args.repo),
                progress=_report,
            )
        else:
            triggered_at = latest_review_trigger_at(
                args.pr, args.repo, timeout=min(60.0, args.timeout)
            )
        status = wait_for_review(
            pr=args.pr,
            expected_head=args.head,
            repo=args.repo,
            timeout_seconds=args.timeout,
            poll_seconds=args.poll,
            progress=_report,
            triggered_at=triggered_at,
        )
    except WindowUnavailable as error:
        print(f"CODERABBIT_RATE_LIMIT no re-request: {error}", file=sys.stderr)
        _record_review_window(triggered_at, waiter_started, args.pr, "rate-limit-window-unavailable")
        return WINDOW_UNAVAILABLE_EXIT
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
