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
import re
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
    # The existing publisher validates the full provider lists ONCE, writes a
    # generation completely, then atomically publishes its current symlink.
    # Admission consumes that real generation/health binding, not O(N) JSON.
    index = directory / 'inventory'
    if index.is_symlink() or not index.is_dir():
        raise ValueError('unsafe mutation inventory index')
    current = index / 'current'
    try:
        target = os.readlink(current)
    except FileNotFoundError:
        return False
    if not re.fullmatch(r'[.]generation-[A-Za-z0-9._-]+', target):
        raise ValueError('foreign mutation inventory generation')
    generation = index / target
    if generation.is_symlink() or not generation.is_dir() or generation.stat().st_uid != os.getuid():
        raise ValueError('unsafe mutation inventory generation')
    health = generation / 'health'
    snapshot = generation / 'admission-machines.json'
    try:
        regular(health)
        regular(snapshot)
        if not health.stat().st_size or not snapshot.stat().st_size:
            return False
        pairs = [line.split('=', 1) for line in health.read_text().splitlines()]
        health_fields = dict(pairs)
        if (len(pairs) != len(health_fields)
                or set(health_fields) != {'publisher_token', 'valid_until', 'generation'}
                or health_fields['generation'] != target):
            raise ValueError('malformed mutation inventory generation health')
        if health_fields['publisher_token'] != fields['token']:
            raise ValueError('foreign mutation admission feed token')
        expiry = health_fields['valid_until']
        if not expiry.isdigit():
            raise ValueError('malformed mutation admission feed health')
        return os.readlink(current) == target and int(expiry) >= time.time()
    except FileNotFoundError:
        # A publisher can retire an old generation while this read is in flight.
        return False


def strict_primary_deadline(args: argparse.Namespace) -> float:
    """Use only the original held strict manifest and original parent clock."""
    directory = Path(AUTHORITY['directory'])
    barrier = Path(os.environ['RUN_BENCH_CAMPAIGN_BARRIER_DIR'])
    cohort = os.environ['RUN_BENCH_CAMPAIGN_COHORT']
    job = os.environ['RUN_BENCH_CAMPAIGN_JOB_ID']
    if (barrier.is_symlink() or barrier.name != cohort
            or barrier.parent.resolve() != (directory.parent / 'startup-cohorts').resolve()):
        raise ValueError('foreign strict clone queue')
    ticket_directory = os.environ.get('RUN_BENCH_CLEANUP_COHORT_DIR')
    if ticket_directory:
        if (Path(ticket_directory) != barrier
                or os.environ.get('RUN_BENCH_CLEANUP_COHORT_ID') != cohort
                or os.environ.get('RUN_BENCH_CLEANUP_JOB') != job):
            raise ValueError('foreign strict cleanup ticket scope')
        name = 'cloudbench-cleanup-tickets.py'
        raw = Path(__file__).with_name(name).read_bytes()
        if AUTHORITY['source']['sha256'].get(name) != hashlib.sha256(raw).hexdigest():
            raise ValueError('strict cleanup ticket interpreter differs from approved source')
        helper = types.ModuleType('strict_cleanup_identity')
        helper.__file__ = str(Path(__file__).with_name(name))
        exec(compile(raw, helper.__file__, 'exec'), helper.__dict__)
        base = helper.base_for(barrier)
        budget, _ = helper.selected(base, job)
        number = int(os.environ['RUN_BENCH_CLEANUP_GENERATION'])
        owner = helper.read(helper.generation(base, 'owners', job, number))
        if (number < 1 or budget['cohort_id'] != cohort
                or not helper.parent_active(budget) or (base / 'closing.json').exists()
                or owner != dict(job=job, generation=number, owner_pid=args.owner_pid,
                                 owner_start=args.owner_start, budget_sha256=helper.digest(budget))
                or helper.read(helper.keyed(base, 'current', job)) != owner):
            raise ValueError('strict cleanup ticket owner changed')
        deadline = budget['deadline']
    else:
        # Legacy campaigns retain their original full-manifest validation.
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


def write_json(path: Path, value: dict, *, replace: bool = False) -> None:
    target = path.with_name('.' + path.name + '.' + uuid.uuid4().hex) if replace else path
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(value, output)
        output.flush()
        os.fsync(output.fileno())
    if replace:
        target.replace(path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['pace', 'acquire', 'release', 'start-native', 'join-native', 'backoff'])
    parser.add_argument('--app', required=True)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--owner-pid', type=int, required=True)
    parser.add_argument('--owner-start', default=os.environ.get('CLOUDBENCH_MUTATION_CALLER_START'))
    parser.add_argument('--wait-seconds', type=int)
    parser.add_argument('--slots', type=int, default=4, help='legacy input; campaign leases have no fixed concurrency cap')
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
    if args.action in ['release', 'start-native', 'join-native', 'backoff']:
        # Only a provider-error publication shares a writer lock. Native owner
        # transitions lock their exact key; unrelated orphans remain untouched.
        token = None if args.action == 'backoff' else uuid.UUID(args.lease).hex
        lock_path = directory / ('provider-backoff.lock' if token is None else f'lease-{token}.lock')
        fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        regular(lock_path)
        with os.fdopen(fd, 'r+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if (os.fstat(lock.fileno()).st_dev, os.fstat(lock.fileno()).st_ino) != (lock_path.stat().st_dev, lock_path.stat().st_ino):
                raise ValueError('mutation key lock changed')
            if args.action == 'backoff':
                if (args.response_code is None or args.retry_after is None
                        or not math.isfinite(args.retry_after) or not 0 < args.retry_after <= 90):
                    raise ValueError('actual rate response and bounded retry interval required')
                if not feed(args.app, validate_inventory=True):
                    raise ValueError('rate response authority temporarily unknown')
                state = directory / 'provider-backoff.json'
                until = time.monotonic() + args.retry_after
                if state.exists():
                    until = max(until, provider_backoff(state, args.app))
                write_json(state, {'app': args.app, 'host': HOST, 'until': until,
                                   'response_code': args.response_code}, replace=True)
                return 0
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
                return 0
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
            write_json(path, record, replace=True)
            return 0
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
        ready = feed(args.app, validate_inventory=True)
        if args.strict_primary:
            strict_primary_not_finished(Path(os.environ['RUN_BENCH_CAMPAIGN_BARRIER_DIR']), args.task_root)
        state = directory / 'provider-backoff.json'
        remaining = provider_backoff(state, args.app) - time.monotonic() if state.exists() else 0
        if ready and remaining <= 0:
            if args.action == 'pace':
                native_budget = math.floor(deadline - time.monotonic())
                if args.strict_primary:
                    if strict_primary_deadline(args) != deadline:
                        raise ValueError('original strict deadline changed')
                    native_budget = min(args.wait_seconds, math.floor(deadline - time.monotonic() - 0.1))
                if native_budget < 1:
                    raise ValueError('no original mutation budget remains')
                if args.strict_primary or args.print_budget:
                    print(native_budget)
                return 0
            token = uuid.uuid4().hex
            path = directory / f'lease-{token}.json'
            write_json(path, {'app': args.app, 'host': HOST, 'pid': args.owner_pid,
                             'birth': owner_birth, 'token': token, 'native_pid': None,
                             'native_birth': None, 'joined': False})
            print(token, flush=True)
            return 0
        # Waiting is caused by an actual published provider response or unknown
        # publisher generation, never by a fixed create/update batch size.
        time.sleep(min(0.05, max(0, deadline - time.monotonic()), remaining if remaining > 0 else 0.05))
    print('mutation admission exhausted existing wait budget', file=sys.stderr)
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
