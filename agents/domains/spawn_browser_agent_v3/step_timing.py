"""Per-step phase timing for the browser agent loop.

The loop is one long coroutine with many ``continue`` exits, so phases are
recorded as contiguous marks instead of nested spans: each ``mark(phase)``
attributes the wall-clock since the previous mark to ``phase``. Calling
``start_step`` (or ``finish``) emits one ``browser.step.phases`` event for the
previous step, so every exit path is still accounted for.
"""

from __future__ import annotations

import time
from typing import Callable, Dict, Optional

import structlog

logger = structlog.get_logger(__name__)


class StepPhaseTimer:
    def __init__(
        self,
        *,
        agent_id: Optional[str],
        task_id: Optional[str],
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._agent_id = agent_id
        self._task_id = task_id
        self._clock = clock
        self._step: Optional[int] = None
        self._step_started: float = 0.0
        self._last_mark: float = 0.0
        self._phases_ms: Dict[str, int] = {}
        self._attrs: Dict[str, object] = {}

    def start_step(self, step: int) -> Optional[Dict[str, object]]:
        summary = self.finish()
        now = self._clock()
        self._step = step
        self._step_started = now
        self._last_mark = now
        self._phases_ms = {}
        self._attrs = {}
        return summary

    def mark(self, phase: str) -> None:
        if self._step is None:
            return
        now = self._clock()
        elapsed_ms = int(round((now - self._last_mark) * 1000))
        self._phases_ms[phase] = self._phases_ms.get(phase, 0) + elapsed_ms
        self._last_mark = now

    def annotate(self, **attrs: object) -> None:
        if self._step is None:
            return
        self._attrs.update({key: value for key, value in attrs.items() if value is not None})

    def finish(self) -> Optional[Dict[str, object]]:
        if self._step is None:
            return None
        self.mark("unattributed")
        total_ms = int(round((self._last_mark - self._step_started) * 1000))
        summary: Dict[str, object] = {
            "step": self._step,
            "total_ms": total_ms,
            "phases_ms": dict(self._phases_ms),
            **self._attrs,
        }
        logger.info(
            "browser.step.phases",
            agent_id=self._agent_id,
            task_id=self._task_id,
            **summary,
        )
        self._step = None
        return summary
