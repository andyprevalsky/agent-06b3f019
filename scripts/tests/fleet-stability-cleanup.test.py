#!/usr/bin/env python3
"""Actual proof supervisor versus isolated external fleet/recovery commands."""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
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
        self.temp = tempfile.TemporaryDirectory(prefix="fleet-proof-cleanup-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
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
            with (self.root / "scripts/lib/cloudbench-env.sh").open("a") as handle:
                handle.write(
                    "\nprintf() {\n case \"$1\" in 'pid=%s\\npid_start=%s\\n'|'%s\\n') return 1 ;; esac\n builtin printf \"$@\"\n}\n"
                )
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
            process = subprocess.Popen(
                command, cwd=self.root, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True
            )
            try:
                if cancel:
                    deadline = time.monotonic() + 8
                    while not (self.root / "ready").exists() and time.monotonic() < deadline and process.poll() is None:
                        time.sleep(0.02)
                    self.assertTrue((self.root / "ready").exists(), (self.root / "output.log").read_text())
                    process.send_signal(signal.SIGTERM)
                try:
                    result = process.wait(timeout=5 if publication_failure else 15)
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
                    if pid and birth.stdout.strip() == fields.get("pid_start"):
                        try:
                            os.killpg(int(fields["pgid"]), signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                for path in (self.root / ".git/cloudbench-fleet-ownership").glob("*/meta"):
                    fields = json.loads(path.read_text())
                    birth = subprocess.run(
                        ["ps", "-p", str(fields["pid"]), "-o", "lstart="], text=True, capture_output=True
                    )
                    if birth.stdout.strip() == fields["birth"]:
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
    fixture_partial_completion=1
    builtin read -r -N 1 -t 5 -u "$proof_completion_reader" proof_completion_line || return "$?"
    printf 'fixture consumed completion byte: %s\n' "$proof_completion_line" >&2
    return 142
  fi
  builtin read "$@"
}
""")

    def test_interrupted_completion_read_preserves_original_failure(self):
        self.run_case(fleet_exit=137, partial_completion=True)

    def run_successful_completion_case(self, *, frame=None):
        self.root = self.root.resolve()
        source = (ROOT / "scripts/tests/fleet-infra-stability-proof.test.sh").read_text()
        fake = source.split("cat >\"$tmp/fake-fleet\" <<'SH'\n", 1)[1].split("\nSH\n", 1)[0]
        (self.root / "fake-fleet").write_text(fake)
        if frame is None:
            self.inject_partial_completion_read()
        else:
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
        result = subprocess.run(
            [BASH, str(self.root / "scripts/run-fleet-infra-stability-proof"),
             "--capability", "--runs", "1", "--width", "1", "--timeout", "300"],
            cwd=self.root, env=self.env, capture_output=True, text=True, timeout=8,
        )
        output = result.stdout + result.stderr
        summary = json.loads(next((self.root / "proofs").glob("*/summary.json")).read_text())
        if frame is None:
            self.assertIn("fixture consumed completion byte: 0", output)
        self.assertEqual(summary["status"], "passed", output)
        self.assertEqual(summary["passed_slices"], 1, output)
        self.assertEqual(summary["cleanup_status"], "verified", output)
        self.assertNotIn("fixture observed oversized completion read", output)
        self.assertEqual(result.returncode, 0 if frame is None else 1, output)

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
        result = subprocess.run(
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
            cwd=self.root,
            env=self.env,
            capture_output=True,
            text=True,
            timeout=8,
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

    def test_failed_slice_log_cannot_abandon_owned_cleanup(self):
        self.run_case(log_fault="slice")

    def test_failed_summary_log_cannot_abandon_owned_cleanup(self):
        self.run_case(log_fault="summary")

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
