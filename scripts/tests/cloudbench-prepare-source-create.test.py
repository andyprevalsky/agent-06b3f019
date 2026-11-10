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
import shutil
import time
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
from types import SimpleNamespace

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
                   'size_gb': 40, 'encrypted': True, 'attached_machine_id': None, 'created_at': datetime.now(timezone.utc).isoformat()}
            if self.mode == 'protected-volume': row['id'] = VOL
            self.volumes[row['id']] = row
            if self.mode == 'lost-volume-ack':
                row['state'] = 'restoring'
                return 503, {}
            return 202, row
        if suffix == '/machines' and method == 'POST':
            # Durable volume receipt MUST already exist at this first Machine write.
            self.assert_volume_journal = any((self.root / ('journal/'+name)).exists() for name in
                                             ('volume.created.json', 'volume.reconciled.json'))
            if self.mode == 'machine-ambiguous': return 503, {'private': 'never-print-this'}
            if self.mode == 'quota': return 429, {'error': 'quota never-print-this'}
            if self.mode == 'interrupt-machine':
                self.pause.set()
                self.release.wait(5)
            row = {'id': '22222222222222', 'instance_id': 'newinstance', 'state': 'created',
                   'created_at': datetime.now(timezone.utc).isoformat(),
                   'image_ref': {'digest': 'sha256:' + 'e' * 64}, **copy.deepcopy(body)}
            if self.mode in ('normalized-machine', 'lost-machine-ack'):
                row['config'].pop('auto_destroy')
                if not row['config']['env']: row['config'].pop('env')
                row['config']['mounts'][0].update(name='cbs_' + OWNER[:26], size_gb=40, encrypted=True)
                row['state'] = 'stopped'
            self.machines[row['id']] = row
            self.volumes['vol_owned']['attached_machine_id'] = row['id']
            if self.mode == 'lost-machine-ack': return 503, {}
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

    def test_native_machine_omitted_defaults_and_volume_metadata(self):
        self.machines[DONOR]['config']['env'] = {}
        self.mode = 'normalized-machine'
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.writes()), 2)
        self.assertEqual(self.run_cli().returncode, 0)
        self.assertEqual(len(self.writes()), 2)

    def make_ambiguous_machine(self):
        self.machines[DONOR]['config']['env'] = {}
        self.mode = 'lost-machine-ack'
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.mode = ''
        journal = self.root/'journal'
        self.assertTrue((journal/'machine.pending.json').exists())
        self.assertFalse((journal/'machine.created.json').exists())
        self.assertEqual(len(self.writes()), 2)
        return journal

    def test_lost_machine_ack_explicit_get_only_receipt_then_prepare_authority(self):
        journal = self.make_ambiguous_machine()
        original = {p.name:p.read_bytes() for p in journal.glob('*.json')}
        before = len(self.calls)
        result = self.run_cli(['reconcile-machine', *self.args[1:]])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(all(call[0] == 'GET' for call in self.calls[before:]))
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt['authority_kind'], 'reconciled-ambiguous-machine-create')
        self.assertFalse((journal/'machine.created.json').exists())
        for name, raw in original.items(): self.assertEqual((journal/name).read_bytes(), raw)
        self.assertEqual(self.run_cli().returncode, 0)
        self.assertEqual(len(self.writes()), 2)
        helper = runpy.run_path(str(CLI))
        authority = helper['verify_created_source'](journal/'result.json')
        self.assertEqual(authority['machine_authority'], 'reconciled-ambiguous-machine-create')
        native = self.machines['22222222222222']['config']
        self.assertEqual(authority['machine']['config'], native)
        self.assertEqual(json.loads((journal/'result.json').read_text())['config_sha256'],
                         hashlib.sha256(json.dumps(native, sort_keys=True, separators=(',', ':')).encode()).hexdigest())

    def test_reconcile_machine_real_preparer_and_authenticated_retirement(self):
        self.machine_reconcile_before_prepare = True
        self.test_real_creator_preparer_and_authenticated_successor_retirement()

    def test_failed_prestart_recovery_fresh_prepare_and_authenticated_retirement(self):
        self.recover_before_prepare = True
        self.test_real_creator_preparer_and_authenticated_successor_retirement()

    def test_reconciled_machine_stdout_never_discloses_inventory_environment(self):
        self.make_ambiguous_machine()
        self.machines['33333333333333'] = dict(id='33333333333333', name='foreign',
            config={'env': {'PRIVATE': 'never-print-this'}})
        result=self.run_cli(['reconcile-machine',*self.args[1:]])
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout)['id'],'22222222222222')

    def test_reconcile_machine_forged_native_identity_config_defaults_and_mount_refuse(self):
        journal = self.make_ambiguous_machine()
        original = copy.deepcopy(self.machines['22222222222222'])
        volume = copy.deepcopy(self.volumes['vol_owned'])
        mutations = ['owner','nonce','intent','protocol','image','digest','region','instance','active',
                     'init','guest','guest-type','restart','extra-config','extra-mount','mount-extra','mount-name',
                     'mount-size','mount-encryption','default-true','default-zero','env-null','env-change',
                     'protected','wrong-time','attachment','duplicates']
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                self.machines = {DONOR:self.machines[DONOR], '22222222222222':copy.deepcopy(original)}
                self.volumes['vol_owned'] = copy.deepcopy(volume)
                row=self.machines['22222222222222'];config=row['config'];mount=config['mounts'][0]
                if mutation in ('owner','nonce','intent','protocol'):
                    key={'owner':'owner','nonce':'create_nonce','intent':'create_intent','protocol':'protocol'}[mutation]
                    config['metadata']['cloudbench_source_'+key]='forged'
                elif mutation=='image':config['image']='registry.fly.io/bench@sha256:'+'f'*64
                elif mutation=='digest':row['image_ref']['digest']='sha256:'+'f'*64
                elif mutation=='region':row['region']='ams'
                elif mutation=='instance':row['instance_id']=''
                elif mutation=='active':row['state']='started'
                elif mutation=='init':config['init']={'cmd':['echo','unsafe']}
                elif mutation=='guest':config['guest']['cpus']=2
                elif mutation=='guest-type':config['guest']['cpus']=True
                elif mutation=='restart':config['restart']={'policy':'always'}
                elif mutation=='extra-config':config['services']=[]
                elif mutation=='extra-mount':config['mounts'].append(dict(mount))
                elif mutation=='mount-extra':mount['unrecognized']=False
                elif mutation=='mount-name':mount['name']='foreign'
                elif mutation=='mount-size':mount['size_gb']=True
                elif mutation=='mount-encryption':mount['encrypted']=False
                elif mutation=='default-true':config['auto_destroy']=True
                elif mutation=='default-zero':config['auto_destroy']=0
                elif mutation=='env-null':config['env']=None
                elif mutation=='env-change':config['env']={'NEW':'foreign'}
                elif mutation=='protected':row['id']=DONOR
                elif mutation=='wrong-time':row['created_at']='2026-01-01T00:00:00Z'
                elif mutation=='attachment':self.volumes['vol_owned']['attached_machine_id']=DONOR
                elif mutation=='duplicates':self.machines['33333333333333']=dict(row,id='33333333333333')
                before=len(self.writes())
                self.assertNotEqual(self.run_cli(['reconcile-machine', *self.args[1:]]).returncode,0)
                self.assertEqual(len(self.writes()),before)
                self.assertFalse((journal/'machine.reconciled.json').exists())

    def test_reconcile_machine_original_inventory_failure_and_receipt_tamper_refuse(self):
        journal=self.make_ambiguous_machine()
        for name in ('machine.pending.json','machine.failed.json'):
            path=journal/name;original=path.read_bytes();value=json.loads(original)
            if 'failed' in name:value['outcome']='native-rejected';value['native_http_status']=429
            else:value['precreate']['sha256']='0'*64
            path.write_text(json.dumps(value))
            self.assertNotEqual(self.run_cli(['reconcile-machine',*self.args[1:]]).returncode,0)
            path.write_bytes(original)
        self.assertEqual(self.run_cli(['reconcile-machine',*self.args[1:]]).returncode,0)
        path=journal/'machine.reconciled.json';value=json.loads(path.read_bytes())
        value['response']['config']['metadata']['cloudbench_source_owner']='f'*32
        value['response_sha256']=runpy.run_path(str(CLI))['sha'](value['response'])
        path.write_text(json.dumps(value))
        before=len(self.writes());self.assertNotEqual(self.run_cli().returncode,0)
        self.assertEqual(len(self.writes()),before)

    def test_successful_native_response_is_saved_before_semantic_refusal(self):
        actual=self.respond
        def wrong(method,path,body):
            status,row=actual(method,path,body)
            if method=='POST' and path.endswith('/machines') and status==201:
                row['config']['services']=[]
            return status,row
        self.respond=wrong
        self.assertNotEqual(self.run_cli().returncode,0)
        journal=self.root/'journal'
        raw=json.loads((journal/'machine.response.raw.json').read_bytes())
        self.assertEqual(raw['id'],'22222222222222')
        self.assertTrue((journal/'machine.response.json').exists())
        self.assertFalse((journal/'machine.created.json').exists())
        self.assertNotEqual(self.run_cli().returncode,0)
        self.assertEqual(len(self.writes()),2)

    def test_recovered_retirement_checks_original_custody_before_successor_verifier(self):
        """Creator trust boundary; recovery and successful-prepare verifiers are explicit doubles."""
        self.assertEqual(self.run_cli().returncode, 0)
        creator=runpy.run_path(str(CLI));journal=self.root/'journal'
        intent=creator['read'](journal/'intent.json')
        original=creator['verify_created_source'](journal/'result.json')
        recovered=copy.deepcopy(original)
        recovered['original_creator']=dict(path=str(journal/'result.json'),sha256=creator['raw_sha'](journal/'result.json'))
        recovered['machine'].update(state='stopped',instance_id='recovered')
        recovered['machine']['config']['image']='registry.fly.io/navi-whisper-lux-bench@sha256:'+'d'*64
        recovered['volume']=copy.deepcopy(self.volumes['vol_owned'])
        recovery_path=self.root/'recovered-bootstrap.json'
        creator['save'](recovery_path,dict(schema='cloudbench-recovered-bootstrap-v1',qualified=False,credit_granted=False))
        request_path=self.root/'new-request.json';result_path=self.root/'new-result.json';manifest_path=self.root/'new-manifest.json'
        image='registry.fly.io/navi-whisper-lux-bench@sha256:'+'f'*64
        request=dict(ownership=dict(path=str(recovery_path),sha256=creator['raw_sha'](recovery_path)),
                     image_ref=image,source_ref='b'*40,node_fingerprint='a'*64,python_fingerprint='b'*64)
        creator['save'](request_path,request)
        after=copy.deepcopy(recovered['machine']);after['instance_id']='new-success';after['config']['image']=image
        after_path=self.root/'new-after.json';creator['save'](after_path,after)
        creator['save'](result_path,dict(after=dict(path=str(after_path),sha256=creator['raw_sha'](after_path))))
        creator['save'](manifest_path,{})
        verified=Mock(return_value=dict(owner_token=OWNER,machine_id='22222222222222',volume_id='vol_owned',instance_id='new-success'))
        helper=dict(resolve_bootstrap_ownership=lambda path:copy.deepcopy(recovered),verify_prepared_source=verified,
                    described=lambda descriptor:creator['read'](Path(descriptor['path'])))
        actual=runpy.run_path
        def load(path,*args,**kwargs):
            if Path(path)==ROOT/'scripts/cloudbench-prepare-source.py':return helper
            return actual(path,*args,**kwargs)
        args=SimpleNamespace(prepared_request=request_path,prepared_result=result_path,prepared_manifest=manifest_path)
        baseline=copy.deepcopy(recovered)
        mutations=['original-path','original-sha','journal','intent','machine','volume','mount','owner','nonce','claim','shape','state','version']
        before=len(self.writes())
        with patch.object(runpy,'run_path',side_effect=load):
            for mutation in mutations:
                recovered.clear();recovered.update(copy.deepcopy(baseline))
                if mutation=='original-path':recovered['original_creator']['path']=str(self.root/'foreign-result.json')
                elif mutation=='original-sha':recovered['original_creator']['sha256']='0'*64
                elif mutation=='journal':recovered['journal']=str(self.root/'foreign-journal')
                elif mutation=='intent':recovered['intent']['nonce']='0'*32
                elif mutation=='machine':recovered['machine']['id']=DONOR
                elif mutation=='volume':recovered['volume']['id']=VOL
                elif mutation=='mount':recovered['machine']['config']['mounts'][0]['volume']=VOL
                elif mutation=='owner':recovered['machine']['config']['metadata']['cloudbench_source_owner']='f'*32
                elif mutation=='nonce':recovered['machine']['config']['metadata']['cloudbench_source_create_nonce']='f'*32
                elif mutation=='claim':recovered['machine']['config']['metadata']['cloudbench_source_consumer_'+'f'*32]='open'
                elif mutation=='shape':recovered['machine']['config']['guest']['cpus']=4
                elif mutation=='state':recovered['machine']['state']='started'
                elif mutation=='version':recovered['machine']['instance_id']=''
                with self.subTest(mutation=mutation),self.assertRaises(ValueError):
                    creator['retirement_successor'](args,journal,intent)
                verified.assert_not_called()
                self.assertFalse((journal/'retirement.admission.json').exists())
            recovered.clear();recovered.update(copy.deepcopy(baseline))
            self.assertEqual(creator['retirement_successor'](args,journal,intent),after)
            verified.assert_called_once()
        self.assertEqual(len(self.writes()),before)

    def test_ready_native_get_shape_is_authoritative_and_sealed(self):
        self.machines[DONOR]['config']['env'] = {}
        actual=self.respond
        def normalized_get(method,path,body):
            status,row=actual(method,path,body)
            if method=='GET' and path.endswith('/machines/22222222222222'):
                row=copy.deepcopy(row);row['config'].pop('auto_destroy',None);row['config'].pop('env',None)
                row['config']['mounts'][0].update(name='cbs_'+OWNER[:26],size_gb=40,encrypted=True)
            return status,row
        self.respond=normalized_get
        result=self.run_cli();self.assertEqual(result.returncode,0,result.stderr)
        helper=runpy.run_path(str(CLI));journal=self.root/'journal'
        authority=helper['verify_created_source'](journal/'result.json')
        self.assertNotIn('env',authority['machine']['config'])
        self.assertIn('name',authority['machine']['config']['mounts'][0])
        ready=journal/'machine.ready.json';changed=json.loads(ready.read_bytes())
        changed['response']['config']['metadata']['cloudbench_source_owner']='forged';ready.write_text(json.dumps(changed))
        before=len(self.writes());self.assertNotEqual(self.run_cli().returncode,0)
        self.assertEqual(before,len(self.writes()))

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

    def test_absolute_response_deadline_preserves_class_phase_without_status_invention(self):
        creator = runpy.run_path(str(CLI))
        class Response:
            status = 202
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def read(self, *_): raise creator['DEADLINES']['Deadline']('controller action deadline')
        class Opener:
            def open(self, *_args, **_kwargs): return Response()
        native = object.__new__(creator['Native'])
        native.auth, native.opener = 'Bearer fake', Opener()
        with self.assertRaises(creator['Refusal']) as caught:
            native.request('POST', 'https://example.invalid/volumes', {'name': 'local-only'})
        self.assertEqual(caught.exception.native_status, 202)
        self.assertEqual(caught.exception.diagnostic['exception_class'], 'Deadline')
        self.assertEqual(caught.exception.diagnostic['response_phase'], 'body')
        self.assertEqual(caught.exception.diagnostic['reason'], 'absolute-response-deadline')
        self.assertFalse(self.calls)

    def make_ambiguous_volume(self):
        self.mode = 'lost-volume-ack'
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.mode = ''
        journal = self.root/'journal'
        self.assertTrue((journal/'volume.pending.json').exists())
        self.assertFalse((journal/'volume.created.json').exists())
        self.assertFalse((journal/'machine.pending.json').exists())
        return journal

    def test_owned_snapshot_fork_survives_unrelated_donor_image_activation(self):
        journal = self.make_ambiguous_volume()
        result = self.run_cli(['reconcile-volume', *self.args[1:]])
        self.assertEqual(result.returncode, 0, result.stderr)
        original = json.loads((journal/'intent.json').read_text())['donor']
        self.volumes['vol_owned']['state'] = 'created'
        self.machines[DONOR]['instance_id'] = 'different-image-activation'
        self.machines[DONOR]['config']['image'] = 'registry.fly.io/bench@sha256:' + '7'*64
        self.machines[DONOR]['image_ref']['digest'] = 'sha256:' + '7'*64
        before = len(self.writes())
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.writes()), before + 1)
        self.assertEqual(self.writes()[-1][1], '/v1/apps/' + APP + '/machines')
        self.assertEqual(self.writes()[-1][2]['config']['image'], original['image'])
        self.assertEqual(self.writes()[-1][2]['config']['mounts'], [{'volume':'vol_owned','path':'/data'}])
        self.assertFalse((journal/'volume.created.json').exists())
        self.assertTrue((journal/'volume.failed.json').exists())

    def test_owned_fork_still_refuses_snapshot_environment_mount_or_volume_tampering(self):
        self.make_ambiguous_volume()
        result = self.run_cli(['reconcile-volume', *self.args[1:]])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.volumes['vol_owned']['state'] = 'created'
        original_machine = copy.deepcopy(self.machines[DONOR])
        original_snapshot = copy.deepcopy(self.snapshots)
        original_volume = copy.deepcopy(self.volumes['vol_owned'])
        before = len(self.writes())
        for kind in ('snapshot', 'environment', 'mount', 'owned-encryption'):
            with self.subTest(kind=kind):
                self.machines[DONOR] = copy.deepcopy(original_machine)
                self.snapshots = copy.deepcopy(original_snapshot)
                self.volumes['vol_owned'] = copy.deepcopy(original_volume)
                if kind == 'snapshot': self.snapshots[0]['digest'] = '0'*64
                elif kind == 'environment': self.machines[DONOR]['config']['env']['TARGET'] = 'changed'
                elif kind == 'mount': self.machines[DONOR]['config']['mounts'][0]['volume'] = 'vol_foreign'
                else: self.volumes['vol_owned']['encrypted'] = False
                self.assertNotEqual(self.run_cli().returncode, 0)
                self.assertEqual(len(self.writes()), before)

    def test_lost_ack_reconcile_is_get_only_preserves_receipts_and_waits_for_created(self):
        journal = self.make_ambiguous_volume()
        original = {name: (journal/name).read_bytes() for name in ('intent.json', 'volume.pending.json', 'volume.failed.json')}
        writes = len(self.writes())
        result = self.run_cli(['reconcile-volume', *self.args[1:]])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.writes()), writes)
        self.assertFalse((journal/'volume.created.json').exists())
        receipt = json.loads((journal/'volume.reconciled.json').read_text())
        self.assertEqual(receipt['authority_kind'], 'reconciled-ambiguous-volume-create')
        self.assertEqual(receipt['id'], 'vol_owned')
        self.assertFalse(receipt['snapshot_lineage_verified'])
        self.assertEqual(receipt['snapshot_provenance'], 'original-writeahead-request')
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertEqual(len(self.writes()), writes)
        self.volumes['vol_owned']['state'] = 'created'
        self.assertEqual(self.run_cli().returncode, 0)
        self.assertEqual(len([c for c in self.writes() if c[1].endswith('/volumes')]), 1)
        for name, raw in original.items(): self.assertEqual((journal/name).read_bytes(), raw)
        creator = runpy.run_path(str(CLI))
        authority = creator['verify_created_source'](journal/'result.json')
        self.assertEqual(authority['volume_authority'], 'reconciled-ambiguous-volume-create')
        self.assertEqual(authority['volume']['id'], 'vol_owned')

    def test_reconciled_real_creator_preparer_verification_chain(self):
        self.reconcile_before_prepare = True
        self.test_real_creator_preparer_and_authenticated_successor_retirement()

    def test_reconcile_rejects_wrong_time_duplicates_protected_and_native_rejection(self):
        journal = self.make_ambiguous_volume()
        row = self.volumes['vol_owned']; original = dict(row)
        writes = len(self.writes())
        for mutation in ('wrong-time', 'duplicates', 'protected', 'attached', '4xx'):
            with self.subTest(mutation=mutation):
                self.volumes['vol_owned'] = dict(original)
                row = self.volumes['vol_owned']
                failed_path = journal/'volume.failed.json'; failed_raw = failed_path.read_bytes()
                if mutation == 'wrong-time': row['created_at'] = '2020-01-01T00:00:00Z'
                if mutation == 'duplicates': self.volumes['vol_other'] = dict(row, id='vol_other')
                if mutation == 'protected': row['id'] = VOL
                if mutation == 'attached': row['attached_machine_id'] = DONOR
                if mutation == '4xx':
                    failed = json.loads(failed_raw); failed.update(outcome='native-rejected', native_http_status=429)
                    failed_path.write_text(json.dumps(failed)); failed_path.chmod(0o600)
                result = self.run_cli(['reconcile-volume', *self.args[1:]])
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((journal/'volume.reconciled.json').exists())
                self.assertEqual(len(self.writes()), writes)
                self.volumes.pop('vol_other', None); failed_path.write_bytes(failed_raw)

    def test_reconcile_rejects_missing_false_or_wrongtype_encryption(self):
        journal = self.make_ambiguous_volume()
        row = self.volumes['vol_owned']
        for value in (False, None, 'true', 1):
            with self.subTest(encrypted=value):
                if value is None: row.pop('encrypted', None)
                else: row['encrypted'] = value
                result = self.run_cli(['reconcile-volume', *self.args[1:]])
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((journal/'volume.reconciled.json').exists())

    def assert_reconciled_live_encryption_change_refuses(self, action):
        journal = self.make_ambiguous_volume()
        result = self.run_cli(['reconcile-volume', *self.args[1:]])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.volumes['vol_owned'].update(state='created', encrypted=False)
        writes = len(self.writes())
        result = self.run_cli([action, *self.args[1:]])
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(self.writes()), writes)
        self.assertFalse((journal/'machine.pending.json').exists())

    def test_reconciled_current_encryption_loss_blocks_machine_admission(self):
        self.assert_reconciled_live_encryption_change_refuses('create')

    def test_reconciled_current_encryption_loss_blocks_cleanup(self):
        self.assert_reconciled_live_encryption_change_refuses('cleanup')

    def test_reconcile_rejects_postdated_or_stale_precreate_inventory(self):
        journal = self.make_ambiguous_volume()
        pending_path = journal/'volume.pending.json'
        pending = json.loads(pending_path.read_text())
        proof_path = journal/pending['precreate']['name']
        original = json.loads(proof_path.read_text())
        for observed in (time.time()+86400, time.time()-3600, float('nan'), True):
            with self.subTest(observed=observed):
                proof = dict(original, observed_epoch=observed)
                proof_path.write_text(json.dumps(proof))
                pending['precreate']['sha256'] = hashlib.sha256(proof_path.read_bytes()).hexdigest()
                pending_path.write_text(json.dumps(pending))
                result = self.run_cli(['reconcile-volume', *self.args[1:]])
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((journal/'volume.reconciled.json').exists())

    def test_reconcile_rejects_encryption_detail_disagreement_and_resealed_tamper(self):
        journal = self.make_ambiguous_volume()
        actual = self.respond
        def mismatched(method, path, body):
            status, value = actual(method, path, body)
            if method == 'GET' and path.endswith('/volumes/vol_owned'):
                value = dict(value, encrypted=False)
            return status, value
        self.respond = mismatched
        self.assertNotEqual(self.run_cli(['reconcile-volume', *self.args[1:]]).returncode, 0)
        self.assertFalse((journal/'volume.reconciled.json').exists())
        self.respond = actual
        result = self.run_cli(['reconcile-volume', *self.args[1:]])
        self.assertEqual(result.returncode, 0, result.stderr)
        path = journal/'volume.reconciled.json'
        receipt = json.loads(path.read_text())
        receipt['observed_volume']['encrypted'] = False
        for row in receipt['inventory']:
            if row['id'] == 'vol_owned': row['encrypted'] = False
        creator = runpy.run_path(str(CLI))
        receipt['inventory_sha256'] = creator['sha'](receipt['inventory'])
        path.write_text(json.dumps(receipt)); self.volumes['vol_owned']['state'] = 'created'
        writes = len(self.writes())
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertEqual(len(self.writes()), writes)
        self.assertFalse((journal/'machine.pending.json').exists())

    def test_reconcile_rejects_missing_or_tampered_original_precreate_invocation(self):
        journal = self.make_ambiguous_volume()
        pending_path = journal/'volume.pending.json'; raw = pending_path.read_bytes()
        pending = json.loads(raw)
        precreate = journal/pending['precreate']['name']
        original = precreate.read_bytes()
        precreate.write_text('{}')
        self.assertNotEqual(self.run_cli(['reconcile-volume', *self.args[1:]]).returncode, 0)
        precreate.write_bytes(original)
        pending.pop('precreate'); pending_path.write_text(json.dumps(pending))
        self.assertNotEqual(self.run_cli(['reconcile-volume', *self.args[1:]]).returncode, 0)
        self.assertFalse((journal/'volume.reconciled.json').exists())
        self.assertEqual(len([c for c in self.writes() if c[1].endswith('/volumes')]), 1)

    def prepare_response(self, method, path, body):
        mid = '22222222222222'
        target = '/machines/' + mid
        if method == 'GET' and path == target and getattr(self, 'stale_after_ack', False):
            self.stale_reads += 1
            # The first replacing predecessor triggers the old producer's
            # immediate failure. Further exact predecessor reads let its old
            # cleanup terminate without inventing a successful new-version park.
            return 200, dict(copy.deepcopy(self.stale_original), state='replacing' if self.stale_reads == 1 else 'stopped')
        if path == target + '/lease':
            return (201, {'data': {'nonce': 'lease-owned'}}) if method == 'POST' else (200, {})
        if method == 'POST' and path == target:
            self.machines[mid]['config'] = body['config']
            self.machines[mid]['instance_id'] = self.machines[mid]['instance_id'] + 'next'
            self.machines[mid]['state'] = 'stopped'
            self.machines[mid]['image_ref']['digest'] = body['config']['image'].rsplit('@', 1)[1]
            if getattr(self, 'force_prestart_failure', False): self.stale_after_ack = True; self.stale_reads = 0
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
        if getattr(self, 'machine_reconcile_before_prepare', False):
            self.make_ambiguous_machine()
            self.assertEqual(self.run_cli(['reconcile-machine', *self.args[1:]]).returncode, 0)
        if getattr(self, 'reconcile_before_prepare', False):
            self.make_ambiguous_volume()
            self.assertEqual(self.run_cli(['reconcile-volume', *self.args[1:]]).returncode, 0)
            self.volumes['vol_owned']['state'] = 'created'
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
        originals = {}
        if getattr(self, 'recover_before_prepare', False):
            # Execute the exact old producer against a real HTTP accepted CAS /
            # replacing predecessor readback. Preserve its genuine false result.
            capsule=self.root/'old-producer';capsule.mkdir()
            for path in (ROOT/'scripts').glob('*.py'):shutil.copy2(path,capsule/path.name)
            old_source=subprocess.check_output(['git','-C',str(ROOT),'show',ref+':scripts/cloudbench-prepare-source.py'])
            (capsule/'cloudbench-prepare-source.py').write_bytes(old_source)
            old=runpy.run_path(str(capsule/'cloudbench-prepare-source.py'))
            for member in old['DEPENDENCIES']:
                (capsule/member).write_bytes(subprocess.check_output(['git','-C',str(ROOT),'show',ref+':scripts/'+member]))
            self.stale_original=copy.deepcopy(self.machines['22222222222222'])
            self.force_prestart_failure=True
            before=len(self.calls)
            failed=subprocess.run([sys.executable,str(capsule/'cloudbench-prepare-source.py'),
                '--request',str(request),'--output',str(output)],env=env,capture_output=True,text=True,timeout=35)
            self.assertNotEqual(failed.returncode,0)
            old_failure=helper['load'](output/'result.json')
            self.assertIs(old_failure['qualified'],False)
            self.assertFalse(any(method=='POST' and path.endswith('/start') for method,path,_ in self.calls[before:]))
            self.assertEqual(self.machines['22222222222222']['config']['guest']['cpus'],4)
            self.assertIsNone(self.lease_nonce)
            self.force_prestart_failure=False;self.stale_after_ack=False
            originals={path:path.read_bytes() for base in (self.root/'journal',output) for path in base.rglob('*') if path.is_file()}
            originals[request]=request.read_bytes()
            recovery=self.root/'recovered'
            result=subprocess.run([sys.executable,str(ROOT/'scripts/cloudbench-prepare-source.py'),
                'recover-bootstrap','--request',str(request),'--failed-result',str(output/'result.json'),
                '--output',str(recovery)],env=env,capture_output=True,text=True,timeout=35)
            self.assertEqual(result.returncode,0,result.stderr)
            authority=helper['resolve_bootstrap_ownership'](recovery/'result.json')
            self.assertEqual(authority['original_creator'],helper['descriptor'](self.root/'journal/result.json'))
            recovered=helper['load'](recovery/'result.json')
            self.assertIs(recovered['qualified'],False);self.assertIs(recovered['credit_granted'],False)
            self.assertEqual(authority['machine']['state'],'stopped')
            self.assertEqual(authority['machine']['config']['guest']['cpus'],1)
            self.preparation_request=copy.deepcopy(self.preparation_request)
            self.preparation_request.update(nonce='d'*32,ownership=helper['descriptor'](recovery/'result.json'),
                native=dict(machine_id=authority['machine']['id'],volume_id=authority['volume']['id'],
                    instance_id=authority['machine']['instance_id'],config_sha256=helper['sha'](helper['canonical'](authority['machine']['config'])),
                    env_sha256=helper['sha'](helper['canonical'](authority['machine']['config'].get('env') or {}))))
            request=self.root/'fresh-prepare-request.json';private_write(request,self.preparation_request)
            output=self.root/'fresh-prepared'
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/cloudbench-prepare-source.py'),
                                '--request', str(request), '--output', str(output)],
                                env=env, capture_output=True, text=True, timeout=35)
        self.assertEqual(result.returncode, 0, result.stderr)
        cleanup_args = ['cleanup', *self.args[1:], '--prepared-request', str(request),
                        '--prepared-result', str(output / 'result.json'),
                        '--prepared-manifest', str(output / 'source-manifest.json')]
        if getattr(self, 'recover_before_prepare', False):
            claim='cloudbench_source_consumer_'+'f'*32
            self.machines['22222222222222']['config']['metadata'][claim]='durable-open-claim'
            before=len([call for call in self.calls if call[0]=='DELETE' and not call[1].endswith('/lease')])
            refused=self.run_cli(cleanup_args);self.assertNotEqual(refused.returncode,0)
            self.assertEqual(len([call for call in self.calls if call[0]=='DELETE' and not call[1].endswith('/lease')]),before)
            del self.machines['22222222222222']['config']['metadata'][claim]
        result = self.run_cli(cleanup_args)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(self.machines), {DONOR})
        self.assertEqual(set(self.volumes), {VOL})
        for path,raw in originals.items():self.assertEqual(path.read_bytes(),raw,str(path))


if __name__ == '__main__': unittest.main()
