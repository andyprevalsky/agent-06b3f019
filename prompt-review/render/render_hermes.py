#!/usr/bin/env python3
"""Render every Hermes-agent prompt entry to a runtime text file.

Strategy: import each module live (so f-string interpolations and join helpers
resolve properly), then dump constants. For schema dicts (`*_SCHEMA`) we
json-pretty-print the dict so it matches what the LLM sees when the schema is
serialized for the model.

Output: prompt-review/rendered/hermes-agent/<id>.txt
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path("/Users/andyprevalsky/conductor/workspaces/navi-whisper-lux-v2/istanbul")
HERMES_ROOT = REPO_ROOT / "hermes-agent"
OUTPUT_DIR = REPO_ROOT / "prompt-review" / "rendered" / "hermes-agent"

# Add hermes-agent to sys.path so its absolute imports work
sys.path.insert(0, str(HERMES_ROOT))


def write_output(stem: str, content: str) -> int:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUTPUT_DIR / f"{stem}.txt"
    path.write_text(content, encoding="utf-8")
    return len(content)


def render_string_const(module, attr: str) -> str:
    value = getattr(module, attr)
    assert isinstance(value, str), f"{attr} expected str, got {type(value).__name__}"
    return value


def render_schema_dict(module, attr: str) -> str:
    value = getattr(module, attr)
    assert isinstance(value, dict), f"{attr} expected dict, got {type(value).__name__}"
    return json.dumps(value, indent=2, ensure_ascii=False)


def render_browser_schema(module, tool_name: str) -> str:
    schema_map = getattr(module, "_BROWSER_SCHEMA_MAP", None)
    assert isinstance(schema_map, dict), "_BROWSER_SCHEMA_MAP expected dict"
    value = schema_map.get(tool_name)
    assert isinstance(value, dict), f"{tool_name} schema expected dict, got {type(value).__name__}"
    return json.dumps(value, indent=2, ensure_ascii=False)


def render_platform_hints(module) -> str:
    """PLATFORM_HINTS is a dict[str,str] of channel → hint string. The LLM only
    sees ONE entry per request (whichever platform the agent is on). Render a
    representative sample plus the catalog of available channels.
    """
    hints = module.PLATFORM_HINTS
    parts = []
    parts.append(
        "# PLATFORM_HINTS structure\n"
        "# This is a dict[str, str] mapping channel id -> hint string. The LLM\n"
        "# only sees one entry per request: the hint for the active channel,\n"
        "# inserted into the system prompt by AIAgent._build_system_prompt().\n"
        f"# Available channels ({len(hints)}): "
        + ", ".join(sorted(hints.keys()))
        + "\n\n"
    )
    # Render representative entries side-by-side
    for key in ["telegram", "slack", "cli", "sms", "bluebubbles", "cron", "discord"]:
        if key in hints:
            parts.append(f"## PLATFORM_HINTS['{key}']\n\n{hints[key]}\n\n")
    return "".join(parts).rstrip() + "\n"


def main() -> None:
    from agent import prompt_builder
    from tools import (
        browser_tool,
        clarify_tool,
        delegate_tool,
        file_tools,
        send_message_tool,
        terminal_tool,
        web_tools,
    )

    results: list[tuple[str, int]] = []

    # Guidance / identity / hint constants
    string_specs = [
        ("hermes_default_agent_identity", prompt_builder, "DEFAULT_AGENT_IDENTITY"),
        ("hermes_memory_guidance", prompt_builder, "MEMORY_GUIDANCE"),
        ("hermes_session_search_guidance", prompt_builder, "SESSION_SEARCH_GUIDANCE"),
        ("hermes_skills_guidance", prompt_builder, "SKILLS_GUIDANCE"),
        ("hermes_kanban_guidance", prompt_builder, "KANBAN_GUIDANCE"),
        ("hermes_tool_use_enforcement", prompt_builder, "TOOL_USE_ENFORCEMENT_GUIDANCE"),
        ("hermes_openai_execution", prompt_builder, "OPENAI_MODEL_EXECUTION_GUIDANCE"),
        ("hermes_google_operational", prompt_builder, "GOOGLE_MODEL_OPERATIONAL_GUIDANCE"),
        ("hermes_wsl_environment_hint", prompt_builder, "WSL_ENVIRONMENT_HINT"),
    ]
    for stem, mod, attr in string_specs:
        text = render_string_const(mod, attr)
        size = write_output(stem, text)
        results.append((stem, size))

    # PLATFORM_HINTS — render a sample + catalog
    text = render_platform_hints(prompt_builder)
    results.append(("hermes_platform_hints", write_output("hermes_platform_hints", text)))

    # Tool schemas
    schema_specs = [
        ("hermes_web_search_tool", web_tools, "WEB_SEARCH_SCHEMA"),
        ("hermes_web_extract_tool", web_tools, "WEB_EXTRACT_SCHEMA"),
        ("hermes_terminal_tool", terminal_tool, "TERMINAL_SCHEMA"),
        ("hermes_delegate_tool", delegate_tool, "DELEGATE_TASK_SCHEMA"),
        ("hermes_clarify_tool", clarify_tool, "CLARIFY_SCHEMA"),
        ("hermes_send_message_tool", send_message_tool, "SEND_MESSAGE_SCHEMA"),
        ("hermes_search_files_tool", file_tools, "SEARCH_FILES_SCHEMA"),
    ]
    for stem, mod, attr in schema_specs:
        text = render_schema_dict(mod, attr)
        size = write_output(stem, text)
        results.append((stem, size))

    child_prompt = delegate_tool._build_child_system_prompt(
        "{{TASK_DESCRIPTION}}",
        context="{{CONTEXT}}",
        workspace_path="{{WORKSPACE_PATH}}",
        role="orchestrator",
        max_spawn_depth=2,
        child_depth=1,
    )
    skill_path = HERMES_ROOT / "optional-skills" / "research" / "gitnexus-explorer" / "SKILL.md"
    skill_text = skill_path.read_text(encoding="utf-8") if skill_path.exists() else "[gitnexus-explorer skill not found]"
    text = (
        "# Generic Delegated Child Prompt\n\n"
        + child_prompt
        + "\n\n# Optional GitNexus Explorer Skill\n\n"
        + skill_text
    )
    results.append(("hermes_explore_reference", write_output("hermes_explore_reference", text)))

    # Browser tool schemas (for strict browser prompt pairing coverage)
    browser_schema_specs = [
        ("hermes_browser_navigate", "browser_navigate"),
        ("hermes_browser_snapshot", "browser_snapshot"),
        ("hermes_browser_click", "browser_click"),
        ("hermes_browser_type", "browser_type"),
        ("hermes_browser_scroll", "browser_scroll"),
        ("hermes_browser_back", "browser_back"),
        ("hermes_browser_press", "browser_press"),
        ("hermes_browser_vision", "browser_vision"),
    ]
    for stem, tool_name in browser_schema_specs:
        text = render_browser_schema(browser_tool, tool_name)
        size = write_output(stem, text)
        results.append((stem, size))

    print("Rendered Hermes prompts:")
    for stem, size in results:
        print(f"  {stem:<40s} {size:>7d} chars")


if __name__ == "__main__":
    main()
