#!/usr/bin/env python3
"""Exercise the real helper entry and exported shell bridge, without provider calls."""
import base64
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import stat
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]
loader = importlib.machinery.SourceFileLoader('backup_fixture', str(SCRIPTS/'tests/cloudbench-disposable-volume.test.py'))
spec = importlib.util.spec_from_loader(loader.name, loader)
fixture_module = importlib.util.module_from_spec(spec)
loader.exec_module(fixture_module)


class CommandEntry(unittest.TestCase):
    def setUp(self):
        self.fixture = fixture_module.Backup()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tmp.cleanup)
        self.directory = Path(self.fixture.tmp.name)
        self.scripts = self.directory/'scripts'
        self.scripts.mkdir()
        source = Path(os.environ.get('CLOUDBENCH_TEST_DISPOSABLE_VOLUME_SOURCE', str(SCRIPTS/'cloudbench-disposable-volume.py')))
        (self.scripts/'cloudbench-disposable-volume.py').write_bytes(source.read_bytes())
        (self.scripts/'cloudbench-original-volume-capture.py').write_bytes((SCRIPTS/'cloudbench-original-volume-capture.py').read_bytes())
        bin_path = self.directory/'bin'
        bin_path.mkdir()
        executable = bin_path/'flyctl'
        executable.write_text('''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
p=Path(os.environ['CASE']); args=sys.argv[1:]
with (p/'calls').open('a') as stream:stream.write(json.dumps(args)+'\\n')
# Pinned v0.4.115 machine status uses --display-config/-d, not --json.
if args[:2]==['machine','status'] and '--json' in args:
 print('Error: unknown flag: --json',file=sys.stderr);raise SystemExit(1)
if args[:2]==['volumes','update'] and int(os.environ['CLI_UPDATE_REJECTIONS'])>len(list(p.glob('rejected-*'))):
 (p/('rejected-'+str(len(list(p.glob('rejected-*')))))).touch()
 # Exact run600c shard-16 r002-j0277 provider response; the Volume existed.
 print('Error: failed updating volume: failed to update volume: volume not found (Request ID: 01FIXTURE-iad)',file=sys.stderr);raise SystemExit(1)
if os.environ['CLI_READ_FAILURE']=='1':
 print('{"fixture":"partial-read"}')
 print('fixture native status failure',file=sys.stderr);raise SystemExit(23)
if args[:2]==['machine','status']:
 assert args==['machine','status','abcd1234','-a','fixture','-d'],args
 print(json.dumps(dict(mounts=[dict(volume='vol_owned')])));raise SystemExit()
assert args[:2] in (['volumes','show'],['volumes','update']),args
assert '--json' in args,args
v=dict(id='vol_owned',state='created',auto_backup_enabled=not (p/'disabled').exists(),snapshot_retention=5,size_gb=40,name='fork',attached_machine_id='abcd1234')
if args[:2]==['volumes','update']:
 assert args==['volumes','update','vol_owned','-a','fixture','--scheduled-snapshots=false','--json'],args
 (p/'disabled').touch();v['auto_backup_enabled']=False
print(json.dumps(v))
''')
        executable.chmod(0o700)
        source = (SCRIPTS/'run-bench-fleet').read_text()
        functions = ''.join(re.search(r'^'+name+r'\(\).*?^}\n', source, re.M|re.S).group() for name in ('private_source_allows_provider_call', 'FLY'))
        # Export the production bridge's exact FLY dependency closure; FLY now
        # calls archived-reuse transport helpers from the sourced libraries.
        bridge = re.search(r'^fleet_disable_disposable_volume_snapshots\(\).*?^\)\n', source, re.M|re.S).group()
        exported = re.search(r'export -f ((?:[^\n]*\\\n)*[^\n]*)', bridge).group(1).replace('\\\n', ' ').split()
        libraries = ''.join('source '+str(SCRIPTS/'lib'/name)+'\n' for name in ('cloudbench-env.sh', 'cloudbench-archived-reuse.sh'))
        self.shell = libraries+functions+'\nexport -f '+' '.join(exported)+'\nexec "$@"\n'
        self.env = dict(os.environ, PATH=str(bin_path)+':'+os.environ['PATH'], CASE=str(self.directory), CLI_READ_FAILURE='0', CLI_UPDATE_REJECTIONS='0', PRIVATE_SOURCE_ID='', CLOUDBENCH_CAMPAIGN_MUTATION_ADMISSION='1', ROOT_DIR=str(SCRIPTS.parent))

    def invoke(self):
        f = self.fixture
        argv = ['python3', str(self.scripts/'cloudbench-disposable-volume.py'), '--registry', str(f.reg), '--owner', f.owner, '--app', 'fixture', '--name', 'cloudbench-fixture', '--machine', 'abcd1234', '--volume', 'vol_owned', '--audit', str(f.audit), '--run', 'run']
        return subprocess.run(['bash', '-c', self.shell, 'entry', *argv], env=self.env, capture_output=True, timeout=30)

    def calls(self):
        return [json.loads(row) for row in (self.directory/'calls').read_text().splitlines()]

    def test_actual_main_pinned_cli_contract_verifies_before_boot(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        calls = self.calls()
        self.assertEqual(len(calls), 5)
        self.assertEqual(sum(row[:2] == ['volumes', 'update'] for row in calls), 1)
        evidence = json.loads((self.fixture.audit/'volume-backups/vol_owned/verified.json').read_bytes())
        self.assertFalse(evidence['auto_backup_enabled'])
        self.assertEqual(evidence['machine'], 'abcd1234')
        self.assertEqual(evidence['volume'], 'vol_owned')

    def test_observed_transient_volume_not_found_update_is_replayed_after_exact_read(self):
        self.env['CLI_UPDATE_REJECTIONS'] = '1'
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        calls = self.calls()
        self.assertEqual([row[:2] for row in calls], [['machine', 'status'], ['volumes', 'show'], ['volumes', 'update'], ['machine', 'status'], ['volumes', 'show'], ['volumes', 'update'], ['machine', 'status'], ['volumes', 'show']])
        evidence = json.loads((self.fixture.audit/'volume-backups/vol_owned/verified.json').read_bytes())
        self.assertFalse(evidence['auto_backup_enabled'])
        receipts = [json.loads(path.read_bytes()) for path in sorted((self.fixture.audit/'volume-backups/vol_owned/commands').glob('*.result.json'))]
        self.assertEqual([row['status'] for row in receipts if row['argv'][1] == 'update'], [1, 0])
        self.assertIn(b'volume not found', base64.b64decode(next(row for row in receipts if row['status'])['stderr_base64']))
        self.assertNotIn(b'volume not found', result.stderr)

    def test_persistent_update_rejection_fails_bounded_without_verification(self):
        self.env['CLI_UPDATE_REJECTIONS'] = '9'
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sum(row[:2] == ['volumes', 'update'] for row in self.calls()), 3)
        self.assertFalse((self.fixture.audit/'volume-backups/vol_owned/verified.json').exists())
        self.assertTrue((self.fixture.audit/'volume-backups/vol_owned/intent.json').exists())

    def test_failed_first_read_keeps_exact_private_diagnostics_and_never_updates(self):
        self.env['CLI_READ_FAILURE'] = '1'
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        # A persistent read rejection is retried a bounded number of times.
        self.assertEqual(len(self.calls()), 3)
        self.assertEqual({tuple(row) for row in self.calls()}, {tuple(self.calls()[0])})
        self.assertFalse((self.fixture.audit/'volume-backups/vol_owned/intent.json').exists())
        self.assertFalse((self.fixture.audit/'volume-backups/vol_owned/verified.json').exists())
        evidence = self.fixture.audit/'volume-backups/vol_owned/commands'
        self.assertEqual(stat.S_IMODE(evidence.stat().st_mode), 0o700)
        results = sorted(evidence.glob('*.result.json'))
        intents = sorted(evidence.glob('*.intent.json'))
        self.assertEqual(len(results), 3)
        self.assertEqual(len(intents), 3)
        for path in results + intents:
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(path.stat().st_uid, os.getuid())
        for result_path, intent_path in zip(results, intents):
            self.assertEqual(result_path.name.removesuffix('.result.json'), intent_path.name.removesuffix('.intent.json'))
            receipt = json.loads(result_path.read_bytes())
            intent = json.loads(intent_path.read_bytes())
            self.assertEqual(receipt['argv'], self.calls()[0])
            self.assertEqual(receipt['argv'], intent['argv'])
            self.assertEqual(receipt['status'], 23)
            self.assertEqual(base64.b64decode(receipt['stdout_base64']), b'{"fixture":"partial-read"}\n')
            self.assertEqual(base64.b64decode(receipt['stderr_base64']), b'fixture native status failure\n')
            self.assertGreaterEqual(receipt['finished_monotonic'], receipt['started_monotonic'])
            self.assertEqual(receipt['started_monotonic'], intent['started_monotonic'])
        self.assertNotIn(b'fixture native status failure', result.stderr)
        self.assertNotIn(b'partial-read', result.stderr)
        self.assertIn(str(results[-1]).encode(), result.stderr)


if __name__ == '__main__':
    unittest.main()
