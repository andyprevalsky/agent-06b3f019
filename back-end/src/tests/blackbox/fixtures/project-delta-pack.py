"""Build a compact, deterministic Git delta DAG; no network or production data.

Scale the captured 96 MiB-cache / ~100 MiB-base pressure by 96, retaining
its ratio, then repeat branch points so reconstruction has a measurable cost.
The candidate's normal cache holds this bounded fixture without thrashing.
"""
import hashlib, struct, zlib, pathlib, subprocess, json, resource, random
import sys, os, signal
if sys.argv[1] == 'measure':
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    child = subprocess.Popen(['bash', '-c', sys.argv[2]], cwd=sys.argv[3], stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    timed_out = False
    try:
        stdout, stderr = child.communicate(timeout=int(sys.argv[4]) / 1000)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(child.pid, signal.SIGKILL)
        stdout, stderr = child.communicate()
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    print(json.dumps({'exitCode': child.returncode, 'stdout': stdout.decode(), 'stderr': stderr.decode(), 'timedOut': timed_out, 'cpu': after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime}))
    sys.exit(0)
root = pathlib.Path(__import__('sys').argv[1])
bare = root / 'remote.git'
subprocess.run(['git', 'init', '--object-format=sha1', '--bare', '-q', str(bare)], check=True)
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
r = subprocess.run(['git', '-c', 'core.deltaBaseCacheLimit=512m', '-C', str(bare), 'index-pack', '--stdin'], input=pack, capture_output=True)
assert r.returncode == 0, r.stderr
subprocess.run(['git', '-C', str(bare), 'update-ref', 'refs/heads/main', last.hex()], check=True)
subprocess.run(['git', '-C', str(bare), 'symbolic-ref', 'HEAD', 'refs/heads/main'], check=True)
subprocess.run(['git', '-C', str(bare), 'config', 'pack.depth', '4096'], check=True)
print(json.dumps({'remote': str(bare), 'count': n, 'size': size}), flush=True)
subprocess.run(['git', '-C', str(bare), 'update-ref', 'refs/heads/other', 'main~10'], check=True)
