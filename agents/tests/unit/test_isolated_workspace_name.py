"""Cement: parallel isolated local benches must not share a Temporal queue."""

from __future__ import annotations

import sys
from pathlib import Path

AGENTS_DIR = Path(__file__).resolve().parents[2]
if str(AGENTS_DIR) not in sys.path:
    sys.path.insert(0, str(AGENTS_DIR))

from benchmarks.local import isolated_workspace_name


def test_isolated_workspace_name_keeps_distinct_run_id_suffix() -> None:
    base = "descend-deploy-I-05-I-06-7107c0c3e879"
    first = isolated_workspace_name(base, "1786272075-2172637-73096")
    second = isolated_workspace_name(base, "1786272075-2172688-57266")
    assert first != second
    assert "2172637-73096" in first
    assert "2172688-57266" in second
    assert len(first) <= 60
    assert len(second) <= 60


def test_prefix_truncation_collision_is_the_bug_we_fixed() -> None:
    base = "descend-deploy-I-05-I-06-7107c0c3e879"
    naive_a = f"{base}-bench-1786272075-2172637-73096"[:60]
    naive_b = f"{base}-bench-1786272075-2172688-57266"[:60]
    assert naive_a == naive_b
