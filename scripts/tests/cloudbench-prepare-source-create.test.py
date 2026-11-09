#!/usr/bin/env python3
"""Real CLI against a simulated native HTTP boundary; no provider credentials."""
import copy
from datetime import datetime, timezone
import http.server
import hashlib
import json
import os
import runpy
import re
import signal
import time
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / 'scripts/cloudbench-prepare-source-create.py'
APP = 'navi-whisper-lux-bench'
OWNER = 'a' * 32
DONOR = '683e47df5094d8'
VOL = 'vol_vwnym366kn7k8mmv'


class Boundary(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.calls = []
        self.lease_nonce = None
        self.request_context = threading.local()
        self.mode = ''
        self.pause = threading.Event()
        self.release = threading.Event()
        self.limit = 10
        self.apps = [{'Name': APP, 'Organization': {'Slug': 'personal'}},
                     {'Name': 'other', 'Organization': {'Slug': 'personal'}}]
        self.machines = {DONOR: {'id': DONOR, 'name': 'cloudbench-warm', 'region': 'iad',
            'instance_id': 'original', 'state': 'started',
            'image_ref': {'digest': 'sha256:' + 'e' * 64},
            'config': {'image': 'registry.fly.io/bench@sha256:' + 'e' * 64,
                'env': {'TARGET': 'original', 'PRIVATE': 'never-print-this'},
                'mounts': [{'volume': VOL, 'path': '/data'}],
                'metadata': {'foreign_owner': 'foreign', 'rose_cloudbench_deps_' + hashlib.sha256(('a' * 64 + '\0' + 'b' * 64).encode()).hexdigest()[:32]: 'a' * 64 + ' ' + 'b' * 64 + ' 1794182400 vs_good ' + VOL + ' ' + DONOR + ' ' + APP},
                'guest': {'cpus': 8, 'cpu_kind': 'performance', 'memory_mb': 16384}}}}
        self.volumes = {VOL: {'id': VOL, 'name': 'donor', 'region': 'iad',
            'state': 'created', 'size_gb': 40, 'attached_machine_id': DONOR}}
        self.snapshots = [{'id': 'vs_good', 'status': 'created', 'size': 100,
                           'digest': 'f' * 64, 'created_at': '2026-11-09T00:00:00Z'}]
        test = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_GET(self): self.handle_request('GET')
            def do_POST(self): self.handle_request('POST')
            def do_DELETE(self): self.handle_request('DELETE')
            def handle_request(self, method):
                body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'null')
                test.request_context.nonce = self.headers.get('fly-machine-lease-nonce')
                test.calls.append((method, self.path, body))
                code, result = test.respond(method, self.path, body)
                raw = json.dumps(result).encode()
                self.send_response(code)
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                try:
                    self.wfile.write(raw)
                except BrokenPipeError:
                    # The interruption test deliberately closes the client before ACK.
                    pass
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        base = 'http://127.0.0.1:' + str(self.server.server_port)
        binary = self.root / 'flyctl'
        binary.write_text('#!/usr/bin/env python3\nimport json,os,sys\nassert sys.argv[1:] == ["apps","list","--org","personal","--json"]\nprint(open(os.environ["FAKE_APPS"]).read())\n')
        binary.chmod(0o700)
        self.env = {**os.environ, 'PATH': str(self.root) + ':' + os.environ['PATH'],
                    'FLY_API_TOKEN': 'fake-token', 'FLY_FLAPS_BASE_URL': base,
                    'FLY_GRAPHQL_URL': base + '/graphql', 'CLOUDBENCH_CAPACITY_RESERVATION_ROOT': str(self.root / 'reservations'), 'FAKE_APPS': str(self.root / 'apps.json')}
        self.args = ['create', '--journal', str(self.root / 'journal'), '--owner-token', OWNER,
                     '--donor-machine-id', DONOR, '--donor-volume-id', VOL,
                     '--snapshot-id', 'vs_good', '--org', 'personal',
                     '--reserved-slots', '1', '--headroom', '1', '--extra-destroying-count', '1']

    def tearDown(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def respond(self, method, path, body):
        if path == '/graphql':
            return 200, {'data': {'organization': {'slug': 'personal', 'settings':
                {'machines_per_org_limit': self.limit}, 'billingStatus': 'current'}}}
        prefix = '/v1/apps/' + APP
        if path == '/v1/apps/other/machines?summary=true':
            return (503, {}) if self.mode == 'missing-app' else (200, [{'id': '11111111111111'}])
        suffix = path.removeprefix(prefix)
        nonce = getattr(self.request_context, 'nonce', None)
        if suffix == '/machines/22222222222222/lease':
            if '22222222222222' not in self.machines: return 404, {}
            if method == 'POST':
                if self.lease_nonce and nonce != self.lease_nonce: return 409, {}
                self.lease_nonce = 'lease-owned'
                return 201, {'data': {'nonce': self.lease_nonce}}
            if method == 'DELETE':
                if nonce != self.lease_nonce: return 409, {}
                self.lease_nonce = None
                return 200, {}
        if suffix.startswith('/machines/22222222222222/metadata/'):
            if not self.lease_nonce or nonce != self.lease_nonce: return 409, {}
            key = suffix.rsplit('/', 1)[1]
            meta = self.machines['22222222222222']['config']['metadata']
            if method == 'POST': meta[key] = body['value']
            elif method == 'DELETE': meta.pop(key, None)
            return 200, {}
        if method == 'DELETE' and suffix == '/machines/22222222222222':
            if not self.lease_nonce or nonce != self.lease_nonce: return 409, {}
        if suffix == '/volumes/vol_owned/snapshots' and method == 'GET' and not hasattr(self, 'preparation_request'):
            return 200, getattr(self, 'own_snapshots', [])
        if hasattr(self, 'preparation_request'):
            handled = self.prepare_response(method, suffix, body)
            if handled is not None: return handled
        if suffix in ('/machines?summary=true', '/machines') and method == 'GET': return 200, list(self.machines.values())
        if suffix == '/volumes':
            if method == 'GET': return 200, list(self.volumes.values())
            if self.mode == 'volume-ambiguous': return 503, {'private': 'never-print-this'}
            row = {'id': 'vol_owned', 'name': body['name'], 'region': 'iad', 'state': 'created',
                   'size_gb': 40, 'attached_machine_id': None}
            if self.mode == 'protected-volume': row['id'] = VOL
            self.volumes[row['id']] = row
            return 202, row
        if suffix == '/machines' and method == 'POST':
            # Durable volume receipt MUST already exist at this first Machine write.
            self.assert_volume_journal = (self.root / 'journal/volume.created.json').exists()
            if self.mode == 'machine-ambiguous': return 503, {'private': 'never-print-this'}
            if self.mode == 'quota': return 429, {'error': 'quota never-print-this'}
            if self.mode == 'interrupt-machine':
                self.pause.set()
                self.release.wait(5)
            row = {'id': '22222222222222', 'instance_id': 'newinstance', 'state': 'created',
                   'image_ref': {'digest': 'sha256:' + 'e' * 64}, **body}
            self.machines[row['id']] = row
            self.volumes['vol_owned']['attached_machine_id'] = row['id']
            return 201, row
        if suffix == '/volumes/' + VOL + '/snapshots': return 200, self.snapshots
        if suffix.startswith('/machines/'):
            identity = suffix.split('/')[2]
            if identity not in self.machines: return 404, {}
            if method == 'DELETE':
                del self.machines[identity]
                if self.mode == 'delete-lost-response':
                    self.volumes['vol_owned']['attached_machine_id'] = None
                    return 503, {}
                self.volumes['vol_owned']['attached_machine_id'] = None
                return 200, {}
            return 200, self.machines[identity]
        if suffix.startswith('/volumes/'):
            identity = suffix.split('/')[2]
            if identity not in self.volumes: return 404, {}
            if method == 'DELETE':
                if self.mode == 'volume-pending-destroy':
                    self.volumes[identity]['state'] = 'pending_destroy'
                    return 202, {}
                del self.volumes[identity]
                return 200, {}
            return 200, self.volumes[identity]
        return 404, {}

    def run_cli(self, args=None):
        (self.root / 'apps.json').write_text(json.dumps(self.apps))
        result = subprocess.run([sys.executable, str(CLI), *(args or self.args)],
                                env=self.env, capture_output=True, text=True, timeout=15)
        self.assertNotIn('never-print-this', result.stdout + result.stderr)
        return result

    def writes(self):
        return [x for x in self.calls if x[0] != 'GET' and x[1] != '/graphql' and not x[1].endswith('/lease')]

    def test_create_parked_exact_owned_and_reuse_without_allocation(self):
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value['machine_id'], '22222222222222')
        self.assertTrue(self.assert_volume_journal)
        self.assertEqual(len(self.writes()), 2)
        body = self.writes()[-1][2]
        self.assertTrue(body['skip_launch'])
        self.assertEqual(body['name'], 'cloudbench-source-' + OWNER)
        self.assertEqual(body['config']['metadata']['cloudbench_source_owner'], OWNER)
        self.assertEqual(body['config']['env'], self.machines[DONOR]['config']['env'])
        self.assertEqual(body['config']['guest'], {'cpu_kind': 'shared', 'cpus': 1, 'memory_mb': 2048})
        self.assertEqual(self.run_cli().returncode, 0)
        self.assertEqual(len(self.writes()), 2)

    def test_capacity_all_apps_reservations_and_headroom(self):
        self.limit = 5  # 2 native + 1 reservation + 1 destroying + 1 headroom leaves zero.
        result = self.run_cli()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.writes())
        self.assertIn('/v1/apps/other/machines?summary=true', [c[1] for c in self.calls])

    def test_incomplete_scope_or_snapshot_refuses_before_write(self):
        for mode in ['missing-app', 'snapshot']:
            with self.subTest(mode=mode):
                self.mode = mode
                if mode == 'snapshot': self.snapshots[0]['status'] = 'running'
                self.assertNotEqual(self.run_cli().returncode, 0)
                self.assertFalse(self.writes())

    def test_ambiguous_create_never_retries_or_adopts(self):
        for mode in ['volume-ambiguous', 'machine-ambiguous']:
            with self.subTest(mode=mode):
                self.mode = mode
                self.args[2] = str(self.root / mode)
                first = self.run_cli()
                self.assertNotEqual(first.returncode, 0)
                count = len(self.writes())
                self.assertNotEqual(self.run_cli().returncode, 0)
                self.assertEqual(len(self.writes()), count)

    def test_foreign_name_or_owner_cannot_be_reused(self):
        self.machines['832717a71940d8'] = {'id': '832717a71940d8', 'name': 'cloudbench-source-' + OWNER,
            'config': {'metadata': {'cloudbench_source_owner': 'a67a0f74e9f12f9b8ab68f7f2544975c'}}}
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertFalse(self.writes())

    def test_tamper_intent_receipt_and_native_owner_fail_closed(self):
        self.assertEqual(self.run_cli().returncode, 0)
        baseline = len(self.writes())
        machine = self.machines['22222222222222']
        machine['config']['metadata']['cloudbench_source_owner'] = 'b' * 32
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertEqual(len(self.writes()), baseline)
        machine['config']['metadata']['cloudbench_source_owner'] = OWNER
        receipt = self.root / 'journal/machine.created.json'
        original = receipt.read_bytes()
        changed = json.loads(original)
        changed['id'] = DONOR
        receipt.write_text(json.dumps(changed))
        self.assertNotEqual(self.run_cli().returncode, 0)
        receipt.write_bytes(original)
        self.args[-1] = '2'
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertEqual(len(self.writes()), baseline)

    def test_cleanup_exact_receipts_only_and_protects_donors(self):
        self.assertEqual(self.run_cli().returncode, 0)
        result = self.run_cli(['cleanup', *self.args[1:]])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(self.machines), {DONOR})
        self.assertEqual(set(self.volumes), {VOL})
        self.assertTrue(all(DONOR not in x[1] and VOL not in x[1] for x in self.writes()))

    def test_participating_reader_is_fenced_during_native_retirement(self):
        self.assertEqual(self.run_cli().returncode, 0)
        actual = self.respond
        attempts = []
        def after_observation(method, path, body):
            answer = actual(method, path, body)
            if method == 'GET' and path == '/v1/apps/navi-whisper-lux-bench/machines':
                status, _ = actual('POST', '/v1/apps/navi-whisper-lux-bench/machines/22222222222222/lease',
                                   {'ttl': 180, 'description': 'cloudbench-source-lease-v1'})
                attempts.append(status)
                if status == 201:
                    self.machines['33333333333333'] = {'id': '33333333333333', 'config': {
                        'metadata': {'cloudbench_clone_source': '22222222222222'}, 'mounts': []}}
            return answer
        self.respond = after_observation
        result = self.run_cli(['cleanup', *self.args[1:]])
        self.assertEqual(attempts, [409], 'reader crossed the native retirement lease')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('33333333333333', self.machines)
        self.assertEqual(self.respond('POST', '/v1/apps/' + APP + '/machines/22222222222222/lease', {})[0], 404)

    def test_expired_consumer_lease_with_durable_claim_refuses_retirement(self):
        self.assertEqual(self.run_cli().returncode, 0)
        self.machines['22222222222222']['config']['metadata']['cloudbench_source_consumer_' + 'c' * 32] = 'durable-orphan'
        count = len([c for c in self.calls if c[0] == 'DELETE' and '/lease' not in c[1]])
        result = self.run_cli(['cleanup', *self.args[1:]])
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(count, len([c for c in self.calls if c[0] == 'DELETE' and '/lease' not in c[1]]))
        self.assertIn('22222222222222', self.machines)

    def test_readonly_bootstrap_verifier_and_tamper(self):
        self.assertEqual(self.run_cli().returncode, 0)
        creator = runpy.run_path(str(CLI))
        path = self.root / 'journal/result.json'
        calls = len(self.calls)
        result = creator['verify_created_source'](path)
        self.assertEqual(result['machine']['id'], '22222222222222')
        self.assertEqual(result['donor']['dependency_proof']['node_fingerprint'], 'a' * 64)
        self.assertEqual(len(self.calls), calls)
        pending = self.root / 'journal/machine.pending.json'
        value = json.loads(pending.read_text())
        value['request']['config']['env']['PRIVATE'] = 'tampered'
        pending.write_text(json.dumps(value))
        with self.assertRaises(ValueError): creator['verify_created_source'](path)

    def test_observed_normal_fleet_reservations_are_counted_never_pruned(self):
        directory = self.root / 'reservations/reservations'
        directory.mkdir(parents=True)
        receipt = directory / 'foreign-primary'
        receipt.write_text('version=1\napp=' + APP + '\nhost=another-host\npid=999999\npid_start=unknown\nrun_id=foreign\ntoken=foreign-primary\nmachine_slots=100\nshared_units=0\nkind=primary\n')
        self.limit = 100
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertFalse(self.writes())
        self.assertTrue(receipt.exists())
        receipt.write_text('not a valid reservation')
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertFalse(self.writes())

    def test_environment_change_between_volume_and_machine_refuses(self):
        original = self.respond
        def changed(method, path, body):
            result = original(method, path, body)
            if method == 'POST' and path.endswith('/volumes'):
                self.machines[DONOR]['config']['env']['TARGET'] = 'changed'
            return result
        self.respond = changed
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertEqual(len(self.writes()), 1)
        self.assertEqual(self.writes()[0][1], '/v1/apps/' + APP + '/volumes')
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertEqual(len(self.writes()), 1)

    def test_acknowledged_unattached_volume_cleanup_after_pre_machine_failure(self):
        original = self.respond
        def changed(method, path, body):
            result = original(method, path, body)
            if method == 'POST' and path.endswith('/volumes'):
                self.machines[DONOR]['config']['env']['TARGET'] = 'changed'
            return result
        self.respond = changed
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertFalse((self.root / 'journal/machine.pending.json').exists())
        result = self.run_cli(['cleanup', *self.args[1:]])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(self.volumes), {VOL})
        self.assertEqual(set(self.machines), {DONOR})

    def test_donor_attestation_and_wrong_snapshot_fail_before_write(self):
        metadata = self.machines[DONOR]['config']['metadata']
        metadata.clear()
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertFalse(self.writes())

    def test_quota_native_rejection_is_not_create_retry_authority(self):
        self.mode = 'quota'
        self.assertNotEqual(self.run_cli().returncode, 0)
        count = len(self.writes())
        self.mode = ''
        failure = json.loads((self.root / 'journal/machine.failed.json').read_text())
        self.assertEqual(failure['native_http_status'], 429)
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertEqual(len(self.writes()), count)

    def test_protected_volume_response_cannot_grant_cleanup_rights(self):
        self.mode = 'protected-volume'
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertFalse((self.root / 'journal/volume.created.json').exists())
        self.assertNotEqual(self.run_cli(['cleanup', *self.args[1:]]).returncode, 0)
        self.assertFalse(any(c[0] == 'DELETE' for c in self.calls))

    def test_interruption_between_machine_post_and_ack_retains_no_retry(self):
        self.mode = 'interrupt-machine'
        (self.root / 'apps.json').write_text(json.dumps(self.apps))
        process = subprocess.Popen([sys.executable, str(CLI), *self.args], env=self.env,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertTrue(self.pause.wait(5), 'Machine POST not observed')
            process.send_signal(signal.SIGTERM)
            stdout, stderr = process.communicate(timeout=5)
            self.assertNotEqual(process.returncode, 0)
            self.assertTrue((self.root / 'journal/volume.created.json').exists())
            self.assertFalse((self.root / 'journal/machine.created.json').exists())
            count = len(self.writes())
            self.assertNotEqual(self.run_cli().returncode, 0)
            self.assertNotEqual(self.run_cli(['cleanup', *self.args[1:]]).returncode, 0)
            self.assertEqual(len(self.writes()), count)
        finally:
            self.release.set()
            if process.poll() is None:
                process.terminate()
                process.communicate(timeout=5)

    def test_interrupted_delete_resumes_by_positive_absence_without_repeating(self):
        self.assertEqual(self.run_cli().returncode, 0)
        self.mode = 'delete-lost-response'
        self.assertNotEqual(self.run_cli(['cleanup', *self.args[1:]]).returncode, 0)
        self.mode = ''
        result = self.run_cli(['cleanup', *self.args[1:]])
        self.assertEqual(result.returncode, 0, result.stderr)
        machine_deletes = [c for c in self.calls if c[0] == 'DELETE' and c[1].endswith('/machines/22222222222222')]
        self.assertEqual(len(machine_deletes), 1)
        self.assertEqual(set(self.machines), {DONOR})

    def test_native_pending_destroy_volume_confirms_exact_retirement(self):
        self.assertEqual(self.run_cli().returncode, 0)
        self.mode = 'volume-pending-destroy'
        result = self.run_cli(['cleanup', *self.args[1:]])
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads((self.root / 'journal/volume.deleted.json').read_text())
        self.assertEqual(receipt['id'], 'vol_owned')
        self.assertEqual(receipt['native_state'], 'pending_destroy')
        self.assertEqual(self.volumes['vol_owned']['state'], 'pending_destroy')
        self.assertEqual(set(self.machines), {DONOR})

    def test_foreign_or_symlink_journal_never_admitted(self):
        target = self.root / 'actual'
        target.mkdir(mode=0o700)
        (self.root / 'journal').symlink_to(target, target_is_directory=True)
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertFalse(self.calls)

    def test_source_consumer_blocks_cleanup_without_mutation(self):
        self.assertEqual(self.run_cli().returncode, 0)
        self.machines['33333333333333'] = {'id': '33333333333333', 'config': {
            'metadata': {'cloudbench_source_owner': OWNER}, 'mounts': []}}
        count = len(self.writes())
        result = self.run_cli(['cleanup', *self.args[1:]])
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(self.writes()), count)

    def test_changed_prepared_image_needs_authenticated_successor_receipts(self):
        self.assertEqual(self.run_cli().returncode, 0)
        self.machines['22222222222222']['instance_id'] = 'prepared'
        self.machines['22222222222222']['config']['image'] = 'registry.fly.io/bench@sha256:' + 'd' * 64
        count = len(self.writes())
        self.assertNotEqual(self.run_cli(['cleanup', *self.args[1:]]).returncode, 0)
        self.assertEqual(len(self.writes()), count)

    def prepare_response(self, method, path, body):
        mid = '22222222222222'
        target = '/machines/' + mid
        if path == target + '/lease':
            return (201, {'data': {'nonce': 'lease-owned'}}) if method == 'POST' else (200, {})
        if method == 'POST' and path == target:
            self.machines[mid]['config'] = body['config']
            self.machines[mid]['instance_id'] = self.machines[mid]['instance_id'] + 'next'
            self.machines[mid]['state'] = 'stopped'
            self.machines[mid]['image_ref']['digest'] = body['config']['image'].rsplit('@', 1)[1]
            return 200, self.machines[mid]
        if method == 'POST' and path in (target + '/start', target + '/stop'):
            self.machines[mid]['state'] = 'started' if path.endswith('/start') else 'stopped'
            return 200, {}
        if path == target + '/exec':
            marker = re.search(r'CLOUDBENCH-DELIVERY:[0-9]+', body['command'][-1])
            if marker:
                return 200, {'exit_code': 0, 'stdout': marker.group(0)}
            if 'subprocess.Popen' in body['command'][-1]:
                return 200, {'exit_code': 0, 'stdout': json.dumps(dict(pid=42, birth='123', boot='12345678-1234-1234-1234-123456789abc'))}
            r = self.preparation_request
            guest = {key: r[key] for key in ('nonce', 'source_ref', 'node_fingerprint', 'python_fingerprint', 'guest_env_sha256')}
            guest.update(job=dict(pid=42, birth='123', boot='12345678-1234-1234-1234-123456789abc'), schema='cloudbench-source-guest-v1', machine_id=mid, mount='/data', guest_exit=0,
                         installed_node=r['node_fingerprint'], installed_python=r['python_fingerprint'],
                         image_node_fingerprint=r['node_fingerprint'], image_python_fingerprint=r['python_fingerprint'],
                         started_epoch=int(time.time()), finished_epoch=int(time.time()))
            return 200, {'exit_code': 0, 'stdout': json.dumps(guest)}
        if path == '/volumes/vol_owned/snapshots':
            row = dict(id='vs_prepared', status='created', size=100, digest='d' * 64,
                       created_at=datetime.now(timezone.utc).isoformat())
            if method == 'POST':
                self.prepared_snapshot = row
                return 201, row
            return 200, [self.prepared_snapshot]
        if path == '/machines/811d632f2650e8':
            return 200, dict(id='811d632f2650e8', config={'mounts': [{'volume': 'vol_r1jde9donnx2mn9r', 'path': '/data'}]})
        return None

    def test_real_creator_preparer_and_authenticated_successor_retirement(self):
        self.assertEqual(self.run_cli().returncode, 0)
        helper = runpy.run_path(str(ROOT / 'scripts/cloudbench-prepare-source.py'))
        created = json.loads((self.root / 'journal/result.json').read_text())
        ref = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip()
        image = 'registry.fly.io/navi-whisper-lux-bench@sha256:' + 'd' * 64
        def private_write(path, value):
            path.write_text(json.dumps(value))
            path.chmod(0o600)
        build = self.root / 'build.json'
        private_write(build, dict(schema='cloudbench-image-build-v1', image_ref=image, source_sha=ref, source_dirty=False))
        self.preparation_request = dict(schema=helper['REQUEST'], nonce='c' * 32,
            source_root=str(ROOT), source_ref=ref, image_ref=image, node_fingerprint='a' * 64,
            python_fingerprint='b' * 64, ownership=helper['descriptor'](self.root / 'journal/result.json'),
            build=helper['descriptor'](build), native={k: created[k] for k in ('machine_id', 'volume_id', 'instance_id', 'config_sha256', 'env_sha256')},
            guest_env_sha256={'AGENTS_ENV_B64': 'e' * 64, 'BACKEND_ENV_B64': 'f' * 64},
            protected_resources={DONOR: VOL, '811d632f2650e8': 'vol_r1jde9donnx2mn9r'},
            scripts={member: helper['sha'](helper['source_bytes'](ROOT, ref, member))
                     for member in ('cloudbench-fetch-ref.sh', 'lib/cloudbench-env.sh', 'cloudbench-sync-deps.sh')})
        request = self.root / 'prepare-request.json'
        private_write(request, self.preparation_request)
        output = self.root / 'prepared'
        env = dict(self.env, FLY_API_HOSTNAME=self.env['FLY_FLAPS_BASE_URL'])
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/cloudbench-prepare-source.py'),
                                '--request', str(request), '--output', str(output)],
                                env=env, capture_output=True, text=True, timeout=35)
        self.assertEqual(result.returncode, 0, result.stderr)
        cleanup_args = ['cleanup', *self.args[1:], '--prepared-request', str(request),
                        '--prepared-result', str(output / 'result.json'),
                        '--prepared-manifest', str(output / 'source-manifest.json')]
        result = self.run_cli(cleanup_args)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(self.machines), {DONOR})
        self.assertEqual(set(self.volumes), {VOL})


if __name__ == '__main__': unittest.main()
