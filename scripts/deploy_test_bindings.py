"""Generate transport bindings from the full suite recipes and prepared hosts."""
from pathlib import Path
import shlex
import sys


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
        if gate.get('native_backend') and mode not in {'local-isolated', 'boxes-thread'}:
            raise ValueError('native backend cases require a local-isolated or boxes-thread worker')
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
        elif mode != 'local-isolated':
            raise ValueError('inventory must name an existing local-isolated, SSH or boxes-thread worker')
        if 'recipe' in slot:
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
    return bindings
