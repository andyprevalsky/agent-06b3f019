#!/usr/bin/env python3
"""Render runtime values of every OUR Python prompt to prompt-review/rendered/ours/<id>.txt.

Strategy: import each module so Python resolves all (...) string concatenations
and external constants automatically. For builder functions, call with
realistic production-like defaults. For tool-spec dicts, dump as JSON.

Re-runnable. No side effects beyond writing .txt files.
"""

from __future__ import annotations

import importlib
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
RENDERED = ROOT / "prompt-review" / "rendered" / "ours"
RENDERED.mkdir(parents=True, exist_ok=True)

# Make agents/ importable.
AGENTS = ROOT / "agents"
sys.path.insert(0, str(AGENTS))

# agents/config.py reads many env vars at import time. Set dummy values so we
# can import prompt modules without a full runtime environment.
for k in [
    "TEMPORAL_API_KEY", "TEMPORAL_NAMESPACE", "TEMPORAL_ADDRESS", "TEMPORAL_TASK_QUEUE",
    "OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
    "PERPLEXITY_API_KEY", "GEMINI_API_KEY", "EXA_API_KEY",
    "BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID",
    "BACKEND_API_KEY", "BACKEND_URL", "BACKEND_API_URL",
    "SUPABASE_URL", "SUPABASE_KEY", "SUPABASE_SERVICE_ROLE_KEY",
    "ROSE_API_KEY", "ROSE_BASE_URL",
    "STAGEHAND_API_KEY", "E2B_API_KEY", "VAPI_API_KEY",
    "DATABASE_URL", "PARRALLEL_API_KEY",
]:
    os.environ.setdefault(k, "render-stub")


def write(idx: str, text: str) -> None:
    path = RENDERED / f"{idx}.txt"
    path.write_text(text)
    print(f"  ✓ {idx} ({len(text)} chars)")


# ----------------------------------------------------------------------------
# Constants (utils/prompts.py)
# ----------------------------------------------------------------------------
print("[render] utils/prompts.py constants")
from utils.prompts import (  # noqa: E402
    VERIFICATION_RULES,
    SELF_CONTAINED_GOAL_RULE,
    EPHEMERAL_SESSION_RULE,
    CONTEXT_POINTERS_RULE,
    FILE_HANDLING_RULE,
    CRITICAL_CONSTRAINTS_RULE,
    RESEARCH_PHASE_PROMPT,
    EXECUTE_PHASE_PROMPT,
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    _VERIFIER_STATIC_PROMPT,
    EXPLORE_AGENT_SYSTEM_PROMPT,
)

write("VERIFICATION_RULES", VERIFICATION_RULES)
write("SELF_CONTAINED_GOAL_RULE", SELF_CONTAINED_GOAL_RULE)
write("EPHEMERAL_SESSION_RULE", EPHEMERAL_SESSION_RULE)
write("CONTEXT_POINTERS_RULE", CONTEXT_POINTERS_RULE)
write("FILE_HANDLING_RULE", FILE_HANDLING_RULE)
write("CRITICAL_CONSTRAINTS_RULE", CRITICAL_CONSTRAINTS_RULE)
write("RESEARCH_PHASE_PROMPT", RESEARCH_PHASE_PROMPT)
write("EXECUTE_PHASE_PROMPT", EXECUTE_PHASE_PROMPT)
write("_VERIFIER_STATIC_PROMPT", _VERIFIER_STATIC_PROMPT)
write("EXPLORE_AGENT_SYSTEM_PROMPT", EXPLORE_AGENT_SYSTEM_PROMPT)

# ----------------------------------------------------------------------------
# Tool prompts (one PROMPT per file)
# ----------------------------------------------------------------------------
print("[render] tools/prompts/*.py")
TOOL_MODULES = [
    ("tool_attempt_completion", "tools.prompts.attempt_completion"),
    ("tool_call_phone_number", "tools.prompts.call_phone_number"),
    ("tool_grep", "tools.prompts.grep"),
    ("tool_message_person", "tools.prompts.message_person"),
    ("tool_reasoning", "tools.prompts.reasoning"),
    ("tool_send_message_to_user", "tools.prompts.send_message_to_user"),
    ("tool_send_message_to_user_execute", "tools.prompts.send_message_to_user_execute_phase"),
    ("tool_set_plan", "tools.prompts.set_plan"),
    ("tool_spawn_agent", "tools.prompts.spawn_agent"),
    ("tool_spawn_browser_agent", "tools.prompts.spawn_browser_agent"),
    ("tool_spawn_code_agent", "tools.prompts.spawn_code_agent"),
    ("tool_spawn_explore_agent", "tools.prompts.spawn_explore_agent"),
    ("tool_spawn_sub_agent", "tools.prompts.spawn_sub_agent"),
    ("tool_spawn_sub_agent_for_each", "tools.prompts.spawn_sub_agent_for_each"),
    ("tool_wait_for", "tools.prompts.wait_for"),
    ("tool_web_fetch", "tools.prompts.web_fetch"),
    ("tool_web_search", "tools.prompts.web_search"),
]
for tool_id, mod_name in TOOL_MODULES:
    try:
        mod = importlib.import_module(mod_name)
    except Exception as e:
        write(tool_id, f"[render error: {e}]")
        continue
    write(tool_id, getattr(mod, "PROMPT", str(mod)))

# ----------------------------------------------------------------------------
# Browser tool definitions (list of dicts, one per tool)
# ----------------------------------------------------------------------------
print("[render] browser_tools/tool_definitions.py")
from browser_tools.tool_definitions import (  # noqa: E402
    get_browser_tool_definitions,
    get_system_prompt as browser_get_sysprompt,
)

# Render the system prompt with realistic placeholder args.
write("browser_get_system_prompt", browser_get_sysprompt(
    task_instruction="<TASK_INSTRUCTION_FROM_PARENT>",
    current_url="<CURRENT_URL>",
))

# Each tool dict — dump as JSON so the LLM-visible schema is preserved.
BROWSER_TOOL_IDS = {
    "observe": "browser_tool_observe",
    "extract": "browser_tool_extract",
    "click": "browser_tool_click",
    "fill": "browser_tool_fill",
    "type": "browser_tool_type",
    "pressKey": "browser_tool_press_key",
    "goto": "browser_tool_goto",
    "scroll": "browser_tool_scroll",
    "wait": "browser_tool_wait",
    "attempt_completion": "browser_tool_attempt_completion",
    "screenshot": "browser_tool_screenshot",
    "ariaTree": "browser_tool_aria_tree",
    "navback": "browser_tool_navback",
    "clickAtCoordinates": "browser_tool_click_at_coordinates",
}
tools = get_browser_tool_definitions(current_url="https://example.com")
for tool in tools:
    name = tool.get("name") or (tool.get("function") or {}).get("name")
    cat_id = BROWSER_TOOL_IDS.get(name)
    if cat_id is None:
        continue
    write(cat_id, json.dumps(tool, indent=2, default=str))

# ----------------------------------------------------------------------------
# Builder functions
# ----------------------------------------------------------------------------
print("[render] builder functions")
from utils.prompts import (  # noqa: E402
    build_system_prompt,
    build_verifier_prompt,
    build_planner_system_prompt,
)

REPRESENTATIVE_USER_CONTEXT = """\
[USER PROFILE]
- Name: <USER_NAME>
- Phone: <USER_PHONE>
- Address: <USER_ADDRESS>

[AUTHENTICATED SESSIONS]
- example.com (cookies persisted)

[INTEGRATIONS]
- Gmail (read-only)

[RECENT COMMUNICATIONS]
- 10 recent SMS threads (truncated for review)

[NETWORK]
- 50 contacts (sample shown above)
"""

REPRESENTATIVE_RESPONSE_SCHEMA = {
    "fields": [
        {"name": "answer", "type": "str", "description": "Final answer text.", "required": True},
        {"name": "sources", "type": "list[str]", "description": "Source URLs used to derive the answer.", "required": True},
    ]
}

# Tool-prompt registry retained for older prompt-review fixtures. The runtime
# agent system prompt no longer inlines tool guidance; tool behavior is carried
# by the structured tool schemas.
RENDER_TOOL_PROMPTS: dict[str, str] = {}
for _tid, _mod_name in TOOL_MODULES:
    try:
        _m = importlib.import_module(_mod_name)
        _tool_name = _mod_name.rsplit(".", 1)[-1]  # tools.prompts.web_search → web_search
        # Map renderer ID like "tool_send_message_to_user_execute" → real tool name
        _alias_overrides = {
            "send_message_to_user_execute_phase": "send_message_to_user_execute_phase",
        }
        RENDER_TOOL_PROMPTS[_alias_overrides.get(_tool_name, _tool_name)] = getattr(_m, "PROMPT", "")
    except Exception:
        pass

# build_system_prompt — static pre-boundary section only. Phase-specific text
# is reviewed separately via RESEARCH_PHASE_PROMPT and EXECUTE_PHASE_PROMPT.
_full_system_prompt = build_system_prompt(
    phase="EXECUTE",
    enabled_tools=[
        "spawn_agent",
        "web_search",
        "web_fetch",
        "message_person",
        "send_message_to_user_execute_phase",
        "attempt_completion",
    ],
    disabled_tools=[],
    user_context_section=REPRESENTATIVE_USER_CONTEXT,
    response_schema=REPRESENTATIVE_RESPONSE_SCHEMA,
    tool_prompts=RENDER_TOOL_PROMPTS,
)
write(
    "build_system_prompt",
    _full_system_prompt.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY, 1)[0].strip()
    + SYSTEM_PROMPT_DYNAMIC_BOUNDARY.strip(),
)

# build_verifier_prompt — with a representative schema.
write("build_verifier_prompt", build_verifier_prompt(
    response_schema=REPRESENTATIVE_RESPONSE_SCHEMA,
))

# build_planner_system_prompt — use the same formatted planner tool
# injection path as runtime so review catches wiring/formatting regressions.
from domains.set_plan.service import get_planner_tools_description  # noqa: E402

PLANNER_TOOLS_DESC = get_planner_tools_description()
write("build_planner_system_prompt", build_planner_system_prompt(
    available_tools_description=PLANNER_TOOLS_DESC,
    user_context=REPRESENTATIVE_USER_CONTEXT,
    response_schema=REPRESENTATIVE_RESPONSE_SCHEMA,
))

# ----------------------------------------------------------------------------
# Runtime prompt blocks that are assembled outside utils/prompts.py
# ----------------------------------------------------------------------------
print("[render] runtime assembled Python prompts")

# helpers/get_user_context.py
from helpers.get_user_context import _format_user_context  # noqa: E402

write("user_generated_context_system_prompt_block", _format_user_context(
    authenticated_sites=["amazon.com", "gmail.com"],
    user_settings={
        "name": "<USER_NAME>",
        "phone": "<USER_PHONE>",
        "addressLine1": "<STREET_ADDRESS>",
        "city": "<CITY>",
        "state": "<STATE>",
        "postalCode": "<POSTAL_CODE>",
        "country": "<COUNTRY>",
    },
    recent_messages=[
        {
            "channel": "SMS",
            "timestamp": "2026-05-06T12:00:00Z",
            "from": "<CONTACT_PHONE>",
            "to": "<USER_PHONE>",
            "message": "Representative recent message shown to the agent.",
        }
    ],
    frequent_contacts=[
        {
            "firstName": "<CONTACT_FIRST>",
            "lastName": "<CONTACT_LAST>",
            "phoneNumber": "<CONTACT_PHONE>",
            "communicationFrequency": "frequent",
            "messagesExchanged": 42,
            "relation": "friend",
            "company": "<COMPANY>",
        }
    ],
    integrations=[
        {
            "status": "CONNECTED",
            "name": "Gmail",
            "emailCredentials": [{"email": "<USER_EMAIL>"}],
        }
    ],
))

# domains/spawn_browser_agent_v3/service.py
from providers.rose.browser_use import build_browser_use_system_prompt as _build_browser_use_prompt  # noqa: E402
from browser_tools.schemas import AVAILABLE_ACTIONS as _V3_BROWSER_ACTIONS  # noqa: E402

_browser_static = _build_browser_use_prompt(_V3_BROWSER_ACTIONS)
_browser_dynamic = (
    "\n\n# Current Goal\n<USER_GOAL>"
    "\n\n# Available Files for Upload\n"
    "The following files are available to upload using the upload_file action.\n"
    "To upload a file, find a file input element (<input type=\"file\">) and use "
    "upload_file with the filename.\n"
    "AVAILABLE FILES FOR UPLOAD: <ATTACHED_FILE_1>, <ATTACHED_FILE_2>"
    "\n\n# Custom Instructions\n"
    "<BROWSER_CUSTOM_INSTRUCTIONS>"
    "\n\nYou will receive a [STATE: ...] line at the end of each turn carrying the per-step time and URL."
)
write("spawn_browser_agent_v3_system_prompt", _browser_static + SYSTEM_PROMPT_DYNAMIC_BOUNDARY + _browser_dynamic)

# domains/spawn_claude_code_agent/service.py
_claude_code_file_info = """

# Available Files
User attachments are available in /home/user/attachments/
Claude Code can read and process these files as needed.

# Output Files
When Claude Code creates files the user needs, it should copy them to /home/user/output/
Files in this directory will be automatically uploaded and returned to the user."""

_claude_code_static = (
    "You are the parent agent monitoring Claude Code, a terminal-based coding agent. "
    "You read its terminal output and decide when to respond, intervene, or mark the task complete.\n\n"
    "Claude Code's terminal output appears as USER messages. Your responses will be sent to Claude Code's stdin.\n\n"
    "# Your Role\n"
    "- Monitor Claude Code's progress on the task\n"
    "- Answer questions Claude Code asks (numbered options can be answered with just the number)\n"
    "- Provide guidance when Claude Code seems stuck\n"
    "- Determine when the task is complete\n\n"
    "# Decision Making\n"
    "Set attempt_completion=true ONLY when:\n"
    "- Claude Code has explicitly stated the task is done\n"
    "- The output shows clear completion (tests passing, task finished, etc.)\n"
    "- Claude Code is asking \"Is there anything else?\" or similar\n\n"
    "Set attempt_completion=false when:\n"
    "- Claude Code is asking questions or requesting input\n"
    "- Claude Code is still working (you see active tool calls, file operations)\n"
    "- Claude Code encountered an error that needs addressing\n\n"
    "# Response Guidelines\n"
    "- Be concise; Claude Code is a terminal agent\n"
    "- If Claude asks numbered options (like 1, 2, 3), respond with just the number\n"
    "- If unsure about a question, let Claude Code decide (respond with \"your choice\" or similar)\n"
    "- Don't repeat the original goal back to Claude Code; it already knows it"
    f"{_claude_code_file_info}"
)
write(
    "spawn_claude_code_monitor_system_prompt",
    _claude_code_static + SYSTEM_PROMPT_DYNAMIC_BOUNDARY + "# Original Goal\n<USER_GOAL>",
)

# domains/message_person/repo.py
_message_person_static_system = (
    "You are a ghostwriter. You compose a message on behalf of a user "
    "from their personal account, in a voice indistinguishable from how "
    "they write themselves. You are NOT an AI assistant; you produce the "
    "message text only.\n\n"
    "Do not use em dashes in any output. Use regular hyphens (-) or commas instead.\n\n"
    "# Voice and Style Rules\n"
    "- Study the user's previous messages carefully. Mimic their exact writing style: "
    "sentence length, vocabulary, punctuation habits, capitalization patterns, use of "
    "abbreviations, emoji usage (or lack thereof).\n"
    "- Pay special attention to how the user writes on the channel they are sending on. "
    "People write differently across channels: texts are usually more casual than emails. "
    "Match the channel-specific style.\n"
    "- Study how the user specifically communicates with the recipient. The tone, formality, "
    "and style may differ from how they write to other people. Match the relationship dynamic.\n"
    "- If previous messages exist, the generated message should be indistinguishable from "
    "the user's real messages.\n\n"
    "# Content Rules\n"
    "- Write ONLY the message content (and subject if email). No meta-commentary.\n"
    "- Be authentic and genuine; this message is sent from the user's personal account, not from an AI.\n"
    "- Reference specific shared context when relevant (previous conversations, mutual interests).\n"
    "- Do NOT include placeholder text like [your name] or [company]."
)
_message_person_persona = (
    "# Persona\n"
    "You ARE <SYSTEM_NAME>. The message will be sent from <SYSTEM_NAME>'s personal account, "
    "so it must sound exactly like <SYSTEM_NAME> wrote it. Sign the message as <SYSTEM_NAME>, "
    "not as an AI assistant or agent name."
)
_message_person_voice = (
    "# <SYSTEM_NAME>'s Recent Messages (all contacts)\n"
    "Use these to understand <SYSTEM_NAME>'s general writing voice, tone, and habits across conversations.\n"
    "<GENERAL_RECENT_MESSAGES_CONTEXT>"
)
_message_person_user = (
    "# Channel\nEmail\n\n"
    "You are writing an email. Be professional but personable. "
    "Include a clear, concise subject line. Structure the email with a greeting, body, and sign-off. "
    "Sign the email as <SYSTEM_NAME>.\n\n"
    "# Recipient\n<PERSON_NAME>\n\n"
    "# Intent\n<MESSAGE_INTENT>\n\n"
    "# Previous Messages with <PERSON_NAME>\n<MESSAGES_WITH_RECIPIENT>\n\n"
    "# Research about <PERSON_NAME>\n<EXA_CONTEXT_OR_NONE>\n\n"
    "# Recent Conversation Context\n<CONVERSATION_CONTEXT>\n\n"
    "Now write the message as <SYSTEM_NAME>. Include a subject line on the first line prefixed with "
    "'Subject: ' followed by the message body."
)
write(
    "message_person_generation_prompt",
    "\n\n".join([
        _message_person_static_system + SYSTEM_PROMPT_DYNAMIC_BOUNDARY + _message_person_persona,
        _message_person_voice,
        _message_person_user,
    ]),
)

write(
    "wait_for_condition_evaluator_prompt",
    "You are a yes/no classifier. Given a condition and evidence gathered from "
    "the web, determine if the condition is currently satisfied.\n\n"
    "Condition: <CONDITION>\n\nEvidence:\n<EVIDENCE>",
)

write(
    "browser_extract_llm_prompt",
    "You are a data extraction assistant. Extract information from the provided web page content according to the user's instruction.\n\n"
    "Be precise and only extract what is asked for. If the requested information is not found, say so clearly.\n\n"
    "Return the extracted data in a clear, structured format.\n\n"
    "URL: <CURRENT_URL>\n\n"
    "PAGE CONTENT:\n<PAGE_CONTENT>\n\n"
    "EXTRACTION INSTRUCTION:\n<INSTRUCTION>\n\n"
    "Extract the requested information from the page content above.",
)

write(
    "context_compression_prompt",
    "You are analyzing an autonomous AI agent's execution history to extract key learnings.\n\n"
    "EXECUTION HISTORY (<MESSAGE_COUNT> messages, <ITERATION_COUNT> iterations):\n"
    "<FULL_CONTEXT>\n\n"
    "Analyze this execution and extract:\n\n"
    "1. **What went RIGHT** - Successful strategies, good decisions, effective tools used\n"
    "2. **What went WRONG** - Mistakes made, failed approaches, errors encountered\n\n"
    "Be concise but specific. Focus on actionable insights that would help the agent continue more effectively.\n\n"
    "Format your response as:\n"
    "## Key Learnings After <ITERATION_COUNT> Iterations\n\n"
    "### ✅ What Worked\n"
    "- [specific successful action/strategy]\n"
    "- [another success]\n\n"
    "### ❌ What Didn't Work\n"
    "- [specific mistake/failure]\n"
    "- [another mistake]\n\n"
    "### 💡 Recommended Approach Going Forward\n"
    "- [concrete next steps based on learnings]",
)

write(
    "completion_summary_prompt",
    "You are summarizing the work completed by an AI agent.\n\n"
    "ORIGINAL GOAL: <USER_GOAL>\n"
    "<STRUCTURED_OUTPUT_CONTEXT>\n\n"
    "Write a BRIEF 1-2 sentence summary of what was accomplished. Focus on the outcome and key result.\n"
    "Do NOT use markdown formatting, bullet points, or section headers.\n"
    "Do NOT list the structured output values - they are displayed separately in the UI.\n"
    "Just write plain text describing what was done.\n\n"
    "Provide a brief 1-2 sentence summary of what was accomplished. Plain text only, no markdown.",
)

# ----------------------------------------------------------------------------
# domains/reasoning/config.py
# ----------------------------------------------------------------------------
print("[render] domains/reasoning + browser_use + param_populator")
from domains.reasoning.config import REASONING_SYSTEM_PROMPT_TEMPLATE  # noqa: E402
write("REASONING_SYSTEM_PROMPT_TEMPLATE", REASONING_SYSTEM_PROMPT_TEMPLATE)

# providers/rose/browser_use.py
from providers.rose.browser_use import build_browser_use_system_prompt  # noqa: E402
DEFAULT_BROWSER_ACTIONS = [
    "go_to_url", "click", "fill", "type", "press_key", "scroll", "wait",
    "screenshot", "extract", "ariaTree", "navback", "attempt_completion",
]
write("build_browser_use_system_prompt",
      build_browser_use_system_prompt(available_actions=DEFAULT_BROWSER_ACTIONS))

# domains/param_populator/service.py
# Production always passes a non-empty alias_hint (matching one of the keys
# in SPAWN_PARAM_REQUIREMENTS) so the type-specific 20-50 line block fires.
from domains.param_populator.service import build_agent_system_prompt  # noqa: E402
write("param_populator_build_agent_system_prompt", build_agent_system_prompt(
    tool_name="spawn_explore_agent",
    goal="<USER_GOAL>",
    alias_hint="spawn_explore_agent",
))

# domains/param_populator/config.py
from domains.param_populator.config import SPAWN_PARAM_REQUIREMENTS  # noqa: E402
# It's a dict[str, str] — render as JSON so the user can see all per-type sections.
write("SPAWN_PARAM_REQUIREMENTS",
      json.dumps(SPAWN_PARAM_REQUIREMENTS, indent=2))

# ----------------------------------------------------------------------------
# helpers/knowledge_base.py
# ----------------------------------------------------------------------------
print("[render] helpers/")
from helpers.knowledge_base import BLUEPRINT_COMPRESSION_PROMPT  # noqa: E402
write("BLUEPRINT_COMPRESSION_PROMPT", BLUEPRINT_COMPRESSION_PROMPT)

# helpers/*.txt — these ARE the runtime prompt; just copy.
for txt_id, rel in [
    ("GEPA_V3_PLANNING_INSTRUCTION", "agents/helpers/gepa_v3_strategy_override.txt"),
    ("PLANNER_V3_STRATEGY_OVERRIDE", "agents/helpers/planner_strategy_override_v3.txt"),
]:
    p = ROOT / rel
    if p.exists():
        write(txt_id, p.read_text())
    else:
        write(txt_id, f"[file not found: {rel}]")

print("[render] done.")
