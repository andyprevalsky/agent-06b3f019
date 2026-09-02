"""FCaptcha proof-of-work recovery helpers for webdecoy.com benchmarks.

WebDecoy's invisible-mode form rejects early submits with ``pow_not_satisfied``
when the page's PoW web worker has not finished. The humanizer probe waits
between interactions; the browser agent can submit too eagerly and retry until
the benchmark timeout. These helpers detect that state and insert bounded waits
so PoW can complete before another submit attempt.

Under smoke concurrency, PoW is CPU-contended: use longer silent waits so the
worker can finish. Do not reload the page after a blocked submit — reload drops
an already-Verified checkbox and can fail the next verify with
``challenge_network_mismatch``. Do not inject completion nudges.
"""

from __future__ import annotations

import re
from urllib.parse import urlparse

WEBDECOY_HOST_SUFFIX = "webdecoy.com"
FCAPTCHA_DEMO_PATH_FRAGMENT = "/product/fcaptcha-demo"

# Silent waits only. No page reload, no LLM completion nudges.
FCAPTCHA_PAGE_SETTLE_SECONDS = 6.0
FCAPTCHA_PRE_SUBMIT_WAIT_SECONDS = 10.0
FCAPTCHA_POW_RETRY_WAIT_SECONDS = 15.0
FCAPTCHA_MAX_POW_RECOVERY_WAITS = 3

_POW_BLOCKED_RE = re.compile(
    r"pow_not_satisfied|bot detected.*form blocked",
    re.IGNORECASE | re.DOTALL,
)
_SUBMIT_LABEL_RE = re.compile(
    r"\b(submit|send message|send\b|post message)\b",
    re.IGNORECASE,
)


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
    """Never reload — reload drops Verified and triggers challenge_network_mismatch."""
    return False


def fcaptcha_pow_retry_guidance(*, recovery_seconds: float, reloaded: bool) -> str:
    """Factual user-turn status after a bounded PoW wait (no completion nudge, no reload)."""
    del reloaded  # reload path retired; keep kwarg for call-site compatibility
    return (
        "FCaptcha rejected the submit (pow_not_satisfied / form blocked) — the page "
        f"proof-of-work was not ready. Waited {recovery_seconds:.0f}s without reloading "
        "so the existing checkbox Verified state is preserved. Move the mouse naturally, "
        "then retry the invisible-form submit once."
    )
