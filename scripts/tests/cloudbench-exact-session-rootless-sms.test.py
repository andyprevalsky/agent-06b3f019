"""A rootless SMS result may retire only from exact zero-allocation evidence."""

import argparse
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cleanup = load("exact_cleanup_sms", ROOT / "scripts/cloudbench-exact-session-cleanup.py")
retirement = load("retirement_sms", ROOT / "scripts/cloudbench-forensic-retirement.py")


class RootlessSmsCleanupTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        out = Path(temporary.name).resolve()
        self.out = out
        self.args = argparse.Namespace(
            owner="a" * 32, fleet_run_id="example-run",
            bench="sms-supervisor-closed-no-spawn", machine_id="a1234",
            output_dir=str(out), guest_run_token="example-token",
            run_json=str(out / "guest-cleanup.run.json"),
            backend_log=str(out / "guest-cleanup.backend.log"),
            quiescence_receipt=str(out / "guest-cleanup.quiescence.json"),
            manifest=str(out / "guest-cleanup.provider-manifest.json"),
            receipt=str(out / "guest-cleanup.recovery-receipt.json"),
            agents_env=str(out / "agents.env"), backend_env=str(out / "backend.env"),
        )
        self.run = {
            "execution_provenance": {
                "base_sha": "f" * 40, "workspace_patch_sha256": "none"},
            "tasks": [{"name": self.args.bench, "agent_id": "", "status": "FAILED",
                       "stop_metadata": {"runner": "sms", "owned_cleanup_verified": True}}],
        }
        self.backend = (
            "[Server] Server started\n"
            "model=SmsSession operation=update\n"
            "[Server] SIGTERM received, closing server...\n"
        )

    def write_evidence(self):
        run = Path(self.args.run_json)
        backend = Path(self.args.backend_log)
        run.write_text(json.dumps(self.run))
        backend.write_text(self.backend)
        Path(self.args.quiescence_receipt).write_text(json.dumps({
            "schema_version": "cloudbench-guest-quiescence-v1", "version": 1,
            "state": "quiesced", "machine_id": self.args.machine_id,
            "guest_run_token": self.args.guest_run_token,
            "reason": "driver-exited-services-stopped", "driver_state": "exited",
            "driver_pid": None, "driver_process_state": None,
            "stopped_service_pids": [], "backend_port": 3003,
            "services_sha256": "0" * 64,
            "run_json_sha256": cleanup.sha256_bytes(run.read_bytes()),
            "backend_log_sha256": cleanup.sha256_bytes(backend.read_bytes()),
        }))

    def test_exact_rootless_manifest_and_forensic_receipt(self):
        self.write_evidence()
        manifest = cleanup.provider_manifest(self.args)
        self.assertEqual(manifest["kind"], "provider-rootless-sms-zero-manifest")
        self.assertIsNone(manifest["root_agent_id"])
        self.assertEqual(manifest["sessions"], {"kernel": [], "steel": []})
        Path(self.args.manifest).write_text(json.dumps(manifest))
        cleanup.cleanup_manifest_sessions(self.args, manifest)
        self.assertEqual(cleanup.validate_recovery_receipt(self.args), 0)
        row = {
            "task": self.args.bench, "machine_id": self.args.machine_id,
            "run_token": self.args.guest_run_token,
            "files": {
                "original/repo/.context/cloudbench/run.json": {
                    "sha256": manifest["evidence"]["run_json_sha256"]},
                "original/repo/.context/cloudbench/logs/backend.log": {
                    "sha256": manifest["evidence"]["backend_log_sha256"]},
            },
        }
        self.assertEqual(
            retirement.verify_quiesced_provider_archive(
                self.out, row, self.args.owner, self.args.fleet_run_id
            )["kind"],
            "provider-rootless-sms-zero-manifest",
        )

    def test_legacy_source_requires_exact_unpatched_sha(self):
        self.run["tasks"][0]["stop_metadata"].pop("owned_cleanup_verified")
        self.run["execution_provenance"]["base_sha"] = cleanup.LEGACY_SMS_CLEANUP_SHA
        self.write_evidence()
        self.assertEqual(cleanup.provider_manifest(self.args)["root_agent_id"], None)
        self.run["execution_provenance"]["workspace_patch_sha256"] = "a" * 64
        self.write_evidence()
        with self.assertRaisesRegex(cleanup.CleanupEvidenceError, "completed cleanup proof"):
            cleanup.provider_manifest(self.args)

    def test_root_creation_or_provider_allocation_fails_closed(self):
        for line in (
            "[HTTP] POST /api/agents -> 201\n",
            "Created Kernel browser session sessionId=kernel_12345678\n",
            "model=BrowserSession operation=create\n",
            "model=AgentPayment operation=create\n",
        ):
            with self.subTest(line=line):
                self.backend = "[Server] Server started\n" + line + (
                    "[Server] SIGTERM received, closing server...\n"
                )
                self.write_evidence()
                with self.assertRaisesRegex(cleanup.CleanupEvidenceError, "unretired external ownership"):
                    cleanup.provider_manifest(self.args)


if __name__ == "__main__":
    unittest.main()
