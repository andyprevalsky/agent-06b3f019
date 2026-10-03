#!/usr/bin/env python3
"""Offline exact-owner regression for a capacity-rejected pooled guest."""

import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


recovery = load("rejected_start", ROOT / "cloudbench-rejected-start-recovery.py")
retirement = load("forensic_retirement", ROOT / "cloudbench-forensic-retirement.py")
OWNER = "a" * 32
MACHINE = "b" * 14
VOLUME = "vol_abcdefghijklmnop"
RUN_ID = "20260929-test-run"
BENCH = "polar-odysseys-example"
APP = "navi-whisper-lux-bench"


def write(path: Path, value: str | bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(value.encode() if isinstance(value, str) else value)


def pairs(path: Path, values: dict[str, str]) -> None:
    write(path, "".join(f"{key}={value}\n" for key, value in values.items()))


class RejectedStartRecoveryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.registry = self.base / "owners" / OWNER
        self.run = self.base / "runs" / RUN_ID
        self.out = self.run / BENCH
        self.capture_dir = self.base / "captures"
        self.audit = self.base / "audit" / OWNER
        self.machine_file = self.base / "machines.json"
        self.volume_file = self.base / "volumes.json"
        self.original = {
            "bench.log": b"old run complete\n",
            "cloudbench-driver.state": b"exited\n",
            "repo/.context/cloudbench/services.json": b'{"status":"stopped"}',
            "repo/.context/cloudbench/logs/backend.log": b"old backend stopped\n",
            "repo/.context/cloudbench/run.json": b'{"run_id":"prior-run","tasks":[{"name":"previous"}]}',
        }
        pairs(
            self.registry / "meta",
            {
                "version": "2",
                "fleet_owner_token": OWNER,
                "cleanup_policy": "retain",
                "run_id": RUN_ID,
                "runs_root": str(self.run.parent),
                "audit_dir": str(self.audit),
                "app": APP,
            },
        )
        write(self.registry / "guest-cleanup-unconfirmed", "")
        write(self.registry / "runtime-evidence-unconfirmed", "")
        pairs(
            self.audit / "pool" / MACHINE,
            {
                "fleet_owner_token": OWNER,
                "run_id": RUN_ID,
                "app": APP,
                "source": "borrowed-pool",
                "disposition": "claimed",
                "volume_id": VOLUME,
            },
        )
        write(self.run / "_batch/lifecycle.json", json.dumps({"status": "failed", "fleet_owner_token": OWNER}))
        write(self.run / "_batch/benches.json", json.dumps([{"name": BENCH}]))
        write(self.out / ".cid", f"pool {MACHINE}\n")
        owner_record = {"version": 1, "machine_id": MACHINE, "run_token": f"{OWNER}-0"}
        write(self.out / "runtime-evidence.owner.json", json.dumps(owner_record))
        write(self.out / "runtime-evidence.pending", json.dumps(owner_record))
        write(self.out / "worker-clones.ids", "")
        line = f"Error: could not start machine due to lack of capacity. Try 'flyctl machine clone {MACHINE} -a {APP}'\n"
        write(self.out / "cloudbench-boot-start.log", line * 4)
        write(
            self.out / "fleet-child.log",
            "provider did not accept the required post-config start\nOriginal exit code: 125\n",
        )
        write(
            self.machine_file,
            json.dumps([{"id": MACHINE, "state": "stopped", "config": {
                "init": {"cmd": ["bash", "/cloudbench-boot.sh"]},
                "mounts": [{"volume": VOLUME}],
            }}]),
        )
        write(self.volume_file, json.dumps([{"id": VOLUME, "attached_machine_id": MACHINE}]))
        self.make_capture()

    def make_capture(self) -> None:
        capture = self.capture_dir / f"{MACHINE}.tar.gz"
        capture.parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(capture, "w:gz") as archive:
            for name, data in self.original.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
        data = capture.read_bytes()
        write(
            self.capture_dir / f"{MACHINE}.provenance.json",
            json.dumps({
                "direct_original_volume": True,
                "source_machine_id": MACHINE,
                "source_volume_id": VOLUME,
                "archive_sha256": hashlib.sha256(data).hexdigest(),
                "archive_bytes": len(data),
                "files": list(self.original),
                "proof_credit": 0,
            }),
        )

    def verify(self):
        return recovery.verify(
            self.registry, BENCH, self.capture_dir, self.machine_file, self.volume_file
        )

    def test_exact_rejected_start_releases_only_zero_credit_guest_marker(self) -> None:
        out, receipt = self.verify()
        self.assertEqual(out, self.out)
        self.assertEqual(receipt["proof_credit"], 0)
        recovery.publish(out, receipt)
        self.assertEqual((out / "guest-shutdown.confirmed").read_text(), RUN_ID + "\n")
        retirement.verify_rejected_start_archive(
            out, {"task": BENCH, "machine_id": MACHINE, "volume_id": VOLUME,
                  "run_token": f"{OWNER}-0"}, OWNER, RUN_ID, self.original,
        )

    def test_accepted_start_is_never_downgraded(self) -> None:
        write(self.out / "post-config-start.accepted", MACHINE + "\n")
        with self.assertRaisesRegex(ValueError, "runtime evidence"):
            self.verify()

    def test_missing_provider_rejection_is_never_downgraded(self) -> None:
        path = self.out / "cloudbench-boot-start.log"
        write(path, path.read_text().splitlines(keepends=True)[0] * 3)
        with self.assertRaisesRegex(ValueError, "every bounded start"):
            self.verify()

    def test_original_volume_with_current_owner_is_not_zero_work(self) -> None:
        self.original["bench.log"] = f"started {OWNER}\n".encode()
        self.make_capture()
        with self.assertRaisesRegex(ValueError, "current owner appeared"):
            self.verify()

    def test_live_or_detached_original_volume_is_rejected(self) -> None:
        write(self.machine_file, json.dumps([{"id": MACHINE, "state": "started", "config": {
            "init": {"cmd": ["bash", "/cloudbench-boot.sh"]},
            "mounts": [{"volume": VOLUME}],
        }}]))
        with self.assertRaisesRegex(ValueError, "not stopped and attached"):
            self.verify()


if __name__ == "__main__":
    unittest.main()
