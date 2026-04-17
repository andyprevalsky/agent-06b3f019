"""
Debug script: Replicate the exact plan-phase request sent to Anthropic via claudeAuth
and iterate until we get a set_plan tool call.

This bypasses the Rose API and calls Anthropic directly to see exactly what happens.
"""

import json
import os
import subprocess
import sys

import httpx

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from helpers.llm import prepare_schema_for_openai
from utils.tool_schemas import PLAN_PHASE_TOOLS, create_agent_action_model


def get_claude_token() -> str:
    raw = subprocess.check_output(
        ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
        stderr=subprocess.DEVNULL,
        text=True,
    ).strip()
    parsed = json.loads(raw)
    return parsed["claudeAiOauth"]["accessToken"]


def extract_native_tools(schema: dict):
    """Same logic as extractToolsFromResponseFormat in index.ts"""
    any_of = schema.get("properties", {}).get("tool_calls", {}).get("items", {}).get("anyOf", [])
    tools = []
    for variant in any_of:
        tool_name = variant["properties"]["tool"]["const"]
        description = variant.get("description", "")
        input_props = {k: v for k, v in variant["properties"].items() if k != "tool"}
        required = [r for r in variant.get("required", []) if r != "tool"]
        input_schema = {
            "type": "object",
            "properties": input_props,
            "required": required,
        }
        if "additionalProperties" in variant:
            input_schema["additionalProperties"] = variant["additionalProperties"]
        tools.append({
            "name": tool_name,
            "description": description,
            "input_schema": input_schema,
        })
    return tools


def main():
    token = get_claude_token()
    print(f"Token: {token[:20]}...")

    # Build the exact schema the agent sends for plan phase
    model_cls = create_agent_action_model(PLAN_PHASE_TOOLS)
    schema = prepare_schema_for_openai(model_cls)
    native_tools = extract_native_tools(schema)

    print(f"\n=== NATIVE TOOLS ({len(native_tools)}) ===")
    for t in native_tools:
        props = list(t["input_schema"]["properties"].keys())
        print(f"  {t['name']}: props={props}")
        print(f"    desc: {t['description'][:120]}")

    # Print full tool schemas
    print(f"\n=== FULL TOOL SCHEMAS ===")
    print(json.dumps(native_tools, indent=2)[:3000])

    # System prompt - simplified plan phase prompt
    system_prompt = """You are a super-intelligent autonomous system (SIAS). Your goal is to plan and execute tasks.

# Phase
PLAN - Research and gather context, then create an execution plan.

STATE MACHINE:
NODE: RESEARCH (start)
ENABLED TOOLS: web_search, web_fetch, send_message_to_user
To progress: call set_plan to move to SET_PLAN, or attempt_completion to EXIT.

NODE: SET_PLAN
Call set_plan when you have enough context and are ready to create an execution plan.

NODE: EXIT
Call attempt_completion when done.

TWO-AXIS PLANNING:
- If uncertainty > decomposability -> stay in RESEARCH
- If decomposability >= uncertainty -> proceed to SET_PLAN

# Output Format

Write your thinking/reasoning as plain text, then call tools.
Your text output is shown to the user as your reasoning. Do not output JSON.
If your previous turn did not include a tool call, you MUST call a tool in this turn to progress towards solving your goal autonomously."""

    messages = [
        {
            "role": "user",
            "content": "Find the best Italian restaurant in San Francisco and make a reservation for 2 people tonight at 7pm."
        }
    ]

    # Build the Anthropic request
    body = {
        "model": "claude-sonnet-4-6",
        "system": system_prompt,
        "messages": messages,
        "tools": native_tools,
        "tool_choice": {"type": "auto"},
        "max_tokens": 4096,
    }

    print(f"\n=== REQUEST (tools: {len(native_tools)}, tool_choice: auto) ===")
    print(f"System prompt length: {len(system_prompt)}")
    print(f"Messages: {len(messages)}")

    # Call Anthropic directly
    print(f"\n=== CALLING ANTHROPIC DIRECTLY ===")
    resp = httpx.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "Authorization": f"Bearer {token}",
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "oauth-2025-04-20,claude-code-20250219,prompt-caching-scope-2026-01-05",
            "x-app": "cli",
            "User-Agent": "claude-cli/2.1.45 (external, rose-planner)",
            "content-type": "application/json",
        },
        json=body,
        timeout=120.0,
    )

    if resp.status_code != 200:
        print(f"ERROR {resp.status_code}: {resp.text[:500]}")
        return

    data = resp.json()
    print(f"\nStop reason: {data.get('stop_reason')}")
    print(f"Usage: {data.get('usage')}")

    print(f"\n=== RESPONSE CONTENT BLOCKS ===")
    for i, block in enumerate(data.get("content", [])):
        btype = block.get("type")
        if btype == "text":
            print(f"  [{i}] TEXT ({len(block['text'])} chars): {block['text'][:200]}")
        elif btype == "tool_use":
            print(f"  [{i}] TOOL_USE: {block['name']}")
            print(f"       input: {json.dumps(block['input'])[:200]}")
        else:
            print(f"  [{i}] {btype}: {json.dumps(block)[:200]}")

    # Check if set_plan was called
    tool_calls = [b for b in data.get("content", []) if b.get("type") == "tool_use"]
    tool_names = [t["name"] for t in tool_calls]
    print(f"\n=== TOOL CALLS: {tool_names} ===")

    if "set_plan" in tool_names:
        print("SUCCESS: set_plan was called!")
    else:
        print(f"MISS: set_plan not called. Tools called: {tool_names}")

    # Now try with tool_choice: any
    print(f"\n\n{'='*60}")
    print(f"=== RETRY WITH tool_choice: any ===")
    print(f"{'='*60}")

    body["tool_choice"] = {"type": "any"}
    resp2 = httpx.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "Authorization": f"Bearer {token}",
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "oauth-2025-04-20,claude-code-20250219,prompt-caching-scope-2026-01-05",
            "x-app": "cli",
            "User-Agent": "claude-cli/2.1.45 (external, rose-planner)",
            "content-type": "application/json",
        },
        json=body,
        timeout=120.0,
    )

    if resp2.status_code != 200:
        print(f"ERROR {resp2.status_code}: {resp2.text[:500]}")
        return

    data2 = resp2.json()
    print(f"\nStop reason: {data2.get('stop_reason')}")

    print(f"\n=== RESPONSE CONTENT BLOCKS ===")
    for i, block in enumerate(data2.get("content", [])):
        btype = block.get("type")
        if btype == "text":
            print(f"  [{i}] TEXT ({len(block['text'])} chars): {block['text'][:200]}")
        elif btype == "tool_use":
            print(f"  [{i}] TOOL_USE: {block['name']}")
            print(f"       input: {json.dumps(block['input'])[:200]}")

    tool_calls2 = [b for b in data2.get("content", []) if b.get("type") == "tool_use"]
    tool_names2 = [t["name"] for t in tool_calls2]
    print(f"\n=== TOOL CALLS: {tool_names2} ===")

    # Now try asking it to call set_plan specifically
    print(f"\n\n{'='*60}")
    print(f"=== TEST: Ask to call set_plan explicitly ===")
    print(f"{'='*60}")

    messages_set_plan = [
        {
            "role": "user",
            "content": "Find the best Italian restaurant in San Francisco and make a reservation for 2 people tonight at 7pm."
        },
        {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "I have enough context. Let me create the plan now."},
                {
                    "type": "tool_use",
                    "id": "tool_1",
                    "name": "web_search",
                    "input": {"query": "best Italian restaurant San Francisco reservations"},
                },
            ],
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "tool_1",
                    "content": "Top results: 1. Flour+Water (highly rated, Mission District) 2. Cotogna (Italian fine dining, Jackson Square) 3. Delfina (classic Italian, Mission)",
                }
            ],
        },
        {
            "role": "user",
            "content": "You have enough context now. Call set_plan to create the execution plan.",
        },
    ]

    body3 = {
        "model": "claude-sonnet-4-6",
        "system": system_prompt,
        "messages": messages_set_plan,
        "tools": native_tools,
        "tool_choice": {"type": "auto"},
        "max_tokens": 4096,
    }

    resp3 = httpx.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "Authorization": f"Bearer {token}",
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "oauth-2025-04-20,claude-code-20250219,prompt-caching-scope-2026-01-05",
            "x-app": "cli",
            "User-Agent": "claude-cli/2.1.45 (external, rose-planner)",
            "content-type": "application/json",
        },
        json=body3,
        timeout=120.0,
    )

    if resp3.status_code != 200:
        print(f"ERROR {resp3.status_code}: {resp3.text[:500]}")
        return

    data3 = resp3.json()
    print(f"\nStop reason: {data3.get('stop_reason')}")

    for i, block in enumerate(data3.get("content", [])):
        btype = block.get("type")
        if btype == "text":
            print(f"  [{i}] TEXT ({len(block['text'])} chars): {block['text'][:200]}")
        elif btype == "tool_use":
            print(f"  [{i}] TOOL_USE: {block['name']}")
            print(f"       input: {json.dumps(block['input'])[:200]}")

    tool_calls3 = [b for b in data3.get("content", []) if b.get("type") == "tool_use"]
    tool_names3 = [t["name"] for t in tool_calls3]
    print(f"\n=== TOOL CALLS: {tool_names3} ===")

    if "set_plan" in tool_names3:
        print("SUCCESS: set_plan was called!")
    else:
        print(f"MISS: set_plan not called. Tools called: {tool_names3}")


if __name__ == "__main__":
    main()
