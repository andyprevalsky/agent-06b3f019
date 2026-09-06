"""DEMO-tag cache policy: replay ignores the Fast Mode button."""

from __future__ import annotations

import json
from pathlib import Path

from domains.spawn_agent.config import (
    OAI_DEMO_CHILD_GOAL_PREFIX,
    OAI_DEMO_ROOT_GOAL_PREFIX,
    is_oai_demo_goal,
)
from providers.fast_cache.normalize import (
    OAI_DEMO_ROOT_GOAL_HASH,
    demo_cache_allowed,
    demo_cache_goal_hashes,
    soft_complete_allowed,
)


def test_mass_agent_0_is_tagged_demo():
    tasks_path = Path(__file__).resolve().parents[2] / "benchmarks" / "tasks.json"
    tasks = json.loads(tasks_path.read_text(encoding="utf-8"))
    mass = next(t for t in tasks if t.get("name") == "test-mass-agent-run-0")
    tags = {str(t).upper() for t in (mass.get("tags") or [])}
    assert "DEMO" in tags


def test_demo_cache_goal_hashes_include_mass_agent_prompt():
    hashes = demo_cache_goal_hashes()
    assert OAI_DEMO_ROOT_GOAL_HASH in hashes
    tasks_path = Path(__file__).resolve().parents[2] / "benchmarks" / "tasks.json"
    tasks = json.loads(tasks_path.read_text(encoding="utf-8"))
    mass = next(t for t in tasks if t.get("name") == "test-mass-agent-run-0")
    from providers.fast_cache.normalize import goal_hash

    assert goal_hash(mass["prompt"]) in hashes


def test_demo_cache_allowed_matches_demo_prompts_not_live():
    assert demo_cache_allowed(f"{OAI_DEMO_ROOT_GOAL_PREFIX} extra") is True
    assert demo_cache_allowed(f"{OAI_DEMO_CHILD_GOAL_PREFIX} Huberman") is True
    assert demo_cache_allowed("Buy socks") is False
    assert demo_cache_allowed("Buy socks", root_goal=f"{OAI_DEMO_ROOT_GOAL_PREFIX} x") is True


def test_soft_complete_shares_demo_gate():
    assert soft_complete_allowed(f"{OAI_DEMO_ROOT_GOAL_PREFIX} x") is True
    assert soft_complete_allowed("Buy socks") is False


def test_is_oai_demo_goal_still_covers_prefixes():
    assert is_oai_demo_goal(OAI_DEMO_ROOT_GOAL_PREFIX)
    assert is_oai_demo_goal(OAI_DEMO_CHILD_GOAL_PREFIX)
