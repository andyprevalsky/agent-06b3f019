"""Blackbox tests for run_agent assistant/tool persistence invariants."""

import asyncio
from unittest.mock import AsyncMock, patch

from _test_utils import (
    BlackboxResult,
    teardown_mock,
)


class _DummyToolCall:
    def __init__(self, payload):
        self._payload = payload

    def model_dump(self):
        return self._payload


class _DummyLLMResult:
    def __init__(self, response, tool_calls):
        self.response = response
        self.tool_calls = [_DummyToolCall(tc) for tc in tool_calls]


async def _run_single_iteration(tool_calls, detected_tools_ordered):
    from loop.run_agent import run_agent

    posted_messages = []
    executed_tools = []

    async def mock_system_prompt():
        return "System prompt"

    async def mock_verifier_prompt():
        return "Verifier prompt"

    async def mock_post_message(text, role, metadata=None):
        posted_messages.append({
            "text": text,
            "role": role,
            "metadata": metadata,
        })

    async def mock_execute_tool(tool_name, tool_args, tool_call_id):
        executed_tools.append({
            "tool_name": tool_name,
            "tool_args": tool_args,
            "tool_call_id": tool_call_id,
        })
        return {"message": f"{tool_name} complete"}

    async def mock_call_llm_structured_streaming(**kwargs):
        return (
            _DummyLLMResult("", tool_calls),
            {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            detected_tools_ordered,
        )

    with (
        patch("loop.run_agent.call_llm_structured_streaming", new=AsyncMock(side_effect=mock_call_llm_structured_streaming)),
        patch("loop.run_agent.handle_tool_event", new=AsyncMock()),
    ):
        result = await run_agent(
            agent_id="agent-test",
            user_id="user-test",
            system_prompt=mock_system_prompt,
            verifier_prompt_generator=mock_verifier_prompt,
            model="rose-labs/rose-1-lite",
            tools=["web_search", "web_fetch"],
            initial_context=[{"role": "USER", "text": "Find updates", "timestamp": "2024-01-01T00:00:00Z"}],
            is_inside_temporal_activity=True,
            post_message=mock_post_message,
            execute_tool=mock_execute_tool,
            build_messages=lambda context, prompt: [{"role": "system", "content": prompt}],
            max_iterations=1,
            skip_verification=True,
            skip_status_updates=True,
        )

    return result, posted_messages, executed_tools


async def test_tool_only_assistant_turn_persists_tool_calls():
    """Tool-only assistant declaration should persist as ASSISTANT with metadata.tool_calls."""
    tool_calls = [{"tool": "web_search", "query": "latest updates"}]
    detected_tools = [("web_search", "tc-web-search-1", 1.0)]

    result, posted, executed = await _run_single_iteration(tool_calls, detected_tools)

    assert result["status"] == "max_iterations"
    assert len(posted) >= 1
    assistant_posts = [m for m in posted if m["role"] == "ASSISTANT"]
    assert len(assistant_posts) == 1

    assistant = assistant_posts[0]
    assert assistant["text"] == ""
    assert assistant["metadata"] is not None
    assert "tool_calls" in assistant["metadata"]
    assert len(assistant["metadata"]["tool_calls"]) == 1

    persisted_call = assistant["metadata"]["tool_calls"][0]
    assert persisted_call["tool"] == "web_search"
    assert persisted_call["query"] == "latest updates"
    assert persisted_call["tool_call_id"] == "tc-web-search-1"

    assert len(executed) == 1
    assert executed[0]["tool_call_id"] == "tc-web-search-1"


async def test_assistant_tool_call_ids_match_execution_and_context_results():
    """Persisted assistant tool_call_id values should match execution and TOOL context metadata."""
    tool_calls = [
        {"tool": "web_search", "query": "alpha"},
        {"tool": "web_search", "query": "beta"},
    ]
    detected_tools = [
        ("web_search", "tc-web-search-1", 1.0),
        ("web_search", "tc-web-search-2", 2.0),
    ]

    result, posted, executed = await _run_single_iteration(tool_calls, detected_tools)

    assistant = [m for m in posted if m["role"] == "ASSISTANT"][0]
    persisted_ids = [tc["tool_call_id"] for tc in assistant["metadata"]["tool_calls"]]
    executed_ids = [t["tool_call_id"] for t in executed]

    assert persisted_ids == ["tc-web-search-1", "tc-web-search-2"]
    assert executed_ids == ["tc-web-search-1", "tc-web-search-2"]

    terminal_tool_msgs = [
        m for m in result["context"]
        if m.get("role") == "TOOL" and (m.get("metadata") or {}).get("toolStatus") == "FINISHED"
    ]
    context_ids = [(m.get("metadata") or {}).get("toolCallId") for m in terminal_tool_msgs]
    assert context_ids == ["tc-web-search-1", "tc-web-search-2"]


async def run_all_tests():
    print("run-agent blackbox tests:")
    r = BlackboxResult()
    await r.record_async("tool_only_assistant_turn_persists_tool_calls", test_tool_only_assistant_turn_persists_tool_calls)
    await r.record_async("assistant_tool_call_ids_match_execution_and_context_results", test_assistant_tool_call_ids_match_execution_and_context_results)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
