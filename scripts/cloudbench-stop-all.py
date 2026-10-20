#!/usr/bin/env python3
"""Explicit app-wide billing stop. Does not release claims or certify run teardown."""
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
import stat
import time

ACTIVE = {'started', 'starting', 'stopping', 'replacing', 'updating'}
STATES = ACTIVE | {'created', 'stopped', 'suspended', 'destroying', 'destroyed'}
class Deadline(Exception):
    pass

def need(value, message):
    if not value:
        raise ValueError(message)

@contextmanager
def until(end):
    """Absolute deadline includes parsing and local evidence writes, not just sockets."""
    previous = signal.getitimer(signal.ITIMER_REAL)
    need(previous[1] == 0, 'periodic caller alarm refused')
    handler = signal.getsignal(signal.SIGALRM)
    start = time.monotonic()
    end = min(end, start + previous[0]) if previous[0] else end
    def expired(*unused):
        raise Deadline('absolute stop-all deadline')
    need(end > start, 'deadline expired')
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, end-start)
    try:
        yield
        if time.monotonic() >= end:
            raise Deadline('late stop-all completion')
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, handler)
        if previous[0]:
            signal.setitimer(signal.ITIMER_REAL, max(.000001, previous[0]-(time.monotonic()-start)))

def save(path, value):
    raw = (json.dumps(value, sort_keys=True, allow_nan=False)+'\n').encode()
    fd = os.open(path, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    fd = os.open(path.parent, os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)

def inventory(value):
    need(isinstance(value, list), 'full inventory must be a list')
    ids = []
    for row in value:
        need(isinstance(row, dict) and re.fullmatch('[0-9a-f]{8,32}', row.get('id', '')),
             'invalid Machine identity')
        need(row.get('state') in STATES, 'unknown Machine state')
        ids.append(row['id'])
    need(len(set(ids)) == len(ids), 'duplicate Machine identity')
    return value

def same_machine(before, after):
    need(all(after.get(k) == before.get(k) for k in ('id', 'instance_id', 'name')),
         'Machine identity changed')
    # A partial list config cannot certify unchanged configuration. Never write config.
    if before.get('config') is not None:
        need(after.get('config') == before['config'], 'Machine config changed')

def call(api, method, path, end, body=None):
    cap = min(end, time.monotonic()+20)
    with until(cap):
        return api.api(method, path, body, timeout=max(.001, cap-time.monotonic()))

def stop_one(api, row, out, end, stop_signal=None):
    mid = row['id']
    body = {'signal': stop_signal, 'timeout': '1s'} if stop_signal else {}
    result = dict(machine=mid, status='PENDING', stop_attempted=False)
    try:
        with until(end):
            out.mkdir(mode=0o700)
            save(out/'before.json', row)
            # Durable once-only intent precedes dispatch. No retry, including ambiguous errors.
            save(out/'stop-intent.json', dict(method='POST', path='/machines/'+mid+'/stop', body=body))
            result['stop_attempted'] = True
            try:
                response = call(api, 'POST', '/machines/'+mid+'/stop', end, body)
                save(out/'stop-response.json', response)
            except Exception as error:
                save(out/'stop-error.json', dict(error=type(error).__name__))
            count = 0
            while time.monotonic() < end:
                try:
                    current = call(api, 'GET', '/machines/'+mid, end)
                    save(out/f'read-{count}.json', current); count += 1
                    same_machine(row, current)
                    if current['state'] == 'stopped':
                        result.update(status='STOPPED_CONFIRMED', instance_id=current.get('instance_id'))
                        break
                    need(current['state'] in ACTIVE, 'unexpected Machine state')
                except Deadline:
                    raise
                except Exception as error:
                    # Identity drift/404 is not stopped confirmation. Retain the refusal.
                    save(out/f'read-error-{count}.json', dict(error=type(error).__name__)); break
                time.sleep(min(1, max(0, end-time.monotonic())))
            save(out/'terminal.json', result)
    except Exception:
        # The parent reports missing terminal evidence as PENDING; never retry this POST.
        pass

def run(api, app, output, workers=16, seconds=300, *, deadline=None, stop_signal=None):
    need(1 <= workers <= 16 and 60 <= seconds <= 1800, 'invalid bounded stop-all limits')
    need(stop_signal in (None, 'SIGKILL'), 'unsupported explicit stop signal')
    output = Path(output).absolute()
    need(output.parent.resolve(strict=True) == output.parent, 'physical output parent required')
    os.umask(0o077); output.mkdir(mode=0o700)
    end = min(time.monotonic()+seconds, deadline) if deadline else time.monotonic()+seconds
    children = []; results = []
    try:
        with until(end):
            before = inventory(call(api, 'GET', '/machines', end))
            save(output/'before.json', before)
            targets = [r for r in before if r['state'] in ACTIVE]
            need(not (os.environ.get('FLY_APP_NAME') == app and
                 os.environ.get('FLY_MACHINE_ID') in {r['id'] for r in targets}),
                 'stop-all must run outside its target Machines')
            save(output/'intent.json', dict(app=app, targets=[r['id'] for r in targets], workers=workers,
                 whole_seconds=seconds, signal=stop_signal, no_start=True, no_delete=True, no_config_update=True,
                 no_claim_or_latch_changes=True, no_stop_retry=True))
            context = multiprocessing.get_context('fork')
            pending = list(targets)
            # Leave a full20s for final inventory. Every child has its own absolute alarm.
            work_end = end-20
            while pending or children:
                for child in list(children):
                    if not child.is_alive():
                        child.join(); children.remove(child)
                while pending and len(children) < workers and time.monotonic() < work_end:
                    row = pending.pop(0)
                    child = context.Process(target=stop_one, args=(api, row, output/row['id'], min(work_end, time.monotonic()+65), stop_signal))
                    child.start(); children.append(child)
                if not children:
                    break
                time.sleep(.02)
            for row in targets:
                path = output/row['id']/'terminal.json'
                try: results.append(json.loads(path.read_bytes()))
                except (OSError, ValueError): results.append(dict(machine=row['id'], status='PENDING'))
            after = inventory(call(api, 'GET', '/machines', end)); save(output/'after.json', after)
            need({r['id'] for r in before} == {r['id'] for r in after}, 'app Machine ID set changed')
            by_id = {r['id']:r for r in after}
            for row in before: same_machine(row, by_id[row['id']])
            # Final observation resolves current state without rewriting earlier PENDING outcomes.
            active = [r['id'] for r in after if r['state'] in ACTIVE]
            stopped = all(r['state'] == 'stopped' for r in after)
            result = dict(app=app, results=results, active_remaining=active, all_stopped=stopped,
                          counts={s:sum(r['state']==s for r in after) for s in sorted({r['state'] for r in after})})
            save(output/'summary.json', result)
            return result
    finally:
        # Never abandon an owned child on an exception; each child is absolutely bounded.
        for child in children: child.join()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', required=True)
    parser.add_argument('--execute', action='store_true', required=True)
    parser.add_argument('--out-dir', type=Path, required=True)
    parser.add_argument('--workers', type=int, default=16)
    parser.add_argument('--timeout', type=int, default=300)
    parser.add_argument('--signal', choices=['SIGKILL'], help='Explicit new corrective action; never automatic escalation')
    args = parser.parse_args()
    need(re.fullmatch('[a-z0-9][a-z0-9-]{0,62}', args.app), 'explicit valid app required')
    need(1 <= args.workers <= 16 and 60 <= args.timeout <= 1800, 'invalid bounded limits')
    helper = runpy.run_path(str(Path(__file__).resolve().parent/'cloudbench-original-volume-capture.py'))
    end = time.monotonic()+args.timeout
    with until(end):
        with until(min(end, time.monotonic()+20)):
            token = helper['resolve_token']({'workspace': os.getcwd()})
            api = helper['Fly'](args.app, token)
        value = run(api, args.app, args.out_dir, args.workers, args.timeout, deadline=end, stop_signal=args.signal)
    print(json.dumps(value, sort_keys=True))
    return 0 if value['all_stopped'] else 1

if __name__ == '__main__':
    raise SystemExit(main())
