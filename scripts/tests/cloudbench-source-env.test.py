#!/usr/bin/env python3
"""Exercise private capsule building, source binding and the real exec boundary."""
import base64
from concurrent.futures import ThreadPoolExecutor
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
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / 'scripts/cloudbench-source-env.py'
MODULE = runpy.run_path(str(HELPER))


class CapsuleTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.root.chmod(0o700)
        self.secret = 'fixture-SECRET-canary-28fd'
        self.binding = dict(owner_token='1' * 32, create_nonce='2' * 32, source_ref='3' * 40,
            image_ref='registry.fly.io/navi-whisper-lux-bench@sha256:' + '4' * 64,
            node_fingerprint='5' * 64, python_fingerprint='6' * 64)
        self.originals = {key: ('# approved bytes\r\nBROWSER_PROVIDER=steel\r\nSECRET=' + self.secret
                               + '\r\nTEMPORAL_ADDRESS=old:7233\r\nTEMPORAL_NAMESPACE=old\r\nTEMPORAL_API_KEY=old\r\n').encode()
                          for key in MODULE['ENV_KEYS']}
        self.originals['BACKEND_ENV_B64'] = self.originals['BACKEND_ENV_B64'].replace(b'BROWSER_PROVIDER=steel', b'BROWSER_PROVIDER=kernel')
        self.projected = {key: raw.replace(b'BROWSER_PROVIDER=steel', b'BROWSER_PROVIDER=kernel')
            .replace(b'TEMPORAL_ADDRESS=old:7233', b'TEMPORAL_ADDRESS=private.example:7233')
            .replace(b'TEMPORAL_NAMESPACE=old', b'TEMPORAL_NAMESPACE=bench-private')
            .replace(b'TEMPORAL_API_KEY=old', b'TEMPORAL_API_KEY=private-key') for key, raw in self.originals.items()}
        self.request = dict(schema='cloudbench-owned-env-build-v1', binding=self.binding,
            approved_inputs={key: self.write(key + '.approved', raw) for key, raw in self.originals.items()},
            projected_inputs={key: self.write(key + '.projected', raw) for key, raw in self.projected.items()},
            temporal_override=self.write('temporal', b'CLOUDBENCH_GUEST_TEMPORAL_ADDRESS=private.example:7233\n'
                b'CLOUDBENCH_GUEST_TEMPORAL_NAMESPACE=bench-private\nCLOUDBENCH_GUEST_TEMPORAL_API_KEY=private-key\n'),
            env_helper=dict(path=str(ROOT / 'scripts/lib/cloudbench-env.sh'),
                            sha256=MODULE['sha']((ROOT / 'scripts/lib/cloudbench-env.sh').read_bytes())),
            provider_proof=self.write('provider-proof', MODULE['canonical'](dict(schema='cloudbench-production-browser-proof-v1',
                observed_epoch=int(time.time()), backend='kernel', worker='kernel',
                evidence=dict(backend=self.write('render-proof', b'fixture authenticated Render observation'),
                              worker=self.write('fly-proof', b'fixture authenticated Fly observation'))))),
            not_before_epoch=int(time.time()) - 1)
        self.request_path = self.root / 'request.json'
        self.output = self.root / 'capsule.json'

    def write(self, name, raw):
        path = self.root / name
        path.write_bytes(raw)
        path.chmod(0o600)
        return dict(path=str(path), sha256=MODULE['sha'](raw))

    def build(self):
        raw = MODULE['canonical'](self.request)
        self.write('request.json', raw)
        return MODULE['build'](self.request_path, MODULE['sha'](raw), self.output)

    def capsule(self):
        self.build()
        return MODULE['parse'](self.output.read_bytes())

    def manifest(self, raw):
        capsule = MODULE['parse'](raw)
        return dict(version=2, lease_protocol='cloudbench-source-lease-v1', guest_env_mode=MODULE['MODE'],
            guest_env_capsule_sha256=MODULE['sha'](raw), guest_env_sha256=capsule['guest_env_sha256'],
            guest_env_capsule_binding=copy.deepcopy(self.binding),
            owner_token=self.binding['owner_token'], creation_nonce=self.binding['create_nonce'],
            image_digest=self.binding['image_ref'].rsplit('@', 1)[1], node_fingerprint=self.binding['node_fingerprint'],
            python_fingerprint=self.binding['python_fingerprint'])

    def test_build_preserves_approved_files_and_only_authorized_projection(self):
        result = self.build()
        raw = self.output.read_bytes()
        capsule = MODULE['validate_capsule'](raw, self.manifest(raw), self.binding['source_ref'])
        for key, descriptor in self.request['approved_inputs'].items():
            self.assertEqual(Path(descriptor['path']).read_bytes(), self.originals[key])
            self.assertEqual(base64.b64decode(capsule['env'][key]), self.projected[key])
        self.assertNotIn(self.secret, json.dumps(result))
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o600)

    def test_unapproved_projected_change_refuses_before_output(self):
        key = 'BACKEND_ENV_B64'
        self.request['projected_inputs'][key] = self.write('bad-projection', self.projected[key].replace(self.secret.encode(), b'other-secret'))
        with self.assertRaises(MODULE['CapsuleError']):
            self.build()
        self.assertFalse(self.output.exists())

    def test_backend_must_already_match_production_before_projection(self):
        key = 'BACKEND_ENV_B64'
        original = self.originals[key].replace(b'BROWSER_PROVIDER=kernel', b'BROWSER_PROVIDER=steel')
        self.request['approved_inputs'][key] = self.write('mismatched-backend', original)
        with self.assertRaises(MODULE['CapsuleError']):
            self.build()
        self.assertFalse(self.output.exists())

    def test_quoted_worker_uses_exact_canonical_unquoted_projection(self):
        key = 'AGENTS_ENV_B64'
        original = self.originals[key].replace(b'BROWSER_PROVIDER=steel', b'  export BROWSER_PROVIDER = "steel"   ')
        projected = self.projected[key].replace(b'BROWSER_PROVIDER=kernel', b'  export BROWSER_PROVIDER =kernel')
        self.request['approved_inputs'][key] = self.write('quoted-worker', original)
        self.request['projected_inputs'][key] = self.write('quoted-projected-worker', projected)
        self.build()
        capsule = MODULE['parse'](self.output.read_bytes())
        self.assertEqual(base64.b64decode(capsule['env'][key]), projected)

    def test_unknown_original_worker_provider_is_not_silently_repaired(self):
        key = 'AGENTS_ENV_B64'
        original = self.originals[key].replace(b'BROWSER_PROVIDER=steel', b'BROWSER_PROVIDER=unknown')
        self.request['approved_inputs'][key] = self.write('unknown-worker', original)
        with self.assertRaises(MODULE['CapsuleError']):
            self.build()
        self.assertFalse(self.output.exists())

    def test_public_metadata_hashes_the_temporal_namespace(self):
        result = self.build()
        self.assertNotIn('bench-private', json.dumps(result))
        self.assertEqual(result['temporal']['namespace_sha256'], MODULE['sha'](b'bench-private'))

    def test_existing_null_fixed_provenance_never_becomes_ambient(self):
        with patch.dict(MODULE['guest_manifest'].__globals__, PROVENANCE_PATHS=('/fixed-provenance.json',),
                        read_regular=lambda *args, **kwargs: b'null'), patch.object(os.path, 'lexists', return_value=True):
            with self.assertRaises(MODULE['CapsuleError']):
                MODULE['guest_manifest']({})

    def test_changed_approved_input_digest_refuses(self):
        Path(self.request['approved_inputs']['AGENTS_ENV_B64']['path']).write_bytes(b'changed')
        with self.assertRaises(MODULE['CapsuleError']):
            self.build()
        self.assertFalse(self.output.exists())

    def test_stale_or_invalid_provider_proof_refuses(self):
        proof = MODULE['parse'](Path(self.request['provider_proof']['path']).read_bytes())
        for field, value in (('backend', 'invented'), ('observed_epoch', 1), ('observed_epoch', int(time.time()) + 9999)):
            with self.subTest(field=field):
                self.request['provider_proof'] = self.write('provider-proof', MODULE['canonical'](dict(proof, **{field: value})))
                with self.assertRaises(MODULE['CapsuleError']):
                    self.build()
                self.assertFalse(self.output.exists())

    def test_production_evidence_bytes_and_temporal_projection_are_pinned(self):
        proof_path = Path(self.request['provider_proof']['path'])
        proof = MODULE['parse'](proof_path.read_bytes())
        Path(proof['evidence']['backend']['path']).write_bytes(b'changed proof')
        with self.assertRaises(MODULE['CapsuleError']):
            self.build()
        self.assertFalse(self.output.exists())
        # A private override with an additional non-Temporal key is rejected by
        # the existing canonical transformer, without emitting its contents.
        proof['evidence']['backend'] = self.write('render-proof', b'fixture authenticated Render observation')
        self.request['provider_proof'] = self.write('provider-proof', MODULE['canonical'](proof))
        raw = Path(self.request['temporal_override']['path']).read_bytes() + b'SECRET=unapproved\n'
        self.request['temporal_override'] = self.write('temporal', raw)
        with self.assertRaises(MODULE['CapsuleError']):
            self.build()
        self.assertFalse(self.output.exists())

    def test_no_existing_output_is_overwritten(self):
        self.output.write_bytes(b'original')
        with self.assertRaises(FileExistsError):
            self.build()
        self.assertEqual(self.output.read_bytes(), b'original')

    def test_capsule_tamper_unknown_fields_and_source_bindings_refuse(self):
        capsule = self.capsule()
        raw = self.output.read_bytes()
        manifest = self.manifest(raw)
        mutations = [dict(capsule, unexpected=True), dict(capsule, schema='unknown'),
                     dict(capsule, providers=dict(backend='steel', worker='kernel')),
                     dict(capsule, temporal=dict(capsule['temporal'], namespace='wrong'))]
        for key in self.binding:
            mutations.append(dict(capsule, binding=dict(self.binding, **{key: '0' * len(self.binding[key])})))
        for value in mutations:
            with self.subTest(value=list(value)):
                changed = MODULE['canonical'](value)
                sealed = dict(manifest, guest_env_capsule_sha256=MODULE['sha'](changed))
                with self.assertRaises((MODULE['CapsuleError'], ValueError)):
                    MODULE['validate_capsule'](changed, sealed, self.binding['source_ref'])

    def test_manifest_mode_hash_contract_downgrade_refuses(self):
        self.build()
        raw = self.output.read_bytes()
        manifest = self.manifest(raw)
        for key in ('guest_env_mode', 'guest_env_capsule_sha256', 'guest_env_sha256', 'creation_nonce'):
            changed = dict(manifest)
            changed.pop(key)
            with self.subTest(key=key), self.assertRaises((MODULE['CapsuleError'], KeyError)):
                MODULE['validate_capsule'](raw, changed, self.binding['source_ref'])

    def test_symlink_and_directory_input_refuse(self):
        regular = self.root / 'regular'
        regular.write_text('private')
        link = self.root / 'link'
        link.symlink_to(regular)
        for path in (link, self.root):
            with self.subTest(path=str(path)), self.assertRaises((OSError, MODULE['CapsuleError'])):
                MODULE['read_regular'](str(path))

    def test_ambient_mode_and_check_effective_leave_existing_guard_in_charge(self):
        for markers in ({}, dict(CLOUDBENCH_SOURCE_GUEST_ENV_MODE='none', CLOUDBENCH_SOURCE_GUEST_ENV_CAPSULE_SHA256='none')):
            with patch.dict(MODULE['guest_manifest'].__globals__, PROVENANCE_PATHS=()):
                self.assertIsNone(MODULE['guest_manifest'](markers))
                self.assertEqual(MODULE['enter'](['/bin/true'], markers), 0)
                self.assertIsNone(MODULE['check_effective'](markers))
                path = self.root / 'ambient.json'
                path.write_bytes(b'{"version":2,"guest_env_sha256":{}}')
                env = dict(markers, CLOUDBENCH_SOURCE_MANIFEST_FILE=str(path),
                           CLOUDBENCH_SOURCE_MANIFEST_SHA256=MODULE['sha'](path.read_bytes()))
                self.assertIsNone(MODULE['guest_manifest'](env))

    def test_owned_manifest_cannot_hide_behind_cleared_mode_markers(self):
        capsule = self.capsule()
        path = self.root / 'owned-manifest.json'
        path.write_bytes(MODULE['canonical'](self.manifest(MODULE['canonical'](capsule))))
        env = dict(CLOUDBENCH_SOURCE_MANIFEST_FILE=str(path),
                   CLOUDBENCH_SOURCE_MANIFEST_SHA256=MODULE['sha'](path.read_bytes()))
        with patch.dict(MODULE['guest_manifest'].__globals__, PROVENANCE_PATHS=()):
            with self.assertRaises(MODULE['CapsuleError']):
                MODULE['enter'](['/bin/true'], env)

    def guest_child(self, *, bad=None, variant='one'):
        """Real root process/FD checks on isolated paths, never production /data."""
        self.build()
        raw = self.output.read_bytes()
        private_root = self.root / 'private'
        private_root.mkdir(mode=0o700, exist_ok=True)
        capsule_root = private_root / 'env'
        capsule_root.mkdir(mode=0o700, exist_ok=True)
        capsule_path = capsule_root / (MODULE['sha'](raw) + '.json')
        capsule_path.write_bytes(raw)
        capsule_path.chmod(0o600)
        manifest = self.manifest(raw)
        manifest_path = self.root / 'manifest.json'
        manifest_path.write_bytes(MODULE['canonical'](manifest))
        provenance_path = self.root / 'provenance.json'
        provenance = dict(base_sha=self.binding['source_ref'], config=dict(values=dict(
            base_source_manifest_sha256=MODULE['sha'](manifest_path.read_bytes()), base_source_lease_protocol='cloudbench-source-lease-v1',
            base_source_guest_env_mode=MODULE['MODE'], base_source_guest_env_capsule_sha256=MODULE['sha'](raw))))
        if bad == 'provenance':
            provenance['config']['values']['base_source_manifest_sha256'] = '0' * 64
        if bad == 'source':
            manifest['guest_env_capsule_binding']['source_ref'] = '0' * 40
            manifest_path.write_bytes(MODULE['canonical'](manifest))
            provenance['config']['values']['base_source_manifest_sha256'] = MODULE['sha'](manifest_path.read_bytes())
        if variant == 'unpublished':
            provenance['base_sha'] = '131f588d495c51c041d2828bc652ad3edd4db3ae'
            provenance['workspace_patch_sha256'] = 'ba35e2b958341ce4049d2d12b1228248d973507b3cd33d4b76d3e30de6be4d46'
        provenance_path.write_bytes(MODULE['canonical'](provenance))
        peer = self.root / 'previous-primary-provenance.json'
        if variant == 'selected-peer':
            peer.write_bytes(b'{"base_sha":"stale","config":{"values":{"base_source_guest_env_mode":"owned-capsule-v1"}}}')
        if bad == 'capsule':
            capsule_path.write_bytes(raw + b' ')
        if bad == 'mode':
            capsule_path.chmod(0o644)
        if bad == 'parent-mode':
            capsule_root.chmod(0o755)
        if bad == 'symlink':
            target = self.root / 'aliased-capsule'
            target.write_bytes(raw)
            target.chmod(0o600)
            capsule_path.unlink()
            capsule_path.symlink_to(target)
        if bad == 'cleared-markers':
            pass
        config = self.root / 'guest-test.json'
        config.write_text(json.dumps(dict(capsule=str(capsule_path), manifest=str(manifest_path), provenance=str(provenance_path),
                                          secret=self.secret, sha=MODULE['sha'](manifest_path.read_bytes()),
                                          capsule_sha=MODULE['sha'](raw), variant=variant, bad=bad, peer=str(peer))))
        launcher = self.root / 'guest-test.py'
        launcher.write_text('''import json,os,runpy,sys
from pathlib import Path
c=json.loads(Path(sys.argv[2]).read_text())
m=runpy.run_path(sys.argv[1]);g=m['load_guest'].__globals__
g['CAPSULE_ROOT']=str(Path(c['capsule']).parent);g['PROVENANCE_PATHS']=(c['provenance'],c['peer'])
# Permit temporary controller manifest location only inside this test process.
original=g['read_regular']
def read(path,**kwargs):
 if path=='/cloudbench-source-manifest.json':path=c['manifest']
 return original(path,**kwargs)
g['read_regular']=read
os.environ.update(CLOUDBENCH_SOURCE_MANIFEST_FILE='/cloudbench-source-manifest.json',
 CLOUDBENCH_SOURCE_MANIFEST_SHA256=c['sha'],CLOUDBENCH_SOURCE_LEASE_PROTOCOL='cloudbench-source-lease-v1',
 CLOUDBENCH_SOURCE_GUEST_ENV_MODE='owned-capsule-v1',CLOUDBENCH_SOURCE_GUEST_ENV_CAPSULE_SHA256=c['capsule_sha'],
 CLOUDBENCH_EXECUTION_PROVENANCE_FILE=c['provenance'],
 AGENTS_ENV_B64='rotated-global',BACKEND_ENV_B64='rotated-global',AGENTS_ENV_SHA256='rotated',
 BACKEND_ENV_SHA256='rotated',CLOUDBENCH_BROWSER_PROVIDER='steel',CLOUDBENCH_WORKER_BROWSER_PROVIDER='steel',
 TEMPORAL_ADDRESS='ambient.example:7233',TEMPORAL_NAMESPACE='ambient-namespace',TEMPORAL_API_KEY='ambient-key',BROWSER_PROVIDER='steel')
if c['bad']=='cleared-markers':
 for k in ('CLOUDBENCH_SOURCE_MANIFEST_FILE','CLOUDBENCH_SOURCE_MANIFEST_SHA256','CLOUDBENCH_SOURCE_LEASE_PROTOCOL','CLOUDBENCH_SOURCE_GUEST_ENV_MODE','CLOUDBENCH_SOURCE_GUEST_ENV_CAPSULE_SHA256'):os.environ.pop(k,None)
if c['bad']=='ambiguous-peer':os.environ.pop('CLOUDBENCH_EXECUTION_PROVENANCE_FILE',None)
if c['bad']=='missing-selected':os.environ['CLOUDBENCH_EXECUTION_PROVENANCE_FILE']=c['peer']
try:
 capsule,meta=m['load_guest']()
 assert m['enter'](['/bin/bash','runner'],os.environ)==42
 expected=m['effective_env'](capsule,os.environ)
 assert m['enter'](['/bin/bash','runner'],expected)==0
 wrong=dict(expected,AGENTS_ENV_B64='coherently-rotated',AGENTS_ENV_SHA256='coherently-rotated')
 try:m['check_effective'](wrong)
 except Exception:pass
 else:raise AssertionError('marker bypassed effective check')
 # dotenv loads without override: an inherited Temporal/browser scalar would beat the validated file value.
 for k in ('TEMPORAL_ADDRESS','TEMPORAL_NAMESPACE','TEMPORAL_API_KEY','BROWSER_PROVIDER'):
  try:m['check_effective'](dict(expected,**{k:'ambient'}))
  except Exception:pass
  else:raise AssertionError('ambient file-owned scalar bypassed effective check')
 command=[sys.executable,'-c',"import os,base64; assert b'BROWSER_PROVIDER=kernel' in base64.b64decode(os.environ['AGENTS_ENV_B64']); assert os.environ['CLOUDBENCH_BROWSER_PROVIDER']=='kernel'; assert not {'TEMPORAL_ADDRESS','TEMPORAL_NAMESPACE','TEMPORAL_API_KEY','BROWSER_PROVIDER'} & set(os.environ); print('EXEC_OK')"]
 m['exec_guest'](command)
except Exception:
 print('REFUSED',file=sys.stderr);sys.exit(1)
''')
        command = ['sudo', '-n', sys.executable, str(launcher), str(HELPER), str(config)]
        # Root ownership matches the production contract. The test directory is
        # reclaimed by this test's cleanup after resetting its ownership.
        subprocess.run(['sudo', '-n', 'chown', '-R', '0:0', str(self.root)], check=True, capture_output=True)
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=10)
        finally:
            subprocess.run(['sudo', '-n', 'chown', '-R', str(os.getuid()) + ':' + str(os.getgid()), str(self.root)], check=True, capture_output=True)
        self.assertNotIn(self.secret, result.stdout + result.stderr + repr(command))
        return result

    def test_actual_exec_ignores_rotated_globals(self):
        result = self.guest_child()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'EXEC_OK\n')

    def test_attested_source_can_differ_from_consumer_unpublished_fetch_base(self):
        result = self.guest_child(variant='unpublished')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_declared_fixed_provenance_wins_over_stale_primary_peer(self):
        result = self.guest_child(variant='selected-peer')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_missing_selected_or_ambiguous_fixed_provenance_refuses(self):
        result = self.guest_child(bad='missing-selected')
        self.assertNotEqual(result.returncode, 0)
        self.output.unlink()
        result = self.guest_child(variant='selected-peer', bad='ambiguous-peer')
        self.assertNotEqual(result.returncode, 0)

    def test_actual_guest_tamper_provenance_source_and_mode_refuse(self):
        for bad in ('capsule', 'provenance', 'source', 'mode', 'parent-mode', 'symlink', 'cleared-markers'):
            with self.subTest(bad=bad):
                self.output.unlink(missing_ok=True)
                result = self.guest_child(bad=bad)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('EXEC_OK', result.stdout)

    def test_two_concurrent_capsules_keep_distinct_approved_bytes(self):
        def run(number):
            test = CapsuleTest()
            test.setUp()
            try:
                test.secret += str(number)
                test.binding['owner_token'] = str(number + 3) * 32
                for key in MODULE['ENV_KEYS']:
                    test.originals[key] = test.originals[key].replace(b'fixture-SECRET-canary-28fd', test.secret.encode())
                    test.projected[key] = test.projected[key].replace(b'fixture-SECRET-canary-28fd', test.secret.encode())
                    test.request['approved_inputs'][key] = test.write(key + '.approved', test.originals[key])
                    test.request['projected_inputs'][key] = test.write(key + '.projected', test.projected[key])
                result = test.guest_child(variant=str(number))
                capsule = MODULE['parse'](test.output.read_bytes())
                return result.returncode, capsule['binding']['owner_token'], capsule['env']
            finally:
                test.doCleanups()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(run, range(2)))
        self.assertEqual([item[0] for item in results], [0, 0])
        self.assertNotEqual(results[0][1], results[1][1])
        self.assertNotEqual(results[0][2], results[1][2])

    def test_cli_diagnostics_do_not_disclose_private_values(self):
        raw = MODULE['canonical'](self.request)
        self.write('request.json', raw)
        command = [sys.executable, str(HELPER), 'build', '--request', str(self.request_path),
                   '--request-sha256', MODULE['sha'](raw), '--output', str(self.output)]
        result = subprocess.run(command, capture_output=True, text=True, timeout=25)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(self.secret, result.stdout + result.stderr + repr(command))
        self.output.unlink()
        self.request['projected_inputs']['AGENTS_ENV_B64']['sha256'] = '0' * 64
        raw = MODULE['canonical'](self.request)
        self.write('request.json', raw)
        command[command.index('--request-sha256') + 1] = MODULE['sha'](raw)
        result = subprocess.run(command, capture_output=True, text=True, timeout=25)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr, 'owned source environment refused\n')
        self.assertNotIn(self.secret, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
