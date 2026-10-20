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


class BoundRecipeLoaderTest(unittest.TestCase):
    def test_bound_comparison_reads_through_the_validated_shared_loader(self) -> None:
        ref = "c" * 40
        reads: list[tuple[Path, str, str]] = []

        def loader(root: Path, at: str, path: str) -> bytes:
            reads.append((root, at, path))
            return path.encode()

        def native(meta, config):
            # The fingerprint side of the shared loader.
            recovery.git_blob(Path(meta["workspace_root"]), ref, "scripts/run-bench-fleet")
            return ref, "recipe", "fingerprint"

        saved = recovery.git_blob, recovery.native_recipe, recovery._bound_optional_executables
        # The fake root is not a Git checkout, so its tree has no optional helper.
        recovery.git_blob, recovery.native_recipe = loader, native
        recovery._bound_optional_executables = lambda root, at: ()
        try:
            root = Path(tempfile.gettempdir()).resolve()
            expected = {
                path: hashlib.sha256(path.encode()).hexdigest()
                for path in recovery.recipe_paths(lambda path: path.encode())
            }
            provenance = {"git_head": ref, "git_exit_code": 0, "tracked_change_exit_code": 0,
                          "tracked_changed_paths": [], "source_file_sha256": expected}
            self.assertEqual(recovery.bound_recipe({"workspace_root": str(root)}, {}, provenance),
                             (ref, "recipe", "fingerprint"))
            self.assertTrue(reads and all(item[:2] == (root, ref) for item in reads))
            self.assertEqual({item[2] for item in reads[1:]}, set(expected) | {"scripts/run-bench-fleet"})
            changed = dict(provenance, source_file_sha256=dict(expected, **{"package.json": "0" * 64}))
            with self.assertRaises(ValueError):
                recovery.bound_recipe({"workspace_root": str(root)}, {}, changed)
        finally:
            recovery.git_blob, recovery.native_recipe, recovery._bound_optional_executables = saved


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

    def make_started_archive(self):
        forensic = self.run / "_forensic"
        forensic.mkdir()
        archive_path = forensic / "originals.tar.gz"
        files = {}
        with tarfile.open(archive_path, "w:gz") as archive:
            for relative, data in self.original.items():
                files[relative] = {
                    "bytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                }
                info = tarfile.TarInfo(f"{self.bench}/{relative}")
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
        write(
            forensic / "manifest.json",
            json.dumps(
                {
                    "schema": "cloudbench-started-evidence-v1",
                    "owner": OWNER,
                    "run_id": RUN_ID,
                    "proof_credit": 0,
                    "archive_bytes": archive_path.stat().st_size,
                    "archive_sha256": hashlib.sha256(
                        archive_path.read_bytes()
                    ).hexdigest(),
                    "tasks": [
                        {
                            "task": self.bench,
                            "ordinal": 0,
                            "run_token": TOKEN,
                            "machine_id": MACHINE,
                            "volume_id": VOLUME,
                            "kind": "pool",
                            "proof_credit": 0,
                            "files": files,
                        }
                    ],
                }
            ),
        )


    def verify_started_archive(self):
        forensic = self.run / "_forensic"
        return retirement.verify_started_pool_evidence(
            self.registry,
            self.run,
            forensic / "manifest.json",
            forensic / "originals.tar.gz",
            self.machines,
            self.volumes,
        )


    def assert_stopped_provider_corruptions_rejected(self, verify):
        paths = {
            name: self.out / f"guest-cleanup.{name}"
            for name in (
                "recovery-receipt.json",
                "provider-manifest.json",
                "machine-stopped.json",
                "backend.log",
            )
        }
        originals = {name: path.read_bytes() for name, path in paths.items()}
        for mutation in (
            "missing-release",
            "wrong-receipt-kind",
            "wrong-session",
            "forged-manifest",
            "different-backend",
        ):
            with self.subTest(mutation=mutation):
                receipt = json.loads(originals["recovery-receipt.json"])
                if mutation == "missing-release":
                    receipt["results"] = []
                elif mutation == "wrong-receipt-kind":
                    receipt["kind"] = "unverified-cleanup"
                elif mutation == "wrong-session":
                    receipt["results"][0]["session_id"] = "kernel_another_owner123"
                elif mutation == "forged-manifest":
                    manifest = json.loads(originals["provider-manifest.json"])
                    manifest["sessions"]["kernel"] = []
                    stopped = json.loads(originals["machine-stopped.json"])
                    stopped["manifest_sha256"] = cleanup.canonical_digest(manifest)
                    receipt["manifest_sha256"] = cleanup.canonical_digest(manifest)
                    receipt["stopped_machine_proof_sha256"] = cleanup.canonical_digest(
                        stopped
                    )
                    receipt["results"] = []
                    write(paths["provider-manifest.json"], json.dumps(manifest))
                    write(paths["machine-stopped.json"], json.dumps(stopped))
                else:
                    write(
                        paths["backend.log"],
                        originals["backend.log"] + b"another backend tail\n",
                    )
                write(paths["recovery-receipt.json"], json.dumps(receipt))
                try:
                    with self.assertRaises((AssertionError, ValueError)):
                        verify()
                finally:
                    for name, data in originals.items():
                        write(paths[name], data)
        self.assertEqual(verify()["proof_credit"], 0)


    def test_started_stale_running_requires_complete_exact_provider_cleanup(
        self,
    ) -> None:
        self.make_started_archive()
        self.assertEqual(self.verify_started_archive()["proof_credit"], 0)
        self.assert_stopped_provider_corruptions_rejected(self.verify_started_archive)


    def test_interrupted_running_driver_requires_complete_exact_provider_cleanup(
        self,
    ) -> None:
        self.original["cloudbench-driver.state"] = b"running\n"
        self.original["cloudbench-driver.pid"] = b"1511\n"
        self.make_capture()
        self.assertEqual(self.verify_archive()["proof_credit"], 0)
        self.assert_stopped_provider_corruptions_rejected(self.verify_existing_archive)


    def test_failed_services_cannot_retire_with_unverified_provider_cleanup(self) -> None:
        self.original["repo/.context/cloudbench/services.json"] = b'{"status":"failed"}'
        self.original["repo/.context/cloudbench/stack.log"] = b"Worker cleanup failed\n"
        self.make_capture()
        self.assertEqual(self.verify_archive()["proof_credit"], 0)
        receipt_path = self.out / "guest-cleanup.recovery-receipt.json"
        manifest_path = self.out / "guest-cleanup.provider-manifest.json"
        receipt_original = receipt_path.read_text()
        manifest_original = manifest_path.read_text()
        for mutation in ("missing-release", "wrong-receipt-kind", "wrong-manifest-kind", "stale-backend"):
            with self.subTest(mutation=mutation):
                receipt = json.loads(receipt_original)
                manifest = json.loads(manifest_original)
                if mutation == "missing-release":
                    receipt["results"] = []
                elif mutation == "wrong-receipt-kind":
                    receipt["kind"] = "unverified-cleanup"
                elif mutation == "wrong-manifest-kind":
                    manifest["kind"] = "unrecognized-provider-manifest"
                else:
                    manifest["evidence"]["backend_log_sha256"] = "f" * 64
                    receipt["manifest_sha256"] = cleanup.canonical_digest(manifest)
                write(receipt_path, json.dumps(receipt))
                write(manifest_path, json.dumps(manifest))
                with self.assertRaises(AssertionError):
                    self.verify_existing_archive()
                write(receipt_path, receipt_original)
                write(manifest_path, manifest_original)


if __name__ == "__main__":
    unittest.main()
