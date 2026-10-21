#!/usr/bin/env python3
"""Split one wide campaign across K disposable controllers and release them together.

    plan_shards()  -> K shards sized to what one controller handles easily
    coordinate()   -> K runner processes; one global strict barrier:
                        every shard ready      -> global-release.json in each runner dir
                        a shard fails first    -> global-abort.json in each runner dir
                        infra threshold (opt.) -> SIGTERM every runner (existing TERM path)
                        operator signal        -> SIGTERM every runner, then join all
    adopt_coordinate() -> after the host owner died: re-adopted runners continue the
                        original journal, release and clocks; signals only detach
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


def process_birth(pid):
    """Linux /proc birth of a live non-zombie PID, or None."""
    try:
        fields = Path('/proc', str(pid), 'stat').read_text().rsplit(') ', 1)[1].split()
        if fields[0] == 'Z':
            return None
        return 'proc-start:' + Path('/proc/sys/kernel/random/boot_id').read_text().strip() + ':' + fields[19]
    except (OSError, IndexError):
        return None


OWNER_STOP = 'owner-stop.json'  # a durable stop decision an adopting runner delivers as one supervisor TERM
REPLAYED_STOP_CAUSES = ('threshold', 'operator')


def terminate_cause(record):
    """Why a journal recorded termination. Older journals carry only this module's own reason strings."""
    if record.get('terminated_at') is None:
        return None
    if record.get('terminate_cause'):
        return record['terminate_cause']
    reason = str(record.get('terminate_reason') or '')
    return ('threshold' if reason.startswith('infra ') else 'operator' if reason.startswith('operator stop:')
            else 'signal' if reason.startswith('operator SIG') else 'internal' if reason.startswith('coordinator failed')
            else 'unknown')


def adoptable(record, shards):
    """An unfinished journal after its barrier decision, whose coordinator is gone, for exactly these shards."""
    need(isinstance(record, dict) and record.get('schema') == 'original600-shard-coordination-v1',
         'original coordination journal required')
    need(record.get('finished_at') is None, 'coordination already finished; nothing to adopt')
    need(type(record.get('scheduled_total')) is int and record['scheduled_total'] > 0
         and record.get('infra_early_stop') in ('enabled', 'disabled'),
         'original scheduled total and early-stop policy required')
    need(record.get('released_at') is not None or record.get('aborted_at') is not None,
         'adoption covers a run after its global barrier decision; abort an undecided barrier instead')
    need(sorted(record.get('shards') or {}) == sorted(str(s['index']) for s in shards)
         and all(record['shards'][str(s['index'])]['out'] == str(s['out']) for s in shards),
         'adoption must cover exactly the original shard outputs')
    owner = record.get('coordinator') or {}
    # An adopting coordinator's liveness is its coordination.adopt.lock (checked by adopt_coordinate).
    if owner.get('pid') is not None and not owner.get('adopting'):
        need(process_birth(owner['pid']) != owner.get('birth'), 'original coordinator still live')


def adopt_coordinate(shards, spawn, journal, *, stop_reason=None, poll_seconds=1.0, clock=time.time,
                     sleep=time.sleep, alert=None):
    """Continue a released (or aborted) run whose coordinator and runners died, over re-adopting owners.

    Keeps the original release identity, decision, clocks, scheduled total and policy. A threshold
    or explicit operator stop is a durable owner-stop.json that each adopter delivers as one
    supervisor TERM, so it survives later adoptions. A signal to this process, an adopter that
    dies, or an internal error only detaches: no barrier abort and no supervisor TERM, and the
    journal stays unfinished so the run can be adopted again. finished_at is written only after
    every adopter exited 0 with its supervisor settled.
    """
    import fcntl
    import sys
    journal = Path(journal)
    record = json.loads(journal.read_bytes())
    adoptable(record, shards)
    need(stop_reason is None or (isinstance(stop_reason, str) and 0 < len(stop_reason) <= 512),
         'invalid operator stop reason')
    alert = alert or (lambda line: print(line, file=sys.stderr, flush=True))
    lock = os.open(journal.with_name('coordination.adopt.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(lock)
        raise ValueError('another adopting coordinator owns this run')
    total, policy, release_id = record['scheduled_total'], record['infra_early_stop'], record['release_id']
    if record.get('released_at') is not None:
        decision = ('global-release.json', dict(release_id=release_id, reason='all %d shards ready' % len(shards)))
    else:
        decision = ('global-abort.json', dict(release_id=release_id, reason=record['abort_reason']))
    detach = [None]
    previous = {s: signal.getsignal(s) for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}

    def request_detach(number, frame):
        detach[0] = detach[0] or signal.Signals(number).name

    for number in previous:
        signal.signal(number, request_detach)
    owner = dict(pid=os.getpid(), birth=process_birth(os.getpid()), adopting=True)
    adoption = dict(at=clock(), coordinator=owner, previous_coordinator=record.get('coordinator'),
                    previous_shards=dict(record['shards']), lost=[], operator_stop=stop_reason)
    prior = terminate_cause(record)
    if prior is not None and prior not in REPLAYED_STOP_CAUSES:
        # A signal-derived stop may be the host restart itself; never replay it into the campaign.
        adoption['unreplayed_stop'] = dict(cause=prior, reason=record.get('terminate_reason'))
        alert('ADOPTION_UNREPLAYED_STOP ' + json.dumps(adoption['unreplayed_stop']))
    record['adoptions'] = list(record.get('adoptions') or []) + [adoption]
    record['coordinator'] = owner
    by_index = {s['index']: s for s in shards}
    runners = {}

    def settled(index, code):
        return code == 0 and (read_status(by_index[index]['out']) or {}).get('state') in TERMINAL_SUPERVISOR

    try:
        if stop_reason is not None and (record['terminated_at'] is None or prior not in REPLAYED_STOP_CAUSES):
            record.update(terminated_at=clock(), terminate_cause='operator', terminate_reason='operator stop: ' + stop_reason)
        for shard in shards:
            runners[shard['index']] = spawn(shard)
            record['shards'][str(shard['index'])] = dict(out=str(shard['out']), pid=runners[shard['index']].pid)
        save(journal, record)
        while True:
            exited = {i: p.poll() for i, p in runners.items()}
            statuses = {s['index']: read_status(s['out']) for s in shards}
            infra = sum(int(((v or {}).get('infra') or {}).get('infra_true') or 0) for v in statuses.values())
            if infra != record.get('infra_true'):
                record['infra_true'] = infra
                save(journal, record)
            for shard in shards:
                if not (Path(shard['out']) / decision[0]).exists():
                    write_once(Path(shard['out']) / decision[0], decision[1])
            if record['terminated_at'] is None and policy == 'enabled' and 20 * infra >= total:
                record.update(terminated_at=clock(), terminate_cause='threshold',
                              terminate_reason='infra %d/%d reached the 5%% threshold' % (infra, total))
                save(journal, record)
            if terminate_cause(record) in REPLAYED_STOP_CAUSES:
                for shard in shards:
                    if not (Path(shard['out']) / OWNER_STOP).exists():
                        write_once(Path(shard['out']) / OWNER_STOP,
                                   dict(release_id=release_id, reason=record['terminate_reason']))
            reported = {item['shard'] for item in adoption['lost']}
            for i, code in exited.items():
                if code is not None and i not in reported and not settled(i, code):
                    lost = dict(shard=i, exit_code=code, at=clock(), supervisor_state=(statuses[i] or {}).get('state'))
                    adoption['lost'].append(lost)
                    save(journal, record)
                    alert('ADOPTER_LOST ' + json.dumps(lost))
            if detach[0] or all(code is not None for code in exited.values()):
                break
            sleep(poll_seconds)
        if detach[0]:
            adoption['detached'] = dict(at=clock(), signal=detach[0])
            for process in runners.values():
                if process.poll() is None:
                    process.send_signal(signal.SIGTERM)  # an adopter detaches; it never stops its supervisor
        codes = {i: p.wait() for i, p in runners.items()}
        adoption['exit_codes'] = {str(i): c for i, c in codes.items()}
        if not detach[0] and all(settled(i, c) for i, c in codes.items()):
            record.update(exit_codes=adoption['exit_codes'], finished_at=clock())
        save(journal, record)
        return record
    except BaseException as error:
        # A recovery tool never stops a healthy campaign: detach every adopter, keep the journal adoptable.
        adoption['error'] = type(error).__name__
        for process in runners.values():
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)
        adoption['exit_codes'] = {str(i): p.wait() for i, p in runners.items()}
        try:
            save(journal, record)
        except OSError:
            pass
        raise
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)
        os.close(lock)


def coordinate(shards, spawn, journal, *, scheduled_total, infra_early_stop='enabled',
               poll_seconds=1.0, clock=time.time, sleep=time.sleep, respawn=None,
               stagger_seconds=0.0, max_attempts=MAX_SHARD_ATTEMPTS, startup_deadline=None):
    """Run K runners to completion under one global barrier. Returns the coordination record.

    shards: [{'index': i, 'out': Path}], spawn(shard) -> Popen-like (poll/wait/send_signal/pid).
    respawn(shard) -> (shard, Popen-like): a fresh attempt for a shard whose runner ended
    before release with a retryable startup terminal; None disables retries.
    After a host death, adopt_coordinate() continues this journal instead.
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
                  terminate_reason=None, shards={}, coordinator=dict(pid=os.getpid(), birth=process_birth(os.getpid())))
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
            startup_expired = startup_deadline is not None and clock() >= startup_deadline
            if decided is None and respawn is not None and not stop[0] and not startup_expired:
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
            startup_expired = startup_deadline is not None and clock() >= startup_deadline
            if decided is None:
                failed = [i for i in runners if barrier[i] in FAILED_STATES or exited[i] is not None
                          or (statuses[i] or {}).get('state') in TERMINAL_SUPERVISOR]
                if stop[0] or failed or startup_expired:
                    decided = 'abort'
                    record.update(aborted_at=clock(), abort_reason=(
                        'operator ' + stop[0] if stop[0] else 'startup budget exhausted before global release' if startup_expired else 'shard %s failed before global release' % failed))
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
            if record['terminated_at'] is None and (stop[0] or threshold or (decided == 'abort' and startup_expired)):
                record.update(terminated_at=clock(), terminate_cause='signal' if stop[0] else 'startup_budget' if decided == 'abort' and startup_expired else 'threshold', terminate_reason=(
                    'operator ' + stop[0] if stop[0] else 'startup budget exhausted before global release' if decided == 'abort' and startup_expired else 'infra %d/%d reached the 5%% threshold' % (infra, scheduled_total)))
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
                      terminate_cause=record.get('terminate_cause') or 'internal',
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
