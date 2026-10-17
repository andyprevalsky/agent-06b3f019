#!/usr/bin/env python3
"""Portable original600 capacity → bind → owned controller entrypoint."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import runpy
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
    'cloudbench-operator-preflight.py', 'cloudbench-original600-runner.py',
    'run-original600-controller.py',
]


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


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
    # Same literal token-file contract used by the original capacity reader.
    values = [line.split('=', 1)[1].strip().strip('\"\'')
              for line in raw.decode().splitlines() if line.startswith('FLY_API_TOKEN=')]
    if len(values) != 1 or not values[0] or any(c.isspace() for c in values[0]):
        raise ValueError('one literal Fly token required in selected complete agents env')
    return values[0]


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


def capacity(api, token, org, directory, extra):
    started = time.time()
    query = 'query { organization(slug:' + json.dumps(org) + ') { id slug settings billingStatus } }'
    req = urllib.request.Request('https://api.fly.io/graphql', data=json.dumps({'query': query}).encode(),
                                 headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
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

    def read_app(app):
        name = app['Name']
        if not isinstance(name, str) or not name or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in name):
            raise ValueError('invalid inventory app name')
        machines = api(name, token).api('GET', '/machines', timeout=20)
        if not isinstance(machines, list) or len({m['id'] for m in machines}) != len(machines):
            raise ValueError('complete native Machine inventory required')
        path = directory / (name + '.private.json')
        runner['save'](path, machines)
        return dict(app=name, count=len(machines), path=str(path), sha256=digest(path.read_bytes()))

    # Read on the alarm-owning main thread: socket inactivity timeouts do not
    # bound a drip-fed body, and thread-pool shutdown cannot join such a worker.
    rows = [read_app(app) for app in apps]
    count = sum(r['count'] for r in rows)
    proof = dict(started_epoch=started, ended_epoch=time.time(), machine_limit=limit,
                 billing_status=organization['billingStatus'], total_active_inventory_objects=count,
                 conservative_extra_destroying_bench_objects=extra, apps=rows,
                 atomic_snapshot=False, all_reads_only=True, available_slots_conservative=limit-count-extra,
                 new_controller_slots=1, requested_original_primary_slots=600)
    if proof['available_slots_conservative'] < 601:
        raise ValueError('fewer than 601 conservatively available native slots')
    runner['save'](directory / 'capacity-proof.private.json', proof)
    return proof


def prepare(args, root, pins, runner, directory, cap):
    if not 0 <= time.time() - cap['ended_epoch'] < 270 or cap['available_slots_conservative'] < 601:
        raise ValueError('capacity proof expired or insufficient')
    read, save = runner['read'], runner['save']
    facts = facts_from(read(args.facts))
    tasks = json.loads(read(args.tasks))
    stamp = time.time()
    runner['campaign_argv'](tasks, stamp)  # Exact task-name hash and all original arguments.
    auth = dict(schema='cloudbench-disposable-controller-authority-v1', allowed=True, single_host=True,
                app=facts['app'], region='iad', vm_size='performance-8x', memory_mib=32768,
                workspace_size_gb=256, org_machine_limit=cap['machine_limit'],
                org_object_count=cap['total_active_inventory_objects'] + cap['conservative_extra_destroying_bench_objects'],
                verified_epoch=cap['ended_epoch'], capacity_proof=dict(path=str(directory/'capacity-proof.private.json'), sha256=digest(read(directory/'capacity-proof.private.json'))),
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
    config = dict(schema='original600-controller-runner-v1', allowed=True, source_root=str(root),
                  source_ref=args.source_ref, source_files=pins, tasks_path=str(args.tasks),
                  started_at_epoch=stamp, authority_template=str(directory/'authority-template.private.json'),
                  remote_files=files, remote_env=dict(CLOUDBENCH_CLONE_MAX_ATTEMPTS='5', PYTHONDONTWRITEBYTECODE='1'),
                  gate_env=dict(CLOUDBENCH_APP=facts['app'], CLOUDBENCH_REGION='iad', WARM_IMAGE_REF=facts['image_ref'],
                                CLOUDBENCH_GATE_TIMEOUT_S='7200', PYTHONDONTWRITEBYTECODE='1'))
    save(directory/'config.private.json', config)
    save(directory/'attempt-start.safe.json', dict(scope='original200x3REAL', scheduled_total=600,
         source_ref=args.source_ref, task_ref=runner['TASK_REF'], started_at_epoch=stamp,
         original_deadline_epoch=stamp+5400, config_sha256=digest(read(directory/'config.private.json')),
         status='BOUND_NOT_LAUNCHED'))
    return directory/'config.private.json'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true', help='perform fresh capacity reads, then allocate and own one original600 controller')
    parser.add_argument('--source-ref', required=True)
    for name in ['state-dir', 'facts', 'agents-env', 'backend-env', 'tasks', 'snapshot-inventory', 'warm-deps']:
        parser.add_argument('--'+name, required=True, type=Path)
    parser.add_argument('--org', choices=['personal'], default='personal')
    parser.add_argument('--extra-destroying-count', type=int, default=1)
    args = parser.parse_args()
    os.umask(0o077)
    root = Path(__file__).resolve().parents[1]
    pins = source(root, args.source_ref)
    runner = runpy.run_path(str(root/'scripts/cloudbench-original600-runner.py'))
    preflight = runpy.run_path(str(root/'scripts/cloudbench-operator-preflight.py'))
    for name in ['facts', 'agents_env', 'backend_env', 'tasks', 'snapshot_inventory', 'warm_deps']:
        path = getattr(args, name).absolute()
        preflight['private_input'](path)
        setattr(args, name, path)
    runner['campaign_argv'](json.loads(runner['read'](args.tasks)), time.time())
    facts_from(runner['read'](args.facts))
    token_from_agents(runner['read'](args.agents_env))
    if args.extra_destroying_count < 1:
        raise ValueError('conservative unlisted/destroying allowance must be at least one')
    subprocess.run([sys.executable, '-I', '-B', str(root/'scripts/cloudbench-operator-preflight.py'), '--require-flyctl'], check=True)
    version = subprocess.check_output(['flyctl', 'version'], text=True, timeout=5)
    if not re.search(r'flyctl v0\.4\.115\b', version):
        raise ValueError('original controller requires the pinned Fly CLI v0.4.115')
    if not args.run:
        print(json.dumps(dict(status='CHECKED_NOT_LAUNCHED', source_ref=args.source_ref, uid=os.geteuid(), provider_calls=0)))
        return 0
    parent = args.state_dir.absolute()
    if parent.resolve(strict=True) != parent or parent.stat().st_uid != os.geteuid() or parent.stat().st_mode & 0o077:
        raise ValueError('private physical current-owner state directory required')
    directory = parent / ('original600-' + str(time.time_ns()))
    directory.mkdir(mode=0o700)
    token = token_from_agents(runner['read'](args.agents_env))
    os.environ['FLY_API_TOKEN'] = token
    capture = runpy.run_path(str(root/'scripts/cloudbench-original-volume-capture.py'))
    with runner['bounded'](110):
        cap = capacity(capture['Fly'], token, args.org, directory, args.extra_destroying_count)
    config = prepare(args, root, pins, runner, directory, cap)
    print(json.dumps(dict(directory=str(directory), source_ref=args.source_ref, status='LAUNCHING_ORIGINAL600')), flush=True)
    return runner['run'](config, digest(runner['read'](config)), directory/'run')


if __name__ == '__main__':
    raise SystemExit(main())
