"""Read-only acquisition of completed persistent agents; never approximate task turns."""
from collections import defaultdict
import json
import os
import subprocess
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode
from core import credential, digest
from redaction import mask
from success import success_verdict


def query(sql):
    if not sql.lstrip().upper().startswith(('SELECT ', 'WITH ')):
        raise ValueError('Only read-only queries are accepted')
    # Devbox shells often inject a LOCAL DATABASE_URL. Use the explicit
    # production override or the backend's complete managed env file.
    from dotenv import dotenv_values
    source = os.environ.get('JEV_PROD_DATABASE_URL') or dotenv_values(
        Path(__file__).resolve().parents[2] / 'back-end/.env').get('DATABASE_URL')
    if not source:
        raise RuntimeError('Production database configuration missing')
    url = urlsplit(source)
    db = urlunsplit(url._replace(query=urlencode({k: v for k, v in parse_qsl(url.query)
                                                if k in ('sslmode', 'connect_timeout')})))
    env = {**os.environ, 'PGOPTIONS': '-c default_transaction_read_only=on -c statement_timeout=25000',
           'PGCONNECT_TIMEOUT': '10'}
    # Transaction-pooling proxies may reset/ignore startup PGOPTIONS. Require
    # a server-side read-only transaction around the actual statement too.
    transaction = 'BEGIN READ ONLY;\n' + sql.rstrip().rstrip(';') + ';\nROLLBACK;\n'
    result = subprocess.run(['psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-w', '-d', db, '-At'], input=transaction, env=env,
                            capture_output=True, text=True, timeout=90)
    if result.returncode:
        raise RuntimeError('Read-only production query failed (credentials and data suppressed)')
    return [json.loads(line) for line in result.stdout.splitlines() if line.strip()]


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def pull(since, until, seen_families, filters=None):
    if filters is None:
        from checkpoint import config
        filters = config()['filters']
    agents = query('SELECT row_to_json(a) FROM (SELECT id,"parentAgentId",status,goal,"responseSchema",'
                   '"updatedAt" FROM "Agent") a')
    by_id = {a['id']: a for a in agents}
    def root(a):
        visited = set()
        while a.get('parentAgentId') in by_id:
            if a['id'] in visited:
                raise ValueError('Cycle in production agent ancestry')
            visited.add(a['id'])
            a = by_id[a['parentAgentId']]
        return a['id']
    families = {a['id']: root(a) for a in agents}
    from datetime import datetime, timezone
    def stamp(s):
        parsed = datetime.fromisoformat(s.replace('Z', '+00:00'))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed
    fresh = {families[a['id']] for a in agents if a['status'] == 'COMPLETED'
             and stamp(since) < stamp(a['updatedAt']) <= stamp(until)
             and families[a['id']] not in seen_families}
    candidates = [a for a in agents if families[a['id']] in fresh and a['status'] == filters['terminal_status']
                  and ('normal_child' if a['parentAgentId'] else 'normal_root') in filters['agent_kinds']
                  and stamp(a['updatedAt']) <= stamp(until) and a.get('goal')]
    events = defaultdict(list)
    for offset in range(0, len(candidates), 80):
        ids = ','.join(literal(a['id']) for a in candidates[offset:offset+80])
        messages = query('SELECT row_to_json(m) FROM (SELECT id,"agentId",role,timestamp,text,metadata '
                         f'FROM "Message" WHERE "agentId" IN ({ids}) '
                         "AND role IN ('ASSISTANT','TOOL') ORDER BY timestamp,id) m")
        calls = defaultdict(set)
        for m in messages:
            md = m.get('metadata') or {}
            if m['role'] == 'ASSISTANT' and isinstance(md.get('tool_calls'), list) and md['tool_calls']:
                events[m['agentId']].append({'id': m['id'], 'role': 'assistant', 'timestamp': m['timestamp'],
                                            'calls': md['tool_calls']})
                calls[m['agentId']].update(c.get('tool_call_id') or c.get('id') for c in md['tool_calls'])
        for m in messages:
            md = m.get('metadata') or {}
            if m['role'] == 'TOOL' and md.get('toolCallId') in calls[m['agentId']]:
                events[m['agentId']].append({'id': m['id'], 'role': 'tool', 'timestamp': m['timestamp'],
                                            'text': (m.get('text') or '')[:filters['result_text_chars']], 'call_id': md['toolCallId'],
                                            'status': md.get('toolStatus'), 'tool': md.get('toolName'), 'metadata': md})
    traces = []
    rejected_success = defaultdict(int)
    for a in candidates:
        history = sorted(events[a['id']], key=lambda e: (e['timestamp'], e['id']))
        turns = [e for e in history if e['role'] == 'assistant']
        if not turns:
            continue
        terminal_ids = {c.get('tool_call_id') or c.get('id') for c in turns[-1]['calls']
                        if (c.get('tool') or c.get('name') or c.get('function', {}).get('name'))
                        in ('attempt_completion', 'attempt_completion_with_result')}
        if not any(e.get('call_id') in terminal_ids and e.get('status') in ('FINISHED', 'COMPLETED') for e in history):
            continue
        trace = {'trace_id': a['id'], 'family_id': families[a['id']],
                            'kind': 'normal_child' if a['parentAgentId'] else 'normal_root',
                            'goal': a['goal'], 'output_schema': a['responseSchema'], 'events': history,
                            'total_batches': len(turns), 'terminal_receipt': {'status': 'COMPLETED'},
                            'source': 'read-only successful production Agent plus own persisted Message turns'}
        result = next((e for e in reversed(history) if e.get('call_id') in terminal_ids
                       and e.get('status') in ('FINISHED', 'COMPLETED')), None)
        ok, reason = success_verdict(trace, {**(result or {}), 'id': a['id'], 'status': a['status']})
        if not ok:
            rejected_success[reason] += 1
            continue
        trace['success_evidence'] = {'outcome': 'SUCCEEDED', 'basis': reason, 'message_id': result['id']}
        # Verifier metadata is audit evidence, never model input.
        for event in history:
            event.pop('metadata', None)
        traces.append(mask(trace))
    return traces, {'candidate_agents': len(candidates), 'usable_traces': len(traces),
                    'rejected_missing_turns_or_terminal': len(candidates)-len(traces),
                    'rejected_success_evidence': dict(rejected_success),
                    'coverage_limitation': 'Fresh pull currently includes persistent root/child agents only. '
                    'Browser/explore require archived turn reconstruction; never fabricate their batches or ETA.'}


def examples(traces):
    if any(t.get('success_evidence', {}).get('outcome') != 'SUCCEEDED' for t in traces):
        raise ValueError('Examples require successful tasks, not merely completed agents')
    rows = []
    for t in traces:
        issued = 0
        for cutoff in range(-1, len(t['events'])):
            if cutoff >= 0 and t['events'][cutoff]['role'] == 'assistant':
                issued += 1
            rows.append({'example_id': digest([t['trace_id'], cutoff]), 'trace_id': t['trace_id'],
                         'family_id': t['family_id'], 'split_group': t['split_group'], 'agent_kind': t['kind'],
                         'cutoff_event_index': cutoff, 'target': {'observed_batches': issued,
                         'remaining_batches': t['total_batches'] - issued, 'batch_progress': issued / t['total_batches']}})
    return rows
