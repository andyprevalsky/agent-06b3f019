"""A composite benchmark's two exact roots must be recoverable together."""

import argparse
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "exact_cleanup", ROOT / "scripts/cloudbench-exact-session-cleanup.py"
)
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)

GATE = "a3370496-a7f8-453b-911d-1a322b9990f5"
TASK = "c74c6fe9-9538-4e47-bf22-6296bc6eb8ad"


class MultiRootCleanupTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name).resolve()
        self.args = argparse.Namespace(
            owner="a" * 32,
            fleet_run_id="example-run",
            bench="minted-agent-accounts-x",
            machine_id="a1234",
            output_dir=str(base),
            guest_run_token="example-token",
            run_json=str(base / "run.json"),
            backend_log=str(base / "backend.log"),
            quiescence_receipt=str(base / "quiescence.json"),
        )
        self.run = {
            "tasks": [{"name": self.args.bench, "agent_id": f"{GATE},{TASK}",
                       "logs": {"cloud_cleanup_evidence": {"root_agent_id": f"{GATE},{TASK}"}}}]
        }
        self.backend_lines = [
            "[Server] Server started",
            "[HTTP] POST /api/agents -> 201",
            f"model=Agent operation=read path=/api/agents/{GATE}",
            "Created Kernel browser session sessionId=kernel_gate123",
            "[HTTP] POST /api/agents -> 201",
            f"model=Agent operation=read path=/api/agents/{TASK}",
            "Created Kernel browser session sessionId=kernel_task123",
            "[Server] SIGTERM received, closing server...",
        ]

    def write_evidence(self):
        run_path = Path(self.args.run_json)
        backend_path = Path(self.args.backend_log)
        run_path.write_text(json.dumps(self.run))
        backend_path.write_text("\n".join(self.backend_lines) + "\n")
        receipt = {
            "schema_version": "cloudbench-guest-quiescence-v1", "version": 1,
            "state": "quiesced", "machine_id": self.args.machine_id,
            "guest_run_token": self.args.guest_run_token,
            "reason": "driver-exited-services-stopped", "driver_state": "exited",
            "driver_pid": None, "driver_process_state": None,
            "stopped_service_pids": [], "backend_port": 3003,
            "services_sha256": "0" * 64,
            "run_json_sha256": cleanup.sha256_bytes(run_path.read_bytes()),
            "backend_log_sha256": cleanup.sha256_bytes(backend_path.read_bytes()),
        }
        Path(self.args.quiescence_receipt).write_text(json.dumps(receipt))

    def test_sealed_composite_run_covers_both_provider_sessions(self):
        self.write_evidence()
        manifest = cleanup.provider_manifest(self.args)
        self.assertEqual(manifest["root_agent_id"], f"{GATE},{TASK}")
        self.assertEqual(manifest["sessions"]["kernel"],
                         ["kernel_gate123", "kernel_task123"])

    def test_missing_second_root_boundary_fails_closed(self):
        self.backend_lines.remove(f"model=Agent operation=read path=/api/agents/{TASK}")
        self.write_evidence()
        with self.assertRaisesRegex(cleanup.CleanupEvidenceError, "exact root agent"):
            cleanup.provider_manifest(self.args)

    def test_duplicate_root_fails_closed(self):
        self.run["tasks"][0]["agent_id"] = f"{GATE},{GATE}"
        self.write_evidence()
        with self.assertRaisesRegex(cleanup.CleanupEvidenceError, "exact root agent"):
            cleanup.provider_manifest(self.args)


if __name__ == "__main__":
    unittest.main()
