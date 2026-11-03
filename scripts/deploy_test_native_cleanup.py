"""Read-only, launch-only reconciliation of sealed native cloud fleet cleanup."""
import copy
import hashlib
import json
import math
from pathlib import Path
import re
import shlex
import time

KIND = 'native-cloud-cleanup-v1'


def need(value, message):
    if not value:
        raise ValueError('native cleanup: ' + message)


def fields(raw):
    rows = [line.partition('=') for line in raw.decode().splitlines()]
    need(all(k and sep for k, sep, _ in rows) and len({r[0] for r in rows}) == len(rows), 'invalid fields')
    return {k: v for k, _, v in rows}


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def validate(receipt, owner, proof):
    from deploy_test_cycle import MAX_RECEIPT_BYTES, bounded_read, sha_file
    need(proof.get('kind') == KIND and proof.get('owner') == owner, 'full original owner mismatch')
    need(set(owner) == {'request_token', 'worker_root', 'native_cleanup_reference'}, 'unsupported owner shape')
    token, root = receipt['token'], Path(owner['worker_root'])
    need(root.is_absolute() and root.resolve() == root, 'noncanonical worker root')
    need(proof['request_token'] == owner['request_token'] == token and proof['source'] == receipt['source'], 'request identity')
    folder = Path(receipt['log']).parent
    adapter_path = Path(receipt['worker_result'])
    adapter = bounded_read(adapter_path, 'native adapter')
    need(bounded_read(folder / 'receipt.json', 'native receipt') == receipt, 'recorded receipt changed')
    receipt_sha, adapter_sha = sha_file(folder / 'receipt.json'), sha_file(adapter_path)
    need(proof['receipt_sha256'] == receipt_sha and proof['worker_result_sha256'] == adapter_sha, 'original bytes changed')
    need(all(adapter.get(k) == receipt.get(k) for k in ('token', 'source', 'gate')), 'adapter identity')
    reference = owner['native_cleanup_reference']
    need(receipt.get('lifecycle') == 'native-producer' and receipt.get('complete') is False
         and receipt.get('timed_out') is False and receipt.get('cancelled') is False
         and reference == receipt.get('native_cleanup_reference') and reference['result'] == str(adapter_path)
         and reference['result_sha256'] == adapter_sha, 'native cleanup reference')
    confirmed = proof['confirmed_at']
    need(finite(confirmed) and finite(receipt['finished_at']) and receipt['finished_at'] <= confirmed <= time.time()
         and isinstance(proof['observed_by'], str) and proof['observed_by'].strip(), 'confirmation')
    bindings, used = proof['files'], set()
    need(isinstance(bindings, dict), 'missing file bindings')

    def bound(path):
        path = Path(path)
        need(path.is_absolute() and path.resolve() == path and path.is_file() and not path.is_symlink(), 'noncanonical proof file')
        need(path.stat().st_size <= MAX_RECEIPT_BYTES, 'proof file too large')
        raw = path.read_bytes()
        need(bindings.get(str(path)) == hashlib.sha256(raw).hexdigest(), 'file hash mismatch: ' + str(path))
        used.add(str(path))
        return raw

    def document(path):
        value = json.loads(bound(path))
        need(isinstance(value, dict), 'expected object')
        return value

    def tree(path):
        need(path.resolve() == path and path.is_dir() and not path.is_symlink(), 'audit directory')
        digest = hashlib.sha256()
        for item in sorted(path.rglob('*'), key=lambda p: str(p.relative_to(path))):
            need(not item.is_symlink() and (item.is_dir() or item.is_file()), 'unsafe audit member')
            if item.is_file() and item.name != 'source-audit':
                for value in (str(item.relative_to(path)).encode(), bound(item)):
                    digest.update(len(value).to_bytes(8, 'big'))
                    digest.update(value)
        return digest.hexdigest()

    request = document(folder / 'request.json')
    need(all(request.get(k) == receipt.get(k) for k in ('token', 'source', 'gate')), 'request document')
    runs = root / '.context/deploy-cloud' / hashlib.sha256(token.encode()).hexdigest() / 'runs'
    cli = runs.parent / 'cli.log'
    need(adapter.get('runner_log') == str(cli), 'adapter native root')
    cli_text = bound(cli).decode()
    log = Path(proof['controller_log'])
    need(log.parent == runs and log.name.startswith('detached-') and log.suffix == '.log', 'controller handle')
    status = log.with_suffix('.status')
    need(str(log) in cli_text and str(status) in cli_text, 'controller not in original CLI')
    exit_code = int(bound(status).decode().strip())
    need(type(adapter.get('native_exit')) is int and exit_code == adapter['native_exit'] and exit_code in (0, 1), 'terminal exit')
    handles = []
    for line in bound(log).decode(errors='replace').splitlines():
        if str(root / 'scripts/run-bench') + ' monitor ' not in line:
            continue
        args = shlex.split(line.strip())
        need(len(args) == 5 and args[:2] == [str(root / 'scripts/run-bench'), 'monitor']
             and args[3:] == ['--controller-status', str(status)], 'native monitor binding')
        handles.append(Path(args[2]))
    need(handles, 'no native parent handle')
    participants = {p for p in runs.iterdir() if p.is_dir() and p.name != '_hub'}
    need(set(handles) == participants and all(p.parent == runs and (p / '_batch').is_dir() for p in participants), 'participant closure')
    retained, audit_seals = {}, {}
    from cloudbench_execution_provenance import validate_provenance, validate_task_matrix_binding
    for fleet in sorted(participants):
        provenance = document(fleet / 'execution-provenance.json')
        matrix = document(fleet / 'execution-task-matrix.json')
        need(not validate_provenance(provenance) and not validate_task_matrix_binding(provenance, matrix)
             and provenance['base_sha'] == receipt['source']['head'] and provenance['workspace_patch_sha256'] == 'none', 'execution source')
        benches = json.loads(bound(fleet / '_batch/benches.json'))
        need(isinstance(benches, list) and len(benches) == len(matrix['tasks'])
             and len({b['name'] for b in benches}) == len(benches)
             and {b['name'] for b in benches} == {t['name'] for t in matrix['tasks']}, 'native inventory')
        if fleet == handles[0]:
            need({b['name'] for b in benches} == set(request['checks']), 'parent requested inventory')
        document(fleet / '_batch/run.json')  # Bind original outcomes without regrading them.
        life = document(fleet / '_batch/lifecycle.json')
        owner_token = life['fleet_owner_token']
        need(isinstance(owner_token, str) and re.fullmatch('[0-9a-f]{32}', owner_token), 'fleet owner')
        need(type(life.get('version')) is int and life['version'] == 1 and life['run_id'] == fleet.name
             and life['workspace_root'] == str(root) and life['hub_publication_failed'] is False
             and type(life['controller_exit_code']) is int
             and (life['controller_exit_code'] == exit_code if fleet == handles[0]
                  else life['controller_exit_code'] == 0 and life['status'] == 'verified')
             and life['status'] in {'verified', 'failed'}, 'native terminal lifecycle')
        audit = fleet / 'teardown-ownership'
        canonical = root / '.git/cloudbench-fleet-audits' / owner_token
        binding = fields(bound(audit / 'source-audit'))
        seal = tree(audit)
        need(binding == {'path': str(canonical), 'sha256': seal}
             and tree(canonical) == seal == life['audit_sha256'], 'native audit seal')
        meta = fields(bound(audit / 'meta'))
        need(meta.get('status') == 'provider-teardown-verified' and meta.get('version') == '1'
             and meta.get('fleet_owner_token') == owner_token and meta.get('run_id') == fleet.name
             and meta.get('workspace_root') == str(root), 'native provider release')
        release = float(bound(audit / 'provider-teardown-verified.epoch'))
        need(finite(release) and adapter['started_at'] <= release <= confirmed, 'release epoch')
        registry = root / '.git/cloudbench-fleet-ownership' / owner_token
        need(not registry.exists() and not registry.is_symlink(), 'fleet registry still retained')
        ids = bound(audit / 'owned-clones.ids').decode().splitlines()
        names = bound(audit / 'owned-clones.names').decode().splitlines()
        rows = [fields(bound(p)) for p in (audit / 'fresh').iterdir()] if (audit / 'fresh').exists() else []
        need(len(ids) == len(set(ids)) == len(rows) and set(ids) == {r['machine_id'] for r in rows}
             and len(names) == len(set(names)) == len(rows) and set(names) == {r['clone_name'] for r in rows}, 'resource closure')
        need(all(r.get('fleet_owner_token') == owner_token and r.get('run_id') == fleet.name
                 and r.get('app') == meta['app'] and r.get('source') == 'fresh-clone'
                 and r.get('disposition') == 'destroyed-provider-retained' for r in rows), 'unsupported resource disposition')
        for name in ('pool', 'pool-handoffs', 'volume-migrations'):
            path = audit / name
            need(not path.exists() or path.is_dir() and not path.is_symlink() and not any(path.iterdir()),
                 'unsupported resource class')
        disposable = document(fleet / '_batch/disposable-cleanup.json')
        need(disposable.get('schema') == 'disposable-cleanup-v1' and disposable.get('owner') == owner_token
             and disposable.get('guest_cleanup_missing') is False and disposable.get('runtime_evidence_missing') is False, 'guest cleanup')
        need(meta['hub_disposition'] == 'retained-exact-owner-transfer-required', 'unsupported Hub disposition')
        hub = Path(meta['hub_owner_file'])
        need(hub.parent == runs / '_hub', 'Hub root')
        hub_owner = fields(bound(hub))
        need(hub_owner.get('status') == 'live-transfer-required' and hub_owner.get('version') == '1'
             and all(hub_owner.get(k) == str(runs) for k in ('root', 'runs_root'))
             and hub_owner.get('repo_root') == str(root) and hub_owner.get('context_dir') == str(runs / '_hub')
             and hub_owner.get('command') == str(root / 'agents/benchmarks/agent_link_server.py')
             and all(hub_owner.get(k) == meta['hub_' + k] for k in ('pid', 'pid_start', 'argv_sha256'))
             and hub_owner.get('pgid') == hub_owner.get('pid') and hub_owner.get('owner_token') == meta['hub_owner_token'], 'retained Hub identity')
        retained[str(hub)] = {'path': str(hub), 'sha256': bindings[str(hub)], 'owner': hub_owner,
                             'disposition': meta['hub_disposition']}
        audit_seals[str(audit)] = seal
    need(used == set(bindings), 'proof file closure')
    return {'kind': KIND, 'gate': receipt['gate'], 'token': token, 'owner': copy.deepcopy(owner),
            'worker_result_sha256': adapter_sha, 'proof': copy.deepcopy(proof),
            'participants': sorted(map(str, participants)), 'native_audit_seals': audit_seals,
            'retained_services': [retained[k] for k in sorted(retained)], 'credit_granted': False}


def reconcile(state, occurrence_id, proof):
    from deploy_test_cycle import latest_receipts, receipt_owner
    try:
        failure = next(f for f in state['failures'] if f['id'] == occurrence_id)
        gate = failure['gate']
        need(any(g['name'] == gate and g.get('native_cloud') is True for g in state['plan']['gates']), 'native_cloud gate required')
        receipt = latest_receipts(state)[gate]
        case = failure['check'].split('/', 1)[1]
        need(failure.get('native_result') == 'UNVERIFIED' and not failure.get('complete')
             and receipt.get('complete') is False and receipt['cases'].get(case) == 'UNVERIFIED', 'latest incomplete occurrence required')
        entry = validate(receipt, receipt_owner(gate, receipt), proof)
        entry['occurrence'] = occurrence_id
        key = proof['receipt_sha256']
        need(not any(e.get('token') == entry['token'] and k != key for k, e in state.get('reconciled_owners', {}).items()), 'token already reconciled elsewhere')
    except (OSError, KeyError, TypeError, StopIteration, ValueError) as error:
        raise ValueError('native cleanup proof refused: ' + str(error)) from error
    state.setdefault('reconciled_owners', {})[key] = entry


def still_bound(entry, receipt, owner):
    try:
        actual = validate(receipt, owner, entry['proof'])
        return actual == {k: v for k, v in entry.items() if k != 'occurrence'}
    except (OSError, ValueError, KeyError, TypeError):
        return False
