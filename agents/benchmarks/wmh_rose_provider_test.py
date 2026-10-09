"""Unit tests for RoseWMHProvider — the WMH inference provider backed by Rose.

Guarantees under test:
  1. WMH `Message`s convert to Rose's OpenAI-style dicts, with `system` as a leading
     system-role message (not a kwarg).
  2. Rose usage (`prompt_tokens`/`completion_tokens`) maps to WMH `TokenUsage`
     (`input_tokens`/`output_tokens`), and `content` maps to `Completion.text`.
  3. NO Anthropic client is ever constructed — the call funnels through the injected
     RoseClient only.
  4. Rotation is DELEGATED, not re-implemented: the provider leases a rotation-capable
     `ComputeAuthContext` (via the reused helpers) and hands it straight to the client;
     when the client hits a simulated auth error it drives `fetch_fresh` on that context,
     and the provider does nothing rotation-related itself.

These tests follow the repo convention (no pytest-asyncio): each async body is wrapped
in an inner `run()` coroutine driven by `asyncio.run(...)`.
"""

from __future__ import annotations

import asyncio
import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List

import pytest
from wmh.providers.base import Message

from benchmarks import wmh_rose_provider
from benchmarks.wmh_rose_provider import (
    _WMH_MAX_TOKENS,
    RoseUsageAccumulator,
    RoseWMHProvider,
    _cost_usd_for_call,
    _to_rose_messages,
)
from providers.rose import ClaudeAuthContext, RoseResponse


@pytest.mark.parametrize("engine", ["legacy", "experiential"])
@pytest.mark.parametrize("explicit_pool", [None, "rose-1-flash"])
def test_serving_cli_uses_declared_pool_and_preserves_explicit_override(monkeypatch, engine, explicit_pool):
    from benchmarks import experiential_bridge, serve_world_model

    monkeypatch.setenv("WMH_ENGINE", engine)
    monkeypatch.setenv("WMH_ROSE_POOL", "rose-1-mini")
    calls = []
    if engine == "experiential":
        monkeypatch.setattr(experiential_bridge, "serve_native", lambda *args: calls.append(args) or 0)
    else:
        monkeypatch.setattr(serve_world_model, "build_app", lambda *args: calls.append(args) or object())
        monkeypatch.setattr("uvicorn.run", lambda *args, **kwargs: None)
    arguments = ["--name", "rose-test", "--root", "/guest/world-model", "--port", "3999"]
    if explicit_pool:
        arguments += ["--pool", explicit_pool]
    assert serve_world_model.main(arguments) == 0
    expected = ("rose-test", "/guest/world-model", explicit_pool or "rose-1-mini")
    assert calls == [(*expected, 3999)] if engine == "experiential" else calls == [expected]


def test_serving_cli_retains_legacy_and_ultra_defaults(monkeypatch):
    from benchmarks import serve_world_model

    monkeypatch.delenv("WMH_ENGINE", raising=False)
    monkeypatch.delenv("WMH_ROSE_POOL", raising=False)
    calls = []
    monkeypatch.setattr(serve_world_model, "build_app", lambda *args: calls.append(args) or object())
    monkeypatch.setattr("uvicorn.run", lambda *args, **kwargs: None)
    assert serve_world_model.main(["--name", "rose-test", "--root", "/guest/world-model", "--port", "3999"]) == 0
    assert calls == [("rose-test", "/guest/world-model", "rose-1-ultra")]


@pytest.mark.parametrize("legacy_wrapper", [False, True])
def test_native_canonical_receipt_scores_identically_to_unwrapped_observation(legacy_wrapper):
    from benchmarks.world_model_harness import CanonicalObservation, score_observation_prediction
    from utils.world_model_observation import world_model_observation_to_tool_result

    actual = CanonicalObservation(
        category="browser",
        content="observed",
        is_error=True,
        metadata={"state_note": "submitted form"},
        artifact_refs=["artifact://recording/123"],
    )
    content = actual.to_output_text()
    if legacy_wrapper:
        content = json.dumps({"output": content, "is_error": True, "state_note": "submitted form"})
    predicted = {"content": content, "is_error": False, "metadata": {"protocol": "text-world-model-v3"}}
    expected = {
        "content": actual.content,
        "is_error": True,
        "metadata": {**actual.metadata, "artifact_refs": actual.artifact_refs},
    }
    assert world_model_observation_to_tool_result(predicted, simulated=True)["message"] == actual.content
    assert score_observation_prediction(actual, predicted) == score_observation_prediction(actual, expected)
    assert score_observation_prediction(actual, predicted)[0] == 1.0


def test_native_cache_identity_preserves_correlated_call_ids():
    from benchmarks.wmh_rose_provider import _WMHFastCacheContext

    cache = _WMHFastCacheContext(enabled=True, goal="DEMO FIXTURE ONLY native cache", write_enabled=True)

    def key(call_id, timestamp, state_clock=30, history_clock=40, system="Native protocol"):
        payload = {
            "environment_state": {"timestamp_ms": state_clock},
            "visible_history": [{"timestamp_ms": history_clock}],
            "candidate_response": {
                "tool_calls": [
                    {
                        "call_id": call_id,
                        "name": "rose.browser.spawn_browser_agent",
                        "arguments": {
                            "schema": "rose.canonical_action.v1",
                            "category": "browser",
                            "name": "spawn_browser_agent",
                            "arguments": {"goal": "submit form"},
                            "tool_call_id": call_id,
                            "timestamp_ms": timestamp,
                        },
                    }
                ]
            },
        }
        return cache.llm_key(
            "wmh_world_model_v3",
            {
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": json.dumps(payload)},
                ]
            },
        )

    first = "4de585b2-3488-4976-825c-154502883d1b"
    second = "59c835ac-fb82-4b30-944e-bd3f59ab8e61"
    assert key(first, 10) == key(first, 20)
    assert key(first, 10) != key(second, 10), "Native cached results are correlated to exact call IDs"
    assert key(first, 10) != key(first, 10, state_clock=31)
    assert key(first, 10) != key(first, 10, history_clock=41)
    from benchmarks.wmh_execution_policy import PUBLIC_AFFORDANCES_TEXT, PUBLIC_AFFORDANCES_V2_TEXT

    assert key(first, 10) != key(first, 10, system="Native protocol" + "\n\n" + PUBLIC_AFFORDANCES_TEXT)
    assert key(first, 10, system="Native protocol" + "\n\n" + PUBLIC_AFFORDANCES_TEXT) == key(
        first, 20, system="Native protocol" + "\n\n" + PUBLIC_AFFORDANCES_TEXT
    )
    assert key(first, 10, system="Native protocol" + "\n\n" + PUBLIC_AFFORDANCES_TEXT) != key(
        first, 10, system="Native protocol" + "\n\n" + PUBLIC_AFFORDANCES_V2_TEXT
    )
    assert key(first, 10, system="Native protocol" + "\n\n" + PUBLIC_AFFORDANCES_V2_TEXT) == key(
        first, 20, system="Native protocol" + "\n\n" + PUBLIC_AFFORDANCES_V2_TEXT
    )


@pytest.mark.parametrize("matching", [False, True])
def test_native_conformance_requires_exact_served_artifact_identity(tmp_path, matching):
    from benchmarks.world_model_harness import evaluate_world_model_conformance_suite

    class Client:
        predictions = 0

        async def model_identity(self, name):
            from benchmarks.wmh_execution_policy import execution_identity

            artifact_id = "artifact-a" if matching else "artifact-b"
            return {
                "world_model_id": artifact_id,
                "world_model_manifest_sha256": "a" * 64,
                "execution_identity": execution_identity("upstream", artifact_id, "a" * 64),
            }

        async def start_session(self, *args, **kwargs):
            self.predictions += 1
            return "session"

        async def step(self, *args, **kwargs):
            return {"content": "exact observation", "is_error": False, "metadata": {}}

    suite = {
        "schema": "rose.wmh_conformance_suite.v1",
        "status": "passed",
        "requested_examples": 1,
        "native_world_model_id": "artifact-a",
        "native_world_model_manifest_sha256": "a" * 64,
        "examples": [
            {
                "task": "root task",
                "action": {
                    "category": "browser",
                    "name": "spawn_browser_agent",
                    "arguments": {},
                    "tool_call_id": "call",
                },
                "observation": {"category": "browser", "content": "exact observation"},
            }
        ],
    }
    path = tmp_path / "suite.json"
    path.write_text(json.dumps(suite))
    client = Client()
    if matching:
        report = asyncio.run(evaluate_world_model_conformance_suite(path, world_model_name="rose-test", client=client))
        assert report["status"] == "passed" and report["native_world_model_id"] == "artifact-a"
    else:
        with pytest.raises(ValueError, match="identity"):
            asyncio.run(evaluate_world_model_conformance_suite(path, world_model_name="rose-test", client=client))
        assert client.predictions == 0


class _FakeRoseClient:
    """Records the kwargs it was called with and returns a canned RoseResponse.

    Crucially it never imports/constructs any Anthropic client — proving the provider's
    path is Rose-only. It also lets a test drive the leased auth context's rotation
    callbacks to prove rotation is delegated to (this stand-in for) RoseClient.
    """

    def __init__(self, response: RoseResponse) -> None:
        self._response = response
        self.calls: List[Dict[str, Any]] = []

    async def collect(self, **kwargs: Any) -> RoseResponse:
        self.calls.append(kwargs)
        return self._response


def _canned_response(*, content: str, prompt: int, completion: int, token_used: Any) -> RoseResponse:
    r = RoseResponse()
    r.content = content
    r.actual_model = "claude-haiku-4-5-claude"
    r.usage = {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "compute_token_used": token_used,
        "compute_token_rotated": False,
    }
    return r


def _leased_claude_auth(fetch_fresh) -> ClaudeAuthContext:
    """A rotation-capable ClaudeAuthContext like `_build_compute_auth_context` returns."""
    return ClaudeAuthContext(
        token="tok-original",
        source="pool",
        user_id="u-1",
        pool_token_id="pt-1",
        lineage_key="lin-1",
        fetch_fresh=fetch_fresh,
        max_rotations=2,
    )


@pytest.fixture(autouse=True)
def _no_anthropic(monkeypatch):
    """Fail loudly if any code path tries to import/construct the Anthropic SDK."""
    import builtins

    real_import = builtins.__import__

    def guarded_import(name, *args, **kwargs):
        if name == "anthropic" or name.startswith("anthropic."):
            raise AssertionError(f"RoseWMHProvider must not touch Anthropic (import {name!r})")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded_import)
    # Belt-and-suspenders: if `anthropic` is already importable, ensure a fresh construction fails.
    monkeypatch.setitem(sys.modules, "anthropic", None)
    yield


def test_message_conversion_puts_system_first():
    messages = [Message(role="user", content="do the thing")]
    rose = _to_rose_messages("SYS PROMPT", messages)
    assert rose == [
        {"role": "system", "content": "SYS PROMPT"},
        {"role": "user", "content": "do the thing"},
    ]


@pytest.mark.parametrize("change_world", [False, True])
def test_native_provider_cache_prefix_precedes_changing_candidate(change_world):
    from os.path import commonprefix

    from benchmarks.wmh_rose_provider import _prompt_text
    from providers.rose.waterfall import build_openrouter_body

    task = {"initial_context": {"company": "Rose Labs"}, "instruction": "Raise funds", "task_id": "root"}
    requests = [
        {
            "candidate_response": {"tool_calls": [{"call_id": call, "arguments": {"goal": goal}}]},
            "environment_state": {"balance": 0},
            "grounded_examples": [],
            "grounding_contexts": [],
            "grounding_schema_version": "test",
            "task": task,
            "visible_conversation": [],
        }
        for call, goal in (("first", "Find investors"), ("second", "Review account"))
    ]
    if change_world:
        requests[1]["task"] = {**task, "tools": [{"name": "browser"}]}
        requests[1]["environment_state"] = {"balance": 100, "timestamp_ms": 20}
        requests[1]["visible_conversation"] = [{"content": "new observation"}]
        requests[1]["grounded_examples"] = [{"content": "new example"}]
        requests[1]["future_evidence_field"] = {"nested": "preserve me"}
    outgoing = [
        _to_rose_messages("unchanged system", [Message(role="user", content=json.dumps(request))])
        for request in requests
    ]
    for original, messages in zip(requests, outgoing):
        assert messages[0]["content"] == "unchanged system"
        assert json.loads(_prompt_text(messages[1]["content"])) == original
        assert messages[1]["content"][0]["cache_control"] == {"type": "ephemeral"}
        assert "cache_control" not in messages[1]["content"][-1]
        wire = build_openrouter_body(
            model="openai/gpt-6.1-sol", messages=messages, tools=None,
            tool_choice=None, response_format=None, temperature=None,
            max_tokens=16384, seed=None, cache_namespace="wmh:session:root",
        )
        assert wire["messages"][1]["content"] == messages[1]["content"]
        assert wmh_rose_provider._native_call_ids(messages) == (
            original["candidate_response"]["tool_calls"][0]["call_id"],
        )
        assert wmh_rose_provider._native_environment_state(messages) == original["environment_state"]
        # Changing wire layout must not alter whole-response replay identity.
        assert wmh_rose_provider._wmh_cache_key_material({"messages": messages}) == (
            wmh_rose_provider._wmh_cache_key_material({"messages": [
                {"role": "system", "content": "unchanged system"},
                {"role": "user", "content": json.dumps(original)},
            ]})
        )
    assert outgoing[0][1]["content"][0] == outgoing[1][1]["content"][0]
    prefix = commonprefix([_prompt_text(messages[1]["content"]) for messages in outgoing])
    assert '"instruction":"Raise funds"' in prefix
    if not change_world:
        assert '"environment_state"' in prefix


@pytest.mark.parametrize("content", [[], [{"type": "image_url", "image_url": {"url": "test"}}]])
def test_native_prompt_blocks_never_discard_nontext_evidence(content):
    messages = [{"role": "user", "content": content}]
    with pytest.raises(TypeError):
        wmh_rose_provider._prompt_text(content)
    assert wmh_rose_provider._native_call_ids(messages) is None
    assert wmh_rose_provider._native_environment_state(messages) is None
    assert wmh_rose_provider._wmh_cache_key_material({"messages": messages}) == {"messages": messages}


def test_native_provider_uses_stable_isolated_rose_cache_namespaces(monkeypatch):
    captured = []

    class Client:
        async def collect(self, **kwargs):
            captured.append(kwargs)
            return RoseResponse(
                content=json.dumps({"message": "", "tool_results": [{"call_id": "test", "content": "complete", "is_error": False}],
                                    "state": {}, "terminal": False}),
                actual_model="openai/gpt-6.1-sol",
                usage={"prompt_tokens": 1, "completion_tokens": 1},
            )

    provider = RoseWMHProvider(client=Client(), usage=RoseUsageAccumulator(), protocol="text-world-model-v3")

    async def no_auth():
        return None, None

    monkeypatch.setattr(provider, "_lease_auth", no_auth)

    async def run():
        for scope, prediction in (("world-a", "prediction-1"), ("world-a", "prediction-2"), ("world-b", "prediction-3")):
            await provider.complete_scoped(scope, prediction, "System", [Message(role="user", content="Evidence")], max_tokens=16384)
        for scope in ("world-a", "world-b"):
            assert (await provider.retire_scope(scope))["join_verified"]

    asyncio.run(run())
    namespaces = [call.get("cache_namespace") for call in captured]
    assert namespaces[0] and namespaces[0] == namespaces[1]
    assert namespaces[0] != namespaces[2]
    from providers.rose.waterfall import build_openrouter_body

    for call, namespace in zip(captured, namespaces):
        wire = build_openrouter_body(model="openai/gpt-6.1-sol", messages=call["messages"], tools=None,
                                     tool_choice=None, response_format=None, temperature=None,
                                     max_tokens=call["max_tokens"], seed=None, cache_namespace=namespace)
        assert wire["session_id"] == namespace
        assert wire["reasoning"]["effort"] == "xhigh"
        assert wire["max_tokens"] == 16384


def test_native_demo_replay_identity_excludes_only_session_routing():
    from copy import deepcopy

    from benchmarks.wmh_execution_policy import execution_policy
    from providers.fast_cache.rose_cache import request_key_material

    cache = wmh_rose_provider._WMHFastCacheContext(
        enabled=True, goal="DEMO FIXTURE ONLY native provider cache", write_enabled=True,
    )
    request = outcome_request()
    request["task"].update(initial_context={"company": "Rose Labs"}, task_id="root")
    system = execution_policy("rose-outcome-distribution-v2").text

    def key(payload, namespace=None, *, packed=True, max_tokens=16384):
        message = Message(role="user", content=json.dumps(payload))
        messages = _to_rose_messages(system, [message]) if packed else [
            {"role": "system", "content": system}, {"role": "user", "content": message.content},
        ]
        return cache.llm_key("wmh_world_model_distribution_v1", request_key_material({
            "messages": messages, "pool": "rose-wmh-gpt61", "max_tokens": max_tokens,
            "cache_namespace": namespace,
        }))

    original = key(request, packed=False)
    for namespace in (None, "wmh:session:" + "a" * 32, "wmh:session:" + "b" * 32):
        assert key(request, namespace) == original
    changed = deepcopy(request)
    changed["candidate_response"]["tool_calls"][0]["call_id"] = "other-call"
    assert key(changed) != original
    changed = deepcopy(request)
    changed["environment_state"]["receipts"].append("new receipt")
    assert key(changed) != original
    assert key(request, max_tokens=1024) != original
    assert key(request, namespace="unrelated caller namespace") != original


def test_native_protocol_uses_same_rose_transport_and_retains_actual_model(monkeypatch):
    text = json.dumps(
        {
            "message": "",
            "tool_results": [{"call_id": "call-1", "content": "observed", "is_error": False}],
            "state": {"forms": {}},
            "terminal": False,
        }
    )
    fake = _FakeRoseClient(_canned_response(content=text, prompt=10, completion=5, token_used=None))
    provider = RoseWMHProvider(client=fake, protocol="text-world-model-v3", usage=RoseUsageAccumulator())

    async def no_auth():
        return None, None

    monkeypatch.setattr(provider, "_lease_auth", no_auth)
    request = {
        "task": {"instruction": "Find application"},
        "candidate_response": {
            "tool_calls": [
                {
                    "call_id": "call-1",
                    "name": "rose.browser.spawn_browser_agent",
                    "arguments": {"timestamp_ms": 1, "arguments": {"goal": "Inspect application"}},
                }
            ]
        },
    }
    completion = provider.complete("native system", [Message(role="user", content=json.dumps(request))])
    assert completion.text == text and completion.actual_model == "claude-haiku-4-5-claude"
    assert fake.calls[0]["call_site"] == "wmh_world_model_v3" and fake.calls[0]["max_tokens"] == 16384
    assert fake.calls[0]["messages"][1]["content"] == json.dumps(request)


def outcome_fixture():
    return {
        "schema": "rose.wmh_outcome_distribution.v1",
        "outcomes": [
            {
                "id": "observed_route",
                "probability": 0.7,
                "description": "Contact route observed",
                "tool_results": [{"call_id": "call-1", "content": "route found", "is_error": False}],
                "state_patch": [],
            },
            {
                "id": "submitted_form",
                "probability": 0.25,
                "description": "Inquiry submitted",
                "tool_results": [{"call_id": "call-1", "content": "submission confirmed", "is_error": False}],
                "state_patch": [{"op": "add", "path": "/receipts/-", "value": "new"}],
            },
            {
                "id": "provider_unavailable",
                "probability": 0.05,
                "description": "Browser connection failed",
                "tool_results": [{"call_id": "call-1", "content": "connection failed", "is_error": True}],
                "state_patch": [],
            },
        ],
    }


def outcome_request():
    return {
        "task": {"instruction": "Inspect public contact"},
        "environment_state": {"receipts": ["prior"], "private_company": None},
        "candidate_response": {"tool_calls": [{"call_id": "call-1"}]},
    }


def test_distribution_categorical_sampling_matches_supplied_mass_and_zero_probability_boundaries():
    from collections import Counter

    from benchmarks.wmh_outcomes import parse_distribution, select_outcome

    request = outcome_request()
    distribution = parse_distribution(
        json.dumps(outcome_fixture()), base_state=request["environment_state"], expected_call_ids=("call-1",)
    )
    counts = Counter(select_outcome(distribution, (i + 0.5) / 100)[1]["selected_outcome_id"] for i in range(100))
    assert counts == {"observed_route": 70, "submitted_form": 25, "provider_unavailable": 5}
    assert select_outcome(distribution, 0.7)[1]["selected_outcome_id"] == "submitted_form"
    assert request["environment_state"] == {"receipts": ["prior"], "private_company": None}
    payload = outcome_fixture()
    for outcome, probability in zip(payload["outcomes"], (0, 1, 0)):
        outcome["probability"] = probability
    certain = parse_distribution(
        json.dumps(payload), base_state=request["environment_state"], expected_call_ids=("call-1",)
    )
    assert select_outcome(certain, 0)[1]["selected_outcome_id"] == "submitted_form"
    assert select_outcome(certain, 0.999999)[1]["selected_outcome_id"] == "submitted_form"


def test_distribution_state_patch_has_explicit_pointer_and_list_semantics():
    from copy import deepcopy

    from benchmarks.wmh_outcomes import apply_state_patch

    base = {"a/b": {"~name": ["old", {"fact": None}]}, "unrelated": {"private": "retained"}}
    before = deepcopy(base)
    patch = [
        {"op": "add", "path": "/a~1b/~0name/-", "value": "new"},
        {"op": "replace", "path": "/a~1b/~0name/1/fact", "value": "established"},
        {"op": "remove", "path": "/a~1b/~0name/0"},
    ]
    result = apply_state_patch(base, patch)
    assert result == {"a/b": {"~name": [{"fact": "established"}, "new"]}, "unrelated": {"private": "retained"}}
    assert base == before
    for invalid in (
        [{"op": "add", "path": "", "value": {}}],
        [{"op": "add", "path": "/missing/child", "value": True}],
        [{"op": "replace", "path": "/a~1b/~0name/-", "value": True}],
        [{"op": "remove", "path": "/a~1b/~0name/2"}],
        [{"op": "remove", "path": "/missing"}],
        [{"op": "remove", "path": "/bad~2escape"}],
    ):
        with pytest.raises(ValueError):
            apply_state_patch(base, invalid)
        assert base == before


@pytest.mark.parametrize(
    "failure", ["negative", "boolean", "nan", "large_integer", "sum", "duplicate", "call", "blank", "patch"]
)
def test_distribution_rejects_invalid_unchosen_branches(failure):
    from benchmarks.wmh_outcomes import parse_distribution

    payload = outcome_fixture()
    outcome = payload["outcomes"][-1]
    if failure == "negative":
        outcome["probability"] = -0.1
    elif failure == "boolean":
        outcome["probability"] = True
    elif failure == "nan":
        outcome["probability"] = float("nan")
    elif failure == "large_integer":
        outcome["probability"] = 10**999
    elif failure == "sum":
        outcome["probability"] = 0.01
    elif failure == "duplicate":
        outcome["id"] = payload["outcomes"][0]["id"]
    elif failure == "call":
        outcome["tool_results"][0]["call_id"] = "wrong-call"
    elif failure == "blank":
        outcome["tool_results"][0]["content"] = '{"output":"","is_error":false}'
    else:
        outcome["state_patch"] = [{"op": "remove", "path": "/nonexistent"}]
    with pytest.raises(ValueError):
        parse_distribution(
            json.dumps(payload), base_state=outcome_request()["environment_state"], expected_call_ids=("call-1",)
        )


@pytest.mark.parametrize("valid", [False, True])
@pytest.mark.parametrize("full_task", [False, True])
def test_distribution_is_validated_before_cache_write_and_on_cached_response(monkeypatch, valid, full_task):
    from benchmarks.wmh_outcomes import DISTRIBUTION_PROTOCOL
    from providers.rose import RoseClient
    from providers.rose.types import StreamChunk

    payload = outcome_fixture()
    if not valid:
        payload["outcomes"][-1]["state_patch"] = [{"op": "remove", "path": "/nonexistent"}]
    text = json.dumps(payload)
    request = outcome_request()
    if full_task:
        request["task"].update(initial_context={"company": "Rose Labs"}, task_id="root")
    message = Message(role="user", content=json.dumps(request))
    messages = _to_rose_messages("distribution system", [message])

    async def stream(self, **kwargs):
        yield StreamChunk(kind="content", data={"text": text})
        yield StreamChunk(kind="usage", data={"prompt_tokens": 10, "completion_tokens": 5})
        yield StreamChunk(kind="done")

    monkeypatch.setattr(RoseClient, "_complete_impl", stream)
    client = object.__new__(wmh_rose_provider._WMHCacheSafeRoseClient)

    async def read_stream():
        seen = []
        if valid:
            async for chunk in client._complete_impl(call_site="wmh_world_model_distribution_v1", messages=messages):
                seen.append(chunk)
        else:
            with pytest.raises(wmh_rose_provider._WMHInvalidPrediction, match="target"):
                async for chunk in client._complete_impl(
                    call_site="wmh_world_model_distribution_v1", messages=messages
                ):
                    seen.append(chunk)
        assert any(chunk.kind == "done" for chunk in seen) is valid

    asyncio.run(read_stream())
    fake = _FakeRoseClient(_canned_response(content=text, prompt=10, completion=5, token_used=None))
    usage = RoseUsageAccumulator()
    provider = RoseWMHProvider(client=fake, protocol=DISTRIBUTION_PROTOCOL, usage=usage)

    async def no_auth():
        return None, None

    monkeypatch.setattr(provider, "_lease_auth", no_auth)
    arguments = ("distribution system", [message])
    if valid:
        result = provider.complete(*arguments)
        assert result.text == text and result.actual_model == "claude-haiku-4-5-claude"
    else:
        with pytest.raises(wmh_rose_provider._WMHInvalidPrediction, match="target"):
            provider.complete(*arguments)
    assert fake.calls[0]["call_site"] == "wmh_world_model_distribution_v1"
    assert usage.snapshot().calls == 1


def test_distribution_cache_keys_bind_exact_action_state_and_policy():
    from copy import deepcopy

    from benchmarks.wmh_execution_policy import execution_policy

    cache = wmh_rose_provider._WMHFastCacheContext(
        enabled=True, goal="DEMO FIXTURE ONLY distribution", write_enabled=True
    )
    request = outcome_request()
    request["environment_state"]["timestamp_ms"] = 50
    request["candidate_response"]["tool_calls"][0]["arguments"] = {"timestamp_ms": 10}

    def key(payload, *, site="wmh_world_model_distribution_v1", system=None):
        return cache.llm_key(
            site,
            {
                "messages": [
                    {"role": "system", "content": system or execution_policy("rose-outcome-distribution-v1").text},
                    {"role": "user", "content": json.dumps(payload)},
                ]
            },
        )

    original = key(request)
    changed = deepcopy(request)
    changed["candidate_response"]["tool_calls"][0]["arguments"]["timestamp_ms"] = 99
    assert key(changed) == original
    changed["candidate_response"]["tool_calls"][0]["call_id"] = "other-call"
    assert key(changed) != original
    changed = deepcopy(request)
    changed["environment_state"]["timestamp_ms"] = 99
    assert key(changed) != original
    assert key(request, site="wmh_world_model_v3") != original
    assert key(request, system="old single-transition contract") != original
    assert key(request, system=execution_policy("rose-outcome-distribution-v2").text) != original


def test_reviewed_distribution_policy_has_exact_identity_and_pinned_runner():
    from dataclasses import replace

    from benchmarks import wmh_execution_policy as policies
    from providers.rose.pools import get_pool

    policy = policies.execution_policy("rose-outcome-distribution-v2")
    assert policies.text_sha256(policy.text) == "23feae1291f883f0a2280d6f7295e7391dbc7bd82dc1a9c1ca7caea52354fbb0"
    assert policy.response_protocol == "rose-outcome-distribution-v1"
    assert policy.effective_system_sha256 == "d76abcd5f096d65ea92e5f1e1aa538b5bae3643b4ea8618ba7e3a54eed24b470"
    assert policies.cache_policy_identity(
        [{"role": "system", "content": "incorrect base\n\n" + policy.text}]
    ) is None
    pool = get_pool("rose-wmh-gpt61")
    assert pool.waterfall == ("openai/gpt-6.1-sol",)
    assert pool.waterfall_reasoning_effort == "xhigh"
    assert not pool.direct_auth_enabled and not pool.foundry_enabled and pool.cerebras_model is None
    assert _cost_usd_for_call("openai/gpt-6.1-sol", 1000, 1000) == pytest.approx(0.012)
    assert get_pool("rose-1-ultra").waterfall[0] == "openai/gpt-6-sol"
    with pytest.MonkeyPatch.context() as patcher:
        patcher.setitem(policies._POLICIES, policy.name, replace(policy, text=policy.text + " changed"))
        with pytest.raises(ValueError, match="without a new version"):
            policies.execution_policy(policy.name)


def test_native_cache_fingerprint_changes_only_current_action_timestamp():
    original = {
        "messages": [
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "candidate_response": {"tool_calls": [{"call_id": "1", "arguments": {"timestamp_ms": 1}}]},
                        "environment_state": {"timestamp_ms": 10},
                        "grounded_examples": [{"timestamp_ms": 20}],
                    }
                ),
            }
        ]
    }
    other = json.loads(json.dumps(original))
    body = json.loads(other["messages"][0]["content"])
    body["candidate_response"]["tool_calls"][0]["arguments"]["timestamp_ms"] = 2
    other["messages"][0]["content"] = json.dumps(body)
    assert wmh_rose_provider._wmh_cache_key_material(original) == wmh_rose_provider._wmh_cache_key_material(other)
    body["environment_state"]["timestamp_ms"] = 11
    other["messages"][0]["content"] = json.dumps(body)
    assert wmh_rose_provider._wmh_cache_key_material(original) != wmh_rose_provider._wmh_cache_key_material(other)
    assert (
        json.loads(original["messages"][0]["content"])["candidate_response"]["tool_calls"][0]["arguments"][
            "timestamp_ms"
        ]
        == 1
    )


def test_native_provider_bridge_rejects_unauthorized_calls_and_exposes_safe_usage():
    from fastapi.testclient import TestClient

    from benchmarks.experiential_bridge import build_provider_bridge

    class Provider:
        _usage = RoseUsageAccumulator()

    http = TestClient(build_provider_bridge(Provider(), "private-test-token"))
    assert http.post("/complete", json={}).status_code == 401
    response = http.get("/rose_usage", headers={"X-Rose-Provider-Token": "private-test-token"})
    assert response.status_code == 200 and response.json()["calls"] == 0


def test_native_provider_retirement_joins_actual_cleanup_and_preserves_other_scope(monkeypatch):
    import httpx

    from benchmarks.experiential_bridge import build_provider_bridge

    entered = {name: threading.Event() for name in ("a", "b")}
    release = {name: threading.Event() for name in ("a", "b")}
    cleanup_entered = threading.Event()
    cleanup_release = threading.Event()
    cleanup_done = threading.Event()
    finished = {name: threading.Event() for name in ("a", "b")}
    collect_calls = {name: 0 for name in ("a", "b")}

    class Client:
        async def collect(self, **kwargs):
            call = json.loads(kwargs["messages"][1]["content"])["candidate_response"]["tool_calls"][0]["call_id"]
            collect_calls[call] += 1
            entered[call].set()
            try:
                try:
                    while not release[call].is_set():
                        await asyncio.sleep(0.001)
                except asyncio.CancelledError:
                    cleanup_entered.set()
                    while not cleanup_release.is_set():
                        await asyncio.sleep(0.001)
                    cleanup_done.set()
                    raise
                return RoseResponse(
                    content=json.dumps(
                        {
                            "message": "",
                            "tool_results": [{"call_id": call, "content": "completed", "is_error": False}],
                            "state": {},
                            "terminal": False,
                        }
                    ),
                    actual_model="openai/gpt-6-sol",
                    usage={"prompt_tokens": 1, "completion_tokens": 1},
                )
            finally:
                finished[call].set()

    provider = RoseWMHProvider(client=Client(), usage=RoseUsageAccumulator(), protocol="text-world-model-v3")

    async def no_auth():
        return None, None

    monkeypatch.setattr(provider, "_lease_auth", no_auth)

    async def wait(event):
        async with asyncio.timeout(3):
            while not event.is_set():
                await asyncio.sleep(0.001)

    def payload(call):
        return {
            "session_id": f"scope-{call}",
            "prediction_id": f"prediction-{call}",
            "messages": [
                {"role": "system", "content": "Simulate"},
                {
                    "role": "user",
                    "content": json.dumps(
                        {"task": {"instruction": "Inspect"}, "candidate_response": {"tool_calls": [{"call_id": call}]}}
                    ),
                },
            ],
            "maximum_output_tokens": 16384,
        }

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=build_provider_bridge(provider, "private-test-token")),
            base_url="http://bridge",
            headers={"X-Rose-Provider-Token": "private-test-token"},
        ) as http:
            calls = [asyncio.create_task(http.post("/complete", json=payload(name))) for name in ("a", "b")]
            retirement = None
            try:
                await wait(entered["a"])
                await wait(entered["b"])
                calls[1].cancel()
                await asyncio.gather(calls[1], return_exceptions=True)
                calls[1] = asyncio.create_task(http.post("/complete", json=payload("b")))
                changed = payload("b")
                changed["messages"][0]["content"] = "Different request"
                assert (await http.post("/complete", json=changed)).status_code == 409
                assert collect_calls == {"a": 1, "b": 1}
                retirement = asyncio.create_task(http.post("/sessions/scope-a/retire"))
                await asyncio.sleep(0.05)
                assert not retirement.done(), "Retirement acknowledged before actual provider cleanup joined"
                await wait(cleanup_entered)
                assert not cleanup_done.is_set() and not finished["b"].is_set()
                cleanup_release.set()
                receipt = (await asyncio.wait_for(retirement, 3)).json()
                assert receipt["join_verified"] is True and receipt["session_id"] == "scope-a"
                assert cleanup_done.is_set() and receipt["usage"]["calls"] == 0
                assert not finished["b"].is_set()
                assert (await http.post("/complete", json=payload("a"))).status_code == 409
                assert (await http.post("/sessions/scope-a/retire")).json() == receipt
                release["b"].set()
                assert (await asyncio.wait_for(calls[1], 3)).status_code == 200
                assert provider._usage.snapshot().calls == 1
                assert receipt["usage"]["calls"] == 0
            finally:
                cleanup_release.set()
                for event in release.values():
                    event.set()
                await asyncio.gather(*calls, *([retirement] if retirement else []), return_exceptions=True)
                await wait(finished["a"])
                await wait(finished["b"])

    asyncio.run(run())


def test_failed_provider_join_keeps_compact_fence_and_retry_joins_cleanup(monkeypatch):
    entered = threading.Event()
    cleanup_entered = threading.Event()
    cleanup_release = threading.Event()
    cleanup_done = threading.Event()
    cleanups = []

    class Client:
        async def collect(self, **kwargs):
            entered.set()
            try:
                await asyncio.Future()
            finally:
                cleanups.append(True)
                cleanup_entered.set()
                while not cleanup_release.is_set():
                    await asyncio.sleep(0.001)
                cleanup_done.set()

    provider = RoseWMHProvider(client=Client(), usage=RoseUsageAccumulator(), protocol="text-world-model-v3")

    async def no_auth():
        return None, None

    monkeypatch.setattr(provider, "_lease_auth", no_auth)
    monkeypatch.setattr(wmh_rose_provider, "_WMH_NATIVE_JOIN_TIMEOUT_SECONDS", 0.02)

    async def wait(event):
        async with asyncio.timeout(3):
            while not event.is_set():
                await asyncio.sleep(0.001)

    async def run():
        call = asyncio.create_task(
            provider.complete_scoped(
                "scope", "prediction", "System", [Message(role="user", content="Evidence")], max_tokens=16384
            )
        )
        try:
            await wait(entered)
            with pytest.raises(RuntimeError, match="did not join"):
                await provider.retire_scope("scope")
            await wait(cleanup_entered)
            assert not cleanup_done.is_set() and "scope" in provider._native_closed_scopes
            assert "scope" not in provider._native_retirements
            with pytest.raises(ValueError, match="retired"):
                await provider.complete_scoped(
                    "scope", "stale", "System", [Message(role="user", content="Evidence")], max_tokens=16384
                )
            with pytest.raises(RuntimeError, match="did not join"):
                await provider.retire_scope("scope")
            assert cleanups == [True] and not cleanup_done.is_set()
            cleanup_release.set()
            receipt = await provider.retire_scope("scope")
            assert receipt["join_verified"] is True and cleanup_done.is_set() and receipt["usage"]["calls"] == 0
            assert cleanups == [True]
        finally:
            cleanup_release.set()
            await asyncio.gather(call, return_exceptions=True)
            await provider.retire_scope("scope")

    asyncio.run(run())


def test_native_wrong_call_result_is_rejected_before_cache_done(monkeypatch):
    from providers.rose import RoseClient
    from providers.rose.types import StreamChunk

    text = json.dumps(
        {
            "message": "",
            "tool_results": [{"call_id": "wrong-call", "content": "observed", "is_error": False}],
            "state": {},
            "terminal": False,
        }
    )

    async def stream(self, **kwargs):
        yield StreamChunk(kind="content", data={"text": text})
        yield StreamChunk(kind="done")

    monkeypatch.setattr(RoseClient, "_complete_impl", stream)
    client = object.__new__(wmh_rose_provider._WMHCacheSafeRoseClient)

    async def run():
        seen = []
        with pytest.raises(wmh_rose_provider._WMHInvalidPrediction, match="call IDs"):
            async for chunk in client._complete_impl(
                call_site="wmh_world_model_v3",
                messages=[
                    {
                        "role": "user",
                        "content": json.dumps({"candidate_response": {"tool_calls": [{"call_id": "real-call"}]}}),
                    }
                ],
            ):
                seen.append(chunk)
        assert not any(chunk.kind == "done" for chunk in seen)

    asyncio.run(run())


@pytest.mark.parametrize(
    "encoded",
    [
        {
            "schema": "rose.canonical_observation.v1",
            "category": "browser",
            "content": "",
            "is_error": False,
            "metadata": {},
        },
        {"output": "", "is_error": False},
    ],
)
def test_native_decoded_blank_is_rejected_before_cache_done(monkeypatch, encoded):
    from providers.rose import RoseClient
    from providers.rose.types import StreamChunk

    text = json.dumps(
        {
            "message": "",
            "tool_results": [{"call_id": "real-call", "content": json.dumps(encoded), "is_error": False}],
            "state": {"bad_commit": True},
            "terminal": False,
        }
    )

    async def stream(self, **kwargs):
        yield StreamChunk(kind="content", data={"text": text})
        yield StreamChunk(kind="done")

    monkeypatch.setattr(RoseClient, "_complete_impl", stream)
    client = object.__new__(wmh_rose_provider._WMHCacheSafeRoseClient)

    async def run():
        seen = []
        with pytest.raises(wmh_rose_provider._WMHInvalidPrediction):
            async for chunk in client._complete_impl(
                call_site="wmh_world_model_v3",
                messages=[
                    {
                        "role": "user",
                        "content": json.dumps({"candidate_response": {"tool_calls": [{"call_id": "real-call"}]}}),
                    }
                ],
            ):
                seen.append(chunk)
        assert not any(chunk.kind == "done" for chunk in seen)

    asyncio.run(run())


def test_native_provider_bridge_returns_typed_protocol_feedback():
    from fastapi.testclient import TestClient

    from benchmarks.experiential_bridge import build_provider_bridge

    class Provider:
        _usage = RoseUsageAccumulator()

        async def complete_scoped(self, *args, **kwargs):
            raise wmh_rose_provider._WMHInvalidPrediction("bad native JSON", {}, "test")

    with TestClient(build_provider_bridge(Provider(), "test-token")) as http:
        response = http.post(
            "/complete",
            headers={"X-Rose-Provider-Token": "test-token"},
            json={
                "session_id": "scope-test",
                "prediction_id": "prediction-test",
                "messages": [{"role": "system", "content": "system"}, {"role": "user", "content": "evidence"}],
                "maximum_output_tokens": 16384,
            },
        )
        assert response.status_code == 422 and response.json()["detail"]["kind"] == "invalid_prediction"


def test_native_service_owner_joins_child_on_shutdown(tmp_path):
    import os
    import socket
    import subprocess
    import time
    from pathlib import Path

    import httpx
    import psutil

    from benchmarks.experiential_bridge import native_python, pool_sha256

    repo = Path(__file__).resolve().parents[2]
    python = native_python()
    digest = pool_sha256("rose-1-ultra")
    fixture_script = 'from pathlib import Path; from benchmarks.experiential_world_model_checks import _source_fixture; from benchmarks.build_experiential_world_model import build; import sys; p=Path(sys.argv[1]); build(_source_fixture(p), p/"native", "rose-test", "rose-1-ultra", sys.argv[2])'
    env = {**os.environ, "PYTHONPATH": str(repo / "agents")}
    subprocess.run(
        [python, "-c", fixture_script, str(tmp_path), digest],
        cwd=repo,
        env=env,
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
    )
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    log = tmp_path / "service.log"
    with log.open("w") as output:
        owner = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "benchmarks.serve_world_model",
                "--engine",
                "experiential",
                "--name",
                "rose-test",
                "--root",
                str(tmp_path / "native"),
                "--port",
                str(port),
            ],
            cwd=repo,
            env=env,
            stdout=output,
            stderr=subprocess.STDOUT,
        )
        children = []
        try:
            with httpx.Client(trust_env=False, timeout=1) as http:
                deadline = time.monotonic() + 35
                while time.monotonic() < deadline:
                    assert owner.poll() is None, log.read_text()
                    try:
                        response = http.get(f"http://127.0.0.1:{port}/healthz")
                        if response.status_code == 200:
                            break
                    except httpx.ConnectError:
                        pass
                    time.sleep(0.1)
                else:
                    pytest.fail(log.read_text())
                assert response.json()["engine"] == "experiential"
            children = psutil.Process(owner.pid).children()
            assert len(children) == 1
        finally:
            if owner.poll() is None:
                owner.terminate()
            try:
                owner.wait(timeout=25)
            except subprocess.TimeoutExpired:
                owner.kill()
                owner.wait(timeout=5)
                pytest.fail("Native service owner did not finish cleanup")
        assert not any(child.is_running() and child.status() != psutil.STATUS_ZOMBIE for child in children), (
            log.read_text()
        )


def test_message_conversion_omits_empty_system():
    rose = _to_rose_messages("", [Message(role="user", content="hi")])
    assert rose == [{"role": "user", "content": "hi"}]


def test_wmh_cache_stream_never_contains_leased_access_token(monkeypatch):
    from providers.rose import RoseClient
    from providers.rose.types import StreamChunk

    leased_usage = {
        "prompt_tokens": 12,
        "completion_tokens": 3,
        "compute_token_used": {
            "type": "gpt",
            "source": "pool",
            "accessToken": "secret-lease",
        },
    }

    async def fake_complete_impl(self, **kwargs):
        yield StreamChunk(kind="usage", data=leased_usage)
        yield StreamChunk(kind="content", data={"text": '{"output":"ok"}'})
        yield StreamChunk(kind="done")

    monkeypatch.setattr(RoseClient, "_complete_impl", fake_complete_impl)
    client = object.__new__(wmh_rose_provider._WMHCacheSafeRoseClient)

    async def chunks_for(call_site):
        return [chunk async for chunk in client._complete_impl(call_site=call_site)]

    wmh_chunks = asyncio.run(chunks_for("wmh_world_model"))
    assert wmh_chunks[0].data["compute_token_used"] == {"type": "gpt", "source": "pool"}
    assert "accessToken" not in str(wmh_chunks)
    assert leased_usage["compute_token_used"]["accessToken"] == "secret-lease"

    other_chunks = asyncio.run(chunks_for("execute_loop"))
    assert other_chunks[0].data["compute_token_used"]["accessToken"] == "secret-lease"


@pytest.mark.parametrize(
    "content,finish",
    [
        ("", "length"),
        (" \n\t", "stop"),
        ('{"output":"unfinished', "length"),
        ('{"output":"","is_error":false,"state_note":"research complete"}', "stop"),
        ('{"output":"","is_error":false}', "stop"),
        ('{"state_note":"research complete"}', "stop"),
    ],
)
def test_invalid_prediction_is_rejected_before_cache_done(monkeypatch, content, finish):
    from providers.rose import RoseClient
    from providers.rose.types import StreamChunk

    async def fake_complete_impl(self, **kwargs):
        yield StreamChunk(kind="metadata", data={"actual_model": "qwen-3.8-27b"})
        yield StreamChunk(kind="content", data={"text": content})
        yield StreamChunk(kind="usage", data={"completion_tokens": 16384, "finish_reason": finish})
        yield StreamChunk(kind="done")

    monkeypatch.setattr(RoseClient, "_complete_impl", fake_complete_impl)
    client = object.__new__(wmh_rose_provider._WMHCacheSafeRoseClient)
    observed = []

    async def run():
        async for chunk in client._complete_impl(call_site="wmh_world_model"):
            observed.append(chunk)

    with pytest.raises(ValueError, match="WMH prediction rejected"):
        asyncio.run(run())
    assert not any(chunk.kind == "done" for chunk in observed), "invalid output reached the cache write marker"


def test_stream_rejection_retains_usage_without_credentials(monkeypatch):
    error = wmh_rose_provider._WMHInvalidPrediction(
        "empty visible content",
        {"prompt_tokens": 100, "completion_tokens": 16384, "compute_token_used": {"accessToken": "secret"}},
        "qwen-3.8-27b",
    )

    class Client:
        async def collect(self, **kwargs):
            raise error

    async def fake_lease(self):
        return None, None

    monkeypatch.setattr(RoseWMHProvider, "_lease_auth", fake_lease)
    usage = RoseUsageAccumulator()
    provider = RoseWMHProvider(client=Client(), usage=usage)
    with pytest.raises(ValueError, match="empty visible content"):
        provider.complete("SYS", [Message(role="user", content="go")])
    assert usage.snapshot().calls == 1
    assert usage.snapshot().output_tokens == 16384
    assert "secret" not in str(error.usage)


@pytest.mark.parametrize(
    "content",
    [
        '{"output":"complete"}',
        "Observation with {unstructured braces}.",
        '{"success":false,"output":"declined","metadata":{"source":"payment"}}',
        '{"success":true,"output":"","metadata":{"source":"query"}}',
    ],
)
def test_default_budget_leaves_room_for_reasoning_and_terminal_json(monkeypatch, content):
    fake_client = _FakeRoseClient(_canned_response(content=content, prompt=10, completion=20, token_used=None))

    async def fake_lease(self):
        return None, None

    monkeypatch.setattr(RoseWMHProvider, "_lease_auth", fake_lease)
    provider = RoseWMHProvider(client=fake_client)
    completion = provider.complete("SYS", [Message(role="user", content="go")])

    assert completion.text == content
    assert _WMH_MAX_TOKENS == 16_384
    assert fake_client.calls[0]["max_tokens"] == 16_384


def test_rose_wmh_provider_allows_overlapping_llm_calls(monkeypatch):
    """The sync-to-async Rose bridge must not reserialize WMH predictions."""

    class ConcurrentClient:
        def __init__(self):
            self.lock = threading.Lock()
            self.active = 0
            self.peak_active = 0

        async def collect(self, **kwargs):
            with self.lock:
                self.active += 1
                self.peak_active = max(self.peak_active, self.active)
            try:
                await asyncio.sleep(0.05)
                return _canned_response(content='{"output":"ok"}', prompt=1, completion=1, token_used=None)
            finally:
                with self.lock:
                    self.active -= 1

    async def fake_lease(self):
        return None, None

    monkeypatch.setattr(RoseWMHProvider, "_lease_auth", fake_lease)
    client = ConcurrentClient()
    provider = RoseWMHProvider(client=client, usage=RoseUsageAccumulator())
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(provider.complete, "SYS", [Message(role="user", content="go")]) for _ in range(2)]
        results = [future.result(timeout=5) for future in futures]
    assert client.peak_active == 2
    assert [result.text for result in results] == ['{"output":"ok"}'] * 2


def test_complete_maps_text_and_usage_via_rose_only(monkeypatch):
    fake_client = _FakeRoseClient(
        _canned_response(
            content="observation: it worked",
            prompt=123,
            completion=45,
            token_used={"type": "claude", "source": "pool"},
        )
    )
    leased = _leased_claude_auth(fetch_fresh=None)

    async def fake_lease(self):
        return leased, None

    monkeypatch.setattr(RoseWMHProvider, "_lease_auth", fake_lease)

    provider = RoseWMHProvider(client=fake_client)

    async def run():
        return await provider._complete_async("SYS", [Message(role="user", content="go")], max_tokens=8192)

    completion = asyncio.run(run())

    # (2) text + usage mapping
    assert completion.text == "observation: it worked"
    assert completion.usage.input_tokens == 123
    assert completion.usage.output_tokens == 45

    # (1) + (3): exactly one Rose call, system-first messages, leased auth forwarded verbatim,
    # and no Anthropic anywhere (guarded by the autouse fixture).
    assert len(fake_client.calls) == 1
    call = fake_client.calls[0]
    assert call["pool"] == "rose-1-ultra"
    assert call["messages"][0] == {"role": "system", "content": "SYS"}
    assert call["messages"][1] == {"role": "user", "content": "go"}
    # The rotation-capable context is handed straight to the client — the provider does
    # not unwrap, copy, or re-derive it.
    assert call["claude_auth"] is leased
    assert call["gpt_auth"] is None


def test_demo_wmh_completion_uses_demo_cache_context(monkeypatch):
    """A DEMO task caches the WMH's own Rose completion, not only agent loops."""
    import json
    from pathlib import Path

    from providers.fast_cache.context import current_context

    monkeypatch.setenv("FAST_MODE_CACHE_DISABLE_WRITE_THROUGH", "1")

    tasks = json.loads(Path(__file__).with_name("tasks.json").read_text())
    demo_goal = next(task["prompt"] for task in tasks if "DEMO" in task.get("tags", []))
    observed = []

    class _ContextInspectingClient(_FakeRoseClient):
        async def collect(self, **kwargs: Any) -> RoseResponse:
            observed.append(current_context())
            return await super().collect(**kwargs)

    fake_client = _ContextInspectingClient(
        _canned_response(content='{"output":"complete"}', prompt=10, completion=20, token_used=None)
    )

    async def fake_lease(self):
        return None, None

    monkeypatch.setattr(RoseWMHProvider, "_lease_auth", fake_lease)
    provider = RoseWMHProvider(client=fake_client)

    asyncio.run(
        provider._complete_async(
            "SYS",
            [Message(role="user", content=f"TASK:\n{demo_goal}\n\nINTERACTION HISTORY:\n(start)")],
            max_tokens=8192,
        )
    )

    assert len(observed) == 1
    assert observed[0] is not None
    assert observed[0].read_enabled is True
    assert observed[0].should_write is True
    assert observed[0].goal == demo_goal
    assert observed[0].root_goal == demo_goal
    assert current_context() is None


def test_demo_wmh_completion_extracts_root_goal_from_delegation(monkeypatch):
    """Specialized WMH tasks inherit DEMO eligibility from ROOT OBJECTIVE."""
    import json
    from pathlib import Path

    from providers.fast_cache.context import current_context

    tasks = json.loads(Path(__file__).with_name("tasks.json").read_text())
    demo_goal = next(task["prompt"] for task in tasks if "DEMO" in task.get("tags", []))
    task = f"ROOT OBJECTIVE:\n{demo_goal}\n\nCURRENT DELEGATION:\nInspect Brex"
    observed = []

    class _ContextInspectingClient(_FakeRoseClient):
        async def collect(self, **kwargs: Any) -> RoseResponse:
            observed.append(current_context())
            return await super().collect(**kwargs)

    fake_client = _ContextInspectingClient(
        _canned_response(content='{"output":"complete"}', prompt=10, completion=20, token_used=None)
    )

    async def fake_lease(self):
        return None, None

    monkeypatch.setattr(RoseWMHProvider, "_lease_auth", fake_lease)
    provider = RoseWMHProvider(client=fake_client)
    asyncio.run(
        provider._complete_async(
            "SYS",
            [Message(role="user", content=f"TASK:\n{task}\n\nINTERACTION HISTORY:\n(start)")],
            max_tokens=8192,
        )
    )

    assert observed[0] is not None
    assert observed[0].goal == demo_goal


def test_non_demo_wmh_completion_does_not_enable_demo_cache(monkeypatch):
    """Ordinary WMH inference cannot accidentally enter the DEMO cache namespace."""
    from providers.fast_cache.context import current_context

    observed = []

    class _ContextInspectingClient(_FakeRoseClient):
        async def collect(self, **kwargs: Any) -> RoseResponse:
            observed.append(current_context())
            return await super().collect(**kwargs)

    fake_client = _ContextInspectingClient(
        _canned_response(content='{"output":"complete"}', prompt=10, completion=20, token_used=None)
    )

    async def fake_lease(self):
        return None, None

    monkeypatch.setattr(RoseWMHProvider, "_lease_auth", fake_lease)
    provider = RoseWMHProvider(client=fake_client)
    asyncio.run(
        provider._complete_async(
            "SYS",
            [Message(role="user", content="TASK:\nBuy socks\n\nINTERACTION HISTORY:\n(start)")],
            max_tokens=8192,
        )
    )

    assert observed == [None]


def test_fundraiser_wmh_prompt_uses_demo_cache_goal():
    """The startup session task resolves to the actual fundraiser DEMO namespace."""
    import json
    from pathlib import Path

    from benchmarks.wmh_rose_provider import _demo_cache_goal_from_messages

    tasks = json.loads(Path(__file__).with_name("tasks.json").read_text())
    goal = next(task["prompt"] for task in tasks if task["name"] == "raise-5m-rose-labs-brex")
    assert (
        _demo_cache_goal_from_messages(
            [Message(role="user", content=f"TASK:\n{goal}\n\nINTERACTION HISTORY:\n(start)")]
        )
        == goal
    )


def test_config_model_defaults_to_pool_for_metering():
    provider = RoseWMHProvider(client=_FakeRoseClient(RoseResponse()))
    # WorldModel.step reads provider.config.model for metering.
    assert provider.config.model == "rose-1-ultra"

    labeled = RoseWMHProvider(client=_FakeRoseClient(RoseResponse()), model_label="claude-haiku")
    assert labeled.config.model == "claude-haiku"


def test_lease_reuses_helpers_and_delegates_rotation(monkeypatch):
    """The provider LEASES via the reused helpers; ROTATION is owned by the client.

    We stub the two reused helpers (`fetch_compute_token_activity`,
    `_build_compute_auth_context`) so no network is hit, and assert:
      - the provider calls the real lease helper (not a hand-rolled fetch),
      - the auth context it forwards carries a `fetch_fresh` callback,
      - when the client (fake) simulates an auth failure and invokes `fetch_fresh`,
        rotation happens THROUGH that callback — the provider never rotates itself.
    """
    rotate_calls: List[str] = []

    async def bound_fetch_fresh(user_id: str):
        # Stand-in for the rotation callback `_build_compute_auth_context` binds to
        # fetch_compute_token_activity. Returns a fresh, rotated context.
        rotate_calls.append(user_id)
        return _leased_claude_auth(fetch_fresh=None)

    leased = _leased_claude_auth(fetch_fresh=bound_fetch_fresh)

    lease_helper_calls: List[str] = []

    async def fake_fetch_compute_token_activity(user_id: str, *a, **k):
        lease_helper_calls.append(user_id)
        return {"type": "claude", "accessToken": "tok", "source": "pool"}

    def fake_build_ctx(result, user_id, **kwargs):
        # Prove the provider routes the helper's result to the isinstance branch.
        assert result["type"] == "claude"
        return leased

    # Patch the symbols where the provider imports them (helpers.llm).
    import helpers.llm as real_llm

    monkeypatch.setattr(real_llm, "fetch_compute_token_activity", fake_fetch_compute_token_activity)
    monkeypatch.setattr(real_llm, "_build_compute_auth_context", fake_build_ctx)

    # A fake client that simulates an auth error by driving the leased context's rotation
    # callback — exactly what the real RoseClient does internally.
    class _RotatingFakeClient:
        def __init__(self) -> None:
            self.calls: List[Dict[str, Any]] = []

        async def collect(self, **kwargs: Any) -> RoseResponse:
            self.calls.append(kwargs)
            auth = kwargs["claude_auth"]
            # Simulate: original token failed auth -> client rotates via the bound callback.
            assert auth.fetch_fresh is not None, "provider must forward a rotation-capable context"
            rotated = await auth.fetch_fresh(auth.user_id)
            assert isinstance(rotated, ClaudeAuthContext)
            return _canned_response(
                content="ok-after-rotation",
                prompt=10,
                completion=2,
                token_used={"type": "claude", "source": "pool"},
            )

    client = _RotatingFakeClient()
    provider = RoseWMHProvider(client=client, user_id="u-1")

    async def run():
        return await provider._complete_async("S", [Message(role="user", content="q")], max_tokens=8192)

    completion = asyncio.run(run())

    assert completion.text == "ok-after-rotation"
    # Lease went through the reused helper (not re-implemented).
    assert lease_helper_calls == ["u-1"]
    # Rotation happened through the callback the client invoked — driven by the client,
    # not by the provider. rotate_calls proves the delegated callback fired.
    assert rotate_calls == ["u-1"]


def test_no_compute_token_falls_through_to_waterfall(monkeypatch):
    """No credentials -> (None, None) auth, so Rose uses the waterfall (no rotation)."""
    import helpers.llm as real_llm

    async def fake_fetch(user_id: str, *a, **k):
        return None

    monkeypatch.setattr(real_llm, "fetch_compute_token_activity", fake_fetch)

    provider = RoseWMHProvider(client=_FakeRoseClient(RoseResponse()), user_id="u-2")

    async def run():
        return await provider._lease_auth()

    claude_auth, gpt_auth = asyncio.run(run())
    assert claude_auth is None
    assert gpt_auth is None


def test_complete_bridges_sync_to_async(monkeypatch):
    """The sync `complete()` drives the async path via asyncio.run (no running loop)."""
    fake_client = _FakeRoseClient(_canned_response(content="sync-ok", prompt=1, completion=1, token_used=None))

    async def fake_lease(self):
        return _leased_claude_auth(fetch_fresh=None), None

    monkeypatch.setattr(RoseWMHProvider, "_lease_auth", fake_lease)
    provider = RoseWMHProvider(client=fake_client)

    completion = provider.complete("S", [Message(role="user", content="go")])
    assert completion.text == "sync-ok"
    assert completion.usage.input_tokens == 1


def test_embed_and_verify_are_not_on_serve_path():
    provider = RoseWMHProvider(client=_FakeRoseClient(RoseResponse()))
    with pytest.raises(NotImplementedError):
        provider.embed(["x"])
    with pytest.raises(NotImplementedError):
        provider.verify()


def test_resolve_user_id_precedence(monkeypatch):
    monkeypatch.delenv("WMH_ROSE_USER_ID", raising=False)
    assert wmh_rose_provider._resolve_user_id("explicit") == "explicit"
    assert wmh_rose_provider._resolve_user_id(None) == wmh_rose_provider._DEFAULT_WMH_USER_ID
    monkeypatch.setenv("WMH_ROSE_USER_ID", "from-env")
    assert wmh_rose_provider._resolve_user_id(None) == "from-env"
    assert wmh_rose_provider._resolve_user_id("explicit") == "explicit"


def test_provider_satisfies_wmh_provider_protocol():
    """Runtime check that RoseWMHProvider is a structural `Provider`."""
    from wmh.providers.base import Provider

    provider = RoseWMHProvider(client=_FakeRoseClient(RoseResponse()))
    assert isinstance(provider, Provider)
    # And it exposes the metering surface WorldModel.step reads.
    assert hasattr(provider.config, "model")


# --- cost accumulation ------------------------------------------------------


def _waterfall_response(*, content: str, prompt: int, completion: int) -> RoseResponse:
    """A response that won the race on a paid waterfall model (non-$0 pricing)."""
    r = RoseResponse()
    r.content = content
    # A concrete waterfall model in providers.rose.pricing (not a -claude direct model).
    r.actual_model = "google/gemini-3.5-flash"
    r.usage = {"prompt_tokens": prompt, "completion_tokens": completion}
    return r


def test_accumulator_is_thread_safe_and_sums():
    """Concurrent record() calls tally without lost updates (lock-guarded)."""
    import threading

    acc = RoseUsageAccumulator()

    def worker():
        for _ in range(1000):
            acc.record(cost_usd=0.001, input_tokens=2, output_tokens=1)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    snap = acc.snapshot()
    assert snap.calls == 8000
    assert snap.input_tokens == 8 * 1000 * 2
    assert snap.output_tokens == 8 * 1000 * 1
    assert snap.total_cost_usd == pytest.approx(8000 * 0.001)


def test_snapshot_as_dict_shape():
    acc = RoseUsageAccumulator()
    acc.record(cost_usd=0.12345678, input_tokens=10, output_tokens=5)
    d = acc.snapshot().as_dict()
    assert set(d) == {"total_cost_usd", "calls", "input_tokens", "output_tokens"}
    assert d["calls"] == 1
    assert d["input_tokens"] == 10
    assert d["output_tokens"] == 5
    # total_cost_usd rounded to 6 places.
    assert d["total_cost_usd"] == 0.123457


def test_cost_zero_for_direct_claude_and_unknown():
    # Any -claude/-gpt direct path is priced at $0 (user's own subscription pays) —
    # including models absent from the explicit direct-pricing list (e.g. haiku-claude).
    assert _cost_usd_for_call("claude-opus-4-8-claude", 10_000, 10_000) == 0.0
    assert _cost_usd_for_call("claude-haiku-4-5-claude", 10_000, 10_000) == 0.0
    assert _cost_usd_for_call("gpt-5.4-gpt", 10_000, 10_000) == 0.0
    # Unknown / empty model → 0.0 (no invented numbers, no fuzzy substring match).
    assert _cost_usd_for_call("some/unknown-model", 10_000, 10_000) == 0.0
    assert _cost_usd_for_call("", 10_000, 10_000) == 0.0


def test_cost_nonzero_for_waterfall_model():
    from providers.rose.pricing import get_model_pricing

    pricing = get_model_pricing("google/gemini-3.5-flash")
    assert pricing is not None
    cost = _cost_usd_for_call("google/gemini-3.5-flash", 1000, 1000)
    expected = (
        (1000 / 1000.0) * pricing["input_cents_per_1k"] + (1000 / 1000.0) * pricing["output_cents_per_1k"]
    ) / 100.0
    assert cost == pytest.approx(expected)
    assert cost > 0.0


def test_complete_records_cost_into_injected_accumulator(monkeypatch):
    """Each WMH step folds its Rose cost + tokens into the provider's accumulator."""
    acc = RoseUsageAccumulator()
    fake_client = _FakeRoseClient(_waterfall_response(content="obs", prompt=1000, completion=1000))

    async def fake_lease(self):
        return _leased_claude_auth(fetch_fresh=None), None

    monkeypatch.setattr(RoseWMHProvider, "_lease_auth", fake_lease)
    provider = RoseWMHProvider(client=fake_client, usage=acc)

    async def run():
        return await provider._complete_async("SYS", [Message(role="user", content="go")], max_tokens=8192)

    completion = asyncio.run(run())
    assert completion.usage.input_tokens == 1000
    assert completion.usage.output_tokens == 1000

    snap = acc.snapshot()
    assert snap.calls == 1
    assert snap.input_tokens == 1000
    assert snap.output_tokens == 1000
    assert snap.total_cost_usd == pytest.approx(_cost_usd_for_call("google/gemini-3.5-flash", 1000, 1000))


def test_complete_records_zero_cost_for_direct_claude(monkeypatch):
    """The common claudeAuth path adds tokens but $0 cost."""
    acc = RoseUsageAccumulator()
    fake_client = _FakeRoseClient(_canned_response(content="obs", prompt=500, completion=200, token_used=None))

    async def fake_lease(self):
        return _leased_claude_auth(fetch_fresh=None), None

    monkeypatch.setattr(RoseWMHProvider, "_lease_auth", fake_lease)
    provider = RoseWMHProvider(client=fake_client, usage=acc)

    async def run():
        return await provider._complete_async("SYS", [Message(role="user", content="go")], max_tokens=8192)

    asyncio.run(run())
    snap = acc.snapshot()
    assert snap.calls == 1
    assert snap.input_tokens == 500
    assert snap.output_tokens == 200
    assert snap.total_cost_usd == 0.0


def test_provider_defaults_to_global_accumulator():
    provider = RoseWMHProvider(client=_FakeRoseClient(RoseResponse()))
    assert provider._usage is wmh_rose_provider.GLOBAL_ROSE_USAGE


@pytest.mark.parametrize(
    "served_policy", ["upstream", "rose-virtual-public-affordances-v1", "rose-virtual-public-affordances-v2"]
)
@pytest.mark.parametrize("expected", ["rose-virtual-public-affordances-v1", "rose-virtual-public-affordances-v2"])
def test_native_conformance_rejects_unexpected_execution_policy_before_inference(tmp_path, served_policy, expected):
    import io
    from contextlib import redirect_stdout

    from benchmarks.run_world_model_conformance import main
    from benchmarks.wmh_execution_policy import execution_identity
    from benchmarks.world_model_harness import evaluate_world_model_conformance_suite

    class Client:
        predictions = 0

        async def model_identity(self, name):
            return {
                "world_model_id": "artifact-a",
                "world_model_manifest_sha256": "a" * 64,
                "execution_identity": execution_identity(served_policy, "artifact-a", "a" * 64),
            }

        async def start_session(self, *args, **kwargs):
            self.predictions += 1
            return "session"

        async def step(self, *args, **kwargs):
            return {"content": "exact", "is_error": False, "metadata": {}}

    path = tmp_path / "suite.json"
    path.write_text(
        json.dumps(
            {
                "schema": "rose.wmh_conformance_suite.v1",
                "status": "passed",
                "requested_examples": 1,
                "native_world_model_id": "artifact-a",
                "native_world_model_manifest_sha256": "a" * 64,
                "examples": [
                    {
                        "task": "root",
                        "action": {
                            "category": "browser",
                            "name": "spawn_browser_agent",
                            "arguments": {},
                            "tool_call_id": "call",
                        },
                        "observation": {"category": "browser", "content": "exact"},
                    }
                ],
            }
        )
    )
    base_bytes = path.read_bytes()
    unbound_client = Client()
    with pytest.raises(ValueError, match="execution-bound"):
        asyncio.run(
            evaluate_world_model_conformance_suite(
                path, world_model_name="test", client=unbound_client, execution_policy=expected
            )
        )
    assert unbound_client.predictions == 0
    bound_path = tmp_path / "bound.json"
    cli_output = io.StringIO()
    with redirect_stdout(cli_output):
        assert (
            main(["--suite", str(path), "--bind-execution-suite", str(bound_path), "--execution-policy", expected]) == 0
        )
    bound = json.loads(bound_path.read_bytes())
    assert json.loads(cli_output.getvalue())["native_execution_identity"] == bound["native_execution_identity"]
    assert path.read_bytes() == base_bytes
    assert bound["examples"] == json.loads(base_bytes)["examples"]
    path = bound_path
    client = Client()
    if served_policy != expected:
        with pytest.raises(ValueError, match="execution identity"):
            asyncio.run(
                evaluate_world_model_conformance_suite(
                    path, world_model_name="test", client=client, execution_policy=expected
                )
            )
        assert client.predictions == 0
    else:
        report = asyncio.run(
            evaluate_world_model_conformance_suite(
                path, world_model_name="test", client=client, execution_policy=expected
            )
        )
        assert report["native_execution_identity"] == execution_identity(expected, "artifact-a", "a" * 64)
        assert report["status"] == "passed" and client.predictions == 1


@pytest.mark.parametrize("descriptor_kind", ["missing", "altered", "wrong_system"])
@pytest.mark.parametrize("policy_name", ["rose-virtual-public-affordances-v1", "rose-virtual-public-affordances-v2"])
def test_provider_bridge_rejects_unbound_execution_before_provider_dispatch(descriptor_kind, policy_name):
    import httpx

    from benchmarks.experiential_bridge import build_provider_bridge
    from benchmarks.wmh_execution_policy import execution_identity

    class Provider:
        calls = 0

        async def complete_scoped(self, *args, **kwargs):
            self.calls += 1
            raise AssertionError("Invalid policy must not dispatch")

    async def run():
        identity = execution_identity(policy_name, "artifact-a", "a" * 64)
        if descriptor_kind == "missing":
            identity = None
        elif descriptor_kind == "altered":
            identity["policy_version"] = "unapproved"
        provider = Provider()
        app = build_provider_bridge(provider, "fixture-token", execution_policy=policy_name)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture") as client:
            response = await client.post(
                "/complete",
                headers={"X-Rose-Provider-Token": "fixture-token"},
                json={
                    "messages": [
                        {"role": "system", "content": "unreviewed system override"},
                        {"role": "user", "content": "{}"},
                    ],
                    "maximum_output_tokens": 16384,
                    "session_id": "session",
                    "prediction_id": "prediction",
                    "execution_identity": identity,
                },
            )
        assert response.status_code == 409 and provider.calls == 0

    asyncio.run(run())
