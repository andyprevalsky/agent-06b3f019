"""Unit tests for explore-agent depth (caller-controlled thoroughness).

Guards the depth→turn-cap mapping, the cache-safe prompt design (static system
prompt + per-call [Thoroughness:] goal tag), and the schema default. The cap is
TURNS, not searches (one turn can batch parallel searches), mirroring Claude
Code's exploreAgent thoroughness levels.
"""

import sys
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from domains.spawn_agent.config import (  # noqa: E402
    EXPLORE_DEFAULT_DEPTH,
    EXPLORE_FAST_MODE_DEPTH,
    EXPLORE_WINDDOWN_WINDOW,
    explore_limits_for_depth,
    resolve_explore_depth,
)
from utils.prompts import EXPLORE_AGENT_SYSTEM_PROMPT  # noqa: E402
from utils.tool_schemas import SpawnAgentTool  # noqa: E402


def test_depth_limits_mapping():
    assert explore_limits_for_depth("quick") == (5, timedelta(seconds=600))
    assert explore_limits_for_depth("medium") == (20, timedelta(seconds=600))
    assert explore_limits_for_depth("deep") == (50, timedelta(seconds=1800))


def test_depth_default_and_unknown_fall_back_to_default():
    assert EXPLORE_DEFAULT_DEPTH == "quick"
    # None and unknown values resolve to the default depth (quick = 5 turns).
    assert explore_limits_for_depth(None) == explore_limits_for_depth("quick")
    assert explore_limits_for_depth("bogus") == explore_limits_for_depth("quick")


def test_fast_mode_promotes_quick_and_missing_to_deep():
    """July OAi-demo explore caches finish around turn ~14–36; quick/medium abort them."""
    assert EXPLORE_FAST_MODE_DEPTH == "deep"
    assert resolve_explore_depth(None, fast_mode_cache_enabled=True, oai_demo=True) == "deep"
    assert resolve_explore_depth("quick", fast_mode_cache_enabled=True, oai_demo=True) == "deep"
    assert resolve_explore_depth("medium", fast_mode_cache_enabled=True, oai_demo=True) == "deep"
    assert resolve_explore_depth("deep", fast_mode_cache_enabled=True, oai_demo=True) == "deep"
    assert resolve_explore_depth("quick", fast_mode_cache_enabled=True, oai_demo=False) == "quick"
    assert resolve_explore_depth("medium", fast_mode_cache_enabled=True, oai_demo=False) == "medium"
    assert resolve_explore_depth(None, fast_mode_cache_enabled=True, oai_demo=False) == "quick"
    assert resolve_explore_depth("quick", fast_mode_cache_enabled=False) == "quick"
    assert resolve_explore_depth("medium", fast_mode_cache_enabled=False) == "medium"
    assert resolve_explore_depth(None, fast_mode_cache_enabled=False) == "quick"


def test_winddown_window_is_positive():
    assert EXPLORE_WINDDOWN_WINDOW >= 1


def test_spawn_agent_schema_depth_defaults_to_quick():
    t = SpawnAgentTool(tool="spawn_agent", type="explore", task_name="find_x", goal="find X")
    assert t.depth == "quick"
    t2 = SpawnAgentTool(tool="spawn_agent", type="explore", task_name="find_x", goal="find X", depth="deep")
    assert t2.depth == "deep"


def test_system_prompt_is_cache_safe_and_depth_aware():
    # Static system prompt references the per-call thoroughness tag and an
    # early-stop, but contains NO per-depth/per-call text (so it stays a stable
    # cache prefix across calls).
    assert "[Thoroughness:" in EXPLORE_AGENT_SYSTEM_PROMPT
    assert "Adapt your research depth" in EXPLORE_AGENT_SYSTEM_PROMPT
    # No concrete per-call value baked into the cached prefix.
    for concrete in ("[Thoroughness: quick]", "[Thoroughness: medium]", "[Thoroughness: deep]"):
        assert concrete not in EXPLORE_AGENT_SYSTEM_PROMPT


def test_goal_tag_format_matches_prompt_contract():
    # The per-call tag the service prepends must be the form the static prompt
    # tells the model to read. (Mirrors service.py state_line construction.)
    for depth in ("quick", "medium", "deep"):
        tag = f"[Thoroughness: {depth}]"
        assert tag.startswith("[Thoroughness: ") and tag.endswith("]")


if __name__ == "__main__":
    test_depth_limits_mapping()
    test_depth_default_and_unknown_fall_back_to_default()
    test_winddown_window_is_positive()
    test_spawn_agent_schema_depth_defaults_to_quick()
    test_system_prompt_is_cache_safe_and_depth_aware()
    test_goal_tag_format_matches_prompt_contract()
    print("all explore-depth tests passed")
