"""Fast Mode cache boundary: no whole-tool result replay."""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def _read(relpath: str) -> str:
    return (ROOT / relpath).read_text()


def test_fast_mode_does_not_cache_whole_tool_results():
    production_sources = "\n".join(
        [
            _read("domains/spawn_agent/service.py"),
            _read("domains/spawn_sub_agents/handler.py"),
            _read("domains/spawn_sub_agents/service.py"),
            _read("domains/spawn_claude_code_agent/service.py"),
            _read("worker.py"),
        ]
    )

    disallowed_markers = [
        "explore_agent_result",
        "sub_agent_result",
        "claude_code_agent_result",
        "demo_cache.explore_result_",
        "demo_cache.sub_agent_result_",
        "demo_cache.code_agent_result_",
        "demo-cache:sub-agent",
        "cached_activity_result",
    ]
    for marker in disallowed_markers:
        assert marker not in production_sources


def test_fast_mode_still_allows_leaf_provider_and_llm_caches():
    rose_client = _read("providers/rose/client.py")
    web_search = _read("tools/web_search/handler.py")
    web_fetch = _read("domains/web_fetch/handler.py")
    browser_http = _read("providers/demo_cache/browser_http.py")

    assert "llm.cache.replay" in rose_client
    assert "demo_cache.web_search_hit" in web_search
    assert "demo_cache.web_fetch_hit" in web_fetch
    assert "demo_cache.browser_http_hit" in browser_http
