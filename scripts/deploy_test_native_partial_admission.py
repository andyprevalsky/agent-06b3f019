"""Cleanup-only replay of the independently witnessed partial zero-allocation campaign."""
import copy
import hashlib
import json
from datetime import datetime
from pathlib import Path
import re
import runpy
import subprocess

CAPTURE = {'source': {'head': 'bd64033af812958f8d89d58532f9686af5a356cb', 'digest': '365d0ff6777d91873eae1b3fba28713c1c37d2745242ceca212f562f271575b5'}, 'token': '7adad44c3f59458f8c2852e99c45f25d', 'request_sha256': 'b8a6aff4cd010add0b8d54881eb8faa255b30437cdb31c1dcd38cedbe7b98d3d', 'receipt_sha256': 'e722e6f5026bb4bc3bbd8f78779563ea6bdadfb9aed55869dcddef51531427ba', 'adapter_sha256': '4f01428a6edf61d512e58ce250a2e77c819cd78b9e73c4650dda4022cd90bf25', 'summary_sha256': '7df6ef53c43b68caac470b774cf63ff5337f87269edd75964c5f3de890264fe3', 'producers': {'scripts/run-bench-fleet': 'f6ec27e73d44727297a5132d14d1cc51f4fd65e701ea66b5b8f9294e54ab2b54', 'scripts/run-bench-campaign.py': 'b072369b83e0f2d66e70c1a5469c2ea2b63e851ffa437e0e20b21236e77432dd', 'scripts/deploy_test_cloud.py': '96badb95c00fd2a735a7ddeb7f1e5616eb336c389534ca85ae71264b1c808e29', 'scripts/cloudbench_execution_provenance.py': '25c3d3b7cd13370c86ce0a36d68660f005096a71be79a77bfbe1ef1390fb019f'}, 'native_runs': {'20261109-233109-2092700': {'sha256': '6bc67009fd7ab5a807013b2150ece163538116b46d482869ca9ad534171d3ec5', 'bytes': 1722}, '20261109-233109-2092701': {'sha256': '81055aaf729734f93f085cfb3793e3d1528fce00eea4a14fae78dd5416ec654a', 'bytes': 1708}, '20261109-233109-2092702': {'sha256': '729f2751bb5f5d1621e5d09de2bae0112bd86ee46be39a415cf310b2b0a9fbf0', 'bytes': 1715}, '20261109-233109-2092705': {'sha256': '0c63372859ecd9eb2c75b62266a09fe0c97cce1d7f5812d6f8a674765973715b', 'bytes': 1720}, '20261109-233109-2092708': {'sha256': 'b2b1df9fb3f905ba0d82aeec0e55d3421296785ca897de6f82c4843ed65aea93', 'bytes': 1731}, '20261109-233109-2092709': {'sha256': 'be655cd428444331ef083a1aadfd0b4428f87224f1701d7d7a7b47a31e2d743f', 'bytes': 1716}, '20261109-233109-2092711': {'sha256': 'f9b24ba8e730a13c90dcf74a0b7fb54a520613c0341b6d62261140fcae1a53b3', 'bytes': 1714}, '20261109-233109-2092717': {'sha256': '4a3dad99c57d87119c38a386d49229a763962338115a6b595024757afb245960', 'bytes': 1722}, '20261109-233109-2092720': {'sha256': 'b0e08a979290a1a9803ff7280057896fd51fb67cc6f655215791566f79540629', 'bytes': 1727}, '20261109-233109-2092726': {'sha256': '1790b5aa49bee946d038b92edb39ce5d9d885f5c570b2004f1f0be38af60ee4b', 'bytes': 1737}, '20261109-233109-2092734': {'sha256': 'efc0fc7dda3a78de672d932f6ba1ff252528312b17632b418dc361967ba4ac83', 'bytes': 1728}, '20261109-233109-2092737': {'sha256': 'ed4e7bb55515fe83d2264bd04fabcb01887bb24fb5158eaad8af2882619c71d1', 'bytes': 1729}, '20261109-233109-2092739': {'sha256': 'dfa94b4f5596a8e0617e306deb33468ccbd2fe24404d4fe1413602ffc59f1a26', 'bytes': 1734}, '20261109-233109-2092747': {'sha256': '649e3f7d9fc5defdcae2fd07c09789e40e186921b215f56f1d26615fe633309d', 'bytes': 1726}, '20261109-233109-2092752': {'sha256': 'f05fb44e6e95b18f9aadde97d8089bc9253150b1a136e7f6cc5075f1fa1d9898', 'bytes': 1728}}}
MARKER = 'cleanup reserve admission failed: [Errno 28] insufficient physical cleanup floors for pending controllers'
REFUSAL = '❌ could not allocate the emergency fleet teardown disk reserve; refusing provider mutation'



def require_unlaunched(job, index, campaign):
    from deploy_test_native_cleanup import need
    log=campaign/(job['job_id']+'.log')
    need(index in (16,17) and job['job_id']==f'r001-j{index:04d}'
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
         and summary['status'] == 'failed' and summary['concurrency'] == summary['peak_concurrency'] == 15
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
        if index > 15:
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
    need(len(parents)==15 and refusals==6 and cancellations==9
         and {p for p in runs.iterdir()if p.name!='_hub'}==parents,'partial exact participants')
    processes=subprocess.check_output(['ps','-ax','-o','pid=,pgid=,stat='],text=True)
    pids={j['controller_pid']for j in jobs[:15]}
    for line in processes.splitlines():
        row=line.split()
        if len(row)>=3 and not row[2].startswith('Z'):
            need(int(row[0])not in pids and int(row[1])not in pids,'partial controller group still live')
    for hub in sorted((runs/'_hub').glob('agent-link-server.*.owner')):
        h=fields(bound(hub))
        need(native['native_hub_owner_retired'](hub,runs,root),'partial additional Hub live/reused')
        hubs[str(hub)]={'path':str(hub),'sha256':hashlib.sha256(bound(hub)).hexdigest(),
                        'owner':h,'disposition':'native-owner-retired-current-absence'}
    need(len(hubs)==9,'partial exact shared Hub inventory')
    need(supervision['quiescent']is True,'partial supervisor incomplete')
    for name in ('hub-group.json','hub-group-publication-ack.private.json'):document(campaign/name)
    need(campaign_published(summary,campaign,adapter['started_at'],native),'partial publication closure')
    return {'kind':'native-cloud-cleanup-v1','gate':receipt['gate'],'token':receipt['token'],
            'owner':copy.deepcopy(owner),'worker_result_sha256':hashlib.sha256(Path(receipt['worker_result']).read_bytes()).hexdigest(),
            'proof':copy.deepcopy(proof),'participants':sorted(map(str,parents)),
            'native_audit_seals':seals,'retained_services':[hubs[k]for k in sorted(hubs)],
            'credit_granted':False,'financial_cleanup_credit':False,
            'partial_preexecution_zero_allocation':True,'original_outcomes_preserved':True}
