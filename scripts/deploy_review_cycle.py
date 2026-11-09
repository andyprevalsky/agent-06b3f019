#!/usr/bin/env python3
"""Track and enforce bounded /deploy code-review lifecycles.

Cycles are ``initial`` → ``incremental`` → ``verification`` (cap 3). A cycle
closed ``unavailable`` never received a review (its HEAD was superseded
first), so it consumes no review budget: the superseding HEAD re-requests the
same kind (``next`` prints it) and the entry stays in the ledger as history;
``--reset`` is for a new deploy, not for this case.

Two versioned dispositions close an open cycle ``clean`` with evidence and a
``TEST_REPORT`` row (deploy.md Skippable tests: CodeRabbit): ``skip`` for confirmed CodeRabbit
usage exhaustion and ``override`` for the standing three-round deferral. Both
refuse without the evidence and append ``deploy-review-dispositions.jsonl``.

``no-reviewable-paths`` records, instead of a CodeRabbit request, a HEAD whose
changed paths are all excluded by ``.coderabbit.yaml`` ``reviews.path_filters``
(CodeRabbit would review nothing and only spend shared quota). It consumes no
review budget, carries only a clean predecessor and refuses a config change.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path


MAX_REVIEW_CYCLES = 3
KINDS = {"initial", "incremental", "verification"}
RESULTS = {"clean", "findings", "unavailable"}
UNAVAILABLE = "unavailable"
KIND_BY_POSITION = {1: "initial", 2: "incremental", 3: "verification"}
SYNC_KIND = "sync-inherited"
NO_REVIEW_KIND = "no-reviewable-paths"
POST_CAP_KIND = "post-cap-unreviewed"
# Audited entries that carry or need no CodeRabbit review; never part of the cap.
UNCOUNTED_KINDS = frozenset({SYNC_KIND, NO_REVIEW_KIND, POST_CAP_KIND})
CODERABBIT_CONFIG = ".coderabbit.yaml"
# Files regenerated from the merged tree after a main sync. Their content is
# derived, so a sync may change them without new review.
GENERATED_PATHS = frozenset({"docs/rca/INDEX.md"})

REVIEW_BOT = "coderabbitai[bot]"
# CodeRabbit wraps its replies to review-thread comments in empty-body
# COMMENTED reviews on the same HEAD (PR 1656: reviews 5722158877/5722158908
# carried its "The supplied code addresses this finding" replies). Only a body
# with a verdict is a legacy review; native publication bodies instead need
# review-bound findings and a completed check. A review-by-HEAD count is not proof.
SUBSTANTIVE_REVIEW = re.compile(
    r"actionable comments posted|lgtm|no actionable|approved|reviewed", re.IGNORECASE
)
PUBLICATION_REVIEW = re.compile(
    r"<!-- coderabbit-review-publication v1 "
    r"publication=(?P<publication>[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}) "
    r"attempt=(?P<attempt>[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}) batch=1/1 -->"
)
FINDINGS_COUNT = re.compile(r"actionable comments posted:\s*(\d+)", re.IGNORECASE)
# Only these words prove usage exhaustion; "Review rate limited" / "Action not
# completed" alone do not (deploy.md Skippable tests: CodeRabbit).
USAGE_EXHAUSTED = re.compile(r"review limit reached|usage spending cap|spending cap", re.IGNORECASE)
# Native command replies omit the SHA; wording alone never binds them to HEAD.
MODERN_QUOTA = re.compile(
    r"Your included review limit is currently reached under our "
    r"\[Fair Usage Limits Policy\]\(https://docs\.coderabbit\.ai/management/"
    r"rate-limits#fair-usage-limits-policy\)", re.IGNORECASE
)
COMMAND_INVOCATION = re.compile(
    r"<!-- CodeRabbit review command invocation: (v2:[0-9a-f]{64}) -->"
)
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
    """Real review cycles; audited sync inheritances and unreviewable HEADs never count toward the cap."""
    return [
        entry
        for entry in entries
        if isinstance(entry, dict) and entry.get("kind") not in UNCOUNTED_KINDS
    ]


def budget_cycles(entries: list[object]) -> list[dict[str, object]]:
    """Count delivered-review budget without counting evidenced provider exhaustion.

    A quota skip is clean only for merge accounting; skip_cycle has proved
    that no substantive review happened. Keep its immutable entry and evidence,
    but reserve the same review position for a later stabilized HEAD. The
    exact-HEAD duplicate guard and every substantive-review cap still apply.
    """
    return [cycle for cycle in review_cycles(entries)
            if cycle.get("result") != UNAVAILABLE
            and not (cycle.get("result") == "clean"
                     and cycle.get("disposition") == "skipped"
                     and cycle.get("skip_reason") == "usage-cap")]


def next_cycle(entries: list[object]) -> dict[str, object]:
    """The cycle the ledger will accept next (number, kind, replaced HEAD)."""
    cycles = review_cycles(entries)
    if cycles and cycles[-1].get("status") == "open":
        raise ReviewCycleError("the previous review cycle is still open")
    consumed = budget_cycles(entries)
    if len(consumed) >= MAX_REVIEW_CYCLES:
        raise ReviewCycleError(
            f"review cycle cap reached ({MAX_REVIEW_CYCLES}); defer the remaining non-security findings with "
            "`override` and merge, or ask the user how a security or prod-impacting fix is reviewed"
        )
    position = len(consumed) + 1
    replaces = None
    if cycles and cycles[-1].get("result") == UNAVAILABLE:
        replaces = str(cycles[-1].get("head"))
    return {"number": position, "kind": KIND_BY_POSITION[position], "replaces": replaces}


def start_cycle(
    path: Path, *, head: str, kind: str, reset: bool = False,
    verification_approval: str | None = None,
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
    previous = budget_cycles(entries)[-1] if cycle_number == 3 else None
    if verification_approval is not None:
        if (
            cycle_number != 3
            or previous.get("result") != "clean"
            or not verification_approval
            or len(verification_approval) > 128
            or any(not (c.isalnum() or c in "-_.:") for c in verification_approval)
        ):
            raise ReviewCycleError("verification approval needs cycle three after clean cycle two and an approval ID")
    if cycle_number == 3:
        assert previous is not None
        if previous.get("result") != "findings" and verification_approval is None:
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
    if verification_approval is not None:
        cycle["verification_approval"] = verification_approval
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
        raise ReviewCycleError("branch diff differs from the reviewed diff; review the change "
                               f"(after the {MAX_REVIEW_CYCLES}-cycle cap: `{POST_CAP_KIND}`)")
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


def post_cap_unreviewed(path: Path, *, head: str, base: str, repo: Path, reason: str) -> dict[str, object]:
    """Record changes after the three-cycle cap as merged unreviewed, never as reviewed.

    The standing user pre-authorization (2026-10-18, reaffirmed 2026-10-27) allows merging without another
    cycle after three review rounds. A conflicting main sync then changes the branch diff, which
    ``inherit-sync`` rightly refuses, and the ledger refuses a fourth cycle. This entry needs three delivered
    rounds (quota skips never count), the cap reached and a clean final cycle (defer its findings with
    ``override`` first). It names every file changed since the reviewed HEAD.
    """
    if not reason.strip():
        raise ReviewCycleError("--reason must name the user authorization and why review cannot run")
    state = read_state(path)
    entries = state["cycles"]
    assert isinstance(entries, list)
    cycles = review_cycles(entries)
    if not cycles or cycles[-1].get("status") != "completed":
        raise ReviewCycleError("post-cap recording needs a completed review cycle")
    if cycles[-1].get("result") != "clean":
        raise ReviewCycleError(
            f"latest review result is {cycles[-1].get('result')}; defer its findings with `override` first"
        )
    budget = budget_cycles(entries)
    delivered = sum(c.get("disposition") != "skipped" and not c.get("skip_reason") for c in budget)
    if len(budget) < MAX_REVIEW_CYCLES or delivered < MIN_OVERRIDE_ROUNDS:
        raise ReviewCycleError(
            f"the review cap is not reached ({len(budget)} cycles, {delivered} delivered rounds); "
            "request the next review cycle"
        )
    source = resolve(repo, str(entries[-1].get("head")))
    head = resolve(repo, head)
    if head == source:
        raise ReviewCycleError("HEAD is already recorded")
    if not is_ancestor(repo, source, head):
        raise ReviewCycleError("recorded HEAD is not an ancestor of HEAD")
    base_sha = resolve(repo, base)
    entry = {
        "number": len(entries) + 1,
        "kind": POST_CAP_KIND,
        "head": head,
        "status": "completed",
        "result": "clean",
        "disposition": "unreviewed",
        "inherited_from": source,
        "base": base_sha,
        "reviewed_branch_diff_sha256": hashlib.sha256(branch_diff(repo, source, base_sha).encode()).hexdigest(),
        "branch_diff_sha256": hashlib.sha256(branch_diff(repo, head, base_sha).encode()).hexdigest(),
        "changed_files": sorted(changed_files(repo, source, head)),
        "reason": reason,
        "started_at": now(),
        "finished_at": now(),
    }
    entry["report_row"] = (
        f"Code Review | \u26a0\ufe0f Overridden | merged unreviewed after the {MAX_REVIEW_CYCLES}-cycle cap: "
        f"{len(entry['changed_files'])} file(s) changed since {source[:9]} ({reason})"
    )
    entries.append(entry)
    write_state(path, state)
    return entry


# ---------------------------------------------------------------------------
# CodeRabbit path filters: HEADs with nothing CodeRabbit would review
# ---------------------------------------------------------------------------


def _glob_segment(segment: str) -> str:
    """One path segment of a minimatch glob (``*``, ``?``, ``!(a|b)``) as a regex; dotfiles stay unmatched."""
    out = ""
    index = 0
    while index < len(segment):
        char = segment[index]
        if segment.startswith("!(", index):
            close = segment.find(")", index)
            if close < 0:
                raise ReviewCycleError(f"unsupported CodeRabbit path filter segment: {segment!r}")
            alternatives = "|".join(_glob_segment(alt) for alt in segment[index + 2:close].split("|"))
            rest = _glob_segment(segment[close + 1:])
            # The excluded values end at this segment's boundary (a "/" or the path's end), not the path's end.
            return out + f"(?:(?!(?:{alternatives}){rest}(?![^/]))[^/]*?){rest}"
        if char == "*":
            out += "[^/]*"
        elif char == "?":
            out += "[^/]"
        elif char in "[]{}()+@":
            raise ReviewCycleError(f"unsupported CodeRabbit path filter segment: {segment!r}")
        else:
            out += re.escape(char)
        index += 1
    return out


def glob_regex(pattern: str) -> re.Pattern[str]:
    """Compile a CodeRabbit (minimatch, no dot, no matchBase) path glob.

    Unsupported syntax raises, so the caller requests the review instead of
    guessing; matching is deliberately no broader than minimatch's defaults.
    """
    segments = pattern.split("/")
    if not pattern or any(not segment for segment in segments):
        raise ReviewCycleError(f"unsupported CodeRabbit path filter: {pattern!r}")
    parts: list[str] = []
    for position, segment in enumerate(segments):
        last = position == len(segments) - 1
        if segment == "**":
            parts.append(r"(?!\.)[^/]+(?:/(?!\.)[^/]+)*" if last else r"(?:(?!\.)[^/]+/)*")
            continue
        guard = r"(?!\.)" if segment[0] in "*?!" else ""
        parts.append(guard + _glob_segment(segment) + ("" if last else "/"))
    return re.compile("^" + "".join(parts) + "$")


def path_filters(repo: Path, head: str) -> tuple[list[re.Pattern[str]], list[re.Pattern[str]], str]:
    """(include, exclude, sha256) of ``reviews.path_filters`` in HEAD's committed ``.coderabbit.yaml``."""
    import yaml

    text = git(repo, "show", f"{head}:{CODERABBIT_CONFIG}")
    try:
        config = yaml.safe_load(text)
    except yaml.YAMLError as error:
        raise ReviewCycleError(f"could not parse {CODERABBIT_CONFIG}: {error}") from error
    reviews = config.get("reviews") if isinstance(config, dict) else None
    filters = reviews.get("path_filters") if isinstance(reviews, dict) else None
    if not isinstance(filters, list) or not filters or not all(isinstance(item, str) for item in filters):
        raise ReviewCycleError(f"{CODERABBIT_CONFIG} has no reviews.path_filters list")
    include = [glob_regex(item) for item in filters if not item.startswith("!")]
    exclude = [glob_regex(item[1:]) for item in filters if item.startswith("!")]
    digest = hashlib.sha256(json.dumps(filters).encode()).hexdigest()
    return include, exclude, digest


def is_reviewable(path: str, include: list[re.Pattern[str]], exclude: list[re.Pattern[str]]) -> bool:
    """CodeRabbit's case sensitivity for custom (extglob) filters is unverified, so either reading that reviews wins."""
    def reviewable(flags: int) -> bool:
        def hit(pattern: re.Pattern[str]) -> bool:
            return re.match(pattern.pattern, path, flags) is not None
        included = not include or any(hit(pattern) for pattern in include)
        return included and not any(hit(pattern) for pattern in exclude)
    return reviewable(0) or reviewable(re.IGNORECASE)


def record_no_reviewable_paths(
    path: Path, *, head: str, repo: Path, receipts_path: Path, base: str | None = None,
    reset: bool = False, pr: str = "",
) -> dict[str, object]:
    """Record a HEAD whose every changed path CodeRabbit's path filters exclude.

    ``reset`` (a new deploy's first cycle) compares the branch with
    merge-base(HEAD, base). Otherwise HEAD must descend from the latest
    completed clean entry, which it carries; findings, an open cycle, a
    ``.coderabbit.yaml`` change or any reviewable path refuse, and the caller
    requests the normal review.
    """
    head = resolve(repo, head)
    prior: dict[str, object] | None = None
    if reset:
        if not base:
            raise ReviewCycleError("a new deploy's first HEAD needs --base")
        state: dict[str, object] = {"schema_version": 1, "cycles": []}
        source = git(repo, "merge-base", head, resolve(repo, base)).strip()
    else:
        state = read_state(path)
        entries = state["cycles"]
        assert isinstance(entries, list)
        cycles = review_cycles(entries)
        if cycles and cycles[-1].get("status") == "open":
            raise ReviewCycleError("the previous review cycle is still open")
        completed = [entry for entry in entries if isinstance(entry, dict)
                     and entry.get("status") == "completed" and entry.get("result") != UNAVAILABLE]
        if not completed:
            raise ReviewCycleError("no completed review to carry; request the review")
        prior = completed[-1]
        if prior.get("result") != "clean":
            raise ReviewCycleError(
                f"latest review result is {prior.get('result')}; its findings need a review cycle"
            )
        source = resolve(repo, str(prior.get("head")))
        if head == source:
            raise ReviewCycleError("HEAD is already the latest recorded HEAD")
        if not is_ancestor(repo, source, head):
            raise ReviewCycleError("the recorded HEAD is not an ancestor of HEAD; request the review")
    changed = sorted(
        line for line in git(repo, "diff", "--name-only", "--no-renames", source, head).splitlines() if line
    )
    if CODERABBIT_CONFIG in changed:
        raise ReviewCycleError(f"{CODERABBIT_CONFIG} changed; request the review")
    include, exclude, digest = path_filters(repo, head)
    reviewable = [name for name in changed if is_reviewable(name, include, exclude)]
    if reviewable:
        shown = ", ".join(reviewable[:10]) + (" …" if len(reviewable) > 10 else "")
        raise ReviewCycleError(f"{len(reviewable)} reviewable path(s): {shown}; request the review")
    report_row = (
        f"Code Review | ➖ No reviewable paths | {len(changed)} changed path(s) since {source[:9]} on "
        f"{head[:9]} are all excluded by {CODERABBIT_CONFIG} path_filters; no CodeRabbit request spent"
    )
    if prior is not None:
        carried = prior.get("disposition") or prior.get("kind")
        report_row += f"; carries the {carried} clean result of {str(prior.get('head'))[:9]}"
    entries = state["cycles"]
    assert isinstance(entries, list)
    entry: dict[str, object] = {
        "number": len(entries) + 1,
        "kind": NO_REVIEW_KIND,
        "head": head,
        "status": "completed",
        "result": "clean",
        "disposition": NO_REVIEW_KIND,
        "compared_from": source,
        "inherited_from": prior.get("head") if prior else None,
        "changed_paths": changed,
        "path_filters_sha256": digest,
        "report_row": report_row,
        "started_at": now(),
        "finished_at": now(),
    }
    entries.append(entry)
    write_state(path, state)
    _append_receipt(receipts_path, {
        "pr": pr, "head": head, "cycle_number": entry["number"], "kind": NO_REVIEW_KIND,
        "disposition": NO_REVIEW_KIND, "report_row": report_row, "at": entry["finished_at"],
        "compared_from": source, "changed_paths": changed,
    })
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
# Quota-skip and override dispositions: evidence-bound ``skip`` and ``override``
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
    """Read a complete endpoint inventory or reject pagination truncation."""
    items: list[object] = []
    for page in range(1, GH_MAX_PAGES + 1):
        payload = _gh_json(["api", f"{endpoint}?per_page={GH_PAGE_SIZE}&page={page}"])
        if not isinstance(payload, list):
            raise ReviewCycleError(f"{endpoint} returned a non-list payload")
        items.extend(payload)
        if len(payload) < GH_PAGE_SIZE:
            return items
    raise ReviewCycleError(f"{endpoint} pagination exceeded the existing page bound")


def _gh_check_runs(slug: str, head: str) -> list[object]:
    """Preserve prior attempts; never accept a silently truncated check inventory."""
    runs: list[object] = []
    for page in range(1, GH_MAX_PAGES + 1):
        payload = _gh_json(["api", f"repos/{slug}/commits/{head}/check-runs"
                            f"?filter=all&per_page={GH_PAGE_SIZE}&page={page}"])
        batch = payload.get("check_runs") if isinstance(payload, dict) else None
        if not isinstance(batch, list):
            raise ReviewCycleError("check-runs returned an unexpected payload")
        runs.extend(batch)
        if len(batch) < GH_PAGE_SIZE:
            return runs
    raise ReviewCycleError("check-runs pagination exceeded the existing page bound")


def fetch_evidence(*, pr: str, head: str, repo: str | None) -> dict[str, object]:
    """Capture the three CodeRabbit endpoints plus the check runs for HEAD via gh."""
    slug = repo
    if not slug:
        payload = _gh_json(["repo", "view", "--json", "nameWithOwner"])
        slug = str(payload.get("nameWithOwner") or "") if isinstance(payload, dict) else ""
        if not slug:
            raise ReviewCycleError("could not resolve OWNER/REPO; pass --repo")
    check_runs = _gh_check_runs(slug, head)
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


def _publication_time(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def publication_evidence(
    review: dict[str, object], head: str, evidence: dict[str, object]
) -> dict[str, object] | None:
    """A native publication needs its own finding and a finished exact-HEAD check."""
    markers = list(PUBLICATION_REVIEW.finditer(_body(review)))
    review_id = review.get("id")
    if (len(markers) != 1 or type(review_id) is not int or review_id <= 0
            or not _is_bot(review) or review.get("commit_id") != head
            or review.get("state") not in {"COMMENTED", "APPROVED", "CHANGES_REQUESTED"}):
        return None
    comments, check_runs = evidence["review_comments"], evidence["check_runs"]
    assert isinstance(comments, list) and isinstance(check_runs, list)
    findings = [comment for comment in comments
                if _is_bot(comment) and comment.get("in_reply_to_id") is None
                and comment.get("pull_request_review_id") == review_id
                and comment.get("original_commit_id", comment.get("commit_id")) == head
                and type(comment.get("id")) is int and comment["id"] > 0
                and _body(comment).strip()]
    published = _publication_time(review.get("submitted_at"))
    check = None
    # Later usage-exhausted attempts cannot erase an already completed publication.
    # The marker UUID is not a native check-run ID; bind its submission to the run interval.
    for run in reversed(coderabbit_check_runs(check_runs, head)):
        started, completed = (_publication_time(run.get(key)) for key in ("started_at", "completed_at"))
        if (run.get("head_sha") == head and run.get("status") == "completed"
                and run.get("conclusion") == "success" and _check_title(run) == "Finished"
                and published is not None and started is not None and completed is not None
                and started <= published <= completed):
            check = run
            break
    if not findings or check is None:
        return None
    return {
        "recognition": "publication-with-review-bound-findings",
        **markers[0].groupdict(), "batch": "1/1",
        "inline_finding_ids": sorted({comment["id"] for comment in findings}),
        "check_run_id": check.get("id"),
        "review_body_sha256": hashlib.sha256(_body(review).encode()).hexdigest(),
    }


def substantive_reviews(
    reviews: list[dict[str, object]], head: str, evidence: dict[str, object] | None = None
) -> list[dict[str, object]]:
    """Verdict bodies or evidenced native publications; reply wrappers are not reviews."""
    return [review for review in coderabbit_reviews(reviews, head)
            if SUBSTANTIVE_REVIEW.search(_body(review))
            or (evidence is not None and publication_evidence(review, head, evidence))]


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




def _review_source_links(body: str) -> tuple[set[tuple[str, str]], set[tuple[str, str]]]:
    """Explicit GitHub commit/configuration targets; never scan opaque hashes."""
    commits = set(re.findall(
        r'https://github\.com/([\w.-]+/[\w.-]+)/commit/([^/\s<>?#)]+)',
        body, re.IGNORECASE))
    configurations = set(re.findall(
        r'https://github\.com/([\w.-]+/[\w.-]+)/blob/([^/\s<>]+)/\.coderabbit\.yaml',
        body, re.IGNORECASE))
    return commits, configurations


def _contradicts_review_head(body: str, head: str, repository: str) -> bool:
    """Detect conflicting labelled source references while leaving opaque tokens alone."""
    # Only labelled references and native links assert commit identity. The v2
    # invocation and unrelated identifiers stay opaque, including 40-hex tokens.
    plain = re.sub(r'[*`]', '', body)
    references = re.findall(
        r'\b(?:commit|head)\b(?:\s+(?:sha|id))?\s*[:=]?\s*\[?([0-9a-f]{7,40})(?![0-9a-f])',
        plain, re.IGNORECASE)
    commits, configurations = _review_source_links(body)
    return (any(not head.lower().startswith(value.lower()) for value in references)
            or any(repo.lower() != repository.lower()
                   or re.fullmatch(r'[0-9a-f]{7,40}', value, re.IGNORECASE) is None
                   or not head.lower().startswith(value.lower())
                   for repo, value in commits | configurations))


def _modern_exhaustion_binding(
    evidence: dict[str, object], cycle: dict[str, object], head: str, pr: str,
) -> tuple[dict[str, object], dict[str, object]] | None:
    """Bind a SHA-less native quota reply, never a path-filter status by itself.

    The invocation hash is opaque: do not invent a mapping to the request.
    Instead require a unique unedited member command, a bot configuration
    updated during its reply, the exact-HEAD check and a fresh authenticated PR
    read. Ambiguous or incomplete captures fail closed.
    """
    comments = evidence['issue_comments']
    runs = evidence['check_runs']
    assert isinstance(comments, list) and isinstance(runs, list)
    started = _publication_time(cycle.get('started_at'))
    captured = _publication_time(evidence.get('captured_at'))
    current = _publication_time(now())
    if started is None or captured is None or current is None or not started <= captured <= current:
        return None

    def official(comment: dict[str, object]) -> bool:
        """Require the native CodeRabbit bot and application identities."""
        app, user = comment.get('performed_via_github_app'), comment.get('user')
        return (_is_bot(comment) and isinstance(user, dict) and user.get('type') == 'Bot'
                and isinstance(app, dict) and app.get('slug') == 'coderabbitai')

    candidates = [c for c in comments if official(c) and MODERN_QUOTA.search(_body(c))
                  and (stamp := _publication_time(c.get('created_at'))) is not None
                  and started <= stamp <= captured]
    if len(candidates) != 1:
        return None
    reply = candidates[0]
    issue = re.fullmatch(r'https://api\.github\.com/repos/([\w.-]+/[\w.-]+)/issues/([0-9]+)',
                         str(reply.get('issue_url') or ''))
    invocations = COMMAND_INVOCATION.findall(_body(reply))
    if issue is None or issue[2] != pr or len(invocations) != 1:
        return None
    invocation = invocations[0]
    if sum(_body(c).count(invocation) for c in comments) != 1:
        return None
    # A different explicit commit in the reply cannot be rebound by a snapshot.
    if _contradicts_review_head(_body(reply), head, issue[1]):
        return None
    created, updated = (_publication_time(reply.get(key)) for key in ('created_at', 'updated_at'))
    allowance = re.search(r'Your next included review will be available in ([1-9][0-9]*) minutes\.',
                          _body(reply))
    if (created is None or updated is None or allowance is None
            or not started <= created <= updated <= captured):
        return None
    # Do not reuse a denial after the bot's own included-review reset.
    try:
        expires = created + timedelta(minutes=int(allowance[1]))
    except (ValueError, OverflowError):
        return None
    if current >= expires:
        return None
    requests = [c for c in comments if c.get('issue_url') == reply.get('issue_url')
                and re.fullmatch(r'\s*@coderabbitai (?:full )?review\s*', _body(c), re.IGNORECASE)
                and (when := _publication_time(c.get('created_at'))) is not None
                and started <= when <= captured]
    if len(requests) != 1:
        return None
    request = requests[0]
    requested = _publication_time(request.get('created_at'))
    if (request.get('created_at') != request.get('updated_at')
            or request.get('author_association') not in {'OWNER', 'MEMBER', 'COLLABORATOR'}
            or requested is None or requested > created):
        return None
    slug = issue[1]
    snapshots = [c for c in comments if official(c)
                 and '<!-- This is an auto-generated comment: skip review by coderabbit.ai -->' in _body(c)
                 and 'Run configuration' in _body(c)
                 and c.get('issue_url') == reply.get('issue_url')
                 and _review_source_links(_body(c)) == ({(slug, head)}, {(slug, head)})
                 and not _contradicts_review_head(_body(c), head, slug)
                 and (stamp := _publication_time(c.get('updated_at'))) is not None
                 and created <= stamp <= updated]
    checks = coderabbit_check_runs(runs, head)
    if len(snapshots) != 1 or not checks:
        return None
    identities = [c.get('id') for c in (reply, request, snapshots[0])]
    if any(type(value) is not int or value <= 0 for value in identities) or len(set(identities)) != 3:
        return None
    check = checks[-1]
    completed = _publication_time(check.get('completed_at'))
    app = check.get('app')
    if (check.get('head_sha') != head or check.get('status') != 'completed'
            or check.get('conclusion') not in {'skipped', 'neutral', 'failure', 'cancelled', 'timed_out', 'action_required'}
            or not isinstance(app, dict) or app.get('slug') != 'coderabbitai'
            or completed is None or not started <= completed <= captured):
        return None
    live = _gh_json(['api', f'repos/{slug}/pulls/{pr}'])
    live_head = live.get('head') if isinstance(live, dict) else None
    live_base = live.get('base') if isinstance(live, dict) else None
    live_repo = live_base.get('repo') if isinstance(live_base, dict) else None
    if (not isinstance(live, dict) or live.get('number') != int(pr) or live.get('state') != 'open'
            or not isinstance(live_head, dict) or live_head.get('sha') != head
            or not isinstance(live_repo, dict) or live_repo.get('full_name') != slug):
        raise ReviewCycleError('modern quota reply does not match the authenticated current PR head')
    if (verified := _publication_time(now())) is None or verified >= expires:
        raise ReviewCycleError('modern quota reply expired during current PR verification')
    return reply, {
        'method': 'current-pr-command-config', 'current_pr_head': head,
        'pr': int(pr), 'repository': slug, 'verified_at': now(),
        'request_comment_id': request.get('id'), 'request_created_at': request.get('created_at'),
        'configuration_comment_id': snapshots[0].get('id'),
        'configuration_updated_at': snapshots[0].get('updated_at'),
        'invocation': invocation, 'quota_expires_at': expires.isoformat(),
        'reply_body_sha256': hashlib.sha256(_body(reply).encode()).hexdigest(),
        'configuration_body_sha256': hashlib.sha256(_body(snapshots[0]).encode()).hexdigest(),
    }


def _quote(body: str) -> str:
    """Every line of the comment that carries exhaustion wording, tags stripped."""
    lines: list[str] = []
    for raw in body.splitlines():
        if not (USAGE_EXHAUSTED.search(raw) or MODERN_QUOTA.search(raw)):
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

    Requires a bot quota comment naming HEAD, or a native command reply bound
    to the current PR, cycle and configuration; also requires the non-success
    exact-HEAD check. A substantive review of HEAD always refuses the skip.
    """
    if reason not in SKIP_REASONS:
        raise ReviewCycleError(f"invalid skip reason: {reason}")
    state = read_state(path)
    cycle = _open_cycle(state, head)
    reviews = evidence["reviews"]
    assert isinstance(reviews, list)
    substantive = substantive_reviews(reviews, head, evidence)
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
    binding = None
    if comment is None:
        modern = _modern_exhaustion_binding(evidence, cycle, head, pr)
        if modern is not None:
            comment, binding = modern
    if comment is None:
        raise ReviewCycleError(
            f"no CodeRabbit comment names {head[:12]} with 'Review limit reached'/'usage spending cap'; "
            "a rate-limited check or 'Action not completed' alone is not usage exhaustion (deploy.md Skippable tests: CodeRabbit)"
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
    head_proof = (f"bound to current PR {pr} commit {head[:9]} by request "
                  f"{binding['request_comment_id']} and configuration {binding['configuration_comment_id']}"
                  if binding else f"naming commit {head[:9]}")
    report_row = (
        "Code Review | ⚠️ Skipped | reviewers usage-exhausted (CodeRabbit: "
        f"'{quote}', issue comment {comment.get('id')} updated {comment.get('updated_at')} "
        f"{head_proof}; check run {check.get('id')} {conclusion} '{title}'; "
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
    if binding is not None:
        fields['evidence']['head_binding'] = binding
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
    rounds = sum(
        cycle.get("disposition") != "skipped" and not cycle.get("skip_reason")
        for cycle in budget_cycles(entries)
    ) + prior_rounds
    if rounds < MIN_OVERRIDE_ROUNDS:
        raise ReviewCycleError(
            f"override is pre-authorized only after {MIN_OVERRIDE_ROUNDS} review rounds; "
            f"this ledger records {rounds} (add --prior-rounds for earlier deploys of the same PR)"
        )
    reviews = evidence["reviews"]
    assert isinstance(reviews, list)
    substantive = substantive_reviews(reviews, head, evidence)
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
    publication = publication_evidence(review, head, evidence)
    if publication is not None and not SUBSTANTIVE_REVIEW.search(_body(review)):
        fields["evidence"]["review_publication"] = publication
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
    start.add_argument("--verification-approval", help="Explicit user approval ID for final verification after a clean second cycle")

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

    skip = subparsers.add_parser("skip", help="close clean under confirmed CodeRabbit usage exhaustion")
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

    post_cap = subparsers.add_parser(
        POST_CAP_KIND, help="after the 3-cycle cap, record later changes (e.g. a conflicting main sync) as merged unreviewed"
    )
    post_cap.add_argument("--head", required=True)
    post_cap.add_argument("--base", default="origin/main")
    post_cap.add_argument("--repo", type=Path, default=Path.cwd())
    post_cap.add_argument("--reason", required=True, help="the user authorization and why review cannot run")

    unreviewable = subparsers.add_parser(
        NO_REVIEW_KIND, help="record a HEAD whose changed paths CodeRabbit's path filters all exclude"
    )
    unreviewable.add_argument("--head", required=True)
    unreviewable.add_argument("--base", help="with --reset: compare the branch from merge-base(HEAD, BASE)")
    unreviewable.add_argument("--reset", action="store_true", help="a new deploy's first HEAD")
    unreviewable.add_argument("--pr", default="", help="pull-request number for the receipt")
    unreviewable.add_argument("--repo", type=Path, default=Path.cwd())
    unreviewable.add_argument("--receipt", type=Path, help=f"receipt ledger (default: <state dir>/{RECEIPTS_NAME})")

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
                args.state, head=args.head, kind=args.kind, reset=args.reset,
                verification_approval=args.verification_approval,
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
        elif args.command == POST_CAP_KIND:
            payload = post_cap_unreviewed(
                args.state, head=args.head, base=args.base, repo=args.repo, reason=args.reason
            )
            print(payload["report_row"])
        elif args.command == NO_REVIEW_KIND:
            payload = record_no_reviewable_paths(
                args.state, head=args.head, repo=args.repo, base=args.base, reset=args.reset, pr=args.pr,
                receipts_path=args.receipt or default_receipts_path(args.state),
            )
            print(payload["report_row"])
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
