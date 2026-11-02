#!/usr/bin/env python3
"""Own a complete staged worker lifetime, including nested sessions and cleanup."""
from __future__ import annotations

import argparse
import ctypes
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

# Preserve the existing ten-second TERM grace; reserve two seconds to reap after KILL.
TERM_GRACE_SECONDS = 10.0
DRAIN_SECONDS = 12.0


def supervise(command, receipt, deadline=None):
    if sys.platform != 'linux':
        raise RuntimeError('local suite supervision requires Linux')
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), 'could not enable suite subreaper')
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    stopped = False
    timed_out = False

    def stop(_signum, _frame):
        nonlocal stopped
        stopped = True

    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, stop)
    child = subprocess.Popen(command)
    native_exit = None
    drain_started = None
    orphaned = False
    term_sent = set()
    kill_sent = set()
    reaped = []
    quiescent = False
    error = None
    remaining = []
    children_path = Path(f'/proc/self/task/{os.getpid()}/children')

    def children():
        # One thread owns waitpid in this process. These unreaped direct children
        # cannot recycle their PIDs before we signal them, even after exit.
        result = [int(value) for value in children_path.read_text().split()]
        for pid in result:
            raw = Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()
            if int(raw[1]) != os.getpid():
                raise RuntimeError('suite child ownership changed')
        return result

    def reap():
        nonlocal native_exit
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return True
            if pid == 0:
                return False
            reaped.append({'pid': pid, 'status': status})
            if pid == child.pid:
                native_exit = os.waitstatus_to_exitcode(status)
                child.returncode = native_exit

    try:
        while True:
            if reap():
                quiescent = native_exit is not None
                break
            timed_out = timed_out or (deadline is not None and time.monotonic() >= deadline)
            remaining = children()
            orphaned = orphaned or (native_exit is not None and bool(remaining))
            if stopped or timed_out or native_exit is not None:
                now = time.monotonic()
                if drain_started is None:
                    drain_started = now
                for pid in remaining:
                    if pid not in term_sent:
                        os.kill(pid, signal.SIGTERM)
                        term_sent.add(pid)
                    if now - drain_started >= TERM_GRACE_SECONDS and pid not in kill_sent:
                        os.kill(pid, signal.SIGKILL)
                        kill_sent.add(pid)
                if now - drain_started >= DRAIN_SECONDS:
                    quiescent = reap()
                    if not quiescent:
                        remaining = children()
                    break
            time.sleep(0.02)
    except BaseException as exception:
        # Preserve failure and use the remaining bounded drain for exact owned
        # children. A failed observation can never produce a quiescent receipt.
        error = type(exception).__name__ + ': ' + str(exception)
        deadline = time.monotonic() + DRAIN_SECONDS
        while time.monotonic() < deadline:
            try:
                if reap():
                    break
                remaining = children()
                for pid in remaining:
                    os.kill(pid, signal.SIGKILL)
                    kill_sent.add(pid)
            except (OSError, RuntimeError):
                break
            time.sleep(0.02)
    result = dict(supervisor_pid=os.getpid(), child_pid=child.pid,
                  native_exit=native_exit, cancelled=stopped, timed_out=timed_out, quiescent=quiescent,
                  orphaned_children=orphaned, reaped=reaped,
                  term_sent=sorted(term_sent), kill_sent=sorted(kill_sent),
                  remaining=[] if quiescent else remaining, error=error)
    temporary = receipt.with_suffix('.tmp')
    temporary.write_text(json.dumps(result, indent=2) + '\n')
    temporary.replace(receipt)
    if not quiescent or error or stopped or timed_out or orphaned or kill_sent or native_exit is None:
        return 78
    return native_exit if native_exit >= 0 else 128 - native_exit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    parser.add_argument('--deadline', type=float)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        parser.error('suite command required')
    return supervise(command, args.receipt, args.deadline)


if __name__ == '__main__':
    raise SystemExit(main())
