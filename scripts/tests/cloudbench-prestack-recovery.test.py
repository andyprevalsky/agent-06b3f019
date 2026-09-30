#!/usr/bin/env python3
"""Offline exact-owner regression for a Mac-only task stopped before stack startup."""

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


if __name__ == "__main__":
    unittest.main()
