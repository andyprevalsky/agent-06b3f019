"""Read-only physical audit for a completed failed backend sweep; never cleans resources."""
from contextlib import ExitStack
import datetime
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
from urllib.parse import urlsplit

VERSION = 'nativebackend-post-execution-audit-v1'
MAX_CONTROL_BYTES = 16 * 1024 * 1024
DB_LOCK_ROOT = Path('/tmp/rose-test-db-locks')

def database_locks(workspace, port):
    return [str(DB_LOCK_ROOT / ('localhost_%d_victoria_%s%s.lock' % (port, workspace, suffix)))
            for suffix in ('', '_s0', '_s1', '_s2')]



def need(value, message):
    if not value:
        raise ValueError('backend post-execution audit: ' + message)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def physical(path, uid=None):
    path = Path(path)
    need(path.is_absolute() and path.resolve(strict=True) == path, 'noncanonical path')
    row = path.lstat()
    need(stat.S_ISREG(row.st_mode) and row.st_nlink == 1
         and row.st_uid == (os.getuid() if uid is None else uid) and not row.st_mode & 0o022,
         'regular private-owned file required')
    return row


def read(path):
    physical(path)
    need(Path(path).stat().st_size <= MAX_CONTROL_BYTES, 'oversized control')
    def unique(pairs):
        row = {}
        for key, value in pairs:
            need(key not in row, 'duplicate JSON key')
            row[key] = value
        return row
    return json.loads(Path(path).read_text(), object_pairs_hook=unique)


def _call(argv):
    result = subprocess.run(argv, capture_output=True, timeout=15, check=False)
    need(result.returncode == 0 and len(result.stdout) <= MAX_CONTROL_BYTES, 'metadata command unavailable')
    return result.stdout


def _docker(machine):
    # Only selected metadata: no Config.Env, credentials, exec or lifecycle commands.
    template = ('{"snapshot":{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},'
                '"image_name":{{json .Config.Image}},"owner":{{json (index .Config.Labels "ai.rose.deploy-worktree.path")}},'
                '"running":{{json .State.Running}},"status":{{json .State.Status}},"paused":{{json .State.Paused}},'
                '"restarting":{{json .State.Restarting}},"dead":{{json .State.Dead}},'
                '"ports":{{json .HostConfig.PortBindings}},"mounts":{{json .Mounts}}},'
                '"runtime":{"pid":{{json .State.Pid}},"started_at":{{json .State.StartedAt}},'
                '"networks":{{json .NetworkSettings.Networks}}}}')
    row = json.loads(_call(['docker', 'inspect', '--format', template, machine]))
    networks = row['runtime'].pop('networks')
    row['runtime']['ips'] = sorted({x['IPAddress'] for x in networks.values() if x.get('IPAddress')})
    return row


def _processes(root):
    matched, unknown = [], []
    prefix = os.fsencode(str(root) + '/')
    for process in Path('/proc').iterdir():
        if not process.name.isdecimal():
            continue
        try:
            if process.stat().st_uid != os.getuid():
                continue
            for task in (process / 'task').iterdir():
                try:
                    raw = (task / 'stat').read_text(); fields = raw[raw.rfind(')') + 2:].split()
                    # Inspect live peers even when the thread-group leader is a zombie.
                    if fields[0] in ('Z', 'X'):
                        continue
                    cwd = (task / 'cwd').resolve(strict=True)
                    args = (task / 'cmdline').read_bytes().split(b'\0')
                    if cwd == root or root in cwd.parents or any(a == os.fsencode(root) or a.startswith(prefix) for a in args):
                        matched.append({'pid': int(process.name), 'tid': int(task.name), 'birth': fields[19]})
                except (FileNotFoundError, ProcessLookupError):
                    continue
                except (OSError, ValueError, IndexError):
                    unknown.append({'pid': int(process.name), 'tid': int(task.name)})
        except (FileNotFoundError, ProcessLookupError):
            continue
        except OSError:
            unknown.append({'pid': int(process.name)})
    return matched, unknown


def _listeners():
    rows = []
    for name in ('tcp', 'tcp6'):
        for line in Path('/proc/net', name).read_text().splitlines()[1:]:
            row = line.split()
            if row[3] == '0A':
                rows.append({'port': int(row[1].rsplit(':', 1)[1], 16), 'inode': row[9], 'uid': int(row[7])})
    return rows


def _proxy(inode, port):
    need(re.fullmatch(r'[0-9]+', inode) and type(port) is int and 1 <= port <= 65535, 'proxy query')
    return json.loads(_call(['sudo', '-n', sys.executable, '-B', str(Path(__file__).resolve()), '--proxy', inode, str(port)]))


def privileged_proxy(inode, port):
    """Exact listener attribution only; no signals or unfiltered argv/env output."""
    need(os.geteuid() == 0 and re.fullmatch(r'[0-9]+', inode)
         and type(port) is int and 1 <= port <= 65535, 'privileged query')
    output = _call(['ss', '-ltnp', 'sport = :' + str(port)]).decode()
    pids = set(map(int, re.findall(r'pid=([0-9]+)', output)))
    need(len(pids) == 1, 'ambiguous listener owner')
    pid, = pids
    process = Path('/proc', str(pid))
    def identity():
        raw = (process / 'stat').read_text(); fields = raw[raw.rfind(')') + 2:].split()
        need(fields[0] not in ('Z', 'X'), 'dead proxy')
        return fields[19]
    birth = identity()
    need((process / 'exe').resolve(strict=True).name == 'docker-proxy', 'foreign listener executable')
    need(any(os.readlink(fd) == 'socket:[' + inode + ']' for fd in (process / 'fd').iterdir()), 'listener inode not owned')
    args = (process / 'cmdline').read_bytes().split(b'\0'); selected = {}
    for flag in (b'-proto', b'-host-ip', b'-host-port', b'-container-ip', b'-container-port'):
        need(args.count(flag) == 1 and args.index(flag) + 1 < len(args), 'proxy arguments')
        selected[flag.decode()] = args[args.index(flag) + 1].decode()
    need(identity() == birth, 'proxy identity changed')
    return {'pid': pid, 'birth': birth, 'exe': 'docker-proxy', 'inode': inode, 'binding': selected}


def _inventory(root, spec):
    ports = set(spec['ports']); manifests = []
    services = root / '.context/services.json'
    service = None
    if services.exists() or services.is_symlink():
        row = read(services)
        need(row.get('status') == 'stopped' and row.get('worktree') == str(root), 'services remain')
        need(isinstance(row.get('ports'), dict)
             and all(type(p) is int and 0 <= p <= 65535 for p in row['ports'].values()), 'services ports unknown')
        ports.update(p for p in row['ports'].values() if p)
        service = {'sha256': hashlib.sha256(services.read_bytes()).hexdigest(), 'ports': row['ports'],
                   'status': row['status'], 'worktree': row['worktree']}
    for manifest in sorted((root / '.context/test-runs').glob('*/manifest.json')):
        row = read(manifest); url = urlsplit(row.get('base_url', ''))
        need(url.scheme == 'http' and url.hostname in ('localhost', '127.0.0.1', '::1')
             and url.username is None and url.password is None and url.port is not None, 'manifest endpoint unknown')
        ports.add(url.port)
        manifests.append({'path': str(manifest), 'port': url.port,
                          'sha256': hashlib.sha256(manifest.read_bytes()).hexdigest()})
    locks = set(spec['locks'])
    for entry in (root / '.context/test-runs/.port-locks').iterdir():
        need(not entry.is_dir() and not entry.is_symlink()
             and re.fullmatch(r'[0-9]+\.lock', entry.name), 'reservation or unknown port owner remains')
        ports.add(int(entry.stem)); locks.add(str(entry))
    locks.update(str(p) for p in (root / 'back-end/coverage').glob('.run-lock*'))
    return sorted(ports), sorted(locks), service, manifests


def check_observation(row, spec):
    need(set(row) == {'version', 'root', 'source', 'token', 'observed_at', 'observer', 'admission',
                     'matched', 'unknown', 'ports', 'locks', 'services', 'manifests', 'listeners', 'fixture', 'proxy'}, 'audit shape')
    need(row['version'] == VERSION and row['root'] == spec['root'] and row['token'] == spec['token']
         and digest(row['source']) == digest(spec['source']), 'audit identity')
    need(type(row['observed_at']) in (int, float) and math.isfinite(row['observed_at'])
         and spec['finished_at'] <= row['observed_at'] <= time.time(), 'audit time')
    need(digest(row['observer']) == digest({'sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                            'mode': stat.S_IMODE(Path(__file__).stat().st_mode)}), 'audit observer')
    need(row['admission'] == str(Path(spec['root']) / '.context/native-worker-admission.lock')
         and row['matched'] == [] and row['unknown'] == [], 'root/admission observation unknown')
    need(isinstance(row['ports'], list) and all(type(p) is int and 1 <= p <= 65535 for p in row['ports'])
         and len(row['ports']) == len(set(row['ports'])) and set(spec['ports']) <= set(row['ports']), 'port scope')
    need(isinstance(row['locks'], list) and all(set(x) == {'path', 'device', 'inode', 'available'}
         and x['available'] is True and type(x['device']) is int and type(x['inode']) is int
         and x['device'] >= 0 and x['inode'] > 0 for x in row['locks'])
         and len({x['path'] for x in row['locks']}) == len(row['locks'])
         and set(spec['locks']) == {x['path'] for x in row['locks']}, 'lock scope/availability')
    service = row['services']
    need(service is None or isinstance(service, dict) and set(service) == {'sha256', 'ports', 'status', 'worktree'}
         and service['status'] == 'stopped' and service['worktree'] == spec['root']
         and isinstance(service['sha256'], str) and re.fullmatch(r'[0-9a-f]{64}', service['sha256'])
         and isinstance(service['ports'], dict) and all(type(p) is int and 0 <= p <= 65535
         and (not p or p in row['ports']) for p in service['ports'].values()), 'services audit unknown')
    need(isinstance(row['manifests'], list) and all(isinstance(m, dict)
         and set(m) == {'path', 'port', 'sha256'} and type(m['port']) is int and m['port'] in row['ports']
         and isinstance(m['path'], str) and Path(spec['root']) / '.context/test-runs' in Path(m['path']).parents
         and isinstance(m['sha256'], str) and re.fullmatch(r'[0-9a-f]{64}', m['sha256']) for m in row['manifests']),
         'dynamic manifests audit unknown')
    fixture = row['fixture']
    need(set(fixture) == {'snapshot', 'runtime'} and digest(fixture['snapshot']) == digest(spec['fixture']), 'retained fixture changed')
    runtime = fixture['runtime']
    need(set(runtime) == {'pid', 'started_at', 'ips'} and type(runtime['pid']) is int
         and isinstance(runtime['ips'], list) and all(isinstance(ip, str) for ip in runtime['ips']), 'fixture runtime')
    need(isinstance(runtime['started_at'], str), 'fixture start time unknown')
    started = datetime.datetime.fromisoformat(runtime['started_at'].replace('Z', '+00:00')).timestamp()
    need(0 < started <= spec['started_at'], 'fixture was restarted during/after native run')
    active = spec['fixture']['running']; expected_port = spec['fixture_port']
    need(type(active) is bool, 'fixture running type')
    if active:
        need(runtime['pid'] > 1 and len(row['listeners']) == 1, 'retained fixture listener unknown')
        listener, = row['listeners']; proxy = row['proxy']
        need(set(listener) == {'port', 'inode', 'uid'} and type(listener['port']) is int
             and listener['port'] == expected_port and type(listener['uid']) is int and listener['uid'] == 0
             and isinstance(listener['inode'], str) and listener['inode'].isdigit(), 'foreign listener')
        need(isinstance(proxy, dict) and set(proxy) == {'pid', 'birth', 'exe', 'inode', 'binding'}
             and type(proxy['pid']) is int and proxy['pid'] > 1 and isinstance(proxy['birth'], str)
             and re.fullmatch(r'[1-9][0-9]*', proxy['birth']) and proxy['exe'] == 'docker-proxy'
             and proxy['inode'] == listener['inode'], 'proxy identity unknown')
        binding = proxy['binding']
        need(set(binding) == {'-proto', '-host-ip', '-host-port', '-container-ip', '-container-port'}
             and binding['-proto'] == 'tcp' and binding['-host-ip'] == '127.0.0.1'
             and binding['-host-port'] == str(expected_port) and binding['-container-port'] == '5432'
             and binding['-container-ip'] in runtime['ips'], 'proxy does not belong to retained fixture')
    else:
        need(runtime['pid'] == 0 and row['listeners'] == [] and row['proxy'] is None, 'exited fixture has listener')


def observe(spec):
    """Fresh locks/processes/listeners/Docker audit; no resource mutation and no file writes."""
    root = Path(spec['root']); need(root.resolve(strict=True) == root, 'root identity')
    with ExitStack() as held:
        admission = root / '.context/native-worker-admission.lock'; physical(admission)
        fd = held.enter_context(admission.open('r')); fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        ports, paths, service, manifests = _inventory(root, spec)
        locks = []
        for path in paths:
            physical(path); lock = held.enter_context(Path(path).open('r'))
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB); info = os.fstat(lock.fileno())
            locks.append({'path': path, 'device': info.st_dev, 'inode': info.st_ino, 'available': True})
        matched, unknown = _processes(root)
        listeners = [row for row in _listeners() if row['port'] in ports]
        fixture = _docker(spec['fixture']['id'])
        proxy = _proxy(listeners[0]['inode'], listeners[0]['port']) if len(listeners) == 1 and spec['fixture']['running'] else None
        row = {'version': VERSION, 'root': str(root), 'source': spec['source'], 'token': spec['token'],
               'observed_at': time.time(), 'observer': {'sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               'mode': stat.S_IMODE(Path(__file__).stat().st_mode)}, 'admission': str(admission),
               'matched': matched, 'unknown': unknown, 'ports': ports, 'locks': locks, 'services': service,
               'manifests': manifests, 'listeners': listeners, 'fixture': fixture, 'proxy': proxy}
        check_observation(row, spec)
        return row


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--proxy':
        print(json.dumps(privileged_proxy(sys.argv[2], int(sys.argv[3]))))
    elif len(sys.argv) == 3 and sys.argv[1] == '--spec':
        print(json.dumps(observe(read(Path(sys.argv[2]).resolve()))))
    else:
        raise SystemExit('usage: --spec private-spec.json | --proxy inode port (read-only sudo)')
