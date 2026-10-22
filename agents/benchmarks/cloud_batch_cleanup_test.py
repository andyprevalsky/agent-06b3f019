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
        AsyncMock(
            return_value=(
                {},
                {
                    "cache_read_input_tokens": 0,
                    "cache_creation_input_tokens": 0,
                    "cache_hit_pct": 0,
                },
            )
        ),
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
        "BenchmarkTask": bench.BenchmarkTask,
        "TaskResult": bench.TaskResult,
        "base_url": "http://fixture.invalid",
        "run_single_task": delegate,
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
        "_report_ticker_task": SimpleNamespace(cancel=lambda: None),
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
    if path in ("cancelled", "raised"):
        with pytest.raises(asyncio.CancelledError if path == "cancelled" else RuntimeError):
            asyncio.run(namespace["_owning_coordinator"]())
        assert events == ["batch-finalize", "batch-closed"] and not evaluated and not signatures
        assert not list(tmp_path.glob("*.pending.json"))
    else:
        asyncio.run(namespace["_owning_coordinator"]())
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

    row = result(ROOT)
    with (
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
            with pytest.raises(RuntimeError, match="owned local stack"):
                cleanup.exact_root_sessions("https://production.example", ROOT)
            payload["purchase_cleanup"] = None
            # Broken payment evidence must fail its own retirement contract
            # without hiding independently valid browser release authority.
            assert cleanup.exact_root_sessions("http://localhost:31001", ROOT, require_deleted=True) == payload
            with pytest.raises(RuntimeError, match="payment evidence"):
                cleanup.pending_root_payments(payload)


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
            patch.object(bench,"get_llm_usage_details",AsyncMock(return_value=({},{"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"cache_hit_pct":0}))),patch.object(bench,"evaluate_task",return_value=(True,None)),
            patch.object(bench,"ensure_payment_lifecycle_cleanup",AsyncMock(return_value=None)),
            patch.object(bench,"collect_logs",AsyncMock(return_value={"messages":[]})),
            patch.object(bench,"finalize_archive_and_score_world_model",AsyncMock(return_value=("archive",None))),
            patch.object(bench,"_should_delete_agent_after_run",return_value=False),
        ]
        with ExitStack() as stack:
            for target in targets:stack.enter_context(target)
            row=await bench.run_single_task("http://localhost:1",task,on_agent_created=lambda name,aid:owned.append(aid))
        assert row.agent_id==(CHILD if mode=="both" else "") and row.passed is (mode=="both")
        assert row.benchmark_status==("PASSED" if mode=="both" else "CANCELLED" if mode=="cancel" else "ERROR")
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
        assert row.benchmark_status==("PASSED" if mode=="both" else "CANCELLED" if mode=="cancel" else "ERROR")

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
            '_run_with_sandbox_payment_lock':bench._run_with_sandbox_payment_lock,'_report_ticker_task':SimpleNamespace(cancel=lambda:None),
            'stop_fly_log_collector':stop_collector,'realtime_started':False,'memory_gate_enabled':False,'owned_batch_cleanup':True,
            '_finalize_owned_cloud_batch':finalize,'_complete_interrupt_cleanup':lambda:None,'_live_task_agent_ids':live,'_wmh_evidence':SimpleNamespace(finalize=lambda:None),
            '_fetch_wmh_retrieval_audit':lambda:None,'cloud_batch_cleanup':SimpleNamespace(contract=lambda:None)})
        code=ast.fix_missing_locations(ast.Module(body=[wrapper,coordinator],type_ignores=[]))
        exec(compile(code,str(bench.__file__),'exec'),namespace)
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
