"""V39 captured-input and cleanup checks; no native calls or process signals."""
import copy
import hashlib
import json
import os
from pathlib import Path
import runpy
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = Path(__file__).parent / 'fixtures/controller_v39'


def _pair(label):
    provenance = json.loads((FIXTURES / 'provenance.json').read_bytes())
    result = {}
    for name in ('native-before.json', 'native-after.json', 'volume.json'):
        raw = (FIXTURES / label / name).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == provenance['files'][label + '/' + name]['fixture_sha256']
        result[name] = json.loads(raw)
    return result


def test_v39_full_native_pair():
    """Same acceptance assertion: captured stale selection RED, fresh pair GREEN."""
    helper = runpy.run_path(str(ROOT / 'scripts/cloudbench-startup-failure-archive.py'))
    selected = _pair('stale' if os.environ.get('CLOUDBENCH_V39_PAIR_SELECTION') == 'captured' else 'fresh')
    first = selected['native-before.json']
    original = dict(clone_name=first['name'], volume_id=first['config']['mounts'][0]['volume'])
    with tempfile.TemporaryDirectory() as tmp:
        paths = {name: Path(tmp) / name for name in selected}
        for name, value in selected.items():
            paths[name].write_text(json.dumps(value))
        proof = helper['current_cold_native'](first['id'], original, paths['native-before.json'], paths['native-after.json'], paths['volume.json'])
        assert proof['instance_id'] == first['instance_id']
        # Keep every native field significant, including provider event metadata.
        for key in ('events', 'updated_at'):
            changed = copy.deepcopy(first)
            changed[key] = [] if key == 'events' else 'different-provider-observation'
            assert changed != first
            paths['native-after.json'].write_text(json.dumps(changed))
            try:
                helper['current_cold_native'](first['id'], original, paths['native-before.json'], paths['native-after.json'], paths['volume.json'])
            except ValueError:
                pass
            else:
                raise AssertionError('provider metadata change was accepted: ' + key)


def test_v39_cleanup_all_uid_writers():
    """Actual canonical writer predicate; PID1 and other UIDs receive no waiver."""
    helper = runpy.run_path(str(ROOT / 'scripts/cloudbench-controller-export.py'))
    fixture = json.loads((FIXTURES / 'cleanup.json').read_bytes())
    assert hashlib.sha256(fixture['fragment'].encode()).hexdigest() == fixture['fragment_sha256']
    root = Path('/fixture-gate')
    rows = {1: '/sbin', 201: '/', 202: '/'}
    identities = {1: 'boot:1', 201: 'boot:201', 202: 'boot:202'}
    class ProcPath:
        def __init__(self, value): self.value = str(value)
        @property
        def name(self): return self.value.rsplit('/', 1)[-1]
        def __truediv__(self, part): return ProcPath(self.value + '/' + str(part))
        def iterdir(self):
            if self.value == '/proc': return [ProcPath('/proc/' + str(pid)) for pid in rows]
            # Single-threaded groups: /proc/<pid>/task holds only the leader's tid.
            if self.value.endswith('/task'): return [self / self.value.split('/')[2]]
            if self.value.endswith('/fd'): return []
            raise AssertionError(self.value)
        def read_text(self):
            assert self.value.endswith('/maps')
            return ''
        def read_bytes(self):
            assert self.value == '/proc/1/cmdline'
            return b'\0'.join(value.encode() for value in fixture['observed_pid1_argv']) + b'\0'
    def readlink(path):
        parts = path.value.split('/')
        assert parts[-1] == 'cwd'
        return rows[int(parts[2])]
    namespace = helper['writers'].__globals__
    with patch.dict(namespace, Path=ProcPath, birth=lambda pid: identities[pid]), patch.object(os, 'readlink', side_effect=readlink):
        if os.environ.get('CLOUDBENCH_V39_CLEANUP_SELECTION') == 'captured':
            with patch.object(os, 'getpid', return_value=201):
                exec(compile(fixture['fragment'], '<captured-pid1-cleanup>', 'exec'), dict(Path=ProcPath, os=os, writers=helper['writers']))
        assert helper['writers']([root], {201}) == []
        rows[1] = str(root)
        assert helper['writers']([root], {201}) == [{'pid': 1, 'birth': 'boot:1'}]
        rows[1] = '/sbin'
        rows[202] = str(root / 'output')
        assert helper['writers']([root], {201}) == [{'pid': 202, 'birth': 'boot:202'}]
        with patch.object(os, 'readlink', side_effect=PermissionError):
            try:
                helper['writers']([root], {201})
            except ValueError:
                pass
            else:
                raise AssertionError('unobservable process was treated as idle')


def test_v39_receipt_bound_runtime():
    """The retained receipt selects the runtime; the old image path is no default."""
    helper = runpy.run_path(str(ROOT / 'scripts/cloudbench-controller-export.py'))
    fixture = json.loads((FIXTURES / 'runtime.json').read_bytes())
    assert hashlib.sha256(fixture['fragment'].encode()).hexdigest() == fixture['fragment_sha256']
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp) / 'repo'
        toolchain = repo / '.context/stress200-host/toolchain'
        runtime = toolchain / 'controller-venv'
        runtime.mkdir(parents=True)
        (repo / 'agents').mkdir()
        venv = repo / 'agents/venv'
        venv.symlink_to(runtime, target_is_directory=True)
        binding = {'private_venv_target': str(runtime)}
        if os.environ.get('CLOUDBENCH_V39_RUNTIME_SELECTION') == 'captured':
            namespace = dict(R=repo, Path=Path, os=os)
            exec(compile(fixture['fragment'], '<captured-runtime-layout>', 'exec'), namespace)
            selected = namespace['venv'].resolve(strict=True)
        else:
            selected = helper['maintenance_runtime_directory'](venv, binding, toolchain)
        assert selected == runtime
        foreign = Path(tmp) / 'foreign'
        foreign.mkdir()
        for wrong in ({'private_venv_target': str(foreign)}, {}):
            try:
                helper['maintenance_runtime_directory'](venv, wrong, toolchain)
            except (ValueError, KeyError):
                pass
            else:
                raise AssertionError('foreign or missing runtime binding accepted')
