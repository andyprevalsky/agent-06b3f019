"""Blackbox regressions for benchmark prompt-cache ratchets."""

import asyncio
import json
import inspect
import os

from _test_utils import BlackboxResult


FAILING_CLAUDE_CODE_AGENT_USAGE = [
    {
        "type": "llm",
        "_benchmark_agent_id": "root",
        "call_site": "execute_loop",
        "cache_sequence_id": "agent:root:call:execute_loop",
        "model": "gpt-5.6-sol-gpt",
        "cache_read_input_tokens": 1408,
        "cache_creation_input_tokens": 6260,
    },
    {
        "type": "llm",
        "_benchmark_agent_id": "root",
        "call_site": "completion_summary",
        "cache_sequence_id": "agent:root:call:completion_summary",
        "model": "anthropic/claude-opus-4.8",
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 1300,
    },
    {
        "type": "llm",
        "_benchmark_agent_id": "root",
        "call_site": "execute_loop",
        "cache_sequence_id": "agent:root:call:execute_loop",
        "model": "gpt-5.6-sol-gpt",
        "cache_read_input_tokens": 6528,
        "cache_creation_input_tokens": 2527,
    },
    {
        "type": "llm",
        "_benchmark_agent_id": "root",
        "call_site": "verifier_execute",
        "cache_sequence_id": "agent:root:call:verifier_execute",
        "model": "gpt-5.6-sol-gpt",
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 2681,
    },
    {
        "type": "llm",
        "_benchmark_agent_id": "root",
        "call_site": "verifier_execute",
        "cache_sequence_id": None,
        "model": "gpt-5.6-sol-gpt",
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 10089,
    },
]


def test_prompt_cache_share_is_the_golden_reference_hit_rate():
    """share = read / (read + creation + uncached input) over every cache-sequenced call.

    claude-code-src utils/forkedAgent.ts:646-654 and openclaw
    live-cache-test-support.ts:166-180 count uncached input in the denominator;
    calls without a cache sequence id cannot reuse a cache and are not measured.
    """
    from benchmarks.llm_usage import aggregate_prompt_cache_share

    usage = [dict(item, tokens_in=10) for item in FAILING_CLAUDE_CODE_AGENT_USAGE]
    metrics = aggregate_prompt_cache_share(usage)

    assert metrics == {
        "cache_read_input_tokens": 7936,
        "cache_creation_input_tokens": 12768,
        "uncached_input_tokens": 40,
        "cache_share_pct": 38.3,
        "call_count": 4,
    }, metrics


def test_one_shot_sequences_and_sibling_namespaces_are_measured():
    """A sequence that ran once still counts: its writes cost and its reads reuse."""
    from benchmarks.llm_usage import aggregate_prompt_cache_share

    metrics = aggregate_prompt_cache_share(
        [
            {
                "type": "llm",
                "_benchmark_agent_id": "root",
                "call_site": "summarize_web_fetch",
                "cache_sequence_id": f"agent:root:tool:fetch-{index}:call:summarize_web_fetch",
                "model": "gpt-5.6-sol-gpt",
                "tokens_in": 0,
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 1000 + index,
            }
            for index in range(9)
        ]
    )

    assert metrics == {
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 9036,
        "uncached_input_tokens": 0,
        "cache_share_pct": 0.0,
        "call_count": 9,
    }, metrics


def _task_result(name: str, **cache_fields):
    from benchmarks.results import TaskResult

    return TaskResult(
        name=name,
        passed=True,
        agent_id="agent-fixture",
        status="COMPLETED",
        progress_score=1,
        duration_seconds=1,
        cost_cents=0,
        message_count=1,
        **cache_fields,
    )


def _share_result(name: str, usage: list[dict]) -> object:
    from benchmarks.llm_usage import aggregate_prompt_cache_share

    metrics = aggregate_prompt_cache_share(usage)
    return _task_result(
        name,
        prompt_cache_read_input_tokens=metrics["cache_read_input_tokens"],
        prompt_cache_creation_input_tokens=metrics["cache_creation_input_tokens"],
        prompt_cache_uncached_input_tokens=metrics["uncached_input_tokens"],
        prompt_cache_share_pct=metrics["cache_share_pct"],
        prompt_cache_call_count=metrics["call_count"],
    )


def _call(read: int, write: int, uncached: int, sequence: str | None = "agent:root:call:execute_loop") -> dict:
    return {
        "type": "llm",
        "_benchmark_agent_id": "root",
        "call_site": "execute_loop",
        "cache_sequence_id": sequence,
        "model": "claude-opus-5-5-claude",
        "tokens_in": uncached,
        "cache_read_input_tokens": read,
        "cache_creation_input_tokens": write,
    }


def _assert_ratchet_fails(result) -> None:
    from benchmarks.run_benchmark import enforce_cache_ratchets

    try:
        enforce_cache_ratchets([result])
        raise AssertionError("cache ratchet failed open")
    except SystemExit as exc:
        assert exc.code == 1


def test_one_call_run_with_good_cache_share_passes():
    """claude-code-agent 18748b72: one root call, 13,768 read / 5,755 write / 4 uncached = 70.5%."""
    from benchmarks.run_benchmark import enforce_cache_ratchets

    result = _share_result("claude-code-agent", [_call(13768, 5755, 4)])
    assert result.prompt_cache_share_pct == 70.5
    enforce_cache_ratchets([result])


def test_one_call_run_with_poor_cache_share_fails():
    """A single call is measured, never passed automatically: 1,000 / 20,004 = 5.0% < 35%."""
    _assert_ratchet_fails(_share_result("claude-code-agent", [_call(1000, 19000, 4)]))


def test_repeated_run_with_no_cache_use_fails():
    """Repeated calls that never read the cache are 0% even when they write or send uncached input."""
    _assert_ratchet_fails(_share_result("claude-code-agent", [_call(0, 0, 9000), _call(0, 0, 9100)]))
    _assert_ratchet_fails(_share_result("claude-code-agent", [_call(0, 6000, 4), _call(0, 6100, 4)]))


def test_missing_cache_telemetry_fails_closed():
    """No cache-sequenced call means no cache telemetry: overall cache cannot mask it."""
    _assert_ratchet_fails(_share_result("claude-code-agent", [_call(13768, 5755, 4, sequence=None)]))
    _assert_ratchet_fails(_task_result("claude-code-agent", cache_read_input_tokens=900, cache_creation_input_tokens=100))
    from benchmarks.run_benchmark import enforce_cache_ratchets, main_async

    at_floor = _share_result("claude-code-agent", [_call(35, 60, 5)])
    assert at_floor.prompt_cache_share_pct == 35.0
    enforce_cache_ratchets([at_floor])
    assert "enforce_cache_ratchets(run.task_results)" in inspect.getsource(main_async)


ROOT_GOAL = "Using Claude Code, write and run a Python program that computes the Collatz sequence starting from 27."


def _root_first_call(static_noise: str = "") -> tuple[list[dict], object]:
    """The root's first EXECUTE planner request as AgentWorkflow builds it, with per-run context."""
    from tools.prompts import TOOL_PROMPTS
    from utils.prompts import build_system_prompt
    from utils.tool_schemas import EXECUTE_PHASE_TOOLS, create_agent_action_model, get_tool_models

    system = build_system_prompt(
        phase="EXECUTE",
        enabled_tools=EXECUTE_PHASE_TOOLS,
        user_context_section="Name: Andy Prevalsky\nPhone: +19729777432",
        response_schema={"fields": [{"name": "total_steps", "type": "int", "required": True}]},
        tool_prompts=TOOL_PROMPTS,
    )
    system = static_noise + system
    messages = [{"role": "system", "content": system}, {"role": "user", "content": ROOT_GOAL}]
    return messages, create_agent_action_model(EXECUTE_PHASE_TOOLS, tool_registry=get_tool_models(rose_desktop=False))


def _claude_cached_prefix(messages: list[dict], response_model: object) -> str:
    """Tools plus system blocks through the first cache marker: what a later call can read."""
    from providers.rose.claude_auth import build_anthropic_body
    from providers.rose.pools import get_pool
    from providers.rose.schema import build_openai_response_format

    body = build_anthropic_body(
        pool_spec=get_pool("rose-1-ultra"),
        messages=messages,
        tools=None,
        tool_choice=None,
        response_format=build_openai_response_format(response_model),
        max_tokens=1024,
    )
    system = body.get("system") or []
    marked = next(index for index, block in enumerate(system) if "cache_control" in block)
    return json.dumps({"tools": body.get("tools"), "system": system[: marked + 1]}, sort_keys=True)


def _gpt_static_scope(messages: list[dict]) -> str:
    from providers.rose.gpt_auth import _build_static_cache_scope

    return _build_static_cache_scope(messages)


def test_warmup_primes_the_root_static_prefix_on_both_routes():
    """The warmup writes the exact prefix the root's first call reads (Claude and GPT routes).

    OpenClaw live-cache-regression-policy.ts:116-178 warms a lane before the measured run.
    """
    from benchmarks.cache_warmup import root_phase, warmup_request

    assert root_phase("execute") == "EXECUTE" and root_phase(None) == "PLAN"
    warm = warmup_request(phase="EXECUTE", goal=ROOT_GOAL, rose_desktop=False)
    root_messages, root_model = _root_first_call()
    assert _claude_cached_prefix(warm["messages"], warm["response_model"]) == _claude_cached_prefix(
        root_messages, root_model
    )
    assert _gpt_static_scope(warm["messages"]) == _gpt_static_scope(root_messages)


def test_warmup_does_not_mask_a_run_specific_static_prefix():
    """A root prefix with run-specific bytes differs from the warmup, so it still reads cold."""
    from benchmarks.cache_warmup import warmup_request

    warm = warmup_request(phase="EXECUTE", goal=ROOT_GOAL, rose_desktop=False)
    root_messages, root_model = _root_first_call(static_noise="Run started 2026-10-25T01:02:03Z\n")
    assert _claude_cached_prefix(warm["messages"], warm["response_model"]) != _claude_cached_prefix(
        root_messages, root_model
    )
    assert _gpt_static_scope(warm["messages"]) != _gpt_static_scope(root_messages)


def test_warmup_is_recorded_apart_from_the_measured_share():
    """A warmup's own cache tokens never count; a cold measured call still fails the floor."""
    cold_after_warmup = _share_result("claude-code-agent", [_call(0, 19544, 4)])
    cold_after_warmup.prompt_cache_warmup = {
        "call_site": "cache_warmup",
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 19544,
        "uncached_input_tokens": 4,
    }
    assert cold_after_warmup.prompt_cache_share_pct == 0.0
    _assert_ratchet_fails(cold_after_warmup)
    warm_measured = _share_result("claude-code-agent", [_call(18736, 822, 4)])
    warm_measured.prompt_cache_warmup = {"call_site": "cache_warmup", "cache_creation_input_tokens": 19544}
    from benchmarks.run_benchmark import enforce_cache_ratchets

    assert warm_measured.prompt_cache_share_pct == 95.8
    enforce_cache_ratchets([warm_measured])


def _gpt_call(read: int, write: int, uncached: int) -> dict:
    return dict(_call(read, write, uncached), model="gpt-6-sol-gpt")


def test_cache_route_is_recorded_from_the_served_model():
    """The share records which route served its sequenced calls."""
    from benchmarks.llm_usage import aggregate_prompt_cache_share

    assert aggregate_prompt_cache_share([_call(10, 10, 1)])["routes"] == ["claude_auth"]
    assert aggregate_prompt_cache_share([_gpt_call(10, 0, 30)])["routes"] == ["gpt_auth"]
    assert aggregate_prompt_cache_share([_call(10, 10, 1), _gpt_call(10, 0, 30)])["routes"] == ["claude_auth", "gpt_auth"]
    unknown = dict(_call(10, 10, 1), model="mystery-model")
    assert aggregate_prompt_cache_share([unknown])["routes"] == ["unclassified"]


def test_gpt_route_floor_is_derived_by_one_rule_from_measured_history():
    """One uniform rule (median of pure-route passing samples x 0.9, as OpenClaw's stable lane
    0.996 -> 0.90), capped at the task floor; under 3 samples falls back to the task floor."""
    from benchmarks.run_benchmark import (
        CACHE_FLOOR_ROUTE_SAMPLES,
        PER_TASK_CACHE_HIT_RATCHET,
        derive_route_cache_floor,
        route_cache_floor,
    )

    assert derive_route_cache_floor([16.0, 20.3, 26.2], cap=25.0) == 18.3
    assert derive_route_cache_floor([72.6, 75.3, 75.9], cap=40.0) == 40.0
    assert derive_route_cache_floor([37.3, 46.3], cap=35.0) == 35.0
    for (task, route), samples in CACHE_FLOOR_ROUTE_SAMPLES.items():
        assert route_cache_floor(task, [route]) == derive_route_cache_floor(
            samples, cap=PER_TASK_CACHE_HIT_RATCHET[task]
        ), (task, route)
    for task, floor in PER_TASK_CACHE_HIT_RATCHET.items():
        assert route_cache_floor(task, ["claude_auth"]) == floor
        assert route_cache_floor(task, ["other"]) == floor


def _routed_result(name: str, usage: list[dict]) -> object:
    from benchmarks.llm_usage import aggregate_prompt_cache_share

    result = _share_result(name, usage)
    result.prompt_cache_routes = aggregate_prompt_cache_share(usage)["routes"]
    return result


def test_gpt_route_run_at_24_percent_passes_only_under_the_derived_floor():
    """spawn-sub-agents on GPT at 24%: passes against the derived GPT floor, fails against Claude's 25%."""
    from benchmarks.run_benchmark import enforce_cache_ratchets, route_cache_floor

    gpt_run = _routed_result("spawn-sub-agents", [_gpt_call(2400, 0, 7600)])
    assert gpt_run.prompt_cache_share_pct == 24.0
    assert route_cache_floor("spawn-sub-agents", ["gpt_auth"]) < 24.0
    enforce_cache_ratchets([gpt_run])

    claude_run = _routed_result("spawn-sub-agents", [_call(2400, 7596, 4)])
    assert claude_run.prompt_cache_share_pct == 24.0
    assert route_cache_floor("spawn-sub-agents", ["claude_auth"]) == 25.0
    _assert_ratchet_fails(claude_run)

    mixed = _routed_result("spawn-sub-agents", [_gpt_call(1200, 0, 3800), _call(1200, 3796, 4)])
    _assert_ratchet_fails(mixed)  # mixed routes take the strictest floor


def test_missing_route_telemetry_fails_closed():
    """No recorded route, or an unclassified one, cannot select a lenient floor."""
    good_share = _share_result("spawn-sub-agents", [_gpt_call(9000, 0, 1000)])
    good_share.prompt_cache_routes = []
    _assert_ratchet_fails(good_share)
    good_share.prompt_cache_routes = ["unclassified"]
    _assert_ratchet_fails(good_share)


def test_claude_code_cache_ratchet_is_deploy_warn_only_when_enabled():
    """Deploy smoke may warn on Claude Code cache telemetry without weakening other ratchets."""
    from benchmarks.run_benchmark import CLAUDE_CODE_CACHE_RATCHET_WARN_ONLY_ENV, enforce_cache_ratchets

    claude_code_low = _share_result("claude-code-agent", [_call(0, 100, 0)])
    parallel_low = _share_result("parallel-tool-calls", [_call(0, 100, 0)])

    previous = os.environ.get(CLAUDE_CODE_CACHE_RATCHET_WARN_ONLY_ENV)
    try:
        os.environ[CLAUDE_CODE_CACHE_RATCHET_WARN_ONLY_ENV] = "1"
        enforce_cache_ratchets([claude_code_low])
        try:
            enforce_cache_ratchets([parallel_low])
            raise AssertionError("non-Claude cache ratchet failed open")
        except SystemExit as exc:
            assert exc.code == 1
    finally:
        if previous is None:
            os.environ.pop(CLAUDE_CODE_CACHE_RATCHET_WARN_ONLY_ENV, None)
        else:
            os.environ[CLAUDE_CODE_CACHE_RATCHET_WARN_ONLY_ENV] = previous


async def test_collector_identity_is_authoritative_and_separates_agents():
    """Each tree agent's usage is collected once under its authoritative identity and measured."""
    import benchmarks.run_benchmark as runner

    original = runner.get_agent_tool_usage

    async def fake_usage(_base_url, agent_id):
        return {
            "usages": [
                {
                    "usage_items": [
                        {
                            "type": "llm",
                            "agent_id": "untrusted-shared-id",
                            "call_site": "execute_loop",
                            "cache_sequence_id": "agent:untrusted-shared-id:call:execute_loop",
                            "cache_read_input_tokens": 50,
                            "cache_creation_input_tokens": 50,
                            "model": "gpt-5.6-sol-gpt",
                        }
                    ]
                }
            ]
        }

    runner.get_agent_tool_usage = fake_usage
    try:
        provider_usage, prompt_cache = await runner.get_llm_usage_details(
            "http://benchmark.invalid",
            "root-agent",
            {"all_agents": [{"agent_id": "root-agent"}, {"agent_id": "child-agent"}]},
        )
    finally:
        runner.get_agent_tool_usage = original

    assert sum(row["calls"] for row in provider_usage.values()) == 2
    assert prompt_cache == {
        "cache_read_input_tokens": 100,
        "cache_creation_input_tokens": 100,
        "uncached_input_tokens": 0,
        "cache_share_pct": 50.0,
        "call_count": 2,
    }


async def test_partial_tree_usage_collection_fails_loudly():
    """One unavailable child usage payload invalidates the tree metric."""
    import benchmarks.run_benchmark as runner

    original = runner.get_agent_tool_usage

    async def partial_usage(_base_url, agent_id):
        if agent_id == "child-agent":
            raise RuntimeError("503 child usage unavailable")
        return {"usages": []}

    runner.get_agent_tool_usage = partial_usage
    try:
        try:
            await runner.get_llm_usage_details(
                "http://benchmark.invalid",
                "root-agent",
                {"all_agents": [{"agent_id": "root-agent"}, {"agent_id": "child-agent"}]},
            )
            raise AssertionError("partial tree usage was silently accepted")
        except RuntimeError as exc:
            assert "child usage unavailable" in str(exc)
    finally:
        runner.get_agent_tool_usage = original


async def test_usage_endpoint_non_200_is_not_an_empty_success():
    """The real usage fetcher distinguishes an unavailable payload from zero usage."""
    import benchmarks.run_benchmark as runner

    class UnavailableResponse:
        status_code = 503

    class UnavailableClient:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, *_args, **_kwargs):
            return UnavailableResponse()

    original_headers = runner._api_headers
    original_client = runner.httpx.AsyncClient

    async def no_headers():
        return {}

    runner._api_headers = no_headers
    runner.httpx.AsyncClient = UnavailableClient
    try:
        try:
            await runner.get_agent_tool_usage(
                "http://benchmark.invalid",
                "agent-fixture",
            )
            raise AssertionError("503 usage response became an empty success")
        except RuntimeError as exc:
            assert "returned 503" in str(exc)
    finally:
        runner._api_headers = original_headers
        runner.httpx.AsyncClient = original_client


def test_prompt_cache_floors_match_deploy_policy():
    """Repeatable-cache floors match the deploy gate's calibrated policy."""
    from benchmarks.run_benchmark import PER_TASK_CACHE_HIT_RATCHET

    assert PER_TASK_CACHE_HIT_RATCHET == {
        "chat-mode": 0.0,
        "spawn-sub-agents": 25.0,
        "parallel-tool-calls": 30.0,
        "claude-code-agent": 35.0,
        "browser-smoke": 40.0,
    }


async def run_all_tests():
    print("cache ratchet blackbox tests:")
    result = BlackboxResult()
    result.record("golden_reference_share", test_prompt_cache_share_is_the_golden_reference_hit_rate)
    result.record("one_shot_sequences_measured", test_one_shot_sequences_and_sibling_namespaces_are_measured)
    result.record("one_call_good_share_passes", test_one_call_run_with_good_cache_share_passes)
    result.record("one_call_poor_share_fails", test_one_call_run_with_poor_cache_share_fails)
    result.record("repeated_no_cache_fails", test_repeated_run_with_no_cache_use_fails)
    result.record("missing_telemetry_fails_closed", test_missing_cache_telemetry_fails_closed)
    result.record("warmup_primes_root_prefix_both_routes", test_warmup_primes_the_root_static_prefix_on_both_routes)
    result.record("warmup_does_not_mask_run_specific_prefix", test_warmup_does_not_mask_a_run_specific_static_prefix)
    result.record("warmup_recorded_apart_from_share", test_warmup_is_recorded_apart_from_the_measured_share)
    result.record("cache_route_recorded", test_cache_route_is_recorded_from_the_served_model)
    result.record("gpt_floor_uniform_rule", test_gpt_route_floor_is_derived_by_one_rule_from_measured_history)
    result.record("gpt_run_24_derived_floor", test_gpt_route_run_at_24_percent_passes_only_under_the_derived_floor)
    result.record("missing_route_fails_closed", test_missing_route_telemetry_fails_closed)
    result.record(
        "claude_code_cache_ratchet_deploy_warn_only",
        test_claude_code_cache_ratchet_is_deploy_warn_only_when_enabled,
    )
    await result.record_async(
        "collector_identity_separates_agents",
        test_collector_identity_is_authoritative_and_separates_agents,
    )
    await result.record_async(
        "partial_tree_collection_fails",
        test_partial_tree_usage_collection_fails_loudly,
    )
    await result.record_async(
        "usage_non_200_fails",
        test_usage_endpoint_non_200_is_not_an_empty_success,
    )
    result.record(
        "prompt_cache_floors_match_policy",
        test_prompt_cache_floors_match_deploy_policy,
    )
    return result.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
