"""Run guest-payload tests under an interpreter with the guest's pidfd API.

Controller guest payloads (orphan drain, relay retirement, disposable Hub
finalization) signal owners only through os.pidfd_open/signal.pidfd_send_signal,
so a recycled PID is never signalled. They run on the controller image's system
python3, which has both. The tests execute that same guest code in-process, but
`scripts/test.sh` calls whatever `python3` is first on PATH, and the documented
agents/venv (a uv standalone CPython build) is compiled without either API.

Re-execute the test file under the first pidfd-capable python3 instead of
weakening the guest's ownership checks; fail loudly when none exists. Linux only:
other platforms keep their current behaviour (these guests never run there).
"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys

OVERRIDE_ENV = "CLOUDBENCH_PIDFD_PYTHON"
REEXEC_MARKER_ENV = "CLOUDBENCH_PIDFD_REEXEC"
PROBE = "import os,signal,sys;sys.exit(0 if hasattr(os,'pidfd_open') and hasattr(signal,'pidfd_send_signal') else 1)"


def has_pidfd() -> bool:
    return hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal")


def candidates() -> list[str]:
    seen, found = set(), []
    override = os.environ.get(OVERRIDE_ENV)
    names = [override] if override else []
    names += ["/usr/bin/python3", "/usr/local/bin/python3"]
    names += [os.path.join(entry, "python3") for entry in os.environ.get("PATH", "").split(os.pathsep) if entry]
    for name in names:
        path = shutil.which(name) if name else None
        if path is None:
            continue
        path = os.path.abspath(path)
        # Each candidate is probed in a fresh process, so the current interpreter is
        # only chosen when it really has pidfd; the re-exec marker prevents loops.
        if path in seen:
            continue
        seen.add(path)
        found.append(path)
    return found


def capable(path: str) -> bool:
    try:
        return subprocess.run([path, "-I", "-S", "-c", PROBE], timeout=10).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def require_pidfd_interpreter(script: str) -> None:
    """Return when this interpreter has pidfd; otherwise exec the script under one that does."""
    if not sys.platform.startswith("linux") or has_pidfd():
        return
    if os.environ.get(REEXEC_MARKER_ENV) == "1":
        raise SystemExit(f"pidfd re-exec landed on {sys.executable}, which still lacks os.pidfd_open")
    for path in candidates():
        if capable(path):
            print(f"pidfd_interpreter: {sys.executable} lacks os.pidfd_open; re-running under {path}",
                  file=sys.stderr, flush=True)
            os.environ[REEXEC_MARKER_ENV] = "1"
            os.execv(path, [path, os.path.abspath(script), *sys.argv[1:]])
    raise SystemExit(
        f"{sys.executable} lacks os.pidfd_open/signal.pidfd_send_signal and no pidfd-capable python3 was found; "
        f"install the system python3 or set {OVERRIDE_ENV} to one (the controller guest image provides both)"
    )
