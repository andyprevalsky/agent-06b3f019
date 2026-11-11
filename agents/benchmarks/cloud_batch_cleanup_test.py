"""Behavioral regression gates for late recordings and exact cloud cleanup."""

import ast
import asyncio
import copy
import functools
import inspect
import json
import os
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from benchmarks import cloud_batch_cleanup as cleanup
from benchmarks import run_benchmark as bench

ROOT = "00000000-0000-4000-8000-000000000001"
CHILD = "00000000-0000-4000-8000-000000000002"


def async_case(function):
    @functools.wraps(function)
    def run():
        return asyncio.run(function())

    run.async_case = function
    return run


@async_case
async def test_evaluated_outcome_is_visible_before_agent_and_phone_teardown():
    for passed in (True, False):
        with pytest.MonkeyPatch.context() as monkeypatch:
            await _assert_evaluated_before_teardown(monkeypatch, passed)


async def _assert_evaluated_before_teardown(
    monkeypatch,
    passed,
    *,
    native=False,
    terminal=None,
    retirement_failure=False,
    log_failure=False,
    admission_failure=False,
    missing_agent=False,
):
    """Exercise the real task runner through evaluation and both cleanup boundaries."""
    events = []
    evaluations = []
    task = copy.deepcopy(bench.get_task_by_name("parallel-tool-calls"))
    task.tags = []
    task.min_steps = {}
    task.min_tool_counts = {}
    task.min_agent_count = None
    task.phone_persona = {"system_prompt": "fixture"}
    task.enforce_declared_evaluators = False

    class Callee:
        phone_number = "fixture-phone"
        dial_number = "fixture-phone"
        hold_line = None
        assistant_id = "fixture-assistant"

        def __init__(self, *_args):
            pass

        async def setup(self):
            pass

        async def cleanup(self):
            events.append("phone-cleanup")

    async def empty(*_args, **_kwargs):
        return []

    async def poll(*_args):
        if terminal == "cancel":
            raise asyncio.CancelledError("execution cancelled")
        if terminal == "error":
            raise RuntimeError("execution failed")
        return {"agent": {"status": "COMPLETED"}, "messages": []}, 0, 0, None

    async def delete(_base, aid):
        assert aid == ROOT
        events.append("agent-cleanup")
        if missing_agent:
            raise RuntimeError("Failed to delete agent: HTTP 404")

    for name in (
        "_apply_live_fixtures",
        "_apply_memory_fixtures",
        "_restore_live_fixture_scenarios_async",
        "subscribe_supabase_realtime_agent",
        "get_agent_tree",
        "post_world_model_update_events",
        "archive_agent_start",
    ):
        monkeypatch.setattr(bench, name, empty)
    monkeypatch.setattr(bench, "PhoneCalleeSession", Callee)
    monkeypatch.setattr(bench, "create_agent", AsyncMock(return_value=ROOT))
    monkeypatch.setattr(bench, "_poll_agent", poll)
    monkeypatch.setattr(bench, "_get_settled_tool_usage", AsyncMock(return_value={}))
    monkeypatch.setattr(bench, "_fetch_tree_stats", AsyncMock(return_value={}))
    monkeypatch.setattr(
        bench,
        "get_llm_usage_details",
        AsyncMock(return_value=({}, bench.aggregate_prompt_cache_share([]))),
    )

    def evaluate(*_args):
        evaluations.append(True)
        return passed, None if passed else "task failed"

    monkeypatch.setattr(bench, "evaluate_task", evaluate)
    monkeypatch.setattr(bench, "_evaluate_phone_call_task", AsyncMock(return_value=(True, None)))
    monkeypatch.setattr(bench, "ensure_payment_lifecycle_cleanup", AsyncMock(return_value=None))
    monkeypatch.setattr(bench, "collect_logs", AsyncMock(return_value={"messages": []}))
    monkeypatch.setattr(bench, "finalize_archive_and_score_world_model", AsyncMock(return_value=("fixture", None)))
    monkeypatch.setattr(bench, "_should_delete_agent_after_run", lambda *_args: True)
    monkeypatch.setattr(bench, "delete_agent", delete)
    if admission_failure and not native:
        monkeypatch.setattr(bench, "create_agent", AsyncMock(side_effect=RuntimeError("execution failed")))
    if terminal or retirement_failure:

        async def get(_base, aid):
            assert aid == ROOT
            if missing_agent:
                raise bench.AgentNotFoundError("Exact seeded root is absent")
            return {"agent": {"status": "CANCELLED"}, "messages": []}

        monkeypatch.setattr(bench, "get_agent", get)
        monkeypatch.setattr(bench, "_begin_interrupt_cleanup", lambda: False)
        monkeypatch.setattr(bench, "_should_delete_cancelled_agent", lambda *_args: True)

        async def archive(*_args, **_kwargs):
            events.append("archive")
            return "fixture", None

        monkeypatch.setattr(bench, "finalize_archive_and_score_world_model", archive)
    if log_failure:
        monkeypatch.setattr(bench, "collect_logs", AsyncMock(side_effect=RuntimeError("logs unavailable")))

    if native:
        receipt = {
            "ended": "native-owned",
            "engine": "experiential",
            "session_id": "native-owned",
            "session_scope_id": ROOT,
            "revision": 3,
            "state": {"sent": False},
            "history": [],
            "usage": {"calls": 3, "total_cost_usd": 0.2},
            "join_verified": True,
        }

        async def create_native(_base, execution_task):
            execution_task._wmh_owned_session = {
                "base_url": "http://native.test",
                "model_name": "rose-test",
                "session_id": "native-owned",
                "root_agent_id": ROOT,
                "engine": "experiential",
            }
            if admission_failure:
                if terminal == "cancel":
                    raise asyncio.CancelledError("execution cancelled")
                raise RuntimeError("execution failed")
            return ROOT

        class NativeClient:
            def __init__(self, base):
                assert base == "http://native.test"

            async def end_session(self, name, session_id):
                assert (name, session_id) == ("rose-test", "native-owned")
                await asyncio.sleep(0)
                if retirement_failure:
                    events.append("native-unjoined")
                    raise RuntimeError("retirement unavailable")
                events.append("native-joined")
                return receipt

        async def settled_usage(*_args, **_kwargs):
            assert events == ["native-joined"], "native provider work must join before cost is frozen"
            return {}

        monkeypatch.setattr(bench, "create_agent", create_native)
        monkeypatch.setattr(bench, "WMHHttpClient", NativeClient)
        monkeypatch.setattr(bench, "_get_settled_tool_usage", settled_usage)

    async def evaluated(result):
        expected_root = ROOT if native or not admission_failure else ""
        assert result.agent_id == expected_root and result.passed is passed
        await asyncio.sleep(0)
        events.append("evaluated")

    kwargs = (
        {"on_task_evaluated": evaluated}
        if "on_task_evaluated" in inspect.signature(bench.run_single_task).parameters
        else {}
    )
    result = await bench.run_single_task("http://localhost:39999", task, **kwargs)
    assert result.passed is passed
    expected = ["evaluated", "agent-cleanup", "phone-cleanup"]
    if terminal or retirement_failure:
        expected = ["archive", *([] if terminal == "cancel" else ["evaluated"]), "agent-cleanup", "phone-cleanup"]
        if admission_failure and not native:
            expected = ["evaluated", "phone-cleanup"]
    if native:
        expected.insert(0, "native-unjoined" if retirement_failure else "native-joined")
    assert events == expected
    if native:
        if retirement_failure:
            assert result.benchmark_status in {"ERROR", "CANCELLED"} and not result.passed
            error = result.logs["wmh_retirement_error"]
            assert error["type"] == "RuntimeError" and error["message"] == "retirement unavailable"
            assert error["session_id"] == "native-owned" and error["session_scope_id"] == ROOT
            assert error["join_verified"] is False and error["cost_verified"] is False
            assert result.logs["benchmark_cost_placeholder"] == {"cost_cents": 0, "settled": False}
            assert not evaluations, "an unjoined world cannot reach task evaluation or settled cost"
            assert "retirement unavailable" in result.failure_reason
            if terminal == "error":
                assert "execution failed" in result.failure_reason
                assert result.logs["benchmark_execution_error"] == {
                    "type": "RuntimeError",
                    "message": "execution failed",
                }
        else:
            assert result.logs["wmh_retirement"] == receipt
        if admission_failure:
            assert result.agent_id == ROOT and not evaluations
            admission = result.logs["wmh_agent_admission"]
            assert admission["root_agent_id"] == ROOT and admission["creation_confirmed"] is False
            if missing_agent:
                assert admission["cleanup_observation"] == "not_found"
            else:
                assert admission["cleanup_observation"] == "deleted"
    elif admission_failure:
        assert result.agent_id == "" and "wmh_agent_admission" not in result.logs


@async_case
async def test_native_world_joins_before_cost_evaluation_and_diagnostics():
    for passed in (True, False):
        with pytest.MonkeyPatch.context() as monkeypatch:
            await _assert_evaluated_before_teardown(monkeypatch, passed, native=True)


@pytest.mark.parametrize("terminal", ["cancel", "error"])
@pytest.mark.parametrize("log_failure", [False, True])
def test_native_world_retirement_preserves_cancel_error_receipts_when_logs_fail(terminal, log_failure):
    with pytest.MonkeyPatch.context() as monkeypatch:
        asyncio.run(
            _assert_evaluated_before_teardown(
                monkeypatch,
                False,
                native=True,
                terminal=terminal,
                log_failure=log_failure,
            )
        )


@pytest.mark.parametrize("terminal", [None, "cancel", "error"])
@pytest.mark.parametrize("log_failure", [False, True])
def test_native_world_retirement_failure_keeps_evidence_cleanup_and_original_error(terminal, log_failure):
    with pytest.MonkeyPatch.context() as monkeypatch:
        asyncio.run(
            _assert_evaluated_before_teardown(
                monkeypatch,
                False,
                native=True,
                terminal=terminal,
                retirement_failure=True,
                log_failure=log_failure,
            )
        )


@pytest.mark.parametrize("terminal", ["cancel", "error"])
@pytest.mark.parametrize("missing_agent", [False, True])
def test_native_world_retirement_owned_seed_recovers_exact_root_after_admission_failure(terminal, missing_agent):
    with pytest.MonkeyPatch.context() as monkeypatch:
        asyncio.run(
            _assert_evaluated_before_teardown(
                monkeypatch,
                False,
                native=True,
                terminal=terminal,
                admission_failure=True,
                missing_agent=missing_agent,
            )
        )


@async_case
async def test_native_world_retirement_caller_owned_admission_does_not_invent_a_root():
    with pytest.MonkeyPatch.context() as monkeypatch:
        await _assert_evaluated_before_teardown(
            monkeypatch,
            False,
            terminal="error",
            admission_failure=True,
        )


def test_native_world_retirement_admission_cleanup_rejects_foreign_and_unverified_roots(monkeypatch):
    async def run():
        task = copy.deepcopy(bench.get_task_by_name("parallel-tool-calls"))
        task._wmh_agent_admission = {"root_agent_id": CHILD, "creation_confirmed": False}
        deletion = AsyncMock(side_effect=RuntimeError("delete unavailable"))
        observed = AsyncMock(return_value={"agent": {"agent_id": ROOT}})
        monkeypatch.setattr(bench, "delete_agent", deletion)
        monkeypatch.setattr(bench, "get_agent", observed)
        with pytest.raises(RuntimeError, match="root does not match"):
            await bench._delete_owned_native_admission_root("http://native.test", task, ROOT)
        assert not deletion.called and not observed.called
        task._wmh_agent_admission["root_agent_id"] = ROOT
        with pytest.raises(RuntimeError, match="delete unavailable"):
            await bench._delete_owned_native_admission_root("http://native.test", task, ROOT)
        assert task._wmh_agent_admission["cleanup_observation"] == "unverified"
        assert task._wmh_agent_admission["creation_confirmed"] is False
        assert task._wmh_agent_admission["cleanup_error"] == {
            "type": "RuntimeError",
            "message": "delete unavailable",
        }

    asyncio.run(run())


@pytest.mark.parametrize(
    "field,value",
    [
        ("join_verified", False),
        ("session_scope_id", CHILD),
        ("session_id", "foreign-session"),
        ("revision", True),
        ("state", None),
        ("usage", None),
    ],
)
def test_native_world_retirement_rejects_unjoined_or_foreign_receipts(monkeypatch, field, value):
    task = copy.deepcopy(bench.get_task_by_name("parallel-tool-calls"))
    task._wmh_owned_session = {
        "base_url": "http://native.test",
        "model_name": "rose-test",
        "session_id": "owned",
        "root_agent_id": ROOT,
        "engine": "experiential",
    }
    receipt = {
        "ended": "owned",
        "engine": "experiential",
        "session_id": "owned",
        "session_scope_id": ROOT,
        "revision": 0,
        "state": {},
        "history": [],
        "usage": {},
        "join_verified": True,
    }
    receipt[field] = value

    class Client:
        def __init__(self, base):
            assert base == "http://native.test"

        async def end_session(self, model, session_id):
            assert (model, session_id) == ("rose-test", "owned")
            return receipt

    monkeypatch.setattr(bench, "WMHHttpClient", Client)
    with pytest.raises(RuntimeError, match="exact owned provider join"):
        asyncio.run(bench._retire_owned_native_world(task, ROOT))
    assert getattr(task, "_wmh_retirement_receipt", None) is None


def test_native_world_retirement_never_closes_a_different_root_or_unowned_session(monkeypatch):
    task = copy.deepcopy(bench.get_task_by_name("parallel-tool-calls"))

    class Client:
        def __init__(self, *_args):
            pytest.fail("unowned/foreign worlds must never reach the retirement endpoint")

    monkeypatch.setattr(bench, "WMHHttpClient", Client)
    assert asyncio.run(bench._retire_owned_native_world(task, ROOT)) is None
    task._wmh_owned_session = {"engine": "legacy"}
    assert asyncio.run(bench._retire_owned_native_world(task, ROOT)) is None
    task._wmh_owned_session = {"engine": "experiential", "root_agent_id": CHILD}
    with pytest.raises(RuntimeError, match="root does not match"):
        asyncio.run(bench._retire_owned_native_world(task, ROOT))
    assert task._wmh_retirement_error["join_verified"] is False
    assert task._wmh_retirement_error["cost_verified"] is False


def test_native_world_retirement_lost_waiter_keeps_one_owner_and_full_receipt(monkeypatch):
    async def run():
        entered = asyncio.Event()
        release = asyncio.Event()
        calls = []
        task = copy.deepcopy(bench.get_task_by_name("parallel-tool-calls"))
        task._wmh_owned_session = {
            "base_url": "http://native.test",
            "model_name": "rose-test",
            "session_id": "owned",
            "root_agent_id": ROOT,
            "engine": "experiential",
        }
        receipt = {
            "ended": "owned",
            "engine": "experiential",
            "session_id": "owned",
            "session_scope_id": ROOT,
            "revision": 1,
            "state": {"submitted": True},
            "history": [],
            "usage": {"calls": 1},
            "join_verified": True,
        }

        class Client:
            def __init__(self, base):
                assert base == "http://native.test"

            async def end_session(self, model, session_id):
                calls.append((model, session_id))
                entered.set()
                await release.wait()
                return receipt

        monkeypatch.setattr(bench, "WMHHttpClient", Client)
        first = asyncio.create_task(bench._retire_owned_native_world(task, ROOT))
        second = None
        try:
            await asyncio.wait_for(entered.wait(), 2)
            first.cancel()
            await asyncio.gather(first, return_exceptions=True)
            second = asyncio.create_task(bench._retire_owned_native_world(task, ROOT))
            await asyncio.sleep(0)
            assert calls == [("rose-test", "owned")] and not second.done()
            release.set()
            assert await asyncio.wait_for(second, 2) == receipt
            assert task._wmh_retirement_receipt == receipt
            assert await bench._retire_owned_native_world(task, ROOT) == receipt
            assert calls == [("rose-test", "owned")]
        finally:
            release.set()
            await asyncio.gather(first, *([second] if second else []), return_exceptions=True)

    asyncio.run(run())


def test_native_world_retirement_parallel_cached_task_copies_keep_exact_roots(monkeypatch):
    async def run():
        task = copy.deepcopy(bench.get_task_by_name("parallel-tool-calls"))
        task._wmh_initial_state_source = "caller-reviewed-seed.json"
        task._wmh_seeded_session_id = "previous-execution"
        admitted = asyncio.Event()
        roots = iter((ROOT, CHILD))
        executions = []
        retired = []
        inherited_sessions = []

        class Client:
            def __init__(self, base):
                assert base == "http://native.test"

            async def end_session(self, model, session):
                assert model == "rose-test"
                retired.append(session)
                return {
                    "ended": session,
                    "engine": "experiential",
                    "session_id": session,
                    "session_scope_id": session,
                    "revision": 0,
                    "state": {},
                    "history": [],
                    "usage": {},
                    "join_verified": True,
                }

        async def execute(_base, execution_task, *_args):
            root = next(roots)
            assert execution_task._wmh_initial_state_source == "caller-reviewed-seed.json"
            inherited_sessions.append(execution_task._wmh_seeded_session_id)
            execution_task._wmh_owned_session = {
                "base_url": "http://native.test",
                "model_name": "rose-test",
                "session_id": root,
                "root_agent_id": root,
                "engine": "experiential",
            }
            executions.append(execution_task)
            if len(executions) == 2:
                admitted.set()
            await admitted.wait()
            receipt = await bench._retire_owned_native_world(execution_task, root)
            return bench.TaskResult(
                name=execution_task.name,
                passed=False,
                agent_id=root,
                status="ERROR",
                benchmark_status="ERROR",
                progress_score=0,
                duration_seconds=0,
                cost_cents=0,
                message_count=0,
                failure_reason="fixture",
                logs={"wmh_retirement": receipt},
            )

        monkeypatch.setattr(bench, "WMHHttpClient", Client)
        monkeypatch.setattr(bench, "_run_single_task_as_run_user", execute)
        results = await asyncio.wait_for(
            asyncio.gather(
                bench.run_single_task("http://localhost:39999", task),
                bench.run_single_task("http://localhost:39999", task),
                return_exceptions=True,
            ),
            2,
        )
        assert all(isinstance(result, bench.TaskResult) for result in results), results
        assert executions[0] is not executions[1] and all(item is not task for item in executions)
        assert inherited_sessions == [None, None]
        assert sorted(retired) == sorted((ROOT, CHILD))
        for result in results:
            assert result.logs["wmh_retirement"]["session_scope_id"] == result.agent_id
        assert task._wmh_seeded_session_id == "previous-execution"
        assert task._wmh_initial_state_source == "caller-reviewed-seed.json"

    asyncio.run(run())


@pytest.mark.parametrize(
    "path", ["delegate-pass", "delegate-fail", "already-evaluated", "cancelled", "raised", "skipped"]
)
def test_evaluated_wrapper_completion_publishes_once_before_owner_release(tmp_path, monkeypatch, path):
    """Exercise the actual admitted wrapper when a delegate omits its callback."""
    from benchmarks import outcome_publication

    source = inspect.getsource(bench)
    tree = ast.parse(source)
    wrapper = next(
        node for node in ast.walk(tree) if isinstance(node, ast.AsyncFunctionDef) and node.name == "_run_reported_task"
    )
    execution = next(
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Try)
        and node.body
        and isinstance(node.body[0], ast.If)
        and isinstance(node.body[0].test, ast.Name)
        and node.body[0].test.id == "checkpoint_source_mode"
    )
    finalize_and_save = next(
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "_finalize_owned_batch_and_save_run"
    )
    coordinator = ast.AsyncFunctionDef(
        name="_owning_coordinator",
        args=ast.arguments(posonlyargs=[], args=[], kwonlyargs=[], kw_defaults=[], defaults=[]),
        body=[execution],
        decorator_list=[],
    )
    task = SimpleNamespace(name="delegated-task")
    result = SimpleNamespace(name=task.name, passed=path != "delegate-fail", agent_id=ROOT)
    if path == "skipped":
        result = bench._claude_code_credential_skip_result(task)
    returned = SimpleNamespace(name=task.name, passed=False, agent_id=ROOT) if path == "already-evaluated" else result
    admitted, agents, evaluated, signatures, live_ids = {}, {}, {}, {}, {}
    events = []
    monkeypatch.setenv("BENCHMARK_HUB_PARENT_RUN_ID", "fixture-parent")
    monkeypatch.setenv("FLY_MACHINE_ID", "1234567890abcd")
    monkeypatch.setenv("BENCHMARK_CONTEXT_DIR", str(tmp_path / "context"))

    async def acknowledged(pending):
        if path == "skipped":
            assert pending is None, "a credential skip never created an agent to acknowledge"
            assert not (tmp_path / "cloudbench-outcome-owned-token.pending.json").exists()
            assert result.status == result.benchmark_status == "SKIPPED" and result.passed is False
            events.append("publication-unneeded")
            return
        packet = json.loads((tmp_path / "cloudbench-outcome-owned-token.pending.json").read_text())
        assert pending and pending[1] == outcome_publication.digest(packet)
        assert packet["name"] == task.name and packet["status"] == ("passed" if result.passed else "failed")
        assert packet["run_id"] == "fixture-parent" and packet["run_token"] == "owned-token"
        assert packet["machine_id"] == "1234567890abcd" and packet["agent_id"] == ROOT
        events.append("publication-observed")

    def emit(*, force=False):
        token = asyncio.current_task()
        if token not in admitted:
            return
        assert force and admitted[token] is task and evaluated[token] is result
        events.append("evaluated-card")

    async def delegate(_base_url, actual_task, *, on_agent_created, on_task_evaluated, **kwargs):
        assert actual_task is task
        assert kwargs == {"keep_failed_agents": False}
        if path != "skipped":
            on_agent_created(task.name, ROOT)
        if path == "cancelled":
            raise asyncio.CancelledError
        if path == "raised":
            raise RuntimeError("delegate failed before evaluation")
        if path == "already-evaluated":
            await on_task_evaluated(result)
        events.append("delegate-complete")
        return returned

    monkeypatch.setattr(outcome_publication, "wait_for_publication", acknowledged)
    run_file = tmp_path / "saved-run.json"
    run_file.write_text("{}")
    run = SimpleNamespace(task_results=[], save=lambda: run_file)

    async def admitted_call(_task, call):
        return await call()

    async def finalizer(_base_url, results, roots, **kwargs):
        assert not admitted and not agents and roots == ({} if path == "skipped" else {task.name: [ROOT]})
        assert results == ([] if path in ("cancelled", "raised") else [returned])
        events.append("batch-finalize")

    async def stop_collector():
        return 0

    namespace = {
        "asyncio": asyncio,
        "sys": bench.sys,
        "BenchmarkTask": bench.BenchmarkTask,
        "TaskResult": bench.TaskResult,
        "base_url": "http://fixture.invalid",
        "run_single_task": delegate,
        "_reads_base_trajectory_history": bench._reads_base_trajectory_history,
        "_prepare_base_trajectory_history": bench._prepare_base_trajectory_history,
        "_refuse_queued_after_interrupt": bench._refuse_queued_after_interrupt,
        "batch_started_at": bench.datetime.now(bench.timezone.utc),
        "cloud_batch_cleanup": SimpleNamespace(contract=lambda: (tmp_path / "contract.json", "owned-token")),
        "_task_root_custody": bench._task_root_custody,
        "_admitted_tasks": admitted,
        "_entered_task_futures": set(),
        "_never_admitted_results": [],
        "_admitted_agent_ids": agents,
        "_evaluated_task_results": evaluated,
        "_outcome_signatures": signatures,
        "_remember_live_agent": lambda name, aid: live_ids.setdefault(name, []).append(aid),
        "_emit_report": emit,
        "checkpoint_source_mode": False,
        "args": SimpleNamespace(parallel=False, keep_failed_agents=False),
        "tasks": [task],
        "run": run,
        "_run_with_sandbox_payment_lock": admitted_call,
        "stop_fly_log_collector": stop_collector,
        "realtime_started": False,
        "memory_gate_enabled": False,
        "owned_batch_cleanup": True,
        "_finalize_owned_cloud_batch": finalizer,
        "_complete_interrupt_cleanup": lambda: events.append("batch-closed"),
        "_live_task_agent_ids": live_ids,
        "_wmh_evidence": SimpleNamespace(finalize=lambda: None),
        "Path": Path,
        "os": os,
        "Any": bench.Any,
        "Callable": bench.Callable,
    }
    module = ast.fix_missing_locations(ast.Module(body=[wrapper, finalize_and_save, coordinator], type_ignores=[]))
    exec(compile(module, str(bench.__file__), "exec"), namespace)

    async def run_coordinator():
        started = asyncio.Event()
        stopped = asyncio.Event()

        async def report_ticker():
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()

        ticker = asyncio.create_task(report_ticker())
        namespace["_report_ticker_task"] = ticker
        await started.wait()
        try:
            return await namespace["_owning_coordinator"]()
        finally:
            coordinator_retired_ticker = ticker.done()
            if not coordinator_retired_ticker:
                ticker.cancel()
                await asyncio.gather(ticker, return_exceptions=True)
            assert coordinator_retired_ticker, "coordinator returned before retiring its ticker"
            assert ticker.cancelled() and stopped.is_set()

    if path in ("cancelled", "raised"):
        with pytest.raises(asyncio.CancelledError if path == "cancelled" else RuntimeError):
            asyncio.run(run_coordinator())
        assert events == ["batch-finalize", "batch-closed"] and not evaluated and not signatures
        assert not list(tmp_path.glob("*.pending.json"))
    else:
        asyncio.run(run_coordinator())
        assert run.task_results[0] is returned
        expected = ["evaluated-card", "publication-observed", "delegate-complete"]
        if path != "already-evaluated":
            expected = [
                "delegate-complete",
                "evaluated-card",
                "publication-unneeded" if path == "skipped" else "publication-observed",
            ]
        assert events == expected + ["batch-finalize", "batch-closed"]
        assert len(signatures) == (0 if path == "skipped" else 1)
    assert not admitted and not agents and not evaluated


def browser_rows(task="browser-one", *, attached=True):
    rows = [
        {
            "text": "started",
            "metadata": {"toolName": "spawn_browser_agent", "task_id": task, "action_type": "task_started"},
        },
        {
            "text": "complete",
            "metadata": {"toolName": "spawn_browser_agent", "task_id": task, "action_type": "task_complete"},
        },
    ]
    if attached:
        rows.append(
            {
                "text": "recording",
                "metadata": {
                    "toolName": "spawn_browser_agent",
                    "task_id": task,
                    "action_type": "recording",
                    "toolStatus": "FINISHED",
                    "recording_view_url": "https://recording.example/video",
                },
            }
        )
    return rows


def test_browser_without_recording_row_fails_durable_readiness():
    assert not bench._agent_messages_ready_for_durable_browser_evidence(browser_rows(attached=False))
    assert bench._agent_messages_ready_for_durable_browser_evidence(browser_rows())
    code = [
        {"metadata": {"task_id": "browser-one", "toolName": "spawn_claude_code_agent", "action_type": "task_complete"}}
    ]
    assert bench._agent_messages_ready_for_durable_browser_evidence(code)
    assert not bench._agent_messages_ready_for_durable_browser_evidence(code + browser_rows(attached=False))
    encoded = [{"metadata": json.dumps(row["metadata"])} for row in browser_rows()]
    assert bench._agent_messages_ready_for_durable_browser_evidence(encoded)


@async_case
async def test_final_archive_refreshes_normalized_child_transcripts():
    logs = {"messages": [{"message": "stale root"}], "tree": {CHILD: {"messages": [{"message": "stale child"}]}}}
    infos = [{"agent_id": ROOT}, {"agent_id": CHILD, "parent_agent_id": ROOT}]
    snapshots = {ROOT: {"messages": [{"text": "fresh root"}]}, CHILD: {"messages": browser_rows()}}

    async def fetch(_url, aid):
        return copy.deepcopy(snapshots[aid])

    with patch.object(bench, "get_agent_tree", AsyncMock(return_value=infos)), patch.object(bench, "get_agent", fetch):
        refreshed = await bench._refresh_browser_archive_snapshot(
            "http://localhost:1", ROOT, {"_benchmark": {"kept": True}}, logs, expected_agent_ids={ROOT, CHILD}
        )
    assert refreshed["_benchmark"] == {"kept": True}
    assert logs["messages"][0]["message"] == "fresh root"
    assert logs["tree"][CHILD]["messages"][-1]["message"] == "recording"
    assert logs["tree"][CHILD]["messages"][-1]["metadata"]["toolStatus"] == "FINISHED"


@async_case
async def test_large_archive_tree_does_not_overload_snapshot_reads():
    """A 51-agent paused tree must survive a bounded backend read capacity."""
    ids = [ROOT] + [f"00000000-0000-4000-8000-{i:012d}" for i in range(2, 52)]
    infos = [{"agent_id": aid, **({"parent_agent_id": ROOT} if aid != ROOT else {})} for aid in ids]
    active = 0
    completed = set()

    async def fetch(_url, aid):
        nonlocal active
        active += 1
        try:
            # Overloaded reads miss the same fixed archive deadline; increasing
            # that deadline or returning a partial tree cannot make this pass.
            await asyncio.sleep(1 if active > 8 else 0.005)
            completed.add(aid)
            return {"messages": [{"text": aid}]}
        finally:
            active -= 1

    logs = {}
    with patch.object(bench, "get_agent_tree", AsyncMock(return_value=infos)), patch.object(bench, "get_agent", fetch):
        await bench._refresh_browser_archive_snapshot(
            "http://localhost:1", ROOT, {}, logs, expected_agent_ids=set(ids), timeout_seconds=10
        )
    assert completed == set(ids)
    assert set(logs["tree"]) == set(ids)
    assert all(logs["tree"][aid]["messages"][0]["message"] == aid for aid in ids)
    assert active == 0


@async_case
async def test_archive_deadline_bounds_slow_fetch_and_rejects_incomplete_tree():
    async def slow_fetch(*_args):
        await asyncio.sleep(10)
        return {"messages": []}

    with (
        patch.object(bench, "get_agent_tree", AsyncMock(return_value=[{"agent_id": ROOT}])),
        patch.object(bench, "get_agent", slow_fetch),
    ):
        with pytest.raises(TimeoutError):
            await bench._refresh_browser_archive_snapshot("http://localhost:1", ROOT, {}, {}, timeout_seconds=0.01)
    with patch.object(bench, "get_agent_tree", AsyncMock(return_value=[{"agent_id": ROOT}])):
        with pytest.raises(RuntimeError, match="omitted"):
            await bench._refresh_browser_archive_snapshot(
                "http://localhost:1", ROOT, {}, {}, expected_agent_ids={ROOT, CHILD}
            )


@async_case
async def test_archive_does_not_accept_terminal_without_recording():
    with (
        patch.object(bench, "get_agent_tree", AsyncMock(return_value=[{"agent_id": ROOT}])),
        patch.object(bench, "get_agent", AsyncMock(return_value={"messages": browser_rows(attached=False)})),
    ):
        with pytest.raises(TimeoutError):
            await bench._refresh_browser_archive_snapshot("http://localhost:1", ROOT, {}, {}, timeout_seconds=0.01)


@async_case
async def test_archive_deadline_spent_during_readiness_is_a_timeout():
    from benchmarks import browser_zero_allocation

    real_receipts = browser_zero_allocation.preparation_cancelled_task_receipts

    def slow_receipts(messages, agent_id):
        time.sleep(0.6)
        return real_receipts(messages, agent_id)

    with (
        patch.object(bench, "get_agent_tree", AsyncMock(return_value=[{"agent_id": ROOT}])),
        patch.object(bench, "get_agent", AsyncMock(return_value={"messages": browser_rows(attached=False)})),
        patch.object(browser_zero_allocation, "preparation_cancelled_task_receipts", slow_receipts),
    ):
        with pytest.raises(TimeoutError, match="did not become terminal with attached recordings"):
            await bench._refresh_browser_archive_snapshot("http://localhost:1", ROOT, {}, {}, timeout_seconds=0.5)


@async_case
async def test_failed_archive_retains_last_observation_without_publishing_it():
    snapshots = {ROOT: {"messages": browser_rows(attached=False)}}
    logs = {"messages": [{"text": "pre-pause snapshot"}]}
    with (
        patch.object(bench, "get_agent_tree", AsyncMock(return_value=[{"agent_id": ROOT}])),
        patch.object(bench, "get_agent", AsyncMock(return_value=snapshots[ROOT])),
    ):
        with pytest.raises(TimeoutError):
            await bench._refresh_browser_archive_snapshot("http://localhost:1", ROOT, {}, logs, timeout_seconds=0.01)
    assert logs["browser_archive_observation"]["snapshots"] == snapshots
    assert logs["browser_archive_observation"]["ready"] is False
    assert logs["browser_archive_observation"]["observed_at"]
    assert logs["messages"] == [{"text": "pre-pause snapshot"}]


@async_case
async def test_owned_batch_defers_all_early_archive_paths():
    archive = AsyncMock(return_value="unexpected")
    with (
        patch.object(cleanup, "contract", return_value=(Path("/tmp/status"), "token")),
        patch.object(bench, "archive_agent_finalize", archive),
    ):
        for force in (False, True):
            ref, _ = await bench.finalize_archive_and_score_world_model(
                "http://localhost:1", ROOT, "fixture", force=force
            )
            assert ref is None
        assert not archive.called


def result(aid):
    return SimpleNamespace(
        agent_id=aid,
        name=aid,
        logs={},
        passed=False,
        benchmark_status="FAILED",
        status="PAUSED",
        failure_reason="test timeout",
    )


@async_case
async def test_owned_cleanup_compensates_a_mint_that_finishes_after_delete():
    """A browser receipt cannot retire a late HELD purchase with its database."""
    await _owned_payment_cleanup_case(refund_fails=False)


@async_case
async def test_owned_cleanup_rejects_unconfirmed_payment_compensation():
    await _owned_payment_cleanup_case(refund_fails=True)


async def _owned_payment_cleanup_case(*, refund_fails):
    events = []
    sealed = False
    payment = {
        "purchase_id": "00000000-0000-4000-8000-000000000003",
        "agent_id": ROOT,
        "status": "CHARGING",
        "card_id": None,
        "stripe_payment_intent_id": "pi_owned",
        "user_id": ROOT, "stripe_livemode": False, "stripe_customer_id": "cus_owned",
        "total_cents": 4396,
        "funding_status": "PENDING",
        "provider_transfer_id": None,
        "reclaim_provider_transfer_id": None,
    }

    def query(_url, aid, *, require_deleted=False):
        assert aid == ROOT
        if require_deleted:
            assert sealed
        return {
            "root_exists": True,
            "root_user_id": ROOT,
            "root_deleted": sealed,
            "unsealed_tree_agent_ids": [] if sealed else [ROOT],
            "tree_agent_ids": [ROOT],
            "browser_sessions": [],
            "purchase_cleanup": [copy.deepcopy(payment)],
        }

    async def delete(_url, aid):
        nonlocal sealed
        assert aid == ROOT
        sealed = True
        events.append("delete")
        # The provider request already started before cancellation. Its result
        # lands after the early ownership snapshot, just as in the live run.
        payment.update(
            status="HELD", card_id="owned-card", funding_status="FUNDED", provider_transfer_id="owned-transfer"
        )

    async def abandon(_url, aid):
        assert sealed and aid == ROOT
        events.append("compensate")
        if refund_fails:
            raise RuntimeError("exact refund unavailable")
        payment.update(status="VOIDED", funding_status="RECLAIMED", reclaim_provider_transfer_id="owned-transfer")
        return {}

    async def custody(_url, aid, **kwargs):
        assert aid == ROOT and kwargs == {"stripe_custody": True}
        return {"agentId": ROOT, "stripeCustody": [{
            "purchaseId": payment["purchase_id"], "userId": ROOT, "agentId": ROOT,
            "purchaseStatus": payment["status"], "paymentIntentId": "pi_owned", "customerId": "cus_owned",
            "livemode": False, "status": "canceled", "currency": "usd", "amountCents": 4396,
            "amountReceivedCents": 0, "amountCapturableCents": 0, "refundedCents": 0, "outcome": "unspent"}]}

    row = result(ROOT)
    with (
        patch.object(bench, "get_test_payment_lifecycle", custody),
        patch.object(cleanup, "exact_root_sessions", query),
        patch.object(cleanup.runpy, "run_path", return_value={"provider_request": lambda *_args: (204, "receipt")}),
        patch.object(bench, "pause_agent", AsyncMock(return_value=True)),
        patch.object(bench, "_refresh_browser_archive_snapshot", AsyncMock(return_value={"messages": []})),
        patch.object(bench, "finalize_archive_and_score_world_model", AsyncMock(return_value=("archive", {}))),
        patch.object(bench, "delete_agent", delete),
        patch.object(bench, "abandon_test_payment", abandon),
        patch.object(bench, "fetch_local_worker_logs", return_value=[]),
    ):
        if refund_fails:
            with pytest.raises(RuntimeError, match="refund unavailable"):
                await bench._finalize_owned_cloud_batch("http://localhost:1", [row], {})
            assert row.benchmark_status == "ERROR"
            assert row.logs["cloud_cleanup_evidence"]["errors"]
        else:
            await bench._finalize_owned_cloud_batch("http://localhost:1", [row], {})
            assert payment["status"] == "VOIDED"
            assert payment["funding_status"] == "RECLAIMED"
            assert row.logs["cloud_payment_cleanup"]["root_agent_id"] == ROOT
        assert events == ["delete", "compensate"]


@async_case
async def test_batch_continues_exact_cleanup_after_recording_or_delete_failure():
    for failure in ("recording", "delete", "pause", "query"):
        events = []

        async def pause(_url, aid):
            events.append(("pause", aid))
            return not (failure == "pause" and aid == ROOT)

        def query(_url, aid, *, require_deleted=False):
            events.append(("query", aid))
            if failure == "query" and aid == ROOT:
                raise RuntimeError("database unavailable")
            if require_deleted:
                assert ("delete", aid) in events
            return {"root_user_id": ROOT, "tree_agent_ids": [aid], "browser_sessions": [], "purchase_cleanup": []}

        async def snapshot(_url, aid, _data, logs, **_kwargs):
            events.append(("snapshot", aid))
            if failure == "recording" and aid == ROOT:
                raise RuntimeError("recording absent")
            logs["messages"] = [{"message": "terminal"}]
            return {"messages": [{}]}

        async def archive(_url, aid, _name, **kwargs):
            assert kwargs["owned_batch_final"] is True
            events.append(("archive", aid))
            return "archive-ref", {}

        async def delete(_url, aid):
            events.append(("delete", aid))
            if failure == "delete" and aid == ROOT:
                raise RuntimeError("delete failed")

        def close(_url, aid, _before, **_kwargs):
            events.append(("release", aid))
            return {"root_agent_id": aid}

        results = [result(ROOT), result(CHILD)]
        with (
            patch.object(bench, "pause_agent", pause),
            patch.object(cleanup, "exact_root_sessions", query),
            patch.object(bench, "_refresh_browser_archive_snapshot", snapshot),
            patch.object(bench, "finalize_archive_and_score_world_model", archive),
            patch.object(bench, "delete_agent", delete),
            patch.object(cleanup, "close_exact_root_sessions", close),
        ):
            if failure in ("recording", "pause"):
                await bench._finalize_owned_cloud_batch("http://localhost:1", results, {})
                assert results[0].benchmark_status == "FAILED"
                assert results[0].failure_reason == "test timeout"
                assert results[0].logs["cloud_cleanup_evidence"]["warnings"]
                assert results[0].logs["cloud_cleanup_evidence"]["errors"] == []
            else:
                with pytest.raises(RuntimeError):
                    await bench._finalize_owned_cloud_batch("http://localhost:1", results, {})
        pauses = [("pause", ROOT)] if failure != "query" else []
        pauses.append(("pause", CHILD))
        assert [event for event in events if event[0] == "pause"] == pauses
        assert max(events.index(event) for event in pauses) < events.index(("snapshot", CHILD))
        assert (
            events.index(("snapshot", CHILD))
            < events.index(("archive", CHILD))
            < events.index(("delete", CHILD))
            < events.index(("release", CHILD))
        )
        if failure == "recording":
            assert ("delete", ROOT) in events and ("release", ROOT) in events
            assert ("archive", ROOT) not in events


@async_case
async def test_missing_create_response_never_proves_zero_allocation():
    for results in ([], [result("")]):
        with pytest.raises(RuntimeError, match="(unknown root|no proven root)"):
            await bench._finalize_owned_cloud_batch("http://localhost:1", results, {})


@async_case
async def test_rootless_sms_requires_its_own_completed_cleanup_receipt():
    row = result("")
    row.stop_metadata = {"runner": "sms", "owned_cleanup_verified": True}
    await bench._finalize_owned_cloud_batch("http://localhost:1", [row], {})
    row.stop_metadata = {"runner": "sms"}
    with pytest.raises(RuntimeError, match="unknown root creation outcome"):
        await bench._finalize_owned_cloud_batch("http://localhost:1", [row], {})


@async_case
async def test_composite_result_finalizes_each_exact_root_without_changing_verdict():
    """A prerequisite gate and its task are two roots of one benchmark record."""
    row = result(f"{ROOT},{CHILD}")
    row.name = "minted-agent-accounts-x"
    row.logs = {
        "auth_bundle_biometrics": {"worker_logs": [json.dumps({"agent_id": ROOT})]},
        "post": {"worker_logs": [json.dumps({"agent_id": CHILD})]},
        "worker_logs": [],
    }
    events = []

    def query(_url, aid, *, require_deleted=False):
        assert aid in {ROOT, CHILD}
        events.append(("query", aid))
        return {"root_user_id": ROOT, "tree_agent_ids": [aid], "browser_sessions": [], "purchase_cleanup": []}

    async def pause(_url, aid):
        events.append(("pause", aid))
        return True

    async def snapshot(_url, aid, _data, logs, **_kwargs):
        events.append(("snapshot", aid))
        logs["tree"] = {aid: {"parent_agent_id": None}}
        return {"messages": []}

    async def archive(_url, aid, _task, **_kwargs):
        events.append(("archive", aid))
        return f"archive-{aid}", {}

    async def delete(_url, aid):
        events.append(("delete", aid))

    def close(_url, aid, _before, **_kwargs):
        events.append(("provider", aid))
        return {"root_agent_id": aid, "root_deleted": True}

    async def payments(_url, aid, _evidence):
        events.append(("payment", aid))
        return {"root_agent_id": aid, "purchases": []}

    with (
        patch.object(cleanup, "exact_root_sessions", query),
        patch.object(bench, "pause_agent", pause),
        patch.object(bench, "_refresh_browser_archive_snapshot", snapshot),
        patch.object(bench, "finalize_archive_and_score_world_model", archive),
        patch.object(bench, "delete_agent", delete),
        patch.object(cleanup, "close_exact_root_sessions", close),
        patch.object(bench, "_finalize_owned_root_payments", payments),
    ):
        await bench._finalize_owned_cloud_batch("http://localhost:1", [row], {})

    for aid, key in ((ROOT, "auth_bundle_biometrics"), (CHILD, "post")):
        assert ("pause", aid) in events
        assert ("archive", aid) in events
        assert ("delete", aid) in events
        assert ("provider", aid) in events
        assert ("payment", aid) in events
        assert row.logs[key]["cloud_cleanup_evidence"]["root_agent_id"] == aid
        assert row.logs[key]["cloud_provider_cleanup"]["root_agent_id"] == aid
        assert row.logs[key]["cloud_payment_cleanup"]["root_agent_id"] == aid
    assert row.logs["post"]["cloud_archive_manifest_ref"] == f"archive-{CHILD}"
    assert row.agent_id == f"{ROOT},{CHILD}"
    assert row.benchmark_status == "FAILED" and row.passed is False


@async_case
async def test_minted_dispatch_preserves_live_root_observer_for_interrupt_cleanup():
    task = bench.get_task_by_name("minted-agent-accounts-x")
    observed = []

    async def composite(_url, _task, _keep_failed, *, on_agent_created):
        on_agent_created("gate-stage", ROOT)
        on_agent_created("post-stage", CHILD)
        return result(f"{ROOT},{CHILD}")

    with (
        patch.object(bench, "run_minted_agent_account_task", composite),
        patch.dict(os.environ, {"BENCHMARK_WORLD_MODEL_MODE": "real"}),
    ):
        outcome = await bench.run_single_task(
            "http://localhost:1",
            task,
            on_agent_created=lambda name, aid: observed.append((name, aid)),
        )
    assert observed == [("gate-stage", ROOT), ("post-stage", CHILD)]
    assert outcome.world_model_mode == "real"


def test_provider_cleanup_rejects_drift_and_requires_sealed_descendants():
    before = {
        "root_exists": True,
        "root_deleted": False,
        "unsealed_tree_agent_ids": [ROOT],
        "tree_agent_ids": [ROOT],
        "browser_sessions": [{"agent_id": ROOT, "provider": "kernel", "session_id": "session123"}],
    }
    after = {**before, "root_deleted": True, "unsealed_tree_agent_ids": []}
    drift = {
        **after,
        "browser_sessions": after["browser_sessions"]
        + [{"agent_id": ROOT, "provider": "kernel", "session_id": "late12345"}],
    }
    releases = []

    def release(provider, sid, _paths):
        releases.append((provider, sid))
        return 404, "receipt-digest"

    with (
        patch.object(cleanup, "exact_root_sessions", side_effect=[after, drift]),
        patch.object(cleanup.runpy, "run_path", return_value={"provider_request": release}),
    ):
        with pytest.raises(RuntimeError, match="changed"):
            cleanup.close_exact_root_sessions("http://localhost:1", ROOT, before)
    assert releases == [("kernel", "session123")]
    with (
        patch.object(cleanup, "exact_root_sessions", side_effect=RuntimeError("unsealed child")),
        patch.object(cleanup.runpy, "run_path") as load_provider,
    ):
        with pytest.raises(RuntimeError, match="unsealed"):
            cleanup.close_exact_root_sessions("http://localhost:1", ROOT, before)
        load_provider.assert_not_called()


def test_exact_database_proof_rejects_live_child_and_foreign_stack():
    import os
    import runpy

    recovery = runpy.run_path(str(cleanup.REPO_ROOT / "scripts/cloudbench-guest-recovery.py"))
    with tempfile.TemporaryDirectory() as directory:
        context = Path(directory)
        manifest = {
            "worktree": str(cleanup.REPO_ROOT),
            "benchmark_mode": True,
            "status": "running",
            "temporal_task_queue": "owned-queue",
            "ports": {"backend": 31001},
            "database": {"name": "owned_fixture", "port": 31006},
        }
        (context / "services.json").write_text(json.dumps(manifest))
        payload = {
            "root_exists": True,
            "root_user_id": ROOT,
            "root_deleted": True,
            "unsealed_tree_agent_ids": [CHILD],
            "tree_agent_ids": [ROOT, CHILD],
            "browser_sessions": [],
            "purchase_cleanup": [],
        }

        def query(_command, **kwargs):
            assert kwargs["database"] == "owned_fixture" and kwargs["port"] == 31006
            assert ROOT in kwargs["sql"] and "unsealed_tree_agent_ids" in kwargs["sql"]
            return json.dumps(payload)

        recovery["run_exact_psql"] = query
        environment = {
            "BENCHMARK_CLOUD_BATCH_CLEANUP": "true",
            "BENCHMARK_ISOLATED_RUN": "true",
            "BENCHMARK_INTERRUPT_CLEANUP_TOKEN": "owned-token",
            "BENCHMARK_INTERRUPT_CLEANUP_STATUS_FILE": str(context / "status"),
            "BENCHMARK_CONTEXT_DIR": directory,
            "TEMPORAL_TASK_QUEUE": "owned-queue",
        }
        with patch.dict(os.environ, environment), patch.object(cleanup.runpy, "run_path", return_value=recovery):
            with pytest.raises(RuntimeError, match="incomplete"):
                cleanup.exact_root_sessions("http://localhost:31001", ROOT, require_deleted=True)
            payload["unsealed_tree_agent_ids"] = []
            assert cleanup.exact_root_sessions("http://localhost:31001", ROOT, require_deleted=True) == payload
            for invalid_owner in (None, "", 42, "not-a-user-id"):
                payload["root_user_id"] = invalid_owner
                with pytest.raises(RuntimeError, match="incomplete"):
                    cleanup.exact_root_sessions("http://localhost:31001", ROOT, require_deleted=True)
            payload["root_user_id"] = ROOT
            with pytest.raises(RuntimeError, match="not the owned local stack"):
                cleanup.exact_root_sessions("https://production.example", ROOT)
            # T114: a stack that went down mid-finalization says so, not "foreign database".
            for stopped in ("stopped", "failed"):
                (context / "services.json").write_text(json.dumps({**manifest, "status": stopped}))
                with pytest.raises(RuntimeError, match=f"owned local stack is {stopped} before provider verification"):
                    cleanup.exact_root_sessions("http://localhost:31001", ROOT)
            (context / "services.json").write_text(json.dumps(manifest))
            payload["purchase_cleanup"] = None
            # Broken payment evidence must fail its own retirement contract
            # without hiding independently valid browser release authority.
            assert cleanup.exact_root_sessions("http://localhost:31001", ROOT, require_deleted=True) == payload
            with pytest.raises(RuntimeError, match="payment evidence"):
                cleanup.pending_root_payments(payload)


def test_exact_database_proof_recognises_tilion_rows_and_releases_them_by_exact_id():
    """Tilion is one shared account: only this tree's exact DB rows authorize release."""
    import os
    import runpy

    recovery = runpy.run_path(str(cleanup.REPO_ROOT / "scripts/cloudbench-guest-recovery.py"))
    with tempfile.TemporaryDirectory() as directory:
        context = Path(directory)
        (context / "services.json").write_text(json.dumps({
            "worktree": str(cleanup.REPO_ROOT),
            "benchmark_mode": True,
            "status": "running",
            "temporal_task_queue": "owned-queue",
            "ports": {"backend": 31001},
            "database": {"name": "owned_fixture", "port": 31006},
        }))
        tilion_row = {"agent_id": CHILD, "provider": "tilion",
                      "session_id": "sess_3d245e56b86d4bc8ae32095b644117d4"}
        payload = {
            "root_exists": True,
            "root_user_id": ROOT,
            "root_deleted": True,
            "unsealed_tree_agent_ids": [],
            "tree_agent_ids": [ROOT, CHILD],
            "browser_sessions": [tilion_row],
            "purchase_cleanup": [],
        }
        recovery["run_exact_psql"] = lambda _command, **_kwargs: json.dumps(payload)
        environment = {
            "BENCHMARK_CLOUD_BATCH_CLEANUP": "true",
            "BENCHMARK_ISOLATED_RUN": "true",
            "BENCHMARK_INTERRUPT_CLEANUP_TOKEN": "owned-token",
            "BENCHMARK_INTERRUPT_CLEANUP_STATUS_FILE": str(context / "status"),
            "BENCHMARK_CONTEXT_DIR": directory,
            "TEMPORAL_TASK_QUEUE": "owned-queue",
        }
        with patch.dict(os.environ, environment), patch.object(cleanup.runpy, "run_path", return_value=recovery):
            assert cleanup.exact_root_sessions("http://localhost:31001", ROOT, require_deleted=True) == payload
            payload["browser_sessions"] = [{**tilion_row, "provider": "browserbase"}]
            with pytest.raises(RuntimeError, match="unrecognized provider"):
                cleanup.exact_root_sessions("http://localhost:31001", ROOT, require_deleted=True)

    sealed = {**payload, "browser_sessions": [tilion_row]}
    calls = []

    def release(provider, sid, _paths):
        calls.append((provider, sid))
        return 410, "digest"

    with (
        patch.object(cleanup, "exact_root_sessions", return_value=sealed),
        patch.object(cleanup.runpy, "run_path", return_value={"provider_request": release}),
    ):
        result = cleanup.close_exact_root_sessions("http://localhost:1", ROOT, sealed)
    assert calls == [("tilion", tilion_row["session_id"])]
    assert result["provider_receipts"] == [{
        "provider": "tilion", "session_id": tilion_row["session_id"],
        "status": 410, "response_sha256": "digest",
    }]


def test_preparation_cancellation_receipt_accepts_tilion_and_rejects_unknown_providers():
    from benchmarks import browser_zero_allocation

    def receipts_for(provider):
        receipt = {
            "version": 1, "agent_id": ROOT, "task_id": CHILD, "tool_call_id": "call-prep",
            "session_id": "sess_3d245e56b86d4bc8ae32095b644117d4", "provider": provider,
            "phase": "initial_session_preparation", "init_acknowledged": True,
            "task_actions_started": False,
        }
        meta = {
            "toolName": "spawn_browser_agent", "action_type": "task_complete",
            "toolStatus": "FINISHED", "task_id": CHILD, "toolCallId": "call-prep",
            "excludeFromModel": True, "browser_preparation_cancellation": receipt,
        }
        return browser_zero_allocation.preparation_cancelled_task_receipts([{"metadata": meta}], ROOT)

    assert set(receipts_for("tilion")) == {CHILD}
    assert receipts_for("browserbase") == {}


def _postgres_binary(name):
    import glob
    import shutil

    found = shutil.which(name) or next(iter(sorted(
        glob.glob(f"/usr/lib/postgresql/*/bin/{name}") + glob.glob(f"/opt/homebrew/opt/postgresql@*/bin/{name}"),
        reverse=True,
    )), None)
    assert found, f"{name} is required: the exact tree query must run against real Postgres rows"
    return found


def test_exact_tree_query_excludes_unmaterialized_logical_browsers_on_real_postgres():
    """Every agent owns a logical BrowserSession row (sessionId NULL) until a
    provider session exists. The owned-cloud finalizer must not reject such a
    tree, and must still validate every row that does hold a provider session."""
    import socket
    import subprocess

    migration = (
        cleanup.REPO_ROOT
        / "back-end/prisma/migrations/20261021180000_browser_logical_identity_verified_credentials/migration.sql"
    ).read_text()
    logical_identity_ddl = migration.split('ALTER TABLE "BrowserSiteState"', 1)[0]
    recovery = __import__("runpy").run_path(str(cleanup.REPO_ROOT / "scripts/cloudbench-guest-recovery.py"))
    with tempfile.TemporaryDirectory() as directory:
        data, sockets = Path(directory) / "data", Path(directory) / "sockets"
        sockets.mkdir()
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        subprocess.run([_postgres_binary("initdb"), "-D", str(data), "-U", "postgres", "--auth=trust", "-E", "UTF8"],
                       check=True, capture_output=True)
        server = [_postgres_binary("pg_ctl"), "-D", str(data), "-w", "-s"]
        # The daemon must not inherit captured pipes, or run() waits for their EOF forever.
        subprocess.run(server + ["-l", str(Path(directory) / "server.log"),
                                 "-o", f"-p {port} -k {sockets} -c listen_addresses=localhost", "start"],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
        try:
            def sql(statement, database="postgres"):
                return subprocess.run(
                    [_postgres_binary("psql"), "-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", "localhost", "-p", str(port),
                     "-U", "postgres", "-d", database, "-c", statement],
                    capture_output=True, text=True, timeout=30,
                )
            assert sql("CREATE DATABASE owned_fixture").returncode == 0
            # The pre-migration table as main defines it, then the branch's real
            # logical-identity migration bytes (nullable sessionId + constraints).
            setup = sql(
                """
                CREATE TYPE "BrowserSessionStatus" AS ENUM ('ACTIVE', 'CLOSED', 'ERROR', 'PAUSED');
                CREATE TABLE "Agent" (id TEXT PRIMARY KEY, "userId" TEXT NOT NULL,
                  "parentAgentId" TEXT, "deletedAt" TIMESTAMP(3));
                CREATE TABLE "BrowserSession" (id TEXT PRIMARY KEY, "contextId" TEXT NOT NULL,
                  "agentId" TEXT NOT NULL, "sessionId" TEXT NOT NULL UNIQUE,
                  status "BrowserSessionStatus" NOT NULL DEFAULT 'ACTIVE', provider TEXT NOT NULL DEFAULT 'steel');
                CREATE TABLE "PurchaseSpend" (id TEXT PRIMARY KEY, "agentId" TEXT, status TEXT, "cardId" TEXT,
                  "stripePaymentIntentId" TEXT, "totalCents" INTEGER, "userId" TEXT NOT NULL,
                  "stripeLivemode" BOOLEAN NOT NULL, "stripeCustomerId" TEXT);
                CREATE TABLE "PurchaseWalletFunding" ("purchaseId" TEXT, status TEXT, "providerTransferId" TEXT,
                  "reclaimProviderTransferId" TEXT);
                """ + logical_identity_ddl,
                "owned_fixture",
            )
            assert setup.returncode == 0, setup.stderr
            # Agent creation's unmaterialized logical browsers (createLogicalBrowserInTransaction)
            # plus one child that did materialize a Kernel session.
            inserted = sql(
                f"""
                INSERT INTO "Agent" VALUES ('{ROOT}', '{ROOT}', NULL, NULL), ('{CHILD}', '{ROOT}', '{ROOT}', NULL);
                INSERT INTO "BrowserSession" (id, "contextId", "agentId", "sessionId", status, provider,
                  "logicalOwnerKey", "baselineCheckpointRef") VALUES
                  ('logical-root', 'context', '{ROOT}', NULL, 'PAUSED', 'kernel', 'agent:{ROOT}', 'empty-baseline'),
                  ('logical-child', 'context', '{CHILD}', NULL, 'PAUSED', 'kernel', 'agent:{CHILD}', 'empty-baseline');
                """,
                "owned_fixture",
            )
            assert inserted.returncode == 0, inserted.stderr
            purchase_id = "00000000-0000-4000-8000-000000000003"
            billing = sql(
                f"""INSERT INTO "PurchaseSpend" (id, "agentId", status, "stripePaymentIntentId", "totalCents",
                     "userId", "stripeLivemode", "stripeCustomerId")
                    VALUES ('{purchase_id}', '{ROOT}', 'FAILED', 'pi_initial_fixture', 4396,
                            '{ROOT}', false, 'cus_owned_fixture')""", "owned_fixture")
            assert billing.returncode == 0, billing.stderr
            # The schema itself guarantees a NULL-session row is only an unmaterialized logical identity.
            orphan = sql(
                f"""INSERT INTO "BrowserSession" (id, "contextId", "agentId", "sessionId", status, provider)
                VALUES ('orphan', 'context', '{ROOT}', NULL, 'ACTIVE', 'kernel')""",
                "owned_fixture",
            )
            assert orphan.returncode != 0 and "BrowserSession_unmaterialized_check" in orphan.stderr

            context = Path(directory) / "context"
            context.mkdir()
            (context / "services.json").write_text(json.dumps({
                "worktree": str(cleanup.REPO_ROOT), "benchmark_mode": True, "status": "running",
                "temporal_task_queue": "owned-queue", "ports": {"backend": 31001},
                "database": {"name": "owned_fixture", "port": port},
            }))
            environment = {
                "BENCHMARK_CLOUD_BATCH_CLEANUP": "true", "BENCHMARK_ISOLATED_RUN": "true",
                "BENCHMARK_INTERRUPT_CLEANUP_TOKEN": "owned-token",
                "BENCHMARK_INTERRUPT_CLEANUP_STATUS_FILE": str(context / "status"),
                "BENCHMARK_CONTEXT_DIR": str(context), "TEMPORAL_TASK_QUEUE": "owned-queue",
                "PATH": str(Path(_postgres_binary("psql")).parent) + os.pathsep + os.environ.get("PATH", ""),
            }
            with patch.dict(os.environ, environment), patch.object(cleanup.runpy, "run_path", return_value=recovery):
                # A non-browser task: only unmaterialized logical rows, so no provider session to own.
                snapshot = cleanup.exact_root_sessions("http://localhost:31001", ROOT)
                assert snapshot["tree_agent_ids"] == sorted([ROOT, CHILD])
                assert snapshot["browser_sessions"] == []
                assert snapshot["purchase_cleanup"] == [{
                    "purchase_id": purchase_id, "agent_id": ROOT, "status": "FAILED", "card_id": None,
                    "stripe_payment_intent_id": "pi_initial_fixture", "user_id": ROOT,
                    "stripe_livemode": False, "stripe_customer_id": "cus_owned_fixture", "total_cents": 4396,
                    "funding_status": None, "provider_transfer_id": None, "reclaim_provider_transfer_id": None,
                }]
                # A materialized Kernel session is still returned and owned exactly.
                materialized = sql(
                    f"""UPDATE "BrowserSession" SET "sessionId" = 'kernel_session_0001', status = 'ACTIVE'
                    WHERE id = 'logical-child'""",
                    "owned_fixture",
                )
                assert materialized.returncode == 0, materialized.stderr
                assert cleanup.exact_root_sessions("http://localhost:31001", ROOT)["browser_sessions"] == [
                    {"agent_id": CHILD, "session_id": "kernel_session_0001", "provider": "kernel"}
                ]
                # A provider-backed row from an unknown provider is still refused.
                assert sql("""UPDATE "BrowserSession" SET provider = 'unknown-provider' WHERE id = 'logical-child'""",
                           "owned_fixture").returncode == 0
                with pytest.raises(RuntimeError, match="unrecognized provider session"):
                    cleanup.exact_root_sessions("http://localhost:31001", ROOT)
        finally:
            subprocess.run(server + ["-m", "immediate", "stop"], capture_output=True, timeout=60)


def test_provider_rejection_does_not_skip_other_sessions_in_same_root():
    sealed = {
        "root_exists": True,
        "root_deleted": True,
        "unsealed_tree_agent_ids": [],
        "tree_agent_ids": [ROOT],
        "browser_sessions": [
            {"agent_id": ROOT, "provider": "kernel", "session_id": "owned0001"},
            {"agent_id": ROOT, "provider": "kernel", "session_id": "owned0002"},
        ],
    }
    calls = []

    def release(provider, sid, _paths):
        calls.append((provider, sid))
        if sid == "owned0001":
            raise RuntimeError("HTTP 503")
        return 404, "digest"

    with (
        patch.object(cleanup, "exact_root_sessions", return_value=sealed) as verify,
        patch.object(cleanup.runpy, "run_path", return_value={"provider_request": release}),
    ):
        with pytest.raises(RuntimeError, match="HTTP 503"):
            cleanup.close_exact_root_sessions("http://localhost:1", ROOT, sealed)
    assert calls == [("kernel", "owned0001"), ("kernel", "owned0002")]
    assert verify.call_count == 2


def test_exact_provider_cleanup_identifies_client_without_accepting_forbidden():
    """Replay Steel's captured Cloudflare 1010 response at the real HTTP seam."""
    import hashlib
    import http.server
    import runpy
    import threading

    helper = runpy.run_path(str(cleanup.REPO_ROOT / "scripts/cloudbench-exact-session-cleanup.py"))
    requests = []
    forbidden = b"error code: 1010"
    released = b'{"success":true}'

    class Provider(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            requests.append((self.path, self.headers.get("User-Agent"), self.headers.get("Accept")))
            identified = bool(self.headers.get("User-Agent")) and not self.headers["User-Agent"].startswith(
                "Python-urllib/"
            )
            accepted = (
                identified and self.headers.get("Accept") == "application/json" and "denied-session" not in self.path
            )
            payload = released if accepted else forbidden
            self.send_response(200 if accepted else 403)
            self.send_header("Content-Type", "application/json" if accepted else "text/plain")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with patch.dict(
            "os.environ", {"STEEL_API_KEY": "fixture-key", "STEEL_BASE_URL": f"http://127.0.0.1:{server.server_port}"}
        ):
            status, digest = helper["provider_request"]("steel", "owned-session", ())
            assert status == 200 and digest == hashlib.sha256(released).hexdigest()
            with pytest.raises(helper["CleanupEvidenceError"], match="HTTP 403"):
                helper["provider_request"]("steel", "denied-session", ())
        assert len(requests) == 2
        assert requests[0][0] == "/v1/sessions/owned-session/release"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=10)
        assert not thread.is_alive()


@async_case
async def test_failed_batch_retains_ownership_and_each_failure_cause():
    before = {
        "root_user_id": ROOT,
        "tree_agent_ids": [ROOT],
        "browser_sessions": [{"agent_id": ROOT, "provider": "steel", "session_id": "owned-session"}],
        "purchase_cleanup": [],
    }
    row = result(ROOT)
    with (
        patch.object(bench, "pause_agent", AsyncMock(return_value=True)),
        patch.object(cleanup, "exact_root_sessions", return_value=before),
        patch.object(bench, "_refresh_browser_archive_snapshot", AsyncMock(side_effect=TimeoutError())),
        patch.object(bench, "delete_agent", AsyncMock()),
        patch.object(cleanup, "close_exact_root_sessions", side_effect=RuntimeError("HTTP 403")),
    ):
        with pytest.raises(RuntimeError):
            await bench._finalize_owned_cloud_batch("http://localhost:1", [row], {})
    evidence = row.logs["cloud_cleanup_evidence"]
    assert evidence["before"] == before
    assert evidence["warnings"] == ["archive: TimeoutError"]
    assert evidence["errors"] == ["provider: HTTP 403"]
    assert "HTTP 403" in row.failure_reason
    assert "cloud_provider_cleanup" not in row.logs


@async_case
async def test_archive_warning_preserves_terminal_result_and_exact_cleanup():
    before = {"root_user_id": CHILD, "tree_agent_ids": [ROOT], "browser_sessions": [], "purchase_cleanup": []}
    for terminal in ("PASSED", "FAILED"):
        for fault in ("timeout", "missing_manifest"):
            row = result(ROOT)
            row.passed = terminal == "PASSED"
            row.benchmark_status = terminal
            row.failure_reason = None if row.passed else "execution window elapsed"
            verdict = (row.passed, row.benchmark_status, row.failure_reason)
            release = {"root_agent_id": ROOT, "tree_sealed": True, "root_deleted": True}
            payment = {"root_agent_id": ROOT, "purchases": []}
            with (
                patch.object(bench, "pause_agent", AsyncMock(return_value=True)),
                patch.object(cleanup, "exact_root_sessions", return_value=before),
                patch.object(
                    bench,
                    "_refresh_browser_archive_snapshot",
                    AsyncMock(
                        side_effect=TimeoutError() if fault == "timeout" else None,
                        return_value={"messages": []},
                    ),
                ),
                patch.object(bench, "finalize_archive_and_score_world_model", AsyncMock(return_value=(None, None))),
                patch.object(bench, "delete_agent", AsyncMock()) as delete,
                patch.object(cleanup, "close_exact_root_sessions", return_value=release) as close,
                patch.object(bench, "_finalize_owned_root_payments", AsyncMock(return_value=payment)) as compensate,
                patch.object(bench, "fetch_local_worker_logs", return_value=["late cleanup diagnostic"]),
            ):
                await bench._finalize_owned_cloud_batch("http://localhost:1", [row], {})
            assert (row.passed, row.benchmark_status, row.failure_reason) == verdict
            evidence = row.logs["cloud_cleanup_evidence"]
            assert evidence["errors"] == []
            assert len(evidence["warnings"]) == 1 and evidence["warnings"][0].startswith("archive:")
            delete.assert_awaited_once_with("http://localhost:1", ROOT)
            close.assert_called_once_with("http://localhost:1", ROOT, before, evidence=evidence)
            compensate.assert_awaited_once_with("http://localhost:1", ROOT, evidence)
            assert row.logs["cloud_provider_cleanup"] == release
            assert row.logs["cloud_payment_cleanup"] == payment
            assert "late cleanup diagnostic" in row.logs["worker_logs"]


@async_case
async def test_missing_terminal_result_stays_hard_after_successful_cleanup():
    before = {"root_user_id": ROOT, "tree_agent_ids": [ROOT], "browser_sessions": [], "purchase_cleanup": []}
    with (
        patch.object(bench, "pause_agent", AsyncMock(return_value=True)),
        patch.object(cleanup, "exact_root_sessions", return_value=before),
        patch.object(bench, "_refresh_browser_archive_snapshot", AsyncMock(return_value={"messages": []})),
        patch.object(bench, "delete_agent", AsyncMock()) as delete,
        patch.object(cleanup, "close_exact_root_sessions", return_value={"root_agent_id": ROOT}) as close,
        patch.object(bench, "_finalize_owned_root_payments", AsyncMock(return_value={"root_agent_id": ROOT})),
    ):
        with pytest.raises(RuntimeError, match="did not produce a task result"):
            await bench._finalize_owned_cloud_batch("http://localhost:1", [], {"task": [ROOT]})
    delete.assert_awaited_once_with("http://localhost:1", ROOT)
    assert close.call_count == 1


@async_case
async def test_multi_browser_archive_keeps_root_until_recordings_are_ready():
    sessions = [{"agent_id": ROOT, "provider": "kernel", "session_id": f"owned-{index}"} for index in range(4)]
    before = {
        "root_user_id": ROOT,
        "tree_agent_ids": [ROOT],
        "browser_sessions": sessions,
        "purchase_cleanup": [],
    }
    row = result(ROOT)
    delete = AsyncMock()

    async def archive_snapshot(_base, _agent, _data, _logs, **kwargs):
        # Four replay stop/read cycles outlasted the former 60s fixed bound in
        # a real cloud guest. The root must remain writable until they land.
        assert kwargs["timeout_seconds"] == 180.0
        assert not delete.called
        return {"messages": browser_rows()}

    with (
        patch.object(bench, "pause_agent", AsyncMock(return_value=True)),
        patch.object(cleanup, "exact_root_sessions", return_value=before),
        patch.object(bench, "_refresh_browser_archive_snapshot", archive_snapshot),
        patch.object(bench, "finalize_archive_and_score_world_model", AsyncMock(return_value=("r2://fixture", {}))),
        patch.object(bench, "delete_agent", delete),
        patch.object(cleanup, "close_exact_root_sessions", return_value={"root_agent_id": ROOT}),
    ):
        await bench._finalize_owned_cloud_batch("http://localhost:1", [row], {})

    delete.assert_awaited_once_with("http://localhost:1", ROOT)
    assert row.logs["cloud_cleanup_evidence"]["errors"] == []


@async_case
async def test_failed_batch_retains_worker_logs_through_provider_release():
    before = {"root_user_id": ROOT, "tree_agent_ids": [ROOT], "browser_sessions": [], "purchase_cleanup": []}
    row = result(ROOT)
    row.logs = {"worker_logs": [f"{ROOT} before task result"]}
    with tempfile.TemporaryDirectory() as temporary:
        log_dir = Path(temporary) / "logs"
        log_dir.mkdir()
        late_line = f"{ROOT} recording cleanup after final archive observation"

        def close(*args, **kwargs):
            (log_dir / "worker.3.log").write_text(late_line + "\n")
            return {"root_agent_id": ROOT}

        with (
            patch.dict(os.environ, {"BENCHMARK_CONTEXT_DIR": temporary}),
            patch.object(bench, "pause_agent", AsyncMock(return_value=True)),
            patch.object(cleanup, "exact_root_sessions", return_value=before),
            patch.object(bench, "_refresh_browser_archive_snapshot", AsyncMock(side_effect=TimeoutError())),
            patch.object(bench, "delete_agent", AsyncMock()),
            patch.object(cleanup, "close_exact_root_sessions", close),
        ):
            await bench._finalize_owned_cloud_batch("http://localhost:1", [row], {})
        assert row.logs["worker_logs"] == [f"{ROOT} before task result", late_line]
        assert row.logs["cloud_cleanup_evidence"]["worker_logs_observed_at"]
        assert row.benchmark_status == "FAILED"
        assert row.logs["cloud_cleanup_evidence"]["warnings"] == ["archive: TimeoutError"]


@async_case
async def test_failed_batch_keeps_late_logs_after_prefix_cap():
    """A busy earlier worker must not hide cleanup from any later capture."""
    before = {"root_user_id": ROOT, "tree_agent_ids": [ROOT], "browser_sessions": [], "purchase_cleanup": []}
    for late_file in ("worker.0.log", "worker.3.log"):
        row = result(ROOT)
        prior = f"{ROOT} before task result"
        row.logs = {"worker_logs": [prior]}
        with tempfile.TemporaryDirectory() as temporary:
            log_dir = Path(temporary) / "logs"
            log_dir.mkdir()
            old = [
                json.dumps({"timestamp": "2026-09-11T01:00:00Z", "agent_id": ROOT, "event": f"old {index}"})
                for index in range(20000)
            ]
            (log_dir / "worker.1.log").write_text("\n".join(old) + "\n")
            late = json.dumps({"timestamp": "2026-09-11T02:00:00Z", "agent_id": ROOT, "event": "recording cleanup"})

            def close(*args, **kwargs):
                (log_dir / late_file).write_text(late + "\n")
                return {"root_agent_id": ROOT}

            with (
                patch.dict(os.environ, {"BENCHMARK_CONTEXT_DIR": temporary}),
                patch.object(bench, "pause_agent", AsyncMock(return_value=True)),
                patch.object(cleanup, "exact_root_sessions", return_value=before),
                patch.object(bench, "_refresh_browser_archive_snapshot", AsyncMock(side_effect=TimeoutError())),
                patch.object(bench, "delete_agent", AsyncMock()),
                patch.object(cleanup, "close_exact_root_sessions", close),
            ):
                await bench._finalize_owned_cloud_batch("http://localhost:1", [row], {})
            assert late in row.logs["worker_logs"], f"late cleanup omitted from {late_file}"
            assert prior in row.logs["worker_logs"]
            assert len(row.logs["worker_logs"]) == 20001
            assert row.benchmark_status == "FAILED"
            assert row.logs["cloud_cleanup_evidence"]["warnings"] == ["archive: TimeoutError"]


def test_latest_worker_logs_order_across_files_with_bounded_retention():
    from datetime import datetime, timezone

    from benchmarks import logs

    with tempfile.TemporaryDirectory() as temporary:
        first = Path(temporary) / "worker.0.log"
        second = Path(temporary) / "worker.1.log"
        recent = json.dumps({"timestamp": "2026-09-11T02:00:00Z", "agent_id": ROOT, "event": "recent"})
        old = json.dumps({"time": "2026-09-11T01:00:00", "agent_id": ROOT, "event": "old"})
        plain = f"{ROOT} unstructured cleanup"
        invalid = json.dumps({"timestamp": "invalid", "agent_id": ROOT})
        first.write_text(recent + "\n" + old + "\n")
        second.write_text(plain + "\n" + invalid + "\n" + "unrelated agent\n")
        modified = datetime(2026, 9, 11, 3, tzinfo=timezone.utc).timestamp()
        os.utime(second, (modified, modified))
        with patch.object(logs, "_local_worker_log_paths", return_value=[str(first), str(second)]):
            assert logs.fetch_local_worker_logs(ROOT, limit=2) == [recent, old]
            assert logs.fetch_local_worker_logs(ROOT, limit=3, newest=True) == [recent, plain, invalid]
            assert logs.fetch_local_worker_logs(ROOT, limit=1, newest=True) == [invalid]
            assert logs.fetch_local_worker_logs(ROOT, limit=0, newest=True) == []
            window = datetime(2026, 9, 11, 1, 30, tzinfo=timezone.utc)
            assert logs.fetch_local_worker_logs(ROOT, window, limit=4, newest=True) == [recent, plain, invalid]


def test_latest_worker_logs_stop_at_opening_file_size():
    from benchmarks import logs

    with tempfile.TemporaryDirectory() as temporary:
        path = Path(temporary) / "worker.log"
        initial = [f"{ROOT} initial café {index}" for index in range(5)]
        path.write_text("\n".join(initial) + "\n")
        mentions = logs._line_mentions_agent
        checks = 0

        def append_while_reading(line, agent_id):
            nonlocal checks
            checks += 1
            # A finite producer proves moving EOF without making the test hang.
            if checks <= 10:
                with path.open("a") as writer:
                    writer.write(f"{ROOT} appended cleanup {checks}\n")
            return mentions(line, agent_id)

        with (
            patch.object(logs, "_local_worker_log_paths", return_value=[str(path)]),
            patch.object(logs, "_line_mentions_agent", append_while_reading),
        ):
            captured = logs.fetch_local_worker_logs(ROOT, limit=3, newest=True)
        assert captured == initial[-3:]
        assert checks == len(initial), "reader chased a producer beyond its opening snapshot"
        assert "appended cleanup" in path.read_text()


def test_failed_release_retains_terminal_database_and_successful_provider_receipts():
    before = {
        "tree_agent_ids": [ROOT],
        "browser_sessions": [
            {"agent_id": ROOT, "provider": "kernel", "session_id": "owned-kernel"},
            {"agent_id": ROOT, "provider": "steel", "session_id": "owned-steel"},
        ],
    }
    after = {**before, "root_deleted": True, "unsealed_tree_agent_ids": []}
    evidence = {}

    def release(provider, _sid, _paths):
        if provider == "steel":
            raise RuntimeError("HTTP 403")
        return 404, "digest"

    with (
        patch.object(cleanup, "exact_root_sessions", return_value=after),
        patch.object(cleanup.runpy, "run_path", return_value={"provider_request": release}),
    ):
        with pytest.raises(RuntimeError, match="HTTP 403"):
            cleanup.close_exact_root_sessions("http://localhost:1", ROOT, before, evidence=evidence)
    assert evidence["before"] == before
    assert evidence["after"] == evidence["final"] == after
    assert evidence["provider_receipts"] == [
        {"provider": "kernel", "session_id": "owned-kernel", "status": 404, "response_sha256": "digest"}
    ]


def test_recovery_manifest_keeps_promoted_sessions_from_exact_database_evidence():
    import runpy

    helper = runpy.run_path(str(cleanup.REPO_ROOT / "scripts/cloudbench-exact-session-cleanup.py"))
    snapshot = {
        "root_exists": True,
        "tree_agent_ids": [ROOT, CHILD],
        "browser_sessions": [{"agent_id": CHILD, "provider": "steel", "session_id": "promoted-steel"}],
    }
    evidence = {"root_agent_id": ROOT, "before": snapshot}
    with tempfile.TemporaryDirectory() as directory:
        output = Path(directory).resolve()
        run = output / "run.json"
        backend = output / "backend.log"
        backend.write_text(f"root={ROOT}\nCreated Kernel browser session sessionId=original-kernel\n")
        args = SimpleNamespace(
            output_dir=str(output),
            owner="a" * 32,
            fleet_run_id="run-one",
            bench="task-one",
            machine_id="a123",
            guest_run_token="guest-one",
            run_json=str(run),
            backend_log=str(backend),
            quiescence_receipt=str(output / "quiescence.json"),
        )

        def publish(value):
            run.write_text(
                json.dumps(
                    {"tasks": [{"name": args.bench, "agent_id": ROOT, "logs": {"cloud_cleanup_evidence": value}}]}
                )
            )

        with patch.dict(
            helper["provider_manifest"].__globals__, {"validate_quiescence": lambda *_args: "quiescence-digest"}
        ):
            publish(evidence)
            manifest = helper["provider_manifest"](args)
            assert manifest["sessions"] == {"kernel": ["original-kernel"], "steel": ["promoted-steel"]}
            backend.write_text(f"root={ROOT}\n")
            assert helper["provider_manifest"](args)["sessions"] == {"kernel": [], "steel": ["promoted-steel"]}
            with pytest.raises(helper["CleanupEvidenceError"], match="recorded provider sessions"):
                helper["zero_provider_manifest"](args)
            backend.write_text(f"root={ROOT}\nCreated Kernel browser session sessionId=original-kernel\n")
            for bad in (
                None,
                {**evidence, "root_agent_id": CHILD},
                {**evidence, "before": {**snapshot, "tree_agent_ids": [ROOT]}},
                {
                    **evidence,
                    "before": {
                        **snapshot,
                        "browser_sessions": [
                            {"agent_id": CHILD, "provider": "unknown", "session_id": "promoted-steel"}
                        ],
                    },
                },
            ):
                publish(bad)
                with pytest.raises(helper["CleanupEvidenceError"]):
                    helper["provider_manifest"](args)


@async_case
async def test_deferred_cleanup_uses_exact_database_owner():
    import os
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    owners = {
        "00000000-0000-4000-8000-000000000001": bench.GATE_FIXTURE_TASK_USER_IDS["gate-kyc-card-mint"],
        "00000000-0000-4000-8000-000000000002": "00000000-0000-4000-8000-000000000104",
    }
    paused, deleted, requests = set(), set(), []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            aid = self.path.split("/")[-2]
            user = self.headers.get("X-User-Id")
            requests.append(("pause", aid, user))
            status = 200 if owners.get(aid) == user else 404
            if status == 200:
                paused.add(aid)
            body = json.dumps({"success": status == 200}).encode()
            self.send_response(status)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_DELETE(self):
            aid = self.path.split("/")[-1]
            requests.append(("delete", aid, self.headers.get("X-User-Id")))
            assert self.headers.get("X-User-Id") == owners[aid]
            deleted.add(aid)
            self.send_response(204)
            self.end_headers()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://localhost:{server.server_port}"

    def query(_url, aid, *, require_deleted=False):
        if require_deleted:
            assert aid in deleted
        return {"root_user_id": owners[aid], "tree_agent_ids": [aid], "browser_sessions": [], "purchase_cleanup": []}

    async def snapshot(_url, aid, _data, _logs, **_kwargs):
        assert aid in paused, "Owner-restricted pause failed before the recording barrier"
        assert bench._current_benchmark_user_id() == owners[aid]
        return {"messages": []}

    async def archive(_url, aid, _name, **_kwargs):
        assert bench._current_benchmark_user_id() == owners[aid]
        return "fixture-archive", None

    def close(_url, aid, _before, **_kwargs):
        return {"root_agent_id": aid, "root_deleted": True}

    async def run():
        results = [
            SimpleNamespace(
                agent_id=aid,
                name=aid,
                logs={},
                passed=True,
                benchmark_status="PASSED",
                status="ACTIVE",
                failure_reason=None,
            )
            for aid in owners
        ]
        await bench._finalize_owned_cloud_batch(base, results, {})
        assert all(r.passed for r in results)
        assert bench._current_benchmark_user_id() == bench.USER_ID
        assert os.environ["BENCHMARK_RUN_USER_ID"] == bench.USER_ID

    try:
        with (
            patch.dict(os.environ, {"BENCHMARK_RUN_USER_ID": bench.USER_ID, "NO_PROXY": "localhost,127.0.0.1"}),
            patch.object(bench, "API_KEY", "fixture-key"),
            patch.object(bench, "_auth_mode", "api_key"),
            patch.object(bench, "_cached_headers", None),
            patch.object(bench, "_cached_headers_user_id", None),
            patch.object(bench.cloud_batch_cleanup, "exact_root_sessions", query),
            patch.object(bench, "_refresh_browser_archive_snapshot", snapshot),
            patch.object(bench, "finalize_archive_and_score_world_model", archive),
            patch.object(bench.cloud_batch_cleanup, "close_exact_root_sessions", close),
        ):
            await run()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=10)
    assert requests == [("pause", aid, owner) for aid, owner in owners.items()] + [
        ("delete", aid, owner) for aid, owner in owners.items()
    ]


@async_case
async def test_cleanup_identity_isolated_and_reset_after_cancellation():
    import os
    from contextvars import ContextVar

    ambient = bench.USER_ID
    task_user = "00000000-0000-4000-8000-000000000105"
    fixture_owner = bench.GATE_FIXTURE_TASK_USER_IDS["gate-kyc-card-mint"]
    before = {"root_user_id": fixture_owner, "tree_agent_ids": [ROOT], "browser_sessions": [], "purchase_cleanup": []}
    entered, observed = asyncio.Event(), asyncio.Event()

    async def sibling():
        await entered.wait()
        assert bench._current_benchmark_user_id() == task_user
        assert os.environ["BENCHMARK_RUN_USER_ID"] == ambient

        observed.set()

    async def snapshot(*_args, **_kwargs):
        assert bench._current_benchmark_user_id() == fixture_owner
        entered.set()
        await observed.wait()
        raise asyncio.CancelledError()

    async def delete(*_args):
        assert bench._current_benchmark_user_id() == fixture_owner

    with (
        patch.dict(os.environ, {"BENCHMARK_RUN_USER_ID": ambient}),
        patch.object(bench, "_task_run_user_id", ContextVar("fixture_task_user", default=task_user)),
        patch.object(cleanup, "exact_root_sessions", return_value=before),
        patch.object(bench, "pause_agent", AsyncMock(return_value=True)),
        patch.object(bench, "_refresh_browser_archive_snapshot", snapshot),
        patch.object(bench, "delete_agent", delete),
        patch.object(cleanup, "close_exact_root_sessions", return_value={"root_agent_id": ROOT}),
    ):
        observer = asyncio.create_task(sibling())
        try:
            async with asyncio.timeout(10):
                with pytest.raises(asyncio.CancelledError):
                    await bench._finalize_owned_cloud_batch("http://localhost:1", [result(ROOT)], {})
                await observer
        finally:
            observer.cancel()
            await asyncio.gather(observer, return_exceptions=True)
        assert bench._current_benchmark_user_id() == task_user
        assert os.environ["BENCHMARK_RUN_USER_ID"] == ambient


@async_case
async def test_disconnected_delete_waits_for_exact_tree_seal_before_provider_release():
    """A timed-out DELETE can still be recursively sealing its fifty-child tree."""
    import httpx

    before = {
        "root_exists": True,
        "root_user_id": ROOT,
        "root_deleted": False,
        "tree_agent_ids": [ROOT, CHILD],
        "unsealed_tree_agent_ids": [ROOT, CHILD],
        "browser_sessions": [],
        "purchase_cleanup": [],
    }
    delete_started, seal_reads, sealed = False, 0, False

    def query(_url, aid, *, require_deleted=False):
        nonlocal seal_reads, sealed
        assert aid == ROOT
        if not delete_started:
            return copy.deepcopy(before)
        if not require_deleted:
            seal_reads += 1
            sealed = seal_reads >= 3
        if require_deleted and not sealed:
            raise RuntimeError("exact root database evidence is incomplete")
        return {**before, "root_deleted": True, "unsealed_tree_agent_ids": [] if sealed else [CHILD]}

    async def delete(*_args):
        nonlocal delete_started
        delete_started = True
        raise httpx.ReadTimeout("DELETE accepted, response not received")

    def release(_url, aid, _before, *, evidence):
        assert sealed, "provider authority cannot precede the exact deletion fence"
        assert aid == ROOT
        return {"root_agent_id": ROOT, "tree_sealed": True, "root_deleted": True, "provider_receipts": []}

    row = result(ROOT)
    with (
        patch.object(cleanup, "exact_root_sessions", query),
        patch.object(bench, "pause_agent", AsyncMock(return_value=True)),
        patch.object(bench, "_refresh_browser_archive_snapshot", AsyncMock(return_value={"messages": []})),
        patch.object(bench, "finalize_archive_and_score_world_model", AsyncMock(return_value=("archive", None))),
        patch.object(bench, "delete_agent", delete),
        patch.object(cleanup, "close_exact_root_sessions", release),
        patch.object(bench.asyncio, "sleep", AsyncMock()),
    ):
        await bench._finalize_owned_cloud_batch("http://localhost:1", [row], {})
    assert seal_reads == 3
    assert row.benchmark_status == "FAILED", "an ordinary task verdict must survive successful cleanup"
    assert row.logs["cloud_provider_cleanup"]["tree_sealed"] is True
    assert row.logs["cloud_cleanup_evidence"]["delete_transport_error"]


@async_case
async def test_disconnected_delete_seal_wait_rejects_owner_drift_and_has_a_deadline():
    before = {"root_user_id": ROOT, "tree_agent_ids": [ROOT, CHILD]}
    pending = {**before, "root_deleted": True, "unsealed_tree_agent_ids": [CHILD]}
    for snapshot in (
        {**pending, "root_user_id": CHILD},
        {**pending, "tree_agent_ids": [ROOT]},
        {**pending, "unsealed_tree_agent_ids": None},
    ):
        with patch.object(cleanup, "exact_root_sessions", return_value=snapshot):
            with pytest.raises(RuntimeError, match="identity or sealing evidence changed"):
                await bench._wait_for_owned_root_seal("http://localhost:1", ROOT, before, {}, timeout_seconds=1)
    evidence = {}
    with patch.object(cleanup, "exact_root_sessions", return_value=pending) as read:
        with pytest.raises(RuntimeError, match="cleanup deadline"):
            await bench._wait_for_owned_root_seal("http://localhost:1", ROOT, before, evidence, timeout_seconds=0.02)
    assert all(not call.kwargs.get("require_deleted") for call in read.call_args_list)
    assert evidence["delete_seal_observation"]["snapshot"]["unsealed_tree_agent_ids"] == [CHILD]


def test_native_world_retirement_retries_a_transient_unjoined_server_error(monkeypatch):
    """Run 7 (2026-10-20): the first native DELETE after the 600s timeout returned
    500 while ~90 cancelled predictions were still draining. The server keeps the
    session fenced and accepts a fresh retirement, so a server/transport failure is
    retried; a 4xx (unknown/foreign session) stays terminal."""
    import httpx

    def owned_task():
        task = copy.deepcopy(bench.get_task_by_name("parallel-tool-calls"))
        task._wmh_owned_session = {
            "base_url": "http://native.test",
            "model_name": "rose-test",
            "session_id": "owned",
            "root_agent_id": ROOT,
            "engine": "experiential",
        }
        return task

    receipt = {
        "ended": "owned",
        "engine": "experiential",
        "session_id": "owned",
        "session_scope_id": ROOT,
        "revision": 3,
        "state": {"raised": 0},
        "history": [],
        "usage": {"calls": 3},
        "join_verified": True,
    }
    url = "http://native.test/world_models/rose-test/sessions/owned"

    def status_error(code):
        request = httpx.Request("DELETE", url)
        return httpx.HTTPStatusError(f"{code}", request=request, response=httpx.Response(code, request=request))

    def client_for(outcomes, calls):
        class Client:
            def __init__(self, base):
                assert base == "http://native.test"

            async def end_session(self, model, session_id):
                calls.append((model, session_id))
                outcome = outcomes.pop(0)
                if isinstance(outcome, Exception):
                    raise outcome
                return outcome

        return Client

    sleeps = []

    async def no_sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr(bench, "_NATIVE_RETIREMENT_SLEEP", no_sleep, raising=False)

    calls = []
    monkeypatch.setattr(
        bench,
        "WMHHttpClient",
        client_for([status_error(500), httpx.ReadTimeout("slow", request=httpx.Request("DELETE", url)), receipt], calls),
    )
    task = owned_task()
    assert asyncio.run(bench._retire_owned_native_world(task, ROOT)) == receipt
    assert calls == [("rose-test", "owned")] * 3 and len(sleeps) == 2
    assert task._wmh_retirement_receipt == receipt and getattr(task, "_wmh_retirement_error", None) is None

    calls.clear()
    monkeypatch.setattr(bench, "WMHHttpClient", client_for([status_error(409)], calls))
    task = owned_task()
    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(bench._retire_owned_native_world(task, ROOT))
    assert calls == [("rose-test", "owned")] and task._wmh_retirement_error["join_verified"] is False

    calls.clear()
    attempts = getattr(bench, "_NATIVE_RETIREMENT_ATTEMPTS", 1)
    persistent = [status_error(500) for _ in range(attempts + 1)]
    monkeypatch.setattr(bench, "WMHHttpClient", client_for(persistent, calls))
    task = owned_task()
    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(bench._retire_owned_native_world(task, ROOT))
    assert len(calls) == attempts > 1
    assert task._wmh_retirement_error["cost_verified"] is False


@async_case
async def test_interrupt_during_archive_wait_keeps_run_record_and_exact_cleanup():
    """SIGINT during the diagnostic archive wait must not lose the evaluated run.

    polar70 (2026-10-19): a FAIL outcome was evaluated and Hub-acknowledged,
    then the owned-batch archive refresh waited for two browser activities
    that ignored pause. The guest watchdog interrupted it; the CancelledError
    skipped ``run.save()`` and the remaining roots' exact cleanup, and the
    interrupt receipt read ``failed`` although provider cleanup was verified.
    """
    for provider_fails in (False, True):
        events = []
        entered = asyncio.Event()
        rows = [result(ROOT), result(CHILD)]
        verdicts = [(row.passed, row.benchmark_status, row.failure_reason) for row in rows]

        def query(_url, aid, **_kwargs):
            return {"root_user_id": ROOT, "tree_agent_ids": [aid], "browser_sessions": [], "purchase_cleanup": []}

        async def snapshot(_url, aid, _data, _logs, **_kwargs):
            events.append(("snapshot", aid))
            entered.set()
            await asyncio.Event().wait()  # browser terminals never arrive

        async def delete(_url, aid):
            events.append(("delete", aid))

        def close(_url, aid, _before, **_kwargs):
            events.append(("release", aid))
            if provider_fails and aid == CHILD:
                raise RuntimeError("provider session still live")
            return {"root_agent_id": aid}

        async def payments(_url, aid, _evidence):
            events.append(("payments", aid))
            return {"root_agent_id": aid, "purchases": []}

        saved = []
        run = SimpleNamespace(task_results=rows, world_model_retrieval_audit=None)

        with tempfile.TemporaryDirectory() as temporary:
            status_file = Path(temporary) / "interrupt.status"
            record = Path(temporary) / "run-record.json"

            def save():
                saved.append([row.logs.get("cloud_cleanup_evidence") for row in rows])
                record.write_text("{}", encoding="utf-8")
                return str(record)

            run.save = save
            env = {
                "BENCHMARK_INTERRUPT_CLEANUP_STATUS_FILE": str(status_file),
                "BENCHMARK_INTERRUPT_CLEANUP_TOKEN": "polar70-token",
                "BENCHMARK_CONTEXT_DIR": temporary,
            }
            with (
                patch.dict(os.environ, env),
                patch.object(bench, "_INTERRUPT_CLEANUP_STARTED", 0),
                patch.object(bench, "_INTERRUPT_CLEANUP_COMPLETED", 0),
                patch.object(bench, "pause_agent", AsyncMock(return_value=True)),
                patch.object(cleanup, "exact_root_sessions", query),
                patch.object(bench, "_refresh_browser_archive_snapshot", snapshot),
                patch.object(bench, "finalize_archive_and_score_world_model", AsyncMock(return_value=("ref", {}))),
                patch.object(bench, "delete_agent", delete),
                patch.object(cleanup, "close_exact_root_sessions", close),
                patch.object(bench, "_finalize_owned_root_payments", payments),
                patch.object(bench, "fetch_local_worker_logs", return_value=[]),
            ):
                bench._begin_interrupt_cleanup()
                finalize = asyncio.create_task(
                    bench._finalize_owned_batch_and_save_run(
                        "http://localhost:1",
                        run,
                        {},
                        owned_batch_cleanup=True,
                        retrieval_audit=lambda: {"audited": True},
                    )
                )
                async with asyncio.timeout(10):
                    await entered.wait()
                    finalize.cancel()  # asyncio.run's SIGINT delivery
                    with pytest.raises(asyncio.CancelledError):
                        await finalize
                bench._finalize_interrupt_cleanup_status()
                state = status_file.read_text(encoding="utf-8")

        # The evaluated outcome is durable and unchanged by the interruption.
        assert len(saved) == 1, "interrupted finalization skipped run.save()"
        assert run.world_model_retrieval_audit == {"audited": True}
        # Every owned root still crosses exact provider and payment cleanup;
        # the interrupted archive wait is never resumed for later roots.
        for aid in (ROOT, CHILD):
            assert ("delete", aid) in events and ("release", aid) in events and ("payments", aid) in events
        assert [event for event in events if event[0] == "snapshot"] == [("snapshot", ROOT)]
        root_evidence, child_evidence = (row.logs["cloud_cleanup_evidence"] for row in rows)
        assert any(warning.startswith("archive:") for warning in root_evidence["warnings"])
        assert any(warning.startswith("archive:") for warning in child_evidence["warnings"])
        if provider_fails:
            # Unverified provider release stays fail-closed.
            assert "state=failed" in state
            assert child_evidence["errors"] == ["provider: provider session still live"]
            assert (rows[1].passed, rows[1].benchmark_status) == (False, "ERROR")
            assert (rows[0].passed, rows[0].benchmark_status, rows[0].failure_reason) == verdicts[0]
        else:
            assert "state=clean" in state, state
            assert root_evidence["errors"] == [] and child_evidence["errors"] == []
            assert [(row.passed, row.benchmark_status, row.failure_reason) for row in rows] == verdicts


@async_case
async def test_fixture_root_custody_refuses_unknown_foreign_and_duplicate_bindings():
    custody={"task_name":"owned-task","roots":[],"callback":None,"graded_creation":"not_started"}
    token=bench._task_root_custody.set(custody)
    try:
        for bad in (None,"","not-a-root"):
            with pytest.raises(RuntimeError,match="unknown or duplicate"):
                bench._register_task_root("owned-task",bad,"fixture_first_run")
        with pytest.raises(RuntimeError,match="foreign"):
            bench._register_task_root("foreign-task",ROOT,"fixture_first_run")
        bench._register_task_root("owned-task",ROOT,"fixture_first_run")
        with pytest.raises(RuntimeError,match="unknown or duplicate"):
            bench._register_task_root("owned-task",ROOT,"fixture_first_run")
        assert len(custody["roots"])==1
    finally:bench._task_root_custody.reset(token)
    for corruption in ("foreign","foreign_stage","duplicate","missing_provider","missing_seal"):
        row=result("");row.name="owned-task";row.graded_root_creation_outcome="not_started"
        record={"root_agent_id":ROOT,"task_name":row.name,"role":"fixture_first_run",
                "creation":{"source":"create_agent_return","root_agent_id":ROOT},"stage_outcome":"failed","logs":{}}
        row.owned_roots=[copy.deepcopy(record)]
        if corruption=="foreign":row.owned_roots[0]["task_name"]="foreign-task"
        if corruption=="foreign_stage":row.owned_roots[0]["logs"]["fixture_snapshot"]={"agent":{"id":CHILD}}
        if corruption=="duplicate":row.owned_roots.append(copy.deepcopy(record))
        sealed=False
        def query(*args,**kwargs):
            return {"root_user_id":ROOT,"tree_agent_ids":[ROOT],"browser_sessions":[],"purchase_cleanup":[],"root_deleted":sealed,"unsealed_tree_agent_ids":[] if sealed else[ROOT]}
        async def delete(*args):
            nonlocal sealed
            sealed=True
        def provider(*args,**kwargs):
            if corruption=="missing_provider":raise RuntimeError("provider proof unavailable")
            if corruption=="missing_seal":raise RuntimeError("exact seal unavailable")
            return {}
        with (
            patch.object(cleanup,"exact_root_sessions",query),patch.object(cleanup,"close_exact_root_sessions",provider),
            patch.object(bench,"pause_agent",AsyncMock(return_value=True)),patch.object(bench,"delete_agent",delete),
            patch.object(bench,"_refresh_browser_archive_snapshot",AsyncMock(return_value={"messages":[]})),
            patch.object(bench,"archive_agent_finalize",AsyncMock(return_value="fixture-archive")),
            patch.object(bench,"finalize_archive_and_score_world_model",AsyncMock(return_value=("archive",{}))),
            patch.object(bench,"_finalize_owned_root_payments",AsyncMock(return_value={})),
            patch.object(bench,"fetch_local_worker_logs",return_value=[]),
        ):
            with pytest.raises(RuntimeError):await bench._finalize_owned_cloud_batch("http://localhost:1",[row],{row.name:[ROOT]})
            if corruption in {"missing_provider","missing_seal"}:
                assert row.benchmark_status=="ERROR"
                assert row.owned_roots[0]["logs"]["cloud_cleanup_evidence"]["errors"]

@async_case
async def test_actual_task_runner_exports_fixture_custody_without_graded_root():
    """No synthetic result: actual runner catches fixture failure/cancellation."""
    from dataclasses import asdict
    for mode in ("early","raise","cancel","foreign_snapshot","graded_unknown","both"):
        task=bench.BenchmarkTask(name="owned-real-fixture",title="Owned fixture",prompt="Read owned result",timeout_seconds=10,is_chat_mode=False,expected_tools=[],tags=[],price_limit_cents=0,requires_browser_agent=True,requires_claude_code=False,attachment=None,approval_handling=None,start_phase="execute")
        owned=[]
        async def poll(*args):
            assert owned==[ROOT], "real task runner lost created fixture root before polling"
            if mode=="raise":raise RuntimeError("fixture poll error")
            if mode=="cancel":raise asyncio.CancelledError()
            return {"agent":{"id":CHILD if mode=="foreign_snapshot" else ROOT,"status":"COMPLETED" if mode in {"graded_unknown","both"} else "ACTIVE"}},0,0,None
        async def apply(*args):
            manifest={"siteId":"owned-site"}
            await bench._run_auth_test_site_first_run(task,"http://localhost:1",manifest,"Create account")
            return manifest
        async def create(*args):
            if owned:
                if mode=="both":return CHILD
                raise RuntimeError("graded create response unknown")
            return ROOT
        async def empty(*args,**kwargs):return []
        from contextlib import ExitStack
        targets = [
            patch.object(bench,"_validate_task_target"),patch.object(bench,"_effective_harness",return_value="rose"),
            patch.object(bench,"_run_user_id_override_for_task",return_value=None),
            patch.object(bench,"_apply_live_fixtures",empty),patch.object(bench,"_apply_memory_fixtures",empty),
            patch.object(bench,"prepare_sandbox_payment_residual",AsyncMock()),patch.object(bench,"_agentcard_setup_fixture_action",return_value=None),
            patch.object(bench,"_apply_auth_test_site",apply),patch.object(bench,"_release_auth_test_site",AsyncMock()),
            patch.object(bench,"_restore_live_fixture_scenarios_async",empty),
            patch.object(bench,"create_agent",create),patch.object(bench,"poll_agent",poll),
            patch.object(bench,"_api_headers",AsyncMock(return_value={})),patch.object(bench.auth_test_site,"mark_run",AsyncMock()),
            patch.object(bench,"subscribe_supabase_realtime_agent",empty),patch.object(bench,"get_agent_tree",empty),
            patch.object(bench,"post_world_model_update_events",empty),patch.object(bench,"archive_agent_start",empty),
            patch.object(bench,"_poll_agent",AsyncMock(return_value=({"agent":{"id":CHILD,"status":"COMPLETED"},"messages":[]},0,0,None))),
            patch.object(bench,"_get_settled_tool_usage",AsyncMock(return_value={})),patch.object(bench,"_fetch_tree_stats",AsyncMock(return_value={})),
            patch.object(bench,"get_llm_usage_details",AsyncMock(return_value=({},bench.aggregate_prompt_cache_share([])))),patch.object(bench,"evaluate_task",return_value=(True,None)),
            patch.object(bench,"ensure_payment_lifecycle_cleanup",AsyncMock(return_value=None)),
            patch.object(bench,"collect_logs",AsyncMock(return_value={"messages":[]})),
            patch.object(bench,"finalize_archive_and_score_world_model",AsyncMock(return_value=("archive",None))),
            patch.object(bench,"_should_delete_agent_after_run",return_value=False),
        ]
        with ExitStack() as stack:
            for target in targets:stack.enter_context(target)
            row=await bench.run_single_task("http://localhost:1",task,on_agent_created=lambda name,aid:owned.append(aid))
        assert row.agent_id==(CHILD if mode=="both" else "") and row.passed is (mode=="both")
        # K7 (355783b87): a first-run agent that does not complete is a graded FAILED, not a runner ERROR.
        expected_status=("PASSED" if mode=="both" else "CANCELLED" if mode=="cancel" else "FAILED" if mode=="early" else "ERROR")
        assert row.benchmark_status==expected_status
        assert row.owned_roots[0]["root_agent_id"]==ROOT and row.owned_roots[0]["role"]=="fixture_first_run"
        assert row.graded_root_creation_outcome==("allocated" if mode=="both" else "unknown" if mode=="graded_unknown" else "not_started")
        exported=asdict(row)
        assert exported["agent_id"]==(CHILD if mode=="both" else "") and exported["owned_roots"][0]["root_agent_id"]==ROOT
        calls=[];sealed=False
        def query(*args,**kwargs):
            return {"root_user_id":ROOT,"tree_agent_ids":[ROOT],"browser_sessions":[],"purchase_cleanup":[],"root_deleted":sealed,"unsealed_tree_agent_ids":[] if sealed else [ROOT]}
        async def delete(*args):
            nonlocal sealed
            sealed=True;calls.append(("delete",args[1]))
        def close(*args,**kwargs):
            assert sealed
            calls.append(("provider",args[1]));return {}
        with (
            patch.object(cleanup,"exact_root_sessions",query),patch.object(cleanup,"close_exact_root_sessions",close),
            patch.object(bench,"pause_agent",AsyncMock(return_value=True)),patch.object(bench,"delete_agent",delete),
            patch.object(bench,"_refresh_browser_archive_snapshot",AsyncMock(return_value={"messages":[]})),
            patch.object(bench,"archive_agent_finalize",AsyncMock(return_value="fixture-archive")) as fixture_archive,
            patch.object(bench,"finalize_archive_and_score_world_model",AsyncMock(return_value=("archive",{}))) as archive,
            patch.object(bench,"_finalize_owned_root_payments",AsyncMock(return_value={})),patch.object(bench,"fetch_local_worker_logs",return_value=[]),
        ):
            if mode=="graded_unknown":
                with pytest.raises(RuntimeError,match="unknown root creation outcome"):
                    await bench._finalize_owned_cloud_batch("http://localhost:1",[row],{task.name:owned})
            else:await bench._finalize_owned_cloud_batch("http://localhost:1",[row],{task.name:owned})
            fixture_archive.assert_awaited_once_with("http://localhost:1",ROOT,task.name,force=True)
            assert archive.await_count==(1 if mode=="both" else 0)
            if mode=="both":
                assert archive.await_args.args[1]==CHILD and archive.await_args.kwargs["benchmark_passed"] is True
                assert archive.await_args.kwargs["benchmark_status"]=="PASSED"
        for aid in ([ROOT,CHILD] if mode=="both" else [ROOT]):
            assert calls.count(("delete",aid))==1 and calls.count(("provider",aid))==1
        assert row.owned_roots[0]["logs"]["cloud_cleanup_evidence"]["root_agent_id"]==ROOT
        assert row.benchmark_status==expected_status

@async_case
async def test_owned_cleanup_diagnostic_pipe_failure_preserves_provider_evidence():
    await _diagnostic_pipe_case('success')
    await _diagnostic_pipe_case('archive')


async def _diagnostic_pipe_case(phase):
    import builtins
    roots = [ROOT, CHILD]
    rows = [result(aid) for aid in roots]
    rows[0].passed = True
    rows[0].benchmark_status = 'PASSED'
    rows[0].failure_reason = None
    events = []
    def query(_url, aid, **kwargs):
        return {'root_user_id': ROOT, 'tree_agent_ids': [aid], 'browser_sessions': [], 'purchase_cleanup': []}
    def release(_url, aid, before, *, evidence):
        events.append(('provider', aid))
        if phase == 'provider':
            raise RuntimeError('genuine provider failure')
        return {'root_agent_id': aid, 'tree_sealed': True, 'root_deleted': True, 'provider_receipts': []}
    async def payments(_url, aid, evidence):
        events.append(('payment', aid))
        if phase == 'payment':
            raise RuntimeError('genuine payment failure')
        return {'root_agent_id': aid, 'purchases': []}
    def output(*args, **kwargs):
        text = ' '.join(str(x) for x in args)
        if phase == 'unrelated' and 'Verified cloud root provider cleanup:' in text:
            raise ValueError('unrelated diagnostic bug')
        if (phase == 'success' and 'Verified cloud root provider cleanup:' in text) or (phase == 'archive' and 'Cloud archive warning:' in text):
            raise BrokenPipeError('diagnostic fixture pipe closed')
        return builtins.print(*args, **kwargs)
    archive = AsyncMock(side_effect=RuntimeError('archive fixture unavailable')) if phase == 'archive' else AsyncMock(return_value=('archive', None))
    with (
        patch.object(cleanup, 'exact_root_sessions', query),
        patch.object(bench, 'pause_agent', AsyncMock(return_value=True)),
        patch.object(bench, '_refresh_browser_archive_snapshot', AsyncMock(return_value={'messages': []})),
        patch.object(bench, 'finalize_archive_and_score_world_model', archive),
        patch.object(bench, 'delete_agent', AsyncMock()),
        patch.object(cleanup, 'close_exact_root_sessions', release),
        patch.object(bench, '_finalize_owned_root_payments', payments),
        patch.object(bench, 'fetch_local_worker_logs', return_value=[]),
        patch.object(bench, 'print', output, create=True),
    ):
        if phase in {'provider', 'payment', 'unrelated'}:
            with pytest.raises(RuntimeError):
                await bench._finalize_owned_cloud_batch('http://localhost:1', rows, {})
        else:
            await bench._finalize_owned_cloud_batch('http://localhost:1', rows, {})
    if phase in {'provider', 'payment', 'unrelated'}:
        assert rows[0].passed is False and rows[0].benchmark_status == 'ERROR'
        assert all(row.logs['cloud_cleanup_evidence']['errors'] for row in rows)
        assert events.count(('payment', ROOT)) == events.count(('payment', CHILD)) == 1
        return
    assert rows[0].passed is True and rows[0].benchmark_status == 'PASSED'
    assert rows[1].passed is False and rows[1].benchmark_status == 'FAILED'
    assert rows[1].failure_reason == 'test timeout'
    assert events == [('provider', ROOT), ('payment', ROOT), ('provider', CHILD), ('payment', CHILD)]
    for row in rows:
        assert row.logs['cloud_provider_cleanup']['root_agent_id'] == row.agent_id
        assert row.logs['cloud_cleanup_evidence']['errors'] == []
        assert any('BrokenPipeError' in warning for warning in row.logs['cloud_cleanup_evidence']['warnings'])


@async_case
async def test_owned_cleanup_diagnostic_sink_preserves_real_failures():
    for phase in ('provider', 'payment', 'unrelated'):
        await _diagnostic_pipe_case(phase)

async def _cancelled_queue_owning_case(mode="allocated"):
    """Actual coordinator AST + actual scheduler/finalizer, only external edges fake."""
    from contextlib import ExitStack
    import socket
    source=inspect.getsource(bench)
    tree=ast.parse(source)
    wrapper=next(n for n in ast.walk(tree) if isinstance(n,ast.AsyncFunctionDef) and n.name=='_run_reported_task')
    execution=next(n for n in ast.walk(tree) if isinstance(n,ast.Try) and n.body
                   and isinstance(n.body[0],ast.If) and isinstance(n.body[0].test,ast.Name)
                   and n.body[0].test.id=='checkpoint_source_mode')
    coordinator=ast.AsyncFunctionDef(name='_cancel_coordinator',args=ast.arguments(posonlyargs=[],args=[],kwonlyargs=[],kw_defaults=[],defaults=[]),body=[execution],decorator_list=[])
    admitted,agents,evaluated,signatures,live={},{},{},{},{}
    entries=[]; executor_tasks=[]; external=[]; entered=asyncio.Event(); closed=[]; saved=[]
    # Duplicate names are distinct scheduler occurrences, not a task-name set.
    tasks=[copy.deepcopy(bench.get_task_by_name('browser-auth-email-otp')) for _ in range(12)]
    original_finalizer=bench._finalize_owned_cloud_batch
    def deny(*args,**kwargs):
        external.append('network'); raise AssertionError('external network forbidden')
    async def delegate(url,task,*,on_agent_created,on_task_evaluated,**kwargs):
        entries.append(task);executor_tasks.append(asyncio.current_task())
        if mode=='allocated':on_agent_created(task.name,ROOT)
        entered.set()
        try: await asyncio.Event().wait()
        except asyncio.CancelledError:
            return bench.TaskResult(name=task.name,passed=False,agent_id=ROOT if mode=='allocated' else '',status='CANCELLED',benchmark_status='CANCELLED',progress_score=0,duration_seconds=0,cost_cents=0,message_count=0,logs={},graded_root_creation_outcome='allocated' if mode=='allocated' else 'unknown')
    @__import__('contextlib').asynccontextmanager
    async def blocked_lock(*args):
        entered.set();await asyncio.Event().wait();yield
    if mode=='never':
        for task in tasks:task.tags=[*task.tags,'agentcard-lifecycle-sandbox']
    async def finalize(url,rows,ids,**kwargs):
        assert len(entries)==(0 if mode=='never' else 1) and len(rows)==12
        assert not admitted and not agents
        queued=[r for r in rows if not r.agent_id]
        assert len(queued)==(11 if mode=='allocated' else 12) and all(r.status==r.benchmark_status=='CANCELLED' and r.passed is False for r in queued)
        if mode=='allocated':assert len(ids[tasks[0].name])==1 and ids[tasks[0].name][0]==ROOT
        else:assert ids=={}
        assert all(any(token is actual for token in namespace['_entered_task_futures']) for actual in executor_tasks)
        # Owning contract: real finalizer must release known root and accept the
        # coordinator's proven nonadmission, while unknown creates stay rejected.
        await original_finalizer(url,rows,ids,**kwargs)
        assert all(r.graded_root_creation_outcome=='not_started' for r in queued)
    async def query_snapshot(url,aid,data,logs,**kwargs):
        logs['messages']=[];return {'agent':{'id':aid,'status':'PAUSED'},'messages':[]}
    def query(url,aid,**kwargs):return {'root_user_id':ROOT,'tree_agent_ids':[aid],'browser_sessions':[],'purchase_cleanup':[]}
    def release(url,aid,before,**kwargs):closed.append(aid);return {'root_agent_id':aid}
    async def stop_collector():return 0
    with tempfile.TemporaryDirectory(prefix='queue-cancel-owned-') as tmp:
        path=Path(tmp)/'run.json'
        def save():path.write_text('{}');saved.append(True);return path
        run=SimpleNamespace(task_results=[],save=save)
        namespace=dict(bench.__dict__)
        namespace.update({'run_single_task':delegate,'_entered_task_futures':set(),'_never_admitted_results':[],'_admitted_tasks':admitted,'_admitted_agent_ids':agents,
            '_evaluated_task_results':evaluated,'_outcome_signatures':signatures,
            '_remember_live_agent':lambda name,aid:live.setdefault(name,[]).append(aid),
            '_emit_report':lambda **kwargs:None,'checkpoint_source_mode':False,'args':SimpleNamespace(parallel=True,keep_failed_agents=True,max_concurrency=5,prod=False),
            'tasks':tasks,'run':run,'max_concurrency':5,'base_url':'http://offline.invalid',
            '_run_with_sandbox_payment_lock':bench._run_with_sandbox_payment_lock,
            'stop_fly_log_collector':stop_collector,'realtime_started':False,'memory_gate_enabled':False,'owned_batch_cleanup':True,
            '_finalize_owned_cloud_batch':finalize,'_complete_interrupt_cleanup':lambda:None,'_live_task_agent_ids':live,'_wmh_evidence':SimpleNamespace(finalize=lambda:None),
            '_fetch_wmh_retrieval_audit':lambda:None,'cloud_batch_cleanup':SimpleNamespace(contract=lambda:None)})
        code=ast.fix_missing_locations(ast.Module(body=[wrapper,coordinator],type_ignores=[]))
        exec(compile(code,str(bench.__file__),'exec'),namespace)
        ticker_started = asyncio.Event()
        ticker_stopped = asyncio.Event()
        async def report_ticker():
            ticker_started.set()
            try:
                await asyncio.Event().wait()
            finally:
                ticker_stopped.set()
        ticker = asyncio.create_task(report_ticker())
        namespace['_report_ticker_task'] = ticker
        await ticker_started.wait()
        try:
            with ExitStack() as patches:
                if mode=='never':patches.enter_context(patch.object(bench,'_sandbox_agentcard_payment_lock',blocked_lock))
                for obj,name,value in [(socket.socket,'connect',deny),(socket,'getaddrinfo',deny),
                    (bench,'pause_agent',AsyncMock(return_value=True)),(cleanup,'exact_root_sessions',query),
                    (bench,'_refresh_browser_archive_snapshot',query_snapshot),
                    (bench,'finalize_archive_and_score_world_model',AsyncMock(return_value=('archive-ref',{}))),
                    (bench,'delete_agent',AsyncMock()),(cleanup,'close_exact_root_sessions',release),
                    (bench,'_finalize_owned_root_payments',AsyncMock(return_value={})),
                    (bench,'fetch_local_worker_logs',lambda *args,**kwargs:[])]:patches.enter_context(patch.object(obj,name,value))
                task=asyncio.create_task(namespace['_cancel_coordinator']())
                ready=asyncio.create_task(entered.wait())
                done,_=await asyncio.wait({task,ready},return_when=asyncio.FIRST_COMPLETED)
                if task in done:
                    ready.cancel();await asyncio.gather(ready,return_exceptions=True);await task
                await ready;await asyncio.sleep(0);task.cancel()
                with pytest.raises(RuntimeError if mode=='unknown' else asyncio.CancelledError) as stopped:
                    await task
                if mode=='unknown':assert 'unknown root creation outcome' in str(stopped.value)
        finally:
            coordinator_retired_ticker = ticker.done()
            if not coordinator_retired_ticker:
                ticker.cancel()
                await asyncio.gather(ticker, return_exceptions=True)
            assert coordinator_retired_ticker, 'coordinator returned before retiring its ticker'
            assert ticker.cancelled() and ticker_stopped.is_set()
        assert saved==[True] and closed==([ROOT] if mode=='allocated' else []) and external==[]

@async_case
async def test_cancelled_unknown_create_stays_fail_closed():
    row=bench.TaskResult(name='browser-auth-email-otp',passed=False,agent_id='',status='CANCELLED',benchmark_status='CANCELLED',progress_score=0,duration_seconds=0,cost_cents=0,message_count=0,graded_root_creation_outcome='unknown')
    with pytest.raises(RuntimeError,match='unknown root creation outcome'):
        await bench._finalize_owned_cloud_batch('http://offline.invalid',[row],{})
    # Status/absence alone and forged not_started are not proof of nonadmission.
    row.graded_root_creation_outcome='not_started'
    with pytest.raises(RuntimeError,match='unknown root creation outcome'):
        await bench._finalize_owned_cloud_batch('http://offline.invalid',[row],{})


async def _run_real_task_failing_before_graded_create(mode,task_name="rootless-setup-task"):
    """Drive the actual task runner to an exception before (or during) root creation."""
    from contextlib import ExitStack
    task=bench.BenchmarkTask(name=task_name,title="Rootless setup",prompt="Buy it",timeout_seconds=10,is_chat_mode=False,expected_tools=[],tags=[],price_limit_cents=0,requires_browser_agent=False,requires_claude_code=False,attachment=None,approval_handling=None,start_phase="execute")
    setup_429=('Failed to prepare-residual benchmark AgentCard setup: 429 {"error":"AgentCard Organization MCP rate limit exceeded",'
               '"code":"agentcard_org_mcp_rate_limited","retryAfterSeconds":null}')
    owned=[]
    async def prepare(*args):
        if mode=="setup":raise RuntimeError(setup_429)
    async def apply(*args):
        if mode!="first_run_create":return None
        await bench._run_auth_test_site_first_run(task,"http://localhost:1",{"siteId":"owned-site"},"Create account")
    async def create(*args):
        # The POST was issued; its response (and any allocated root id) was lost.
        raise RuntimeError("create response lost")
    async def codex(*args,**kwargs):
        raise RuntimeError("codex create response lost")
    async def empty(*args,**kwargs):return []
    targets=[
        patch.object(bench,"_validate_task_target"),patch.object(bench,"_effective_harness",return_value="codex" if mode=="codex" else "rose"),
        patch.object(bench,"_check_codex_harness_credentials",AsyncMock(return_value=True)),
        patch("benchmarks.codex_runner.run_codex_task",codex),
        patch.object(bench,"_run_user_id_override_for_task",return_value=None),
        patch.object(bench,"_apply_live_fixtures",empty),patch.object(bench,"_apply_memory_fixtures",empty),
        patch.object(bench,"prepare_sandbox_payment_residual",prepare),patch.object(bench,"_agentcard_setup_fixture_action",return_value=None),
        patch.object(bench,"_apply_auth_test_site",apply),patch.object(bench,"_release_auth_test_site",AsyncMock()),
        patch.object(bench,"_restore_live_fixture_scenarios_async",empty),
        patch.object(bench,"create_agent",create),patch.object(bench,"_api_headers",AsyncMock(return_value={})),
        patch.object(bench,"ensure_payment_lifecycle_cleanup",AsyncMock(return_value=None)),
        patch.object(bench,"finalize_archive_and_score_world_model",AsyncMock(return_value=("archive",None))),
    ]
    with ExitStack() as stack:
        for target in targets:stack.enter_context(target)
        return await bench.run_single_task("http://localhost:1",task,on_agent_created=lambda name,aid:owned.append(aid)),owned


@async_case
async def test_rootless_setup_failure_keeps_its_task_verdict_instead_of_unknown_creation():
    """2026-11-08 smoke: a prepare-residual 429 raised before any create_agent call.

    The task never issued a root creation request, so its custody proves zero
    allocation. Finalization must keep the ordinary ERROR verdict instead of
    raising the unknown-creation infra failure that cancelled every smoke job.
    """
    row,owned=await _run_real_task_failing_before_graded_create("setup")
    assert owned==[] and row.agent_id=="" and row.owned_roots==[]
    assert row.graded_root_creation_outcome=="not_started" and row.root_creation_attempted is False
    assert row.status==row.benchmark_status=="ERROR" and row.passed is False
    assert "agentcard_org_mcp_rate_limited" in row.failure_reason
    with patch.object(cleanup,"exact_root_sessions",side_effect=AssertionError("no root may be queried")):
        await bench._finalize_owned_cloud_batch("http://offline.invalid",[row],{})
    assert row.status==row.benchmark_status=="ERROR" and "prepare-residual" in row.failure_reason
    # The proof is exact: any sign that a root might exist stays fail-closed.
    for key,value in [("root_creation_attempted",None),("root_creation_attempted",True),
                      ("graded_root_creation_outcome","unknown"),("passed",True),
                      ("owned_roots",[{"root_agent_id":ROOT}])]:
        changed=copy.deepcopy(row);setattr(changed,key,value)
        with pytest.raises(RuntimeError):
            await bench._finalize_owned_cloud_batch("http://offline.invalid",[changed],{})
    with pytest.raises(RuntimeError):
        await bench._finalize_owned_cloud_batch("http://offline.invalid",[row],{row.name:[ROOT]})


@async_case
async def test_lost_create_response_before_graded_creation_stays_unknown():
    """A first-run fixture or Codex create whose response was lost may own a root."""
    for mode in ("first_run_create","codex"):
        row,owned=await _run_real_task_failing_before_graded_create(mode)
        assert owned==[] and row.agent_id=="" and row.status=="ERROR"
        assert row.root_creation_attempted is True, mode
        with pytest.raises(RuntimeError,match="unknown root creation outcome"):
            await bench._finalize_owned_cloud_batch("http://offline.invalid",[row],{})


@async_case
async def test_composite_stage_with_lost_create_keeps_the_outer_task_unknown():
    """A composite (minted-account) runner creates roots through nested run_single_task stages.

    A stage whose create response was lost marks only its own nested custody unless the mark
    reaches the enclosing task; the composite row would then look rootless and its possibly
    allocated root would never be cleaned up.
    """
    async def composite(base_url,task,keep_failed_agents,on_agent_created=None):
        inner=bench.BenchmarkTask(name="rootless-setup-task",title="Stage",prompt="Post",timeout_seconds=10,is_chat_mode=False,expected_tools=[],tags=[],price_limit_cents=0,requires_browser_agent=False,requires_claude_code=False,attachment=None,approval_handling=None,start_phase="execute")
        stage=await bench.run_single_task(base_url,inner,on_agent_created=on_agent_created)
        assert stage.agent_id=="" and stage.root_creation_attempted is True
        return bench.TaskResult(name=task.name,passed=False,agent_id="",status="FAILED",benchmark_status="FAILED",
                                progress_score=0,duration_seconds=0,cost_cents=0,message_count=0,failure_reason=stage.failure_reason)
    with patch.object(bench,"run_minted_agent_account_task",composite):
        row,owned=await _run_real_task_failing_before_graded_create("first_create",task_name=bench.MINTED_AGENT_ACCOUNT_X_TASK_NAME)
    assert owned==[] and row.agent_id=="" and row.owned_roots==[]
    assert row.root_creation_attempted is True
    with pytest.raises(RuntimeError,match="unknown root creation outcome"):
        await bench._finalize_owned_cloud_batch("http://offline.invalid",[row],{})


@async_case
async def test_cancelled_inbox_waiters_are_proven_never_admitted():
    await _cancelled_queue_owning_case()

@async_case
async def test_cancelled_before_any_executor_allocates_nothing():
    await _cancelled_queue_owning_case('never')

@async_case
async def test_cancelled_entered_unknown_create_cannot_claim_nonadmission():
    await _cancelled_queue_owning_case('unknown')

@async_case
async def test_nonadmission_proof_rejects_copies_and_forged_metadata():
    row=bench.TaskResult(name='same-name',passed=False,agent_id='',status='CANCELLED',benchmark_status='CANCELLED',progress_score=0,duration_seconds=0,cost_cents=0,message_count=0,graded_root_creation_outcome='not_started',stop_metadata={'runner':'benchmark_coordinator','admission':'not_started','occurrence_index':0})
    cloned=copy.deepcopy(row)
    # Equal dataclass values are NOT the same coordinator-owned result object.
    assert row==cloned and row is not cloned
    for rows,proof in [([cloned],[row]),([row,cloned],[row]),([row],[]),([row],[row,row])]:
        with pytest.raises(RuntimeError):
            await bench._finalize_owned_cloud_batch('http://offline.invalid',rows,{},never_admitted_results=proof)
    for key,value in [('runner','foreign'),('admission','unknown'),('occurrence_index',True),('occurrence_index',-1)]:
        forged=copy.deepcopy(row);forged.stop_metadata[key]=value
        with pytest.raises(RuntimeError):
            await bench._finalize_owned_cloud_batch('http://offline.invalid',[forged],{},never_admitted_results=[forged])


@async_case
async def test_initial_claude_skip_requires_exact_preflight_nonadmission_custody():
    task = bench.get_task_by_name('claude-code-agent')
    row = bench._claude_code_credential_skip_result(task)
    row.graded_root_creation_outcome = 'not_started'
    row.stop_metadata = {'runner': 'benchmark_preflight', 'admission': 'not_started',
                         'reason': 'claude_credential_unavailable'}
    with patch.object(cleanup, 'exact_root_sessions', side_effect=RuntimeError('offline native control')):
        await bench._finalize_owned_cloud_batch('http://offline.invalid', [row], {}, never_admitted_results=(row,))
        # Execute the actual initial producer statements, before any dispatch can occur.
        main = next(n for n in ast.parse(inspect.getsource(bench)).body
                    if isinstance(n, ast.AsyncFunctionDef) and n.name == 'main_async')
        nodes = [n for n in main.body if
            isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'initial_credential_skips' for t in n.targets)
            or isinstance(n, ast.For) and isinstance(n.iter, ast.Name) and n.iter.id == 'initial_credential_skips'
            or isinstance(n, ast.Expr) and isinstance(n.value, ast.Call) and isinstance(n.value.func, ast.Attribute)
                and n.value.func.attr == 'extend' and any(isinstance(a, ast.Name) and a.id == 'initial_credential_skips' for a in n.value.args)
            or isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name) and n.target.id == '_never_admitted_results']
        namespace = {**bench.__dict__, 'skipped_claude_tasks': [task], 'run': SimpleNamespace(task_results=[])}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(bench.__file__), 'exec'), namespace)
        produced = namespace['run'].task_results[0]
        assert namespace['initial_credential_skips'][0] is produced
        await bench._finalize_owned_cloud_batch('http://offline.invalid', [produced], {},
                                                never_admitted_results=tuple(namespace['_never_admitted_results']))
        clone = copy.deepcopy(row)
        for rows, proof in [([row], ()), ([clone], (row,)), ([row], (row, row)),
                            ([row, clone], (row,)), ([row], (clone,))]:
            with pytest.raises(RuntimeError):
                await bench._finalize_owned_cloud_batch('http://offline.invalid', rows, {}, never_admitted_results=proof)
        for key, value in [('graded_root_creation_outcome', 'unknown'), ('passed', True),
                           ('failure_reason', 'other skip'), ('name', 'parallel-tool-calls'),
                           ('logs', {'late': 'execution'}), ('owned_roots', [{'root_agent_id': ROOT}]),
                           ('stop_metadata', {'runner': 'benchmark_preflight', 'admission': 'unknown'})]:
            changed = copy.deepcopy(row); setattr(changed, key, value)
            with pytest.raises(RuntimeError):
                await bench._finalize_owned_cloud_batch('http://offline.invalid', [changed], {}, never_admitted_results=(changed,))
        with pytest.raises(RuntimeError):
            await bench._finalize_owned_cloud_batch('http://offline.invalid', [row], {row.name: [ROOT]}, never_admitted_results=(row,))
        generic = bench._claude_code_credential_skip_result(task)  # dispatch skip has no initial custody
        with pytest.raises(RuntimeError):
            await bench._finalize_owned_cloud_batch('http://offline.invalid', [generic], {}, never_admitted_results=(generic,))


@async_case
async def test_post_verdict_cleanup_failure_never_rewrites_graded_verdicts():
    """T114 (Kernel antibot Run A): the memory watchdog killed the owned backend during batch
    finalization; the verifier could not run for the roots still awaiting cleanup and the run record
    rewrote 5 graded PASS verdicts as ERROR (report card 26 vs record 21). When the owned stack itself
    stopped, the evaluator's verdict stays, the unverified cleanup is recorded, the batch raises and
    CI fails. A genuine provider/payment cleanup failure still fails the task (control below)."""
    rows = [result(ROOT), result(CHILD)]
    rows[0].passed, rows[0].status, rows[0].benchmark_status, rows[0].failure_reason = True, "COMPLETED", "PASSED", None
    rows[1].passed, rows[1].status, rows[1].benchmark_status, rows[1].failure_reason = False, "FAILED", "FAILED", "judge: no results"
    graded = [(row.passed, row.status, row.benchmark_status, row.failure_reason) for row in rows]
    before = {"root_user_id": ROOT, "tree_agent_ids": [ROOT], "browser_sessions": [{"provider": "kernel", "session_id": "nnksma2uo5sa548v"}]}
    stopped = cleanup.OwnedStackStoppedError("owned local stack is stopped before provider verification")
    with (
        patch.object(cleanup, "exact_root_sessions", return_value=before),
        patch.object(cleanup, "close_exact_root_sessions", side_effect=stopped),
        patch.object(bench, "pause_agent", AsyncMock(return_value=True)),
        patch.object(bench, "delete_agent", AsyncMock(return_value=True)),
        patch.object(bench, "_refresh_browser_archive_snapshot", AsyncMock(side_effect=ConnectionError("All connection attempts failed"))),
        patch.object(bench, "_finalize_owned_root_payments", AsyncMock(side_effect=stopped)),
        patch.object(bench, "fetch_local_worker_logs", return_value=[]),
    ):
        with pytest.raises(RuntimeError, match="owned cloud evidence finalization failed"):
            await bench._finalize_owned_cloud_batch("http://localhost:1", rows, {})
    assert [(row.passed, row.status, row.benchmark_status, row.failure_reason) for row in rows] == graded
    for row in rows:
        assert row.cleanup_failure == (
            "Cloud cleanup failed: provider: owned local stack is stopped before provider verification; "
            "payment: owned local stack is stopped before provider verification"
        )
    from benchmarks.results import BenchmarkRun, TaskResult

    recorded = [
        TaskResult(
            name=row.name, passed=row.passed, agent_id=row.agent_id, status=row.status, progress_score=1,
            duration_seconds=1, cost_cents=0, message_count=0, cleanup_failure=row.cleanup_failure,
        )
        for row in rows
    ]
    summary = BenchmarkRun(task_results=recorded).summary
    assert (summary["passed"], summary["failed"], summary["cleanup_failures"]) == (1, 1, 2)
    assert bench._ci_should_fail({"failed": 0, "cleanup_failures": 2}, rows) is True


@async_case
async def test_genuine_cleanup_failure_still_fails_the_task():
    """Control for T114: an unreleased provider session on a live stack keeps the strict ERROR."""
    row = result(ROOT)
    row.passed, row.status, row.benchmark_status, row.failure_reason = True, "COMPLETED", "PASSED", None
    before = {"root_user_id": ROOT, "tree_agent_ids": [ROOT], "browser_sessions": [{"provider": "kernel", "session_id": "nnksma2uo5sa548v"}]}
    with (
        patch.object(cleanup, "exact_root_sessions", return_value=before),
        patch.object(cleanup, "close_exact_root_sessions", side_effect=RuntimeError("provider session still live")),
        patch.object(bench, "pause_agent", AsyncMock(return_value=True)),
        patch.object(bench, "delete_agent", AsyncMock(return_value=True)),
        patch.object(bench, "_refresh_browser_archive_snapshot", AsyncMock(return_value={})),
        patch.object(bench, "finalize_archive_and_score_world_model", AsyncMock(return_value=("ref", None))),
        patch.object(bench, "_finalize_owned_root_payments", AsyncMock(return_value={})),
        patch.object(bench, "fetch_local_worker_logs", return_value=[]),
    ):
        with pytest.raises(RuntimeError, match="owned cloud evidence finalization failed"):
            await bench._finalize_owned_cloud_batch("http://localhost:1", [row], {})
    assert (row.passed, row.benchmark_status) == (False, "ERROR")
    assert row.failure_reason == "Cloud cleanup failed: provider: provider session still live"
    assert getattr(row, "cleanup_failure", None) is None


@async_case
async def test_archive_retains_completed_snapshot_before_gather_resumes():
    logs = {"messages": [{"text": "pre-pause snapshot"}]}
    snapshot = {"messages": browser_rows(attached=False)}
    owner = asyncio.current_task()

    async def fetch(_url, aid):
        assert aid == ROOT
        owner.cancel()
        return snapshot

    with (
        patch.object(bench, "get_agent_tree", AsyncMock(return_value=[{"agent_id": ROOT}])),
        patch.object(bench, "get_agent", fetch),
    ):
        with pytest.raises(asyncio.CancelledError):
            await bench._refresh_browser_archive_snapshot(
                "http://localhost:1", ROOT, {}, logs, timeout_seconds=0.01
            )
    observation = logs["browser_archive_observation"]
    assert observation["completed_agent_ids"] == [ROOT]
    assert observation["snapshots"] == {ROOT: snapshot}
    assert observation["ready"] is False
    assert logs["messages"] == [{"text": "pre-pause snapshot"}]
    assert "tree" not in logs


@async_case
async def test_archive_timeout_retains_only_completed_snapshots():
    snapshot = {"messages": browser_rows(attached=False)}
    loop = asyncio.get_running_loop()
    for return_root in (True, False):
        logs = {"messages": [{"text": "pre-pause snapshot"}]}
        pending_cancelled = set()
        pending_started = set()
        clock = loop.time()

        def fixture_time():
            return clock

        async def fetch(_url, aid):
            nonlocal clock
            if return_root and aid == ROOT:
                return snapshot
            try:
                pending_started.add(aid)
                if pending_started == ({CHILD} if return_root else {ROOT, CHILD}):
                    # Expire the unchanged deadline only after the scenario's
                    # completed and pending fetches exist. Setup latency must
                    # not turn this into a tree-fetch timeout instead.
                    clock += 0.01
                await asyncio.Event().wait()
            finally:
                pending_cancelled.add(aid)

        with (
            patch.object(loop, "time", fixture_time),
            patch.object(bench, "get_agent_tree", AsyncMock(return_value=[{"agent_id": ROOT}, {"agent_id": CHILD}])),
            patch.object(bench, "get_agent", fetch),
        ):
            with pytest.raises(TimeoutError):
                await bench._refresh_browser_archive_snapshot(
                    "http://localhost:1", ROOT, {}, logs, timeout_seconds=0.01
                )
        observation = logs["browser_archive_observation"]
        assert observation["snapshots"] == ({ROOT: snapshot} if return_root else {}), (return_root, observation)
        assert set(observation["completed_agent_ids"]) == ({ROOT} if return_root else set())
        assert pending_cancelled == ({CHILD} if return_root else {ROOT, CHILD})
        assert observation["ready"] is False
        assert logs["messages"] == [{"text": "pre-pause snapshot"}]
        assert "tree" not in logs


def test_exact_database_proof_preserves_native_long_run_identity_without_aliases():
    """Replay the native74-character manifest failure through its real DB guard."""
    import subprocess
    import runpy

    source = (Path(__file__).resolve().parents[2] / "scripts/run.sh").read_text()
    marker = '    if [ "$BENCHMARK_ISOLATED_RUN" = "true" ] && [ -n "${BENCHMARK_RUN_ID:-}" ]; then'
    start = source.index(marker)
    stop = source.index('\n    if pg_isready', start)
    fragment = source[start:stop]
    run_id = "agentcard-v2-stability-20261109-partial11-round-01-worlds-1"
    def native_name(value):
        completed = subprocess.run(
            ["bash", "-e", "-c", '. "$1"\n' + fragment + '\nexport LOCAL_DB_NAME LOCAL_DB_URL\npython3 -c \'import json,os; print(json.dumps({"name":os.environ["LOCAL_DB_NAME"],"url":os.environ["LOCAL_DB_URL"]}))\'', "native-name", str(Path(__file__).resolve().parents[2] / "scripts/lib/workspace-env.sh")],
            env={"PATH": os.environ["PATH"], "BENCHMARK_ISOLATED_RUN": "true",
                 "BENCHMARK_RUN_ID": value, "SYSTEM_PG_PORT": "5432"},
            capture_output=True, text=True, check=True, timeout=5,
        )
        row = json.loads(completed.stdout)
        assert row["url"] == f"postgresql://postgres:postgres@localhost:5432/{row['name']}"
        return row["name"]

    names = [native_name(run_id), native_name(run_id[:-1] + "2")]
    recovery = runpy.run_path(str(cleanup.REPO_ROOT / "scripts/cloudbench-guest-recovery.py"))
    payload = {"root_exists": True, "root_user_id": ROOT, "root_deleted": True,
               "unsealed_tree_agent_ids": [], "tree_agent_ids": [ROOT],
               "browser_sessions": [], "purchase_cleanup": []}
    queries = []
    def query(_command, **kwargs):
        queries.append(kwargs)
        return json.dumps(payload)
    recovery["run_exact_psql"] = query
    with tempfile.TemporaryDirectory() as directory:
        context = Path(directory)
        manifest = {"worktree": str(cleanup.REPO_ROOT), "benchmark_mode": True, "status": "running",
                    "temporal_task_queue": "owned-queue", "ports": {"backend": 3201},
                    "database": {"name": names[0], "port": 5432, "use_system_postgres": True}}
        manifest_path = context / "services.json"
        manifest_path.write_text(json.dumps(manifest))
        environment = {"BENCHMARK_CLOUD_BATCH_CLEANUP": "true", "BENCHMARK_ISOLATED_RUN": "true",
                       "BENCHMARK_INTERRUPT_CLEANUP_TOKEN": "owned-token",
                       "BENCHMARK_INTERRUPT_CLEANUP_STATUS_FILE": str(context / "status"),
                       "BENCHMARK_CONTEXT_DIR": directory, "TEMPORAL_TASK_QUEUE": "owned-queue"}
        with patch.dict(os.environ, environment), patch.object(cleanup.runpy, "run_path", return_value=recovery):
            assert cleanup.exact_root_sessions("http://localhost:3201", ROOT, require_deleted=True) == payload
            assert queries[-1]["database"] == names[0] and queries[-1]["port"] == 5432
            assert all(len(name.encode("ascii")) <= 63 for name in names)
            assert names[0] != names[1], "world siblings must never alias one system database"
            assert native_name(run_id) == names[0], "same world must retain the same identity"
            assert native_name("short-fixture") == "victoria_bench_short_fixture"
            exact_boundary = "x" * (63 - len("victoria_bench_"))
            assert native_name(exact_boundary) == "victoria_bench_" + exact_boundary
            assert len(native_name(exact_boundary + "x")) == 63
            assert native_name(exact_boundary + "x") != native_name(exact_boundary + "y")
            for foreign_url in ("https://production.example", "http://localhost:3202", "http://localhost:3201/foreign", "http://user@localhost:3201", "http://localhost:3201?database=foreign", "http://127.0.0.1:3201"):
                count = len(queries)
                with pytest.raises(RuntimeError, match="not the owned local stack"):
                    cleanup.exact_root_sessions(foreign_url, ROOT)
                assert len(queries) == count, "foreign URL must be refused before SQL"
            for patch_value in ({"worktree": str(context / "foreign")}, {"temporal_task_queue": "foreign-queue"},
                                {"database": {"name": "unsafe;DROP DATABASE foreign", "port": 5432}},
                                {"database": {"name": names[0], "port": 65536}},
                                {"database": {"name": names[0], "port": "5432"}}):
                manifest_path.write_text(json.dumps({**manifest, **patch_value}))
                count = len(queries)
                with pytest.raises(RuntimeError, match="not the owned local stack"):
                    cleanup.exact_root_sessions("http://localhost:3201", ROOT)
                assert len(queries) == count, "foreign/unsafe stack must be refused before SQL"


def test_native_system_database_identity_agrees_for_create_restore_runtime_and_manifest():
    """Run native startup fragments with database commands replaced by exact captures."""
    import subprocess
    from urllib.parse import urlsplit

    repo = Path(__file__).resolve().parents[2]
    source = (repo / "scripts/run.sh").read_text()
    marker = '    if [ "$BENCHMARK_ISOLATED_RUN" = "true" ] && [ -n "${BENCHMARK_RUN_ID:-}" ]; then'
    name_start = source.index(marker)
    names = source[name_start:source.index('\n    if pg_isready', name_start)]
    create_start = source.index('    if [ "$BENCHMARK_ISOLATED_RUN" = "true" ]; then\n        PGPASSWORD=postgres dropdb')
    creates = source[create_start:source.index('\nfi\n\n# DEMO cache', create_start)]
    config_start = source.index('configure_local_db_url() {')
    config = source[config_start:source.index('\nconfigure_local_db_url', config_start)]
    restore_start = source.index('    if PGPASSWORD=postgres bash scripts/restore-seed-dump.sh')
    restores = source[restore_start:source.index('; then', restore_start)].removeprefix('    if ')
    writer_start = source.index('write_services_manifest() {')
    python_start = source.index("python3 - <<'PY'\n", writer_start) + len("python3 - <<'PY'\n")
    manifest_python = source[python_start:source.index('\nPY\n', python_start)]
    import importlib.util
    import sys
    spec = importlib.util.spec_from_file_location("owned_db_local", repo / "agents/benchmarks/local.py")
    local = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {spec.name: local}):
        spec.loader.exec_module(local)
    run_ids = ["agentcard-v2-stability-20261109-partial11-round-01-worlds-1",
               "agentcard-v2-stability-20261109-partial11-round-01-worlds-2",
               "same.prefix-" + "a" * 70, "same_prefix-" + "a" * 70]
    observed = []
    for run_id in run_ids:
        with tempfile.TemporaryDirectory() as directory:
            context = Path(directory)
            script = (
                '. "$1"\n' + names + "\n"
                'dropdb() { DROPPED_DB="${@: -1}"; }\n'
                'createdb() { CREATED_DB="${@: -1}"; }\n'
                '{\n' + creates + '\n} >/dev/null\n' + config + '\nconfigure_local_db_url\n'
                'bash() { [ "$1" = scripts/restore-seed-dump.sh ] || return 99; RESTORED_DB="$6"; }\n'
                '_SEED_DUMP=offline.dump; _SEED_RESTORE_CONTAINER=""\n' + restores + '\n'
                'export LOCAL_DB_NAME LOCAL_DB_ACTUAL_PORT DB_OWNED_BY_US DROPPED_DB CREATED_DB RESTORED_DB\n'
                "python3 - <<'PY_NATIVE_MANIFEST'\n" + manifest_python + "\nPY_NATIVE_MANIFEST\n"
                "python3 - <<'PY_NATIVE_CAPTURE'\n"
                'import json,os,pathlib\n'
                'row={k:os.environ[k] for k in ["LOCAL_DB_NAME","DATABASE_URL","DIRECT_URL","DROPPED_DB","CREATED_DB","RESTORED_DB"]}\n'
                'row["manifest"]=json.loads((pathlib.Path(os.environ["RUN_CONTEXT_DIR"])/"services.json").read_text())\n'
                'print(json.dumps(row))\nPY_NATIVE_CAPTURE\n'
            )
            result = subprocess.run(
                ["bash", "-e", "-c", script, "native-db-identity", str(repo / "scripts/lib/workspace-env.sh")],
                cwd=cleanup.REPO_ROOT,
                env={"PATH": os.environ["PATH"], "BENCHMARK_ISOLATED_RUN":"true", "BENCHMARK_MODE":"true",
                     "BENCHMARK_RUN_ID":run_id, "SYSTEM_PG_PORT":"5432", "LOCAL_DB_ACTUAL_PORT":"5432",
                     "USE_SYSTEM_PG":"true", "IS_CLOUD":"true", "RUN_CONTEXT_DIR":directory,
                     "SERVICE_STATUS":"running", "BACKEND_PORT":"3201", "TEMPORAL_TASK_QUEUE":"owned-queue"},
                capture_output=True, text=True, check=True, timeout=5,
            )
            row = json.loads(result.stdout)
            name = row["LOCAL_DB_NAME"]
            assert name.isascii() and len(name) <= 63
            for field in ["DROPPED_DB", "CREATED_DB", "RESTORED_DB"]:
                assert row[field] == name
            assert urlsplit(row["DATABASE_URL"]).path == urlsplit(row["DIRECT_URL"]).path == "/" + name
            assert row["manifest"]["database"]["name"] == name
            assert row["manifest"]["database"]["port"] == row["manifest"]["database"]["runtime_port"] == 5432
            assert local.benchmark_system_pg_db_name(run_id) == name
            observed.append(name)
    assert len(set(observed)) == len(run_ids), "hash must include original punctuation and sibling suffix"


async def _assert_terminal_report_final_grade(scenarios):
    """Real main finalizer must project canonical post-cleanup outcomes to the native card."""
    from benchmarks import results as result_types
    from benchmarks import report_card as native_card
    import runpy

    source = Path(__file__).with_name("run_benchmark.py")
    module = ast.parse(source.read_text()).body
    save_helper = next(node for node in module if isinstance(node, ast.AsyncFunctionDef) and node.name == "_finalize_owned_batch_and_save_run")
    private_emitter = runpy.run_path(str(source.with_name("report_card.py")))["ReportCardEmitter"]
    main = next(node for node in module if isinstance(node, ast.AsyncFunctionDef) and node.name == "main_async")
    start = next(i for i, node in enumerate(main.body) if isinstance(node, ast.Assign) and any(
        isinstance(target, ast.Name) and target.id == "initial_credential_skips" for target in node.targets))
    stop = next(i for i, node in enumerate(main.body) if isinstance(node, ast.Assign) and any(
        isinstance(target, ast.Name) and target.id == "owned_batch_cleanup" for target in node.targets))
    owner = next(node for node in main.body if isinstance(node, ast.Try) and any(
        isinstance(child, ast.Name) and child.id == "_report_ticker_task"
        for statement in node.finalbody for child in ast.walk(statement)))
    finish = ast.AsyncFunctionDef(name="_finish_native_report", args=ast.arguments(
        posonlyargs=[], args=[], kwonlyargs=[], kw_defaults=[], defaults=[]), body=owner.finalbody, decorator_list=[])
    task = SimpleNamespace(name="agent-payment-setup-resume", world_model_mode=None)
    for scenario in scenarios:
        grade = scenario.removesuffix("-closed")
        closed = [False]
        def sink(*args, **kwargs):
            if closed[0]:
                raise BrokenPipeError("stdout closed")
        error = asyncio.CancelledError("owned cleanup cancelled") if grade == "cleanup-cancelled" else RuntimeError("provider verification database is not the owned local stack")
        with tempfile.TemporaryDirectory() as directory:
            context = Path(directory)
            passed = grade in {"cleanup-error", "cleanup-cancelled", "passed"}
            status = "COMPLETED" if passed else grade.upper()
            result = bench.TaskResult(name=task.name, passed=passed, agent_id=ROOT, status=status,
                benchmark_status="PASSED" if passed else status, progress_score=1 if passed else 0,
                duration_seconds=241.5, cost_cents=2.0, message_count=3, tokens_in=194195, tokens_out=1679)
            run = result_types.BenchmarkRun(run_id="native-final-report", task_results=[result])
            real_save = run.save
            run.save = lambda: real_save(directory=str(context / "canonical"))
            async def stop_collector():
                return 0
            async def finalize(_url, results, _roots, **_kwargs):
                assert results == [result]
                if scenario.endswith("-closed"):
                    closed[0] = True
                if grade.startswith("cleanup-"):
                    bench._record_owned_cleanup_failure(result,
                        {"errors":["provider: exact provider ownership was not established", "payment: exact payment ownership was not established"]}, error)
                    raise error
            namespace = dict(vars(bench))
            namespace.update(tasks=[task], skipped_claude_tasks=[], run=run, base_url="http://localhost:3201",
                stop_fly_log_collector=stop_collector, realtime_started=False, memory_gate_enabled=False,
                print=sink, _finalize_owned_cloud_batch=finalize, _complete_interrupt_cleanup=lambda:None,
                owned_batch_cleanup=True, _live_task_agent_ids={task.name:[ROOT]}, _never_admitted_results=[],
                _WMHEvidenceSnapshot=lambda: SimpleNamespace(refresh=lambda:None, finalize=lambda:None),
                _infra_usd_for_elapsed=lambda _elapsed:None)
            with patch.dict(os.environ, {"BENCHMARK_CONTEXT_DIR":directory}), \
                 patch.object(bench, "_finalize_owned_cloud_batch", finalize), \
                 patch.object(bench, "_complete_interrupt_cleanup"), \
                 patch.object(run, "_record_history") as history, \
                 patch.object(run, "_upload_to_hub") as hub, \
                 patch("socket.create_connection", side_effect=AssertionError("real network forbidden")) as dial, \
                 patch("socket.socket.connect", side_effect=AssertionError("real network forbidden")) as connect, \
                 patch("socket.socket.connect_ex", side_effect=AssertionError("real network forbidden")) as connect_ex, \
                 patch.object(native_card, "ReportCardEmitter", private_emitter), \
                 patch("benchmarks.report_card.clean_source_sha", return_value="a"*40):
                exec(compile(ast.fix_missing_locations(ast.Module(body=[save_helper, *main.body[start:stop], finish], type_ignores=[])),
                    str(source), "exec"), namespace)
                namespace["_report_emitter"]._emit = sink
                namespace["_emit_report"](force=True)
                before = json.loads((context / "report-card.json").read_text())
                ticker = asyncio.create_task(asyncio.Event().wait())
                namespace["_report_ticker_task"] = ticker
                try:
                    if grade.startswith("cleanup-"):
                        with pytest.raises(type(error)) as caught:
                            await namespace["_finish_native_report"]()
                        assert caught.value is error, "output failure replaced the original cleanup exception"
                    else:
                        await namespace["_finish_native_report"]()
                finally:
                    ticker.cancel()
                    await asyncio.gather(ticker, return_exceptions=True)
            history.assert_called_once()
            hub.assert_called_once()
            dial.assert_not_called()
            connect.assert_not_called()
            connect_ex.assert_not_called()
            card = json.loads((context / "report-card.json").read_text())
            canonical = json.loads((context / "run.json").read_text())
            expected = "failed" if grade.startswith("cleanup-") else grade
            assert card["per_task"][0]["status"] == expected, "terminal report retained pre-cleanup PASS after canonical ERROR"
            assert card["results"]["passed"] == int(expected == "passed")
            assert card["results"]["failed"] == int(expected == "failed")
            assert card["results"]["cancelled"] == int(expected == "cancelled")
            assert canonical["tasks"][0]["passed"] is (expected == "passed")
            assert card["per_task"][0]["agent_id"] == ROOT
            assert card["source_sha"] == before["source_sha"] == "a"*40
            assert card["started_at"] == before["started_at"] and card["finished_at"] == before["finished_at"]
            assert card["per_task"][0]["tokens_in"] == 194195 and card["per_task"][0]["cost_usd"] == .02


@async_case
async def test_terminal_report_refreshes_after_owned_cleanup_final_grade():
    await _assert_terminal_report_final_grade(("cleanup-error", "passed", "failed", "cancelled", "passed-closed"))


@async_case
async def test_terminal_report_closed_sink_preserves_cleanup_runtime_error():
    await _assert_terminal_report_final_grade(("cleanup-error-closed",))


@async_case
async def test_terminal_report_closed_sink_preserves_real_cleanup_cancellation():
    await _assert_terminal_report_final_grade(("cleanup-cancelled-closed",))


@async_case
async def test_terminal_failed_setup_intent_requires_external_custody():
    failed = {"purchase_id": "00000000-0000-4000-8000-000000000003", "agent_id": ROOT,
              "user_id": ROOT, "stripe_livemode": False, "stripe_customer_id": "cus_owned",
              "status": "FAILED", "card_id": None, "stripe_payment_intent_id": "pi_initial",
              "total_cents": 4396, "funding_status": None, "provider_transfer_id": None,
              "reclaim_provider_transfer_id": None}
    paid = {**failed, "purchase_id": "00000000-0000-4000-8000-000000000004", "status": "CLEARED",
            "card_id": "card_owned", "stripe_payment_intent_id": "pi_paid", "funding_status": "CONSUMED"}
    def proof(row, outcome):
        return {"purchaseId": row["purchase_id"], "userId": ROOT, "agentId": ROOT,
                "purchaseStatus": row["status"], "paymentIntentId": row["stripe_payment_intent_id"],
                "customerId": "cus_owned", "livemode": False, "status": "canceled" if outcome == "unspent" else "succeeded",
                "currency": "usd", "amountCents": 4396, "amountReceivedCents": 0 if outcome == "unspent" else 4396,
                "amountCapturableCents": 0, "refundedCents": 0, "outcome": outcome}
    snapshot = {"root_user_id": ROOT, "tree_agent_ids": [ROOT], "purchase_cleanup": [failed, paid]}
    observations = [proof(failed, "unspent"), proof(paid, "paid")]
    fetch = AsyncMock(return_value={"agentId": ROOT, "stripeCustody": observations})
    with patch.object(cleanup, "exact_root_sessions", return_value=snapshot), patch.object(bench, "get_test_payment_lifecycle", fetch):
        result = await bench._finalize_owned_root_payments("http://localhost:1", ROOT, {})
        fetch.assert_awaited_once_with("http://localhost:1", ROOT, stripe_custody=True)
        assert result["stripe_custody"] == observations
        for field, value in [("livemode", True), ("customerId", "cus_foreign"), ("userId", CHILD),
                             ("status", "requires_capture"), ("amountCapturableCents", 4396),
                             ("paymentIntentId", "pi_foreign"), ("amountReceivedCents", 4396)]:
            broken = copy.deepcopy(observations); broken[0][field] = value
            fetch.return_value = {"agentId": ROOT, "stripeCustody": broken}
            with pytest.raises(RuntimeError, match="custody"):
                await bench._finalize_owned_root_payments("http://localhost:1", ROOT, {})
        refunded = copy.deepcopy(observations)
        refunded[0].update(status="succeeded", outcome="refunded", amountReceivedCents=4396, refundedCents=4396)
        fetch.return_value = {"agentId": ROOT, "stripeCustody": refunded}
        assert (await bench._finalize_owned_root_payments("http://localhost:1", ROOT, {}))["stripe_custody"] == refunded
        refunded[0]["refundedCents"] = 4395
        with pytest.raises(RuntimeError, match="custody"):
            await bench._finalize_owned_root_payments("http://localhost:1", ROOT, {})
        fetch.return_value = {"agentId": ROOT, "stripeCustody": observations[1:]}
        with pytest.raises(RuntimeError, match="custody"):
            await bench._finalize_owned_root_payments("http://localhost:1", ROOT, {})


def _native_world_receipt_fixture(scenario):
    """Execute native provisioning, validation, manifest writer and EXIT cleanup; vendors are fake."""
    import subprocess
    source = (Path(__file__).resolve().parents[2] / "scripts/run.sh").read_text()
    writer_start = source.index("write_services_manifest() {")
    writer = source[writer_start:source.index("\n# ── World Model Harness", writer_start)]
    cleanup_start = source.index("\ncleanup() {", writer_start) + 1
    cleanup_end = source.index("\nrun_install_teardown_signal_traps", cleanup_start)
    native_cleanup_and_trap = source[cleanup_start:cleanup_end]
    provision_start = source.index('if [ "${BENCHMARK_AGENTCARD_WORLD_IDENTITY:-}" = "true" ]; then')
    provision = source[provision_start:source.index('\nBACKEND_PID=""', provision_start)]
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        (root / "back-end").mkdir()
        context = root / "context"
        context.mkdir()
        manifest = context / "services.json"
        manifest.write_text(json.dumps({"status": "starting", "retained": "must-be-replaced"}))
        # An inherited receipt must never publish a previous world's identity on a failed setup.
        old_receipt = context / "old-world.json"
        old_receipt.write_text(json.dumps({"version": 1, "worldId": "foreign-world", "providerUserId": "usr_old", "livemode": False, "fundsSource": "company_flow"}))
        stubs = r'''
NAMES=(); PIDS=()
SHUTTING_DOWN=false
SERVICE_STATUS=starting
DB_CONTAINER=''; DB_VOLUME=''; DB_OWNED_BY_US=false; USE_SYSTEM_PG=false
SYSTEM_DB_OWNED_BY_US=false; LOCAL_DB_NAME=owned_fixture; LOCAL_DB_ACTUAL_PORT=5432
BENCHMARK_ISOLATED_RUN=true; BENCHMARK_MODE=true
NGROK_CONFIG_FILE=''; FAIL_DIR=''
run_ignore_repeated_teardown_signals() { :; }
stop_stack_owner_watch() { :; }
run_publish_stack_cleanup_status() { printf '%s\n' "$1" >> "$RUN_CONTEXT_DIR/cleanup-status.txt"; }
run_drain_owned_agents() { return 0; }
release_seed_lock_if_held() { :; }
remove_isolated_frontend_build() { :; }
node() {
    printf '%s\n' "${BENCHMARK_AGENTCARD_WORLD_RECEIPT-unpublished}" > "$RUN_CONTEXT_DIR/receipt-during-provision.txt"
    [ "$FIXTURE_SCENARIO" != setup-missing ] || return 17
    python3 - "${@: -1}" "$FIXTURE_SCENARIO" <<'PY_FIXTURE_RECEIPT'
import json,sys
from pathlib import Path
path,scenario=Path(sys.argv[1]),sys.argv[2]
row={"version":1,"worldId":"owned-world","providerUserId":"usr_owned","livemode":False,"fundsSource":"company_flow"}
if scenario=="wrong-world": row["worldId"]="foreign-world"
if scenario=="wrong-mode": row["livemode"]=True
if scenario=="legacy-alias": row["providerUserId"]="cm_legacy"
path.write_text("{" if scenario=="malformed" else json.dumps(row))
PY_FIXTURE_RECEIPT
    [ "$FIXTURE_SCENARIO" != setup-written ] || return 17
}
'''
        script = "set -eu\n" + stubs + writer + native_cleanup_and_trap + "\n" + provision + "\nSERVICE_STATUS=running\nwrite_services_manifest\n"
        env = {"PATH": os.environ["PATH"], "RUN_CONTEXT_DIR": str(context),
               "BENCHMARK_AGENTCARD_WORLD_IDENTITY": "true", "BENCHMARK_RUN_ID": "owned-world",
               "BENCHMARK_AGENTCARD_WORLD_RECEIPT": str(old_receipt),
               "BENCHMARK_AGENTCARD_V2_USER_ID": "usr_old", "FIXTURE_SCENARIO": scenario}
        result = subprocess.run(["bash", "-c", script], cwd=root, env=env, capture_output=True, text=True, timeout=5)
        return result, json.loads(manifest.read_text()), (context / "cleanup-status.txt").read_text().splitlines(), (context / "receipt-during-provision.txt").read_text().strip()


def test_native_world_receipt_failure_still_publishes_stopped_manifest():
    result, manifest, statuses, _ = _native_world_receipt_fixture("setup-missing")
    assert result.returncode != 0
    assert manifest["status"] == "stopped", result.stderr
    assert "agentcard_world_identity" not in manifest
    assert statuses == ["pending", "clean"]


def test_native_world_receipt_validation_rejects_before_publication():
    for scenario in ("setup-written", "malformed", "wrong-world", "wrong-mode", "legacy-alias"):
        result, manifest, statuses, during = _native_world_receipt_fixture(scenario)
        assert result.returncode != 0, scenario
        assert manifest["status"] == "stopped", (scenario, result.stderr)
        assert "agentcard_world_identity" not in manifest, scenario
        assert statuses == ["pending", "clean"], scenario
        assert during == "unpublished", scenario


def test_native_world_receipt_success_publishes_only_validated_exact_identity():
    result, manifest, statuses, during = _native_world_receipt_fixture("valid")
    assert result.returncode == 0, result.stderr
    assert during == "unpublished"
    assert manifest["status"] == "stopped"
    assert manifest["agentcard_world_identity"] == {"version":1,"worldId":"owned-world","providerUserId":"usr_owned","livemode":False,"fundsSource":"company_flow"}
    assert statuses == ["pending", "clean"]
