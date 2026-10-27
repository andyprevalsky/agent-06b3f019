#!/usr/bin/env python3
"""Read the optional Graphide review of one exact pull-request HEAD.

Graphide Review (GitHub App ``graphide-review``) reviews a pull request when
someone mentions ``@graphide-review`` on it. Its result is a check run on the
commit; PR comments are a per-repository opt-in that starts off, so reviews,
inline comments and issue comments are read too when present.

This review is advisory and SKIPPABLE: every outcome (finished, missing, slow,
errored, unavailable, HEAD moved) exits 0 and prints exactly one JSON object on
stdout with ``status`` ``completed`` or ``skipped`` plus ``reason``. /deploy
must never block on it. Classification of findings is left to the caller.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import time
from collections.abc import Callable
from datetime import datetime
from pathlib import Path

APP_SLUG = "graphide-review"
BOT_LOGIN = f"{APP_SLUG}[bot]"
# Completed check runs whose conclusion means Graphide never produced a review.
NON_REVIEW_CONCLUSIONS = {"cancelled", "skipped", "stale", "startup_failure", "timed_out"}
MAX_PAGES = 20

_SPEC = importlib.util.spec_from_file_location(
    "wait_for_code_review", Path(__file__).resolve().parent / "wait_for_code_review.py"
)
assert _SPEC and _SPEC.loader
_WAIT = importlib.util.module_from_spec(_SPEC)
sys.modules.setdefault(_SPEC.name, _WAIT)
_SPEC.loader.exec_module(_WAIT)

Api = Callable[[str], object]


def _is_graphide(item: dict[str, object]) -> bool:
    user = item.get("user")
    login = str(user.get("login") or "") if isinstance(user, dict) else ""
    app = item.get("performed_via_github_app")
    slug = str(app.get("slug") or "") if isinstance(app, dict) else ""
    return login.lower() == BOT_LOGIN or slug == APP_SLUG


def _pages(api: Api, endpoint: str, key: str | None = None) -> list[dict[str, object]]:
    items: list[dict[str, object]] = []
    separator = "&" if "?" in endpoint else "?"
    for page in range(1, MAX_PAGES + 1):
        payload = api(f"{endpoint}{separator}per_page=100&page={page}")
        batch = payload.get(key) if key and isinstance(payload, dict) else payload
        if not isinstance(batch, list):
            raise _WAIT.ReviewWaitError(f"unexpected payload from {endpoint}")
        items.extend(item for item in batch if isinstance(item, dict))
        if len(batch) < 100:
            break
    return items


def _check_run(api: Api, slug: str, run: dict[str, object]) -> dict[str, object]:
    output = run.get("output") if isinstance(run.get("output"), dict) else {}
    assert isinstance(output, dict)
    annotations: list[dict[str, object]] = []
    if int(output.get("annotations_count") or 0) > 0 and run.get("id") is not None:
        annotations = _pages(api, f"repos/{slug}/check-runs/{run['id']}/annotations")
    return {
        "id": run.get("id"),
        "name": run.get("name"),
        "status": run.get("status"),
        "conclusion": run.get("conclusion"),
        "html_url": run.get("html_url"),
        "title": output.get("title"),
        "summary": output.get("summary"),
        "text": output.get("text"),
        "annotations": [
            {
                key: annotation.get(key)
                for key in (
                    "path",
                    "start_line",
                    "end_line",
                    "annotation_level",
                    "title",
                    "message",
                    "raw_details",
                )
            }
            for annotation in annotations
        ],
    }


def _comment(item: dict[str, object]) -> dict[str, object]:
    keys = ("id", "state", "path", "line", "body", "html_url", "created_at", "submitted_at")
    return {key: item[key] for key in keys if key in item}


def observe(
    api: Api, *, slug: str, pr: str, head: str, since: datetime | None
) -> dict[str, object]:
    """One poll. Returns a terminal result or ``{"status": "pending"}``."""
    pull = api(f"repos/{slug}/pulls/{pr}")
    actual = ""
    if isinstance(pull, dict) and isinstance(pull.get("head"), dict):
        actual = str(pull["head"].get("sha") or "")
    if actual != head:
        return {"status": "skipped", "reason": f"PR HEAD changed to {actual or 'missing'}"}

    runs = [
        run
        for run in _pages(api, f"repos/{slug}/commits/{head}/check-runs", "check_runs")
        if isinstance(run.get("app"), dict) and run["app"].get("slug") == APP_SLUG
    ]
    reviews = [
        _comment(item)
        for item in _pages(api, f"repos/{slug}/pulls/{pr}/reviews")
        if _is_graphide(item) and item.get("commit_id") == head
    ]
    review_comments = [
        _comment(item)
        for item in _pages(api, f"repos/{slug}/pulls/{pr}/comments")
        if _is_graphide(item)
        and head in (item.get("commit_id"), item.get("original_commit_id"))
    ]
    issue_comments = []
    for item in _pages(api, f"repos/{slug}/issues/{pr}/comments"):
        created = _WAIT.parse_github_time(item.get("created_at"))
        fresh = since is None or (created is not None and created >= since)
        if _is_graphide(item) and fresh:
            issue_comments.append(_comment(item))

    completed = [run for run in runs if str(run.get("status")) == "completed"]
    reviewed = [
        run for run in completed if str(run.get("conclusion")) not in NON_REVIEW_CONCLUSIONS
    ]
    if not reviewed and not (reviews or review_comments or issue_comments):
        if runs and len(completed) == len(runs):
            conclusions = ",".join(sorted({str(run.get("conclusion")) for run in runs}))
            return {"status": "skipped", "reason": f"Graphide check concluded {conclusions}"}
        reason = "Graphide check in progress" if runs else "no Graphide review yet"
        return {"status": "pending", "reason": reason}
    result = {
        "status": "completed",
        "reason": "Graphide review read",
        "check_runs": [_check_run(api, slug, run) for run in reviewed],
        "reviews": reviews,
        "review_comments": review_comments,
        "issue_comments": issue_comments,
    }
    result["finding_count"] = sum(len(run["annotations"]) for run in result["check_runs"]) + len(
        review_comments
    )
    return result


def read_review(
    *,
    pr: str,
    head: str,
    slug: str,
    since: datetime | None,
    timeout_seconds: float,
    poll_seconds: float,
    api: Api,
    sleeper: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> dict[str, object]:
    deadline = clock() + timeout_seconds
    last = "not polled"
    while True:
        try:
            result = observe(api, slug=slug, pr=pr, head=head, since=since)
        except Exception as error:  # every failure is a skip, never a deploy blocker
            result = {"status": "pending", "reason": f"GitHub read failed: {error}"}
        last = str(result.get("reason"))
        if result["status"] != "pending":
            break
        if clock() + poll_seconds > deadline:
            reason = f"timed out after {timeout_seconds:g}s ({last})"
            result = {"status": "skipped", "reason": reason}
            break
        sleeper(poll_seconds)
    result["head"] = head
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pr", required=True, help="pull-request number")
    parser.add_argument("--head", required=True, help="exact full PR HEAD SHA")
    parser.add_argument("--repo", help="OWNER/REPO, when not inferable by gh")
    parser.add_argument("--since", help="UTC time the @graphide-review request was posted")
    parser.add_argument("--timeout", type=float, default=600.0)
    parser.add_argument("--poll", type=float, default=15.0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    since = _WAIT.parse_github_time(args.since) if args.since else None
    try:
        slug = _WAIT._repo_slug(args.repo, timeout=60.0)
        pr = _WAIT._pr_number(args.pr)
    except Exception as error:
        result: dict[str, object] = {
            "status": "skipped",
            "reason": f"could not resolve repository: {error}",
            "head": args.head,
        }
    else:
        result = read_review(
            pr=pr,
            head=args.head,
            slug=slug,
            since=since,
            timeout_seconds=args.timeout,
            poll_seconds=args.poll,
            api=lambda endpoint: _WAIT._gh_api_json(endpoint, repo=args.repo, timeout=60.0),
        )
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
