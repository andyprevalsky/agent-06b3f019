"""WHM opt-in reliability contracts; all provider and activity calls are offline."""

import asyncio
from copy import deepcopy
from datetime import timedelta
from unittest.mock import AsyncMock

import pytest

from benchmarks.wmh_execution_policy import execution_identity, validate_execution_identity
from benchmarks.wmh_grounding_filter import failed_tool_result
from helpers.wmh_activity_policy import wmh_activity_timeout_options
from providers.rose.client import RoseClient
from providers.rose.errors import RoseStallError
from providers.rose.types import RoseResponse, StreamChunk


def _grounded_retry_control(
    monkeypatch, failures, *, seconds=0, retry_after=None, wall_gap=False, hang_first=False, blocked_backoff=None
):
    """Actual WHM collect/validator/cache owner; only provider stream and clock controlled."""
    import json

    from benchmarks import wmh_rose_provider as wmh
    from providers.demo_cache import client as cache
    from providers.rose import errors

    calls, captures, sleeps, chunks = [], [], [], []
    clock = {"mono": 0.0, "wall": 0.0}
    try:
        from benchmarks import wmh_completion_retry as policy
    except ImportError:
        policy = None
    if policy is not None:
        monkeypatch.setattr(policy, "_monotonic", lambda: clock["mono"])
        monkeypatch.setattr(policy, "_wall", lambda: clock["wall"])
        monkeypatch.setattr(policy, "_random", lambda: 0.0)

        async def sleep(delay):
            sleeps.append(delay)
            if blocked_backoff is not None:
                blocked_backoff.set()
                await asyncio.Future()
            clock["mono"] += delay
            clock["wall"] += delay

        monkeypatch.setattr(policy, "_sleep", sleep)
    monkeypatch.setattr(cache, "ensure_context", AsyncMock(return_value=None))

    async def capture(value):
        assert "private-lease-marker" not in json.dumps(value)
        captures.append(value)

    recorder = getattr(wmh, "REJECTION_RECORDER", None)
    valid = json.dumps(
        {
            "schema": "rose.wmh_timed_outcome_distribution.v1",
            "outcomes": [
                {
                    "id": "one",
                    "probability": 1,
                    "elapsed_ms": 1000,
                    "description": "offline",
                    "state_patch": [],
                    "tool_results": [{"call_id": "call-1", "content": "valid", "is_error": False}],
                }
            ],
        }
    )
    messages = [
        {"role": "system", "content": "offline fixed policy"},
        {
            "role": "user",
            "content": json.dumps(
                {
                    "environment_state": {},
                    "candidate_response": {"tool_calls": [{"call_id": "call-1"}]},
                }
            ),
        },
    ]

    async def once(self, **kwargs):
        calls.append(kwargs)
        yield StreamChunk(kind="metadata", data={"actual_model": "gpt-5.6-luna-foundry"})
        if hang_first and len(calls) == 1:
            await asyncio.sleep(1)
        yield StreamChunk(kind="content", data={"text": "abandoned" if len(calls) <= len(failures) else valid})
        clock["mono"] += seconds
        clock["wall"] += seconds + (1000 if wall_gap else 0)
        yield StreamChunk(
            kind="usage",
            data={
                "prompt_tokens": 10,
                "completion_tokens": 3,
                "cache_read_input_tokens": 7,
                "total_tokens": 13,
                "finish_reason": "stop",
            },
        )
        if len(calls) <= len(failures):
            error = failures[len(calls) - 1]
            if retry_after is not None and error is not None:
                error.retry_after_s = retry_after
            if error is not None:
                raise error
        yield StreamChunk(kind="done", data={})

    monkeypatch.setattr(RoseClient, "_complete_once", once)
    client = wmh._WMHCacheSafeRoseClient(openrouter_key="offline")

    async def run():
        token = recorder.set(capture) if recorder is not None else None
        try:
            response = await client.collect(
                pool="rose-1-flash",
                messages=messages,
                call_site="wmh_world_model_timed_distribution_v1",
                result_required=True,
                retry_partial_errors=True,
                max_tokens=16384,
                deadline_s=590,
            )
            return response
        finally:
            if recorder is not None:
                recorder.reset(token)

    return run, calls, captures, sleeps, clock, chunks, errors


def test_whm_grounded_schedule_retries_twice_without_reusing_failed_partial_reply(monkeypatch):
    run, calls, captures, sleeps, _, _, _ = _grounded_retry_control(
        monkeypatch, [RoseStallError("first"), RoseStallError("second")]
    )
    response = asyncio.run(run())
    assert len(calls) == 3 and sleeps == [0.5, 1.0]
    assert len(captures) == 2
    assert "abandoned" not in response.content
    assert response.usage["prompt_tokens"] == 30
    assert response.usage["completion_tokens"] == 9
    assert response.usage["cache_read_input_tokens"] == 21
    assert len(response.usage["abandoned_attempts"]) == 2
    assert all(call["messages"] == calls[0]["messages"] for call in calls)
    assert all(
        call["deadline_s"] == 360 and call["ttft_timeout_s"] == 90 and call["idle_timeout_s"] == 120 for call in calls
    )


@pytest.mark.parametrize(
    "name", ["RoseAuthError", "RoseInvalidRequest", "RosePaymentRequiredError", "RoseRefusalError"]
)
def test_whm_grounded_schedule_does_not_repeat_permanent_failures(monkeypatch, name):
    from providers.rose import errors

    error = getattr(errors, name)("offline permanent failure")
    run, calls, captures, sleeps, _, _, _ = _grounded_retry_control(monkeypatch, [error])
    with pytest.raises(type(error)):
        asyncio.run(run())
    assert len(calls) == 1 and sleeps == [] and captures == []


def test_whm_grounded_schedule_honors_retry_after_floor(monkeypatch):
    from providers.rose.errors import RoseRateLimitError

    run, calls, captures, sleeps, _, _, _ = _grounded_retry_control(
        monkeypatch, [RoseRateLimitError("offline short throttle", status=429)], retry_after=4
    )
    asyncio.run(run())
    assert len(calls) == 2 and len(captures) == 1 and sleeps == [4]


def test_whm_grounded_schedule_never_shortens_retry_after_to_fit_deadline(monkeypatch):
    from providers.rose.errors import RoseDeadlineError, RoseRateLimitError

    run, calls, _, sleeps, _, _, _ = _grounded_retry_control(
        monkeypatch, [RoseRateLimitError("offline long throttle", status=429)], retry_after=600
    )
    with pytest.raises(RoseDeadlineError):
        asyncio.run(run())
    assert len(calls) == 1 and sleeps == []


def test_whm_grounded_schedule_uses_one_budget_for_attempts_and_backoff(monkeypatch):
    run, calls, _, sleeps, clock, _, _ = _grounded_retry_control(
        monkeypatch, [RoseStallError("first"), RoseStallError("second")], seconds=180
    )
    asyncio.run(run())
    assert len(calls) == 3 and sleeps == [0.5, 1]
    assert calls[0]["deadline_s"] == 360 and calls[1]["deadline_s"] == 360
    assert calls[2]["deadline_s"] == pytest.approx(228.5)
    assert clock["mono"] == 541.5


def test_whm_grounded_schedule_rejects_success_after_forward_wall_clock_gap(monkeypatch):
    from providers.rose.errors import RoseDeadlineError

    run, calls, _, sleeps, _, _, _ = _grounded_retry_control(monkeypatch, [], wall_gap=True)
    with pytest.raises(RoseDeadlineError):
        asyncio.run(run())
    assert len(calls) == 1 and sleeps == []


def test_whm_grounded_schedule_preserves_cancellation_without_another_attempt(monkeypatch):
    run, calls, _, sleeps, _, _, _ = _grounded_retry_control(monkeypatch, [asyncio.CancelledError()])
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(run())
    assert len(calls) == 1 and sleeps == []


def test_whm_grounded_schedule_enforces_actual_attempt_timer_and_marks_unknown_usage(monkeypatch):
    from benchmarks import wmh_completion_retry as policy

    monkeypatch.setitem(policy.POLICY, "attempt_seconds", 0.01)
    run, calls, captures, sleeps, _, _, _ = _grounded_retry_control(monkeypatch, [], hang_first=True)
    response = asyncio.run(run())
    assert len(calls) == 2 and len(captures) == 1 and sleeps == [0.5]
    assert captures[0]["error_type"] == "TimeoutError" and captures[0]["usage_complete"] is False
    assert response.usage["prompt_tokens"] == 10 and response.usage["completion_tokens"] == 3
    assert response.usage["usage_complete"] is False
    assert response.usage["abandoned_attempts"][0]["usage_complete"] is False


def test_whm_grounded_schedule_joins_cancellation_during_backoff(monkeypatch):
    async def check():
        entered = asyncio.Event()
        run, calls, _, sleeps, _, _, _ = _grounded_retry_control(
            monkeypatch, [RoseStallError("offline transient")], blocked_backoff=entered
        )
        task = asyncio.create_task(run())
        await asyncio.wait_for(entered.wait(), timeout=0.5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert len(calls) == 1 and sleeps == [0.5] and task.done()

    asyncio.run(check())


def test_whm_grounded_schedule_caps_combined_semantic_and_transient_attempts(monkeypatch):
    from providers.rose.errors import RoseError

    run, calls, captures, sleeps, _, _, _ = _grounded_retry_control(
        monkeypatch, [None, RoseStallError("middle"), RoseStallError("last")]
    )
    with pytest.raises(RoseError) as caught:
        asyncio.run(run())
    assert len(calls) == 3 and len(captures) == 3 and sleeps == [0.5]
    assert [row["attempt_ordinal"] for row in captures] == [1, 2, 3]
    assert caught.value.usage["prompt_tokens"] == 30 and caught.value.usage["completion_tokens"] == 9
    assert calls[1]["_skip_models"] == calls[2]["_skip_models"]


def test_whm_grounded_schedule_uses_unique_ordinals_for_transient_then_semantic_repair(monkeypatch):
    run, calls, captures, sleeps, _, _, _ = _grounded_retry_control(
        monkeypatch, [RoseStallError("first transient"), None]
    )
    response = asyncio.run(run())
    assert len(calls) == 3 and sleeps == [0.5]
    assert [row["attempt_ordinal"] for row in captures] == [1, 2]
    assert response.usage["prompt_tokens"] == 30 and response.usage["completion_tokens"] == 9


def test_whm_grounded_budget_never_refunds_forward_clock_gap_when_wall_clock_corrects(monkeypatch):
    from benchmarks import wmh_completion_retry as policy

    clock = {"mono": 0, "wall": 0}
    monkeypatch.setattr(policy, "_monotonic", lambda: clock["mono"])
    monkeypatch.setattr(policy, "_wall", lambda: clock["wall"])
    budget = policy.CompletionRetryBudget()
    assert budget.remaining() == 590
    clock["wall"] = 400
    assert budget.remaining() == 190
    clock.update(mono=1, wall=1)
    assert budget.remaining() == 189
    clock.update(mono=31, wall=31)
    assert budget.remaining() == 159


@pytest.mark.parametrize("provider_name", ["foundry", "cerebras"])
@pytest.mark.parametrize("response_case", ["short", "long", "quota", "server"])
def test_actual_provider_retry_metadata_reaches_whm_owner_and_is_inactive_elsewhere(
    monkeypatch, provider_name, response_case
):
    from contextlib import asynccontextmanager
    from types import SimpleNamespace

    import httpx

    from benchmarks import wmh_completion_retry as policy
    from providers.rose import cerebras, foundry
    from providers.rose.errors import RoseError
    from providers.rose.pools import get_pool
    from providers.rose.whm_retry_observation import FAILURE_OBSERVER

    headers = {"retry-after": "4" if response_case in {"short", "server"} else "600"}
    body = {"error": {"code": "insufficient_quota" if response_case == "quota" else "rate_limit_exceeded"}}
    pool = get_pool("rose-1-flash")
    captured = []
    network_requests = []
    provider_clock = {"now": foundry.time.monotonic()}
    monkeypatch.setattr(foundry, "time", SimpleNamespace(monotonic=lambda: provider_clock["now"]))

    def respond(request):
        network_requests.append(request)
        return httpx.Response(503 if response_case == "server" else 429, headers=headers, json=body)

    original_client = httpx.AsyncClient
    monkeypatch.setattr(
        foundry.httpx, "AsyncClient", lambda **kwargs: original_client(**kwargs, transport=httpx.MockTransport(respond))
    )
    for name in foundry.FOUNDRY_REGION_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("AZURE_FOUNDRY_ENDPOINT", "https://offline.invalid")
    monkeypatch.setenv("AZURE_FOUNDRY_API_KEY", "private-lease-marker")
    monkeypatch.setattr(foundry, "_region_deployments", lambda *_: ["offline-deployment"])
    monkeypatch.setattr(foundry, "_cooldown_until", {})
    monkeypatch.setattr(foundry, "_auth_cooldown_until", {})
    monkeypatch.setattr(foundry, "_shared_scope", lambda: None)
    monkeypatch.setattr(cerebras, "_cooldown_scope", lambda *_: (("", "offline", "offline"), ""))
    monkeypatch.setattr(cerebras, "_cerebras_on_cooldown", AsyncMock(return_value=False))
    monkeypatch.setattr(cerebras, "_mark_cerebras_cooldown", AsyncMock())

    @asynccontextmanager
    async def post(**kwargs):
        async with original_client(transport=httpx.MockTransport(respond)) as client:
            yield await client.post("https://offline.invalid/cerebras", json=kwargs["body"])

    monkeypatch.setattr(cerebras, "post_cerebras_stream", post)

    async def attempt(**kwargs):
        if provider_name == "foundry":
            source = foundry.foundry_complete(
                pool_spec=pool,
                messages=[],
                response_format=None,
                tools=None,
                context_tools=None,
                tool_choice=None,
                temperature=None,
                effort=None,
                provider_fast_mode=True,
                request_id="offline",
                route_key=None,
                agent_id=None,
                call_site="wmh_world_model_timed_distribution_v1",
                cache_namespace=None,
                ttft_timeout_s=90,
                idle_timeout_s=120,
            )
        else:
            source = cerebras.cerebras_complete(
                pool_spec=pool,
                messages=[],
                tools=None,
                cerebras_key="private-lease-marker",
                request_id="offline",
                call_site="wmh_world_model_timed_distribution_v1",
            )
        async for chunk in source:
            yield chunk

    async def run():
        # Default owner: actual HTTP behavior/error class unchanged, no observer.
        with pytest.raises(RoseError):
            async for _ in attempt():
                pass
        assert FAILURE_OBSERVER.get() is None
        monkeypatch.setattr(foundry, "_cooldown_until", {})

        async def sleep(delay):
            provider_clock["now"] += delay

        monkeypatch.setattr(policy, "_sleep", sleep)
        budget = policy.CompletionRetryBudget()

        async def capture(value):
            captured.append(value)

        with pytest.raises(Exception):
            async for _ in policy.scheduled_attempt(attempt, {}, budget, capture):
                pass
        assert budget.attempts == (3 if response_case in {"short", "server"} else 1)
        if response_case == "quota":
            assert getattr(budget.last_error, "wmh_permanent_route_failure") is True
        else:
            assert policy.retry_after_seconds(budget.last_error) == float(headers["retry-after"])
        assert FAILURE_OBSERVER.get() is None
        assert "private-lease-marker" not in repr(captured)

    asyncio.run(run())
    assert network_requests


def test_actual_rose_failure_retains_foundry_retry_floor_on_terminal_waterfall(monkeypatch):
    import json
    from types import SimpleNamespace

    import httpx

    from benchmarks import wmh_completion_retry as policy
    from benchmarks import wmh_rose_provider as wmh
    from providers.demo_cache import client as cache
    from providers.rose import client as rose
    from providers.rose import foundry
    from providers.rose.errors import RoseAllFailed, RoseError, RoseServerError, RoseStepError

    captured, sleeps, requests = [], [], []
    clock = {"now": foundry.time.monotonic()}
    original = httpx.AsyncClient

    def respond(request):
        requests.append(request)
        return httpx.Response(429, headers={"retry-after": "4"}, json={"error": {"code": "rate_limit_exceeded"}})

    monkeypatch.setattr(
        foundry.httpx, "AsyncClient", lambda **kw: original(**kw, transport=httpx.MockTransport(respond))
    )
    monkeypatch.setattr(foundry, "time", SimpleNamespace(monotonic=lambda: clock["now"]))
    monkeypatch.setattr(foundry, "_region_deployments", lambda *_: ["offline-deployment"])
    monkeypatch.setattr(foundry, "_cooldown_until", {})
    monkeypatch.setattr(foundry, "_auth_cooldown_until", {})
    monkeypatch.setattr(foundry, "_shared_scope", lambda: None)
    for name in foundry.FOUNDRY_REGION_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("AZURE_FOUNDRY_ENDPOINT", "https://offline.invalid")
    monkeypatch.setenv("AZURE_FOUNDRY_API_KEY", "private-lease-marker")
    monkeypatch.setattr(rose, "_openai_api_key", lambda: "")
    monkeypatch.setattr(rose, "load_config", lambda: SimpleNamespace(anthropic=SimpleNamespace(api_key="")))
    monkeypatch.setattr(rose, "_cerebras_api_key", lambda: "")
    monkeypatch.setattr(cache, "ensure_context", AsyncMock(return_value=None))

    async def waterfall(**kwargs):
        yield StreamChunk(kind="metadata", data={"actual_model": "qwen-3.8-27b"})
        raise RoseAllFailed(
            "offline terminal routes",
            step_errors=[RoseStepError(model="qwen-3.8-27b", error=RoseServerError("offline overload", status=503))],
        )

    monkeypatch.setattr(rose, "waterfall_complete", waterfall)

    async def sleep(delay):
        sleeps.append(delay)
        clock["now"] += delay

    monkeypatch.setattr(policy, "_sleep", sleep)

    async def capture(value):
        captured.append(value)

    async def run():
        token = wmh.REJECTION_RECORDER.set(capture)
        try:
            with pytest.raises(RoseError):
                await wmh._WMHCacheSafeRoseClient(openrouter_key="offline").collect(
                    pool="rose-1-flash",
                    messages=[
                        {"role": "system", "content": "offline"},
                        {
                            "role": "user",
                            "content": json.dumps(
                                {"environment_state": {}, "candidate_response": {"tool_calls": [{"call_id": "call-1"}]}}
                            ),
                        },
                    ],
                    call_site="wmh_world_model_timed_distribution_v1",
                    prefer_azure=True,
                    result_required=True,
                    retry_partial_errors=True,
                )
        finally:
            wmh.REJECTION_RECORDER.reset(token)

    asyncio.run(run())
    assert len(requests) == 3 and sleeps == [4, 4]
    transport = [row for row in captured if row["kind"] == "provider_http_failures"]
    transient = [row for row in captured if row["kind"] == "transient_completion_failure"]
    assert len(transport) == len(transient) == 3 and len(captured) == 6
    assert "private-lease-marker" not in repr(captured)
    assert [row["attempt_ordinal"] for row in transport] == [1, 2, 3]
    assert [row["attempt_ordinal"] for row in transient] == [1, 2, 3]
    assert all(row["request"]["deadline_s"] <= 360 for row in captured)


def test_whm_retry_policy_is_bound_to_runtime_identity_without_changing_original_policy():
    from benchmarks.wmh_execution_policy import WMH_COMPLETION_RETRY_POLICY

    config = {
        "inference_pool": "rose-1-flash",
        "inference_pool_sha256": "b" * 64,
        "azure_first": True,
        "exclude_failed_tool_examples": True,
        "validation_recovery": True,
    }
    original = deepcopy(config)
    identity = execution_identity("rose-outcome-distribution-v3", "fixture-model", "a" * 64, runtime_config=config)
    assert config == original
    assert identity["runtime_config"]["completion_retry_policy"] == WMH_COMPLETION_RETRY_POLICY
    mutated = deepcopy(config)
    mutated["completion_retry_policy"] = {**WMH_COMPLETION_RETRY_POLICY, "attempt_seconds": 1}
    with pytest.raises(ValueError):
        execution_identity("rose-outcome-distribution-v3", "fixture-model", "a" * 64, runtime_config=mutated)


@pytest.mark.parametrize(
    "value",
    [
        {"is_error": True},
        {"success": False},
        {"error": "HTTP503"},
        {"status": "FAILED"},
        {"metadata": {"toolStatus": "error"}},
        {"metadata": {"result_unavailable": True}},
        {"kind": "tool_result", "content": '{"is_error":true,"content":"timeout"}'},
        {"tool_results": [{"is_error": False}, {"is_error": True}]},
    ],
)
def test_explicit_failed_results_are_excluded(value):
    original = deepcopy(value)
    assert failed_tool_result(value)
    assert value == original


@pytest.mark.parametrize(
    "value",
    [
        {"is_error": False, "content": "Investor declined; no route found"},
        {"status": "sent", "error": None},
        "error in fundraising assumptions",
        {"content": "Investor refused a meeting"},
        {"success": True},
    ],
)
def test_negative_business_outcomes_are_retained(value):
    assert not failed_tool_result(value)


def test_runtime_identity_changes_without_rewriting_base_policy():
    base = execution_identity("rose-outcome-distribution-v3", "artifact-a", "a" * 64)
    config = {
        "inference_pool": "rose-1-flash",
        "inference_pool_sha256": "b" * 64,
        "azure_first": True,
        "exclude_failed_tool_examples": True,
    }
    active = execution_identity("rose-outcome-distribution-v3", "artifact-a", "a" * 64, runtime_config=config)
    assert {k: v for k, v in active.items() if k not in {"runtime_config", "execution_sha256"}} == {
        k: v for k, v in base.items() if k != "execution_sha256"
    }
    assert active["execution_sha256"] != base["execution_sha256"]
    assert validate_execution_identity(active, "rose-outcome-distribution-v3") == active
    changed = deepcopy(active)
    changed["runtime_config"]["azure_first"] = False
    with pytest.raises(ValueError):
        validate_execution_identity(changed, "rose-outcome-distribution-v3")
    assert execution_identity("rose-outcome-distribution-v3", "artifact-a", "a" * 64) == base


def test_opt_in_route_cache_keys_are_distinct_and_default_material_is_unchanged():
    from providers.demo_cache.rose_cache import request_key_material

    request = {"pool": "rose-1-flash", "messages": [{"role": "user", "content": "offline"}]}
    base = request_key_material(request)
    assert "prefer_azure" not in base and "retry_partial_errors" not in base
    assert request_key_material({**request, "prefer_azure": False, "retry_partial_errors": False}) == base
    azure = request_key_material({**request, "prefer_azure": True, "retry_partial_errors": True})
    assert azure != base and azure["prefer_azure"] is True and azure["retry_partial_errors"] is True


@pytest.mark.parametrize("channel,seconds", [("email", 60), ("agent_sms", 45), ("imessage", 150)])
@pytest.mark.parametrize("mode", ["real", "simulate", "shadow"])
def test_actual_message_scheduling_keeps_real_deadlines_and_removes_wmh_attempt_deadlines(
    monkeypatch, channel, seconds, mode
):
    from domains.message_person.handler import MessagePersonManager

    captured = []

    async def activity(fn, *, args, **kwargs):
        captured.append((args, kwargs))
        return {"success": True, "status": "sent", "message_id": "offline", "queue_id": "offline"}

    monkeypatch.setattr("domains.message_person.handler.workflow.execute_activity", activity)
    asyncio.run(
        MessagePersonManager._deliver_message(
            channel=channel,
            user_id="user",
            agent_id="actor",
            tool_call_id="call",
            context=[],
            person_phone="+15555550100",
            generated_message="offline",
            person_display="recipient",
            world_model_mode=mode,
            world_model_session_scope_id="scope",
            person_email="a@example.invalid",
            from_email="b@example.invalid",
            generated_subject="offline",
        )
    )
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
        "start_to_close_timeout": timedelta(seconds=30)
    }


@pytest.mark.parametrize(
    "prefer_azure,fail_azure,recover,expected",
    [
        (False, False, False, ["cerebras"]),
        (True, False, False, ["foundry"]),
        (True, True, True, ["foundry", "cerebras"]),
    ],
)
def test_flash_routes_and_discards_abandoned_partial_reply(monkeypatch, prefer_azure, fail_azure, recover, expected):
    import providers.rose.client as module
    from providers.demo_cache import client as cache

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
    response = asyncio.run(
        RoseClient(openrouter_key="offline").collect(
            pool="rose-1-flash",
            messages=[{"role": "user", "content": "offline"}],
            dump_context=False,
            prefer_azure=prefer_azure,
            result_required=True,
            retry_partial_errors=recover,
        )
    )
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

    monkeypatch.setattr(
        "benchmarks.wmh_execution_policy.validate_execution_identity", lambda identity, *_args, **_kw: identity
    )
    policy = "rose-outcome-distribution-v3"
    config = {
        "inference_pool": "rose-1-flash",
        "inference_pool_sha256": "b" * 64,
        "azure_first": True,
        "exclude_failed_tool_examples": True,
    }
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
            response = await client.post(
                "/complete",
                headers={"X-Rose-Provider-Token": "offline-token"},
                json={
                    "session_id": "session",
                    "prediction_id": "prediction",
                    "maximum_output_tokens": 16384,
                    "execution_identity": identity,
                    "messages": [
                        {"role": "system", "content": "offline validated system fixture"},
                        {"role": "user", "content": "{}"},
                    ],
                },
            )
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

    from providers.demo_cache import client as cache
    from providers.rose import foundry

    body = []

    def handler(request):
        assert request.url.host == "offline.azure.com", "No funded provider may be contacted"
        body.append(json.loads(request.content))
        text = 'data: {"type":"response.output_text.delta","delta":"{\\"result\\":true}"}\n\n'
        text += 'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'
        text += "data: [DONE]\n\n"
        return httpx.Response(200, text=text, headers={"Content-Type": "text/event-stream"})

    monkeypatch.setattr(cache, "ensure_context", AsyncMock(return_value=None))
    monkeypatch.setattr(foundry, "_shared_scope", lambda: None)
    monkeypatch.setenv("AZURE_FOUNDRY_ENDPOINT", "https://offline.azure.com")
    monkeypatch.setenv("AZURE_FOUNDRY_API_KEY", "offline-key")
    monkeypatch.setenv("CEREBRAS_API_KEY", "")
    monkeypatch.setenv("GPT_API_KEY", "")
    set_mock_handler(handler)
    try:
        response = asyncio.run(
            RoseClient(openrouter_key="offline").collect(
                pool="rose-1-flash",
                messages=[{"role": "user", "content": "Return JSON"}],
                prefer_azure=True,
                json_mode=json_mode,
                dump_context=False,
            )
        )
    finally:
        teardown_mock()
    assert response.content == '{"result":true}' and len(body) == 1
    if json_mode:
        assert body[0]["text"]["format"] == {"type": "json_object"}
    else:
        assert "text" not in body[0]


@pytest.mark.parametrize("accepted", [False, True])
def test_store_event_matches_actual_cache_write_result(monkeypatch, accepted):
    import providers.rose.client as module
    from providers.demo_cache import client as cache
    from providers.demo_cache.context import DemoCacheContext, reset_context, set_context

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
        token = set_context(DemoCacheContext(enabled=False, goal="offline", write_enabled=True))
        try:
            await client.collect(pool="rose-1-flash", messages=[])
        finally:
            reset_context(token)

    asyncio.run(run())
    assert ("llm.cache.stored" in events) is accepted
    assert ("llm.cache.store_skipped" in events) is not accepted


def test_json_mode_is_bound_in_execution_and_cache_identity():
    from providers.demo_cache.rose_cache import request_key_material

    config = {
        "inference_pool": "rose-1-flash",
        "inference_pool_sha256": "b" * 64,
        "azure_first": True,
        "exclude_failed_tool_examples": True,
    }
    base = execution_identity("rose-outcome-distribution-v3", "artifact-a", "a" * 64, runtime_config=config)
    formatted = execution_identity(
        "rose-outcome-distribution-v3", "artifact-a", "a" * 64, runtime_config={**config, "json_mode": True}
    )
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
            result = await client.post(
                "/complete",
                headers={"X-Rose-Provider-Token": "offline"},
                json={
                    "session_id": "session",
                    "prediction_id": "prediction",
                    "maximum_output_tokens": 16384,
                    "messages": [{"role": "system", "content": "fixture"}, {"role": "user", "content": "{}"}],
                },
            )
        assert result.status_code == 422
        detail = result.json()["detail"]
        assert detail["kind"] == "invalid_prediction"
        assert detail["rejected_response"]["content"] == rejected

    asyncio.run(run())


@pytest.mark.parametrize(
    "failure",
    [
        "comma",
        "colon",
        "extra_data",
        "duplicate_key",
        "probability",
        "call_identity",
        "outcome_keys",
    ],
)
def test_rejected_distribution_capture_keeps_exact_bytes_private_and_validation_strict(monkeypatch, failure):
    """Synthetic boundary controls, not a replay of Run13's missing reply bytes."""
    import json
    from types import SimpleNamespace

    import httpx

    from benchmarks import wmh_rose_provider as module
    from benchmarks.experiential_bridge import build_provider_bridge
    from benchmarks.wmh_outcomes import TIMED_DISTRIBUTION_PROTOCOL

    marker = "private-rejected-reply-marker"
    distribution = {
        "schema": "rose.wmh_timed_outcome_distribution.v1",
        "outcomes": [
            {
                "id": "observed",
                "probability": 1,
                "elapsed_ms": 1000,
                "description": "offline result",
                "state_patch": [],
                "tool_results": [{"call_id": "call-1", "content": marker, "is_error": False}],
            }
        ],
    }
    if failure == "probability":
        distribution["outcomes"][0]["probability"] = 0.7
    elif failure == "call_identity":
        distribution["outcomes"][0]["tool_results"][0]["call_id"] = "foreign-call"
    elif failure == "outcome_keys":
        distribution["outcomes"][0]["unexpected"] = True
    rejected = json.dumps(distribution)
    if failure == "comma":
        rejected = rejected.replace('", "content"', '" "content"')
    elif failure == "colon":
        rejected = rejected.replace('"content":', '"content"')
    elif failure == "extra_data":
        rejected += " {}"
    elif failure == "duplicate_key":
        rejected = rejected.replace('"probability": 1', '"probability": 1, "probability": 1')

    request = {
        "environment_state": {},
        "candidate_response": {"tool_calls": [{"call_id": "call-1"}]},
    }
    messages = [
        {"role": "system", "content": "offline distribution fixture"},
        {"role": "user", "content": json.dumps(request)},
    ]
    safe_usage = {"prompt_tokens": 10, "completion_tokens": 5, "finish_reason": "stop"}
    leased_usage = {**safe_usage, "compute_token_used": {"accessToken": "private-lease-marker"}}
    logs = []
    monkeypatch.setattr(module.logger, "warning", lambda event, **kw: logs.append((event, kw)))

    async def stream(self, **kwargs):
        yield StreamChunk(kind="metadata", data={"actual_model": "offline-model"})
        yield StreamChunk(kind="content", data={"text": rejected})
        yield StreamChunk(kind="usage", data=leased_usage)
        yield StreamChunk(kind="done", data={})

    monkeypatch.setattr(RoseClient, "_complete_impl", stream)
    client = object.__new__(module._WMHCacheSafeRoseClient)
    seen = []

    async def consume():
        with pytest.raises(module._WMHInvalidPrediction) as caught:
            async for chunk in client._complete_impl(
                call_site="wmh_world_model_timed_distribution_v1",
                messages=messages,
            ):
                seen.append(chunk)
        assert caught.value.rejected_response["content"] == rejected
        assert caught.value.rejected_response["usage"] == safe_usage
        assert caught.value.rejected_response["request"] == {
            "call_site": "wmh_world_model_timed_distribution_v1",
            "messages": messages,
        }

    asyncio.run(consume())
    assert not any(chunk.kind == "done" for chunk in seen), "Rejected output reached DEMO cache completion"

    cached_client = SimpleNamespace(
        collect=AsyncMock(
            return_value=RoseResponse(
                content=rejected,
                usage=leased_usage,
                actual_model="offline-model",
            )
        )
    )
    usage = module.RoseUsageAccumulator()
    provider = module.RoseWMHProvider(
        client=cached_client,
        usage=usage,
        protocol=TIMED_DISTRIBUTION_PROTOCOL,
        user_id="offline-user",
    )
    monkeypatch.setattr(provider, "_lease_auth", AsyncMock(return_value=(None, None)))

    async def call_bridge():
        app = build_provider_bridge(provider, "offline-token")
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://offline") as bridge:
            response = await bridge.post(
                "/complete",
                headers={"X-Rose-Provider-Token": "offline-token"},
                json={
                    "session_id": "offline-session",
                    "prediction_id": "offline-prediction",
                    "maximum_output_tokens": 16384,
                    "messages": messages,
                },
            )
        assert response.status_code == 422
        detail = response.json()["detail"]
        assert detail["kind"] == "invalid_prediction"
        sent_model = cached_client.collect.await_args.kwargs["response_model"]
        assert sent_model.__name__ == "CandidateTimedOutcomeDistribution"
        from providers.rose.schema import build_openai_response_format
        result_schema = build_openai_response_format(sent_model)["json_schema"]["schema"]["properties"]["outcomes"]["items"]["properties"]["tool_results"]
        assert result_schema["items"]["properties"]["call_id"] == {"title": "Call Id", "type": "string"}
        assert "maxItems" not in result_schema
        from benchmarks.wmh_response_schema import response_model_for_protocol
        other_model = response_model_for_protocol(TIMED_DISTRIBUTION_PROTOCOL, expected_call_ids=("other-A", "other-B"))
        assert build_openai_response_format(other_model)["json_schema"]["schema"]["properties"]["outcomes"]["items"]["properties"]["tool_results"] == result_schema
        assert detail["rejected_response"] == {
            "content": rejected,
            "actual_model": "offline-model",
            "usage": safe_usage,
            "request": {
                "pool": "rose-1-ultra",
                "messages": cached_client.collect.await_args.kwargs["messages"],
                "max_tokens": 16384,
                "call_site": "wmh_world_model_timed_distribution_v1",
                "dump_context": False,
                "cache_namespace": "wmh:session:offline-session",
                "result_required": True,
                "prefer_azure": False,
                "retry_partial_errors": True,
                "response_model": {
                    "name": "CandidateTimedOutcomeDistribution",
                    "schema": sent_model.model_json_schema(),
                    "rose_openai_strict": False,
                },
            },
        }
        assert marker not in detail["reason"]
        assert "private-lease-marker" not in response.text

    asyncio.run(call_bridge())
    assert usage.snapshot().calls == 1
    assert marker not in repr(logs) and "private-lease-marker" not in repr(logs)


def test_rejected_prediction_captures_actual_streamed_wire_request_without_auth(monkeypatch):
    """Capture the actual collect input, including stream units and format flags."""
    import json
    from types import SimpleNamespace

    import httpx

    from benchmarks import wmh_rose_provider as module
    from benchmarks.experiential_bridge import build_provider_bridge
    from benchmarks.wmh_outcomes import TIMED_DISTRIBUTION_PROTOCOL
    from benchmarks.wmh_wire_stream import STREAM_GUIDE
    from benchmarks.wmh_wire_stream_test import evidence

    monkeypatch.setenv("WMH_WIRE_STREAM", "1")
    rejected = '{"private-wire-reply-marker":'
    client = SimpleNamespace(
        collect=AsyncMock(
            return_value=RoseResponse(
                content=rejected,
                usage={"prompt_tokens": 10, "completion_tokens": 1},
                actual_model="offline-model",
            )
        )
    )
    provider = module.RoseWMHProvider(
        client=client,
        protocol=TIMED_DISTRIBUTION_PROTOCOL,
        pool="rose-1-flash",
        prefer_azure=True,
        json_mode=True,
        user_id="offline-user",
        usage=module.RoseUsageAccumulator(),
    )
    secret = "private-wire-auth-marker"
    monkeypatch.setattr(provider, "_lease_auth", AsyncMock(return_value=(None, {"accessToken": secret})))
    logs = []
    monkeypatch.setattr(module.logger, "warning", lambda event, **kw: logs.append((event, kw)))
    monkeypatch.setattr(module.logger, "info", lambda event, **kw: logs.append((event, kw)))

    async def run():
        app = build_provider_bridge(provider, "offline-token")
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://offline") as bridge:
            response = await bridge.post(
                "/complete",
                headers={"X-Rose-Provider-Token": "offline-token"},
                json={
                    "session_id": "wire-session",
                    "prediction_id": "wire-prediction",
                    "maximum_output_tokens": 16384,
                    "messages": [
                        {"role": "system", "content": "offline policy"},
                        {"role": "user", "content": json.dumps(evidence([], call="wire-call"))},
                    ],
                },
            )
        assert response.status_code == 422
        capture = response.json()["detail"]["rejected_response"]
        sent = client.collect.await_args.kwargs
        from providers.rose.schema import build_openai_response_format
        result_schema = build_openai_response_format(sent["response_model"])["json_schema"]["schema"]["properties"]["outcomes"]["items"]["properties"]["tool_results"]
        assert result_schema["items"]["properties"]["call_id"] == {"title": "Call Id", "type": "string"}
        assert "maxItems" not in result_schema
        from benchmarks.wmh_response_schema import response_model_for_protocol
        other_model = response_model_for_protocol(TIMED_DISTRIBUTION_PROTOCOL, expected_call_ids=("other-A", "other-B"))
        assert build_openai_response_format(other_model)["json_schema"]["schema"]["properties"]["outcomes"]["items"]["properties"]["tool_results"] == result_schema
        assert capture["request"] == {
            "pool": "rose-1-flash",
            "messages": sent["messages"],
            "max_tokens": 16384,
            "call_site": "wmh_world_model_timed_distribution_v1",
            "dump_context": False,
            "cache_namespace": "wmh:session:wire-session",
            "result_required": True,
            "prefer_azure": True,
            "retry_partial_errors": True,
            "json_mode": True,
            "response_model": {
                "name": "CandidateTimedOutcomeDistribution",
                "schema": sent["response_model"].model_json_schema(),
                "rose_openai_strict": False,
            },
        }
        assert STREAM_GUIDE in sent["messages"][0]["content"]
        assert any(isinstance(message["content"], list) for message in sent["messages"])
        assert sent["gpt_auth"]["accessToken"] == secret
        assert secret not in response.text
        assert capture["content"] == rejected

    asyncio.run(run())
    assert "private-wire-reply-marker" not in repr(logs) and secret not in repr(logs)


def test_wmh_success_keeps_precontent_http_failure_evidence():
    import asyncio
    import hashlib

    import httpx

    from benchmarks.wmh_completion_retry import CompletionRetryBudget, scheduled_attempt
    from providers.rose.types import StreamChunk
    from providers.rose.whm_retry_observation import FAILURE_OBSERVER, observe_http_failure

    body = b'{"error":{"code":"synthetic_bad_request","message":"offline"}}'
    captured = []

    async def attempt(**kwargs):
        for model in ("gpt-5.6-luna", "qwen-3.8-27b"):
            response = httpx.Response(
                400,
                content=body,
                headers={"x-request-id": model + "-offline", "Authorization": "private-test-key"},
            )
            await observe_http_failure(model, response)
        yield StreamChunk(kind="content", data={"text": "offline-valid-control"})
        yield StreamChunk(kind="usage", data={"prompt_tokens": 1, "completion_tokens": 1})
        yield StreamChunk(kind="done", data={})

    async def capture(row):
        captured.append(row)

    async def run():
        budget = CompletionRetryBudget()
        chunks = [chunk async for chunk in scheduled_attempt(attempt, {}, budget, capture)]
        assert len(captured) == 1, "Successful fallback discarded pre-content HTTP response evidence"
        assert captured[0]["kind"] == "provider_http_failures"
        assert captured[0]["attempt_ordinal"] == 1
        failures = captured[0]["route_failures"]
        assert len(failures) == 2
        assert all(row["response_body"].encode() == body for row in failures)
        assert all(row["response_body_sha256"] == hashlib.sha256(body).hexdigest() for row in failures)
        assert "private-test-key" not in repr(captured)
        assert [chunk.kind for chunk in chunks] == ["content", "usage", "done"]
        assert budget.attempts == 1 and budget.last_error is None
        assert FAILURE_OBSERVER.get() is None

    asyncio.run(run())
