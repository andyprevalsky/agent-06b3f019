#!/usr/bin/env python3
"""Reconcile exact owned Machine mounts without losing retired volume evidence.

Provider reads -> immutable migration receipt -> current audit -> registry.
The receipt is the write-ahead authority for either interrupted publication.
Fly preserves Machine IDs while replacing volumes during host migration:
https://fly.io/docs/reference/machine-migration/
https://fly.io/docs/volumes/volume-states/
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile


FRESH_KEYS = {
    "version",
    "fleet_owner_token",
    "run_id",
    "app",
    "clone_name",
    "source",
    "source_machine_id",
    "machine_id",
    "volume_id",
    "disposition",
}
RECEIPT_KEYS = {
    "version",
    "fleet_owner_token",
    "run_id",
    "app",
    "clone_name",
    "machine_id",
    "source_machine_id",
    "old_volume_id",
    "new_volume_id",
    "old_volume_state",
    "old_attached_machine_id",
    "new_volume_state",
    "new_attached_machine_id",
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def plain(path: Path, directory: bool = False) -> None:
    require(path.is_absolute() and path.resolve() == path, "unsafe ownership path")
    metadata = path.lstat()
    require(
        stat.S_ISDIR(metadata.st_mode) if directory else stat.S_ISREG(metadata.st_mode),
        "noncanonical ownership inode",
    )


def payload(path: Path) -> bytes:
    plain(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        require(stat.S_ISREG(os.fstat(fd).st_mode), "non-regular ownership record")
        data = os.read(fd, 65_537)
        require(len(data) <= 65_536, "oversized ownership record")
        return data
    finally:
        os.close(fd)


def fields(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in payload(path).decode().splitlines():
        key, separator, value = line.partition("=")
        require(bool(separator) and key not in values, "malformed ownership fields")
        values[key] = value
    return values


def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        require(key not in result, "duplicate provider or journal field")
        result[key] = value
    return result


def sync_directory(path: Path) -> None:
    plain(path, True)
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def make_directory(path: Path) -> None:
    plain(path.parent, True)
    try:
        path.mkdir(mode=0o700)
        sync_directory(path.parent)
    except FileExistsError:
        pass
    plain(path, True)


def publish(path: Path, data: bytes, *, immutable: bool = False) -> None:
    plain(path.parent, True)
    if path.exists() or path.is_symlink():
        prior = payload(path)
        if immutable:
            require(prior == data, "conflicting immutable migration receipt")
            return
    fd, temporary = tempfile.mkstemp(prefix=".migration-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        if immutable:
            os.link(temporary, path)
            os.unlink(temporary)
        else:
            os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def field_payload(values: dict[str, str]) -> bytes:
    return "".join(f"{key}={value}\n" for key, value in values.items()).encode()


def owner_context(
    registry: Path, audit_root: Path, app: str
) -> tuple[Path, dict[str, str]]:
    plain(registry, True)
    plain(registry.parent, True)
    plain(registry / "clones", True)
    plain(audit_root, True)
    owner = registry.name
    require(re.fullmatch(r"[0-9a-f]{32}", owner) is not None, "invalid fleet owner")
    meta = fields(registry / "meta")
    audit = audit_root / owner
    require(
        meta.get("version") == "2"
        and meta.get("fleet_owner_token") == owner
        and meta.get("app") == app
        and meta.get("audit_dir") == str(audit)
        and re.fullmatch(r"[A-Za-z0-9._-]+", meta.get("run_id", "")) is not None,
        "mismatched fleet registry identity",
    )
    plain(audit, True)
    audit_meta = fields(audit / "meta")
    require(
        audit_meta.get("fleet_owner_token") == owner
        and audit_meta.get("run_id") == meta["run_id"]
        and audit_meta.get("app") == app
        and audit_meta.get("status") in {"incomplete", "provider-teardown-verified"},
        "mismatched or terminal owner audit",
    )
    for name in ("fresh", "expected-fresh", "by-machine-id"):
        plain(audit / name, True)
    return audit, meta


def clone_context(
    audit: Path, meta: dict[str, str], clone: str, machine: str
) -> dict[str, str]:
    require(
        re.fullmatch(r"cloudbench-[A-Za-z0-9._-]+", clone) is not None,
        "invalid clone name",
    )
    require(re.fullmatch(r"[0-9a-f]+", machine) is not None, "invalid Machine ID")
    fresh = fields(audit / "fresh" / clone)
    expected = fields(audit / "expected-fresh" / clone)
    require(
        set(fresh) == FRESH_KEYS
        and fresh["version"] == "1"
        and fresh["fleet_owner_token"] == meta["fleet_owner_token"]
        and fresh["run_id"] == meta["run_id"]
        and fresh["app"] == meta["app"]
        and fresh["source"] == "fresh-clone"
        and fresh["clone_name"] == clone
        and fresh["machine_id"] == machine
        and re.fullmatch(r"[0-9a-f]+", fresh["source_machine_id"]) is not None
        and fresh["source_machine_id"] != machine
        and re.fullmatch(r"vol_[A-Za-z0-9_-]+", fresh["volume_id"]) is not None
        and expected
        == {"clone_name": clone, "source_machine_id": fresh["source_machine_id"]}
        and payload(audit / "by-machine-id" / machine).decode().splitlines() == [clone],
        "mismatched exact clone audit identity",
    )
    return fresh


def migration_chain(audit: Path, fresh: dict[str, str]) -> list[dict[str, object]]:
    root = audit / "volume-migrations"
    if not root.exists() and not root.is_symlink():
        return []
    plain(root, True)
    directory = root / fresh["machine_id"]
    if not directory.exists() and not directory.is_symlink():
        return []
    plain(directory, True)
    by_old: dict[str, dict[str, object]] = {}
    destinations: set[str] = set()
    for path in directory.iterdir():
        if path.name.startswith(".migration-"):
            # Interrupted staging carries no authority; never ignore a symlink.
            plain(path)
            continue
        receipt = json.loads(payload(path), object_pairs_hook=unique_object)
        require(
            isinstance(receipt, dict) and set(receipt) == RECEIPT_KEYS,
            "malformed migration receipt",
        )
        old = receipt["old_volume_id"]
        new = receipt["new_volume_id"]
        require(
            receipt["version"] == 1
            and all(
                receipt[key] == fresh[key]
                for key in (
                    "fleet_owner_token",
                    "run_id",
                    "app",
                    "clone_name",
                    "machine_id",
                    "source_machine_id",
                )
            )
            and isinstance(old, str)
            and re.fullmatch(r"vol_[A-Za-z0-9_-]+", old) is not None
            and isinstance(new, str)
            and re.fullmatch(r"vol_[A-Za-z0-9_-]+", new) is not None
            and old != new
            and path.name == f"{old}.json"
            and old not in by_old
            and new not in destinations
            and receipt["old_volume_state"] in {"pending_destroy", "destroyed"}
            and receipt["old_attached_machine_id"] is None
            and receipt["new_volume_state"] == "created"
            and receipt["new_attached_machine_id"] == fresh["machine_id"],
            "unsafe volume migration authority",
        )
        by_old[old] = receipt
        destinations.add(new)
    if not by_old:
        return []
    starts = set(by_old) - destinations
    require(len(starts) == 1, "ambiguous volume migration chain")
    volume = starts.pop()
    ordered = []
    while volume in by_old:
        require(len(ordered) < len(by_old), "cyclic volume migration chain")
        receipt = by_old[volume]
        ordered.append(receipt)
        volume = str(receipt["new_volume_id"])
    require(len(ordered) == len(by_old), "disconnected volume migration chain")
    return ordered


def resume_clone(
    registry: Path, audit: Path, meta: dict[str, str], clone: str, machine: str
) -> None:
    fresh = clone_context(audit, meta, clone, machine)
    chain = migration_chain(audit, fresh)
    if not chain:
        return
    record_path = registry / "clones" / clone
    if fresh["disposition"] in {
        "transfer-pending-stopped",
        "destroyed-verified-absent",
        "destroyed-provider-retained",
        "transferred-to-pool-stopped",
    }:
        require(
            fresh["volume_id"] == chain[-1]["new_volume_id"],
            "uncommitted terminal migration",
        )
        if record_path.exists() or record_path.is_symlink():
            require(
                fields(record_path)
                == {"name": clone, "id": machine, "volume_id": fresh["volume_id"]},
                "conflicting terminal migration registry",
            )
        return
    record = fields(record_path)
    require(
        fields(audit / "meta").get("status") == "incomplete",
        "cannot repair an uncommitted sealed audit",
    )
    require(
        set(record) == {"name", "id", "volume_id"}
        and record["name"] == clone
        and record["id"] == machine,
        "mismatched migration registry identity",
    )
    volumes = [str(chain[0]["old_volume_id"])] + [
        str(item["new_volume_id"]) for item in chain
    ]
    require(
        fresh["volume_id"] in volumes and record["volume_id"] in volumes,
        "foreign volume identity",
    )
    audit_index = volumes.index(fresh["volume_id"])
    registry_index = volumes.index(record["volume_id"])
    require(
        audit_index >= registry_index
        and len(volumes) - 1 - registry_index <= 1
        and fresh["disposition"] == "owned",
        "non-monotonic migration publication",
    )
    fresh["volume_id"] = volumes[-1]
    publish(audit / "fresh" / clone, field_payload(fresh))
    if (
        os.environ.get("CLOUDBENCH_TEST_MODE") == "1"
        and os.environ.get("CLOUDBENCH_TEST_MIGRATION_CRASH") == "audit"
    ):
        raise RuntimeError("injected interruption after migration audit publication")
    record["volume_id"] = volumes[-1]
    publish(record_path, field_payload(record))


def reconcile(args: argparse.Namespace, audit: Path, meta: dict[str, str]) -> None:
    require(
        fields(audit / "meta").get("status") == "incomplete",
        "cannot migrate a sealed owner audit",
    )
    fresh = clone_context(audit, meta, args.clone, args.machine)
    require(
        fresh["disposition"] == "owned", "migration requires active exact ownership"
    )
    record = fields(args.registry / "clones" / args.clone)
    require(
        record
        == {"name": args.clone, "id": args.machine, "volume_id": fresh["volume_id"]},
        "conflicting registry/audit volume",
    )
    values = json.load(sys.stdin, object_pairs_hook=unique_object)
    require(
        isinstance(values, list)
        and len(values) == 3
        and all(isinstance(item, dict) for item in values),
        "malformed exact provider evidence",
    )
    config, old, new = values
    mounts = config.get("mounts")
    require(
        isinstance(mounts, list) and len(mounts) == 1 and isinstance(mounts[0], dict),
        "ambiguous Machine mounts",
    )
    current = mounts[0].get("volume")
    require(
        isinstance(current, str)
        and re.fullmatch(r"vol_[A-Za-z0-9_-]+", current) is not None
        and current != fresh["volume_id"]
        and current != args.protected_volume
        and old.get("id") == fresh["volume_id"]
        and old.get("state") in {"pending_destroy", "destroyed"}
        and "attached_machine_id" in old
        and old["attached_machine_id"] is None
        and new.get("id") == current
        and new.get("state") == "created"
        and new.get("attached_machine_id") == args.machine,
        "unproven exact volume migration",
    )
    receipt = {
        key: fresh[key]
        for key in (
            "fleet_owner_token",
            "run_id",
            "app",
            "clone_name",
            "machine_id",
            "source_machine_id",
        )
    }
    receipt.update(
        {
            "version": 1,
            "old_volume_id": fresh["volume_id"],
            "new_volume_id": current,
            "old_volume_state": old["state"],
            "old_attached_machine_id": None,
            "new_volume_state": new["state"],
            "new_attached_machine_id": args.machine,
        }
    )
    root = audit / "volume-migrations"
    make_directory(root)
    directory = root / args.machine
    make_directory(directory)
    publish(
        directory / f"{fresh['volume_id']}.json",
        (json.dumps(receipt, sort_keys=True) + "\n").encode(),
        immutable=True,
    )
    if (
        os.environ.get("CLOUDBENCH_TEST_MODE") == "1"
        and os.environ.get("CLOUDBENCH_TEST_MIGRATION_CRASH") == "journal"
    ):
        raise RuntimeError("injected interruption after migration receipt publication")
    resume_clone(args.registry, audit, meta, args.clone, args.machine)


def verify(audit: Path, owner: str, run_id: str, app: str) -> None:
    root = audit / "volume-migrations"
    if not root.exists() and not root.is_symlink():
        return
    plain(root, True)
    meta = {"fleet_owner_token": owner, "run_id": run_id, "app": app}
    for directory in root.iterdir():
        plain(directory, True)
        machine = directory.name
        require(
            re.fullmatch(r"[0-9a-f]+", machine) is not None,
            "invalid journal Machine ID",
        )
        clone = payload(audit / "by-machine-id" / machine).decode().strip()
        fresh = clone_context(audit, meta, clone, machine)
        chain = migration_chain(audit, fresh)
        require(
            bool(chain) and chain[-1]["new_volume_id"] == fresh["volume_id"],
            "uncommitted migration journal",
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("reconcile", "resume", "verify"))
    parser.add_argument("--registry", type=Path)
    parser.add_argument("--audit-root", type=Path)
    parser.add_argument("--app", required=True)
    parser.add_argument("--clone")
    parser.add_argument("--machine")
    parser.add_argument("--protected-volume", default="")
    parser.add_argument("--audit", type=Path)
    parser.add_argument("--owner")
    parser.add_argument("--run-id")
    args = parser.parse_args()
    try:
        if args.action == "verify":
            verify(args.audit, args.owner, args.run_id, args.app)
            return 0
        audit, meta = owner_context(args.registry, args.audit_root, args.app)
        journal_root = audit / "volume-migrations"
        if (
            args.action == "resume"
            and not journal_root.exists()
            and not journal_root.is_symlink()
        ):
            return 0
        if journal_root.exists() or journal_root.is_symlink():
            plain(journal_root, True)
        locks = args.registry / "migration-locks"
        make_directory(locks)
        machine_ids = (
            [args.machine]
            if args.machine
            else [entry.name for entry in journal_root.iterdir()]
        )
        for machine in machine_ids:
            require(
                isinstance(machine, str)
                and re.fullmatch(r"[0-9a-f]+", machine) is not None,
                "invalid migration Machine",
            )
            fd = os.open(
                locks / machine, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600
            )
            try:
                require(stat.S_ISREG(os.fstat(fd).st_mode), "unsafe migration lock")
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                clone = (
                    args.clone
                    or payload(audit / "by-machine-id" / machine).decode().strip()
                )
                if args.action == "reconcile":
                    reconcile(args, audit, meta)
                else:
                    resume_clone(args.registry, audit, meta, clone, machine)
            finally:
                os.close(fd)
        return 0
    except (OSError, ValueError, RuntimeError, KeyError, TypeError):
        # Provider input may contain environment secrets. Never echo it or a
        # decoder traceback, including when malformed input embeds credentials.
        print(
            "exact volume migration reconciliation failed; ownership retained",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
