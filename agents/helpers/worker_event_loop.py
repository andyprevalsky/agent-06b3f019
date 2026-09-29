"""Close a worker loop without waiting forever on abandoned terminal CDP I/O."""

import asyncio
import logging
from collections.abc import Coroutine
from typing import Any


_BROWSER_TERMINAL_IO_PREFIX = "browser-terminal-io:"
_TASK_DRAIN_SECONDS = 2.0
_LOG = logging.getLogger(__name__)


async def _stop_loop_event_buses(loop: asyncio.AbstractEventLoop) -> list[str]:
    """Close browser-use event buses while their owning loop can still run.

    bubus registers each started bus on its event loop and normally closes it
    from a loop.close hook. That hook runs too late for our strict pending-task
    check, leaving an otherwise idle EventBus._run_loop as a false teardown
    failure. Stop the registered buses through their public API first; a bus
    that still refuses to stop remains visible to the pending-task check.
    """
    buses = [
        bus for bus in list(getattr(loop, "_eventbus_instances", ()))
        if getattr(bus, "_is_running", False)
    ]
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
            bus_stop_errors = loop.run_until_complete(_stop_loop_event_buses(loop))
            pending = asyncio.all_tasks(loop)
            for task in pending:
                task.cancel()
            if pending:
                _done, pending = loop.run_until_complete(
                    asyncio.wait(pending, timeout=_TASK_DRAIN_SECONDS)
                )
            unexpected = [
                task for task in pending
                if not task.get_name().startswith(_BROWSER_TERMINAL_IO_PREFIX)
            ]
            problems = []
            if unexpected:
                problems.append(
                    "left unrelated tasks pending: "
                    + ", ".join(sorted(task.get_name() for task in unexpected))
                )
            if bus_stop_errors:
                problems.append("event bus stop failed: " + ", ".join(bus_stop_errors))
            if problems:
                raise RuntimeError("Worker shutdown " + "; ".join(problems))
            if pending:
                # The browser activity has already recorded the timeout, stopped
                # replay, and returned through the worker's explicit cleanup.
                _LOG.warning(
                    "Closing worker loop with %d timed-out terminal browser I/O task(s)",
                    len(pending),
                )
            loop.run_until_complete(loop.shutdown_asyncgens())
            loop.run_until_complete(loop.shutdown_default_executor())
    finally:
        asyncio.set_event_loop(None)
        loop.close()
