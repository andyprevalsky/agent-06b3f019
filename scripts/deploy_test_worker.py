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
import select
import shutil
import subprocess
import sys
import time

from deploy_test_cycle import ROOT, command, digest, read, source, write
from deploy_test_isolation import validate_tmpdir_request
from deploy_test_process import CANCEL, cancellation_handlers, run_command

MAX_REQUEST_BYTES = 16 * 1024 * 1024


def prepare_checkout(root: Path, target: Path, copy_config: bool = False) -> dict:
    """Prepare a new checkout from committed source; never mutate an existing one."""
    root, target = root.resolve(), target.resolve()
    if target == root or root in target.parents or target in root.parents:
        raise ValueError('prepared checkout must be separate from the source')
    if target.exists() and any(target.iterdir()):
        raise ValueError('refusing to overwrite an existing worker checkout')
    expected = source(root)
    for args in (['diff', '--name-only', 'HEAD'], ['ls-files', '--others', '--exclude-standard']):
        paths = subprocess.run(['git', *args], cwd=root, capture_output=True,
                               text=True, check=True).stdout.splitlines()
        if any(not p.startswith('agents/benchmarks/history/') for p in paths):
            raise ValueError('commit the frozen source before preparing workers')
    subprocess.run(['git', 'clone', '--quiet', '--no-hardlinks', '--local', str(root), str(target)], check=True)
    subprocess.run(['git', 'checkout', '--quiet', '--detach', expected['head']], cwd=target, check=True)
    if copy_config:
        for rel in ('.env', 'env.sh', 'back-end/.env', 'agents/.env', 'agents/.env.benchmark-temporal',
                    'front-end/.env', 'front-end/.env.local'):
            origin, destination = root / rel, target / rel
            if origin.is_file():
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.touch(mode=0o600)
                destination.chmod(0o600)
                shutil.copyfile(origin, destination)
                destination.chmod(0o600)
    if source(root) != expected or source(target) != expected:
        raise ValueError('prepared checkout differs from the frozen source')
    return {'source': expected, 'worker_root': str(target), 'configuration_copied': copy_config}


def read_request(timeout: float) -> dict:
    """Bound a remote sender that never closes stdin or sends excessive data."""
    end = time.monotonic() + timeout
    chunks, size = [], 0
    while True:
        remaining = end - time.monotonic()
        if remaining <= 0 or not select.select([sys.stdin], [], [], remaining)[0]:
            raise ValueError('worker request timed out')
        chunk = os.read(sys.stdin.fileno(), min(65536, MAX_REQUEST_BYTES + 1 - size))
        if not chunk:
            break
        size += len(chunk)
        if size > MAX_REQUEST_BYTES:
            raise ValueError('worker request exceeds transport limit')
        chunks.append(chunk)
    return json.loads(b''.join(chunks))


def execute(request: dict, root: Path) -> dict:
    validate_tmpdir_request(request, root)
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
    if request.get('worker_root', str(root)) != str(root.resolve()):
        raise ValueError('worker ran in a different checkout than its isolation binding')
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
                  reused=False, evidence=rows, recipe_digest=digest(recipe), cleanup_complete=cleaned,
                  worker_root=str(root.resolve()))
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
    if code not in (0, 1) or timeout or cancelled or lingering or (code and spec.get('aggregate')):
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
    parser.add_argument('--request-timeout', type=float, default=30)
    parser.add_argument('--prepare-checkout', type=Path, help='new isolated checkout from the committed freeze')
    parser.add_argument('--copy-config', action='store_true', help='copy private config locally without printing it')
    args = parser.parse_args()
    try:
        if args.prepare_checkout:
            print(json.dumps(prepare_checkout(args.root, args.prepare_checkout, args.copy_config)))
            return 0
        if not math.isfinite(args.request_timeout) or args.request_timeout <= 0:
            raise ValueError('invalid request timeout')
        request = read_request(args.request_timeout) if args.stdio else read(Path(os.environ['DEPLOY_GATE_REQUEST']))
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
