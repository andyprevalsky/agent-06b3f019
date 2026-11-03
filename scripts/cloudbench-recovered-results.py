"""Read-only, hash-bound import of recovered sharded job classifications."""
import csv
import hashlib
import io
import re
import json
from pathlib import Path


def need(value, message):
    if not value:
        raise ValueError('recovered results: ' + message)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def descriptor(path):
    path = Path(path).resolve(strict=True)
    return {'path': str(path), 'sha256': digest(path.read_bytes())}


def read_file(item):
    raw = Path(item['path']).read_bytes()
    need(digest(raw) == item['sha256'], 'source hash changed: ' + item['path'])
    return raw


def binding(run):
    run = Path(run).resolve(strict=True)
    paths = [run / 'coordination.json', run / 'hub-group/hub-group.json', run / 'shards.private.json']
    for shard in sorted(run.glob('shard-*')):
        paths += [shard / 'attempt-start.safe.json', shard / 'config.private.json', shard / 'run/export/launch.json']
        paths += [p for p in (shard / 'run/terminal.json', shard / 'run/export/disposable-export.verified.json') if p.exists()]
    return {str(p.relative_to(run)): descriptor(p) for p in paths}


def prepare(run, results, accepted, jobs, hub):
    run = Path(run).resolve(strict=True)
    value = {'schema': 'cloudbench-recovered-results-v1', 'run_dir': str(run), 'run_id': run.name,
             'originals': binding(run), 'inputs': {k: descriptor(p) for k, p in
             [('results', results), ('accepted', accepted), ('jobs', jobs), ('hub', hub)]}}
    rows(value, run)  # Refuse an invalid import before writing any sidecar.
    return value


def rows(value, run):
    run = Path(run).resolve(strict=True)
    need(value['schema'] == 'cloudbench-recovered-results-v1', 'unsupported schema')
    need(value['run_dir'] == str(run) and value['run_id'] == run.name, 'wrong run')
    need(value['originals'] == binding(run), 'original run binding changed')
    originals = {k: json.loads(read_file(v)) for k, v in value['originals'].items()}
    raw = {k: read_file(v) for k, v in value['inputs'].items()}
    group = originals['hub-group/hub-group.json']
    members = group['run_group']['members']
    expected = {(m['name'], int(m['run_number']), m['member_id']) for m in members}
    total = originals['coordination.json']['scheduled_total']
    need(len(expected) == len(members) == total, 'duplicate/incomplete run members')
    refs = {v['source_ref'] for k, v in originals.items() if k.endswith('attempt-start.safe.json')}
    need(len(refs) == 1 and re.fullmatch('[0-9a-f]{40}', next(iter(refs))) is not None, 'ambiguous original source SHA')
    controllers = {}
    for key, config in originals.items():
        if not key.endswith('config.private.json'):
            continue
        launch = originals[key.rsplit('/', 1)[0] + '/run/export/launch.json']
        need(launch['source_ref'] in refs and config['source_ref'] in refs, 'controller source differs')
        need(config['shard']['group_run_id'] == group['run_id'], 'controller group differs')
        for task in config['shard']['tasks']:
            need(task not in controllers, 'duplicate task controller')
            controllers[task] = launch['machine_id']
    parsed = list(csv.DictReader(io.StringIO(raw['results'].decode())))
    keys = [(r['task'], int(r['K']), r['job_id']) for r in parsed]
    need(len(keys) == len(set(keys)) and set(keys) == expected, 'duplicate/missing/wrong task K job identity')
    accepted = list(csv.DictReader(io.StringIO(raw['accepted'].decode())))
    grades = {r['benchmark']: r for r in accepted}
    need(len(grades) == len(accepted), 'duplicate accepted-grade task')
    job_rows = [json.loads(line) for line in raw['jobs'].decode().splitlines() if line.strip()]
    job_keys = [(r['task'], int(r['run']), r['job']) for r in job_rows]
    need(len(job_keys) == len(set(job_keys)) and set(job_keys) == expected, 'job snapshot identities differ')
    jobs = dict(zip(job_keys, job_rows))
    hub_rows = json.loads(raw['hub'])
    hubs = {r['run_id']: r for r in hub_rows}
    need(len(hubs) == len(hub_rows) == total, 'duplicate/incomplete Hub snapshot')
    need({r['hub_run_id'] for r in parsed} == set(hubs), 'Hub run identities differ')
    output, observations = [], []
    for key, r in zip(keys, parsed):
        task, k, job_id = key
        j, h = jobs[key], hubs[r['hub_run_id']]
        verdict = r['verdict']
        need(verdict in ('PASS', 'FAIL', 'INFRA'), 'unsupported classification')
        need(task in grades, 'missing accepted-grade task')
        grade = grades[task]['K' + str(k)]
        need(grade == (verdict if verdict != 'INFRA' else 'UNGRADED'), 'accepted grade conflict: ' + job_id)
        need(r['controller'] == j['machine'] == controllers[task], 'controller differs: ' + job_id)
        need(h['name'] == task and r['hub_run_id'].rsplit('-m', 1)[0] == r['fleet_run'], 'Hub/fleet identity differs')
        need(j.get('run_id') in (None, r['fleet_run']), 'job fleet differs')
        need((h.get('agent_id') or '') == r['agent_id'], 'agent identity differs')
        hub_verdict = {'passed': 'PASS', 'failed': 'FAIL', 'INFRA_ERROR': 'INFRA'}.get(h['status'])
        need(hub_verdict == verdict, 'Hub classification conflict: ' + job_id)
        job_verdict = {'PASSED': 'PASS', 'FAILED': 'FAIL', 'INFRA_ERROR': 'INFRA'}.get(j.get('task_status'))
        need(job_verdict is None or job_verdict == verdict, 'recorded job grade conflict: ' + job_id)
        need(verdict != 'INFRA' or bool(r['failure_reason']), 'infra evidence reason missing')
        if verdict == 'INFRA':
            need(h.get('passed') is None and not r['agent_id'], 'infra would override accepted Hub grade')
        else:
            need(h.get('passed') is (verdict == 'PASS'), 'accepted Hub grade differs')
        row = {'job_id': job_id, 'task': task, 'run': k,
               'status': 'passed' if verdict == 'PASS' else 'failed',
               'task_status': {'PASS': 'PASSED', 'FAIL': 'FAILED', 'INFRA': 'INFRA_ERROR'}[verdict],
               'infra_failure': verdict == 'INFRA', 'attempts': j['attempts'],
               'terminal_attempts': j['attempts'], 'infra_attempts': j['attempts'] if verdict == 'INFRA' else 0,
               'released': j.get('released'), 'lifecycle': None, 'wall_s': j.get('wall'),
               'reason': r['failure_reason'], 'agent_id': r['agent_id'] or None,
               'exec_s': float(r['duration_s']) if r['duration_s'] else None,
               'cost_usd': float(r['cost_usd']) if r['cost_usd'] else None,
               'unmetered': ['infra', 'wmh_grounding']}
        output.append(row)
        observations.append({'job_id': job_id, 'job_snapshot': j, 'hub_snapshot': h,
                             'recovered_verdict': verdict, 'accepted_grade': grade})
    return output, {'source_ref': next(iter(refs)), 'group_run_id': group['run_id'],
                    'inputs': value['inputs'], 'originals': value['originals'], 'observations': observations}
