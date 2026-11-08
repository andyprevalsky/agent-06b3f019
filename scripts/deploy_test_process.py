"""Owned subprocess lifetime for staged deploy workers (no broad host cleanup)."""
from contextlib import contextmanager
import os
import json
from pathlib import Path
import sys
import tempfile
import signal
import subprocess
import threading
import time

CANCEL = threading.Event()
# Ten seconds for TERM, two for reap, one for receipt publication.
OWNED_DRAIN_SECONDS = 13.0



def scan_same_user_processes(inspect, refuse, grace=2.0):
    """Call inspect(process) for each /proc entry owned by this euid; never signals anything.

    A same-user process can turn unreadable mid-scan (non-dumpable, or exec of a setuid binary that
    keeps our real uid). Re-observe it for up to `grace` seconds: skip it only once it exits or its
    real or effective uid is another user's (a sudo that keeps our real uid but runs as root is
    skipped exactly as the first look skips it); one that stays unreadable under our own credentials
    goes to refuse(pid), never assumed quiet.
    """
    def foreign(process):
        for line in (process / 'status').read_text().splitlines():
            if line.startswith('Uid:'):
                real, effective = map(int, line.split()[1:3])
                return real != os.getuid() or effective != os.geteuid()
        raise PermissionError(f'{process}: no Uid line')

    for process in Path('/proc').iterdir():
        if not process.name.isdigit():
            continue
        deadline, unreadable = time.monotonic() + grace, False
        while True:
            try:
                if not unreadable and process.stat().st_uid != os.geteuid():
                    break
                inspect(process)
                break
            except (FileNotFoundError, ProcessLookupError):
                break
            except PermissionError:
                unreadable = True
                try:
                    if foreign(process):
                        break
                except (FileNotFoundError, ProcessLookupError):
                    break
                except PermissionError:
                    pass  # An unreadable status proves nothing either; keep re-observing to the deadline.
                if time.monotonic() >= deadline:
                    refuse(process.name)
                    raise PermissionError(f'/proc/{process.name}: unverifiable')  # refuse must raise
                time.sleep(0.05)

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


def run_command(argv, *, cwd, env, output, timeout, input_path=None, stderr_output=None,
                owned_lifecycle=False, retain_owned=None):
    """``retain_owned()`` is asked before the group KILL; truthy means a token-owned
    benchmark controller is still running its own cleanup and its supervisor's
    token-bound teardown owns the escalation, so the group is left (and reported lingering)."""
    if owned_lifecycle:
        if sys.platform != "linux":
            raise OSError("owned worker lifecycle requires Linux")
        return run_owned(argv, cwd=cwd, env=env, output=output, timeout=timeout,
                         input_path=input_path, stderr_output=stderr_output)
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
    forced = False
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
                if retain_owned is not None and retain_owned():
                    break
                forced = True
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
    return proc.returncode, timed_out, CANCEL.is_set(), lingering or forced


def run_owned(argv, *, cwd, env, output, timeout, input_path, stderr_output):
    """Supervise the whole worker, allowing its setup/services to live until cleanup."""
    name = getattr(output, 'name', None)
    if isinstance(name, str) and Path(name).is_absolute():
        receipt = Path(name + '.process.json')
    else:
        folder = Path(tempfile.mkdtemp(prefix='deploy-process-', dir='/var/tmp'))
        receipt = folder / 'process.json'
    command = [sys.executable, '-B', str(Path(__file__).with_name('deploy_test_supervisor.py')),
               '--receipt', str(receipt)]
    deadline = None if timeout is None else time.monotonic() + timeout
    if deadline is not None:
        command += ['--deadline', str(deadline)]
    command += ['--', *argv]
    incoming = open(input_path, 'rb') if input_path else None
    try:
        proc = subprocess.Popen(command, cwd=cwd, env=env, stdin=incoming, stdout=output,
                                stderr=stderr_output if stderr_output is not None else subprocess.STDOUT,
                                start_new_session=True)
    finally:
        if incoming:
            incoming.close()
    cancelled = False
    cleanup_deadline = None if deadline is None else deadline + OWNED_DRAIN_SECONDS
    while proc.poll() is None:
        if CANCEL.is_set() and not cancelled:
            cancelled = True
            proc.terminate()  # The retained, unreaped supervisor owns descendant cleanup.
            cancel_limit = time.monotonic() + OWNED_DRAIN_SECONDS
            cleanup_deadline = cancel_limit if cleanup_deadline is None else min(cleanup_deadline, cancel_limit)
        if cleanup_deadline is not None and time.monotonic() >= cleanup_deadline:
            # A wedged supervisor cannot extend the gate indefinitely. Killing
            # this retained child says nothing about its descendants: fail closed.
            proc.kill()
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
            watchdog = receipt.with_name(receipt.name + '.watchdog.json')
            try:
                watchdog.write_text(json.dumps({
                    'supervisor_pid': proc.pid, 'supervisor_reaped': proc.returncode is not None,
                    'descendants_quiescent': False, 'deadline': deadline, 'cancelled': cancelled,
                    'reason': 'owned supervisor exceeded cleanup bound; descendants unverified',
                }, indent=2) + '\n')
            except OSError:
                pass  # Evidence failure must not erase the unknown cleanup outcome.
            try:
                output.write(f'owned supervisor cleanup unverified: {watchdog}\n'.encode())
            except (OSError, ValueError):
                pass
            return (proc.returncode if proc.returncode is not None else 127,
                    deadline is not None and time.monotonic() >= deadline, cancelled, True)
        try:
            proc.wait(timeout=.1)
        except subprocess.TimeoutExpired:
            continue
    try:
        value = json.loads(receipt.read_text())
        if not isinstance(value, dict) or value.get('supervisor_pid') != proc.pid:
            raise ValueError('supervisor receipt identity mismatch')
        code = value['native_exit']
        if not isinstance(code, int):
            raise ValueError('supervisor did not observe a native exit')
        lingering = (value.get('quiescent') is not True or bool(value.get('kill_sent'))
                     or value.get('orphaned_children') is True or bool(value.get('error')))
        return code, bool(value.get('timed_out')), cancelled or bool(value.get('cancelled')), lingering
    except (OSError, ValueError, KeyError, TypeError):
        return proc.returncode or 127, deadline is not None and time.monotonic() >= deadline, cancelled, True
