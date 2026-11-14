"""Bounded, payload-free diagnostics for a browser step's foreground awaits.

Request ordinals identify source operations, not provider/CDP wire requests.
This trace never supplies progress, deadlines, retries, or recovery decisions.
"""

from __future__ import annotations

import asyncio
import contextvars
import hashlib
import uuid
from typing import Awaitable, TypeVar

import structlog

_T = TypeVar("_T")
logger = structlog.get_logger(__name__)
_current: contextvars.ContextVar["ForegroundAwaitTrace | None"] = contextvars.ContextVar(
    "browser_foreground_trace", default=None,
)
_OPERATIONS = frozenset({
    "user_control", "tab_rebind", "instruction_sync", "overlay_suppress", "observe_page",
    "cdp_attach", "target_info", "cdp_detach", "foreground", "humanizer_close",
    "cursor_initialize", "control_read", "control_ack", "control_yield",
})
MAX_OPERATIONS = 16


def _identity(value: object) -> str:
    # Never invoke user-defined __str__, retain raw IDs, or hash arbitrary payloads.
    if type(value) is not str or not 0 < len(value) <= 256:
        return "unavailable"
    return hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()[:24]


class ForegroundAwaitTrace:
    def __init__(self, *, agent_id: object, task_id: object, session_id: object, step: object):
        self._owner = {
            "agent_key": _identity(agent_id), "task_key": _identity(task_id),
            "session_key": _identity(session_id),
            "step": step if type(step) is int and 0 <= step <= 1_000_000 else 0,
            "trace_id": uuid.uuid4().hex,
        }
        self._count = 0
        self._overflow = False
        self._active_tasks: dict[asyncio.Task, int] = {}

    def owns_current_task(self) -> bool:
        task = asyncio.current_task()
        return task is not None and task in self._active_tasks

    def _emit(self, **fields: object) -> None:
        # Diagnostics cannot turn a successful operation into a failed activity.
        try:
            logger.info("browser.foreground.await", **self._owner, **fields)
        except Exception:
            pass

    async def run(self, operation: str, work: Awaitable[_T], *, target_id: object = None) -> _T:
        # Unknown operation names are never reflected into logs. Still execute once.
        if type(operation) is not str or operation not in _OPERATIONS or self._count >= MAX_OPERATIONS:
            if not self._overflow:
                self._overflow = True
                self._emit(state="budget_exhausted")
            return await work
        self._count += 1
        ordinal = self._count
        fields = {"operation": operation, "request_ordinal": ordinal,
                  "target_key": _identity(target_id)}
        self._emit(state="start", **fields)
        token = _current.set(self)
        task = asyncio.current_task()
        if task is not None:
            self._active_tasks[task] = self._active_tasks.get(task, 0) + 1
        state = "done"
        try:
            return await work
        except asyncio.CancelledError:
            state = "cancelled"
            raise
        except BaseException:
            state = "error"
            raise
        finally:
            _current.reset(token)
            if task is not None:
                depth = self._active_tasks[task] - 1
                if depth:
                    self._active_tasks[task] = depth
                else:
                    del self._active_tasks[task]
            self._emit(state=state, **fields)


async def trace_foreground_await(
    operation: str, work: Awaitable[_T], *, target_id: object = None,
) -> _T:
    owner = _current.get()
    if owner is None or not owner.owns_current_task():
        return await work
    return await owner.run(operation, work, target_id=target_id)
