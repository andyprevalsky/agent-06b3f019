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


# Locator decisions made before the cloud request namespace exists. Each has a stable reason
# code so deploy_test_cloud can publish a typed no-admission receipt; any other error stays generic.
ADMISSION_REFUSALS = {
    'request-locator-mismatch': 'historical custody: missing request-owned custody locator',
    'canonical-locator-missing': 'historical custody: missing canonical custody locator',
    'canonical-custody-unverifiable': 'historical custody: canonical custody history cannot be verified',
    'canonical-custody-uncovered': 'historical custody: canonical custody obligations are not covered by the request-owned ledger',
    'canonical-cycle-active': 'historical custody: canonical cycle is still active',
    'canonical-cycle-owns-source': 'historical custody: canonical cycle owns the requested source',
}


class AdmissionRefusal(ValueError):
    """A custody locator refusal raised by admission() before any allocation."""

    def __init__(self, code, detail=None):
        """Carry the stable reason code; the message is the exact registered refusal text."""
        super().__init__(ADMISSION_REFUSALS[code])
        self.reason_code = code
        self.detail = detail


def refuse(ok, code):
    """Raise the typed pre-allocation refusal for ``code`` unless ``ok``."""
    if not ok:
        raise AdmissionRefusal(code)


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
    counts = {}
    indexed = {r['original_failure']['id'] for r in state.get('historical_custody_history', [])}
    for transfer in state.get('historical_custody_transfers', []):
        ids = transfer['protected_failure_ids']
        need(isinstance(ids, list) and ids and all(isinstance(value, str) and value for value in ids)
             and len(set(ids)) == len(ids), 'invalid transferred failure identities')
        indexed.update(ids)
    for f in state.get('failures', []):
        if 'id' in f:
            counts[f['id']] = counts.get(f['id'], 0) + 1
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
    need(all(counts[key] == 1 for key in found), 'duplicate historical failure identity')
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


# Provider-wide observations inside a stall snapshot. They count every same-amount card/transfer for the
# shared benchmark cardholder created since the purchase, so the concurrent identical lifecycles of one smoke
# (seven payment tasks, plus other devboxes' fleets) change them between the end-of-task and cleanup
# snapshots (PR #1784 cycle bn8: 7 vs 12). Every identity, status and lifecycle-scoped count must still agree.
PROVIDER_WIDE_COUNTERS = ('agentCardProviderCardCount', 'agentCardProviderTransferCount',
                          'agentCardProviderUnlinkedTransferCount')


def lifecycle_view(snapshot):
    """A stall snapshot without its provider-wide counters; everything else is compared exactly."""
    view = copy.deepcopy(snapshot)
    integrity = view.get('integrity') if isinstance(view, dict) else None
    if isinstance(integrity, dict):
        for key in PROVIDER_WIDE_COUNTERS:
            integrity.pop(key, None)
    return view


def warning_only_context(violations):
    """No error-severity context violation. run_benchmark fails a row only on error severity;
    a warning (e.g. a whitespace-only assistant message) says nothing about payment cleanup.
    Anything malformed or of another severity stays unknown."""
    return isinstance(violations, list) and all(
        isinstance(v, dict) and v.get('severity') == 'warning' for v in violations)


def stall_lifecycle(cleanup, root_id):
    """The recorded release-stall lifecycle and the sealed-tree agent that owns its purchase.

    run_benchmark keys each lifecycle by the agent of a still-pending purchase: the root, or the
    browser sub-agent that requested the card (agent-payment-idempotent-abandonment, PR #1972).
    It writes the map before judging the stall; a rejected stall is recorded in cleanup errors,
    which callers require to be empty. Custody binds exactly one purchase, so exactly one
    self-identified, well-formed snapshot is required. Anything else refuses with a typed
    error instead of guessing an owner or leaving a second stalled purchase unbound.
    """
    need(isinstance(root_id, str) and bool(root_id), 'invalid native root identity')
    lifecycles = cleanup.get('agentcard_release_stall_lifecycles')
    need(isinstance(lifecycles, dict) and lifecycles, 'no release-stall lifecycle snapshot')
    need(len(lifecycles) == 1, 'ambiguous release-stall lifecycles')
    (owner, snap), = lifecycles.items()
    need(isinstance(snap, dict) and snap.get('agentId') == owner, 'release-stall lifecycle owner mismatch')
    need(all(isinstance(snap.get(k), dict) for k in ('agentCard', 'orgTransfer', 'purchase', 'walletFunding', 'stripeHold')),
         'malformed release-stall lifecycle')
    return owner, snap


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
         and warning_only_context(t.get('context_violations')), 'native task/cleanup unknown')
    task = task_contract(root, f['source']['head'], t['name'])
    cleanup = t['logs']['cloud_cleanup_evidence']
    owner, snap = stall_lifecycle(cleanup, t['agent_id'])
    need(cleanup.get('errors') == [] and cleanup.get('root_agent_id') == t['agent_id'], 'cleanup/root mismatch')
    if 'agentcard_release_stall_lifecycle' in t['logs']:
        need(lifecycle_view(t['logs']['agentcard_release_stall_lifecycle']) == lifecycle_view(snap),
             'two native snapshots disagree')
    final = cleanup['final']
    tree = final.get('tree_agent_ids')
    need(final.get('root_deleted') is True and final.get('unsealed_tree_agent_ids') == []
         and isinstance(tree, list) and t['agent_id'] in tree and owner in tree, 'native root not sealed')
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
    need(all(p.get(k) == v for k, v in {'agent_id': owner, 'card_id': card['id'],
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
        # A confirmed stall can end natively FAILED or ERROR (reconciliation raised after the final
        # lifecycle read failed, PR #2014 smoke): both are complete non-passing rows; refusing custody
        # would leave only a rerun that mints another card.
        need(t['benchmark_status'] in ('FAILED', 'ERROR') and decision(rca) == 'pending post-merge'
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


def pending_shapes(state, old):
    """Refuse malformed pending metadata before legacy owner/discovery readers run."""
    pending = state.get('pending', [])
    need(isinstance(pending, list) and all(isinstance(key, str) and key for key in pending),
         'invalid pending identities')
    if not pending:
        return
    need(isinstance(state.get('pending_execution_contracts', {}), dict), 'malformed pending contract history')
    need(isinstance(old.get('gates'), list)
         and all(isinstance(g, dict) and isinstance(g.get('name'), str)
                 and isinstance(g.get('checks'), list) for g in old['gates']),
         'malformed pending gate inventory')
    need(isinstance(state.get('failures'), list) and isinstance(state.get('attempts'), list),
         'malformed pending failure/attempt inventory')
    for failure in state['failures']:
        need(isinstance(failure, dict) and isinstance(failure.get('check'), str)
             and isinstance(failure.get('gate'), str), 'malformed pending failure identity')
        evidence, rca = failure.get('worker_evidence'), failure.get('rca')
        need((evidence is None or isinstance(evidence, dict)) and (rca is None or isinstance(rca, dict)),
             'malformed pending failure evidence')
        if isinstance(evidence, dict) and 'native_task' in evidence:
            need(isinstance(evidence['native_task'], dict), 'malformed pending native task')
        if isinstance(rca, dict) and 'resource_skip' in rca:
            need(isinstance(rca['resource_skip'], dict), 'malformed pending resource evidence')
    for attempt in state['attempts']:
        need(isinstance(attempt, dict) and isinstance(attempt.get('results'), list),
             'malformed pending attempt')
        for receipt in attempt['results']:
            need(isinstance(receipt, dict) and isinstance(receipt.get('gate'), str)
                 and ('cases' not in receipt or isinstance(receipt['cases'], dict)),
                 'malformed pending receipt')


def pending_rca(state, old, protected):
    """Bind complete pending failures with recorded cleanup and no retained producer."""
    import deploy_test_cycle as c
    pending = state.get('pending', [])
    need(isinstance(pending, list) and all(isinstance(key, str) and key for key in pending)
         and len(pending) == len(set(pending)), 'invalid pending identities')
    if not pending:
        return []
    need(state.get('phase') == 'triage' and state.get('ready') is False
         and 'live_failures' not in state, 'pending RCA requires quiescent triage')
    gates = {gate['name']: gate for gate in old['gates']}
    need(len(gates) == len(old['gates']), 'duplicate pending gate contract')
    rows = []
    for key in pending:
        matches = [f for f in state.get('failures', []) if isinstance(f, dict) and f.get('id') == key]
        need(len(matches) == 1 and key not in protected, 'missing/duplicate/protected pending occurrence')
        f = matches[0]
        gate = gates.get(f.get('gate'), {})
        # Semantic execution can create compute sessions. Admission requires its recorded
        # complete gate/stack cleanup below, never a claim of universal resource absence.
        # Unknown categories stay closed; no occurrence-ID exception is made.
        need(gate.get('category') in c.QUICK | {'semantic-stack'} and not gate.get('native_cloud')
             and gate.get('worker_transport') != 'benchmark-cloud-cli', 'pending gate is not admitted for nonfinancial RCA')
        check = f.get('check', '').partition('/')[2]
        need(f.get('check') == f.get('gate', '') + '/' + check and check in gate.get('checks', [])
             and isinstance(f.get('source'), dict) and f.get('complete') is True and f.get('native_result') == 'FAIL', 'incomplete/unbound pending failure')
        need(isinstance(f.get('worker_result'), str) and f['worker_result'],
             'malformed pending adapter path')
        path = Path(f['worker_result'])
        need(path.is_absolute() and path.resolve() == path and path.is_file() and not path.is_symlink(),
             'pending adapter missing or noncanonical')
        adapter = c.bounded_read(path, 'pending adapter')
        need(isinstance(adapter, dict) and isinstance(adapter.get('cases'), dict)
             and isinstance(adapter.get('evidence'), dict), 'malformed pending adapter containers')
        receipts = [r for a in state.get('attempts', []) for r in a.get('results', [])
                    if r.get('worker_result') == str(path) and r.get('source') == f['source']
                    and r.get('gate') == f['gate']]
        need(len(receipts) == 1, 'missing/duplicate pending receipt')
        receipt = receipts[0]
        need(receipt.get('executed') is True and receipt.get('complete') is True
             and type(receipt.get('native_exit')) is int and receipt['native_exit'] == 1
             and receipt.get('status') == 'FAIL' and receipt.get('timed_out') is False
             and receipt.get('cancelled') is False and receipt.get('lingering_group') is False
             and ('interrupted' not in receipt or receipt['interrupted'] is False)
             and ('reused' not in receipt or receipt['reused'] is False)
             and ('source_unchanged' not in receipt or receipt['source_unchanged'] is True)
             and receipt.get('cases', {}).get(check) == 'FAIL'
             and not c.receipt_owner(f['gate'], receipt), 'pending receipt incomplete or owner unknown')
        need(all(adapter.get(k) == receipt.get(k) for k in ('token', 'source', 'gate'))
             and isinstance(adapter.get('token'), str) and bool(adapter['token'])
             and adapter.get('complete') is True and adapter.get('cleanup_complete') is True
             and adapter.get('source_unchanged') is True
             and type(adapter.get('native_exit')) is int and adapter['native_exit'] == 1
             and adapter.get('interrupted') is False and adapter.get('reused') is False
             and all(key not in adapter or adapter[key] is False
                     for key in ('timed_out', 'cancelled', 'lingering_group'))
             and ('status' not in adapter or adapter['status'] == 'FAIL') and not adapter.get('cleanup_owner')
             and adapter.get('cases', {}).get(check) == 'FAIL'
             and adapter.get('evidence', {}).get(check) == f.get('worker_evidence'),
             'pending adapter is incomplete or differs from failure/receipt')
        need(f.get('command') == receipt.get('command'), 'pending original command changed')
        original_files = {}
        if f['source'] == state['source']:
            need(f.get('command') == gate.get('command'), 'pending gate command changed')
            request = {'token': receipt['token'], 'source': f['source'],
                       'gate': f['gate'], 'checks': gate['checks']}
            for field in ('worker_recipe', 'worker_root'):
                if field in gate:
                    request[field] = gate[field]
        else:
            # A carried failure still belongs to its original execution, not this plan's source.
            # Use the complete saved producer request and exact retained receipt; never ancestry.
            documents = {}
            for name in ('request', 'receipt'):
                file = path.with_name(name + '.json')
                need(file.is_file() and not file.is_symlink() and file.resolve() == file,
                     'original pending request/receipt missing')
                documents[name] = c.bounded_read(file, 'original pending ' + name)
                need(isinstance(documents[name], dict), 'malformed original pending document')
                original_files[name + '_sha256'] = c.sha_file(file)
            request = documents['request']
            binding = receipt.get('execution_binding')
            attempts = [a for a in state['attempts'] if any(r is receipt for r in a['results'])]
            need(documents['receipt'] == receipt and len(attempts) == 1
                 and attempts[0].get('source') == f['source']
                 and request.get('phase') == attempts[0].get('phase') == f.get('phase')
                 and all(request.get(k) == receipt.get(k) for k in ('token', 'source', 'gate'))
                 and isinstance(request.get('checks'), list) and request['checks']
                 and all(isinstance(v, str) and v for v in request['checks'])
                 and len(request['checks']) == len(set(request['checks']))
                 and request.get('skips') == {} and check in request['checks']
                 and isinstance(request.get('worker_recipe'), dict)
                 and isinstance(request.get('worker_root'), str) and request['worker_root']
                 and isinstance(binding, dict)
                 and all(isinstance(binding.get(k), str) and re.fullmatch('[0-9a-f]{64}', binding[k])
                         for k in ('contract_digest', 'input_fingerprint', 'environment')),
                 'original pending execution binding changed')
            saved = state.get('pending_execution_contracts', {}).get(key)
            if saved is None:
                # Recover only byte-equivalent recorded contract fields, proven by the native digest.
                original_gate = copy.deepcopy(gate)
                original_gate['command'] = copy.deepcopy(receipt['command'])
                original_gate['worker_recipe'] = copy.deepcopy(request['worker_recipe'])
                original_gate['worker_root'] = request['worker_root']
                saved = {'source': copy.deepcopy(f['source']), 'gate': original_gate}
            need(isinstance(saved, dict) and saved.get('source') == f['source']
                 and isinstance(saved.get('gate'), dict)
                 and c.digest(saved['gate']) == binding['contract_digest']
                 and saved['gate'].get('name') == f['gate']
                 and saved['gate'].get('command') == f['command']
                 and saved['gate'].get('checks') == request['checks']
                 and saved['gate'].get('worker_recipe') == request['worker_recipe']
                 and saved['gate'].get('worker_root') == request['worker_root'],
                 'original pending contract digest changed')
            original_files['execution_contract'] = copy.deepcopy(saved)
        c.validate_result(adapter, request, receipt['native_exit'])
        need(adapter['cases'] == receipt['cases'], 'pending native grades differ from receipt')
        rows.append({'id': key, 'adapter_sha256': c.sha_file(path), 'receipt_sha256': c.digest(receipt),
                     **original_files})
    return rows


def build(state, old, new, root):
    import deploy_test_cycle as c
    pending_shapes(state, old)
    need(c.digest(old) == state['plan_digest'] and old['source'] == state['source'], 'old plan mismatch')
    need(not c.CANCEL.is_set() and not c.retained_owners(state, [g['name'] for g in old['gates']])
         and not any(state.get(k) for k in ('running', 'live_failures', 'resume_phase')), 'active/unknown coordinator')
    protected = known(state, root)
    pending = pending_rca(state, old, protected)
    rows = [historical(state, f, root) for f in protected.values()]
    need(rows, 'no historical stalls')
    for key in ('root_id', 'card_id', 'transfer_id', 'purchase_id'):
        need(len({r[key] for r in rows}) == len(rows), 'borrowed resource identity')
    gates = {g['name']: g for g in new['gates']}
    for r in rows:
        f = r['original_failure']
        need(f['check'].split('/', 1)[1] in gates[f['gate']]['checks'], 'protected task removed')
    return {'kind': KIND, 'before_state_sha256': c.digest(state), 'old_plan_digest': c.digest(old),
            'current_binding': binding(new, root), 'cases': rows, **({'pending_rca': pending} if pending else {})}


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


LEGACY_IMPORT_KIND = 'historical-agentcard-no-retry-import-v1'


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
    validate_donor_rows(donor, root)
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
    transfer_proof = build(donor, donor['plan'], state['plan'], root)
    need(c.digest(transfer_proof['cases']) == c.digest(rows), 'donor transfer inventory differs')
    need(c.sha_file(donor_path) == donor_sha, 'donor index changed during preparation')
    return {'kind': LEGACY_IMPORT_KIND, 'donor_path': str(donor_path), 'donor_sha256': donor_sha,
            'target_state': str(directory / 'cycle.json'), 'before_state_sha256': c.digest(fresh),
            'current_binding': binding(state['plan'], root), 'cases': rows, 'transfer_proof': transfer_proof,
            'failures': [copy.deepcopy(found[identifier]) for identifier in ids],
            'pending_post_merge': [copy.deepcopy(p) for p in donor.get('pending_post_merge', []) if p['id'] in ids]}


def admit_import(state, proof, donor_path, directory, root, *, donor_sha256):
    """Revalidate everything before one state publication by the existing CLI writer."""
    import deploy_test_cycle as c
    fresh = c.initialize(state['plan'], root)
    expected = prepare_import(fresh, donor_path, directory, root, donor_sha256=donor_sha256)
    need(c.digest(proof) == c.digest(expected), 'import proof differs from exact donor/current binding')
    # The hash-pinned interface is an adapter to the authoritative transfer
    # protocol, including its persistent identities and pending-repair guards.
    donor = c.bounded_read(Path(donor_path), 'historical donor index')
    need(c.sha_file(donor_path) == donor_sha256, 'donor index changed before admission')
    candidate = copy.deepcopy(fresh)
    adopt(candidate, donor, donor['plan'], expected['transfer_proof'], root)
    need(c.sha_file(donor_path) == donor_sha256, 'donor index changed during admission')
    candidate['historical_custody_import'] = {'kind': LEGACY_IMPORT_KIND, 'proof_sha256': c.digest(expected),
        'donor_path': expected['donor_path'], 'donor_sha256': expected['donor_sha256']}
    verify(candidate, root)
    if state.get('historical_custody_import'):
        need(c.digest(state) == c.digest(candidate), 'import replay changed or cycle is no longer fresh')
    else:
        need(c.digest(state) == c.digest(fresh), 'import requires a normally initialized fresh cycle')
    state.clear(); state.update(candidate)

IMPORT_KIND = 'historical-agentcard-custody-import-v1'


def donor_rows(donor_path, index_path, donor_sha256, index_sha256, root):
    """Validate an explicit pinned archive's complete index, never its execution ledger."""
    import deploy_test_cycle as c
    for path, expected in ((donor_path, donor_sha256), (index_path, index_sha256)):
        need(path.is_file() and not path.is_symlink() and path.resolve() == path
             and re.fullmatch('[0-9a-f]{64}', expected or '')
             and c.sha_file(path) == expected, 'donor provenance changed')
    donor, index = c.read(donor_path), c.read(index_path)
    need(index.get('format') == 'PR1770-HISTORICAL-CUSTODY-RECOVERY-CONTENTS-V1'
         and index.get('files', {}).get(str(root / '.context/deploy-pipeline/cycle.json')) == donor_sha256,
         'donor snapshot not in pinned contents manifest')
    return validate_donor_rows(donor, root)


def validate_donor_rows(donor, root):
    """Shared native/index inventory checks for both explicit provenance envelopes."""
    import deploy_test_cycle as c
    history, active = donor.get('historical_custody_history', []), donor.get('historical_no_retry_custody', [])
    need(history and active, 'empty donor custody index')
    ids = [r['original_failure']['id'] for r in history]
    active_ids = [r['original_failure']['id'] for r in active]
    need(len(set(ids)) == len(ids) == len(active_ids) == len(set(active_ids))
         and set(ids) == set(active_ids), 'partial or duplicate donor custody index')
    # Validate donor discovery unchanged, including negative observations. Only
    # the indexed obligations are admitted; the entire donor stays evidence.
    need(not any(donor.get(k) for k in ('pending', 'running', 'live_failures', 'resume_phase')),
         'active or pending donor snapshot')
    found = known(donor, root)
    need(set(found) == set(ids), 'partial donor custody discovery')
    need(len([f for f in donor['failures'] if f['id'] in ids]) == len(ids),
         'duplicate donor indexed failure')
    need(donor['source'] == donor['plan']['source']
         and c.digest(donor['plan']) == donor['plan_digest'], 'donor plan changed')
    old_binding = {k: donor[k] for k in ('source', 'plan_digest', 'environment', 'input_fingerprints')}
    pending_ids = [p['id'] for p in donor.get('pending_post_merge', []) if p['id'] in ids]
    need(len(pending_ids) == len(set(pending_ids)), 'duplicate donor pending authority')
    rows = []
    for saved in history:
        row = historical(donor, found[saved['original_failure']['id']], root)
        need(row == saved, 'donor indexed native record changed')
        matches = [r for r in active if r['original_failure']['id'] == saved['original_failure']['id']]
        expected = dict(kind=KIND, disposition=DISPOSITION, **row, current_binding=old_binding,
                        current_execution='UNVERIFIED', current_financial_state='UNVERIFIED',
                        credit={'test_execution': False, 'assertions': False, 'financial_release': False})
        need(matches == [expected], 'donor active custody record changed')
        rows.append(row)
    for key in ('root_id', 'card_id', 'transfer_id', 'purchase_id'):
        need(len({r[key] for r in rows}) == len(rows), 'borrowed donor resource identity')
    return donor, found, rows


def import_proof(state, donor_path, index_path, donor_sha256, index_sha256, root):
    """Read-only proposal for a pristine, frozen full current cycle."""
    import deploy_test_cycle as c
    need(state == c.initialize(state['plan'], root), 'custody import requires pristine fresh state')
    donor, found, rows = donor_rows(donor_path, index_path, donor_sha256, index_sha256, root)
    gates = {g['name']: g for g in state['plan']['gates']}
    for row in rows:
        f = row['original_failure']
        need(f['gate'] in gates and gates[f['gate']].get('case_protocol') is True
             and f['check'].split('/', 1)[1] in gates[f['gate']]['checks'], 'protected donor task removed')
    return {'kind': IMPORT_KIND, 'before_state_sha256': c.digest(state),
            'current_binding': binding(state['plan'], root),
            'donor': {'state_path': str(donor_path), 'state_sha256': donor_sha256,
                      'index_path': str(index_path), 'index_sha256': index_sha256,
                      'state_digest': c.digest(donor)},
            'cases': rows, 'failures': [copy.deepcopy(found[r['original_failure']['id']]) for r in rows],
            'pending_post_merge': [copy.deepcopy(p) for p in donor.get('pending_post_merge', [])
                                   if p['id'] in found]}


def import_history(state, donor_path, index_path, donor_sha256, index_sha256, proof, root):
    """Atomic in-memory history-only admission; caller publishes one ordinary state write."""
    import deploy_test_cycle as c
    provenance = state.get('historical_custody_import')
    if provenance is not None:
        # Rebuild from the pristine current baseline, never from donor READY.
        baseline = c.initialize(state['plan'], root)
    else:
        baseline = state
    expected = import_proof(baseline, donor_path, index_path, donor_sha256, index_sha256, root)
    need(proof == expected, 'custody import proof differs from exact donor/current binding')
    candidate = copy.deepcopy(baseline)
    candidate['failures'] = copy.deepcopy(proof['failures'])
    candidate['pending_post_merge'] = copy.deepcopy(proof['pending_post_merge'])
    apply(candidate, proof['cases'], root)
    candidate['historical_custody_import'] = copy.deepcopy(proof)
    verify(candidate, root)
    if provenance is not None:
        need(state == candidate, 'custody import replay requires exact pristine imported state')
        return
    state.clear(); state.update(candidate)


def adopt(state, donor, old, proof, root):
    """Transfer verified no-remint facts into a fresh independent deploy.

    Unlike a same-deploy refresh, this carries no execution or waiver state.
    The donor's complete ledger remains bound by its digest in the receipt.
    """
    import deploy_test_cycle as c
    rows = prepare(donor, old, state['plan'], proof, root)
    current = binding(state['plan'], root)
    need(all(state.get(key) == value for key, value in current.items()),
         'ledger differs from fresh current binding')
    receipt = {'donor_state_sha256': c.digest(donor), 'donor_source': donor['source'],
               'donor_plan_digest': c.digest(old), 'proof_sha256': c.digest(proof),
               'current_binding': current,
               'protected_failure_ids': [r['original_failure']['id'] for r in rows]}
    if receipt in state.get('historical_custody_transfers', []):
        protected = set(receipt['protected_failure_ids'])
        need(protected <= {r['original_failure']['id'] for r in state.get('historical_no_retry_custody', [])}
             and all(r in state.get('historical_custody_history', []) for r in rows),
             'transfer receipt lost original custody')
        verify(state, root)
        return
    need(state == c.initialize(state['plan'], root), 'transfer requires a fresh current ledger')
    candidate = copy.deepcopy(state)
    found = known(donor, root)
    # Preserve the donor's actual resolution and independent auth-failure debt;
    # apply() retains the original native failure and financial snapshot too.
    candidate['failures'] = [copy.deepcopy(found[key]) for key in receipt['protected_failure_ids']]
    candidate['pending_post_merge'] = []
    for key in receipt['protected_failure_ids']:
        f = found[key]
        pending = ([{k: copy.deepcopy(f[k]) for k in ('id', 'check', 'gate', 'native_result')}
                    | {'packet': copy.deepcopy(f['rca']['post_merge'])}]
                   if f['disposition'] == 'pending post-merge' else [])
        need([p for p in donor.get('pending_post_merge', []) if p['id'] == key] == pending,
             'pending repair wrapper changed')
        candidate['pending_post_merge'].extend(pending)
    apply(candidate, rows, root)
    candidate['historical_custody_transfers'] = [receipt]
    verify(candidate, root)
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
    verify_import_origin(state, root)
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


def verify(state, root, *, allow_stale_elections=False):
    """Validate retained provenance and every protected obligation against the current plan."""
    import deploy_test_cycle as c
    verify_import_origin(state, root)
    if not (known(state, root) or state.get('historical_no_retry_custody') or state.get('historical_custody_history')):
        return
    gates = {g['name']: g for g in state['plan']['gates']}
    for f in known(state, root).values():
        need(f['gate'] in gates and f['check'].split('/', 1)[1] in gates[f['gate']]['checks'], 'known historical task removed from plan')
    for gate in state['plan']['gates']:
        # Caller supplies legacy qualifications without recursively entering custody.
        guard(state, gate, root, c.reuse_qualifications(state, gate, include_custody=False, root=root,
            validate_elections=not allow_stale_elections))


def verify_import_origin(state, root):
    """Keep the explicit donor provenance bound during normal verification/admission."""
    if 'historical_custody_import' not in state:
        return
    proof = state['historical_custody_import']
    if isinstance(proof, dict) and proof.get('kind') == LEGACY_IMPORT_KIND:
        verify_legacy_import_origin(state, proof, root)
        return
    need(isinstance(proof, dict) and proof.get('kind') == IMPORT_KIND, 'malformed retained import provenance')
    origin = proof.get('donor')
    need(isinstance(origin, dict), 'malformed retained donor provenance')
    donor, found, rows = donor_rows(Path(origin['state_path']), Path(origin['index_path']),
                                   origin['state_sha256'], origin['index_sha256'], root)
    import deploy_test_cycle as c
    need(proof['kind'] == IMPORT_KIND and origin['state_digest'] == c.digest(donor)
         and proof['cases'] == rows
         and proof['failures'] == [found[r['original_failure']['id']] for r in rows]
         and proof['pending_post_merge'] == [p for p in donor.get('pending_post_merge', []) if p['id'] in found]
         and all(r in state.get('historical_custody_history', []) for r in rows),
         'custody import provenance/index changed')



def verify_legacy_import_origin(state, proof, root):
    """Revalidate the approved-SHA/adopt envelope without resetting a progressed cycle."""
    import deploy_test_cycle as c
    need(set(proof) == {'kind', 'proof_sha256', 'donor_path', 'donor_sha256'}
         and re.fullmatch('[0-9a-f]{64}', proof.get('proof_sha256', ''))
         and re.fullmatch('[0-9a-f]{64}', proof.get('donor_sha256', '')),
         'malformed retained legacy import provenance')
    path = Path(proof['donor_path'])
    need(path.is_absolute() and path.resolve() == path and path.is_relative_to(root / '.context')
         and path.name == 'cycle.json' and path.is_file() and not path.is_symlink()
         and c.sha_file(path) == proof['donor_sha256'], 'legacy donor provenance changed')
    donor = c.bounded_read(path, 'historical donor index')
    _, found, rows = validate_donor_rows(donor, root)
    need(all(r in state.get('historical_custody_history', []) for r in rows), 'historical failure removed')
    need(set(found) <= known(state, root).keys(), 'historical failure removed')

def state_identity(state):
    """Bind admission to current inputs and the complete retained custody provenance."""
    import deploy_test_cycle as c
    return c.digest({k: state.get(k) for k in ('source', 'plan_digest', 'environment', 'input_fingerprints',
                    'historical_no_retry_custody', 'historical_custody_history',
                    'historical_custody_import', 'historical_custody_transfers')})


def debt_key(failure):
    """The identity of one no-remint obligation: original failure, source and native bytes."""
    import deploy_test_cycle as c
    return c.digest({**{k: failure.get(k) for k in ('id', 'gate', 'check', 'source')},
                     'native_sha256': (failure.get('worker_evidence') or {}).get('sha256')})


def canonical_override(state, default, root):
    """Admit a request-owned alternate ledger beside the canonical default only when the default's
    authoritative custody history is validated and either empty or covered by that ledger."""
    import deploy_test_cycle as c
    try:
        need(default.is_file() and not default.is_symlink(), 'canonical custody state is not a regular file')
        canonical = c.read(default)
        need(isinstance(canonical, dict) and isinstance(canonical.get('failures'), list)
             and isinstance(canonical.get('source'), dict) and isinstance(canonical.get('plan'), dict)
             and c.digest(canonical['plan']) == canonical.get('plan_digest'), 'malformed canonical cycle')
        verify_import_origin(canonical, root)
        found = known(canonical, root)
        history = canonical.get('historical_custody_history', [])
        # Re-derive every saved record from its exact native bytes, as donor import does; a stale
        # source is fine, but changed credit, provenance or native history is not coverage.
        for saved in history:
            need(historical(canonical, found[saved['original_failure']['id']], root) == saved,
                 'canonical custody history changed')
        for record in canonical.get('historical_no_retry_custody', []):
            native = historical(canonical, found[record['original_failure']['id']], root)
            exact = dict(kind=KIND, disposition=DISPOSITION, **native, current_binding=record.get('current_binding'),
                         current_execution='UNVERIFIED', current_financial_state='UNVERIFIED',
                         credit={'test_execution': False, 'assertions': False, 'financial_release': False})
            need(record == exact and native in history, 'canonical custody record changed')
        running = any(canonical.get(k) for k in ('running', 'live_failures', 'resume_phase'))
    except (OSError, ValueError, KeyError, TypeError, IndexError, AttributeError) as error:
        raise AdmissionRefusal('canonical-custody-unverifiable', f'{type(error).__name__}: {error}') from error
    refuse(not running, 'canonical-cycle-active')
    covered = known(state, root)
    refuse(all(key in covered and debt_key(covered[key]) == debt_key(f) for key, f in found.items()),
           'canonical-custody-uncovered')
    identity = c.digest(canonical)
    derived = ((state.get('historical_custody_import') or {}).get('donor', {}).get('state_digest') == identity
               or any(t.get('donor_state_sha256') == identity for t in state.get('historical_custody_transfers', [])))
    refuse(canonical['source'] != state['source'] or derived, 'canonical-cycle-owns-source')


def admission(request, root):
    """Bind a gate child's request to its custody ledger before the cloud namespace is created."""
    import deploy_test_cycle as c
    default = root / '.context/deploy-pipeline/cycle.json'
    locator = request.get('custody_state')
    request_path = Path(os.environ.get('DEPLOY_GATE_REQUEST', ''))
    owner_state = None
    if (request_path.name == 'request.json' and len(request_path.parents) > 4
            and request_path.parents[3].name == 'attempts'):
        owner_state = request_path.parents[4] / 'cycle.json'
        refuse(locator is not None and Path(locator).resolve() == owner_state.resolve(), 'request-locator-mismatch')
    override = False
    if default.exists() or default.is_symlink():
        # A supported non-default state directory owns its request; the canonical default must
        # still be proven free of (or covered for) known no-remint obligations below.
        override = owner_state is not None and owner_state.resolve() != default.resolve()
        refuse(override or (locator is not None and Path(locator).resolve() == default.resolve()),
               'canonical-locator-missing')
    if locator is None:
        return  # standalone disposable requests with no canonical cycle have no recorded obligations
    path = Path(locator)
    need(path.is_absolute() and path.resolve() == path and path.is_relative_to(root / '.context')
         and path.name == 'cycle.json' and not path.is_symlink(), 'invalid custody state locator')
    state = c.read(path)
    need(request.get('custody_child_environment') == environment_identity(os.environ), 'admission environment changed')
    need(state_identity(state) == request.get('custody_state_sha256') and state['source'] == request['source'], 'custody state changed')
    if override:
        canonical_override(state, default, root)
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
    from deploy_test_user_omission import qualifications as elected_qualifications
    expected.update(elected_qualifications(state, gate, expected))
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
