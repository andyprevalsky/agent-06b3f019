#!/usr/bin/env python3
"""Exercise controller-owned source environment handoffs before native effects."""
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts'


class SourceHandoff(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        fixture = runpy.run_path(str(SCRIPTS / 'tests/cloudbench-source-version.test.py'))['SourceVersion']()
        fixture.setUp()
        self.manifest = self.directory / 'source.json'
        self.manifest.write_text(json.dumps(fixture.v2))
        self.digest = hashlib.sha256(self.manifest.read_bytes()).hexdigest()
        self.provenance = self.directory / 'provenance.json'
        self.provenance.write_text(json.dumps({'config': {'values': {
            'base_source_manifest_sha256': self.digest,
            'base_source_lease_protocol': 'cloudbench-source-lease-v1'}}}))
        self.env = {**os.environ, 'CLOUDBENCH_RUNTIME_SCRIPT_ROOT': str(SCRIPTS),
            'CLOUDBENCH_SOURCE_MANIFEST_FILE': str(self.manifest),
            'CLOUDBENCH_SOURCE_MANIFEST_SHA256': self.digest,
            'CLOUDBENCH_SOURCE_LEASE_PROTOCOL': 'cloudbench-source-lease-v1',
            'CLOUDBENCH_EXECUTION_PROVENANCE_FILE': str(self.provenance)}
        self.cloud = (SCRIPTS / 'run-bench-cloud').read_text()

    def admission(self):
        function = re.search(r'^verify_private_source_environment_contract\(\) \{.*?^\}', self.cloud, re.M | re.S)
        self.assertIsNotNone(function, 'native source environment handoff has no admission boundary')
        return subprocess.run(['bash', '-c', function.group() + '\nverify_private_source_environment_contract'],
                              env=self.env, capture_output=True, text=True, timeout=8)

    def test_captured_v2_environment_is_bound_to_provenance(self):
        self.assertEqual(self.admission().returncode, 0)
        self.manifest.write_bytes(self.manifest.read_bytes() + b' ')
        self.assertNotEqual(self.admission().returncode, 0)
        self.env['CLOUDBENCH_SOURCE_MANIFEST_SHA256'] = hashlib.sha256(self.manifest.read_bytes()).hexdigest()
        self.assertNotEqual(self.admission().returncode, 0, 'caller resealing bypassed original provenance')

    def test_missing_or_downgraded_v2_handoff_refuses(self):
        original = dict(self.env)
        for key in ('CLOUDBENCH_SOURCE_MANIFEST_FILE', 'CLOUDBENCH_SOURCE_MANIFEST_SHA256',
                    'CLOUDBENCH_SOURCE_LEASE_PROTOCOL'):
            self.env = dict(original); self.env.pop(key)
            self.assertNotEqual(self.admission().returncode, 0, key)

    def test_shared_legacy_launch_does_not_need_private_contract(self):
        for key in tuple(self.env):
            if key.startswith('CLOUDBENCH_SOURCE_') or key == 'CLOUDBENCH_EXECUTION_PROVENANCE_FILE':
                self.env.pop(key)
        self.assertEqual(self.admission().returncode, 0)

    def test_boot_payload_transports_captured_file_and_exact_digest(self):
        block = re.search(r'^    if \[ "\$\{CLOUDBENCH_SOURCE_LEASE_PROTOCOL:-none\}" = cloudbench-source-lease-v1 \]; then.*?^    fi',
                          self.cloud, re.M | re.S)
        self.assertIsNotNone(block)
        script = '_envargs=(); _boot_file_args=()\n' + block.group() + '\nprintf "%s\\n" "${_envargs[@]}" "${_boot_file_args[@]}"'
        result = subprocess.run(['bash', '-c', script], env=self.env, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        args = result.stdout.splitlines()
        self.assertIn('/cloudbench-source-manifest.json=' + str(self.manifest), args)
        self.assertIn('CLOUDBENCH_SOURCE_MANIFEST_SHA256=' + self.digest, args)

    def test_worker_wrapper_overwrites_ambient_contract_from_capture(self):
        fleet = (SCRIPTS / 'run-bench-fleet').read_text()
        lines = [line for line in fleet.splitlines() if 'echo "export CLOUDBENCH_SOURCE_' in line]
        self.assertEqual(len(lines), 3)
        env = dict(self.env, PRIVATE_SOURCE_FILE=str(self.manifest), PRIVATE_SOURCE_SHA256=self.digest,
                   PRIVATE_SOURCE_LEASE_PROTOCOL='cloudbench-source-lease-v1')
        rendered = subprocess.run(['bash', '-c', '\n'.join(lines)], env=env,
                                  capture_output=True, text=True, timeout=5)
        self.assertEqual(rendered.returncode, 0, rendered.stderr)
        # Simulate app secrets trying to replace all three handoff variables.
        self.env.update(CLOUDBENCH_SOURCE_MANIFEST_FILE='', CLOUDBENCH_SOURCE_MANIFEST_SHA256='',
                        CLOUDBENCH_SOURCE_LEASE_PROTOCOL='')
        script = rendered.stdout + '\nprintf "%s\\n" "$CLOUDBENCH_SOURCE_MANIFEST_FILE" "$CLOUDBENCH_SOURCE_MANIFEST_SHA256" "$CLOUDBENCH_SOURCE_LEASE_PROTOCOL"'
        actual = subprocess.run(['bash', '-c', script], env=self.env, capture_output=True, text=True, timeout=5)
        self.assertEqual(actual.returncode, 0, actual.stderr)
        self.assertEqual(actual.stdout.splitlines(), ['/data/cloudbench-source-manifest.json', self.digest, 'cloudbench-source-lease-v1'])


if __name__ == '__main__':
    unittest.main()
