#!/usr/bin/env python3
"""Exercise native per-surface provider validation and maintenance without a network."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import re
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

    def cli(self, unauthorized=False, omit_marker=False):
        repo = self.root / 'repo'
        repo.mkdir()
        shutil.copytree(ROOT / 'scripts', repo / 'scripts')
        for name in ('agents', 'back-end', 'bin', 'home'):
            (repo / name).mkdir()
        subprocess.run(['git', 'init', '-q', str(repo)], check=True)
        (repo / 'agents/.env').write_text('BROWSER_PROVIDER=kernel\nUNCHANGED=fake-worker-secret\n')
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
  print(json.dumps([{'id':'c001','config':{'env':{'BROWSER_PROVIDER':'kernel'}}}]))
 else:print(json.dumps([{'id':'a001','name':'cloudbench-warm','state':'stopped','config':{}},{'id':'b001','state':'stopped','config':{}},{'id':'b002','state':'started','config':{}}]))
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
        env = dict(PATH=str(repo / 'bin') + ':' + os.environ['PATH'], HOME=str(repo / 'home'),
            FLY_BENCH_API_TOKEN='offline-fixture-selected-token', FIXTURE_ROOT=str(repo),
            UNAUTHORIZED=str(int(unauthorized)), OMIT_MARKER=str(int(omit_marker)))
        hashes = {str(p):hashlib.sha256(p.read_bytes()).hexdigest()
                  for p in (repo / 'agents/.env', repo / 'back-end/.env')}
        p = subprocess.run(['bash', str(repo / 'scripts/run-bench-cloud'),
            '--verify-secrets' if omit_marker else '--refresh-secrets'], cwd=repo,
            env=env, text=True, capture_output=True, timeout=30)
        self.assertEqual(hashes, {p:hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in hashes})
        return p, repo

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


CLOUD = ROOT / 'scripts/run-bench-cloud'


def function(name):
    source = CLOUD.read_text()
    start = source.index(name + '() {')
    return source[start:source.index('\n}', start) + 2]


class RolePinRegression(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='provider-contract-')
        self.root = Path(self.temp.name)
        (self.root / 'agents').mkdir()
        (self.root / 'back-end').mkdir()
        self.agents = self.root / 'agents/.env'
        self.backend = self.root / 'back-end/.env'
        self.write('kernel', 'tilion')

    def tearDown(self):
        self.temp.cleanup()

    def write(self, worker, backend, key=True):
        self.agents.write_text(f'BROWSER_PROVIDER={worker}\n')
        self.backend.write_text(f'BROWSER_PROVIDER={backend}\n' + ('TILION_API_KEY=fixture-only-key\n' if key else ''))

    def run_shell(self, code, extra=None):
        env = {'PATH': os.environ['PATH'], 'FIXTURE_ROOT': str(self.root)}
        env.update(extra or {})
        result = subprocess.run(['bash', '-c', 'set -euo pipefail\nsource "$1"\n' + code,
                                 'provider-test', str(HELPER)], cwd=self.root,
                                env=env, capture_output=True, text=True)
        self.assertNotIn('fixture-only-key', result.stdout + result.stderr)
        return result

    def validate(self, backend='tilion', worker='kernel'):
        return self.run_shell(f'cloudbench_validate_browser_provider_contract agents/.env back-end/.env {backend} {worker}')

    def test_respective_production_roles(self):
        result = self.validate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('backend=tilion worker=kernel', result.stdout)

    def test_wrong_local_role_remains_refused(self):
        self.write('kernel', 'kernel')
        self.assertIn('benchmark backend env does not match', self.validate().stderr)
        self.write('tilion', 'tilion')
        self.assertIn('benchmark worker env does not match', self.validate().stderr)

    def test_unknown_roles_and_missing_key_remain_refused(self):
        self.assertNotEqual(self.validate('unknown', 'kernel').returncode, 0)
        self.assertNotEqual(self.validate('tilion', 'unknown').returncode, 0)
        self.write('kernel', 'tilion', key=False)
        self.assertIn('no TILION_API_KEY', self.validate().stderr)

    def test_stage_pins_both_roles_and_immutable_env_bytes(self):
        before = (self.agents.read_bytes(), self.backend.read_bytes())
        script = function('validate_environment_contract') + '\n' + function('_inject_secrets_locked') + r'''
ROOT_DIR="$FIXTURE_ROOT"
APP=fixture-app
resolve_prod_backend_browser_provider() { printf 'tilion\n'; }
resolve_prod_worker_browser_provider() { printf 'kernel\n'; }
cloudbench_require_agentcard_org_oauth() { :; }
cloudbench_guest_temporal_override_file() { :; }
cloudbench_require_staged_guest_temporal_namespace() { :; }
resolve_durable_github_token() { printf 'fixture-git-token\n'; }
assert_app_environment_lock_ownership() { :; }
environment_activation_targets() { :; }
FLY() { printf '%s\n' "$@" > "$FIXTURE_ROOT/staged-args"; }
_inject_secrets_locked
'''
        result = self.run_shell(script)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        args = dict(line.split('=', 1) for line in (self.root / 'staged-args').read_text().splitlines() if '=' in line)
        self.assertEqual(args['CLOUDBENCH_BROWSER_PROVIDER'], 'tilion')
        self.assertEqual(args['CLOUDBENCH_WORKER_BROWSER_PROVIDER'], 'kernel')
        for label, original in zip(('AGENTS', 'BACKEND'), before):
            self.assertEqual(base64.b64decode(args[label + '_ENV_B64']), original)
            self.assertEqual(args[label + '_ENV_SHA256'], hashlib.sha256(original).hexdigest())
        manifest = json.loads((self.root / '.context/cloudbench-env-manifest.json').read_text())
        self.assertEqual(manifest['browser_provider'], 'tilion')
        self.assertEqual(manifest['worker_browser_provider'], 'kernel')
        self.assertEqual((self.agents.read_bytes(), self.backend.read_bytes()), before)

    def test_all_guest_call_sites_consume_role_pins(self):
        for filename in ('cloudbench-entrypoint.sh', 'cloudbench-run.sh', 'cloudbench-worker.sh'):
            with self.subTest(filename=filename):
                source = (ROOT / 'scripts' / filename).read_text()
                call = re.search(r'(?ms)^cloudbench_validate_browser_provider_contract \\\n.*?\|\| (?:exit|finish) 1', source).group(0)
                prefix = 'APP_DIR="$FIXTURE_ROOT"\nREPO_DIR="$FIXTURE_ROOT"\nfinish() { exit "$1"; }\n'
                result = self.run_shell(prefix + call, {'CLOUDBENCH_BROWSER_PROVIDER': 'tilion', 'CLOUDBENCH_WORKER_BROWSER_PROVIDER': 'kernel'})
                self.assertEqual(result.returncode, 0, result.stderr)
                # An explicitly empty role is unknown; it must not silently become the other role.
                result = self.run_shell(prefix + call, {'CLOUDBENCH_BROWSER_PROVIDER': 'tilion', 'CLOUDBENCH_WORKER_BROWSER_PROVIDER': ''})
                self.assertNotEqual(result.returncode, 0)
                self.write('kernel', 'kernel')
                # New main receipts require the explicit worker role even for equal roles.
                self.assertEqual(self.run_shell(prefix + call, {'CLOUDBENCH_BROWSER_PROVIDER': 'kernel', 'CLOUDBENCH_WORKER_BROWSER_PROVIDER': 'kernel'}).returncode, 0)
                self.assertNotEqual(self.run_shell(prefix + call, {'CLOUDBENCH_BROWSER_PROVIDER': 'kernel'}).returncode, 0)
                self.write('kernel', 'tilion')
                self.assertNotEqual(self.run_shell(prefix + call, {'CLOUDBENCH_BROWSER_PROVIDER': 'tilion'}).returncode, 0)


if __name__ == '__main__':
    unittest.main()
