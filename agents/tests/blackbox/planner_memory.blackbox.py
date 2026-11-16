"""Blackbox tests for planner memory (trajectory RAG over the finalized-run history).

Covers: transcript trimming, PII/credential scrubbing, scoring + cutoff, the
native get_memories fork (shape, position, cache-prefix invariance, waterfall
flattening), the constant declared-only planner toolset, the compressor
contract (prompt line cap, clamped/scrubbed output), real tool roles in the
planner context, and the planner activity wiring (memory on/off/no-hits).
All offline: backend + LLM are mocked.
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any, Optional
from unittest.mock import patch

import httpx

from _test_utils import BlackboxResult, get_captured_requests, setup_mock_fn, teardown_mock

GOAL = "Order a 16oz iced vanilla bean shakerato with oat milk for pickup from Blue Bottle Coffee at the Ferry Building"


def _messages() -> list[dict[str, Any]]:
    call = "call_1"
    return [
        {"id": "m0", "role": "USER", "message": GOAL, "createdAt": "2026-09-03T08:00:00.000Z", "metadata": {}},
        {
            "id": "m1",
            "role": "TOOL",
            "message": "",
            "createdAt": "2026-09-03T08:00:01.000Z",
            "metadata": {"toolName": "agent_init", "toolStatus": "FINISHED", "title": "Initialized"},
        },
        {
            "id": "m2",
            "role": "ASSISTANT",
            "message": "",
            "createdAt": "2026-09-03T08:00:02.000Z",
            "metadata": {
                "tool_calls": [
                    {
                        "tool": "spawn_agent",
                        "tool_call_id": call,
                        "type": "browser",
                        "start_url": "https://order.online/store/blue-bottle-coffee-2188540?pickup=true",
                        "goal": "Order the drink, guest checkout, stop at payment. api_key=sk-abcdefghijklmnopqrstuvwxyz123456",
                    }
                ]
            },
        },
        {
            "id": "m3",
            "role": "TOOL",
            "message": "",
            "createdAt": "2026-09-03T08:00:03.000Z",
            "metadata": {
                "toolName": "spawn_browser_agent",
                "toolStatus": "IN_PROGRESS",
                "title": "Navigating → https://order.online/store/x",
                "toolCallId": call,
            },
        },
        {
            "id": "m4",
            "role": "TOOL",
            "message": "",
            "createdAt": "2026-09-03T08:00:04.000Z",
            "metadata": {
                "toolName": "spawn_browser_agent",
                "toolStatus": "FINISHED",
                "title": "Navigated → https://order.online/store/x",
                "toolCallId": call,
            },
        },
        {
            "id": "m5",
            "role": "TOOL",
            "message": "",
            "createdAt": "2026-09-03T08:00:05.000Z",
            "metadata": {
                "toolName": "spawn_browser_agent",
                "toolStatus": "FINISHED",
                "title": "Waited 3000ms",
                "toolCallId": call,
            },
        },
        {
            "id": "m6",
            "role": "TOOL",
            "message": "",
            "createdAt": "2026-09-03T08:00:06.000Z",
            "metadata": {
                "toolName": "spawn_browser_agent",
                "toolStatus": "FINISHED",
                "title": "evaluate",
                "toolCallId": call,
            },
        },
        {
            "id": "m7",
            "role": "TOOL",
            "message": "Typed 'andy@example.com' into email; phone +1 (972) 977-7432",
            "createdAt": "2026-09-03T08:00:07.000Z",
            "metadata": {
                "toolName": "spawn_browser_agent",
                "toolStatus": "FINISHED",
                "title": "Typed 'andy@example.com' into <input name=\"email\">",
                "toolCallId": call,
            },
        },
        {
            "id": "m8",
            "role": "TOOL",
            "message": "",
            "createdAt": "2026-09-03T08:00:08.000Z",
            "metadata": {
                "toolName": "spawn_browser_agent",
                "toolStatus": "FINISHED",
                "title": "Payment card requested ($12.25)",
                "toolCallId": call,
            },
        },
        {
            "id": "m9",
            "role": "TOOL",
            "message": "",
            "createdAt": "2026-09-03T08:00:09.000Z",
            "metadata": {
                "toolName": "request_user_approval",
                "toolStatus": "IN_PROGRESS",
                "title": "🔐 Requesting user approval",
                "toolCallId": "call_2",
            },
        },
    ]


# ── transcript ──────────────────────────────────────────────────────────────


def test_trim_rows_drops_lifecycle_and_in_progress_keeps_decisions_and_terminal():
    from providers.planner_memory import trim_rows

    rows, dropped = trim_rows(_messages())
    titles = [r.title for r in rows if r.role == "tool"]
    assert "Initialized" not in titles and "Waited 3000ms" not in titles and "evaluate" not in titles
    assert not any(t and t.startswith("Navigating") for t in titles), "in-progress duplicate must be dropped"
    assert any(t and t.startswith("Navigated") for t in titles)
    assert titles[-1] == "🔐 Requesting user approval", "trailing in-progress row is the terminal state"
    assistant = [r for r in rows if r.role == "assistant"]
    assert assistant and assistant[0].calls[0]["start_url"].startswith("https://order.online/")
    assert "[REDACTED]" in assistant[0].calls[0]["goal"] and "sk-abcdef" not in assistant[0].calls[0]["goal"]
    assert dropped == 4  # agent_init, in-progress duplicate, waited, evaluate


def test_build_transcript_outcome_and_bounds():
    from providers.planner_memory import build_transcript
    from providers.planner_memory.transcript import HEAD_ROWS, MAX_ROWS

    passed = build_transcript(root_agent_id="r1", goal=GOAL, messages=_messages(), passed=True, root_status="ACTIVE")
    assert passed.outcome == "passed" and passed.outcome_note == ""
    failed = build_transcript(
        root_agent_id="r2",
        goal=GOAL,
        messages=_messages(),
        passed=False,
        root_status="PAUSED",
        failure_reason="Timeout after 1200s",
    )
    assert failed.outcome == "failed" and "Timeout" in failed.outcome_note
    completed = build_transcript(
        root_agent_id="r3", goal=GOAL, messages=_messages(), passed=None, root_status="COMPLETED"
    )
    assert completed.outcome == "passed"
    # Long runs keep head + tail.
    big = []
    for i in range(400):
        big.append(
            {
                "id": f"b{i:04d}",
                "role": "TOOL",
                "message": f"step {i}",
                "createdAt": f"2026-09-03T08:{i // 60:02d}:{i % 60:02d}.000Z",
                "metadata": {
                    "toolName": "spawn_browser_agent",
                    "toolStatus": "FINISHED",
                    "title": f"Clicked <button {i}>",
                },
            }
        )
    bounded = build_transcript(root_agent_id="r4", goal=GOAL, messages=big, passed=True, root_status="COMPLETED")
    assert len(bounded.rows) <= MAX_ROWS and bounded.rows[0].text == "step 0" and bounded.rows[-1].text == "step 399"
    assert bounded.rows[HEAD_ROWS - 1].text == f"step {HEAD_ROWS - 1}"
    payload = json.dumps(bounded.to_prompt_payload())
    assert len(payload) < 60_000


def test_scrub_removes_emails_phones_cards_and_secrets():
    from providers.planner_memory.bundle import redact_reference_text, scrub_personal_data

    text = "email andy@example.com phone +1 (972) 977-7432 card 4242 4242 4242 4242 cvv 123 token ghp_abcdefghijklmnopqrstuvwxyz0123 keep https://order.online/store/x?pickup=true"
    out = scrub_personal_data(redact_reference_text(text))
    assert "andy@example.com" not in out and "[EMAIL]" in out
    assert "977-7432" not in out and "[PHONE]" in out
    assert "4242 4242" not in out and "[REDACTED-PAN]" in out
    assert "cvv 123" not in out
    assert "ghp_" not in out
    assert "https://order.online/store/x?pickup=true" in out


def test_scrub_preserves_numeric_public_urls_and_dates_but_masks_e164_phones():
    """Captured compressor cases: public numeric IDs/dates are not PII; E.164 numbers are."""
    from providers.planner_memory.compressor import parse_critical_path

    tiktok_url = "https://www.tiktok.com/@hubermanlab/video/7591981806514162974"
    raw = {
        "outcome": "passed",
        "entry_points": [{"tool": "web_fetch", "start_url": tiktok_url}],
        "critical_path": [
            {
                "step": 1,
                "tool": "web_fetch",
                "action": f"Fetched {tiktok_url} on 2026-09-11.",
                "result": "Sent the result to +19729777432.",
            }
        ],
        "detours": [],
        "pitfalls": ["Use the exact 2026-09-11 date."],
        "terminal_condition": "Completed after notifying +19729777432.",
        "first_unmet_requirement": None,
    }
    record = parse_critical_path(json.dumps(raw))
    rendered = json.dumps(record.model_dump(), ensure_ascii=False)
    assert tiktok_url in rendered, "a public numeric URL ID must not be redacted as a payment card"
    assert "2026-09-11" in rendered, "an ISO date must not be classified as a phone number"
    assert "+19729777432" not in rendered and "[PHONE]" in rendered, "contiguous E.164 phones must be masked"


def test_scrub_masks_sensitive_values_inside_urls_and_rendered_goals():
    """URL structure is not a privacy bypass, and shared benchmark goals are scrubbed before injection."""
    from providers.planner_memory import render_memories
    from providers.planner_memory.bundle import sanitize_memory_text

    values = (
        "https://checkout.example/pay?card=4242424242424242",
        "https://example.com/profile?email=andy@example.com",
        "https://example.com/call?phone=+19729777432",
        "https://example.com/profile?email=andy%40example.com",
    )
    sanitized = "\n".join(sanitize_memory_text(value) for value in values)
    for secret in ("4242424242424242", "andy@example.com", "+19729777432", "andy%40example.com"):
        assert secret not in sanitized
    hit = _hit()
    hit.goal = "Email andy@example.com or call +19729777432; card 4242424242424242"
    rendered = render_memories([hit])
    assert "andy@example.com" not in rendered
    assert "+19729777432" not in rendered
    assert "4242424242424242" not in rendered


# ── compressor contract ─────────────────────────────────────────────────────


def test_compressor_prompt_is_generic_and_under_line_cap():
    from providers.planner_memory import COMPRESSOR_PROMPT, COMPRESSOR_PROMPT_MAX_LINES
    from providers.planner_memory.compressor import compressor_prompt_line_count

    assert compressor_prompt_line_count() <= COMPRESSOR_PROMPT_MAX_LINES
    lowered = COMPRESSOR_PROMPT.lower()
    for banned in ("blue bottle", "order.online", "doordash", "amazon", "benchmark", "instacart"):
        assert banned not in lowered, f"compressor prompt must stay generic; found {banned!r}"


def test_parse_critical_path_clamps_and_scrubs():
    from providers.planner_memory.compressor import parse_critical_path

    raw = {
        "outcome": "passed",
        "entry_points": [{"tool": "spawn_browser_agent", "start_url": "https://order.online/store/x"}],
        "critical_path": [
            {"step": i, "tool": "browser", "action": "x" * 400, "result": f"contact andy@example.com {i}"}
            for i in range(12)
        ],
        "detours": [{"tried": "store finder", "why_it_failed": "no link", "steps_wasted": 30}] * 7,
        "pitfalls": ["p"] * 9,
        "terminal_condition": "stopped at payment approval",
        "first_unmet_requirement": None,
    }
    record = parse_critical_path(json.dumps(raw))
    assert len(record.critical_path) == 8 and len(record.detours) == 5 and len(record.pitfalls) == 5
    assert all(len(step.action) <= 200 for step in record.critical_path)
    assert all("[EMAIL]" in step.result for step in record.critical_path)
    assert [step.step for step in record.critical_path] == list(range(1, 9))


def test_transcript_resolves_each_spawn_tool_from_its_own_archived_type():
    """Tool aliases are resolved while their lossless per-call type evidence is still present."""
    from providers.planner_memory.transcript import trim_rows

    messages = [
        {
            "id": "a",
            "role": "ASSISTANT",
            "message": "",
            "createdAt": "2026-09-03T08:00:00.000Z",
            "metadata": {
                "tool_calls": [
                    {"tool": "spawn_agent", "type": "browser", "goal": "open site", "start_url": "https://x.com"},
                    {"tool": "spawn_agent", "type": "explore", "goal": "research topic"},
                    {"tool": "spawn_agent", "type": "code", "goal": "write code"},
                ]
            },
        },
        {
            "id": "b",
            "role": "TOOL",
            "message": "",
            "createdAt": "2026-09-03T08:00:01.000Z",
            "metadata": {
                "toolName": "spawn_agent",
                "agentType": "explore",
                "plannedToolName": "spawn_explore_agent",
                "toolStatus": "FINISHED",
                "title": "Explore agent finished",
            },
        },
    ]
    rows, _ = trim_rows(messages)
    assert [call["tool"] for call in rows[0].calls] == [
        "spawn_browser_agent",
        "spawn_explore_agent",
        "spawn_code_agent",
    ]
    assert rows[1].tool == "spawn_explore_agent"


def test_parse_critical_path_rejects_archive_internal_spawn_tool():
    from providers.planner_memory.compressor import parse_critical_path

    raw = {
        "outcome": "passed",
        "entry_points": [{"tool": "spawn_agent", "start_url": None}],
        "critical_path": [],
        "detours": [],
        "pitfalls": [],
        "terminal_condition": "done",
        "first_unmet_requirement": None,
    }
    try:
        parse_critical_path(json.dumps(raw))
    except ValueError as exc:
        assert "archive-internal spawn_agent" in str(exc)
    else:
        raise AssertionError("generic archive tool names must never enter planner memory")


def test_compressor_benchmark_grounding_uses_structured_text_and_shared_pii_rules():
    """Captured evaluator cases: JSON escaping and ISO dates cannot create false failures."""
    from benchmarks.run_memory_compressor_bench import evaluate
    from providers.planner_memory import build_transcript
    from providers.planner_memory.records import CriticalPath

    url = "https://api.ipify.org?format=json"
    messages = [
        {
            "id": "u1",
            "role": "USER",
            "message": "Use ipify on 2026-09-11.",
            "createdAt": "2026-09-11T00:00:00.000Z",
            "metadata": {},
        },
        {
            "id": "t1",
            "role": "TOOL",
            "message": f"Navigated → {url} on 2026-09-11.",
            "createdAt": "2026-09-11T00:00:01.000Z",
            "metadata": {"toolName": "spawn_browser_agent", "toolStatus": "FINISHED", "title": "Task Completed"},
        },
    ]
    transcript = build_transcript(
        root_agent_id="captured-grounding",
        goal="Use ipify on 2026-09-11.",
        messages=messages,
        passed=True,
        root_status="COMPLETED",
    )
    record = CriticalPath.model_validate(
        {
            "outcome": "passed",
            "entry_points": [{"tool": "spawn_browser_agent", "start_url": url}],
            "critical_path": [
                {
                    "step": 1,
                    "tool": "spawn_browser_agent",
                    "action": f"Opened {url} on 2026-09-11.",
                    "result": f'Title showed "Navigated → {url}".',
                }
            ],
            "detours": [],
            "pitfalls": ["Use the exact 2026-09-11 date."],
            "terminal_condition": "Task completed.",
            "first_unmet_requirement": None,
        }
    )
    assert evaluate(transcript, record, 1.0) == []


def test_compressor_benchmark_has_an_independent_sensitive_data_oracle():
    from benchmarks.run_memory_compressor_bench import contains_sensitive_data

    assert contains_sensitive_data({"url": "https://checkout.example/pay?card=4242424242424242"})
    assert contains_sensitive_data({"url": "https://example.com/profile?email=andy@example.com"})
    assert contains_sensitive_data({"url": "https://example.com/profile?email=andy%40example.com"})
    assert contains_sensitive_data({"result": "called +19729777432"})
    assert not contains_sensitive_data({"url": "https://www.tiktok.com/@x/video/7591981806514162974"})
    assert not contains_sensitive_data({"date": "2026-09-11"})


async def test_compress_transcript_uses_structured_call_and_transcript_outcome_wins():
    import providers.planner_memory.compressor as compressor
    from providers.planner_memory import build_transcript, compress_transcript

    seen: dict[str, Any] = {}

    async def fake_call_llm(messages, **kwargs):
        seen["messages"] = messages
        seen["kwargs"] = kwargs
        return {
            "content": json.dumps(
                {
                    "outcome": "failed",
                    "entry_points": [],
                    "critical_path": [{"step": 1, "tool": "browser", "action": "open", "result": "ok"}],
                    "detours": [],
                    "pitfalls": [],
                    "terminal_condition": "done",
                    "first_unmet_requirement": None,
                }
            ),
            "model": "test",
        }

    transcript = build_transcript(
        root_agent_id="r1", goal=GOAL, messages=_messages(), passed=True, root_status="COMPLETED"
    )
    import helpers.llm as llm

    with patch.object(llm, "call_llm", new=fake_call_llm):
        record = await compress_transcript(transcript)
    assert record.outcome == "passed", "benchmark verdict beats the model's guess"
    assert seen["kwargs"]["response_model"].__name__ == "CriticalPath"
    assert seen["kwargs"]["call_site"] == compressor.COMPRESSOR_CALL_SITE
    assert seen["kwargs"]["model"] == compressor.COMPRESSOR_MODEL
    assert seen["messages"][0]["content"] == compressor.COMPRESSOR_PROMPT
    assert GOAL in seen["messages"][1]["content"]


# ── scoring / cutoff ────────────────────────────────────────────────────────


def _cand(
    id_: str,
    goal: str,
    *,
    passed=True,
    status="COMPLETED",
    task="t",
    sim=0.8,
    cp=None,
    compressor_version=None,
    created="2026-09-01T00:00:00Z",
):
    if cp is not None and compressor_version is None:
        from providers.planner_memory import COMPRESSOR_VERSION

        compressor_version = COMPRESSOR_VERSION
    return {
        "id": id_,
        "goal": goal,
        "passed": passed,
        "root_status": status,
        "benchmark_task_name": task,
        "similarity": sim,
        "critical_path": cp,
        "compressor_version": compressor_version,
        "agent_created_at": created,
    }


def test_select_hits_cutoff_dedupe_success_filter_and_top_k():
    from providers.planner_memory import RetrievalConfig, select_hits

    config = RetrievalConfig(min_similarity=0.5, k=3)
    same = _cand("a", GOAL, sim=0.9, created="2026-09-01T00:00:00Z")
    same_newer_compressed = _cand(
        "b", GOAL, sim=0.9, cp={"outcome": "passed", "terminal_condition": "x"}, created="2026-09-02T00:00:00Z"
    )
    near = _cand("c", "Order an iced shakerato from Blue Bottle Ferry Building for pickup", sim=0.7)
    below_floor = _cand("d", "Renew my passport at the downtown post office", sim=0.3)
    failed = _cand("e", GOAL + " failed", passed=False, status="PAUSED", sim=0.95)
    private_completed = _cand("f", GOAL + " today", passed=None, status="COMPLETED", task=None, sim=0.8)
    extra = _cand("g", "Order a latte from Blue Bottle", sim=0.6)
    hits = select_hits([same, same_newer_compressed, near, below_floor, failed, private_completed, extra], config)
    ids = [h.id for h in hits]
    assert "d" not in ids, "candidates under the similarity cutoff are never memories"
    assert "e" not in ids, "failed runs are not memories"
    assert "a" not in ids and ids[0] == "b", "one hit per unique goal, prefer the compressed row"
    assert ids == ["b", "f", "c"], f"similarity-ordered and capped at k: {ids}"
    assert select_hits([below_floor], config) == [] and select_hits([], config) == []


def test_default_config_is_top3_at_cutoff_070():
    from providers.planner_memory import RetrievalConfig, select_hits

    assert RetrievalConfig().min_similarity == 0.70 and RetrievalConfig().k == 3
    picked = select_hits(
        [_cand("hi", GOAL, sim=0.71), _cand("edge", GOAL + " b", sim=0.70), _cand("lo", GOAL + " c", sim=0.69)],
        RetrievalConfig(),
    )
    assert [h.id for h in picked] == ["hi", "edge"], "0.70 is inclusive; 0.69 is excluded"


def test_stale_compressor_cache_is_recomputed_without_a_ttl():
    from providers.planner_memory import RetrievalConfig, select_hits

    stale = _cand(
        "stale",
        GOAL,
        cp={"outcome": "passed", "terminal_condition": "old output"},
        compressor_version="cp-v1",
        sim=0.9,
    )
    current = _cand(
        "current",
        GOAL + " today",
        cp={"outcome": "passed", "terminal_condition": "current output"},
        sim=0.8,
    )
    hits = select_hits([stale, current], RetrievalConfig(min_similarity=0.0))
    by_id = {hit.id: hit for hit in hits}
    assert by_id["stale"].critical_path is None, "a stale compressor version must refill lazily"
    assert by_id["current"].critical_path is not None, "the current version remains a cache hit"


def test_benchmark_memory_fixtures_are_cache_hits_at_the_current_compressor_version():
    """Memory fixtures are pre-compressed history: every row must be a retrieval cache hit.

    A row compressed by an older compressor is treated as stale and recompressed at plan
    time; when that LLM call cannot finish inside the compression budget the memory-on arm
    plans with no memory at all (planner-memory-blue-bottle-on, 2026-11-06).
    """
    from providers.planner_memory import COMPRESSOR_VERSION, RetrievalConfig, select_hits
    from scripts.build_memory_fixture import FIXTURE_DIR

    checked = 0
    for path in sorted(FIXTURE_DIR.glob("*.json")):
        fixture = json.loads(path.read_text(encoding="utf-8"))
        rows = fixture.get("rows") if isinstance(fixture, dict) else None
        if not isinstance(rows, list):
            continue
        candidates = [{**row, "similarity": 1.0} for row in rows]
        hits = {hit.id: hit for hit in select_hits(candidates, RetrievalConfig(min_similarity=0.0, k=len(rows)))}
        for row in rows:
            hit = hits.get(row["id"])
            assert hit is not None, f"{path.name}: row {row['id']} is not retrievable"
            assert hit.critical_path is not None, (
                f"{path.name}: row {row['id']} was compressed by {row.get('compressor_version')!r}, "
                f"not {COMPRESSOR_VERSION!r}; rebuild it with scripts/build_memory_fixture.py"
            )
            checked += 1
    assert checked > 0, "no memory fixture rows were checked"


# ── fork ────────────────────────────────────────────────────────────────────


def _hit(id_: str = "mem-1", with_path: bool = True):
    from providers.planner_memory.records import CriticalPath, MemoryHit

    cp = None
    if with_path:
        cp = CriticalPath.model_validate(
            {
                "outcome": "passed",
                "entry_points": [
                    {
                        "tool": "spawn_browser_agent",
                        "start_url": "https://order.online/store/blue-bottle-coffee-2188540?pickup=true",
                    }
                ],
                "critical_path": [
                    {
                        "step": 1,
                        "tool": "spawn_browser_agent",
                        "action": "open order.online store page",
                        "result": "menu",
                    },
                    {
                        "step": 2,
                        "tool": "spawn_browser_agent",
                        "action": "add shakerato, guest checkout",
                        "result": "payment",
                    },
                ],
                "detours": [
                    {"tried": "bluebottlecoffee.com store finder", "why_it_failed": "no order link", "steps_wasted": 30}
                ],
                "pitfalls": ["order.online is the checkout host"],
                "terminal_condition": "stopped at payment approval",
                "first_unmet_requirement": None,
            }
        )
    return MemoryHit(
        id=id_,
        goal=GOAL,
        benchmark_task_name="browser-blue-bottle-challenge-recovery",
        passed=True,
        root_status="ACTIVE",
        created_at="2026-09-03T08:57:36.972Z",
        similarity=0.91,
        critical_path=cp,
    )


def test_fork_shape_pairing_and_render():
    from providers.planner_memory import GET_MEMORIES_TOOL_NAME, build_memory_fork
    from providers.planner_memory.inject import MEMORY_RESULT_PREFIX

    fork = build_memory_fork(GOAL, [_hit()], k=3)
    assistant, tool = fork.messages()
    assert assistant["role"] == "assistant" and tool["role"] == "tool"
    call = assistant["tool_calls"][0]
    assert call["id"] == fork.tool_call_id == tool["tool_call_id"]
    assert call["function"]["name"] == GET_MEMORIES_TOOL_NAME == tool["name"]
    assert json.loads(call["function"]["arguments"]) == {"query": GOAL, "k": 3}
    assert tool["content"].startswith(MEMORY_RESULT_PREFIX)
    assert "start_url=https://order.online/store/blue-bottle-coffee-2188540?pickup=true" in tool["content"]
    assert "Detour avoided (30 steps)" in tool["content"]
    assert "do not copy names, prices, dates" in tool["content"]
    assert "live/current-state verification in that same stateful browser task" in tool["content"]
    # Deterministic id for the same query (Temporal retries reuse it).
    assert build_memory_fork(GOAL, [_hit()], k=3).tool_call_id == fork.tool_call_id


def test_render_caps_total_size():
    from providers.planner_memory import render_memories
    from providers.planner_memory.inject import MAX_RENDERED_CHARS

    hits = [_hit(f"mem-{i}") for i in range(20)]
    for hit in hits:
        hit.goal = GOAL * 3
    rendered = render_memories(hits)
    assert len(rendered) <= MAX_RENDERED_CHARS + 1


def test_memory_scenario_runner_rejects_shared_history():
    from benchmarks.run_memory_scenarios import require_isolated_history

    expected = [{"id": "fixture-a", "goal": "expected", "passed": True}]
    observed = [{"id": "fixture-a", "goal": "expected", "passed": True}]
    require_isolated_history({"total": 1}, expected, observed)
    try:
        require_isolated_history({"total": 1}, expected, [{"id": "fixture-a", "goal": "wrong", "passed": True}])
    except RuntimeError as exc:
        assert "requires an isolated PlannerMemory table" in str(exc)
    else:
        raise AssertionError("same-size but incorrect fixture corpus must fail closed before an A/B run")


def test_insert_fork_goes_before_validation_retry_tail_and_leaves_prefix_untouched():
    from providers.planner_memory import build_memory_fork, insert_memory_fork

    base = [
        {"role": "system", "content": "static planner prompt"},
        {"role": "user", "content": f"GOAL: {GOAL}\n\nPlan this goal into tasks."},
        {"role": "assistant", "content": "clarifying question"},
        {"role": "user", "content": "oat milk please"},
        {"role": "user", "content": "[VALIDATION ERROR - Please fix]: bad json"},
    ]
    fork = build_memory_fork(GOAL, [_hit()], k=3)
    out = insert_memory_fork(base, fork)
    assert [m["role"] for m in out] == ["system", "user", "assistant", "user", "assistant", "tool", "user"]
    assert out[:4] == base[:4], "the cached prefix must be byte-identical"
    assert out[-1] is base[-1]
    assert out[4] is fork.assistant_message and out[5] is fork.tool_message
    # Without a retry tail the fork is simply appended.
    assert [m["role"] for m in insert_memory_fork(base[:4], fork)][-2:] == ["assistant", "tool"]


def test_fork_flattens_to_text_when_no_tools_are_declared():
    from providers.planner_memory import build_memory_fork
    from providers.rose.transforms import flatten_tool_history_to_text

    fork = build_memory_fork(GOAL, [_hit()], k=3)
    flat = flatten_tool_history_to_text([{"role": "user", "content": "GOAL"}, *fork.messages()])
    assert all("tool_calls" not in m and m["role"] != "tool" for m in flat)
    assert any("get_memories" in str(m.get("content")) for m in flat)
    assert any("order.online/store/blue-bottle" in str(m.get("content")) for m in flat)


def test_planner_context_tools_are_constant_and_declared_only():
    from providers.planner_memory import GET_MEMORIES_TOOL_NAME, planner_context_tools
    from providers.planner_memory.inject import CONTEXT_ONLY_TOOL_KEY
    from utils.tool_schemas import PLAN_PHASE_TOOLS

    tools = planner_context_tools()
    names = [t["name"] for t in tools]
    assert names[-1] == GET_MEMORIES_TOOL_NAME and names.count(GET_MEMORIES_TOOL_NAME) == 1
    assert set(PLAN_PHASE_TOOLS) <= set(names)
    assert all(t.get(CONTEXT_ONLY_TOOL_KEY) is True for t in tools)
    assert json.dumps(planner_context_tools(), sort_keys=True) == json.dumps(tools, sort_keys=True)


def test_anthropic_body_keeps_context_tools_historical_only():
    from providers.planner_memory import GET_MEMORIES_TOOL, build_memory_fork
    from providers.rose.claude_auth import build_anthropic_body
    from providers.rose.pools import get_pool
    from providers.rose.schema import build_openai_response_format
    from utils.tool_schemas import PlannerResponse

    fork = build_memory_fork(GOAL, [_hit()], k=3)
    body = build_anthropic_body(
        pool_spec=get_pool("rose-1-ultra"),
        messages=[{"role": "system", "content": "sys"}, {"role": "user", "content": "GOAL"}, *fork.messages()],
        tools=None,
        tool_choice=None,
        response_format=build_openai_response_format(PlannerResponse),
        max_tokens=1000,
        context_tools=[GET_MEMORIES_TOOL],
    )
    assert "get_memories" not in [t["name"] for t in body.get("tools", [])]
    assert "output_config" in body or "output_format" in body, "structured output must survive the declaration"
    blocks = [b for m in body["messages"] for b in (m["content"] if isinstance(m["content"], list) else [])]
    assert any(b.get("type") == "tool_use" and b.get("name") == "get_memories" for b in blocks)
    assert any(b.get("type") == "tool_result" and b.get("tool_use_id") == fork.tool_call_id for b in blocks)

    native = {**GET_MEMORIES_TOOL, "name": "send_message_to_user"}
    with_native = build_anthropic_body(
        pool_spec=get_pool("rose-1-ultra"),
        messages=[{"role": "system", "content": "sys"}, {"role": "user", "content": "GOAL"}, *fork.messages()],
        tools=[native],
        tool_choice="auto",
        response_format=None,
        max_tokens=1000,
        context_tools=[GET_MEMORIES_TOOL],
    )
    assert [tool["name"] for tool in with_native["tools"]] == ["send_message_to_user"]


def test_responses_body_keeps_context_tools_historical_only():
    from providers.planner_memory import GET_MEMORIES_TOOL, build_memory_fork
    from providers.rose.gpt_auth import build_codex_responses_body
    from providers.rose.pools import get_pool
    from providers.rose.schema import build_openai_response_format
    from utils.tool_schemas import PlannerResponse

    fork = build_memory_fork(GOAL, [_hit()], k=3)
    messages = [{"role": "system", "content": "sys"}, {"role": "user", "content": "GOAL"}, *fork.messages()]
    body = build_codex_responses_body(
        pool_spec=get_pool("rose-1-ultra"),
        messages=messages,
        response_format=build_openai_response_format(PlannerResponse),
        tools=None,
        context_tools=[GET_MEMORIES_TOOL],
        request_id="r",
    )
    assert "get_memories" not in [tool["name"] for tool in body.get("tools", [])]
    assert any(item.get("type") == "function_call" for item in body["input"])
    assert any(item.get("type") == "function_call_output" for item in body["input"])
    assert body["text"]["format"]["type"] == "json_schema"

    native = {**GET_MEMORIES_TOOL, "name": "send_message_to_user"}
    with_native = build_codex_responses_body(
        pool_spec=get_pool("rose-1-ultra"),
        messages=messages,
        tools=[native],
        context_tools=[GET_MEMORIES_TOOL],
        request_id="r-native",
    )
    assert [tool["name"] for tool in with_native["tools"]] == ["send_message_to_user"]


# ── planner context real roles ──────────────────────────────────────────────


def test_build_planner_messages_keeps_real_tool_roles():
    from domains.set_plan.service import build_planner_messages

    context = [
        {"role": "USER", "text": GOAL},
        {
            "role": "ASSISTANT",
            "text": "",
            "metadata": {
                "tool_calls": [
                    {"tool": "spawn_agent", "tool_call_id": "c1", "type": "explore", "goal": "find the store url"}
                ]
            },
        },
        {
            "role": "TOOL",
            "text": "https://order.online/store/x",
            "metadata": {"toolCallId": "c1", "toolName": "spawn_agent", "title": "Explore done"},
        },
        {"role": "TOOL", "text": "Initialized", "metadata": {"toolCallId": "zz", "toolName": "agent_init"}},
        {"role": "SYSTEM", "text": "notice"},
    ]
    messages, user_messages = build_planner_messages(context)
    assert user_messages == [GOAL]
    roles = [m["role"] for m in messages]
    assert roles == ["user", "user", "assistant", "tool", "user", "user"]
    assert (
        messages[2]["tool_calls"][0]["id"] == "c1" and messages[2]["tool_calls"][0]["function"]["name"] == "spawn_agent"
    )
    assert json.loads(messages[2]["tool_calls"][0]["function"]["arguments"])["type"] == "explore"
    assert messages[3]["tool_call_id"] == "c1" and messages[3]["name"] == "spawn_agent"
    assert messages[3]["content"].startswith("Explore done: ")
    assert messages[4]["content"].startswith("[SYSTEM]: ") and "[TOOL]" not in messages[4]["content"]
    assert not any(str(m.get("content", "")).startswith("[TOOL]") for m in messages)


# ── activity wiring ─────────────────────────────────────────────────────────


def _mock_backend(candidates: list[dict[str, Any]]):
    calls: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        calls.append(
            {"url": url, "method": request.method, "body": request.content.decode() if request.content else ""}
        )
        if "/api/planner-memory/search" in url:
            return httpx.Response(200, json={"candidates": candidates})
        if request.method == "POST" and "/critical-path-claim" in url:
            return httpx.Response(200, json={"claimed": True, "lease_id": "lease-1"})
        if request.method == "DELETE" and "/critical-path-claim" in url:
            return httpx.Response(200, json={"released": True})
        if "/critical-path" in url:
            return httpx.Response(200, json={"id": "x"})
        return httpx.Response(404, json={"error": f"no mock for {url}"})

    setup_mock_fn(handler)
    return calls


async def _run_activity(
    *,
    memory_enabled: bool,
    candidates: list[dict[str, Any]],
    lease: Optional[dict[str, Any]] = None,
    compressor_content: str = "",
):
    import helpers.llm as llm
    from utils.tool_schemas import PlannerResponse

    captured: dict[str, Any] = {"llm_calls": []}

    async def fake_call_llm(messages, **kwargs):
        captured["llm_calls"].append({"messages": messages, **kwargs})
        return {"content": compressor_content}

    async def fake_structured(**kwargs):
        captured.update(kwargs)
        plan = {
            "title": "Blue Bottle pickup",
            "join": "all",
            "tasks": [{"task_idx": "0", "goal": "order it", "tool_name": "spawn_browser_agent", "depends_on": []}],
        }
        return (
            PlannerResponse.model_validate(plan),
            {"prompt_tokens": 10, "completion_tokens": 5, "actual_model": "test"},
            None,
        )

    calls = _mock_backend(candidates)
    old = dict(os.environ)
    os.environ["BACKEND_API_KEY"] = os.environ.get("BACKEND_API_KEY") or "test-key"
    os.environ["BACKEND_API_URL"] = "http://backend.test"
    os.environ.pop("PLANNER_MEMORY_ENABLED", None)
    try:
        with (
            patch.object(llm, "call_llm_structured_streaming", new=fake_structured),
            patch.object(llm, "call_llm", new=fake_call_llm),
        ):
            result = await llm.call_planner_llm_activity(
                [{"role": "user", "content": f"GOAL: {GOAL}\n\nPlan this goal into tasks."}],
                "rose-labs/rose-1-ultra",
                "tool schemas",
                "Name: Test User",
                None,
                **{"claude_token_user_id": "user-a", **(lease or {})},
                memory_enabled=memory_enabled,
            )
    finally:
        os.environ.clear()
        os.environ.update(old)
        teardown_mock()
    return result, captured, calls


async def test_planner_activity_forks_get_memories_when_enabled_with_hits():
    cp = _hit().critical_path.model_dump()
    result, captured, calls = await _run_activity(
        memory_enabled=True, candidates=[_cand("mem-1", GOAL, sim=0.95, cp=cp)]
    )
    sent = captured["messages"]
    assert captured["llm_calls"] == [], "retrieval makes no LLM call when hits are already compressed"
    assert [m["role"] for m in sent] == ["system", "user", "assistant", "tool"]
    assert sent[2]["tool_calls"][0]["function"]["name"] == "get_memories"
    assert sent[3]["name"] == "get_memories" and "order.online/store/blue-bottle" in sent[3]["content"]
    assert sent[1]["content"].startswith("GOAL: ")
    tool_names = [t["name"] for t in captured["context_tools"]]
    assert tool_names[-1] == "get_memories"
    assert result["planner_memory_enabled"] is True
    assert result["planner_memory"]["hits"][0]["id"] == "mem-1"
    assert result["planner_memory_injected"]["tool_call_id"] == sent[2]["tool_calls"][0]["id"]
    assert any("/api/planner-memory/search" in c["url"] for c in calls)
    search_body = json.loads(next(c["body"] for c in calls if "/search" in c["url"]))
    assert search_body["goal"] == GOAL and search_body["user_id"] == "user-a"
    assert search_body["min_similarity"] == 0.70 and search_body["passed_only"] is True


async def test_planner_activity_without_memory_sends_unchanged_context():
    result, captured, calls = await _run_activity(memory_enabled=False, candidates=[_cand("mem-1", GOAL, sim=0.95)])
    assert [m["role"] for m in captured["messages"]] == ["system", "user"]
    assert captured["llm_calls"] == [], "memory off makes no retrieval LLM call"
    assert result["planner_memory"] is None and result["planner_memory_injected"] is None
    assert not any("/api/planner-memory" in c["url"] for c in calls), "memory off must not touch the history table"
    assert [t["name"] for t in captured["context_tools"]][-1] == "get_memories", "declared toolset is constant"


async def test_planner_activity_enabled_without_hits_adds_no_fork():
    result, captured, _ = await _run_activity(
        memory_enabled=True, candidates=[_cand("x", "Renew my passport downtown", sim=0.2)]
    )
    assert [m["role"] for m in captured["messages"]] == ["system", "user"]
    assert captured["llm_calls"] == [], "nothing above the cutoff → no LLM call"
    assert result["planner_memory"]["hits"] == [] and result["planner_memory_injected"] is None


async def test_planner_activity_injects_top3_in_similarity_order():
    cp = _hit().critical_path.model_dump()
    candidates = [
        _cand("m4", GOAL + " four", sim=0.72, cp=cp),
        _cand("m1", GOAL + " one", sim=0.95, cp=cp),
        _cand("m3", GOAL + " three", sim=0.80, cp=cp),
        _cand("m2", GOAL + " two", sim=0.90, cp=cp),
        _cand("low", GOAL + " low", sim=0.60, cp=cp),
    ]
    result, captured, _ = await _run_activity(memory_enabled=True, candidates=candidates)
    assert [h["id"] for h in result["planner_memory"]["hits"]] == ["m1", "m2", "m3"]
    assert [m["role"] for m in captured["messages"]] == ["system", "user", "assistant", "tool"]
    rendered = captured["messages"][3]["content"]
    assert rendered.index("## Memory 1") < rendered.index("## Memory 2") < rendered.index("## Memory 3")
    assert "## Memory 4" not in rendered


async def test_failed_run_is_never_compressed_into_a_memory():
    """Only completed runs become memories: a row whose bundle did not pass is skipped, never injected."""
    import providers.planner_memory.retrieval as retrieval
    from providers.planner_memory import build_transcript

    failed_transcript = build_transcript(
        root_agent_id="mem-fail",
        goal=GOAL,
        messages=_messages(),
        passed=False,
        root_status="PAUSED",
        failure_reason="Timeout",
    )
    compress_calls: list[str] = []

    async def fake_compress(t, **kwargs):
        compress_calls.append(t.root_agent_id)
        return _hit().critical_path

    with (
        patch("providers.planner_memory.transcript.load_bundle_transcript", return_value=failed_transcript),
        patch.object(retrieval, "compress_transcript", new=fake_compress),
    ):
        # The search row claims passed=True (a stale verdict); the bundle itself says failed.
        result, captured, calls = await _run_activity(
            memory_enabled=True, candidates=[_cand("mem-fail", GOAL, sim=0.95)]
        )
    assert compress_calls == [], "a failed transcript must never reach the compressor"
    assert result["planner_memory"]["hits"] == [] and result["planner_memory_injected"] is None
    assert [m["role"] for m in captured["messages"]] == ["system", "user"]
    assert not any(c["method"] == "PATCH" for c in calls)


def test_search_requests_completed_runs_only_and_selection_drops_failures():
    from providers.planner_memory.retrieval import DEFAULT_CONFIG, select_hits

    assert DEFAULT_CONFIG.passed_only is True
    failed = _cand("f1", GOAL, passed=False, status="COMPLETED", sim=0.9)
    timed_out = _cand("f2", GOAL + " b", passed=None, status="PAUSED", sim=0.9)
    completed_private = _cand("ok", GOAL + " c", passed=None, status="COMPLETED", task=None, sim=0.9)
    hits = select_hits([failed, timed_out, completed_private], DEFAULT_CONFIG)
    assert [h.id for h in hits] == ["ok"]


async def test_planner_activity_compresses_uncompressed_hit_and_caches_it():
    import providers.planner_memory.retrieval as retrieval
    from providers.planner_memory import build_transcript

    transcript = build_transcript(
        root_agent_id="mem-2", goal=GOAL, messages=_messages(), passed=True, root_status="COMPLETED"
    )

    async def fake_compress(t, **kwargs):
        return _hit().critical_path

    with (
        patch.object(retrieval, "load_bundle_transcript", create=True),
        patch("providers.planner_memory.transcript.load_bundle_transcript", return_value=transcript),
        patch.object(retrieval, "compress_transcript", new=fake_compress),
    ):
        result, captured, calls = await _run_activity(memory_enabled=True, candidates=[_cand("mem-2", GOAL, sim=0.95)])
    assert result["planner_memory"]["compressed"] == 1
    assert result["planner_memory"]["hits"][0]["compressed_now"] is True
    assert any(c["method"] == "PATCH" and "/mem-2/critical-path" in c["url"] for c in calls), (
        "cache fill must be stored"
    )
    assert [m["role"] for m in captured["messages"]] == ["system", "user", "assistant", "tool"]


async def test_plan_time_compressor_uses_the_planner_activity_lease():
    """The compressor reuses the planner activity's leased compute token.

    Cloud job r001-j0016 (agent fdd82785): the planner call ran with claude_auth while the
    plan-time compressor in the same activity ran with no auth, fell through the exhausted
    API-key legs and timed out, so the memory was never injected.
    """
    from providers.planner_memory import build_transcript

    transcript = build_transcript(
        root_agent_id="mem-3", goal=GOAL, messages=_messages(), passed=True, root_status="COMPLETED"
    )
    leases = {
        "claude": {
            "claude_max_token": "claude-lease-token",
            "claude_token_source": "user",
            "claude_token_pool_id": "pool-c",
            "compute_token_lineage_key": "lineage-1",
        },
        "gpt": {
            "gpt_token": "gpt-lease-token",
            "gpt_account_id": "acct-1",
            "gpt_token_source": "pool",
            "gpt_token_pool_id": "pool-g",
            "gpt_token_user_id": "user-a",
        },
    }
    expected = {
        "claude": {
            "claude_token": "claude-lease-token",
            "claude_token_source": "user",
            "claude_token_pool_id": "pool-c",
            "claude_token_user_id": "user-a",
            "compute_token_lineage_key": "lineage-1",
        },
        "gpt": {
            "gpt_token": "gpt-lease-token",
            "gpt_account_id": "acct-1",
            "gpt_token_source": "pool",
            "gpt_token_pool_id": "pool-g",
            "gpt_token_user_id": "user-a",
        },
    }
    for kind, lease in leases.items():
        with patch("providers.planner_memory.transcript.load_bundle_transcript", return_value=transcript):
            result, captured, _ = await _run_activity(
                memory_enabled=True,
                candidates=[_cand("mem-3", GOAL, sim=0.95)],
                lease=lease,
                compressor_content=_hit().critical_path.model_dump_json(),
            )
        compressor_calls = [c for c in captured["llm_calls"] if c.get("call_site") == "memory_compressor"]
        assert len(compressor_calls) == 1, f"{kind}: one plan-time compression, got {len(compressor_calls)}"
        sent = compressor_calls[0]
        for key, value in expected[kind].items():
            assert sent.get(key) == value, f"{kind}: compressor {key}={sent.get(key)!r}, planner lease {value!r}"
        assert result["planner_memory"]["compressed"] == 1, f"{kind}: compressed memory must be injected"
        assert [m["role"] for m in captured["messages"]] == ["system", "user", "assistant", "tool"]


async def test_compression_timeout_injects_nothing_and_releases_the_lease():
    import providers.planner_memory.retrieval as retrieval
    from providers.planner_memory import build_transcript

    hanging = _cand("hanging", GOAL, sim=0.9)
    transcript = build_transcript(
        root_agent_id="hanging",
        goal=hanging["goal"],
        messages=_messages(),
        passed=True,
        root_status="COMPLETED",
    )
    released: list[tuple[str, str]] = []

    async def fake_search(*args, **kwargs):
        return [hanging]

    async def fake_claim(id_: str, **kwargs):
        return {"claimed": True, "lease_id": f"lease-{id_}"}

    async def fake_release(id_: str, *, lease_id: str):
        released.append((id_, lease_id))
        return True

    async def hanging_compressor(*args, **kwargs):
        await asyncio.Event().wait()

    with (
        patch.object(retrieval.backend, "search_memories", new=fake_search),
        patch.object(retrieval.backend, "claim_compression", new=fake_claim),
        patch.object(retrieval.backend, "release_compression", new=fake_release),
        patch("providers.planner_memory.transcript.load_bundle_transcript", return_value=transcript),
        patch.object(retrieval, "compress_transcript", new=hanging_compressor),
        patch.object(retrieval, "COMPRESSION_BATCH_TIMEOUT_SECONDS", 0.01),
    ):
        result = await retrieval.retrieve_memories(GOAL, user_id="user-a", exclude_root_agent_id="current")

    assert result.hits == []
    assert result.skipped_uncompressed == 1
    assert released == [("hanging", "lease-hanging")]


async def test_retrieval_never_raises_when_backend_is_down():
    from providers.planner_memory import retrieve_memories

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"error": "down"})

    setup_mock_fn(handler)
    old = dict(os.environ)
    os.environ["BACKEND_API_KEY"] = "k"
    os.environ["BACKEND_API_URL"] = "http://backend.test"
    try:
        result = await retrieve_memories(GOAL, user_id="u", exclude_root_agent_id="a")
    finally:
        os.environ.clear()
        os.environ.update(old)
        teardown_mock()
    assert result.hits == [] and result.error


def test_no_unmocked_outbound_calls():
    assert all("backend.test" in c["url"] for c in get_captured_requests()), get_captured_requests()


async def run_all_tests():
    print("planner-memory blackbox tests:")
    r = BlackboxResult()
    r.record("trim_rows", test_trim_rows_drops_lifecycle_and_in_progress_keeps_decisions_and_terminal)
    r.record("build_transcript_outcome_bounds", test_build_transcript_outcome_and_bounds)
    r.record("scrub_pii_and_secrets", test_scrub_removes_emails_phones_cards_and_secrets)
    r.record(
        "scrub_numeric_urls_dates_e164",
        test_scrub_preserves_numeric_public_urls_and_dates_but_masks_e164_phones,
    )
    r.record("scrub_sensitive_url_values_and_goals", test_scrub_masks_sensitive_values_inside_urls_and_rendered_goals)
    r.record("compressor_prompt_generic_line_cap", test_compressor_prompt_is_generic_and_under_line_cap)
    r.record("parse_critical_path_clamps_scrubs", test_parse_critical_path_clamps_and_scrubs)
    r.record(
        "transcript_typed_spawn",
        test_transcript_resolves_each_spawn_tool_from_its_own_archived_type,
    )
    r.record("compressor_rejects_generic_spawn", test_parse_critical_path_rejects_archive_internal_spawn_tool)
    r.record(
        "compressor_bench_structured_grounding",
        test_compressor_benchmark_grounding_uses_structured_text_and_shared_pii_rules,
    )
    r.record(
        "compressor_bench_independent_pii_oracle",
        test_compressor_benchmark_has_an_independent_sensitive_data_oracle,
    )
    await r.record_async(
        "compress_transcript_contract", test_compress_transcript_uses_structured_call_and_transcript_outcome_wins
    )
    r.record("select_cutoff_dedupe_success", test_select_hits_cutoff_dedupe_success_filter_and_top_k)
    r.record("default_top3_cutoff_070", test_default_config_is_top3_at_cutoff_070)
    r.record("compressor_cache_version", test_stale_compressor_cache_is_recomputed_without_a_ttl)
    r.record(
        "memory_fixtures_current_compressor",
        test_benchmark_memory_fixtures_are_cache_hits_at_the_current_compressor_version,
    )
    r.record("fork_shape_pairing_render", test_fork_shape_pairing_and_render)
    r.record("render_caps", test_render_caps_total_size)
    r.record("scenario_fixture_exactness", test_memory_scenario_runner_rejects_shared_history)
    r.record(
        "insert_fork_position_prefix", test_insert_fork_goes_before_validation_retry_tail_and_leaves_prefix_untouched
    )
    r.record("fork_flattens_without_tools", test_fork_flattens_to_text_when_no_tools_are_declared)
    r.record("planner_context_tools_constant", test_planner_context_tools_are_constant_and_declared_only)
    r.record("anthropic_body_context_tools", test_anthropic_body_keeps_context_tools_historical_only)
    r.record("responses_body_context_tools", test_responses_body_keeps_context_tools_historical_only)
    r.record("planner_messages_real_tool_roles", test_build_planner_messages_keeps_real_tool_roles)
    await r.record_async("activity_forks_with_hits", test_planner_activity_forks_get_memories_when_enabled_with_hits)
    await r.record_async("activity_memory_off_unchanged", test_planner_activity_without_memory_sends_unchanged_context)
    await r.record_async("activity_enabled_no_hits", test_planner_activity_enabled_without_hits_adds_no_fork)
    await r.record_async("activity_top3_order", test_planner_activity_injects_top3_in_similarity_order)
    await r.record_async("failed_run_never_compressed", test_failed_run_is_never_compressed_into_a_memory)
    r.record("completed_only_selection", test_search_requests_completed_runs_only_and_selection_drops_failures)
    await r.record_async(
        "activity_compresses_and_caches", test_planner_activity_compresses_uncompressed_hit_and_caches_it
    )
    await r.record_async("compressor_uses_planner_lease", test_plan_time_compressor_uses_the_planner_activity_lease)
    await r.record_async(
        "compression_timeout_releases_lease",
        test_compression_timeout_injects_nothing_and_releases_the_lease,
    )
    await r.record_async("retrieval_backend_down_safe", test_retrieval_never_raises_when_backend_is_down)
    r.record("no_unmocked_outbound_calls", test_no_unmocked_outbound_calls)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
