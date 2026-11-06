#!/usr/bin/env python3
"""Local-only deploy cycle prep (not committed): hardlinked worker clones, inventory, frozen env.

usage: prep-cycle.py <source-root> <workers-dir>
Clones the committed HEAD of <source-root> into <workers-dir>/<name> with hardlinked objects
(prepare_checkout's --no-hardlinks costs ~4.7 GB per worker; this is ~3.2 GB), verifies the
frozen source digest equals the coordinator's, links dependency trees, writes the inventory.
"""
import json, os, shutil, subprocess, sys
from pathlib import Path

src = Path(sys.argv[1]).resolve()
base = Path(sys.argv[2]).resolve()
sys.path.insert(0, str(src / 'scripts'))
from deploy_test_worker import source  # noqa: E402
import deploy_test_plan as planner  # noqa: E402

# name -> (gate, port base). Port bases are packed so the 532-port listener footprints are disjoint.
WORKERS = {
    'backend': ('backend-coverage-blackbox', 10000),
    'frontend': ('frontend-coverage-blackbox', 10501),
    'agentscov': ('agents-coverage-blackbox', 11002),
    'structural': ('deploy-command-structural', 11503),
    'semantic': ('semantic-stack', 12004),
    'e2b': ('e2b-smoke', 12505),
    'liveprobes': ('live-probes', 13006),
    'seedcache': ('seed-cache-decision', 13507),
    'seedwa': ('canonical-seed-whatsapp-content', 14008),
    'seedmem': ('seed-memory-ratchet', 14509),
    'cloudctl': ('cloudbench-controller', 15010),
}
PATH = ':'.join(['/home/boxes/.local/bin', '/home/boxes/.fly/bin', str(src / 'agents/venv/bin'),
                 '/opt/devbox-tools/bin', '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin'])
RECIPE_FRAME = {
    'setup': {'command': ['bash', 'scripts/run-deploy-stage', '--start']},
    'cleanup': {'command': ['bash', '-c', 'bash scripts/kill-services.sh && bash scripts/run-deploy-stage --finish']},
    'services': True,
}
EXTRA_ENV = {'agents-coverage-blackbox': {'AGENTS_COVERAGE_CONCURRENCY': '2'}}
STRUCTURAL = ['python3', 'scripts/run-deploy-structural-gates.py', '--max-workers', '5']


def run(*args, **kw):
    return subprocess.run(args, check=True, **kw)


def clone(name):
    target = base / name
    if target.exists():
        raise SystemExit(f'{target} exists')
    expected = source(src)
    run('git', 'clone', '--quiet', '--local', str(src), str(target))
    run('git', '-C', str(target), 'checkout', '--quiet', '--detach', expected['head'])
    run('git', '-C', str(target), 'config', 'gc.auto', '0')
    for rel in ('.env', 'env.sh', 'back-end/.env', 'agents/.env', 'agents/.env.benchmark-temporal',
                'front-end/.env', 'front-end/.env.local'):
        origin, dest = src / rel, target / rel
        if origin.is_file():
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.touch(mode=0o600)
            shutil.copyfile(origin, dest)
            dest.chmod(0o600)
    for tree in ('node_modules', 'back-end/node_modules', 'front-end/node_modules'):
        if (src / tree).is_dir():
            run('cp', '-al', str(src / tree), str(target / tree))
    if (src / 'agents/venv').is_dir():
        (target / 'agents/venv').symlink_to(src / 'agents/venv')
    if source(target) != expected:
        raise SystemExit(f'{name}: source digest differs from the frozen source')
    return target


def main():
    base.mkdir(parents=True, exist_ok=True)
    template = planner.standard_template()
    gates = {g['name']: g for g in template['gates']}
    inventory = {}
    for name, (gate_name, port) in WORKERS.items():
        target = clone(name)
        env = {'CONDUCTOR_WORKSPACE_NAME': f'dw-{name}', 'CONDUCTOR_PORT': str(port),
               'CONDUCTOR_ROOT_PATH': str(target), 'ROSE_USE_SYSTEM_PG': 'true', 'PATH': PATH,
               'TMPDIR': '/var/tmp'}
        slot = {'id': f'local-{name}-worker', 'transport': 'local-isolated', 'worker_root': str(target),
                'env': env, 'timeout_seconds': 14400}
        gate = gates[gate_name]
        if gate_name == 'backend-coverage-blackbox':
            spec_env = None  # recipe comes from deploy_test_backend.py --handoff-slot
            slot['recipe'] = {'execution_timeout_seconds': 14400, **RECIPE_FRAME,
                              'cases': {gate['checks'][0]: {'command': ['npm', 'run', 'test:coverage:sharded'],
                                                            'cwd': 'back-end', 'env': {}, 'aggregate': True}}}
        else:
            command = STRUCTURAL if gate_name == 'deploy-command-structural' else gate['command']
            cwd = gate.get('cwd', '.')
            slot['recipe'] = {'cases': {gate['checks'][0]: {
                'command': command, 'cwd': cwd,
                'env': {**gate.get('env', {}), **EXTRA_ENV.get(gate_name, {}), **env}, 'aggregate': True}},
                **RECIPE_FRAME}
        inventory[gate_name] = slot
    inventory['smoke'] = {'id': 'cloud-smoke-worker', 'transport': 'benchmark-cloud-cli'}
    out = src / '.context/deploy-pipeline/inventory.json'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(inventory, indent=2))
    print('inventory written', out, 'workers', len(WORKERS))


if __name__ == '__main__':
    main()
