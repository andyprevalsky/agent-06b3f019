#!/usr/bin/env python3
"""Owning create/retire decisions; provider boundaries are local filesystem fakes."""
from pathlib import Path
import json
import os
import re
import shlex
import subprocess
import tempfile
import unittest
from unittest import mock
SOURCE=Path(os.environ.get('CLOUDBENCH_TEST_FLEET_SOURCE',Path(__file__).resolve().parents[1]/'run-bench-fleet'))
def function(name):
 override={'fleet_reap_registry_record':'CLOUDBENCH_TEST_OLD_REAPER','fleet_release_cleanup_capacity':'CLOUDBENCH_TEST_OLD_CAPACITY_SOURCE'}.get(name)
 source=Path(os.environ[override]) if override and os.environ.get(override) else SOURCE
 m=re.search(r'^'+re.escape(name)+r'\(\).*?^}\n',source.read_text(),re.M|re.S);assert m,name;return m.group()
class Disposable(unittest.TestCase):
 def run_case(self,body,*,missing=False,disposable=True):
  with tempfile.TemporaryDirectory()as d:
   p=Path(d);reg=p/'owners'/('a'*32);(reg/'clones').mkdir(parents=True);(reg/'meta').write_text('version=2\n');(reg/'disposable-resources-v1').write_text('a'*32+'\nfixture\n');(reg/'clones/cloudbench-fixture').write_text('name=cloudbench-fixture\nid=abcd1234\nvolume_id=vol_owned\n')
   audit=p/'audit';run=p/'run';out=run/'task';out.mkdir(parents=True)
   for directory in ('fresh','expected-fresh','by-machine-id'):(audit/directory).mkdir(parents=True)
   def write(path,value):
    path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value) if isinstance(value,dict) else value)
   row=dict(version='1',fleet_owner_token='a'*32,run_id='run',app='fixture',clone_name='cloudbench-fixture',source='fresh-clone',source_machine_id='1234abcd',machine_id='abcd1234',volume_id='vol_owned',disposition='owned')
   write(audit/'fresh/cloudbench-fixture',''.join(k+'='+v+'\n' for k,v in row.items()))
   write(audit/'expected-fresh/cloudbench-fixture','clone_name=cloudbench-fixture\nsource_machine_id=1234abcd\n')
   write(audit/'by-machine-id/abcd1234','cloudbench-fixture\n')
   write(reg/'meta','version=2\nfleet_owner_token='+('a'*32)+'\nrun_id=run\napp=fixture\n')
   write(out/'autoscaler.pid','123|proc-start:1\n');write(out/'benchmark-child.finished','0\n');write(out/'autoscaler.completed-after-child','0\n');write(out/'worker-clones.ids','');write(out/'worker-ready.ids','')
   write(out/'.cid','clone abcd1234\n');write(out/'guest-shutdown.confirmed','run\n')
   token='a'*32+'-0';write(out/'runtime-evidence.owner.json',dict(machine_id='abcd1234',run_token=token))
   index=run/'.native-retirement-index'
   write(index/'owner.json',dict(owner='a'*32,run_id='run',catalog_sha256='b'*64))
   write(index/'ordinals/task',dict(name='task',ordinal=0,catalog_sha256='b'*64))
   write(index/'clones/cloudbench-fixture',dict(source='1234abcd',machine='abcd1234',volume='vol_owned',child_count=0))
   write(index/'machines/abcd1234','cloudbench-fixture\n');write(index/'volumes/vol_owned','cloudbench-fixture\n')
   for n in ('guest-cleanup-unconfirmed','runtime-evidence-unconfirmed'):
    if missing:(reg/n).touch()
   script='set -u\n'+''.join(function(n)for n in ('fleet_current_disposable_registry','fleet_disposable_registry_policy','fleet_disposable_delete_intent','fleet_retire_sealed_primary','fleet_disposable_resources_terminal','fleet_release_cleanup_capacity','capacity_release_owner_reservations','capacity_reserve_slots','reap_volume','reap_machine','fleet_validate_reap_cohort','fleet_reap_registry_record_native','fleet_reap_registry_record','reap_registry_clones','machine_creation_admission','provision_primary_machine'))+r'''
APP=fixture; FLEET_OWNER_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FLEET_OWNERSHIP_ROOT="$CASE/owners";FLEET_REGISTRY_DIR="$FLEET_OWNERSHIP_ROOT/$FLEET_OWNER_TOKEN"
GIT_COMMON_DIR="$CASE/common";mkdir -p "$GIT_COMMON_DIR"
RUN_ID=run;FLEET_DIR="$CASE/run";FLEET_TEARDOWN_OWNERSHIP_DIR="$CASE/audit"
FLEET_REGISTRY_PUBLISHED=1;KEEP_CLONES=0;FLEET_OWNER_HOST=fixture
FLEET_OWNER_PID_START="$(ps -p $$ -o lstart= | sed 's/^ *//;s/ *$//')"
CAPACITY_RESERVATION_ROOT="$CASE/capacity";CAPACITY_RESERVATION_PUBLISHED=1
CLOUDBENCH_FLEET_RUN_TOKEN="$FLEET_OWNER_TOKEN-0";AUTOSCALER_FINALIZATION_WAIT_SECONDS=1
cloudbench_pid_birth_state(){ echo absent; }
cloudbench_validate_primary_runtime_evidence(){ return 0; }
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
registry_machine_details(){ local s; s="$(cat "$CASE/machine-state")";[ "$s" != absent ]||return 1;printf '%s cloudbench-fixture\n' "$s"; }
volume_inventory_contains_id(){ local s;s="$(cat "$CASE/volume-state")";[ "$s" != absent ]||return 1;echo "$s"; }
registry_meta_value(){ sed -n "s/^$2=//p" "$1"; }
fleet_registry_reconcile_mounted_volume(){ echo vol_owned; }
fleet_audit_update_registry_clone(){ printf 'audit %s\n' "$*" >> "$CASE/audit-log"; }
fleet_with_native_reap_permit(){ "$@"; }
sleep(){ :; }
primary_vm_size_for_bench(){ echo shared-cpu-4x; }
primary_vm_memory_for_bench(){ echo 8192; }
bench_uses_default_pool_shape(){ return 0; }
claim_pool_machine(){ echo BORROWED >> "$CASE/claims";echo existing; }
clone_machine_target(){ machine_creation_admission "$1"||return $?;echo CREATE >> "$CASE/creates";echo new123; }
primary_clone_storage_mode(){ echo fresh; }
mkdir -p "$CASE/out"
'''.replace('MODE','1'if disposable else'0')+'source '+shlex.quote(str(SOURCE.parent/'lib/cloudbench-archived-reuse.sh'))+'\n'+body
   r=subprocess.run(['bash','-c',script],env=dict(os.environ,CASE=d),capture_output=True,text=True)
   read=lambda n:(p/n).read_text()if(p/n).exists()else''
   return r,{n:read(n)for n in ('calls','audit-log','claims','creates','out/.cid','capacity-result')},list((reg/'clones').iterdir()) if (reg/'clones').exists() else []
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
 def test_actual_early_sealed_retirement_then_final_never_replays_delete(self):
  r,v,records=self.run_case('FLEET_NATIVE_REAP_ENABLED=1;DISPOSABLE_REAP=0;HOLD=1;AMBIGUOUS=1;fleet_retire_sealed_primary "$FLEET_DIR/task";test -f "$FLEET_REGISTRY_DIR/disposable-delete-machine-abcd1234.json" || exit 99;reap_registry_clones "$FLEET_REGISTRY_DIR" current')
  self.assertNotEqual(r.returncode,0);self.assertEqual(v['calls'].splitlines(),['machine destroy --force abcd1234 -a fixture']);self.assertEqual(len(records),1)
 def capacity_case(self,*,pending=False,foreign=False):
  body=r'''
capacity_reserve_slots "$FLEET_OWNER_TOKEN-primary" 1 1 1 1 0 0 primary > "$CASE/first-admission" || exit 90
'''
  if not pending:
   body+='rm "$FLEET_REGISTRY_DIR/clones/cloudbench-fixture";sed -i s/disposition=owned/disposition=destroyed-verified-absent/ "$CASE/audit/fresh/cloudbench-fixture"\n'
  if foreign:body+='sed -i s/app=fixture/app=foreign/ "$CASE/audit/fresh/cloudbench-fixture"\n'
  body+=r'''
fleet_release_cleanup_capacity 1 1 || exit 91
capacity_reserve_slots "$FLEET_OWNER_TOKEN-next" 1 1 1 1 0 0 primary > "$CASE/capacity-result"
'''
  return self.run_case(body,missing=True)
 def test_failed_evidence_all_resources_gone_releases_and_next_admission(self):
  r,v,_=self.capacity_case();self.assertEqual(r.returncode,0,r.stderr);self.assertTrue(v['capacity-result'].startswith('OK '),v)
 def test_pending_disposal_preserves_capacity_reservation(self):
  r,v,_=self.capacity_case(pending=True);self.assertNotEqual(r.returncode,0);self.assertIn('DENY_MACHINE',v['capacity-result'])
 def test_foreign_terminal_audit_cannot_release_capacity(self):
  r,v,_=self.capacity_case(foreign=True);self.assertNotEqual(r.returncode,0);self.assertIn('DENY_MACHINE',v['capacity-result'])
 def test_explicit_keep_does_not_change_creation_policy(self):
  r,v,_=self.run_case('KEEP_CLONES=1;provision_primary_machine bench "$CASE/out"');self.assertEqual(r.returncode,0);self.assertEqual(v['claims'],'');self.assertEqual(v['creates'],'CREATE\n')
class CapacityMetadata(unittest.TestCase):
    def test_one_boot_and_pid_read_for_repeated_live_owner(self):
        import builtins, contextlib, io, sys

        code = function("capacity_reserve_slots").split("<<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
        boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        raw = Path(f"/proc/{os.getpid()}/stat").read_text()
        start = raw[raw.rfind(")") + 2 :].split()[19]
        owner = "e" * 32
        birth = f"proc-start:{boot}:{start}"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            records = root / "reservations"
            records.mkdir()
            for index in range(600):
                token = owner + "-worker-" + f"{index:032x}"
                (records / token).write_text(
                    f"version=1\napp=fixture\nhost=fixture\npid={os.getpid()}\npid_start={birth}\nrun_id=run\ntoken={token}\nfleet_owner_token={owner}\nmachine_slots=1\nshared_units=0\nkind=worker\n"
                )
            counts = {"boot": 0, "pid": 0}
            original = builtins.open

            def counted(path, *args, **kwargs):
                if str(path) == "/proc/sys/kernel/random/boot_id":
                    counts["boot"] += 1
                if str(path) == f"/proc/{os.getpid()}/stat":
                    counts["pid"] += 1
                return original(path, *args, **kwargs)

            argv = [
                "inline",
                str(root),
                owner + "-primary",
                "fixture",
                "fixture",
                str(os.getpid()),
                birth,
                "newrun",
                owner,
                str(root / "owners"),
                "1",
                "0",
                "1000",
                "1000",
                "0",
                "0",
                "primary",
            ]
            output = io.StringIO()
            with (
                mock.patch.object(sys, "argv", argv),
                mock.patch("builtins.open", side_effect=counted),
                contextlib.redirect_stdout(output),
            ):
                exec(compile(code, "capacity_reserve_slots", "exec"), {})
            self.assertEqual(output.getvalue().strip(), "OK 600 0 601 0")
            self.assertEqual(counts, {"boot": 1, "pid": 1})

    def test_all_capacity_calls_skip_unrelated_site_startup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "sitecustomize.py").write_text("import os\nos._exit(85)\n")
            names = (
                "capacity_reserve_slots",
                "capacity_release_reservation",
                "capacity_release_owner_reservations",
                "capacity_release_stale_owner_reservations",
            )
            script = (
                "set -eu\n"
                + "".join(function(name) for name in names)
                + r"""
APP=fixture;FLEET_OWNER_HOST=fixture;FLEET_OWNER_PID_START=fixture
FLEET_OWNER_TOKEN=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
FLEET_OWNERSHIP_ROOT="$CASE/owners";CAPACITY_RESERVATION_ROOT="$CASE/capacity";RUN_ID=run
registry_meta_value(){ case "$2" in pid) echo $$;;pid_start) echo fixture;;host) echo fixture;;fleet_owner_token) echo "$FLEET_OWNER_TOKEN";;esac; }
capacity_reserve_slots "$FLEET_OWNER_TOKEN-primary" 1 0 1000 1000 0 0 primary
capacity_release_reservation "$FLEET_OWNER_TOKEN-primary"
capacity_release_owner_reservations
capacity_release_stale_owner_reservations unused "$FLEET_OWNER_TOKEN-primary"
"""
            )
            result = subprocess.run(
                ["bash", "-c", script],
                env=dict(os.environ, PYTHONPATH=str(root), CASE=str(root)),
                text=True,
                capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "OK 0 0 1 0")
if __name__=='__main__':unittest.main()
