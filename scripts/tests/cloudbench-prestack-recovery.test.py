#!/usr/bin/env python3
"""Offline exact-owner regression for a Mac-only task stopped before stack startup."""

import argparse
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
OWNER = "a" * 32
MACHINE = "b" * 14
VOLUME = "vol_abcdefghijklmnop"
RUN_ID = "20260930-test-run"
BENCH = "message-person"
APP = "navi-whisper-lux-bench"
TOKEN = OWNER + "-0"


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


recovery = load("prestack_recovery", ROOT / "cloudbench-prestack-recovery.py")
retirement = load("forensic_retirement_prestack", ROOT / "cloudbench-forensic-retirement.py")
cleanup = load("exact_cleanup_failed_stack", ROOT / "cloudbench-exact-session-cleanup.py")


def write(path: Path, value: str | bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(value.encode() if isinstance(value, str) else value)


def pairs(path: Path, values: dict[str, str]) -> None:
    write(path, "".join(f"{key}={value}\n" for key, value in values.items()))


class PrestackRecoveryTest(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name).resolve()
        self.registry = self.base / "owners" / OWNER
        self.run = self.base / "runs" / RUN_ID
        self.out = self.run / BENCH
        self.audit = self.base / "audit" / OWNER
        self.captures = self.base / "captures"
        self.machines = self.base / "machines.json"
        self.volumes = self.base / "volumes.json"
        self.original = {
            "bench.log": (
                f"[boot] owner={OWNER} git-syncing + verifying /data/repo\n"
                "guest shutdown requested\n"
                "driver exited rc=143\n"
            ).encode(),
            "cloudbench-driver.state": b"exited\n",
            f"cloudbench-driver-clean-{TOKEN}.ack": (TOKEN + "\n").encode(),
        }
        pairs(self.registry / "meta", {
            "version": "2", "fleet_owner_token": OWNER, "cleanup_policy": "reap",
            "run_id": RUN_ID, "runs_root": str(self.run.parent),
            "audit_dir": str(self.audit), "app": APP,
        })
        write(self.registry / "runtime-evidence-unconfirmed", "")
        (self.registry / "clones").mkdir(parents=True)
        pairs(self.audit / "meta", {
            "fleet_owner_token": OWNER, "run_id": RUN_ID, "app": APP,
        })
        for name in ("by-machine-id", "fresh", "expected-fresh"):
            (self.audit / name).mkdir()
        pairs(self.audit / "pool" / MACHINE, {
            "version": "1", "fleet_owner_token": OWNER, "run_id": RUN_ID,
            "app": APP, "source": "borrowed-pool", "machine_id": MACHINE,
            "volume_id": VOLUME, "disposition": "claimed",
        })
        write(self.run / "_batch/lifecycle.json", json.dumps({
            "status": "failed", "controller_exit_code": 1,
            "fleet_owner_token": OWNER,
        }))
        write(self.run / "_batch/benches.json", json.dumps([{"name": BENCH}]))
        write(self.out / ".cid", f"pool {MACHINE}\n")
        record = {"version": 1, "machine_id": MACHINE, "run_token": TOKEN}
        write(self.out / "runtime-evidence.owner.json", json.dumps(record))
        write(self.out / "runtime-evidence.pending", json.dumps(record))
        write(self.out / "guest-shutdown.confirmed", RUN_ID + "\n")
        write(self.out / "post-config-start.accepted", MACHINE + "\n")
        write(self.out / "worker-clones.ids", "")
        write(self.out / "benchmark-child.finished", "70\n")
        write(self.out / "fleet-child.log",
              "Live message-person benchmark requires a macOS controller for Apple Messages\n"
              "Original exit code: 70\n")
        write(self.machines, json.dumps([{
            "id": MACHINE, "state": "stopped", "config": {
                "init": {"cmd": ["bash", "/cloudbench-boot.sh"]},
                "mounts": [{"volume": VOLUME}],
            },
        }]))
        write(self.volumes, json.dumps([{"id": VOLUME, "attached_machine_id": MACHINE}]))
        self.make_capture()

    def make_capture(self) -> None:
        capture = self.captures / f"{MACHINE}.tar.gz"
        capture.parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(capture, "w:gz") as archive:
            for name, data in self.original.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
        payload = capture.read_bytes()
        write(self.captures / f"{MACHINE}.provenance.json", json.dumps({
            "direct_original_volume": True, "source_machine_id": MACHINE,
            "source_volume_id": VOLUME, "archive_sha256": hashlib.sha256(payload).hexdigest(),
            "archive_bytes": len(payload), "files": list(self.original), "proof_credit": 0,
        }))

    def verify(self):
        return recovery.verify(self.registry, BENCH, self.captures, self.machines, self.volumes)

    def test_exact_prestack_capture_retires_only_zero_credit_runtime(self) -> None:
        out, receipt = self.verify()
        self.assertEqual(receipt["proof_credit"], 0)
        recovery.publish(out, receipt)
        retirement.verify_prestack_archive(
            out, {"task": BENCH, "machine_id": MACHINE, "volume_id": VOLUME,
                  "run_token": TOKEN}, OWNER, RUN_ID, self.original,
        )

    def test_full_interrupted_archive_accepts_exact_prestack_bytes(self) -> None:
        out, receipt = self.verify()
        recovery.publish(out, receipt)
        build = subprocess.run([
            sys.executable, str(ROOT / "cloudbench-build-interrupted-pool-archive.py"),
            "--registry", str(self.registry), "--capture-dir", str(self.captures),
        ], capture_output=True, text=True)
        self.assertEqual(build.returncode, 0, build.stderr)
        forensic = self.run / "_forensic"
        result = retirement.verify_interrupted_pool_evidence(
            self.registry, self.run, forensic / "manifest.json",
            forensic / "originals.tar.gz", self.machines, self.volumes,
        )
        self.assertEqual(result["proof_credit"], 0)
        self.assertEqual(result["incomplete_tasks"], 1)

    def test_stack_start_is_not_prestack(self) -> None:
        self.original["repo/.context/cloudbench/services.json"] = b'{"status":"stopped"}'
        self.make_capture()
        with self.assertRaisesRegex(ValueError, "before stack startup"):
            self.verify()

    def test_missing_exact_clean_ack_is_rejected(self) -> None:
        self.original.pop(f"cloudbench-driver-clean-{TOKEN}.ack")
        self.make_capture()
        with self.assertRaisesRegex(ValueError, "before stack startup"):
            self.verify()

    def test_live_machine_or_wrong_task_boundary_is_rejected(self) -> None:
        write(self.machines, json.dumps([{"id": MACHINE, "state": "started", "config": {
            "init": {"cmd": ["bash", "/cloudbench-boot.sh"]},
            "mounts": [{"volume": VOLUME}],
        }}]))
        with self.assertRaisesRegex(ValueError, "not stopped and attached"):
            self.verify()
        write(self.machines, json.dumps([{"id": MACHINE, "state": "stopped", "config": {
            "init": {"cmd": ["bash", "/cloudbench-boot.sh"]},
            "mounts": [{"volume": VOLUME}],
        }}]))
        write(self.out / "fleet-child.log", "other failure\nOriginal exit code: 70\n")
        with self.assertRaisesRegex(ValueError, "unsupported platform"):
            self.verify()


class FailedStackRecoveryTest(unittest.TestCase):
    """A required service can die before run.sh updates services.json."""

    make_capture = PrestackRecoveryTest.make_capture

    def setUp(self) -> None:
        PrestackRecoveryTest.setUp(self)
        self.bench = "polar-odysseys-dd2eedbc88cb"
        renamed = self.run / self.bench
        self.out.rename(renamed)
        self.out = renamed
        write(self.run / "_batch/benches.json", json.dumps([{"name": self.bench}]))
        write(self.out / "benchmark-child.finished", "125\n")
        backend = (
            "[Server] Server started\n"
            "[HTTP] POST /api/agents -> 201\n"
            "model=Agent operation=read path=/api/agents/694913ff-2954-4d9a-b206-53c0c2dea488\n"
            "Created Kernel browser session sessionId=kernel_failed_stack123\n"
        ).encode()
        self.original = {
            "bench.log": b"owned benchmark interrupted after backend death\n",
            "cloudbench-driver.state": b"exited\n",
            "repo/.context/cloudbench/services.json": json.dumps({
                "status": "running", "services": [{"name": "back-end", "pid": 1510}],
            }).encode(),
            "repo/.context/cloudbench/stack.log": (
                "Environment ready\n"
                "back-end (PID 1510) exited with code 137 — shutting down all services.\n"
                "Stopping all services...\n"
            ).encode(),
            "repo/.context/cloudbench/logs/backend.log": backend,
            "repo/.context/cloudbench/logs/worker.log": b"worker stopped\n",
            "repo/.context/cloudbench/run.json": json.dumps({
                "tasks": [{"name": self.bench, "status": "ERROR"}],
            }).encode(),
        }
        write(self.out / "guest-cleanup.backend.log", backend)
        write(self.out / "fleet-child.log", "backend lost during evidence finalization\nOriginal exit code: 125\n")
        clone_name = "exact-failed-stack"
        status = (
            f"Machine ID: {MACHINE}\nState: stopped\nVM\n"
            f" ID │ {MACHINE}\n State │ stopped\n Name │ {clone_name}\n"
        )
        write(self.out / "guest-cleanup.machine-status.txt", status)
        args = argparse.Namespace(
            owner=OWNER, fleet_run_id=RUN_ID, bench=self.bench, machine_id=MACHINE,
            output_dir=str(self.out), guest_run_token=TOKEN,
            backend_log=str(self.out / "guest-cleanup.backend.log"),
            clone_name=clone_name,
            machine_status=str(self.out / "guest-cleanup.machine-status.txt"),
            manifest=str(self.out / "guest-cleanup.provider-manifest.json"),
            stopped_proof=str(self.out / "guest-cleanup.machine-stopped.json"),
        )
        manifest = cleanup.active_provider_manifest(args)
        write(Path(args.manifest), json.dumps(manifest))
        stopped = cleanup.stopped_machine_proof(args)
        write(Path(args.stopped_proof), json.dumps(stopped))
        write(self.out / "guest-cleanup.recovery-receipt.json", json.dumps({
            "schema_version": cleanup.SCHEMA, "version": 1,
            "kind": "provider-exact-cleanup", **cleanup.identity(args),
            "root_agent_id": manifest["root_agent_id"],
            "manifest_sha256": cleanup.canonical_digest(manifest),
            "stopped_machine_proof_sha256": cleanup.canonical_digest(stopped),
            "results": [{"provider": "kernel", "session_id": "kernel_failed_stack123",
                         "http_status": 204, "response_sha256": "0" * 64}],
        }))
        self.make_capture()

    def verify_archive(self):
        build = subprocess.run([
            sys.executable, str(ROOT / "cloudbench-build-interrupted-pool-archive.py"),
            "--registry", str(self.registry), "--capture-dir", str(self.captures),
        ], capture_output=True, text=True)
        self.assertEqual(build.returncode, 0, build.stderr)
        return self.verify_existing_archive()

    def verify_existing_archive(self):
        forensic = self.run / "_forensic"
        return retirement.verify_interrupted_pool_evidence(
            self.registry, self.run, forensic / "manifest.json",
            forensic / "originals.tar.gz", self.machines, self.volumes,
        )

    def add_retired_worker(self):
        worker, volume, name = "c" * 14, "vol_retiredworker123", "cloudbench-retired-worker"
        pairs(self.audit / "fresh" / name, {
            "version": "1", "fleet_owner_token": OWNER, "run_id": RUN_ID, "app": APP,
            "clone_name": name, "source": "fresh-clone", "source_machine_id": MACHINE,
            "machine_id": worker, "volume_id": volume, "disposition": "destroyed-provider-retained",
        })
        pairs(self.audit / "expected-fresh" / name, {"clone_name": name, "source_machine_id": MACHINE})
        write(self.audit / "by-machine-id" / worker, name + "\n")
        base = self.out / "worker-runtime-evidence" / worker
        identity = {"version": 1, "machine_id": worker, "run_token": TOKEN}
        write(base / "owner.json", json.dumps({**identity, "primary_machine_id": MACHINE}))
        process = {"pid": 123, "birth": "linux:00000000-0000-4000-8000-000000000001:456"}
        owner = {**identity, "supervisor": process, "expected_worker_logs": ["worker.txt"]}
        terminal = {**identity, "supervisor": process, "child": process,
                    "quiescent": True, "children_reaped": True, "streams_closed": True,
                    "worker_started": True, "exit_code": 0}
        files = {"receipts/owner.json": json.dumps(owner).encode(),
                 "receipts/terminal.json": json.dumps(terminal).encode(),
                 "logs/worker.log": b"supervisor closed\n", "logs/agents/worker.txt": b"original worker closed\n"}
        capture = base / "capture"
        for relative, data in files.items():
            write(capture / relative, data)
        write(capture / "manifest.json", json.dumps({
            **identity, "quiescent": True, "terminal": terminal, "worker_logs": ["worker.txt"],
            "files": {relative: {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                      for relative, data in files.items()},
        }))
        return worker, volume, capture

    def test_interrupted_pool_accepts_verified_retired_worker_and_rejects_missing_or_live_evidence(self):
        worker, volume, capture = self.add_retired_worker()
        receipt = self.verify_archive()
        self.assertEqual(receipt["proof_credit"], 0)
        self.assertEqual(receipt["verified_workers"], 1)
        for inventory, extra in ((self.machines, {"id": worker, "state": "started"}),
                                 (self.volumes, {"id": volume})):
            original = inventory.read_text()
            write(inventory, json.dumps(json.loads(original) + [extra]))
            with self.assertRaises(AssertionError):
                self.verify_existing_archive()
            write(inventory, original)
        log = capture / "logs/worker.log"
        original = log.read_bytes()
        log.write_bytes(original + b"unverified tail")
        with self.assertRaises(ValueError):
            self.verify_existing_archive()
        log.write_bytes(original)
        owner = capture.parent / "owner.json"
        original = owner.read_text()
        changed = json.loads(original)
        changed["primary_machine_id"] = worker
        write(owner, json.dumps(changed))
        with self.assertRaises(AssertionError):
            self.verify_existing_archive()

    def test_stale_running_manifest_after_backend_sigkill_retires_zero_credit(self) -> None:
        result = self.verify_archive()
        self.assertEqual(result["proof_credit"], 0)
        self.assertEqual(result["incomplete_tasks"], 1)

    def test_running_manifest_without_matching_supervisor_exit_is_rejected(self) -> None:
        self.original["repo/.context/cloudbench/stack.log"] = b"Environment ready\n"
        self.make_capture()
        with self.assertRaises(AssertionError):
            self.verify_archive()

    def test_running_manifest_with_wrong_backend_pid_is_rejected(self) -> None:
        stack = self.original["repo/.context/cloudbench/stack.log"]
        self.original["repo/.context/cloudbench/stack.log"] = stack.replace(
            b"back-end (PID 1510)", b"back-end (PID 9999)")
        self.make_capture()
        with self.assertRaises(AssertionError):
            self.verify_archive()

    def test_running_manifest_with_incomplete_provider_receipt_is_rejected(self) -> None:
        receipt_path = self.out / "guest-cleanup.recovery-receipt.json"
        receipt = json.loads(receipt_path.read_text())
        receipt["results"] = []
        write(receipt_path, json.dumps(receipt))
        with self.assertRaises(AssertionError):
            self.verify_archive()


if __name__ == "__main__":
    unittest.main()
