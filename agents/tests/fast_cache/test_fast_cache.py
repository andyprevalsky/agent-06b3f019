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

import pytest
from pydantic import BaseModel

from providers.fast_cache import normalize
from providers.fast_cache.context import (
    FastCacheContext,
    is_enabled,
    reset_context,
    set_context,
)
from providers.fast_cache import rose_cache
from providers.rose.pools import POOL_REGISTRY


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

    async def set(self, key: str, kind: str, goal_hash: str, value: Any) -> bool:
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
    return store


async def _drain(agen) -> List[Any]:
    return [c async for c in agen]


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
        assert f":sim.rose-archive-v2:" in key

    # Different world models get different namespaces.
    monkeypatch.setenv("WMH_MODEL_NAME", "rose-archive-v3")
    assert normalize.build_key("llm", "goal", "detail") != sim_key


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


def test_llm_request_key_separates_anthropic_exclusion_policy(monkeypatch):
    monkeypatch.delenv("ROSE_EXCLUDE_ANTHROPIC_FAMILY", raising=False)
    ctx = FastCacheContext(enabled=True, goal="same goal", base_step=1)
    normal = rose_cache.request_key_material({"pool": "rose-1-ultra"})
    excluded = rose_cache.request_key_material(
        {"pool": "rose-1-ultra", "_exclude_anthropic_family": True}
    )

    assert ctx.llm_key("execute_loop", normal) != ctx.llm_key("execute_loop", excluded)


def test_llm_request_key_resolves_environment_provider_policy(monkeypatch):
    """Outer cached_complete and RoseClient.complete must fingerprint one policy."""
    monkeypatch.setenv("ROSE_EXCLUDE_ANTHROPIC_FAMILY", "1")
    implicit = rose_cache.request_key_material({"pool": "rose-1-ultra"})
    explicit = rose_cache.request_key_material(
        {"pool": "rose-1-ultra", "_exclude_anthropic_family": True}
    )

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


def test_position_llm_key_ignores_completion_summary_structured_output_block():
    ctx = FastCacheContext(enabled=True, goal="same coding-agent goal", base_step=0)
    cold_request = {
        "pool": "rose-1-lite",
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
            {"role": "user", "content": "prior live output A"},
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
            {"role": "user", "content": "prior live output B"},
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
    async def body():
        set_context(FastCacheContext(enabled=False, goal="g", write_enabled=True))
        rose = FakeRose(_full_stream())
        await _drain(rose_cache.cached_complete(rose, call_site="execute_loop", pool="rose-1-ultra"))
        assert rose.calls == 1
        assert mem.get_calls == 0
        assert mem.set_calls == 1
        assert len(mem.data) == 1

    asyncio.run(body())


def test_write_only_context_uses_provider_fast_mode(mem):
    async def body():
        set_context(FastCacheContext(enabled=False, goal="g", write_enabled=True))
        rose = FakeRose(_full_stream())
        await _drain(rose_cache.cached_complete(rose, call_site="execute_loop", pool="rose-1-ultra"))
        assert rose.calls == 1
        assert mem.set_calls == 1
        assert next(iter(mem.data.keys())) == FastCacheContext(enabled=True, goal="g").llm_key(
            "execute_loop",
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
    async def body():
        set_context(FastCacheContext(enabled=True, goal="g"))
        rose = FakeRose(_full_stream())
        await _drain(rose_cache.cached_complete(rose, call_site="execute_loop", pool="rose-1-ultra"))
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
                call_site="execute_loop",
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
        await _drain(rose_cache.cached_complete(rose, call_site="execute_loop", pool="rose-1-ultra"))
        assert mem.data == {}

    asyncio.run(body())


def test_hit_replays_without_calling_rose(mem):
    # #11 replay = no third-party egress; #12 re-streamed.
    async def body():
        set_context(FastCacheContext(enabled=True, goal="g"))
        await _drain(
            rose_cache.cached_complete(FakeRose(_full_stream()), call_site="execute_loop", pool="rose-1-ultra")
        )

        # Second run, fresh context (new run, same goal) — must hit.
        set_context(FastCacheContext(enabled=True, goal="g"))
        rose2 = FakeRose(_full_stream())
        chunks = await _drain(rose_cache.cached_complete(rose2, call_site="execute_loop", pool="rose-1-ultra"))

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
        usage = next(c for c in chunks if c.kind == "usage")
        assert usage.data["prompt_tokens"] == 0
        assert usage.data["cache_read_input_tokens"] == 10
        assert usage.data["cache_creation_input_tokens"] == 0

    asyncio.run(body())


def test_replay_after_write_does_not_rewrite(mem):
    # #10 replaying the same key hits cache and does not call live Rose again.
    async def body():
        set_context(FastCacheContext(enabled=True, goal="g"))
        await _drain(
            rose_cache.cached_complete(FakeRose(_full_stream()), call_site="execute_loop", pool="rose-1-ultra")
        )
        set_context(FastCacheContext(enabled=True, goal="g"))
        # Second run MISSes? No — same key already present → it HITS and won't write again.
        await _drain(
            rose_cache.cached_complete(FakeRose(_full_stream()), call_site="execute_loop", pool="rose-1-ultra")
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
                call_site="execute_loop",
                pool="rose-1-ultra",
                messages=first_messages,
            )
        )

        set_context(FastCacheContext(enabled=True, goal="g"))
        hit_rose = FakeRose(_full_stream())
        await _drain(
            rose_cache.cached_complete(
                hit_rose,
                call_site="execute_loop",
                pool="rose-1-ultra",
                messages=first_messages,
            )
        )
        miss_rose = FakeRose(_full_stream())
        await _drain(
            rose_cache.cached_complete(
                miss_rose,
                call_site="execute_loop",
                pool="rose-1-ultra",
                messages=second_messages,
            )
        )

        assert hit_rose.calls == 0  # same canonical request replayed
        assert miss_rose.calls == 1  # changed request went live
        assert len(mem.data) == 2  # both request fingerprints now cached

    asyncio.run(body())


def test_get_error_falls_through_to_live(monkeypatch):
    # #16 a backend read error must NOT break the run — degrade to a live miss.
    async def boom(key: str):
        raise RuntimeError("backend down")

    async def noop_set(*a, **k):
        return True

    monkeypatch.setattr(rose_cache.cache_client, "cache_get", boom)
    monkeypatch.setattr(rose_cache.cache_client, "cache_set", noop_set)

    async def body():
        set_context(FastCacheContext(enabled=True, goal="g"))
        rose = FakeRose(_full_stream())
        chunks = await _drain(rose_cache.cached_complete(rose, call_site="execute_loop", pool="rose-1-ultra"))
        assert rose.calls == 1  # degraded to a live call instead of crashing
        assert chunks[-1].kind == "done"

    asyncio.run(body())


def test_resolve_fast_cache_goal_activity_returns_persisted_row_goal(monkeypatch):
    # The workflow keys the cache namespace by the persisted Agent-row goal, not
    # its (possibly chat-refined) input goal. This activity is that resolution.
    import providers.fast_cache.client as cache_client_module
    from helpers.fast_cache_goal import resolve_fast_cache_goal_activity

    async def fake_resolve(agent_id: str):
        assert agent_id == "agent-1"
        return True, "persisted row goal", True, "agent-1"

    monkeypatch.setattr(cache_client_module, "resolve_agent_fast_mode", fake_resolve)

    async def body():
        assert await resolve_fast_cache_goal_activity("agent-1") == "persisted row goal"

    asyncio.run(body())


def test_resolve_fast_cache_goal_activity_none_on_unresolved(monkeypatch):
    import providers.fast_cache.client as cache_client_module
    from helpers.fast_cache_goal import resolve_fast_cache_goal_activity

    async def fake_resolve(agent_id: str):
        return False, None, False, None

    monkeypatch.setattr(cache_client_module, "resolve_agent_fast_mode", fake_resolve)

    async def body():
        assert await resolve_fast_cache_goal_activity("agent-x") is None

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
