#!/usr/bin/env python3
"""Replay a saved LLM dump against the current local Rose client."""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
AGENTS_DIR = REPO_ROOT / "agents"
sys.path.insert(0, str(AGENTS_DIR))

from providers.rose import RoseClient, gpt_auth_from_token  # noqa: E402
from providers.rose.browser_use import build_browser_use_messages, normalize_browser_use_tool_call  # noqa: E402
from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY  # noqa: E402


LEGACY_BROWSER_DYNAMIC_RULE_RE = re.compile(
    r"^Your browser is in full screen mode\..*?complete your directed goal\.\s*",
    re.S,
)


def load_dump(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise SystemExit(f"Expected top-level JSON object in {path}")
    return data


def remove_goal_text(data: dict[str, Any], needles: list[str]) -> None:
    if not needles:
        return
    messages = data.get("messages")
    if not isinstance(messages, list):
        return
    for message in messages:
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        content = message.get("content")
        if not isinstance(content, str) or not content.startswith("# Current Goal"):
            continue
        for needle in needles:
            content = content.replace(needle, "")
        message["content"] = re.sub(r"\s{2,}", " ", content).replace("# Current Goal ", "# Current Goal\n").strip()
        return


def split_system(content: str) -> tuple[str, str]:
    if SYSTEM_PROMPT_DYNAMIC_BOUNDARY in content:
        static, dynamic = content.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY, 1)
        return static.strip(), dynamic.strip()
    marker = SYSTEM_PROMPT_DYNAMIC_BOUNDARY.strip()
    if marker in content:
        static, dynamic = content.split(marker, 1)
        return static.strip(), dynamic.strip()
    return content.strip(), ""


def normalize_payment_context(dynamic: str) -> str:
    if "## Autopay" not in dynamic or "## Payment Rules" not in dynamic or "## Billing Address" not in dynamic:
        return dynamic

    autopay_match = re.search(r"\n## Autopay\n(.*?)(?=\n## Billing Address\n)", dynamic, re.S)
    billing_match = re.search(r"\n## Billing Address\n(.*?)(?=\n## Payment Rules\n)", dynamic, re.S)
    rules_match = re.search(r"\n## Payment Rules\n(.*?)(?=\n# |\Z)", dynamic, re.S)
    if not autopay_match or not billing_match or not rules_match:
        return dynamic

    autopay = autopay_match.group(1).strip()
    billing = billing_match.group(1).strip()
    rules = "\n".join(
        line
        for line in rules_match.group(1).strip().splitlines()
        if "Always verify the total before entering card details" not in line
        and "Double-check the billing address matches before submitting" not in line
    ).strip()
    replacement = f"\n## Billing Address\n{billing}\n\n## Payment Information\n{autopay}"
    if rules:
        replacement += f"\n\n{rules}"

    start = autopay_match.start()
    end = rules_match.end()
    return dynamic[:start] + replacement + dynamic[end:]


def normalize_dynamic_context_for_current_code(dynamic: str) -> str:
    dynamic = LEGACY_BROWSER_DYNAMIC_RULE_RE.sub("", dynamic.strip()).strip()
    dynamic = normalize_payment_context(dynamic)
    return dynamic.strip()


def browser_replay_inputs(data: dict[str, Any]) -> dict[str, Any]:
    messages = data.get("messages")
    if not isinstance(messages, list) or len(messages) < 3:
        raise SystemExit("Browser-use replay requires a dump with at least system, goal, and state messages.")

    system_message = messages[0] if isinstance(messages[0], dict) else {}
    _, dynamic_system_context = split_system(str(system_message.get("content") or ""))
    dynamic_system_context = normalize_dynamic_context_for_current_code(dynamic_system_context)

    non_system = [message for message in messages if isinstance(message, dict) and message.get("role") != "system"]
    task = str((non_system[0] if non_system else {}).get("content") or "")
    turn_messages = non_system[1:-1]
    extra = data.get("extra") if isinstance(data.get("extra"), dict) else {}
    config = data.get("config") if isinstance(data.get("config"), dict) else {}
    browser_state = extra.get("browser_state") if isinstance(extra.get("browser_state"), dict) else {}
    action_history = extra.get("action_history") if isinstance(extra.get("action_history"), list) else []
    available_actions = config.get("available_actions") if isinstance(config.get("available_actions"), list) else []
    if not available_actions:
        available_actions = (extra.get("available_actions") if isinstance(extra.get("available_actions"), list) else [])
    return {
        "task": task,
        "dynamic_system_context": dynamic_system_context,
        "turn_messages": turn_messages,
        "browser_state": browser_state,
        "action_history": action_history,
        "available_actions": available_actions,
    }


def gpt_auth_from_dump(data: dict[str, Any]) -> Any:
    output = data.get("output") if isinstance(data.get("output"), dict) else {}
    usage = output.get("usage") if isinstance(output.get("usage"), dict) else {}
    token_used = usage.get("compute_token_used") if isinstance(usage.get("compute_token_used"), dict) else {}
    if token_used.get("type") != "gpt" or not token_used.get("accessToken"):
        return None
    return gpt_auth_from_token(
        str(token_used.get("accessToken")),
        account_id=token_used.get("accountId"),
    )


async def replay_browser_use(data: dict[str, Any], *, exact: bool) -> dict[str, Any]:
    config = data.get("config") if isinstance(data.get("config"), dict) else {}
    call_site = f"replicate_{data.get('call_site') or 'browser_use'}"
    client = RoseClient()
    gpt_auth = gpt_auth_from_dump(data)

    if exact:
        messages = data.get("messages") or []
        tools = data.get("tools") or config.get("tools") or []
        response = await client.collect(
            pool="rose-1-browser-use",
            messages=messages,
            tools=tools,
            tool_choice=config.get("tool_choice") or "any",
            max_tokens=config.get("max_tokens") or 16000,
            temperature=config.get("temperature") if config.get("temperature") is not None else 1.0,
            gpt_auth=gpt_auth,
            agent_id=data.get("agent_id"),
            call_site=call_site,
        )
        action = normalize_browser_use_tool_call(response.tool_calls[0]) if response.tool_calls else None
        return {
            "action": action,
            "actual_model": response.actual_model,
            "usage": response.usage,
            "timing": response.timing,
            "request_id": response.request_id,
        }

    inputs = browser_replay_inputs(data)
    result = await client.complete_browser_use(
        task=inputs["task"],
        browser_state=inputs["browser_state"],
        action_history=inputs["action_history"],
        available_actions=inputs["available_actions"],
        include_screenshot=False,
        dynamic_system_context=inputs["dynamic_system_context"],
        turn_messages=inputs["turn_messages"],
        gpt_auth=gpt_auth,
        agent_id=data.get("agent_id"),
        call_site=call_site,
        dump_extra={
            "replicated_from": data.get("call_site"),
            "replication_mode": "rebuilt_browser_use_current_code",
        },
    )
    return result


async def main_async(args: argparse.Namespace) -> int:
    data = load_dump(args.dump)
    remove_goal_text(data, args.remove_goal_text or [])
    call_site = str(data.get("call_site") or "")
    if "browser_use" not in call_site:
        raise SystemExit("Only browser_use dumps are supported right now.")
    result = await replay_browser_use(data, exact=args.exact)
    printable = json.loads(json.dumps(result, default=str))
    usage = printable.get("usage") if isinstance(printable, dict) else None
    token_used = usage.get("compute_token_used") if isinstance(usage, dict) else None
    if isinstance(token_used, dict) and token_used.get("accessToken"):
        token_used["accessToken"] = "[redacted]"
    print(json.dumps(printable, indent=2, default=str))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Replay a saved LLM dump.")
    parser.add_argument("dump", type=Path)
    parser.add_argument(
        "--exact",
        action="store_true",
        help="Send the provider messages exactly as stored instead of rebuilding browser-use messages with current code.",
    )
    parser.add_argument(
        "--remove-goal-text",
        action="append",
        default=[],
        help="Remove this exact text from the # Current Goal user message before replaying. Can be repeated.",
    )
    return parser.parse_args()


def main() -> int:
    return asyncio.run(main_async(parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
