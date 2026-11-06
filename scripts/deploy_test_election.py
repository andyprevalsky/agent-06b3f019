"""Explicit optional AgentCard selection, separate from task or cleanup waivers."""
from __future__ import annotations

import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import runpy
import subprocess
import time

GATE = 'agentcard-lifecycle'
KIND = 'local-agentcard-omission-custody-v1'
DISPOSITION = 'optional gate omitted; native outcome and custody retained'


def need(value, message):
    if not value:
        raise ValueError('AgentCard election: ' + message)


def document(path):
    p = Path(path)
    need(p.is_absolute() and p.is_file() and not p.is_symlink() and p.stat().st_size <= 16 * 1024 * 1024,
         'bounded regular evidence file required')
    return json.loads(p.read_text())


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def native_run(path, archived):
    """Project native financial evidence without loading messages or raw logs."""
    file = Path(path)
    need(file.is_absolute() and file.is_file() and not file.is_symlink()
         and file.stat().st_size == archived['bytes'] and sha(file) == archived['sha256'],
         'original archived run bytes changed')
    projection = '''reduce inputs as $v ({tasks: []};
      if ($v|length)==2 and
         ($v[0]==["run_id"] or
          ($v[0][0]=="tasks" and ($v[0]|length)>=3 and
           ((["name","agent_id","status","benchmark_status","passed"] | index($v[0][2])) != null or
            ($v[0][2]=="logs" and
             ($v[0][3]=="cloud_provider_cleanup" or
              ($v[0][3]=="cloud_cleanup_evidence" and $v[0][4]=="payment_snapshot"))))))
      then setpath($v[0]; $v[1]) else . end)'''
    result = subprocess.run(['jq', '--stream', '-cn', projection, str(file)],
                            capture_output=True, timeout=30)
    need(result.returncode == 0 and len(result.stdout) <= 16 * 1024 * 1024,
         'bounded native financial projection failed')
    return json.loads(result.stdout)


def omission(plan):
    rows = [row for row in plan.get('omitted', []) if row.get('gate') == GATE]
    need(len(rows) == 1, 'one explicit omission required')
    row = rows[0]
    prefix = 'explicit AgentCard opt-out: '
    need(row.get('category') == GATE and row.get('disposition') == 'SKIPPED'
         and row.get('executed') is False and isinstance(row.get('reason'), str)
         and row['reason'].startswith(prefix) and row['reason'][len(prefix):].strip(),
         'planner opt-out reason required')
    return row


def physical_quiet(proof):
    physical = document(proof['physical'])
    need(physical.get('canonical_reconcile_exit') == 0 and physical.get('physical_process_absent') is True
         and physical.get('database_status') == 'ABSENT' and physical.get('listeners') == []
         and physical.get('services_status') == 'stopped' and physical.get('financial_cleanup_verified') is False,
         'physical closure must remain distinct from financial cleanup')
    run = Path(physical['run'])
    need(physical.get('source') == proof['source']['head'], 'physical source mismatch')
    owner = document(run / 'local-stack-owner.json')
    services = document(run / 'services.json')
    benchmark = document(run / 'local-benchmark-owner.json')
    need(services.get('benchmark_mode') is True and services.get('status') == 'stopped'
         and services.get('run_sh_pid') == owner.get('pid') and benchmark.get('state') == 'failed_retained'
         and benchmark.get('run_id') == owner.get('run_id') == run.name,
         'original failed-retained owner and stopped manifest required')
    status = (run / ('benchmark-cleanup-' + benchmark['token'] + '.status')).read_text()
    need('state=failed\n' in status and 'token=' + benchmark['token'] + '\n' in status,
         'original failed benchmark cleanup must remain unchanged')
    process = Path('/proc', str(owner['pid']))
    if process.exists():
        raw = (process / 'stat').read_text().rsplit(') ', 1)[1].split()
        identity = 'linux:' + Path('/proc/sys/kernel/random/boot_id').read_text().strip() + ':' + raw[19]
        need(identity != owner.get('native_identity'), 'original stack is still live')
    policy = Path(proof['physical_policy'])
    original = subprocess.run(['git', 'show', proof['source']['head'] + ':agents/benchmarks/local_cleanup_reconcile.py'],
                              cwd=services['worktree'], capture_output=True, check=True).stdout
    need(hashlib.sha256(original).hexdigest() == proof['files'][str(policy)], 'native physical policy changed')
    tools = runpy.run_path(str(policy))
    ancestors = tools['_ancestors'](os.getpid())
    for pid, argv, environ, cwd in tools['_process_table']():
        if pid in ancestors:
            continue
        need(not ('RUN_STACK_CLEANUP_TOKEN=' + owner['token'] in environ.split('\n')
                  or str(run) in argv or cwd == str(run) or cwd.startswith(str(run) + '/')),
             'owned process or evidence writer remains')
    wanted = {p for p in services.get('ports', {}).values() if type(p) is int and p > 0}
    need(wanted and not wanted.intersection(tools['_listening_ports']()), 'owned service listener remains')
    database = services['database']['name']
    need(re.fullmatch(r'victoria_bench_[A-Za-z0-9_]+', database) is not None
         and database == physical.get('database') and services['database'].get('use_system_postgres') is True,
         'exact isolated database identity required')
    need(tools['_database_present'](services['database']) is None,
         'original isolated database still exists or is unknown')


def validate_custody(proof, receipt):
    from deploy_test_cycle import bounded_read, receipt_owner
    need(isinstance(proof, dict) and proof.get('kind') == KIND and proof.get('source') == receipt['source']
         and proof.get('token') == receipt.get('token') and proof.get('owner') == receipt_owner(GATE, receipt)
         and proof.get('financial_cleanup_verified') is False and proof.get('credit_granted') is False,
         'original source/token/owner and zero credit required')
    need(isinstance(proof.get('known_loss'), str) and proof['known_loss'].strip()
         and isinstance(proof.get('accountable_owner'), str) and proof['accountable_owner'].strip(),
         'known loss and continuing accountable owner required')
    need(type(receipt.get('finished_at')) in (int, float), 'original terminal time required')
    files = proof.get('files')
    need(isinstance(files, dict) and len(files) >= 7 and all(sha(path) == digest for path, digest in files.items()),
         'custody evidence changed')
    for name in ('physical', 'archive', 'inventory', 'provider_observation', 'run_json',
                 'report_card', 'payment_policy', 'physical_policy'):
        need(proof.get(name) in files, 'missing bound ' + name)
    physical = document(proof['physical'])
    need(type(physical.get('observed_at')) in (int, float)
         and math.isfinite(physical['observed_at'])
         and receipt['finished_at'] <= physical['observed_at'] <= time.time(),
         'physical observation must follow the original operation')
    folder = Path(receipt['log']).parent
    for name in ('request.json', 'receipt.json', 'result.json'):
        need(str(folder / name) in files, 'missing original native ' + name)
    need(bounded_read(folder / 'receipt.json', 'omitted original receipt') == receipt,
         'original native receipt changed')
    request = bounded_read(folder / 'request.json', 'original optional request')
    result = bounded_read(folder / 'result.json', 'original optional result')
    need(all(row.get(k) == receipt.get(k) for row in (request, result) for k in ('token', 'source', 'gate'))
         and receipt.get('gate') == GATE and receipt.get('cases') == result.get('cases') == {GATE: 'UNVERIFIED'}
         and receipt.get('complete') is False and result.get('complete') is False
         and receipt.get('executed') is True and receipt.get('lifecycle') == 'native-producer'
         and type(receipt.get('native_exit')) is int and receipt['native_exit'] == 1,
         'original incomplete native producer identity required')
    need(result.get('recipe_digest') == __import__('deploy_test_cycle').digest(request.get('worker_recipe')),
         'original worker recipe changed')
    archive = document(proof['archive'])
    need(archive.get('format') == 'ROSE-PRIVATE-TAR-GCM-V1' and archive.get('bucket') == 'trace-archive'
         and archive.get('full_readback_verified') is True
         and archive.get('receipt_sidecar_authenticated_readback') is True
         and archive.get('all_members_restored_and_hash_verified') is True
         and isinstance(archive.get('files'), int) and archive['files'] > 0
         and re.fullmatch(r'[0-9a-f]{64}', archive.get('ciphertext_sha256', ''))
         and isinstance(archive.get('key'), str) and archive['key'].startswith('devbox-closeout-private/')
         and archive.get('receipt_sidecar_key') == archive['key'] + '.receipt.aesgcm',
         'verified private preservation and independent recovery references required')
    inventory = document(proof['inventory'])
    entries = inventory if isinstance(inventory, list) else inventory.get('files', [])
    archived_entries = {x['original_path']: x for x in entries}
    archived = {path: row['sha256'] for path, row in archived_entries.items()}
    for name in ('request.json', 'receipt.json', 'result.json'):
        path = str(folder / name)
        need(archived.get(path) == files[path], 'original native evidence was not archived')
    need(archived.get(proof['run_json']) == files[proof['run_json']], 'original run was not archived')
    run = native_run(proof['run_json'], archived_entries[proof['run_json']])
    card = document(proof['report_card'])
    need(card.get('source_sha') == receipt['source']['head'] and card.get('run_id') == run.get('run_id'),
         'native run source binding')
    command = request['worker_recipe']['cases'][GATE]['command']
    need(command[:3] == ['bash', 'scripts/run-bench', '--local'] and '--bootstrap' in command,
         'original full local payment command required')
    names = command[3:command.index('--bootstrap')]
    tasks = run.get('tasks')
    need(isinstance(tasks, list) and len(names) == len(set(names)) == len(tasks)
         and set(names) == {x['name'] for x in tasks}, 'complete original task inventory required')
    policy = Path(proof['payment_policy'])
    original = subprocess.run(['git', 'show', receipt['source']['head'] + ':agents/benchmarks/cloud_batch_cleanup.py'],
                              cwd=proof['owner']['worker_root'], capture_output=True, check=True).stdout
    need(hashlib.sha256(original).hexdigest() == files[str(policy)], 'native payment evidence policy changed')
    pending = []
    for task in tasks:
        logs = task.get('logs') or {}
        cleanup = logs.get('cloud_provider_cleanup') or {}
        need(cleanup.get('root_agent_id') == task.get('agent_id') and cleanup.get('tree_sealed') is True
             and cleanup.get('root_deleted') is True and isinstance(cleanup.get('provider_receipts'), list)
             and all(x.get('status') in {200, 204, 404} for x in cleanup['provider_receipts']),
             'original provider root must have completed native closure')
        pending.extend(runpy.run_path(str(policy))['pending_root_payments'](
            logs.get('cloud_cleanup_evidence', {}).get('payment_snapshot') or {}))
    observation = document(proof['provider_observation'])
    transfer = observation.get('transfer') or {}
    obligations = proof.get('obligations')
    need(isinstance(obligations, list) and obligations and all(
        isinstance(x, dict) and set(x) == {'purchase_id', 'card_id', 'transfer_id', 'amount_cents', 'livemode'}
        and type(x['amount_cents']) is int and x['amount_cents'] > 0 and x['livemode'] is False
        and all(isinstance(x[k], str) and x[k] for k in ('purchase_id', 'card_id', 'transfer_id')) for x in obligations),
        'exact original financial obligations required')
    need(obligations == [{'purchase_id': x['purchase_id'], 'card_id': x['card_id'],
                           'transfer_id': x['provider_transfer_id'], 'amount_cents': x['total_cents'],
                           'livemode': False} for x in pending], 'native pending obligations differ')
    need(observation.get('readOnly') is True and observation.get('providerMutation') is False
         and observation.get('found') is True and len(obligations) == 1
         and transfer.get('id') == obligations[0]['transfer_id']
         and transfer.get('card_id') == obligations[0]['card_id']
         and transfer.get('amount_cents') == obligations[0]['amount_cents']
         and transfer.get('livemode') is False and transfer.get('status') == 'consumed'
         and transfer.get('released_cents') == 0,
         'observed original obligation required; no release inference')
    physical_quiet(proof)


def prepare(state, old, new, proof):
    """Only explicit optional coverage changes; never clears a native cleanup owner."""
    from deploy_test_cycle import digest, latest_receipts
    from deploy_failure_report import decision
    old_gates = {g['name']: g for g in old['gates']}
    removed = set(old_gates) - {g['name'] for g in new['gates']}
    if not removed:
        return None
    need(removed == {GATE} and old_gates[GATE].get('category') == GATE, 'other selected coverage cannot be removed')
    choice = omission(new)
    need(state.get('phase') == 'triage' and 'live_failures' not in state and not state.get('running'),
         'quiescent triage required')
    latest = latest_receipts(state).get(GATE)
    pending = [f for f in state['failures'] if f['id'] in state.get('pending', []) and f['gate'] == GATE]
    if latest is not None:
        need(proof is not None, 'started optional gate requires preserved physical/financial custody')
        validate_custody(proof, latest)
        entries = proof.get('rca', [])
        need({x['id'] for x in entries} == {f['id'] for f in pending} and len(entries) == len(pending),
             'every omitted pending occurrence requires its actual RCA')
        for failure in pending:
            entry = next(x for x in entries if x['id'] == failure['id'])
            need(all(entry.get(k) == failure.get(k) for k in ('check', 'source', 'command', 'native_result'))
                 and entry.get('attribution') == 'NOT_INTRODUCED' and decision(entry) == 'blocking',
                 'election cannot invent attribution, waive an incomplete case, or substitute a handoff')
            need(not (failure.get('rca') or {}).get('assigned_repair') and not any(
                entry.get(k) is not None for k in ('assigned_repair', 'resource_skip', 'standing_policy',
                'repair_agent', 'post_merge', 'external_provider', 'execute_unverified')),
                'an assigned repair or another waiver cannot become an optional election')
    else:
        need(not pending and proof is None, 'unexecuted selection must have no invented custody')
    return {'gate': GATE, 'reason': choice['reason'], 'elected_at': time.time(), 'source': new['source'],
            'original_source': state['source'], 'original_gate': copy.deepcopy(old_gates[GATE]),
            'original_contract_digest': digest(old_gates[GATE]), 'proof': copy.deepcopy(proof),
            'prior_qualifications': {k: copy.deepcopy(v) for k, v in state.get('skips', {}).items()
                                     if k.startswith(GATE + '/')},
            'native_result': 'UNVERIFIED retained' if latest else 'UNEXECUTED',
            'executed': False, 'test_credit': False, 'cleanup_credit': False}


def apply(state, election):
    if election is None:
        return
    proof = election['proof']
    pending_ids = {x['id'] for x in proof.get('rca', [])} if proof else set()
    for failure in state['failures']:
        if failure['id'] in pending_ids:
            failure['rca'] = copy.deepcopy(next(x for x in proof['rca'] if x['id'] == failure['id']))
            failure['disposition'] = DISPOSITION
    state['pending'] = [x for x in state.get('pending', []) if x not in pending_ids]
    if not state['pending']:
        state.pop('pending')
    state['repair_gates'] = [x for x in state['repair_gates'] if x != GATE]
    state['triage_repair_gates'] = [x for x in state.get('triage_repair_gates', []) if x != GATE]
    state.setdefault('elected_omissions', []).append(election)


def verify(state):
    from deploy_test_cycle import latest_receipts
    for election in state.get('elected_omissions', []):
        need(election['gate'] == GATE and omission(state['plan'])['reason'] == election['reason']
             and not any(g['name'] == GATE for g in state['plan']['gates'])
             and election.get('test_credit') is False and election.get('cleanup_credit') is False,
             'optional omission changed or claimed execution credit')
        if election['proof']:
            validate_custody(election['proof'], latest_receipts(state)[GATE])
        if election.get('accepted_custody'):
            checking = copy.deepcopy(state)
            for row in checking['elected_omissions']:
                row.pop('accepted_custody', None)
            accept(checking, election['accepted_custody'])


def completion_block(state):
    verify(state)
    for election in state.get('elected_omissions', []):
        if election['proof'] and not election.get('accepted_custody'):
            return 'omitted AgentCard coverage retains original debt; durable operational custody acceptance required'
    return None


def accept(state, proof):
    """An actor's custody acceptance is no execution, cleanup or settlement proof."""
    elections = [e for e in state.get('elected_omissions', []) if e['proof'] and not e.get('accepted_custody')]
    need(len(elections) == 1, 'one unresolved operational custody required')
    election = elections[0]
    acceptance = document(proof['acceptance'])
    platform = document(proof['platform_result'])
    need(sha(proof['acceptance']) == proof['acceptance_sha256']
         and sha(proof['platform_result']) == proof['platform_result_sha256'], 'acceptance evidence changed')
    data = platform.get('data') or {}
    text = (data.get('output') or {}).get('text', '')
    original = election['proof']
    archive = document(original['archive'])
    need(platform.get('ok') is True and data.get('status') == 'completed'
         and isinstance(data.get('completedAt'), (int, float)) and data.get('executionInstanceId') == acceptance.get('custodian_devbox')
         and isinstance(original.get('originating_devbox'), str) and original['originating_devbox']
         and proof.get('originating_devbox') == original['originating_devbox']
         and acceptance.get('custodian_devbox') != original['originating_devbox']
         and re.fullmatch(r'https://boxes\.dev/thread/[A-Za-z0-9_-]+', proof.get('custody_link', ''))
         and acceptance.get('thread_url') == proof['custody_link']
         and 'OPERATIONAL_CUSTODY_ACCEPTED_SHA256 ' + proof['acceptance_sha256'] in text.splitlines()
         and acceptance.get('obligations') == original['obligations']
         and acceptance.get('archive_key') == archive['key']
         and acceptance.get('ciphertext_sha256') == archive['ciphertext_sha256']
         and acceptance.get('financial_cleanup_verified') is False and acceptance.get('test_credit') is False
         and acceptance.get('continuing_parent_accountability') is True
         and acceptance.get('independent_archive_recovery_verified') is True,
         'exact off-box operational acceptance required; no task/financial release credit')
    election['accepted_custody'] = copy.deepcopy(proof)
