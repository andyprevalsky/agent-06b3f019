"""Supervise the original 600-job campaign; stop at 30 unique infrastructure failures."""
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time
from contextlib import contextmanager

TERMINAL = {'failed', 'passed', 'cancelled'}

def fold(summary):
    """Count affected logical jobs once, retaining every physical outcome."""
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
            'trigger': len(infra) >= 30, 'records': records}

def should_stop(result, trigger_saved):
    return result['trigger'] or trigger_saved

def birth(pid):
    raw = Path('/proc', str(pid), 'stat').read_text()
    fields = raw[raw.rfind(')')+2:].split()
    if fields[0] == 'Z':
        raise ValueError('parent zombie')
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    return 'proc-start:'+boot+':'+fields[19]

def validate_snapshot(summary, manifest, epoch, campaign_id, deadline, tasks=None):
    if summary.get('campaign_id') != campaign_id or summary.get('e2e_started_at_epoch') != epoch:
        raise ValueError('campaign/epoch mismatch')
    if summary.get('total_jobs') != 600 or summary.get('concurrency') != 600 or len(summary['jobs']) != 600:
        raise ValueError('600 membership mismatch')
    jobs = {j['job_id']: j for j in summary['jobs']}
    if len(jobs) != 600 or manifest.get('cohort_id') != 'c001' or set(manifest['jobs']) != set(jobs):
        raise ValueError('original manifest membership mismatch')
    if type(deadline) not in (int,float) or not math.isfinite(deadline) or deadline <= 0:
        raise ValueError('invalid original deadline')
    if manifest.get('e2e_deadline_monotonic') != deadline:
        raise ValueError('original deadline changed')
    for pid in manifest['jobs'].values():
        if pid is not None and (type(pid) is not int or pid <= 0):
            raise ValueError('invalid manifest PID')
    if tasks is not None:
        from collections import Counter
        if len(tasks) != 200 or len(set(tasks)) != 200:
            raise ValueError('original 200 task membership mismatch')
        if Counter(j.get('task') for j in jobs.values()) != Counter({t: 3 for t in tasks}):
            raise ValueError('original task/k3 mismatch')
        if {(j.get('task'), j.get('run')) for j in jobs.values()} != {(t, r) for t in tasks for r in (1, 2, 3)}:
            raise ValueError('original task/run identities mismatch')
    # Ready/released counts never change the fixed 30/600 denominator.
    return fold(summary)

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
    task_ref = '570830dbf17635e13d16a6f03b4d705f6b6443b1'
    task_raw = Path(os.environ['REVIEWED_OPERATOR_TASKS']).read_bytes()
    if hashlib.sha256(task_raw).hexdigest() != os.environ['REVIEWED_OPERATOR_TASKS_SHA256']:
        raise ValueError('original tasks bytes changed')
    tasks = json.loads(task_raw)
    if not isinstance(tasks, list) or len(tasks) != 200 or len(set(tasks)) != 200:
        raise ValueError('original 200 tasks required')
    if hashlib.sha256(('\n'.join(tasks)+'\n').encode()).hexdigest() != '660873a9e02c6c5682a98e9a00dd0133c394a16dcdefd726bcb0a8987f1b59f5':
        raise ValueError('original ordered 200 tasks changed')
    epoch = float(sys.argv[1])
    args = sys.argv[2:]
    if not args or args[:2] != ['bash','scripts/run-bench']:
        raise ValueError('unexpected reviewed command')
    for flag, value in [('--concurrency','600'), ('-k','3'), ('--retry-infra','1'), ('--timeout','1200'), ('--e2e-timeout','5400'), ('--e2e-started-at',sys.argv[1]), ('--ref',task_ref)]:
        if args.count(flag) != 1 or args[args.index(flag)+1] != value:
            raise ValueError('original rollout option changed: '+flag)
    if args[-200:] != tasks:
        raise ValueError('original ordered task arguments changed')
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
    env = dict(os.environ, RUN_BENCH_CAMPAIGN_ID=campaign_id)
    destination = repo/'.context/stress200-host'/campaign_id
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
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
                    validate_snapshot(summary,manifest,epoch,campaign_id,original_deadline,tasks)
                    save_once(destination/'threshold-original-parent.private.json',encode({
                        'parent_pid':parent.pid,'parent_birth':expected_birth,'source_ref':ref,
                        'original_epoch':epoch,'campaign_id':campaign_id,
                        'e2e_deadline_monotonic':original_deadline,'members':original_membership}))
                result = validate_snapshot(summary,manifest,epoch,campaign_id,original_deadline,tasks)
                if result['infra_true'] and not first_reported:
                    evidence = {'summary_sha256':hashlib.sha256(raw).hexdigest(),
                                'observed_epoch':time.time(),**result}
                    save_once(destination/'first-authentic-infra-summary.private.json',raw)
                    save_once(destination/'first-authentic-infra.private.json',encode(evidence))
                    first = next(r for r in result['records'] if r.get('infra_failure') is True and r.get('status') != 'cancelled')
                    print('FIRST_AUTHENTIC_INFRA '+json.dumps({k:first.get(k) for k in ['job_id','task','attempt','log','run_id','task_status']}),flush=True)
                    first_reported = True
                if should_stop(result, (destination/'first-infra-threshold-trigger.private.json').exists()) and not stopped and parent.poll() is None:
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
                    validate_snapshot(current,current_manifest,epoch,campaign_id,original_deadline,tasks)
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
