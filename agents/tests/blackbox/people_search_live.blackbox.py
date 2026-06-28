"""LIVE integration tests for people-search — hits real Exa + Parallel.

Gated by PEOPLE_SEARCH_LIVE=1 so normal/CI runs skip it (no spend, no flake).
Exercises the full code path (people_search_activity -> service -> repo ->
real provider HTTP -> normalization) across the (mode x provider) matrix plus
fields/limit variations. Requires EXA_API_KEY and PARRALLEL_API_KEY in .env.

Run:
    PEOPLE_SEARCH_LIVE=1 python scripts/run_blackbox_tests.py people-search-live
"""

import asyncio
import os
from unittest.mock import patch

from _test_utils import BlackboxResult, teardown_mock

LIVE = os.environ.get("PEOPLE_SEARCH_LIVE") == "1"

# Stable queries that should reliably return real people.
ENRICH_QUERY = "Patrick Collison, co-founder and CEO of Stripe"
DISCOVER_QUERY = "partners at venture capital firms that invest in AI infrastructure startups in San Francisco"
ENRICH_FIELDS = ["current_title", "current_company", "location", "linkedin_url"]


def _assert_envelope(result: dict, mode: str, provider: str):
    assert result["mode_used"] == mode, result
    assert result["provider_used"] in ("exa", "parallel"), result
    assert provider in result["providers_attempted"], result
    assert isinstance(result["results"], list), result
    assert isinstance(result["warnings"], list), result


async def _run(query, mode, provider, **kw):
    # Ensure no mock handler is active so real HTTP flows.
    teardown_mock()
    with patch("temporalio.activity.heartbeat"):
        from tools.people_search.handler import people_search_activity

        return await people_search_activity(query=query, mode=mode, provider=provider, **kw)


# -------------------- discover --------------------


async def test_live_discover_exa():
    r = await _run(DISCOVER_QUERY, "discover", "exa", limit=5)
    _assert_envelope(r, "discover", "exa")
    assert len(r["results"]) >= 1, f"expected >=1 result, got {r}"
    assert any(p.get("name") or p.get("profile_url") for p in r["results"])
    print(f"    discover/exa -> {len(r['results'])} results, used={r['provider_used']}")


async def test_live_discover_parallel():
    r = await _run(DISCOVER_QUERY, "discover", "parallel", limit=5)
    _assert_envelope(r, "discover", "parallel")
    assert len(r["results"]) >= 1, f"expected >=1 result, got {r}"
    assert all(p["source"]["provider"] in ("parallel", "exa") for p in r["results"])
    print(f"    discover/parallel -> {len(r['results'])} results, used={r['provider_used']}")


async def test_live_discover_exa_default_limit():
    r = await _run(DISCOVER_QUERY, "discover", "exa")  # no limit -> default 10
    _assert_envelope(r, "discover", "exa")
    assert len(r["results"]) <= 10
    print(f"    discover/exa default-limit -> {len(r['results'])} results")


# -------------------- enrich --------------------


async def test_live_enrich_exa_with_fields():
    r = await _run(ENRICH_QUERY, "enrich", "exa", fields=ENRICH_FIELDS)
    _assert_envelope(r, "enrich", "exa")
    assert len(r["results"]) <= 1
    if r["results"]:
        p = r["results"][0]
        assert set(p["attributes"].keys()) == set(ENRICH_FIELDS), p["attributes"]
        print(f"    enrich/exa -> {p.get('name')} | attrs={p['attributes']}")
    else:
        print("    enrich/exa -> no result (live data)")


async def test_live_enrich_exa_no_fields():
    r = await _run(ENRICH_QUERY, "enrich", "exa")  # native profile, no field list
    _assert_envelope(r, "enrich", "exa")
    assert len(r["results"]) <= 1
    if r["results"]:
        p = r["results"][0]
        assert "attributes" not in p  # no fields requested
        print(f"    enrich/exa no-fields -> {p.get('name')} | title={p.get('title')} co={p.get('company')}")


async def test_live_enrich_parallel_best_effort():
    r = await _run(ENRICH_QUERY, "enrich", "parallel", fields=["current_title", "email"])
    _assert_envelope(r, "enrich", "parallel")
    assert len(r["results"]) <= 1
    # Parallel Entity Search can't field-enrich; expect a limited-fields warning.
    if r["results"]:
        assert any("limited fields" in w for w in r["warnings"]), r["warnings"]
        print(f"    enrich/parallel -> {r['results'][0].get('name')} | warnings ok")


async def run_all_tests():
    print("people-search LIVE blackbox tests:")
    if not LIVE:
        print("  ⏭  skipped (set PEOPLE_SEARCH_LIVE=1 to run live provider tests)")
        return True
    r = BlackboxResult()
    await r.record_async("discover/exa", test_live_discover_exa)
    await r.record_async("discover/parallel", test_live_discover_parallel)
    await r.record_async("discover/exa default-limit", test_live_discover_exa_default_limit)
    await r.record_async("enrich/exa +fields", test_live_enrich_exa_with_fields)
    await r.record_async("enrich/exa no-fields", test_live_enrich_exa_no_fields)
    await r.record_async("enrich/parallel best-effort", test_live_enrich_parallel_best_effort)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
