#!/usr/bin/env python3
import os,re,runpy,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
CANDIDATE=Path(os.environ.get('CLOUDBENCH_TEST_CROSS_SOURCE',str(ROOT/'scripts/run-bench-fleet')))
mod=runpy.run_path(str(ROOT/'scripts/tests/cloudbench-disposable-lifecycle.test.py'))
mod['function'].__globals__['SOURCE']=CANDIDATE
def function(name):
 text=CANDIDATE.read_text()
 old=os.environ.get('CLOUDBENCH_TEST_OLD_CROSS_SOURCE')
 if old and name in ('fleet_reap_registry_record','stale_registry_only_waits_for_provider_detach'):text=Path(old).read_text()
 return re.search(r'^'+re.escape(name)+r'\(\).*?^}\n',text,re.M|re.S).group()
class Cross(unittest.TestCase):
 def run_case(self,kind='machine',legacy=False,corrupt=False,malformed=False,latch=False,forced=False,never=False):
  body=''.join(function(name)for name in ('fleet_registry_remove_if_empty','fleet_disposable_registry_policy','fleet_pid_matches_start','registry_owner_alive','fleet_registry_cleanup_state','reconcile_stale_fleet_registries_full','reconcile_stale_fleet_registries','stale_registry_only_waits_for_provider_detach'))
  if os.environ.get('CLOUDBENCH_TEST_OLD_CROSS_SOURCE'):body+=function('fleet_reap_registry_record')
  body+=r'''
FLY(){
 printf '%s\n' "$*" >> "$CASE/calls"
 case "$1 $2" in
 'machine destroy') [ "$HOLD" = 1 ] || printf absent > "$CASE/machine-state";return 1;;
 'volumes destroy') printf "$SOFT" > "$CASE/volume-state";return 0;;
 'volumes show') printf '{"id":"vol_owned","state":"%s","attached_machine_id":null}\n' "$(cat "$CASE/volume-state")";;
 *) return 9;;esac
}
recover_registry_audit_only_fresh(){ return 0; }
release_cleanup_disk_reserve(){ return 0; }
acquire_registry_recovery_lock(){ return 0; }
release_registry_recovery_lock(){ return 0; }
exact_owner_pool_claim_ids(){ return 0; }
recover_exact_pool_claims(){ return 0; }
fleet_audit_finalize_recovered_registry(){ return 0; }
OLD="$FLEET_REGISTRY_DIR";HOLD=1;SOFT=waiting_for_detach
'''
  if kind=='volume':body+='printf absent > "$CASE/machine-state";printf waiting_for_detach > "$CASE/volume-state"\n'
  body+=r'''
(
 old_pid="$BASHPID";old_birth="$(ps -p "$old_pid" -o lstart= | sed 's/^ *//;s/ *$//')"
 printf 'version=2\nfleet_owner_token=%s\nrun_id=run\napp=fixture\ncleanup_policy=reap\nhost=fixture\npid=%s\npid_start=%s\n' "$FLEET_OWNER_TOKEN" "$old_pid" "$old_birth" > "$OLD/meta"
'''
  if not never:body+='fleet_reap_registry_record "$OLD" current 2 0 "$OLD/clones/cloudbench-fixture" || true\n'
  body+=')\nregistry_owner_alive "$OLD/meta";test "$?" = 1 || exit 80\n'
  if kind=='machine':body+='printf stopped > "$CASE/machine-state"\n'
  if legacy:body+='rm "$OLD/disposable-resources-v1"\n'
  if corrupt:body+='sed -i s/fixture/foreign/ "$OLD/disposable-delete-'+kind+'-'+('abcd1234'if kind=='machine'else'vol_owned')+'.json"\n'
  if malformed:body+='printf malformed > "$OLD/disposable-resources-v1"\n'
  if latch:body+='touch "$OLD/guest-cleanup-unconfirmed"\n'
  if never:body+='HOLD=0;SOFT=absent\n'
  body+='FLEET_OWNER_TOKEN=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;FLEET_REGISTRY_DIR="$FLEET_OWNERSHIP_ROOT/$FLEET_OWNER_TOKEN"\nDISPOSABLE_REAP=0\n'
  body+=('fleet_reap_registry_record "$OLD" forced 2 0 "$OLD/clones/cloudbench-fixture"'if forced else'reconcile_stale_fleet_registries')+'\n'
  return mod['Disposable']().run_case(body)
 def test_dead_owner_stale_machine_get_only(self):
  r,v,c=self.run_case();self.assertNotEqual(r.returncode,0);self.assertEqual(v['calls'].splitlines(),['machine destroy --force abcd1234 -a fixture']);self.assertEqual(len(c),1)
 def test_dead_owner_deferred_volume_get_only(self):
  r,v,c=self.run_case(kind='volume');self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(sum(x.startswith('volumes destroy ')for x in v['calls'].splitlines()),1);self.assertTrue(any(x.startswith('volumes show ')for x in v['calls'].splitlines()));self.assertEqual(len(c),1)
 def test_forced_record_honors_original_once(self):
  r,v,c=self.run_case(forced=True);self.assertNotEqual(r.returncode,0);self.assertEqual(len(v['calls'].splitlines()),1)
 def test_legacy_neighbor_keeps_its_reconciliation_policy(self):
  r,v,c=self.run_case(legacy=True);self.assertGreater(len(v['calls'].splitlines()),1)
 def test_corrupt_original_once_never_dispatches_again(self):
  r,v,c=self.run_case(corrupt=True);self.assertNotEqual(r.returncode,0);self.assertEqual(len(v['calls'].splitlines()),1)
 def test_invalid_marker_never_falls_back_to_retry(self):
  r,v,c=self.run_case(malformed=True);self.assertNotEqual(r.returncode,0);self.assertEqual(len(v['calls'].splitlines()),1)
 def test_guest_latch_remains_guarded(self):
  r,v,c=self.run_case(latch=True);self.assertEqual(r.returncode,0);self.assertEqual(len(v['calls'].splitlines()),1);self.assertEqual(len(c),1)
 def test_dead_typed_owner_never_dispatched_can_delete_once(self):
  r,v,c=self.run_case(never=True);self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(v['calls'].splitlines(),['machine destroy --force abcd1234 -a fixture','volumes destroy vol_owned -a fixture --yes']);self.assertEqual(c,[])
if __name__=='__main__':unittest.main()
