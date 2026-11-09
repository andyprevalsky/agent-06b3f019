#!/usr/bin/env python3
"""Validate a separately owned immutable fleet base; never mutate providers."""

from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re
import runpy
import sys

HERE = Path(__file__).resolve().parent
storage = runpy.run_path(str(HERE / "cloudbench-volume-migration.py"))
readiness = runpy.run_path(str(HERE / "cloudbench-machine-readiness.py"))["readiness"]
select_snapshot = runpy.run_path(str(HERE / "cloudbench-select-snapshot.py"))[
    "select_snapshot"
]


class SourceError(ValueError):
    """A payload-free source-contract failure."""


def require(condition: bool, label: str) -> None:
    if not condition:
        raise SourceError(label)


KEYS = {
    "version",
    "app",
    "owner_token",
    "machine_id",
    "instance_id",
    "machine_name",
    "volume_id",
    "region",
    "image_digest",
    "snapshot_id",
    "node_fingerprint",
    "python_fingerprint",
    "verified_at",
    "shared_machine_id",
    "shared_volume_id",
}
LEASE_PROTOCOL = "cloudbench-source-lease-v1"
LEASE_KEYS = KEYS | {"lease_protocol", "creation_nonce"}


def manifest(data: bytes) -> dict:
    value = json.loads(data, object_pairs_hook=storage["unique_object"])
    require(isinstance(value, dict), "manifest object")
    require(type(value.get("version")) is int and value["version"] in (1, 2), "manifest version")
    require(set(value) == (KEYS if value["version"] == 1 else LEASE_KEYS), "manifest fields")
    if value["version"] == 2:
        require(value["lease_protocol"] == LEASE_PROTOCOL, "source lease protocol")
        require(isinstance(value["creation_nonce"], str)
                and re.fullmatch(r"[0-9a-f]{32}", value["creation_nonce"]) is not None,
                "source creation nonce")
    require(value["app"] == "navi-whisper-lux-bench", "manifest app")
    patterns = {
        "owner_token": r"[0-9a-f]{32}",
        "machine_id": r"[0-9a-f]+",
        "shared_machine_id": r"[0-9a-f]+",
        "instance_id": r"[A-Za-z0-9]+",
        "volume_id": r"vol_[A-Za-z0-9]+",
        "shared_volume_id": r"vol_[A-Za-z0-9]+",
        "region": r"[a-z]{3}",
        "image_digest": r"sha256:[0-9a-f]{64}",
        "snapshot_id": r"vs_[A-Za-z0-9]+",
        "node_fingerprint": r"[0-9a-f]{64}",
        "python_fingerprint": r"[0-9a-f]{64}",
    }
    for key, pattern in patterns.items():
        require(
            isinstance(value[key], str)
            and re.fullmatch(pattern, value[key]) is not None,
            f"manifest {key}",
        )
    require(
        value["machine_name"] == "cloudbench-source-" + value["owner_token"],
        "manifest machine name",
    )
    require(
        value["machine_id"] != value["shared_machine_id"]
        and value["volume_id"] != value["shared_volume_id"],
        "shared source alias",
    )
    require(
        type(value["verified_at"]) is int and value["verified_at"] > 0,
        "dependency verification epoch",
    )
    return value


def canonical(value: dict) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def exact(rows: object, identity: str, label: str) -> dict:
    require(
        isinstance(rows, list) and all(isinstance(row, dict) for row in rows),
        f"{label} inventory",
    )
    matches = [row for row in rows if row.get("id") == identity]
    require(len(matches) == 1, f"{label} identity missing or duplicate")
    return matches[0]


def verify(value: dict, inventory: dict, *, parked_memory: int) -> None:
    machine = exact(inventory.get("machines"), value["machine_id"], "machine")
    shared = exact(
        inventory.get("machines"), value["shared_machine_id"], "shared machine"
    )
    require(shared.get("name") == "cloudbench-warm", "protected shared machine")
    shared_mounts = (shared.get("config") or {}).get("mounts")
    require(
        isinstance(shared_mounts, list)
        and len(shared_mounts) == 1
        and isinstance(shared_mounts[0], dict)
        and shared_mounts[0].get("volume") == value["shared_volume_id"]
        and shared_mounts[0].get("path") == "/data",
        "protected shared mount",
    )
    require(
        machine.get("name") == value["machine_name"]
        and machine.get("instance_id") == value["instance_id"],
        "machine native identity",
    )
    require(machine.get("state") == "stopped", "source must be stopped")
    require(machine.get("region") == value["region"], "machine region")
    config = machine.get("config") or {}
    metadata = config.get("metadata") or {}
    if value["version"] == 2:
        require(metadata.get("cloudbench_source_protocol") == LEASE_PROTOCOL
                and metadata.get("cloudbench_source_create_nonce") == value["creation_nonce"],
                "native source lease protocol")
        require(not any(key.startswith("cloudbench_source_retiring") for key in metadata),
                "source retirement has begun")
    else:
        require("cloudbench_source_protocol" not in metadata, "source protocol downgrade")
    require(
        (config.get("metadata") or {}).get("cloudbench_source_owner")
        == value["owner_token"],
        "source owner",
    )
    require(
        (machine.get("image_ref") or {}).get("digest") == value["image_digest"]
        and str(config.get("image") or "").endswith("@" + value["image_digest"]),
        "source image",
    )
    mounts = config.get("mounts")
    require(
        isinstance(mounts, list)
        and len(mounts) == 1
        and isinstance(mounts[0], dict)
        and mounts[0].get("volume") == value["volume_id"]
        and mounts[0].get("path") == "/data",
        "source mount",
    )
    guest = config.get("guest") or {}
    require(
        guest.get("cpu_kind") == "shared"
        and guest.get("cpus") == 1
        and guest.get("memory_mb") == parked_memory,
        "source parked shape",
    )
    volume = exact(inventory.get("volumes"), value["volume_id"], "volume")
    require(
        volume.get("region") == value["region"]
        and volume.get("attached_machine_id") == value["machine_id"],
        "source volume attachment or region",
    )
    ready, _ = readiness(inventory, value["machine_id"])
    require(ready, "source storage readiness")
    snapshot = exact(inventory.get("snapshots"), value["snapshot_id"], "snapshot")
    require(select_snapshot([snapshot]) == value["snapshot_id"], "snapshot incomplete")
    created = int(
        datetime.fromisoformat(
            str(snapshot["created_at"]).replace("Z", "+00:00")
        ).timestamp()
    )
    require(
        created >= value["verified_at"] - 60,
        "snapshot predates dependency verification",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["capture", "fields", "verify", "protocol"])
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--workspace", type=Path)
    parser.add_argument("--parked-memory", type=int, default=2048)
    parser.add_argument("--sha256")
    args = parser.parse_args()
    try:
        data = storage["payload"](args.manifest)
        value = manifest(data)
        if args.sha256 is not None:
            require(
                hashlib.sha256(data).hexdigest() == args.sha256,
                "captured manifest changed",
            )
        if args.mode == "capture":
            require(args.output is not None, "capture output required")
            if args.workspace is not None:
                context = args.workspace.resolve() / ".context"
                require(
                    args.output.is_absolute()
                    and args.output.resolve() == args.output
                    and args.output.is_relative_to(context),
                    "capture outside workspace context",
                )
            args.output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            storage["publish"](args.output, canonical(value), immutable=True)
            args.output.chmod(0o444)
            print(hashlib.sha256(canonical(value)).hexdigest())
        elif args.mode == "protocol":
            print(value.get("lease_protocol", "none"))
        elif args.mode == "fields":
            keys = (
                "machine_id",
                "volume_id",
                "snapshot_id",
                "region",
                "node_fingerprint",
                "python_fingerprint",
                "shared_machine_id",
                "shared_volume_id",
                "instance_id",
            )
            print(" ".join(value[key] for key in keys))
        else:
            inventory = json.load(sys.stdin, object_pairs_hook=storage["unique_object"])
            require(isinstance(inventory, dict), "provider inventory")
            verify(value, inventory, parked_memory=args.parked_memory)
    except SourceError as error:
        print(f"private fleet source validation failed: {error}", file=sys.stderr)
        return 1
    except (OSError, ValueError, TypeError, KeyError, OverflowError, AttributeError):
        # Provider payloads may contain secrets; report only the boundary.
        print("private fleet source validation failed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
