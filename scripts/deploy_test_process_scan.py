"""Read-only native process custody scan. Privilege is limited to this fixed scanner."""
import hashlib
import inspect
import json
import os
from pathlib import Path
import subprocess
import uuid


class ProcessAccessError(ValueError):
    pass


def scan_roots(workers, proc=Path('/proc'), *, birth_guard=False, excluded=()):
    """Fail closed on live or unreadable local process ownership; never signal it."""
    if not proc.is_dir():
        raise ValueError('prepared binding ownership inspection requires /proc')
    for entry in proc.glob('[0-9]*'):
        if int(entry.name) in (os.getpid(), *excluded):
            continue
        birth = None
        if birth_guard:
            try:
                initial = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
                birth = initial[19]
                if initial[0] == 'Z':
                    if initial[17] != '1':
                        raise ProcessAccessError('exited leader still has a thread group')
                    # An exited process may remain unreaped. Prove that it has
                    # no filesystem references before omitting it from custody.
                    try:
                        os.readlink(entry / 'cwd')
                    except FileNotFoundError:
                        pass
                    else:
                        raise ProcessAccessError('exited process retains a working directory')
                    try:
                        if list((entry / 'fd').iterdir()) or (entry / 'maps').read_bytes():
                            raise ProcessAccessError('exited process retains file references')
                        final = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
                        if final[0] != 'Z' or final[19] != birth or final[17] != '1':
                            raise ProcessAccessError('exited process identity changed')
                    except (FileNotFoundError, ProcessLookupError) as error:
                        if entry.exists():
                            raise ProcessAccessError('exited process ownership is unreadable') from error
                    continue
            except FileNotFoundError:
                continue
            except (OSError, IndexError) as error:
                raise ValueError('local process birth identity is unreadable') from error
        paths = []
        for field in ('cwd', 'fd', 'maps'):
            try:
                if field == 'cwd':
                    paths.append(Path(os.readlink(entry / field).removesuffix(' (deleted)')))
                elif field == 'fd':
                    for fd in (entry / field).iterdir():
                        try:
                            paths.append(Path(os.readlink(fd).removesuffix(' (deleted)')))
                        except (FileNotFoundError, ProcessLookupError):
                            # A closed descriptor cannot suppress other descriptors or maps.
                            continue
                else:
                    for line in (entry / field).read_text().splitlines():
                        fields = line.split(maxsplit=5)
                        if len(fields) == 6 and fields[5].startswith('/'):
                            paths.append(Path(fields[5].removesuffix(' (deleted)')))
            except (FileNotFoundError, ProcessLookupError):
                if entry.exists():
                    raise ProcessAccessError('local process ownership is unreadable')
            except PermissionError as error:
                if entry.exists():
                    raise ProcessAccessError('local process ownership is unreadable') from error
            if any(path == worker or worker in path.parents for path in paths for worker in workers):
                raise ValueError('prepared worker has an active local consumer')
        if birth_guard:
            try:
                if (entry / 'stat').read_text().rsplit(')', 1)[1].split()[19] != birth:
                    raise ValueError('local process birth identity changed')
            except FileNotFoundError:
                continue
            except (OSError, IndexError) as error:
                raise ValueError('local process birth identity is unreadable') from error


def identity(pid):
    path = Path('/proc') / str(pid)
    fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
    uids = next(line.split()[1:] for line in (path / 'status').read_text().splitlines()
                if line.startswith('Uid:'))
    return int(uids[0]), int(uids[1]), fields[19], int(fields[1])


def privileged_main():
    try:
        signal.alarm(25)
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            raise ValueError('scan input limit')
        request = json.loads(raw)
        if (set(request) != {'kind','uid','pid','birth','roots','nonce'}
                or request['kind'] != 'deploy-process-scan-v1'
                or type(request['uid']) is not int or request['uid'] <= 0
                or type(request['pid']) is not int or request['pid'] <= 1
                or not isinstance(request['birth'], str)
                or not isinstance(request['nonce'], str) or len(request['nonce']) != 32
                or not isinstance(request['roots'], list) or not 1 <= len(request['roots']) <= 64
                or len(set(request['roots'])) != len(request['roots'])
                or os.geteuid() != 0 or os.environ.get('SUDO_UID') != str(request['uid'])):
            raise ValueError('scan invocation identity')
        original = identity(request['pid'])
        if original[:3] != (request['uid'],request['uid'],request['birth']):
            raise ValueError('scan caller changed')
        ancestor = os.getppid()
        for _ in range(6):
            if ancestor == request['pid']:
                break
            uid, euid, birth, ancestor = identity(ancestor)
            if uid not in (0,request['uid']) or euid not in (0,request['uid']):
                raise ValueError('scan parent identity')
        else:
            raise ValueError('scan is not a child of caller')
        roots = []
        for value in request['roots']:
            if not isinstance(value,str) or len(value.encode()) > 4096:
                raise ValueError('scan path limit')
            path=Path(value)
            if (not path.is_absolute() or str(path) != value or '..' in path.parts
                    or len(path.parts) < 3 or path.resolve() != path or not path.is_dir()
                    or path.stat().st_uid != request['uid']):
                raise ValueError('scan root custody')
            roots.append(path)
        scan_roots(roots,birth_guard=True,excluded=(request['pid'],))
        if identity(request['pid']) != original:
            raise ValueError('scan caller changed')
        answer={'kind':'deploy-process-scan-v1','request_sha256':hashlib.sha256(raw).hexdigest(),
                'uid':request['uid'],'pid':request['pid'],'birth':request['birth'],'quiescent':True}
        print(json.dumps(answer))
    except Exception:
        # Do not expose unrelated process paths/arguments or execute caller-provided text.
        print(json.dumps({'kind':'deploy-process-scan-v1','quiescent':False}))
        raise SystemExit(2)


def privileged_scan(roots):
    if not 1 <= len(roots) <= 64:
        raise ValueError('scan input limit')
    uid,euid,birth,_=identity(os.getpid())
    if uid != euid or uid <= 0:
        raise ValueError('scan delegation requires the original nonroot uid')
    request=dict(kind='deploy-process-scan-v1',uid=uid,pid=os.getpid(),birth=birth,
                 roots=list(dict.fromkeys(str(p) for p in roots)),nonce=uuid.uuid4().hex)
    raw=json.dumps(request,sort_keys=True).encode()
    if len(raw)>65536 or not 1 <= len(request['roots']) <= 64:
        raise ValueError('scan input limit')
    # Isolated Python, fixed audited program, no local imports or shell; only bounded JSON is data.
    program=('import sys,os,json,hashlib,signal\nfrom pathlib import Path\n'
             +inspect.getsource(ProcessAccessError)+'\n'+inspect.getsource(scan_roots)+'\n'
             +inspect.getsource(identity)+'\n'+inspect.getsource(privileged_main)+'\nprivileged_main()\n')
    try:
        result=subprocess.run(['/usr/bin/sudo','-n','/usr/bin/python3','-I','-S','-B','-c',program],
                              input=raw,capture_output=True,timeout=30,close_fds=True,
                              env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'})
        if result.returncode or len(result.stdout)>4096:
            raise ValueError('privileged read-only process scan refused or unavailable')
        answer=json.loads(result.stdout)
    except (OSError,subprocess.TimeoutExpired,json.JSONDecodeError) as error:
        raise ValueError('privileged read-only process scan unavailable') from error
    expected=dict(kind='deploy-process-scan-v1',request_sha256=hashlib.sha256(raw).hexdigest(),
                  uid=uid,pid=os.getpid(),birth=birth,quiescent=True)
    if answer != expected or identity(os.getpid())[:3] != (uid,euid,birth):
        raise ValueError('privileged process scan response identity differs')
    return {**answer,'scanner_sha256':hashlib.sha256(program.encode()).hexdigest()}


def prepared_workers_idle(roots,proc=Path('/proc'),*,birth_guard=False):
    try:
        return scan_roots(roots,proc,birth_guard=birth_guard)
    except ProcessAccessError:
        if proc != Path('/proc') or not birth_guard:
            raise
        return privileged_scan(roots)
