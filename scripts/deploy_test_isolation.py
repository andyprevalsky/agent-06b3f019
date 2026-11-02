"""Validate execution bindings before removing cross-suite ordering edges."""
from pathlib import Path
import importlib.util

_spec = importlib.util.spec_from_file_location('deploy_worker_ports', Path(__file__).with_name('deploy-worktree-port.py'))
_ports = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_ports)


def validate(plan, root):
    root = Path(root).resolve()
    roots, workspaces, ports = set(), set(), set()
    for gate in plan['gates']:
        if gate.get('quick'):
            continue
        mode = gate.get('worker_transport')
        args = gate['command']
        if mode == 'benchmark-cloud-cli':
            if not (len(args) >= 2 and Path(args[0]).name == 'bash'
                    and Path(args[1]).name == 'run-predeploy-cloud'):
                raise ValueError('cloud smoke must use the actual cloud benchmark launcher')
            continue
        if mode == 'ssh':
            host = gate.get('worker_host')
            if (not isinstance(host, str) or not host or host.startswith('-')
                    or Path(args[0]).name != 'ssh' or len(args) < 3 or args[1] != host):
                raise ValueError('SSH binding requires its explicit host in the transport argv')
            location = gate.get('worker_root')
            if not isinstance(location, str) or not location.startswith('/'):
                raise ValueError('SSH binding requires the prepared remote checkout root')
            if '..' in Path(location).parts:
                raise ValueError('remote worker root must be normalized')
            location = str(Path(location))
            if not gate.get('case_protocol') or gate.get('result_transport') != 'stdout':
                raise ValueError('SSH binding requires the source-bound worker receipt protocol')
        elif mode == 'local-isolated':
            host = 'local'
            location = str(Path(gate.get('cwd', root)).resolve())
            path = Path(location)
            if path == root or root in path.parents or path in root.parents:
                raise ValueError('worker checkout must be outside the coordinator checkout')
            if gate.get('worker_root', location) != location:
                raise ValueError('local worker root and working directory differ')
        else:
            raise ValueError('bind a local-isolated, SSH, or cloud benchmark executor')
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
