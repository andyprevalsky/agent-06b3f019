"""Blackbox tests for people-search domain (enrich/discover x exa/parallel)."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import patch

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    get_captured_requests,
    setup_mock,
    teardown_mock,
)

EXA_URL = "api.exa.ai/search"
PARALLEL_URL = "api.parallel.ai/v1beta/findall/entity-search"


def _fake_config(exa_key: str = "exa-test-key", parallel_key: str = "parallel-test-key"):
    return SimpleNamespace(
        exa=SimpleNamespace(api_key=exa_key),
        parallel=SimpleNamespace(api_key=parallel_key),
    )


def _exa_results(n: int = 1):
    return [
        {
            "title": f"Person {i}",
            "url": f"https://exa.example.com/{i}",
            "highlights": [f"highlight {i}"],
            "entities": [
                {
                    "type": "person",
                    "properties": {
                        "name": f"Jane Doe {i}",
                        "location": "Berlin",
                        "workHistory": [{"title": "VP Engineering", "company": {"name": "Acme"}}],
                        "educationHistory": [{"degree": "BSc", "institution": {"name": "MIT"}}],
                    },
                }
            ],
        }
        for i in range(n)
    ]


def _parallel_entities(n: int = 5):
    return [
        {"name": f"Person {i}", "url": f"https://parallel.example.com/{i}", "description": f"Leader {i}"}
        for i in range(n)
    ]


def _setup_exa(n: int = 1):
    setup_mock({EXA_URL: {"status": 200, "json": {"results": _exa_results(n)}}})


def _setup_parallel(n: int = 5):
    setup_mock({PARALLEL_URL: {"status": 200, "json": {"entity_set_id": "s1", "entities": _parallel_entities(n)}}})


def test_types_contracts_are_importable():
    """Public people-search result contracts stay importable for tool callers."""
    from tools.people_search.types import (
        ExecuteActivityCallable,
        PeopleSearchResult,
        PersonResult,
        PersonSource,
    )

    assert ExecuteActivityCallable is not None
    assert "provider" in PersonSource.__annotations__
    assert "source" in PersonResult.__annotations__
    assert "providers_attempted" in PeopleSearchResult.__annotations__


# -------------------- schema validation --------------------


async def test_schema_strict_pairing():
    """limit only valid for discover; fields only valid for enrich."""
    from utils.tool_schemas import PeopleSearchTool

    # valid
    PeopleSearchTool(tool="people_search", query="q", mode="discover", provider="parallel", limit=5)
    PeopleSearchTool(tool="people_search", query="q", mode="enrich", provider="exa", fields=["current_title"])

    for kwargs, bad in [
        ({"mode": "enrich", "provider": "exa", "limit": 5}, "limit"),
        ({"mode": "discover", "provider": "exa", "fields": ["x"]}, "fields"),
    ]:
        try:
            PeopleSearchTool(tool="people_search", query="q", **kwargs)
            raise AssertionError(f"Expected validation error for {bad}")
        except Exception as e:  # pydantic ValidationError
            assert bad in str(e)


async def test_limit_clamp_discover():
    from tools.people_search.service import clamp_discover_limit

    assert clamp_discover_limit(None) == 10
    assert clamp_discover_limit(0) == 1
    assert clamp_discover_limit(100) == 25
    assert clamp_discover_limit(7) == 7
    assert clamp_discover_limit("bad") == 10


# -------------------- request shapes --------------------


async def test_exa_discover_request_shape():
    _setup_exa(3)
    with patch("temporalio.activity.heartbeat"):
        with patch("tools.people_search.service.load_config", return_value=_fake_config()):
            from tools.people_search.handler import people_search_activity

            await people_search_activity(query="CTOs in NYC", mode="discover", provider="exa", limit=10)

    call = assert_captured_call(url_contains=EXA_URL, method="POST", header_present="x-api-key")
    body = json.loads(call["requestBody"])
    assert body["category"] == "people"
    assert body["numResults"] == 10
    assert "outputSchema" not in body  # no fields for discover


async def test_parallel_discover_request_shape():
    _setup_parallel(10)
    with patch("temporalio.activity.heartbeat"):
        with patch("tools.people_search.service.load_config", return_value=_fake_config()):
            from tools.people_search.handler import people_search_activity

            await people_search_activity(query="AI investors", mode="discover", provider="parallel", limit=10)

    call = assert_captured_call(url_contains=PARALLEL_URL, method="POST", header_present="x-api-key")
    body = json.loads(call["requestBody"])
    assert body["entity_type"] == "people"
    assert body["objective"] == "AI investors"
    assert body["match_limit"] == 10


async def test_exa_enrich_sends_output_schema_for_fields():
    _setup_exa(1)
    with patch("temporalio.activity.heartbeat"):
        with patch("tools.people_search.service.load_config", return_value=_fake_config()):
            from tools.people_search.handler import people_search_activity

            await people_search_activity(
                query="Patrick Collison, Stripe",
                mode="enrich",
                provider="exa",
                fields=["current_title", "current_company", "location"],
            )

    call = assert_captured_call(url_contains=EXA_URL, method="POST")
    body = json.loads(call["requestBody"])
    assert "outputSchema" in body
    assert set(body["outputSchema"]["properties"].keys()) == {"current_title", "current_company", "location"}


async def test_parallel_discover_min_then_trim():
    _setup_parallel(5)
    with patch("temporalio.activity.heartbeat"):
        with patch("tools.people_search.service.load_config", return_value=_fake_config()):
            from tools.people_search.handler import people_search_activity

            result = await people_search_activity(query="founders", mode="discover", provider="parallel", limit=2)

    call = assert_captured_call(url_contains=PARALLEL_URL, method="POST")
    assert json.loads(call["requestBody"])["match_limit"] == 5
    assert len(result["results"]) == 2


# -------------------- normalization --------------------


async def test_exa_enrich_attributes():
    _setup_exa(1)
    with patch("temporalio.activity.heartbeat"):
        with patch("tools.people_search.service.load_config", return_value=_fake_config()):
            from tools.people_search.handler import people_search_activity

            result = await people_search_activity(
                query="Jane Doe",
                mode="enrich",
                provider="exa",
                fields=["current_title", "current_company", "location", "education"],
            )

    assert result["mode_used"] == "enrich"
    assert result["provider_used"] == "exa"
    assert len(result["results"]) == 1
    attrs = result["results"][0]["attributes"]
    assert attrs["current_title"] == "VP Engineering"
    assert attrs["current_company"] == "Acme"
    assert attrs["location"] == "Berlin"
    assert attrs["education"] == ["BSc MIT"]
    assert result["results"][0]["confidence"] == "high"


async def test_exa_enrich_linkedin_url_derived_from_profile_url():
    """linkedin_url is filled from the result URL when it's a linkedin.com profile."""
    results = _exa_results(1)
    results[0]["url"] = "https://www.linkedin.com/in/janedoe0"
    setup_mock({EXA_URL: {"status": 200, "json": {"results": results}}})
    with patch("temporalio.activity.heartbeat"):
        with patch("tools.people_search.service.load_config", return_value=_fake_config()):
            from tools.people_search.handler import people_search_activity

            result = await people_search_activity(
                query="Jane Doe", mode="enrich", provider="exa", fields=["linkedin_url", "email"]
            )

    attrs = result["results"][0]["attributes"]
    assert attrs["linkedin_url"] == "https://www.linkedin.com/in/janedoe0"
    assert attrs["email"] is None  # not available from Exa


async def test_exa_discover_normalization():
    _setup_exa(3)
    with patch("temporalio.activity.heartbeat"):
        with patch("tools.people_search.service.load_config", return_value=_fake_config()):
            from tools.people_search.handler import people_search_activity

            result = await people_search_activity(query="VPs", mode="discover", provider="exa", limit=3)

    assert len(result["results"]) == 3
    p = result["results"][0]
    assert p["title"] == "VP Engineering"
    assert p["company"] == "Acme"
    assert "attributes" not in p  # discover has no attributes


async def test_parallel_enrich_warns_limited_fields():
    _setup_parallel(5)
    with patch("temporalio.activity.heartbeat"):
        with patch("tools.people_search.service.load_config", return_value=_fake_config()):
            from tools.people_search.handler import people_search_activity

            result = await people_search_activity(
                query="some person", mode="enrich", provider="parallel", fields=["current_title", "email"]
            )

    assert result["provider_used"] == "parallel"
    assert len(result["results"]) == 1
    assert any("limited fields" in w for w in result["warnings"])
    attrs = result["results"][0]["attributes"]
    assert attrs["current_title"] is None  # not available from Entity Search


# -------------------- fallback --------------------


async def test_auto_fallback_on_error():
    """Exa 500 -> auto-retry parallel; providers_attempted shows both."""
    def handler(request):
        import httpx

        url = str(request.url)
        if EXA_URL in url:
            return httpx.Response(500, json={"error": "boom"})
        if PARALLEL_URL in url:
            return httpx.Response(200, json={"entities": _parallel_entities(3)})
        return httpx.Response(404, json={})

    from _test_utils import setup_mock_fn

    setup_mock_fn(handler)
    with patch("temporalio.activity.heartbeat"):
        with patch("tools.people_search.service.load_config", return_value=_fake_config()):
            from tools.people_search.handler import people_search_activity

            result = await people_search_activity(query="people", mode="discover", provider="exa", limit=5)

    assert result["providers_attempted"] == ["exa", "parallel"]
    assert result["provider_used"] == "parallel"
    assert len(result["results"]) == 3
    assert any("fell back" in w for w in result["warnings"])


async def test_no_fallback_on_empty_results():
    """Empty (non-error) results do NOT trigger fallback; model handles re-call."""
    setup_mock({EXA_URL: {"status": 200, "json": {"results": []}}})
    with patch("temporalio.activity.heartbeat"):
        with patch("tools.people_search.service.load_config", return_value=_fake_config()):
            from tools.people_search.handler import people_search_activity

            result = await people_search_activity(query="nobody", mode="discover", provider="exa", limit=5)

    assert result["results"] == []
    assert result["providers_attempted"] == ["exa"]
    assert not any(PARALLEL_URL in c["url"] for c in get_captured_requests())


async def test_missing_key_falls_back():
    """Missing primary key falls back to the other provider."""
    _setup_parallel(3)
    with patch("temporalio.activity.heartbeat"):
        with patch(
            "tools.people_search.service.load_config",
            return_value=_fake_config(exa_key="", parallel_key="parallel-test-key"),
        ):
            from tools.people_search.handler import people_search_activity

            result = await people_search_activity(query="people", mode="discover", provider="exa", limit=3)

    assert result["provider_used"] == "parallel"
    assert any("exa API key not configured" in w for w in result["warnings"])


# -------------------- handler / entry point --------------------


def _mock_execute(calls: list, *, result: dict | None = None, raises: bool = False):
    async def mock(activity_fn, *args, **kwargs):
        name = getattr(activity_fn, "__name__", "")
        calls.append({"activity": name, "args": args, "kwargs": kwargs})
        if name == "people_search_activity":
            if raises:
                raise RuntimeError("provider offline")
            return result or {
                "query": "q", "mode_used": "discover", "provider_used": "exa",
                "providers_attempted": ["exa"], "results": [], "warnings": [],
            }
        return None

    return mock


async def test_manager_execute_tool_happy():
    from tools.people_search.handler import PeopleSearchManager

    calls = []
    manager = PeopleSearchManager()
    out = await manager.execute_tool(
        execute_activity=_mock_execute(
            calls,
            result={
                "query": "Jane", "mode_used": "enrich", "provider_used": "exa",
                "providers_attempted": ["exa"], "results": [{"name": "Jane"}], "warnings": [],
            },
        ),
        tool_call={"query": "Jane", "mode": "enrich", "provider": "exa", "fields": ["current_title"]},
        tool_call_id="tc-1",
        agent_id="agent-1",
        user_id="user-1",
    )
    assert out["result"]["provider_used"] == "exa"
    assert out["usage"]["service"][0]["cost_cents"] > 0
    posted = [c for c in calls if c["activity"] == "post_agent_message"]
    assert posted and posted[0]["kwargs"]["args"][3]["title"].startswith("Enriching people")


async def test_manager_execute_tool_raises_on_error():
    from tools.people_search.handler import PeopleSearchManager

    calls = []
    manager = PeopleSearchManager()
    try:
        await manager.execute_tool(
            execute_activity=_mock_execute(calls, raises=True),
            tool_call={"query": "q", "mode": "discover", "provider": "exa"},
            tool_call_id="tc-1",
            agent_id="agent-1",
            user_id="user-1",
        )
        raise AssertionError("Expected RuntimeError")
    except RuntimeError as e:
        assert "provider offline" in str(e)


async def test_people_search_entry_point():
    from tools.people_search.handler import people_search

    calls = []
    out = await people_search(
        execute_activity=_mock_execute(calls),
        tool_call={"query": "q", "mode": "discover", "provider": "parallel"},
        tool_call_id="tc-1",
        agent_id="agent-1",
        user_id="user-1",
    )
    assert "result" in out


async def run_all_tests():
    print("people-search blackbox tests:")
    r = BlackboxResult()
    r.record("types_contracts", test_types_contracts_are_importable)
    await r.record_async("schema_strict_pairing", test_schema_strict_pairing)
    await r.record_async("limit_clamp_discover", test_limit_clamp_discover)
    await r.record_async("exa_discover_request_shape", test_exa_discover_request_shape)
    await r.record_async("parallel_discover_request_shape", test_parallel_discover_request_shape)
    await r.record_async("exa_enrich_sends_output_schema", test_exa_enrich_sends_output_schema_for_fields)
    await r.record_async("parallel_discover_min_then_trim", test_parallel_discover_min_then_trim)
    await r.record_async("exa_enrich_attributes", test_exa_enrich_attributes)
    await r.record_async("exa_enrich_linkedin_url_derived", test_exa_enrich_linkedin_url_derived_from_profile_url)
    await r.record_async("exa_discover_normalization", test_exa_discover_normalization)
    await r.record_async("parallel_enrich_warns_limited_fields", test_parallel_enrich_warns_limited_fields)
    await r.record_async("auto_fallback_on_error", test_auto_fallback_on_error)
    await r.record_async("no_fallback_on_empty_results", test_no_fallback_on_empty_results)
    await r.record_async("missing_key_falls_back", test_missing_key_falls_back)
    await r.record_async("manager_execute_tool_happy", test_manager_execute_tool_happy)
    await r.record_async("manager_execute_tool_raises", test_manager_execute_tool_raises_on_error)
    await r.record_async("people_search_entry_point", test_people_search_entry_point)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
