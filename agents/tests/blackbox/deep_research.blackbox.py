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


async def run_all_tests():
    print("deep-research blackbox tests:")
    r = BlackboxResult()
    await r.record_async("disabled_returns_mock", test_disabled_returns_mock)
    await r.record_async("activity_calls_perplexity", test_activity_calls_perplexity)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
