"""Foundry fallback contract with a fake HTTP boundary."""

import json

import httpx
import pytest

from providers.rose import foundry
from providers.rose.errors import RoseRateLimitError, RoseServerError
from providers.rose.gpt_auth import _openai_credit_error, build_codex_responses_body
from providers.rose.pools import foundry_model, get_pool
from providers.rose.pricing import get_model_pricing


def _sse(*events: dict) -> str:
    return "".join(f"data: {json.dumps(event)}\n\n" for event in events) + "data: [DONE]\n\n"


@pytest.mark.parametrize(
    "code",
    [
        "insufficient_quota",
        "credit_balance_exhausted",
        "organization_usage_limit_exceeded",
        "organization_spend_limit_exceeded",
        "project_spend_limit_exceeded",
    ],
)
def test_openai_credit_codes_are_distinct_from_rate_limits(code):
    assert _openai_credit_error(json.dumps({"error": {"code": code}}))
    assert not _openai_credit_error(json.dumps({"error": {"code": "rate_limit_exceeded"}}))


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
async def test_foundry_outbound_payload_matches_gpt_compute_payload(monkeypatch):
    """The actual Azure POST must carry the GPT compute request body unchanged."""
    captured = []

    def handler(request):
        captured.append(json.loads(request.content))
        return httpx.Response(200, text=_sse({"type": "response.output_text.delta", "delta": "ok"}))

    _install_http(monkeypatch, handler)
    monkeypatch.setenv("AZURE_FOUNDRY_DEPLOYMENTS", "gpt-6-sol")
    pool = get_pool("rose-1-ultra")
    messages = [
        {"role": "system", "content": "Follow the supplied response contract."},
        {"role": "user", "content": "Return the result."},
    ]
    schema = {
        "json_schema": {
            "name": "result",
            "strict": True,
            "schema": {
                "type": "object",
                "properties": {"value": {"type": "string"}},
                "required": ["value"],
                "additionalProperties": False,
            },
        }
    }
    tools = [
        {
            "name": "answer",
            "description": "Return the result",
            "parameters": schema["json_schema"]["schema"],
            "strict": True,
        }
    ]
    for name, response_format, selected_tools, tool_choice, fast in (
        ("strict-json", schema, None, None, True),
        ("forced-tool", None, tools, {"name": "answer"}, False),
    ):
        options = dict(
            pool_spec=pool,
            messages=messages,
            response_format=response_format,
            tools=selected_tools,
            context_tools=None,
            tool_choice=tool_choice,
            temperature=0.7,
            effort="xhigh",
            provider_fast_mode=fast,
            request_id=f"parity-{name}",
            cache_namespace="agent-parity",
        )
        chunks = [
            chunk
            async for chunk in foundry.foundry_complete(
                **options,
                route_key="agent-parity",
                agent_id="agent-parity",
                call_site="parity-test",
                ttft_timeout_s=2,
                idle_timeout_s=2,
            )
        ]
        assert any(chunk.kind == "content" for chunk in chunks)
        expected = build_codex_responses_body(**options, model_override="gpt-6-sol")
        assert captured[-1] == expected
        assert "temperature" not in captured[-1]  # GPT compute also omits it.


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


@pytest.mark.asyncio
async def test_precontent_protocol_error_tries_next_deployment(monkeypatch):
    calls = []

    def handler(request):
        calls.append(json.loads(request.content)["model"])
        if len(calls) == 1:
            raise httpx.RemoteProtocolError("connection closed before headers")
        return httpx.Response(200, text=_sse({"type": "response.output_text.delta", "delta": "Hi"}))

    _install_http(monkeypatch, handler)
    monkeypatch.setenv("AZURE_FOUNDRY_DEPLOYMENTS", "gpt-6-sol,gpt-6-sol-b")
    chunks = [chunk async for chunk in _call()]
    assert len(calls) == 2
    assert chunks[1].data["text"] == "Hi"


@pytest.mark.asyncio
async def test_postcontent_protocol_error_never_retries(monkeypatch):
    calls = []

    class BrokenStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield f'data: {json.dumps({"type": "response.output_text.delta", "delta": "Partial"})}\n\n'.encode()
            raise httpx.RemoteProtocolError("connection closed after content")

        async def aclose(self):
            pass

    def handler(request):
        calls.append(json.loads(request.content)["model"])
        return httpx.Response(200, stream=BrokenStream())

    _install_http(monkeypatch, handler)
    monkeypatch.setenv("AZURE_FOUNDRY_DEPLOYMENTS", "gpt-6-sol,gpt-6-sol-b")
    chunks = []
    with pytest.raises(httpx.RemoteProtocolError):
        async for chunk in _call():
            chunks.append(chunk)
    assert len(calls) == 1
    assert chunks[1].data["text"] == "Partial"


def test_shared_deployment_list_is_scoped_to_each_pool_model(monkeypatch):
    """Prod's AZURE_FOUNDRY_DEPLOYMENTS names Sol; Luna pools must not inherit it."""
    monkeypatch.setenv("AZURE_FOUNDRY_DEPLOYMENTS", "gpt-6-sol, gpt-6-sol-b")
    assert foundry._deployments(get_pool("rose-1-ultra").gpt_auth_model) == ["gpt-6-sol", "gpt-6-sol-b"]
    for pool in ("rose-1-mini", "rose-1-flash", "rose-1-browser-use"):
        spec = get_pool(pool)
        assert spec.foundry_enabled, pool
        assert foundry._deployments(spec.gpt_auth_model) == ["gpt-5.6-luna"], pool
    monkeypatch.setenv("AZURE_FOUNDRY_DEPLOYMENTS", "gpt-5.6-luna-east")
    assert foundry._deployments("gpt-5.6-luna") == ["gpt-5.6-luna-east"]
    assert foundry._deployments("gpt-6-sol") == ["gpt-6-sol"]
    monkeypatch.delenv("AZURE_FOUNDRY_DEPLOYMENTS")
    assert foundry._deployments("gpt-6-sol") == ["gpt-6-sol"]
    # The open-weights pool's Foundry fallback stays open-weights.
    oss = get_pool("rose-1-oss")
    assert oss.foundry_enabled and foundry_model(oss) == "gpt-oss-120b"
    assert foundry._deployments(foundry_model(oss)) == ["gpt-oss-120b"]
