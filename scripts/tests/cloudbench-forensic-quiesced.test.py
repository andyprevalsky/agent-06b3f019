"""A canceled composite run may retire only from exact quiesced receipts."""

import hashlib
import copy
import shutil
import subprocess
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


    def capture_fixture(self):
        capture = load("capture_append", ROOT / "scripts/cloudbench-original-volume-capture.py")
        state = {
            "schema_version": "cloudbench-guest-state-v1", "version": 1,
            "machine_id": self.args.machine_id, "guest_run_token": self.args.guest_run_token,
            "state": "active", "driver_state": "running", "driver_pid": 123,
            "driver_token_match": True,
            "backend_log": {"exists": True, "regular": True, "symlink": False,
                            "within_limit": True, "bytes": len(self.backend)},
            "services_manifest": {"exists": True, "bytes": 2},
            "run_json": {"exists": True, "bytes": 2},
        }
        (self.out / "guest-cleanup.state.json").write_text(json.dumps(state))
        ident = {"owner": self.args.owner, "run_id": self.args.fleet_run_id,
                 "bench": self.args.bench, "machine_id": self.args.machine_id,
                 "token": self.args.guest_run_token}
        originals = {"repo/.context/cloudbench/services.json": b"{}",
                     "repo/.context/cloudbench/run.json": b"{}",
                     "repo/.context/cloudbench/logs/backend.log": self.backend}
        return capture, state, ident, originals

    def test_capture_cross_check_admits_bound_stopped_backend_append(self):
        capture, state, ident, originals = self.capture_fixture()
        tail = b"[Server] SIGTERM received, closing server...\n"
        originals["repo/.context/cloudbench/logs/backend.log"] += tail
        before = {path.name: path.read_bytes() for path in self.out.iterdir() if path.is_file()}
        checks = capture.cross_check_receipts(self.out, ident, originals)
        self.assertEqual(before, {path.name: path.read_bytes() for path in self.out.iterdir() if path.is_file()})
        proof = checks["backend_log_append"]
        self.assertEqual(proof["prior_sha256"], hashlib.sha256(self.backend).hexdigest())
        self.assertEqual(proof["captured_sha256"], hashlib.sha256(self.backend + tail).hexdigest())
        self.assertEqual(proof["appended_sha256"], hashlib.sha256(tail).hexdigest())
        self.assertEqual(proof["appended_bytes"], len(tail))
        self.assertEqual(proof["kind"], "stopped-provider-backend-extension")
        for name in ("guest-cleanup.state.json", "guest-cleanup.provider-manifest.json"):
            self.assertEqual(checks[name], hashlib.sha256((self.out/name).read_bytes()).hexdigest())

    def test_capture_cross_check_keeps_exact_nonappend_contract(self):
        capture, state, ident, originals = self.capture_fixture()
        self.assertNotIn("backend_log_append", capture.cross_check_receipts(self.out, ident, originals))
        for name in ("repo/.context/cloudbench/run.json", "repo/.context/cloudbench/services.json"):
            changed = dict(originals, **{name: b"{}\n"})
            with self.subTest(name=name), self.assertRaises(capture.CaptureFailure):
                capture.cross_check_receipts(self.out, ident, changed)

    def test_capture_backend_append_rejects_rewrite_growth_and_new_ownership(self):
        capture, state, ident, originals = self.capture_fixture()
        for tail in (
            b"Created Kernel browser session sessionId=kernel_late123\n",
            b"model=BrowserSession operation=update\n",
            b"[HTTP] POST /api/agents -> 201\n",
            b"model=AgentPayment operation=create\n",
            b"invalid-utf8-\xff\n", b"incomplete-line",
            b"x" * (1024 * 1024) + b"\n",
        ):
            with self.subTest(tail=tail[:50]), self.assertRaises(capture.CaptureFailure):
                capture.cross_check_receipts(self.out, ident, dict(originals, **{
                    "repo/.context/cloudbench/logs/backend.log": self.backend + tail}))
        for changed in (self.backend[:-1], b"rewrite" + self.backend[7:], b"rewrite\n" + self.backend):
            with self.subTest(change=changed[:20]), self.assertRaises(capture.CaptureFailure):
                capture.cross_check_receipts(self.out, ident, dict(originals, **{
                    "repo/.context/cloudbench/logs/backend.log": changed}))

    def test_capture_backend_append_requires_original_body_and_stopped_receipts(self):
        capture, state, ident, originals = self.capture_fixture()
        originals["repo/.context/cloudbench/logs/backend.log"] += b"[Server] SIGTERM received, closing server...\n"
        saved = {path: path.read_bytes() for path in self.out.iterdir() if path.is_file()}
        for name in ("guest-cleanup.backend.log", "guest-cleanup.machine-stopped.json",
                     "guest-cleanup.machine-status.txt", "guest-cleanup.recovery-receipt.json",
                     "guest-cleanup.provider-manifest.json"):
            path = self.out/name
            with self.subTest(missing=name):
                path.unlink()
                with self.assertRaises(capture.CaptureFailure):
                    capture.cross_check_receipts(self.out, ident, originals)
                path.write_bytes(saved[path])
        for field, value in (("version", True), ("state", "exited"), ("driver_state", "exited"),
                             ("driver_token_match", False), ("driver_pid", None),
                             ("machine_id", "c"*14), ("guest_run_token", "other-token")):
            with self.subTest(field=field):
                (self.out/"guest-cleanup.state.json").write_text(json.dumps(dict(state, **{field: value})))
                with self.assertRaises(capture.CaptureFailure):
                    capture.cross_check_receipts(self.out, ident, originals)
        (self.out/"guest-cleanup.state.json").write_text(json.dumps(state))
        old_body = self.out/"guest-cleanup.backend.log"
        old_body.write_bytes(b"X" + self.backend[1:])
        with self.assertRaises(capture.CaptureFailure):
            capture.cross_check_receipts(self.out, ident, originals)
        old_body.write_bytes(saved[old_body])
        for name, field, value in (("guest-cleanup.provider-manifest.json", "version", True),
                                   ("guest-cleanup.provider-manifest.json", "kind", "provider-exact-manifest"),
                                   ("guest-cleanup.provider-manifest.json", "fleet_owner_token", "c"*32),
                                   ("guest-cleanup.provider-manifest.json", "root_agent_id", "d"*32),
                                   ("guest-cleanup.machine-stopped.json", "machine_id", "c"*14),
                                   ("guest-cleanup.recovery-receipt.json", "results", [])):
            path=self.out/name
            row=json.loads(saved[path])
            row[field]=value
            path.write_text(json.dumps(row))
            with self.subTest(changed=name), self.assertRaises(capture.CaptureFailure):
                capture.cross_check_receipts(self.out, ident, originals)
            path.write_bytes(saved[path])


    def test_capture_publishes_append_proof_without_changing_old_receipts(self):
        capture, state, ident, originals = self.capture_fixture()
        originals["repo/.context/cloudbench/logs/backend.log"] += b"[Server] SIGTERM received, closing server...\n"
        originals["bench.log"] = ("RUNSTAMP-" + ident["token"] + "\n").encode()
        encoded = io.BytesIO()
        with tarfile.open(fileobj=encoded, mode="w:gz") as archive:
            for name, data in originals.items():
                member = tarfile.TarInfo(name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        payload = encoded.getvalue()
        directory = self.out/"capture"
        directory.mkdir(mode=0o700)
        downloaded = directory/"download.unverified"
        downloaded.write_bytes(payload)
        inventory = {"version": 1, "run_token": ident["token"], "archive_bytes": len(payload),
                     "archive_sha256": hashlib.sha256(payload).hexdigest(), "missing": [],
                     "files": {name: {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                               for name, data in originals.items()}}
        config = {"init": {"cmd": ["bash", "/cloudbench-boot.sh"]}}
        initial = {"id": ident["machine_id"], "state": "stopped", "instance_id": "instance", "config": copy.deepcopy(config)}
        calls = []
        class NativeFixture:
            current = copy.deepcopy(initial)
            def machine(self, machine_id):
                self_outer.assertEqual(machine_id, ident["machine_id"])
                return copy.deepcopy(self.current)
            def volume(self, volume_id):
                return {"id": volume_id, "state": "created", "attached_machine_id": ident["machine_id"]}
            def api(self, method, path, body=None):
                self_outer.assertEqual(method, "POST")
                calls.append(path)
                if path.endswith("/start"):
                    self.current["state"] = "started"
                elif path.endswith("/stop"):
                    self.current["state"] = "stopped"
                else:
                    self.current["config"] = copy.deepcopy(body["config"])
        self_outer = self
        ident.update(volume_id="vol_fixture", kind="clone", clone_name=self.args.clone_name, app="fixture-app", ordinal=0, out=self.out)
        artifacts = {name: directory/(ident["machine_id"]+"."+name) for name in (
            "tar.gz", "provenance.json", "original-config.private.json", "capture-failure.json")}
        before = {path.name: path.read_bytes() for path in self.out.iterdir() if path.is_file()}
        with patch.dict(capture.mutate_and_capture.__globals__, {
            "guest_capture": lambda *args: (downloaded, inventory),
        }):
            result = capture.mutate_and_capture(NativeFixture(), ident,
                argparse.Namespace(wait_seconds=5, attempts=1, ssh_seconds=5), directory, artifacts, initial, config)
        self.assertEqual(result, 0)
        proof = json.loads(artifacts["provenance.json"].read_bytes())
        append = proof["receipt_cross_checks"]["backend_log_append"]
        self.assertEqual(append["captured_sha256"], inventory["files"]["repo/.context/cloudbench/logs/backend.log"]["sha256"])
        self.assertEqual(proof["proof_credit"], 0)
        self.assertIs(proof["native_release_verified"], False)
        self.assertEqual(calls, ["/machines/"+ident["machine_id"], "/machines/"+ident["machine_id"]+"/start",
                                 "/machines/"+ident["machine_id"]+"/stop", "/machines/"+ident["machine_id"]])
        self.assertEqual(before, {path.name: path.read_bytes() for path in self.out.iterdir() if path.is_file()})


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
                multichunk_original=False, published_run_bytes=0):
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
        if published_run_bytes:
            # The normal collector published the canonical result and cleared
            # pending; the guest sealed run.json up to the producer's bound.
            (f.out / "runtime-evidence.pending").unlink()
            record = json.dumps({"pad": "x" * published_run_bytes}).encode()
            (f.out / "cloudbench-run.json").write_bytes(record)
            bootstrap_test.write(f.out / "remote-logs/runtime-evidence/run.json", record)
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

    def native_builder_fixture(self):
        # Start with the existing full consumer fixture, including real worker
        # capture and source recipe. Replace only its hand-built outer packet.
        self.generic()
        f = self.fixture
        shutil.rmtree(f.run / "_forensic")
        f.captures.mkdir(exist_ok=True)
        machine = bootstrap_test.MACHINE
        raw = self.originals["original-volume-capture.tar.gz"]
        config = self.originals["original-native-config.json"] + b"\n"
        legacy = json.loads(self.originals["original-capture-manifest.json"])
        proof = dict(
            schema="cloudbench-original-volume-capture-v1", version=1,
            kind="original-volume-inert-capture", direct_original_volume=True,
            proof_credit=0, native_release_verified=False,
            fleet_owner_token=bootstrap_test.OWNER, run_id=bootstrap_test.RUN,
            app=bootstrap_test.APP, bench=bootstrap_test.BENCH, ordinal=0,
            allocation_kind="clone", guest_run_token=bootstrap_test.TOKEN,
            machine_id=machine, source_machine_id=machine,
            volume_id=bootstrap_test.VOLUME, source_volume_id=bootstrap_test.VOLUME,
            archive_name=machine + ".tar.gz", archive_bytes=len(raw),
            archive_sha256=hashlib.sha256(raw).hexdigest(),
            files=legacy["files"], missing=legacy["missing"],
            native_original_config_sha256=hashlib.sha256(json.dumps(
                json.loads(config), sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
            native_final_state="stopped", native_final_volume_state="created",
            inert_command=["sleep", "infinity"], guest_inert_sleepers=1,
            provider_mutations=["config-inert", "start", "stop", "config-restore"],
        )
        for suffix, data in (("tar.gz", raw), ("original-config.private.json", config),
                             ("provenance.json", json.dumps(proof).encode())):
            (f.captures / (machine + "." + suffix)).write_bytes(data)
        (f.run / "execution-task-matrix.json").write_text("{}")
        return proof

    def build_native(self):
        f = self.fixture
        return subprocess.run([
            sys.executable, str(ROOT / "scripts/cloudbench-build-interrupted-pool-archive.py"),
            "--registry", str(f.registry), "--capture-dir", str(f.captures),
        ], capture_output=True, text=True)

    def verify_built_native(self):
        f = self.fixture
        packet = f.run / "_forensic"
        return retirement.verify(f.registry, f.run, packet / "manifest.json",
                                 packet / "originals.tar.gz", f.machines, f.volumes,
                                 archive_only=True)

    def test_native_capture_builder_roundtrip_uses_real_verifier(self):
        proof = self.native_builder_fixture()
        result = self.build_native()
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.verify_built_native()
        self.assertEqual(result["proof_credit"], 0)
        self.assertFalse(result["native_release_verified"])
        packet = self.fixture.run / "_forensic"
        row = json.loads((packet / "manifest.json").read_bytes())["tasks"][0]
        self.assertEqual(row["missing"], proof["missing"])
        with tarfile.open(packet / "originals.tar.gz") as archive:
            for name, suffix in (("original-capture-provenance.json", "provenance.json"),
                                 ("original-native-config.json", "original-config.private.json"),
                                 ("original-volume-capture.tar.gz", "tar.gz")):
                self.assertEqual(archive.extractfile(bootstrap_test.BENCH + "/" + name).read(),
                                 (self.fixture.captures / (bootstrap_test.MACHINE + "." + suffix)).read_bytes())

    def test_native_builder_refuses_missing_symlinked_or_mismatched_sidecars(self):
        proof = self.native_builder_fixture()
        f = self.fixture
        config = f.captures / (bootstrap_test.MACHINE + ".original-config.private.json")
        provenance = f.captures / (bootstrap_test.MACHINE + ".provenance.json")
        original_config = config.read_bytes()
        for fault in ("missing-config", "symlink-config", "foreign-owner", "wrong-hash", "wrong-files"):
            with self.subTest(fault=fault):
                changed = copy.deepcopy(proof)
                if fault == "missing-config":
                    config.unlink()
                elif fault == "symlink-config":
                    config.unlink()
                    target = f.captures / "config-target"
                    target.write_bytes(original_config)
                    config.symlink_to(target)
                elif fault == "foreign-owner":
                    changed["fleet_owner_token"] = "f" * 32
                elif fault == "wrong-hash":
                    changed["archive_sha256"] = "0" * 64
                else:
                    changed["files"]["bench.log"]["sha256"] = "0" * 64
                provenance.write_text(json.dumps(changed))
                result = self.build_native()
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((f.run / "_forensic/manifest.json").exists())
                shutil.rmtree(f.run / "_forensic")
                config.unlink(missing_ok=True)
                config.write_bytes(original_config)

    def test_native_consumer_rejects_tampering_even_with_rehashed_outer_packet(self):
        self.native_builder_fixture()
        result = self.build_native()
        self.assertEqual(result.returncode, 0, result.stderr)
        f = self.fixture
        packet = f.run / "_forensic"
        manifest = json.loads((packet / "manifest.json").read_bytes())
        with tarfile.open(packet / "originals.tar.gz") as archive:
            original = {member.name: archive.extractfile(member).read() for member in archive}
        prefix = bootstrap_test.BENCH + "/"
        for field, value in (
            ("fleet_owner_token", "f" * 32), ("run_id", "foreign"),
            ("app", "foreign"), ("bench", "foreign"), ("ordinal", 1),
            ("machine_id", "c" * 14), ("source_machine_id", "c" * 14),
            ("source_volume_id", "vol_foreign"), ("volume_id", "vol_foreign"),
            ("guest_run_token", "foreign"), ("proof_credit", 1),
            ("native_release_verified", True), ("native_final_state", "started"),
            ("native_final_volume_state", "destroyed"), ("provider_mutations", ["config-inert", "start"]),
            ("native_original_config_sha256", "0" * 64), ("archive_sha256", "0" * 64),
            ("missing", []), ("files", {}), ("changed-config", None),
            ("changed-raw", None), ("mixed-wrappers", None),
        ):
            with self.subTest(field=field):
                payloads = dict(original)
                proof = json.loads(payloads[prefix + "original-capture-provenance.json"])
                if field == "changed-config":
                    config = json.loads(payloads[prefix + "original-native-config.json"])
                    config["env"]["CLOUDBENCH_RUN_TOKEN"] = "foreign"
                    payloads[prefix + "original-native-config.json"] = json.dumps(config).encode()
                    proof["native_original_config_sha256"] = hashlib.sha256(json.dumps(
                        config, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
                elif field == "changed-raw":
                    payloads[prefix + "original-volume-capture.tar.gz"] += b"changed"
                elif field == "mixed-wrappers":
                    payloads[prefix + "original-capture-receipt.json"] = b"{}"
                else:
                    proof[field] = value
                payloads[prefix + "original-capture-provenance.json"] = json.dumps(proof).encode()
                changed = copy.deepcopy(manifest)
                for member, data in payloads.items():
                    if member.startswith(prefix):
                        changed["tasks"][0]["files"][member[len(prefix):]] = dict(
                            bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
                changed["uncompressed_bytes"] = sum(map(len, payloads.values()))
                with tarfile.open(packet / "originals.tar.gz", "w:gz") as archive:
                    for name, data in payloads.items():
                        member = tarfile.TarInfo(name)
                        member.size = len(data)
                        archive.addfile(member, io.BytesIO(data))
                raw = (packet / "originals.tar.gz").read_bytes()
                changed.update(archive_bytes=len(raw), archive_sha256=hashlib.sha256(raw).hexdigest())
                (packet / "manifest.json").write_text(json.dumps(changed))
                with self.assertRaises((AssertionError, KeyError, ValueError)):
                    self.verify_built_native()

    UNLAUNCHED = "5678abcd"

    def add_unlaunched_worker(self):
        """An owned autoscaler clone allocated inert whose wrapper never launched.

        Mirrors the production shape (c0961355 polar-bu-083 / 86551e4c762738):
        owner.json plus the fleet's sealed not-launched.json, and no capture.
        """
        f = self.fixture
        worker, clone, volume = self.UNLAUNCHED, "cloudbench-unlaunched", "vol_unlaunched1"
        bootstrap_test.pairs(f.audit / "fresh" / clone,
                             dict(version=1, fleet_owner_token=bootstrap_test.OWNER, run_id=bootstrap_test.RUN,
                                  app=bootstrap_test.APP, clone_name=clone, source="fresh-clone",
                                  source_machine_id=bootstrap_test.MACHINE, machine_id=worker,
                                  volume_id=volume, disposition="owned"))
        bootstrap_test.pairs(f.audit / "expected-fresh" / clone,
                             dict(clone_name=clone, source_machine_id=bootstrap_test.MACHINE))
        bootstrap_test.write(f.audit / "by-machine-id" / worker, clone + "\n")
        bootstrap_test.pairs(f.registry / "clones" / clone, dict(name=clone, id=worker, volume_id=volume))
        f.volumes.write_text(json.dumps([dict(id=volume, state="created")]))
        stage = (b"allocated inert worker clone; wrapper not launched\n"
                 b"[t] attempt 1/40: start neutralized worker succeeded\n"
                 b"[t] attempt 1/40: upload cloudbench-worker.sh\n")
        (f.out / f"worker-{worker}.stage.log").write_bytes(stage)
        (f.out / f"worker-{worker}.pending").write_bytes(b"")
        base = f.out / "worker-runtime-evidence" / worker
        base.mkdir(parents=True)
        owner = dict(version=1, machine_id=worker, primary_machine_id=bootstrap_test.MACHINE,
                     run_token=bootstrap_test.TOKEN, workspace="flt-fixture-0")
        (base / "owner.json").write_text(json.dumps(owner))
        receipt = dict(owner, worker_started=False, stage_sha256=hashlib.sha256(stage).hexdigest())
        (base / "not-launched.json").write_text(json.dumps(receipt, sort_keys=True))
        return base, stage

    def test_native_builder_archives_sealed_not_launched_worker(self):
        self.native_builder_fixture()
        base, stage = self.add_unlaunched_worker()
        result = self.build_native()
        self.assertEqual(result.returncode, 0, result.stderr)
        verified = self.verify_built_native()
        self.assertEqual(verified["normal_worker_captures"], 2)
        self.assertEqual(verified["proof_credit"], 0)
        packet = self.fixture.run / "_forensic"
        manifest = json.loads((packet / "manifest.json").read_bytes())
        row = next(row for row in manifest["normal_workers"] if row["machine_id"] == self.UNLAUNCHED)
        self.assertEqual(row["kind"], "not-launched")
        self.assertEqual(set(row["files"]), {"owner.json", "not-launched.json", "stage.log"})
        prefix = f"_normal_workers/{self.UNLAUNCHED}/"
        with tarfile.open(packet / "originals.tar.gz") as archive:
            self.assertEqual(archive.extractfile(prefix + "stage.log").read(), stage)
            self.assertEqual(archive.extractfile(prefix + "not-launched.json").read(),
                             (base / "not-launched.json").read_bytes())

    def test_not_launched_worker_requires_exact_original_receipt(self):
        reasons = {
            "started": "does not bind", "stage-changed": "does not bind",
            "launch-attempted": "launch-attempted", "ready": "was reported ready",
            "wrapper-launched": "wrapper launched", "foreign-primary": "does not bind",
            "partial-capture": "has other evidence",
            # Without the sealed receipt the worker must have a capture.
            "missing-receipt": "capture",
        }
        self.native_builder_fixture()
        base, stage = self.add_unlaunched_worker()
        f = self.fixture
        stage_path = f.out / f"worker-{self.UNLAUNCHED}.stage.log"
        original_receipt = (base / "not-launched.json").read_bytes()
        for fault in reasons:
            with self.subTest(fault=fault):
                receipt = json.loads(original_receipt)
                if fault == "started":
                    receipt["worker_started"] = True
                elif fault == "stage-changed":
                    stage_path.write_bytes(stage + b"later bytes\n")
                elif fault == "launch-attempted":
                    (f.out / f"worker-{self.UNLAUNCHED}.launch-attempted").touch()
                elif fault == "ready":
                    (f.out / "worker-ready.ids").write_text(self.UNLAUNCHED + "\n")
                elif fault == "wrapper-launched":
                    stage_path.write_bytes(stage + b"launch worker wrapper succeeded\n")
                    receipt["stage_sha256"] = hashlib.sha256(stage_path.read_bytes()).hexdigest()
                elif fault == "foreign-primary":
                    receipt["primary_machine_id"] = "c" * 14
                elif fault == "partial-capture":
                    (base / "capture").mkdir()
                if fault == "missing-receipt":
                    (base / "not-launched.json").unlink()
                else:
                    (base / "not-launched.json").write_text(json.dumps(receipt, sort_keys=True))
                result = self.build_native()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(reasons[fault], result.stderr)
                self.assertFalse((f.run / "_forensic/manifest.json").exists())
                # Restore the exact original worker state for the next fault.
                shutil.rmtree(f.run / "_forensic", ignore_errors=True)
                (base / "not-launched.json").write_bytes(original_receipt)
                stage_path.write_bytes(stage)
                (f.out / f"worker-{self.UNLAUNCHED}.launch-attempted").unlink(missing_ok=True)
                (f.out / "worker-ready.ids").unlink(missing_ok=True)
                if (base / "capture").is_dir():
                    (base / "capture").rmdir()
        # The restored original state still builds and verifies.
        self.assertEqual(self.build_native().returncode, 0)
        self.assertEqual(self.verify_built_native()["normal_worker_captures"], 2)

    def test_consumer_rechecks_not_launched_worker_after_build(self):
        self.native_builder_fixture()
        self.add_unlaunched_worker()
        self.assertEqual(self.build_native().returncode, 0)
        f = self.fixture
        (f.out / f"worker-{self.UNLAUNCHED}.launch-attempted").touch()
        with self.assertRaises(AssertionError):
            self.verify_built_native()

    def reset_fixture(self):
        """Start each fault from a fresh fixture; earlier faults never leak."""
        self.doCleanups()
        self.setUp()

    def test_native_consumer_keeps_reviewed_source_policy_mandatory(self):
        self.native_builder_fixture()
        result = self.build_native()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.reviewed_sources.clear()
        with self.assertRaises(AssertionError):
            self.verify_built_native()

    def rebuild_native(self, manifest_sha=None, archive_sha=None):
        f = self.fixture
        packet = f.run / "_forensic"
        return subprocess.run([
            sys.executable, str(ROOT / "scripts/cloudbench-build-interrupted-pool-archive.py"),
            "--registry", str(f.registry), "--capture-dir", str(f.captures),
            "--rebuild-existing",
            "--expected-manifest-sha256", manifest_sha or hashlib.sha256((packet / "manifest.json").read_bytes()).hexdigest(),
            "--expected-archive-sha256", archive_sha or hashlib.sha256((packet / "originals.tar.gz").read_bytes()).hexdigest(),
        ], capture_output=True, text=True)

    def test_hash_bound_rebuild_preserves_previous_packet_and_real_verifier(self):
        self.native_builder_fixture()
        self.assertEqual(self.build_native().returncode, 0)
        f = self.fixture
        packet = f.run / "_forensic"
        before = {path.name: path.read_bytes() for path in packet.iterdir()}
        registry_before = {str(path.relative_to(f.registry)): path.read_bytes()
                           for path in f.registry.rglob("*") if path.is_file()}
        result = self.rebuild_native()
        self.assertEqual(result.returncode, 0, result.stderr)
        rejected = f.run / ("_forensic.rejected-" + hashlib.sha256(before["manifest.json"]).hexdigest())
        self.assertEqual({path.name: path.read_bytes() for path in rejected.iterdir()}, before)
        self.assertEqual({str(path.relative_to(f.registry)): path.read_bytes()
                          for path in f.registry.rglob("*") if path.is_file()}, registry_before)
        result = self.verify_built_native()
        self.assertEqual(result["proof_credit"], 0)
        self.assertFalse(result["native_release_verified"])

    def test_hash_bound_rebuild_refuses_wrong_digest_or_failed_capture_without_replacing(self):
        self.native_builder_fixture()
        self.assertEqual(self.build_native().returncode, 0)
        f = self.fixture
        packet = f.run / "_forensic"
        before = {path.name: path.read_bytes() for path in packet.iterdir()}
        for kind in ("manifest", "archive", "failed-capture", "existing-destination", "unexpected-member"):
            with self.subTest(kind=kind):
                config = f.captures / (bootstrap_test.MACHINE + ".original-config.private.json")
                config_bytes = config.read_bytes()
                rejected = f.run / ("_forensic.rejected-" + hashlib.sha256(before["manifest.json"]).hexdigest())
                if kind == "failed-capture":
                    config.unlink()
                elif kind == "existing-destination":
                    rejected.mkdir()
                    (rejected / "do-not-overwrite").write_bytes(b"preserve")
                elif kind == "unexpected-member":
                    (packet / "unknown").write_bytes(b"preserve")
                result = self.rebuild_native(manifest_sha="0" * 64 if kind == "manifest" else None,
                                             archive_sha="0" * 64 if kind == "archive" else None)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual({name: (packet / name).read_bytes() for name in before}, before)
                self.assertTrue((f.registry / "runtime-evidence-unconfirmed").is_file())
                if kind == "failed-capture":
                    config.write_bytes(config_bytes)
                elif kind == "existing-destination":
                    self.assertEqual((rejected / "do-not-overwrite").read_bytes(), b"preserve")
                    shutil.rmtree(rejected)
                elif kind == "unexpected-member":
                    self.assertEqual((packet / "unknown").read_bytes(), b"preserve")
                    (packet / "unknown").unlink()

    def test_rebuild_refuses_held_recovery_guard(self):
        self.native_builder_fixture()
        self.assertEqual(self.build_native().returncode, 0)
        helper = retirement.runpy.run_path(str(ROOT / "scripts/cloudbench-original-volume-capture.py"))
        lock = helper["RecoveryLock"](self.fixture.registry)
        lock.acquire()
        try:
            result = self.rebuild_native()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("guard is held", result.stderr)
        finally:
            lock.release()
        self.assertEqual(self.verify_built_native()["proof_credit"], 0)

    def test_rebuild_refuses_changed_old_packet_staging_or_parent_before_publish(self):
        self.native_builder_fixture()
        self.assertEqual(self.build_native().returncode, 0)
        f = self.fixture
        packet = f.run / "_forensic"
        before = {path.name: path.read_bytes() for path in packet.iterdir()}
        builder = load("rebuild_builder", ROOT / "scripts/cloudbench-build-interrupted-pool-archive.py")
        original_snapshot = builder.packet_snapshot
        for fault in ("old-packet", "stage-directory", "stage-payload", "parent-alias"):
            with self.subTest(fault=fault):
                calls = 0
                moved_parent = f.run.with_name(f.run.name + "-retained")
                def changed_snapshot(path, *args, **kwargs):
                    nonlocal calls
                    if path == packet:
                        calls += 1
                        if calls == 2 and fault == "old-packet":
                            (packet / "manifest.json").write_bytes(before["manifest.json"] + b" ")
                    result = original_snapshot(path, *args, **kwargs)
                    if path == packet and calls == 2:
                        stages = list(f.run.glob("_forensic.rebuild-*"))
                        stage = max(stages, key=lambda item: item.stat().st_mtime_ns)
                        if fault == "stage-directory":
                            retained = stage.with_name(stage.name + "-retained")
                            stage.rename(retained)
                            shutil.copytree(retained, stage)
                        elif fault == "stage-payload":
                            (stage / "manifest.json").write_bytes(b'{"substituted":true}\n')
                            (stage / "originals.tar.gz").write_bytes(b"substituted archive")
                        elif fault == "parent-alias":
                            f.run.rename(moved_parent)
                            f.run.symlink_to(moved_parent, target_is_directory=True)
                    return result
                argv = ["builder", "--registry", str(f.registry), "--capture-dir", str(f.captures),
                        "--rebuild-existing", "--expected-manifest-sha256", hashlib.sha256(before["manifest.json"]).hexdigest(),
                        "--expected-archive-sha256", hashlib.sha256(before["originals.tar.gz"]).hexdigest()]
                try:
                    with patch.object(builder, "packet_snapshot", side_effect=changed_snapshot), patch.object(sys, "argv", argv):
                        with self.assertRaises((AssertionError, OSError)):
                            builder.main()
                finally:
                    if f.run.is_symlink():
                        f.run.unlink()
                        moved_parent.rename(f.run)
                    (packet / "manifest.json").write_bytes(before["manifest.json"])
                self.assertEqual({path.name: path.read_bytes() for path in packet.iterdir()}, before)

    def test_rebuild_publication_rollback_never_overwrites_concurrent_canonical(self):
        builder = load("rebuild_publish", ROOT / "scripts/cloudbench-build-interrupted-pool-archive.py")
        helper = retirement.runpy.run_path(str(ROOT / "scripts/cloudbench-original-volume-capture.py"))
        for concurrent in (False, True):
            with self.subTest(concurrent=concurrent), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                canonical, rejected, stage = (root / name for name in ("canonical", "rejected", "stage"))
                canonical.mkdir(mode=0o700)
                stage.mkdir(mode=0o700)
                (canonical / "original").write_bytes(b"original")
                (stage / "replacement").write_bytes(b"replacement")
                calls = 0
                def failed_publish(source, target):
                    nonlocal calls
                    calls += 1
                    if calls == 2:
                        if concurrent:
                            canonical.mkdir(mode=0o700)
                            (canonical / "foreign").write_bytes(b"foreign")
                        raise OSError("injected final publication failure")
                    return helper["rename_noreplace"](source, target)
                with self.assertRaises(OSError):
                    builder.publish_rebuilt_packet(stage, canonical, rejected,
                        {**helper, "rename_noreplace": failed_publish})
                if concurrent:
                    self.assertEqual((canonical / "foreign").read_bytes(), b"foreign")
                    self.assertEqual((rejected / "original").read_bytes(), b"original")
                else:
                    self.assertEqual((canonical / "original").read_bytes(), b"original")
                    self.assertFalse(rejected.exists())
                self.assertEqual((stage / "replacement").read_bytes(), b"replacement")

    def test_rebuild_resumes_crash_after_preservation_through_same_cli(self):
        self.native_builder_fixture()
        self.assertEqual(self.build_native().returncode, 0)
        f = self.fixture
        packet = f.run / "_forensic"
        before = {path.name: path.read_bytes() for path in packet.iterdir()}
        md, ad = (hashlib.sha256(before[name]).hexdigest() for name in ("manifest.json", "originals.tar.gz"))
        rejected = f.run / ("_forensic.rejected-" + md)
        stage = f.run / "_forensic.crash-stage"
        stage.mkdir(mode=0o700)
        (stage / "partial").write_bytes(b"retained partial")
        code = f'''import importlib.util,os,runpy,signal
from pathlib import Path
spec=importlib.util.spec_from_file_location("builder",{str(ROOT / "scripts/cloudbench-build-interrupted-pool-archive.py")!r})
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
h=runpy.run_path({str(ROOT / "scripts/cloudbench-original-volume-capture.py")!r})
lock=h["RecoveryLock"](Path({str(f.registry)!r}));lock.acquire()
def crash_after_preserve(source,target):
 h["rename_noreplace"](source,target)
 os.kill(os.getpid(),signal.SIGKILL)
b.publish_rebuilt_packet(Path({str(stage)!r}),Path({str(packet)!r}),Path({str(rejected)!r}),{{**h,"rename_noreplace":crash_after_preserve}})
'''
        child = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
        self.assertEqual(child.returncode, -9, child.stderr)
        self.assertFalse(packet.exists())
        self.assertEqual({path.name: path.read_bytes() for path in rejected.iterdir()}, before)
        self.assertEqual((stage / "partial").read_bytes(), b"retained partial")
        result = self.rebuild_native(manifest_sha=md, archive_sha=ad)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual({path.name: path.read_bytes() for path in rejected.iterdir()}, before)
        self.assertEqual(self.verify_built_native()["proof_credit"], 0)
        self.assertEqual((stage / "partial").read_bytes(), b"retained partial")

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

    def test_generic_archive_admits_run_record_sealed_within_producer_bound(self):
        # A real Polar guest sealed a 95-206 MiB run.json; the consumer once
        # capped it at 64 MiB and raised a bare AssertionError.
        result = self.generic(published_run_bytes=65 * 1024 * 1024)
        self.assertEqual(result["proof_credit"], 0)
        status_server = retirement.runpy.run_path(str(ROOT / "scripts/cloudbench-status-server.py"))
        self.assertEqual(retirement.RUN_RECORD_MAX_BYTES, status_server["MAX_RECOVERY_RUN_BYTES"])
        with patch.object(retirement, "RUN_RECORD_MAX_BYTES", 1024):
            self.reset_fixture()
            with self.assertRaisesRegex(AssertionError, "exceeds the 1024-byte bound"):
                self.generic(published_run_bytes=2048)

    def test_generic_archive_bound_scales_with_covered_guests(self):
        # One primary plus one normal worker: two producer runtime budgets.
        self.generic()
        f = self.fixture
        packet = f.run / "_forensic"
        size = (packet / "originals.tar.gz").stat().st_size
        verify = lambda: retirement.verify(f.registry, f.run, packet / "manifest.json",
                                           packet / "originals.tar.gz", f.machines, f.volumes,
                                           archive_only=True)
        with patch.object(retirement, "GUEST_EVIDENCE_MAX_BYTES", size // 2 + 1):
            self.assertEqual(verify()["proof_credit"], 0)
        with patch.object(retirement, "GUEST_EVIDENCE_MAX_BYTES", size // 2 - 1):
            with self.assertRaisesRegex(AssertionError, "bound"):
                verify()

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
