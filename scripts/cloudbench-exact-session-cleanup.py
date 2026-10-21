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
import time
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
RUNNER_STATES = {"pending", "clean", "failed"}
SCHEMA = "cloudbench-guest-cleanup-recovery-v1"
ZERO_QUERY_SCHEMA = "cloudbench-guest-zero-allocation-v1"
LEGACY_SMS_CLEANUP_SHA = "3b91d36b9b884feedaa34c0d2c16ae3341fcaec7"
# Release order. Manifests always carry kernel and steel; tilion appears only
# when it has sessions, so Kernel/Steel-only manifests stay byte-identical.
PROVIDERS = ("kernel", "steel", "tilion")
ALWAYS_LISTED_PROVIDERS = ("kernel", "steel")
RELEASED_STATUSES = {"kernel": {204, 404}, "steel": {200, 404}, "tilion": {204, 404, 410}}
# Tilion answers 503 "session worker unavailable; retry cleanup" when the
# browser is not confirmed gone. Retry a bounded number of times, then fail.
TILION_RELEASE_ATTEMPTS = 4
TILION_RELEASE_RETRY_SECONDS = 2.0
TILION_SESSION_MARKERS = (
    "Created Tilion browser session",
    "Tilion geo pin unsupported; keeping country exit",
    "Tilion geo unsupported; recreating with a wider pin",
    "Tilion session failed validation; creating another",
    "Failed to release Tilion session",
)


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
        or parsed["state"] not in RUNNER_STATES
    ):
        raise CleanupEvidenceError("runner receipt has invalid exact lifecycle state")
    return parsed


def parse_json_object(payload: bytes, path: Path) -> dict[str, Any]:
    try:
        value = json.loads(payload)
    except (TypeError, ValueError) as error:
        raise CleanupEvidenceError(f"malformed JSON evidence: {path}") from error
    if not isinstance(value, dict):
        raise CleanupEvidenceError(f"JSON evidence is not an object: {path}")
    return value


def read_json_object(path: Path, *, maximum: int = 16 * 1024 * 1024) -> dict[str, Any]:
    return parse_json_object(read_bytes(path, maximum=maximum), path)


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
    if parsed["state"] != "clean":
        raise CleanupEvidenceError("runner receipt does not prove exact clean state")
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


def classify_runner_receipt(args: argparse.Namespace) -> int:
    identity(args)
    payload = read_bytes(Path(args.source), maximum=65_536)
    parsed = parse_runner_status(payload, args.guest_run_token)
    print(parsed["state"])
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
    # A composite benchmark can run a prerequisite gate and then its task as
    # two separate roots. The sealed run records both IDs in this field. Keep
    # their order and exact spelling so receipts stay bound to the run bytes.
    roots = root_agent_id.split(",") if isinstance(root_agent_id, str) else []
    if (
        not roots
        or len(roots) != len(set(roots))
        or any(SAFE_AGENT.fullmatch(root) is None for root in roots)
    ):
        raise CleanupEvidenceError("run record has no exact root agent")
    return root_agent_id.lower(), sha256_bytes(payload)


def empty_sessions() -> dict[str, set[str]]:
    return {provider: set() for provider in PROVIDERS}


def manifest_sessions(sessions: dict[str, Any]) -> dict[str, list[str]]:
    listed = {provider: sorted(sessions.get(provider) or ()) for provider in PROVIDERS}
    return {
        provider: values
        for provider, values in listed.items()
        if values or provider in ALWAYS_LISTED_PROVIDERS
    }


def manifest_provider_sessions(manifest: dict[str, Any], provider: str) -> list[str]:
    return list(manifest["sessions"].get(provider, []))


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


def read_backend_evidence(path: Path, root_agent_id: str) -> tuple[str, str]:
    payload = read_bytes(path)
    try:
        text = ANSI.sub("", payload.decode("utf-8"))
    except UnicodeDecodeError as error:
        raise CleanupEvidenceError("backend log is not UTF-8") from error
    roots = root_agent_id.split(",")
    if len(roots) == 1 and roots[0].lower() not in text.lower():
        raise CleanupEvidenceError("backend log is not bound to the exact root agent")
    if len(roots) > 1 and any(
        re.search(rf"\bpath=/api/agents/{re.escape(root)}(?:\b|/)", text, re.IGNORECASE) is None
        for root in roots
    ):
        raise CleanupEvidenceError("backend log is not bound to the exact root agent")
    if len(roots) > 1 and text.count("[HTTP] POST /api/agents -> 201") < len(roots):
        raise CleanupEvidenceError("backend log lacks the composite root creations")
    return text, sha256_bytes(payload)


def collect_session_evidence(
    text: str,
) -> tuple[dict[str, list[str]], int, int]:
    sessions = empty_sessions()
    allocation_event_count = 0
    kernel_markers = (
        "Created Kernel browser session",
        "Reset restored Kernel profile tabs",
        "Failed to evict invalid Kernel session",
    )
    for marker in kernel_markers:
        marker_sessions = kernel_marker_sessions(text, marker)
        allocation_event_count += len(marker_sessions)
        for session_id in marker_sessions:
            add_session(sessions, "kernel", session_id)
    kernel_failures = list(
        re.finditer(
        r"Kernel session ([A-Za-z0-9_-]+) failed (?:tab reset|CDP validation)",
        text,
        )
    )
    allocation_event_count += len(kernel_failures)
    for match in kernel_failures:
        add_session(sessions, "kernel", match.group(1))

    for line in text.splitlines():
        if "Created Steel session:" not in line:
            continue
        allocation_event_count += 1
        entry = json_log_entry(line)
        message = str(entry.get("message", "")) if entry is not None else line
        match = re.search(r"Created Steel session:\s*([A-Za-z0-9_-]+)", message)
        if match is None:
            raise CleanupEvidenceError("Created Steel session evidence omitted an exact session id")
        add_session(sessions, "steel", match.group(1))
    steel_sessions = steel_response_sessions(text)
    allocation_event_count += len(steel_sessions)
    for session_id in steel_sessions:
        add_session(sessions, "steel", session_id)
    allocation_event_count += sum(
        text.count(marker)
        for marker in (
            "Creating Steel browser session",
            "Session creation attempt ",
        )
    )

    allocation_event_count += collect_tilion_session_evidence(text, sessions)

    parsed = manifest_sessions(sessions)
    mutation_count = len(
        re.findall(
            r"\bmodel=BrowserSession\b[^\n]*\boperation="
            r"(?:create|update|updateMany|upsert|delete|deleteMany)\b",
            text,
        )
    )
    return parsed, allocation_event_count, mutation_count


def tilion_create_requests(text: str) -> tuple[int, int]:
    """Count Tilion POST /v1/session request logs: (all attempts, may-have-created).

    A 2xx create or a create that failed before any response may own a remote
    browser; 4xx/5xx answers did not create one.
    """
    attempts = 0
    possibly_created = 0
    for line in text.splitlines():
        if "Tilion request" not in line:
            continue
        entry = json_log_entry(line)
        if entry is not None:
            message = str(entry.get("message", ""))
            method, path, status = entry.get("method"), entry.get("path"), entry.get("status")
        else:
            message = line
            method_match = re.search(r"\bmethod=(\S+)", line)
            path_match = re.search(r"\bpath=(\S+)", line)
            status_match = re.search(r"\bstatus=(\d+)", line)
            method = method_match.group(1) if method_match else None
            path = path_match.group(1) if path_match else None
            status = int(status_match.group(1)) if status_match else None
        if method != "POST" or path != "/v1/session":
            continue
        if "Tilion request failed before a response" in message:
            attempts += 1
            possibly_created += 1
        elif "Tilion request" in message:
            attempts += 1
            if isinstance(status, int) and 200 <= status < 300:
                possibly_created += 1
    return attempts, possibly_created


def collect_tilion_session_evidence(text: str, sessions: dict[str, set[str]]) -> int:
    """Record exact Tilion session ids; return allocation events.

    One Tilion account is shared by prod, dev and benchmarks, so ownership comes
    only from this guest's exact adapter logs, never an account listing. A create
    that may have allocated a browser without any recorded id fails closed.
    """
    events = 0
    for marker in TILION_SESSION_MARKERS:
        marker_sessions = kernel_marker_sessions(text, marker)
        events += len(marker_sessions)
        for session_id in marker_sessions:
            add_session(sessions, "tilion", session_id)
    failures = list(
        re.finditer(
            r"Tilion session ([A-Za-z0-9_-]+) failed (?:CDP validation|validation and cleanup)",
            text,
        )
    )
    events += len(failures)
    for match in failures:
        add_session(sessions, "tilion", match.group(1))
    attempts, possibly_created = tilion_create_requests(text)
    if possibly_created and not sessions["tilion"]:
        raise CleanupEvidenceError("Tilion create evidence omitted an exact session id")
    return events + attempts


def parse_active_root_agent(text: str) -> str:
    lines = text.splitlines()
    create_indices = [
        index
        for index, line in enumerate(lines)
        if "[HTTP] POST /api/agents -> 201" in line
    ]
    if not create_indices:
        raise CleanupEvidenceError("active backend evidence has no successful root creation")
    first_create = create_indices[0]
    next_create = create_indices[1] if len(create_indices) > 1 else len(lines)
    candidates: list[str] = []
    for line in lines[first_create + 1 : next_create]:
        match = re.search(r"\bpath=/api/agents/([0-9a-f-]{36})(?:\b|/)", line, re.IGNORECASE)
        if match is None:
            continue
        candidate = match.group(1).lower()
        if SAFE_AGENT.fullmatch(candidate) is not None:
            candidates.append(candidate)
    if not candidates:
        raise CleanupEvidenceError("active backend evidence has no exact root agent boundary")
    return candidates[0]


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
        or value.get("reason") != "driver-exited-services-stopped"
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
        or not isinstance(value.get("services_sha256"), str)
        or re.fullmatch(r"[0-9a-f]{64}", value["services_sha256"]) is None
        or value.get("run_json_sha256") != run_json_sha256
        or value.get("backend_log_sha256") != backend_log_sha256
    ):
        raise CleanupEvidenceError("guest quiescence receipt does not match exact Machine/run")
    return sha256_bytes(payload)


def root_snapshot_sessions(path: Path, root_agent_id: str, run_sha: str) -> dict[str, set[str]]:
    """Recover provider switches from the sealed run's exact database reads."""
    payload = read_bytes(path)
    if sha256_bytes(payload) != run_sha:
        raise CleanupEvidenceError("run evidence changed while reading provider ownership")
    task = json.loads(payload)["tasks"][0]
    logs = task.get("logs") or {}
    if not isinstance(logs, dict):
        raise CleanupEvidenceError("malformed run logs for provider ownership")
    evidence = logs.get("cloud_cleanup_evidence")
    sessions = empty_sessions()
    if "cloud_cleanup_evidence" not in logs:
        return sessions
    if not isinstance(evidence, dict) or evidence.get("root_agent_id") != root_agent_id:
        raise CleanupEvidenceError("database snapshots are not bound to the exact root")
    for phase in ("before", "after", "final"):
        if phase not in evidence:
            continue
        snapshot = evidence[phase]
        if not isinstance(snapshot, dict):
            raise CleanupEvidenceError("malformed exact root database snapshot")
        tree = snapshot.get("tree_agent_ids")
        rows = snapshot.get("browser_sessions")
        if (
            snapshot.get("root_exists") is not True
            or not isinstance(tree, list)
            or root_agent_id not in tree
            or any(not isinstance(aid, str) or SAFE_AGENT.fullmatch(aid) is None for aid in tree)
            or len(tree) != len(set(tree))
            or not isinstance(rows, list)
        ):
            raise CleanupEvidenceError("incomplete exact root database snapshot")
        for row in rows:
            if (
                not isinstance(row, dict)
                or row.get("agent_id") not in tree
                or row.get("provider") not in sessions
                or not isinstance(row.get("session_id"), str)
            ):
                raise CleanupEvidenceError("provider session is not bound to the exact root tree")
            add_session(sessions, row["provider"], row["session_id"])
    return sessions


def sealed_zero_session_run(path: Path, root_agent_id: str, run_sha: str) -> bool:
    """Accept a failed archive only when exact DB snapshots prove cleanup finished.

    A browser task can fail before its provider session is allocated. Its run
    record then has no session ID to release, even though root deletion and
    payment cleanup succeeded. The complete, root-bound before/after/final
    snapshots are stronger evidence than inventing a provider session.
    """
    payload = read_bytes(path)
    if sha256_bytes(payload) != run_sha:
        raise CleanupEvidenceError("run evidence changed during zero-session verification")
    logs = json.loads(payload)["tasks"][0].get("logs") or {}
    evidence = logs.get("cloud_cleanup_evidence") or {}
    if evidence.get("root_agent_id") != root_agent_id:
        return False
    for phase in ("before", "after", "final"):
        snapshot = evidence.get(phase)
        if not isinstance(snapshot, dict) or snapshot.get("root_exists") is not True:
            return False
        tree = snapshot.get("tree_agent_ids")
        if not isinstance(tree, list) or root_agent_id not in tree:
            return False
        if snapshot.get("browser_sessions") != [] or snapshot.get("purchase_cleanup") != []:
            return False
        if phase != "before" and (
            snapshot.get("root_deleted") is not True
            or snapshot.get("unsealed_tree_agent_ids") != []
        ):
            return False
    provider = logs.get("cloud_provider_cleanup") or {}
    payment = logs.get("cloud_payment_cleanup") or {}
    return (
        provider.get("root_agent_id") == root_agent_id
        and provider.get("root_deleted") is True
        and provider.get("tree_sealed") is True
        and provider.get("provider_receipts") == []
        and payment.get("root_agent_id") == root_agent_id
        and payment.get("purchases") == []
    )


def payment_mutation_count(text: str) -> int:
    return len(re.findall(
        r"\bmodel=(?:Purchase|AgentCardPurchase|AgentPayment)\b[^\n]*"
        r"\boperation=(?:create|update|updateMany|upsert|delete|deleteMany)\b",
        text,
    ))


def provider_manifest(args: argparse.Namespace) -> dict[str, Any]:
    exact_identity = identity(args)
    run_candidate = read_json_object(Path(args.run_json))
    candidate_tasks = run_candidate.get("tasks")
    if (
        isinstance(candidate_tasks, list)
        and len(candidate_tasks) == 1
        and isinstance(candidate_tasks[0], dict)
        and candidate_tasks[0].get("agent_id") == ""
        and isinstance(candidate_tasks[0].get("stop_metadata"), dict)
        and candidate_tasks[0]["stop_metadata"].get("runner") == "sms"
    ):
        return rootless_sms_provider_manifest(args)
    root_agent_id, run_sha = parse_run_identity(Path(args.run_json), args.bench)
    text, backend_sha = read_backend_evidence(Path(args.backend_log), root_agent_id)
    logged_sessions, _, _ = collect_session_evidence(text)
    snapshots = root_snapshot_sessions(Path(args.run_json), root_agent_id, run_sha)
    sessions = manifest_sessions(
        {
            provider: set(logged_sessions.get(provider, ())) | snapshots[provider]
            for provider in snapshots
        }
    )
    if not any(sessions.values()):
        if not sealed_zero_session_run(Path(args.run_json), root_agent_id, run_sha):
            raise CleanupEvidenceError("durable evidence contains no exact provider session identity")
        validate_complete_backend_lifecycle(text)
        logged_sessions, allocation_count, mutation_count = collect_session_evidence(text)
        root_deletes = re.findall(
            rf"\[HTTP\] DELETE /api/agents/{re.escape(root_agent_id)} -> 204\b",
            text,
        )
        if (
            any(logged_sessions.values())
            or allocation_count != 0
            or mutation_count != 0
            or len(root_deletes) != 1
            or payment_mutation_count(text) != 0
        ):
            raise CleanupEvidenceError("zero-session run has unretired external ownership")
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


def rootless_sms_provider_manifest(args: argparse.Namespace) -> dict[str, Any]:
    """Retire a quiesced SMS loop only when no external root was created.

    The legacy source SHA returned a result only after its ``finally`` cleanup
    completed, but did not emit an explicit receipt. Later source versions
    carry ``owned_cleanup_verified``. Both require the complete guest/backend
    bytes and zero root, browser, and payment allocation evidence.
    """
    run_path = Path(args.run_json)
    run_payload = read_bytes(run_path)
    run = parse_json_object(run_payload, run_path)
    tasks = run.get("tasks")
    if not isinstance(tasks, list) or len(tasks) != 1 or not isinstance(tasks[0], dict):
        raise CleanupEvidenceError("rootless SMS run is not exactly one task")
    task = tasks[0]
    metadata = task.get("stop_metadata")
    provenance = run.get("execution_provenance")
    legacy = (
        isinstance(provenance, dict)
        and provenance.get("base_sha") == LEGACY_SMS_CLEANUP_SHA
        and provenance.get("workspace_patch_sha256") == "none"
    )
    if (
        task.get("name") != args.bench
        or task.get("agent_id") != ""
        or task.get("status") not in {"PASSED", "FAILED", "COMPLETED"}
        or not isinstance(metadata, dict)
        or metadata.get("runner") != "sms"
        or not (metadata.get("owned_cleanup_verified") is True or legacy)
    ):
        raise CleanupEvidenceError("rootless SMS result has no completed cleanup proof")
    backend_path = Path(args.backend_log)
    backend_payload = read_bytes(backend_path)
    try:
        backend = ANSI.sub("", backend_payload.decode("utf-8"))
    except UnicodeDecodeError as error:
        raise CleanupEvidenceError("backend log is not UTF-8") from error
    validate_complete_backend_lifecycle(backend)
    sessions, allocations, browser_mutations = collect_session_evidence(backend)
    if (
        "[HTTP] POST /api/agents" in backend
        or "path=/api/agents/" in backend
        or any(sessions.values())
        or allocations != 0
        or browser_mutations != 0
        or payment_mutation_count(backend) != 0
    ):
        raise CleanupEvidenceError("rootless SMS guest has unretired external ownership")
    run_sha = sha256_bytes(run_payload)
    backend_sha = sha256_bytes(backend_payload)
    quiescence_sha = validate_quiescence(
        Path(args.quiescence_receipt), args.machine_id,
        args.guest_run_token, run_sha, backend_sha,
    )
    return {
        "schema_version": SCHEMA,
        "version": 1,
        "kind": "provider-rootless-sms-zero-manifest",
        **identity(args),
        "root_agent_id": None,
        "sessions": {"kernel": [], "steel": []},
        "evidence": {
            "run_json_sha256": run_sha,
            "backend_log_sha256": backend_sha,
            "quiescence_receipt_sha256": quiescence_sha,
            "allocation_event_count": 0,
            "browser_session_mutation_count": 0,
            "payment_mutation_count": 0,
            "root_creation_count": 0,
        },
    }


def publish_manifest(args: argparse.Namespace) -> dict[str, Any]:
    manifest = provider_manifest(args)
    path = Path(args.manifest)
    if not validate_existing(path, manifest):
        atomic_json(path, manifest)
    return manifest


def active_provider_manifest(args: argparse.Namespace) -> dict[str, Any]:
    exact_identity = identity(args)
    payload = read_bytes(Path(args.backend_log))
    try:
        text = ANSI.sub("", payload.decode("utf-8"))
    except UnicodeDecodeError as error:
        raise CleanupEvidenceError("backend log is not UTF-8") from error
    sessions, allocation_event_count, mutation_count = collect_session_evidence(text)
    if "[HTTP] POST /api/agents -> 201" not in text:
        # A canceled stack can exit before the benchmark creates any root.
        # Require an exact authenticated guest-state receipt proving the
        # driver exited, no run record exists, and all services stopped.
        # The backend independently proves no root or external allocation.
        state_path = Path(args.state_receipt) if args.state_receipt else None
        if state_path is None:
            raise CleanupEvidenceError("prestart cleanup requires exact guest state")
        state_payload = read_bytes(state_path, maximum=1024 * 1024)
        state = json.loads(state_payload)
        run = state.get("run_json")
        if (
            state.get("schema_version") != "cloudbench-guest-state-v1"
            or state.get("version") != 1
            or state.get("machine_id") != args.machine_id
            or state.get("guest_run_token") != args.guest_run_token
            or state.get("state") != "exited"
            or state.get("driver_state") != "exited"
            or state.get("driver_pid") is not None
            or state.get("driver_descendants") != []
            or state.get("services_status") != "stopped"
            or state.get("live_service_pids") != []
            or state.get("backend_closed") is not True
            or not isinstance(run, dict)
            or run.get("exists") is not False
            or run.get("symlink") is not False
            or "[HTTP] POST /api/agents" in text
            or "path=/api/agents/" in text
            or any(sessions.values())
            or allocation_event_count != 0
            or mutation_count != 0
            or payment_mutation_count(text) != 0
            or text.count("[Server] Server started") != 1
            or text.count("[Server] SIGTERM received, closing server...") < 1
        ):
            raise CleanupEvidenceError("prestart guest has unretired external ownership")
        return {
            "schema_version": SCHEMA,
            "version": 1,
            "kind": "provider-prestart-zero-manifest",
            **exact_identity,
            "root_agent_id": None,
            "sessions": {"kernel": [], "steel": []},
            "evidence": {
                "backend_log_sha256": sha256_bytes(payload),
                "guest_state_sha256": sha256_bytes(state_payload),
                "allocation_event_count": 0,
                "browser_session_mutation_count": 0,
                "payment_mutation_count": 0,
                "root_creation_count": 0,
            },
        }
    root_agent_id = parse_active_root_agent(text)
    root_deletes = re.findall(
        rf"\[HTTP\] DELETE /api/agents/{re.escape(root_agent_id)} -> 204\b",
        text,
    )
    if not any(sessions.values()):
        # An interrupted runner can exit after evaluating a task but before it
        # saves run.json. A task that never opened a browser has no positive
        # provider identity to release. Accept that case only from the complete
        # single-server log, with no allocation, BrowserSession write, or
        # payment write. If the isolated DB died before DELETE, the subsequent
        # exact stopped-Machine proof fences the local-only root permanently.
        validate_complete_backend_lifecycle(text)
        all_root_deletes = re.findall(
            rf"\[HTTP\] DELETE /api/agents/{re.escape(root_agent_id)} -> \d+\b",
            text,
        )
        if (
            text.count("[HTTP] POST /api/agents -> 201") != 1
            or len(root_deletes) > 1
            or len(all_root_deletes) != len(root_deletes)
            or allocation_event_count != 0
            or mutation_count != 0
            or payment_mutation_count(text) != 0
        ):
            raise CleanupEvidenceError(
                "runless zero-session evidence lacks exact terminal cleanup"
            )
    return {
        "schema_version": SCHEMA,
        "version": 1,
        "kind": "provider-active-exact-manifest",
        **exact_identity,
        "root_agent_id": root_agent_id,
        "sessions": manifest_sessions(sessions),
        "evidence": {
            "backend_log_sha256": sha256_bytes(payload),
            "allocation_event_count": allocation_event_count,
            "browser_session_mutation_count": mutation_count,
            "root_delete_count": len(root_deletes),
        },
    }


def publish_active_manifest(args: argparse.Namespace) -> dict[str, Any]:
    manifest = active_provider_manifest(args)
    path = Path(args.manifest)
    if not validate_existing(path, manifest):
        atomic_json(path, manifest)
    return manifest


def parse_stopped_machine_status(
    path: Path,
    machine_id: str,
    clone_name: str,
) -> str:
    payload = read_bytes(path, maximum=1024 * 1024)
    try:
        text = ANSI.sub("", payload.decode("utf-8"))
    except UnicodeDecodeError as error:
        raise CleanupEvidenceError("exact Machine status is not UTF-8") from error
    lines = text.splitlines()
    top_ids = [
        line.split(":", 1)[1].strip()
        for line in lines
        if line.startswith("Machine ID:")
    ]
    top_states = [
        line.split(":", 1)[1].strip()
        for line in lines
        if line.startswith("State:")
    ]
    vm_headers = [index for index, line in enumerate(lines) if line.strip() == "VM"]
    if len(vm_headers) != 1:
        raise CleanupEvidenceError("exact Machine status has no canonical VM section")
    start = vm_headers[0] + 1
    end = next(
        (
            index
            for index in range(start, len(lines))
            if lines[index].strip() == "Event Logs"
        ),
        len(lines),
    )
    pairs: dict[str, str] = {}
    separators: set[str] = set()
    for line in lines[start:end]:
        if not line.strip():
            continue
        match = re.fullmatch(r"\s*([^=│]+?)\s*(=|│)\s*(.*?)\s*", line)
        if match is None:
            raise CleanupEvidenceError("exact Machine status VM row is malformed")
        key, separator, value = match.groups()
        if key in pairs:
            raise CleanupEvidenceError("exact Machine status VM field is duplicated")
        pairs[key] = value
        separators.add(separator)
    if (
        top_ids != [machine_id]
        or top_states != ["stopped"]
        or len(separators) != 1
        or pairs.get("ID") != machine_id
        or pairs.get("State") != "stopped"
        or pairs.get("Name") != clone_name
    ):
        raise CleanupEvidenceError("exact Machine is not proven stopped")
    return sha256_bytes(payload)


def stopped_machine_proof(args: argparse.Namespace) -> dict[str, Any]:
    exact_identity = identity(args)
    manifest = read_json_object(Path(args.manifest))
    if manifest != active_provider_manifest(args):
        raise CleanupEvidenceError("active provider manifest no longer matches sealed evidence")
    if SAFE_NAME.fullmatch(args.clone_name) is None:
        raise CleanupEvidenceError("unsafe exact clone name")
    status_sha = parse_stopped_machine_status(
        Path(args.machine_status),
        args.machine_id,
        args.clone_name,
    )
    return {
        "schema_version": SCHEMA,
        "version": 1,
        "kind": "machine-stopped-proof",
        **exact_identity,
        "clone_name": args.clone_name,
        "state": "stopped",
        "machine_status_sha256": status_sha,
        "manifest_sha256": canonical_digest(manifest),
    }


def publish_stopped_machine_proof(args: argparse.Namespace) -> int:
    value = stopped_machine_proof(args)
    path = Path(args.stopped_proof)
    if not validate_existing(path, value):
        atomic_json(path, value)
    return 0


def validate_stopped_machine_proof(
    args: argparse.Namespace,
    manifest: dict[str, Any],
) -> str:
    proof = read_json_object(Path(args.stopped_proof))
    expected = stopped_machine_proof(args)
    if proof != expected or proof.get("manifest_sha256") != canonical_digest(manifest):
        raise CleanupEvidenceError("exact Machine stopped proof is invalid")
    return canonical_digest(proof)


def validate_complete_backend_lifecycle(text: str) -> None:
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
    # A second SIGTERM can be logged while the same server is already closing.
    # Accept only a terminal suffix of shutdown lines; no ordinary event may
    # follow the first shutdown, and there must still be one server start.
    if (
        len(starts) != 1
        or not shutdowns
        or starts[0] >= shutdowns[0]
        or shutdowns != list(range(shutdowns[0], len(lines)))
    ):
        raise CleanupEvidenceError(
            "backend evidence has no complete single-server lifecycle boundary"
        )


def validate_zero_query_proof(
    args: argparse.Namespace,
    root_agent_id: str,
    run_sha: str,
    backend_sha: str,
    quiescence_sha: str,
) -> tuple[dict[str, Any], str]:
    query_path = Path(args.zero_query_proof)
    query_payload = read_bytes(query_path, maximum=1024 * 1024)
    query = parse_json_object(query_payload, query_path)
    required = {
        "schema_version",
        "version",
        "machine_id",
        "guest_run_token",
        "root_agent_id",
        "root_disposition",
        "database_name",
        "database_state",
        "tree_agent_ids",
        "browser_sessions",
        "services_sha256",
        "run_json_sha256",
        "backend_log_sha256",
        "quiescence_receipt_sha256",
    }
    quiescence = read_json_object(Path(args.quiescence_receipt), maximum=1024 * 1024)
    tree = query.get("tree_agent_ids")
    sessions = query.get("browser_sessions")
    disposition = query.get("root_disposition")
    database_state = query.get("database_state")
    if (
        set(query) != required
        or query.get("schema_version") != ZERO_QUERY_SCHEMA
        or query.get("version") != 1
        or query.get("machine_id") != args.machine_id
        or query.get("guest_run_token") != args.guest_run_token
        or query.get("root_agent_id") != root_agent_id
        or disposition
        not in {
            "database-absent",
            "root-absent",
            "root-already-deleted",
            "deleted-exact-tree",
        }
        or database_state not in {"absent", "present"}
        or not isinstance(query.get("database_name"), str)
        or SAFE_NAME.fullmatch(query["database_name"]) is None
        or not isinstance(tree, list)
        or len(tree) != len(set(tree))
        or any(
            not isinstance(agent_id, str) or SAFE_AGENT.fullmatch(agent_id) is None
            for agent_id in tree
        )
        or sessions != []
        or query.get("services_sha256") != quiescence.get("services_sha256")
        or query.get("run_json_sha256") != run_sha
        or query.get("backend_log_sha256") != backend_sha
        or query.get("quiescence_receipt_sha256") != quiescence_sha
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
            and (
                database_state != "present"
                or root_agent_id not in tree
            )
        )
    ):
        raise CleanupEvidenceError(
            "zero-allocation query proof is not exact, positive, and root-bound"
        )
    return query, sha256_bytes(query_payload)


def zero_provider_manifest(args: argparse.Namespace) -> dict[str, Any]:
    exact_identity = identity(args)
    root_agent_id, run_sha = parse_run_identity(Path(args.run_json), args.bench)
    if any(root_snapshot_sessions(Path(args.run_json), root_agent_id, run_sha).values()):
        raise CleanupEvidenceError("zero-allocation evidence contains recorded provider sessions")
    text, backend_sha = read_backend_evidence(Path(args.backend_log), root_agent_id)
    validate_complete_backend_lifecycle(text)
    sessions, allocation_event_count, mutation_count = collect_session_evidence(text)
    if any(sessions.values()) or allocation_event_count != 0:
        raise CleanupEvidenceError(
            "complete backend evidence contains provider allocation events"
        )
    if mutation_count != 0:
        raise CleanupEvidenceError(
            "complete backend evidence contains BrowserSession mutations"
        )
    quiescence_sha = validate_quiescence(
        Path(args.quiescence_receipt),
        args.machine_id,
        args.guest_run_token,
        run_sha,
        backend_sha,
    )
    query, query_sha = validate_zero_query_proof(
        args,
        root_agent_id,
        run_sha,
        backend_sha,
        quiescence_sha,
    )
    return {
        "schema_version": SCHEMA,
        "version": 1,
        "kind": "provider-zero-manifest",
        **exact_identity,
        "root_agent_id": root_agent_id,
        "sessions": {"kernel": [], "steel": []},
        "evidence": {
            "run_json_sha256": run_sha,
            "backend_log_sha256": backend_sha,
            "quiescence_receipt_sha256": quiescence_sha,
            "zero_query_proof_sha256": query_sha,
            "services_sha256": query["services_sha256"],
            "allocation_event_count": allocation_event_count,
            "browser_session_mutation_count": mutation_count,
        },
    }


def publish_zero_manifest(args: argparse.Namespace) -> dict[str, Any]:
    manifest = zero_provider_manifest(args)
    path = Path(args.manifest)
    if not validate_existing(path, manifest):
        atomic_json(path, manifest)
    return manifest


def load_env_value(name: str, paths: tuple[Path, ...]) -> str:
    inherited = os.environ.get(name, "").strip()
    if inherited:
        return inherited
    for path in paths:
        # Fresh clones and Conductor workspaces may link ignored env files from
        # their authoritative source. This is configuration input, not a proof
        # artifact: keep receipt files symlink-free, but follow a regular env
        # target so exact cancellation can authenticate provider cleanup.
        try:
            source = path.resolve(strict=True)
            metadata = source.stat()
        except OSError:
            continue
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 1024 * 1024:
            continue
        for raw in source.read_text(encoding="utf-8").splitlines():
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
    elif provider == "tilion":
        api_key = load_env_value("TILION_API_KEY", env_paths)
        base_url = load_env_value("TILION_BASE_URL", env_paths) or "https://back.tilion.dev"
        method = "DELETE"
        url = f"{base_url.rstrip('/')}/v1/session/{urllib.parse.quote(session_id, safe='')}"
        headers = {"Authorization": f"Bearer {api_key}"}
        body = None
    else:
        raise CleanupEvidenceError(f"unsupported exact cleanup provider: {provider}")
    if not api_key:
        raise CleanupEvidenceError(f"{provider} cleanup credential is missing")

    # Identify this client explicitly, as the provider SDK does. Steel's edge
    # rejects urllib's default identity with Cloudflare 1010 before API auth.
    headers.update({"User-Agent": "rose-cloudbench/1.0", "Accept": "application/json"})
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    attempts = TILION_RELEASE_ATTEMPTS if provider == "tilion" else 1
    for attempt in range(1, attempts + 1):
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
        if status != 503 or attempt == attempts:
            break
        time.sleep(TILION_RELEASE_RETRY_SECONDS)

    if provider == "tilion":
        if status not in RELEASED_STATUSES["tilion"]:
            raise CleanupEvidenceError(
                f"Tilion exact session cleanup failed for {session_id}: HTTP {status}"
            )
        return status, sha256_bytes(response_body)

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


def validate_provider_receipt(
    receipt: dict[str, Any],
    manifest: dict[str, Any],
    stopped_proof_sha256: str | None = None,
) -> bool:
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
    if stopped_proof_sha256 is not None:
        expected_fields.add("stopped_machine_proof_sha256")
    if (
        set(receipt) != expected_fields
        or receipt.get("schema_version") != SCHEMA
        or receipt.get("version") != 1
        or receipt.get("kind") != "provider-exact-cleanup"
    ):
        return False
    if receipt.get("manifest_sha256") != canonical_digest(manifest):
        return False
    if stopped_proof_sha256 is not None and (
        receipt.get("stopped_machine_proof_sha256") != stopped_proof_sha256
    ):
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
        for provider in PROVIDERS
        for session_id in manifest_provider_sessions(manifest, provider)
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
            provider not in RELEASED_STATUSES
            or not isinstance(session_id, str)
            or not isinstance(status, int)
            or not isinstance(body_sha, str)
            or re.fullmatch(r"[0-9a-f]{64}", body_sha) is None
            or status not in RELEASED_STATUSES[provider]
        ):
            return False
        observed.append((provider, session_id))
    return observed == expected


def cleanup_manifest_sessions(
    args: argparse.Namespace,
    manifest: dict[str, Any],
    *,
    stopped_proof_sha256: str | None = None,
) -> int:
    receipt_path = Path(args.receipt)
    if receipt_path.exists() or receipt_path.is_symlink():
        existing = read_json_object(receipt_path)
        if not validate_provider_receipt(
            existing,
            manifest,
            stopped_proof_sha256,
        ):
            raise CleanupEvidenceError("existing provider receipt is not exact and complete")
        return 0

    env_paths = (Path(args.backend_env), Path(args.agents_env))
    results: list[dict[str, Any]] = []
    for provider in PROVIDERS:
        for session_id in manifest_provider_sessions(manifest, provider):
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
    if stopped_proof_sha256 is not None:
        receipt["stopped_machine_proof_sha256"] = stopped_proof_sha256
    if not validate_provider_receipt(
        receipt,
        manifest,
        stopped_proof_sha256,
    ):
        raise CleanupEvidenceError("provider cleanup results are incomplete")
    atomic_json(receipt_path, receipt)
    return 0


def cleanup_provider_sessions(args: argparse.Namespace) -> int:
    return cleanup_manifest_sessions(args, publish_manifest(args))


def cleanup_sealed_provider_sessions(args: argparse.Namespace) -> int:
    manifest = read_json_object(Path(args.manifest))
    if manifest != active_provider_manifest(args):
        raise CleanupEvidenceError(
            "active provider manifest no longer matches sealed evidence"
        )
    stopped_proof_sha256 = validate_stopped_machine_proof(args, manifest)
    return cleanup_manifest_sessions(
        args,
        manifest,
        stopped_proof_sha256=stopped_proof_sha256,
    )


def validate_zero_receipt(
    receipt: dict[str, Any],
    manifest: dict[str, Any],
) -> bool:
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
        "zero_query_proof_sha256",
        "allocation_event_count",
        "browser_session_mutation_count",
    }
    evidence = manifest.get("evidence")
    if (
        set(receipt) != expected_fields
        or receipt.get("schema_version") != SCHEMA
        or receipt.get("version") != 1
        or receipt.get("kind") != "provider-zero-allocated"
        or not isinstance(evidence, dict)
        or receipt.get("manifest_sha256") != canonical_digest(manifest)
        or receipt.get("zero_query_proof_sha256")
        != evidence.get("zero_query_proof_sha256")
        or receipt.get("allocation_event_count")
        != evidence.get("allocation_event_count")
        or receipt.get("browser_session_mutation_count")
        != evidence.get("browser_session_mutation_count")
        or receipt.get("allocation_event_count") != 0
        or receipt.get("browser_session_mutation_count") != 0
    ):
        return False
    return all(
        receipt.get(field) == manifest.get(field)
        for field in (
            "fleet_owner_token",
            "fleet_run_id",
            "bench",
            "machine_id",
            "output_dir",
            "guest_run_token",
            "root_agent_id",
        )
    )


def recover_zero_allocation(args: argparse.Namespace) -> int:
    manifest = publish_zero_manifest(args)
    receipt_path = Path(args.receipt)
    if receipt_path.exists() or receipt_path.is_symlink():
        if not validate_zero_receipt(read_json_object(receipt_path), manifest):
            raise CleanupEvidenceError(
                "existing zero-allocation receipt is not exact and positive"
            )
        return 0
    evidence = manifest["evidence"]
    receipt: dict[str, Any] = {
        "schema_version": SCHEMA,
        "version": 1,
        "kind": "provider-zero-allocated",
        **identity(args),
        "root_agent_id": manifest["root_agent_id"],
        "manifest_sha256": canonical_digest(manifest),
        "zero_query_proof_sha256": evidence["zero_query_proof_sha256"],
        "allocation_event_count": evidence["allocation_event_count"],
        "browser_session_mutation_count": evidence[
            "browser_session_mutation_count"
        ],
    }
    if not validate_zero_receipt(receipt, manifest):
        raise CleanupEvidenceError("zero-allocation receipt is incomplete")
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

    if receipt.get("kind") == "provider-zero-allocated":
        if not all(
            (
                args.manifest,
                args.run_json,
                args.backend_log,
                args.quiescence_receipt,
                args.zero_query_proof,
            )
        ):
            raise CleanupEvidenceError(
                "zero-allocation receipt requires its complete exact evidence"
            )
        manifest = read_json_object(Path(args.manifest))
        if manifest != zero_provider_manifest(args):
            raise CleanupEvidenceError(
                "zero-allocation manifest no longer matches exact durable evidence"
            )
        if not validate_zero_receipt(receipt, manifest):
            raise CleanupEvidenceError(
                "zero-allocation receipt is not exact and positive"
            )
        return 0

    if receipt.get("kind") != "provider-exact-cleanup":
        raise CleanupEvidenceError("recovery receipt kind is unsupported")
    if not args.manifest:
        raise CleanupEvidenceError(
            "provider recovery receipt requires its exact manifest"
        )
    manifest = read_json_object(Path(args.manifest))
    stopped_proof_sha256: str | None = None
    if manifest.get("kind") in {"provider-exact-manifest", "provider-rootless-sms-zero-manifest"}:
        if not all(
            (
                args.run_json,
                args.backend_log,
                args.quiescence_receipt,
            )
        ):
            raise CleanupEvidenceError(
                "provider receipt requires its exact quiescence evidence"
            )
        if manifest != provider_manifest(args):
            raise CleanupEvidenceError(
                "provider manifest no longer matches exact durable evidence"
            )
    elif manifest.get("kind") in {
        "provider-active-exact-manifest", "provider-prestart-zero-manifest"
    }:
        if not all(
            (
                args.backend_log,
                args.clone_name,
                args.machine_status,
                args.stopped_proof,
            )
        ):
            raise CleanupEvidenceError(
                "active provider receipt requires its exact stopped-Machine evidence"
            )
        if manifest != active_provider_manifest(args):
            raise CleanupEvidenceError(
                "active provider manifest no longer matches exact durable evidence"
            )
        stopped_proof_sha256 = validate_stopped_machine_proof(args, manifest)
    else:
        raise CleanupEvidenceError("provider manifest kind is unsupported")
    if not validate_provider_receipt(
        receipt,
        manifest,
        stopped_proof_sha256,
    ):
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
    parser.add_argument("--clone-name")
    parser.add_argument("--machine-status")
    parser.add_argument("--stopped-proof")
    parser.add_argument("--zero-query-proof")
    parser.add_argument("--state-receipt")


def add_active_provider_arguments(parser: argparse.ArgumentParser) -> None:
    add_identity_arguments(parser)
    parser.add_argument("--backend-log", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--state-receipt")


def add_stopped_provider_arguments(parser: argparse.ArgumentParser) -> None:
    add_active_provider_arguments(parser)
    parser.add_argument("--clone-name", required=True)
    parser.add_argument("--machine-status", required=True)
    parser.add_argument("--stopped-proof", required=True)


def add_zero_provider_arguments(parser: argparse.ArgumentParser) -> None:
    add_provider_arguments(parser)
    parser.add_argument("--zero-query-proof", required=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    runner = subparsers.add_parser("recover-runner-receipt")
    add_identity_arguments(runner)
    runner.add_argument("--source", required=True)
    runner.add_argument("--receipt", required=True)

    runner_state = subparsers.add_parser("classify-runner-receipt")
    add_identity_arguments(runner_state)
    runner_state.add_argument("--source", required=True)

    manifest = subparsers.add_parser("build-provider-manifest")
    add_provider_arguments(manifest)

    active_manifest = subparsers.add_parser("build-active-provider-manifest")
    add_active_provider_arguments(active_manifest)

    stopped_proof = subparsers.add_parser("publish-stopped-machine-proof")
    add_stopped_provider_arguments(stopped_proof)

    cleanup = subparsers.add_parser("cleanup-provider-sessions")
    add_provider_arguments(cleanup)
    cleanup.add_argument("--receipt", required=True)
    cleanup.add_argument("--agents-env", required=True)
    cleanup.add_argument("--backend-env", required=True)

    sealed_cleanup = subparsers.add_parser("cleanup-sealed-provider-sessions")
    add_stopped_provider_arguments(sealed_cleanup)
    sealed_cleanup.add_argument("--receipt", required=True)
    sealed_cleanup.add_argument("--agents-env", required=True)
    sealed_cleanup.add_argument("--backend-env", required=True)

    zero = subparsers.add_parser("recover-zero-allocation")
    add_zero_provider_arguments(zero)
    zero.add_argument("--receipt", required=True)

    validate = subparsers.add_parser("validate-recovery-receipt")
    add_identity_arguments(validate)
    add_optional_provider_arguments(validate)
    validate.add_argument("--receipt", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.command == "recover-runner-receipt":
        return recover_runner_receipt(args)
    if args.command == "classify-runner-receipt":
        return classify_runner_receipt(args)
    if args.command == "build-provider-manifest":
        publish_manifest(args)
        return 0
    if args.command == "build-active-provider-manifest":
        publish_active_manifest(args)
        return 0
    if args.command == "publish-stopped-machine-proof":
        return publish_stopped_machine_proof(args)
    if args.command == "cleanup-provider-sessions":
        return cleanup_provider_sessions(args)
    if args.command == "cleanup-sealed-provider-sessions":
        return cleanup_sealed_provider_sessions(args)
    if args.command == "recover-zero-allocation":
        return recover_zero_allocation(args)
    if args.command == "validate-recovery-receipt":
        return validate_recovery_receipt(args)
    raise CleanupEvidenceError("unknown cleanup command")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CleanupEvidenceError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1) from error
