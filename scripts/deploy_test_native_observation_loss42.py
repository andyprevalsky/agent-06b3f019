"""Exact round42 lost-coordinator admission; original UNKNOWNs and task outcomes stay immutable.

This only selects existing full native cleanup guards. It supplies no missing audit, runtime,
financial, provider, Hub, relay or publication evidence and never normalizes process flags.
"""
import hashlib,json,subprocess,time
from pathlib import Path
from datetime import datetime
CAPTURE = {'source': {'head': '431b7c4cb2aff2af425c95d0f2aedd658e843b9c', 'digest': 'a6107a35dcdc0350f86d54f05d0089be6af7f3da1f6305feef9fd87d5c631104'}, 'token': '03c4d0faac5a49f2b1aeb75851f5f741', 'request_sha256': '2b93d801b78ef3d084e23f63504f26ab289576882cf8aaee8100cd200b6c1461', 'receipt_sha256': '2be533ffdce4cd9a41bdc414d89bfbb1ef2157958c6832cb93bbefb8dccd89cc', 'adapter_sha256': 'd6fedaff877cd753a6358308550f8a5a171912d86e2af75b7a85b1ab5eb3c235', 'summary_sha256': '7183a1c5c98bb2e1a60ecaff4a29e7619af2adbbe2a9d50f256c58a6c5224f67', 'journal_sha256': '1004c43e9d35799cf568448363493b2d25ea29b41e930bda8afd62194516b312', 'marker_sha256': '58f178cc80ec287bca2ace94d4cc828198c169698a84b8fb4502785a98a9dce9', 'native_cleanup_before_sha256': 'ce44aa5979c92a477687a1fda5f43ff94115f8f5a2e9edbbaadfaeac8ce0422f', 'producer_sha256': {'scripts/run-bench': 'b308ad2be0a9e9bdadc98e25a1240d8799796086d665c996e0808808ada8fbbb', 'scripts/run-bench-fleet': 'e57c208ab78775d9b21dc4ac4bd64ac813621b5e27bf1ea870c2fbcfa67ef68b', 'scripts/run-bench-campaign.py': 'cf60fcee75fc673ea2d6ccee928009a67262fdd8e3c5e28f38a3724ac33f57ca', 'scripts/deploy_test_cloud.py': 'edc9fc221e3b04e897f492b725fb0cc237624adf8fe3db0279ca3b6746b16cee', 'scripts/cloudbench_execution_provenance.py': '25c3d3b7cd13370c86ce0a36d68660f005096a71be79a77bfbe1ef1390fb019f', 'scripts/cloudbench-status-server.py': '738ad4b98a1aa1f441601ae078b3f9f405e275ec492ccc75f8a10621425c5093'}}
LAYOUT='campaign-observation-loss-mixed42-v1'
KIND='native-coordinator-observation-loss42-v1'
def need(value,message):
 if not value:raise ValueError('observation-loss42: '+message)
def encoded(value):return (json.dumps(value,indent=2,allow_nan=False)+'\n').encode()
def read(path):
 need(path.is_absolute() and path.resolve()==path and path.is_file() and not path.is_symlink(),'exact regular capture')
 need(path.stat().st_size<=64*1024*1024,'bounded capture')
 return path.read_bytes()
def sha(path):return hashlib.sha256(read(path)).hexdigest()
def contract(proof):
 isolated=proof.get('purpose')=='isolated-validation'
 base={'kind','owner','request_token','source','receipt_sha256','worker_result_sha256','confirmed_at','observed_by','layout','campaign','files','observation_loss'}
 if isolated:
  need(set(proof)==base|{'purpose','validation_source','execution_quiescence','retained_volume_lineage'},'isolated proof fields')
  target=proof['validation_source']
  need(isinstance(target,dict) and set(target)=={'head','digest'} and isinstance(target['head'],str) and isinstance(target['digest'],str)
       and __import__('re').fullmatch('[0-9a-f]{40}|[0-9a-f]{64}',target['head']) and __import__('re').fullmatch('[0-9a-f]{64}',target['digest']),'isolated next source')
  need(isinstance(proof['execution_quiescence'],dict) and isinstance(proof['retained_volume_lineage'],dict),'isolated observation objects')
 else:
  need(set(proof)-{'recovered_runtime'}==base and ('recovered_runtime'not in proof or isinstance(proof['recovered_runtime'],dict)),'proof fields')
 typed=proof['observation_loss']
 need(isinstance(typed,dict) and type(typed.get('version'))is int and typed['version']==1,'typed integer version')
 credit=typed.get('credit')
 need(isinstance(credit,dict) and set(credit)=={'test_execution','assertions','financial_release'} and all(type(v)is bool and v is False for v in credit.values()),'typed explicit boolean false credits')
 need(typed=={'kind':KIND,'version':1,'journal_sha256':CAPTURE['journal_sha256'],'marker_sha256':CAPTURE['marker_sha256'],'credit':{'test_execution':False,'assertions':False,'financial_release':False}},'typed contract/credit')
def admit(receipt,owner,proof,adapter,root):
 contract(proof);folder=Path(receipt['log']).parent
 need(receipt['source']==adapter['source']==CAPTURE['source'] and receipt['token']==adapter['token']==CAPTURE['token'],'original source/token')
 for name,path in [('request',folder/'request.json'),('receipt',folder/'receipt.json'),('adapter',Path(receipt['worker_result']))]:need(sha(path)==CAPTURE[name+'_sha256'],'original '+name+' changed')
 need(receipt.get('kind')=='recovered-native-execution-v1' and receipt['status']=='FAIL' and receipt['complete']is False and receipt['executed']is True,'negative original receipt')
 need(all(receipt.get(k)=='UNKNOWN' for k in ['native_exit','timed_out','cancelled','lingering_group']) and receipt['started_at']is None and receipt['finished_at']is None,'unknown coordinator facts preserved')
 need(receipt['native_cleanup_reference']==owner['native_cleanup_reference'] and receipt['cleanup_owner']==owner and owner['native_cleanup_reference']['cleanup_complete']is False,'exact retained native owner')
 need(adapter.get('native_exit')==1 and adapter.get('complete')is False and adapter.get('cleanup_complete')is False and adapter.get('reused')is False,'actual incomplete producer')
 need(receipt['native_producer_started_at']==adapter['started_at'] and receipt['native_producer_finished_at']==adapter['finished_at'],'producer clocks distinct')
 need(type(adapter['finished_at'])in(int,float) and type(proof['confirmed_at'])in(int,float) and adapter['started_at']<=adapter['finished_at']<=proof['confirmed_at']<=time.time(),'actual producer/observation clocks')
 need(proof['receipt_sha256']==CAPTURE['receipt_sha256'] and proof['worker_result_sha256']==CAPTURE['adapter_sha256'],'proof identity')
 return adapter['finished_at']
def consume_settlement(root,proof,bound,document):
 # The current retention/source repair is not authority for an old431 execution.
 # bound() records historical_sources, so subsequent native source reads retain this Git authority.
 for relative,expected in CAPTURE['producer_sha256'].items():
  original=bound(root/relative,historical_head=CAPTURE['source']['head'])
  need(hashlib.sha256(original).hexdigest()==expected,'actual431 historical producer changed: '+relative)
 # The common body executes this observer. Refuse changed current observer semantics
 # until separately reviewed; retention's changed run-bench-fleet remains historical-only.
 observer=root/'scripts/run-bench-campaign.py'
 need(sha(observer)==CAPTURE['producer_sha256']['scripts/run-bench-campaign.py'],'current Hub observer changed; historical observer admission needs review')
 directory=Path(proof['owner']['native_cleanup_reference']['result']).parents[4]
 need(directory==root/'.context/deploy-pipeline','exact native state root')
 journal=directory/'settlement-round42-journal.json';marker=directory/'settlement-round42-committed.json'
 need(hashlib.sha256(bound(journal)).hexdigest()==CAPTURE['journal_sha256'] and hashlib.sha256(bound(marker)).hexdigest()==CAPTURE['marker_sha256'],'committed exact settlement')
 j=document(journal);need(document(marker)=={'journal_sha256':CAPTURE['journal_sha256']} and j['kind']=='native-settlement-journal-v1' and j['round']==42 and j['native_source']==CAPTURE['source'] and j['positive_credit']is False,'native settlement authority')
 receipt=Path(proof['owner']['native_cleanup_reference']['result']).with_name('receipt.json')
 need(j['output_sha256'][str(receipt)]==CAPTURE['receipt_sha256'],'settlement original output')
 # Current OS observations, not a reconstructed historical join. Reuse refuses as well.
 pids=set(j['quiescence']['original_pid_absence']);need(pids and all(type(p)is int and p>1 and not Path('/proc',str(p)).exists() for p in pids),'original PID present/unknown')
 rows=subprocess.check_output(['ps','-ax','-o','pid=,pgid=,stat='],text=True)
 for line in rows.splitlines():
  row=line.split()
  if len(row)>=3 and not row[2].startswith('Z'):need(int(row[0])not in pids and int(row[1])not in pids,'original process group remains')
def require_current_owner_release(root,adapter):
 # A fork/copy, source fix, or retired controller never proves native resource release.
 # These current observations only add refusals; the unchanged full verifier below must
 # still authenticate every mirrored audit, provenance, runtime, Hub and publication.
 from deploy_test_native_cleanup import fleet_audit_root,fleet_ownership_root,fields
 runs=Path(adapter['fleet_directory']).parents[1]/'runs'
 owners=[]
 for fleet in sorted(runs.iterdir()):
  if not fleet.is_dir() or fleet.name=='_hub':continue
  pointer=fleet/'teardown-ownership.path';need(pointer.is_file() and not pointer.is_symlink(),'exact owner audit pointer absent')
  audit=Path(read(pointer).decode().strip());need(audit.parent==fleet_audit_root(root),'canonical owner audit root')
  meta=fields(read(audit/'meta'));owner=meta['fleet_owner_token'];owners.append(owner)
  need(audit.name==owner and meta['run_id']==fleet.name,'actual participant owner')
  registry=fleet_ownership_root(root)/owner
  need(not registry.exists() and not registry.is_symlink() and meta.get('status')=='provider-teardown-verified' and (audit/'provider-teardown-verified.epoch').is_file() and (fleet/'teardown-ownership/source-audit').is_file(),'native owner not legitimately closed: '+owner)
 need(len(owners)==len(set(owners))==13,'all12main plus separateN2 owner coverage')
def mixed_jobs(root,campaign,request,receipt,adapter,summary,proof):
 need(hashlib.sha256(encoded(summary)).hexdigest()==CAPTURE['summary_sha256'],'actual terminal summary changed')
 need(proof['campaign']==str(campaign) and summary['status']=='failed' and summary['runs']==1 and summary['retry_infra']==0 and summary['concurrency']==summary['peak_concurrency']==6,'actual mixed campaign')
 checks,jobs=request['checks'],summary['jobs'];need(len(checks)==len(set(checks))==len(jobs)==17,'actual17inventory')
 need(adapter['cases']=={k:('PASS'if i<6 else'UNVERIFIED')for i,k in enumerate(checks)},'six genuine native PASS evidence only')
 need(receipt['cases']==dict(adapter['cases'],**dict.fromkeys(request['skips'],'SKIP')) and all(v is False for v in receipt['case_complete'].values()),'no new execution credit')
 launched=[];unstarted=[]
 for i,job in enumerate(jobs,1):
  need(job['index']==i and job['job_id']==f'r001-j{i:04d}' and job['task']==checks[i-1] and job['run']==job['attempt']==1 and job['attempts']==[] and job['log']==str(campaign/(job['job_id']+'.log')) and job['controller_command']==['bash',str(root/'scripts/run-bench'),job['task'],'--ref',CAPTURE['source']['head'],'--foreground'],'ordered exact dispatch')
  if i>12:
   need(job['status']=='cancelled' and all(job.get(k)is None for k in ['controller_pid','controller_exit_code','started_at','finished_at','wall_clock_seconds','run_id','fleet_dir','fleet_owner_token']) and not Path(job['log']).exists() and not Path(job['log']).is_symlink(),'never-started acquired identity')
   unstarted.append(job['job_id']);continue
  need(type(job['controller_pid'])is int and job['controller_pid']>1 and type(job['controller_exit_code'])is int,'launched exact process')
  if i<=6:need(job['status']=='passed' and job['controller_exit_code']==0 and job['task_status']=='PASSED' and job['terminal_task']is True and job['resources_released']is True and job['lifecycle_verified']is True,'native genuine PASS unchanged')
  elif i==8:need(job['status']=='failed' and job['controller_exit_code']==1 and job['task_status']=='INFRA_ERROR','original first failure')
  else:need(job['status']=='cancelled' and job['controller_exit_code']==(143 if i in(10,12)else 1),'native cancelled sibling unchanged')
  launched.append(job)
 stop=summary['infra_stop'];need(stop['job_id']=='r001-j0008' and stop['task']=='agent-payment-test-shop' and stop['infra_jobs']==1 and stop['infra_job_ids']==['r001-j0008'] and stop['scheduled_total']==17 and stop['policy']=='enabled','original infra stop')
 need(len(launched)==12 and len(unstarted)==5,'actual12launched5unstarted')
 return frozenset(unstarted)

def validate_retained_volume_lineage(root,runs,receipt,adapter,proof,bound,document):
 """Exclude exact retained originals/copies for launch only; never certify recovery."""
 from deploy_test_native_cleanup import fleet_git_common
 expected=(
  ('shop','f05beba81bdf478691b96b82bfef50c0','20261110-064451-3970418','84ee730a234e48','vol_v3g3q8mdp9knpzm4','vol_rkgpz9dw009w9kk4','cf42_f05_raw_20261110','retained-volume-fork-v2-direct-cli'),
  ('setup','dabd559f5c234116a7503af648474f0e','20261110-064626-4011530','0807666a7e7638','vol_4m3ozdyn853nmm1v','vol_4ql2yxg962pj99gr','cf42_dabd_raw_20261110','retained-volume-fork-v1-direct-cli'),
  ('biometrics','235d14dafb7f44ef942a9eb621dc7a7d','20261110-064836-4067866','8744e50a0e0d58','vol_r68x06909oyl5n14','vol_v8egm37n1wmoxl7v','cf42_235d_raw_20261110','retained-volume-fork-v1-direct-cli'))
 lineage=proof['retained_volume_lineage']
 need(isinstance(lineage,dict) and set(lineage)=={'kind','wire_observation','wire_observation_sha256','copies','test_credit','cleanup_credit','financial_credit'}
      and lineage['kind']=='retained-volume-lineage42-v1','retained lineage schema')
 need(all(type(lineage.get(k))is bool and lineage[k]is False for k in ('test_credit','cleanup_credit','financial_credit')),'retained lineage false credits')
 copies=lineage['copies'];need(isinstance(copies,list) and len(copies)==3,'all three retained copies')
 observation_raw=bound(Path(lineage['wire_observation']))
 need(hashlib.sha256(observation_raw).hexdigest()==lineage['wire_observation_sha256'],'retained wire observation seal')
 observation=json.loads(observation_raw)
 observed=datetime.fromisoformat(observation['observed_at']).timestamp()
 need(type(observed)in(int,float) and adapter['finished_at']<=observed<=proof['confirmed_at']<=time.time(),
      'retained lineage observation clock')
 rows=observation['rows'];need(isinstance(rows,list) and len(rows)==3,'all three actual wire observations')
 need({row.get('label')for row in rows}=={row[0]for row in expected}
      and {row.get('owner')for row in rows}=={row[1]for row in expected},'wire owner closure')
 fences=fleet_git_common(root)/'cloudbench-native-effect-fences';excluded={}
 for label,owner,run,machine,source,copy,name,leaf in expected:
  values=[row for row in copies if row.get('owner')==owner]
  need(len(values)==1,'retained copy owner identity');link=values[0]
  need(set(link)=={'owner','run_id','machine_id','source_volume_id','copy_volume_id','fork_intent','fork_result'}
       and link['run_id']==run and link['machine_id']==machine and link['source_volume_id']==source
       and link['copy_volume_id']==copy and (runs/run).is_dir(),'retained exact original/copy binding')
  effect=fences/owner/run/source/leaf
  need(link['fork_intent']==str(effect/'intent.json') and link['fork_result']==str(effect/'result.json'),
       'native fork effect-fence authority')
  raw_intent=bound(effect/'intent.json');intent=json.loads(raw_intent);result=document(effect/'result.json')
  need(intent.get('schema')=='pr1865-one-shot-native-volume-fork-v1'
       and intent.get('source_ref')==CAPTURE['source']['head'] and intent.get('app')=='navi-whisper-lux-bench'
       and intent.get('owner')==owner and intent.get('run_id')==run and intent.get('source_machine')==machine
       and intent.get('source_volume')==source and intent.get('new_exact_name')==name
       and intent.get('credit')is False and intent.get('original_flags_unchanged')is True,
       'native original preservation intent')
  need(result.get('intent_sha256')==hashlib.sha256(raw_intent).hexdigest()
       and type(result.get('native_exit_code'))is int and result['native_exit_code']==0
       and result.get('fork_id')==copy and result.get('original_source_unchanged')is True
       and result.get('credit')is False
       and result.get('status')=='COPY_RETURNED_PENDING_POSITIVE_READBACK', 'native copy acceptance only')
  stdout=bound(effect/'native.stdout.private.log');stderr=bound(effect/'native.stderr.private.log')
  need(hashlib.sha256(stdout).hexdigest()==result.get('stdout_sha256')
       and hashlib.sha256(stderr).hexdigest()==result.get('stderr_sha256')
       and json.loads(stdout)==result.get('native_json') and result['native_json'].get('id')==copy
       and result['native_json'].get('name')==name,'native fork stdout/result seal')
  # Authenticate every actual HTTP GET in the immutable original one-shot effect fence.
  wire=result.get('wire');need(isinstance(wire,list) and len(wire)==6,'native fork wire closure')
  for record in wire:
   path=Path(record['path_local'])
   need(path.parent==effect and record.get('method')=='GET' and type(record.get('http_status'))is int
        and record['http_status']==200 and hashlib.sha256(bound(path)).hexdigest()==record.get('sha256'),
        'native fork actual wire body')
  need(intent.get('source_gets')==wire[:3],'native fork original GETs')
  before_machine=document(effect/'original-machine-before.raw.json');after_machine=document(effect/'original-machine-after.raw.json')
  before_source=document(effect/'original-volume-before.raw.json');after_source=document(effect/'original-volume-after.raw.json')
  need(before_machine==after_machine and before_source==after_source,'original fork operation changed source')
  row=next(row for row in rows if row['label']==label)
  need(row.get('owner')==owner and row.get('original_source_unchanged')is True,'current original preservation')
  current=row.get('wire');need(isinstance(current,list) and len(current)==3,'current exact triple wire closure')
  objects={}
  for role,suffix in [('machine','original-machine.raw.json'),('source','source.raw.json'),('copy','copy.raw.json')]:
   matches=[record for record in current if Path(record.get('path','')).name.endswith('-'+suffix)]
   need(len(matches)==1,'current exact response role');record=matches[0]
   need(type(record.get('http_status'))is int and record['http_status']==200,'actual current HTTP200 required')
   raw=bound(Path(record['path']));need(hashlib.sha256(raw).hexdigest()==record.get('sha256'),'current raw HTTP body hash')
   objects[role]=json.loads(raw)
  need(objects['machine']==after_machine and objects['source']==after_source,'current original body changed')
  native=objects['machine'];env=native.get('config',{}).get('env',{})
  need(native.get('id')==machine and native.get('state')=='destroyed'
       and env.get('REF')==CAPTURE['source']['head'] and env.get('CLOUDBENCH_RUN_TOKEN')==owner+'-0'
       and any(m.get('volume')==source and m.get('path')=='/data'for m in native['config'].get('mounts',[])),
       'original destroyed source/config/mount identity')
  for role,identity,states in [('source',source,{'pending_destroy','destroyed'}),('copy',copy,{'enabling_remote_export','created'})]:
   volume=objects[role]
   need(volume.get('id')==identity and volume.get('state')in states and volume.get('region')=='iad'
        and type(volume.get('size_gb'))is int and volume['size_gb']==40 and volume.get('encrypted')is True
        and volume.get('host_status')=='ok' and volume.get('attached_machine_id')is None
        and volume.get('attached_alloc_id')is None,'retained volume attached/identity/health unknown')
  projected=row.get('copy',{})
  need(isinstance(projected,dict) and set(projected)=={'id','state','name','region','size_gb','encrypted','created_at','attached_machine_id','attached_alloc_id','host_status'}
       and objects['copy'].get('name')==name and projected=={k:objects['copy'].get(k)for k in projected},'current copy metadata/body mismatch')
  excluded[copy]=source
 need(len(excluded)==3,'retained copy exclusion closure')
 return excluded

def isolated_unallocated42(fleet,life,root,receipt,proof,row,bound,document,tree,execution_start):
 """Authenticate the sealed positive no-allocation row; blank identity alone is never authority."""
 from deploy_test_native_cleanup import fleet_audit_root,fleet_ownership_root,fields,finite
 owner='59b616a74c9c41bb9ab129d1ecd7079d';name='cloudbench-372dd2aa726a4c16b781e60c'
 need(proof.get('purpose')=='isolated-validation' and proof.get('layout')==LAYOUT and receipt['source']==CAPTURE['source']
      and fleet.name=='20261110-065812-151812' and life['fleet_owner_token']==owner,'isolated unallocated42 scope')
 need(row=={'version':'1','fleet_owner_token':owner,'run_id':fleet.name,'app':'navi-whisper-lux-bench',
            'clone_name':name,'source':'fresh-clone','source_machine_id':'683e47df5094d8',
            'machine_id':'','volume_id':'','disposition':'not-allocated-verified'},'positive native unallocated42 row')
 audit=fleet_audit_root(root)/owner;local=fleet/'teardown-ownership';registry=fleet_ownership_root(root)/owner
 need(not registry.exists() and not registry.is_symlink(),'unallocated42 native registry remains')
 # Independently witnessed native seal. The pinned431 producer verifies complete native
 # name absence before publishing provider-teardown-verified; a forged empty row cannot self-certify.
 seal='f66d462a26e36640eddff7a4a87bb8d1166cf5c50795ef3ce46e45cac4a91554'
 need(tree(audit)==tree(local)==life['audit_sha256']==seal
      and fields(bound(local/'source-audit'))=={'path':str(audit),'sha256':seal},'unallocated42 mirrored native release seal')
 meta=fields(bound(audit/'meta'))
 need(meta.get('status')=='provider-teardown-verified' and meta.get('fleet_owner_token')==owner
      and meta.get('run_id')==fleet.name and meta.get('workspace_root')==str(root),'unallocated42 provider authority')
 epoch=float(bound(audit/'provider-teardown-verified.epoch'))
 need(finite(epoch) and execution_start<=epoch<=proof['confirmed_at'],'unallocated42 release clock')
 need(hashlib.sha256(bound(audit/'fresh'/name)).hexdigest()=='0dde49ed0f90b62fdf61170e68edf65b48a590212a5da716bde46f6f44312bfc'
      and fields(bound(audit/'expected-fresh'/name))=={'clone_name':name,'source_machine_id':'683e47df5094d8'}
      and bound(audit/'owned-clones.ids')==b'' and bound(audit/'owned-clones.names')==(name+'\n').encode()
      and not any((audit/'by-machine-id').iterdir()),'unallocated42 expected intent/native IDs')
 disposable=document(fleet/'_batch/disposable-cleanup.json')
 need(disposable=={'schema':'disposable-cleanup-v1','owner':owner,'guest_cleanup_missing':False,
                   'runtime_evidence_missing':False,'successful_runtime_inferred':False}
      and life['status']=='failed' and type(life['controller_exit_code'])is int and life['controller_exit_code']==143,
      'unallocated42 no runtime inference/terminal projection')
 task=fleet/'agent-payment-new-user-journey'
 need(bound(task/'primary.names')==(name+'\n').encode(),'unallocated42 intended primary name')
 for filename in ('.cid','primary.ids','worker-clones.ids','cloudbench-run.json'):
  path=task/filename;need(not path.exists() and not path.is_symlink(),'unallocated42 acquired task allocation')
 return True


def isolated_relay_retired42(root,campaign,receipt,proof,bound,document):
 """Terminal relay JSON is preserved metadata, never an active consumer or release credit."""
 from deploy_test_native_cleanup import retired_local_process
 import re
 need(proof.get('purpose')=='isolated-validation' and proof.get('layout')==LAYOUT
      and receipt['token']==CAPTURE['token'] and receipt['source']==CAPTURE['source'],'isolated relay42 scope')
 location=document(campaign/'shared-relay-location.json')['directory'];directory=Path(location)
 need(re.fullmatch(r'/tmp/cb-relay-[A-Za-z0-9_]{8}',location) and directory.resolve()==directory
      and directory.is_dir() and not directory.is_symlink(),'isolated relay42 namespace')
 archive=campaign/'shared-relay';records={}
 for name in ('authority.private.json','startup-agent.json','bootstrap-owner.json','broker-owner.json','ready.json','serve.once.json','broker.private.log'):
  raw=bound(directory/name);need(raw==bound(archive/name),'isolated relay42 mirror changed')
  if name!='broker.private.log':records[name]=json.loads(raw)
  else:need(raw.strip()==b'{"stopped": true}','isolated relay42 native shutdown unconfirmed')
 authority=records['authority.private.json'];capture=records['startup-agent.json'];bootstrap=records['bootstrap-owner.json'];broker=records['broker-owner.json'];ready=records['ready.json'];once=records['serve.once.json']
 original=bound(root/'scripts/cloudbench-shared-relay.py',historical_head=CAPTURE['source']['head'])
 authority_sha=hashlib.sha256(bound(directory/'authority.private.json')).hexdigest()
 need(authority_sha=='38485dec40f5aaa136b6952928586c9b5d086c9002e7644af7e2944ab3b6d1d1','isolated relay42 original authority seal')
 parent=dict(pid=authority['parent_pid'],birth=authority['parent_start'])
 need(authority.get('schema')=='shared-relay-authority-v1' and authority.get('app')=='navi-whisper-lux-bench'
      and authority.get('source_sha256')==hashlib.sha256(original).hexdigest()
      and authority.get('inventory_directory')==str(campaign/'shared-inventory')
      and capture.get('schema')=='shared-relay-startup-agent-v1'
      and capture.get('authority_sha256')==ready.get('authority_sha256')==once.get('authority_sha256')==authority_sha
      and capture.get('parent')==parent and capture.get('broker')==dict(pid=broker['pid'],birth=broker['birth'])
      and ready.get('agent')==capture.get('agent') and ready['pid']==once['pid']==broker['pid']
      and ready['birth']==once['birth']==broker['birth']
      and all(value.get('parent_pid')==parent['pid'] and value.get('parent_start')==parent['birth']for value in (bootstrap,broker))
      and capture.get('socket')==authority.get('agent_socket')==location+'/fly-agent.sock'
      and ready.get('socket')==location+'/control.sock','isolated relay42 native custody')
 identities=[parent,bootstrap,broker,capture['agent']]
 need(len({v['pid']for v in identities})==len(identities),'isolated relay42 aliased owner')
 for value in identities:retired_local_process(value)
 for name in ('fly-agent.sock','control.sock'):
  path=directory/name;need(not path.exists() and not path.is_symlink(),'isolated relay42 socket remains')
 live,mirrored=directory/'leases',archive/'leases'
 need(all(path.resolve()==path and path.is_dir() and not path.is_symlink()for path in (live,mirrored)),
      'isolated relay42 lease directories')
 paths=sorted(live.iterdir());mirrors=sorted(mirrored.iterdir())
 need(len(paths)==37 and [p.name for p in paths]==[p.name for p in mirrors], 'isolated relay42 exact lease inventory')
 inventory=hashlib.sha256()
 for path,mirror in zip(paths,mirrors):
  need(re.fullmatch(r'[0-9a-f]{32}\.json',path.name),'isolated relay42 live/unknown lease artifact')
  raw=bound(path);need(raw==bound(mirror),'isolated relay42 lease mirror changed');row=json.loads(raw)
  need(set(row)=={'authority_sha256','instance_id','lease','local_port','mid','owner_pid','owner_start','remote_ip','remote_port','state','token'}
       and row.get('lease')==path.stem and row.get('authority_sha256')==authority_sha
       and row.get('state')in {'closed','abandoned'},'isolated relay42 lease not natively terminal')
  need(type(row['owner_pid'])is int and row['owner_pid']>1
       and isinstance(row['owner_start'],str) and re.fullmatch(r'proc-start:[0-9a-f-]+:[0-9]+',row['owner_start']),
       'isolated relay42 terminal lease identity')
  # Native retire() has already joined this route. Its old client may be a
  # healthy shared daemon; terminal metadata grants no signal/absence authority.
  for value in (path.name.encode(),raw):inventory.update(len(value).to_bytes(8,'big'));inventory.update(value)
 need(inventory.hexdigest()=='5b4f47b7e929fd97851c4daeb34e86438c91aef57f408ad9b542d6b617739450','isolated relay42 complete historical lease seal')
 need(paths==sorted(live.iterdir()) and mirrors==sorted(mirrored.iterdir()),'isolated relay42 lease membership changed')
 return {'terminal_records':len(paths),'credit_granted':False,'records_preserved':True}
