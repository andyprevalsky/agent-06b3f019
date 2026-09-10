#!/usr/bin/env python3
"""Seal exact guest quiescence before controller-owned provider cleanup."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import socket
import stat
import sys
from pathlib import Path
from typing import Any


SAFE_MACHINE = re.compile(r"[0-9a-f]+")
SAFE_TOKEN = re.compile(r"[A-Za-z0-9._-]+")
SCHEMA = "cloudbench-guest-quiescence-v1"


class GuestRecoveryError(RuntimeError):
    """The exact guest is not proven unable to create more provider resources."""


def regular_file(path: Path) -> bool:
    try:
        metadata = path.lstat()
    except OSError:
        return False
    return stat.S_ISREG(metadata.st_mode) and not path.is_symlink()


def plain_directory(path: Path) -> bool:
    try:
        metadata = path.lstat()
    except OSError:
        return False
    return stat.S_ISDIR(metadata.st_mode) and not path.is_symlink()


def read_bytes(path: Path, *, maximum: int) -> bytes:
    if not regular_file(path):
        raise GuestRecoveryError(f"missing regular exact guest evidence: {path}")
    metadata = path.stat()
    if metadata.st_size > maximum:
        raise GuestRecoveryError(f"oversized exact guest evidence: {path}")
    return path.read_bytes()


def process_state(pid: int) -> str | None:
    try:
        stat_payload = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
    except (FileNotFoundError, ProcessLookupError):
        return None
    except OSError as error:
        raise GuestRecoveryError(f"cannot inspect guest process {pid}") from error
    try:
        return stat_payload.split(") ", 1)[1].split()[0]
    except (IndexError, ValueError) as error:
        raise GuestRecoveryError(f"malformed process state for {pid}") from error


def process_has_run_token(pid: int, token: str) -> bool:
    try:
        environment = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
    except OSError:
        return False
    expected = f"CLOUDBENCH_RUN_TOKEN={token}".encode()
    return any(hmac.compare_digest(entry, expected) for entry in environment)


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    if not plain_directory(path.parent):
        raise GuestRecoveryError("unsafe quiescence receipt parent")
    temporary = path.parent / f".{path.name}.{os.getpid()}.tmp"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", closefd=False) as handle:
            json.dump(value, handle, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
    finally:
        os.close(descriptor)
    try:
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def parse_services(path: Path, repo_dir: Path) -> tuple[dict[str, Any], bytes]:
    if not regular_file(path):
        raise GuestRecoveryError("missing exact guest services manifest")
    payload = path.read_bytes()
    if len(payload) > 1024 * 1024:
        raise GuestRecoveryError("oversized exact guest services manifest")
    try:
        value = json.loads(payload)
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise GuestRecoveryError("malformed exact guest services manifest") from error
    if (
        not isinstance(value, dict)
        or value.get("schema_version") != 1
        or value.get("benchmark_mode") is not True
        or value.get("worktree") != str(repo_dir)
        or value.get("status") != "stopped"
        or not isinstance(value.get("services"), list)
    ):
        raise GuestRecoveryError("guest services are not durably stopped")
    return value, payload


def service_pids(value: dict[str, Any]) -> list[int]:
    raw_pids: list[Any] = [value.get("run_sh_pid")]
    for service in value["services"]:
        if not isinstance(service, dict) or set(service) != {"name", "pid"}:
            raise GuestRecoveryError("malformed exact guest service identity")
        if not isinstance(service.get("name"), str) or not service["name"]:
            raise GuestRecoveryError("malformed exact guest service name")
        raw_pids.append(service.get("pid"))
    if any(not isinstance(pid, int) or pid <= 1 for pid in raw_pids):
        raise GuestRecoveryError("malformed exact guest service pid")
    pids = [int(pid) for pid in raw_pids]
    if len(pids) != len(set(pids)):
        raise GuestRecoveryError("duplicate exact guest service pid")
    return pids


def backend_port(value: dict[str, Any]) -> int:
    ports = value.get("ports")
    port = ports.get("backend") if isinstance(ports, dict) else None
    if not isinstance(port, int) or not 1 <= port <= 65_535:
        raise GuestRecoveryError("missing exact guest backend port")
    return port


def backend_is_closed(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.5)
        return probe.connect_ex(("127.0.0.1", port)) != 0


def read_existing(path: Path, machine_id: str, token: str) -> dict[str, Any] | None:
    if not path.exists() and not path.is_symlink():
        return None
    if not regular_file(path):
        raise GuestRecoveryError("unsafe existing quiescence receipt")
    try:
        value = json.loads(path.read_bytes())
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise GuestRecoveryError("malformed existing quiescence receipt") from error
    required_fields = {
        "schema_version",
        "version",
        "state",
        "machine_id",
        "guest_run_token",
        "reason",
        "driver_state",
        "driver_pid",
        "driver_process_state",
        "stopped_service_pids",
        "backend_port",
        "services_sha256",
        "run_json_sha256",
        "backend_log_sha256",
    }
    if (
        not isinstance(value, dict)
        or set(value) != required_fields
        or value.get("schema_version") != SCHEMA
        or value.get("version") != 1
        or value.get("state") != "quiesced"
        or value.get("machine_id") != machine_id
        or value.get("guest_run_token") != token
        or value.get("reason")
        not in {
            "driver-exited-services-stopped",
            "running-driver-services-stopped",
        }
        or value.get("driver_state") not in {"running", "exited"}
        or (
            value.get("driver_pid") is not None
            and (not isinstance(value["driver_pid"], int) or value["driver_pid"] <= 1)
        )
        or (
            value.get("driver_process_state") is not None
            and not isinstance(value["driver_process_state"], str)
        )
        or not isinstance(value.get("stopped_service_pids"), list)
        or any(
            not isinstance(pid, int) or pid <= 1
            for pid in value["stopped_service_pids"]
        )
        or not isinstance(value.get("backend_port"), int)
        or not 1 <= value["backend_port"] <= 65_535
        or any(
            not isinstance(value.get(field), str)
            or re.fullmatch(r"[0-9a-f]{64}", value[field]) is None
            for field in (
                "services_sha256",
                "run_json_sha256",
                "backend_log_sha256",
            )
        )
    ):
        raise GuestRecoveryError("existing quiescence receipt has the wrong owner")
    return value


def quiesce(args: argparse.Namespace) -> int:
    data_dir = Path(args.data_dir)
    repo_dir = Path(args.repo_dir)
    receipt = Path(args.receipt)
    if (
        SAFE_MACHINE.fullmatch(args.machine_id) is None
        or SAFE_TOKEN.fullmatch(args.guest_run_token) is None
        or not data_dir.is_absolute()
        or not repo_dir.is_absolute()
        or not receipt.is_absolute()
        or not plain_directory(data_dir)
        or not plain_directory(repo_dir)
        or data_dir.resolve() != data_dir
        or repo_dir.resolve() != repo_dir
        or receipt.parent != data_dir
    ):
        raise GuestRecoveryError("unsafe exact guest recovery identity")
    driver_state_path = data_dir / "cloudbench-driver.state"
    driver_pid_path = data_dir / "cloudbench-driver.pid"
    if not regular_file(driver_state_path):
        raise GuestRecoveryError("missing exact guest driver state")
    driver_state = driver_state_path.read_text(encoding="utf-8").strip()
    if driver_state not in {"running", "exited"}:
        raise GuestRecoveryError("exact guest driver state is not terminal or inspectable")

    driver_pid: int | None = None
    if regular_file(driver_pid_path):
        try:
            driver_pid = int(driver_pid_path.read_text(encoding="utf-8").strip())
        except ValueError as error:
            raise GuestRecoveryError("malformed exact guest driver pid") from error
        if driver_pid <= 1:
            raise GuestRecoveryError("unsafe exact guest driver pid")
    driver_process_state = process_state(driver_pid) if driver_pid is not None else None

    if driver_state == "exited":
        if driver_process_state is not None:
            raise GuestRecoveryError("exited guest still has a live driver pid")
        reason = "driver-exited-services-stopped"
    else:
        if (
            driver_pid is None
            or driver_process_state is None
            or not process_has_run_token(driver_pid, args.guest_run_token)
        ):
            raise GuestRecoveryError("running driver does not own the exact guest run")
        reason = "running-driver-services-stopped"

    context_dir = repo_dir / ".context" / "cloudbench"
    services, services_payload = parse_services(context_dir / "services.json", repo_dir)
    stopped_pids = service_pids(services)
    live = [pid for pid in stopped_pids if process_state(pid) is not None]
    if live:
        raise GuestRecoveryError(
            "guest service processes remain live: " + ",".join(str(pid) for pid in live)
        )
    port = backend_port(services)
    if not backend_is_closed(port):
        raise GuestRecoveryError("exact guest backend can still create provider sessions")

    run_json_payload = read_bytes(Path(args.run_json), maximum=512 * 1024 * 1024)
    backend_log_payload = read_bytes(Path(args.backend_log), maximum=512 * 1024 * 1024)
    services_sha = hashlib.sha256(services_payload).hexdigest()
    run_json_sha = hashlib.sha256(run_json_payload).hexdigest()
    backend_log_sha = hashlib.sha256(backend_log_payload).hexdigest()

    value = {
        "schema_version": SCHEMA,
        "version": 1,
        "state": "quiesced",
        "machine_id": args.machine_id,
        "guest_run_token": args.guest_run_token,
        "reason": reason,
        "driver_state": driver_state,
        "driver_pid": driver_pid,
        "driver_process_state": driver_process_state,
        "stopped_service_pids": stopped_pids,
        "backend_port": port,
        "services_sha256": services_sha,
        "run_json_sha256": run_json_sha,
        "backend_log_sha256": backend_log_sha,
    }
    existing = read_existing(receipt, args.machine_id, args.guest_run_token)
    if existing is not None:
        immutable_fields = (
            "machine_id",
            "guest_run_token",
            "stopped_service_pids",
            "backend_port",
            "services_sha256",
            "run_json_sha256",
            "backend_log_sha256",
        )
        if any(existing[field] != value[field] for field in immutable_fields):
            raise GuestRecoveryError("existing quiescence receipt no longer matches exact evidence")
        return 0
    atomic_json(receipt, value)
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    command = subparsers.add_parser("quiesce")
    command.add_argument("--machine-id", required=True)
    command.add_argument("--guest-run-token", required=True)
    command.add_argument("--data-dir", default="/data")
    command.add_argument("--repo-dir", default="/data/repo")
    command.add_argument("--receipt", required=True)
    command.add_argument(
        "--run-json",
        default="/data/repo/.context/cloudbench/run.json",
    )
    command.add_argument(
        "--backend-log",
        default="/data/repo/.context/cloudbench/logs/backend.log",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.command == "quiesce":
        return quiesce(args)
    raise GuestRecoveryError("unknown guest recovery command")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except GuestRecoveryError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1) from error
