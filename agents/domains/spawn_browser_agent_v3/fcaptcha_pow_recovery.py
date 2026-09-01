"""FCaptcha proof-of-work recovery helpers for webdecoy.com benchmarks.

WebDecoy's invisible-mode form rejects early submits with ``pow_not_satisfied``
when the page's PoW web worker has not finished. The humanizer probe waits
between interactions; the browser agent can submit too eagerly and retry until
the benchmark timeout. These helpers detect that state and insert bounded waits
so PoW can complete before another submit attempt.
"""

from __future__ import annotations

import re
from urllib.parse import urlparse

WEBDECOY_HOST_SUFFIX = "webdecoy.com"
FCAPTCHA_DEMO_PATH_FRAGMENT = "/product/fcaptcha-demo"

# Probe timings (fcaptcha_humanizer_probe.py): page settle + bounded PoW retry.
FCAPTCHA_PAGE_SETTLE_SECONDS = 2.0
FCAPTCHA_PRE_SUBMIT_WAIT_SECONDS = 4.0
FCAPTCHA_POW_RETRY_WAIT_SECONDS = 12.0
FCAPTCHA_MAX_POW_RECOVERY_WAITS = 4

_POW_BLOCKED_RE = re.compile(r"pow_not_satisfied|bot detected.*form blocked", re.IGNORECASE | re.DOTALL)
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
