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
import sys
from contextlib import contextmanager
from urllib.parse import quote
from urllib.request import Request, urlopen

POOL_KEY = "rose_cooperative_worker_pool"
CUSTODY_KEY = "rose_worker_reuse_custody"
API = "https://api.machines.dev/v1"


def config_digest(config):
    config = copy.deepcopy(config)
    metadata = config.get("metadata", {})
    for key in (POOL_KEY, CUSTODY_KEY):
        metadata.pop(key, None)
    if not metadata:
        config.pop("metadata", None)
    return hashlib.sha256(
        json.dumps(config, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def record(machine, app):
    config = machine["config"]
    env = config.get("env", {})
    return {
        "app": app,
        "id": machine["id"],
        "instance_id": machine["instance_id"],
        "config_sha256": config_digest(config),
        "hash": env.get("TEMPORAL_WORKER_SURFACE_HASH"),
        "build": env.get("TEMPORAL_WORKER_BUILD_ID"),
        "token": env.get("TEMPORAL_WORKER_DEPLOYMENT_TOKEN"),
    }


def metadata(machine, key):
    try:
        value = json.loads(
            machine.get("config", {}).get("metadata", {}).get(key, "null")
        )
        return value if isinstance(value, dict) else {}
    except (ValueError, TypeError):
        return {}


def custody_ready(machine, app):
    custody = metadata(machine, CUSTODY_KEY)
    source = record(machine, app)
    return (
        custody.get("version") == 1
        and all(
            custody.get(key) == source[key]
            for key in ("app", "id", "instance_id", "config_sha256")
        )
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
        and (
            all(pool.get(key) == value for key, value in attempt.items())
            or pool.get("rolling") == attempt
        )
    )


def eligible(machine, app, live_hash):
    try:
        pool = metadata(machine, POOL_KEY)
        source = record(machine, app)
        return (
            machine["state"] == "stopped"
            and bool(live_hash)
            and all(
                source.get(key) for key in ("hash", "build", "token", "instance_id")
            )
            and source["hash"] != live_hash
            # Persisted overlays can mask the newly pinned worker image. They
            # remain retained, but require a separate data/source migration.
            and (machine["config"].get("rootfs") or {}).get("persist")
            in (None, "", "never", 0)
            and (machine["config"].get("guest") or {}).get("persist_rootfs")
            in (None, "", "never", 0)
            and not machine["config"]
            .get("metadata", {})
            .get("rose_worker_reuse_protected")
            and pool.get("version") == 1
            and pool.get("phase") == "idle"
            and pool.get("source") == source
            and isinstance(pool.get("retired_by"), dict)
            and bool(pool.get("retired_by", {}).get("build"))
            and bool(pool.get("retired_by", {}).get("token"))
            and pool.get("drained_queue") == f"navi-agent-tasks@{source['hash']}"
            and custody_ready(machine, app)
        )
    except (KeyError, TypeError):
        return False


class Fly:
    def __init__(self, app, machine_id):
        self.path = f"/apps/{quote(app, safe='')}/machines/{quote(machine_id, safe='')}"
        self.nonce = None

    def request(self, method, suffix="", data=None):
        headers = {
            "Authorization": f"Bearer {os.environ['FLY_API_TOKEN']}",
            "Content-Type": "application/json",
        }
        if self.nonce:
            headers["fly-machine-lease-nonce"] = self.nonce
        body = None if data is None else json.dumps(data).encode()
        with urlopen(
            Request(
                API + self.path + suffix, data=body, headers=headers, method=method
            ),
            timeout=30,
        ) as response:
            raw = response.read()
            return json.loads(raw) if raw else None

    @contextmanager
    def lease(self):
        self.nonce = self.request(
            "POST", "/lease", {"ttl": 500, "description": "cooperative-worker-pool"}
        )["data"]["nonce"]
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
    with fly.lease():
        current = fly.request("GET")
        if current.get("id") != args.id:
            raise ValueError("Fly returned a different Machine")
        source = record(expected, args.app)
        if args.action == "reuse":
            if (
                args.hash == args.live_hash
                or args.queue != f"navi-agent-tasks@{args.hash}"
            ):
                raise ValueError(
                    "Reuse requires a different, exact target generation queue"
                )
            if not eligible(expected, args.app, args.live_hash):
                raise ValueError(
                    "Machine lacks an eligible stopped, drained custody record"
                )
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
            marker = {
                "version": 1,
                "phase": "active",
                "app": args.app,
                "id": args.id,
                "hash": args.hash,
                "build": args.build,
                "token": args.token,
            }
            config.setdefault("metadata", {})[POOL_KEY] = json.dumps(
                marker, sort_keys=True
            )
            # Reconcile a native update whose response was lost, under the same
            # lease and attempt. A different owner/attempt is never adopted.
            already_updated = (
                config_digest(current["config"]) == config_digest(config)
                and metadata(current, POOL_KEY) == marker
            )
            if not already_updated:
                if record(current, args.app) != source or not eligible(
                    current, args.app, args.live_hash
                ):
                    raise ValueError("Stopped Machine changed before its leased reuse")
                fly.request(
                    "POST",
                    data={
                        "config": config,
                        "current_version": current["instance_id"],
                        "skip_launch": True,
                    },
                )
            verified = fly.request("GET")
            if (
                verified.get("id") != args.id
                or config_digest(verified["config"]) != config_digest(config)
                or metadata(verified, POOL_KEY) != marker
            ):
                raise ValueError(
                    "Native update did not preserve the expected worker configuration"
                )
        elif args.action in ("activate", "prepare-roll"):
            # flyctl owns the rolling update and health checks. Only refresh
            # metadata on its explicitly selected, now-updated native snapshot.
            if (
                record(current, args.app) != source
                or current["state"] != "started"
                or source["hash"] != args.hash
                or args.live_hash != args.hash
                or not active_owner(current, args.app)
                or (
                    args.action == "activate"
                    and (source["build"] != args.build or source["token"] != args.token)
                )
            ):
                raise ValueError(
                    "Rolling activation does not match its live owned snapshot"
                )
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
                raise ValueError(
                    "Protected Machine cannot be assigned to the retired pool"
                )
            if record(current, args.app) != source or current["state"] != "stopped":
                raise ValueError(
                    "Retirement requires the exact stopped Machine snapshot"
                )
            if source["hash"] != args.hash or not all(
                source.get(key) for key in ("hash", "build", "token")
            ):
                raise ValueError(
                    "Retirement source generation/provenance is missing or changed"
                )
            if (
                not args.live_hash
                or args.live_hash == args.hash
                or args.queue != f"navi-agent-tasks@{args.hash}"
            ):
                raise ValueError(
                    "Retirement cannot certify the live generation or another queue"
                )
            marker = {
                "version": 1,
                "phase": "idle",
                "source": source,
                "drained_queue": args.queue,
                "retired_by": {"build": args.build, "token": args.token},
            }
            fly.request(
                "POST",
                f"/metadata/{POOL_KEY}",
                {"value": json.dumps(marker, sort_keys=True)},
            )
            verified = fly.request("GET")
            if (
                record(verified, args.app) != source
                or verified["state"] != "stopped"
                or metadata(verified, POOL_KEY) != marker
            ):
                raise ValueError(
                    "Retirement metadata did not preserve the stopped Machine"
                )
    return {"id": args.id, "action": args.action, "verified": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "action", choices=("candidates", "reuse", "retire", "activate", "prepare-roll")
    )
    for flag in ("app", "live-hash", "id", "hash", "build", "token", "image", "queue"):
        parser.add_argument("--" + flag, required=flag in ("app", "live-hash"))
    args = parser.parse_args()
    expected = json.load(sys.stdin)
    if args.action == "candidates":
        for machine in expected:
            if eligible(machine, args.app, args.live_hash):
                print(machine["id"])
        return
    if not all((args.id, args.hash, args.build, args.token)) or (
        args.action == "reuse" and not args.image
    ):
        raise ValueError("Missing generation/attempt/image provenance")
    print(json.dumps(operate(args, expected, Fly(args.app, args.id))))


if __name__ == "__main__":
    try:
        main()
    except (KeyError, ValueError, TypeError, OSError) as error:
        # Native configs, authorization headers and lease nonces are private.
        print(f"Worker pool operation failed: {type(error).__name__}", file=sys.stderr)
        raise SystemExit(1)
