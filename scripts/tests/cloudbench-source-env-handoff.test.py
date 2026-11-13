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
        self.assertEqual(len(lines), 6)
        env = dict(self.env, PRIVATE_SOURCE_FILE=str(self.manifest), PRIVATE_SOURCE_SHA256=self.digest,
                   PRIVATE_SOURCE_LEASE_PROTOCOL='cloudbench-source-lease-v1',
                   PRIVATE_SOURCE_GUEST_ENV_MODE='none', PRIVATE_SOURCE_GUEST_ENV_CAPSULE_SHA256='none')
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

    def test_owned_capsule_host_contract_cannot_be_cleared_or_resealed(self):
        value=json.loads(self.manifest.read_bytes())
        value.update(guest_env_mode='owned-capsule-v1',guest_env_capsule_sha256='9'*64,
            guest_env_capsule_binding=dict(owner_token=value['owner_token'],create_nonce=value['creation_nonce'],
                source_ref='a'*40,image_ref='registry.fly.io/navi-whisper-lux-bench@'+value['image_digest'],
                node_fingerprint=value['node_fingerprint'],python_fingerprint=value['python_fingerprint']))
        self.manifest.write_text(json.dumps(value));self.digest=hashlib.sha256(self.manifest.read_bytes()).hexdigest()
        self.env.update(CLOUDBENCH_SOURCE_MANIFEST_SHA256=self.digest,
            CLOUDBENCH_SOURCE_GUEST_ENV_MODE='owned-capsule-v1',CLOUDBENCH_SOURCE_GUEST_ENV_CAPSULE_SHA256='9'*64)
        self.provenance.write_text(json.dumps({'config':{'values':dict(base_source_manifest_sha256=self.digest,
            base_source_lease_protocol='cloudbench-source-lease-v1',base_source_guest_env_mode='owned-capsule-v1',
            base_source_guest_env_capsule_sha256='9'*64)}}))
        self.assertEqual(self.admission().returncode,0)
        for key in ('CLOUDBENCH_SOURCE_GUEST_ENV_MODE','CLOUDBENCH_SOURCE_GUEST_ENV_CAPSULE_SHA256'):
            original=self.env.pop(key)
            self.assertNotEqual(self.admission().returncode,0,key)
            self.env[key]=original

    def test_all_transports_stage_loader_and_literal_owned_capsule_contract(self):
        fleet=(SCRIPTS/'run-bench-fleet').read_text()
        for text in (self.cloud,fleet):
            self.assertIn('cloudbench-source-env.py',text)
            self.assertIn('CLOUDBENCH_SOURCE_GUEST_ENV_MODE',text)
            self.assertIn('CLOUDBENCH_SOURCE_GUEST_ENV_CAPSULE_SHA256',text)
        self.assertIn('"/cloudbench-source-env.py=$CLOUDBENCH_GUEST_SOURCE_ENV_HELPER"',self.cloud)
        self.assertIn('"$CLOUDBENCH_GUEST_SOURCE_ENV_HELPER" /data/cloudbench-source-env.py',self.cloud)
        self.assertIn('"$CLOUDBENCH_SCRIPT_SNAPSHOT/cloudbench-source-env.py" /data/cloudbench-source-env.py',fleet)
        self.assertIn('printf \'%s\\0\' "${_envargs[@]}" "${_boot_file_args[@]}"',self.cloud)
        for name in ('cloudbench-run.sh','cloudbench-worker.sh','cloudbench-entrypoint.sh'):
            source=(SCRIPTS/name).read_text()
            self.assertLess(source.index('"$_source_env_helper" mode'),source.index('source "$ENV_HELPER"'))
            self.assertIn('exec python3 "$_source_env_helper" exec -- /bin/bash',source)


class CanonicalBrowserProjection(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.agents=self.root/'agents.env';self.backend=self.root/'backend.env';self.output=self.root/'private'
        self.output.mkdir(mode=0o700)
        self.agents.write_bytes(b'# approved worker\r\nexport BROWSER_PROVIDER="tilion"\r\nSECRET=never-print-this\r\n')
        self.backend.write_bytes(b'BROWSER_PROVIDER=tilion\nOTHER=unchanged\n')

    def project(self,backend='tilion',worker='kernel'):
        result=subprocess.run(['bash','-c','source "$1"; cloudbench_write_guest_browser_env_files "$2" "$3" "$4" "$5" "$6"',
            'fixture',str(SCRIPTS/'lib/cloudbench-env.sh'),str(self.agents),str(self.backend),backend,worker,str(self.output)],
            capture_output=True,text=True,timeout=5)
        self.assertNotIn('never-print-this',result.stdout+result.stderr)
        return result

    def test_canonical_parent_function_is_exact_pinned_body(self):
        source=(SCRIPTS/'lib/cloudbench-env.sh').read_text()
        body=re.search(r'^cloudbench_write_guest_browser_env_files\(\) \{.*?^\}',source,re.M|re.S).group()
        self.assertEqual(hashlib.sha256(body.encode()).hexdigest(),'2fb72bb7fca6a5e0a2855733e96cc614226279906f786b06460b066d81ae0edd')

    def test_quoted_worker_projection_preserves_approved_backend_and_all_other_bytes(self):
        before=(self.agents.read_bytes(),self.backend.read_bytes())
        result=self.project();self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual((self.agents.read_bytes(),self.backend.read_bytes()),before)
        self.assertEqual((self.output/'agents.env').read_bytes(),before[0].replace(b'"tilion"',b'kernel'))
        self.assertEqual((self.output/'backend.env').read_bytes(),before[1])
        manifest=json.loads((self.output/'browser-projection.json').read_bytes())
        self.assertEqual(manifest['allowed_changes'],{'agents.env':['BROWSER_PROVIDER'],'backend.env':[]})
        self.assertEqual((self.output/'agents.env').stat().st_mode&0o777,0o600)

    def test_backend_mismatch_unknown_and_duplicate_assignments_refuse(self):
        original=self.agents.read_bytes()
        self.assertNotEqual(self.project(backend='kernel').returncode,0)
        self.assertFalse((self.output/'backend.env').exists())
        for raw in (b'BROWSER_PROVIDER=unknown\n',b'BROWSER_PROVIDER=kernel\nBROWSER_PROVIDER=tilion\n',b'BROWSER_PROVIDER="tilion\n'):
            self.agents.write_bytes(raw);self.assertNotEqual(self.project().returncode,0)
        self.backend.write_bytes(b'BROWSER_PROVIDER=kernel\n');self.agents.write_bytes(original)
        self.assertNotEqual(self.project(worker='unknown').returncode,0)


if __name__ == '__main__':
    unittest.main()
