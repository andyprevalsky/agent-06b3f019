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
        self.env=dict(FLY_MACHINE_ID=self.controller,FLY_APP_NAME='app',CLOUDBENCH_IDLE_WORKSPACE=str(self.repo),CLOUDBENCH_IDLE_COMMON=str(self.common),CLOUDBENCH_IDLE_POOL_IDS=target['pool_ids_file'],CLOUDBENCH_IDLE_POOL_META=target['pool_meta_file'])
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


if __name__=='__main__':unittest.main()
