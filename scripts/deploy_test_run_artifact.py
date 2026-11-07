"""Bounded regular-FD verification of native run JSON; never rewrite evidence.

Default raw accepted bytes: existing MAX_RECEIPT_BYTES (64MiB). Metadata wire
bytes INCLUDING whitespace/structure, materialized values and each scalar are
independently bounded by the caller's existing receipt limit. Fixed64KiB I/O;
no mmap, readall, temporary artifact or implicit larger forensic allowance.
"""
import codecs
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
from deploy_test_process import CANCEL
from deploy_test_result import MAX_RECEIPT_BYTES

BUFFER_BYTES = 65536
_NUMBER = re.compile(rb'(?:-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null|NaN|-?Infinity)')
_SPECIAL = re.compile(rb'["\\\x00-\x1f]')
_SPACE = re.compile(rb'[ \r\n\t]+')


def checkpoint(deadline=None):
    if CANCEL.is_set():
        raise ValueError('native artifact: cancelled')
    if deadline is not None and time.monotonic() >= deadline:
        raise ValueError('native artifact: caller deadline exhausted')


def identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


class ForensicValue:
    """Present, validated forensic subtree; never parsed cleanup authority."""
    def __init__(self, start, end):
        self.start, self.end = start, end


class _FD:
    def __init__(self, fd, size, limit, deadline):
        self.fd, self.size, self.limit, self.deadline = fd, size, limit, deadline
        self.pos, self.buffer, self.offset = 0, b'', 0
        self.digest = hashlib.sha256()
        self.charged, self.metadata = True, 0
        self.last_check = 0

    def peek(self):
        if self.pos - self.last_check >= BUFFER_BYTES:
            checkpoint(self.deadline)
            self.last_check = self.pos
        if self.offset == len(self.buffer):
            checkpoint(self.deadline)
            if self.pos == self.size:
                return None
            wanted = min(BUFFER_BYTES, self.size - self.pos)
            self.buffer = os.read(self.fd, wanted)
            self.offset = 0
            if len(self.buffer) != wanted:
                raise ValueError('native artifact: short read or truncation')
            self.digest.update(self.buffer)
        return self.buffer[self.offset]

    def take(self, count=1):
        if count < 0 or self.peek() is None or self.offset + count > len(self.buffer):
            raise ValueError('native artifact: incomplete token')
        if self.charged:
            self.metadata += count
            if self.metadata > self.limit:
                raise ValueError('native artifact: metadata document byte bound exceeded')
        data = self.buffer[self.offset:self.offset + count]
        self.offset += count
        self.pos += count
        return data


class _Reader:
    def __init__(self, source, limit):
        self.source, self.limit, self.materialized = source, limit, 0

    def memory(self, value):
        self.materialized += sys.getsizeof(value)
        if self.materialized > self.limit:
            raise ValueError('native artifact: materialization bound exceeded')
        return value

    def growth(self, count):
        self.materialized += max(count, 0)
        if self.materialized > self.limit:
            raise ValueError('native artifact: materialization bound exceeded')

    def space(self):
        while self.source.peek() in (32, 13, 10, 9):
            match = _SPACE.match(self.source.buffer, self.source.offset)
            self.source.take(match.end() - self.source.offset)

    def string(self, retain):
        s = self.source
        start = s.pos
        parts = bytearray() if retain else None
        decoder = codecs.getincrementaldecoder('utf-8')()
        def consume(count):
            raw = s.take(count)
            decoder.decode(raw)
            if parts is not None:
                parts.extend(raw)
            if s.pos - start > self.limit:
                raise ValueError('native artifact: scalar byte bound exceeded')
        consume(1)
        while True:
            if s.peek() is None:
                raise ValueError('native artifact: unterminated string')
            match = _SPECIAL.search(s.buffer, s.offset)
            end = match.start() if match else len(s.buffer)
            if end > s.offset:
                consume(end - s.offset)
                continue
            ch = s.peek()
            if ch == 34:
                consume(1)
                break
            if ch < 32:
                raise ValueError('native artifact: string control byte')
            consume(1)
            escape = s.peek()
            if escape is None:
                raise ValueError('native artifact: unfinished escape')
            consume(1)
            if escape == 117:
                for _ in range(4):
                    digit = s.peek()
                    if digit is None or digit not in b'0123456789abcdefABCDEF':
                        raise ValueError('native artifact: invalid unicode escape')
                    consume(1)
            elif escape not in b'"\\/bfnrt':
                raise ValueError('native artifact: invalid string escape')
        decoder.decode(b'', final=True)
        if retain:
            checkpoint(s.deadline)
            return self.memory(json.loads(parts))
        return None

    @staticmethod
    def forensic(path):
        return (len(path) == 3 and path[0] == 'tasks' and type(path[1]) is int and path[2] == 'logs'
                or len(path) == 5 and path[0] == 'tasks' and type(path[1]) is int
                and path[2] == 'owned_roots' and type(path[3]) is int and path[4] == 'logs')

    def value(self, path, retain, depth):
        if depth > 128:
            raise ValueError('native artifact: excessive JSON depth')
        s = self.source
        self.space()  # Whitespace before a forensic value is ordinary metadata.
        start = s.pos
        old_charge = s.charged
        opaque = retain and self.forensic(path)
        keep = retain and not opaque
        if opaque:
            s.charged = False
        try:
            ch = s.peek()
            if ch is None:
                raise ValueError('native artifact: missing value')
            result = None
            if ch == 34:
                result = self.string(keep)
            elif ch in (123, 91):
                obj, close = ch == 123, 125 if ch == 123 else 93
                s.take()
                result = self.memory({} if obj else []) if keep else None
                transient_mark = None if keep else self.materialized
                keys, index = set(), 0
                self.space()
                if s.peek() == close:
                    s.take()
                else:
                    while True:
                        self.space()
                        if obj:
                            if s.peek() != 34:
                                raise ValueError('native artifact: object key required')
                            key = self.string(True)
                            if key in keys:
                                raise ValueError('native artifact: duplicate object key')
                            before = sys.getsizeof(keys)
                            keys.add(key)
                            self.growth(sys.getsizeof(keys) - before)
                            self.space()
                            if s.peek() != 58:
                                raise ValueError('native artifact: missing colon')
                            s.take()
                        else:
                            key = index
                        child = self.value(path + (key,), keep, depth + 1)
                        if keep:
                            before = sys.getsizeof(result)
                            if obj:
                                result[key] = child
                            else:
                                result.append(child)
                            self.growth(sys.getsizeof(result) - before)
                        index += 1
                        self.space()
                        separator = s.peek()
                        if separator == close:
                            s.take()
                            break
                        if separator != 44:
                            raise ValueError('native artifact: missing comma')
                        s.take()
                if transient_mark is not None:
                    # Closed opaque containers retain neither values nor duplicate keys.
                    # Restore only their charges, keeping all still-open ancestors charged.
                    self.materialized = transient_mark
            else:
                token = bytearray()
                while s.peek() is not None and s.peek() not in b' \r\n\t,]}':
                    token.extend(s.take())
                    if len(token) > self.limit:
                        raise ValueError('native artifact: scalar byte bound exceeded')
                if not _NUMBER.fullmatch(token):
                    raise ValueError('native artifact: invalid scalar')
                checkpoint(s.deadline)
                scalar = json.loads(token)  # Preserve Python's numeric security guards.
                if keep:
                    result = self.memory(scalar)
            return self.memory(ForensicValue(start, s.pos)) if opaque else result
        finally:
            s.charged = old_charge


def read_run_artifact(path, expected_sha256, limit, *, raw_limit=None, deadline=None, raw_remaining=None):
    """Higher raw_limit is explicit and caller-bound; the generic default stays unchanged."""
    checkpoint(deadline)
    raw_limit = MAX_RECEIPT_BYTES if raw_limit is None else raw_limit
    if type(raw_limit) is not int or raw_limit <= 0 or type(limit) is not int or limit <= 0:
        raise ValueError('native artifact: invalid byte contract')
    path = Path(path)
    if not path.is_absolute() or path.resolve(strict=True) != path or path.is_symlink():
        raise ValueError('native artifact: canonical regular file required')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            raise ValueError('native artifact: regular fd required')
        if not 0 < before.st_size <= raw_limit:
            raise ValueError('native artifact: raw file byte bound exceeded')
        if raw_remaining is not None:
            if (not isinstance(raw_remaining, list) or len(raw_remaining) != 1
                    or type(raw_remaining[0]) is not int
                    or not 0 <= raw_remaining[0] <= raw_limit
                    or before.st_size > raw_remaining[0]):
                raise ValueError('native artifact: aggregate raw admission bound exceeded')
            raw_remaining[0] -= before.st_size  # Charge the verified FD, not a racy path stat.
        first = hashlib.sha256()
        remaining = before.st_size
        while remaining:
            checkpoint(deadline)
            block = os.read(fd, min(BUFFER_BYTES, remaining))
            if not block:
                raise ValueError('native artifact: short hash read or truncation')
            remaining -= len(block)
            first.update(block)
        if first.hexdigest() != expected_sha256 or identity(os.fstat(fd)) != identity(before):
            raise ValueError('native artifact: original hash or identity changed')
        os.lseek(fd, 0, os.SEEK_SET)
        stream = _FD(fd, before.st_size, limit, deadline)
        reader = _Reader(stream, limit)
        value = reader.value((), True, 0)
        reader.space()
        if stream.peek() is not None or not isinstance(value, dict):
            raise ValueError('native artifact: exact JSON object required')
        checkpoint(deadline)
        current = path.stat(follow_symlinks=False)
        if (stream.digest.hexdigest() != expected_sha256
                or identity(os.fstat(fd)) != identity(before) or identity(current) != identity(before)
                or path.resolve(strict=True) != path or path.is_symlink()):
            raise ValueError('native artifact: original changed during validation')
        return value
    finally:
        os.close(fd)
