"""A canceled composite run may retire only from exact quiesced receipts."""

import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cleanup_test = load("cleanup_test", ROOT / "scripts/tests/cloudbench-exact-session-multi-root.test.py")
retirement = load("retirement", ROOT / "scripts/cloudbench-forensic-retirement.py")
cleanup = cleanup_test.cleanup
sealed_machine_test = load("sealed_machine_test", ROOT / "scripts/tests/cloudbench-sealed-machine-retirement.test.py")


class QuiescedForensicTest(unittest.TestCase):
    def setUp(self):
        fixture = cleanup_test.MultiRootCleanupTest("test_sealed_composite_run_covers_both_provider_sessions")
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.write_evidence()
        self.args = fixture.args
        self.out = Path(fixture.args.output_dir)
        self.manifest = cleanup.provider_manifest(self.args)
        (self.out / "guest-cleanup.run.json").write_bytes(Path(self.args.run_json).read_bytes())
        (self.out / "guest-cleanup.backend.log").write_bytes(Path(self.args.backend_log).read_bytes())
        (self.out / "guest-cleanup.quiescence.json").write_bytes(
            Path(self.args.quiescence_receipt).read_bytes())
        (self.out / "guest-cleanup.provider-manifest.json").write_text(json.dumps(self.manifest))
        receipt = {
            "schema_version": cleanup.SCHEMA, "version": 1,
            "kind": "provider-exact-cleanup",
            **cleanup.identity(self.args),
            "root_agent_id": self.manifest["root_agent_id"],
            "manifest_sha256": cleanup.canonical_digest(self.manifest),
            "results": [{"provider": "kernel", "session_id": session,
                         "http_status": 204, "response_sha256": "0" * 64}
                        for session in self.manifest["sessions"]["kernel"]],
        }
        (self.out / "guest-cleanup.recovery-receipt.json").write_text(json.dumps(receipt))
        self.row = {
            "task": self.args.bench, "machine_id": self.args.machine_id,
            "run_token": self.args.guest_run_token,
            "files": {
                "original/repo/.context/cloudbench/run.json": {
                    "sha256": self.manifest["evidence"]["run_json_sha256"]},
                "original/repo/.context/cloudbench/logs/backend.log": {
                    "sha256": self.manifest["evidence"]["backend_log_sha256"]},
            },
        }

    def test_exact_quiescence_and_both_provider_receipts_authorize_zero_credit_retirement(self):
        result = retirement.verify_quiesced_provider_archive(
            self.out, self.row, self.args.owner, self.args.fleet_run_id)
        self.assertEqual(result["sessions"]["kernel"],
                         ["kernel_gate123", "kernel_task123"])

    def test_archive_hash_mismatch_cannot_retire(self):
        self.row["files"]["original/repo/.context/cloudbench/run.json"]["sha256"] = "f" * 64
        with self.assertRaises(AssertionError):
            retirement.verify_quiesced_provider_archive(
                self.out, self.row, self.args.owner, self.args.fleet_run_id)

    def test_missing_provider_release_cannot_retire(self):
        path = self.out / "guest-cleanup.recovery-receipt.json"
        receipt = json.loads(path.read_text())
        receipt["results"].pop()
        path.write_text(json.dumps(receipt))
        with self.assertRaises(AssertionError):
            retirement.verify_quiesced_provider_archive(
                self.out, self.row, self.args.owner, self.args.fleet_run_id)


class SealedMachineRecoveryTest(unittest.TestCase):
    def test_completed_member_retires_independently_with_full_failed_owner_retained(self):
        self.assertEqual(sealed_machine_test.run_recurrence()["status"], "PASS")


if __name__ == "__main__":
    unittest.main()
