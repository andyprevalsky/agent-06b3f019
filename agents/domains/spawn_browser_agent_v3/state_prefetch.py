"""Speculative DOM build for the browser agent's next ``read_browser_state``.

    action that may change the page ──► arm()
    next step, right before the LLM ───► start(): settle, then build DOM
                                          │ (overlaps the LLM call; every
                                          │  step-start reload/autofill is done)
    next decision == read_browser_state ─► take(live_url): await build,
                                          │ reuse only if still on that URL
    any other decision / user control  ─► discard(): drop the build

Nothing is injected into the model's context: the build is only returned when
the model itself asks for ``read_browser_state``. At most one build per agent
is in flight, and it is cancelled as soon as another action is chosen.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any, Dict, Optional

import structlog

logger = structlog.get_logger()

PREFETCH_AFTER_ACTIONS = frozenset(
    {
        "click",
        "click_coordinates",
        "close_tab",
        "drag",
        "goto",
        "hover",
        "input_text",
        "navback",
        "open_new_tab",
        "press_key",
        "recover_from_challenge",
        "scroll",
        "select_dropdown",
        "switch_tab",
        "upload_file",
        "wait",
    }
)
# With the step-start work before it, lets click-triggered dropdowns,
# animations, and client-side renders land before the snapshot; the LLM call
# it overlaps takes longer than this.
PREFETCH_SETTLE_SECONDS = 0.25


class BrowserStatePrefetch:
    def __init__(self, *, settle_s: float = PREFETCH_SETTLE_SECONDS) -> None:
        self._settle_s = settle_s
        self._armed = False
        self._source: Any = None
        self._task: Optional["asyncio.Task[Dict[str, Any]]"] = None

    @property
    def in_flight(self) -> bool:
        return self._task is not None

    def arm(self, action_name: Optional[str], *, success: bool) -> None:
        self.discard()
        self._armed = success and action_name in PREFETCH_AFTER_ACTIONS

    def start(self, dom_service: Any) -> None:
        armed, self._armed = self._armed, False
        if not armed or dom_service is None or self._task is not None:
            return
        self._source = dom_service
        self._task = asyncio.create_task(self._build(dom_service))

    async def _build(self, dom_service: Any) -> Dict[str, Any]:
        await asyncio.sleep(self._settle_s)
        return await dom_service.get_browser_state(include_screenshot=False)

    async def take(self, dom_service: Any, live_url: Optional[str]) -> Optional[Dict[str, Any]]:
        """Return the speculative build if it is for this session and page."""
        task, source = self._task, self._source
        self._task, self._source = None, None
        if task is None:
            return None
        if source is not dom_service:
            task.cancel()
            return None
        try:
            state = await task
        except Exception as exc:
            logger.warning("Speculative browser state build failed", error=str(exc)[:200])
            return None
        if not isinstance(state, dict) or "dom_tree" not in state:
            return None
        if not live_url or state.get("url") != live_url:
            return None
        return state

    def discard(self) -> None:
        self._armed = False
        task, self._task, self._source = self._task, None, None
        if task is not None and not task.done():
            task.cancel()
        elif task is not None:
            with contextlib.suppress(BaseException):
                task.exception()
