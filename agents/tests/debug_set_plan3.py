"""
Debug: Verify phase-aware nudge makes the model call set_plan instead of send_message_to_user.
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

    # OLD nudge (generic — model picks send_message_to_user)
    old_nudge = 'You did not call any tools in your previous turn. You MUST call a tool now to make progress towards completing your task autonomously. Do not respond with only text.'

    # NEW nudge (phase-aware — tells model to call set_plan)
    new_nudge = old_nudge + '\n\nIf you have gathered enough context, call set_plan to proceed to plan generation. If you need more information, call web_search or web_fetch. You MUST call one of these tools now.'

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
        # Model produces text-only response (the stuck behavior)
        {"role": "assistant", "content": [
            {"type": "text", "text": "I have enough context to proceed. Let me plan this out and execute."},
        ]},
    ]

    results = {}

    # Test with OLD generic nudge (3 runs to check consistency)
    for i in range(3):
        msgs = base_msgs + [{"role": "user", "content": old_nudge}]
        names = call_anthropic(headers, {
            "model": "claude-sonnet-4-6",
            "system": SYSTEM,
            "messages": msgs,
            "tools": native_tools,
            "tool_choice": {"type": "auto"},
            "max_tokens": 4096,
        }, f"OLD nudge (generic) — run {i+1}/3")
        results.setdefault("old", []).append(names or [])

    # Test with NEW phase-aware nudge (3 runs)
    for i in range(3):
        msgs = base_msgs + [{"role": "user", "content": new_nudge}]
        names = call_anthropic(headers, {
            "model": "claude-sonnet-4-6",
            "system": SYSTEM,
            "messages": msgs,
            "tools": native_tools,
            "tool_choice": {"type": "auto"},
            "max_tokens": 4096,
        }, f"NEW nudge (phase-aware) — run {i+1}/3")
        results.setdefault("new", []).append(names or [])

    # Summary
    print(f"\n\n{'='*60}")
    print(f"  SUMMARY")
    print(f"{'='*60}")
    for label, runs in results.items():
        set_plan_count = sum(1 for r in runs if "set_plan" in r)
        print(f"  {label} nudge: set_plan called {set_plan_count}/3 runs")
        for i, r in enumerate(runs):
            print(f"    run {i+1}: {r}")


if __name__ == "__main__":
    main()
