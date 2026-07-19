#!/usr/bin/env python3
"""Run a command in its own process group while teeing output safely."""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path


FORWARDED_SIGNALS = (signal.SIGHUP, signal.SIGINT, signal.SIGTERM)
CLEANUP_GRACE_SECONDS = 60


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("log", type=Path)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    return parser


def main() -> int:
    args = _parser().parse_args()
    command = list(args.command)
    if command and command[0] == "--":
        command.pop(0)
    if not command:
        print("run_logged_command.py: command is required", file=sys.stderr)
        return 2

    args.log.parent.mkdir(parents=True, exist_ok=True)
    received_signal = 0
    child: subprocess.Popen[bytes] | None = None
    kill_timer_started = False

    def force_kill_after_grace() -> None:
        time.sleep(CLEANUP_GRACE_SECONDS)
        if child is not None and child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def forward(signum: int, _frame: object) -> None:
        nonlocal kill_timer_started, received_signal
        received_signal = received_signal or signum
        if child is None or child.poll() is not None:
            return
        try:
            os.killpg(child.pid, signum)
        except ProcessLookupError:
            return
        if not kill_timer_started:
            kill_timer_started = True
            threading.Thread(target=force_kill_after_grace, daemon=True).start()

    for forwarded_signal in FORWARDED_SIGNALS:
        signal.signal(forwarded_signal, forward)

    child_exit = 127
    try:
        with args.log.open("wb") as log_handle:
            if received_signal:
                return 128 + received_signal
            try:
                child = subprocess.Popen(
                    command,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
            except OSError as exc:
                print(f"could not start command: {exc}", file=sys.stderr)
                return 127
            if received_signal:
                forward(received_signal, None)

            assert child.stdout is not None
            while True:
                try:
                    chunk = os.read(child.stdout.fileno(), 65536)
                except InterruptedError:
                    continue
                if not chunk:
                    break
                log_handle.write(chunk)
                log_handle.flush()
                try:
                    sys.stdout.buffer.write(chunk)
                    sys.stdout.buffer.flush()
                except BrokenPipeError:
                    pass
            child_exit = child.wait()
    finally:
        if child is not None and child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=CLEANUP_GRACE_SECONDS)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait()
    if received_signal:
        return 128 + received_signal
    if child_exit < 0:
        return 128 - child_exit
    return child_exit


if __name__ == "__main__":
    raise SystemExit(main())
