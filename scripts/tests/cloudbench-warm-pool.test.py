#!/usr/bin/env python3
"""Owning regression for scripts/cloudbench-warm-pool.py (digest-bound SUSPENDED warm pool).

Runs the real CLI against an in-process fake Fly Machines API (same pattern as
cloudbench-reclaim-stopped.test.py): no flyctl, no network, no credentials.
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
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "scripts" / "cloudbench-warm-pool.py"
REAPER = runpy.run_path(str(ROOT / "scripts" / "cloudbench-reclaim-stopped.py"))
IMAGE_A = "sha256:" + "a" * 64
IMAGE_B = "sha256:" + "b" * 64
DEPS_A = "deps-aaaa"
DEPS_B = "deps-bbbb"


def donor(image=IMAGE_A):
    return {"id": "683e47df5094d8", "name": "cloudbench-warm", "state": "stopped", "region": "iad",
            "image_ref": {"digest": image},
            "config": {"image": f"registry.fly.io/navi-whisper-lux-bench@{image}",
                       "env": {"PYTHONUNBUFFERED": "1", "CLOUDBENCH_BOOT": "1", "REF": "x"},
                       "init": {"cmd": ["bash", "-c", "exec sleep infinity"]},
                       "guest": {"cpu_kind": "shared", "cpus": 1, "memory_mb": 2048},
                       "mounts": [{"volume": "vol_donor000000001", "path": "/data"}],
                       "metadata": {"rose_cloudbench_deps_x": "y"}}}


def foreign(i, state="stopped"):
    """A PR #1627-style smoke guest the pool must never touch."""
    return {"id": f"{0xf00 + i:014x}", "name": f"cloudbench-{i:024x}", "state": state, "region": "iad",
            "image_ref": {"digest": IMAGE_A},
            "config": {"image": "x", "guest": {"cpu_kind": "shared", "cpus": 4, "memory_mb": 4096},
                       "mounts": [{"volume": f"vol_foreign{i:08x}", "path": "/data"}], "metadata": {}}}


class FakeFly:
    """Machines API fixture: machines, volumes, snapshots, start/suspend/wait/exec/metadata."""

    def __init__(self, rows, *, suspend_refuse_above_mb=None, prep_fail=False, health_fail_ids=()):
        self.rows = {r["id"]: r for r in rows}
        self.volumes = {"vol_donor000000001": {"id": "vol_donor000000001", "state": "created", "size_gb": 40, "region": "iad"}}
        for r in rows:
            for m in r["config"].get("mounts") or []:
                self.volumes.setdefault(m["volume"], {"id": m["volume"], "state": "created", "size_gb": 40, "region": "iad"})
        self.snapshots = {"vol_donor000000001": [
            {"id": "vs_old", "status": "created", "created_at": "2026-10-01T00:00:00Z", "size": "40", "digest": "d1"},
            {"id": "vs_new", "status": "created", "created_at": "2026-10-27T00:00:00Z", "size": "40", "digest": "d2"},
            {"id": "vs_run", "status": "running", "created_at": "2026-10-28T00:00:00Z", "size": "40", "digest": "d3"}]}
        self.events, self.lock = [], threading.Lock()
        self.suspend_refuse_above_mb = suspend_refuse_above_mb
        self.prep_fail = prep_fail
        self.health_fail_ids = set(health_fail_ids)
        self.cold_boot_ids = set()  # Fly lost the memory snapshot: start boots from scratch
        self.counter = 0
        self.uptime = {}
        fake = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def reply(self, code, value=None):
                raw = json.dumps(value).encode() if value is not None else b""
                self.send_response(code)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def body(self):
                n = int(self.headers.get("Content-Length") or 0)
                return json.loads(self.rfile.read(n) or b"{}") if n else {}

            def parts(self):
                return urlparse(self.path).path.strip("/").split("/")

            def do_GET(self):
                p = self.parts()
                with fake.lock:
                    fake.events.append(("GET", self.path))
                    if p[-1] == "machines":
                        return self.reply(200, list(fake.rows.values()))
                    if p[-2] == "machines":
                        row = fake.rows.get(p[-1])
                        return self.reply(200, row) if row else self.reply(404, {"error": "not found"})
                    if p[-1] == "wait":
                        row = fake.rows.get(p[-2])
                        want = parse_qs(urlparse(self.path).query).get("state", [""])[0]
                        return self.reply(200, {"ok": True}) if row and row["state"] == want else self.reply(408, {"error": "timeout"})
                    if p[-1] == "snapshots":
                        return self.reply(200, fake.snapshots.get(p[-2], []))
                    if p[-1] == "volumes":
                        attached = {m["volume"]: r["id"] for r in fake.rows.values() for m in r["config"].get("mounts") or []}
                        return self.reply(200, [dict(v, attached_machine_id=attached.get(v["id"])) for v in fake.volumes.values()])
                    if p[-2] == "volumes":
                        vol = fake.volumes.get(p[-1])
                        return self.reply(200, vol) if vol else self.reply(404, {"error": "not found"})
                    return self.reply(404, {"error": self.path})

            def do_POST(self):
                p = self.parts()
                data = self.body()
                with fake.lock:
                    fake.events.append(("POST", self.path, data))
                    if p[-1] == "volumes":
                        fake.counter += 1
                        vid = f"vol_pool{fake.counter:010x}"
                        fake.volumes[vid] = {"id": vid, "name": data.get("name"), "state": "created", "size_gb": data.get("size_gb", 40),
                                             "region": data["region"], "snapshot_id": data.get("snapshot_id")}
                        return self.reply(200, fake.volumes[vid])
                    if p[-1] == "machines":
                        fake.counter += 1
                        mid = f"{0xa000 + fake.counter:014x}"
                        image = data["config"]["image"].rpartition("@")[2]
                        row = {"id": mid, "name": data["name"], "state": "started", "region": data["region"],
                               "instance_id": f"inst-{mid}", "image_ref": {"digest": image}, "config": data["config"],
                               "created_at": f"2026-10-28T19:{fake.counter:02d}:00Z"}
                        fake.rows[mid] = row
                        fake.uptime[mid] = 10.0
                        return self.reply(200, row)
                    mid = p[-2] if p[-1] in {"start", "suspend", "stop", "exec"} else (p[-3] if p[-2] == "metadata" else p[-1])
                    row = fake.rows.get(mid)
                    if row is None:
                        return self.reply(404, {"error": "not found"})
                    if p[-1] == "start":
                        row["state"] = "started"
                        if mid in fake.cold_boot_ids:
                            fake.uptime[mid] = 0.0  # snapshot lost: the guest boots from zero
                        else:
                            fake.uptime[mid] = fake.uptime.get(mid, 0) + 1.0  # memory snapshot preserved
                        return self.reply(200, {"previous_state": "suspended"})
                    if p[-1] == "suspend":
                        mem = row["config"]["guest"]["memory_mb"]
                        if fake.suspend_refuse_above_mb and mem > fake.suspend_refuse_above_mb:
                            return self.reply(422, {"error": f"machines with more than {fake.suspend_refuse_above_mb}MB cannot be suspended"})
                        row["state"] = "suspended"
                        return self.reply(200, {"previous_state": "started"})
                    if p[-1] == "stop":
                        row["state"] = "stopped"
                        return self.reply(200, {})
                    if p[-1] == "exec":
                        cmd = " ".join(data.get("command") or [])
                        fake.uptime[mid] = fake.uptime.get(mid, 0) + (1.0 if mid in fake.cold_boot_ids else 30.0)
                        if "WARM_POOL_READY" in cmd:
                            mode = data["command"][-1]
                            if (mode == "prep" and fake.prep_fail) or (mode == "health" and mid in fake.health_fail_ids):
                                return self.reply(200, {"exit_code": 1, "stdout": f"WARM_POOL_READY mode={mode} pg=0 seed=1 repo=abc1234 uptime={fake.uptime[mid]}\n", "stderr": ""})
                            return self.reply(200, {"exit_code": 0, "stdout": f"WARM_POOL_READY mode={mode} pg=1 seed=1 repo=abc1234 uptime={fake.uptime[mid]}\n", "stderr": ""})
                        if "-C /data/repo fetch --quiet origin" in cmd:
                            return self.reply(200, {"exit_code": 0, "stdout": "deadbee\n", "stderr": ""})
                        return self.reply(200, {"exit_code": 0, "stdout": "", "stderr": ""})
                    if p[-2] == "metadata":
                        row["config"].setdefault("metadata", {})[p[-1]] = data["value"]
                        return self.reply(204)
                    if p[-2] == "machines":  # config update
                        row["config"].update(data.get("config") or {})
                        return self.reply(200, row)
                    return self.reply(404, {"error": self.path})

            def do_DELETE(self):
                p = self.parts()
                with fake.lock:
                    fake.events.append(("DELETE", self.path))
                    if p[-2] == "volumes":
                        return self.reply(200, {}) if fake.volumes.pop(p[-1], None) else self.reply(404, {})
                    mid = p[-1].split("?")[0]
                    if p[-2] == "machines" and mid in fake.rows:
                        fake.rows.pop(mid)
                        return self.reply(200, {})
                    return self.reply(404, {"error": self.path})

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def members(self, pool="deploy-warm-pool"):
        return [r for r in self.rows.values() if (r["config"].get("metadata") or {}).get("deploy_warm_pool") == pool]

    def mutations(self):
        return [e for e in self.events if e[0] in {"POST", "DELETE"}]


def run(fake, *argv, expect=0):
    env = dict(os.environ, FLY_FLAPS_BASE_URL=fake.base, FLY_API_TOKEN="FlyV1 test", CLOUDBENCH_APP_MACHINE_CEILING="56")
    proc = subprocess.run([sys.executable, "-I", str(CLI), *argv, "--json"], env=env, capture_output=True, text=True, timeout=120, check=False)
    if proc.returncode != expect:
        raise AssertionError(f"exit {proc.returncode} != {expect}\nstdout={proc.stdout}\nstderr={proc.stderr}")
    return json.loads(proc.stdout) if proc.stdout.strip() else {}


class WarmPoolTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeFly([donor(), foreign(1), foreign(2, "started")])
        self.addCleanup(self.fake.close)
        self.deps = ["--deps-fingerprint", DEPS_A]
        self.common = [*self.deps, "--lease-settle", "0"]  # checkout-only settle flag

    def provision(self, size=2, **kw):
        extra = [arg for k, v in kw.items() for arg in (f"--{k.replace('_', '-')}", str(v))]
        return run(self.fake, "provision", "--size", str(size), "--deps-fingerprint", DEPS_A, "--fetch-ref", "main", *extra)

    def test_provision_clones_donor_snapshot_warms_suspends_and_tags(self):
        report = self.provision(2)
        members = self.fake.members()
        self.assertEqual(len(members), 2)
        for row in members:
            meta = row["config"]["metadata"]
            self.assertEqual(row["state"], "suspended")
            self.assertEqual(meta["deploy_warm_pool_state"], "ready")
            self.assertEqual(meta["deploy_warm_pool_image"], IMAGE_A)
            self.assertEqual(meta["deploy_warm_pool_deps"], DEPS_A)
            self.assertEqual(meta["cloudbench_protected_owner"], "deploy-warm-pool")
            self.assertEqual(meta["deploy_warm_pool_ref"], "deadbee")
            self.assertTrue(row["name"].startswith("deploy-warm-pool-"))
            self.assertIsNone(REAPER["TASK_NAME"].fullmatch(row["name"]), "pool names must not look like task Machines")
            self.assertNotIn("CLOUDBENCH_BOOT", row["config"]["env"], "pool guests must idle, not boot a driver")
            self.assertEqual(row["config"]["guest"], {"cpu_kind": "shared", "cpus": 4, "memory_mb": 2048})
            self.assertEqual(self.fake.volumes[row["config"]["mounts"][0]["volume"]]["snapshot_id"], "vs_new")
        self.assertEqual(report["snapshot"], "vs_new", "newest COMPLETED snapshot, never the running one")
        self.assertEqual(report["by_state"], {"suspended": 2})
        phases = report["provisioned"][0]["phases"]
        self.assertEqual(set(phases), {"volume_created", "machine_created", "started", "warm_ready", "ref_fetched", "suspended"})
        self.assertTrue(phases["volume_created"] <= phases["machine_created"] <= phases["started"] <= phases["warm_ready"] <= phases["suspended"])
        preps = [e for e in self.fake.events if e[0] == "POST" and e[1].endswith("/exec") and e[2]["command"][-1] == "prep"]
        self.assertEqual(len(preps), 2, "each member is warmed (Postgres started, repo verified) before suspension")
        # exact cost accounting: (8 GB rootfs + 40 GB volume) * $0.15 / 730 h
        self.assertAlmostEqual(report["cost"][0]["usd_per_hour"], 48 * 0.15 / 730, places=6)
        self.assertAlmostEqual(report["usd_per_hour_total"], 2 * 48 * 0.15 / 730, places=6)
        # foreign machines untouched; donor only read
        self.assertTrue(all("f00" not in e[1] for e in self.fake.mutations()))
        self.assertTrue(all("683e47df5094d8" not in e[1] for e in self.fake.mutations()))
        # idempotent top-up
        again = self.provision(2)
        self.assertEqual(len(self.fake.members()), 2)
        self.assertEqual(again["provisioned"], [])

    def test_reaper_classifies_pool_members_as_protected_even_when_stopped(self):
        self.provision(1)
        row = self.fake.members()[0]
        row["state"] = "stopped"  # a lost snapshot can leave a member stopped
        reason = REAPER["classify"](row, {"machines": set(), "names": set(), "volumes": set()}, None)
        self.assertEqual(reason, "not-a-task-machine-name")
        row["name"] = "cloudbench-" + "0" * 24  # even under a task-like name the metadata prefix protects it
        reason = REAPER["classify"](row, {"machines": set(), "names": set(), "volumes": set()}, None)
        self.assertEqual(reason, "protected-metadata")

    def test_checkout_resumes_exactly_one_matching_member_then_falls_back(self):
        self.provision(2)
        first = run(self.fake, "checkout", *self.common)
        self.assertTrue(first["machine"])
        self.assertEqual(self.fake.rows[first["machine"]]["state"], "started")
        self.assertTrue(self.fake.rows[first["machine"]]["config"]["metadata"]["deploy_warm_pool_state"].startswith("leased:"))
        self.assertGreater(first["guest_uptime"], 0)
        health = [e for e in self.fake.events if e[0] == "POST" and e[1].endswith("/exec") and e[2]["command"][-1] == "health"]
        self.assertEqual(len(health), 1, "resume is verified by a health probe before handing the guest over")
        second = run(self.fake, "checkout", *self.common)
        self.assertNotEqual(second["machine"], first["machine"])
        starts = [e for e in self.fake.events if e[0] == "POST" and e[1].endswith("/start")]
        self.assertEqual(len(starts), 2)
        third = run(self.fake, "checkout", *self.common, expect=3)
        self.assertIsNone(third["machine"])
        self.assertEqual(len([e for e in self.fake.events if e[0] == "POST" and e[1].endswith("/start")]), 2, "no match => no provider mutation")

    def test_checkout_refuses_digest_or_deps_mismatch(self):
        self.provision(1)
        before = len(self.fake.mutations())
        run(self.fake, "checkout", "--deps-fingerprint", DEPS_B, "--lease-settle", "0", expect=3)
        run(self.fake, "checkout", "--deps-fingerprint", DEPS_A, "--image", IMAGE_B, "--lease-settle", "0", expect=3)
        self.assertEqual(len(self.fake.mutations()), before, "mismatch must not lease, start or destroy anything")
        self.assertEqual(self.fake.members()[0]["state"], "suspended")

    def test_checkout_destroys_unhealthy_member_and_moves_on(self):
        self.provision(2)
        ids = sorted(self.fake.members(), key=lambda r: r["created_at"])
        self.fake.health_fail_ids.add(ids[0]["id"])
        receipt = run(self.fake, "checkout", *self.common)
        self.assertEqual(receipt["machine"], ids[1]["id"])
        self.assertNotIn(ids[0]["id"], self.fake.rows, "unhealthy member destroyed")
        self.assertNotIn(ids[0]["config"]["mounts"][0]["volume"], self.fake.volumes, "and its volume")
        self.assertEqual(receipt["tried"][0]["machine"], ids[0]["id"])

    # ── fleet consumption boundary (EXP-L): claim / release receipts ──────────
    def claim(self, out, *extra, expect=0):
        return run(self.fake, "claim", "--out", str(out), "--run-token", "owner-0", "--ref", "a" * 40,
                   *self.common, *extra, expect=expect)

    def test_claim_resumes_matching_member_over_running_guest_transport_without_boot_config(self):
        """Resume path chosen: the suspended member is started from its memory
        snapshot and verified, and NO boot-config update (POST /machines/<id>)
        or clone (POST /machines, volume create) happens — the fleet child
        syncs ref/patch on the running guest instead of restarting it."""
        self.provision(1)
        member = self.fake.members()[0]["id"]
        before = len(self.fake.mutations())
        with tempfile.TemporaryDirectory() as raw:
            out = Path(raw)
            receipt = self.claim(out)
            on_disk = json.loads((out / "warm-pool-claim.json").read_text())
        self.assertEqual(receipt["machine"], member)
        self.assertEqual(on_disk["machine"], member)
        self.assertEqual(on_disk["transport"], "running-guest")
        self.assertFalse(on_disk["boot_config_update"])
        self.assertIsNone(on_disk["fallback"])
        self.assertEqual(on_disk["run_token"], "owner-0")
        self.assertTrue(on_disk["memory_snapshot_preserved"], "fake start keeps uptime: snapshot resume")
        self.assertEqual(on_disk["config_updates"], 0, "no machine config update on the resume path")
        self.assertEqual(self.fake.rows[member]["state"], "started")
        self.assertEqual(self.fake.rows[member]["config"]["metadata"]["deploy_warm_pool_run"], "owner-0")
        mutations = self.fake.mutations()[before:]
        paths = [e[1] for e in mutations]
        self.assertEqual(len([p for p in paths if p.endswith("/start")]), 1)
        self.assertFalse(any(p.endswith(f"/machines/{member}") for p in paths), "no config update = no re-run of boot config")
        self.assertFalse(any(p.endswith("/machines") or p.endswith("/volumes") for p in paths), "no clone")
        self.assertFalse(any(e[0] == "DELETE" for e in mutations), "healthy member is kept for release")
        self.assertNotIn("CLOUDBENCH_BOOT", self.fake.rows[member]["config"]["env"], "guest config untouched")

    def test_claim_without_matching_member_records_clone_fallback(self):
        self.provision(1)
        before = len(self.fake.mutations())
        with tempfile.TemporaryDirectory() as raw:
            out = Path(raw)
            receipt = run(self.fake, "claim", "--out", str(out), "--deps-fingerprint", DEPS_B, "--lease-settle", "0", expect=3)
            on_disk = json.loads((out / "warm-pool-claim.json").read_text())
        self.assertIsNone(receipt["machine"])
        self.assertEqual(on_disk["fallback"], "clone")
        self.assertEqual(on_disk["candidates"], 0)
        self.assertEqual(len(self.fake.mutations()), before, "mismatch must not lease, start, destroy or clone")
        self.assertEqual(self.fake.members()[0]["state"], "suspended")

    def test_claim_destroys_unhealthy_member_and_uses_the_next(self):
        self.provision(2)
        ids = [r["id"] for r in sorted(self.fake.members(), key=lambda r: r["created_at"])]
        self.fake.health_fail_ids.add(ids[0])
        with tempfile.TemporaryDirectory() as raw:
            receipt = self.claim(Path(raw))
        self.assertEqual(receipt["machine"], ids[1])
        self.assertNotIn(ids[0], self.fake.rows, "unhealthy member destroyed")
        self.assertEqual(receipt["tried"][0]["machine"], ids[0])
        self.assertTrue(receipt["tried"][0]["outcome"].startswith("unhealthy"))

    def test_claim_reports_a_cold_boot_when_the_snapshot_was_not_preserved(self):
        self.provision(1)
        member = self.fake.members()[0]["id"]
        self.fake.cold_boot_ids.add(member)
        with tempfile.TemporaryDirectory() as raw:
            receipt = self.claim(Path(raw))
        self.assertEqual(receipt["machine"], member)
        self.assertFalse(receipt["memory_snapshot_preserved"])
        self.assertEqual(receipt["config_updates"], 0, "a cold boot is still no reconfiguration")

    def test_claim_refuses_a_second_claim_in_the_same_output(self):
        self.provision(2)
        with tempfile.TemporaryDirectory() as raw:
            self.claim(Path(raw))
            self.claim(Path(raw), expect=1)
        self.assertEqual(len([r for r in self.fake.members() if r["state"] == "started"]), 1)

    def test_release_after_claim_resuspends_and_writes_receipt(self):
        self.provision(1)
        with tempfile.TemporaryDirectory() as raw:
            out = Path(raw)
            receipt = self.claim(out)
            rel = run(self.fake, "release", receipt["machine"], "--out", str(out), *self.deps)
            on_disk = json.loads((out / "warm-pool-release.json").read_text())
        self.assertEqual(rel["action"], "suspended")
        self.assertEqual(on_disk["action"], "suspended")
        self.assertEqual(self.fake.rows[receipt["machine"]]["state"], "suspended")
        self.assertEqual(self.fake.rows[receipt["machine"]]["config"]["metadata"]["deploy_warm_pool_state"], "ready")

    def test_release_resuspends_healthy_match_and_destroys_stale(self):
        self.provision(2)
        a, b = [r["id"] for r in sorted(self.fake.members(), key=lambda r: r["created_at"])]
        run(self.fake, "checkout", *self.common)  # leases a
        self.assertEqual(self.fake.rows[a]["state"], "started")
        rel = run(self.fake, "release", a, *self.deps)
        self.assertEqual(rel["action"], "suspended")
        self.assertEqual(self.fake.rows[a]["state"], "suspended")
        self.assertEqual(self.fake.rows[a]["config"]["metadata"]["deploy_warm_pool_state"], "ready")
        run(self.fake, "checkout", *self.common)  # leases a again (oldest ready)
        stale = run(self.fake, "release", a, "--deps-fingerprint", DEPS_B)
        self.assertEqual(stale["action"], "destroyed")
        self.assertNotIn(a, self.fake.rows)
        self.assertIn(b, self.fake.rows)
        # release refuses non-members
        run(self.fake, "release", foreign(1)["id"], *self.deps, expect=1)
        self.assertIn(foreign(1)["id"], self.fake.rows)

    def test_refresh_replaces_stale_members_and_keeps_leased(self):
        self.provision(3)
        ids = [r["id"] for r in sorted(self.fake.members(), key=lambda r: r["created_at"])]
        run(self.fake, "checkout", *self.common)  # ids[0] leased + started
        self.fake.rows["683e47df5094d8"]["image_ref"]["digest"] = IMAGE_B  # donor image activated anew
        self.fake.rows["683e47df5094d8"]["config"]["image"] = f"registry.fly.io/navi-whisper-lux-bench@{IMAGE_B}"
        report = run(self.fake, "refresh", "--size", "3", "--deps-fingerprint", DEPS_A, "--fetch-ref", "")
        self.assertIn(ids[0], self.fake.rows, "leased member is never touched by refresh")
        self.assertNotIn(ids[1], self.fake.rows)
        self.assertNotIn(ids[2], self.fake.rows)
        ready = [r for r in self.fake.members() if r["config"]["metadata"]["deploy_warm_pool_state"] == "ready"]
        self.assertEqual(len(ready), 2, "size 3 = 1 leased + 2 fresh ready members")
        self.assertTrue(all(r["image_ref"]["digest"] == IMAGE_B for r in ready))
        self.assertEqual(len(report["destroyed"]), 2)

    def test_suspend_refusal_destroys_machine_and_volume_no_leak(self):
        self.fake.suspend_refuse_above_mb = 2048
        proc_report = None
        env = dict(os.environ, FLY_FLAPS_BASE_URL=self.fake.base, FLY_API_TOKEN="FlyV1 test")
        proc = subprocess.run([sys.executable, "-I", str(CLI), "provision", "--size", "1", "--memory", "4096",
                               "--deps-fingerprint", DEPS_A, "--fetch-ref", "", "--json"], env=env, capture_output=True, text=True, timeout=120, check=False)
        self.assertEqual(proc.returncode, 1, proc.stderr)
        proc_report = json.loads(proc.stdout)
        receipt = proc_report["provisioned"][0]
        self.assertFalse(receipt["ok"])
        self.assertIn("cannot be suspended", receipt["error"])
        self.assertEqual(receipt["cleanup"], "machine+volume destroyed")
        self.assertEqual(self.fake.members(), [])
        self.assertFalse(any(v.startswith("vol_pool") for v in self.fake.volumes), "no orphaned volume")

    def test_suspend_refusal_with_fallback_resizes_same_machine_once(self):
        self.fake.suspend_refuse_above_mb = 2048
        env = dict(os.environ, FLY_FLAPS_BASE_URL=self.fake.base, FLY_API_TOKEN="FlyV1 test")
        proc = subprocess.run([sys.executable, "-I", str(CLI), "provision", "--size", "1", "--memory", "4096",
                               "--suspend-fallback-memory", "2048", "--deps-fingerprint", DEPS_A, "--fetch-ref", "", "--json"],
                              env=env, capture_output=True, text=True, timeout=120, check=False)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        receipt = json.loads(proc.stdout)["provisioned"][0]
        self.assertTrue(receipt["ok"])
        self.assertEqual(receipt["suspend_refused_at_mb"], 4096)
        self.assertEqual(receipt["suspend_fallback_memory_mb"], 2048)
        self.assertIn("resized_warm_ready", receipt["phases"])
        members = self.fake.members()
        self.assertEqual(len(members), 1, "same Machine, no second clone")
        self.assertEqual(members[0]["state"], "suspended")
        self.assertEqual(members[0]["config"]["guest"]["memory_mb"], 2048)
        self.assertEqual(len([e for e in self.fake.events if e[0] == "POST" and e[1].endswith("/machines")]), 1)
        self.assertEqual(len([e for e in self.fake.events if e[0] == "POST" and e[1].endswith("/volumes")]), 1)

    def test_prep_failure_destroys_clone(self):
        self.fake.prep_fail = True
        env = dict(os.environ, FLY_FLAPS_BASE_URL=self.fake.base, FLY_API_TOKEN="FlyV1 test")
        proc = subprocess.run([sys.executable, "-I", str(CLI), "provision", "--size", "1", "--deps-fingerprint", DEPS_A,
                               "--fetch-ref", "", "--json"], env=env, capture_output=True, text=True, timeout=120, check=False)
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(self.fake.members(), [])
        self.assertFalse(any(v.startswith("vol_pool") for v in self.fake.volumes))

    def test_destroy_is_exact_owner_only(self):
        self.provision(2)
        run(self.fake, "destroy", foreign(1)["id"], expect=1)
        self.assertIn(foreign(1)["id"], self.fake.rows)
        run(self.fake, "destroy", "--all")
        self.assertEqual(self.fake.members(), [])
        self.assertIn(foreign(1)["id"], self.fake.rows)
        self.assertIn("683e47df5094d8", self.fake.rows)
        self.assertIn("vol_donor000000001", self.fake.volumes)

    def test_interrupted_provision_orphan_volume_is_reported_and_released(self):
        self.provision(1)
        member_volume = self.fake.members()[0]["config"]["mounts"][0]["volume"]
        self.assertTrue(self.fake.volumes[member_volume]["name"].startswith("warmpool_"), "pool volumes are attributable by name")
        # a provision killed between volume create and Machine create leaves this behind
        self.fake.volumes["vol_orphan0000001"] = {"id": "vol_orphan0000001", "name": "warmpool_0123456789ab", "state": "created", "size_gb": 40, "region": "iad"}
        self.fake.volumes["vol_foreignfree01"] = {"id": "vol_foreignfree01", "name": "cloudbench_t10_ord_85a7e2c", "state": "created", "size_gb": 40, "region": "iad"}
        report = run(self.fake, "status")
        self.assertEqual([v["id"] for v in report["orphan_volumes"]], ["vol_orphan0000001"])
        self.assertAlmostEqual(report["usd_per_hour_total"], (48 + 40) * 0.15 / 730, places=6, msg="orphan storage is billed too")
        result = run(self.fake, "destroy", "--all")
        self.assertEqual(result["orphan_volumes_released"], ["vol_orphan0000001"])
        self.assertNotIn("vol_orphan0000001", self.fake.volumes)
        self.assertIn("vol_foreignfree01", self.fake.volumes, "foreign unattached volumes are never touched")
        self.assertIn("vol_donor000000001", self.fake.volumes)

    def test_headroom_guard_refuses_over_ceiling(self):
        env = dict(os.environ, FLY_FLAPS_BASE_URL=self.fake.base, FLY_API_TOKEN="FlyV1 test")
        proc = subprocess.run([sys.executable, "-I", str(CLI), "provision", "--size", "4", "--max-org-machines", "5",
                               "--deps-fingerprint", DEPS_A, "--json"], env=env, capture_output=True, text=True, timeout=120, check=False)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("ceiling", proc.stderr)
        self.assertEqual(self.fake.members(), [])

    def test_status_reports_cost_without_mutation(self):
        self.provision(1)
        before = len(self.fake.mutations())
        report = run(self.fake, "status", "--rootfs-gb", "8")
        self.assertEqual(len(self.fake.mutations()), before)
        self.assertEqual(report["by_state"], {"suspended": 1})
        self.assertAlmostEqual(report["usd_per_day_total"], 48 * 0.15 / 730 * 24, places=4)
        self.assertIn("rootfs assumed 8", report["pricing_basis"])


if __name__ == "__main__":
    unittest.main()
