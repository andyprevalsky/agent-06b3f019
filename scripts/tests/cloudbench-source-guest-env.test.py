#!/usr/bin/env python3
"""Exercise the actual guest decode boundaries without provider or secret access."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import runpy
import shutil
import sys
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


class OwnedCapsuleGuest(unittest.TestCase):
    """Actual loader exec and all three unmodified decode boundaries on mapped private paths."""
    def setUp(self):
        fixture=runpy.run_path(str(SCRIPTS/'tests/cloudbench-source-env.test.py'))['CapsuleTest']()
        fixture.setUp();self.addCleanup(fixture.doCleanups)
        self.fixture=fixture;self.root=fixture.root
        self.addCleanup(lambda:subprocess.run(['sudo','-n','chown','-R',str(os.geteuid()),str(self.root)],capture_output=True))
        self.capsule=fixture.capsule()
        module=runpy.run_path(str(SCRIPTS/'cloudbench-source-env.py'));self.module=module
        raw=fixture.output.read_bytes();self.capsule_sha=module['sha'](raw)
        self.manifest=fixture.manifest(raw)
        self.manifest['guest_env_capsule_binding']=fixture.binding
        self.manifest_file=self.root/'captured-source.json';self.provenance_file=self.root/'provenance.json'
        self.private=self.root/'private';self.private.mkdir(mode=0o700)
        self.store=self.private/'env';self.store.mkdir(mode=0o700)
        self.capsule_file=self.store/(self.capsule_sha+'.json');self.capsule_file.write_bytes(raw);self.capsule_file.chmod(0o600)
        self.manifest_file.write_bytes(module['canonical'](self.manifest))
        self.manifest_sha=module['sha'](self.manifest_file.read_bytes())
        self.provenance=dict(config=dict(values=dict(base_source_manifest_sha256=self.manifest_sha,
            base_source_lease_protocol=PROTOCOL,base_source_guest_env_mode='owned-capsule-v1',
            base_source_guest_env_capsule_sha256=self.capsule_sha)))
        self.provenance_file.write_bytes(module['canonical'](self.provenance))
        self.loader=self.root/'cloudbench-source-env.py'
        loader=(SCRIPTS/'cloudbench-source-env.py').read_text()
        loader=loader.replace('/data/.cloudbench-private/env',str(self.store))
        loader=loader.replace('/cloudbench-execution-provenance.json',str(self.provenance_file))
        loader=loader.replace('/data/cloudbench-execution-provenance.json',str(self.root/'unused-provenance'))
        loader=loader.replace('/cloudbench-source-manifest.json',str(self.manifest_file))
        loader=loader.replace('/data/cloudbench-source-manifest.json',str(self.root/'unused-manifest'))
        self.loader.write_text(loader)
        self.envhelper=self.root/'cloudbench-env.sh'
        lib=(SCRIPTS/'lib/cloudbench-env.sh').read_text().replace('/cloudbench-execution-provenance.json',str(self.provenance_file)).replace('/data/cloudbench-execution-provenance.json',str(self.root/'unused-provenance'))
        self.envhelper.write_text(lib)
        self.env={k:v for k,v in os.environ.items() if not k.startswith(('CLOUDBENCH_','AGENTS_ENV_','BACKEND_ENV_','FLY_MACHINE_'))}
        self.env.update(CLOUDBENCH_SOURCE_ENV_HELPER=str(self.loader),ENV_HELPER=str(self.envhelper),
            CLOUDBENCH_SOURCE_MANIFEST_FILE=str(self.manifest_file),CLOUDBENCH_SOURCE_MANIFEST_SHA256=self.manifest_sha,
            CLOUDBENCH_SOURCE_LEASE_PROTOCOL=PROTOCOL,CLOUDBENCH_SOURCE_GUEST_ENV_MODE='owned-capsule-v1',
            CLOUDBENCH_SOURCE_GUEST_ENV_CAPSULE_SHA256=self.capsule_sha,CLOUDBENCH_EXECUTION_PROVENANCE_FILE=str(self.provenance_file),
            CLOUDBENCH_DATA_DIR=str(self.root),FLY_MACHINE_ID='0123456789abcd',CLOUDBENCH_RUN_TOKEN='owned-fixture',
            REPO_DIR=str(self.root),APP_DIR=str(self.root),APP_USER='root',AGENTS_ENV_B64='rotated-global',BACKEND_ENV_B64='rotated-global',
            AGENTS_ENV_SHA256='rotated',BACKEND_ENV_SHA256='rotated',CLOUDBENCH_BROWSER_PROVIDER='steel',CLOUDBENCH_WORKER_BROWSER_PROVIDER='steel')
        for name in ('agents','back-end'):(self.root/name).mkdir()

    def run_child(self,script,exit_code=0,transport=None):
        subprocess.run(['sudo','-n','chown','-R',str(os.geteuid()),str(self.root)],check=True,capture_output=True)
        source=(SCRIPTS/script).read_text()
        start=source.index('_source_env_dir=');end=source.index('\nesac',start)+len('\nesac')
        decode_start=source.index('source "$ENV_HELPER"')
        first=source.index('cloudbench_verify_env_file ',decode_start);second=source.index('cloudbench_verify_env_file ',first+1)
        decode_end=source.index('\n',second)
        runner=self.root/'runner.sh'
        runner.write_text('set -uo pipefail\n'+source[start:end]+'\nlog() { :; }; finish() { exit "$1"; }; chown() { :; };\n'
            +source[decode_start:decode_end]+'\nprintf "one\\n" >> "$CLOUDBENCH_DATA_DIR/executions"\nprintf "OWNED_OK\\n"\nexit '+str(exit_code)+'\n')
        config=self.root/'child-env.json';config.write_text(json.dumps(self.env));config.chmod(0o600)
        if transport in ('ssh','worker','reused-worker'):
            host=(SCRIPTS/('run-bench-cloud' if transport=='ssh' else 'run-bench-fleet')).read_text()
            lines=[line for line in host.splitlines() if 'echo "export CLOUDBENCH_SOURCE_' in line]
            render_env=dict(self.env,PRIVATE_SOURCE_FILE=str(self.manifest_file),PRIVATE_SOURCE_SHA256=self.manifest_sha,
                PRIVATE_SOURCE_LEASE_PROTOCOL=PROTOCOL,PRIVATE_SOURCE_GUEST_ENV_MODE='owned-capsule-v1',
                PRIVATE_SOURCE_GUEST_ENV_CAPSULE_SHA256=self.capsule_sha)
            rendered=subprocess.run(['bash','-c','\n'.join(lines)],env=render_env,capture_output=True,text=True,timeout=5)
            self.assertEqual(rendered.returncode,0,rendered.stderr)
            exports=rendered.stdout.replace('/data/cloudbench-source-env.py',str(self.loader)).replace('/data/cloudbench-source-manifest.json',str(self.manifest_file))
            runner.write_text(exports+'\n'+runner.read_text())
            untrusted=dict(self.env,CLOUDBENCH_SOURCE_ENV_HELPER='/missing-global-loader',
                CLOUDBENCH_SOURCE_MANIFEST_FILE='',CLOUDBENCH_SOURCE_MANIFEST_SHA256='',
                CLOUDBENCH_SOURCE_LEASE_PROTOCOL='',CLOUDBENCH_SOURCE_GUEST_ENV_MODE='',
                CLOUDBENCH_SOURCE_GUEST_ENV_CAPSULE_SHA256='')
            config.write_text(json.dumps(untrusted))
        elif transport in ('boot','staged'):
            import re
            host=(SCRIPTS/'run-bench-cloud').read_text()
            lines=[line for line in host.splitlines() if line.startswith('        --env ') and
                   any(key in line for key in ('CLOUDBENCH_SOURCE_ENV_HELPER=','CLOUDBENCH_SOURCE_GUEST_ENV_MODE=',
                                               'CLOUDBENCH_SOURCE_GUEST_ENV_CAPSULE_SHA256='))]
            block=re.search(r'^    if \[ "\$\{CLOUDBENCH_SOURCE_LEASE_PROTOCOL:-none\}" = cloudbench-source-lease-v1 \]; then.*?^    fi',host,re.M|re.S).group()
            code='_envargs=(\n'+'\n'.join(lines)+'\n); _boot_file_args=()\n'+block+'\nprintf "%s\\n" "${_envargs[@]}"'
            rendered=subprocess.run(['bash','-c',code],env=self.env,capture_output=True,text=True,timeout=5)
            self.assertEqual(rendered.returncode,0,rendered.stderr)
            argv=rendered.stdout.splitlines();projected=dict(self.env)
            self.assertEqual(len(argv)%2,0)
            for key,value in zip(argv[::2],argv[1::2]):
                self.assertEqual(key,'--env');name,payload=value.split('=',1)
                projected[name]=payload.replace('/cloudbench-source-env.py',str(self.loader)).replace('/cloudbench-source-manifest.json',str(self.manifest_file))
            config.write_text(json.dumps(projected))
        launcher=self.root/'launch.py';launcher.write_text('import os,json,sys\nfrom pathlib import Path\ne=json.loads(Path(sys.argv[1]).read_text());os.execve("/bin/bash",["/bin/bash",sys.argv[2]],e)\n')
        subprocess.run(['sudo','-n','chown','-R','0:0',str(self.root)],check=True,capture_output=True)
        result=subprocess.run(['sudo','-n',sys.executable,str(launcher),str(config),str(runner)],capture_output=True,text=True,timeout=10)
        subprocess.run(['sudo','-n','chown','-R',str(os.geteuid()),str(self.root)],check=True,capture_output=True)
        return result

    def test_capsule_overrides_coherent_global_rotation_at_all_three_decode_sites(self):
        for script in ('cloudbench-run.sh','cloudbench-worker.sh','cloudbench-entrypoint.sh'):
            with self.subTest(script=script):
                result=self.run_child(script);self.assertEqual(result.returncode,0,result.stderr)
                self.assertTrue(result.stdout.endswith('OWNED_OK\n'))
                self.assertEqual(result.stdout.count('OWNED_OK'),1)
                self.assertNotIn(self.fixture.secret,result.stdout+result.stderr)
                self.assertNotIn(self.fixture.secret,' '.join(result.args))
                for encoded in self.capsule['env'].values():
                    self.assertNotIn(encoded,result.stdout+result.stderr+' '.join(result.args))
                self.assertEqual((self.root/'agents/.env').read_bytes(),self.fixture.projected['AGENTS_ENV_B64'])
                self.assertEqual((self.root/'back-end/.env').read_bytes(),self.fixture.projected['BACKEND_ENV_B64'])
        self.assertEqual((self.root/'executions').read_text(),'one\none\none\n')

    def test_mode_hash_source_nonce_provider_temporal_and_file_tamper_refuse_before_decode(self):
        original=self.capsule_file.read_bytes()
        for mutation in ('mode','hash','source','nonce','provider','temporal','file'):
            env=dict(self.env);capsule=json.loads(original)
            if mutation=='mode':self.env['CLOUDBENCH_SOURCE_GUEST_ENV_MODE']='none'
            elif mutation=='hash':self.env['CLOUDBENCH_SOURCE_GUEST_ENV_CAPSULE_SHA256']='0'*64
            elif mutation=='source':capsule['binding']['source_ref']='0'*40
            elif mutation=='nonce':capsule['binding']['create_nonce']='0'*32
            elif mutation=='provider':capsule['providers']['backend']='steel'
            elif mutation=='temporal':capsule['temporal']['namespace']='wrong'
            elif mutation=='file':self.capsule_file.chmod(0o644)
            if mutation not in ('mode','hash','file'):self.capsule_file.write_bytes(self.module['canonical'](capsule))
            result=self.run_child('cloudbench-run.sh');self.assertNotEqual(result.returncode,0,mutation)
            self.assertFalse((self.root/'agents/.env').exists(),mutation)
            self.assertFalse((self.root/'executions').exists(),mutation)
            self.assertNotIn(self.fixture.secret,result.stdout+result.stderr)
            self.env=env
            subprocess.run(['sudo','-n','chown','-R',str(os.geteuid()),str(self.root)],check=True,capture_output=True)
            self.capsule_file.write_bytes(original);self.capsule_file.chmod(0o600)

    def test_cleared_markers_cannot_downgrade_fixed_owned_provenance(self):
        for key in ('CLOUDBENCH_SOURCE_GUEST_ENV_MODE','CLOUDBENCH_SOURCE_GUEST_ENV_CAPSULE_SHA256',
                    'CLOUDBENCH_SOURCE_MANIFEST_FILE','CLOUDBENCH_SOURCE_MANIFEST_SHA256','CLOUDBENCH_SOURCE_LEASE_PROTOCOL'):
            self.env[key]=''
        result=self.run_child('cloudbench-worker.sh')
        self.assertNotEqual(result.returncode,0)
        self.assertFalse((self.root/'agents/.env').exists())

    def test_spoofed_loader_marker_cannot_skip_effective_value_check(self):
        self.env['CLOUDBENCH_SOURCE_ENV_EXECUTED']='owned-capsule-v1'
        result=self.run_child('cloudbench-entrypoint.sh')
        self.assertNotEqual(result.returncode,0)
        self.assertFalse((self.root/'agents/.env').exists())

    def test_exec_preserves_runner_exit_status_and_runs_exactly_once(self):
        result=self.run_child('cloudbench-run.sh',37)
        self.assertEqual(result.returncode,37,result.stderr)
        self.assertEqual((self.root/'executions').read_text(),'one\n')

    def test_actual_ssh_worker_and_reused_worker_literal_wrappers_defeat_ambient_markers(self):
        for transport in ('ssh','worker','reused-worker'):
            script='cloudbench-run.sh' if transport=='ssh' else 'cloudbench-worker.sh'
            result=self.run_child(script,transport=transport)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual((self.root/'agents/.env').read_bytes(),self.fixture.projected['AGENTS_ENV_B64'])
        self.assertEqual((self.root/'executions').read_text(),'one\none\none\n')

    def test_actual_boot_and_staged_environment_args_load_before_decode(self):
        for transport in ('boot','staged'):
            result=self.run_child('cloudbench-run.sh',transport=transport)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual((self.root/'agents/.env').read_bytes(),self.fixture.projected['AGENTS_ENV_B64'])
        self.assertEqual((self.root/'executions').read_text(),'one\none\n')

    def test_reused_guest_uses_literal_selected_provenance_with_other_fixed_file_present(self):
        (self.root/'unused-provenance').write_text(json.dumps({'config':{'values':{'base_source_guest_env_mode':'none'}}}))
        result=self.run_child('cloudbench-worker.sh',transport='reused-worker')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual((self.root/'executions').read_text(),'one\n')

    def test_empty_storage_refuses_then_native_snapshot_restore_supplies_primary_and_worker_capsule(self):
        storage=runpy.run_path(str(SCRIPTS/'tests/cloudbench-source-lease-fleet.test.py'))['OwnedCapsuleStorage']()
        # The loopback provider models immutable snapshot inheritance only when
        # the actual Volume POST names the captured source snapshot. No guest
        # stage or controller secret wire fills the initially empty target.
        snapshot_bytes=self.capsule_file.read_bytes()
        self.capsule_file.unlink()
        for storage_mode,snapshot in (('fresh','vs_owned'),('snapshot','')):
            result,requests=storage.volume_boundary('owned-capsule-v1',storage_mode,snapshot)
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(requests,[])
            self.assertFalse(self.capsule_file.exists())
        for role,script,transport in (('primary','cloudbench-run.sh','boot'),('worker','cloudbench-worker.sh','worker')):
            if self.capsule_file.exists():self.capsule_file.unlink()
            for path in (self.root/'agents/.env',self.root/'back-end/.env'):
                if path.exists():path.unlink()
            missing=self.run_child(script,transport=transport)
            self.assertNotEqual(missing.returncode,0)
            self.assertFalse((self.root/'agents/.env').exists())
            self.assertFalse((self.root/'back-end/.env').exists())
            mode=(storage.primary('owned-capsule-v1') if role=='primary' else storage.worker('owned-capsule-v1'))
            self.assertEqual(mode.returncode,0,mode.stderr)
            def restore(body):
                self.assertEqual(body['snapshot_id'],'vs_owned')
                self.assertIs(body['encrypted'],True)
                self.capsule_file.write_bytes(snapshot_bytes);self.capsule_file.chmod(0o600)
            created,requests=storage.volume_boundary('owned-capsule-v1',mode.stdout,'vs_owned',observe=restore)
            self.assertEqual(created.returncode,0,created.stderr)
            self.assertEqual(len(requests),1)
            self.assertNotIn(self.fixture.secret,json.dumps(requests))
            for value in self.capsule['env'].values():self.assertNotIn(value,json.dumps(requests))
            loaded=self.run_child(script,transport=transport)
            self.assertEqual(loaded.returncode,0,loaded.stderr)
            self.assertEqual((self.root/'agents/.env').read_bytes(),self.fixture.projected['AGENTS_ENV_B64'])
            self.assertEqual((self.root/'back-end/.env').read_bytes(),self.fixture.projected['BACKEND_ENV_B64'])
            self.assertNotIn(self.fixture.secret,loaded.stdout+loaded.stderr+' '.join(loaded.args))
        self.assertEqual((self.root/'executions').read_text(),'one\none\n')


if __name__ == '__main__':
    unittest.main()
