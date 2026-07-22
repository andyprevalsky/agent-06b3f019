#!/usr/bin/env python3
"""Host-wide local-port leases for cloudbench controller transports.

The lease registry is serialized with fcntl.flock, so claim, stale-owner reap,
and release cannot interleave. Lease records are atomically published only
after their complete PID/start-identity/token payload is durable.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time


def _process_start_identity(pid: int) -> str | None:
    result = subprocess.run(
        ["ps", "-o", "lstart=", "-p", str(pid)],
        text=True,
        capture_output=True,
        check=False,
    )
    identity = " ".join(result.stdout.split())
    return identity or None


def _read_record(path: Path) -> dict[str, object] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    return value if isinstance(value, dict) else None


def _record_is_live(record: dict[str, object]) -> bool:
    try:
        pid = int(record["pid"])
        recorded_start = str(record["process_start"])
        token = str(record["token"])
    except (KeyError, TypeError, ValueError):
        return False
    return bool(token) and _process_start_identity(pid) == recorded_start


def _port_is_bindable(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def _candidate_ports(start: int) -> list[int]:
    if start > 0:
        if not 1024 <= start <= 65535:
            raise ValueError("preferred local port must be between 1024 and 65535")
        # Archived benchmark viewers are durable and can occupy hundreds of
        # consecutive ports. Search the complete user-port space, preserving
        # locality above the preferred port and wrapping only at 65535.
        return [*range(start, 65536), *range(1024, start)]
    candidates: list[int] = []
    for _ in range(100):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            port = int(sock.getsockname()[1])
        if port not in candidates:
            candidates.append(port)
    return candidates


class Registry:
    def __init__(self, root: Path) -> None:
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        self.lock_file = (root / ".lock").open("a+", encoding="utf-8")

    def __enter__(self) -> "Registry":
        fcntl.flock(self.lock_file.fileno(), fcntl.LOCK_EX)
        self._remove_interrupted_temps()
        return self

    def __exit__(self, *_: object) -> None:
        fcntl.flock(self.lock_file.fileno(), fcntl.LOCK_UN)
        self.lock_file.close()

    def _remove_interrupted_temps(self) -> None:
        for path in self.root.glob(".claim-*.tmp"):
            try:
                path.unlink()
            except FileNotFoundError:
                pass

    def _reap_stale(self) -> None:
        for path in self.root.iterdir():
            if not path.name.isdigit() or not path.is_file():
                continue
            record = _read_record(path)
            if record is None or not _record_is_live(record):
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass

    def claim(self, *, owner_pid: int, token: str, start: int) -> int:
        process_start = _process_start_identity(owner_pid)
        if process_start is None:
            raise RuntimeError(f"owner process {owner_pid} is not alive")
        self._reap_stale()
        record = {
            "pid": owner_pid,
            "process_start": process_start,
            "token": token,
        }
        for port in _candidate_ports(start):
            lease = self.root / str(port)
            if lease.exists() or not _port_is_bindable(port):
                continue
            fd, temp_name = tempfile.mkstemp(
                prefix=".claim-", suffix=".tmp", dir=self.root
            )
            temp = Path(temp_name)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump(record, handle, sort_keys=True)
                    handle.write("\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                pause = float(
                    os.environ.get(
                        "CLOUDBENCH_PORT_LEASE_TEST_PAUSE_BEFORE_PUBLISH", "0"
                    )
                )
                if pause > 0:
                    time.sleep(pause)
                os.replace(temp, lease)
                return port
            finally:
                try:
                    temp.unlink()
                except FileNotFoundError:
                    pass
        raise RuntimeError("could not claim a free local port")

    def release(self, *, port: int, owner_pid: int, token: str) -> None:
        lease = self.root / str(port)
        record = _read_record(lease)
        current_start = _process_start_identity(owner_pid)
        if (
            record is not None
            and record.get("pid") == owner_pid
            and record.get("process_start") == current_start
            and record.get("token") == token
        ):
            try:
                lease.unlink()
            except FileNotFoundError:
                pass

    def release_owner(self, *, owner_pid: int, token: str) -> None:
        current_start = _process_start_identity(owner_pid)
        for lease in self.root.iterdir():
            if not lease.name.isdigit() or not lease.is_file():
                continue
            record = _read_record(lease)
            if (
                record is not None
                and record.get("pid") == owner_pid
                and record.get("process_start") == current_start
                and record.get("token") == token
            ):
                try:
                    lease.unlink()
                except FileNotFoundError:
                    pass

    def release_prefix(self, *, owner_pid: int, token_prefix: str) -> None:
        current_start = _process_start_identity(owner_pid)
        for lease in self.root.iterdir():
            if not lease.name.isdigit() or not lease.is_file():
                continue
            record = _read_record(lease)
            if (
                record is not None
                and record.get("pid") == owner_pid
                and record.get("process_start") == current_start
                and str(record.get("token", "")).startswith(token_prefix)
            ):
                try:
                    lease.unlink()
                except FileNotFoundError:
                    pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "action", choices=("claim", "release", "release-owner", "release-prefix")
    )
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--owner-pid", type=int, required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--port", type=int)
    parser.add_argument("--start", type=int, default=0)
    args = parser.parse_args()

    with Registry(args.root) as registry:
        if args.action == "claim":
            print(
                registry.claim(
                    owner_pid=args.owner_pid, token=args.token, start=args.start
                )
            )
        elif args.action == "release":
            if args.port is None:
                parser.error("release requires --port")
            registry.release(
                port=args.port, owner_pid=args.owner_pid, token=args.token
            )
        elif args.action == "release-owner":
            registry.release_owner(owner_pid=args.owner_pid, token=args.token)
        else:
            registry.release_prefix(owner_pid=args.owner_pid, token_prefix=args.token)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
