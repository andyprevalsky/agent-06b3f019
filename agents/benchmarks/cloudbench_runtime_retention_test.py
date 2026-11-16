"""Runtime evidence must survive provider cleanup until its copy is verified."""

import hashlib
import json
import os
import runpy
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from benchmarks.cloudbench_dependency_sync_test import _extract_fleet_function, fleet_source_text

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize("mode", ["current", "stale", "forced"])
def test_runtime_pending_registry_cannot_be_reaped(tmp_path: Path, mode: str) -> None:
    registry = tmp_path / "owners" / "fleet-a"
    (registry / "clones").mkdir(parents=True)
    (registry / "runtime-evidence-unconfirmed").write_text("abc123\n")
    (registry / "meta").write_text("version=2\n")
    (registry / "clones" / "clone-a").write_text("name=clone-a\nid=abc123\nvolume_id=vol_a\n")
    mutations = tmp_path / "mutations"
    function = _extract_fleet_function(fleet_source_text(), "reap_registry_clones() {")
    result = subprocess.run(
        [
            "bash",
            "-c",
            function
            + """
registry_meta_value() { sed -n "s/^$2=//p" "$1"; }
registry_machine_details() { echo 'stopped clone-a'; }
fleet_registry_reconcile_mounted_volume() { echo vol_a; }
reap_machine() { echo destroy >> "$MUTATIONS"; }
reap_volume() { echo volume >> "$MUTATIONS"; }
fleet_audit_update_registry_clone() { :; }
reap_registry_clones "$REGISTRY" "$MODE"
""",
        ],
        env={
            **os.environ,
            "FLEET_OWNERSHIP_ROOT": str(registry.parent),
            "REGISTRY": str(registry),
            "MODE": mode,
            "MUTATIONS": str(mutations),
        },
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert result.returncode != 0, result.stdout + result.stderr
    assert not mutations.exists(), "uncopied runtime evidence was destroyed"
    assert (registry / "clones" / "clone-a").is_file()


@pytest.mark.parametrize("capture_ok", [True, False])
def test_worker_capture_precedes_scale_down_destroy(tmp_path: Path, capture_ok: bool) -> None:
    out = tmp_path / "task"
    out.mkdir()
    (out / "worker-clones.ids").write_text("abc123\n")
    (out / "worker-ready.ids").write_text("abc123\n")
    evidence = out / "worker-runtime-evidence" / "abc123"
    evidence.mkdir(parents=True)
    (evidence / "owner.json").write_text("{}\n")
    function = _extract_fleet_function(fleet_source_text(), "cleanup_failed_worker() {")
    result = subprocess.run(
        [
            "bash",
            "-c",
            function
            + """
worker_ledger_lock_acquire() { :; }
worker_ledger_lock_release() { :; }
fleet_registry_volume_for_id() { echo vol_a; }
cloudbench_capture_worker_runtime_evidence() {
    echo capture >> "$EVENTS"
    [ "$CAPTURE_OK" = 1 ]
}
reap_machine() { echo destroy >> "$EVENTS"; }
fleet_audit_update_fresh_clone_by_id() { :; }
fleet_registry_release_id() { :; }
cleanup_failed_worker "$OUT" abc123
""",
        ],
        env={**os.environ, "OUT": str(out), "EVENTS": str(tmp_path / "events"), "CAPTURE_OK": str(int(capture_ok))},
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    events = (tmp_path / "events").read_text().splitlines()
    assert events == (["capture", "destroy"] if capture_ok else ["capture"])
    assert (result.returncode == 0) == capture_ok
    if not capture_ok:
        assert (out / "worker-clones.ids").read_text() == "abc123\n"


def primary_fixture(out: Path, token: str = "run-0") -> Path:
    root = out / "remote-logs/runtime-evidence"
    (root / "logs").mkdir(parents=True)
    owner = {"version": 1, "run_token": token, "machine_id": "abc123"}
    (out / "runtime-evidence.owner.json").write_text(json.dumps(owner))
    files = {
        "services.json": json.dumps({"status": "stopped", "env": {"worker_processes": 2}}),
        "run.json": '{"tasks": []}',
        "stack.log": "stack log\n",
        f"cloudbench-stack-cleanup-{token}.status": f"state=clean\ntoken={token}\n",
        "logs/backend.log": "backend log\n",
        "logs/worker.log": "worker zero\n",
        "logs/worker.1.log": "worker one\n",
    }
    manifest = {**owner, "files": {}}
    for name, value in files.items():
        payload = value.encode()
        (root / name).write_bytes(payload)
        manifest["files"][name] = {"bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
    (root / "manifest.json").write_text(json.dumps(manifest))
    return root


@pytest.mark.parametrize(
    "fault", ["none", "live-machine", "foreign-volume", "foreign-owner", "archive", "credit", "successful-controller"]
)
def test_failed_controller_all_sealed_archive_retires_with_zero_credit(tmp_path: Path, fault: str) -> None:
    """A canceled collector can retain its latch after every guest seals."""
    owner = "a" * 32
    run_id = "failed-controller"
    registry = tmp_path / "owners" / owner
    audit = tmp_path / "audits" / owner
    run = tmp_path / "runs" / run_id
    (registry / "clones").mkdir(parents=True)
    for directory in ("pool", "fresh", "expected-fresh", "by-machine-id"):
        (audit / directory).mkdir(parents=True)
    (registry / "meta").write_text(
        f"version=2\nfleet_owner_token={owner}\napp=bench-app\nrun_id={run_id}\n"
        f"runs_root={run.parent}\naudit_dir={audit}\ncleanup_policy=reap\n"
    )
    latch = registry / "runtime-evidence-unconfirmed"
    latch.touch()
    (audit / "meta").write_text(f"fleet_owner_token={owner}\napp=bench-app\nrun_id={run_id}\n")
    (run / "_batch").mkdir(parents=True)
    tasks = [{"name": f"task-{i}"} for i in range(10)]
    lifecycle = {"status": "failed", "controller_exit_code": 143, "fleet_owner_token": owner}
    (run / "_batch/benches.json").write_text(json.dumps(tasks))
    (run / "_batch/lifecycle.json").write_text(json.dumps(lifecycle))
    machines, volumes = [], []
    for i, task in enumerate(tasks):
        machine, volume, token = f"abc{i:011x}", f"vol_fixture{i}", f"{owner}-{i}"
        out = run / task["name"]
        root = primary_fixture(out, token)
        identity = {"version": 1, "machine_id": machine, "run_token": token}
        (out / "runtime-evidence.owner.json").write_text(json.dumps(identity))
        payload = json.dumps({"tasks": [{"name": task["name"], "status": "FAILED"}]}).encode()
        (root / "run.json").write_bytes(payload)
        manifest = json.loads((root / "manifest.json").read_text())
        manifest.update(identity)
        manifest["files"]["run.json"] = {"bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
        (root / "manifest.json").write_text(json.dumps(manifest))
        (out / ".cid").write_text(f"pool {machine}\n")
        (out / "guest-shutdown.confirmed").write_text(run_id + "\n")
        (audit / "pool" / machine).write_text(
            f"fleet_owner_token={owner}\napp=bench-app\nrun_id={run_id}\n"
            f"machine_id={machine}\nvolume_id={volume}\nsource=borrowed-pool\ndisposition=claimed\n"
        )
        machines.append({"id": machine, "state": "stopped"})
        volumes.append({"id": volume, "attached_machine_id": machine})
    builder = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/cloudbench-build-interrupted-pool-archive.py"),
            "--registry",
            str(registry),
            "--capture-dir",
            str(tmp_path / "unused-captures"),
        ],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert builder.returncode == 0, builder.stderr
    assert json.loads(builder.stdout)["incomplete"] == 0
    assert json.loads(builder.stdout)["proof_credit"] == 0
    archive = run / "_forensic/originals.tar.gz"
    manifest_path = run / "_forensic/manifest.json"
    if fault == "live-machine":
        machines[0]["state"] = "started"
    elif fault == "foreign-volume":
        volumes[0]["attached_machine_id"] = "def456"
    elif fault == "foreign-owner":
        path = run / "task-0/runtime-evidence.owner.json"
        identity = json.loads(path.read_text())
        identity["run_token"] = "foreign-0"
        path.write_text(json.dumps(identity))
    elif fault == "archive":
        archive.write_bytes(archive.read_bytes() + b"altered")
    elif fault == "credit":
        manifest = json.loads(manifest_path.read_text())
        manifest["proof_credit"] = 1
        manifest_path.write_text(json.dumps(manifest))
    elif fault == "successful-controller":
        lifecycle.update(status="completed", controller_exit_code=0)
        (run / "_batch/lifecycle.json").write_text(json.dumps(lifecycle))
    machines_path, volumes_path = tmp_path / "machines.json", tmp_path / "volumes.json"
    machines_path.write_text(json.dumps(machines))
    volumes_path.write_text(json.dumps(volumes))
    functions = "\n".join(
        _extract_fleet_function(fleet_source_text(), name + "() {")
        for name in ("registry_meta_value", "fleet_recovery_confirm_forensic_retirement")
    )
    script = (
        functions
        + f"""
APP=bench-app
FORENSIC_RETIREMENT_HELPER={shlex.quote(str(ROOT / "scripts/cloudbench-forensic-retirement.py"))}
cloudbench_fsync_directory() {{ :; }}
fly_with_timeout() {{
    case "$2" in
        machines) cat {shlex.quote(str(machines_path))} ;;
        volumes) cat {shlex.quote(str(volumes_path))} ;;
        *) return 90 ;;
    esac
}}
fleet_recovery_confirm_forensic_retirement {shlex.quote(str(registry))}
"""
    )
    result = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=10, check=False)
    receipt_path = run / "_forensic/retirement-verified.json"
    if fault == "none":
        assert result.returncode == 0, result.stdout + result.stderr
        receipt = json.loads(receipt_path.read_text())
        assert receipt["proof_credit"] == 0 and receipt["tasks"] == 10
        assert receipt["incomplete_tasks"] == 0
        assert not latch.exists()
    else:
        assert result.returncode != 0, f"unsafe {fault} released this owner's latch"
        assert latch.exists() and not receipt_path.exists()


@pytest.mark.parametrize(
    "corrupt",
    [
        "none",
        "missing",
        "hash",
        "symlink",
        "extra-worker",
        "wrong-owner",
        "borrowed-sibling",
        "absent-seal",
        "absent-listed-file",
        "wmh-serve-log",
        "unknown-listed-file",
    ],
)
def test_primary_retention_rechecks_complete_capture(tmp_path: Path, corrupt: str) -> None:
    out = tmp_path / "task"
    root = primary_fixture(out)
    if corrupt in ("wmh-serve-log", "unknown-listed-file"):
        # A SIM guest seals its optional WMH serve log beside the stack files; the
        # controller collects it, so the fleet's final validator must accept it.
        name = "wmh-serve-log.txt" if corrupt == "wmh-serve-log" else "unexpected.txt"
        payload = b"wmh_step_committed prediction_ms=10\n"
        (root / name).write_bytes(payload)
        manifest = json.loads((root / "manifest.json").read_text())
        manifest["files"][name] = {"bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
        (root / "manifest.json").write_text(json.dumps(manifest))
    if corrupt == "absent-seal":
        # A guest stopped before collection never produced remote-logs at all.
        shutil.rmtree(out / "remote-logs")
    elif corrupt == "absent-listed-file":
        (root / "stack.log").unlink()
    elif corrupt == "missing":
        (root / "logs/worker.1.log").unlink()
    elif corrupt == "hash":
        (root / "logs/worker.1.log").write_text("mutated log\n")
    elif corrupt == "symlink":
        (root / "logs/worker.1.log").unlink()
        (root / "logs/worker.1.log").symlink_to(root / "logs/worker.log")
    elif corrupt == "extra-worker":
        (root / "logs/worker.2.log").write_text("unlisted worker\n")
    elif corrupt in ("wrong-owner", "borrowed-sibling"):
        owner = json.loads((out / "runtime-evidence.owner.json").read_text())
        owner["machine_id"] = "def456"
        (out / "runtime-evidence.owner.json").write_text(json.dumps(owner))
        if corrupt == "borrowed-sibling":
            manifest = json.loads((root / "manifest.json").read_text())
            manifest["machine_id"] = "def456"
            (root / "manifest.json").write_text(json.dumps(manifest))
    function = _extract_fleet_function(fleet_source_text(), "cloudbench_validate_primary_runtime_evidence() {")
    result = subprocess.run(
        ["bash", "-c", function + '\ncloudbench_validate_primary_runtime_evidence "$OUT" abc123 run-0'],
        env={**os.environ, "OUT": str(out)},
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert (result.returncode == 0) == (corrupt in ("none", "wmh-serve-log")), result.stderr
    if corrupt.startswith("absent-"):
        # The absence is reported as such, never as a raw resolver traceback.
        assert "Traceback" not in result.stderr and "FileNotFoundError" not in result.stderr, result.stderr
        assert "absent" in result.stderr, result.stderr


@pytest.mark.parametrize("failure", ["none", "pending", "missing-owner", "worker", "missing-worker-owner"])
def test_runtime_retention_latch_clears_only_after_all_owners(tmp_path: Path, failure: str) -> None:
    out = tmp_path / "task"
    primary_fixture(out)
    (out / "post-config-start.accepted").write_text("abc123\n")
    if failure == "pending":
        (out / "runtime-evidence.pending").write_text("{}")
    if failure == "missing-owner":
        (out / "runtime-evidence.owner.json").unlink()
    worker = out / "worker-runtime-evidence/def456"
    worker.mkdir(parents=True)
    (worker / "owner.json").write_text(
        json.dumps({"version": 1, "machine_id": "def456", "primary_machine_id": "abc123", "run_token": "run-0"})
    )
    if failure == "missing-worker-owner":
        (worker / "owner.json").unlink()
    registry = tmp_path / "registry"
    registry.mkdir()
    (registry / "fresh").mkdir()
    (registry / "fresh/worker").write_text("source_machine_id=abc123\nmachine_id=def456\n")
    marker = registry / "runtime-evidence-unconfirmed"
    marker.touch()
    functions = "\n".join(
        _extract_fleet_function(fleet_source_text(), name + "() {")
        for name in (
            "cloudbench_retain_runtime_evidence",
            "cloudbench_validate_primary_runtime_evidence",
            "cloudbench_validate_worker_evidence_coverage",
            "cloudbench_collect_remaining_runtime_evidence",
        )
    )
    result = subprocess.run(
        [
            "bash",
            "-c",
            functions
            + """
CHILD_OUT=("$OUT")
CHILD_MACHINE=(abc123)
FLEET_OWNER_TOKEN=run
cloudbench_fsync_directory() { :; }
cloudbench_capture_worker_runtime_evidence() {
    echo "$2" >> "$EVENTS"
    [ "$FAILURE" != worker ]
}
cloudbench_collect_remaining_runtime_evidence
""",
        ],
        env={
            **os.environ,
            "OUT": str(out),
            "EVENTS": str(tmp_path / "events"),
            "FLEET_REGISTRY_PUBLISHED": "1",
            "FLEET_REGISTRY_DIR": str(registry),
            "FLEET_TEARDOWN_OWNERSHIP_DIR": str(registry),
            "FAILURE": failure,
            "CLOUDBENCH_BOOT_LAUNCH": "1",
            "INFRA_PROBE": "0",
            "SKIP_AUTOSCALER": "0",
        },
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert (result.returncode == 0) == (failure == "none"), result.stderr
    assert marker.exists() == (failure != "none")
    if failure == "missing-worker-owner":
        assert not (tmp_path / "events").exists()
    else:
        assert (tmp_path / "events").read_text() == "def456\n"


def test_worker_evidence_owner_is_immutable_before_launch(tmp_path: Path) -> None:
    function = _extract_fleet_function(fleet_source_text(), "cloudbench_record_worker_evidence_owner() {")
    command = [
        "bash",
        "-c",
        function + '\ncloudbench_record_worker_evidence_owner "$OUT" def456 abc123 run-0 workspace',
    ]
    first = subprocess.run(
        command, env={**os.environ, "OUT": str(tmp_path)}, capture_output=True, text=True, timeout=10, check=False
    )
    assert first.returncode == 0, first.stderr
    path = tmp_path / "worker-runtime-evidence/def456/owner.json"
    original = path.read_bytes()
    assert json.loads(original) == {
        "version": 1,
        "run_token": "run-0",
        "machine_id": "def456",
        "primary_machine_id": "abc123",
        "workspace": "workspace",
    }
    again = subprocess.run(
        command, env={**os.environ, "OUT": str(tmp_path)}, capture_output=True, text=True, timeout=10, check=False
    )
    assert again.returncode != 0
    assert path.read_bytes() == original


@pytest.mark.parametrize("valid_copies", [True, False])
def test_exact_recovery_consumes_runtime_receipt_without_repeating_guest_shutdown(
    tmp_path: Path, valid_copies: bool
) -> None:
    token = "a" * 32
    registry = tmp_path / token
    registry.mkdir()
    audit = tmp_path / "audit" / token
    (audit / "pool").mkdir(parents=True)
    (audit / "fresh").mkdir()
    (audit / "meta").write_text(
        f"fleet_owner_token={token}\napp=app\nrun_id=original-run\n"
        f"workspace_root={tmp_path / 'removed-workspace'}\n"
    )
    (registry / "meta").write_text(
        f"version=2\napp=app\nfleet_owner_token={token}\nhost=host\ncleanup_policy=reap\naudit_dir={audit}\n"
    )
    (registry / "runtime-evidence-unconfirmed").touch()
    functions = "\n".join(
        _extract_fleet_function(fleet_source_text(), name + "() {")
        for name in (
            "registry_meta_value",
            "fleet_registry_cleanup_state",
            "exact_owner_pool_claim_ids",
            "fleet_recovery_confirm_pool_claims",
            "fleet_publish_recovered_terminal_projection",
            "release_registry_recovery_guard",
            "release_registry_recovery_lock",
            "fleet_close_recovered_source_consumer",
            "recover_exact_stale_fleet_owner",
        )
    )
    result = subprocess.run(
        [
            "bash",
            "-c",
            functions
            + """
registry_owner_alive() { return 1; }
release_cleanup_disk_reserve() { :; }
acquire_registry_recovery_lock() { :; }
fleet_recovery_reconnect_guest_shutdowns() { echo unexpected-guest-replay >> "$EVENTS"; return 1; }
fleet_recovery_confirm_runtime_evidence() {
    echo verify-evidence >> "$EVENTS"
    [ "$VALID_COPIES" = 1 ] || return 1
    rm "$1/runtime-evidence-unconfirmed"
}
recover_registry_audit_only_fresh() { :; }
reap_registry_clones() { echo destroy >> "$EVENTS"; }
recover_exact_pool_claims() { :; }
capacity_release_stale_owner_reservations() { :; }
fleet_audit_finalize_recovered_registry() {
    printf 'status=provider-teardown-verified\\n' >> "$FLEET_AUDIT_ROOT/$TOKEN/meta"
}
fleet_registry_remove_if_empty() {
    rm "$1/meta"
    rmdir "$1"
}
recover_exact_stale_fleet_owner "$TOKEN"
""",
        ],
        env={
            **os.environ,
            "FLEET_OWNERSHIP_ROOT": str(tmp_path),
            "FLEET_AUDIT_ROOT": str(tmp_path / "audit"),
            "FLEET_OWNER_HOST": "host",
            "APP": "app",
            "TOKEN": token,
            "EVENTS": str(tmp_path / "events"),
            "VALID_COPIES": str(int(valid_copies)),
        },
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert (tmp_path / "events").read_text().splitlines() == (
        ["verify-evidence", "destroy"] if valid_copies else ["verify-evidence"]
    ), result.stderr
    assert (result.returncode == 0) == valid_copies
    assert (registry / "runtime-evidence-unconfirmed").exists() != valid_copies


@pytest.mark.parametrize(
    "corrupt",
    [
        "none",
        "absent-pool",
        "preallocation",
        "preallocation-no-inputs",
        "preallocation-root-marker",
        "preallocation-nested-marker",
        "preallocation-dangling-link",
        "admitted-no-inputs",
        "linked-pool",
        "canonical-mismatch",
        "raw-log",
        "result-rejected",
        "omitted-task",
        "fsync-file",
        "fsync-directory",
    ],
)
def test_recovery_revalidates_exact_complete_copies_before_clearing_latch(tmp_path: Path, corrupt: str) -> None:
    token = "a" * 32
    registry = tmp_path / "registries" / token
    registry.mkdir(parents=True)
    (registry / "clones").mkdir()
    audit = tmp_path / "audits" / token
    (audit / "fresh").mkdir(parents=True)
    (audit / "expected-fresh").mkdir()
    (audit / "by-machine-id").mkdir()
    (audit / "pool").mkdir()
    (audit / "meta").write_text(f"fleet_owner_token={token}\n")
    (audit / "fresh/primary").write_text("source_machine_id=123456\nmachine_id=abc123\n")
    runs = tmp_path / "runs"
    run = runs / "run-a"
    (run / "_batch").mkdir(parents=True)
    (run / "_batch/benches.json").write_text('[{"name":"task","mode":"REAL"}]')
    contract = runpy.run_path(str(ROOT / "scripts/cloudbench_execution_provenance.py"))
    matrix = contract["build_task_matrix"](["task=real"])
    config = contract["build_config"](
        contract["CONFIG_SCHEMA_VERSION"], ["task_count=1", "task_matrix_sha256=" + matrix["sha256"]]
    )
    provenance = {
        "schema_version": contract["EXECUTION_SCHEMA_VERSION"],
        "base_sha": "a" * 40,
        "workspace_patch_sha256": "none",
        "controller_snapshot": {"schema_version": contract["SNAPSHOT_SCHEMA_VERSION"], "sha256": "b" * 64},
        "config": config,
    }
    (run / "execution-provenance.json").write_text(json.dumps(provenance))
    (run / "execution-task-matrix.json").write_text(json.dumps(matrix))
    out = run / "task"
    raw = primary_fixture(out, token + "-0")
    (out / ".cid").write_text("clone abc123\n")
    (out / "post-config-start.accepted").write_text("abc123\n")
    (out / "cloudbench-run.json").write_bytes((raw / "run.json").read_bytes())
    (out / "runtime-evidence.pending").write_bytes((out / "runtime-evidence.owner.json").read_bytes())
    if corrupt in {"absent-pool", "admitted-no-inputs", "linked-pool"} or corrupt.startswith("preallocation"):
        (audit / "pool").rmdir()
    if corrupt == "linked-pool":
        (audit / "pool").symlink_to(audit / "fresh", target_is_directory=True)
    if corrupt.startswith("preallocation"):
        import shutil

        shutil.rmtree(out)
        (audit / "fresh/primary").unlink()
    if corrupt not in {"preallocation"} and (corrupt.startswith("preallocation") or corrupt == "admitted-no-inputs"):
        (run / "execution-task-matrix.json").unlink()
        (run / "execution-provenance.json").unlink()
    if corrupt == "preallocation-root-marker":
        (run / ".cid").write_text("clone abc123\n")
    if corrupt == "preallocation-nested-marker":
        nested = run / "task/deeper"
        nested.mkdir(parents=True)
        (nested / ".cid").write_text("clone abc123\n")
    if corrupt == "preallocation-dangling-link":
        (run / "unrelated").symlink_to(run / "absent")
    (registry / "meta").write_text(f"fleet_owner_token={token}\naudit_dir={audit}\nruns_root={runs}\nrun_id=run-a\n")
    latch = registry / "runtime-evidence-unconfirmed"
    latch.touch()
    snapshot = tmp_path / "snapshot"
    snapshot.mkdir()
    (snapshot / "cloudbench_execution_provenance.py").write_bytes(
        (ROOT / "scripts/cloudbench_execution_provenance.py").read_bytes()
    )
    (snapshot / "cloudbench_result.py").write_text(
        "import sys\nsys.exit(" + ("1" if corrupt == "result-rejected" else "0") + ")\n"
    )
    if corrupt == "canonical-mismatch":
        (out / "cloudbench-run.json").write_text('{"different":true}')
    if corrupt == "raw-log":
        (raw / "logs/worker.log").write_text("mutated")
    if corrupt == "omitted-task":
        (run / "_batch/benches.json").write_text("[]")
    injection = tmp_path / "injection"
    injection.mkdir()
    if corrupt.startswith("fsync-"):
        mode = "S_ISREG" if corrupt == "fsync-file" else "S_ISDIR"
        (injection / "sitecustomize.py").write_text(
            "import os,stat\noriginal=os.fsync\n"
            "def injected(fd):\n"
            f" if stat.{mode}(os.fstat(fd).st_mode): raise OSError('injected evidence durability failure')\n"
            " return original(fd)\n"
            "os.fsync=injected\n"
        )
    functions = "\n".join(
        _extract_fleet_function(fleet_source_text(), name + "() {")
        for name in (
            "registry_meta_value",
            "cloudbench_retain_runtime_evidence",
            "cloudbench_validate_primary_runtime_evidence",
            "cloudbench_validate_worker_evidence_coverage",
            "cloudbench_collect_remaining_runtime_evidence",
            "fleet_recovery_confirm_runtime_evidence",
        )
    )
    result = subprocess.run(
        [
            "bash",
            "-c",
            functions
            + """
cloudbench_fsync_directory() { :; }
fleet_recovery_confirm_runtime_evidence "$REGISTRY"
""",
        ],
        env={
            **os.environ,
            "REGISTRY": str(registry),
            "FLEET_AUDIT_ROOT": str(audit.parent),
            "PYTHONPATH": str(injection),
            "CLOUDBENCH_SCRIPT_SNAPSHOT": str(snapshot),
            "INFRA_PROBE": "0",
            "SKIP_AUTOSCALER": "0",
        },
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    accepted = corrupt in {"none", "absent-pool", "preallocation", "preallocation-no-inputs"}
    assert (result.returncode == 0) == accepted, result.stderr
    assert latch.exists() == (not accepted)
    assert (out / "runtime-evidence.pending").exists() == (not accepted and not corrupt.startswith("preallocation"))


@pytest.mark.parametrize(
    "state", ["complete", "pending", "partial", "wrong-owner", "hash", "symlink", "capture-symlink", "fleet", "locked"]
)
def test_boot_admission_archives_only_verified_completed_standalone_runs(tmp_path: Path, state: str) -> None:
    """One namespace remains fenced until its exact previous capture is complete."""
    import fcntl

    cloud = (ROOT / "scripts/run-bench-cloud").read_text()
    start = cloud.index("# Markers the on-box per-run script prints")
    end = cloud.index("DONE_MARKER=", start)
    prepare = _extract_fleet_function(cloud, "cloudbench_prepare_runtime_evidence() {")
    script = (
        'set -eu\nMODE=run\nOUT_DIR="$1"\nCLOUDBENCH_BOOT_LAUNCH=1\n'
        "FLEET_MACHINE_ID=abc123\n"
        "cloudbench_skip_held_driver_teardown_race() { return 1; }\n"
        + cloud[start:end]
        + "\n"
        + prepare
        + '\ncloudbench_prepare_runtime_evidence\nprintf "%s\\n" "$OUT_DIR"\n'
    )
    output = tmp_path / "output"
    output.mkdir()
    env = {**os.environ, "CLOUDBENCH_FLEET_RUN_TOKEN": "fleet-one" if state == "fleet" else ""}

    def admit():
        return subprocess.run(
            ["bash", "-c", script, "admission", str(output)], env=env, text=True, capture_output=True, timeout=5
        )

    first = admit()
    assert first.returncode == 0, first.stderr
    first_dir = Path(first.stdout.strip())
    owner_file = first_dir / "runtime-evidence.owner.json"
    original_owner = owner_file.read_bytes()
    token = json.loads(original_owner)["run_token"]
    capture = primary_fixture(first_dir, token)
    owner_file.write_bytes(original_owner)
    if state != "pending":
        (first_dir / "runtime-evidence.pending").unlink()
    if state == "partial":
        (capture / "manifest.json").unlink()
    elif state == "wrong-owner":
        path = capture / "manifest.json"
        manifest = json.loads(path.read_text())
        manifest["machine_id"] = "def456"
        path.write_text(json.dumps(manifest))
    elif state == "hash":
        (capture / "logs/backend.log").write_text("changed")
    elif state == "symlink":
        owner_file.rename(first_dir / "original-owner")
        owner_file.symlink_to(first_dir / "original-owner")
    elif state == "capture-symlink":
        target = tmp_path / "outside"
        target.mkdir()
        (capture / "unlisted").symlink_to(target, target_is_directory=True)
    before = {str(p.relative_to(first_dir)): p.read_bytes() for p in first_dir.rglob("*") if p.is_file()}
    with (output / ".runtime-evidence-admission.lock").open("a") as lock:
        if state == "locked":
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        second = admit()
    if state != "complete":
        assert second.returncode != 0, f"unresolved {state} ownership admitted another run"
        assert all((first_dir / name).read_bytes() == data for name, data in before.items())
        return
    assert second.returncode == 0, second.stderr
    assert Path(second.stdout.strip()) == first_dir == output
    archived = output / "runtime-evidence-history" / token
    assert (archived / "runtime-evidence.owner.json").read_bytes() == original_owner
    for name, data in before.items():
        if name.startswith("remote-logs/runtime-evidence/"):
            assert (archived / name.removeprefix("remote-logs/")).read_bytes() == data
    new_owner = owner_file.read_bytes()
    assert json.loads(new_owner)["run_token"] != token
    assert (output / "runtime-evidence.pending").read_bytes() == new_owner
    assert not capture.exists()


@pytest.mark.parametrize(
    "case",
    [
        "wmh-serve-log",
        "guest-diagnostics",
        "seal-transition",
        "manifest-url",
        "manifest-timeout",
        "socket-reset",
        "socket-disconnect",
        "file-stall",
        "file-truncate",
        "file-corrupt",
        "shutdown-url",
        "driver-timeout",
        "ack-url",
        "persistent-timeout",
        "deadline-during-read",
        "http-rejection",
        "terminal-failures",
    ],
)
def test_runtime_collector_rechecks_terminal_seal_and_bounds_transport_reads(case: str) -> None:
    fixture = runpy.run_path(str(ROOT / "scripts/tests/cloudbench-runtime-evidence-collector.test.py"))
    fixture["exercise_read_transition"](case)


def test_forensic_running_stack_requires_exact_provider_cleanup() -> None:
    result = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/tests/cloudbench-prestack-recovery.test.py"),
            "FailedStackRecoveryTest.test_started_stale_running_requires_complete_exact_provider_cleanup",
            "FailedStackRecoveryTest.test_interrupted_running_driver_requires_complete_exact_provider_cleanup",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize("fleet", [False, True])
def test_boot_timeout_unconfirmed_shutdown_skips_normal_capture(tmp_path: Path, fleet: bool) -> None:
    """Actual 409/alive status traffic must not admit the ordinary 7200s capture phase."""
    import signal
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    cloud = Path(os.environ.get("CLOUDBENCH_CODEX_AUTH_TEST_CLOUD", str(ROOT / "scripts/run-bench-cloud"))).read_text()
    collector = _extract_fleet_function(cloud, "cloudbench_collect_runtime_evidence() {")
    retirement = _extract_fleet_function(cloud, "stop_on_exit() {")
    begin = cloud.index("# Preserve the complete remote driver")
    end = cloud.index('if [ "${CLOUDBENCH_BOOT_LAUNCH:-0}" != "1" ]; then', begin)
    collection = cloud[begin:end]
    out = tmp_path / "out"
    out.mkdir()
    owner = {"version": 1, "run_token": "fixture-run", "machine_id": "abcdef12345678"}
    for name in ["runtime-evidence.pending", "runtime-evidence.owner.json"]:
        (out / name).write_text(json.dumps(owner))
    (tmp_path / "driver.log").write_text("fixture driver alive\n")
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            requests.append(self.path)
            self.send_response(200 if self.path == "/driver-health" else 409)
            self.send_header("Content-Length", "0")
            self.end_headers()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    budget = tmp_path / "capture-budgets"
    retained = tmp_path / "retired-controller"
    script = "set -eu\n" + collector.replace(
        "cloudbench_collect_runtime_evidence()", "actual_cloudbench_collect_runtime_evidence()", 1
    ) + retirement
    script += f"""
OUT_DIR={shlex.quote(str(out))}
SSH_LOG={shlex.quote(str(tmp_path / 'driver.log'))}
RUN_LOG_TOKEN=fixture-run
mid=abcdef12345678
FLEET_MACHINE_ID={'abcdef12345678' if fleet else "''"}
LOCAL_STATUS_PORT={server.server_port}
CLOUDBENCH_BARRIER_TOKEN=fixture-only-token
export CLOUDBENCH_BARRIER_TOKEN
CLOUDBENCH_BOOT_LAUNCH=1
CLOUDBENCH_CHILD_TERM_SECONDS=30
TIMED_OUT=1
STOP_DONE=0
LOCK_ACQUIRED=0
cloudbench_skip_held_driver_teardown_race() {{ return 1; }}
confirm_guest_shutdown() {{ [ -z "$FLEET_MACHINE_ID" ]; }}
cloudbench_collect_runtime_evidence() {{
  printf '%s\\n' "$5" >> {shlex.quote(str(budget))}
  # A retirement transfer failure stays fail-closed. Only the normal phase
  # exercises the live, unsealed status server in this admission fixture.
  [ "$5" -gt 30 ] || return 1
  actual_cloudbench_collect_runtime_evidence "$@"
}}
release_boot_config_update_slot() {{ :; }}
stop_proxy() {{ printf retired > {shlex.quote(str(retained))}; }}
release_local_port_leases() {{ :; }}
stop_live_archive_frontend() {{ :; }}
stop_all_local_viewers() {{ :; }}
stop_machine() {{ echo 'pending runtime owner must not be stopped' >&2; exit 99; }}
trap stop_on_exit EXIT
{collection}
"""
    process = subprocess.Popen(
        ["bash", "-c", script], env={**os.environ, "PYTHONUNBUFFERED": "1"},
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True,
    )
    timed_out = False
    try:
        try:
            stdout, stderr = process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGTERM)
            stdout, stderr = process.communicate(timeout=10)
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        server.shutdown()
        server.server_close()
        thread.join(timeout=10)
    assert not timed_out, "unconfirmed boot timeout entered ordinary runtime collection"
    assert process.returncode == (125 if fleet else 70), (process.returncode, stdout, stderr)
    assert retained.is_file(), "existing bounded EXIT retirement did not run"
    assert not requests, "normal capture read the still-live unsealed driver"
    budgets = [int(value) for value in budget.read_text().splitlines()] if budget.exists() else []
    assert all(0 < value <= 28 for value in budgets)
    assert len(budgets) == (0 if fleet else 1)
    assert (out / "runtime-evidence.pending").is_file()
    assert (out / "runtime-evidence.owner.json").is_file()
    assert not (out / "remote-logs/runtime-evidence").exists()


@pytest.mark.parametrize(
    "case", ["probe", "autoscaler-log", "autoscaler-pid", "workers", "owner-only", "no-ack", "foreign-ack", "worker-evidence"]
)
def test_recovery_admits_infra_probe_outputs_that_never_own_runtime_evidence(tmp_path: Path, case: str) -> None:
    """A SIGKILLed --infra-probe fleet (owner 0e592393) has admitted guests but, by design, no runtime evidence."""
    token = "b" * 32
    registry = tmp_path / "registries" / token
    (registry / "clones").mkdir(parents=True)
    audit = tmp_path / "audits" / token
    for name in ("fresh", "expected-fresh", "by-machine-id", "pool"):
        (audit / name).mkdir(parents=True)
    (audit / "meta").write_text(f"fleet_owner_token={token}\n")
    runs = tmp_path / "runs"
    run = runs / "run-p"
    (run / "_batch").mkdir(parents=True)
    names = ["probe-a", "probe-b"]
    (run / "_batch/benches.json").write_text(json.dumps([{"name": n, "mode": "REAL"} for n in names]))
    contract = runpy.run_path(str(ROOT / "scripts/cloudbench_execution_provenance.py"))
    matrix = contract["build_task_matrix"]([f"{n}=real" for n in names])
    config = contract["build_config"](
        contract["CONFIG_SCHEMA_VERSION"], ["task_count=2", "task_matrix_sha256=" + matrix["sha256"]]
    )
    (run / "execution-provenance.json").write_text(json.dumps({
        "schema_version": contract["EXECUTION_SCHEMA_VERSION"], "base_sha": "a" * 40,
        "workspace_patch_sha256": "none",
        "controller_snapshot": {"schema_version": contract["SNAPSHOT_SCHEMA_VERSION"], "sha256": "b" * 64},
        "config": config,
    }))
    (run / "execution-task-matrix.json").write_text(json.dumps(matrix))
    for index, name in enumerate(names):
        machine = f"abc12{index}"
        (audit / f"fresh/clone-{index}").write_text(f"source_machine_id=123456\nmachine_id={machine}\n")
        out = run / name
        out.mkdir()
        (out / ".cid").write_text(f"clone {machine}\n")
        (out / "post-config-start.accepted").write_text(machine + "\n")
        (out / "autoscaler.ready").write_bytes(b"")
        (out / "autoscaler.completed-after-child").write_bytes(b"")
        (out / "desired-worker-count").write_text("0\n")
        (out / "guest-shutdown.confirmed").write_text("run-p\n")
    out = run / names[1]
    if case == "autoscaler-log":
        (out / "autoscaler.log").write_text("autoscaler started\n")
    elif case == "autoscaler-pid":
        (out / "autoscaler.pid").write_text("123 start\n")
    elif case == "workers":
        (out / "desired-worker-count").write_text("1\n")
    elif case == "owner-only":
        (out / "runtime-evidence.owner.json").write_text(json.dumps({"version": 1, "machine_id": "abc121", "run_token": token + "-1"}))
    elif case == "no-ack":
        (out / "guest-shutdown.confirmed").unlink()
    elif case == "foreign-ack":
        (out / "guest-shutdown.confirmed").write_text("run-other\n")
    elif case == "worker-evidence":
        (out / "worker-runtime-evidence/w1").mkdir(parents=True)
    (registry / "meta").write_text(f"fleet_owner_token={token}\naudit_dir={audit}\nruns_root={runs}\nrun_id=run-p\n")
    latch = registry / "runtime-evidence-unconfirmed"
    latch.touch()
    snapshot = tmp_path / "snapshot"
    snapshot.mkdir()
    (snapshot / "cloudbench_execution_provenance.py").write_bytes(
        (ROOT / "scripts/cloudbench_execution_provenance.py").read_bytes()
    )
    (snapshot / "cloudbench_result.py").write_text("import sys\nsys.exit(0)\n")
    functions = "\n".join(
        _extract_fleet_function(fleet_source_text(), name + "() {")
        for name in (
            "registry_meta_value",
            "cloudbench_retain_runtime_evidence",
            "cloudbench_validate_primary_runtime_evidence",
            "cloudbench_validate_worker_evidence_coverage",
            "cloudbench_collect_remaining_runtime_evidence",
            "fleet_recovery_confirm_runtime_evidence",
        )
    )
    result = subprocess.run(
        ["bash", "-c", functions + '\ncloudbench_fsync_directory() { :; }\nfleet_recovery_confirm_runtime_evidence "$REGISTRY"\n'],
        env={**os.environ, "REGISTRY": str(registry), "FLEET_AUDIT_ROOT": str(audit.parent),
             "CLOUDBENCH_SCRIPT_SNAPSHOT": str(snapshot), "INFRA_PROBE": "0", "SKIP_AUTOSCALER": "0"},
        capture_output=True, text=True, timeout=10, check=False,
    )
    accepted = case == "probe"
    assert (result.returncode == 0) == accepted, result.stderr
    assert latch.exists() == (not accepted)
