#!/usr/bin/env python3
"""Inject hand-picked semantic mappings into prompt-review/catalog.json.

For each OUR prompt, the table below names the closest equivalent in each
reference repo, or `None` when there's no semantic equivalent (e.g. our
verifier system prompt has no Claude analogue — Claude doesn't grade).

The build script reads `matches` and uses it directly. Only when `matches`
is absent for a repo does it fall back to keyword scoring.

Re-runnable. Idempotent. Edit MAPPINGS to refine the pairings.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
CATALOG = ROOT / "prompt-review" / "catalog.json"

# `None` = explicit "no equivalent in this reference repo" (UI shows
# "no candidate"). A string = the matched ID in that repo.
MAPPINGS: dict[str, dict[str, str | None]] = {
    # --- canonical instruction blocks (our shared rules) ----------------------
    "VERIFICATION_RULES": {
        "claude": None,        # Claude has no separate grader/verifier
        "openclaw": None,
        "hermes": None,
    },
    "SELF_CONTAINED_GOAL_RULE": {
        "claude": "claude_tool_agent",   # spawn-context guidance
        "openclaw": None,
        "hermes": "hermes_kanban_guidance",
    },
    "EPHEMERAL_SESSION_RULE": {
        "claude": None,
        "openclaw": None,
        "hermes": None,
    },
    "CONTEXT_POINTERS_RULE": {
        "claude": "claude_compact",      # context-trimming strategy
        "openclaw": None,
        "hermes": "hermes_memory_guidance",
    },
    "FILE_HANDLING_RULE": {
        "claude": "claude_tool_write",
        "openclaw": None,
        "hermes": None,
    },
    "CRITICAL_CONSTRAINTS_RULE": {
        "claude": None,
        "openclaw": None,
        "hermes": "hermes_tool_use_enforcement",
    },

    # --- core system prompts ---------------------------------------------------
    "build_system_prompt": {
        "claude": "claude_getSystemPrompt",
        "openclaw": "openclaw_buildAgentSystemPrompt",
        "hermes": "hermes_default_agent_identity",
    },
    "_VERIFIER_STATIC_PROMPT": {
        "claude": None,        # no separate verifier in Claude
        "openclaw": None,
        "hermes": None,
    },
    "build_verifier_prompt": {
        "claude": None,
        "openclaw": None,
        "hermes": None,
    },
    "build_planner_system_prompt": {
        "claude": "claude_tool_enter_plan_mode",  # closest analogue (planning)
        "openclaw": None,
        "hermes": None,
    },
    "EXPLORE_AGENT_SYSTEM_PROMPT": {
        "claude": "claude_builtin_explore_agent",
        "openclaw": "openclaw_subagent_system_prompt",
        "hermes": "hermes_explore_reference",
    },

    # --- main tool descriptions -----------------------------------------------
    "tool_attempt_completion": {
        "claude": "claude_tool_exit_plan_mode",   # signals task end (closest)
        "openclaw": None,
        "hermes": None,
    },
    "tool_call_phone_number": {
        "claude": None,
        "openclaw": None,
        "hermes": None,
    },
    "tool_grep": {
        "claude": "claude_tool_grep",
        "openclaw": None,
        "hermes": "hermes_search_files_tool",
    },
    "tool_message_person": {
        "claude": "claude_tool_brief",
        "openclaw": "openclaw_message_tool",
        "hermes": "hermes_send_message_tool",
    },
    "tool_reasoning": {
        "claude": None,
        "openclaw": None,
        "hermes": None,
    },
    "tool_send_message_to_user": {
        "claude": "claude_tool_brief",
        "openclaw": "openclaw_message_tool",
        "hermes": "hermes_send_message_tool",
    },
    "tool_send_message_to_user_execute": {
        "claude": "claude_tool_brief",
        "openclaw": "openclaw_message_tool",
        "hermes": "hermes_send_message_tool",
    },
    "tool_set_plan": {
        "claude": "claude_tool_enter_plan_mode",
        "openclaw": "openclaw_update_plan",
        "hermes": None,
    },

    # --- spawn family (all map to Claude's Agent + Hermes's delegate) --------
    "tool_spawn_agent":               {"claude": "claude_tool_agent", "openclaw": "openclaw_sessions_spawn", "hermes": "hermes_delegate_tool"},
    "tool_spawn_browser_agent":       {"claude": "claude_tool_agent", "openclaw": "openclaw_sessions_spawn", "hermes": "hermes_delegate_tool"},
    "tool_spawn_code_agent":          {"claude": "claude_tool_agent", "openclaw": "openclaw_sessions_spawn", "hermes": "hermes_delegate_tool"},
    "tool_spawn_explore_agent":       {"claude": "claude_tool_agent", "openclaw": "openclaw_sessions_spawn", "hermes": "hermes_delegate_tool"},
    "tool_spawn_sub_agent":           {"claude": "claude_tool_agent", "openclaw": "openclaw_sessions_spawn", "hermes": "hermes_delegate_tool"},
    "tool_spawn_sub_agent_for_each":  {"claude": "claude_tool_agent", "openclaw": "openclaw_sessions_spawn", "hermes": "hermes_delegate_tool"},

    "tool_wait_for": {
        "claude": "claude_tool_sleep",
        "openclaw": None,
        "hermes": None,
    },
    "tool_web_fetch": {
        "claude": "claude_tool_web_fetch",
        "openclaw": "openclaw_web_fetch",
        "hermes": "hermes_web_extract_tool",
    },
    "tool_web_search": {
        "claude": "claude_tool_web_search",
        "openclaw": "openclaw_web_search",
        "hermes": "hermes_web_search_tool",
    },

    # --- browser tooling ---
    "browser_get_system_prompt":          {"claude": None, "openclaw": None, "hermes": None},
    "browser_tool_observe":                {"claude": None, "openclaw": "openclaw_browser_action_snapshot", "hermes": "hermes_browser_snapshot"},
    "browser_tool_extract":                {"claude": None, "openclaw": None, "hermes": None},
    "browser_tool_click":                  {"claude": None, "openclaw": "openclaw_browser_action_act_click", "hermes": "hermes_browser_click"},
    "browser_tool_fill":                   {"claude": None, "openclaw": "openclaw_browser_action_act_fill", "hermes": "hermes_browser_type"},
    "browser_tool_type":                   {"claude": None, "openclaw": "openclaw_browser_action_act_type", "hermes": "hermes_browser_type"},
    "browser_tool_press_key":              {"claude": None, "openclaw": "openclaw_browser_action_act_press", "hermes": "hermes_browser_press"},
    "browser_tool_goto":                   {"claude": None, "openclaw": "openclaw_browser_action_navigate", "hermes": "hermes_browser_navigate"},
    "browser_tool_scroll":                 {"claude": None, "openclaw": None, "hermes": "hermes_browser_scroll"},
    "browser_tool_wait":                   {"claude": "claude_tool_sleep", "openclaw": "openclaw_browser_action_act_wait", "hermes": None},
    "browser_tool_attempt_completion":     {"claude": "claude_tool_exit_plan_mode", "openclaw": None, "hermes": None},
    "browser_tool_screenshot":             {"claude": None, "openclaw": "openclaw_browser_action_screenshot", "hermes": "hermes_browser_vision"},
    "browser_tool_aria_tree":              {"claude": None, "openclaw": "openclaw_browser_action_snapshot_aria", "hermes": "hermes_browser_snapshot"},
    "browser_tool_navback":                {"claude": None, "openclaw": None, "hermes": "hermes_browser_back"},
    "browser_tool_click_at_coordinates":   {"claude": None, "openclaw": "openclaw_browser_action_act_clickCoords", "hermes": None},

    # --- domain-specific system prompts ---------------------------------------
    "REASONING_SYSTEM_PROMPT_TEMPLATE": {
        "claude": None,
        "openclaw": None,
        "hermes": None,
    },
    "build_browser_use_system_prompt": {
        "claude": None,
        "openclaw": None,
        "hermes": None,
    },
    "param_populator_build_agent_system_prompt": {
        "claude": "claude_tool_agent",   # they overlap on agent-spawning context
        "openclaw": None,
        "hermes": None,
    },
    "SPAWN_PARAM_REQUIREMENTS": {
        "claude": None,
        "openclaw": None,
        "hermes": None,
    },
    "BLUEPRINT_COMPRESSION_PROMPT": {
        "claude": "claude_compact",
        "openclaw": None,
        "hermes": "hermes_memory_guidance",
    },
    "GEPA_V3_PLANNING_INSTRUCTION": {
        "claude": None,
        "openclaw": None,
        "hermes": None,
    },
    "PLANNER_V3_STRATEGY_OVERRIDE": {
        "claude": "claude_tool_enter_plan_mode",
        "openclaw": None,
        "hermes": None,
    },

    # --- back-end TS prompts --------------------------------------------------
    "schema_gen_system_prompt": {
        "claude": None,                  # Claude doesn't generate response schemas
        "openclaw": None,
        "hermes": None,
    },
    "router_system_prompt": {
        "claude": None,                  # Claude is a single-LLM agent (no router)
        "openclaw": None,
        "hermes": None,
    },
    "generator_system_prompt": {
        "claude": "claude_getSystemPrompt",
        "openclaw": "openclaw_buildAgentSystemPrompt",
        "hermes": "hermes_default_agent_identity",
    },
    "vapi_base_system_prompt": {
        "claude": None,
        "openclaw": None,
        "hermes": None,
    },
    "sms_supervisor_system_prompt": {
        "claude": "claude_getSystemPrompt",
        "openclaw": "openclaw_buildAgentSystemPrompt",
        "hermes": "hermes_default_agent_identity",
    },
    "llm_judge_prompt_generator_system": {
        "claude": None,
        "openclaw": None,
        "hermes": None,
    },
}


def main() -> int:
    cat = json.loads(CATALOG.read_text())
    approved_mappings: dict[str, dict[str, str | None]] = {
        "build_system_prompt": {
            "claude": "claude_getSystemPrompt",
            "openclaw": "openclaw_buildAgentSystemPrompt",
            "hermes": "hermes_default_agent_identity",
        },
        "_VERIFIER_STATIC_PROMPT": {"claude": None, "openclaw": None, "hermes": None},
        "build_planner_system_prompt": {"claude": None, "openclaw": None, "hermes": None},
        "EXPLORE_AGENT_SYSTEM_PROMPT": {
            "claude": "claude_builtin_explore_agent",
            "openclaw": "openclaw_subagent_system_prompt",
            "hermes": "hermes_explore_reference",
        },
        "browser_get_system_prompt": {"claude": None, "openclaw": None, "hermes": None},
        "REASONING_SYSTEM_PROMPT_TEMPLATE": {"claude": None, "openclaw": None, "hermes": None},
        "build_browser_use_system_prompt": {"claude": None, "openclaw": None, "hermes": None},
        "param_populator_build_agent_system_prompt": {"claude": None, "openclaw": None, "hermes": None},
        "BLUEPRINT_COMPRESSION_PROMPT": {"claude": None, "openclaw": None, "hermes": None},
        "schema_gen_system_prompt": {"claude": None, "openclaw": None, "hermes": None},
        "router_system_prompt": {"claude": None, "openclaw": None, "hermes": None},
        "generator_system_prompt": {"claude": None, "openclaw": None, "hermes": None},
        "vapi_base_system_prompt": {"claude": None, "openclaw": None, "hermes": None},
        "sms_supervisor_system_prompt": {"claude": None, "openclaw": None, "hermes": None},
        "llm_judge_prompt_generator_system": {"claude": None, "openclaw": None, "hermes": None},
        "tool_attempt_completion": {"claude": "claude_tool_exit_plan_mode", "openclaw": None, "hermes": None},
        "tool_call_phone_number": {"claude": None, "openclaw": None, "hermes": None},
        "tool_grep": {"claude": "claude_tool_grep", "openclaw": None, "hermes": "hermes_search_files_tool"},
        "tool_message_person": {"claude": "claude_tool_brief", "openclaw": "openclaw_message_tool", "hermes": "hermes_send_message_tool"},
        "tool_reasoning": {"claude": None, "openclaw": None, "hermes": None},
        "tool_send_message_to_user": {"claude": "claude_tool_brief", "openclaw": "openclaw_message_tool", "hermes": "hermes_send_message_tool"},
        "tool_send_message_to_user_execute": {"claude": "claude_tool_brief", "openclaw": "openclaw_message_tool", "hermes": "hermes_send_message_tool"},
        "tool_set_plan": {"claude": "claude_tool_enter_plan_mode", "openclaw": "openclaw_update_plan", "hermes": None},
        "tool_spawn_agent": {"claude": "claude_tool_agent", "openclaw": "openclaw_sessions_spawn", "hermes": "hermes_delegate_tool"},
        "tool_spawn_browser_agent": {"claude": "claude_tool_agent", "openclaw": "openclaw_sessions_spawn", "hermes": "hermes_delegate_tool"},
        "tool_spawn_code_agent": {"claude": "claude_tool_agent", "openclaw": "openclaw_sessions_spawn", "hermes": "hermes_delegate_tool"},
        "tool_spawn_explore_agent": {"claude": "claude_tool_agent", "openclaw": "openclaw_sessions_spawn", "hermes": "hermes_delegate_tool"},
        "tool_spawn_sub_agent": {"claude": "claude_tool_agent", "openclaw": "openclaw_sessions_spawn", "hermes": "hermes_delegate_tool"},
        "tool_spawn_sub_agent_for_each": {"claude": "claude_tool_agent", "openclaw": "openclaw_sessions_spawn", "hermes": "hermes_delegate_tool"},
        "tool_wait_for": {"claude": "claude_tool_sleep", "openclaw": None, "hermes": None},
        "tool_web_fetch": {"claude": "claude_tool_web_fetch", "openclaw": "openclaw_web_fetch", "hermes": "hermes_web_extract_tool"},
        "tool_web_search": {"claude": "claude_tool_web_search", "openclaw": "openclaw_web_search", "hermes": "hermes_web_search_tool"},
        "browser_tool_observe": {"claude": None, "openclaw": "openclaw_browser_action_snapshot", "hermes": "hermes_browser_snapshot"},
        "browser_tool_extract": {"claude": None, "openclaw": None, "hermes": None},
        "browser_tool_click": {"claude": None, "openclaw": "openclaw_browser_action_act_click", "hermes": "hermes_browser_click"},
        "browser_tool_fill": {"claude": None, "openclaw": "openclaw_browser_action_act_fill", "hermes": "hermes_browser_type"},
        "browser_tool_type": {"claude": None, "openclaw": "openclaw_browser_action_act_type", "hermes": "hermes_browser_type"},
        "browser_tool_press_key": {"claude": None, "openclaw": "openclaw_browser_action_act_press", "hermes": "hermes_browser_press"},
        "browser_tool_goto": {"claude": None, "openclaw": "openclaw_browser_action_navigate", "hermes": "hermes_browser_navigate"},
        "browser_tool_scroll": {"claude": None, "openclaw": None, "hermes": "hermes_browser_scroll"},
        "browser_tool_wait": {"claude": "claude_tool_sleep", "openclaw": "openclaw_browser_action_act_wait", "hermes": None},
        "browser_tool_attempt_completion": {"claude": "claude_tool_exit_plan_mode", "openclaw": None, "hermes": None},
        "browser_tool_screenshot": {"claude": None, "openclaw": "openclaw_browser_action_screenshot", "hermes": "hermes_browser_vision"},
        "browser_tool_aria_tree": {"claude": None, "openclaw": "openclaw_browser_action_snapshot_aria", "hermes": "hermes_browser_snapshot"},
        "browser_tool_navback": {"claude": None, "openclaw": None, "hermes": "hermes_browser_back"},
        "browser_tool_click_at_coordinates": {"claude": None, "openclaw": "openclaw_browser_action_act_clickCoords", "hermes": None},
    }
    updated = 0
    for entry in cat["ours"]:
        m = approved_mappings.get(entry["id"])
        if m is None:
            entry.pop("matches", None)
            continue
        # Stash on entry. Use a stable JSON-friendly form: dict with explicit
        # nulls preserved.
        entry["matches"] = {
            "claude": m.get("claude"),
            "openclaw": m.get("openclaw"),
            "hermes": m.get("hermes"),
        }
        updated += 1

    CATALOG.write_text(json.dumps(cat, indent=2) + "\n")
    print(f"[mappings] applied explicit matches to {updated}/{len(cat['ours'])} ours entries")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
