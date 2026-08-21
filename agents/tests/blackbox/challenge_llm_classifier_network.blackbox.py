"""Owning-boundary: challenge classifier must see HTTP soft-block statuses.

Hotels.com browser-hotel-booking (agent 2da69edc): recover_from_challenge was
called for GraphQL HTTP 429 / Offers Loading. Cookie + config probes used
``challenge_llm_classifier``, whose network summary is Performance Resource
Timing only (name/duration/transferSize) — no HTTP status — so the classifier
returned challenged=false while /graphql still 429'd. Recovery then reported
success (cookies_sanitized, then kernel_isp) without clearing the soft-block.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _test_utils import BlackboxResult
from domains.spawn_browser_agent_v3.challenge_llm_classifier import (
    build_challenge_classifier_messages,
    capture_network_summary,
)


class _PerfOnlyPage:
    """Mirrors Production Performance Resource Timing for a 429 GraphQL call."""

    async def evaluate(self, _script, _cap):
        return [
            {
                "name": "https://www.hotels.com/graphql",
                "durationMs": 286,
                "transferSize": 108,
            }
        ]


class _StatusAwarePage:
    """CDP-/recorder-backed page that can report failed fetch status codes."""

    async def evaluate(self, _script, _cap):
        return [
            {
                "name": "https://www.hotels.com/graphql",
                "durationMs": 286,
                "transferSize": 108,
                "status": 429,
                "statusText": "Too Many Requests",
            }
        ]


async def test_network_summary_surfaces_graphql_http_429():
    """Classifier network summary must mention HTTP 429 for failed /graphql.

    Pre-fix (Performance-only capture): summary is like
    ``286ms 108B https://www.hotels.com/graphql`` with no status → assert fails.
    Post-fix: capture includes status from CDP/network recorder when present.
    """
    summary = await capture_network_summary(_StatusAwarePage())
    assert "429" in summary or "Too Many Requests" in summary, (
        "challenge classifier network summary must surface GraphQL HTTP 429 "
        f"soft-blocks; got: {summary!r}"
    )


async def test_perf_only_entries_still_format_without_status():
    """Entries without status remain printable (Progressive enhancement)."""
    summary = await capture_network_summary(_PerfOnlyPage())
    assert "https://www.hotels.com/graphql" in summary
    assert "286ms" in summary


def test_classifier_messages_include_network_block():
    msgs = build_challenge_classifier_messages(
        {
            "url": "https://www.hotels.com/ho129640/",
            "title": "Hotel Kabuki",
            "status": 200,
            "cleaned_dom": "<div id=Offers>Loading</div>",
            "network_summary": "286ms 108B status=429 https://www.hotels.com/graphql",
            "screenshot_base64_png": None,
        }
    )
    user = next(m for m in msgs if m.get("role") == "user")
    text = user["content"][0]["text"] if isinstance(user["content"], list) else user["content"]
    assert "status=429" in text or "429" in text
    assert "Network metadata" in text


async def run_all_tests() -> bool:
    print("challenge-llm-classifier-network blackbox tests:")
    result = BlackboxResult()
    await result.record_async(
        "network_summary_surfaces_graphql_http_429",
        test_network_summary_surfaces_graphql_http_429,
    )
    await result.record_async(
        "perf_only_entries_still_format_without_status",
        test_perf_only_entries_still_format_without_status,
    )
    result.record(
        "classifier_messages_include_network_block",
        test_classifier_messages_include_network_block,
    )
    return result.all_passed


if __name__ == "__main__":
    raise SystemExit(0 if asyncio.run(run_all_tests()) else 1)
