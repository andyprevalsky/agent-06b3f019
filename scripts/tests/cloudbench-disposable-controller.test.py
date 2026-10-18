#!/usr/bin/env python3
"""Owning offline controller entry controls; all provider calls hit a stateful fake."""
import copy
import hashlib
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

SOURCE = Path(os.environ.get('CLOUDBENCH_TEST_CONTROLLER_SOURCE',
    str(Path(__file__).resolve().parents[1] / 'cloudbench-disposable-controller.py')))
S = runpy.run_path(str(SOURCE))
MID = 'abcdef12345678'
VID = 'vol_fixture_controller'
IMAGE = 'registry.fly.io/fixture:warm@sha256:' + 'a' * 64


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


class UnexpectedBoundary(BaseException):
    pass


class FakeAPI:
    def __init__(self):
        self.calls = []
        self.machines = [{'id': 'keep' + str(i)} for i in range(4)]
        self.machine = None
        self.volume = dict(id=VID, name='controller-workspace', region='iad', size_gb=256,
                           encrypted=True, state='created', attached_machine_id=None,
                           auto_backup_enabled=True)
        self.delete_raises = False
        self.ignore_backup_put = False

    def __call__(self, method, path, body=None):
        self.calls.append((method, path, copy.deepcopy(body)))
        if method == 'GET' and path == '/machines':
            return copy.deepcopy(self.machines)
        if method == 'GET' and path == '/machines/' + MID:
            return copy.deepcopy(self.machine)
        if method == 'GET' and path == '/volumes/' + VID:
            return copy.deepcopy(self.volume)
        if method == 'PUT' and path == '/volumes/' + VID:
            if not self.ignore_backup_put:
                self.volume.update(body)
            return copy.deepcopy(self.volume)
        if method == 'DELETE' and path == '/machines/' + MID + '?kill=true':
            self.machine = None
            self.volume['attached_machine_id'] = None
            if self.delete_raises:
                raise TimeoutError('ambiguous response after actual fake deletion')
            return None
        if method == 'DELETE' and path == '/volumes/' + VID:
            self.volume['state'] = 'pending_destroy'
            if self.delete_raises:
                raise TimeoutError('ambiguous volume response')
            return None
        raise UnexpectedBoundary('unexpected boundary: ' + repr((method, path, body)))


class DisposableController(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'scripts').mkdir()
        self.out = self.root / 'output'
        self.out.mkdir(mode=0o700)
        self.api = FakeAPI()
        boundary = types.ModuleType('disposable_controller_test_boundary')
        boundary.API = self.api
        boundary.NotFound = type("NotFound", (Exception,), {})
        self.modules = patch.dict(sys.modules, disposable_controller_test_boundary=boundary)
        self.modules.start()
        self.addCleanup(self.modules.stop)
        transport = '''from disposable_controller_test_boundary import API
NotFound=__import__("disposable_controller_test_boundary").NotFound
class Fly:
 def __init__(self, app, token): assert app == "navi-whisper-lux-bench" and token == "fixture-token"
 def api(self, method, path, body=None, timeout=None, observer=None):
  assert timeout == 20
  import json
  try: value=API(method, path, body)
  except NotFound:
   if observer is not None: observer(method,path,404,b"not found")
   raise
  if observer is not None: observer(method,path,200,json.dumps(value).encode())
  return value
def resolve_token(request): raise AssertionError("no credential fallback in fixture")
'''
        exporter = '''def verify(args):
 assert args.archive.read_bytes() == b"archive-original"
 assert args.manifest.read_bytes() == b"manifest-original"
 assert args.record.read_bytes() == b"launch-original"
 assert args.caller.read_bytes() == b"caller-original"
'''
        for name, data in {'cloudbench-disposable-controller.py': SOURCE.read_text(),
                           'run-cloudbench-controller-gate': '# fixture gate\n',
                           'cloudbench-controller-export.py': exporter,
                           'cloudbench-original-volume-capture.py': transport}.items():
            (self.root / 'scripts' / name).write_text(data)
        self.env = patch.dict(os.environ, {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        os.environ['FLY_API_TOKEN'] = 'fixture-token'
        self.git('init', '-q')
        self.git('add', 'scripts')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture boundary')
        self.ref = self.git('rev-parse', 'HEAD').strip()
        self.auth = dict(schema='cloudbench-disposable-controller-authority-v1', allowed=True,
                         single_host=True, app='navi-whisper-lux-bench', region='iad',
                         vm_size='performance-8x', memory_mib=32768, workspace_size_gb=256,
                         org_machine_limit=1000, org_object_count=4, verified_epoch=time.time(),
                         cleanup_owner_pid=os.getpid(), cleanup_owner_birth=S['birth'](os.getpid()),
                         protected_machines=['keep' + str(i) for i in range(4)],
                         protected_volumes=['vol_warm', 'vol_whm'], source_ref=self.ref,
                         env_files={}, output_directory=str(self.out))
        for key in ('agents', 'backend'):
            p = self.root / (key + '.complete.env')
            self.private(p, b'COMPLETE_FIXTURE_SECRET=value\n')
            self.auth['env_files'][key] = dict(path=str(p), sha256=digest(p.read_bytes()))
        proof = self.root / 'capacity.private.json'
        self.private(proof, b'{"org_object_count":4,"org_machine_limit":1000}\n')
        self.auth['capacity_proof'] = dict(path=str(proof), sha256=digest(proof.read_bytes()))
        self.authpath = self.root / 'authority.json'
        self.workspace = self.out / 'workspace-volume.ownership.json'
        self.write_json(self.workspace, dict(schema='cloudbench-controller-workspace-ownership-v1',
                       app=self.auth['app'], source_ref=self.ref, size_gb=256,
                       volume_id=VID, name='controller-workspace'))
        self.write_auth()

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.root), *args], text=True, stderr=subprocess.DEVNULL)

    def private(self, path, raw):
        path.write_bytes(raw)
        path.chmod(0o600)

    def write_json(self, path, value):
        self.private(path, (json.dumps(value) + '\n').encode())

    def write_auth(self):
        self.write_json(self.authpath, self.auth)

    def entry(self, action, *extra):
        argv = ['helper', action, '--authority', str(self.authpath), '--root', str(self.root),
                '--directory', str(self.out), '--workspace', str(self.workspace), *extra]
        with patch.object(sys, 'argv', argv):
            return S['main']()

    def seal(self, backup=True):
        if backup:
            self.entry('backup-off')
        self.api.machine = dict(id=MID, instance_id='instance-original', name='disposable-controller',
                                region='iad', state='stopped', config=dict(image=IMAGE,
                                guest=dict(cpu_kind='performance', cpus=8, memory_mb=32768),
                                mounts=[dict(volume=VID, path='/tmp/gate')]))
        self.api.volume['attached_machine_id'] = MID
        self.entry('seal', '--machine', MID, '--name', 'disposable-controller', '--image', IMAGE)

    def export(self):
        for name in ('originals.tar.gz', 'manifest.json', 'launch.json', 'caller.json'):
            self.private(self.out / name, {'originals.tar.gz': b'archive-original',
                         'manifest.json': b'manifest-original', 'launch.json': b'launch-original',
                         'caller.json': b'caller-original'}[name])
        self.entry('export-ready', '--machine', MID, '--image', IMAGE)

    def test_actual_entry_requires_profile_authority_and_current_capacity(self):
        self.entry('admit')
        for field, bad in [('allowed', False), ('vm_size', 'shared-cpu-4x'),
                           ('workspace_size_gb', 64), ('org_machine_limit', 1001)]:
            old = self.auth[field]
            self.auth[field] = bad
            self.write_auth()
            calls = len(self.api.calls)
            with self.assertRaises(ValueError):
                self.entry('admit')
            self.assertEqual(len(self.api.calls), calls)
            self.auth[field] = old
        self.auth['org_machine_limit'] = 4
        self.write_auth()
        with self.assertRaisesRegex(ValueError, 'room'):
            self.entry('admit')
        self.assertFalse(any(c[0] != 'GET' for c in self.api.calls))
        original_output = self.out
        self.out = self.root / 'foreign-output'
        self.out.mkdir(mode=0o700)
        calls = len(self.api.calls)
        with self.assertRaisesRegex(ValueError, 'output directory changed'):
            self.entry('admit')
        self.assertEqual(len(self.api.calls), calls)
        self.out = original_output

    def test_current_complete_env_hash_checked_before_copy(self):
        self.entry('env-files')
        self.assertEqual((self.out / 'current-agents.private.env').read_bytes(),
                         Path(self.auth['env_files']['agents']['path']).read_bytes())
        other = self.root / 'second-output'
        other.mkdir(mode=0o700)
        self.out = other
        self.auth['output_directory'] = str(other)
        self.write_auth()
        self.private(Path(self.auth['env_files']['agents']['path']), b'CHANGED=fixture\n')
        with self.assertRaisesRegex(ValueError, 'complete env changed'):
            self.entry('env-files')
        self.assertFalse(list(other.iterdir()))
        self.assertEqual(self.api.calls, [])

    def test_workspace_read_pending_is_readonly_and_null_is_not_absence(self):
        original = self.api.__call__
        calls = []
        missing = sys.modules['disposable_controller_test_boundary'].NotFound
        def pending(method, path, body=None):
            calls.append((method, path))
            if len(calls) == 1:
                raise missing()
            return original(method, path, body)
        sys.modules['disposable_controller_test_boundary'].API = pending
        with patch('time.sleep'):
            self.entry('backup-off')
        self.assertEqual([x[0] for x in calls], ['GET', 'GET', 'PUT', 'GET'])
        self.assertTrue((self.out / 'workspace-backup.verified.json').exists())
        raws = [json.loads(p.read_bytes()) for p in self.out.glob('native-backup-off-*/*.raw.json')]
        self.assertEqual(sorted(x['status'] for x in raws), [200, 200, 200, 404])

    def test_workspace_positive_null_and_wrong_identity_never_write(self):
        for value in (None, dict(self.api.volume, id='vol_wrong')):
            sys.modules['disposable_controller_test_boundary'].API = lambda *args: value
            with self.assertRaisesRegex(ValueError, 'response must be an object|native mismatch'):
                self.entry('backup-off')
        self.assertFalse((self.out / 'workspace-backup.intent.json').exists())
        self.assertFalse((self.out / 'workspace-backup.verified.json').exists())

    def test_workspace_pending_read_is_bounded_without_mutation(self):
        missing = sys.modules['disposable_controller_test_boundary'].NotFound
        def absent(*args):
            raise missing()
        sys.modules['disposable_controller_test_boundary'].API = absent
        clock = iter([0, 0, 0, 181, 181, 181, 181, 181, 181, 181, 181, 181])
        with patch('time.monotonic', side_effect=lambda: next(clock, 181)), patch('time.sleep'):
            with self.assertRaises((ValueError, S['Deadline'])):
                self.entry('backup-off')
        self.assertFalse((self.out / 'workspace-backup.intent.json').exists())

    def test_backup_verification_missing_read_never_replays_put(self):
        original = self.api.__call__
        missing = sys.modules['disposable_controller_test_boundary'].NotFound
        reads = 0
        def pending(method, path, body=None):
            nonlocal reads
            if method == 'GET':
                reads += 1
                if reads == 2:
                    raise missing()
            return original(method, path, body)
        sys.modules['disposable_controller_test_boundary'].API = pending
        with patch('time.sleep'):
            self.entry('backup-off')
        self.assertEqual(sum(c[0] == 'PUT' for c in self.api.calls), 1)
        with self.assertRaises(FileExistsError):
            self.api.volume['auto_backup_enabled'] = True
            self.entry('backup-off')
        self.assertEqual(sum(c[0] == 'PUT' for c in self.api.calls), 1)

    def test_workspace_pending_cancellation_never_writes(self):
        missing = sys.modules['disposable_controller_test_boundary'].NotFound
        def absent(*args):
            raise missing()
        sys.modules['disposable_controller_test_boundary'].API = absent
        with patch('time.sleep', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.entry('backup-off')
        self.assertFalse((self.out / 'workspace-backup.intent.json').exists())
        self.assertFalse((self.out / 'workspace-backup.verified.json').exists())

    def test_workspace_absence_cleanup_requires_existing_delete_and_raw_404(self):
        marker = self.out / 'disposable-delete-volume.intent.json'
        self.write_json(marker, dict(authority_sha256=digest(self.authpath.read_bytes()),
                                    kind='volume', identifier=VID))
        missing = sys.modules['disposable_controller_test_boundary'].NotFound
        def absent(*args):
            raise missing()
        sys.modules['disposable_controller_test_boundary'].API = absent
        self.entry('cleanup-workspace')
        released = json.loads((self.out / 'disposable-controller.release.json').read_bytes())
        self.assertEqual(released['volume_disposition'], 'ABSENT')
        self.assertIs(released['command_history_verified'], False)
        raws = list(self.out.glob('native-cleanup-workspace-*/*.raw.json'))
        self.assertEqual([json.loads(p.read_bytes())['status'] for p in raws], [404])

    def test_actual_gate_admit_without_directory_does_not_create_output(self):
        import shutil
        shutil.rmtree(self.out)
        argv = ['helper', 'admit', '--authority', str(self.authpath), '--root', str(self.root)]
        with patch.object(sys, 'argv', argv):
            S['main']()
        self.assertFalse(self.out.exists())
        self.assertEqual([x[:2] for x in self.api.calls], [('GET', '/machines')])

    def test_backup_disabled_and_verified_before_host_seal(self):
        self.seal()
        self.assertTrue((self.out / 'workspace-backup.verified.json').is_file())
        calls = self.api.calls
        put = next(i for i, c in enumerate(calls) if c[0] == 'PUT')
        host = next(i for i, c in enumerate(calls) if c[1] == '/machines/' + MID)
        self.assertLess(put, host)
        self.assertIs(self.api.volume['auto_backup_enabled'], False)
        record = json.loads((self.out / 'disposable-controller.ownership.json').read_text())
        self.assertEqual(record['machine']['config']['mounts'][0]['volume'], VID)
        # An acknowledged PUT without verified backup disable cannot admit a host.
        self.out = self.root / 'backup-not-applied'
        self.out.mkdir(mode=0o700)
        self.auth['output_directory'] = str(self.out)
        self.write_auth()
        self.workspace = self.out / 'workspace-volume.ownership.json'
        self.write_json(self.workspace, dict(schema='cloudbench-controller-workspace-ownership-v1',
                       app=self.auth['app'], source_ref=self.ref, size_gb=256,
                       volume_id=VID, name='controller-workspace'))
        self.api.volume.update(attached_machine_id=None, auto_backup_enabled=True)
        self.api.ignore_backup_put = True
        start = len(self.api.calls)
        with self.assertRaisesRegex(ValueError, 'backup disable not verified'):
            self.entry('backup-off')
        self.assertFalse(any(c[1].startswith('/machines/') for c in self.api.calls[start:]))

    def test_seal_refuses_foreign_image_mount_and_protected_resources(self):
        self.entry('backup-off')
        self.api.machine = dict(id=MID, instance_id='i', name='disposable-controller', region='iad',
            config=dict(image=IMAGE, guest=dict(cpu_kind='performance', cpus=8, memory_mb=32768),
                        mounts=[dict(volume=VID, path='/tmp/gate')]))
        self.api.volume['attached_machine_id'] = MID
        original = copy.deepcopy(self.api.machine)
        for mutate in (lambda: self.api.machine['config'].update(image='foreign-image'),
                       lambda: self.api.machine['config']['mounts'][0].update(volume='vol_foreign'),
                       lambda: self.api.machine.update(name='foreign-controller')):
            self.api.machine = copy.deepcopy(original)
            mutate()
            with self.assertRaises(ValueError):
                self.entry('seal', '--machine', MID, '--name', 'disposable-controller', '--image', IMAGE)
        self.api.machine = original
        self.auth['protected_machines'].append(MID)
        self.write_auth()
        with self.assertRaisesRegex(ValueError, 'protected'):
            self.entry('seal', '--machine', MID, '--name', 'disposable-controller', '--image', IMAGE)
        self.auth['protected_machines'].remove(MID)
        self.auth['protected_volumes'].append(VID)
        self.write_auth()
        with self.assertRaisesRegex(ValueError, 'protected workspace Volume'):
            self.entry('seal', '--machine', MID, '--name', 'disposable-controller', '--image', IMAGE)
        self.assertFalse((self.out / 'disposable-controller.ownership.json').exists())
        self.assertFalse(any(c[0] == 'DELETE' for c in self.api.calls))

    def test_verified_export_required_and_changed_originals_block_delete(self):
        self.seal()
        with self.assertRaises(FileNotFoundError):
            self.entry('cleanup')
        self.export()
        self.private(self.out / 'originals.tar.gz', b'changed archive')
        with self.assertRaisesRegex(ValueError, 'export originals changed'):
            self.entry('cleanup')
        self.assertFalse(any(c[0] == 'DELETE' for c in self.api.calls))

    def test_ambiguous_delete_reconciles_with_get_and_existing_intent_never_reposts(self):
        self.seal()
        self.export()
        self.api.delete_raises = True
        self.entry('cleanup')
        deletes = [c for c in self.api.calls if c[0] == 'DELETE']
        self.assertEqual([c[1] for c in deletes], ['/machines/' + MID + '?kill=true', '/volumes/' + VID])
        self.assertTrue((self.out / 'disposable-controller.release.json').exists())
        # Preserve the original intents; another reconciliation may only GET.
        (self.out / 'disposable-controller.release.json').unlink()
        self.entry('cleanup')
        self.assertEqual(len([c for c in self.api.calls if c[0] == 'DELETE']), 2)

    def test_actual_delete_deadline_reconciles_get_without_redelete(self):
        self.seal()
        self.export()
        original_api = self.api.__class__.__call__
        original_bounded = S['bounded']
        def delayed(api, method, path, body=None):
            result = original_api(api, method, path, body)
            if method == 'DELETE':
                time.sleep(.05)
            return result
        def short_calls(seconds, **kwargs):
            return original_bounded(.01 if seconds == 20 else seconds, **kwargs)
        with patch.object(FakeAPI, '__call__', delayed), patch.dict(S['main'].__globals__, bounded=short_calls):
            self.entry('cleanup')
        self.assertTrue((self.out / 'disposable-controller.release.json').exists())
        self.assertEqual(len([c for c in self.api.calls if c[0] == 'DELETE']), 2)
        (self.out / 'disposable-controller.release.json').unlink()
        self.entry('cleanup')
        self.assertEqual(len([c for c in self.api.calls if c[0] == 'DELETE']), 2)

    def test_whole_deadline_never_becomes_recoverable_delete_timeout(self):
        self.seal()
        self.export()
        original_api = self.api.__class__.__call__
        original_bounded = S['bounded']
        def delayed(api, method, path, body=None):
            result = original_api(api, method, path, body)
            if method == 'DELETE':
                time.sleep(.5)
            return result
        def short_whole(seconds, **kwargs):
            return original_bounded(.2 if seconds == 180 else seconds, **kwargs)
        with patch.object(FakeAPI, '__call__', delayed), patch.dict(S['main'].__globals__, bounded=short_whole):
            with self.assertRaises(S['Deadline']):
                self.entry('cleanup')
        self.assertFalse((self.out / 'disposable-controller.release.json').exists())
        self.assertEqual(len([c for c in self.api.calls if c[0] == 'DELETE']), 1)
        self.assertEqual(self.api.calls[-1][0], 'DELETE')

    def test_late_export_and_cleanup_do_not_reapply_creation_ttl(self):
        self.entry('backup-off')
        with patch.object(S['authority'].__globals__['time'], 'time', return_value=self.auth['verified_epoch'] + 600):
            with self.assertRaisesRegex(ValueError, 'original.*reservation|reservation.*required'):
                self.entry('continue-allocation', '--driver-pid', str(os.getpid()))
        self.entry('reserve', '--driver-pid', str(os.getpid()))
        with patch.object(S['authority'].__globals__['time'], 'time', return_value=self.auth['verified_epoch'] + 600):
            self.entry('continue-allocation', '--driver-pid', str(os.getpid()))
            with self.assertRaises(ValueError):
                self.entry('continue-allocation', '--driver-pid', '1')
            other = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(20)'])
            try:
                with self.assertRaisesRegex(ValueError, 'already reserved'):
                    self.entry('continue-allocation', '--driver-pid', str(other.pid))
            finally:
                other.terminate()
                other.wait(timeout=5)
        self.seal(backup=False)
        with patch.object(S['authority'].__globals__['time'], 'time', return_value=self.auth['verified_epoch'] + 600):
            with self.assertRaisesRegex(ValueError, 'stale creation'):
                self.entry('admit')
            self.export()
            self.entry('cleanup')
        self.assertTrue((self.out / 'disposable-controller.release.json').exists())


    def test_partial_volume_allocation_cleanup_requires_no_host_and_never_redeletes(self):
        self.entry('create-intent', '--name', 'disposable-controller', '--image', IMAGE)
        self.api.machines.append(dict(id='unexpected-host', name='disposable-controller', config={}))
        with self.assertRaisesRegex(ValueError, 'allocation exists or is ambiguous'):
            self.entry('cleanup-workspace')
        self.api.machines.pop()
        self.api.machines.append(dict(id='foreign-host', name='foreign-controller',
                                     config=dict(mounts=[dict(volume=VID)])))
        with self.assertRaisesRegex(ValueError, 'allocation exists or is ambiguous'):
            self.entry('cleanup-workspace')
        self.api.machines.pop()
        self.api.volume['attached_machine_id'] = 'foreign-host'
        with self.assertRaisesRegex(ValueError, 'not provably detached'):
            self.entry('cleanup-workspace')
        self.assertFalse(any(c[0] == 'DELETE' for c in self.api.calls))
        self.api.volume['attached_machine_id'] = None
        self.api.delete_raises = True
        self.entry('cleanup-workspace')
        release = json.loads((self.out / 'disposable-controller.release.json').read_text())
        self.assertIsNone(release['machine_id'])
        self.assertTrue(release['no_live_machine_observed'])
        self.assertFalse(release['command_history_verified'])
        (self.out / 'disposable-controller.release.json').unlink()
        self.entry('cleanup-workspace')
        self.assertEqual([c[1] for c in self.api.calls if c[0] == 'DELETE'], ['/volumes/' + VID])

    def test_sibling_controller_slots_admit_k_controllers_from_one_snapshot(self):
        # One measured snapshot (4 objects, limit 7) admits K=3 controllers only
        # when each reserves its two siblings; later siblings observe earlier ones.
        self.auth['org_machine_limit'] = 7
        self.write_auth()
        self.api.machines += [{'id': 'sibling0'}, {'id': 'sibling1'}]
        with self.assertRaisesRegex(ValueError, 'room'):
            self.entry('admit')
        self.auth['sibling_controller_slots'] = 2
        self.write_auth()
        self.entry('admit')
        self.api.machines.append({'id': 'unexpected-third'})
        with self.assertRaisesRegex(ValueError, 'room'):
            self.entry('admit')
        self.api.machines.pop()
        self.auth['org_machine_limit'] = 6
        self.write_auth()
        with self.assertRaisesRegex(ValueError, 'room'):
            self.entry('admit')
        for bad in (-1, True, '1', 6, 1.0):
            self.auth['sibling_controller_slots'] = bad
            self.write_auth()
            calls = len(self.api.calls)
            with self.subTest(bad=bad), self.assertRaisesRegex(ValueError, 'sibling controller slots'):
                self.entry('admit')
            self.assertEqual(len(self.api.calls), calls)
        self.assertFalse(any(c[0] != 'GET' for c in self.api.calls))


class ControllerGateName(unittest.TestCase):
    GATE = Path(__file__).resolve().parents[1] / 'run-cloudbench-controller-gate'

    def name(self, suffix):
        source = self.GATE.read_text()
        definition = [line for line in source.splitlines() if line.startswith('gate_machine_name() {')]
        self.assertEqual(len(definition), 1)
        self.assertEqual(source.count('MACHINE_NAME="$(gate_machine_name)"'), 1)
        self.assertNotIn('MACHINE_NAME="cloudbench-gate-', source)
        script = definition[0] + '\nGATE_REF=abcdef1234567890; STAMP=20261018-000000; GATE_NAME_SUFFIX="$1"; gate_machine_name\n'
        return subprocess.run(['bash', '-c', script, 'gate', suffix], capture_output=True, text=True, check=True).stdout.strip()

    def test_default_name_unchanged_and_suffix_distinguishes_same_second_gates(self):
        self.assertEqual(self.name(''), 'cloudbench-gate-abcdef12-20261018-000000')
        self.assertEqual(self.name('s00'), 'cloudbench-gate-abcdef12-20261018-000000-s00')
        self.assertNotEqual(self.name('s00'), self.name('s01'))

    def test_invalid_suffix_refused_before_any_preflight_or_provider_effect(self):
        with tempfile.TemporaryDirectory() as directory:
            for bad in ('S00', 's_00', 'a' * 13, 's00;x'):
                env = {k: v for k, v in os.environ.items() if not k.startswith('CLOUDBENCH_')}
                env.update(CLOUDBENCH_GATE_ROOT_DIR=directory, CLOUDBENCH_GATE_NAME_SUFFIX=bad, PATH='/usr/bin:/bin')
                result = subprocess.run(['bash', str(self.GATE)], cwd=directory, env=env, capture_output=True, text=True, timeout=30)
                with self.subTest(bad=bad):
                    self.assertEqual(result.returncode, 2)
                    self.assertIn('invalid CLOUDBENCH_GATE_NAME_SUFFIX', result.stderr)
                    self.assertNotIn('operator-preflight', result.stderr)
            self.assertEqual(list(Path(directory).iterdir()), [])


if __name__ == '__main__':
    unittest.main()
