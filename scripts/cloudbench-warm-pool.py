#!/usr/bin/env python3
"""Digest-bound SUSPENDED warm pool of cloud benchmark guests for deploy smoke.

Fly resumes a suspended Machine from its memory snapshot in hundreds of
milliseconds, while a fresh clone pays volume creation, cold boot and the whole
guest warm-up (Postgres cluster start, seed fixture, repo checkout). This pool
keeps K guests pre-cloned from the warm donor snapshot, warmed to the
ref-independent idle state and SUSPENDED, each tagged with the donor image
digest and the dependency fingerprint they were built from.

    status   [--json]                      inventory, idle cost/hour, headroom
    provision --size K [--memory MB ...]   top the pool up to K ready members
    checkout --image D --deps F            resume one matching member (exit 3 = none)
    claim    --out DIR [--run-token T]     fleet boundary: checkout + <DIR>/warm-pool-claim.json
                                           (exit 3 = none; receipt says "fallback": "clone")
    release <id> --image D --deps F [--out DIR]  re-suspend if healthy + still matching, else destroy
    refresh --size K                       destroy stale (digest/deps mismatch) members, re-pool
    destroy [--all | <id>...]              exact-owner teardown (members only, with volumes)
    cost     [--json]                      per-hour idle cost from Fly list prices

Ownership: members are named `<pool>-<12 hex>` (never `cloudbench-<hex>`, so
`run-bench reclaim-stopped` ignores them by name) and carry
`cloudbench_protected_owner=<pool>` (a reaper-protected metadata prefix) plus
`deploy_warm_pool*` tags. Every mutation first re-reads the Machine and requires
the exact `deploy_warm_pool=<pool>` tag; the donor is only ever read.

Fly constraints (docs.fly.io/reference/suspend-resume): suspend needs <= 2 GB
memory, no swap, no schedule; snapshots are not guaranteed to persist (a resume
may cold boot). Billing while suspended = stopped: rootfs + volume storage only.

Offline tests point `FLY_FLAPS_BASE_URL` at a fake Machines API
(scripts/tests/cloudbench-warm-pool.test.py); nothing here shells out to flyctl.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_APP = "navi-whisper-lux-bench"
DEFAULT_POOL = "deploy-warm-pool"
DEFAULT_DONOR = "cloudbench-warm"
TAG = "deploy_warm_pool"
PROTECTED_TAG = "cloudbench_protected_owner"  # prefix `cloudbench_protected` is reaper-protected
STATE_READY = "ready"
STATE_LEASED = "leased"
MACHINE_ID = re.compile(r"[0-9a-f]{14}")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
SUSPEND_MAX_MEMORY_MB = 2048  # docs.fly.io/reference/suspend-resume
# docs.fly.io/about/pricing (checked 2026-10-28): stopped or suspended Machine
# rootfs $0.15/GB/month; volumes $0.15/GB/month of provisioned capacity.
STORAGE_USD_PER_GB_MONTH = 0.15
HOURS_PER_MONTH = 730.0
DEFAULT_ROOTFS_GB = 8  # the Machines API exposes no rootfs size; biz_review_fly.py assumes 8 GB too
EXIT_NO_MATCH = 3

# Ref-independent warm-up executed inside the guest (root). Prints one
# WARM_POOL_READY line the controller parses; exit status is the readiness verdict.
PREP_SCRIPT = r"""
set -u
DATA="${CLOUDBENCH_DATA_DIR:-/data}"
MODE="$1"
for _ in $(seq 1 60); do touch "$DATA/.warm-pool-probe" 2>/dev/null && break; sleep 1; done
rm -f "$DATA/.warm-pool-probe" 2>/dev/null
if [ ! -d "$DATA/repo/.git" ]; then echo "WARM_POOL_FAIL repo=missing"; exit 2; fi
if [ "$MODE" = prep ]; then
    PG_VER="$(ls /etc/postgresql 2>/dev/null | sort -V | tail -1)"
    if [ -n "$PG_VER" ]; then pg_ctlcluster "$PG_VER" main start >/dev/null 2>&1 || service postgresql start >/dev/null 2>&1 || true; fi
fi
pg=0
for _ in $(seq 1 90); do
    if pg_isready -q 2>/dev/null || pg_isready -h localhost -p 5432 -U postgres -q 2>/dev/null; then pg=1; break; fi
    [ "$MODE" = prep ] || break
    sleep 1
done
seed=0; [ -s "$DATA/cloudbench-cache/victoria-seed.dump" ] && seed=1
sha="$(git -c safe.directory="$DATA/repo" -C "$DATA/repo" rev-parse --short HEAD 2>/dev/null || echo unknown)"
up="$(cut -d' ' -f1 /proc/uptime)"
echo "WARM_POOL_READY mode=$MODE pg=$pg seed=$seed repo=$sha uptime=$up"
[ "$pg" = 1 ]
"""
READY_LINE = re.compile(r"WARM_POOL_READY mode=(\S+) pg=(\d) seed=(\d) repo=(\S+) uptime=([0-9.]+)")


class PoolError(Exception):
    pass


def need(value, message):
    if not value:
        raise PoolError(message)


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def resolve_token(explicit: str | None = None) -> str:
    token = explicit or os.environ.get("FLY_API_TOKEN", "")
    if not token:
        env_file = ROOT / "agents" / ".env"
        if env_file.is_file():
            for line in env_file.read_text().splitlines():
                if line.startswith("FLY_API_TOKEN="):
                    token = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
    need(token, "FLY_API_TOKEN missing (env or agents/.env)")
    return token if token.startswith("FlyV1 ") else f"FlyV1 {token}"


class Fly:
    """Minimal Machines API client; base URL overridable for offline fakes."""

    def __init__(self, app: str, token: str, base: str | None = None, timeout: float = 60.0):
        self.app = app
        self.token = token
        self.base = (base or os.environ.get("FLY_FLAPS_BASE_URL", "https://api.machines.dev")).rstrip("/")
        self.timeout = timeout
        self.calls: list[tuple[str, str]] = []

    def _call(self, method: str, path: str, body=None, expect_json=True):
        url = f"{self.base}/v1/apps/{self.app}{path}"
        raw = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(url, data=raw, method=method, headers={
            "Authorization": self.token, "Accept": "application/json", "Content-Type": "application/json",
            "User-Agent": "rose-cloudbench-warm-pool/1"})
        self.calls.append((method, path))
        last = None
        for attempt in range(4):
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    payload = response.read()
                    if not expect_json or not payload:
                        return None
                    return json.loads(payload)
            except urllib.error.HTTPError as error:
                detail = error.read().decode(errors="replace")[:400]
                if error.code in (429, 502, 503, 504) and attempt < 3:
                    last = error
                    time.sleep(1.5 * (attempt + 1))
                    continue
                raise PoolError(f"{method} {path} -> HTTP {error.code}: {detail}") from error
            except (urllib.error.URLError, TimeoutError) as error:
                if attempt < 3:
                    last = error
                    time.sleep(1.5 * (attempt + 1))
                    continue
                raise PoolError(f"{method} {path} -> {error}") from error
        raise PoolError(f"{method} {path} -> {last}")

    # machines
    def machines(self):
        return self._call("GET", "/machines") or []

    def machine(self, machine_id):
        return self._call("GET", f"/machines/{machine_id}")

    def create_machine(self, body):
        return self._call("POST", "/machines", body)

    def update_machine(self, machine_id, body):
        return self._call("POST", f"/machines/{machine_id}", body)

    def start(self, machine_id):
        return self._call("POST", f"/machines/{machine_id}/start", {})

    def suspend(self, machine_id):
        return self._call("POST", f"/machines/{machine_id}/suspend", {})

    def stop(self, machine_id):
        return self._call("POST", f"/machines/{machine_id}/stop", {})

    def wait(self, machine_id, state, seconds=60):
        return self._call("GET", f"/machines/{machine_id}/wait?state={state}&timeout={int(seconds)}")

    def exec(self, machine_id, command, seconds=120):
        return self._call("POST", f"/machines/{machine_id}/exec", {"command": command, "timeout": int(seconds)})

    def set_metadata(self, machine_id, key, value):
        return self._call("POST", f"/machines/{machine_id}/metadata/{key}", {"value": value}, expect_json=False)

    def destroy_machine(self, machine_id):
        return self._call("DELETE", f"/machines/{machine_id}?force=true", expect_json=False)

    # volumes
    def volume(self, volume_id):
        return self._call("GET", f"/volumes/{volume_id}")

    def create_volume(self, body):
        return self._call("POST", "/volumes", body)

    def destroy_volume(self, volume_id):
        return self._call("DELETE", f"/volumes/{volume_id}", expect_json=False)

    def snapshots(self, volume_id):
        return self._call("GET", f"/volumes/{volume_id}/snapshots") or []

    def volumes(self):
        return self._call("GET", "/volumes") or []


# ── inventory helpers ────────────────────────────────────────────────────────

def metadata_of(row):
    return ((row.get("config") or {}).get("metadata") or {})


def image_digest_of(row):
    digest = (row.get("image_ref") or {}).get("digest") or ""
    if not digest:
        image = (row.get("config") or {}).get("image") or ""
        digest = image.rpartition("@")[2] if "@" in image else ""
    return digest if DIGEST.fullmatch(digest or "") else ""


def volumes_of(row):
    return [m.get("volume") for m in ((row.get("config") or {}).get("mounts") or []) if m.get("volume")]


def is_member(row, pool):
    return metadata_of(row).get(TAG) == pool


def orphan_pool_volumes(fly: Fly):
    """Unattached `warmpool_<hex>` volumes: left only by a provision interrupted
    between volume create and Machine create. Exact by name prefix + no Machine."""
    return [row for row in fly.volumes()
            if re.fullmatch(r"warmpool_[0-9a-f]{12}", str(row.get("name") or ""))
            and not row.get("attached_machine_id")
            and str(row.get("state") or "").lower() not in {"destroyed", "pending_destroy", "destroying"}]


def member_summary(row):
    meta = metadata_of(row)
    guest = (row.get("config") or {}).get("guest") or {}
    return {
        "id": row.get("id"), "name": row.get("name"), "state": row.get("state"), "region": row.get("region"),
        "image": image_digest_of(row), "deps": meta.get(f"{TAG}_deps", ""), "pool_state": meta.get(f"{TAG}_state", ""),
        "ref": meta.get(f"{TAG}_ref", ""), "volumes": volumes_of(row), "created_at": row.get("created_at"),
        "guest": f"{guest.get('cpu_kind', '?')}-{guest.get('cpus', '?')}x/{guest.get('memory_mb', '?')}MB",
        "memory_mb": guest.get("memory_mb"),
    }


def find_donor(fly: Fly, donor_name: str):
    rows = [row for row in fly.machines() if row.get("name") == donor_name]
    need(rows, f"donor Machine '{donor_name}' not found in {fly.app}")
    donor = rows[0]
    need(image_digest_of(donor), "donor image digest unavailable")
    return donor


def newest_completed_snapshot(records):
    completed = [row for row in records
                 if str(row.get("status") or row.get("state") or "").lower() in {"created", "complete", "completed", "ready", "available"}
                 and row.get("id")]
    completed.sort(key=lambda row: str(row.get("created_at") or ""), reverse=True)
    return completed[0] if completed else None


def default_deps_fingerprint(root: Path = ROOT) -> str:
    """Hash of the dependency manifests a guest image is built from (python
    requirements + the npm dependency fields of each workspace package.json)."""
    digest = hashlib.sha256()
    for relative in ("agents/requirements.txt", "package.json", "back-end/package.json", "front-end/package.json"):
        path = root / relative
        if not path.is_file():
            continue
        digest.update(relative.encode() + b"\0")
        if relative.endswith("package.json"):
            data = json.loads(path.read_text() or "{}")
            fields = {k: data.get(k) for k in ("dependencies", "devDependencies", "optionalDependencies",
                                               "peerDependencies", "overrides", "workspaces") if k in data}
            digest.update(json.dumps(fields, sort_keys=True, separators=(",", ":")).encode())
        else:
            digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def parse_ready(result):
    stdout = (result or {}).get("stdout") or ""
    match = READY_LINE.search(stdout)
    code = (result or {}).get("exit_code")
    if match is None or code != 0:
        raise PoolError(f"guest readiness probe failed (exit={code}): {stdout.strip()[-300:]} {(result or {}).get('stderr', '')[-200:]}")
    return {"pg": match.group(2) == "1", "seed": match.group(3) == "1", "repo": match.group(4), "uptime": float(match.group(5))}


def probe(fly: Fly, machine_id, mode, seconds=240):
    return parse_ready(fly.exec(machine_id, ["bash", "-c", PREP_SCRIPT, "warm-pool", mode], seconds))


def wait_state(fly: Fly, machine_id, state, seconds):
    deadline = time.monotonic() + seconds
    while True:
        try:
            fly.wait(machine_id, state, min(60, max(1, int(deadline - time.monotonic()))))
        except PoolError:
            pass
        row = fly.machine(machine_id)
        if row.get("state") == state:
            return row
        if time.monotonic() >= deadline:
            raise PoolError(f"{machine_id} did not reach state {state} within {seconds}s (state={row.get('state')})")
        time.sleep(2)


def wait_volume(fly: Fly, volume_id, seconds):
    deadline = time.monotonic() + seconds
    while True:
        row = fly.volume(volume_id)
        state = str(row.get("state") or "").lower()
        if state == "created":
            return row
        need(state not in {"failed", "destroyed", "pending_destroy"}, f"volume {volume_id} entered {state}")
        need(time.monotonic() < deadline, f"volume {volume_id} not created within {seconds}s (state={state})")
        time.sleep(3)


# ── lifecycle ────────────────────────────────────────────────────────────────

def member_or_fail(fly: Fly, pool, machine_id):
    need(MACHINE_ID.fullmatch(machine_id or ""), f"invalid Machine id {machine_id!r}")
    row = fly.machine(machine_id)
    need(is_member(row, pool), f"{machine_id} is not owned by pool {pool}; refusing")
    return row


def destroy_member(fly: Fly, pool, machine_id, log):
    """Exact-owner teardown: re-read, require the pool tag, delete Machine then its Volumes."""
    row = member_or_fail(fly, pool, machine_id)
    volumes = volumes_of(row)
    fly.destroy_machine(machine_id)
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        try:
            current = fly.machine(machine_id)
        except PoolError as error:
            if "404" in str(error):
                break
            raise
        if current.get("state") == "destroyed":
            break
        time.sleep(2)
    for volume in volumes:
        try:
            fly.destroy_volume(volume)
        except PoolError as error:
            if "404" not in str(error):
                raise
    log(f"🗑️  destroyed pool member {machine_id} (+{len(volumes)} volume(s))")
    return {"machine": machine_id, "volumes": volumes}


def suspend_member(fly: Fly, machine_id, seconds):
    fly.suspend(machine_id)
    return wait_state(fly, machine_id, "suspended", seconds)


def provision_one(fly: Fly, args, donor, snapshot, image, deps, log):
    """Clone donor snapshot -> warm -> suspend -> tag ready. Returns a timing receipt."""
    receipt = {"phases": {}, "machine": None, "volume": None, "ok": False}
    clock = time.monotonic()

    def mark(name):
        receipt["phases"][name] = round(time.monotonic() - clock, 3)

    suffix = uuid.uuid4().hex[:12]
    name = f"{args.pool}-{suffix}"
    region = donor.get("region") or args.region
    config = json.loads(json.dumps(donor.get("config") or {}))
    config.pop("mounts", None)
    config.pop("schedule", None)
    config.pop("swap_size_mb", None)
    config.pop("checks", None)
    env = dict(config.get("env") or {})
    for key in list(env):
        if key.startswith("CLOUDBENCH_") or key in {"REF", "BENCH_TASKS_B64", "BENCH_SIMULATE"}:
            env.pop(key)
    config["env"] = env
    config["guest"] = {"cpu_kind": args.cpu_kind, "cpus": args.cpus, "memory_mb": args.memory}
    config["restart"] = {"policy": "no"}
    config["auto_destroy"] = False
    config["metadata"] = {
        PROTECTED_TAG: args.pool, TAG: args.pool, f"{TAG}_image": image, f"{TAG}_deps": deps,
        f"{TAG}_state": "provisioning", f"{TAG}_owner_host": socket.gethostname(), f"{TAG}_created": now_iso(),
    }
    # Attributable volume name: an interrupted provision (before the Machine
    # exists) leaves an unattached `warmpool_<hex>` volume that status/destroy
    # can recognise and release instead of an anonymous orphan.
    volume_body = {"name": f"warmpool_{suffix}", "region": region, "size_gb": int(args.volume_gb or snapshot.get("size_gb") or 0) or None}
    if volume_body["size_gb"] is None:
        volume_body.pop("size_gb")
    volume_body["snapshot_id"] = snapshot["id"]
    volume = fly.create_volume(volume_body)
    receipt["volume"] = volume.get("id")
    log(f"  💾 volume {volume.get('id')} from snapshot {snapshot['id']} ({region})")
    try:
        wait_volume(fly, volume["id"], args.volume_timeout)
        mark("volume_created")
        config["mounts"] = [{"volume": volume["id"], "path": "/data"}]
        machine = fly.create_machine({"name": name, "region": region, "config": config, "skip_launch": False})
        receipt["machine"] = machine.get("id")
        log(f"  🖥️  machine {machine.get('id')} {name} ({args.cpu_kind}-{args.cpus}x/{args.memory}MB)")
        mark("machine_created")
        wait_state(fly, machine["id"], "started", args.start_timeout)
        mark("started")
        ready = probe(fly, machine["id"], "prep", args.prep_timeout)
        receipt["prep"] = ready
        mark("warm_ready")
        if args.fetch_ref:
            result = fly.exec(machine["id"], ["bash", "-c", f"timeout 240 git -c safe.directory=/data/repo -C /data/repo fetch --quiet origin {args.fetch_ref} && git -c safe.directory=/data/repo -C /data/repo rev-parse --short FETCH_HEAD"], 300)
            fetched = (result.get("stdout") or "").strip() if result.get("exit_code") == 0 else "unfetched"
            fly.set_metadata(machine["id"], f"{TAG}_ref", fetched)
            receipt["fetched_ref"] = fetched
            mark("ref_fetched")
        if args.memory > SUSPEND_MAX_MEMORY_MB:
            log(f"  ⚠️  memory {args.memory}MB exceeds Fly's documented suspend limit ({SUSPEND_MAX_MEMORY_MB}MB); attempting anyway")
        try:
            suspend_member(fly, machine["id"], args.suspend_timeout)
        except PoolError as error:
            fallback = int(getattr(args, "suspend_fallback_memory", 0) or 0)
            if not fallback or fallback >= args.memory:
                raise
            # One clone, one retry: shrink the same Machine to a suspendable
            # shape (config update restarts it), re-warm, suspend again.
            log(f"  ↩️  suspend refused at {args.memory}MB ({error}); resizing {machine['id']} to {fallback}MB and retrying")
            receipt["suspend_refused_at_mb"] = args.memory
            current = fly.machine(machine["id"])
            updated = json.loads(json.dumps(current.get("config") or {}))
            updated["guest"] = dict(updated.get("guest") or {}, memory_mb=fallback)
            fly.update_machine(machine["id"], {"config": updated})
            wait_state(fly, machine["id"], "started", args.start_timeout)
            mark("resized_started")
            receipt["prep_after_resize"] = probe(fly, machine["id"], "prep", args.prep_timeout)
            mark("resized_warm_ready")
            suspend_member(fly, machine["id"], args.suspend_timeout)
            receipt["suspend_fallback_memory_mb"] = fallback
        mark("suspended")
        fly.set_metadata(machine["id"], f"{TAG}_state", STATE_READY)
        receipt["ok"] = True
        log(f"  ✅ pooled (suspended): {machine['id']}")
        return receipt
    except PoolError as error:
        receipt["error"] = str(error)
        log(f"  ❌ provisioning failed: {error}")
        if receipt["machine"]:
            try:
                destroy_member(fly, args.pool, receipt["machine"], log)
                receipt["cleanup"] = "machine+volume destroyed"
                return receipt
            except PoolError as cleanup_error:
                receipt["cleanup"] = f"FAILED: {cleanup_error}"
                log(f"  ❌ cleanup failed; retained {receipt['machine']} for exact-owner recovery: {cleanup_error}")
                return receipt
        try:
            fly.destroy_volume(volume["id"])
            receipt["cleanup"] = "volume destroyed"
        except PoolError as cleanup_error:
            receipt["cleanup"] = f"FAILED: {cleanup_error}"
        return receipt


def matching_ready(members, image, deps):
    return [m for m in members if m["state"] == "suspended" and m["pool_state"] == STATE_READY
            and m["image"] == image and m["deps"] == deps]


def checkout(fly: Fly, args, image, deps, log):
    members = [member_summary(row) for row in fly.machines() if is_member(row, args.pool)]
    candidates = matching_ready(members, image, deps)
    lease = args.lease or uuid.uuid4().hex
    tried = []
    for member in sorted(candidates, key=lambda m: m["created_at"] or ""):
        machine_id = member["id"]
        clock = time.monotonic()
        fly.set_metadata(machine_id, f"{TAG}_state", f"{STATE_LEASED}:{lease}")
        time.sleep(args.lease_settle)
        current = fly.machine(machine_id)
        if metadata_of(current).get(f"{TAG}_state") != f"{STATE_LEASED}:{lease}" or current.get("state") != "suspended":
            tried.append({"machine": machine_id, "outcome": "lost-lease-race"})
            continue
        try:
            fly.start(machine_id)
            wait_state(fly, machine_id, "started", args.start_timeout)
            started_at = round(time.monotonic() - clock, 3)
            ready = probe(fly, machine_id, "health", args.prep_timeout)
            ready_seconds = round(time.monotonic() - clock, 3)
            # A resume from the memory snapshot keeps the guest's uptime; a
            # cold boot (Fly does not guarantee snapshot persistence) starts
            # it over. Either way the guest was never reconfigured: no
            # config update (POST /machines/<id>) happened on this path.
            preserved = ready["uptime"] > ready_seconds + 5
            config_updates = sum(1 for method, path in fly.calls if method == "POST" and path == f"/machines/{machine_id}")
            receipt = {"machine": machine_id, "volumes": member["volumes"], "lease": lease, "image": image, "deps": deps,
                       "resume_seconds": started_at, "ready_seconds": ready_seconds,
                       "guest_uptime": ready["uptime"], "repo": ready["repo"], "seed": ready["seed"], "tried": tried,
                       "memory_snapshot_preserved": preserved, "config_updates": config_updates,
                       "transport": "running-guest", "boot_config_update": False}
            log(f"♻️  resumed pool member {machine_id} in {receipt['ready_seconds']}s (uptime {ready['uptime']}s → memory snapshot {'preserved' if preserved else 'NOT preserved (cold boot)'})")
            return receipt
        except PoolError as error:
            tried.append({"machine": machine_id, "outcome": f"unhealthy: {error}"})
            log(f"⚠️  pool member {machine_id} unhealthy after resume; destroying: {error}")
            try:
                destroy_member(fly, args.pool, machine_id, log)
            except PoolError as cleanup_error:
                log(f"❌ could not destroy unhealthy member {machine_id}: {cleanup_error}")
    return {"machine": None, "tried": tried, "candidates": len(candidates), "members": len(members)}


def release(fly: Fly, args, image, deps, log):
    row = member_or_fail(fly, args.pool, args.machine)
    meta = metadata_of(row)
    reason = None
    if image_digest_of(row) != image or meta.get(f"{TAG}_deps") != deps:
        reason = "digest/deps no longer match"
    elif row.get("state") != "started":
        reason = f"machine state {row.get('state')} is not started"
    else:
        try:
            health = probe(fly, args.machine, "health", args.prep_timeout)
            if not health["pg"]:
                reason = "postgres not accepting connections"
        except PoolError as error:
            reason = f"health probe failed: {error}"
    if reason is None:
        try:
            suspend_member(fly, args.machine, args.suspend_timeout)
            fly.set_metadata(args.machine, f"{TAG}_state", STATE_READY)
            log(f"💤 re-suspended pool member {args.machine} (ready)")
            return {"machine": args.machine, "action": "suspended"}
        except PoolError as error:
            reason = f"suspend failed: {error}"
    log(f"🧹 releasing {args.machine} by destroy: {reason}")
    destroyed = destroy_member(fly, args.pool, args.machine, log)
    return {"machine": args.machine, "action": "destroyed", "reason": reason, **destroyed}


def idle_cost(members, rootfs_gb, volume_sizes):
    rows = []
    for member in members:
        volume_gb = sum(volume_sizes.get(v, 0) for v in member["volumes"])
        per_hour = (rootfs_gb + volume_gb) * STORAGE_USD_PER_GB_MONTH / HOURS_PER_MONTH
        rows.append({"id": member["id"], "state": member["state"], "rootfs_gb": rootfs_gb, "volume_gb": volume_gb,
                     "usd_per_hour": round(per_hour, 6)})
    return rows


def pool_report(fly: Fly, args, members, log):
    volume_sizes = {}
    for member in members:
        for volume in member["volumes"]:
            try:
                volume_sizes[volume] = int(fly.volume(volume).get("size_gb") or 0)
            except PoolError:
                volume_sizes[volume] = 0
    costs = idle_cost(members, args.rootfs_gb, volume_sizes)
    orphans = [{"id": v.get("id"), "name": v.get("name"), "size_gb": v.get("size_gb"), "created_at": v.get("created_at")}
               for v in orphan_pool_volumes(fly)]
    orphan_usd = sum(int(v["size_gb"] or 0) for v in orphans) * STORAGE_USD_PER_GB_MONTH / HOURS_PER_MONTH
    total = round(sum(c["usd_per_hour"] for c in costs) + orphan_usd, 6)
    by_state = {}
    for member in members:
        by_state[member["state"]] = by_state.get(member["state"], 0) + 1
    if orphans:
        log(f"⚠️  {len(orphans)} unattached warmpool_* volume(s) (interrupted provision): {[v['id'] for v in orphans]} — `destroy --all` releases them")
    return {"pool": args.pool, "app": fly.app, "members": members, "by_state": by_state, "cost": costs, "orphan_volumes": orphans,
            "usd_per_hour_total": total, "usd_per_day_total": round(total * 24, 4),
            "pricing_basis": f"Fly list price ${STORAGE_USD_PER_GB_MONTH}/GB/month for stopped-or-suspended rootfs and volumes; "
                             f"rootfs assumed {args.rootfs_gb} GB (not exposed by the Machines API); no CPU/RAM billed while suspended",
            "observed_at": now_iso()}


# ── CLI ──────────────────────────────────────────────────────────────────────

def add_common(parser):
    parser.add_argument("--app", default=os.environ.get("CLOUDBENCH_APP", DEFAULT_APP))
    parser.add_argument("--pool", default=os.environ.get("CLOUDBENCH_WARM_POOL_NAME", DEFAULT_POOL))
    parser.add_argument("--donor", default=os.environ.get("CLOUDBENCH_WARM_MACHINE_NAME", DEFAULT_DONOR))
    parser.add_argument("--token", default=None, help=argparse.SUPPRESS)
    parser.add_argument("--rootfs-gb", type=float, default=DEFAULT_ROOTFS_GB)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--receipt", default=None, help="write the JSON result here as well")
    parser.add_argument("--deps-fingerprint", default=None, help="dependency fingerprint tag (default: hash of manifests)")
    parser.add_argument("--image", default=None, help="image digest tag (default: donor's current digest)")


def add_timeouts(parser):
    parser.add_argument("--start-timeout", type=int, default=300)
    parser.add_argument("--suspend-timeout", type=int, default=300)
    parser.add_argument("--prep-timeout", type=int, default=300)
    parser.add_argument("--volume-timeout", type=int, default=900)


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    status = sub.add_parser("status")
    add_common(status)

    cost = sub.add_parser("cost")
    add_common(cost)

    provision = sub.add_parser("provision")
    add_common(provision)
    add_timeouts(provision)
    provision.add_argument("--size", type=int, default=4)
    provision.add_argument("--cpu-kind", default="shared")
    provision.add_argument("--cpus", type=int, default=4)
    provision.add_argument("--memory", type=int, default=SUSPEND_MAX_MEMORY_MB)
    provision.add_argument("--volume-gb", type=int, default=None)
    provision.add_argument("--region", default="iad")
    provision.add_argument("--fetch-ref", default="main", help="best-effort git fetch inside the guest ('' to skip)")
    provision.add_argument("--max-org-machines", type=int, default=int(os.environ.get("CLOUDBENCH_APP_MACHINE_CEILING", "56")))
    provision.add_argument("--suspend-fallback-memory", type=int, default=0,
                           help="if suspend is refused at --memory, resize the same Machine to this and retry once (0 = off)")
    provision.add_argument("--parallel", type=int, default=4, help="concurrent slot provisioning")

    checkout = sub.add_parser("checkout")
    add_common(checkout)
    add_timeouts(checkout)
    checkout.add_argument("--lease", default=None)
    checkout.add_argument("--lease-settle", type=float, default=0.5)

    # Fleet consumption boundary (scripts/run-bench-fleet provision_primary_machine):
    # checkout for one bench output directory, recording the claim receipt the
    # fleet child and the release step read. Exit 3 (no match) also writes the
    # receipt with "fallback": "clone" so the fleet's clone path stays attributable.
    claim = sub.add_parser("claim")
    add_common(claim)
    add_timeouts(claim)
    claim.add_argument("--out", required=True, help="bench output directory (<out>/warm-pool-claim.json)")
    claim.add_argument("--run-token", default="", help="fleet run token tagged on the member for attribution")
    claim.add_argument("--ref", default="", help="source ref the guest driver will sync (recorded only)")
    claim.add_argument("--lease", default=None)
    claim.add_argument("--lease-settle", type=float, default=0.5)

    rel = sub.add_parser("release")
    add_common(rel)
    add_timeouts(rel)
    rel.add_argument("machine")
    rel.add_argument("--out", default=None, help="bench output directory (<out>/warm-pool-release.json)")

    refresh = sub.add_parser("refresh")
    add_common(refresh)
    add_timeouts(refresh)
    refresh.add_argument("--size", type=int, default=4)
    refresh.add_argument("--cpu-kind", default="shared")
    refresh.add_argument("--cpus", type=int, default=4)
    refresh.add_argument("--memory", type=int, default=SUSPEND_MAX_MEMORY_MB)
    refresh.add_argument("--volume-gb", type=int, default=None)
    refresh.add_argument("--region", default="iad")
    refresh.add_argument("--fetch-ref", default="main")
    refresh.add_argument("--max-org-machines", type=int, default=int(os.environ.get("CLOUDBENCH_APP_MACHINE_CEILING", "56")))
    refresh.add_argument("--parallel", type=int, default=4)
    refresh.add_argument("--suspend-fallback-memory", type=int, default=0)

    destroy = sub.add_parser("destroy")
    add_common(destroy)
    destroy.add_argument("--all", action="store_true")
    destroy.add_argument("machines", nargs="*")
    return parser


def emit(args, payload, log):
    if args.receipt:
        Path(args.receipt).parent.mkdir(parents=True, exist_ok=True)
        Path(args.receipt).write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))


def main(argv=None):
    args = build_parser().parse_args(argv)
    log = (lambda message: print(message, file=sys.stderr, flush=True)) if args.json else (lambda message: print(message, flush=True))
    fly = Fly(args.app, resolve_token(args.token))
    try:
        if args.command in {"status", "cost"}:
            members = [member_summary(row) for row in fly.machines() if is_member(row, args.pool)]
            report = pool_report(fly, args, members, log)
            if not args.json:
                print(f"🏊 pool {args.pool} in {args.app}: {len(members)} member(s) {report['by_state']}")
                for member in members:
                    print(f"   {member['id']} {member['name']} {member['state']:<9} {member['guest']:<22} pool_state={member['pool_state']} image={member['image'][:19]} deps={member['deps'][:12]} ref={member['ref']}")
                print(f"💲 idle cost: ${report['usd_per_hour_total']}/hour (${report['usd_per_day_total']}/day) — {report['pricing_basis']}")
            emit(args, report, log)
            return 0

        if args.command == "destroy":
            members = [member_summary(row) for row in fly.machines() if is_member(row, args.pool)]
            targets = [m["id"] for m in members] if args.all else list(args.machines)
            need(targets or args.all, "nothing to destroy (pass Machine ids or --all)")
            results = [destroy_member(fly, args.pool, machine_id, log) for machine_id in targets]
            released = []
            if args.all:
                for volume in orphan_pool_volumes(fly):
                    fly.destroy_volume(volume["id"])
                    released.append(volume["id"])
                    log(f"🗑️  released orphan pool volume {volume['id']} ({volume.get('name')})")
            emit(args, {"destroyed": results, "orphan_volumes_released": released}, log)
            return 0

        donor = find_donor(fly, args.donor)
        image = args.image or image_digest_of(donor)
        deps = args.deps_fingerprint or default_deps_fingerprint()

        if args.command == "checkout":
            receipt = checkout(fly, args, image, deps, log)
            emit(args, receipt, log)
            if not receipt.get("machine"):
                log(f"🏊 no suspended pool member matches image {image[:19]} deps {deps[:12]} ({receipt.get('candidates', 0)} candidates of {receipt.get('members', 0)}); caller falls back to clone")
                return EXIT_NO_MATCH
            return 0

        if args.command == "claim":
            out = Path(args.out)
            need(out.is_dir() and not out.is_symlink(), f"claim --out {args.out} is not a directory")
            claim_path = out / "warm-pool-claim.json"
            need(not claim_path.exists(), f"{claim_path} already exists; one claim per bench output")
            receipt = checkout(fly, args, image, deps, log)
            receipt.update({"pool": args.pool, "app": fly.app, "run_token": args.run_token, "ref": args.ref,
                            "claimed_at": now_iso()})
            if receipt.get("machine"):
                if args.run_token:
                    fly.set_metadata(receipt["machine"], f"{TAG}_run", args.run_token)
                receipt["fallback"] = None
            else:
                receipt["fallback"] = "clone"
            claim_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
            emit(args, receipt, log)
            if not receipt.get("machine"):
                log(f"🏊 no suspended pool member matches image {image[:19]} deps {deps[:12]} ({receipt.get('candidates', 0)} candidates of {receipt.get('members', 0)}); fleet falls back to clone")
                return EXIT_NO_MATCH
            log(f"🏊 warm pool claim {receipt['machine']} → {claim_path} (transport running-guest; no boot-config update)")
            return 0

        if args.command == "release":
            receipt = release(fly, args, image, deps, log)
            receipt["released_at"] = now_iso()
            if args.out:
                Path(args.out, "warm-pool-release.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
            emit(args, receipt, log)
            return 0

        # provision / refresh
        members = [member_summary(row) for row in fly.machines() if is_member(row, args.pool)]
        destroyed = []
        if args.command == "refresh":
            for member in members:
                if member["pool_state"].startswith(STATE_LEASED):
                    continue
                if member["image"] != image or member["deps"] != deps or member["state"] != "suspended":
                    destroyed.append(destroy_member(fly, args.pool, member["id"], log))
            members = [member_summary(row) for row in fly.machines() if is_member(row, args.pool)]
        ready = matching_ready(members, image, deps)
        leased = [m for m in members if m["pool_state"].startswith(STATE_LEASED)]
        needed = max(0, args.size - len(ready) - len(leased))
        total_machines = len(fly.machines())
        headroom = args.max_org_machines - total_machines
        need(needed <= headroom, f"need {needed} more Machine(s) but app ceiling {args.max_org_machines} leaves {headroom} (observed {total_machines})")
        donor_volume = (volumes_of(donor) or [None])[0]
        need(donor_volume, "donor has no volume to snapshot from")
        snapshot = newest_completed_snapshot(fly.snapshots(donor_volume))
        need(snapshot, f"donor volume {donor_volume} has no completed snapshot")
        if args.volume_gb is None:  # a snapshot restore target must be at least the donor volume's size
            args.volume_gb = int(fly.volume(donor_volume).get("size_gb") or 0) or None
        log(f"🏊 pool {args.pool}: {len(ready)} ready + {len(leased)} leased of {args.size}; provisioning {needed} from donor {donor['id']} snapshot {snapshot['id']} image {image[:19]} deps {deps[:12]}")
        if needed <= 1 or args.parallel <= 1:
            receipts = [provision_one(fly, args, donor, snapshot, image, deps, log) for _ in range(needed)]
        else:
            from concurrent.futures import ThreadPoolExecutor
            with ThreadPoolExecutor(max_workers=min(args.parallel, needed)) as pool:
                receipts = list(pool.map(lambda _: provision_one(fly, args, donor, snapshot, image, deps, log), range(needed)))
        members = [member_summary(row) for row in fly.machines() if is_member(row, args.pool)]
        report = pool_report(fly, args, members, log)
        report.update({"provisioned": receipts, "destroyed": destroyed, "image": image, "deps": deps, "snapshot": snapshot["id"]})
        failures = [r for r in receipts if not r["ok"]]
        if not args.json:
            print(f"✅ pool {args.pool}: {len(matching_ready(members, image, deps))} ready / {len(members)} members; idle ${report['usd_per_hour_total']}/hour")
        emit(args, report, log)
        return 1 if failures else 0
    except PoolError as error:
        log(f"❌ {error}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
