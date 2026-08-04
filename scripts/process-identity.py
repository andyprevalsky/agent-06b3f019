#!/usr/bin/env python3
"""Collision-resistant, OS-native identity for one live process.

Two modes:

  process-identity.py PID
      Print the process birth identity.

  process-identity.py --expect IDENTITY --signal SIG PID
      Re-read the identity and, only if it still equals IDENTITY, deliver SIG —
      both inside this single process, with nothing between the identity read
      and kill(2) but a string comparison. See ``signal_if_same_identity`` in
      scripts/kill-services.sh for why this is a narrowed window and not an
      atomic operation: POSIX kill(2) addresses a PID, not a process instance.

Exit codes: 0 ok, 1 identity unreadable, 2 usage, 3 identity mismatch (nothing
signaled), 4 identity matched but kill(2) failed.
"""

from __future__ import annotations

import ctypes
import os
import platform
import signal as signal_module
import sys
from pathlib import Path

EXIT_OK = 0
EXIT_UNKNOWN_IDENTITY = 1
EXIT_USAGE = 2
EXIT_IDENTITY_MISMATCH = 3
EXIT_SIGNAL_FAILED = 4


def linux_identity(pid: int) -> str:
    stat = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
    close_paren = stat.rfind(")")
    if close_paren < 0:
        raise ValueError("malformed /proc stat")

    recorded_pid = int(stat[: stat.find(" ")])
    fields_after_comm = stat[close_paren + 2 :].split()
    # /proc/<pid>/stat field 22 is the process start time in clock ticks since boot.
    start_ticks = int(fields_after_comm[19])
    boot_id = Path("/proc/sys/kernel/random/boot_id").read_text(encoding="ascii").strip()
    if recorded_pid != pid or start_ticks <= 0 or not boot_id:
        raise ValueError("invalid /proc process identity")
    return f"linux:{boot_id}:{start_ticks}"


class ProcBSDInfo(ctypes.Structure):
    """Darwin's proc_bsdinfo from <sys/proc_info.h>."""

    _fields_ = [
        ("pbi_flags", ctypes.c_uint32),
        ("pbi_status", ctypes.c_uint32),
        ("pbi_xstatus", ctypes.c_uint32),
        ("pbi_pid", ctypes.c_uint32),
        ("pbi_ppid", ctypes.c_uint32),
        ("pbi_uid", ctypes.c_uint32),
        ("pbi_gid", ctypes.c_uint32),
        ("pbi_ruid", ctypes.c_uint32),
        ("pbi_rgid", ctypes.c_uint32),
        ("pbi_svuid", ctypes.c_uint32),
        ("pbi_svgid", ctypes.c_uint32),
        ("rfu_1", ctypes.c_uint32),
        ("pbi_comm", ctypes.c_char * 16),
        ("pbi_name", ctypes.c_char * 32),
        ("pbi_nfiles", ctypes.c_uint32),
        ("pbi_pgid", ctypes.c_uint32),
        ("pbi_pjobc", ctypes.c_uint32),
        ("e_tdev", ctypes.c_uint32),
        ("e_tpgid", ctypes.c_uint32),
        ("pbi_nice", ctypes.c_int32),
        ("pbi_start_tvsec", ctypes.c_uint64),
        ("pbi_start_tvusec", ctypes.c_uint64),
    ]


_LIBPROC: ctypes.CDLL | None = None


def _libproc() -> ctypes.CDLL:
    """Load and memoize libproc so the dlopen cost is paid before, never inside,
    the check-and-signal critical section."""
    global _LIBPROC
    if _LIBPROC is None:
        libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
        libproc.proc_pidinfo.argtypes = [
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_uint64,
            ctypes.c_void_p,
            ctypes.c_int,
        ]
        libproc.proc_pidinfo.restype = ctypes.c_int
        _LIBPROC = libproc
    return _LIBPROC


def darwin_identity(pid: int) -> str:
    proc_pidt_bsdinfo = 3
    libproc = _libproc()

    info = ProcBSDInfo()
    expected_size = ctypes.sizeof(info)
    actual_size = libproc.proc_pidinfo(
        pid, proc_pidt_bsdinfo, 0, ctypes.byref(info), expected_size
    )
    if (
        actual_size != expected_size
        or info.pbi_pid != pid
        or info.pbi_start_tvsec <= 0
        or info.pbi_start_tvusec >= 1_000_000
    ):
        raise ValueError("proc_pidinfo could not validate process identity")
    return f"darwin:{info.pbi_start_tvsec}:{info.pbi_start_tvusec:06d}"


def current_identity(pid: int) -> str:
    system = platform.system()
    if system == "Linux":
        return linux_identity(pid)
    if system == "Darwin":
        return darwin_identity(pid)
    raise ValueError(f"unsupported platform: {system}")


def resolve_signal(name: str) -> int | None:
    if name.isdigit():
        number = int(name)
        return number if 0 <= number < signal_module.NSIG else None
    candidate = name if name.startswith("SIG") else f"SIG{name}"
    value = getattr(signal_module, candidate, None)
    if isinstance(value, signal_module.Signals):
        return int(value)
    return None


def parse_args(argv: list[str]) -> tuple[int, str | None, str | None] | None:
    expect: str | None = None
    signal_name: str | None = None
    positional: list[str] = []

    index = 1
    while index < len(argv):
        argument = argv[index]
        if argument in ("--expect", "--signal"):
            index += 1
            if index >= len(argv):
                return None
            if argument == "--expect":
                expect = argv[index]
            else:
                signal_name = argv[index]
        elif argument.startswith("-"):
            return None
        else:
            positional.append(argument)
        index += 1

    # --expect and --signal are meaningless apart: validating without signaling
    # is the plain identity mode, and signaling without validating is exactly
    # the unguarded kill this helper exists to prevent.
    if len(positional) != 1 or (expect is None) != (signal_name is None):
        return None
    try:
        pid = int(positional[0])
    except ValueError:
        return None
    return pid, expect, signal_name


def main(argv: list[str]) -> int:
    parsed = parse_args(argv)
    if parsed is None:
        return EXIT_USAGE
    pid, expect, signal_name = parsed
    if pid <= 0:
        return EXIT_UNKNOWN_IDENTITY

    if signal_name is None:
        try:
            identity = current_identity(pid)
        except (OSError, ValueError, IndexError):
            return EXIT_UNKNOWN_IDENTITY
        print(identity)
        return EXIT_OK

    signal_number = resolve_signal(signal_name)
    if signal_number is None:
        return EXIT_USAGE

    if platform.system() == "Darwin":
        # Warm the dlopen/prototype setup outside the critical section below.
        try:
            _libproc()
        except OSError:
            return EXIT_UNKNOWN_IDENTITY

    # ── check-and-signal critical section ────────────────────────────────────
    # These three statements are deliberately adjacent: the identity read and
    # kill(2) are back-to-back syscalls in one process with no I/O, allocation
    # of new resources, subprocess spawn, or shell round trip between them. That
    # is the narrowest window reachable without a pidfd/process handle, which
    # neither bash nor portable POSIX exposes. The window is narrowed, not
    # closed — the PID can still be recycled between these two lines.
    try:
        identity = current_identity(pid)
    except (OSError, ValueError, IndexError):
        return EXIT_UNKNOWN_IDENTITY
    if identity != expect:
        return EXIT_IDENTITY_MISMATCH
    try:
        os.kill(pid, signal_number)
    except OSError:
        return EXIT_SIGNAL_FAILED
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
