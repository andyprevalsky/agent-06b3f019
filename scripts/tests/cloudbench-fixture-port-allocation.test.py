#!/usr/bin/env python3
"""Native-process contract for the multi-workstream fixture's actual allocator."""
import fcntl
import hashlib
import json
from contextlib import contextmanager
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
SOURCE = (ROOT / 'scripts/tests/cloudbench-multi-workstream.test.sh').read_text()
START = SOURCE.index('# The fleet derives its hub port')
END = SOURCE.index('# ═', START)
ALLOCATOR = SOURCE[START:END]
PROBE_START = SOURCE.index('test_tcp_listener_absent() {')
PROBE_END = SOURCE.index('\n}\n', PROBE_START) + 3
PROBE = SOURCE[PROBE_START:PROBE_END]
OWNED_CHILDREN = []


def supervised_process(command, env, temporary):
    owner = Path(temporary) / ('allocator-' + uuid.uuid4().hex + '.json')
    child = subprocess.Popen(
        [sys.executable, str(ROOT / 'scripts/cloudbench-local-supervisor.py'),
         '--receipt', str(owner), '--', *command],
        env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    child.owner_receipt = owner
    OWNED_CHILDREN.append(child)
    return child


def launch(tmp, fixture, policy=None, claim_root=None):
    script = '''set -uo pipefail
source "$ROOT/scripts/lib/cloudbench-env.sh"
fail() { echo "$*" >&2; exit 1; }
PORT_CLAIM_DIR=""
'''
    if policy is not None:
        script += '''cat() {
  if [ "$1" = /proc/sys/net/ipv4/ip_local_port_range ]; then
    printf '%s\\n' "$TEST_POLICY"
  else command cat "$@"; fi
}
'''
    allocator = ALLOCATOR
    if claim_root is not None:
        original = 'PORT_CLAIM_ROOT="/tmp/cloudbench-multi-workstream-port-claims-$(id -u)"'
        assert allocator.count(original) == 1
        allocator = allocator.replace(original, f'PORT_CLAIM_ROOT="{claim_root}"')
    script += PROBE + '\n' + allocator + '''
printf '%s:%s:%s\\n' "$HUB_PORT_A" "$HUB_PORT_B" "$PORT_CLAIM_DIR"
read -r release
rm -f "$PORT_CLAIM_DIR/owner"
'''
    env = dict(os.environ, ROOT=str(ROOT), TMPDIR=str(tmp), TMP_ROOT=str(fixture), TEST_POLICY=policy or '')
    return supervised_process(['bash', '-c', script], env, tmp)


def receipt(child):
    # Bound native children; no open-ended waits, including a broken allocator.
    import select
    deadline = time.monotonic() + 10
    data = bytearray()
    while b'\n' not in data:
        remaining = max(0, deadline - time.monotonic())
        assert select.select([child.stdout], [], [], remaining)[0], 'allocator did not publish within 10 seconds'
        chunk = os.read(child.stdout.fileno(), 4096)
        assert chunk, 'allocator exited without publishing a lease'
        data.extend(chunk)
    line = data.split(b'\n', 1)[0].decode().strip()
    assert line, 'allocator exited without publishing a lease'
    a, b, claim = line.split(':')
    return int(a), int(b), claim


def retire(child):
    timed_out = False
    try:
        # EOF releases the fixture read loop and is safe even when a prior
        # communicate call already started before timing out.
        child.communicate(timeout=10)
    except subprocess.TimeoutExpired:
        timed_out = True
        # Signal only our subreaper. Its existing bounded drain owns every
        # descendant, including processes that created another session.
        child.terminate()
        child.communicate(timeout=10)
    result = json.loads(child.owner_receipt.read_text())
    assert result['quiescent'] and not result['remaining'] and result['error'] is None, result
    if timed_out:
        raise AssertionError('allocator retirement timed out; exact owned tree was drained')


def retire_all(children):
    primary = sys.exc_info()[1]
    failures = []
    for child in children:
        try:
            retire(child)
        except BaseException as error:
            failures.append(error)
    if failures:
        details = 'allocator retire failures: ' + '; '.join(str(error) for error in failures)
        if primary is not None:
            primary.add_note(details)
        else:
            raise AssertionError(details) from failures[0]


@contextmanager
def owned_temporary_directory():
    with tempfile.TemporaryDirectory(prefix='cloudbench-port-contract-') as directory:
        try:
            yield directory
        finally:
            try:
                retire_all(OWNED_CHILDREN)
            finally:
                OWNED_CHILDREN.clear()


def paired_roots(root):
    result = []
    for label in ('a', 'b'):
        tmp = root / label
        tmp.mkdir()
        for n in range(10000):
            fixture = tmp / str(n)
            if int.from_bytes(hashlib.sha256(str(fixture).encode()).digest()[:4], 'big') % 200 == 0:
                fixture.mkdir()
                result.append((tmp, fixture))
                break
        else:
            raise AssertionError('could not construct matching native allocator slots')
    return result


def main():
    children = []
    sockets = []
    with owned_temporary_directory() as directory:
        root = Path(directory)
        try:
            roots = paired_roots(root)
            for tmp, fixture in roots:
                children.append(launch(tmp, fixture))
            rows = [receipt(child) for child in children]
            # Both allocators have probed before either server binds, exactly the
            # lease-to-bind gap. Real sockets expose duplicate ownership.
            for a, b, claim in rows:
                for port in (a, b, a + 20, a + 21):
                    listener = socket.socket()
                    sockets.append(listener)
                    # Like the fixture's real servers, ignore an earlier connection's TIME_WAIT (a previous
                    # consecutive run); a second live listener on the same port still fails to bind.
                    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    try:
                        listener.bind(('127.0.0.1', port))
                        listener.listen()
                    except OSError as error:
                        raise AssertionError(f'two private TMPDIRs admitted overlapping native leases: {rows}; {error}') from error
            assert Path(rows[0][2]).parent == Path(rows[1][2]).parent, rows
            low, high = map(int, Path('/proc/sys/net/ipv4/ip_local_port_range').read_text().split())
            assert all(not low <= port <= high for a, b, _ in rows for port in (a, b, a + 20, a + 21)), rows
            print('PASS: two private TMPDIRs hold disjoint native leases outside the kernel ephemeral range')
        finally:
            for listener in sockets:
                listener.close()
            retire_all(children)
        # A terminated native owner cannot strand a lease or require PID-based
        # deletion of a lock inode. Reuse is safe once its descriptor is closed.
        private_claims = root / 'retirement-claims'
        child = launch(*roots[0], claim_root=private_claims)
        first = receipt(child)
        child.terminate()
        child.communicate(timeout=10)
        with (Path(first[2]) / 'lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        replacement = launch(*roots[0], claim_root=private_claims)
        try:
            receipt(replacement)
        finally:
            retire(replacement)
        print('PASS: terminated owner releases its lock without removing its inode')
        # A real non-fixture listener still owns its port even without a lease.
        reservation = launch(*roots[0])
        reserved = receipt(reservation)
        blocker = socket.socket()
        try:
            blocker.bind(('127.0.0.1', reserved[0]))
            blocker.listen()
        finally:
            retire(reservation)
        occupied = launch(*roots[0])
        try:
            assert receipt(occupied)[0] != reserved[0]
        finally:
            retire(occupied)
            blocker.close()
        print('PASS: an existing native listener is preserved and its window skipped')
        child = launch(*roots[0], policy='10000 10010')
        try:
            a, b, _ = receipt(child)
            assert a > 10010 and b > 10010, (a, b)
        finally:
            retire(child)
        print('PASS: allocator skips candidate windows overlapping a different kernel range')
        for policy in ('1024 65535', 'unreadable', '60999 32768', '0 65535'):
            tmp = root / ('refusal-' + policy.split()[0])
            tmp.mkdir()
            child = launch(tmp, tmp, policy)
            out, err = child.communicate(timeout=10)
            assert child.returncode != 0 and not out, (policy, child.returncode, out, err)
            print('PASS: allocator refuses exhausted or malformed ephemeral policy:', policy)
        # Substitute only the namespace path, preserving actual initialization,
        # lstat ownership/mode checks and refusal behavior. Never damage a live
        # common namespace merely to construct a negative control.
        unsafe = root / 'unsafe'
        unsafe.mkdir(mode=0o777)
        unsafe.chmod(0o777)
        linked = root / 'linked'
        linked.symlink_to(unsafe, target_is_directory=True)
        for namespace in (unsafe, linked):
            child = launch(*roots[0], claim_root=namespace)
            out, err = child.communicate(timeout=10)
            assert child.returncode != 0 and not out, (out, err)
            assert 'unsafe cross-workspace port claim directory' in err, err
        assert unsafe.stat().st_mode & 0o777 == 0o777
        assert linked.is_symlink()
        print('PASS: unsafe or symlinked namespaces are refused and preserved')
    print('PASS: fixture allocation contract')


if __name__ == '__main__':
    main()
