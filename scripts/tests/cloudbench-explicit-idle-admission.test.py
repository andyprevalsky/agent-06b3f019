#!/usr/bin/env python3
import copy
import ast
from unittest import mock
import fcntl
import importlib.util
import json
import os
import re
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
        preflight+='\n'+'\n'.join(function(n) for n in ('pool_machine_state_from_json','reconcile_pool','pool_machine_shape_from_json','normalize_current_pool_shape','pool_write_shape_hints'))
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
        intent_shell='\n'.join(function(n) for n in ('provision_primary_machine','primary_cold_bootstrap_requested'))
        intent_shell+='''
primary_vm_size_for_bench() { echo shared-cpu-4x; }
primary_vm_memory_for_bench() { echo 8192; }
bench_uses_default_pool_shape() { return 0; }
claim_pool_machine() { printf %s "$MID"; }
pool_reuse_proof_file() { printf '%s/cloudbench-pool-reuse/%s.json' "$GIT_COMMON_DIR" "$1"; }
provision_primary_machine task "$OUT" && primary_cold_bootstrap_requested "$OUT" "$MID"
'''
        env.update(POOL_COLD_BOOTSTRAP='1',FRESH_TARGET_REGION='',MID=self.mid,OUT=str(out),EXECUTION_TASK_MATRIX_FILE=str(matrix),RUN_ID='new-run',BENCH_REF=self.request['consumer']['source_ref'])
        intent=subprocess.run(['bash','-c',intent_shell],env=env,capture_output=True,text=True)
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


    def test_actual_worker_cli_claim_stage_return_and_next_claim(self):
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
h['stage_worker'](a.assignment,a.source,a.node,a.python,a.size,a.memory,api)
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
        shell='\n'.join(function(n) for n in ('pool_claim_fs_transaction','write_pool_claim','pool_claim_release_exact','claim_explicit_idle_worker','claim_reusable_worker','return_reusable_worker'))
        shell+='''
set -e
python3() {
 if [ "$1" = "$IDLE_HELPER" ] && [ "$2" = worker-stage ]; then
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
        env={**os.environ,'OUT':str(self.out),'MID':self.mid,'IDLE_HELPER':str(SCRIPT),'VOLUME_HELPER':str(SCRIPT.with_name('cloudbench-original-volume-capture.py')),'RUNNER':str(runner),'API_FIXTURE':str(fixture),'GIT_COMMON_DIR':str(self.common),'POOL_IDS_FILE':self.request['consumer']['pool_ids_file'],'POOL_META_FILE':self.request['consumer']['pool_meta_file'],'POOL_CLAIMS_DIR':str(self.common/'cloudbench-pool-claims'),'POOL_COLD_BOOTSTRAP':'1','FLEET_OWNER_TOKEN':'e'*32,'FLEET_OWNER_HOST':mod.socket.gethostname(),'CURRENT_NODE_FP':self.dep['node'],'CURRENT_PY_FP':self.dep['python'],'BENCH_REF':self.request['consumer']['source_ref'],'FLEET_WORKER_VM_SIZE':'performance-1x','FLEET_WORKER_VM_MEMORY':'2048','APP':'app'}
        result=subprocess.run(['bash','-c',shell],env=env,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(result.stdout,self.mid)
        calls=json.loads(fixture.with_suffix('.calls').read_text());self.assertEqual(sum(c[0]=='POST' for c in calls),1)
        self.assertEqual(json.loads(fixture.read_text())['native']['config']['guest'],dict(cpu_kind='performance',cpus=1,memory_mb=2048))
        self.assertEqual(mod.returned_state(self.proof)['native']['instance_id'],'worker-instance')
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


if __name__=='__main__':unittest.main()
