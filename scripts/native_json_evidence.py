"""Validate and hash a native JSON object without materializing its log payloads."""
import hashlib
import os
from pathlib import Path
import re
import stat

_STRING_SPECIAL = re.compile(r'["\\\x00-\x1f]')
_NUMBER = re.compile(r'-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?\Z')


class _Parser:
    def __init__(self, stream):
        self.stream, self.buffer, self.offset = stream, '', 0

    def peek(self):
        if self.offset == len(self.buffer):
            self.buffer, self.offset = self.stream.read(65536), 0
        return self.buffer[self.offset:self.offset + 1]

    def take(self):
        char = self.peek()
        if char:
            self.offset += 1
        return char

    def whitespace(self):
        while self.peek() and self.peek() in ' \t\r\n':
            self.offset += 1

    def expect(self, char):
        if self.take() != char:
            raise ValueError('invalid native JSON punctuation')

    def string(self):
        self.expect('"')
        while self.peek():
            match = _STRING_SPECIAL.search(self.buffer, self.offset)
            if not match:
                self.offset = len(self.buffer)
                continue
            self.offset = match.start()
            char = self.take()
            if char == '"':
                return
            if char != '\\':
                raise ValueError('invalid native JSON string')
            escaped = self.take()
            if escaped == 'u':
                for _ in range(4):
                    digit = self.take()
                    if not digit or digit not in '0123456789abcdefABCDEF':
                        raise ValueError('invalid native JSON Unicode escape')
            elif not escaped or escaped not in '"\\/bfnrt':
                raise ValueError('invalid native JSON escape')
        raise ValueError('unterminated native JSON string')

    def value(self, depth=0):
        if depth > 256:
            raise ValueError('native JSON nesting exceeds 256')
        self.whitespace()
        char = self.peek()
        if char == '"':
            self.string()
        elif char in ('{', '['):
            self.take()
            end = '}' if char == '{' else ']'
            self.whitespace()
            if self.peek() == end:
                self.take()
                return
            while True:
                if char == '{':
                    self.whitespace()
                    self.string()
                    self.whitespace()
                    self.expect(':')
                self.value(depth + 1)
                self.whitespace()
                next_char = self.take()
                if next_char == end:
                    return
                if next_char != ',':
                    raise ValueError('invalid native JSON container')
        else:
            token = ''
            while self.peek() and self.peek() not in ' \t\r\n,]}':
                token += self.take()
                if len(token) > 4300:
                    raise ValueError('native JSON scalar exceeds 4300 characters')
            if token not in ('true', 'false', 'null', 'NaN', 'Infinity', '-Infinity') and not _NUMBER.fullmatch(token):
                raise ValueError('invalid native JSON scalar')


def verify_native_object(path, expected_sha256):
    path = Path(path)
    if not path.is_absolute() or path.resolve() != path or path.is_symlink():
        raise ValueError('noncanonical native JSON file')
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as raw:
        before = os.fstat(raw.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ValueError('native JSON is not a regular file')
        digest = hashlib.sha256()
        for chunk in iter(lambda: raw.read(65536), b''):
            digest.update(chunk)
        if digest.hexdigest() != expected_sha256:
            raise ValueError('native JSON hash mismatch')
        raw.seek(0)
        import io
        text = io.TextIOWrapper(raw, encoding='utf-8', errors='strict')
        parser = _Parser(text)
        parser.whitespace()
        if parser.peek() != '{':
            raise ValueError('native JSON must be an object')
        parser.value()
        parser.whitespace()
        if parser.peek():
            raise ValueError('native JSON has trailing data')
        after = os.fstat(raw.fileno())
        signature = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        if (path.is_symlink() or path.resolve() != path or signature(before) != signature(after)
                or signature(after) != signature(path.stat())):
            raise ValueError('native JSON changed during validation')
