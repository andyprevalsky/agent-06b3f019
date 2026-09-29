#!/usr/bin/env python3
"""Cross-language contract for helpers.context_scope (shared/context-scope/fixtures.json)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_PATH = REPO_ROOT / "shared" / "context-scope" / "fixtures.json"

from helpers.context_scope import (  # noqa: E402
    filter_internal_subagent_messages,
    is_internal_subagent_message,
)


def test_shared_fixtures() -> None:
    fixtures = json.loads(FIXTURE_PATH.read_text())
    assert fixtures["contract_version"] == 1
    assert len(fixtures["cases"]) >= 6

    for case in fixtures["cases"]:
        message = case["message"]
        actual = is_internal_subagent_message(message)
        assert actual is case["is_internal"], (
            f"{case['name']}: expected is_internal={case['is_internal']}, got {actual}"
        )

    messages = [case["message"] for case in fixtures["cases"]]
    filtered = filter_internal_subagent_messages(messages)
    kept_names = {
        case["name"]
        for case in fixtures["cases"]
        if case["message"] in filtered
    }
    assert "parent_spawn_finished_result_kept" in kept_names
    assert "general_purpose_aggregate_unsuffixed_toolCallId_kept" in kept_names
    assert "explore_web_fetch_with_subAgentId_dropped" not in kept_names
    assert "foreach_child_producer_marked_dropped" not in kept_names
    assert "foreach_child_historical_suffixed_dropped" not in kept_names
    assert "provider_numeric_suffixed_toolCallId_kept" in kept_names


async def run_all_tests() -> dict:
    tests = [test_shared_fixtures]
    passed = 0
    failed = 0
    for test in tests:
        name = test.__name__
        try:
            test()
            print(f"  PASS {name}")
            passed += 1
        except Exception as exc:
            print(f"  FAIL {name}: {exc}")
            failed += 1
    return {"passed": passed, "failed": failed}


if __name__ == "__main__":
    import asyncio

    result = asyncio.run(run_all_tests())
    if result["failed"]:
        sys.exit(1)
    print("PASS context_scope shared fixtures (parent spawn kept, subAgentId dropped)")
