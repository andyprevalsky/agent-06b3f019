"""Exact round19 execution exclusion; the unpatched canary remains a failure."""
import hashlib
import json
from pathlib import Path
import subprocess
import deploy_test_round12_isolation as shared
import deploy_test_round16_isolation as prior
from deploy_test_native_cleanup import fields, preallocation_binding
from cloudbench_execution_provenance import validate_provenance, validate_task_matrix_binding

ROOT = shared.ROOT
TOKEN = '2cfd040275864ff3b605eb35daf87f7c'
SOURCE = 'e23dcd094d6fbafa6dcc120a4f79c3acc6e57408'
MODE = 'round19-canary-source-isolation-v1'
RECEIPT = ROOT / '.context/cli-nov05-cycle/attempts/19/needs-focused-plan/smoke/receipt.json'
PINS = json.loads(Path(__file__).with_name('fixtures').joinpath('round19-isolation-pins.json').read_text())
CHILD = '20261105-095858-385335'
ABORT = '20261105-100909-658441'
RESOURCES = {'8744402f1e1d98': 'vol_re1lgj5d5qwmpqd4', '8e403dc7ee3018': 'vol_40o72n6eed6epw94'}
PARTITION = {**prior.RESOURCES, **RESOURCES}
check = shared.check


def pinned_files(proof):
    check(proof.get('files') == PINS, 'round19 exact evidence inventory')
    for name, digest in PINS.items():
        p = Path(name)
        check(p.is_file() and not p.is_symlink() and p.resolve() == p
              and hashlib.sha256(p.read_bytes()).hexdigest() == digest, 'round19 original bytes changed')


def snapshot(proof):
    pinned_files(proof)
    def document(path):
        check(str(path) in PINS, 'round19 unpinned document')
        return json.loads(path.read_text())
    def bound(path):
        check(str(path) in PINS, 'round19 unpinned evidence')
        return path.read_bytes()
    receipt = document(RECEIPT); request = document(RECEIPT.parent/'request.json')
    adapter = document(RECEIPT.parent/'result.json')
    root = ROOT/'.context/deploy-cloud'/hashlib.sha256(TOKEN.encode()).hexdigest()
    campaign = root/'campaigns'/('deploy-'+root.name)
    check(proof.get('campaign') == str(campaign), 'round19 campaign scope')
    check(adapter == document(root/'result.json')
          and all(adapter[k] == receipt[k] == request[k] for k in ('token','source','gate'))
          and receipt['worker_result'] == str(RECEIPT.parent/'result.json')
          and receipt['native_cleanup_reference']['result_sha256'] == PINS[receipt['worker_result']]
          and receipt['native_cleanup_reference']['native_directory'] == str(campaign)
          and adapter['complete'] is False and adapter['cleanup_complete'] is False, 'round19 original authority')
    seal = document(root/'source-transport.json')
    check(adapter['source_transport'] == seal and seal['token'] == TOKEN and seal['source'] == receipt['source']
          and seal['workspace_patch_sha256'] == hashlib.sha256(bound(root/'workspace.patch')).hexdigest(),
          'round19 intended source')
    summary = document(campaign/'summary.json'); jobs = summary['jobs']
    participants = sorted(p for p in (root/'runs').iterdir() if p.is_dir() and p.name != '_hub')
    check(len(jobs) == 10 and len(participants) == 12 and summary['status'] == 'failed'
          and {p.name.rsplit('-',1)[-1] for p in participants} == {str(j['controller_pid']) for j in jobs} | {'385335','658441'}
          and {j['task'] for j in jobs} == set(request['checks']) and not request['skips']
          and sum(j['status']=='failed' and j['controller_exit_code']==1 for j in jobs)==1
          and sum(j['status']=='cancelled' and j['controller_exit_code']==143 for j in jobs)==9, 'round19 participant closure')
    for child, job in ((CHILD,'r001-j0001.log'),(ABORT,'r001-j0003.log')):
        text = bound(campaign/job).decode()
        check(str(root/'runs'/child) in text and 'mode: --infra-probe (strict barrier, no LLM / run_benchmark)' in text,
              'round19 original canary link')
    for fleet in participants:
        life = document(fleet/'_batch/lifecycle.json'); owner = life['fleet_owner_token']
        check(life['run_id'] == fleet.name and life['workspace_root'] == str(ROOT)
              and life['status'] == 'failed' and life['controller_exit_code'] in (1,143), 'round19 original failures')
        check({str(p) for p in (fleet/'_batch').iterdir() if p.is_file()}
              == {p for p in PINS if Path(p).parent == fleet/'_batch'}, 'round19 batch closure')
        prov = fleet/'execution-provenance.json'; matrix = fleet/'execution-task-matrix.json'
        check(prov.exists() == matrix.exists() == (fleet.name != ABORT), 'round19 original provenance membership')
        check((fleet/'preallocation-abort.json').exists() == (fleet.name == ABORT), 'round19 retrospective abort')
        if fleet.name == ABORT:
            provenance, tasks = preallocation_binding(fleet, receipt, owner, ROOT, document, bound, 143, adapter)
        else:
            provenance, tasks = document(prov), document(matrix)
        # Keep the actual unpatched canary distinct from the requested parent.
        check(not validate_provenance(provenance) and not validate_task_matrix_binding(provenance,tasks)
              and provenance['base_sha'] == seal['base_sha']
              and provenance['workspace_patch_sha256'] == ('none' if fleet.name in {CHILD,ABORT} else seal['workspace_patch_sha256']),
              'round19 actual source mismatch must remain')
        check({b['name'] for b in document(fleet/'_batch/benches.json')} == {t['name'] for t in tasks['tasks']},
              'round19 task inventory')
        for audit in (fleet/'teardown-ownership', ROOT/'.git/cloudbench-fleet-audits'/owner):
            h=hashlib.sha256()
            for p in sorted(audit.rglob('*'),key=lambda p:str(p.relative_to(audit))):
                check(not p.is_symlink(),'round19 audit symlink')
                if p.is_file() and p.name!='source-audit':
                    for data in (str(p.relative_to(audit)).encode(),bound(p)):h.update(len(data).to_bytes(8,'big'));h.update(data)
            check(h.hexdigest()==life['audit_sha256'],'round19 paired audit seal')
            meta=fields(bound(audit/'meta'))
            check(meta['status']=='provider-teardown-verified' and meta['fleet_owner_token']==owner
                  and meta['run_id']==fleet.name and meta['workspace_root']==str(ROOT),'round19 original custody')
            rows=[fields(bound(p)) for p in (audit/'fresh').glob('*') if p.is_file()]
            resources={r['machine_id']:r['volume_id'] for r in rows}
            check(resources==(RESOURCES if fleet.name==CHILD else {})
                  and all(r['disposition']=='destroyed-provider-retained' for r in rows)
                  and set(bound(audit/'owned-clones.ids').decode().split())==set(resources)
                  and set(bound(audit/'owned-clones.names').decode().split())=={r['clone_name'] for r in rows},'round19 exact resources')
            for name in ('pool','pool-handoffs','volume-migrations'):
                check(not (audit/name).exists() or not any((audit/name).iterdir()),'round19 other resource class')
        local=fleet/'teardown-ownership';canonical=ROOT/'.git/cloudbench-fleet-audits'/owner
        check(fields(bound(local/'source-audit'))=={'path':str(canonical),'sha256':life['audit_sha256']},'round19 source audit link')
        check(not (ROOT/'.git/cloudbench-fleet-ownership'/owner).exists(),'round19 retained registry')
        disposal=document(fleet/'_batch/disposable-cleanup.json')
        check(disposal['owner']==owner and disposal['guest_cleanup_missing'] is False
              and disposal['runtime_evidence_missing'] is False and disposal['successful_runtime_inferred'] is False,
              'round19 original disposal remains uncredited')
    debts=sorted((root/'runs/_hub').glob('*.owner'))
    check(len(debts)==7 and all(str(p) in PINS for p in debts),'round19 all seven Hub debts')
    return receipt,request,root,participants,debts,document(campaign/'shared-relay-location.json')['directory']


def observe_partition():
    return prior.observe_partition(resources=PARTITION,live_pid=374522,port=18768)


def partition_facts(value):
    return prior.partition_facts(value,resources=PARTITION,live_pid=374522,port=18768)


def operation_spec():
    return dict(token=TOKEN,source=SOURCE,mode=MODE,pins=PINS,receipt_path=RECEIPT,interrupted=False,
                snapshot=snapshot,inherited_count=5,live_pid=374522,adapter_sha=PINS[str(RECEIPT.parent/'result.json')],
                guest_observe=observe_partition,guest_facts=partition_facts,excluded_resources=PARTITION)


def validate(receipt,owner,proof):
    return shared.validate_execution(receipt,owner,proof,operation_spec())


def build(source):
    root=ROOT/'.context/deploy-cloud'/hashlib.sha256(TOKEN.encode()).hexdigest()
    seed={'files':PINS,'campaign':str(root/'campaigns'/('deploy-'+root.name))}
    op=operation_spec();op['snapshot']=lambda proof:snapshot({**seed,**proof})
    proof=shared.build_execution(source,op);proof.update(campaign=seed['campaign'],worker_result_sha256=op['adapter_sha'])
    return proof


def inherited_sources(state,entries):
    return prior.inherited_operation_sources(state,entries,__import__(__name__))
