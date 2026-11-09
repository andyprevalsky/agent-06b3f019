"""Generate transport bindings from the full suite recipes and prepared hosts."""
from pathlib import Path
import shlex
import sys

from deploy_test_isolation import (GITHUB_LAUNCHER, GITHUB_RUNNER, GITHUB_TRANSPORT, GITHUB_WORKER_ROOT,
                                   GITHUB_WORKER_SCRIPTS, github_argv)


def portable(recipe):
    """A remote VM has no coordinator paths: its interpreter is `python3` from the runner's agents venv."""
    def argv(spec):
        if not spec:
            return spec
        command = list(spec['command'])
        if command and Path(command[0]).is_absolute() and Path(command[0]).name.startswith('python'):
            command[0] = 'python3'
        return {**spec, 'command': command}
    out = {**recipe, 'cases': {name: argv(spec) for name, spec in recipe['cases'].items()}}
    for key in ('setup', 'cleanup'):
        if recipe.get(key):
            out[key] = argv(recipe[key])
    return out


def generate(template, inventory, root):
    bindings = {}
    for gate in template['gates']:
        name = gate['name']
        slot = inventory.get(name)
        if slot is None:
            continue  # The selector reports missing workers only for selected gates.
        mode = slot['transport']
        if mode == 'benchmark-cloud-cli':
            command = ([sys.executable, str(root / 'scripts/deploy_test_cloud.py')]
                       if gate.get('native_cloud') else ['bash', 'scripts/run-predeploy-cloud'])
            bindings[name] = {**slot, 'command': command}
            continue
        checkout = str(Path(slot['worker_root']))
        if not Path(checkout).is_absolute():
            raise ValueError('prepared worker roots must be absolute')
        if mode == 'local-isolated':
            checkout = str(Path(checkout).resolve())
            slot = {**slot, 'worker_root': checkout}
        if gate.get('native_backend'):
            from deploy_test_backend import sweep_from_recipe
            sweep_from_recipe(slot.get('recipe', {}), gate['checks'])
        if gate.get('native_backend') and mode not in {'local-isolated', 'boxes-thread', GITHUB_TRANSPORT}:
            raise ValueError('native backend cases require a local-isolated, boxes-thread or github-actions worker')
        if gate.get('native_backend') and mode == 'local-isolated':
            bindings[name] = {**slot, 'command': [sys.executable, str(root / 'scripts/deploy_test_backend.py'),
                              '--root', checkout], 'cwd': checkout, 'case_protocol': True, 'result_transport': 'file'}
            continue
        script = str(Path(checkout) / 'scripts/deploy_test_worker.py')
        command = [slot.get('python', sys.executable if mode == 'local-isolated' else 'python3'),
                   script, '--root', checkout, '--stdio']
        timeout = slot.get('timeout_seconds', gate.get('timeout_seconds'))
        if mode == 'ssh':
            # Timeout/cancel would signal only the local ssh client; the remote worker and its
            # services would keep running with no owned cleanup receipt (finding 4447557475).
            raise ValueError(f'{name}: ssh transport has no remote cancel/cleanup path (finding 4447557475); '
                             'use boxes-thread or local-isolated')
        elif mode == 'boxes-thread':
            for key in ('worker_thread', 'worker_host', 'coordinator_thread'):
                if not isinstance(slot.get(key), str) or not slot[key]:
                    raise ValueError(f'boxes-thread inventory requires {key}')
            if timeout is None:
                raise ValueError('boxes-thread inventory requires the existing gate deadline')
            # Local launcher is the coordinator's interpreter; slot.python is the REMOTE one.
            command = [sys.executable, str(root / 'scripts/deploy_test_boxes.py'), '--thread',
                       slot['worker_thread'], '--host', slot['worker_host'], '--worker-root', checkout,
                       '--python', slot.get('python', str(Path(checkout) / 'agents/venv/bin/python')),
                       '--coordinator-thread', slot['coordinator_thread'], '--deadline-seconds', str(timeout)]
            if gate.get('native_backend'):
                command += ['--worker-script', 'deploy_test_backend.py']
        elif mode == GITHUB_TRANSPORT:
            # One ephemeral Blacksmith VM per gate request; the launcher pushes the frozen commit, starts
            # .github/workflows/deploy-gates.yml and returns the worker's own result.json artifact.
            if checkout != GITHUB_WORKER_ROOT:
                raise ValueError(f'github-actions inventory requires the runner checkout {GITHUB_WORKER_ROOT}')
            if not isinstance(slot.get('runner'), str) or not GITHUB_RUNNER.fullmatch(slot['runner']):
                raise ValueError('github-actions inventory requires a Blacksmith Ubuntu 24.04 runner label')
            if timeout is None:
                raise ValueError('github-actions inventory requires the existing gate deadline')
            if gate.get('category', name) == 'smoke':
                raise ValueError(f'{name}: smoke stays on the cloud benchmark CLI')
            script = GITHUB_WORKER_SCRIPTS[1] if gate.get('native_backend') else GITHUB_WORKER_SCRIPTS[0]
            command = [sys.executable, str(root / GITHUB_LAUNCHER), *github_argv(slot['runner'], script, timeout)]
        elif mode != 'local-isolated':
            raise ValueError('inventory must name an existing local-isolated, SSH, boxes-thread or github-actions worker')
        if gate.get('native_live_probes'):
            from run_deploy_live_probes import recipe as live_recipe
            original = {'command': gate['command'], 'cwd': gate.get('cwd', '.'),
                        'env': {**gate.get('env', {}), **slot.get('env', {})}, 'aggregate': True}
            if 'timeout_seconds' in gate:
                original['timeout_seconds'] = gate['timeout_seconds']
            recipe = live_recipe(root, original)
        elif 'recipe' in slot:
            recipe = slot['recipe']
        else:
            if len(gate['checks']) != 1:
                raise ValueError('multi-case gates require their actual case-aware recipe')
            cwd = Path(gate.get('cwd', '.'))
            if cwd.is_absolute():
                cwd = cwd.relative_to(root)
            spec = {'command': gate['command'], 'cwd': str(cwd),
                    'env': {**gate.get('env', {}), **slot.get('env', {})},
                    # An aggregate exit cannot prove every constituent ran.
                    'aggregate': True}
            if 'timeout_seconds' in gate:
                spec['timeout_seconds'] = gate['timeout_seconds']
            recipe = {'cases': {gate['checks'][0]: spec}}
        bindings[name] = {**slot, 'command': command, 'cwd': checkout if mode == 'local-isolated' else str(root),
                          'recipe': recipe, 'result_transport': 'stdout'}
        if mode == 'boxes-thread':
            bindings[name].update(result_transport='file', timeout_seconds=timeout, worker_root=checkout,
                                  python=command[command.index('--python') + 1])
        elif mode == GITHUB_TRANSPORT:
            bindings[name].update(result_transport='file', timeout_seconds=timeout, worker_root=checkout,
                                  recipe=portable(recipe))
    return bindings
