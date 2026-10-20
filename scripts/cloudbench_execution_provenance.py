#!/usr/bin/env python3
"""Build and verify Cloud Fleet execution provenance.

The controller snapshot, code-under-test identity, and an allowlisted non-secret
configuration document are one acceptance contract.  This module is copied into
the immutable controller snapshot and staged beside the guest driver so artifact
stamping never imports code from the mutable checkout under test.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import stat
import sys
import tempfile
from pathlib import Path
from typing import Any


EXECUTION_SCHEMA_VERSION = "cloudbench-execution-provenance-v1"
SNAPSHOT_SCHEMA_VERSION = "cloudbench-controller-snapshot-v1"
CONFIG_SCHEMA_VERSION = "cloudbench-fleet-config-v1"
TASK_MATRIX_SCHEMA_VERSION = "cloudbench-task-matrix-v1"
SNAPSHOT_MANIFEST_NAME = "cloudbench-controller-snapshot-manifest.json"
_SNAPSHOT_RUNTIME_FILES = {
    ".cloudbench-script-snapshot-owner.json",
    ".cloudbench-script-snapshot-owner.lock",
    SNAPSHOT_MANIFEST_NAME,
}
_HEX40 = re.compile(r"^[0-9a-f]{40}$")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_SENSITIVE_CONFIG_SEGMENTS = {
    "auth",
    "authorization",
    "cookie",
    "credential",
    "credentials",
    "key",
    "password",
    "secret",
    "token",
}
_CONFIG_SCALAR_KEYS = {
    "app",
    "region",
    "donor_region",
    "fresh_volume_unique_zone",
    "run_timeout_seconds",
    "child_run_timeout_seconds",
    "benchmark_wall_clock_backstop_seconds",
    "synchronized_start",
    "first_run_stack_wait_seconds",
    "per_box_barrier_wait_seconds",
    "start_barrier_wait_seconds",
    "boot_launch",
    "boot_transport",
    "infra_probe",
    "worker_qualification_floor",
    "boot_config_max_in_flight",
    "campaign_mutation_admission",
    "boot_update_capacity_wait_seconds",
    "boot_config_barrier_wait_seconds",
    "primary_reuse_only",
    "resource_lifecycle",
    "requested_boot_transport",
    "cold_primary_bootstrap",
    "primary_vm_size",
    "primary_vm_memory_mb",
    "bundled_frontend_vm_size",
    "bundled_frontend_vm_memory_mb",
    "sim_vm_size",
    "sim_vm_memory_mb",
    "worker_vm_size",
    "worker_vm_memory_mb",
    "worker_health_port",
    "warm_parked_vm_size",
    "warm_parked_vm_memory_mb",
    "autoscale_max",
    "autoscale_poll_seconds",
    "autoscale_scale_down_confirm_seconds",
    "autoscaler_startup_wait_seconds",
    "autoscaler_finalization_wait_seconds",
    "worker_stage_attempts",
    "worker_stage_attempt_wall_seconds",
    "worker_ready_timeout_seconds",
    "snapshot_poll_seconds",
    "snapshot_refresh_timeout_seconds",
    "inventory_max_stale_seconds",
    "clone_launch_stagger_seconds",
    "launch_stagger_seconds",
    "keep_clones",
    "guest_pg_major",
    "seed_cache_identity",
    "volume_snapshot_id",
    "base_source_manifest_sha256",
    "node_dependency_fingerprint",
    "python_dependency_fingerprint",
    "per_child_max_concurrency",
    "wmh_model_name",
    "wmh_engine",
    "wmh_rose_pool",
    "wmh_execution_policy",
    "benchmark_fast_mode_cache",
    "fast_mode_cache_disable_write_through",
    "benchmark_demo_cache_read_only",
    "benchmark_claude_code_cache_ratchet_warn_only",
    "rose_exclude_anthropic_family",
    "task_count",
    "task_matrix_sha256",
}


class ProvenanceError(ValueError):
    """An execution provenance contract was not satisfied."""


def canonical_bytes(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def canonical_sha256(value: object) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError as exc:
        raise ProvenanceError(f"file does not exist: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ProvenanceError(f"invalid JSON in {path}: {exc}") from exc


def _write_json_atomic(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, sort_keys=True, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _snapshot_payload(snapshot_dir: Path) -> dict[str, object]:
    if not snapshot_dir.is_dir():
        raise ProvenanceError(f"controller snapshot is not a directory: {snapshot_dir}")
    files: list[dict[str, object]] = []
    for path in sorted(snapshot_dir.rglob("*"), key=lambda item: item.as_posix()):
        relative = path.relative_to(snapshot_dir).as_posix()
        if relative in _SNAPSHOT_RUNTIME_FILES:
            continue
        if path.is_symlink():
            raise ProvenanceError(f"controller snapshot contains a symlink: {relative}")
        if path.is_dir():
            continue
        try:
            status = path.stat()
        except FileNotFoundError as exc:
            raise ProvenanceError(f"controller snapshot changed while hashing: {relative}") from exc
        if not stat.S_ISREG(status.st_mode):
            raise ProvenanceError(f"controller snapshot contains a non-regular file: {relative}")
        content = path.read_bytes()
        files.append(
            {
                "path": relative,
                "mode": format(stat.S_IMODE(status.st_mode), "04o"),
                "size": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
            }
        )
    if not files:
        raise ProvenanceError("controller snapshot contains no dependency files")
    return {"schema_version": SNAPSHOT_SCHEMA_VERSION, "files": files}


def build_snapshot_manifest(snapshot_dir: Path) -> dict[str, object]:
    payload = _snapshot_payload(snapshot_dir)
    return {**payload, "sha256": canonical_sha256(payload)}


def validate_snapshot_manifest(document: object) -> list[str]:
    if not isinstance(document, dict):
        return ["controller snapshot manifest must be a JSON object"]
    expected_keys = {"schema_version", "sha256", "files"}
    if set(document) != expected_keys:
        return ["controller snapshot manifest fields are not the v1 contract"]
    if document.get("schema_version") != SNAPSHOT_SCHEMA_VERSION:
        return ["controller snapshot manifest schema version is unsupported"]
    digest = document.get("sha256")
    if not isinstance(digest, str) or not _HEX64.fullmatch(digest):
        return ["controller snapshot manifest sha256 is invalid"]
    files = document.get("files")
    if not isinstance(files, list) or not files:
        return ["controller snapshot manifest files must be a non-empty list"]
    prior = ""
    for entry in files:
        if not isinstance(entry, dict) or set(entry) != {"path", "mode", "size", "sha256"}:
            return ["controller snapshot manifest has an invalid file entry"]
        path = entry.get("path")
        if not isinstance(path, str) or not path or path.startswith("/") or ".." in Path(path).parts:
            return ["controller snapshot manifest has an unsafe file path"]
        if path <= prior:
            return ["controller snapshot manifest files are not uniquely sorted"]
        prior = path
        if not isinstance(entry.get("mode"), str) or not re.fullmatch(r"[0-7]{4}", entry["mode"]):
            return [f"controller snapshot manifest mode is invalid for {path}"]
        if not isinstance(entry.get("size"), int) or entry["size"] < 0:
            return [f"controller snapshot manifest size is invalid for {path}"]
        if not isinstance(entry.get("sha256"), str) or not _HEX64.fullmatch(entry["sha256"]):
            return [f"controller snapshot manifest sha256 is invalid for {path}"]
    payload = {"schema_version": document["schema_version"], "files": files}
    if canonical_sha256(payload) != digest:
        return ["controller snapshot manifest digest is internally inconsistent"]
    return []


def verify_snapshot(snapshot_dir: Path, manifest: object) -> None:
    errors = validate_snapshot_manifest(manifest)
    if errors:
        raise ProvenanceError("; ".join(errors))
    current = build_snapshot_manifest(snapshot_dir)
    if current != manifest:
        raise ProvenanceError(
            "controller snapshot digest mismatch: immutable dependency bytes changed after manifest creation"
        )


def _config_key_is_sensitive(key: str) -> bool:
    segments = {part for part in re.split(r"[^a-z0-9]+", key.lower()) if part}
    compact = re.sub(r"[^a-z0-9]", "", key.lower())
    return bool(segments & _SENSITIVE_CONFIG_SEGMENTS) or any(
        marker in compact
        for marker in (
            "accesstoken",
            "apikey",
            "authorization",
            "credential",
            "password",
            "secret",
        )
    )


def _config_key_is_allowlisted(key: str) -> bool:
    return key in _CONFIG_SCALAR_KEYS


def build_config(version: str, pairs: list[str]) -> dict[str, object]:
    if version != CONFIG_SCHEMA_VERSION:
        raise ProvenanceError(f"unsupported config provenance version: {version!r}")
    values: dict[str, str] = {}
    for pair in pairs:
        key, separator, value = pair.partition("=")
        if not separator or not key or not re.fullmatch(r"[a-z0-9][a-z0-9_.-]*", key):
            raise ProvenanceError(f"invalid config value assignment: {pair!r}")
        if _config_key_is_sensitive(key):
            raise ProvenanceError(f"secret-like config key is forbidden: {key}")
        if not _config_key_is_allowlisted(key):
            raise ProvenanceError(f"config provenance key is not allowlisted: {key}")
        if key in values:
            raise ProvenanceError(f"duplicate config provenance key: {key}")
        values[key] = value
    if not values:
        raise ProvenanceError("config provenance must contain at least one allowlisted value")
    payload = {"schema_version": version, "values": values}
    return {**payload, "sha256": canonical_sha256(payload)}


def build_task_matrix(tasks: list[str]) -> dict[str, object]:
    rows: list[dict[str, str]] = []
    for task in tasks:
        name, separator, mode = task.partition("=")
        if (
            not separator
            or re.fullmatch(r"[a-z0-9][a-z0-9-]*", name) is None
            or mode not in {"real", "simulate"}
        ):
            raise ProvenanceError("task matrix rows must be NAME=real|simulate")
        rows.append({"name": name, "world_model_mode": mode})
    if not rows:
        raise ProvenanceError("task matrix must contain at least one task")
    if len({row["name"] for row in rows}) != len(rows):
        raise ProvenanceError("task matrix contains duplicate task names")
    payload = {"schema_version": TASK_MATRIX_SCHEMA_VERSION, "tasks": rows}
    return {**payload, "sha256": canonical_sha256(payload)}


def validate_task_matrix(document: object) -> list[str]:
    if not isinstance(document, dict) or set(document) != {
        "schema_version",
        "tasks",
        "sha256",
    }:
        return ["execution task matrix fields are not the v1 contract"]
    if document.get("schema_version") != TASK_MATRIX_SCHEMA_VERSION:
        return ["execution task matrix schema version is unsupported"]
    tasks = document.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        return ["execution task matrix tasks must be a non-empty list"]
    names: set[str] = set()
    for row in tasks:
        if not isinstance(row, dict) or set(row) != {"name", "world_model_mode"}:
            return ["execution task matrix contains an invalid row"]
        name = row.get("name")
        mode = row.get("world_model_mode")
        if not isinstance(name, str) or re.fullmatch(r"[a-z0-9][a-z0-9-]*", name) is None:
            return ["execution task matrix contains an invalid task name"]
        if name in names:
            return ["execution task matrix contains duplicate task names"]
        names.add(name)
        if mode not in {"real", "simulate"}:
            return [f"execution task matrix contains an invalid mode for {name}"]
    payload = {"schema_version": document["schema_version"], "tasks": tasks}
    if document.get("sha256") != canonical_sha256(payload):
        return ["execution task matrix digest is internally inconsistent"]
    return []


def load_task_matrix(path: Path) -> dict[str, object]:
    document = _read_json(path)
    errors = validate_task_matrix(document)
    if errors:
        raise ProvenanceError("; ".join(errors))
    assert isinstance(document, dict)
    return document


def validate_task_matrix_binding(
    provenance: object,
    matrix: object,
) -> list[str]:
    provenance_errors = validate_provenance(provenance)
    if provenance_errors:
        return [f"execution provenance is invalid: {error}" for error in provenance_errors]
    matrix_errors = validate_task_matrix(matrix)
    if matrix_errors:
        return matrix_errors
    assert isinstance(provenance, dict) and isinstance(matrix, dict)
    config = provenance["config"]
    assert isinstance(config, dict)
    values = config["values"]
    assert isinstance(values, dict)
    errors: list[str] = []
    if values.get("task_matrix_sha256") != matrix.get("sha256"):
        errors.append("config task matrix digest does not match the canonical task matrix")
    if values.get("task_count") != str(len(matrix["tasks"])):
        errors.append("config task count does not match the canonical task matrix")
    return errors


def validate_provenance(document: object) -> list[str]:
    if not isinstance(document, dict):
        return ["execution provenance must be a JSON object"]
    if set(document) != {
        "schema_version",
        "base_sha",
        "workspace_patch_sha256",
        "controller_snapshot",
        "config",
    }:
        return ["execution provenance fields are not the v1 contract"]
    if document.get("schema_version") != EXECUTION_SCHEMA_VERSION:
        return ["execution provenance schema version is unsupported"]
    if not isinstance(document.get("base_sha"), str) or not _HEX40.fullmatch(document["base_sha"]):
        return ["execution provenance base_sha is not a full lowercase commit SHA"]
    patch = document.get("workspace_patch_sha256")
    if patch != "none" and (not isinstance(patch, str) or not _HEX64.fullmatch(patch)):
        return ["execution provenance workspace patch must be 'none' or a lowercase sha256"]
    snapshot = document.get("controller_snapshot")
    if not isinstance(snapshot, dict) or set(snapshot) != {"schema_version", "sha256"}:
        return ["execution provenance controller_snapshot is invalid"]
    if snapshot.get("schema_version") != SNAPSHOT_SCHEMA_VERSION:
        return ["execution provenance controller snapshot schema is unsupported"]
    if not isinstance(snapshot.get("sha256"), str) or not _HEX64.fullmatch(snapshot["sha256"]):
        return ["execution provenance controller snapshot sha256 is invalid"]
    config = document.get("config")
    if not isinstance(config, dict) or set(config) != {"schema_version", "sha256", "values"}:
        return ["execution provenance config is invalid"]
    if config.get("schema_version") != CONFIG_SCHEMA_VERSION:
        return ["execution provenance config schema is unsupported"]
    values = config.get("values")
    if not isinstance(values, dict) or not values:
        return ["execution provenance config values must be a non-empty object"]
    for key, value in values.items():
        if not isinstance(key, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_.-]*", key):
            return ["execution provenance config contains an invalid key"]
        if _config_key_is_sensitive(key):
            return [f"execution provenance config contains a secret-like key: {key}"]
        if not _config_key_is_allowlisted(key):
            return [f"execution provenance config key is not allowlisted: {key}"]
        if not isinstance(value, str):
            return [f"execution provenance config value must be a string: {key}"]
    config_payload = {"schema_version": config["schema_version"], "values": values}
    if config.get("sha256") != canonical_sha256(config_payload):
        return ["execution provenance config digest is internally inconsistent"]
    return []


def load_provenance(path: Path) -> dict[str, object]:
    document = _read_json(path)
    errors = validate_provenance(document)
    if errors:
        raise ProvenanceError("; ".join(errors))
    assert isinstance(document, dict)
    return document


def verify_code_binding(
    provenance: dict[str, object],
    *,
    base_sha: str,
    workspace_patch_sha256: str,
) -> None:
    if provenance.get("base_sha") != base_sha:
        raise ProvenanceError(
            "execution provenance base SHA does not match the requested guest checkout"
        )
    if provenance.get("workspace_patch_sha256") != workspace_patch_sha256:
        raise ProvenanceError(
            "execution provenance workspace patch does not match the staged guest patch"
        )


def build_provenance(
    *,
    base_sha: str,
    workspace_patch_sha256: str,
    snapshot_manifest: object,
    config: dict[str, object],
) -> dict[str, object]:
    if not _HEX40.fullmatch(base_sha):
        raise ProvenanceError("base SHA must be a full lowercase 40-character commit SHA")
    if workspace_patch_sha256 != "none" and not _HEX64.fullmatch(workspace_patch_sha256):
        raise ProvenanceError("workspace patch must be 'none' or a lowercase sha256")
    snapshot_errors = validate_snapshot_manifest(snapshot_manifest)
    if snapshot_errors:
        raise ProvenanceError("; ".join(snapshot_errors))
    if not isinstance(snapshot_manifest, dict):
        raise ProvenanceError("controller snapshot manifest must be an object")
    document: dict[str, object] = {
        "schema_version": EXECUTION_SCHEMA_VERSION,
        "base_sha": base_sha,
        "workspace_patch_sha256": workspace_patch_sha256,
        "controller_snapshot": {
            "schema_version": SNAPSHOT_SCHEMA_VERSION,
            "sha256": snapshot_manifest["sha256"],
        },
        "config": config,
    }
    errors = validate_provenance(document)
    if errors:
        raise ProvenanceError("; ".join(errors))
    return document


def validate_run_provenance(document: object, expected: object) -> list[str]:
    expected_errors = validate_provenance(expected)
    if expected_errors:
        return [f"expected execution provenance is invalid: {error}" for error in expected_errors]
    if not isinstance(document, dict):
        return ["run artifact must be a JSON object"]
    actual = document.get("execution_provenance")
    if actual is None:
        errors = ["run artifact is missing execution provenance"]
    else:
        actual_errors = validate_provenance(actual)
        errors = [f"run artifact execution provenance is invalid: {error}" for error in actual_errors]
        if not actual_errors and actual != expected:
            errors.append("run artifact execution provenance does not match expected provenance")
    tasks = document.get("tasks")
    if isinstance(tasks, list):
        for index, task in enumerate(tasks):
            if not isinstance(task, dict):
                continue
            task_provenance = task.get("execution_provenance")
            if task_provenance is None:
                errors.append(f"task {index} is missing execution provenance")
            elif task_provenance != expected:
                errors.append(f"task {index} execution provenance does not match expected provenance")
    return errors


def stamp_run_document(document: object, provenance: dict[str, object]) -> dict[str, object]:
    if not isinstance(document, dict):
        raise ProvenanceError("run artifact must be a JSON object")
    tasks = document.get("tasks")
    if not isinstance(tasks, list) or not tasks or any(not isinstance(task, dict) for task in tasks):
        raise ProvenanceError("run artifact tasks must be a non-empty list of objects")
    stamped = copy.deepcopy(document)
    stamped["execution_provenance"] = copy.deepcopy(provenance)
    for task in stamped["tasks"]:
        task["execution_provenance"] = copy.deepcopy(provenance)
    return stamped


def _command_snapshot(args: argparse.Namespace) -> None:
    manifest = build_snapshot_manifest(args.snapshot_dir)
    _write_json_atomic(args.output, manifest)


def _command_verify_snapshot(args: argparse.Namespace) -> None:
    verify_snapshot(args.snapshot_dir, _read_json(args.manifest))


def _command_create(args: argparse.Namespace) -> None:
    manifest = _read_json(args.snapshot_manifest)
    verify_snapshot(args.snapshot_dir, manifest)
    config = build_config(args.config_version, args.config_value)
    provenance = build_provenance(
        base_sha=args.base_sha,
        workspace_patch_sha256=args.workspace_patch_sha256,
        snapshot_manifest=manifest,
        config=config,
    )
    _write_json_atomic(args.output, provenance)


def _command_validate(args: argparse.Namespace) -> None:
    load_provenance(args.provenance)


def _command_verify_binding(args: argparse.Namespace) -> None:
    provenance = load_provenance(args.provenance)
    manifest = _read_json(args.manifest)
    verify_snapshot(args.snapshot_dir, manifest)
    snapshot = provenance["controller_snapshot"]
    assert isinstance(snapshot, dict)
    if snapshot.get("sha256") != manifest.get("sha256"):
        raise ProvenanceError(
            "execution provenance controller snapshot does not match the staged immutable snapshot"
        )
    verify_code_binding(
        provenance,
        base_sha=args.base_sha,
        workspace_patch_sha256=args.workspace_patch_sha256,
    )


def _command_verify_code(args: argparse.Namespace) -> None:
    provenance = load_provenance(args.provenance)
    verify_code_binding(
        provenance,
        base_sha=args.base_sha,
        workspace_patch_sha256=args.workspace_patch_sha256,
    )


def _command_digest_task_matrix(args: argparse.Namespace) -> None:
    matrix = build_task_matrix(args.task)
    _write_json_atomic(args.output, matrix)
    print(matrix["sha256"])


def _command_stamp(args: argparse.Namespace) -> None:
    provenance = load_provenance(args.provenance)
    document = _read_json(args.run_json)
    _write_json_atomic(args.output, stamp_run_document(document, provenance))


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    snapshot = commands.add_parser("snapshot")
    snapshot.add_argument("--snapshot-dir", type=Path, required=True)
    snapshot.add_argument("--output", type=Path, required=True)
    snapshot.set_defaults(function=_command_snapshot)
    verify = commands.add_parser("verify-snapshot")
    verify.add_argument("--snapshot-dir", type=Path, required=True)
    verify.add_argument("--manifest", type=Path, required=True)
    verify.set_defaults(function=_command_verify_snapshot)
    create = commands.add_parser("create")
    create.add_argument("--base-sha", required=True)
    create.add_argument("--workspace-patch-sha256", required=True)
    create.add_argument("--snapshot-dir", type=Path, required=True)
    create.add_argument("--snapshot-manifest", type=Path, required=True)
    create.add_argument("--config-version", default=CONFIG_SCHEMA_VERSION)
    create.add_argument("--config-value", action="append", default=[])
    create.add_argument("--output", type=Path, required=True)
    create.set_defaults(function=_command_create)
    validate = commands.add_parser("validate")
    validate.add_argument("--provenance", type=Path, required=True)
    validate.set_defaults(function=_command_validate)
    binding = commands.add_parser("verify-binding")
    binding.add_argument("--provenance", type=Path, required=True)
    binding.add_argument("--base-sha", required=True)
    binding.add_argument("--workspace-patch-sha256", required=True)
    binding.add_argument("--snapshot-dir", type=Path, required=True)
    binding.add_argument("--manifest", type=Path, required=True)
    binding.set_defaults(function=_command_verify_binding)
    code = commands.add_parser("verify-code")
    code.add_argument("--provenance", type=Path, required=True)
    code.add_argument("--base-sha", required=True)
    code.add_argument("--workspace-patch-sha256", required=True)
    code.set_defaults(function=_command_verify_code)
    matrix = commands.add_parser("digest-task-matrix")
    matrix.add_argument("--task", action="append", required=True)
    matrix.add_argument("--output", type=Path, required=True)
    matrix.set_defaults(function=_command_digest_task_matrix)
    stamp = commands.add_parser("stamp")
    stamp.add_argument("--run-json", type=Path, required=True)
    stamp.add_argument("--provenance", type=Path, required=True)
    stamp.add_argument("--output", type=Path, required=True)
    stamp.set_defaults(function=_command_stamp)
    return parser


def main() -> int:
    args = _parser().parse_args()
    try:
        args.function(args)
    except (OSError, ProvenanceError) as exc:
        print(f"execution provenance rejected: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
