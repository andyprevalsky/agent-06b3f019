"""Close a worker loop without waiting forever on abandoned terminal CDP I/O."""

import asyncio
import logging
from collections.abc import Coroutine
from typing import Any


_BROWSER_TERMINAL_IO_PREFIX = "browser-terminal-io:"
_TASK_DRAIN_SECONDS = 2.0
_LOG = logging.getLogger(__name__)


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
            if unexpected:
                raise RuntimeError(
                    "Worker shutdown left unrelated tasks pending: "
                    + ", ".join(sorted(task.get_name() for task in unexpected))
                )
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
