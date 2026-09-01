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
    CHALLENGE_LLM_SYSTEM_PROMPT,
    format_network_summary_lines,
    recovery_soft_block_still_present,
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
                "response_body": (
                    '{"errors":[{"message":"Provisioned request rate has been exceeded"}]}'
                ),
                "response_body_truncated": False,
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
    assert "status=429" in summary
    assert "response_body" in summary
    assert "Provisioned request rate" in summary


async def test_perf_only_entries_still_format_without_status():
    """Entries without status remain printable (Progressive enhancement)."""
    summary = await capture_network_summary(_PerfOnlyPage())
    assert "https://www.hotels.com/graphql" in summary
    assert "286ms" in summary


async def test_truncated_response_body_is_labeled():
    long_body = "X" * 500
    summary = format_network_summary_lines(
        [
            {
                "url": "https://www.hotels.com/graphql",
                "status": 429,
                "status_text": "Too Many Requests",
                "duration_ms": 100,
                "size_bytes": 50,
                "response_body": long_body,
                "response_body_truncated": True,
            }
        ]
    )
    assert "response_body (truncated):" in summary
    assert long_body not in summary
    assert "X" * 200 in summary


def test_classifier_messages_include_network_block_and_recovery_reason():
    msgs = build_challenge_classifier_messages(
        {
            "url": "https://www.hotels.com/ho129640/",
            "title": "Hotel Kabuki",
            "status": 200,
            "cleaned_dom": "<div id=Offers>Loading</div>",
            "network_summary": (
                "status=429 Too Many Requests 286ms 108B https://www.hotels.com/graphql\n"
                "  response_body (truncated): Provisioned request rate has been exceeded"
            ),
            "screenshot_base64_png": None,
            "recovery_reason": "GraphQL 429 / Offers Loading on hotels.com property page",
        }
    )
    user = next(m for m in msgs if m.get("role") == "user")
    text = user["content"][0]["text"] if isinstance(user["content"], list) else user["content"]
    assert "status=429" in text or "429" in text
    assert "Network metadata" in text
    assert "CRITICAL recovery constraint" in text
    assert "Offers Loading" in text
    assert "truncated" in text.lower()
    assert "DOM tree" in text


def test_soft_block_gate_forces_challenged_when_429_remains():
    assert recovery_soft_block_still_present(
        "status=429 Too Many Requests https://www.hotels.com/graphql",
        "repeated GraphQL 429 / Offers still Loading",
    )
    assert not recovery_soft_block_still_present(
        "status=200 120ms https://www.hotels.com/graphql",
        "repeated GraphQL 429 / Offers still Loading",
    )


def test_classifier_prompt_and_messages_force_network_check_for_cited_blocked_resource():
    """23:40 failure mode: screenshot looked fine while js.stripe.com stayed blocked.

    No deterministic regex hard-gate — the LLM must be instructed hard enough that
    a painted product UI cannot clear a recovery reason citing a blocked third-party.
    """
    reason = (
        "Checkout payment widget never mounted.\n"
        "Blocked third-party resource that must become reachable/usable: "
        "https://js.stripe.com/v3/"
    )
    assert "screenshot looks like the real product site" in CHALLENGE_LLM_SYSTEM_PROMPT.lower() or (
        "screenshot appearance alone never" in CHALLENGE_LLM_SYSTEM_PROMPT.lower()
    )
    assert "blocked third-party" in CHALLENGE_LLM_SYSTEM_PROMPT.lower()
    assert "Evidence priority" in CHALLENGE_LLM_SYSTEM_PROMPT or "Evidence priority" in CHALLENGE_LLM_SYSTEM_PROMPT

    msgs = build_challenge_classifier_messages(
        {
            "url": "https://www.doordash.com/checkout",
            "title": "DoorDash",
            "status": 200,
            "cleaned_dom": "Checkout  Subtotal  Place Order",
            "network_summary": "status=200 80ms https://www.doordash.com/graphql",
            "screenshot_base64_png": None,
            "recovery_reason": reason,
        }
    )
    system = next(m for m in msgs if m.get("role") == "system")["content"]
    user = next(m for m in msgs if m.get("role") == "user")
    text = user["content"][0]["text"] if isinstance(user["content"], list) else user["content"]
    assert "CRITICAL recovery constraint" in text
    assert "https://js.stripe.com/v3/" in text
    assert "even when the screenshot looks like" in text.lower() or "even when the screenshot" in text.lower()
    assert "screenshot alone cannot clear" in text.lower() or "visual context only" in text.lower()
    assert "network metadata" in text.lower()
    # System prompt must override screenshot-as-ground-truth overweighting.
    assert "do not return challenged=false just because the screenshot" in system.lower()



async def test_network_entries_override_prefers_explicit_status_rows():
    summary = await capture_network_summary(
        _PerfOnlyPage(),
        network_entries=[
            {
                "url": "https://www.hotels.com/graphql",
                "status": 429,
                "status_text": "Too Many Requests",
                "duration_ms": 50,
                "size_bytes": 108,
                "response_body": '{"message":"Provisioned request rate has been exceeded"}',
            }
        ],
    )
    assert "status=429" in summary
    assert "Provisioned request rate" in summary


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
    await result.record_async(
        "truncated_response_body_is_labeled",
        test_truncated_response_body_is_labeled,
    )
    result.record(
        "classifier_messages_include_network_block_and_recovery_reason",
        test_classifier_messages_include_network_block_and_recovery_reason,
    )
    result.record(
        "soft_block_gate_forces_challenged_when_429_remains",
        test_soft_block_gate_forces_challenged_when_429_remains,
    )
    result.record(
        "classifier_prompt_and_messages_force_network_check_for_cited_blocked_resource",
        test_classifier_prompt_and_messages_force_network_check_for_cited_blocked_resource,
    )
    await result.record_async(
        "network_entries_override_prefers_explicit_status_rows",
        test_network_entries_override_prefers_explicit_status_rows,
    )
    return result.all_passed


if __name__ == "__main__":
    raise SystemExit(0 if asyncio.run(run_all_tests()) else 1)
