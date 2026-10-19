"""Registered controller guard cases; historical adapters execute captured boundaries only."""
import ast
import copy
import hashlib
import json
import os
from pathlib import Path
import runpy
import shutil
import stat
import subprocess
import sys
import tempfile
import types
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = Path(__file__).parent / 'fixtures/controller_maintenance'


def captured():
    raw = (FIXTURES / 'captured.json').read_bytes()
    manifest = json.loads((FIXTURES / 'provenance.json').read_bytes())
    assert hashlib.sha256(raw).hexdigest() == manifest['fixture_sha256']
    value = json.loads(raw)
    for row in manifest['fragments']:
        assert hashlib.sha256(value[row['boundary']].encode()).hexdigest() == row['published_fragment_sha256']
    return value


class Historical:
    """Narrow offline adapters, not substitute defective implementations."""
    def __init__(self): self.source = captured()

    def maintenance_process_identity(self, observed, expected):
        row = observed
        fields = ['S', str(row['ppid'])] + ['0'] * 17 + [row['birth']]
        class Proc:
            def __init__(self, name): self.name = name
            def __truediv__(self, name): return Proc(self.name + '/' + name)
            def read_text(self): return '101 (fixture) ' + ' '.join(fields)
            def read_bytes(self): return b'\0'.join(s.encode() for s in row['argv']) + b'\0'
            def stat(self): return types.SimpleNamespace(st_uid=row['uid'])
        ns = dict(Path=Proc, filehash=lambda p: hashlib.sha256(p.read_bytes()).hexdigest())
        exec(self.source['identity'], ns)
        return observed

    def maintenance_inventory(self, required, optional, trees):
        campaign, reg, audit = map(Path, trees)
        ns = dict(Path=Path, os=os, stat=stat, hashlib=hashlib, R=campaign.parent,
                  C=Path(required[-1]).parent, campaign=campaign, record={'common_git': str(reg.parent.parent)})
        key = 'optional' if not reg.exists() else 'typed'
        # Typed test also has absent original registry; select its original
        # boundary explicitly through the fixture scenario rather than changing code.
        if any(p.is_symlink() or stat.S_ISFIFO(p.lstat().st_mode) for p in campaign.rglob('*')):
            key = 'typed'
        exec(self.source[key], ns)
        return dict(entries={str(p): {'kind': 'regular'} for p in ns['protected']}, presence=ns.get('optional_presence', {}))

    def maintenance_run_child(self, argv, uid, gid, **kwargs):
        exec(self.source['privilege'], {'os': os})
        return subprocess.run(argv, **kwargs)

    def maintenance_operation_directory(self, parent, child):
        root = Path(parent).parents[2]
        script = 'set -euo pipefail\numask 077\noperation=target\nrepo="$1"\nrun_dir="$2"\n' + self.source['directory']
        result = subprocess.run(['bash', '-c', script, 'captured-directory', str(root), str(child)], capture_output=True, text=True)
        if result.returncode: raise ValueError(result.stderr)
        return Path(child)

    def maintenance_wait_stopped(self, expected, observe, children, stop, clock, sleep, timeout=2):
        # Actual failed loop/exact_init source, with its external reads supplied.
        ns = dict(INIT=expected['pid'], BIRTH=expected['birth'], process=observe,
                  time=types.SimpleNamespace(monotonic=clock, sleep=sleep), deadline=clock()+timeout)
        exec(self.source['scheduler'], ns)
        return observe(expected['pid'])

    def maintenance_tool_environment(self, binary, digest, size, environment):
        attrs = {name: getattr(os, name) for name in dir(os)}
        attrs['environ'] = environment
        ns = dict(os=types.SimpleNamespace(**attrs), REPO=Path(binary).parent)
        exec(self.source['path'], ns)
        return ns['env']


def guards():
    if os.environ.get('CLOUDBENCH_MAINTENANCE_IMPLEMENTATION') == 'captured':
        return Historical()
    return types.SimpleNamespace(**runpy.run_path(str(ROOT / 'scripts/cloudbench-controller-export.py')))


def refuses(fn):
    try: fn()
    except (ValueError, AssertionError, OSError): return
    raise AssertionError('changed or unsafe observation was accepted')


def test_process_identity():
    g = guards()
    row = dict(pid=101, birth='123', ppid=1, uid=0, argv=['/bin/bash', '/tmp/fixture-init.sh'], state='S')
    expected = dict(row, workspace_uid=1001)
    assert g.maintenance_process_identity(row, expected) == row
    for key, value in [('uid',1001), ('birth','124'), ('argv',['/bin/bash','/tmp/other.sh'])]:
        changed = dict(row, **{key:value})
        refuses(lambda: g.maintenance_process_identity(changed, expected))


def layout(root):
    repo = root/'repo'; campaign = repo/'campaign'; reg = repo/'.git/cloudbench-fleet-ownership'/('a'*32)
    audit = repo/'.git/cloudbench-fleet-audits'/('a'*32); custody=root/'custody'
    for p in [campaign,audit/'fresh',audit/'expected-fresh',audit/'by-machine-id',custody]: p.mkdir(parents=True)
    required=[campaign/'summary.json',repo/'.context/stress200-host/preflight.json',audit/'meta',repo/'agents/.env',repo/'back-end/.env',custody/'launch.json',custody/'original82-capture-b85.manifest.json',custody/'original82-capture-b85.tar.gz']
    for p in required: p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b'original fixture')
    optional=[reg,reg/'clones',reg/'meta',audit/'fresh',audit/'expected-fresh',audit/'by-machine-id']
    return required,optional,[campaign,reg,audit]


def test_optional_inventory():
    g=guards()
    with tempfile.TemporaryDirectory() as tmp:
        required,optional,trees=layout(Path(tmp))
        before=g.maintenance_inventory(required,optional,trees)
        assert before['presence'][str(optional[0])] is False
        assert g.maintenance_inventory(required,optional,trees)==before
        optional[0].mkdir(parents=True)
        assert g.maintenance_inventory(required,optional,trees)!=before
        required[-1].unlink()
        refuses(lambda:g.maintenance_inventory(required,optional,trees))


def test_typed_inventory():
    g=guards()
    with tempfile.TemporaryDirectory() as tmp:
        required,optional,trees=layout(Path(tmp));root=trees[0]
        target=root/'snapshot';target.mkdir();(target/'data').write_bytes(b'kept')
        link=root/'current';link.symlink_to('snapshot',target_is_directory=True)
        fifo=root/'capture.pipe';os.mkfifo(fifo)
        before=g.maintenance_inventory(required,optional,trees)
        assert before['entries'][str(link)]['kind']=='symlink'
        assert before['entries'][str(link)]['link']=='snapshot'
        assert before['entries'][str(fifo)]['kind']=='fifo'
        assert str(link/'data') not in before['entries']
        assert 'sha256' not in before['entries'][str(fifo)]
        link.unlink();link.symlink_to('different')
        assert g.maintenance_inventory(required,optional,trees)!=before


def test_privilege_separation():
    g=guards();state=dict(uid=0,gid=0,groups=[0]);events=[]
    def run(argv,**kwargs):
        assert state['uid']==0,'coordinator lost root-private seal access before child'
        child=dict(state)
        if kwargs.get('preexec_fn'): kwargs['preexec_fn']()
        events.append(dict(state));state.update(child)
        return types.SimpleNamespace(returncode=0)
    with tempfile.TemporaryDirectory() as tmp:
        seal=Path(tmp)/'seal';seal.write_bytes(b'original');seal.chmod(0o600);before=seal.stat()
        with patch.object(os,'setgroups',side_effect=lambda v:state.update(groups=v)),patch.object(os,'setgid',side_effect=lambda v:state.update(gid=v)),patch.object(os,'setuid',side_effect=lambda v:state.update(uid=v)),patch.object(os,'chdir'),patch.object(subprocess,'run',side_effect=run):
            g.maintenance_run_child(['fixture-git'],1001,1001)
        assert state['uid']==0 and seal.read_bytes()==b'original'
        assert events==[dict(uid=1001,gid=1001,groups=[])]
        assert (before.st_uid,before.st_mode)==(seal.stat().st_uid,seal.stat().st_mode)


def test_operation_directory():
    g=guards()
    with tempfile.TemporaryDirectory() as tmp:
        root=Path(tmp);parent=root/'.context/pr1525-continuation/v41-retained-ops';parent.parent.mkdir(parents=True)
        child=parent/'target-fixture';assert g.maintenance_operation_directory(parent,child)==child
        assert parent.stat().st_mode&0o777==0o700 and child.stat().st_mode&0o777==0o700
        marker=child/'original';marker.write_text('retained')
        refuses(lambda:g.maintenance_operation_directory(parent,child));assert marker.read_text()=='retained'
        parent.chmod(0o755);refuses(lambda:g.maintenance_operation_directory(parent,parent/'bad'))


def test_stop_transition():
    g=guards();expected=dict(pid=101,birth='fixture-birth',uid=0,uids=[0]*4,ppid=1,argv=['/bin/bash','/tmp/gate.sh'])
    def scenario(states,foreign=False):
        sequence=iter(states);ticks=iter([i/10 for i in range(100)]);stops=[]
        def observe(pid):return dict(expected,state=next(sequence,states[-1]),birth='foreign' if foreign else expected['birth'])
        result=g.maintenance_wait_stopped(expected,observe,lambda:[],stops.append,lambda:next(ticks),lambda _:None,timeout=0.5)
        return result,stops
    result,stops=scenario(['S','S','R','D','T'])
    assert result['state']=='T' and stops==[101]
    refuses(lambda:scenario(['S','R'],True))
    try:scenario(['S','S']+['R']*20)
    except TimeoutError:pass
    else:raise AssertionError('pending stop exceeded deadline')


def test_retained_path():
    g=guards()
    with tempfile.TemporaryDirectory() as tmp:
        binary=Path(tmp)/'flyctl';data=b'not executed';binary.write_bytes(data);binary.chmod(0o700)
        digest=hashlib.sha256(data).hexdigest();original=dict(PATH='/usr/bin:/bin',PRESERVE='yes')
        env=g.maintenance_tool_environment(binary,digest,len(data),original)
        assert shutil.which('flyctl',path=env['PATH'])==str(binary)
        assert env['PATH'].endswith('/usr/bin:/bin') and env['PRESERVE']=='yes' and original==dict(PATH='/usr/bin:/bin',PRESERVE='yes')
        refuses(lambda:g.maintenance_tool_environment(binary,'0'*64,len(data),original))
        target=binary.with_name('real');binary.rename(target);binary.symlink_to(target)
        refuses(lambda:g.maintenance_tool_environment(binary,digest,len(data),original))
