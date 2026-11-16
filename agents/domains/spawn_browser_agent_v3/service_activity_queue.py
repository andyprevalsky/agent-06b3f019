"""Workflow-local browser serialization and acknowledged activity cleanup."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, contextmanager
from contextvars import ContextVar
from typing import Any, AsyncIterator


class BrowserCleanupOwners:
    """Activity-local custody, including handles discarded by failed setup."""

    def __init__(self) -> None:
        self.dom_services: dict[int, Any] = {}
        self.multiplexers: dict[int, Any] = {}
        self.playwright: dict[tuple[str, int], tuple[Any, Any, Any, bool]] = {}
        self.setup_tasks: set[asyncio.Task] = set()
        self.driver_owners: dict[tuple[str, int], Any] = {}
        self.playwright_startups: dict[int, Any] = {}
        self.admission_closed = False
        self.phone_leases: dict[tuple[str, str], set[str]] = {}
        self.phone_cleanup: dict[tuple[str, str], dict[str, str]] = {}

    def ensure_acquisition_open(self) -> None:
        if self.admission_closed:
            raise RuntimeError("Browser resource acquisition is closed")

    def close_admission(self) -> None:
        # Close before cancellation can yield into a setup task's finally block.
        self.admission_closed = True

    def track_dom(self, service: Any) -> None:
        self.dom_services = {
            key: owner
            for key, owner in self.dom_services.items()
            if getattr(owner, "disconnect_confirmed", False) is not True
        }
        self.dom_services[id(service)] = service
        self.multiplexers.pop(id(getattr(service, "cdp_multiplexer", None)), None)

    @staticmethod
    def playwright_key(browser: Any, instance: Any, pid: Any) -> tuple[str, int] | None:
        if instance is not None:
            return "instance", id(instance)
        if browser is not None:
            return "browser", id(browser)
        return ("pid", pid) if pid is not None else None

    def track_playwright(self, browser: Any, instance: Any, pid: Any, *, close_browser: bool = True) -> None:
        key = self.playwright_key(browser, instance, pid)
        if key is not None:
            self.playwright[key] = (browser, instance, pid, close_browser)

    def track_driver(self, browser: Any, instance: Any, pid: Any) -> None:
        key = self.playwright_key(browser, instance, pid)
        if pid is None or key is None or key in self.driver_owners:
            return
        import psutil

        try:
            self.driver_owners[key] = psutil.Process(pid)
        except psutil.NoSuchProcess:
            self.driver_owners[key] = False  # already exited at capture
        except (psutil.Error, OSError):
            self.driver_owners[key] = None  # identity unknown: retain custody

    def release_playwright(self, browser: Any, instance: Any, pid: Any) -> None:
        key = self.playwright_key(browser, instance, pid)
        self.playwright.pop(key, None)
        self.driver_owners.pop(key, None)


_cleanup_owners: ContextVar[BrowserCleanupOwners | None] = ContextVar("browser_cleanup_owners", default=None)


@contextmanager
def browser_cleanup_owners():
    owners = BrowserCleanupOwners()
    token = _cleanup_owners.set(owners)
    try:
        yield owners
    finally:
        _cleanup_owners.reset(token)


def get_browser_cleanup_owners() -> BrowserCleanupOwners | None:
    return _cleanup_owners.get()


@asynccontextmanager
async def browser_activity_turn(owner: Any) -> AsyncIterator[None]:
    # Owned by this GP workflow, reconstructed in deterministic coroutine order
    # on replay. Never keep this lock on the process-global manager singleton.
    lock = getattr(owner, "_browser_activity_lock", None)
    if lock is None:
        lock = asyncio.Lock()
        owner._browser_activity_lock = lock
    async with lock:
        yield


async def await_owned_browser_cleanup(task: asyncio.Future) -> None:
    """Do not acknowledge cancellation while this activity still owns cleanup."""
    cancelled = False
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            cancelled = True
    task.result()
    if cancelled:
        raise asyncio.CancelledError


async def cancel_and_join_browser_activity(handle: Any) -> None:
    """WAIT_CANCELLATION_COMPLETED keeps the workflow turn until worker cleanup."""
    handle.cancel()
    while not handle.done():
        try:
            await asyncio.shield(handle)
        except asyncio.CancelledError:
            pass
        except Exception:
            break
    # Retrieve the terminal error; the caller preserves its cancellation.
    try:
        handle.result()
    except (asyncio.CancelledError, Exception):
        pass


async def acknowledge_browser_activity_cleanup() -> None:
    """Report worker teardown to the current continuation, scoped to its source attempt.

    This acknowledges local driving custody only. A provider checkpoint/release
    error remains on the original result; the next activity still validates the
    existing logical browser through the ordinary backend lifecycle.
    """
    from datetime import timedelta

    import structlog
    from temporalio import activity

    if not activity.in_activity():
        return
    info = activity.info()
    if not info.workflow_id or not info.activity_id.startswith("browser-cleanup:"):
        return
    try:
        await activity.client().get_workflow_handle(info.workflow_id).signal(
            "browser_activity_cleanup_complete",
            {"run_id": info.workflow_run_id, "activity_id": info.activity_id},
            rpc_timeout=timedelta(seconds=10),
        )
    except Exception as error:
        # An absent receipt must leave the workflow fenced. Never infer success
        # from elapsed time or replace the original browser outcome with this RPC.
        structlog.get_logger().error(
            "Browser cleanup receipt delivery failed",
            activity_id=info.activity_id,
            error_type=type(error).__name__,
        )
