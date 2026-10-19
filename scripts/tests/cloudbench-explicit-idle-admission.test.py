#!/usr/bin/env python3
import copy
import base64
import ast
from unittest import mock
import fcntl
import importlib.util
import json
import os
import re
import runpy
import shutil
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'cloudbench-explicit-idle-admission.py'
spec=importlib.util.spec_from_file_location('admission',SCRIPT); mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)


class Admission(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.repo=self.root/'repo';self.repo.mkdir()
        for args in (['init','-q'],['-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','fixture']):
            subprocess.run(['git','-C',str(self.repo),*args],check=True,capture_output=True)
        self.common=self.repo/'.git';ref=subprocess.check_output(['git','-C',str(self.repo),'rev-parse','HEAD'],text=True).strip()
        self.mid='0123456789abcd';self.controller='11111111111111';self.vol='vol_fixture';self.nonce='a'*32;self.dep={'node':'b'*64,'python':'c'*64}
        self.resource=dict(app='app',machine_id=self.mid,name='cloudbench-idle',volume_id=self.vol,instance_id='instance',image_digest='sha256:'+'d'*64,shape={'cpu_kind':'shared','cpus':4,'memory_mb':8192})
        config=dict(image='image@'+self.resource['image_digest'],init={'cmd':['sleep','infinity']},env={},mounts=[{'volume':self.vol,'path':'/data'}],guest=self.resource['shape'],restart={'policy':'no'})
        self.resource['config_sha256']=mod.sha(mod.canonical(config))
        native=dict(id=self.mid,name='cloudbench-idle',instance_id='instance',state='stopped',config=config,image_ref={'digest':self.resource['image_digest']})
        self.counter=0
        def save(value):
            self.counter+=1;p=self.root/f'evidence-{self.counter}.json';p.write_bytes(mod.canonical(value));return mod.descriptor(p)
        self.save=save
        actual_controller=json.loads(SCRIPT.with_name('tests').joinpath('explicit-idle-controller-init.fixture.json').read_text())
        control_config=dict(init=actual_controller['init'],mounts=[{'volume':'vol_controller','path':'/data'}],restart={'policy':'no'},rootfs=actual_controller['rootfs'])
        ctrl=dict(id=self.controller,state='started',instance_id='controller-instance',config=control_config)
        own=dict(schema='cloudbench-controller-workspace-ownership-v1',volume_id='vol_controller',app='app',mount_path='/data')
        own_desc=save(own)
        target=dict(machine=self.controller,volume='vol_controller',workspace=str(self.repo),common=str(self.common),source_ref=ref,ownership_sha256=own_desc['sha256'],controller_config_sha256=mod.sha(mod.canonical(control_config)),preservation='rootfs-always',pool_name='repo-sourcehash.cold.ids',pool_ids_file=str(self.common/'cloudbench-pools/repo-sourcehash.cold.ids'),pool_meta_file=str(self.common/'cloudbench-pools/repo-sourcehash.cold.ids.deps'),dependencies=self.dep)
        ready=dict(id='vs_snapshot',status='created',created_at='2026-10-16T00:00:00Z',size=100,digest='e'*64)
        scan=dict(kind='exact-inert-quiescence-v1',machine=self.mid,nonce=self.nonce,boot='01234567-1234-1234-1234-123456789abc',unknown=[],inert_sleepers=[{'pid':1,'birth':'1'}],idle_pinned_agents=[],idle_platform_hallpass=[],observed_epoch=1)
        obs=dict(schema='cloudbench-explicit-idle-observation-v1',origin=mod.ORIGIN,machine_id=self.mid,native_instance='instance',admission_nonce=self.nonce,historical_task_credit=0,collector_sha256=mod.sha(SCRIPT.read_bytes()),predicate_sha256=mod.sha(mod.billing_predicate().encode()),workspace={'kind':'existing-git','head':'f'*40,'status_sha256':'1'*64},data_mount={'device':1,'inode':2,'mount_device':'1:1'},dependencies=self.dep,before=scan,after=dict(scan,observed_epoch=2),started_epoch=1,finished_epoch=2)
        obs_desc=save(obs)
        self.request=dict(schema='cloudbench-explicit-idle-request-v1',origin=mod.ORIGIN,historical_task_credit=0,admission_nonce=self.nonce,allowed_future_roles=['primary','worker'],resource=self.resource,consumer=target,controller_before=save(ctrl),controller_after=save(ctrl),workspace_ownership=own_desc,native_before=save(native),native_after=save(native),volume=save(dict(id=self.vol,attached_machine_id=self.mid,state='created')),protected_overlay=save(dict(machines=[self.controller],volumes=['vol_controller'])),preservation=dict(snapshot_id='vs_snapshot',receipt=save(dict(volume_id=self.vol,snapshot_id='vs_snapshot',available=ready,machine_id=self.mid,source_instance='instance',source_config_sha256=self.resource['config_sha256'],capture_state='stopped',verified_epoch=0)),available_read=save(dict(volume_id=self.vol,snapshots=[ready]))),observation=obs_desc,observer_terminal=save(dict(status='OBSERVED_AND_STOPPED',machine_id=self.mid,admission_nonce=self.nonce,observation_sha256=obs_desc['sha256'],finished_epoch=3)),workspace_policy='existing-git-reset-v1')
        self.env=dict(CLOUDBENCH_SCRIPT_SNAPSHOT=str(SCRIPT.parent),FLY_MACHINE_ID=self.controller,FLY_APP_NAME='app',CLOUDBENCH_IDLE_WORKSPACE=str(self.repo),CLOUDBENCH_IDLE_COMMON=str(self.common),CLOUDBENCH_IDLE_POOL_IDS=target['pool_ids_file'],CLOUDBENCH_IDLE_POOL_META=target['pool_meta_file'])
        self.old_env={k:os.environ.get(k) for k in self.env};os.environ.update(self.env);self.addCleanup(self.restore_env)
    def restore_env(self):
        for k,v in self.old_env.items():
            if v is None:os.environ.pop(k,None)
            else:os.environ[k]=v
    def changed(self,key,modify):
        req=copy.deepcopy(self.request);value=mod.described(req[key]);modify(value);req[key]=self.save(value);return req
    def test_existing_git_is_supported_without_fake_history(self):
        self.assertEqual(mod.validate_request(self.request)['id'],self.mid)
        self.assertEqual(self.request['historical_task_credit'],0)
    def test_empty_checkout_uses_distinct_bootstrap_policy(self):
        req=self.changed('observation',lambda x:x.update(workspace={'kind':'empty'}));req['workspace_policy']='real-empty-bootstrap-v1';term=mod.described(req['observer_terminal']);term['observation_sha256']=req['observation']['sha256'];req['observer_terminal']=self.save(term)
        self.assertEqual(mod.validate_request(req)['id'],self.mid)
    def test_native_identity_mismatch(self):
        req=self.changed('native_after',lambda x:x.update(instance_id='other'))
        with self.assertRaises(ValueError):mod.validate_request(req)
    def test_protected_machine(self):
        req=self.changed('protected_overlay',lambda x:x['machines'].append(self.mid))
        with self.assertRaises(ValueError):mod.validate_request(req)
    def test_snapshot_wrong_volume(self):
        req=copy.deepcopy(self.request);req['preservation']['available_read']=self.save({'volume_id':'vol_other','snapshots':[]})
        with self.assertRaises(ValueError):mod.validate_request(req)
    def test_unknown_guest_work_refuses(self):
        req=self.changed('observation',lambda x:x['before']['unknown'].append({'pid':42}))
        with self.assertRaises(ValueError):mod.validate_request(req)
    def test_dependency_mismatch(self):
        req=self.changed('observation',lambda x:x['dependencies'].update(node='0'*64))
        with self.assertRaises(ValueError):mod.validate_request(req)
    def test_no_root_authority(self):
        with self.assertRaises((ValueError,FileNotFoundError)):mod.authorize(self.root/'missing','0'*64,self.request,'0'*64,0)
    def test_changed_image_shape_and_mount_refuse(self):
        for field,value in (('image_digest','sha256:'+'0'*64),('shape',{'cpu_kind':'shared','cpus':1,'memory_mb':4096})):
            req=copy.deepcopy(self.request);req['resource'][field]=value
            with self.assertRaises(ValueError):mod.validate_request(req)
        req=self.changed('observation',lambda x:x.update(data_mount={'device':0,'inode':2,'mount_device':'1:1'}))
        with self.assertRaises(ValueError):mod.validate_request(req)
    def test_nonempty_workspace_cannot_claim_empty_bootstrap(self):
        req=copy.deepcopy(self.request);req['workspace_policy']='real-empty-bootstrap-v1'
        with self.assertRaises(ValueError):mod.validate_request(req)
    def test_identical_or_same_inode_native_pair_refuses_before_read(self):
        req=copy.deepcopy(self.request);req['native_after']=dict(req['native_before'])
        with self.assertRaises(ValueError):mod.validate_request(req)
        req['native_after']=dict(req['native_before'],path=str(self.root/'different-name'))
        with self.assertRaises(ValueError):mod.validate_request(req)
    def test_actual_gate_init_controller_uses_separate_explicit_endpoint(self):
        mod.validate_consumer(self.request)
        old=mod.sibling('cloudbench-startup-failure-archive.py')['capture_cold_handoff_target']
        target=self.request['consumer']
        with self.assertRaisesRegex(ValueError,'not exact inert maintenance controller'):old(target['workspace'],target['common'],self.request['controller_before']['path'],self.request['controller_after']['path'],self.request['workspace_ownership']['path'],target['source_ref'],target['pool_name'])
    def test_controller_identity_config_and_pair_mismatch_refuse(self):
        req=copy.deepcopy(self.request);req['controller_after']=dict(req['controller_before'])
        with self.assertRaises(ValueError):mod.validate_consumer(req)
        req=copy.deepcopy(self.request);req['consumer']['machine']='22222222222222'
        with self.assertRaises(ValueError):mod.validate_consumer(req)
        req=copy.deepcopy(self.request);req['consumer']['controller_config_sha256']='0'*64
        with self.assertRaises(ValueError):mod.validate_consumer(req)
    def authority(self):
        req=self.root/'request.json';req.write_bytes(mod.canonical(self.request));lock=self.root/'custody.lock';lock.touch(mode=0o600);fd=os.open(lock,os.O_RDWR);fcntl.flock(fd,fcntl.LOCK_EX);self.addCleanup(os.close,fd)
        value=dict(schema='explicit-idle-authority-v1',consumer=self.request['consumer'],app='app',machine_id=self.mid,volume_id=self.vol,admission_nonce=self.nonce,request_sha256=mod.sha(req.read_bytes()),coordinator_thread='test-coordinator',custody_lock=str(lock),protected_overlay={k:self.request['protected_overlay'][k] for k in ('path','sha256')},sole_operator=True,old_actors_joined=True,historical_task_credit=0,allowed_operations=['observe','same-config-start','stop','publish-pool'])
        auth=self.root/'authority.json';auth.write_bytes(mod.canonical(value));auth.chmod(0o600)
        return req,auth,fd
    def fleet_dispatch_fixture(self):
        fleet=SCRIPT.with_name('run-bench-fleet').read_text()
        start=fleet.index('while [ $# -gt 0 ]; do',fleet.index('CAPACITY_RESERVATION_ROOT='))
        parser=fleet[start:fleet.index('\ndone\n',start)+6]
        start=fleet.index('if [ "$RECOVER_STALE_ONLY" = "1" ] && [ -z "$COLD_HANDOFF_REQUEST" ]')
        guard=fleet[start:fleet.index('\nfi\n',start)+4]
        start=fleet.index('if [ "${#EXPLICIT_IDLE_ARGS[@]}" -gt 0 ]; then')
        dispatch=fleet[start:fleet.index('\nfi\n',start)+4]
        path=self.root/'actual-fleet-dispatch.sh'
        path.write_text('''set -uo pipefail
EXPLICIT_IDLE_ARGS=(); RECOVER_STALE_ONLY=0; RECOVER_OWNER_TOKEN=; COLD_HANDOFF_REQUEST=
ROOT_DIR="$FIXTURE_REPO"; GIT_COMMON_DIR="$FIXTURE_COMMON"; APP=app
POOL_IDS_FILE="$FIXTURE_POOL"; POOL_META_FILE="$FIXTURE_POOL.deps"
LOCK_DIR="$FIXTURE_COMMON/fixture-controller-lock"
cloudbench_controller_lock_release() { printf released > "$FIXTURE_COMMON/lock-released"; }
'''+parser+'\n'+guard+'\n'+dispatch+'\nprintf recovery-token-accepted\n')
        return path
    @unittest.skipUnless(os.geteuid()==0,'root publication boundary; execute this registered test as root')
    def test_actual_cli_admission_dispatch_reaches_canonical_publisher(self):
        request,authority,fd=self.authority();dispatch=self.fleet_dispatch_fixture()
        env={**os.environ,'RUN_BENCH_FLEET_BIN_UNDER_TEST':str(dispatch),'FIXTURE_REPO':str(self.repo),'FIXTURE_COMMON':str(self.common),'FIXTURE_POOL':self.request['consumer']['pool_ids_file']}
        result=subprocess.run(['bash',str(SCRIPT.with_name('run-bench')),'--admit-existing-idle',str(request),mod.sha(request.read_bytes()),str(authority),mod.sha(authority.read_bytes()),str(fd)],env=env,pass_fds=(fd,),capture_output=True,text=True,timeout=15)
        if result.returncode:
            self.assertFalse(Path(self.request['consumer']['pool_ids_file']).exists(),'refused CLI must not publish')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout)['status'],'COMPLETE')
        self.assertEqual(Path(self.request['consumer']['pool_ids_file']).read_text(),self.mid+'\n')
        self.assertEqual((self.common/'lock-released').read_text(),'released')
    def test_actual_cli_invalid_recovery_token_still_refuses(self):
        dispatch=self.fleet_dispatch_fixture()
        env={**os.environ,'RUN_BENCH_FLEET_BIN_UNDER_TEST':str(dispatch),'FIXTURE_REPO':str(self.repo),'FIXTURE_COMMON':str(self.common),'FIXTURE_POOL':self.request['consumer']['pool_ids_file']}
        result=subprocess.run(['bash',str(SCRIPT.with_name('run-bench')),'--recover-stale-owner','invalid'],env=env,capture_output=True,text=True,timeout=15)
        self.assertEqual(result.returncode,2);self.assertIn('requires exactly 32 lowercase hex',result.stderr)
        self.assertFalse(Path(self.request['consumer']['pool_ids_file']).exists())

    @unittest.skipUnless(os.geteuid()==0,'actual mixed-owner boundary requires root')
    def test_root_claim_producer_directory_allows_workspace_owned_publisher(self):
        os.chown(self.common,1001,1001)
        claims=self.common/'cloudbench-pool-claims';claims.mkdir(mode=0o755);os.chown(claims,1001,1001)
        pool=Path(self.request['consumer']['pool_ids_file']);pool.parent.mkdir(mode=0o700);os.chown(pool.parent,1001,1001)
        Path(str(pool)+'.deps').write_text(self.dep['node']+' '+self.dep['python']+' cold-image-bootstrap\n')
        fleet=SCRIPT.with_name('run-bench-fleet').read_text();fn=re.search(r'^pool_claim_fs_transaction\(\).*?^}\n',fleet,re.M|re.S).group()
        result=subprocess.run(['bash','-c',fn+'\npool_claim_fs_transaction publish-ordinary "$@"','claim',str(claims/'22222222222222'),'22222222222222','vol_other','fixture-host',str(os.getpid()),'fixture-birth','f'*32,str(pool),str(pool)+'.deps','e'*64],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
        locks=claims/'.locks'
        self.test_actual_cli_admission_dispatch_reaches_canonical_publisher()
        self.assertEqual((locks.stat().st_uid,locks.stat().st_gid),(1001,1001))
    @unittest.skipUnless(os.geteuid()==0,'actual mixed-owner boundary requires root')
    def test_existing_root_lock_directory_is_not_silently_repaired(self):
        os.chown(self.common,1001,1001)
        claims=self.common/'cloudbench-pool-claims';claims.mkdir(mode=0o755);os.chown(claims,1001,1001)
        locks=claims/'.locks';locks.mkdir(mode=0o700);pilot=locks/'870613f04272d8.lock';pilot.write_bytes(b'preserved pilot lock')
        before=(locks.stat().st_ino,locks.stat().st_uid,locks.stat().st_gid,pilot.stat().st_ino,pilot.read_bytes())
        req,auth,fd=self.authority()
        with self.assertRaisesRegex(ValueError,'unsafe output directory'):mod.publish(req,mod.sha(req.read_bytes()),auth,mod.sha(auth.read_bytes()),fd)
        self.assertEqual((locks.stat().st_ino,locks.stat().st_uid,locks.stat().st_gid,pilot.stat().st_ino,pilot.read_bytes()),before)
        self.assertFalse(Path(self.request['consumer']['pool_ids_file']).exists())

    @unittest.skipUnless(os.geteuid()==0,'root publication boundary; execute this registered test as root')
    def test_real_module_publish_verify_and_exclusive_repeat(self):
        req,auth,fd=self.authority()
        result=subprocess.run(['python3',str(SCRIPT),'admit','--request',str(req),'--sha256',mod.sha(req.read_bytes()),'--authority',str(auth),'--authority-sha256',mod.sha(auth.read_bytes()),'--custody-fd',str(fd)],pass_fds=(fd,),capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout)['status'],'COMPLETE')
        proof=self.common/'cloudbench-pool-reuse'/(self.mid+'.json')
        verified=mod.verify_pool(proof,self.common,self.request['native_before'],self.request['native_after'],self.request['consumer']['source_ref'],mod.described(self.request['volume']))
        self.assertIn('explicit_idle',verified);self.assertNotIn('imported_cold',verified)
        fleet=SCRIPT.with_name('run-bench-fleet').read_text()
        def function(name):
            match=re.search(r'^'+name+r'\(\).*?^}\n',fleet,re.M|re.S)
            assert match,name
            return match.group()
        verify=self.root/'verify.py'
        verify.write_text('import json,runpy,sys\nh=runpy.run_path('+repr(str(SCRIPT))+')\nr=json.load(open('+repr(str(req))+'))\nh["verify_pool"](sys.argv[1],r["consumer"]["common"],r["native_before"],r["native_after"],r["consumer"]["source_ref"],h["described"](r["volume"]))\n')
        start=fleet.index('# A newer snapshot is not proof')
        end=fleet.index('# Recover only positively owned ephemeral clones',start)
        preflight=fleet[start:end]
        preflight+='\n'+'\n'.join(function(n) for n in ('pool_machine_state_from_json','pool_machine_inventory_index','pool_machine_indexed_state','reconcile_pool','pool_machine_shape_from_json','normalize_current_pool_shape','pool_write_shape_hints'))
        native_file=self.root/'current-native.json';native_file.write_text(json.dumps([mod.described(self.request['native_before'])]))
        preflight+='''
FLY() { cat "$NATIVE_FILE"; }
resize_pool_machine() { echo unexpected-resize >&2; return 9; }
reconcile_pool && normalize_current_pool_shape && pool_write_shape_hints
'''
        preflight_env={**os.environ,'GIT_COMMON_DIR':str(self.common),'POOL_IDS_FILE':self.request['consumer']['pool_ids_file'],'POOL_META_FILE':self.request['consumer']['pool_meta_file'],'POOL_COLD_BOOTSTRAP':'1','CURRENT_NODE_FP':self.dep['node'],'CURRENT_PY_FP':self.dep['python'],'FLEET_PRIMARY_VM_SIZE':'shared-cpu-2x','FLEET_PRIMARY_VM_MEMORY':'4096','FLEET_BUNDLED_FRONTEND_VM_SIZE':'shared-cpu-4x','FLEET_BUNDLED_FRONTEND_VM_MEMORY':'8192','CLOUDBENCH_POOL_DYNAMIC_VM_SHAPE':'1','FLEET_DIR':str(self.root),'NATIVE_FILE':str(native_file)}
        accepted=subprocess.run(['bash','-c',preflight],env=preflight_env,capture_output=True,text=True)
        self.assertEqual(accepted.returncode,0,accepted.stderr)
        self.assertIn('cold pool image manifest baseline matches',accepted.stdout)
        self.assertNotIn('unexpected-resize',accepted.stderr)
        shell='\n'.join(function(n) for n in ('pool_claim_fs_transaction','write_pool_claim','claim_pool_machine'))
        shell+='''
registry_meta_value() { sed -n "s/^$2=//p" "$1"; }
cloudbench_env_sha256() { sha256sum "$1" | cut -d' ' -f1; }
machine_volume_id_from_json() { cat >/dev/null; printf vol_fixture; }
fleet_audit_record_pool_machine() { return 0; }
pool_verify_reuse_proof() { python3 "$VERIFY" "$GIT_COMMON_DIR/cloudbench-pool-reuse/$1.json"; }
claim_pool_machine shared-cpu-4x 8192 1
'''
        (self.root/'pool-shapes.tsv').write_text(self.mid+' shared 4 8192\n')
        env={**os.environ,'GIT_COMMON_DIR':str(self.common),'POOL_IDS_FILE':self.request['consumer']['pool_ids_file'],'POOL_META_FILE':self.request['consumer']['pool_meta_file'],'POOL_CLAIMS_DIR':str(self.common/'cloudbench-pool-claims'),'FLEET_DIR':str(self.root),'CLAIMED_POOL_FILE':str(self.root/'claimed.ids'),'FLEET_OWNER_TOKEN':'f'*32,'FLEET_OWNER_HOST':'test','FLEET_OWNER_PID_START':'birth','VERIFY':str(verify)}
        claimed=subprocess.run(['bash','-c',shell],env=env,capture_output=True,text=True)
        self.assertEqual(claimed.returncode,0,claimed.stderr)
        self.assertEqual(claimed.stdout,self.mid)
        self.assertEqual((self.root/'claimed.ids').read_text(),self.mid+'\n')
        out=self.root/'task';out.mkdir();matrix=self.root/'matrix.json';matrix.write_text(json.dumps({'tasks':[{'name':'task','world_model_mode':'real'}]}))
        intent_shell='unset CLOUDBENCH_ARCHIVED_REUSE_REQUEST\nsource "$1"\n'+'\n'.join(function(n) for n in ('provision_primary_machine','primary_cold_bootstrap_requested'))
        intent_shell+='''
primary_vm_size_for_bench() { echo shared-cpu-4x; }
primary_vm_memory_for_bench() { echo 8192; }
bench_uses_default_pool_shape() { return 0; }
claim_pool_machine() { printf %s "$MID"; }
pool_reuse_proof_file() { printf '%s/cloudbench-pool-reuse/%s.json' "$GIT_COMMON_DIR" "$1"; }
provision_primary_machine task "$OUT" && primary_cold_bootstrap_requested "$OUT" "$MID"
'''
        env.update(POOL_COLD_BOOTSTRAP='1',FRESH_TARGET_REGION='',MID=self.mid,OUT=str(out),EXECUTION_TASK_MATRIX_FILE=str(matrix),RUN_ID='new-run',BENCH_REF=self.request['consumer']['source_ref'])
        intent=subprocess.run(['bash','-c',intent_shell,'intent',str(SCRIPT.parent/'lib/cloudbench-archived-reuse.sh')],env=env,capture_output=True,text=True)
        self.assertEqual(intent.returncode,0,intent.stderr);self.assertEqual(intent.stdout,'0\n')
        self.assertEqual(json.loads((out/'cold-primary-bootstrap').read_text())['policy'],'existing-git-reset-v1')
        with self.assertRaises(ValueError):mod.publish(req,mod.sha(req.read_bytes()),auth,mod.sha(auth.read_bytes()),fd)
    @unittest.skipUnless(os.geteuid()==0,'root publication boundary; execute this registered test as root')
    def test_active_claim_and_wrong_consumer_refuse(self):
        req,auth,fd=self.authority();claims=self.common/'cloudbench-pool-claims';claims.mkdir();(claims/self.mid).write_text('existing owner')
        with self.assertRaises(ValueError):mod.publish(req,mod.sha(req.read_bytes()),auth,mod.sha(auth.read_bytes()),fd)
        self.assertEqual((claims/self.mid).read_text(),'existing owner')
        (claims/self.mid).unlink();os.environ['CLOUDBENCH_IDLE_POOL_IDS']=str(self.common/'cloudbench-pools/other.cold.ids')
        with self.assertRaises(ValueError):mod.publish(req,mod.sha(req.read_bytes()),auth,mod.sha(auth.read_bytes()),fd)
    @unittest.skipUnless(os.geteuid()==0,'root publication boundary; execute this registered test as root')
    def test_new_directory_parent_fsync_and_ownership_precede_claim(self):
        req,auth,fd=self.authority();events=[];original=os.fsync;common_inode=self.common.stat().st_ino
        def synced(descriptor):
            events.append(os.fstat(descriptor).st_ino);return original(descriptor)
        def checkpoint(phase):
            if phase=='claimed':self.assertIn(common_inode,events)
        with mock.patch.object(mod.os,'fsync',side_effect=synced):
            mod.publish(req,mod.sha(req.read_bytes()),auth,mod.sha(auth.read_bytes()),fd,checkpoint=checkpoint)
        for name in ('cloudbench-pool-claims','cloudbench-pool-claims/.locks','cloudbench-pool-reuse','cloudbench-explicit-idle','cloudbench-pools'):
            info=(self.common/name).stat();self.assertEqual(info.st_uid,self.common.stat().st_uid);self.assertEqual(info.st_mode & 0o777,0o700)
    @unittest.skipUnless(os.geteuid()==0,'root publication boundary; execute this registered test as root')
    def test_existing_writable_directory_is_refused_without_repair(self):
        req,auth,fd=self.authority();bad=self.common/'cloudbench-pool-reuse';bad.mkdir();bad.chmod(0o777)
        with self.assertRaises(ValueError):mod.publish(req,mod.sha(req.read_bytes()),auth,mod.sha(auth.read_bytes()),fd)
        self.assertEqual(bad.stat().st_mode & 0o777,0o777)
        self.assertFalse((self.common/'cloudbench-pool-claims'/self.mid).exists())
    @unittest.skipUnless(os.geteuid()==0,'root publication boundary; execute this registered test as root')
    def test_partial_publication_stays_claimed_unusable(self):
        req,auth,fd=self.authority()
        def stop(phase):
            if phase=='published':raise RuntimeError('interrupted')
        with self.assertRaises(RuntimeError):mod.publish(req,mod.sha(req.read_bytes()),auth,mod.sha(auth.read_bytes()),fd,checkpoint=stop)
        self.assertTrue((self.common/'cloudbench-pool-claims'/self.mid).exists())
        proof=self.common/'cloudbench-pool-reuse'/(self.mid+'.json')
        with self.assertRaises(FileNotFoundError):mod.verify_pool(proof,self.common,self.request['native_before'],self.request['native_after'],self.request['consumer']['source_ref'],mod.described(self.request['volume']))

    def cold_preflight_fixture(self, cold, *, inherited='0', corrupt=False):
        request,authority,fd=self.authority()
        mod.publish(request,mod.sha(request.read_bytes()),authority,mod.sha(authority.read_bytes()),fd)
        if corrupt:
            proof=self.common/'cloudbench-pool-reuse'/(self.mid+'.json')
            value=json.loads(proof.read_bytes());value['explicit_idle']['request_sha256']='0'*64
            proof.write_bytes(mod.canonical(value))
        fleet=SCRIPT.with_name('run-bench-fleet').read_text()
        def function(name):
            match=re.search(r'^'+name+r'\(\).*?^}\n',fleet,re.M|re.S);assert match,name
            return match.group()
        start=fleet.index('while [ $# -gt 0 ]; do',fleet.index('CAPACITY_RESERVATION_ROOT='))
        parser=fleet[start:fleet.index('\ndone\n',start)+6]
        scripts=self.repo/'scripts';scripts.mkdir()
        for name in ('run-fleet-infra-canary','cloudbench-infra-canary-preflight.py','cloudbench-explicit-idle-admission.py','cloudbench-original-volume-capture.py','cloudbench-startup-failure-archive.py','cloudbench-select-snapshot.py'):
            (scripts/name).write_bytes(SCRIPT.with_name(name).read_bytes())
        (scripts/'fleet_infra_sample.py').write_text('print("parallel-tool-calls\\nspawn-sub-agents")\n')
        proof=self.common/'cloudbench-pool-reuse'/(self.mid+'.json')
        nested=scripts/'run-bench-fleet'
        nested.write_text('''set -uo pipefail
POOL_COLD_BOOTSTRAP=0; POOL_REUSE_ONLY=1; BENCHES=(); INFRA_PROBE=0
BENCH_REF=0000000000000000000000000000000000000000
'''+parser+'\n'+function('pool_verify_reuse_proof')+'''
pool_reuse_proof_file() { printf '%s' "$FIXTURE_PROOF"; }
fleet_preconfig_native_read() { cp "$FIXTURE_NATIVE" "$2"; }
fleet_cold_handoff_volume_read() { cp "$FIXTURE_VOLUME" "$2"; }
[ "$INFRA_PROBE" = 1 ] || exit 91
[ "${#BENCHES[@]}" = 2 ] || exit 92
printf 'nested_cold=%s nested_ref=%s\n' "$POOL_COLD_BOOTSTRAP" "$BENCH_REF"
pool_verify_reuse_proof "$FIXTURE_MID" vol_fixture
''')
        parent=self.root/'parent-fleet.sh'
        parent.write_text('''set -uo pipefail
POOL_COLD_BOOTSTRAP=0; POOL_REUSE_ONLY=1; BENCHES=(); INFRA_PROBE=0
RECOVER_STALE_ONLY=0; PROVISION_POOL=
ROOT_DIR="$FIXTURE_REPO"; CLOUDBENCH_FLEET_ROOT="$ROOT_DIR"
CLOUDBENCH_SCRIPT_SNAPSHOT="$FIXTURE_SCRIPTS"
export CLOUDBENCH_FLEET_ROOT CLOUDBENCH_SCRIPT_SNAPSHOT
INFRA_CANARY_PREFLIGHT_SCRIPT="$FIXTURE_SCRIPTS/cloudbench-infra-canary-preflight.py"
'''+parser+'\n'+function('fleet_infra_canary_preflight')+'\nfleet_infra_canary_preflight\n')
        env={**os.environ,'RUN_BENCH_FLEET_BIN_UNDER_TEST':str(parent),'FIXTURE_REPO':str(self.repo),'FIXTURE_SCRIPTS':str(scripts),'FIXTURE_PROOF':str(proof),'FIXTURE_MID':self.mid,'FIXTURE_NATIVE':self.request['native_before']['path'],'FIXTURE_VOLUME':self.request['volume']['path'],'GIT_COMMON_DIR':str(self.common),'BENCH_REF':self.request['consumer']['source_ref'],'CLOUDBENCH_INFRA_CANARY_COLD_BOOTSTRAP':inherited}
        for key in ('CLOUDBENCH_FAKE_DIR','CLOUDBENCH_SKIP_INFRA_CANARY_PREFLIGHT','CLOUDBENCH_INFRA_CANARY_PREFLIGHT_ACTIVE','RUN_BENCH_CAMPAIGN_BARRIER_DIR'):
            env.pop(key,None)
        argv=['bash',str(SCRIPT.with_name('run-bench')),'parallel-tool-calls','--reuse-pool-only','--autoscale-max','2','--foreground','--ref',self.request['consumer']['source_ref']]
        if cold:argv.append('--cold-primary-bootstrap')
        result=subprocess.run(argv,env=env,capture_output=True,text=True,timeout=15)
        return result,self.repo/'.context/fleet-infra-canary.last-pass'

    @unittest.skipUnless(os.geteuid()==0,'canonical local publication needs root')
    def test_cold_parent_cli_preflight_reaches_real_explicit_pool_proof(self):
        result,stamp=self.cold_preflight_fixture(True)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertIn('nested_cold=1',result.stdout);self.assertIn('nested_ref='+self.request['consumer']['source_ref'],result.stdout);self.assertTrue(stamp.is_file())

    @unittest.skipUnless(os.geteuid()==0,'canonical local publication needs root')
    def test_no_cold_opt_in_still_refuses_explicit_pool(self):
        result,stamp=self.cold_preflight_fixture(False)
        self.assertNotEqual(result.returncode,0);self.assertIn('nested_cold=0',result.stdout);self.assertFalse(stamp.exists())

    @unittest.skipUnless(os.geteuid()==0,'canonical local publication needs root')
    def test_stale_canary_environment_cannot_opt_parent_into_cold(self):
        result,stamp=self.cold_preflight_fixture(False,inherited='1')
        self.assertNotEqual(result.returncode,0);self.assertIn('nested_cold=0',result.stdout);self.assertFalse(stamp.exists())

    @unittest.skipUnless(os.geteuid()==0,'canonical local publication needs root')
    def test_cold_preflight_corrupt_proof_still_refuses_and_never_stamps(self):
        result,stamp=self.cold_preflight_fixture(True,corrupt=True)
        self.assertNotEqual(result.returncode,0);self.assertIn('nested_cold=1',result.stdout);self.assertFalse(stamp.exists())



class CanonicalBillingPredicate(unittest.TestCase):
    def test_actual_captured_hallpass_is_accepted_by_collector_predicate(self):
        captured=json.loads(SCRIPT.with_name('tests').joinpath('hallpass-platform-descriptor.fixture.json').read_text())
        node=next(n for n in ast.parse(mod.billing_predicate()).body if isinstance(n,ast.FunctionDef) and n.name=='hallpass_identity')
        env={};exec(compile(ast.Module(body=[node],type_ignores=[]),'canonical-billing','exec'),env)
        values=[captured['uid'],captured['ppid'],captured['pgid'],[captured['exe'].encode()],captured['exe'],captured['exe_sha256'],captured['birth_stable'],captured['exe_regular'],captured['exe_owner']]
        self.assertTrue(env['hallpass_identity'](*values))
        for index,wrong in ((0,1001),(1,2),(2,1),(4,'/tmp/hallpass'),(5,'0'*64),(6,False),(7,False),(8,1001)):
            changed=list(values);changed[index]=wrong
            self.assertFalse(env['hallpass_identity'](*changed))

    def test_collector_executes_exact_current_predicate_with_existing_bindings(self):
        machine='0123456789abcd';nonce='a'*32
        with mock.patch.object(mod.subprocess,'check_output',return_value=b'{}') as call:
            mod.observe_processes(machine,nonce,mod.time.monotonic()+35)
        args=call.call_args.args[0]
        self.assertEqual(args,[mod.sys.executable,'-c',mod.billing_predicate().replace('TARGET',repr(machine)).replace('NONCE',repr(nonce))])
        self.assertLessEqual(call.call_args.kwargs['timeout'],20)



@unittest.skipUnless(os.geteuid()==0,'root publication boundary')
class Worker(unittest.TestCase):
    setUp=Admission.setUp
    restore_env=Admission.restore_env
    authority=Admission.authority
    def prepare(self):
        req,auth,fd=self.authority();mod.publish(req,mod.sha(req.read_bytes()),auth,mod.sha(auth.read_bytes()),fd)
        self.proof=self.common/'cloudbench-pool-reuse'/(self.mid+'.json')
        self.out=self.root/'run';self.borrow=self.out/'worker-borrowed';self.borrow.mkdir(parents=True)
        self.attempt=self.borrow/'attempt';self.attempt.mkdir()
        self.claim=self.common/'cloudbench-pool-claims'/self.mid
        # Exercise the actual persistent-lock claim implementation, binding this live test owner.
        fleet=SCRIPT.with_name('run-bench-fleet').read_text()
        claimfn=re.search(r'^pool_claim_fs_transaction\(\).*?^}\n',fleet,re.M|re.S).group()
        self.owner='f'*32
        birth=mod.sibling('cloudbench-original-volume-capture.py')['bash_lib']('cloudbench-env.sh',['cloudbench_pid_start_time',str(os.getpid())])
        args=['bash','-c',claimfn+'\npool_claim_fs_transaction publish-ordinary "$@"','claim',str(self.claim),self.mid,self.vol,mod.socket.gethostname(),str(os.getpid()),birth,self.owner,self.request['consumer']['pool_ids_file'],self.request['consumer']['pool_meta_file'],mod.sha(Path(self.request['consumer']['pool_meta_file']).read_bytes())]
        r=subprocess.run(args,capture_output=True,text=True);self.assertEqual(r.returncode,0,r.stderr)
        self.assignment=self.borrow/(self.mid+'.json')
        self.row=dict(version=1,origin=mod.ORIGIN,historical_task_credit=0,role='borrowed-worker',machine_id=self.mid,volume_id=self.vol,proof=str(self.proof),claim_sha256=mod.sha(self.claim.read_bytes()),primary_machine_id='primary',workspace='repo',run_token='current-token',admission=str(self.attempt),fleet_owner_token='e'*32,claim_owner_token=self.owner,ledger=self.request['consumer']['pool_ids_file'],previous_state_sha256=None)
        self.assignment.write_bytes(mod.canonical(self.row))
        self.native=mod.described(self.request['native_before']);self.volume=mod.described(self.request['volume']);self.calls=[]
    def api(self,method,path,body=None,timeout=None):
        self.assertGreater(timeout,0);self.assertLessEqual(timeout,20);self.calls.append((method,path,copy.deepcopy(body)))
        if method=='POST':
            self.assertEqual(body['current_version'],self.native['instance_id']);self.assertTrue(body['skip_launch'])
            previous=copy.deepcopy(self.native['config']);self.native['config']=copy.deepcopy(body['config'])
            previous['guest']=self.native['config']['guest'];self.assertEqual(previous,self.native['config'])
            self.native['instance_id']='resized-instance'
        return copy.deepcopy(self.volume if '/volumes/' in path else self.native)
    def stage(self,size='performance-1x',memory='2048',api=None):
        return mod.stage_worker(self.assignment,self.request['consumer']['source_ref'],self.dep['node'],self.dep['python'],size,memory,api or self.api)
    def evidence(self):
        root=self.out/'worker-runtime-evidence'/self.mid;root.mkdir(parents=True)
        owner=dict(version=1,machine_id=self.mid,primary_machine_id='primary',run_token='current-token',workspace='repo')
        (root/'owner.json').write_bytes(mod.canonical(owner));stage=self.out/('worker-'+self.mid+'.stage.log');stage.write_bytes(b'not launched')
        (root/'not-launched.json').write_bytes(mod.canonical(dict(owner,worker_started=False,stage_sha256=mod.sha(stage.read_bytes()))))
        return mod.sibling('cloudbench-worker-reuse.py')['validate_capture'](self.out,self.mid,'primary','current-token')
    def return_inputs(self):
        return [self.save(self.native)['path'],self.save(self.native)['path'],self.save(self.volume)['path']]
    def test_requested_worker_shape_one_versioned_update(self):
        self.prepare();result=self.stage()
        self.assertEqual(result['native']['config']['guest'],dict(cpu_kind='performance',cpus=1,memory_mb=2048))
        self.assertEqual(sum(c[0]=='POST' for c in self.calls),1);self.assertTrue(self.claim.exists())
        self.assertEqual(result['native']['config']['mounts'][0]['volume'],self.vol)
    def test_matching_shape_needs_no_update(self):
        self.prepare();self.stage('shared-cpu-4x','8192');self.assertFalse(any(c[0]=='POST' for c in self.calls))
    def test_ambiguous_update_cannot_retry(self):
        self.prepare()
        def api(method,*args,**kwargs):
            result=self.api(method,*args,**kwargs)
            if method=='POST':raise TimeoutError('ambiguous ACK')
            return result
        with self.assertRaises(TimeoutError):self.stage(api=api)
        before=len(self.calls)
        with self.assertRaises(ValueError):self.stage()
        self.assertEqual(len(self.calls),before);self.assertEqual(sum(c[0]=='POST' for c in self.calls),1)
        self.assertEqual(json.loads((self.attempt/'stage.pending.json').read_text())['status'],'PENDING_NO_RETRY')
    def test_wrong_volume_refuses_before_update(self):
        self.prepare();self.volume['attached_machine_id']='foreign'
        with self.assertRaises(ValueError):self.stage()
        self.assertFalse(any(c[0]=='POST' for c in self.calls));self.assertTrue(self.claim.exists())
    def test_claim_changed_refuses_before_api(self):
        self.prepare();self.claim.write_bytes(self.claim.read_bytes()+b'changed=yes\n')
        with self.assertRaises(ValueError):self.stage()
        self.assertFalse(self.calls)
    def test_deadline_cannot_publish_or_retry(self):
        self.prepare()
        with self.assertRaises(ValueError):mod.stage_worker(self.assignment,self.request['consumer']['source_ref'],self.dep['node'],self.dep['python'],'performance-1x','2048',self.api,seconds=0)
        self.assertFalse(self.calls);self.assertFalse((self.attempt/'stage.complete.json').exists())
        with self.assertRaises(ValueError):self.stage()
    def test_return_release_allows_next_primary_or_worker(self):
        self.prepare();self.stage();evidence=self.evidence();before,after,volume=self.return_inputs()
        state=mod.record_worker_return(self.assignment,before,after,volume)
        receipt=dict(machine_id=self.mid,run_token='current-token',claim_sha256=self.row['claim_sha256'],primary_machine_id='primary',fleet_owner_token=self.row['fleet_owner_token'],state='stopped',volume_retained=True,evidence_sha256=evidence)
        returned=self.borrow/(self.mid+'.returned.json');returned.write_bytes(mod.canonical(receipt))
        with self.assertRaises((ValueError,FileNotFoundError)):mod.returned_state(self.proof)
        self.claim.unlink()
        helper=mod.sibling('cloudbench-worker-reuse.py');helper['recover_return_release'](self.out,self.mid,'primary','current-token')
        self.assertEqual(mod.returned_state(self.proof),state)
        for role in ('primary','worker'):
            mod.verify_pool(self.proof,self.common,mod.descriptor(before),mod.descriptor(after),self.request['consumer']['source_ref'],self.volume,role=role)
        self.assertEqual(mod.current_policy(self.proof),'existing-git-reset-v1')
        state_path=self.common/'cloudbench-explicit-idle'/(self.mid+'.state.json')
        tampered=copy.deepcopy(state);tampered['native']['config']['guest']['memory_mb']=1024;state_path.write_bytes(mod.canonical(tampered))
        with self.assertRaises(ValueError):mod.returned_state(self.proof)
        state_path.write_bytes(mod.canonical(state))
        self.assertEqual(Path(self.request['consumer']['pool_ids_file']).read_text(),self.mid+'\n')
    def test_return_running_or_alias_pair_or_missing_capture_refuses(self):
        self.prepare();self.stage();before,after,volume=self.return_inputs()
        with self.assertRaises(FileNotFoundError):mod.record_worker_return(self.assignment,before,after,volume)
        self.evidence()
        with self.assertRaises(ValueError):mod.record_worker_return(self.assignment,before,before,volume)
        self.native['state']='started';before,after,volume=self.return_inputs()
        with self.assertRaises(ValueError):mod.record_worker_return(self.assignment,before,after,volume)
    def test_second_role_cannot_claim_same_machine(self):
        self.prepare();fleet=SCRIPT.with_name('run-bench-fleet').read_text();claimfn=re.search(r'^pool_claim_fs_transaction\(\).*?^}\n',fleet,re.M|re.S).group()
        fields=dict(line.split('=',1) for line in self.claim.read_text().splitlines())
        args=['bash','-c',claimfn+'\npool_claim_fs_transaction publish-ordinary "$@"','claim',str(self.claim),self.mid,self.vol,fields['host'],fields['pid'],fields['pid_start'],'a'*32,fields['pool_ledger_file'],fields['pool_meta_file'],fields['pool_meta_sha256']]
        result=subprocess.run(args,capture_output=True,text=True)
        self.assertNotEqual(result.returncode,0);self.assertEqual(mod.sha(self.claim.read_bytes()),self.row['claim_sha256'])


    def test_actual_worker_cli_claim_stage_return_and_next_claim(self,transport="config",size="performance-1x",memory="2048",expected_posts=1):
        self.prepare();self.claim.unlink();self.assignment.unlink()
        fixture=self.root/'api.json';fixture.write_text(json.dumps(dict(native=self.native,volume=self.volume)))
        runner=self.root/'stage-api.py'
        runner.write_text('''import argparse,json,runpy,sys
from pathlib import Path
h=runpy.run_path(sys.argv[1]);p=argparse.ArgumentParser()
for name in ('assignment','source','node','python','size','memory','app'):p.add_argument('--'+name,required=True)
a=p.parse_args(sys.argv[3:]);f=Path('''+repr(str(fixture))+''');data=json.loads(f.read_text());calls=[]
def api(method,path,body=None,timeout=None):
 assert timeout<=20
 calls.append([method,path,body])
 if method=='POST':
  assert body['current_version']==data['native']['instance_id'] and body['skip_launch'] is True
  data['native']['config']=body['config'];data['native']['instance_id']='worker-instance'
 return data['volume'] if '/volumes/' in path else data['native']
h.get('worker_stage',h.get('stage_worker'))(a.assignment,a.source,a.node,a.python,a.size,a.memory,api)
f.write_text(json.dumps(data));f.with_suffix('.calls').write_text(json.dumps(calls))
r=json.loads(Path(a.assignment).read_text());out=Path(a.assignment).parent.parent
e=out/'worker-runtime-evidence'/r['machine_id'];e.mkdir(parents=True)
owner=dict(version=1,machine_id=r['machine_id'],primary_machine_id=r['primary_machine_id'],run_token=r['run_token'])
(e/'owner.json').write_text(json.dumps(owner));s=out/('worker-'+r['machine_id']+'.stage.log');s.write_bytes(b'not launched')
(e/'not-launched.json').write_text(json.dumps(dict(owner,worker_started=False,stage_sha256=h['sha'](s.read_bytes()))))
''')
        fleet=SCRIPT.with_name('run-bench-fleet').read_text()
        def function(name):return re.search(r'^'+name+r'\(\).*?^}\n',fleet,re.M|re.S).group()
        # Historical fallback remains present and unchanged; explicit path must win first.
        shell='\n'.join(function(n) for n in ('pool_claim_fs_transaction','write_pool_claim','pool_claim_release_exact','explicit_worker_helper','claim_explicit_idle_worker','claim_reusable_worker','return_reusable_worker'))
        shell+='''
set -e
python3() {
 if [ "$1" = "$STAGED_HELPER" ] && [ "$2" = worker-stage ]; then
  command python3 "$RUNNER" "$@"
 else command python3 "$@"; fi
}
cloudbench_env_sha256() { sha256sum "$1" | cut -d' ' -f1; }
cloudbench_fsync_directory() { return 0; }
worker_ledger_lock_acquire() { return 0; }
worker_ledger_lock_release() { return 0; }
pool_claim_mark_cleanup_unconfirmed() { echo unexpected-unconfirmed >&2; return 9; }
fleet_preconfig_native_read() { command python3 -c 'import json,sys;open(sys.argv[2],"w").write(json.dumps(json.load(open(sys.argv[1]))["native"]))' "$API_FIXTURE" "$2"; }
fleet_cold_handoff_volume_read() { command python3 -c 'import json,sys;open(sys.argv[2],"w").write(json.dumps(json.load(open(sys.argv[1]))["volume"]))' "$API_FIXTURE" "$2"; }
FLEET_OWNER_PID_START="$(command python3 -c 'import runpy,sys;h=runpy.run_path(sys.argv[1]);print(h["bash_lib"]("cloudbench-env.sh",["cloudbench_pid_start_time",sys.argv[2]]))' "$VOLUME_HELPER" "$$")"
mid="$(claim_reusable_worker "$OUT" primary repo current-token ::1)"
[ "$mid" = "$MID" ]
return_reusable_worker "$OUT" "$mid"
[ ! -e "$POOL_CLAIMS_DIR/$mid" ]
write_pool_claim "$POOL_CLAIMS_DIR/$mid" "$mid" vol_fixture
printf '%s' "$mid"
'''
        env={**os.environ,'OUT':str(self.out),'MID':self.mid,'IDLE_HELPER':str(SCRIPT),'STAGED_HELPER':str(SCRIPT.with_name('cloudbench-staged-boot-return.py')),'VOLUME_HELPER':str(SCRIPT.with_name('cloudbench-original-volume-capture.py')),'RUNNER':str(runner),'API_FIXTURE':str(fixture),'GIT_COMMON_DIR':str(self.common),'POOL_IDS_FILE':self.request['consumer']['pool_ids_file'],'POOL_META_FILE':self.request['consumer']['pool_meta_file'],'POOL_CLAIMS_DIR':str(self.common/'cloudbench-pool-claims'),'POOL_COLD_BOOTSTRAP':'1','FLEET_OWNER_TOKEN':'e'*32,'FLEET_OWNER_HOST':mod.socket.gethostname(),'CURRENT_NODE_FP':self.dep['node'],'CURRENT_PY_FP':self.dep['python'],'BENCH_REF':self.request['consumer']['source_ref'],'FLEET_WORKER_VM_SIZE':size,'FLEET_WORKER_VM_MEMORY':memory,'APP':'app','CLOUDBENCH_BOOT_TRANSPORT':transport}
        result=subprocess.run(['bash','-c',shell],env=env,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(result.stdout,self.mid)
        calls=json.loads(fixture.with_suffix('.calls').read_text());self.assertEqual(sum(c[0]=='POST' for c in calls),expected_posts)
        self.assertEqual(json.loads(fixture.read_text())['native']['config']['guest'],mod.worker_profile(size,memory))
        self.assertEqual(mod.returned_state(self.proof)['native']['instance_id'],'worker-instance' if expected_posts else 'instance')
        self.assertEqual((self.out/'worker-clones.ids').read_text(),self.mid+'\n')
        self.assertEqual(Path(self.request['consumer']['pool_ids_file']).read_text(),self.mid+'\n')


    def test_current_runtime_capture_promotes_empty_workspace_policy(self):
        obs=mod.described(self.request['observation']);obs['workspace']={'kind':'empty'}
        self.request['observation']=self.save(obs);self.request['workspace_policy']='real-empty-bootstrap-v1'
        terminal=mod.described(self.request['observer_terminal']);terminal['observation_sha256']=self.request['observation']['sha256'];self.request['observer_terminal']=self.save(terminal)
        self.prepare();self.stage()
        expected=dict(version=1,machine_id=self.mid,run_token='current-token')
        process=dict(pid=11,birth='linux:01234567-1234-1234-1234-123456789abc:1')
        owner=dict(expected,primary_machine_id='primary',supervisor=process,expected_worker_logs=['worker.json'])
        terminal=dict(expected,supervisor=process,child=dict(process,pid=12),exit_code=0,worker_started=True,quiescent=True,children_reaped=True,streams_closed=True)
        root=self.out/'worker-runtime-evidence'/self.mid;root.mkdir(parents=True)
        (root/'owner.json').write_bytes(mod.canonical(owner));capture=root/'capture';capture.mkdir()
        files={}
        for name,value in {'receipts/owner.json':mod.canonical(owner),'receipts/terminal.json':mod.canonical(terminal),'logs/worker.log':b'current worker closed\n','logs/agents/worker.json':b'{}\n'}.items():
            path=capture/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(value);files[name]=dict(bytes=len(value),sha256=mod.sha(value))
        manifest=dict(expected,quiescent=True,files=files,terminal=terminal,worker_logs=['worker.json'])
        (capture/'manifest.json').write_bytes(mod.canonical(manifest))
        before,after,volume=self.return_inputs();state=mod.record_worker_return(self.assignment,before,after,volume)
        self.assertEqual(state['workspace_policy'],'existing-git-reset-v1')
        (capture/'logs/worker.log').write_bytes(b'tampered')
        with self.assertRaises(Exception):mod.verify_worker_return(self.assignment,before,after,volume)

class PoolLedgerReadIsolation(unittest.TestCase):
    def run_reconcile(self, *, foreign=True, selected_readable=True, foreign_readable=False, foreign_state='stopped'):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);root.chmod(0o700);os.chown(root,1001,1001)
            common=root/'common';common.mkdir();os.chown(common,1001,1001)
            pools=common/'cloudbench-pools';pools.mkdir();os.chown(pools,1001,1001)
            selected=pools/'repo.cold.ids';selected.write_text('0123456789abcd\n');selected.chmod(0o600)
            if selected_readable:os.chown(selected,1001,1001)
            old=pools/'v41-primary.cold.ids'
            if foreign:old.write_text('11111111111111\n');old.chmod(0o600)
            if foreign and foreign_readable:os.chown(old,1001,1001)
            original=old.stat() if foreign else None
            native=root/'inventory.json';native.write_text(json.dumps([{'id':'0123456789abcd','state':'stopped'},{'id':'11111111111111','state':foreign_state}]))
            native.chmod(0o644)
            fleet=SCRIPT.with_name('run-bench-fleet').read_text()
            def function(name):
                match=re.search(r'^'+name+r'\(\).*?^}\n',fleet,re.M|re.S);assert match,name
                return match.group()
            script='\n'.join(function(name) for name in ('pool_machine_state_from_json','pool_machine_inventory_index','pool_machine_indexed_state','reconcile_pool'))+'''
FLY() { [ "$1 $2" = 'machines list' ] || { echo FORBIDDEN >&2; return 90; }; cat "$INVENTORY"; }
reconcile_pool
'''
            env={**os.environ,'GIT_COMMON_DIR':str(common),'POOL_IDS_FILE':str(selected),'POOL_CLAIMS_DIR':str(common/'claims'),'APP':'app','INVENTORY':str(native),'CLOUDBENCH_CAMPAIGN_INVENTORY_DIR':'','PRIVATE_SOURCE_ID':''}
            result=subprocess.run(['bash','-e','-c',script],env=env,user=1001,group=1001,extra_groups=[],capture_output=True,text=True,timeout=5)
            self.assertNotIn('FORBIDDEN',result.stderr)
            self.assertEqual(selected.read_text(),'0123456789abcd\n')
            if foreign:
                after=old.stat();self.assertEqual(old.read_text(),'11111111111111\n')
                self.assertEqual((original.st_dev,original.st_ino,original.st_uid,original.st_gid,original.st_mode),(after.st_dev,after.st_ino,after.st_uid,after.st_gid,after.st_mode))
            return result

    @unittest.skipUnless(os.geteuid()==0,'real UID1001 permission boundary needs root')
    def test_unreadable_foreign_pool_does_not_block_selected_pool(self):
        result=self.run_reconcile()
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('unreadable foreign pool ledger untouched',result.stderr)

    @unittest.skipUnless(os.geteuid()==0,'real UID1001 permission boundary needs root')
    def test_unreadable_selected_pool_still_refuses(self):
        result=self.run_reconcile(selected_readable=False)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('selected pool ledger is unreadable',result.stderr)

    @unittest.skipUnless(os.geteuid()==0,'real UID1001 permission boundary needs root')
    def test_readable_foreign_pool_still_obeys_existing_state_guard(self):
        result=self.run_reconcile(foreign_readable=True,foreign_state='unexpected')
        self.assertNotEqual(result.returncode,0)
        self.assertIn('unsafe pre-refresh state',result.stderr)

    @unittest.skipUnless(os.geteuid()==0,'real UID1001 permission boundary needs root')
    def test_selected_readable_pool_alone_still_reconciles(self):
        result=self.run_reconcile(foreign=False)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertNotIn('unreadable',result.stderr)

class BorrowedPreconfigRecovery(unittest.TestCase):
    def setUp(self):
        self.f=Admission();self.f.setUp();self.addCleanup(self.f.doCleanups)
        self.h=runpy.run_path(str(SCRIPT.with_name('cloudbench-explicit-idle-preconfig.py')))
        req,auth,fd=self.f.authority();mod.publish(req,mod.sha(req.read_bytes()),auth,mod.sha(auth.read_bytes()),fd)
        self.owner='e'*32;self.registry=self.f.common/'cloudbench-fleet-ownership'/self.owner
        self.audit=self.f.common/'cloudbench-fleet-audits'/self.owner;self.run=self.f.root/'runs'/'failed';self.out=self.run/'parallel-tool-calls'
        for p in (self.registry/'clones',self.audit/'fresh',self.audit/'expected-fresh',self.audit/'by-machine-id',self.audit/'pool',self.run/'_batch',self.run/'.boot-config-barrier/ready',self.out):p.mkdir(parents=True,exist_ok=True)
        self.meta=dict(version='2',fleet_owner_token=self.owner,app='app',run_id='failed',runs_root=str(self.run.parent),audit_dir=str(self.audit),host=mod.socket.gethostname(),pid='99999999',pid_start='dead-fixture',cleanup_policy='retain')
        self.fields(self.registry/'meta',self.meta);self.fields(self.audit/'meta',self.meta)
        for n in ('owned-clones.ids','owned-clones.names'):(self.audit/n).write_bytes(b'')
        self.write(self.run/'_batch/lifecycle.json',dict(status='failed',fleet_owner_token=self.owner,run_id='failed',controller_exit_code=1))
        self.write(self.run/'_batch/benches.json',[dict(name='parallel-tool-calls',mode='REAL')])
        contract=runpy.run_path(str(SCRIPT.with_name('cloudbench_execution_provenance.py')))
        matrix=contract['build_task_matrix'](['parallel-tool-calls=real']);config=contract['build_config'](contract['CONFIG_SCHEMA_VERSION'],['task_count=1','task_matrix_sha256='+matrix['sha256'],'boot_launch=1','primary_reuse_only=1','cold_primary_bootstrap=1'])
        prov=dict(schema_version=contract['EXECUTION_SCHEMA_VERSION'],base_sha=self.f.request['consumer']['source_ref'],workspace_patch_sha256='none',controller_snapshot=dict(schema_version=contract['SNAPSHOT_SCHEMA_VERSION'],sha256='f'*64),config=config)
        self.write(self.run/'execution-provenance.json',prov);self.write(self.run/'execution-task-matrix.json',matrix)
        self.claim=self.f.common/'cloudbench-pool-claims'/self.f.mid
        self.fields(self.claim,dict(host=self.meta['host'],pid=self.meta['pid'],pid_start=self.meta['pid_start'],fleet_owner_token=self.owner,cleanup_state='unconfirmed'))
        self.pool=dict(version='1',fleet_owner_token=self.owner,app='app',run_id='failed',source='borrowed-pool',machine_id=self.f.mid,volume_id=self.f.vol,pool_ledger_file=self.f.request['consumer']['pool_ids_file'],pool_meta_file=self.f.request['consumer']['pool_meta_file'],pool_meta_sha256=mod.sha(Path(self.f.request['consumer']['pool_meta_file']).read_bytes()),disposition='claimed')
        self.fields(self.audit/'pool'/self.f.mid,self.pool)
        proof=self.f.common/'cloudbench-pool-reuse'/(self.f.mid+'.json')
        self.write(self.out/'cold-primary-bootstrap',dict(version=1,policy=mod.current_policy(proof),machine_id=self.f.mid,volume_id=self.f.vol,source_ref=self.f.request['consumer']['source_ref'],run_id='failed',run_token=self.owner+'-0',proof_sha256=mod.sha(proof.read_bytes())))
        for name,raw in {'.cid':'pool '+self.f.mid+'\n','benchmark-child.finished':'125\n','boot-config-unapplied':self.f.mid+'\n','worker-clones.ids':'','cloudbench-boot-update.log':'Error: organization has reached its machine limit\n','autoscaler.completed-after-child':'','desired-worker-count':'0\n'}.items():(self.out/name).write_text(raw)
        identity=dict(version=1,machine_id=self.f.mid,run_token=self.owner+'-0')
        self.write(self.out/'runtime-evidence.owner.json',identity);self.write(self.out/'runtime-evidence.pending',identity)
        (self.registry/'runtime-evidence-unconfirmed').write_text('pending')
        self.native=mod.described(self.f.request['native_before']);self.volume=mod.described(self.f.request['volume'])
        self.source=self.f.request['consumer']['source_ref']
    def write(self,p,v):p.write_bytes(mod.canonical(v))
    def fields(self,p,v):p.write_text(''.join(k+'='+v+'\n' for k,v in v.items()))
    def recover(self,**kw):return self.h['recover'](self.registry,self.f.common,self.source,lambda mid:copy.deepcopy(self.native),lambda vol:copy.deepcopy(self.volume),**kw)
    @unittest.skipUnless(os.geteuid()==0,'canonical publication fixture requires root')
    def test_actual_borrowed_pool_preconfig_archives_before_release(self):
        observed=[]
        def check(stage):
            if stage=='archived':self.assertTrue(self.claim.exists());self.assertTrue((self.out/'runtime-evidence.pending').exists());observed.append(stage)
        fleet=SCRIPT.with_name('run-bench-fleet').read_text()
        function=re.search(r'^fleet_preconfig_recovery_plan\(\).*?^}\n',fleet,re.M|re.S).group()
        old=subprocess.run(['bash','-c',function+'\nfleet_preconfig_recovery_plan "$REGISTRY"'],env={**os.environ,'REGISTRY':str(self.registry),'APP':'app','FLEET_AUDIT_ROOT':str(self.audit.parent),'CLOUDBENCH_SCRIPT_SNAPSHOT':str(SCRIPT.parent),'POOL_COLD_BOOTSTRAP':'1','POOL_CLAIMS_DIR':str(self.claim.parent)},capture_output=True,text=True)
        self.assertNotEqual(old.returncode,0,'fresh-only path must reject borrowed audit')
        result=self.recover(checkpoint=check)
        self.assertEqual(result['status'],'RECOVERED_STOPPED');self.assertEqual(observed,['archived'])
        self.assertFalse(self.claim.exists());self.assertFalse((self.out/'runtime-evidence.pending').exists())
        self.assertEqual(self.h['fields'](self.audit/'pool'/self.f.mid)['disposition'],'returned-stopped-claim-released')
        # Later field readers enumerate audit/pool: leave only the exact audit record.
        self.assertEqual(sorted(path.name for path in (self.audit/'pool').iterdir()),[self.f.mid])
        self.assertIn(self.f.mid,Path(self.pool['pool_ledger_file']).read_text())
    @unittest.skipUnless(os.geteuid()==0,'canonical publication fixture requires root')
    def test_absent_infra_runtime_is_not_synthesized(self):
        (self.out/'runtime-evidence.owner.json').unlink();(self.out/'runtime-evidence.pending').unlink()
        result=self.recover();self.assertEqual(result['status'],'RECOVERED_STOPPED')
        self.assertFalse((self.out/'runtime-evidence.owner.json').exists());self.assertFalse(self.claim.exists())
    @unittest.skipUnless(os.geteuid()==0,'canonical publication fixture requires root')
    def test_mixed_runtime_absence_refuses(self):
        (self.out/'runtime-evidence.pending').unlink()
        with self.assertRaises(ValueError):self.recover()
        self.assertTrue(self.claim.exists())
    @unittest.skipUnless(os.geteuid()==0,'canonical publication fixture requires root')
    def test_live_owner_refuses_without_archive_or_release(self):
        self.h['plan'].__globals__['pid_birth_state']=lambda *a:'live'
        with self.assertRaises(ValueError):self.recover()
        self.assertTrue(self.claim.exists());self.assertFalse((self.registry/'explicit-idle-preconfig-recovery').exists())
    @unittest.skipUnless(os.geteuid()==0,'canonical publication fixture requires root')
    def test_start_evidence_refuses(self):
        (self.out/'post-config-start.accepted').write_text(self.f.mid)
        with self.assertRaises(ValueError):self.recover()
        self.assertTrue(self.claim.exists())
    @unittest.skipUnless(os.geteuid()==0,'canonical publication fixture requires root')
    def test_native_drift_refuses_and_keeps_claim(self):
        self.native['instance_id']='changed'
        with self.assertRaises(ValueError):self.recover()
        self.assertTrue(self.claim.exists());self.assertTrue((self.out/'runtime-evidence.pending').exists())
    @unittest.skipUnless(os.geteuid()==0,'canonical publication fixture requires root')
    def test_archive_interruption_preserves_claim_and_pending(self):
        def stop(stage):raise RuntimeError('local interruption')
        with self.assertRaises(RuntimeError):self.recover(checkpoint=stop)
        self.assertTrue(self.claim.exists());self.assertTrue((self.out/'runtime-evidence.pending').exists());self.assertTrue((self.registry/'explicit-idle-preconfig-recovery/archive.json').exists())
    @unittest.skipUnless(os.geteuid()==0,'canonical publication fixture requires root')
    def test_foreign_claim_and_fresh_cid_refuse(self):
        self.fields(self.claim,dict(host=self.meta['host'],pid=self.meta['pid'],pid_start=self.meta['pid_start'],fleet_owner_token='a'*32,cleanup_state='unconfirmed'))
        with self.assertRaises(ValueError):self.recover()
        self.fields(self.claim,dict(host=self.meta['host'],pid=self.meta['pid'],pid_start=self.meta['pid_start'],fleet_owner_token=self.owner,cleanup_state='unconfirmed'))
        (self.out/'.cid').write_text('clone '+self.f.mid+'\n')
        with self.assertRaises(ValueError):self.recover()


class BorrowedPreconfigDeadlines(unittest.TestCase):
    def test_alarm_is_not_swallowed_by_oserror_catch(self):
        import time
        h=runpy.run_path(str(SCRIPT.with_name('cloudbench-explicit-idle-preconfig.py')))
        def legacy_api():
            try:time.sleep(.05)
            except OSError:return 'swallowed'
        with self.assertRaises(h['RecoveryDeadline']):h['bounded_read'](legacy_api,time.monotonic()+.01)
    def test_late_per_read_return_is_refused_before_whole_deadline(self):
        h=runpy.run_path(str(SCRIPT.with_name('cloudbench-explicit-idle-preconfig.py')))
        with mock.patch.object(h['time'],'monotonic',side_effect=[0,21]):
            with self.assertRaises(h['RecoveryDeadline']):h['bounded_read'](lambda:'late',180)
    def test_late_return_is_refused(self):
        h=runpy.run_path(str(SCRIPT.with_name('cloudbench-explicit-idle-preconfig.py')))
        with mock.patch.object(h['time'],'monotonic',side_effect=[0,2]):
            with self.assertRaises(h['RecoveryDeadline']):h['bounded_read'](lambda:'late',1)


class PreconfigSnapshotLayout(unittest.TestCase):
    # The flat-layout PID predicate needs no publication authority; only the
    # dead-owner plan case uses the root-published borrowed-recovery fixture.
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        self.flat=Path(temp.name)/'flat-snapshot';self.flat.mkdir()
        for path in SCRIPT.parent.glob('*.py'):shutil.copy2(path,self.flat/path.name)
        shutil.copy2(SCRIPT.parent/'lib/cloudbench-env.sh',self.flat/'cloudbench-env.sh')
        self.helper=self.flat/'cloudbench-explicit-idle-preconfig.py'
    def test_original_wrapper_supports_flat_snapshot_pid(self):
        helper=runpy.run_path(str(self.flat/'cloudbench-original-volume-capture.py'))
        self.assertEqual(helper['pid_birth_state']('99999999','dead-fixture'),'absent')
    @unittest.skipUnless(os.geteuid()==0,'canonical publication fixture requires root')
    def test_actual_flat_snapshot_plan_runs_canonical_dead_owner_predicate(self):
        self.f=BorrowedPreconfigRecovery();self.f.setUp();self.addCleanup(self.f.doCleanups)
        code='import runpy,sys; h=runpy.run_path(sys.argv[1]); p=h["plan"](*sys.argv[2:]); print(len(p["rows"]))'
        result=subprocess.run(['python3','-c',code,str(self.helper),str(self.f.registry),str(self.f.f.common),self.f.source],text=True,capture_output=True,timeout=20,cwd='/')
        self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(result.stdout.strip(),'1')
        self.assertFalse((self.f.registry/'explicit-idle-preconfig-recovery').exists())
    def test_actual_flat_snapshot_retains_live_owner_guard(self):
        helper=runpy.run_path(str(self.helper))
        birth=subprocess.check_output(['bash','-c','source "$1"; cloudbench_pid_start_time "$2"','fixture',str(self.flat/'cloudbench-env.sh'),str(os.getpid())],text=True).strip()
        self.assertEqual(helper['pid_birth_state'](str(os.getpid()),birth),'live')
    def test_missing_or_linked_library_fails_closed(self):
        library=self.flat/'cloudbench-env.sh';library.unlink()
        helper=runpy.run_path(str(self.helper))
        with self.assertRaises(FileNotFoundError):helper['pid_birth_state']('99999999','dead-fixture')
        library.symlink_to(SCRIPT.parent/'lib/cloudbench-env.sh')
        with self.assertRaises(ValueError):helper['pid_birth_state']('99999999','dead-fixture')


@unittest.skipUnless(os.geteuid()==0,'real publication and claim boundary')
class StagedPrimaryReturn(unittest.TestCase):
    def setUp(self):
        self.f=Worker();self.f.setUp();self.addCleanup(self.f.doCleanups);self.f.prepare()
        self.h=runpy.run_path(str(SCRIPT.with_name('cloudbench-staged-boot-return.py')))
        if os.environ.get('STAGED_RETURN_TEST_SOURCE'):
            self.h={'__file__':str(SCRIPT.with_name('cloudbench-staged-boot-return.py')),'__name__':'staged_return_old'}
            exec(compile(Path(os.environ['STAGED_RETURN_TEST_SOURCE']).read_bytes(),'staged-return-old','exec'),self.h)
        self.transport=runpy.run_path(str(SCRIPT.with_name('cloudbench-staged-boot.py')))
        self.registry=self.f.common/'cloudbench-fleet-ownership'/self.f.owner;self.registry.mkdir(parents=True)
        self.run=self.f.root/'runs'/'current';self.out=self.run/'parallel-tool-calls';self.out.mkdir(parents=True)
        self.stage=self.out/'staged-boot';self.stage.mkdir()
        self.source=self.f.request['consumer']['source_ref'];self.token=self.f.owner+'-0'
        claim=dict(line.split('=',1) for line in self.f.claim.read_text().splitlines())
        meta=dict(claim,app='app',run_id='current',runs_root=str(self.run.parent))
        (self.registry/'meta').write_text(''.join(k+'='+v+'\n' for k,v in meta.items()))
        c=runpy.run_path(str(SCRIPT.with_name('cloudbench_execution_provenance.py')))
        matrix=c['build_task_matrix'](['parallel-tool-calls=real'])
        config=c['build_config'](c['CONFIG_SCHEMA_VERSION'],['task_count=1','task_matrix_sha256='+matrix['sha256'],'boot_launch=1','primary_reuse_only=1','cold_primary_bootstrap=1','boot_transport=staged'])
        self.provenance=dict(schema_version=c['EXECUTION_SCHEMA_VERSION'],base_sha=self.source,workspace_patch_sha256='none',controller_snapshot=dict(schema_version=c['SNAPSHOT_SCHEMA_VERSION'],sha256='f'*64),config=config)
        self.write(self.run/'execution-provenance.json',self.provenance);self.write(self.run/'execution-task-matrix.json',matrix)
        (self.out/'.cid').write_text('pool '+self.f.mid+'\n')
        request=dict(schema='cloudbench-staged-boot-request-v1',app='app',machine=self.f.mid,volume_id=self.f.vol,instance_id=self.f.native['instance_id'],run_token=self.token,source_ref=self.source,nonce='a'*32,config_sha256=mod.sha(mod.canonical(self.f.native['config'])),update_attempted=False,idle_probe='bound fixture')
        payload={n:b'fixture source' for n in ('cloudbench-boot.sh','cloudbench-status-server.py','cloudbench-boot-payload.py','cloudbench-boot-payload.json.gz')}
        archive_sha,request=self.transport['bundle'](self.stage/'boot.tar.gz',dict(REF=self.source,CLOUDBENCH_RUN_TOKEN=self.token,CLOUDBENCH_BOOT='1'),payload,request)
        self.write(self.stage/'intent.json',request)
        self.write(self.stage/'payload.json',dict(archive_sha256=archive_sha,bytes=(self.stage/'boot.tar.gz').stat().st_size))
        self.ack=dict(schema='cloudbench-staged-boot-launch-v1',**{k:request[k] for k in ('app','machine','volume_id','instance_id','run_token','source_ref','nonce','config_sha256')},archive_sha256=archive_sha,intent_sha256=mod.sha((self.stage/'intent.json').read_bytes()),guest_once='/tmp/cloudbench-staged-boot/'+self.token,supervisor_pid=42,supervisor_birth='123',dispatched=True,runtime_success=False)
        self.write(self.stage/'launch.ack.json',self.ack);self.terminal()
        self.write(self.stage/'native-before.json',self.f.native);self.write(self.stage/'native-started.json',dict(self.f.native,state='started'));self.write(self.stage/'volume-before.json',self.f.volume)
        self.before=self.out/'before.json';self.after=self.out/'after.json';self.vol=self.out/'volume.json'
        self.write(self.before,self.f.native);self.write(self.after,self.f.native);self.write(self.vol,self.f.volume)
        self.write(self.out/'runtime-evidence.owner.json',dict(version=1,machine_id=self.f.mid,run_token=self.token))
        runtime=self.out/'remote-logs/runtime-evidence';(runtime/'logs').mkdir(parents=True)
        entries={'services.json':mod.canonical(dict(status='stopped',env=dict(worker_processes=1))), 'run.json':b'{}','stack.log':b'log','cloudbench-stack-cleanup-'+self.token+'.status':('state=clean\ntoken='+self.token+'\n').encode(),'logs/backend.log':b'backend','logs/worker.log':b'worker'}
        for name,raw in entries.items():(runtime/name).write_bytes(raw)
        self.write(runtime/'manifest.json',dict(version=1,machine_id=self.f.mid,run_token=self.token,files={n:dict(bytes=len(v),sha256=mod.sha(v)) for n,v in entries.items()}))
        (self.out/'guest-shutdown.confirmed').write_text('current\n')
    def write(self,path,value):path.write_bytes(mod.canonical(value)+b'\n')
    def terminal(self):self.write(self.stage/'terminal.json',dict(status='BOOT_DISPATCHED',intent_sha256=mod.sha((self.stage/'intent.json').read_bytes()),launch_ack_sha256=mod.sha((self.stage/'launch.ack.json').read_bytes()),runtime_success=False,update_attempted=False))
    def verify(self):return self.h['verify'](self.out,self.registry,self.f.common,self.source,self.f.mid,self.f.vol,self.before,self.after,self.vol)
    def test_real_claim_producer_archive_and_canonical_runtime_return(self):
        before=self.f.claim.read_bytes();self.assertEqual(self.verify()['status'],'STOPPED_RUNTIME_VERIFIED');self.assertEqual(self.f.claim.read_bytes(),before)
    def test_no_ack_or_pending_dispatch_cannot_use_preconfig_return(self):
        (self.stage/'launch.ack.json').unlink()
        with self.assertRaises(FileNotFoundError):self.verify()
        self.assertTrue(self.f.claim.exists())
    def test_wrong_run_ack_even_with_rehashed_terminal_refuses(self):
        self.ack['run_token']='other';self.write(self.stage/'launch.ack.json',self.ack);self.terminal()
        with self.assertRaises(ValueError):self.verify()
    def test_alias_or_changed_native_pair_refuses(self):
        self.after.unlink();os.link(self.before,self.after)
        with self.assertRaises(ValueError):self.verify()
        self.after.unlink();self.write(self.after,dict(self.f.native,state='started'))
        with self.assertRaises(ValueError):self.verify()
    def test_corrupt_runtime_manifest_member_refuses(self):
        (self.out/'remote-logs/runtime-evidence/logs/worker.log').write_bytes(b'corrupt')
        with self.assertRaises(AssertionError):self.verify()
    def test_missing_shutdown_or_pending_runtime_refuses(self):
        (self.out/'guest-shutdown.confirmed').unlink()
        with self.assertRaises(FileNotFoundError):self.verify()
        (self.out/'guest-shutdown.confirmed').write_text('current\n');(self.out/'runtime-evidence.pending').write_text('pending')
        with self.assertRaises(ValueError):self.verify()
    def test_changed_volume_and_claim_refuse(self):
        self.write(self.vol,dict(self.f.volume,attached_machine_id='other'))
        with self.assertRaises(ValueError):self.verify()
        self.write(self.vol,self.f.volume);self.f.claim.write_text(self.f.claim.read_text().replace(self.f.owner,'0'*32))
        with self.assertRaises(ValueError):self.verify()
    def usage_pairs(self):
        return json.loads(SCRIPT.with_name('tests').joinpath('staged-return-volume-usage.fixture.json').read_text()).values()
    def test_actual_return_volume_usage_pairs(self):
        for pair in self.usage_pairs():
            self.h['validate_return_volume'](pair['original'], pair['current'])
    def test_usage_change_reaches_real_runtime_and_preserves_claim(self):
        pair=next(iter(self.usage_pairs()))
        original=dict(pair['original'], id=self.f.vol, attached_machine_id=self.f.mid)
        current=dict(pair['current'], id=self.f.vol, attached_machine_id=self.f.mid)
        self.write(self.stage/'volume-before.json',original);self.write(self.vol,current)
        before=self.f.claim.read_bytes()
        self.assertEqual(self.verify()['status'],'STOPPED_RUNTIME_VERIFIED')
        self.assertEqual(self.f.claim.read_bytes(),before)
        (self.out/'remote-logs/runtime-evidence/logs/worker.log').write_bytes(b'corrupt')
        with self.assertRaises(AssertionError):self.verify()
        self.assertEqual(self.f.claim.read_bytes(),before)
    def test_usage_counter_type_range_and_partial_refuse(self):
        pair=next(iter(self.usage_pairs()))
        for key,value in [('bytes_used',True),('blocks_free',-1),('blocks_avail',pair['original']['blocks']+1),('bytes_used',pair['original']['bytes_total']+1),('blocks_free',1.5)]:
            current=dict(pair['current']);current[key]=value
            with self.assertRaises(ValueError):self.h['validate_return_volume'](pair['original'],current)
        original=dict(pair['original']);current=dict(pair['current'])
        del original['bytes_used'];del current['bytes_used']
        with self.assertRaises(ValueError):self.h['validate_return_volume'](original,current)
    def test_volume_identity_capacity_and_unknown_fields_stay_exact(self):
        pair=next(iter(self.usage_pairs()))
        for key,value in [('id','other'),('attached_machine_id','other'),('blocks',1),('bytes_total',1),('encrypted',False),('state','destroyed'),('region','other'),('future_field',1)]:
            current=dict(pair['current']);current[key]=value
            with self.assertRaises(ValueError):self.h['validate_return_volume'](pair['original'],current)
    def test_usage_is_not_required_when_absent_in_both_old_records(self):
        self.h['validate_return_volume'](self.f.volume,self.f.volume)

    def audit_refresh(self, corrupt=None, transport="staged"):
        value=self.verify();self.h['record'](value,self.f.common)
        immutable=(self.stage/'return.json').read_bytes();proof_before=self.f.proof.read_bytes()
        if corrupt:corrupt()
        fleet=Path(os.environ.get('STAGED_REFRESH_FLEET_SOURCE',str(SCRIPT.with_name('run-bench-fleet')))).read_text()
        names=('pool_verify_reuse_proof','pool_native_reuse_proof','fleet_verify_staged_primary_return','fleet_audit_record_pool_machine','pool_claim_fs_transaction','fleet_record_staged_primary_release')
        functions='\n'.join(re.search(r'^'+name+r'\(\).*?^}\n',fleet,re.M|re.S).group() for name in names)
        inventory=SCRIPT.with_name('lib')/'cloudbench-inventory.sh'
        functions+='\n'+re.search(r'^registry_meta_value\(\).*?^}\n',inventory.read_text(),re.M|re.S).group()
        fake=self.f.root/'fake-campaign.py';fake.write_text('import os\ndef fetch(*args):\n return open(os.environ["BEFORE"]).read()\n')
        functions=functions.replace('"$CLOUDBENCH_SCRIPT_SNAPSHOT/cloudbench-campaign-machines.py"',str(fake))
        audit=self.f.root/'refresh-audit';audit.mkdir()
        claim=dict(line.split('=',1)for line in self.f.claim.read_text().splitlines())
        shell=r'''set -e
CHILD_MACHINE=("$MID"); CHILD_OUT=("$OUT")
fleet_preconfig_native_read(){ cp "$BEFORE" "$2"; }
fleet_cold_handoff_volume_read(){ cp "$VOLUME" "$2"; }
cloudbench_env_sha256(){ sha256sum "$1" | cut -d' ' -f1; }
pool_reuse_proof_file(){ printf '%s/cloudbench-pool-reuse/%s.json' "$GIT_COMMON_DIR" "$1"; }
'''+functions+r'''
fleet_audit_record_pool_machine "$MID" "$VOL" claimed
fleet_audit_record_pool_machine "$MID" "$VOL" returned-stopped-claim-released
pool_claim_fs_transaction release "$CLAIM" "$MID" "$CLAIM_SHA" "$CLAIM_HOST" "$CLAIM_PID" "$CLAIM_BIRTH" "$FLEET_OWNER_TOKEN"
fleet_record_staged_primary_release "$MID"
'''
        env=dict(os.environ,MID=self.f.mid,VOL=self.f.vol,OUT=str(self.out),BEFORE=str(self.before),VOLUME=str(self.vol),CLAIM=str(self.f.claim),CLAIM_SHA=mod.sha(self.f.claim.read_bytes()),CLAIM_HOST=claim['host'],CLAIM_PID=claim['pid'],CLAIM_BIRTH=claim['pid_start'],CLOUDBENCH_BOOT_TRANSPORT=transport,POOL_COLD_BOOTSTRAP='1',APP='app',CLOUDBENCH_SCRIPT_SNAPSHOT=str(SCRIPT.parent),FLEET_REGISTRY_DIR=str(self.registry),GIT_COMMON_DIR=str(self.f.common),BENCH_REF=self.source,FLEET_OWNER_TOKEN=self.f.owner,FLEET_TEARDOWN_OWNERSHIP_DIR=str(audit),RUN_ID='current',POOL_IDS_FILE=self.f.request['consumer']['pool_ids_file'],POOL_META_FILE=self.f.request['consumer']['pool_meta_file'])
        result=subprocess.run(['bash','-c',shell],env=env,capture_output=True,text=True)
        self.assertEqual((self.stage/'return.json').read_bytes(),immutable);self.assertEqual(self.f.proof.read_bytes(),proof_before)
        return result,claim
    def test_actual_audit_refresh_release_and_next_claim(self):
        result,claim=self.audit_refresh();self.assertEqual(result.returncode,0,result.stderr);self.assertFalse(self.f.claim.exists())
        self.assertEqual(self.h['current_policy'](self.f.proof),'existing-git-reset-v1')
        fleet=SCRIPT.with_name('run-bench-fleet').read_text();fn=re.search(r'^pool_claim_fs_transaction\(\).*?^}\n',fleet,re.M|re.S).group()
        args=['bash','-c',fn+'\npool_claim_fs_transaction publish-ordinary "$@"','claim',str(self.f.claim),self.f.mid,self.f.vol,claim['host'],claim['pid'],claim['pid_start'],'a'*32,self.f.request['consumer']['pool_ids_file'],self.f.request['consumer']['pool_meta_file'],mod.sha(Path(self.f.request['consumer']['pool_meta_file']).read_bytes())]
        next_claim=subprocess.run(args,capture_output=True,text=True);self.assertEqual(next_claim.returncode,0,next_claim.stderr)
    def test_refresh_changed_native_keeps_claim_and_return(self):
        result,_=self.audit_refresh(lambda:self.write(self.before,dict(self.f.native,state='started')))
        self.assertNotEqual(result.returncode,0);self.assertTrue(self.f.claim.exists())
    def test_refresh_changed_runtime_keeps_claim_and_return(self):
        result,_=self.audit_refresh(lambda:(self.out/'remote-logs/runtime-evidence/logs/worker.log').write_bytes(b'changed'))
        self.assertNotEqual(result.returncode,0);self.assertTrue(self.f.claim.exists())
    def test_refresh_changed_claim_keeps_claim_and_return(self):
        result,_=self.audit_refresh(lambda:self.f.claim.write_text(self.f.claim.read_text().replace(self.f.owner,'e'*32)))
        self.assertNotEqual(result.returncode,0);self.assertTrue(self.f.claim.exists())
    def test_nonstaged_refresh_keeps_normal_config_guard(self):
        result,_=self.audit_refresh(transport='update')
        self.assertNotEqual(result.returncode,0);self.assertIn('line 32',result.stderr);self.assertTrue(self.f.claim.exists())
    def test_refresh_saved_receipt_tamper_refuses(self):
        result=self.verify();self.h['record'](result,self.f.common)
        saved=self.stage/'return.json';saved.write_bytes(saved.read_bytes()+b' ')
        with self.assertRaises(ValueError):self.h['verify_existing_return'](self.verify(),self.f.common)

    def test_nonstaged_provenance_cannot_borrow_new_proof(self):
        c=runpy.run_path(str(SCRIPT.with_name('cloudbench_execution_provenance.py')))
        values=self.provenance['config']['values'];values.pop('boot_transport')
        self.provenance['config']=c['build_config'](c['CONFIG_SCHEMA_VERSION'],[k+'='+v for k,v in values.items()])
        self.write(self.run/'execution-provenance.json',self.provenance)
        with self.assertRaises(ValueError):self.verify()
    def test_canonical_release_enables_next_reuse_without_changing_admission(self):
        proof_before=self.f.proof.read_bytes();result=self.verify();self.h['record'](result,self.f.common)
        with self.assertRaises(FileNotFoundError):self.h['current_policy'](self.f.proof)
        fleet=SCRIPT.with_name('run-bench-fleet').read_text();fn=re.search(r'^pool_claim_fs_transaction\(\).*?^}\n',fleet,re.M|re.S).group()
        claim=dict(line.split('=',1) for line in self.f.claim.read_text().splitlines())
        args=['bash','-c',fn+'\npool_claim_fs_transaction release "$@"','release',str(self.f.claim),self.f.mid,result['claim_sha256'],claim['host'],claim['pid'],claim['pid_start'],claim['fleet_owner_token']]
        completed=subprocess.run(args,text=True,capture_output=True);self.assertEqual(completed.returncode,0,completed.stderr)
        self.h['released'](self.out,self.f.common,self.f.mid)
        self.assertEqual(self.h['current_policy'](self.f.proof),'existing-git-reset-v1');self.assertEqual(self.f.proof.read_bytes(),proof_before)
        # The same shared pool member may next be assigned as a worker. Its
        # original stage logic must consume the released primary reset policy.
        new_owner='a'*32
        args=['bash','-c',fn+'\npool_claim_fs_transaction publish-ordinary "$@"','claim',str(self.f.claim),self.f.mid,self.f.vol,claim['host'],claim['pid'],claim['pid_start'],new_owner,self.f.request['consumer']['pool_ids_file'],self.f.request['consumer']['pool_meta_file'],mod.sha(Path(self.f.request['consumer']['pool_meta_file']).read_bytes())]
        completed=subprocess.run(args,text=True,capture_output=True);self.assertEqual(completed.returncode,0,completed.stderr)
        self.f.row['claim_owner_token']=new_owner;self.f.row['claim_sha256']=mod.sha(self.f.claim.read_bytes());self.f.assignment.write_bytes(mod.canonical(self.f.row))
        stage=self.h['worker_stage'](self.f.assignment,self.source,self.f.dep['node'],self.f.dep['python'],'performance-1x','2048',self.f.api)
        self.assertEqual(stage['workspace_policy'],'existing-git-reset-v1')
        self.assertEqual(stage['native']['config']['guest'],dict(cpu_kind='performance',cpus=1,memory_mb=2048))
        (self.out/'remote-logs/runtime-evidence/stack.log').write_bytes(b'drift')
        with self.assertRaises(AssertionError):self.h['current_policy'](self.f.proof)
    def test_actual_claimed_cleanup_gate_refuses_corrupt_staged_return(self):
        fleet=SCRIPT.with_name('run-bench-fleet').read_text()
        wrapper=re.search(r'^fleet_verify_staged_primary_return\(\).*?^}\n',fleet,re.M|re.S).group()
        script=self.f.root/'cleanup-gate.sh'
        script.write_text('''set -u
CHILD_MACHINE=("$MID"); CHILD_OUT=("$OUT"); CLOUDBENCH_BOOT_TRANSPORT=staged
fleet_preconfig_native_read() { cp "$BEFORE" "$2"; }
fleet_cold_handoff_volume_read() { cp "$VOLUME" "$2"; }
'''+wrapper+'''
fleet_verify_staged_primary_return "$MID" "$VOL" && printf released
''')
        env=dict(os.environ,MID=self.f.mid,OUT=str(self.out),BEFORE=str(self.before),VOLUME=str(self.vol),VOL=self.f.vol,CLOUDBENCH_SCRIPT_SNAPSHOT=str(SCRIPT.parent),FLEET_REGISTRY_DIR=str(self.registry),GIT_COMMON_DIR=str(self.f.common),BENCH_REF=self.source)
        result=subprocess.run(['bash',str(script)],env=env,capture_output=True,text=True);self.assertEqual(result.returncode,0,result.stderr);self.assertIn('released',result.stdout)
        (self.stage/'launch.ack.json').unlink()
        result=subprocess.run(['bash',str(script)],env=env,capture_output=True,text=True);self.assertNotEqual(result.returncode,0);self.assertNotIn('released',result.stdout)
        self.assertTrue(self.f.claim.exists())
    def test_actual_flat_snapshot_transport_and_return_dependencies(self):
        source=SCRIPT.with_name('run-bench-fleet').read_text()
        start=source.index('|| ! cp "$ROOT_DIR/scripts/run-bench-fleet"')
        end=source.index('"$CLOUDBENCH_SCRIPT_SNAPSHOT/"; then',start)
        paths=re.findall(r'"\$ROOT_DIR/(scripts/[^"\n]+)"',source[start:end])
        flat=self.f.root/'flat-snapshot';flat.mkdir()
        for name in paths:shutil.copy2(SCRIPT.parent.parent/name,flat/Path(name).name)
        transport=runpy.run_path(str(flat/'cloudbench-staged-boot.py'))
        self.assertEqual(transport['native_binding'](self.f.native,self.f.volume,'shared-cpu-4x','8192'),self.f.vol)
        h=runpy.run_path(str(flat/'cloudbench-staged-boot-return.py'))
        result=h['verify'](self.out,self.registry,self.f.common,self.source,self.f.mid,self.f.vol,self.before,self.after,self.vol)
        self.assertEqual(result['status'],'STOPPED_RUNTIME_VERIFIED')


@unittest.skipUnless(os.geteuid()==0,'real publication and typed probe ownership')
class StagedProbeReturn(unittest.TestCase):
    write=StagedPrimaryReturn.write
    terminal=StagedPrimaryReturn.terminal
    verify=StagedPrimaryReturn.verify
    def setUp(self):
        StagedPrimaryReturn.setUp(self)
        (self.out/'runtime-evidence.owner.json').unlink();shutil.rmtree(self.out/'remote-logs')
        intent=json.loads((self.stage/'intent.json').read_bytes());intent.pop('files');intent['evidence_kind']='infra-probe'
        (self.stage/'boot.tar.gz').unlink()
        payload={n:b'fixture source' for n in ('cloudbench-boot.sh','cloudbench-status-server.py','cloudbench-boot-payload.py','cloudbench-boot-payload.json.gz')}
        archive_sha,intent=self.transport['bundle'](self.stage/'boot.tar.gz',dict(REF=self.source,CLOUDBENCH_RUN_TOKEN=self.token,CLOUDBENCH_BOOT='1',CLOUDBENCH_INFRA_PROBE='1'),payload,intent)
        self.write(self.stage/'intent.json',intent);self.write(self.stage/'payload.json',dict(archive_sha256=archive_sha,bytes=(self.stage/'boot.tar.gz').stat().st_size))
        self.ack.update(evidence_kind='infra-probe',archive_sha256=archive_sha,intent_sha256=mod.sha((self.stage/'intent.json').read_bytes()))
        self.write(self.stage/'launch.ack.json',self.ack);self.terminal();term=json.loads((self.stage/'terminal.json').read_bytes());term['evidence_kind']='infra-probe';self.write(self.stage/'terminal.json',term)
        self.write(self.out/'staged-probe.owner.json',dict(schema='cloudbench-staged-probe-owner-v1',app='app',machine_id=self.f.mid,run_token=self.token,source_ref=self.source,infra_probe=True,runtime_success=False))
        c=runpy.run_path(str(SCRIPT.with_name('cloudbench_execution_provenance.py')));values=self.provenance['config']['values'];values['infra_probe']='1'
        self.provenance['config']=c['build_config'](c['CONFIG_SCHEMA_VERSION'],[k+'='+v for k,v in values.items()]);self.write(self.run/'execution-provenance.json',self.provenance)
        # Execute the actual existing probe artifact producer snippets.
        source=SCRIPT.with_name('cloudbench-run.sh').read_text()
        code=re.search(r"PROBE_TASKS_JSON=.*?python3 -c '\n(.*?)\n'\)",source,re.S).group(1)
        env=dict(os.environ,PROBE_WMM='real',PROBE_TS='2026-10-16T00:00:00Z')
        result=json.loads(subprocess.run(['python3','-c',code],input='parallel-tool-calls\n',text=True,capture_output=True,check=True,env=env).stdout)
        self.write(self.out/'cloudbench-run.json',c['stamp_run_document'](result,self.provenance))
        code=re.search(r"PROBE_CARD_JSON=.*?python3 -c '\n(.*?)\n'\)",source,re.S).group(1)
        card=json.loads(subprocess.run(['python3','-c',code],input='parallel-tool-calls\n',text=True,capture_output=True,check=True).stdout);self.write(self.out/'cloudbench-report-card.json',card)
        for name,value in [('benchmark-child.finished','0\n'),('barrier.ready.observed',''),('autoscaler.completed-after-child',''),('desired-worker-count','0\n')]:
            (self.out/name).write_text(value)
    audit_refresh=StagedPrimaryReturn.audit_refresh
    def test_probe_actual_audit_refresh_release(self):
        result,_=self.audit_refresh();self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(self.h['current_policy'](self.f.proof),'existing-git-reset-v1');self.assertFalse(self.f.claim.exists())
    def test_actual_probe_artifacts_return_without_real_task_credit(self):
        value=self.verify();self.assertEqual(value['schema'],'cloudbench-staged-probe-return-v1');self.assertEqual(value['real_task_credit'],0);self.assertNotIn('runtime_manifest',value)
        self.h['record'](value,self.f.common)
        fleet=SCRIPT.with_name('run-bench-fleet').read_text();fn=re.search(r'^pool_claim_fs_transaction\(\).*?^}\n',fleet,re.M|re.S).group();claim=dict(line.split('=',1) for line in self.f.claim.read_text().splitlines())
        r=subprocess.run(['bash','-c',fn+'\npool_claim_fs_transaction release "$@"','release',str(self.f.claim),self.f.mid,value['claim_sha256'],claim['host'],claim['pid'],claim['pid_start'],claim['fleet_owner_token']],capture_output=True,text=True);self.assertEqual(r.returncode,0,r.stderr)
        self.h['released'](self.out,self.f.common,self.f.mid);self.assertEqual(self.h['current_policy'](self.f.proof),'existing-git-reset-v1')
        owner=json.loads((self.out/'staged-probe.owner.json').read_bytes());owner['runtime_success']=True;self.write(self.out/'staged-probe.owner.json',owner)
        with self.assertRaises(ValueError):self.h['current_policy'](self.f.proof)
    def test_probe_cannot_supply_fabricated_real_owner(self):
        self.write(self.out/'runtime-evidence.owner.json',dict(version=1,machine_id=self.f.mid,run_token=self.token))
        with self.assertRaises(ValueError):self.verify()
    def test_missing_typed_owner_refuses(self):
        (self.out/'staged-probe.owner.json').unlink()
        with self.assertRaises(FileNotFoundError):self.verify()
    def test_failed_probe_child_refuses(self):
        (self.out/'benchmark-child.finished').write_text('125\n')
        with self.assertRaises(ValueError):self.verify()
    def test_missing_barrier_or_shutdown_refuses(self):
        (self.out/'barrier.ready.observed').unlink()
        with self.assertRaises(FileNotFoundError):self.verify()
        (self.out/'barrier.ready.observed').write_bytes(b'');(self.out/'guest-shutdown.confirmed').unlink()
        with self.assertRaises(FileNotFoundError):self.verify()
    def test_real_or_foreign_result_cannot_be_probe(self):
        path=self.out/'cloudbench-run.json';value=json.loads(path.read_bytes());value['infra_probe']=False;self.write(path,value)
        with self.assertRaises(ValueError):self.verify()
        value['infra_probe']=True;value['tasks'][0]['name']='foreign';self.write(path,value)
        with self.assertRaises(ValueError):self.verify()
    def test_probe_worker_allocation_refuses(self):
        (self.out/'worker-clones.ids').write_text('some-worker\n')
        with self.assertRaises(ValueError):self.verify()



@unittest.skipUnless(os.geteuid()==0,'root publication/claim boundary')
class StagedWorkerShape(unittest.TestCase):
    def setUp(self):
        self.f=Worker();self.f.setUp();self.addCleanup(self.f.doCleanups)
        self.h=runpy.run_path(str(SCRIPT.with_name('cloudbench-staged-boot-return.py')))
    def stage(self,size='performance-1x',memory='2048',transport='staged'):
        with mock.patch.dict(os.environ,CLOUDBENCH_BOOT_TRANSPORT=transport):
            return self.h['worker_stage'](self.f.assignment,self.f.request['consumer']['source_ref'],self.f.dep['node'],self.f.dep['python'],size,memory,self.f.api)
    def test_wrong_shape_refuses_before_any_post(self):
        self.f.prepare()
        with self.assertRaisesRegex(ValueError,'shape'):self.stage()
        self.assertFalse(any(x[0]=='POST'for x in self.f.calls));self.assertTrue(self.f.claim.exists())
    def test_exact_shape_preserves_stage_and_no_post(self):
        self.f.prepare();value=self.stage('shared-cpu-4x','8192')
        self.assertEqual(value['status'],'STOPPED_STAGED');self.assertFalse(any(x[0]=='POST'for x in self.f.calls))
    def test_nonstaged_resize_unchanged(self):
        self.f.prepare();self.stage(transport='config');self.assertEqual(sum(x[0]=='POST'for x in self.f.calls),1)
    def test_exact_shape_metadata_filter(self):
        self.f.prepare();self.assertFalse(self.h['worker_shape_matches'](self.f.proof,'performance-1x','2048'));self.assertTrue(self.h['worker_shape_matches'](self.f.proof,'shared-cpu-4x','8192'))
    def test_actual_matching_claim_stage_return(self):
        self.f.test_actual_worker_cli_claim_stage_return_and_next_claim(transport='staged',size='shared-cpu-4x',memory='8192',expected_posts=0)
    def test_actual_wrong_shape_skipped_before_claim(self):
        self.f.prepare();self.f.claim.unlink();self.f.assignment.unlink()
        fleet=SCRIPT.with_name('run-bench-fleet').read_text()
        fn=lambda n:re.search(r'^'+n+r'\(\).*?^}\n',fleet,re.M|re.S).group()
        shell='\n'.join(fn(n)for n in ('pool_claim_fs_transaction','write_pool_claim','claim_explicit_idle_worker'))
        shell+="""
python3(){
 if [ "$1" = "$STAGED_HELPER" ] && [ "$2" = worker-stage ]; then : > "$BAD_STAGE"; return 91; fi
 command python3 "$@"
}
cloudbench_env_sha256(){ sha256sum "$1" | cut -d' ' -f1; }
cloudbench_fsync_directory(){ return 0; }
pool_claim_mark_cleanup_unconfirmed(){ return 0; }
FLEET_OWNER_PID_START="$(command python3 -c 'import runpy,sys;h=runpy.run_path(sys.argv[1]);print(h["bash_lib"]("cloudbench-env.sh",["cloudbench_pid_start_time",sys.argv[2]]))' "$VOLUME_HELPER" "$$")"
claim_explicit_idle_worker "$OUT" primary repo current-token ::1
"""
        bad=self.f.root/'bad-stage'
        env=dict(os.environ,OUT=str(self.f.out),BAD_STAGE=str(bad),STAGED_HELPER=str(SCRIPT.with_name('cloudbench-staged-boot-return.py')),VOLUME_HELPER=str(SCRIPT.with_name('cloudbench-original-volume-capture.py')),GIT_COMMON_DIR=str(self.f.common),POOL_IDS_FILE=self.f.request['consumer']['pool_ids_file'],POOL_META_FILE=self.f.request['consumer']['pool_meta_file'],POOL_CLAIMS_DIR=str(self.f.common/'cloudbench-pool-claims'),POOL_COLD_BOOTSTRAP='1',FLEET_OWNER_TOKEN='e'*32,FLEET_OWNER_HOST=mod.socket.gethostname(),CURRENT_NODE_FP=self.f.dep['node'],CURRENT_PY_FP=self.f.dep['python'],BENCH_REF=self.f.request['consumer']['source_ref'],FLEET_WORKER_VM_SIZE='performance-1x',FLEET_WORKER_VM_MEMORY='2048',APP='app',CLOUDBENCH_BOOT_TRANSPORT='staged',CLOUDBENCH_SCRIPT_SNAPSHOT=str(SCRIPT.parent))
        result=subprocess.run(['bash','-c',shell],env=env,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(result.stdout,'');self.assertFalse(self.f.claim.exists());self.assertFalse(bad.exists())

class PoolInventoryIndex(unittest.TestCase):
    def functions(self):
        text=SCRIPT.with_name('run-bench-fleet').read_text()
        names=['pool_machine_state_from_json','pool_machine_inventory_index','pool_machine_indexed_state','reconcile_pool']
        return '\n'.join(re.search(r'^'+n+r'\(\).*?^}\n',text,re.M|re.S).group() for n in names if re.search(r'^'+n+r'\(\)',text,re.M))
    def run_full(self, inventory, rows, *, extra=''):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);common=root/'common';pools=common/'cloudbench-pools';pools.mkdir(parents=True)
            for n,ids in enumerate(rows):(pools/f'{n}.ids').write_text(''.join(i+'\n'for i in ids))
            native=root/'native.json';native.write_text(json.dumps(inventory));counter=root/'parses';counter.write_text('')
            shell='set -uo pipefail\n'+self.functions()+r'''
python3(){ printf x >> "$COUNT"; command python3 "$@"; }
FLY(){ [ "$1 $2" = 'machines list' ] || return 91; cat "$NATIVE"; }
UNAVAILABLE_POOL_IDS=()
reconcile_pool || exit $?
printf 'UNAVAILABLE=%s\n' "${UNAVAILABLE_POOL_IDS[*]}"
'''+extra
            env=dict(os.environ,GIT_COMMON_DIR=str(common),POOL_IDS_FILE=str(pools/'0.ids'),POOL_CLAIMS_DIR=str(common/'claims'),APP='fixture',NATIVE=str(native),COUNT=str(counter),CLOUDBENCH_CAMPAIGN_INVENTORY_DIR='',PRIVATE_SOURCE_ID='')
            before={p.name:p.read_bytes()for p in pools.iterdir()}
            r=subprocess.run(['bash','-c',shell],env=env,capture_output=True,text=True,timeout=30)
            self.assertEqual({p.name:p.read_bytes()for p in pools.iterdir()},before)
            return r,len(counter.read_text())
    def test_full_403_rows_parse_once_and_preserve_ledgers(self):
        ids=[f'{i:014x}' for i in range(1,404)]
        inventory=[dict(id=f'{i:014x}',state='stopped')for i in range(1,987)]
        r,count=self.run_full(inventory,[ids[:200],ids[200:],ids[:7]])
        self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(count,1);self.assertEqual(r.stdout,'UNAVAILABLE=\n')
    def test_full_reconcile_duplicate_first_match_and_absence(self):
        r,count=self.run_full([dict(id='a',state='stopped'),dict(id='a',state='started')],[['a','missing']])
        self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(count,1);self.assertEqual(r.stdout,'UNAVAILABLE=\n')
    def test_full_reconcile_invalid_inventory_refuses(self):
        for value in ({},[dict(id='a',state='stopped'),1],[dict(id='a',state='')],[dict(id='a',state=None)]):
            with self.subTest(value=value):
                r,_=self.run_full(value,[['a']]);self.assertNotEqual(r.returncode,0);self.assertIn('could not read pool machine a',r.stderr)
    def test_full_reconcile_preserves_unknown_state_refusal(self):
        r,_=self.run_full([dict(id='a',state='surprise')],[['a']]);self.assertNotEqual(r.returncode,0);self.assertIn("unsafe pre-refresh state 'surprise'",r.stderr)
    def test_each_reconciliation_rebuilds_snapshot(self):
        extra=r'''
printf '[{"id":"a","state":"started"}]' > "$NATIVE"
reconcile_pool || exit $?
printf 'SECOND=%s\n' "${UNAVAILABLE_POOL_IDS[*]}"
'''
        r,count=self.run_full([dict(id='a',state='stopped')],[['a']],extra=extra)
        self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(count,2);self.assertIn('SECOND=a',r.stdout)
    def test_empty_ledger_keeps_lazy_inventory_validation(self):
        r,count=self.run_full({'invalid':'but never looked up'},[['   ']])
        self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(count,0)
    def test_original_lookup_status_and_output_parity(self):
        cases=[([], 'missing'),([dict(id='a',state='stopped')],'a'),([dict(id='a',state=''),dict(id='a',state='stopped')],'a'),([dict(id='a',state='started'),dict(id='a',state='stopped')],'a'),([dict(id='a',state='x\n\n')],'a'),([dict(id='a',state='x\0y')],'a'),([dict(id=['a'],state='stopped'),dict(id='a',state=8)],'a')]
        for value,target in cases:
            with tempfile.TemporaryDirectory()as tmp:
                native=Path(tmp)/'native';native.write_text(json.dumps(value))
                script='set -uo pipefail\n'+self.functions()+r'''
pool_inventory_ids=();pool_inventory_status=();pool_inventory_states=()
pool_machine_inventory_index "$(cat "$1")" || exit $?
a="$(cat "$1" | pool_machine_state_from_json "$2")"; ar=$?
b="$(pool_machine_indexed_state "$2")"; br=$?
[ "$ar" = "$br" ] && [ "$a" = "$b" ]
'''
                r=subprocess.run(['bash','-c',script,'_',str(native),target],capture_output=True,text=True)
                self.assertEqual(r.returncode,0,(value,r.stderr))


@unittest.skipUnless(os.geteuid()==0,'canonical dead-owner publication recovery')
class StagedDeadProbeRecovery(unittest.TestCase):
    def setUp(self):
        self.f=StagedProbeReturn();self.f.setUp();self.addCleanup(self.f.doCleanups)
        self.r=runpy.run_path(str(SCRIPT.with_name('cloudbench-staged-probe-recovery.py')))
        f=self.f;old=f.run;f.run=f.f.repo/'.context/fleet/runs/current';f.run.parent.mkdir(parents=True);shutil.move(old,f.run);f.out=f.run/'parallel-tool-calls';f.stage=f.out/'staged-boot';f.before=f.out/'before.json';f.after=f.out/'after.json';f.vol=f.out/'volume.json'
        self.child=subprocess.Popen(['sleep','60']);self.addCleanup(self.join_child)
        birth=self.birth(self.child.pid);meta=dict(line.split('=',1)for line in (f.registry/'meta').read_text().splitlines());meta.update(version='2',pid=str(self.child.pid),pid_start=birth,cleanup_policy='reap',workspace_root=str(f.f.repo),runs_root=str(f.run.parent),audit_dir=str(f.f.common/'cloudbench-fleet-audits'/f.f.owner))
        self.write_fields(f.registry/'meta',meta)
        claim=dict(line.split('=',1)for line in f.f.claim.read_text().splitlines());claim.update(pid=str(self.child.pid),pid_start=birth);self.write_fields(f.f.claim,claim)
        audit=Path(meta['audit_dir']);audit.mkdir(parents=True)
        for name in ('fresh','expected-fresh','by-machine-id','pool'): (audit/name).mkdir()
        (f.registry/'clones').mkdir()
        self.write_fields(audit/'meta',dict(fleet_owner_token=f.f.owner,app='app',run_id='current'))
        for name in ('owned-clones.ids','owned-clones.names'):(audit/name).write_bytes(b'')
        row=dict(version='1',fleet_owner_token=f.f.owner,run_id='current',app='app',source='borrowed-pool',machine_id=f.f.mid,volume_id=f.f.vol,pool_ledger_file=f.f.request['consumer']['pool_ids_file'],pool_meta_file=f.f.request['consumer']['pool_meta_file'],pool_meta_sha256=mod.sha(Path(f.f.request['consumer']['pool_meta_file']).read_bytes()),disposition='claimed');self.write_fields(audit/'pool'/f.f.mid,row)
        barrier=f.run/'.boot-config-barrier';barrier.mkdir();(barrier/'ready').mkdir();(barrier/'release').write_bytes(b'')
        (f.run/'_batch').mkdir();f.write(f.run/'_batch/lifecycle.json',dict(status='failed',fleet_owner_token=f.f.owner,run_id='current',controller_exit_code=1));f.write(f.run/'_batch/benches.json',[dict(name='parallel-tool-calls',mode='REAL')])
        f.h['record'](f.verify(),f.f.common);self.original=(f.stage/'return.json').read_bytes();self.lifecycle=(f.run/'_batch/lifecycle.json').read_bytes()
        self.guard_path=f.f.common/'cloudbench-fleet-recovery-locks'/f.f.owner;self.guard_path.parent.mkdir();self.fd=os.open(self.guard_path,os.O_CREAT|os.O_RDWR,0o600);fcntl.flock(self.fd,fcntl.LOCK_EX);self.addCleanup(os.close,self.fd)
        (f.registry/'recovery-lock').mkdir();self.recovery_birth=self.birth(os.getpid());self.write_fields(f.registry/'recovery-lock/meta',dict(host=mod.socket.gethostname(),pid=str(os.getpid()),pid_start=self.recovery_birth))
        self.calls=[]
    def birth(self,pid):
        return 'proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+Path('/proc/'+str(pid)+'/stat').read_text().split(') ',1)[1].split()[19]
    def join_child(self):
        if self.child.poll()is None:self.child.terminate()
        self.child.wait()
    def write_fields(self,path,value):path.write_text(''.join(k+'='+v+'\n'for k,v in value.items()))
    def recover(self,native=None):
        f=self.f
        def nr(mid):self.calls.append(('machine',mid));return copy.deepcopy(f.f.native if native is None else native)
        def vr(vid):self.calls.append(('volume',vid));return copy.deepcopy(f.f.volume)
        if os.environ.get('STAGED_DEAD_RECOVERY_OLD')=='1':return self.r['P']['plan'](f.registry,f.f.common,f.source)
        return self.r['recover'](f.registry,f.f.common,f.source,nr,vr,self.fd,os.getpid(),self.recovery_birth)
    def test_actual_dead_owner_archives_then_returns_without_rewriting_outcome(self):
        self.join_child();f=self.f;result=self.recover();self.assertEqual(result['status'],'RECOVERED_STOPPED_PROBES');self.assertEqual(len(self.calls),3);self.assertFalse(f.f.claim.exists())
        self.assertEqual((f.stage/'return.json').read_bytes(),self.original);self.assertEqual((f.run/'_batch/lifecycle.json').read_bytes(),self.lifecycle);self.assertEqual(f.h['current_policy'](f.f.proof),'existing-git-reset-v1')
        archive=json.loads((f.registry/'staged-probe-return-recovery/archive.json').read_bytes());self.assertEqual(archive['real_task_credit'],0);self.assertIn(str(f.f.claim),archive['plan']['originals'])
        fleet=SCRIPT.with_name('run-bench-fleet').read_text();fn=re.search(r'^pool_claim_fs_transaction\(\).*?^}\n',fleet,re.M|re.S).group();claim=dict(line.split('=',1)for line in base64.b64decode(archive['plan']['originals'][str(f.f.claim)]).decode().splitlines())
        args=['bash','-c',fn+'\npool_claim_fs_transaction publish-ordinary "$@"','claim',str(f.f.claim),f.f.mid,f.f.vol,claim['host'],str(os.getpid()),self.recovery_birth,'a'*32,f.f.request['consumer']['pool_ids_file'],f.f.request['consumer']['pool_meta_file'],mod.sha(Path(f.f.request['consumer']['pool_meta_file']).read_bytes())]
        done=subprocess.run(args,capture_output=True,text=True);self.assertEqual(done.returncode,0,done.stderr)
    def test_live_original_owner_refuses_before_reads(self):
        with self.assertRaisesRegex(ValueError,'not dead'):self.recover()
        self.assertEqual(self.calls,[]);self.assertTrue(self.f.f.claim.exists())
    def test_dead_owner_still_refused_by_normal_live_verifier(self):
        self.join_child()
        with self.assertRaisesRegex(ValueError,'owner state'):self.f.verify()
    def test_changed_fresh_native_refuses_retains_claim(self):
        self.join_child()
        with self.assertRaises(ValueError):self.recover(dict(self.f.f.native,state='started'))
        self.assertTrue(self.f.f.claim.exists());self.assertFalse((self.f.registry/'staged-probe-return-recovery/archive.json').exists())
    def test_changed_probe_result_refuses_retains_claim(self):
        self.join_child();(self.f.out/'benchmark-child.finished').write_text('125\n')
        with self.assertRaises(ValueError):self.recover()
        self.assertTrue(self.f.f.claim.exists())
    def test_replaced_claim_refuses_retains_claim(self):
        self.join_child();p=self.f.f.claim;p.write_text(p.read_text().replace(self.f.f.owner,'e'*32))
        with self.assertRaises(ValueError):self.recover()
        self.assertTrue(p.exists());self.assertEqual(self.calls,[])
    def test_wrong_guard_owner_refuses_before_reads(self):
        self.join_child();self.write_fields(self.f.registry/'recovery-lock/meta',dict(host=mod.socket.gethostname(),pid=str(os.getpid()),pid_start='wrong'))
        with self.assertRaises(ValueError):self.recover()
        self.assertEqual(self.calls,[])
    def test_fresh_allocation_or_missing_index_refuses(self):
        self.join_child();(self.f.registry/'clones/foreign').write_text('x')
        with self.assertRaises(ValueError):self.recover()
        self.assertEqual(self.calls,[])
    def test_canonical_dispatch_selects_probe_recovery_without_preconfig_fallback(self):
        fleet=SCRIPT.with_name('run-bench-fleet').read_text();start=fleet.index('    if [ "${RECOVER_PRIMARY_TO_POOL:-0}" = 1 ] && [ "${POOL_COLD_BOOTSTRAP:-0}" = 1 ]; then\n        local staged_return_candidate=')
        end=fleet.index('    for _evidence_output in ',fleet.index('    fi\n',start)+7)
        block=fleet[start:end]
        meta=re.search(r'^registry_meta_value\(\).*?^}\n',(SCRIPT.with_name('lib')/'cloudbench-inventory.sh').read_text(),re.M|re.S).group()
        shell=meta+'''
python3(){ printf '%s\n' "$1"; }
capacity_release_stale_owner_reservations(){ :; }
release_registry_recovery_lock(){ :; }
invoke(){ local meta="$REGISTRY/meta" registry="$REGISTRY" token="$TOKEN";
'''+block+'''
printf fallback
}
invoke
'''
        env=dict(os.environ,REGISTRY=str(self.f.registry),TOKEN=self.f.f.owner,RECOVER_PRIMARY_TO_POOL='1',POOL_COLD_BOOTSTRAP='1',CLOUDBENCH_SCRIPT_SNAPSHOT=str(SCRIPT.parent),GIT_COMMON_DIR=str(self.f.f.common),BENCH_REF=self.f.source,REGISTRY_RECOVERY_GUARD_FD=str(self.fd),FLEET_OWNER_PID_START=self.recovery_birth)
        result=subprocess.run(['bash','-c',shell],env=env,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr);self.assertIn('cloudbench-staged-probe-recovery.py',result.stdout);self.assertNotIn('fallback',result.stdout)
    def test_old_preconfig_recovery_refuses_executed_probe(self):
        self.join_child();barrier=self.f.run/'.boot-config-barrier';barrier.mkdir(exist_ok=True);(barrier/'release').write_bytes(b'')
        with self.assertRaisesRegex(ValueError,'barrier released'):self.r['P']['plan'](self.f.registry,self.f.f.common,self.f.source)
    def test_missing_claim_or_return_index_refuses_without_release(self):
        self.join_child();index=self.f.f.common/'cloudbench-staged-boot-returns'/(self.f.f.mid+'.json');raw=index.read_bytes();index.unlink()
        with self.assertRaises(FileNotFoundError):self.recover()
        self.assertTrue(self.f.f.claim.exists());index.write_bytes(raw);self.f.f.claim.unlink()
        with self.assertRaises(FileNotFoundError):self.recover()
        self.assertFalse((self.f.registry/'staged-probe-return-recovery').exists())
    def test_aliased_recovery_mutex_parent_refuses(self):
        self.join_child();parent=self.guard_path.parent;moved=parent.with_name('moved-recovery-locks');parent.rename(moved);parent.symlink_to(moved,target_is_directory=True)
        with self.assertRaises(ValueError):self.recover()
        self.assertEqual(self.calls,[]);self.assertTrue(self.f.f.claim.exists())
    def test_aliased_machine_mutex_parent_refuses(self):
        self.join_child();parent=self.f.f.common/'cloudbench-pool-claims/.locks';moved=parent.with_name('moved-machine-locks');parent.rename(moved);parent.symlink_to(moved,target_is_directory=True)
        with self.assertRaises(ValueError):self.recover()
        self.assertEqual(self.calls,[]);self.assertTrue(self.f.f.claim.exists())
    def test_failed_recovery_cannot_blind_retry(self):
        self.join_child()
        with self.assertRaises(ValueError):self.recover(dict(self.f.f.native,state='started'))
        with self.assertRaises(FileExistsError):self.recover()
        self.assertTrue(self.f.f.claim.exists())


@unittest.skipUnless(os.geteuid()==0, 'canonical worker publication fixture requires root')
class WorkerStageSnapshotToken(unittest.TestCase):
    def setUp(self):
        self.f=Worker();self.f.setUp();self.addCleanup(self.f.doCleanups);self.f.prepare()
        self.flat=self.f.root/'canonical-flat-snapshot';self.flat.mkdir()
        fleet=SCRIPT.with_name('run-bench-fleet').read_text()
        start=fleet.index('|| ! cp "$ROOT_DIR/scripts/run-bench-fleet"')
        end=fleet.index('"$CLOUDBENCH_SCRIPT_SNAPSHOT/"',start)
        paths=re.findall(r'"\$ROOT_DIR/([^"\n]+)"',fleet[start:end])
        self.assertIn('scripts/lib/cloudbench-inventory.sh',paths)
        for relative in paths:shutil.copy2(SCRIPT.parents[1]/relative,self.flat/Path(relative).name)
        self.assertFalse((self.flat/'lib').exists())
    def stage(self,folder):
        helper=runpy.run_path(str(folder/'cloudbench-staged-boot-return.py'));h=helper['H'];base=h['sibling']('cloudbench-original-volume-capture.py');seen=[];f=self.f
        class Fly:
            def __init__(self,app,token):seen.append((app,token))
            def api(self,*args,**kwargs):return f.api(*args,**kwargs)
        base['Fly']=Fly;original=h['sibling']
        def sibling(name):return base if name=='cloudbench-original-volume-capture.py'else original(name)
        argv=['staged','worker-stage','--assignment',str(f.assignment),'--source',f.request['consumer']['source_ref'],'--node',f.dep['node'],'--python',f.dep['python'],'--size','shared-cpu-4x','--memory','8192','--app','app']
        with mock.patch.dict(h['main'].__globals__,sibling=sibling),mock.patch.object(__import__('sys'),'argv',argv),mock.patch.dict(os.environ,FLY_BENCH_API_TOKEN='offline-worker-token-123456789',CLOUDBENCH_BOOT_TRANSPORT='staged'),mock.patch('sys.stdout',new_callable=__import__('io').StringIO)as output:
            helper['main']()
        self.assertEqual(seen,[('app','offline-worker-token-123456789')]);self.assertEqual(json.loads(output.getvalue())['status'],'STOPPED_STAGED');self.assertTrue(f.calls);self.assertTrue(all(c[0]=='GET'for c in f.calls))
    def test_actual_flat_snapshot_worker_stage(self):self.stage(self.flat)
    def test_repository_worker_stage(self):self.stage(SCRIPT.parent)
    def test_missing_flat_library_refuses(self):
        (self.flat/'cloudbench-inventory.sh').unlink();helper=runpy.run_path(str(self.flat/'cloudbench-original-volume-capture.py'))
        with self.assertRaises(helper['Refusal']):helper['resolve_token']({'workspace':str(self.f.repo)})
    def test_linked_flat_library_refuses(self):
        path=self.flat/'cloudbench-inventory.sh';path.unlink();path.symlink_to(SCRIPT.parent/'lib/cloudbench-inventory.sh');helper=runpy.run_path(str(self.flat/'cloudbench-original-volume-capture.py'))
        with self.assertRaises(helper['Refusal']):helper['resolve_token']({'workspace':str(self.f.repo)})
    def test_shell_source_failure_refuses(self):
        (self.flat/'cloudbench-inventory.sh').write_text('resolve_fly_token(){ echo should-not-run; }; return 42\n');helper=runpy.run_path(str(self.flat/'cloudbench-original-volume-capture.py'))
        with self.assertRaises(helper['Refusal']):helper['resolve_token']({'workspace':str(self.f.repo)})
    def test_repository_library_precedes_flat_name(self):
        scripts=self.f.root/'repository-scripts';(scripts/'lib').mkdir(parents=True)
        shutil.copy2(SCRIPT.with_name('cloudbench-original-volume-capture.py'),scripts/'cloudbench-original-volume-capture.py')
        (scripts/'lib/cloudbench-inventory.sh').write_text('resolve_fly_token(){ echo nested-canonical; }\n')
        (scripts/'cloudbench-inventory.sh').write_text('resolve_fly_token(){ echo wrong-layout; }\n')
        helper=runpy.run_path(str(scripts/'cloudbench-original-volume-capture.py'));self.assertEqual(helper['resolve_token']({'workspace':str(self.f.repo)}),'nested-canonical')


class ReuseProofAttemptRetirement(unittest.TestCase):
    """Cold explicit/imported proof checks retire their private native-read attempt."""

    def run_verify(self,kind,outcome):
        root=Path(tempfile.mkdtemp());self.addCleanup(shutil.rmtree,root,True)
        scratch=root/'tmp';scratch.mkdir();helpers=root/'helpers';helpers.mkdir()
        proof=root/'proof.json';proof.write_text(json.dumps({kind:{}}))
        body='raise SystemExit(7)' if outcome=='reject' else 'pass'
        (helpers/'cloudbench-explicit-idle-admission.py').write_text(
            'def descriptor(path): return path\ndef verify_pool(*args):\n    '+body+'\n')
        (helpers/'archive.py').write_text('def verify_imported_pool_proof(*args, native_volume):\n    '+body+'\n')
        fleet=SCRIPT.with_name('run-bench-fleet').read_text()
        function=re.search(r'^pool_verify_reuse_proof\(\).*?^}\n',fleet,re.M|re.S).group()
        script=f'''set -uo pipefail
POOL_COLD_BOOTSTRAP=1 GIT_COMMON_DIR=/nonexistent BENCH_REF=0
CLOUDBENCH_SCRIPT_SNAPSHOT={str(helpers)!r} STARTUP_FAILURE_ARCHIVE_HELPER={str(helpers/'archive.py')!r}
pool_reuse_proof_file() {{ printf '%s' {str(proof)!r}; }}
fleet_preconfig_native_read() {{ [ {outcome!r} != read-failure ] && printf '{{}}' > "$2"; }}
fleet_cold_handoff_volume_read() {{ printf '{{}}' > "$2"; }}
{function}
pool_verify_reuse_proof machine-fixture vol_fixture
'''
        result=subprocess.run(['bash','-c',script],env={**os.environ,'TMPDIR':str(scratch)},capture_output=True,text=True,timeout=60)
        return result,sorted(path.name for path in scratch.iterdir())

    def test_every_cold_proof_outcome_removes_its_attempt_directory(self):
        for kind in ('explicit_idle','imported_cold'):
            for outcome,expected in (('accept',0),('reject',1),('read-failure',1)):
                with self.subTest(kind=kind,outcome=outcome):
                    result,left=self.run_verify(kind,outcome)
                    self.assertEqual(result.returncode!=0,bool(expected),result.stderr)
                    self.assertEqual(left,[],result.stderr)

if __name__=='__main__':unittest.main()
