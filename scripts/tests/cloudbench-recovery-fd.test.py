"""Offline native-exec boundary: recovery custody never follows a Fly daemon."""
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]


def function(source, name, required=True):
    match = re.search(r'^' + name + r'\(\).*?^}\n', source, re.M | re.S)
    if required and not match:
        raise AssertionError('missing production function ' + name)
    return match.group() if match else ''


def wait_file(path, process=None):
    deadline = time.monotonic() + 10
    while not path.exists():
        if process is not None and process.poll() is not None:
            raise AssertionError('controller exited before ' + str(path))
        if time.monotonic() >= deadline:
            raise AssertionError('fixture readiness deadline: ' + str(path))
        time.sleep(0.01)


@unittest.skipUnless(sys.platform.startswith("linux"), "native FD receipt uses Linux procfs")
class RecoveryDescriptorTest(unittest.TestCase):
    def test_background_proxy_keeps_native_pid_and_excludes_guard(self):
        fleet = (ROOT / 'scripts/run-bench-fleet').read_text()
        env_source = (ROOT / 'scripts/lib/cloudbench-env.sh').read_text()
        definitions = '\n'.join(function(fleet, name) for name in (
            'acquire_registry_recovery_lock', 'release_registry_recovery_guard'))
        definitions += function(fleet, 'flyctl', required=False)
        shared = function(env_source, 'cloudbench_start_data_plane_proxy')
        metrics = fleet.split('    start_metrics_proxy() {', 1)[1]
        for label, source, indent, variable in (
                ('status', shared, '    ', 'pid'),
                ('metrics', metrics, '            ', 'metrics_proxy_pid')):
            pattern = (r'^' + indent + r'(?:# Exec in this background child[^\n]*\n|'
                       r'\(\n|flyctl proxy ).*?^' + indent + variable + r'=\$!\n')
            launch = re.search(pattern, source, re.M | re.S)
            self.assertIsNotNone(launch, 'production background launch not found: ' + label)
            with self.subTest(proxy=label), tempfile.TemporaryDirectory() as temporary:
                base = Path(temporary)
                registry = base / 'owners' / ('a' * 32)
                registry.mkdir(parents=True)
                guard = base / 'cloudbench-fleet-recovery-locks' / registry.name
                fake = base / 'flyctl'
                fake.write_text('''#!/usr/bin/env python3
import json, os, pathlib, time
base = pathlib.Path(os.environ['FIXTURE'])
fds = {}
for name in os.listdir('/proc/self/fd'):
    try: fds[name] = os.readlink('/proc/self/fd/' + name)
    except FileNotFoundError: pass
(base/'native.json').write_text(json.dumps(dict(pid=os.getpid(), fds=fds)))
deadline = time.monotonic() + 15
while not (base/'native.release').exists() and time.monotonic() < deadline:
    time.sleep(.01)
(base/'native.done').touch()
''')
                fake.chmod(0o700)
                script = definitions + '''
FLEET_OWNER_HOST=fixture
FLEET_OWNER_PID_START=fixture-birth
APP=offline
local_port=1 remote_port=2 host=fixture
metrics_port=1 BOX_HEALTH_PORT=2 pip=fixture out="$FIXTURE"
log_file="$FIXTURE/proxy.log"
acquire_registry_recovery_lock "$FIXTURE/owners/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" || exit 90
''' + launch.group() + 'printf "%s" "$' + variable + '" > "$FIXTURE/published"\n' + '''
while [ ! -e "$FIXTURE/controller.release" ]; do sleep .01; done
release_registry_recovery_guard
'''
                environment = dict(os.environ, FIXTURE=str(base), PATH=str(base) + ':' + os.environ['PATH'])
                with tempfile.TemporaryFile() as output:
                    controller = subprocess.Popen(['bash', '-c', script], env=environment,
                                                  stdout=output, stderr=output)
                    try:
                        wait_file(base / 'native.json', controller)
                        wait_file(base / 'published', controller)
                        native = json.loads((base / 'native.json').read_text())
                        self.assertEqual(int((base / 'published').read_text()), native['pid'],
                                         'recorded proxy PID must identify native Fly')
                        with guard.open('r') as challenger:
                            with self.assertRaises(BlockingIOError):
                                fcntl.flock(challenger, fcntl.LOCK_EX | fcntl.LOCK_NB)
                            (base / 'controller.release').touch()
                            self.assertEqual(controller.wait(timeout=5), 0)
                            self.assertFalse((base / 'native.done').exists())
                            self.assertNotIn(str(guard), native['fds'].values())
                            fcntl.flock(challenger, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    finally:
                        (base / 'controller.release').touch()
                        controller.wait(timeout=5)
                        (base / 'native.release').touch()
                        if (base / 'native.json').exists():
                            wait_file(base / 'native.done')

    def test_native_exec_excludes_guard_and_preserves_controller_custody(self):
        fleet = (ROOT / 'scripts/run-bench-fleet').read_text()
        inventory = (ROOT / 'scripts/lib/cloudbench-inventory.sh').read_text()
        definitions = '\n'.join(function(fleet, name) for name in (
            'acquire_registry_recovery_lock', 'release_registry_recovery_guard',
            'release_registry_recovery_lock', 'FLY'))
        definitions += function(fleet, 'flyctl', required=False)
        definitions += function(inventory, 'fly_with_timeout')
        for route in ('flyctl ssh console', 'FLY ssh console', 'fly_with_timeout 3 ssh console'):
            with self.subTest(route=route), tempfile.TemporaryDirectory() as temporary:
                base = Path(temporary)
                registry = base / 'owners' / ('a' * 32)
                registry.mkdir(parents=True)
                guard = base / 'cloudbench-fleet-recovery-locks' / registry.name
                fake = base / 'flyctl'
                fake.write_text('''#!/usr/bin/env python3
import json, os, pathlib, time
base = pathlib.Path(os.environ['FIXTURE'])
fds = {}
for name in os.listdir('/proc/self/fd'):
    try: fds[name] = os.readlink('/proc/self/fd/' + name)
    except FileNotFoundError: pass
(base/'native.json').write_text(json.dumps(fds))
pid = os.fork()
if pid == 0:
    # Isolate guard custody from the timeout wrapper's separate FIFO lifetime.
    for name, target in fds.items():
        if int(name) > 2 and 'cloudbench-fleet-recovery-locks' not in target:
            os.close(int(name))
    for fd in (0, 1, 2):
        os.dup2(os.open(os.devnull, os.O_RDWR), fd)
    (base/'daemon.ready').write_text(str(os.getpid()))
    deadline = time.monotonic() + 15
    while not (base/'daemon.release').exists() and time.monotonic() < deadline:
        time.sleep(.01)
    (base/'daemon.done').touch()
    os._exit(0)
os._exit(17)
''')
                fake.chmod(0o700)
                script = definitions + '''
private_source_allows_provider_call() { return 0; }
archived_reuse_sftp_get() { return 2; }
archived_reuse_transport_args() { ARCHIVED_FLY_ARGS=("$@"); }
registry_meta_value() { sed -n "s/^${2}=//p" "$1" | head -1; }
FLEET_OWNER_HOST=fixture
FLEET_OWNER_PID_START=fixture-birth
APP=offline
acquire_registry_recovery_lock "$FIXTURE/owners/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" || exit 90
''' + route + '''
printf '%s' "$?" > "$FIXTURE/status"
while [ ! -e "$FIXTURE/controller.release" ]; do sleep .01; done
release_registry_recovery_lock "$FIXTURE/owners/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
'''
                environment = dict(os.environ, FIXTURE=str(base), PATH=str(base) + ':' + os.environ['PATH'])
                with tempfile.TemporaryFile() as output:
                    controller = subprocess.Popen(['bash', '-c', script], env=environment,
                                                  stdout=output, stderr=output)
                    try:
                        wait_file(base / 'daemon.ready', controller)
                        wait_file(base / 'status', controller)
                        self.assertEqual((base / 'status').read_text(), '17')
                        with guard.open('r') as challenger:
                            with self.assertRaises(BlockingIOError):
                                fcntl.flock(challenger, fcntl.LOCK_EX | fcntl.LOCK_NB)
                            (base / 'controller.release').touch()
                            self.assertEqual(controller.wait(timeout=5), 0)
                            self.assertFalse((base / 'daemon.done').exists())
                            native = json.loads((base / 'native.json').read_text())
                            self.assertNotIn(str(guard), native.values(),
                                             'native Fly exec inherited the recovery guard: ' + str(native))
                            fcntl.flock(challenger, fcntl.LOCK_EX | fcntl.LOCK_NB)
                            self.assertFalse((registry / 'recovery-lock').exists())
                    finally:
                        (base / 'controller.release').touch()
                        controller.wait(timeout=5)
                        (base / 'daemon.release').touch()
                        if (base / 'daemon.ready').exists():
                            wait_file(base / 'daemon.done')


if __name__ == '__main__':
    unittest.main()
