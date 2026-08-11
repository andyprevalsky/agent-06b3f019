#!/usr/bin/env python3
"""Regression: isolated local stacks must not collide Temporal queues."""

from __future__ import annotations

from benchmarks.local import isolated_workspace_name


def test_isolated_workspace_name_keeps_run_id_suffix_under_cap() -> None:
    base = "descend-deploy-I-05-I-06-7107c0c3e879"
    first = isolated_workspace_name(base, "1786272075-2172637-73096")
    second = isolated_workspace_name(base, "1786272075-2172688-57266")
    assert first != second, (first, second)
    assert first.endswith("2172637-73096")
    assert second.endswith("2172688-57266")
    assert len(first) <= 60
    assert len(second) <= 60


def test_naive_prefix_truncation_would_have_collided() -> None:
    """Document the failure mode this helper replaces."""
    base = "descend-deploy-I-05-I-06-7107c0c3e879"
    a = f"{base}-bench-1786272075-2172637-73096"[:60]
    b = f"{base}-bench-1786272075-2172688-57266"[:60]
    assert a == b


if __name__ == "__main__":
    test_isolated_workspace_name_keeps_run_id_suffix_under_cap()
    test_naive_prefix_truncation_would_have_collided()
    print("local_workspace_name_test: ok")
