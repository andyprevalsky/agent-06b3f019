#!/usr/bin/env python3
"""The prestart recovery must never infer a guest shutdown from a stopped VM."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "cloudbench-prestart-recovery.py"
SPEC = importlib.util.spec_from_file_location("cloudbench_prestart_recovery", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PrestartRecoveryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name).resolve()
        self.owner = "a" * 32
        self.run_id = "20260929-032004-9714"
        self.app = "navi-whisper-lux-bench"
        self.registry = root / "ownership" / self.owner
        self.audit_root = root / "audits"
        self.audit = self.audit_root / self.owner
        self.claims = root / "claims"
        self.run = root / "runs" / self.run_id
        self.inventory = root / "machines.json"
        for path in (
            self.registry / "clones",
            self.audit / "pool",
            self.audit / "fresh",
            self.audit / "expected-fresh",
            self.audit / "by-machine-id",
            self.claims,
            self.run / "_batch",
            self.run / ".boot-config-barrier" / "ready",
        ):
            path.mkdir(parents=True)
        (self.registry / "guest-cleanup-unconfirmed").write_text("")
        (self.registry / "meta").write_text(
            "version=2\n"
            f"app={self.app}\nfleet_owner_token={self.owner}\n"
            "host=3d8d023dc05d58\npid=9714\npid_start=unique-birth\n"
            f"run_id={self.run_id}\nruns_root={self.run.parent}\n"
            f"audit_dir={self.audit}\ncleanup_policy=retain\n"
        )
        (self.audit / "meta").write_text(f"fleet_owner_token={self.owner}\n")
        (self.audit / "owned-clones.ids").write_text("")
        (self.audit / "owned-clones.names").write_text("")
        self.machines = []
        self.mapping = [
            ("polar-one", "1" * 14, "vol_" + "1" * 16),
            ("polar-two", "2" * 14, "vol_" + "2" * 16),
        ]
        (self.run / "_batch" / "benches.json").write_text(
            json.dumps([{"name": name} for name, _, _ in self.mapping])
        )
        for index, (bench, machine, volume) in enumerate(self.mapping):
            output = self.run / bench
            output.mkdir()
            (output / ".cid").write_text(f"pool {machine}\n")
            (output / "worker-clones.ids").write_text("")
            runtime_owner = json.dumps(
                {"version": 1, "machine_id": machine, "run_token": f"{self.owner}-{index}"}
            )
            (output / "runtime-evidence.owner.json").write_text(runtime_owner)
            (output / "runtime-evidence.pending").write_text(runtime_owner)
            if index == 0:
                (output / "boot-config-unapplied").write_text(f"{machine}\n")
            else:
                (self.run / ".boot-config-barrier" / "ready" / machine).write_text("")
            (self.audit / "pool" / machine).write_text(
                f"fleet_owner_token={self.owner}\nrun_id={self.run_id}\n"
                f"app={self.app}\nsource=borrowed-pool\n"
                f"machine_id={machine}\nvolume_id={volume}\ndisposition=claimed\n"
            )
            (self.claims / machine).write_text(
                f"fleet_owner_token={self.owner}\nhost=3d8d023dc05d58\n"
                "pid=9714\npid_start=unique-birth\ncleanup_state=unconfirmed\n"
            )
            self.machines.append(
                {
                    "id": machine,
                    "state": "stopped",
                    "config": {"mounts": [{"volume": volume}]},
                }
            )
        self.write_inventory()

    def write_inventory(self):
        self.inventory.write_text(json.dumps(self.machines))

    def validate(self):
        return MODULE.validate(
            self.registry, self.audit_root, self.claims, self.inventory, self.app
        )

    def test_publishes_only_for_an_entire_unreleased_stopped_pool(self):
        receipts = self.validate()
        self.assertEqual(len(receipts), 2)
        MODULE.publish(receipts)
        MODULE.publish(self.validate())
        for path, payload in receipts:
            self.assertEqual(path.read_bytes(), payload)
            self.assertEqual(json.loads(payload)["kind"], "no-guest-start")

    def test_rejects_start_or_ambiguous_boot_proof(self):
        output = self.run / "polar-one"
        for path in (
            self.run / ".boot-config-barrier" / "release",
            output / "post-config-start.accepted",
            output / "status-proxy.port",
        ):
            path.write_text("1")
            with self.assertRaises(ValueError):
                self.validate()
            path.unlink()
        (output / "worker-clones.ids").write_text("worker-id\n")
        with self.assertRaises(ValueError):
            self.validate()
        (output / "worker-clones.ids").write_text("")
        (output / "boot-config-unapplied").unlink()
        with self.assertRaises(ValueError):
            self.validate()

    def test_rejects_wrong_host_state_or_volume(self):
        self.machines[0]["state"] = "started"
        self.write_inventory()
        with self.assertRaises(ValueError):
            self.validate()
        self.machines[0]["state"] = "stopped"
        self.machines[0]["config"]["mounts"][0]["volume"] = "vol_wrong"
        self.write_inventory()
        with self.assertRaises(ValueError):
            self.validate()


if __name__ == "__main__":
    unittest.main()
