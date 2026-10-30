"""Offline owning-path controls for a replaced preconfiguration primary."""
import copy
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(os.environ.get('R122_SOURCE_ROOT', Path(__file__).resolve().parents[2]))
HELPER = ROOT / 'scripts/cloudbench-startup-failure-archive.py'
FLEET = ROOT / 'scripts/run-bench-fleet'
OWNER, OLD, CURRENT, DONOR = 'a'*32, '1'*14, '2'*14, '3'*14


def function(name):
    return re.search(r'^'+name+r'\(\).*?(?=^[A-Za-z_][A-Za-z_0-9]*\(\)|\Z)', FLEET.read_text(), re.M|re.S).group()


class ReplacedPreconfig(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.registry = self.root/'owners'/OWNER
        self.audit = self.root/'audits'/OWNER
        self.run = self.root/'runs'/'original-run'
        self.task = self.run/'browser-fixture'
        self.old = self.task/('host-replaced-'+OLD)
        self.module = runpy.run_path(str(HELPER))
        self.write(self.registry/'meta', '\n'.join(f'{k}={v}' for k,v in dict(version=2, fleet_owner_token=OWNER,run_id='original-run',runs_root=self.run.parent,audit_dir=self.audit,app='fixture',cleanup_policy='retain').items())+'\n')
        self.write(self.audit/'meta', f'fleet_owner_token={OWNER}\nrun_id=original-run\napp=fixture\n')
        for mid in (OLD,CURRENT):
            name='cloudbench-'+mid
            values=dict(version=1,fleet_owner_token=OWNER,run_id='original-run',app='fixture',clone_name=name,source='fresh-clone',source_machine_id=DONOR,machine_id=mid,volume_id='vol_'+mid,disposition='owned')
            self.write(self.audit/'fresh'/name, '\n'.join(f'{k}={v}' for k,v in values.items())+'\n')
            self.write(self.audit/'expected-fresh'/name,f'clone_name={name}\nsource_machine_id={DONOR}\n')
            self.write(self.audit/'by-machine-id'/mid,name+'\n')
            self.write(self.registry/'clones'/name,f'name={name}\nid={mid}\nvolume_id=vol_{mid}\n')
        self.write(self.registry/'guest-cleanup-unconfirmed','')
        self.write(self.registry/'runtime-evidence-unconfirmed','')
        self.write(self.task/'.cid','clone '+CURRENT+'\n')
        self.write(self.task/'boot-config-host-replaced',OLD+'\n')
        self.write(self.task/'worker-clones.ids','')
        self.write(self.task/'status-proxy.port','8808\n')
        self.write(self.task/'runtime-evidence.owner.json',json.dumps(dict(version=1,machine_id=CURRENT,run_token=OWNER+'-0')))
        self.write(self.task/'runtime-evidence.pending',(self.task/'runtime-evidence.owner.json').read_text())
        self.write(self.old/'.cid','clone '+OLD+'\n')
        for name in ('boot-config-host-unresponsive','boot-config-unapplied'):self.write(self.old/name,OLD+'\n')
        self.write(self.old/'benchmark-child.finished','125\n')
        for name in ('runtime-evidence.owner.json','runtime-evidence.pending'):
            self.write(self.old/name,json.dumps(dict(version=1,machine_id=OLD,run_token=OWNER+'-0')))
        contract=runpy.run_path(str(ROOT/'scripts/cloudbench_execution_provenance.py'))
        matrix=contract['build_task_matrix']([self.task.name+'=real'])
        config=contract['build_config'](contract['CONFIG_SCHEMA_VERSION'],['task_matrix_sha256='+matrix['sha256'],'task_count=1'])
        source=dict(schema_version=contract['EXECUTION_SCHEMA_VERSION'],base_sha='d'*40,workspace_patch_sha256='none',controller_snapshot=dict(schema_version=contract['SNAPSHOT_SCHEMA_VERSION'],sha256='f'*64),config=config)
        self.write(self.run/'execution-task-matrix.json',json.dumps(matrix))
        batch=dict(status='failed',controller_exit_code=1,run_id='original-run',execution_provenance=source)
        for name in ('run.json','lifecycle.json'):self.write(self.run/'_batch'/name,json.dumps(batch))
        self.write(self.run/'_batch/benches.json',json.dumps([dict(name=self.task.name,mode='REAL')]))
        self.write(self.run/'execution-provenance.json',json.dumps(source))
        self.native=dict(id=OLD,name='cloudbench-'+OLD,state='started',instance_id='original-instance',config=dict(init={'cmd':['sleep','infinity']},env={},restart={'policy':'no'},image='fixture@sha256:'+'e'*64,mounts=[dict(volume='vol_'+OLD,path='/data')],files=[]))
        self.write(self.root/'native.json',json.dumps(self.native))
        self.base=self.old/'failed-preconfig-runtime-archive'
        self.base.mkdir(mode=0o700)

    def write(self,p,data):
        p.parent.mkdir(parents=True,exist_ok=True);p.write_text(data)

    def planner(self):
        body=function('fleet_registry_build_guest_recovery_plan')
        code=body.split("<<'PY'\n",1)[1].split('\nPY\n}',1)[0]
        out=self.root/'plan.tsv'
        args=[sys.executable,'-',str(self.registry),str(out),'fixture',str(self.audit.parent),'','',str(HELPER)]
        result=subprocess.run(args,input=code,text=True,capture_output=True)
        return result,out

    def consume(self, mutation=None):
        if mutation:self.write(self.root/'native.json',json.dumps(mutation))
        result,plan=self.planner()
        if result.returncode:return result
        names=['fleet_registry_build_guest_recovery_plan','fleet_has_replaced_preconfig','fleet_has_replaced_preconfig_phase','fleet_recovery_verify_replaced_preconfig','fleet_recovery_confirm_replaced_preconfig','fleet_replaced_preconfig_verify_before_reap']
        body='\n'.join(function(name) for name in names)
        body+='\nregistry_meta_value(){ sed -n "s/^$2=//p" "$1"; }\nfleet_preconfig_native_read(){ cp "$CASE/native.json" "$2"; }\n'
        body+='fleet_recovery_confirm_replaced_preconfig "$REGISTRY" "$PLAN"\n'
        env=dict(os.environ,CASE=str(self.root),REGISTRY=str(self.registry),PLAN=str(plan),STARTUP_FAILURE_ARCHIVE_HELPER=str(HELPER),APP="fixture",FLEET_AUDIT_ROOT=str(self.audit.parent))
        return subprocess.run(['bash','-e','-c',body],env=env,text=True,capture_output=True)

    def test_complete_member_phase_keeps_current_obligations(self):
        result=self.consume();self.assertEqual(result.returncode,0,result.stderr)
        self.assertFalse((self.old/'runtime-evidence.pending').exists())
        self.assertTrue((self.task/'runtime-evidence.pending').exists())
        self.assertTrue((self.registry/'guest-cleanup-unconfirmed').exists())
        self.assertTrue((self.registry/'runtime-evidence-unconfirmed').exists())
        self.assertFalse((self.old/'guest-shutdown.confirmed').exists())
        self.assertFalse((self.old/'status-proxy.port').exists())
        self.assertFalse((self.registry/'preconfig-evidence-consumed').exists())
        proof=json.loads((self.base/'consumed.json').read_text())
        self.assertEqual(proof['proof_credit'],0);self.assertFalse(proof['runtime_evidence_complete'])
        self.assertFalse(proof['native_release_verified']);self.assertEqual(proof['bench'],self.task.name)
        again=self.consume();self.assertEqual(again.returncode,0,again.stderr)

    def test_planner_preserves_two_obligations(self):
        result,plan=self.planner();self.assertEqual(result.returncode,0,result.stderr)
        rows=[x.split('\t') for x in plan.read_text().splitlines()]
        self.assertEqual({(r[0],r[3]) for r in rows},{('guest',CURRENT),('replaced-preconfig',OLD)})
        self.assertEqual(next(r[6] for r in rows if r[3]==OLD),'0')

    def test_native_applied_or_changed_refuses_before_pending_consumption(self):
        for field in ('env','init','mounts','image'):
            with self.subTest(field=field):
                value=copy.deepcopy(self.native)
                value['config'][field]={'RUN_TOKEN':OWNER+'-0'} if field=='env' else {'cmd':['run-agent']} if field=='init' else [{'volume':'vol_foreign','path':'/data'}] if field=='mounts' else 'not-digest'
                result=self.consume(value);self.assertNotEqual(result.returncode,0)
                self.assertTrue((self.old/'runtime-evidence.pending').exists())
                archive=self.base/'originals.tar.gz'
                if archive.exists():archive.unlink()

    def test_missing_and_foreign_marker_or_runtime_owner_refuse(self):
        for path,data in [(self.task/'boot-config-host-replaced',CURRENT),(self.old/'boot-config-unapplied',CURRENT),(self.old/'runtime-evidence.owner.json','{}'),(self.old/'benchmark-child.finished','0')]:
            before=path.read_bytes();path.write_text(data)
            result,_=self.planner();self.assertNotEqual(result.returncode,0)
            path.write_bytes(before)

    def test_symlink_extra_nested_and_worker_refuse(self):
        marker=self.task/'boot-config-host-replaced';value=marker.read_bytes();marker.unlink();marker.symlink_to(self.old/'boot-config-unapplied')
        self.assertNotEqual(self.planner()[0].returncode,0);marker.unlink();marker.write_bytes(value)
        extra=self.task/('host-replaced-'+'4'*14);extra.mkdir();self.assertNotEqual(self.planner()[0].returncode,0);extra.rmdir()
        (self.task/'worker-clones.ids').write_text('4'*14+'\n');self.assertNotEqual(self.planner()[0].returncode,0)

    def test_receipt_rejects_changed_parent_and_original(self):
        result=self.consume();self.assertEqual(result.returncode,0,result.stderr)
        for path,value in [(self.task/'.cid','clone '+'4'*14),(self.old/'benchmark-child.finished','0')]:
            before=path.read_bytes();path.write_text(value)
            with self.assertRaises((ValueError,KeyError,AssertionError)):self.module['replaced_preconfig_members'](self.registry,verified=True)
            path.write_bytes(before)

    def test_ordinary_single_primary_unchanged(self):
        shutil.rmtree(self.old);(self.task/'boot-config-host-replaced').unlink()
        for path in [self.registry/'clones'/('cloudbench-'+OLD),self.audit/'fresh'/('cloudbench-'+OLD),self.audit/'expected-fresh'/('cloudbench-'+OLD),self.audit/'by-machine-id'/OLD]:path.unlink()
        result,plan=self.planner();self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(len(plan.read_text().splitlines()),1)

    def reconnect(self, ack=True):
        names=['fleet_registry_build_guest_recovery_plan','fleet_has_replaced_preconfig','fleet_has_replaced_preconfig_phase','fleet_recovery_verify_replaced_preconfig','fleet_recovery_confirm_replaced_preconfig','fleet_replaced_preconfig_verify_before_reap','fleet_registry_confirm_guest_teardown','fleet_recovery_reconnect_guest_shutdowns']
        body='\n'.join(function(name) for name in names)
        body+=r'''
registry_meta_value(){ sed -n "s/^$2=//p" "$1"; }
cloudbench_fsync_directory(){ return 0; }
fly_with_timeout(){ return 1; }
cleanup_stale_owner_recovery_proxies(){ return 0; }
fleet_preconfig_native_read(){ test "$1" = "$OLD" || return 99; cp "$CASE/native.json" "$2"; }
registry_machine_details(){ test "$1" = "$CURRENT" || return 98; printf 'started cloudbench-%s 127.0.0.1\n' "$CURRENT"; }
machine_guest_recovery_configuration(){ test "$1" = "$CURRENT" || return 97; printf 'barrier\t%s-0\t8808\n' "$OWNER"; }
claim_recovery_status_proxy_ports(){ test "$2" = 1 || return 96; echo 8808 > "$1"; }
start_data_plane_proxy(){ printf -v "$5" '%s' "$$"; }
cloudbench_confirm_guest_shutdowns(){
 test "${#CHILD_OUT[@]}" = 1 && test "${CHILD_OUT[0]}" = "$TASK" || return 95
 test ! -e "$OLD_OUTPUT/runtime-evidence.pending" || return 94
 test -f "$OLD_OUTPUT/failed-preconfig-runtime-archive/consumed.json" || return 93
 test "$ACK" = 1 || return 1
 printf '%s\n' "$RUN_ID" > "$TASK/guest-shutdown.confirmed"
}
cloudbench_recover_guest_cleanup_receipts(){ return 1; }
fleet_recovery_reconnect_guest_shutdowns "$REGISTRY"
'''
        (self.task/'remote-logs/runtime-evidence').mkdir(parents=True,exist_ok=True)
        env=dict(os.environ,CASE=str(self.root),REGISTRY=str(self.registry),STARTUP_FAILURE_ARCHIVE_HELPER=str(HELPER),APP='fixture',FLEET_AUDIT_ROOT=str(self.audit.parent),OLD=OLD,CURRENT=CURRENT,OWNER=OWNER,OLD_OUTPUT=str(self.old),TASK=str(self.task),ACK=str(int(ack)),CLOUDBENCH_SCRIPT_SNAPSHOT=str(ROOT/'scripts'))
        return subprocess.run(['bash','-c',body],env=env,text=True,capture_output=True)

    def test_actual_reconnect_requires_current_ack_after_old_phase(self):
        result=self.reconnect(ack=False);self.assertNotEqual(result.returncode,0)
        self.assertFalse((self.old/'runtime-evidence.pending').exists())
        self.assertTrue((self.registry/'guest-cleanup-unconfirmed').exists())
        self.assertTrue((self.registry/'runtime-evidence-unconfirmed').exists())
        result=self.reconnect(ack=True);self.assertEqual(result.returncode,0,result.stderr)
        self.assertFalse((self.registry/'guest-cleanup-unconfirmed').exists())
        self.assertTrue((self.registry/'runtime-evidence-unconfirmed').exists())
        self.assertTrue((self.task/'runtime-evidence.pending').exists())
        self.assertFalse((self.old/'guest-shutdown.confirmed').exists())

    def test_actual_reconnect_refuses_applied_old_configuration(self):
        native=copy.deepcopy(self.native);native['config']['env']={'ADMITTED':'yes'}
        self.write(self.root/'native.json',json.dumps(native))
        result=self.reconnect();self.assertNotEqual(result.returncode,0)
        self.assertTrue((self.old/'runtime-evidence.pending').exists())
        self.assertFalse((self.task/'guest-shutdown.confirmed').exists())

    def test_actual_reaper_rechecks_native_and_whole_mapping(self):
        result=self.consume();self.assertEqual(result.returncode,0,result.stderr)
        names=['fleet_registry_build_guest_recovery_plan','fleet_has_replaced_preconfig','fleet_has_replaced_preconfig_phase','fleet_recovery_verify_replaced_preconfig','fleet_replaced_preconfig_verify_before_reap']
        body='\n'.join(function(name) for name in names)
        body+='\nregistry_meta_value(){ sed -n "s/^$2=//p" "$1"; }\nfleet_preconfig_native_read(){ cp "$CASE/native.json" "$2"; }\nfleet_replaced_preconfig_verify_before_reap "$REGISTRY" "$OLD" "vol_$OLD" started\n'
        env=dict(os.environ,CASE=str(self.root),REGISTRY=str(self.registry),OLD=OLD,STARTUP_FAILURE_ARCHIVE_HELPER=str(HELPER),APP='fixture',FLEET_AUDIT_ROOT=str(self.audit.parent))
        result=subprocess.run(['bash','-c',body],env=env,text=True,capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr)
        absent=body.replace('"vol_$OLD" started', '"vol_$OLD" absent')
        result=subprocess.run(['bash','-c',absent],env=env,text=True,capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr)
        native=copy.deepcopy(self.native);native['instance_id']='reused-instance'
        self.write(self.root/'native.json',json.dumps(native))
        result=subprocess.run(['bash','-c',body],env=env,text=True,capture_output=True)
        self.assertNotEqual(result.returncode,0)
        (self.task/'boot-config-host-replaced').unlink()
        result=subprocess.run(['bash','-c',body],env=env,text=True,capture_output=True)
        self.assertNotEqual(result.returncode,0)

    def test_final_runtime_latch_waits_for_both_phases_and_revalidates(self):
        result=self.consume();self.assertEqual(result.returncode,0,result.stderr)
        names=['fleet_registry_build_guest_recovery_plan','fleet_has_replaced_preconfig','fleet_has_replaced_preconfig_phase','fleet_recovery_verify_replaced_preconfig','cloudbench_collect_remaining_runtime_evidence']
        body='\n'.join(function(name) for name in names)
        body+=r'''
registry_meta_value(){ sed -n "s/^$2=//p" "$1"; }
cloudbench_fsync_directory(){ return 0; }
cloudbench_validate_primary_runtime_evidence(){ return 0; }
cloudbench_validate_worker_evidence_coverage(){
 if [ "$TAMPER" = 1 ]; then echo altered > "$OLD_OUTPUT/benchmark-child.finished"; fi
 return 0
}
cloudbench_retain_runtime_evidence(){ return 0; }
CHILD_OUT=("$TASK");CHILD_MACHINE=("$CURRENT")
cloudbench_collect_remaining_runtime_evidence
'''
        env=dict(os.environ,REGISTRY=str(self.registry),FLEET_REGISTRY_DIR=str(self.registry),FLEET_REGISTRY_PUBLISHED='1',FLEET_OWNER_TOKEN=OWNER,TASK=str(self.task),CURRENT=CURRENT,OLD_OUTPUT=str(self.old),STARTUP_FAILURE_ARCHIVE_HELPER=str(HELPER),APP='fixture',FLEET_AUDIT_ROOT=str(self.audit.parent))
        result=subprocess.run(['bash','-c',body],env=env,text=True,capture_output=True)
        self.assertNotEqual(result.returncode,0);self.assertTrue((self.registry/'runtime-evidence-unconfirmed').exists())
        (self.task/'runtime-evidence.pending').unlink()
        result=subprocess.run(['bash','-c',body],env=dict(env,TAMPER='1'),text=True,capture_output=True)
        self.assertNotEqual(result.returncode,0);self.assertTrue((self.registry/'runtime-evidence-unconfirmed').exists())
        self.write(self.old/'benchmark-child.finished','125\n')
        result=subprocess.run(['bash','-c',body],env=env,text=True,capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr);self.assertFalse((self.registry/'runtime-evidence-unconfirmed').exists())

    def test_partial_retirement_preserves_other_identity(self):
        result=self.consume();self.assertEqual(result.returncode,0,result.stderr)
        for mid in (OLD,CURRENT):
            record=self.audit/'fresh'/('cloudbench-'+mid)
            original=record.read_text();record.write_text(original.replace('disposition=owned','disposition=destroyed-provider-retained'))
            clone=self.registry/'clones'/('cloudbench-'+mid);data=clone.read_bytes();clone.unlink()
            result,_=self.planner();self.assertEqual(result.returncode,0,result.stderr)
            self.module['replaced_preconfig_members'](self.registry,verified=True)
            record.write_text(original);clone.write_bytes(data)

    def test_anchor_prevents_erasing_consumed_member(self):
        result=self.consume();self.assertEqual(result.returncode,0,result.stderr)
        hidden=self.root/'hidden-original';self.old.rename(hidden)
        (self.task/'boot-config-host-replaced').unlink()
        with self.assertRaises(ValueError):self.module['replaced_preconfig_members'](self.registry,verified=True)

    def test_changed_native_pair_never_commits(self):
        self.module['capture_preconfig'](self.registry,self.old,OLD,OWNER+'-0',self.base/'originals.tar.gz')
        self.write(self.base/'before.json',json.dumps(self.native))
        changed=copy.deepcopy(self.native);changed['instance_id']='another-incarnation'
        self.write(self.base/'after.json',json.dumps(changed))
        with self.assertRaises(ValueError):
            self.module['commit_preconfig'](self.registry,self.old,OLD,OWNER+'-0',self.base/'originals.tar.gz',self.base/'before.json',self.base/'after.json',self.base/'consumed.json')
        self.assertFalse((self.base/'consumed.json').exists())
        self.assertTrue((self.old/'runtime-evidence.pending').exists())

    def test_changed_audit_and_traversal_refuse(self):
        marker=self.task/'boot-config-host-replaced';before=marker.read_bytes();marker.write_text('../'+OLD)
        self.assertNotEqual(self.planner()[0].returncode,0);marker.write_bytes(before)
        fresh=self.audit/'fresh'/('cloudbench-'+CURRENT);before=fresh.read_text();fresh.write_text(before.replace(DONOR,'4'*14))
        self.assertNotEqual(self.planner()[0].returncode,0);fresh.write_text(before)
        self.write(self.audit/'fresh'/'duplicate', (self.audit/'fresh'/('cloudbench-'+OLD)).read_text())
        self.assertNotEqual(self.planner()[0].returncode,0)

    def normal_runtime(self):
        import hashlib
        base=self.task/'remote-logs/runtime-evidence'
        provenance=json.loads((self.run/'execution-provenance.json').read_text())
        result=dict(tasks=[dict(name=self.task.name,status='FAILED',passed=False,world_model_mode='real',execution_provenance=provenance)],summary=dict(total=1,passed=0,failed=1),execution_provenance=provenance)
        files={'services.json':json.dumps(dict(status='stopped',env=dict(worker_processes=2))).encode(),'run.json':json.dumps(result).encode(),'stack.log':b'original terminal stack\n','logs/backend.log':b'original backend\n','logs/worker.log':b'original worker\n','logs/worker.1.log':b'original worker 1\n','cloudbench-stack-cleanup-'+OWNER+'-0.status':('state=clean\ntoken='+OWNER+'-0\n').encode()}
        for name,data in files.items():
            path=base/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
        self.write(base/'manifest.json',json.dumps(dict(version=1,machine_id=CURRENT,run_token=OWNER+'-0',files={name:dict(bytes=len(data),sha256=hashlib.sha256(data).hexdigest()) for name,data in files.items()})))
        # No synthetic PASS: this valid normal bundle retains FAILED.
        snapshot=self.root/'runtime-helper';snapshot.mkdir(exist_ok=True)
        for name in ('cloudbench_execution_provenance.py','cloudbench_result.py','cloudbench_catalog.py'):
            shutil.copyfile(ROOT/'scripts'/name,snapshot/name)
        names=['fleet_registry_build_guest_recovery_plan','fleet_has_replaced_preconfig','fleet_has_replaced_preconfig_phase','fleet_recovery_verify_replaced_preconfig','cloudbench_retain_runtime_evidence','cloudbench_primary_runtime_evidence_prelaunch','cloudbench_validate_primary_runtime_evidence','cloudbench_validate_worker_evidence_coverage','cloudbench_collect_remaining_runtime_evidence','fleet_recovery_confirm_replaced_preconfig','fleet_recovery_prepare_replaced_preconfig','fleet_recovery_confirm_runtime_evidence']
        body='\n'.join(function(name) for name in names)+r'''
registry_meta_value(){ sed -n "s/^$2=//p" "$1"; }
cloudbench_fsync_directory(){ return 0; }
fleet_preconfig_native_read(){ cp "$CASE/native.json" "$2"; }
fleet_recovery_confirm_runtime_evidence "$REGISTRY"
'''
        env=dict(os.environ,CASE=str(self.root),REGISTRY=str(self.registry),FLEET_DIR=str(self.run),FLEET_OWNER_TOKEN=OWNER,STARTUP_FAILURE_ARCHIVE_HELPER=str(HELPER),APP='fixture',FLEET_AUDIT_ROOT=str(self.audit.parent),CLOUDBENCH_SCRIPT_SNAPSHOT=str(snapshot),RUN_ID='original-run')
        return body,env,base

    def test_actual_normal7_closes_runtime_only_with_valid_both_phases(self):
        result=self.reconnect();self.assertEqual(result.returncode,0,result.stderr)
        body,env,base=self.normal_runtime()
        # Lost current evidence refuses and retains the aggregate latch.
        original=(base/'logs/worker.log').read_bytes();(base/'logs/worker.log').write_bytes(b'changed')
        result=subprocess.run(['bash','-c',body],env=env,text=True,capture_output=True)
        self.assertNotEqual(result.returncode,0);self.assertTrue((self.registry/'runtime-evidence-unconfirmed').exists())
        (base/'logs/worker.log').write_bytes(original)
        # Lost old phase evidence also refuses, even with a valid normal7.
        receipt=self.base/'consumed.json';raw=receipt.read_bytes();receipt.unlink()
        result=subprocess.run(['bash','-c',body],env=env,text=True,capture_output=True)
        self.assertNotEqual(result.returncode,0);self.assertTrue((self.registry/'runtime-evidence-unconfirmed').exists())
        receipt.write_bytes(raw)
        result=subprocess.run(['bash','-c',body],env=env,text=True,capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertFalse((self.registry/'runtime-evidence-unconfirmed').exists())
        self.assertFalse((self.registry/'guest-cleanup-unconfirmed').exists())
        self.assertFalse((self.task/'runtime-evidence.pending').exists())
        self.assertFalse(json.loads((self.task/'cloudbench-run.json').read_text())['tasks'][0]['passed'])

    def test_normal_successful_replacement_does_not_require_recovery_phase(self):
        # Ordinary live completion follows its existing normal7/ACK contract;
        # it has never entered the failed-owner recovery phase.
        for name in ('run.json','lifecycle.json'):
            path=self.run/'_batch'/name;data=json.loads(path.read_text())
            data.update(status='completed',controller_exit_code=0)
            path.write_text(json.dumps(data))
        (self.registry/'guest-cleanup-unconfirmed').unlink()
        (self.task/'runtime-evidence.pending').unlink()
        self.write(self.task/'guest-shutdown.confirmed','original-run\n')
        body,env,_=self.normal_runtime()
        body=body.replace('fleet_recovery_confirm_runtime_evidence "$REGISTRY"', r'''
FLEET_REGISTRY_DIR="$REGISTRY";FLEET_REGISTRY_PUBLISHED=1
CHILD_OUT=("$TASK");CHILD_MACHINE=("$CURRENT")
cloudbench_collect_remaining_runtime_evidence
''')
        env.update(TASK=str(self.task),CURRENT=CURRENT,FLEET_TEARDOWN_OWNERSHIP_DIR=str(self.audit))
        result=subprocess.run(['bash','-c',body],env=env,text=True,capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertFalse((self.registry/'runtime-evidence-unconfirmed').exists())
        # The new per-member reaper guard must also be a no-op outside a
        # durably entered recovery phase, even when old producer markers exist.
        guard='\n'.join(function(name) for name in ('fleet_has_replaced_preconfig','fleet_has_replaced_preconfig_phase','fleet_recovery_verify_replaced_preconfig','fleet_replaced_preconfig_verify_before_reap'))
        guard+='\nregistry_meta_value(){ sed -n "s/^$2=//p" "$1"; }\nfleet_replaced_preconfig_verify_before_reap "$REGISTRY" "'+OLD+'" "vol_'+OLD+'" started\n'
        result=subprocess.run(['bash','-c',guard],env=env,text=True,capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertFalse((self.registry/'replaced-preconfig-phase.json').exists())
        self.assertTrue((self.old/'runtime-evidence.pending').exists())

    def test_old_worker_allocation_evidence_refuses_before_consumption_and_replay(self):
        for name in ('worker-clones.ids','worker-ready.ids'):
            path=self.old/name;self.write(path,'4'*14+'\n')
            result=self.consume();self.assertNotEqual(result.returncode,0)
            self.assertTrue((self.old/'runtime-evidence.pending').exists())
            self.assertFalse((self.base/'consumed.json').exists());path.unlink()
        result=self.consume();self.assertEqual(result.returncode,0,result.stderr)
        _,files,_=self.module['read_preconfig_archive'](self.base/'originals.tar.gz')
        for name in ('worker-clones.ids','worker-ready.ids'):
            changed=dict(files);changed['output/'+name]=b'44444444444444\n'
            with self.assertRaisesRegex(ValueError,'worker allocation evidence'):
                self.module['archived_preconfig_identity'](changed,self.registry,self.old,OLD,OWNER+'-0')
        self.write(self.old/'worker-clones.ids','4'*14+'\n')
        with self.assertRaisesRegex(ValueError,'worker allocation evidence'):
            self.module['replaced_preconfig_members'](self.registry,verified=True)

    def test_surviving_receipt_without_anchor_still_blocks_normal_cleanup(self):
        result=self.consume();self.assertEqual(result.returncode,0,result.stderr)
        (self.registry/'replaced-preconfig-phase.json').unlink()
        body,env,_=self.normal_runtime()
        (self.task/'runtime-evidence.pending').unlink()
        body=body.replace('fleet_recovery_confirm_runtime_evidence "$REGISTRY"', 'FLEET_REGISTRY_DIR="$REGISTRY"; FLEET_REGISTRY_PUBLISHED=1; CHILD_OUT=("$TASK"); CHILD_MACHINE=("$CURRENT"); cloudbench_collect_remaining_runtime_evidence')
        env.update(TASK=str(self.task),CURRENT=CURRENT,FLEET_TEARDOWN_OWNERSHIP_DIR=str(self.audit))
        result=subprocess.run(['bash','-c',body],env=env,text=True,capture_output=True)
        self.assertNotEqual(result.returncode,0)
        self.assertTrue((self.registry/'runtime-evidence-unconfirmed').exists())

    def already_acked_current(self):
        (self.registry/'guest-cleanup-unconfirmed').unlink()
        (self.task/'runtime-evidence.pending').unlink()
        self.write(self.task/'guest-shutdown.confirmed','original-run\n')
        meta=self.registry/'meta';meta.write_text(meta.read_text().replace('cleanup_policy=retain','cleanup_policy=reap'))
        return self.normal_runtime()

    def test_stale_already_acked_current_still_consumes_old_phase(self):
        body,env,_=self.already_acked_current()
        self.assertTrue((self.old/'runtime-evidence.pending').exists())
        self.assertFalse((self.registry/'replaced-preconfig-phase.json').exists())
        result=subprocess.run(['bash','-c',body],env=env,text=True,capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertFalse((self.old/'runtime-evidence.pending').exists())
        self.assertTrue((self.registry/'replaced-preconfig-phase.json').exists())
        self.assertFalse((self.registry/'runtime-evidence-unconfirmed').exists())
        self.assertFalse((self.old/'guest-shutdown.confirmed').exists())

    def test_stale_already_acked_current_rejects_unproven_old_phase(self):
        body,env,_=self.already_acked_current()
        native=copy.deepcopy(self.native);native['config']['env']={'RUN_TOKEN':'applied'}
        self.write(self.root/'native.json',json.dumps(native))
        result=subprocess.run(['bash','-c',body],env=env,text=True,capture_output=True)
        self.assertNotEqual(result.returncode,0)
        self.assertTrue((self.old/'runtime-evidence.pending').exists())
        self.assertTrue((self.registry/'runtime-evidence-unconfirmed').exists())
        self.assertFalse((self.registry/'replaced-preconfig-phase.json').exists())

if __name__=='__main__':unittest.main()
