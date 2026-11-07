#!/usr/bin/env python3
"""Replay the unchanged active-retry consumer across a normal delayed ledger poll."""
import ast
import base64
import glob
import json
import os
from pathlib import Path, PurePosixPath
import re
import runpy
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = (ROOT / "scripts/tests/cloudbench-multi-workstream.test.sh").read_text()
FLEET = (ROOT / "scripts/run-bench-fleet").read_text()


def function(name):
    return re.search(r"^" + name + r"\(\).*?^}", FLEET, re.M | re.S).group()


class Clock:
    """Only the fake driver's clock is controlled; its 30-second bounds stay intact."""
    def __init__(self):
        self.value = 0.0
        self.events = []

    def time(self):
        return self.value

    def sleep(self, seconds):
        target = self.value + seconds
        while self.events and self.events[0][0] <= target:
            self.value, action = self.events.pop(0)
            action()
        self.value = target


class ReadinessPublication(unittest.TestCase):
    def test_active_retry_does_not_wait_for_the_next_metrics_poll(self):
        self.exercise("valid", True)

    def test_foreign_terminal_cannot_unlock_retry(self):
        self.exercise("foreign-terminal", False)

    def test_cancelled_worker_cannot_unlock_retry(self):
        self.exercise("cancelled", False)

    def exercise(self, mode, expected_pass):
        temporary_root = ROOT / ".context"
        temporary_root.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="readiness-publication-", dir=temporary_root) as directory:
            base = Path(directory)
            data = base / "primary/data"
            tmp = base / "primary/tmp"
            data.mkdir(parents=True)
            tmp.mkdir()
            fake = base / "fake"
            markers = fake / "markers"
            markers.mkdir(parents=True)
            output = base / "controller/.context/fleet/runs/current/autoscaler-worker-never-ready"
            output.mkdir(parents=True)
            token, failed, ready = "readiness-replay", "failed00000001", "ready000000002"
            (output / "runtime-evidence.owner.json").write_text(json.dumps({"run_token": token}))
            (output / "worker-clones.ids").write_text(failed + "\n")
            (output / "worker-ready.ids").touch()
            (markers / ("worker-launch-succeeded-" + failed)).touch()
            (fake / "worker-never-ready").touch()
            (fake / "worker-readiness-retry").touch()
            state = {"machines": [{"id": failed}]}
            (tmp / "rb.sh").write_text(
                f"export CLOUDBENCH_RUN_TOKEN={token}\n"
                f"export REF={'a' * 40}\n"
                "export BENCH_TASKS_B64=" + base64.b64encode(b"autoscaler-worker-never-ready").decode() + "\n"
            )
            provenance = runpy.run_path(str(ROOT / "scripts/cloudbench_execution_provenance.py"))
            snapshot = base / "snapshot"
            snapshot.mkdir()
            (snapshot / "file").write_text("readiness fixture\n")
            expected = provenance["build_provenance"](
                base_sha="a" * 40, workspace_patch_sha256="none",
                snapshot_manifest=provenance["build_snapshot_manifest"](snapshot),
                config=provenance["build_config"](provenance["CONFIG_SCHEMA_VERSION"], ["app=fixture"]),
            )
            (base / "primary/cloudbench-execution-provenance.json").write_text(json.dumps(expected))
            shutil.copyfile(ROOT / "scripts/cloudbench_execution_provenance.py", base / "primary/cloudbench-execution-provenance.py")

            def retire():
                capture = output / f"worker-runtime-evidence/{failed}/capture/receipts"
                capture.mkdir(parents=True)
                (capture / "terminal.json").write_text(json.dumps({
                    "run_token": "foreign" if mode == "foreign-terminal" else token,
                    "machine_id": failed, "quiescent": True,
                    "children_reaped": True, "streams_closed": True,
                }))
                (output / f"worker-{failed}.stage.log").write_text("worker did not reach queue readiness within 5s\n")
                state["machines"] = []
                (output / "worker-clones.ids").write_text(ready + "\n")
                if mode == "cancelled":
                    (output / f"worker-{ready}.cancelled").touch()

            helpers = "\n".join(function(name) for name in (
                "worker_ledger_lock_acquire", "worker_ledger_lock_release",
                "worker_is_tracked", "reconcile_worker_ready_outcomes",
            ))
            start = FLEET.index("      publish_worker_ready() {")
            publish = FLEET[start:FLEET.index("      log_worker_stage() {", start)]

            def shell(action):
                script = ("set -eu\n" + helpers + "\n" + publish + "\n"
                          + "out=" + shlex.quote(str(output)) + "\nwid=" + ready + "\n"
                          + action)
                result = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=5)
                self.assertEqual(result.returncode, 0, result.stderr)

            clock = Clock()
            # Capture/reap completes at 22; replacement is queue-ready at 27.
            # The next normal ten-second aggregate poll is at 32. The consumer's
            # original shared deadline is 30, so delayed publication loses real
            # readiness even though it happened in time. No task result is fed in.
            clock.events = [(22.0, retire), (27.0, lambda: shell("publish_worker_ready\n")),
                            (32.0, lambda: shell('reconcile_worker_ready_outcomes "$out"\n'))]

            class State:
                def __enter__(self):
                    return state

                def __exit__(self, *unused):
                    return False

            fake_source = SOURCE.split('cat > "$FAKE_DIR/flyctl.py" <<\'PY\'\n', 1)[1].split("\nPY\n", 1)[0]
            nodes = [node for node in ast.parse(fake_source).body if isinstance(node, ast.FunctionDef)
                     and node.name in {"rb_export", "run_fake_driver"}]
            self.assertEqual(len(nodes), 2)
            fake_os = SimpleNamespace(path=os.path, environ={"CLOUDBENCH_FAKE_CONTROLLER_WS": str(base / "controller")},
                                      makedirs=os.makedirs, remove=os.remove, listdir=os.listdir)
            namespace = dict(os=fake_os, Path=Path, PurePosixPath=PurePosixPath, re=re, json=json,
                             glob=glob, subprocess=subprocess, sys=sys, time=clock,
                             FAKE_DIR=str(fake), MARKERS=str(markers), locked_state=State,
                             find_machine=lambda current, mid: next((m for m in current["machines"] if m["id"] == mid), None))
            exec(compile(ast.Module(body=nodes, type_ignores=[]), str(ROOT / "scripts/tests/cloudbench-multi-workstream.test.sh"), "exec"), namespace)
            namespace["run_fake_driver"](str(base / "primary"))
            run = json.loads((data / "repo/.context/cloudbench/run.json").read_text())
            self.assertEqual(provenance["validate_run_provenance"](run, expected), [])
            self.assertIs(run["tasks"][0]["passed"], expected_pass,
                          "FAIL: readiness active-retry must preserve completed task and exact worker retirement")
            self.assertEqual(run["summary"]["passed"], int(expected_pass))
            self.assertEqual((markers / "worker-readiness-retry-proven").exists(), expected_pass)
            self.assertEqual(state["machines"], [])


class NativeCaller(unittest.TestCase):
    def run_case(self, mode):
        output = ROOT / ".context"
        output.mkdir(exist_ok=True)
        base = Path(tempfile.mkdtemp(prefix=mode + "-", dir=output))
        self.addCleanup(shutil.rmtree, base)
        out = base / "worker"
        out.mkdir()
        wid = "a353ce91385e4c"
        (out / "worker-clones.ids").write_text(wid + "\n")
        (out / "worker-ready.ids").touch()
        (out / f"worker-{wid}.pending").touch()
        (out / f"worker-{wid}.launch-attempted").touch()
        (out / "wrapper").touch()
        (out / "worker.env").touch()
        owner = out / "worker-runtime-evidence" / wid
        owner.mkdir(parents=True)
        (owner / "owner.json").write_text(json.dumps({"machine_id": wid, "run_token": "test-run"}))
        if mode == "lock-timeout":
            lock = out / "worker-clones.ids.lock"
            lock.mkdir()
            (lock / "owner").write_text(f"{os.getpid()} held-by-test {int(time.time())}\n")
        if mode == "cancelled":
            (out / f"worker-{wid}.cancelled").touch()
        if mode == "foreign-ready":
            (out / "worker-foreign.ready").touch()
        names = ["worker_is_tracked", "worker_ledger_lock_acquire", "worker_ledger_lock_release",
                 "reconcile_worker_ready_outcomes", "cleanup_failed_worker"]
        helpers = "\n".join(function(name) for name in names)
        start = FLEET.index("      worker_provision_cancelled() {")
        helpers += "\n" + FLEET[start:FLEET.index("      launched=0", start)]
        start = FLEET.index("      ready_deadline=$((SECONDS + worker_ready_timeout))")
        caller = FLEET[start:FLEET.index("\n    ) &", start)]
        script = "set -uo pipefail\n" + helpers + "\n" + r'''
out="$1"; wid="$2"; case_mode="$3"; bench=fixture; ws=fixture
wrapper="$out/wrapper"; worker_env="$out/worker.env"
stage_log="$out/worker-$wid.stage.log"; launched=1; worker_ready_timeout=5
# Fail precisely the first aggregate append, including when the test runs as
# root. Other fixture writes and subsequent cleanup remain real filesystem I/O.
ready_append_failed=0
printf() {
    if [ "$case_mode" = write-failure ] && [ "$ready_append_failed" = 0 ] \
        && [ "${1:-}" = '%s\n' ] && [ "${2:-}" = "$wid" ]; then
        ready_append_failed=1
        builtin printf '%s\n' 'injected ready-ledger append failure' >&2
        return 1
    fi
    builtin printf "$@"
}
worker_operational() { return 0; }
fleet_current_disposable_registry() { return 1; }
fleet_registry_volume_for_id() { printf 'owned-volume'; }
cloudbench_preserve_unlaunched_worker() { return 1; }
cloudbench_capture_worker_runtime_evidence() {
    test -f "$out/worker-runtime-evidence/$wid/owner.json" || return 1
    printf '%s\n' "$wid" > "$out/capture.called"
}
reap_machine() {
    test "$1" = "$wid" && test "$3" = owned-volume || return 1
    test -s "$out/capture.called" || return 1
    printf '%s\n' "$1" > "$out/reap.called"
}
fleet_audit_update_fresh_clone_by_id() { return 0; }
fleet_registry_release_id() { printf '%s\n' "$1" > "$out/release.called"; }
''' + caller
        (base / "caller.sh").write_text(script)
        start_time = time.monotonic()
        result = subprocess.run(["bash", str(base / "caller.sh"), str(out), wid, mode],
                                capture_output=True, text=True, timeout=45)
        row = {"mode": mode, "exit": result.returncode, "elapsed_seconds": time.monotonic()-start_time,
               "pending": (out / f"worker-{wid}.pending").exists(),
               "tracked": (out / "worker-clones.ids").read_text().splitlines(),
               "ready": (out / "worker-ready.ids").read_text().splitlines(),
               "failure": (out / f"worker-{wid}.failed").read_text() if (out / f"worker-{wid}.failed").exists() else "",
               "captured": (out / "capture.called").exists(), "reaped": (out / "reap.called").exists(),
               "stdout": result.stdout, "stderr": result.stderr}
        print("NATIVE_CALLER_RESULT " + json.dumps(row), flush=True)
        if mode == "lock-timeout":
            self.assertIn("timed out acquiring worker ledger lock", result.stderr)
        self.assertNotIn("command not found", result.stderr)
        self.assertNotIn("unbound variable", result.stderr)
        return row

    def test_lock_timeout_does_not_publish_success(self):
        row = self.run_case("lock-timeout")
        self.assertNotEqual(row["exit"], 0, "failed readiness publication must not report native provisioner success")
        self.assertTrue(row["pending"], "unreconciled ownership must remain pending")
        self.assertTrue(row["tracked"])
        self.assertFalse(row["ready"])
        self.assertNotIn("joined queue", row["stdout"])
        self.assertTrue(row["failure"])

    def test_io_failure_retires_only_after_capture(self):
        row = self.run_case("write-failure")
        self.assertNotEqual(row["exit"], 0, "failed readiness publication must not report native provisioner success")
        self.assertNotIn("joined queue", row["stdout"])
        self.assertTrue(row["captured"] and row["reaped"])
        self.assertFalse(row["tracked"] or row["ready"] or row["pending"])

    def test_healthy_and_foreign_ready(self):
        for mode in ["healthy", "foreign-ready"]:
            row = self.run_case(mode)
            self.assertEqual(row["exit"], 0)
            self.assertEqual(row["ready"], row["tracked"])
            self.assertFalse(row["pending"])
            self.assertFalse(row["reaped"])

    def test_cancelled_cleans_without_success_message(self):
        row = self.run_case("cancelled")
        self.assertEqual(row["exit"], 0)
        self.assertNotIn("joined queue", row["stdout"])
        self.assertTrue(row["captured"] and row["reaped"])
        self.assertFalse(row["tracked"] or row["ready"] or row["pending"])


if __name__ == "__main__":
    unittest.main()
