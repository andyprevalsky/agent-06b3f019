#!/usr/bin/env python3
"""Validate a joined, pre-reservation failure for prepare-only continuation."""

import copy
import hashlib
import json
import os
import runpy
import stat
import subprocess
import time
from pathlib import Path

SOURCE = "59ab01b35aa91521e105a3d48e1587007aa347ad"
CLI_SHA = "bf1ed9281340b13963349c87af034c32aadd205fb9e9781fe6a40be1dc5d0217"
JOURNAL = "pre-reservation-preparation"
LOCK = "pre-reservation-preparation.lock"
ABSENT = {
    "archived-reuse-original.private.json",
    "archived-reuse-request.private.json",
    "archived-reuse-reservations",
    "authority-template.private.json",
    "config.private.json",
    "run",
}


def need(value, message):
    if not value:
        raise ValueError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode()


def file_hash(path):
    path = Path(path).absolute()
    need(path.resolve(strict=True) == path, "physical preparation input required")

    def stable(value):
        return tuple(
            getattr(value, key)
            for key in (
                "st_dev",
                "st_ino",
                "st_size",
                "st_mtime_ns",
                "st_ctime_ns",
                "st_mode",
                "st_uid",
                "st_gid",
                "st_nlink",
            )
        )

    before = path.lstat()
    with os.fdopen(
        os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb"
    ) as stream:
        state = os.fstat(stream.fileno())
        need(
            stat.S_ISREG(state.st_mode)
            and state.st_uid == os.geteuid()
            and not state.st_mode & 0o077
            and state.st_nlink == 1
            and state.st_size <= 256 * 1024 * 1024
            and stable(state) == stable(before),
            "private preparation input required",
        )
        digest = hashlib.sha256()
        size = 0
        while size <= state.st_size:
            block = stream.read(min(1048576, state.st_size - size + 1))
            if not block:
                break
            digest.update(block)
            size += len(block)
        need(
            stable(os.fstat(stream.fileno())) == stable(state)
            and stable(path.lstat()) == stable(state)
            and size == state.st_size,
            "preparation input changed",
        )
    return dict(bytes=size, sha256=digest.hexdigest())


def membership(directory):
    need(
        directory.resolve(strict=True) == directory
        and directory.is_dir()
        and directory.stat().st_uid == os.geteuid()
        and not directory.stat().st_mode & 0o077,
        "private original admission required",
    )
    found = {}
    for path in sorted(directory.rglob("*")):
        relative = path.relative_to(directory)
        if relative.parts[0] in (JOURNAL, LOCK):
            continue
        need(
            not path.is_symlink() and path.resolve(strict=True) == path,
            "preparation history alias",
        )
        if path.is_dir():
            state = path.stat()
            need(
                state.st_uid == os.geteuid() and not state.st_mode & 0o077,
                "foreign preparation directory",
            )
            found[str(relative)] = dict(kind="directory")
        else:
            found[str(relative)] = dict(kind="file", **file_hash(path))
    return found


def old_operator(root):
    need(root.resolve(strict=True) == root, "physical original operator required")
    raw = subprocess.check_output(
        [
            "git",
            "--no-replace-objects",
            "-C",
            str(root),
            "show",
            SOURCE + ":scripts/run-original600-controller.py",
        ]
    )
    need(
        sha(raw) == CLI_SHA
        and (root / "scripts/run-original600-controller.py").read_bytes() == raw,
        "unsupported original preparation protocol",
    )
    return runpy.run_path(str(root / "scripts/run-original600-controller.py"))


def owner_gone(root):
    program = str(root / "scripts/run-original600-controller.py").encode()
    for path in Path("/proc").iterdir():
        if not path.name.isdecimal():
            continue
        try:
            if path.stat().st_uid != os.geteuid():
                continue
            argv = (path / "cmdline").read_bytes().split(b"\0")
        except FileNotFoundError:
            continue
        matches = program in argv
        if not matches:
            for argument in argv:
                if argument and argument.endswith(b"run-original600-controller.py"):
                    try:
                        target = Path(os.fsdecode(argument))
                        if not target.is_absolute():
                            target = Path(os.readlink(path / "cwd")) / target
                        matches = target.resolve() == Path(os.fsdecode(program))
                    except FileNotFoundError:
                        continue
                    if matches:
                        break
        need(not matches, "original admission CLI is still live")


def plan(args, runner):
    directory = Path(args.prepare_admission_request).absolute()
    need(
        directory.parent == Path(args.state_dir).absolute(),
        "original admission outside selected state directory",
    )
    failure_path = Path(args.pre_reservation_failure).absolute()
    failure_raw = runner["read"](failure_path)
    failure = json.loads(failure_raw)
    failure_info = file_hash(failure_path)
    intent_path = directory / "admission-intent.private.json"
    intent_raw = runner["read"](intent_path)
    intent = json.loads(intent_raw)
    need(
        failure["schema"] == "original600-observed-prereservation-failure-v1"
        and failure["source_ref"] == SOURCE
        and failure["admission_directory"] == str(directory)
        and failure["admission_intent_sha256"] == sha(intent_raw),
        "pre-reservation failure binding differs",
    )
    need(
        failure["joined_observed"] is True
        and failure["tool_reported_exit_code"] == 1
        and type(failure["tool_session_id"]) is int
        and failure["tool_session_id"] > 0
        and failure["controller_created"] is False
        and failure["capture_kind"] == "original-process-stream"
        and failure["launch_directories"] == [],
        "positive joined pre-reservation failure required",
    )
    started, deadline = intent["started_at_epoch"], intent["deadline_epoch"]
    need(
        started == failure["started_at_epoch"]
        and deadline == failure["deadline_epoch"] == started + 5400
        and started <= failure["recorded_observation_epoch"] <= time.time() < deadline,
        "original preparation clock expired or changed",
    )
    need(
        set(failure["absent_paths"]) == ABSENT
        and all(
            not (directory / name).exists() and not (directory / name).is_symlink()
            for name in ABSENT
        )
        and not any(directory.glob("launch-*"))
        and not (directory / "controller-launch.intent.json").exists(),
        "preparation already has reservation or launch authority",
    )
    root = Path(failure["source_root"])
    old = old_operator(root)
    pins = old["source"](root, SOURCE)
    runner["validate_source_members"](root, SOURCE, pins)
    oldargs = copy.copy(args)
    oldargs.source_ref = SOURCE
    need(
        old["admission_binding"](oldargs, runner) == intent["binding"],
        "original preparation inputs/archives/exclusions changed",
    )
    need(
        intent["binding"]["archive_runs"] and len(intent["binding"]["inputs"]) == 6,
        "complete archived admission binding required",
    )
    inputs = {str(intent_path): file_hash(intent_path), str(failure_path): failure_info}
    for descriptor in intent["binding"]["inputs"].values():
        path = Path(descriptor["path"])
        info = file_hash(path)
        need(info["sha256"] == descriptor["sha256"], "bound preparation input changed")
        inputs[str(path)] = info
    log_path = Path(failure["log_path"])
    need(
        log_path.parent == directory.parent,
        "original stream is outside admission state",
    )
    info = file_hash(log_path)
    need(info["sha256"] == failure["log_sha256"], "original failure stream changed")
    log = runner["read"](log_path).decode()
    lines = log.splitlines()
    first, pending = json.loads(lines[0]), json.loads(lines[1])
    need(
        first["status"] == "ADMISSION_STARTED"
        and first["directory"] == str(directory)
        and first["source_ref"] == SOURCE
        and pending["status"] == "ADMISSION_PENDING"
        and pending["directory"] == str(directory)
        and pending["controller_started"] is False
        and "cloudbench-recovered-reservations.py" in log
        and "in membership" in log
        and "<run_path>.Deadline: external controller I/O deadline" in log,
        "known local-proof failure stream differs",
    )
    inputs[str(log_path)] = info
    found = membership(directory)
    expected = {
        name: dict(kind="file", **value) for name, value in failure["files"].items()
    }
    need(
        "admission-intent.private.json" in expected
        and expected["admission-intent.private.json"]["sha256"] == sha(intent_raw),
        "original file inventory lacks admission",
    )
    for name in list(expected):
        path = Path(name)
        need(
            not path.is_absolute() and ".." not in path.parts,
            "unsafe preparation manifest",
        )
        for parent in path.parents:
            if str(parent) != ".":
                expected[str(parent)] = dict(kind="directory")
    if failure_path.parent == directory:
        expected[failure_path.name] = dict(kind="file", **failure_info)
    need(found == expected, "original pre-reservation membership changed")
    owner_gone(root)
    need(time.time() < deadline, "original preparation clock expired")
    value = dict(
        directory=str(directory),
        started_at=started,
        deadline=deadline,
        source_ref=SOURCE,
        source_root=str(root),
        source_pins=pins,
        inputs=inputs,
        files=found,
        failure_path=str(failure_path),
        binding=intent["binding"],
        journal=str(directory / JOURNAL),
    )
    value["identity_sha256"] = sha(canonical(value))
    return value


def revalidate(value, runner):
    need(time.time() < value["deadline"], "original preparation clock expired")
    for path, expected in value["inputs"].items():
        need(file_hash(path) == expected, "preparation evidence changed")
    need(
        membership(Path(value["directory"])) == value["files"],
        "preparation membership changed",
    )
    root = Path(value["source_root"])
    old = old_operator(root)
    need(
        old["source"](root, SOURCE) == value["source_pins"],
        "old preparation source changed",
    )
    runner["validate_source_members"](root, SOURCE, value["source_pins"])
    owner_gone(root)
    need(time.time() < value["deadline"], "original preparation clock expired")
    return True
