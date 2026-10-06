#!/usr/bin/env python3
"""Lossless, checksum-bound transport for controller-injected guest files."""

import base64
import gzip
import hashlib
import json
import os
import re
import sys
import tempfile
import zlib
from pathlib import Path


def valid_name(name):
    return isinstance(name, str) and re.fullmatch(r"cloudbench[-_][a-zA-Z0-9_.-]+", name) and name not in {
        "cloudbench-boot.sh", "cloudbench-boot-payload.py",
        "cloudbench-boot-payload.json.gz", "cloudbench-status-server.py",
    }


def pack(destination, pairs):
    files = {}
    for pair in pairs:
        if pair == "--file-local":
            continue
        guest, local = pair.split("=", 1)
        name = guest.removeprefix("/")
        if guest != "/" + name or not valid_name(name) or name in files:
            raise ValueError("invalid or duplicate boot payload destination")
        data = Path(local).read_bytes()
        if not data:
            raise ValueError("empty controller-injected boot payload file")
        files[name] = base64.b64encode(data).decode("ascii")
    if not files:
        raise ValueError("empty boot payload")
    raw = json.dumps({"version": 1, "files": files}, sort_keys=True, separators=(",", ":")).encode()
    compressed = gzip.compress(raw, compresslevel=9, mtime=0)
    Path(destination).write_bytes(compressed)
    return hashlib.sha256(compressed).hexdigest()


def unpack(source, expected, directory):
    raw = Path(source).read_bytes()
    if not re.fullmatch(r"[0-9a-f]{64}", expected) or hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError("boot payload checksum mismatch")
    payload = json.loads(gzip.decompress(raw))
    if not isinstance(payload, dict) or set(payload) != {"version", "files"} or payload["version"] != 1:
        raise ValueError("invalid boot payload schema")
    files = payload["files"]
    if not isinstance(files, dict) or not files:
        raise ValueError("empty or invalid boot payload files")
    decoded = {}
    # Validate the entire envelope before replacing any injected helper. Never
    # extract archive paths, links, permissions, or a payload-supplied entrypoint.
    for name, content in files.items():
        if not valid_name(name) or not isinstance(content, str):
            raise ValueError("invalid boot payload entry")
        data = base64.b64decode(content, validate=True)
        if not data:
            raise ValueError("empty boot payload entry")
        decoded[name] = data
    destination = Path(directory)
    for name, data in decoded.items():
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=destination, prefix=".cloudbench-payload-", delete=False) as handle:
                temporary = Path(handle.name)
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
                # Drivers drop privileges to rose and retain these root-owned
                # script paths. Match flyctl --file-local's readable file mode.
                os.fchmod(handle.fileno(), 0o644)
            os.replace(temporary, destination / name)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        if len(sys.argv) >= 4 and sys.argv[1] == "pack":
            print(pack(sys.argv[2], sys.argv[3:]))
        elif len(sys.argv) == 5 and sys.argv[1] == "unpack":
            unpack(*sys.argv[2:])
        else:
            raise ValueError("usage: pack <output> <file-local pairs> | unpack <input> <sha256> <directory>")
    except (OSError, ValueError, TypeError, EOFError, zlib.error):
        # Input bytes may contain arbitrary files; errors must not echo them.
        print("FATAL: invalid, corrupt, or unwritable controller boot payload", file=sys.stderr)
        sys.exit(1)
