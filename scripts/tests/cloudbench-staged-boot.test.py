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
  with self.assertRaisesRegex(AssertionError,'autostart'):self.launch()
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
  code=(ROOT/'run-bench-cloud').read_text();start=code.index('if [ "${CLOUDBENCH_BOOT_TRANSPORT:-config}" = staged ]');end=code.index('fi  # end launch: boot-launch vs legacy ssh path',start);branch=code[start:end].split('    else\n',1)[0]
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
  env={k:v for k,v in os.environ.items()if not k.startswith(('CLOUDBENCH_','FLY_'))};env.update(CLOUDBENCH_FLEET_ROOT=str(repo),CLOUDBENCH_BOOT_TRANSPORT='staged',FLY_BENCH_API_TOKEN='offline-fixture-selected-token',PATH=str(binp)+':'+os.environ['PATH'],HOME=str(self.root),FIXTURE_FLY_CALL=str(receipt))
  return subprocess.run(['bash',str(ROOT/'run-bench-cloud'),*args],env=env,capture_output=True,text=True,timeout=5),receipt
 def test_actual_verify_secrets_ignores_inherited_launch_transport(self):
  result,receipt=self.environment_entry(['--verify-secrets']);self.assertEqual(result.returncode,0,result.stderr);self.assertTrue(receipt.exists());self.assertIn('verified (read-only)',result.stdout)
 def test_actual_task_still_requires_explicit_staged_boot_flags(self):
  result,receipt=self.environment_entry(['fixture-task','--machine',MID]);self.assertEqual(result.returncode,2);self.assertIn('requires explicitly admitted cold BOOT_LAUNCH',result.stderr);self.assertFalse(receipt.exists())
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
if __name__=='__main__':unittest.main()
