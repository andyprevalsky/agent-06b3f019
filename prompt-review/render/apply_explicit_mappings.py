#!/usr/bin/env python3
"""Inject hand-picked semantic mappings into prompt-review/catalog.json.

For each OUR prompt, the table in `main()` (`approved_mappings`) names the
closest equivalent in each reference repo, or `None` when there's no semantic
equivalent (e.g. our verifier system prompt has no Claude analogue — Claude
doesn't grade).

The build script reads `matches` and uses it directly. Only when `matches`
is absent for a repo does it fall back to keyword scoring.

Re-runnable. Idempotent. Edit `approved_mappings` inside `main()` to refine
the pairings.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
CATALOG = ROOT / "prompt-review" / "catalog.json"


def main() -> int:
    cat = json.loads(CATALOG.read_text(encoding="utf-8"))
    # `None` = explicit "no equivalent in this reference repo" (UI shows
    # "no candidate"). A string = the matched ID in that repo.
    approved_mappings: dict[str, dict[str, str | None]] = {
        "USER_FACING_WRITING_STYLE": {
            "claude": None,
            "openclaw": None,
            "hermes": None,
        },
        "USER_FACING_WRITING_STYLE_TS": {
            "claude": None,
            "openclaw": None,
            "hermes": None,
        },
        "build_system_prompt": {
            "claude": "claude_getSystemPrompt",
            "openclaw": "openclaw_buildAgentSystemPrompt",
            "hermes": "hermes_default_agent_identity",
            "codex": "codex_base_instructions",
            "prime": "prime_core_harness",
            "kimi": "kimi_system_prompt",
        },
        "_VERIFIER_STATIC_PROMPT": {"claude": None, "openclaw": None, "hermes": None},
        "build_planner_system_prompt": {"claude": None, "openclaw": None, "hermes": None},
        "EXPLORE_AGENT_SYSTEM_PROMPT": {
            "claude": "claude_builtin_explore_agent",
            "openclaw": "openclaw_subagent_system_prompt",
            "hermes": "hermes_explore_reference",
            "codex": "codex_multi_agent_subagent",
            "kimi": "kimi_explore_overlay",
        },
        "browser_get_system_prompt": {"claude": None, "openclaw": None, "hermes": None},
        "REASONING_SYSTEM_PROMPT_TEMPLATE": {"claude": None, "openclaw": None, "hermes": None},
        "build_browser_use_system_prompt": {"claude": None, "openclaw": None, "hermes": None},
        "param_populator_build_agent_system_prompt": {"claude": None, "openclaw": None, "hermes": None},
        "BLUEPRINT_COMPRESSION_PROMPT": {"claude": None, "openclaw": None, "hermes": None, "codex": "codex_compact_prompt", "prime": "prime_compaction_prompt", "kimi": "kimi_compaction_instruction"},
        "context_compression_prompt": {"claude": None, "openclaw": None, "hermes": None, "codex": "codex_compact_prompt", "prime": "prime_compaction_prompt", "kimi": "kimi_compaction_instruction"},
        "schema_gen_system_prompt": {"claude": None, "openclaw": None, "hermes": None},
        "router_system_prompt": {"claude": None, "openclaw": None, "hermes": None},
        "generator_system_prompt": {"claude": None, "openclaw": None, "hermes": None},
        "vapi_base_system_prompt": {"claude": None, "openclaw": None, "hermes": None},
        "sms_supervisor_system_prompt": {"claude": None, "openclaw": None, "hermes": None},
        "llm_judge_prompt_generator_system": {"claude": None, "openclaw": None, "hermes": None},
        "tool_attempt_completion": {"claude": "claude_tool_exit_plan_mode", "openclaw": None, "hermes": None, "prime": "prime_skill_goal", "kimi": "kimi_tool_update_goal"},
        "tool_call_phone_number": {"claude": None, "openclaw": None, "hermes": None},
        "tool_grep": {"claude": "claude_tool_grep", "openclaw": None, "hermes": "hermes_search_files_tool", "kimi": "kimi_tool_grep"},
        "tool_message_person": {"claude": "claude_tool_brief", "openclaw": "openclaw_message_tool", "hermes": "hermes_send_message_tool"},
        "tool_reasoning": {"claude": None, "openclaw": None, "hermes": None},
        "tool_send_message_to_user": {"claude": "claude_tool_brief", "openclaw": "openclaw_message_tool", "hermes": "hermes_send_message_tool", "kimi": "kimi_tool_notify_user"},
        "tool_send_message_to_user_execute": {"claude": "claude_tool_brief", "openclaw": "openclaw_message_tool", "hermes": "hermes_send_message_tool", "kimi": "kimi_tool_notify_user"},
        "tool_set_plan": {"claude": "claude_tool_enter_plan_mode", "openclaw": "openclaw_update_plan", "hermes": None, "prime": "prime_skill_factory", "kimi": "kimi_tool_todo_list"},
        "tool_spawn_agent": {"claude": "claude_tool_agent", "openclaw": "openclaw_sessions_spawn", "hermes": "hermes_delegate_tool", "codex": "codex_orchestrator", "prime": "prime_subagents", "kimi": "kimi_tool_agent"},
        "tool_spawn_browser_agent": {"claude": "claude_tool_agent", "openclaw": "openclaw_sessions_spawn", "hermes": "hermes_delegate_tool", "codex": "codex_orchestrator", "prime": "prime_subagents", "kimi": "kimi_tool_agent"},
        "tool_spawn_code_agent": {"claude": "claude_tool_agent", "openclaw": "openclaw_sessions_spawn", "hermes": "hermes_delegate_tool", "codex": "codex_orchestrator", "prime": "prime_subagents", "kimi": "kimi_tool_agent"},
        "tool_spawn_explore_agent": {"claude": "claude_tool_agent", "openclaw": "openclaw_sessions_spawn", "hermes": "hermes_delegate_tool", "codex": "codex_orchestrator", "prime": "prime_subagents", "kimi": "kimi_tool_agent"},
        "tool_spawn_sub_agent": {"claude": "claude_tool_agent", "openclaw": "openclaw_sessions_spawn", "hermes": "hermes_delegate_tool", "codex": "codex_orchestrator", "prime": "prime_subagents", "kimi": "kimi_tool_agent"},
        "tool_spawn_sub_agent_for_each": {"claude": "claude_tool_agent", "openclaw": "openclaw_sessions_spawn", "hermes": "hermes_delegate_tool", "codex": "codex_orchestrator", "prime": "prime_skill_factory", "kimi": "kimi_tool_agent_swarm"},
        "tool_wait_for": {"claude": "claude_tool_sleep", "openclaw": None, "hermes": None, "prime": "prime_skill_rlm_heartbeat", "kimi": "kimi_tool_task_wait"},
        "tool_web_fetch": {"claude": "claude_tool_web_fetch", "openclaw": "openclaw_web_fetch", "hermes": "hermes_web_extract_tool", "kimi": "kimi_tool_fetch_url"},
        "tool_web_search": {"claude": "claude_tool_web_search", "openclaw": "openclaw_web_search", "hermes": "hermes_web_search_tool", "prime": "prime_skill_websearch", "kimi": "kimi_tool_web_search"},
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
            "codex": m.get("codex"),
            "prime": m.get("prime"),
            "kimi": m.get("kimi"),
        }
        updated += 1

    CATALOG.write_text(json.dumps(cat, indent=2) + "\n", encoding="utf-8")
    print(f"[mappings] applied explicit matches to {updated}/{len(cat['ours'])} ours entries")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
