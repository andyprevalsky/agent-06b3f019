"""Force browser completion once the visible goal result is already stated.

`browser-biometrics-webdecoy` (agent c3762be3) already read FCaptcha risk
score 0.07 and "Bot detected - form blocked" / pow_not_satisfied, then spent
the remaining 420s cap on 5–10s waits and extra submits. The task asks to
return that visible score and verdict, not to keep retrying proof-of-work.

A later smoke failure (agent b234cfa8) stated Risk Score 0.11 + the same bot
verdict, then burned the 420s cap on scroll/screenshot loops instead of wait.
Rewrite post-submit idle actions (`wait`, `scroll`, `read_browser_state`, …)
into `attempt_completion` so the parent can finish instead of burning the
harness timeout.

Page-changing actions after the last submit invalidate prior visible-result
evidence — a scroll on a later page must not complete against a stale score.
"""

from __future__ import annotations

import json
import re
from typing import Any, Iterable

_RISK_SCORE_RE = re.compile(r"\brisk\s+score\b", re.IGNORECASE)
_FCAPTCHA_SCORE_RE = re.compile(r"\bfcaptcha\b.*\bscore\b|\bscore\b.*\bfcaptcha\b", re.IGNORECASE)
_NUMERIC_SCORE_RE = re.compile(r"\b\d+\.\d+\b")
_VERDICT_MARKERS = (
    "bot detected",
    "form blocked",
    "pow_not_satisfied",
    "human detected",
    "verified!",
)
# Idle / exploratory actions that cannot change a result already on the page.
# Do NOT include click/type/submit — those may still be required before the
# first submit, and the submit-history gate already blocks pre-submit rewrites.
_POST_RESULT_IDLE_ACTIONS = frozenset(
    {
        "wait",
        "scroll",
        "scroll_to",
        "scroll_until",
        "scroll_down",
        "scroll_up",
        "page_up",
        "page_down",
        "screenshot",
        "read_browser_state",
        "noop",
        "sleep",
        "move",
        "hover",
    }
)
# Actions that leave the page where the score/verdict was observed.
_NAVIGATION_MARKERS = (
    "navigate",
    "goto",
    "go_to",
    "open_url",
    "open_page",
    "go_back",
    "go_forward",
    "new_tab",
    "switch_tab",
    "close_tab",
)


def reasoning_states_visible_fcaptcha_result(text: str) -> bool:
    """True when the agent already reported the visible score or verdict.

    Agent 6ba2a6bd stated a numeric risk score after Submit but never named a
    verdict marker, then scrolled/waited out the 420s cap. A numeric score is
    enough: the task asks to return that visible number.
    """
    blob = str(text or "")
    if not blob.strip():
        return False
    has_score = bool(_RISK_SCORE_RE.search(blob) or _FCAPTCHA_SCORE_RE.search(blob))
    if not has_score:
        return False
    lowered = blob.lower()
    has_verdict = any(marker in lowered for marker in _VERDICT_MARKERS)
    has_numeric = bool(_NUMERIC_SCORE_RE.search(blob))
    return has_verdict or has_numeric


def _entry_blob(entry: Any) -> str:
    if isinstance(entry, str):
        return entry
    try:
        return json.dumps(entry, default=str)
    except TypeError:
        return str(entry)


def _history_entries(
    action_summaries: Iterable[Any] | None = None,
    action_entries: Iterable[Any] | None = None,
) -> list[str]:
    # Prefer structured action_entries when present — they are the chronological
    # source of truth. Concatenating summaries+entries doubles the timeline and
    # breaks submit/navigation index comparisons (CodeRabbit).
    source = list(action_entries or []) or list(action_summaries or [])
    return [_entry_blob(entry).lower() for entry in source]


def history_has_submit_click(
    action_summaries: Iterable[Any] | None = None,
    action_entries: Iterable[Any] | None = None,
) -> bool:
    """True when a prior click already targeted a Submit control."""
    return any("submit" in blob and "click" in blob for blob in _history_entries(action_summaries, action_entries))


def _last_submit_index(entries: list[str]) -> int:
    return max(
        (idx for idx, blob in enumerate(entries) if "submit" in blob and "click" in blob),
        default=-1,
    )


def _last_navigation_index(entries: list[str]) -> int:
    return max(
        (
            idx
            for idx, blob in enumerate(entries)
            if any(marker in blob for marker in _NAVIGATION_MARKERS)
        ),
        default=-1,
    )


def history_has_navigation_after_submit(
    action_summaries: Iterable[Any] | None = None,
    action_entries: Iterable[Any] | None = None,
) -> bool:
    """True when a page-changing action follows the latest submit click."""
    entries = _history_entries(action_summaries, action_entries)
    last_submit_idx = _last_submit_index(entries)
    if last_submit_idx < 0:
        return False
    return _last_navigation_index(entries) > last_submit_idx


def history_has_navigation_before_latest_submit(
    action_summaries: Iterable[Any] | None = None,
    action_entries: Iterable[Any] | None = None,
) -> bool:
    """True when a page change precedes the latest submit.

    submit(A) → reason(score A) → navigate(B) → submit(B) leaves score-A text
    in prior reasoning while the latest submit has no following navigation.
    Callers must not treat that pre-navigation evidence as belonging to page B.
    """
    entries = _history_entries(action_summaries, action_entries)
    last_submit_idx = _last_submit_index(entries)
    if last_submit_idx < 0:
        return False
    last_nav_idx = _last_navigation_index(entries)
    return 0 <= last_nav_idx < last_submit_idx


def should_force_visible_result_completion(
    *,
    action_name: str,
    last_reasoning: str,
    prior_reasoning_messages: Iterable[str] | None = None,
    action_summaries: Iterable[Any] | None = None,
    action_entries: Iterable[Any] | None = None,
) -> bool:
    """Rewrite idle post-submit actions once the visible result is stated."""
    if str(action_name or "").strip().lower() not in _POST_RESULT_IDLE_ACTIONS:
        return False
    # Materialize once so generator/iterator callers are not consumed by the
    # submit check and then appear empty to the navigation guard (CodeRabbit).
    summaries = list(action_summaries or [])
    entries = list(action_entries or [])
    if not history_has_submit_click(summaries, entries):
        return False
    if history_has_navigation_after_submit(summaries, entries):
        return False
    # After navigate→submit, prior reasoning may still describe the old page.
    # Only the current turn's reasoning is trustworthy for the new page.
    if history_has_navigation_before_latest_submit(summaries, entries):
        candidates = [last_reasoning]
    else:
        candidates = [last_reasoning, *(prior_reasoning_messages or [])]
    return any(reasoning_states_visible_fcaptcha_result(text) for text in candidates)


def forced_visible_result_completion_action(thinking: str) -> dict[str, Any]:
    """Build the attempt_completion action that replaces a post-result wait."""
    reasoning = str(thinking or "").strip() or (
        "Visible FCaptcha score and verdict are already on the page; reporting them now."
    )
    return {
        "action": "attempt_completion",
        "thinking": thinking or reasoning,
        "params": {"reasoning": reasoning},
    }
