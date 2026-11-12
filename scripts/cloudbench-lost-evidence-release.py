#!/usr/bin/env python3
"""Release an exact dead fleet owner whose runtime evidence is provably lost.

Exact-owner recovery keeps a registry while ``runtime-evidence-unconfirmed`` is
set, so the guest's runtime evidence can still be captured from its original
volume. When the controller already destroyed every owned Machine and sent every
volume DELETE, nothing can ever be captured: the registry is then held forever
and blocks deploy smoke custody (PR #1864, PR #1931, 2026-11-11).

This helper is the explicit, operator-requested exit
(``scripts/run-bench --recover-stale-owner TOKEN --accept-lost-runtime-evidence``).
It never mutates provider state. It refuses unless:

* the registry and audit identities match the exact token, app and workspace;
* the original controller process is gone (pid + boot-bound start identity);
* every owned Machine reads ``destroyed`` (or 404) from the Machines API; and
* every owned volume reads ``pending_destroy``/``destroyed`` (or 404) and is
  attached to no Machine.

On success it writes ``runtime-evidence-lost.json`` (every native read with its
response hash) into the audit directory and clears only the evidence latches
(``runtime-evidence-unconfirmed`` and, for a purged guest that can never
acknowledge cleanup, ``guest-cleanup-unconfirmed``), so
normal exact-owner recovery can finish its ordinary teardown and audit. The
receipt records the loss; it never claims the evidence or the task outcome.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import re
import runpy
import sys
from pathlib import Path

LATCH = "runtime-evidence-unconfirmed"
GUEST_LATCH = "guest-cleanup-unconfirmed"
RECEIPT = "runtime-evidence-lost.json"
TERMINAL_MACHINE = {"destroyed"}
TERMINAL_VOLUME = {"pending_destroy", "destroyed"}
MACHINE_ID = re.compile(r"^[0-9a-f]{14}$")
VOLUME_ID = re.compile(r"^vol_[0-9a-z]{16}$")


class Refused(Exception):
    pass


def need(value: object, message: str) -> None:
    if not value:
        raise Refused(message)


def fields(path: Path) -> dict[str, str]:
    need(path.is_file() and not path.is_symlink(), f"missing record {path}")
    return dict(line.split("=", 1) for line in path.read_text().splitlines() if "=" in line)


def process_alive(pid: str, start: str) -> bool:
    """True when the exact original process (pid + proc-start identity) still runs."""
    if not pid.isdigit():
        return False
    stat = Path(f"/proc/{pid}/stat")
    try:
        raw = stat.read_text()
    except OSError:
        return False
    ticks = raw.rsplit(")", 1)[1].split()[19]
    boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    return start in ("", f"proc-start:{boot}:{ticks}")


def owned_resources(registry: Path, audit: Path) -> tuple[set[str], set[str]]:
    machines: set[str] = set()
    volumes: set[str] = set()
    fresh = audit / "fresh"
    if fresh.is_dir():
        for row in fresh.iterdir():
            value = fields(row)
            machines.add(value.get("machine_id", ""))
            volumes.add(value.get("volume_id", ""))
    owned = audit / "owned-clones.ids"
    if owned.is_file():
        machines |= {line.strip() for line in owned.read_text().splitlines() if line.strip()}
    for record in registry.glob("disposable-delete-machine-*.json"):
        machines.add(record.name[len("disposable-delete-machine-"):-len(".json")])
    for record in registry.glob("disposable-delete-volume-*.json"):
        volumes.add(record.name[len("disposable-delete-volume-"):-len(".json")])
    machines.discard("")
    volumes.discard("")
    need(all(MACHINE_ID.match(m) for m in machines), "malformed owned Machine id")
    need(all(VOLUME_ID.match(v) for v in volumes), "malformed owned volume id")
    need(machines or volumes, "no owned provider resources recorded; use ordinary recovery")
    return machines, volumes


def observe(client, kind: str, ident: str) -> dict:
    """One native GET; 404 is terminal absence."""
    responses: list[tuple[int, bytes]] = []
    def observer(_method, _path, status, payload):
        responses.append((status, payload))
    try:
        client.api("GET", f"/{kind}s/{ident}", observer=observer)
    except client.not_found:
        pass
    need(len(responses) == 1, f"{kind} {ident}: no single native response")
    status, payload = responses[0]
    row = {"kind": kind, "id": ident, "http_status": status,
           "response_sha256": hashlib.sha256(payload).hexdigest()}
    if status == 404:
        row["state"] = "absent"
        return row
    need(status == 200, f"{kind} {ident}: HTTP {status}")
    value = json.loads(payload)
    need(isinstance(value, dict) and value.get("id") == ident, f"{kind} {ident}: inexact native read")
    row["state"] = value.get("state")
    if kind == "machine":
        need(row["state"] in TERMINAL_MACHINE, f"Machine {ident} is {row['state']}, not destroyed")
    else:
        row["attached_machine_id"] = value.get("attached_machine_id")
        need(row["state"] in TERMINAL_VOLUME and not row["attached_machine_id"],
             f"volume {ident} is {row['state']} attached={row['attached_machine_id']}")
    return row


def release(registry: Path, audit_root: Path, app: str, root: Path, client) -> dict:
    token = registry.name
    need(re.fullmatch(r"[0-9a-f]{32}", token), "registry name is not an exact owner token")
    meta = fields(registry / "meta")
    audit = audit_root / token
    audit_meta = fields(audit / "meta")
    for key, expected in (("fleet_owner_token", token), ("app", app), ("workspace_root", str(root))):
        need(meta.get(key) == expected and audit_meta.get(key) == expected, f"identity mismatch: {key}")
    need(meta.get("run_id") == audit_meta.get("run_id"), "identity mismatch: run_id")
    latches = [name for name in (LATCH, GUEST_LATCH)
               if (registry / name).is_file() and not (registry / name).is_symlink()]
    need(not process_alive(meta.get("pid", ""), meta.get("pid_start", "")), "original controller still running")
    path = audit / RECEIPT
    if path.exists() and not latches:
        # Resume an interrupted release: the loss is recorded and both latches are gone, but the
        # guest-cleanup quarantine policy was not yet returned to reap. Re-prove terminal state first.
        prior = json.loads(path.read_text())
        need(prior.get("fleet_owner_token") == token and prior.get("guest_cleanup") == "LOST"
             and meta.get("cleanup_policy") == "retain", "lost-evidence receipt already recorded")
        machines, volumes = owned_resources(registry, audit)
        for m in sorted(machines): observe(client, "machine", m)
        for v in sorted(volumes): observe(client, "volume", v)
        set_policy_reap(registry)
        return prior
    need(latches, "runtime evidence latch absent; use ordinary recovery")
    need(not path.exists(), "lost-evidence receipt already recorded")
    machines, volumes = owned_resources(registry, audit)
    rows = [observe(client, "machine", m) for m in sorted(machines)]
    rows += [observe(client, "volume", v) for v in sorted(volumes)]
    receipt = {
        "schema": "cloudbench-runtime-evidence-lost-v1",
        "fleet_owner_token": token,
        "run_id": meta.get("run_id"),
        "app": app,
        "observed_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "operator_flag": "--accept-lost-runtime-evidence",
        "runtime_evidence": "LOST",
        # A purged guest can never acknowledge browser/session cleanup either; record it, never infer it.
        "guest_cleanup": "LOST" if GUEST_LATCH in latches else "NOT_REQUIRED",
        "latches_cleared": latches,
        "outcome_credit": False,
        "observations": rows,
    }
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(receipt, indent=1) + "\n")
    os.replace(tmp, path)
    if GUEST_LATCH in latches:
        # Mirror fleet_registry_confirm_guest_teardown: leave quarantine (retain) for reap before
        # removing the latch. Every owned resource is already provider-terminal, so nothing is kept.
        set_policy_reap(registry)
    for name in latches:
        (registry / name).unlink()
    return receipt


def set_policy_reap(registry: Path) -> None:
    meta = registry / "meta"
    lines = meta.read_text().splitlines()
    need(sum(line.startswith("cleanup_policy=") for line in lines) == 1, "registry cleanup policy missing")
    tmp = meta.with_name("meta.tmp.lost-evidence")
    tmp.write_text("".join(("cleanup_policy=reap" if line.startswith("cleanup_policy=") else line) + "\n"
                           for line in lines))
    os.replace(tmp, meta)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--registry", required=True, type=Path)
    parser.add_argument("--audit-root", required=True, type=Path)
    parser.add_argument("--app", required=True)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args(argv)
    capture = runpy.run_path(str(Path(__file__).resolve().parent / "cloudbench-original-volume-capture.py"))
    client = capture["Fly"](args.app, os.environ["FLY_API_TOKEN"])
    client.not_found = capture["NotFound"]
    try:
        receipt = release(args.registry.resolve(), args.audit_root.resolve(), args.app, args.root.resolve(), client)
    except Refused as error:
        print(f"❌ lost-evidence release refused: {error}", file=sys.stderr)
        return 1
    print(f"⚠️  runtime evidence recorded LOST for {receipt['fleet_owner_token']}: "
          f"{len(receipt['observations'])} provider-terminal resources; no outcome credit")
    return 0


if __name__ == "__main__":
    sys.exit(main())
