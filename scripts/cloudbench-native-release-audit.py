#!/usr/bin/env python3
"""Read-only native release audit for a sharded benchmark admission.

    python3 scripts/cloudbench-native-release-audit.py <admission-dir> --agents-env agents/.env

Lists the benchmark app's Machines and Volumes once each and records which of
this admission's owned guest, volume and controller identities are still
present. Ownership comes only from recorded artifacts: controller
terminal/identity receipts and, inside each verified controller export, every
fleet's run-local teardown ownership, primary/worker ID files, git-common
ownership registries (clone name, Machine and volume IDs) and audits. Native
Machines are also matched by the exported fleet owner tokens in their
``CLOUDBENCH_RUN_TOKEN``, so a guest whose ID never reached a file is still
found. An ownership registry still present in an export means that owner never
retired; it fails the audit closed even when nothing is natively present. Only
the owner-token prefix of the guest environment is read; no environment value
is recorded or printed. It never stops, deletes or changes anything. The result
is written atomically to ``<admission>/native-release-audit.json`` for the
scorecard.
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
# Run-local ownership files: released teardown audits plus each bench's primary
# and worker ID lists (a retained fleet never moves its audit into the run dir).
OWNED = re.compile(r"(^|/)\.?context/fleet/runs/[^/]+/(teardown-ownership/owned-clones\.(names|ids)"
                   r"|[^/]+/(primary|worker-clones)\.ids)$")
# Exported git-common fleet ownership: registries, their clone records and audits.
REGISTRY = re.compile(r"(^|/)git-common/cloudbench-fleet-ownership/([0-9a-f]{32})/(meta|clones/[^/]+)$")
FLEET_AUDIT = re.compile(r"(^|/)git-common/cloudbench-fleet-audits/([0-9a-f]{32})/(meta|owned-clones\.(names|ids))$")
MACHINE_ID = re.compile(r"^[0-9a-f]{14}$")
VOLUME_ID = re.compile(r"^vol_[0-9a-z]+$")
OWNER_TOKEN = re.compile(r"^([0-9a-f]{32})(-[0-9]+)?$")
RELEASED_VOLUME_STATES = frozenset({"destroyed", "destroying", "scheduling_destroy", "pending_destroy"})


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


def _fields(text: str) -> dict:
    return dict(line.split("=", 1) for line in text.splitlines() if "=" in line)


def empty_ownership() -> dict:
    return {"names": set(), "ids": set(), "volumes": set(), "tokens": set(), "registries": set()}


def ownership_from_archive(archive: Path) -> dict:
    """Every owned guest identity and fleet owner recorded inside one verified export."""
    found = empty_ownership()

    def identity(value: str) -> None:
        value = value.strip()
        if MACHINE_ID.match(value):
            found["ids"].add(value)
        elif VOLUME_ID.match(value):
            found["volumes"].add(value)
        elif value:
            found["names"].add(value)

    with tarfile.open(archive, "r:gz") as stream:
        for member in stream:
            if not member.isfile() or member.size > 1024 * 1024:
                continue
            registry, audit = REGISTRY.search(member.name), FLEET_AUDIT.search(member.name)
            if not (registry or audit or OWNED.search(member.name)):
                continue
            text = stream.extractfile(member).read().decode(errors="replace")
            if registry:
                found["tokens"].add(registry.group(2))
                if registry.group(3) == "meta":
                    found["registries"].add(registry.group(2))
                else:
                    for key in ("name", "id", "volume_id"):
                        identity(_fields(text).get(key, ""))
            elif audit:
                found["tokens"].add(audit.group(2))
                if audit.group(3) != "meta":
                    for line in text.split():
                        identity(line)
            else:
                for line in text.split():
                    identity(line)
    return found


def _verified(export: Path) -> bool:
    return (export / "disposable-export.verified.json").exists() and (export / "originals.tar.gz").exists()


def final_exports(admission: Path) -> list[Path]:
    """Each shard's final attempt export, from the coordinator journal.

    A respawned shard rewrites its journal ``out``; an earlier attempt's export never
    stands in for the final one. Without journal entries, each ``shard-*`` directory
    counts once."""
    coordination = _json(admission / "coordination.json") or {}
    shards = coordination.get("shards") if isinstance(coordination, dict) else None
    if isinstance(shards, dict) and shards:
        finals = []
        for entry in shards.values():
            out = Path(str((entry or {}).get("out") or ""))
            if not out.exists() and admission.name in out.parts:
                out = admission.joinpath(*out.parts[out.parts.index(admission.name) + 1:])
            finals.append(out / "export")
        return finals
    return [next(iter(sorted(shard.glob("**/export"))), shard / "run/export")
            for shard in sorted(admission.glob("shard-*")) if shard.is_dir()]


def guest_identities(admission: Path) -> tuple[dict, int]:
    """Ownership from every attempt's verified export; the count covers final attempts only."""
    owned = empty_ownership()
    for export in sorted(admission.glob("shard-*/**/export")):
        if _verified(export):
            for key, values in ownership_from_archive(export / "originals.tar.gz").items():
                owned[key] |= values
    return owned, sum(_verified(export) for export in final_exports(admission))


def expected_shards(admission: Path) -> int:
    """Shard count from the coordinator journal, else the shard directories."""
    coordination = _json(admission / "coordination.json") or {}
    count = coordination.get("controllers") if isinstance(coordination, dict) else None
    if type(count) is int and count > 0:
        return count
    return sum(path.is_dir() for path in admission.glob("shard-*"))


def _owner_token(machine: dict) -> str | None:
    env = (machine.get("config") or {}).get("env") or {}
    match = OWNER_TOKEN.match(str(env.get("CLOUDBENCH_RUN_TOKEN") or ""))
    return match.group(1) if match else None


def audit(machines: list, *, app: str, guest_names, guest_ids, controllers, exports: int, now: float | None = None,
          shards: int | None = None, volumes: list | None = None, guest_volumes=(), owner_tokens=(),
          retained_owners=()) -> dict:
    owner_tokens = set(owner_tokens)
    present, attached = [], set()
    for machine in machines:
        if not isinstance(machine, dict) or machine.get("state") == "destroyed":
            continue
        if (machine.get("id") in guest_ids or machine.get("id") in controllers
                or machine.get("name") in guest_names or _owner_token(machine) in owner_tokens):
            present.append({k: machine.get(k) for k in ("id", "name", "state")})
            attached.update(mount.get("volume") for mount in (machine.get("config") or {}).get("mounts") or [])
    volume_names = {"cbv_" + name[len("cloudbench-"):] for name in guest_names if name.startswith("cloudbench-")}
    present_volumes = [{k: volume.get(k) for k in ("id", "name", "state")} for volume in volumes or []
                       if isinstance(volume, dict) and volume.get("state") not in RELEASED_VOLUME_STATES
                       and (volume.get("id") in guest_volumes or volume.get("id") in attached
                            or volume.get("name") in volume_names)]
    return {"schema": SCHEMA, "app": app, "observed_at": round(time.time() if now is None else now, 3),
            "request": f"GET /v1/apps/{app}/machines and /volumes", "listed_machines": len(machines),
            "listed_volumes": None if volumes is None else len(volumes),
            "checked": {"guest_names": sorted(guest_names), "guest_ids": sorted(guest_ids),
                        "guest_volumes": sorted(guest_volumes), "owner_tokens": sorted(owner_tokens),
                        "controller_ids": sorted(controllers), "verified_exports": exports,
                        "expected_shards": shards},
            # Fail closed: an unchecked identity set, a shard without its verified
            # export, or an exported owner that never retired never certifies release.
            "present": present, "present_volumes": present_volumes, "retained_owners": sorted(retained_owners),
            "released": (not present and not present_volumes and not retained_owners and exports > 0
                         and bool(guest_names or guest_ids or owner_tokens)
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


def run(admission: Path, api, app: str = DEFAULT_APP) -> dict:
    owned, exports = guest_identities(admission)
    machines = api.api("GET", "/machines", timeout=60)
    volumes = api.api("GET", "/volumes", timeout=60)
    if not isinstance(machines, list) or not isinstance(volumes, list):
        raise ValueError("native Machine/Volume list is not a list")
    result = audit(machines, app=app, guest_names=owned["names"], guest_ids=owned["ids"],
                   controllers=controller_ids(admission), exports=exports, shards=expected_shards(admission),
                   volumes=volumes, guest_volumes=owned["volumes"], owner_tokens=owned["tokens"],
                   retained_owners=owned["registries"])
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
    summary = {k: result[k] for k in ("observed_at", "listed_machines", "listed_volumes", "released", "present",
                                      "present_volumes", "retained_owners")}
    summary["checked"] = {k: len(v) if isinstance(v, list) else v for k, v in result["checked"].items()}
    print(json.dumps(summary))
    return 0 if result["released"] else 1


if __name__ == "__main__":
    sys.exit(main())
