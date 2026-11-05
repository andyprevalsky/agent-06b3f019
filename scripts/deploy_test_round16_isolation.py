"""Exact fc2 execution isolation, never historical cleanup or task credit."""
import hashlib
import json
import os
from pathlib import Path
import time
import subprocess
import urllib.error
import urllib.request
import deploy_test_round12_isolation as shared
from deploy_test_native_cleanup import fields
from cloudbench_execution_provenance import validate_provenance, validate_task_matrix_binding

ROOT = shared.ROOT
TOKEN = '04c89c38e75f4e1db40d7de6664e0824'
SOURCE = '3d4c6c5088b10c1da23622ed91ed22ee45482f8c'
MODE = 'round16-checkout-isolation-v1'
RECEIPT = ROOT / '.context/cli-nov05-cycle/attempts/16/needs-focused-plan/smoke/receipt.json'
PINS = json.loads(Path(__file__).with_name('fixtures').joinpath('round16-isolation-pins.json').read_text())
WARM = ROOT / '.context/cli-nov05-review/cloud-round16-resume-bound-warm.json'
CHILD = '20261105-080356-2833771'
RESOURCES = {'6837330b379318': 'vol_r1jd31kzyq59em0r', '683e590a634e48': 'vol_4y8l3yme7klen9jr'}
check = shared.check


def pinned_files(proof):
    check(proof.get('files') == PINS, 'round16 exact evidence inventory')
    for name, expected in PINS.items():
        p = Path(name)
        check(p.is_file() and not p.is_symlink() and p.resolve() == p
              and hashlib.sha256(p.read_bytes()).hexdigest() == expected, 'round16 original evidence changed')


def snapshot(proof):
    pinned_files(proof)
    receipt = json.loads(RECEIPT.read_text()); request = json.loads((RECEIPT.parent/'request.json').read_text())
    adapter = json.loads((RECEIPT.parent/'result.json').read_text())
    root = ROOT/'.context/deploy-cloud'/hashlib.sha256(TOKEN.encode()).hexdigest()
    campaign = root/'campaigns'/('deploy-'+root.name)
    check(proof.get('campaign') == str(campaign), 'round16 campaign scope')
    check(adapter == json.loads((root/'result.json').read_text())
          and all(adapter[k] == receipt[k] == request[k] for k in ('token','source','gate'))
          and receipt['worker_result'] == str(RECEIPT.parent/'result.json')
          and receipt['native_cleanup_reference']['result_sha256'] == PINS[receipt['worker_result']]
          and receipt['native_cleanup_reference']['native_directory'] == str(campaign)
          and adapter['complete'] is False and adapter['cleanup_complete'] is False, 'round16 original adapter')
    intent = json.loads((root/'source-transport.json').read_text())
    check(adapter['source_transport'] == intent and intent['source'] == receipt['source'] and intent['token'] == TOKEN
          and intent['workspace_patch_sha256'] == hashlib.sha256((root/'workspace.patch').read_bytes()).hexdigest(), 'round16 intended source')
    summary = json.loads((campaign/'summary.json').read_text());jobs=summary['jobs']
    participants=sorted(p for p in (root/'runs').iterdir() if p.is_dir() and p.name!='_hub')
    parents={str(j['controller_pid']) for j in jobs}
    check(len(jobs)==10 and len(participants)==11 and summary['status']=='failed'
          and {p.name.rsplit('-',1)[-1] for p in participants} == parents | {'2833771'}
          and {j['task'] for j in jobs}==set(request['checks']) and not request['skips']
          and sum(j['status']=='failed' and j['controller_exit_code']==1 for j in jobs)==1
          and sum(j['status']=='cancelled' and j['controller_exit_code']==143 for j in jobs)==9, 'round16 participant closure')
    parent_log=(campaign/'r001-j0010.log').read_text()
    check(str(root/'runs'/CHILD) in parent_log and 'mode: --infra-probe (strict barrier, no LLM / run_benchmark)' in parent_log,
          'round16 original canary link')
    producer_hash=hashlib.sha256(subprocess.check_output(['git','-C',str(ROOT),'show',SOURCE+':scripts/cloudbench_preallocation.py'])).hexdigest()
    for fleet in participants:
        life=json.loads((fleet/'_batch/lifecycle.json').read_text());owner=life['fleet_owner_token']
        check(life['run_id']==fleet.name and life['workspace_root']==str(ROOT) and life['status']=='failed'
              and life['controller_exit_code'] in (1,143), 'round16 native failure')
        check({str(p) for p in (fleet/'_batch').iterdir() if p.is_file()}
              == {p for p in PINS if Path(p).parent==fleet/'_batch'}, 'round16 batch closure')
        check(not (fleet/'preallocation-abort.json').exists(), 'round16 retrospective abort')
        intent_path=fleet/'preallocation-source.json'
        check(intent_path.exists()==(str(intent_path) in PINS), 'round16 retrospective intent')
        if intent_path.exists():
            pre=json.loads(intent_path.read_text())
            check(pre['source']==SOURCE and pre['owner']==owner and pre['run_id']==fleet.name
                  and pre['pid']==int(fleet.name.rsplit('-',1)[-1]) and pre['producer_sha256']==producer_hash,
                  'round16 preallocation producer binding')
        prov=fleet/'execution-provenance.json';matrix=fleet/'execution-task-matrix.json'
        expected_provenance=fleet.name in (CHILD,'20261105-073457-1788370')
        check(prov.exists()==matrix.exists()==expected_provenance, 'round16 original provenance membership')
        if expected_provenance:
            provenance=json.loads(prov.read_text());tasks=json.loads(matrix.read_text())
            check(not validate_provenance(provenance) and not validate_task_matrix_binding(provenance,tasks)
                  and provenance['base_sha']==intent['base_sha']
                  and provenance['workspace_patch_sha256']==('none' if fleet.name==CHILD else intent['workspace_patch_sha256']),
                  'round16 actual recorded source')
        for audit in (fleet/'teardown-ownership',ROOT/'.git/cloudbench-fleet-audits'/owner):
            digest=hashlib.sha256()
            for p in sorted(audit.rglob('*'),key=lambda p:str(p.relative_to(audit))):
                check(not p.is_symlink(),'round16 unsafe audit')
                if p.is_file() and p.name!='source-audit':
                    for b in (str(p.relative_to(audit)).encode(),p.read_bytes()):digest.update(len(b).to_bytes(8,'big'));digest.update(b)
            check(digest.hexdigest()==life['audit_sha256'],'round16 native audit seal')
            meta=fields((audit/'meta').read_bytes())
            check(meta['status']=='provider-teardown-verified' and meta['fleet_owner_token']==owner
                  and meta['run_id']==fleet.name and meta['workspace_root']==str(ROOT), 'round16 native custody')
            rows=[fields(p.read_bytes()) for p in (audit/'fresh').glob('*') if p.is_file()]
            resources={r['machine_id']:r['volume_id'] for r in rows}
            check(resources==(RESOURCES if fleet.name==CHILD else {})
                  and all(r['disposition']=='destroyed-provider-retained' for r in rows)
                  and set((audit/'owned-clones.ids').read_text().split())==set(resources), 'round16 resource closure')
            for name in ('pool','pool-handoffs','volume-migrations'):
                check(not (audit/name).exists() or not any((audit/name).iterdir()), 'round16 other resource class')
        check(not (ROOT/'.git/cloudbench-fleet-ownership'/owner).exists(),'round16 retained registry')
        disposal=json.loads((fleet/'_batch/disposable-cleanup.json').read_text())
        check(disposal['owner']==owner and disposal['guest_cleanup_missing'] is False
              and disposal['runtime_evidence_missing'] is False and disposal['successful_runtime_inferred'] is False,
              'round16 original disposal')
    debts=sorted((root/'runs/_hub').glob('*.owner'))
    check(len(debts)==3 and all(str(p) in PINS for p in debts),'round16 all three Hub debts')
    relay=json.loads((campaign/'shared-relay-location.json').read_text())['directory']
    return receipt,request,root,participants,debts,relay


def hub_socket(proc=Path('/proc')):
    pid, port = 1793380, 18767
    owned = {os.readlink(p)[8:-1] for p in (proc/str(pid)/'fd').iterdir()
             if os.readlink(p).startswith('socket:[')}
    listening = set()
    for name in ('tcp', 'tcp6'):
        for line in (proc/'net'/name).read_text().splitlines()[1:]:
            row=line.split()
            if int(row[1].rsplit(':',1)[1],16)==port and row[3]=='0A':listening.add(row[9])
    check(listening and listening <= owned, 'round16 Hub listening socket owner changed')
    return {'pid':pid,'port':port,'inodes':sorted(listening)}


def observe_partition():
    token=shared.fly_token();prefix='https://api.machines.dev/v1/apps/navi-whisper-lux-bench/'
    def get(path):
        try:
            with urllib.request.urlopen(urllib.request.Request(prefix+path,headers={'Authorization':'Bearer '+token}),timeout=25) as r:
                check(r.status==200,'round16 native read');return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code==404:return None
            raise
    expected=json.loads(WARM.read_text());before=get('machines/'+expected['id'])
    def match(m):
        check(m is not None and all(m.get(k)==expected[k] for k in ('id','instance_id','name','state'))
              and m['state']=='stopped'
              and hashlib.sha256(json.dumps(m['config'],sort_keys=True).encode()).hexdigest()==expected['config_sha256'],
              'round16 warm identity/state changed')
    match(before);resources={}
    for mid,vid in RESOURCES.items():
        machine=get('machines/'+mid);volume=get('volumes/'+vid)
        check(machine is None or machine.get('id')==mid and machine.get('state')=='destroyed','round16 old machine remains')
        check(volume is None or volume.get('id')==vid and volume.get('state') in {'pending_destroy','destroyed'}
              and volume.get('attached_machine_id') is None,'round16 old volume active')
        resources[mid]={'machine_absent_or_destroyed':True,'volume_absent_or_detached_terminal':True,'volume':vid}
    after=get('machines/'+expected['id']);match(after)
    return {'observed_at':time.time(),'warm':{k:expected[k] for k in ('id','instance_id','name','state','config_sha256')},'resources':resources,'hub_socket':hub_socket()}


def partition_facts(value):
    check(value.get('warm',{}).get('state')=='stopped' and set(value.get('resources',{}))==set(RESOURCES),'round16 positive partition required')
    socket=value.get('hub_socket',{})
    check(socket.get('pid')==1793380 and socket.get('port')==18767 and socket.get('inodes'), 'round16 Hub socket proof')
    for mid,vid in RESOURCES.items():
        check(value['resources'][mid]=={'machine_absent_or_destroyed':True,'volume_absent_or_detached_terminal':True,'volume':vid},'round16 resource observation')
    return {k:v for k,v in value.items() if k!='observed_at'}


def operation_spec():
    return dict(token=TOKEN,source=SOURCE,mode=MODE,pins=PINS,receipt_path=RECEIPT,interrupted=False,
                snapshot=snapshot,inherited_count=4,live_pid=1793380,adapter_sha=PINS[str(RECEIPT.parent/'result.json')],
                guest_observe=observe_partition,guest_facts=partition_facts,excluded_resources=RESOURCES)


def validate(receipt,owner,proof):return shared.validate_execution(receipt,owner,proof,operation_spec())


def build(source):
    root=ROOT/'.context/deploy-cloud'/hashlib.sha256(TOKEN.encode()).hexdigest()
    seed={'files':PINS,'campaign':str(root/'campaigns'/('deploy-'+root.name))}
    op=operation_spec();op['snapshot']=lambda proof:snapshot({**seed,**proof})
    proof=shared.build_execution(source,op);proof.update(campaign=seed['campaign'],worker_result_sha256=op['adapter_sha'])
    return proof


def inherited_sources(state, entries):
    """Current round16 partition can cover only its exact pinned ancestor graph.

    No entry is renewed or replaced. Original guest snapshots remain historical;
    every original byte/local owner is checked, and current guest authority comes
    exclusively from the fully validated latest round16 operation.
    """
    from deploy_test_cycle import receipt_owner, latest_receipts
    from deploy_test_native_cleanup import still_bound
    import deploy_test_round14_isolation as round14
    candidates = [e for e in entries if e.get('token') == TOKEN]
    if not candidates:
        return {}
    check(len(candidates) == 1, 'ambiguous latest partition')
    candidate = candidates[0]
    latest = latest_receipts(state).get(candidate['gate'])
    check(latest is not None and latest.get('token') == TOKEN
          and candidate['proof'].get('compatibility') == MODE
          and candidate['validation_source'] == state['source'] == state['plan']['source']
          and still_bound(candidate, latest, receipt_owner(candidate['gate'], latest)),
          'latest full partition/source changed')
    by_token = {e['token']: e for e in entries}
    links = candidate['proof']['inherited_admissions']
    check(len(by_token) == len(entries) == 5
          and len(links) == 4
          and {a['original_request_token'] for a in links} == set(by_token) - {TOKEN},
          'complete exact ancestor set required')
    receipts = {}
    for token, entry in by_token.items():
        rows = [r for a in state['attempts'] for r in a.get('results', [])
                if r.get('gate') == candidate['gate'] and r.get('token') == token]
        check(len(rows) == 1 and entry.get('gate') == candidate['gate']
              and entry.get('purpose') == 'isolated-validation'
              and entry.get('cleanup_complete') is False and entry.get('credit_granted') is False
              and entry.get('obligations_preserved') is True, 'ancestor debt identity')
        receipts[token] = rows[0]
    # Validate all edges against the immutable original requests. This rejects
    # foreign, omitted, duplicate, cyclic, source-swapped and substituted debts.
    for token, entry in by_token.items():
        mode = entry['proof'].get('compatibility')
        if mode not in {shared.MODE, round14.MODE, MODE}:
            check(still_bound(entry, receipts[token], receipt_owner(entry['gate'], receipts[token])),
                  'original legacy debt changed')
            continue
        request = json.loads(Path(entry['proof']['original_request']).read_text())
        ancestry = entry['proof']['inherited_admissions']
        check(request['isolated_validation'] == ancestry and request['token'] == token,
              'original ancestor request changed')
        check(len({a['original_request_token'] for a in ancestry}) == len(ancestry), 'duplicate ancestry')
        for link in ancestry:
            prior = by_token.get(link['original_request_token'])
            check(prior is not None and prior['token'] != token
                  and link == dict(original_receipt_sha256=prior['proof']['receipt_sha256'],
                      original_request_token=prior['token'], new_request_token=token,
                      source=receipts[token]['source'],
                      new_native_root=str(ROOT/'.context/deploy-cloud'/hashlib.sha256(token.encode()).hexdigest()),
                      excluded_resources=prior['excluded_resources'], credit_granted=False)
                  and receipts[prior['token']]['finished_at'] <= receipts[token]['started_at'],
                  'ancestor edge changed')
    covered = {}
    for module in (shared, round14):
        entry = by_token.get(module.TOKEN)
        check(entry is not None and entry['proof'].get('compatibility') == module.MODE, 'exact covered ancestor required')
        receipt = receipts[module.TOKEN]
        actual = shared.validate_execution(receipt, receipt_owner(entry['gate'], receipt),
                                           entry['proof'], module.operation_spec(), _covered_guest=True)
        check(actual == {k:v for k,v in entry.items() if k != 'occurrence'}, 'historical ancestor proof changed')
        covered[module.TOKEN] = candidate['validation_source']
    return covered


if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser();p.add_argument('--validation-source',required=True);a=p.parse_args()
    print(json.dumps(build(json.loads(a.validation_source)),indent=2))
