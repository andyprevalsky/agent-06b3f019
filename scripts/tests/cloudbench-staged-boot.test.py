#!/usr/bin/env python3
"""Offline staged BOOT transport, actual guest installer and boot supervisor."""
import ast,copy,hashlib,importlib.util,json,os,shutil,signal,subprocess,sys,tarfile,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('staged',ROOT/'cloudbench-staged-boot.py');S=importlib.util.module_from_spec(spec);spec.loader.exec_module(S)
MID='b'*14;TOKEN='a'*32+'-0';REF='c'*40
PROBE="import json;print(json.dumps(dict(machine=TARGET,nonce=NONCE,kind='exact-inert-quiescence-v1',unknown=[],inert_sleepers=[1])))"
class Tests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.out=self.root/'staged-boot';S.save(self.root/'runtime-evidence.owner.json',dict(version=1,machine_id=MID,run_token=TOKEN));S.save(self.root/'runtime-evidence.pending',dict(version=1,machine_id=MID,run_token=TOKEN))
  self.env={'CLOUDBENCH_BOOT':'1','CLOUDBENCH_RUN_TOKEN':TOKEN,'REF':REF};self.files={'cloudbench-boot.sh':b'echo boot','cloudbench-status-server.py':b'print(1)','cloudbench-boot-payload.py':b'print(2)','cloudbench-boot-payload.json.gz':b'payload'}
  self.native=dict(id=MID,name='original',state='stopped',instance_id='instance1',image_ref={'digest':'sha256:'+'e'*64},config=dict(init={'cmd':['sleep','infinity']},env={},restart={'policy':'no'},auto_destroy=False,mounts=[dict(volume='vol_original',path='/data')],guest=dict(cpu_kind='shared',cpus=2,memory_mb=4096)))
  self.volume=dict(id='vol_original',attached_machine_id=MID,state='created');self.calls=[]
 def tearDown(self):self.tmp.cleanup();signal.setitimer(signal.ITIMER_REAL,0)
 def fly(self,mode=None):
  outer=self
  class Fly:
   app='navi-whisper-lux-bench'
   started=False
   def api(self,method,path,timeout):
    outer.calls.append((method,path));assert timeout<=20
    if method=='POST':self.started=True;return {'accepted':True}
    if '/volumes/'in path:return outer.volume
    n=copy.deepcopy(outer.native);n['state']='started'if self.started else'stopped';return n
   def flyctl(self,seconds,*args):
    outer.calls.append(('SFTP',seconds));assert seconds<=30
    if mode=='sftp':return(1,'','unavailable')
    return(0,'','')
   def machine_exec_json(self,seconds,mid,command,**kw):
    assert type(seconds)is int and seconds<=20;outer.calls.append(('EXEC',seconds))
    if 'tarfile'in command:
     if mode=='launch':raise TimeoutError('ambiguous launch')
     r=json.loads((outer.out/'intent.json').read_text());p=json.loads((outer.out/'payload.json').read_text());v={k:r[k]for k in ('app','nonce','machine','volume_id','instance_id','run_token','source_ref','config_sha256')};v.update(schema='cloudbench-staged-boot-launch-v1',archive_sha256=p['archive_sha256'],intent_sha256=S.digest((outer.out/'intent.json').read_bytes()),guest_once='/tmp/cloudbench-staged-boot/'+TOKEN,supervisor_pid=123,supervisor_birth='456',dispatched=True,runtime_success=False)
     if 'evidence_kind'in r:v['evidence_kind']=r['evidence_kind']
    else:
     self.command=command;assert __import__('shlex').split(command)[:4]==['python3','-I','-S','-B'];v=dict(kind='exact-inert-quiescence-v1',machine=MID,nonce=json.loads((outer.out/'intent.json').read_text())['nonce'],unknown=[],inert_sleepers=[1])
    if mode=='realprobe'and 'tarfile'not in command:v=json.loads(subprocess.check_output(__import__('shlex').split(command),timeout=2))
    assert kw['validate_ack'](v);return v
  return Fly()
 def launch(self,mode=None):return S.launch(self.fly(mode),self.out,MID,TOKEN,self.env,self.files,'shared-cpu-2x','4096',PROBE,ready_seconds=2)
 def test_success_same_native_and_payload_no_update(self):
  ack=self.launch();self.assertTrue(ack['dispatched']);self.assertEqual(sum(m=='POST'for m,p in self.calls),1);self.assertFalse(any('update'in str(p)for m,p in self.calls));self.assertEqual(json.loads((self.out/'terminal.json').read_text())['status'],'BOOT_DISPATCHED');self.assertTrue((self.root/'runtime-evidence.pending').exists())
  self.assertEqual((self.out/'boot.tar.gz').stat().st_mode&0o777,0o600)
 def test_actual_rendered_host_probe_command(self):
  ack=self.launch('realprobe');self.assertTrue(ack['dispatched']);self.assertTrue((self.out/'idle-before-stage.json').exists())
 def test_wrong_shape_refuses_before_start(self):
  self.native['config']['guest']['cpus']=4
  with self.assertRaisesRegex(ValueError,'resize'):self.launch()
  self.assertFalse(any(m=='POST'for m,p in self.calls))
 def test_noninert_refuses_before_start(self):
  self.native['config']['init']['cmd']=['bash','old-task']
  with self.assertRaisesRegex(ValueError,'inert'):self.launch()
  self.assertFalse(any(m=='POST'for m,p in self.calls))
 def test_automatic_activation_refuses_before_start(self):
  self.native['config']['disable_machine_autostart']=False
  with self.assertRaisesRegex(ValueError,'autostart'):self.launch()
  self.assertFalse(any(m=='POST'for m,p in self.calls))
 def test_sftp_failure_no_retry_no_dispatch(self):
  with self.assertRaisesRegex(ValueError,'no retry'):self.launch('sftp')
  self.assertEqual(sum(m=='SFTP'for m,p in self.calls),1);self.assertEqual(sum(m=='EXEC'for m,p in self.calls),1);self.assertEqual(json.loads((self.out/'terminal.json').read_text())['status'],'PENDING_NO_RETRY')
 def test_ambiguous_launch_preserves_once_and_owner(self):
  with self.assertRaises(TimeoutError):self.launch('launch')
  self.assertTrue((self.out/'dispatch.intent.json').exists());before=len(self.calls)
  with self.assertRaises(FileExistsError):self.launch()
  self.assertEqual(len(self.calls),before);self.assertTrue((self.root/'runtime-evidence.pending').exists())
 def test_cancellation_retains_pending_and_no_retry(self):
  fly=self.fly();fly.flyctl=lambda *a:(_ for _ in ()).throw(KeyboardInterrupt())
  with self.assertRaises(KeyboardInterrupt):S.launch(fly,self.out,MID,TOKEN,self.env,self.files,'shared-cpu-2x','4096',PROBE,ready_seconds=2)
  self.assertEqual(json.loads((self.out/'terminal.json').read_text())['error_class'],'KeyboardInterrupt');self.assertTrue((self.root/'runtime-evidence.pending').exists())
 def test_missing_owner_refuses_before_provider(self):
  (self.root/'runtime-evidence.owner.json').unlink()
  with self.assertRaises(FileNotFoundError):self.launch()
  self.assertEqual(self.calls,[])
 def test_boot_branch_selected_before_update_and_evidence_unchanged(self):
  code=(ROOT/'run-bench-cloud').read_text();start=code.index('if [ "${CLOUDBENCH_BOOT_TRANSPORT:-config}" = staged ]; then');end=code.index('fi  # end launch: boot-launch vs legacy ssh path',start);branch=code[start:end].split('    else\n',1)[0]
  self.assertNotIn('machine update',branch);self.assertIn('cloudbench-staged-boot.py',branch);self.assertIn('stage_explicit_codex_auth',branch);self.assertLess(code.index('cloudbench_prepare_runtime_evidence ||'),start)
 @unittest.skipUnless(os.geteuid()==0,'guest file identity requires root fixture')
 def test_archive_corruption_is_rejected_before_guest_write(self):
  ns={'__name__':'test_guest'};exec(compile(S.GUEST,'guest','exec'),ns);p=self.root/'bad.tar.gz';p.write_bytes(b'not archive')
  with patch.dict(os.environ,FLY_MACHINE_ID=MID),self.assertRaisesRegex(ValueError,'archive mismatch'):ns['install'](str(p),'0'*64)
 def test_wrong_pending_owner_no_calls(self):
  (self.root/'runtime-evidence.pending').write_text('{}')
  with self.assertRaisesRegex(ValueError,'pending'):self.launch()
  self.assertEqual(self.calls,[])
 def test_barrier_requires_release_before_dispatch(self):
  barrier=self.root/'barrier';barrier.mkdir();(barrier/'release').write_text('release')
  ack=S.launch(self.fly(),self.out,MID,TOKEN,self.env,self.files,'shared-cpu-2x','4096','probe',ready_seconds=2,barrier=barrier,barrier_seconds=1)
  self.assertTrue(ack['dispatched']);self.assertTrue((barrier/'ready'/MID).is_file())
 def test_started_response_after_readiness_deadline_refuses(self):
  clock=[0.0];fly=self.fly();original=fly.api
  def api(method,path,timeout):
   value=original(method,path,timeout)
   if fly.started and method=='GET'and '/machines/'in path:clock[0]=3.0
   return value
  fly.api=api
  with patch.object(S.time,'monotonic',side_effect=lambda:clock[0]),self.assertRaisesRegex(ValueError,'deadline|late'):
   S.launch(fly,self.out,MID,TOKEN,self.env,self.files,'shared-cpu-2x','4096',PROBE,ready_seconds=2)
  self.assertFalse(any(m=='SFTP'for m,p in self.calls))
 def test_release_observed_after_barrier_deadline_refuses(self):
  clock=[0.0];barrier=self.root/'barrier';barrier.mkdir();(barrier/'release').write_text('release');original=Path.is_file
  def is_file(path):
   if path==barrier/'release':clock[0]=2.0
   return original(path)
  with patch.object(S.time,'monotonic',side_effect=lambda:clock[0]),patch.object(Path,'is_file',is_file),self.assertRaisesRegex(ValueError,'barrier expired'):
   S.launch(self.fly(),self.out,MID,TOKEN,self.env,self.files,'shared-cpu-2x','4096',PROBE,ready_seconds=2,barrier=barrier,barrier_seconds=1)
  self.assertEqual(sum(m=='EXEC'for m,p in self.calls),1)
 def test_actual_shell_branch_never_calls_config_update(self):
  source=Path(os.environ.get('ROSE_STAGED_TEST_SOURCE',str(ROOT/'run-bench-cloud'))).read_text()
  marker='    if [ "${CLOUDBENCH_BOOT_TRANSPORT:-config}" = staged ]; then'
  start=source.index(marker)if marker in source else source.index('    boot_config_payload_guard "${_boot_file_args[@]}" || exit 1')
  end=source.index('\nelse\n# ── 1. Start the warm machine',start)
  header="""
set -e
CLOUDBENCH_BOOT_TRANSPORT=staged
mid=bbbbbbbbbbbbbb
RUN_LOG_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-0
APP=navi-whisper-lux-bench
OUT_DIR=$TEST_OUTPUT
CLOUDBENCH_RUNTIME_SCRIPT_ROOT=/fixture
CLOUDBENCH_POOL_BOOT_VM_SIZE=shared-cpu-2x
CLOUDBENCH_POOL_BOOT_VM_MEMORY=4096
POST_CONFIG_START_MARKER=$OUT_DIR/start.marker
_envargs=(); _boot_file_args=(); _pool_shape_args=()
boot_config_payload_guard(){ return 0; }
acquire_boot_config_update_slot(){ return 0; }
release_boot_config_update_slot(){ return 0; }
boot_update_with_capacity_recovery(){ echo UPDATE; return 0; }
flyctl(){ echo START; return 0; }
_with_timeout(){ shift; "$@"; }
sleep(){ :; }
stage_explicit_codex_auth(){ return 0; }
python3(){ cat >/dev/null; echo STAGED; }
"""
  r=subprocess.run(['bash','-c',header+source[start:end]],env=dict(os.environ,TEST_OUTPUT=str(self.root)),capture_output=True,text=True,timeout=5)
  self.assertEqual(r.returncode,0,r.stderr);self.assertIn('STAGED',r.stdout);self.assertNotIn('UPDATE',r.stdout)
 def test_signal_cancellation_preserves_original_intent(self):
  fly=self.fly();fly.flyctl=lambda*a:signal.raise_signal(signal.SIGTERM)
  with self.assertRaises(S.Cancelled):S.launch(fly,self.out,MID,TOKEN,self.env,self.files,'shared-cpu-2x','4096',PROBE,ready_seconds=2)
  self.assertEqual(json.loads((self.out/'terminal.json').read_text())['error_class'],'Cancelled')
 def environment_entry(self,args):
  repo=self.root/'fixture-repo';lib=repo/'scripts/lib';lib.mkdir(parents=True);(repo/'agents').mkdir();(repo/'back-end').mkdir()
  for name in ('cloudbench-env.sh','cloudbench-app-env-lock.sh'):(lib/name).write_text('# fixture: no provider or credential operations\n')
  (lib/'cloudbench-github-token.sh').write_text('cloudbench_export_controller_github_token(){ return 0; }\n')
  binp=self.root/'fixture-bin';binp.mkdir();fly=binp/'flyctl';receipt=self.root/'fly-call.json'
  fly.write_text('#!/usr/bin/env python3\nimport json,os,sys\nfrom pathlib import Path\nassert sys.argv[1:]==["secrets","list","-a","navi-whisper-lux-bench","--json"]\nPath(os.environ["FIXTURE_FLY_CALL"]).write_text(json.dumps(sys.argv[1:]))\nprint(json.dumps([{"Name":n} for n in "AGENTS_ENV_B64 BACKEND_ENV_B64 AGENTS_ENV_SHA256 BACKEND_ENV_SHA256 CLOUDBENCH_BROWSER_PROVIDER GITHUB_TOKEN".split()]))\n');fly.chmod(0o755)
  env={k:v for k,v in os.environ.items()if not k.startswith(('CLOUDBENCH_','FLY_'))};env.update(CLOUDBENCH_FLEET_ROOT=str(repo),CLOUDBENCH_BOOT_TRANSPORT='staged',FLY_BENCH_API_TOKEN='offline-fixture-selected-token',PATH=str(binp)+':'+os.environ['PATH'],FIXTURE_FLY_CALL=str(receipt))
  return subprocess.run(['bash',str(ROOT/'run-bench-cloud'),*args],env=env,capture_output=True,text=True,timeout=5),receipt
 def test_actual_verify_secrets_ignores_inherited_launch_transport(self):
  result,receipt=self.environment_entry(['--verify-secrets']);self.assertEqual(result.returncode,0,result.stderr);self.assertTrue(receipt.exists());self.assertIn('verified (read-only)',result.stdout)
 def test_actual_task_still_requires_explicit_staged_boot_flags(self):
  result,receipt=self.environment_entry(['fixture-task','--machine',MID]);self.assertEqual(result.returncode,2);self.assertIn('requires explicit BOOT_LAUNCH',result.stderr);self.assertFalse(receipt.exists())
 def probe_owner(self):
  for n in ('runtime-evidence.owner.json','runtime-evidence.pending'):(self.root/n).unlink()
  self.env['CLOUDBENCH_INFRA_PROBE']='1'
  return S.prepare_probe_owner(self.root,'navi-whisper-lux-bench',MID,TOKEN,REF)
 def test_probe_owner_is_distinct_and_exclusive(self):
  owner=self.probe_owner();self.assertTrue(owner['infra_probe']);self.assertFalse(owner['runtime_success']);self.assertFalse((self.root/'runtime-evidence.owner.json').exists());self.assertFalse((self.root/'runtime-evidence.pending').exists())
  with self.assertRaises(FileExistsError):S.prepare_probe_owner(self.root,'navi-whisper-lux-bench',MID,TOKEN,REF)
 def test_typed_probe_launch_has_no_runtime_credit(self):
  self.probe_owner();ack=self.launch();self.assertEqual(ack['evidence_kind'],'infra-probe');self.assertFalse(ack['runtime_success']);self.assertEqual(json.loads((self.out/'terminal.json').read_text())['evidence_kind'],'infra-probe');self.assertFalse((self.root/'runtime-evidence.pending').exists())
 def test_probe_refuses_real_runtime_owner(self):
  self.env['CLOUDBENCH_INFRA_PROBE']='1'
  S.save(self.root/'staged-probe.owner.json',dict(schema='cloudbench-staged-probe-owner-v1',app='navi-whisper-lux-bench',machine_id=MID,run_token=TOKEN,source_ref=REF,infra_probe=True,runtime_success=False))
  with self.assertRaisesRegex(ValueError,'impersonate'):self.launch()
  self.assertEqual(self.calls,[])
 def test_real_mode_cannot_use_probe_owner(self):
  self.probe_owner();self.env['CLOUDBENCH_INFRA_PROBE']='0'
  with self.assertRaises(FileNotFoundError):self.launch()
  self.assertEqual(self.calls,[])
 def test_actual_probe_producer_uses_distinct_owner(self):
  for n in ('runtime-evidence.owner.json','runtime-evidence.pending'):(self.root/n).unlink()
  source=Path(os.environ.get('ROSE_STAGED_TEST_SOURCE',str(ROOT/'run-bench-cloud'))).read_text();start=source.index('cloudbench_prepare_runtime_evidence() {');end=source.index('\ncloudbench_collect_runtime_evidence()',start);function=source[start:end]
  shell='set -e\ncloudbench_skip_held_driver_teardown_race(){ return 0; }\n'+function+'\ncloudbench_prepare_runtime_evidence\n'
  env=dict(os.environ,CLOUDBENCH_BOOT_LAUNCH='1',CLOUDBENCH_BOOT_TRANSPORT='staged',CLOUDBENCH_INFRA_PROBE='1',CLOUDBENCH_RUNTIME_SCRIPT_ROOT=str(ROOT),APP='navi-whisper-lux-bench',FLEET_MACHINE_ID=MID,RUN_LOG_TOKEN=TOKEN,BENCH_REF=REF,OUT_DIR=str(self.root))
  result=subprocess.run(['bash','-c',shell],env=env,capture_output=True,text=True,timeout=5);self.assertEqual(result.returncode,0,result.stderr);self.assertTrue((self.root/'staged-probe.owner.json').exists());self.assertFalse((self.root/'runtime-evidence.pending').exists())
 @unittest.skipUnless(os.geteuid()==0,'actual guest file ownership contract requires root fixture')
 def test_actual_guest_installer_boot_supervisor_and_once(self):
  root=self.root/'guest';root.mkdir();data=root/'data';data.mkdir();binp=root/'bin';binp.mkdir()
  for name,body in [('pkill','exit 0'),('git','exit 0'),('sleep','exit 0')]:p=binp/name;p.write_text('#!/bin/sh\n'+body+'\n');p.chmod(0o755)
  driver=root/'driver.sh';driver.write_text('#!/bin/bash\n/bin/sleep .2\nprintf "%s" "$REF" > "$CLOUDBENCH_DATA_DIR/actual-driver-ref"\n');fetch=root/'fetch.sh';fetch.write_text('exit 0\n')
  env=dict(self.env,CLOUDBENCH_DATA_DIR=str(data),CLOUDBENCH_REPO_DIR=str(root/'repo'),CLOUDBENCH_RUN_SCRIPT=str(driver),CLOUDBENCH_FETCH_REF_SCRIPT=str(fetch),PATH=str(binp)+':'+os.environ['PATH'])
  files=dict(self.files);files['cloudbench-boot.sh']=(ROOT/'cloudbench-boot.sh').read_bytes();files['cloudbench-status-server.py']=b'pass\n';env['CLOUDBENCH_STATUS_SERVER_SCRIPT']=str(root/'cloudbench-status-server.py')
  request=dict(machine=MID,app='navi-whisper-lux-bench',run_token=TOKEN,source_ref=REF,nonce='d'*32,instance_id='instance1',volume_id='vol_original',config_sha256='f'*64,idle_probe="import json;print(json.dumps(dict(machine='"+MID+"',nonce='"+'d'*32+"',kind='exact-inert-quiescence-v1',unknown=[],inert_sleepers=[1])))")
  archive=self.root/'actual.tar.gz';hash_,request=S.bundle(archive,env,files,request)
  ns={'__name__':'guest_fixture'};exec(compile(S.GUEST,'actual-guest-installer','exec'),ns);realpath=Path;realpopen=subprocess.Popen;children=[]
  def path(*args):
   p=realpath(*args)
   if p==realpath('/'):return root
   if str(p).startswith('/tmp/cloudbench-staged-boot'):return root/'custody'/str(p).removeprefix('/tmp/cloudbench-staged-boot').lstrip('/')
   return p
  def popen(argv,**kw):
   if argv[0]!='bash':return realpopen(argv,**kw)
   child=realpopen(['bash',str(root/'cloudbench-boot.sh')],**kw);children.append(child);return child
  (root/'custody').mkdir(mode=0o700)
  with patch.dict(ns,Path=path),patch.dict(os.environ,FLY_MACHINE_ID=MID),patch('subprocess.Popen',side_effect=popen):ack=ns['install'](str(archive),hash_)
  for child in children:child.wait(timeout=3)
  self.assertEqual((data/'actual-driver-ref').read_text(),REF);self.assertEqual((data/'cloudbench-driver.state').read_text(),'exited\n');self.assertEqual(ack['intent_sha256'],S.digest(S.canonical(request)+b'\n'))
  with patch.dict(ns,Path=path),patch.dict(os.environ,FLY_MACHINE_ID=MID):
   with self.assertRaises(FileExistsError):ns['install'](str(archive),hash_)
  self.assertEqual(len(children),1)
@unittest.skipUnless(os.geteuid()==0,'canonical claim and return fixture')
class ReusableStagedBootstrap(unittest.TestCase):
 def setUp(self):
  spec=importlib.util.spec_from_file_location('return_fixture',ROOT/'tests/cloudbench-explicit-idle-admission.test.py');self.A=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.A)
  original=self.A.Worker.setUp
  def empty(worker):
   original(worker);obs=self.A.mod.described(worker.request['observation']);obs['workspace']={'kind':'absent'};worker.request['observation']=worker.save(obs)
   terminal=self.A.mod.described(worker.request['observer_terminal']);terminal['observation_sha256']=worker.request['observation']['sha256'];worker.request['observer_terminal']=worker.save(terminal);worker.request['workspace_policy']='real-empty-bootstrap-v1'
  self.f=self.A.StagedPrimaryReturn()
  with patch.object(self.A.Worker,'setUp',empty):self.f.setUp()
  self.addCleanup(self.f.doCleanups)
 def cli(self,cold,fresh,boot='1'):
  source=Path(os.environ.get('ROSE_STAGED_TEST_SOURCE',str(ROOT/'run-bench-cloud'))).read_text();end=source.index('if [ "$IMAGE_BUILD_BUILDER_REQUESTED" = 1 ]')
  prefix=source[:end]+'\nprintf "CLI_BOOTSTRAP_ACCEPTED=%s:%s\n" "${CLOUDBENCH_COLD_PRIMARY_BOOTSTRAP:-0}" "${CLOUDBENCH_FRESH_VOLUME:-0}"\n'
  env=dict(os.environ,CLOUDBENCH_FLEET_ROOT=str(ROOT.parent),CLOUDBENCH_BOOT_TRANSPORT='staged',CLOUDBENCH_BOOT_LAUNCH=boot,CLOUDBENCH_COLD_PRIMARY_BOOTSTRAP=str(cold),CLOUDBENCH_FRESH_VOLUME=str(fresh))
  env.pop('CLOUDBENCH_SCRIPT_SNAPSHOT',None)
  return subprocess.run(['bash','-c',prefix,'cloud-cli','parallel-tool-calls','--machine',self.f.f.mid,'--ref',self.f.source,'--no-simulate'],env=env,capture_output=True,text=True,timeout=10)
 def next_intent(self,wrong=False):
  f=self.f;fleet=(ROOT/'run-bench-fleet').read_text();claimfn=__import__('re').search(r'^pool_claim_fs_transaction\(\).*?^}\n',fleet,__import__('re').M|__import__('re').S).group()
  cf=dict(line.split('=',1)for line in f.f.claim.read_text().splitlines()) if f.f.claim.exists() else self.claim
  owner='a'*32;args=['bash','-c',claimfn+'\npool_claim_fs_transaction publish-ordinary "$@"','claim',str(f.f.claim),f.f.mid,f.f.vol,cf['host'],cf['pid'],cf['pid_start'],owner,f.f.request['consumer']['pool_ids_file'],f.f.request['consumer']['pool_meta_file'],self.A.mod.sha(Path(f.f.request['consumer']['pool_meta_file']).read_bytes())]
  r=subprocess.run(args,capture_output=True,text=True);self.assertEqual(r.returncode,0,r.stderr)
  out=f.f.root/'next'/'parallel-tool-calls';out.mkdir(parents=True);(out/'.cid').write_text('pool '+f.f.mid+'\n')
  code=fleet.split("<<'PYCOLD' || return 1\n",1)[1].split('\nPYCOLD',1)[0]
  env=dict(os.environ,CLOUDBENCH_SCRIPT_SNAPSHOT=str(ROOT));r=subprocess.run([sys.executable,'-c',code,str(f.f.proof),str(out/'cold-primary-bootstrap'),f.f.mid,f.source,'next',owner,str(f.run/'execution-task-matrix.json'),out.name],env=env,capture_output=True,text=True);self.assertEqual(r.returncode,0,r.stderr)
  if wrong:
   value=json.loads((out/'cold-primary-bootstrap').read_bytes());value['policy']='real-empty-bootstrap-v1';(out/'cold-primary-bootstrap').write_text(json.dumps(value))
  fn=__import__('re').search(r'^primary_cold_bootstrap_requested\(\).*?^}\n',fleet,__import__('re').M|__import__('re').S).group()
  env.update(POOL_COLD_BOOTSTRAP='1',BENCH_REF=f.source,RUN_ID='next',FLEET_OWNER_TOKEN=owner,EXECUTION_TASK_MATRIX_FILE=str(f.run/'execution-task-matrix.json'),PROOF=str(f.f.proof))
  return subprocess.run(['bash','-c','pool_reuse_proof_file(){ printf "%s" "$PROOF"; }\n'+fn+'\nprimary_cold_bootstrap_requested "$1" "$2"','next-intent',str(out),f.f.mid],env=env,capture_output=True,text=True)
 def returned(self):
  f=self.f;self.assertEqual(f.h['current_policy'](f.f.proof),'real-empty-bootstrap-v1');self.claim=dict(line.split('=',1)for line in f.f.claim.read_text().splitlines())
  r,_=f.audit_refresh();self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(f.h['current_policy'](f.f.proof),'existing-git-reset-v1')
 def test_first_return_next_claim_intent_and_actual_cli_bootstrap(self):
  first=self.cli(1,1);self.assertEqual(first.returncode,0,first.stderr)
  self.returned();before=self.f.f.proof.read_bytes();r=self.next_intent();self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(r.stdout.strip(),'0')
  next_run=self.cli(r.stdout.strip(),0);self.assertEqual(next_run.returncode,0,next_run.stderr);self.assertIn('CLI_BOOTSTRAP_ACCEPTED=0:0',next_run.stdout);self.assertEqual(self.f.f.proof.read_bytes(),before)
 def test_changed_return_policy_intent_still_refuses(self):
  self.returned();self.assertNotEqual(self.next_intent(wrong=True).returncode,0)
 def test_boot_flag_and_cold_fresh_guards_remain(self):
  for cold,fresh,boot in [(0,0,'0'),(1,0,'1'),(2,0,'1')]:
   with self.subTest(cold=cold,fresh=fresh,boot=boot):self.assertNotEqual(self.cli(cold,fresh,boot).returncode,0)
 def test_existing_checkout_uses_unchanged_reset_path(self):
  f=self.f;repo=f.f.root/'retained-repo';subprocess.run(['git','init','-q',str(repo)],check=True)
  (repo/'payload').write_text('committed\n');subprocess.run(['git','-C',str(repo),'add','.'],check=True);subprocess.run(['git','-C',str(repo),'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'],check=True)
  ref=subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True).strip();(repo/'payload').write_text('changed\n');(repo/'untracked').write_text('retained\n')
  env=dict(os.environ,CLOUDBENCH_REQUIRE_EMPTY_CHECKOUT='0',CLOUDBENCH_FRESH_VOLUME='0');env.pop('CLOUDBENCH_APP_USER',None)
  r=subprocess.run(['bash',str(ROOT/'cloudbench-fetch-ref.sh'),str(repo),ref],env=env,capture_output=True,text=True,timeout=10)
  self.assertEqual(r.returncode,0,r.stderr);self.assertIn('already-at '+ref,r.stdout);self.assertEqual((repo/'payload').read_text(),'committed\n');self.assertEqual((repo/'untracked').read_text(),'retained\n')

if __name__=='__main__':unittest.main()
