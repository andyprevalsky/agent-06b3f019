#!/usr/bin/env python3
"""Portable original600 capacity → bind → owned controller entrypoint."""
import argparse
import ast
import copy
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
import re
from pathlib import Path
import runpy
import signal
import stat
import subprocess
import sys
import time
import urllib.request

PINS = [
    'run-cloudbench-controller-gate', 'cloudbench-disposable-controller.py',
    'cloudbench-controller-export.py', 'cloudbench-original-volume-capture.py',
    'cloudbench-original600-supervisor.py', 'cloudbench-install-controller-client.py',
    'cloudbench-campaign-mutation.py', 'cloudbench-script-snapshot.py',
    'cloudbench-cleanup-tickets.py', 'cloudbench-machine-readiness.py',
    'cloudbench-cohort-reconcile.py', 'cloudbench-shared-relay.py',
    'cloudbench-campaign-env.py', 'cloudbench-campaign-seed.py', 'cloudbench-port-lease.py',
    'cloudbench-operator-preflight.py', 'cloudbench-original600-runner.py',
    'run-original600-controller.py', 'cloudbench-archived-machine-reuse.py',
    'cloudbench-archived-reuse-effects.py', 'cloudbench-archived-reuse-transport.py',
    'cloudbench-retained-successor.py',
    'cloudbench-archived-owner-stop.py', 'cloudbench-stop-all.py',
    'cloudbench-unused-reservations.py',
    'cloudbench-parked-reservations.py',
    'cloudbench-reconcile-reservations.py',
    'cloudbench-observe-reservations.py',
    'cloudbench-incomplete-reservations.py',
    'cloudbench-recovered-reservations.py',
    'cloudbench-closed-transition-reservations.py',
    'cloudbench-prepare-admission.py',
    'cloudbench-reuse-index.py',
    'cloudbench-isolated-generation.py', 'cloudbench-fetch-ref.sh',
    'lib/cloudbench-archived-reuse.sh', 'run-bench-fleet', 'run-bench-cloud',
]


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def reuse_module():
    return runpy.run_path(str(Path(__file__).with_name('cloudbench-archived-machine-reuse.py')))


class AdmissionInterrupted(BaseException):
    def __init__(self, signum):
        self.signum=signum


@contextmanager
def joined_admission_signals():
    """Interrupt admission once, allowing its executor to join owned operations."""
    previous={number:signal.getsignal(number) for number in (signal.SIGINT,signal.SIGTERM)}
    def interrupted(signum, frame):
        # Repeated signals must not interrupt the finite native join/lease release.
        for number in previous:
            signal.signal(number,lambda *_:None)
        raise AdmissionInterrupted(signum)
    for number in previous:
        signal.signal(number,interrupted)
    try:
        yield
    finally:
        for number,handler in previous.items():
            signal.signal(number,handler)


def source(root, ref):
    actual = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
    if actual != ref:
        raise ValueError('exact harness HEAD required')
    if subprocess.check_output(['git', '-C', str(root), 'status', '--porcelain', '--untracked-files=no']):
        raise ValueError('tracked harness changes refused')
    pins = {}
    for name in PINS:
        raw = (root / 'scripts' / name).read_bytes()
        committed = subprocess.check_output(['git', '--no-replace-objects', '-C', str(root), 'show', ref + ':scripts/' + name])
        if raw != committed:
            raise ValueError('harness source changed: ' + name)
        pins[name] = digest(raw)
    return pins


def token_from_agents(raw):
    # Preserve the canonical credential's explicit scheme. Only a single
    # literal value is accepted; no shell expansion or multiline parsing.
    values = [line.split('=', 1)[1].strip()
              for line in raw.decode().splitlines() if line.startswith('FLY_API_TOKEN=')]
    if len(values) != 1:
        raise ValueError('one literal Fly token required in selected complete agents env')
    value = values[0]
    if value[:1] in ('"', "'") or value[-1:] in ('"', "'"):
        if len(value) < 2 or value[0] != value[-1]:
            raise ValueError('one literal Fly token required in selected complete agents env')
        value = value[1:-1]
    if value in ('FlyV1', 'Bearer') or not re.fullmatch(r'(?:(?:FlyV1|Bearer) )?[A-Za-z0-9_./+,=:\-]+', value):
        raise ValueError('one literal Fly token required in selected complete agents env')
    return value


def token_header(token):
    return token if token.startswith(('FlyV1 ', 'Bearer ')) else 'Bearer ' + token


def github_token(root, backend_env, agents_env):
    # Use the existing controller precedence, passing complete explicit input
    # paths instead of materializing secret subsets in a sparse checkout.
    result = subprocess.run(['bash', '-c',
        'source "$1"; cloudbench_resolve_controller_github_token "$2" "$3" "$4"',
        'github-preflight', str(root/'scripts/lib/cloudbench-env.sh'), str(root),
        str(backend_env), str(agents_env)], cwd=root, capture_output=True, timeout=15)
    token = result.stdout.decode().strip()
    if result.returncode != 0 or not re.fullmatch(r'[A-Za-z0-9_./+=:\-]+', token):
        raise ValueError('GitHub credential unavailable or malformed in selected controller inputs')
    return token


def facts_from(raw):
    facts = json.loads(raw)
    if (facts.get('app') != 'navi-whisper-lux-bench'
            or not isinstance(facts.get('image_ref'), str)
            or '@sha256:' not in facts['image_ref']
            or not isinstance(facts.get('protected_machines'), list)
            or len(facts['protected_machines']) < 4
            or not isinstance(facts.get('protected_volumes'), list)):
        raise ValueError('original app, immutable image and explicit protected resources required')
    return facts


def read_inventory(path):
    """Read a complete native inventory without widening small secret/intent inputs."""
    path = Path(path).absolute()
    if path.resolve(strict=True) != path:
        raise ValueError('physical private inventory required')
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not (stat.S_ISREG(before.st_mode) and before.st_uid == os.geteuid()
                and not before.st_mode & 0o077 and before.st_nlink == 1
                and 0 < before.st_size <= 256 * 1024 * 1024):
            raise ValueError('private current-owner inventory required')
        raw = stream.read(before.st_size + 1)
        after = os.fstat(stream.fileno())
        fields = ('st_ino', 'st_dev', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_mode', 'st_uid', 'st_nlink')
        if len(raw) != before.st_size or any(getattr(before, field) != getattr(after, field) for field in fields):
            raise ValueError('native inventory changed during read')
        return raw


def image_identity(value):
    match=re.fullmatch(r'([^@\s]+)@(sha256:[0-9a-f]{64})',value if isinstance(value,str) else '')
    if not match:
        raise ValueError('immutable repository and image digest required')
    name=match[1]
    # Tags are labels, while repository plus digest identifies immutable bytes.
    if ':' in name.rsplit('/',1)[-1]:
        name=name.rsplit(':',1)[0]
    return name,match[2]


def verify_reuse_images(request, inventory, expected):
    identity=image_identity(expected)
    machines={machine['id']:machine for machine in inventory}
    for row in request['candidates']:
        current=machines.get(row['machine_id'])
        if current is None or image_identity(current['config'].get('image')) != identity:
            raise ValueError('archived candidate image differs from the admitted immutable image')
        resolved=current.get('image_ref')
        if isinstance(resolved,dict) and resolved.get('digest') and resolved['digest'] != identity[1]:
            raise ValueError('resolved native image digest differs from the admitted image')


def capacity_snapshot(api, token, org, directory, extra):
    started = time.time()
    query = 'query { organization(slug:' + json.dumps(org) + ') { id slug settings billingStatus } }'
    req = urllib.request.Request('https://api.fly.io/graphql', data=json.dumps({'query': query}).encode(),
                                 headers={'Authorization': token_header(token), 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=20) as response:
        settings = json.load(response)
    if settings.get('errors') or not settings.get('data', {}).get('organization'):
        raise ValueError('complete organization settings required')
    organization = settings['data']['organization']
    if organization.get('slug') != org:
        raise ValueError('organization settings scope mismatch')
    limit = organization['settings']['machines_per_org_limit']
    if type(limit) is not int or not 1 <= limit <= 1000:
        raise ValueError('measured original organization limit required')
    result = subprocess.run(['flyctl', 'apps', 'list', '--org', org, '--json'],
                            capture_output=True, text=True, timeout=20, check=True)
    apps = json.loads(result.stdout)
    if not isinstance(apps, list) or not apps or len({a['Name'] for a in apps}) != len(apps):
        raise ValueError('fresh complete organization app inventory required')
    if 'navi-whisper-lux-bench' not in {a['Name'] for a in apps}:
        raise ValueError('capacity inventory does not include the original benchmark app')
    for app in apps:
        organization_value = app.get('Organization')
        app_org = organization_value.get('Slug') if isinstance(organization_value, dict) else organization_value
        if app_org != org:
            raise ValueError('organization app inventory scope mismatch')
    runner = runpy.run_path(str(Path(__file__).with_name('cloudbench-original600-runner.py')))
    runner['save'](directory / 'organization.private.json', settings)
    runner['save'](directory / 'apps.private.json', apps)

    native_by_app = {}
    def read_app(app):
        name = app['Name']
        if not isinstance(name, str) or not name or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in name):
            raise ValueError('invalid inventory app name')
        machines = api(name, token).api('GET', '/machines', timeout=20)
        if not isinstance(machines, list) or len({m['id'] for m in machines}) != len(machines):
            raise ValueError('complete native Machine inventory required')
        native_by_app[name] = machines
        path = directory / (name + '.private.json')
        runner['save'](path, machines)
        return dict(app=name, count=len(machines), path=str(path), sha256=digest(path.read_bytes()))

    # Read on the alarm-owning main thread: socket inactivity timeouts do not
    # bound a drip-fed body, and thread-pool shutdown cannot join such a worker.
    rows = [read_app(app) for app in apps]
    count = sum(r['count'] for r in rows)
    return dict(started_epoch=started, ended_epoch=time.time(), machine_limit=limit,
                billing_status=organization['billingStatus'], total_active_inventory_objects=count,
                conservative_extra_destroying_bench_objects=extra, apps=rows,
                atomic_snapshot=False, all_reads_only=True, available_slots_conservative=limit-count-extra,
                new_controller_slots=1, requested_original_primary_slots=600)


def admission_remaining(deadline):
    remaining = deadline - time.time()
    if not 0 < remaining <= 5400:
        raise ValueError("original admission clock expired")
    return remaining


def capacity(
    api,
    token,
    org,
    directory,
    extra,
    reuse_runs=None,
    harness_ref=None,
    excluded=(),
    image_ref=None,
    unused_runs=(),
    parked_runs=(),
    expired_runs=(),
    *,
    deadline=None,
):
    deadline = time.time() + 5400 if deadline is None else deadline
    runner = runpy.run_path(
        str(Path(__file__).with_name("cloudbench-original600-runner.py"))
    )
    with runner["bounded"](min(110, admission_remaining(deadline))):
        proof = capacity_snapshot(api, token, org, directory, extra)
    with runner["bounded"](admission_remaining(deadline)):
        return capacity_from_snapshot(
            proof,
            directory,
            reuse_runs,
            harness_ref,
            excluded,
            image_ref,
            unused_runs,
            parked_runs,
            expired_runs,
        )


def capacity_from_snapshot(proof, directory, reuse_runs, harness_ref, excluded,
                           image_ref, unused_runs, parked_runs, expired_runs):
    if reuse_runs:
        helper=reuse_module()
        import secrets
        inventory_path=directory/'navi-whisper-lux-bench.private.json'
        reuse=helper['prepare_request'](reuse_runs,inventory_path,secrets.token_hex(16),harness_ref,excluded,unused_runs,parked_runs,expired_runs)
        if image_ref is not None:
            reuse['image_ref']=image_ref
        helper['validate_request'](reuse,harness_ref)
        inventory=json.loads(read_inventory(inventory_path))
        if image_ref is not None:
            verify_reuse_images(reuse,inventory,image_ref)
        eligible=helper['capacity_demand'](reuse,inventory,set())['qualified_reuse_count']
        # Eligibility is a planning result, never a native reservation or quota credit.
        proof.update(eligible_reuse_count=eligible, qualified_reuse_count=0,
                     new_machine_demand=601, qualified_ids=[], admission='ELIGIBLE_NOT_RESERVED')
        if proof['available_slots_conservative'] + eligible < 601:
            raise ValueError('insufficient capacity even if every eligible archived identity is reserved')
        save = runpy.run_path(str(Path(__file__).with_name('cloudbench-original600-runner.py')))['save']
        save(directory/'archived-reuse-request.private.json',reuse)
        save(directory/'capacity-before-reservation.private.json',proof)
        return proof
    proof.update(qualified_reuse_count=0,new_machine_demand=601,qualified_ids=[])
    if proof['available_slots_conservative'] < 601:
        raise ValueError('insufficient measured capacity for original601 new Machines')
    runpy.run_path(str(Path(__file__).with_name('cloudbench-original600-runner.py')))['save'](directory/'capacity-proof.private.json',proof)
    return proof


def admission_binding(args, runner):
    names=('facts','agents_env','backend_env','tasks','snapshot_inventory','warm_deps')
    binding = dict(source_ref=args.source_ref, org=args.org, extra=args.extra_destroying_count,
                inputs={name:dict(path=str(getattr(args,name)),sha256=digest(runner['read'](getattr(args,name)))) for name in names},
                archive_runs=[str(path.absolute()) for path in (args.archive_run or [])],
                excluded_machines=sorted(set(args.reuse_exclude_machine)))
    unused = getattr(args, 'unused_reservation_run', ())
    if unused:
        binding['unused_reservation_runs'] = [str(path.absolute()) for path in unused]
    parked = getattr(args, 'parked_reservation_run', ())
    if parked:
        binding['parked_reservation_runs'] = [str(path.absolute()) for path in parked]
    expired = getattr(args, 'expired_reservation_run', [])
    if expired:
        binding['expired_reservation_runs'] = [str(path.absolute()) for path in expired]
    return binding


def open_admission(parent, resume, binding, runner, has_archives):
    if resume:
        directory=resume.absolute()
        if directory.parent != parent or directory.resolve(strict=True) != directory or directory.stat().st_uid != os.geteuid() or directory.stat().st_mode & 0o077:
            raise ValueError('resume must select an existing private admission below state-dir')
        original=json.loads(runner['read'](directory/'admission-intent.private.json'))
        if original['binding'] != binding or not has_archives:
            raise ValueError('resume source/inputs/archives differ from the original admission')
        if (directory/'controller-launch.intent.json').exists() or (directory/'config.private.json').exists():
            raise ValueError('admission already bound; use --status and its existing controller owner')
        return directory,original['started_at_epoch']
    directory=parent/('original600-'+str(time.time_ns()))
    directory.mkdir(mode=0o700)
    started_at=time.time()
    runner['save'](directory/'admission-intent.private.json',dict(binding=binding,started_at_epoch=started_at,deadline_epoch=started_at+5400))
    return directory,started_at


def seal_expired_handoffs(request, directory, runner):
    """Give each expired admission exactly one new successor cohort."""
    for archive in request['archives']:
        old=archive.get('expired_admission')
        if old is None:
            continue
        root=Path(old['directory'])
        if root.resolve(strict=True)!=root or root.stat().st_uid!=os.geteuid() or root.stat().st_mode&0o077:
            raise ValueError('private expired admission required')
        validator=runpy.run_path(str(Path(__file__).with_name('cloudbench-reconcile-reservations.py')))
        validator['validate_handoff'](archive)
        if ((root/'controller-launch.intent.json').exists() or (root/'config.private.json').exists()
                or any(root.glob('launch-*'))):
            raise ValueError('expired admission acquired a controller')
        seal={'schema':'original600-expired-admission-handoff-v1','original_closure_sha256':archive['archive_sha256'],
              'new_admission_directory':str(directory),'new_cohort':request['cohort'],
              'new_request_sha256':digest(json.dumps(request,sort_keys=True,allow_nan=False).encode())}
        path=root/'expired-reservation-handoff.json'
        try:runner['save'](path,seal)
        except FileExistsError:pass
        if json.loads(runner['read'](path))!=seal:
            raise ValueError('expired admission already assigned to another successor')


def reservation_disk_headroom(directory, request, inventory, snapshot_directory):
    """Budget retained wire copies, observation and fresh inventories before effects."""
    fs=os.statvfs(directory)
    block=fs.f_frsize or fs.f_bsize
    def allocated(size):
        return ((size+block-1)//block)*block
    machines={row['id']:row for row in inventory}
    selected=sum(allocated(len(json.dumps(machines[row['machine_id']],sort_keys=True).encode()))
                 for row in request['candidates'])
    rows=sum(allocated(len(json.dumps(row,sort_keys=True).encode())) for row in request['candidates'])
    snapshot=sum(allocated(path.stat().st_size) for path in snapshot_directory.glob('*.private.json'))
    request_bytes=allocated(len(json.dumps(request,sort_keys=True).encode()))
    # Native, update, raw-base64 and decoded copies plus one leased observation;
    # 64 small journal files/directories per candidate cover both bounded paths.
    required=14*selected+4*rows+2*snapshot+4*request_bytes+64*block*len(request['candidates'])
    inodes=64*len(request['candidates'])+128
    if fs.f_bavail*block < required or (fs.f_files and fs.f_favail < inodes):
        raise ValueError('insufficient local disk headroom for retained reservation evidence')
    return {'required_bytes':required,'available_bytes':fs.f_bavail*block,
            'required_inodes':inodes,'available_inodes':fs.f_favail}


def reserve_reuse_capacity(api, token, args, runner, directory, snapshot_directory, cap, started_at=None):
    """Reserve existing identities before crediting them; retain journals across resume."""
    helper=reuse_module()
    request_path=directory/'archived-reuse-original.private.json'
    if not request_path.exists():
        request=json.loads(runner['read'](snapshot_directory/'archived-reuse-request.private.json'))
        request['task_names']=json.loads(runner['read'](args.tasks))
        request['image_ref']=facts_from(runner['read'](args.facts))['image_ref']
        runner['campaign_argv'](request['task_names'],time.time())
        runner['save'](request_path,dict(schema='original600-archived-admission-request-v1',request=request,
                                       sha256=digest(json.dumps(request,sort_keys=True,allow_nan=False).encode())))
    saved=json.loads(runner['read'](request_path))
    request=saved['request']
    if saved.get('schema') != 'original600-archived-admission-request-v1' or digest(json.dumps(request,sort_keys=True,allow_nan=False).encode()) != saved['sha256']:
        raise ValueError('original archived reuse request bytes changed')
    if request.get('image_ref') != facts_from(runner['read'](args.facts))['image_ref']:
        raise ValueError('reserved image differs from the admitted immutable image')
    initial_inventory=json.loads(read_inventory(snapshot_directory/'navi-whisper-lux-bench.private.json'))
    verify_reuse_images(request,initial_inventory,request['image_ref'])
    helper['validate_request'](request,args.source_ref)
    if request.get('task_names') != json.loads(runner['read'](args.tasks)):
        raise ValueError('reserved task manifest differs from original ordered200')
    if cap['available_slots_conservative'] + len(request['candidates']) < 601:
        raise ValueError('insufficient measured capacity even with every reserved candidate')
    reservation_disk_headroom(directory,request,initial_inventory,snapshot_directory)
    seal_expired_handoffs(request,directory,runner)
    # NativeAdapter owns finite per-operation deadlines and joins all reservations.
    connection=api('navi-whisper-lux-bench',token)
    def adapter(journal):
        return helper['NativeAdapter'](connection,journal/'wire')
    with joined_admission_signals():
        reserved=helper['reserve_cohort'](adapter,request,directory/'archived-reuse-reservations')
        if reserved.get('held_native_reservations'):
            if started_at is None:
                raise ValueError('original admission epoch required for held readback')
            observer=runpy.run_path(str(Path(__file__).with_name('cloudbench-reconcile-reservations.py')))
            reserved=observer['observe_acknowledged_holds'](adapter,request,reserved,
                directory/'archived-reuse-reservations'/'acknowledged-holds-observation',started_at+5400)
    refreshed=directory/('capacity-after-reservation-'+str(time.time_ns()))
    refreshed.mkdir(mode=0o700)
    with runner['bounded'](110):
        final=capacity_snapshot(api,token,args.org,refreshed,args.extra_destroying_count)
    inventory=json.loads(read_inventory(refreshed/'navi-whisper-lux-bench.private.json'))
    facts=facts_from(runner['read'](args.facts))
    verify_reuse_images(reserved,inventory,facts['image_ref'])
    demand=helper['capacity_demand'](reserved,inventory,set(facts['protected_machines']),require_reserved=True)
    final.update(demand,admission='RESERVED_NATIVE_READBACK',reservation_mutations_separate=True)
    if final['available_slots_conservative'] < final['new_machine_demand']:
        raise ValueError('fresh capacity after reserved native readback is insufficient')
    request_output=directory/'archived-reuse-request.private.json'
    if request_output.exists():
        if json.loads(runner['read'](request_output)) != reserved:
            raise ValueError('the previously reserved request changed')
    else:
        runner['save'](request_output,reserved)
    final['reservation_request_sha256']=digest(runner['read'](request_output))
    proof_path=refreshed/'capacity-proof.private.json'
    runner['save'](proof_path,final)
    return dict(final,proof_path=str(proof_path))


def prepare(args, root, pins, runner, directory, cap, started_at=None, host_operator_provenance=None):
    if not 0 <= time.time() - cap['ended_epoch'] < 270 or cap['available_slots_conservative'] < cap.get('new_machine_demand',601):
        raise ValueError('capacity proof expired or insufficient')
    read, save = runner['read'], runner['save']
    facts = facts_from(read(args.facts))
    tasks = json.loads(read(args.tasks))
    stamp = time.time() if started_at is None else started_at
    if not 0 <= time.time()-stamp < 5400:
        raise ValueError('original campaign clock expired during admission')
    runner['campaign_argv'](tasks, stamp)  # Exact task-name hash and all original arguments.
    auth = dict(schema='cloudbench-disposable-controller-authority-v1', allowed=True, single_host=True,
                app=facts['app'], region='iad', vm_size='performance-8x', memory_mib=32768,
                workspace_size_gb=256, org_machine_limit=cap['machine_limit'],
                org_object_count=cap['total_active_inventory_objects'] + cap['conservative_extra_destroying_bench_objects'],
                verified_epoch=cap['ended_epoch'], capacity_proof=dict(path=cap.get('proof_path',str(directory/'capacity-proof.private.json')), sha256=digest(read(cap.get('proof_path',directory/'capacity-proof.private.json')))),
                protected_machines=facts['protected_machines'], protected_volumes=facts['protected_volumes'],
                source_ref=args.source_ref, output_directory=str(directory/'run/export'), env_files={})
    if len(auth['protected_machines']) < 4 or not isinstance(auth['protected_volumes'], list):
        raise ValueError('explicit protected resource cohort required')
    for key, path in [('agents', args.agents_env), ('backend', args.backend_env)]:
        auth['env_files'][key] = dict(path=str(path), sha256=digest(read(path)))
    save(directory/'authority-template.private.json', auth)
    files = []
    for path, relative in [(args.snapshot_inventory, '.git/cloudbench-warm-snapshot-inventory.cloudbench-warm-t10-ord-85a7e2c.json'),
                           (args.warm_deps, '.git/cloudbench-warm-deps.cloudbench-warm-t10-ord-85a7e2c.fp')]:
        files.append(dict(source_path=str(path), relative_path=relative, sha256=digest(read(path))))
    reuse_env = {}
    if cap.get('qualified_reuse_count'):
        reuse_path=directory/'archived-reuse-request.private.json';reuse_raw=read(reuse_path);reuse_sha=digest(reuse_raw)
        relative='.git/cloudbench-archived-reuse-'+str(json.loads(reuse_raw)['cohort'])+'.json'
        files.append(dict(source_path=str(reuse_path),relative_path=relative,sha256=reuse_sha))
        reuse_env=dict(CLOUDBENCH_ARCHIVED_REUSE_REQUEST='/tmp/gate/repo/'+relative,CLOUDBENCH_ARCHIVED_REUSE_REQUEST_SHA256=reuse_sha)
        if 'cloudbench-reuse-index.py' in pins:
            indexer=runpy.run_path(str(root/'scripts/cloudbench-reuse-index.py'))
            index_raw=indexer['build'](reuse_raw,reuse_sha,args.source_ref,reuse_module()['validate_request'])
            index_path=directory/'archived-reuse-index.private.json'
            fd=os.open(index_path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
            with os.fdopen(fd,'wb') as stream:
                stream.write(index_raw);stream.flush();os.fsync(stream.fileno())
            fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY)
            try:os.fsync(fd)
            finally:os.close(fd)
            index_relative=relative.removesuffix('.json')+'.index.json'
            files.append({'source_path':str(index_path),'relative_path':index_relative,'sha256':digest(index_raw)})
            reuse_env.update(CLOUDBENCH_ARCHIVED_REUSE_INDEX='/tmp/gate/repo/'+index_relative,
                             CLOUDBENCH_ARCHIVED_REUSE_INDEX_SHA256=digest(index_raw))
    config = dict(schema='original600-controller-runner-v1', allowed=True, source_root=str(root),
                  source_ref=args.source_ref, source_files=pins, tasks_path=str(args.tasks),
                  started_at_epoch=stamp, authority_template=str(directory/'authority-template.private.json'),
                  remote_files=files, remote_env=dict(CLOUDBENCH_CLONE_MAX_ATTEMPTS='5', PYTHONDONTWRITEBYTECODE='1', **reuse_env),
                  gate_env=dict(CLOUDBENCH_APP=facts['app'], CLOUDBENCH_REGION='iad', WARM_IMAGE_REF=facts['image_ref'],
                                CLOUDBENCH_GATE_TIMEOUT_S='7200', PYTHONDONTWRITEBYTECODE='1'))
    if host_operator_provenance is not None:
        config['host_operator_provenance']=host_operator_provenance
    save(directory/'config.private.json', config)
    save(directory/'attempt-start.safe.json', dict(scope='original200x3REAL', scheduled_total=600,
         source_ref=args.source_ref, task_ref=runner['TASK_REF'], started_at_epoch=stamp,
         original_deadline_epoch=stamp+5400, config_sha256=digest(read(directory/'config.private.json')),
         status='BOUND_NOT_LAUNCHED'))
    return directory/'config.private.json'



def payload_guard_failure(runner, output, evidence, original_config, original_sha, raw, receipt):
    """Import the observed 852 pre-gate size refusal without replaying a launch."""
    config=json.loads(runner['read'](original_config))
    if (receipt.get('tool_reported_exit_code')!=1 or receipt.get('gate_created') is not False
            or receipt.get('error')!='compressed launch payload too large for config transport'
            or receipt.get('source_ref')!=config['source_ref']
            or receipt.get('config_path')!=str(original_config) or receipt.get('config_sha256')!=original_sha
            or receipt.get('output_directory')!=str(output)):
        raise ValueError('unbound prelaunch payload refusal')
    known='591e49e553c227c73a02bedc65e49562e9216e0d961493c20790e1cd4c34613a'
    source=subprocess.check_output(['git','--no-replace-objects','-C',str(Path(__file__).resolve().parents[1]),'show',config['source_ref']+':scripts/cloudbench-original600-runner.py'])
    if digest(source)!=known:
        raise ValueError('unrecognized prelaunch payload operator')
    log=runner['read'](receipt['log'])
    lines=log.decode().splitlines()
    if (digest(log)!=receipt['log_sha256'] or not lines
            or lines[-1]!='ValueError: compressed launch payload too large for config transport'
            or sum('payload,payload_sha,remote_command=launch_handoff(out,remote)' in line for line in lines)!=1
            or 'line 236, in run' not in log.decode() or 'line 176, in launch_handoff' not in log.decode()):
        raise ValueError('exact pre-gate payload traceback required')
    event=json.loads(lines[1])
    if event.get('status')!='LAUNCHING_ORIGINAL600' or event.get('source_ref')!=config['source_ref'] or event.get('directory')!=str(original_config.parent):
        raise ValueError('prelaunch event binding differs')
    if output.resolve(strict=True)!=output or {p.name for p in output.iterdir()}!={'authority.private.json'}:
        raise ValueError('payload refusal output contains possible gate activity')
    info=output.stat()
    if info.st_uid!=os.geteuid() or info.st_mode&0o077:
        raise ValueError('private current-owner prelaunch output required')
    authority_raw=runner['read'](output/'authority.private.json')
    recorded=receipt['output_files']
    if set(recorded)!={'authority.private.json'} or recorded['authority.private.json']!={'bytes':len(authority_raw),'sha256':digest(authority_raw)}:
        raise ValueError('prelaunch authority bytes changed')
    authority=json.loads(authority_raw)
    if authority.get('source_ref')!=config['source_ref'] or authority.get('output_directory')!=str(output/'export'):
        raise ValueError('prelaunch authority binding differs')
    try:alive=runner['birth'](authority['cleanup_owner_pid'])==authority['cleanup_owner_birth']
    except (FileNotFoundError,ProcessLookupError,ValueError):alive=False
    if alive:raise ValueError('prelaunch owner still live')
    successor=output.parent/('run-after-prelaunch-'+digest(raw)[:16])
    if successor.exists() or successor.is_symlink() or (output/'host-launch-successor.json').exists():
        raise ValueError('prelaunch continuation already claimed')
    return dict(path=str(evidence),sha256=digest(raw),prior_output=str(output),successor_output=str(successor))


def typed_payload_failure(runner, output, evidence, original_config, original_sha, raw, receipt):
    config=json.loads(runner['read'](original_config))
    if (receipt.get('schema')!='original600-host-payload-failure-v1'
            or receipt.get('gate_created') is not False
            or receipt.get('reason')!='compressed launch payload too large for config transport'
            or receipt.get('source_ref')!=config['source_ref']
            or receipt.get('config_path')!=str(original_config) or receipt.get('config_sha256')!=original_sha
            or receipt.get('output_directory')!=str(output)):
        raise ValueError('unbound typed payload refusal')
    source=subprocess.check_output(['git','--no-replace-objects','-C',str(Path(__file__).resolve().parents[1]),'show',config['source_ref']+':scripts/cloudbench-original600-runner.py'])
    if digest(source)!='f0da1304a88459677a4f5017c7c8689c73c3441357e635fe9040450637c1ab0f' or receipt.get('host_runner_sha256')!=digest(source):
        raise ValueError('unrecognized typed payload operator')
    if output.resolve(strict=True)!=output or {p.name for p in output.iterdir()}!={'authority.private.json','launch-payload-failure.json'}:
        raise ValueError('typed refusal contains possible gate activity')
    info=output.stat()
    if info.st_uid!=os.geteuid() or info.st_mode&0o077 or runner['read'](output/'launch-payload-failure.json')!=raw:
        raise ValueError('private original typed refusal required')
    authority=json.loads(runner['read'](output/'authority.private.json'))
    if (authority.get('source_ref')!=config['source_ref'] or authority.get('output_directory')!=str(output/'export')
            or authority.get('cleanup_owner_pid')!=receipt.get('owner_pid') or authority.get('cleanup_owner_birth')!=receipt.get('owner_birth')):
        raise ValueError('typed refusal owner/authority differs')
    try:alive=runner['birth'](receipt['owner_pid'])==receipt['owner_birth']
    except (FileNotFoundError,ProcessLookupError,ValueError):alive=False
    if alive:raise ValueError('typed refusal owner still live')
    successor=output.parent/('run-after-prelaunch-'+digest(raw)[:16])
    if os.path.lexists(successor) or (output/'host-launch-successor.json').exists():
        raise ValueError('prelaunch continuation already claimed')
    return dict(path=str(evidence),sha256=digest(raw),prior_output=str(output),successor_output=str(successor))


def prelaunch_failure(runner, output, evidence, original_config, original_sha):
    """Accept the retained known pre-exec failure, never directory absence alone."""
    raw=runner['read'](evidence);receipt=json.loads(raw)
    if receipt.get('schema')=='original600-host-payload-failure-v1':
        return typed_payload_failure(runner,output,evidence,original_config,original_sha,raw,receipt)
    if receipt.get('schema')=='observed-host-prelaunch-refusal-v1':
        return payload_guard_failure(runner,output,evidence,original_config,original_sha,raw,receipt)
    if receipt.get('schema') != 'observed-tool-session-join-v1' or receipt.get('tool_reported_exit_code') != 1:
        raise ValueError('positive joined Popen failure evidence required')
    if receipt.get('log_contains_synchronous_popen_errno') != 7 or receipt.get('gate_pid') != 'NOT_CREATED_BY_FAILED_POPEN':
        raise ValueError('only proven E2BIG before gate execution may continue')
    expected={'host-operator-provenance.json','authority.private.json','gate.private.log'}
    if output.resolve(strict=True)!=output or {p.name for p in output.iterdir()}!=expected:
        raise ValueError('prelaunch output contains possible gate activity')
    info=output.stat()
    if info.st_uid!=os.geteuid() or info.st_mode&0o077:
        raise ValueError('private current-owner prelaunch output required')
    recorded=receipt['run_output_files_observed']
    if set(recorded)!={str(output/name) for name in expected}:
        raise ValueError('prelaunch evidence names another output')
    for name in expected:
        data=runner['read'](output/name);entry=recorded[str(output/name)]
        if len(data)!=entry['bytes'] or digest(data)!=entry['sha256']:
            raise ValueError('prelaunch evidence bytes changed')
    if runner['read'](output/'gate.private.log'):
        raise ValueError('gate produced output')
    provenance=json.loads(runner['read'](output/'host-operator-provenance.json'))
    if provenance.get('original_config_path')!=str(original_config) or provenance.get('original_config_sha256')!=original_sha:
        raise ValueError('prelaunch original config changed')
    # Legacy import is deliberately limited to the observed version whose
    # Popen error occurred before caller publication or any gate execution.
    known='965eb3a1a70a3ccb3b20c89b3780af0a87bc709ace31633c3220e5eb9db4c988'
    host_ref=provenance.get('host_operator_source_ref','')
    source=subprocess.check_output(['git','--no-replace-objects','-C',str(Path(__file__).resolve().parents[1]),'show',host_ref+':scripts/cloudbench-original600-runner.py'])
    if digest(source)!=known or provenance.get('host_runner_sha256')!=known:
        raise ValueError('unrecognized legacy prelaunch operator')
    text=runner['read'](receipt['stderr_and_stdout_log'])
    if digest(text)!=receipt['log_sha256']:
        raise ValueError('prelaunch traceback changed')
    lines=text.decode().splitlines()
    if (not lines or lines[-1]!="OSError: [Errno 7] Argument list too long: 'bash'"
            or sum('gate=subprocess.Popen(command,cwd=root,env=env,stdout=stream,stderr=subprocess.STDOUT)' in line for line in lines)!=1
            or 'line 204, in run' not in text.decode()):
        raise ValueError('exact synchronous pre-exec traceback required')
    event=json.loads(lines[0])
    if event.get('host_operator_source_ref')!=host_ref or event.get('source_ref')!=provenance.get('workload_source_ref'):
        raise ValueError('traceback source identity changed')
    authority=json.loads(runner['read'](output/'authority.private.json'))
    config=json.loads(runner['read'](original_config))
    if (authority.get('source_ref')!=config.get('source_ref') or provenance.get('workload_source_ref')!=config.get('source_ref')
            or provenance.get('original_started_at_epoch')!=config.get('started_at_epoch')
            or authority.get('output_directory')!=str(output/'export')):
        raise ValueError('prelaunch authority/workload binding changed')
    try:alive=runner['birth'](authority['cleanup_owner_pid'])==authority['cleanup_owner_birth']
    except (FileNotFoundError,ProcessLookupError,ValueError):alive=False
    if alive:
        raise ValueError('prelaunch owner still live')
    successor=output.parent/('run-after-popen-'+digest(raw)[:16])
    if successor.exists() or successor.is_symlink() or (output/'host-launch-successor.json').exists():
        raise ValueError('prelaunch continuation already claimed')
    return dict(path=str(evidence),sha256=digest(raw),prior_output=str(output),successor_output=str(successor))


def bound_launch_plan(args, runner):
    """Verify a failed pre-effect launch without changing its workload or clock."""
    directory = args.resume_bound_launch.absolute()
    if directory.resolve(strict=True) != directory or directory.parent != args.state_dir.absolute():
        raise ValueError('bound admission must be physical and below original state-dir')
    info = directory.stat()
    if info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError('private current-owner bound admission required')
    original = json.loads(runner['read'](directory/'admission-intent.private.json'))
    binding = admission_binding(args, runner)
    binding['source_ref'] = original['binding']['source_ref']
    if binding != original['binding']:
        raise ValueError('bound launch original inputs changed')
    intent_path = directory/'controller-launch.intent.json'
    intent = json.loads(runner['read'](intent_path))
    config_path = Path(intent['config_path'])
    output = Path(intent['run_directory'])
    if (config_path.parent.parent != directory or output.parent != config_path.parent
            or output.name != 'run' or output.is_symlink()):
        raise ValueError('bound launch output must be the original absent run directory')
    raw = runner['read'](config_path)
    if digest(raw) != intent['config_sha256']:
        raise ValueError('original bound config changed')
    config = json.loads(raw)
    failure=None
    if output.exists():
        evidence=getattr(args,'prelaunch_failure',None)
        if evidence is None:
            raise ValueError('bound launch output must be the original absent run directory')
        failure=prelaunch_failure(runner,output,evidence,config_path,intent['config_sha256'])
    elif getattr(args,'prelaunch_failure',None):
        raise ValueError('prelaunch evidence requires its exact existing output')
    old_ref = original['binding']['source_ref']
    if config['source_ref'] != old_ref or config['started_at_epoch'] != original['started_at_epoch']:
        raise ValueError('original bound workload or clock changed')
    workload = Path(config['source_root'])
    if subprocess.check_output(['git','-C',str(workload),'rev-parse','HEAD'],text=True).strip() != old_ref:
        raise ValueError('original workload checkout changed')
    runner['validate_source_members'](workload, old_ref, config['source_files'])
    descriptor = next(row for row in config['remote_files'] if row['relative_path'].startswith('.git/cloudbench-archived-reuse-'))
    reserved_raw = runner['read'](descriptor['source_path'])
    if digest(reserved_raw) != descriptor['sha256']:
        raise ValueError('original bound reservations changed')
    reserved = reuse_module()['validate_request'](json.loads(reserved_raw), old_ref)
    if reserved['task_names'] != json.loads(runner['read'](args.tasks)):
        raise ValueError('original bound task manifest changed')
    return dict(directory=directory, intent_path=intent_path, intent=intent, config=config,
                original_config_path=config_path, reserved=reserved, output=Path(failure['successor_output']) if failure else output, original_binding=original['binding'], prelaunch_failure=failure)


def resume_bound_launch(args, root, runner, plan, github):
    # The old immutable workload remains the execution source. Only this host
    # operator and fresh read-only admission proof are new and separately logged.
    config = plan['config']
    current_binding = admission_binding(args, runner)
    current_binding['source_ref'] = config['source_ref']
    if current_binding != plan['original_binding']:
        raise ValueError('bound launch input changed after validation')
    if not 0 <= time.time()-config['started_at_epoch'] < 5400:
        raise ValueError('original campaign clock expired')
    continuation = plan['directory']/('bound-continuation-'+str(time.time_ns()))
    continuation.mkdir(mode=0o700)
    token = token_from_agents(runner['read'](args.agents_env))
    os.environ['FLY_API_TOKEN'] = token
    capture = runpy.run_path(str(root/'scripts/cloudbench-original-volume-capture.py'))
    with runner['bounded'](110):
        cap = capacity_snapshot(capture['Fly'], token, args.org, continuation, args.extra_destroying_count)
    inventory = json.loads(read_inventory(continuation/'navi-whisper-lux-bench.private.json'))
    facts = facts_from(runner['read'](args.facts))
    verify_reuse_images(plan['reserved'], inventory, facts['image_ref'])
    cap.update(reuse_module()['capacity_demand'](plan['reserved'], inventory, set(facts['protected_machines']), require_reserved=True))
    if cap['available_slots_conservative'] < cap['new_machine_demand']:
        raise ValueError('fresh bound-launch capacity insufficient')
    proof_path = continuation/'capacity-proof.private.json'
    runner['save'](proof_path, cap)
    authority = json.loads(runner['read'](config['authority_template']))
    authority.update(org_machine_limit=cap['machine_limit'],
                     org_object_count=cap['total_active_inventory_objects']+cap['conservative_extra_destroying_bench_objects'],
                     verified_epoch=cap['ended_epoch'],capacity_proof=dict(path=str(proof_path),sha256=digest(runner['read'](proof_path))))
    authority_path = continuation/'authority-template.private.json'
    runner['save'](authority_path, authority)
    provenance = dict(host_operator_source_ref=args.source_ref, workload_source_ref=config['source_ref'],
                      original_config_path=str(plan['original_config_path']),original_config_sha256=plan['intent']['config_sha256'],
                      original_launch_intent_sha256=digest(runner['read'](plan['intent_path'])),
                      original_started_at_epoch=config['started_at_epoch'],
                      host_runner_sha256=digest((root/'scripts/cloudbench-original600-runner.py').read_bytes()),
                      host_gate_sha256=digest((root/'scripts/run-cloudbench-controller-gate').read_bytes()),
                      prelaunch_failure=plan.get('prelaunch_failure'))
    derived = dict(config, authority_template=str(authority_path), host_operator_provenance=provenance)
    path = continuation/'config.private.json'
    runner['save'](path, derived)
    if plan.get('prelaunch_failure'):
        failure=plan['prelaunch_failure']
        # Revalidate the old immutable evidence immediately before the exclusive handoff.
        again=prelaunch_failure(runner,Path(failure['prior_output']),Path(failure['path']),plan['original_config_path'],plan['intent']['config_sha256'])
        if again!=failure:raise ValueError('prelaunch continuation changed')
        runner['save'](Path(failure['prior_output'])/'host-launch-successor.json',dict(schema='original600-host-launch-successor-v1',
            evidence=failure,config_path=str(path),config_sha256=digest(runner['read'](path)),
            original_started_at_epoch=config['started_at_epoch'],host_operator_source_ref=args.source_ref))
    print(json.dumps(dict(status='CONTINUING_ORIGINAL_BOUND_LAUNCH',admission_directory=str(plan['directory']),
                         source_ref=config['source_ref'],host_operator_source_ref=args.source_ref,run_directory=str(plan['output']),config_path=str(path))),flush=True)
    return runner['run'](path, digest(runner['read'](path)), plan['output'], github_token=github)


def incomplete_admission_plan(args, runner):
    directory=args.resume_incomplete_admission.absolute()
    if directory.parent!=args.state_dir.absolute() or directory.resolve(strict=True)!=directory:
        raise ValueError('incomplete admission must be an original private state directory')
    module=runpy.run_path(str(Path(__file__).with_name('cloudbench-incomplete-reservations.py')))
    plan=module['plan'](directory,args.incomplete_admission_failure)
    original=json.loads(runner['read'](directory/'admission-intent.private.json'))
    binding=admission_binding(args,runner)
    binding['source_ref']=original['binding']['source_ref']
    if binding!=original['binding'] or plan['source_ref']!=binding['source_ref']:
        raise ValueError('incomplete admission original inputs changed')
    oldroot=Path(plan['source_root'])
    if subprocess.check_output(['git','-C',str(oldroot),'rev-parse','HEAD'],text=True).strip()!=plan['source_ref']:
        raise ValueError('original workload HEAD changed')
    oldcli=subprocess.check_output(['git','--no-replace-objects','-C',str(oldroot),'show',plan['source_ref']+':scripts/run-original600-controller.py'])
    names=ast.literal_eval(next(node.value for node in ast.parse(oldcli).body
        if isinstance(node,ast.Assign) and any(isinstance(n,ast.Name) and n.id=='PINS' for n in node.targets)))
    if subprocess.check_output(['git','-C',str(oldroot),'status','--porcelain','--untracked-files=no']):
        raise ValueError('original workload checkout changed')
    pins={name:digest((oldroot/'scripts'/name).read_bytes()) for name in names}
    runner['validate_source_members'](oldroot,plan['source_ref'],pins)
    return module,plan,pins


def resume_incomplete_admission(args, root, runner, github):
    module,plan,oldpins=incomplete_admission_plan(args,runner)
    directory=Path(plan['directory']);deadline=plan['deadline']
    def remaining():
        value=deadline-time.time()
        if not 0<value<=5400:
            raise ValueError('original incomplete-admission clock expired')
        return min(110,value)
    lock=directory/'incomplete-admission.lock'
    fd=os.open(lock,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid() or info.st_mode&0o077 or info.st_nlink!=1:
            raise ValueError('private incomplete admission lock required')
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if incomplete_admission_plan(args,runner)[1]!=plan:
            raise ValueError('incomplete admission evidence changed')
        operator={'source_ref':args.source_ref,'source_root':str(root),
                  'original_plan_sha256':digest(json.dumps(plan,sort_keys=True,allow_nan=False).encode())}
        operator_path=directory/'incomplete-operator.intent.json'
        try:runner['save'](operator_path,operator)
        except FileExistsError:pass
        if json.loads(runner['read'](operator_path))!=operator:
            raise ValueError('incomplete admission assigned to another operator')
        token=token_from_agents(runner['read'](args.agents_env))
        os.environ['FLY_API_TOKEN']=token
        capture=runpy.run_path(str(root/'scripts/cloudbench-original-volume-capture.py'))
        before=directory/('capacity-before-recovery-'+str(time.time_ns()));before.mkdir(mode=0o700)
        with runner['bounded'](remaining()):
            initial=capacity_snapshot(capture['Fly'],token,args.org,before,args.extra_destroying_count)
        inventory=json.loads(read_inventory(before/'navi-whisper-lux-bench.private.json'))
        request=plan['request']
        verify_reuse_images(request,inventory,facts_from(runner['read'](args.facts))['image_ref'])
        reservation_disk_headroom(directory,request,inventory,before)
        if initial['available_slots_conservative']+len(plan['classifications'])<601:
            raise ValueError('incomplete admission has insufficient possible capacity')
        if incomplete_admission_plan(args,runner)[1]!=plan:
            raise ValueError('incomplete admission evidence changed before native effect')
        remaining()
        helper=reuse_module()
        connection=capture['Fly']('navi-whisper-lux-bench',token)
        def adapter(journal):return helper['NativeAdapter'](connection,journal/'wire')
        with joined_admission_signals():
            reserved=module['reconcile'](adapter,plan,directory/'incomplete-admission-recovery',deadline)
        after=directory/('capacity-after-recovery-'+str(time.time_ns()));after.mkdir(mode=0o700)
        with runner['bounded'](remaining()):
            final=capacity_snapshot(capture['Fly'],token,args.org,after,args.extra_destroying_count)
        inventory=json.loads(read_inventory(after/'navi-whisper-lux-bench.private.json'))
        facts=facts_from(runner['read'](args.facts))
        verify_reuse_images(reserved,inventory,facts['image_ref'])
        final.update(helper['capacity_demand'](reserved,inventory,set(facts['protected_machines']),require_reserved=True))
        if final['available_slots_conservative']<final['new_machine_demand']:
            raise ValueError('fresh incomplete-admission capacity insufficient')
        proof=after/'capacity-proof.private.json';runner['save'](proof,final)
        final['proof_path']=str(proof)
        if incomplete_admission_plan(args,runner)[1]!=plan:
            raise ValueError('incomplete admission evidence changed before launch')
        remaining()
        launch=directory/('launch-'+str(time.time_ns()));launch.mkdir(mode=0o700)
        runner['save'](launch/'archived-reuse-request.private.json',reserved)
        provenance={'host_operator_source_ref':args.source_ref,'workload_source_ref':plan['source_ref'],
            'original_started_at_epoch':plan['started_at'], 'incomplete_admission':operator,
            'host_runner_sha256':digest((root/'scripts/cloudbench-original600-runner.py').read_bytes()),
            'host_gate_sha256':digest((root/'scripts/run-cloudbench-controller-gate').read_bytes())}
        oldargs=copy.copy(args);oldargs.source_ref=plan['source_ref']
        config=prepare(oldargs,Path(plan['source_root']),oldpins,runner,launch,final,
                       started_at=plan['started_at'],host_operator_provenance=provenance)
        runner['save'](directory/'controller-launch.intent.json',{'config_path':str(config),
            'config_sha256':digest(runner['read'](config)),'run_directory':str(launch/'run')})
        print(json.dumps({'status':'CONTINUING_ORIGINAL_ADMISSION','admission_directory':str(directory),
            'source_ref':plan['source_ref'],'host_operator_source_ref':args.source_ref,
            'config_path':str(config),'run_directory':str(launch/'run')}),flush=True)
        return runner['run'](config,digest(runner['read'](config)),launch/'run',github_token=github)
    finally:
        os.close(fd)


def preparation_plan(args, runner):
    module = runpy.run_path(
        str(Path(__file__).with_name("cloudbench-prepare-admission.py"))
    )
    return module, module["plan"](args, runner)


def prepare_admission_request(args, root, runner):
    """Publish the first request; the original operator still owns reservation and launch."""
    module, plan = preparation_plan(args, runner)
    directory = Path(plan["directory"])
    lock = directory / "pre-reservation-preparation.lock"
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.geteuid()
            or info.st_mode & 0o077
            or info.st_nlink != 1
        ):
            raise ValueError("private preparation lock required")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if module["plan"](args, runner) != plan:
            raise ValueError("pre-reservation evidence changed")
        journal = directory / "pre-reservation-preparation"
        journal.mkdir(mode=0o700)
        runner["save"](
            journal / "intent.json",
            {
                "schema": "original600-pre-reservation-preparation-v1",
                "operator_ref": args.source_ref,
                "operator_root": str(root),
                "plan": plan,
            },
        )
        oldroot = Path(plan["source_root"])
        old = runpy.run_path(str(oldroot / "scripts/run-original600-controller.py"))
        oldrunner = runpy.run_path(
            str(oldroot / "scripts/cloudbench-original600-runner.py")
        )
        token = token_from_agents(runner["read"](args.agents_env))
        os.environ["FLY_API_TOKEN"] = token
        api = runpy.run_path(
            str(oldroot / "scripts/cloudbench-original-volume-capture.py")
        )["Fly"]
        snapshot = journal / "capacity"
        snapshot.mkdir(mode=0o700)
        function = old["capacity"]
        namespace = function.__globals__
        native_snapshot = namespace["capacity_snapshot"]

        def bounded_snapshot(*values):
            with runner["bounded"](min(110, admission_remaining(plan["deadline"]))):
                return native_snapshot(*values)

        namespace["capacity_snapshot"] = bounded_snapshot
        try:
            with (
                joined_admission_signals(),
                runner["bounded"](admission_remaining(plan["deadline"])),
            ):
                old["capacity"](
                    api,
                    token,
                    args.org,
                    snapshot,
                    args.extra_destroying_count,
                    args.archive_run,
                    plan["source_ref"],
                    args.reuse_exclude_machine,
                    facts_from(runner["read"](args.facts))["image_ref"],
                    args.unused_reservation_run,
                    args.parked_reservation_run,
                    args.expired_reservation_run,
                )
        finally:
            namespace["capacity_snapshot"] = native_snapshot
        request = json.loads(
            oldrunner["read"](snapshot / "archived-reuse-request.private.json")
        )
        request["task_names"] = json.loads(oldrunner["read"](args.tasks))
        request["image_ref"] = old["facts_from"](oldrunner["read"](args.facts))[
            "image_ref"
        ]
        oldrunner["campaign_argv"](request["task_names"], plan["started_at"])
        old["reuse_module"]()["validate_request"](request, plan["source_ref"])
        if module["plan"](args, runner) != plan:
            raise ValueError("pre-reservation evidence changed before publication")
        admission_remaining(plan["deadline"])
        envelope = dict(
            schema="original600-archived-admission-request-v1",
            request=request,
            sha256=digest(
                json.dumps(request, sort_keys=True, allow_nan=False).encode()
            ),
        )
        envelope_sha = digest(
            (json.dumps(envelope, sort_keys=True, allow_nan=False) + "\n").encode()
        )
        runner["save"](
            journal / "ready.json",
            {
                "status": "READY_FOR_REQUEST_PUBLICATION",
                "request_sha256": envelope_sha,
                "source_ref": plan["source_ref"],
                "operator_ref": args.source_ref,
                "original_started_at_epoch": plan["started_at"],
                "deadline_epoch": plan["deadline"],
            },
        )
        admission_remaining(plan["deadline"])
        oldrunner["save"](directory / "archived-reuse-original.private.json", envelope)
        if (
            digest(
                oldrunner["read"](directory / "archived-reuse-original.private.json")
            )
            != envelope_sha
        ):
            raise ValueError("published preparation request changed")
        print(
            json.dumps(
                dict(
                    status="REQUEST_PREPARED",
                    directory=str(directory),
                    source_ref=plan["source_ref"],
                    operator_ref=args.source_ref,
                    request_sha256=envelope_sha,
                    started_at_epoch=plan["started_at"],
                    deadline_epoch=plan["deadline"],
                )
            ),
            flush=True,
        )
        return 0
    finally:
        os.close(fd)


def main():
    if sys.argv[1:2] == ['--status']:
        status = runpy.run_path(str(Path(__file__).with_name('original600-status.py')))
        return status['main'](sys.argv[2:])
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true', help='perform fresh capacity reads, then allocate and own one original600 controller')
    parser.add_argument('--source-ref', required=True)
    for name in ['state-dir', 'facts', 'agents-env', 'backend-env', 'tasks', 'snapshot-inventory', 'warm-deps']:
        parser.add_argument('--'+name, required=True, type=Path)
    parser.add_argument('--archive-run', action='append', type=Path, help='Verified predecessor run directory; preserve IDs/volume using a clean task generation before fresh creation')
    parser.add_argument('--unused-reservation-run', action='append', default=[], type=Path, help='Closed admission whose fully archived, never-assigned reservations may pass to this new cohort')
    parser.add_argument('--parked-reservation-run', action='append', default=[], type=Path, help='Closed admission: validate untouched and positively proven parked claims for a new cohort')
    parser.add_argument('--expired-reservation-run', action='append', default=[], type=Path, help='Expired never-launched admission: validate retained reservations for a new cohort')
    parser.add_argument('--reuse-exclude-machine', action='append', default=[], help='Conservatively exclude a changed/pilot Machine from archived reuse')
    parser.add_argument('--prelaunch-failure',type=Path,help='Retained positive no-child E2BIG evidence for an existing bound output')
    parser.add_argument('--resume-bound-launch', type=Path, help='Continue an original absent-output bound launch using a verified host operator and fresh capacity')
    parser.add_argument('--resume-admission', type=Path, help='Reconcile the same prelaunch archived-reservation state; never restart a bound controller')
    parser.add_argument('--resume-incomplete-admission',type=Path,help='Continue a proven joined pre-controller failure without rewriting its partial journals')
    parser.add_argument('--incomplete-admission-failure',type=Path,help='Positive source-bound joined admission failure receipt')
    parser.add_argument('--prepare-admission-request', type=Path, help='Prepare only the first request for a joined pre-reservation admission; preserve its original operator and clock')
    parser.add_argument('--pre-reservation-failure', type=Path, help='Positive joined pre-reservation failure receipt')
    parser.add_argument('--org', choices=['personal'], default='personal')
    parser.add_argument('--extra-destroying-count', type=int, default=1)
    args = parser.parse_args()
    os.umask(0o077)
    root = Path(__file__).resolve().parents[1]
    pins = source(root, args.source_ref)
    runner = runpy.run_path(str(root/'scripts/cloudbench-original600-runner.py'))
    runner['validate_source_members'](root, args.source_ref, pins)
    preflight = runpy.run_path(str(root/'scripts/cloudbench-operator-preflight.py'))
    for name in ['facts', 'agents_env', 'backend_env', 'tasks', 'snapshot_inventory', 'warm_deps']:
        path = getattr(args, name).absolute()
        preflight['private_input'](path)
        setattr(args, name, path)
    args.archive_run=[path.absolute() for path in (args.archive_run or [])]
    args.unused_reservation_run=[path.absolute() for path in args.unused_reservation_run]
    args.parked_reservation_run=[path.absolute() for path in args.parked_reservation_run]
    args.expired_reservation_run=[path.absolute() for path in args.expired_reservation_run]
    if (args.unused_reservation_run or args.parked_reservation_run or args.expired_reservation_run) and not args.archive_run:
        raise ValueError('reservation recovery requires its original predecessor archives')
    recovery=args.unused_reservation_run+args.parked_reservation_run+args.expired_reservation_run
    if len(set(recovery))!=len(recovery):
        raise ValueError('same admission cannot use multiple reservation recovery modes')
    for archive in args.archive_run + recovery:
        if archive.resolve(strict=True) != archive or not archive.is_dir():
            raise ValueError('original archive run must be a physical directory')
    runner['campaign_argv'](json.loads(runner['read'](args.tasks)), time.time())
    facts_from(runner['read'](args.facts))
    token_from_agents(runner['read'](args.agents_env))
    github = github_token(root, args.backend_env, args.agents_env)
    if args.extra_destroying_count < 1:
        raise ValueError('conservative unlisted/destroying allowance must be at least one')
    subprocess.run([sys.executable, '-I', '-B', str(root/'scripts/cloudbench-operator-preflight.py'), '--require-flyctl'], check=True)
    version = subprocess.check_output(['flyctl', 'version'], text=True, timeout=5)
    if not re.search(r'flyctl v0\.4\.115\b', version):
        raise ValueError('original controller requires the pinned Fly CLI v0.4.115')
    if args.prelaunch_failure and not args.resume_bound_launch:
        raise ValueError('--prelaunch-failure requires --resume-bound-launch')
    if sum(bool(v) for v in (args.resume_bound_launch,args.resume_admission,args.resume_incomplete_admission,args.prepare_admission_request))>1:
        raise ValueError('select one continuation mode')
    if bool(args.resume_incomplete_admission)!=bool(args.incomplete_admission_failure):
        raise ValueError('incomplete admission requires its explicit failure receipt')
    if args.resume_incomplete_admission:
        incomplete_admission_plan(args,runner)
    if bool(args.prepare_admission_request) != bool(args.pre_reservation_failure):
        raise ValueError('request preparation requires its explicit joined failure receipt')
    if args.prepare_admission_request:
        preparation_plan(args, runner)
    bound = bound_launch_plan(args, runner) if args.resume_bound_launch else None
    if not args.run:
        print(json.dumps(dict(status='CHECKED_NOT_LAUNCHED', source_ref=args.source_ref, uid=os.geteuid(), provider_calls=0)))
        return 0
    if bound is not None:
        return resume_bound_launch(args, root, runner, bound, github)
    if args.resume_incomplete_admission:
        return resume_incomplete_admission(args,root,runner,github)
    if args.prepare_admission_request:
        return prepare_admission_request(args, root, runner)
    parent = args.state_dir.absolute()
    if parent.resolve(strict=True) != parent or parent.stat().st_uid != os.geteuid() or parent.stat().st_mode & 0o077:
        raise ValueError('private physical current-owner state directory required')
    directory,started_at=open_admission(parent,args.resume_admission,admission_binding(args,runner),runner,bool(args.archive_run))
    if not 0 <= time.time()-started_at < 5400:
        raise ValueError('original campaign clock expired; retained reservations are not new launch permission')
    token = token_from_agents(runner['read'](args.agents_env))
    os.environ['FLY_API_TOKEN'] = token
    capture = runpy.run_path(str(root/'scripts/cloudbench-original-volume-capture.py'))
    snapshot=directory/('capacity-before-reservation-'+str(time.time_ns())) if args.archive_run else directory
    if snapshot != directory: snapshot.mkdir(mode=0o700)
    print(json.dumps(dict(directory=str(directory),source_ref=args.source_ref,status='ADMISSION_STARTED',resume_option='--resume-admission '+str(directory))),flush=True)
    try:
        if (directory/'archived-reuse-original.private.json').exists():
            with runner['bounded'](min(110, admission_remaining(started_at + 5400))):
                cap=capacity_snapshot(capture['Fly'],token,args.org,snapshot,args.extra_destroying_count)
        else:
            cap=capacity(capture['Fly'],token,args.org,snapshot,args.extra_destroying_count,args.archive_run,args.source_ref,args.reuse_exclude_machine,
                         facts_from(runner['read'](args.facts))['image_ref'],args.unused_reservation_run,args.parked_reservation_run,args.expired_reservation_run,
                         deadline=started_at + 5400)
        admission_remaining(started_at + 5400)
        if args.archive_run:
            cap=reserve_reuse_capacity(capture['Fly'],token,args,runner,directory,snapshot,cap,started_at)
            launch_directory=directory/('launch-'+str(time.time_ns()))
            launch_directory.mkdir(mode=0o700)
            runner['save'](launch_directory/'archived-reuse-request.private.json',json.loads(runner['read'](directory/'archived-reuse-request.private.json')))
        else:
            launch_directory=directory
        config = prepare(args, root, pins, runner, launch_directory, cap,started_at=started_at)
    except BaseException as error:
        print(json.dumps(dict(directory=str(directory),status='ADMISSION_PENDING',controller_started=False,
                             action=('Keep this state and use the same command with --resume-admission; never discard native reservation intents.'
                                     if args.archive_run else 'Preserve this failed admission; no controller was started.'))),file=sys.stderr,flush=True)
        if isinstance(error,AdmissionInterrupted):
            raise SystemExit(128+error.signum)
        raise
    runner['save'](directory/'controller-launch.intent.json',dict(config_path=str(config),config_sha256=digest(runner['read'](config)),run_directory=str(launch_directory/'run')))
    print(json.dumps(dict(directory=str(launch_directory),admission_directory=str(directory), source_ref=args.source_ref, status='LAUNCHING_ORIGINAL600')), flush=True)
    return runner['run'](config, digest(runner['read'](config)), launch_directory/'run', github_token=github)


if __name__ == '__main__':
    raise SystemExit(main())
