#!/usr/bin/env python3
"""Blackbox tests for read_logs using production browser diagnostic captures."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _test_utils import BlackboxResult
from domains.spawn_browser_agent_v3.recording import BrowserNetworkRecorder
from domains.spawn_browser_agent_v3.service_actions import execute_action

FIXTURE_ROOT = (
    Path(__file__).resolve().parents[1]
    / "fixtures"
    / "browser_diagnostics"
    / "aba4c297_hotel_kabuki_429"
)
NETWORK_INDEX = FIXTURE_ROOT / "network" / "index.json"
CONSOLE_INDEX = FIXTURE_ROOT / "console" / "index.json"

FIXTURE_ROOT = (
    Path(__file__).resolve().parents[1]
    / "fixtures"
    / "browser_diagnostics"
    / "aba4c297_hotel_kabuki_429"
)
NETWORK_INDEX = FIXTURE_ROOT / "network" / "index.json"
CONSOLE_INDEX = FIXTURE_ROOT / "console" / "index.json"


def _load_fixture_recorder() -> BrowserNetworkRecorder:
    assert NETWORK_INDEX.is_file(), f"missing production network fixture: {NETWORK_INDEX}"
    assert CONSOLE_INDEX.is_file(), f"missing production console fixture: {CONSOLE_INDEX}"
    return BrowserNetworkRecorder.from_diagnostic_indexes(
        network_index_path=NETWORK_INDEX,
        console_index_path=CONSOLE_INDEX,
    )


def test_production_fixture_console_has_apollo_429_errors():
    payload = json.loads(CONSOLE_INDEX.read_text(encoding="utf-8"))
    entries = payload.get("entries") or []
    apollo_429 = [
        entry
        for entry in entries
        if isinstance(entry, dict)
        and "ApolloError" in str(entry.get("text") or "")
        and "429" in str(entry.get("text") or "")
    ]
    assert len(apollo_429) >= 100, f"expected many Apollo 429 console lines, got {len(apollo_429)}"


def test_production_fixture_network_has_prepare_checkout_graphql():
    payload = json.loads(NETWORK_INDEX.read_text(encoding="utf-8"))
    entries = payload.get("entries") or []
    graphql = [
        entry
        for entry in entries
        if isinstance(entry, dict) and "graphql" in str(entry.get("url") or "").lower()
    ]
    assert len(graphql) == 6, f"expected 6 graphql rows from prod capture, got {len(graphql)}"
    assert all(entry.get("status") is None for entry in graphql), (
        "fixture should preserve missing CDP response status from prod"
    )


def test_read_logs_regex_finds_rate_limit_console_lines():
    recorder = _load_fixture_recorder()
    logs = recorder.query_logs(pattern=r"ApolloError.*429", limit=500)
    assert len(logs) >= 100
    assert all(row["source"] == "console" for row in logs)
    assert all("429" in row["text"] for row in logs)


def test_read_logs_enriches_graphql_network_status_from_console():
    recorder = _load_fixture_recorder()
    logs = recorder.query_logs(
        pattern=r"graphql",
        sources=["network"],
        status="error",
        limit=20,
    )
    assert len(logs) >= 1
    assert all(row["source"] == "network" for row in logs)
    assert all(row.get("status") == 429 for row in logs)
    assert all(row.get("status_source") == "console" for row in logs)


def test_read_logs_combined_sources_match_bot_or_not_or_429():
    recorder = _load_fixture_recorder()
    logs = recorder.query_logs(pattern=r"429|botOrNot|ApolloError", limit=50)
    assert len(logs) == 50
    sources = {row["source"] for row in logs}
    assert "console" in sources


async def test_read_logs_invalid_regex_returns_error_from_action_layer():
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    recorder = MagicMock()
    recorder.query_logs = MagicMock(side_effect=ValueError("Invalid regex pattern: unbalanced parenthesis"))

    out = await execute_action(
        dom,
        ah,
        {"action": "read_logs", "params": {"pattern": "(unclosed"}},
        browser_network_recorder=recorder,
    )
    assert out["success"] is False
    assert "Invalid regex" in out["error"]


async def test_read_logs_action_success_message():
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    recorder = MagicMock()
    recorder.query_logs = MagicMock(
        return_value=[
            {
                "source": "console",
                "level": "error",
                "text": "ApolloError: Response not successful: Received status code 429",
                "url": "https://www.hotels.com/ho129640/example",
            }
        ]
    )

    out = await execute_action(
        dom,
        ah,
        {"action": "read_logs", "params": {"pattern": "429"}},
        browser_network_recorder=recorder,
    )
    assert out["success"] is True
    assert out["logs"][0]["text"].startswith("ApolloError")
    assert "Matched 1 log line" in out["message"]
    recorder.query_logs.assert_called_once()
    assert recorder.query_logs.call_args.kwargs["pattern"] == "429"


async def run_all_tests() -> bool:
    r = BlackboxResult()
    r.record("production_console_apollo_429", test_production_fixture_console_has_apollo_429_errors)
    r.record("production_network_prepare_checkout", test_production_fixture_network_has_prepare_checkout_graphql)
    r.record("read_logs_regex_console_429", test_read_logs_regex_finds_rate_limit_console_lines)
    r.record("read_logs_enriches_graphql_status", test_read_logs_enriches_graphql_network_status_from_console)
    r.record("read_logs_combined_regex", test_read_logs_combined_sources_match_bot_or_not_or_429)
    await r.record_async("read_logs_invalid_regex", test_read_logs_invalid_regex_returns_error_from_action_layer)
    await r.record_async("read_logs_action_message", test_read_logs_action_success_message)
    return r.all_passed


if __name__ == "__main__":
    raise SystemExit(0 if asyncio.run(run_all_tests()) else 1)
