#!/usr/bin/env python3
"""Local control-flow tests for current-owner return; native proof stays canonical."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'run-bench-fleet'


def function(name):
    match = re.search(r'^' + name + r'\(\).*?^}\n', SOURCE.read_text(), re.M | re.S)
    assert match, name
    return match.group()


class LiveReturn(unittest.TestCase):
    def run_case(self, changes='', args='1 0 0', fail_second=False, plan_only=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'registry').mkdir()
            (root / 'claims').mkdir()
            script = r'''
set -e
FLEET_REGISTRY_DIR="$CASE_DIR/registry"; FLEET_OWNER_TOKEN=owner
FLEET_OWNER_HOST=host; FLEET_OWNER_PID_START=birth; RUN_ID=run
FLEET_TEARDOWN_OWNERSHIP_DIR="$CASE_DIR/audit"; ROOT_DIR="$CASE_DIR"
POOL_IDS_FILE="$CASE_DIR/pools/repo.ids"; POOL_CLAIMS_DIR="$CASE_DIR/claims"
FLEET_REGISTRY_PUBLISHED=1; FLEET_EXECUTION_COMPLETED=1
KEEP_CLONES=0; POOL_COLD_BOOTSTRAP=0; CLOUDBENCH_PYTHON_MANIFESTS=()
cat > "$FLEET_REGISTRY_DIR/meta" <<EOF
fleet_owner_token=owner
host=host
pid=$$
pid_start=birth
run_id=run
audit_dir=$CASE_DIR/audit
cleanup_policy=reap
EOF
registry_meta_value() { sed -n "s/^$2=//p" "$1"; }
registry_owner_alive() { [ "$OWNER_DEAD" = 0 ]; }
fleet_validate_reap_cohort() { echo cohort >> "$CASE_DIR/actions"; }
cloudbench_node_dependency_fingerprint() { echo node; }
cloudbench_manifest_fingerprint() { echo python; }
pool_recovery_primary_plan() {
    [ "$4" = current ] || return 1
    printf 'node\tpython\tsnapshot\nabcd\tcloudbench-a\tvol_a\nefab\tcloudbench-b\tvol_b\n'
}
pool_source_image_digest() { echo image; }
pool_native_reuse_proof() {
    echo "proof:$1" >> "$CASE_DIR/actions"
    [ "$FAIL_SECOND:$1" != 1:efab ] || return 1
    printf '{"machine":"%s"}' "$1"
}
pool_publish_recovery_baseline() { echo baseline >> "$CASE_DIR/actions"; }
transfer_owned_stopped_machine_to_pool() {
    [ "$2:$3" = "$$:birth" ] || return 1
    echo "transfer:$1" >> "$CASE_DIR/actions"
}
'''
            script += function('fleet_registry_cleanup_state')
            script += function('current_registry_primaries_to_pool_plan')
            script += function('return_current_registry_primaries_to_pool')
            script += changes + '\n' + ('current_registry_primaries_to_pool_plan' if plan_only else 'return_current_registry_primaries_to_pool') + ' ' + args + '\n'
            result = subprocess.run(['bash', '-c', script], capture_output=True, text=True,
                                    env={**os.environ, 'CASE_DIR': directory, 'OWNER_DEAD': '0',
                                         'FAIL_SECOND': str(int(fail_second))})
            actions = (root / 'actions').read_text().splitlines() if (root / 'actions').exists() else []
            return result, actions

    def test_read_only_plan_exposes_exact_stop_targets_without_native_or_mutation(self):
        result, actions = self.run_case(plan_only=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'node\tpython\tsnapshot\nabcd\tcloudbench-a\tvol_a\nefab\tcloudbench-b\tvol_b\n')
        self.assertEqual(actions, ['cohort'])

    def test_live_owner_proves_every_primary_before_publishing(self):
        result, actions = self.run_case()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(actions, ['cohort', 'proof:abcd', 'proof:efab', 'baseline', 'transfer:abcd', 'transfer:efab'])

    def test_unjoined_or_missing_guest_or_runtime_never_reads_native(self):
        for args in ('0 0 0', '1 1 0', '1 0 1'):
            with self.subTest(args=args):
                result, actions = self.run_case(args=args)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(actions, [])

    def test_wrong_current_identity_refuses(self):
        result, actions = self.run_case('FLEET_OWNER_PID_START=other')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(actions, [])

    def test_dead_owner_does_not_use_live_return(self):
        result, actions = self.run_case('OWNER_DEAD=1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(actions, [])

    def test_retained_incomplete_or_cold_run_refuses(self):
        for change in ('KEEP_CLONES=1', 'FLEET_EXECUTION_COMPLETED=0', 'POOL_COLD_BOOTSTRAP=1'):
            with self.subTest(change=change):
                result, actions = self.run_case(change)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(actions, [])

    def test_latched_or_locked_registry_refuses(self):
        for latch in ('guest-cleanup-unconfirmed', 'runtime-evidence-unconfirmed', 'cold-handoff-outgoing', 'recovery-lock'):
            with self.subTest(latch=latch):
                result, actions = self.run_case('touch "$FLEET_REGISTRY_DIR/' + latch + '"')
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(actions, [])

    def test_protected_warm_machine_refuses_before_proof(self):
        result, actions = self.run_case('WARM_ID=abcd')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(actions, ['cohort'])

    def test_existing_claim_refuses_before_publication(self):
        result, actions = self.run_case('touch "$POOL_CLAIMS_DIR/abcd"')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(actions, ['cohort', 'proof:abcd'])

    def test_second_native_refusal_never_partially_publishes(self):
        result, actions = self.run_case(fail_second=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(actions, ['cohort', 'proof:abcd', 'proof:efab'])


class ActualPrimaryPlan(unittest.TestCase):
    def run_plan(self, mode, source='pool'):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            owner = 'a' * 32
            registry = root / owner
            audit = root / 'audits' / owner
            run = root / '.context' / 'runs' / 'run'
            for path in (registry, audit, run / 'task'):
                path.mkdir(parents=True)
            (registry / 'meta').write_text(f'version=2\nfleet_owner_token={owner}\napp=app\nworkspace_root={root}\nrun_id=run\nruns_root={root}/.context/runs\naudit_dir={audit}\n')
            (audit / 'meta').write_text(f'fleet_owner_token={owner}\napp=app\n')
            (run / 'task/.cid').write_text(source + ' abcd\n')
            (root / 'cloudbench_execution_provenance.py').write_text(
                "def load_provenance(path):\n return {'config': {'values': {'app': 'app', 'node_dependency_fingerprint': '" + 'a' * 64 + "', 'python_dependency_fingerprint': '" + 'b' * 64 + "', 'volume_snapshot_id': 'snap'}}}\n"
                "def load_task_matrix(path):\n return {'tasks': [{'name': 'task'}]}\n"
                "def validate_task_matrix_binding(*args):\n return []\n")
            script = function('pool_recovery_primary_plan') + '\nROOT_DIR="$CASE_DIR"; FLEET_AUDIT_ROOT="$CASE_DIR/audits"; APP=app; CLOUDBENCH_SCRIPT_SNAPSHOT="$CASE_DIR"; POOL_CLAIMS_DIR="$CASE_DIR/claims"\npool_recovery_primary_plan "$CASE_DIR/' + owner + '" ' + 'a' * 64 + ' ' + 'b' * 64 + ' ' + mode
            return subprocess.run(['bash', '-c', script], env={**os.environ, 'CASE_DIR': directory}, capture_output=True, text=True)

    def test_existing_recovery_still_refuses_empty_primary_set(self):
        self.assertNotEqual(self.run_plan('recovery').returncode, 0)

    def test_current_pool_only_run_needs_no_fresh_transfer(self):
        result = self.run_plan('current')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'a' * 64 + '\t' + 'b' * 64 + '\tsnap\n')

    def test_current_clone_missing_runtime_still_refuses(self):
        self.assertNotEqual(self.run_plan('current', 'clone').returncode, 0)


if __name__ == '__main__':
    unittest.main()
