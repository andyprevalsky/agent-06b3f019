"""Blackbox tests for summarize domain."""

import asyncio

from _test_utils import (
    BlackboxResult,
    teardown_mock,
)


async def test_count_tool_usage():
    """_count_tool_usage counts FINISHED tool messages correctly."""
    from helpers.summarize import _count_tool_usage

    context = [
        {"role": "USER", "text": "Find companies"},
        {"role": "TOOL", "metadata": {"toolName": "web_search", "toolStatus": "IN_PROGRESS"}},
        {"role": "TOOL", "metadata": {"toolName": "web_search", "toolStatus": "FINISHED"}},
        {"role": "TOOL", "metadata": {"toolName": "enrich", "toolStatus": "FINISHED"}},
        {"role": "TOOL", "metadata": {"toolName": "web_search", "toolStatus": "FINISHED"}},
        {"role": "TOOL", "metadata": {"toolName": "check_progress", "toolStatus": "FINISHED"}},  # excluded
        {"role": "TOOL", "metadata": {"toolName": "attempt_completion", "toolStatus": "FINISHED"}},  # excluded
        {"role": "ASSISTANT", "text": "Done"},
    ]

    counts = _count_tool_usage(context)

    assert counts["web_search"] == 2
    assert counts["enrich"] == 1
    # Excluded tools should not appear
    assert "check_progress" not in counts
    assert "attempt_completion" not in counts


async def test_count_tool_usage_empty():
    """_count_tool_usage returns empty dict for empty context."""
    from helpers.summarize import _count_tool_usage

    assert _count_tool_usage([]) == {}


async def test_merge_tool_counts():
    """_merge_tool_counts merges own and sub-agent tool counts."""
    from helpers.summarize import _merge_tool_counts

    own = {"web_search": 3, "enrich": 1}
    sub = {"web_search": 2, "deep_research": 1}

    merged = _merge_tool_counts(own, sub)

    assert merged["web_search"] == 5
    assert merged["enrich"] == 1
    assert merged["deep_research"] == 1


async def test_merge_tool_counts_empty():
    """_merge_tool_counts handles empty inputs."""
    from helpers.summarize import _merge_tool_counts

    assert _merge_tool_counts({}, {}) == {}
    assert _merge_tool_counts({"a": 1}, {}) == {"a": 1}
    assert _merge_tool_counts({}, {"b": 2}) == {"b": 2}


async def test_format_tool_stats_footer():
    """_format_tool_stats_footer formats tool counts as markdown."""
    from helpers.summarize import _format_tool_stats_footer

    counts = {"web_search": 5, "enrich": 2, "deep_research": 1}

    footer = _format_tool_stats_footer(counts)

    assert "Tool Usage Statistics" in footer
    assert "Total:** 8" in footer
    assert "Web Searches" in footer  # mapped display name
    assert "Enrichments" in footer   # mapped display name
    assert "Deep Research Runs" in footer


async def test_format_tool_stats_footer_empty():
    """_format_tool_stats_footer returns empty string for no tools."""
    from helpers.summarize import _format_tool_stats_footer

    assert _format_tool_stats_footer({}) == ""


async def test_format_tool_stats_footer_sort_order():
    """_format_tool_stats_footer sorts by count descending."""
    from helpers.summarize import _format_tool_stats_footer

    counts = {"enrich": 1, "web_search": 10, "deep_research": 5}

    footer = _format_tool_stats_footer(counts)

    # web_search (10) should appear before deep_research (5) before enrich (1)
    ws_pos = footer.index("Web Searches")
    dr_pos = footer.index("Deep Research")
    en_pos = footer.index("Enrichments")
    assert ws_pos < dr_pos < en_pos


async def run_all_tests():
    print("summarize blackbox tests:")
    r = BlackboxResult()
    await r.record_async("count_tool_usage", test_count_tool_usage)
    await r.record_async("count_tool_usage_empty", test_count_tool_usage_empty)
    await r.record_async("merge_tool_counts", test_merge_tool_counts)
    await r.record_async("merge_tool_counts_empty", test_merge_tool_counts_empty)
    await r.record_async("format_tool_stats_footer", test_format_tool_stats_footer)
    await r.record_async("format_tool_stats_footer_empty", test_format_tool_stats_footer_empty)
    await r.record_async("format_tool_stats_footer_sort_order", test_format_tool_stats_footer_sort_order)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
