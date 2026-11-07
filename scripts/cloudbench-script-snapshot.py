#!/usr/bin/env python3
"""Exact-owner lifecycle for run-bench-fleet's immutable script snapshot."""

from __future__ import annotations

import argparse
import fcntl
import json
import math
import os
import signal
import shutil
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


MARKER_NAME = ".cloudbench-script-snapshot-owner.json"
LOCK_NAME = ".cloudbench-script-snapshot-owner.lock"
STATE_EXIT_CODES = {
    "armed": 0,
    "pending": 10,
    "stale-cleaned": 11,
    "absent": 12,
    "unclaimed": 13,
    "signaled": 14,
}


class SnapshotOwnershipError(RuntimeError):
    pass


def _pid_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _proc_identity_state(pid: int, expected_start: str) -> str:
    """Match the boot-relative /proc identity minted by run-bench-fleet on Linux.

    Linux ``ps -o lstart`` shifts with wall-clock steps (for example a VM
    snapshot fork), so the shell owner records the /proc start tick instead.
    """
    try:
        boot_id = (
            Path("/proc/sys/kernel/random/boot_id").read_text(encoding="utf-8").strip()
        )
        stat = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return "absent" if not _pid_exists(pid) else "unknown"
    except OSError:
        return "unknown" if _pid_exists(pid) else "absent"
    fields = stat[stat.rfind(")") + 2 :].split()
    if not boot_id or len(fields) <= 19 or not fields[19].isdigit():
        return "unknown"
    actual_start = f"proc-start:{boot_id}:{fields[19]}"
    return "match" if actual_start == expected_start.strip() else "mismatch"


def _process_identity_state(pid: int, expected_start: str) -> str:
    """Return match, mismatch, absent, or unknown without conflating ps failure."""

    if not expected_start:
        return "mismatch"
    if not _pid_exists(pid):
        return "absent"
    if expected_start.startswith("proc-start:"):
        return _proc_identity_state(pid, expected_start)
    try:
        result = subprocess.run(
            ["ps", "-p", str(pid), "-o", "lstart="],
            check=False,
            capture_output=True,
            text=True,
            timeout=1,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "unknown" if _pid_exists(pid) else "absent"
    if result.returncode != 0 or not result.stdout.strip():
        return "unknown" if _pid_exists(pid) else "absent"
    actual_start = " ".join(result.stdout.split())
    return "match" if actual_start == " ".join(expected_start.split()) else "mismatch"


def _process_matches(pid: int, expected_start: str) -> bool:
    return _process_identity_state(pid, expected_start) == "match"


def _stale_owner_state(pid: int, expected_start: str) -> bool:
    state = _process_identity_state(pid, expected_start)
    if state == "unknown":
        raise SnapshotOwnershipError("snapshot owner process identity is unknown")
    return state in {"absent", "mismatch"}


def _validate_path(path: Path, temp_root: Path, token: str) -> None:
    if len(token) != 32 or any(char not in "0123456789abcdef" for char in token):
        raise SnapshotOwnershipError("invalid snapshot owner token")
    try:
        parent = path.parent.resolve(strict=True)
        expected_parent = temp_root.resolve(strict=True)
    except OSError as exc:
        raise SnapshotOwnershipError(
            f"could not resolve snapshot parent: {exc}"
        ) from exc
    if parent != expected_parent:
        raise SnapshotOwnershipError("snapshot is outside its exact temp root")
    if not path.name.startswith("cloudbench-scripts."):
        raise SnapshotOwnershipError("snapshot basename is outside the owned prefix")
    suffix = path.name[len("cloudbench-scripts.") :]
    legacy_suffix = len(suffix) == 6 and all(
        char in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        for char in suffix
    )
    token_derived_suffix = suffix == token
    if not legacy_suffix and not token_derived_suffix:
        raise SnapshotOwnershipError("snapshot basename has an invalid mktemp suffix")


def _read_marker(path: Path, token: str) -> dict[str, object]:
    try:
        marker = json.loads((path / MARKER_NAME).read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise SnapshotOwnershipError(
            f"snapshot owner marker is unreadable: {exc}"
        ) from exc
    if not isinstance(marker, dict) or marker.get("version") != 1:
        raise SnapshotOwnershipError("snapshot owner marker has an invalid version")
    if marker.get("token") != token:
        raise SnapshotOwnershipError("snapshot owner marker token does not match")
    owner_pid = marker.get("owner_pid")
    owner_start = marker.get("owner_pid_start")
    state = marker.get("state")
    if not isinstance(owner_pid, int) or owner_pid <= 0:
        raise SnapshotOwnershipError("snapshot owner marker PID is invalid")
    if not isinstance(owner_start, str) or not owner_start:
        raise SnapshotOwnershipError(
            "snapshot owner marker PID birth identity is invalid"
        )
    if state not in {"claiming", "armed"}:
        raise SnapshotOwnershipError("snapshot owner marker state is invalid")
    return marker


def _write_marker(path: Path, marker: dict[str, object]) -> None:
    target = path / MARKER_NAME
    temporary = path / f"{MARKER_NAME}.tmp.{os.getpid()}"
    try:
        temporary.write_text(json.dumps(marker, sort_keys=True) + "\n")
        if os.environ.get("CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_FAIL_REPLACE") == "1":
            raise OSError("injected owner-marker replace failure")
        os.replace(temporary, target)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _lock_timeout_seconds() -> float:
    raw = os.environ.get("CLOUDBENCH_SCRIPT_SNAPSHOT_LOCK_SECONDS", "1")
    try:
        timeout = float(raw)
    except ValueError as exc:
        raise SnapshotOwnershipError(
            "snapshot lock seconds must be a positive number"
        ) from exc
    if not math.isfinite(timeout) or timeout <= 0 or timeout > 30:
        raise SnapshotOwnershipError(
            "snapshot lock seconds must be greater than zero and at most 30"
        )
    return timeout


@contextmanager
def _snapshot_lock(path: Path, hook_scope: str = "") -> Iterator[None]:
    lock_path = path / LOCK_NAME
    try:
        handle = lock_path.open("a+")
    except OSError as exc:
        raise SnapshotOwnershipError(
            f"could not open exact snapshot lock: {exc}"
        ) from exc
    try:
        scoped_prefix = (
            f"CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_{hook_scope}_LOCK"
            if hook_scope
            else "CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_LOCK"
        )
        generic_prefix = "CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_LOCK"

        def hook_path(suffix: str) -> str | None:
            scoped = os.environ.get(f"{scoped_prefix}_{suffix}")
            if scoped is not None or not hook_scope:
                return scoped
            return os.environ.get(f"{generic_prefix}_{suffix}")

        waiting_path = hook_path("WAITING")
        if waiting_path:
            Path(waiting_path).write_text("waiting\n")
        deadline = time.monotonic() + _lock_timeout_seconds()
        while True:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError as exc:
                if time.monotonic() >= deadline:
                    raise SnapshotOwnershipError(
                        "timed out acquiring exact snapshot lifecycle lock"
                    ) from exc
                time.sleep(0.01)
        ready_path = hook_path("READY")
        release_path = hook_path("RELEASE")
        if ready_path:
            Path(ready_path).write_text("ready\n")
        while release_path and not Path(release_path).exists():
            time.sleep(0.01)
        yield
    finally:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()


def initialize(
    path: Path, temp_root: Path, token: str, pid: int, pid_start: str
) -> None:
    _validate_path(path, temp_root, token)
    if os.getppid() != pid or not _process_matches(pid, pid_start):
        raise SnapshotOwnershipError(
            "initializer PID birth identity does not match caller"
        )
    with _snapshot_lock(path):
        _write_marker(
            path,
            {
                "version": 1,
                "token": token,
                "owner_pid": pid,
                "owner_pid_start": " ".join(pid_start.split()),
                "state": "armed",
            },
        )


def _remove_snapshot(path: Path) -> None:
    """Remove a snapshot so no observer ever sees it half deleted.

    rmtree unlinks the helper before the directory, so a peer that checked the
    path between the two (the launcher's handoff poll or its EXIT cleanup, which
    run this helper from inside the snapshot) found the directory without its
    helper and reported a failed removal. Renaming first makes the path vanish
    in one step; the private tombstone is then deleted.
    """

    tombstone = path.with_name(f".{path.name}.removing-{os.getpid()}")
    os.rename(path, tombstone)
    shutil.rmtree(tombstone)


def _remove_unadopted_snapshot(path: Path) -> None:
    """Remove the helper-created path while serialized with parent cleanup."""

    if not path.exists():
        return
    with _snapshot_lock(path):
        if path.exists():
            _remove_snapshot(path)


def create(path: Path, temp_root: Path, token: str, pid: int, pid_start: str) -> Path:
    """Create and retain responsibility until the guarded shell acknowledges it."""

    if len(token) != 32 or any(char not in "0123456789abcdef" for char in token):
        raise SnapshotOwnershipError("invalid snapshot owner token")
    if os.getppid() != pid or not _process_matches(pid, pid_start):
        raise SnapshotOwnershipError("creator PID birth identity does not match caller")
    _validate_path(path, temp_root, token)
    try:
        resolved_root = temp_root.resolve(strict=True)
    except OSError as exc:
        raise SnapshotOwnershipError(
            f"could not resolve snapshot temp root: {exc}"
        ) from exc
    if not resolved_root.is_dir():
        raise SnapshotOwnershipError("snapshot temp root is not a directory")

    pending_signal: list[str] = []

    def defer_signal(signum: int, _frame: object) -> None:
        if not pending_signal:
            pending_signal.append(signal.Signals(signum).name)

    for signal_name in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(signal_name, defer_signal)

    normalized_pid_start = " ".join(pid_start.split())
    result_path = resolved_root / f".cloudbench-script-snapshot-create.{pid}.{token}"
    adoption_path = resolved_root / f".cloudbench-script-snapshot-adopt.{pid}.{token}"
    result_temporary = resolved_root / f"{result_path.name}.tmp.{os.getpid()}"
    adopted = False
    try:
        if result_path.exists() or adoption_path.exists():
            raise SnapshotOwnershipError("snapshot creation rendezvous already exists")
        if path.name != f"cloudbench-scripts.{token}":
            raise SnapshotOwnershipError(
                "creator path is not derived from its owner token"
            )
        path.mkdir(mode=0o700)

        # Cleanup must already be executable when the shell learns the path.
        # Seed this helper before owner publication; the remaining immutable
        # scripts can be copied after the shell arms its early EXIT guard.
        shutil.copy2(Path(__file__), path / Path(__file__).name)
        if pending_signal:
            raise SnapshotOwnershipError(
                f"snapshot creation interrupted by {pending_signal[0]}"
            )

        ready_path = os.environ.get("CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_INIT_READY")
        release_path = os.environ.get("CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_INIT_RELEASE")
        if ready_path:
            Path(ready_path).write_text(f"{os.getpid()}\n")
        while release_path and not Path(release_path).exists() and not pending_signal:
            time.sleep(0.01)
        if pending_signal:
            raise SnapshotOwnershipError(
                f"snapshot creation interrupted by {pending_signal[0]}"
            )

        initialize(path, resolved_root, token, pid, pid_start)
        if pending_signal:
            raise SnapshotOwnershipError(
                f"snapshot creation interrupted by {pending_signal[0]}"
            )
        with result_temporary.open("x") as result_handle:
            published_path = (
                ""
                if os.environ.get("CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_INVALID_RESULT")
                == "1"
                else str(path)
            )
            result_handle.write(f"{published_path}\n")
            result_handle.write(f"{pending_signal[0] if pending_signal else ''}\n")
            result_handle.flush()
            os.fsync(result_handle.fileno())
        if os.environ.get("CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_FAIL_RESULT_REPLACE") == "1":
            raise OSError("injected snapshot-result replace failure")
        os.replace(result_temporary, result_path)

        adoption_seconds_raw = os.environ.get(
            "CLOUDBENCH_SCRIPT_SNAPSHOT_ADOPTION_SECONDS", "30"
        )
        try:
            adoption_seconds = int(adoption_seconds_raw)
        except ValueError as exc:
            raise SnapshotOwnershipError(
                "snapshot adoption seconds must be a positive integer"
            ) from exc
        if adoption_seconds <= 0:
            raise SnapshotOwnershipError(
                "snapshot adoption seconds must be a positive integer"
            )
        deadline = time.monotonic() + adoption_seconds
        expected_adoption = [str(path), token, str(pid), normalized_pid_start]
        while time.monotonic() < deadline:
            if pending_signal:
                raise SnapshotOwnershipError(
                    f"snapshot adoption interrupted by {pending_signal[0]}"
                )
            if os.getppid() != pid:
                raise SnapshotOwnershipError(
                    "snapshot creator's parent vanished before adoption"
                )
            try:
                observed_adoption = adoption_path.read_text().splitlines()
            except FileNotFoundError:
                time.sleep(0.01)
                continue
            if observed_adoption != expected_adoption:
                raise SnapshotOwnershipError(
                    "snapshot adoption acknowledgement does not match creation"
                )
            adopted = True
            break
        if not adopted:
            raise SnapshotOwnershipError("snapshot adoption acknowledgement timed out")
        return path
    finally:
        try:
            result_temporary.unlink()
        except FileNotFoundError:
            pass
        if not adopted:
            try:
                result_path.unlink()
            except FileNotFoundError:
                pass
            try:
                adoption_path.unlink()
            except FileNotFoundError:
                pass
            _remove_unadopted_snapshot(path)


def recover_create(
    path: Path, temp_root: Path, token: str, pid: int, pid_start: str
) -> str:
    """Recover the token-derived path after hard loss of its creator helper."""

    _validate_path(path, temp_root, token)
    if path.name != f"cloudbench-scripts.{token}":
        raise SnapshotOwnershipError(
            "recovery path is not derived from its owner token"
        )
    if os.getppid() != pid or not _process_matches(pid, pid_start):
        raise SnapshotOwnershipError(
            "recovery PID birth identity does not match caller"
        )
    if not path.exists():
        return "absent"
    with _snapshot_lock(path):
        if path.exists():
            _remove_snapshot(path)
    return "deleted"


def acknowledge_adoption(
    path: Path, temp_root: Path, token: str, pid: int, pid_start: str
) -> None:
    """Atomically acknowledge that the exact parent armed snapshot cleanup."""

    _validate_path(path, temp_root, token)
    normalized_pid_start = " ".join(pid_start.split())
    if os.getppid() != pid or not _process_matches(pid, normalized_pid_start):
        raise SnapshotOwnershipError(
            "adopting PID birth identity does not match caller"
        )
    with _snapshot_lock(path):
        marker = _read_marker(path, token)
        if (
            marker["owner_pid"] != pid
            or marker["owner_pid_start"] != normalized_pid_start
            or marker["state"] != "armed"
        ):
            raise SnapshotOwnershipError(
                "snapshot adoption does not match its armed owner marker"
            )

    resolved_root = temp_root.resolve(strict=True)
    adoption_path = resolved_root / f".cloudbench-script-snapshot-adopt.{pid}.{token}"
    adoption_temporary = resolved_root / f"{adoption_path.name}.tmp.{os.getpid()}"
    try:
        with adoption_temporary.open("x") as adoption_handle:
            adoption_handle.write(f"{path}\n{token}\n{pid}\n{normalized_pid_start}\n")
            adoption_handle.flush()
            os.fsync(adoption_handle.fileno())
        if (
            os.environ.get("CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_FAIL_ADOPTION_REPLACE")
            == "1"
        ):
            raise OSError("injected snapshot-adoption replace failure")
        os.replace(adoption_temporary, adoption_path)
    finally:
        try:
            adoption_temporary.unlink()
        except FileNotFoundError:
            pass


def claim(
    path: Path,
    temp_root: Path,
    token: str,
    pid: int,
    pid_start: str,
    previous_pid: int,
    previous_pid_start: str,
) -> None:
    _validate_path(path, temp_root, token)
    if os.getppid() != pid or not _process_matches(pid, pid_start):
        raise SnapshotOwnershipError(
            "claimant PID birth identity does not match caller"
        )
    with _snapshot_lock(path, "CLAIM"):
        marker = _read_marker(path, token)
        if marker["owner_pid"] != previous_pid or marker["owner_pid_start"] != " ".join(
            previous_pid_start.split()
        ):
            raise SnapshotOwnershipError("claim source owner identity does not match")
        _write_marker(
            path,
            {
                "version": 1,
                "token": token,
                "owner_pid": pid,
                "owner_pid_start": " ".join(pid_start.split()),
                "state": "claiming",
            },
        )


def arm(path: Path, temp_root: Path, token: str, pid: int, pid_start: str) -> None:
    _validate_path(path, temp_root, token)
    if os.getppid() != pid or not _process_matches(pid, pid_start):
        raise SnapshotOwnershipError("arming PID birth identity does not match caller")
    with _snapshot_lock(path):
        marker = _read_marker(path, token)
        if marker["owner_pid"] != pid or marker["owner_pid_start"] != " ".join(
            pid_start.split()
        ):
            raise SnapshotOwnershipError(
                "only the exact claimant can arm snapshot cleanup"
            )
        marker["state"] = "armed"
        _write_marker(path, marker)


def cleanup(
    path: Path,
    temp_root: Path,
    token: str,
    pid: int,
    pid_start: str,
    allow_transfer: bool,
) -> str:
    _validate_path(path, temp_root, token)
    if not path.exists():
        return "absent"
    if os.getppid() != pid:
        raise SnapshotOwnershipError("cleanup PID birth identity does not match caller")
    try:
        with _snapshot_lock(path):
            marker = _read_marker(path, token)
            expected_start = " ".join(pid_start.split())
            if (
                marker["owner_pid"] != pid
                or marker["owner_pid_start"] != expected_start
            ):
                if marker["owner_pid"] == pid:
                    raise SnapshotOwnershipError(
                        "current owner PID birth identity does not match marker"
                    )
                if allow_transfer:
                    if not _process_matches(pid, expected_start):
                        raise SnapshotOwnershipError(
                            "cleanup observer PID birth identity does not match caller"
                        )
                    if _stale_owner_state(
                        int(marker["owner_pid"]), str(marker["owner_pid_start"])
                    ):
                        _remove_snapshot(path)
                        return "stale-deleted"
                    return "transferred"
                raise SnapshotOwnershipError(
                    "snapshot ownership transferred to another live process"
                )
            _remove_snapshot(path)
    except SnapshotOwnershipError:
        if not path.exists():
            return "absent"
        raise
    return "deleted"


def check_armed(
    path: Path,
    temp_root: Path,
    token: str,
    previous_pid: int,
    previous_pid_start: str,
) -> str:
    _validate_path(path, temp_root, token)
    if not path.exists():
        return "absent"
    if os.getppid() != previous_pid or not _process_matches(
        previous_pid, previous_pid_start
    ):
        raise SnapshotOwnershipError("handoff observer identity does not match caller")
    try:
        with _snapshot_lock(path):
            marker = _read_marker(path, token)
            owner_pid = int(marker["owner_pid"])
            owner_start = str(marker["owner_pid_start"])
            if owner_pid == previous_pid:
                if owner_start != " ".join(previous_pid_start.split()):
                    raise SnapshotOwnershipError(
                        "previous owner PID birth identity does not match marker"
                    )
                return "pending"
            if _stale_owner_state(owner_pid, owner_start):
                _remove_snapshot(path)
                return "stale-cleaned"
            return "armed" if marker["state"] == "armed" else "pending"
    except SnapshotOwnershipError:
        if not path.exists():
            return "absent"
        raise


def cancel_claim(
    path: Path,
    temp_root: Path,
    token: str,
    previous_pid: int,
    previous_pid_start: str,
) -> str:
    """Cancel a claimant that failed to arm within the bounded handoff.

    Signal while holding the lifecycle lock. A claimant still between `claim`
    and `arm` cannot race this decision: its deferred TERM is replayed only
    after its EXIT cleanup is armed. If it armed first, leave the controller
    alone and report the completed transfer.
    """

    _validate_path(path, temp_root, token)
    if not path.exists():
        return "absent"
    if os.getppid() != previous_pid or not _process_matches(
        previous_pid, previous_pid_start
    ):
        raise SnapshotOwnershipError("handoff canceller identity does not match caller")
    try:
        with _snapshot_lock(path):
            marker = _read_marker(path, token)
            owner_pid = int(marker["owner_pid"])
            owner_start = str(marker["owner_pid_start"])
            expected_previous_start = " ".join(previous_pid_start.split())
            if owner_pid == previous_pid:
                if owner_start != expected_previous_start:
                    raise SnapshotOwnershipError(
                        "previous owner PID birth identity does not match marker"
                    )
                return "unclaimed"
            if marker["state"] == "armed":
                return "armed"
            if _stale_owner_state(owner_pid, owner_start):
                _remove_snapshot(path)
                return "stale-cleaned"
            os.kill(owner_pid, signal.SIGTERM)
            return "signaled"
    except SnapshotOwnershipError:
        if not path.exists():
            return "absent"
        raise


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    create_parser = subparsers.add_parser("create")
    create_parser.add_argument("--path", type=Path, required=True)
    create_parser.add_argument("--temp-root", type=Path, required=True)
    create_parser.add_argument("--token", required=True)
    create_parser.add_argument("--pid", type=int, required=True)
    create_parser.add_argument("--pid-start", required=True)
    for command in (
        "adopt",
        "recover-create",
        "initialize",
        "claim",
        "arm",
        "cleanup",
        "check-armed",
        "cancel-claim",
    ):
        subparser = subparsers.add_parser(command)
        subparser.add_argument("--path", type=Path, required=True)
        subparser.add_argument("--temp-root", type=Path, required=True)
        subparser.add_argument("--token", required=True)
        if command in {
            "adopt",
            "recover-create",
            "initialize",
            "claim",
            "arm",
            "cleanup",
        }:
            subparser.add_argument("--pid", type=int, required=True)
            subparser.add_argument("--pid-start", required=True)
        if command == "cleanup":
            subparser.add_argument("--allow-transfer", action="store_true")
        if command in {"claim", "check-armed", "cancel-claim"}:
            subparser.add_argument("--previous-pid", type=int, required=True)
            subparser.add_argument("--previous-pid-start", required=True)
    return parser


def main() -> int:
    args = _parser().parse_args()
    try:
        if args.command == "create":
            create(args.path, args.temp_root, args.token, args.pid, args.pid_start)
            result = "created"
        elif args.command == "adopt":
            acknowledge_adoption(
                args.path, args.temp_root, args.token, args.pid, args.pid_start
            )
            result = "adopted"
        elif args.command == "recover-create":
            result = recover_create(
                args.path, args.temp_root, args.token, args.pid, args.pid_start
            )
        elif args.command == "initialize":
            initialize(args.path, args.temp_root, args.token, args.pid, args.pid_start)
            result = "initialized"
        elif args.command == "claim":
            claim(
                args.path,
                args.temp_root,
                args.token,
                args.pid,
                args.pid_start,
                args.previous_pid,
                args.previous_pid_start,
            )
            result = "claimed"
        elif args.command == "arm":
            arm(args.path, args.temp_root, args.token, args.pid, args.pid_start)
            result = "armed"
        elif args.command == "cleanup":
            result = cleanup(
                args.path,
                args.temp_root,
                args.token,
                args.pid,
                args.pid_start,
                args.allow_transfer,
            )
        elif args.command == "check-armed":
            result = check_armed(
                args.path,
                args.temp_root,
                args.token,
                args.previous_pid,
                args.previous_pid_start,
            )
        else:
            result = cancel_claim(
                args.path,
                args.temp_root,
                args.token,
                args.previous_pid,
                args.previous_pid_start,
            )
        print(result)
        if args.command in {"check-armed", "cancel-claim"}:
            return STATE_EXIT_CODES[result]
        return 0
    except (OSError, SnapshotOwnershipError) as exc:
        print(f"snapshot ownership error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
