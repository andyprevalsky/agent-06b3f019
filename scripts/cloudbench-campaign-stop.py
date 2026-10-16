#!/usr/bin/env python3
"""Stop the owned 600-job campaign at 30 confirmed infrastructure-failed jobs."""
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

TERMINAL = {'failed', 'passed', 'cancelled'}

def fold(summary):
    """Fixed scheduled membership owns acceptance; physical attempts are telemetry."""
    jobs = summary['jobs']
    if len(jobs) != 600 or len({job['job_id'] for job in jobs}) != 600:
        raise ValueError('600 scheduled membership mismatch')
    failed_jobs = set()
    records = []
    seen = set()
    for job in summary['jobs']:
        for attempt in job.get('attempts', []):
            identity = (job['job_id'], attempt['attempt'])
            if identity in seen:
                raise ValueError('duplicate physical attempt')
            seen.add(identity)
            if attempt.get('status') not in TERMINAL or not attempt.get('finished_at'):
                continue
            flag = attempt.get('infra_failure')
            if flag is not None and type(flag) is not bool:
                raise ValueError('invalid infrastructure flag')
            records.append({'job_id': job['job_id'], 'task': job['task'], **attempt})
            if flag is True:
                failed_jobs.add(job['job_id'])
    true = sum(row.get('infra_failure') is True for row in records)
    false = sum(row.get('infra_failure') is False for row in records)
    return {'terminal': len(records), 'infra_true': true, 'infra_false': false,
            'infra_unknown': len(records)-true-false,
            'scheduled_jobs': 600, 'infra_failed_jobs': len(failed_jobs),
            'infra_failed_job_ids': sorted(failed_jobs),
            'trigger': 20*len(failed_jobs) >= 600, 'records': records}

def should_stop(result, trigger_saved):
    return result['trigger'] or trigger_saved

def birth(pid):
    raw = Path('/proc', str(pid), 'stat').read_text()
    fields = raw[raw.rfind(')')+2:].split()
    if fields[0] == 'Z':
        raise ValueError('parent zombie')
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    return 'proc-start:'+boot+':'+fields[19]

def validate_snapshot(summary, manifest, epoch, campaign_id, deadline):
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
    # ready/released counts intentionally do not gate the user's threshold stop.
    return fold(summary)

def save_once(path, raw):
    fd = os.open(path, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())

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

def watcher_destination(repo, scope):
    """Opt-in immutable run namespace; legacy receipts are never overwritten."""
    parent = repo/'.context/stress200-host'
    if scope is None:
        return parent
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,95}', scope):
        raise ValueError('invalid watcher scope')
    if parent.resolve(strict=True) != parent:
        raise ValueError('unsafe watcher scope parent')
    descriptor = os.open(parent, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        if info.st_uid != os.getuid():
            raise ValueError('foreign watcher scope parent')
        try:
            os.mkdir(scope, mode=0o700, dir_fd=descriptor)
        except FileExistsError:
            raise ValueError('prior watcher scope requires a fresh reviewed namespace') from None
        child = os.open(scope, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW, dir_fd=descriptor)
        try:
            actual = os.fstat(child)
            if actual.st_uid != os.getuid() or stat.S_IMODE(actual.st_mode) != 0o700:
                raise ValueError('watcher scope is not private and owned')
            os.fsync(child)
        finally:
            os.close(child)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return parent/scope

def main():
    repo = Path('/tmp/gate/repo')
    ref = os.environ['REVIEWED_OPERATOR_SOURCE_REF']
    if len(ref) != 40 or any(c not in '0123456789abcdef' for c in ref):
        raise ValueError('final source is not bound')
    epoch = float(sys.argv[1])
    args = sys.argv[2:]
    scope = None
    if args[:1] == ['--watcher-scope']:
        if len(args) < 4:
            raise ValueError('watcher scope requires a reviewed command')
        scope, args = args[1], args[2:]
    if not args or args[:2] != ['bash','scripts/run-bench']:
        raise ValueError('unexpected reviewed command')
    workspace = repo
    binding = None
    if os.environ.get('CLOUDBENCH_FLEET_ROOT') and Path(os.environ['CLOUDBENCH_FLEET_ROOT']).resolve() != repo.resolve():
        control = Path(__file__).resolve().parent.parent
        module_path = control/'scripts/run-bench-campaign.py'
        checked = subprocess.check_output(['git','--no-replace-objects','-C',str(control),'show',ref+':scripts/run-bench-campaign.py'])
        if module_path.read_bytes() != checked:
            raise ValueError('campaign helper differs from exact reviewed source')
        campaign_module = {'__name__':'campaign_stop_binding','__file__':str(module_path)}
        exec(compile(checked,str(module_path),'exec'),campaign_module)
        workspace, binding = campaign_module['campaign_workspace'](control, args[2:])
        if binding is None or binding['control_ref'] != ref:
            raise ValueError('watcher control/workspace binding differs')
        repo = control
    destination = watcher_destination(workspace, scope)
    watcher_files = ('threshold-original-parent.private.json',
                     'first-authentic-infra-summary.private.json',
                     'first-authentic-infra.private.json',
                     'first-infra-threshold-summary.private.json',
                     'first-infra-threshold-trigger.private.json',
                     'infra-threshold-parent-term.safe.json')
    # Preserve old evidence and refuse before launching any new owned process.
    if any(os.path.lexists(destination/name) for name in watcher_files):
        raise ValueError('prior watcher evidence requires a fresh reviewed namespace')
    namespace = hashlib.sha256((float(epoch).hex()+':'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()).encode()).hexdigest()[:24]
    campaign_id = 'campaign-qualified600-'+namespace+'-'+str(os.getpid())
    campaign = workspace/'.context/benchmarks/campaigns'/campaign_id
    if campaign.exists():
        raise ValueError('new campaign destination exists')
    env = dict(os.environ, RUN_BENCH_CAMPAIGN_ID=campaign_id)
    parent = subprocess.Popen(args,cwd=repo,env=env)
    if parent.poll() is not None:
        return parent.wait()
    expected_birth = birth(parent.pid)
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
                validate_snapshot(summary,manifest,epoch,campaign_id,original_deadline)
                save_once(destination/'threshold-original-parent.private.json',encode({
                    'parent_pid':parent.pid,'parent_birth':expected_birth,'source_ref':ref,
                    **({'workspace_binding': binding} if binding else {}),
                    'original_epoch':epoch,'campaign_id':campaign_id,
                    'e2e_deadline_monotonic':original_deadline,'members':original_membership}))
            result = validate_snapshot(summary,manifest,epoch,campaign_id,original_deadline)
            if result['infra_true'] and not first_reported:
                evidence = {'summary_sha256':hashlib.sha256(raw).hexdigest(),
                            'observed_epoch':time.time(),**result}
                save_once(destination/'first-authentic-infra-summary.private.json',raw)
                save_once(destination/'first-authentic-infra.private.json',encode(evidence))
                first = next(r for r in result['records'] if r.get('infra_failure') is True)
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
                validate_snapshot(current,current_manifest,epoch,campaign_id,original_deadline)
                # A genuine30/600 scheduled-job breach remains latched through retries/cancellation.
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
                    'scheduled_jobs':result['scheduled_jobs'],'infra_failed_jobs':result['infra_failed_jobs'],
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
