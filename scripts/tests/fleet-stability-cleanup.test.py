#!/usr/bin/env python3
"""Actual proof supervisor versus isolated external fleet/recovery commands."""

from __future__ import annotations

from contextlib import ExitStack
import json
import os
from pathlib import Path
import runpy
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]

FIXTURE_PROCESS = runpy.run_path(str(ROOT / "scripts/tests/fixture_process.py"))
NATIVE_COMPLETION = runpy.run_path(str(ROOT / "scripts/tests/native_completion_schedule.py"))
BASH = shutil.which("bash") or "bash"
if Path("/opt/homebrew/bin/bash").exists():
    BASH = "/opt/homebrew/bin/bash"

FLEET = r"""#!/usr/bin/env bash
set -euo pipefail
exec python3 - "$@" <<'PYCLI'
import json, os, pathlib, shutil, signal, subprocess, sys, time
root = pathlib.Path.cwd()
owner = os.environ['CLOUDBENCH_FLEET_OWNER_TOKEN']
registry = root / '.git/cloudbench-fleet-ownership' / owner
registry.mkdir(parents=True)
birth = subprocess.check_output(['ps','-p',str(os.getpid()),'-o','lstart='],text=True).strip()
meta={'owner':owner,'pid':os.getpid(),'birth':birth}
if os.environ.get('FIXTURE_DESCENDANT')=='1':
    child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(1)'])
    meta['child_pid']=child.pid
    meta['child_birth']=subprocess.check_output(['ps','-p',str(child.pid),'-o','lstart='],text=True).strip()
(registry / 'meta').write_text(json.dumps(meta))
(registry / 'machine').write_text('allocated\n')
run = pathlib.Path(os.environ['CLOUDBENCH_RUNS_ROOT']) / ('fake-' + os.environ['FLEET_STABILITY_SLICE'])
(run / '_batch').mkdir(parents=True)
names=[]
for arg in sys.argv[1:]:
    if arg.startswith('--'): break
    names.append(arg)
(run/'_batch/run.json').write_text(json.dumps({'tasks':[{'name':name,'status':'FAILED','passed':False} for name in names]}))
(run/'_batch/lifecycle.json').write_text(json.dumps({'version':1,'status':'failed','controller_exit_code':1,'fleet_owner_token':owner,'run_id':run.name,'workspace_root':str(root),'audit_sha256':''}))
with (root/'calls').open('a') as f: f.write('fleet ' + owner + '\n')
print('🔏 execution provenance: '+str(run/'execution-provenance.json'), flush=True)
(root/'ready').write_text(owner)
fault=os.environ.get('FIXTURE_ORPHAN_AUDIT')
if fault:
    shutil.rmtree(registry)
    audit=root/'.git/cloudbench-fleet-audits'/owner
    audit.parent.mkdir(parents=True)
    if fault=='dangling': audit.symlink_to(root/'missing-audit',target_is_directory=True)
    else:
        audit.mkdir()
        (audit/'meta').write_text('fleet_owner_token='+owner+'\nstatus=provider-teardown-verified\n')
if os.environ.get('FIXTURE_CANCEL') == '1':
    def stop(*args):
        time.sleep(.2)
        raise SystemExit(143)
    signal.signal(signal.SIGTERM, stop)
    while True: time.sleep(.05)
raise SystemExit(int(os.environ.get('FIXTURE_FLEET_EXIT','1')))
PYCLI
"""
RECOVERY = r"""#!/usr/bin/env bash
set -euo pipefail
exec python3 - "$@" <<'PYCLI'
import hashlib, json, os, pathlib, shutil, subprocess, sys
root = pathlib.Path.cwd()
assert sys.argv[1] == '--recover-stale-owner' and len(sys.argv) == 3
owner = sys.argv[2]
registry = root / '.git/cloudbench-fleet-ownership' / owner
meta=json.loads((registry/'meta').read_text())
assert meta['owner']==owner
observed=subprocess.run(['ps','-p',str(meta['pid']),'-o','lstart='],text=True,capture_output=True)
assert observed.stdout.strip()!=meta['birth'], 'recovery raced live fleet producer'
if meta.get('child_pid'):
    child=subprocess.run(['ps','-p',str(meta['child_pid']),'-o','lstart='],text=True,capture_output=True)
    assert child.stdout.strip()!=meta['child_birth'], 'recovery raced owned descendant'
for receipt in (root/'proofs').glob('*/slice-*.cleanup.json'):
    data=json.loads(receipt.read_text())
    if data.get('fleet_owner_token')==owner:
        assert data.get('process_group_drained') is True
        assert data.get('status')=='running'
        assert data.get('group_token') and data.get('pid_start')
        break
else: raise AssertionError('missing exact owner/group cleanup receipt')
summary=json.loads(next((root/'proofs').glob('*/summary.json')).read_text())
assert summary.get('finished_at') is None, 'proof finalized before provider recovery'
with (root/'calls').open('a') as f: f.write('recovery '+owner+'\n')
if os.environ.get('FIXTURE_RECOVERY_FAIL')=='1': raise SystemExit(1)
if os.environ.get('FIXTURE_FALSE_ACK')=='1': raise SystemExit(0)
shutil.rmtree(registry)
audit=root/'.git/cloudbench-fleet-audits'/owner
audit.mkdir(parents=True)
run=next(path for path in (root/'proofs').glob('*/runs/*') if json.loads((path/'_batch/lifecycle.json').read_text())['fleet_owner_token']==owner)
(audit/'meta').write_text('version=1\nfleet_owner_token='+owner+'\nstatus=provider-teardown-verified\napp=fixture\nworkspace_root='+str(root)+'\nrun_id='+run.name+'\n')
mirror=run/'teardown-ownership'
shutil.copytree(audit,mirror)
digest=hashlib.sha256()
for item in sorted(audit.rglob('*'),key=lambda x:str(x.relative_to(audit))):
    if item.is_file():
        relative,data=str(item.relative_to(audit)).encode(),item.read_bytes()
        digest.update(len(relative).to_bytes(8,'big'));digest.update(relative)
        digest.update(len(data).to_bytes(8,'big'));digest.update(data)
(mirror/'source-audit').write_text('path='+str(audit)+'\nsha256='+digest.hexdigest()+'\n')
PYCLI
"""


class FleetFailureCleanup(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="fleet-proof-cleanup-"))
        self.addCleanup(self.finish_fixture)
        for relative in (
            "scripts/run-fleet-infra-stability-proof",
            "scripts/fleet_infra_sample.py",
            "scripts/cloudbench_catalog.py",
            "scripts/lib/cloudbench-env.sh",
        ):
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, path)
        catalog = self.root / "agents/benchmarks/tasks.json"
        catalog.parent.mkdir(parents=True)
        catalog.write_text(json.dumps([{"name": "fixture-task", "status": "ready"}]))
        catalog.with_name("polar_tasks.json").write_text(json.dumps([{"name": "polar-fixture", "status": "ready"}]))
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        unrelated = self.root / ".git/cloudbench-fleet-ownership" / "unrelated"
        unrelated.mkdir(parents=True)
        (unrelated / "machine").write_text("leave untouched\n")
        (self.root / "fake-fleet").write_text(FLEET)
        (self.root / "fake-recovery").write_text(RECOVERY)
        self.env = os.environ.copy()
        self.env.update(
            FLEET_INFRA_PROOF_FLEET_BIN=str(self.root / "fake-fleet"),
            FLEET_INFRA_PROOF_RECOVERY_BIN=str(self.root / "fake-recovery"),
            FLEET_INFRA_PROOF_STATE_ROOT=str(self.root / "proofs"),
            FLEET_INFRA_PROOF_ARTIFACT_DIR=str(self.root / "artifacts"),
            BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS="300",
        )

    def finish_fixture(self):
        result = self._outcome.result if self._outcome is not None else None
        failed = result is None or any(
            test is self or getattr(test, "test_case", None) is self
            for test, _ in list(result.errors) + list(result.failures)
        )
        if not failed:
            shutil.rmtree(self.root)
            return
        # mkdtemp deliberately has no destructor: a failed archival operation
        # must leave the original evidence available for diagnosis.
        artifact_root = Path(os.environ.get("BLACKBOX_TEST_ARTIFACT_DIR", str(ROOT / ".context/test-runs")))
        artifact_root.mkdir(parents=True, exist_ok=True)
        retained = Path(tempfile.mkdtemp(prefix=f"fleet-proof-{self._testMethodName}-", dir=artifact_root))
        shutil.move(str(self.root), str(retained / "fixture"))
        print(f"Retained failed fleet fixture: {retained}", file=sys.stderr)

    def wait_for_proof(self, process, timeout_seconds, native_schedule=None):
        if native_schedule is None:
            return process.wait(timeout=timeout_seconds)
        primary_error = None
        try:
            return native_schedule.wait(process, timeout_seconds)
        except BaseException as error:
            primary_error = error
            raise
        finally:
            try:
                (self.root / "native-completion-reads.json").write_text(json.dumps({
                    "expected_frame_hex": native_schedule.expected_frame.hex(),
                    "hold_seconds": native_schedule.hold_seconds,
                    "triggered": native_schedule.triggered,
                    "reads": native_schedule.reads,
                }, indent=2) + "\n")
            except OSError as metadata_error:
                if primary_error is None:
                    raise
                primary_error.add_note(f"Native scheduling metadata capture failed: {metadata_error!r}")

    def run_completion_proof(self, command, *, timeout_seconds=60, native_schedule=None):
        log_path = self.root / "output.log"
        metadata_path = self.root / "command.json"
        metadata = {"command": command, "timeout_seconds": timeout_seconds, "status": "starting"}
        metadata_path.write_text(json.dumps(metadata))
        with log_path.open("w") as log:
            launch = subprocess.Popen if native_schedule is None else native_schedule.launch
            process = launch(
                command, cwd=self.root, env=self.env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
            )
            primary_error = None
            try:
                metadata.update(pid=process.pid, status="running")
                metadata_path.write_text(json.dumps(metadata))
                result = self.wait_for_proof(process, timeout_seconds, native_schedule)
            except BaseException as error:
                primary_error = error
                metadata["status"] = "timeout" if isinstance(error, subprocess.TimeoutExpired) else "error"
                try:
                    with ExitStack() as cleanup:
                        cleanup.callback(process.wait, timeout=60)
                        cleanup.callback(lambda: process.kill() if process.poll() is None else None)
                        drained = FIXTURE_PROCESS["terminate_fixture_tree"](process)
                        metadata["cleanup"] = "captured-tree-drained" if drained else "unverified-root-exited"
                except BaseException as cleanup_error:
                    metadata["cleanup"] = repr(cleanup_error)
                    error.add_note(f"Fixture cleanup failed: {cleanup_error!r}")
                    raise error from cleanup_error
                raise
            finally:
                metadata["returncode"] = process.poll()
                if metadata["status"] == "running":
                    metadata["status"] = "exited"
                try:
                    metadata_path.write_text(json.dumps(metadata))
                except OSError as metadata_error:
                    if primary_error is None:
                        raise
                    primary_error.add_note(f"Fixture metadata capture failed: {metadata_error!r}")
        return subprocess.CompletedProcess(command, result, log_path.read_text(), "")

    def finish_native_error_control(self, process):
        # A failing before-code poll may have cached a ptrace stop as exit.
        # Reap only this newly created child using native terminal statuses.
        try:
            waited, status = os.waitpid(process.pid, os.WNOHANG)
        except ChildProcessError:
            return
        if waited and (os.WIFEXITED(status) or os.WIFSIGNALED(status)):
            process.returncode = os.waitstatus_to_exitcode(status)
            return
        try:
            os.kill(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            try:
                waited, status = os.waitpid(process.pid, os.WNOHANG)
            except ChildProcessError:
                return
            if waited:
                if os.WIFEXITED(status) or os.WIFSIGNALED(status):
                    process.returncode = os.waitstatus_to_exitcode(status)
                    return
                if os.WIFSTOPPED(status):
                    try:
                        NATIVE_COMPLETION["ptrace"](7, process.pid, 0, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            time.sleep(.001)
        self.fail("native error-control root did not reach a terminal reap")

    def native_error_control(self, *, during_metadata):
        ready = self.root / "native-child-ready.json"
        script = r"""
import json, pathlib, runpy, subprocess, sys, time
identity = runpy.run_path(sys.argv[1])
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(600)'], start_new_session=True)
ready = pathlib.Path(sys.argv[2]); pending = ready.with_suffix('.tmp')
pending.write_text(json.dumps({'pid': child.pid, 'identity': identity['current_identity'](child.pid)})); pending.replace(ready)
while True: time.sleep(1)
"""
        command = [sys.executable, "-c", script, str(ROOT / "scripts/process-identity.py"), str(ready)]
        schedule = NATIVE_COMPLETION["CompletionReadSchedule"]()
        native_globals = schedule.wait.__func__.__globals__
        real_ptrace = native_globals["ptrace"]
        real_popen = subprocess.Popen
        real_write = Path.write_text
        fault = OSError("injected native metadata failure" if during_metadata else "injected scheduler failure")
        created = []
        foreign = real_popen([sys.executable, "-c", "import time; time.sleep(600)"])

        def launch(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            if kwargs.get("preexec_fn") is not None:
                created.append(process)
            return process

        def write_metadata(path, value, *args, **kwargs):
            if during_metadata and path == self.root / "command.json" and json.loads(value)["status"] == "running":
                raise fault
            return real_write(path, value, *args, **kwargs)

        def native_operation(request, pid, address=0, data=0):
            if not during_metadata and ready.exists():
                if request == 24:
                    raise fault
                if request == 17:
                    raise OSError("injected detach failure")
            return real_ptrace(request, pid, address, data)

        try:
            with (
                patch.object(subprocess, "Popen", side_effect=launch),
                patch.object(Path, "write_text", write_metadata),
                patch.dict(native_globals, {"ptrace": native_operation}),
                self.assertRaises(OSError) as raised,
            ):
                self.run_completion_proof(command, native_schedule=schedule)
            self.assertEqual(len(created), 1, "scheduler traced more than its exact root")
            self.assertIs(raised.exception, fault, "trace cleanup replaced the initiating exception")
            self.assertIsNotNone(created[0].returncode, "native root has no observed terminal status")
            with self.assertRaises(ChildProcessError, msg="native root was not actually reaped"):
                os.waitpid(created[0].pid, os.WNOHANG)
            if not during_metadata:
                self.assertTrue(ready.exists(), "scheduler failure did not reach a real detached child")
                child = json.loads(ready.read_text())
                observed = subprocess.run(["ps", "-p", str(child["pid"]), "-o", "stat="], capture_output=True, text=True)
                self.assertTrue(not observed.stdout.strip() or observed.stdout.strip().startswith("Z"),
                                "native scheduler failure left its detached child alive")
            self.assertIsNone(foreign.poll(), "native trace cleanup signalled an unrelated control")
        finally:
            for process in created:
                self.finish_native_error_control(process)
            if ready.exists():
                child = json.loads(ready.read_text())
                FIXTURE_PROCESS["load_process_identity"]().main([
                    "process-identity.py", "--expect", child["identity"], "--signal", "KILL", str(child["pid"]),
                ])
            foreign.terminate()
            foreign.wait(timeout=2)

    @unittest.skipUnless(NATIVE_COMPLETION["SUPPORTED"], "native syscall schedule requires Linux x86_64")
    def test_native_metadata_failure_reaps_stopped_root(self):
        self.native_error_control(during_metadata=True)

    @unittest.skipUnless(NATIVE_COMPLETION["SUPPORTED"], "native syscall schedule requires Linux x86_64")
    def test_native_scheduler_failure_reaps_root_and_detached_child(self):
        self.native_error_control(during_metadata=False)

    @unittest.skipUnless(NATIVE_COMPLETION["SUPPORTED"], "native syscall schedule requires Linux x86_64")
    def test_native_initial_terminal_status_is_retained(self):
        schedule = NATIVE_COMPLETION["CompletionReadSchedule"]()
        process = schedule.launch([sys.executable, "-c", "import time; time.sleep(600)"], start_new_session=True)
        try:
            os.kill(process.pid, signal.SIGKILL)
            time.sleep(.02)
            self.assertEqual(schedule.wait(process, 2), -signal.SIGKILL)
            self.assertEqual(process.poll(), -signal.SIGKILL)
            with self.assertRaises(ChildProcessError):
                os.waitpid(process.pid, os.WNOHANG)
        finally:
            self.finish_native_error_control(process)

    def test_timeout_reaps_detached_child_and_retains_output(self):
        identity = FIXTURE_PROCESS["load_process_identity"]()
        ready = self.root / "detached-ready.json"
        script = r"""
import json, pathlib, runpy, subprocess, sys, time
identity = runpy.run_path(sys.argv[1])
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(600)'], start_new_session=True)
ready = pathlib.Path(sys.argv[2])
pending = ready.with_suffix('.tmp')
pending.write_text(json.dumps({'pid': child.pid, 'identity': identity['current_identity'](child.pid)}))
pending.replace(ready)
print('fixture output before timeout', flush=True)
time.sleep(600)
"""
        foreign = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])
        try:
            with self.assertRaises(subprocess.TimeoutExpired):
                self.run_completion_proof(
                    [sys.executable, "-c", script, str(ROOT / "scripts/process-identity.py"), str(ready)],
                    timeout_seconds=8,
                )
            captured = json.loads(ready.read_text())
            state = subprocess.run(
                ["ps", "-p", str(captured["pid"]), "-o", "stat="], capture_output=True, text=True
            )
            self.assertTrue(
                not state.stdout.strip() or state.stdout.strip().startswith("Z"),
                "timed-out fixture left its detached child alive",
            )
            self.assertIsNone(foreign.poll(), "unrelated process was signalled")
            self.assertIn("fixture output before timeout", (self.root / "output.log").read_text())
        finally:
            with ExitStack() as cleanup:
                cleanup.callback(foreign.wait, timeout=2)
                cleanup.callback(foreign.terminate)
                if ready.exists():
                    captured = json.loads(ready.read_text())
                    identity.main(
                        ["process-identity.py", "--expect", captured["identity"], "--signal", "KILL", str(captured["pid"])]
                    )

    def test_failed_case_retains_its_inner_evidence(self):
        with tempfile.TemporaryDirectory(prefix="fleet-fixture-retention-control-") as directory:
            inner = FleetFailureCleanup("runTest")

            def fail_with_evidence():
                (inner.root / "inner-output.log").write_text("original failure evidence\n")
                inner.fail("injected fixture failure")

            inner.runTest = fail_with_evidence
            result = unittest.TestResult()
            with patch.dict(os.environ, {"BLACKBOX_TEST_ARTIFACT_DIR": directory}):
                inner.run(result)
            self.assertEqual(len(result.failures), 1)
            retained = list(Path(directory).rglob("inner-output.log"))
            self.assertEqual(len(retained), 1, "failed unittest deleted its inner evidence")
            self.assertEqual(retained[0].read_text(), "original failure evidence\n")

    def test_completion_runner_preserves_failure_and_joins_owned_root(self):
        for scenario in ("post_spawn_metadata", "rejected_ancestry", "exited_root", "final_metadata"):
            with self.subTest(scenario=scenario):
                writes = []
                calls = []

                class Process:
                    pid = 999991
                    returncode = None

                    def poll(self):
                        return self.returncode

                    def wait(self, timeout):
                        calls.append(("wait", timeout))
                        if self.returncode is not None:
                            return self.returncode
                        if scenario == "exited_root":
                            self.returncode = 0
                        raise subprocess.TimeoutExpired(["synthetic-fixture"], timeout)

                    def kill(self):
                        calls.append(("kill",))
                        self.returncode = -9

                process = Process()
                real_write = Path.write_text
                real_cleanup = FIXTURE_PROCESS["terminate_fixture_tree"]

                def write_metadata(path, value, *args, **kwargs):
                    if path == self.root / "command.json":
                        writes.append(json.loads(value))
                        if (scenario == "post_spawn_metadata" and len(writes) == 2) or (
                            scenario == "final_metadata" and len(writes) == 3
                        ):
                            raise OSError("injected metadata write failure")
                    return real_write(path, value, *args, **kwargs)

                def cleanup(value):
                    self.assertIs(value, process)
                    calls.append(("cleanup",))
                    if scenario == "rejected_ancestry":
                        raise AssertionError("injected uncertain ancestry")
                    if scenario == "exited_root":
                        return real_cleanup(value)
                    value.kill()
                    return True

                error_type = OSError if scenario == "post_spawn_metadata" else subprocess.TimeoutExpired
                with (
                    patch.object(subprocess, "Popen", return_value=process),
                    patch.object(Path, "write_text", write_metadata),
                    patch.dict(FIXTURE_PROCESS, {"terminate_fixture_tree": cleanup}),
                    self.assertRaises(error_type) as raised,
                ):
                    self.run_completion_proof(["synthetic-fixture"])
                self.assertIsNotNone(process.poll(), "failure abandoned the owned root")
                self.assertEqual(calls[-1], ("wait", 60), "failure did not finally join the owned root")
                self.assertIn(("cleanup",), calls)
                if scenario == "exited_root":
                    self.assertEqual(writes[-1]["cleanup"], "unverified-root-exited")
                    self.assertNotIn(("kill",), calls)
                elif scenario == "rejected_ancestry":
                    self.assertIn("uncertain ancestry", writes[-1]["cleanup"])
                    self.assertIn("Fixture cleanup failed", " ".join(raised.exception.__notes__))
                elif scenario == "final_metadata":
                    self.assertIn("metadata capture failed", " ".join(raised.exception.__notes__))

    def inject_local_status_publication_failure(self):
        with (self.root / "scripts/lib/cloudbench-env.sh").open("a") as handle:
            handle.write(r"""
printf() {
  # Fail only the existing local publication writers. Identity normalization
  # also uses %s\\n and must keep observing the real native process state.
  case "${FUNCNAME[1]:-main}:$1" in
    'main:pid=%s\npid_start=%s\n'|'run_owned_proof_slice:pid=%s\npid_start=%s\n'|'main:%s\n')
      return 1 ;;
  esac
  builtin printf "$@"
}
""")

    def test_local_status_publication_fault_preserves_live_identity(self):
        self.inject_local_status_publication_failure()
        result = subprocess.run(
            [BASH, "-c", 'source "$1"; birth="$(cloudbench_pid_start_time "$$")"; '
             'cloudbench_pid_birth_state "$$" "$birth"',
             "identity-fault-test", str(self.root / "scripts/lib/cloudbench-env.sh")],
            cwd=self.root, env=self.env, capture_output=True, text=True, timeout=3,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "live", "publication fault corrupted live identity observation")

    def run_case(
        self,
        *,
        cancel=False,
        recovery_fail=False,
        fleet_exit=1,
        false_ack=False,
        descendant=False,
        malformed_identity=False,
        audit_fault="",
        unknown_body_probe=False,
        log_fault="",
        publication_failure=False,
        partial_completion=False,
        native_schedule=None,
    ):
        env = dict(
            self.env,
            FIXTURE_CANCEL=str(int(cancel)),
            FIXTURE_RECOVERY_FAIL=str(int(recovery_fail)),
            FIXTURE_FLEET_EXIT=str(fleet_exit),
            FIXTURE_FALSE_ACK=str(int(false_ack)),
            FIXTURE_DESCENDANT=str(int(descendant)),
            FIXTURE_ORPHAN_AUDIT=audit_fault,
        )
        if partial_completion:
            self.inject_partial_completion_read()
        if publication_failure:
            self.inject_local_status_publication_failure()
        if unknown_body_probe:
            fake_bin = self.root / "bin"
            fake_bin.mkdir()
            ps = fake_bin / "ps"
            ps.write_text(
                "#!/usr/bin/env python3\n"
                + r"""import os, pathlib, sys
root=pathlib.Path(os.environ['FIXTURE_ROOT'])
marker=root/'unknown-probe'
if len(sys.argv)==5 and sys.argv[1]=='-p' and (root/'ready').exists() and not marker.exists():
    for path in (root/'proofs').glob('*/controller.owner'):
        fields=dict(line.split('=',1) for line in path.read_text().splitlines())
        if fields.get('pid')==sys.argv[2]:
            marker.write_text('injected transient ps failure\n')
            raise SystemExit(2)
os.execv(os.environ['FIXTURE_REAL_PS'],[os.environ['FIXTURE_REAL_PS'],*sys.argv[1:]])
"""
            )
            ps.chmod(0o700)
            env.update(
                PATH=str(fake_bin) + os.pathsep + env["PATH"],
                FIXTURE_REAL_PS=shutil.which("ps"),
                FIXTURE_ROOT=str(self.root),
            )
        if log_fault:
            fake_bin = self.root / "bin"
            fake_bin.mkdir(exist_ok=True)
            tee = fake_bin / "tee"
            tee.write_text(r"""#!/usr/bin/env bash
case "$1" in
  */slice-*.log)
    if [ "$FIXTURE_LOG_FAULT" = slice ]; then head -n 1 >/dev/null; exit 1; fi
    ;;
  *)
    if [ "$FIXTURE_LOG_FAULT" = summary ]; then
      while [ ! -f "$FIXTURE_ROOT/ready" ]; do sleep .02; done
      exit 1
    fi
    ;;
esac
exec "$FIXTURE_REAL_TEE" "$@"
""")
            tee.chmod(0o700)
            env.update(
                PATH=str(fake_bin) + os.pathsep + env["PATH"],
                FIXTURE_REAL_TEE=shutil.which("tee"),
                FIXTURE_ROOT=str(self.root),
                FIXTURE_LOG_FAULT=log_fault,
            )
        command = [
            BASH,
            str(self.root / "scripts/run-fleet-infra-stability-proof"),
            "--capability",
            "--runs",
            "2",
            "--width",
            "1",
            "--timeout",
            "300",
        ]
        with (self.root / "output.log").open("w") as log:
            launch = subprocess.Popen if native_schedule is None else native_schedule.launch
            process = launch(
                command, cwd=self.root, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
            )
            try:
                if cancel:
                    deadline = time.monotonic() + 60
                    while not (self.root / "ready").exists() and time.monotonic() < deadline and process.poll() is None:
                        time.sleep(0.02)
                    self.assertTrue((self.root / "ready").exists(), (self.root / "output.log").read_text())
                    process.send_signal(signal.SIGTERM)
                try:
                    result = self.wait_for_proof(process, 60, native_schedule)
                except subprocess.TimeoutExpired:
                    self.fail(
                        "proof supervisor did not finish its owned cleanup\n" + (self.root / "output.log").read_text()
                    )
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                # Before-code control can orphan only this fixture's child group.
                for path in (self.root / "proofs").glob("*/slice-*.owner"):
                    fields = dict(line.split("=", 1) for line in path.read_text().splitlines() if "=" in line)
                    pid = fields.get("pid", "")
                    birth = subprocess.run(["ps", "-p", pid, "-o", "lstart="], text=True, capture_output=True)
                    expected_birth = " ".join(fields.get("pid_start", "").split())
                    if pid and expected_birth and birth.returncode == 0 and " ".join(birth.stdout.split()) == expected_birth:
                        try:
                            os.killpg(int(fields["pgid"]), signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                for path in (self.root / ".git/cloudbench-fleet-ownership").glob("*/meta"):
                    fields = json.loads(path.read_text())
                    birth = subprocess.run(
                        ["ps", "-p", str(fields["pid"]), "-o", "lstart="], text=True, capture_output=True
                    )
                    expected_birth = " ".join(fields["birth"].split())
                    if expected_birth and birth.returncode == 0 and " ".join(birth.stdout.split()) == expected_birth:
                        try:
                            os.kill(fields["pid"], signal.SIGKILL)
                        except ProcessLookupError:
                            pass
        output = (self.root / "output.log").read_text()
        self.assertNotEqual(result, 0, output)
        owner = (self.root / "ready").read_text()
        calls = (self.root / "calls").read_text().splitlines()
        self.assertEqual(calls.count("fleet " + owner), 1, output)
        self.assertEqual(
            calls.count("recovery " + owner),
            0 if malformed_identity or audit_fault else 1,
            "failed proof abandoned exact cleanup obligation\n" + output,
        )
        summary = json.loads(next((self.root / "proofs").glob("*/summary.json")).read_text())
        self.assertEqual(summary["status"], "failed", output)
        self.assertEqual(summary["passed_slices"], 0, output)
        self.assertEqual(len(summary["slices"]), 1, output)
        self.assertEqual(summary["slices"][0]["classification"], "infra", output)
        receipt = json.loads(next((self.root / "proofs").glob("*/slice-*.cleanup.json")).read_text())
        retained = bool(recovery_fail or false_ack or malformed_identity or audit_fault)
        self.assertEqual(receipt["status"], "failed_retained" if retained else "verified", output)
        self.assertEqual(receipt["fleet_owner_token"], owner)
        self.assertEqual(receipt["process_group_drained"], not malformed_identity)
        self.assertEqual(
            (self.root / ".git/cloudbench-fleet-ownership" / owner).exists(), retained and not audit_fault, output
        )
        self.assertEqual(
            (self.root / ".git/cloudbench-fleet-ownership/unrelated/machine").read_text(), "leave untouched\n"
        )
        self.assertEqual(summary["cleanup_status"], receipt["status"])
        self.assertEqual(summary["benchmark_wall_clock_backstop_seconds"], 300)
        if not cancel:
            self.assertEqual(result, fleet_exit, output)

    def inject_partial_completion_read(self):
        # A timed read may consume bytes before returning a timeout/signal.
        # Split the actual producer's frame at that syscall-result boundary.
        helper = self.root / "scripts/lib/cloudbench-env.sh"
        with helper.open("a") as handle:
            handle.write(r"""
read() {
  if [[ "${!#}" == proof_completion_line ]] && [[ -n "${proof_completion_reader:-}" ]] \
    && [[ -z "${fixture_partial_completion:-}" ]]; then
    builtin read -r -N 1 -t 5 -u "$proof_completion_reader" proof_completion_line || return "$?"
    fixture_partial_completion=1
    printf 'fixture consumed completion byte: %s\n' "$proof_completion_line" >&2
    return 142
  fi
  builtin read "$@"
}
""")

    def test_partial_completion_injection_retries_unconsumed_read(self):
        self.inject_partial_completion_read()
        command = r"""
source "$1"
builtin() {
  if [[ "$1" == read ]]; then
    fixture_read_calls=$(( ${fixture_read_calls:-0} + 1 ))
    [[ "$fixture_read_calls" != 1 ]] || return 142
    printf -v "${!#}" '%s' 0
    return 0
  fi
  command builtin "$@"
}
proof_completion_reader=123
read -r proof_completion_line || first_result=$?
[[ "$first_result" == 142 && -z "${fixture_partial_completion:-}" ]] || exit 21
read -r proof_completion_line || second_result=$?
[[ "$second_result" == 142 && "$proof_completion_line" == 0
   && "$fixture_partial_completion" == 1 && "$fixture_read_calls" == 2 ]] || exit 22
"""
        result = subprocess.run(
            [BASH, "-c", command, "_", str(self.root / "scripts/lib/cloudbench-env.sh")],
            cwd=self.root, env=self.env, capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("fixture consumed completion byte: 0", result.stderr)

    def test_interrupted_completion_read_preserves_original_failure(self):
        self.run_case(fleet_exit=137, partial_completion=True)

    def run_successful_completion_case(self, *, frame=None, native_schedule=None):
        self.root = self.root.resolve()
        source = (ROOT / "scripts/tests/fleet-infra-stability-proof.test.sh").read_text()
        fake = source.split("cat >\"$tmp/fake-fleet\" <<'SH'\n", 1)[1].split("\nSH\n", 1)[0]
        (self.root / "fake-fleet").write_text(fake)
        if frame is None and native_schedule is None:
            self.inject_partial_completion_read()
        elif frame is not None:
            self.env["FIXTURE_COMPLETION_FRAME"] = frame
            with (self.root / "scripts/lib/cloudbench-env.sh").open("a") as handle:
                handle.write(r"""
read() {
  local fixture_read_result=0
  builtin read "$@" || fixture_read_result=$?
  if [[ "${!#}" == proof_completion_line ]] && [[ "${#proof_completion_line}" -gt 4 ]]; then
    builtin printf 'fixture observed oversized completion read\n' >&2
  fi
  return "$fixture_read_result"
}
printf() {
  if [[ "${BASHPID:-}" == "${body_self_pid:-missing}" ]] \
    && [[ -n "${proof_completion_writer:-}" ]] && [[ "$#" == 2 ]] && [[ "$1" == '%s\n' ]]; then
    builtin printf '%s' "$FIXTURE_COMPLETION_FRAME"
  else
    builtin printf "$@"
  fi
}
""")
        result = self.run_completion_proof(
            [BASH, str(self.root / "scripts/run-fleet-infra-stability-proof"),
             "--capability", "--runs", "1", "--width", "1", "--timeout", "300"],
            native_schedule=native_schedule,
        )
        output = result.stdout + result.stderr
        summary = json.loads(next((self.root / "proofs").glob("*/summary.json")).read_text())
        if frame is None and native_schedule is None:
            self.assertIn("fixture consumed completion byte: 0", output)
        self.assertEqual(summary["status"], "passed", output)
        self.assertEqual(summary["passed_slices"], 1, output)
        self.assertEqual(summary["cleanup_status"], "verified", output)
        self.assertNotIn("fixture observed oversized completion read", output)
        self.assertEqual(result.returncode, 0 if frame is None else 1, output)

    def native_optional_artifact_completion(self, hold_seconds):
        broken_artifacts = self.root / "broken-artifacts"
        broken_artifacts.symlink_to(self.root / "unavailable/artifacts", target_is_directory=True)
        self.env["FLEET_INFRA_PROOF_ARTIFACT_DIR"] = str(broken_artifacts)
        schedule = NATIVE_COMPLETION["CompletionReadSchedule"](hold_seconds=hold_seconds)
        self.run_successful_completion_case(native_schedule=schedule)
        self.assertTrue(schedule.triggered, "native delimiter scheduling boundary was not exercised")
        self.assertEqual(next((self.root / "proofs").glob("*/controller.exit")).read_bytes(), b"0\n")
        self.assertIn("optional artifact directory unavailable", (self.root / "output.log").read_text())

    @unittest.skipUnless(NATIVE_COMPLETION["SUPPORTED"], "native syscall schedule requires Linux x86_64")
    def test_native_delimiter_control_preserves_optional_artifact_success(self):
        self.native_optional_artifact_completion(0)

    @unittest.skipUnless(NATIVE_COMPLETION["SUPPORTED"], "native syscall schedule requires Linux x86_64")
    def test_native_delimiter_timeout_preserves_optional_artifact_success(self):
        self.native_optional_artifact_completion(.15)

    @unittest.skipUnless(NATIVE_COMPLETION["SUPPORTED"], "native syscall schedule requires Linux x86_64")
    def test_native_delimiter_timeout_preserves_original_failure(self):
        schedule = NATIVE_COMPLETION["CompletionReadSchedule"](expected_frame=b"137\n")
        self.run_case(fleet_exit=137, native_schedule=schedule)
        self.assertTrue(schedule.triggered, "native delimiter scheduling boundary was not exercised")
        self.assertEqual(next((self.root / "proofs").glob("*/controller.exit")).read_bytes(), b"137\n")

    def test_interrupted_completion_read_preserves_success(self):
        self.run_successful_completion_case()

    def test_completion_rejects_unterminated_frame(self):
        self.run_successful_completion_case(frame="0")

    def test_completion_rejects_duplicate_frames(self):
        self.run_successful_completion_case(frame="0\n0\n")

    def test_completion_rejects_oversize_frame(self):
        self.run_successful_completion_case(frame="0" * 4096 + "\n")

    def test_completion_rejects_non_numeric_frame(self):
        self.run_successful_completion_case(frame="bad\n")

    def test_completion_rejects_out_of_range_frame(self):
        self.run_successful_completion_case(frame="256\n")

    def test_failed_local_status_publication_does_not_wait_forever(self):
        self.run_case(publication_failure=True)
        proof = next((self.root / "proofs").glob("*"))
        for name in ("controller.owner", "controller.exit"):
            with self.subTest(publication=name):
                self.assertTrue((proof / name).is_file(), "publication fault did not reach its writer")
                self.assertEqual((proof / name).read_bytes(), b"", "intended publication fault was bypassed")

    def test_skipped_tasks_do_not_count_as_actual_capability_execution(self):
        self.root = self.root.resolve()
        source = (ROOT / "scripts/tests/fleet-infra-stability-proof.test.sh").read_text()
        fake = source.split("cat >\"$tmp/fake-fleet\" <<'SH'\n", 1)[1].split("\nSH\n", 1)[0]
        fake = (
            fake.replace('status = "FAILED"', 'status = "SKIPPED"')
            .replace('status = "PASSED"', 'status = "SKIPPED"')
            .replace("passed = True", "passed = False")
        )
        (self.root / "fake-fleet").write_text(fake)
        result = self.run_completion_proof(
            [
                BASH,
                str(self.root / "scripts/run-fleet-infra-stability-proof"),
                "--capability",
                "--runs",
                "1",
                "--width",
                "1",
                "--timeout",
                "300",
            ],
        )
        summary = json.loads(next((self.root / "proofs").glob("*/summary.json")).read_text())
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(summary["status"], "failed")
        self.assertEqual(summary["passed_slices"], 0)
        self.assertEqual(summary["slices"][0]["classification"], "infra")
        self.assertEqual(summary["cleanup_status"], "verified")

    def test_failed_controller_recovers_exact_owner_before_final_status(self):
        self.run_case()

    def test_evidence_wrapper_failure_recovers_without_acceptance_credit(self):
        self.run_case(fleet_exit=70)

    def test_recovery_failure_retains_ownership_and_reports_failure(self):
        self.run_case(recovery_fail=True)

    def test_signal_waits_for_owned_producer_before_recovery(self):
        self.run_case(cancel=True)

    def test_cancellation_normalizes_padded_birth_identity(self):
        # BSD ps pads single-digit days. Preserve every native birth field while
        # exercising that whitespace on every date, including double-digit days.
        with (self.root / "scripts/lib/cloudbench-env.sh").open("a") as handle:
            handle.write(r'''
ps() {
  local observed
  if [[ "$*" == *" lstart=" ]]; then
    observed="$(command ps "$@")" || return $?
    printf '%s\n' "$observed" | awk 'NF { printf "%s %s  %s %s %s\n", $1, $2, $3, $4, $5 }'
  else
    command ps "$@"
  fi
}
''')
        self.run_case(cancel=True)
        owner = next((self.root / "proofs").glob("*/controller.owner"))
        fields = dict(line.split("=", 1) for line in owner.read_text().splitlines())
        self.assertEqual(fields["pid_start"], " ".join(fields["pid_start"].split()))

    def test_failed_slice_log_cannot_abandon_owned_cleanup(self):
        self.run_case(log_fault="slice")

    def test_failed_summary_log_cannot_abandon_owned_cleanup(self):
        self.run_case(log_fault="summary")

    def test_repeated_waiter_cancellation_keeps_exact_cleanup(self):
        # The supervisor re-forwards cancellation to the published waiter every
        # 0.1s. Bash 5.2 can run that trap inside a $(...) or <(...) parse in the
        # waiter, failing the substitution and abandoning recovery. Deliver the
        # same TERM densely for the waiter's whole life so any such parse is hit.
        stop = threading.Event()
        delivered = []

        def forward_repeatedly():
            # Pace delivery; the event ends the storm as soon as the case returns.
            while not stop.wait(0.0005):
                for path in (self.root / "proofs").glob("*/active-waiter.owner"):
                    try:
                        fields = dict(line.split("=", 1) for line in path.read_text().splitlines())
                        os.kill(int(fields["pid"]), signal.SIGTERM)
                        delivered.append(1)
                    except (OSError, KeyError, ValueError):
                        pass

        storm = threading.Thread(target=forward_repeatedly, daemon=True)
        storm.start()
        try:
            self.run_case(cancel=True)
        finally:
            stop.set()
            storm.join(timeout=10)
        self.assertGreater(len(delivered), 100, "waiter was never exposed to repeated cancellation")
        self.assertNotIn("unexpected EOF", (self.root / "output.log").read_text())

    def test_cancellation_does_not_depend_on_body_pid_probe(self):
        self.run_case(cancel=True, unknown_body_probe=True)
        # The observer's completion pipe removes the old body-ps dependency.
        # Cancellation must complete without consulting this unavailable probe.
        self.assertFalse((self.root / "unknown-probe").exists())

    def test_terminal_status_waits_for_owned_descendant(self):
        self.run_case(descendant=True)

    def test_successful_recovery_exit_cannot_hide_retained_registry(self):
        self.run_case(false_ack=True)

    def test_dangling_audit_is_not_never_allocated(self):
        self.run_case(audit_fault="dangling")

    def test_two_field_terminal_audit_is_not_teardown_proof(self):
        self.run_case(audit_fault="truncated")

    def test_malformed_group_identity_cannot_authorize_recovery(self):
        helper = self.root / "scripts/lib/cloudbench-env.sh"
        source = helper.read_text().replace("cloudbench_detach_reexec_tracked() {", "fixture_original_detach() {", 1)
        source += """\ncloudbench_detach_reexec_tracked() {
  fixture_original_detach "$@" || return $?
  python3 - "$1" <<'PYBAD'
import pathlib,sys
p=pathlib.Path(sys.argv[1])
s=p.read_text().splitlines()
p.write_text('\\n'.join('group_token=malformed' if x.startswith('group_token=') else x for x in s)+'\\n')
PYBAD
}
"""
        helper.write_text(source)
        self.run_case(malformed_identity=True)


if __name__ == "__main__":
    unittest.main()
