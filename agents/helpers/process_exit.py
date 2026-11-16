"""Process entrypoint that exits without CPython interpreter finalization.

The Temporal SDK bridge (pyo3 + tokio) can deadlock finalization: a tokio
thread finishing an in-flight client RPC (e.g. a rate-limited
``count_workflows`` in retry backoff) tries to take the GIL, pyo3 parks it
forever because the interpreter is finalizing, and the main thread then waits
on that thread while dropping the runtime. The worker logs "Worker stopped"
and never exits, holding its ports and memory as an orphan.

    asyncio.run(main())  ──returns/raises──►  flush logs + stdio  ──►  os._exit(code)
                                                   (finalization never runs)
"""

import asyncio
import contextlib
import logging
import os
import sys
import threading
import time
import traceback
from typing import Any, Callable, Coroutine, NoReturn

NATIVE_CALLBACK_DRAIN_SECONDS = 2.0


def foreign_threads_running_python() -> bool:
    python_started = {
        thread.ident for thread in threading.enumerate() if not isinstance(thread, threading._DummyThread)
    }
    return any(ident not in python_started for ident in sys._current_frames())


async def drain_native_python_callbacks(timeout: float = NATIVE_CALLBACK_DRAIN_SECONDS) -> bool:
    """Wait until no SDK-owned native thread is executing Python code.

    An SDK RPC completion resolves its asyncio future from a Tokio thread via
    call_soon_threadsafe, whose self-pipe write releases the GIL before the
    callback returns. If the entry point returns first, that thread re-takes
    the GIL during interpreter finalization and the process aborts (SIGABRT
    "PyGILState_Release ... finalizing" or SIGSEGV) after a clean shutdown.
    Every entry point that drives the Temporal SDK awaits this last.
    """
    deadline = time.monotonic() + timeout
    while foreign_threads_running_python():
        if time.monotonic() >= deadline:
            return False
        await asyncio.sleep(0.005)
    return True


def exit_code_for(code: object) -> int:
    """Map a ``SystemExit.code`` to a process status the way CPython does."""
    if code is None:
        return 0
    if isinstance(code, bool):
        return int(code)
    if isinstance(code, int):
        return code
    with contextlib.suppress(Exception):
        print(code, file=sys.stderr)
    return 1


def run_then_exit(
    main: Callable[[], Coroutine[Any, Any, object]],
    run: Callable[[Coroutine[Any, Any, object]], object] = asyncio.run,
) -> NoReturn:
    """Run ``main`` on ``run`` (the worker passes its bounded-shutdown loop), then exit."""
    code = 0
    try:
        run(main())
    except SystemExit as exc:
        code = exit_code_for(exc.code)
    except KeyboardInterrupt:
        code = 130
    except BaseException:
        with contextlib.suppress(Exception):
            traceback.print_exc()
        code = 1
    with contextlib.suppress(Exception):
        logging.shutdown()
    for stream in (sys.stdout, sys.stderr):
        with contextlib.suppress(Exception):
            stream.flush()
    os._exit(code)
