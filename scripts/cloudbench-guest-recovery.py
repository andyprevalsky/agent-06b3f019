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
import subprocess
import sys
from pathlib import Path
from typing import Any

SAFE_MACHINE = re.compile(r"[0-9a-f]+")
SAFE_TOKEN = re.compile(r"[A-Za-z0-9._-]+")
SAFE_AGENT = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
    re.IGNORECASE,
)
SAFE_DATABASE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,62}")
ANSI = re.compile(r"\x1b\[[0-9;]*m")
SCHEMA = "cloudbench-guest-quiescence-v1"
STATE_SCHEMA = "cloudbench-guest-state-v1"
ZERO_SCHEMA = "cloudbench-guest-zero-allocation-v1"


class GuestRecoveryError(RuntimeError):
    """The exact guest is not proven unable to create more provider resources."""


def regular_file(path: Path) -> bool:
    try:
        metadata = path.lstat()
    except OSError:
        return False
    return stat.S_ISREG(metadata.st_mode) and not path.is_symlink()


def executable_file(path: Path) -> bool:
    if not path.is_absolute():
        return False
    try:
        resolved = path.resolve(strict=True)
        metadata = resolved.lstat()
    except OSError:
        return False
    return (
        stat.S_ISREG(metadata.st_mode)
        and not resolved.is_symlink()
        and os.access(path, os.X_OK)
    )


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


def process_identity(pid: int) -> dict[str, Any] | None:
    try:
        stat_payload = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
        fields = stat_payload.split(") ", 1)[1].split()
        command_payload = Path(f"/proc/{pid}/cmdline").read_bytes()[:4096]
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        return None
    except (IndexError, OSError, ValueError) as error:
        raise GuestRecoveryError(f"cannot inspect guest process identity {pid}") from error
    command = command_payload.split(b"\0", 1)[0].decode("utf-8", errors="replace")
    return {
        "pid": pid,
        "parent_pid": int(fields[1]),
        "process_state": fields[0],
        "command": Path(command).name,
    }


def process_descendants(pid: int, *, maximum: int = 256) -> list[dict[str, Any]]:
    processes: dict[int, dict[str, Any]] = {}
    try:
        candidates = list(Path("/proc").iterdir())
    except OSError as error:
        raise GuestRecoveryError("cannot inspect exact guest process table") from error
    for candidate in candidates:
        if not candidate.name.isdigit():
            continue
        identity = process_identity(int(candidate.name))
        if identity is not None:
            processes[identity["pid"]] = identity
    descendants: list[dict[str, Any]] = []
    parents = {pid}
    while parents:
        children = sorted(
            (
                value
                for value in processes.values()
                if value["parent_pid"] in parents
                and value["pid"] != pid
                and value not in descendants
            ),
            key=lambda value: value["pid"],
        )
        if not children:
            break
        descendants.extend(children)
        if len(descendants) > maximum:
            raise GuestRecoveryError("exact guest driver process tree is oversized")
        parents = {child["pid"] for child in children}
    return descendants


def file_state(path: Path, *, maximum: int) -> dict[str, Any]:
    try:
        metadata = path.lstat()
    except OSError:
        return {
            "exists": False,
            "regular": False,
            "symlink": False,
            "bytes": None,
            "within_limit": False,
        }
    return {
        "exists": True,
        "regular": stat.S_ISREG(metadata.st_mode),
        "symlink": path.is_symlink(),
        "bytes": metadata.st_size if stat.S_ISREG(metadata.st_mode) else None,
        "within_limit": (
            stat.S_ISREG(metadata.st_mode)
            and not path.is_symlink()
            and metadata.st_size <= maximum
        ),
    }


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
        != "driver-exited-services-stopped"
        or value.get("driver_state") != "exited"
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


def read_driver_identity(
    data_dir: Path,
    token: str,
) -> tuple[str, int | None, str | None, bool]:
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
    token_matches = (
        driver_pid is not None
        and driver_process_state is not None
        and process_has_run_token(driver_pid, token)
    )
    return driver_state, driver_pid, driver_process_state, token_matches


def state_snapshot(
    args: argparse.Namespace,
    data_dir: Path,
    repo_dir: Path,
) -> dict[str, Any]:
    context_dir = repo_dir / ".context" / "cloudbench"
    snapshot: dict[str, Any] = {
        "schema_version": STATE_SCHEMA,
        "version": 1,
        "state": "unsafe",
        "machine_id": args.machine_id,
        "guest_run_token": args.guest_run_token,
        "reason": "exact guest state captured",
        "driver_state": "unreadable",
        "driver_pid": None,
        "driver_process_state": None,
        "driver_token_match": False,
        "driver_descendants": [],
        "services_manifest": file_state(
            context_dir / "services.json",
            maximum=1024 * 1024,
        ),
        "run_json": file_state(Path(args.run_json), maximum=512 * 1024 * 1024),
        "backend_log": file_state(
            Path(args.backend_log),
            maximum=512 * 1024 * 1024,
        ),
        "services_status": None,
        "stopped_service_pids": [],
        "live_service_pids": [],
        "backend_port": None,
        "backend_closed": None,
    }
    try:
        driver_state, driver_pid, driver_process_state, token_matches = (
            read_driver_identity(data_dir, args.guest_run_token)
        )
        descendants = (
            process_descendants(driver_pid)
            if driver_pid is not None and driver_process_state is not None
            else []
        )
    except GuestRecoveryError as error:
        snapshot["reason"] = str(error)
        return snapshot
    snapshot.update(
        {
            "driver_state": driver_state,
            "driver_pid": driver_pid,
            "driver_process_state": driver_process_state,
            "driver_token_match": token_matches,
            "driver_descendants": descendants,
        }
    )
    if driver_state == "running" and driver_process_state is not None and token_matches:
        snapshot["state"] = "active"
    elif driver_state == "exited" and driver_process_state is None:
        snapshot["state"] = "exited"
    return snapshot


def quiesce(args: argparse.Namespace) -> int:
    data_dir = Path(args.data_dir)
    repo_dir = Path(args.repo_dir)
    receipt = Path(args.receipt)
    state_receipt = (
        Path(args.state_receipt)
        if args.state_receipt
        else data_dir / f"cloudbench-guest-state-{args.guest_run_token}.json"
    )
    if (
        SAFE_MACHINE.fullmatch(args.machine_id) is None
        or SAFE_TOKEN.fullmatch(args.guest_run_token) is None
        or not data_dir.is_absolute()
        or not repo_dir.is_absolute()
        or not receipt.is_absolute()
        or not state_receipt.is_absolute()
        or not plain_directory(data_dir)
        or not plain_directory(repo_dir)
        or data_dir.resolve() != data_dir
        or repo_dir.resolve() != repo_dir
        or receipt.parent != data_dir
        or state_receipt.parent != data_dir
    ):
        raise GuestRecoveryError("unsafe exact guest recovery identity")

    snapshot = state_snapshot(args, data_dir, repo_dir)
    context_dir = repo_dir / ".context" / "cloudbench"
    try:
        driver_state = snapshot["driver_state"]
        driver_pid = snapshot["driver_pid"]
        driver_process_state = snapshot["driver_process_state"]
        if snapshot["state"] == "active":
            raise GuestRecoveryError("exact guest driver is still active")
        if snapshot["state"] == "unsafe":
            raise GuestRecoveryError(snapshot["reason"])
        if driver_state == "running":
            raise GuestRecoveryError("running driver does not own the exact guest run")
        if driver_process_state is not None:
            raise GuestRecoveryError("exited guest still has a live driver pid")

        services, services_payload = parse_services(
            context_dir / "services.json",
            repo_dir,
        )
        stopped_pids = service_pids(services)
        live = [pid for pid in stopped_pids if process_state(pid) is not None]
        port = backend_port(services)
        closed = backend_is_closed(port)
        snapshot.update(
            {
                "services_status": services["status"],
                "stopped_service_pids": stopped_pids,
                "live_service_pids": live,
                "backend_port": port,
                "backend_closed": closed,
            }
        )
        if live:
            raise GuestRecoveryError(
                "guest service processes remain live: "
                + ",".join(str(pid) for pid in live)
            )
        if not closed:
            raise GuestRecoveryError(
                "exact guest backend can still create provider sessions"
            )

        run_json_payload = read_bytes(
            Path(args.run_json),
            maximum=512 * 1024 * 1024,
        )
        backend_log_payload = read_bytes(
            Path(args.backend_log),
            maximum=512 * 1024 * 1024,
        )
    except GuestRecoveryError as error:
        snapshot["reason"] = str(error)
        atomic_json(state_receipt, snapshot)
        raise

    reason = "driver-exited-services-stopped"
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
    snapshot["state"] = "quiesced"
    snapshot["reason"] = reason
    snapshot["run_json"] = file_state(
        Path(args.run_json),
        maximum=512 * 1024 * 1024,
    )
    snapshot["backend_log"] = file_state(
        Path(args.backend_log),
        maximum=512 * 1024 * 1024,
    )
    atomic_json(state_receipt, snapshot)
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


def describe_state(args: argparse.Namespace) -> int:
    path = Path(args.receipt)
    payload = read_bytes(path, maximum=1024 * 1024)
    try:
        value = json.loads(payload)
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise GuestRecoveryError("malformed exact guest state receipt") from error
    required = {
        "schema_version",
        "version",
        "state",
        "machine_id",
        "guest_run_token",
        "reason",
        "driver_state",
        "driver_pid",
        "driver_process_state",
        "driver_token_match",
        "driver_descendants",
        "services_manifest",
        "run_json",
        "backend_log",
        "services_status",
        "stopped_service_pids",
        "live_service_pids",
        "backend_port",
        "backend_closed",
    }

    def valid_file_snapshot(candidate: Any) -> bool:
        if not isinstance(candidate, dict) or set(candidate) != {
            "exists",
            "regular",
            "symlink",
            "bytes",
            "within_limit",
        }:
            return False
        if any(
            not isinstance(candidate.get(field), bool)
            for field in ("exists", "regular", "symlink", "within_limit")
        ):
            return False
        size = candidate.get("bytes")
        return size is None or (
            isinstance(size, int)
            and not isinstance(size, bool)
            and size >= 0
        )

    def valid_process(candidate: Any) -> bool:
        if not isinstance(candidate, dict) or set(candidate) != {
            "pid",
            "parent_pid",
            "process_state",
            "command",
        }:
            return False
        return (
            isinstance(candidate.get("pid"), int)
            and not isinstance(candidate["pid"], bool)
            and candidate["pid"] > 1
            and isinstance(candidate.get("parent_pid"), int)
            and not isinstance(candidate["parent_pid"], bool)
            and candidate["parent_pid"] >= 0
            and isinstance(candidate.get("process_state"), str)
            and candidate["process_state"] != ""
            and "\t" not in candidate["process_state"]
            and "\n" not in candidate["process_state"]
            and isinstance(candidate.get("command"), str)
            and "\t" not in candidate["command"]
            and "\n" not in candidate["command"]
        )

    driver_pid = value.get("driver_pid") if isinstance(value, dict) else None
    driver_process_state = (
        value.get("driver_process_state") if isinstance(value, dict) else None
    )
    stopped_pids = value.get("stopped_service_pids") if isinstance(value, dict) else None
    live_pids = value.get("live_service_pids") if isinstance(value, dict) else None
    descendants = value.get("driver_descendants") if isinstance(value, dict) else None
    backend_port_value = value.get("backend_port") if isinstance(value, dict) else None
    backend_closed_value = (
        value.get("backend_closed") if isinstance(value, dict) else None
    )
    if (
        not isinstance(value, dict)
        or set(value) != required
        or value.get("schema_version") != STATE_SCHEMA
        or value.get("version") != 1
        or value.get("state") not in {"active", "exited", "unsafe", "quiesced"}
        or value.get("machine_id") != args.machine_id
        or value.get("guest_run_token") != args.guest_run_token
        or not isinstance(value.get("reason"), str)
        or len(value["reason"]) > 4096
        or "\t" in value["reason"]
        or "\n" in value["reason"]
        or value.get("driver_state") not in {"running", "exited", "unreadable"}
        or (
            driver_pid is not None
            and (
                not isinstance(driver_pid, int)
                or isinstance(driver_pid, bool)
                or driver_pid <= 1
            )
        )
        or (
            driver_process_state is not None
            and (
                not isinstance(driver_process_state, str)
                or driver_process_state == ""
                or "\t" in driver_process_state
                or "\n" in driver_process_state
            )
        )
        or not isinstance(value.get("driver_token_match"), bool)
        or not isinstance(descendants, list)
        or len(descendants) > 256
        or any(not valid_process(candidate) for candidate in descendants)
        or not valid_file_snapshot(value.get("services_manifest"))
        or not valid_file_snapshot(value.get("run_json"))
        or not valid_file_snapshot(value.get("backend_log"))
        or value.get("services_status") not in {None, "stopped"}
        or not isinstance(stopped_pids, list)
        or any(
            not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1
            for pid in stopped_pids
        )
        or len(stopped_pids) != len(set(stopped_pids))
        or not isinstance(live_pids, list)
        or any(
            not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1
            for pid in live_pids
        )
        or len(live_pids) != len(set(live_pids))
        or (
            backend_port_value is not None
            and (
                not isinstance(backend_port_value, int)
                or isinstance(backend_port_value, bool)
                or not 1 <= backend_port_value <= 65_535
            )
        )
        or (
            backend_closed_value is not None
            and not isinstance(backend_closed_value, bool)
        )
    ):
        raise GuestRecoveryError("exact guest state receipt has the wrong owner")
    if value["state"] == "active" and not (
        value["driver_state"] == "running"
        and driver_pid is not None
        and driver_process_state is not None
        and value["driver_token_match"] is True
    ):
        raise GuestRecoveryError("exact active guest state is inconsistent")
    if value["state"] in {"exited", "quiesced"} and not (
        value["driver_state"] == "exited"
        and driver_process_state is None
        and value["driver_token_match"] is False
        and not descendants
    ):
        raise GuestRecoveryError("exact exited guest state is inconsistent")
    if value["state"] == "quiesced" and not (
        value["reason"] == "driver-exited-services-stopped"
        and value["services_status"] == "stopped"
        and not live_pids
        and backend_port_value is not None
        and backend_closed_value is True
        and value["services_manifest"]["within_limit"] is True
        and value["run_json"]["within_limit"] is True
        and value["backend_log"]["within_limit"] is True
    ):
        raise GuestRecoveryError("exact quiesced guest state is inconsistent")

    def available_evidence(candidate: dict[str, Any]) -> bool:
        return (
            candidate["exists"] is True
            and candidate["regular"] is True
            and candidate["symlink"] is False
            and isinstance(candidate["bytes"], int)
            and candidate["within_limit"] is True
        )

    state_kind = value["state"]
    if (
        state_kind == "exited"
        and value["reason"].startswith("missing regular exact guest evidence: ")
        and value["services_status"] == "stopped"
        and stopped_pids
        and not live_pids
        and backend_port_value is not None
        and backend_closed_value is True
        and available_evidence(value["services_manifest"])
        and value["run_json"]
        == {
            "exists": False,
            "regular": False,
            "symlink": False,
            "bytes": None,
            "within_limit": False,
        }
        and available_evidence(value["backend_log"])
    ):
        state_kind = "exited-no-run"
    print(
        state_kind,
        value["driver_state"],
        len(value["driver_descendants"]),
        value["reason"],
        sep="\t",
    )
    return 0


def read_json_object(path: Path, *, maximum: int) -> tuple[dict[str, Any], bytes]:
    payload = read_bytes(path, maximum=maximum)
    try:
        value = json.loads(payload)
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise GuestRecoveryError(f"malformed exact guest JSON evidence: {path}") from error
    if not isinstance(value, dict):
        raise GuestRecoveryError(f"exact guest JSON evidence is not an object: {path}")
    return value, payload


def parse_zero_run(path: Path) -> tuple[str, str]:
    value, payload = read_json_object(path, maximum=512 * 1024 * 1024)
    tasks = value.get("tasks")
    if not isinstance(tasks, list) or len(tasks) != 1 or not isinstance(tasks[0], dict):
        raise GuestRecoveryError("run evidence is not bound to exactly one benchmark")
    root_agent_id = tasks[0].get("agent_id")
    if (
        not isinstance(root_agent_id, str)
        or SAFE_AGENT.fullmatch(root_agent_id) is None
    ):
        raise GuestRecoveryError("run evidence has no exact root agent")
    return root_agent_id.lower(), hashlib.sha256(payload).hexdigest()


def validate_zero_backend(path: Path, root_agent_id: str) -> tuple[str, str]:
    payload = read_bytes(path, maximum=512 * 1024 * 1024)
    try:
        text = ANSI.sub("", payload.decode("utf-8"))
    except UnicodeDecodeError as error:
        raise GuestRecoveryError("backend evidence is not UTF-8") from error
    lines = [line for line in text.splitlines() if line.strip()]
    starts = [
        index
        for index, line in enumerate(lines)
        if "[Server] Server started" in line
    ]
    shutdowns = [
        index
        for index, line in enumerate(lines)
        if "[Server] SIGTERM received, closing server..." in line
    ]
    if (
        root_agent_id not in text.lower()
        or len(starts) != 1
        or not shutdowns
        or starts[0] >= shutdowns[0]
        or shutdowns != list(range(shutdowns[0], len(lines)))
    ):
        raise GuestRecoveryError(
            "backend evidence has no complete exact-root lifecycle boundary"
        )
    provider_markers = (
        "Created Kernel browser session",
        "Reset restored Kernel profile tabs",
        "Failed to evict invalid Kernel session",
        "Created Steel session:",
        "Steel Session:",
        "Creating Steel browser session",
        "Session creation attempt ",
    )
    if any(marker in text for marker in provider_markers) or re.search(
        r"Kernel session [A-Za-z0-9_-]+ failed (?:tab reset|CDP validation)",
        text,
    ):
        raise GuestRecoveryError(
            "complete backend evidence contains provider allocation events"
        )
    if re.search(
        r"\bmodel=BrowserSession\b[^\n]*\boperation="
        r"(?:create|update|updateMany|upsert|delete|deleteMany)\b",
        text,
    ):
        raise GuestRecoveryError(
            "complete backend evidence contains BrowserSession mutations"
        )
    return text, hashlib.sha256(payload).hexdigest()


def exact_system_postgres_labels(database: dict[str, Any]) -> bool:
    container = database.get("container")
    volume = database.get("volume")
    database_name = database.get("name")
    if not all(isinstance(value, str) for value in (container, volume, database_name)):
        return False
    if container == "" and volume == "":
        return True

    container_prefix = "victoria-db-"
    volume_prefix = "victoria-pgdata-"
    if not container.startswith(container_prefix) or not volume.startswith(volume_prefix):
        return False
    container_suffix = container.removeprefix(container_prefix)
    volume_suffix = volume.removeprefix(volume_prefix)
    if (
        container_suffix != volume_suffix
        or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,47}", container_suffix)
        is None
    ):
        return False
    legacy_database_name = "victoria_bench_" + re.sub(
        r"[^A-Za-z0-9]",
        "_",
        container_suffix,
    )
    return database_name == legacy_database_name


def parse_zero_services(path: Path) -> tuple[str, int, str]:
    value, payload = read_json_object(path, maximum=1024 * 1024)
    database = value.get("database")
    expected_repo = path.parent.parent.parent
    if (
        not path.is_absolute()
        or path.resolve() != path
        or not plain_directory(expected_repo)
        or value.get("schema_version") != 1
        or value.get("benchmark_mode") is not True
        or value.get("worktree") != str(expected_repo)
        or value.get("status") != "stopped"
        or not isinstance(database, dict)
        or database.get("owned_by_run_sh") is not True
        or database.get("use_system_postgres") is not True
        or not exact_system_postgres_labels(database)
    ):
        raise GuestRecoveryError(
            "services evidence has no exact isolated stopped database identity"
        )
    database_name = database.get("name")
    runtime_port = database.get("runtime_port")
    if (
        not isinstance(database_name, str)
        or SAFE_DATABASE.fullmatch(database_name) is None
        or not isinstance(runtime_port, int)
        or isinstance(runtime_port, bool)
        or not 1 <= runtime_port <= 65_535
    ):
        raise GuestRecoveryError("services evidence has an unsafe database identity")
    return database_name, runtime_port, hashlib.sha256(payload).hexdigest()


def validate_zero_quiescence(
    path: Path,
    *,
    machine_id: str,
    guest_run_token: str,
    services_sha256: str,
    run_json_sha256: str,
    backend_log_sha256: str,
) -> str:
    value, payload = read_json_object(path, maximum=1024 * 1024)
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
        set(value) != required_fields
        or value.get("schema_version") != SCHEMA
        or value.get("version") != 1
        or value.get("state") != "quiesced"
        or value.get("machine_id") != machine_id
        or value.get("guest_run_token") != guest_run_token
        or value.get("reason") != "driver-exited-services-stopped"
        or value.get("driver_state") != "exited"
        or value.get("driver_pid") is not None
        or value.get("driver_process_state") is not None
        or value.get("services_sha256") != services_sha256
        or value.get("run_json_sha256") != run_json_sha256
        or value.get("backend_log_sha256") != backend_log_sha256
    ):
        raise GuestRecoveryError(
            "quiescence evidence does not bind the exact stopped database/run"
        )
    return hashlib.sha256(payload).hexdigest()


def run_exact_psql(
    command: str,
    *,
    database: str,
    port: int,
    sql: str,
) -> str:
    if not executable_file(Path(command)):
        raise GuestRecoveryError("exact psql command is unavailable")
    environment = os.environ.copy()
    environment["PGPASSWORD"] = "postgres"
    try:
        result = subprocess.run(
            [
                command,
                "-X",
                "-q",
                "-A",
                "-t",
                "-v",
                "ON_ERROR_STOP=1",
                "-h",
                "localhost",
                "-p",
                str(port),
                "-U",
                "postgres",
                "-d",
                database,
                "-c",
                sql,
            ],
            env=environment,
            text=True,
            capture_output=True,
            check=False,
            timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise GuestRecoveryError("exact root-bound database query failed") from error
    if result.returncode != 0:
        raise GuestRecoveryError("exact root-bound database query failed")
    return result.stdout.strip()


def root_tree_query_sql(root_agent_id: str, *, include_sealing_state: bool = False) -> str:
    # browser_sessions lists provider-backed rows only. Agent creation gives every
    # agent a logical browser with no provider session ("sessionId" NULL); the
    # schema's BrowserSession_unmaterialized_check guarantees such a row is only
    # that unmaterialized identity, so it holds nothing to release or audit.
    statement = f"""
WITH RECURSIVE tree AS (
  SELECT id, "parentAgentId", "deletedAt"
  FROM "Agent"
  WHERE id = '{root_agent_id}'
  UNION
  SELECT child.id, child."parentAgentId", child."deletedAt"
  FROM "Agent" child
  JOIN tree parent ON child."parentAgentId" = parent.id
)
SELECT json_build_object(
  'root_exists', EXISTS(
    SELECT 1 FROM "Agent" WHERE id = '{root_agent_id}'
  ),
  'root_deleted', COALESCE((
    SELECT "deletedAt" IS NOT NULL FROM "Agent" WHERE id = '{root_agent_id}'
  ), false),
  'tree_agent_ids', COALESCE((
    SELECT json_agg(id ORDER BY id) FROM tree
  ), '[]'::json),
  'browser_sessions', COALESCE((
    SELECT json_agg(
      json_build_object(
        'agent_id', session."agentId",
        'session_id', session."sessionId",
        'provider', session.provider
      )
      ORDER BY session."sessionId"
    )
    FROM "BrowserSession" session
    WHERE session."agentId" IN (SELECT id FROM tree)
      AND session."sessionId" IS NOT NULL
  ), '[]'::json)
)::text;
""".strip()
    if include_sealing_state:
        statement = statement.replace(
            "'root_exists', EXISTS(",
            f"'root_user_id', (SELECT \"userId\" FROM \"Agent\" WHERE id = '{root_agent_id}'), "
            "'unsealed_tree_agent_ids', COALESCE((SELECT json_agg(id ORDER BY id) FROM tree WHERE \"deletedAt\" IS NULL), '[]'::json), "
            """'purchase_cleanup', COALESCE((
              SELECT json_agg(json_build_object(
                'purchase_id', purchase.id,
                'agent_id', purchase."agentId",
                'status', purchase.status,
                'card_id', purchase."cardId",
                'stripe_payment_intent_id', purchase."stripePaymentIntentId",
                'total_cents', purchase."totalCents",
                'funding_status', funding.status,
                'provider_transfer_id', funding."providerTransferId",
                'reclaim_provider_transfer_id', funding."reclaimProviderTransferId"
              ) ORDER BY purchase.id)
              FROM "PurchaseSpend" purchase
              LEFT JOIN "PurchaseWalletFunding" funding ON funding."purchaseId" = purchase.id
              WHERE purchase."agentId" IN (SELECT id FROM tree)
            ), '[]'::json), 'root_exists', EXISTS(""",
            1,
        )
    return " ".join(statement.split())


def parse_root_tree_query(payload: str, root_agent_id: str) -> dict[str, Any]:
    lines = [line for line in payload.splitlines() if line.strip()]
    if len(lines) != 1:
        raise GuestRecoveryError("exact root-bound database query is not canonical")
    try:
        value = json.loads(lines[0])
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise GuestRecoveryError("exact root-bound database query is malformed") from error
    if not isinstance(value, dict) or set(value) != {
        "root_exists",
        "root_deleted",
        "tree_agent_ids",
        "browser_sessions",
    }:
        raise GuestRecoveryError("exact root-bound database query has the wrong shape")
    tree = value.get("tree_agent_ids")
    sessions = value.get("browser_sessions")
    if (
        not isinstance(value.get("root_exists"), bool)
        or not isinstance(value.get("root_deleted"), bool)
        or not isinstance(tree, list)
        or any(
            not isinstance(agent_id, str) or SAFE_AGENT.fullmatch(agent_id) is None
            for agent_id in tree
        )
        or len(tree) != len(set(tree))
        or not isinstance(sessions, list)
        or (value["root_exists"] and root_agent_id not in tree)
        or (not value["root_exists"] and tree)
    ):
        raise GuestRecoveryError("exact root-bound database result is inconsistent")
    if sessions:
        raise GuestRecoveryError(
            "exact root tree contains provider-backed BrowserSession rows"
        )
    return value


def delete_exact_agent_tree(
    command: str,
    *,
    database_name: str,
    runtime_port: int,
    root_agent_id: str,
) -> None:
    sql = f"""
WITH RECURSIVE tree AS (
  SELECT id FROM "Agent" WHERE id = '{root_agent_id}'
  UNION
  SELECT child.id
  FROM "Agent" child
  JOIN tree parent ON child."parentAgentId" = parent.id
)
UPDATE "Agent"
SET "deletedAt" = COALESCE("deletedAt", NOW())
WHERE id IN (SELECT id FROM tree);
""".strip()
    run_exact_psql(
        command,
        database=database_name,
        port=runtime_port,
        sql=sql,
    )


def prove_zero_allocation(args: argparse.Namespace) -> int:
    if (
        SAFE_MACHINE.fullmatch(args.machine_id) is None
        or SAFE_TOKEN.fullmatch(args.guest_run_token) is None
        or not Path(args.receipt).is_absolute()
        or not plain_directory(Path(args.receipt).parent)
    ):
        raise GuestRecoveryError("unsafe exact zero-allocation identity")
    services_path = Path(args.services)
    run_json_path = Path(args.run_json)
    backend_log_path = Path(args.backend_log)
    quiescence_path = Path(args.quiescence_receipt)
    database_name, runtime_port, services_sha = parse_zero_services(services_path)
    root_agent_id, run_sha = parse_zero_run(run_json_path)
    _, backend_sha = validate_zero_backend(backend_log_path, root_agent_id)
    quiescence_sha = validate_zero_quiescence(
        quiescence_path,
        machine_id=args.machine_id,
        guest_run_token=args.guest_run_token,
        services_sha256=services_sha,
        run_json_sha256=run_sha,
        backend_log_sha256=backend_sha,
    )
    proof_base: dict[str, Any] = {
        "schema_version": ZERO_SCHEMA,
        "version": 1,
        "machine_id": args.machine_id,
        "guest_run_token": args.guest_run_token,
        "root_agent_id": root_agent_id,
        "database_name": database_name,
        "services_sha256": services_sha,
        "run_json_sha256": run_sha,
        "backend_log_sha256": backend_sha,
        "quiescence_receipt_sha256": quiescence_sha,
    }
    receipt_path = Path(args.receipt)
    if receipt_path.exists() or receipt_path.is_symlink():
        existing, _ = read_json_object(receipt_path, maximum=1024 * 1024)
        if (
            set(existing)
            != {
                *proof_base,
                "root_disposition",
                "database_state",
                "tree_agent_ids",
                "browser_sessions",
            }
            or any(existing.get(key) != value for key, value in proof_base.items())
        ):
            raise GuestRecoveryError(
                "existing zero-allocation proof has the wrong exact owner"
            )
        tree = existing.get("tree_agent_ids")
        disposition = existing.get("root_disposition")
        database_state = existing.get("database_state")
        if (
            disposition not in {
                "database-absent",
                "root-absent",
                "root-already-deleted",
                "deleted-exact-tree",
            }
            or database_state not in {"absent", "present"}
            or not isinstance(tree, list)
            or any(
                not isinstance(agent_id, str)
                or SAFE_AGENT.fullmatch(agent_id) is None
                for agent_id in tree
            )
            or len(tree) != len(set(tree))
            or existing.get("browser_sessions") != []
            or (
                disposition == "database-absent"
                and (database_state != "absent" or tree)
            )
            or (
                disposition == "root-absent"
                and (database_state != "present" or tree)
            )
            or (
                disposition in {"root-already-deleted", "deleted-exact-tree"}
                and (database_state != "present" or root_agent_id not in tree)
            )
        ):
            raise GuestRecoveryError(
                "existing zero-allocation proof is not positive and exact"
            )
        return 0

    catalog_sql = (
        "SELECT datname FROM pg_database "
        f"WHERE datname = '{database_name}';"
    )
    catalog_result = run_exact_psql(
        args.psql_command,
        database="postgres",
        port=runtime_port,
        sql=catalog_sql,
    )
    catalog_rows = [row for row in catalog_result.splitlines() if row.strip()]
    if not catalog_rows:
        proof = {
            **proof_base,
            "root_disposition": "database-absent",
            "database_state": "absent",
            "tree_agent_ids": [],
            "browser_sessions": [],
        }
        atomic_json(receipt_path, proof)
        return 0
    if catalog_rows != [database_name]:
        raise GuestRecoveryError("exact isolated database lookup is ambiguous")

    query_sql = root_tree_query_sql(root_agent_id)
    before = parse_root_tree_query(
        run_exact_psql(
            args.psql_command,
            database=database_name,
            port=runtime_port,
            sql=query_sql,
        ),
        root_agent_id,
    )
    if not before["root_exists"]:
        disposition = "root-absent"
        final = before
    elif before["root_deleted"]:
        disposition = "root-already-deleted"
        final = before
    else:
        delete_exact_agent_tree(
            args.psql_command,
            database_name=database_name,
            runtime_port=runtime_port,
            root_agent_id=root_agent_id,
        )
        final = parse_root_tree_query(
            run_exact_psql(
                args.psql_command,
                database=database_name,
                port=runtime_port,
                sql=query_sql,
            ),
            root_agent_id,
        )
        if (
            not final["root_exists"]
            or not final["root_deleted"]
            or final["tree_agent_ids"] != before["tree_agent_ids"]
        ):
            raise GuestRecoveryError(
                "exact root tree did not reach an idempotently deleted state"
            )
        disposition = "deleted-exact-tree"
    proof = {
        **proof_base,
        "root_disposition": disposition,
        "database_state": "present",
        "tree_agent_ids": final["tree_agent_ids"],
        "browser_sessions": [],
    }
    atomic_json(receipt_path, proof)
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
    command.add_argument("--state-receipt")
    command.add_argument(
        "--run-json",
        default="/data/repo/.context/cloudbench/run.json",
    )
    command.add_argument(
        "--backend-log",
        default="/data/repo/.context/cloudbench/logs/backend.log",
    )
    state = subparsers.add_parser("describe-state")
    state.add_argument("--machine-id", required=True)
    state.add_argument("--guest-run-token", required=True)
    state.add_argument("--receipt", required=True)
    zero = subparsers.add_parser("prove-zero-allocation")
    zero.add_argument("--machine-id", required=True)
    zero.add_argument("--guest-run-token", required=True)
    zero.add_argument("--services", required=True)
    zero.add_argument("--run-json", required=True)
    zero.add_argument("--backend-log", required=True)
    zero.add_argument("--quiescence-receipt", required=True)
    zero.add_argument("--receipt", required=True)
    zero.add_argument("--psql-command", default="/usr/bin/psql")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.command == "quiesce":
        return quiesce(args)
    if args.command == "describe-state":
        return describe_state(args)
    if args.command == "prove-zero-allocation":
        return prove_zero_allocation(args)
    raise GuestRecoveryError("unknown guest recovery command")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except GuestRecoveryError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1) from error
