#!/usr/bin/env python3
"""Claim durable, non-overlapping local port ranges for deploy worktrees."""

from __future__ import annotations

import argparse
from contextlib import ExitStack
import fcntl
import json
import os
from pathlib import Path
import socket
import tempfile


FIRST_BASE_PORT = 56_000
LAST_BASE_PORT = 64_990
PORTS_PER_WORKTREE = 10


def _record(path: Path) -> dict[str, object] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, TypeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _range_is_bindable(base_port: int) -> bool:
    sockets: list[socket.socket] = []
    try:
        for port in range(base_port, base_port + PORTS_PER_WORKTREE):
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sockets.append(sock)
            sock.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        for sock in sockets:
            sock.close()


def _foreign_claims(registries: tuple[Path, ...], owner: Path) -> set[int]:
    """Live base ports another owner holds in a registry this one must respect.

    Live claims in earlier (TMPDIR-scoped) registries reserve their ranges,
    because their stacks may not be listening when this claim runs.
    """
    ports: set[int] = set()
    for registry in registries:
        for path in registry.glob("*.json") if registry.is_dir() else ():
            value = _record(path)
            if value is None:
                continue
            claimant = Path(str(value.get("owner", "")))
            if str(claimant) == str(owner) or not claimant.is_dir():
                continue
            try:
                ports.add(int(value["base_port"]))
            except (KeyError, TypeError, ValueError):
                continue
    return ports


def _write_claim(root: Path, payload: dict[str, object]) -> None:
    fd, temp_name = tempfile.mkstemp(prefix=".claim-", suffix=".tmp", dir=root)
    temp = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, root / f"{payload['base_port']}.json")
    finally:
        temp.unlink(missing_ok=True)


class Registry:
    def __init__(self, root: Path) -> None:
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        self.lock = (root / ".lock").open("a+", encoding="utf-8")

    def __enter__(self) -> "Registry":
        fcntl.flock(self.lock.fileno(), fcntl.LOCK_EX)
        return self

    def __exit__(self, *_: object) -> None:
        fcntl.flock(self.lock.fileno(), fcntl.LOCK_UN)
        self.lock.close()

    def _records(self) -> list[tuple[Path, dict[str, object]]]:
        records: list[tuple[Path, dict[str, object]]] = []
        for path in self.root.glob("*.json"):
            value = _record(path)
            owner = Path(str(value.get("owner", ""))) if value else None
            if value is None or owner is None or not owner.is_dir():
                path.unlink(missing_ok=True)
                continue
            records.append((path, value))
        return records

    def claim(self, owner: Path, respected: tuple[Path, ...] = ()) -> int:
        owner = owner.resolve()
        records = self._records()
        for _, value in records:
            if value.get("owner") == str(owner):
                return int(value["base_port"])

        claimed = {int(value["base_port"]) for _, value in records}
        claimed |= _foreign_claims(respected, owner)
        for base_port in range(
            FIRST_BASE_PORT, LAST_BASE_PORT + 1, PORTS_PER_WORKTREE
        ):
            if base_port in claimed or not _range_is_bindable(base_port):
                continue
            payload = {
                "schema_version": 1,
                "owner": str(owner),
                "base_port": base_port,
            }
            _write_claim(self.root, payload)
            # Mirror the claim into each existing earlier registry so a claimant
            # still running the TMPDIR-scoped protocol observes this range too.
            for legacy in respected:
                if legacy.is_dir():
                    _write_claim(legacy, payload)
            return base_port
        raise RuntimeError("no free ten-port deploy-worktree range is available")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("claim",))
    parser.add_argument("--registry", type=Path, required=True)
    parser.add_argument("--owner", type=Path, required=True)
    parser.add_argument(
        "--respect-registry",
        type=Path,
        action="append",
        default=[],
        help="another registry whose live claims also reserve their ranges",
    )
    args = parser.parse_args()

    if not args.owner.is_dir():
        parser.error(f"owner path is not a directory: {args.owner}")
    # Create every configured earlier registry and dedupe by resolved path, so
    # each .lock is held exactly once and a legacy claimant that starts later
    # still finds this claim mirrored there.
    own = args.registry.resolve()
    resolved: set[Path] = set()
    for path in args.respect_registry:
        path.mkdir(parents=True, exist_ok=True)
        resolved.add(path.resolve())
    respected = tuple(sorted(path for path in resolved if path != own))
    with ExitStack() as stack:
        # Earlier-protocol claimants serialize on their registry's .lock; hold
        # each one (in a fixed order) so neither side claims from a stale view.
        for legacy in respected:
            handle = stack.enter_context((legacy / ".lock").open("a+", encoding="utf-8"))
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        with Registry(args.registry) as registry:
            print(registry.claim(args.owner, respected))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
