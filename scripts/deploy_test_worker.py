#!/usr/bin/env python3
"""Execute an explicit case recipe on a prepared, isolated deploy worker.

The caller owns provisioning and teardown. This program cannot allocate hosts,
grant waivers, or turn a failed setup into a completed test. --stdio supports
existing SSH/container transports without shared request/result paths.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import time

from deploy_test_cycle import ROOT, command, digest, read, source, write
from deploy_test_process import CANCEL, cancellation_handlers, run_command


def execute(request: dict, root: Path) -> dict:
    recipe = request['worker_recipe']
    cases = recipe['cases']
    selected, skipped = request['checks'], request.get('skips', {})
    if (not isinstance(cases, dict) or not cases or len(set(selected)) != len(selected)
            or set(selected) & set(skipped) or not set(selected) <= cases.keys()
            or not set(skipped) <= cases.keys()):
        raise ValueError('worker case inventory mismatch')
    if request['phase'] != 'focused' and set(selected) | set(skipped) != cases.keys():
        raise ValueError('full gate omitted registered cases')
    if source(root) != request['source']:
        raise ValueError('worker source differs from requested freeze')
    for case in cases.values():
        command(case['command'])
    for spec in [*cases.values(), recipe.get('setup'), recipe.get('cleanup')]:
        if not spec:
            continue
        command(spec['command'])
        timeout = spec.get('timeout_seconds')
        if timeout is not None and (type(timeout) not in (int, float) or not math.isfinite(timeout) or timeout <= 0):
            raise ValueError('invalid worker timeout')
    if recipe.get('services') and not recipe.get('cleanup'):
        raise ValueError('service recipes require explicit owned cleanup')
    folder = root / '.context' / 'deploy-worker' / hashlib.sha256(request['token'].encode()).hexdigest()
    folder.mkdir(parents=True, exist_ok=False)
    rows = {}
    setup_ok = True
    with cancellation_handlers():
        try:
            if recipe.get('setup'):
                setup_ok = run_step('setup', recipe['setup'], root, folder)['status'] == 'PASS'
            for name in selected:
                if not setup_ok or CANCEL.is_set():
                    rows[name] = {'status': 'UNVERIFIED', 'reason': 'setup failed or worker interrupted'}
                else:
                    rows[name] = run_step(name, cases[name], root, folder)
        finally:
            cleanup = recipe.get('cleanup')
            if cleanup:
                # Teardown is allowed to finish after cancellation of its tests.
                interrupted = CANCEL.is_set()
                CANCEL.clear()
                cleaned = run_step('cleanup', cleanup, root, folder)['status'] == 'PASS'
                if interrupted:
                    CANCEL.set()
            else:
                cleaned = recipe.get('services') is not True
        same_source = source(root) == request['source']
        if not cleaned or not same_source:
            rows = {name: {**row, 'status': 'UNVERIFIED',
                           'reason': 'cleanup failed or source changed'} for name, row in rows.items()}
    statuses = {name: row['status'] for name, row in rows.items()}
    result = {k: request[k] for k in ('token', 'source', 'gate')}
    result.update(cases=statuses, complete=all(s in ('PASS', 'FAIL') for s in statuses.values()),
                  reused=False, evidence=rows, recipe_digest=digest(recipe), cleanup_complete=cleaned)
    write(folder / 'result.json', result)
    return result


def run_step(name: str, spec: dict, root: Path, folder: Path) -> dict:
    log = folder / (hashlib.sha256(name.encode()).hexdigest() + '.log')
    env = {**os.environ, **spec.get('env', {}), 'DEPLOY_LANE_SCOPED_REUSE': '0', 'DEPLOY_CYCLE_FRESH': '1'}
    started = time.time()
    with log.open('wb') as stream:
        code, timeout, cancelled, lingering = run_command(command(spec['command']),
            cwd=root / spec.get('cwd', '.'), env=env, output=stream, timeout=spec.get('timeout_seconds'))
    status = 'PASS' if code == 0 else 'FAIL'
    if code not in (0, 1) or timeout or cancelled or lingering:
        status = 'UNVERIFIED'
    raw = log.read_bytes()
    return {'status': status, 'native_exit': code, 'command': spec['command'],
            'started_at': started, 'finished_at': time.time(), 'timed_out': timeout,
            'cancelled': cancelled, 'lingering_group': lingering, 'log': str(log),
            'sha256': hashlib.sha256(raw).hexdigest(), 'tail': raw[-65536:].decode(errors='replace')}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--stdio', action='store_true')
    args = parser.parse_args()
    try:
        request = json.load(sys.stdin) if args.stdio else read(Path(os.environ['DEPLOY_GATE_REQUEST']))
        result = execute(request, args.root.resolve())
        if args.stdio:
            print(json.dumps(result))
        else:
            write(Path(os.environ['DEPLOY_GATE_RESULT']), result)
        return 0 if all(s == 'PASS' for s in result['cases'].values()) else 1
    except (ImportError, KeyError, TypeError, ValueError, OSError) as error:
        print(f'DEPLOY_WORKER BLOCKED: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
