"""Private Git and disk transport for offline campaign lifecycle fixtures.

Only filesystem capacity/device observations are synthetic. Production helper
prepare/assign/retire and the caller's default 512/32/256 policy stay intact.
"""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
from unittest.mock import patch


def checked_directory(path):
    path=Path(path).absolute()
    if path.resolve(strict=True)!=path or not stat.S_ISDIR(path.lstat().st_mode) or path.stat().st_uid!=os.getuid():
        raise ValueError('fixture directory must be owned, real and unredirected')
    return path


def observe(original,prefix,device):
    def wrapped(path,*args,**kwargs):
        value=original(path,*args,**kwargs)
        if isinstance(path,(str,bytes,os.PathLike)):
            name=os.path.abspath(os.fsdecode(path))
            if (name==prefix or name.startswith(prefix+os.sep)) and stat.S_ISDIR(value.st_mode):
                fields=list(value);fields[2]=device;return os.stat_result(fields)
        return value
    return wrapped


class CampaignCleanupFixture:
    def __init__(self,root,source):
        self.root=checked_directory(root);source=Path(source).absolute()
        scripts=checked_directory(self.root/'scripts')
        self.private=self.root/'.cleanup-fixture'
        self.private.mkdir(mode=0o700)  # Exclusive: never replace another fixture.
        if (self.root/'.git').exists() or (self.root/'.git').is_symlink():
            raise ValueError('cleanup fixture requires a fresh non-Git root')
        names=('cloudbench-cleanup-tickets.py','cloudbench-infra-canary-preflight.py','run-fleet-infra-canary')
        for name in names:
            target=scripts/name
            with os.fdopen(os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb') as stream:
                stream.write((source/'scripts'/name).read_bytes())
        for args in (['init','-q'],['add','-f','--',*[str(Path('scripts')/name) for name in names]],
                     ['-c','user.name=Cleanup fixture','-c','user.email=fixture@localhost','-c','core.hooksPath=/dev/null','commit','-qm','real cleanup interpreter']):
            git_env={key:value for key,value in os.environ.items() if not key.startswith('GIT_')}
            subprocess.run(['git','-c','init.templateDir=','-c','core.hooksPath=/dev/null',
                            '-c','core.bare=false','-c','core.worktree='+str(self.root),
                            '-C',str(self.root),*args],env=git_env,check=True,capture_output=True)
        self.device=(1<<56)|int.from_bytes(os.urandom(7),'big')
        self.prefix=str(self.root/'.git/cloudbench-fleet-ownership')
        python=self.private/'python';python.mkdir(mode=0o700)
        # Reuse exactly this fixture's scoped directory-device observation.
        (python/'sitecustomize.py').write_text('import os,stat\n'+__import__('inspect').getsource(observe)+
            '\nos.stat=observe(os.stat,'+repr(self.prefix)+','+str(self.device)+')\nos.lstat=observe(os.lstat,'+repr(self.prefix)+','+str(self.device)+')\n')
        binary=self.private/'bin';binary.mkdir(mode=0o700)
        (binary/'df').write_text('#!/bin/sh\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted on\\nfixture 67108864 0 67108864 0%%%% /fixture\\n"\n')
        (binary/'df').chmod(0o700)
        self.env={'PYTHONPATH':str(python)+os.pathsep+os.environ.get('PYTHONPATH',''),
                  'PATH':str(binary)+os.pathsep+os.environ.get('PATH','')}
        (self.private/'identity.json').write_text(json.dumps(dict(root=str(self.root),device=self.device)))

    @contextmanager
    def scope(self):
        with patch.dict(os.environ,self.env),patch.object(os,'stat',observe(os.stat,self.prefix,self.device)),patch.object(os,'lstat',observe(os.lstat,self.prefix,self.device)):
            yield

    def close(self):
        retire(self.root)


def retire(root):
    root=checked_directory(root);private=checked_directory(root/'.cleanup-fixture')
    record=json.loads((private/'identity.json').read_text())
    if set(record)!={'root','device'} or record['root']!=str(root) or type(record['device']) is not int or record['device']<(1<<56):
        raise ValueError('foreign cleanup fixture identity')
    namespace=Path('/tmp')/('rose-cloudbench-cleanup-admission-'+str(os.getuid()))/str(record['device'])
    if not namespace.exists():return
    checked_directory(namespace)
    for path in namespace.rglob('*'):
        if path.is_symlink() or path.stat().st_uid!=os.getuid():raise ValueError('redirected fixture accounting')
    if set(p.name for p in namespace.iterdir())-{'admission.lock','ticket-grants','state.json'}:
        raise ValueError('unknown fixture accounting')
    if (namespace/'ticket-grants').exists() and any((namespace/'ticket-grants').iterdir()):
        raise ValueError('fixture campaign still owes a cleanup grant')
    if (namespace/'state.json').exists():
        state=json.loads((namespace/'state.json').read_text())
        if state.get('groups') or state.get('inflight'):raise ValueError('fixture legacy debt remains')
    shutil.rmtree(namespace)  # Only the exact self-owned, debt-free virtual device.


if __name__=='__main__':
    if sys.argv[1]=='prepare':
        fixture=CampaignCleanupFixture(sys.argv[2],sys.argv[3]);print(json.dumps(fixture.env))
    elif sys.argv[1]=='retire':retire(sys.argv[2])
    else:raise SystemExit('prepare or retire required')
