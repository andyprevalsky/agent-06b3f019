"""Narrow, source-bound renewal of an existing sandbox release-stall exclusion.

No native result or financial fact is rewritten. Provider observation is produced
separately, after freezing source, by the read-only TypeScript CLI.
"""
from __future__ import annotations
import ast
import copy
import json
import math
import re
from pathlib import Path
import subprocess
import time

KIND = 'agentcard-release-stall-renewal-v1'
PRODUCER = 'back-end/scripts/agentcard-confirm-stall.ts'
PAYMENT_PATHS = ('back-end/src/domains/purchases', 'back-end/src/domains/test-payment',
                 'back-end/src/domains/agentcard', 'back-end/src/providers/agentcard')
FUNCTIONS = ('_validate_payment_lifecycle', '_agentcard_release_skip_task',
             '_agentcard_release_stalled', '_agentcard_release_skip_lifecycle',
             '_agentcard_release_prior_failure_is_settlement_only',
             '_validate_payment_merchant_identity', '_catalog_merchant_identity',
             '_merchant_label_matches_businesses', 'ensure_payment_lifecycle_cleanup',
             '_start_payment_abandonment_with_recovery', '_owned_payments_release_stalled',
             '_agentcard_release_skip_enabled')


def contract(root, head, name):
    """Compare immutable Git baseline to current bytes, including untracked payment files."""
    import deploy_test_cycle as c
    if not re.fullmatch(r'[0-9a-f]{40}', head):
        raise ValueError('invalid original source commit')
    def old(path):
        return subprocess.run(['git', 'show', f'{head}:{path}'], cwd=root,
                              check=True, capture_output=True).stdout
    def read(path):
        return (root / path).read_bytes()
    def identity(loader):
        tasks = json.loads(loader('agents/benchmarks/tasks.json'))
        task, = [t for t in tasks if t['name'] == name]
        if task.get('production_only', False) is not False or 'agentcard-lifecycle-sandbox' not in task['tags']:
            raise ValueError('only catalog sandbox lifecycle tasks can renew')
        tree = ast.parse(loader('agents/benchmarks/run_benchmark.py'))
        nodes = {}
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                nodes[node.name] = node
            elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                for target in getattr(node, 'targets', [getattr(node, 'target', None)]):
                    if isinstance(target, ast.Name):
                        nodes[target.id] = node
        if not set(FUNCTIONS) <= nodes.keys():
            raise ValueError('missing lifecycle assertion contract')
        # Include referenced local helpers/constants: unchanged entry-point text
        # must never hide a changed predicate dependency.
        pending, funcs = set(FUNCTIONS), {}
        while pending:
            function_name = pending.pop()
            if function_name in funcs or function_name not in nodes:
                continue
            node = nodes[function_name]
            funcs[function_name] = ast.dump(node, include_attributes=False)
            pending.update(n.id for n in ast.walk(node)
                           if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load) and n.id not in funcs)
        return task, funcs
    baseline = identity(old)
    if baseline != identity(read):
        raise ValueError('changed task/predicate/independent assertion contract')
    paths = subprocess.run(['git', 'ls-tree', '-r', '--name-only', head, '--', *PAYMENT_PATHS],
                           cwd=root, check=True, capture_output=True, text=True).stdout.splitlines()
    current = subprocess.run(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '--', *PAYMENT_PATHS],
                             cwd=root, check=True, capture_output=True, text=True).stdout.splitlines()
    paths.append('agents/benchmarks/cloud_batch_cleanup.py')
    current.append('agents/benchmarks/cloud_batch_cleanup.py')
    if not paths or set(paths) != set(current) or any(old(p) != read(p) for p in paths):
        raise ValueError('changed payment contract')
    return baseline[0], c.digest([baseline, {p: c.sha_file(root / p) for p in paths}])


def original(state, occurrence, root):
    import deploy_test_cycle as c
    candidates = [w for w in state.get('superseded_resource_warnings', []) if w['id'] == occurrence]
    if not candidates:
        raise ValueError('no superseded warning to renew')
    warning = candidates[-1]
    failure, = [f for f in state['failures'] if f['id'] == occurrence]
    c.validate_resource_skip(failure['rca'], failure)
    evidence = failure['worker_evidence']
    if (warning['confirmation'].get('reason_code') != 'agentcard_release_stall'
            or failure['disposition'] != c.RESOURCE_SKIP
            or warning.get('original_source', warning['source']) != failure['source']
            or warning['confirmation'] != failure['rca']['resource_skip']
            or warning['native_row'] != evidence['native_task']
            or warning['receipt_sha256'] != evidence['sha256']
            or c.sha_file(evidence['path']) != evidence['sha256']):
        raise ValueError('original warning/native evidence changed')
    doc = c.read(Path(evidence['path']))
    task, = [t for t in doc['tasks'] if t['name'] == warning['native_row']['name']]
    for field in ('name', 'status', 'benchmark_status', 'passed', 'failure_reason', 'agent_id'):
        if task.get(field) != warning['native_row'].get(field):
            raise ValueError('native row mismatch')
    if task.get('execution_provenance', {}).get('base_sha') != failure['source']['head']:
        raise ValueError('native execution source mismatch')
    if task.get('cleanup_failure', 'missing') is not None or task.get('context_violations') != []:
        raise ValueError('independent native failure')
    lifecycle = task['logs']['agentcard_release_stall_lifecycle']
    cleanup = task['logs']['cloud_cleanup_evidence']
    if (cleanup.get('errors') != [] or cleanup.get('root_agent_id') != task['agent_id']
            or cleanup['agentcard_release_stall_lifecycles'].get(task['agent_id']) != lifecycle
            or cleanup['final'].get('root_deleted') is not True
            or cleanup['final'].get('unsealed_tree_agent_ids') != []):
        raise ValueError('cleanup unknown or lifecycle join mismatch')
    for session in cleanup['final']['browser_sessions']:
        if not any(receipt.get('provider') == session.get('provider')
                   and receipt.get('session_id') == session.get('session_id')
                   and receipt.get('status') in (200, 204, 404, 410)
                   for receipt in cleanup.get('provider_receipts', [])):
            raise ValueError('browser resource cleanup unknown')
    if lifecycle.get('agentId') != task['agent_id']:
        raise ValueError('lifecycle belongs to another agent')
    card, transfer = lifecycle['agentCard'], lifecycle['orgTransfer']
    if (card['status'] != 'CLOSED' or type(card['balanceCents']) is not int or card['balanceCents'] != 0
            or transfer['livemode'] is not False or transfer['status'] != 'consumed'
            or type(transfer['releasedCents']) is not int or transfer['releasedCents'] != 0
            or type(transfer['transferredCents']) is not int or transfer['transferredCents'] <= 0
            or transfer['amountCents'] != transfer['transferredCents']
            or transfer['cardId'] != card['id'] or lifecycle['purchase']['cardId'] != card['id']
            or lifecycle['purchase']['status'] != 'HELD' or lifecycle['walletFunding']['status'] != 'RECLAIMING'
            or lifecycle['walletFunding']['providerTransferId'] != transfer['id']
            or lifecycle['stripeRefund'] is not None or lifecycle['stripeHold']['livemode'] is not False):
        raise ValueError('not an exact unreleased sandbox stall')
    task_contract, contract_sha = contract(root, failure['source']['head'], task['name'])
    ignored = {'purchase': {'status'}, 'walletFunding': {'status'},
               'orgTransfer': {'status', 'transferredCents', 'releasedCents'}}
    def compare(expected, actual):
        if isinstance(expected, dict):
            return isinstance(actual, dict) and all(k in actual and compare(v, actual[k]) for k, v in expected.items())
        return type(expected) is type(actual) and expected == actual
    expected = copy.deepcopy(task_contract['expected_payment_lifecycle'])
    expected.pop('stripeRefund', None)
    for section, fields in ignored.items():
        for field in fields:
            expected.get(section, {}).pop(field, None)
    if not compare(expected, lifecycle):
        raise ValueError('independent lifecycle assertions failed')
    return warning, failure, lifecycle, contract_sha


def binding(state, occurrence, root):
    import deploy_test_cycle as c
    if (state['source'] != c.source(root) or state['plan_digest'] != c.digest(state['plan'])
            or state['plan']['source'] != state['source'] or state['environment'] != c.environment_digest()
            or state['input_fingerprints'] != c.input_fingerprints(state['plan'], root)):
        raise ValueError('source/plan/input/environment is not frozen')
    c.validate_plan(state['plan'], root)
    warning, failure, lifecycle, contract_sha = original(state, occurrence, root)
    return {'kind': KIND, 'occurrence': occurrence, 'warning_sha256': c.digest(warning),
            'native_sha256': warning['receipt_sha256'], 'original_source': failure['source'],
            'source': state['source'], 'plan_digest': state['plan_digest'],
            'input_fingerprint': state['input_fingerprints'][warning['gate']],
            'environment': state['environment'], 'contract_sha256': contract_sha,
            'producer_sha256': c.sha_file(root / PRODUCER),
            'card_id': lifecycle['agentCard']['id'], 'transfer_id': lifecycle['orgTransfer']['id'],
            'amount_cents': lifecycle['orgTransfer']['amountCents']}


def renew(state, proof, root):
    import deploy_test_cycle as c
    if (state.get('phase') not in {'quick', 'initial', 'final', 'ready', 'needs-focused-plan', 'failed-gates'}
            or any(k in state for k in ('running', 'live_failures', 'resume_phase', 'pending'))
            or c.CANCEL.is_set() or c.retained_owners(state, [g['name'] for g in state['plan']['gates']])):
        raise ValueError('renewal requires quiescent coordinator and known cleanup')
    expected = binding(state, proof['binding']['occurrence'], root)
    supplied = dict(proof['binding'])
    prepared_at = supplied.pop('prepared_at', None)
    negative = 'confirmation_failure' in proof
    payload = 'confirmation_failure' if negative else 'observations'
    if set(proof) != {'binding', 'started_at', 'finished_at', payload} or supplied != expected:
        raise ValueError('renewal proof binding mismatch or mixed waiver fields')
    current = [w for w in state.get('resource_warnings', []) if w['id'] == expected['occurrence']]
    if current:
        if current[0].get('renewal') == proof:
            validate_active(state, current[0])
            return
        raise ValueError('warning already renewed with another proof')
    if type(prepared_at) not in (int, float) or not math.isfinite(prepared_at):
        raise ValueError('missing source preparation timestamp')
    for field in ('started_at', 'finished_at'):
        if type(proof[field]) not in (int, float) or not math.isfinite(proof[field]):
            raise ValueError('invalid read observation time')
    failure = next(f for f in state['failures'] if f['id'] == expected['occurrence'])
    if not failure['finished_at'] <= prepared_at <= proof['started_at'] <= proof['finished_at'] <= time.time() + 5:
        raise ValueError('read observation predates native execution or is in future')
    if time.time() - proof['started_at'] > 300:
        raise ValueError('stale read-only confirmation')
    if negative:
        exception = proof['confirmation_failure']
        if (not isinstance(exception, dict)
                or set(exception) != {'provider', 'reason', 'status', 'code', 'tool'}
                or exception != {'provider': 'AgentCard', 'reason': 'credential or billing change',
                                 'status': 401, 'code': 'agentcard_org_mcp_unauthorized',
                                 'tool': exception.get('tool')}
                or type(exception['status']) is not int
                or exception['tool'] not in ('get_card', 'list_transfers')):
            raise ValueError('not an exact provider authentication refusal')
    else:
        validate_observations(proof['observations'], expected)
    warning = next(w for w in reversed(state['superseded_resource_warnings']) if w['id'] == expected['occurrence'])
    entry = {k: copy.deepcopy(v) for k, v in warning.items() if k != 'superseded'}
    entry.pop('provider_exception', None)
    entry.pop('current_resource_state', None)
    entry.update(source=state['source'], original_source=failure['source'],
                 input_fingerprint=expected['input_fingerprint'], renewal=copy.deepcopy(proof))
    if negative:
        entry['provider_exception'] = copy.deepcopy(proof['confirmation_failure'])
        entry['current_resource_state'] = 'UNVERIFIED; original native financial obligation retained'
    if binding(state, expected['occurrence'], root) != expected:
        raise ValueError('source/input changed during renewal validation')
    state.setdefault('resource_warnings', []).append(entry)
    state.setdefault('resource_warning_renewals', []).append(copy.deepcopy(proof))


def validate_observations(observations, expected):
    import deploy_test_cycle as c
    if not isinstance(observations, dict) or not isinstance(observations.get('card'), dict):
        raise ValueError('missing card observation')
    expected_card = {'id': expected['card_id'], 'status': 'CLOSED', 'balanceCents': 0}
    # Card mode is optional metadata, never inferred from the transfer. If the
    # vendor supplies it, only an explicit boolean false is acceptable.
    if 'livemode' in observations['card']:
        if observations['card']['livemode'] is not False:
            raise ValueError('invalid or live card mode')
        expected_card['livemode'] = False
    expected_observations = {
        'card': expected_card,
        'transfer': {'id': expected['transfer_id'], 'cardId': expected['card_id'], 'status': 'consumed',
                     'amountCents': expected['amount_cents'], 'transferredCents': expected['amount_cents'],
                     'releasedCents': 0, 'livemode': False}}
    # Exact shape and types: bool/number equality cannot admit malformed JSON.
    if c.digest(observations) != c.digest(expected_observations):
        raise ValueError('provider observation no longer proves original sandbox stall')


def validate_active(state, warning):
    """A persisted exclusion is not fresh execution; its current input binding stays mandatory."""
    import deploy_test_cycle as c
    proof = warning['renewal']
    failure = next(f for f in state['failures'] if f['id'] == warning['id'])
    c.validate_resource_skip(failure['rca'], failure)
    if c.sha_file(failure['worker_evidence']['path']) != warning['receipt_sha256']:
        raise ValueError('renewed native evidence changed')
    b = proof['binding']
    if (b['occurrence'] != warning['id'] or b['native_sha256'] != warning['receipt_sha256']
            or b['input_fingerprint'] != state['input_fingerprints'][warning['gate']]
            or b['environment'] != state['environment']
            or proof not in state.get('resource_warning_renewals', [])):
        raise ValueError('renewed warning binding changed')
