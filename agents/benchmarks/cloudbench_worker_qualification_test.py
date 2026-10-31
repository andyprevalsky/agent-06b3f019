"""Separate worker qualification: actual demand/readiness/capture/return boundaries."""
import json,os,shlex,subprocess,sys
from pathlib import Path
import pytest
from benchmarks.fixture_proxy_cli import install_proxy_cli
from benchmarks.cloudbench_worker_evidence_test import capture_fixture
from benchmarks.cloudbench_campaign_workspace_test import bound_campaign
ROOT=Path(__file__).resolve().parents[2]
FLEET=Path(os.environ.get('CLOUDBENCH_QUALIFICATION_FLEET_UNDER_TEST',ROOT/'scripts/run-bench-fleet')).read_text()

def shell(script,env=None):
 return subprocess.run(['bash','-eu','-c',script],env={**os.environ,**(env or {})},text=True,capture_output=True,timeout=20)

def floor(mode,desired):
 start=FLEET.index('        # Only explicit qualification changes')
 end=FLEET.index('        # Publish outstanding demand',start)
 return shell(f'QUALIFY_WORKER={mode}; desired={desired}; AUTOSCALE_MAX=15\n'+FLEET[start:end]+'\nprintf "%s" "$want"').stdout

def test_explicit_floor_one_worker():assert floor(1,1)=='1'
def test_original_demand_unchanged():assert floor(0,1)=='0' and floor(0,4)=='3'
def test_higher_actual_demand_not_lowered():assert floor(1,4)=='3'

def capture_return(tmp_path,monkeypatch):
 helper,archive,data,agents,state,expected=capture_fixture(tmp_path,monkeypatch)
 out=tmp_path/'out';e=out/'worker-runtime-evidence'/expected['machine_id'];e.mkdir(parents=True)
 helper.check_archive(archive,expected,e/'capture')
 owner=dict(machine_id=expected['machine_id'],primary_machine_id='primary',run_token=expected['run_token'])
 (e/'owner.json').write_text(json.dumps(owner));borrow=out/'worker-borrowed';borrow.mkdir()
 assignment={**owner,'fleet_owner_token':'fleet','claim_sha256':'claim'}
 returned={**assignment,'state':'stopped','volume_retained':True,'evidence_sha256':__import__('hashlib').sha256((e/'capture/manifest.json').read_bytes()).hexdigest()}
 for suffix,obj in [('',assignment),('.returned',returned),('.released',returned)]:
  (borrow/(expected['machine_id']+suffix+'.json')).write_text(json.dumps(obj))
 (out/('worker-'+expected['machine_id']+'.qualification-ready')).write_text(expected['machine_id']+'|'+expected['run_token']+'|primary\n')
 claims=tmp_path/'claims';claims.mkdir()
 return out,e,expected,claims

def verify(out,claims):
 start=FLEET.index('verify_worker_qualification() {');end=FLEET.index('\ncleanup() {',start)
 return shell(FLEET[start:end]+'\nverify_worker_qualification "$OUT"',{'CLOUDBENCH_SCRIPT_SNAPSHOT':str(ROOT/'scripts'),'FLEET_OWNER_TOKEN':'fleet','POOL_CLAIMS_DIR':str(claims),'OUT':str(out)})

def test_real_capture_and_return_pass(tmp_path,monkeypatch):
 out,e,exp,claims=capture_return(tmp_path,monkeypatch);r=verify(out,claims);assert r.returncode==0,r.stderr
 assert json.loads(r.stdout)['worker_ids']==[exp['machine_id']]

@pytest.mark.parametrize('defect',['no-worker','no-release','still-claimed','no-ready','foreign-owner','changed-capture'])
def test_incomplete_worker_cannot_qualify(tmp_path,monkeypatch,defect):
 out,e,exp,claims=capture_return(tmp_path,monkeypatch);mid=exp['machine_id']
 if defect=='no-worker':(out/'worker-borrowed'/f'{mid}.released.json').unlink()
 elif defect=='no-release':(out/'worker-borrowed'/f'{mid}.returned.json').unlink()
 elif defect=='still-claimed':(claims/mid).write_text('held')
 elif defect=='no-ready':(out/f'worker-{mid}.qualification-ready').unlink()
 elif defect=='foreign-owner':
  p=out/'worker-borrowed'/f'{mid}.json';v=json.loads(p.read_text());v['fleet_owner_token']='foreign';p.write_text(json.dumps(v))
 else:(e/'capture/logs/worker.log').write_text('changed')
 assert verify(out,claims).returncode!=0

def test_actual_ready_producer(tmp_path):
 start=FLEET.index('      publish_worker_ready() {');end=FLEET.index('      log_worker_stage()',start)
 script=FLEET[start:end]+'\npublish_worker_ready'
 env={'out':str(tmp_path),'wid':'worker','runtime_run_token':'run','primary_id':'primary','QUALIFY_WORKER':'1'}
 result=shell(script,env);assert result.returncode==0,result.stderr
 assert (tmp_path/'worker-worker.qualification-ready').read_text()=='worker|run|primary\n'

@pytest.mark.parametrize('defect',['multiple','infra','skip','keep','update','shape','simulate'])
def test_selection_refuses_before_provider(defect):
 start=FLEET.index('# A worker qualification is a separate');end=FLEET.index('# Validate the whole runnable batch',start)
 init='QUALIFY_WORKER=1; BENCHES=(task); INFRA_PROBE=0; SKIP_AUTOSCALER=0; KEEP_CLONES=0; POOL_REUSE_ONLY=1; RECOVER_STALE_ONLY=0; PROVISION_POOL=""; SIM_ON_CSV=""; CLOUDBENCH_BOOT_TRANSPORT=staged; FLEET_WORKER_VM_SIZE=performance-1x; FLEET_WORKER_VM_MEMORY=2048\n'
 change={'multiple':'BENCHES=(one two)','infra':'INFRA_PROBE=1','skip':'SKIP_AUTOSCALER=1','keep':'KEEP_CLONES=1','update':'CLOUDBENCH_BOOT_TRANSPORT=update','shape':'FLEET_WORKER_VM_MEMORY=4096','simulate':'SIM_ON_CSV=task'}[defect]
 assert shell(init+change+'\n'+FLEET[start:end]).returncode==2

def test_real_outer_cli_rejects_campaign(bound_campaign):
 source,workspace,snapshot,ref,task,env=bound_campaign
 r=subprocess.run(['bash',str(source/'scripts/run-bench'),'parallel-tool-calls','--qualify-worker','-k','3','--concurrency','600'],cwd=workspace,env=env,text=True,capture_output=True,timeout=20)
 assert r.returncode==2 and 'separate from campaigns' in r.stderr

def test_provenance_only_explicit_mode():
 import importlib.util
 spec=importlib.util.spec_from_file_location('qualification_provenance',ROOT/'scripts/cloudbench_execution_provenance.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
 assert m.build_config('cloudbench-fleet-config-v1',['worker_qualification_floor=2'])['values']['worker_qualification_floor']=='2'
 assert 'PROVENANCE_CONFIG_ARGS+=(--config-value "worker_qualification_floor=2")' in FLEET


def test_real_outer_cli_forwards_qualification(bound_campaign):
 source,workspace,snapshot,ref,task,env=bound_campaign
 (source/'scripts/run-bench-fleet').write_text("""#!/bin/bash\npython3 -c 'import sys,json;print(json.dumps(sys.argv[1:]))' \"$@\"\n""")
 r=subprocess.run(['bash',str(source/'scripts/run-bench'),'parallel-tool-calls','--qualify-worker','--foreground','--reuse-pool-only','--ref',task],cwd=workspace,env=env,text=True,capture_output=True,timeout=20)
 assert r.returncode==0,r.stdout+r.stderr
 assert '--qualify-worker' in json.loads(r.stdout.strip().splitlines()[-1])


def test_actual_autoscaler_requests_worker_at_idle_floor(tmp_path):
 from benchmarks.cloudbench_dependency_sync_test import _extract_fleet_function
 proxy_bin=install_proxy_cli(tmp_path,['proxy','12345:3003','ip','-a','fixture','--bind-addr','127.0.0.1','-q'],10)
 functions='source '+shlex.quote(str(ROOT/'scripts/lib/cloudbench-env.sh'))+'\n'+'\n'.join(_extract_fleet_function(FLEET,n+'() {')for n in ['bench_autoscaler','_pool_ids','_ready_pool_ids','_box_desired'])
 script=functions+r"""
 QUALIFY_WORKER=1; RUN_ID=fixture; APP=fixture; AUTOSCALE_POLL=.01; AUTOSCALE_MAX=2
 AUTOSCALER_FINALIZATION_WAIT_SECONDS=1; BOX_HEALTH_PORT=3003; CLOUDBENCH_BOOT_LAUNCH=0
 _machine_priv_ip(){ printf ip; }
 claim_autoscaler_metrics_port(){ printf -v "$1" 12345; }
 release_autoscaler_metrics_owner(){ :; }
 cloudbench_terminate_and_wait(){ shift; for p in "$@"; do [ -z "$p" ] || { kill "$p" 2>/dev/null || :; wait "$p" 2>/dev/null || :; }; done; }
 fleet_job_running(){ kill -0 "$1" 2>/dev/null; }
 inventory_machine_exists(){ return 0; }
 curl(){
  case " $* " in *' -o /dev/null '*) return 0;; esac
  if [ -e "$OUT/scraped" ];then printf finished > "$OUT/benchmark-child.finished";fi
  : > "$OUT/scraped"; printf 'desired_machine_count 1\n'
 }
 reconcile_worker_ready_outcomes(){ cp "$1/worker-clones.ids" "$1/worker-ready.ids"; }
 reconcile_worker_failure_outcomes(){ return 0; }
 provision_worker(){ printf 'worker\n' >> "$OUT/worker-clones.ids"; printf finished > "$OUT/benchmark-child.finished"; }
 bench_autoscaler task primary ws 0 "$OUT" 12345 token
 """
 r=shell(script,{'OUT':str(tmp_path),'PATH':str(proxy_bin)+os.pathsep+os.environ.get('PATH',''),'CLOUDBENCH_SHARED_RELAY_AUTHORITY':'','CLOUDBENCH_SHARED_RELAY_DIRECTORY':''})
 assert r.returncode==0,r.stderr+r.stdout
 assert (tmp_path/'worker-clones.ids').read_text()=='worker\n'

 assert (tmp_path/'proxy.commands').read_text().splitlines()==['proxy 12345:3003 ip -a fixture --bind-addr 127.0.0.1 -q']
