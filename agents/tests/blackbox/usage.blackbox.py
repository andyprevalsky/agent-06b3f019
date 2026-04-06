"""Blackbox tests for usage domain."""

import asyncio

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    teardown_mock,
)


def test_llm_usage():
    """llm_usage creates correct dict structure with all fields."""
    from helpers.usage import llm_usage

    result = llm_usage(tokens_in=100, tokens_out=50, model="rose-ultra", provider="Rose Planner")

    assert result["tokens_in"] == 100
    assert result["tokens_out"] == 50
    assert result["model"] == "rose-ultra"
    assert result["provider"] == "Rose Planner"


def test_llm_usage_defaults():
    """llm_usage with only required args has None defaults."""
    from helpers.usage import llm_usage

    result = llm_usage(tokens_in=200, tokens_out=75)

    assert result["tokens_in"] == 200
    assert result["tokens_out"] == 75
    assert result["model"] is None
    assert result["provider"] is None


def test_service_usage():
    """service_usage creates correct dict structure."""
    from helpers.usage import service_usage

    result = service_usage(cost_cents=5, provider="Perplexity Search")

    assert result["cost_cents"] == 5
    assert result["provider"] == "Perplexity Search"


def test_make_usage():
    """make_usage combines llm and service lists."""
    from helpers.usage import llm_usage, service_usage, make_usage

    llm_items = [llm_usage(tokens_in=100, tokens_out=50)]
    svc_items = [service_usage(cost_cents=5, provider="Steel")]

    result = make_usage(llm=llm_items, service=svc_items)

    assert len(result["llm"]) == 1
    assert len(result["service"]) == 1
    assert result["llm"][0]["tokens_in"] == 100
    assert result["service"][0]["cost_cents"] == 5


def test_make_usage_defaults():
    """make_usage with no args returns empty lists."""
    from helpers.usage import make_usage

    result = make_usage()

    assert result["llm"] == []
    assert result["service"] == []


def test_with_usage():
    """with_usage wraps result dict with usage key."""
    from helpers.usage import llm_usage, with_usage

    result = with_usage(
        result={"success": True, "data": "hello"},
        llm=[llm_usage(tokens_in=100, tokens_out=50, model="rose-ultra")],
    )

    assert result["result"]["success"] is True
    assert result["result"]["data"] == "hello"
    assert len(result["usage"]["llm"]) == 1
    assert result["usage"]["service"] == []


async def run_all_tests():
    print("usage blackbox tests:")
    r = BlackboxResult()
    r.record("llm_usage", test_llm_usage)
    r.record("llm_usage_defaults", test_llm_usage_defaults)
    r.record("service_usage", test_service_usage)
    r.record("make_usage", test_make_usage)
    r.record("make_usage_defaults", test_make_usage_defaults)
    r.record("with_usage", test_with_usage)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
