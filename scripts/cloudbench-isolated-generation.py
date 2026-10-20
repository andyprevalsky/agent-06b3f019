#!/usr/bin/env python3
"""Enter a clean logical generation on a retained Volume before canonical boot.

Host admission owns native leases, version fences and archive custody. This
helper accepts only its immutable config-bound proof; it grants no native rights.
"""

import argparse
import base64
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

MODE = "retained-volume-fresh-generation"


def require(value, reason):
    if not value:
        raise ValueError(reason)


def proof(env):
    require(env.get("CLOUDBENCH_STORAGE_MODE") == MODE, "storage mode")
    raw = base64.b64decode(env["CLOUDBENCH_ARCHIVED_REUSE_PROOF_B64"], validate=True)
    require(
        len(raw) <= 65536 and hashlib.sha256(raw).hexdigest() == env["CLOUDBENCH_ARCHIVED_REUSE_PROOF_SHA256"],
        "proof digest",
    )
    value = json.loads(raw)
    require(
        value["schema"] == "cloudbench-archived-reuse-v1" and value["storage_mode"] == MODE,
        "proof schema",
    )
    claim = value["claim_id"]
    require(
        re.fullmatch("[a-f0-9]{32}", claim) and value["generation_id"] == claim,
        "generation identity",
    )
    require(
        value["machine_id"] == env["FLY_MACHINE_ID"] and re.fullmatch("[a-f0-9]{14}", value["machine_id"]),
        "Machine identity",
    )
    require(re.fullmatch("vol_[A-Za-z0-9_-]+", value["volume_id"]), "Volume identity")
    require(
        value["source_instance_id"] and re.fullmatch("[a-f0-9]{64}", value["source_config_sha256"]),
        "source native identity",
    )
    require(
        value["predecessor_archive_sha256s"]
        and all(re.fullmatch("[a-f0-9]{64}", x) for x in value["predecessor_archive_sha256s"]),
        "archive digests",
    )
    successor = value["successor"]
    require(
        all(isinstance(successor[k], str) and successor[k] for k in ("controller_id", "run_id", "owner_token", "task")),
        "successor owner",
    )
    require(type(successor["ordinal"]) is int and successor["ordinal"] >= 0, "task ordinal")
    require(
        all(re.fullmatch("[a-f0-9]{40}", successor[k]) for k in ("harness_ref", "task_ref")),
        "source refs",
    )
    require(
        env.get("CLOUDBENCH_RUN_TOKEN") == successor["owner_token"] + "-" + str(successor["ordinal"]),
        "run token",
    )
    require(env.get("REF") == successor["task_ref"], "task source")
    expected = "/data/.cloudbench-generations/" + claim
    require(
        value["guest"] == {"data_dir": expected, "repo_dir": expected + "/repo"},
        "guest paths",
    )
    require(re.fullmatch("[a-f0-9]{64}", value["native_marker_sha256"]), "native marker")
    return value


def safe_directory(path):
    info = path.lstat()
    require(
        stat.S_ISDIR(info.st_mode) and not path.is_symlink() and info.st_uid == 0,
        "root-owned real directory required",
    )
    require(
        path.resolve(strict=True) == path and not info.st_mode & 0o022,
        "unsafe directory path",
    )


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", default="/data")
    parser.add_argument("--boot-script", default="/cloudbench-boot.sh")
    parser.add_argument("--inner", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--verify-checkout", nargs=2, metavar=("REPO", "REF"))
    parser.add_argument("--external-exec", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    require(os.geteuid() == 0, "privileged boot required")
    value = proof(os.environ)
    helper = Path(__file__).resolve(strict=True)
    helper_info = helper.stat()
    require(
        helper_info.st_uid == 0 and not helper_info.st_mode & 0o022,
        "unsafe generation helper",
    )
    data = Path(args.data_root)
    require(data.is_absolute(), "absolute data root required")
    safe_directory(data)
    if args.external_exec is not None:
        require(not args.inner and not args.verify_checkout, "conflicting entry modes")
        command = args.external_exec
        if command and command[0] == "--":
            command = command[1:]
        require(command and command[0].startswith("/"), "absolute external command required")
        generation = data / ".cloudbench-generations" / value["claim_id"]
        safe_directory(generation.parent)
        safe_directory(generation)
        certificate_path = generation / ".cloudbench-generation.json"
        info = certificate_path.lstat()
        require(
            stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
            "unsafe generation certificate",
        )
        certificate = json.loads(certificate_path.read_text())
        require(
            certificate["schema"] == "cloudbench-isolated-generation-v1"
            and certificate["storage_mode"] == MODE
            and certificate["claim_id"] == value["claim_id"]
            and certificate["machine_id"] == value["machine_id"]
            and certificate["volume_id"] == value["volume_id"]
            and certificate["physical_data_dir"] == value["guest"]["data_dir"]
            and certificate["proof_sha256"] == os.environ["CLOUDBENCH_ARCHIVED_REUSE_PROOF_SHA256"]
            and certificate["root_inode"] == generation.stat().st_ino
            and certificate["root_device"] == generation.stat().st_dev,
            "external generation certificate mismatch",
        )
        pid = certificate["pid"]
        require(type(pid) is int and pid > 0, "invalid namespace owner")
        process = Path("/proc") / str(pid)

        def birth():
            return (process / "stat").read_text().rsplit(") ", 1)[1].split()[19]

        require(birth() == certificate["birth"], "namespace owner birth mismatch")
        namespace = process / "ns/mnt"
        fd = os.open(namespace, os.O_RDONLY)
        require(
            "mnt:[" + str(os.fstat(fd).st_ino) + "]" == certificate["mount_namespace"]
            and birth() == certificate["birth"],
            "namespace owner changed",
        )
        # Pin the verified namespace, so PID exit/reuse cannot redirect nsenter.
        for name in os.listdir("/proc/self/fd"):
            number = int(name)
            if number > 2 and number != fd:
                try:
                    os.set_inheritable(number, False)
                except OSError:
                    pass
        os.set_inheritable(fd, True)
        null = os.open("/dev/null", os.O_RDWR)
        os.dup2(null, 0)
        for number in (1, 2):
            info = os.fstat(number)
            if stat.S_ISREG(info.st_mode) and info.st_dev == data.stat().st_dev:
                os.dup2(null, number)
        os.close(null)
        os.chdir("/")
        os.environ["CLOUDBENCH_DATA_DIR"] = str(data)
        os.environ["CLOUDBENCH_REPO_DIR"] = str(data / "repo")
        os.execvp(
            "nsenter",
            ["nsenter", "--mount=/proc/self/fd/" + str(fd), "--wd=/", "--", *command],
        )
    if args.verify_checkout:
        repo, ref = args.verify_checkout
        certificate_path = data / ".cloudbench-generation.json"
        info = certificate_path.lstat()
        require(
            stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
            "unsafe generation certificate",
        )
        certificate = json.loads(certificate_path.read_text())
        require(
            certificate["schema"] == "cloudbench-isolated-generation-v1"
            and certificate["storage_mode"] == MODE
            and certificate["claim_id"] == value["claim_id"]
            and certificate["machine_id"] == value["machine_id"]
            and certificate["volume_id"] == value["volume_id"]
            and certificate["proof_sha256"] == os.environ["CLOUDBENCH_ARCHIVED_REUSE_PROOF_SHA256"]
            and certificate["mount_namespace"] == os.readlink("/proc/self/ns/mnt")
            and certificate["root_inode"] == data.stat().st_ino
            and certificate["root_device"] == data.stat().st_dev,
            "generation certificate mismatch",
        )
        require(
            repo == str(data / "repo")
            and os.environ.get("CLOUDBENCH_REPO_DIR") == repo
            and ref == value["successor"]["task_ref"],
            "checkout binding",
        )
        return
    boot = Path(args.boot_script)
    info = boot.lstat()
    require(
        boot.resolve(strict=True) == boot
        and stat.S_ISREG(info.st_mode)
        and info.st_uid == 0
        and not info.st_mode & 0o022,
        "unsafe boot helper",
    )
    require(
        not helper.is_relative_to(data),
        "generation helper must be outside retained Volume",
    )
    require(
        not boot.is_relative_to(data),
        "boot helper must be on fresh rootfs, outside retained Volume",
    )
    generation = data / ".cloudbench-generations" / value["claim_id"]
    if not args.inner:
        require(
            any(
                line.split(" ")[4]
                == str(data).replace("\\", "\\134").replace(" ", "\\040").replace("\t", "\\011").replace("\n", "\\012")
                for line in Path("/proc/self/mountinfo").read_text().splitlines()
            ),
            "data root must be the admitted Volume mount",
        )
        parent = generation.parent
        try:
            parent.mkdir(mode=0o700)
        except FileExistsError:
            pass
        safe_directory(parent)
        generation.mkdir(mode=0o700)  # Existing or partially used generations never become fresh again.
        safe_directory(generation)
        sync_directory(parent)
        sync_directory(data)
        os.chdir("/")
        for name in os.listdir("/proc/self/fd"):
            fd = int(name)
            if fd > 2:
                try:
                    os.set_inheritable(fd, False)
                except OSError:
                    pass
        null = os.open("/dev/null", os.O_RDWR)
        os.dup2(null, 0)
        for fd in (1, 2):
            fd_info = os.fstat(fd)
            if stat.S_ISREG(fd_info.st_mode) and fd_info.st_dev == data.stat().st_dev:
                os.dup2(null, fd)
        os.close(null)
        os.execvp(
            "unshare",
            [
                "unshare",
                "--mount",
                "--propagation",
                "private",
                sys.executable,
                str(Path(__file__).resolve()),
                "--inner",
                "--data-root",
                str(data),
                "--boot-script",
                str(boot),
            ],
        )
    require(list(generation.iterdir()) == [], "generation not empty")
    expected_inode = generation.stat().st_ino
    expected_device = generation.stat().st_dev
    subprocess.run(["mount", "--make-rprivate", "/"], check=True, close_fds=True)
    subprocess.run(["mount", "--bind", str(generation), str(data)], check=True, close_fds=True)
    require(
        os.stat(data).st_ino == expected_inode and os.stat(data).st_dev == expected_device,
        "generation bind failed",
    )
    require(list(data.iterdir()) == [], "bound task root not empty")
    # Canonical boot writes as root; task user needs traversal, never the hidden parent tree.
    os.chmod(data, 0o755)
    certificate = {
        "schema": "cloudbench-isolated-generation-v1",
        "storage_mode": MODE,
        "claim_id": value["claim_id"],
        "machine_id": value["machine_id"],
        "volume_id": value["volume_id"],
        "physical_data_dir": value["guest"]["data_dir"],
        "proof_sha256": os.environ["CLOUDBENCH_ARCHIVED_REUSE_PROOF_SHA256"],
        "pid": os.getpid(),
        "birth": Path("/proc/self/stat").read_text().rsplit(") ", 1)[1].split()[19],
        "mount_namespace": os.readlink("/proc/self/ns/mnt"),
        "root_device": os.stat(data).st_dev,
        "root_inode": os.stat(data).st_ino,
    }
    with (data / ".cloudbench-generation.json").open("x") as stream:
        json.dump(certificate, stream, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    sync_directory(data)
    os.environ["CLOUDBENCH_DATA_DIR"] = str(data)
    os.environ["CLOUDBENCH_REPO_DIR"] = str(data / "repo")
    os.environ["CLOUDBENCH_WMH_DIR"] = str(data / "world-model")
    os.environ["CLOUDBENCH_COLD_PRIMARY_BOOTSTRAP"] = "1"
    os.environ["CLOUDBENCH_FRESH_VOLUME"] = "0"
    os.chdir("/")
    os.execv("/bin/bash", ["bash", str(boot)])


if __name__ == "__main__":
    main()
