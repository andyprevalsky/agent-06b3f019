"""DEMO cache naming (2026-10-23 rename from "fast cache").

Legacy env names and the legacy ``fast_cache`` catalog field must keep working
so prod/Fly/bench environments and older catalogs need no edits.
"""

from __future__ import annotations

import json

import pytest

from benchmarks.benchmark_tasks import normalize_legacy_catalog_fields
from benchmarks.long_horizon import DEFAULT_CATALOG
from providers.demo_cache import context as demo_cache_context
from providers.demo_cache.env import DEMO_CACHE_ENV_ALIASES, demo_cache_env, pop_demo_cache_env


def test_legacy_env_name_still_read():
    assert demo_cache_env("DEMO_CACHE_DATABASE_URL", environ={"FAST_MODE_CACHE_DATABASE_URL": "legacy"}) == "legacy"
    assert demo_cache_env("DEMO_CACHE_DB_POOL", environ={"FAST_CACHE_DB_POOL": "4"}) == "4"


def test_demo_cache_env_name_read():
    assert demo_cache_env("DEMO_CACHE_DATABASE_URL", environ={"DEMO_CACHE_DATABASE_URL": "demo"}) == "demo"


def test_legacy_wins_while_present_even_empty():
    env = {"DEMO_CACHE_DATABASE_URL": "demo", "FAST_MODE_CACHE_DATABASE_URL": ""}
    assert demo_cache_env("DEMO_CACHE_DATABASE_URL", environ=env) == ""


def test_pop_clears_both_spellings():
    env = {"DEMO_CACHE_USE_LOCAL": "1", "FAST_MODE_CACHE_USE_LOCAL": "1", "OTHER": "x"}
    pop_demo_cache_env(env, "DEMO_CACHE_USE_LOCAL")
    assert env == {"OTHER": "x"}


def test_aliases_are_demo_to_legacy():
    for name, legacy in DEMO_CACHE_ENV_ALIASES.items():
        assert name.startswith("DEMO_CACHE_")
        assert legacy.startswith(("FAST_MODE_CACHE_", "FAST_CACHE_"))


@pytest.mark.parametrize("name", ["FAST_MODE_CACHE_DISABLE_WRITE_THROUGH", "DEMO_CACHE_DISABLE_WRITE_THROUGH"])
def test_read_only_flag_accepts_both_spellings(monkeypatch, name):
    monkeypatch.delenv("FAST_MODE_CACHE_DISABLE_WRITE_THROUGH", raising=False)
    monkeypatch.delenv("DEMO_CACHE_DISABLE_WRITE_THROUGH", raising=False)
    monkeypatch.setenv(name, "1")
    assert demo_cache_context.cache_writes_disabled() is True


def test_legacy_fast_cache_catalog_field_maps_to_demo_cache():
    assert normalize_legacy_catalog_fields({"name": "t", "fast_cache": "on"}) == {"name": "t", "demo_cache": "on"}
    assert normalize_legacy_catalog_fields({"name": "t", "demo_cache": "off"}) == {"name": "t", "demo_cache": "off"}
    assert normalize_legacy_catalog_fields({"name": "t", "demo_cache": "on", "fast_cache": "on"}) == {
        "name": "t",
        "demo_cache": "on",
    }
    with pytest.raises(ValueError):
        normalize_legacy_catalog_fields({"name": "t", "demo_cache": "on", "fast_cache": "off"})


def test_catalog_uses_demo_cache_field_only():
    raw = json.loads(DEFAULT_CATALOG.read_text())
    assert not [task["name"] for task in raw if "fast_cache" in task]
    assert sum(1 for task in raw if task.get("demo_cache") == "on") > 0
