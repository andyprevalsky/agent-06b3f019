#!/usr/bin/env python3
"""Print a collision-resistant, OS-native identity for one live process."""

from __future__ import annotations

import ctypes
import platform
import sys
from pathlib import Path


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


def darwin_identity(pid: int) -> str:
    proc_pidt_bsdinfo = 3
    libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
    libproc.proc_pidinfo.argtypes = [
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_uint64,
        ctypes.c_void_p,
        ctypes.c_int,
    ]
    libproc.proc_pidinfo.restype = ctypes.c_int

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


def main() -> int:
    if len(sys.argv) != 2:
        return 2
    try:
        pid = int(sys.argv[1])
        if pid <= 0:
            return 1
        system = platform.system()
        if system == "Linux":
            identity = linux_identity(pid)
        elif system == "Darwin":
            identity = darwin_identity(pid)
        else:
            return 1
    except (OSError, ValueError, IndexError):
        return 1

    print(identity)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
