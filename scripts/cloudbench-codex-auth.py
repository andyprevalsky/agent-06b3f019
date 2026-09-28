#!/usr/bin/env python3
"""Private, run-bound Codex auth file handoff over exact-machine SFTP."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import sys
import time

ROOT = Path("/tmp/rose-cloudbench-codex")
MAX_BYTES = 65536
WAIT_SECONDS = 270


def private_bytes(path, *, owners=None, keep_open=False):
    if owners is None:
        owners = {os.geteuid()}
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    retained = False
    try:
        before = os.fstat(descriptor)
        if (
            before.st_uid not in owners
            or not stat.S_ISREG(before.st_mode)
            or before.st_mode & 0o077
            or not 0 < before.st_size <= MAX_BYTES
        ):
            raise ValueError("invalid private regular file")
        body = b""
        while len(body) < before.st_size:
            block = os.read(descriptor, before.st_size - len(body))
            if not block:
                raise ValueError("short private file")
            body += block
        after = os.fstat(descriptor)
        if (
            before.st_dev,
            before.st_ino,
            before.st_size,
            before.st_mtime_ns,
            before.st_ctime_ns,
        ) != (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        ):
            raise ValueError("private file changed during read")
        if keep_open:
            retained = True
            return body, before, descriptor
        return body
    finally:
        if not retained:
            os.close(descriptor)


def validate_auth(body):
    value = json.loads(body)
    if not isinstance(value, dict) or value.get("auth_mode") != "chatgpt":
        raise ValueError("invalid auth mode")
    tokens = value.get("tokens")
    if not isinstance(tokens, dict) or any(
        not isinstance(tokens.get(k), str) or not tokens[k]
        for k in ("access_token", "refresh_token")
    ):
        raise ValueError("invalid auth envelope")


def flush_directory(directory):
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_exclusive(path, body):
    descriptor = os.open(
        path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
    )
    with os.fdopen(descriptor, "wb") as output:
        output.write(body)
        output.flush()
        os.fsync(output.fileno())
    flush_directory(path.parent)


def prepare(source, output):
    body = private_bytes(source)
    validate_auth(body)
    output = output.parent.resolve(strict=True) / output.name
    write_exclusive(output, body)
    return hashlib.sha256(body).hexdigest()


def authority(run_token, machine, digest, reader_uid=None):
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,160}", run_token) or run_token in (
        ".",
        "..",
    ):
        raise ValueError("invalid run identity")
    if not re.fullmatch(r"[0-9a-f]{14,16}", machine) or not re.fullmatch(
        r"[0-9a-f]{64}", digest
    ):
        raise ValueError("invalid machine or digest")
    if (
        os.environ.get("FLY_MACHINE_ID") != machine
        or os.environ.get("CLOUDBENCH_RUN_TOKEN") != run_token
    ):
        raise ValueError("guest identity mismatch")
    return {
        "version": 1,
        "run_token": run_token,
        "machine_id": machine,
        "sha256": digest,
        "reader_uid": os.geteuid() if reader_uid is None else reader_uid,
    }


def directory(owner):
    return ROOT / (owner["run_token"] + "-" + owner["machine_id"])


def check_directory(path, mode, *, owners=None):
    if owners is None:
        owners = {os.geteuid()}
    metadata = path.lstat()
    if (
        metadata.st_uid not in owners
        or not stat.S_ISDIR(metadata.st_mode)
        or stat.S_IMODE(metadata.st_mode) != mode
    ):
        raise ValueError("unsafe private directory")


def check_owner(owner, admission_token=None):
    check_directory(ROOT, 0o711)
    target = directory(owner)
    metadata = target.lstat()
    if stat.S_IMODE(metadata.st_mode) not in (0o700, 0o711):
        raise ValueError("unsafe private directory mode")
    check_directory(target, stat.S_IMODE(metadata.st_mode))
    actual = json.loads(private_bytes(target / "owner.json"))
    claim = actual.pop("admission_token", "")
    if actual != owner or not re.fullmatch(r"[0-9a-f]{64}", claim):
        raise ValueError("private owner mismatch")
    if admission_token is not None and admission_token != claim:
        raise ValueError("private admission mismatch")
    return target


def admit(owner, admission_token):
    if not re.fullmatch(r"[0-9a-f]{64}", admission_token):
        raise ValueError("invalid admission token")
    try:
        ROOT.mkdir(mode=0o711)
        ROOT.chmod(0o711)
    except FileExistsError:
        pass
    check_directory(ROOT, 0o711)
    target = directory(owner)
    try:
        target.mkdir(mode=0o700)
    except FileExistsError:
        check_owner(owner, admission_token)
        return
    write_exclusive(
        target / "owner.json",
        json.dumps(
            {**owner, "admission_token": admission_token}, sort_keys=True
        ).encode(),
    )
    flush_directory(ROOT)


def stage(owner):
    # Only a live driver waiting under its EXIT owner may create admission.
    target = check_owner(owner)
    ready = target / "auth.json"
    if os.path.lexists(ready):
        check_ready(owner)
        return "already-ready"
    check_directory(target, 0o700)
    pending = target / "auth.pending"
    if os.path.lexists(pending):
        metadata = pending.lstat()
        if (
            metadata.st_uid != os.geteuid()
            or not stat.S_ISREG(metadata.st_mode)
            or metadata.st_mode & 0o077
        ):
            raise ValueError("unsafe pending file")
        pending.unlink()
        flush_directory(target)
    return "stage-ready"


def check_ready(owner):
    target = check_owner(owner)
    body = private_bytes(
        target / "auth.json", owners={os.geteuid(), owner["reader_uid"]}
    )
    if hashlib.sha256(body).hexdigest() != owner["sha256"]:
        raise ValueError("auth digest mismatch")
    validate_auth(body)
    return target / "auth.json"


def publish(owner):
    target = check_owner(owner)
    if os.path.lexists(target / "auth.json"):
        check_ready(owner)
        return
    check_directory(target, 0o700)
    pending = target / "auth.pending"
    body, before, descriptor = private_bytes(pending, keep_open=True)
    try:
        if hashlib.sha256(body).hexdigest() != owner["sha256"]:
            raise ValueError("pending auth digest mismatch")
        validate_auth(body)
        os.fsync(descriptor)
        after = pending.lstat()
        fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
        if any(getattr(before, key) != getattr(after, key) for key in fields):
            raise ValueError("pending identity changed before publication")
        os.rename(pending, target / "auth.json")
        flush_directory(target)
    finally:
        os.close(descriptor)


def wait_ready(owner, user, admission_token):
    admit(owner, admission_token)
    target = directory(owner)
    deadline = time.monotonic() + WAIT_SECONDS
    while not os.path.lexists(target / "auth.json"):
        if time.monotonic() >= deadline:
            raise TimeoutError("explicit auth handoff deadline")
        time.sleep(0.1)
    path = check_ready(owner)
    account = pwd.getpwnam(user)
    if account.pw_uid != owner["reader_uid"]:
        raise ValueError("reader identity mismatch")
    os.chown(path, account.pw_uid, account.pw_gid, follow_symlinks=False)
    # Reader may traverse but cannot replace owner, pending or ready entries.
    target.chmod(0o711)
    flush_directory(target)
    return path


def retire(owner, admission_token):
    if os.path.lexists(ROOT):
        check_directory(ROOT, 0o711)
    target = directory(owner)
    if not os.path.lexists(target):
        return
    check_owner(owner, admission_token)
    if set(p.name for p in target.iterdir()) - {
        "owner.json",
        "auth.pending",
        "auth.json",
    }:
        raise ValueError("unexpected private directory member")
    for name in ("auth.pending", "auth.json"):
        path = target / name
        if os.path.lexists(path):
            metadata = path.lstat()
            if (
                metadata.st_uid not in {os.geteuid(), owner["reader_uid"]}
                or not stat.S_ISREG(metadata.st_mode)
                or metadata.st_mode & 0o077
            ):
                raise ValueError("unsafe credential retirement target")
            path.unlink()
    (target / "owner.json").unlink()
    flush_directory(target)
    target.rmdir()
    flush_directory(ROOT)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "action", choices=("prepare", "stage", "publish", "wait", "retire")
    )
    parser.add_argument("--source", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--run-token")
    parser.add_argument("--machine-id")
    parser.add_argument("--sha256")
    parser.add_argument("--user", default="rose")
    parser.add_argument("--admission-token", default="")
    args = parser.parse_args()
    if args.action == "prepare":
        if args.source is None or args.output is None:
            raise ValueError("missing local handoff paths")
        print(prepare(args.source, args.output))
        return
    owner = authority(
        args.run_token or "",
        args.machine_id or "",
        args.sha256 or "",
        pwd.getpwnam(args.user).pw_uid,
    )
    if args.action == "wait":
        wait_ready(owner, args.user, args.admission_token)
    elif args.action == "retire":
        retire(owner, args.admission_token)
    elif args.action == "stage":
        print(stage(owner))
    else:
        publish(owner)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError):
        print("FATAL: explicit Codex credential handoff rejected", file=sys.stderr)
        sys.exit(1)
