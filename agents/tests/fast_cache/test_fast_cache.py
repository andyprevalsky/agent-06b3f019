"""Fast Mode aggressive cache — Python behavior tests.

Each test is annotated with the checklist item(s) it proves (see
docs/plans/active/fast-mode-aggressive-cache.md). These exercise the REAL cache
components with the third-party boundary (backend store + Rose) mocked.

Async cases run via asyncio.run() so the suite needs no pytest-asyncio plugin
(the agents repo runs blackbox tests through a custom asyncio runner).
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import replace
from types import SimpleNamespace
from typing import Any, AsyncIterator, Dict, List

from pathlib import Path

import pytest
from pydantic import BaseModel

from providers.fast_cache import normalize, rose_cache
from providers.fast_cache.context import (
    FastCacheContext,
    is_enabled,
    reset_context,
    set_context,
)
from providers.rose.pools import POOL_REGISTRY


def _soft_complete_bench_goal() -> str:
    """Exact prompt for the sole ``fast_cache:on`` task (test-mass-agent-run-0)."""
    from pathlib import Path

    tasks_path = Path(__file__).resolve().parents[2] / "benchmarks" / "tasks.json"
    tasks = json.loads(tasks_path.read_text(encoding="utf-8"))
    return next(t["prompt"] for t in tasks if t["name"] == "test-mass-agent-run-0")


# ---------------------------------------------------------------------------
# Fakes / helpers
# ---------------------------------------------------------------------------


def _chunk(kind: str, data: Dict[str, Any]):
    return SimpleNamespace(kind=kind, data=data)


class FakeRose:
    """Stand-in for RoseClient.complete — records calls and yields a fixed stream."""

    def __init__(self, chunks: List[Any]):
        self._chunks = chunks
        self.calls = 0

    async def complete(self, **kwargs: Any) -> AsyncIterator[Any]:
        self.calls += 1
        for c in self._chunks:
            yield c


def _full_stream() -> List[Any]:
    return [
        _chunk("metadata", {"actual_model": "claude-opus-4-7-claude", "pool_name": "rose-1-ultra", "request_id": "r1"}),
        _chunk("content", {"text": "Hello "}),
        _chunk("content", {"text": "world"}),
        _chunk("tool_call", {"id": "t1", "name": "set_plan", "arguments": '{"x":1}'}),
        _chunk("usage", {"prompt_tokens": 10, "completion_tokens": 5, "finish_reason": "tool_calls"}),
        _chunk("done", {"timing": {"round_trip_s": 1.2}}),
    ]


class MemStore:
    """In-memory backend store; last write wins like the backend upsert."""

    def __init__(self):
        self.data: Dict[str, Any] = {}
        self.set_calls = 0
        self.get_calls = 0

    async def get(self, key: str):
        self.get_calls += 1
        return self.data.get(key)

    async def set(
        self, key: str, kind: str, goal_hash: str, value: Any, *, goal: str | None = None, root_goal: str | None = None
    ) -> bool:
        self.set_calls += 1
        self.data[key] = normalize.strip_secrets(value)
        return True


@pytest.fixture(autouse=True)
def _reset_ctx():
    token = set_context(None)
    yield
    try:
        reset_context(token)
    except Exception:
        pass


@pytest.fixture
def mem(monkeypatch):
    store = MemStore()
    monkeypatch.setattr(rose_cache.cache_client, "cache_get", store.get)
    monkeypatch.setattr(rose_cache.cache_client, "cache_set", store.set)

    async def _get_first(keys):
        for key in keys or []:
            value = await store.get(key)
            if value is not None:
                return value, key
        return None, None

    async def _position_fallback(goal_hash, call_site, step=None):
        del goal_hash, call_site, step
        return None, None

    async def _prior_exists(goal_hash, call_site, step):
        del goal_hash, call_site
        # Default cold; tests that need true exhaustion stub this True.
        return bool(step is not None and int(step) > 0 and False)

    monkeypatch.setattr(rose_cache.cache_client, "cache_get_first", _get_first)
    monkeypatch.setattr(rose_cache.cache_client, "cache_get_position_fallback", _position_fallback)
    monkeypatch.setattr(rose_cache.cache_client, "trajectory_prior_exists", _prior_exists)
    store.prior_exists = _prior_exists
    return store


async def _drain(agen) -> List[Any]:
    return [c async for c in agen]


@pytest.mark.parametrize("entrypoint", ["central", "compatibility"])
@pytest.mark.parametrize("capture", [True, False])
def test_cache_replay_captures_actual_completion(mem, monkeypatch, tmp_path, entrypoint, capture):
    """The real replay and disk writer must retain current input and synthetic output."""
    from helpers import observability
    from providers.rose.client import RoseClient

    monkeypatch.setattr(observability, "_DUMP_ROOT", tmp_path)
    monkeypatch.setattr(observability, "_IS_PRODUCTION", False)
    monkeypatch.setattr(observability, "archive_json", lambda **kwargs: None)
    agent_id = "replay-evidence-contract"
    messages = [{"role": "user", "content": "Current replay request"}]
    tools = [{"type": "function", "function": {"name": "set_plan", "parameters": {"type": "object"}}}]
    kwargs = dict(
        pool="rose-1-ultra",
        messages=messages,
        tools=tools,
        agent_id=agent_id,
        provider_fast_mode=True,
        dump_context=capture,
    )
    stored = rose_cache.empty_response()
    for chunk in _full_stream():
        rose_cache.accumulate_chunk(stored, chunk)

    async def body():
        context = FastCacheContext(enabled=True, goal="evidence contract", write_enabled=False)
        set_context(context)
        key = context.llm_key("execute_loop", rose_cache.request_key_material(kwargs))
        mem.data[key] = stored
        client = RoseClient(openrouter_key="must-not-call-live")

        async def forbid_live(**_kwargs):
            raise AssertionError("a replay must never call a live provider")
            yield  # pragma: no cover

        monkeypatch.setattr(client, "_complete_impl", forbid_live)
        expected = await _drain(rose_cache.replay(stored))
        stream = (
            client.complete(call_site="execute_loop", **kwargs)
            if entrypoint == "central"
            else rose_cache.cached_complete(client, call_site="execute_loop", **kwargs)
        )
        chunks = await _drain(stream)
        assert chunks == expected
        assert mem.set_calls == 0
        return key

    key = asyncio.run(body())
    dumps = list(tmp_path.rglob("*.json"))
    assert len(dumps) == int(capture)
    if capture:
        dump = json.loads(dumps[0].read_text())
        assert dump["agent_id"] == agent_id
        assert dump["messages"] == messages
        assert dump["tools"] == tools
        assert dump["extra"]["completion_source"] == "fast_cache"
        assert dump["extra"]["cache_key"] == key
        assert dump["output"]["actual_model"] == "fast-cache"
        assert dump["output"]["content"] == "Hello world"
        assert dump["output"]["tool_calls"] == stored["tool_calls"]
        assert dump["output"]["usage"]["completion_tokens"] == 0
        assert dump["output"]["replay_complete"] is True


@pytest.mark.parametrize("entrypoint", ["central", "compatibility"])
def test_cache_passthrough_dump_is_labeled(mem, monkeypatch, tmp_path, entrypoint):
    from helpers import observability
    from providers.rose.client import RoseClient

    monkeypatch.setattr(observability, "_DUMP_ROOT", tmp_path)
    monkeypatch.setattr(observability, "_IS_PRODUCTION", False)
    monkeypatch.setattr(observability, "archive_json", lambda **kwargs: None)

    async def body():
        set_context(FastCacheContext(enabled=True, goal=_soft_complete_bench_goal()))
        client = RoseClient(openrouter_key="must-not-call-live")
        kwargs = dict(
            pool="rose-1-ultra",
            agent_id="passthrough-contract",
            messages=[{"role": "user", "content": "Current completion context"}],
        )
        stream = (
            client.complete(call_site="completion_summary", **kwargs)
            if entrypoint == "central"
            else rose_cache.cached_complete(client, call_site="completion_summary", **kwargs)
        )
        chunks = await _drain(stream)
        assert chunks[-1].kind == "done"

    asyncio.run(body())
    dumps = list(tmp_path.rglob("*.json"))
    assert len(dumps) == 1
    dump = json.loads(dumps[0].read_text())
    assert dump["extra"]["completion_source"] == "fast_cache"
    assert dump["extra"]["replay_reason"] == "fm_terminal_passthrough"
    assert dump["extra"]["cache_hit_key"] == "terminal_passthrough"
    assert dump["output"]["actual_model"] == "fast-cache"
    assert dump["output"]["replay_complete"] is True


@pytest.mark.parametrize("entrypoint", ["central", "compatibility"])
def test_cache_dump_marks_consumer_abandonment(mem, monkeypatch, tmp_path, entrypoint):
    from helpers import observability
    from providers.rose.client import RoseClient

    monkeypatch.setattr(observability, "_DUMP_ROOT", tmp_path)
    monkeypatch.setattr(observability, "_IS_PRODUCTION", False)
    monkeypatch.setattr(observability, "archive_json", lambda **kwargs: None)

    async def body():
        ctx = FastCacheContext(enabled=True, goal="abandonment contract", write_enabled=False)
        set_context(ctx)
        kwargs = dict(pool="rose-1-ultra", agent_id="abandoned-contract", messages=[])
        key = ctx.llm_key("execute_loop", rose_cache.request_key_material({**kwargs, "provider_fast_mode": True}))
        mem.data[key] = {"content": "not consumed"}
        client = RoseClient(openrouter_key="must-not-call-live")
        stream = (
            client.complete(call_site="execute_loop", **kwargs)
            if entrypoint == "central"
            else rose_cache.cached_complete(client, call_site="execute_loop", **kwargs)
        )
        assert (await anext(stream)).kind == "metadata"
        await stream.aclose()
        # Check before event-loop shutdown/GC can finalize a leaked inner iterator.
        dump = json.loads(next(tmp_path.rglob("*.json")).read_text())
        assert dump["output"]["replay_complete"] is False
        assert dump["output"]["content"] == ""

    asyncio.run(body())


@pytest.mark.parametrize("failure", ["start", "finish"])
def test_cache_dump_failure_preserves_stream(monkeypatch, failure):
    from helpers import observability

    def fail(**kwargs):
        raise OSError("capture unavailable")

    monkeypatch.setattr(observability, "dump_llm_context", fail if failure == "start" else lambda **kwargs: "dump")
    monkeypatch.setattr(observability, "update_llm_dump", lambda *args, **kwargs: fail())

    async def body():
        stored = {"content": "unchanged response"}
        expected = await _drain(rose_cache.replay(stored))
        actual = await _drain(
            rose_cache.replay_with_context(
                stored,
                call_site="execute_loop",
                cache_key="key",
                hit_key="key",
                complete_kwargs={"agent_id": "failure-contract", "messages": []},
            )
        )
        assert actual == expected

    asyncio.run(body())


# ---------------------------------------------------------------------------
# Normalization / keys  (anti-bust, exact-match, PII)
# ---------------------------------------------------------------------------


def test_url_normalization_collapses_cache_busters():
    # #15 cache-busting query drift must not bust the key.
    a = normalize.normalize_url("https://Example.com/path/?utm_source=x&cb=123&b=2&a=1#frag")
    b = normalize.normalize_url("https://example.com/path?a=1&b=2&cb=999999&gclid=zzz")
    assert a == b == "https://example.com/path?a=1&b=2"


def test_browser_http_key_stable_across_busters():
    # #15 same logical request → same key despite volatile params.
    k1 = normalize.browser_http_key("goal", "GET", "https://s.com/a?_=1&q=hi")
    k2 = normalize.browser_http_key("goal", "get", "https://s.com/a?q=hi&_=99999")
    assert k1 == k2


def test_browser_http_key_reuses_public_gets_across_goals():
    assert normalize.browser_http_key("goal-a", "GET", "https://s.com/a?q=hi") == normalize.browser_http_key(
        "goal-b", "GET", "https://s.com/a?q=hi"
    )


def test_browser_http_key_partitions_authenticated_requests():
    public = normalize.browser_http_key("goal-a", "GET", "https://s.com/a?q=hi")
    auth_a = normalize.browser_http_key("goal-b", "GET", "https://s.com/a?q=hi", {"Cookie": "sid=a"})
    auth_b = normalize.browser_http_key("goal-b", "GET", "https://s.com/a?q=hi", {"Cookie": "sid=b"})
    assert public != auth_a
    assert auth_a != auth_b


def test_browser_http_post_key_is_goal_scoped_endpoint_replay():
    a = normalize.browser_http_key("goal", "POST", "https://s.com/api", body='{"b":2,"a":1}')
    b = normalize.browser_http_key("goal", "post", "https://s.com/api", body='{"a":1,"b":2}')
    c = normalize.browser_http_key("other goal", "POST", "https://s.com/api", body='{"a":1,"b":2}')
    assert a == b
    assert a != c


def test_web_provider_keys_are_global_across_goals():
    assert normalize.web_search_key("goal-a", "Best cities to live in your 20s", 100) == normalize.web_search_key(
        "goal-b", " best   cities to LIVE in your 20s ", 100
    )
    assert normalize.web_fetch_key("goal-a", "https://x.com/a?t=1") == normalize.web_fetch_key(
        "goal-b", "https://x.com/a?t=999"
    )
    assert normalize.web_search_key("goal-a", "query", 100).startswith("fastmode:v42:web_search:global:")
    assert normalize.web_fetch_key("goal-a", "https://x.com/a").startswith("fastmode:v42:web_fetch:global:")


def test_codex_key_from_hash_uses_canonical_request_fingerprint():
    assert normalize.codex_key_from_hash(
        "abc", {"input": [{"role": "user", "content": "hello"}]}
    ) == normalize.codex_key_from_hash("abc", {"input": [{"content": "hello", "role": "user"}]})
    assert normalize.codex_key_from_hash("abc", {"input": []}).startswith("fastmode:v42:codex:abc:c:")


def test_world_model_scope_empty_for_real_and_shadow_runs(monkeypatch):
    monkeypatch.delenv("BENCHMARK_WORLD_MODEL_MODE", raising=False)
    real_key = normalize.build_key("llm", "goal", "detail")
    assert real_key == f"fastmode:{normalize.CACHE_KEY_VERSION}:llm:{normalize.goal_hash('goal')}:detail"
    assert normalize.world_model_cache_scope() == ""
    # Shadow mode executes real calls — those cache entries are real signal.
    monkeypatch.setenv("BENCHMARK_WORLD_MODEL_MODE", "shadow")
    assert normalize.build_key("llm", "goal", "detail") == real_key


def test_world_model_scope_partitions_simulated_runs(monkeypatch):
    monkeypatch.delenv("BENCHMARK_WORLD_MODEL_MODE", raising=False)
    real_key = normalize.build_key("llm", "goal", "detail")
    real_global = normalize.build_global_key("web_fetch", "abc")
    real_codex = normalize.codex_key_from_hash("gh", {"input": []})

    monkeypatch.setenv("BENCHMARK_WORLD_MODEL_MODE", "simulate")
    monkeypatch.setenv("WMH_MODEL_NAME", "rose archive/v2")
    sim_key = normalize.build_key("llm", "goal", "detail")
    sim_global = normalize.build_global_key("web_fetch", "abc")
    sim_codex = normalize.codex_key_from_hash("gh", {"input": []})

    assert sim_key != real_key and sim_global != real_global and sim_codex != real_codex
    for key in (sim_key, sim_global, sim_codex):
        assert ":sim.rose-archive-v2:" in key

    # Different world models get different namespaces.
    monkeypatch.setenv("WMH_MODEL_NAME", "rose-archive-v3")
    assert normalize.build_key("llm", "goal", "detail") != sim_key


def test_canonical_messages_ignore_planner_memory_fork_churn():
    """Retrieved memories drift as the history table grows; they must not key planner replays."""

    def request(memory_block: str):
        return {
            "messages": [
                {"role": "system", "content": "static planner prompt"},
                {"role": "user", "content": "GOAL: same goal\n\nPlan this goal into tasks."},
                {
                    "role": "assistant",
                    "content": "Checking memories of similar past runs before planning.",
                    "tool_calls": [
                        {
                            "id": "call_getmem_abc",
                            "type": "function",
                            "function": {"name": "get_memories", "arguments": '{"query": "same goal", "k": 3}'},
                        }
                    ],
                },
                {"role": "tool", "tool_call_id": "call_getmem_abc", "name": "get_memories", "content": memory_block},
            ]
        }

    with_alpha = request(
        "# Memories of similar past runs\n\n## Memory 1 — PASSED — 2026-09-01 — similarity 0.80\nGoal: alpha"
    )
    with_beta = request(
        "# Memories of similar past runs\n\n## Memory 1 — PASSED — 2026-09-03 — similarity 0.61\nGoal: beta"
    )
    without_memories = {"messages": with_alpha["messages"][:2]}
    assert normalize.canonical_messages(with_alpha) == normalize.canonical_messages(with_beta)
    assert normalize.canonical_messages(with_alpha) == normalize.canonical_messages(without_memories)
    assert normalize.position_request_fingerprint({**with_alpha, "pool": "rose-1-ultra"}) == (
        normalize.position_request_fingerprint({**with_beta, "pool": "rose-1-ultra"})
    )
    assert normalize.position_request_fingerprint({**with_alpha, "pool": "rose-1-ultra"}) == (
        normalize.position_request_fingerprint({**without_memories, "pool": "rose-1-ultra"})
    )
    # A genuinely different user turn still changes the key.
    different = request("# Memories of similar past runs\n\nGoal: alpha")
    different["messages"][1] = {"role": "user", "content": "unrelated user turn"}
    assert normalize.canonical_messages(with_alpha) != normalize.canonical_messages(different)


def test_canonical_messages_preserve_transcript_shaped_nested_payloads():
    """Memory-fork stripping applies only to the provider's top-level message list."""

    def request(memory_block: str):
        return [
            {
                "role": "user",
                "content": [
                    {
                        "role": "assistant",
                        "tool_calls": [
                            {
                                "id": "nested_getmem",
                                "type": "function",
                                "function": {"name": "get_memories", "arguments": "{}"},
                            }
                        ],
                    },
                    {
                        "role": "tool",
                        "tool_call_id": "nested_getmem",
                        "name": "get_memories",
                        "content": memory_block,
                    },
                ],
            }
        ]

    assert normalize.canonical_messages(request("nested alpha")) != normalize.canonical_messages(request("nested beta"))


def test_canonical_messages_ignore_separate_dynamic_user_context_system_message_churn():
    def request(recent_message: str, integrations: list[str], user_text: str = "same goal"):
        return {
            "messages": [
                {"role": "system", "content": "static system prompt"},
                {
                    "role": "system",
                    "content": (
                        "# User Context\n\n"
                        "## User Profile\nName: Andy\n\n"
                        "## Connected Integrations\n"
                        + "\n".join(f"- {name}" for name in integrations)
                        + "\n\n## Recent Communications\n"
                        + recent_message
                        + "\n\n## User Network\nAman | daily | 359 msgs\n"
                    ),
                },
                {"role": "user", "content": user_text},
            ]
        }

    assert normalize.canonical_messages(
        request(
            "[IMESSAGE] 2026-06-26 01:51 | Started a different task",
            ["chrome", "gpt_code", "chrome_passwords"],
        )
    ) == normalize.canonical_messages(
        request(
            "[IMESSAGE] 2026-06-26 01:56 | New message arrived",
            ["chrome", "chrome_passwords", "gpt_code"],
        )
    )
    assert normalize.canonical_messages(
        request("same context", ["chrome"], "same goal")
    ) != normalize.canonical_messages(request("same context", ["chrome"], "different goal"))


def test_codex_key_normalizes_run_local_rose_agent_repo_identity():
    def request(repo_slug: str, color: str = "green"):
        return {
            "instructions": (
                "Repository workflow:\n"
                f"- The repository is cloned at /home/user/{repo_slug}.\n"
                f"- Remote: https://github.com/rose-gh-agent/{repo_slug}.git\n"
            ),
            "input": [
                {
                    "type": "function_call_output",
                    "output": (
                        "Chunk ID: abc123\n"
                        "Wall time: 0.0000 seconds\n"
                        "Process exited with code 0\n"
                        "Original token count: 12\n"
                        "Output:\n"
                        f"/home/user/{repo_slug}\n"
                        f"origin\thttps://x-access-token:secret@github.com/rose-gh-agent/{repo_slug}.git (fetch)\n"
                        f"origin\thttps://github.com/rose-gh-agent/{repo_slug}.git (push)\n"
                        f"created /home/user/{repo_slug}/output/rs_{color}.png\n"
                    ),
                }
            ],
        }

    assert normalize.codex_key_from_hash("abc", request("agent-b913fbea")) == normalize.codex_key_from_hash(
        "abc", request("agent-af3a523b")
    )
    assert normalize.codex_key_from_hash("abc", request("agent-b913fbea")) != normalize.codex_key_from_hash(
        "abc", request("agent-af3a523b", "yellow")
    )


def test_codex_key_ignores_responses_api_volatile_ids_and_encrypted_blobs():
    a = {
        "previous_response_id": "resp_1234567890abcdef",
        "input": [
            {
                "id": "rs_1234567890abcdef",
                "type": "reasoning",
                "encrypted_content": "opaque-a",
            },
            {
                "id": "msg_1234567890abcdef",
                "type": "message",
                "content": [{"type": "input_text", "text": "command output: 111 steps"}],
            },
        ],
    }
    b = {
        "previous_response_id": "resp_fedcba0987654321",
        "input": [
            {
                "id": "rs_fedcba0987654321",
                "type": "reasoning",
                "encrypted_content": "opaque-b",
            },
            {
                "id": "msg_fedcba0987654321",
                "type": "message",
                "content": [{"type": "input_text", "text": "command output: 111 steps"}],
            },
        ],
    }
    changed = {
        **b,
        "input": [
            b["input"][0],
            {
                "id": "msg_fedcba0987654321",
                "type": "message",
                "content": [{"type": "input_text", "text": "command output: 112 steps"}],
            },
        ],
    }
    assert normalize.codex_key_from_hash("abc", a) == normalize.codex_key_from_hash("abc", b)
    assert normalize.codex_key_from_hash("abc", a) != normalize.codex_key_from_hash("abc", changed)


def test_codex_key_normalizes_command_wrapper_noise_and_path_listing_order():
    a = {
        "input": [
            {
                "type": "function_call_output",
                "output": (
                    "Chunk ID: abc123\n"
                    "Wall time: 0.0000 seconds\n"
                    "Process exited with code 0\n"
                    "Original token count: 12\n"
                    "Output:\n"
                    "/home/user/b.txt\n"
                    "/home/user/a.txt\n"
                ),
            }
        ]
    }
    b = {
        "input": [
            {
                "type": "function_call_output",
                "output": (
                    "Chunk ID: def456\n"
                    "Wall time: 0.1234 seconds\n"
                    "Process exited with code 0\n"
                    "Original token count: 99\n"
                    "Output:\n"
                    "/home/user/a.txt\n"
                    "/home/user/b.txt\n"
                ),
            }
        ]
    }
    ordered_program_output = {
        "input": [
            {
                "type": "function_call_output",
                "output": (
                    "Chunk ID: def456\n"
                    "Wall time: 0.1234 seconds\n"
                    "Process exited with code 0\n"
                    "Original token count: 99\n"
                    "Output:\n"
                    "2\n"
                    "1\n"
                ),
            }
        ]
    }
    changed_program_output = {
        "input": [
            {
                "type": "function_call_output",
                "output": (
                    "Chunk ID: zzz999\n"
                    "Wall time: 0.1234 seconds\n"
                    "Process exited with code 0\n"
                    "Original token count: 99\n"
                    "Output:\n"
                    "1\n"
                    "2\n"
                ),
            }
        ]
    }
    assert normalize.codex_key_from_hash("abc", a) == normalize.codex_key_from_hash("abc", b)
    assert normalize.codex_key_from_hash("abc", ordered_program_output) != normalize.codex_key_from_hash(
        "abc", changed_program_output
    )


def test_codex_key_normalizes_timestamped_path_listings():
    a = {
        "input": [
            {
                "type": "function_call_output",
                "output": (
                    "Chunk ID: paths\n"
                    "Wall time: 0.0000 seconds\n"
                    "Process exited with code 0\n"
                    "Original token count: 8\n"
                    "Output:\n"
                    "1782435343.0029090300 /home/user/b.txt\n"
                    "1782435211.8108716460 /home/user/a.txt\n"
                ),
            }
        ]
    }
    b = {
        "input": [
            {
                "type": "function_call_output",
                "output": (
                    "Chunk ID: paths2\n"
                    "Wall time: 0.0000 seconds\n"
                    "Process exited with code 0\n"
                    "Original token count: 8\n"
                    "Output:\n"
                    "1782435999.1234567890 /home/user/a.txt\n"
                    "1782435888.1234567890 /home/user/b.txt\n"
                ),
            }
        ]
    }
    assert normalize.codex_key_from_hash("abc", a) == normalize.codex_key_from_hash("abc", b)


def test_codex_key_normalizes_iso_timestamps_inside_command_output():
    def request(timestamp: str, cwd: str = "/home/user"):
        return {
            "input": [
                {
                    "type": "function_call_output",
                    "output": (
                        "Chunk ID: date\n"
                        "Wall time: 0.0000 seconds\n"
                        "Process exited with code 0\n"
                        "Original token count: 6\n"
                        "Output:\n"
                        f"{cwd}\n"
                        f"{timestamp}\n"
                    ),
                }
            ]
        }

    assert normalize.codex_key_from_hash("abc", request("2026-06-26T01:38:50Z")) == normalize.codex_key_from_hash(
        "abc", request("2026-06-26T01:42:37Z")
    )
    assert normalize.codex_key_from_hash("abc", request("2026-06-26T01:38:50Z")) != normalize.codex_key_from_hash(
        "abc", request("2026-06-26T01:38:50Z", "/tmp")
    )


def test_codex_key_normalizes_empty_successful_output_and_empty_running_output():
    exited = {
        "input": [
            {
                "type": "function_call_output",
                "output": (
                    "Chunk ID: done\n"
                    "Wall time: 0.0000 seconds\n"
                    "Process exited with code 0\n"
                    "Original token count: 0\n"
                    "Output:\n"
                ),
            }
        ]
    }
    running = {
        "input": [
            {
                "type": "function_call_output",
                "output": (
                    "Chunk ID: running\n"
                    "Wall time: 1.0000 seconds\n"
                    "Process running with session ID 24656\n"
                    "Original token count: 1\n"
                    "Output:\n"
                ),
            }
        ]
    }
    changed = {
        "input": [
            {
                "type": "function_call_output",
                "output": (
                    "Chunk ID: done\n"
                    "Wall time: 0.0000 seconds\n"
                    "Process exited with code 0\n"
                    "Original token count: 1\n"
                    "Output:\n"
                    "created file\n"
                ),
            }
        ]
    }
    assert normalize.codex_key_from_hash("abc", exited) == normalize.codex_key_from_hash("abc", running)
    assert normalize.codex_key_from_hash("abc", exited) != normalize.codex_key_from_hash("abc", changed)


def test_codex_key_normalizes_live_process_polling_noise():
    def request(session_id: int, partial_output: str, yield_time_ms: int = 1000):
        return {
            "prompt_cache_key": "019f015c-6bea-7f21-aecc-68fd35ec53d2",
            "client_metadata": {
                "x-codex-installation-id": "11111111-1111-4111-8111-111111111111",
            },
            "input": [
                {
                    "type": "function_call",
                    "name": "write_stdin",
                    "arguments": json.dumps({"session_id": session_id, "chars": "", "yield_time_ms": yield_time_ms}),
                },
                {
                    "type": "function_call_output",
                    "output": (
                        "Chunk ID: abc123\n"
                        "Wall time: 1.0008 seconds\n"
                        f"Process running with session ID {session_id}\n"
                        "Original token count: 12\n"
                        "Output:\n"
                        f"{partial_output}"
                    ),
                },
                {
                    "type": "function_call_output",
                    "output": (
                        "Chunk ID: shell\n"
                        "Wall time: 0.0000 seconds\n"
                        "Process exited with code 0\n"
                        "Original token count: 7\n"
                        "Output:\n"
                        "/home/user/.codex/shell_snapshots/"
                        "11111111-1111-4111-8111-111111111111.1782434262046559997.sh\n"
                    ),
                },
            ],
        }

    cold = request(10036, "Collecting pillow\n Downloading pillow-12.2.0.whl (7.1 MB)\n", 30000)
    hot = request(24656, "")
    changed_final_output = {
        **hot,
        "input": [
            hot["input"][0],
            hot["input"][1],
            {
                "type": "function_call_output",
                "output": (
                    "Chunk ID: final\n"
                    "Wall time: 0.0000 seconds\n"
                    "Process exited with code 0\n"
                    "Original token count: 4\n"
                    "Output:\n"
                    "created red file\n"
                ),
            },
        ],
    }

    assert normalize.codex_key_from_hash("abc", cold) == normalize.codex_key_from_hash("abc", hot)
    assert normalize.codex_key_from_hash("abc", hot) != normalize.codex_key_from_hash("abc", changed_final_output)


def test_codex_key_normalizes_stale_process_id_failures():
    a = {
        "input": [
            {
                "type": "function_call_output",
                "output": "write_stdin failed: Unknown process id 86634",
            }
        ]
    }
    b = {
        "input": [
            {
                "type": "function_call_output",
                "output": "write_stdin failed: Unknown process id 15144",
            }
        ]
    }
    assert normalize.codex_key_from_hash("abc", a) == normalize.codex_key_from_hash("abc", b)


def test_codex_key_strips_npm_update_notices_from_command_output():
    a = {
        "input": [
            {
                "type": "function_call_output",
                "output": (
                    "Chunk ID: abc123\n"
                    "Wall time: 0.0000 seconds\n"
                    "Process exited with code 0\n"
                    "Original token count: 2\n"
                    "Output:\n"
                    "2.1.193\n"
                ),
            }
        ]
    }
    b = {
        "input": [
            {
                "type": "function_call_output",
                "output": (
                    "Chunk ID: def456\n"
                    "Wall time: 0.5809 seconds\n"
                    "Process exited with code 0\n"
                    "Original token count: 55\n"
                    "Output:\n"
                    "2.1.193\n"
                    "npm notice\n"
                    "npm notice New major version of npm available! 10.8.2 -> 11.17.0\n"
                    "npm notice Changelog: https://github.com/npm/cli/releases/tag/v11.17.0\n"
                    "npm notice To update run: npm install -g npm@11.17.0\n"
                    "npm notice\n"
                ),
            }
        ]
    }
    assert normalize.codex_key_from_hash("abc", a) == normalize.codex_key_from_hash("abc", b)


def test_codex_key_normalizes_ls_long_listing_mtimes():
    a = {
        "input": [
            {
                "type": "function_call_output",
                "output": (
                    "Chunk ID: abc123\n"
                    "Wall time: 0.0000 seconds\n"
                    "Process exited with code 0\n"
                    "Original token count: 12\n"
                    "Output:\n"
                    "/home/user:\n"
                    "total 64\n"
                    "drwxr-xr-x 6 user user 4.0K Jun 25 05:57 .\n"
                    "-rw-r--r-- 1 user user 900 Jun 25 05:57 AGENTS.md\n"
                ),
            }
        ]
    }
    b = {
        "input": [
            {
                "type": "function_call_output",
                "output": (
                    "Chunk ID: def456\n"
                    "Wall time: 0.1234 seconds\n"
                    "Process exited with code 0\n"
                    "Original token count: 99\n"
                    "Output:\n"
                    "/home/user:\n"
                    "total 64\n"
                    "drwxr-xr-x 6 user user 4.0K Jun 25 06:12 .\n"
                    "-rw-r--r-- 1 user user 900 Jun 25 06:12 AGENTS.md\n"
                ),
            }
        ]
    }
    changed = {
        "input": [
            {
                "type": "function_call_output",
                "output": (
                    "Chunk ID: zzz999\n"
                    "Wall time: 0.1234 seconds\n"
                    "Process exited with code 0\n"
                    "Original token count: 99\n"
                    "Output:\n"
                    "/home/user:\n"
                    "total 64\n"
                    "drwxr-xr-x 6 user user 4096 Jun 25 06:12 .\n"
                    "-rw-r--r-- 1 user user 901 Jun 25 06:12 AGENTS.md\n"
                ),
            }
        ]
    }
    assert normalize.codex_key_from_hash("abc", a) == normalize.codex_key_from_hash("abc", b)
    assert normalize.codex_key_from_hash("abc", a) != normalize.codex_key_from_hash("abc", changed)


def test_codex_key_normalizes_package_download_progress_rates():
    a = {
        "input": [
            {
                "type": "function_call_output",
                "output": (
                    "Chunk ID: abc123\n"
                    "Wall time: 1.0008 seconds\n"
                    "Process running with session ID 85557\n"
                    "Original token count: 12\n"
                    "Output:\n"
                    "Collecting Pillow\n"
                    " Downloading pillow-12.2.0.whl (7.1 MB)\n"
                    " ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 7.1/7.1 MB 63.3 MB/s eta 0:00:00\n"
                ),
            }
        ]
    }
    b = {
        "input": [
            {
                "type": "function_call_output",
                "output": (
                    "Chunk ID: def456\n"
                    "Wall time: 1.0011 seconds\n"
                    "Process running with session ID 31569\n"
                    "Original token count: 12\n"
                    "Output:\n"
                    "Collecting Pillow\n"
                    " Downloading pillow-12.2.0.whl (7.1 MB)\n"
                    " ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 7.1/7.1 MB 57.3 MB/s eta 0:00:00\n"
                ),
            }
        ]
    }
    changed = {
        "input": [
            {
                "type": "function_call_output",
                "output": (
                    "Chunk ID: def456\n"
                    "Wall time: 1.0011 seconds\n"
                    "Process exited with code 0\n"
                    "Original token count: 12\n"
                    "Output:\n"
                    "Collecting numpy\n"
                    " Downloading numpy.whl (18.0 MB)\n"
                    " ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 18.0/18.0 MB 57.3 MB/s eta 0:00:00\n"
                ),
            }
        ]
    }
    assert normalize.codex_key_from_hash("abc", a) == normalize.codex_key_from_hash("abc", b)
    assert normalize.codex_key_from_hash("abc", a) != normalize.codex_key_from_hash("abc", changed)


def test_codex_key_normalizes_completed_package_manager_progress_noise():
    def pip(rate: str, prefix: str, success: str):
        return {
            "input": [
                {
                    "type": "function_call_output",
                    "output": (
                        "Chunk ID: pkg\n"
                        "Wall time: 4.2210 seconds\n"
                        "Process exited with code 0\n"
                        "Original token count: 120\n"
                        "Output:\n"
                        f"{prefix}"
                        f" ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 7.1/7.1 MB {rate} eta 0:00:00\n"
                        "Installing collected packages: Pillow\n"
                        f"{success}\n"
                    ),
                }
            ]
        }

    def npm(duration: str, warn: bool = False):
        return {
            "input": [
                {
                    "type": "function_call_output",
                    "output": (
                        "Chunk ID: npm\n"
                        "Wall time: 5.2210 seconds\n"
                        "Process exited with code 0\n"
                        "Original token count: 80\n"
                        "Output:\n\n"
                        + ("npm warn deprecated phin@3.7.1: Package no longer supported.\n" if warn else "")
                        + f"added 9 packages, and audited 11 packages in {duration}\n\n"
                        + "3 packages are looking for funding\n"
                    ),
                }
            ]
        }

    assert normalize.codex_key_from_hash(
        "abc",
        pip(
            "63.3 MB/s",
            "Collecting Pillow\n Downloading pillow-12.2.0.whl (7.1 MB)\n",
            "Successfully installed Pillow-12.2.0",
        ),
    ) == normalize.codex_key_from_hash(
        "abc",
        pip(
            "42.1 MB/s",
            "Collecting Pillow\nCollecting numpy\n Downloading pillow-12.2.0.whl (7.1 MB)\n",
            "Successfully installed Pillow-12.2.0",
        ),
    )
    assert normalize.codex_key_from_hash(
        "abc",
        pip(
            "63.3 MB/s",
            "Collecting Pillow\n Downloading pillow-12.2.0.whl (7.1 MB)\n",
            "Successfully installed Pillow-12.2.0",
        ),
    ) != normalize.codex_key_from_hash(
        "abc",
        pip(
            "42.1 MB/s",
            "Collecting numpy\n Downloading numpy.whl (18.0 MB)\n",
            "Successfully installed numpy-2.2.6",
        ),
    )
    assert normalize.codex_key_from_hash("abc", npm("4s")) == normalize.codex_key_from_hash("abc", npm("883ms", True))


def test_codex_key_ignores_optional_pip_installing_status_lines():
    def request(include_installing_line: bool):
        return {
            "input": [
                {
                    "type": "function_call_output",
                    "output": (
                        "Chunk ID: pkg\n"
                        "Wall time: 4.2210 seconds\n"
                        "Process exited with code 0\n"
                        "Original token count: 80\n"
                        "Output:\n"
                        + ("Installing collected packages: Pillow\n" if include_installing_line else "")
                        + "Successfully installed Pillow-12.2.0\n"
                    ),
                }
            ]
        }

    assert normalize.codex_key_from_hash("abc", request(True)) == normalize.codex_key_from_hash("abc", request(False))


def test_canonical_messages_ignores_code_agent_heartbeat_status_updates():
    with_heartbeat = {
        "messages": [
            {
                "role": "tool",
                "content": (
                    "✓ Task Completed: **Status**: SUCCESS\n\n"
                    "**Actions Taken** (6 total, showing last 6):\n"
                    "  • Created E2B sandbox: <sandbox_id>\n"
                    "  • Status update at 30s\n"
                    "  • Agentic loop finished: 0 interactions\n"
                ),
            },
            {
                "role": "tool",
                "content": (
                    'TOOL_RESULT {"tool_name":"claude_code_history","result":"Execution Summary:\\n\\n'
                    "Created E2B sandbox: sandboxabc123\\nStatus update at 30s\\n"
                    'Agentic loop finished: 0 interactions"}'
                ),
            },
        ],
    }
    without_heartbeat = {
        "messages": [
            {
                "role": "tool",
                "content": (
                    "✓ Task Completed: **Status**: SUCCESS\n\n"
                    "**Actions Taken** (5 total, showing last 5):\n"
                    "  • Created E2B sandbox: <sandbox_id>\n"
                    "  • Agentic loop finished: 0 interactions\n"
                ),
            },
            {
                "role": "tool",
                "content": (
                    'TOOL_RESULT {"tool_name":"claude_code_history","result":"Execution Summary:\\n\\n'
                    'Created E2B sandbox: sandboxabc123\\nAgentic loop finished: 0 interactions"}'
                ),
            },
        ],
    }
    assert normalize.canonical_messages(with_heartbeat) == normalize.canonical_messages(without_heartbeat)


def test_canonical_messages_ignores_optional_code_agent_sandbox_action_line():
    with_sandbox_action = {
        "messages": [
            {
                "role": "tool",
                "content": (
                    "✓ Task Completed: **Status**: SUCCESS\n\n"
                    "**Actions Taken** (6 total, showing last 6):\n"
                    "  • Created E2B sandbox: <sandbox_id>\n"
                    "  • Uploaded 1 files to /home/user/attachments/\n"
                    "  • Agentic loop finished: 0 interactions\n"
                ),
            },
            {
                "role": "tool",
                "content": (
                    'TOOL_RESULT {"tool_name":"claude_code_history","result":"Execution Summary:\\n\\n'
                    "Created E2B sandbox: sandboxabc123\\nUploaded 1 files to /home/user/attachments/\\n"
                    'Agentic loop finished: 0 interactions"}'
                ),
            },
        ],
    }
    without_sandbox_action = {
        "messages": [
            {
                "role": "tool",
                "content": (
                    "✓ Task Completed: **Status**: SUCCESS\n\n"
                    "**Actions Taken** (5 total, showing last 5):\n"
                    "  • Uploaded 1 files to /home/user/attachments/\n"
                    "  • Agentic loop finished: 0 interactions\n"
                ),
            },
            {
                "role": "tool",
                "content": (
                    'TOOL_RESULT {"tool_name":"claude_code_history","result":"Execution Summary:\\n\\n'
                    'Uploaded 1 files to /home/user/attachments/\\nAgentic loop finished: 0 interactions"}'
                ),
            },
        ],
    }
    assert normalize.canonical_messages(with_sandbox_action) == normalize.canonical_messages(without_sandbox_action)


def test_goal_hash_is_exact_match():
    assert normalize.goal_hash("buy milk") == normalize.goal_hash("buy milk")
    assert normalize.goal_hash("buy milk") != normalize.goal_hash("buy MILK")


def test_llm_key_uses_canonical_request_fingerprint():
    ctx_a = FastCacheContext(enabled=True, goal="g")
    ctx_b = FastCacheContext(enabled=True, goal="g")
    assert ctx_a.llm_key("execute_loop", {"messages": [{"role": "user", "content": "hello"}]}) == ctx_b.llm_key(
        "execute_loop", {"messages": [{"content": "hello", "role": "user"}]}
    )
    assert ctx_a.llm_key("execute_loop", {"messages": [{"role": "user", "content": "hello"}]}) != ctx_b.llm_key(
        "execute_loop", {"messages": [{"role": "user", "content": "goodbye"}]}
    )


def test_llm_request_key_changes_when_pool_model_contract_changes(monkeypatch):
    ctx = FastCacheContext(enabled=True, goal="same goal", base_step=1)
    original_request = rose_cache.request_key_material({"pool": "rose-1-ultra"})
    original_key = ctx.llm_key("execute_loop", original_request)

    original_pool = POOL_REGISTRY["rose-1-ultra"]
    monkeypatch.setitem(
        POOL_REGISTRY,
        "rose-1-ultra",
        replace(original_pool, gpt_auth_model="gpt-next"),
    )
    changed_request = rose_cache.request_key_material({"pool": "rose-1-ultra"})

    assert ctx.llm_key("execute_loop", changed_request) != original_key


def test_llm_request_key_separates_context_tool_schemas():
    """Declared-only tools shape provider validity and must partition replay."""
    ctx = FastCacheContext(enabled=True, goal="same goal", base_step=1)
    base = {
        "pool": "rose-1-ultra",
        "context_tools": [
            {
                "name": "history_tool",
                "description": "Legalizes native history",
                "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}},
            }
        ],
    }
    reordered = {
        "pool": "rose-1-ultra",
        "context_tools": [
            {
                "input_schema": {"properties": {"query": {"type": "string"}}, "type": "object"},
                "description": "Legalizes native history",
                "name": "history_tool",
            }
        ],
    }
    changed = {
        **base,
        "context_tools": [{**base["context_tools"][0], "name": "different_history_tool"}],
    }

    base_key = ctx.llm_key("planner", rose_cache.request_key_material(base))
    assert ctx.llm_key("planner", rose_cache.request_key_material(reordered)) == base_key
    assert ctx.llm_key("planner", rose_cache.request_key_material(changed)) != base_key


def test_fable_51_pool_contract_shares_fable_5_fingerprint():
    """claudeAuth 5 → 5.1 must not miss the warm exact key (mass-agent p:1)."""
    shared = {
        "pool": "rose-1-ultra",
        "messages": [{"role": "system", "content": "static system"}],
        "tools": [{"name": "spawn_agent"}],
        "temperature": 0,
    }
    fable_5 = {
        **shared,
        "pool_contract": {
            "claude_auth_model": "claude-fable-5",
            "gpt_auth_model": "gpt-5.6-sol",
            "waterfall": ("openai/gpt-5.6-sol", "moonshotai/kimi-k3"),
        },
    }
    fable_51 = {
        **shared,
        "pool_contract": {
            "claude_auth_model": "claude-fable-5-1",
            "gpt_auth_model": "gpt-5.6-sol",
            "waterfall": ("openai/gpt-5.6-sol", "moonshotai/kimi-k3"),
        },
    }
    assert normalize.position_request_fingerprint(fable_5) == normalize.position_request_fingerprint(fable_51)
    assert normalize.oai_demo_position_request_fingerprint(fable_5) == (
        normalize.oai_demo_position_request_fingerprint(fable_51)
    )
    ctx = FastCacheContext(enabled=True, goal="same goal", base_step=1)
    assert ctx.llm_key("dag_param_populator", fable_5) == ctx.llm_key("dag_param_populator", fable_51)
    live = rose_cache.request_key_material({"pool": "rose-1-ultra"})
    assert live["pool_contract"]["claude_auth_model"] == "claude-opus-5-5"
    # Opus is a different family from Fable, so it must not collapse onto the
    # fable-5 fingerprint alias.
    aliased = dict(live)
    aliased["pool_contract"] = {
        **live["pool_contract"],
        "claude_auth_model": "claude-fable-5",
    }
    assert ctx.llm_key("dag_param_populator", live) != ctx.llm_key("dag_param_populator", aliased)


def test_llm_request_key_separates_anthropic_exclusion_policy(monkeypatch):
    monkeypatch.delenv("ROSE_EXCLUDE_ANTHROPIC_FAMILY", raising=False)
    ctx = FastCacheContext(enabled=True, goal="same goal", base_step=1)
    normal = rose_cache.request_key_material({"pool": "rose-1-ultra"})
    excluded = rose_cache.request_key_material({"pool": "rose-1-ultra", "_exclude_anthropic_family": True})

    assert ctx.llm_key("execute_loop", normal) != ctx.llm_key("execute_loop", excluded)


def test_llm_request_key_resolves_environment_provider_policy(monkeypatch):
    """Outer cached_complete and RoseClient.complete must fingerprint one policy."""
    monkeypatch.setenv("ROSE_EXCLUDE_ANTHROPIC_FAMILY", "1")
    implicit = rose_cache.request_key_material({"pool": "rose-1-ultra"})
    explicit = rose_cache.request_key_material({"pool": "rose-1-ultra", "_exclude_anthropic_family": True})

    assert implicit == explicit


def test_position_llm_key_ignores_prior_tool_outputs_but_keeps_static_prompt():
    ctx = FastCacheContext(enabled=True, goal="same coding-agent goal", base_step=2)
    base_request = {
        "pool": "rose-1-ultra",
        "messages": [
            {"role": "system", "content": "Static system prompt v1"},
            {"role": "user", "content": "same coding-agent goal"},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "call_a", "function": {"name": "spawn_agent"}}]},
            {"role": "tool", "tool_call_id": "call_a", "content": "file_pointer=abc duration=91s"},
            {"role": "system", "content": "Created E2B sandbox: sbx_live_123"},
        ],
        "tools": [{"name": "spawn_agent"}],
        "response_schema": {"type": "object", "properties": {"ok": {"type": "boolean"}}},
        "env_fingerprint": "node=22|npm=10",
    }
    noisy_request = {
        **base_request,
        "messages": [
            {"role": "system", "content": "Static system prompt v1"},
            {"role": "user", "content": "same coding-agent goal"},
            {"role": "assistant", "content": "different prior text"},
            {"role": "tool", "tool_call_id": "call_b", "content": "file_pointer=xyz duration=3s"},
            {"role": "system", "content": "Created E2B sandbox: sbx_hot_456"},
        ],
    }
    changed_prompt = {
        **base_request,
        "messages": [
            {"role": "system", "content": "Static system prompt v2"},
            *base_request["messages"][1:],
        ],
    }

    assert ctx.llm_key("execute_loop", base_request) == ctx.llm_key("execute_loop", noisy_request)
    assert ctx.llm_key("execute_loop", base_request) != ctx.llm_key("execute_loop", changed_prompt)
    assert ctx.llm_key("execute_loop", base_request) != FastCacheContext(
        enabled=True, goal="same coding-agent goal", base_step=3
    ).llm_key("execute_loop", base_request)


def test_position_llm_key_busts_when_user_attachment_metadata_changes():
    ctx = FastCacheContext(enabled=True, goal="tint the attached image red", base_step=1)
    image_only = {
        "pool": "rose-1-ultra",
        "messages": [
            {"role": "system", "content": "Static system prompt v1"},
            {"role": "user", "content": "Make this image completely red-tinted."},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "[timestamp] "},
                    {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,/9j/AAAA"}},
                ],
            },
        ],
        "tools": [{"name": "spawn_agent"}],
    }
    with_metadata = {
        **image_only,
        "messages": [
            image_only["messages"][0],
            image_only["messages"][1],
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": (
                            "[timestamp] \n\nfile_pointer:\n"
                            "  original_filename: rs.jpeg\n"
                            "  mime_type: image/jpeg\n"
                            "  size: 202.5 KB\n"
                        ),
                    },
                    {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,/9j/BBBB"}},
                ],
            },
        ],
    }
    noisy_tool_history = {
        **with_metadata,
        "messages": [
            *with_metadata["messages"],
            {"role": "assistant", "content": "", "tool_calls": [{"id": "call_a", "function": {"name": "spawn_agent"}}]},
            {"role": "tool", "tool_call_id": "call_a", "content": "explore returned test.png"},
        ],
    }

    assert ctx.llm_key("execute_loop", image_only) != ctx.llm_key("execute_loop", with_metadata)
    assert ctx.llm_key("execute_loop", with_metadata) == ctx.llm_key("execute_loop", noisy_tool_history)


def test_position_llm_key_unchanged_when_only_assistant_tool_history_differs():
    ctx = FastCacheContext(enabled=True, goal="plain coding task", base_step=1)
    request = {
        "pool": "rose-1-ultra",
        "messages": [
            {"role": "system", "content": "Static system prompt v1"},
            {"role": "user", "content": "Refactor the helper module."},
            {"role": "assistant", "content": "done"},
        ],
        "tools": [{"name": "spawn_agent"}],
    }
    noisy = {
        **request,
        "messages": [
            request["messages"][0],
            {"role": "user", "content": "Refactor the helper module."},
            {"role": "assistant", "content": "different prior text"},
            {"role": "tool", "tool_call_id": "call_x", "content": "noisy tool output"},
        ],
    }
    assert ctx.llm_key("execute_loop", request) == ctx.llm_key("execute_loop", noisy)


def test_position_llm_key_busts_when_user_goal_changes():
    ctx = FastCacheContext(enabled=True, goal="tint the attached image red", base_step=1)
    base = {
        "pool": "rose-1-ultra",
        "messages": [
            {"role": "system", "content": "Static system prompt v1"},
            {"role": "user", "content": "Make this image completely red-tinted."},
        ],
        "tools": [{"name": "spawn_agent"}],
    }
    changed_goal = {
        **base,
        "messages": [
            base["messages"][0],
            {"role": "user", "content": "Make this image completely blue-tinted."},
        ],
    }
    assert ctx.llm_key("execute_loop", base) != ctx.llm_key("execute_loop", changed_goal)


def test_position_llm_key_ignores_completion_summary_structured_output_block():
    ctx = FastCacheContext(enabled=True, goal="same coding-agent goal", base_step=0)
    cold_request = {
        "pool": "rose-1-flash",
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are summarizing the work completed by an AI agent.\n\n"
                    "ORIGINAL GOAL: same coding-agent goal\n\n"
                    "STRUCTURED OUTPUT DELIVERED:\n"
                    "- Approach Note: Used a luminance-based sapphire remap.\n"
                    "- Variant File: {'created_at': '2026-06-26T04:32:24.274Z', "
                    "'id': '11111111-1111-4111-8111-111111111111', "
                    "'storage_path': '11111111-1111-4111-8111-111111111111/"
                    "22222222-2222-4222-8222-222222222222_rs_sapphire_variant.png'}\n\n\n"
                    "Write a BRIEF 1-2 sentence summary of what was accomplished."
                ),
            },
            {"role": "assistant", "content": "prior live output A"},
            {
                "role": "user",
                "content": "Provide a brief 1-2 sentence summary of what was accomplished. Plain text only, no markdown.",
            },
        ],
    }
    hot_request = {
        **cold_request,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are summarizing the work completed by an AI agent.\n\n"
                    "ORIGINAL GOAL: same coding-agent goal\n\n"
                    "STRUCTURED OUTPUT DELIVERED:\n"
                    "- Approach Note: Used a luminance-based sapphire remap with engraved detail.\n"
                    "- Variant File: {'created_at': '2026-06-26T04:36:32.304Z', "
                    "'id': '33333333-3333-4333-8333-333333333333', "
                    "'storage_path': '33333333-3333-4333-8333-333333333333/"
                    "44444444-4444-4444-8444-444444444444_rs_sapphire_variant.png'}\n\n\n"
                    "Write a BRIEF 1-2 sentence summary of what was accomplished."
                ),
            },
            {"role": "assistant", "content": "prior live output B"},
            cold_request["messages"][-1],
        ],
    }
    changed_static_prompt = {
        **cold_request,
        "messages": [
            {
                "role": "system",
                "content": cold_request["messages"][0]["content"].replace("Write a BRIEF", "Write a DETAILED"),
            }
        ],
    }

    assert ctx.llm_key("completion_summary", cold_request) == ctx.llm_key("completion_summary", hot_request)
    assert ctx.llm_key("completion_summary", cold_request) != ctx.llm_key("completion_summary", changed_static_prompt)


def test_llm_key_ignores_browser_step_index_in_call_site():
    ctx = FastCacheContext(enabled=True, goal="g")
    request = {"messages": [{"role": "user", "content": "same browser request"}]}
    assert ctx.llm_key("browser_use_step_2", request) == ctx.llm_key("browser_use_step_7", request)
    assert ":browser_use_step:c:" in ctx.llm_key("browser_use_step_2", request)


def test_canonical_messages_ignore_run_local_ids_and_timestamps():
    a = {
        "messages": [
            {
                "role": "user",
                "content": '[STATE: now=2026-06-24T18:28:00Z]\n\n[2026-06-24 18:28] Run the task.\nReference: <resolved-ref pointer="@ref:message:11111111-1111-4111-8111-111111111111" title="x">',
            },
            {
                "role": "tool",
                "tool_call_id": "toolu_01AAAAAAAAAAAAAAAAAAAAAA",
                "content": 'TOOL_RESULT {"tool_call_id":"toolu_01AAAAAAAAAAAAAAAAAAAAAA","id":"22222222-2222-4222-8222-222222222222"}',
            },
        ],
        "agent_id": "33333333-3333-4333-8333-333333333333",
        "span_id": "abcdef123456",
    }
    b = {
        "span_id": "fedcba654321",
        "agent_id": "44444444-4444-4444-8444-444444444444",
        "messages": [
            {
                "content": '[STATE: now=2026-06-24T18:34:00Z]\n\n[2026-06-24 18:34] Run the task.\nReference: <resolved-ref pointer="@ref:message:55555555-5555-4555-8555-555555555555" title="x">',
                "role": "user",
            },
            {
                "content": 'TOOL_RESULT {"tool_call_id":"toolu_01BBBBBBBBBBBBBBBBBBBBBB","id":"66666666-6666-4666-8666-666666666666"}',
                "tool_call_id": "toolu_01BBBBBBBBBBBBBBBBBBBBBB",
                "role": "tool",
            },
        ],
    }
    assert normalize.canonical_messages(a) == normalize.canonical_messages(b)


def test_canonical_messages_ignore_spawn_group_ids():
    a = {
        "messages": [
            {
                "role": "tool",
                "tool_call_id": "toolu_01AAAAAAAAAAAAAAAAAAAAAA",
                "content": "spawn complete",
                "metadata": {
                    "toolCallId": "toolu_01AAAAAAAAAAAAAAAAAAAAAA",
                    "spawnGroupId": "llm-turn:execute:1",
                    "subAgentIds": ["same-agent"],
                },
            }
        ]
    }
    b = {
        "messages": [
            {
                "role": "tool",
                "tool_call_id": "toolu_01BBBBBBBBBBBBBBBBBBBBBB",
                "content": "spawn complete",
                "metadata": {
                    "toolCallId": "toolu_01BBBBBBBBBBBBBBBBBBBBBB",
                    "spawnGroupId": "dag-task:2",
                    "subAgentIds": ["same-agent"],
                },
            }
        ]
    }

    assert normalize.canonical_messages(a) == normalize.canonical_messages(b)


def test_canonical_messages_normalizes_code_agent_runtime_noise():
    a = {
        "messages": [
            {
                "role": "tool",
                "content": (
                    'TOOL_RESULT {"tool_name":"code_agent_sdk_events","result":"{\\n'
                    '  \\"timestamp\\": \\"2026-06-25T04:08:16.913Z\\",\\n'
                    '  \\"sandbox_id\\": \\"ituiwnzr4eqea3lh6uhl1\\"\\n}"}\n\n'
                    "Created E2B sandbox: ituiwnzr4eqea3lh6uhl1"
                ),
            }
        ]
    }
    b = {
        "messages": [
            {
                "role": "tool",
                "content": (
                    'TOOL_RESULT {"tool_name":"code_agent_sdk_events","result":"{\\n'
                    '  \\"timestamp\\": \\"2026-06-25T04:16:27.334Z\\",\\n'
                    '  \\"sandbox_id\\": \\"i5lnhwwkqbm4pbdo02gm1\\"\\n}"}\n\n'
                    "Created E2B sandbox: i5lnhwwkqbm4pbdo02gm1"
                ),
            }
        ]
    }
    changed = {
        "messages": [
            {
                "role": "tool",
                "content": (
                    'TOOL_RESULT {"tool_name":"code_agent_sdk_events","result":"{\\n'
                    '  \\"timestamp\\": \\"2026-06-25T04:16:27.334Z\\",\\n'
                    '  \\"sandbox_id\\": \\"i5lnhwwkqbm4pbdo02gm1\\",\\n'
                    '  \\"stdout\\": \\"different result\\"\\n}"}'
                ),
            }
        ]
    }
    assert normalize.canonical_messages(a) == normalize.canonical_messages(b)
    assert normalize.canonical_messages(a) != normalize.canonical_messages(changed)


def test_canonical_messages_canonicalizes_code_agent_sdk_event_telemetry():
    def tool_result(payload):
        return "TOOL_RESULT " + json.dumps(
            {
                "tool_name": "code_agent_sdk_events",
                "tool_call_id": None,
                "result": "Code-agent SDK event JSON:\n\n" + json.dumps(payload, indent=2),
            }
        )

    cold_payload = {
        "code_agent_events": [
            {"type": "command", "raw_type": "item.started", "status": "started", "command": "/bin/bash -lc pwd"},
            {
                "type": "command",
                "raw_type": "item.started",
                "status": "started",
                "command": "/bin/bash -lc 'ls -la /home/user'",
            },
            {
                "type": "command",
                "raw_type": "item.completed",
                "status": "completed",
                "command": "/bin/bash -lc pwd",
                "exit_code": 0,
                "output": "/home/user\n",
            },
            {
                "type": "command",
                "raw_type": "item.completed",
                "status": "completed",
                "command": "/bin/bash -lc 'ls -la /home/user'",
                "exit_code": 0,
                "output": (
                    "/home/user:\n"
                    "total 64\n"
                    "drwxr-xr-x 6 user user 4096 Jun 25 06:11 .\n"
                    "-rw-r--r-- 1 user user 900 Jun 25 06:11 AGENTS.md\n"
                ),
            },
            {
                "type": "command",
                "raw_type": "item.completed",
                "status": "completed",
                "command": "python3 /home/user/output/collatz_27.py",
                "exit_code": 0,
                "output": "Total steps: 111\n",
            },
        ],
        "execution_summary": ["Created E2B sandbox: abc123sandbox", "Status update at 30s", "Extracted 1 output files"],
        "extracted_output_files": [{"path": "/home/user/output/collatz_27.py", "size_bytes": 484}],
    }
    hot_payload = {
        **cold_payload,
        "code_agent_events": [
            cold_payload["code_agent_events"][0],
            cold_payload["code_agent_events"][2],
            cold_payload["code_agent_events"][1],
            {
                **cold_payload["code_agent_events"][3],
                "output": (
                    "/home/user:\n"
                    "total 64\n"
                    "drwxr-xr-x 6 user user 4096 Jun 25 06:13 .\n"
                    "-rw-r--r-- 1 user user 900 Jun 25 06:13 AGENTS.md\n"
                ),
            },
            cold_payload["code_agent_events"][4],
        ],
        "execution_summary": ["Created E2B sandbox: different456sandbox", "Extracted 1 output files"],
    }
    changed_payload = {
        **hot_payload,
        "code_agent_events": [
            *hot_payload["code_agent_events"][:4],
            {**hot_payload["code_agent_events"][4], "output": "Total steps: 112\n"},
        ],
    }

    def request(payload):
        return {"messages": [{"role": "tool", "content": tool_result(payload)}]}

    assert normalize.canonical_messages(request(cold_payload)) == normalize.canonical_messages(request(hot_payload))
    assert normalize.canonical_messages(request(cold_payload)) != normalize.canonical_messages(request(changed_payload))


def test_canonical_messages_repairs_capped_raw_code_agent_sdk_event_text():
    payload = {
        "code_agent_events": [
            {
                "version": 1,
                "provider": "codex",
                "type": "command",
                "raw_type": "item.started",
                "status": "started",
                "command": "/bin/bash -lc pwd",
            },
            {
                "version": 1,
                "provider": "codex",
                "timestamp": "2026-06-25T23:14:31.127Z",
                "type": "command",
                "raw_type": "item.completed",
                "status": "completed",
                "command": "/bin/bash -lc pwd",
                "output": "/home/user\n",
                "exit_code": 0,
            },
            {
                "version": 1,
                "provider": "codex",
                "timestamp": "2026-06-25T23:15:18.137Z",
                "type": "final",
                "status": "completed",
                "exit_code": 0,
                "signal": None,
            },
        ],
        "extracted_output_files": [{"path": "/home/user/output/collatz_27.py", "size_bytes": 514}],
        "execution_summary": [
            "Created E2B sandbox: i57ri32j3jealyuuqwqhd",
            "Status update at 30s",
            "Extracted 1 output files",
        ],
    }
    full = json.dumps(payload, indent=2)
    started_idx = full.index('{\n      "version"')
    completed_idx = full.index('{\n      "version"', started_idx + 1)
    cold_text = "Code-agent SDK event JSON:\n\n" + full[started_idx:]
    hot_text = (
        "Code-agent SDK event JSON:\n\n"
        + ': "/bin/bash -lc pwd"\n    },\n    '
        + full[completed_idx:]
        .replace("2026-06-25T23:15:18.137Z", "2026-06-25T23:18:56.051Z")
        .replace("i57ri32j3jealyuuqwqhd", "ies64r770imeqmunyr0fr")
        .replace('    "Status update at 30s",\n', "")
    )
    changed_text = hot_text.replace("/home/user\\n", "/tmp\\n")

    def request(text):
        return {"messages": [{"role": "TOOL", "text": text}]}

    assert normalize.canonical_messages(request(cold_text)) == normalize.canonical_messages(request(hot_text))
    assert normalize.canonical_messages(request(cold_text)) != normalize.canonical_messages(request(changed_text))


def test_canonical_messages_normalizes_browser_result_dom_and_action_index_noise():
    base = {
        "messages": [
            {
                "role": "tool",
                "content": (
                    "Browser automation complete: **Status**: SUCCESS\n\n"
                    "**Actions Taken** (4 total, showing last 4):\n"
                    '  • click: {"action":"click","index":78,"params":{"index":78}}\n'
                    '  • input_text: {"action":"input_text","index":35,"params":{"index":35,"text":"benchmark-human@example.com"}}\n\n'
                    'TOOL_RESULT {"tool_name":"spawn_browser_agent","result":"  • click: {\\"action\\":\\"click\\",\\"index\\":78,\\"params\\":{\\"index\\":78}}"}\n'
                    "### DOM Tree (browser-extracted final-state page content)\n"
                    "[78]<div role=checkbox aria-checked=true />\n"
                    "|SHADOW(open)|[35]<input id=demo-email />\n"
                    'Token: eyJpcF9oYXNoIjoiabc","score":0.1\n'
                    "Risk Score: 0.04"
                ),
            }
        ],
    }
    noisy = {
        "messages": [
            {
                "role": "tool",
                "content": (
                    "Browser automation complete: **Status**: SUCCESS\n\n"
                    "**Actions Taken** (4 total, showing last 4):\n"
                    '  • click: {"action":"click","index":74,"params":{"index":74}}\n'
                    '  • input_text: {"action":"input_text","index":30,"params":{"index":30,"text":"benchmark-human@example.com"}}\n\n'
                    'TOOL_RESULT {"tool_name":"spawn_browser_agent","result":"  • click: {\\"action\\":\\"click\\",\\"index\\":74,\\"params\\":{\\"index\\":74}}"}\n'
                    "### DOM Tree (browser-extracted final-state page content)\n"
                    "[74]<div role=checkbox aria-checked=true />\n"
                    "|SHADOW(open)|[30]<input id=demo-email />\n"
                    'Token: eyJpcF9oYXNoIjoixyz","score":0.9\n'
                    "Risk Score: 0.04"
                ),
            }
        ],
    }
    changed = {
        "messages": [
            {
                "role": "tool",
                "content": noisy["messages"][0]["content"].replace("Risk Score: 0.04", "Risk Score: 0.91"),
            }
        ],
    }
    assert normalize.canonical_messages(base) == normalize.canonical_messages(noisy)
    assert normalize.canonical_messages(base) != normalize.canonical_messages(changed)


def test_canonical_messages_sort_adjacent_parallel_tool_results():
    # Parallel tool calls can complete in different orders across runs; the
    # semantic request should remain stable when the same tool results are present.
    base = {
        "messages": [
            {"role": "user", "content": "Compare cities"},
            {
                "role": "assistant",
                "tool_calls": [
                    {"id": "toolu_austin", "function": {"name": "spawn_agent", "arguments": "{}"}},
                    {"id": "toolu_denver", "function": {"name": "spawn_agent", "arguments": "{}"}},
                ],
            },
            {"role": "tool", "tool_call_id": "toolu_austin", "content": "Austin result"},
            {"role": "tool", "tool_call_id": "toolu_denver", "content": "Denver result"},
            {"role": "assistant", "content": "Next step"},
        ],
    }
    reordered = {
        "messages": [
            base["messages"][0],
            base["messages"][1],
            {"role": "tool", "tool_call_id": "toolu_denver", "content": "Denver result"},
            {"role": "tool", "tool_call_id": "toolu_austin", "content": "Austin result"},
            base["messages"][4],
        ],
    }
    changed = {
        "messages": [
            base["messages"][0],
            base["messages"][1],
            {"role": "tool", "tool_call_id": "toolu_denver", "content": "Different Denver result"},
            {"role": "tool", "tool_call_id": "toolu_austin", "content": "Austin result"},
            base["messages"][4],
        ],
    }
    assert normalize.canonical_messages(base) == normalize.canonical_messages(reordered)
    assert normalize.canonical_messages(base) != normalize.canonical_messages(changed)


def test_canonical_messages_sort_adjacent_parallel_user_result_messages():
    base = {
        "messages": [
            {"role": "user", "content": "Run DAG"},
            {"role": "user", "content": "[2026-06-24 21:48] [spawn_general_purpose_agent result]: NYC"},
            {"role": "user", "content": "[2026-06-24 21:49] [spawn_general_purpose_agent result]: Tokyo"},
            {"role": "user", "content": "[2026-06-24 21:50] [thought result]: use both values"},
        ],
    }
    reordered = {
        "messages": [
            base["messages"][0],
            {"role": "user", "content": "[2026-06-24 21:53] [spawn_general_purpose_agent result]: Tokyo"},
            {"role": "user", "content": "[2026-06-24 21:53] [spawn_general_purpose_agent result]: NYC"},
            {"role": "user", "content": "[2026-06-24 21:53] [thought result]: use both values"},
        ],
    }
    assert normalize.canonical_messages(base) == normalize.canonical_messages(reordered)


def test_canonical_messages_sort_parallel_tool_result_blocks_inside_text():
    base = {
        "messages": [
            {
                "role": "user",
                "content": (
                    'TOOL_RESULT {"tool_name": "spawn_general_purpose_agent", "tool_call_id": "toolu_NYC111111", "result": "NYC"}'
                    "\n\n"
                    'TOOL_RESULT {"tool_name": "spawn_general_purpose_agent", "tool_call_id": "toolu_TOKYO111111", "result": "Tokyo"}'
                    "\n\n"
                    'TOOL_RESULT {"tool_name": "thought", "tool_call_id": "toolu_THOUGHT111111", "result": "use both"}'
                ),
            }
        ],
    }
    reordered = {
        "messages": [
            {
                "role": "user",
                "content": (
                    'TOOL_RESULT {"tool_name": "spawn_general_purpose_agent", "tool_call_id": "toolu_TOKYO222222", "result": "Tokyo"}'
                    "\n\n"
                    'TOOL_RESULT {"tool_name": "spawn_general_purpose_agent", "tool_call_id": "toolu_NYC222222", "result": "NYC"}'
                    "\n\n"
                    'TOOL_RESULT {"tool_name": "thought", "tool_call_id": "toolu_THOUGHT222222", "result": "use both"}'
                ),
            }
        ],
    }
    assert normalize.canonical_messages(base) == normalize.canonical_messages(reordered)


def test_canonical_messages_sort_timestamped_result_blocks_inside_text():
    base = {
        "messages": [
            {
                "role": "user",
                "content": (
                    "[2026-06-24 21:48] [web_search result]: Denver\n\n[2026-06-24 21:49] [web_search result]: Austin"
                ),
            }
        ],
    }
    reordered = {
        "messages": [
            {
                "role": "user",
                "content": (
                    "[2026-06-24 21:53] [web_search result]: Austin\n\n[2026-06-24 21:54] [web_search result]: Denver"
                ),
            }
        ],
    }
    assert normalize.canonical_messages(base) == normalize.canonical_messages(reordered)


def test_canonical_messages_normalizes_web_provider_result_blocks_but_keeps_result_hash():
    base = {
        "messages": [
            {
                "role": "tool",
                "name": "web_fetch",
                "content": (
                    "**Params Passed:**\n\n"
                    "- **url**: https://Example.com/page?utm_source=x&b=2&a=1\n"
                    "- **objective**: Extract climate facts\n\n"
                    "**Result:**\n\n"
                    "Source URL: https://example.com/page\n\n"
                    "Denver has 300 days of sunshine."
                ),
            }
        ],
    }
    noisy = {
        "messages": [
            {
                "role": "tool",
                "name": "web_fetch",
                "content": (
                    "**Params Passed:**\n\n"
                    "- **objective**: Extract climate facts\n"
                    "- **url**: https://example.com/page?a=1&b=2&utm_campaign=y\n\n"
                    "**Result:**\n\n"
                    "Source URL: https://example.com/page\n\n"
                    "Denver has 300 days of sunshine."
                ),
            }
        ],
    }
    changed = {
        "messages": [
            {
                "role": "tool",
                "name": "web_fetch",
                "content": (
                    "**Params Passed:**\n\n"
                    "- **objective**: Extract climate facts\n"
                    "- **url**: https://example.com/page?a=1&b=2\n\n"
                    "**Result:**\n\n"
                    "Source URL: https://example.com/page\n\n"
                    "Denver has 250 days of sunshine."
                ),
            }
        ],
    }
    assert normalize.canonical_messages(base) == normalize.canonical_messages(noisy)
    assert normalize.canonical_messages(base) != normalize.canonical_messages(changed)


def test_canonical_messages_normalizes_provider_json_observation_key_order():
    base = {
        "messages": [
            {
                "role": "tool",
                "name": "web_search",
                "content": (
                    '[2026-06-24 21:48] {"answer":"Denver has a large job market.",'
                    '"sources":["https://example.com/a"],"query":"Denver jobs","provider":"parallel"}'
                ),
            }
        ],
    }
    reordered = {
        "messages": [
            {
                "role": "tool",
                "name": "web_search",
                "content": (
                    '[2026-06-24 21:49] {"query":"Denver jobs","answer":"Denver has a large job market.",'
                    '"provider":"parallel","sources":["https://example.com/a"]}'
                ),
            }
        ],
    }
    changed = {
        "messages": [
            {
                "role": "tool",
                "name": "web_search",
                "content": (
                    '[2026-06-24 21:49] {"query":"Denver jobs","answer":"Denver has a small job market.",'
                    '"provider":"parallel","sources":["https://example.com/a"]}'
                ),
            }
        ],
    }
    assert normalize.canonical_messages(base) == normalize.canonical_messages(reordered)
    assert normalize.canonical_messages(base) != normalize.canonical_messages(changed)


def test_canonical_messages_normalizes_web_fetch_downloaded_file_metadata():
    base = {
        "messages": [
            {
                "role": "tool",
                "name": "web_fetch",
                "content": (
                    '[2026-06-24 21:48] {"content":"Official housing facts",'
                    '"url":"https://example.com/housing","objective":"Extract facts",'
                    '"summarized":true,"downloaded_files":[{"id":"11111111-1111-4111-8111-111111111111",'
                    '"storage_path":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/'
                    '11111111-1111-4111-8111-111111111111_Report.pdf",'
                    '"original_filename":"Report.pdf","mime_type":"application/pdf",'
                    '"size_bytes":123,"created_at":"2026-06-24T21:48:01Z"}],'
                    '"links_discovered":4,"links_downloaded":1}'
                ),
            }
        ],
    }
    noisy = {
        "messages": [
            {
                "role": "tool",
                "name": "web_fetch",
                "content": (
                    '[2026-06-24 21:49] {"objective":"Extract facts","url":"https://example.com/housing",'
                    '"downloaded_files":[{"id":"22222222-2222-4222-8222-222222222222",'
                    '"storage_path":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/'
                    '22222222-2222-4222-8222-222222222222_Report.pdf",'
                    '"created_at":"2026-06-24T21:49:01Z","size_bytes":123,'
                    '"mime_type":"application/pdf","original_filename":"Report.pdf"}],'
                    '"links_downloaded":1,"content":"Official housing facts","links_discovered":4,'
                    '"summarized":true}'
                ),
            }
        ],
    }
    changed = {
        "messages": [
            {
                "role": "tool",
                "name": "web_fetch",
                "content": (
                    '[2026-06-24 21:49] {"objective":"Extract facts","url":"https://example.com/housing",'
                    '"downloaded_files":[],"links_downloaded":0,"content":"Different facts",'
                    '"links_discovered":4,"summarized":true}'
                ),
            }
        ],
    }
    assert normalize.canonical_messages(base) == normalize.canonical_messages(noisy)
    assert normalize.canonical_messages(base) != normalize.canonical_messages(changed)


def test_canonical_messages_ignores_runtime_accounting_fields():
    base = {
        "messages": [
            {
                "role": "tool",
                "metadata": {
                    "completionSummary": {
                        "durationSeconds": 185,
                        "costDollars": 0.0381,
                        "outputs": [{"key": "answer", "value": "42"}],
                    }
                },
            }
        ]
    }
    noisy = {
        "messages": [
            {
                "role": "tool",
                "metadata": {
                    "completionSummary": {
                        "durationSeconds": 2,
                        "costDollars": 0.0,
                        "outputs": [{"key": "answer", "value": "42"}],
                    }
                },
            }
        ]
    }
    changed = {
        "messages": [
            {
                "role": "tool",
                "metadata": {
                    "completionSummary": {
                        "durationSeconds": 2,
                        "costDollars": 0.0,
                        "outputs": [{"key": "answer", "value": "43"}],
                    }
                },
            }
        ]
    }
    assert normalize.canonical_messages(base) == normalize.canonical_messages(noisy)
    assert normalize.canonical_messages(base) != normalize.canonical_messages(changed)


def test_browser_use_key_ignores_dynamic_browser_state_noise():
    base = {
        "task": "Visit the page",
        "browser_state": {
            "url": "https://example.com/path?cb=1",
            "title": "Example",
            "dom_tree": "Timestamp: 2026-06-24T18:29:05Z\n[42]<button />\n\tSubmit",
            "scroll_position": {"y": 230, "pages_above": 0.3},
            "tabs": [{"id": "FA31", "url": "https://example.com/path?cb=1"}],
        },
        "action_entries": [
            {
                "action": "click",
                "index": 77,
                "coordinates": {"x": 531, "y": 564},
                "element_description": "[77] div",
                "status": "success",
            },
            {"action": "goto", "url": "https://example.com/path"},
        ],
        "config": {"browser_use_mode": "claude"},
        "turn_messages": [{"role": "user", "content": "Screenshot captured (451162 bytes)"}],
    }
    noisy = {
        "task": "Visit the page",
        "browser_state": {
            "url": "https://example.com/path?cb=999",
            "title": "Example",
            "dom_tree": "Timestamp: 2026-06-24T18:35:08Z\n[40]<button />\n\tSubmit",
            "scroll_position": {"y": 112, "pages_above": 0.1},
            "tabs": [{"id": "1407", "url": "https://example.com/path?cb=999"}],
        },
        "action_entries": [
            {
                "action": "click",
                "index": 72,
                "coordinates": {"x": 532, "y": 663},
                "element_description": "[72] div",
                "status": "success",
            },
            {"url": "https://example.com/path", "action": "goto"},
        ],
        "config": {"browser_use_mode": "claude"},
        "turn_messages": [{"role": "user", "content": "Screenshot captured (451055 bytes)"}],
    }
    changed_history = {
        **noisy,
        "action_entries": [
            {"url": "https://example.com/path", "action": "goto"},
            {"action": "click", "index": 2, "element_description": "[2] button Submit"},
        ],
    }
    assert normalize.browser_use_key("goal", base) == normalize.browser_use_key("goal", noisy)
    assert normalize.browser_use_key("goal", base) != normalize.browser_use_key("goal", changed_history)


def test_strip_secrets_removes_credentials():
    # #26 no token/PII leakage into the cache value.
    cleaned = normalize.strip_secrets(
        {
            "Authorization": "Bearer x",
            "cookie": "s=1",
            "claude_token": "t",
            "keep": "ok",
            "nested": {"x-api-key": "k", "fine": 1},
        }
    )
    assert cleaned == {"keep": "ok", "nested": {"fine": 1}}


def test_is_enabled_false_when_no_context():
    # #1 default off.
    assert is_enabled() is False


# ---------------------------------------------------------------------------
# Gating / write / replay
# ---------------------------------------------------------------------------


def test_passthrough_when_disabled(mem):
    # #1 / #25 flag off: rose called, zero cache reads/writes.
    async def body():
        set_context(FastCacheContext(enabled=False, goal="g"))
        rose = FakeRose(_full_stream())
        chunks = await _drain(rose_cache.cached_complete(rose, call_site="execute_loop", pool="rose-1-ultra"))
        assert rose.calls == 1
        assert mem.data == {}
        assert mem.set_calls == 0
        assert chunks[0].kind == "metadata"

    asyncio.run(body())


def test_write_only_context_writes_without_reading(mem):
    """WRITE_ONLY: skip cache read, call provider, write (non-soft call_site).

    Write-through never soft-completes — Andy/Tamy $0 warm paths use Fast Mode
    *read* (enabled=True). Write-only must keep calling live LLM so multi-step
    cold seeds (explore p:2 after writing p:1) are not aborted.
    """

    async def body():
        set_context(FastCacheContext(enabled=False, goal="g", write_enabled=True))
        rose = FakeRose(_full_stream())
        await _drain(rose_cache.cached_complete(rose, call_site="response_schema", pool="rose-1-ultra"))
        assert rose.calls == 1
        assert mem.get_calls == 0
        assert mem.set_calls == 1
        assert len(mem.data) == 1

    asyncio.run(body())


def test_write_only_continues_live_even_when_prior_slot_exists(mem, monkeypatch):
    """Write-through must not trajectory-end-passthrough after seeding p:N.

    Regression for spawn-sub-agents smoke: allowlisted write-through wrote
    explore/execute p:1, then p:2 saw trajectory_prior_exists and stubbed
    attempt_completion — verifier 0% loops until timeout.
    """

    async def prior_true(goal_hash, call_site, step):
        del goal_hash, call_site
        return step is not None and int(step) > 0

    monkeypatch.setattr(rose_cache.cache_client, "trajectory_prior_exists", prior_true)

    async def body():
        set_context(FastCacheContext(enabled=False, goal="g", write_enabled=True, base_step=3))
        rose = FakeRose(_full_stream())
        chunks = await _drain(rose_cache.cached_complete(rose, call_site="execute_loop", pool="rose-1-ultra"))
        assert rose.calls == 1
        assert mem.set_calls == 1
        assert chunks[0].kind == "metadata"
        assert not any(
            getattr(c, "data", None) and c.data.get("name") == "attempt_completion"
            for c in chunks
            if c.kind == "tool_call"
        )

    asyncio.run(body())


def test_rose_client_write_only_does_not_trajectory_end_passthrough(mem, monkeypatch):
    """RoseClient.complete write-through must match cached_complete: never stub p:N+1.

    browser-smoke / spawn-sub-agents use Andy write-through with Fast Mode off.
    Stubbing the second execute_loop as attempt_completion kills the only
    repeatable cache_sequence_id pair and hard-fails the 40% cache ratchet.
    """
    from providers.rose.client import RoseClient

    async def prior_true(goal_hash, call_site, step):
        del goal_hash, call_site
        return step is not None and int(step) > 0

    monkeypatch.setattr(
        "providers.fast_cache.client.trajectory_prior_exists",
        prior_true,
    )

    async def body():
        set_context(FastCacheContext(enabled=False, goal="browser-smoke-goal", write_enabled=True, base_step=2))
        client = RoseClient(openrouter_key="test-key")
        live_calls = {"n": 0}

        async def fake_impl(**kwargs):
            del kwargs
            live_calls["n"] += 1
            for c in _full_stream():
                yield c

        monkeypatch.setattr(client, "_complete_impl", fake_impl)
        chunks = await _drain(
            client.complete(
                pool="rose-1-ultra",
                messages=[{"role": "user", "content": "go"}],
                call_site="execute_loop",
                agent_id="agent-browser-smoke",
                dump_context=False,
            )
        )
        assert live_calls["n"] == 1
        assert chunks[0].kind == "metadata"
        assert not any(
            getattr(c, "data", None) and c.data.get("name") == "attempt_completion"
            for c in chunks
            if c.kind == "tool_call"
        )

    asyncio.run(body())


def test_write_only_context_uses_provider_fast_mode(mem):
    async def body():
        set_context(FastCacheContext(enabled=False, goal="g", write_enabled=True))
        rose = FakeRose(_full_stream())
        await _drain(rose_cache.cached_complete(rose, call_site="response_schema", pool="rose-1-ultra"))
        assert rose.calls == 1
        assert mem.set_calls == 1
        assert next(iter(mem.data.keys())) == FastCacheContext(enabled=True, goal="g").llm_key(
            "response_schema",
            rose_cache.request_key_material(
                {
                    "pool": "rose-1-ultra",
                    "provider_fast_mode": True,
                }
            ),
        )

    asyncio.run(body())


def test_miss_writes_assembled_response(mem):
    # #7 first run populates; #8 full (saw done) write.
    # Non-soft call_site so cold miss still records (soft sites short-circuit).
    async def body():
        set_context(FastCacheContext(enabled=True, goal="g"))
        rose = FakeRose(_full_stream())
        await _drain(rose_cache.cached_complete(rose, call_site="response_schema", pool="rose-1-ultra"))
        assert rose.calls == 1
        assert len(mem.data) == 1
        stored = next(iter(mem.data.values()))
        assert stored["content"] == "Hello world"
        assert stored["tool_calls"][0]["name"] == "set_plan"
        assert stored["actual_model"] == "claude-opus-4-7-claude"

    asyncio.run(body())


def test_structured_response_model_does_not_write_during_stream(mem):
    async def body():
        class StructuredAction(BaseModel):
            response: str
            tool_calls: list = []

        set_context(FastCacheContext(enabled=True, goal="g"))
        rose = FakeRose(_full_stream())
        chunks = await _drain(
            rose_cache.cached_complete(
                rose,
                call_site="response_schema",
                pool="rose-1-ultra",
                response_model=StructuredAction,
            )
        )

        assert rose.calls == 1
        assert chunks[-1].kind == "done"
        assert mem.set_calls == 0
        assert mem.data == {}

    asyncio.run(body())


def test_partial_stream_not_written(mem):
    # #8 aborted/partial (no done chunk) is never cached.
    async def body():
        set_context(FastCacheContext(enabled=True, goal="g"))
        rose = FakeRose(_full_stream()[:3])  # metadata + 2 content, NO usage/done
        await _drain(rose_cache.cached_complete(rose, call_site="response_schema", pool="rose-1-ultra"))
        assert mem.data == {}

    asyncio.run(body())


def test_hit_replays_without_calling_rose(mem):
    # #11 replay = no third-party egress; #12 re-streamed.
    async def body():
        set_context(FastCacheContext(enabled=True, goal="g"))
        await _drain(
            rose_cache.cached_complete(FakeRose(_full_stream()), call_site="response_schema", pool="rose-1-ultra")
        )

        # Second run, fresh context (new run, same goal) — must hit.
        set_context(FastCacheContext(enabled=True, goal="g"))
        rose2 = FakeRose(_full_stream())
        chunks = await _drain(rose_cache.cached_complete(rose2, call_site="response_schema", pool="rose-1-ultra"))

        assert rose2.calls == 0  # never touched Rose
        kinds = [c.kind for c in chunks]
        assert kinds[0] == "metadata"
        assert "content" in kinds and "tool_call" in kinds and "usage" in kinds and kinds[-1] == "done"
        content = "".join(c.data.get("text", "") for c in chunks if c.kind == "content")
        assert content == "Hello world"
        tc = next(c for c in chunks if c.kind == "tool_call")
        assert tc.data["name"] == "set_plan"
        meta = next(c for c in chunks if c.kind == "metadata")
        assert meta.data.get("from_fast_cache") is True
        assert meta.data.get("actual_model") == "fast-cache"
        usage = next(c for c in chunks if c.kind == "usage")
        assert usage.data["prompt_tokens"] == 0
        assert usage.data["cache_read_input_tokens"] == 10
        assert usage.data["cache_creation_input_tokens"] == 0
        assert usage.data["completion_tokens"] == 0
        assert usage.data["tokens_out"] == 0
        assert usage.data["total_tokens"] == 0

    asyncio.run(body())


def test_replay_after_write_does_not_rewrite(mem):
    # #10 replaying the same key hits cache and does not call live Rose again.
    async def body():
        set_context(FastCacheContext(enabled=True, goal="g"))
        await _drain(
            rose_cache.cached_complete(FakeRose(_full_stream()), call_site="response_schema", pool="rose-1-ultra")
        )
        set_context(FastCacheContext(enabled=True, goal="g"))
        # Second run MISSes? No — same key already present → it HITS and won't write again.
        await _drain(
            rose_cache.cached_complete(FakeRose(_full_stream()), call_site="response_schema", pool="rose-1-ultra")
        )
        assert len(mem.data) == 1
        assert mem.set_calls == 1  # only the first run wrote

    asyncio.run(body())


def test_partial_cache_degrades_gracefully(mem):
    # #16 mix of hit + miss: present key replays, absent key goes live + writes.
    async def body():
        first_messages = [{"role": "user", "content": "hello"}]
        second_messages = [{"role": "user", "content": "goodbye"}]
        set_context(FastCacheContext(enabled=True, goal="g"))
        await _drain(
            rose_cache.cached_complete(
                FakeRose(_full_stream()),
                call_site="response_schema",
                pool="rose-1-ultra",
                messages=first_messages,
            )
        )

        set_context(FastCacheContext(enabled=True, goal="g"))
        hit_rose = FakeRose(_full_stream())
        await _drain(
            rose_cache.cached_complete(
                hit_rose,
                call_site="response_schema",
                pool="rose-1-ultra",
                messages=first_messages,
            )
        )
        miss_rose = FakeRose(_full_stream())
        await _drain(
            rose_cache.cached_complete(
                miss_rose,
                call_site="response_schema",
                pool="rose-1-ultra",
                messages=second_messages,
            )
        )

        assert hit_rose.calls == 0  # same canonical request replayed
        assert miss_rose.calls == 1  # changed request went live
        assert len(mem.data) == 2  # both request fingerprints now cached

    asyncio.run(body())


def test_get_error_falls_through_to_live(monkeypatch):
    # #16 a backend read error must NOT break the run — degrade to a live miss
    # for ordinary (non-allowlisted) Fast Mode reads.
    async def boom(key: str):
        raise RuntimeError("backend down")

    async def noop_set(*a, **k):
        return True

    monkeypatch.setattr(rose_cache.cache_client, "cache_get", boom)
    monkeypatch.setattr(rose_cache.cache_client, "cache_get_first", boom)
    monkeypatch.setattr(rose_cache.cache_client, "cache_set", noop_set)

    async def body():
        set_context(FastCacheContext(enabled=True, goal="g"))
        rose = FakeRose(_full_stream())
        chunks = await _drain(rose_cache.cached_complete(rose, call_site="execute_loop", pool="rose-1-ultra"))
        assert rose.calls == 1  # soft sites still degrade to live on transport errors
        assert chunks[-1].kind == "done"

    asyncio.run(body())


def _foreign_dag_param_payload() -> Dict[str, Any]:
    return {
        "actual_model": "fast-mode-replay",
        "pool_name": "rose-1-ultra",
        "request_id": "foreign-dag-node",
        "content": "",
        "content_chunks": [],
        "reasoning": "",
        "tool_calls": [
            {
                "id": "call-foreign",
                "name": "spawn_agent",
                "arguments": '{"type":"for_each","goal":"analyze every creator","items":["a"]}',
            }
        ],
        "codex_reasoning_items": [],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5},
    }


def test_dag_param_positional_candidate_is_not_rekeyed(mem, monkeypatch):
    """A foreign DAG-node candidate must not poison the exact request key."""
    foreign = _foreign_dag_param_payload()

    async def foreign_position(*_args, **_kwargs):
        return foreign, "fastmode:v42:llm:goal:dag_param_populator:p:1:c:foreign"

    monkeypatch.setattr(rose_cache.cache_client, "cache_get_position_fallback", foreign_position)

    async def body():
        set_context(FastCacheContext(enabled=True, goal="g", base_step=1, write_enabled=True))
        rose = FakeRose(_full_stream())
        chunks = await _drain(rose_cache.cached_complete(rose, call_site="dag_param_populator", pool="rose-1-ultra"))
        assert rose.calls == 0
        assert next(chunk for chunk in chunks if chunk.kind == "tool_call").data["name"] == "spawn_agent"
        assert mem.set_calls == 0

    asyncio.run(body())


def test_rose_client_dag_param_positional_candidate_is_not_promoted(mem, monkeypatch):
    """The production cache notch also leaves foreign DAG candidates unpromoted."""
    from providers.rose.client import RoseClient

    foreign = _foreign_dag_param_payload()

    async def foreign_position(*_args, **_kwargs):
        return foreign, "fastmode:v42:llm:goal:dag_param_populator:p:1:c:foreign"

    monkeypatch.setattr(rose_cache.cache_client, "cache_get_position_fallback", foreign_position)

    async def body():
        set_context(FastCacheContext(enabled=True, goal="g", base_step=1, write_enabled=True))
        client = RoseClient(openrouter_key="test-key")
        live_calls = {"n": 0}

        async def fake_impl(**_kwargs):
            live_calls["n"] += 1
            for chunk in _full_stream():
                yield chunk

        monkeypatch.setattr(client, "_complete_impl", fake_impl)
        chunks = await _drain(
            client.complete(
                pool="rose-1-ultra",
                messages=[{"role": "user", "content": "populate params"}],
                call_site="dag_param_populator",
            )
        )
        assert live_calls["n"] == 0
        assert next(chunk for chunk in chunks if chunk.kind == "tool_call").data["name"] == "spawn_agent"
        assert mem.set_calls == 0

    asyncio.run(body())


def test_get_error_on_allowlisted_bench_does_not_go_live(monkeypatch):
    """Mass-agent Fast Mode must not bill live LLM when get-position times out.

    Recurrence of 2026-07-07: a store transport fault is not a semantic miss.
    Allowlisted reads raise FastCacheLookupError instead of falling through.
    """

    async def boom(*_a, **_k):
        raise RuntimeError("ReadTimeout")

    async def noop_set(*a, **k):
        return True

    monkeypatch.setattr(rose_cache.cache_client, "cache_get", boom)
    monkeypatch.setattr(rose_cache.cache_client, "cache_get_first", boom)
    monkeypatch.setattr(rose_cache.cache_client, "cache_get_position_fallback", boom)
    monkeypatch.setattr(rose_cache.cache_client, "cache_set", noop_set)

    async def body():
        bench = _soft_complete_bench_goal()
        set_context(
            FastCacheContext(
                enabled=True,
                goal=_july_gp_child_goal(),
                base_step=1,
                root_goal=bench,
                write_enabled=False,
            )
        )
        rose = FakeRose(_full_stream())
        with pytest.raises(rose_cache.FastCacheLookupError):
            await _drain(rose_cache.cached_complete(rose, call_site="execute_loop", pool="rose-1-ultra"))
        assert rose.calls == 0

    asyncio.run(body())


def test_resolve_fast_cache_goal_activity_returns_persisted_row_goal(monkeypatch):
    # The workflow keys the cache namespace by the persisted Agent-row goal, not
    # its (possibly chat-refined) input goal. This activity is that resolution.
    import providers.fast_cache.client as cache_client_module
    from helpers.fast_cache_goal import resolve_fast_cache_goal_activity

    async def fake_resolve(agent_id: str):
        assert agent_id == "agent-1"
        return True, "persisted row goal", True, "agent-1", "persisted row goal", True

    monkeypatch.setattr(cache_client_module, "resolve_agent_fast_mode", fake_resolve)

    async def body():
        assert await resolve_fast_cache_goal_activity("agent-1") == {
            "goal": "persisted row goal",
            "root_goal": "persisted row goal",
        }

    asyncio.run(body())


def test_resolve_fast_cache_goal_activity_returns_child_and_root_goal(monkeypatch):
    import providers.fast_cache.client as cache_client_module
    from helpers.fast_cache_goal import (
        resolve_fast_cache_goal_activity,
        unpack_fast_cache_goal_resolution,
    )

    leftover = "Produce fresh tool-grounded evidence for Andy Prevalsky"
    root = "I'm building a [REDACTED] brand for health, longevity, technology, founder journey"

    async def fake_resolve(agent_id: str):
        assert agent_id == "leftover-child"
        return True, leftover, True, "root-agent", root, True

    monkeypatch.setattr(cache_client_module, "resolve_agent_fast_mode", fake_resolve)

    async def body():
        resolved = await resolve_fast_cache_goal_activity("leftover-child")
        assert resolved == {"goal": leftover, "root_goal": root}
        assert unpack_fast_cache_goal_resolution(resolved) == (leftover, root)
        assert unpack_fast_cache_goal_resolution("legacy-string") == ("legacy-string", None)
        assert unpack_fast_cache_goal_resolution(None) == (None, None)

    asyncio.run(body())


def test_resolve_fast_cache_goal_activity_none_on_unresolved(monkeypatch):
    import providers.fast_cache.client as cache_client_module
    from helpers.fast_cache_goal import resolve_fast_cache_goal_activity

    async def fake_resolve(agent_id: str):
        return False, None, False, None, None, True

    monkeypatch.setattr(cache_client_module, "resolve_agent_fast_mode", fake_resolve)

    async def body():
        assert await resolve_fast_cache_goal_activity("agent-x") is None

    asyncio.run(body())


def test_resolve_fast_cache_context_activity_returns_general_demo_gate(monkeypatch):
    """Any catalog DEMO tree, not only the legacy OAI demo, enables replay."""
    import providers.fast_cache.client as cache_client_module
    from helpers.fast_cache_goal import resolve_fast_cache_context_activity

    async def fake_resolve(agent_id: str, *, refresh: bool = False):
        assert refresh is True, "a workflow run start must re-read the agent row"
        assert agent_id == "fundraise-root"
        return (
            True,
            "Raise me 5m dollars for my company Rose Labs\nNo questions asked",
            True,
            "fundraise-root",
            "Raise me 5m dollars for my company Rose Labs\nNo questions asked",
            False,
        )

    monkeypatch.setattr(cache_client_module, "resolve_agent_fast_mode", fake_resolve)

    async def body():
        assert await resolve_fast_cache_context_activity("fundraise-root") == {
            "resolved": True,
            "enabled": True,
            "goal": "Raise me 5m dollars for my company Rose Labs\nNo questions asked",
            "write_enabled": True,
            "root_agent_id": "fundraise-root",
            "root_goal": "Raise me 5m dollars for my company Rose Labs\nNo questions asked",
            "provider_fast_mode": False,
        }

    asyncio.run(body())


def test_goal_hash_collapses_run_local_message_refs():
    # Spawn paths append "Reference: @ref:message:<uuid>" to sub-agent goals with
    # a fresh message id per run. The namespace must survive reruns.
    base = "Analyze ONE creator as part of a 50-creator analysis.\nRow item:\nThomas DeLauer | YouTube"
    run_a = base + "\n\nReference: @ref:message:3018fec0-93f2-4907-bba9-098cef49ab74"
    run_b = base + "\n\nReference: @ref:message:aaaabbbb-cccc-4ddd-8eee-ffff00001111"
    assert normalize.goal_hash(run_a) == normalize.goal_hash(run_b)
    assert normalize.goal_hash(run_a) == normalize.goal_hash(base + "\n\nReference: @ref:message:<uuid>")
    # Different goal prose must still get its own namespace.
    assert normalize.goal_hash(run_a) != normalize.goal_hash("Different goal" + run_a)
    # Goals without refs hash exactly as before (raw sha256 prefix).
    assert normalize.goal_hash(base) == normalize.sha256(base)[:16]


def test_write_through_disabled_by_isolated_shared_cache_flag(monkeypatch):
    """Isolated July-cache smokes must not write through Andy/Tamy into prod."""
    from providers.fast_cache.context import write_through_enabled_for_user

    monkeypatch.delenv("FAST_MODE_CACHE_DISABLE_WRITE_THROUGH", raising=False)
    assert write_through_enabled_for_user("1f85ff25-6e29-4c1b-8739-f917bd101a30") is True
    monkeypatch.setenv("FAST_MODE_CACHE_DISABLE_WRITE_THROUGH", "1")
    assert write_through_enabled_for_user("1f85ff25-6e29-4c1b-8739-f917bd101a30") is False
    assert write_through_enabled_for_user("43c2f6ae-37c0-42d0-bd88-2d6fc335b9e9") is False
    assert FastCacheContext(enabled=True, goal="benchmark", write_enabled=True).should_write is False


def test_shared_cache_disable_flag_blocks_ordinary_cache_writes(mem, monkeypatch):
    """Benchmark read-only mode wins over ordinary contexts that request writes."""
    monkeypatch.setenv("FAST_MODE_CACHE_DISABLE_WRITE_THROUGH", "1")

    async def body():
        set_context(FastCacheContext(enabled=True, goal="ordinary goal", write_enabled=True))
        rose = FakeRose(_full_stream())
        await _drain(rose_cache.cached_complete(rose, call_site="execute_loop", pool="rose-1-ultra"))
        assert rose.calls == 1
        assert mem.set_calls == 0

    asyncio.run(body())


def test_demo_wmh_cache_stores_and_replays_with_benchmark_read_only_flag(mem, monkeypatch):
    """DEMO WHM predictions persist even when ordinary benchmark writes are disabled."""
    from benchmarks.wmh_rose_provider import _WMHFastCacheContext
    from providers.rose.client import RoseClient

    monkeypatch.setenv("FAST_MODE_CACHE_DISABLE_WRITE_THROUGH", "1")

    async def body():
        goal = "DEMO fundraiser cache integration"
        ctx = _WMHFastCacheContext(enabled=True, goal=goal, write_enabled=True, root_goal=goal)
        set_context(ctx)
        rose = RoseClient(openrouter_key="test-key")
        live_calls = 0

        async def fake_impl(**_kwargs):
            nonlocal live_calls
            live_calls += 1
            for chunk in _full_stream():
                yield chunk

        monkeypatch.setattr(rose, "_complete_impl", fake_impl)
        kwargs = {
            "pool": "rose-1-ultra",
            "messages": [{"role": "user", "content": "Predict this DEMO step"}],
            "call_site": "wmh_world_model",
        }
        first = await _drain(rose.complete(**kwargs))
        assert live_calls == 1
        assert mem.set_calls == 1
        second = await _drain(rose.complete(**kwargs))
        assert live_calls == 1
        assert mem.get_calls >= 2
        assert [chunk.kind for chunk in second] == [chunk.kind for chunk in first]

    asyncio.run(body())


def test_oai_demo_root_goal_hash_constant():
    assert normalize.OAI_DEMO_ROOT_GOAL_HASH == "4ae3193053ac1d8f"


def test_oai_demo_andy_child_goal_hashes_to_july_aman_namespace():
    """Andy-named children must reuse the July Aman cache namespace.

    The display-name swap must not mint a new goalHash: that miss path
    cold-passthroughs explore/execute into the 24s traj-end stub.
    """
    window = "2026-04-04 through 2026-07-03"  # pragma: allowlist secret
    aman_goal = (
        "You are analyzing ONE creator for Aman Gottumukkala, a technology founder "  # pragma: allowlist secret
        "building a personal brand at the intersection of health, longevity, "  # pragma: allowlist secret
        f"technology, and founder journey. Last 90 days: {window}. "  # pragma: allowlist secret
        "Creator: Dr. Eric Topol."
    )
    andy_goal = aman_goal.replace("Aman Gottumukkala", "Andy Prevalsky")
    assert "Andy Prevalsky" in andy_goal
    assert normalize.goal_hash(andy_goal) == normalize.goal_hash(aman_goal)
    from utils.oai_demo_july import JULY_GP_GOAL_HASHES

    assert normalize.goal_hash(andy_goal) == JULY_GP_GOAL_HASHES["Eric Topol"]
    sahil = andy_goal.replace("Dr. Eric Topol", "Sahil Bloom")
    assert normalize.goal_hash(sahil) == JULY_GP_GOAL_HASHES["Sahil Bloom"] == "3fd2fec61970ac83"
    # Smoke7 leftovers remapped onto Austin/checkout namespaces (270-step
    # clones). Those hashes must not be reused for creator-analysis children.
    austin_or_checkout = {
        "d5ca1a36cddc02e8",
        "a40f6dd9ace06b6c",
        "115e7be730aed584",
        "1f60137116da569c",
        "8cac2a39243299c3",
    }
    leftover_creators = (
        "Bryan Johnson",
        "Tim Ferriss",
        "Dave Asprey",
        "Gary Brecka",
        "Andrew Wilkinson",
        "Max Lugavere",
        "Molly Maloof",
        "Lex Fridman",
        "Siim Land",
        "Nick Norwitz",
        "Steven Bartlett",
        "Mark Hyman",
        "David Sinclair",
        "Casey Means",
        "Matt Kaeberlein",
        "Rowan Cheung",
        "Naval Ravikant",
        "Sam Parr",
        "Matt D'Avella",
    )
    for name in leftover_creators:
        child = andy_goal.replace("Dr. Eric Topol", name)
        hashed = normalize.goal_hash(child)
        assert hashed == JULY_GP_GOAL_HASHES[name]
        assert hashed not in austin_or_checkout, name
    kayla = (
        "You are analyzing ONE creator for Andy Prevalsky. "  # pragma: allowlist secret
        f"Last 90 days: {window}. "  # pragma: allowlist secret
        'Row item:\n{"creator_name": "Kayla Barnes-Lentz", "rank": 39}'
    )
    assert normalize.goal_hash(kayla) != JULY_GP_GOAL_HASHES["Eric Topol"]
    other_andy = "Find the current professional profile of Andy Prevalsky, founder of Rose Labs."
    other_aman = other_andy.replace("Andy Prevalsky", "Aman Gottumukkala")
    assert normalize.goal_hash(other_andy) != normalize.goal_hash(other_aman)


@pytest.mark.parametrize("cancelled_party", ["waiter", "owner", "owner_and_waiter"])
def test_position_fallback_cancellation_preserves_singleflight_ownership(monkeypatch, cancelled_party):
    """Caller cancellation stays local; the shared HTTP task resolves live followers."""
    import httpx

    import providers.fast_cache.client as cache_client

    async def body():
        cache_client.clear_position_memo()
        started = asyncio.Event()
        release = asyncio.Event()
        joined = asyncio.Event()
        requests = []
        cancelled_http = []
        tasks = []
        expected_body = {"goalHash": "cancel-goal", "callSite": "explore_agent", "step": 7}
        expected_result = ({"step": 7}, "cancel-key")

        async def handle(request):
            assert request.url.path == "/api/fast-cache/get-position"
            assert json.loads(request.content) == expected_body
            requests.append(request)
            started.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                cancelled_http.append(request)
                raise
            return httpx.Response(
                200,
                json={"hit": True, "value": expected_result[0], "key": expected_result[1]},
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            monkeypatch.setattr(cache_client, "_backend", lambda: ("http://cache.test", "test-key"))
            monkeypatch.setattr(cache_client, "_shared_client", lambda: client)
            monkeypatch.setattr(cache_client, "_POSITION_PREFETCH_AHEAD", 0)

            async def lookup(waiter=False):
                if waiter:
                    joined.set()
                return await cache_client.cache_get_position_fallback("cancel-goal", "explore_agent", 7)

            try:
                owner = asyncio.create_task(lookup())
                tasks.append(owner)
                await asyncio.wait_for(started.wait(), 10)
                shared = cache_client._position_inflight[("cancel-goal", "explore_agent", 7)]
                waiter = asyncio.create_task(lookup(waiter=True))
                tasks.append(waiter)
                await asyncio.wait_for(joined.wait(), 10)
                target = waiter if cancelled_party == "waiter" else owner
                target.cancel()
                if cancelled_party == "owner_and_waiter":
                    waiter.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await target

                if cancelled_party == "waiter":
                    assert not shared.cancelled(), "waiter cancellation poisoned the shared result"
                    assert not owner.done()
                    assert not cancelled_http
                    joined.clear()
                    later = asyncio.create_task(lookup(waiter=True))
                    tasks.append(later)
                    await asyncio.wait_for(joined.wait(), 10)
                    release.set()
                    results = await asyncio.wait_for(asyncio.gather(owner, later), 10)
                    assert results == [expected_result, expected_result]
                    assert len(requests) == 1
                else:
                    assert not shared.cancelled(), "caller cancellation poisoned the shared HTTP task"
                    assert not cancelled_http
                    assert cache_client._position_inflight.get(("cancel-goal", "explore_agent", 7)) is shared
                    release.set()
                    if cancelled_party == "owner_and_waiter":
                        with pytest.raises(asyncio.CancelledError):
                            await waiter
                        assert len(requests) == 1
                        assert await lookup() == expected_result
                    else:
                        assert await asyncio.wait_for(waiter, 10) == expected_result
                    assert len(requests) == 1

                assert await lookup() == expected_result
                assert len(requests) == 1
                assert not cache_client._position_inflight
            finally:
                release.set()
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                await asyncio.gather(*cache_client._position_inflight.values(), return_exceptions=True)
                cache_client.clear_position_memo()

    asyncio.run(body())


@pytest.mark.parametrize("with_follower", [False, True])
def test_position_fallback_failure_is_owned_and_propagated(monkeypatch, with_follower):
    """The shared promise adds no unhandled error; real HTTP failures still propagate."""
    import gc

    import httpx

    import providers.fast_cache.client as cache_client

    async def body():
        loop = asyncio.get_running_loop()
        original_handler = loop.get_exception_handler()
        unhandled = []
        loop.set_exception_handler(lambda _loop, context: unhandled.append(context))

        async def exercise():
            cache_client.clear_position_memo()
            started, release, joined = asyncio.Event(), asyncio.Event(), asyncio.Event()
            requests, tasks = [], []

            async def handle(request):
                assert request.url.path == "/api/fast-cache/get-position"
                assert json.loads(request.content) == {
                    "goalHash": "failure-goal",
                    "callSite": "explore_agent",
                    "step": 8,
                }
                requests.append(request)
                started.set()
                await release.wait()
                raise httpx.ReadTimeout("owned fixture timeout", request=request)

            async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
                monkeypatch.setattr(cache_client, "_backend", lambda: ("http://cache.test", "test-key"))
                monkeypatch.setattr(cache_client, "_shared_client", lambda: client)
                monkeypatch.setattr(cache_client, "_POSITION_PREFETCH_AHEAD", 0)

                async def lookup(follower=False):
                    if follower:
                        joined.set()
                    return await cache_client.cache_get_position_fallback("failure-goal", "explore_agent", 8)

                try:
                    tasks.append(asyncio.create_task(lookup()))
                    await asyncio.wait_for(started.wait(), 10)
                    if with_follower:
                        tasks.append(asyncio.create_task(lookup(follower=True)))
                        await asyncio.wait_for(joined.wait(), 10)
                    release.set()
                    results = await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), 10)
                    assert all(isinstance(result, httpx.ReadTimeout) for result in results)
                    assert all(result is results[0] for result in results)
                    assert len(requests) == 3
                    assert not cache_client._position_inflight
                    assert cache_client._position_memo_get("failure-goal", "explore_agent", 8) is None
                finally:
                    release.set()
                    for task in tasks:
                        if not task.done():
                            task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
                    cache_client.clear_position_memo()

        try:
            await exercise()
            await asyncio.sleep(0)
            gc.collect()
            await asyncio.sleep(0)
            assert not unhandled, "shared HTTP failure leaked an unowned Future error"
        finally:
            loop.set_exception_handler(original_handler)

    asyncio.run(body())


def test_position_fallback_memos_and_single_flights_http(monkeypatch):
    """Sibling Fast Mode agents must share one get-position HTTP per durable slot."""
    import providers.fast_cache.client as cache_client

    cache_client.clear_position_memo()
    posts: list[int] = []

    class _Resp:
        status_code = 200

        @staticmethod
        def json():
            return {"hit": True, "value": {"tool_calls": [{"name": "web_search"}]}, "key": "k-1"}

    class _Client:
        async def post(self, *args, **kwargs):
            del args
            posts.append(int((kwargs.get("json") or {}).get("step") or 0))
            await asyncio.sleep(0)
            return _Resp()

    monkeypatch.setattr(cache_client, "_backend", lambda: ("http://cache.test", "key"))
    monkeypatch.setattr(cache_client, "_shared_client", lambda: _Client())

    async def body():
        first, second = await asyncio.gather(
            cache_client.cache_get_position_fallback("hash-a", "explore_agent", 1),
            cache_client.cache_get_position_fallback("hash-a", "explore_agent", 1),
        )
        third = await cache_client.cache_get_position_fallback("hash-a", "explore_agent", 1)
        assert first == second == third
        assert first[1] == "k-1"
        assert posts.count(1) == 1

    asyncio.run(body())
    cache_client.clear_position_memo()


def test_position_fallback_prefetches_upcoming_steps(monkeypatch):
    """A hit should prefetch the next few steps so the sequential loop is local."""
    import providers.fast_cache.client as cache_client

    cache_client.clear_position_memo()
    seen: list[int] = []

    class _Resp:
        def __init__(self, step: int):
            self.status_code = 200
            self._step = step

        def json(self):
            return {"hit": True, "value": {"step": self._step}, "key": f"k-{self._step}"}

    class _Client:
        async def post(self, *args, **kwargs):
            del args
            step = int((kwargs.get("json") or {}).get("step") or 0)
            seen.append(step)
            await asyncio.sleep(0)
            return _Resp(step)

    monkeypatch.setattr(cache_client, "_backend", lambda: ("http://cache.test", "key"))
    monkeypatch.setattr(cache_client, "_shared_client", lambda: _Client())

    async def body():
        value, key = await cache_client.cache_get_position_fallback("hash-b", "execute_loop", 3)
        assert key == "k-3"
        assert value == {"step": 3}
        for _ in range(40):
            if {3, 4, 5, 6, 7, 8, 9, 10, 11}.issubset(set(seen)):
                break
            await asyncio.sleep(0)
        assert 3 in seen
        assert {4, 5, 6, 7, 8, 9, 10, 11}.issubset(set(seen))
        replay = await cache_client.cache_get_position_fallback("hash-b", "execute_loop", 4)
        assert replay == ({"step": 4}, "k-4")
        assert seen.count(4) == 1

    asyncio.run(body())
    cache_client.clear_position_memo()


def test_position_fallback_retries_timeout_then_hits(monkeypatch):
    """get-position ReadTimeout must retry like cache_get, not raise on first fault."""
    import httpx

    import providers.fast_cache.client as cache_client

    cache_client.clear_position_memo()
    posts = {"n": 0}

    class _Resp:
        status_code = 200

        @staticmethod
        def json():
            return {"hit": True, "value": {"tool_calls": [{"name": "web_search"}]}, "key": "k-retry"}

    class _Client:
        async def post(self, *args, **kwargs):
            del args, kwargs
            posts["n"] += 1
            if posts["n"] < 3:
                raise httpx.ReadTimeout("")
            return _Resp()

    monkeypatch.setattr(cache_client, "_backend", lambda: ("http://cache.test", "key"))
    monkeypatch.setattr(cache_client, "_shared_client", lambda: _Client())

    async def body():
        value, key = await cache_client.cache_get_position_fallback("hash-c", "execute_loop", 1)
        assert key == "k-retry"
        assert value == {"tool_calls": [{"name": "web_search"}]}
        assert posts["n"] == 3

    asyncio.run(body())
    cache_client.clear_position_memo()


def _slow_position_client(cache_client, monkeypatch, release_holder: dict, posts: list[int]):
    """get-position stub that blocks every POST until ``release_holder['event']`` is set."""

    class _Resp:
        def __init__(self, step: int):
            self.status_code = 200
            self._step = step

        def json(self):
            return {"hit": True, "value": {"step": self._step}, "key": f"k-{self._step}"}

    class _Client:
        async def post(self, *args, **kwargs):
            del args
            step = int((kwargs.get("json") or {}).get("step") or 0)
            posts.append(step)
            await release_holder["event"].wait()
            return _Resp(step)

    monkeypatch.setattr(cache_client, "_backend", lambda: ("http://cache.test", "key"))
    monkeypatch.setattr(cache_client, "_shared_client", lambda: _Client())


def test_position_fallback_waiter_timeout_does_not_cancel_shared_slot(monkeypatch):
    """A timed-out waiter must not hand CancelledError to the slot's other callers.

    test-mass-agent-run-0 / 855ae867: summarize_web_fetch's 90s wait_for
    (loop/activity_helper.py) expired while awaiting a single-flighted
    get-position slot. Task cancellation cancelled the SHARED future, so the
    retry 1s later awaited that cancelled future and a bare CancelledError
    failed the whole explore activity (spawn_agent ERROR, t10-no-tool-failures).
    """
    import providers.fast_cache.client as cache_client

    cache_client.clear_position_memo()
    posts: list[int] = []
    release: dict = {}
    _slow_position_client(cache_client, monkeypatch, release, posts)

    async def body():
        release["event"] = asyncio.Event()
        slot = ("hash-d", "summarize_web_fetch", 2)
        owner = asyncio.create_task(cache_client.cache_get_position_fallback(*slot))
        sibling = asyncio.create_task(cache_client.cache_get_position_fallback(*slot))
        await asyncio.sleep(0)
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(cache_client.cache_get_position_fallback(*slot), timeout=0.01)
        retry = asyncio.create_task(cache_client.cache_get_position_fallback(*slot))
        await asyncio.sleep(0)
        release["event"].set()
        results = await asyncio.gather(owner, sibling, retry, return_exceptions=True)
        assert results == [({"step": 2}, "k-2")] * 3
        assert posts.count(2) == 1

    asyncio.run(body())
    cache_client.clear_position_memo()


def test_position_fallback_owner_timeout_still_resolves_waiters(monkeypatch):
    """The caller that started the fetch may time out; waiters still get the row."""
    import providers.fast_cache.client as cache_client

    cache_client.clear_position_memo()
    posts: list[int] = []
    release: dict = {}
    _slow_position_client(cache_client, monkeypatch, release, posts)

    async def body():
        release["event"] = asyncio.Event()
        slot = ("hash-e", "summarize_web_fetch", 5)
        owner = asyncio.create_task(asyncio.wait_for(cache_client.cache_get_position_fallback(*slot), timeout=0.01))
        await asyncio.sleep(0)
        waiter = asyncio.create_task(cache_client.cache_get_position_fallback(*slot))
        with pytest.raises(asyncio.TimeoutError):
            await owner
        release["event"].set()
        assert await asyncio.wait_for(waiter, timeout=1.0) == ({"step": 5}, "k-5")
        assert await cache_client.cache_get_position_fallback(*slot) == ({"step": 5}, "k-5")
        assert posts.count(5) == 1

    asyncio.run(body())
    cache_client.clear_position_memo()


def test_cache_replay_usage_zeros_live_output_tokens():
    """Replay must not report stored completion tokens as live streamed output."""
    usage = rose_cache._cache_replay_usage(
        {
            "prompt_tokens": 40,
            "completion_tokens": 250,
            "tokens_out": 250,
            "total_tokens": 290,
            "cache_read_input_tokens": 10,
            "cache_creation_input_tokens": 8,
            "actual_model": "claude-fable-5",
        }
    )
    assert usage["prompt_tokens"] == 0
    assert usage["cache_creation_input_tokens"] == 0
    assert usage["cache_read_input_tokens"] == 40
    assert usage["completion_tokens"] == 0
    assert usage["tokens_out"] == 0
    assert usage["total_tokens"] == 0
    assert usage["from_fast_cache"] is True


def test_oai_demo_replay_rewrites_aman_to_andy_only_for_this_task():
    stored = {
        "content": "Hello Aman Gottumukkala",
        "reasoning": "Aman's brand angle",
        "tool_calls": [{"arguments": '{"result":"Aman Gottumukkala notes"}'}],
    }
    rewritten = normalize.rewrite_oai_demo_display_names(stored)
    assert rewritten["content"] == "Hello Andy Prevalsky"
    assert rewritten["reasoning"] == "Andy's brand angle"
    assert "Andy Prevalsky" in rewritten["tool_calls"][0]["arguments"]
    assert "Aman Gottumukkala" not in json.dumps(rewritten)

    window = "2026-04-04 through 2026-07-03"  # pragma: allowlist secret
    ctx = FastCacheContext(enabled=True, goal=f"Analyze Topol. Window {window}.")
    token = set_context(ctx)
    try:
        chunks: list[Any] = []

        async def collect() -> None:
            async for chunk in rose_cache._replay(stored):
                chunks.append(chunk)

        asyncio.run(collect())
        texts = [json.dumps(getattr(chunk, "data", {}), default=str) for chunk in chunks]
        blob = "\n".join(texts)
        assert "Andy Prevalsky" in blob
        assert "Aman Gottumukkala" not in blob
    finally:
        reset_context(token)


def test_content_lookup_keys_dual_read_flash_and_lite_pools():
    """rose-1-flash content keys must dual-read the pre-rename rose-1-lite row."""
    material = {
        "pool": "rose-1-flash",
        "system": "schema system",
        "user": "Goal: mass agent",
        "response_model": "_GeneratedResponseSchemaWithTitle",
        "temperature": 0.3,
        "max_tokens": [2000, 4000],
    }
    keys = normalize.content_lookup_keys_with_pool_aliases("mass agent", "response_schema", material)
    flash_key = normalize.content_key("mass agent", "response_schema", material)
    lite_key = normalize.content_key("mass agent", "response_schema", {**material, "pool": "rose-1-lite"})
    assert keys[0] == flash_key
    assert lite_key in keys
    assert flash_key != lite_key
    # Reverse alias direction (legacy callers still on lite) also dual-reads flash.
    reverse = normalize.content_lookup_keys_with_pool_aliases(
        "mass agent", "response_schema", {**material, "pool": "rose-1-lite"}
    )
    assert reverse[0] == lite_key
    assert flash_key in reverse


def test_position_lookup_keys_include_july_demo_aliases():
    request = {
        "pool": "rose-1-ultra",
        "messages": [
            {"role": "system", "content": "static system"},
            {"role": "user", "content": "dynamic user that must not affect july fp"},
        ],
        "tools": [{"name": "spawn"}],
        "temperature": 0,
    }
    keys = normalize.position_lookup_keys("mass agent root goal", "dag_param_populator", 1, request)
    assert keys[0] == normalize.position_key("mass agent root goal", "dag_param_populator", 1, request)
    assert any(k.startswith("fastmode:v42:") for k in keys)
    assert any(k.startswith("fastmode:v43:") for k in keys)
    legacy_fp = normalize.oai_demo_position_request_fingerprint(request)
    assert any(f":c:{legacy_fp}" in k for k in keys)
    # July fingerprint ignores trailing user messages; current fingerprint must not.
    assert normalize.oai_demo_position_request_fingerprint(request) != normalize.position_request_fingerprint(request)
    # Without the user message, July and current fingerprints still differ by
    # exclude_anthropic_family (present only in the current material).
    static_only = {
        "pool": "rose-1-ultra",
        "messages": [{"role": "system", "content": "static system"}],
        "tools": [{"name": "spawn"}],
        "temperature": 0,
    }
    assert normalize.oai_demo_position_request_fingerprint(static_only) != normalize.position_request_fingerprint(
        static_only
    )


def test_position_prefix_pattern_matches_durable_slot():
    pattern = normalize.position_prefix_pattern("goal", "plan_loop", 2)
    gh = normalize.goal_hash("goal")
    scope = normalize.world_model_cache_scope()
    assert pattern == f"fastmode:%:{scope}llm:{gh}:plan_loop:p:2:c:%"


def test_build_for_each_goal_hash_matches_oai_demo_python_namespace():
    """JS JSON.stringify hashes diverge from Python json.dumps — rekey must use Python form."""
    from domains.spawn_agent.service import build_for_each_goal

    base = "Analyze the assigned creator only for a brand strategy project.\nCurrent date is 2026-07-03."
    item = {
        "rank": 1,
        "name": "Andrew Huberman",
        "primary_niche_angle": "health/longevity + performance systems",
        "platforms": {
            "youtube": {"url": "https://www.youtube.com/@hubermanlab", "handle": "@hubermanlab"},
            "instagram": None,
            "tiktok": None,
            "substack": None,
        },
    }
    py_goal = build_for_each_goal(base, item)
    js_like = (
        f"{base}\n\nUse this row context for the task below.\nRow item:\n{json.dumps(item, separators=(',', ':'))}"
    )
    assert normalize.goal_hash(py_goal) != normalize.goal_hash(js_like)
    # Spaced separators + sort_keys must match spawn_agent (JSONB-stable).
    spaced = (
        f"{base}\n\nUse this row context for the task below.\nRow item:\n"
        f"{json.dumps(item, ensure_ascii=True, sort_keys=True)}"
    )
    assert normalize.goal_hash(py_goal) == normalize.goal_hash(spaced)
    # Insertion-order dumps must NOT be used — they miss the Jul OAi namespaces.
    unsorted = f"{base}\n\nUse this row context for the task below.\nRow item:\n{json.dumps(item, ensure_ascii=True)}"
    assert normalize.goal_hash(py_goal) != normalize.goal_hash(unsorted)


def test_soft_complete_allowed_only_for_fast_cache_on_bench_goals():
    """Soft stubs require exact match with a fast_cache:on catalog prompt (or its root)."""
    bench = _soft_complete_bench_goal()
    assert normalize.goal_hash(bench) == normalize.OAI_DEMO_ROOT_GOAL_HASH
    assert normalize.OAI_DEMO_ROOT_GOAL_HASH in normalize.soft_complete_goal_hashes()
    assert normalize.soft_complete_allowed(bench) is True
    assert normalize.soft_complete_allowed("Order Blue Bottle at Ferry Building") is False
    assert normalize.soft_complete_allowed("child for_each goal", root_goal=bench) is True
    assert normalize.soft_complete_allowed("child for_each goal", root_goal="other root") is False
    ctx = FastCacheContext(enabled=True, goal="child", root_goal=bench)
    assert ctx.soft_complete_allowed is True
    ctx_other = FastCacheContext(enabled=True, goal="Order coffee")
    assert ctx_other.soft_complete_allowed is False


def test_wmh_demo_cache_miss_runs_live_and_writes_instead_of_soft_completing(mem, monkeypatch):
    """Simulated DEMO runs replay exact hits but must seed cold trajectory slots."""
    from providers.rose.client import RoseClient

    bench = _soft_complete_bench_goal()
    monkeypatch.setenv("BENCHMARK_WORLD_MODEL_MODE", "simulate")
    monkeypatch.setenv("WMH_MODEL_NAME", "rose-archive")
    assert normalize.demo_cache_allowed(bench) is True
    assert normalize.soft_complete_allowed(bench) is False

    async def body():
        set_context(FastCacheContext(enabled=True, goal=bench, root_goal=bench, base_step=0))
        client = RoseClient(openrouter_key="test-key")
        live_calls = {"n": 0}

        async def fake_impl(**kwargs):
            del kwargs
            live_calls["n"] += 1
            for chunk in _full_stream():
                yield chunk

        monkeypatch.setattr(client, "_complete_impl", fake_impl)
        first = await _drain(
            client.complete(
                pool="rose-1-ultra",
                messages=[{"role": "user", "content": "go"}],
                call_site="plan_loop",
                dump_context=False,
            )
        )
        assert first[0].kind == "metadata"
        assert live_calls["n"] == 1
        assert mem.set_calls == 1
        second = await _drain(
            client.complete(
                pool="rose-1-ultra",
                messages=[{"role": "user", "content": "go"}],
                call_site="plan_loop",
                dump_context=False,
            )
        )
        assert second[0].kind == "metadata"
        assert live_calls["n"] == 1
        assert mem.set_calls == 1

    asyncio.run(body())


def test_soft_complete_on_miss_for_explore_sites_only():
    from providers.fast_cache.rose_cache import soft_complete_on_miss, swf_scrape_passthrough

    explore = soft_complete_on_miss("explore_agent")
    assert explore is not None
    assert explore["tool_calls"][0]["name"] == "attempt_completion_with_result"
    assert explore["usage"]["from_fast_cache"] is True

    # SWF is no longer soft-completed — scrape passthrough returns real page text.
    assert soft_complete_on_miss("summarize_web_fetch") is None
    swf = swf_scrape_passthrough([{"role": "user", "content": "PAGE MARKDOWN FOR OBJECTIVE\n" + ("x" * 20)}])
    assert swf["usage"]["from_fast_cache"] is True
    parsed = json.loads(swf["content"])
    assert "PAGE MARKDOWN" in parsed["summary"]
    assert parsed["files_to_download"] == []

    execute = soft_complete_on_miss("execute_loop")
    assert execute is not None
    assert execute["tool_calls"][0]["name"] == "attempt_completion"

    assert soft_complete_on_miss("verifier_execute") is not None
    assert soft_complete_on_miss("verifier_browser") is not None
    v = soft_complete_on_miss("verifier_execute")
    assert json.loads(v["content"])["score"] == 1.0
    assert soft_complete_on_miss("completion_summary") is not None
    assert soft_complete_on_miss("context_compression") is not None
    assert soft_complete_on_miss("response_schema") is None

    # If the July assemble-final row is absent, dag_reasoning must
    # traj-end rather than call live Rose ($0.63 miss + extra nested
    # GP children on 163ad502). When p:6 exists, get-position hits it.
    dag = soft_complete_on_miss("dag_reasoning")
    assert dag is not None
    assert json.loads(dag["content"])["response"]
    assert dag["usage"]["from_fast_cache"] is True
    assert dag["tool_calls"] == []


def test_soft_complete_dag_reasoning_miss_does_not_call_live(mem, monkeypatch):
    """Warm end-of-trajectory dag_reasoning miss ends via passthrough, no live Rose."""

    async def prior_true(goal_hash, call_site, step):
        del goal_hash, call_site
        return step is not None and int(step) > 0

    monkeypatch.setattr(rose_cache.cache_client, "trajectory_prior_exists", prior_true)

    async def body():
        bench = _soft_complete_bench_goal()
        set_context(FastCacheContext(enabled=True, goal=bench, base_step=6, root_goal=bench))
        rose = FakeRose(_full_stream())
        chunks = await _drain(rose_cache.cached_complete(rose, call_site="dag_reasoning", pool="rose-1-ultra"))
        assert rose.calls == 0
        content = "".join(c.data.get("text", "") for c in chunks if c.kind == "content")
        parsed = json.loads(content)
        assert "trajectory ended" in parsed["response"].lower()
        assert mem.set_calls == 0

    asyncio.run(body())


def test_soft_complete_explore_miss_does_not_call_live(mem, monkeypatch):
    """Warm end-of-trajectory explore miss ends via passthrough replay, no live Rose."""

    async def prior_true(goal_hash, call_site, step):
        del goal_hash, call_site
        return step is not None and int(step) > 0

    monkeypatch.setattr(rose_cache.cache_client, "trajectory_prior_exists", prior_true)
    bench = _soft_complete_bench_goal()

    async def body():
        set_context(FastCacheContext(enabled=True, goal=bench, base_step=5, root_goal=bench))
        rose = FakeRose(_full_stream())
        chunks = await _drain(rose_cache.cached_complete(rose, call_site="explore_agent", pool="rose-1-flash"))
        assert rose.calls == 0
        kinds = [c.kind for c in chunks]
        assert kinds[0] == "metadata"
        assert "tool_call" in kinds and kinds[-1] == "done"
        tc = next(c for c in chunks if c.kind == "tool_call")
        assert tc.data["name"] == "attempt_completion_with_result"
        assert mem.set_calls == 0  # end-notch does not poison the cache

    asyncio.run(body())


def test_cold_explore_miss_passthrough_only_for_allowlisted_bench(mem):
    """Cold allowlisted (mass-agent) namespaces passthrough; other FM goals go live."""

    async def body_allowlisted():
        bench = _soft_complete_bench_goal()
        set_context(FastCacheContext(enabled=True, goal=bench, base_step=1, root_goal=bench))
        rose = FakeRose(_full_stream())
        chunks = await _drain(rose_cache.cached_complete(rose, call_site="explore_agent", pool="rose-1-flash"))
        assert rose.calls == 0
        tc = next(c for c in chunks if c.kind == "tool_call")
        assert tc.data["name"] == "attempt_completion_with_result"
        assert mem.set_calls == 0

    async def body_non_bench_goes_live():
        set_context(FastCacheContext(enabled=True, goal="Order Blue Bottle", base_step=1))
        rose = FakeRose(_full_stream())
        await _drain(rose_cache.cached_complete(rose, call_site="explore_agent", pool="rose-1-flash"))
        assert rose.calls == 1

    asyncio.run(body_allowlisted())
    asyncio.run(body_non_bench_goes_live())


def test_cold_explore_miss_does_not_soft_complete(mem):
    """Backward-compat alias: non-bench cold FM must not stub (goes live)."""

    async def body():
        set_context(FastCacheContext(enabled=True, goal="g", base_step=1))
        rose = FakeRose(_full_stream())
        await _drain(rose_cache.cached_complete(rose, call_site="explore_agent", pool="rose-1-flash"))
        assert rose.calls == 1
        # Live path may write-through the fresh response; the critical assertion is
        # that we did not emit a soft-complete attempt_completion stub.

    asyncio.run(body())


def test_write_only_cold_execute_loop_does_not_soft(mem):
    """Cold write-through execute_loop must not soft-complete (no prior slot).

    Write-through still falls through to live so allowlisted accounts can seed
    new namespaces; only Fast Mode *read* uses cold passthrough.
    """

    async def body():
        set_context(FastCacheContext(enabled=False, goal="g", write_enabled=True, base_step=1))
        rose = FakeRose(_full_stream())
        await _drain(rose_cache.cached_complete(rose, call_site="execute_loop", pool="rose-1-ultra"))
        assert rose.calls == 1

    asyncio.run(body())


def test_write_only_explore_continues_after_seeding_prior_step(mem, monkeypatch):
    """After write-through stores explore p:1, p:2 must call live LLM (not stub)."""

    async def prior_after_first(goal_hash, call_site, step):
        del goal_hash, call_site
        return step is not None and int(step) > 1

    monkeypatch.setattr(rose_cache.cache_client, "trajectory_prior_exists", prior_after_first)

    async def body():
        set_context(FastCacheContext(enabled=False, goal="spawn-smoke-explore", write_enabled=True, base_step=1))
        rose = FakeRose(_full_stream())
        await _drain(rose_cache.cached_complete(rose, call_site="explore_agent", pool="rose-1-flash"))
        assert rose.calls == 1
        assert mem.set_calls == 1

        set_context(FastCacheContext(enabled=False, goal="spawn-smoke-explore", write_enabled=True, base_step=2))
        rose2 = FakeRose(_full_stream())
        chunks = await _drain(rose_cache.cached_complete(rose2, call_site="explore_agent", pool="rose-1-flash"))
        assert rose2.calls == 1
        assert mem.set_calls == 2
        assert not any(
            getattr(c, "data", None) and c.data.get("name") == "attempt_completion_with_result"
            for c in chunks
            if c.kind == "tool_call"
        )

    asyncio.run(body())


def test_coerce_activity_shaped_response_schema_payload():
    """Activity-shaped {schema, usage} rows must replay as schema JSON, not empty content."""
    stored = {
        "schema": {
            "fields": [
                {"name": "positioning_statement", "type": "str", "required": True},
                {
                    "name": "top_creators_analysis",
                    "type": "list[object]",
                    "properties": [{"name": "creator_name", "type": "str"}],
                },
            ]
        },
        "usage": {"prompt_tokens": 1885, "completion_tokens": 301},
    }
    coerced = rose_cache.coerce_cached_llm_payload(stored)
    parsed = json.loads(coerced["content"])
    assert parsed["title"] == "Creator Brand Strategy"
    assert [field["name"] for field in parsed["fields"]] == [
        "positioning_statement",
        "top_creators_analysis",
    ]
    assert parsed["fields"][1]["properties"][0]["name"] == "creator_name"

    async def body():
        chunks = await _drain(rose_cache.replay(stored))
        content = "".join(c.data.get("text", "") for c in chunks if c.kind == "content")
        replayed = json.loads(content)
        assert replayed["fields"][0]["name"] == "positioning_statement"

    asyncio.run(body())


def test_coerce_activity_shaped_creator_schema_uses_meaningful_title():
    stored = {
        "title": "Task Output",
        "schema": {
            "fields": [
                {"name": "creator_name", "type": "str", "required": True},
                {"name": "posting_cadence_by_platform", "type": "str", "required": True},
                {"name": "hook_formulas", "type": "list[str]", "required": True},
            ]
        },
    }

    coerced = rose_cache.coerce_cached_llm_payload(stored)
    parsed = json.loads(coerced["content"])

    assert parsed["title"] == "Creator Analysis"
    assert parsed["title"] != "Task Output"


def test_response_schema_title_rejects_all_generic_explicit_and_derived_titles():
    schema = {"fields": [{"name": "result", "type": "str", "required": True}]}

    for title in ("Task", "Task Output", "Agent Run", "Result", "Output"):
        assert rose_cache.meaningful_response_schema_title(schema, title) == "Structured Deliverable"

    assert rose_cache.meaningful_response_schema_title(schema, "Revenue Forecast") == "Revenue Forecast"


def test_swf_miss_uses_scrape_passthrough_not_soft(mem):
    """summarize_web_fetch miss returns page text passthrough, not soft stub."""

    async def body():
        bench = _soft_complete_bench_goal()
        set_context(FastCacheContext(enabled=True, goal=bench, base_step=2, root_goal=bench))
        rose = FakeRose(_full_stream())
        chunks = await _drain(
            rose_cache.cached_complete(
                rose,
                call_site="summarize_web_fetch",
                pool="rose-1-flash",
                messages=[{"role": "user", "content": "SCRAPED PAGE BODY ABOUT CREATOR"}],
            )
        )
        assert rose.calls == 0
        content = "".join(c.data.get("text", "") for c in chunks if c.kind == "content")
        parsed = json.loads(content)
        assert "SCRAPED PAGE BODY" in parsed["summary"]
        assert mem.set_calls == 0

    asyncio.run(body())


def test_swf_miss_non_bench_goes_live(mem):
    """Non-allowlisted FM goals do not get SWF scrape passthrough stubs."""

    async def body():
        set_context(FastCacheContext(enabled=True, goal="Order coffee", base_step=2))
        rose = FakeRose(_full_stream())
        await _drain(
            rose_cache.cached_complete(
                rose,
                call_site="summarize_web_fetch",
                pool="rose-1-flash",
                messages=[{"role": "user", "content": "SCRAPED PAGE BODY ABOUT CREATOR"}],
            )
        )
        assert rose.calls == 1

    asyncio.run(body())


def _july_gp_child_goal() -> str:
    window = "2026-04-04 through 2026-07-03"  # pragma: allowlist secret
    return (
        "You are analyzing ONE creator for Andy Prevalsky, a technology founder "  # pragma: allowlist secret
        "building a personal brand at the intersection of health, longevity, "  # pragma: allowlist secret
        f"technology, and founder journey. Last 90 days: {window}. "  # pragma: allowlist secret
        "Creator: Dr. Eric Topol."
    )


def test_july_gp_execute_classifier_requires_bound_per_creator_goal():
    """Creator names inside synthesis prompts must not force a live GP path."""
    synthesis_goals = [
        'Build a 12-week calendar from [{"name":"Andrew Huberman"}, {"name":"Chris Williamson"}].',
        "Create reusable content hooks from the Andrew Huberman and Eric Topol analyses.",
        "Select exactly 20 creators, including Chris Williamson, for weekly engagement.",
    ]

    for goal in synthesis_goals:
        assert rose_cache.is_july_gp_execute_site(SimpleNamespace(goal=goal), "execute_loop") is False

    assert (
        rose_cache.is_july_gp_execute_site(
            SimpleNamespace(goal=_july_gp_child_goal()),
            "execute_loop",
        )
        is True
    )


def _july_web_search_payload() -> Dict[str, Any]:
    return {
        "actual_model": "fast-mode-replay",
        "pool_name": "rose-1-ultra",
        "request_id": "july-gp-p1",
        "content": "",
        "content_chunks": [],
        "reasoning": "",
        "tool_calls": [
            {
                "id": "call_july_gp_web_search",
                "name": "web_search",
                "arguments": '{"query":"Eric Topol recent content"}',
            }
        ],
        "codex_reasoning_items": [],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "from_fast_cache": True},
    }


def test_july_gp_execute_first_step_retries_and_replays_web_search(mem, monkeypatch):
    """First execute_loop get-position flake on a July GP child must retry, not stub.

    Prod 66732839 stubbed Sahil/Lenny/Gabrielle/DeLauer/Greg because p:1 flaked
    and trajectory_prior_exists(step=1) is false (no p:0). Replay must be
    web_search, never attempt_completion.
    """
    calls = {"n": 0}

    async def flake_then_hit(goal_hash, call_site, step=None):
        del goal_hash, call_site
        calls["n"] += 1
        if calls["n"] == 1 or step is None or int(step) < 1:
            return None, None
        return _july_web_search_payload(), f"fastmode:v42:llm:a33288f6c3a3e484:execute_loop:p:{step}"

    monkeypatch.setattr(rose_cache.cache_client, "cache_get_position_fallback", flake_then_hit)

    async def body():
        bench = _soft_complete_bench_goal()
        set_context(
            FastCacheContext(
                enabled=True,
                goal=_july_gp_child_goal(),
                base_step=1,
                root_goal=bench,
            )
        )
        rose = FakeRose(_full_stream())
        chunks = await _drain(rose_cache.cached_complete(rose, call_site="execute_loop", pool="rose-1-ultra"))
        assert rose.calls == 0
        assert calls["n"] >= 2
        tc = next(c for c in chunks if c.kind == "tool_call")
        assert tc.data["name"] == "web_search"
        assert not any(c.kind == "tool_call" and c.data.get("name") == "attempt_completion" for c in chunks)

    asyncio.run(body())


def test_july_gp_execute_skips_first_step_attempt_completion(mem, monkeypatch):
    """Sahil-style July p:1 attempt_completion must not 9-msg stub the child.

    Fall forward to the next research tool (web_search) instead.
    """
    stub = {
        "actual_model": "fast-mode-replay",
        "pool_name": "rose-1-ultra",
        "request_id": "july-gp-p1-stub",
        "content": "",
        "tool_calls": [
            {
                "id": "call_early_complete",
                "name": "attempt_completion",
                "arguments": '{"result":"Fast Mode cache trajectory ended for this agent."}',
            }
        ],
        "usage": {"from_fast_cache": True},
    }

    async def p1_stub_p2_search(goal_hash, call_site, step=None):
        del goal_hash, call_site
        if step is None or int(step) <= 1:
            return stub, "fastmode:v42:llm:a33288f6c3a3e484:execute_loop:p:1:c:x"
        return _july_web_search_payload(), f"fastmode:v42:llm:a33288f6c3a3e484:execute_loop:p:{step}:c:x"

    monkeypatch.setattr(rose_cache.cache_client, "cache_get_position_fallback", p1_stub_p2_search)

    async def body():
        bench = _soft_complete_bench_goal()
        set_context(
            FastCacheContext(
                enabled=True,
                goal=_july_gp_child_goal(),
                base_step=1,
                root_goal=bench,
            )
        )
        rose = FakeRose(_full_stream())
        chunks = await _drain(rose_cache.cached_complete(rose, call_site="execute_loop", pool="rose-1-ultra"))
        assert rose.calls == 0
        tc = next(c for c in chunks if c.kind == "tool_call")
        assert tc.data["name"] == "web_search"
        assert not any(c.kind == "tool_call" and c.data.get("name") == "attempt_completion" for c in chunks)

    asyncio.run(body())


def test_july_gp_execute_miss_does_not_cold_passthrough(mem):
    """Known July GP execute namespaces must not emit the 9-msg traj-end stub.

    After retries still miss, fall through to live rather than attempt_completion.
    Other FM trees (Tokyo / non-July execute) keep existing cold-passthrough.
    """

    async def july_goes_live():
        bench = _soft_complete_bench_goal()
        set_context(
            FastCacheContext(
                enabled=True,
                goal=_july_gp_child_goal(),
                base_step=1,
                root_goal=bench,
            )
        )
        rose = FakeRose(_full_stream())
        chunks = await _drain(rose_cache.cached_complete(rose, call_site="execute_loop", pool="rose-1-ultra"))
        assert rose.calls == 1
        assert not any(c.kind == "tool_call" and c.data.get("name") == "attempt_completion" for c in chunks)

    async def tokyo_still_stubs():
        bench = _soft_complete_bench_goal()
        set_context(
            FastCacheContext(
                enabled=True,
                goal="Find the current professional profile of Andy Prevalsky, founder of Rose Labs.",
                base_step=1,
                root_goal=bench,
            )
        )
        rose = FakeRose(_full_stream())
        chunks = await _drain(rose_cache.cached_complete(rose, call_site="execute_loop", pool="rose-1-ultra"))
        assert rose.calls == 0
        tc = next(c for c in chunks if c.kind == "tool_call")
        assert tc.data["name"] == "attempt_completion"

    asyncio.run(july_goes_live())
    asyncio.run(tokyo_still_stubs())


def test_read_only_benchmark_clean_miss_never_calls_provider(mem, monkeypatch):
    """A missing shared-cache row fails closed before any live benchmark spend."""
    from providers.fast_cache.rose_cache import FastCacheLookupError
    from providers.rose.client import RoseClient

    monkeypatch.setenv("FAST_MODE_CACHE_DISABLE_WRITE_THROUGH", "1")

    async def body():
        bench = _soft_complete_bench_goal()
        set_context(
            FastCacheContext(
                enabled=True,
                goal=_july_gp_child_goal(),
                base_step=1,
                root_goal=bench,
            )
        )
        client = RoseClient(openrouter_key="test-key")
        live_calls = {"n": 0}

        async def fake_impl(**_kwargs):
            live_calls["n"] += 1
            for chunk in _full_stream():
                yield chunk

        monkeypatch.setattr(client, "_complete_impl", fake_impl)
        with pytest.raises(FastCacheLookupError, match="Strict read-only benchmark cache miss"):
            await _drain(
                client.complete(
                    pool="rose-1-ultra",
                    messages=[{"role": "user", "content": "go"}],
                    call_site="execute_loop",
                    agent_id="agent-july-gp",
                )
            )
        assert live_calls["n"] == 0
        assert mem.set_calls == 0

    asyncio.run(body())


def test_rose_client_july_gp_execute_retry_replays_not_stub(mem, monkeypatch):
    """Production RoseClient.complete notch must retry July GP p:1 and replay tools."""
    from providers.rose.client import RoseClient

    calls = {"n": 0}

    async def flake_then_hit(goal_hash, call_site, step=None):
        del goal_hash, call_site
        calls["n"] += 1
        if calls["n"] == 1 or step is None or int(step) < 1:
            return None, None
        return _july_web_search_payload(), f"fastmode:v42:llm:a33288f6c3a3e484:execute_loop:p:{step}"

    monkeypatch.setattr("providers.fast_cache.client.cache_get_position_fallback", flake_then_hit)
    monkeypatch.setattr(rose_cache.cache_client, "cache_get_position_fallback", flake_then_hit)

    async def body():
        bench = _soft_complete_bench_goal()
        set_context(
            FastCacheContext(
                enabled=True,
                goal=_july_gp_child_goal(),
                base_step=1,
                root_goal=bench,
            )
        )
        client = RoseClient(openrouter_key="test-key")
        live_calls = {"n": 0}

        async def fake_impl(**kwargs):
            del kwargs
            live_calls["n"] += 1
            for c in _full_stream():
                yield c

        monkeypatch.setattr(client, "_complete_impl", fake_impl)
        chunks = await _drain(
            client.complete(
                pool="rose-1-ultra",
                messages=[{"role": "user", "content": "go"}],
                call_site="execute_loop",
                agent_id="agent-july-gp",
                dump_context=False,
            )
        )
        assert live_calls["n"] == 0
        assert calls["n"] >= 2
        tc = next(c for c in chunks if c.kind == "tool_call")
        assert tc.data["name"] == "web_search"

    asyncio.run(body())


def _july_explore_molly_goal() -> str:
    return (
        "Research public web/platform information for creator Molly Maloof (rank 19) "  # pragma: allowlist secret
        "for Andy Prevalsky's personal brand research in health, longevity, technology, "  # pragma: allowlist secret
        "and founder journey. Starting URLs: https://www.youtube.com/@drmollymaloof"
    )


def _july_explore_casey_goal() -> str:
    return (
        "Research public web/platform information for Casey Means for Andy "  # pragma: allowlist secret
        "Prevalsky's personal brand research in health, longevity, and founder journey."  # pragma: allowlist secret
    )


def test_extract_oai_demo_creator_from_rank_template_and_free_text():
    from utils.oai_demo_july import (
        extract_oai_demo_creator_name,
        july_explore_goal_hash_for_goal,
    )

    assert extract_oai_demo_creator_name(_july_explore_molly_goal()) == "Molly Maloof"
    assert extract_oai_demo_creator_name(_july_explore_casey_goal()) == "Casey Means"
    assert july_explore_goal_hash_for_goal(_july_explore_molly_goal()) == "1e80caff3f0e8008"
    assert july_explore_goal_hash_for_goal(_july_explore_casey_goal()) == "0931c308d4db5d54"
    assert extract_oai_demo_creator_name(_soft_complete_bench_goal()) is None


def test_july_explore_falls_back_to_july_hash_and_replays_web_search(mem, monkeypatch):
    """Cold templated GP explore prompts must replay July web_search, not complete."""
    july_hash = "1e80caff3f0e8008"

    async def by_hash(goal_hash, call_site, step=None):
        del call_site
        if goal_hash == july_hash and step is not None and int(step) >= 1:
            return _july_web_search_payload(), f"fastmode:v42:llm:{july_hash}:explore_agent:p:{step}"
        return None, None

    monkeypatch.setattr(rose_cache.cache_client, "cache_get_position_fallback", by_hash)

    async def body():
        bench = _soft_complete_bench_goal()
        set_context(
            FastCacheContext(
                enabled=True,
                goal=_july_explore_molly_goal(),
                base_step=1,
                root_goal=bench,
            )
        )
        rose = FakeRose(_full_stream())
        chunks = await _drain(rose_cache.cached_complete(rose, call_site="explore_agent", pool="rose-1-flash"))
        assert rose.calls == 0
        tc = next(c for c in chunks if c.kind == "tool_call")
        assert tc.data["name"] == "web_search"
        assert not any(
            c.kind == "tool_call" and c.data.get("name") in {"attempt_completion", "attempt_completion_with_result"}
            for c in chunks
        )

    asyncio.run(body())


def test_july_explore_skips_first_step_attempt_completion(mem, monkeypatch):
    """July explore p:1 completion must not reject-loop the chip."""
    stub = {
        "actual_model": "fast-mode-replay",
        "pool_name": "rose-1-flash",
        "request_id": "july-explore-p1-stub",
        "content": "",
        "tool_calls": [
            {
                "id": "call_early_complete",
                "name": "attempt_completion_with_result",
                "arguments": '{"result":"Fast Mode cache trajectory ended for this agent."}',
            }
        ],
        "usage": {"from_fast_cache": True},
    }
    july_hash = "1e80caff3f0e8008"

    async def p1_stub_then_search(goal_hash, call_site, step=None):
        del call_site
        if goal_hash != july_hash or step is None:
            return None, None
        if int(step) <= 1:
            return stub, f"fastmode:v42:llm:{july_hash}:explore_agent:p:1:c:x"
        return _july_web_search_payload(), f"fastmode:v42:llm:{july_hash}:explore_agent:p:{step}:c:x"

    monkeypatch.setattr(rose_cache.cache_client, "cache_get_position_fallback", p1_stub_then_search)

    async def body():
        bench = _soft_complete_bench_goal()
        set_context(
            FastCacheContext(
                enabled=True,
                goal=_july_explore_molly_goal(),
                base_step=1,
                root_goal=bench,
            )
        )
        rose = FakeRose(_full_stream())
        chunks = await _drain(rose_cache.cached_complete(rose, call_site="explore_agent", pool="rose-1-flash"))
        assert rose.calls == 0
        tc = next(c for c in chunks if c.kind == "tool_call")
        assert tc.data["name"] == "web_search"

    asyncio.run(body())


def test_july_explore_replays_last_step_completion_summary(mem, monkeypatch):
    """After research, the last cached attempt_completion is the explore wrap-up."""
    summary = (
        "Nick Norwitz posts ~4x/week on YouTube and Substack. "
        "Top hooks are mechanism-first metabolic explainers with June 2026 "
        "Stay Curious view proxies from @nicknorwitzPhD."
    )
    completion = {
        "actual_model": "fast-mode-replay",
        "pool_name": "rose-1-flash",
        "request_id": "july-explore-last-complete",
        "content": "",
        "tool_calls": [
            {
                "id": "call_last_complete",
                "name": "attempt_completion_with_result",
                "arguments": json.dumps({"result": summary}),
            }
        ],
        "usage": {"from_fast_cache": True},
    }
    july_hash = "1e80caff3f0e8008"

    async def research_then_complete(goal_hash, call_site, step=None):
        del call_site
        if goal_hash != july_hash or step is None:
            return None, None
        if int(step) >= 5:
            return completion, f"fastmode:v42:llm:{july_hash}:explore_agent:p:{step}:c:x"
        return _july_web_search_payload(), f"fastmode:v42:llm:{july_hash}:explore_agent:p:{step}:c:x"

    monkeypatch.setattr(rose_cache.cache_client, "cache_get_position_fallback", research_then_complete)

    async def body():
        bench = _soft_complete_bench_goal()
        set_context(
            FastCacheContext(
                enabled=True,
                goal=_july_explore_molly_goal(),
                base_step=5,
                root_goal=bench,
            )
        )
        rose = FakeRose(_full_stream())
        chunks = await _drain(rose_cache.cached_complete(rose, call_site="explore_agent", pool="rose-1-flash"))
        assert rose.calls == 0
        tc = next(c for c in chunks if c.kind == "tool_call")
        assert tc.data["name"] == "attempt_completion_with_result"
        assert "Stay Curious" in str(tc.data.get("arguments") or "")

    asyncio.run(body())


def test_july_explore_recovers_last_completion_when_step_exhausted(mem, monkeypatch):
    """Past the last cached row, replay the real wrap-up instead of a stub."""
    summary = (
        "Nick Norwitz posts about four times a week on YouTube and Substack. "
        "Top hooks are mechanism-first metabolic explainers with June 2026 "
        "Stay Curious view proxies from the nicknorwitzPhD channel, plus "
        "Instagram cadence and newsletter takeaways for a new personal brand."  # pragma: allowlist secret
    )
    completion = {
        "actual_model": "fast-mode-replay",
        "pool_name": "rose-1-flash",
        "request_id": "july-explore-recovered-complete",
        "content": "",
        "tool_calls": [
            {
                "id": "call_recovered_complete",
                "name": "attempt_completion_with_result",
                "arguments": json.dumps({"result": summary}),
            }
        ],
        "usage": {"from_fast_cache": True},
    }
    july_hash = "1e80caff3f0e8008"

    async def exhausted_after_complete(goal_hash, call_site, step=None):
        del call_site
        if goal_hash != july_hash or step is None:
            return None, None
        n = int(step)
        if n == 5:
            return completion, f"fastmode:v42:llm:{july_hash}:explore_agent:p:5:c:x"
        if n < 5:
            return _july_web_search_payload(), f"fastmode:v42:llm:{july_hash}:explore_agent:p:{n}:c:x"
        return None, None

    monkeypatch.setattr(rose_cache.cache_client, "cache_get_position_fallback", exhausted_after_complete)

    async def body():
        bench = _soft_complete_bench_goal()
        set_context(
            FastCacheContext(
                enabled=True,
                goal=_july_explore_molly_goal(),
                base_step=8,
                root_goal=bench,
            )
        )
        rose = FakeRose(_full_stream())
        chunks = await _drain(rose_cache.cached_complete(rose, call_site="explore_agent", pool="rose-1-flash"))
        assert rose.calls == 0
        tc = next(c for c in chunks if c.kind == "tool_call")
        assert tc.data["name"] == "attempt_completion_with_result"
        assert "Stay Curious" in str(tc.data.get("arguments") or "")

    asyncio.run(body())


def test_july_explore_miss_does_not_cold_passthrough(mem):
    """Known July explore namespaces must not emit attempt_completion_with_result."""

    async def molly_goes_live():
        bench = _soft_complete_bench_goal()
        set_context(
            FastCacheContext(
                enabled=True,
                goal=_july_explore_molly_goal(),
                base_step=1,
                root_goal=bench,
            )
        )
        rose = FakeRose(_full_stream())
        chunks = await _drain(rose_cache.cached_complete(rose, call_site="explore_agent", pool="rose-1-flash"))
        assert rose.calls == 1
        assert not any(c.kind == "tool_call" and c.data.get("name") == "attempt_completion_with_result" for c in chunks)

    asyncio.run(molly_goes_live())


def test_rose_client_july_explore_fallback_replays_web_search(mem, monkeypatch):
    """Production RoseClient.complete must fall back to the July explore namespace."""
    from providers.rose.client import RoseClient

    july_hash = "1e80caff3f0e8008"

    async def by_hash(goal_hash, call_site, step=None):
        del call_site
        if goal_hash == july_hash and step is not None and int(step) >= 1:
            return _july_web_search_payload(), f"fastmode:v42:llm:{july_hash}:explore_agent:p:{step}"
        return None, None

    monkeypatch.setattr("providers.fast_cache.client.cache_get_position_fallback", by_hash)
    monkeypatch.setattr(rose_cache.cache_client, "cache_get_position_fallback", by_hash)

    async def body():
        bench = _soft_complete_bench_goal()
        set_context(
            FastCacheContext(
                enabled=True,
                goal=_july_explore_molly_goal(),
                base_step=1,
                root_goal=bench,
            )
        )
        client = RoseClient(openrouter_key="test-key")
        live_calls = {"n": 0}

        async def fake_impl(**kwargs):
            del kwargs
            live_calls["n"] += 1
            for c in _full_stream():
                yield c

        monkeypatch.setattr(client, "_complete_impl", fake_impl)
        chunks = await _drain(
            client.complete(
                pool="rose-1-flash",
                messages=[{"role": "user", "content": "go"}],
                call_site="explore_agent",
                agent_id="agent-july-explore",
                dump_context=False,
            )
        )
        assert live_calls["n"] == 0
        tc = next(c for c in chunks if c.kind == "tool_call")
        assert tc.data["name"] == "web_search"

    asyncio.run(body())


@pytest.mark.parametrize("boundary", ["unresolved-context", "browser-bypass", "non-demo-cache-miss"])
def test_demo_cache_probe_refuses_unresolved_or_uncached_live_provider(mem, monkeypatch, boundary):
    """The opted-in isolated probe never spends after cache admission is lost."""
    from providers.fast_cache import client as cache_client
    from providers.fast_cache.rose_cache import FastCacheLookupError
    from providers.rose.client import RoseClient

    monkeypatch.setenv("BENCHMARK_DEMO_CACHE_READ_ONLY", "1")
    monkeypatch.setenv("BENCHMARK_ISOLATED_RUN", "true")
    monkeypatch.setenv("FAST_MODE_CACHE_DISABLE_WRITE_THROUGH", "1")

    async def unresolved(*_args, **_kwargs):
        return None

    async def normal_provider_speed(*_args, **_kwargs):
        return False

    monkeypatch.setattr(cache_client, "ensure_context", unresolved)
    monkeypatch.setattr(cache_client, "resolve_provider_fast_mode", normal_provider_speed)

    async def body():
        token = set_context(
            FastCacheContext(enabled=True, goal="ordinary goal", base_step=1)
            if boundary == "non-demo-cache-miss"
            else None
        )
        client = RoseClient(openrouter_key="test-key")
        live_calls = {"n": 0}

        async def live_boundary(**_kwargs):
            live_calls["n"] += 1
            for chunk in _full_stream():
                yield chunk

        monkeypatch.setattr(client, "_complete_impl", live_boundary)
        try:
            with pytest.raises(FastCacheLookupError, match="DEMO replay probe.*live"):
                await _drain(
                    client.complete(
                        pool="rose-1-browser-use" if boundary == "browser-bypass" else "rose-1-ultra",
                        messages=[{"role": "user", "content": "go"}],
                        call_site="response_schema",
                        agent_id="agent-fixture",
                    )
                )
            assert live_calls["n"] == 0
            assert mem.set_calls == 0
        finally:
            reset_context(token)

    asyncio.run(body())


@pytest.mark.parametrize("probe,isolated", [(None, "true"), ("1", None)])
def test_demo_cache_probe_flag_off_or_nonisolated_preserves_live_fallback(mem, monkeypatch, probe, isolated):
    """The new guard must not redefine the generic read-only write flag."""
    from providers.fast_cache import client as cache_client
    from providers.rose.client import RoseClient

    for key, value in {"BENCHMARK_DEMO_CACHE_READ_ONLY": probe, "BENCHMARK_ISOLATED_RUN": isolated}.items():
        if value is None:
            monkeypatch.delenv(key, raising=False)
        else:
            monkeypatch.setenv(key, value)
    monkeypatch.setenv("FAST_MODE_CACHE_DISABLE_WRITE_THROUGH", "1")

    async def unresolved(*_args, **_kwargs):
        return None

    async def normal_provider_speed(*_args, **_kwargs):
        return False

    monkeypatch.setattr(cache_client, "ensure_context", unresolved)
    monkeypatch.setattr(cache_client, "resolve_provider_fast_mode", normal_provider_speed)

    async def body():
        token = set_context(None)
        client = RoseClient(openrouter_key="test-key")
        live_calls = {"n": 0}

        async def live_boundary(**_kwargs):
            live_calls["n"] += 1
            for chunk in _full_stream():
                yield chunk

        monkeypatch.setattr(client, "_complete_impl", live_boundary)
        try:
            chunks = await _drain(
                client.complete(
                    pool="rose-1-ultra",
                    messages=[{"role": "user", "content": "go"}],
                    call_site="response_schema",
                    agent_id="agent-fixture",
                )
            )
            assert chunks
            assert live_calls["n"] == 1
            assert mem.set_calls == 0
        finally:
            reset_context(token)

    asyncio.run(body())


@pytest.mark.parametrize("probe", ["1", None])
def test_demo_cache_probe_compatibility_wrapper_fences_non_demo_miss(mem, monkeypatch, probe):
    """Legacy callers must not bypass the opted-in task guard through _complete_impl."""
    from providers.fast_cache.rose_cache import FastCacheLookupError
    from providers.rose.client import RoseClient

    if probe is None:
        monkeypatch.delenv("BENCHMARK_DEMO_CACHE_READ_ONLY", raising=False)
    else:
        monkeypatch.setenv("BENCHMARK_DEMO_CACHE_READ_ONLY", probe)
    monkeypatch.setenv("BENCHMARK_ISOLATED_RUN", "true")
    monkeypatch.setenv("FAST_MODE_CACHE_DISABLE_WRITE_THROUGH", "1")

    async def body():
        token = set_context(FastCacheContext(enabled=True, goal="ordinary goal", base_step=1))
        client = RoseClient(openrouter_key="test-key")
        live_calls = {"n": 0}

        async def live_boundary(**_kwargs):
            live_calls["n"] += 1
            for chunk in _full_stream():
                yield chunk

        monkeypatch.setattr(client, "_complete_impl", live_boundary)
        try:
            stream = rose_cache.cached_complete(
                client,
                pool="rose-1-ultra",
                messages=[{"role": "user", "content": "go"}],
                call_site="response_schema",
                agent_id="agent-fixture",
            )
            if probe is not None:
                with pytest.raises(FastCacheLookupError, match="DEMO replay probe.*live"):
                    await _drain(stream)
                assert live_calls["n"] == 0
            else:
                assert await _drain(stream)
                assert live_calls["n"] == 1
            assert mem.set_calls == 0
        finally:
            reset_context(token)

    asyncio.run(body())


@pytest.mark.parametrize(
    "replay_control",
    [
        test_july_gp_execute_first_step_retries_and_replays_web_search,
        test_rose_client_july_gp_execute_retry_replays_not_stub,
    ],
    ids=["compatibility-wrapper", "central-client"],
)
def test_demo_cache_probe_preserves_existing_recorded_replay_hits(mem, monkeypatch, replay_control):
    """Reuse the owning July replay controls under the exact CLI guard flags."""
    monkeypatch.setenv("BENCHMARK_DEMO_CACHE_READ_ONLY", "1")
    monkeypatch.setenv("BENCHMARK_ISOLATED_RUN", "true")
    monkeypatch.setenv("FAST_MODE_CACHE_DISABLE_WRITE_THROUGH", "1")
    replay_control(mem, monkeypatch)
    assert mem.set_calls == 0


def test_simulated_root_and_gp_cache_isolates_immutable_execution_policy(monkeypatch):
    monkeypatch.setenv("WMH_MODEL_NAME", "rose-archive")
    monkeypatch.setenv("BENCHMARK_WORLD_MODEL_MODE", "simulate")
    monkeypatch.delenv("WMH_EXECUTION_POLICY", raising=False)
    baseline_scope = normalize.world_model_cache_scope()
    baseline = normalize.content_key(
        "DEMO FIXTURE ONLY root goal", "root_gp_call", [{"role": "user", "content": "same goal"}]
    )
    baseline_global = normalize.build_global_key("lookup", "same-request")
    assert baseline_scope == "sim.rose-archive:"
    old_cache = {baseline: "baseline no-route result", baseline_global: "baseline route lookup"}
    for policy, version, digest in (
        ("rose-virtual-public-affordances-v1", "1", "49d9d1f0430a5d8e"),
        ("rose-virtual-public-affordances-v2", "2", "5dd9924e9a1ff4c5"),
        ("rose-outcome-distribution-v1", "1", "650945bf68ee4ba6"),
        ("rose-outcome-distribution-v2", "2", "23feae1291f883f0"),
        ("rose-outcome-distribution-v3", "3", "3ace77b6b1a3a33c"),
        ("rose-outcome-distribution-v4", "4", "dc3c757c601515ff"),
    ):
        monkeypatch.setenv("WMH_EXECUTION_POLICY", policy)
        scope = normalize.world_model_cache_scope()
        candidate = normalize.content_key(
            "DEMO FIXTURE ONLY root goal", "root_gp_call", [{"role": "user", "content": "same goal"}]
        )
        candidate_global = normalize.build_global_key("lookup", "same-request")
        assert scope == f"sim.rose-archive.policy.{policy}.{version}.{digest}:"
        assert candidate not in old_cache and candidate_global not in old_cache
        assert candidate == normalize.content_key(
            "DEMO FIXTURE ONLY root goal", "root_gp_call", [{"content": "same goal", "role": "user"}]
        )
        assert candidate_global == normalize.build_global_key("lookup", "same-request")
        old_cache.update({candidate: policy, candidate_global: policy})
    monkeypatch.setenv("WMH_EXECUTION_POLICY", "unapproved")
    with pytest.raises(ValueError, match="Unknown WMH execution policy"):
        normalize.world_model_cache_scope()
    # Real/shadow keys remain byte-identical regardless of configured policy,
    # including the v4 registration (production never runs in simulate mode).
    for policy in ("unapproved", "rose-outcome-distribution-v4"):
        monkeypatch.setenv("WMH_EXECUTION_POLICY", policy)
        monkeypatch.delenv("BENCHMARK_WORLD_MODEL_MODE")
        assert normalize.world_model_cache_scope() == ""
        assert normalize.build_global_key("lookup", "same-request") == (
            f"fastmode:{normalize.CACHE_KEY_VERSION}:lookup:global:same-request"
        )
        monkeypatch.setenv("BENCHMARK_WORLD_MODEL_MODE", "shadow")
        assert normalize.world_model_cache_scope() == ""


def test_world_model_policy_cache_identities_match_the_immutable_registry():
    """The runtime cache scope must not import benchmark modules, yet it must
    reproduce each registered policy's exact (version, sha256 prefix)."""
    from benchmarks import wmh_execution_policy as policies

    registered = {}
    for name in policies._POLICIES:
        if name == policies.DEFAULT_EXECUTION_POLICY:
            continue
        policy = policies.execution_policy(name)
        registered[name] = (policy.version, policy.metadata()["policy_sha256"][:16])
    assert normalize.WMH_POLICY_CACHE_IDENTITIES == registered


def test_backend_policy_cache_identities_mirror_the_immutable_registry():
    """The backend's simulate-mode cache scope throws for an unlisted policy, so
    its TypeScript mirror must carry every registered policy exactly."""
    import re

    from benchmarks import wmh_execution_policy as policies

    source = (Path(__file__).resolve().parents[3] / "back-end/src/providers/fastCacheNormalizeConstants.ts").read_text()
    constants = dict(re.findall(r"const (WMH_[A-Z0-9_]+) =\s*'([^']+)'", source))
    table = source[
        source.index("const WMH_EXECUTION_POLICIES") : source.index("]);", source.index("const WMH_EXECUTION_POLICIES"))
    ]
    mirrored = {}
    for name, version, sha in re.findall(
        r"\[\s*('[^']+'|WMH_[A-Z0-9_]+),\s*\{\s*version:\s*('[^']+'|WMH_[A-Z0-9_]+),\s*sha256:\s*('[^']+'|WMH_[A-Z0-9_]+)",
        table,
    ):
        value = lambda token: token.strip("'") if token.startswith("'") else constants[token]  # noqa: E731
        mirrored[value(name)] = (value(version), value(sha))
    registered = {
        name: (policies.execution_policy(name).version, policies.execution_policy(name).metadata()["policy_sha256"])
        for name in policies.registered_execution_policies()
        if name != policies.DEFAULT_EXECUTION_POLICY
    }
    assert mirrored == registered


@pytest.mark.parametrize("base_step", [None, 7], ids=["content", "position"])
@pytest.mark.parametrize(
    "tool_choice",
    [None, "auto", {"type": "function", "function": {"name": "set_plan"}}],
    ids=["default", "auto", "forced-function"],
)
def test_simulated_v2_cache_misses_v1_and_replays_its_own_tool_choice(mem, monkeypatch, base_step, tool_choice):
    """Actual cache read/write/replay must preserve policy and tool-choice custody."""
    monkeypatch.setenv("BENCHMARK_WORLD_MODEL_MODE", "simulate")
    monkeypatch.setenv("WMH_MODEL_NAME", "rose-archive")
    monkeypatch.delenv("FAST_MODE_CACHE_DISABLE_WRITE_THROUGH", raising=False)
    kwargs = {
        "pool": "rose-1-ultra",
        "messages": [{"role": "user", "content": "same goal"}],
        "tool_choice": tool_choice,
        "provider_fast_mode": True,
    }

    async def body():
        monkeypatch.setenv("WMH_EXECUTION_POLICY", "rose-virtual-public-affordances-v1")
        set_context(FastCacheContext(enabled=True, goal="g", base_step=base_step))
        old_chunks = _full_stream()
        old_chunks[1].data["text"] = "v1 stale "
        old_rose = FakeRose(old_chunks)
        await _drain(rose_cache.cached_complete(old_rose, call_site="response_schema", **kwargs))
        assert old_rose.calls == 1 and mem.set_calls == 1
        old_keys = set(mem.data)

        monkeypatch.setenv("WMH_EXECUTION_POLICY", "rose-virtual-public-affordances-v2")
        context = FastCacheContext(enabled=True, goal="g", base_step=base_step)
        set_context(context)
        material = rose_cache.request_key_material(kwargs)
        assert material["tool_choice"] == tool_choice
        key = context.llm_key("response_schema", material)
        assert key not in old_keys
        assert not old_keys.intersection(context.llm_lookup_keys("response_schema", material))
        choices = [None, "auto", {"type": "function", "function": {"name": "set_plan"}}]
        choice_keys = {
            context.llm_key("response_schema", rose_cache.request_key_material({**kwargs, "tool_choice": choice}))
            for choice in choices
        }
        assert len(choice_keys) == len(choices)

        new_chunks = _full_stream()
        new_chunks[1].data["text"] = "v2 fresh "
        new_rose = FakeRose(new_chunks)
        await _drain(rose_cache.cached_complete(new_rose, call_site="response_schema", **kwargs))
        assert new_rose.calls == 1 and mem.set_calls == 2
        assert mem.data[key]["content"] == "v2 fresh world"

        set_context(FastCacheContext(enabled=True, goal="g", base_step=base_step))
        replay_rose = FakeRose(_full_stream())
        replay = await _drain(rose_cache.cached_complete(replay_rose, call_site="response_schema", **kwargs))
        assert replay_rose.calls == 0 and mem.set_calls == 2
        assert "".join(c.data.get("text", "") for c in replay if c.kind == "content") == "v2 fresh world"
        assert next(c for c in replay if c.kind == "metadata").data["from_fast_cache"] is True

    asyncio.run(body())


def test_demo_replay_namespace_rejects_live_write_through(monkeypatch):
    """A live miss must not add entries to a frozen DEMO recording.

    On 2026-10-09 a team write-through run stored a fresh response_schema under
    the DEMO mass-agent goal; later replays mixed it with the July outputs.
    """
    import asyncio

    from benchmarks.benchmark_tasks import get_task_by_name
    from providers.fast_cache import client, context, normalize

    demo_goal = get_task_by_name("test-mass-agent-run-0").prompt
    posts = []

    class _Response:
        status_code = 200

        @staticmethod
        def json():
            return {"ok": True, "stored": True}

    class _Recorder:
        async def post(self, url, **kwargs):
            posts.append(kwargs["json"]["key"])
            return _Response()

    async def _no_archive(*_args, **_kwargs):
        return None

    monkeypatch.setattr(client, "_shared_client", lambda: _Recorder())
    monkeypatch.setattr(client, "_backend", lambda: ("http://backend.invalid", "key"))
    monkeypatch.setattr(client, "_archive_cache_write", _no_archive)
    monkeypatch.delenv("FAST_MODE_CACHE_RECORD_DEMO", raising=False)
    monkeypatch.delenv("FAST_MODE_CACHE_DISABLE_WRITE_THROUGH", raising=False)

    demo_hash = normalize.goal_hash(demo_goal)
    assert asyncio.run(client.cache_set("demo-key", "llm", demo_hash, {"schema": {}})) is False
    child = context.FastCacheContext(enabled=True, goal="for_each child", root_goal=demo_goal, write_enabled=True)
    assert child.should_write is False
    # Direct callers (browser-use, web search/fetch, files) pass their goal so an
    # identity-bound OAi child goal is guarded even though its hash differs.
    from utils.oai_demo import OAI_DEMO_CACHE_DISPLAY_NAME, OAI_DEMO_CHILD_GOAL_PREFIX

    bound_child = f"{OAI_DEMO_CHILD_GOAL_PREFIX} for {OAI_DEMO_CACHE_DISPLAY_NAME}"
    child_hash = normalize.goal_hash(bound_child)
    assert child_hash not in normalize.demo_cache_goal_hashes()
    assert asyncio.run(client.cache_set("child-key", "web_search", child_hash, {}, goal=bound_child)) is False
    ordinary = normalize.goal_hash("an ordinary non-demo goal")
    assert asyncio.run(client.cache_set("ordinary-key", "llm", ordinary, {"schema": {}})) is True
    assert posts == ["ordinary-key"]

    # A deliberate re-recording may still write the DEMO namespace.
    monkeypatch.setenv("FAST_MODE_CACHE_RECORD_DEMO", "1")
    assert child.should_write is True
    assert asyncio.run(client.cache_set("demo-key", "llm", demo_hash, {"schema": {}})) is True
    assert posts == ["ordinary-key", "demo-key"]
