"""Distinct prospective user elections and paid-action prohibitions; no native credit."""
from __future__ import annotations

import copy
from pathlib import Path
import re

KIND = 'explicit-agentcard-preexecution-election-v1'
FIELD = 'user_elected_omissions'
PROHIBITION_KIND = 'explicit-paid-agentcard-prohibition-v1'
PROHIBITION_FIELD = 'user_paid_agentcard_prohibition'
CATALOG_ROOT = Path(__file__).resolve().parents[1]
DISPOSITION = 'user / overridden'


def need(value, message):
    """Refuse an invalid election before any cycle mutation."""
    if not value:
        raise ValueError('user omission election: ' + message)


def pinned_document(path, expected):
    """Read a bounded regular artifact against its independently supplied content digest."""
    import deploy_test_cycle as c
    file = Path(path)
    need(file.is_absolute() and file.is_file() and not file.is_symlink()
         and isinstance(expected, str) and re.fullmatch('[0-9a-f]{64}', expected),
         'absolute regular artifact and SHA256 required')
    # Hash the same bounded bytes parsed below, rather than separate mutable reads.
    need(file.stat().st_size <= c.MAX_RECEIPT_BYTES, 'artifact exceeds receipt limit')
    raw = file.read_bytes()
    need(len(raw) <= c.MAX_RECEIPT_BYTES
         and __import__('hashlib').sha256(raw).hexdigest() == expected, 'artifact SHA256 changed')
    value = __import__('json').loads(raw)
    need(isinstance(value, dict), 'artifact must be an object')
    return value


def authority(proof):
    """Validate the exact original user reference from a pinned complete native scoped transcript."""
    from deploy_failure_report import USER_OVERRIDE_REFERENCE
    if isinstance(proof, dict) and proof.get('kind') == 'native-search-continuation-v1':
        search_continuation_authority(proof)
        return
    need(isinstance(proof, dict) and set(proof) == {'path', 'sha256', 'message_source'},
         'pinned native authority required')
    page = pinned_document(proof['path'], proof['sha256'])
    need(isinstance(page.get('thread'), dict) and isinstance(page.get('transcript'), dict),
         'native thread/transcript objects required')
    need(page.get('ok') is True and page.get('readMode') == 'full' and page.get('scope') in {'project', 'user'}
         and page.get('thread', {}).get('id') == USER_OVERRIDE_REFERENCE['thread_id'],
         'original native scoped thread required')
    transcript = page.get('transcript', {})
    completeness = transcript.get('completeness', {})
    need(isinstance(completeness, dict), 'native completeness object required')
    need(completeness.get('mode') == 'full' and completeness.get('pageComplete') is True
         and all(type(completeness.get(key)) is int and completeness[key] == 0 for key in
                 ('missingTurnCount', 'omittedMessageCount', 'shortenedMessageCount', 'unavailableMessageCount')),
         'complete native page without omissions required')
    messages = transcript.get('messages')
    need(isinstance(messages, list), 'native messages required')
    matches = [m for m in messages if isinstance(m, dict) and m.get('role') == 'user'
               and m.get('turnId') == USER_OVERRIDE_REFERENCE['turn_id']
               and m.get('text') == USER_OVERRIDE_REFERENCE['reply']]
    need(len(matches) == 1, 'exact original user message and quote required')
    message = matches[0]
    source = message.get('source')
    need(message.get('textComplete') is True and message.get('reason') is None
         and isinstance(source, dict) and source == proof['message_source']
         and all(isinstance(source.get(key), str) and source[key] for key in ('fileIdentityKey', 'lineId'))
         and type(source.get('textOffset')) is int and source['textOffset'] == 0
         and type(source.get('textLength')) is int and source['textLength'] == len(USER_OVERRIDE_REFERENCE['reply']),
         'complete original native source identity required')


def search_continuation_authority(proof):
    """Preserve the original export gap while joining exact native search, cursor read and continuing restriction."""
    import json
    from deploy_failure_report import USER_OVERRIDE_REFERENCE
    need(set(proof) == {'kind', 'search', 'original_read', 'continuation'}, 'typed native authority bundle required')
    documents = {}
    for name in ('search', 'original_read', 'continuation'):
        locator = proof[name]
        need(isinstance(locator, dict) and set(locator) == {'path', 'sha256'}, 'pinned native locator required')
        documents[name] = pinned_document(locator['path'], locator['sha256'])
    search, original, continuation = (documents[name] for name in ('search', 'original_read', 'continuation'))
    need(search.get('ok') is True and search.get('scope') == 'project'
         and isinstance(search.get('results'), list), 'native scoped original search required')
    matches = [r for r in search['results'] if isinstance(r, dict)
               and isinstance(r.get('thread'), dict) and isinstance(r.get('match'), dict)
               and isinstance(r['match'].get('snippet'), dict)
               and r.get('thread', {}).get('id') == USER_OVERRIDE_REFERENCE['thread_id']
               and r.get('match', {}).get('role') == 'user'
               and r.get('match', {}).get('snippet', {}).get('text') == USER_OVERRIDE_REFERENCE['reply']
               and r.get('match', {}).get('messageTimeMs') == 1794172045719]
    need(len(matches) == 1, 'exact original native user search required')
    cursor = json.loads(matches[0]['match']['readCursor'])
    need(isinstance(cursor, dict), 'native cursor object required')
    need(cursor.get('publicId') == USER_OVERRIDE_REFERENCE['thread_id']
         and isinstance(cursor.get('fileIdentityKey'), str) and cursor['fileIdentityKey']
         and type(cursor.get('pageEndOrdinalInclusive')) is int, 'native search locator required')
    need(isinstance(original.get('thread'), dict) and isinstance(original.get('transcript'), dict),
         'original native thread/transcript objects required')
    need(original.get('ok') is True and original.get('scope') == 'project'
         and original.get('thread', {}).get('id') == USER_OVERRIDE_REFERENCE['thread_id'],
         'original native cursor read required')
    transcript = original.get('transcript', {})
    need(any(m.get('turnId') == USER_OVERRIDE_REFERENCE['turn_id']
             for m in transcript.get('messages', []) if isinstance(m, dict)), 'original native turn reference required')
    pagination = transcript.get('pagination', {})
    need(isinstance(pagination, dict), 'native pagination object required')
    prior = json.loads(pagination.get('nextCursor', '{}'))
    need(isinstance(prior, dict), 'native prior cursor object required')
    need(all(prior.get(key) == cursor.get(key) for key in ('publicId', 'fileId', 'fileIdentityKey', 'historyMode', 'projectionVersion'))
         and prior.get('pageEndOrdinalInclusive') == cursor['pageEndOrdinalInclusive'] - 1,
         'original read must follow the exact native search cursor')
    need(isinstance(continuation.get('thread'), dict) and isinstance(continuation.get('transcript'), dict),
         'continuing native thread/transcript objects required')
    need(continuation.get('ok') is True and continuation.get('scope') == 'project'
         and continuation.get('thread', {}).get('id') == USER_OVERRIDE_REFERENCE['thread_id'],
         'native continuing-user restriction required')
    continuing = [m for m in continuation.get('transcript', {}).get('messages', []) if isinstance(m, dict)
                  and m.get('role') == 'user' and m.get('messageTimeMs') == 1794275237473
                  and m.get('turnId') == 'turn:01a1c323-5e2d-7da0-b4a9-10ea071ca012'
                  and isinstance(m.get('text'), str)
                  and 'No paidAgentCard new/reclaim; user SKIPagentcardbs exactsixscope remains, $43.96UNKNOWN financialdebt remains.' in m['text']]
    need(len(continuing) == 1, 'exact continuing native user restriction required')
    # This is corroboration of the already hardcoded election, not a new grant.
    # The original read hides its body; its gap is never relabeled complete.


def validate_binding(request, state):
    """Shared immutable source/environment/plan boundary for both typed records."""
    import deploy_test_cycle as c
    need(request['source'] == state['source'] and request['environment'] == state['environment']
         and request['plan_digest'] == state['plan_digest'] == c.digest(state['plan'])
         and state['plan'].get('source') == state['source'], 'current source/environment/plan binding changed')
    source = request['source']
    need(isinstance(source, dict) and set(source) == {'head', 'digest'}
         and isinstance(source['head'], str) and re.fullmatch('[0-9a-f]{40}|[0-9a-f]{64}', source['head'])
         and isinstance(source['digest'], str) and re.fullmatch('[0-9a-f]{64}', source['digest'])
         and isinstance(request['environment'], str) and re.fullmatch('[0-9a-f]{64}', request['environment']),
         'typed source/environment digest required')


def validate_original(request, state):
    """Bind one exact selected intersection to current source, environment, plan, inputs and native authority."""
    from deploy_failure_report import USER_OVERRIDE_CHECKS
    need(isinstance(request, dict) and set(request) == {'kind', 'source', 'environment', 'plan_digest',
         'input_fingerprints', 'checks', 'question_checks', 'authority'} and request['kind'] == KIND,
         'typed election request required')
    validate_binding(request, state)
    questions, checks = request['question_checks'], request['checks']
    selected = {g['name'] + '/' + case for g in state['plan']['gates'] for case in g['checks']}
    expected = selected & USER_OVERRIDE_CHECKS
    need(isinstance(questions, list) and len(questions) == 6
         and all(isinstance(v, str) for v in questions) and set(questions) == USER_OVERRIDE_CHECKS
         and isinstance(checks, list) and checks and all(isinstance(v, str) for v in checks)
         and len(checks) == len(set(checks)) and set(checks) == expected,
         'exact six-question scope and selected intersection required')
    gates = {check.split('/', 1)[0] for check in checks}
    fingerprints = request['input_fingerprints']
    need(isinstance(fingerprints, dict) and set(fingerprints) == gates
         and all(fingerprints[name] == state['input_fingerprints'].get(name)
                 and isinstance(fingerprints[name], str) and re.fullmatch('[0-9a-f]{64}', fingerprints[name])
                 for name in gates), 'current selected gate inputs changed')
    authority(request['authority'])


def payment_catalog(binding):
    """Bind classification to the native catalog and the actual fixture predicate, without importing runners."""
    import ast
    import hashlib
    import json
    need(isinstance(binding, dict) and set(binding) == {'tasks_sha256', 'local_sha256'},
         'typed native payment catalog binding required')
    raw = {}
    for key, filename in (('tasks_sha256', 'tasks.json'), ('local_sha256', 'local.py')):
        data = (CATALOG_ROOT / 'agents/benchmarks' / filename).read_bytes()
        need(binding[key] == hashlib.sha256(data).hexdigest(), 'native payment catalog changed')
        raw[filename] = data
    tasks = json.loads(raw['tasks.json'])
    need(isinstance(tasks, list) and all(isinstance(t, dict) and isinstance(t.get('name'), str) for t in tasks),
         'native payment catalog rows required')
    need(len({t['name'] for t in tasks}) == len(tasks), 'duplicate native catalog identity')
    # Evaluate only the literal dependencies of AGENT_PAYMENT_TASK_NAMES. Never
    # import local.py: that module owns live runners, environment and providers.
    tree = ast.parse(raw['local.py'])
    assignments = {n.targets[0].id: n.value for n in tree.body if isinstance(n, ast.Assign)
                   and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name)}
    def literal(node):
        if isinstance(node, ast.Constant) and isinstance(node.value, str): return node.value
        if isinstance(node, ast.Set): return {literal(e) for e in node.elts}
        if isinstance(node, ast.Name) and node.id in assignments: return literal(assignments[node.id])
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
            return literal(node.left) | literal(node.right)
        raise ValueError('user omission election: unsupported native payment predicate dependency')
    need('AGENT_PAYMENT_TASK_NAMES' in assignments, 'native payment task predicate required')
    names = literal(assignments['AGENT_PAYMENT_TASK_NAMES'])
    functions = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'needs_payment_fixture']
    expected = ast.parse('def needs_payment_fixture(tasks):\n return bool(AGENT_PAYMENT_TASK_NAMES & set(tasks))').body[0]
    need(len(functions) == 1 and ast.dump(ast.Module(body=functions[0].body, type_ignores=[]))
         == ast.dump(ast.Module(body=expected.body, type_ignores=[])), 'native payment fixture predicate changed')
    return {t['name']: t for t in tasks}, names


def validate(request, state):
    """Keep the original six-question election distinct from the later paid-action prohibition."""
    if not isinstance(request, dict) or request.get('kind') != PROHIBITION_KIND:
        return validate_original(request, state)
    from deploy_failure_report import USER_OVERRIDE_CHECKS
    need(set(request) == {'kind', 'source', 'environment', 'plan_digest', 'input_fingerprints',
                         'checks', 'authority', 'catalog'}, 'typed paid prohibition request required')
    validate_binding(request, state)
    selected = {g['name'] + '/' + case for g in state['plan']['gates'] for case in g['checks']}
    authority(request['authority'])
    need(isinstance(request['authority'], dict)
         and request['authority'].get('kind') == 'native-search-continuation-v1',
         'later native user prohibition evidence required')
    tasks, native_paid = payment_catalog(request['catalog'])
    eligible = set()
    for check in selected - USER_OVERRIDE_CHECKS:
        gate, name = check.split('/', 1)
        task = tasks.get(name)
        if gate != 'smoke' or name not in native_paid or task is None: continue
        tags, environment = task.get('tags'), task.get('environment')
        lifecycle = task.get('expected_payment_lifecycle')
        need(isinstance(tags, list) and all(isinstance(t, str) for t in tags)
             and {'payment', 'agentcard-lifecycle-sandbox'} <= set(tags)
             and isinstance(environment, dict) and isinstance(environment.get('db_fixtures'), list)
             and 'agent_payment_lifecycle_v1' in environment['db_fixtures']
             and isinstance(lifecycle, dict) and task.get('runner') == 'agent'
             and task.get('harness') == 'rose' and task.get('bench') == 'pipeline-e2e',
             'selected native paid task lacks lifecycle contract')
        integrity = lifecycle.get('integrity')
        need(isinstance(integrity, dict) and type(integrity.get('cardCount')) is int
             and integrity['cardCount'] > 0, 'positive paid card lifecycle required')
        for key in ('stripeHold', 'orgTransfer'):
            row = lifecycle.get(key)
            need(isinstance(row, dict) and type(row.get('amountCents')) is int and row['amountCents'] > 0,
                 'positive paid lifecycle evidence required')
        eligible.add(check)
    checks = request['checks']
    need(isinstance(checks, list) and checks and all(isinstance(x, str) for x in checks)
         and len(set(checks)) == len(checks) and set(checks) == eligible,
         'exact selected native paid tasks outside original six required')
    fingerprints = request['input_fingerprints']
    need(isinstance(fingerprints, dict) and set(fingerprints) == {x.split('/', 1)[0] for x in checks}
         and all(value == state['input_fingerprints'].get(gate) and isinstance(value, str)
                 and re.fullmatch('[0-9a-f]{64}', value) for gate, value in fingerprints.items()),
         'current selected paid gate inputs changed')


def entry(request, check):
    """A selection record, never a fabricated failure or native receipt."""
    return {'check': check, 'source': copy.deepcopy(request['source']),
            'input_fingerprint': request['input_fingerprints'][check.split('/', 1)[0]],
            'disposition': DISPOSITION, 'status': 'SKIP', 'native_result': 'UNEXECUTED',
            'native_exit': None, 'executed': False,
            'credit': {'test_execution': False, 'assertions': False, 'financial_release': False},
            'authority': copy.deepcopy(request['authority'])}


def verify(state):
    """Re-read native authority and reject stale or altered elections on every reuse."""
    import deploy_test_cycle as c
    for field, kind in ((FIELD, KIND), (PROHIBITION_FIELD, PROHIBITION_KIND)):
        if field not in state: continue
        record = state[field]
        need(isinstance(record, dict) and set(record) == {'request', 'request_sha256', 'entries'},
             'election record schema changed')
        request = record['request']
        need(isinstance(request, dict) and request.get('kind') == kind, 'election ledger kind changed')
        validate(request, state)
        need(record['request_sha256'] == c.digest(request)
             and record['entries'] == {check: entry(request, check) for check in request['checks']},
             'election record changed or claimed execution credit')


def qualifications(state, gate, occupied):
    """Validate both ledgers; prior custody always wins over prospective omissions."""
    verify(state)
    prefix = gate['name'] + '/'
    return {check[len(prefix):]: copy.deepcopy(row)
            for field in (FIELD, PROHIBITION_FIELD)
            for check, row in state.get(field, {}).get('entries', {}).items()
            if check.startswith(prefix) and check[len(prefix):] not in occupied}


def elect(state, request, root):
    """Apply a quiescent, current-input election atomically without rewriting any native history."""
    import deploy_test_cycle as c
    for field in (FIELD, PROHIBITION_FIELD):
        need(field not in state or isinstance(state[field], dict), 'retained election record object required')
    need(not c.CANCEL.is_set() and state.get('phase') in {'quick', 'triage', 'needs-focused-plan',
         'focused', 'failed-gates', 'initial', 'final'} and 'live_failures' not in state
         and not state.get('running') and not state.get('resume_phase'), 'quiescent nonterminal cycle required')
    c.validate_plan(state['plan'], root)
    need(c.source(root) == state['source'] and c.environment_digest() == state['environment']
         and c.input_fingerprints(state['plan'], root) == state['input_fingerprints'],
         'live source/environment/input binding changed')
    validate(request, state)
    pending = set(state.get('pending', []))
    need(not any(f['id'] in pending and f.get('check') in request['checks'] for f in state.get('failures', [])),
         'selected pending native failure requires normal adjudication')
    names = [g['name'] for g in state['plan']['gates']]
    need(not c.retained_owners(state, names), 'live or retained native owners forbid election')
    record = {'request': copy.deepcopy(request), 'request_sha256': c.digest(request),
              'entries': {check: entry(request, check) for check in request['checks']}}
    field = PROHIBITION_FIELD if request['kind'] == PROHIBITION_KIND else FIELD
    previous = state.get(field)
    if previous == record:
        verify(state)
        return
    if previous is not None:
        need(isinstance(previous, dict) and isinstance(previous.get('request'), dict),
             'retained election record/request objects required')
        need(previous.get('request', {}).get('source') != state['source']
             or previous.get('request', {}).get('environment') != state['environment']
             or previous.get('request', {}).get('plan_digest') != state['plan_digest']
             or previous.get('request', {}).get('input_fingerprints') != request['input_fingerprints'],
             'conflicting election for same inputs')
    # All external reads and guards above precede either mutation. Stale election
    # remains fail-closed after refresh until this explicit current-input renewal.
    if previous is not None:
        state.setdefault('superseded_' + field, []).append(copy.deepcopy(previous))
    state[field] = record


def report_lines(state):
    """State explicit omission and zero credit without treating prior task outcomes as current execution."""
    verify(state)
    return [f"{check}: ⚠️ Overridden — elected UNEXECUTED/SKIP, native exit UNRECORDED; "
            "no execution/assertion/financial credit; original results and $43.96 custody unchanged."
            for field in (FIELD, PROHIBITION_FIELD)
            for check in state.get(field, {}).get('entries', {})]
