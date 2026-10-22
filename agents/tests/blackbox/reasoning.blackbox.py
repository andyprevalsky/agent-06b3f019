"""Blackbox tests for reasoning domain."""

import asyncio
from unittest.mock import patch, AsyncMock

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    setup_mock,
    teardown_mock,
    assert_captured_call,
    setup_mock_fn,
)


def test_reasoning_response_model():
    """ReasoningResponse stores response field and serializes correctly."""
    from activities.reasoning import ReasoningResponse

    r = ReasoningResponse(response="test analysis")

    assert r.response == "test analysis"
    d = r.model_dump()
    assert d == {"response": "test analysis"}


def test_reasoning_response_validates():
    """ReasoningResponse rejects missing response field."""
    from activities.reasoning import ReasoningResponse
    from pydantic import ValidationError

    try:
        ReasoningResponse()  # missing required 'response'
        raise AssertionError("Should have raised ValidationError")
    except ValidationError:
        pass  # expected


def test_safe_heartbeat_outside_activity():
    """_safe_heartbeat does not raise when called outside Temporal activity context."""
    from activities.reasoning import _safe_heartbeat

    # Should silently skip without raising
    _safe_heartbeat("test heartbeat")


# -------------------- service.py tests --------------------


def test_build_system_prompt_includes_goal():
    from domains.reasoning.service import build_system_prompt
    prompt = build_system_prompt("Analyze companies")
    assert "Analyze companies" in prompt
    assert "reasoning task" in prompt.lower()


async def test_build_reasoning_messages_preserves_sources_within_budget():
    from domains.reasoning.service import build_reasoning_messages
    from domains.reasoning.config import MAX_CONTEXT_MESSAGES

    context = [
        {"role": "USER", "text": f"msg {i}"} for i in range(MAX_CONTEXT_MESSAGES + 20)
    ]
    msgs = await build_reasoning_messages(context, "SYSTEM", "do stuff")

    # system + last MAX_CONTEXT_MESSAGES + trailing user
    assert msgs[0]["role"] == "system" or "SYSTEM" in str(msgs[0]).upper() or msgs[0].get("content") == "SYSTEM"
    assert msgs[-1]["role"] == "user"
    assert "do stuff" in msgs[-1]["content"]
    # Message count alone must not discard a source that fits the full budget.
    assert len(msgs) == len(context) + 2
    assert "msg 0" in msgs[1]["content"]



async def test_build_reasoning_messages_small_context():
    from domains.reasoning.service import build_reasoning_messages

    msgs = await build_reasoning_messages(
        [{"role": "USER", "text": "hello"}], "SYS", "goal"
    )
    assert msgs[-1]["role"] == "user"
    assert "goal" in msgs[-1]["content"]


async def test_execute_reasoning_happy_path():
    """execute_reasoning returns content from a mocked LLM."""
    from domains.reasoning import service as rservice
    from activities.reasoning import ReasoningResponse
    captured_kwargs = {}
    captured_messages = []
    streamed_chunks = []

    async def fake_llm(messages, **kwargs):
        captured_kwargs.update(kwargs)
        captured_messages.extend(messages)
        # Invoke on_chunk to cover streaming branch
        on_chunk = kwargs.get("on_chunk")
        if on_chunk:
            await on_chunk("analysis so far", 10)
            await on_chunk("analysis so far done", 20)
        return (
            ReasoningResponse(response="final analysis"),
            {"input_tokens": 10, "output_tokens": 5},
            [],
        )

    async def fake_stream_chunk(**kwargs):
        streamed_chunks.append(kwargs)

    with (
        patch.object(rservice, "call_llm_structured_streaming", fake_llm),
        patch.object(rservice, "stream_assistant_chunk", fake_stream_chunk),
    ):
        out = await rservice.execute_reasoning(
            goal="Investigate",
            context=[{"role": "USER", "text": "ctx"}],
            model="test-model",
            agent_id="agent-1",
            stream_id="stream-1",
            heartbeat_fn=lambda m: None,
            system_prompt_text="MAIN SYSTEM PROMPT",
        )
    assert out["content"] == "final analysis"
    assert out["usage"]["input_tokens"] == 10
    assert captured_kwargs["skip_cache_write"] is True
    assert captured_kwargs["call_site"] == "dag_reasoning"
    assert captured_messages[0] == {"role": "system", "content": "MAIN SYSTEM PROMPT"}
    assert captured_messages[-1]["role"] == "user"
    assert "Investigate" in captured_messages[-1]["content"]
    assert streamed_chunks[0]["delta"] == ""
    assert streamed_chunks[0]["done"] is False
    assert streamed_chunks[0]["sequence"] == 0
    assert isinstance(streamed_chunks[0]["llm_started_at_ms"], int)
    assert streamed_chunks[1]["delta"] == "analysis so far"
    assert streamed_chunks[-1]["done"] is True


async def test_execute_reasoning_marks_gpt_streams():
    """All GPT routes keep their streaming UI classification."""
    from activities.reasoning import ReasoningResponse
    from domains.reasoning import service as rservice

    for actual_model in ("gpt-6-sol-gpt", "gpt-6-sol-openai", "gpt-6-sol-foundry"):
        streamed_chunks = []

        async def fake_llm(messages, **kwargs):
            kwargs["on_model_detected"](actual_model)
            await kwargs["on_chunk"]("GPT stream", 2)
            return ReasoningResponse(response="GPT stream"), {}, []

        async def fake_stream_chunk(**kwargs):
            streamed_chunks.append(kwargs)

        with (
            patch.object(rservice, "call_llm_structured_streaming", fake_llm),
            patch.object(rservice, "stream_assistant_chunk", fake_stream_chunk),
        ):
            await rservice.execute_reasoning(
                goal="Investigate",
                context=[],
                model="gpt-6-sol",
                agent_id="agent-1",
                stream_id="stream-1",
            )

        text_chunks = [chunk for chunk in streamed_chunks if chunk["delta"]]
        assert text_chunks and all(chunk["is_gpt"] for chunk in text_chunks), actual_model


async def test_execute_reasoning_uses_streamed_text_when_structured_json_missing():
    """Reasoning is raw assistant text; streamed text should survive JSON wrapper misses."""
    from domains.reasoning import service as rservice

    streamed_chunks = []

    async def fake_llm(messages, **kwargs):
        on_chunk = kwargs.get("on_chunk")
        if on_chunk:
            await on_chunk("streamed reasoning answer", 6)
        raise ValueError("No JSON content received in response (chunks=12, model=test)")

    async def fake_stream_chunk(**kwargs):
        streamed_chunks.append(kwargs)

    with (
        patch.object(rservice, "call_llm_structured_streaming", fake_llm),
        patch.object(rservice, "stream_assistant_chunk", fake_stream_chunk),
    ):
        out = await rservice.execute_reasoning(
            goal="Investigate",
            context=[],
            model="test-model",
            agent_id="agent-1",
            stream_id="stream-1",
        )

    assert out["content"] == "streamed reasoning answer"
    assert out["usage"] == {}
    assert streamed_chunks[0]["delta"] == ""
    assert streamed_chunks[1]["delta"] == "streamed reasoning answer"
    assert streamed_chunks[-1]["done"] is True


async def test_execute_reasoning_retries_provider_failure_as_raw_text():
    """Provider/schema failures before chunks should retry once as raw assistant text."""
    from ssl import SSLError

    from domains.reasoning import service as rservice

    streamed_chunks = []
    captured_raw_kwargs = {}

    async def fake_structured_llm(messages, **kwargs):
        raise SSLError("ssl/tls alert bad record mac")

    async def fake_raw_llm(**kwargs):
        captured_raw_kwargs.update(kwargs)
        return {
            "content": "raw reasoning answer",
            "usage": {"prompt_tokens": 3, "completion_tokens": 4},
        }

    async def fake_stream_chunk(**kwargs):
        streamed_chunks.append(kwargs)

    with (
        patch.object(rservice, "call_llm_structured_streaming", fake_structured_llm),
        patch.object(rservice, "call_llm", fake_raw_llm),
        patch.object(rservice, "stream_assistant_chunk", fake_stream_chunk),
    ):
        out = await rservice.execute_reasoning(
            goal="Investigate",
            context=[],
            model="test-model",
            agent_id="agent-1",
            stream_id="stream-1",
        )

    assert out["content"] == "raw reasoning answer"
    assert out["usage"]["prompt_tokens"] == 3
    assert captured_raw_kwargs["response_model"] is None
    assert captured_raw_kwargs["skip_cache_write"] is True
    assert streamed_chunks[0]["delta"] == ""
    assert streamed_chunks[1]["delta"] == "raw reasoning answer"
    assert streamed_chunks[-1]["done"] is True


async def test_execute_reasoning_empty_response():
    """execute_reasoning returns fallback message when LLM response is empty."""
    from domains.reasoning import service as rservice
    from activities.reasoning import ReasoningResponse

    async def fake_llm(messages, **kwargs):
        return (
            ReasoningResponse(response=""),
            {"input_tokens": 1, "output_tokens": 0},
            [],
        )

    with patch.object(rservice, "call_llm_structured_streaming", fake_llm):
        out = await rservice.execute_reasoning(
            goal="Investigate",
            context=[],
            model="test-model",
        )
    assert "Unable to complete" in out["content"]


async def test_execute_reasoning_no_stream_no_agent():
    """execute_reasoning works without agent_id or stream_id."""
    from domains.reasoning import service as rservice
    from activities.reasoning import ReasoningResponse

    async def fake_llm(messages, **kwargs):
        return (
            ReasoningResponse(response="done"),
            {},
            [],
        )

    with patch.object(rservice, "call_llm_structured_streaming", fake_llm):
        out = await rservice.execute_reasoning(
            goal="G",
            context=[],
            model="m",
        )
    assert out["content"] == "done"


async def test_execute_reasoning_activity_wraps_errors():
    """execute_reasoning_activity logs and re-raises errors."""
    from domains.reasoning import service as rservice
    from domains.reasoning.handler import execute_reasoning_activity

    async def boom(*a, **kw):
        raise RuntimeError("LLM exploded")

    with patch.object(rservice, "call_llm_structured_streaming", boom):
        try:
            await execute_reasoning_activity(
                goal="G", context=[], model="m"
            )
            raise AssertionError("should have raised")
        except RuntimeError as e:
            assert "exploded" in str(e)


async def test_execute_reasoning_activity_happy():
    """execute_reasoning_activity delegates to execute_reasoning."""
    from domains.reasoning import service as rservice
    from domains.reasoning.handler import execute_reasoning_activity
    from activities.reasoning import ReasoningResponse

    async def fake_llm(messages, **kwargs):
        return (ReasoningResponse(response="ok"), {}, [])

    with patch.object(rservice, "call_llm_structured_streaming", fake_llm):
        out = await execute_reasoning_activity(
            goal="G", context=[], model="m"
        )
    assert out["content"] == "ok"


async def run_all_tests():
    print("reasoning blackbox tests:")
    r = BlackboxResult()
    r.record("reasoning_response_model", test_reasoning_response_model)
    r.record("reasoning_response_validates", test_reasoning_response_validates)
    r.record("safe_heartbeat_outside_activity", test_safe_heartbeat_outside_activity)
    r.record("build_system_prompt_includes_goal", test_build_system_prompt_includes_goal)
    await r.record_async("build_reasoning_messages_trims", test_build_reasoning_messages_preserves_sources_within_budget)
    await r.record_async("build_reasoning_messages_small", test_build_reasoning_messages_small_context)
    await r.record_async("execute_reasoning_happy_path", test_execute_reasoning_happy_path)
    await r.record_async("execute_reasoning_marks_gpt_streams", test_execute_reasoning_marks_gpt_streams)
    await r.record_async(
        "execute_reasoning_streamed_text_json_missing",
        test_execute_reasoning_uses_streamed_text_when_structured_json_missing,
    )
    await r.record_async(
        "execute_reasoning_raw_text_retry",
        test_execute_reasoning_retries_provider_failure_as_raw_text,
    )
    await r.record_async("execute_reasoning_empty_response", test_execute_reasoning_empty_response)
    await r.record_async("execute_reasoning_no_stream", test_execute_reasoning_no_stream_no_agent)
    await r.record_async("execute_reasoning_activity_wraps_errors", test_execute_reasoning_activity_wraps_errors)
    await r.record_async("execute_reasoning_activity_happy", test_execute_reasoning_activity_happy)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
