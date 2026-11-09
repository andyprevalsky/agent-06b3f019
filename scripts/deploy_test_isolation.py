"""Validate execution bindings before removing cross-suite ordering edges."""
from pathlib import Path
import importlib.util
import json
import os
import stat
import re

_spec = importlib.util.spec_from_file_location('deploy_worker_ports', Path(__file__).with_name('deploy-worktree-port.py'))
_ports = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_ports)

# Blacksmith GitHub Actions executor (scripts/deploy_test_github.py, .github/workflows/deploy-gates.yml):
# one ephemeral VM per gate, so a gate's checkout, database and ports cannot collide with another gate's.
GITHUB_TRANSPORT = 'github-actions'
GITHUB_LAUNCHER = 'scripts/deploy_test_github.py'
GITHUB_WORKER_ROOT = '/home/runner/_work/rose/rose'
GITHUB_RUNNER = re.compile(r'^blacksmith-(2|4|8|16|32)vcpu-ubuntu-2404$')
GITHUB_WORKER_SCRIPTS = ('deploy_test_worker.py', 'deploy_test_backend.py')
BACKEND_GATE = 'backend-coverage-blackbox'


def github_argv(runner: str, worker_script: str, timeout) -> list[str]:
    """Launcher arguments after the interpreter and script path; the binding and the validator share them."""
    return ['--runner', runner, '--worker-script', worker_script, '--worker-root', GITHUB_WORKER_ROOT,
            '--deadline-seconds', str(timeout)]


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
        elif mode == GITHUB_TRANSPORT:
            name = gate.get('name')
            if gate.get('category', name) == 'smoke':
                raise ValueError(f'{name}: smoke stays on the cloud benchmark CLI')
            if gate.get('worker_root') != GITHUB_WORKER_ROOT:
                raise ValueError(f'github-actions binding requires the runner checkout {GITHUB_WORKER_ROOT}')
            location = GITHUB_WORKER_ROOT
            if (not gate.get('case_protocol') or 'worker_recipe' not in gate
                    or gate.get('result_transport') != 'file'):
                raise ValueError('github-actions binding requires the source-bound worker receipt protocol')
            if gate.get('timeout_seconds') is None:
                raise ValueError('github-actions binding requires its existing gate deadline')
            if gate.get('native_backend') and name != BACKEND_GATE:
                raise ValueError('backend entrypoint is restricted to the backend coverage gate')
            script = GITHUB_WORKER_SCRIPTS[1] if gate.get('native_backend') else GITHUB_WORKER_SCRIPTS[0]
            runner = args[args.index('--runner') + 1] if '--runner' in args[:-1] else ''
            if not GITHUB_RUNNER.fullmatch(runner):
                raise ValueError('github-actions binding requires a Blacksmith Ubuntu 24.04 runner label')
            expected = github_argv(runner, script, gate['timeout_seconds'])
            if (len(args) != 2 + len(expected) or args[2:] != expected
                    or Path(args[1]).resolve() != root / GITHUB_LAUNCHER):
                raise ValueError('github-actions argv must bind the launcher, runner, worker script, root and deadline')
            host = 'github:' + name
        elif mode == 'local-isolated':
            host = 'local'
            location = str(Path(gate.get('cwd', root)).resolve())
            path = Path(location)
            if path == root or root in path.parents or path in root.parents:
                raise ValueError('worker checkout must be outside the coordinator checkout')
            if gate.get('worker_root', location) != location:
                raise ValueError('local worker root and working directory differ')
        else:
            raise ValueError('bind a local-isolated, SSH, boxes-thread, github-actions, or cloud benchmark executor')
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
    for gate in plan['gates']:
        value = gate.get('env', {}).get('TMPDIR')
        if gate.get('worker_transport') != 'local-isolated' or not value:
            continue
        worker = Path(gate.get('worker_root', gate.get('cwd', root)))
        if worker not in Path(value).parents:
            external_tmpdir(value, worker, root, gate['name'], plan['source'])
            if any(Path(value) == Path(p) or Path(p) in Path(value).parents
                   or Path(value) in Path(p).parents for host,p in roots if host == 'local'):
                raise ValueError('external TMPDIR overlaps another worker checkout')



def external_tmpdir(value, worker, coordinator, gate, source):
    """Validate an explicit, inode-bound private temp lease; never create or repair it."""
    path, worker, coordinator = Path(value), Path(worker), Path(coordinator)
    if (not path.is_absolute() or str(path) != value or '..' in path.parts
            or path.resolve() != path or not path.is_dir()
            or len(os.fsencode(str(path / 'org.chromium.Chromium.XXXXXX/SingletonSocket'))) > 107):
        raise ValueError('external TMPDIR must be a short real absolute directory')
    for ancestor in (path, *path.parents):
        if ancestor.is_symlink() or (ancestor / '.git').exists():
            raise ValueError('external TMPDIR cannot traverse symlinks or a checkout')
        info = ancestor.stat()
        if info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX:
            raise ValueError('external TMPDIR cannot traverse a mutable shared parent')
    if any(path == root or root in path.parents or path in root.parents for root in (worker, coordinator)):
        raise ValueError('external TMPDIR must be outside checkouts')
    info = path.stat()
    marker = path / '.deploy-tmpdir-owner.json'
    if (info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700
            or marker.is_symlink() or not marker.is_file()):
        raise ValueError('external TMPDIR requires private current-owner custody')
    meta = marker.stat()
    if (meta.st_uid != info.st_uid or stat.S_IMODE(meta.st_mode) != 0o600
            or meta.st_nlink != 1 or meta.st_size > 65536):
        raise ValueError('external TMPDIR custody marker is not private')
    expected = dict(schema='deploy-external-tmpdir-v1', coordinator_root=str(coordinator),
                    worker_root=str(worker), gate=gate, uid=info.st_uid,
                    device=info.st_dev, inode=info.st_ino)
    if json.loads(marker.read_text()) != expected:
        raise ValueError('external TMPDIR custody identity differs')
    return expected


def validate_tmpdir_request(request, root):
    """Shared point-of-use check for both native worker adapters, before effects."""
    lease, value = request.get('external_tmpdir'), request.get('external_tmpdir_path')
    actual = os.environ.get('TMPDIR')
    marked = bool(actual and (Path(actual) / '.deploy-tmpdir-owner.json').exists())
    if lease is None and value is None and not marked:
        return
    if (not isinstance(lease, dict) or not isinstance(value, str) or actual != value
            or not isinstance(lease.get('coordinator_root'), str)):
        raise ValueError('native worker external TMPDIR lease/env is missing or mismatched')
    if external_tmpdir(value, root, Path(lease['coordinator_root']), request['gate'], request['source']) != lease:
        raise ValueError('native worker external TMPDIR custody differs')
    recipe = request.get('worker_recipe') or {}
    for spec in [*recipe.get('cases', {}).values(), recipe.get('setup'), recipe.get('cleanup')]:
        if spec and 'TMPDIR' in spec.get('env', {}) and spec['env']['TMPDIR'] != value:
            raise ValueError('recipe cannot override owned external TMPDIR')
