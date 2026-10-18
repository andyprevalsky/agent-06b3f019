#!/usr/bin/env python3
"""Split one wide campaign across K disposable controllers and release them together.

    plan_shards()  -> K shards sized to what one controller handles easily
    coordinate()   -> K runner processes; one global strict barrier:
                        every shard ready      -> global-release.json in each runner dir
                        a shard fails first    -> global-abort.json in each runner dir
                        infra threshold (opt.) -> SIGTERM every runner (existing TERM path)
                        operator signal        -> SIGTERM every runner, then join all
    merge()        -> one combined outcome from the K shard results

Each runner still owns exactly one controller (creation, export, teardown);
this module never signals a gate, a controller or any process it did not spawn.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import secrets
import signal
import time

# Copies per controller that one VM handles easily. The single performance-8x
# controller failed at 600 copies (flyctl/parent OOM, load 1,146 on 8 vCPU);
# ~40-wide waves ran on 8 vCPU. Bounds: 4 copies per vCPU, ~700 MiB per copy
# (5–7 long-lived processes), and ≤40 copies so one shared relay stays small.
COPIES_PER_VCPU = 4
MIB_PER_COPY = 700
RESERVED_MIB = 4096
MAX_COPIES_PER_CONTROLLER = 40
CANARY_MACHINES_PER_CONTROLLER = 2
BASE_SNAPSHOT_POLL_SECONDS = 15
CONTROLLER_PROFILES = {'performance-8x': dict(vcpus=8, memory_mib=32768)}
RELEASED_STATES = ('ready', 'released')
FAILED_STATES = ('failed', 'aborted')
TERMINAL_SUPERVISOR = ('JOINED', 'ABSENT_UNCONFIRMED')


def need(value, message):
    if not value:
        raise ValueError(message)


def copy_bound(vcpus, memory_mib):
    need(type(vcpus) is int and vcpus >= 1 and type(memory_mib) is int and memory_mib > RESERVED_MIB,
         'invalid controller profile')
    return max(1, min(COPIES_PER_VCPU * vcpus, (memory_mib - RESERVED_MIB) // MIB_PER_COPY,
                      MAX_COPIES_PER_CONTROLLER))


def plan_shards(tasks, runs, controllers='auto', tasks_per_controller=None, profile='performance-8x'):
    """All `runs` copies of a task stay on one shard; tasks are dealt round-robin (order kept)."""
    need(isinstance(tasks, list) and tasks and len(set(tasks)) == len(tasks), 'distinct ordered tasks required')
    need(type(runs) is int and runs >= 1, 'positive repetitions required')
    shape = CONTROLLER_PROFILES[profile]
    bound = copy_bound(shape['vcpus'], shape['memory_mib'])
    if tasks_per_controller is not None:
        need(type(tasks_per_controller) is int and tasks_per_controller >= 1, 'invalid --tasks-per-controller')
        per = tasks_per_controller
        count = math.ceil(len(tasks) / per)
        need(controllers in ('auto', count), 'explicit --controllers conflicts with --tasks-per-controller')
    elif controllers == 'auto':
        per = max(1, bound // runs)
        count = math.ceil(len(tasks) / per)
    else:
        need(type(controllers) is int and 1 <= controllers <= len(tasks), 'invalid --controllers')
        count = controllers
        need(math.ceil(len(tasks) / count) * runs <= bound,
             f'{controllers} controllers exceed {bound} copies each; pass --tasks-per-controller to override')
    need(count <= 100, 'more than 100 controllers requested')
    # Global manifest indexes keep job IDs (r001-j0047) identical to a single-controller run.
    shards = [dict(index=i, count=count, tasks=tasks[i::count], task_indexes=list(range(i, len(tasks), count)),
                   runs=runs) for i in range(count)]
    return dict(controllers=count, copies_per_controller_bound=bound, copies=len(tasks) * runs,
                profile=profile, shards=shards)


def capacity_demand(copies, controllers, worker_headroom=0):
    """Native org slots one sharded run needs before any task Machine exists."""
    return copies + controllers + CANARY_MACHINES_PER_CONTROLLER * controllers + worker_headroom


def shard_runtime_env(*, machine_limit, other_app_objects, extra_destroying, planned_shared_cpus,
                      baseline_shared_cpus, controllers, headroom_shared_cpus=20):
    """One global budget for every shard: each shard reads the same app-wide native inventory."""
    ceiling = machine_limit - other_app_objects - extra_destroying
    need(ceiling > 0, 'no app Machine capacity left in the organization')
    return dict(CLOUDBENCH_APP_MACHINE_CEILING=str(ceiling),
                CLOUDBENCH_SHARED_CPU_GOVERNOR=str(max(160, planned_shared_cpus + baseline_shared_cpus
                                                       + headroom_shared_cpus)),
                CLOUDBENCH_CAMPAIGN_MUTATION_ADMISSION='1',
                # K shards each list the whole app; keep the aggregate list rate near one feed's.
                CLOUDBENCH_SNAPSHOT_POLL_SECONDS=str(min(60, BASE_SNAPSHOT_POLL_SECONDS * max(1, math.ceil(controllers / 4)))))


def write_once(path, value):
    raw = (json.dumps(value, sort_keys=True) + '\n').encode()
    temporary = path.with_name('.' + path.name + '.' + secrets.token_hex(4))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    try:
        os.link(temporary, path)  # never replaces an existing decision
    except FileExistsError:
        pass
    finally:
        temporary.unlink()


def read_status(out):
    try:
        value = json.loads((Path(out) / 'shard-status.json').read_bytes())
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def coordinate(shards, spawn, journal, *, scheduled_total, infra_early_stop='enabled',
               poll_seconds=1.0, clock=time.time, sleep=time.sleep):
    """Run K runners to completion under one global barrier. Returns the coordination record.

    shards: [{'index': i, 'out': Path}], spawn(shard) -> Popen-like (poll/wait/send_signal/pid).
    """
    journal = Path(journal)
    need(scheduled_total > 0 and shards, 'scheduled shards required')
    release_id = secrets.token_hex(12)
    stop = [None]
    previous = {s: signal.getsignal(s) for s in (signal.SIGTERM, signal.SIGINT)}

    def request_stop(number, frame):
        stop[0] = stop[0] or signal.Signals(number).name

    for number in previous:
        signal.signal(number, request_stop)
    record = dict(schema='original600-shard-coordination-v1', release_id=release_id, controllers=len(shards),
                  scheduled_total=scheduled_total, infra_early_stop=infra_early_stop, started_at=clock(),
                  released_at=None, aborted_at=None, abort_reason=None, terminated_at=None,
                  terminate_reason=None, shards={})
    runners = {}
    try:
        for shard in shards:
            runners[shard['index']] = spawn(shard)
            record['shards'][str(shard['index'])] = dict(out=str(shard['out']), pid=runners[shard['index']].pid)
        save(journal, record)
        decided = None
        while True:
            exited = {i: p.poll() for i, p in runners.items()}
            statuses = {s['index']: read_status(s['out']) for s in shards}
            barrier = {i: ((v or {}).get('barrier') or {}).get('status') for i, v in statuses.items()}
            infra = sum(int(((v or {}).get('infra') or {}).get('infra_true') or 0) for v in statuses.values())
            record['infra_true'] = infra
            if decided is None:
                failed = [i for i in runners if barrier[i] in FAILED_STATES or exited[i] is not None
                          or (statuses[i] or {}).get('state') in TERMINAL_SUPERVISOR]
                if stop[0] or failed:
                    decided = 'abort'
                    record.update(aborted_at=clock(), abort_reason=(
                        'operator ' + stop[0] if stop[0] else 'shard %s failed before global release' % failed))
                    for shard in shards:
                        write_once(Path(shard['out']) / 'global-abort.json',
                                   dict(release_id=release_id, reason=record['abort_reason']))
                    save(journal, record)
                elif all(barrier[i] in RELEASED_STATES for i in runners):
                    decided = 'release'
                    record['released_at'] = clock()
                    for shard in shards:
                        write_once(Path(shard['out']) / 'global-release.json',
                                   dict(release_id=release_id, reason='all %d shards ready' % len(shards)))
                    save(journal, record)
            threshold = infra_early_stop == 'enabled' and 20 * infra >= scheduled_total
            if record['terminated_at'] is None and (stop[0] or threshold):
                record.update(terminated_at=clock(), terminate_reason=(
                    'operator ' + stop[0] if stop[0] else 'infra %d/%d reached the 5%% threshold' % (infra, scheduled_total)))
                for process in runners.values():
                    if process.poll() is None:
                        process.send_signal(signal.SIGTERM)  # runner forwards TERM to its own supervisor only
                save(journal, record)
            if all(code is not None for code in exited.values()):
                break
            sleep(poll_seconds)
        record['exit_codes'] = {str(i): p.wait() for i, p in runners.items()}
        record['finished_at'] = clock()
        save(journal, record)
        return record
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)


def save(path, value):
    path = Path(path)
    temporary = path.with_name('.' + path.name + '.tmp')
    temporary.write_text(json.dumps(value, sort_keys=True, indent=1) + '\n')
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def merge(summaries, scheduled_total):
    """Combine shard campaign summaries into one outcome. Missing jobs stay missing, never inferred."""
    jobs = {}
    for summary in summaries:
        for job in summary.get('jobs') or []:
            ident = job.get('job_id')
            need(isinstance(ident, str) and ident not in jobs, 'duplicate or missing job identity across shards')
            jobs[ident] = job

    def tally(key):
        counts = {}
        for job in jobs.values():
            value = str(job.get(key) or 'UNKNOWN')
            counts[value] = counts.get(value, 0) + 1
        return dict(sorted(counts.items()))

    return dict(scheduled_total=scheduled_total, observed_jobs=len(jobs), missing_jobs=scheduled_total - len(jobs),
                campaign_status=tally('status'), task_status=tally('task_status'),
                infra_failures=sum(job.get('infra_failure') is True for job in jobs.values()),
                terminal_tasks=sum(job.get('terminal_task') is True for job in jobs.values()),
                lifecycle_verified=sum(job.get('lifecycle_verified') is True for job in jobs.values()),
                resources_released=sum(job.get('resources_released') is True for job in jobs.values()))
