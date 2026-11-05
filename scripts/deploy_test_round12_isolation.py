"""Reviewed execution-only admission for one interrupted round-12 campaign.

Pinned native observations prove the original execution ended, not cleanup,
source execution, or task success. All historical obligations remain retained.
"""
import copy
import hashlib
import json
from pathlib import Path
import time
import os
import shlex
import urllib.request
import runpy
from deploy_test_startup_compat import observe
from deploy_test_f87_isolation import hub_identity

ROOT = Path('/home/boxes/rose')
TOKEN = '61ef8f173775453cab36fbc78c43e1b8'
SOURCE = '1bd8133c0f47c27012a06ec3a9b48065433ad94d'
MODE = 'round12-interrupted-isolation-v1'
PINS = json.loads(Path(__file__).with_name('fixtures').joinpath('round12-isolation-pins.json').read_text())
RECEIPT = ROOT / '.context/cli-nov05-cycle/attempts/12/needs-focused-plan/smoke/receipt.json'
GUEST = next(Path(p) for p in PINS if p.endswith('/round12-guest/receipt.json'))


def check(value, message):
    if not value:
        raise ValueError('round12 isolation: ' + message)


def snapshot(proof):
    """Every original byte is independently reviewed and bound, including all six debts."""
    check(proof.get('files') == PINS, 'exact original file inventory required')
    for name, digest in PINS.items():
        path = Path(name)
        check(path.is_file() and not path.is_symlink() and path.resolve() == path
              and hashlib.sha256(path.read_bytes()).hexdigest() == digest, 'original evidence changed: ' + name)
    receipt = json.loads(RECEIPT.read_text())
    folder = RECEIPT.parent
    request = json.loads((folder / 'request.json').read_text())
    root = ROOT / '.context/deploy-cloud' / hashlib.sha256(TOKEN.encode()).hexdigest()
    campaign = root / 'campaigns' / ('deploy-' + root.name)
    summary = json.loads((campaign / 'summary.json').read_text())
    participants = sorted(p for p in (root / 'runs').iterdir() if p.is_dir() and p.name != '_hub')
    check(len(participants) == 10 and len(summary['jobs']) == 10
          and {str(j['controller_pid']) for j in summary['jobs']} == {p.name.rsplit('-', 1)[-1] for p in participants}
          and all(j['status'] == 'cancelled' and j['controller_exit_code'] == 143 for j in summary['jobs']), 'participant closure')
    check({j['task'] for j in summary['jobs']} == set(request['checks']) and not request['skips'], 'original inventory')
    for p in participants:
        check(not any((p / n).exists() for n in ('execution-provenance.json', 'execution-task-matrix.json', 'preallocation-abort.json')),
              'historical execution evidence added')
        check({str(f) for f in (p / '_batch').iterdir() if f.is_file()}
              == {name for name in PINS if Path(name).parent == p / '_batch'}, 'batch evidence closure')
        life = json.loads((p / '_batch/lifecycle.json').read_text())
        check(life['controller_exit_code'] == 143 and life['status'] == 'failed', 'original failure changed')
        for tree in (p / 'teardown-ownership', ROOT / '.git/cloudbench-fleet-audits' / life['fleet_owner_token']):
            h = hashlib.sha256()
            for f in sorted(tree.rglob('*'), key=lambda f: str(f.relative_to(tree))):
                check(not f.is_symlink(), 'audit symlink')
                if f.is_file() and f.name != 'source-audit':
                    for b in (str(f.relative_to(tree)).encode(), f.read_bytes()):
                        h.update(len(b).to_bytes(8, 'big')); h.update(b)
            check(h.hexdigest() == life['audit_sha256'], 'native audit digest')
    check(not (root / 'result.json').exists() and not (folder / 'result.json').exists(), 'retrospective adapter added')
    debts = sorted((root / 'runs/_hub').glob('*.owner'))
    check(len(debts) == 6 and all(str(p) in PINS for p in debts), 'all six Hub debts required')
    guest = json.loads(GUEST.read_text())
    check(guest['identity_unchanged'] and guest['exec_status'] == 200 and guest['guest']['uid'] == 0
          and guest['before'] == guest['after'] and guest['before']['id'] == '683e47df5094d8'
          and guest['before']['instance_id'] == '01M6N4WFPT4NQBETPT18WV716W', 'guest native identity')
    wire = guest['wire'][1]
    native = json.loads((GUEST.parent / wire['file']).read_text())
    check(wire['method'] == 'POST' and wire['status'] == 200 and wire['path'].endswith('/683e47df5094d8/exec')
          and native['exit_code'] == 0 and not native.get('exit_signal')
          and json.loads(native['stdout']) == guest['guest'], 'native guest observation binding')
    g = guest['guest']
    check(g['refresh_scope_pids'] == [] and g['unreadable'] == [] and g['token_path_metadata']['exists'] is False
          and [(p['pid'], p['exe']) for p in g['processes']] == [(1, '/fly/init'), (632, '/.fly/hallpass'), (633, '/usr/bin/sleep')]
          and all(s['pids'] == [632] and s['state'] == '0A' and s['local'].endswith(':0016') for s in g['sockets']),
          'original warm execution not positively quiescent')
    relay = json.loads((campaign / 'shared-relay-location.json').read_text())['directory']
    return receipt, request, root, participants, debts, relay


def fly_token():
    """Use the existing native-audit credential convention without exporting it."""
    token = os.environ.get('FLY_API_TOKEN')
    if not token:
        loader = runpy.run_path(str(Path(__file__).with_name('cloudbench-native-release-audit.py')))
        token = loader['token_from_env_file'](ROOT / 'agents/.env')
    check(bool(token), 'read-only guest credentials unavailable')
    return token


def guest_observe():
    """Observe a stable native state; stopped machines use GET/GET, never exec."""
    token = fly_token()
    url = 'https://api.machines.dev/v1/apps/navi-whisper-lux-bench/machines/683e47df5094d8'
    def call(method, suffix='', body=None):
        request = urllib.request.Request(url + suffix, method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=25) as response:
            check(response.status == 200, 'guest native HTTP failure')
            return json.load(response)
    before = call('GET')
    original = json.loads((GUEST.parent / 'wire-00.private.json').read_text())
    check(before.get('config') == original.get('config'), 'original guest config changed; no exec')
    check(before.get('id') == '683e47df5094d8' and before.get('instance_id') == '01M6N4WFPT4NQBETPT18WV716W'
          and before.get('state') in {'started', 'stopped'}, 'original guest identity or stable state changed; no exec')
    guest = None
    if before['state'] == 'started':
        code = Path(__file__).with_name('fixtures').joinpath('round12-guest-observe.py').read_text()
        result = call('POST', '/exec', {'cmd': shlex.join(['python3', '-I', '-B', '-c', code]), 'timeout': 15, 'machine': True})
        check(result.get('exit_code') == 0 and not result.get('exit_signal'), 'guest native exec failed')
        guest = json.loads(result['stdout'])
    after = call('GET')
    check(all(before.get(k) == after.get(k) for k in ('id', 'instance_id', 'config', 'name', 'region', 'state')),
          'guest identity/config changed during observation')
    return {'observed_at': time.time(), 'id': before['id'], 'instance_id': before['instance_id'],
            'config_sha256': hashlib.sha256(json.dumps(before['config'], sort_keys=True).encode()).hexdigest(),
            'state': before['state'], 'guest': guest}


def guest_facts(observation):
    identity = {k: observation[k] for k in ('id', 'instance_id', 'config_sha256', 'state')}
    if observation['state'] == 'stopped':
        check(observation.get('guest') is None, 'stopped observation must not contain exec evidence')
        return {**identity, 'guest': None}
    check(observation['state'] == 'started', 'transitional guest state')
    g = observation['guest']
    check(g.get('uid') == 0 and g.get('refresh_scope_pids') == [] and g.get('unreadable') == []
          and g.get('token_path_metadata') == {'path': '/tmp/cloudbench-warm-fetch-token.3934342', 'exists': False},
          'guest refresh active/unreadable or token path remains')
    check([(p['pid'], p['exe']) for p in g['processes']] == [(1, '/fly/init'), (632, '/.fly/hallpass'), (633, '/usr/bin/sleep')]
          and all(s['pids'] == [632] and s['state'] == '0A' and s['local'].endswith(':0016') for s in g['sockets']),
          'guest processes/sockets changed')
    return {**identity,
            'guest': {k: v for k, v in g.items() if k != 'observed_at'}}


def operation_spec():
    return dict(token=TOKEN, source=SOURCE, mode=MODE, pins=PINS, receipt_path=RECEIPT,
                interrupted=True, snapshot=snapshot, inherited_count=2, live_pid=3912856, adapter_sha=None)


def validate(receipt, owner, proof):
    return validate_execution(receipt, owner, proof, operation_spec())


def validate_execution(receipt, owner, proof, operation, *, _covered_guest=False):
    token, source, mode = (operation[k] for k in ('token', 'source', 'mode'))
    pins, receipt_path = operation['pins'], operation['receipt_path']
    check(proof.get('kind') == 'native-cloud-cleanup-v1' and proof.get('compatibility') == mode
          and proof.get('purpose') == 'isolated-validation' and proof.get('layout') == 'campaign-v1', 'execution-only purpose')
    check(receipt['source']['head'] == source and receipt['token'] == token and proof.get('source') == receipt['source']
          and proof.get('request_token') == token and proof.get('owner') == owner == receipt['cleanup_owner'], 'original identity')
    if operation['interrupted']:
        check(receipt.get('worker_result') is None and receipt.get('native_cleanup_reference') is None
              and receipt.get('cancelled') is True and receipt.get('native_exit') == -9, 'original missing authority must remain')
    else:
        check(isinstance(receipt.get('worker_result'), str) and isinstance(receipt.get('native_cleanup_reference'), dict)
              and receipt.get('cancelled') is False and receipt.get('native_exit') == 1
              and proof.get('worker_result_sha256') == operation['adapter_sha'], 'original adapter authority must remain')
    check(receipt.get('complete') is False and all(x == 'UNVERIFIED' for x in receipt['cases'].values()),
          'original failure must remain')
    original, request, root, participants, debts, relay = operation['snapshot'](proof)
    check(receipt == original and proof.get('receipt_sha256') == pins[str(receipt_path)], 'original receipt bytes')
    check(proof.get('original_request') == str(receipt_path.parent / 'request.json')
          and proof.get('inherited_admissions') == request['isolated_validation'] and len(request['isolated_validation']) == operation['inherited_count'],
          'inherited ce/e92 debts required')
    check(isinstance(proof.get('validation_source'), dict) and set(proof['validation_source']) == {'head', 'digest'}, 'next source')
    confirmed = proof.get('confirmed_at')
    check(type(confirmed) in (float, int) and receipt['finished_at'] <= confirmed <= time.time(), 'confirmation clock')
    saved_guest = proof.get('guest_observation', {})
    check(max(receipt['finished_at'], confirmed - 60) <= saved_guest.get('observed_at', 0) <= confirmed, 'stale guest observation')
    facts = operation.get('guest_facts', guest_facts)
    saved_facts = facts(saved_guest)
    # Only the exact round16 transitive validator may supply current shared-guest
    # authority. Historical facts, pins and local owners still validate below.
    if not _covered_guest:
        check(saved_facts == facts(operation.get('guest_observe', guest_observe)()), 'guest observation changed')
    local = proof.get('local_observation', {})
    pids = {int(p.name.rsplit('-', 1)[-1]) for p in participants}
    retained = []
    live = []
    for path in debts:
        fields = dict(line.split('=', 1) for line in path.read_text().splitlines() if '=' in line)
        pid = int(fields['pid']); pids.add(pid)
        if fields.get('status') == 'live-transfer-required':
            birth, argv = hub_identity(pid)
            check((birth, argv) == (fields['pid_start'], fields['argv_sha256']), 'Hub incarnation changed')
            live.append(pid)
        retained.append({'path': str(path), 'sha256': pins[str(path)], 'owner': fields,
                         'disposition': 'retained-original-debt'})
    current = observe(pids, [str(root), relay])
    keys = ('boot_id', 'uid', 'pids', 'scopes', 'matched', 'unreadable')
    check(live == [operation['live_pid']] and current['matched'] == live and current['unreadable'] == []
          and all(local.get(k) == current[k] for k in keys)
          and receipt['finished_at'] <= local.get('observed_at', 0) <= confirmed
          and confirmed - local.get('observed_at', 0) <= 60, 'current local execution/identity')
    return {'kind': 'native-cloud-cleanup-v1', 'gate': receipt['gate'], 'token': token,
            'owner': copy.deepcopy(owner), 'worker_result_sha256': operation['adapter_sha'], 'proof': copy.deepcopy(proof),
            'participants': list(map(str, participants)), 'retained_services': retained,
            'purpose': 'isolated-validation', 'validation_source': proof['validation_source'],
            'excluded_resources': operation.get('excluded_resources', {}), 'credit_granted': False, 'obligations_preserved': True,
            'cleanup_complete': False}


def validate_renewal(prior, proof):
    """Explicit renewal can refresh only observations/target source, never old debt."""
    allowed = {'validation_source', 'guest_observation', 'local_observation', 'confirmed_at'}
    check({k: v for k, v in prior.items() if k not in allowed}
          == {k: v for k, v in proof.items() if k not in allowed}, 'immutable original proof changed')
    check(proof['confirmed_at'] >= prior['confirmed_at'] and 0 <= time.time() - proof['confirmed_at'] <= 60,
          'renewal must be freshly collected')


def build(validation_source):
    return build_execution(validation_source, operation_spec())


def build_execution(validation_source, operation):
    pins, receipt_path = operation['pins'], operation['receipt_path']
    receipt, request, root, participants, debts, relay = operation['snapshot']({'files': pins})
    pids = {int(p.name.rsplit('-', 1)[-1]) for p in participants}
    for p in debts:
        pids.add(int(dict(l.split('=', 1) for l in p.read_text().splitlines() if '=' in l)['pid']))
    observation = observe(pids, [str(root), relay])
    return dict(kind='native-cloud-cleanup-v1', compatibility=operation['mode'], purpose='isolated-validation', layout='campaign-v1',
                source=receipt['source'], request_token=operation['token'], owner=receipt['cleanup_owner'], files=pins,
                original_request=str(receipt_path.parent/'request.json'), inherited_admissions=request['isolated_validation'],
                receipt_sha256=pins[str(receipt_path)], validation_source=validation_source,
                local_observation=observation, guest_observation=operation.get('guest_observe', guest_observe)(), confirmed_at=time.time(), observed_by='round12 pinned investigator proof builder')


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--validation-source', required=True, help='JSON with exact head and digest')
    args = parser.parse_args()
    print(json.dumps(build(json.loads(args.validation_source)), indent=2))
