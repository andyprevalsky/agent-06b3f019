#!/usr/bin/env python3
"""Case-aware staged adapter over the existing isolated cloud benchmark CLI.

Native failures remain failures until canonical /RCA grants an exception. This
adapter neither retries nor launches the request's already-skipped tasks.
"""
import argparse
from datetime import datetime
import hashlib
import json
import math
import os
import runpy
from pathlib import Path
import sys
import subprocess
import time

from cloudbench_execution_provenance import load_provenance, verify_code_binding
from cloudbench_result import validate_run_document, validate_run_file
from deploy_test_cycle import NAME, ROOT, read, source, write
from deploy_test_process import cancellation_handlers, run_command


def collect(request, root, runs, started, native_exit):
    fleets = [p for p in runs.iterdir() if p.is_dir() and (p / '_batch').is_dir()]
    if len(fleets) != 1:
        raise ValueError('expected exactly one request-owned cloud fleet')
    return collect_fleet(request, root, fleets[0], started, native_exit)


def collect_fleet(request, root, fleet, started, native_exit):
    cases = dict.fromkeys(request['checks'], 'UNVERIFIED')
    details = {}
    provenance = load_provenance(fleet / 'execution-provenance.json')
    verify_code_binding(provenance, base_sha=request['source']['head'], workspace_patch_sha256='none')
    lifecycle = read(fleet / '_batch/lifecycle.json')
    audit_rows = [line.split('=', 1) for line in
                  (fleet / 'teardown-ownership/source-audit').read_text().splitlines()]
    if any(len(row) != 2 for row in audit_rows) or len(dict(audit_rows)) != len(audit_rows):
        raise ValueError('invalid native teardown audit')
    audit = dict(audit_rows)
    release = float((fleet / 'teardown-ownership/provider-teardown-verified.epoch').read_text())
    if (type(lifecycle.get('version')) is not int or lifecycle['version'] != 1
            or lifecycle.get('status') != 'verified' or lifecycle.get('run_id') != fleet.name
            or lifecycle.get('workspace_root') != str(root)
            or type(lifecycle.get('controller_exit_code')) is not int
            or lifecycle.get('controller_exit_code') != native_exit
            or native_exit not in (0, 1) or not math.isfinite(release) or release < started
            or audit.get('sha256') != lifecycle.get('audit_sha256')
            or not isinstance(lifecycle.get('audit_sha256'), str) or len(lifecycle['audit_sha256']) != 64
            or any(c not in '0123456789abcdef' for c in lifecycle['audit_sha256'])
            or not isinstance(lifecycle.get('fleet_owner_token'), str)
            or not lifecycle['fleet_owner_token'] or lifecycle.get('hub_publication_failed') is not False):
        raise ValueError('cloud ownership, exit or native cleanup was not verified')
    aggregate = read(fleet / '_batch/run.json')
    errors = validate_run_document(aggregate, request['checks'], not_before_epoch=started,
                                  expected_execution_provenance=provenance)
    if errors or aggregate.get('run_id') != fleet.name:
        raise ValueError('cloud aggregate does not match the requested source/inventory')
    for name in request['checks']:
        child = fleet / name / 'cloudbench-run.json'
        try:
            issues = validate_run_file(child, [name], not_before_epoch=started,
                                       expected_execution_provenance=provenance)
            finish = float((fleet / name / 'bench-e2e.finished-epoch').read_text())
            tasks = read(child).get('tasks')
            if issues or not isinstance(tasks, list) or len(tasks) != 1 or not isinstance(tasks[0], dict):
                raise ValueError('unverified native task document')  # finding 4447557526
            task = tasks[0]
            outcome = str(task.get('benchmark_status') or task.get('status') or '').upper()
            if not math.isfinite(finish) or finish < started or task.get('cleanup_failure'):
                raise ValueError('unverified native task or task cleanup')
            if task.get('passed') is True and outcome == 'PASSED':
                cases[name] = 'PASS'
            elif task.get('passed') is False and outcome in {'FAILED', 'ERROR', 'INFRA_ERROR', 'SKIPPED'}:
                cases[name] = 'FAIL'
            details[name] = {'native_task': {k: task.get(k) for k in ('name','status','benchmark_status','passed','failure_reason','agent_id')}, 'path': str(child),
                             'sha256': hashlib.sha256(child.read_bytes()).hexdigest()}
        except (OSError, ValueError, KeyError, TypeError, IndexError) as error:
            details[name] = {'unverified': str(error), 'path': str(child)}
    if native_exit != 0 and all(v == 'PASS' for v in cases.values()):
        cases = dict.fromkeys(cases, 'UNVERIFIED')
    return cases, details, True, str(fleet)


def campaign_width(checks):
    capacity = runpy.run_path(str(Path(__file__).with_name('cloudbench-provider-capacity.py')))
    registry = capacity['for_browser_provider'](capacity['load_registry'](),
                                               capacity['resolve_browser_provider']())
    return min(len(checks), registry['cap'])


def campaign_published(summary, campaign, started, native):
    record_path = campaign / 'hub-group.json'
    ack_path = campaign / 'hub-group-publication-ack.private.json'
    if record_path.is_symlink() or ack_path.is_symlink():
        return False
    record, ack = read(record_path), read(ack_path)
    expected = native['campaign_group_record'](summary)
    group = record['run_group']
    # The native producer seals publication before updating its final timing.
    finish = datetime.fromisoformat(group['finished_at']).timestamp()
    if not started <= finish <= datetime.fromisoformat(summary['finished_at']).timestamp():
        return False
    for key in ('finished_at', 'wall_clock_seconds'):
        expected['run_group'][key] = group.get(key)
    if (record != expected or set(ack) != {'pid', 'token', 'record_sha256'}
            or type(ack['pid']) is not int or ack['pid'] <= 1
            or not isinstance(ack['token'], str) or len(ack['token']) != 32
            or any(c not in '0123456789abcdef' for c in ack['token'])
            or ack['record_sha256'] != hashlib.sha256(json.dumps(record, sort_keys=True).encode()).hexdigest()):
        return False
    processes = subprocess.check_output(['ps', '-ax', '-o', 'pid=,pgid=,stat='], text=True)
    return not any(int(row.split()[1]) == ack['pid'] and not row.split()[2].startswith('Z')
                   for row in processes.splitlines())


def collect_campaign(request, root, runs, campaign, started, native_exit, width):
    summary = read(campaign / 'summary.json')
    jobs = summary.get('jobs')
    expected = set(request['checks'])
    if (summary.get('campaign_id') != campaign.name or summary.get('runs') != 1
            or summary.get('retry_infra') != 0 or summary.get('concurrency') != width
            or summary.get('task_count') != len(expected) or summary.get('total_jobs') != len(expected)
            or type(summary.get('peak_concurrency')) is not int
            or not 0 <= summary['peak_concurrency'] <= width
            or summary.get('status') not in {'passed', 'failed', 'cancelled'}
            or not isinstance(jobs, list) or len(jobs) != len(expected)
            or any(not isinstance(job, dict) for job in jobs)
            or {job.get('task') for job in jobs} != expected
            or len({job.get('job_id') for job in jobs}) != len(jobs)
            or any(not isinstance(job.get('job_id'), str) or not job['job_id']
                   or job.get('run') != 1 or job.get('attempt') != 1 or job.get('attempts') != []
                   for job in jobs)):
        raise ValueError('campaign identity, inventory or concurrency mismatch')
    for field in ('started_at', 'finished_at'):
        stamp = datetime.fromisoformat(summary[field]).timestamp()
        if not math.isfinite(stamp) or stamp < started:
            raise ValueError('campaign timestamp predates request')
    native = runpy.run_path(str(Path(__file__).with_name('run-bench-campaign.py')))
    cases = dict.fromkeys(request['checks'], 'UNVERIFIED')
    details = {}
    cleaned = not any(summary.get(key) for key in (
        'shared_transport_cleanup_pending', 'cleanup_ticket_failure', 'shared_inventory_failed'))
    cleaned = cleaned and not any(cohort.get('cleanup_budget_retirement_pending')
                                  for cohort in summary.get('startup_cohorts', []))
    try:
        cleaned = cleaned and campaign_published(summary, campaign, started, native)
    except (OSError, ValueError, KeyError, TypeError, IndexError, subprocess.SubprocessError):
        cleaned = False
    seen = set()
    for job in jobs:
        name = job['task']
        try:
            if job.get('status') not in {'passed', 'failed'}:
                raise ValueError('campaign job did not terminate normally')
            log = Path(job['log'])
            if not log.resolve().is_relative_to(campaign.resolve()) or log.is_symlink():
                raise ValueError('campaign job log is not request-owned')
            found = native['terminal_task'](root, job)
            if found is None:
                raise ValueError('campaign job has no native fleet handle')
            fleet = found[0]
            if not fleet.is_relative_to(runs.resolve()) or fleet in seen:
                raise ValueError('campaign fleet is outside request or duplicated')
            seen.add(fleet)
            one, evidence, released, _ = collect_fleet(
                {**request, 'checks': [name]}, root, fleet, started, job['controller_exit_code'])
            cases.update(one)
            details.update(evidence)
            cleaned = cleaned and released and one[name] != 'UNVERIFIED'
        except (OSError, ValueError, KeyError, TypeError, IndexError) as error:
            details[name] = {'unverified': str(error)}
            cleaned = False
    if native_exit != 0 and all(value == 'PASS' for value in cases.values()):
        cases = dict.fromkeys(cases, 'UNVERIFIED')
        cleaned = False
    return cases, details, cleaned, str(campaign)


def execute(request, root):
    """Run the frozen native campaign with owned supervision and retain its cleanup evidence."""
    checks, skipped = request['checks'], request.get('skips', {})
    if (not checks or len(set(checks)) != len(checks) or set(checks) & set(skipped)
            or any(not isinstance(n, str) or not NAME.fullmatch(n) or n.startswith('-')
                   or n in {'.','..'} for n in checks)):
        raise ValueError('invalid cloud case inventory')
    if source(root) != request['source']:
        raise ValueError('cloud source differs from the requested freeze')
    directory = root / '.context/deploy-cloud' / hashlib.sha256(request['token'].encode()).hexdigest()
    runs = directory / 'runs'
    runs.mkdir(parents=True, exist_ok=False)
    width = campaign_width(checks)
    if width < 1:
        raise ValueError('provider capacity cannot admit one smoke task')
    campaign = directory / 'campaigns' / ('deploy-' + directory.name)
    env = {**os.environ, 'CLOUDBENCH_RUNS_ROOT': str(runs), 'CLOUDBENCH_SKIP_LOCAL_PATCH': '1',
           'DEPLOY_NATIVE_HUB_JOIN': '1',
           'RUN_BENCH_CAMPAIGN_ROOT': str(campaign.parent), 'RUN_BENCH_CAMPAIGN_ID': campaign.name,
           'DEPLOY_LANE_SCOPED_REUSE': '0', 'DEPLOY_CYCLE_FRESH': '1'}
    scheduling = ['--runs', '1', '--concurrency', str(width), '--retry-infra', '0']
    argv = ['bash', 'scripts/run-bench', *checks, *scheduling, '--ref', request['source']['head']]
    catalog = root / 'agents/benchmarks/tasks.json'
    guidance = ''
    if catalog.is_file():
        selector = runpy.run_path(str(Path(__file__).resolve().parents[1]
                                     / 'agents/benchmarks/select_predeploy_benches.py'))
        guidance = selector['format_skip_eligibility'](
            selector['standing_skip_eligibility'](selector['load_tasks'](catalog), checks))
    started = time.time()
    with cancellation_handlers(), (directory / 'cli.log').open('wb') as log:
        if guidance:
            print(guidance, file=sys.stderr, flush=True)
            log.write((guidance + '\n').encode())
            log.flush()
        code, timed_out, cancelled, lingering = run_command(argv, cwd=root, env=env, output=log, timeout=None, owned_lifecycle=True)
    reason = None
    try:
        if timed_out or cancelled or lingering or source(root) != request['source']:
            raise ValueError('cloud command interrupted or source changed')
        cases, details, cleaned, fleet = collect_campaign(
            request, root, runs, campaign, started, code, width)
    except (OSError, ValueError, KeyError, TypeError, IndexError) as error:
        cases, details, cleaned, fleet = dict.fromkeys(checks, 'UNVERIFIED'), {}, False, None
        reason = str(error)
    result = {k: request[k] for k in ('token', 'source', 'gate')}
    result.update(cases=cases, complete=cleaned and all(v != 'UNVERIFIED' for v in cases.values()),
                  cleanup_complete=cleaned, reused=False, native_exit=code, native_command=argv,
                  evidence=details, reason=reason, fleet_directory=fleet,
                  runner_log=str(directory / 'cli.log'), started_at=started, finished_at=time.time())
    write(directory / 'result.json', result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    args = parser.parse_args()
    request = None
    try:
        request = read(Path(os.environ['DEPLOY_GATE_REQUEST']))
        result = execute(request, args.root.resolve())
        write(Path(os.environ['DEPLOY_GATE_RESULT']), result)
        return 0 if result['complete'] and all(v == 'PASS' for v in result['cases'].values()) else 1
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f'DEPLOY_CLOUD BLOCKED: {error}', file=sys.stderr)
        return 2
    except Exception as error:  # unexpected: still a fail-closed UNVERIFIED receipt, distinct exit (finding 4447557526)
        print(f'DEPLOY_CLOUD UNVERIFIED: {type(error).__name__}: {error}', file=sys.stderr)
        if isinstance(request, dict) and 'DEPLOY_GATE_RESULT' in os.environ:
            receipt = {k: request.get(k) for k in ('token', 'source', 'gate')}
            receipt.update(cases=dict.fromkeys(request.get('checks', []), 'UNVERIFIED'), complete=False,
                           cleanup_complete=False, reused=False, evidence={},
                           reason=f'unexpected adapter error: {type(error).__name__}: {error}')
            write(Path(os.environ['DEPLOY_GATE_RESULT']), receipt)
        return 3


if __name__ == '__main__':
    raise SystemExit(main())
