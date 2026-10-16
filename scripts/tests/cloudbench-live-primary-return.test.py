#!/usr/bin/env python3
"""Local control-flow tests for current-owner return; native proof stays canonical."""
import os
import json
import runpy
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'run-bench-fleet'


def function(name):
    match = re.search(r'^' + name + r'\(\).*?^}\n', Path(os.environ.get('LIVE_RETURN_SOURCE',str(SOURCE))).read_text(), re.M | re.S)
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

    def test_retained_or_incomplete_run_refuses(self):
        for change in ('KEEP_CLONES=1', 'FLEET_EXECUTION_COMPLETED=0'):
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



class ColdEmptyReturn(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.owner='a'*32;self.registry=self.root/self.owner;self.audit=self.root/'audits'/self.owner;self.run=self.root/'.context/runs/run';self.claims=self.root/'claims'
        for p in (self.registry/'clones',self.audit/'fresh',self.audit/'expected-fresh',self.audit/'by-machine-id',self.audit/'pool',self.run/'task',self.claims):p.mkdir(parents=True,exist_ok=True)
        for n in ('owned-clones.ids','owned-clones.names'):(self.audit/n).write_text('')
        self.fields(self.audit/'meta',dict(fleet_owner_token=self.owner,app='app'))
        self.fields(self.audit/'pool/abcd',dict(version='1',fleet_owner_token=self.owner,app='app',run_id='run',source='borrowed-pool',machine_id='abcd',volume_id='vol_fixture',pool_ledger_file=str(self.root/'pool.ids'),pool_meta_file=str(self.root/'pool.ids.deps'),pool_meta_sha256='d'*64,disposition='returned-stopped-claim-released'))
        (self.run/'task/.cid').write_text('pool abcd\n');(self.run/'claimed-pool.ids').write_text('abcd\n')
        c=runpy.run_path(str(SOURCE.with_name('cloudbench_execution_provenance.py')));matrix=c['build_task_matrix'](['task=real']);cfg=c['build_config'](c['CONFIG_SCHEMA_VERSION'],['task_count=1','task_matrix_sha256='+matrix['sha256'],'app=app','node_dependency_fingerprint='+'a'*64,'python_dependency_fingerprint='+'b'*64,'volume_snapshot_id=snap'])
        self.prov=dict(schema_version=c['EXECUTION_SCHEMA_VERSION'],base_sha='c'*40,workspace_patch_sha256='none',controller_snapshot=dict(schema_version=c['SNAPSHOT_SCHEMA_VERSION'],sha256='f'*64),config=cfg)
        (self.run/'execution-provenance.json').write_text(json.dumps(self.prov));(self.run/'execution-task-matrix.json').write_text(json.dumps(matrix))
    def fields(self,path,row):path.write_text(''.join(k+'='+v+'\n'for k,v in row.items()))
    def invoke(self,changes=''):
        shell=r'''set -e
FLEET_REGISTRY_DIR="$CASE_DIR/$OWNER";FLEET_TEARDOWN_OWNERSHIP_DIR="$CASE_DIR/audits/$OWNER";FLEET_AUDIT_ROOT="$CASE_DIR/audits";ROOT_DIR="$CASE_DIR"
FLEET_OWNER_TOKEN="$OWNER";FLEET_OWNER_HOST=host;FLEET_OWNER_PID_START=birth;RUN_ID=run;APP=app
POOL_CLAIMS_DIR="$CASE_DIR/claims";CLAIMED_POOL_FILE="$CASE_DIR/.context/runs/run/claimed-pool.ids"
FLEET_REGISTRY_PUBLISHED=1;FLEET_EXECUTION_COMPLETED=1;KEEP_CLONES=0;POOL_COLD_BOOTSTRAP=1
CLOUDBENCH_SCRIPT_SNAPSHOT="$SCRIPTS";CLOUDBENCH_PYTHON_MANIFESTS=()
cat > "$FLEET_REGISTRY_DIR/meta" <<EOF
version=2
fleet_owner_token=$OWNER
app=app
host=host
pid=$$
pid_start=birth
run_id=run
workspace_root=$CASE_DIR
runs_root=$CASE_DIR/.context/runs
audit_dir=$CASE_DIR/audits/$OWNER
cleanup_policy=reap
EOF
registry_meta_value(){ sed -n "s/^$2=//p" "$1"; }
registry_owner_alive(){ return 0; }
cloudbench_node_dependency_fingerprint(){ printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'; }
cloudbench_manifest_fingerprint(){ printf 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n'; }
registry_machine_details(){ echo native >> "$CASE_DIR/events";return 1; }
pool_source_image_digest(){ echo image >> "$CASE_DIR/events";return 1; }
'''
        for name in ('fleet_registry_cleanup_state','fleet_validate_reap_cohort','pool_recovery_primary_plan','current_registry_primaries_to_pool_plan','return_current_registry_primaries_to_pool','stop_current_registry_primaries_for_pool'):shell+='\n'+function(name)
        shell+='\n'+changes+'\nstop_current_registry_primaries_for_pool 1 0 0\nreturn_current_registry_primaries_to_pool 1 0 0\n'
        result=subprocess.run(['bash','-c',shell],env=dict(os.environ,CASE_DIR=str(self.root),OWNER=self.owner,SCRIPTS=str(SOURCE.parent)),capture_output=True,text=True)
        self.assertFalse((self.root/'events').exists(),'empty cohort must not read/stop/transfer native resources');return result
    def test_returned_borrowed_cold_cohort_is_noop(self):
        r=self.invoke();self.assertEqual(r.returncode,0,r.stderr)
    def test_aborted_parent_without_any_claim_or_task_is_noop(self):
        (self.audit/'pool/abcd').unlink();(self.run/'task/.cid').unlink();(self.run/'claimed-pool.ids').unlink()
        r=self.invoke('FLEET_EXECUTION_COMPLETED=0');self.assertEqual(r.returncode,0,r.stderr)
    def absent_pool_parent(self):
        (self.audit/'pool/abcd').unlink();(self.audit/'pool').rmdir()
        (self.run/'task/.cid').unlink();(self.run/'claimed-pool.ids').unlink()
    def test_actual_aborted_parent_absent_pool_and_claim_ledger_is_noop(self):
        self.absent_pool_parent();r=self.invoke('FLEET_EXECUTION_COMPLETED=0');self.assertEqual(r.returncode,0,r.stderr)
    def test_absent_pool_with_claim_ledger_refuses(self):
        self.absent_pool_parent();(self.run/'claimed-pool.ids').write_text('')
        self.assertNotEqual(self.invoke().returncode,0)
    def test_absent_pool_with_task_cid_refuses(self):
        self.absent_pool_parent();(self.run/'task/.cid').write_text('pool abcd\n')
        self.assertNotEqual(self.invoke().returncode,0)
    def test_pool_symlink_is_not_typed_absence(self):
        self.absent_pool_parent();(self.audit/'pool').symlink_to(self.root/'missing')
        self.assertNotEqual(self.invoke().returncode,0)
    def test_pool_regular_file_is_not_typed_absence(self):
        self.absent_pool_parent();(self.audit/'pool').write_text('')
        self.assertNotEqual(self.invoke().returncode,0)
    def test_absent_other_fresh_directory_still_refuses(self):
        self.absent_pool_parent();(self.audit/'fresh').rmdir()
        self.assertNotEqual(self.invoke().returncode,0)
    def test_unfinished_borrowed_audit_refuses(self):
        p=self.audit/'pool/abcd';p.write_text(p.read_text().replace('returned-stopped-claim-released','claimed'))
        self.assertNotEqual(self.invoke().returncode,0)
    def test_shared_claim_or_unmapped_claimed_id_refuses(self):
        (self.claims/'abcd').write_text('owned claim');self.assertNotEqual(self.invoke().returncode,0)
        (self.claims/'abcd').unlink();(self.claims/'orphan').write_text('owned claim');(self.run/'claimed-pool.ids').write_text('orphan\n');self.assertNotEqual(self.invoke().returncode,0)
    def test_any_fresh_ownership_refuses(self):
        for p in (self.registry/'clones/x',self.audit/'fresh/x',self.audit/'expected-fresh/x',self.audit/'by-machine-id/x',self.audit/'owned-clones.ids'):
            old=p.read_bytes()if p.exists()else None;p.write_text('unexpected')
            self.assertNotEqual(self.invoke().returncode,0)
            if old is None:p.unlink()
            else:p.write_bytes(old)
    def test_wrong_live_owner_and_unjoined_refuse(self):
        for changes in ('FLEET_OWNER_PID_START=wrong','KEEP_CLONES=1'):
            self.assertNotEqual(self.invoke(changes).returncode,0)
    def test_dependency_contract_still_required(self):
        self.prov['config']['values']['node_dependency_fingerprint']='0'*64;(self.run/'execution-provenance.json').write_text(json.dumps(self.prov))
        self.assertNotEqual(self.invoke().returncode,0)
    def test_unrecorded_clone_cid_cannot_be_treated_as_empty(self):
        (self.run/'task/.cid').write_text('clone abcd\n');self.assertNotEqual(self.invoke().returncode,0)

if __name__ == '__main__':
    unittest.main()
