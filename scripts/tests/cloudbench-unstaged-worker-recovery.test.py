from pathlib import Path
import copy,json,os,runpy,socket,unittest,fcntl
from unittest.mock import patch
D=Path(__file__).resolve().parents[1];T=runpy.run_path(str(D/'tests/cloudbench-fixed-native-worker.test.py'))
@unittest.skipUnless(os.geteuid()==0,'canonical publication and recovery fixture')
class Recovery(unittest.TestCase):
 def setUp(self):
  self.consumer=T['Consumer']();self.consumer.setUp();self.addCleanup(self.consumer.doCleanups);self.C=T['Consumer'].setUp.__globals__['C'];self.f=self.consumer.f
  f=self.f;req,auth,fd=f.authority();a=json.loads(auth.read_bytes());a.update(app='navi-whisper-lux-bench',fixed_native_baseline_sha256=self.C['G']['BASELINE_SHA'],future_role='worker');auth.write_bytes(self.C['H']['canonical'](a));self.C['publish'](req,self.C['H']['sha'](req.read_bytes()),auth,self.C['H']['sha'](auth.read_bytes()),fd)
  self.h=runpy.run_path(str(D/'cloudbench-unstaged-worker-recovery.py'));self.h['plan'].__globals__['H']=self.C;self.h['recover'].__globals__['H']=self.C
  self.owner='d'*32;self.claimowner='c'*32;self.source=f.request['consumer']['source_ref'];self.registry=f.common/'cloudbench-fleet-ownership'/self.owner;self.registry.mkdir(parents=True)
  self.run=f.root/'workspace/.context/fleet/runs/original';self.out=self.run/'parallel-tool-calls';self.borrow=self.out/'worker-borrowed';self.borrow.mkdir(parents=True);self.attempt=self.borrow/('.admit-'+f.mid+'.fixture');self.attempt.mkdir();(self.attempt/'verified').write_bytes(b'')
  self.proof=f.common/'cloudbench-pool-reuse'/(f.mid+'.json');self.claim=f.common/'cloudbench-pool-claims'/f.mid;self.meta=dict(version='2',app='navi-whisper-lux-bench',fleet_owner_token=self.owner,host=socket.gethostname(),pid='99999999',pid_start='dead-parent',run_id='original',workspace_root=str(self.run.parent.parent.parent.parent),runs_root=str(self.run.parent),cleanup_policy='reap')
  (self.registry/'meta').write_text(''.join(k+'='+v+'\n' for k,v in self.meta.items()));self.write(self.run/'_batch/lifecycle.json',dict(status='failed',fleet_owner_token=self.owner,run_id='original',controller_exit_code=1))
  c=runpy.run_path(str(D/'cloudbench_execution_provenance.py'));matrix=c['build_task_matrix'](['parallel-tool-calls=real']);cfg=c['build_config'](c['CONFIG_SCHEMA_VERSION'],['task_count=1','task_matrix_sha256='+matrix['sha256'],'boot_launch=1','primary_reuse_only=1','cold_primary_bootstrap=1','boot_transport=staged','worker_qualification_floor=2']);self.write(self.run/'execution-provenance.json',dict(schema_version=c['EXECUTION_SCHEMA_VERSION'],base_sha=self.source,workspace_patch_sha256='none',controller_snapshot=dict(schema_version=c['SNAPSHOT_SCHEMA_VERSION'],sha256='f'*64),config=cfg));self.write(self.run/'execution-task-matrix.json',matrix)
  (self.out/'.cid').write_text('pool primary\n');self.write(self.out/'runtime-evidence.owner.json',dict(version=1,machine_id='primary',run_token=self.owner+'-0'));(self.out/'autoscaler.pid').write_text('99999998|dead-auto\n');(self.out/'autoscaler.failed').write_text('Existing worker admission is unresolved; ownership retained\n');(self.out/'autoscaler.log').write_text('cloudbench-explicit-idle-admission.py\nresolve_fly_token failed (exit 127)\n')
  for name in ('worker-clones.ids','worker-ready.ids'):(self.out/name).write_bytes(b'')
  ledger=Path(f.request['consumer']['pool_ids_file']);baseline=Path(str(ledger)+'.deps');self.original=(f"host={self.meta['host']}\npid=99999999\npid_start=dead-parent\nfleet_owner_token={self.claimowner}\ncleanup_state=owned\nmachine_id={f.mid}\nvolume_id={f.vol}\npool_ledger_file={ledger}\npool_meta_file={baseline}\npool_meta_sha256={self.h['sha'](baseline.read_bytes())}\n").encode();self.claim.write_bytes(self.original)
  self.assignment=self.borrow/(f.mid+'.json');self.write(self.assignment,dict(version=1,origin='explicit-user-idle-resource',historical_task_credit=0,role='borrowed-worker',machine_id=f.mid,volume_id=f.vol,fleet_owner_token=self.owner,claim_owner_token=self.claimowner,claim_sha256=self.h['sha'](self.original),primary_machine_id='primary',run_token=self.owner+'-0',admission=str(self.attempt),proof=str(self.proof),ledger=str(ledger),previous_state_sha256=None))
  self.patcher=patch.dict(self.h['P']['pid_birth_state'].__globals__,{})
  self.oldpid=self.h['P']['pid_birth_state'];self.h['P']['pid_birth_state']=lambda pid,birth:'absent'
  self.addCleanup(lambda:self.h['P'].__setitem__('pid_birth_state',self.oldpid));self.h['R']['guard']=lambda *args:None
  lock=f.common/'cloudbench-pool-claims/.locks'/(f.mid+'.lock');lock.parent.mkdir(exist_ok=True);lock.touch();self.native=self.C['H']['described'](f.request['native_before']);self.volume=self.C['H']['described'](f.request['volume'])
 def write(self,p,v):p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(json.dumps(v,sort_keys=True,separators=(',',':')).encode())
 def plan(self):return self.h['plan'](self.registry,self.f.common,self.source)
 def recover(self):return self.h['recover'](self.registry,self.f.common,self.source,lambda mid:copy.deepcopy(self.native),lambda vid:copy.deepcopy(self.volume),3,1,'live')
 def test_actual_plan_original_claim(self):self.assertEqual(self.plan()['claim_sha256'],self.h['sha'](self.original))
 def test_unconfirmed_cleanup_successor_and_release(self):
  self.claim.write_text(f"host={self.meta['host']}\npid=99999999\npid_start=dead-parent\nfleet_owner_token={self.claimowner}\ncleanup_state=unconfirmed\n");oldproof=self.proof.read_bytes();oldlife=(self.run/'_batch/lifecycle.json').read_bytes();r=self.recover();self.assertEqual(r['status'],'RECOVERED_NOT_LAUNCHED');self.assertFalse(self.claim.exists());self.assertEqual(self.proof.read_bytes(),oldproof);self.assertEqual((self.run/'_batch/lifecycle.json').read_bytes(),oldlife);self.assertFalse((self.borrow/(self.f.mid+'.returned.json')).exists())
 def test_live_owner_refuses(self):
  self.h['P']['pid_birth_state']=lambda *a:'live'
  with self.assertRaisesRegex(ValueError,'not dead'):self.plan()
 def test_live_autoscaler_refuses(self):
  self.h['P']['pid_birth_state']=lambda pid,birth:'live'if birth=='dead-auto'else'absent'
  with self.assertRaisesRegex(ValueError,'not joined'):self.plan()
 def test_stage_attempt_refuses(self):
  (self.attempt/'stage.attempt.json').write_text('{}')
  with self.assertRaisesRegex(ValueError,'stage attempted'):self.plan()
 def test_worker_runtime_refuses(self):
  (self.out/'worker-runtime-evidence'/self.f.mid).mkdir(parents=True)
  with self.assertRaisesRegex(ValueError,'runtime'):self.plan()
 def test_wrong_claim_refuses(self):
  self.claim.write_bytes(self.original.replace(b'cleanup_state=owned',b'cleanup_state=foreign'))
  with self.assertRaisesRegex(ValueError,'current claim'):self.plan()
 def test_wrong_assignment_digest_refuses(self):
  a=json.loads(self.assignment.read_bytes());a['claim_sha256']='0'*64;self.write(self.assignment,a)
  with self.assertRaisesRegex(ValueError,'rich claim'):self.plan()
 def test_native_drift_keeps_claim(self):
  self.native['config']['guest']['cpus']=99
  with self.assertRaises(ValueError):self.recover()
  self.assertTrue(self.claim.exists())
 def test_volume_drift_keeps_claim(self):
  self.volume['attached_machine_id']='foreign'
  with self.assertRaises(ValueError):self.recover()
  self.assertTrue(self.claim.exists())
 def test_canonical_guard_rejects_wrong_fd(self):
  real=runpy.run_path(str(D/'cloudbench-staged-probe-recovery.py'))
  with self.assertRaises((ValueError,OSError,FileNotFoundError)):real['guard'](self.registry,self.f.common,0,os.getpid(),'x')
 def test_old_return_refuses_unstaged_assignment(self):
  with self.assertRaises((ValueError,FileNotFoundError)):self.C['verify_worker_return'](self.assignment,self.f.root/'before',self.f.root/'after',self.f.root/'volume')
  self.assertTrue(self.claim.exists());self.assertEqual(self.recover()['status'],'RECOVERED_NOT_LAUNCHED')
 def test_original_pool_remains_verifiable_after_recovery(self):
  self.recover();before=self.f.save(self.native);after=self.f.save(self.native)
  self.C['verify_pool'](self.proof,self.f.common,before,after,self.source,self.volume,role='worker');self.assertFalse(self.claim.exists())
 def test_unknown_attempt_file_refuses(self):
  (self.attempt/'unexpected').write_text('')
  with self.assertRaisesRegex(ValueError,'stage attempted'):self.plan()
 def test_after_archive_failure_keeps_claim_and_pending(self):
  def fail(stage):raise RuntimeError('simulated archive boundary')
  with self.assertRaises(RuntimeError):self.h['recover'](self.registry,self.f.common,self.source,lambda mid:copy.deepcopy(self.native),lambda vid:copy.deepcopy(self.volume),3,1,'live',checkpoint=fail)
  self.assertTrue(self.claim.exists());r=self.registry/('unstaged-worker-recovery-'+self.f.mid);self.assertTrue((r/'archive.json').exists());self.assertTrue((r/'pending.json').exists());self.assertFalse((r/'complete.json').exists())
 def test_foreign_proof_keeps_claim(self):
  proof=json.loads(self.proof.read_bytes());proof['machine_id']='foreign';self.write(self.proof,proof)
  with self.assertRaisesRegex(ValueError,'proof identity'):self.plan()
  self.assertTrue(self.claim.exists())
 def test_actual_canonical_recovery_dispatch_only_worker(self):
  import re,subprocess
  source=(D/'run-bench-fleet').read_text();fn=re.search(r'^recover_exact_stale_fleet_owner\(\).*?^}\n',source,re.M|re.S).group()
  marker=self.f.root/'dispatch';script='''
registry_meta_value(){ sed -n "s/^$2=//p" "$1" | head -1; }
fleet_registry_cleanup_state(){ echo quarantined; }
registry_owner_alive(){ return 1; }
release_cleanup_disk_reserve(){ echo BAD_RESERVE >> "$MARKER"; return 1; }
acquire_registry_recovery_lock(){ REGISTRY_RECOVERY_GUARD_FD=3; return 0; }
release_registry_recovery_lock(){ echo RELEASE >> "$MARKER"; }
python3(){ printf '%s\\n' "$@" >> "$MARKER"; }
'''+fn+'\nrecover_exact_stale_fleet_owner "$OWNER"\n'
  env=dict(os.environ,FLEET_OWNERSHIP_ROOT=str(self.registry.parent),FLEET_AUDIT_ROOT=str(self.f.common/'cloudbench-fleet-audits'),FLEET_OWNER_HOST=socket.gethostname(),FLEET_OWNER_PID_START='current',APP='navi-whisper-lux-bench',RECOVER_UNSTAGED_WORKER='1',CLOUDBENCH_SCRIPT_SNAPSHOT=str(D),BENCH_REF=self.source,OWNER=self.owner,MARKER=str(marker))
  result=subprocess.run(['bash','-c',script],env=env,capture_output=True,text=True)
  self.assertEqual(result.returncode,0,result.stderr);text=marker.read_text();self.assertIn('cloudbench-unstaged-worker-recovery.py',text);self.assertNotIn('BAD_RESERVE',text);self.assertTrue(text.endswith('RELEASE\n'))
  marker.unlink();again=script.replace('REGISTRY_RECOVERY_GUARD_FD=3; return 0','return 2');r=subprocess.run(['bash','-c',again],env=env,capture_output=True,text=True);self.assertNotEqual(r.returncode,0);self.assertFalse(marker.exists())
class OuterRecoveryCLI(unittest.TestCase):
 def setUp(self):
  import tempfile
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name);self.fake=self.root/'fleet';self.fake.write_text('printf "%s\\n" "$@"\n');self.env=dict(os.environ,RUN_BENCH_FLEET_BIN_UNDER_TEST=str(self.fake))
 def run_cli(self,*args):
  import subprocess
  return subprocess.run(['bash',str(D/'run-bench'),*args],capture_output=True,text=True,env=self.env)
 def test_actual_outer_forwards_exact_recovery(self):
  args=['--recover-unstaged-worker','117b0d8dcad34f54b5f04233e1589e4b','--cold-primary-bootstrap','--reuse-pool-only','--foreground','--ref','570830dbf17635e13d16a6f03b4d705f6b6443b1'];r=self.run_cli(*args);self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(r.stdout.splitlines(),args)
 def test_missing_token_refuses_before_dispatch(self):
  r=self.run_cli('--recover-unstaged-worker');self.assertEqual(r.returncode,2);self.assertIn('requires a value',r.stderr)
 def test_campaign_mix_refuses(self):
  r=self.run_cli('--recover-unstaged-worker','f'*32,'--runs','2');self.assertNotEqual(r.returncode,0);self.assertIn('campaign flags',r.stderr)
if __name__=='__main__':unittest.main()
