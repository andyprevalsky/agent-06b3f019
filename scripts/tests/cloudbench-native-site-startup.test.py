#!/usr/bin/env python3
"""Actual checked mutation and campaign native reader startup, offline only."""
import gzip
import http.server
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(os.environ.get('NATIVE_SITE_SOURCE_ROOT', ROOT))
NETWORK_GUARD = '''
import ipaddress, os, runpy, sys
def deny_remote(event, args):
    if event == 'socket.getaddrinfo':
        host = args[0]
    elif event == 'socket.connect':
        address = args[1]
        if not isinstance(address, tuple):
            return  # Unix-domain endpoints are local, not provider destinations.
        host = address[0]
    else:
        return
    if isinstance(host, bytes):
        host = host.decode('ascii')
    if host == 'localhost':
        return
    try:
        if ipaddress.ip_address(host).is_loopback:
            return
    except ValueError:
        pass
    raise OSError('owning fixture denied non-loopback network destination')
sys.addaudithook(deny_remote)
args = sys.argv[1:]
if args[0] == '-c':
    sys.argv = ['-c', *args[2:]]
    exec(compile(args[1], '<string>', 'exec'), {'__name__': '__main__'})
elif args[0] == '-':
    sys.argv = args
    exec(compile(sys.stdin.read(), '<stdin>', 'exec'), {'__name__': '__main__'})
else:
    sys.argv = args
    sys.path[0] = os.path.dirname(os.path.abspath(args[0]))
    runpy.run_path(args[0], run_name='__main__')
'''


class NativeSiteStartup(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        venv = self.root/'venv'
        (venv/'bin').mkdir(parents=True)
        binary = Path(sys.executable).resolve()
        real = venv/'bin/python-real'
        real.symlink_to(binary)
        (venv/'pyvenv.cfg').write_text('home = '+str(binary.parent)+'\ninclude-system-site-packages = false\n')
        packages = venv/f'lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages'
        packages.mkdir(parents=True)
        self.marker = self.root/'site-started'
        (packages/'owning-control.pth').write_text(
            'import os,time; os.close(os.open('+repr(str(self.marker))+',os.O_WRONLY|os.O_CREAT,0o600)); time.sleep(0.15)\n'
        )
        guard = self.root/'network-guard.py'
        guard.write_text(NETWORK_GUARD)
        wrapper = venv/'bin/python3'
        wrapper.write_text('#!/bin/bash\nflags=()\nif [ "${1:-}" = -S ]; then flags=(-S); shift; fi\n'
                           'exec "'+str(real)+'" "${flags[@]}" "'+str(guard)+'" "$@"\n')
        wrapper.chmod(0o700)
        self.env = dict(os.environ, PATH=str(venv/'bin')+':'+os.environ['PATH'])
        self.python = wrapper

    def test_actual_checked_loader_preserves_admission_and_hash_refusal_without_site(self):
        spec = importlib.util.spec_from_file_location('admission_fixture', ROOT/'scripts/tests/cloudbench-parallel-mutation.test.py')
        fixture_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixture_module)
        fixture = fixture_module.Admission(methodName='runTest')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        text = (SOURCE/'scripts/lib/cloudbench-env.sh').read_text()
        functions = text[text.index('cloudbench_mutation_launch_code() {'):]
        script = ('set -eu\n'+functions+'\ncloudbench_mutation_admission "$HELPER" pace '
                  '--app fixture --root "$CAPACITY" --owner-pid "$OWNER" '
                  '--owner-start "$BIRTH" --wait-seconds 2\n')
        env = dict(fixture.env, PATH=self.env['PATH'], HELPER=str(ROOT/'scripts/cloudbench-campaign-mutation.py'),
                   CAPACITY=str(fixture.capacity), OWNER=str(os.getpid()), BIRTH=fixture_module.birth(os.getpid()))
        result = subprocess.run(['/bin/bash', '-c', script], env=env, capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.marker.exists(), 'checked stdlib mutation loader initialized venv site packages')
        authority = json.loads(env['CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY'])
        authority['source']['sha256']['cloudbench-campaign-mutation.py'] = '0'*64
        env['CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY'] = json.dumps(authority)
        rejected = subprocess.run(['/bin/bash', '-c', script], env=env, capture_output=True, text=True, timeout=3)
        self.assertNotEqual(rejected.returncode, 0, 'altered authority must not execute/grant')
        self.assertIn('native mutation authority changed', rejected.stderr)

    def test_actual_campaign_reader_preserves_full_gzip_payload_and_rejects_duplicates(self):
        for host in ['203.0.113.1', 'api.machines.dev']:
            denied = subprocess.run([str(self.python), '-S', '-c',
                                     'import socket;socket.create_connection(("'+host+'",443),.1)'],
                                    capture_output=True, text=True, timeout=2)
            self.assertNotEqual(denied.returncode, 0)
            self.assertIn('denied non-loopback', denied.stderr)
        payload = [dict(id='1234567890abcd', state='stopped', config=dict(
            guest=dict(cpu_kind='shared', cpus=2, memory_mb=2048),
            env=dict(OPAQUE_FIXTURE='retained'), init=dict(cmd=['sleep', 'infinity']),
            mounts=[dict(volume='vol-fixture', path='/data', size_gb=32)]))]
        calls = []
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                calls.append((self.command, self.path, self.headers.get('Authorization')))
                raw = gzip.compress(json.dumps(payload).encode())
                self.send_response(200)
                self.send_header('Content-Encoding', 'gzip')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
            def log_message(self, *unused):
                pass
        server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        self.addCleanup(thread.join, 2)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        text = (SOURCE/'scripts/cloudbench-campaign-inventory.sh').read_text()
        function = 'FLY() {\n'+text.split('\nFLY() {\n', 1)[1].split('\n}\n', 1)[0]+'\n}\n'
        script = 'set -eu\n'+function+'\nFLY machines list -a "$APP" --json\n'
        env = dict(self.env, SOURCE=str(ROOT/'scripts'), APP='fixture', SNAPSHOT_REFRESH_TIMEOUT='2',
                   FLY_API_TOKEN='offline-fixture', FLY_FLAPS_BASE_URL='http://127.0.0.1:'+str(server.server_port))
        self.assertIn("os.environ.get('FLY_FLAPS_BASE_URL'", (ROOT/'scripts/cloudbench-campaign-machines.py').read_text())
        env.pop('FLY_FORCE_INSTANCE_ID', None)
        env.pop('CLOUDBENCH_INVENTORY_PHASE_FILE', None)
        result = subprocess.run(['/bin/bash', '-c', script], env=env, capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), payload)
        self.assertEqual(calls, [('GET', '/v1/apps/fixture/machines', 'Bearer offline-fixture')])
        self.assertFalse(self.marker.exists(), 'stdlib native reader initialized venv site packages')
        payload.append(payload[0])
        refused = subprocess.run(['/bin/bash', '-c', script], env=env, capture_output=True, text=True, timeout=3)
        self.assertNotEqual(refused.returncode, 0, 'duplicate Machine IDs must not grant a full inventory')
        self.assertEqual(refused.stdout, '')

    def test_app_metadata_accepts_only_optional_string_network(self):
        import runpy
        helper=runpy.run_path(str(SOURCE/'scripts/cloudbench-campaign-machines.py'))
        value={'name':'fixture','organization':{'slug':'owner'}}
        for network in (None,'','default','private'):
            with self.subTest(network=network):
                expected='' if network in (None,'','default') else network
                self.assertEqual(helper['app_metadata']({**value,'network':network},'fixture')['Network'],expected)
        self.assertEqual(helper['app_metadata'](value,'fixture')['Network'],'')
        for network in (0,False,[],{}):
            with self.subTest(network=network),self.assertRaises(helper['Refusal']):
                helper['app_metadata']({**value,'network':network},'fixture')


    def cloud_function(self, name):
        text = (SOURCE/'scripts/run-bench-cloud').read_text()
        start = text.index(name+'() {')
        return text[start:text.index('\n}\n', start)+3]

    def test_progress_state_preserves_fragment_reset_and_identity_errors_without_site(self):
        function = self.cloud_function('cloudbench_update_progress_state')
        # Compare the exact original parser with and without site initialization.
        outputs = []
        for mode, selected in [('normal', function.replace('python3 -S ', 'python3 ')), ('selected', function)]:
            state = self.root/(mode+'.json')
            delta = self.root/(mode+'.log')
            state.write_text('')
            self.marker.unlink(missing_ok=True)
            observations = []
            for data, reset in [(b'[cloudbench 01:02:03] STEP git_', '0'),
                                (b'sync\n synchronized start barrier ready\n', '0'),
                                (b'synchronized start barrier released\n', '1')]:
                delta.write_bytes(data)
                script = selected+'\ncloudbench_update_progress_state "$STATE" "$DELTA" token task 20 '+reset
                env = dict(self.env, STATE=str(state), DELTA=str(delta))
                result = subprocess.run(['/bin/bash', '-c', script], env=env, capture_output=True, text=True, timeout=3)
                self.assertEqual(result.returncode, 0, result.stderr)
                observations.append((result.stdout, json.loads(state.read_text())))
            state.write_text('{}')
            mismatch = subprocess.run(['/bin/bash', '-c', script], env=env, capture_output=True, text=True, timeout=3)
            self.assertNotEqual(mismatch.returncode, 0)
            self.assertIn('identity mismatch', mismatch.stderr)
            state.write_text('{broken')
            malformed = subprocess.run(['/bin/bash', '-c', script], env=env, capture_output=True, text=True, timeout=3)
            self.assertNotEqual(malformed.returncode, 0)
            self.assertIn('invalid cloudbench progress state', malformed.stderr)
            outputs.append(observations)
            if mode == 'normal':
                self.assertTrue(self.marker.exists(), 'control must exercise normal site initialization')
            else:
                self.assertFalse(self.marker.exists(), 'progress poll initialized venv site packages')
        self.assertEqual(outputs[0], outputs[1])
        self.assertEqual(outputs[1][1][1]['steps'], ['git_sync'])
        self.assertTrue(outputs[1][1][1]['barrier_ready'])
        self.assertFalse(outputs[1][2][1]['barrier_ready'])
        self.assertTrue(outputs[1][2][1]['barrier_released'])

    def test_log_anchor_preserves_exact_bytes_validation_and_transport_exit_without_site(self):
        import hashlib
        function = self.cloud_function('read_bench_log')
        log = self.root/'bench.log'
        raw = bytes(range(256))*20+b'\x00last\xff'
        log.write_bytes(raw)
        outputs = []
        for mode, selected in [('normal', function.replace('python3 -S ', 'python3 ')), ('selected', function)]:
            self.marker.unlink(missing_ok=True)
            args = self.root/(mode+'.args')
            # Intercept every curl invocation; this test has no network transport.
            script = ('cloudbench_proxy_alive() { return 0; }\n'
                      'curl() { printf "%s\\n" "$@" > "$ARGS"; printf fixture-bytes; return "${CURL_EXIT:-0}"; }\n'
                      +selected+'\nread_bench_log "$OFFSET" "$LIMIT"')
            env = dict(self.env, SSH_LOG=str(log), ARGS=str(args), LOCAL_STATUS_PORT='1',
                       OFFSET=str(len(raw)), LIMIT='262144')
            result = subprocess.run(['/bin/bash', '-c', script], env=env, capture_output=True, timeout=3)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, b'fixture-bytes')
            anchor = hashlib.sha256(raw[-4096:]).hexdigest()
            self.assertIn('X-Cloudbench-Log-Anchor: '+anchor, args.read_text())
            outputs.append(args.read_text())
            failure = subprocess.run(['/bin/bash', '-c', script], env=dict(env, CURL_EXIT='28'), capture_output=True, timeout=3)
            self.assertEqual(failure.returncode, 28)
            args.unlink()
            invalid = subprocess.run(['/bin/bash', '-c', script], env=dict(env, LIMIT='262145'), capture_output=True, timeout=3)
            self.assertEqual(invalid.returncode, 2)
            self.assertFalse(args.exists(), 'invalid limit must refuse before transport')
            if mode == 'normal':
                self.assertTrue(self.marker.exists())
            else:
                self.assertFalse(self.marker.exists(), 'log hash anchor initialized venv site packages')
        self.assertEqual(outputs[0], outputs[1])


if __name__ == '__main__':
    unittest.main()
