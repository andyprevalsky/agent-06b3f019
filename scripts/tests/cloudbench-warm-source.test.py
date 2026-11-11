#!/usr/bin/env python3
"""Owning regression for scripts/cloudbench-warm-source.py.

One warm source per dependency set, a cross-devbox maintenance claim that is a
lease-guarded compare-and-set on the base donor's metadata, and bounded
retention that never destroys an in-use, claimed, protected or referenced set.

Runs the real helper against an in-process fake Fly Machines API (leases, lease
nonces, metadata, Machines, volumes, snapshots); no flyctl, network or credentials.
"""
from __future__ import annotations

import http.server
import json
import os
import runpy
import subprocess
import sys
import tempfile
import threading
import time

import unittest
import uuid
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "lib"))
from condition_wait import wait_until
CLI = ROOT / "scripts" / "cloudbench-warm-source.py"
NODE_A, PY_A = "a" * 64, "b" * 64
NODE_B, PY_B = "c" * 64, "d" * 64


class FakeFly:
    def __init__(self):
        self.lock = threading.RLock()
        self.machines = {}
        self.volumes = {}
        self.snapshots = {}
        self.leases = {}
        self.log = []
        self.throttle_metadata_writes = 0  # next N metadata writes answer 429 (Fly rate limit)
        self.add_volume("vol_base00000001", "cloudbench_data", attached="0b0000000000aa")
        self.snapshots["vol_base00000001"] = [
            {"id": "vs_old", "status": "created", "created_at": "2026-10-01T00:00:00Z", "size": 40},
            {"id": "vs_new", "status": "created", "created_at": "2026-11-01T00:00:00Z", "size": 40},
            {"id": "vs_running", "status": "running", "created_at": "2026-11-07T00:00:00Z", "size": 0},
        ]
        self.add_machine("0b0000000000aa", "cloudbench-warm", "stopped", volume="vol_base00000001", metadata={
            "rose_cloudbench_deps_0123": "proof naming the base volume", "rose_cloudbench_lane": "x"})

    def add_volume(self, vid, name, attached=None, state="created"):
        self.volumes[vid] = {"id": vid, "name": name, "state": state, "size_gb": 40, "region": "iad",
                             "attached_machine_id": attached}

    def add_machine(self, mid, name, state, volume=None, metadata=None):
        self.machines[mid] = {"id": mid, "name": name, "state": state, "region": "iad",
                              "instance_id": uuid.uuid4().hex,
                              "config": {"image": "registry.fly.io/bench@sha256:" + "e" * 64,
                                         "guest": {"cpu_kind": "shared", "cpus": 1, "memory_mb": 2048},
                                         "mounts": [{"volume": volume, "path": "/data"}] if volume else [],
                                         "metadata": dict(metadata or {})}}
        if volume and volume in self.volumes:
            self.volumes[volume]["attached_machine_id"] = mid

    def lease_held(self, mid, nonce):
        lease = self.leases.get(mid)
        return lease and lease["expires"] > time.time() and lease["nonce"] != nonce

    def handle(self, method, path, body, nonce):
        parts = urlparse(path).path.split("/")[4:]  # after /v1/apps/<app>
        query = urlparse(path).query
        with self.lock:
            self.log.append((method, "/".join(parts)))
            if parts == ["machines"]:
                if method == "GET":
                    return 200, list(self.machines.values())
                mid = uuid.uuid4().hex[:14]
                config = body["config"]
                self.machines[mid] = {"id": mid, "name": body["name"], "region": body["region"],
                                      "state": "started", "instance_id": uuid.uuid4().hex, "config": config}
                for mount in config.get("mounts") or []:
                    self.volumes[mount["volume"]]["attached_machine_id"] = mid
                return 200, self.machines[mid]
            if parts[0] == "machines":
                mid = parts[1]
                machine = self.machines.get(mid)
                if machine is None:
                    return 404, {"error": "not found"}
                rest = parts[2:]
                if rest == [] and method == "GET":
                    return 200, machine
                if rest == [] and method == "DELETE":
                    if machine["state"] != "stopped" and "force=true" not in query:
                        return 412, {"error": "not stopped"}
                    if self.lease_held(mid, nonce):
                        return 409, {"error": "lease held"}
                    machine["state"] = "destroyed"
                    for mount in machine["config"].get("mounts") or []:
                        self.volumes[mount["volume"]]["attached_machine_id"] = None
                    return 200, {"ok": True}
                if rest == ["lease"] and method == "POST":
                    if self.lease_held(mid, None):
                        return 409, {"error": "lease currently held"}
                    lease = {"nonce": uuid.uuid4().hex, "expires": time.time() + body["ttl"]}
                    self.leases[mid] = lease
                    # Real Fly answers a granted lease with 201 Created (observed 2026-11-09).
                    return 201, {"status": "success", "data": {"nonce": lease["nonce"]}}
                if rest == ["lease"] and method == "DELETE":
                    if self.leases.get(mid, {}).get("nonce") == nonce:
                        self.leases.pop(mid)
                    return 200, {}
                if rest and rest[0] == "metadata":
                    if method == "POST" and self.throttle_metadata_writes > 0:
                        self.throttle_metadata_writes -= 1
                        return 429, {"error": "rate limit exceeded"}
                    if self.lease_held(mid, nonce):
                        return 409, {"error": "lease currently held"}
                    if method == "POST":
                        machine["config"]["metadata"][rest[1]] = body["value"]
                    else:
                        machine["config"]["metadata"].pop(rest[1], None)
                    return 204, None
                if rest == ["stop"]:
                    machine["state"] = "stopped"
                    return 200, {}
                if rest == ["wait"]:
                    params = dict(item.split("=") for item in query.split("&"))
                    # Real Fly rejects a wait timeout outside [1s, 1m0s] (observed 2026-11-09).
                    if not 1 <= int(params.get("timeout", "60")) <= 60:
                        return 400, {"error": "invalid_argument: invalid WaitMachineRequest.Timeout"}
                    wanted = params["state"]
                    return (200, {"ok": True}) if machine["state"] == wanted else (408, {"error": "timeout"})
            if parts == ["volumes"]:
                if method == "GET":
                    return 200, list(self.volumes.values())
                vid = "vol_" + uuid.uuid4().hex[:14]
                self.add_volume(vid, body["name"])
                self.volumes[vid]["snapshot_id"] = body["snapshot_id"]
                return 200, self.volumes[vid]
            if parts[0] == "volumes":
                volume = self.volumes.get(parts[1])
                if volume is None:
                    return 404, {"error": "not found"}
                if parts[2:] == ["snapshots"]:
                    return 200, self.snapshots.get(parts[1], [])
                if method == "DELETE":
                    volume["state"] = "destroyed"
                    return 200, {}
                return 200, volume
        return 404, {"error": "unhandled " + path}


def serve(fake):
    class Handler(http.server.BaseHTTPRequestHandler):
        def _go(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length)) if length else None
            status, payload = fake.handle(self.command, self.path, body, self.headers.get("fly-machine-lease-nonce"))
            raw = b"" if payload is None else json.dumps(payload).encode()
            self.send_response(status)
            if status == 429:
                self.send_header("Retry-After", "0")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        do_GET = do_POST = do_DELETE = _go

        def log_message(self, *_args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class FakeApiCase(unittest.TestCase):
    def setUp(self):
        self.fake = FakeFly()
        self.server = serve(self.fake)
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"
        os.environ["FLY_FLAPS_BASE_URL"] = self.base_url
        self.mod = runpy.run_path(str(CLI))
        self.api = self.mod["Api"]("navi-whisper-lux-bench", "FlyV1 fixture", base=self.base_url, timeout=10)
        self.donor = "0b0000000000aa"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def meta(self, mid):
        return self.fake.machines[mid]["config"]["metadata"]

    def run_cli(self, *args, timeout=60, **kwargs):
        env = {**os.environ, "FLY_FLAPS_BASE_URL": self.base_url, "FLY_API_TOKEN": "fixture"}
        return subprocess.run([sys.executable, str(CLI), *args], env=env, text=True, capture_output=True,
                              timeout=timeout, **kwargs)


class WarmSource(FakeApiCase):
    def test_names_are_per_dependency_set_and_never_task_shaped(self):
        set_a, machine_a, volume_a = self.mod["names"](NODE_A, PY_A)
        set_b, machine_b, _ = self.mod["names"](NODE_B, PY_B)
        self.assertNotEqual(set_a, set_b)
        self.assertEqual(self.mod["names"](NODE_A, PY_A), (set_a, machine_a, volume_a))
        self.assertRegex(machine_a, r"^cloudbench-warm-[0-9a-f]{12}$")
        self.assertRegex(volume_a, r"^cloudbench_data_[0-9a-f]{12}$")
        self.assertLessEqual(len(volume_a), 30)  # Fly volume name limit
        reaper = runpy.run_path(str(ROOT / "scripts" / "cloudbench-reclaim-stopped.py"))
        self.assertIsNone(reaper["TASK_NAME"].fullmatch(machine_a))
        result = self.run_cli("names", "--node-fp", NODE_A, "--py-fp", PY_A)
        self.assertEqual(result.stdout.split(), [set_a, machine_a, volume_a])
        self.assertNotEqual(self.run_cli("names", "--node-fp", "x", "--py-fp", PY_A).returncode, 0)

    def test_claim_is_exclusive_per_set_and_written_only_under_the_lease(self):
        acquire = self.mod["claim_acquire"]
        set_a, set_b = self.mod["dependency_set"](NODE_A, PY_A), self.mod["dependency_set"](NODE_B, PY_B)
        self.assertTrue(acquire(self.api, self.donor, set_a, "devbox-1", 600, 0))
        self.assertFalse(acquire(self.api, self.donor, set_a, "devbox-2", 600, 0))
        # Another dependency set never waits on this one.
        self.assertTrue(acquire(self.api, self.donor, set_b, "devbox-2", 600, 0))
        writes = [entry for entry in self.fake.log if entry[0] == "POST" and "/metadata/" in entry[1]]
        leases = [entry for entry in self.fake.log if entry[1].endswith("/lease")]
        self.assertEqual(len(writes), 2)
        self.assertEqual(len(leases), 6)  # acquire+release around each of three exchanges
        self.assertNotIn(self.donor, self.fake.leases)  # the short lease never outlives an exchange
        self.assertTrue(self.mod["claim_release"](self.api, self.donor, set_a, "devbox-1"))
        self.assertTrue(acquire(self.api, self.donor, set_a, "devbox-2", 600, 0))
        self.assertFalse(self.mod["claim_release"](self.api, self.donor, set_a, "devbox-1"))
        self.assertTrue(self.meta(self.donor)["rose_cloudbench_warm_claim_" + set_a].startswith("devbox-2 "))

    def test_expired_claim_of_a_crashed_devbox_is_taken_over(self):
        set_a = self.mod["dependency_set"](NODE_A, PY_A)
        self.meta(self.donor)["rose_cloudbench_warm_claim_" + set_a] = f"dead-devbox {int(time.time()) - 1} host"
        self.assertTrue(self.mod["claim_acquire"](self.api, self.donor, set_a, "devbox-2", 600, 0))

    def test_concurrent_requests_for_one_set_admit_exactly_one(self):
        set_a = self.mod["dependency_set"](NODE_A, PY_A)
        results = {}
        barrier = threading.Barrier(6)

        def contend(owner):
            api = self.mod["Api"]("navi-whisper-lux-bench", "FlyV1 fixture", base=self.base_url, timeout=10)
            barrier.wait()
            results[owner] = self.mod["claim_acquire"](api, self.donor, set_a, owner, 600, 0)

        threads = [threading.Thread(target=contend, args=(f"devbox-{i}",)) for i in range(6)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(30)
        self.assertEqual(sum(results.values()), 1, results)
        winner = next(owner for owner, won in results.items() if won)
        self.assertTrue(self.meta(self.donor)["rose_cloudbench_warm_claim_" + set_a].startswith(winner + " "))

    def test_waiting_request_reports_progress_and_acquires_after_release(self):
        set_a = self.mod["dependency_set"](NODE_A, PY_A)
        self.assertTrue(self.mod["claim_acquire"](self.api, self.donor, set_a, "devbox-1", 600, 0))
        threading.Timer(2.5, lambda: self.mod["claim_release"](self.api, self.donor, set_a, "devbox-1")).start()
        result = self.run_cli("claim", "acquire", "--set", set_a, "--owner", "devbox-2", "--wait", "20")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("maintenance claimed by devbox-1@", result.stderr)

    def test_hold_renews_while_parent_lives_and_releases_when_it_exits(self):
        set_a = self.mod["dependency_set"](NODE_A, PY_A)
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as directory:
            ready = Path(directory) / "ready"
            parent = subprocess.Popen(["sleep", "30"])
            try:
                env = {**os.environ, "FLY_FLAPS_BASE_URL": self.base_url, "FLY_API_TOKEN": "fixture"}
                holder = subprocess.Popen([sys.executable, str(CLI), "claim", "hold", "--set", set_a, "--owner",
                                           "devbox-1", "--ttl", "4", "--renew", "1", "--parent-pid",
                                           str(parent.pid), "--ready", str(ready)], env=env,
                                          stderr=subprocess.PIPE, text=True)
                wait_until(ready.exists, timeout=20, description="claim hold ready file")
                claim = "rose_cloudbench_warm_claim_" + set_a
                first = int(self.meta(self.donor)[claim].split()[1])

                def renewed_expiry():
                    value = int(self.meta(self.donor)[claim].split()[1])
                    return value if value > first else None

                renewed = wait_until(renewed_expiry, timeout=20, description="claim renewed past its first expiry")
                self.assertGreater(renewed, first)
                self.assertFalse(self.mod["claim_acquire"](self.api, self.donor, set_a, "devbox-2", 600, 0))
            finally:
                parent.kill()
                parent.wait()
            _, errors = holder.communicate(timeout=20)
            self.assertEqual(holder.returncode, 0, errors)
        self.assertNotIn("rose_cloudbench_warm_claim_" + set_a, self.meta(self.donor))

    def test_ensure_creates_one_stopped_source_per_set_from_the_newest_complete_snapshot(self):
        set_a, machine_a, volume_a = self.mod["names"](NODE_A, PY_A)
        result = self.run_cli("ensure", "--node-fp", NODE_A, "--py-fp", PY_A, "--owner", "devbox-1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.split(), [set_a, machine_a, volume_a])
        rows = [m for m in self.fake.machines.values() if m["name"] == machine_a]
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["state"], "stopped")
        metadata = row["config"]["metadata"]
        self.assertEqual(metadata["rose_cloudbench_warm_source_set"], set_a)
        self.assertNotIn("rose_cloudbench_deps_0123", metadata)  # base proof names another volume
        self.assertFalse(any(key.startswith("rose_cloudbench_warm_claim_") for key in metadata))
        volume = self.fake.volumes[row["config"]["mounts"][0]["volume"]]
        self.assertEqual((volume["name"], volume["snapshot_id"]), (volume_a, "vs_new"))
        self.assertFalse(any(k.startswith("rose_cloudbench_warm_claim_") for k in self.meta(self.donor)))
        self.assertEqual(self.fake.machines[self.donor]["state"], "stopped")  # the base donor is only read
        # A second fleet with the same set reuses it and records its use; nothing new is allocated.
        machines, volumes = len(self.fake.machines), len(self.fake.volumes)
        metadata[self.mod["LAST_USED_KEY"]] = "1"
        again = self.run_cli("ensure", "--node-fp", NODE_A, "--py-fp", PY_A, "--owner", "devbox-2")
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual((len(self.fake.machines), len(self.fake.volumes)), (machines, volumes))
        self.assertGreater(int(metadata[self.mod["LAST_USED_KEY"]]), 1)

    def test_ensure_rides_out_fly_metadata_rate_limits_and_still_bounds_them(self):
        # Deploy smoke 2026-11-11: 15 concurrent jobs recorded LAST_USED_KEY on one source,
        # Fly answered 429 and every job aborted "could not select this dependency set's warm source".
        set_a, machine_a, volume_a = self.mod["names"](NODE_A, PY_A)
        first = self.run_cli("ensure", "--node-fp", NODE_A, "--py-fp", PY_A, "--owner", "devbox-1")
        self.assertEqual(first.returncode, 0, first.stderr)
        row = next(m for m in self.fake.machines.values() if m["name"] == machine_a)
        row["config"]["metadata"][self.mod["LAST_USED_KEY"]] = "1"
        self.fake.throttle_metadata_writes = self.mod["RATE_LIMIT_ATTEMPTS"] - 1
        again = self.run_cli("ensure", "--node-fp", NODE_A, "--py-fp", PY_A, "--owner", "devbox-2")
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(again.stdout.split(), [set_a, machine_a, volume_a])
        self.assertGreater(int(row["config"]["metadata"][self.mod["LAST_USED_KEY"]]), 1)
        self.assertEqual(self.fake.throttle_metadata_writes, 0)
        # A persistent limit still fails closed after the bounded attempts, never loops forever.
        self.fake.throttle_metadata_writes = 10 ** 6
        refused = self.run_cli("ensure", "--node-fp", NODE_A, "--py-fp", PY_A, "--owner", "devbox-3", timeout=60)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("HTTP 429", refused.stderr)

    def test_ensure_reuses_an_interrupted_create_volume_and_waits_out_a_peer_claim(self):
        set_b, machine_b, volume_b = self.mod["names"](NODE_B, PY_B)
        self.fake.add_volume("vol_orphan000001", volume_b)
        self.assertTrue(self.mod["claim_acquire"](self.api, self.donor, set_b, "devbox-1", 600, 0))
        refused = self.run_cli("ensure", "--node-fp", NODE_B, "--py-fp", PY_B, "--owner", "devbox-2", "--wait", "0")
        self.assertNotEqual(refused.returncode, 0)
        self.assertFalse(any(m["name"] == machine_b for m in self.fake.machines.values()))
        self.mod["claim_release"](self.api, self.donor, set_b, "devbox-1")
        made = self.run_cli("ensure", "--node-fp", NODE_B, "--py-fp", PY_B, "--owner", "devbox-2")
        self.assertEqual(made.returncode, 0, made.stderr)
        row = next(m for m in self.fake.machines.values() if m["name"] == machine_b)
        self.assertEqual(row["config"]["mounts"][0]["volume"], "vol_orphan000001")
        self.assertEqual(sum(v["name"] == volume_b for v in self.fake.volumes.values()), 1)

    def source(self, set_seed, state="stopped", last_used=None, extra=None):
        set_id = self.mod["dependency_set"](set_seed * 64, set_seed * 64)
        mid = uuid.uuid4().hex[:14]
        vid = "vol_" + uuid.uuid4().hex[:14]
        self.fake.add_volume(vid, f"cloudbench_data_{set_id}")
        self.fake.add_machine(mid, f"cloudbench-warm-{set_id}", state, volume=vid, metadata={
            "rose_cloudbench_warm_source_set": set_id,
            "rose_cloudbench_warm_source_last_used": str(int(time.time() - 7 * 86400) if last_used is None
                                                         else last_used), **(extra or {})})
        return set_id, mid, vid

    def test_retention_keeps_recent_and_in_use_sets_and_retires_only_verified_idle_ones(self):
        now = int(time.time())
        newest = [self.source(seed, last_used=now - 100 * i) for i, seed in enumerate("012")]
        idle_set, idle_id, idle_volume = self.source("3")
        started = self.source("4", state="started")
        protected = self.source("5", extra={"rose_cloudbench_warm_source_retain": "1"})
        reaper_protected = self.source("6", extra={"cloudbench_protected_owner": "x"})
        recent = self.source("7", last_used=now - 600)
        referenced = self.source("8")
        self.fake.add_machine("c10e0000000001", "cloudbench-" + "f" * 24, "started",
                              metadata={"rose_cloudbench_warm_source_set": referenced[0]})  # a live task clone
        claimed = self.source("9")
        self.meta(self.donor)["rose_cloudbench_warm_claim_" + claimed[0]] = f"devbox-1 {now + 600} host"
        dry = self.run_cli("retire", "--keep", "3", "--grace", "3600")
        self.assertEqual(dry.returncode, 0, dry.stderr)
        self.assertEqual(dry.stdout.split(), [])
        self.assertEqual(self.fake.machines[idle_id]["state"], "stopped")  # a dry run destroys nothing
        self.assertIn(f"would retire warm source {idle_set}", dry.stderr)
        result = self.run_cli("retire", "--keep", "3", "--grace", "3600", "--execute")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.split(), [idle_set])
        self.assertEqual(self.fake.machines[idle_id]["state"], "destroyed")
        self.assertEqual(self.fake.volumes[idle_volume]["state"], "destroyed")
        for kept in [*newest, started, protected, reaper_protected, recent, referenced, claimed]:
            self.assertNotEqual(self.fake.machines[kept[1]]["state"], "destroyed", kept)
            self.assertEqual(self.fake.volumes[kept[2]]["state"], "created")
        self.assertEqual(self.fake.machines[self.donor]["state"], "stopped")
        for reason in ("within newest retention", "not stopped", "protected", "recently used",
                       "referenced by a live Machine", "claimed"):
            self.assertIn(reason, result.stderr)
        self.assertFalse(any(k.startswith("rose_cloudbench_warm_claim_" + idle_set) for k in self.meta(self.donor)))

    def test_retire_rechecks_exact_state_before_destroying(self):
        idle_set, idle_id, _ = self.source("3")
        plan = self.mod["retention_plan"]
        kept, retire, _ = plan(list(self.fake.machines.values()), keep=0, grace=0, now=time.time())
        self.assertEqual([s for _, s in retire], [idle_set])
        # Started between planning and the destroy (a peer began maintenance): not retired.
        original = self.fake.handle
        lists = []

        def start_after_planning(method, path, body, nonce):
            if method == "GET" and urlparse(path).path.endswith("/machines"):
                lists.append(path)
                if len(lists) == 3:  # base donor read, planning list, then the exact re-read
                    self.fake.machines[idle_id]["state"] = "started"
            return original(method, path, body, nonce)

        machines = self.api.machines()
        self.fake.handle = start_after_planning
        try:
            retired = self.mod["retire"](self.api, "devbox-9", keep=0, grace=0, execute=True)
        finally:
            self.fake.handle = original
        self.assertEqual(retired, [])
        self.assertEqual(self.fake.machines[idle_id]["state"], "started")
        self.assertTrue(machines)


def bash_function(path: Path, name: str) -> str:
    """One bash function (top-level or nested in a mode block) from a real controller script."""
    import re
    text = path.read_text()
    match = re.search(rf"^( *){re.escape(name)}\(\) \{{.*$", text, re.MULTILINE)
    end = text.index(f"\n{match.group(1)}}}\n", match.end()) + len(match.group(1)) + 3
    return text[match.start():end]


class ControllerIntegration(FakeApiCase):
    """The real fleet selector and run-bench-cloud claim/peer-proof functions against the fake API."""

    def bash(self, script, timeout=60):
        env = {**os.environ, "FLY_FLAPS_BASE_URL": self.base_url, "FLY_API_TOKEN": "fixture"}
        env.pop("CLOUDBENCH_WARM_MACHINE_NAME", None)
        env.pop("CLOUDBENCH_WARM_SOURCE_PER_DEPS", None)
        return subprocess.run(["bash", "-c", script], env=env, text=True, capture_output=True, timeout=timeout)

    def fleet_selector(self, flags):
        return f"""set -u
APP=navi-whisper-lux-bench ROOT_DIR=/unused GIT_COMMON_DIR=/common FLEET_OWNER_TOKEN=0123abcd
MACHINE_NAME=cloudbench-warm VOLUME_NAME=cloudbench_data WARM_DEPS_STATE_FILE=/common/cloudbench-warm-deps.fp
WARM_SOURCE_HELPER={CLI}
CLOUDBENCH_PYTHON_MANIFESTS=(agents/requirements.txt)
cloudbench_node_dependency_fingerprint() {{ printf '%s\\n' {NODE_A}; }}
cloudbench_manifest_fingerprint() {{ printf '%s\\n' {PY_A}; }}
{flags}
{bash_function(ROOT / "scripts" / "run-bench-fleet", "select_dependency_set_warm_source")}
select_dependency_set_warm_source || exit 7
printf 'selected=%s %s %s exported=%s\\n' "$MACHINE_NAME" "$VOLUME_NAME" "$WARM_DEPS_STATE_FILE" "${{CLOUDBENCH_WARM_MACHINE_NAME:-none}}"
"""

    def test_fleet_default_keeps_the_shared_donor_and_touches_nothing(self):
        result = self.bash(self.fleet_selector(""))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("selected=cloudbench-warm cloudbench_data /common/cloudbench-warm-deps.fp exported=none",
                      result.stdout)
        self.assertEqual(self.fake.log, [])

    def test_fleet_opt_in_selects_and_exports_its_dependency_set_source(self):
        set_a, machine_a, volume_a = self.mod["names"](NODE_A, PY_A)
        result = self.bash(self.fleet_selector("CLOUDBENCH_WARM_SOURCE_PER_DEPS=1"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"selected={machine_a} {volume_a} /common/cloudbench-warm-deps.{machine_a}.fp "
                      f"exported={machine_a}", result.stdout)
        self.assertTrue(any(m["name"] == machine_a and m["state"] == "stopped" for m in self.fake.machines.values()))
        # A fleet of this set never waits on another set's claim.
        set_b = self.mod["dependency_set"](NODE_B, PY_B)
        self.assertTrue(self.mod["claim_acquire"](self.api, self.donor, set_b, "devbox-9", 600, 0))
        again = self.bash(self.fleet_selector("CLOUDBENCH_WARM_SOURCE_PER_DEPS=1"), timeout=20)
        self.assertEqual(again.returncode, 0, again.stderr)
        explicit = self.bash(self.fleet_selector("CLOUDBENCH_WARM_SOURCE_PER_DEPS=1 CLOUDBENCH_WARM_MACHINE_NAME=pinned"))
        self.assertIn("selected=cloudbench-warm cloudbench_data", explicit.stdout)

    def refresh_functions(self, body):
        cloud = ROOT / "scripts" / "run-bench-cloud"
        names = ("acquire_warm_source_claim", "release_warm_source_claim", "peer_devbox_proven_snapshot")
        return f"""set -u
APP=navi-whisper-lux-bench CLOUDBENCH_RUNTIME_SCRIPT_ROOT={ROOT / "scripts"} WARM_SOURCE_CLAIM_PID=""
source {ROOT / "scripts" / "lib" / "cloudbench-env.sh"}
FLY() {{
    case "$1 $2" in
        "machines list") python3 -c 'import json,sys,urllib.request; print(urllib.request.urlopen(sys.argv[1]).read().decode())' "$FLY_FLAPS_BASE_URL/v1/apps/$APP/machines" ;;
        "volume snapshots") python3 -c 'import json,sys,urllib.request; print(urllib.request.urlopen(sys.argv[1]).read().decode())' "$FLY_FLAPS_BASE_URL/v1/apps/$APP/volumes/$4/snapshots" ;;
        *) return 9 ;;
    esac
}}
{"".join(bash_function(cloud, name) for name in names)}
{body}
"""

    def test_refresh_holds_the_set_claim_and_releases_it_on_exit(self):
        set_a, machine_a, _ = self.mod["names"](NODE_A, PY_A)
        key = "rose_cloudbench_warm_claim_" + set_a
        script = self.refresh_functions(f"""
acquire_warm_source_claim {set_a} || exit 5
python3 -c 'import sys,urllib.request,json; m=json.load(urllib.request.urlopen(sys.argv[1])); print("held=" + m["config"]["metadata"].get(sys.argv[2], "none").split()[0])' "$FLY_FLAPS_BASE_URL/v1/apps/$APP/machines/{self.donor}" {key}
release_warm_source_claim
""")
        result = self.bash(script)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stdout, r"held=refresh-[A-Za-z0-9.-]+-\d+")
        self.assertNotIn(key, self.meta(self.donor))
        # A peer devbox's claim is waited on (bounded) rather than ignored.
        self.assertTrue(self.mod["claim_acquire"](self.api, self.donor, set_a, "devbox-1", 600, 0))
        blocked = self.bash(self.refresh_functions(
            f"CLOUDBENCH_APP_ENV_LOCK_WAIT_SECONDS=2\nacquire_warm_source_claim {set_a}; echo status=$?"))
        self.assertIn("status=1", blocked.stdout)
        self.assertIn("maintenance claimed by devbox-1@", blocked.stderr)

    def test_refresh_reuses_another_devboxs_exact_proof_and_never_a_mismatched_one(self):
        set_a, machine_a, _ = self.mod["names"](NODE_A, PY_A)
        self.mod["ensure"](self.api, NODE_A, PY_A, "devbox-1")
        row = next(m for m in self.fake.machines.values() if m["name"] == machine_a)
        volume = row["config"]["mounts"][0]["volume"]
        epoch = int(time.time()) - 30
        self.fake.snapshots[volume] = [{"id": "vs_peer", "status": "created", "size": 40,
                                        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch + 10))}]
        key = subprocess.run(["bash", "-c", f"source {ROOT / 'scripts/lib/cloudbench-env.sh'}; "
                              f"cloudbench_warm_deps_metadata_key {NODE_A} {PY_A}"],
                             text=True, capture_output=True, check=True).stdout.strip()
        row["config"]["metadata"][key] = " ".join((NODE_A, PY_A, str(epoch), "vs_peer", volume, row["id"],
                                                   "navi-whisper-lux-bench"))
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as directory:
            state = Path(directory) / "state.fp"
            body = (f"MACHINE_NAME={machine_a} WARM_DEPS_STATE_FILE={state} REFRESH_PATCH_FILE=''\n"
                    f"EXPECTED_NODE_FP={NODE_A} EXPECTED_PY_FP={{py}}\n"
                    "peer_devbox_proven_snapshot; echo status=$?")
            ok = self.bash(self.refresh_functions(body.format(py=PY_A)))
            self.assertIn("vs_peer\nstatus=0", ok.stdout, ok.stderr)
            self.assertEqual(state.read_text().split(), [NODE_A, PY_A, str(epoch), "vs_peer"])
            state.unlink()
            mismatch = self.bash(self.refresh_functions(body.format(py=PY_B)))
            self.assertIn("status=1", mismatch.stdout)
            self.assertFalse(state.exists())
            patched = self.bash(self.refresh_functions(body.format(py=PY_A).replace(
                "REFRESH_PATCH_FILE=''", "REFRESH_PATCH_FILE=/some/patch")))
            self.assertIn("status=1", patched.stdout)

    def test_refresh_and_fleet_wire_the_claim_and_snapshot_the_helpers(self):
        cloud = (ROOT / "scripts" / "run-bench-cloud").read_text()
        refresh = cloud[cloud.index('if [ "$MODE" = "refresh-deps" ]; then'):]
        self.assertLess(refresh.index("acquire_app_environment_lock || exit 1"),
                        refresh.index('acquire_warm_source_claim "${MACHINE_NAME#cloudbench-warm-}" || exit 1'))
        cleanup = refresh[refresh.index("cleanup_refresh_deps() {"):refresh.index("trap cleanup_refresh_deps EXIT")]
        self.assertLess(cleanup.index("park_warm_source"), cleanup.index("release_warm_source_claim"))
        fleet = (ROOT / "scripts" / "run-bench-fleet").read_text()
        for helper in ("cloudbench-warm-source.py", "cloudbench-warm-pool.py"):
            self.assertIn(f'"$ROOT_DIR/scripts/{helper}" \\', fleet)
        self.assertLess(fleet.index("select_dependency_set_warm_source || exit 1"),
                        fleet.index('warm_pair="$(printf'))


if __name__ == "__main__":
    unittest.main()
