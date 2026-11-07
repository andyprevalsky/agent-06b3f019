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


if __name__ == "__main__":
    unittest.main()
