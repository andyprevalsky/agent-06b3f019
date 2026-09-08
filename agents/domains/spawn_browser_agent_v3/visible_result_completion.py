"""Force browser completion once the visible goal result is already stated.

`browser-biometrics-webdecoy` (agent c3762be3) already read FCaptcha risk
score 0.07 and "Bot detected - form blocked" / pow_not_satisfied, then spent
the remaining 420s cap on 5–10s waits and extra submits. The task asks to
return that visible score and verdict, not to keep retrying proof-of-work.

A later smoke failure (agent b234cfa8) stated Risk Score 0.11 + the same bot
verdict, then burned the 420s cap on scroll/screenshot loops instead of wait.
Agent 15a85ea0 then showed the same visible 0.15 / "Bot detected" result in
an evaluate tool result, but reasoning only named pow_not_satisfied and kept
waiting / inspecting PoW. Scan post-submit action-entry blobs, not just LLM
reasoning, and treat network/log inspection as idle once that result exists.

Rewrite post-submit idle actions (`wait`, `scroll`, `read_browser_state`,
`read_network_requests`, …) into `attempt_completion` so the parent can
finish instead of burning the harness timeout.

Page-changing actions after the last submit invalidate prior visible-result
evidence — a scroll on a later page must not complete against a stale score.
"""

from __future__ import annotations

import json
import re
from typing import Any, Iterable

_RISK_SCORE_RE = re.compile(r"\brisk\s+score\b", re.IGNORECASE)
_FCAPTCHA_SCORE_RE = re.compile(r"\bfcaptcha\b.*\bscore\b|\bscore\b.*\bfcaptcha\b", re.IGNORECASE)
# FCaptcha risk scores are unit-interval (0.07, 0.15) plus labeled bounds 0/1/1.0.
# Reject version fragments: v1.34.1 (`34.1`) and v1.0.15 (`0.15` after a dot).
_UNIT_INTERVAL_SCORE_RE = re.compile(r"(?<![\d.])\b0\.\d+\b(?!\.\d+)")
_LABELED_BOUND_SCORE_RE = re.compile(
    r"\brisk\s+score\b.{0,40}(?<![\d.])\b(?:0(?:\.\d+)?|1(?:\.0+)?)\b(?!\.\d+)"
    r"|(?<![\d.])\b(?:0(?:\.\d+)?|1(?:\.0+)?)\b(?!\.\d+).{0,40}\brisk\s+score\b",
    re.IGNORECASE | re.DOTALL,
)
_JSON_SCORE_RE = re.compile(
    r"""['"]score['"]\s*:\s*(?:0(?:\.\d+)?|1(?:\.0+)?)\b(?!\.\d+)""",
    re.IGNORECASE,
)


def _normalize_history_blob(blob: str) -> str:
    """Undo json.dumps escaping so labels/newlines remain grep-able."""
    return blob.replace("\\n", "\n").replace("\\t", "\t").replace('\\"', '"')


def _blob_has_fcaptcha_score_value(blob: str) -> bool:
    """True when a numeric FCaptcha score is labeled or structured.

    A bare `0.15` next to `Bot detected` is not enough — `threshold 0.15`
    and `v1.0.15` must not force completion (CodeRabbit). History blobs are
    json.dumps of action entries, so unescape before matching labels.
    """
    text = _normalize_history_blob(blob)
    if _JSON_SCORE_RE.search(text):
        return True
    if _LABELED_BOUND_SCORE_RE.search(text):
        return True
    has_label = bool(_RISK_SCORE_RE.search(text) or _FCAPTCHA_SCORE_RE.search(text))
    return has_label and bool(_UNIT_INTERVAL_SCORE_RE.search(text))


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
        "read_network_requests",
        "read_logs",
        "noop",
        "sleep",
        "move",
        "hover",
    }
)
# Form-submit verdicts (not checkbox "Verified!") — used when the score lives
# in a tool result rather than the model's reasoning.
_FORM_RESULT_VERDICTS = (
    "bot detected",
    "form blocked",
    "pow_not_satisfied",
    "human detected",
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
    return _blob_has_fcaptcha_score_value(blob)


def observation_states_visible_fcaptcha_result(text: str) -> bool:
    """True when a post-submit tool result already shows the form verdict.

    Evaluate/read results dump the whole page, so a static "Risk Score" label
    plus a version number (v1.34.1) must not count. Require an explicit
    form-result verdict plus an actual unit-interval / JSON score value —
    not any decimal (CodeRabbit: Bot detected + v1.34.1 must not complete).
    """
    blob = str(text or "")
    if not blob.strip():
        return False
    lowered = blob.lower()
    if not any(marker in lowered for marker in _FORM_RESULT_VERDICTS):
        return False
    return _blob_has_fcaptcha_score_value(blob)


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


def _post_submit_observation_blobs(entries: list[str]) -> list[str]:
    last_submit_idx = _last_submit_index(entries)
    if last_submit_idx < 0:
        return []
    return entries[last_submit_idx + 1 :]


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
    if any(reasoning_states_visible_fcaptcha_result(text) for text in candidates):
        return True
    # 15a85ea0: evaluate already returned 0.15 + "Bot detected" while
    # reasoning only named pow_not_satisfied and kept waiting. Tool-result
    # text after the latest submit is the same visible result.
    history_blobs = _history_entries(summaries, entries)
    return any(
        observation_states_visible_fcaptcha_result(blob)
        for blob in _post_submit_observation_blobs(history_blobs)
    )


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
