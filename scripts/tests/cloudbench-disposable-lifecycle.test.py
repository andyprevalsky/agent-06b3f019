#!/usr/bin/env python3
"""Owning create/retire decisions; provider boundaries are local filesystem fakes."""
from pathlib import Path
import os,re,subprocess,tempfile,unittest
SOURCE=Path(__file__).resolve().parents[1]/'run-bench-fleet'
def function(name):
 m=re.search(r'^'+re.escape(name)+r'\(\).*?^}\n',SOURCE.read_text(),re.M|re.S);assert m,name;return m.group()
class Disposable(unittest.TestCase):
 def run_case(self,body,*,missing=False,disposable=True):
  with tempfile.TemporaryDirectory()as d:
   p=Path(d);reg=p/'owners'/('a'*32);(reg/'clones').mkdir(parents=True);(reg/'meta').write_text('version=2\n');(reg/'disposable-resources-v1').write_text('a'*32+'\nfixture\n');(reg/'clones/clone-fixture').write_text('name=clone-fixture\nid=abcd1234\nvolume_id=vol_owned\n')
   for n in ('guest-cleanup-unconfirmed','runtime-evidence-unconfirmed'):
    if missing:(reg/n).touch()
   script='set -u\n'+''.join(function(n)for n in ('fleet_current_disposable_registry','fleet_disposable_delete_intent','reap_volume','reap_machine','fleet_validate_reap_cohort','fleet_reap_registry_record_native','fleet_reap_registry_record','reap_registry_clones','machine_creation_admission','provision_primary_machine'))+r'''
APP=fixture; FLEET_OWNER_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FLEET_OWNERSHIP_ROOT="$CASE/owners";FLEET_REGISTRY_DIR="$FLEET_OWNERSHIP_ROOT/$FLEET_OWNER_TOKEN"
GIT_COMMON_DIR="$CASE/common";mkdir -p "$GIT_COMMON_DIR"
POOL_REUSE_ONLY=0;DISPOSABLE_LIFECYCLE=MODE;DISPOSABLE_REAP=1
WARM_ID=warm;WARM_VOLUME_ID=vol_warm;SHARED_WARM_ID=shared;SHARED_WARM_VOLUME_ID=vol_shared
PROVISION_POOL=''; FRESH_TARGET_REGION='';POOL_COLD_BOOTSTRAP=0;SNAP_ID=snap
printf started > "$CASE/machine-state";printf created > "$CASE/volume-state"
FLY(){
 printf '%s\n' "$*" >> "$CASE/calls"
 case "$1 $2" in
 'machine destroy') [ "${HOLD:-0}" = 1 ] || printf absent > "$CASE/machine-state";[ "${AMBIGUOUS:-0}" != 1 ] ;;
 'volumes destroy') printf "${SOFT:-absent}" > "$CASE/volume-state" ;;
 *) return 9;;esac
}
registry_machine_details(){ local s; s="$(cat "$CASE/machine-state")";[ "$s" != absent ]||return 1;printf '%s clone-fixture\n' "$s"; }
volume_inventory_contains_id(){ local s;s="$(cat "$CASE/volume-state")";[ "$s" != absent ]||return 1;echo "$s"; }
registry_meta_value(){ sed -n "s/^$2=//p" "$1"; }
fleet_registry_reconcile_mounted_volume(){ echo vol_owned; }
fleet_audit_update_registry_clone(){ printf 'audit %s\n' "$*" >> "$CASE/audit"; }
fleet_with_native_reap_permit(){ "$@"; }
sleep(){ :; }
primary_vm_size_for_bench(){ echo shared-cpu-4x; }
primary_vm_memory_for_bench(){ echo 8192; }
bench_uses_default_pool_shape(){ return 0; }
claim_pool_machine(){ echo BORROWED >> "$CASE/claims";echo existing; }
clone_machine_target(){ machine_creation_admission "$1"||return $?;echo CREATE >> "$CASE/creates";echo new123; }
primary_clone_storage_mode(){ echo fresh; }
mkdir -p "$CASE/out"
'''.replace('MODE','1'if disposable else'0')+body
   r=subprocess.run(['bash','-c',script],env=dict(os.environ,CASE=d),capture_output=True,text=True)
   read=lambda n:(p/n).read_text()if(p/n).exists()else''
   return r,{n:read(n)for n in ('calls','audit','claims','creates','out/.cid')},list((reg/'clones').iterdir())
 def test_disposable_start_creates_instead_of_borrowing(self):
  r,v,_=self.run_case('provision_primary_machine bench "$CASE/out"');self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(v['out/.cid'],'clone new123\n');self.assertEqual(v['claims'],'');self.assertEqual(v['creates'],'CREATE\n')
 def test_explicit_reuse_borrows_no_create(self):
  r,v,_=self.run_case('POOL_REUSE_ONLY=1;provision_primary_machine bench "$CASE/out"',disposable=False);self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(v['out/.cid'],'pool existing\n');self.assertEqual(v['creates'],'')
 def test_failed_evidence_still_retires_exact_disposable(self):
  r,v,records=self.run_case('reap_registry_clones "$FLEET_REGISTRY_DIR" current',missing=True);self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(v['calls'].splitlines(),['machine destroy --force abcd1234 -a fixture','volumes destroy vol_owned -a fixture --yes']);self.assertEqual(records,[])
 def test_legacy_missing_evidence_retains(self):
  r,v,records=self.run_case('reap_registry_clones "$FLEET_REGISTRY_DIR" current',missing=True,disposable=False);self.assertNotEqual(r.returncode,0);self.assertEqual(v['calls'],'');self.assertEqual(len(records),1)
 def test_foreign_registry_marker_not_disposable(self):
  r,v,_=self.run_case('FLEET_OWNER_TOKEN=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;reap_registry_clones "$FLEET_REGISTRY_DIR" current',missing=True);self.assertNotEqual(r.returncode,0);self.assertEqual(v['calls'],'')
 def test_ambiguous_delete_then_get_only(self):
  r,v,_=self.run_case('AMBIGUOUS=1;reap_machine abcd1234 "$CASE/log" vol_owned');self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(len(v['calls'].splitlines()),2)
 def test_still_stopped_not_deleted_never_success_or_retry(self):
  r,v,_=self.run_case('HOLD=1;printf stopped > "$CASE/machine-state";reap_machine abcd1234 "$CASE/log" vol_owned;reap_machine abcd1234 "$CASE/log2" vol_owned');self.assertNotEqual(r.returncode,0);self.assertEqual(v['calls'].splitlines(),['machine destroy --force abcd1234 -a fixture'])
 def test_soft_deleted_volume_is_typed_retained_not_absence(self):
  r,v,_=self.run_case('SOFT=pending_destroy;reap_volume vol_owned');self.assertEqual(r.returncode,74,r.stderr);self.assertEqual(len(v['calls'].splitlines()),1)
 def test_warm_whm_borrowed_no_mutation(self):
  for body in ['reap_machine warm "$CASE/log" vol_warm','reap_machine 820224f7e069e8 "$CASE/log" vol_whm','mkdir -p "$GIT_COMMON_DIR/cloudbench-worker-reuse/proofs";touch "$GIT_COMMON_DIR/cloudbench-worker-reuse/proofs/abcd1234.json";reap_machine abcd1234 "$CASE/log" vol_owned','reap_volume vol_warm']:
   r,v,_=self.run_case(body);self.assertNotEqual(r.returncode,0);self.assertEqual(v['calls'],'')
 def test_explicit_keep_does_not_change_creation_policy(self):
  r,v,_=self.run_case('KEEP_CLONES=1;provision_primary_machine bench "$CASE/out"');self.assertEqual(r.returncode,0);self.assertEqual(v['claims'],'');self.assertEqual(v['creates'],'CREATE\n')
if __name__=='__main__':unittest.main()
