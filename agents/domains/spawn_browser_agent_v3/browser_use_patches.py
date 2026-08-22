"""Runtime patches for browser-use that our config cannot reach via env alone.

browser-use's ``BrowserSession._navigate_and_wait`` hardcodes
``nav_timeout = 20.0`` around ``Page.navigate()``, independent of
``TIMEOUT_NavigateToUrlEvent`` (which we set to 300s in ``config.py``).

On heavy merchant start URLs (e.g. amctheatres.com showtimes via Steel/Kernel),
the CDP navigate RPC can exceed 20s. The activity then raises
``RuntimeError: Page.navigate() timed out after 20.0s``, which surfaces as a
tool ERROR. The root agent then re-spawns with an alternate ticket seller
(Fandango), violating ``expected_payment_receipt.merchant`` for AMC-direct
tasks (descend browser-event-ticket, 2026-08-20).

This module replaces that hardcoded 20s with ``NAVIGATE_TO_URL_TIMEOUT_SECONDS``.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from .config import NAVIGATE_TO_URL_TIMEOUT_SECONDS

logger = logging.getLogger(__name__)

_PATCHED_ATTR = "_rose_navigate_timeout_patched"
_UPSTREAM_PAGE_NAVIGATE_TIMEOUT_SECONDS = 20.0


def page_navigate_timeout_seconds() -> float:
    """Authoritative CDP Page.navigate wait used by our browser agent."""
    return float(NAVIGATE_TO_URL_TIMEOUT_SECONDS)


def apply_browser_use_navigate_timeout_patch() -> bool:
    """Patch browser-use ``_navigate_and_wait`` to honor our navigate timeout.

    Safe to call repeatedly. Returns True when the patch is active.
    """
    try:
        from browser_use.browser.session import BrowserSession
    except Exception as exc:  # pragma: no cover - import environment
        logger.warning("browser-use BrowserSession unavailable for nav timeout patch: %s", exc)
        return False

    if getattr(BrowserSession, _PATCHED_ATTR, False):
        return True

    original = BrowserSession._navigate_and_wait
    timeout_s = page_navigate_timeout_seconds()

    async def _patched(self: Any, *args: Any, **kwargs: Any) -> Any:
        real_wait_for = asyncio.wait_for

        async def _wait_for(awaitable: Any, timeout: float | None = None, **wait_kwargs: Any) -> Any:
            # Upstream hardcodes timeout=20.0 exclusively around Page.navigate.
            # Stretch only that call; leave other wait_for budgets unchanged.
            if timeout == _UPSTREAM_PAGE_NAVIGATE_TIMEOUT_SECONDS:
                timeout = timeout_s
            return await real_wait_for(awaitable, timeout=timeout, **wait_kwargs)

        asyncio.wait_for = _wait_for  # type: ignore[assignment]
        try:
            return await original(self, *args, **kwargs)
        finally:
            asyncio.wait_for = real_wait_for  # type: ignore[assignment]

    BrowserSession._navigate_and_wait = _patched  # type: ignore[method-assign]
    setattr(BrowserSession, _PATCHED_ATTR, True)
    logger.info(
        "Patched browser-use Page.navigate timeout: %.1fs → %.1fs (NAVIGATE_TO_URL_TIMEOUT_SECONDS)",
        _UPSTREAM_PAGE_NAVIGATE_TIMEOUT_SECONDS,
        timeout_s,
    )
    return True
