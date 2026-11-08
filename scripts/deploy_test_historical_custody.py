"""Historical sandbox no-remint custody. Never current execution or financial credit."""
from __future__ import annotations

import copy
import json
from pathlib import Path
import re
import subprocess
import os

KIND = 'historical-agentcard-no-retry-v1'
DISPOSITION = 'NO_RETRY_CUSTODY'


def need(ok, message):
    if not ok:
        raise ValueError('historical custody: ' + message)


def task_contract(root, head, name):
    need(bool(re.fullmatch('[0-9a-f]{40}', head)), 'invalid original commit')
    result = subprocess.run(['git', 'show', head + ':agents/benchmarks/tasks.json'], cwd=root, capture_output=True)
    need(result.returncode == 0, 'original catalog unavailable')
    raw = result.stdout
    old = [t for t in json.loads(raw) if t['name'] == name]
    current = [t for t in json.loads((root / 'agents/benchmarks/tasks.json').read_bytes()) if t['name'] == name]
    need(len(old) == len(current) == 1 and old == current, 'catalog task changed')
    need(old[0].get('production_only', False) is False
         and 'agentcard-lifecycle-sandbox' in old[0].get('tags', []), 'not a sandbox catalog task')
    return old[0]


def known(state, root=None):
    """Discover obligations from immutable failures, even after active exclusions disappear."""
    import deploy_test_cycle as c
    root = c.ROOT if root is None else root
    found = {}
    catalogs = {}
    indexed = {r['original_failure']['id'] for r in state.get('historical_custody_history', [])}
    for f in state.get('failures', []):
        row = (f.get('worker_evidence') or {}).get('native_task') or {}
        if f.get('check', '').split('/', 1)[-1] != row.get('name'):
            continue
        path = (f.get('worker_evidence') or {}).get('path')
        resource = (f.get('rca') or {}).get('resource_skip')
        if resource and resource.get('reason_code') != c.AGENTCARD_RELEASE_STALL_CODE:
            continue  # Compute-quota semantics are not part of this custody protocol.
        confirmed = (f.get('rca') or {}).get('resource_skip', {}).get('reason_code') == c.AGENTCARD_RELEASE_STALL_CODE
        if not confirmed and f['id'] not in indexed and (path and Path(path).is_file() or c.agentcard_release_stall_task(row.get('name'))):
            head = (f.get('source') or {}).get('head', '')
            need(bool(re.fullmatch('[0-9a-f]{40}', head)), 'invalid original catalog source')
            if head not in catalogs:
                result = subprocess.run(['git', 'show', head + ':agents/benchmarks/tasks.json'], cwd=root, capture_output=True)
                need(result.returncode == 0, 'original catalog unavailable during discovery')
                catalogs[head] = json.loads(result.stdout)
            candidate = any(t.get('name') == row.get('name') and 'agentcard-lifecycle-sandbox' in t.get('tags', [])
                            for t in catalogs[head])
            if candidate:
                need(path and Path(path).is_file() and c.sha_file(path) == f['worker_evidence'].get('sha256'),
                     'original sandbox native bytes missing or changed')
            if path and Path(path).is_file():
                doc = c.read(Path(path))
                tasks = [t for t in doc.get('tasks', []) if t.get('name') == row.get('name')]
                confirmed = any(t.get('logs', {}).get('cloud_cleanup_evidence', {}).get(
                    'agentcard_release_stall_lifecycles') for t in tasks)
        if not confirmed and c.agentcard_release_stall_task(row.get('name')) and not Path(path or '').is_file():
            raise ValueError('historical custody: sandbox native evidence missing')
        if confirmed or f['id'] in indexed:
            need(f['id'] not in found, 'duplicate historical failure')
            found[f['id']] = f
    need(indexed <= found.keys(), 'historical failure removed')
    return found


def native_closure(path, root):
    """Replay the existing native audit format; never contact the provider."""
    import deploy_test_cycle as c
    from deploy_test_native_cleanup import fleet_audit_root, fleet_ownership_root, fields
    fleet = path.parent.parent
    life = c.read(fleet / '_batch/lifecycle.json')
    token = life['fleet_owner_token']
    need(re.fullmatch('[0-9a-f]{32}', token) and life['status'] == 'verified'
         and life['hub_publication_failed'] is False and life['workspace_root'] == str(root)
         and life['run_id'] == fleet.name, 'native fleet not terminal')
    local, canonical = fleet / 'teardown-ownership', fleet_audit_root(root) / token
    with c.source_module(Path(__file__).with_name('cloudbench-retained-successor.py')) as library:
        digest = library.tree_digest(local)
        need(library.tree_digest(canonical) == digest == life['audit_sha256']
             and fields((local / 'source-audit').read_bytes()) == {'path': str(canonical), 'sha256': digest}, 'native audit changed')
    meta = fields((local / 'meta').read_bytes())
    need(meta.get('status') == 'provider-teardown-verified' and meta.get('fleet_owner_token') == token
         and meta.get('run_id') == fleet.name and meta.get('workspace_root') == str(root), 'native owner mismatch')
    owner = fleet_ownership_root(root) / token
    need(not owner.exists() and not owner.is_symlink(), 'native owner still registered')
    for pid in [fleet.name.rsplit('-', 1)[-1], meta.get('hub_pid')]:
        if pid:
            need(str(pid).isdigit() and int(pid) > 1 and not Path('/proc', str(pid)).exists(), 'native owner active or unknown')
    return {'fleet': str(fleet), 'audit_sha256': digest, 'lifecycle_sha256': c.sha_file(fleet / '_batch/lifecycle.json')}


def historical(state, failure, root):
    """Re-read exact native bytes and join their resource/cleanup identities."""
    import deploy_test_cycle as c
    from deploy_failure_report import decision
    f = copy.deepcopy(failure)
    saved = [r for r in state.get('historical_custody_history', [])
             if r['original_failure']['id'] == f['id']]
    if saved:
        original = saved[0]['original_failure']
        if f != original:
            resolved = copy.deepcopy(original)
            entry = {k: v for k, v in original['rca'].items() if k != 'post_merge'}
            entry['repair_agent'] = (f.get('rca') or {}).get('repair_agent')
            resolved.update(rca={**entry, 'resolved_post_merge': original['rca'].get('post_merge')},
                            disposition=decision(entry))
            need(f == resolved and resolved['disposition'] == 'delegated / waived', 'original failure changed')
        f = copy.deepcopy(original)
    need(f.get('native_result') == 'FAIL' and f.get('complete') is True, 'incomplete original failure')
    e, rca = f['worker_evidence'], f['rca']
    for key in ('id', 'source', 'check', 'command', 'native_result'):
        need(rca.get(key) == f.get(key), 'RCA binding changed: ' + key)
    path = Path(e['path'])
    need(path.is_absolute() and path.resolve() == path and path.is_file() and not path.is_symlink(), 'invalid native path')
    need(c.sha_file(path) == e['sha256'], 'native bytes changed')
    doc = c.read(path)
    rows = [t for t in doc['tasks'] if t.get('name') == f['check'].split('/', 1)[1]]
    need(len(rows) == 1, 'ambiguous native task')
    t = rows[0]
    need(all(t.get(k) == v for k, v in e['native_task'].items()), 'native row changed')
    need(t.get('execution_provenance', {}).get('base_sha') == f['source']['head'], 'native source changed')
    need(t.get('passed') is False and t.get('cleanup_failure', 'missing') is None
         and t.get('context_violations') == [], 'native task/cleanup unknown')
    task = task_contract(root, f['source']['head'], t['name'])
    cleanup = t['logs']['cloud_cleanup_evidence']
    snap = cleanup['agentcard_release_stall_lifecycles'][t['agent_id']]
    need(cleanup.get('errors') == [] and cleanup.get('root_agent_id') == t['agent_id'] == snap['agentId'], 'cleanup/root mismatch')
    if 'agentcard_release_stall_lifecycle' in t['logs']:
        need(t['logs']['agentcard_release_stall_lifecycle'] == snap, 'two native snapshots disagree')
    final = cleanup['final']
    need(final.get('root_deleted') is True and final.get('unsealed_tree_agent_ids') == []
         and t['agent_id'] in final.get('tree_agent_ids', []), 'native root not sealed')
    for session in final['browser_sessions']:
        need(any(r.get('provider') == session.get('provider') and r.get('session_id') == session.get('session_id')
                 and r.get('status') in (200, 204, 404, 410) for r in cleanup.get('provider_receipts', [])), 'browser cleanup unknown')
    card, transfer, purchase, funding = (snap[k] for k in ('agentCard', 'orgTransfer', 'purchase', 'walletFunding'))
    amount = transfer['amountCents']
    need(all(isinstance(v, str) and v for v in (t['agent_id'], card.get('id'), transfer.get('id'), purchase.get('id'))),
         'missing resource identity')
    need(type(amount) is int and amount > 0 and type(transfer['transferredCents']) is int
         and transfer['transferredCents'] == amount and type(transfer['releasedCents']) is int
         and transfer['releasedCents'] == 0 and transfer['livemode'] is False
         and transfer['status'] == 'consumed' and card['status'] == 'CLOSED'
         and type(card['balanceCents']) is int and card['balanceCents'] == 0
         and ('livemode' not in card or card['livemode'] is False)
         and purchase['status'] == 'HELD' and funding['status'] == 'RECLAIMING'
         and transfer['cardId'] == purchase['cardId'] == card['id']
         and funding['providerTransferId'] == transfer['id']
         and snap['stripeHold']['livemode'] is False and snap['stripeRefund'] is None, 'not a confirmed sandbox release stall')
    matches = [p for p in final['purchase_cleanup'] if p.get('purchase_id') == purchase['id']]
    need(len(matches) == 1, 'missing/ambiguous final purchase')
    p = matches[0]
    need(all(p.get(k) == v for k, v in {'agent_id': t['agent_id'], 'card_id': card['id'],
         'provider_transfer_id': transfer['id'], 'total_cents': amount, 'status': 'HELD',
         'funding_status': 'RECLAIMING'}.items()), 'final purchase join changed')
    # Revalidate the original recorded adapter closure, independently of financial state.
    adapter = c.read(Path(f['worker_result']))
    need(adapter.get('source') == f['source'] and adapter.get('gate') == f['gate']
         and adapter.get('cleanup_complete') is True and adapter.get('complete') is True
         and adapter.get('evidence', {}).get(t['name']) == e, 'original adapter closure/evidence changed')
    if f['disposition'] == c.RESOURCE_SKIP:
        c.validate_resource_skip(rca, f)
        warnings = [w for w in [*state.get('resource_warnings', []), *state.get('superseded_resource_warnings', [])]
                    if w['id'] == f['id']]
        if saved:
            warnings.append(saved[0]['authority']['original_warning'])
        need(warnings and all(w['native_row'] == e['native_task'] and w['confirmation'] == rca['resource_skip']
                             and w['receipt_sha256'] == e['sha256'] for w in warnings), 'original warning changed')
        original_warning = (saved[0]['authority']['original_warning'] if saved else
                            next((w for w in warnings if w['source'] == f['source']), warnings[0]))
        authority = {'kind': 'original_resource_warning', 'confirmation': rca['resource_skip'],
                     'original_warning': copy.deepcopy(original_warning)}
    else:
        need(t['benchmark_status'] == 'FAILED' and decision(rca) == 'pending post-merge'
             and f['disposition'] == 'pending post-merge' and not rca.get('resource_skip'), 'independent failure lacks canonical pending repair')
        pending = [p for p in state.get('pending_post_merge', []) if p['id'] == f['id']]
        resolved = failure != f
        need(resolved or len(pending) == 1 and pending[0]['packet'] == rca['post_merge'], 'pending repair lost')
        authority = {'kind': 'canonical_pending_repair', 'packet': rca['post_merge']}
    return {'original_failure': f, 'native_sha256': e['sha256'], 'native_row_sha256': c.digest(t),
            'adapter_sha256': c.sha_file(f['worker_result']), 'snapshot_sha256': c.digest(snap),
            'task_sha256': c.digest(task), 'root_id': t['agent_id'], 'purchase_id': purchase['id'],
            'card_id': card['id'], 'transfer_id': transfer['id'], 'original_amount_cents': amount,
            'authority': authority, 'native_closure': native_closure(path, root)}


def binding(plan, root):
    import deploy_test_cycle as c
    need(plan['source'] == c.source(root), 'current source not frozen')
    c.validate_plan(plan, root)
    return {'source': plan['source'], 'plan_digest': c.digest(plan), 'environment': c.environment_digest(),
            'input_fingerprints': c.input_fingerprints(plan, root)}


def build(state, old, new, root):
    import deploy_test_cycle as c
    need(c.digest(old) == state['plan_digest'], 'old plan mismatch')
    need(not c.CANCEL.is_set() and not c.retained_owners(state, [g['name'] for g in old['gates']])
         and not any(state.get(k) for k in ('running', 'live_failures', 'resume_phase', 'pending')), 'active/unknown coordinator')
    rows = [historical(state, f, root) for f in known(state, root).values()]
    need(rows, 'no historical stalls')
    for key in ('root_id', 'card_id', 'transfer_id', 'purchase_id'):
        need(len({r[key] for r in rows}) == len(rows), 'borrowed resource identity')
    gates = {g['name']: g for g in new['gates']}
    for r in rows:
        f = r['original_failure']
        need(f['check'].split('/', 1)[1] in gates[f['gate']]['checks'], 'protected task removed')
    return {'kind': KIND, 'before_state_sha256': c.digest(state), 'old_plan_digest': c.digest(old),
            'current_binding': binding(new, root), 'cases': rows}


def prepare(state, old, new, proof, root):
    import deploy_test_cycle as c
    expected = build(state, old, new, root)
    need(c.digest(proof) == c.digest(expected), 'proof differs from exact native/current binding')
    return copy.deepcopy(proof['cases'])


def apply(state, rows, root):
    current = binding(state['plan'], root)
    state['historical_no_retry_custody'] = [dict(kind=KIND, disposition=DISPOSITION, **r,
        current_binding=current, current_execution='UNVERIFIED', current_financial_state='UNVERIFIED',
        credit={'test_execution': False, 'assertions': False, 'financial_release': False}) for r in rows]
    history = state.setdefault('historical_custody_history', [])
    for r in rows:
        if r not in history:
            history.append(copy.deepcopy(r))


IMPORT_KIND = 'historical-agentcard-no-retry-import-v1'


def prepare_import(state, donor_path, directory, root, *, donor_sha256):
    """Bind exact donor obligations to a pristine independent cycle; never copy files."""
    import deploy_test_cycle as c
    fresh = c.initialize(state['plan'], root)
    need(c.digest(state) == c.digest(fresh), 'import requires a normally initialized fresh cycle')
    directory, donor_path = Path(directory), Path(donor_path)
    for path in (directory, donor_path):
        need(path.is_absolute() and path.resolve() == path and path.is_relative_to(root / '.context')
             and not path.is_symlink(), 'noncanonical import path')
    need(donor_path.name == 'cycle.json' and donor_path.is_file()
         and donor_path != directory / 'cycle.json', 'invalid independent donor index')
    need(not (directory / 'cycle.json').is_symlink(), 'symlinked target cycle')
    need(not (directory / 'attempts').exists() and not (directory / 'attempts').is_symlink(),
         'import target has an existing attempt namespace')
    donor_sha = c.sha_file(donor_path)
    need(isinstance(donor_sha256, str) and re.fullmatch('[0-9a-f]{64}', donor_sha256)
         and donor_sha == donor_sha256, 'donor bytes differ from approved hash')
    donor = c.bounded_read(donor_path, 'historical donor index')
    need(not c.CANCEL.is_set() and not any(donor.get(k) for k in
         ('running', 'live_failures', 'resume_phase', 'pending')), 'active/unknown donor coordinator')
    found = known(donor, root)
    history = donor.get('historical_custody_history', [])
    ids = [row['original_failure']['id'] for row in history]
    need(ids and len(ids) == len(set(ids)) and set(ids) == set(found), 'donor custody inventory differs')
    need(not any(w['id'] in ids for w in donor.get('resource_warnings', []))
         and not any(found[i]['check'] in donor.get('skips', {}) for i in ids), 'mixed donor waiver and custody')
    for identifier in ids:
        for raw in (found[identifier]['worker_evidence']['path'], found[identifier]['worker_result']):
            path = Path(raw)
            need(path.is_absolute() and path.resolve() == path and path.is_file()
                 and path.is_relative_to(root / '.context') and not path.is_symlink(), 'noncanonical native/adapter file')
    rows = [historical(donor, found[identifier], root) for identifier in ids]
    need(c.digest(rows) == c.digest(history), 'donor native custody history changed')
    for key in ('root_id', 'card_id', 'transfer_id', 'purchase_id'):
        need(len({row[key] for row in rows}) == len(rows), 'borrowed resource identity')
    gates = {gate['name']: gate for gate in state['plan']['gates']}
    for row in rows:
        failure = row['original_failure']
        gate = gates.get(failure['gate'], {})
        need(failure['check'].split('/', 1)[1] in gate.get('checks', [])
             and gate.get('case_protocol') is True, 'protected task or case protocol missing')
    need(c.sha_file(donor_path) == donor_sha, 'donor index changed during preparation')
    return {'kind': IMPORT_KIND, 'donor_path': str(donor_path), 'donor_sha256': donor_sha,
            'target_state': str(directory / 'cycle.json'), 'before_state_sha256': c.digest(fresh),
            'current_binding': binding(state['plan'], root), 'cases': rows,
            'failures': [copy.deepcopy(found[identifier]) for identifier in ids],
            'pending_post_merge': [copy.deepcopy(p) for p in donor.get('pending_post_merge', []) if p['id'] in ids]}


def admit_import(state, proof, donor_path, directory, root, *, donor_sha256):
    """Revalidate everything before one state publication by the existing CLI writer."""
    import deploy_test_cycle as c
    fresh = c.initialize(state['plan'], root)
    expected = prepare_import(fresh, donor_path, directory, root, donor_sha256=donor_sha256)
    need(c.digest(proof) == c.digest(expected), 'import proof differs from exact donor/current binding')
    candidate = copy.deepcopy(fresh)
    candidate['failures'] = copy.deepcopy(expected['failures'])
    candidate['pending_post_merge'] = copy.deepcopy(expected['pending_post_merge'])
    apply(candidate, expected['cases'], root)
    candidate['historical_custody_import'] = {'kind': IMPORT_KIND, 'proof_sha256': c.digest(expected),
        'donor_path': expected['donor_path'], 'donor_sha256': expected['donor_sha256']}
    verify(candidate, root)
    if state.get('historical_custody_import'):
        need(c.digest(state) == c.digest(candidate), 'import replay changed or cycle is no longer fresh')
    else:
        need(c.digest(state) == c.digest(fresh), 'import requires a normally initialized fresh cycle')
    state.clear(); state.update(candidate)


def identical_inputs_binding(state, root):
    """Validate an old FULL receipt during refresh, without rebinding its native source."""
    import deploy_test_cycle as c
    c.validate_plan(state['plan'], root)
    need(state['plan']['source'] == state['source'] and c.digest(state['plan']) == state['plan_digest']
         and c.environment_digest() == state['environment']
         and c.input_fingerprints(state['plan'], root) == state['input_fingerprints'],
         'old FULL receipt inputs changed')
    return {k: state[k] for k in ('source', 'plan_digest', 'environment', 'input_fingerprints')}


def qualifications(state, gate, root, *, current=None):
    import deploy_test_cycle as c
    found = known(state, root)
    records = state.get('historical_no_retry_custody', [])
    expected = {}
    current_binding = None
    for r in records:
        f = r['original_failure']
        if f['gate'] != gate['name']:
            continue
        if current_binding is None:
            current_binding = binding(state['plan'], root) if current is None else current
        need(f['id'] in found, 'custody lacks original failure')
        native = historical(state, found[f['id']], root)
        exact = dict(kind=KIND, disposition=DISPOSITION, **native, current_binding=current_binding,
                     current_execution='UNVERIFIED', current_financial_state='UNVERIFIED',
                     credit={'test_execution': False, 'assertions': False, 'financial_release': False})
        need(c.digest(r) == c.digest(exact) and native in state.get('historical_custody_history', []), 'custody proof/history changed')
        if f['gate'] == gate['name']:
            check = f['check'].split('/', 1)[1]
            need(check in gate['checks'] and check not in expected, 'duplicate/removed custody check')
            expected[check] = {**r, 'source': state['source']}
    return expected


def guard(state, gate, root, legacy=None, *, current=None):
    """No fallback allocation when a known historical obligation loses its proof."""
    legacy = {} if legacy is None else legacy
    custody = qualifications(state, gate, root, current=current)
    for f in known(state, root).values():
        if f['gate'] != gate['name']:
            continue
        case = f['check'].split('/', 1)[1]
        need(case in gate['checks'], 'protected task removed')
        need(case in custody or case in legacy, 'known stall has no current no-retry qualification: ' + case)
    need(not set(custody) & set(legacy), 'mixed waiver and custody')
    return custody


def verify(state, root):
    import deploy_test_cycle as c
    if not (known(state, root) or state.get('historical_no_retry_custody') or state.get('historical_custody_history')):
        return
    gates = {g['name']: g for g in state['plan']['gates']}
    for f in known(state, root).values():
        need(f['gate'] in gates and f['check'].split('/', 1)[1] in gates[f['gate']]['checks'], 'known historical task removed from plan')
    for gate in state['plan']['gates']:
        # Caller supplies legacy qualifications without recursively entering custody.
        guard(state, gate, root, c.reuse_qualifications(state, gate, include_custody=False, root=root))


def state_identity(state):
    import deploy_test_cycle as c
    return c.digest({k: state.get(k) for k in ('source', 'plan_digest', 'environment', 'input_fingerprints',
                    'historical_no_retry_custody', 'historical_custody_history')})


def admission(request, root):
    import deploy_test_cycle as c
    default = root / '.context/deploy-pipeline/cycle.json'
    locator = request.get('custody_state')
    request_path = Path(os.environ.get('DEPLOY_GATE_REQUEST', ''))
    if (request_path.name == 'request.json' and len(request_path.parents) > 4
            and request_path.parents[3].name == 'attempts'):
        owner_state = request_path.parents[4] / 'cycle.json'
        need(locator is not None and Path(locator).resolve() == owner_state.resolve(), 'missing request-owned custody locator')
    if default.exists():
        need(locator is not None and Path(locator).resolve() == default.resolve(), 'missing canonical custody locator')
    if locator is None:
        return  # standalone disposable requests with no canonical cycle have no recorded obligations
    path = Path(locator)
    need(path.is_absolute() and path.resolve() == path and path.is_relative_to(root / '.context')
         and path.name == 'cycle.json' and not path.is_symlink(), 'invalid custody state locator')
    state = c.read(path)
    need(request.get('custody_child_environment') == environment_identity(os.environ), 'admission environment changed')
    need(state_identity(state) == request.get('custody_state_sha256') and state['source'] == request['source'], 'custody state changed')
    gate = next(g for g in state['plan']['gates'] if g['name'] == request['gate'])
    need(c.source(root) == state['source'] and c.digest(state['plan']) == state['plan_digest'], 'admission source/plan changed')
    need(request.get('custody_runtime') == runtime_identity(root), 'admission runtime files changed')
    c.validate_plan(state['plan'], root)
    # The child has explicit DEPLOY_* additions. Validate those against its launch hash,
    # then replay parent fingerprints using the bound parent environment digest.
    need(c.input_fingerprints(state['plan'], root, environment=state['environment']) == state['input_fingerprints'],
         'admission input fingerprint changed')
    expected = c.reuse_qualifications(state, gate, root=root, include_custody=False)
    current = {k: state[k] for k in ('source', 'plan_digest', 'environment', 'input_fingerprints')}
    expected.update(guard(state, gate, root, expected, current=current))
    need(request['skips'] == expected and request['checks'] == [x for x in gate['checks'] if x not in expected], 'admission inventory/qualification changed')


def environment_identity(environ):
    import deploy_test_cycle as c
    transient = {'_', 'PWD', 'OLDPWD', 'SHLVL', 'INVOCATION_ID', 'JOURNAL_STREAM', 'SYSTEMD_EXEC_PID', 'CODEX_TOOL_CALL_ID'}
    return c.digest({k: v for k, v in environ.items() if k not in transient})


def runtime_identity(root):
    import deploy_test_cycle as c
    return {name: c.runtime_config_sha256(root / name) for name in
            ('.env', 'env.sh', 'back-end/.env', 'agents/.env', 'agents/.env.benchmark-temporal',
             'front-end/.env', 'front-end/.env.local') if (root / name).is_file()}
