#!/usr/bin/env python3
"""Attest a captured cloud guest stopped before service/provider startup.

The exact stopped original volume must be captured first. This receipt can
retire runtime ownership with zero benchmark credit; it is never a run result.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import importlib.util
import io
import json
import os
import re
import stat
import subprocess
import tarfile
from pathlib import Path

MISSING_STACK = {
    "cloudbench-driver.pid",
    "repo/.context/cloudbench/services.json",
    "repo/.context/cloudbench/stack.log",
    "repo/.context/cloudbench/logs/backend.log",
    "repo/.context/cloudbench/logs/worker.log",
    "repo/.context/cloudbench/run.json",
}


def regular(path: Path, maximum: int = 64 * 1024 * 1024) -> bytes:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
        raise ValueError(f"missing or unsafe regular file: {path}")
    return path.read_bytes()


def fields(path: Path) -> dict[str, str]:
    pairs = [line.split("=", 1) for line in regular(path, 65536).decode().splitlines()]
    if any(len(pair) != 2 for pair in pairs):
        raise ValueError("malformed owner metadata")
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("duplicate owner metadata")
    return result


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def bootstrap_regular(path: Path, maximum: int = 64 * 1024 * 1024) -> bytes:
    try:
        descriptor = os.open(
            path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0)
        )
    except OSError as error:
        raise ValueError("missing or unsafe bootstrap evidence file") from error
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
            raise ValueError("unsafe bootstrap evidence file")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            data = stream.read(maximum + 1)
        if len(data) != info.st_size or len(data) > maximum:
            raise ValueError("changed or oversized bootstrap evidence file")
        return data
    finally:
        os.close(descriptor)


def bootstrap_identity(
    registry: Path,
    bench: str,
    capture_dir: Path,
    machines_file: Path,
    volumes_file: Path,
) -> tuple[Path, dict[str, object]]:
    """Fresh task-free infra probe canceled during DB/dependency bootstrap.

    This proves no backend/worker/provider launch in one captured source
    recipe. It does not claim that run.sh or its isolated database never ran.
    The original Machine remains stopped until the normal exact fresh reaper.
    """

    def obj(path: Path, maximum: int = 1048576):
        return json.loads(bootstrap_regular(path, maximum))

    for path in (registry, capture_dir):
        if (
            not path.is_absolute()
            or path.resolve() != path
            or not path.is_dir()
            or path.is_symlink()
        ):
            raise ValueError("unsafe bootstrap owner or capture path")
    owner = registry.name
    if not re.fullmatch(r"[0-9a-f]{32}", owner) or not re.fullmatch(
        r"[A-Za-z0-9._-]+", bench
    ):
        raise ValueError("unsafe bootstrap identity")
    meta = fields(registry / "meta")
    if (
        meta.get("version") != "2"
        or meta.get("fleet_owner_token") != owner
        or meta.get("cleanup_policy") not in {"retain", "reap"}
        or (registry / "runtime-evidence-unconfirmed").exists()
        or (registry / "runtime-evidence-unconfirmed").is_symlink()
    ):
        raise ValueError("bootstrap owner has unarchived runtime or unsafe policy")
    run_id = meta["run_id"]
    run, audit = Path(meta["runs_root"]) / run_id, Path(meta["audit_dir"])
    if (
        not run.is_absolute()
        or run.resolve() != run
        or not run.is_dir()
        or not audit.is_absolute()
        or audit.resolve() != audit
        or audit.name != owner
    ):
        raise ValueError("bootstrap run or audit is not exact")
    audit_meta = fields(audit / "meta")
    if any(
        audit_meta.get(key) != meta[key]
        for key in ("fleet_owner_token", "run_id", "app")
    ):
        raise ValueError("bootstrap audit owner disagrees")
    lifecycle, tasks = (
        obj(run / "_batch/lifecycle.json"),
        obj(run / "_batch/benches.json"),
    )
    if (
        lifecycle.get("status") != "failed"
        or lifecycle.get("fleet_owner_token") != owner
        or lifecycle.get("run_id") != run_id
        or type(lifecycle.get("controller_exit_code")) is not int
        or lifecycle["controller_exit_code"] == 0
        or not isinstance(tasks, list)
        or not tasks
        or any(not isinstance(row, dict) for row in tasks)
    ):
        raise ValueError("bootstrap fleet is not terminal and failed")
    names = [row.get("name") for row in tasks]
    if len(set(names)) != len(names) or bench not in names:
        raise ValueError("bootstrap catalog slot is not exact")
    out, token = run / bench, f"{owner}-{names.index(bench)}"
    cid = bootstrap_regular(out / ".cid", 256).decode().split()
    if len(cid) != 2 or cid[0] != "clone" or not re.fullmatch(r"[0-9a-f]{14}", cid[1]):
        raise ValueError("bootstrap guest is not a fresh clone")
    machine = cid[1]
    clone = bootstrap_regular(audit / "by-machine-id" / machine, 256).decode().strip()
    if not re.fullmatch(r"cloudbench-[A-Za-z0-9._-]+", clone):
        raise ValueError("bootstrap clone index is unsafe")
    fresh = fields(audit / "fresh" / clone)
    claimed = fields(registry / "clones" / clone)
    volume = fresh.get("volume_id", "")
    if (
        any(
            fresh.get(key) != meta[key]
            for key in ("fleet_owner_token", "run_id", "app")
        )
        or fresh.get("source") != "fresh-clone"
        or fresh.get("disposition") != "owned"
        or fresh.get("clone_name") != clone
        or fresh.get("machine_id") != machine
        or not re.fullmatch(r"vol_[A-Za-z0-9]+", volume)
        or claimed != {"name": clone, "id": machine, "volume_id": volume}
    ):
        raise ValueError("bootstrap fresh ownership is not exact")
    if (
        bootstrap_regular(out / "post-config-start.accepted", 256)
        != (machine + "\n").encode()
        or bootstrap_regular(out / "primary.ids", 256) != (machine + "\n").encode()
        or bootstrap_regular(out / "benchmark-child.finished", 256).strip() != b"143"
        or bootstrap_regular(out / "desired-worker-count", 256).strip() != b"0"
    ):
        raise ValueError("bootstrap child did not terminate before worker allocation")
    for name in (
        "cloudbench-run.json",
        "runtime-evidence.pending",
        "worker-runtime-evidence",
    ):
        if (out / name).exists() or (out / name).is_symlink():
            raise ValueError("bootstrap guest crossed runtime evidence boundary")
    for name in (
        "guest-cleanup.provider-manifest.json",
        "guest-cleanup.recovery-receipt.json",
    ):
        if (out / name).exists() or (out / name).is_symlink():
            raise ValueError(
                "bootstrap receipt must remain distinct from guest/provider acknowledgement"
            )
    machines, volumes = (
        obj(machines_file, 128 * 1024 * 1024),
        obj(volumes_file, 128 * 1024 * 1024),
    )
    if not isinstance(machines, list) or not isinstance(volumes, list):
        raise ValueError("unsafe bootstrap native inventory")
    native = [row for row in machines if row.get("id") == machine]
    native_volume = [row for row in volumes if row.get("id") == volume]
    config_bytes = bootstrap_regular(
        capture_dir / f"{machine}.original-config.private.json", 1048576
    )
    config = json.loads(config_bytes)
    if (
        not isinstance(config, dict)
        or not isinstance(config.get("env"), dict)
        or not isinstance(config.get("files"), list)
    ):
        raise ValueError("original native source config schema is invalid")
    if (
        len(native) != 1
        or len(native_volume) != 1
        or native[0].get("state") != "stopped"
        or native[0].get("name") != clone
        or native[0].get("config") != config
        or native_volume[0].get("attached_machine_id") != machine
        or config.get("init", {}).get("cmd") != ["bash", "/cloudbench-boot.sh"]
        or not isinstance(config.get("mounts"), list)
        or len(config["mounts"]) != 1
        or config["mounts"][0].get("volume") != volume
        or config["mounts"][0].get("path") != "/data"
        or "@sha256:" not in config.get("image", "")
    ):
        raise ValueError("original stopped bootstrap config or volume is not exact")
    marker = out / "guest-shutdown.confirmed"
    if (marker.exists() or marker.is_symlink()) and bootstrap_regular(marker, 256) != (
        run_id + "\n"
    ).encode():
        raise ValueError("existing genuine cleanup confirmation belongs to another run")
    return out, dict(
        meta=meta,
        config=config,
        token=token,
        machine=machine,
        volume=volume,
        clone=clone,
    )


RECIPE_PATHS = (
    "scripts/run-bench-cloud",
    "scripts/run-bench-fleet",
    "scripts/cloudbench-run.sh",
    "scripts/cloudbench-guest-recovery.py",
    "scripts/cloudbench-status-server.py",
    "scripts/run.sh",
    "scripts/ensure-workspace-dependencies.sh",
    "scripts/lib/run-process-cleanup.sh",
    "scripts/lib/workspace-env.sh",
    "scripts/lib/ngrok-tunnel.sh",
    "scripts/lib/run-context.sh",
    "scripts/lib/run-service-readiness.sh",
    "scripts/lib/seed-cache.sh",
    "scripts/lib/fast-mode-cache-schema.sh",
    "scripts/lib/local-pg-image.sh",
    "back-end/scripts/apply-local-workflow-ddl.sh",
    "back-end/scripts/ensure-agent-network-grep-indexes.ts",
    "back-end/scripts/ensure-fast-mode-cache-schema.ts",
    "package.json",
    "back-end/package.json",
    "front-end/package.json",
)


def git_blob(root: Path, ref: str, path: str) -> bytes:
    """One bounded loader for bound-source blobs (fingerprint and comparison)."""
    result = subprocess.run(
        ["git", "-C", str(root), "show", f"{ref}:{path}"],
        capture_output=True,
        timeout=15,
    )
    if result.returncode or len(result.stdout) > 67108864:
        raise ValueError("bound source blob is unavailable")
    return result.stdout


def _bound_optional_executables(root: Path, ref: str) -> tuple[str, ...]:
    """Bind the optional browser helper by Git ref when that source commits it."""
    path = "scripts/ensure-playwright-browsers.py"
    result = subprocess.run(
        ["git", "-C", str(root), "ls-tree", "-z", ref, "--", path],
        capture_output=True, timeout=15,
    )
    if result.returncode:
        raise ValueError("bound optional executable lookup failed")
    if not result.stdout:
        return ()
    rows = result.stdout.split(b"\0")
    if len(rows) != 2 or rows[-1] or b"\t" not in rows[0]:
        raise ValueError("unsafe optional executable tree entry")
    metadata, name = rows[0].split(b"\t", 1)
    mode, kind, _oid = metadata.split()
    if name != path.encode() or mode not in (b"100644", b"100755") or kind != b"blob":
        raise ValueError("optional executable must be a regular committed blob")
    return (path,)


def recipe_paths(blob, root: Path | None = None, ref: str | None = None) -> tuple[str, ...]:
    # Historical captures retain their original checkout binding and fingerprint.
    # A source that can delegate native mutations must bind that authority and
    # both identity providers, including the parent that mints feed identity.
    paths = RECIPE_PATHS
    if b"cloudbench-campaign-mutation.py" in blob("scripts/run-bench-fleet"):
        paths += (
            "scripts/cloudbench-campaign-mutation.py",
            "scripts/cloudbench-script-snapshot.py",
            "scripts/run-bench-campaign.py",
            "scripts/cloudbench-port-lease.py",
        )
    if root is not None and ref is not None:
        paths += _bound_optional_executables(root, ref)
    return paths


def native_recipe(meta: dict[str, str], config: dict) -> tuple[str, str, str]:
    if (
        not isinstance(config, dict)
        or not isinstance(config.get("env"), dict)
        or not isinstance(config.get("files"), list)
    ):
        raise ValueError("original native source config schema is invalid")
    script_inputs = {
        "CLOUDBENCH_RUN_SCRIPT": "/cloudbench-run.sh",
        "CLOUDBENCH_FETCH_REF_SCRIPT": "/cloudbench-fetch-ref.sh",
        "CLOUDBENCH_STATUS_SERVER_SCRIPT": "/cloudbench-status-server.py",
        "CLOUDBENCH_BENCHMARK_TARGET_SCRIPT": "/cloudbench-benchmark-target.py",
        "CLOUDBENCH_CATALOG_SCRIPT": "/cloudbench_catalog.py",
        "CLOUDBENCH_CURRENT_RUN_ARTIFACT_SCRIPT": "/cloudbench-current-run-artifact.py",
        "CLOUDBENCH_EXACT_SESSION_CLEANUP_SCRIPT": "/cloudbench-exact-session-cleanup.py",
        "CLOUDBENCH_EXECUTION_PROVENANCE_SCRIPT": "/cloudbench-execution-provenance.py",
        "CLOUDBENCH_GUEST_RECOVERY_SCRIPT": "/cloudbench-guest-recovery.py",
        "CLOUDBENCH_NGROK_INSTALL_SCRIPT": "/cloudbench-install-ngrok.sh",
        "CLOUDBENCH_PREPARE_PATCH_SCRIPT": "/cloudbench-prepare-patch.sh",
        "CLOUDBENCH_SYNC_DEPS_SCRIPT": "/cloudbench-sync-deps.sh",
        "CLOUDBENCH_SYNC_PRISMA_SCRIPT": "/cloudbench-sync-prisma-client.sh",
    }
    for key, value in config["env"].items():
        if (
            key.startswith("CLOUDBENCH_")
            and key.endswith("_SCRIPT")
            and script_inputs.get(key) != value
        ):
            raise ValueError(
                "native executable input is outside the bound source control schema"
            )
    ref = config.get("env", {}).get("REF", "")
    workspace = meta.get("workspace_root")
    if not isinstance(workspace, str) or not workspace:
        raise ValueError("execution lacks an immutable workspace binding")
    root = Path(workspace)
    if (
        re.fullmatch(r"[0-9a-f]{40}", ref) is None
        or not root.is_absolute()
        or root.resolve() != root
        or not root.is_dir()
    ):
        raise ValueError("execution lacks an immutable source binding")

    def blob(path: str) -> bytes:
        return git_blob(root, ref, path)

    expected = {path: sha(blob(path)) for path in recipe_paths(blob, root, ref)}
    injected = {}
    for item in config.get("files", []):
        if (
            not isinstance(item, dict)
            or set(item) != {"guest_path", "raw_value"}
            or item["guest_path"] in injected
        ):
            raise ValueError("unsafe original injected control files")
        injected[item["guest_path"]] = base64.b64decode(
            item["raw_value"], validate=True
        )
    for name in (
        "cloudbench-boot.sh",
        "cloudbench-boot-payload.py",
        "cloudbench-status-server.py",
    ):
        if injected.get("/" + name) != blob("scripts/" + name):
            raise ValueError("original injected boot control differs from bound source")
    payload_path = config["env"].get("CLOUDBENCH_BOOT_PAYLOAD_FILE")
    direct_paths = {
        "/cloudbench-boot.sh",
        "/cloudbench-boot-payload.py",
        "/cloudbench-status-server.py",
        "/cloudbench-boot-payload.json.gz",
    }
    if (
        payload_path != "/cloudbench-boot-payload.json.gz"
        or set(injected) != direct_paths
    ):
        raise ValueError(
            "original direct native file set differs from the bound boot recipe"
        )
    envelope = injected.get(payload_path)
    if (
        not isinstance(envelope, bytes)
        or len(envelope) > 16777216
        or sha(envelope) != config["env"].get("CLOUDBENCH_BOOT_PAYLOAD_SHA256")
    ):
        raise ValueError("original boot envelope is not checksum bound")
    with gzip.GzipFile(fileobj=io.BytesIO(envelope)) as stream:
        unpacked = stream.read(67108865)
    if len(unpacked) > 67108864:
        raise ValueError("original boot envelope exceeds its source limit")
    packed = json.loads(unpacked)
    if (
        not isinstance(packed, dict)
        or set(packed) != {"version", "files"}
        or packed["version"] != 1
        or not isinstance(packed["files"], dict)
    ):
        raise ValueError("unsafe original boot envelope schema")
    controls = {}
    document = None
    for name, content in packed["files"].items():
        if name != "process-identity.py" and re.fullmatch(r"cloudbench[-_][A-Za-z0-9_.-]+", name) is None:
            raise ValueError("unsafe packed control name")
        data = base64.b64decode(content, validate=True)
        if name == "cloudbench-execution-provenance.json":
            document = json.loads(data)
            continue
        if name == "cloudbench-execution-provenance.py":
            path = "scripts/cloudbench_execution_provenance.py"
        elif name in ("cloudbench-env.sh", "cloudbench-seed-budget.sh"):
            path = "scripts/lib/" + name
        else:
            path = "scripts/" + name
        if data != blob(path):
            raise ValueError("actual packed executable differs from bound source")
        controls[path] = sha(data)
    if not {"scripts/cloudbench-run.sh", "scripts/cloudbench-fetch-ref.sh"} <= set(
        controls
    ):
        raise ValueError("original packed driver/fetch pair is incomplete")
    # JSON is owned by the existing provenance validator, never interpreted as
    # executable code or admitted solely because its filename ends in .json.
    if document is None:
        raise ValueError("original packed execution provenance document is missing")
    helper = Path(__file__).with_name("cloudbench_execution_provenance.py")
    if bootstrap_regular(helper) != blob("scripts/cloudbench_execution_provenance.py"):
        raise ValueError("local provenance validator differs from bound source")
    spec = importlib.util.spec_from_file_location("bound_execution_owner", helper)
    if spec is None or spec.loader is None:
        raise ValueError("execution provenance owner module cannot be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if module.validate_provenance(document):
        raise ValueError("original packed execution provenance is invalid")
    module.verify_code_binding(document, base_sha=ref, workspace_patch_sha256="none")
    original_provenance = (
        Path(meta["runs_root"]) / meta["run_id"] / "execution-provenance.json"
    )
    if json.loads(bootstrap_regular(original_provenance, 1048576)) != document:
        raise ValueError("packed provenance differs from original bound fleet input")
    recipe = {
        "checkout": expected,
        "injected_controls": controls,
        "boot_controls": {
            name: sha(injected["/" + name])
            for name in (
                "cloudbench-boot.sh",
                "cloudbench-boot-payload.py",
                "cloudbench-status-server.py",
            )
        },
        "execution_provenance_sha256": sha(module.canonical_bytes(document)),
    }
    source_recipe = {
        key: recipe[key] for key in ("checkout", "injected_controls", "boot_controls")
    }
    source_fingerprint = sha(
        json.dumps(source_recipe, sort_keys=True, separators=(",", ":")).encode()
    )
    return (
        ref,
        sha(json.dumps(recipe, sort_keys=True, separators=(",", ":")).encode()),
        source_fingerprint,
    )


def bound_recipe(meta: dict[str, str], config: dict, provenance: dict) -> tuple[str, str, str]:
    result = native_recipe(meta, config)
    # native_recipe has validated this exact absolute, resolved workspace root.
    ref, root = result[0], Path(meta["workspace_root"])

    def blob(path: str) -> bytes:
        return git_blob(root, ref, path)

    expected = {path: sha(blob(path)) for path in recipe_paths(blob, root, ref)}
    if (
        provenance.get("git_head") != ref
        or provenance.get("git_exit_code") != 0
        or provenance.get("tracked_change_exit_code") != 0
        or provenance.get("tracked_changed_paths") != []
        or provenance.get("source_file_sha256") != expected
    ):
        raise ValueError("captured checkout differs from the bound clean source")
    return result


def verify_bootstrap_current(
    registry: Path,
    bench: str,
    capture_dir: Path,
    machines_file: Path,
    volumes_file: Path,
) -> tuple[Path, dict]:
    out, ctx = bootstrap_identity(
        registry, bench, capture_dir, machines_file, volumes_file
    )
    meta, config, token, machine, volume, clone = (
        ctx[k] for k in ("meta", "config", "token", "machine", "volume", "clone")
    )
    env = config.get("env", {})
    if (
        env.get("CLOUDBENCH_RUN_TOKEN") != token
        or env.get("CLOUDBENCH_INFRA_PROBE") != "1"
        or env.get("CLOUDBENCH_FRESH_VOLUME") != "1"
        or env.get("BENCH_TASKS_B64") != base64.b64encode(bench.encode()).decode()
    ):
        raise ValueError("native config is not the exact task-free fresh infra probe")
    provenance_file = capture_dir / f"{machine}.provenance.safe.json"
    provenance = json.loads(bootstrap_regular(provenance_file, 1048576))
    capture = capture_dir / f"{machine}.originals.private.tar.gz"
    captured = bootstrap_regular(capture, 134217728)
    config_bytes = bootstrap_regular(
        capture_dir / f"{machine}.original-config.private.json", 1048576
    )
    if (
        provenance.get("version") != 1
        or provenance.get("direct_original_volume") is not True
        or provenance.get("source_machine_id") != machine
        or provenance.get("machine_id") != machine
        or provenance.get("source_volume_id") != volume
        or provenance.get("guest_run_token") != token
        or provenance.get("proof_credit") != 0
        or provenance.get("archive_sha256") != sha(captured)
        or provenance.get("archive_bytes") != len(captured)
        or provenance.get("native_original_config_sha256") != sha(config_bytes)
    ):
        raise ValueError("original stopped guest archive/config provenance differs")
    ref, recipe_sha, source_fingerprint = bound_recipe(meta, config, provenance)
    originals = {}
    with tarfile.open(fileobj=io.BytesIO(captured), mode="r:gz") as stream:
        for member in stream:
            if (
                not member.isfile()
                or member.name in originals
                or Path(member.name).is_absolute()
                or ".." in Path(member.name).parts
                or member.size > 67108864
            ):
                raise ValueError("unsafe original-volume member")
            reader = stream.extractfile(member)
            if reader is None:
                raise ValueError("missing original-volume member")
            originals[member.name] = reader.read(member.size + 1)
            if len(originals[member.name]) != member.size:
                raise ValueError("truncated original-volume member")
    base = {
        "bench.log",
        "cloudbench-driver.state",
        f"cloudbench-shutdown-{token}.request",
    }
    optional = {
        "repo/.context/cloudbench/stack.log",
        f"cloudbench-driver-clean-{token}.ack",
        f"cloudbench-guest-state-{token}.json",
        "cloudbench-guest-recovery.py",
    }
    absent = {
        "cloudbench-driver.pid",
        "repo/.context/cloudbench/services.json",
        "repo/.context/cloudbench/run.json",
        "repo/.context/cloudbench/logs/backend.log",
        "repo/.context/cloudbench/logs/worker.log",
    }
    if (
        not base <= set(originals)
        or not set(originals) <= base | optional
        or not isinstance(provenance.get("missing"), list)
        or not absent <= set(provenance["missing"])
        or set(originals) & set(provenance["missing"])
        or provenance.get("files")
        != {
            name: {"bytes": len(data), "sha256": sha(data)}
            for name, data in originals.items()
        }
        or originals["cloudbench-driver.state"] != b"exited\n"
        or originals[f"cloudbench-shutdown-{token}.request"] != b""
    ):
        raise ValueError("archive lacks complete original files or pre-service absence")
    ack = f"cloudbench-driver-clean-{token}.ack"
    if ack in originals and originals[ack] != (token + "\n").encode():
        raise ValueError("original native cleanup ACK has a different owner")
    if "cloudbench-guest-recovery.py" in originals:
        if (
            sha(originals["cloudbench-guest-recovery.py"])
            != provenance["source_file_sha256"]["scripts/cloudbench-guest-recovery.py"]
        ):
            raise ValueError("captured recovery helper differs from bound source")
    state_name = f"cloudbench-guest-state-{token}.json"
    if state_name in originals:
        state = json.loads(originals[state_name])
        if (
            state.get("machine_id") != machine
            or state.get("guest_run_token") != token
            or state.get("driver_state") != "exited"
            or state.get("driver_process_state") is not None
            or state.get("driver_descendants") != []
            or state.get("driver_token_match") is not False
            or any(
                state.get(key, {}).get("exists") is not False
                for key in ("services_manifest", "run_json", "backend_log")
            )
        ):
            raise ValueError(
                "original recovery state differs from exited pre-service guest"
            )
    bench_log = originals["bench.log"].decode()
    if (
        not bench_log.startswith(f"RUNSTAMP-{token}\n")
        or "guest shutdown requested" not in bench_log
        or "driver exited rc=143; holding for controller collection" not in bench_log
        or "stack healthy" in bench_log
        or "running benchmark:" in bench_log
    ):
        raise ValueError("original driver crossed the task/service boundary")
    stack_name = "repo/.context/cloudbench/stack.log"
    if stack_name not in originals:
        if (
            stack_name not in provenance["missing"]
            or ack not in originals
            or "launching stack (run.sh --benchmark)" in bench_log
            or "waiting for stack to become healthy" in bench_log
        ):
            raise ValueError(
                "missing stack log is not an acknowledged pre-stack cancellation"
            )
        phase, database_created = "before-stack-launch", False
    else:
        if (
            "launching stack (run.sh --benchmark)" not in bench_log
            or "waiting for stack to become healthy" not in bench_log
            or "stack worker cleanup was not confirmed; refusing guest cleanup acknowledgement"
            not in bench_log
            or ack in originals
        ):
            raise ValueError("bootstrap stack interruption is not exact")
        stack = originals[stack_name].decode()
        lines = stack.splitlines()
        db = re.findall(
            r"Created isolated system database ([A-Za-z_][A-Za-z0-9_]{0,62})", stack
        )
        if len(db) != 1 or "DB restored from dump" not in stack or not lines:
            raise ValueError("original isolated database bootstrap is incomplete")
        if lines[-1] == "📦 Installing front-end dependencies...":
            phase = "frontend-dependency-preflight"
        elif (
            "🔎 Ensuring agent-network grep indexes (post-restore)..." in stack
            and not any(
                marker in stack
                for marker in (
                    "🧠 Re-ensuring Fast Mode cache schema (post-restore)...",
                    "🗜️  Saving seed dump for fast future warm-starts",
                    "📦 Installing front-end dependencies...",
                    "📦 Ensuring Playwright browser assets...",
                    "🌱 Local database already seeded; syncing browser credentials...",
                    "🌱 Syncing production data to local database",
                )
            )
            # Every public-tunnel step (domain reservation, launch or skip)
            # prints a 🌐 line; on Linux guests none of the markers above sits
            # between the index step and that first provider allocation.
            and not any(line.startswith("🌐 ") for line in lines)
        ):
            # Native cancellation can append command help/cleanup diagnostics
            # after the final phase marker. Bound source review proves this
            # whole interval still precedes service/provider startup.
            phase = "agent-network-index-bootstrap"
        else:
            raise ValueError("original final source boundary is not supported")
        database_created = True
    return out, {
        "version": 1,
        "kind": "fresh-infra-bootstrap-zero-provider",
        "fleet_owner_token": registry.name,
        "run_id": meta["run_id"],
        "bench": bench,
        "machine_id": machine,
        "volume_id": volume,
        "clone_name": clone,
        "run_token": token,
        "provider_state": "stopped",
        "proof_credit": 0,
        "isolated_database_created": database_created,
        "provider_allocation_count": 0,
        "bootstrap_phase": phase,
        "source_ref": ref,
        "source_recipe_sha256": recipe_sha,
        "source_review_fingerprint": source_fingerprint,
        "capture_dir": str(capture_dir),
        "capture_sha256": sha(captured),
        "capture_provenance_sha256": sha(bootstrap_regular(provenance_file)),
        "native_original_config_sha256": sha(config_bytes),
        "original_file_sha256": {
            name: sha(data) for name, data in sorted(originals.items())
        },
    }


def trusted_source_review_policy() -> dict[str, list[str]]:
    """Read executable-source approvals from the invoked helper's committed Git source."""
    helper = Path(__file__).resolve()
    result = subprocess.run(
        ["git", "-C", str(helper.parent), "rev-parse", "--show-toplevel"],
        capture_output=True,
        text=True,
        timeout=15,
    )
    canonical_root = (
        Path(result.stdout.strip()).resolve() if result.returncode == 0 else None
    )
    canonical = (
        canonical_root is not None
        and helper == canonical_root / "scripts/cloudbench-prestack-recovery.py"
    )
    if canonical:
        root, ref = canonical_root, "HEAD"
    else:
        workspace = os.environ.get("CLOUDBENCH_FLEET_ROOT", "")
        ref = os.environ.get("CLOUDBENCH_PRESTACK_CONTROLLER_REF", "")
        snapshot = os.environ.get("CLOUDBENCH_SCRIPT_SNAPSHOT", "")
        if (
            not workspace
            or not Path(workspace).is_absolute()
            or Path(workspace).resolve() != Path(workspace)
            or re.fullmatch(r"[0-9a-f]{40}", ref) is None
            or snapshot != str(helper.parent)
        ):
            raise ValueError(
                "source review policy lacks a trusted controller source binding"
            )
        root = Path(workspace)
        source_root = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if source_root.returncode or source_root.stdout.strip() != str(root):
            raise ValueError("source review policy lacks a trusted Git checkout")
    policy_path = helper.with_name("cloudbench-prestack-source-reviews.json")
    owner_path = helper.with_name("cloudbench_execution_provenance.py")
    committed = {}
    for path in (helper, policy_path, owner_path):
        relative = "scripts/" + path.name
        blob = subprocess.run(
            ["git", "-C", str(root), "show", f"{ref}:{relative}"],
            capture_output=True,
            timeout=15,
        )
        if blob.returncode or bootstrap_regular(path, 1048576) != blob.stdout:
            raise ValueError(
                "source review policy or helper differs from trusted committed source"
            )
        committed[path] = blob.stdout
    if not canonical:
        spec = importlib.util.spec_from_file_location(
            "trusted_snapshot_owner", owner_path
        )
        if spec is None or spec.loader is None:
            raise ValueError("controller snapshot provenance owner cannot be loaded")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        manifest = json.loads(
            bootstrap_regular(helper.parent / module.SNAPSHOT_MANIFEST_NAME, 1048576)
        )
        module.verify_snapshot(helper.parent, manifest)
    policy = json.loads(committed[policy_path])
    if (
        not isinstance(policy, dict)
        or set(policy) != {"schema_version", "reviewed_executable_sources"}
        or policy["schema_version"] != 1
        or not isinstance(policy["reviewed_executable_sources"], dict)
        or not policy["reviewed_executable_sources"]
    ):
        raise ValueError("trusted source review policy schema is invalid")
    sources = policy["reviewed_executable_sources"]
    for fingerprint, phases in sources.items():
        if (
            re.fullmatch(r"[0-9a-f]{64}", fingerprint) is None
            or not isinstance(phases, list)
            or not phases
            or len(set(phases)) != len(phases)
            or any(
                phase
                not in {
                    "before-stack-launch",
                    "agent-network-index-bootstrap",
                    "frontend-dependency-preflight",
                }
                for phase in phases
            )
        ):
            raise ValueError("trusted source review policy entry is invalid")
    return sources


def require_independent_source_review(receipt: dict) -> None:
    sources = trusted_source_review_policy()
    if receipt.get("bootstrap_phase") not in sources.get(
        receipt.get("source_review_fingerprint"), []
    ):
        raise ValueError(
            "executable source boundary lacks a trusted independent review"
        )
    # The capture-local marker binds this audited instance; only the committed
    # source policy above can authorize its executable source and phase.
    review = json.loads(
        bootstrap_regular(
            Path(receipt["capture_dir"]) / "source-boundary-reviewed.safe.json", 65536
        )
    )
    if (
        review.get("reviewed") is not True
        or not isinstance(review.get("reviewer"), str)
        or not review["reviewer"].strip()
        or review.get("source_ref") != receipt["source_ref"]
        or review.get("source_recipe_sha256") != receipt["source_recipe_sha256"]
        or receipt["bootstrap_phase"] not in review.get("pre_service_boundaries", [])
    ):
        raise ValueError("independent bound-source pre-service review is missing")


def verify_bootstrap(
    registry: Path,
    bench: str,
    capture_dir: Path,
    machines_file: Path,
    volumes_file: Path,
) -> tuple[Path, dict]:
    return verify_bootstrap_current(
        registry, bench, capture_dir, machines_file, volumes_file
    )


def verify(
    registry: Path,
    bench: str,
    capture_dir: Path,
    machines_file: Path,
    volumes_file: Path,
) -> tuple[Path, dict[str, object]]:
    if bench != "message-person":
        return verify_bootstrap(
            registry, bench, capture_dir, machines_file, volumes_file
        )
    owner = registry.name
    if not re.fullmatch(r"[0-9a-f]{32}", owner) or bench != "message-person":
        raise ValueError("unsupported prestack owner or task")
    meta = fields(registry / "meta")
    if (
        meta.get("version") != "2"
        or meta.get("fleet_owner_token") != owner
        or meta.get("cleanup_policy") != "reap"
        or (registry / "guest-cleanup-unconfirmed").exists()
        or not (registry / "runtime-evidence-unconfirmed").is_file()
    ):
        raise ValueError("exact owner cleanup and runtime latches are not ready")
    run_id = meta["run_id"]
    run = Path(meta["runs_root"]) / run_id
    if not run.is_absolute() or run.resolve() != run:
        raise ValueError("unsafe original run path")
    lifecycle = json.loads(regular(run / "_batch/lifecycle.json", 1048576))
    tasks = json.loads(regular(run / "_batch/benches.json", 1048576))
    if (
        lifecycle.get("status") != "failed"
        or lifecycle.get("fleet_owner_token") != owner
        or len([task for task in tasks if task.get("name") == bench]) != 1
    ):
        raise ValueError("failed fleet and task identity are not exact")
    ordinal = next(index for index, task in enumerate(tasks) if task["name"] == bench)
    token = f"{owner}-{ordinal}"
    out = run / bench
    kind, machine = regular(out / ".cid", 256).decode().split()
    if kind != "pool" or not re.fullmatch(r"[0-9a-f]{14}", machine):
        raise ValueError("task is not bound to one pool Machine")
    audit = Path(meta["audit_dir"])
    pool = fields(audit / "pool" / machine)
    volume = pool.get("volume_id", "")
    if (
        pool.get("fleet_owner_token") != owner
        or pool.get("run_id") != run_id
        or pool.get("app") != meta["app"]
        or pool.get("source") != "borrowed-pool"
        or pool.get("disposition") != "claimed"
        or not re.fullmatch(r"vol_[A-Za-z0-9]+", volume)
    ):
        raise ValueError("original pool claim is not exact")
    record = {"version": 1, "machine_id": machine, "run_token": token}
    if (
        json.loads(regular(out / "runtime-evidence.owner.json", 4096)) != record
        or json.loads(regular(out / "runtime-evidence.pending", 4096)) != record
    ):
        raise ValueError("runtime evidence is not bound to the original guest")
    if (
        regular(out / "guest-shutdown.confirmed", 256) != (run_id + "\n").encode()
        or regular(out / "post-config-start.accepted", 256) != (machine + "\n").encode()
        or regular(out / "worker-clones.ids", 4096)
        or regular(out / "benchmark-child.finished", 256).strip() == b"0"
        or (out / "cloudbench-run.json").exists()
        or (out / "remote-logs/runtime-evidence/manifest.json").exists()
    ):
        raise ValueError("guest was not a failed, cleaned prestack start")
    child = regular(out / "fleet-child.log", 1048576).decode()
    if (
        "Live message-person benchmark requires a macOS controller for Apple Messages"
        not in child
        or "Original exit code: 70" not in child
    ):
        raise ValueError("controller did not reject the unsupported platform")
    machines = json.loads(regular(machines_file, 128 * 1024 * 1024))
    volumes = json.loads(regular(volumes_file, 128 * 1024 * 1024))
    native = next((value for value in machines if value.get("id") == machine), None)
    native_volume = next(
        (value for value in volumes if value.get("id") == volume), None
    )
    if (
        native is None
        or native.get("state") != "stopped"
        or (native.get("config") or {}).get("mounts", [{}])[0].get("volume") != volume
        or (native.get("config") or {}).get("init", {}).get("cmd")
        != ["bash", "/cloudbench-boot.sh"]
        or native_volume is None
        or native_volume.get("attached_machine_id") != machine
    ):
        raise ValueError("original Machine and volume are not stopped and attached")
    capture_path = capture_dir / f"{machine}.tar.gz"
    capture = regular(capture_path, 512 * 1024 * 1024)
    provenance = json.loads(regular(capture_dir / f"{machine}.provenance.json", 65536))
    if (
        provenance.get("direct_original_volume") is not True
        or provenance.get("source_machine_id") != machine
        or provenance.get("source_volume_id") != volume
        or provenance.get("archive_sha256") != sha(capture)
        or provenance.get("archive_bytes") != len(capture)
        or provenance.get("proof_credit") != 0
    ):
        raise ValueError("original-volume capture provenance is not exact")
    original: dict[str, bytes] = {}
    with tarfile.open(capture_path, "r:gz") as archive:
        for member in archive:
            if (
                not member.isfile()
                or member.name in original
                or ".." in Path(member.name).parts
            ):
                raise ValueError("unsafe original-volume member")
            stream = archive.extractfile(member)
            assert stream is not None
            original[member.name] = stream.read(member.size + 1)
            if len(original[member.name]) != member.size:
                raise ValueError("truncated original-volume member")
    clean_ack = f"cloudbench-driver-clean-{token}.ack"
    if (
        set(provenance.get("files", [])) != set(original)
        or not {"bench.log", "cloudbench-driver.state", clean_ack} <= set(original)
        or MISSING_STACK & set(original)
        or original["cloudbench-driver.state"].strip() != b"exited"
        or original[clean_ack] != (token + "\n").encode()
    ):
        raise ValueError("original guest did not stop before stack startup")
    bench_log = original["bench.log"].decode()
    if (
        owner not in bench_log
        or "git-syncing + verifying" not in bench_log
        or "guest shutdown requested" not in bench_log
        or "driver exited rc=143" not in bench_log
        or "stack healthy" in bench_log
        or "running benchmark" in bench_log
    ):
        raise ValueError("original driver crossed the prestack boundary")
    return out, {
        "version": 1,
        "kind": "unsupported-platform-prestack-zero",
        "fleet_owner_token": owner,
        "run_id": run_id,
        "bench": bench,
        "machine_id": machine,
        "volume_id": volume,
        "run_token": token,
        "provider_state": "stopped",
        "proof_credit": 0,
        "capture_sha256": sha(capture),
        "capture_provenance": provenance,
        "original_file_sha256": {
            name: sha(data) for name, data in sorted(original.items())
        },
    }


def publish(out: Path, receipt: dict[str, object]) -> None:
    if receipt.get("kind") == "fresh-infra-bootstrap-zero-provider":
        require_independent_source_review(receipt)
    path = out / (
        "guest-bootstrap.confirmed"
        if receipt.get("kind") == "fresh-infra-bootstrap-zero-provider"
        else "guest-prestack.confirmed"
    )
    payload = (
        json.dumps(receipt, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode()
    if path.exists() or path.is_symlink():
        if regular(path, 65536) != payload:
            raise ValueError("existing prestack receipt changed")
        return
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    descriptor = os.open(
        temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
    )
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--registry", required=True, type=Path)
    parser.add_argument("--bench", required=True)
    parser.add_argument("--capture-dir", required=True, type=Path)
    parser.add_argument("--machines-json", required=True, type=Path)
    parser.add_argument("--volumes-json", required=True, type=Path)
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--validate-published-bootstrap", action="store_true")
    args = parser.parse_args()
    out, receipt = verify(
        args.registry,
        args.bench,
        args.capture_dir,
        args.machines_json,
        args.volumes_json,
    )
    if args.validate_published_bootstrap:
        require_independent_source_review(receipt)
        if (
            args.publish
            or receipt.get("kind") != "fresh-infra-bootstrap-zero-provider"
            or json.loads(bootstrap_regular(out / "guest-bootstrap.confirmed", 1048576))
            != receipt
        ):
            raise ValueError(
                "published bootstrap retirement does not match exact original capture"
            )
    if args.publish:
        publish(out, receipt)
    print(
        json.dumps(
            {
                "verified": True,
                "published": args.publish,
                "machine_id": receipt["machine_id"],
                "proof_credit": 0,
            }
        )
    )


if __name__ == "__main__":
    main()
