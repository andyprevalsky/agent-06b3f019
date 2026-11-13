from pathlib import Path
import base64,copy,json,os,runpy,unittest,zlib
D=Path(__file__).resolve().parents[1];T=runpy.run_path(str(D/'tests/cloudbench-explicit-idle-admission.test.py'))

# Actual pre-C1 wrapper from main8046dcbc, preserving the historical negative
# control independently of current token exports and checkout Git history.
# Extracted bytes SHA256: 6262003ce5695ce9d20975b92302eda04a801beb0fb9dc8210967b18ae6b75eb
LEGACY_WORKER_WRAPPER_SOURCE=zlib.decompress(base64.b85decode(
 'c$}qHZEu@M5dPj@v7%|+>S~fyZ9d$IN*LA!1%m}Rt<|emYgo!EymeXPT5bP(7l;#VOvLG;$i}<#Jo7L!JF@@)P%xVD2uw7~S?M!q'
 'YX<sg`o?O8eCHb4Xm<5ZdGY<<YyzaSZO(29L*FQms}17$Ey>X4>YW5WJZ_TgPI@MI!O!Ni{v$!01F0k&Oo?>3I-wEx0;Ul-=V@`y'
 'Hd|TX!PkEPk4ZK;vaO#Q7JO<)KHwO_{&f<|(qj$BRuMf~k;soCXB@b2uAIHvNAbn?I!<jE#g6n^I*sZ?dk+297<rm&E`8-Z#2lXo'
 'NnV8;k_GWJB3yhj63Jyeg3pDXfo>dYwSYp|m&eqUJZJbDk$?gsM#>m`1utLj3*Zv``n7+)7$MtR+Zxj0(i@ar?y_JSlA;_XyWv~9'
 'rngX^W)vFB6i<VMl8ld{hV~6IptXc<pHifH6vrpWy@oD=H>NIr!$H0_)KhXtL-Cu)#cnjWyRzFe*Q+O1Wt^r2iSPE*b?d55@Fr(0'
 '-;xlu?&}O+i0q1tj(s0bbCysM4o1sesG4Eg5Se;U@0Nyxm0zR1r7B$7YEz&`&~gwdiesU=Yh*Z{-@_HO7<1TWj^isA19mf26Vcbv'
 '(sBC^X3l5SH5h)ug)z*q-|V8F1CORvf;kBR&+`Oq@+u24qof3R25`mmGQf%0ZL?c~45y^-kfNipJF%YTAxY$6ISWUJ*6Da3ZXe2$'
 'Wf^B7pu7a+2MH=pg`6T!Xs~+&wlNK2P+-Psy<RqYbhvOpfCKTE(A!p{@Rwq?o0LxogrA|d@=eDU!LdwjeNyJJ(O?D)s9OF&66O|!'
 '{=S4ehJ$4H-N{_6EY<JFucT=g+Ke;l>}P`#)q0KUkRVN*6)1YVsw2m?)_+fb*GKenKj<Fdr@asID3{VObgp`SliGWfZhGp>g6NZL'
 '`Vjes>#RN+Pcl3@H$A6*d%f;a3TIVkj7RjK6O}P$q7OASfEd9c%ClrQ)R6wO#$GF_`=$uT8qH0spPgF34n;H}{rt8we;h(wQL=~P'
 'S*rEGuKh{v1U(RCIhty9Y?S6!(U}lQE)KI?U@_CB$ADB>eLFb@|8E7Jp}u{8r5xbewI_YwoAkm?0<gj2;xI7w9wzDU_D0BXQHW{O'
 'EWLWRZ!3OGOCbI+2x6LqqCw<$v=lvrus^Xq2<`'
)).decode()

class Consumer(unittest.TestCase):
 def setUp(self):
  global C,H,G
  C=runpy.run_path(str(D/'cloudbench-fixed-native-worker.py'));H=C['H'];G=C['G']
  fixture=json.loads((D/'tests/fixed-native-worker.fixture.json').read_bytes());base=G['baseline']()
  base.update(config_sha256=H['sha'](H['canonical'](fixture['config'])),env_sha256=H['sha'](H['canonical'](fixture['config']['env'])),files_sha256=H['sha'](H['canonical'](fixture['config']['files'])))
  G['native_pair'].__globals__['baseline']=lambda:base;G['baseline']=lambda:base
  f=T['Admission']();f.setUp();self.addCleanup(f.doCleanups);self.f=f;r=copy.deepcopy(f.request);b=G['baseline']();n=fixture
  f.mid=b['machine'];f.vol=b['volume'];f.resource=dict(app='navi-whisper-lux-bench',machine_id=f.mid,name=b['name'],volume_id=f.vol,instance_id=n['instance_id'],image_digest=b['image'].rpartition('@')[2],shape=b['shape'],config_sha256=b['config_sha256']);r['resource']=f.resource
  r.update(schema=C['REQUEST_SCHEMA'],fixed_native_baseline_sha256=G['BASELINE_SHA'],allowed_future_roles=['worker'],worker_environment_policy=dict(schema='remove-fixed-native-environment-v1',baseline_sha256=G['BASELINE_SHA'],removed_keys=b['env_keys']))
  r['native_before']=f.save(n);r['native_after']=f.save(n);r['volume']=f.save(dict(id=f.vol,attached_machine_id=f.mid,state='created'))
  r['protected_overlay']=f.save(dict(machines=[f.controller],volumes=['vol_controller'],names=[]))
  own=H['described'](r['workspace_ownership']);own['app']='navi-whisper-lux-bench';r['workspace_ownership']=f.save(own);r['consumer']['ownership_sha256']=r['workspace_ownership']['sha256'];os.environ['FLY_APP_NAME']='navi-whisper-lux-bench'
  obs=H['described'](r['observation']);obs.update(machine_id=f.mid,native_instance=n['instance_id']);obs['before']['machine']=f.mid;obs['after']['machine']=f.mid;r['observation']=f.save(obs)
  term=H['described'](r['observer_terminal']);term.update(machine_id=f.mid,observation_sha256=r['observation']['sha256']);r['observer_terminal']=f.save(term)
  rec=H['described'](r['preservation']['receipt']);rec.update(machine_id=f.mid,volume_id=f.vol,source_instance=n['instance_id'],source_config_sha256=b['config_sha256']);r['preservation']['receipt']=f.save(rec)
  av=H['described'](r['preservation']['available_read']);av['volume_id']=f.vol;r['preservation']['available_read']=f.save(av);f.request=r
 def test_full_validation(self):self.assertEqual(C['validate_request'](self.f.request)['id'],self.f.mid)
 def test_primary_role_refused(self):
  r=copy.deepcopy(self.f.request);r['allowed_future_roles']=['primary','worker']
  with self.assertRaisesRegex(ValueError,'worker-only'):C['validate_request'](r)
 def test_environment_policy_required(self):
  r=copy.deepcopy(self.f.request);r['worker_environment_policy']['removed_keys']=[]
  with self.assertRaisesRegex(ValueError,'environment policy'):C['validate_request'](r)
 @unittest.skipUnless(os.geteuid()==0,'root publication boundary; execute this registered test as root')
 def test_publish_verify_worker_only(self):
  f=self.f;req,auth,fd=f.authority();a=json.loads(auth.read_bytes());a.update(app='navi-whisper-lux-bench',fixed_native_baseline_sha256=G['BASELINE_SHA'],future_role='worker');auth.write_bytes(H['canonical'](a))
  result=C['publish'](req,H['sha'](req.read_bytes()),auth,H['sha'](auth.read_bytes()),fd);self.assertEqual(result['status'],'COMPLETE');self.assertEqual(result['schema'],C['SCHEMA'])
  proof=f.common/'cloudbench-pool-reuse'/(f.mid+'.json');C['verify_pool'](proof,f.common,f.request['native_before'],f.request['native_after'],f.request['consumer']['source_ref'],H['described'](f.request['volume']),role='worker')
  with self.assertRaisesRegex(ValueError,'role'):C['verify_pool'](proof,f.common,f.request['native_before'],f.request['native_after'],f.request['consumer']['source_ref'],H['described'](f.request['volume']),role='primary')
  self.assertEqual(C['worker_launch_argv'](proof),G['worker_entry_argv']())
 def test_authority_subtype_required(self):
  f=self.f;req,auth,fd=f.authority()
  with self.assertRaisesRegex(ValueError,'authority'):C['publish'](req,H['sha'](req.read_bytes()),auth,H['sha'](auth.read_bytes()),fd)
 def test_normal_validator_still_refuses(self):
  import importlib.util
  p=D/'cloudbench-explicit-idle-admission.py';spec=importlib.util.spec_from_file_location('unmodified',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
  with self.assertRaises(ValueError):m.validate_request(self.f.request)
 def test_production_baseline_not_generic(self):
  actual=runpy.run_path(str(D/'cloudbench-fixed-native-worker-guard.py'))['baseline']()
  self.assertEqual(actual['machine'],'86549d6aed9358');self.assertEqual(actual['config_sha256'],'4eecbf5b09bc19a8ac87a5e8c372d51818efccb35f9d614ff7782b7a466fd995')
 def test_real_outer_cli_and_worker_only_primary_skip(self):
  f=self.f;req,auth,fd=f.authority();a=json.loads(auth.read_bytes());a.update(app='navi-whisper-lux-bench',fixed_native_baseline_sha256=G['BASELINE_SHA'],future_role='worker');auth.write_bytes(H['canonical'](a))
  # Exercise actual outer argv parsing and extracted unmodified dispatch block.
  dispatch=f.fleet_dispatch_fixture();env={**os.environ,'RUN_BENCH_FLEET_BIN_UNDER_TEST':str(dispatch),'FIXTURE_REPO':str(f.repo),'FIXTURE_COMMON':str(f.common),'FIXTURE_POOL':f.request['consumer']['pool_ids_file'],'PYTHONPATH':''}
  # A sanitized fixture cannot pass production exactfingerprint; refusal must be
  # before publication. Full actual-config CLI success is separately private.
  import subprocess
  r=subprocess.run(['bash',str(D/'run-bench'),'--admit-fixed-native-worker',str(req),H['sha'](req.read_bytes()),str(auth),H['sha'](auth.read_bytes()),str(fd)],pass_fds=(fd,),env=env,capture_output=True,text=True)
  self.assertNotEqual(r.returncode,0);self.assertFalse(Path(f.request['consumer']['pool_ids_file']).exists())
 def test_actual_worker_wrapper_clears_old_identity(self):
  import subprocess,shlex
  f=self.f;fleet=LEGACY_WORKER_WRAPPER_SOURCE;start=fleet.index("    printf 'CLOUDBENCH_GITHUB_TOKEN_B64=%q\\n'");end=fleet.index('    ) &',start) if False else fleet.index('    (\n      # This is a child provisioner',start)
  body=fleet[start:end];wrapper=f.root/'wrapper.sh';envfile=f.root/'worker.env';worker=f.root/'worker.py'
  worker.write_text('import json,os;print(json.dumps(dict(os.environ)))')
  seed=dict(wrapper=str(wrapper),worker_env=str(envfile),worker_github_token_b64='CURRENT',BENCH_REF='a'*40,worker_storage='borrowed',runtime_run_token='current-token',borrowed_worker='1',wid=f.mid,ws='current-workspace',pip='fd00::1',BOX_BACKEND_PORT='3001',BOX_WMH_PORT='3007',FLEET_WORKER_HEALTH_PORT='3103',sim='0',ready_file=str(f.root/'ready'),FLEET_PATCH_FILE='')
  cmd='\n'.join(k+'='+shlex.quote(v)for k,v in seed.items())+'\n'+body
  subprocess.run(['bash','-c',cmd],check=True,capture_output=True)
  text=wrapper.read_text().replace('/tmp/rbw.env',str(envfile)).replace('exec bash /data/cloudbench-worker.sh','exec '+shlex.quote(__import__('sys').executable)+' '+shlex.quote(str(worker)));wrapper.write_text(text)
  inherited={**os.environ,**{k:'OLD'for k in G['baseline']()['env_keys']}}
  old=json.loads(subprocess.check_output(['bash',str(wrapper)],env=inherited));self.assertEqual(old['CLOUDBENCH_RUN_TOKEN'],'OLD')
  # Recreate the exclusive current environment file consumed by the old run.
  envfile.write_text('CLOUDBENCH_GITHUB_TOKEN_B64=CURRENT\n')
  argv=G['worker_entry_argv']();argv[-1]=str(wrapper)
  got=json.loads(subprocess.check_output(argv,env=inherited));self.assertNotIn('CLOUDBENCH_RUN_TOKEN',got);self.assertNotIn('CLOUDBENCH_BARRIER_TOKEN',got);self.assertNotIn('BENCHMARK_HUB_PARENT_RUN_ID',got);self.assertEqual(got['CLOUDBENCH_WORKER_RUN_TOKEN'],'current-token');self.assertEqual(got['REF'],'a'*40);self.assertEqual(got['CLOUDBENCH_BOOT'],'0');self.assertEqual(got.get('HOME'),os.environ.get('HOME'))
 @unittest.skipUnless(os.geteuid()==0,'root publication boundary; execute this registered test as root')
 def test_actual_claim_stage_cancel_return_and_next_policy(self):
  from types import SimpleNamespace
  from unittest.mock import patch
  f=self.f;f.__class__=T['Worker'];old_authority=f.authority
  def authority():
   req,auth,fd=old_authority();a=json.loads(auth.read_bytes());a.update(app='navi-whisper-lux-bench',fixed_native_baseline_sha256=G['BASELINE_SHA'],future_role='worker');auth.write_bytes(H['canonical'](a));return req,auth,fd
  f.authority=authority
  proxy=SimpleNamespace(**H);proxy.publish=C['publish'];proxy.stage_worker=C['stage_worker'];proxy.record_worker_return=C['record_worker_return'];proxy.returned_state=C['returned_state']
  with patch.dict(T['Worker'].prepare.__globals__,{'mod':proxy}):
   f.prepare();result=f.stage('performance-1x','2048');self.assertEqual(result['status'],'STOPPED_STAGED');self.assertFalse(any(x[0]=='POST'for x in f.calls));evidence=f.evidence();before,after,volume=f.return_inputs();state=C['record_worker_return'](f.assignment,before,after,volume)
   receipt=dict(machine_id=f.mid,run_token='current-token',claim_sha256=f.row['claim_sha256'],primary_machine_id='primary',fleet_owner_token=f.row['fleet_owner_token'],state='stopped',volume_retained=True,evidence_sha256=evidence);(f.borrow/(f.mid+'.returned.json')).write_bytes(H['canonical'](receipt));f.claim.unlink();H['sibling']('cloudbench-worker-reuse.py')['recover_return_release'](f.out,f.mid,'primary','current-token');self.assertEqual(C['returned_state'](f.proof),state);self.assertEqual(C['current_policy'](f.proof),state['workspace_policy'])
 def test_wrong_requested_profile_no_api(self):
  calls=[]
  with self.assertRaisesRegex(ValueError,'profile'):C['stage_worker']('unused','source','n','p','shared-cpu-4x','8192',lambda *a,**k:calls.append(a))
  self.assertEqual(calls,[])
 @unittest.skipUnless(os.geteuid()==0,'root publication boundary; execute this registered test as root')
 def test_actual_primary_claim_skips_worker_only(self):
  import re,subprocess
  f=self.f;req,auth,fd=f.authority();a=json.loads(auth.read_bytes());a.update(app='navi-whisper-lux-bench',fixed_native_baseline_sha256=G['BASELINE_SHA'],future_role='worker');auth.write_bytes(H['canonical'](a));C['publish'](req,H['sha'](req.read_bytes()),auth,H['sha'](auth.read_bytes()),fd)
  fn=re.search(r'^claim_pool_machine\(\).*?^}\n',(D/'run-bench-fleet').read_text(),re.M|re.S).group()
  claimed=f.root/'claimed';claimed.touch()
  env={**os.environ,'POOL_IDS_FILE':f.request['consumer']['pool_ids_file'],'POOL_CLAIMS_DIR':str(f.common/'cloudbench-pool-claims'),'CLAIMED_POOL_FILE':str(claimed),'GIT_COMMON_DIR':str(f.common),'FLEET_DIR':str(f.root)}
  r=subprocess.run(['bash','-c',fn+'\nclaim_pool_machine shared-cpu-2x 4096'],env=env,capture_output=True,text=True);self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(r.stdout,'');self.assertFalse((f.common/'cloudbench-pool-claims'/f.mid).exists())
 def test_actual_snapshot_list_contains_complete_fixed_module(self):
  import re,shutil
  fleet=(D/'run-bench-fleet').read_text();a=fleet.index('if [ "${CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_FAIL_COPY:-0}"');b=fleet.index('then',a)
  names=re.findall(r'"\$ROOT_DIR/scripts/([^"$]+)"',fleet[a:b])
  flat=self.f.root/'flat';flat.mkdir()
  for name in names:
   source=D/name
   if source.is_file():shutil.copyfile(source,flat/source.name)
  for name in ('cloudbench-fixed-native-worker.py','cloudbench-fixed-native-worker-guard.py','cloudbench-fixed-native-worker-baseline.json','cloudbench-explicit-idle-admission.py'):self.assertTrue((flat/name).exists(),name)
  loaded=runpy.run_path(str(flat/'cloudbench-fixed-native-worker.py'));self.assertEqual(loaded['G']['baseline']()['machine'],'86549d6aed9358')
 def test_protected_name_refused(self):
  r=copy.deepcopy(self.f.request);r['protected_overlay']=self.f.save(dict(machines=[],volumes=[],names=[r['resource']['name']]))
  with self.assertRaisesRegex(ValueError,'protected name'):C['validate_request'](r)
if __name__=='__main__':unittest.main()
