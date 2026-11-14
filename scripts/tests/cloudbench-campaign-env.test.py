#!/usr/bin/env python3
"""Real concurrent canonical verifier fixtures; no provider or secret writes."""

import fcntl
import json
import os
import re
import runpy
import shlex
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

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
            source = (
                os.environ.get("CLOUDBENCH_TEST_CAMPAIGN_ENV_SOURCE")
                if name == "cloudbench-campaign-env.py"
                else None
            )
            shutil.copyfile(source or ROOT / "scripts" / name, self.helpers / name)
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

    def test_actual_fleet_shell_waits_for_declared_job_pid_publication(self):
        source = (ROOT / "scripts/run-bench-fleet").read_text()
        function = re.search(
            r"^verify_fleet_environment\(\).*?^}\n", source, re.MULTILINE | re.DOTALL
        ).group()
        manifest = self.barrier / "manifest.json"
        manifest.write_text(json.dumps({"cohort_id": "cohort", "jobs": {"job": None}}))
        values = {
            "ROOT_DIR": str(self.root),
            "CLOUDBENCH_SCRIPT_SNAPSHOT": str(self.helpers),
            "CLOUDBENCH_CAMPAIGN_INVENTORY_DIR": str(self.inventory),
            "RUN_BENCH_CAMPAIGN_BARRIER_DIR": str(self.barrier),
            "RUN_BENCH_CAMPAIGN_JOB_ID": "job",
            "CLOUDBENCH_PRESTACK_CONTROLLER_REF": self.command[
                self.command.index("--source-ref") + 1
            ],
            "FLEET_CONTROLLER_STARTED_EPOCH": str(int(time.time())),
            "START_BARRIER_WAIT_SECONDS": "10",
        }
        setup = "\n".join(
            key + "=" + shlex.quote(value) for key, value in values.items()
        )
        script = (
            "set -eu\n"
            + setup
            + "\n"
            + function
            + '\nprintf "%s" "$$" > '
            + shlex.quote(str(self.root / "shell.pid"))
            + "\nif ! verify_fleet_environment; then exit 17; fi\n"
        )
        child = subprocess.Popen(
            ["bash", "-c", script],
            cwd=self.root,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            deadline = time.monotonic() + 5
            while (
                not (self.root / "shell.pid").exists() and time.monotonic() < deadline
            ):
                time.sleep(0.01)
            shell_pid = int((self.root / "shell.pid").read_text())
            self.assertEqual(shell_pid, child.pid)
            time.sleep(0.25)
            self.assertFalse((self.root / "calls").exists())
            next_manifest = manifest.with_suffix(".next")
            next_manifest.write_text(
                json.dumps({"cohort_id": "cohort", "jobs": {"job": shell_pid}})
            )
            next_manifest.replace(manifest)
            output, error = child.communicate(timeout=8)
            self.assertEqual(child.returncode, 0, error + output)
            self.assertEqual((self.root / "calls").read_text(), "1")
            result = self.run_check()
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((self.root / "calls").read_text(), "1")
        finally:
            if child.poll() is None:
                child.terminate()
                child.communicate(timeout=5)

    def test_unpublished_registration_keeps_original_deadline(self):
        (self.barrier / "manifest.json").write_text(
            json.dumps({"cohort_id": "cohort", "jobs": {"job": None}})
        )
        self.command[self.command.index("--deadline") + 1] = str(time.time() + 0.2)
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("registration deadline expired", result.stderr)
        self.assertFalse((self.root / "calls").exists())

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

    def run_actual_verifier(self, reads):
        """Run the real verify_app_environment with scripted secrets-list reads.

        Each entry in ``reads`` is (exit status, stdout) for one flyctl read;
        ``sleep`` is recorded instead of slept so pauses are asserted exactly.
        """
        source = (ROOT / "scripts/run-bench-cloud").read_text()
        body = source[
            source.index("REQUIRED_APP_SECRETS=") : source.index(
                '\nif [ "$MODE" = "verify-secrets" ]; then'
            )
        ]
        script = self.root / "reads"
        script.write_text("".join(f"{status} {out}\n" for status, out in reads))
        log = self.root / "read-log"
        result = subprocess.run(
            [
                "bash",
                "-c",
                "APP=fixture; "
                'sleep() { echo "sleep $1" >> "$LOG"; }; '
                '_with_timeout() { echo "read timeout=$1" >> "$LOG"; shift; "$@"; }; '
                "flyctl() { "
                "n=$(grep -c '^read ' \"$LOG\"); "
                "line=$(sed -n \"${n}p\" \"$READS\"); "
                'echo native-read-fixture >&2; printf "%s" "${line#* }"; '
                'return "${line%% *}"; }; '
                + body
                + "\nverify_app_environment",
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
            env={
                **{
                    key: value
                    for key, value in os.environ.items()
                    if key != "CLOUDBENCH_APP_ENV_READ_TIMEOUT_SECONDS"
                },
                "LOG": str(log),
                "READS": str(script),
            },
        )
        return result, log.read_text().splitlines()

    def complete_listing(self):
        source = (ROOT / "scripts/run-bench-cloud").read_text()
        names = re.search(r'REQUIRED_APP_SECRETS="([^"]+)"', source).group(1).split()
        return json.dumps([{"Name": name} for name in names])

    def test_actual_verifier_retains_native_failure_status_and_stderr(self):
        result, log = self.run_actual_verifier([(9, "")])
        self.assertEqual(result.returncode, 1)
        self.assertIn("native-read-fixture", result.stderr)
        self.assertIn("read exit=9", result.stderr)
        # A non-timeout failure (auth, missing app) is never retried.
        self.assertEqual(log, ["read timeout=20"])

    def test_actual_verifier_retries_one_slow_read_then_verifies(self):
        result, log = self.run_actual_verifier(
            [(124, ""), (0, self.complete_listing())]
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("environment verified (read-only)", result.stdout)
        self.assertIn("timed out after 20s (attempt 1/3)", result.stderr)
        self.assertEqual(log, ["read timeout=20", "sleep 2", "read timeout=20"])

    def test_actual_verifier_persistent_timeout_fails_after_three_reads(self):
        result, log = self.run_actual_verifier([(124, "")] * 4)
        self.assertEqual(result.returncode, 1)
        self.assertIn("read exit=124", result.stderr)
        self.assertEqual(
            log,
            [
                "read timeout=20",
                "sleep 2",
                "read timeout=20",
                "sleep 5",
                "read timeout=20",
            ],
        )

    def test_actual_verifier_missing_secret_after_slow_read_fails_loud(self):
        listing = json.loads(self.complete_listing())
        missing = listing.pop()["Name"]
        result, log = self.run_actual_verifier([(124, ""), (0, json.dumps(listing))])
        self.assertEqual(result.returncode, 1)
        self.assertIn(f"missing secrets: {missing}", result.stderr)
        self.assertEqual(log, ["read timeout=20", "sleep 2", "read timeout=20"])

    def test_selected_authentication_matches_canonical_shell_resolver(self):
        helper = runpy.run_path(str(self.helpers / "cloudbench-campaign-env.py"))
        source = (ROOT / "scripts/run-bench-cloud").read_text()
        resolver = re.search(
            r"^resolve_fly_token\(\) \{.*?^}", source, re.MULTILINE | re.DOTALL
        ).group()
        home = self.root / "auth-home"
        (home / ".fly").mkdir(parents=True)
        config = home / ".fly/config.yml"
        agents = self.root / "agents/.env"
        cases = [
            (
                "bench-token-long-enough-fixture",
                "process-fixture",
                "access_token: config-fixture\n",
                "agents-fixture",
            ),
            (
                "short",
                "process-fixture",
                "access_token: 'config-fixture'\n",
                "agents-fixture",
            ),
            (
                "",
                "process-fixture",
                'access_token: ""\nother: metadata\n',
                "agents-fixture",
            ),
            ("", "", "other: metadata\n", "agents-fixture"),
            ("", "", "access_token:\tconfig-tab\n", "agents-fixture"),
            ("", "", "other: metadata\n", ""),
        ]
        for bench, process, content, agent in cases:
            config.write_text(content)
            agents.write_text('FLY_API_TOKEN="' + agent + '"\n')
            env = dict(
                os.environ,
                HOME=str(home),
                FLY_BENCH_API_TOKEN=bench,
                FLY_API_TOKEN=process,
            )
            shell = subprocess.run(
                ["bash", "-c", resolver + "\nresolve_fly_token"],
                cwd=self.root,
                env=env,
                capture_output=True,
                check=True,
            )
            import hashlib

            expected = hashlib.sha256(shell.stdout.rstrip(b"\n")).hexdigest()
            with patch.dict(os.environ, env, clear=True):
                self.assertEqual(
                    helper["selected_authentication"](self.root)["credential_sha256"],
                    expected,
                )

    def concurrent_config_change(self, selected_changes):
        home = self.root / "concurrent-home"
        (home / ".fly").mkdir(parents=True)
        config = home / ".fly/config.yml"
        config.write_text("last_check: first\n")
        env = dict(
            os.environ,
            HOME=str(home),
            FLY_API_TOKEN="process-fixture",
            FLY_BENCH_API_TOKEN="",
        )
        verifier = self.helpers / "run-bench-cloud"
        verifier.write_text(
            verifier.read_text().replace(
                "time.sleep(0.25)",
                "\nend=time.monotonic()+5\nwhile not (p/'release').exists() and time.monotonic()<end:time.sleep(0.01)\n",
            )
        )
        children = []
        try:
            children.append(
                subprocess.Popen(
                    self.command,
                    env=env,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
            )
            end = time.monotonic() + 4
            while not (self.root / "child.pid").exists() and time.monotonic() < end:
                time.sleep(0.01)
            self.assertTrue((self.root / "child.pid").exists())
            children.append(
                subprocess.Popen(
                    self.command,
                    env=env,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
            )

            def waiting(process):
                try:
                    return any(
                        str(path.readlink()).endswith(".lock")
                        and "environment-preflight" in str(path.readlink())
                        for path in (Path("/proc") / str(process.pid) / "fd").iterdir()
                    )
                except FileNotFoundError:
                    return False

            while (
                not all(waiting(child) for child in children) and time.monotonic() < end
            ):
                time.sleep(0.01)
            self.assertTrue(
                all(waiting(child) for child in children),
                "both helpers must have bound old identity before rewrite",
            )
            replacement = config.with_suffix(".next")
            replacement.write_text(
                "access_token: changed-credential\n"
                if selected_changes
                else "last_check: second\n"
            )
            replacement.replace(config)
            (self.root / "release").touch()
            outputs = [child.communicate(timeout=8) for child in children]
            if selected_changes:
                self.assertTrue(all(child.returncode for child in children), outputs)
                self.assertFalse(
                    list((self.barrier / "environment-preflight").glob("*.pass.json"))
                )
                mismatches = list(
                    (self.barrier / "environment-preflight").glob(
                        "identity-mismatch-*.json"
                    )
                )
                self.assertTrue(mismatches)
                self.assertTrue(
                    any(
                        "authentication"
                        in str(json.loads(path.read_text())["changed_fields"])
                        for path in mismatches
                    )
                )
            else:
                self.assertTrue(
                    all(child.returncode == 0 for child in children), outputs
                )
                self.assertEqual((self.root / "calls").read_text(), "1")
                self.assertEqual(
                    len(
                        list(
                            (self.barrier / "environment-preflight").glob("*.pass.json")
                        )
                    ),
                    1,
                )
        finally:
            (self.root / "release").touch()
            for child in children:
                if child.poll() is None:
                    child.terminate()
                child.communicate(timeout=8)

    def test_unselected_config_rewrite_does_not_invalidate_waiting_cohort(self):
        self.concurrent_config_change(False)

    def test_changed_selected_credential_refuses_and_retains_mismatch(self):
        self.concurrent_config_change(True)

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
