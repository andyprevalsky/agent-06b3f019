#!/usr/bin/env python3
"""Exercise native per-surface provider validation and maintenance without a network."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(os.environ.get('CLOUDBENCH_CONTRACT_ROOT', Path(__file__).resolve().parents[2]))
HELPER = ROOT / 'scripts/lib/cloudbench-env.sh'


class ProviderContract(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.agents = self.root / 'agents.env'
        self.backend = self.root / 'backend.env'

    def contract(self, backend='tilion', worker='kernel', local_backend='tilion',
                 local_worker='kernel', key=True):
        self.agents.write_text('BROWSER_PROVIDER=' + local_worker + '\n')
        self.backend.write_text('BROWSER_PROVIDER=' + local_backend + '\n' +
                                ('TILION_API_KEY=fake-private-key\n' if key else ''))
        return subprocess.run(['bash', '-c', 'source "$1"; '
            'cloudbench_validate_browser_provider_contract "$2" "$3" "$4" "$5"',
            '_', str(HELPER), str(self.agents), str(self.backend), backend, worker],
            text=True, capture_output=True, timeout=10)

    def test_distinct_authorities_accept_exact_pair(self):
        p = self.contract()
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertNotIn('fake-private-key', p.stdout + p.stderr)

    def test_wrong_worker_is_refused(self):
        p = self.contract(local_worker='tilion')
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('benchmark worker env does not match production', p.stderr)

    def test_wrong_backend_is_refused(self):
        p = self.contract(local_backend='kernel')
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('benchmark backend env does not match production', p.stderr)

    def test_backend_key_is_still_required(self):
        p = self.contract(key=False)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('no TILION_API_KEY', p.stderr)

    def test_missing_or_invalid_authority_is_refused(self):
        for name in ('backend', 'worker'):
            for value in ('', 'unknown', 'null', 'true'):
                with self.subTest(name=name, value=value):
                    self.assertNotEqual(self.contract(**{name: value}).returncode, 0)

    def test_existing_equal_contracts_remain_valid(self):
        for provider in ('tilion', 'kernel', 'steel', 'browser-use'):
            p = self.contract(provider, provider, provider, provider)
            self.assertEqual(p.returncode, 0, p.stderr)

    def test_all_actual_guest_fragments_use_separate_authorities(self):
        for script in ('cloudbench-run.sh', 'cloudbench-worker.sh', 'cloudbench-entrypoint.sh'):
            text = (ROOT / 'scripts' / script).read_text()
            start = text.index('\ncloudbench_validate_browser_provider_contract \\') + 1
            fragment = text[start:text.index('\n', text.index('||', start))]
            fragment = fragment.replace('|| finish 1', '|| exit 1')
            env = dict(PATH=os.environ['PATH'], CLOUDBENCH_BROWSER_PROVIDER='tilion',
                       CLOUDBENCH_WORKER_BROWSER_PROVIDER='kernel', APP_DIR=str(self.root),
                       REPO_DIR=str(self.root))
            (self.root / 'agents').mkdir(exist_ok=True)
            (self.root / 'back-end').mkdir(exist_ok=True)
            (self.root / 'agents/.env').write_text('BROWSER_PROVIDER=kernel\n')
            (self.root / 'back-end/.env').write_text('BROWSER_PROVIDER=tilion\nTILION_API_KEY=fake\n')
            command = 'source "$1"\n' + fragment
            p = subprocess.run(['bash', '-c', command, '_', str(HELPER)], env=env,
                               text=True, capture_output=True, timeout=10)
            self.assertEqual(p.returncode, 0, script + p.stderr)
            env.pop('CLOUDBENCH_WORKER_BROWSER_PROVIDER')
            p = subprocess.run(['bash', '-c', command, '_', str(HELPER)], env=env,
                               text=True, capture_output=True, timeout=10)
            self.assertNotEqual(p.returncode, 0, script)

    def probe(self, scenario=''):
        import ast
        import contextlib
        import io
        import pathlib
        import sys
        import types
        from unittest.mock import patch
        tree = ast.parse((ROOT / 'scripts/worker_pool_runtime.py').read_text())
        source = next(ast.literal_eval(node.value) for node in tree.body
                      if isinstance(node, ast.Assign) and any(getattr(t, 'id', '') == 'RUNTIME_BROWSER_PROVIDER_PROBE' for t in node.targets))
        real_path = type(self.root)
        stat = '596 (python) ' + ' '.join(['S'] + ['0'] * 18 + ['40'])
        self.root.joinpath('stat').write_text(stat)
        self.root.joinpath('boot').write_text('11111111-1111-4111-8111-111111111111')
        environment = b'A_SECRET=private-never-emit\0BROWSER_PROVIDER=tilion\0'
        if scenario == 'missing-provider': environment = b'A_SECRET=private-never-emit\0'
        self.root.joinpath('environ').write_bytes(environment)
        code = 'from dotenv import load_dotenv\nload_dotenv(override=False)\n'
        self.root.joinpath('worker').write_text(code)
        self.root.joinpath('config').write_text(code if scenario != 'dotenv-overwrite' else code.replace('False', 'True'))
        if scenario == 'provider-write': self.root.joinpath('config').write_text(code + "os.environ['BROWSER_PROVIDER']='kernel'\n")
        paths = {'/proc/596/stat': 'stat', '/proc/sys/kernel/random/boot_id': 'boot', '/proc/596/environ': 'environ',
                 '/app/worker.py': 'worker', '/app/config.py': 'config'}
        reads = 0
        def fake_path(*parts):
            nonlocal reads
            path = real_path(*parts)
            if str(path) == '/proc/596/stat':
                reads += 1
                if scenario == 'birth-drift' and reads > 1:
                    self.root.joinpath('stat').write_text(stat.removesuffix('40') + '41')
            return self.root / paths[str(path)] if str(path) in paths else path
        process = types.SimpleNamespace(pid=596, info={'cmdline': None if scenario == 'unreadable-process' else ['python', 'worker.py']},
                                        cmdline=lambda: ['python', 'worker.py'], cwd=lambda: '/app')
        processes = [process, process] if scenario == 'ambiguous-worker' else [process]
        psutil = types.SimpleNamespace(process_iter=lambda fields: processes)
        output = io.StringIO()
        with patch.dict(sys.modules, {'psutil': psutil}), patch.object(pathlib, 'Path', side_effect=fake_path), \
             patch.dict(os.environ, {'FLY_MACHINE_ID': 'c001', 'FLY_MACHINE_VERSION': 'i001'}), \
             patch.object(sys, 'argv', ['probe', 'c001' if scenario != 'foreign-machine' else 'c002', 'i001']), \
             contextlib.redirect_stdout(output):
            exec(compile(source, '<actual-worker-provider-probe>', 'exec'), {})
        self.assertNotIn('private-never-emit', output.getvalue())
        return json.loads(output.getvalue())

    def test_actual_native_probe_reads_only_provider_and_stable_birth(self):
        observed = self.probe()
        self.assertEqual(observed['before'], observed['after'])
        self.assertEqual(observed['before'][0]['provider'], 'tilion')
        self.assertEqual(observed['before'][0]['birth'], '11111111-1111-4111-8111-111111111111:596:40')

    def test_actual_native_probe_refuses_ambiguous_mutated_or_foreign_evidence(self):
        for scenario in ('missing-provider', 'birth-drift', 'dotenv-overwrite', 'provider-write', 'ambiguous-worker', 'foreign-machine', 'unreadable-process'):
            with self.subTest(scenario=scenario), self.assertRaises(ValueError):
                self.probe(scenario)

    def cli(self, unauthorized=False, omit_marker=False, effective="kernel", scenario=""):
        repo = self.root / 'repo'
        repo.mkdir()
        shutil.copytree(ROOT / 'scripts', repo / 'scripts')
        for name in ('agents', 'back-end', 'bin', 'home'):
            (repo / name).mkdir()
        subprocess.run(['git', 'init', '-q', str(repo)], check=True)
        (repo / 'agents/.env').write_text('BROWSER_PROVIDER=' + effective + '\nUNCHANGED=fake-worker-secret\n')
        (repo / 'back-end/.env').write_text('BROWSER_PROVIDER=tilion\nTILION_API_KEY=fake-vendor-key\n'
            'RENDER_API_KEY=fake-render-key\nRENDER_SERVICE_ID=fixture\n'
            'GITHUB_DISPATCH_TOKEN=fake-durable-token\n'
            'AGENTCARD_ORG_OAUTH_CLIENT_ID=01234567890123456789\n'
            'AGENTCARD_ORG_OAUTH_CLIENT_SECRET=abcdefghijklmnopqrstuvwxyz012345\n')
        override = repo / 'agents/.env.benchmark-temporal'
        override.write_text('CLOUDBENCH_GUEST_TEMPORAL_ADDRESS=fixture:7233\n'
            'CLOUDBENCH_GUEST_TEMPORAL_NAMESPACE=rose-labs-bench.tch2n\n'
            'CLOUDBENCH_GUEST_TEMPORAL_API_KEY=fake-guest-key\n')
        override.chmod(0o600)
        (repo / '.context').mkdir()
        (repo / '.context/cloudbench-pool.ids').write_text('b001\nb002\n')
        fly = repo / 'bin/flyctl'
        fly.write_text('''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
a=sys.argv[1:];r=Path(os.environ['FIXTURE_ROOT'])
with (r/'calls.jsonl').open('a') as f:f.write(json.dumps(a)+'\\n')
if a[:2]==['machines','list']:
 app=a[a.index('-a')+1]
 if app=='navi-whisper-lux':
  if os.environ.get('UNAUTHORIZED')=='1':print('unauthorized 403',file=sys.stderr);sys.exit(1)
  scenario=os.environ.get('OBSERVATION_SCENARIO','')
  inventory=[{'id':'c001','state':'started','instance_id':'i001','config':{'env':{'BROWSER_PROVIDER':'kernel'}}}]
  if scenario=='no-active':inventory[0]['state']='stopped'
  if scenario=='missing-instance':inventory[0].pop('instance_id')
  if scenario=='mixed':inventory.append({'id':'c002','state':'started','instance_id':'i002','config':{}})
  if scenario=='stopped-not-authority':inventory.append({'id':'c002','state':'stopped','config':{'env':{'BROWSER_PROVIDER':'unknown'}}})
  if scenario=='instance-drift' and sum(json.loads(line)[:2]==['machines','list'] for line in (r/'calls.jsonl').read_text().splitlines())>1:inventory[0]['instance_id']='i002'
  print(json.dumps(inventory))
 else:print(json.dumps([{'id':'a001','name':'cloudbench-warm','state':'stopped','config':{}},{'id':'b001','state':'stopped','config':{}},{'id':'b002','state':'started','config':{}}]))
elif a[:2]==['machine','exec']:
 scenario=os.environ.get('OBSERVATION_SCENARIO','');mid=a[2]
 if scenario=='unreachable':raise SystemExit(1)
 record={'pid':596,'birth':'11111111-1111-4111-8111-111111111111:596:40','provider':os.environ['EFFECTIVE_PROVIDER'],'worker_sha256':'a'*64,'config_sha256':'b'*64,'dotenv_nonoverwriting':True}
 if scenario=='missing-provider':record.pop('provider')
 if scenario=='invalid-provider':record['provider']='unknown'
 if scenario=='source-contract':record['dotenv_nonoverwriting']=False
 if scenario=='mixed' and mid=='c002':record['provider']='steel'
 after=dict(record)
 if scenario=='pid-drift':after['birth']=after['birth'].removesuffix(':40')+':41'
 if scenario=='provider-drift':after['provider']='steel'
 rows=[record,dict(record)] if scenario=='ambiguous-worker' else [record]
 if scenario=='no-worker':rows=[]
 observation={'machine_id':mid,'instance_id':'i001' if mid=='c001' else 'i002','before':rows,'after':[after] if len(rows)==1 else rows}
 if scenario=='foreign-machine':observation['machine_id']='foreign'
 reply={'exit_code':False if scenario=='malformed-exit' else 0,'stdout':json.dumps(observation),'stderr':''}
 if scenario=='cli-omits-zero':reply.pop('exit_code')
 print(json.dumps(reply))
elif a[:2]==['secrets','set']:
 (r/'staged.json').write_text(json.dumps(dict(x.split('=',1) for x in a if '=' in x)))
elif a[:2]==['secrets','list']:
 names='AGENTS_ENV_B64 BACKEND_ENV_B64 AGENTS_ENV_SHA256 BACKEND_ENV_SHA256 CLOUDBENCH_BROWSER_PROVIDER GITHUB_TOKEN'.split()
 if os.environ.get('OMIT_MARKER')!='1':names.append('CLOUDBENCH_WORKER_BROWSER_PROVIDER')
 print(json.dumps([{'Name':x} for x in names]))
elif a[:2]==['machine','update']:pass
else:raise SystemExit('UNEXPECTED NATIVE EFFECT '+repr(a))
''')
        fly.chmod(0o755)
        curl = repo / 'bin/curl'
        curl.write_text('''#!/usr/bin/env python3
import sys
a=sys.argv[1:]
if any('api.render.com/' in x for x in a):print('{"envVar":{"value":"tilion"}}')
elif any('api.github.com/' in x for x in a):print('200',end='')
else:raise SystemExit('UNEXPECTED NETWORK '+repr(a))
''')
        curl.chmod(0o755)
        (repo / 'bin/sitecustomize.py').write_text("""import io,json,os,urllib.request
from pathlib import Path
def native_request(request,*args,**kwargs):
 prefix='https://api.machines.dev/v1/apps/navi-whisper-lux/machines/'
 if request.get_method()!='POST' or not request.full_url.startswith(prefix) or not request.full_url.endswith('/exec'):
  raise AssertionError('UNEXPECTED NETWORK')
 mid=request.full_url[len(prefix):-len('/exec')];scenario=os.environ.get('OBSERVATION_SCENARIO','')
 root=Path(os.environ['FIXTURE_ROOT'])
 with (root/'calls.jsonl').open('a')as stream:stream.write(json.dumps(['api','exec',mid])+'\\n')
 if scenario=='unreachable':raise OSError('fixture transport refused')
 if scenario=='api-http-error':
  from urllib.error import HTTPError
  raise HTTPError(request.full_url,503,'fixture service unavailable',{},None)
 data=json.loads(request.data)
 assert data['command'][:4]==['python3','-I','-B','-c'] and data['command'][-2:]==[mid,'i001'if mid=='c001'else'i002']
 assert data['timeout']>0 and kwargs['timeout']>0
 record={'pid':596,'birth':'11111111-1111-4111-8111-111111111111:596:40','provider':os.environ['EFFECTIVE_PROVIDER'],'worker_sha256':'a'*64,'config_sha256':'b'*64,'dotenv_nonoverwriting':True}
 if scenario=='missing-provider':record.pop('provider')
 if scenario=='invalid-provider':record['provider']='unknown'
 if scenario=='source-contract':record['dotenv_nonoverwriting']=False
 if scenario=='mixed'and mid=='c002':record['provider']='steel'
 after=dict(record)
 if scenario=='pid-drift':after['birth']=after['birth'].removesuffix(':40')+':41'
 if scenario=='provider-drift':after['provider']='steel'
 rows=[record,dict(record)]if scenario=='ambiguous-worker'else[record]
 if scenario=='no-worker':rows=[]
 observation={'machine_id':mid,'instance_id':'i001'if mid=='c001'else'i002','before':rows,'after':[after]if len(rows)==1 else rows}
 if scenario=='foreign-machine':observation['machine_id']='foreign'
 reply={'exit_code':0,'exit_signal':0,'stdout':json.dumps(observation),'stderr':''}
 if scenario=='malformed-exit':reply['exit_code']=False
 if scenario=='api-missing-exit':reply.pop('exit_code')
 if scenario=='api-null-exit':reply['exit_code']=None
 if scenario=='api-string-exit':reply['exit_code']='0'
 if scenario=='api-nonzero-exit':reply['exit_code']=1
 if scenario=='api-missing-signal':reply.pop('exit_signal')
 if scenario=='api-null-signal':reply['exit_signal']=None
 if scenario=='api-signal':reply['exit_signal']=9
 if scenario=='api-malformed-stdout':reply['stdout']='not json'
 return io.BytesIO(json.dumps(reply).encode())
urllib.request.urlopen=native_request
""")
        env = dict(PATH=str(repo / 'bin') + ':' + os.environ['PATH'], HOME=str(repo / 'home'),
            FLY_BENCH_API_TOKEN='offline-fixture-selected-token', FIXTURE_ROOT=str(repo), PYTHONPATH=str(repo / 'bin'),
            UNAUTHORIZED=str(int(unauthorized)), OMIT_MARKER=str(int(omit_marker)), EFFECTIVE_PROVIDER=effective, OBSERVATION_SCENARIO=scenario)
        hashes = {str(p):hashlib.sha256(p.read_bytes()).hexdigest()
                  for p in (repo / 'agents/.env', repo / 'back-end/.env')}
        p = subprocess.run(['bash', str(repo / 'scripts/run-bench-cloud'),
            '--verify-secrets' if omit_marker else '--refresh-secrets'], cwd=repo,
            env=env, text=True, capture_output=True, timeout=30)
        self.assertEqual(hashes, {p:hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in hashes})
        return p, repo

    def test_native_cli_uses_running_worker_provider_over_machine_config(self):
        p, repo = self.cli(effective='tilion')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        staged = json.loads((repo / 'staged.json').read_text())
        self.assertEqual(staged['CLOUDBENCH_WORKER_BROWSER_PROVIDER'], 'tilion')
        calls = [json.loads(line) for line in (repo / 'calls.jsonl').read_text().splitlines()]
        self.assertTrue(any(call[:2] in (['machine', 'exec'], ['api', 'exec']) for call in calls))

    def test_native_cli_refuses_unverified_or_changed_active_runtime(self):
        for scenario in ('no-active', 'missing-instance', 'missing-provider', 'invalid-provider',
                         'source-contract', 'mixed', 'pid-drift', 'provider-drift',
                         'ambiguous-worker', 'no-worker', 'foreign-machine', 'instance-drift', 'unreachable', 'malformed-exit'):
            with self.subTest(scenario=scenario):
                # Each CLI fixture is exclusively owned; retire it before the next subcase.
                self.tearDown()
                self.temp.cleanup()
                self.setUp()
                p, repo = self.cli(effective='tilion', scenario=scenario)
                self.assertNotEqual(p.returncode, 0, scenario)
                self.assertFalse((repo / 'staged.json').exists(), scenario)
                calls = [json.loads(line) for line in (repo / 'calls.jsonl').read_text().splitlines()]
                self.assertFalse(any(call[:2] in (['machine', 'start'], ['machine', 'update'], ['secrets', 'set']) for call in calls))

    def test_stopped_machine_config_is_not_live_runtime_authority(self):
        p, repo = self.cli(effective='tilion', scenario='stopped-not-authority')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        calls = [json.loads(line) for line in (repo / 'calls.jsonl').read_text().splitlines()]
        self.assertEqual([call[2] for call in calls if call[:2] in (['machine', 'exec'], ['api', 'exec'])], ['c001'])

    def test_actual_cli_omitted_zero_status_uses_explicit_raw_api_completion(self):
        p, repo = self.cli(effective='tilion', scenario='cli-omits-zero')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertEqual(json.loads((repo / 'staged.json').read_text())['CLOUDBENCH_WORKER_BROWSER_PROVIDER'], 'tilion')

    def test_raw_api_requires_explicit_typed_normal_completion(self):
        for scenario in ('api-missing-exit', 'api-null-exit', 'api-string-exit', 'api-nonzero-exit',
                         'api-missing-signal', 'api-null-signal', 'api-signal', 'api-malformed-stdout', 'api-http-error'):
            with self.subTest(scenario=scenario):
                self.temp.cleanup()
                self.setUp()
                p, repo = self.cli(effective='tilion', scenario=scenario)
                self.assertNotEqual(p.returncode, 0, scenario)
                self.assertFalse((repo / 'staged.json').exists(), scenario)

    def test_native_cli_stages_independent_markers_and_activates_only_safe_targets(self):
        p, repo = self.cli()
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        staged = json.loads((repo / 'staged.json').read_text())
        self.assertEqual(staged['CLOUDBENCH_BROWSER_PROVIDER'], 'tilion')
        self.assertEqual(staged['CLOUDBENCH_WORKER_BROWSER_PROVIDER'], 'kernel')
        for kind in ('AGENTS', 'BACKEND'):
            content = base64.b64decode(staged[kind + '_ENV_B64'])
            self.assertEqual(hashlib.sha256(content).hexdigest(), staged[kind + '_ENV_SHA256'])
        manifest = json.loads((repo / '.context/cloudbench-env-manifest.json').read_text())
        self.assertEqual((manifest['browser_provider'], manifest['worker_browser_provider']), ('tilion', 'kernel'))
        calls = [json.loads(x) for x in (repo / 'calls.jsonl').read_text().splitlines()]
        updates = [x for x in calls if x[:2] == ['machine', 'update']]
        self.assertEqual([x[2] for x in updates], ['a001', 'b001'])
        self.assertTrue(all('--skip-start' in x for x in updates))
        self.assertFalse(any('start' in x or 'create' in x for x in calls))

    def test_native_cli_refuses_unverified_production_authority_before_staging(self):
        p, repo = self.cli(unauthorized=True)
        self.assertNotEqual(p.returncode, 0)
        self.assertFalse((repo / 'staged.json').exists())
        self.assertIn('could not read production Fly worker configuration', p.stderr)

    def test_readonly_cli_requires_worker_marker_before_any_run(self):
        p, repo = self.cli(omit_marker=True)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('CLOUDBENCH_WORKER_BROWSER_PROVIDER', p.stdout + p.stderr)
        self.assertFalse((repo / 'staged.json').exists())


if __name__ == '__main__':
    unittest.main()
