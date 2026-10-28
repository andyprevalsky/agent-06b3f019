#!/usr/bin/env python3
"""Offline role-specific provider receipts; no service, credentials or guest calls."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / 'scripts/lib/cloudbench-env.sh'
CLOUD = ROOT / 'scripts/run-bench-cloud'


def function(name):
    source = CLOUD.read_text()
    start = source.index(name + '() {')
    return source[start:source.index('\n}', start) + 2]


class ProviderContract(unittest.TestCase):
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
                # Old equal-role receipts remain usable. Missing worker pin cannot admit heterogeneity.
                self.assertEqual(self.run_shell(prefix + call, {'CLOUDBENCH_BROWSER_PROVIDER': 'kernel'}).returncode, 0)
                self.write('kernel', 'tilion')
                self.assertNotEqual(self.run_shell(prefix + call, {'CLOUDBENCH_BROWSER_PROVIDER': 'tilion'}).returncode, 0)


if __name__ == '__main__':
    unittest.main()
