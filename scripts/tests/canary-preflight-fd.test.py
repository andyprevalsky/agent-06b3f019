"""Real preflight flock custody excludes native descendants without early release."""
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / 'scripts/cloudbench-infra-canary-preflight.py'


def wait_file(path, process=None):
    deadline = time.monotonic() + 10
    while not path.exists():
        if process is not None and process.poll() is not None:
            raise AssertionError('preflight exited before fixture readiness')
        if time.monotonic() >= deadline:
            raise AssertionError('fixture readiness missing: ' + str(path))
        time.sleep(.01)


@unittest.skipUnless(sys.platform.startswith('linux'), 'FD receipts use Linux procfs')
class CanaryDescriptorTest(unittest.TestCase):
    def test_guard_survives_helper_crash_but_not_native_daemon(self):
        for outcome in ('pass', 'failure', 'helper-crash', 'cancel'):
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as temporary:
                base = Path(temporary)
                native = base / 'flyctl'
                native.write_text('''#!/usr/bin/env python3
import json,os,pathlib,signal,time
base=pathlib.Path(os.environ['CASE'])
fds={}
for name in os.listdir('/proc/self/fd'):
    try:fds[name]=os.readlink('/proc/self/fd/'+name)
    except FileNotFoundError:pass
(base/'native.json').write_text(json.dumps(dict(pid=os.getpid(),fds=fds)))
pid=os.fork()
if pid==0:
    for fd in (0,1,2):os.dup2(os.open(os.devnull,os.O_RDWR),fd)
    (base/'daemon.ready').touch()
    deadline=time.monotonic()+20
    while not (base/'daemon.release').exists() and time.monotonic()<deadline:time.sleep(.01)
    (base/'daemon.done').touch()
    os._exit(0)
def terminate(sig,frame):
    (base/'native.term').touch()
    deadline=time.monotonic()+10
    while not (base/'native.release').exists() and time.monotonic()<deadline:time.sleep(.01)
    (base/'native.done').touch()
    raise SystemExit(143)
signal.signal(signal.SIGTERM,terminate)
deadline=time.monotonic()+15
while not (base/'native.release').exists() and time.monotonic()<deadline:time.sleep(.01)
(base/'native.done').touch()
raise SystemExit(int(os.environ['NATIVE_STATUS']))
''')
                native.chmod(0o700)
                canary = base / 'canary.sh'
                canary.write_text('#!/usr/bin/env bash\nexec "$CASE/flyctl" secrets list\n')
                lock, stamp = base / 'transaction.lock', base / 'stamp'
                environment = dict(os.environ, CASE=str(base), NATIVE_STATUS='17' if outcome == 'failure' else '0')
                for key in tuple(environment):
                    if key.startswith(('RUN_BENCH_CAMPAIGN_', 'CLOUDBENCH_COHORT_', 'RUN_BENCH_CLEANUP_', 'CLOUDBENCH_CAMPAIGN_PARENT_')):
                        environment.pop(key)
                args = [sys.executable, str(HELPER), '--stamp', str(stamp), '--lock', str(lock),
                        '--ttl-seconds', '3600', '--width', '2', '--canary', str(canary),
                        '--nested-controller-lock', 'fixture.lock']
                with tempfile.TemporaryFile() as output:
                    helper = subprocess.Popen(args, env=environment, stdout=output, stderr=output)
                    try:
                        wait_file(base / 'daemon.ready', helper)
                        native_receipt = json.loads((base / 'native.json').read_text())
                        if outcome == 'helper-crash':
                            helper.kill()
                            helper.wait(timeout=5)
                        elif outcome == 'cancel':
                            helper.terminate()
                            wait_file(base / 'native.term')
                            self.assertIsNone(helper.poll(), 'preflight exited before native cleanup joined')
                        with lock.open('r') as challenger:
                            with self.assertRaises(BlockingIOError):
                                fcntl.flock(challenger, fcntl.LOCK_EX | fcntl.LOCK_NB)
                            (base / 'native.release').touch()
                            wait_file(base / 'native.done')
                            if outcome != 'helper-crash':
                                expected = {'pass': 0, 'failure': 17, 'cancel': 143}[outcome]
                                self.assertEqual(helper.wait(timeout=5), expected)
                                self.assertEqual(stamp.exists(), outcome == 'pass')
                            self.assertFalse((base / 'daemon.done').exists())
                            self.assertNotIn(str(lock), native_receipt['fds'].values(),
                                             'native Fly inherited canary transaction custody')
                            deadline=time.monotonic()+5
                            while True:
                                try:
                                    fcntl.flock(challenger, fcntl.LOCK_EX | fcntl.LOCK_NB)
                                    break
                                except BlockingIOError:
                                    if time.monotonic()>=deadline:raise
                                    time.sleep(.01)
                    finally:
                        (base / 'native.release').touch()
                        if helper.poll() is None:
                            helper.terminate()
                            helper.wait(timeout=5)
                        (base / 'daemon.release').touch()
                        if (base / 'daemon.ready').exists():wait_file(base / 'daemon.done')


if __name__ == '__main__':
    unittest.main()
