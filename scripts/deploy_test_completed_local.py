"""Data-preserving migration of a completed local payment batch, never execution credit."""
import copy
import json
import os
from pathlib import Path
import re
import subprocess

KIND = 'completed-local-agentcard-migration-v1'


def need(value, reason):
    if not value:
        raise ValueError('completed local custody: ' + reason)


def physical(worker, run, owners, services):
    """Re-observe exact local closure without stopping anything or touching a database."""
    from deploy_test_local_cleanup import quiet
    quiet(worker)
    for owner in owners:
        need(type(owner.get('pid')) is int and owner['pid'] > 1
             and re.fullmatch(r'linux:[0-9a-f-]+:[0-9]+', owner.get('native_identity', '')),
             'original owner birth missing')
        path = Path('/proc', str(owner['pid']), 'stat')
        try:
            row = path.read_text().rsplit(') ', 1)[1].split()
            identity = 'linux:' + Path('/proc/sys/kernel/random/boot_id').read_text().strip() + ':' + row[19]
            need(identity != owner['native_identity'] or row[0] in ('Z', 'X'), 'original owner still live')
        except (FileNotFoundError, ProcessLookupError):
            pass
    ports = set(services['ports'].values()) - {0}
    need(all(type(p) is int and 0 < p < 65536 for p in ports), 'recorded ports invalid')
    for table in ('tcp', 'tcp6'):
        for line in Path('/proc/net', table).read_text().splitlines()[1:]:
            fields = line.split()
            need(fields[3] != '0A' or int(fields[1].split(':')[1], 16) not in ports,
                 'recorded service listener remains')


def original(state, evidence, root):
    """Only the exact admitted, joined batch with one proved financial stall."""
    import deploy_test_cycle as c
    need(set(evidence) == {'failure_id', 'run', 'files'}, 'evidence fields changed')
    matches = [f for f in state['failures'] if f['id'] == evidence['failure_id']]
    need(len(matches) == 1, 'original failure missing or duplicated')
    f = matches[0]
    gates = [g for g in state['plan']['gates'] if g['name'] == f['gate']]
    need(len(gates) == 1, 'original gate missing')
    gate = gates[0]
    need(gate['name'] == gate['category'] == 'agentcard-lifecycle'
         and gate.get('worker_transport') == 'local-isolated' and gate.get('case_protocol') is True
         and gate['checks'] == ['agentcard-lifecycle'] and f['native_result'] == 'UNVERIFIED'
         and f['complete'] is False, 'not the legacy local aggregate')
    folder = Path(f['worker_result']).parent
    worker = Path(gate['worker_root'])
    run = Path(evidence['run'])
    need(worker.resolve(strict=True) == worker and run.resolve(strict=True) == run
         and run.parent == worker / '.context/benchmarks', 'original physical root changed')
    expected = {folder / n for n in ('request.json', 'receipt.json', 'result.json')}
    expected.update(run / n for n in ('run.json', 'report-card.json', 'local-stack-owner.json',
                                      'local-benchmark-owner.json', 'services.json', 'local-stack-cleanup.status'))
    def raw(path):
        need(path.is_absolute() and path.resolve(strict=True) == path and path.is_file()
             and not path.is_symlink() and c.sha_file(path) == evidence['files'].get(str(path)),
             'original artifact changed: ' + str(path))
        return path.read_bytes()
    def doc(path):
        raw(path)
        return c.bounded_read(path, 'completed local original')
    request, receipt, adapter = (doc(folder / n) for n in ('request.json', 'receipt.json', 'result.json'))
    stored = [v for a in state['attempts'] for v in a.get('results', [])
              if v.get('token') == receipt.get('token') and v.get('gate') == f['gate']]
    need(stored == [receipt] and c.sha_file(folder / 'result.json') == receipt['native_cleanup_reference']['result_sha256'],
         'original adapter/receipt seal changed')
    need(all(d.get(k) == f.get(k) for d in (request, receipt, adapter) for k in ('source', 'gate'))
         and request['token'] == receipt['token'] == adapter['token']
         and receipt['command'] == f['command'] == gate['command']
         and receipt['log'] == f['evidence'] and receipt['worker_result'] == f['worker_result'],
         'original receipt identity changed')
    need(receipt['complete'] is False and receipt['native_exit'] == 1
         and receipt['lingering_group'] is True and receipt.get('lifecycle') == 'native-producer'
         and receipt.get('cancelled') is False and receipt.get('timed_out') is False
         and adapter['complete'] is False and adapter['cleanup_complete'] is True
         and adapter['cases'] == receipt['cases'] == {'agentcard-lifecycle': 'UNVERIFIED'},
         'native original outcome changed')
    need(request['worker_root'] == adapter['worker_root'] == str(worker)
         and adapter['recipe_digest'] == c.digest(request['worker_recipe'])
         and request['worker_recipe'] == gate['worker_recipe'], 'original worker contract changed')
    case = adapter['evidence']['agentcard-lifecycle']
    need(case == f['worker_evidence'], 'original case evidence changed')
    log = Path(case['log']); expected.add(log)
    need(case['command'] == request['worker_recipe']['cases']['agentcard-lifecycle']['command']
         and case['native_exit'] == 1 and case['status'] == 'UNVERIFIED'
         and all(case.get(k) is False for k in ('timed_out', 'cancelled', 'lingering_group'))
         and case['sha256'] == evidence['files'].get(str(log))
         and str(run) in raw(log).decode(), 'original admitted/joined case changed')
    need(set(evidence['files']) == {str(p) for p in expected}, 'exact original artifact closure required')
    batch, card = doc(run / 'run.json'), doc(run / 'report-card.json')
    need(card['source_sha'] == f['source']['head'] and card['run_id'] == batch['run_id']
         and card['tasks'] == {'total': 4, 'running': 0, 'completed': 4, 'queued': 0},
         'original batch not complete')
    command = case['command']
    need(command[:4] == ['bash', 'scripts/run-bench', '--local', 'agent-payment-test-shop']
         and command[7:] == ['--bootstrap', '--max-concurrency', '1', '--no-dashboard'],
         'original task recipe changed')
    names = command[3:7]
    need(names == ['agent-payment-test-shop', 'agent-payment-setup-resume',
                   'agent-payment-idempotent-abandonment', 'agent-payment-abandonment'],
         'original four task identities changed')
    tasks = batch['tasks']
    need(len(set(names)) == len(tasks) == 4 and {t['name'] for t in tasks} == set(names),
         'original task inventory changed')
    old_catalog = json.loads(subprocess.check_output(
        ['git', 'show', f['source']['head'] + ':agents/benchmarks/tasks.json'], cwd=root))
    catalog = json.loads((root / 'agents/benchmarks/tasks.json').read_bytes())
    contracts = {}
    for name in names:
        old, = [t for t in old_catalog if t['name'] == name]
        current, = [t for t in catalog if t['name'] == name]
        semantic = lambda t: {k: v for k, v in t.items() if k not in ('group', 'tags')}
        need(semantic(old) == semantic(current)
             and 'agentcard-lifecycle-sandbox' in current.get('tags', [])
             and current.get('production_only', False) is False, 'task semantics changed: ' + name)
        contracts[name] = {'original': old, 'current': current}
    failures = [t for t in tasks if t['passed'] is not True]
    need(len(failures) == 1 and all(t['status'] == 'COMPLETED' and t['benchmark_status'] == 'PASSED'
                                  for t in tasks if t['passed'] is True), 'independent original task failure')
    stalled = failures[0]
    need(stalled['name'] == 'agent-payment-abandonment'
         and stalled['status'] == stalled['benchmark_status'] == 'ERROR'
         and stalled['failure_reason'] == 'Cloud cleanup failed: payment: TimeoutError'
         and stalled.get('cleanup_failure') is None and stalled.get('context_violations') == [],
         'not the exclusive original payment cleanup failure')
    cleanup = stalled['logs']['cloud_cleanup_evidence']
    snap = stalled['logs']['failure_evidence']['benchmark_state']['payment_lifecycle']
    need(cleanup['errors'] == ['payment: TimeoutError']
         and cleanup['root_agent_id'] == snap['agentId'] == stalled['agent_id'], 'stall root changed')
    from deploy_test_historical_custody import sandbox_stall_snapshot
    sandbox_stall_snapshot(snap)
    expected_lifecycle = copy.deepcopy(contracts[stalled['name']]['original']['expected_payment_lifecycle'])
    pending = {'purchase': {'status'}, 'walletFunding': {'status'},
               'orgTransfer': {'status', 'transferredCents', 'releasedCents'}}
    expected_lifecycle.pop('stripeRefund', None)
    def matches(expected, actual):
        return (isinstance(actual, dict) and all(k in actual and matches(v, actual[k]) for k, v in expected.items())
                if isinstance(expected, dict) else expected == actual)
    for section, keys in pending.items():
        for key in keys:
            expected_lifecycle.get(section, {}).pop(key, None)
    need(matches(expected_lifecycle, snap), 'independent payment assertions changed')
    final = cleanup['final']
    need(final['root_deleted'] is True and final['unsealed_tree_agent_ids'] == []
         and stalled['agent_id'] in final['tree_agent_ids'], 'task tree closure missing')
    for session in final['browser_sessions']:
        need(any(p.get('provider') == session['provider'] and p.get('session_id') == session['session_id']
                 and p.get('status') in (200, 204, 404, 410) for p in cleanup['provider_receipts']),
             'browser closure missing')
    purchase, = [p for p in final['purchase_cleanup'] if p['purchase_id'] == snap['purchase']['id']]
    need(all(purchase.get(k) == v for k, v in {
        'agent_id': stalled['agent_id'], 'card_id': snap['agentCard']['id'],
        'provider_transfer_id': snap['orgTransfer']['id'], 'total_cents': snap['orgTransfer']['amountCents'],
        'status': 'HELD', 'funding_status': 'RECLAIMING'}.items()), 'final purchase identity changed')
    owners = [doc(run / n) for n in ('local-stack-owner.json', 'local-benchmark-owner.json')]
    services = doc(run / 'services.json')
    need(all(o['run_id'] == run.name for o in owners) and services['run_sh_pid'] == owners[0]['pid']
         and services['worktree'] == str(worker) and services['status'] == 'stopped', 'original stack identity changed')
    fields = dict(line.split('=', 1) for line in raw(run / 'local-stack-cleanup.status').decode().splitlines())
    need(fields.get('state') == 'clean' and fields.get('token') == owners[0]['token']
         and fields.get('stack_native_identity') == owners[0]['native_identity'], 'native stack closure missing')
    physical(worker, run, owners, services)
    return {'original_failure': copy.deepcopy(f), 'original_gate': copy.deepcopy(gate),
            'evidence': copy.deepcopy(evidence), 'contracts': contracts, 'stalled_task': stalled['name'],
            'root_id': stalled['agent_id'], 'purchase_id': snap['purchase']['id'],
            'card_id': snap['agentCard']['id'], 'transfer_id': snap['orgTransfer']['id'],
            'original_amount_cents': snap['orgTransfer']['amountCents'],
            'protected_database': services['database'], 'native_row_sha256': c.digest(stalled),
            'credit': {'execution': False, 'financial_release': False, 'database_cleanup': False}}


def build(state, old, new, evidence, root):
    import deploy_test_cycle as c
    need(not any(state.get(k) for k in ('running', 'live_failures', 'resume_phase', 'pending'))
         and not c.CANCEL.is_set() and state['phase'] in {'needs-focused-plan', 'failed-gates', 'final'},
         'quiescent repair boundary required')
    need(c.digest(old) == state['plan_digest'], 'old plan changed')
    from deploy_test_historical_custody import known
    need(not known(state, root) and not state.get('historical_no_retry_custody')
         and not state.get('historical_custody_import'),
         'existing cloud historical custody requires its original migration authority')
    row = original(state, evidence, root)
    need(row['original_gate']['name'] not in {g['name'] for g in new['gates']}, 'legacy execution still selected')
    names = set(row['contracts'])
    targets = [g for g in new['gates'] if g.get('native_cloud') is True and names <= set(g['checks'])]
    need(len(targets) == 1, 'all four original tasks must map to one ordinary cloud gate')
    row['target_gate'] = targets[0]['name']
    row['target_gate_contract'] = copy.deepcopy(targets[0])
    old_target, = [g for g in old['gates'] if g['name'] == row['target_gate']]
    normal_policy_contract(old_target, targets[0])
    from deploy_test_historical_custody import binding
    return {'kind': KIND, 'before_state_sha256': c.digest(state), 'old_plan': copy.deepcopy(old),
            'retained_cloud_scopes': cloud_scopes(state, old),
            'current_binding': binding(new, root), 'row': row}


def prepare(state, old, new, proof, root):
    need(proof == build(state, old, new, proof['row']['evidence'], root), 'migration proof changed')
    return proof['row']['original_gate']['name']


def verify(state, root):
    import deploy_test_cycle as c
    for proof in state.get('completed_local_custody_history', []):
        row = proof['row']; original_state = {**state, 'plan': proof['old_plan']}
        need(cloud_scopes(state, proof['old_plan'], proof['retained_cloud_scopes']) == proof['retained_cloud_scopes'],
             'original cloud obligations changed')
        need(original(original_state, row['evidence'], root) == {k: v for k, v in row.items() if k not in ('target_gate', 'target_gate_contract')},
             'original custody changed')
        need(row['original_gate']['name'] not in {g['name'] for g in state['plan']['gates']}, 'legacy task replay forbidden')
        gate, = [g for g in state['plan']['gates'] if g['name'] == row['target_gate']]
        from deploy_test_result import preserve_contract
        preserve_contract(row['target_gate_contract'], gate)
        need(gate.get('native_cloud') is True and set(row['contracts']) <= set(gate['checks']),
             'mapped peer coverage removed')


def qualifications(state, gate, root, *, current=None):
    import deploy_test_cycle as c
    from deploy_test_historical_custody import binding
    verify(state, root)
    if current is not None:
        from deploy_test_historical_custody import identical_inputs_binding
        need(current == identical_inputs_binding(state, root), 'identical-input qualification binding changed')
    current_binding = binding(state['plan'], root) if current is None else current
    result = {}
    for proof in state.get('completed_local_custody_history', []):
        row = proof['row']
        if row['target_gate'] == gate['name']:
            name = row['stalled_task']
            need(name not in result, 'duplicate mapped stall')
            result[name] = {'kind': KIND, 'disposition': 'NO_RETRY_CUSTODY',
                            'source': state['source'], 'current_binding': current_binding,
                            'original_failure': row['original_failure'], 'proof_sha256': c.digest(proof),
                            'current_execution': 'UNVERIFIED', 'current_financial_state': 'UNVERIFIED',
                            'original_amount_cents': row['original_amount_cents'], 'credit': copy.deepcopy(row['credit'])}
    return result


def completion(state, root):
    """All three peers still require an ordinary complete current-source cloud run."""
    import deploy_test_cycle as c
    verify(state, root)
    for proof in state.get('completed_local_custody_history', []):
        gate, = [g for g in state['plan']['gates'] if g['name'] == proof['row']['target_gate']]
        binding = c.full_pass_binding(state, gate, root=root)
        need(binding is not None and (binding.get('native_source') == state['source']
             or c.carried_pass(state, gate, root=root)),
             'mapped current peer coverage incomplete, failed, cancelled or stale')


def normal_policy_contract(old, new):
    """Only the documented strict-investigation0 -> ordinary-policy1 env transition."""
    from deploy_test_result import preserve_contract
    key = 'BENCHMARK_SKIP_AGENTCARD_RELEASE_STALL'
    need(old.get('env', {}).get(key) in ('0', '1') and new.get('env', {}).get(key) == '1',
         'ordinary sandbox warning policy must be explicit')
    comparison = copy.deepcopy(new)
    comparison['env'][key] = old['env'][key]
    preserve_contract(old, comparison)
    return comparison


def cloud_scopes(state, old, recorded=None):
    """Static original debt graph, without provider access or cleanup credit.

    A later legitimate successor may be latest; replay only its retained original
    ancestors for this static check. Ordinary isolated_admissions still validates
    the actual latest successor before execution and final native verification.
    """
    import deploy_test_cycle as c
    result = []
    for gate in old['gates']:
        entries = [e for e in state.get('reconciled_owners', {}).values()
                   if e.get('gate') == gate['name'] and e.get('purpose') == 'isolated-validation']
        if not entries:
            need(recorded is None or not any(r['gate'] == gate['name'] for r in recorded),
                 'original cloud debt graph removed')
            continue
        tokens = {e['token'] for e in entries}
        saved = next((r for r in recorded or [] if r['gate'] == gate['name']), None)
        if saved:
            need(tokens == {v['token'] for v in saved['bindings']}, 'original cloud ancestor membership changed')
        projected = state
        if saved is not None:
            projected = copy.copy(state)
            projected['attempts'] = [{'results': [r for r in a.get('results', [])
                                      if r.get('gate') != gate['name'] or r.get('token') in tokens]}
                                     for a in state['attempts']]
        _, bindings = c.bound_isolated_owner_roots(projected, gate)
        result.append({'gate': gate['name'], 'bindings': sorted(
            bindings, key=lambda b: b['token'])})
    return result
