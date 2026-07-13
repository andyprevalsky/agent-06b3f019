#!/usr/bin/env python3
"""Check whether a Fly Machine's configured volumes are mountable."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


MOUNTABLE_VOLUME_STATES = {"created"}


def _load_payload(argv: list[str]) -> dict[str, Any]:
    if len(argv) == 4:
        return {
            "machines": json.loads(Path(argv[2]).read_text()),
            "volumes": json.loads(Path(argv[3]).read_text()),
        }
    return json.load(sys.stdin)


def readiness(payload: dict[str, Any], machine_id: str) -> tuple[bool, str]:
    machines = payload.get("machines") or []
    volumes = payload.get("volumes") or []
    machine = next(
        (item for item in machines if item.get("id") == machine_id),
        None,
    )
    if machine is None:
        return False, "waiting:machine=missing"

    mounts = (machine.get("config") or {}).get("mounts") or []
    volume_ids = [mount.get("volume") for mount in mounts if mount.get("volume")]
    if not volume_ids:
        return True, "ready"

    states = {item.get("id"): item.get("state") for item in volumes}
    waiting = [
        f"{volume_id}={states.get(volume_id) or 'missing'}"
        for volume_id in volume_ids
        if states.get(volume_id) not in MOUNTABLE_VOLUME_STATES
    ]
    if waiting:
        return False, f"waiting:{','.join(waiting)}"
    return True, "ready"


def main(argv: list[str]) -> int:
    if len(argv) not in {2, 4}:
        print(
            "usage: cloudbench-machine-readiness.py MACHINE_ID "
            "[MACHINES_JSON_PATH VOLUMES_JSON_PATH]",
            file=sys.stderr,
        )
        return 2
    try:
        payload = _load_payload(argv)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"invalid Fly lifecycle payload: {exc}", file=sys.stderr)
        return 2
    ready, detail = readiness(payload, argv[1])
    print(detail)
    return 0 if ready else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
