#!/usr/bin/env python3
"""Explicit lost-runtime-evidence release refuses anything not provider-terminal.

PR #1864 (2026-11-11): four smoke fleet owners whose Machines were destroyed and
volumes pending_destroy kept `runtime-evidence-unconfirmed` forever, blocking
deploy smoke custody. `--recover-stale-owner TOKEN --accept-lost-runtime-evidence`
records the loss and clears only that latch after native provider reads prove
every owned resource is terminal.
"""
import json
import os
import re
import runpy
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HELPER = runpy.run_path(str(ROOT / "scripts/cloudbench-lost-evidence-release.py"))
TOKEN = "67e077a4f2224fe9a4f8f6fc0c828a19"
MACHINE, VOLUME = "899233c6107948", "vol_vgnwj6d1xe363284"


class NotFound(Exception):
    pass


class FakeFly:
    not_found = NotFound

    def __init__(self, states):
        self.states, self.calls = states, []

    def api(self, method, path, observer=None):
        self.calls.append((method, path))
        assert method == "GET"
        kind, ident = path.strip("/").split("/")
        value = self.states.get(ident)
        if value is None:
            observer(method, path, 404, b'{"error":"not found"}')
            raise NotFound(path)
        payload = json.dumps({"id": ident, **value}).encode()
        observer(method, path, 200, payload)
        return json.loads(payload)


class LostEvidenceRelease(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.root = base / "repo"
        self.root.mkdir()
        self.registry = base / "ownership" / TOKEN
        self.audit_root = base / "audits"
        audit = self.audit_root / TOKEN
        (audit / "fresh").mkdir(parents=True)
        self.registry.mkdir(parents=True)
        meta = (f"version=2\napp=bench\nfleet_owner_token={TOKEN}\npid=999999999\n"
                f"pid_start=proc-start:x:1\nrun_id=20261111-113622-1666748\nworkspace_root={self.root}\n")
        (self.registry / "meta").write_text(meta + "cleanup_policy=reap\n")
        (audit / "meta").write_text(meta + "status=incomplete\n")
        (audit / "fresh/clone").write_text(
            f"version=1\nfleet_owner_token={TOKEN}\napp=bench\nmachine_id={MACHINE}\nvolume_id={VOLUME}\n")
        (self.registry / "runtime-evidence-unconfirmed").write_text("latch\n")

    def tearDown(self):
        self.tmp.cleanup()

    def release(self, states):
        client = FakeFly(states)
        return HELPER["release"](self.registry, self.audit_root, "bench", self.root, client), client

    def refused(self, states, pattern):
        with self.assertRaisesRegex(HELPER["Refused"], pattern):
            self.release(states)
        self.assertTrue((self.registry / "runtime-evidence-unconfirmed").is_file(), "latch kept on refusal")
        self.assertFalse((self.audit_root / TOKEN / "runtime-evidence-lost.json").exists())

    def test_terminal_resources_record_loss_and_clear_only_the_latch(self):
        receipt, client = self.release({MACHINE: {"state": "destroyed"},
                                        VOLUME: {"state": "pending_destroy", "attached_machine_id": None}})
        self.assertEqual({("GET", f"/machines/{MACHINE}"), ("GET", f"/volumes/{VOLUME}")}, set(client.calls))
        self.assertEqual("LOST", receipt["runtime_evidence"])
        self.assertEqual("NOT_REQUIRED", receipt["guest_cleanup"])
        self.assertFalse(receipt["outcome_credit"])
        saved = json.loads((self.audit_root / TOKEN / "runtime-evidence-lost.json").read_text())
        self.assertEqual(receipt, saved)
        self.assertTrue(all(re.fullmatch("[0-9a-f]{64}", r["response_sha256"]) for r in saved["observations"]))
        self.assertFalse((self.registry / "runtime-evidence-unconfirmed").exists())
        self.assertTrue((self.registry / "meta").is_file(), "ordinary recovery still owns registry teardown")

    def test_purged_guest_cleanup_latch_is_recorded_lost_with_evidence(self):
        (self.registry / "guest-cleanup-unconfirmed").write_text("latch\n")
        receipt, _ = self.release({})
        self.assertEqual("LOST", receipt["guest_cleanup"])
        self.assertEqual(["runtime-evidence-unconfirmed", "guest-cleanup-unconfirmed"], receipt["latches_cleared"])
        self.assertFalse((self.registry / "guest-cleanup-unconfirmed").exists())
        self.assertIn("cleanup_policy=reap", (self.registry / "meta").read_text())

    def test_interrupted_guest_release_resumes_to_reap_only_after_terminal_reread(self):
        (self.registry / "guest-cleanup-unconfirmed").write_text("latch\n")
        meta = (self.registry / "meta").read_text().replace("cleanup_policy=reap", "cleanup_policy=retain")
        (self.registry / "meta").write_text(meta)
        self.release({})
        (self.registry / "meta").write_text(meta)  # interrupted before the policy flip
        with self.assertRaisesRegex(HELPER["Refused"], "not destroyed"):
            self.release({MACHINE: {"state": "started"}})
        self.assertIn("cleanup_policy=retain", (self.registry / "meta").read_text())
        self.release({})
        self.assertIn("cleanup_policy=reap", (self.registry / "meta").read_text())
        with self.assertRaisesRegex(HELPER["Refused"], "already recorded"):
            self.release({})

    def test_guest_latch_alone_still_requires_terminal_resources(self):
        (self.registry / "runtime-evidence-unconfirmed").unlink()
        (self.registry / "guest-cleanup-unconfirmed").write_text("latch\n")
        with self.assertRaisesRegex(HELPER["Refused"], "not destroyed"):
            self.release({MACHINE: {"state": "stopped"}})
        self.assertTrue((self.registry / "guest-cleanup-unconfirmed").is_file())
        receipt, _ = self.release({MACHINE: {"state": "destroyed"}, VOLUME: {"state": "destroyed"}})
        self.assertEqual("LOST", receipt["guest_cleanup"])

    def test_claimed_pool_machine_must_be_terminal_before_release(self):
        pool = self.audit_root / TOKEN / "pool"
        pool.mkdir()
        claimed, claimed_volume = "aaaa1111bbbb22", "vol_cccc3333dddd4444"
        (pool / claimed).write_text(f"volume_id={claimed_volume}\ndisposition=claimed\n")
        (pool / "eeee5555ffff66").write_text("volume_id=vol_gggg7777hhhh8888\n"
                                             "disposition=returned-stopped-claim-released\n")
        terminal = {MACHINE: {"state": "destroyed"}, VOLUME: {"state": "destroyed"}}
        self.refused({**terminal, claimed: {"state": "started"}}, "not destroyed")
        receipt, client = self.release({**terminal, claimed: {"state": "destroyed"},
                                        claimed_volume: {"state": "destroyed"}})
        self.assertIn(("GET", f"/machines/{claimed}"), client.calls)
        self.assertNotIn(("GET", "/machines/eeee5555ffff66"), client.calls, "returned pool Machine is not owned")
        self.assertEqual("LOST", receipt["runtime_evidence"])

    def test_absent_resources_are_terminal(self):
        receipt, _ = self.release({})
        self.assertEqual({"absent"}, {r["state"] for r in receipt["observations"]})

    def test_live_or_attached_resources_refuse(self):
        self.refused({MACHINE: {"state": "stopped"}, VOLUME: {"state": "pending_destroy"}}, "not destroyed")
        self.refused({MACHINE: {"state": "started"}, VOLUME: {"state": "destroyed"}}, "not destroyed")
        self.refused({MACHINE: {"state": "destroyed"}, VOLUME: {"state": "created", "attached_machine_id": None}},
                     "volume")
        self.refused({MACHINE: {"state": "destroyed"},
                      VOLUME: {"state": "pending_destroy", "attached_machine_id": MACHINE}}, "volume")

    def test_identity_latch_and_live_controller_refuse(self):
        terminal = {MACHINE: {"state": "destroyed"}, VOLUME: {"state": "destroyed"}}
        meta = (self.registry / "meta").read_text()
        (self.registry / "meta").write_text(meta.replace("app=bench", "app=other"))
        self.refused(terminal, "identity mismatch: app")
        (self.registry / "meta").write_text(meta.replace(
            "pid=999999999\npid_start=proc-start:x:1", f"pid={os.getpid()}\npid_start="))
        self.refused(terminal, "original controller still running")
        (self.registry / "meta").write_text(meta)
        (self.registry / "runtime-evidence-unconfirmed").unlink()
        with self.assertRaisesRegex(HELPER["Refused"], "latch absent"):
            self.release(terminal)

    def test_flag_is_only_valid_with_exact_owner_recovery(self):
        result = subprocess.run(["bash", str(ROOT / "scripts/run-bench-fleet"), "--accept-lost-runtime-evidence",
                                 "--recover-stale-owner-to-pool", TOKEN], capture_output=True, text=True,
                                env={**os.environ, "FLY_API_TOKEN": "fixture"}, timeout=120)
        self.assertEqual(2, result.returncode, result.stderr[-500:])
        self.assertIn("valid only with --recover-stale-owner", result.stderr)
        fleet = (ROOT / "scripts/run-bench-fleet").read_text()
        self.assertIn('"$ROOT_DIR/scripts/cloudbench-lost-evidence-release.py"', fleet,
                      "helper must be in the controller script snapshot")


if __name__ == "__main__":
    unittest.main()
