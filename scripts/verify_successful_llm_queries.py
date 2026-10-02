"""Read-only proof gate: completed provider queries, never input-dump counts.

This is an acceptance observer; it does not alter tasks, calls or evaluation.
Conservatively counts only correlated provider read spans with positive output
usage and a normal stop/tool-call finish. Terminal model-request failures inside
the owned execution window invalidate the proof even when three other queries
completed. Retries and duplicated log lines do not inflate counts.
"""
import argparse
import hashlib
import json
import math
import re
import sys
import uuid
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

ROSE_DONE_EVENTS = frozenset({
    'rose.complete.direct_auth.done',
    'rose.complete.openai_apikey.done',
    'rose.complete.anthropic_apikey.done',
    'rose.complete.foundry.done',
    'rose.complete.cerebras.done',
    'rose.complete.waterfall.done',
})
ROSE_EVIDENCE_EVENTS = ROSE_DONE_EVENTS | {
    'rose.complete.start', 'rose.complete.first_productive_chunk',
    'rose.complete.failed',
}


def _unique_events(events):
    """Collapse identical copied log lines; conflicting copies remain distinct."""
    return [json.loads(raw) for raw in {json.dumps(e, sort_keys=True) for e in events}]


def _browser_state_timeout(event):
    """An owned backend failure remains INFRA even if browser init retries work."""
    if (event.get('event') != 'Transient browser session init failure; retrying with a fresh proxy'
            or event.get('status_code') != 500):
        return False
    try:
        detail = json.loads(event.get('detail', ''))
    except (ValueError, TypeError):
        return False
    return (isinstance(detail, dict) and isinstance(detail.get('error'), str)
            and re.fullmatch(r'Browser state injection timed out after [0-9]+ms', detail['error'])
            is not None)


def _rose_completed_queries(events, usage, start, finish):
    """Correlate live Rose completions when provider_read spans are not emitted.

    RoseClient.complete logs start, first productive output, one usage chunk,
    then a route-specific done event for each live provider response. Fast-mode
    cache replays bypass this route, and failed provider attempts have no done.
    A shared tracing span can contain consecutive continuation requests, so
    request_id and non-overlapping timestamps are both mandatory.
    """
    groups = defaultdict(lambda: defaultdict(list))
    for event in events:
        kind = event.get('event')
        if kind not in ROSE_EVIDENCE_EVENTS:
            continue
        key = (event.get('agent_id'), event.get('request_id'), event.get('span_id'))
        if not all(key):
            continue
        groups[key][kind].append(event)

    intervals = []
    for (agent_id, request_id, span_id), group in groups.items():
        starts = _unique_events(group['rose.complete.start'])
        productive = _unique_events(group['rose.complete.first_productive_chunk'])
        done = _unique_events([event for kind in ROSE_DONE_EVENTS for event in group[kind]])
        failures = _unique_events(group['rose.complete.failed'])
        if len(starts) != 1 or len(productive) != 1 or len(done) != 1 or failures:
            continue
        opening, first, closing = starts[0], productive[0], done[0]
        try:
            began, first_at, ended = (stamp(e['timestamp']) for e in (opening, first, closing))
        except (KeyError, ValueError, TypeError, AssertionError):
            continue
        if not start <= began <= first_at <= ended <= finish:
            continue
        intervals.append((agent_id, request_id, span_id, opening, first, closing, began, ended))

    result = {}
    for agent_id, request_id, span_id, opening, first, closing, began, ended in intervals:
        # Exactly one distinct usage event from this live completion, and no
        # overlapping completion may borrow it. A length-truncated response
        # does not certify the requested successful query.
        candidates = []
        for event in _unique_events(usage):
            if (event.get('agent_id'), event.get('span_id')) != (agent_id, span_id):
                continue
            try:
                when = stamp(event['timestamp'])
            except (KeyError, ValueError, TypeError, AssertionError):
                continue
            if began <= when <= ended:
                candidates.append((event, when))
        if len(candidates) != 1:
            continue
        event, when = candidates[0]
        owners = [row for row in intervals if row[0] == agent_id and row[2] == span_id
                  and row[6] <= when <= row[7]]
        if len(owners) != 1:
            continue
        tokens = event.get('completion_tokens')
        if (not isinstance(tokens, int) or isinstance(tokens, bool) or tokens <= 0
                or event.get('finish') not in ('stop', 'tool_calls')
                or not isinstance(event.get('actual_model'), str)
                or not event['actual_model'].strip()):
            continue
        result[(agent_id, request_id)] = {
            'agent_id': agent_id,
            'request_id': request_id,
            'rose_completion_span_id': span_id,
            'evidence_kind': 'rose_live_completion',
            'started_at': opening['timestamp'],
            'first_productive_at': first['timestamp'],
            'completed_at': closing['timestamp'],
            'usage_at': event['timestamp'],
            'completion_tokens': tokens,
            'finish': event['finish'],
            'route_done_event': closing['event'],
        }
    return result


def stamp(value):
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    assert parsed.tzinfo is not None, 'timestamp must include timezone'
    return parsed


def verify(payload, minimum=3):
    assert minimum >= 3
    assert len(payload['tasks']) == 1
    task = payload['tasks'][0]
    root = task['agent_id']
    roots = root.split(',')
    assert roots and len(roots) == len(set(roots))
    assert all(str(uuid.UUID(agent_id)) == agent_id for agent_id in roots)
    assert str(uuid.UUID(payload['run_id'])) == payload['run_id']
    start = stamp(payload['timestamp'])
    duration = task['duration_seconds']
    assert isinstance(duration, (float, int)) and math.isfinite(duration) and duration > 0
    finish = start + timedelta(seconds=duration)
    logs = task['logs']
    if len(roots) == 1:
        stages = [(root, logs)]
    else:
        # Composite benchmark artifacts keep each root's worker logs under its
        # stage (for example biometrics gate and X post). The outer worker log
        # is a duplicate view and must not inflate query counts.
        nested = [value for value in logs.values()
                  if isinstance(value, dict) and isinstance(value.get('worker_logs'), list)]
        assert len(nested) == len(roots), 'composite root stages are incomplete'
        stages = []
        for stage in nested:
            observed = set()
            for raw in stage['worker_logs']:
                try:
                    event = json.loads(raw) if isinstance(raw, str) else raw
                except ValueError:
                    continue
                if isinstance(event, dict) and event.get('agent_id') is not None:
                    observed.add(event['agent_id'])
            candidates = observed & set(roots)
            assert len(candidates) == 1, 'unbound composite stage'
            stage_root = next(iter(candidates))
            assert observed <= set(stage.get('tree') or {stage_root: {}}), 'unbound composite stage'
            stages.append((stage_root, stage))
        assert {agent_id for agent_id, _ in stages} == set(roots), 'missing composite root'
    spans = defaultdict(lambda: defaultdict(list))
    usage = []
    rose_events = []
    infra_events = []
    stage_owners = set()
    for stage_root, stage in stages:
        tree = stage.get('tree')
        if tree:
            assert stage_root in tree and tree[stage_root].get('parent_agent_id') in (None, '')
            owned = {stage_root}
            while True:
                added = {key for key, node in tree.items() if node.get('parent_agent_id') in owned} - owned
                if not added:
                    break
                owned.update(added)
            assert owned == set(tree), 'unbound tree nodes'
            assert all(str(uuid.UUID(key)) == key for key in owned)
        else:
            assert len(roots) > 1, 'missing single-root tree'
            owned = {stage_root}
        assert not (owned & stage_owners), 'overlapping stage ownership'
        stage_owners.update(owned)
        for line in stage['worker_logs']:
            try:
                event = json.loads(line) if isinstance(line, str) else line
            except ValueError:
                continue
            if not isinstance(event, dict) or event.get('agent_id') not in owned:
                continue
            if event.get('root_agent_id') not in (None, stage_root):
                continue
            if _browser_state_timeout(event):
                infra_events.append(event)
            if event.get('event') == 'llm.cache':
                usage.append(event)
            elif event.get('event') in ROSE_EVIDENCE_EVENTS:
                rose_events.append(event)
            elif event.get('span_name') == 'llm.provider_read' and event.get('event') in ('span.start', 'span.end'):
                spans[event['span_id']][event['event']].append(event)

    eligible = {}
    occupied = []
    for span_id, group in spans.items():
        # Exact duplicate lines are harmless; conflicting copies cannot certify
        # success. Even an incomplete/error span occupies its time window so its
        # usage cannot be borrowed by another simultaneous query.
        starts = {json.dumps(e, sort_keys=True) for e in group['span.start']}
        ends = {json.dumps(e, sort_keys=True) for e in group['span.end']}
        identity = ('span_id', 'parent_span_id', 'agent_id', 'request_id', 'actual_model', 'attempt')
        for raw_start in starts:
            opening = json.loads(raw_start)
            if not all(opening.get(k) for k in ('span_id', 'parent_span_id', 'agent_id', 'request_id', 'actual_model')):
                continue
            try:
                began = stamp(opening['timestamp'])
            except (KeyError, ValueError, TypeError, AssertionError):
                continue
            if not start <= began <= finish:
                continue
            closing = json.loads(next(iter(ends))) if len(ends) == 1 else None
            ended = finish
            exact_end = closing is not None and all(opening.get(k) == closing.get(k) for k in identity)
            if exact_end:
                try:
                    ended = stamp(closing['timestamp'])
                except (KeyError, ValueError, TypeError, AssertionError):
                    exact_end = False
                    ended = finish
            if ended < began or ended > finish:
                exact_end = False
                ended = finish
            occupied.append((span_id, opening, began, ended))
            if len(starts) == 1 and exact_end and closing.get('status') == 'ok' and began <= ended <= finish:
                eligible[span_id] = (opening, closing)

    usage_slots = defaultdict(set)
    for event in usage:
        # A slot identifies one usage emission independently of its claimed
        # result. Conflicting values invalidate the slot; do not select only the
        # positive copy and silently discard the contrary one.
        key = tuple(event.get(k) for k in ('span_id', 'agent_id', 'actual_model', 'timestamp'))
        usage_slots[key].add(json.dumps(event, sort_keys=True))
    queries = {}
    for versions in usage_slots.values():
        if len(versions) != 1:
            continue
        event = json.loads(next(iter(versions)))
        tokens = event.get('completion_tokens')
        if not isinstance(tokens, int) or isinstance(tokens, bool) or tokens <= 0 or event.get('finish') not in ('stop', 'tool_calls'):
            continue
        try:
            when = stamp(event['timestamp'])
        except (KeyError, ValueError, TypeError, AssertionError):
            continue
        candidates = [span_id for span_id, opening, began, ended in occupied
                      if (event.get('span_id'), event.get('agent_id'), event.get('actual_model')) == (opening['parent_span_id'], opening['agent_id'], opening['actual_model'])
                      and began <= when <= ended]
        if len(candidates) != 1 or candidates[0] not in eligible:
            continue
        span_id = candidates[0]
        opening, closing = eligible[span_id]
        key = (opening['agent_id'], opening['request_id'])
        queries.setdefault(key, {'agent_id': key[0], 'request_id': key[1], 'provider_read_span_id': span_id, 'evidence_kind': 'provider_read_span', 'started_at': opening['timestamp'], 'completed_at': closing['timestamp'], 'completion_tokens': tokens, 'finish': event['finish']})
    for key, row in _rose_completed_queries(rose_events, usage, start, finish).items():
        queries.setdefault(key, row)
    # A genuine terminal request failure can be hidden by an ordinary task
    # FAILED verdict and enough unrelated successful queries. Recovered route
    # rejections are not terminal completion failures; cleanup after the task's
    # execution window is outside this progress proof. Ownership was checked
    # while collecting rose_events above, including composite-stage roots.
    failed_queries = []
    failures = [event for event in rose_events if event.get('event') == 'rose.complete.failed']
    for event in _unique_events(failures):
        when = stamp(event['timestamp'])
        if start <= when <= finish:
            failed_queries.append({key: event.get(key) for key in (
                'agent_id', 'request_id', 'span_id', 'timestamp',
                'error_type', 'active_route',
            )})
    failed_queries.sort(key=lambda e: (e['timestamp'], e['agent_id'], e['request_id'] or ''))
    infra_errors = []
    for event in _unique_events(infra_events):
        if start <= stamp(event['timestamp']) <= finish:
            # Keep response bodies out of portable reports. The input artifact
            # and exact event hashes retain the private evidence binding.
            infra_errors.append({
                'agent_id': event['agent_id'], 'timestamp': event['timestamp'],
                'error_type': 'BrowserStateInjectionTimeout',
                'event_sha256': hashlib.sha256(json.dumps(event, sort_keys=True).encode()).hexdigest(),
            })
    infra_errors.sort(key=lambda e: (e['timestamp'], e['agent_id'], e['event_sha256']))
    result = {'task': task['name'], 'agent_id': root, 'run_id': payload['run_id'], 'minimum_required': minimum, 'successful_llm_queries': len(queries), 'status': 'passed' if len(queries) >= minimum and not failed_queries and not infra_errors else 'failed', 'queries': sorted(queries.values(), key=lambda e: (e['completed_at'], e['agent_id'], e['request_id'])), 'failed_queries': failed_queries, 'infra_errors': infra_errors}
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run_dir', type=Path)
    parser.add_argument('report_json', type=Path)
    parser.add_argument('--minimum', type=int, default=3)
    parser.add_argument('--expected-count', type=int, default=10)
    args = parser.parse_args(argv)
    if args.minimum < 3 or args.expected_count < 1:
        parser.error('--minimum must be >=3 and --expected-count must be positive')
    run = args.run_dir.resolve()
    paths = sorted(run.glob('*/cloudbench-run.json'))
    if len(paths) != args.expected_count:
        print(f'expected {args.expected_count} task evidence files, found {len(paths)}', file=sys.stderr)
        return 70
    rows = []
    for path in paths:
        data = path.read_bytes()
        row = verify(json.loads(data), minimum=args.minimum)
        assert row['task'] == path.parent.name
        row.update(run_json=str(path), run_json_sha256=hashlib.sha256(data).hexdigest())
        rows.append(row)
    assert len({r['agent_id'] for r in rows}) == args.expected_count
    report = {'status': 'passed' if all(r['status'] == 'passed' for r in rows) else 'failed', 'scope': 'Successful LLM queries, terminal model-request failures and owned browser-state timeouts; startup, task outcome, other infrastructure and cleanup gates remain separately mandatory', 'minimum_per_benchmark': args.minimum, 'benchmark_count': args.expected_count, 'tasks': rows}
    target = args.report_json
    assert not target.exists(), 'preserve original evidence receipts'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'counts': {r['task']: r['successful_llm_queries'] for r in rows}, 'failed_query_counts': {r['task']: len(r['failed_queries']) for r in rows}, 'infra_error_counts': {r['task']: len(r['infra_errors']) for r in rows}}))
    return 0 if report['status'] == 'passed' else 70


if __name__ == '__main__':
    raise SystemExit(main())
