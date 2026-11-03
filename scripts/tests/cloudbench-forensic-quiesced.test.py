"""A canceled composite run may retire only from exact quiesced receipts."""

import hashlib
import io
import os
import sys
import tarfile
from unittest.mock import patch
import argparse
import tempfile
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_AGENTS_VENV = ROOT / "agents" / "venv" / "bin" / "python"
if _AGENTS_VENV.is_file() and Path(sys.executable).resolve() != _AGENTS_VENV.resolve():
    os.execv(str(_AGENTS_VENV), [str(_AGENTS_VENV), *sys.argv])


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


class StoppedArchiveExtensionTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.out = Path(temporary.name).resolve()
        self.args = argparse.Namespace(
            owner="a" * 32, fleet_run_id="failed-run", bench="ordinary-task",
            machine_id="b" * 14, output_dir=str(self.out),
            guest_run_token="a" * 32 + "-0", clone_name="cloudbench-original",
            backend_log=str(self.out / "guest-cleanup.backend.log"),
            manifest=str(self.out / "guest-cleanup.provider-manifest.json"),
            machine_status=str(self.out / "guest-cleanup.machine-status.txt"),
            stopped_proof=str(self.out / "guest-cleanup.machine-stopped.json"),
            state_receipt=None,
        )
        self.backend = (
            "[Server] Server started\n[HTTP] POST /api/agents -> 201\n"
            f"model=Agent operation=read path=/api/agents/{cleanup_test.TASK}\n"
            "Created Kernel browser session sessionId=kernel_task123\n"
        ).encode()
        Path(self.args.backend_log).write_bytes(self.backend)
        Path(self.args.machine_status).write_text(
            f"Machine ID: {self.args.machine_id}\nState: stopped\nVM\n"
            f"ID = {self.args.machine_id}\nState = stopped\nName = {self.args.clone_name}\n"
        )
        provider = cleanup.active_provider_manifest(self.args)
        Path(self.args.manifest).write_text(json.dumps(provider))
        stopped = cleanup.stopped_machine_proof(self.args)
        Path(self.args.stopped_proof).write_text(json.dumps(stopped))
        receipt = {
            "schema_version": cleanup.SCHEMA, "version": 1,
            "kind": "provider-exact-cleanup", **cleanup.identity(self.args),
            "root_agent_id": provider["root_agent_id"],
            "manifest_sha256": cleanup.canonical_digest(provider),
            "stopped_machine_proof_sha256": cleanup.canonical_digest(stopped),
            "results": [{"provider": "kernel", "session_id": "kernel_task123",
                         "http_status": 204, "response_sha256": "0" * 64}],
        }
        (self.out / "guest-cleanup.recovery-receipt.json").write_text(json.dumps(receipt))
        self.row = {"task": self.args.bench, "machine_id": self.args.machine_id,
                    "run_token": self.args.guest_run_token}

    def verify(self, backend):
        retirement.verify_failed_stack_provider_archive(
            self.out, self.row, self.args.owner, self.args.fleet_run_id,
            {"repo/.context/cloudbench/services.json": b'{"status":"failed"}',
             "repo/.context/cloudbench/logs/backend.log": backend},
        )

    def test_unchanged_cleanup_receipt_covers_later_complete_diagnostic_log(self):
        self.verify(self.backend + b"[Server] SIGTERM received, closing server...\n")

    def test_appended_ownership_cannot_borrow_earlier_receipt(self):
        for suffix in (
            b"Created Kernel browser session sessionId=kernel_late123\n",
            b"model=BrowserSession operation=update\n",
            b"[HTTP] POST /api/agents -> 201\n",
            b"model=AgentPayment operation=create\n",
        ):
            with self.subTest(suffix=suffix), self.assertRaises((AssertionError, cleanup.CleanupEvidenceError)):
                self.verify(self.backend + suffix)

    def test_rewritten_original_prefix_cannot_borrow_earlier_receipt(self):
        with self.assertRaises(AssertionError):
            self.verify(b"rewritten\n" + self.backend)


bootstrap_test = load("bootstrap_test", ROOT / "scripts/tests/cloudbench-bootstrap-recovery.test.py")
worker_test = load("worker_test", ROOT / "agents/benchmarks/cloudbench_worker_evidence_test.py")


class PreServiceArchiveTest(unittest.TestCase):
    def setUp(self):
        fixture = bootstrap_test.BootstrapRecoveryTest()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.fixture = fixture
        self.meta = retirement.fields(fixture.registry / "meta")
        token = bootstrap_test.TOKEN
        self.originals = {
            "bench.log": ("RUNSTAMP-" + token + "\nfailed before service launch\n").encode(),
            "cloudbench-driver.state": b"exited\n",
            f"cloudbench-driver-clean-{token}.ack": (token + "\n").encode(),
            f"cloudbench-shutdown-{token}.request": b"",
        }
        absent = sorted(retirement.runpy.run_path(str(ROOT / "scripts/cloudbench-prestack-recovery.py"))["MISSING_STACK"])
        self.row = dict(task=bootstrap_test.BENCH, machine_id=bootstrap_test.MACHINE,
                        volume_id=bootstrap_test.VOLUME, run_token=token, ordinal=0,
                        services_status=None, runtime_evidence_complete=False,
                        proof_credit=0, missing=absent)
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w:gz") as output:
            for name, data in self.originals.items():
                member = tarfile.TarInfo(name)
                member.size = len(data)
                output.addfile(member, io.BytesIO(data))
        raw = archive.getvalue()
        config = json.dumps(fixture.config).encode()
        capture = dict(machine_id=bootstrap_test.MACHINE, source_machine_id=bootstrap_test.MACHINE,
                       source_volume_id=bootstrap_test.VOLUME, run_token=token, proof_credit=0,
                       missing=absent, archive_bytes=len(raw), archive_sha256=hashlib.sha256(raw).hexdigest(),
                       files={name: dict(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
                              for name, data in self.originals.items()})
        receipt = dict(machine_id=bootstrap_test.MACHINE, volume_id=bootstrap_test.VOLUME,
                       owner=bootstrap_test.OWNER, proof_credit=0, capture_complete=True,
                       restored_original_config=True, original_config_sha256=hashlib.sha256(config).hexdigest(),
                       archive_bytes=len(raw), archive_sha256=hashlib.sha256(raw).hexdigest())
        self.originals.update({"original-volume-capture.tar.gz": raw,
                               "original-native-config.json": config,
                               "original-capture-manifest.json": json.dumps(capture).encode(),
                               "original-capture-receipt.json": json.dumps(receipt).encode()})
        # Archive tests provide their own reviewed fixture recipe, without
        # adding the current checkout to the production approval registry.
        helper = ROOT / "scripts/cloudbench-prestack-recovery.py"
        run_path = retirement.runpy.run_path
        source = run_path(str(helper))
        _, _, fingerprint = source["native_recipe"](self.meta, json.loads(config))
        self.reviewed_sources = {fingerprint: ["before-stack-launch"]}
        source["trusted_source_review_policy"] = lambda: self.reviewed_sources

        def fixture_source(path, *args, **kwargs):
            if Path(path).resolve() == helper:
                return source
            return run_path(path, *args, **kwargs)

        policy = patch.object(retirement.runpy, "run_path", side_effect=fixture_source)
        policy.start()
        self.addCleanup(policy.stop)

    def verify(self):
        retirement.verify_pre_service_archive(self.meta, self.row, self.originals)

    def test_original_ack_and_absence_admit_source_bound_pre_service_endpoint(self):
        self.verify()

    def test_foreign_ack_and_service_bytes_cannot_claim_pre_service(self):
        token = bootstrap_test.TOKEN
        self.originals[f"cloudbench-driver-clean-{token}.ack"] = b"foreign\n"
        with self.assertRaises(AssertionError):
            self.verify()
        self.originals[f"cloudbench-driver-clean-{token}.ack"] = (token + "\n").encode()
        self.originals["repo/.context/cloudbench/services.json"] = b"{}"
        with self.assertRaises(AssertionError):
            self.verify()

    def test_missing_absence_and_changed_native_source_are_rejected(self):
        self.row["missing"].remove("repo/.context/cloudbench/logs/backend.log")
        with self.assertRaises(AssertionError):
            self.verify()
        self.row["missing"].append("repo/.context/cloudbench/logs/backend.log")
        config = json.loads(self.originals["original-native-config.json"])
        config["env"]["CLOUDBENCH_RUN_TOKEN"] = "foreign"
        self.originals["original-native-config.json"] = json.dumps(config).encode()
        with self.assertRaises(AssertionError):
            self.verify()

    def generic(self, native_worker=False, missing_worker_log=False, preserved_note=False,
                multichunk_original=False):
        f = self.fixture
        owner, machine, volume, clone = (bootstrap_test.OWNER, bootstrap_test.MACHINE,
                                         bootstrap_test.VOLUME, bootstrap_test.CLONE)
        meta = (f.registry / "meta").read_text().replace("cleanup_policy=retain", "cleanup_policy=reap")
        (f.registry / "meta").write_text(meta)
        (f.registry / "guest-cleanup-unconfirmed").unlink()
        (f.registry / "runtime-evidence-unconfirmed").touch()
        (f.out / "runtime-evidence.owner.json").write_text(json.dumps(
            dict(version=1, machine_id=machine, run_token=bootstrap_test.TOKEN)))
        (f.out / "runtime-evidence.pending").write_bytes((f.out / "runtime-evidence.owner.json").read_bytes())
        (f.out / "guest-shutdown.confirmed").write_text(bootstrap_test.RUN + "\n")
        bootstrap_test.pairs(f.audit / "fresh" / clone,
                             dict(version=1, fleet_owner_token=owner, run_id=bootstrap_test.RUN,
                                  app=bootstrap_test.APP, clone_name=clone, source="fresh-clone",
                                  source_machine_id="c" * 14, machine_id=machine, volume_id=volume,
                                  disposition="owned"))
        bootstrap_test.pairs(f.audit / "expected-fresh" / clone,
                             dict(clone_name=clone, source_machine_id="c" * 14))
        worker = "1234abcd"
        worker_clone, worker_volume = "cloudbench-worker", "vol_worker123"
        bootstrap_test.pairs(f.audit / "fresh" / worker_clone,
                             dict(version=1, fleet_owner_token=owner, run_id=bootstrap_test.RUN,
                                  app=bootstrap_test.APP, clone_name=worker_clone, source="fresh-clone",
                                  source_machine_id=machine, machine_id=worker, volume_id=worker_volume,
                                  disposition="destroyed-provider-retained"))
        bootstrap_test.pairs(f.audit / "expected-fresh" / worker_clone,
                             dict(clone_name=worker_clone, source_machine_id=machine))
        bootstrap_test.write(f.audit / "by-machine-id" / worker, worker_clone + "\n")
        base = f.out / "worker-runtime-evidence" / worker
        base.mkdir(parents=True)
        (base / "owner.json").write_text(json.dumps(dict(version=1, machine_id=worker,
            primary_machine_id=machine, run_token=bootstrap_test.TOKEN)))
        helper, data, agents, state, expected = worker_test.make_bundle(f.base)
        expected["run_token"] = bootstrap_test.TOKEN
        for filename in ("owner.json", "terminal.json"):
            value = json.loads((state / filename).read_text())
            value.update(expected)
            if filename == "terminal.json":
                value["exit_code"] = 1
                value["worker_started"] = False
            (state / filename).write_text(json.dumps(value))
        args = argparse.Namespace(run_token=bootstrap_test.TOKEN, machine_id=worker,
                                  data_dir=str(data), output=str(f.base / "worker.tar"))
        with patch.dict(os.environ, {"FLY_MACHINE_ID": worker}):
            helper.capture(args)
        helper.check_archive(f.base / "worker.tar", expected, base / "capture")
        worker_files = {str(path.relative_to(base)): path.read_bytes()
                        for path in base.rglob("*") if path.is_file()}
        if missing_worker_log:
            worker_files.pop("capture/logs/worker.log")
        worker_row = dict(task=bootstrap_test.BENCH, machine_id=worker,
                          primary_machine_id=machine, volume_id=worker_volume,
                          run_token=bootstrap_test.TOKEN, proof_credit=0,
                          files={name: dict(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
                                 for name, data in worker_files.items()})
        f.machines.write_text(json.dumps([dict(id=worker)] if native_worker else []))
        f.volumes.write_text("[]")
        if multichunk_original:
            self.originals["phase-diagnostic.log"] = b"original-diagnostic\n" * 16384
        payloads = {bootstrap_test.BENCH + "/" + name: data for name, data in self.originals.items()}
        payloads.update({"_normal_workers/" + worker + "/" + name: data
                         for name, data in worker_files.items()})
        if preserved_note:
            payloads["_note.json"] = b'{"original":true}\n'
        self.row["files"] = {name: dict(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
                             for name, data in self.originals.items()}
        destination = f.run / "_forensic"
        destination.mkdir()
        archive = destination / "originals.tar.gz"
        with tarfile.open(archive, "w:gz") as output:
            for name, data in payloads.items():
                member = tarfile.TarInfo(name)
                member.size = len(data)
                output.addfile(member, io.BytesIO(data))
        manifest = dict(schema="cloudbench-forensic-retirement-v1", owner=owner,
                        run_id=bootstrap_test.RUN, proof_credit=0, tasks=[self.row],
                        normal_workers=[worker_row], uncompressed_bytes=sum(map(len, payloads.values())),
                        archive_bytes=archive.stat().st_size,
                        archive_sha256=hashlib.sha256(archive.read_bytes()).hexdigest())
        if preserved_note:
            data = payloads["_note.json"]
            manifest["preserved_files"] = {"_note.json": dict(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())}
        manifest_path = destination / "manifest.json"
        manifest_path.write_text(json.dumps(manifest))
        return retirement.verify(f.registry, f.run, manifest_path, archive, f.machines, f.volumes,
                                 archive_only=True)

    def test_generic_archive_retains_honest_failed_worker_and_full_ledger(self):
        result = self.generic()
        self.assertEqual(result["normal_worker_captures"], 1)
        self.assertEqual(result["proof_credit"], 0)
        self.assertFalse(result["native_release_verified"])

    def test_generic_archive_accepts_valid_single_segment_preserved_metadata(self):
        result = self.generic(preserved_note=True)
        self.assertEqual(result["proof_credit"], 0)
        self.assertFalse(result["native_release_verified"])

    def test_generic_archive_preserves_multichunk_phase_original_bytes(self):
        original_verifier = retirement.verify_pre_service_archive

        def verify_received_originals(meta, row, originals):
            self.assertEqual(originals["phase-diagnostic.log"],
                             self.originals["phase-diagnostic.log"])
            return original_verifier(meta, row, originals)

        with patch.object(retirement, "verify_pre_service_archive",
                          side_effect=verify_received_originals) as verifier:
            result = self.generic(multichunk_original=True)
        verifier.assert_called_once()
        self.assertEqual(result["normal_worker_captures"], 1)
        self.assertEqual(result["proof_credit"], 0)
        self.assertFalse(result["native_release_verified"])

    def test_generic_archive_rejects_missing_original_worker_log(self):
        with self.assertRaises(AssertionError):
            self.generic(missing_worker_log=True)

    def test_generic_archive_rejects_retired_worker_still_in_native_inventory(self):
        with self.assertRaises(AssertionError):
            self.generic(native_worker=True)


class SealedMachineRecoveryTest(unittest.TestCase):
    def test_completed_member_retires_independently_with_full_failed_owner_retained(self):
        self.assertEqual(sealed_machine_test.run_recurrence()["status"], "PASS")


if __name__ == "__main__":
    unittest.main()
