#!/usr/bin/env python3
"""Actual startup-capacity release against bounded, loopback native HTTP only."""
import http.server
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(os.environ.get('START_ACCOUNTING_SOURCE_ROOT', ROOT))


class StartAccounting(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        text = (SOURCE/'scripts/run-bench-fleet').read_text()
        start = text.index('release_capacity_reservation_after_primary_start_accounted() {')
        self.function = text[start:text.index('\n}\n', start)+3]
        self.assertIn('CLOUDBENCH_CAPACITY_START_ACCOUNTING_SECONDS:-120', self.function)
        self.calls = []
        self.mode = 'started'
        owner = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                owner.calls.append(self.path)
                ident = self.path.rsplit('/', 1)[-1]
                if self.path not in ['/v1/apps/fixture/machines/aa', '/v1/apps/fixture/machines/bb']:
                    self.send_error(400); return
                if owner.mode == '404':
                    self.send_error(404); return
                state = 'started'
                if owner.mode == 'stopped' or (owner.mode == 'transition' and len(owner.calls) == 1):
                    state = 'stopped'
                value = {'id':ident, 'state':state, 'config':{'env':{'FIXTURE':'retained'}}}
                if owner.mode == 'wrong-id': value['id'] = 'ff'
                if owner.mode == 'missing-state': value.pop('state')
                raw = b'{malformed' if owner.mode == 'malformed' else json.dumps(value).encode()
                self.send_response(200)
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                try:
                    if owner.mode == 'drip':
                        for byte in raw:
                            self.wfile.write(bytes([byte])); self.wfile.flush(); time.sleep(.2)
                    else:
                        self.wfile.write(raw)
                except (BrokenPipeError, ConnectionResetError):
                    pass
            def log_message(self, *args): pass
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        self.addCleanup(thread.join, 2)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.endpoint = 'http://127.0.0.1:'+str(server.server_port)
        # The child cannot reach a real provider even if its endpoint is wrong.
        spec = importlib.util.spec_from_file_location('native_site_fixture', ROOT/'scripts/tests/cloudbench-native-site-startup.test.py')
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        guard = self.root/'deny-network.py'; guard.write_text(module.NETWORK_GUARD)
        binary = self.root/'bin'; binary.mkdir()
        wrapper = binary/'python3'
        import sys
        wrapper.write_text('#!/bin/bash\nflags=()\nif [ "${1:-}" = -S ]; then flags=(-S); shift; fi\n'
                           'exec "'+str(Path(sys.executable).resolve())+'" "${flags[@]}" "'+str(guard)+'" "$@"\n')
        wrapper.chmod(0o700)
        self.env = dict(os.environ, PATH=str(binary)+':'+os.environ['PATH'],
                        APP='fixture', CLOUDBENCH_SCRIPT_SNAPSHOT=str(ROOT/'scripts'),
                        FLY_API_TOKEN='offline-fixture', FLY_FLAPS_BASE_URL=self.endpoint,
                        CLOUDBENCH_CAPACITY_START_ACCOUNTING_SECONDS='1', FIXTURE_ROOT=str(self.root))
        self.env.pop('FLY_FORCE_INSTANCE_ID', None)
        self.env.pop('CLOUDBENCH_INVENTORY_PHASE_FILE', None)

    def invoke(self, markers=True, incomplete=False, release_exit=0):
        for ident in ['aa', 'bb']:
            directory = self.root/ident; directory.mkdir(exist_ok=True)
            marker = directory/'post-config-start.accepted'
            marker.unlink(missing_ok=True)
            if markers: marker.write_text('accepted\n')
        self.calls.clear()
        (self.root/'bulk.calls').unlink(missing_ok=True)
        (self.root/'release.calls').unlink(missing_ok=True)
        script = '''set -u
CAPACITY_RESERVATION_PUBLISHED=1
CAPACITY_RESERVATION_TOKEN=exact-owned-token
BENCHES=(one two)
CHILD_MACHINE=(aa bb)
CHILD_OUT=("$FIXTURE_ROOT/aa" "$FIXTURE_ROOT/bb")
FLY() {
    printf '%s\\n' "$*" >> "$FIXTURE_ROOT/bulk.calls"
    printf '%s\\n' '[{"id":"aa","state":"started"},{"id":"bb","state":"started"}]'
}
capacity_release_reservation() {
    [ "$1" = exact-owned-token ] || return 2
    printf '%s\\n' "$1" >> "$FIXTURE_ROOT/release.calls"
    return "$RELEASE_EXIT"
}
'''+self.function+'\n'
        if incomplete: script += 'CHILD_MACHINE=(aa)\n'
        script += '''status=0
release_capacity_reservation_after_primary_start_accounted || status=$?
printf '%s|%s\\n' "$status" "$CAPACITY_RESERVATION_PUBLISHED" > "$FIXTURE_ROOT/result"
'''
        started = time.monotonic()
        process = subprocess.run(['/bin/bash','-c',script], env=dict(self.env, RELEASE_EXIT=str(release_exit)),
                                 capture_output=True, text=True, timeout=4)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertLess(time.monotonic()-started, 3, 'native body must stay within original accounting window')
        result = (self.root/'result').read_text().strip()
        self.assertFalse((self.root/'bulk.calls').exists(), 'startup accounting must not materialize app-wide Machines')
        return result

    def test_accepted_owned_starts_release_only_after_fresh_native_observations(self):
        self.env['CLOUDBENCH_CAPACITY_START_ACCOUNTING_SECONDS']='2'
        self.assertEqual(self.invoke(), '0|0')
        self.assertEqual(self.calls, ['/v1/apps/fixture/machines/aa','/v1/apps/fixture/machines/bb'])
        self.assertEqual((self.root/'release.calls').read_text(), 'exact-owned-token\n')
        self.mode='transition'
        # Use two seconds for this retry control, never a new clock per request.
        self.env['CLOUDBENCH_CAPACITY_START_ACCOUNTING_SECONDS']='2'
        self.assertEqual(self.invoke(), '0|0')
        self.assertEqual(self.calls, ['/v1/apps/fixture/machines/aa','/v1/apps/fixture/machines/aa','/v1/apps/fixture/machines/bb'])
        self.mode='started'
        self.assertEqual(self.invoke(release_exit=1), '1|1')

    def test_unknown_stopped_or_unbounded_native_body_retains_owned_reservation(self):
        for mode in ['stopped','missing-state','wrong-id','malformed','404','drip']:
            with self.subTest(mode=mode):
                self.mode=mode
                self.assertEqual(self.invoke(), '1|1')
                self.assertFalse((self.root/'release.calls').exists())
                self.assertTrue(self.calls)
                self.assertTrue(all(path.endswith('/aa') for path in self.calls))

    def test_missing_accepted_markers_or_incomplete_ownership_make_no_native_read(self):
        self.assertEqual(self.invoke(markers=False), '1|1')
        self.assertEqual(self.calls, [])
        self.assertEqual(self.invoke(incomplete=True), '1|1')
        self.assertEqual(self.calls, [])
        self.assertFalse((self.root/'release.calls').exists())
        slow = self.root/'slow-loader'; slow.mkdir()
        helper = (ROOT/'scripts/cloudbench-campaign-machines.py').read_text()
        # Preserve the actual helper; inject a delayed module load after its
        # future-import header to distinguish the outer original-clock guard.
        helper = helper.replace('import json\n', 'import time; time.sleep(3)\nimport json\n', 1)
        (slow/'cloudbench-campaign-machines.py').write_text(helper)
        self.env['CLOUDBENCH_SCRIPT_SNAPSHOT'] = str(slow)
        self.assertEqual(self.invoke(), '1|1')
        self.assertEqual(self.calls, [])
        self.assertFalse((self.root/'release.calls').exists())


if __name__ == '__main__': unittest.main()
