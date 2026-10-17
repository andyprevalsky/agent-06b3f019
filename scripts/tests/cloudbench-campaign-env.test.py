#!/usr/bin/env python3
"""Real concurrent canonical verifier fixtures; no provider or secret writes."""

import fcntl
import json
import os
import runpy
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SEED = runpy.run_path(str(ROOT / "scripts/cloudbench-campaign-seed.py"))


class Environment(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)
        self.helpers = self.root / "scripts"
        self.helpers.mkdir()
        for name in [
            "cloudbench-campaign-env.py",
            "cloudbench-campaign-seed.py",
            "cloudbench-port-lease.py",
        ]:
            shutil.copyfile(ROOT / "scripts" / name, self.helpers / name)
        for directory in ["agents", "back-end", "inventory", "startup-cohorts/cohort"]:
            (self.root / directory).mkdir(parents=True, exist_ok=True)
        for directory in ["agents", "back-end"]:
            (self.root / directory / ".env").write_text("EXACT_FIXTURE=value\n")
        self.inventory = self.root / "inventory"
        self.barrier = self.root / "startup-cohorts/cohort"
        self.parent_lock = (self.barrier.parent / "parent.lock").open("w")
        fcntl.flock(self.parent_lock, fcntl.LOCK_EX)
        self.addCleanup(self.parent_lock.close)
        owner = {
            "app": "navi-whisper-lux-bench",
            "pid": os.getpid(),
            "pid_start": SEED["birth"](os.getpid()),
            "token": "owner-fixture",
            "parent_pid": os.getpid(),
            "parent_start": SEED["birth"](os.getpid()),
        }
        (self.inventory / "owner").write_text(
            "".join(str(k) + "=" + str(v) + "\n" for k, v in owner.items())
        )
        (self.barrier / "manifest.json").write_text(
            json.dumps({"cohort_id": "cohort", "jobs": {"job": os.getpid()}})
        )
        (self.helpers / "run-bench-cloud").write_text("""#!/bin/bash
set -eu
[ "$1" = --verify-secrets ]
python3 -S - "$PWD" <<'PY'
import fcntl,os,time,sys
from pathlib import Path
p=Path(sys.argv[1])
with (p/'calls.lock').open('a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 n=int((p/'calls').read_text()) if (p/'calls').exists() else 0
 (p/'calls').write_text(str(n+1))
 (p/'child.pid').write_text(str(os.getpid()))
time.sleep(0.25)
if (p/'fail').exists():
 print('native diagnostic fixture',file=sys.stderr)
 raise SystemExit(9)
if (p/'hang').exists():time.sleep(60)
print('canonical verification success')
PY
""")
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        (self.root / "source-marker").write_text("fixture")
        subprocess.run(
            ["git", "-C", str(self.root), "add", "source-marker"], check=True
        )
        subprocess.run(
            [
                "git",
                "-C",
                str(self.root),
                "-c",
                "user.name=fixture",
                "-c",
                "user.email=fixture@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-qm",
                "fixture",
            ],
            check=True,
        )
        source_ref = subprocess.check_output(
            ["git", "-C", str(self.root), "rev-parse", "HEAD"], text=True
        ).strip()
        self.command = [
            "python3",
            "-I",
            "-S",
            "-B",
            str(self.helpers / "cloudbench-campaign-env.py"),
            "--root",
            str(self.root),
            "--inventory",
            str(self.inventory),
            "--barrier",
            str(self.barrier),
            "--job",
            "job",
            "--controller-pid",
            str(os.getpid()),
            "--source-ref",
            source_ref,
            "--deadline",
            str(time.time() + 30),
        ]

    def run_check(self):
        return subprocess.run(
            self.command, capture_output=True, text=True, timeout=8, check=False
        )

    def test_concurrent_canonical_checks_share_success_and_bind_environment(self):
        # Legacy fleet invokes the same canonical verifier separately per job.
        legacy = [
            subprocess.Popen(
                ["bash", str(self.helpers / "run-bench-cloud"), "--verify-secrets"],
                cwd=self.root,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            for _ in range(2)
        ]
        for process in legacy:
            process.communicate(timeout=5)
            self.assertEqual(process.returncode, 0)
        self.assertEqual((self.root / "calls").read_text(), "2")
        (self.root / "calls").unlink()
        children = [
            subprocess.Popen(
                self.command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
            )
            for _ in range(6)
        ]
        try:
            for process in children:
                output, error = process.communicate(timeout=8)
                self.assertEqual(process.returncode, 0, error + output)
        finally:
            for process in children:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=5)
        self.assertEqual((self.root / "calls").read_text(), "1")
        self.assertEqual(
            len(list((self.barrier / "environment-preflight").glob("*.pass.json"))), 1
        )
        (self.root / "agents/.env").write_text("EXACT_FIXTURE=changed\n")
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "calls").read_text(), "2")

    def test_actual_verifier_retains_native_failure_status_and_stderr(self):
        source = (ROOT / "scripts/run-bench-cloud").read_text()
        body = source[
            source.index("verify_app_environment() {") : source.index(
                '\nif [ "$MODE" = "verify-secrets" ]; then'
            )
        ]
        result = subprocess.run(
            [
                "bash",
                "-c",
                "APP=fixture; FLY() { echo native-read-fixture >&2; return 9; }; "
                + body
                + "\nverify_app_environment",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("native-read-fixture", result.stderr)
        self.assertIn("read exit=9", result.stderr)

    def test_failure_is_not_cached_and_private_diagnostic_is_retained(self):
        (self.root / "fail").touch()
        result = self.run_check()
        self.assertEqual(result.returncode, 9, result.stderr)
        directory = self.barrier / "environment-preflight"
        self.assertEqual(list(directory.glob("*.pass.json")), [])
        self.assertIn(
            "native diagnostic fixture",
            next(directory.glob("attempt-*/stderr.private.log")).read_text(),
        )
        (self.root / "fail").unlink()
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "calls").read_text(), "2")

    def test_foreign_controller_and_symlink_cache_refuse_before_verification(self):
        self.command[self.command.index("--controller-pid") + 1] = "1"
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "calls").exists())
        self.command[self.command.index("--controller-pid") + 1] = str(os.getpid())
        (self.barrier / "environment-preflight").symlink_to(self.root)
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "calls").exists())

    def test_cancel_joins_only_owned_verifier_and_never_publishes_success(self):
        (self.root / "hang").touch()
        child = subprocess.Popen(
            self.command, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        try:
            deadline = time.monotonic() + 5
            while (
                not (self.root / "child.pid").exists() and time.monotonic() < deadline
            ):
                time.sleep(0.02)
            self.assertTrue((self.root / "child.pid").exists())
            verifier = int((self.root / "child.pid").read_text())
            child.send_signal(signal.SIGTERM)
            child.communicate(timeout=8)
            self.assertNotEqual(child.returncode, 0)
            self.assertEqual(
                list((self.barrier / "environment-preflight").glob("*.pass.json")), []
            )
            status = Path("/proc") / str(verifier) / "stat"
            self.assertTrue(
                not status.exists()
                or status.read_text().rsplit(") ", 1)[1].startswith("Z ")
            )
        finally:
            if child.poll() is None:
                child.terminate()
                child.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
