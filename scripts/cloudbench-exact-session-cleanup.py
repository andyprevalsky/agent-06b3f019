#!/usr/bin/env python3
"""Recover exact guest-cleanup receipts without provider inventory calls."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


SAFE_NAME = re.compile(r"[A-Za-z0-9._-]+")
SAFE_OWNER = re.compile(r"[0-9a-f]{32}")
SAFE_MACHINE = re.compile(r"[0-9a-f]+")
SAFE_SESSION = re.compile(r"[A-Za-z0-9_-]{8,128}")
SAFE_AGENT = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
    re.IGNORECASE,
)
ANSI = re.compile(r"\x1b\[[0-9;]*m")
RUNNER_FIELDS = {"version", "token", "state"}
SCHEMA = "cloudbench-guest-cleanup-recovery-v1"


class CleanupEvidenceError(RuntimeError):
    """The exact evidence cannot safely authorize cleanup."""


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


def read_bytes(path: Path, *, maximum: int = 512 * 1024 * 1024) -> bytes:
    if not regular_file(path):
        raise CleanupEvidenceError(f"missing regular evidence file: {path}")
    metadata = path.stat()
    if metadata.st_size > maximum:
        raise CleanupEvidenceError(f"oversized evidence file: {path}")
    return path.read_bytes()


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def canonical_digest(value: dict[str, Any]) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return sha256_bytes(payload)


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    parent = path.parent
    if not plain_directory(parent):
        raise CleanupEvidenceError(f"unsafe receipt parent: {parent}")
    temporary = parent / f".{path.name}.{os.getpid()}.tmp"
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
        directory = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def identity(args: argparse.Namespace) -> dict[str, str]:
    output = Path(args.output_dir)
    if (
        SAFE_OWNER.fullmatch(args.owner) is None
        or SAFE_NAME.fullmatch(args.fleet_run_id) is None
        or SAFE_NAME.fullmatch(args.bench) is None
        or SAFE_MACHINE.fullmatch(args.machine_id) is None
        or SAFE_NAME.fullmatch(args.guest_run_token) is None
        or not output.is_absolute()
        or not plain_directory(output)
        or output.resolve() != output
    ):
        raise CleanupEvidenceError("unsafe exact cleanup identity")
    return {
        "fleet_owner_token": args.owner,
        "fleet_run_id": args.fleet_run_id,
        "bench": args.bench,
        "machine_id": args.machine_id,
        "output_dir": str(output),
        "guest_run_token": args.guest_run_token,
    }


def parse_runner_status(payload: bytes, expected_token: str) -> dict[str, str]:
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise CleanupEvidenceError("runner receipt is not UTF-8") from error
    parsed: dict[str, str] = {}
    for line in text.splitlines():
        key, separator, value = line.partition("=")
        if not separator or key in parsed or key not in RUNNER_FIELDS:
            raise CleanupEvidenceError("runner receipt is not canonical")
        parsed[key] = value
    if (
        set(parsed) != RUNNER_FIELDS
        or parsed["version"] != "1"
        or parsed["token"] != expected_token
        or parsed["state"] != "clean"
    ):
        raise CleanupEvidenceError("runner receipt does not prove exact clean state")
    return parsed


def read_json_object(path: Path, *, maximum: int = 16 * 1024 * 1024) -> dict[str, Any]:
    payload = read_bytes(path, maximum=maximum)
    try:
        value = json.loads(payload)
    except (TypeError, ValueError) as error:
        raise CleanupEvidenceError(f"malformed JSON evidence: {path}") from error
    if not isinstance(value, dict):
        raise CleanupEvidenceError(f"JSON evidence is not an object: {path}")
    return value


def validate_existing(path: Path, expected: dict[str, Any]) -> bool:
    if not path.exists() and not path.is_symlink():
        return False
    value = read_json_object(path)
    if value != expected:
        raise CleanupEvidenceError(f"existing receipt does not match exact evidence: {path}")
    return True


def recover_runner_receipt(args: argparse.Namespace) -> int:
    exact_identity = identity(args)
    source = Path(args.source)
    payload = read_bytes(source, maximum=65_536)
    parsed = parse_runner_status(payload, args.guest_run_token)
    value: dict[str, Any] = {
        "schema_version": SCHEMA,
        "version": 1,
        "kind": "runner-cleanup",
        **exact_identity,
        "runner_receipt": {
            **parsed,
            "sha256": sha256_bytes(payload),
        },
    }
    receipt = Path(args.receipt)
    if not validate_existing(receipt, value):
        atomic_json(receipt, value)
    return 0


def parse_run_identity(path: Path, bench: str) -> tuple[str, str]:
    payload = read_bytes(path)
    try:
        value = json.loads(payload)
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise CleanupEvidenceError("run record is not valid JSON") from error
    if not isinstance(value, dict) or not isinstance(value.get("tasks"), list):
        raise CleanupEvidenceError("run record has no canonical task list")
    tasks = value["tasks"]
    matches = [
        task
        for task in tasks
        if isinstance(task, dict) and task.get("name") == bench
    ]
    if len(tasks) != 1 or len(matches) != 1:
        raise CleanupEvidenceError("run record is not bound to exactly one benchmark")
    root_agent_id = matches[0].get("agent_id")
    if not isinstance(root_agent_id, str) or SAFE_AGENT.fullmatch(root_agent_id) is None:
        raise CleanupEvidenceError("run record has no exact root agent")
    return root_agent_id, sha256_bytes(payload)


def add_session(sessions: dict[str, set[str]], provider: str, session_id: str) -> None:
    if SAFE_SESSION.fullmatch(session_id) is None:
        raise CleanupEvidenceError(f"unsafe {provider} session identifier in evidence")
    sessions[provider].add(session_id)


def json_log_entry(line: str) -> dict[str, Any] | None:
    try:
        value = json.loads(line.strip())
    except (TypeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def kernel_marker_sessions(text: str, marker: str) -> list[str]:
    session_ids: list[str] = []
    for line in text.splitlines():
        if marker not in line:
            continue
        match = re.search(r"\bsessionId=([A-Za-z0-9_-]+)", line)
        if match is not None:
            session_ids.append(match.group(1))
            continue
        entry = json_log_entry(line)
        session_id = entry.get("sessionId") if entry is not None else None
        if (
            entry is None
            or marker not in str(entry.get("message", ""))
            or not isinstance(session_id, str)
        ):
            raise CleanupEvidenceError(f"{marker} evidence omitted an exact session id")
        session_ids.append(session_id)
    return session_ids


def steel_response_sessions(text: str) -> list[str]:
    marker = "Steel Session:"
    decoder = json.JSONDecoder()
    session_ids: list[str] = []
    offset = 0
    while True:
        position = text.find(marker, offset)
        if position < 0:
            break
        line_end = text.find("\n", position)
        if line_end < 0:
            line_end = len(text)
        line_start = text.rfind("\n", 0, position) + 1
        line = text[line_start:line_end]
        entry = json_log_entry(line)
        if entry is not None:
            message = entry.get("message")
            if not isinstance(message, str) or marker not in message:
                raise CleanupEvidenceError("Steel provider response log is malformed")
            candidate = message.split(marker, 1)[1].lstrip()
        else:
            candidate = text[position + len(marker) :].lstrip()
        try:
            value, _ = decoder.raw_decode(candidate)
        except (TypeError, ValueError, json.JSONDecodeError) as error:
            raise CleanupEvidenceError("Steel provider response log is malformed") from error
        session_id = value.get("id") if isinstance(value, dict) else None
        if not isinstance(session_id, str):
            raise CleanupEvidenceError("Steel provider response omitted its exact session id")
        session_ids.append(session_id)
        offset = position + len(marker)
    return session_ids


def parse_session_evidence(path: Path, root_agent_id: str) -> tuple[dict[str, list[str]], str]:
    payload = read_bytes(path)
    try:
        text = ANSI.sub("", payload.decode("utf-8"))
    except UnicodeDecodeError as error:
        raise CleanupEvidenceError("backend log is not UTF-8") from error
    if root_agent_id not in text:
        raise CleanupEvidenceError("backend log is not bound to the exact root agent")

    sessions: dict[str, set[str]] = {"kernel": set(), "steel": set()}
    kernel_markers = (
        "Created Kernel browser session",
        "Reset restored Kernel profile tabs",
        "Failed to evict invalid Kernel session",
    )
    for marker in kernel_markers:
        for session_id in kernel_marker_sessions(text, marker):
            add_session(sessions, "kernel", session_id)
    for match in re.finditer(
        r"Kernel session ([A-Za-z0-9_-]+) failed (?:tab reset|CDP validation)",
        text,
    ):
        add_session(sessions, "kernel", match.group(1))

    for line in text.splitlines():
        if "Created Steel session:" not in line:
            continue
        entry = json_log_entry(line)
        message = str(entry.get("message", "")) if entry is not None else line
        match = re.search(r"Created Steel session:\s*([A-Za-z0-9_-]+)", message)
        if match is None:
            raise CleanupEvidenceError("Created Steel session evidence omitted an exact session id")
        add_session(sessions, "steel", match.group(1))
    for session_id in steel_response_sessions(text):
        add_session(sessions, "steel", session_id)

    parsed = {
        provider: sorted(provider_sessions)
        for provider, provider_sessions in sessions.items()
    }
    if not parsed["kernel"] and not parsed["steel"]:
        raise CleanupEvidenceError(
            "durable backend evidence contains no exact provider session identity"
        )
    return parsed, sha256_bytes(payload)


def validate_quiescence(
    path: Path,
    machine_id: str,
    guest_run_token: str,
    run_json_sha256: str,
    backend_log_sha256: str,
) -> str:
    payload = read_bytes(path, maximum=1024 * 1024)
    try:
        value = json.loads(payload)
    except (TypeError, ValueError) as error:
        raise CleanupEvidenceError("guest quiescence receipt is malformed") from error
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
        or value.get("schema_version") != "cloudbench-guest-quiescence-v1"
        or value.get("version") != 1
        or value.get("state") != "quiesced"
        or value.get("machine_id") != machine_id
        or value.get("guest_run_token") != guest_run_token
        or value.get("reason") not in {
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
        or not isinstance(value.get("services_sha256"), str)
        or re.fullmatch(r"[0-9a-f]{64}", value["services_sha256"]) is None
        or value.get("run_json_sha256") != run_json_sha256
        or value.get("backend_log_sha256") != backend_log_sha256
    ):
        raise CleanupEvidenceError("guest quiescence receipt does not match exact Machine/run")
    return sha256_bytes(payload)


def provider_manifest(args: argparse.Namespace) -> dict[str, Any]:
    exact_identity = identity(args)
    root_agent_id, run_sha = parse_run_identity(Path(args.run_json), args.bench)
    sessions, backend_sha = parse_session_evidence(Path(args.backend_log), root_agent_id)
    quiescence_sha = validate_quiescence(
        Path(args.quiescence_receipt),
        args.machine_id,
        args.guest_run_token,
        run_sha,
        backend_sha,
    )
    return {
        "schema_version": SCHEMA,
        "version": 1,
        "kind": "provider-exact-manifest",
        **exact_identity,
        "root_agent_id": root_agent_id,
        "sessions": sessions,
        "evidence": {
            "run_json_sha256": run_sha,
            "backend_log_sha256": backend_sha,
            "quiescence_receipt_sha256": quiescence_sha,
        },
    }


def publish_manifest(args: argparse.Namespace) -> dict[str, Any]:
    manifest = provider_manifest(args)
    path = Path(args.manifest)
    if not validate_existing(path, manifest):
        atomic_json(path, manifest)
    return manifest


def load_env_value(name: str, paths: tuple[Path, ...]) -> str:
    inherited = os.environ.get(name, "").strip()
    if inherited:
        return inherited
    for path in paths:
        if not regular_file(path):
            continue
        for raw in path.read_text(encoding="utf-8").splitlines():
            key, separator, value = raw.partition("=")
            if separator and key == name:
                return value.strip().strip('"').strip("'")
    return ""


def provider_request(provider: str, session_id: str, env_paths: tuple[Path, ...]) -> tuple[int, str]:
    if provider == "kernel":
        api_key = load_env_value("KERNEL_API_KEY", env_paths)
        base_url = load_env_value("KERNEL_API_BASE_URL", env_paths) or "https://api.onkernel.com"
        method = "DELETE"
        url = f"{base_url.rstrip('/')}/browsers/{urllib.parse.quote(session_id, safe='')}"
        headers = {"Authorization": f"Bearer {api_key}"}
        body = None
    elif provider == "steel":
        api_key = load_env_value("STEEL_API_KEY", env_paths)
        base_url = load_env_value("STEEL_BASE_URL", env_paths) or "https://api.steel.dev"
        method = "POST"
        url = f"{base_url.rstrip('/')}/v1/sessions/{urllib.parse.quote(session_id, safe='')}/release"
        headers = {
            "steel-api-key": api_key,
            "Content-Type": "application/json",
        }
        body = b"{}"
    else:
        raise CleanupEvidenceError(f"unsupported exact cleanup provider: {provider}")
    if not api_key:
        raise CleanupEvidenceError(f"{provider} cleanup credential is missing")

    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            status = int(response.status)
            response_body = response.read(65_537)
    except urllib.error.HTTPError as error:
        status = int(error.code)
        response_body = error.read(65_537)
    except (OSError, urllib.error.URLError) as error:
        raise CleanupEvidenceError(
            f"{provider} exact session cleanup transport failed for {session_id}"
        ) from error
    if len(response_body) > 65_536:
        raise CleanupEvidenceError(f"{provider} cleanup response is oversized")

    if provider == "kernel":
        if status not in {204, 404}:
            raise CleanupEvidenceError(
                f"Kernel exact session cleanup failed for {session_id}: HTTP {status}"
            )
        return status, sha256_bytes(response_body)

    if status == 404:
        return status, sha256_bytes(response_body)
    if status != 200:
        raise CleanupEvidenceError(
            f"Steel exact session cleanup failed for {session_id}: HTTP {status}"
        )
    try:
        steel_response = json.loads(response_body)
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise CleanupEvidenceError("Steel cleanup success response is not valid JSON") from error
    if not isinstance(steel_response, dict) or steel_response.get("success") is not True:
        raise CleanupEvidenceError("Steel cleanup response did not confirm success")
    return status, sha256_bytes(response_body)


def validate_provider_receipt(receipt: dict[str, Any], manifest: dict[str, Any]) -> bool:
    expected_fields = {
        "schema_version",
        "version",
        "kind",
        "fleet_owner_token",
        "fleet_run_id",
        "bench",
        "machine_id",
        "output_dir",
        "guest_run_token",
        "root_agent_id",
        "manifest_sha256",
        "results",
    }
    if (
        set(receipt) != expected_fields
        or receipt.get("schema_version") != SCHEMA
        or receipt.get("version") != 1
        or receipt.get("kind") != "provider-exact-cleanup"
    ):
        return False
    if receipt.get("manifest_sha256") != canonical_digest(manifest):
        return False
    for field in (
        "fleet_owner_token",
        "fleet_run_id",
        "bench",
        "machine_id",
        "output_dir",
        "guest_run_token",
        "root_agent_id",
    ):
        if receipt.get(field) != manifest.get(field):
            return False
    expected = [
        (provider, session_id)
        for provider in ("kernel", "steel")
        for session_id in manifest["sessions"][provider]
    ]
    results = receipt.get("results")
    if not isinstance(results, list) or len(results) != len(expected):
        return False
    observed: list[tuple[str, str]] = []
    for result in results:
        if not isinstance(result, dict):
            return False
        provider = result.get("provider")
        session_id = result.get("session_id")
        status = result.get("http_status")
        body_sha = result.get("response_sha256")
        if (
            provider not in {"kernel", "steel"}
            or not isinstance(session_id, str)
            or not isinstance(status, int)
            or not isinstance(body_sha, str)
            or re.fullmatch(r"[0-9a-f]{64}", body_sha) is None
            or (provider == "kernel" and status not in {204, 404})
            or (provider == "steel" and status not in {200, 404})
        ):
            return False
        observed.append((provider, session_id))
    return observed == expected


def cleanup_provider_sessions(args: argparse.Namespace) -> int:
    manifest = publish_manifest(args)
    receipt_path = Path(args.receipt)
    if receipt_path.exists() or receipt_path.is_symlink():
        existing = read_json_object(receipt_path)
        if not validate_provider_receipt(existing, manifest):
            raise CleanupEvidenceError("existing provider receipt is not exact and complete")
        return 0

    env_paths = (Path(args.backend_env), Path(args.agents_env))
    results: list[dict[str, Any]] = []
    for provider in ("kernel", "steel"):
        for session_id in manifest["sessions"][provider]:
            status, response_sha = provider_request(provider, session_id, env_paths)
            results.append(
                {
                    "provider": provider,
                    "session_id": session_id,
                    "http_status": status,
                    "response_sha256": response_sha,
                }
            )
    receipt: dict[str, Any] = {
        "schema_version": SCHEMA,
        "version": 1,
        "kind": "provider-exact-cleanup",
        **identity(args),
        "root_agent_id": manifest["root_agent_id"],
        "manifest_sha256": canonical_digest(manifest),
        "results": results,
    }
    if not validate_provider_receipt(receipt, manifest):
        raise CleanupEvidenceError("provider cleanup results are incomplete")
    atomic_json(receipt_path, receipt)
    return 0


def validate_recovery_receipt(args: argparse.Namespace) -> int:
    expected_identity = identity(args)
    receipt = read_json_object(Path(args.receipt))
    for field, expected in expected_identity.items():
        if receipt.get(field) != expected:
            raise CleanupEvidenceError("recovery receipt identity does not match exact guest")
    if receipt.get("schema_version") != SCHEMA or receipt.get("version") != 1:
        raise CleanupEvidenceError("recovery receipt schema is unsupported")

    if receipt.get("kind") == "runner-cleanup":
        expected_fields = {
            "schema_version",
            "version",
            "kind",
            *expected_identity,
            "runner_receipt",
        }
        runner = receipt.get("runner_receipt")
        if (
            set(receipt) != expected_fields
            or not isinstance(runner, dict)
            or set(runner) != {"version", "token", "state", "sha256"}
            or runner.get("version") != "1"
            or runner.get("token") != args.guest_run_token
            or runner.get("state") != "clean"
            or not isinstance(runner.get("sha256"), str)
            or re.fullmatch(r"[0-9a-f]{64}", runner["sha256"]) is None
        ):
            raise CleanupEvidenceError("runner recovery receipt is not exact and positive")
        return 0

    if receipt.get("kind") != "provider-exact-cleanup":
        raise CleanupEvidenceError("recovery receipt kind is unsupported")
    if not all(
        (
            args.manifest,
            args.run_json,
            args.backend_log,
            args.quiescence_receipt,
        )
    ):
        raise CleanupEvidenceError(
            "provider recovery receipt requires its exact manifest and durable evidence"
        )
    manifest = read_json_object(Path(args.manifest))
    if manifest != provider_manifest(args):
        raise CleanupEvidenceError("provider manifest no longer matches exact durable evidence")
    if not validate_provider_receipt(receipt, manifest):
        raise CleanupEvidenceError("provider recovery receipt is not exact and complete")
    return 0


def add_identity_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--owner", required=True)
    parser.add_argument("--fleet-run-id", required=True)
    parser.add_argument("--bench", required=True)
    parser.add_argument("--machine-id", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--guest-run-token", required=True)


def add_provider_arguments(parser: argparse.ArgumentParser) -> None:
    add_identity_arguments(parser)
    parser.add_argument("--run-json", required=True)
    parser.add_argument("--backend-log", required=True)
    parser.add_argument("--quiescence-receipt", required=True)
    parser.add_argument("--manifest", required=True)


def add_optional_provider_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--run-json")
    parser.add_argument("--backend-log")
    parser.add_argument("--quiescence-receipt")
    parser.add_argument("--manifest")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    runner = subparsers.add_parser("recover-runner-receipt")
    add_identity_arguments(runner)
    runner.add_argument("--source", required=True)
    runner.add_argument("--receipt", required=True)

    manifest = subparsers.add_parser("build-provider-manifest")
    add_provider_arguments(manifest)

    cleanup = subparsers.add_parser("cleanup-provider-sessions")
    add_provider_arguments(cleanup)
    cleanup.add_argument("--receipt", required=True)
    cleanup.add_argument("--agents-env", required=True)
    cleanup.add_argument("--backend-env", required=True)

    validate = subparsers.add_parser("validate-recovery-receipt")
    add_identity_arguments(validate)
    add_optional_provider_arguments(validate)
    validate.add_argument("--receipt", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.command == "recover-runner-receipt":
        return recover_runner_receipt(args)
    if args.command == "build-provider-manifest":
        publish_manifest(args)
        return 0
    if args.command == "cleanup-provider-sessions":
        return cleanup_provider_sessions(args)
    if args.command == "validate-recovery-receipt":
        return validate_recovery_receipt(args)
    raise CleanupEvidenceError("unknown cleanup command")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CleanupEvidenceError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1) from error
