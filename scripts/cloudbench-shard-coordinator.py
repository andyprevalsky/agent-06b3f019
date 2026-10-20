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
import traceback

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
# One global Benchmark Hub write budget for every shard. The production Hub
# admits about 4-6 uploads/s in total (each catalog cycle rewrites a ~21 MB
# index under one lock, at most 64 uploads per cycle; measured 2026-10-18), so
# live writes use under half of it. Terminal bundles are multi-megabyte and
# held in Hub memory until their cycle; bound how many are in flight at once.
HUB_GLOBAL_LIVE_UPLOADS_PER_SECOND = 2.0
HUB_GLOBAL_TERMINAL_IN_FLIGHT = 20
HUB_TERMINAL_PUBLICATION_SECONDS = 1200
# Benchmark guests share the production Temporal Cloud namespace's Visibility API
# budget (CountWorkflowExecutions/DescribeTaskQueue). Prod's own 1 Hz autoscaler
# already spends ~75 calls/s at 25 workers; all shards together stay within this.
TEMPORAL_GLOBAL_VISIBILITY_CALLS_PER_SECOND = 20.0
CONTROLLER_PROFILES = {'performance-8x': dict(vcpus=8, memory_mib=32768)}
RELEASED_STATES = ('ready', 'released')
# Runner terminals that prove the shard created nothing, or verifiably released
# what it created, before any task ran: a fresh attempt cannot double-allocate.
RETRYABLE_STARTUP_TERMINALS = ('FAILED_BEFORE_PROVIDER_DISPATCH', 'FAILED_STARTUP_WORKSPACE_RELEASED')
MAX_SHARD_ATTEMPTS = 3
DEFAULT_SPAWN_STAGGER_SECONDS = 2.0
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
                CLOUDBENCH_SNAPSHOT_POLL_SECONDS=str(min(60, BASE_SNAPSHOT_POLL_SECONDS * max(1, math.ceil(controllers / 4)))),
                # Each shard host owns 1/K of the global Hub budget, never K times it.
                BENCHMARK_HUB_LIVE_UPLOADS_PER_SECOND=repr(HUB_GLOBAL_LIVE_UPLOADS_PER_SECOND / max(1, controllers)),
                BENCHMARK_HUB_TERMINAL_CONCURRENCY=str(max(1, HUB_GLOBAL_TERMINAL_IN_FLIGHT // max(1, controllers))),
                BENCHMARK_HUB_TERMINAL_PUBLICATION_SECONDS=str(HUB_TERMINAL_PUBLICATION_SECONDS),
                # Guests share the production Temporal namespace's Visibility API
                # budget; each shard host paces its guests within 1/K of it.
                CLOUDBENCH_TEMPORAL_VISIBILITY_CALLS_PER_SECOND=repr(
                    TEMPORAL_GLOBAL_VISIBILITY_CALLS_PER_SECOND / max(1, controllers)))


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


def runner_terminal_status(out):
    try:
        value = json.loads((Path(out) / 'terminal.json').read_bytes())
    except (OSError, ValueError):
        return None
    return value.get('status') if isinstance(value, dict) else None


def coordinate(shards, spawn, journal, *, scheduled_total, infra_early_stop='enabled',
               poll_seconds=1.0, clock=time.time, sleep=time.sleep, respawn=None,
               stagger_seconds=0.0, max_attempts=MAX_SHARD_ATTEMPTS):
    """Run K runners to completion under one global barrier. Returns the coordination record.

    shards: [{'index': i, 'out': Path}], spawn(shard) -> Popen-like (poll/wait/send_signal/pid).
    respawn(shard) -> (shard, Popen-like): a fresh attempt for a shard whose runner ended
    before release with a retryable startup terminal; None disables retries.
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
    runners, attempts = {}, {}
    record['retries'] = []
    try:
        for position, shard in enumerate(shards):
            if position and stagger_seconds:
                sleep(stagger_seconds)  # spread K controller admissions over the provider API
            runners[shard['index']] = spawn(shard)
            attempts[shard['index']] = 1
            record['shards'][str(shard['index'])] = dict(out=str(shard['out']), pid=runners[shard['index']].pid)
        save(journal, record)
        decided, decision = None, None
        while True:
            exited = {i: p.poll() for i, p in runners.items()}
            statuses = {s['index']: read_status(s['out']) for s in shards}
            barrier = {i: ((v or {}).get('barrier') or {}).get('status') for i, v in statuses.items()}
            infra = sum(int(((v or {}).get('infra') or {}).get('infra_true') or 0) for v in statuses.values())
            record['infra_true'] = infra
            if decided is None and respawn is not None and not stop[0]:
                for shard in shards:
                    i = shard['index']
                    terminal = runner_terminal_status(shard['out']) if exited[i] is not None else None
                    if terminal not in RETRYABLE_STARTUP_TERMINALS or attempts[i] >= max_attempts:
                        continue
                    try:
                        replacement, process = respawn(shard)
                    except (KeyboardInterrupt, SystemExit):
                        raise
                    except BaseException as error:  # a failed retry (incl. I/O Deadline) is an ordinary startup failure
                        record['retries'].append(dict(shard=i, attempt=attempts[i] + 1, at=clock(),
                                                      previous=terminal, error=type(error).__name__,
                                                      detail=str(error)[:300],
                                                      where=traceback.format_exc().strip().splitlines()[-4:]))
                        attempts[i] = max_attempts  # one failed respawn ends this shard's retries
                        continue
                    shard.update(replacement)
                    runners[i], exited[i], statuses[i], barrier[i] = process, None, None, None
                    attempts[i] += 1
                    record['retries'].append(dict(shard=i, attempt=attempts[i], at=clock(), previous=terminal,
                                                  out=str(shard['out']), pid=process.pid))
                    record['shards'][str(i)] = dict(out=str(shard['out']), pid=process.pid)
                    save(journal, record)
            if decided is None:
                failed = [i for i in runners if barrier[i] in FAILED_STATES or exited[i] is not None
                          or (statuses[i] or {}).get('state') in TERMINAL_SUPERVISOR]
                if stop[0] or failed:
                    decided = 'abort'
                    record.update(aborted_at=clock(), abort_reason=(
                        'operator ' + stop[0] if stop[0] else 'shard %s failed before global release' % failed))
                    decision = ('global-abort.json', dict(release_id=release_id, reason=record['abort_reason']))
                    save(journal, record)
                elif all(barrier[i] in RELEASED_STATES for i in runners):
                    decided = 'release'
                    record['released_at'] = clock()
                    decision = ('global-release.json', dict(release_id=release_id,
                                                            reason='all %d shards ready' % len(shards)))
                    save(journal, record)
            if decision is not None:
                # A runner creates its own output directory; deliver once it exists.
                for shard in shards:
                    target = Path(shard['out'])
                    if target.is_dir() and not (target / decision[0]).exists():
                        write_once(target / decision[0], decision[1])
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
    except BaseException as error:
        # An internal failure after runners started (spawn, journal write, decision delivery)
        # gets the operator-signal guarantee: abort every barrier, TERM every runner, join all.
        reason = 'coordinator failed: ' + type(error).__name__
        for shard in shards:
            target = Path(shard['out'])
            try:
                if target.is_dir() and not (target / 'global-release.json').exists():
                    write_once(target / 'global-abort.json', dict(release_id=release_id, reason=reason))
            except OSError:
                pass
        for process in runners.values():
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)  # runner forwards TERM to its own supervisor only
        codes = {str(i): p.wait() for i, p in runners.items()}
        record.update(aborted_at=record['aborted_at'] or clock(), abort_reason=record['abort_reason'] or reason,
                      terminated_at=record['terminated_at'] or clock(),
                      terminate_reason=record['terminate_reason'] or reason, exit_codes=codes, finished_at=clock())
        try:
            save(journal, record)
        except OSError:
            pass
        raise
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
