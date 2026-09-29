#!/usr/bin/env python3
"""Bind one reusable worker snapshot to the stopped fleet pool's volume size."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path


READY = {"created", "complete", "completed", "ready"}


def provider(fly: str, app: str, *args: str) -> object:
    result = subprocess.run(
        [fly, *args, "-a", app, "--json"],
        check=True, capture_output=True, text=True, timeout=120,
    )
    # `flyctl volumes snapshots create --json` has emitted both JSON and plain
    # acknowledgement across CLI versions. Bind the new ID from the subsequent
    # exact-volume inventory delta, never from this presentation-only output.
    if args[:3] == ("volumes", "snapshots", "create"):
        return {}
    return json.loads(result.stdout)


def snapshot_ready(snapshots: object, snapshot_id: str) -> bool:
    return isinstance(snapshots, list) and any(
        isinstance(item, dict)
        and item.get("id") == snapshot_id
        and str(item.get("status") or "").lower() in READY
        and int(item.get("size") or 0) > 0
        for item in snapshots
    )


def pool_sources(machines: object, volumes: object, pool_ids: list[str]) -> list[dict[str, object]]:
    if not isinstance(machines, list) or not isinstance(volumes, list):
        raise ValueError("provider inventory is malformed")
    by_machine = {m.get("id"): m for m in machines if isinstance(m, dict)}
    by_volume = {v.get("id"): v for v in volumes if isinstance(v, dict)}
    sources = []
    for machine_id in pool_ids:
        machine = by_machine.get(machine_id)
        if not isinstance(machine, dict):
            raise ValueError("pooled machine missing from provider inventory")
        mounts = (machine.get("config") or {}).get("mounts") or []
        if len(mounts) != 1 or not isinstance(mounts[0], dict):
            raise ValueError("pooled machine does not have exactly one volume")
        volume_id = mounts[0].get("volume")
        volume = by_volume.get(volume_id)
        if not isinstance(volume, dict):
            raise ValueError("pooled volume missing from provider inventory")
        size = int(volume.get("size_gb") or 0)
        if size <= 0 or int(mounts[0].get("size_gb") or 0) != size:
            raise ValueError("pooled volume size is missing or inconsistent")
        sources.append({"machine_id": machine_id, "volume_id": volume_id,
                        "size_gb": size, "state": machine.get("state")})
    if len({source["size_gb"] for source in sources}) != 1:
        raise ValueError("pool contains mixed volume sizes")
    return sources


def write_cache(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(payload, stream, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def ensure(args: argparse.Namespace) -> str:
    pool_ids = [line.strip() for line in args.pool_ids.read_text().splitlines() if line.strip()]
    if not pool_ids:
        return ""
    machines = provider(args.fly, args.app, "machines", "list")
    volumes = provider(args.fly, args.app, "volumes", "list")
    sources = pool_sources(machines, volumes, pool_ids)
    size = int(sources[0]["size_gb"])
    warm = next((v for v in volumes if isinstance(v, dict)
                 and v.get("id") == args.warm_volume_id), None)
    if warm is None or int(warm.get("size_gb") or 0) <= 0:
        raise ValueError("warm volume missing or has no size")
    if size == int(warm["size_gb"]):
        return f"{size} {args.warm_snapshot_id}"

    try:
        cached = json.loads(args.cache.read_text())
    except (FileNotFoundError, ValueError):
        cached = {}
    if isinstance(cached, dict) and cached.get("size_gb") == size:
        source = next((s for s in sources if s["volume_id"] == cached.get("volume_id")), None)
        if source and isinstance(cached.get("snapshot_id"), str):
            snapshots = provider(args.fly, args.app, "volume", "snapshots", "list", str(source["volume_id"]))
            if snapshot_ready(snapshots, cached["snapshot_id"]):
                return f"{size} {cached['snapshot_id']}"

    source = next((s for s in sources if s["state"] == "stopped"), None)
    if source is None:
        raise ValueError("no stopped pooled volume available for worker snapshot")
    volume_id = str(source["volume_id"])
    before = provider(args.fly, args.app, "volume", "snapshots", "list", volume_id)
    if not isinstance(before, list):
        raise ValueError("pre-snapshot inventory malformed")
    before_ids = {s.get("id") for s in before if isinstance(s, dict)}
    provider(args.fly, args.app, "volumes", "snapshots", "create", volume_id)
    bound_id = ""
    for _ in range(args.ready_attempts):
        snapshots = provider(args.fly, args.app, "volume", "snapshots", "list", volume_id)
        if not isinstance(snapshots, list):
            raise ValueError("post-snapshot inventory malformed")
        new_ids = {s["id"] for s in snapshots if isinstance(s, dict)
                   and s.get("id") and s["id"] not in before_ids}
        if len(new_ids) > 1:
            raise ValueError("snapshot ownership ambiguous; multiple new IDs")
        if new_ids:
            observed_id = next(iter(new_ids))
            if bound_id and bound_id != observed_id:
                raise ValueError("snapshot identity changed during readiness polling")
            bound_id = str(observed_id)
        if bound_id and snapshot_ready(snapshots, bound_id):
            write_cache(args.cache, {"volume_id": volume_id,
                                     "size_gb": size, "snapshot_id": bound_id})
            return f"{size} {bound_id}"
        time.sleep(args.poll_seconds)
    raise ValueError("worker snapshot did not become complete before deadline")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pool-ids", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--app", required=True)
    parser.add_argument("--fly", default="flyctl")
    parser.add_argument("--warm-volume-id", required=True)
    parser.add_argument("--warm-snapshot-id", required=True)
    parser.add_argument("--ready-attempts", type=int, default=120)
    parser.add_argument("--poll-seconds", type=float, default=5)
    args = parser.parse_args()
    try:
        print(ensure(args))
    except (OSError, ValueError, subprocess.CalledProcessError,
            subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        print(f"worker snapshot preflight failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
