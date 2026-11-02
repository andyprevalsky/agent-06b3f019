"""Owned subprocess lifetime for staged deploy workers (no broad host cleanup)."""
from contextlib import contextmanager
import os
import signal
import subprocess
import threading
import time

CANCEL = threading.Event()


@contextmanager
def cancellation_handlers():
    CANCEL.clear()
    previous = {s: signal.getsignal(s) for s in (signal.SIGTERM, signal.SIGINT)}
    for s in previous:
        signal.signal(s, lambda *_: CANCEL.set())
    try:
        yield
    finally:
        for s, handler in previous.items():
            signal.signal(s, handler)


def run_command(argv, *, cwd, env, output, timeout, input_path=None, stderr_output=None):
    incoming = open(input_path, 'rb') if input_path else None
    try:
        proc = subprocess.Popen(argv, cwd=cwd, env=env, stdin=incoming, stdout=output,
                                stderr=stderr_output if stderr_output is not None else subprocess.STDOUT,
                                start_new_session=True)
    finally:
        if incoming:
            incoming.close()
    deadline = None if timeout is None else time.monotonic() + timeout
    timed_out = False
    while proc.poll() is None:
        timed_out = deadline is not None and time.monotonic() >= deadline
        if CANCEL.is_set() or timed_out:
            # Popen has not reaped this exact session leader, so its pid cannot
            # have been reused. Only its owned process group is signalled.
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                proc.wait()
            break
        try:
            proc.wait(timeout=min(.1, max(.001, deadline - time.monotonic())) if deadline else .1)
        except subprocess.TimeoutExpired:
            continue
    # A command that exits but leaves its group alive did not complete cleanup.
    # Do not signal after reaping a leader: ownership must be re-established by
    # the normal runner's cleanup protocol, never inferred from a recycled pid.
    lingering = False
    try:
        os.killpg(proc.pid, 0)
        lingering = True
    except ProcessLookupError:
        pass
    return proc.returncode, timed_out, CANCEL.is_set(), lingering
