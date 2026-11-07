"""Cement: a signalled local benchmark controller never orphans its runner.

TERMing the local.py controller tore down the isolated stack but left the
run_benchmark.py child and its flyctl log stream running under launchd.
"""

from __future__ import annotations

import inspect
import os
import subprocess
import sys
import time
from pathlib import Path

AGENTS_DIR = Path(__file__).resolve().parents[2]
if str(AGENTS_DIR) not in sys.path:
    sys.path.insert(0, str(AGENTS_DIR))

from benchmarks import local


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def test_stop_active_child_processes_reaps_runner_and_descendants(tmp_path: Path) -> None:
    grandchild_pid_file = tmp_path / "grandchild.pid"
    runner = subprocess.Popen(
        [
            sys.executable,
            "-c",
            (
                "import pathlib, signal, subprocess, sys, time\n"
                "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
                "child = subprocess.Popen(['sleep', '60'])\n"
                f"pathlib.Path({str(grandchild_pid_file)!r}).write_text(str(child.pid))\n"
                "time.sleep(60)\n"
            ),
        ]
    )
    local._ACTIVE_CHILD_PROCESSES.add(runner)
    try:
        deadline = time.monotonic() + 10
        while not grandchild_pid_file.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        grandchild_pid = int(grandchild_pid_file.read_text())

        # The runner ignores TERM, so this also proves the KILL escalation.
        local.stop_active_child_processes(grace_seconds=1)

        assert runner.poll() is not None
        deadline = time.monotonic() + 5
        while _alive(grandchild_pid) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert not _alive(grandchild_pid)
        assert runner not in local._ACTIVE_CHILD_PROCESSES
    finally:
        if runner.poll() is None:
            runner.kill()
            runner.wait()
        local._ACTIVE_CHILD_PROCESSES.discard(runner)


def test_streamed_commands_are_tracked_only_while_running() -> None:
    code, _ = local.run_streamed_command([sys.executable, "-c", "print('ok')"], cwd=AGENTS_DIR)
    assert code == 0
    assert not local._ACTIVE_CHILD_PROCESSES


def test_shutdown_handler_stops_runner_before_services() -> None:
    source = inspect.getsource(local.main)
    handler = source[source.index("def handle_shutdown") :]
    assert handler.index("stop_active_child_processes()") < handler.index("stop_services(")


# The 2026-11-05 deploy measurement TERMed local.py, which SIGINTed this runner.
# asyncio.run cancelled the coordinator while the exclusive
# agent-payment-setup-resume task ran; run_single_task returned its CANCELLED
# row instead of re-raising, and the coordinator admitted the three queued paid
# AgentCard tasks for ~24 more minutes. The actual coordinator statements run
# below with only the task executor and external edges replaced.
def _coordinator_case(parallel: bool):
    import ast
    import asyncio
    from types import SimpleNamespace

    from benchmarks import run_benchmark as bench

    tree = ast.parse(inspect.getsource(bench))
    wrapper = next(n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef) and n.name == "_run_reported_task")
    execution = next(
        n
        for n in ast.walk(tree)
        if isinstance(n, ast.Try)
        and n.body
        and isinstance(n.body[0], ast.If)
        and isinstance(n.body[0].test, ast.Name)
        and n.body[0].test.id == "checkpoint_source_mode"
    )
    coordinator = ast.AsyncFunctionDef(
        name="_coordinator",
        args=ast.arguments(posonlyargs=[], args=[], kwonlyargs=[], kw_defaults=[], defaults=[]),
        body=[execution],
        decorator_list=[],
    )
    names = [
        "agent-payment-setup-resume",
        "agent-payment-test-shop",
        "agent-payment-idempotent-abandonment",
        "agent-payment-abandonment",
    ]
    tasks = [bench.get_task_by_name(name) for name in names]
    if parallel:
        assert [t.name for t in bench._parallel_task_phases(tasks)[0][1]] == names[:1]
    entered: list[str] = []
    first_entered = asyncio.Event()
    finalized: dict = {}

    def row(name: str, status: str) -> object:
        return bench.TaskResult(
            name=name, passed=status == "COMPLETED", agent_id="", status=status,
            benchmark_status="PASSED" if status == "COMPLETED" else status, progress_score=0,
            duration_seconds=0, cost_cents=0, message_count=0,
        )

    async def run_single_task(url, task, *, on_agent_created, on_task_evaluated, **kwargs):
        entered.append(task.name)
        if len(entered) > 1:
            return row(task.name, "COMPLETED")  # A queued paid task that was admitted.
        first_entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            # The real executor's contract: collect evidence, return a row.
            return row(task.name, "CANCELLED")
        raise AssertionError("unreachable")

    async def passthrough_lock(task, runner):
        return await runner()

    async def stop_collector():
        return 0

    async def finalize(url, run, live_ids, **kwargs):
        finalized.update(kwargs, rows=list(run.task_results))

    run = SimpleNamespace(task_results=[])
    namespace = dict(bench.__dict__)
    namespace.update({
        "run_single_task": run_single_task, "_run_with_sandbox_payment_lock": passthrough_lock,
        "_entered_task_futures": set(), "_never_admitted_results": [], "_admitted_tasks": {},
        "_admitted_agent_ids": {}, "_evaluated_task_results": {}, "_outcome_signatures": {},
        "_remember_live_agent": lambda name, aid: None, "_live_task_agent_ids": {},
        "_emit_report": lambda **kwargs: None, "checkpoint_source_mode": False,
        "args": SimpleNamespace(parallel=parallel, keep_failed_agents=True, max_concurrency=1, prod=False),
        "tasks": tasks, "run": run, "base_url": "http://offline.invalid",
        "batch_started_at": None, "_report_ticker_task": SimpleNamespace(cancel=lambda: None),
        "stop_fly_log_collector": stop_collector, "realtime_started": False, "memory_gate_enabled": False,
        "owned_batch_cleanup": False, "_finalize_owned_batch_and_save_run": finalize,
        "_wmh_evidence": SimpleNamespace(finalize=lambda: None),
        "cloud_batch_cleanup": SimpleNamespace(contract=lambda: None),
    })
    module = ast.fix_missing_locations(ast.Module(body=[wrapper, coordinator], type_ignores=[]))
    exec(compile(module, str(bench.__file__), "exec"), namespace)

    async def scenario():
        main = asyncio.create_task(namespace["_coordinator"]())
        await asyncio.wait_for(first_entered.wait(), 10)
        main.cancel()  # asyncio.run's handling of the owner's SIGINT.
        try:
            await asyncio.wait_for(main, 10)
        except asyncio.CancelledError:
            return "interrupted"
        return "completed"

    outcome = asyncio.run(scenario())
    return outcome, entered, finalized, names, bench


def _assert_interrupt_admits_nothing_queued(parallel: bool) -> None:
    outcome, entered, finalized, names, bench = _coordinator_case(parallel)
    assert entered == names[:1], f"queued tasks were admitted after the interrupt: {entered}"
    assert outcome == "interrupted"
    rows = finalized["rows"]
    assert [r.name for r in rows] == names and all(r.status == "CANCELLED" and not r.passed for r in rows)
    proofs = finalized["never_admitted_results"]
    # Exactly the queued occurrences carry the coordinator's nonadmission proof.
    assert len(proofs) == 3 and all(any(p is r for r in rows[1:]) for p in proofs)
    assert sorted(p.stop_metadata["occurrence_index"] for p in proofs) == [1, 2, 3]
    assert all(
        p.graded_root_creation_outcome == "not_started"
        and p.stop_metadata == {"runner": "benchmark_coordinator", "admission": "not_started",
                                "occurrence_index": p.stop_metadata["occurrence_index"]}
        for p in proofs
    )


def test_interrupt_of_exclusive_serial_task_admits_no_queued_task() -> None:
    _assert_interrupt_admits_nothing_queued(parallel=True)


def test_interrupt_of_sequential_task_admits_no_queued_task() -> None:
    _assert_interrupt_admits_nothing_queued(parallel=False)
