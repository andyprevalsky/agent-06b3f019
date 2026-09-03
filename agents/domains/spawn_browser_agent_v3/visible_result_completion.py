"""Force browser completion once the visible goal result is already stated.

`browser-biometrics-webdecoy` (agent c3762be3) already read FCaptcha risk
score 0.07 and "Bot detected - form blocked" / pow_not_satisfied, then spent
the remaining 420s cap on 5–10s waits and extra submits. The task asks to
return that visible score and verdict, not to keep retrying proof-of-work.

A later smoke failure (agent b234cfa8) stated Risk Score 0.11 + the same bot
verdict, then burned the 420s cap on scroll/screenshot loops instead of wait.
Rewrite post-submit idle actions (`wait`, `scroll`, …) into
`attempt_completion` so the parent can finish instead of burning the harness
timeout.
"""

from __future__ import annotations

import json
import re
from typing import Any, Iterable

_RISK_SCORE_RE = re.compile(r"\brisk\s+score\b", re.IGNORECASE)
_FCAPTCHA_SCORE_RE = re.compile(r"\bfcaptcha\b.*\bscore\b|\bscore\b.*\bfcaptcha\b", re.IGNORECASE)
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
        "page_up",
        "page_down",
        "screenshot",
        "noop",
        "sleep",
        "move",
        "hover",
    }
)


def reasoning_states_visible_fcaptcha_result(text: str) -> bool:
    """True when the agent already reported the visible score/verdict."""
    blob = str(text or "")
    if not blob.strip():
        return False
    has_score = bool(_RISK_SCORE_RE.search(blob) or _FCAPTCHA_SCORE_RE.search(blob))
    lowered = blob.lower()
    has_verdict = any(marker in lowered for marker in _VERDICT_MARKERS)
    return has_score and has_verdict


def _entry_blob(entry: Any) -> str:
    if isinstance(entry, str):
        return entry
    try:
        return json.dumps(entry, default=str)
    except TypeError:
        return str(entry)


def history_has_submit_click(
    action_summaries: Iterable[Any] | None = None,
    action_entries: Iterable[Any] | None = None,
) -> bool:
    """True when a prior click already targeted a Submit control."""
    for entry in list(action_summaries or []) + list(action_entries or []):
        blob = _entry_blob(entry).lower()
        if "submit" in blob and "click" in blob:
            return True
    return False


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
    if not history_has_submit_click(action_summaries, action_entries):
        return False
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
