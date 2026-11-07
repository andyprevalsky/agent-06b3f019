from pathlib import Path
import os,subprocess,sys,json,tempfile,shutil,socket
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'scripts'))
from deploy_test_process import run_command
with tempfile.TemporaryDirectory(prefix='native-hub-join-') as tmp:
 root=Path(tmp)/'repo';runs=root/'.context/deploy-cloud'/('a'*64)/'runs';hub=runs/'_hub';hub.mkdir(parents=True)
 campaign=runs.parent/'campaigns'/('deploy-'+runs.parent.name);campaign.mkdir(parents=True)
 for rel in ['agents/benchmarks/agent_link_server.py','scripts/lib/cloudbench-env.sh']:
  dest=root/rel;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(ROOT/rel,dest)
 with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
 # Keep a real failed-bind starting owner ahead of the subsequently live Hub.
 with socket.socket() as occupied:
  occupied.bind(('127.0.0.1',0));occupied.listen();failed_port=occupied.getsockname()[1]
  failed_owner=hub/('agent-link-server.'+str(failed_port)+'.'+'0'*32+'.owner')
  failed=subprocess.run([sys.executable,str(root/'agents/benchmarks/agent_link_server.py'),
   '--root',str(runs),'--repo-root',str(root),'--context-dir',str(hub),
   '--frontend-dir',str(root/'front-end'),'--port',str(failed_port),'--hub-runs-dir',str(runs),
   '--owner-file',str(failed_owner),'--owner-token','0'*32],start_new_session=True,capture_output=True,timeout=5)
  assert failed.returncode!=0 and 'status=starting' in failed_owner.read_text()
 owner=hub/('agent-link-server.'+str(port)+'.'+'b'*32+'.owner')
 child_code='''from pathlib import Path
import sys,subprocess,time,runpy,json
root,runs,campaign,owner=map(Path,sys.argv[2:6]);port=sys.argv[6]
p=subprocess.Popen([sys.executable,'-c','import subprocess,sys;subprocess.Popen(sys.argv[1:],start_new_session=True)',sys.executable,str(root/'agents/benchmarks/agent_link_server.py'),'--root',str(runs),'--repo-root',str(root),'--context-dir',str(runs/'_hub'),'--frontend-dir',str(root/'front-end'),'--port',port,'--hub-runs-dir',str(runs),'--owner-file',str(owner),'--owner-token','b'*32])
p.wait(timeout=3)
for _ in range(500):
 if owner.exists() and 'status=live-transfer-required' in owner.read_text():break
 time.sleep(.01)
else:raise SystemExit('Hub never ready')
m=runpy.run_path(sys.argv[1]);m.get('join_native_hubs',lambda *_:True)(root,campaign)
'''
 wrapper=Path(tmp)/'wrapper.py';wrapper.write_text(child_code)
 env={**os.environ,'DEPLOY_NATIVE_HUB_JOIN':'1','CLOUDBENCH_RUNS_ROOT':str(runs)}
 log=Path(tmp)/'native.log'
 with log.open('wb') as out:result=run_command([sys.executable,str(wrapper),sys.argv[1],str(root),str(runs),str(campaign),str(owner),str(port)],cwd=root,env=env,output=out,timeout=15,owned_lifecycle=True)
 sidecar=json.loads(Path(str(log)+'.process.json').read_text());print(json.dumps({'result':result,'supervision':sidecar,'log':log.read_text()}))
 assert result==(0,False,False,False),result
 assert sidecar['orphaned_children'] is False and sidecar['remaining']==[] and sidecar['term_sent']==[]
 assert Path(str(owner)+'.terminal').exists()

 assert not Path(str(failed_owner)+'.terminal').exists(), 'already-retired owner must not gain fabricated termination'
