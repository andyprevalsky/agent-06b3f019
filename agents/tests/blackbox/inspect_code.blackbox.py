"""Blackbox tests for inspect_code: explore's read-only look inside a code agent's workspace.

  explore activity (real spawn_explore_agent_activity, scripted run_agent)
    └─ inspect_code ─► InspectCodeManager ─► inspect_code_activity
         └─ POST /api/claude-code-session/code-sessions/:id/inspect   (mocked backend)

Covers: the tool is offered to explore (and only explore), the backend call is
owner-scoped by the caller's user and agent, an answer becomes grounded explore
evidence with its verified citations, and refusals/timeouts become tool errors.
The backend half (restore, guards, teardown, owner checks) is
back-end/src/tests/blackbox/code-session-inspect.blackbox.ts.
"""

import asyncio
import json
from unittest.mock import patch

import httpx
from _test_utils import BlackboxResult, get_captured_requests, setup_mock_fn, teardown_mock

SESSION_ID = "6f1c2d3e-4b5a-4968-8778-695a4b3c2d1e"
AGENT_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
USER_ID = "user-inspect-1"
BACKEND = "https://backend.inspect-test.invalid"

ANSWERED = {
    "status": "answered",
    "code_session_id": SESSION_ID,
    "checkpoint_seq": 3,
    "checkpoint_created_at": "2026-10-20T20:00:00.000Z",
    "provider": "claude",
    "branch": "rose/feature-1",
    "head": "0123456789abcdef0123456789abcdef01234567",
    "work_dir": "workspace",
    "answer": "feature.txt holds: committed locally\n\nCitations:\n- feature.txt:1\n- nowhere.ts:9",
    "citations": [{"path": "feature.txt", "line": 1, "end_line": None}],
    "unverified_citations": ["nowhere.ts:9"],
    "error": None,
    "resets_at": None,
    "sandbox_id": "sb-1",
    "timings": {"startup_ms": 900, "total_ms": 4000},
}


def _backend(inspect_response: httpx.Response | Exception):
    """Mock backend: the inspect route answers as given; FE message posts succeed."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith(f"/code-sessions/{SESSION_ID}/inspect"):
            if isinstance(inspect_response, Exception):
                raise inspect_response
            return inspect_response
        return httpx.Response(200, json={})

    setup_mock_fn(handler)


def _inspect_calls():
    return [c for c in get_captured_requests() if "/inspect" in c["url"]]


async def _in_activity(fn, **kwargs):
    """Run inside an activity context, as the explore activity does (FE posts heartbeat)."""
    from temporalio.testing import ActivityEnvironment

    async def body():
        return await fn(**kwargs)

    return await ActivityEnvironment().run(body)


async def test_inspect_code_is_an_explore_tool_only():
    """Explore gets inspect_code; root and sub-agents reach it through spawn_agent(type='explore')."""
    from tools.prompts import TOOL_PROMPTS
    from utils.tool_schemas import (
        EXECUTE_PHASE_TOOLS,
        PLAN_PHASE_TOOLS,
        TOOL_MODELS,
        InspectCodeTool,
        create_agent_action_model,
        get_explore_agent_tools,
    )

    assert "inspect_code" in get_explore_agent_tools()
    assert TOOL_MODELS["inspect_code"] is InspectCodeTool
    assert "inspect_code" not in PLAN_PHASE_TOOLS and "inspect_code" not in EXECUTE_PHASE_TOOLS
    assert "inspect_code" in TOOL_PROMPTS
    model = create_agent_action_model(get_explore_agent_tools())
    action = model.model_validate(
        {
            "response": "",
            "tool_calls": [{"tool": "inspect_code", "code_session_id": SESSION_ID, "question": "What changed?"}],
        }
    )
    assert action.tool_calls[0].tool == "inspect_code"
    schema = InspectCodeTool.model_json_schema()
    assert schema["required"] == ["tool", "code_session_id", "question"]
    assert TOOL_PROMPTS["spawn_agent"].count("code_session_id") >= 1, "root learns explore can inspect code"


async def test_explore_runs_inspect_code_against_the_backend():
    """The real explore activity offers inspect_code and turns its answer into grounded evidence."""
    from temporalio.testing import ActivityEnvironment

    from domains.spawn_agent.service import spawn_explore_agent_activity

    _backend(httpx.Response(200, json=ANSWERED))
    seen: dict = {}

    async def scripted_run_agent(**kwargs):
        seen["tools"] = kwargs["tools"]
        seen["inspect"] = await kwargs["execute_tool"](
            "inspect_code", {"code_session_id": SESSION_ID, "question": "What does feature.txt say?"}, "tc-inspect"
        )
        return {"status": "completed", "final_response": "feature.txt holds: committed locally [1]"}

    with (
        patch.dict("os.environ", {"BACKEND_API_URL": BACKEND}),
        patch("loop.run_agent.run_agent", new=scripted_run_agent),
    ):
        result = await ActivityEnvironment().run(
            spawn_explore_agent_activity,
            agent_id=AGENT_ID,
            user_id=USER_ID,
            goal=f"What does feature.txt say in code session {SESSION_ID}?",
            model="m",
        )

    assert "inspect_code" in seen["tools"]
    assert seen["inspect"]["success"] is True, seen["inspect"]
    message = seen["inspect"]["message"]
    assert "feature.txt holds: committed locally" in message
    assert "Verified citations: feature.txt:1" in message
    assert "Not found in the checkpoint: nowhere.ts:9" in message
    assert "branch rose/feature-1 @ 0123456789ab" in message

    calls = _inspect_calls()
    assert len(calls) == 1, calls
    call = calls[0]
    assert call["method"] == "POST"
    assert call["url"] == f"{BACKEND}/api/claude-code-session/code-sessions/{SESSION_ID}/inspect"
    headers = {k.lower(): v for k, v in call["requestHeaders"].items()}
    assert headers["x-user-id"] == USER_ID, "owner scoping uses the caller's user"
    body = json.loads(call["requestBody"])
    assert body["agent_id"] == AGENT_ID, "and the calling agent"
    assert body["question"] == "What does feature.txt say?"

    assert result["status"] == "completed", result
    assert any(
        text.startswith("[inspect_code]") and "committed locally" in text for text in result["tool_call_results"]
    )


async def test_refusals_and_failures_are_tool_errors():
    """404 / 409 / usage limits / a failed CLI come back as tool errors, never as evidence."""
    from domains.inspect_code.service import execute_inspect_code
    from loop.activity_helper import call_temporal_activity_from_activity

    cases = [
        (httpx.Response(404, json={"error": "Code session not found", "code": "CODE_SESSION_NOT_FOUND"}), "not found"),
        (httpx.Response(409, json={"error": "This code session has no checkpoint yet"}), "no checkpoint"),
        (
            httpx.Response(
                200, json={**ANSWERED, "status": "usage_limited", "answer": None, "resets_at": "2026-10-21T01:00:00Z"}
            ),
            "usage limit until 2026-10-21T01:00:00Z",
        ),
        (
            httpx.Response(
                200, json={**ANSWERED, "status": "failed", "answer": None, "error": "the inspection CLI timed out"}
            ),
            "timed out",
        ),
    ]
    with patch.dict("os.environ", {"BACKEND_API_URL": BACKEND}):
        for response, expected in cases:
            _backend(response)
            out = await _in_activity(
                execute_inspect_code,
                execute_activity=call_temporal_activity_from_activity,
                tool_call={"code_session_id": SESSION_ID, "question": "Anything?"},
                tool_call_id="tc-x",
                agent_id=AGENT_ID,
                user_id=USER_ID,
            )
            assert "result" not in out, out
            assert expected in out["error"], (expected, out)
            assert len(_inspect_calls()) == 1, "a refusal is not retried"
            teardown_mock()

        missing = await _in_activity(
            execute_inspect_code,
            execute_activity=call_temporal_activity_from_activity,
            tool_call={"code_session_id": SESSION_ID, "question": "  "},
            tool_call_id="tc-y",
            agent_id=AGENT_ID,
            user_id=USER_ID,
        )
        assert "needs a code_session_id" in missing["error"]


async def test_timeout_is_an_error_and_not_retried():
    """A timed-out inspection is bounded by the backend; asking again would start a second sandbox."""
    from domains.inspect_code.repo import inspect_code_activity
    from domains.inspect_code.service import execute_inspect_code
    from loop.activity_helper import call_temporal_activity_from_activity

    with patch.dict("os.environ", {"BACKEND_API_URL": BACKEND}):
        _backend(httpx.ReadTimeout("slow"))
        out = await inspect_code_activity(SESSION_ID, "q", USER_ID, AGENT_ID)
        assert out["code"] == "CODE_INSPECT_TIMEOUT", out
        teardown_mock()
        _backend(httpx.ReadTimeout("slow"))
        tool = await _in_activity(
            execute_inspect_code,
            execute_activity=call_temporal_activity_from_activity,
            tool_call={"code_session_id": SESSION_ID, "question": "q"},
            tool_call_id="tc-t",
            agent_id=AGENT_ID,
            user_id=USER_ID,
        )
        assert "did not finish" in tool["error"]
        assert len(_inspect_calls()) == 1


async def run_all_tests():
    print("inspect-code blackbox tests:")
    r = BlackboxResult()
    await r.record_async("inspect_code_is_an_explore_tool_only", test_inspect_code_is_an_explore_tool_only)
    await r.record_async(
        "explore_runs_inspect_code_against_the_backend", test_explore_runs_inspect_code_against_the_backend
    )
    teardown_mock()
    await r.record_async("refusals_and_failures_are_tool_errors", test_refusals_and_failures_are_tool_errors)
    teardown_mock()
    await r.record_async("timeout_is_an_error_and_not_retried", test_timeout_is_an_error_and_not_retried)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
