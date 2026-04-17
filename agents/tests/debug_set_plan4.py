"""
Debug: Force set_plan via different strategies.
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


def call_anthropic(headers, body, label):
    print(f"\n{'='*60}")
    print(f"  {label}")
    print(f"{'='*60}")
    resp = httpx.post(ANTHROPIC_URL, headers=headers, json=body, timeout=120.0)
    if resp.status_code != 200:
        print(f"  ERROR {resp.status_code}: {resp.text[:500]}")
        return []
    data = resp.json()
    print(f"  Stop reason: {data.get('stop_reason')}")
    for i, block in enumerate(data.get("content", [])):
        btype = block.get("type")
        if btype == "text":
            print(f"  [{i}] TEXT ({len(block['text'])} chars): {block['text'][:200]}")
        elif btype == "tool_use":
            print(f"  [{i}] TOOL_USE: {block['name']}  input={json.dumps(block['input'])[:200]}")
    tool_names = [b["name"] for b in data.get("content", []) if b.get("type") == "tool_use"]
    print(f"  Tools called: {tool_names}")
    return tool_names


def main():
    token = get_claude_token()
    headers = {
        "Authorization": f"Bearer {token}",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20,claude-code-20250219,prompt-caching-scope-2026-01-05",
        "x-app": "cli",
        "User-Agent": "claude-cli/2.1.45 (external, rose-planner)",
        "content-type": "application/json",
    }

    model_cls = create_agent_action_model(PLAN_PHASE_TOOLS)
    schema = prepare_schema_for_openai(model_cls)
    native_tools = extract_native_tools(schema)

    # Simulate stuck loop: model did research, then produced text-only
    base_msgs = [
        {"role": "user", "content": "Find the best Italian restaurant in SF and make a reservation for 2 tonight at 7pm."},
        {"role": "assistant", "content": [
            {"type": "text", "text": "Let me search for the best Italian restaurants."},
            {"type": "tool_use", "id": "t1", "name": "web_search", "input": {"query": "best Italian restaurant San Francisco"}},
        ]},
        {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "t1", "content": "Top results: 1. Flour+Water (highly rated, Mission District) 2. Cotogna (Italian fine dining, Jackson Square) 3. Delfina (classic Italian, Mission)"},
        ]},
        {"role": "assistant", "content": [
            {"type": "text", "text": "I have enough context to proceed. Let me plan this out and execute."},
        ]},
    ]

    results = {}

    # Strategy A: tool_choice forced to set_plan when nudge fires
    msgs_a = base_msgs.copy()
    names = call_anthropic(headers, {
        "model": "claude-sonnet-4-6",
        "system": SYSTEM,
        "messages": msgs_a,
        "tools": native_tools,
        "tool_choice": {"type": "tool", "name": "set_plan"},
        "max_tokens": 4096,
    }, "Strategy A: Force tool_choice to set_plan (no nudge msg)")
    results["A: forced tool_choice"] = names

    # Strategy B: tool_choice=any + remove send_message_to_user from tools
    tools_no_msg = [t for t in native_tools if t["name"] != "send_message_to_user"]
    msgs_b = base_msgs + [{"role": "user", "content": "You did not call a tool. Call set_plan to proceed to plan generation, or web_search/web_fetch for more research."}]
    names = call_anthropic(headers, {
        "model": "claude-sonnet-4-6",
        "system": SYSTEM,
        "messages": msgs_b,
        "tools": tools_no_msg,
        "tool_choice": {"type": "any"},
        "max_tokens": 4096,
    }, "Strategy B: tool_choice=any + remove send_message (4 tools)")
    results["B: any + no send_msg"] = names

    # Strategy C: tool_choice=auto + very aggressive nudge
    aggressive_nudge = """[SYSTEM OVERRIDE] Your previous response contained NO tool calls. This is a violation of your operating protocol.

You MUST call the set_plan tool RIGHT NOW. Do not call send_message_to_user. Do not output text only.
The ONLY acceptable action is: call set_plan to trigger plan generation."""
    msgs_c = base_msgs + [{"role": "user", "content": aggressive_nudge}]
    names = call_anthropic(headers, {
        "model": "claude-sonnet-4-6",
        "system": SYSTEM,
        "messages": msgs_c,
        "tools": native_tools,
        "tool_choice": {"type": "auto"},
        "max_tokens": 4096,
    }, "Strategy C: Aggressive nudge (auto)")
    results["C: aggressive nudge"] = names

    # Strategy D: Use the actual fundraising goal (more realistic/decomposable)
    fundraise_msgs = [
        {"role": "user", "content": "Reach out to every fund / angel / VC on my behalf. Raising 500k-3M. Angels > VCs > Accelerators. Close by end of feb."},
        {"role": "assistant", "content": [
            {"type": "text", "text": "Let me research the investor landscape."},
            {"type": "tool_use", "id": "t1", "name": "web_search", "input": {"query": "top AI angel investors San Francisco 2024"}},
        ]},
        {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "t1", "content": "Results: Naval Ravikant, Elad Gil, Garry Tan (YC), Jason Calacanis, etc."},
        ]},
        {"role": "assistant", "content": [
            {"type": "text", "text": "I have enough context about the investor landscape. Let me now create the plan."},
        ]},
        {"role": "user", "content": "You did not call any tools. If you have gathered enough context, call set_plan to proceed to plan generation. If you need more info, call web_search or web_fetch."},
    ]
    names = call_anthropic(headers, {
        "model": "claude-sonnet-4-6",
        "system": SYSTEM,
        "messages": fundraise_msgs,
        "tools": native_tools,
        "tool_choice": {"type": "auto"},
        "max_tokens": 4096,
    }, "Strategy D: Fundraising goal (realistic) + nudge")
    results["D: realistic goal + nudge"] = names

    # Strategy E: tool_choice=auto but with a modified system that says set_plan is MANDATORY
    system_mandatory = SYSTEM + """

CRITICAL RULE: After research, you MUST call set_plan before anything else.
You cannot call send_message_to_user to explain limitations — call set_plan and let the planner handle it."""
    msgs_e = base_msgs + [{"role": "user", "content": "Call set_plan now."}]
    names = call_anthropic(headers, {
        "model": "claude-sonnet-4-6",
        "system": system_mandatory,
        "messages": msgs_e,
        "tools": native_tools,
        "tool_choice": {"type": "auto"},
        "max_tokens": 4096,
    }, "Strategy E: System prompt says set_plan is MANDATORY + nudge")
    results["E: mandatory system prompt"] = names

    # Summary
    print(f"\n\n{'='*60}")
    print(f"  SUMMARY")
    print(f"{'='*60}")
    for label, names in results.items():
        has_set_plan = "set_plan" in (names or [])
        print(f"  {'✓' if has_set_plan else '✗'} {label}: {names}")


if __name__ == "__main__":
    main()
