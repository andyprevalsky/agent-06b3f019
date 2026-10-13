"""WHM opt-in reliability contracts; all provider and activity calls are offline."""
import asyncio
from copy import deepcopy
from datetime import timedelta
from unittest.mock import AsyncMock

import pytest

from benchmarks.wmh_grounding_filter import failed_tool_result
from benchmarks.wmh_execution_policy import execution_identity, validate_execution_identity
from helpers.wmh_activity_policy import wmh_activity_timeout_options
from providers.rose.client import RoseClient
from providers.rose.errors import RoseStallError
from providers.rose.types import StreamChunk


@pytest.mark.parametrize("value", [
    {"is_error": True}, {"success": False}, {"error": "HTTP503"},
    {"status": "FAILED"}, {"metadata": {"toolStatus": "error"}},
    {"metadata": {"result_unavailable": True}},
    {"kind": "tool_result", "content": '{"is_error":true,"content":"timeout"}'},
    {"tool_results": [{"is_error": False}, {"is_error": True}]},
])
def test_explicit_failed_results_are_excluded(value):
    original = deepcopy(value)
    assert failed_tool_result(value)
    assert value == original


@pytest.mark.parametrize("value", [
    {"is_error": False, "content": "Investor declined; no route found"},
    {"status": "sent", "error": None}, "error in fundraising assumptions",
    {"content": "Investor refused a meeting"}, {"success": True},
])
def test_negative_business_outcomes_are_retained(value):
    assert not failed_tool_result(value)


def test_runtime_identity_changes_without_rewriting_base_policy():
    base = execution_identity("rose-outcome-distribution-v3", "artifact-a", "a" * 64)
    config = {"inference_pool": "rose-1-flash", "inference_pool_sha256": "b" * 64,
              "azure_first": True, "exclude_failed_tool_examples": True}
    active = execution_identity("rose-outcome-distribution-v3", "artifact-a", "a" * 64,
                                runtime_config=config)
    assert {k: v for k, v in active.items() if k not in {"runtime_config", "execution_sha256"}} == {
        k: v for k, v in base.items() if k != "execution_sha256"}
    assert active["execution_sha256"] != base["execution_sha256"]
    assert validate_execution_identity(active, "rose-outcome-distribution-v3") == active
    changed = deepcopy(active)
    changed["runtime_config"]["azure_first"] = False
    with pytest.raises(ValueError):
        validate_execution_identity(changed, "rose-outcome-distribution-v3")
    assert execution_identity("rose-outcome-distribution-v3", "artifact-a", "a" * 64) == base


def test_opt_in_route_cache_keys_are_distinct_and_default_material_is_unchanged():
    from providers.fast_cache.rose_cache import request_key_material
    request = {"pool": "rose-1-flash", "messages": [{"role": "user", "content": "offline"}]}
    base = request_key_material(request)
    assert "prefer_azure" not in base and "retry_partial_errors" not in base
    assert request_key_material({**request, "prefer_azure": False, "retry_partial_errors": False}) == base
    azure = request_key_material({**request, "prefer_azure": True, "retry_partial_errors": True})
    assert azure != base and azure["prefer_azure"] is True and azure["retry_partial_errors"] is True


@pytest.mark.parametrize("channel,seconds", [("email", 60), ("agent_sms", 45), ("imessage", 150)])
@pytest.mark.parametrize("mode", ["real", "simulate", "shadow"])
def test_actual_message_scheduling_keeps_real_deadlines_and_removes_wmh_attempt_deadlines(monkeypatch, channel, seconds, mode):
    from domains.message_person.handler import MessagePersonManager
    captured = []

    async def activity(fn, *, args, **kwargs):
        captured.append((args, kwargs))
        return {"success": True, "status": "sent", "message_id": "offline", "queue_id": "offline"}

    monkeypatch.setattr("domains.message_person.handler.workflow.execute_activity", activity)
    asyncio.run(MessagePersonManager._deliver_message(
        channel=channel, user_id="user", agent_id="actor", tool_call_id="call", context=[],
        person_phone="+15555550100", generated_message="offline", person_display="recipient",
        world_model_mode=mode, world_model_session_scope_id="scope", person_email="a@example.invalid",
        from_email="b@example.invalid", generated_subject="offline"))
    assert len(captured) == 1
    args, options = captured[0]
    if mode == "real":
        assert options["start_to_close_timeout"] == timedelta(seconds=seconds)
        assert "schedule_to_close_timeout" not in options
    else:
        assert "start_to_close_timeout" not in options
        assert options["schedule_to_close_timeout"] > timedelta(hours=1)
        assert args[-3:] == [mode, "scope", True]
    assert wmh_activity_timeout_options("real", timedelta(seconds=30)) == {
        "start_to_close_timeout": timedelta(seconds=30)}


@pytest.mark.parametrize("prefer_azure,fail_azure,recover,expected", [
    (False, False, False, ["cerebras"]),
    (True, False, False, ["foundry"]),
    (True, True, True, ["foundry", "cerebras"]),
])
def test_flash_routes_and_discards_abandoned_partial_reply(monkeypatch, prefer_azure, fail_azure, recover, expected):
    import providers.rose.client as module
    from providers.fast_cache import client as cache
    attempts = []
    monkeypatch.setattr(cache, "ensure_context", AsyncMock(return_value=None))
    monkeypatch.setattr(module, "foundry_configured", lambda _: True)
    monkeypatch.setattr(module, "_cerebras_api_key", lambda: "offline-key")

    def route(name, model):
        async def stream(**kwargs):
            attempts.append(name)
            yield StreamChunk(kind="metadata", data={"actual_model": model})
            if name == "foundry" and fail_azure:
                yield StreamChunk(kind="content", data={"text": '{"abandoned":'})
                raise RoseStallError("offline partial idle timeout")
            yield StreamChunk(kind="content", data={"text": '{"result":"complete"}'})
            yield StreamChunk(kind="usage", data={"prompt_tokens": 1, "completion_tokens": 1})
            yield StreamChunk(kind="done", data={})
        return stream

    monkeypatch.setattr(module, "foundry_complete", route("foundry", "gpt-5.6-luna-foundry"))
    monkeypatch.setattr(module, "cerebras_complete", route("cerebras", "qwen-3.8-27b"))
    response = asyncio.run(RoseClient(openrouter_key="offline").collect(
        pool="rose-1-flash", messages=[{"role": "user", "content": "offline"}], dump_context=False,
        prefer_azure=prefer_azure, result_required=True, retry_partial_errors=recover))
    assert attempts == expected
    assert response.content == '{"result":"complete"}'
    if recover:
        assert response.usage["abandoned_attempts"][0]["usage_complete"] is False


def test_partial_failure_is_unchanged_without_opt_in_and_cancellation_is_never_retried():
    from providers.rose.truncation import recover_truncated

    async def run(exc, enabled):
        calls = []
        async def stream(**kwargs):
            calls.append(kwargs)
            yield StreamChunk(kind="metadata", data={"actual_model": "gpt-5.6-luna-foundry"})
            yield StreamChunk(kind="content", data={"text": "partial"})
            raise exc
        with pytest.raises(type(exc)):
            async for _ in recover_truncated(stream, {"result_required": True, "retry_partial_errors": enabled}):
                pass
        assert len(calls) == 1
    asyncio.run(run(RoseStallError("offline"), False))
    asyncio.run(run(asyncio.CancelledError(), True))


def test_all_partial_provider_failures_stop_after_one_fallback():
    from providers.rose.truncation import recover_truncated
    async def run():
        calls = []
        async def stream(**kwargs):
            calls.append(kwargs)
            yield StreamChunk(kind="metadata", data={"actual_model": "gpt-5.6-luna-foundry"})
            raise RoseStallError("offline")
        with pytest.raises(RoseStallError):
            async for _ in recover_truncated(stream, {"result_required": True, "retry_partial_errors": True}):
                pass
        assert len(calls) == 2
    asyncio.run(run())


def test_bridge_rejects_runtime_settings_different_from_served_configuration(monkeypatch):
    import httpx
    from benchmarks.experiential_bridge import build_provider_bridge
    monkeypatch.setattr("benchmarks.wmh_execution_policy.validate_execution_identity", lambda identity, *_args, **_kw: identity)
    policy = "rose-outcome-distribution-v3"
    config = {"inference_pool": "rose-1-flash", "inference_pool_sha256": "b" * 64,
              "azure_first": True, "exclude_failed_tool_examples": True}
    different = {**config, "azure_first": False}
    identity = execution_identity(policy, "artifact-a", "a" * 64, runtime_config=different)
    class Provider:
        calls = 0
        async def complete_scoped(self, *args, **kwargs):
            self.calls += 1
            raise AssertionError("Mismatching settings must fail before any provider call")
    async def run():
        provider = Provider()
        app = build_provider_bridge(provider, "offline-token", execution_policy=policy, runtime_config=config)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://offline") as client:
            response = await client.post("/complete", headers={"X-Rose-Provider-Token": "offline-token"}, json={
                "session_id": "session", "prediction_id": "prediction", "maximum_output_tokens": 16384,
                "execution_identity": identity, "messages": [
                    {"role": "system", "content": "offline validated system fixture"},
                    {"role": "user", "content": "{}"}]})
        assert response.status_code == 409 and provider.calls == 0
        assert "runtime configuration differs" in response.text
    asyncio.run(run())


@pytest.mark.parametrize("json_mode", [False, True])
def test_flash_json_mode_reaches_foundry_body_and_default_stays_plain(monkeypatch, json_mode):
    import json
    import sys
    from pathlib import Path
    import httpx
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests/blackbox"))
    from _test_utils import set_mock_handler, teardown_mock
    from providers.fast_cache import client as cache
    body = []
    def handler(request):
        assert request.url.host == "offline.azure.com", "No funded provider may be contacted"
        body.append(json.loads(request.content))
        text = 'data: {"type":"response.output_text.delta","delta":"{\\"result\\":true}"}\n\n'
        text += 'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'
        text += 'data: [DONE]\n\n'
        return httpx.Response(200, text=text, headers={"Content-Type": "text/event-stream"})
    monkeypatch.setattr(cache, "ensure_context", AsyncMock(return_value=None))
    monkeypatch.setenv("AZURE_FOUNDRY_ENDPOINT", "https://offline.azure.com")
    monkeypatch.setenv("AZURE_FOUNDRY_API_KEY", "offline-key")
    monkeypatch.setenv("CEREBRAS_API_KEY", "")
    monkeypatch.setenv("GPT_API_KEY", "")
    set_mock_handler(handler)
    try:
        response = asyncio.run(RoseClient(openrouter_key="offline").collect(
            pool="rose-1-flash", messages=[{"role": "user", "content": "Return JSON"}],
            prefer_azure=True, json_mode=json_mode, dump_context=False))
    finally:
        teardown_mock()
    assert response.content == '{"result":true}' and len(body) == 1
    if json_mode:
        assert body[0]["text"]["format"] == {"type": "json_object"}
    else:
        assert "text" not in body[0]


@pytest.mark.parametrize("accepted", [False, True])
def test_store_event_matches_actual_cache_write_result(monkeypatch, accepted):
    from providers.fast_cache.context import FastCacheContext, set_context, reset_context
    from providers.fast_cache import client as cache
    import providers.rose.client as module
    events = []
    monkeypatch.setattr(module.logger, "info", lambda event, **kw: events.append(event))
    monkeypatch.setattr(cache, "cache_set", AsyncMock(return_value=accepted))
    monkeypatch.setenv("FAST_MODE_CACHE_DISABLE_WRITE_THROUGH", "0")
    monkeypatch.setenv("FAST_MODE_CACHE_RECORD_DEMO", "1")
    async def stream(**kw):
        yield StreamChunk(kind="content", data={"text": "offline"})
        yield StreamChunk(kind="done", data={})
    client = RoseClient(openrouter_key="offline")
    monkeypatch.setattr(client, "_complete_impl", stream)
    async def run():
        token = set_context(FastCacheContext(enabled=False, goal="offline", write_enabled=True))
        try:
            await client.collect(pool="rose-1-flash", messages=[])
        finally:
            reset_context(token)
    asyncio.run(run())
    assert ("llm.cache.stored" in events) is accepted
    assert ("llm.cache.store_skipped" in events) is not accepted


def test_json_mode_is_bound_in_execution_and_cache_identity():
    from providers.fast_cache.rose_cache import request_key_material
    config = {"inference_pool": "rose-1-flash", "inference_pool_sha256": "b" * 64,
              "azure_first": True, "exclude_failed_tool_examples": True}
    base = execution_identity("rose-outcome-distribution-v3", "artifact-a", "a" * 64, runtime_config=config)
    formatted = execution_identity("rose-outcome-distribution-v3", "artifact-a", "a" * 64,
                                    runtime_config={**config, "json_mode": True})
    assert formatted["execution_sha256"] != base["execution_sha256"]
    assert validate_execution_identity(formatted, "rose-outcome-distribution-v3") == formatted
    ordinary = request_key_material({"pool": "rose-1-flash"})
    assert "json_mode" not in ordinary
    assert request_key_material({"pool": "rose-1-flash", "json_mode": False}) == ordinary
    assert request_key_material({"pool": "rose-1-flash", "json_mode": True}) != ordinary


def test_bridge_retains_rejected_reply_for_native_private_parser_repro():
    import httpx
    from benchmarks.experiential_bridge import build_provider_bridge
    from benchmarks.wmh_rose_provider import _WMHInvalidPrediction
    rejected = '{"outcomes":[{"id":"bad unescaped "quote""}]}'
    class Provider:
        async def complete_scoped(self, *args, **kwargs):
            raise _WMHInvalidPrediction("invalid JSON fixture", {"prompt_tokens": 1}, "offline", rejected)
    async def run():
        app = build_provider_bridge(Provider(), "offline")
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://offline") as client:
            result = await client.post("/complete", headers={"X-Rose-Provider-Token": "offline"}, json={
                "session_id": "session", "prediction_id": "prediction", "maximum_output_tokens": 16384,
                "messages": [{"role": "system", "content": "fixture"}, {"role": "user", "content": "{}"}]})
        assert result.status_code == 422
        detail = result.json()["detail"]
        assert detail["kind"] == "invalid_prediction"
        assert detail["rejected_response"]["content"] == rejected
    asyncio.run(run())
