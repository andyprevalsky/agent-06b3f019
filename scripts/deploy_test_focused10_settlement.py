"""Exact focused10 negative observation; never fabricate an original outer receipt."""
import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import stat
import time

KIND = 'focused10-negative-observation-v1'
SOURCE = '585ac3db05a4a0479ad70df59f856d42df0fbd26'
ANCHORS = {
 'smoke': ('182ec5e04e324004a298cfd95cb0badc', 'ed0d1b86243a5540c25dd7ae3b547c8c2f9d4634e64313ebe87dc5013d065a7e', '03184cb13d60d0ac331f35efd40f368f197ee74e2754638dc7021e32cf714329'),
 'new-test-stability': ('2e8399ac32164184ad862b6f5e471863', '4908bed248fadd7ee204c2e9408821a51d6442d6f8389900e7f601d43f016e93', 'e2bd787922b204f8816d3969898ab242ec67a88ebb1684231aedaad6937e2be2'),
}
JOURNAL = 'focused10-negative-journal.json'
COMMITTED = 'focused10-negative-committed.json'

def need(ok, why):
 if not ok: raise ValueError('focused10 negative settlement: '+why)
def encoded(v): return (json.dumps(v,sort_keys=True,indent=2,allow_nan=False)+'\n').encode()
def digest(v): return hashlib.sha256(encoded(v)).hexdigest()
def sha(path):
 p=Path(path);s=p.lstat();need(p.is_absolute() and p.resolve(strict=True)==p and stat.S_ISREG(s.st_mode) and s.st_uid==os.getuid() and not s.st_mode&0o022,'artifact path/owner/mode')
 with p.open('rb')as f:return hashlib.file_digest(f,'sha256').hexdigest()
def doc(path):
 p=Path(path);before=sha(p);need(p.stat().st_size<=32*1024**2,'document limit');v=json.loads(p.read_bytes());need(type(v)is dict and sha(p)==before,'stable document');return v
def absent(pid):
 need(type(pid)is int and pid>1,'PID type')
 try:os.kill(pid,0)
 except ProcessLookupError:pass
 except OSError:raise ValueError('focused10 negative settlement: PID visibility unknown')
 else:raise ValueError('focused10 negative settlement: PID present/reused')
 try:Path('/proc',str(pid)).stat()
 except FileNotFoundError:return
 raise ValueError('focused10 negative settlement: proc identity present')
def terminal(p):
 need(type(p.get('native_exit'))is int and p['native_exit']==1 and p.get('quiescent')is True and p.get('error')is None,'native negative closure')
 need(all(p.get(k)is False for k in ('cancelled','timed_out','orphaned_children')) and all(p.get(k)==[] for k in ('remaining','term_sent','kill_sent')),'native uncertainty')
 need(type(p.get('child_pid'))is int and type(p.get('supervisor_pid'))is int and p['child_pid']!=p['supervisor_pid'],'native PID identity')
 need([x['status']for x in p.get('reaped',[])if x.get('pid')==p['child_pid']]==[256],'native child reap')
 absent(p['child_pid']);absent(p['supervisor_pid'])
def verify_seals(seals, mutable=(), retained=()):
 need(type(seals)is dict and bool(seals),'original seal closure')
 frozen={r['path']:r for r in retained}
 for name,entry in seals.items():
  if name in mutable:continue
  if name in frozen and not Path(name).exists():
   need(not Path(name).is_symlink(),'retired Hub symlink')
   raw=base64.b64decode(frozen[name]['raw_b64'],validate=True)
   need(hashlib.sha256(raw).hexdigest()==frozen[name]['sha256']==entry['sha256'],'frozen Hub seal')
   continue
  need(sha(name)==entry['sha256'],'changed original '+name)
  need(Path(name).stat().st_size==entry['size'] and oct(stat.S_IMODE(Path(name).stat().st_mode))==entry['mode'],'original metadata')
def fields(path):return dict(x.split('=',1)for x in Path(path).read_text().splitlines()if '='in x)
def tree(path):
 p=Path(path);need(p.resolve(strict=True)==p and p.is_dir() and not p.is_symlink(),'audit path');h=hashlib.sha256()
 for f in sorted(p.rglob('*'),key=lambda x:str(x.relative_to(p))):
  need(not f.is_symlink(),'audit symlink')
  if f.is_file()and f.name!='source-audit':
   for v in (str(f.relative_to(p)).encode(),f.read_bytes()):h.update(len(v).to_bytes(8,'big'));h.update(v)
 return h.hexdigest()
def hub_record(meta, frozen=()):
 path=Path(meta['hub_owner_file']);saved={r['path']:r for r in frozen}.get(str(path))
 if path.exists():
  before=sha(path);raw=path.read_bytes();need(sha(path)==before==hashlib.sha256(raw).hexdigest(),'stable Hub bytes')
  if saved is not None:need(before==saved['sha256'],'old Hub record replaced')
 else:
  need(not path.is_symlink() and saved is not None,'missing Hub without frozen evidence')
  raw=base64.b64decode(saved['raw_b64'],validate=True);need(hashlib.sha256(raw).hexdigest()==saved['sha256'],'frozen Hub bytes')
 owner=dict(x.split('=',1)for x in raw.decode().splitlines()if '='in x)
 need(owner['owner_token']==meta['hub_owner_token'] and owner['pid']==meta['hub_pid'] and owner['pid_start']==meta['hub_pid_start'] and owner['argv_sha256']==meta['hub_argv_sha256'],'frozen Hub identity')
 absent(int(meta['hub_pid']))
 return {'path':str(path),'sha256':hashlib.sha256(raw).hexdigest(),'raw_b64':base64.b64encode(raw).decode(),'meta':meta}

def zero_allocation(root, smoke, audit, frozen=()):
 """Resource-only launch debt closure; retain every Hub/financial/archive obligation."""
 need(audit.get('positive_execution_credit')is False and len(audit.get('rows',[]))==16,'exact no-allocation report')
 runs=Path(smoke['fleet_directory']).parents[1]/'runs'
 need(runs.parent.name==hashlib.sha256(ANCHORS['smoke'][0].encode()).hexdigest(),'native root token')
 participants={f for f in runs.iterdir()if f.is_dir()and f.name!='_hub'}
 need(len(participants)==16 and {f.name for f in participants}=={r['run']for r in audit['rows']},'all16 original participants')
 common=Path(root)/'.git';need(common.is_dir()and not common.is_symlink(),'canonical Git common directory')
 retained=[]
 for row in audit['rows']:
  f=runs/row['run'];life=doc(f/'_batch/lifecycle.json');owner=life['fleet_owner_token'];need(owner==row['owner'],'fleet owner')
  absent(int(f.name.rsplit('-',1)[1]));local=f/'teardown-ownership';canonical=common/'cloudbench-fleet-audits'/owner
  seal=tree(local);need(tree(canonical)==seal==life['audit_sha256'],'mirrored native audit seal')
  need(fields(local/'source-audit')=={'path':str(canonical),'sha256':seal},'audit binding')
  meta=fields(canonical/'meta');need(meta==row['meta'] and sha(canonical/'meta')==row['meta_sha256'],'meta identity')
  need(meta['status']=='provider-teardown-verified' and meta['run_id']==f.name and meta['workspace_root']==str(root) and meta['fleet_owner_token']==owner,'native release identity')
  registry=common/'cloudbench-fleet-ownership'/owner;need(not registry.exists()and not registry.is_symlink(),'registry retained')
  for name in ('expected-fresh','fresh','by-machine-id','pool','pool-handoffs','volume-migrations'):
   for base in (local,canonical):
    p=base/name;need(not p.is_symlink()and(not p.exists()or p.is_dir()and not any(p.iterdir())),'allocation/intent remains')
  for name in ('owned-clones.ids','owned-clones.names'):
   need((local/name).read_bytes()==(canonical/name).read_bytes()==b'','resource IDs remain')
  need((canonical/'provider-teardown-verified.epoch').is_file(),'release stamp missing')
  hub=Path(meta['hub_owner_file']);need(hub.parent==runs/'_hub' and meta['hub_disposition']=='retained-exact-owner-transfer-required','Hub obligation')
  retained.append(hub_record(meta,frozen))
 return retained

def negative_row(gate, request, folder, process, now, c):
 result=doc(folder/'result.json')
 # Exercise native validation but never convert its returned case outcomes into PASS.
 try:
  cases,complete=c.validate_result(result,request,process['native_exit'],invalid_process=False)
  validation={'accepted':True,'cases':cases,'complete':complete}
 except (KeyError,TypeError,ValueError)as error:
  # The actual smoke result intentionally fails ordinary validation. Preserve
  # that exact error, never require valid execution to record negative custody.
  validation={'accepted':False,'error_type':type(error).__name__,'error':str(error)}
 return {'kind':KIND,'gate':gate['name'],'token':request['token'],'source':request['source'],
  'status':'FAIL','cases':{**dict.fromkeys(request['checks'],'UNVERIFIED'),**dict.fromkeys(request['skips'],'SKIP')},
  'case_complete':dict.fromkeys(gate['checks'],False),'complete':False,'executed':'UNKNOWN',
  'native_exit':'UNKNOWN','native_child_exit':process['native_exit'],'timed_out':'UNKNOWN','cancelled':'UNKNOWN',
  'lingering_group':False,'cleanup_complete':False,'positive_credit':False,
  'reason':'Original outer receipt absent; bounded negative observation only',
  'command':gate['command'],'log':str(folder/'output.log'),'worker_result':str(folder/'result.json'),
  'recovered_at':now,'native_validation':validation,'original_receipt_absent':True,'retained_cleanup_debt':True}

def selected_gates(state, directory, c):
 selected=dict(state['focused'])
 prerequisite=c.cloud_smoke_prerequisite(state['plan'],state,list(selected.values()))
 if prerequisite is not None:selected.setdefault(prerequisite['name'],prerequisite)
 folders=Path(directory)/'attempts/10/focused'
 requests={p.parent.name for p in folders.glob('*/request.json')}
 need(requests==set(selected) and len(requests)==7,'all seven original requests including automatic prerequisite')
 return selected

def prepare(state, directory, root, spec, c):
 directory=Path(directory).resolve(strict=True);root=Path(root).resolve(strict=True)
 need(spec.get('approved')is True and spec.get('kind')==KIND and spec.get('positive_credit')is False,'typed reviewed authority')
 need(0<=time.time()-spec['reviewed_at']<=120 and 0<spec['deadline']-time.time()<=180,'bounded authority')
 need(state.get('phase')=='focused' and state.get('round')==10 and state.get('ready')is False and 'live_failures'in state and not state.get('running'),'exact original focused boundary')
 need(state['source']['head']==SOURCE and c.source(root)==spec['operator_source'],'source identity')
 need(sha(directory/'cycle.json')==spec['before_state_sha256'] and spec['source']==state['source'],'exact state/source')
 need(spec['repository']==str(root) and spec['coordinator_pid']==300545,'original coordinator/root');absent(spec['coordinator_pid'])
 need(sha(__file__)==spec['observer_sha256'],'reviewed recovery observer')
 need(set(spec['processes'])==set(ANCHORS),'exact native proof map')
 need(sha(spec['original_inputs'])==spec['original_inputs_sha256'] and sha(spec['no_allocation'])==spec['no_allocation_sha256'],'additional proof bindings')
 need(c.digest(state['plan'])==state['plan_digest'] and state['environment']==c.environment_digest(),'plan/environment')
 # Current operator may add only the reviewed recovery observer; original inputs are pinned separately.
 need(set(spec['operator_files'])=={'scripts/deploy_test_cycle.py','scripts/deploy_test_result.py','scripts/deploy_test_process.py'},'operator dependency closure')
 for p,h in spec['operator_files'].items():need(sha(root/p)==h,'operator pin')
 baseline=doc(spec['original_inputs']);need(baseline['source_original']==state['source'] and baseline['positive_credit']is False,'original inventory')
 seals=baseline['original_files'];verify_seals(seals)
 need(seals[str(directory/'cycle.json')]['sha256']==spec['before_state_sha256'],'original state seal')
 result_rows=[];candidate=copy.deepcopy(state);now=time.time();selected=selected_gates(state,directory,c);missing=set()
 for name,gate in selected.items():
  folder=directory/'attempts/10/focused'/name;request=doc(folder/'request.json')
  need(request['source']==state['source'] and request['gate']==name,'request identity')
  if (folder/'receipt.json').exists():
   row=doc(folder/'receipt.json');need(all(row.get(k)==request[k]for k in ('token','source','gate')),'sibling receipt identity')
  else:
   need(name in ANCHORS and not(folder/'receipt.json').is_symlink(),'unknown missing original')
   token,rsha,vsha=ANCHORS[name];need(request['token']==token and sha(folder/'request.json')==rsha and sha(folder/'result.json')==vsha,'exact original anchor')
   need(not any(r.get('token')==token for a in state['attempts']for r in a.get('results',[])),'already settled original')
   p=Path(spec['processes'][name]);need(str(p)in seals,'original native proof sealed');process=doc(p);terminal(process)
   if name=='smoke':need(p==Path(doc(folder/'result.json')['runner_log']+'.process.json'),'exact nested native CLI proof')
   else:need(p==folder/'output.log.process.json','exact native launcher proof')
   row=negative_row(gate,request,folder,process,now,c);missing.add(name)
  result_rows.append(row)
 need(missing==set(ANCHORS),'exact two missing originals')
 retained=zero_allocation(root,doc(directory/'attempts/10/focused/smoke/result.json'),doc(spec['no_allocation']))
 # Keep original already-recorded early occurrences; add failures only for missing observations.
 failures=candidate.pop('live_failures')
 for row in result_rows:
  if row.get('kind')==KIND:failures.extend(c.failed_cases(candidate,[row]))
 c.advance(candidate,result_rows,failures)
 need(candidate['phase']=='triage' and candidate['ready']is False and not 'live_failures'in candidate,'negative triage only')
 candidate['attempts'][-1]['negative_settlement']=KIND
 candidate['focused10_negative_settlement']={'kind':KIND,'positive_credit':False,'missing_receipts_retained':True,'retained_services':retained}
 need(time.time()<spec['deadline'],'authority expired during verification')
 return {'kind':KIND,'round':10,'positive_credit':False,'before_state_sha256':spec['before_state_sha256'],
  'source':state['source'],'operator_source':spec['operator_source'],'operator_files':spec['operator_files'],
  'spec':copy.deepcopy(spec),'seals':seals,'original_plan':state['plan'],'after_state':candidate}

def sync(path):
 fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:os.fsync(fd)
 finally:os.close(fd)

def pending_guard(directory,action):
 directory=Path(directory)
 if (directory/JOURNAL).exists() and not(directory/COMMITTED).exists():
  need(action in ('settle-focused10','status','report'),'resume exact pending focused10 journal before normal actions')

def committed(directory):
 directory=Path(directory);journal=doc(directory/JOURNAL);marker=doc(directory/COMMITTED)
 need(set(marker) in ({'journal_sha256'},{'journal_sha256','continuation_sha256','continuation_path'}) and marker['journal_sha256']==sha(directory/JOURNAL) and journal['kind']==KIND and journal['positive_credit']is False,'committed negative certificate')
 if 'continuation_sha256'in marker:
  file=Path(marker['continuation_path']);need(file.parent==directory,'continuation directory');need(sha(file)==marker['continuation_sha256'],'continuation seal')
  continuation=doc(file);authority=continuation['authority']
  need(file.name=='focused10-negative-continuation-'+digest(authority)+'.json','exact continuation path')
  need(continuation['journal_sha256']==marker['journal_sha256'] and authority.get('approved')is True
       and authority['resume_journal_sha256']==marker['journal_sha256']
       and digest(authority_identity(authority))==journal['authority_identity_sha256']
       and authority['reviewed_at']<=continuation['validated_at']<authority['deadline']<=continuation['validated_at']+180,'reviewed bounded continuation')
 need(digest(journal['proposal'])==journal['proposal_sha256'],'proposal seal');return journal['proposal']

def validate_committed(state, directory):
 p=committed(directory);need(p['kind']==KIND and p['round']==10 and p['source']['head']==SOURCE,'certificate scope')
 verify_seals(p['seals'],{str(Path(directory)/'cycle.json'),str(Path(directory)/'plan.json')},p['after_state']['focused10_negative_settlement']['retained_services'])
 need(state.get('focused10_negative_settlement')==p['after_state']['focused10_negative_settlement'],'retained debt changed')
 for old in p['after_state']['attempts'][-1]['results']:
  rows=[r for a in state['attempts']for r in a.get('results',[])if r.get('token')==old.get('token')]
  need(len(rows)==1 and rows[0]==old,'original observation changed')
 for name,(token,rsha,vsha)in ANCHORS.items():
  folder=Path(directory)/'attempts/10/focused'/name;need(not(folder/'receipt.json').exists()and not(folder/'receipt.json').is_symlink(),'original receipt fabricated')
  need(sha(folder/'request.json')==rsha and sha(folder/'result.json')==vsha,'original hard anchor')
  row,=[r for r in p['after_state']['attempts'][-1]['results']if r.get('gate')==name]
  request=doc(folder/'request.json')
  need(row.get('kind')==KIND and row.get('token')==token and row.get('source')==request['source']
       and row.get('status')=='FAIL' and row.get('complete')is False and row.get('positive_credit')is False
       and row.get('executed')==row.get('native_exit')==row.get('timed_out')==row.get('cancelled')=='UNKNOWN'
       and row.get('cases')=={**dict.fromkeys(request['checks'],'UNVERIFIED'),**dict.fromkeys(request['skips'],'SKIP')}
       and not any(k in row for k in ('started_at','finished_at')),'negative-only exact observation')
 # Recheck physical custody on every future admission, never accept merely a true flag.
 root=Path(p['spec']['repository']);absent(300545)
 for file in p['spec']['processes'].values():terminal(doc(file))
 zero_allocation(root,doc(Path(directory)/'attempts/10/focused/smoke/result.json'),doc(p['spec']['no_allocation']),p['after_state']['focused10_negative_settlement']['retained_services'])
 return p

def recognized(state,directory,gate,request):
 request=Path(request);directory=Path(directory)
 if request not in {directory/'attempts/10/focused'/n/'request.json'for n in ANCHORS}:return False
 if not(directory/JOURNAL).exists()and not(directory/COMMITTED).exists():return False
 p=validate_committed(state,directory);old=next(g for g in p['original_plan']['gates']if g['name']==gate['name'])
 need(all(gate.get(k)==old.get(k)for k in ('worker_root','cwd','worker_transport','result_transport')),'admission root changed')
 return True

def observation_owner(receipt):
 need(receipt.get('kind')==KIND and receipt.get('gate')in ANCHORS,'typed negative owner')
 directory=Path(receipt['log']).parents[4]
 state=doc(directory/'cycle.json');validate_committed(state,directory)
 rows=[r for a in state['attempts']for r in a.get('results',[])if r.get('token')==receipt['token']]
 need(rows==[receipt],'exact negative observation')
 # Launch ownership only is retired by sealed zero-allocation/native-physical proof.
 # Original adapter cleanup_complete=false and Hub/archive/financial debts remain untouched.
 return None

def authority_identity(spec):
 return {k:v for k,v in spec.items()if k not in ('approved','reviewed_at','deadline','resume_journal_sha256')}

def settle(state,directory,root,spec,c,persist):
 """Caller holds the canonical cycle lock. No native launches or receipt fabrication."""
 directory=Path(directory);jp=directory/JOURNAL;mp=directory/COMMITTED
 if jp.exists():
  j=doc(jp)
  if j.get('spec_sha256')!=digest(spec):
   need(spec.get('approved')is True and spec.get('resume_journal_sha256')==sha(jp)
        and digest(authority_identity(spec))==j.get('authority_identity_sha256')
        and 0<=time.time()-spec['reviewed_at']<=120 and 0<spec['deadline']-time.time()<=180,
        'fresh exact reviewed journal continuation required')
  p=j['proposal']
  need(digest(p)==j['proposal_sha256'],'journal proposal changed')
  need(digest(state)in (j['before_state_digest'],digest(p['after_state'])),'journal state changed')
  verify_seals(p['seals'],{str(directory/'cycle.json')},p['after_state']['focused10_negative_settlement']['retained_services']);absent(300545)
  need(c.source(root)==spec['operator_source'] and c.environment_digest()==p['after_state']['environment'],'resume current source/environment')
  need(sha(__file__)==spec['observer_sha256'],'resume observer pin')
  for path,expected in spec['operator_files'].items():need(sha(Path(root)/path)==expected,'resume operator pin')
  for path in spec['processes'].values():terminal(doc(path))
  zero_allocation(Path(root),doc(directory/'attempts/10/focused/smoke/result.json'),doc(spec['no_allocation']),p['after_state']['focused10_negative_settlement']['retained_services'])
 else:
  p=prepare(state,directory,root,spec,c)
  c.write(directory/'focused10-before-state.json',state)
  j={'kind':KIND,'positive_credit':False,'spec_sha256':digest(spec),'authority_identity_sha256':digest(authority_identity(spec)),'before_state_digest':digest(state),'proposal_sha256':digest(p),'proposal':p}
  c.write(jp,j);sync(directory)
 if mp.exists():need(doc(mp)=={'journal_sha256':sha(jp)},'commit changed');return
 need(time.time()<spec['deadline'],'settlement deadline expired')
 marker={'journal_sha256':sha(jp)}
 if spec.get('resume_journal_sha256') is not None:
  continuation=directory/('focused10-negative-continuation-'+digest(spec)+'.json')
  value={'journal_sha256':sha(jp),'authority':spec,'validated_at':time.time()}
  if continuation.exists():
   saved=doc(continuation);need(saved['authority']==spec and saved['journal_sha256']==sha(jp) and spec['reviewed_at']<=saved['validated_at']<spec['deadline'],'continuation changed')
  else:c.write(continuation,value);sync(directory)
  marker['continuation_sha256']=sha(continuation);marker['continuation_path']=str(continuation)
 persist(p['after_state']);sync(directory);c.write(mp,marker);sync(directory)
 state.clear();state.update(copy.deepcopy(p['after_state']))
