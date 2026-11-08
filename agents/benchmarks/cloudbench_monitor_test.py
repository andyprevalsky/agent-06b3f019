"""Read-only operator observations must distinguish results from retirement."""

import json
import os
import subprocess
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def observe(directory: Path, *args: str) -> dict:
    result = subprocess.run(
        ["bash", str(ROOT / "scripts/run-bench"), "monitor", str(directory), *args],
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def write(directory: Path, name: str, value: dict) -> Path:
    target = directory / "_batch" / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(value))
    return target


def test_fleet_monitor_terminal_task_is_not_controller_completion(tmp_path: Path):
    write(
        tmp_path,
        "report-card.json",
        {
            "per_task": [
                {"name": "task-a", "status": "failed", "lifecycle_stage": "evaluated"},
                {"name": "task-b", "status": "running", "lifecycle_stage": "running"},
            ],
            "private_request_body": "MUST_NOT_PRINT",
        },
    )
    write(tmp_path, "run.json", {"tasks": [{"name": "task-a", "status": "FAILED"}]})
    result = observe(tmp_path)
    assert result["controller_terminal"] is False
    assert result["occupancy"]["evaluation/evidence"] == 1
    assert result["occupancy"]["running"] == 1
    assert result["task_outcomes"] == {"failed": 1, "running": 1}
    assert "MUST_NOT_PRINT" not in json.dumps(result)


@pytest.mark.parametrize("child_exit", [0, 1, 125, 143])
@pytest.mark.parametrize("invalid_rows", [False, True])
def test_fleet_monitor_surfaces_abnormal_child_exit_without_rejecting_outcomes(
    tmp_path: Path, child_exit: int, invalid_rows: bool
):
    write(
        tmp_path,
        "report-card.json",
        {"per_task": [
            {"name": "task-a", "status": "failed", "lifecycle_stage": "teardown"},
            {"name": "task-b", "status": "running", "lifecycle_stage": "running"},
        ] + ([None] if invalid_rows else [])},
    )
    task = tmp_path / "task-a"
    task.mkdir()
    (task / "benchmark-child.finished").write_text(f"{child_exit}\n")
    result = observe(tmp_path)
    warnings = result.get("task_controller_warnings", [])
    assert result["next_action"] == ("inspect_task_warnings_and_continue" if child_exit > 1 and not invalid_rows else "observe_again")
    if invalid_rows:
        assert result["observation_warning"] == "invalid task rows; inspect this exact owner"
    assert warnings == ([{"task": "task-a", "exit_code": child_exit}] if child_exit > 1 else [])
    assert result["controller_terminal"] is False
    assert result["task_outcomes"] == {"failed": 1, "running": 1}
    assert result["occupancy"]["teardown"] == result["occupancy"]["running"] == 1
    assert result["occupancy"]["rejected"] == 0


def test_fleet_monitor_checks_terminal_receipt_even_when_card_is_stale(tmp_path: Path):
    card = write(
        tmp_path,
        "report-card.json",
        {
            "per_task": [
                {"name": "task-a", "status": "failed", "lifecycle_stage": "running"},
            ]
        },
    )
    os.utime(card, (1, 1))
    task = tmp_path / "task-a"
    task.mkdir()
    (task / "bench-e2e.finished-epoch").write_text("2\n")
    write(
        tmp_path,
        "lifecycle.json",
        {
            "version": 1,
            "run_id": tmp_path.name,
            "status": "verified",
            "controller_exit_code": 1,
        },
    )
    pending = observe(tmp_path)
    assert pending["controller_terminal"] is False
    assert pending["lifecycle_terminal"] is True
    assert pending["next_action"] == "inspect_terminal_and_owned_resources"
    status = tmp_path / "detached.status"
    status.write_text("1\n")
    result = observe(tmp_path, "--controller-status", str(status))
    assert result["controller_terminal"] is True
    assert result["cleanup_status"] == "verified"
    assert result["controller_exit_code"] == 1
    assert result["occupancy"]["finished"] == 1
    assert result["card_age_s"] > 60


def test_fleet_monitor_missing_observation_never_authorizes_restart(tmp_path: Path):
    write(tmp_path, "benches.json", [{"name": "task-a"}, {"name": "task-b"}])
    result = observe(tmp_path)
    assert result["controller_terminal"] is False
    assert result["occupancy"]["preflight"] == 2
    assert result["observation_warning"]
    assert result["next_action"] == "observe_again"


def test_fleet_monitor_rejects_foreign_terminal_receipt(tmp_path: Path):
    write(tmp_path, "lifecycle.json", {"run_id": "another-run", "status": "verified"})
    result = observe(tmp_path)
    assert result["controller_terminal"] is False
    assert result["cleanup_status"] == "unknown"


def test_fleet_monitor_handles_malformed_rows_and_nonterminal_receipt(tmp_path: Path):
    write(tmp_path, "report-card.json", {"per_task": {"unexpected": "shape"}})
    write(tmp_path, "benches.json", [{"name": "task-a", "status": {"private": "MUST_NOT_PRINT"}}])
    write(tmp_path, "lifecycle.json", {"run_id": tmp_path.name, "status": "in_progress"})
    result = observe(tmp_path)
    assert result["occupancy"]["preflight"] == 1
    assert result["task_outcomes"] == {"queued": 1}
    assert result["observation_warning"]
    assert result["lifecycle_terminal"] is False
    assert result["cleanup_status"] == "unknown"
    assert "MUST_NOT_PRINT" not in json.dumps(result)

    write(tmp_path, "benches.json", {"unexpected": "shape"})
    result = observe(tmp_path)
    assert sum(result["occupancy"].values()) == 0
    assert result["observation_warning"]


def test_fleet_monitor_preserves_caller_relative_paths(tmp_path: Path):
    directory = tmp_path / "run"
    write(
        directory,
        "report-card.json",
        {
            "per_task": [
                {"name": "task-a", "status": "running", "lifecycle_stage": "running"},
            ]
        },
    )
    (tmp_path / "exit.status").write_text("0\n")
    result = subprocess.run(
        ["bash", str(ROOT / "scripts/run-bench"), "monitor", "run", "--controller-status", "exit.status"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode == 0, result.stderr
    value = json.loads(result.stdout)
    assert value["occupancy"]["running"] == 1
    assert value["controller_exit_code"] == 0


@pytest.mark.parametrize("wait", [False, True], ids=["detach", "wait"])
def test_fleet_monitor_detached_launch_retains_actual_controller_exit(
    tmp_path: Path, wait: bool
):
    runs = tmp_path / "runs"
    snapshots = tmp_path / "snapshots"
    runs.mkdir()
    snapshots.mkdir()
    env = {
        **os.environ,
        "CLOUDBENCH_RUNS_ROOT": str(runs),
        "CLOUDBENCH_SCRIPT_SNAPSHOT": "",
        "CLOUDBENCH_SKIP_LOCAL_PATCH": "1",
        "CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_EXIT_AFTER_CLAIM": "7",
        "TMPDIR": str(snapshots),
    }
    result = subprocess.run(
        [
            "bash",
            str(ROOT / "scripts/run-bench"),
            "spawn-sub-agents",
            "--ref",
            "origin/main",
            *(["--wait"] if wait else []),
        ],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == (7 if wait else 0), result.stdout + result.stderr
    deadline = time.monotonic() + 10
    statuses = []
    while time.monotonic() < deadline:
        statuses = list(runs.glob("detached-*.status"))
        if statuses:
            break
        time.sleep(0.05)
    assert len(statuses) == 1, "detached launch lost its actual exit status"
    assert statuses[0].read_text().strip() == "7"
    assert "monitor every 30s" in result.stdout
    terminal = observe(runs / "not-allocated", "--controller-status", str(statuses[0]))
    assert terminal["controller_exit_code"] == 7
    assert terminal["controller_terminal"] is True
    assert terminal["cleanup_status"] == "unknown"
    if wait:
        assert not list(runs.glob("detached-*.owner")), "waiter retained its live ownership rendezvous"


def test_fleet_monitor_snapshot_already_removed_is_a_clean_exit(tmp_path: Path):
    """The snapshot's new owner removes it on exit; nothing is left to clean up.

    Under load that removal landed between the cleanup's existence check and
    its helper (which lives inside the snapshot) starting, and the launch
    failed with "could not remove the exact owned script snapshot". The test
    hook removes the snapshot at exactly that point.
    """
    runs = tmp_path / "runs"
    snapshots = tmp_path / "snapshots"
    runs.mkdir()
    snapshots.mkdir()
    env = {
        **os.environ,
        "CLOUDBENCH_RUNS_ROOT": str(runs),
        "CLOUDBENCH_SCRIPT_SNAPSHOT": "",
        "CLOUDBENCH_SKIP_LOCAL_PATCH": "1",
        "CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_EXIT_AFTER_CLAIM": "7",
        "CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_VANISH_BEFORE_CLEANUP": "1",
        "TMPDIR": str(snapshots),
    }
    result = subprocess.run(
        ["bash", str(ROOT / "scripts/run-bench"), "spawn-sub-agents", "--ref", "origin/main"],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    deadline = time.monotonic() + 10
    statuses = []
    while time.monotonic() < deadline:
        statuses = list(runs.glob("detached-*.status"))
        if statuses:
            break
        time.sleep(0.05)
    assert len(statuses) == 1, "detached launch lost its actual exit status"
    assert statuses[0].read_text().strip() == "7"
    assert not list(snapshots.glob("cloudbench-scripts.*")), "the snapshot was left behind"


def test_script_snapshot_removal_never_exposes_a_partly_deleted_snapshot(tmp_path, monkeypatch):
    """RCA 2026-11-07: rmtree unlinked the helper before the directory, so the
    launcher's EXIT cleanup ran the helper from a snapshot that still existed
    without it ("can't open file .../cloudbench-script-snapshot.py", then
    "FATAL: could not remove the exact owned script snapshot"), failing
    test_fleet_monitor_detached_launch_retains_actual_controller_exit on
    Blacksmith runners. Deletion must start only after the path is gone."""
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "cloudbench_script_snapshot_under_test", ROOT / "scripts/cloudbench-script-snapshot.py"
    )
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    snapshot = tmp_path / "cloudbench-scripts.0123456789abcdef0123456789abcdef"
    snapshot.mkdir()
    (snapshot / "cloudbench-script-snapshot.py").write_text("# helper\n")
    observed = []
    real_rmtree = helper.shutil.rmtree

    def recording_rmtree(target, *args, **kwargs):
        observed.append((Path(target), snapshot.exists()))
        return real_rmtree(target, *args, **kwargs)

    monkeypatch.setattr(helper.shutil, "rmtree", recording_rmtree)
    helper._remove_unadopted_snapshot(snapshot)

    assert not snapshot.exists()
    assert observed and all(not visible for _, visible in observed), observed
    assert [p for p in tmp_path.iterdir()] == [], list(tmp_path.iterdir())


def test_script_snapshot_cleanup_retries_abandoned_tombstones(tmp_path):
    """CodeRabbit on PR #1762: a removal interrupted after its rename leaves a
    private tombstone. The next removal of that snapshot, or a cleanup that finds
    the snapshot already absent, deletes it instead of leaking it."""
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "cloudbench_script_snapshot_tombstones", ROOT / "scripts/cloudbench-script-snapshot.py"
    )
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    token = "0123456789abcdef0123456789abcdef"
    snapshot = tmp_path / f"cloudbench-scripts.{token}"
    abandoned = tmp_path / f".{snapshot.name}.removing-4242"
    (abandoned / "nested").mkdir(parents=True)
    (abandoned / "nested" / "left-behind").write_text("partial\n")
    snapshot.mkdir()
    (snapshot / "cloudbench-script-snapshot.py").write_text("# helper\n")

    helper._remove_unadopted_snapshot(snapshot)
    assert list(tmp_path.iterdir()) == []

    abandoned.mkdir()
    (abandoned / "left-behind").write_text("partial\n")
    assert helper.cleanup(snapshot, tmp_path, token, os.getppid(), "unused", False) == "absent"
    assert list(tmp_path.iterdir()) == []
