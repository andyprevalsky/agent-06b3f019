"""Runtime evidence must survive provider cleanup until its copy is verified."""

import hashlib
import json
import os
import runpy
import subprocess
from pathlib import Path

import pytest

from benchmarks.cloudbench_dependency_sync_test import _extract_fleet_function

ROOT = Path(__file__).resolve().parents[2]
FLEET = Path(os.environ.get("CLOUDBENCH_FLEET_SCRIPT_UNDER_TEST", ROOT / "scripts/run-bench-fleet"))


@pytest.mark.parametrize("mode", ["current", "stale", "forced"])
def test_runtime_pending_registry_cannot_be_reaped(tmp_path: Path, mode: str) -> None:
    registry = tmp_path / "owners" / "fleet-a"
    (registry / "clones").mkdir(parents=True)
    (registry / "runtime-evidence-unconfirmed").write_text("abc123\n")
    (registry / "meta").write_text("version=2\n")
    (registry / "clones" / "clone-a").write_text("name=clone-a\nid=abc123\nvolume_id=vol_a\n")
    mutations = tmp_path / "mutations"
    function = _extract_fleet_function(FLEET.read_text(), "reap_registry_clones() {")
    result = subprocess.run(
        ["bash", "-c", function + '''
registry_meta_value() { sed -n "s/^$2=//p" "$1"; }
registry_machine_details() { echo 'stopped clone-a'; }
fleet_registry_reconcile_mounted_volume() { echo vol_a; }
reap_machine() { echo destroy >> "$MUTATIONS"; }
reap_volume() { echo volume >> "$MUTATIONS"; }
fleet_audit_update_registry_clone() { :; }
reap_registry_clones "$REGISTRY" "$MODE"
'''],
        env={**os.environ, "FLEET_OWNERSHIP_ROOT": str(registry.parent), "REGISTRY": str(registry),
             "MODE": mode, "MUTATIONS": str(mutations)},
        capture_output=True, text=True, timeout=10, check=False,
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
    function = _extract_fleet_function(FLEET.read_text(), "cleanup_failed_worker() {")
    result = subprocess.run(
        ["bash", "-c", function + '''
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
'''],
        env={**os.environ, "OUT": str(out), "EVENTS": str(tmp_path / "events"),
             "CAPTURE_OK": str(int(capture_ok))},
        capture_output=True, text=True, timeout=10, check=False,
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
        "run.json": '{"tasks": []}', "stack.log": "stack log\n",
        f"cloudbench-stack-cleanup-{token}.status": f"state=clean\ntoken={token}\n",
        "logs/backend.log": "backend log\n", "logs/worker.log": "worker zero\n",
        "logs/worker.1.log": "worker one\n",
    }
    manifest = {**owner, "files": {}}
    for name, value in files.items():
        payload = value.encode()
        (root / name).write_bytes(payload)
        manifest["files"][name] = {"bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
    (root / "manifest.json").write_text(json.dumps(manifest))
    return root


@pytest.mark.parametrize("corrupt", ["none", "missing", "hash", "symlink", "extra-worker", "wrong-owner", "borrowed-sibling"])
def test_primary_retention_rechecks_complete_capture(tmp_path: Path, corrupt: str) -> None:
    out = tmp_path / "task"
    root = primary_fixture(out)
    if corrupt == "missing":
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
    function = _extract_fleet_function(FLEET.read_text(), "cloudbench_validate_primary_runtime_evidence() {")
    result = subprocess.run(["bash", "-c", function + '\ncloudbench_validate_primary_runtime_evidence "$OUT" abc123 run-0'],
                            env={**os.environ, "OUT": str(out)}, capture_output=True, text=True,
                            timeout=10, check=False)
    assert (result.returncode == 0) == (corrupt == "none"), result.stderr


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
    (worker / "owner.json").write_text(json.dumps({"version": 1, "machine_id": "def456", "primary_machine_id": "abc123", "run_token": "run-0"}))
    if failure == "missing-worker-owner":
        (worker / "owner.json").unlink()
    registry = tmp_path / "registry"
    registry.mkdir()
    (registry / "fresh").mkdir()
    (registry / "fresh/worker").write_text("source_machine_id=abc123\nmachine_id=def456\n")
    marker = registry / "runtime-evidence-unconfirmed"
    marker.touch()
    functions = "\n".join(_extract_fleet_function(FLEET.read_text(), name + "() {") for name in (
        "cloudbench_retain_runtime_evidence", "cloudbench_validate_primary_runtime_evidence",
        "cloudbench_validate_worker_evidence_coverage", "cloudbench_collect_remaining_runtime_evidence"))
    result = subprocess.run(["bash", "-c", functions + '''
CHILD_OUT=("$OUT")
CHILD_MACHINE=(abc123)
FLEET_OWNER_TOKEN=run
cloudbench_fsync_directory() { :; }
cloudbench_capture_worker_runtime_evidence() {
    echo "$2" >> "$EVENTS"
    [ "$FAILURE" != worker ]
}
cloudbench_collect_remaining_runtime_evidence
'''], env={**os.environ, "OUT": str(out), "EVENTS": str(tmp_path / "events"),
           "FLEET_REGISTRY_PUBLISHED": "1", "FLEET_REGISTRY_DIR": str(registry), "FLEET_TEARDOWN_OWNERSHIP_DIR": str(registry),
           "FAILURE": failure, "CLOUDBENCH_BOOT_LAUNCH": "1", "INFRA_PROBE": "0", "SKIP_AUTOSCALER": "0"},
        capture_output=True, text=True, timeout=10, check=False)
    assert (result.returncode == 0) == (failure == "none"), result.stderr
    assert marker.exists() == (failure != "none")
    if failure == "missing-worker-owner":
        assert not (tmp_path / "events").exists()
    else:
        assert (tmp_path / "events").read_text() == "def456\n"


def test_worker_evidence_owner_is_immutable_before_launch(tmp_path: Path) -> None:
    function = _extract_fleet_function(FLEET.read_text(), "cloudbench_record_worker_evidence_owner() {")
    command = ["bash", "-c", function + '\ncloudbench_record_worker_evidence_owner "$OUT" def456 abc123 run-0 workspace']
    first = subprocess.run(command, env={**os.environ, "OUT": str(tmp_path)},
                           capture_output=True, text=True, timeout=10, check=False)
    assert first.returncode == 0, first.stderr
    path = tmp_path / "worker-runtime-evidence/def456/owner.json"
    original = path.read_bytes()
    assert json.loads(original) == {"version": 1, "run_token": "run-0", "machine_id": "def456",
                                   "primary_machine_id": "abc123", "workspace": "workspace"}
    again = subprocess.run(command, env={**os.environ, "OUT": str(tmp_path)},
                           capture_output=True, text=True, timeout=10, check=False)
    assert again.returncode != 0
    assert path.read_bytes() == original


@pytest.mark.parametrize("valid_copies", [True, False])
def test_exact_recovery_consumes_runtime_receipt_without_repeating_guest_shutdown(tmp_path: Path, valid_copies: bool) -> None:
    token = "a" * 32
    registry = tmp_path / token
    registry.mkdir()
    (registry / "meta").write_text(f"version=2\napp=app\nfleet_owner_token={token}\nhost=host\ncleanup_policy=reap\n")
    (registry / "runtime-evidence-unconfirmed").touch()
    functions = "\n".join(_extract_fleet_function(FLEET.read_text(), name + "() {") for name in (
        "registry_meta_value", "fleet_registry_cleanup_state", "recover_exact_stale_fleet_owner"))
    result = subprocess.run(["bash", "-c", functions + '''
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
fleet_audit_finalize_recovered_registry() { :; }
fleet_registry_remove_if_empty() { :; }
recover_exact_stale_fleet_owner "$TOKEN"
'''], env={**os.environ, "FLEET_OWNERSHIP_ROOT": str(tmp_path), "FLEET_AUDIT_ROOT": str(tmp_path / "audit"),
           "FLEET_OWNER_HOST": "host", "APP": "app", "TOKEN": token,
           "EVENTS": str(tmp_path / "events"), "VALID_COPIES": str(int(valid_copies))},
        capture_output=True, text=True, timeout=10, check=False)
    assert (tmp_path / "events").read_text().splitlines() == (["verify-evidence", "destroy"] if valid_copies else ["verify-evidence"])
    assert (result.returncode == 0) == valid_copies
    assert (registry / "runtime-evidence-unconfirmed").exists() != valid_copies


@pytest.mark.parametrize("corrupt", ["none", "canonical-mismatch", "raw-log", "result-rejected", "omitted-task", "fsync-file", "fsync-directory"])
def test_recovery_revalidates_exact_complete_copies_before_clearing_latch(tmp_path: Path, corrupt: str) -> None:
    token = "a" * 32
    registry = tmp_path / "registries" / token
    registry.mkdir(parents=True)
    audit = tmp_path / "audits" / token
    (audit / "fresh").mkdir(parents=True)
    (audit / "meta").write_text(f"fleet_owner_token={token}\n")
    (audit / "fresh/primary").write_text("source_machine_id=123456\nmachine_id=abc123\n")
    runs = tmp_path / "runs"
    run = runs / "run-a"
    (run / "_batch").mkdir(parents=True)
    (run / "_batch/benches.json").write_text('[{"name":"task","mode":"REAL"}]')
    contract = runpy.run_path(str(ROOT / "scripts/cloudbench_execution_provenance.py"))
    matrix = contract["build_task_matrix"](["task=real"])
    config = contract["build_config"](contract["CONFIG_SCHEMA_VERSION"], ["task_count=1", "task_matrix_sha256=" + matrix["sha256"]])
    provenance = {"schema_version": contract["EXECUTION_SCHEMA_VERSION"], "base_sha": "a" * 40,
                  "workspace_patch_sha256": "none", "controller_snapshot": {"schema_version": contract["SNAPSHOT_SCHEMA_VERSION"], "sha256": "b" * 64},
                  "config": config}
    (run / "execution-provenance.json").write_text(json.dumps(provenance))
    (run / "execution-task-matrix.json").write_text(json.dumps(matrix))
    out = run / "task"
    raw = primary_fixture(out, token + "-0")
    (out / ".cid").write_text("fresh abc123\n")
    (out / "post-config-start.accepted").write_text("abc123\n")
    (out / "cloudbench-run.json").write_bytes((raw / "run.json").read_bytes())
    (out / "runtime-evidence.pending").write_bytes((out / "runtime-evidence.owner.json").read_bytes())
    (registry / "meta").write_text(f"fleet_owner_token={token}\naudit_dir={audit}\nruns_root={runs}\nrun_id=run-a\n")
    latch = registry / "runtime-evidence-unconfirmed"
    latch.touch()
    snapshot = tmp_path / "snapshot"
    snapshot.mkdir()
    (snapshot / "cloudbench_execution_provenance.py").write_bytes((ROOT / "scripts/cloudbench_execution_provenance.py").read_bytes())
    (snapshot / "cloudbench_result.py").write_text("import sys\nsys.exit(" + ("1" if corrupt == "result-rejected" else "0") + ")\n")
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
    functions = "\n".join(_extract_fleet_function(FLEET.read_text(), name + "() {") for name in (
        "registry_meta_value", "cloudbench_retain_runtime_evidence", "cloudbench_validate_primary_runtime_evidence",
        "cloudbench_validate_worker_evidence_coverage", "cloudbench_collect_remaining_runtime_evidence",
        "fleet_recovery_confirm_runtime_evidence"))
    result = subprocess.run(["bash", "-c", functions + '''
cloudbench_fsync_directory() { :; }
fleet_recovery_confirm_runtime_evidence "$REGISTRY"
'''], env={**os.environ, "REGISTRY": str(registry), "FLEET_AUDIT_ROOT": str(audit.parent),
           "PYTHONPATH": str(injection),
           "CLOUDBENCH_SCRIPT_SNAPSHOT": str(snapshot), "INFRA_PROBE": "0", "SKIP_AUTOSCALER": "0"},
        capture_output=True, text=True, timeout=10, check=False)
    assert (result.returncode == 0) == (corrupt == "none"), result.stderr
    assert latch.exists() == (corrupt != "none")
    assert (out / "runtime-evidence.pending").exists() == (corrupt != "none")
