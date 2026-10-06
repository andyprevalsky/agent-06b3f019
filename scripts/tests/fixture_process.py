"""Native-identity cleanup for descendants of a still-owned local test process."""

import importlib.util
import os
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]


def load_process_identity():
    spec = importlib.util.spec_from_file_location("boot_fixture_process_identity", ROOT / "scripts/process-identity.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def terminate_fixture_tree(process: subprocess.Popen, *, identity=None) -> bool:
    """Reap a live owned root's snapshot; return false if ancestry is lost."""
    if process.poll() is not None:
        return False
    table = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,lstart="], check=True, capture_output=True, text=True
    ).stdout
    records = {}
    children = {}
    for raw in table.splitlines():
        if not raw.strip():
            continue
        pid_text, parent_text, birth = raw.split(None, 2)
        pid, parent = int(pid_text), int(parent_text)
        assert pid not in records and birth.strip(), "ambiguous fixture process identity"
        records[pid] = (parent, " ".join(birth.split()))
        children.setdefault(parent, []).append(pid)
    # Popen still owns the root; a numeric PID read from a stale file does not.
    if process.poll() is not None:
        return False
    assert records.get(process.pid, (None,))[0] == os.getpid(), "fixture root ownership changed"
    targets = []
    identity = identity or load_process_identity()

    def collect(pid: int) -> None:
        try:
            birth = identity.current_identity(pid)
        except (OSError, ValueError, IndexError):
            observed = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True)
            assert (observed.returncode == 1 and not observed.stdout.strip()) or observed.stdout.strip().startswith("Z")
            return
        ancestry = subprocess.run(
            ["ps", "-p", str(pid), "-o", "ppid=,lstart="], capture_output=True, text=True
        )
        if ancestry.returncode == 1 and not ancestry.stdout.strip():
            return
        fields = ancestry.stdout.split(None, 1)
        assert ancestry.returncode == 0 and len(fields) == 2, "fixture ancestry inspection failed"
        assert (int(fields[0]), " ".join(fields[1].split())) == records[pid], "fixture ancestry changed"
        targets.append((pid, birth))
        for child_pid in children.get(pid, []):
            collect(child_pid)

    def same_birth_live(pid: int, birth: str) -> bool:
        observed = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True)
        if observed.returncode == 1 and not observed.stdout.strip():
            return False
        assert observed.returncode == 0 and observed.stdout.strip(), "fixture process inspection failed"
        if observed.stdout.strip().startswith("Z"):
            return False
        try:
            return identity.current_identity(pid) == birth
        except (OSError, ValueError, IndexError):
            # A target can finish between ps and the native identity syscall.
            absent = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True)
            assert (absent.returncode == 1 and not absent.stdout.strip()) or absent.stdout.strip().startswith("Z")
            return False

    collect(process.pid)
    # Capture first, then stop parents before children so reparenting cannot
    # lose a detached benchmark or let a waiting launcher start more work.
    for pid, birth in targets:
        # Reuse the OS-native check-and-signal critical section. ps lstart is
        # second-resolution and cannot distinguish same-second PID reuse.
        result = identity.main(["process-identity.py", "--expect", birth, "--signal", "KILL", str(pid)])
        if result != identity.EXIT_OK:
            assert not same_birth_live(pid, birth), "fixture identity could not be signalled safely"
    process.wait(timeout=2)
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline and any(same_birth_live(pid, birth) for pid, birth in targets):
        time.sleep(0.02)
    assert not any(same_birth_live(pid, birth) for pid, birth in targets), "fixture descendants survived cleanup"
    return True
