#!/usr/bin/env python3
"""Real holder/check/close processes and creator retirement at native HTTP boundary."""
from datetime import datetime, timezone
import ast
import hashlib
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import time
import tempfile
import threading
from unittest.mock import patch
import unittest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE / 'lib'))
from condition_wait import WaitTimeout, wait_until
FIXTURE = runpy.run_path(str(HERE / 'tests/cloudbench-prepare-source-create.test.py'))
HELPER = HERE / 'cloudbench-source-lease.py'
OWNER = 'c' * 32
RUN = 'lease-test'


class SourceLease(unittest.TestCase):
    def setUp(self):
        self.b = FIXTURE['Boundary']('runTest')
        self.b.setUp()
        self.addCleanup(self.b.tearDown)
        result = self.b.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.root = self.b.root
        created = json.loads(result.stdout)
        self.mid = created['machine_id']
        self.b.machines[self.mid]['state'] = 'stopped'
        now = int(time.time())
        self.b.own_snapshots = [dict(id='vs_owned', status='created', size=100, digest='f'*64,
                                    created_at=datetime.now(timezone.utc).isoformat())]
        self.manifest = dict(version=2, app=FIXTURE['APP'], owner_token=FIXTURE['OWNER'], machine_id=self.mid,
            instance_id=created['instance_id'], machine_name=created['machine_name'], volume_id=created['volume_id'],
            region='iad', image_digest='sha256:'+'e'*64, snapshot_id='vs_owned', node_fingerprint='a'*64,
            python_fingerprint='b'*64, verified_at=now, shared_machine_id=FIXTURE['DONOR'],
            shared_volume_id=FIXTURE['VOL'], lease_protocol='cloudbench-source-lease-v1', creation_nonce=created['nonce'], guest_env_sha256={'AGENTS_ENV_B64':'1'*64,'BACKEND_ENV_B64':'2'*64})
        self.m = runpy.run_path(str(HELPER))
        input_path = self.root/'input.json'
        self.write(input_path, self.manifest)
        self.path = self.root/'captured.json'
        captured = subprocess.run([sys.executable, str(HERE/'cloudbench-source.py'), 'capture', str(input_path),
                                   '--output', str(self.path)], capture_output=True, text=True)
        self.assertEqual(captured.returncode, 0, captured.stderr)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o444)
        self.workspace = self.root/'workspace'
        self.workspace.mkdir(mode=0o700)
        self.common = self.workspace/'.git'; self.common.mkdir(mode=0o700)
        self.runs = self.workspace/'.context/fleet/runs'; self.runs.mkdir(parents=True, mode=0o700)
        self.audit = self.common/'cloudbench-fleet-audits'/OWNER; self.audit.mkdir(parents=True, mode=0o700)
        self.registry = self.common/'cloudbench-fleet-ownership'/OWNER; self.registry.mkdir(parents=True, mode=0o700)
        self.manifest_digest = hashlib.sha256(self.path.read_bytes()).hexdigest()
        (self.audit/'source-manifest.json').write_bytes(self.path.read_bytes())
        (self.registry/'meta').write_text('version=2\nfleet_owner_token='+OWNER+'\nrun_id='+RUN+'\napp='+FIXTURE['APP']+'\npid='+str(os.getpid())+'\npid_start='+self.m['identity'](os.getpid()).replace('linux:', 'proc-start:', 1)+'\nworkspace_root='+str(self.workspace)+'\nruns_root='+str(self.runs)+'\naudit_dir='+str(self.audit)+'\nsource_manifest_sha256='+self.manifest_digest+'\n')
        (self.runs/RUN).mkdir(mode=0o700)
        self.ready, self.journal, self.release = self.root/'ready.json', self.runs/RUN/'source-lease', self.root/'release.json'
        self.processes = []
        self.addCleanup(self.stop_processes)

    def write(self, path, value):
        path.write_text(json.dumps(value, sort_keys=True)+'\n')
        path.chmod(0o600)

    def stop_processes(self):
        for process in self.processes:
            if process.poll() is None: process.terminate()
            process.communicate(timeout=8)

    def command(self, action):
        result = [sys.executable, str(HELPER), action, '--consumer-owner', OWNER, '--run-id', RUN]
        if action == 'check': return result + ['--ready', str(self.ready), '--manifest', str(self.path), '--source-id', self.mid,
                                              '--manifest-sha256', self.manifest_digest, '--parent-pid', str(os.getpid())]
        if action == 'recover-close': return result + ['--journal', str(self.journal)]
        if action == 'close': return result + ['--journal', str(self.journal), '--release-proof', str(self.release)]
        return result + ['--manifest', str(self.path), '--journal', str(self.journal), '--ready', str(self.ready),
                         '--release-proof', str(self.release), '--parent-pid', str(os.getpid()),
                         '--workspace', str(self.workspace)]

    def start(self):
        process = subprocess.Popen(self.command('hold'), env=self.b.env, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True)
        self.processes.append(process)
        try:
            wait_until(lambda: self.ready.exists() or process.poll() is not None, timeout=5,
                       description='source lease publisher READY or exit')
        except WaitTimeout:
            pass  # The assertion below reports the missing READY.
        self.assertTrue(self.ready.exists(), process.communicate(timeout=5) if process.poll() is not None else 'no READY')
        self.assertEqual(self.invoke('check').returncode, 0)
        return process

    def invoke(self, action):
        return subprocess.run(self.command(action), env=self.b.env, capture_output=True, text=True, timeout=8)

    def proof(self, owner=OWNER, run_id=RUN, audit=None, registry=None, release_path=None):
        audit = self.audit if audit is None else audit
        registry = self.registry if registry is None else registry
        release_path = self.release if release_path is None else release_path
        (audit/'by-machine-id').mkdir(mode=0o700)
        (audit/'fresh').mkdir(mode=0o700)
        digest = hashlib.sha256(self.path.read_bytes()).hexdigest()
        (audit/'source-manifest.json').write_bytes(self.path.read_bytes())
        (audit/'meta').write_text('version=1\nfleet_owner_token='+owner+'\nrun_id='+run_id+'\napp='+FIXTURE['APP']+
            '\nworkspace_root='+str(self.workspace)+'\nstatus=provider-teardown-verified\nsource_manifest_sha256='+digest+'\n')
        (audit/'provider-teardown-verified.epoch').write_text(str(int(time.time())))
        sha = self.m['digest_tree'](audit)
        fleet = self.runs/run_id
        fleet.mkdir(exist_ok=True)
        local = fleet/'teardown-ownership'
        shutil.copytree(audit, local)
        (local/'source-audit').write_text('path='+str(audit)+'\nsha256='+sha+'\n')
        (fleet/'_batch').mkdir()
        lifecycle = fleet/'_batch/lifecycle.json'
        self.write(lifecycle, dict(version=1, cleanup_verified=True, fleet_owner_token=owner,
            run_id=run_id, workspace_root=str(self.workspace), audit_sha256=sha))
        lifecycle.chmod(0o644)  # Actual normal fleet lifecycle writer uses the controller umask.
        shutil.rmtree(registry)
        self.write(release_path, dict(audit_dir=str(audit), lifecycle=str(lifecycle)))
        release_path.chmod(0o644)
        return audit, lifecycle

    def test_actual_readonly_capture_hold_check_audit_close_and_retire(self):
        process = self.start()
        meta = self.b.machines[self.mid]['config']['metadata']
        self.assertIn(self.m['CLAIM_PREFIX']+OWNER, meta)
        # Retirement may not delete under an active consumer lease.
        before = len([c for c in self.b.calls if c[0]=='DELETE' and '/lease' not in c[1]])
        result = self.b.run_cli(['cleanup', *self.b.args[1:]])
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len([c for c in self.b.calls if c[0]=='DELETE' and '/lease' not in c[1]]), before)
        self.proof()
        _, stderr = process.communicate(timeout=6)
        self.assertEqual(process.returncode, 0, stderr)
        self.assertNotIn(self.m['CLAIM_PREFIX']+OWNER, meta)
        self.assertNotEqual(self.invoke('check').returncode, 0)
        result = self.b.run_cli(['cleanup', *self.b.args[1:]])
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_dead_or_expired_holder_claim_blocks_retirement(self):
        process = self.start()
        process.terminate(); process.communicate(timeout=5)
        # SIGTERM releases lease but retains the durable source consumer.
        self.assertIsNone(self.b.lease_nonce)
        self.assertNotEqual(self.invoke('check').returncode, 0)
        result = self.b.run_cli(['cleanup', *self.b.args[1:]])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(self.mid, self.b.machines)
        self.assertIn(self.m['CLAIM_PREFIX']+OWNER, self.b.machines[self.mid]['config']['metadata'])
        self.proof()
        self.assertEqual(self.invoke('close').returncode, 0)
        self.assertNotIn(self.m['CLAIM_PREFIX']+OWNER, self.b.machines[self.mid]['config']['metadata'])

    def test_forged_lifecycle_or_wrong_source_audit_cannot_clear_claim(self):
        process = self.start()
        process.terminate(); process.communicate(timeout=5)
        audit, lifecycle = self.proof()
        value = json.loads(lifecycle.read_text()); value['cleanup_verified'] = False
        self.write(lifecycle, value)
        self.assertNotEqual(self.invoke('close').returncode, 0)
        value['cleanup_verified'] = True; self.write(lifecycle, value)
        (audit/'source-manifest.json').write_text('{}')
        self.assertNotEqual(self.invoke('close').returncode, 0)
        self.assertIn(self.m['CLAIM_PREFIX']+OWNER, self.b.machines[self.mid]['config']['metadata'])

    def test_alternate_self_consistent_cleanup_audit_does_not_gain_original_custody(self):
        process = self.start()
        process.terminate(); process.communicate(timeout=5)
        audit, lifecycle = self.proof()
        alternate = self.root/'caller-authored-audit'
        shutil.copytree(audit, alternate)
        value = json.loads(self.release.read_text()); value['audit_dir'] = str(alternate)
        self.write(self.release, value)
        self.assertNotEqual(self.invoke('close').returncode, 0)
        self.assertIn(self.m['CLAIM_PREFIX']+OWNER, self.b.machines[self.mid]['config']['metadata'])

    def test_guard_rejects_wrong_owner_or_expiry_or_holder_identity(self):
        process = self.start()
        ready = json.loads(self.ready.read_text())
        for key, changed in [('consumer_owner', 'd'*32), ('claim_guard_deadline_monotonic', 0), ('holder_birth', 'foreign')]:
            bad = dict(ready); bad[key] = changed; self.write(self.ready, bad)
            self.assertNotEqual(self.invoke('check').returncode, 0)
        self.write(self.ready, ready)
        self.assertEqual(self.invoke('check').returncode, 0)

    def test_canonical_recovery_closes_physical_claim_without_rewriting_failed_lifecycle(self):
        process = self.start()
        process.terminate(); process.communicate(timeout=5)
        audit, lifecycle = self.proof()
        value = json.loads(lifecycle.read_text()); value['cleanup_verified'] = False
        value['status'] = 'failed'; value['audit_sha256'] = ''; self.write(lifecycle, value)
        original = lifecycle.read_bytes()
        self.assertNotEqual(self.invoke('close').returncode, 0)
        result = self.invoke('recover-close')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(lifecycle.read_bytes(), original)
        receipt = json.loads((self.journal/'recovered-physical-closure.json').read_text())
        self.assertEqual(receipt['original_lifecycle_sha256'], hashlib.sha256(original).hexdigest())
        self.assertFalse(receipt['historical_task_credit'])
        self.assertNotIn(self.m['CLAIM_PREFIX']+OWNER, self.b.machines[self.mid]['config']['metadata'])

    def recovery_workspace_command(self):
        return [sys.executable, str(HELPER), 'recover-close', '--workspace', str(self.workspace),
                '--consumer-owner', OWNER]

    def seal_changed_audit(self, lifecycle):
        local = lifecycle.parent.parent/'teardown-ownership'
        shutil.rmtree(local)
        shutil.copytree(self.audit, local)
        sha = self.m['digest_tree'](self.audit)
        (local/'source-audit').write_text('path='+str(self.audit)+'\nsha256='+sha+'\n')

    def add_original_resources(self, mid='55555555555555', vid='vol_original'):
        (self.audit/'by-machine-id'/mid).write_text('cloudbench-original\n')
        (self.audit/'fresh/cloudbench-original').write_text('version=1\nfleet_owner_token='+OWNER+
            '\nrun_id='+RUN+'\napp='+FIXTURE['APP']+'\nclone_name=cloudbench-original\nmachine_id='+mid+
            '\nvolume_id='+vid+'\n')

    def test_workspace_recovery_discovers_custom_original_runs_and_is_idempotent(self):
        custom = self.root/'custom-original-runs'
        (custom/RUN).mkdir(parents=True)
        meta = self.registry/'meta'
        meta.write_text(meta.read_text().replace('runs_root='+str(self.runs), 'runs_root='+str(custom)))
        self.runs = custom
        self.journal = custom/RUN/'source-lease'
        process = self.start()
        process.terminate(); process.communicate(timeout=5)
        audit, lifecycle = self.proof()
        value = json.loads(lifecycle.read_text()); value.update(cleanup_verified=False, status='failed', audit_sha256='')
        self.write(lifecycle, value); original = lifecycle.read_bytes()
        result = subprocess.run(self.recovery_workspace_command(), env=self.b.env, capture_output=True, text=True, timeout=8)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(lifecycle.read_bytes(), original)
        self.assertTrue((self.journal/'recovered-physical-closure.json').exists())
        deletes = len([c for c in self.b.calls if c[0]=='DELETE' and '/metadata/' in c[1]])
        result = subprocess.run(self.recovery_workspace_command(), env=self.b.env, capture_output=True, text=True, timeout=8)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['outcome'], 'source-claim-absent-no-effect')
        self.assertEqual(len([c for c in self.b.calls if c[0]=='DELETE' and '/metadata/' in c[1]]), deletes)
        self.assertFalse(json.loads(result.stdout)['historical_task_credit'])

    def test_recovered_native_machine_or_volume_presence_cannot_close_claim(self):
        process = self.start()
        process.terminate(); process.communicate(timeout=5)
        audit, lifecycle = self.proof()
        value = json.loads(lifecycle.read_text()); value.update(cleanup_verified=False, audit_sha256='')
        self.write(lifecycle, value)
        self.add_original_resources()
        self.seal_changed_audit(lifecycle)
        self.b.machines['55555555555555'] = dict(id='55555555555555', state='stopped', config={'metadata': {}})
        result = subprocess.run(self.recovery_workspace_command(), env=self.b.env, capture_output=True, timeout=8)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(self.m['CLAIM_PREFIX']+OWNER, self.b.machines[self.mid]['config']['metadata'])
        del self.b.machines['55555555555555']
        self.b.volumes['vol_original'] = dict(id='vol_original', state='created', attached_machine_id=None)
        result = subprocess.run(self.recovery_workspace_command(), env=self.b.env, capture_output=True, timeout=8)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.journal/'recovered-physical-closure.json').exists())
        del self.b.volumes['vol_original']
        result = subprocess.run(self.recovery_workspace_command(), env=self.b.env, capture_output=True, timeout=8)
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads((self.journal/'recovered-physical-closure.json').read_text())
        self.assertEqual(receipt['native_observations'], {'machines': {'55555555555555': 'absent'},
                                                        'volumes': {'vol_original': 'absent'}})

    def test_volume_only_clone_closes_only_after_its_volume_is_provider_terminal(self):
        """PR1910 round 25: an ambiguous clone left a Volume but never a Machine (empty machine_id)."""
        process = self.start()
        process.terminate(); process.communicate(timeout=5)
        audit, lifecycle = self.proof()
        value = json.loads(lifecycle.read_text()); value.update(cleanup_verified=False, audit_sha256='')
        self.write(lifecycle, value)
        (self.audit/'fresh/cloudbench-volume-only').write_text('version=1\nfleet_owner_token='+OWNER+
            '\nrun_id='+RUN+'\napp='+FIXTURE['APP']+'\nclone_name=cloudbench-volume-only\nmachine_id='
            '\nvolume_id=vol_volumeonly\n')
        self.seal_changed_audit(lifecycle)
        self.b.volumes['vol_volumeonly'] = dict(id='vol_volumeonly', state='created', attached_machine_id=None)
        result = subprocess.run(self.recovery_workspace_command(), env=self.b.env, capture_output=True, timeout=8)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(self.m['CLAIM_PREFIX']+OWNER, self.b.machines[self.mid]['config']['metadata'])
        self.b.volumes['vol_volumeonly'] = dict(id='vol_volumeonly', state='pending_destroy', attached_machine_id=None)
        result = subprocess.run(self.recovery_workspace_command(), env=self.b.env, capture_output=True, timeout=8)
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads((self.journal/'recovered-physical-closure.json').read_text())
        self.assertEqual(receipt['native_observations'], {'machines': {}, 'volumes': {'vol_volumeonly': 'pending_destroy'}})
        self.assertFalse(receipt['historical_task_credit'])

    def test_recovery_rejects_claim_custody_swap_and_caller_boolean_override(self):
        process = self.start()
        process.terminate(); process.communicate(timeout=5)
        self.proof()
        meta = self.b.machines[self.mid]['config']['metadata']
        key = self.m['CLAIM_PREFIX']+OWNER
        claim = json.loads(meta[key]); claim['custody']['lifecycle'] = str(self.root/'caller/_batch/lifecycle.json')
        meta[key] = json.dumps(claim)
        result = subprocess.run(self.recovery_workspace_command(), env=self.b.env, capture_output=True, timeout=8)
        self.assertNotEqual(result.returncode, 0)
        result = subprocess.run(self.recovery_workspace_command()+['--allow-failed-lifecycle'], env=self.b.env,
                                capture_output=True, timeout=8)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(key, meta)

    def test_two_concurrent_same_source_holders_publish_distinct_claims_without_lifetime_lease(self):
        owner2, run2 = 'd'*32, 'second-parallel-run'
        audit2 = self.common/'cloudbench-fleet-audits'/owner2; audit2.mkdir(parents=True)
        (audit2/'source-manifest.json').write_bytes(self.path.read_bytes())
        registry2 = self.common/'cloudbench-fleet-ownership'/owner2; registry2.mkdir(parents=True)
        (registry2/'meta').write_text('version=2\nfleet_owner_token='+owner2+'\nrun_id='+run2+'\napp='+FIXTURE['APP']+
            '\npid='+str(os.getpid())+'\npid_start='+self.m['identity'](os.getpid()).replace('linux:', 'proc-start:', 1)+
            '\nworkspace_root='+str(self.workspace)+'\nruns_root='+str(self.runs)+'\naudit_dir='+str(audit2)+
            '\nsource_manifest_sha256='+self.manifest_digest+'\n')
        (self.runs/run2).mkdir()
        ready2, journal2 = self.root/'ready2.json', self.runs/run2/'source-lease'
        command = self.command('hold')
        for flag, value in [('--consumer-owner', owner2), ('--run-id', run2), ('--ready', str(ready2)),
                            ('--journal', str(journal2)), ('--release-proof', str(self.root/'release2.json'))]:
            command[command.index(flag)+1] = value
        first_ack, release_ack, received_409 = threading.Event(), threading.Event(), threading.Event()
        self.addCleanup(release_ack.set)
        actual = self.b.respond
        def delayed_ack(method, path, body):
            answer = actual(method, path, body)
            if method == 'POST' and path.endswith('/metadata/' + self.m['CLAIM_PREFIX'] + OWNER):
                first_ack.set()
                release_ack.wait(5)
            if method == 'POST' and path.endswith('/lease') and answer[0] == 409:
                received_409.set()
            return answer
        self.b.respond = delayed_ack
        first = subprocess.Popen(self.command('hold'), env=self.b.env, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True)
        self.processes.append(first)
        self.assertTrue(first_ack.wait(4), 'first publisher never reached metadata ACK barrier')
        second = subprocess.Popen(command, env=self.b.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.processes.append(second)
        self.assertTrue(received_409.wait(3), 'second publisher did not encounter actual native lease contention')
        release_ack.set()
        try:
            wait_until(lambda: ready2.exists() or second.poll() is not None, timeout=4,
                       description='second publisher READY or exit')
        except WaitTimeout:
            pass  # The assertion below reports the serialized peer.
        self.assertTrue(ready2.exists(), second.communicate(timeout=3) if second.poll() is not None else 'peer serialized behind fleet lifetime')
        self.assertTrue(self.ready.exists(), 'first publisher never became READY')
        self.assertEqual(self.invoke('check').returncode, 0)
        self.assertIsNone(first.poll()); self.assertIsNone(second.poll())
        self.assertIsNone(self.b.lease_nonce, 'a reader kept the provider lease through fleet execution')
        meta = self.b.machines[self.mid]['config']['metadata']
        self.assertIn(self.m['CLAIM_PREFIX']+OWNER, meta)
        self.assertIn(self.m['CLAIM_PREFIX']+owner2, meta)
        self.assertNotEqual(self.b.run_cli(['cleanup', *self.b.args[1:]]).returncode, 0)
        self.proof()
        _, stderr = first.communicate(timeout=6)
        self.assertEqual(first.returncode, 0, stderr)
        self.assertNotIn(self.m['CLAIM_PREFIX']+OWNER, meta)
        self.assertIn(self.m['CLAIM_PREFIX']+owner2, meta)
        check2 = self.command('check')
        for flag, value in [('--consumer-owner', owner2), ('--run-id', run2), ('--ready', str(ready2))]:
            check2[check2.index(flag)+1] = value
        self.assertEqual(subprocess.run(check2, env=self.b.env, capture_output=True, timeout=5).returncode, 0)
        self.assertNotEqual(self.b.run_cli(['cleanup', *self.b.args[1:]]).returncode, 0)
        self.proof(owner2, run2, audit2, registry2, self.root/'release2.json')
        _, stderr = second.communicate(timeout=6)
        self.assertEqual(second.returncode, 0, stderr)
        self.assertNotIn(self.m['CLAIM_PREFIX']+owner2, meta)
        retired = self.b.run_cli(['cleanup', *self.b.args[1:]])
        self.assertEqual(retired.returncode, 0, retired.stderr)

    def test_unknown_native_lease_ack_never_retries_or_publishes_ready(self):
        actual = self.b.respond
        def lost_ack(method, path, body):
            answer = actual(method, path, body)
            if method == 'POST' and path.endswith('/machines/'+self.mid+'/lease'):
                return 503, {}
            return answer
        self.b.respond = lost_ack
        result = subprocess.run(self.command('hold'), env=self.b.env, capture_output=True, text=True, timeout=6)
        self.assertNotEqual(result.returncode, 0)
        attempts = [call for call in self.b.calls if call[0]=='POST' and call[1].endswith('/machines/'+self.mid+'/lease')]
        self.assertEqual(len(attempts), 1)
        self.assertFalse(self.ready.exists())
        self.assertNotIn(self.m['CLAIM_PREFIX']+OWNER, self.b.machines[self.mid]['config']['metadata'])

    def test_guard_binds_expected_source_digest_and_exact_parent(self):
        process = self.start()
        command = self.command('check')
        for flag, value in [('--source-id', '44444444444444'), ('--manifest-sha256', 'd'*64), ('--parent-pid', '2')]:
            changed = list(command); changed[changed.index(flag)+1] = value
            result = subprocess.run(changed, env=self.b.env, capture_output=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)

    def test_killed_unreaped_holder_cannot_pass_guard(self):
        process = self.start()
        process.kill()
        # Do not reap before checking; matching /proc birth alone accepts a zombie.
        try:
            wait_until(lambda: Path('/proc/'+str(process.pid)+'/stat').read_text().rsplit(') ',1)[1].split()[0] == 'Z',
                       timeout=3, description='publisher process becomes a zombie')
        except WaitTimeout:
            pass  # The check below still observes the unexpired native lease.
        self.assertNotEqual(self.invoke('check').returncode, 0)
        process.communicate(timeout=5)
        self.b.lease_nonce = None  # Native lease expires independently of process death.
        result = self.b.run_cli(['cleanup', *self.b.args[1:]])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(self.mid, self.b.machines)

    def test_v1_manifest_and_protocol_tamper_refuse_before_claim(self):
        value = dict(self.manifest, version=1)
        del value['lease_protocol']; del value['creation_nonce']; del value['guest_env_sha256']
        self.path.chmod(0o600); self.write(self.path, value)
        result = subprocess.run(self.command('hold'), env=self.b.env, capture_output=True, text=True, timeout=6)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.ready.exists())
        self.assertFalse(any(k.startswith(self.m['CLAIM_PREFIX']) for k in self.b.machines[self.mid]['config']['metadata']))


    def snapshot_replies(self, empty_reads):
        actual, reads = self.b.respond, []
        def reply(method, path, body):
            if method == 'GET' and path.endswith('/volumes/vol_owned/snapshots'):
                reads.append(path)
                if len(reads) <= empty_reads:
                    return 200, []
            return actual(method, path, body)
        self.b.respond = reply
        return reads

    def test_transient_empty_snapshot_list_is_reread_before_admission(self):
        """PR1910 CodeRabbit 4559306460: the holder ran before the fleet's retrying validator."""
        reads = self.snapshot_replies(empty_reads=2)
        process = subprocess.Popen(self.command('hold'), env=self.b.env, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True)
        self.processes.append(process)
        try:
            wait_until(lambda: self.ready.exists() or process.poll() is not None, timeout=20,
                       description='source lease publisher READY or exit')
        except WaitTimeout:
            pass  # The assertion below reports the missing READY.
        self.assertTrue(self.ready.exists(), process.communicate(timeout=5) if process.poll() is not None else 'no READY')
        self.assertEqual(len(reads), 3)
        self.assertEqual(self.invoke('check').returncode, 0)
        self.assertIn(self.m['CLAIM_PREFIX']+OWNER, self.b.machines[self.mid]['config']['metadata'])

    def test_persistently_missing_snapshot_still_refuses_admission(self):
        reads = self.snapshot_replies(empty_reads=99)
        result = subprocess.run(self.command('hold'), env=self.b.env, capture_output=True, text=True, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(reads), self.m['SNAPSHOT_READS'])
        self.assertFalse(self.ready.exists())
        self.assertFalse(any(k.startswith(self.m['CLAIM_PREFIX']) for k in self.b.machines[self.mid]['config']['metadata']))

    def test_claim_receipt_precedes_native_claim_so_lost_ack_is_recoverable(self):
        """PR1910 CodeRabbit 4559306472: a native claim must never exist without its local receipt."""
        actual = self.b.respond
        key = self.m['CLAIM_PREFIX'] + OWNER
        def lost_ack(method, path, body):
            answer = actual(method, path, body)
            if method == 'POST' and path.endswith('/metadata/' + key):
                return 503, {}
            return answer
        self.b.respond = lost_ack
        result = subprocess.run(self.command('hold'), env=self.b.env, capture_output=True, text=True, timeout=8)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.ready.exists())
        self.assertIn(key, self.b.machines[self.mid]['config']['metadata'])
        self.b.respond = actual
        saved = json.loads((self.journal/'claim.json').read_text())
        self.assertEqual(saved['owned'], {'key': key, 'value': self.b.machines[self.mid]['config']['metadata'][key]})
        self.proof()
        result = subprocess.run(self.recovery_workspace_command(), env=self.b.env, capture_output=True, text=True, timeout=8)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(key, self.b.machines[self.mid]['config']['metadata'])

    def add_pool_transfer(self, mid='55555555555555', vid='vol_pooled', handoff=True):
        (self.audit/'by-machine-id'/mid).write_text('cloudbench-pooled\n')
        common = 'version=1\nfleet_owner_token='+OWNER+'\nrun_id='+RUN+'\napp='+FIXTURE['APP']+'\nclone_name=cloudbench-pooled\n'
        (self.audit/'fresh/cloudbench-pooled').write_text(common+'source=fresh-clone\nsource_machine_id='+self.mid+
            '\nmachine_id='+mid+'\nvolume_id='+vid+'\ndisposition=transferred-to-pool-stopped\n')
        if handoff:
            (self.audit/'pool-handoffs').mkdir(mode=0o700, exist_ok=True)
            ledger = str(self.common/'cloudbench-pools/fixture.ids')
            (self.audit/'pool-handoffs/cloudbench-pooled').write_text(common+'source=fresh-to-pool\nmachine_id='+mid+
                '\nvolume_id='+vid+'\npool_ledger_file='+ledger+'\npool_meta_file='+ledger+'.deps\npool_meta_sha256='+'1'*64+
                '\nclaim_sha256='+'2'*64+'\nlinearization=terminal-record-before-exact-claim-release\n')
        self.b.machines[mid] = dict(id=mid, state='stopped', config={'metadata': {}, 'mounts': [{'volume': vid, 'path': '/data'}]})
        self.b.volumes[vid] = dict(id=vid, state='created', attached_machine_id=mid)

    def reseal_verified(self, lifecycle):
        self.seal_changed_audit(lifecycle)
        value = json.loads(lifecycle.read_text()); value['audit_sha256'] = self.m['digest_tree'](self.audit)
        self.write(lifecycle, value)

    def test_audited_pool_returned_primary_does_not_block_claim_closure(self):
        """PR1910 CodeRabbit 4559306469: a stopped pool-returned primary stays indexed by the audit."""
        process = self.start()
        process.terminate(); process.communicate(timeout=5)
        audit, lifecycle = self.proof()
        self.add_pool_transfer(handoff=False)
        self.reseal_verified(lifecycle)
        self.assertNotEqual(self.invoke('close').returncode, 0)
        self.assertIn(self.m['CLAIM_PREFIX']+OWNER, self.b.machines[self.mid]['config']['metadata'])
        self.add_pool_transfer()
        self.reseal_verified(lifecycle)
        result = self.invoke('close')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(self.m['CLAIM_PREFIX']+OWNER, self.b.machines[self.mid]['config']['metadata'])
        self.assertEqual(self.b.machines['55555555555555']['state'], 'stopped')

    def test_recovery_accepts_audited_pool_return_and_verified_no_allocation(self):
        """PR1910 CodeRabbit 4559306469 and 4559306478 on the physical recovery path."""
        process = self.start()
        process.terminate(); process.communicate(timeout=5)
        audit, lifecycle = self.proof()
        value = json.loads(lifecycle.read_text()); value.update(cleanup_verified=False, audit_sha256='')
        self.write(lifecycle, value)
        (self.audit/'fresh/cloudbench-none').write_text('version=1\nfleet_owner_token='+OWNER+'\nrun_id='+RUN+
            '\napp='+FIXTURE['APP']+'\nclone_name=cloudbench-none\nsource=fresh-clone\nsource_machine_id='+self.mid+
            '\nmachine_id=\nvolume_id=\ndisposition=not-allocated-verified\n')
        self.add_pool_transfer()
        self.seal_changed_audit(lifecycle)
        result = subprocess.run(self.recovery_workspace_command(), env=self.b.env, capture_output=True, text=True, timeout=8)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(self.m['CLAIM_PREFIX']+OWNER, self.b.machines[self.mid]['config']['metadata'])
        receipt = json.loads((self.journal/'recovered-physical-closure.json').read_text())
        self.assertEqual(receipt['native_observations'],
                         {'machines': {'55555555555555': 'transferred-to-pool-stopped'}, 'volumes': {}})

    def test_verified_no_allocation_record_alone_permits_recovery(self):
        """PR1910 CodeRabbit 4559306478: empty Machine and Volume IDs are the verified no-allocation shape."""
        process = self.start()
        process.terminate(); process.communicate(timeout=5)
        audit, lifecycle = self.proof()
        value = json.loads(lifecycle.read_text()); value.update(cleanup_verified=False, audit_sha256='')
        self.write(lifecycle, value)
        (self.audit/'fresh/cloudbench-none').write_text('version=1\nfleet_owner_token='+OWNER+'\nrun_id='+RUN+
            '\napp='+FIXTURE['APP']+'\nclone_name=cloudbench-none\nsource=fresh-clone\nsource_machine_id='+self.mid+
            '\nmachine_id=\nvolume_id=\ndisposition=not-allocated-verified\n')
        self.seal_changed_audit(lifecycle)
        result = subprocess.run(self.recovery_workspace_command(), env=self.b.env, capture_output=True, text=True, timeout=8)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(self.m['CLAIM_PREFIX']+OWNER, self.b.machines[self.mid]['config']['metadata'])
        # The no-allocation exception never admits an unverified empty shape.
        (self.audit/'fresh/cloudbench-none').write_text((self.audit/'fresh/cloudbench-none').read_text()
            .replace('disposition=not-allocated-verified', 'disposition=owned'))
        self.assertRaises(Exception, self.m['original_resources'], self.audit, self.manifest, OWNER, RUN)

    def test_recovery_replay_accepts_terminal_volume_advancing_to_absent(self):
        """PR1910 CodeRabbit 4559306480: pending_destroy -> absent must not strand the original receipt."""
        process = self.start()
        process.terminate(); process.communicate(timeout=5)
        audit, lifecycle = self.proof()
        value = json.loads(lifecycle.read_text()); value.update(cleanup_verified=False, audit_sha256='')
        self.write(lifecycle, value)
        (self.audit/'fresh/cloudbench-volume-only').write_text('version=1\nfleet_owner_token='+OWNER+
            '\nrun_id='+RUN+'\napp='+FIXTURE['APP']+'\nclone_name=cloudbench-volume-only\nmachine_id='
            '\nvolume_id=vol_volumeonly\n')
        self.seal_changed_audit(lifecycle)
        self.b.volumes['vol_volumeonly'] = dict(id='vol_volumeonly', state='pending_destroy', attached_machine_id=None)
        actual = self.b.respond
        key = self.m['CLAIM_PREFIX'] + OWNER
        def interrupted_removal(method, path, body):
            if method == 'DELETE' and path.endswith('/metadata/' + key):
                return 503, {}
            return actual(method, path, body)
        self.b.respond = interrupted_removal
        result = subprocess.run(self.recovery_workspace_command(), env=self.b.env, capture_output=True, text=True, timeout=8)
        self.assertNotEqual(result.returncode, 0)
        original = (self.journal/'recovered-physical-closure.json').read_bytes()
        self.assertIn(key, self.b.machines[self.mid]['config']['metadata'])
        self.b.respond = actual
        del self.b.volumes['vol_volumeonly']
        result = subprocess.run(self.recovery_workspace_command(), env=self.b.env, capture_output=True, text=True, timeout=8)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(key, self.b.machines[self.mid]['config']['metadata'])
        self.assertEqual((self.journal/'recovered-physical-closure.json').read_bytes(), original)
        self.assertEqual(json.loads(original)['native_observations']['volumes'], {'vol_volumeonly': 'pending_destroy'})


class FleetGitCommon(unittest.TestCase):
    def test_same_canonical_path_implementation_without_deploy_planner_import(self):
        def implementation(path):
            return next(node for node in ast.parse(path.read_text()).body
                        if isinstance(node, ast.FunctionDef) and node.name == 'fleet_git_common')
        self.assertEqual(ast.dump(implementation(HERE/'deploy_test_native_cleanup.py')),
                         ast.dump(implementation(HELPER)))

    def test_normal_gitfile_and_invalid_repositories(self):
        module = runpy.run_path(str(HELPER))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            regular = root/'regular'
            subprocess.run(['git', 'init', '-q', str(regular)], check=True, capture_output=True)
            self.assertEqual(module['fleet_git_common'](regular), regular/'.git')
            separate, common = root/'separate', root/'common'
            subprocess.run(['git', 'init', '-q', '--separate-git-dir', str(common), str(separate)],
                           check=True, capture_output=True)
            self.assertTrue((separate/'.git').is_file())
            self.assertEqual(module['fleet_git_common'](separate), common)
            invalid = root/'invalid'; invalid.mkdir()
            with self.assertRaises(ValueError):
                module['fleet_git_common'](invalid)


class AuditFDBound(unittest.TestCase):
    def test_growth_between_path_stat_and_open_refuses_before_oversize_read(self):
        module = runpy.run_path(str(HELPER))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'audit-grow.json'
            path.write_bytes(b'{}'); path.chmod(0o600)
            original = os.open
            def growing(member, *args, **kwargs):
                if Path(member) == path:
                    with path.open('wb') as stream:
                        stream.truncate(16*1024*1024+1)
                return original(member, *args, **kwargs)
            with patch.object(os, 'open', side_effect=growing), self.assertRaises(ValueError):
                module['audit_payload'](path)


if __name__=='__main__': unittest.main()
