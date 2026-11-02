#!/usr/bin/env python3
"""Case-aware staged adapter over the existing isolated cloud benchmark CLI.

Native failures remain failures until canonical /RCA grants an exception. This
adapter neither retries nor launches the request's already-skipped tasks.
"""
import argparse
import hashlib
import math
import os
from pathlib import Path
import sys
import time

from cloudbench_execution_provenance import load_provenance, verify_code_binding
from cloudbench_result import validate_run_document, validate_run_file
from deploy_test_cycle import NAME, ROOT, read, source, write
from deploy_test_process import cancellation_handlers, run_command


def collect(request, root, runs, started, native_exit):
    cases = dict.fromkeys(request['checks'], 'UNVERIFIED')
    details = {}
    fleets = [p for p in runs.iterdir() if p.is_dir() and (p / '_batch').is_dir()]
    if len(fleets) != 1:
        raise ValueError('expected exactly one request-owned cloud fleet')
    fleet = fleets[0]
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
            task = read(child)['tasks'][0]
            outcome = str(task.get('benchmark_status') or task.get('status') or '').upper()
            if issues or not math.isfinite(finish) or finish < started or task.get('cleanup_failure'):
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


def execute(request, root):
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
    env = {**os.environ, 'CLOUDBENCH_RUNS_ROOT': str(runs), 'CLOUDBENCH_SKIP_LOCAL_PATCH': '1',
           'DEPLOY_LANE_SCOPED_REUSE': '0', 'DEPLOY_CYCLE_FRESH': '1'}
    argv = ['bash', 'scripts/run-bench', *checks, '--wait', '--ref', request['source']['head']]
    started = time.time()
    with cancellation_handlers(), (directory / 'cli.log').open('wb') as log:
        code, timed_out, cancelled, lingering = run_command(argv, cwd=root, env=env, output=log, timeout=None)
    reason = None
    try:
        if timed_out or cancelled or lingering or source(root) != request['source']:
            raise ValueError('cloud command interrupted or source changed')
        cases, details, cleaned, fleet = collect(request, root, runs, started, code)
    except (OSError, ValueError, KeyError, TypeError, IndexError) as error:
        cases, details, cleaned, fleet = dict.fromkeys(checks, 'UNVERIFIED'), {}, False, None
        reason = str(error)
    result = {k: request[k] for k in ('token', 'source', 'gate')}
    result.update(cases=cases, complete=all(v != 'UNVERIFIED' for v in cases.values()),
                  cleanup_complete=cleaned, reused=False, native_exit=code, native_command=argv,
                  evidence=details, reason=reason, fleet_directory=fleet,
                  runner_log=str(directory / 'cli.log'), started_at=started, finished_at=time.time())
    write(directory / 'result.json', result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    args = parser.parse_args()
    try:
        result = execute(read(Path(os.environ['DEPLOY_GATE_REQUEST'])), args.root.resolve())
        write(Path(os.environ['DEPLOY_GATE_RESULT']), result)
        return 0 if all(v == 'PASS' for v in result['cases'].values()) else 1
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f'DEPLOY_CLOUD BLOCKED: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
