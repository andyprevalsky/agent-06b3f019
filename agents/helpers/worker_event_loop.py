"""Close a worker loop without waiting forever on abandoned terminal CDP I/O."""

import asyncio
import logging
import os
import sys
import threading
from collections.abc import Coroutine
from typing import Any

_BROWSER_TERMINAL_IO_PREFIX = "browser-terminal-io:"
_TASK_DRAIN_SECONDS = 2.0
# How long loop close waits for blocking jobs on the loop's default executor
# (asyncio.to_thread: recording-archive uploads, checkpoint writes). Python 3.11's
# shutdown_default_executor() has no deadline and joins its worker threads in a
# finally block, so a cancelled wait still blocks. Local and benchmark stacks bound
# it; production keeps the unbounded join, which Fly's kill_timeout already caps.
_EXECUTOR_SHUTDOWN_SECONDS = 20.0


def _executor_shutdown_seconds() -> float | None:
    """Bound for the default-executor join; None keeps the unbounded production join."""
    if os.environ.get("FLY_APP_NAME") is not None or os.environ.get("ENVIRONMENT") == "production":
        return None
    return _EXECUTOR_SHUTDOWN_SECONDS
_LOG = logging.getLogger(__name__)


async def _shutdown_default_executor_bounded(loop: asyncio.AbstractEventLoop, timeout: float) -> None:
    """Close the default executor, waiting for running jobs at most ``timeout`` seconds.

    Queued jobs that have not started are dropped. Their awaiting tasks were
    already cancelled above and the archive callers keep their durable outbox.
    Jobs still running at the deadline are left to the process exit, which
    ``run_then_exit`` performs with ``os._exit`` and which does not join threads.
    """
    executor = getattr(loop, "_default_executor", None)
    if executor is None:
        return
    executor.shutdown(wait=False, cancel_futures=True)
    finished = threading.Event()

    def join() -> None:
        executor.shutdown(wait=True)
        finished.set()

    threading.Thread(target=join, name="default-executor-shutdown", daemon=True).start()
    deadline = loop.time() + max(0.0, timeout)
    while not finished.is_set() and loop.time() < deadline:
        await asyncio.sleep(0.05)
    if not finished.is_set():
        _LOG.warning(
            "Worker default executor still has running jobs after %.0fs; leaving them to the process exit",
            timeout,
        )


async def _stop_loop_event_buses(loop: asyncio.AbstractEventLoop) -> list[str]:
    """Close browser-use event buses while their owning loop can still run.

    bubus registers each started bus on its event loop and normally closes it
    from a loop.close hook. That hook runs too late for our strict pending-task
    check, leaving an otherwise idle EventBus._run_loop as a false teardown
    failure. Stop the registered buses through their public API first; a bus
    that still refuses to stop remains visible to the pending-task check.
    """
    buses = [bus for bus in list(getattr(loop, "_eventbus_instances", ())) if getattr(bus, "_is_running", False)]
    if not buses:
        return []
    results = await asyncio.gather(
        *(asyncio.wait_for(bus.stop(timeout=0, clear=True), timeout=1.0) for bus in buses),
        return_exceptions=True,
    )
    errors = [
        f"{bus.name}: {type(result).__name__}"
        for bus, result in zip(buses, results)
        if isinstance(result, BaseException)
    ]
    for error in errors:
        _LOG.warning("Failed to stop browser event bus %s", error)
    return errors


def run_worker_event_loop(main: Coroutine[Any, Any, Any]) -> Any:
    """Run the worker through its own cleanup, then bound loop task shutdown.

    Browser terminal I/O can ignore cancellation after its activity and recording
    cleanup have finished. ``asyncio.run`` waits for every such task forever.
    Only explicitly named terminal I/O may remain after this bounded drain;
    unrelated pending work is a shutdown failure, not a clean worker exit.
    """
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        try:
            return loop.run_until_complete(main)
        finally:
            primary_error = sys.exception()
            bus_stop_errors = loop.run_until_complete(_stop_loop_event_buses(loop))
            pending = asyncio.all_tasks(loop)
            for task in pending:
                task.cancel()
            if pending:
                _done, pending = loop.run_until_complete(asyncio.wait(pending, timeout=_TASK_DRAIN_SECONDS))
            unexpected = [task for task in pending if not task.get_name().startswith(_BROWSER_TERMINAL_IO_PREFIX)]
            problems = []
            if unexpected:
                problems.append(
                    "left unrelated tasks pending: " + ", ".join(sorted(task.get_name() for task in unexpected))
                )
            if bus_stop_errors:
                problems.append("event bus stop failed: " + ", ".join(bus_stop_errors))
            if problems:
                shutdown_error = "Worker shutdown " + "; ".join(problems)
                if primary_error is None:
                    raise RuntimeError(shutdown_error)
                _LOG.error(shutdown_error)
            if pending and not unexpected:
                # The browser activity has already recorded the timeout, stopped
                # replay, and returned through the worker's explicit cleanup.
                _LOG.warning(
                    "Closing worker loop with %d timed-out terminal browser I/O task(s)",
                    len(pending),
                )
            loop.run_until_complete(loop.shutdown_asyncgens())
            executor_bound = _executor_shutdown_seconds()
            if executor_bound is None:
                loop.run_until_complete(loop.shutdown_default_executor())
            else:
                loop.run_until_complete(_shutdown_default_executor_bounded(loop, executor_bound))
    finally:
        asyncio.set_event_loop(None)
        loop.close()
