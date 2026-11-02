#!/usr/bin/env python3
"""Track and enforce bounded /deploy code-review lifecycles.

Cycles are ``initial`` → ``incremental`` → ``verification`` (cap 3). A cycle
closed ``unavailable`` never received a review (its HEAD was superseded
first), so it consumes no review budget: the superseding HEAD re-requests the
same kind (``next`` prints it) and the entry stays in the ledger as history;
``--reset`` is for a new deploy, not for this case.

Two versioned dispositions close an open cycle ``clean`` with evidence and a
``TEST_REPORT`` row (deploy.md Step 9a): ``skip`` for confirmed CodeRabbit
usage exhaustion and ``override`` for the standing three-round deferral. Both
refuse without the evidence and append ``deploy-review-dispositions.jsonl``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path


MAX_REVIEW_CYCLES = 3
KINDS = {"initial", "incremental", "verification"}
RESULTS = {"clean", "findings", "unavailable"}
UNAVAILABLE = "unavailable"
KIND_BY_POSITION = {1: "initial", 2: "incremental", 3: "verification"}
SYNC_KIND = "sync-inherited"
# Files regenerated from the merged tree after a main sync. Their content is
# derived, so a sync may change them without new review.
GENERATED_PATHS = frozenset({"docs/rca/INDEX.md"})

REVIEW_BOT = "coderabbitai[bot]"
# CodeRabbit wraps its replies to review-thread comments in empty-body
# COMMENTED reviews on the same HEAD (PR 1656: reviews 5722158877/5722158908
# carried its "The supplied code addresses this finding" replies). Only a body
# with a verdict is a review; a review-by-HEAD count is not.
SUBSTANTIVE_REVIEW = re.compile(
    r"actionable comments posted|lgtm|no actionable|approved|reviewed", re.IGNORECASE
)
FINDINGS_COUNT = re.compile(r"actionable comments posted:\s*(\d+)", re.IGNORECASE)
# Only these words prove usage exhaustion; "Review rate limited" / "Action not
# completed" alone do not (deploy.md Step 9a).
USAGE_EXHAUSTED = re.compile(r"review limit reached|usage spending cap|spending cap", re.IGNORECASE)
DEFERRED_REPLY = re.compile(r"^\s*\[(DEFERRED|FIXED)\]", re.IGNORECASE)
ANSWERED_REPLY = re.compile(r"^\s*\[(DEFERRED|FIXED|IGNORED|NOTED)\]", re.IGNORECASE)
SKIP_REASONS = {"usage-cap"}
MIN_OVERRIDE_ROUNDS = 3
RECEIPTS_NAME = "deploy-review-dispositions.jsonl"
GH_PAGE_SIZE = 100
GH_MAX_PAGES = 20
GH_TIMEOUT_SECONDS = 120.0


class ReviewCycleError(RuntimeError):
    """Raised when the review lifecycle would become unsafe or unbounded."""


def default_state_path() -> Path:
    return Path.cwd() / ".context" / "deploy-review-cycle.json"


def default_receipts_path(state_path: Path) -> Path:
    return state_path.with_name(RECEIPTS_NAME)


def read_state(path: Path) -> dict[str, object]:
    try:
        state = json.loads(path.read_text())
    except FileNotFoundError as error:
        raise ReviewCycleError("review cycle state is not initialized") from error
    except (json.JSONDecodeError, OSError) as error:
        raise ReviewCycleError(f"could not read review cycle state: {error}") from error
    if not isinstance(state, dict) or not isinstance(state.get("cycles"), list):
        raise ReviewCycleError("invalid review cycle state")
    return state


def write_state(path: Path, state: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(state, indent=2) + "\n")
    temporary.replace(path)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def review_cycles(entries: list[object]) -> list[dict[str, object]]:
    """Real review cycles; audited sync inheritances never count toward the cap."""
    return [
        entry
        for entry in entries
        if isinstance(entry, dict) and entry.get("kind") != SYNC_KIND
    ]


def budget_cycles(entries: list[object]) -> list[dict[str, object]]:
    """Open or delivered reviews; quota skips retain history without spending a round."""
    return [cycle for cycle in review_cycles(entries)
            if cycle.get("result") != UNAVAILABLE and cycle.get("disposition") != "skipped"]


def next_cycle(entries: list[object]) -> dict[str, object]:
    """The cycle the ledger will accept next (number, kind, replaced HEAD)."""
    cycles = review_cycles(entries)
    if cycles and cycles[-1].get("status") == "open":
        raise ReviewCycleError("the previous review cycle is still open")
    consumed = budget_cycles(entries)
    if len(consumed) >= MAX_REVIEW_CYCLES:
        raise ReviewCycleError(
            f"review cycle cap reached ({MAX_REVIEW_CYCLES}); stop /deploy as review-unstable"
        )
    position = len(consumed) + 1
    replaces = None
    if cycles and cycles[-1].get("result") == UNAVAILABLE:
        replaces = str(cycles[-1].get("head"))
    return {"number": position, "kind": KIND_BY_POSITION[position], "replaces": replaces}


def start_cycle(
    path: Path, *, head: str, kind: str, reset: bool = False
) -> dict[str, object]:
    if not head:
        raise ReviewCycleError("review HEAD must not be empty")
    if kind not in KINDS:
        raise ReviewCycleError(f"invalid review kind: {kind}")
    if reset:
        state: dict[str, object] = {"schema_version": 1, "cycles": []}
    else:
        state = read_state(path)
    entries = state["cycles"]
    assert isinstance(entries, list)
    expected = next_cycle(entries)
    if any(entry.get("head") == head for entry in entries if isinstance(entry, dict)):
        raise ReviewCycleError("this exact HEAD already completed a review cycle")
    cycle_number = int(expected["number"])
    if kind != expected["kind"]:
        hint = ""
        if expected["replaces"]:
            hint = (
                f" (cycle {cycle_number} on {str(expected['replaces'])[:12]} closed unavailable"
                f" and consumed no review; the superseding HEAD re-requests {expected['kind']}"
                " — `deploy_review_cycle.py next` prints it; do not --reset)"
            )
        raise ReviewCycleError(
            f"review cycle {cycle_number} must be {expected['kind']}, not {kind}{hint}"
        )
    if cycle_number == 3:
        previous = budget_cycles(entries)[-1]
        if previous.get("result") != "findings":
            raise ReviewCycleError(
                "verification review is allowed only after cycle two found a valid issue"
            )
    cycle: dict[str, object] = {
        "number": cycle_number,
        "kind": kind,
        "head": head,
        "status": "open",
        "started_at": now(),
    }
    if expected["replaces"]:
        cycle["replaces"] = expected["replaces"]
    entries.append(cycle)
    write_state(path, state)
    return cycle


def _open_cycle(state: dict[str, object], head: str) -> dict[str, object]:
    cycles = state["cycles"]
    assert isinstance(cycles, list)
    if not cycles or not isinstance(cycles[-1], dict):
        raise ReviewCycleError("no review cycle is open")
    cycle = cycles[-1]
    if cycle.get("status") != "open":
        raise ReviewCycleError("no review cycle is open")
    if cycle.get("head") != head:
        raise ReviewCycleError(
            f"review HEAD mismatch: cycle has {cycle.get('head')}, got {head}"
        )
    return cycle


def finish_cycle(path: Path, *, head: str, result: str) -> dict[str, object]:
    if result not in RESULTS:
        raise ReviewCycleError(f"invalid review result: {result}")
    state = read_state(path)
    cycle = _open_cycle(state, head)
    cycle.update({"status": "completed", "result": result, "finished_at": now()})
    write_state(path, state)
    return cycle


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True, check=False
    )
    if result.returncode != 0:
        raise ReviewCycleError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


def resolve(repo: Path, ref: str) -> str:
    return git(repo, "rev-parse", "--verify", f"{ref}^{{commit}}").strip()


def is_ancestor(repo: Path, ancestor: str, descendant: str) -> bool:
    return (
        subprocess.run(
            ["git", "merge-base", "--is-ancestor", ancestor, descendant],
            cwd=repo,
            check=False,
        ).returncode
        == 0
    )


def branch_diff(repo: Path, head: str, base: str) -> str:
    """The branch-only change: merge-base(head, base)..head, generated files excluded."""
    fork = git(repo, "merge-base", head, base).strip()
    excludes = [f":(exclude){name}" for name in sorted(GENERATED_PATHS)]
    return git(repo, "diff", "--binary", "--full-index", fork, head, "--", ".", *excludes)


def changed_files(repo: Path, old: str, new: str) -> set[str]:
    return {line for line in git(repo, "diff", "--name-only", old, new).splitlines() if line}


def inherit_sync(
    path: Path, *, head: str, base: str, repo: Path
) -> dict[str, object]:
    """Carry a clean review onto a HEAD that only synced the base branch.

    Refuses unless the latest real review is clean, every commit after the
    reviewed HEAD is a merge of base-branch history, the branch-only diff is
    byte-identical to the reviewed one (generated files excluded), and every
    file the sync changed was changed on base or is generated.
    """
    state = read_state(path)
    entries = state["cycles"]
    assert isinstance(entries, list)
    cycles = review_cycles(entries)
    if not cycles or cycles[-1].get("status") != "completed":
        raise ReviewCycleError("sync inheritance needs a completed review cycle")
    reviewed = cycles[-1]
    if reviewed.get("result") != "clean":
        raise ReviewCycleError(
            f"latest review result is {reviewed.get('result')}; nothing clean to inherit"
        )
    latest = entries[-1]
    assert isinstance(latest, dict)
    source = str(latest.get("head"))
    head = resolve(repo, head)
    base_sha = resolve(repo, base)
    source = resolve(repo, source)
    if head == source:
        raise ReviewCycleError("HEAD is already the reviewed HEAD")
    if not is_ancestor(repo, source, head):
        raise ReviewCycleError("reviewed HEAD is not an ancestor of HEAD; review the new history")
    for commit in git(repo, "rev-list", "--first-parent", f"{source}..{head}").split():
        parents = git(repo, "rev-list", "--parents", "-n", "1", commit).split()[1:]
        if len(parents) < 2:
            raise ReviewCycleError(f"{commit[:12]} is not a sync merge; review the new commit")
        if not all(is_ancestor(repo, parent, base_sha) for parent in parents[1:]):
            raise ReviewCycleError(f"{commit[:12]} merges history that is not on {base}")
    reviewed_diff = branch_diff(repo, source, base_sha)
    synced_diff = branch_diff(repo, head, base_sha)
    if reviewed_diff != synced_diff:
        raise ReviewCycleError("branch diff differs from the reviewed diff; review the change")
    fork = git(repo, "merge-base", source, base_sha).strip()
    main_side = changed_files(repo, fork, base_sha)
    unexpected = sorted(changed_files(repo, source, head) - main_side - GENERATED_PATHS)
    if unexpected:
        raise ReviewCycleError(
            "sync changed files that neither base nor a generator changed: "
            + ", ".join(unexpected)
        )
    entry = {
        "number": len(entries) + 1,
        "kind": SYNC_KIND,
        "head": head,
        "status": "completed",
        "result": "clean",
        "inherited_from": source,
        "base": base_sha,
        "branch_diff_sha256": hashlib.sha256(synced_diff.encode()).hexdigest(),
        "generated_changed": sorted(changed_files(repo, source, head) & GENERATED_PATHS),
        "started_at": now(),
        "finished_at": now(),
    }
    entries.append(entry)
    write_state(path, state)
    return entry


def require_mergeable(path: Path, *, head: str) -> dict[str, object]:
    state = read_state(path)
    cycles = state["cycles"]
    assert isinstance(cycles, list)
    if not cycles or not isinstance(cycles[-1], dict):
        raise ReviewCycleError("HEAD has no completed review")
    cycle = cycles[-1]
    if cycle.get("status") != "completed":
        raise ReviewCycleError("the latest review cycle is still open")
    if cycle.get("head") != head:
        raise ReviewCycleError(
            f"current HEAD {head} is unreviewed; latest reviewed HEAD is {cycle.get('head')}"
        )
    if cycle.get("result") != "clean":
        raise ReviewCycleError(
            f"latest review result is {cycle.get('result')}; current HEAD is not mergeable"
        )
    return cycle


# ---------------------------------------------------------------------------
# Step 9a dispositions: evidence-bound ``skip`` and ``override``
# ---------------------------------------------------------------------------


def _as_list(value: object, name: str) -> list[dict[str, object]]:
    if isinstance(value, dict) and isinstance(value.get(name), list):
        value = value[name]
    if not isinstance(value, list):
        raise ReviewCycleError(f"evidence {name!r} must be a list")
    return [item for item in value if isinstance(item, dict)]


def normalize_evidence(data: object, *, source: str) -> dict[str, object]:
    """Raw GitHub payloads: issue comments, check runs, reviews, review comments."""
    if not isinstance(data, dict):
        raise ReviewCycleError("evidence must be a JSON object")
    evidence: dict[str, object] = {
        "issue_comments": _as_list(data.get("issue_comments", []), "issue_comments"),
        "check_runs": _as_list(data.get("check_runs", []), "check_runs"),
        "reviews": _as_list(data.get("reviews", []), "reviews"),
        "review_comments": _as_list(data.get("review_comments", []), "review_comments"),
        "source": source,
        "captured_at": str(data.get("captured_at") or now()),
    }
    return evidence


def _gh_json(args: list[str]) -> object:
    try:
        completed = subprocess.run(
            ["gh", *args], capture_output=True, text=True, check=False, timeout=GH_TIMEOUT_SECONDS
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ReviewCycleError(f"gh {' '.join(args)} failed: {error}") from error
    if completed.returncode != 0:
        raise ReviewCycleError(f"gh {' '.join(args)} failed: {completed.stderr.strip()}")
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise ReviewCycleError(f"gh {' '.join(args)} returned invalid JSON") from error


def _gh_pages(endpoint: str) -> list[object]:
    items: list[object] = []
    for page in range(1, GH_MAX_PAGES + 1):
        payload = _gh_json(["api", f"{endpoint}?per_page={GH_PAGE_SIZE}&page={page}"])
        if not isinstance(payload, list):
            raise ReviewCycleError(f"{endpoint} returned a non-list payload")
        items.extend(payload)
        if len(payload) < GH_PAGE_SIZE:
            break
    return items


def fetch_evidence(*, pr: str, head: str, repo: str | None) -> dict[str, object]:
    """Capture the three CodeRabbit endpoints plus the check runs for HEAD via gh."""
    slug = repo
    if not slug:
        payload = _gh_json(["repo", "view", "--json", "nameWithOwner"])
        slug = str(payload.get("nameWithOwner") or "") if isinstance(payload, dict) else ""
        if not slug:
            raise ReviewCycleError("could not resolve OWNER/REPO; pass --repo")
    check_runs = _gh_json(["api", f"repos/{slug}/commits/{head}/check-runs?per_page={GH_PAGE_SIZE}"])
    return normalize_evidence(
        {
            "issue_comments": _gh_pages(f"repos/{slug}/issues/{pr}/comments"),
            "check_runs": check_runs,
            "reviews": _gh_pages(f"repos/{slug}/pulls/{pr}/reviews"),
            "review_comments": _gh_pages(f"repos/{slug}/pulls/{pr}/comments"),
            "captured_at": now(),
        },
        source=f"gh:{slug}",
    )


def load_evidence(
    evidence_path: Path | None, *, pr: str, head: str, repo: str | None
) -> dict[str, object]:
    if evidence_path is None:
        return fetch_evidence(pr=pr, head=head, repo=repo)
    try:
        data = json.loads(evidence_path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise ReviewCycleError(f"could not read evidence {evidence_path}: {error}") from error
    return normalize_evidence(data, source=str(evidence_path))


def _is_bot(entry: dict[str, object]) -> bool:
    user = entry.get("user")
    return isinstance(user, dict) and user.get("login") == REVIEW_BOT


def _body(entry: dict[str, object]) -> str:
    return str(entry.get("body") or "")


def names_head(text: str, head: str) -> bool:
    """Whether ``text`` names ``head`` (full SHA or a ≥7-hex-digit prefix)."""
    head = head.lower()
    for match in re.finditer(r"(?<![0-9a-f])[0-9a-f]{7,40}(?![0-9a-f])", text.lower()):
        if head.startswith(match.group(0)):
            return True
    return False


def coderabbit_reviews(reviews: list[dict[str, object]], head: str) -> list[dict[str, object]]:
    return [review for review in reviews if _is_bot(review) and review.get("commit_id") == head]


def substantive_reviews(reviews: list[dict[str, object]], head: str) -> list[dict[str, object]]:
    """CodeRabbit reviews of HEAD with a verdict body; reply wrappers are not reviews."""
    return [review for review in coderabbit_reviews(reviews, head) if SUBSTANTIVE_REVIEW.search(_body(review))]


def review_findings(review: dict[str, object]) -> int | None:
    match = FINDINGS_COUNT.search(_body(review))
    return int(match.group(1)) if match else None


def _check_time(run: dict[str, object]) -> str:
    return str(run.get("completed_at") or run.get("started_at") or "")


def coderabbit_check_runs(check_runs: list[dict[str, object]], head: str) -> list[dict[str, object]]:
    runs = [
        run
        for run in check_runs
        if str(run.get("name") or "").lower() == "coderabbit"
        and (not run.get("head_sha") or run.get("head_sha") == head)
    ]
    return sorted(runs, key=_check_time)


def _check_title(run: dict[str, object]) -> str:
    output = run.get("output")
    return str(output.get("title") or "") if isinstance(output, dict) else ""


def _exhaustion_comment(
    issue_comments: list[dict[str, object]], head: str
) -> dict[str, object] | None:
    matches = [
        comment
        for comment in issue_comments
        if _is_bot(comment) and names_head(_body(comment), head) and USAGE_EXHAUSTED.search(_body(comment))
    ]
    if not matches:
        return None
    return max(matches, key=lambda comment: str(comment.get("updated_at") or comment.get("created_at") or ""))


def _quote(body: str) -> str:
    """Every line of the comment that carries exhaustion wording, tags stripped."""
    lines: list[str] = []
    for raw in body.splitlines():
        if not USAGE_EXHAUSTED.search(raw):
            continue
        text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", raw)).strip(" #>*-\t")
        if text and text not in lines:
            lines.append(text)
    return " — ".join(lines)[:240]


def _append_receipt(receipts_path: Path, record: dict[str, object]) -> None:
    receipts_path.parent.mkdir(parents=True, exist_ok=True)
    with receipts_path.open("a") as handle:
        handle.write(json.dumps(record, separators=(",", ":")) + "\n")


def _close_with_disposition(
    path: Path,
    receipts_path: Path,
    state: dict[str, object],
    cycle: dict[str, object],
    *,
    pr: str,
    disposition: str,
    report_row: str,
    fields: dict[str, object],
) -> dict[str, object]:
    cycle.update(
        {
            "status": "completed",
            "result": "clean",
            "finished_at": now(),
            "disposition": disposition,
            "report_row": report_row,
            **fields,
        }
    )
    write_state(path, state)
    _append_receipt(
        receipts_path,
        {
            "pr": pr,
            "head": cycle.get("head"),
            "cycle_number": cycle.get("number"),
            "kind": cycle.get("kind"),
            "disposition": disposition,
            "report_row": report_row,
            "at": cycle["finished_at"],
            **fields,
        },
    )
    return cycle


def skip_cycle(
    path: Path,
    *,
    head: str,
    pr: str,
    reason: str,
    evidence: dict[str, object],
    receipts_path: Path,
) -> dict[str, object]:
    """Close the open cycle clean under confirmed CodeRabbit usage exhaustion.

    Requires the bot comment naming HEAD with the exhaustion wording and the
    non-success CodeRabbit check run on HEAD; refuses when any substantive
    review of HEAD exists (a review that ran is never skipped).
    """
    if reason not in SKIP_REASONS:
        raise ReviewCycleError(f"invalid skip reason: {reason}")
    state = read_state(path)
    cycle = _open_cycle(state, head)
    reviews = evidence["reviews"]
    assert isinstance(reviews, list)
    substantive = substantive_reviews(reviews, head)
    if substantive:
        summary = ", ".join(
            f"{review.get('id')} ({review_findings(review) if review_findings(review) is not None else 'verdict'})"
            for review in substantive
        )
        raise ReviewCycleError(
            f"a substantive CodeRabbit review exists for {head[:12]} (review {summary}); "
            "close the cycle with finish --result clean/findings, never skip"
        )
    issue_comments = evidence["issue_comments"]
    assert isinstance(issue_comments, list)
    comment = _exhaustion_comment(issue_comments, head)
    if comment is None:
        raise ReviewCycleError(
            f"no CodeRabbit comment names {head[:12]} with 'Review limit reached'/'usage spending cap'; "
            "a rate-limited check or 'Action not completed' alone is not usage exhaustion (deploy.md Step 9a)"
        )
    check_runs = evidence["check_runs"]
    assert isinstance(check_runs, list)
    runs = coderabbit_check_runs(check_runs, head)
    if not runs:
        raise ReviewCycleError(f"no CodeRabbit check run on {head[:12]} recorded the limit")
    check = runs[-1]
    conclusion = str(check.get("conclusion") or check.get("status") or "")
    title = _check_title(check)
    if conclusion == "success" and not re.search(r"rate limited|review limit", title, re.IGNORECASE):
        raise ReviewCycleError(
            f"newest CodeRabbit check run {check.get('id')} on {head[:12]} succeeded ({title!r}); not usage exhaustion"
        )
    quote = _quote(_body(comment))
    wrapper_ids = [review.get("id") for review in coderabbit_reviews(reviews, head)]
    report_row = (
        "Code Review | ⚠️ Skipped | reviewers usage-exhausted (CodeRabbit: "
        f"'{quote}', issue comment {comment.get('id')} updated {comment.get('updated_at')} "
        f"naming commit {head[:9]}; check run {check.get('id')} {conclusion} '{title}'; "
        "Claude fallback disabled)"
    )
    fields: dict[str, object] = {
        "skip_reason": reason,
        "evidence": {
            "source": evidence["source"],
            "captured_at": evidence["captured_at"],
            "issue_comment_id": comment.get("id"),
            "issue_comment_updated_at": comment.get("updated_at"),
            "quote": quote,
            "check_run_id": check.get("id"),
            "check_conclusion": conclusion,
            "check_title": title,
            "non_substantive_review_ids": wrapper_ids,
        },
    }
    return _close_with_disposition(
        path, receipts_path, state, cycle, pr=pr, disposition="skipped", report_row=report_row, fields=fields
    )


def _parse_ids(raw: str) -> list[int]:
    ids: list[int] = []
    for token in re.split(r"[,\s]+", raw.strip()):
        if not token:
            continue
        if not token.isdigit():
            raise ReviewCycleError(f"finding id must be a GitHub review comment id, got {token!r}")
        ids.append(int(token))
    if not ids:
        raise ReviewCycleError("--finding-ids must name at least one review comment id")
    return ids


def override_cycle(
    path: Path,
    *,
    head: str,
    pr: str,
    finding_ids: list[int],
    deferred_to: str,
    evidence: dict[str, object],
    prior_rounds: int,
    receipts_path: Path,
) -> dict[str, object]:
    """Close the open cycle clean after three review rounds, deferring findings.

    Standing user pre-authorization (2026-10-18, reaffirmed 2026-10-27): after
    three review rounds the remaining findings may be deferred. Every listed
    finding must be a CodeRabbit comment on HEAD with a ``[DEFERRED]``/``[FIXED]``
    reply; every other CodeRabbit comment on HEAD must be answered.
    """
    if not deferred_to.strip():
        raise ReviewCycleError("--deferred-to must name the follow-up PR, branch or RCA")
    if prior_rounds < 0:
        raise ReviewCycleError("--prior-rounds must not be negative")
    state = read_state(path)
    cycle = _open_cycle(state, head)
    entries = state["cycles"]
    assert isinstance(entries, list)
    # Only cycles that delivered a review count: an `unavailable` cycle consumed no review budget.
    rounds = len(budget_cycles(entries)) + prior_rounds
    if rounds < MIN_OVERRIDE_ROUNDS:
        raise ReviewCycleError(
            f"override is pre-authorized only after {MIN_OVERRIDE_ROUNDS} review rounds; "
            f"this ledger records {rounds} (add --prior-rounds for earlier deploys of the same PR)"
        )
    reviews = evidence["reviews"]
    assert isinstance(reviews, list)
    substantive = substantive_reviews(reviews, head)
    if not substantive:
        raise ReviewCycleError(
            f"no substantive CodeRabbit review on {head[:12]} to override "
            "(use skip for usage exhaustion; wait for the review otherwise)"
        )
    review = substantive[-1]
    comments = evidence["review_comments"]
    assert isinstance(comments, list)
    on_head = [
        comment
        for comment in comments
        if _is_bot(comment)
        and not comment.get("in_reply_to_id")
        and head in {comment.get("commit_id"), comment.get("original_commit_id")}
    ]
    findings = {int(comment["id"]): comment for comment in on_head if str(comment.get("id", "")).isdigit()}
    replies: dict[int, list[dict[str, object]]] = {}
    for comment in comments:
        parent = comment.get("in_reply_to_id")
        if isinstance(parent, int):
            replies.setdefault(parent, []).append(comment)
    recorded: list[dict[str, object]] = []
    for finding_id in finding_ids:
        if finding_id not in findings:
            raise ReviewCycleError(
                f"finding {finding_id} is not a CodeRabbit review comment on {head[:12]}"
            )
        answered = [reply for reply in replies.get(finding_id, []) if DEFERRED_REPLY.match(_body(reply))]
        if not answered:
            raise ReviewCycleError(
                f"finding {finding_id} has no [DEFERRED]/[FIXED] reply; reply before overriding"
            )
        recorded.append({"id": finding_id, "reply_id": answered[-1].get("id")})
    for other_id in sorted(set(findings) - set(finding_ids)):
        if not any(ANSWERED_REPLY.match(_body(reply)) for reply in replies.get(other_id, [])):
            raise ReviewCycleError(
                f"CodeRabbit comment {other_id} on {head[:12]} is neither listed nor answered "
                "([FIXED]/[IGNORED]/[NOTED]); reply or add it to --finding-ids"
            )
    check_runs = evidence["check_runs"]
    assert isinstance(check_runs, list)
    runs = coderabbit_check_runs(check_runs, head)
    check = runs[-1] if runs else {}
    ids = ", ".join(str(finding_id) for finding_id in finding_ids)
    report_row = (
        f"Code Review | ⚠️ Overridden | CodeRabbit review {review.get('id')} on {head[:9]} "
        f"left finding(s) {ids} deferred to {deferred_to.strip()} (user pre-authorization: "
        f"skip review after {MIN_OVERRIDE_ROUNDS} rounds; rounds={rounds}); ledger result clean"
    )
    fields: dict[str, object] = {
        "finding_ids": list(finding_ids),
        "deferred_to": deferred_to.strip(),
        "rounds": rounds,
        "prior_rounds": prior_rounds,
        "evidence": {
            "source": evidence["source"],
            "captured_at": evidence["captured_at"],
            "review_id": review.get("id"),
            "review_findings": review_findings(review),
            "check_run_id": check.get("id"),
            "check_conclusion": check.get("conclusion"),
            "findings": recorded,
        },
    }
    return _close_with_disposition(
        path, receipts_path, state, cycle, pr=pr, disposition="overridden", report_row=report_row, fields=fields
    )

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, default=default_state_path())
    subparsers = parser.add_subparsers(dest="command", required=True)

    start = subparsers.add_parser("start")
    start.add_argument("--head", required=True)
    start.add_argument("--kind", choices=sorted(KINDS), required=True)
    start.add_argument("--reset", action="store_true")

    finish = subparsers.add_parser("finish")
    finish.add_argument("--head", required=True)
    finish.add_argument("--result", choices=sorted(RESULTS), required=True)

    def add_evidence_arguments(sub: argparse.ArgumentParser) -> None:
        sub.add_argument("--head", required=True)
        sub.add_argument("--pr", required=True, help="pull-request number")
        sub.add_argument("--repo", help="OWNER/REPO, when not inferable by gh")
        sub.add_argument(
            "--evidence-json",
            type=Path,
            help="captured gh payloads {issue_comments, check_runs, reviews, review_comments}; default: fetch via gh",
        )
        sub.add_argument("--receipt", type=Path, help=f"receipt ledger (default: <state dir>/{RECEIPTS_NAME})")

    skip = subparsers.add_parser("skip", help="Step 9a: close clean under confirmed CodeRabbit usage exhaustion")
    add_evidence_arguments(skip)
    skip.add_argument("--reason", choices=sorted(SKIP_REASONS), required=True)

    override = subparsers.add_parser("override", help="standing three-round deferral of remaining findings")
    add_evidence_arguments(override)
    override.add_argument("--finding-ids", required=True, help="comma-separated CodeRabbit review comment ids")
    override.add_argument("--deferred-to", required=True, help="follow-up PR, branch or RCA reference")
    override.add_argument("--prior-rounds", type=int, default=0, help="review rounds from earlier deploys of this PR")

    inherit = subparsers.add_parser("inherit-sync")
    inherit.add_argument("--head", required=True)
    inherit.add_argument("--base", default="origin/main")
    inherit.add_argument("--repo", type=Path, default=Path.cwd())

    merge = subparsers.add_parser("require-mergeable")
    merge.add_argument("--head", required=True)

    subparsers.add_parser("next", help="the cycle the ledger accepts next")
    subparsers.add_parser("status")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.command == "start":
            payload = start_cycle(
                args.state, head=args.head, kind=args.kind, reset=args.reset
            )
        elif args.command == "finish":
            payload = finish_cycle(args.state, head=args.head, result=args.result)
        elif args.command in {"skip", "override"}:
            evidence = load_evidence(args.evidence_json, pr=args.pr, head=args.head, repo=args.repo)
            receipts_path = args.receipt or default_receipts_path(args.state)
            if args.command == "skip":
                payload = skip_cycle(
                    args.state, head=args.head, pr=args.pr, reason=args.reason,
                    evidence=evidence, receipts_path=receipts_path,
                )
            else:
                payload = override_cycle(
                    args.state, head=args.head, pr=args.pr, finding_ids=_parse_ids(args.finding_ids),
                    deferred_to=args.deferred_to, evidence=evidence, prior_rounds=args.prior_rounds,
                    receipts_path=receipts_path,
                )
            print(payload["report_row"])
        elif args.command == "inherit-sync":
            payload = inherit_sync(
                args.state, head=args.head, base=args.base, repo=args.repo
            )
        elif args.command == "require-mergeable":
            payload = require_mergeable(args.state, head=args.head)
        elif args.command == "next":
            entries = read_state(args.state)["cycles"]
            assert isinstance(entries, list)
            payload = next_cycle(entries)
        else:
            payload = read_state(args.state)
    except ReviewCycleError as error:
        raise SystemExit(str(error)) from error
    print(json.dumps(payload, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
