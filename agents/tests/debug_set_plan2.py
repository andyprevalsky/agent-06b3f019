"""
Debug: Can the model call set_plan at all? Test with forced tool_choice and schema variants.
"""

import json
import subprocess
import sys
import os

import httpx

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from helpers.llm import prepare_schema_for_openai
from utils.tool_schemas import PLAN_PHASE_TOOLS, create_agent_action_model


def get_claude_token() -> str:
    raw = subprocess.check_output(
        ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
        stderr=subprocess.DEVNULL, text=True,
    ).strip()
    return json.loads(raw)["claudeAiOauth"]["accessToken"]


def extract_native_tools(schema: dict):
    any_of = schema.get("properties", {}).get("tool_calls", {}).get("items", {}).get("anyOf", [])
    tools = []
    for variant in any_of:
        tool_name = variant["properties"]["tool"]["const"]
        description = variant.get("description", "")
        input_props = {k: v for k, v in variant["properties"].items() if k != "tool"}
        required = [r for r in variant.get("required", []) if r != "tool"]
        input_schema = {"type": "object", "properties": input_props, "required": required}
        if "additionalProperties" in variant:
            input_schema["additionalProperties"] = variant["additionalProperties"]
        tools.append({"name": tool_name, "description": description, "input_schema": input_schema})
    return tools


HEADERS = None
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"

SYSTEM = """You are a super-intelligent autonomous system. Your goal is to plan and execute tasks.

# Phase
PLAN - Research and gather context, then create an execution plan.

STATE MACHINE:
NODE: RESEARCH (start) -> call set_plan when ready
NODE: SET_PLAN -> plan is generated automatically
NODE: EXIT -> call attempt_completion

# Output Format
Write your thinking/reasoning as plain text, then call tools.
If your previous turn did not include a tool call, you MUST call a tool now."""


def call_anthropic(body: dict, label: str):
    print(f"\n{'='*60}")
    print(f"  {label}")
    print(f"{'='*60}")
    resp = httpx.post(ANTHROPIC_URL, headers=HEADERS, json=body, timeout=120.0)
    if resp.status_code != 200:
        print(f"  ERROR {resp.status_code}: {resp.text[:500]}")
        return None
    data = resp.json()
    print(f"  Stop reason: {data.get('stop_reason')}")
    for i, block in enumerate(data.get("content", [])):
        btype = block.get("type")
        if btype == "text":
            print(f"  [{i}] TEXT ({len(block['text'])} chars): {block['text'][:300]}")
        elif btype == "tool_use":
            print(f"  [{i}] TOOL_USE: {block['name']}  input={json.dumps(block['input'])[:200]}")
    tool_names = [b["name"] for b in data.get("content", []) if b.get("type") == "tool_use"]
    print(f"  Tools called: {tool_names}")
    return data


def main():
    global HEADERS
    token = get_claude_token()
    HEADERS = {
        "Authorization": f"Bearer {token}",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20,claude-code-20250219,prompt-caching-scope-2026-01-05",
        "x-app": "cli",
        "User-Agent": "claude-cli/2.1.45 (external, rose-planner)",
        "content-type": "application/json",
    }

    # Get the actual extracted tools
    model_cls = create_agent_action_model(PLAN_PHASE_TOOLS)
    schema = prepare_schema_for_openai(model_cls)
    native_tools = extract_native_tools(schema)

    # Print set_plan tool schema
    set_plan_tool = [t for t in native_tools if t["name"] == "set_plan"][0]
    print("set_plan schema:")
    print(json.dumps(set_plan_tool, indent=2))

    messages_research_done = [
        {"role": "user", "content": "Find the best Italian restaurant in SF and make a reservation for 2 tonight at 7pm."},
        {"role": "assistant", "content": [
            {"type": "text", "text": "Let me search for the best Italian restaurants."},
            {"type": "tool_use", "id": "t1", "name": "web_search", "input": {"query": "best Italian restaurant San Francisco"}},
        ]},
        {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "t1", "content": "Top results: 1. Flour+Water 2. Cotogna 3. Delfina"},
        ]},
    ]

    # ── TEST 1: Force tool_choice to set_plan ──
    call_anthropic({
        "model": "claude-sonnet-4-6",
        "system": SYSTEM,
        "messages": messages_research_done,
        "tools": native_tools,
        "tool_choice": {"type": "tool", "name": "set_plan"},
        "max_tokens": 4096,
    }, "TEST 1: tool_choice forced to set_plan (can it call it at all?)")

    # ── TEST 2: tool_choice=auto, with user nudge to call set_plan ──
    msgs_with_nudge = messages_research_done + [
        {"role": "user", "content": "You have enough context. Call set_plan now to proceed to planning."},
    ]
    call_anthropic({
        "model": "claude-sonnet-4-6",
        "system": SYSTEM,
        "messages": msgs_with_nudge,
        "tools": native_tools,
        "tool_choice": {"type": "auto"},
        "max_tokens": 4096,
    }, "TEST 2: tool_choice=auto + explicit nudge to call set_plan")

    # ── TEST 3: set_plan with a dummy parameter (test if empty schema is the issue) ──
    tools_with_param = [t.copy() for t in native_tools]
    for t in tools_with_param:
        if t["name"] == "set_plan":
            t["input_schema"] = {
                "type": "object",
                "properties": {
                    "ready": {
                        "type": "boolean",
                        "description": "Set to true to confirm you are ready to generate the plan.",
                    }
                },
                "required": ["ready"],
            }

    call_anthropic({
        "model": "claude-sonnet-4-6",
        "system": SYSTEM,
        "messages": msgs_with_nudge,
        "tools": tools_with_param,
        "tool_choice": {"type": "auto"},
        "max_tokens": 4096,
    }, "TEST 3: set_plan with dummy 'ready' parameter + nudge")

    # ── TEST 4: tool_choice=any (forced to call SOME tool) + nudge ──
    call_anthropic({
        "model": "claude-sonnet-4-6",
        "system": SYSTEM,
        "messages": msgs_with_nudge,
        "tools": native_tools,
        "tool_choice": {"type": "any"},
        "max_tokens": 4096,
    }, "TEST 4: tool_choice=any + explicit nudge to call set_plan")

    # ── TEST 5: Only set_plan and attempt_completion available (no other tools) ──
    signal_only = [t for t in native_tools if t["name"] in ("set_plan", "attempt_completion")]
    call_anthropic({
        "model": "claude-sonnet-4-6",
        "system": SYSTEM,
        "messages": messages_research_done,
        "tools": signal_only,
        "tool_choice": {"type": "auto"},
        "max_tokens": 4096,
    }, "TEST 5: Only set_plan + attempt_completion available (no distractions)")

    # ── TEST 6: Simulate the stuck loop — assistant text-only, then user nudge ──
    msgs_stuck = messages_research_done + [
        {"role": "assistant", "content": [
            {"type": "text", "text": "I have enough context. Let me proceed to plan this out."},
        ]},
        {"role": "user", "content": "You did not call any tools in your previous turn. You MUST call a tool now to make progress towards completing your task autonomously. Do not respond with only text."},
    ]
    call_anthropic({
        "model": "claude-sonnet-4-6",
        "system": SYSTEM,
        "messages": msgs_stuck,
        "tools": native_tools,
        "tool_choice": {"type": "auto"},
        "max_tokens": 4096,
    }, "TEST 6: Simulate stuck loop — previous turn was text-only, injected nudge")


if __name__ == "__main__":
    main()
