#!/usr/bin/env python3
"""Stress campaign's app-scoped native mutation admission; no provider calls."""
from __future__ import annotations

import argparse
import hashlib
import fcntl
import types
import json
import math
import os
import subprocess
import sys
import time
import uuid

HOST = os.uname().nodename
sys.dont_write_bytecode = True
from pathlib import Path

# Validate the parent-minted, Git-bound authority bytes before importing any
# mutation dependency. Native recipe approval includes these same source blobs.
AUTHORITY = json.loads(os.environ['CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY'])
if set(AUTHORITY) != {'directory', 'owner', 'source'} or set(AUTHORITY['source']) != {'ref', 'sha256'}:
    raise ValueError('missing immutable mutation authority binding')
checked = {}
for name in ('cloudbench-campaign-mutation.py', 'cloudbench-script-snapshot.py'):
    checked[name] = Path(__file__).with_name(name).read_bytes()
    actual = hashlib.sha256(checked[name]).hexdigest()
    if AUTHORITY['source']['sha256'].get(name) != actual:
        raise ValueError('mutation authority bytes differ from approved source binding')

IDENTITY = types.ModuleType('snapshot_identity')
identity_path = Path(__file__).with_name('cloudbench-script-snapshot.py')
IDENTITY.__file__ = str(identity_path)
exec(compile(checked['cloudbench-script-snapshot.py'], str(identity_path), 'exec'), IDENTITY.__dict__)


def birth(pid: int) -> str:
    if Path('/proc/self/stat').exists():
        stat = Path(f'/proc/{pid}/stat').read_text()
        ticks = stat[stat.rfind(')') + 2:].split()[19]
        boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        return f'proc-start:{boot}:{ticks}'
    return subprocess.check_output(['ps', '-p', str(pid), '-o', 'lstart='], text=True).strip()


def regular(path: Path) -> None:
    if path.is_symlink() or not path.is_file() or path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o022:
        raise ValueError('unsafe mutation admission file')


def live(pid: int, expected: str) -> bool:
    return IDENTITY._process_identity_state(pid, expected) == 'match'


def caller_ancestor(pid: int) -> bool:
    current = os.getppid()
    for _ in range(128):
        if current == pid:
            return True
        if current <= 1:
            return False
        if Path('/proc/self/stat').exists():
            stat = Path(f'/proc/{current}/stat').read_text()
            current = int(stat[stat.rfind(')') + 2:].split()[1])
        else:
            current = int(subprocess.check_output(['ps', '-p', str(current), '-o', 'ppid='], text=True).strip())
    return False


def feed(app: str, *, validate_inventory: bool = False) -> bool:
    """Fence parent/publisher births; temporary absence never permits mutation."""
    directory = Path(os.environ['CLOUDBENCH_CAMPAIGN_INVENTORY_DIR'])
    expected = AUTHORITY
    if set(expected) != {'directory', 'owner', 'source'} or directory.is_symlink() or str(directory.resolve()) != expected['directory']:
        raise ValueError('foreign mutation admission inventory scope')
    owner = directory / 'owner'
    regular(owner)
    pairs = [line.split('=', 1) for line in owner.read_text().splitlines()]
    if any(len(pair) != 2 for pair in pairs):
        raise ValueError('malformed mutation admission owner')
    fields = dict(pairs)
    if len(fields) != len(pairs) or set(fields) != {'app', 'pid', 'pid_start', 'token', 'parent_pid', 'parent_start'}:
        raise ValueError('malformed mutation admission owner fields')
    if fields != expected['owner']:
        raise ValueError('foreign mutation admission publisher authority')
    if fields.get('app') != app or not fields.get('token'):
        raise ValueError('foreign mutation admission campaign')
    if not caller_ancestor(int(fields['parent_pid'])):
        raise ValueError('mutation caller is outside the owning campaign ancestry')
    for pid, stamp in [('pid', 'pid_start'), ('parent_pid', 'parent_start')]:
        if int(fields[pid]) < 1 or not live(int(fields[pid]), fields[stamp]):
            raise ValueError('mutation admission campaign owner is not alive')
    health = directory / 'inventory/current/health'
    snapshot = directory / 'machines.json'
    if not health.exists() or not snapshot.exists():
        return False
    regular(health)
    regular(snapshot)
    if not health.stat().st_size or not snapshot.stat().st_size:
        return False
    health_fields = dict(line.split('=', 1) for line in health.read_text().splitlines())
    if health_fields.get('publisher_token') != fields['token']:
        raise ValueError('foreign mutation admission feed token')
    expiry = health_fields['valid_until']
    if not expiry.isdigit():
        raise ValueError('malformed mutation admission feed health')
    if validate_inventory and not isinstance(json.loads(snapshot.read_text()), list):
        raise ValueError('malformed mutation admission inventory')
    return int(expiry) >= time.time()


def strict_primary_deadline(args: argparse.Namespace) -> float:
    """Use only the original held strict manifest and original parent clock."""
    directory = Path(AUTHORITY['directory'])
    barrier = Path(os.environ['RUN_BENCH_CAMPAIGN_BARRIER_DIR'])
    cohort = os.environ['RUN_BENCH_CAMPAIGN_COHORT']
    job = os.environ['RUN_BENCH_CAMPAIGN_JOB_ID']
    if (barrier.is_symlink() or barrier.name != cohort
            or barrier.parent.resolve() != (directory.parent / 'startup-cohorts').resolve()):
        raise ValueError('foreign strict clone queue')
    manifest = barrier / 'manifest.json'
    regular(manifest)
    record = json.loads(manifest.read_text())
    if record.get('cohort_id') != cohort or not isinstance(record.get('jobs'), dict):
        raise ValueError('invalid strict clone membership')
    if type(record['jobs'].get(job)) is not int or record['jobs'][job] != args.owner_pid:
        raise ValueError('strict clone owner changed')
    deadline = record.get('e2e_deadline_monotonic')
    if (isinstance(deadline, bool) or not isinstance(deadline, (int, float))
            or not math.isfinite(deadline) or deadline <= time.monotonic()
            or str(deadline) != os.environ.get('RUN_BENCH_CAMPAIGN_E2E_DEADLINE_MONOTONIC')):
        raise ValueError('expired or invalid original campaign deadline')
    parent_lock = barrier.parent / 'parent.lock'
    regular(parent_lock)
    with parent_lock.open('r') as held:
        try:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            pass
        else:
            fcntl.flock(held, fcntl.LOCK_UN)
            raise ValueError('strict campaign parent lock is not held')
    if args.task_root is None or args.task_root.is_symlink():
        raise ValueError('missing owned primary task root')
    runs = directory.parents[3] / 'fleet' / 'runs'
    task = args.task_root.resolve()
    if not task.is_relative_to(runs.resolve()) or task.name != os.environ.get('RUN_BENCH_CAMPAIGN_TASK'):
        raise ValueError('foreign primary task root')
    strict_primary_not_finished(barrier, task)
    return float(deadline)


def strict_primary_not_finished(barrier: Path, task: Path) -> None:
    if (barrier / 'abort.json').exists() or (task / 'benchmark-child.finished').exists() or (task / 'autoscaler.runtime-completed').exists():
        raise ValueError('strict clone campaign cancelled or task finished')


def provider_backoff(path: Path, app: str) -> float:
    regular(path)
    record = json.loads(path.read_text())
    if (set(record) != {'app', 'host', 'until', 'response_code'}
            or record['app'] != app or record['host'] != HOST
            or record['response_code'] not in ('429', 'resource_exhausted')
            or isinstance(record['until'], bool) or not isinstance(record['until'], (int, float))
            or not math.isfinite(record['until']) or record['until'] < 0):
        raise ValueError('foreign or malformed provider backoff')
    return float(record['until'])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['pace', 'acquire', 'release', 'start-native', 'join-native', 'backoff'])
    parser.add_argument('--app', required=True)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--owner-pid', type=int, required=True)
    parser.add_argument('--owner-start', default=os.environ.get('CLOUDBENCH_MUTATION_CALLER_START'))
    parser.add_argument('--wait-seconds', type=int)
    parser.add_argument('--slots', type=int, default=4)
    parser.add_argument('--lease', default='')
    parser.add_argument('--response-code', choices=['429', 'resource_exhausted'])
    parser.add_argument('--retry-after', type=float)
    parser.add_argument('--native-owner-pid', type=int)
    parser.add_argument('--strict-primary', action='store_true')
    parser.add_argument('--print-budget', action='store_true')
    parser.add_argument('--task-root', type=Path)
    args = parser.parse_args()
    if args.owner_pid < 1 or args.slots < 1 or not args.app or '/' in args.app:
        raise ValueError('invalid mutation admission contract')
    os.umask(0o077)
    owner_birth = args.owner_start
    if not owner_birth or not live(args.owner_pid, owner_birth) or not caller_ancestor(args.owner_pid):
        raise ValueError('foreign or reused mutation caller')
    directory = args.root / 'campaign-native-mutations'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if directory.is_symlink() or directory.stat().st_uid != os.getuid() or directory.stat().st_mode & 0o022:
        raise ValueError('unsafe mutation admission directory')
    lock_path = directory / 'lock'
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    regular(lock_path)
    with os.fdopen(fd, 'r+') as lock:
        if args.action in ['release', 'start-native', 'join-native']:
            token = uuid.UUID(args.lease).hex
            fcntl.flock(lock, fcntl.LOCK_EX)
            path = directory / f'lease-{token}.json'
            regular(path)
            record = json.loads(path.read_text())
            if set(record) != {'app', 'host', 'pid', 'birth', 'token', 'native_pid', 'native_birth', 'joined'}:
                raise ValueError('malformed native mutation lease')
            if any(record.get(key) != value for key, value in {'app': args.app, 'host': HOST, 'pid': args.owner_pid, 'birth': owner_birth, 'token': token}.items()):
                raise ValueError('foreign mutation admission lease')
            if args.action == 'release':
                if record.get('joined') is not True:
                    raise ValueError('native mutation child has no joined receipt')
                path.unlink()
            else:
                if args.native_owner_pid is None or args.native_owner_pid < 1:
                    raise ValueError('missing native mutation owner')
                if not caller_ancestor(args.native_owner_pid):
                    raise ValueError('foreign native mutation owner ancestry')
                native_birth = birth(args.native_owner_pid)
                if args.action == 'start-native':
                    if not feed(args.app, validate_inventory=True):
                        raise ValueError('native mutation feed is temporarily unknown')
                    if record.get('native_pid') is not None and record.get('joined') is not True:
                        raise ValueError('previous native mutation owner is unconfirmed')
                    record.update(native_pid=args.native_owner_pid, native_birth=native_birth, joined=False)
                else:
                    if record.get('native_pid') != args.native_owner_pid or record.get('native_birth') != native_birth:
                        raise ValueError('foreign native mutation joined receipt')
                    record['joined'] = True
                temporary = path.with_name('.' + path.name + '.' + uuid.uuid4().hex)
                with temporary.open('x') as output:
                    json.dump(record, output)
                temporary.replace(path)
            return 0
        if args.action == 'backoff':
            if (args.response_code is None or args.retry_after is None
                    or not math.isfinite(args.retry_after) or not 0 < args.retry_after <= 90):
                raise ValueError('actual rate response and bounded retry interval required')
            if not feed(args.app, validate_inventory=True):
                raise ValueError('rate response authority temporarily unknown')
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                state = directory / 'provider-backoff.json'
                now = time.monotonic()
                until = now + args.retry_after
                if state.exists():
                    until = max(until, provider_backoff(state, args.app))
                temporary = directory / f'.backoff-{uuid.uuid4().hex}'
                with temporary.open('x') as output:
                    json.dump({'app': args.app, 'host': HOST, 'until': until,
                               'response_code': args.response_code}, output)
                    output.flush()
                    os.fsync(output.fileno())
                temporary.replace(state)
                return 0
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)
        if args.wait_seconds is None or args.wait_seconds < 1:
            raise ValueError('invalid existing mutation wait budget')
        if args.strict_primary and args.action != 'pace':
            raise ValueError('strict queue supports only primary create admission')
        if args.strict_primary:
            feed(args.app)
            deadline = strict_primary_deadline(args)
        else:
            deadline = time.monotonic() + args.wait_seconds
        while time.monotonic() < deadline:
            if not live(args.owner_pid, owner_birth):
                raise ValueError('mutation caller owner changed')
            ready = feed(args.app)
            if args.strict_primary:
                strict_primary_not_finished(Path(os.environ['RUN_BENCH_CAMPAIGN_BARRIER_DIR']), args.task_root)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                time.sleep(0.1)
                continue
            admitted = False
            delay = 0.02
            try:
                if not ready or not feed(args.app):
                    continue
                backoff = directory / 'provider-backoff.json'
                if backoff.exists():
                    remaining_backoff = provider_backoff(backoff, args.app) - time.monotonic()
                    if remaining_backoff > 0:
                        delay = min(0.1, remaining_backoff)
                        continue
                if args.action == 'pace':
                    if not feed(args.app, validate_inventory=True):
                        continue
                    native_budget = math.floor(deadline - time.monotonic())
                    if native_budget < 1:
                        raise ValueError('no original mutation budget remains')
                    if args.strict_primary:
                        if strict_primary_deadline(args) != deadline:
                            raise ValueError('original strict deadline changed')
                        native_budget = min(args.wait_seconds, math.floor(deadline - time.monotonic() - 0.1))
                        if native_budget < 1:
                            raise ValueError('no original campaign budget remains for native clone')
                    if args.strict_primary or args.print_budget:
                        print(native_budget)
                    admitted = True
                    return 0
                for path in directory.glob('lease-*.json'):
                    regular(path)
                    record = json.loads(path.read_text())
                    if set(record) != {'app', 'host', 'pid', 'birth', 'token', 'native_pid', 'native_birth', 'joined'} or record['app'] != args.app or record['host'] != HOST or path.name != f"lease-{record['token']}.json":
                        raise ValueError('foreign or malformed update lease')
                    status = IDENTITY._process_identity_state(record['pid'], record['birth'])
                    if status in ['absent', 'mismatch']:
                        # Only the exact native wrapper can publish this after
                        # joining its child. Death alone proves no cleanup.
                        if record['joined'] is True and isinstance(record['native_pid'], int) and record['native_pid'] > 0 and isinstance(record['native_birth'], str) and record['native_birth']:
                            path.unlink()
                        else:
                            raise ValueError('unconfirmed dead update lease owner')
                    elif status != 'match':
                        raise ValueError('unknown update lease owner')
                if not feed(args.app, validate_inventory=True):
                    continue
                token = uuid.uuid4().hex
                path = directory / f'lease-{token}.json'
                with path.open('x') as output:
                    json.dump({'app': args.app, 'host': HOST, 'pid': args.owner_pid, 'birth': owner_birth, 'token': token, 'native_pid': None, 'native_birth': None, 'joined': False}, output)
                print(token, flush=True)
                admitted = True
                return 0
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)
                # Never sleep under the accounting lock, or after a healthy admission.
                if not admitted:
                    time.sleep(min(delay, max(0, deadline - time.monotonic())))

        print('mutation admission exhausted existing wait budget', file=__import__('sys').stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
