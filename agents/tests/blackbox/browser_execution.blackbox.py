"""Explicit browser-surface admission and native lifecycle controls (offline)."""
import asyncio
import contextlib
import logging
from unittest.mock import AsyncMock, patch

from _test_utils import BlackboxResult, set_mock_handler, teardown_mock
import httpx


async def test_polar_create_binds_browser_without_changing_task():
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks import run_benchmark as runner
    sent = []
    def handler(request):
        import json
        if request.method == "POST":
            sent.append(json.loads(request.content))
            return httpx.Response(201, json={"agent_id": "browser-root"})
        return httpx.Response(200, json={"agent": {"write_lock_enabled": False}})
    set_mock_handler(handler)
    try:
        with patch.object(runner, "_api_headers", AsyncMock(return_value={})), patch.object(runner, "_local_benchmark_task_queue", return_value=None), patch.object(runner, "_frontend_url_for_benchmark", return_value="http://localhost:3002"):
            task = get_task_by_name("polar-bu-074")
            original = (task.prompt, list(task.expected_tools), dict(task.max_steps), task.start_phase)
            await runner.create_agent("http://localhost:3001", task)
        assert sent[0]["goal"] == task.prompt
        assert sent[0]["start_phase"] == "browser", sent[0]
        assert original == (task.prompt, task.expected_tools, task.max_steps, task.start_phase)
    finally:
        teardown_mock()


@contextlib.contextmanager
def native_owner(*, browser_success=True, handoff=False, receipt=True):
    from workflows.agent_workflow import AgentWorkflow
    from temporalio import workflow
    from tools.base import ToolEvent, EventType, MessageStatus
    owner = AgentWorkflow()
    owner.agent_id = "parent"
    owner.user_id = "user"
    owner.goal = "According to github, when was Regression added to the oldest closed numpy.polynomial issue that has the Regression label in MM/DD/YY?"
    owner.model = "rose-1-ultra"
    owner.current_phase = "EXECUTE"
    owner.max_iterations = None
    owner.context_gates = {}
    owner.output_schema = {"fields": [{"name": "date", "type": "str", "required": True}]}
    owner._check_credits = AsyncMock()
    owner._prepare_response_schema_continuation = AsyncMock()
    owner._response_schema_user_messages = AsyncMock(side_effect=lambda **kwargs: [owner.goal, *owner._response_schema_feedback])
    owner._post_message = AsyncMock()
    owner._update_tree_state = AsyncMock()
    owner._attempt_post_dag_completion = AsyncMock(return_value={"score": 1, "structured_response": {"date": "04/15/18"}})
    calls = []
    async def executor(name, args, call_id):
        calls.append((name, dict(args), call_id, owner._take_tool_resume(call_id)))
        if handoff:
            assert owner._park_pending_tool(call_id, {"stage": "activity", "task_id": "native-task"})
            return {"generation_handoff": True, "handoff_task_queue": "next-queue"}
        await owner._handle_tool_event(ToolEvent(
            type=EventType.POST_MESSAGE, title="Browser complete", message="Native result", status=MessageStatus.FINISHED,
            metadata={"toolName": "spawn_browser_agent", "action_type": "task_complete", "success": browser_success,
                      "browser_instruction_receipt": {"message_ids": list(owner._browser_execution_pending_input_ids), "read_confirmed": True, "schema_current": True} if receipt else {}},
        ), call_id, "spawn_browser_agent")
        return {"success": True}
    owner._execute_tool = executor
    async def wait_condition(predicate, **kwargs):
        for _ in range(100):
            if predicate():
                return
            await asyncio.sleep(0)
        raise AssertionError("native task did not settle")
    async def event_edge(**kwargs):
        pass
    with patch.object(workflow, "logger", logging.getLogger("browser-execution-test")), patch.object(workflow, "wait_condition", wait_condition), patch("workflows.agent_workflow.handle_tool_event", event_edge), patch("workflows.background_agents.resolve_own_task_path", AsyncMock(return_value="/root")):
        yield owner, calls


def source_rows():
    return [{"role": "USER", "message_id": "request-1", "text": "original task", "metadata": {}}]


async def test_native_browser_result_owns_completion_and_is_idempotent():
    from workflows.browser_execution import run_browser_execution
    with native_owner() as (owner, calls):
        result = await run_browser_execution(owner, source_rows())
        assert result["status"] == "completed"
        assert len(calls) == 1
        assert calls[0][0] == "spawn_agent"
        assert calls[0][1]["type"] == "browser"
        assert calls[0][1]["goal"] == owner.goal
        assert calls[0][1]["output_schema"] == owner.output_schema
        assert calls[0][1]["start_url"] == "about:blank"
        task_id = calls[0][2]
        assert owner._background_finished[task_id]["browser_verified"] is True
        again = await run_browser_execution(owner, source_rows())
        assert again["status"] == "completed" and len(calls) == 1


async def test_clean_auth_decline_is_not_verified_browser_success():
    from workflows.browser_execution import run_browser_execution
    with native_owner(browser_success=False) as (owner, calls):
        result = await run_browser_execution(owner, source_rows())
        assert result["status"] == "error"
        owner._attempt_post_dag_completion.assert_not_awaited()
        assert len(calls) == 1


async def test_native_handoff_retains_dispatch_and_resume_state():
    from workflows.browser_execution import run_browser_execution
    with native_owner(handoff=True) as (owner, calls):
        result = await run_browser_execution(owner, source_rows())
        assert result["status"] == "generation_handoff"
        task_id = owner._browser_execution_task_id
        state = owner._background_state_snapshot()
        assert task_id in owner._background_tasks
    with native_owner() as (next_owner, calls):
        next_owner._browser_execution_task_id = task_id
        next_owner._browser_execution_contract = owner._browser_execution_contract
        next_owner._restore_background_state(state)
        result = await run_browser_execution(next_owner, source_rows())
        assert result["status"] == "completed"
        assert len(calls) == 1 and calls[0][2] == task_id
        assert calls[0][3] == {"stage": "activity", "task_id": "native-task"}


async def test_paused_killed_and_lost_state_never_duplicate_dispatch():
    from workflows.browser_execution import run_browser_execution, browser_execution_identity
    with native_owner() as (owner, calls):
        owner.is_paused = True
        assert (await run_browser_execution(owner, source_rows()))["status"] == "paused"
        owner.is_paused = False
        owner._kill_request = {"killed_by": "/root"}
        assert (await run_browser_execution(owner, source_rows()))["status"] == "aborted"
        owner._kill_request = None
        rows = source_rows()
        rows.append({"role": "TOOL", "metadata": {"backgroundTaskId": browser_execution_identity(owner.agent_id, rows, requirements=[owner.goal], schema=owner.output_schema)}})
        assert (await run_browser_execution(owner, rows))["status"] == "error"
        assert not calls
    assert browser_execution_identity("parent", source_rows(), requirements=["goal"], schema={}) != browser_execution_identity("parent", [{**source_rows()[0], "message_id": "request-2"}], requirements=["goal"], schema={})


async def test_completed_browser_does_not_replay_writes_for_updated_requirements():
    from workflows.browser_execution import run_browser_execution
    with native_owner() as (owner, calls):
        await run_browser_execution(owner, source_rows())
        owner._response_schema_feedback = ["Use UTC dates", "Also include the issue URL"]
        owner._response_schema_revision = owner._response_schema_accepted_revision = 2
        rows = source_rows() + [{"role": "USER", "message_id": "request-2", "text": "Use UTC dates", "metadata": {}}]
        result = await run_browser_execution(owner, rows)
        assert result["status"] == "error" and "Completed browser" in result["message"]
        assert len(calls) == 1, "completed browser work was replayed"


async def test_paused_native_browser_resumes_same_conversation():
    from workflows.browser_execution import run_browser_execution
    from helpers.background_agents import PAUSED_TASK_STATUS
    with native_owner() as (owner, calls):
        await run_browser_execution(owner, source_rows())
        task_id = calls[0][2]
        owner._background_finished[task_id]["status"] = PAUSED_TASK_STATUS
        result = await run_browser_execution(owner, source_rows())
        assert result["status"] == "completed"
        assert len(calls) == 2 and calls[1][2] == task_id
        assert calls[1][1]["_resume_paused_conversation"]["inbox_address"] == task_id
        assert owner._background_finished[task_id]["run"] == 2


async def test_real_post_executor_supersession_continues_without_failing():
    import workflows.agent_workflow as module
    from workflows.browser_execution import run_browser_execution
    from temporalio import workflow
    class Continued(BaseException):
        pass
    continuation = []
    def continue_as_new(**kwargs):
        continuation.append(kwargs)
        raise Continued()
    with native_owner() as (owner, calls):
        # Exercise the real completion tool/poll/verifier wrapper. Only its
        # provider call and database boundary are replaced by deterministic edges.
        del owner._attempt_post_dag_completion
        owner._refresh_compute_token = AsyncMock()
        owner._make_verifier_prompt_generator = lambda: AsyncMock(return_value="Verify the browser result")
        owner._make_response_schema_getter = lambda: None
        from types import SimpleNamespace
        owner._dag_hooks = lambda: SimpleNamespace(seq=lambda: 0, message_pending=lambda: True)
        owner._track_tokens_and_cost = AsyncMock()
        owner._await_deferred_startup = AsyncMock()
        owner._drain_fast_mode_explores = AsyncMock()
        owner._flush_pending_messages = AsyncMock()
        owner._mark_complete = AsyncMock()
        owner._mark_failed = AsyncMock()
        owner._continuation_args = lambda context, **kwargs: ["continued", kwargs["start_phase"]]
        real_executor = owner._execute_tool
        async def executor(name, args, call_id):
            if name == "attempt_completion":
                calls.append((name, args, call_id, None))
                return {}
            return await real_executor(name, args, call_id)
        owner._execute_tool = executor
        with patch.object(workflow, "execute_activity", AsyncMock(return_value=source_rows())), patch.object(workflow, "uuid4", return_value="attempt-id"), patch.object(workflow, "continue_as_new", continue_as_new):
            result = await run_browser_execution(owner, source_rows())
            assert result["score"] == 0 and result["superseded_by_user_feedback"] is True
            assert result["interrupted_by_message"] is True
            assert calls[-1][0] == "attempt_completion"
            try:
                await owner._finish_execute_result(result)
            except Continued:
                pass
            else:
                raise AssertionError("superseded verdict was accepted")
        assert continuation and continuation[0]["args"] == ["continued", "execute_continued"]
        owner._mark_complete.assert_not_awaited()
        owner._mark_failed.assert_not_awaited()


async def test_initial_workflow_and_continue_restore_browser_mode():
    import runpy
    from pathlib import Path
    import workflows.agent_workflow as module
    support = runpy.run_path(str(Path(module.__file__).parents[1] / "tests/blackbox/workflow.blackbox.py"))
    fake = support["_FakeWorkflowModule"]()
    schema = {"fields": [{"name": "date", "type": "str", "required": True}]}
    fake.activity_returns.update({
        "poll_new_messages": source_rows(),
        "get_model_context_window": 200_000,
        "get_agent_source": "WEB", "get_user_context": "",
        "fetch_agent_config": {"response_schema": schema, "write_lock_enabled": True},
        "generate_completion_summary": {"summary": "done", "tool_counts": {}, "usage": {}},
    })
    state = None
    for phase in ("browser", "execute_continued", "resume"):
        with native_owner() as (owner, calls), patch.object(module, "workflow", fake):
            owner._run_agent_turns = AsyncMock(side_effect=AssertionError("free root loop entered"))
            owner._mark_complete = AsyncMock()
            result = await owner.run(owner.agent_id, owner.user_id, owner.goal, owner.model, 256,
                {"type": "FLOAT_LLM_JUDGE"}, start_phase=phase, resume_state=state)
            assert result["status"] == "completed", result
            assert owner._browser_execution_mode is True
            assert len(calls) == (1 if state is None else 0)
            owner._run_agent_turns.assert_not_awaited()
            state = owner._continuation_resume_state(source_rows())
            assert state["runtime_state"]["browser_execution_mode"] is True
            assert state["runtime_state"]["browser_execution_task_id"]


async def test_canonical_requirements_signal_row_replay_is_one_dispatch():
    from workflows.browser_execution import run_browser_execution
    from temporalio import workflow
    with native_owner() as (owner, calls):
        del owner._response_schema_user_messages
        rows = [{**source_rows()[0], "text": owner.goal}]
        with patch.object(workflow, "execute_activity", AsyncMock(side_effect=lambda *args, **kwargs: rows)):
            await run_browser_execution(owner, rows)
            assert calls[0][1]["goal"] == owner.goal
            owner._record_response_schema_feedback("Use the updated date", request_id="attention-1", authored=True)
            owner._response_schema_accepted_revision = owner._response_schema_revision
            from helpers.background_agents import PAUSED_TASK_STATUS
            owner._background_finished[calls[0][2]]["status"] = PAUSED_TASK_STATUS
            rows.append({"role": "USER", "message_id": "attention-row", "text": "Use the updated date", "metadata": {"source": "attention_response", "attentionRequestId": "attention-1"}})
            updated = await run_browser_execution(owner, rows)
            assert updated["status"] == "completed", updated
            second = calls[1][2]
            await run_browser_execution(owner, rows)
        assert len(calls) == 2 and owner._browser_execution_task_id == second
        assert calls[1][1]["_resume_paused_conversation"]


async def test_ordinary_failed_verifier_is_not_promoted_to_completion():
    from workflows.browser_execution import run_browser_execution
    with native_owner() as (owner, calls):
        owner._attempt_post_dag_completion = AsyncMock(return_value={"score": 0, "reasoning": "Incorrect answer"})
        result = await run_browser_execution(owner, source_rows())
        assert result["status"] == "error" and result["message"] == "Incorrect answer"
        assert len(calls) == 1


async def test_new_requirements_settle_old_native_handoff_before_new_dispatch():
    from workflows.browser_execution import run_browser_execution
    with native_owner(handoff=True) as (owner, calls):
        assert (await run_browser_execution(owner, source_rows()))["status"] == "generation_handoff"
        state = owner._continuation_resume_state(source_rows())
        old_id = owner._browser_execution_task_id
    with native_owner() as (resumed, calls):
        resumed._restore_deployment_state(state)
        resumed._response_schema_feedback = ["Use the new date"]
        resumed._response_schema_revision = resumed._response_schema_accepted_revision = 1
        rows = source_rows() + [{"role": "USER", "message_id": "new-request", "text": "Use the new date", "metadata": {}}]
        resumed.context = rows
        updated = await run_browser_execution(resumed, rows)
        assert updated["status"] == "completed", updated
        assert len(calls) == 1
        assert calls[0][2] == old_id and calls[0][3] == {"stage": "activity", "task_id": "native-task"}
        assert old_id not in resumed._background_tasks
        assert resumed._background_finished[old_id]["status"] == "completed"


async def test_new_requirements_settle_paused_native_browser_first():
    from workflows.browser_execution import run_browser_execution
    from helpers.background_agents import PAUSED_TASK_STATUS
    with native_owner() as (owner, calls):
        await run_browser_execution(owner, source_rows())
        old_id = calls[0][2]
        owner._background_finished[old_id]["status"] = PAUSED_TASK_STATUS
        owner._response_schema_feedback = ["Use the new date"]
        owner._response_schema_revision = owner._response_schema_accepted_revision = 1
        rows = source_rows() + [{"role": "USER", "message_id": "new-date", "text": "Use the new date", "metadata": {}}]
        assert (await run_browser_execution(owner, rows))["status"] == "completed"
        assert len(calls) == 2
        assert calls[1][2] == old_id and "_resume_paused_conversation" in calls[1][1]


async def test_feedback_during_requirement_read_waits_for_accepted_schema():
    from workflows.browser_execution import run_browser_execution
    with native_owner() as (owner, calls):
        reads = 0
        async def requirements(**kwargs):
            nonlocal reads
            reads += 1
            if reads == 1:
                owner._response_schema_revision = 1
                owner._response_schema_feedback = ["Include an issue URL"]
                return [owner.goal, "Include an issue URL"]
            return [owner.goal, *owner._response_schema_feedback]
        async def prepare():
            if owner._response_schema_revision == 1:
                assert not calls, "browser launched before schema acceptance"
                owner.output_schema = {"fields": [{"name": "url", "type": "str", "required": True}]}
                owner._response_schema_accepted_revision = 1
        owner._response_schema_user_messages = requirements
        owner._prepare_response_schema_continuation = prepare
        assert (await run_browser_execution(owner, source_rows()))["status"] == "completed"
        assert reads == 2 and len(calls) == 1
        assert calls[0][1]["output_schema"]["fields"][0]["name"] == "url"
    for stopped in ("pause", "kill"):
        with native_owner() as (owner, calls):
            async def stop_during_read(**kwargs):
                if stopped == "pause": owner.is_paused = True
                else: owner._kill_request = {"killed_by": "/root"}
                return [owner.goal]
            owner._response_schema_user_messages = stop_during_read
            result = await run_browser_execution(owner, source_rows())
            assert result["status"] == ("paused" if stopped == "pause" else "aborted")
            assert not calls


async def test_native_final_sync_receipt_survives_real_manager():
    import runpy
    from pathlib import Path
    from types import SimpleNamespace
    from domains.spawn_browser_agent_v3 import handler as browser
    support = runpy.run_path(str(Path(browser.__file__).parents[2] / "tests/blackbox/spawn_browser_agent_v3.blackbox.py"))
    @support["_in_browser_activity_context"]
    async def replay():
        actual = await support["_run_browser_durable_user_feedback_replay"](verifier_feedback="pass")
        result = actual["result"]
        receipt = result["browser_instruction_receipt"]
        assert receipt["read_confirmed"] is True and receipt["schema_current"] is True
        assert "70979068-bddc-4fb1-9e47-35a5cfcd2d87" in receipt["message_ids"]
        assert len(actual["verifier_calls"]) == 2, "late input did not invalidate first browser verdict"
        wf = SimpleNamespace(user_id="user-1", agent_id="agent-1", is_paused=False, write_lock_enabled=True,
                             system_name="Rose", _check_generation_handoff=AsyncMock(return_value=None))
        with patch.object(browser.workflow, "start_activity", return_value=support["_SequencedActivityHandle"](result)), patch.object(browser.workflow, "wait_condition", AsyncMock(return_value=None)):
            events = [event async for event in browser.SpawnBrowserAgentManagerV3().execute_tool(wf, {"goal": "Read calendar", "output_schema": actual["initial_schema"]}, "tool-1")]
        terminal = [event for event in events if (getattr(event, "metadata", None) or {}).get("action_type") == "task_complete"]
        assert terminal and terminal[-1].metadata["browser_instruction_receipt"] == receipt
    await replay()


async def test_missing_stale_and_unknown_native_receipts_fail_closed():
    from workflows.browser_execution import run_browser_execution
    from domains.spawn_browser_agent_v3.handler import _browser_instruction_receipt
    assert _browser_instruction_receipt({})["read_confirmed"] is False
    stale = _browser_instruction_receipt({"_user_instruction_poll_confirmed": True, "user_instruction_message_ids": ["new-input"], "user_instruction_messages": [{"role": "user", "content": "updated"}], "schema_user_instruction_count": 0})
    assert stale["schema_current"] is False
    for receipt in ({}, stale, {"read_confirmed": True, "schema_current": True, "message_ids": []}):
        with native_owner(handoff=True) as (prior, _):
            await run_browser_execution(prior, source_rows())
            state = prior._continuation_resume_state(source_rows())
        with native_owner(receipt=False) as (owner, calls):
            owner._restore_deployment_state(state)
            owner._response_schema_feedback = ["Updated task"]
            owner._response_schema_revision = owner._response_schema_accepted_revision = 1
            owner.context = source_rows() + [{"role": "USER", "message_id": "new-input", "text": "Updated task", "metadata": {}}]
            native = owner._execute_tool
            async def execute(name, args, call_id):
                result = await native(name, args, call_id)
                owner._background_outcomes[call_id]["browser_instruction_receipt"] = receipt
                return result
            owner._execute_tool = execute
            result = await run_browser_execution(owner, owner.context)
            assert result["status"] == "error" and "acknowledge" in result["message"]
            assert len(calls) == 1, "unacknowledged input replayed browser work"
            owner._attempt_post_dag_completion.assert_not_awaited()


async def test_input_after_browser_final_sync_cannot_be_accepted_by_root_verifier():
    from workflows.browser_execution import run_browser_execution
    from loop.run_agent import _requirement_keys
    for boundary in ("join", "verifier"):
        with native_owner() as (owner, calls):
            owner.context = source_rows()
            def deliver():
                owner.context.append({"role": "USER", "message_id": "late-input", "text": "Do not submit that form", "metadata": {}})
                owner._response_schema_revision = owner._response_schema_accepted_revision = 1
            if boundary == "join":
                native_join = owner._await_dag_background_spawn
                async def join(task_id):
                    result = await native_join(task_id)
                    deliver()
                    return result
                owner._await_dag_background_spawn = join
            async def verify(*args):
                if boundary == "verifier": deliver()
                return {"score": 1, "_verified_user_requirement_keys": [list(k) for k in _requirement_keys(owner.context)]}
            owner._attempt_post_dag_completion = verify
            result = await run_browser_execution(owner, source_rows())
            assert result["status"] == "error" and "not acknowledged" in result["message"]
            assert len(calls) == 1, "late input caused replay of completed browser work"


async def run_all_tests():
    result = BlackboxResult()
    for name, test in [
        ("polar_create_browser_surface", test_polar_create_binds_browser_without_changing_task),
        ("native_browser_result_and_idempotency", test_native_browser_result_owns_completion_and_is_idempotent),
        ("browser_decline_not_success", test_clean_auth_decline_is_not_verified_browser_success),
        ("native_browser_handoff", test_native_handoff_retains_dispatch_and_resume_state),
        ("browser_no_duplicate_dispatch", test_paused_killed_and_lost_state_never_duplicate_dispatch),
        ("browser_post_terminal_update_fails_closed", test_completed_browser_does_not_replay_writes_for_updated_requirements),
        ("browser_real_paused_resume", test_paused_native_browser_resumes_same_conversation),
        ("browser_real_completion_supersession", test_real_post_executor_supersession_continues_without_failing),
        ("browser_workflow_entry_and_continuation", test_initial_workflow_and_continue_restore_browser_mode),
        ("browser_canonical_signal_row_replay", test_canonical_requirements_signal_row_replay_is_one_dispatch),
        ("browser_verifier_failure_stays_failed", test_ordinary_failed_verifier_is_not_promoted_to_completion),
        ("browser_update_after_handoff", test_new_requirements_settle_old_native_handoff_before_new_dispatch),
        ("browser_update_after_pause", test_new_requirements_settle_paused_native_browser_first),
        ("browser_requirement_read_race", test_feedback_during_requirement_read_waits_for_accepted_schema),
        ("browser_actual_final_sync_receipt", test_native_final_sync_receipt_survives_real_manager),
        ("browser_receipt_fail_closed", test_missing_stale_and_unknown_native_receipts_fail_closed),
        ("browser_late_verifier_snapshot", test_input_after_browser_final_sync_cannot_be_accepted_by_root_verifier),
    ]:
        await result.record_async(name, test)
    return result.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
