#!/usr/bin/env python3
"""Per-dependency-set warm source Machines and a cross-devbox claim for their maintenance.

Every devbox shares one benchmark app. With ONE `cloudbench-warm` donor, a fleet
whose dependency set differs rebuilt that donor (~20 min) while every other
devbox's fleet waited for it to stop and then failed, and two dependency sets
kept flipping it. This helper gives each dependency set its own warm source and
serialises maintenance of one set across devboxes:

    names   --node-fp N --py-fp P            print "<set> <machine> <volume>"
    claim   acquire|renew|release --set S --owner T [--ttl S] [--wait S]
    claim   hold --set S --owner T --parent-pid PID [--ttl S] [--renew S] [--ready FILE]
    ensure  --node-fp N --py-fp P --owner T  create the set's stopped source if absent
    retire  [--keep K] [--grace S] [--execute]  bounded retention of older sets

Names: `cloudbench-warm-<set>` / `cloudbench_data_<set>`, `<set>` = first 12 hex
of sha256(node_fp NUL py_fp). They never match the reaper's task pattern
`cloudbench-<hex>`, and no reaper-protection metadata is written because task
clones inherit their source's metadata. Clones DO inherit
`rose_cloudbench_warm_source_set`, which is how any devbox sees that a set is
still referenced by a live fleet.

Claim: a Fly-native compare-and-set. The record lives in the base donor's
metadata (`rose_cloudbench_warm_claim_<set>` = "<owner> <expiry-epoch> <host>"),
and every read-check-write runs under a Machines API lease on that donor, held
only for that exchange, so flyctl maintenance of any Machine is not blocked. A
crashed holder's claim simply expires (TTL); `hold` renews it while its parent
lives and releases it on exit. Claims for different sets never contend.

Retention keeps the newest K sets by last use. An older set is retired only when
its Machine is stopped, named and tagged as a warm source, unprotected, unused
for the grace period, unclaimed, and no other Machine references its set; the
destroy is re-verified against a fresh exact read under that set's claim.

Offline tests point FLY_FLAPS_BASE_URL at a fake Machines API
(scripts/tests/cloudbench-warm-source.test.py); nothing here shells out to flyctl.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import runpy
import signal
import socket
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
POOL = runpy.run_path(str(Path(__file__).with_name("cloudbench-warm-pool.py")))
Fly, PoolError, resolve_token = POOL["Fly"], POOL["PoolError"], POOL["resolve_token"]
# Fly caps one /wait at 60 s; the pool helper loops within that bound.
wait_state = POOL["wait_state"]

DEFAULT_APP = "navi-whisper-lux-bench"
BASE_DONOR = "cloudbench-warm"
SET_KEY = "rose_cloudbench_warm_source_set"
LAST_USED_KEY = "rose_cloudbench_warm_source_last_used"
RETAIN_KEY = "rose_cloudbench_warm_source_retain"
CLAIM_PREFIX = "rose_cloudbench_warm_claim_"
SET_RE = re.compile(r"[0-9a-f]{12}")
FP_RE = re.compile(r"[0-9a-f]{64}")
OWNER_RE = re.compile(r"[A-Za-z0-9._:@-]{1,128}")
# Same protected prefixes the stopped-Machine reaper honours (cloudbench-reclaim-stopped.py).
PROTECTED_PREFIXES = ("whm_deploy", "rose_controller", "cloudbench_protected", "polar", "cloudbench_archived_reuse")
GONE = {"destroyed", "destroying"}
COMPLETE_SNAPSHOT = {"created", "complete", "completed", "ready", "available"}
LEASE_TTL_SECONDS = 30
EXIT_TIMEOUT = 3


class WarmSourceError(Exception):
    pass


def need(value, message):
    if not value:
        raise WarmSourceError(message)


def log(message):
    print(message, file=sys.stderr, flush=True)


def dependency_set(node_fp: str, py_fp: str) -> str:
    need(FP_RE.fullmatch(node_fp or "") and FP_RE.fullmatch(py_fp or ""), "dependency fingerprints must be sha256 hex")
    return hashlib.sha256(f"{node_fp}\0{py_fp}".encode()).hexdigest()[:12]


def names(node_fp: str, py_fp: str) -> tuple[str, str, str]:
    value = dependency_set(node_fp, py_fp)
    return value, f"cloudbench-warm-{value}", f"cloudbench_data_{value}"


def metadata_of(row) -> dict:
    return ((row or {}).get("config") or {}).get("metadata") or {}


RATE_LIMIT_ATTEMPTS = 6
RATE_LIMIT_MAX_DELAY = 16.0


def rate_limit_delay(retry_after, attempt):
    """Seconds to wait before retrying a 429: Fly's Retry-After when given, else jittered exponential backoff."""
    try:
        base = float(retry_after)
    except (TypeError, ValueError):
        base = min(2.0 ** attempt, RATE_LIMIT_MAX_DELAY)
    return min(max(base, 0.0), RATE_LIMIT_MAX_DELAY) + random.uniform(0.0, 0.5)


class Api(Fly):
    """Machines API client with the lease and lease-nonce calls this helper needs."""

    def _leased(self, method, path, body, nonce):
        url = f"{self.base}/v1/apps/{self.app}{path}"
        headers = {"Authorization": self.token, "Accept": "application/json", "Content-Type": "application/json",
                   "User-Agent": "rose-cloudbench-warm-source/1"}
        if nonce:
            headers["fly-machine-lease-nonce"] = nonce
        request = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
                                         method=method, headers=headers)
        for attempt in range(RATE_LIMIT_ATTEMPTS):
            self.calls.append((method, path))
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    payload = response.read()
                    return response.status, (json.loads(payload) if payload else None)
            except urllib.error.HTTPError as error:
                # A fleet's concurrent jobs share one warm source: Fly answers its burst of metadata
                # writes with 429 (PR #1928 smoke, 10 of 13 jobs). Back off and retry; any other
                # status, or a 429 that outlasts the bounded attempts, still reaches the caller.
                if error.code != 429 or attempt == RATE_LIMIT_ATTEMPTS - 1:
                    return error.code, None
                time.sleep(rate_limit_delay(error.headers.get("Retry-After"), attempt))
            except (urllib.error.URLError, OSError, ValueError) as error:
                raise WarmSourceError(f"{method} {path} -> {error}") from error
        raise AssertionError("unreachable")

    def acquire_lease(self, machine_id, ttl=LEASE_TTL_SECONDS):
        status, body = self._leased("POST", f"/machines/{machine_id}/lease",
                                    {"ttl": int(ttl), "description": "rose cloudbench warm-source claim"}, None)
        if status == 409:
            return None
        # Fly grants a lease with 201 Created; accept 200 too for older API responses.
        need(status in (200, 201) and isinstance(body, dict), f"lease acquire on {machine_id} -> HTTP {status}")
        nonce = (body.get("data") or {}).get("nonce")
        need(isinstance(nonce, str) and nonce, "lease acquire returned no nonce")
        return nonce

    def release_lease(self, machine_id, nonce):
        self._leased("DELETE", f"/machines/{machine_id}/lease", None, nonce)

    def write_metadata(self, machine_id, key, value, nonce=None):
        status, _ = self._leased("POST", f"/machines/{machine_id}/metadata/{key}", {"value": value}, nonce)
        need(status in (200, 204), f"metadata write {key} on {machine_id} -> HTTP {status}")

    def destroy_stopped(self, machine_id):
        """Non-force destroy: Fly refuses it unless the Machine is stopped."""
        status, _ = self._leased("DELETE", f"/machines/{machine_id}", None, None)
        need(status in (200, 204), f"destroy {machine_id} -> HTTP {status}")

    def delete_metadata(self, machine_id, key, nonce=None):
        status, _ = self._leased("DELETE", f"/machines/{machine_id}/metadata/{key}", None, nonce)
        need(status in (200, 204, 404), f"metadata delete {key} on {machine_id} -> HTTP {status}")


def find_named(api: Api, name: str):
    rows = [row for row in api.machines() if row.get("name") == name and row.get("state") not in GONE]
    need(len(rows) <= 1, f"ambiguous Machines named {name}")
    return rows[0] if rows else None


def base_donor(api: Api, name: str):
    row = find_named(api, name)
    need(row and row.get("id"), f"base warm donor '{name}' not found in {api.app}")
    return row


# ── cross-devbox claim ───────────────────────────────────────────────────────

def parse_claim(value):
    fields = str(value or "").split()
    if len(fields) != 3 or not OWNER_RE.fullmatch(fields[0]) or not fields[1].isdigit():
        return None
    return {"owner": fields[0], "expires": int(fields[1]), "host": fields[2]}


def claim_exchange(api: Api, donor_id: str, set_id: str, decide, *, lease_wait=60, clock=time.time, sleep=time.sleep):
    """Run decide(current_claim) -> (new_value | None to delete | Ellipsis to keep) under a short lease."""
    key = CLAIM_PREFIX + set_id
    deadline = clock() + lease_wait
    while True:
        nonce = api.acquire_lease(donor_id)
        if nonce:
            break
        need(clock() < deadline, "base donor lease stayed held; claim exchange not attempted")
        sleep(1)
    try:
        current = parse_claim(metadata_of(api.machine(donor_id)).get(key))
        outcome, value = decide(current)
        if value is None:
            api.delete_metadata(donor_id, key, nonce)
        elif value is not Ellipsis:
            api.write_metadata(donor_id, key, value, nonce)
        return outcome, current
    finally:
        api.release_lease(donor_id, nonce)


def claim_acquire(api, donor_id, set_id, owner, ttl, wait, poll=10, clock=time.time, sleep=time.sleep):
    need(OWNER_RE.fullmatch(owner or ""), "invalid claim owner token")
    need(SET_RE.fullmatch(set_id or ""), "invalid dependency set")
    started = clock()
    announced = None
    while True:
        now = int(clock())

        def decide(current):
            if current is None or current["owner"] == owner or current["expires"] <= now:
                return True, f"{owner} {now + int(ttl)} {socket.gethostname()}"
            return False, Ellipsis

        acquired, current = claim_exchange(api, donor_id, set_id, decide, clock=clock, sleep=sleep)
        if acquired:
            if current and current["owner"] != owner:
                log(f"♻️  warm source {set_id}: took over expired claim of {current['owner']}@{current['host']}")
            return True
        waited = int(clock() - started)
        if waited >= wait:
            log(f"❌ warm source {set_id}: claim held by {current['owner']}@{current['host']} for the whole {wait}s wait")
            return False
        if announced is None or waited - announced >= 30:
            log(f"⏳ warm source {set_id}: maintenance claimed by {current['owner']}@{current['host']} "
                f"(expires in {max(0, current['expires'] - now)}s); waiting {waited}s/{wait}s")
            announced = waited
        sleep(min(poll, max(1, wait - waited)))


def claim_renew(api, donor_id, set_id, owner, ttl, clock=time.time):
    now = int(clock())

    def decide(current):
        if current and current["owner"] == owner:
            return True, f"{owner} {now + int(ttl)} {socket.gethostname()}"
        return False, Ellipsis

    renewed, _ = claim_exchange(api, donor_id, set_id, decide, clock=clock)
    return renewed


def claim_release(api, donor_id, set_id, owner):
    def decide(current):
        if current and current["owner"] == owner:
            return True, None
        return False, Ellipsis

    released, _ = claim_exchange(api, donor_id, set_id, decide)
    return released


def parent_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def claim_hold(api, donor_id, set_id, owner, ttl, wait, renew, parent_pid, ready_file=None):
    """Acquire, then renew while the parent lives; release on parent exit or TERM/INT."""
    need(0 < renew < ttl, "renew interval must be shorter than the claim TTL")
    stop = []
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda *_a: stop.append(True))
    if not claim_acquire(api, donor_id, set_id, owner, ttl, wait):
        return EXIT_TIMEOUT
    try:
        if ready_file:
            Path(ready_file).write_text(f"{set_id} {owner}\n")
        last = time.monotonic()
        while not stop and parent_alive(parent_pid):
            time.sleep(1)
            if time.monotonic() - last >= renew:
                if not claim_renew(api, donor_id, set_id, owner, ttl):
                    log(f"❌ warm source {set_id}: claim was lost before renewal")
                    return 1
                last = time.monotonic()
        return 0
    finally:
        claim_release(api, donor_id, set_id, owner)


# ── per-set source materialisation ──────────────────────────────────────────

def newest_complete_snapshot(records):
    complete = [row for row in records or [] if row.get("id")
                and str(row.get("status") or row.get("state") or "").lower() in COMPLETE_SNAPSHOT
                and int(row.get("size") or 0) > 0]
    complete.sort(key=lambda row: str(row.get("created_at") or ""), reverse=True)
    return complete[0] if complete else None


def wait_until(probe, seconds, what, sleep=time.sleep):
    deadline = time.monotonic() + seconds
    while True:
        if probe():
            return
        need(time.monotonic() < deadline, f"timed out waiting for {what}")
        sleep(2)


def source_config(donor, set_id, volume_id, now):
    config = json.loads(json.dumps(donor.get("config") or {}))
    config["mounts"] = [{"volume": volume_id, "path": "/data"}]
    config["restart"] = {"policy": "no"}
    config["auto_destroy"] = False
    metadata = {key: value for key, value in (config.get("metadata") or {}).items()
                # The base donor's dependency proofs name its own volume, and its
                # claims are not this Machine's; neither carries over.
                if not key.startswith(("rose_cloudbench_deps_", CLAIM_PREFIX, "rose_cloudbench_warm_source"))}
    metadata.update({SET_KEY: set_id, LAST_USED_KEY: str(int(now))})
    config["metadata"] = metadata
    return config


LAST_USED_FRESH_SECONDS = 600


def touch_last_used(api, machine_id):
    """Mark this set's warm source used. A fleet's concurrent jobs all touch one Machine; when Fly keeps
    throttling (HTTP 429 past the client's backoff), a peer's write in the same burst already keeps the
    source fresh for retention, so a recent recorded value satisfies the touch. Anything else still fails."""
    try:
        api.write_metadata(machine_id, LAST_USED_KEY, str(int(time.time())))
    except WarmSourceError as error:
        if "HTTP 429" not in str(error):
            raise
        row = next((r for r in api.machines() if r.get("id") == machine_id), None)
        try:
            recorded = float(metadata_of(row).get(LAST_USED_KEY, "0"))
        except ValueError:
            recorded = 0.0
        if time.time() - recorded > LAST_USED_FRESH_SECONDS:
            raise
        log(f"warm source {machine_id}: last-used write throttled (429); a peer recorded it "
            f"{int(time.time() - recorded)}s ago")


def ensure(api, node_fp, py_fp, owner, *, base=BASE_DONOR, ttl=1800, wait=3600, timeout=600):
    """Return (set, machine, volume) names, creating the set's stopped warm source once."""
    set_id, machine_name, volume_name = names(node_fp, py_fp)
    existing = find_named(api, machine_name)
    if existing:
        need(metadata_of(existing).get(SET_KEY) == set_id, f"{machine_name} is not tagged as this set's warm source")
        touch_last_used(api, existing["id"])
        return set_id, machine_name, volume_name
    donor = base_donor(api, base)
    if not claim_acquire(api, donor["id"], set_id, owner, ttl, wait):
        raise WarmSourceError(f"could not claim warm source {set_id} within {wait}s")
    try:
        existing = find_named(api, machine_name)
        if existing:  # a peer created it while this request waited
            touch_last_used(api, existing["id"])
            return set_id, machine_name, volume_name
        mounts = (donor.get("config") or {}).get("mounts") or []
        need(len(mounts) == 1 and mounts[0].get("volume"), "base donor must mount exactly one volume")
        donor_volume = api.volume(mounts[0]["volume"])
        snapshot = newest_complete_snapshot(api.snapshots(mounts[0]["volume"]))
        need(snapshot, "base donor volume has no complete snapshot to fork")
        region = donor.get("region")
        need(region, "base donor region unknown")
        # A create interrupted before its Machine existed leaves this exact
        # unattached volume; reuse it instead of allocating a duplicate.
        volume = next((v for v in api.volumes() if v.get("name") == volume_name and v.get("region") == region
                       and not v.get("attached_machine_id")
                       and str(v.get("state") or "").lower() not in {"destroyed", "destroying", "pending_destroy"}),
                      None)
        if volume:
            log(f"♻️  warm source {set_id}: reusing unattached {volume_name} {volume['id']}")
        else:
            log(f"🌱 warm source {set_id}: forking {volume_name} from {base} snapshot {snapshot['id']} ({region})")
            volume = api.create_volume({"name": volume_name, "region": region, "snapshot_id": snapshot["id"],
                                        "size_gb": int(donor_volume.get("size_gb") or 0) or None})
        need(volume and volume.get("id"), "volume create returned no id")
        wait_until(lambda: str(api.volume(volume["id"]).get("state") or "").lower() == "created",
                   timeout, f"volume {volume['id']}")
        machine = api.create_machine({"name": machine_name, "region": region,
                                      "config": source_config(donor, set_id, volume["id"], time.time())})
        need(machine and machine.get("id"), "machine create returned no id")
        # Fleets and maintenance require a STOPPED source; a created-only Machine is not one.
        wait_state(api, machine["id"], "started", 120)
        api.stop(machine["id"])
        wait_state(api, machine["id"], "stopped", 120)
        log(f"✅ warm source {set_id}: {machine_name} ({machine['id']}) stopped on {volume['id']}")
        return set_id, machine_name, volume_name
    finally:
        claim_release(api, donor["id"], set_id, owner)


# ── bounded retention ───────────────────────────────────────────────────────

def retention_plan(machines, *, keep, grace, now, base=BASE_DONOR, claims=None):
    """Return ([kept set ids], [(row, set) to retire], {set: reason kept})."""
    claims = claims or {}
    sources = []
    for row in machines:
        set_id = metadata_of(row).get(SET_KEY, "")
        if (row.get("name") == f"cloudbench-warm-{set_id}" and SET_RE.fullmatch(set_id)
                and row.get("name") != base and row.get("state") not in GONE):
            sources.append((row, set_id))
    def last_used(item):
        value = metadata_of(item[0]).get(LAST_USED_KEY, "0")
        return int(value) if str(value).isdigit() else 0
    sources.sort(key=last_used, reverse=True)
    kept, retire, reasons = [], [], {}
    for index, (row, set_id) in enumerate(sources):
        metadata = metadata_of(row)
        referenced = any(other.get("id") != row.get("id") and other.get("state") not in GONE
                         and metadata_of(other).get(SET_KEY) == set_id for other in machines)
        claim = parse_claim(claims.get(set_id))
        reason = ("within newest retention" if index < keep
                  else "not stopped" if row.get("state") != "stopped"
                  else "protected" if metadata.get(RETAIN_KEY) == "1"
                  or any(key.startswith(PROTECTED_PREFIXES) for key in metadata)
                  else "recently used" if now - last_used((row, set_id)) < grace
                  else "claimed" if claim and claim["expires"] > now
                  else "referenced by a live Machine" if referenced
                  else None)
        if reason:
            kept.append(set_id)
            reasons[set_id] = reason
        else:
            retire.append((row, set_id))
    return kept, retire, reasons


def retire(api, owner, *, keep, grace, execute, base=BASE_DONOR, timeout=300):
    donor = base_donor(api, base)
    claims = {key[len(CLAIM_PREFIX):]: value for key, value in metadata_of(donor).items()
              if key.startswith(CLAIM_PREFIX)}
    machines = api.machines()
    kept, candidates, reasons = retention_plan(machines, keep=keep, grace=grace, now=time.time(),
                                               base=base, claims=claims)
    for set_id in kept:
        log(f"🧊 keep warm source {set_id}: {reasons[set_id]}")
    retired = []
    for row, set_id in candidates:
        log(f"🗑️  {'retiring' if execute else 'would retire'} warm source {set_id} ({row['id']})")
        if not execute:
            continue
        if not claim_acquire(api, donor["id"], set_id, owner, ttl=timeout * 2, wait=0):
            log(f"⏭️  warm source {set_id}: claimed by another devbox; not retired")
            continue
        try:
            fresh = api.machines()
            current = next((m for m in fresh if m.get("id") == row["id"]), None)
            _, again, _ = retention_plan(fresh, keep=keep, grace=grace, now=time.time(), base=base)
            if (not current or current.get("instance_id") != row.get("instance_id")
                    or all(m.get("id") != row["id"] for m, _ in again)):
                log(f"⏭️  warm source {set_id}: changed since planning; not retired")
                continue
            volumes = [m.get("volume") for m in (current.get("config") or {}).get("mounts") or []]
            api.destroy_stopped(row["id"])
            wait_until(lambda: all(m.get("id") != row["id"] or m.get("state") in GONE for m in api.machines()),
                       timeout, f"Machine {row['id']} destroy")
            for volume_id in volumes:
                volume = api.volume(volume_id)
                if volume.get("name") == f"cloudbench_data_{set_id}" and not volume.get("attached_machine_id"):
                    api.destroy_volume(volume_id)
            retired.append(set_id)
        finally:
            claim_release(api, donor["id"], set_id, owner)
    return retired


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--app", default=os.environ.get("CLOUDBENCH_APP", DEFAULT_APP))
    parser.add_argument("--base", default=BASE_DONOR)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("names", "ensure"):
        command = sub.add_parser(name)
        command.add_argument("--node-fp", required=True)
        command.add_argument("--py-fp", required=True)
        if name == "ensure":
            command.add_argument("--owner", required=True)
            command.add_argument("--wait", type=int, default=3600)
    claim = sub.add_parser("claim")
    claim.add_argument("action", choices=["acquire", "renew", "release", "hold"])
    claim.add_argument("--set", required=True)
    claim.add_argument("--owner", required=True)
    claim.add_argument("--ttl", type=int, default=900)
    claim.add_argument("--wait", type=int, default=3600)
    claim.add_argument("--renew", type=int, default=120)
    claim.add_argument("--parent-pid", type=int, default=os.getppid())
    claim.add_argument("--ready")
    retirement = sub.add_parser("retire")
    retirement.add_argument("--owner", default=f"retire-{socket.gethostname()}-{os.getpid()}")
    retirement.add_argument("--keep", type=int, default=3)
    retirement.add_argument("--grace", type=int, default=86400)
    retirement.add_argument("--execute", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.command == "names":
            print(*names(args.node_fp, args.py_fp))
            return 0
        api = Api(args.app, resolve_token())
        if args.command == "ensure":
            print(*ensure(api, args.node_fp, args.py_fp, args.owner, base=args.base, wait=args.wait))
            return 0
        if args.command == "retire":
            need(args.keep >= 1 and args.grace >= 0, "retention must keep at least one set")
            print(" ".join(retire(api, args.owner, keep=args.keep, grace=args.grace,
                                  execute=args.execute, base=args.base)))
            return 0
        donor = base_donor(api, args.base)
        if args.action == "acquire":
            return 0 if claim_acquire(api, donor["id"], args.set, args.owner, args.ttl, args.wait) else EXIT_TIMEOUT
        if args.action == "renew":
            return 0 if claim_renew(api, donor["id"], args.set, args.owner, args.ttl) else 1
        if args.action == "release":
            return 0 if claim_release(api, donor["id"], args.set, args.owner) else 1
        return claim_hold(api, donor["id"], args.set, args.owner, args.ttl, args.wait, args.renew,
                          args.parent_pid, args.ready)
    except (WarmSourceError, PoolError) as error:
        log(f"❌ {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
