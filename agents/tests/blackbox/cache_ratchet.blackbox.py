"""Blackbox regressions for benchmark prompt-cache ratchets."""

import asyncio
import inspect

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
]


def test_cache_ratchet_measures_repeatable_call_groups():
    """One-shot verifier calls must not hide healthy within-run prefix reuse."""
    from benchmarks.llm_usage import aggregate_repeatable_cache_usage

    metrics = aggregate_repeatable_cache_usage(FAILING_CLAUDE_CODE_AGENT_USAGE)

    assert metrics == {
        "cache_read_input_tokens": 7936,
        "cache_creation_input_tokens": 8787,
        "cache_hit_pct": 47.5,
    }


def test_different_cache_namespaces_do_not_form_a_repeatable_group():
    """Sibling sequences at one call site are not proof of prefix reuse."""
    from benchmarks.llm_usage import aggregate_repeatable_cache_usage

    metrics = aggregate_repeatable_cache_usage(
        [
            {
                "type": "llm",
                "_benchmark_agent_id": "root",
                "call_site": "execute_loop",
                "cache_sequence_id": "agent:root:task:a:call:execute_loop",
                "model": "gpt-5.6-sol-gpt",
                "cache_read_input_tokens": 10000,
                "cache_creation_input_tokens": 0,
            },
            {
                "type": "llm",
                "_benchmark_agent_id": "root",
                "call_site": "execute_loop",
                "cache_sequence_id": "agent:root:task:b:call:execute_loop",
                "model": "gpt-5.6-sol-gpt",
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0,
            },
        ]
    )

    assert metrics == {
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 0,
        "cache_hit_pct": 0.0,
    }


def test_independent_web_summaries_are_not_repeatable():
    """Nine one-shot page summaries must contribute no repeatable denominator."""
    from benchmarks.llm_usage import aggregate_repeatable_cache_usage

    metrics = aggregate_repeatable_cache_usage(
        [
            {
                "type": "llm",
                "_benchmark_agent_id": "root",
                "call_site": "summarize_web_fetch",
                "cache_sequence_id": f"agent:root:tool:fetch-{index}:call:summarize_web_fetch",
                "model": "gpt-5.6-sol-gpt",
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 1000 + index,
            }
            for index in range(9)
        ]
    )

    assert metrics == {
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 0,
        "cache_hit_pct": 0.0,
    }


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


def test_runner_enforces_repeatable_fields_and_missing_metrics_fail_closed():
    """Overall cache cannot mask a repeatable-cache failure or missing capture."""
    from benchmarks.run_benchmark import enforce_cache_ratchets, main_async

    low_repeatable = _task_result(
        "claude-code-agent",
        cache_read_input_tokens=900,
        cache_creation_input_tokens=100,
        repeatable_cache_read_input_tokens=39,
        repeatable_cache_creation_input_tokens=61,
    )
    missing_repeatable = _task_result(
        "claude-code-agent",
        cache_read_input_tokens=900,
        cache_creation_input_tokens=100,
    )
    at_floor = _task_result(
        "claude-code-agent",
        repeatable_cache_read_input_tokens=40,
        repeatable_cache_creation_input_tokens=60,
    )
    no_genuine_repeat = _task_result(
        "claude-code-agent",
        repeatable_cache_read_input_tokens=0,
        repeatable_cache_creation_input_tokens=0,
    )

    for result in (low_repeatable, missing_repeatable, no_genuine_repeat):
        try:
            enforce_cache_ratchets([result])
            raise AssertionError("positive-floor cache telemetry failed open")
        except SystemExit as exc:
            assert exc.code == 1
    enforce_cache_ratchets([at_floor])
    assert "enforce_cache_ratchets(run.task_results)" in inspect.getsource(main_async)


async def test_collector_identity_is_authoritative_and_separates_agents():
    """Payload identity cannot merge one call from each agent into a fake repeatable group."""
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
        provider_usage, repeatable = await runner.get_llm_usage_details(
            "http://benchmark.invalid",
            "root-agent",
            {"all_agents": [{"agent_id": "root-agent"}, {"agent_id": "child-agent"}]},
        )
    finally:
        runner.get_agent_tool_usage = original

    assert sum(row["calls"] for row in provider_usage.values()) == 2
    assert repeatable == {
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 0,
        "cache_hit_pct": 0.0,
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


def test_repeatable_cache_floors_only_ratchet_up():
    """New denominator calibration tightens every task that cleared its next trigger."""
    from benchmarks.run_benchmark import PER_TASK_CACHE_HIT_RATCHET

    assert PER_TASK_CACHE_HIT_RATCHET == {
        "chat-mode": 0.0,
        "spawn-sub-agents": 25.0,
        "parallel-tool-calls": 30.0,
        "claude-code-agent": 40.0,
        "browser-smoke": 40.0,
    }


async def run_all_tests():
    print("cache ratchet blackbox tests:")
    result = BlackboxResult()
    result.record(
        "repeatable_call_groups",
        test_cache_ratchet_measures_repeatable_call_groups,
    )
    result.record(
        "cache_namespace_separation",
        test_different_cache_namespaces_do_not_form_a_repeatable_group,
    )
    result.record(
        "independent_web_summaries_excluded",
        test_independent_web_summaries_are_not_repeatable,
    )
    result.record(
        "runner_repeatable_fields_fail_closed",
        test_runner_enforces_repeatable_fields_and_missing_metrics_fail_closed,
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
        "repeatable_floors_ratchet_up",
        test_repeatable_cache_floors_only_ratchet_up,
    )
    return result.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
