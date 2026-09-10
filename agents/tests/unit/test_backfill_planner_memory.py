"""Security and lifecycle tests for the one-off planner-memory backfill cache."""

from __future__ import annotations

import importlib.util
import sys
from collections import Counter
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "backfill_planner_memory.py"


def _load_script():
    spec = importlib.util.spec_from_file_location("backfill_planner_memory_test_module", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_cache_is_owner_only(tmp_path: Path) -> None:
    module = _load_script()
    module.CACHE_PATH = tmp_path / "planner-memory-backfill.jsonl"

    module.write_cache([{"id": "one", "goal": "private history"}])

    assert module.CACHE_PATH.stat().st_mode & 0o777 == 0o600


def test_complete_full_upsert_removes_cache(monkeypatch, tmp_path: Path) -> None:
    module = _load_script()
    module.CACHE_PATH = tmp_path / "planner-memory-backfill.jsonl"
    module.write_cache([{"id": "one", "goal": "goal", "world_model_mode": "real"}])

    async def successful_upsert(rows, **kwargs):
        assert [row["id"] for row in rows] == ["one"]
        return Counter(ok=1)

    monkeypatch.setattr(module, "upsert", successful_upsert)
    monkeypatch.setenv("BACKEND_API_KEY", "test-key")
    monkeypatch.setattr(sys, "argv", [str(SCRIPT), "--backend", "https://backend.test"])

    assert module.main() == 0
    assert not module.CACHE_PATH.exists()


def test_limited_upsert_preserves_cache(monkeypatch, tmp_path: Path) -> None:
    module = _load_script()
    module.CACHE_PATH = tmp_path / "planner-memory-backfill.jsonl"
    module.write_cache([{"id": "one", "goal": "goal", "world_model_mode": "real"}])

    async def successful_upsert(rows, **kwargs):
        return Counter(ok=len(rows))

    monkeypatch.setattr(module, "upsert", successful_upsert)
    monkeypatch.setenv("BACKEND_API_KEY", "test-key")
    monkeypatch.setattr(
        sys,
        "argv",
        [str(SCRIPT), "--backend", "https://backend.test", "--limit", "1"],
    )

    assert module.main() == 0
    assert module.CACHE_PATH.exists()
