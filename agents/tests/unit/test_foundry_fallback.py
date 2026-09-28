"""Foundry fallback contract with a fake HTTP boundary."""

import json

import httpx
import pytest

from providers.rose import foundry
from providers.rose.errors import RoseRateLimitError, RoseServerError
from providers.rose.pools import get_pool
from providers.rose.pricing import get_model_pricing


def _sse(*events: dict) -> str:
    return "".join(f"data: {json.dumps(event)}\n\n" for event in events) + "data: [DONE]\n\n"


def _call():
    return foundry.foundry_complete(
        pool_spec=get_pool("rose-1-ultra"),
        messages=[{"role": "user", "content": "Say hi"}],
        response_format=None,
        tools=None,
        context_tools=None,
        tool_choice=None,
        temperature=None,
        effort="high",
        provider_fast_mode=True,
        request_id="foundry-test",
        route_key="agent-1",
        agent_id="agent-1",
        call_site="test",
        cache_namespace=None,
        ttft_timeout_s=2,
        idle_timeout_s=2,
    )


def _install_http(monkeypatch, handler):
    original = httpx.AsyncClient
    monkeypatch.setattr(
        foundry.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs)
    )
    monkeypatch.setenv("AZURE_FOUNDRY_ENDPOINT", "https://a-4989-resource.openai.azure.com")
    monkeypatch.setenv("AZURE_FOUNDRY_API_KEY", "test-key")
    foundry._cooldown_until.clear()
    foundry._auth_cooldown_until = 0


@pytest.mark.asyncio
async def test_responses_shape_and_zero_user_cost(monkeypatch):
    def handler(request):
        assert str(request.url) == "https://a-4989-resource.openai.azure.com/openai/v1/responses"
        assert request.headers["api-key"] == "test-key"
        body = json.loads(request.content)
        assert body["model"] == "gpt-6-sol"
        assert body["reasoning"]["effort"] == "high"
        assert body["stream"] is True and body["store"] is False
        assert body["include"] == ["reasoning.encrypted_content"]
        assert body["service_tier"] == "priority"
        return httpx.Response(
            200,
            text=_sse(
                {"type": "response.output_text.delta", "delta": "Hi"},
                {"type": "response.completed", "response": {"usage": {"input_tokens": 3, "output_tokens": 1}}},
            ),
        )

    _install_http(monkeypatch, handler)
    chunks = [chunk async for chunk in _call()]
    assert [chunk.kind for chunk in chunks] == ["metadata", "content", "usage", "done"]
    assert chunks[0].data["actual_model"] == "gpt-6-sol-foundry"
    assert chunks[1].data["text"] == "Hi"
    assert get_model_pricing("gpt-6-sol-foundry") == {
        "input_cents_per_1k": 0.0,
        "output_cents_per_1k": 0.0,
    }


@pytest.mark.asyncio
async def test_429_spills_to_next_deployment(monkeypatch):
    calls = []

    def handler(request):
        deployment = json.loads(request.content)["model"]
        calls.append(deployment)
        if len(calls) == 1:
            return httpx.Response(429, headers={"retry-after-ms": "2000"})
        return httpx.Response(200, text=_sse({"type": "response.output_text.delta", "delta": "Hi"}))

    _install_http(monkeypatch, handler)
    monkeypatch.setenv("AZURE_FOUNDRY_DEPLOYMENTS", "gpt-6-sol,gpt-6-sol-b")
    chunks = [chunk async for chunk in _call()]
    assert len(calls) == 2 and calls[0] != calls[1]
    assert chunks[1].data["text"] == "Hi"
    assert foundry._cooldown_until[calls[0]] > 0


@pytest.mark.asyncio
async def test_all_429s_fall_through_without_content(monkeypatch):
    _install_http(monkeypatch, lambda _request: httpx.Response(429, headers={"retry-after-ms": "1000"}))
    monkeypatch.setenv("AZURE_FOUNDRY_DEPLOYMENTS", "gpt-6-sol")
    with pytest.raises(RoseRateLimitError):
        [chunk async for chunk in _call()]


@pytest.mark.asyncio
async def test_partial_stream_never_splices_deployments(monkeypatch):
    calls = []

    def handler(request):
        calls.append(json.loads(request.content)["model"])
        return httpx.Response(
            200,
            text=_sse(
                {"type": "response.output_text.delta", "delta": "Partial"},
                {"type": "response.failed", "error": {"code": "server_error", "message": "interrupted"}},
            ),
        )

    _install_http(monkeypatch, handler)
    monkeypatch.setenv("AZURE_FOUNDRY_DEPLOYMENTS", "gpt-6-sol,gpt-6-sol-b")
    chunks = []
    with pytest.raises(RoseServerError):
        async for chunk in _call():
            chunks.append(chunk)
    assert len(calls) == 1
    assert chunks[1].data["text"] == "Partial"
