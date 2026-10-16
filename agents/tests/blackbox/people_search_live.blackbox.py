"""Opt-in live Lantern test through the actual tool activity and HTTP adapter."""

import asyncio
import json
import os
from pathlib import Path
from unittest.mock import patch

from _test_utils import BlackboxResult, get_captured_requests, teardown_mock


async def test_live_lantern_discovery_and_exact_profile():
    from tools.people_search.handler import people_search_activity
    from tools.people_search.repo import fetch_lantern_people

    responses = []

    async def capture_response(**kwargs):
        try:
            data = await fetch_lantern_people(**kwargs)
        except Exception as error:
            responses.append({"error": str(error), "details": getattr(error, "details", ())})
            raise
        responses.append(data)
        return data

    teardown_mock()
    user_id = os.getenv("PEOPLE_SEARCH_LIVE_USER_ID")
    with (
        patch("temporalio.activity.heartbeat"),
        patch("tools.people_search.service.fetch_lantern_people", side_effect=capture_response),
    ):
        try:
            discovered = await people_search_activity(
                query="engineer",
                mode="discover",
                provider="lantern",
                limit=2,
                search_options={"titles": ["Software Engineer"]},
                user_id=user_id,
            )
        finally:
            evidence = os.getenv("PEOPLE_SEARCH_LIVE_RESPONSE_FILE")
            if evidence:
                Path(evidence).write_text(json.dumps(responses))
        assert discovered["provider_used"] == "lantern"
        assert discovered["providers_attempted"] == ["lantern"]
        assert 1 <= len(discovered["results"]) <= 2
        person = discovered["results"][0]
        assert person["name"] and person["profile_url"]
        assert person["source"]["record_id"]
        options = {"sourceRecordId": person["source"]["record_id"]}
        if discovered.get("generation"):
            options["generation"] = discovered["generation"]
        try:
            enriched = await people_search_activity(
                query=person["name"],
                mode="enrich",
                provider="lantern",
                fields=["current_title", "current_company", "linkedin_url"],
                search_options=options,
                user_id=user_id,
            )
        finally:
            if evidence:
                Path(evidence).write_text(json.dumps(responses))
        assert len(enriched["results"]) == 1
        assert enriched["results"][0]["source"]["record_id"] == person["source"]["record_id"]
        assert set(enriched["results"][0]["attributes"]) == {"current_title", "current_company", "linkedin_url"}
        assert all(
            "people.lantern.md/v1/operations/" in call["url"]
            or "/api/integrations/lantern-people/credentials/token" in call["url"]
            for call in get_captured_requests()
        )
    print(f"    Lantern discovery: {len(discovered['results'])} profiles; exact profile retrieval passed.")


async def run_all_tests():
    if os.getenv("PEOPLE_SEARCH_LIVE") != "1":
        print("people-search LIVE skipped (set PEOPLE_SEARCH_LIVE=1).")
        return True
    result = BlackboxResult()
    await result.record_async("lantern_discovery_and_exact_profile", test_live_lantern_discovery_and_exact_profile)
    teardown_mock()
    return result.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
