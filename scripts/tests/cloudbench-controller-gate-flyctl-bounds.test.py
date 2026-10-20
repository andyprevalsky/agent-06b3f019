#!/usr/bin/env python3
"""The controller gate's flyctl calls are bounded and stop only their own child.

On 2026-10-20 a detached `flyctl machine run` printed "Machine started" and then
blocked for 17 minutes while the controller Machine was healthy. These controls
run the gate's actual launch block, read from its source, against a fake flyctl.
CLOUDBENCH_TEST_GATE_SOURCE selects another revision of the gate.
"""
import os, re, signal, subprocess, tempfile, time, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GATE = Path(os.environ.get('CLOUDBENCH_TEST_GATE_SOURCE', str(ROOT / 'scripts/run-cloudbench-controller-gate')))
FAKE = r'''#!/usr/bin/env bash
printf '%s\n' "$$" >> "$FAKE_PID_LOG"
printf '%s\n' "$*" >> "$FAKE_ARGS_LOG"
case "$FAKE_MODE" in
  started-block|id-block|exit-ok)
    echo "Success! A Machine has been successfully launched in app fixture"
    echo " Machine ID: 8d99dd7be69478"
    echo " Attempting to start machine..."
    [ "$FAKE_MODE" = id-block ] || echo "Machine started, you can connect via the following private ip"
    [ "$FAKE_MODE" = exit-ok ] && exit 0
    exec sleep 600 ;;
  no-id-fail) echo "Error: fixture create refused" >&2; exit 1 ;;
  no-id-slow) sleep 3; echo "Error: fixture create refused late" >&2; exit 1 ;;
  block) exec sleep 600 ;;
  fail) echo "fixture failure" >&2; exit 7 ;;
esac
'''


def gate_parts():
    lines = GATE.read_text().splitlines()
    helpers, inside = [], False
    for line in lines:
        if re.match(r'^(fly_[a-z_]+)\(\) \{', line) or line == 'FLY_CHILD_PID=""':
            inside = line != 'FLY_CHILD_PID=""'
            helpers.append(line)
            continue
        if inside:
            helpers.append(line)
            inside = line != '}'
    start = next(i for i, line in enumerate(lines) if line.startswith('RUN_LOG="$(mktemp -t cloudbench-gate-run.'))
    end = next(i for i, line in enumerate(lines) if i > start and line.startswith('MACHINE_ID="$(grep -oiE'))
    return '\n'.join(helpers), '\n'.join(lines[start:end + 1])


PRELUDE = '''set -euo pipefail
IMAGE_REF=fixture-image APP=fixture-app REGION=iad MACHINE_NAME=fixture VM_SIZE=shared-cpu-1x VM_MEMORY=256
GATE_SCRIPT=/dev/null GATE_TOKEN_FILE=/dev/null GATE_REF=fixture REPO_URL=fixture GATE_NODE_VERSION=v24.0.0
KEEP_FIXTURE_ON_FAILURE=0
MACHINE_LIFETIME_ARGS=(--rm) MACHINE_STORAGE_ARGS=() WORKSPACE_VOLUME_ARGS=() GATE_EXPORT_FILES=() GATE_PAYLOAD_FILES=()
'''


class GateFlyctlBounds(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='gate-flyctl-bounds-')
        self.root = Path(self.tmp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        (self.bin / 'flyctl').write_text(FAKE)
        (self.bin / 'flyctl').chmod(0o700)
        self.pids = self.root / 'pids.log'
        self.args = self.root / 'args.log'
        self.decoy = None

    def tearDown(self):
        if self.decoy is not None and self.decoy.poll() is None:
            self.decoy.kill()
            self.decoy.wait()
        for pid in self.fake_pids():
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        self.tmp.cleanup()

    def fake_pids(self):
        return [int(p) for p in self.pids.read_text().split()] if self.pids.exists() else []

    def start_decoy(self):
        # A same-named flyctl this gate did not start must survive every stop.
        other = self.root / 'other'
        other.mkdir()
        (other / 'flyctl').write_text(FAKE)
        (other / 'flyctl').chmod(0o700)
        self.decoy = subprocess.Popen([str(other / 'flyctl')], env=dict(
            os.environ, FAKE_MODE='block', FAKE_PID_LOG=str(self.root / 'decoy.pids'), FAKE_ARGS_LOG='/dev/null'))

    def run_bash(self, body, mode, timeout=30, **extra):
        helpers, _ = gate_parts()
        env = dict(os.environ, PATH=f'{self.bin}:/usr/bin:/bin', TMPDIR=str(self.root), FAKE_MODE=mode,
                   FAKE_PID_LOG=str(self.pids), FAKE_ARGS_LOG=str(self.args), **extra)
        started = time.monotonic()
        child = subprocess.Popen(['bash', '-c', PRELUDE + helpers + '\n' + body], env=env, text=True,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        try:
            out, err = child.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            out, err = child.communicate()
            self.fail(f'gate launch block still blocked after {timeout}s (flyctl unbounded)\n{out}\n{err}')
        return child.returncode, out, err, time.monotonic() - started

    def launch(self, mode, **extra):
        _, block = gate_parts()
        return self.run_bash(block + '\nprintf "RESULT_MACHINE_ID=%s\\n" "$MACHINE_ID"\n', mode,
                             CLOUDBENCH_GATE_RUN_AFTER_ID_S='3', CLOUDBENCH_GATE_RUN_AFTER_START_S='1', **extra)

    def assert_fake_gone(self):
        for pid in self.fake_pids():
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and Path(f'/proc/{pid}').exists() and \
                    Path(f'/proc/{pid}/stat').read_text().split()[2] != 'Z':
                time.sleep(0.1)
            alive = Path(f'/proc/{pid}').exists() and Path(f'/proc/{pid}/stat').read_text().split()[2] != 'Z'
            self.assertFalse(alive, f'owned flyctl {pid} left running')

    def test_machine_started_then_blocked_is_stopped_and_id_kept(self):
        self.start_decoy()
        rc, out, err, elapsed = self.launch('started-block')
        self.assertEqual(rc, 0, err)
        self.assertIn('RESULT_MACHINE_ID=8d99dd7be69478', out)
        self.assertIn('Machine started', out, 'flyctl output still streams to the caller')
        self.assertIn('stopped exact pid', err)
        self.assertLess(elapsed, 15)
        self.assert_fake_gone()
        self.assertIsNone(self.decoy.poll(), 'unrelated flyctl was signalled')
        self.assertIn('machine run fixture-image', self.args.read_text())

    def test_id_without_start_report_is_bounded_by_the_post_id_window(self):
        rc, out, err, elapsed = self.launch('id-block')
        self.assertEqual(rc, 0, err)
        self.assertIn('RESULT_MACHINE_ID=8d99dd7be69478', out)
        self.assertGreaterEqual(elapsed, 3, 'the start wait gets its full post-ID window')
        self.assertLess(elapsed, 15)
        self.assert_fake_gone()

    def test_normal_exit_is_unchanged(self):
        rc, out, err, elapsed = self.launch('exit-ok')
        self.assertEqual(rc, 0, err)
        self.assertIn('RESULT_MACHINE_ID=8d99dd7be69478', out)
        self.assertNotIn('stopped exact pid', err)
        self.assertLess(elapsed, 5)

    def test_no_machine_id_still_fails_closed_without_a_deadline(self):
        # No ID: never stopped early (a Machine may exist), and no ID is invented.
        rc, out, err, elapsed = self.launch('no-id-slow')
        self.assertNotEqual(rc, 0)
        self.assertNotIn('RESULT_MACHINE_ID=', out)
        self.assertGreaterEqual(elapsed, 3, 'flyctl ran to its own exit')
        self.assertNotIn('stopped exact pid', err)
        rc, out, err, _ = self.launch('no-id-fail')
        self.assertNotEqual(rc, 0)
        self.assertNotIn('RESULT_MACHINE_ID=', out)

    def test_fly_bounded_stops_only_its_child_and_returns_124(self):
        self.start_decoy()
        rc, out, err, elapsed = self.run_bash(
            'rc=0; fly_bounded 1 logs -a fixture-app >> "$TMPDIR/out.log" || rc=$?; echo "RC=$rc"', 'block')
        self.assertIn('RC=124', out, err)
        self.assertIn('flyctl logs exceeded its bound', err)
        self.assertLess(elapsed, 10)
        self.assert_fake_gone()
        self.assertIsNone(self.decoy.poll(), 'unrelated flyctl was signalled')

    def test_fly_bounded_keeps_flyctl_status_and_output(self):
        rc, out, err, _ = self.run_bash(
            'rc=0; fly_bounded 30 machines list || rc=$?; echo "RC=$rc"', 'fail')
        self.assertIn('RC=7', out)
        self.assertIn('fixture failure', err)

    def test_term_during_launch_stops_the_exact_child(self):
        # The gate traps TERM into exit and its EXIT cleanup stops FLY_CHILD_PID.
        _, block = gate_parts()
        body = ('trap \'[ -z "$FLY_CHILD_PID" ] || fly_stop_exact "$FLY_CHILD_PID"\' EXIT\n'
                "trap 'exit 143' TERM\n" + block)
        helpers, _ = gate_parts()
        env = dict(os.environ, PATH=f'{self.bin}:/usr/bin:/bin', TMPDIR=str(self.root), FAKE_MODE='block',
                   FAKE_PID_LOG=str(self.pids), FAKE_ARGS_LOG=str(self.args))
        child = subprocess.Popen(['bash', '-c', PRELUDE + helpers + '\n' + body], env=env, text=True,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        deadline = time.monotonic() + 10
        while not self.fake_pids() and time.monotonic() < deadline:
            time.sleep(0.1)
        self.assertTrue(self.fake_pids(), 'fake flyctl never started')
        child.send_signal(signal.SIGTERM)
        try:
            child.communicate(timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.communicate()
            self.fail('TERM did not end the launch promptly')
        self.assertEqual(child.returncode, 143)
        self.assert_fake_gone()

    def test_no_unbounded_flyctl_call_remains_in_the_gate(self):
        for number, line in enumerate(GATE.read_text().splitlines(), 1):
            code = line.split('#', 1)[0] if line.lstrip().startswith('#') else line
            if re.search(r'(^|[\s(|;&])flyctl\s', code) and 'fly_bounded' not in code \
                    and not re.match(r'^\s*(flyctl "\$@" &|flyctl machine run "\$@" > "\$log" 2>&1 &)$', code) \
                    and 'echo ' not in code:
                self.fail(f'unbounded flyctl call at gate line {number}: {line.strip()}')


if __name__ == '__main__':
    unittest.main()
