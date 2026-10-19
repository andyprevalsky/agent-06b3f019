#!/usr/bin/env python3
"""Read-only native release audit for a sharded benchmark admission.

    python3 scripts/cloudbench-native-release-audit.py <admission-dir> --agents-env agents/.env

Lists the benchmark app's Machines once (GET /machines?summary=true) and records
which of this admission's owned guest and controller identities are still
present. The owned identities come only from recorded artifacts: controller
terminal/identity receipts and the verified controller exports'
teardown-ownership names/IDs. It never stops, deletes or changes anything, and
it does not print credentials. The result is written atomically to
``<admission>/native-release-audit.json`` for the scorecard.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import runpy
import sys
import tarfile
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCHEMA = "cloudbench-native-release-audit-v1"
DEFAULT_APP = "navi-whisper-lux-bench"
OWNED = re.compile(r"(^|/)\.?context/fleet/runs/[^/]+/(teardown-ownership/owned-clones\.(names|ids)|[^/]+/worker-clones\.ids)$")
MACHINE_ID = re.compile(r"^[0-9a-f]{14}$")


def _json(path: Path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def controller_ids(admission: Path) -> set[str]:
    ids = set()
    for name in ("terminal.json", "controller.identity.json"):
        for path in admission.glob(f"shard-*/**/{name}"):
            value = _json(path) or {}
            for candidate in (value.get("machine"), (value.get("release") or {}).get("machine_id")):
                if isinstance(candidate, str) and MACHINE_ID.match(candidate):
                    ids.add(candidate)
    return ids


def owned_from_archive(archive: Path) -> tuple[set[str], set[str]]:
    """Owned guest clone names and Machine IDs recorded inside one verified export."""
    names, ids = set(), set()
    with tarfile.open(archive, "r:gz") as stream:
        for member in stream:
            if member.isfile() and member.size <= 1024 * 1024 and OWNED.search(member.name):
                for line in stream.extractfile(member).read().decode(errors="replace").split():
                    (ids if MACHINE_ID.match(line) else names).add(line)
    return names, ids


def guest_identities(admission: Path) -> tuple[set[str], set[str], int]:
    names, ids, exports = set(), set(), 0
    for export in sorted(admission.glob("shard-*/**/export")):
        if (export / "disposable-export.verified.json").exists() and (export / "originals.tar.gz").exists():
            found_names, found_ids = owned_from_archive(export / "originals.tar.gz")
            names |= found_names
            ids |= found_ids
            exports += 1
    return names, ids, exports


def expected_shards(admission: Path) -> int:
    """Shard count from the coordinator journal, else the shard directories."""
    coordination = _json(admission / "coordination.json") or {}
    count = coordination.get("controllers") if isinstance(coordination, dict) else None
    if type(count) is int and count > 0:
        return count
    return sum(path.is_dir() for path in admission.glob("shard-*"))


def audit(machines: list, *, app: str, guest_names, guest_ids, controllers, exports: int, now: float | None = None,
          shards: int | None = None) -> dict:
    present = []
    for machine in machines:
        if not isinstance(machine, dict) or machine.get("state") == "destroyed":
            continue
        if machine.get("id") in guest_ids or machine.get("id") in controllers or machine.get("name") in guest_names:
            present.append({k: machine.get(k) for k in ("id", "name", "state")})
    return {"schema": SCHEMA, "app": app, "observed_at": round(time.time() if now is None else now, 3),
            "request": f"GET /v1/apps/{app}/machines?summary=true", "listed_machines": len(machines),
            "checked": {"guest_names": sorted(guest_names), "guest_ids": sorted(guest_ids),
                        "controller_ids": sorted(controllers), "verified_exports": exports,
                        "expected_shards": shards},
            # Fail closed: an unchecked identity set or a shard without its
            # verified export never certifies release.
            "present": present,
            "released": (not present and exports > 0 and bool(guest_names or guest_ids)
                         and (shards is None or exports == shards))}


def save(path: Path, value: dict) -> None:
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, sort_keys=True, indent=1)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)


def run(admission: Path, api, app: str = DEFAULT_APP, identities=None) -> dict:
    names, ids, exports = identities if identities is not None else guest_identities(admission)
    machines = api.api("GET", "/machines?summary=true", timeout=60)
    if not isinstance(machines, list):
        raise ValueError("native Machine list is not a list")
    result = audit(machines, app=app, guest_names=names, guest_ids=ids, controllers=controller_ids(admission),
                   exports=exports, shards=expected_shards(admission))
    save(admission / "native-release-audit.json", result)
    return result


def token_from_env_file(path: Path) -> str:
    for line in path.read_text().splitlines():
        if line.startswith("FLY_API_TOKEN="):
            value = line.split("=", 1)[1].strip().strip("\"'")
            if value:
                return value
    raise ValueError("FLY_API_TOKEN is absent from the agents env file")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("admission", type=Path)
    parser.add_argument("--agents-env", type=Path, required=True)
    parser.add_argument("--app", default=DEFAULT_APP)
    args = parser.parse_args(argv)
    admission = args.admission.absolute()
    if not (admission / "coordination.json").exists():
        parser.error("a sharded admission directory with coordination.json is required")
    capture = runpy.run_path(str(HERE / "cloudbench-original-volume-capture.py"))
    api = capture["Fly"](args.app, token_from_env_file(args.agents_env))
    result = run(admission, api, args.app)
    summary = {k: result[k] for k in ("observed_at", "listed_machines", "released", "present")}
    summary["checked"] = {k: len(v) if isinstance(v, list) else v for k, v in result["checked"].items()}
    print(json.dumps(summary))
    return 0 if result["released"] else 1


if __name__ == "__main__":
    sys.exit(main())
