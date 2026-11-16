"""Cleanup-only replay of the independently witnessed round38 partial zero-allocation campaign."""
import copy
import hashlib
import json
from datetime import datetime
from pathlib import Path
import re
import runpy
import subprocess

CAPTURE = {'source': {'head': '2390845cf087491b96e4d8ea83d16188f80f64bd', 'digest': '50294f07e9b4952dc3a9b4b8501c9ed05cc6a30f10ed68a820fe6b7769a82ebe'}, 'token': 'ad662412b121446cb0e17241c78bbd2b', 'request_sha256': 'cbdbb1f9d70b3a9f53cfcdd9b7dcefd4afdcba507b29ab172af2dccd48dc9a37', 'receipt_sha256': '0649ae751ee81af4847ac9238c5ef67ff8cbf1016893587b45ae87dc0d6e4f08', 'adapter_sha256': '35c0c8417ad11ed275212a90f719475d72a267e81f251a9ba81f09e3d8431e1e', 'summary_sha256': '80fc4ba14d566773f5dd4aee00d34a6433240a4e775fb86bb745b85eab04428f', 'producers': {'scripts/run-bench-fleet': 'e57c208ab78775d9b21dc4ac4bd64ac813621b5e27bf1ea870c2fbcfa67ef68b', 'scripts/run-bench-campaign.py': 'cf60fcee75fc673ea2d6ccee928009a67262fdd8e3c5e28f38a3724ac33f57ca', 'scripts/deploy_test_cloud.py': 'edc9fc221e3b04e897f492b725fb0cc237624adf8fe3db0279ca3b6746b16cee', 'scripts/cloudbench_execution_provenance.py': '25c3d3b7cd13370c86ce0a36d68660f005096a71be79a77bfbe1ef1390fb019f'}, 'native_runs': {'20261110-035121-1793297': {'sha256': '74615a3a62fb0fbf5e24d3473dc87ac1e5817c6265e512e23976998a5eb68f43', 'bytes': 1720}, '20261110-035120-1793298': {'sha256': '18daae3c532f403ae70c3f8803c1767e68b6e3a0df62811b65e6d83ce40a3657', 'bytes': 1710}, '20261110-035120-1793299': {'sha256': '05f6763fa961818aa76cd1379e54d2263fcd617f2cff7eb77bd3db4a3855d317', 'bytes': 1717}, '20261110-035120-1793300': {'sha256': 'd2214dbada5f65f857ec279232f98a2055ec6b33bf92fe0130d4d14995ca838f', 'bytes': 1720}, '20261110-035120-1793304': {'sha256': 'd85e6d71d18e5b41f857bdde2c6b74ea9f9abb8237af9af8adae18f97c1daee1', 'bytes': 1731}, '20261110-035120-1793307': {'sha256': '20ba4842b43d05269f72e01dd0cce01e992cb53e8feb90d6cb376f1dbf212d9f', 'bytes': 1718}, '20261110-035120-1793309': {'sha256': 'bb5e2e05d8dbeb42e04a58123daed1541e1d5f124181b611a47d6464ecdf90a2', 'bytes': 1714}, '20261110-035120-1793311': {'sha256': '2601d32fa79661963005d0bc245c802f23d37772755a921eb556f2efbb6478f2', 'bytes': 1724}}}
MARKER = 'cleanup reserve admission failed: [Errno 28] insufficient physical cleanup floors for pending controllers'
REFUSAL = '❌ could not allocate the emergency fleet teardown disk reserve; refusing provider mutation'



def require_unlaunched(job, index, campaign):
    from deploy_test_native_cleanup import need
    log=campaign/(job['job_id']+'.log')
    need(9 <= index <= 17 and job['job_id']==f'r001-j{index:04d}'
         and job['log']==str(log) and job['status']=='cancelled'
         and all(job.get(k)is None for k in
                 ('controller_pid','controller_exit_code','started_at','finished_at','wall_clock_seconds',
                  'run_id','fleet_dir','fleet_owner_token'))
         and not log.exists() and not log.is_symlink(),
         'partial unlaunched job acquired identity')

def validate_partial(receipt, owner, proof, adapter, root, runs, cli_text, bound, document, tree):
    from deploy_test_native_cleanup import need, fields, fleet_audit_root, fleet_ownership_root, preallocation_processes
    from deploy_test_native_admission import validate_parent
    from deploy_test_cloud import campaign_published
    need(set(proof)=={'kind','owner','request_token','source','receipt_sha256','worker_result_sha256',
                      'confirmed_at','observed_by','layout','campaign','files'}, 'partial proof contract fields')
    need(not any(proof.get(k) for k in ('purpose', 'controller_log', 'recovered_runtime', 'current_hub_retirement')),
         'partial admission cleanup only')
    folder = Path(receipt['log']).parent
    campaign = runs.parent / 'campaigns' / ('deploy-' + runs.parent.name)
    need(receipt['source'] == CAPTURE['source'] and receipt['token'] == CAPTURE['token']
         and proof.get('campaign') == str(campaign)
         and owner['native_cleanup_reference']['native_directory'] == str(campaign)
         and adapter.get('fleet_directory') == str(campaign) and str(campaign) in cli_text,
         'partial original capture identity')
    for name, path in [('request', folder/'request.json'), ('receipt', folder/'receipt.json'),
                       ('adapter', Path(receipt['worker_result'])), ('summary', campaign/'summary.json')]:
        need(hashlib.sha256(bound(path)).hexdigest() == CAPTURE[name+'_sha256'],
             'partial witnessed '+name+' changed')
    request = document(folder/'request.json')
    summary = document(campaign/'summary.json')
    checks, jobs = request['checks'], summary['jobs']
    need(len(checks) == len(set(checks)) == 17 and len(jobs) == 17
         and {j['task'] for j in jobs} == set(checks)
         and summary['campaign_id'] == campaign.name and summary['runs'] == 1
         and summary['retry_infra'] == 0 and summary['task_count'] == summary['total_jobs'] == 17
         and summary['status'] == 'failed' and summary['concurrency'] == summary['peak_concurrency'] == 8
         and not any(summary.get(k) for k in ('startup_cohorts','cleanup_ticket_failure','shared_inventory_failed',
                                             'shared_transport_cleanup_pending','e2e_timeout_exceeded')),
         'partial campaign inventory')
    need(adapter['cases'] == dict.fromkeys(checks,'UNVERIFIED') and adapter['complete'] is False
         and adapter['cleanup_complete'] is False and adapter['native_exit'] == 1
         and receipt['cases'] == dict(adapter['cases'], **dict.fromkeys(request['skips'],'SKIP'))
         and receipt['status'] == 'FAIL' and receipt['executed'] is True,
         'partial original failed outcomes')
    need(set(request['skips']) == {'agent-payment-abandonment'}
         and request['skips']['agent-payment-abandonment']['disposition'] == 'NO_RETRY_CUSTODY',
         'partial original no-retry inventory')
    # Fixed immutable producers establish the refusal before execution provenance or provider allocation.
    for relative, digest in CAPTURE['producers'].items():
        need(hashlib.sha256(bound(root/relative,historical_head=CAPTURE['source']['head'])).hexdigest()==digest,
             'partial producer changed')
    supervision = preallocation_processes(root,runs,campaign,request,receipt,adapter,document,bound)
    relay_location=Path(document(campaign/'shared-relay-location.json')['directory'])
    for leases in (campaign/'shared-relay'/'leases', relay_location/'leases'):
        need(not leases.is_symlink() and (not leases.exists() or leases.is_dir() and not any(leases.iterdir())),
             'partial relay consumers remain')

    native = runpy.run_path(str(root/'scripts/run-bench-campaign.py'))
    start, finish = (datetime.fromisoformat(summary[k]).timestamp() for k in ('started_at','finished_at'))
    need(adapter['started_at'] <= start <= finish <= receipt['finished_at'] <= proof['confirmed_at'],
         'partial campaign clocks')
    parents, hubs, seals, refusals, cancellations = set(), {}, {}, 0, 0
    raw_total = 0
    for index, job in enumerate(jobs,1):
        need(job['job_id']==f'r001-j{index:04d}' and job['run']==job['attempt']==1 and job['attempts']==[],
             'partial job identity')
        log=campaign/(job['job_id']+'.log')
        need(job['log']==str(log),'partial job log path')
        if index > 8:
            require_unlaunched(job,index,campaign)
            continue
        pid=job['controller_pid']
        need(type(pid)is int and pid>1 and type(job['controller_exit_code'])is int
             and job['controller_exit_code'] in (1,143),'partial launched process identity')
        fleet=Path(job['fleet_dir']);parents.add(fleet)
        need(fleet.parent==runs and fleet.name.rsplit('-',1)[-1]==str(pid)
             and job['run_id']==fleet.name and not Path('/proc',str(pid)).exists(),
             'partial original parent process')
        lines=bound(log).decode().splitlines()
        handle=str(root/'scripts/run-bench')+' monitor '+str(fleet)
        need(sum(line.strip()==handle for line in lines)==1,'partial native monitor handle')
        if job['controller_exit_code']==1:
            need(lines.count(MARKER)==lines.count(REFUSAL)==1 and lines.index(MARKER)<lines.index(REFUSAL),
                 'partial positive native reserve refusal')
            refusals+=1
        else:
            need(job['status']=='cancelled' and sum(re.fullmatch(r'⚰️  controller received TERM \([0-9]{2}:[0-9]{2}:[0-9]{2}\)',line)is not None for line in lines)==1,
                 'partial positive sibling cancellation')
            cancellations+=1
        need(all(not(fleet/name).exists() and not(fleet/name).is_symlink()
                 for name in ('execution-provenance.json','execution-task-matrix.json')),
             'partial execution artifacts present')
        life=document(fleet/'_batch/lifecycle.json')
        need(life.get('cleanup_verified')is False and life['controller_exit_code']==job['controller_exit_code']
             and life['fleet_owner_token']==job['fleet_owner_token'],'partial original lifecycle')
        benches=json.loads(bound(fleet/'_batch/benches.json'))
        run_path=fleet/'_batch/run.json';pin=CAPTURE['native_runs'].get(fleet.name)
        need(pin is not None and run_path.stat().st_size==pin['bytes'],'partial original run size')
        raw_total+=pin['bytes']
        need(raw_total<=128*1024*1024,'partial aggregate raw admission bound exceeded')
        raw=bound(run_path,limit=pin['bytes'])
        need(hashlib.sha256(raw).hexdigest()==pin['sha256'],'partial original run bytes')
        run=json.loads(raw)
        need({b['name']for b in benches}=={job['task']},'partial parent check')
        validate_parent(fleet,life,benches,run,root,bound,document,tree, canonical_audit=fleet_audit_root(root)/life['fleet_owner_token'])
        audit=fleet/'teardown-ownership';meta=fields(bound(audit/'meta'));seal=tree(audit)
        need(tree(fleet_audit_root(root)/life['fleet_owner_token'])==seal,'partial canonical seal')
        registry=fleet_ownership_root(root)/life['fleet_owner_token']
        need(not registry.exists() and not registry.is_symlink(),'partial native owner remains')
        disposable=document(fleet/'_batch/disposable-cleanup.json')
        need(disposable.get('schema')=='disposable-cleanup-v1' and disposable.get('owner')==life['fleet_owner_token']
             and disposable.get('guest_cleanup_missing')is False and disposable.get('runtime_evidence_missing')is False,
             'partial disposable closure')
        release=float(bound(audit/'provider-teardown-verified.epoch'))
        need(start<=release<=proof['confirmed_at'],'partial release clock')
        need(meta['hub_disposition']=='retained-exact-owner-transfer-required','partial hub disposition')
        hub=Path(meta['hub_owner_file']);h=fields(bound(hub))
        need(hub.parent==runs/'_hub' and h['owner_token']==meta['hub_owner_token']
             and all(h[k]==meta['hub_'+k] for k in ('pid','pid_start','argv_sha256'))
             and native['native_hub_owner_retired'](hub,runs,root),
             'partial current Hub live/reused or mismatched')
        terminal=hub.with_suffix(hub.suffix+'.terminal')
        need(terminal.is_file(),'partial native Hub terminal receipt missing')
        t=fields(bound(terminal))
        need(t==dict(version='1',owner_file=str(hub),owner_sha256=hashlib.sha256(bound(hub)).hexdigest(),
                     pid=h['pid'],pid_start=h['pid_start'],pgid=h['pgid'],owner_token=h['owner_token'],
                     disposition='terminated-verified',terminated_at=t.get('terminated_at'))
             and start<=datetime.fromisoformat(t['terminated_at']).timestamp()<=finish,
             'partial native Hub terminal binding')
        hubs[str(hub)]={'path':str(hub),'sha256':hashlib.sha256(bound(hub)).hexdigest(),
                        'owner':h,'disposition':'native-terminated-verified'}
        seals[str(audit)]=seal
    need(len(parents)==8 and refusals==1 and cancellations==7
         and {p for p in runs.iterdir()if p.name!='_hub'}==parents,'partial exact participants')
    processes=subprocess.check_output(['ps','-ax','-o','pid=,pgid=,stat='],text=True)
    pids={j['controller_pid']for j in jobs[:8]}
    for line in processes.splitlines():
        row=line.split()
        if len(row)>=3 and not row[2].startswith('Z'):
            need(int(row[0])not in pids and int(row[1])not in pids,'partial controller group still live')
    for hub in sorted((runs/'_hub').glob('agent-link-server.*.owner')):
        h=fields(bound(hub))
        need(native['native_hub_owner_retired'](hub,runs,root),'partial additional Hub live/reused')
        hubs[str(hub)]={'path':str(hub),'sha256':hashlib.sha256(bound(hub)).hexdigest(),
                        'owner':h,'disposition':'native-owner-retired-current-absence'}
    need(len(hubs)==5,'partial exact shared Hub inventory')
    need(supervision['quiescent']is True,'partial supervisor incomplete')
    for name in ('hub-group.json','hub-group-publication-ack.private.json'):document(campaign/name)
    need(campaign_published(summary,campaign,adapter['started_at'],native),'partial publication closure')
    return {'kind':'native-cloud-cleanup-v1','gate':receipt['gate'],'token':receipt['token'],
            'owner':copy.deepcopy(owner),'worker_result_sha256':hashlib.sha256(Path(receipt['worker_result']).read_bytes()).hexdigest(),
            'proof':copy.deepcopy(proof),'participants':sorted(map(str,parents)),
            'native_audit_seals':seals,'retained_services':[hubs[k]for k in sorted(hubs)],
            'credit_granted':False,'financial_cleanup_credit':False,
            'partial_preexecution_zero_allocation':True,'original_outcomes_preserved':True}
