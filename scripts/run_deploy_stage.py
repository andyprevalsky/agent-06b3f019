#!/usr/bin/env python3
"""Run and record one /deploy stage without per-stage helper processes."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence

from deploy_stage import LifecycleError, admit_stage, append_stage, release_stage
from factory_metadata import load_metadata

FORWARDED_SIGNALS = (signal.SIGHUP, signal.SIGINT, signal.SIGTERM)
CLEANUP_GRACE_SECONDS = 60
REPO_ROOT = Path(__file__).resolve().parents[1]


def _utc_timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-root", required=True, type=Path)
    parser.add_argument("--reuse-passed", action="store_true")
    parser.add_argument("stage")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    return parser


def _hash_field(digest: "hashlib._Hash", label: str, value: bytes) -> None:
    digest.update(label.encode())
    digest.update(b"\0")
    digest.update(str(len(value)).encode())
    digest.update(b"\0")
    digest.update(value)
    digest.update(b"\0")


def _git_output(*arguments: str) -> bytes:
    return subprocess.run(
        ("git", *arguments),
        cwd=REPO_ROOT,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    ).stdout


def _worktree_fingerprint(command: Sequence[str]) -> str:
    """Hash every deploy input; exact-tree reuse is conservative by design."""

    digest = hashlib.sha256()
    _hash_field(digest, "head", _git_output("rev-parse", "HEAD"))
    _hash_field(digest, "tracked", _git_output("diff", "--no-ext-diff", "--binary", "HEAD"))
    untracked = _git_output("ls-files", "--others", "--exclude-standard", "-z")
    _hash_field(digest, "untracked-list", untracked)
    for raw_path in sorted(path for path in untracked.split(b"\0") if path):
        relative = os.fsdecode(raw_path)
        path = REPO_ROOT / relative
        try:
            value = os.readlink(path).encode() if path.is_symlink() else path.read_bytes()
        except OSError as error:
            value = f"unreadable:{type(error).__name__}".encode()
        _hash_field(digest, f"untracked:{relative}", value)
    _hash_field(digest, "cwd", os.fsencode(os.getcwd()))
    for index, argument in enumerate(command):
        _hash_field(digest, f"argv:{index}", os.fsencode(argument))
    for name, value in sorted(os.environ.items()):
        if name in {"_", "OLDPWD", "SHLVL"}:
            continue
        _hash_field(digest, f"env:{name}", os.fsencode(value))
    return digest.hexdigest()


def _cache_path(run_dir: Path, stage: str, fingerprint: str) -> Path:
    return run_dir / "passed-cache" / stage / f"{fingerprint}.json"


def _cache_hit(run_dir: Path, stage: str, fingerprint: str) -> bool:
    path = _cache_path(run_dir, stage, fingerprint)
    try:
        payload = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return False
    return payload == {"schema_version": 1, "fingerprint": fingerprint}


def _record_cache_hit(run_dir: Path, stage: str, fingerprint: str) -> None:
    path = _cache_path(run_dir, stage, fingerprint)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps({"schema_version": 1, "fingerprint": fingerprint}) + "\n")
    temporary.replace(path)


def _run_logged(log_path: Path, command: Sequence[str]) -> int:
    received_signal = 0
    child: subprocess.Popen[bytes] | None = None
    kill_timer_started = False

    def force_kill_after_grace() -> None:
        time.sleep(CLEANUP_GRACE_SECONDS)
        if child is not None and child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def forward(signum: int, _frame: object) -> None:
        nonlocal kill_timer_started, received_signal
        received_signal = received_signal or signum
        if child is None or child.poll() is not None:
            return
        try:
            os.killpg(child.pid, signum)
        except ProcessLookupError:
            return
        if not kill_timer_started:
            kill_timer_started = True
            threading.Thread(target=force_kill_after_grace, daemon=True).start()

    for forwarded_signal in FORWARDED_SIGNALS:
        signal.signal(forwarded_signal, forward)

    child_exit = 127
    try:
        with log_path.open("wb") as log_handle:
            if received_signal:
                return 128 + received_signal
            try:
                child = subprocess.Popen(
                    command,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
            except OSError as error:
                print(f"could not start command: {error}", file=sys.stderr)
                return 127
            if received_signal:
                forward(received_signal, None)

            assert child.stdout is not None
            while True:
                try:
                    chunk = os.read(child.stdout.fileno(), 65536)
                except InterruptedError:
                    continue
                if not chunk:
                    break
                log_handle.write(chunk)
                try:
                    sys.stdout.buffer.write(chunk)
                    sys.stdout.buffer.flush()
                except BrokenPipeError:
                    pass
            child_exit = child.wait()
    finally:
        if child is not None and child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=CLEANUP_GRACE_SECONDS)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait()

    if received_signal:
        return 128 + received_signal
    if child_exit < 0:
        return 128 - child_exit
    return child_exit


def main() -> int:
    args = _parser().parse_args()
    command = list(args.command)
    if command and command[0] == "--":
        command.pop(0)
    if not command or re.fullmatch(r"[A-Za-z0-9._-]+", args.stage) is None:
        print("run_deploy_stage.py: valid STAGE and COMMAND are required", file=sys.stderr)
        return 2

    try:
        telemetry = load_metadata()
    except (OSError, ValueError) as error:
        print(f"invalid factory metadata: {type(error).__name__}", file=sys.stderr)
        return 2

    token = f"{args.stage}-{os.getpid()}-{secrets.token_hex(4)}"
    try:
        run_id = admit_stage(args.run_root, token=token, pid=os.getpid())
    except LifecycleError as error:
        print(f"deploy timing lifecycle error: {error}", file=sys.stderr)
        return 2

    run_dir = args.run_root / run_id
    fingerprint: str | None = None
    if args.reuse_passed:
        try:
            fingerprint = _worktree_fingerprint(command)
        except (OSError, subprocess.SubprocessError) as error:
            print(f"warning: could not fingerprint deploy inputs: {error}", file=sys.stderr)
        if fingerprint is not None and _cache_hit(run_dir, args.stage, fingerprint):
            try:
                release_stage(args.run_root, run_id=run_id, token=token)
            except (LifecycleError, OSError) as error:
                print(f"warning: could not release deploy stage admission: {error}", file=sys.stderr)
            print(f"== reused passed deploy stage: {args.stage} (exact worktree + command) ==")
            return 0

    log_relative = f"logs/{args.stage}-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}-{os.getpid()}.log"
    log_path = run_dir / log_relative
    log_path.parent.mkdir(parents=True, exist_ok=True)
    started_at = _utc_timestamp()
    started_epoch = time.time()
    print(f"== deploy stage: {args.stage} ==")

    stage_exit = _run_logged(log_path, command)
    finished_epoch = time.time()
    try:
        append_stage(
            run_dir,
            run_id=run_id,
            stage=args.stage,
            started_at=started_at,
            finished_at=_utc_timestamp(),
            started_epoch=started_epoch,
            finished_epoch=finished_epoch,
            exit_code=stage_exit,
            log=log_relative,
            telemetry=telemetry,
        )
    except OSError as error:
        print(f"warning: could not append deploy stage record: {error}", file=sys.stderr)
    try:
        release_stage(args.run_root, run_id=run_id, token=token)
    except (LifecycleError, OSError) as error:
        print(f"warning: could not release deploy stage admission: {error}", file=sys.stderr)

    if stage_exit == 0 and fingerprint is not None:
        try:
            finished_fingerprint = _worktree_fingerprint(command)
            if finished_fingerprint == fingerprint:
                _record_cache_hit(run_dir, args.stage, fingerprint)
            else:
                print(
                    f"warning: deploy inputs changed while {args.stage} ran; pass was not cached",
                    file=sys.stderr,
                )
        except (OSError, subprocess.SubprocessError) as error:
            print(f"warning: could not cache passed deploy stage: {error}", file=sys.stderr)

    print(f"== deploy stage: {args.stage} exit={stage_exit} log={log_path} ==")
    return stage_exit


if __name__ == "__main__":
    raise SystemExit(main())
