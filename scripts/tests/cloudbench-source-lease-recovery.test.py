#!/usr/bin/env python3
"""Canonical recovery wiring through real source leases and a local native API."""
import hashlib
import os
from pathlib import Path
import re
import runpy
import subprocess
import unittest

ROOT = Path(os.environ.get('CLOUDBENCH_RECOVERY_REPO_ROOT', Path(__file__).resolve().parents[2]))
FLEET = Path(os.environ.get('CLOUDBENCH_FLEET_UNDER_TEST', ROOT / 'scripts/run-bench-fleet'))
LEASE_TESTS = runpy.run_path(str(ROOT / 'scripts/tests/cloudbench-source-lease.test.py'))


class SourceRecovery(unittest.TestCase):
    def setUp(self):
        self.fixture = LEASE_TESTS['SourceLease']('runTest')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)

    def orphan(self, *, live_consumer=False, through_entry=False):
        f = self.fixture
        process = f.start()
        process.terminate(); process.communicate(timeout=5)
        _, lifecycle = f.proof()
        old = f.m['read'](lifecycle) if lifecycle.stat().st_mode & 0o077 == 0 else __import__('json').loads(lifecycle.read_text())
        old.update(cleanup_verified=False, audit_sha256='')
        f.write(lifecycle, old)
        original = lifecycle.read_bytes()
        if live_consumer:
            f.b.machines['33333333333333'] = dict(id='33333333333333', state='started',
                config={'metadata': {'fleet_owner_token': LEASE_TESTS['OWNER']}})
        source = FLEET.read_text()
        start = source.index('recover_exact_stale_fleet_owner() {')
        end = source.index('# ── Pre-provisioned pool:', start)
        definitions = source[start:end]
        helper = re.search(r'^fleet_close_recovered_source_consumer\(\).*?^}', source, re.M | re.S)
        if helper:
            definitions = helper.group(0) + '\n' + definitions
        prelude = 'source '+str(ROOT/'scripts/lib/cloudbench-inventory.sh')+'\n'
        prelude += 'fleet_publish_recovered_terminal_projection(){ return 0; }\n'
        if through_entry:
            begin = source.index('if [ "$RECOVER_STALE_ONLY" = "1" ]; then\n')
            stop = source.index('# ── Fire-time visibility:', begin)
            prelude += 'RECOVER_STALE_ONLY=1\nLOCK_DIR=fixture\ncloudbench_controller_lock_release(){ return 0; }\n'
            prelude += 'exact_recovery_is_pool_only(){ return 1; }\nresolve_exact_recovery_warm_identity(){ return 1; }\n'
            script = prelude + definitions + '\n' + source[begin:stop]
        else:
            script = prelude + definitions + '\nrecover_exact_stale_fleet_owner "$RECOVER_OWNER_TOKEN"\n'
        result = subprocess.run(['bash', '-c', script], env=dict(f.b.env,
            FLEET_OWNERSHIP_ROOT=str(f.registry.parent), FLEET_AUDIT_ROOT=str(f.audit.parent),
            RECOVER_OWNER_TOKEN=LEASE_TESTS['OWNER'], APP='navi-whisper-lux-bench',
            SOURCE_HELPER=str(ROOT/'scripts/cloudbench-source.py'), SOURCE_LEASE_HELPER=str(ROOT/'scripts/cloudbench-source-lease.py')),
            capture_output=True, text=True, timeout=12)
        self.assertEqual(lifecycle.read_bytes(), original, 'original failed lifecycle bytes were changed')
        return result

    def test_canonical_orphan_recovery_closes_v2_claim_preserving_failed_lifecycle(self):
        f = self.fixture
        result = self.orphan()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(f.m['CLAIM_PREFIX']+LEASE_TESTS['OWNER'], f.b.machines[f.mid]['config']['metadata'])
        receipt = f.m['read'](f.journal/'recovered-physical-closure.json')
        self.assertIs(receipt['historical_task_credit'], False)

    def test_normal_reconcile_entry_resumes_v2_orphan_without_new_caller_paths(self):
        f = self.fixture
        result = self.orphan(through_entry=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(f.m['CLAIM_PREFIX']+LEASE_TESTS['OWNER'], f.b.machines[f.mid]['config']['metadata'])

    def test_legacy_v1_audit_does_not_invoke_new_source_recovery(self):
        f = self.fixture
        legacy = dict(f.manifest, version=1)
        del legacy['lease_protocol']; del legacy['creation_nonce']; del legacy['guest_env_sha256']
        f.path.chmod(0o600); f.write(f.path, legacy)
        f.proof()
        source = FLEET.read_text()
        begin = source.index('recover_exact_stale_fleet_owner() {')
        end = source.index('# ── Pre-provisioned pool:', begin)
        definitions = source[begin:end]
        helper = re.search(r'^fleet_close_recovered_source_consumer\(\).*?^}', source, re.M | re.S)
        if helper: definitions = helper.group(0)+'\n'+definitions
        script = 'source '+str(ROOT/'scripts/lib/cloudbench-inventory.sh')+'\nfleet_publish_recovered_terminal_projection(){ return 0; }\n'
        script += definitions+'\nrecover_exact_stale_fleet_owner "$RECOVER_OWNER_TOKEN"\n'
        before = len(f.b.calls)
        result = subprocess.run(['bash','-c',script], env=dict(f.b.env,
            FLEET_OWNERSHIP_ROOT=str(f.registry.parent), FLEET_AUDIT_ROOT=str(f.audit.parent),
            RECOVER_OWNER_TOKEN=LEASE_TESTS['OWNER'], APP='navi-whisper-lux-bench',
            SOURCE_HELPER=str(ROOT/'scripts/cloudbench-source.py'), SOURCE_LEASE_HELPER='/must-not-execute'),
            capture_output=True,text=True,timeout=5)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(len(f.b.calls),before)

    def test_live_original_consumer_retains_source_claim(self):
        f = self.fixture
        result = self.orphan(live_consumer=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f.m['CLAIM_PREFIX']+LEASE_TESTS['OWNER'], f.b.machines[f.mid]['config']['metadata'])


if __name__ == '__main__': unittest.main()
