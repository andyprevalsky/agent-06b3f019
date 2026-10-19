#!/usr/bin/env python3
from pathlib import Path
import contextlib,hashlib,http.server,json,os,runpy,signal,subprocess,tempfile,threading,time,unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
H=runpy.run_path(str(ROOT/'scripts/cloudbench-stop-all.py'))
def machine(mid='0123456789abcd',state='started'):
 return dict(id=mid,instance_id='same-instance',name='fixture',state=state,config={'guest':{'cpus':2}},image_ref={})
class StopAll(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
 def test_cli_missing_execution_and_mixed_flags_no_provider(self):
  for args in [('stop-all','--app','fixture','--out-dir',str(self.root/'unused')),('stop-all','--execute','--out-dir',str(self.root/'unused')),('stop-all','--app','fixture','--execute','--out-dir',str(self.root/'unused'),'--runs','2')]:
   r=subprocess.run(['bash',str(ROOT/'scripts/run-bench'),*args],capture_output=True,text=True);self.assertEqual(r.returncode,2,r.stderr);self.assertFalse((self.root/'unused').exists())
 def test_actual_outer_cli_http_stop_confirmation(self):
  events=[];rows={f'{i:014x}':machine(f'{i:014x}')for i in range(8)};lock=threading.Lock();live=[0,0]
  class Handler(http.server.BaseHTTPRequestHandler):
   def log_message(self,*a):pass
   def reply(self,value):
    raw=json.dumps(value).encode();self.send_response(200);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
   def do_GET(self):
    with lock:events.append(('GET',self.path));value=list(rows.values())if self.path.endswith('/machines')else rows[self.path.rsplit('/',1)[1]]
    self.reply(value)
   def do_POST(self):
    with lock:events.append(('POST',self.path));live[0]+=1;live[1]=max(live)
    time.sleep(.04)
    with lock:
     mid=self.path.split('/')[-2];rows[mid]['state']='stopped';live[0]-=1
    self.reply({})
  server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
  binary=self.root/'flyctl';binary.write_text('#!/bin/sh\nexit 0\n');binary.chmod(0o700)
  env=dict(os.environ,PATH=str(self.root)+':'+os.environ['PATH'],FLY_API_HOSTNAME=f'http://127.0.0.1:{server.server_port}',FLY_BENCH_API_TOKEN='fixture-token-with-at-least20chars')
  r=subprocess.run(['bash',str(ROOT/'scripts/run-bench'),'stop-all','--app','fixture','--execute','--out-dir',str(self.root/'out'),'--workers','3'],env=env,capture_output=True,text=True,timeout=20)
  self.assertEqual(r.returncode,0,r.stderr);summary=json.loads(r.stdout);self.assertTrue(summary['all_stopped']);self.assertEqual(len(summary['results']),8);self.assertGreater(live[1],1);self.assertLessEqual(live[1],3)
  posts=[p for m,p in events if m=='POST'];self.assertEqual(len(posts),8);self.assertTrue(all(p.startswith('/v1/apps/fixture/machines/')and p.endswith('/stop')for p in posts));self.assertEqual(len(posts),len(set(posts)))
 def stop(self,api,seconds=.15):
  out=self.root/'one';H['stop_one'](api,machine(),out,time.monotonic()+seconds);return out
 def test_ambiguous_stop_fresh_stopped_no_retry(self):
  class Api:
   calls=[]
   def api(self,m,p,*args,**kwargs):
    self.calls.append(m)
    if m=='POST':raise TimeoutError('ambiguous')
    return machine(state='stopped')
  a=Api();out=self.stop(a);self.assertEqual(a.calls,['POST','GET']);self.assertEqual(json.loads((out/'terminal.json').read_text())['status'],'STOPPED_CONFIRMED');self.assertTrue((out/'stop-error.json').exists())
 def test_timeout_pending_single_post(self):
  class Api:
   calls=[]
   def api(self,m,p,*args,**kwargs):self.calls.append(m);time.sleep(1)
  a=Api();start=time.monotonic();out=self.stop(a,.04);self.assertLess(time.monotonic()-start,.3);self.assertEqual(a.calls,['POST']);self.assertTrue(not(out/'terminal.json').exists()or json.loads((out/'terminal.json').read_text())['status']=='PENDING');self.assertTrue((out/'stop-intent.json').exists())
 def test_identity_drift_never_confirms(self):
  class Api:
   def api(self,m,p,*args,**kwargs):return {}if m=='POST'else dict(machine(state='stopped'),instance_id='other')
  out=self.stop(Api());self.assertEqual(json.loads((out/'terminal.json').read_text())['status'],'PENDING')
 def test_local_save_is_inside_whole_deadline(self):
  original=H['save'];calls=[]
  class Api:
   def api(self,*a,**k):calls.append(a);return {}
  def slow(path,value):time.sleep(.2);original(path,value)
  with patch.dict(H['stop_one'].__globals__,save=slow):
   start=time.monotonic();self.stop(Api(),.03);self.assertLess(time.monotonic()-start,.15)
  self.assertEqual(calls,[])
 def test_percall_absolute_deadline_not_socket(self):
  class Api:
   def api(self,*a,**k):time.sleep(.2)
  with self.assertRaises(H['Deadline']):H['call'](Api(),'GET','/machines',time.monotonic()+.03)
 def test_no_repeat_into_existing_output(self):
  class Api:
   calls=[]
   def api(self,*a,**k):self.calls.append(a);return []
  out=self.root/'exists';out.mkdir();a=Api()
  with self.assertRaises(FileExistsError):H['run'](a,'fixture',out)
  self.assertEqual(a.calls,[])
 def test_duplicate_inventory_refuses(self):
  with self.assertRaises(ValueError):H['inventory']([machine(),machine()])
 def test_final_active_inventory_non_success(self):
  # No targets are stopped implicitly when another Machine appears active later.
  class Api:
   count=0
   def api(self,*a,**k):self.count+=1;return [machine(state='stopped'if self.count==1 else'started')]
  result=H['run'](Api(),'fixture',self.root/'active');self.assertFalse(result['all_stopped']);self.assertEqual(result['active_remaining'],['0123456789abcd'])
 def test_self_stop_refuses_before_post(self):
  class Api:
   calls=[]
   def api(self,m,*a,**k):self.calls.append(m);return [machine()]
  a=Api()
  with patch.dict(os.environ,FLY_APP_NAME='fixture',FLY_MACHINE_ID='0123456789abcd'):
   with self.assertRaisesRegex(ValueError,'outside'):H['run'](a,'fixture',self.root/'self')
  self.assertEqual(a.calls,['GET'])
 def test_created_suspended_not_stop_targets(self):
  class Api:
   calls=[]
   def api(self,m,*a,**k):self.calls.append(m);return [machine(state='created'),machine('abcdef01234567',state='suspended')]
  a=Api();r=H['run'](a,'fixture',self.root/'idle');self.assertEqual(a.calls,['GET','GET']);self.assertEqual(r['results'],[]);self.assertFalse(r['all_stopped'])
 def test_unknown_state_refuses(self):
  with self.assertRaisesRegex(ValueError,'unknown'):H['inventory']([machine(state='new-unknown')])
 def test_explicit_signal_distinct_no_auto_escalation(self):
  class Api:
   calls=[]
   def api(self,m,p,body=None,**k):self.calls.append((m,body));return {}if m=='POST'else machine(state='stopped')
  a=Api();out=self.root/'kill';H['stop_one'](a,machine(),out,time.monotonic()+1,'SIGKILL');self.assertEqual(a.calls[0],('POST',{'signal':'SIGKILL','timeout':'1s'}));self.assertEqual(len([x for x in a.calls if x[0]=='POST']),1)
 def test_forked_child_mkdir_inside_absolute_alarm(self):
  import multiprocessing
  original=Path.mkdir
  class Api:
   def api(self,*a,**k):raise AssertionError('mkdir must expire before provider')
  def slow(path,*a,**k):time.sleep(.6);return original(path,*a,**k)
  context=multiprocessing.get_context('fork')
  with patch.object(Path,'mkdir',slow):
   child=context.Process(target=H['stop_one'],args=(Api(),machine(),self.root/'slow-mkdir',time.monotonic()+.04));child.start()
  try:
   child.join(.25);self.assertFalse(child.is_alive(),'child mkdir escaped65s-equivalent alarm')
  finally:child.join(2)
  self.assertFalse((self.root/'slow-mkdir').exists())
if __name__=='__main__':unittest.main()
