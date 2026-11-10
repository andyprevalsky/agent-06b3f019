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
 need(set(proof)-{'recovered_runtime'}=={'kind','owner','request_token','source','receipt_sha256','worker_result_sha256','confirmed_at','observed_by','layout','campaign','files','observation_loss'} and ('recovered_runtime'not in proof or isinstance(proof['recovered_runtime'],dict)),'proof fields')
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
