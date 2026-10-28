"""A composite benchmark's two exact roots must be recoverable together.

Also owns exact Tilion cleanup: one Tilion account is shared by prod, dev and
benchmarks, so only exact session ids from this guest's evidence are released.
"""

import argparse
import importlib.util
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

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


TILION_A = "sess_3d245e56b86d4bc8ae32095b644117d4"
TILION_B = "sess_6ac44536ab704d77b335f09ca281ada1"
TILION_CREATE_OK = "[Tilion] Tilion request method=POST path=/v1/session status=201 attempt=1"


class FakeResponse:
    def __init__(self, status, body=b""):
        self.status = status
        self._body = body

    def read(self, _limit):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


def http_error(status, body=b"{}"):
    error = urllib.error.HTTPError("https://back.tilion.dev", status, "x", {}, None)
    error.read = lambda _limit: body
    return error


class TilionExactCleanupTest(MultiRootCleanupTest):
    def setUp(self):
        super().setUp()
        self.env = Path(self.temp.name) / "backend.env"
        self.env.write_text("TILION_API_KEY=tl_fake_cleanup_key\n")
        self.args.backend_env = str(self.env)
        self.args.agents_env = str(Path(self.temp.name) / "agents.env")
        self.args.receipt = str(Path(self.temp.name).resolve() / "receipt.json")
        replacements = {
            "Created Kernel browser session sessionId=kernel_gate123": [
                TILION_CREATE_OK,
                f"[Tilion] Created Tilion browser session sessionId={TILION_A} proxyType=isp",
            ],
            "Created Kernel browser session sessionId=kernel_task123": [
                TILION_CREATE_OK,
                json.dumps({"level": "info", "component": "Tilion",
                            "message": "Created Tilion browser session",
                            "sessionId": TILION_B}),
            ],
        }
        self.backend_lines = [
            new for line in self.backend_lines for new in replacements.get(line, [line])
        ]

    def test_sealed_composite_run_covers_both_provider_sessions(self):
        self.write_evidence()
        manifest = cleanup.provider_manifest(self.args)
        self.assertEqual(manifest["sessions"],
                         {"kernel": [], "steel": [], "tilion": [TILION_A, TILION_B]})

    def test_kernel_only_manifest_shape_is_unchanged(self):
        sessions, _, _ = cleanup.collect_session_evidence(
            "Created Kernel browser session sessionId=kernel_gate123\n")
        self.assertEqual(sessions, {"kernel": ["kernel_gate123"], "steel": []})
        self.assertEqual(cleanup.collect_session_evidence(""),
                         ({"kernel": [], "steel": []}, 0, 0))

    def test_every_adapter_marker_and_db_row_is_owner_evidence(self):
        text = "\n".join([
            TILION_CREATE_OK,
            "[Tilion] Tilion geo unsupported; recreating with a wider pin sessionId=sess_geo00001",
            "[Tilion] Tilion geo pin unsupported; keeping country exit sessionId=sess_geo00002",
            "[Tilion] Tilion session failed validation; creating another sessionId=sess_val00001",
            "Error: Tilion session sess_val00002 failed validation and cleanup",
            "[Tilion] Failed to release Tilion session; retaining retryable local session state "
            "sessionId=sess_rel00001",
        ])
        sessions, events, _ = cleanup.collect_session_evidence(text)
        self.assertEqual(sessions["tilion"], sorted([
            "sess_geo00001", "sess_geo00002", "sess_val00001", "sess_val00002", "sess_rel00001",
        ]))
        self.assertEqual(events, 6)
        # A single-root run whose DB snapshot names a Tilion row the logs missed.
        self.run["tasks"][0]["agent_id"] = GATE
        self.run["tasks"][0]["logs"]["cloud_cleanup_evidence"] = {
            "root_agent_id": GATE,
            "before": {
                "root_exists": True, "tree_agent_ids": [GATE, TASK],
                "browser_sessions": [{"agent_id": TASK, "provider": "tilion",
                                      "session_id": "sess_dbrow0001"}],
            },
        }
        self.write_evidence()
        manifest = cleanup.provider_manifest(self.args)
        self.assertIn("sess_dbrow0001", manifest["sessions"]["tilion"])

    def test_allocation_log_owns_a_session_that_died_before_validation(self):
        # The worker died after the create response, before any Created line.
        text = "\n".join([
            TILION_CREATE_OK,
            "[Tilion] Tilion session allocated sessionId=sess_alloc0001 "
            "idempotencyKey=rose-0f4c proxyType=residential",
            json.dumps({"message": "Tilion exit placed at country level; narrower targeting unavailable",
                        "sessionId": "sess_alloc0001"}),
        ])
        sessions, events, _ = cleanup.collect_session_evidence(text)
        self.assertEqual(sessions["tilion"], ["sess_alloc0001"])
        self.assertEqual(events, 3)
        # A create response without an id is logged as null: still fail closed.
        with self.assertRaises(cleanup.CleanupEvidenceError):
            cleanup.collect_session_evidence(
                TILION_CREATE_OK + "\n" + json.dumps({"message": "Tilion session allocated", "sessionId": None}))

    def test_create_without_exact_session_id_fails_closed(self):
        for line in (TILION_CREATE_OK,
                     "[Tilion] Tilion request failed before a response method=POST "
                     "path=/v1/session attempt=1"):
            with self.subTest(line=line):
                with self.assertRaisesRegex(cleanup.CleanupEvidenceError, "exact session id"):
                    cleanup.collect_session_evidence(line + "\n")
        # A refused create allocated nothing, but still counts against zero proofs.
        sessions, events, _ = cleanup.collect_session_evidence(
            "[Tilion] Tilion request method=POST path=/v1/session status=429 attempt=1\n")
        self.assertEqual((sessions, events), ({"kernel": [], "steel": []}, 1))
        # Reads and other session routes are not creates.
        sessions, events, _ = cleanup.collect_session_evidence(
            f"[Tilion] Tilion request method=POST path=/v1/session/{TILION_A}/view-token "
            "status=200 attempt=1\n")
        self.assertEqual(events, 0)

    def test_release_deletes_only_the_exact_session_and_retries_transient_gateway_statuses(self):
        calls = []

        def urlopen(request, timeout):
            calls.append((request.get_method(), request.full_url,
                          request.get_header("Authorization")))
            status = responses.pop(0)
            if status >= 400:
                raise http_error(status)
            return FakeResponse(status)

        # 502/504 are the gateway's transient answers (a 502 failed a passing local
        # browser-smoke run's release, #1604 RCA 2026-10-28); 503 is Tilion's own.
        for sequence, expected in (([204], 204), ([404], 404), ([410], 410),
                                   ([503, 503, 204], 204), ([502, 204], 204),
                                   ([504, 502, 404], 404), ([502, 503, 504, 410], 410)):
            with self.subTest(sequence=sequence):
                calls.clear()
                responses = list(sequence)
                with mock.patch.object(cleanup.urllib.request, "urlopen", urlopen), \
                        mock.patch.object(cleanup.time, "sleep") as sleep:
                    status, _ = cleanup.provider_request("tilion", TILION_A, (self.env,))
                self.assertEqual(status, expected)
                self.assertEqual(sleep.call_count, len(sequence) - 1)
                self.assertEqual(calls, [(
                    "DELETE", f"https://back.tilion.dev/v1/session/{TILION_A}",
                    "Bearer tl_fake_cleanup_key")] * len(sequence))

        for sequence in ([503] * cleanup.TILION_RELEASE_ATTEMPTS, [502] * cleanup.TILION_RELEASE_ATTEMPTS,
                         [401], [500]):
            with self.subTest(sequence=sequence):
                responses = list(sequence)
                with mock.patch.object(cleanup.urllib.request, "urlopen", urlopen), \
                        mock.patch.object(cleanup.time, "sleep"):
                    with self.assertRaisesRegex(cleanup.CleanupEvidenceError, "Tilion exact"):
                        cleanup.provider_request("tilion", TILION_A, (self.env,))
                self.assertEqual(responses, [])

    def test_missing_tilion_key_fails_before_any_request(self):
        self.env.write_text("")
        with mock.patch.object(cleanup.urllib.request, "urlopen") as urlopen, \
                mock.patch.dict(cleanup.os.environ, {"TILION_API_KEY": ""}):
            with self.assertRaisesRegex(cleanup.CleanupEvidenceError, "credential is missing"):
                cleanup.provider_request("tilion", TILION_A, (self.env,))
        urlopen.assert_not_called()

    def test_cleanup_keeps_a_complete_receipt_per_session(self):
        self.write_evidence()
        manifest = cleanup.provider_manifest(self.args)
        statuses = {TILION_A: 204, TILION_B: 410}

        def urlopen(request, timeout):
            status = statuses[request.full_url.rsplit("/", 1)[1]]
            if status >= 400:
                raise http_error(status)
            return FakeResponse(status)

        with mock.patch.object(cleanup.urllib.request, "urlopen", urlopen):
            self.assertEqual(cleanup.cleanup_manifest_sessions(self.args, manifest), 0)
        receipt = json.loads(Path(self.args.receipt).read_text())
        self.assertEqual([(r["provider"], r["session_id"], r["http_status"])
                          for r in receipt["results"]],
                         [("tilion", TILION_A, 204), ("tilion", TILION_B, 410)])
        self.assertTrue(cleanup.validate_provider_receipt(receipt, manifest))
        receipt["results"][1]["http_status"] = 503
        self.assertFalse(cleanup.validate_provider_receipt(receipt, manifest))
        # Re-running with the stored receipt makes no provider call.
        with mock.patch.object(cleanup.urllib.request, "urlopen") as again:
            self.assertEqual(cleanup.cleanup_manifest_sessions(self.args, manifest), 0)
        again.assert_not_called()


if __name__ == "__main__":
    unittest.main()
