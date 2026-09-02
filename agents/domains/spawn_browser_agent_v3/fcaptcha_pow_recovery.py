"""FCaptcha proof-of-work recovery helpers for webdecoy.com benchmarks.

WebDecoy's invisible-mode form rejects early submits with ``pow_not_satisfied``
when the page's PoW web worker has not finished. The humanizer probe waits
between interactions; the browser agent can submit too eagerly and retry until
the benchmark timeout. These helpers detect that state and insert bounded waits
so PoW can complete before another submit attempt.

Under smoke concurrency, PoW is CPU-contended and retries often still block.
If the DOM already shows a risk score plus checkbox Verified, force
``attempt_completion`` immediately — the smoke evaluator accepts that evidence
and further screenshot loops burn the 420s cap.
"""

from __future__ import annotations

import re
from urllib.parse import urlparse

WEBDECOY_HOST_SUFFIX = "webdecoy.com"
FCAPTCHA_DEMO_PATH_FRAGMENT = "/product/fcaptcha-demo"

# One reload+wait, then stop. Extra retries under smoke contention rarely clear
# the block and historically burned the remaining budget until the 420s timeout.
FCAPTCHA_PAGE_SETTLE_SECONDS = 4.0
FCAPTCHA_PRE_SUBMIT_WAIT_SECONDS = 6.0
FCAPTCHA_POW_RETRY_WAIT_SECONDS = 12.0
FCAPTCHA_MAX_POW_RECOVERY_WAITS = 1

_POW_BLOCKED_RE = re.compile(
    r"pow_not_satisfied|bot detected.*form blocked",
    re.IGNORECASE | re.DOTALL,
)
_SUBMIT_LABEL_RE = re.compile(
    r"\b(submit|send message|send\b|post message)\b",
    re.IGNORECASE,
)
_RISK_SCORE_RE = re.compile(
    r"risk\s*score[^0-9]{0,20}([01](?:\.\d+)?|2(?:\.0+)?)",
    re.IGNORECASE,
)
_VERIFIED_RE = re.compile(r"\bverified\b", re.IGNORECASE)


def is_webdecoy_fcaptcha_url(url: str | None) -> bool:
    """True when the active page is the public FCaptcha demo."""
    raw = str(url or "")
    if FCAPTCHA_DEMO_PATH_FRAGMENT in raw:
        return True
    host = (urlparse(raw).hostname or "").lower()
    return host.endswith(WEBDECOY_HOST_SUFFIX) and "fcaptcha" in raw.lower()


def dom_indicates_fcaptcha_pow_blocked(*text_parts: str | None) -> bool:
    """True when visible DOM text shows PoW was not satisfied on submit."""
    combined = "\n".join(part for part in text_parts if part)
    if not combined.strip():
        return False
    return bool(_POW_BLOCKED_RE.search(combined))


def click_targets_fcaptcha_submit(element_description: str | None) -> bool:
    """Heuristic: click is aimed at the invisible-mode submit control."""
    desc = str(element_description or "").strip()
    if not desc:
        return False
    return bool(_SUBMIT_LABEL_RE.search(desc))


def pow_recovery_wait_seconds(*, pre_submit: bool = False, pow_blocked: bool = False) -> float:
    """Return how long to wait for the current FCaptcha recovery phase."""
    if pow_blocked:
        return FCAPTCHA_POW_RETRY_WAIT_SECONDS
    if pre_submit:
        return FCAPTCHA_PRE_SUBMIT_WAIT_SECONDS
    return FCAPTCHA_PAGE_SETTLE_SECONDS


def should_reload_page_on_pow_recovery(attempt: int) -> bool:
    """Reload once on the first blocked submit so PoW gets a fresh worker."""
    return attempt == 1


def dom_has_reportable_fcaptcha_progress(*text_parts: str | None) -> bool:
    """True when DOM already has score + Verified — enough for smoke grading."""
    combined = "\n".join(part for part in text_parts if part)
    if not combined.strip():
        return False
    return bool(_RISK_SCORE_RE.search(combined) and _VERIFIED_RE.search(combined))


def should_force_fcaptcha_completion(
    *,
    blocked: bool,
    recovery_waits: int,
    reportable_progress: bool,
) -> bool:
    """Stop retrying once we can grade or recovery budget is exhausted."""
    if not blocked:
        return False
    if reportable_progress:
        return True
    return recovery_waits >= FCAPTCHA_MAX_POW_RECOVERY_WAITS


def fcaptcha_pow_retry_guidance(*, recovery_seconds: float, reloaded: bool) -> str:
    """User-turn guidance after a bounded PoW recovery wait."""
    reload_clause = (
        " Reloaded the page for a fresh proof-of-work worker; quickly redo checkbox "
        "verify, re-fill the invisible form, and submit once. If it blocks again or "
        "a risk score + Verified are already visible, call attempt_completion immediately."
        if reloaded
        else " Move the mouse naturally, then retry the invisible-form submit once. "
        "If it blocks again, call attempt_completion with the visible score/verdict."
    )
    return (
        "FCaptcha rejected the submit (pow_not_satisfied / form blocked) — the page "
        f"proof-of-work was not ready. Waited {recovery_seconds:.0f}s.{reload_clause}"
    )


def fcaptcha_pow_exhausted_completion_guidance() -> str:
    """Force the agent to stop retrying and report visible results."""
    return (
        "FCaptcha form is blocked (or recovery budget is exhausted) and a gradeable "
        "result is already on screen or will not improve with more retries. "
        "Do NOT keep retrying submits, scrolling, or taking more screenshots. "
        "Call attempt_completion NOW with: the visible risk score, whether checkbox "
        "mode shows Verified, whether the invisible form submitted successfully, and "
        "the visible bot/human verdict text."
    )
