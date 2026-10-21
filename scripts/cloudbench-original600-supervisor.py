"""Supervise original600 with an explicitly bound infrastructure-stop policy."""
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time
from contextlib import contextmanager

TERMINAL = {'failed', 'passed', 'cancelled'}
INFRA_THRESHOLD = 30
ORIGINAL_TASK_NAMES_SHA256 = '660873a9e02c6c5682a98e9a00dd0133c394a16dcdefd726bcb0a8987f1b59f5'
SHARD_FIELDS = {'index', 'count', 'tasks', 'tasks_sha256', 'task_indexes', 'runs',
                'group_run_id', 'group_total', 'group_started_at'}
# Optional bound shard fields; absent means the original600 value (runner SHARD_OPTIONAL).
SHARD_OPTIONAL = {'infra_threshold', 'manifest_sha256', 'task_timeout', 'e2e_timeout', 'task_ref'}
# Historical guest task source; a shard binds its own pushed ref in task_ref.
ORIGINAL_TASK_REF = '1387ae608e7cfb8e3f0a876daae92093f503b465'
DEFAULT_TASK_TIMEOUT = 1200
RUN_DEADLINE = 5400
# The runner's E2E_ALLOWANCE: startup to barrier release (720+900), one copy's
# post-window tail (720) and evidence/full release (480).
POST_TASK_ALLOWANCE = 720+480
E2E_ALLOWANCE = 720+900+POST_TASK_ALLOWANCE
MAX_TASK_TIMEOUT = 7200  # the runner's MAX_TASK_TIMEOUT
MAX_RUN_DEADLINE = MAX_TASK_TIMEOUT+E2E_ALLOWANCE

def names_sha256(tasks):
    return hashlib.sha256(('\n'.join(tasks)+'\n').encode()).hexdigest()

def shard_timeouts(shard):
    """The shard's bound task/e2e timeouts; the runner's campaign_timeouts bounds."""
    if shard.get('task_timeout') == DEFAULT_TASK_TIMEOUT or shard.get('e2e_timeout') == RUN_DEADLINE:
        raise ValueError('default timeouts are encoded by absence')
    task, e2e = shard.get('task_timeout', DEFAULT_TASK_TIMEOUT), shard.get('e2e_timeout', RUN_DEADLINE)
    if type(task) is not int or not 60 <= task <= MAX_TASK_TIMEOUT:
        raise ValueError('invalid bound task timeout')
    if type(e2e) is not int or not task+POST_TASK_ALLOWANCE < e2e <= MAX_RUN_DEADLINE:
        raise ValueError('invalid bound e2e timeout')
    return task, e2e

def shard_task_ref(shard):
    """The guest task source: a shard's bound task_ref, or the pinned original when absent."""
    if shard is None or 'task_ref' not in shard:
        return ORIGINAL_TASK_REF
    ref = shard['task_ref']
    # One canonical encoding: the original value is encoded by absence.
    if not isinstance(ref, str) or not re.fullmatch('[0-9a-f]{40}', ref) or ref == ORIGINAL_TASK_REF:
        raise ValueError('invalid bound task ref')
    return ref

def group_infra_threshold(shard):
    """The shard's own stop count: an explicitly bound one, else 5% of its group's scheduled total.

    The host coordinator sums shards against the same fixed predicate. Binding it here keeps a
    stop alive on the guest when the host owner dies: any one shard reaching the group threshold
    implies the group reached it, so this never stops earlier than the global rule."""
    return shard.get('infra_threshold', -(-shard['group_total'] // 20))

def bound_manifest(tasks, shard):
    """The ordered launch manifest: the pinned original 200, or a shard's explicitly bound one."""
    bound = ORIGINAL_TASK_NAMES_SHA256 if shard is None else shard.get('manifest_sha256', ORIGINAL_TASK_NAMES_SHA256)
    if shard is not None and 'manifest_sha256' in shard and (
            not isinstance(bound, str) or not re.fullmatch('[0-9a-f]{64}', bound) or bound == ORIGINAL_TASK_NAMES_SHA256):
        raise ValueError('invalid bound manifest hash')
    if (not isinstance(tasks, list) or not tasks or len(set(tasks)) != len(tasks)
            or any(not isinstance(t, str) or not t for t in tasks)):
        raise ValueError('distinct ordered tasks required')
    if bound == ORIGINAL_TASK_NAMES_SHA256 and len(tasks) != 200:
        raise ValueError('original 200 tasks required')
    if names_sha256(tasks) != bound:
        raise ValueError('original ordered 200 tasks changed' if bound == ORIGINAL_TASK_NAMES_SHA256 else 'bound ordered tasks changed')

def fold(summary, threshold=INFRA_THRESHOLD):
    """Count affected logical jobs once, retaining every physical outcome."""
    if type(threshold) is not int or threshold < 1:
        raise ValueError('invalid infrastructure threshold')
    records, seen, jobs = [], set(), set()
    infra, unknown, agent, cancelled = set(), set(), set(), set()
    for job in summary['jobs']:
        jid = job['job_id']
        if not isinstance(jid, str) or jid in jobs:
            raise ValueError('duplicate logical job')
        jobs.add(jid)
        for attempt in job.get('attempts', []):
            identity = (jid, attempt['attempt'])
            if type(attempt['attempt']) is not int or attempt['attempt'] not in (1, 2) or identity in seen:
                raise ValueError('duplicate/invalid physical attempt')
            seen.add(identity)
            if attempt.get('status') not in TERMINAL or not attempt.get('finished_at'):
                continue
            flag = attempt.get('infra_failure')
            if flag is not None and type(flag) is not bool:
                raise ValueError('invalid infrastructure flag')
            row = dict(attempt, job_id=jid, task=job['task'])
            records.append(row)
            if attempt['status'] == 'cancelled':
                cancelled.add(jid)
            elif flag is True:
                infra.add(jid)
            elif flag is None:
                unknown.add(jid)
            elif attempt['status'] == 'failed':
                agent.add(jid)
    return {'terminal': len(records), 'infra_true': len(infra),
            'infra_false': sum(r.get('infra_failure') is False for r in records),
            'infra_unknown': len(unknown), 'agent_failed_unique': len(agent),
            'cancelled_unique': len(cancelled), 'infra_job_ids': sorted(infra),
            'trigger': len(infra) >= threshold, 'records': records}

PROGRESS_COMBOS = 40
PROGRESS_REASONS = 5
CARD_BYTES = 512 * 1024


def card_reason(job, cache):
    """A terminal non-pass job's recorded failure reason from its own fleet report card.

    Read once per terminal fleet directory (the card is final by then); missing,
    oversized or malformed cards contribute no reason."""
    if job.get('status') not in TERMINAL or job.get('task_status') == 'PASSED':
        return None
    fleet = job.get('fleet_dir')
    if not isinstance(fleet, str) or not fleet:
        return None
    if fleet not in cache:
        cache[fleet] = None
        try:
            path = Path(fleet)/'_batch/report-card.json'
            if path.stat().st_size <= CARD_BYTES:
                card = json.loads(path.read_bytes())
                rows = [r for r in card.get('per_task') or [] if isinstance(r, dict)]
                row = next((r for r in rows if r.get('name') == job.get('task')), rows[0] if len(rows) == 1 else {})
                reason = row.get('failure_reason')
                if isinstance(reason, str) and reason.strip():
                    cache[fleet] = re.sub(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<id>',
                                          reason.strip().split(' | ')[0])[:120]
        except (OSError, ValueError, AttributeError):
            pass
    return cache[fleet]


def progress_counters(summary, cache):
    """Small bounded job counters for the external runner PROBE (live scorecard)."""
    combos, reasons = {}, {}
    terminal_attempts = infra_attempts = 0
    for job in summary.get('jobs') or []:
        if not isinstance(job, dict):
            continue
        verdict = job.get('task_status')
        infra = job.get('infra_failure')
        key = (str(job.get('status'))[:16], verdict[:16] if isinstance(verdict, str) else None,
               infra if isinstance(infra, bool) else None)
        combos[key] = combos.get(key, 0) + 1
        for attempt in job.get('attempts') or []:
            if isinstance(attempt, dict) and attempt.get('status') in TERMINAL and attempt.get('finished_at'):
                terminal_attempts += 1
                infra_attempts += attempt.get('infra_failure') is True
        reason = card_reason(job, cache)
        if reason:
            category = 'INFRA' if infra is True else 'AGENT FAIL' if verdict == 'FAILED' else 'UNKNOWN'
            reasons[(category, reason)] = reasons.get((category, reason), 0) + 1
    ordered = sorted(combos.items(), key=lambda item: (-item[1], str(item[0])))[:PROGRESS_COMBOS]
    top = sorted(reasons.items(), key=lambda item: (-item[1], item[0]))[:PROGRESS_REASONS]
    return {'combos': [[s, t, i, n] for (s, t, i), n in ordered], 'jobs': len(summary.get('jobs') or []),
            'terminal_attempts': terminal_attempts, 'infra_attempts': infra_attempts,
            'reasons': [[category, reason, n] for (category, reason), n in top]}


def should_stop(result, trigger_saved, policy='enabled'):
    if policy not in ('enabled', 'disabled'):
        raise ValueError('invalid infrastructure early-stop policy')
    return policy == 'enabled' and (result['trigger'] or trigger_saved)

def birth(pid):
    raw = Path('/proc', str(pid), 'stat').read_text()
    fields = raw[raw.rfind(')')+2:].split()
    if fields[0] == 'Z':
        raise ValueError('parent zombie')
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    return 'proc-start:'+boot+':'+fields[19]

def validate_shard(shard, manifest):
    """An ordered subset of its bound manifest (the pinned original when unbound); returns the shard job count."""
    if not isinstance(shard, dict) or not SHARD_FIELDS <= set(shard) <= SHARD_FIELDS | SHARD_OPTIONAL:
        raise ValueError('exact shard fields required')
    bound_manifest(manifest, shard)
    shard_task_ref(shard)
    index, count, runs, names = shard['index'], shard['count'], shard['runs'], shard['tasks']
    if any(type(x) is not int for x in (index, count, runs)) or not 0 <= index < count or runs < 1:
        raise ValueError('invalid shard index/count/runs')
    if (not isinstance(names, list) or not names or len(set(names)) != len(names)
            or any(not isinstance(t, str) or not t for t in names)):
        raise ValueError('distinct shard tasks required')
    if hashlib.sha256(('\n'.join(names)+'\n').encode()).hexdigest() != shard['tasks_sha256']:
        raise ValueError('shard task hash changed')
    indexes = shard['task_indexes']
    if (not isinstance(indexes, list) or len(indexes) != len(names) or len(set(indexes)) != len(indexes)
            or any(type(i) is not int or not 0 <= i < len(manifest) for i in indexes)):
        raise ValueError('distinct task indexes for every shard task required')
    if any(manifest[i] != t for i, t in zip(indexes, names)) or indexes != sorted(indexes):
        raise ValueError('shard tasks must be an ordered subset of the bound manifest at their indexes')
    if not isinstance(shard['group_run_id'], str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}', shard['group_run_id']):
        raise ValueError('invalid shared group id')
    total, started = shard['group_total'], shard['group_started_at']
    if type(total) is not int or not len(names)*runs <= total <= len(manifest)*runs or total % runs:
        raise ValueError('invalid shared group total')
    if any(i >= total//runs for i in indexes):
        raise ValueError('task index outside the group width')
    if type(started) not in (int, float) or not math.isfinite(started) or started <= 0:
        raise ValueError('invalid shared group start')
    threshold = group_infra_threshold(shard)
    if type(threshold) is not int or threshold < 1:
        raise ValueError('invalid infrastructure threshold')
    shard_timeouts(shard)
    return len(names)*runs

def shard_job_ids(shard):
    """Group-wide job IDs r{run}-j{(run-1)*width+index+1} of exactly this shard's tasks."""
    width = shard['group_total']//shard['runs']
    return {f'r{run:03d}-j{(run-1)*width+index+1:04d}': (task, run)
            for run in range(1, shard['runs']+1) for index, task in zip(shard['task_indexes'], shard['tasks'])}

def shard_membership(jobs, shard):
    expected = shard_job_ids(shard)
    if set(jobs) != set(expected) or any((job.get('task'), job.get('run')) != expected[jid] for jid, job in jobs.items()):
        raise ValueError('shard task/run/job identities mismatch')

def validate_snapshot(summary, manifest, epoch, campaign_id, deadline, tasks=None, shard=None):
    if summary.get('campaign_id') != campaign_id or summary.get('e2e_started_at_epoch') != epoch:
        raise ValueError('campaign/epoch mismatch')
    expected = 600 if shard is None else len(shard['tasks'])*shard['runs']
    if summary.get('total_jobs') != expected or summary.get('concurrency') != expected or len(summary['jobs']) != expected:
        raise ValueError(str(expected)+' membership mismatch')
    jobs = {j['job_id']: j for j in summary['jobs']}
    if len(jobs) != expected or manifest.get('cohort_id') != 'c001' or set(manifest['jobs']) != set(jobs):
        raise ValueError('original manifest membership mismatch')
    if type(deadline) not in (int,float) or not math.isfinite(deadline) or deadline <= 0:
        raise ValueError('invalid original deadline')
    if manifest.get('e2e_deadline_monotonic') != deadline:
        raise ValueError('original deadline changed')
    for pid in manifest['jobs'].values():
        if pid is not None and (type(pid) is not int or pid <= 0):
            raise ValueError('invalid manifest PID')
    if shard is not None:
        if summary.get('group_total') != shard['group_total']:
            raise ValueError('shared group total changed')
        shard_membership(jobs, shard)
    elif tasks is not None:
        from collections import Counter
        if len(tasks) != 200 or len(set(tasks)) != 200:
            raise ValueError('original 200 task membership mismatch')
        if Counter(j.get('task') for j in jobs.values()) != Counter({t: 3 for t in tasks}):
            raise ValueError('original task/k3 mismatch')
        if {(j.get('task'), j.get('run')) for j in jobs.values()} != {(t, r) for t in tasks for r in (1, 2, 3)}:
            raise ValueError('original task/run identities mismatch')
    # Ready/released counts never change the fixed threshold/scheduled denominator.
    return fold(summary, INFRA_THRESHOLD if shard is None else group_infra_threshold(shard))

def publish_status(path, value):
    """Atomically replace a small private status file for the external runner PROBE."""
    temporary = path.with_name('.'+path.name+'.'+str(os.getpid()))
    fd = os.open(temporary, os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(encode(value))
        os.replace(temporary, path)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)

def shard_controls(shard, identity_path, environment):
    """The launch environment carries exactly this shard's campaign controls."""
    if not identity_path:
        raise ValueError('sharded supervisor identity required')
    expected = {'RUN_BENCH_CAMPAIGN_EXTERNAL_BARRIER': str(Path(identity_path).with_suffix('.barrier')),
                'RUN_BENCH_CAMPAIGN_TASK_INDEXES': ','.join(map(str, shard['task_indexes'])),
                'RUN_BENCH_CAMPAIGN_GROUP_TOTAL': str(shard['group_total']),
                'RUN_BENCH_CAMPAIGN_GROUP_STARTED_AT': str(shard['group_started_at']),
                'BENCHMARK_HUB_GROUP_RUN_ID': shard['group_run_id'],
                'CLOUDBENCH_CAMPAIGN_MUTATION_ADMISSION': '1'}
    for key, value in expected.items():
        if environment.get(key) != value:
            raise ValueError('shard campaign control changed: '+key)
    return Path(identity_path).with_suffix('.infra.json')

def save_once(path, raw):
    fd = os.open(path, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    fd = os.open(path.parent, os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)

def encode(value):
    return (json.dumps(value, sort_keys=True)+'\n').encode()

def fence(repo, parent, expected_birth, ref, campaign):
    if birth(parent.pid) != expected_birth or parent.poll() is not None:
        raise ValueError('original parent identity changed')
    if os.readlink('/proc/'+str(parent.pid)+'/cwd') != str(repo/'agents'):
        raise ValueError('parent cwd mismatch')
    argv = Path('/proc', str(parent.pid), 'cmdline').read_bytes().split(b'\0')
    if not any(Path(part.decode()).name == 'run-bench-campaign.py' for part in argv if part):
        raise ValueError('parent executable mismatch')
    if subprocess.check_output(['git','--no-replace-objects','-C',str(repo),'rev-parse','HEAD'],text=True).strip() != ref:
        raise ValueError('source changed')
    lock = campaign/'startup-cohorts/parent.lock'
    info = lock.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError('unsafe parent lock')
    with lock.open('rb') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            pass
        else:
            raise ValueError('original parent lock not held')
    owned = False
    for fd in Path('/proc',str(parent.pid),'fd').iterdir():
        try:
            target = fd.stat()
        except FileNotFoundError:
            continue
        owned |= (target.st_dev,target.st_ino)==(info.st_dev,info.st_ino)
    if not owned or birth(parent.pid) != expected_birth:
        raise ValueError('parent lock owner mismatch')

@contextmanager
def owned_parent(args, repo, env, destination, ref, epoch):
    """Keep this supervisor alive through exact parent cleanup after local failure."""
    parent = None
    expected_birth = None
    stop_requested = False
    previous = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
    def stop(signum, frame):
        nonlocal stop_requested
        stop_requested = True
        if parent is not None and expected_birth is not None and parent.poll() is None:
            try:
                if birth(parent.pid) == expected_birth:
                    parent.send_signal(signal.SIGTERM)
            except (FileNotFoundError, ProcessLookupError, ValueError):
                pass
    for sig in previous:
        signal.signal(sig, stop)
    try:
        parent = subprocess.Popen(args, cwd=repo, env=env)
        expected_birth = birth(parent.pid)
        if stop_requested:
            stop(signal.SIGTERM, None)
        yield parent, expected_birth
    finally:
        if parent is not None and parent.poll() is None and expected_birth is not None:
            stop(signal.SIGTERM, None)
        # No group signal or kill. A source-owned parent joins its controllers.
        try:
            status = parent.wait() if parent is not None else None
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
        if parent is None:
            raise RuntimeError('campaign parent was not created')
        value = dict(parent_pid=parent.pid, parent_birth=expected_birth,
                     parent_exit_code=status, parent_joined=True,
                     source_ref=ref, original_epoch=epoch)
        save_once(destination/'supervisor-parent-joined.safe.json', encode(value))
        identity_path = env.get('REVIEWED_OPERATOR_IDENTITY_PATH')
        if identity_path:
            path = Path(identity_path)
            identity = json.loads(path.read_bytes())
            if identity['pid'] != os.getpid() or identity['birth'] != birth(os.getpid()):
                raise ValueError('external supervisor identity changed')
            code = status if sys.exc_info()[0] is None else 1
            save_once(path.with_suffix('.terminal.json'), encode(dict(
                **identity, supervisor_exit_code=code, supervisor_joined=True,
                parent_pid=parent.pid, parent_birth=expected_birth,
                parent_joined=True, epoch_finished=time.time())))

def main():
    repo = Path(os.environ['REVIEWED_OPERATOR_ROOT']).resolve(strict=True)
    ref = os.environ['REVIEWED_OPERATOR_SOURCE_REF']
    if len(ref) != 40 or any(c not in '0123456789abcdef' for c in ref):
        raise ValueError('final source is not bound')
    task_ref = ORIGINAL_TASK_REF
    task_raw = Path(os.environ['REVIEWED_OPERATOR_TASKS']).read_bytes()
    if hashlib.sha256(task_raw).hexdigest() != os.environ['REVIEWED_OPERATOR_TASKS_SHA256']:
        raise ValueError('original tasks bytes changed')
    tasks = json.loads(task_raw)
    # An optional shard is a bound launch input; absent keeps the original 600/k3 checks.
    # The shard binds its ordered manifest hash; without one the pinned original 200 applies.
    shard = None
    if os.environ.get('REVIEWED_OPERATOR_SHARD'):
        shard_raw = Path(os.environ['REVIEWED_OPERATOR_SHARD']).read_bytes()
        if hashlib.sha256(shard_raw).hexdigest() != os.environ.get('REVIEWED_OPERATOR_SHARD_SHA256'):
            raise ValueError('shard launch input changed')
        shard = json.loads(shard_raw)
        validate_shard(shard, tasks)
    else:
        bound_manifest(tasks, None)
    task_ref = shard_task_ref(shard)
    expected_jobs = 600 if shard is None else len(shard['tasks'])*shard['runs']
    expected_runs = 3 if shard is None else shard['runs']
    task_timeout, e2e_timeout = (DEFAULT_TASK_TIMEOUT, RUN_DEADLINE) if shard is None else shard_timeouts(shard)
    epoch = float(sys.argv[1])
    args = sys.argv[2:]
    if not args or args[:2] != ['bash','scripts/run-bench']:
        raise ValueError('unexpected reviewed command')
    for flag, value in [('--concurrency',str(expected_jobs)), ('-k',str(expected_runs)), ('--retry-infra','1'), ('--timeout',str(task_timeout)), ('--e2e-timeout',str(e2e_timeout)), ('--e2e-started-at',sys.argv[1]), ('--ref',task_ref)]:
        if args.count(flag) != 1 or args[args.index(flag)+1] != value:
            raise ValueError('original rollout option changed: '+flag)
    if shard is None:
        if args[-200:] != tasks:
            raise ValueError('original ordered task arguments changed')
    elif args[args.index('--ref')+2:] != shard['tasks'] or '--stress-defaults' in args:
        raise ValueError('shard ordered task arguments changed')
    infra_path = None if shard is None else shard_controls(shard, os.environ.get('REVIEWED_OPERATOR_IDENTITY_PATH'), os.environ)
    if subprocess.check_output(['git','--no-replace-objects','-C',str(repo),'rev-parse','HEAD'],text=True).strip() != ref:
        raise ValueError('harness source changed before launch')
    if '--strict-barrier' not in args or '--qualify-worker' in args or '--reuse-pool-only' in args:
        raise ValueError('original disposable strict rollout required')
    if not math.isfinite(epoch) or epoch <= 0 or time.time() >= epoch+5400:
        raise ValueError('original attempt epoch expired')
    namespace = hashlib.sha256((float(epoch).hex()+':'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()).encode()).hexdigest()[:24]
    campaign_id = 'campaign-qualified600-'+namespace+'-'+str(os.getpid())
    campaign = repo/'.context/benchmarks/campaigns'/campaign_id
    if campaign.exists():
        raise ValueError('new campaign destination exists')
    policy = os.environ.get('CLOUDBENCH_ORIGINAL600_INFRA_EARLY_STOP', 'enabled')
    should_stop({'trigger': False}, False, policy)
    env = dict(os.environ, RUN_BENCH_CAMPAIGN_ID=campaign_id)
    if shard is not None:
        env["RUN_BENCH_CAMPAIGN_STARTUP_DEADLINE_EPOCH"] = str(epoch+e2e_timeout-task_timeout-POST_TASK_ALLOWANCE)
    destination = repo/'.context/stress200-host'/campaign_id
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    save_once(destination/'infra-early-stop-policy.safe.json', encode(dict(infra_early_stop=policy, source_ref=ref, original_epoch=epoch, task_timeout_seconds=task_timeout, run_timeout_seconds=e2e_timeout)))
    with owned_parent(args,repo,env,destination,ref,epoch) as (parent,expected_birth):
        if parent.poll() is not None:
            return parent.wait()
        def forward_owner_stop(signum, frame):
            if parent.poll() is None and birth(parent.pid) == expected_birth:
                parent.send_signal(signal.SIGTERM)
        signal.signal(signal.SIGTERM, forward_owner_stop)
        signal.signal(signal.SIGINT, forward_owner_stop)
        original_deadline = None
        original_membership = None
        first_reported = False
        stopped = False
        last_refusal = None
        card_cache = {}
        while True:
            try:
                raw = (campaign/'summary.json').read_bytes()
                summary = json.loads(raw)
                manifest_raw = (campaign/'startup-cohorts/c001/manifest.json').read_bytes()
                manifest = json.loads(manifest_raw)
                if original_deadline is None:
                    fence(repo,parent,expected_birth,ref,campaign)
                    original_deadline = manifest['e2e_deadline_monotonic']
                    original_membership = sorted(manifest['jobs'])
                    validate_snapshot(summary,manifest,epoch,campaign_id,original_deadline,tasks,shard)
                    save_once(destination/'threshold-original-parent.private.json',encode({
                        'parent_pid':parent.pid,'parent_birth':expected_birth,'source_ref':ref,
                        'original_epoch':epoch,'campaign_id':campaign_id,
                        'e2e_deadline_monotonic':original_deadline,'members':original_membership}))
                result = validate_snapshot(summary,manifest,epoch,campaign_id,original_deadline,tasks,shard)
                if infra_path is not None:
                    try:
                        publish_status(infra_path, {'schema':'original600-shard-infra-v1','infra_true':result['infra_true'],
                                                    'unique_jobs':len(summary['jobs']),'observed_at':time.time(),
                                                    'progress':progress_counters(summary, card_cache)})
                    except OSError as error:  # status only; never a reason to stop the campaign parent
                        message = 'INFRA_STATUS_WRITE_FAILED '+type(error).__name__
                        if message != last_refusal:
                            print(message, file=sys.stderr, flush=True)
                            last_refusal = message
                if result['infra_true'] and not first_reported:
                    evidence = {'summary_sha256':hashlib.sha256(raw).hexdigest(),
                                'observed_epoch':time.time(),**result}
                    save_once(destination/'first-authentic-infra-summary.private.json',raw)
                    save_once(destination/'first-authentic-infra.private.json',encode(evidence))
                    first = next(r for r in result['records'] if r.get('infra_failure') is True and r.get('status') != 'cancelled')
                    print('FIRST_AUTHENTIC_INFRA '+json.dumps({k:first.get(k) for k in ['job_id','task','attempt','log','run_id','task_status']}),flush=True)
                    first_reported = True
                if result['trigger'] and not (destination/'infra-threshold-observed.private.json').exists():
                    save_once(destination/'infra-threshold-observed.private.json', encode(dict(infra_early_stop=policy, summary_sha256=hashlib.sha256(raw).hexdigest(), original_epoch=epoch, observed_epoch=time.time(), **result)))
                if should_stop(result, (destination/'first-infra-threshold-trigger.private.json').exists(), policy) and not stopped and parent.poll() is None:
                    trigger = {'source_ref':ref,'parent_pid':parent.pid,'parent_birth':expected_birth,
                               'original_epoch':epoch,'original_deadline':original_deadline,
                               'summary_sha256':hashlib.sha256(raw).hexdigest(),
                               'observed_epoch':time.time(),**result}
                    trigger_path = destination/'first-infra-threshold-trigger.private.json'
                    if not trigger_path.exists():
                        save_once(destination/'first-infra-threshold-summary.private.json',raw)
                        save_once(trigger_path,encode(trigger))
                    fence(repo,parent,expected_birth,ref,campaign)
                    current = json.loads((campaign/'summary.json').read_bytes())
                    current_manifest = json.loads((campaign/'startup-cohorts/c001/manifest.json').read_bytes())
                    validate_snapshot(current,current_manifest,epoch,campaign_id,original_deadline,tasks,shard)
                    # The preserved first trigger is irrevocable, even if later cancellations dilute it.
                    if sorted(current_manifest['jobs']) != original_membership:
                        raise ValueError('original members changed')
                    if birth(parent.pid) != expected_birth:
                        raise ValueError('parent changed before TERM')
                    parent.send_signal(signal.SIGTERM)
                    stopped = True
                    save_once(destination/'infra-threshold-parent-term.safe.json',encode({
                        'signal':'SIGTERM','parent_pid':parent.pid,'parent_birth':expected_birth,
                        'trigger_sha256':hashlib.sha256(trigger_path.read_bytes()).hexdigest(),
                        'observed_epoch':time.time(),'child_or_group_signals':False}))
                    print('INFRA_THRESHOLD_PARENT_TERM '+json.dumps({'parent_pid':parent.pid,
                        'terminal':result['terminal'],'infra_true':result['infra_true']}),flush=True)
            except FileNotFoundError:
                pass  # Source-owned campaign/manifest can still be initializing or retiring.
            except (ValueError,KeyError,AssertionError,json.JSONDecodeError) as error:
                message = type(error).__name__+': '+str(error)
                if message != last_refusal:
                    print('INFRA_STOP_FENCE_REFUSAL '+message,file=sys.stderr,flush=True)
                    last_refusal = message
            if parent.poll() is not None:
                break
            time.sleep(0.25)
        return parent.wait()

if __name__ == '__main__':
    raise SystemExit(main())
