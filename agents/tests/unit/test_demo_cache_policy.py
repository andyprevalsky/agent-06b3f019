"""DEMO-tag cache policy: replay ignores the Fast Mode button."""

from __future__ import annotations

import json
from pathlib import Path

from providers.demo_cache.normalize import (
    OAI_DEMO_ROOT_GOAL_HASH,
    demo_cache_allowed,
    demo_cache_goal_hashes,
    soft_complete_allowed,
)
from utils.oai_demo import (
    OAI_DEMO_CHILD_GOAL_PREFIX,
    OAI_DEMO_CHILD_WINDOW,
    OAI_DEMO_ROOT_GOAL_PREFIX,
    OAI_DEMO_ROOT_TITLE,
    is_oai_demo_goal,
    mass_agent_root_title,
)


def test_mass_agent_0_is_tagged_demo():
    tasks_path = Path(__file__).resolve().parents[2] / "benchmarks" / "tasks.json"
    tasks = json.loads(tasks_path.read_text(encoding="utf-8"))
    mass = next(t for t in tasks if t.get("name") == "test-mass-agent-run-0")
    tags = {str(t).upper() for t in (mass.get("tags") or [])}
    assert "DEMO" in tags


def test_mass_agent_root_title_only_overrides_demo_roots():
    assert mass_agent_root_title(OAI_DEMO_ROOT_GOAL_PREFIX, True, None) == OAI_DEMO_ROOT_TITLE
    assert mass_agent_root_title(OAI_DEMO_ROOT_GOAL_PREFIX, True, "Task Output") == OAI_DEMO_ROOT_TITLE
    assert mass_agent_root_title(OAI_DEMO_ROOT_GOAL_PREFIX, False, None) is None
    assert mass_agent_root_title("Buy socks", True, "Goal Summary") == "Goal Summary"


def test_demo_cache_goal_hashes_include_mass_agent_prompt():
    hashes = demo_cache_goal_hashes()
    assert OAI_DEMO_ROOT_GOAL_HASH in hashes
    tasks_path = Path(__file__).resolve().parents[2] / "benchmarks" / "tasks.json"
    tasks = json.loads(tasks_path.read_text(encoding="utf-8"))
    mass = next(t for t in tasks if t.get("name") == "test-mass-agent-run-0")
    from providers.demo_cache.normalize import goal_hash

    assert goal_hash(mass["prompt"]) in hashes


def test_demo_cache_allowed_matches_demo_prompts_not_live():
    assert demo_cache_allowed(f"{OAI_DEMO_ROOT_GOAL_PREFIX} extra") is True
    # Bound child (prefix + Andy) is allowed; bare prefix is not.
    assert (
        demo_cache_allowed(f"{OAI_DEMO_CHILD_GOAL_PREFIX} for Andy Prevalsky — Huberman")
        is True
    )
    assert demo_cache_allowed(f"{OAI_DEMO_CHILD_GOAL_PREFIX} Huberman") is False
    assert demo_cache_allowed("Buy socks") is False
    assert demo_cache_allowed("Buy socks", root_goal=f"{OAI_DEMO_ROOT_GOAL_PREFIX} x") is True


def test_soft_complete_shares_demo_gate():
    assert soft_complete_allowed(f"{OAI_DEMO_ROOT_GOAL_PREFIX} x") is True
    assert soft_complete_allowed("Buy socks") is False


def test_is_oai_demo_goal_still_covers_prefixes():
    assert is_oai_demo_goal(OAI_DEMO_ROOT_GOAL_PREFIX)
    assert not is_oai_demo_goal(OAI_DEMO_CHILD_GOAL_PREFIX)
    assert is_oai_demo_goal(f"{OAI_DEMO_CHILD_GOAL_PREFIX} for Andy Prevalsky")
    assert is_oai_demo_goal(f"window {OAI_DEMO_CHILD_WINDOW} only")


def test_demo_cache_goal_hashes_include_fleet_concurrency_prompts():
    demo_cache_goal_hashes.cache_clear()
    hashes = demo_cache_goal_hashes()
    tasks_path = Path(__file__).resolve().parents[2] / "benchmarks" / "tasks.json"
    tasks = json.loads(tasks_path.read_text(encoding="utf-8"))
    from providers.demo_cache.normalize import goal_hash

    for name in ("demo-fleet-alpha", "demo-fleet-beta", "demo-fleet-gamma"):
        task = next(t for t in tasks if t.get("name") == name)
        assert goal_hash(task["prompt"]) in hashes
        assert demo_cache_allowed(task["prompt"]) is True
        assert soft_complete_allowed(task["prompt"]) is True


def test_is_demo_cache_task_covers_fleet_and_mass_agent():
    from types import SimpleNamespace

    from domains.spawn_agent.config import is_demo_cache_task, is_oai_demo_mass_agent_task

    tasks_path = Path(__file__).resolve().parents[2] / "benchmarks" / "tasks.json"
    tasks = json.loads(tasks_path.read_text(encoding="utf-8"))
    alpha = next(t for t in tasks if t.get("name") == "demo-fleet-alpha")
    fleet = SimpleNamespace(goal=alpha["prompt"], demo_cache_goal="")
    mass = SimpleNamespace(goal=OAI_DEMO_ROOT_GOAL_PREFIX, demo_cache_goal="")
    live = SimpleNamespace(goal="Buy socks", demo_cache_goal="")
    assert is_demo_cache_task(fleet) is True
    assert is_oai_demo_mass_agent_task(fleet) is False
    assert is_demo_cache_task(mass) is True
    assert is_oai_demo_mass_agent_task(mass) is True
    leftover = SimpleNamespace(
        goal="Produce fresh tool-grounded evidence for Andy Prevalsky's brand task.",
        demo_cache_goal="",
        root_goal=OAI_DEMO_ROOT_GOAL_PREFIX,
    )
    assert is_demo_cache_task(leftover) is True
    assert is_oai_demo_mass_agent_task(leftover) is True
    assert is_demo_cache_task(live) is False


def test_is_demo_cache_task_reads_restored_demo_cache_goal(monkeypatch):
    """continue_as_new may restore demo demo_cache_goal while input goal is live."""
    import asyncio
    import hashlib

    import pytest

    from workflows import agent_workflow

    tasks_path = Path(__file__).resolve().parents[2] / "benchmarks" / "tasks.json"
    tasks = json.loads(tasks_path.read_text(encoding="utf-8"))
    alpha = next(t for t in tasks if t.get("name") == "demo-fleet-alpha")
    resumed = agent_workflow.AgentWorkflow()

    class StartupObserved(Exception):
        pass

    def observe_startup():
        # Observe the startup gate before any durable activity can overwrite it.
        raise StartupObserved

    monkeypatch.setattr(agent_workflow.workflow, "now", observe_startup)
    with pytest.raises(StartupObserved):
        asyncio.run(
            resumed.run(
                "resumed-agent",
                "cache-user",
                "Buy socks",
                "rose-labs/rose-ultra",
                256,
                {"type": "FLOAT_LLM_JUDGE"},
                fast_mode_cache_enabled=False,
                resume_state={
                    "version": 1,
                    "kind": "continuation",
                    "runtime_state": {"fast_cache_goal": alpha["prompt"]},  # stored runtime key (wire name kept)
                },
            )
        )
    assert resumed.demo_cache_goal == alpha["prompt"]
    assert resumed.fast_mode_cache_enabled is True
    assert resumed.provider_fast_mode is False
    material = json.dumps(
        {"version": 1, "user_id": "cache-user", "goal": alpha["prompt"]},
        sort_keys=True,
        separators=(",", ":"),
    )
    assert resumed.compute_token_demo_cache_affinity_key == (
        "fast-cache-agent-provider:" + hashlib.sha256(material.encode()).hexdigest()
    )


def test_simulation_writes_demo_goals_only_to_its_scoped_namespace(monkeypatch):
    """A cold WHM simulation miss seeds its scoped keys; real DEMO recordings stay frozen."""
    from providers.demo_cache import client
    from providers.demo_cache.normalize import build_key, goal_hash

    tasks_path = Path(__file__).resolve().parents[2] / "benchmarks" / "tasks.json"
    tasks = json.loads(tasks_path.read_text(encoding="utf-8"))
    demo_goal = next(t for t in tasks if t.get("name") == "test-mass-agent-run-0")["prompt"]
    demo_hash = goal_hash(demo_goal)
    assert demo_hash in demo_cache_goal_hashes()
    monkeypatch.delenv("FAST_MODE_CACHE_RECORD_DEMO", raising=False)

    monkeypatch.setenv("BENCHMARK_WORLD_MODEL_MODE", "real")
    real_key = build_key("llm", demo_goal, "detail")
    assert client.cache_write_allowed(demo_hash, goal=demo_goal) is False

    monkeypatch.setenv("BENCHMARK_WORLD_MODEL_MODE", "simulate")
    simulated_key = build_key("llm", demo_goal, "detail")
    assert simulated_key != real_key and ":sim." in simulated_key
    assert client.cache_write_allowed(demo_hash, goal=demo_goal) is True
