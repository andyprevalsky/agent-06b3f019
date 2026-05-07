"""Blackbox tests for summarize domain."""

import asyncio
from unittest.mock import patch, AsyncMock

from _test_utils import (
    BlackboxResult,
    teardown_mock,
)


async def test_count_tool_usage():
    """_count_tool_usage counts FINISHED tool messages correctly.

    Verifier rows now ride under toolName="attempt_completion" with
    metadata.verifierMessage=True; they're filtered by that flag, not by the
    legacy "check_progress" toolName (which no longer exists).
    """
    from helpers.summarize import _count_tool_usage

    context = [
        {"role": "USER", "text": "Find companies"},
        {"role": "TOOL", "metadata": {"toolName": "web_search", "toolStatus": "IN_PROGRESS"}},
        {"role": "TOOL", "metadata": {"toolName": "web_search", "toolStatus": "FINISHED"}},
        {"role": "TOOL", "metadata": {"toolName": "wait_for", "toolStatus": "FINISHED"}},
        {"role": "TOOL", "metadata": {"toolName": "web_search", "toolStatus": "FINISHED"}},
        # Verifier-feedback row: filtered via verifierMessage flag, not by toolName.
        {"role": "TOOL", "metadata": {"toolName": "attempt_completion", "toolStatus": "FINISHED", "verifierMessage": True}},
        {"role": "TOOL", "metadata": {"toolName": "attempt_completion", "toolStatus": "FINISHED"}},  # excluded by name
        {"role": "ASSISTANT", "text": "Done"},
    ]

    counts = _count_tool_usage(context)

    assert counts["web_search"] == 2
    assert counts["wait_for"] == 1
    # Excluded tools should not appear
    assert "attempt_completion" not in counts


async def test_count_tool_usage_empty():
    """_count_tool_usage returns empty dict for empty context."""
    from helpers.summarize import _count_tool_usage

    assert _count_tool_usage([]) == {}


async def test_merge_tool_counts():
    """_merge_tool_counts merges own and sub-agent tool counts."""
    from helpers.summarize import _merge_tool_counts

    own = {"web_search": 3, "wait_for": 1}
    sub = {"web_search": 2, "set_plan": 1}

    merged = _merge_tool_counts(own, sub)

    assert merged["web_search"] == 5
    assert merged["wait_for"] == 1
    assert merged["set_plan"] == 1


async def test_merge_tool_counts_empty():
    """_merge_tool_counts handles empty inputs."""
    from helpers.summarize import _merge_tool_counts

    assert _merge_tool_counts({}, {}) == {}
    assert _merge_tool_counts({"a": 1}, {}) == {"a": 1}
    assert _merge_tool_counts({}, {"b": 2}) == {"b": 2}


async def test_format_tool_stats_footer():
    """_format_tool_stats_footer formats tool counts as markdown."""
    from helpers.summarize import _format_tool_stats_footer

    counts = {"web_search": 5, "wait_for": 2, "set_plan": 1}

    footer = _format_tool_stats_footer(counts)

    assert "Tool Usage Statistics" in footer
    assert "Total:** 8" in footer
    assert "Web Searches" in footer  # mapped display name
    assert "Wait Operations" in footer   # mapped display name
    assert "Plans Set" in footer


async def test_format_tool_stats_footer_empty():
    """_format_tool_stats_footer returns empty string for no tools."""
    from helpers.summarize import _format_tool_stats_footer

    assert _format_tool_stats_footer({}) == ""


async def test_format_tool_stats_footer_sort_order():
    """_format_tool_stats_footer sorts by count descending."""
    from helpers.summarize import _format_tool_stats_footer

    counts = {"set_plan": 1, "web_search": 10, "wait_for": 5}

    footer = _format_tool_stats_footer(counts)

    # web_search (10) should appear before wait_for (5) before set_plan (1)
    ws_pos = footer.index("Web Searches")
    wf_pos = footer.index("Wait Operations")
    sp_pos = footer.index("Plans Set")
    assert ws_pos < wf_pos < sp_pos


# -------------------- activity tests --------------------


async def test_compress_context_happy():
    """compress_context returns learnings from a mocked LLM."""
    from helpers import summarize
    import helpers.llm as llm_mod

    async def fake_llm(messages, **kwargs):
        assert kwargs["claude_token"] is None
        assert kwargs["gpt_token"] is None
        return {"content": "## Learnings\n- worked well", "usage": {"total_tokens": 100}}

    with patch("temporalio.activity.heartbeat"):
        with patch.object(llm_mod, "call_llm", fake_llm):
            out = await summarize.compress_context(
                context=[{"role": "USER", "text": "do stuff"}],
                iteration_count=5,
                model="test-model",
            )
    assert "Learnings" in out["learnings"]
    assert out["usage"]["total_tokens"] == 100


async def test_compress_context_forwards_compute_auth():
    """compress_context forwards direct compute auth to call_llm."""
    from helpers import summarize
    import helpers.llm as llm_mod

    observed_kwargs = []

    async def fake_llm(messages, **kwargs):
        observed_kwargs.append(kwargs)
        return {"content": "## Learnings\n- used direct auth", "usage": {"total_tokens": 10}}

    with patch("temporalio.activity.heartbeat"):
        with patch.object(llm_mod, "call_llm", fake_llm):
            await summarize.compress_context(
                context=[{"role": "USER", "text": "do stuff"}],
                iteration_count=5,
                model="test-model",
                gpt_token="gpt-token",
                gpt_account_id="acct-1",
                gpt_token_source="user",
                gpt_token_pool_id="pool-1",
                gpt_token_user_id="user-1",
                agent_id="agent-1",
            )

    assert observed_kwargs[0]["gpt_token"] == "gpt-token"
    assert observed_kwargs[0]["gpt_account_id"] == "acct-1"
    assert observed_kwargs[0]["gpt_token_source"] == "user"
    assert observed_kwargs[0]["gpt_token_pool_id"] == "pool-1"
    assert observed_kwargs[0]["gpt_token_user_id"] == "user-1"
    assert observed_kwargs[0]["agent_id"] == "agent-1"
    assert observed_kwargs[0]["user_id"] == "user-1"


async def test_compress_context_on_error_returns_fallback():
    from helpers import summarize
    import helpers.llm as llm_mod

    async def boom(*a, **kw):
        raise RuntimeError("LLM down")

    with patch("temporalio.activity.heartbeat"):
        with patch.object(llm_mod, "call_llm", boom):
            out = await summarize.compress_context(
                context=[{"role": "USER", "text": "x"}],
                iteration_count=10,
                model="m",
            )
    assert "Context Reset After 10 Iterations" in out["learnings"]
    assert out["usage"] == {}


async def test_generate_completion_summary_happy():
    from helpers import summarize
    import helpers.llm as llm_mod

    observed_local_context = []

    async def fake_llm(messages, **kwargs):
        observed_local_context.append(kwargs.get("local_context"))
        assert kwargs["claude_token"] is None
        assert kwargs["gpt_token"] is None
        return {
            "content": "Completed all research tasks successfully.",
            "usage": {"total_tokens": 50, "prompt_tokens": 30, "completion_tokens": 20},
        }

    def fake_convert(context, include_system=False, include_assistant=True):
        return [{"role": "user", "content": m.get("text", "")} for m in context]

    context = [
        {"role": "TOOL", "metadata": {"toolName": "web_search", "toolStatus": "FINISHED"}},
        {"role": "TOOL", "metadata": {"toolName": "wait_for", "toolStatus": "FINISHED"}},
    ]

    with patch("temporalio.activity.heartbeat"):
        with patch.object(llm_mod, "call_llm", fake_llm):
            with patch.object(llm_mod, "convert_context_to_messages", fake_convert):
                out = await summarize.generate_completion_summary(
                    context=context,
                    goal="Find companies",
                    model="m",
                    structured_response={"companies": ["ACME", "Initech"], "count": 2},
                    sub_agent_tool_counts={"web_search": 3},
                )
    assert "Completed all research tasks" in out["summary"]
    assert out["tool_counts"]["web_search"] == 4  # 1 own + 3 sub
    assert out["tool_counts"]["wait_for"] == 1
    assert observed_local_context == [context]


async def test_generate_completion_summary_forwards_compute_auth():
    """generate_completion_summary forwards direct compute auth to call_llm."""
    from helpers import summarize
    import helpers.llm as llm_mod

    observed_kwargs = []

    async def fake_llm(messages, **kwargs):
        observed_kwargs.append(kwargs)
        return {
            "content": "Completed with cached direct auth.",
            "usage": {"total_tokens": 50, "prompt_tokens": 30, "completion_tokens": 20},
        }

    def fake_convert(context, include_system=False, include_assistant=True):
        return []

    with patch("temporalio.activity.heartbeat"):
        with patch.object(llm_mod, "call_llm", fake_llm):
            with patch.object(llm_mod, "convert_context_to_messages", fake_convert):
                await summarize.generate_completion_summary(
                    context=[],
                    goal="G",
                    model="m",
                    gpt_token="gpt-token",
                    gpt_account_id="acct-1",
                    gpt_token_source="user",
                    gpt_token_pool_id="pool-1",
                    gpt_token_user_id="user-1",
                    agent_id="agent-1",
                )

    assert observed_kwargs[0]["gpt_token"] == "gpt-token"
    assert observed_kwargs[0]["gpt_account_id"] == "acct-1"
    assert observed_kwargs[0]["gpt_token_source"] == "user"
    assert observed_kwargs[0]["gpt_token_pool_id"] == "pool-1"
    assert observed_kwargs[0]["gpt_token_user_id"] == "user-1"
    assert observed_kwargs[0]["agent_id"] == "agent-1"
    assert observed_kwargs[0]["user_id"] == "user-1"


async def test_generate_completion_summary_on_error():
    from helpers import summarize
    import helpers.llm as llm_mod

    async def boom(*a, **kw):
        raise RuntimeError("LLM boom")

    def fake_convert(context, include_system=False, include_assistant=True):
        return []

    with patch("temporalio.activity.heartbeat"):
        with patch.object(llm_mod, "call_llm", boom):
            with patch.object(llm_mod, "convert_context_to_messages", fake_convert):
                out = await summarize.generate_completion_summary(
                    context=[],
                    goal="My goal",
                    model="m",
                )
    assert "My goal" in out["summary"]
    assert out["usage"]["total_tokens"] == 0
    assert out["tool_counts"] == {}


async def test_generate_completion_summary_no_structured_response():
    """Covers path where structured_response is None/empty."""
    from helpers import summarize
    import helpers.llm as llm_mod

    async def fake_llm(messages, **kwargs):
        return {"content": "Summary.", "usage": {"total_tokens": 10}}

    def fake_convert(context, include_system=False, include_assistant=True):
        return []

    with patch("temporalio.activity.heartbeat"):
        with patch.object(llm_mod, "call_llm", fake_llm):
            with patch.object(llm_mod, "convert_context_to_messages", fake_convert):
                out = await summarize.generate_completion_summary(
                    context=[],
                    goal="G",
                    model="m",
                    structured_response=None,
                )
    assert "Summary." in out["summary"]


async def run_all_tests():
    print("summarize blackbox tests:")
    r = BlackboxResult()
    await r.record_async("count_tool_usage", test_count_tool_usage)
    await r.record_async("count_tool_usage_empty", test_count_tool_usage_empty)
    await r.record_async("merge_tool_counts", test_merge_tool_counts)
    await r.record_async("merge_tool_counts_empty", test_merge_tool_counts_empty)
    await r.record_async("format_tool_stats_footer", test_format_tool_stats_footer)
    await r.record_async("format_tool_stats_footer_empty", test_format_tool_stats_footer_empty)
    await r.record_async("format_tool_stats_footer_sort_order", test_format_tool_stats_footer_sort_order)
    await r.record_async("compress_context_happy", test_compress_context_happy)
    await r.record_async("compress_context_forwards_compute_auth", test_compress_context_forwards_compute_auth)
    await r.record_async("compress_context_error_fallback", test_compress_context_on_error_returns_fallback)
    await r.record_async("generate_completion_summary_happy", test_generate_completion_summary_happy)
    await r.record_async(
        "generate_completion_summary_forwards_compute_auth",
        test_generate_completion_summary_forwards_compute_auth,
    )
    await r.record_async("generate_completion_summary_error", test_generate_completion_summary_on_error)
    await r.record_async("generate_completion_summary_no_structured", test_generate_completion_summary_no_structured_response)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
