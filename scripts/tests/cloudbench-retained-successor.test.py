#!/usr/bin/env python3
"""Real fleet completion and campaign acceptance for retained native successors."""

import copy
import json
import os
import runpy
import shlex
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(os.environ.get("CLOUDBENCH_TEST_RETAINED_SOURCE", ROOT))
H = runpy.run_path(str(ROOT / "scripts/cloudbench-retained-successor.py"))
OLD = runpy.run_path(str(ROOT / "scripts/tests/cloudbench-archived-machine-reuse.test.py"))


def put(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, sort_keys=True) + "\n" if not isinstance(value, str) else value)
    path.chmod(0o600)


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.workspace = self.root / "workspace"
        request, machines, successor = OLD["fixture"]()
        self.proof = OLD["H"]["proof_for"](request, request["candidates"][0], successor)
        self.owner, self.run, self.task = successor["owner_token"], successor["run_id"], successor["task"]
        self.fleet = self.workspace / ".context/fleet/runs" / self.run
        self.output = self.fleet / self.task
        self.audit = self.root / "common/cloudbench-fleet-audits" / self.owner
        self.registry = self.root / "common/cloudbench-fleet-ownership" / self.owner
        self.local = self.fleet / "teardown-ownership"
        self.registry.mkdir(parents=True)
        (self.registry / "clones").mkdir()
        meta = (
            f"version=2\nfleet_owner_token={self.owner}\nrun_id={self.run}\napp=navi-whisper-lux-bench\n"
            f"workspace_root={self.workspace}\nhost={successor['controller_id']}\n"
            f"runs_root={self.fleet.parent}\naudit_dir={self.audit}\n"
        )
        put(self.registry / "meta", meta)
        put(self.audit / "meta", meta + "status=provider-teardown-verified\n")
        put(self.audit / "provider-teardown-verified.epoch", "12345\n")
        self.mid = self.proof["machine_id"]
        self.name = self.mid + ".json"
        for path in (
            self.registry / "archived-reuse" / self.name,
            self.audit / "archived-reuse" / self.name,
            self.output / "archived-reuse-proof.json",
        ):
            put(path, self.proof)
        put(self.output / ".cid", "archived-reuse " + self.mid + "\n")
        native = copy.deepcopy(machines[0])
        native["instance_id"] = "task-terminal-version"
        native["config"]["metadata"] = {
            "cloudbench_archived_reuse": H["canonical"](self.proof["native_marker"]).decode()
        }
        self.terminal = {
            "schema": self.proof["schema"],
            "proof": self.proof,
            "native": native,
            "source": "archived-reuse",
            "machine_retained": True,
            "volume_retained": True,
            "old_liabilities": "UNRESOLVED",
        }
        self.terminal_path = self.output / "archived-reuse-retirement/retained-terminal.json"
        put(self.terminal_path, self.terminal)
        H["record"](self.output / "archived-reuse-proof.json", self.terminal_path, self.audit)
        shutil.copytree(self.audit, self.local)
        put(self.local / "source-audit", f"path={self.audit}\nsha256={H['tree_digest'](self.audit)}\n")
        put(self.fleet / "teardown-ownership.path", str(self.audit) + "\n")
        put(self.fleet / "_batch/benches.json", [{"name": self.task}])
        put(
            self.fleet / "_batch/run.json",
            {
                "run_id": self.run,
                "tasks": [
                    {
                        "name": self.task,
                        "passed": True,
                        "status": "PASSED",
                        "benchmark_status": "PASSED",
                        "lifecycle_stage": "released",
                    }
                ],
            },
        )
        self.log = self.root / "job.log"
        put(self.log, f"{self.workspace}/scripts/run-bench monitor {self.fleet}\n")

    def released(self):
        return H["released"](self.registry, self.audit, self.fleet, self.owner, self.run)

    def fleet_completion(self):
        source = (SOURCE / "scripts/run-bench-fleet").read_text()
        marker = "fleet_registry_release_verified() {"
        function = ""
        if marker in source:
            start = source.index(marker)
            function = source[start : source.index("\n}\n", start) + 3]
        start = source.index("    # Keep the parent live while releasing resources.")
        end = source.index("    # Teardown and final publication both need", start)
        hub = self.root / "hub.py"
        hub.write_text(
            "import json,sys\nfrom pathlib import Path\nPath("
            + repr(str(self.root / "hub.json"))
            + ").write_text(json.dumps(sys.argv[1:]))\n"
        )
        values = {
            "FLEET_DIR": self.fleet,
            "FLEET_OWNER_TOKEN": self.owner,
            "RUN_ID": self.run,
            "ROOT_DIR": self.workspace,
            "FLEET_TEARDOWN_OWNERSHIP_DIR": self.audit,
            "FLEET_REGISTRY_DIR": self.registry,
            "HUB_UPLOAD_HELPER": hub,
            "CLOUDBENCH_SCRIPT_SNAPSHOT": ROOT / "scripts",
            "BENCHMARK_HUB_PARENT_RUN_ID": "parent",
            "SELF_MANAGED_HUB_RUN": 1,
            "FLEET_EXECUTION_COMPLETED": 1,
            "AUTOSCALER_FAILURE": 0,
            "teardown_failed": 0,
            "KEEP_CLONES": 0,
            "publication_failed": 0,
            "ec": 0,
        }
        script = "\n".join(f"{key}={shlex.quote(str(value))}" for key, value in values.items())
        script += "\n" + function + "\nfinalize_terminal_projection() { return 0; }\ncomplete() {\n"
        script += source[start:end] + "\n}\ncomplete\n"
        subprocess.run(["bash", "-eu", "-c", script], check=True, capture_output=True)
        return json.loads((self.fleet / "_batch/lifecycle.json").read_text())

    def campaign(self):
        return runpy.run_path(str(SOURCE / "scripts/run-bench-campaign.py"))["released_attempt"](
            self.workspace, {"log": str(self.log), "task": self.task}
        )

    def test_actual_fleet_lifecycle_publication_and_campaign(self):
        before = {path: path.read_bytes() for path in self.registry.rglob("*") if path.is_file()}
        lifecycle = self.fleet_completion()
        self.assertEqual(lifecycle["status"], "verified")
        self.assertEqual(json.loads((self.root / "hub.json").read_text())[0], "--upload-final")
        result = self.campaign()
        self.assertTrue(result["resources_released"])
        self.assertTrue(result["lifecycle_verified"])
        self.assertTrue(result["terminal_task"])
        self.assertEqual(before, {path: path.read_bytes() for path in self.registry.rglob("*") if path.is_file()})

    def test_native_or_evidence_failure_never_qualifies(self):
        self.assertTrue(self.released())
        cases = [
            lambda value: value["native"].update(state="started"),
            lambda value: value["native"]["config"].update(mounts=[]),
            lambda value: value["native"]["config"]["metadata"].update(cloudbench_archived_reuse="foreign"),
            lambda value: value.update(
                proof=dict(self.proof, successor=dict(self.proof["successor"], owner_token="0" * 32))
            ),
        ]
        for change in cases:
            with self.subTest(change=change):
                bad = copy.deepcopy(self.terminal)
                change(bad)
                with self.assertRaises(ValueError):
                    H["terminal"](self.proof, bad)
                for path in (
                    self.terminal_path,
                    self.audit / "retained-successors" / self.name,
                    self.local / "retained-successors" / self.name,
                ):
                    put(path, bad)
                with self.assertRaises(ValueError):
                    self.released()
        put(self.audit / "retained-successors" / self.name, self.terminal)
        put(self.local / "retained-successors" / self.name, self.terminal)
        put(self.terminal_path, self.terminal)
        for latch in ("runtime-evidence-unconfirmed", "guest-cleanup-unconfirmed"):
            put(self.registry / latch, "")
            with self.assertRaises(ValueError):
                self.released()
            (self.registry / latch).unlink()
        put(self.registry / "clones/unknown", "id=unknown\n")
        with self.assertRaises(ValueError):
            self.released()

    def test_current_claim_and_complete_snapshot_are_required(self):
        put(self.audit / "additional-receipt", "changed\n")
        with self.assertRaises(ValueError):
            self.released()
        put(self.local / "additional-receipt", "changed\n")
        with self.assertRaises(ValueError):
            self.released()
        (self.audit / "additional-receipt").unlink()
        (self.local / "additional-receipt").unlink()
        (self.local / "retained-successors" / self.name).unlink()
        with self.assertRaises(ValueError):
            self.released()
        put(self.local / "retained-successors" / self.name, self.terminal)
        path = self.registry / "archived-reuse" / self.name
        path.unlink()
        path.symlink_to(self.audit / "archived-reuse" / self.name)
        with self.assertRaises(ValueError):
            self.released()

    def test_pending_task_and_failed_lifecycle_are_not_success(self):
        self.fleet_completion()
        record = json.loads((self.fleet / "_batch/run.json").read_text())
        record["tasks"][0].update(benchmark_status="RUNNING", passed=None)
        put(self.fleet / "_batch/run.json", record)
        self.assertFalse(self.campaign()["resources_released"])
        record["tasks"][0].update(benchmark_status="FAILED", passed=False)
        put(self.fleet / "_batch/run.json", record)
        self.assertTrue(self.campaign()["terminal_task"])
        lifecycle = json.loads((self.fleet / "_batch/lifecycle.json").read_text())
        lifecycle["status"] = "failed"
        put(self.fleet / "_batch/lifecycle.json", lifecycle)
        self.assertFalse(self.campaign()["lifecycle_verified"])

    def test_active_native_receipt_blocks_final_publication_and_release(self):
        bad = copy.deepcopy(self.terminal)
        bad["native"]["state"] = "started"
        for path in (
            self.terminal_path,
            self.audit / "retained-successors" / self.name,
            self.local / "retained-successors" / self.name,
        ):
            put(path, bad)
        put(self.local / "source-audit", f"path={self.audit}\nsha256={H['tree_digest'](self.audit)}\n")
        self.assertEqual(self.fleet_completion()["status"], "failed")
        self.assertEqual(json.loads((self.root / "hub.json").read_text())[0], "--upload-live")
        self.assertFalse(self.campaign()["resources_released"])

    def test_normal_absent_registry_keeps_original_completion_path(self):
        shutil.rmtree(self.registry)
        self.assertEqual(self.fleet_completion()["status"], "verified")
        self.assertEqual(json.loads((self.root / "hub.json").read_text())[0], "--upload-final")
        self.assertTrue(self.campaign()["lifecycle_verified"])


if __name__ == "__main__":
    unittest.main()
