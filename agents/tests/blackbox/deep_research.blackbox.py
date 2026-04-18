"""Blackbox tests for deep-research domain."""

import asyncio
from unittest.mock import patch, AsyncMock, MagicMock

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    setup_mock,
    teardown_mock,
)


async def test_disabled_returns_mock():
    """deep_research is currently disabled — manager returns disabled message."""
    from tools.deep_research import DeepResearchManager

    manager = DeepResearchManager()
    mock_execute = AsyncMock()

    with patch("tools.deep_research.handle_tool_event", new_callable=AsyncMock):
        result = await manager.execute_tool(
            execute_activity=mock_execute,
            tool_call={"query": "What is quantum computing?", "max_tokens": 2000},
            tool_call_id="tc-1",
            agent_id="agent-1",
            user_id="user-1",
        )

    # When disabled, the activity should not be called
    # and the tool returns a message about being disabled
    assert isinstance(result, dict)


async def test_activity_calls_perplexity():
    """deep_research_activity calls Perplexity API via OpenAI client."""
    setup_mock({
        "api.perplexity.ai": {
            "status": 200,
            "json": {
                "choices": [
                    {
                        "message": {
                            "content": "Quantum computing uses qubits...",
                            "citations": ["https://example.com/qc"],
                        }
                    }
                ],
                "citations": ["https://example.com/qc"],
                "usage": {
                    "prompt_tokens": 50,
                    "completion_tokens": 200,
                },
            },
        }
    })

    # Mock the OpenAI AsyncOpenAI client since deep_research uses it
    # (not httpx directly, so capture won't see it — this is documented)
    mock_response = MagicMock()
    mock_response.choices = [
        MagicMock(
            message=MagicMock(
                content="Quantum computing uses qubits for computation.",
                citations=["https://example.com/qc"],
            )
        )
    ]
    mock_response.citations = ["https://example.com/qc"]
    mock_response.usage = MagicMock(
        prompt_tokens=50,
        completion_tokens=200,
        citation_tokens=10,
        reasoning_tokens=0,
        num_search_queries=3,
    )

    with (
        patch("temporalio.activity.heartbeat"),
        patch("openai.AsyncOpenAI") as mock_openai_cls,
    ):
        mock_client = AsyncMock()
        mock_client.chat.completions.create = AsyncMock(return_value=mock_response)
        mock_openai_cls.return_value = mock_client

        from tools.deep_research import deep_research_activity

        result = await deep_research_activity("What is quantum computing?", max_tokens=4000)

    assert result["report"] == "Quantum computing uses qubits for computation."
    assert result["query"] == "What is quantum computing?"
    assert result["model"] == "sonar-deep-research"
    assert len(result["citations"]) == 1

    # Verify the OpenAI client was called with correct params
    call_kwargs = mock_client.chat.completions.create.call_args
    assert call_kwargs.kwargs["model"] == "sonar-deep-research"
    assert call_kwargs.kwargs["max_tokens"] == 4000


# -------------------- service.py tests --------------------


def test_compute_service_usage_empty():
    from domains.deep_research.service import compute_service_usage
    # No usage key or empty usage → empty list
    assert compute_service_usage({"report": "x"}) == []
    assert compute_service_usage({"usage": {}}) == []


def test_compute_service_usage_all_fields():
    from domains.deep_research.service import compute_service_usage

    usage = compute_service_usage({
        "usage": {
            "input_tokens": 1_000_000,
            "output_tokens": 1_000_000,
            "citation_tokens": 1_000_000,
            "reasoning_tokens": 1_000_000,
            "search_count": 10,
        }
    })
    # Each populated field should add an entry
    providers = {u["provider"] for u in usage}
    assert "Perplexity Input Tokens" in providers
    assert "Perplexity Output Tokens" in providers
    assert "Perplexity Citation Tokens" in providers
    assert "Perplexity Reasoning Tokens" in providers
    assert "Perplexity Search Queries" in providers
    # All costs should be positive ints
    assert all(u["cost_cents"] > 0 for u in usage)


def test_compute_service_usage_partial_fields():
    from domains.deep_research.service import compute_service_usage

    usage = compute_service_usage({
        "usage": {
            "input_tokens": 500_000,
            # output missing
            "reasoning_tokens": 1000,
        }
    })
    providers = {u["provider"] for u in usage}
    assert "Perplexity Input Tokens" in providers
    assert "Perplexity Output Tokens" not in providers
    assert "Perplexity Reasoning Tokens" in providers


def test_build_completion_message_no_citations():
    from domains.deep_research.service import build_completion_message
    msg = build_completion_message({"report": "Some report"})
    assert msg == "Some report"


def test_build_completion_message_one_citation():
    from domains.deep_research.service import build_completion_message
    msg = build_completion_message({"report": "r", "citations": ["c1"]})
    # Singular "citation" (no 's')
    assert "1 citation*" in msg
    # Ensure it's not pluralized
    assert "1 citations" not in msg


def test_build_completion_message_many_citations():
    from domains.deep_research.service import build_completion_message
    msg = build_completion_message({"report": "r", "citations": ["c1", "c2", "c3"]})
    assert "3 citations" in msg


def test_build_completion_message_explicit_count():
    from domains.deep_research.service import build_completion_message
    # Uses explicit citation_count when provided
    msg = build_completion_message({"report": "r", "citations": [], "citation_count": 5})
    assert "5 citations" in msg


# -------------------- handler.py tests --------------------


async def test_manager_returns_disabled_result():
    """DeepResearchManager returns a disabled placeholder result."""
    from domains.deep_research.handler import DeepResearchManager
    from unittest.mock import patch, AsyncMock

    async def mock_execute(*a, **kw):
        return None

    manager = DeepResearchManager()
    with patch("domains.deep_research.handler.handle_tool_event", new_callable=AsyncMock):
        out = await manager.execute_tool(
            execute_activity=mock_execute,
            tool_call={"query": "What is AI?"},
            tool_call_id="tc-1",
            agent_id="agent-1",
            user_id="user-1",
        )
    # Disabled → result is a DeepResearchResult with report that mentions disabled
    assert "result" in out
    assert "disabled" in out["result"]["report"].lower()
    assert out["result"]["citation_count"] == 0


async def test_deep_research_entry_point():
    """deep_research() entry point dispatches to manager."""
    from domains.deep_research.handler import deep_research
    from unittest.mock import patch, AsyncMock

    async def mock_execute(*a, **kw):
        return None

    with patch("domains.deep_research.handler.handle_tool_event", new_callable=AsyncMock):
        out = await deep_research(
            execute_activity=mock_execute,
            tool_call={"query": "x"},
            tool_call_id="tc-1",
            agent_id="agent-1",
            user_id="user-1",
        )
    assert "result" in out


async def run_all_tests():
    print("deep-research blackbox tests:")
    r = BlackboxResult()
    await r.record_async("disabled_returns_mock", test_disabled_returns_mock)
    await r.record_async("activity_calls_perplexity", test_activity_calls_perplexity)
    r.record("compute_service_usage_empty", test_compute_service_usage_empty)
    r.record("compute_service_usage_all_fields", test_compute_service_usage_all_fields)
    r.record("compute_service_usage_partial", test_compute_service_usage_partial_fields)
    r.record("build_completion_no_citations", test_build_completion_message_no_citations)
    r.record("build_completion_one_citation", test_build_completion_message_one_citation)
    r.record("build_completion_many_citations", test_build_completion_message_many_citations)
    r.record("build_completion_explicit_count", test_build_completion_message_explicit_count)
    await r.record_async("manager_returns_disabled", test_manager_returns_disabled_result)
    await r.record_async("deep_research_entry_point", test_deep_research_entry_point)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
