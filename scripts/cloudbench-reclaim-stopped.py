#!/usr/bin/env python3
"""Reclaim Fly org Machine slots held by stopped benchmark task Machines.

Fly's per-org Machine limit counts stopped Machines. Failed or retained runs
leave stopped task Machines behind, and enough of them block admission of the
next wide run. A stopped task Machine is not claimed (user policy 2026-10-18):
this command destroys exact stopped task Machines and their attached Volumes.

    plan (default)   fresh full list -> plan.json, no provider mutation
    --execute        fresh full list -> per target: exact re-read (still
                     stopped, same instance/config) -> one DELETE Machine ->
                     confirm gone -> DELETE each attached Volume -> confirm

Never targets: non-stopped Machines, warm donors or any name other than
`cloudbench-<hex>`, Machines carrying controller/WHM/protected or archived-reuse
(retained successor / parked or held reservation) metadata, the fixed native
worker baseline, this host's indexed or claimed pool members, other hosts'
pool members (--other-host-pools-file, or an explicit --no-other-host-pools
attestation), explicit --protect-machine/--protect-file Machines, names or
Volumes (including `cloudbench-protected-resources.py` union output), or the
Machine running this command. Any unreadable protection source refuses the
whole command before a provider call.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import multiprocessing
import os
from pathlib import Path
import re
import runpy
import signal
import subprocess
import time

STATES = {'started', 'starting', 'stopping', 'replacing', 'updating', 'created',
          'stopped', 'suspended', 'destroying', 'destroyed'}
TASK_NAME = re.compile(r'cloudbench-[0-9a-f]{16,40}')
MACHINE_ID = re.compile(r'[0-9a-f]{8,32}')
VOLUME_ID = re.compile(r'vol_[0-9a-z]{8,40}')
# `cloudbench_archived_reuse` marks retained archived-reuse successors and their
# parked/held reservations (scripts/cloudbench-archived-machine-reuse.py MARKER).
PROTECTED_METADATA_PREFIXES = ('whm_deploy', 'rose_controller', 'cloudbench_protected', 'polar',
                               'cloudbench_archived_reuse')
GONE_VOLUME_STATES = {'destroyed', 'pending_destroy', 'destroying'}
CALL_CAP_SECONDS = 30


class Deadline(Exception):
    pass


def need(value, message):
    if not value:
        raise ValueError(message)


@contextmanager
def until(end):
    previous = signal.getitimer(signal.ITIMER_REAL)
    need(previous[1] == 0, 'periodic caller alarm refused')
    handler = signal.getsignal(signal.SIGALRM)
    start = time.monotonic()
    end = min(end, start + previous[0]) if previous[0] else end
    need(end > start, 'deadline expired')

    def expired(*unused):
        raise Deadline('absolute reclaim deadline')

    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, end - start)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, handler)
        if previous[0]:
            signal.setitimer(signal.ITIMER_REAL, max(.000001, previous[0] - (time.monotonic() - start)))


def save(path, value):
    raw = (json.dumps(value, sort_keys=True, allow_nan=False) + '\n').encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


class CallTimeout(Exception):
    """One provider call exceeded its own cap; the target deadline may still allow a re-read."""


def call(api, method, path, end, body=None):
    cap = min(end, time.monotonic() + CALL_CAP_SECONDS)
    try:
        with until(cap):
            return api.api(method, path, body, timeout=max(.001, cap - time.monotonic()))
    except Deadline:
        if cap < end:
            raise CallTimeout(method + ' ' + path) from None
        raise


def read(api, path, end):
    """GET with re-reads after a per-call timeout or transient error; 404 propagates."""
    while True:
        try:
            return call(api, 'GET', path, end)
        except Deadline:
            raise
        except Exception as error:
            if is_not_found(error) or time.monotonic() >= end - 1:
                raise
            time.sleep(min(2, max(0, end - time.monotonic())))


def is_not_found(error):
    return type(error).__name__ == 'NotFound'


def is_rate_limited(error):
    return 'HTTP 429' in str(error)


def inventory(value):
    need(isinstance(value, list), 'full Machine list required')
    ids = []
    for row in value:
        need(isinstance(row, dict) and MACHINE_ID.fullmatch(row.get('id') or ''), 'invalid Machine identity')
        need(row.get('state') in STATES, 'unknown Machine state')
        ids.append(row['id'])
    need(len(ids) == len(set(ids)), 'duplicate Machine identity')
    return value


def volumes_of(row):
    mounts = (row.get('config') or {}).get('mounts') or []
    found = [m.get('volume') for m in mounts if isinstance(m, dict)]
    need(all(isinstance(v, str) and VOLUME_ID.fullmatch(v) for v in found), 'invalid mounted Volume identity')
    return found


def local_pool_members(root):
    """Machine IDs indexed (cloudbench-pools/*.ids, cloudbench-worker-pools/<pool>) or claimed
    (cloudbench-pool-claims/<id>) by this host's git-common pools. An unreadable index fails closed: no reclaim at all."""
    try:
        common = Path(subprocess.check_output(['git', '-C', str(root), 'rev-parse', '--path-format=absolute',
                                               '--git-common-dir'], text=True, timeout=10).strip())
        need(common.is_absolute() and common.is_dir(), 'git common directory missing')
        members = set()
        pools = common / 'cloudbench-pools'
        if os.path.lexists(pools):
            need(pools.is_dir(), 'pool index is not a directory')
            for index in sorted(pools.glob('*.ids')):
                members.update(ids_from(index.read_text()))
        claims = common / 'cloudbench-pool-claims'
        if os.path.lexists(claims):
            need(claims.is_dir(), 'pool claims is not a directory')
            members.update(entry.name for entry in claims.iterdir() if MACHINE_ID.fullmatch(entry.name))
        # Imported workers leave the claim directory but stay members of the
        # worker-pool ledger written by cloudbench-worker-reuse.py import_packet.
        worker_pools = common / 'cloudbench-worker-pools'
        if os.path.lexists(worker_pools):
            need(worker_pools.is_dir(), 'worker pool index is not a directory')
            for ledger in sorted(worker_pools.iterdir()):
                if ledger.name.endswith(('.deps', '.lock')):
                    continue
                rows = [row for row in ledger.read_text().splitlines() if row.strip()]
                need(all(MACHINE_ID.fullmatch(row) for row in rows), 'malformed worker pool ledger')
                members.update(rows)
    except (OSError, subprocess.SubprocessError, UnicodeDecodeError, ValueError) as error:
        raise ValueError('pool membership index unavailable; refusing reclaim') from error
    return members


def ids_from(text):
    """Whitespace Machine-ID tokens, a JSON ID array, or a protected-resources union document."""
    stripped = text.lstrip()
    if not stripped.startswith(('[', '{')):
        return {token for token in text.split() if MACHINE_ID.fullmatch(token)}
    return protection_from_json(json.loads(text))['machines']


def protection_from_json(value):
    if isinstance(value, list):
        value = dict(machines=value)
    need(isinstance(value, dict) and any(k in value for k in ('machines', 'names', 'volumes')),
         'unsupported protection document')
    result = {}
    for key, pattern in (('machines', MACHINE_ID), ('names', None), ('volumes', VOLUME_ID)):
        items = value.get(key) or []
        need(isinstance(items, list) and all(isinstance(v, str) and v and (pattern is None or pattern.fullmatch(v))
                                             for v in items), 'invalid protected ' + key)
        result[key] = set(items)
    return result


def empty_protection():
    return dict(machines=set(), names=set(), volumes=set())


def merge(*parts):
    out = empty_protection()
    for part in parts:
        for key in out:
            out[key] |= set(part.get(key) or ())
    return out


def fixed_native_worker():
    """The sha-pinned fixed native worker baseline (machine/name/volume); unreadable fails closed."""
    try:
        guard = runpy.run_path(str(Path(__file__).resolve().parent / 'cloudbench-fixed-native-worker-guard.py'))
        base = guard['baseline']()
    except Exception as error:
        raise ValueError('fixed native worker baseline unavailable; refusing reclaim') from error
    return protection_from_json(dict(machines=[base['machine']], names=[base['name']], volumes=[base['volume']]))


def classify(row, protected, self_id):
    """Return None when the row is a reclaim target, else the protection reason."""
    if not isinstance(protected, dict):
        protected = merge(dict(machines=protected))
    if row['id'] == self_id:
        return 'running-this-command'
    if row['id'] in protected['machines'] or row.get('name') in protected['names']:
        return 'explicitly-protected'
    if row.get('state') != 'stopped':
        return 'not-stopped'
    if not TASK_NAME.fullmatch(row.get('name') or ''):
        return 'not-a-task-machine-name'
    if row.get('config') is not None and set(volumes_of(row)) & protected['volumes']:
        return 'explicitly-protected'
    metadata = (row.get('config') or {}).get('metadata') or {}
    if any(str(key).startswith(PROTECTED_METADATA_PREFIXES) for key in metadata):
        return 'protected-metadata'
    if row.get('config') is None:
        return 'unknown-config'
    return None


def plan(rows, protected_ids, self_id):
    targets, kept = [], {}
    for row in rows:
        reason = classify(row, protected_ids, self_id)
        if reason is None:
            targets.append(dict(machine=row['id'], name=row['name'], instance_id=row.get('instance_id'),
                                volumes=volumes_of(row)))
        else:
            kept[reason] = kept.get(reason, 0) + 1
    return targets, kept


def same_machine(before, current):
    need(all(current.get(k) == before.get(k) for k in ('id', 'instance_id', 'name')), 'Machine identity changed')
    need(current.get('config') == before.get('config'), 'Machine config changed')


def delete_once(api, path, out, name, end):
    """One DELETE. Only an explicit HTTP 429 (request refused, not executed) is retried."""
    save(out / f'{name}-intent.json', dict(method='DELETE', path=path))
    for attempt in range(4):
        try:
            response = call(api, 'DELETE', path, end)
            save(out / f'{name}-response-{attempt}.json', response if isinstance(response, dict) else {})
            return 'accepted'
        except Deadline:
            raise
        except Exception as error:
            if is_not_found(error):
                save(out / f'{name}-not-found-{attempt}.json', {})
                return 'not-found'
            save(out / f'{name}-error-{attempt}.json', dict(error=type(error).__name__, detail=str(error)[:200]))
            if not is_rate_limited(error):
                return 'ambiguous'
            time.sleep(min(2 ** attempt, max(0, end - time.monotonic())))
    return 'rate-limited'


def reclaim_one(api, before, target, out, end):
    mid = target['machine']
    result = dict(machine=mid, status='PENDING', volumes={})
    try:
        with until(end):
            out.mkdir(mode=0o700)
            current = read(api, '/machines/' + mid, end)
            save(out / 'exact-before.json', current)
            same_machine(before, current)
            need(current.get('state') == 'stopped', 'Machine is no longer stopped')
            outcome = delete_once(api, '/machines/' + mid, out, 'machine-destroy', end)
            result['machine_delete'] = outcome
            gone = outcome == 'not-found'
            reads = 0
            # An ambiguous DELETE is never resent; a few reads show whether it took effect.
            while (not gone and time.monotonic() < end
                   and (outcome == 'accepted' or (outcome == 'ambiguous' and reads < 5))):
                try:
                    row = read(api, '/machines/' + mid, end)
                    save(out / f'read-{reads}.json', dict(state=row.get('state'), instance_id=row.get('instance_id')))
                    gone = row.get('state') == 'destroyed'
                    need(gone or row.get('state') in ('stopped', 'destroying'), 'unexpected state after destroy')
                except Deadline:
                    raise
                except Exception as error:
                    if not is_not_found(error):
                        raise
                    gone = True
                reads += 1
                if not gone:
                    time.sleep(min(1, max(0, end - time.monotonic())))
            if not gone:
                save(out / 'terminal.json', result)
                return
            for volume in target['volumes']:
                state = delete_once(api, '/volumes/' + volume, out, 'volume-destroy-' + volume, end)
                if state == 'accepted':
                    try:
                        state = read(api, '/volumes/' + volume, end).get('state') or 'unknown'
                    except Deadline:
                        raise
                    except Exception as error:
                        state = 'not-found' if is_not_found(error) else 'unconfirmed'
                result['volumes'][volume] = state
            volumes_gone = all(s in GONE_VOLUME_STATES | {'not-found'} for s in result['volumes'].values())
            result['status'] = 'RECLAIMED' if volumes_gone else 'MACHINE_DESTROYED_VOLUME_PENDING'
            save(out / 'terminal.json', result)
    except Exception as error:
        try:
            save(out / 'terminal.json', dict(result, refusal=type(error).__name__, detail=str(error)[:200]))
        except Exception:
            pass


def run(api, app, output, protected_ids, *, execute=False, workers=8, seconds=1800, self_id=None,
        max_targets=None):
    need(1 <= workers <= 16 and 60 <= seconds <= 7200, 'invalid bounded reclaim limits')
    output = Path(output).absolute()
    need(output.parent.resolve(strict=True) == output.parent, 'physical output parent required')
    os.umask(0o077)
    output.mkdir(mode=0o700)
    end = time.monotonic() + seconds
    rows = inventory(read(api, '/machines', end))
    save(output / 'before.json', rows)
    targets, kept = plan(rows, protected_ids, self_id)
    if max_targets is not None:
        targets = targets[:max_targets]
    summary = dict(app=app, execute=execute, machines_listed=len(rows), targets=len(targets),
                   target_volumes=sum(len(t['volumes']) for t in targets), kept=kept)
    save(output / 'plan.json', dict(summary, target_rows=targets))
    if not execute:
        return dict(summary, status='PLANNED')
    by_id = {row['id']: row for row in rows}
    context = multiprocessing.get_context('fork')
    pending, children = list(targets), []
    work_end = end - 30
    try:
        while pending or children:
            for child in list(children):
                if not child.is_alive():
                    child.join()
                    children.remove(child)
            while pending and len(children) < workers and time.monotonic() < work_end:
                target = pending.pop(0)
                child = context.Process(target=reclaim_one, args=(
                    api, by_id[target['machine']], target, output / target['machine'],
                    min(work_end, time.monotonic() + 180)))
                child.start()
                children.append(child)
            if not children:
                break
            time.sleep(.02)
    finally:
        for child in children:
            child.join()
    results = []
    for target in targets:
        try:
            results.append(json.loads((output / target['machine'] / 'terminal.json').read_bytes()))
        except (OSError, ValueError):
            results.append(dict(machine=target['machine'], status='PENDING'))
    after = inventory(read(api, '/machines', end))
    save(output / 'after.json', after)
    remaining = {row['id'] for row in after if row.get('state') != 'destroyed'}
    counts = {}
    for item in results:
        counts[item['status']] = counts.get(item['status'], 0) + 1
    summary.update(status='EXECUTED', results=counts,
                   reclaimed_machines=sum(r['status'] in ('RECLAIMED', 'MACHINE_DESTROYED_VOLUME_PENDING')
                                          for r in results),
                   targets_still_listed=sorted(t['machine'] for t in targets if t['machine'] in remaining),
                   machines_listed_after=len(remaining))
    save(output / 'summary.json', summary)
    return summary


def protected_from(args):
    ids = set(args.protect_machine or [])
    need(all(isinstance(v, str) and MACHINE_ID.fullmatch(v) for v in ids), 'invalid protected Machine ID')
    parts = [dict(machines=ids)]
    for path in list(args.protect_file or []) + list(args.other_host_pools_file or []):
        text = Path(path).read_text()
        if text.lstrip().startswith(('[', '{')):
            parts.append(protection_from_json(json.loads(text)))
        else:
            tokens = text.split()
            need(all(MACHINE_ID.fullmatch(v) for v in tokens), 'invalid protected Machine ID')
            parts.append(dict(machines=set(tokens)))
    return merge(*parts)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--app', required=True)
    parser.add_argument('--out-dir', type=Path, required=True)
    parser.add_argument('--execute', action='store_true', help='destroy the planned targets (default: plan only)')
    parser.add_argument('--protect-machine', action='append', default=[])
    parser.add_argument('--protect-file', action='append', default=[], type=Path,
                        help='JSON array or whitespace-separated Machine IDs to keep')
    parser.add_argument('--other-host-pools-file', action='append', default=[], type=Path,
                        help="another host's pool index/claims (IDs, JSON array or protected-resources union)")
    parser.add_argument('--no-other-host-pools', action='store_true',
                        help='attest that no other host indexes or claims pool members in this app')
    parser.add_argument('--max-targets', type=int, help='reclaim at most N targets (first in list order)')
    parser.add_argument('--workers', type=int, default=8)
    parser.add_argument('--timeout', type=int, default=1800)
    args = parser.parse_args()
    need(re.fullmatch('[a-z0-9][a-z0-9-]{0,62}', args.app), 'explicit valid app required')
    need(args.max_targets is None or args.max_targets >= 1, 'invalid --max-targets')
    need(bool(args.other_host_pools_file) != bool(args.no_other_host_pools),
         "other hosts' pool members are invisible here: pass --other-host-pools-file or --no-other-host-pools")
    protected = merge(protected_from(args), fixed_native_worker(),
                      dict(machines=local_pool_members(Path(__file__).resolve().parents[1])))
    helper = runpy.run_path(str(Path(__file__).resolve().parent / 'cloudbench-original-volume-capture.py'))
    api = helper['Fly'](args.app, helper['resolve_token']({'workspace': os.getcwd()}))
    self_id = os.environ.get('FLY_MACHINE_ID') if os.environ.get('FLY_APP_NAME') == args.app else None
    value = run(api, args.app, args.out_dir, protected, execute=args.execute, workers=args.workers,
                seconds=args.timeout, self_id=self_id, max_targets=args.max_targets)
    print(json.dumps(value, sort_keys=True))
    if not args.execute:
        return 0
    return 0 if not value['targets_still_listed'] and value['results'].get('RECLAIMED', 0) == value['targets'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
