#!/usr/bin/env python3
"""Exercise the actual guest decode boundaries without provider or secret access."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPTS = Path(os.environ.get('SOURCE_GUEST_ENV_TEST_SCRIPTS', Path(__file__).resolve().parents[1]))
PROTOCOL = 'cloudbench-source-lease-v1'


class GuestEnvironment(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.blobs = {key: base64.b64encode((key + '=original\n').encode()).decode()
                      for key in ('AGENTS_ENV_B64', 'BACKEND_ENV_B64')}
        self.contract = {key: hashlib.sha256(value.encode()).hexdigest() for key, value in self.blobs.items()}
        self.manifest = dict(version=2, lease_protocol=PROTOCOL, guest_env_sha256=self.contract)
        self.path = self.root / 'manifest.json'
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(('CLOUDBENCH_', 'AGENTS_ENV_', 'BACKEND_ENV_', 'FLY_MACHINE_'))}
        self.env.update(self.blobs, FLY_MACHINE_ID='0123456789abcd', CLOUDBENCH_RUN_TOKEN='fixture-run',
                        CLOUDBENCH_DATA_DIR=str(self.root), CLOUDBENCH_SOURCE_MANIFEST_FILE=str(self.path),
                        CLOUDBENCH_SOURCE_LEASE_PROTOCOL=PROTOCOL)
        self.env.update({key.replace('_B64', '_SHA256'): hashlib.sha256(base64.b64decode(value)).hexdigest()
                         for key, value in self.blobs.items()})
        self.seal()

    def seal(self, raw=None):
        self.path.write_bytes(raw if raw is not None else json.dumps(self.manifest).encode())
        self.env['CLOUDBENCH_SOURCE_MANIFEST_SHA256'] = hashlib.sha256(self.path.read_bytes()).hexdigest()

    def run_guest(self, script=None):
        code = 'source "$ENV_HELPER"\ncloudbench_verify_source_guest_env'
        if script:
            source = (SCRIPTS / script).read_text()
            start = source.index('source "$ENV_HELPER"')
            first = source.index('cloudbench_verify_env_file ', start)
            second = source.index('cloudbench_verify_env_file ', first + 1)
            end = source.index('\n', second)
            code = source[start:end]
        for name in ('agents', 'back-end'):
            (self.root / name).mkdir(exist_ok=True)
        env = dict(self.env, ENV_HELPER=str(SCRIPTS / 'lib/cloudbench-env.sh'),
                   REPO_DIR=str(self.root), APP_DIR=str(self.root))
        return subprocess.run(['bash', '-c', 'log() { :; }; finish() { exit "$1"; }; chown() { :; };\n' + code],
                              env=env, capture_output=True, text=True, timeout=10)

    def receipt(self):
        return self.root / 'cloudbench-source-guest-env-fixture-run.json'

    def test_coherent_global_secret_rotation_refuses_before_all_decode_writes(self):
        for key in self.blobs:
            raw = (key + '=rotated\n').encode()
            self.env[key] = base64.b64encode(raw).decode()
            self.env[key.replace('_B64', '_SHA256')] = hashlib.sha256(raw).hexdigest()
        for script in ('cloudbench-run.sh', 'cloudbench-worker.sh', 'cloudbench-entrypoint.sh'):
            with self.subTest(script=script):
                result = self.run_guest(script)
                self.assertNotEqual(result.returncode, 0, 'coherent secret rotation was accepted')
                self.assertFalse((self.root / 'agents/.env').exists())
                self.assertFalse((self.root / 'back-end/.env').exists())
                self.assertFalse(self.receipt().exists())
                self.assertTrue(all(self.env[key] not in result.stdout + result.stderr for key in self.blobs))

    def test_matching_contract_decodes_and_durably_binds_each_clone(self):
        for script in ('cloudbench-run.sh', 'cloudbench-worker.sh', 'cloudbench-entrypoint.sh'):
            with self.subTest(script=script):
                result = self.run_guest(script)
                self.assertEqual(result.returncode, 0, result.stderr)
                value = json.loads(self.receipt().read_text())
                self.assertEqual(value['machine_id'], self.env['FLY_MACHINE_ID'])
                self.assertEqual(value['run_token'], self.env['CLOUDBENCH_RUN_TOKEN'])
                self.assertEqual(value['source_manifest_sha256'], self.env['CLOUDBENCH_SOURCE_MANIFEST_SHA256'])
                self.assertEqual(value['guest_env_sha256'], self.contract)
                self.assertEqual(self.receipt().stat().st_mode & 0o777, 0o600)
                self.assertEqual((self.root / 'agents/.env').read_bytes(), base64.b64decode(self.blobs['AGENTS_ENV_B64']))

    def test_legacy_without_contract_still_decodes(self):
        for key in ('CLOUDBENCH_SOURCE_MANIFEST_FILE', 'CLOUDBENCH_SOURCE_MANIFEST_SHA256', 'CLOUDBENCH_SOURCE_LEASE_PROTOCOL'):
            self.env.pop(key)
        for script in ('cloudbench-run.sh', 'cloudbench-worker.sh', 'cloudbench-entrypoint.sh'):
            result = self.run_guest(script)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.receipt().exists())

    def test_partial_markers_and_unknown_protocol_refuse(self):
        original = dict(self.env)
        for key in ('CLOUDBENCH_SOURCE_MANIFEST_FILE', 'CLOUDBENCH_SOURCE_MANIFEST_SHA256', 'CLOUDBENCH_SOURCE_LEASE_PROTOCOL'):
            self.env = dict(original); self.env.pop(key)
            self.assertNotEqual(self.run_guest().returncode, 0)
        self.env = dict(original, CLOUDBENCH_SOURCE_LEASE_PROTOCOL='unknown')
        self.assertNotEqual(self.run_guest().returncode, 0)

    def test_manifest_tampering_and_malformed_contract_refuse(self):
        for wrong in ({}, {'AGENTS_ENV_B64': 'a'*64}, dict(self.contract, EXTRA='b'*64),
                      dict(self.contract, AGENTS_ENV_B64='bad'), dict(self.contract, AGENTS_ENV_B64=42)):
            self.manifest['guest_env_sha256'] = wrong; self.seal()
            self.assertNotEqual(self.run_guest().returncode, 0)
        self.manifest['guest_env_sha256'] = self.contract; self.seal()
        self.path.write_text(self.path.read_text() + ' ')
        self.assertNotEqual(self.run_guest().returncode, 0)
        for raw in (b'[]', b'{', b'{"version":2,"version":2}'):
            self.seal(raw); self.assertNotEqual(self.run_guest().returncode, 0)

    def test_symlink_or_missing_manifest_refuses(self):
        target = self.root / 'target'; self.path.rename(target); self.path.symlink_to(target)
        self.assertNotEqual(self.run_guest().returncode, 0)
        self.path.unlink(); self.assertNotEqual(self.run_guest().returncode, 0)

    def test_primary_provenance_must_bind_same_manifest(self):
        path = self.root / 'provenance.json'
        self.env['CLOUDBENCH_EXECUTION_PROVENANCE_FILE'] = str(path)
        path.write_text(json.dumps({'config': {'values': {'base_source_manifest_sha256': '0'*64}}}))
        self.assertNotEqual(self.run_guest().returncode, 0)
        path.write_text(json.dumps({'config': {'values': {'base_source_manifest_sha256': self.env['CLOUDBENCH_SOURCE_MANIFEST_SHA256']}}}))
        self.assertEqual(self.run_guest().returncode, 0)

    def test_primary_provenance_prevents_cleared_marker_downgrade(self):
        path = self.root / 'provenance.json'
        path.write_text(json.dumps({'config': {'values': {
            'base_source_lease_protocol': PROTOCOL,
            'base_source_manifest_sha256': self.env['CLOUDBENCH_SOURCE_MANIFEST_SHA256']}}}))
        self.env['CLOUDBENCH_EXECUTION_PROVENANCE_FILE'] = str(path)
        for key in ('CLOUDBENCH_SOURCE_MANIFEST_FILE', 'CLOUDBENCH_SOURCE_MANIFEST_SHA256', 'CLOUDBENCH_SOURCE_LEASE_PROTOCOL'):
            self.env[key] = ''
        self.assertNotEqual(self.run_guest('cloudbench-run.sh').returncode, 0)
        self.assertFalse((self.root / 'agents/.env').exists())

    def test_malformed_provenance_cannot_be_treated_as_legacy(self):
        path = self.root / 'provenance.json'
        self.env['CLOUDBENCH_EXECUTION_PROVENANCE_FILE'] = str(path)
        for key in ('CLOUDBENCH_SOURCE_MANIFEST_FILE', 'CLOUDBENCH_SOURCE_MANIFEST_SHA256', 'CLOUDBENCH_SOURCE_LEASE_PROTOCOL'):
            self.env[key] = ''
        for value in (None, {}, [], {'config': {'values': []}}):
            path.write_text(json.dumps(value))
            for script in ('cloudbench-run.sh', 'cloudbench-worker.sh', 'cloudbench-entrypoint.sh'):
                with self.subTest(value=value, script=script):
                    self.assertNotEqual(self.run_guest(script).returncode, 0)
                    self.assertFalse((self.root / 'agents/.env').exists())
                    self.assertFalse((self.root / 'back-end/.env').exists())

    def test_missing_native_identity_or_run_token_refuses(self):
        for key in ('FLY_MACHINE_ID', 'CLOUDBENCH_RUN_TOKEN'):
            value = self.env.pop(key)
            self.assertNotEqual(self.run_guest().returncode, 0)
            self.env[key] = value

    def test_existing_observation_cannot_be_rebound(self):
        result = self.run_guest(); self.assertEqual(result.returncode, 0, result.stderr)
        original = self.receipt().read_bytes()
        self.env['FLY_MACHINE_ID'] = 'ffffffffffffff'
        self.assertNotEqual(self.run_guest().returncode, 0)
        self.assertEqual(self.receipt().read_bytes(), original)

    def test_concurrent_future_clones_keep_contract_and_refuse_rotated_peer(self):
        children = []
        for index in range(3):
            directory = self.root / str(index); directory.mkdir()
            env = dict(self.env, CLOUDBENCH_DATA_DIR=str(directory),
                       FLY_MACHINE_ID='0123456789abc' + str(index))
            if index == 2:
                env['AGENTS_ENV_B64'] = base64.b64encode(b'REVIEW_FIXTURE=rotated\n').decode()
                env['AGENTS_ENV_SHA256'] = hashlib.sha256(b'REVIEW_FIXTURE=rotated\n').hexdigest()
            code = 'source "$1"; cloudbench_verify_source_guest_env'
            process = subprocess.Popen(['bash', '-c', code, 'fixture', str(SCRIPTS / 'lib/cloudbench-env.sh')],
                                       env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            children.append((process, directory))
        for index, (process, directory) in enumerate(children):
            stdout, stderr = process.communicate(timeout=10)
            self.assertEqual(process.returncode == 0, index != 2, stderr)
            receipt = directory / self.receipt().name
            self.assertEqual(receipt.exists(), index != 2)
            if index != 2:
                value = json.loads(receipt.read_text())
                self.assertEqual(value['guest_env_sha256'], self.contract)
                self.assertEqual(value['machine_id'], '0123456789abc' + str(index))


if __name__ == '__main__':
    unittest.main()
