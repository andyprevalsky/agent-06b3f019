"""Let SDK native threads leave Python before an entry point returns into interpreter exit.

A Temporal bridge completion settles its asyncio future from a Tokio thread via
call_soon_threadsafe, whose self-pipe write releases the GIL before the callback
returns. If the entry point returns first, that thread re-takes the GIL during
interpreter finalization and the process aborts (SIGABRT "PyGILState_Release ...
finalizing" or SIGSEGV) after a clean shutdown. worker.main and the blackbox test
runner both await this drain before returning.
"""

import asyncio
import sys
import threading
import time

NATIVE_CALLBACK_DRAIN_SECONDS = 2.0


def foreign_threads_running_python() -> bool:
    """Whether a thread that threading did not start (an SDK Tokio thread) is executing Python."""
    python_started = {
        thread.ident for thread in threading.enumerate() if not isinstance(thread, threading._DummyThread)
    }
    return any(ident not in python_started for ident in sys._current_frames())


async def drain_native_python_callbacks(timeout: float = NATIVE_CALLBACK_DRAIN_SECONDS) -> bool:
    """Wait (bounded) until no SDK-owned native thread is executing Python code."""
    deadline = time.monotonic() + timeout
    while foreign_threads_running_python():
        if time.monotonic() >= deadline:
            return False
        await asyncio.sleep(0.005)
    return True
