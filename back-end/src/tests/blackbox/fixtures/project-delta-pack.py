"""Build a compact, deterministic Git delta DAG; no network or production data.

Scale the captured 96 MiB-cache / ~100 MiB-base pressure by 96, retaining
its ratio, then repeat branch points so reconstruction has a measurable cost.
The candidate's normal cache holds this bounded fixture without thrashing.
"""
import hashlib, struct, zlib, pathlib, subprocess, json, resource, random
import sys, os, signal
import threading

_active_child = None
_spawn_lock = threading.Lock()
_parent_pid = int(os.environ['ROSE_MEASURE_PARENT_PID'])
_TERMINATION_SIGNALS = {signal.SIGTERM, signal.SIGINT}
_PARENT_CHECK_SECONDS = 0.1


def terminate_owned(_signum, _frame):
    if _active_child is not None:
        try:
            os.killpg(_active_child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    raise SystemExit(143)


signal.signal(signal.SIGTERM, terminate_owned)
signal.signal(signal.SIGINT, terminate_owned)
if os.getppid() != _parent_pid:
    raise SystemExit(143)


def watch_parent():
    wake = threading.Event()
    while not wake.wait(_PARENT_CHECK_SECONDS):
        if os.getppid() != _parent_pid:
            with _spawn_lock:
                signal.pthread_kill(threading.main_thread().ident, signal.SIGTERM)
            return


# The watcher inherits the blocked mask, leaving only the main thread eligible
# for external termination signals. Spawn/registration can then block them atomically.
_initial_mask = signal.pthread_sigmask(signal.SIG_BLOCK, _TERMINATION_SIGNALS)
threading.Thread(target=watch_parent, daemon=True).start()
signal.pthread_sigmask(signal.SIG_SETMASK, _initial_mask)


def owned_run(args, *, input=None, capture_output=False, check=False, timeout=None):
    global _active_child
    child = None
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, _TERMINATION_SIGNALS)
    try:
        with _spawn_lock:
            # Reset the inherited mask in a fresh interpreter, avoiding a
            # Python preexec_fn in this multithreaded parent.
            unblock_and_exec = (
                'import os,signal,sys; '
                'signal.pthread_sigmask(signal.SIG_UNBLOCK,{signal.SIGTERM,signal.SIGINT}); '
                'os.execvp(sys.argv[1],sys.argv[1:])'
            )
            child = subprocess.Popen(
                [sys.executable, '-c', unblock_and_exec, *args],
                stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
                stdout=subprocess.PIPE if capture_output else None,
                stderr=subprocess.PIPE if capture_output else None,
                start_new_session=True,
            )
            _active_child = child
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        stdout, stderr = child.communicate(input=input, timeout=timeout)
        result = subprocess.CompletedProcess(args, child.returncode, stdout, stderr)
        if check:
            result.check_returncode()
        return result
    finally:
        signal.pthread_sigmask(signal.SIG_BLOCK, _TERMINATION_SIGNALS)
        if child is not None:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        _active_child = None
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)


if sys.argv[1] == 'measure':
    os.chdir(sys.argv[3])
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    result = owned_run(['bash', '-c', sys.argv[2]], capture_output=True,
                       timeout=int(sys.argv[4]) / 1000)
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    print(json.dumps({
        'exitCode': result.returncode, 'stdout': result.stdout.decode(),
        'stderr': result.stderr.decode(), 'timedOut': False,
        'cpu': after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime,
    }))
    sys.exit(0)
root = pathlib.Path(__import__('sys').argv[1])
bare = root / 'remote.git'
owned_run(['git', 'init', '--object-format=sha1', '--bare', '-q', str(bare)], check=True)
# Hold the local upload-pack server constant; only the session client's cache differs.
owned_run(['git', '-C', str(bare), 'config', 'core.deltaBaseCacheLimit', '512m'], check=True)
entries = []
oids = []
size = 1092266
n = 4097
rng = random.Random(0)
prefix = b''.join((json.dumps({'agent': rng.getrandbits(128), 'duration': rng.randrange(1000000), 'call': 'model', 'span': rng.getrandbits(64)}, separators=(',', ':')).encode() + b'\n' for _ in range(size // 90 + 1)))[:size - 32]
assert len(prefix) == size - 32

def oid(kind, data):
    return hashlib.sha1(kind + b' ' + str(len(data)).encode() + b'\x00' + data).digest()

def header(kind, n):
    out = bytearray([kind << 4 | n & 15])
    n >>= 4
    while n:
        out[-1] |= 128
        out.append(n & 127)
        n >>= 7
    return bytes(out)

def varint(n):
    out = bytearray()
    while n >= 128:
        out.append(n & 127 | 128)
        n >>= 7
    out.append(n)
    return bytes(out)

def add(kind, data, base=None):
    if base is None:
        entries.append(header(kind, len(data)) + zlib.compress(data, 1))
    else:
        entries.append(header(7, len(data)) + base + zlib.compress(data, 1))
last = None
for i in range(n):
    tail = f'{i:032d}'.encode()
    data = prefix + tail
    bh = oid(b'blob', data)
    oids.append(bh)
    if i == 0:
        add(3, data)
    else:
        parent = max(0, (i - 1) // 4 * 4 - 3)
        copylen = len(prefix)
        op = bytearray()
        offset = 0
        while offset < copylen:
            length = min(16777215, copylen - offset)
            command = 128
            operands = bytearray()
            for k in range(4):
                value = offset >> 8 * k & 255
                if value:
                    command |= 1 << k
                    operands.append(value)
            for k in range(3):
                value = length >> 8 * k & 255
                if value:
                    command |= 1 << 4 + k
                    operands.append(value)
            op.append(command)
            op.extend(operands)
            offset += length
        delta = varint(size) + varint(size) + op + bytes([32]) + tail
        add(3, delta, oids[parent])
    tree = b'100644 data\x00' + bh
    th = oid(b'tree', tree)
    add(2, tree)
    commit = b'tree ' + th.hex().encode() + b'\n' + (b'parent ' + last.hex().encode() + b'\n' if last else b'') + b'author Fixture <fixture@example.com> 1 +0000\ncommitter Fixture <fixture@example.com> 1 +0000\n\nfixture\n'
    ch = oid(b'commit', commit)
    add(1, commit)
    last = ch
pack = b'PACK' + struct.pack('>II', 2, len(entries)) + b''.join(entries)
pack += hashlib.sha1(pack).digest()
p = root / 'fixture.pack'
p.write_bytes(pack)
r = owned_run(['git', '-c', 'core.deltaBaseCacheLimit=512m', '-C', str(bare), 'index-pack', '--stdin'], input=pack, capture_output=True)
assert r.returncode == 0, r.stderr
owned_run(['git', '-C', str(bare), 'update-ref', 'refs/heads/main', last.hex()], check=True)
owned_run(['git', '-C', str(bare), 'symbolic-ref', 'HEAD', 'refs/heads/main'], check=True)
owned_run(['git', '-C', str(bare), 'config', 'pack.depth', '4096'], check=True)
print(json.dumps({'remote': str(bare), 'count': n, 'size': size}), flush=True)
owned_run(['git', '-C', str(bare), 'update-ref', 'refs/heads/other', 'main~10'], check=True)
