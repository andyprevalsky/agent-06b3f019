"""Separate exact-native worker consumer; reuses sealed original admission code.
No import or validation performs a provider call. This is not wired to fleet yet.
"""
from pathlib import Path
import json,os,runpy
D=Path(__file__).resolve().parent
G=runpy.run_path(str(D/'cloudbench-fixed-native-worker-guard.py'));need=G['require'];sha=G['sha']
source=D/'cloudbench-explicit-idle-admission.py'
need(sha(source.read_bytes())=='984480289bdd2da323c747dd4891706e5f308e7861dbd401c76038a7c568d402','original admission source changed')
H=runpy.run_path(str(source));NS=H['validate_request'].__globals__
ORIGINAL_VALIDATE=H['validate_request'];ORIGINAL_AUTHORIZE=H['authorize'];ORIGINAL_STAGE=H['stage_worker']
SCHEMA='cloudbench-fixed-native-worker-admission-v1'
REQUEST_SCHEMA='cloudbench-fixed-native-worker-request-v1'
def native_pair(before,after,resource,reader=H['described']):
 return G['native_pair'](before,after,resource,reader)
def validate_request(request,reader=H['described']):
 need(request['schema']==REQUEST_SCHEMA,'fixed worker request schema')
 need(request['resource']['app']=='navi-whisper-lux-bench','fixed worker app')
 need(request.get('fixed_native_baseline_sha256')==G['BASELINE_SHA'],'fixed worker baseline')
 need(request.get('allowed_future_roles')==['worker'],'fixed native worker-only role')
 protected=reader(request['protected_overlay']);need(isinstance(protected.get('names'),list) and request['resource']['name'] not in protected['names'],'fixed worker protected name')
 need(request.get('worker_environment_policy')==dict(schema='remove-fixed-native-environment-v1',baseline_sha256=G['BASELINE_SHA'],removed_keys=G['baseline']()['env_keys']),'fixed worker environment policy')
 # Only the schema spelling is adapted. Native documents and all observations
 # pass unchanged through the original mandatory proof predicates.
 return ORIGINAL_VALIDATE(dict(request,schema='cloudbench-explicit-idle-request-v1'),reader)
def authorize(path,digest,request,request_sha,custody_fd):
 authority=json.loads(H['read'](path))
 need(authority.get('fixed_native_baseline_sha256')==G['BASELINE_SHA']and authority.get('future_role')=='worker','explicit fixed-worker authority required')
 return ORIGINAL_AUTHORIZE(path,digest,request,request_sha,custody_fd)
def stage_worker(assignment,source,node,python,size,memory,api,*,seconds=120):
 need(H['worker_profile'](size,memory)==G['baseline']()['shape'],'fixed worker profile must remain original')
 def readonly(method,path,body=None,timeout=None):
  need(method=='GET','fixed native worker cannot update configuration')
  value=api(method,path,body,timeout=timeout)
  if path.startswith('/machines/'):
   need(value.get('id')==G['baseline']()['machine']and sha(H['canonical'](value.get('config')))==G['baseline']()['config_sha256'],'fixed worker fresh configuration drift')
  return value
 return ORIGINAL_STAGE(assignment,source,node,python,size,memory,readonly,seconds=seconds)
# All changes are in this isolated module namespace; source bytes and other
# module instances remain unchanged. Original publish/return/custody stay intact.
NS.update(SCHEMA=SCHEMA,native_pair=native_pair,validate_request=validate_request,authorize=authorize,stage_worker=stage_worker)
for name in ('publish','verify_pool','verify_worker_return','record_worker_return','returned_state','current_policy','main'):
 if name in H:globals()[name]=H[name]
def worker_launch_argv(proof_path):
 proof=json.loads(H['read'](proof_path));admission=H['described'](proof['explicit_idle']['admission'])
 need(admission['schema']==SCHEMA and admission['resource']['machine_id']==G['baseline']()['machine'],'fixed worker launch proof')
 need(admission['request']['worker_environment_policy']['baseline_sha256']==G['BASELINE_SHA'],'fixed worker launch environment binding')
 return G['worker_entry_argv']()
if __name__=='__main__':
 import sys,shlex
 if len(sys.argv)==3 and sys.argv[1]=='worker-launch-prefix':print(shlex.join(worker_launch_argv(sys.argv[2])))
 else:
  need(len(sys.argv)>1 and sys.argv[1] in ('admit','worker-stage','worker-return'),'unsupported fixed-worker action')
  main()
