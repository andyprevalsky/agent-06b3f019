"""Validate execution bindings before removing cross-suite ordering edges."""
from pathlib import Path
import importlib.util

_spec = importlib.util.spec_from_file_location('deploy_worker_ports', Path(__file__).with_name('deploy-worktree-port.py'))
_ports = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_ports)


def validate(plan, root):
    root = Path(root).resolve()
    roots, workspaces, ports, threads = set(), set(), set(), set()
    for gate in plan['gates']:
        if gate.get('quick'):
            continue
        mode = gate.get('worker_transport')
        args = gate['command']
        if mode == 'benchmark-cloud-cli':
            native = (gate.get('native_cloud') is True and gate.get('case_protocol') is True
                      and len(args) == 2 and Path(args[1]).resolve() == root / 'scripts/deploy_test_cloud.py')
            legacy = (not gate.get('native_cloud') and len(args) == 2
                      and Path(args[0]).name == 'bash' and Path(args[1]).name == 'run-predeploy-cloud')
            if not (native or legacy):
                raise ValueError('cloud smoke must use the actual cloud benchmark launcher')
            continue
        if mode == 'ssh':
            # Fail closed on saved plans too: timeout/cancel cannot reach the remote worker (finding 4447557475).
            raise ValueError(f"{gate.get('name')}: ssh transport has no remote cancel/cleanup path "
                             '(finding 4447557475); use boxes-thread or local-isolated')
        if mode == 'boxes-thread':
            thread, box, location, python, control = (gate.get(k) for k in
                ('worker_thread', 'worker_host', 'worker_root', 'remote_python', 'coordinator_thread'))
            if any(not isinstance(v, str) or not v or v.startswith('-') for v in (thread, box, control)):
                raise ValueError('boxes-thread binding requires its worker thread, devbox host and coordinator thread')
            if not isinstance(location, str) or not location.startswith('/') or '..' in Path(location).parts:
                raise ValueError('boxes-thread binding requires the prepared absolute worker root')
            location = str(Path(location))
            if (not isinstance(python, str) or not python.startswith('/') or '..' in Path(python).parts
                    or Path(location) not in Path(python).parents):
                raise ValueError('boxes-thread binding requires an absolute remote python inside the worker root')
            if (not gate.get('case_protocol') or 'worker_recipe' not in gate
                    or gate.get('result_transport') != 'file'):
                raise ValueError('boxes-thread binding requires the source-bound worker receipt protocol')
            if gate.get('timeout_seconds') is None:
                raise ValueError('boxes-thread binding requires its existing gate deadline')
            expected = ['--thread', thread, '--host', box, '--worker-root', location, '--python', python,
                        '--coordinator-thread', control, '--deadline-seconds', str(gate['timeout_seconds'])]
            if gate.get('native_backend'):
                if gate.get('name') != 'backend-coverage-blackbox':
                    raise ValueError('backend entrypoint is restricted to the backend coverage gate')
                expected += ['--worker-script', 'deploy_test_backend.py']
            if (len(args) != 2 + len(expected) or args[2:] != expected
                    or Path(args[1]).resolve() != root / 'scripts/deploy_test_boxes.py'):
                raise ValueError('boxes-thread argv must bind the same thread, host, root, python, coordinator and deadline')
            if thread in threads:
                raise ValueError('workers must not share a worker thread')
            threads.add(thread)
            host = 'boxes:' + box
        elif mode == 'local-isolated':
            host = 'local'
            location = str(Path(gate.get('cwd', root)).resolve())
            path = Path(location)
            if path == root or root in path.parents or path in root.parents:
                raise ValueError('worker checkout must be outside the coordinator checkout')
            if gate.get('worker_root', location) != location:
                raise ValueError('local worker root and working directory differ')
        else:
            raise ValueError('bind a local-isolated, SSH, boxes-thread, or cloud benchmark executor')
        workspace = gate.get('env', {}).get('CONDUCTOR_WORKSPACE_NAME')
        port = gate.get('env', {}).get('CONDUCTOR_PORT')
        if not workspace or not port or not port.isdigit() or not 1 <= int(port) <= 65535:
            raise ValueError('worker needs explicit isolated workspace/database identity and port')
        overlapping_root = any(h == host and (Path(location) == Path(p)
            or Path(location) in Path(p).parents or Path(p) in Path(location).parents) for h, p in roots)
        footprint = {(host, int(port) + offset) for offset in _ports.LISTENER_OFFSETS}
        if any(number > _ports.MAX_PORT for _, number in footprint):
            raise ValueError('worker port footprint exceeds the valid port range')
        if overlapping_root or (host, workspace) in workspaces or footprint & ports:
            raise ValueError('workers must not share a checkout, database/workspace, or port')
        roots.add((host, location));workspaces.add((host, workspace));ports.update(footprint)
