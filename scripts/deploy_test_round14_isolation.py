"""Exact round-14 investigator admission; source intent never becomes task proof."""
import hashlib
import json
from pathlib import Path
import subprocess
import deploy_test_round12_isolation as shared

ROOT = shared.ROOT
TOKEN = '3a856e5e24a84f6197c46ca0bfa18f9b'
SOURCE = '9dccd611b2d067139a4a379ecc2f5fc46006265d'
MODE = 'round14-warm-stop-isolation-v1'
RECEIPT = ROOT / '.context/cli-nov05-cycle/attempts/14/needs-focused-plan/smoke/receipt.json'
PINS = json.loads(Path(__file__).with_name('fixtures').joinpath('round14-isolation-pins.json').read_text())
check = shared.check


def snapshot(proof):
    check(proof.get('files') == PINS, 'round14 exact original inventory required')
    for name, digest in PINS.items():
        path = Path(name)
        check(path.is_file() and not path.is_symlink() and path.resolve() == path
              and hashlib.sha256(path.read_bytes()).hexdigest() == digest, 'round14 original evidence changed')
    receipt = json.loads(RECEIPT.read_text()); folder = RECEIPT.parent
    request = json.loads((folder / 'request.json').read_text())
    adapter = json.loads((folder / 'result.json').read_text())
    root = ROOT / '.context/deploy-cloud' / hashlib.sha256(TOKEN.encode()).hexdigest()
    campaign = root / 'campaigns' / ('deploy-' + root.name)
    check(adapter == json.loads((root / 'result.json').read_text())
          and all(adapter[k] == receipt[k] == request[k] for k in ('source', 'token', 'gate'))
          and receipt['worker_result'] == str(folder / 'result.json')
          and receipt['native_cleanup_reference']['result_sha256'] == PINS[str(folder / 'result.json')]
          and receipt['native_cleanup_reference']['native_directory'] == str(campaign)
          and receipt['native_cleanup_reference']['cleanup_complete'] is False
          and adapter['complete'] is False and adapter['cleanup_complete'] is False
          and adapter['preallocation_evidence'] == {}, 'round14 original adapter/reference')
    seal = json.loads((root / 'source-transport.json').read_text())
    check(adapter['source_transport'] == seal and seal['token'] == TOKEN and seal['source'] == receipt['source']
          and seal['workspace_patch_sha256'] == hashlib.sha256((root / 'workspace.patch').read_bytes()).hexdigest(),
          'round14 original intended source')
    summary = json.loads((campaign / 'summary.json').read_text())
    jobs = summary['jobs']
    participants = sorted(p for p in (root / 'runs').iterdir() if p.is_dir() and p.name != '_hub')
    check(len(jobs) == len(participants) == 10 and summary['status'] == 'failed'
          and {str(j['controller_pid']) for j in jobs} == {p.name.rsplit('-', 1)[-1] for p in participants}
          and {j['task'] for j in jobs} == set(request['checks']) and not request['skips']
          and sum(j['status'] == 'failed' and j['controller_exit_code'] == 1 for j in jobs) == 1
          and sum(j['status'] == 'cancelled' and j['controller_exit_code'] == 143 for j in jobs) == 9,
          'round14 terminal participant closure')
    producer = subprocess.check_output(['git', '-C', str(ROOT), 'show', SOURCE + ':scripts/cloudbench_preallocation.py'])
    for fleet in participants:
        life = json.loads((fleet / '_batch/lifecycle.json').read_text())
        intent = json.loads((fleet / 'preallocation-source.json').read_text())
        job = next(j for j in jobs if str(j['controller_pid']) == fleet.name.rsplit('-', 1)[-1])
        check(life['status'] == 'failed' and life['controller_exit_code'] == job['controller_exit_code']
              and intent['source'] == SOURCE and intent['owner'] == life['fleet_owner_token']
              and intent['run_id'] == life['run_id'] == fleet.name and intent['pid'] == job['controller_pid']
              and intent['producer_sha256'] == hashlib.sha256(producer).hexdigest()
              and intent['execution_provenance']['base_sha'] == seal['base_sha']
              and intent['execution_provenance']['workspace_patch_sha256'] == seal['workspace_patch_sha256'],
              'round14 preallocation intent binding')
        check(not any((fleet / f).exists() for f in ('execution-provenance.json', 'execution-task-matrix.json', 'preallocation-abort.json')),
              'round14 historical execution evidence added')
        check({str(p) for p in (fleet / '_batch').iterdir() if p.is_file()}
              == {p for p in PINS if Path(p).parent == fleet / '_batch'}, 'round14 batch closure')
        log = (campaign / (job['job_id'] + '.log')).read_text()
        check('waiting until stopped before fleet provisioning' in log
              and 'forking clones from complete snapshot:' not in log, 'round14 stop-before-provision trace')
        for audit in (fleet / 'teardown-ownership', ROOT / '.git/cloudbench-fleet-audits' / life['fleet_owner_token']):
            h = hashlib.sha256()
            for p in sorted(audit.rglob('*'), key=lambda p: str(p.relative_to(audit))):
                check(not p.is_symlink(), 'round14 unsafe audit')
                if p.is_file() and p.name != 'source-audit':
                    for value in (str(p.relative_to(audit)).encode(), p.read_bytes()):
                        h.update(len(value).to_bytes(8, 'big')); h.update(value)
            check(h.hexdigest() == life['audit_sha256'], 'round14 native audit digest')
            check((audit / 'owned-clones.ids').read_bytes() == (audit / 'owned-clones.names').read_bytes() == b'',
                  'round14 unexpected resource inventory')
            for name in ('fresh', 'pool', 'pool-handoffs', 'volume-migrations'):
                check(not (audit / name).exists() or not any((audit / name).iterdir()), 'round14 resource class not closed')
    debts = sorted((root / 'runs/_hub').glob('*.owner'))
    check(len(debts) == 2 and all(str(p) in PINS for p in debts), 'round14 both Hub debts required')
    relay = json.loads((campaign / 'shared-relay-location.json').read_text())['directory']
    return receipt, request, root, participants, debts, relay


def operation_spec():
    return dict(token=TOKEN, source=SOURCE, mode=MODE, pins=PINS, receipt_path=RECEIPT,
                interrupted=False, snapshot=snapshot, inherited_count=3, live_pid=372368,
                adapter_sha=PINS[str(RECEIPT.parent / 'result.json')])


def validate(receipt, owner, proof):
    root = ROOT / '.context/deploy-cloud' / hashlib.sha256(TOKEN.encode()).hexdigest()
    check(proof.get('campaign') == str(root / 'campaigns' / ('deploy-' + root.name)), 'round14 campaign scope')
    return shared.validate_execution(receipt, owner, proof, operation_spec())


def build(validation_source):
    proof = shared.build_execution(validation_source, operation_spec())
    proof['worker_result_sha256'] = PINS[str(RECEIPT.parent / 'result.json')]
    root = ROOT / '.context/deploy-cloud' / hashlib.sha256(TOKEN.encode()).hexdigest()
    proof['campaign'] = str(root / 'campaigns' / ('deploy-' + root.name))
    return proof


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--validation-source', required=True)
    args = parser.parse_args()
    print(json.dumps(build(json.loads(args.validation_source)), indent=2))
