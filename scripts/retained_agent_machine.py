#!/usr/bin/env python3
"""Native Fly leases and CAS for explicitly released, same-app worker spares.

The cutover script owns retries, queue draining, starts and pointer publication.
This helper never creates, starts, stops or destroys a Machine. Retirement only
adds metadata; reuse preserves the complete native config except image, worker
generation fields and our pool marker. An owner-issued custody record is required
before an image update can consume a retired Machine.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import sys
from contextlib import contextmanager
from time import monotonic, sleep
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

POOL_KEY = "rose_cooperative_worker_pool"
CUSTODY_KEY = "rose_worker_reuse_custody"
API = "https://api.machines.dev/v1"
SPARE_SURFACE = "pool-unassigned"


def config_digest(config):
    config = copy.deepcopy(config)
    metadata = config.get("metadata", {})
    for key in (POOL_KEY, CUSTODY_KEY):
        metadata.pop(key, None)
    if not metadata:
        config.pop("metadata", None)
    return hashlib.sha256(json.dumps(config, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def managed_worker_command(queue):
    """Bind the worker selector after Fly merges app secrets over config.env."""
    base, separator, surface = queue.rpartition("@")
    if not separator or not re.fullmatch(r"[A-Za-z0-9._-]+", base) or not surface:
        raise ValueError("Managed worker startup requires an exact generation queue")
    return ["/usr/bin/env", f"TEMPORAL_TASK_QUEUE={base}", "python", "worker.py"]


def bind_managed_worker_startup(config, queue):
    if config.get("processes") or config.get("containers"):
        raise ValueError("Managed worker process/container layout is not canonical")
    init = config.setdefault("init", {})
    if not isinstance(init, dict):
        raise ValueError("Managed worker init layout is not canonical")
    existing = init.get("exec")
    known = (
        isinstance(existing, list)
        and len(existing) == 4
        and existing[0] == "/usr/bin/env"
        and isinstance(existing[1], str)
        and re.fullmatch(r"TEMPORAL_TASK_QUEUE=[A-Za-z0-9._-]+", existing[1])
        and existing[2:] == ["python", "worker.py"]
    )
    if init.get("entrypoint") or init.get("cmd") not in (None, [], ["python", "worker.py"]):
        raise ValueError("Managed worker image startup contract is not canonical")
    if existing not in (None, []) and not known:
        raise ValueError("Managed worker init.exec is not canonical")
    init["exec"] = managed_worker_command(queue)


def record(machine, app):
    config = machine["config"]
    env = config.get("env", {})
    value = {
        "app": app,
        "id": machine["id"],
        "instance_id": machine["instance_id"],
        "config_sha256": config_digest(config),
        "hash": env.get("TEMPORAL_WORKER_SURFACE_HASH"),
        "build": env.get("TEMPORAL_WORKER_BUILD_ID"),
        "token": env.get("TEMPORAL_WORKER_DEPLOYMENT_TOKEN"),
    }
    if env.get("TEMPORAL_WORKER_POOL_QUEUE"):
        value["queue"] = env["TEMPORAL_WORKER_POOL_QUEUE"]
    return value


def metadata(machine, key):
    try:
        # The Machines API can return a stopped Machine with "config": null.
        value = json.loads(((machine.get("config") or {}).get("metadata") or {}).get(key, "null"))
        return value if isinstance(value, dict) else {}
    except (AttributeError, ValueError, TypeError):
        return {}


def custody_ready(machine, app):
    custody = metadata(machine, CUSTODY_KEY)
    source = record(machine, app)
    return (
        custody.get("version") == 1
        and all(custody.get(key) == source[key] for key in ("app", "id", "instance_id", "config_sha256"))
        and isinstance(custody.get("evidence_ref"), str)
        and custody["evidence_ref"].startswith("https://")
        and custody.get("rootfs_disposition") in ("stateless", "archived")
    )


def active_owner(machine, app):
    values = machine["config"].get("metadata", {})
    if values.get("rose_worker_reuse_protected"):
        return False
    if POOL_KEY not in values:
        return True
    pool = metadata(machine, POOL_KEY)
    source = record(machine, app)
    attempt = {"build": source["build"], "token": source["token"]}
    return (
        pool.get("version") == 1
        and pool.get("phase") == "active"
        and pool.get("app") == app
        and pool.get("id") == machine["id"]
        and pool.get("hash") == source["hash"]
        and bool(attempt["build"])
        and bool(attempt["token"])
        and (all(pool.get(key) == value for key, value in attempt.items()) or pool.get("rolling") == attempt)
    )


def eligible(machine, app, live_hash, live_queue=None):
    try:
        pool = metadata(machine, POOL_KEY)
        source = record(machine, app)
        return (
            (machine["state"] == "stopped" or (machine["state"] == "created" and pool.get("origin") == "preallocated"))
            and bool(live_hash)
            and all(source.get(key) for key in ("hash", "build", "token", "instance_id"))
            and (
                source.get("queue") != live_queue if live_queue and source.get("queue") else source["hash"] != live_hash
            )
            # Persisted overlays can mask the newly pinned worker image. They
            # remain retained, but require a separate data/source migration.
            and (machine["config"].get("rootfs") or {}).get("persist") in (None, "", "never", 0)
            and (machine["config"].get("guest") or {}).get("persist_rootfs") in (None, "", "never", 0)
            and not machine["config"].get("metadata", {}).get("rose_worker_reuse_protected")
            and pool.get("version") == 1
            and pool.get("phase") == "idle"
            and pool.get("source") == source
            and isinstance(pool.get("retired_by"), dict)
            and bool(pool.get("retired_by", {}).get("build"))
            and bool(pool.get("retired_by", {}).get("token"))
            and pool.get("drained_queue") == source.get("queue", f"navi-agent-tasks@{source['hash']}")
            and custody_ready(machine, app)
        )
    except (AttributeError, KeyError, TypeError):
        # A Machine whose config is null or malformed is never reusable.
        return False


def reserved(machine, args):
    """A reservation keeps its source snapshot until the pinned image is written."""
    try:
        marker = metadata(machine, POOL_KEY)
        return (
            marker.get("version") == 1
            and marker.get("phase") == "reserved"
            and marker.get("job") == args.job
            and marker.get("target")
            == {
                "hash": args.hash,
                "build": args.build,
                "token": args.token,
            }
            and marker.get("source") == record(machine, args.app)
            and machine["state"] in ("stopped", "created")
            and custody_ready(machine, args.app)
            and not machine["config"].get("metadata", {}).get("rose_worker_reuse_protected")
        )
    except (AttributeError, KeyError, TypeError):
        return False


def initial_spare(machine, app, live_hash):
    """Only deliberately enrolled, never-production pool entries bypass drain."""
    return (
        eligible(machine, app, live_hash)
        and record(machine, app)["hash"] == SPARE_SURFACE
        and metadata(machine, POOL_KEY).get("origin") == "preallocated"
        and metadata(machine, CUSTODY_KEY).get("rootfs_disposition") == "stateless"
        and machine["config"].get("env", {}).get("TEMPORAL_WORKER_POOL_SPARE") == "1"
    )


# Transient Machines API failures (408/429/5xx, reset, read timeout) killed
# production cutovers on single reads (2026-10-20, 2026-10-26). Only requests
# that cannot change native state are replayed; a write's outcome after one
# of these failures is unknown, so writes are sent exactly once.
TRANSIENT_ATTEMPTS = 3


def transient(exc):
    if isinstance(exc, HTTPError):
        return exc.code in (408, 429) or 500 <= exc.code < 600
    return isinstance(exc, (URLError, ConnectionError, TimeoutError))


def backoff(attempt):
    return min(2**attempt, 8)


def replay_transient(call, attempts=TRANSIENT_ATTEMPTS):
    for attempt in range(attempts):
        try:
            return call()
        except Exception as exc:
            if attempt == attempts - 1 or not transient(exc):
                raise
        sleep(backoff(attempt))


# Fly answers /wait with 408 while the exact version is still replacing. A
# new-image update on a stopped worker took 489s on 2026-11-15 (run
# 43666358952), past the old 9 x 20s budget. Wait until a deadline instead,
# refreshing our own lease long before its TTL can lapse.
STOPPED_WAIT_SECONDS = 20
STOPPED_WAIT_DEADLINE_SECONDS = 900
LEASE_TTL_SECONDS = 500
LEASE_REFRESH_AFTER_SECONDS = 240


def wait_stopped(fly, version):
    """408 means still replacing and waits to the deadline; other transient failures stay bounded."""
    deadline = monotonic() + STOPPED_WAIT_DEADLINE_SECONDS
    failures = 0
    while True:
        fly.keep_lease()
        try:
            return fly.request(
                "GET",
                f"/wait?state=stopped&instance_id={quote(version, safe='')}&timeout={STOPPED_WAIT_SECONDS}",
                replay=False,
            )
        except Exception as exc:
            if not transient(exc) or monotonic() >= deadline:
                raise
            if isinstance(exc, HTTPError) and exc.code == 408:
                failures = 0
                sleep(1)
                continue
            failures += 1
            if failures >= TRANSIENT_ATTEMPTS:
                raise
            sleep(backoff(failures - 1))


class Fly:
    def __init__(self, app, machine_id):
        self.path = f"/apps/{quote(app, safe='')}/machines/{quote(machine_id, safe='')}"
        self.nonce = None
        self.leased_at = None

    def request(self, method, suffix="", data=None, *, timeout=30, replay=None):
        """GETs replay transient failures; a write replays only when its caller proves it idempotent."""
        headers = {
            "Authorization": f"Bearer {os.environ['FLY_API_TOKEN']}",
            "Content-Type": "application/json",
        }
        if self.nonce:
            headers["fly-machine-lease-nonce"] = self.nonce
        body = None if data is None else json.dumps(data).encode()

        def once():
            with urlopen(
                Request(API + self.path + suffix, data=body, headers=headers, method=method),
                timeout=timeout,
            ) as response:
                raw = response.read()
                return json.loads(raw) if raw else None

        return replay_transient(once, TRANSIENT_ATTEMPTS if (method == "GET" if replay is None else replay) else 1)

    def keep_lease(self):
        """Extend our own lease during a long native wait (fly-go RefreshLease).

        The refresh is bound to our nonce and only re-extends our own lease, so
        replaying it after a transient failure is idempotent; a lost lease is
        refused natively or answered with another holder and fails closed.
        """
        if not self.nonce or monotonic() - self.leased_at < LEASE_REFRESH_AFTER_SECONDS:
            return
        granted = self.request("POST", f"/lease?ttl={LEASE_TTL_SECONDS}", replay=True)
        if not isinstance(granted, dict) or (granted.get("data") or {}).get("nonce") != self.nonce:
            raise ValueError("Native lease refresh did not extend this owner's lease")
        self.leased_at = monotonic()

    @contextmanager
    def lease(self):
        self.nonce = self.request(
            "POST", "/lease", {"ttl": LEASE_TTL_SECONDS, "description": "cooperative-worker-pool"}
        )["data"]["nonce"]
        self.leased_at = monotonic()
        try:
            yield
        finally:
            original_error = sys.exc_info()[0] is not None
            try:
                self.request("DELETE", "/lease")
            except Exception:
                if not original_error:
                    raise
                print(
                    "Worker pool lease release failed; original failure retained",
                    file=sys.stderr,
                )
            finally:
                self.nonce = None


def operate(args, expected, fly):
    if expected.get("id") != args.id:
        raise ValueError("Expected Machine ID does not match the owned snapshot")
    if args.action != "enroll":
        owned_mutation = getattr(fly, "assert_managed_mutable", None)
        if not callable(owned_mutation):
            raise ValueError("Pool mutations require the lease-owned canonical controller")
        owned_mutation()
    with fly.lease():
        current = fly.request("GET")
        if current.get("id") != args.id:
            raise ValueError("Fly returned a different Machine")
        source = record(expected, args.app)
        if args.action == "enroll":
            if (
                record(current, args.app) != source
                or current["state"] not in ("stopped", "created")
                or source["hash"] != SPARE_SURFACE
                or not custody_ready(current, args.app)
                or metadata(current, CUSTODY_KEY).get("rootfs_disposition") != "stateless"
                or (current["config"].get("rootfs") or {}).get("persist") not in (None, "", "never", 0)
                or (current["config"].get("guest") or {}).get("persist_rootfs") not in (None, "", "never", 0)
                or current["config"].get("env", {}).get("TEMPORAL_WORKER_POOL_SPARE") != "1"
                or current["config"].get("metadata", {}).get("rose_worker_reuse_protected")
            ):
                raise ValueError("Only an explicitly stateless unassigned spare may be enrolled")
            marker = {
                "version": 1,
                "phase": "idle",
                "origin": "preallocated",
                "source": source,
                "drained_queue": f"navi-agent-tasks@{SPARE_SURFACE}",
                "retired_by": {"build": args.build, "token": args.token},
            }
            prior = metadata(current, POOL_KEY)
            if prior and prior != marker:
                raise ValueError("Preallocated enrollment cannot overwrite another owner")
            if prior != marker:
                fly.request(
                    "POST",
                    f"/metadata/{POOL_KEY}",
                    {"value": json.dumps(marker, sort_keys=True)},
                )
            if not initial_spare(fly.request("GET"), args.app, args.live_hash):
                raise ValueError("Preallocated spare enrollment was not verified")
        elif args.action == "reserve":
            if not getattr(args, "job", None):
                raise ValueError("A durable deployment job is required for reservation")
            if reserved(current, args):
                return {"id": args.id, "action": args.action, "verified": True}
            if record(current, args.app) != source or not eligible(
                current, args.app, args.live_hash, getattr(args, "live_queue", None)
            ):
                raise ValueError("Only an unchanged released Machine may be reserved")
            marker = {
                "version": 1,
                "phase": "reserved",
                "job": args.job,
                "source": source,
                "previous": metadata(current, POOL_KEY),
                "target": {"hash": args.hash, "build": args.build, "token": args.token},
            }
            fly.request(
                "POST",
                f"/metadata/{POOL_KEY}",
                {"value": json.dumps(marker, sort_keys=True)},
            )
            verified = fly.request("GET")
            if not reserved(verified, args):
                raise ValueError("Native reservation did not preserve its source")
        elif args.action == "release-reservation":
            if not getattr(args, "job", None) or not reserved(current, args):
                raise ValueError("Only the unchanged owning reservation may be released")
            marker = metadata(current, POOL_KEY)
            restored = copy.deepcopy(current)
            restored["config"]["metadata"][POOL_KEY] = json.dumps(marker.get("previous"))
            if record(current, args.app) != source or not eligible(
                restored, args.app, args.live_hash, getattr(args, "live_queue", None)
            ):
                raise ValueError("Reservation source is not a reusable idle Machine")
            fly.request("POST", f"/metadata/{POOL_KEY}", {"value": json.dumps(marker["previous"], sort_keys=True)})
            verified = fly.request("GET")
            if record(verified, args.app) != source or not eligible(
                verified, args.app, args.live_hash, getattr(args, "live_queue", None)
            ):
                raise ValueError("Reservation release was not verified")
        elif args.action == "reuse":
            if not re.fullmatch(r"[A-Za-z0-9._-]+@" + re.escape(args.hash), args.queue) or (
                args.queue == getattr(args, "live_queue", None)
                if getattr(args, "live_queue", None)
                else args.hash == args.live_hash
            ):
                raise ValueError("Reuse requires a different, exact target generation queue")
            if not (
                reserved(expected, args)
                if getattr(args, "job", None)
                else eligible(expected, args.app, args.live_hash, getattr(args, "live_queue", None))
            ):
                raise ValueError("Machine lacks an eligible stopped, drained custody record")
            config = copy.deepcopy(expected["config"])
            config["image"] = args.image
            config.setdefault("env", {}).update(
                {
                    "TEMPORAL_WORKER_BUILD_ID": args.build,
                    "TEMPORAL_WORKER_SURFACE_HASH": args.hash,
                    "TEMPORAL_WORKER_DEPLOYMENT_TOKEN": args.token,
                    "TEMPORAL_WORKER_REQUIRE_ACTIVATION": "0",
                }
            )
            config["env"].pop("TEMPORAL_WORKER_POOL_SPARE", None)
            if getattr(args, "job", None):
                bind_managed_worker_startup(config, args.queue)
                config["env"].update(
                    {
                        "TEMPORAL_TASK_QUEUE": args.queue.rsplit("@", 1)[0],
                        "TASK_QUEUE": args.queue.rsplit("@", 1)[0],
                        "TEMPORAL_WORKER_POOL_QUEUE": args.queue,
                        "AUTOSCALER_ACTUATE": "0",
                        "PEOPLE_CREDENTIAL_BROKER_URL": "https://navi-j9a9.onrender.com",
                    }
                )
            marker = {
                "version": 1,
                "phase": "active",
                "app": args.app,
                "id": args.id,
                "hash": args.hash,
                "build": args.build,
                "token": args.token,
            }
            if getattr(args, "job", None):
                marker["job"] = args.job
                marker["source"] = source
                marker["configSHA256"] = config_digest(config)
            config.setdefault("metadata", {})[POOL_KEY] = json.dumps(marker, sort_keys=True)
            # Reconcile a native update whose response was lost, under the same
            # lease and attempt. A different owner/attempt is never adopted.
            already_updated = (
                config_digest(current["config"]) == config_digest(config) and metadata(current, POOL_KEY) == marker
            )
            if not already_updated:
                selected = (
                    reserved(current, args)
                    if getattr(args, "job", None)
                    else eligible(current, args.app, args.live_hash, getattr(args, "live_queue", None))
                )
                if record(current, args.app) != source or not selected:
                    raise ValueError("Stopped Machine changed before its leased reuse")
                updated = fly.request(
                    "POST",
                    data={
                        "config": config,
                        "current_version": current["instance_id"],
                        "skip_launch": True,
                    },
                )
                if (
                    not isinstance(updated, dict)
                    or updated.get("id") != args.id
                    or not isinstance(updated.get("instance_id"), str)
                    or not updated["instance_id"]
                    or updated["instance_id"] == current["instance_id"]
                    or config_digest(updated.get("config", {})) != config_digest(config)
                    or metadata(updated, POOL_KEY) != marker
                ):
                    raise ValueError("Native update acknowledgement does not match the requested worker configuration")
                # An accepted update can still expose the old, replacing
                # instance through GET. Wait for the acknowledged version;
                # neither another update nor a matching old version is proof.
                updated_version = updated["instance_id"]
            else:
                updated_version = current["instance_id"]
            if not isinstance(updated_version, str) or not updated_version:
                raise ValueError("Native updated worker has no exact instance version")
            # A lost acknowledgement can leave the exact target version still
            # replacing. Both paths require native stopped-state confirmation.
            completed = wait_stopped(fly, updated_version)
            if not isinstance(completed, dict) or completed.get("ok") is not True:
                raise ValueError("Native updated worker did not reach its stopped state")
            verified = fly.request("GET")
            if (
                verified.get("id") != args.id
                or verified.get("instance_id") != updated_version
                or verified.get("state") != "stopped"
                or config_digest(verified["config"]) != config_digest(config)
                or metadata(verified, POOL_KEY) != marker
            ):
                raise ValueError("Native update did not preserve the expected worker configuration")
            # A stateless grant follows this exact, verified image/env update.
            # An archive of the old runtime cannot certify newly written data.
            custody = metadata(expected, CUSTODY_KEY)
            if custody.get("rootfs_disposition") == "stateless":
                refreshed = copy.deepcopy(custody)
                refreshed.update(
                    {
                        key: value
                        for key, value in record(verified, args.app).items()
                        if key in ("app", "id", "instance_id", "config_sha256")
                    }
                )
                if metadata(verified, CUSTODY_KEY) != refreshed:
                    fly.request(
                        "POST",
                        f"/metadata/{CUSTODY_KEY}",
                        {"value": json.dumps(refreshed, sort_keys=True)},
                    )
                final = fly.request("GET")
                if (
                    record(final, args.app) != record(verified, args.app)
                    or metadata(final, POOL_KEY) != marker
                    or metadata(final, CUSTODY_KEY) != refreshed
                    or not custody_ready(final, args.app)
                ):
                    raise ValueError("Stateless pool custody was not retained")
        elif args.action in ("activate", "prepare-roll"):
            # flyctl owns the rolling update and health checks. Only refresh
            # metadata on its explicitly selected, now-updated native snapshot.
            if (
                record(current, args.app) != source
                or current["state"] != "started"
                or source["hash"] != args.hash
                or args.live_hash != args.hash
                or not active_owner(current, args.app)
                or (args.action == "activate" and (source["build"] != args.build or source["token"] != args.token))
            ):
                raise ValueError("Rolling activation does not match its live owned snapshot")
            marker = {
                "version": 1,
                "phase": "active",
                "app": args.app,
                "id": args.id,
                "hash": args.hash,
                "build": source["build"],
                "token": source["token"],
            }
            if args.action == "prepare-roll":
                # Publish intent before flyctl can change native env fields.
                # A failed/partial deploy can then reconcile exactly this target.
                marker["rolling"] = {"build": args.build, "token": args.token}
            fly.request(
                "POST",
                f"/metadata/{POOL_KEY}",
                {"value": json.dumps(marker, sort_keys=True)},
            )
            verified = fly.request("GET")
            if (
                record(verified, args.app) != source
                or verified["state"] != "started"
                or metadata(verified, POOL_KEY) != marker
            ):
                raise ValueError("Rolling metadata did not preserve its live Machine")
        else:
            if current["config"].get("metadata", {}).get("rose_worker_reuse_protected"):
                raise ValueError("Protected Machine cannot be assigned to the retired pool")
            if record(current, args.app) != source or (
                current["state"] != "stopped"
                and not (getattr(args, "allow_created", False) and current["state"] == "created")
            ):
                raise ValueError("Retirement requires the exact stopped Machine snapshot")
            if source["hash"] != args.hash or not all(source.get(key) for key in ("hash", "build", "token")):
                raise ValueError("Retirement source generation/provenance is missing or changed")
            if (
                not args.live_hash
                or (
                    args.queue == getattr(args, "live_queue", None)
                    if getattr(args, "live_queue", None)
                    else args.live_hash == args.hash
                )
                or args.queue != source.get("queue", f"navi-agent-tasks@{args.hash}")
            ):
                raise ValueError("Retirement cannot certify the live generation or another queue")
            marker = {
                "version": 1,
                "phase": "idle",
                "source": source,
                "drained_queue": args.queue,
                "retired_by": {"build": args.build, "token": args.token},
            }
            if current["state"] == "created":
                marker["origin"] = "preallocated"
            fly.request(
                "POST",
                f"/metadata/{POOL_KEY}",
                {"value": json.dumps(marker, sort_keys=True)},
            )
            verified = fly.request("GET")
            if (
                record(verified, args.app) != source
                or verified["state"] != current["state"]
                or metadata(verified, POOL_KEY) != marker
            ):
                raise ValueError("Retirement metadata did not preserve the stopped Machine")
    return {"id": args.id, "action": args.action, "verified": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "action",
        choices=(
            "candidates",
            "enroll",
            "reserve",
            "release-reservation",
            "reuse",
            "retire",
            "activate",
            "prepare-roll",
        ),
    )
    for flag in ("app", "live-hash", "id", "hash", "build", "token", "image", "queue"):
        parser.add_argument("--" + flag, required=flag in ("app", "live-hash"))
    parser.add_argument("--job")
    parser.add_argument("--live-queue")
    args = parser.parse_args()
    expected = json.load(sys.stdin)
    if args.action == "candidates":
        for machine in expected:
            if eligible(machine, args.app, args.live_hash, args.live_queue):
                print(machine["id"])
        return
    if not all((args.id, args.hash, args.build, args.token)) or (args.action == "reuse" and not args.image):
        raise ValueError("Missing generation/attempt/image provenance")
    print(json.dumps(operate(args, expected, Fly(args.app, args.id))))


if __name__ == "__main__":
    try:
        main()
    except (KeyError, ValueError, TypeError, OSError) as error:
        # Native configs, authorization headers and lease nonces are private.
        print(f"Worker pool operation failed: {type(error).__name__}", file=sys.stderr)
        raise SystemExit(1)
