"""Foundry fallback contract with a fake HTTP boundary."""

import hashlib
import json

import httpx
import pytest
from structlog.testing import capture_logs

from providers.rose import foundry
from providers.rose.errors import RoseAuthError, RoseInvalidRequest, RoseRateLimitError, RoseServerError
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


_REAL_ASYNC_CLIENT = httpx.AsyncClient


def _install_http(monkeypatch, handler):
    monkeypatch.setattr(
        foundry.httpx,
        "AsyncClient",
        lambda **kwargs: _REAL_ASYNC_CLIENT(transport=httpx.MockTransport(handler), **kwargs),
    )
    # A developer .env may configure extra regions; each test owns its whole config.
    for name in foundry.FOUNDRY_REGION_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("AZURE_FOUNDRY_ENDPOINT", "https://a-4989-resource.openai.azure.com")
    monkeypatch.setenv("AZURE_FOUNDRY_API_KEY", "test-key")
    # No shared cooldown authority: these cases own every request the handler sees.
    monkeypatch.setattr(foundry, "_shared_scope", lambda: None)
    foundry._cooldown_until.clear()
    foundry._auth_cooldown_until.clear()


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
    assert foundry._cooldown_until[("https://a-4989-resource.openai.azure.com", calls[0])] > 0


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
            yield f"data: {json.dumps({'type': 'response.output_text.delta', 'delta': 'Partial'})}\n\n".encode()
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
    _install_http(monkeypatch, lambda _request: httpx.Response(500))

    def deployments(model):
        return [d for _, d in foundry._route_plan(foundry.foundry_regions(), model, "agent-1")]

    monkeypatch.setenv("AZURE_FOUNDRY_DEPLOYMENTS", "gpt-6-sol, gpt-6-sol-b")
    assert sorted(deployments(get_pool("rose-1-ultra").gpt_auth_model)) == ["gpt-6-sol", "gpt-6-sol-b"]
    for pool in ("rose-1-mini", "rose-1-flash", "rose-1-browser-use"):
        spec = get_pool(pool)
        assert spec.foundry_enabled, pool
        assert deployments(spec.gpt_auth_model) == ["gpt-5.6-luna"], pool
    monkeypatch.setenv("AZURE_FOUNDRY_DEPLOYMENTS", "gpt-5.6-luna-east")
    assert deployments("gpt-5.6-luna") == ["gpt-5.6-luna-east"]
    assert deployments("gpt-6-sol") == ["gpt-6-sol"]
    monkeypatch.delenv("AZURE_FOUNDRY_DEPLOYMENTS")
    assert deployments("gpt-6-sol") == ["gpt-6-sol"]
    # The open-weights pool's Foundry fallback stays open-weights.
    oss = get_pool("rose-1-oss")
    assert oss.foundry_enabled and foundry_model(oss) == "DeepSeek-V3.2"
    assert deployments(foundry_model(oss)) == ["DeepSeek-V3.2"]


@pytest.mark.asyncio
async def test_open_weights_foundry_omits_reasoning_params(monkeypatch):
    """Azure DeepSeek rejects reasoning params (HTTP 400); GPT pools keep their effort."""
    bodies = []

    def handler(request):
        bodies.append(json.loads(request.content))
        return httpx.Response(200, text=_sse({"type": "response.output_text.delta", "delta": "ok"}))

    _install_http(monkeypatch, handler)
    for pool in ("rose-1-oss", "rose-1-ultra"):
        async for _chunk in foundry.foundry_complete(
            pool_spec=get_pool(pool),
            messages=[{"role": "user", "content": "hi"}],
            response_format=None,
            tools=None,
            context_tools=None,
            tool_choice=None,
            temperature=None,
            effort=None,
            provider_fast_mode=False,
            request_id=f"reasoning-{pool}",
            route_key="agent-1",
            agent_id="agent-1",
            call_site="test",
            cache_namespace=None,
            ttft_timeout_s=2,
            idle_timeout_s=2,
        ):
            pass
    oss, ultra = bodies
    assert oss["model"] == "DeepSeek-V3.2"
    assert "reasoning" not in oss and "include" not in oss
    assert ultra["model"] == "gpt-6-sol" and ultra["reasoning"]["effort"] == "xhigh"


# ---------------------------------------------------------------------------
# Multi-region fallback: AZURE_FOUNDRY_* is region 1, *_2 and *_3 add regions.
# ---------------------------------------------------------------------------

_R1 = "https://a-4989-resource.openai.azure.com"
_R2 = "https://rose-eastus2.openai.azure.com"
_R3 = "https://rose-swedencentral.openai.azure.com"
_KEYS = {_R1: "key-region-1", _R2: "key-region-2", _R3: "key-region-3"}


def _install_regions(monkeypatch, handler, *, regions=(_R1, _R2, _R3), deployments="gpt-6-sol"):
    """Configure regions in slot order and route each request to ``handler(region, deployment)``."""
    requests = []

    def dispatch(request):
        region = f"https://{request.url.host}"
        assert str(request.url) == f"{region}/openai/v1/responses"
        assert request.headers["api-key"] == _KEYS[region], "each region must use its own key"
        deployment = json.loads(request.content)["model"]
        requests.append((region, deployment))
        return handler(region, deployment)

    _install_http(monkeypatch, dispatch)
    for slot, endpoint in enumerate(regions, start=1):
        suffix = "" if slot == 1 else f"_{slot}"
        monkeypatch.setenv(f"AZURE_FOUNDRY_ENDPOINT{suffix}", endpoint)
        monkeypatch.setenv(f"AZURE_FOUNDRY_API_KEY{suffix}", _KEYS[endpoint])
        monkeypatch.setenv(f"AZURE_FOUNDRY_DEPLOYMENTS{suffix}", deployments)
    return requests


def _call_with(route_key: str, pool: str = "rose-1-ultra"):
    return foundry.foundry_complete(
        pool_spec=get_pool(pool),
        messages=[{"role": "user", "content": "Say hi"}],
        response_format=None,
        tools=None,
        context_tools=None,
        tool_choice=None,
        temperature=None,
        effort="high",
        provider_fast_mode=True,
        request_id=f"region-{route_key}",
        route_key=route_key,
        agent_id=route_key,
        call_site="test",
        cache_namespace=None,
        ttft_timeout_s=2,
        idle_timeout_s=2,
    )


def _plan_regions(route_key: str, model: str = "gpt-6-sol") -> list[str]:
    return [region.endpoint for region, _ in foundry._route_plan(foundry.foundry_regions(), model, route_key)]


def _key_with_primary(endpoint: str) -> str:
    return next(f"agent-{i}" for i in range(10_000) if _plan_regions(f"agent-{i}")[0] == endpoint)


def _ok():
    return httpx.Response(200, text=_sse({"type": "response.output_text.delta", "delta": "Hi"}))


@pytest.mark.asyncio
async def test_region_one_429_fails_over_to_another_region_and_cools_only_that_deployment(monkeypatch):
    requests = _install_regions(
        monkeypatch,
        lambda region, _d: httpx.Response(429, headers={"retry-after-ms": "5000"}) if region == _R1 else _ok(),
    )
    route_key = _key_with_primary(_R1)
    chunks = [chunk async for chunk in _call_with(route_key)]
    assert [region for region, _ in requests] == _plan_regions(route_key)[:2]
    assert requests[0] == (_R1, "gpt-6-sol") and requests[1][0] != _R1
    assert next(c for c in chunks if c.kind == "content").data["text"] == "Hi"
    assert chunks[0].data["actual_model"] == "gpt-6-sol-foundry"
    assert set(foundry._cooldown_until) == {(_R1, "gpt-6-sol")}

    # While region 1 cools, the same agent goes straight to its next region.
    requests.clear()
    [chunk async for chunk in _call_with(route_key)]
    assert requests == [(_plan_regions(route_key)[1], "gpt-6-sol")]


@pytest.mark.asyncio
async def test_in_stream_rate_limit_fails_over_to_next_region(monkeypatch):
    """Azure reports a deployment's TPM ceiling inside an HTTP 200 stream."""

    def handler(region, _deployment):
        if region == _R1:
            return httpx.Response(
                200,
                text=_sse(
                    {
                        "type": "response.failed",
                        "response": {"error": {"code": "rate_limit_exceeded", "message": "exceeded token rate limit"}},
                    }
                ),
            )
        return _ok()

    requests = _install_regions(monkeypatch, handler)
    route_key = _key_with_primary(_R1)
    chunks = [chunk async for chunk in _call_with(route_key)]
    assert len(requests) == 2 and requests[0][0] == _R1 and requests[1][0] != _R1
    assert next(c for c in chunks if c.kind == "content").data["text"] == "Hi"
    assert (_R1, "gpt-6-sol") in foundry._cooldown_until


@pytest.mark.asyncio
async def test_every_region_cooling_raises_rate_limit_without_requests(monkeypatch):
    requests = _install_regions(monkeypatch, lambda *_: httpx.Response(429, headers={"retry-after": "30"}))
    with pytest.raises(RoseRateLimitError):
        [chunk async for chunk in _call_with("agent-saturated")]
    assert sorted(region for region, _ in requests) == sorted([_R1, _R2, _R3])
    requests.clear()
    with pytest.raises(RoseRateLimitError):
        [chunk async for chunk in _call_with("agent-other")]
    assert requests == [], "cooling regions must not be probed again"


@pytest.mark.asyncio
async def test_partial_output_never_fails_over_to_another_region(monkeypatch):
    requests = _install_regions(
        monkeypatch,
        lambda *_: httpx.Response(
            200,
            text=_sse(
                {"type": "response.output_text.delta", "delta": "Partial"},
                {"type": "response.failed", "error": {"code": "rate_limit_exceeded", "message": "late"}},
            ),
        ),
    )
    with pytest.raises(RoseRateLimitError):
        [chunk async for chunk in _call_with("agent-partial")]
    assert len(requests) == 1


@pytest.mark.asyncio
async def test_server_and_transport_errors_fail_over_without_cooldown(monkeypatch):
    route_key = None

    def handler(region, _deployment):
        order = _plan_regions(route_key)
        if region == order[0]:
            return httpx.Response(503)
        if region == order[1]:
            raise httpx.ConnectError("connection refused")
        return _ok()

    requests = _install_regions(monkeypatch, handler)
    route_key = "agent-server-errors"
    chunks = [chunk async for chunk in _call_with(route_key)]
    assert [region for region, _ in requests] == _plan_regions(route_key)
    assert next(c for c in chunks if c.kind == "content").data["text"] == "Hi"
    assert foundry._cooldown_until == {}, "transient 5xx/transport errors do not cool a deployment"


@pytest.mark.asyncio
async def test_request_shape_errors_stop_every_region(monkeypatch):
    for response in (
        httpx.Response(400),
        httpx.Response(
            200, text=_sse({"type": "error", "error": {"code": "context_length_exceeded", "message": "too long"}})
        ),
    ):
        requests = _install_regions(monkeypatch, lambda *_, response=response: response)
        with pytest.raises(RoseInvalidRequest):
            [chunk async for chunk in _call_with("agent-bad-request")]
        assert len(requests) == 1, "the same request body fails in every region"


@pytest.mark.asyncio
async def test_region_auth_failure_cools_only_that_regions_key(monkeypatch):
    requests = _install_regions(monkeypatch, lambda region, _d: httpx.Response(401) if region == _R2 else _ok())
    route_key = _key_with_primary(_R2)
    chunks = [chunk async for chunk in _call_with(route_key)]
    assert requests[0][0] == _R2 and requests[1][0] != _R2
    assert any(c.kind == "content" for c in chunks)
    assert foundry.foundry_configured(get_pool("rose-1-ultra"))
    requests.clear()
    [chunk async for chunk in _call_with(route_key)]
    assert all(region != _R2 for region, _ in requests)


@pytest.mark.asyncio
async def test_single_region_auth_failure_still_disables_foundry(monkeypatch):
    requests = _install_regions(monkeypatch, lambda *_: httpx.Response(403), regions=(_R1,))
    with pytest.raises(RoseAuthError):
        [chunk async for chunk in _call_with("agent-auth")]
    assert len(requests) == 1
    assert not foundry.foundry_configured(get_pool("rose-1-ultra"))


def test_route_key_keeps_a_stable_primary_and_spreads_load(monkeypatch):
    _install_regions(monkeypatch, lambda *_: _ok())
    keys = [f"agent-{i}" for i in range(3000)]
    plans = {key: _plan_regions(key) for key in keys}
    assert all(_plan_regions(key) == plans[key] for key in keys[:200]), "same agent, same region order"
    assert all(sorted(plan) == sorted([_R1, _R2, _R3]) for plan in plans.values())
    for region in (_R1, _R2, _R3):
        share = sum(plan[0] == region for plan in plans.values()) / len(keys)
        assert 0.28 < share < 0.39, (region, share)
        # One region's overflow spreads over every other region, not one neighbor.
        seconds = [plan[1] for plan in plans.values() if plan[0] == region]
        for other in {_R1, _R2, _R3} - {region}:
            assert 0.40 < seconds.count(other) / len(seconds) < 0.60, (region, other)

    # Adding a region moves only the agents it takes over: everyone else keeps
    # their primary region and its prompt cache.
    monkeypatch.delenv("AZURE_FOUNDRY_ENDPOINT_3")
    before = {key: _plan_regions(key)[0] for key in keys}
    monkeypatch.setenv("AZURE_FOUNDRY_ENDPOINT_3", _R3)
    moved = [key for key in keys if plans[key][0] != before[key]]
    assert all(plans[key][0] == _R3 for key in moved)


def test_single_region_config_keeps_the_legacy_route_plan(monkeypatch):
    """Without *_2/*_3 the plan is exactly the previous single-resource deployment rotation."""
    _install_http(monkeypatch, lambda _request: _ok())
    monkeypatch.setenv("AZURE_FOUNDRY_ENDPOINT", f"{_R1}/openai/v1/")
    monkeypatch.setenv("AZURE_FOUNDRY_DEPLOYMENTS", "gpt-6-sol,gpt-6-sol-b,gpt-6-sol-c")
    [region] = foundry.foundry_regions()
    assert (region.slot, region.endpoint, region.host) == (1, _R1, "a-4989-resource.openai.azure.com")
    names = ["gpt-6-sol", "gpt-6-sol-b", "gpt-6-sol-c"]
    for i in range(200):
        route_key = f"agent-{i}"
        start = int(hashlib.sha256(route_key.encode()).hexdigest()[:8], 16) % len(names)
        legacy = names[start:] + names[:start]
        plan = foundry._route_plan(foundry.foundry_regions(), "gpt-6-sol", route_key)
        assert [(r.endpoint, d) for r, d in plan] == [(_R1, name) for name in legacy]


def test_secondary_regions_serve_only_listed_models(monkeypatch):
    """A new resource holding only Sol must never receive Luna or DeepSeek traffic."""
    _install_regions(monkeypatch, lambda *_: _ok())
    for key in ("agent-1", "agent-2", "agent-3"):
        assert _plan_regions(key, "gpt-5.6-luna") == [_R1]
        assert _plan_regions(key, "DeepSeek-V3.2") == [_R1]
    for name in ("AZURE_FOUNDRY_ENDPOINT", "AZURE_FOUNDRY_API_KEY"):
        monkeypatch.delenv(name)
    assert foundry.foundry_configured(get_pool("rose-1-ultra"))
    assert not foundry.foundry_configured(get_pool("rose-1-mini"))
    # An incomplete region (missing key or endpoint) is not a region.
    monkeypatch.delenv("AZURE_FOUNDRY_API_KEY_2")
    assert [r.slot for r in foundry.foundry_regions()] == [3]


def test_model_listed_only_by_another_region_never_routes_to_region_one(monkeypatch):
    """Region 1 lists only Sol; region 2 lists GPT-6.1 Sol. Region 1's deploymentless
    GPT-6.1 call is a terminal 400, so every GPT-6.1 route key must start (and end) in region 2."""
    _install_regions(monkeypatch, lambda *_: _ok(), regions=(_R1, _R2))
    monkeypatch.setenv("AZURE_FOUNDRY_DEPLOYMENTS_2", "gpt-6.1-sol")
    for i in range(200):
        assert _plan_regions(f"agent-{i}", "gpt-6.1-sol") == [_R2]
        assert _plan_regions(f"agent-{i}", "gpt-5.6-luna") == [_R1]
    # Unlisted everywhere: region 1 keeps its deploymentless route.
    monkeypatch.setenv("AZURE_FOUNDRY_DEPLOYMENTS_2", "gpt-6-sol")
    assert _plan_regions("agent-1", "gpt-6.1-sol") == [_R1]


@pytest.mark.asyncio
async def test_unpinned_sol_pool_uses_any_sol_deployment_and_pinned_pool_does_not(monkeypatch):
    """GPT-6 Sol and GPT-6.1 Sol stand in for each other unless a pool pins its Foundry model."""
    _install_regions(monkeypatch, lambda *_: _ok(), regions=(_R1, _R2))
    monkeypatch.setenv("AZURE_FOUNDRY_DEPLOYMENTS_2", "gpt-6.1-sol")
    ultra = foundry.foundry_models(get_pool("rose-1-ultra"))
    assert ultra == ("gpt-6-sol", "gpt-6.1-sol")
    assert foundry.foundry_models(get_pool("rose-wmh-gpt61")) == ("gpt-6.1-sol",)
    assert foundry.foundry_models(get_pool("rose-1-oss")) == ("DeepSeek-V3.2",)
    plans = {
        f"agent-{i}": [(r.endpoint, d) for r, d in foundry._route_plan(foundry.foundry_regions(), ultra, f"agent-{i}")]
        for i in range(200)
    }
    assert all(sorted(plan) == [(_R1, "gpt-6-sol"), (_R2, "gpt-6.1-sol")] for plan in plans.values())
    assert 0.35 < sum(plan[0][0] == _R2 for plan in plans.values()) / len(plans) < 0.65
    for i in range(50):
        assert _plan_regions(f"agent-{i}", foundry.foundry_models(get_pool("rose-wmh-gpt61"))) == [_R2]

    # A region-1 429 moves ultra to the GPT-6.1 deployment, reported as the model that served.
    requests = _install_regions(
        monkeypatch,
        lambda region, _d: httpx.Response(429, headers={"retry-after": "5"}) if region == _R1 else _ok(),
        regions=(_R1, _R2),
    )
    monkeypatch.setenv("AZURE_FOUNDRY_DEPLOYMENTS_2", "gpt-6.1-sol")
    route_key = next(key for key, plan in plans.items() if plan[0][0] == _R1)
    chunks = [chunk async for chunk in _call_with(route_key)]
    assert requests == [(_R1, "gpt-6-sol"), (_R2, "gpt-6.1-sol")]
    assert chunks[0].data["actual_model"] == "gpt-6.1-sol-foundry"


@pytest.mark.asyncio
async def test_truncation_exclusion_removes_only_the_excluded_sol_model(monkeypatch):
    """A Sol model cut off at its output limit is never retried; the other Sol model still serves."""
    requests = _install_regions(monkeypatch, lambda *_: _ok(), regions=(_R1, _R2))
    monkeypatch.setenv("AZURE_FOUNDRY_DEPLOYMENTS_2", "gpt-6.1-sol")
    ultra = get_pool("rose-1-ultra")
    assert foundry.foundry_candidates(ultra, frozenset({"gpt61sol"})) == ("gpt-6-sol",)
    assert foundry.foundry_candidates(ultra, frozenset({"gpt6sol"})) == ("gpt-6.1-sol",)
    assert foundry.foundry_candidates(ultra, frozenset({"gpt6sol", "gpt61sol"})) == ()
    assert foundry.foundry_candidates(get_pool("rose-wmh-gpt61"), frozenset({"gpt6sol"})) == ("gpt-6.1-sol",)

    for excluded, served in (("gpt61sol", (_R1, "gpt-6-sol")), ("gpt6sol", (_R2, "gpt-6.1-sol"))):
        for i in range(20):
            requests.clear()
            chunks = [
                chunk
                async for chunk in foundry.foundry_complete(
                    pool_spec=ultra,
                    messages=[{"role": "user", "content": "Say hi"}],
                    response_format=None,
                    tools=None,
                    context_tools=None,
                    tool_choice=None,
                    temperature=None,
                    effort="high",
                    provider_fast_mode=True,
                    request_id=f"trunc-{excluded}-{i}",
                    route_key=f"agent-{i}",
                    agent_id=None,
                    call_site="test",
                    cache_namespace=None,
                    ttft_timeout_s=2,
                    idle_timeout_s=2,
                    skip_models=frozenset({excluded}),
                )
            ]
            assert requests == [served]
            assert chunks[0].data["actual_model"] == f"{served[1]}-foundry"
    with pytest.raises(RoseServerError):
        [
            chunk
            async for chunk in foundry.foundry_complete(
                pool_spec=ultra,
                messages=[{"role": "user", "content": "Say hi"}],
                response_format=None,
                tools=None,
                context_tools=None,
                tool_choice=None,
                temperature=None,
                effort="high",
                provider_fast_mode=True,
                request_id="trunc-all",
                route_key="agent-1",
                agent_id=None,
                call_site="test",
                cache_namespace=None,
                ttft_timeout_s=2,
                idle_timeout_s=2,
                skip_models=frozenset({"gpt6sol", "gpt61sol"}),
            )
        ]


@pytest.mark.asyncio
async def test_non_https_optional_region_is_skipped_and_primary_still_rejects(monkeypatch):
    """A typo in one optional slot must not stop the healthy regions (mirrors foundry.ts)."""
    monkeypatch.setattr(foundry, "_warned_insecure_regions", set())
    requests = _install_regions(monkeypatch, lambda *_: _ok(), regions=(_R1, _R2))
    monkeypatch.setenv("AZURE_FOUNDRY_ENDPOINT_7", "http://typo-region.openai.azure.com")
    monkeypatch.setenv("AZURE_FOUNDRY_API_KEY_7", "key-region-7")
    monkeypatch.setenv("AZURE_FOUNDRY_DEPLOYMENTS_7", "gpt-6-sol")
    with capture_logs() as logs:
        assert foundry.foundry_configured(get_pool("rose-1-ultra"))
        chunks = [chunk async for chunk in _call_with("agent-insecure-optional")]
        [chunk async for chunk in _call_with("agent-insecure-optional-2")]
    assert next(c for c in chunks if c.kind == "content").data["text"] == "Hi"
    assert {region for region, _ in requests} <= {_R1, _R2}
    warnings = [entry for entry in logs if entry["event"] == "rose.foundry.region_not_https"]
    assert len(warnings) == 1 and warnings[0]["env"] == "AZURE_FOUNDRY_ENDPOINT_7", warnings

    # Only the insecure optional region lists Ultra's model: routing never uses it.
    _install_regions(monkeypatch, lambda *_: _ok(), regions=(_R1, _R2), deployments="gpt-5.6-luna")
    for name in ("AZURE_FOUNDRY_ENDPOINT", "AZURE_FOUNDRY_API_KEY"):
        monkeypatch.delenv(name)
    monkeypatch.setenv("AZURE_FOUNDRY_ENDPOINT_3", "http://typo-region.openai.azure.com")
    monkeypatch.setenv("AZURE_FOUNDRY_API_KEY_3", "key-region-3")
    monkeypatch.setenv("AZURE_FOUNDRY_DEPLOYMENTS_3", "gpt-6-sol")
    assert not foundry.foundry_configured(get_pool("rose-1-ultra"))
    # No HTTPS region left: the configuration is rejected.
    monkeypatch.delenv("AZURE_FOUNDRY_ENDPOINT_2")
    with pytest.raises(RoseInvalidRequest, match="AZURE_FOUNDRY_ENDPOINT_3 must be HTTPS"):
        [chunk async for chunk in _call_with("agent-only-insecure")]

    # A non-HTTPS region 1 still rejects the whole configuration before any request.
    requests = _install_regions(monkeypatch, lambda *_: _ok(), regions=(_R1, _R2))
    monkeypatch.setenv("AZURE_FOUNDRY_ENDPOINT", "http://a-4989-resource.openai.azure.com")
    assert foundry.foundry_configured(get_pool("rose-1-ultra")), "routing surfaces the config error"
    with pytest.raises(RoseInvalidRequest, match="AZURE_FOUNDRY_ENDPOINT must be HTTPS"):
        [chunk async for chunk in _call_with("agent-insecure-primary")]
    assert requests == []


@pytest.mark.asyncio
async def test_region_evidence_is_logged_and_keys_never_are(monkeypatch):
    def handler(region, _deployment):
        if region == _R1:
            return httpx.Response(429, headers={"retry-after-ms": "1000"})
        if region == _R2:
            return httpx.Response(401)
        return _ok()

    requests = _install_regions(monkeypatch, handler)
    route_key = next(f"agent-{i}" for i in range(10_000) if _plan_regions(f"agent-{i}") == [_R1, _R2, _R3])
    with capture_logs() as logs:
        [chunk async for chunk in _call_with(route_key)]
    assert [region for region, _ in requests] == [_R1, _R2, _R3]
    failed = [entry for entry in logs if entry["event"] == "rose.foundry.attempt_failed"]
    assert [(e["region"], e["region_slot"], e["deployment"], e["status"]) for e in failed] == [
        ("a-4989-resource.openai.azure.com", 1, "gpt-6-sol", 429),
        ("rose-eastus2.openai.azure.com", 2, "gpt-6-sol", 401),
    ]
    [served] = [entry for entry in logs if entry["event"] == "rose.foundry.served"]
    assert (served["region"], served["region_slot"], served["deployment"]) == (
        "rose-swedencentral.openai.azure.com",
        3,
        "gpt-6-sol",
    )
    assert served["attempt"] == 3
    rendered = repr(logs) + repr(foundry.foundry_regions())
    assert not any(key in rendered for key in _KEYS.values()), "an API key reached a log or repr"
