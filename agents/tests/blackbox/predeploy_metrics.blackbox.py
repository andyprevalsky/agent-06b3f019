"""Blackbox tests for local pre-deploy scheduling and run summaries."""

import asyncio
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from _test_utils import BlackboxResult, teardown_mock


def _wait_for_file(path: Path, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if path.read_text().strip():
                return
        except FileNotFoundError:
            pass
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {path}")


def _pid_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def _write_history(path: Path) -> None:
    rows = {
        "chat-mode": [80, 90, 85],
        "spawn-sub-agents": [170, 190, 180],
        "parallel-tool-calls": [175, 185, 180],
        "browser-smoke": [195, 205, 200],
    }
    with path.open("w") as handle:
        for task, durations in rows.items():
            for duration in durations:
                handle.write(
                    json.dumps(
                        {
                            "task": task,
                            "duration_seconds": duration,
                            "timestamp": "2026-07-18T00:00:00+00:00",
                        }
                    )
                    + "\n"
                )


def test_longest_first_schedule_preserves_gate_and_reduces_makespan() -> None:
    from benchmarks.predeploy_metrics import estimate_makespan, schedule_longest_first

    tasks = [
        "chat-mode",
        "spawn-sub-agents",
        "parallel-tool-calls",
        "browser-smoke",
    ]
    with tempfile.TemporaryDirectory() as raw_dir:
        history_file = Path(raw_dir) / "task_durations.jsonl"
        _write_history(history_file)

        schedule = schedule_longest_first(tasks, history_file=history_file, window=3)

    assert schedule.tasks == [
        "browser-smoke",
        "spawn-sub-agents",
        "parallel-tool-calls",
        "chat-mode",
    ]
    assert sorted(schedule.tasks) == sorted(tasks)
    assert schedule.estimated_seconds == {
        "chat-mode": 85.0,
        "spawn-sub-agents": 180.0,
        "parallel-tool-calls": 180.0,
        "browser-smoke": 200.0,
    }
    assert estimate_makespan(schedule.tasks, schedule.estimated_seconds, concurrency=2) == 360.0
    assert estimate_makespan(tasks, schedule.estimated_seconds, concurrency=2) == 380.0


def test_schedule_keeps_catalog_order_for_tasks_without_history() -> None:
    from benchmarks.predeploy_metrics import schedule_longest_first

    with tempfile.TemporaryDirectory() as raw_dir:
        history_file = Path(raw_dir) / "task_durations.jsonl"
        _write_history(history_file)
        schedule = schedule_longest_first(
            ["unknown-a", "spawn-sub-agents", "unknown-b"],
            history_file=history_file,
            window=3,
        )

    assert schedule.tasks == ["spawn-sub-agents", "unknown-a", "unknown-b"]
    assert schedule.estimated_seconds == {"spawn-sub-agents": 180.0}


def test_run_summary_records_actual_wall_time_and_schedule() -> None:
    from benchmarks.predeploy_metrics import write_run_summary

    with tempfile.TemporaryDirectory() as raw_dir:
        output = Path(raw_dir) / "summary.json"
        write_run_summary(
            output,
            run_id="20260718-120000-123",
            started_at="2026-07-18T12:00:00Z",
            finished_at="2026-07-18T12:08:30Z",
            started_epoch=1000.0,
            finished_epoch=1510.4,
            exit_code=0,
            concurrency=2,
            tasks=["chat-mode", "browser-smoke"],
            schedule=["browser-smoke", "chat-mode"],
            git_sha="abc123",
            runner_log=".context/predeploy-runs/run/runner.log",
        )
        summary = json.loads(output.read_text())

    assert summary["status"] == "passed"
    assert summary["duration_seconds"] == 510.4
    assert summary["concurrency"] == 2
    assert summary["tasks"] == ["chat-mode", "browser-smoke"]
    assert summary["schedule"] == ["browser-smoke", "chat-mode"]
    assert summary["runner_log"].endswith("runner.log")


def test_history_filters_end_to_end_runs_to_current_gate_shape() -> None:
    from benchmarks.predeploy_metrics import render_history, write_run_summary

    tasks = ["chat-mode", "browser-smoke"]
    with tempfile.TemporaryDirectory() as raw_dir:
        root = Path(raw_dir)
        history_file = root / "task_durations.jsonl"
        _write_history(history_file)
        cases = [
            ("matching-pass", tasks, 2, 100.0, 0),
            ("matching-fail", tasks, 2, 110.0, 1),
            ("different-tasks", ["chat-mode"], 2, 5.0, 0),
            ("different-concurrency", tasks, 5, 10.0, 0),
        ]
        for run_id, run_tasks, concurrency, duration, exit_code in cases:
            write_run_summary(
                root / run_id / "summary.json",
                run_id=run_id,
                started_at="2026-07-18T12:00:00Z",
                finished_at="2026-07-18T12:10:00Z",
                started_epoch=1000.0,
                finished_epoch=1000.0 + duration,
                exit_code=exit_code,
                concurrency=concurrency,
                tasks=run_tasks,
                schedule=run_tasks,
                git_sha="abc123",
                runner_log="runner.log",
            )

        rendered = render_history(
            tasks,
            history_file=history_file,
            run_root=root,
            concurrency=2,
        )

    assert "Comparable end-to-end local runs: 2 (1 passed, 1 failed)" in rendered
    assert "passed p50=100.0s p90=100.0s" in rendered
    assert "environment-agnostic" in rendered


def test_local_runner_persists_console_log_and_summary() -> None:
    repo_root = Path(__file__).resolve().parents[3]
    with tempfile.TemporaryDirectory() as raw_dir:
        fixture = Path(raw_dir)
        (fixture / "scripts").mkdir()
        (fixture / "agents/benchmarks/history").mkdir(parents=True)
        shutil.copy(repo_root / "scripts/run-predeploy-local", fixture / "scripts/run-predeploy-local")
        shutil.copy(repo_root / "scripts/run_logged_command.py", fixture / "scripts/run_logged_command.py")
        shutil.copy(
            repo_root / "agents/benchmarks/predeploy_metrics.py",
            fixture / "agents/benchmarks/predeploy_metrics.py",
        )
        shutil.copy(
            repo_root / "agents/benchmarks/select_predeploy_benches.py",
            fixture / "agents/benchmarks/select_predeploy_benches.py",
        )
        shutil.copy(
            repo_root / "agents/benchmarks/history_ledger.py",
            fixture / "agents/benchmarks/history_ledger.py",
        )
        (fixture / "agents/benchmarks/history/task_attempts.jsonl").write_text("")
        (fixture / "agents/benchmarks/tasks.json").write_text(
            json.dumps(
                [
                    {"name": "short-task", "tags": ["smoke"], "timeout_seconds": 60, "deploy_category": "harness"},
                    {"name": "medium-task", "tags": ["smoke"], "timeout_seconds": 60, "deploy_category": "harness"},
                    {"name": "long-task", "tags": ["smoke"], "timeout_seconds": 60, "deploy_category": "harness"},
                ]
            )
        )
        history = fixture / "agents/benchmarks/history/task_durations.jsonl"
        history.write_text(
            "".join(
                json.dumps({"task": task, "duration_seconds": duration}) + "\n"
                for task, duration in [
                    ("short-task", 10),
                    ("medium-task", 20),
                    ("long-task", 30),
                    ("short-task", 12),
                    ("medium-task", 22),
                    ("long-task", 32),
                ]
            )
        )
        fake_runner = fixture / "scripts/run-bench"
        fake_runner.write_text("#!/usr/bin/env bash\nprintf 'fake runner: %s\\n' \"$*\"\n")
        fake_runner.chmod(0o755)
        subprocess.run(["git", "init", "-q", str(fixture)], check=True)
        subprocess.run(["git", "-C", str(fixture), "config", "user.email", "bench@example.com"], check=True)
        subprocess.run(["git", "-C", str(fixture), "config", "user.name", "Bench"], check=True)
        subprocess.run(["git", "-C", str(fixture), "add", "."], check=True)
        subprocess.run(["git", "-C", str(fixture), "commit", "-qm", "fixture"], check=True)
        env = {**os.environ, "PREDEPLOY_RUN_ID": "fixture-run"}
        env.pop("PREDEPLOY_LOCAL_CONCURRENCY", None)

        completed = subprocess.run(
            ["bash", str(fixture / "scripts/run-predeploy-local")],
            cwd=fixture,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

        artifact_dir = fixture / ".context/predeploy-runs/fixture-run"
        summary = json.loads((artifact_dir / "summary.json").read_text())
        runner_log = (artifact_dir / "runner.log").read_text()

    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert (
        "Schedule (longest recent median first, concurrency 2): "
        "long-task medium-task short-task"
    ) in completed.stdout
    assert (
        "fake runner: --local long-task medium-task short-task --max-concurrency 2"
        in runner_log
    )
    assert summary["status"] == "passed"
    assert summary["concurrency"] == 2
    assert summary["tasks"] == ["short-task", "medium-task", "long-task"]
    assert summary["schedule"] == ["long-task", "medium-task", "short-task"]


def test_timing_wrappers_terminate_child_groups_and_record_signal() -> None:
    repo_root = Path(__file__).resolve().parents[3]
    stage_runner = repo_root / "scripts/run-deploy-stage"
    with tempfile.TemporaryDirectory() as raw_dir:
        temp_dir = Path(raw_dir)
        stage_pid_file = temp_dir / "stage-child.pid"
        env = {**os.environ, "DEPLOY_RUN_ROOT": str(temp_dir / "deploy-runs")}
        subprocess.run(
            ["bash", str(stage_runner), "--start", "--run-id", "signal-deploy"],
            cwd=repo_root,
            env=env,
            check=True,
            capture_output=True,
        )
        stage_process = subprocess.Popen(
            [
                "bash",
                str(stage_runner),
                "slow-stage",
                "--",
                "bash",
                "-c",
                f"printf '%s\\n' $$ > '{stage_pid_file}'; while :; do sleep 1; done",
            ],
            cwd=repo_root,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        _wait_for_file(stage_pid_file)
        stage_child_pid = int(stage_pid_file.read_text())
        stage_process.terminate()
        stage_process.communicate(timeout=10)
        stage_rows = [
            json.loads(line)
            for line in (temp_dir / "deploy-runs/signal-deploy/stages.jsonl").read_text().splitlines()
        ]

        fixture = temp_dir / "local-fixture"
        (fixture / "scripts").mkdir(parents=True)
        (fixture / "agents/benchmarks/history").mkdir(parents=True)
        shutil.copy(repo_root / "scripts/run-predeploy-local", fixture / "scripts/run-predeploy-local")
        shutil.copy(repo_root / "scripts/run_logged_command.py", fixture / "scripts/run_logged_command.py")
        shutil.copy(
            repo_root / "agents/benchmarks/predeploy_metrics.py",
            fixture / "agents/benchmarks/predeploy_metrics.py",
        )
        shutil.copy(
            repo_root / "agents/benchmarks/select_predeploy_benches.py",
            fixture / "agents/benchmarks/select_predeploy_benches.py",
        )
        shutil.copy(
            repo_root / "agents/benchmarks/history_ledger.py",
            fixture / "agents/benchmarks/history_ledger.py",
        )
        (fixture / "agents/benchmarks/history/task_attempts.jsonl").write_text("")
        (fixture / "agents/benchmarks/tasks.json").write_text(
            json.dumps(
                [
                    {
                        "name": "slow-task",
                        "tags": ["smoke"],
                        "timeout_seconds": 60,
                        "deploy_category": "harness",
                    }
                ]
            )
        )
        (fixture / "agents/benchmarks/history/task_durations.jsonl").write_text("")
        local_pid_file = temp_dir / "local-child.pid"
        cleanup_sentinel = temp_dir / "local-cleanup-finished"
        fake_runner = fixture / "scripts/run-bench"
        fake_runner.write_text(
            "#!/usr/bin/env bash\n"
            # Short deliberate delay so cleanup is observable without starving
            # communicate() under parallel deploy-gate load.
            f"trap 'sleep 2; printf cleaned > \"{cleanup_sentinel}\"; exit 143' TERM\n"
            f"printf '%s\\n' $$ > '{local_pid_file}'\n"
            "while :; do sleep 1; done\n"
        )
        fake_runner.chmod(0o755)
        subprocess.run(["git", "init", "-q", str(fixture)], check=True)
        subprocess.run(["git", "-C", str(fixture), "config", "user.email", "bench@example.com"], check=True)
        subprocess.run(["git", "-C", str(fixture), "config", "user.name", "Bench"], check=True)
        subprocess.run(["git", "-C", str(fixture), "add", "."], check=True)
        subprocess.run(["git", "-C", str(fixture), "commit", "-qm", "fixture"], check=True)
        local_env = {**os.environ, "PREDEPLOY_RUN_ID": "signal-local"}
        local_process = subprocess.Popen(
            ["bash", str(fixture / "scripts/run-predeploy-local")],
            cwd=fixture,
            env=local_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        _wait_for_file(local_pid_file)
        local_child_pid = int(local_pid_file.read_text())
        local_process.terminate()
        local_output, _ = local_process.communicate(timeout=20)
        local_summary = json.loads(
            (fixture / ".context/predeploy-runs/signal-local/summary.json").read_text()
        )
        cleanup_completed = cleanup_sentinel.exists() and cleanup_sentinel.read_text() == "cleaned"

    assert stage_process.returncode == 143
    assert stage_rows[-1]["exit_code"] == 143
    assert not _pid_exists(stage_child_pid)
    assert local_process.returncode == 143
    assert local_summary["exit_code"] == 143
    assert cleanup_completed, local_output
    assert not _pid_exists(local_child_pid)


def test_logged_command_streams_output_before_child_exit() -> None:
    repo_root = Path(__file__).resolve().parents[3]
    helper = repo_root / "scripts/run_logged_command.py"
    with tempfile.TemporaryDirectory() as raw_dir:
        log_path = Path(raw_dir) / "live.log"
        process = subprocess.Popen(
            [
                "python3",
                str(helper),
                str(log_path),
                "--",
                "bash",
                "-c",
                "printf 'early output\\n'; sleep 2; printf 'late output\\n'",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        # Reading the wrapper's stdout is the synchronization primitive: if it
        # buffers until child exit, poll() is already terminal when readline()
        # returns. This stays deterministic under coverage CPU load without a
        # one-second scheduling race.
        early_line = process.stdout.readline() if process.stdout is not None else ""
        streamed_while_running = (
            "early output" in early_line
            and log_path.exists()
            and "early output" in log_path.read_text()
            and process.poll() is None
        )
        process.communicate(timeout=5)

    assert streamed_while_running
    assert process.returncode == 0


def test_deploy_stage_runner_records_status_output_and_history() -> None:
    repo_root = Path(__file__).resolve().parents[3]
    runner = repo_root / "scripts/run-deploy-stage"
    with tempfile.TemporaryDirectory() as raw_dir:
        env = {**os.environ, "DEPLOY_RUN_ROOT": raw_dir}
        started = subprocess.run(
            ["bash", str(runner), "--start", "--run-id", "fixture-deploy"],
            cwd=repo_root,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        passed = subprocess.run(
            ["bash", str(runner), "typecheck", "--", "bash", "-c", "printf 'typecheck ok\\n'"],
            cwd=repo_root,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        failed = subprocess.run(
            ["bash", str(runner), "semantic", "--", "bash", "-c", "printf 'semantic failed\\n'; exit 7"],
            cwd=repo_root,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        summary = subprocess.run(
            ["bash", str(runner), "--summary"],
            cwd=repo_root,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        history = subprocess.run(
            ["bash", str(runner), "--history"],
            cwd=repo_root,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        finished = subprocess.run(
            ["bash", str(runner), "--finish"],
            cwd=repo_root,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        completed_history = subprocess.run(
            ["bash", str(runner), "--history"],
            cwd=repo_root,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        run_dir = Path(raw_dir) / "fixture-deploy"
        rows = [json.loads(line) for line in (run_dir / "stages.jsonl").read_text().splitlines()]
        metadata = json.loads((run_dir / "metadata.json").read_text())
        typecheck_log = (run_dir / rows[0]["log"]).read_text()

    assert started.returncode == 0, started.stdout + started.stderr
    assert passed.returncode == 0
    assert failed.returncode == 7
    assert [row["stage"] for row in rows] == ["typecheck", "semantic"]
    assert [row["status"] for row in rows] == ["passed", "failed"]
    assert typecheck_log == "typecheck ok\n"
    assert "typecheck" in summary.stdout and "semantic" in summary.stdout
    assert "Parallel overlap:" in summary.stdout
    assert "Unrecorded/gap time:" in summary.stdout
    assert "Completed run-span history: none yet" in history.stdout
    assert finished.returncode == 0, finished.stdout + finished.stderr
    assert metadata["status"] == "completed"
    assert "Completed run-span p50=" in completed_history.stdout
    assert "fixture-deploy" in completed_history.stdout


def test_deploy_summary_separates_parallel_overlap_from_gaps() -> None:
    repo_root = Path(__file__).resolve().parents[3]
    spec = importlib.util.spec_from_file_location("deploy_stage_under_test", repo_root / "scripts/deploy_stage.py")
    assert spec is not None and spec.loader is not None
    deploy_stage = importlib.util.module_from_spec(spec)
    # A file-spec import does not add its sibling scripts directory to sys.path.
    # The production CLI does, so give this fixture the same import context.
    sys.path.insert(0, str(repo_root / "scripts"))
    try:
        spec.loader.exec_module(deploy_stage)
    finally:
        sys.path.pop(0)

    with tempfile.TemporaryDirectory() as raw_dir:
        run_dir = Path(raw_dir) / "interval-run"
        deploy_stage.init_run(
            run_dir,
            run_id="interval-run",
            started_at="2026-07-18T12:00:00Z",
            started_epoch=0.0,
            git_sha="abc123",
            branch="test",
        )
        for stage, started, finished in [
            ("parallel-a", 0.0, 10.0),
            ("parallel-b", 0.0, 10.0),
            ("after-gap", 100.0, 110.0),
        ]:
            deploy_stage.append_stage(
                run_dir,
                run_id="interval-run",
                stage=stage,
                started_at="2026-07-18T12:00:00Z",
                finished_at="2026-07-18T12:00:10Z",
                started_epoch=started,
                finished_epoch=finished,
                exit_code=0,
                log=f"logs/{stage}.log",
            )
        deploy_stage.finalize_run(
            run_dir,
            finished_at="2026-07-18T12:02:00Z",
            finished_epoch=120.0,
        )
        rendered = deploy_stage.render_summary(run_dir)

    assert "Recorded wall span: 120.0s" in rendered
    assert "Summed stage time: 30.0s" in rendered
    assert "Parallel overlap: 10.0s" in rendered
    assert "Unrecorded/gap time: 100.0s" in rendered


def test_resource_exhaustion_receipt_policy() -> None:
    repo_root = Path(__file__).resolve().parents[3]
    completed = subprocess.run(
        [sys.executable, str(repo_root / "scripts/tests/predeploy-receipts.test.py")],
        capture_output=True, text=True, timeout=30,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr


async def run_all_tests():
    print("predeploy-metrics blackbox tests:")
    result = BlackboxResult()
    result.record(
        "longest_first_preserves_gate",
        test_longest_first_schedule_preserves_gate_and_reduces_makespan,
    )
    result.record(
        "missing_history_is_stable",
        test_schedule_keeps_catalog_order_for_tasks_without_history,
    )
    result.record(
        "summary_records_wall_time",
        test_run_summary_records_actual_wall_time_and_schedule,
    )
    result.record(
        "history_filters_gate_shape",
        test_history_filters_end_to_end_runs_to_current_gate_shape,
    )
    result.record(
        "runner_persists_artifacts",
        test_local_runner_persists_console_log_and_summary,
    )
    result.record(
        "deploy_stage_timeline",
        test_deploy_stage_runner_records_status_output_and_history,
    )
    result.record(
        "deploy_interval_math",
        test_deploy_summary_separates_parallel_overlap_from_gaps,
    )
    result.record(
        "signal_cleanup",
        test_timing_wrappers_terminate_child_groups_and_record_signal,
    )
    result.record(
        "live_log_streaming",
        test_logged_command_streams_output_before_child_exit,
    )
    result.record("resource_exhaustion_receipts", test_resource_exhaustion_receipt_policy)
    teardown_mock()
    return result.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
