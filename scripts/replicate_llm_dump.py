#!/usr/bin/env python3
"""Replay a saved LLM dump against the current local Rose client.

Supports:
  - browser_use dumps (legacy)
  - planner dumps (structured PlannerResponse)
  - generic dumps with messages + optional response_format / response_model

Modes:
  --mode exact           Send dump messages as stored (baseline for /update-prompts)
  --mode rebuild-system  For planner dumps: rebuild system prompt via
                         build_planner_system_prompt() while keeping non-system
                         messages from the dump (post-edit check)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Optional

REPO_ROOT = Path(__file__).resolve().parents[1]
AGENTS_DIR = REPO_ROOT / "agents"
sys.path.insert(0, str(AGENTS_DIR))

# Load agents/.env so Rose / compute tokens resolve in cloud VMs.
_env_path = AGENTS_DIR / ".env"
if _env_path.is_file():
    for line in _env_path.read_text().splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value

from providers.rose import RoseClient, gpt_auth_from_token  # noqa: E402
from providers.rose.browser_use import build_browser_use_messages, normalize_browser_use_tool_call  # noqa: E402
from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY, build_planner_system_prompt  # noqa: E402
from utils.tool_schemas import PlannerResponse  # noqa: E402


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
        available_actions = extra.get("available_actions") if isinstance(extra.get("available_actions"), list) else []
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


def _pool_from_dump(data: dict[str, Any]) -> str:
    config = data.get("config") if isinstance(data.get("config"), dict) else {}
    pool = config.get("pool") or data.get("model") or "rose-1-ultra"
    # Dumps sometimes store "rose-labs/rose-1-ultra" — Rose pools are bare names.
    if isinstance(pool, str) and "/" in pool:
        pool = pool.rsplit("/", 1)[-1]
    return str(pool)


def _planner_tool_counts(plan: dict[str, Any]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for task in plan.get("tasks") or []:
        if not isinstance(task, dict):
            continue
        name = str(task.get("tool_name") or "?")
        counts[name] = counts.get(name, 0) + 1
    return counts


def _extract_tools_description_from_dump(messages: list[dict[str, Any]]) -> str:
    marker = "## Available Execute Tool Schemas"
    for message in messages:
        if message.get("role") != "system":
            continue
        content = str(message.get("content") or "")
        if marker in content:
            # Keep the schemas block (after the intro paragraph if present).
            return content[content.index(marker) :]
    from domains.set_plan.service import get_planner_tools_description

    return get_planner_tools_description()


def _extract_user_context_from_dump(messages: list[dict[str, Any]]) -> str:
    for message in messages:
        if message.get("role") != "system":
            continue
        content = str(message.get("content") or "")
        if content.lstrip().startswith("# User Context"):
            body = content
            if body.startswith("# User Context"):
                body = body[len("# User Context") :].lstrip("\n")
            return body.strip()
    return ""


def _extract_response_schema_from_dump(messages: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    for message in messages:
        if message.get("role") != "system":
            continue
        content = str(message.get("content") or "")
        if "# Required Output Schema" not in content and "response_schema" not in content.lower():
            continue
        # Best-effort: leave None and let builder omit unless a JSON block is obvious.
    return None


def rebuild_planner_messages(data: dict[str, Any]) -> list[dict[str, Any]]:
    messages = data.get("messages") if isinstance(data.get("messages"), list) else []
    tools_description = _extract_tools_description_from_dump(messages)
    user_context = _extract_user_context_from_dump(messages)
    response_schema = _extract_response_schema_from_dump(messages)
    system_prompt = build_planner_system_prompt(tools_description, user_context, response_schema=response_schema)
    # Match runtime: one system message (builder already inserts boundary markers).
    non_system = [m for m in messages if isinstance(m, dict) and m.get("role") != "system"]
    return [{"role": "system", "content": system_prompt}] + non_system


def summarize_planner_plan(plan: dict[str, Any]) -> dict[str, Any]:
    tasks = plan.get("tasks") if isinstance(plan.get("tasks"), list) else []
    compact = []
    for task in tasks:
        if not isinstance(task, dict):
            continue
        compact.append(
            {
                "task_idx": task.get("task_idx"),
                "tool_name": task.get("tool_name"),
                "depends_on": task.get("depends_on"),
                "goal": (str(task.get("goal") or "")[:160] + ("…" if len(str(task.get("goal") or "")) > 160 else "")),
            }
        )
    return {
        "title": plan.get("title"),
        "join": plan.get("join"),
        "task_count": len(compact),
        "tool_counts": _planner_tool_counts(plan),
        "tasks": compact,
    }


def evaluate_assertions(plan: dict[str, Any], assertions: list[str]) -> list[dict[str, Any]]:
    """Evaluate simple planner assertions used by /update-prompts.

    Supported forms:
      min_tool:<name>:<n>
      max_tool:<name>:<n>
      exact_tool:<name>:<n>
      require_tool:<name>
      forbid_tool:<name>
    """
    counts = _planner_tool_counts(plan)
    results = []
    for raw in assertions:
        parts = raw.split(":")
        kind = parts[0]
        ok = False
        detail = ""
        if kind == "require_tool" and len(parts) == 2:
            name = parts[1]
            ok = counts.get(name, 0) >= 1
            detail = f"{name}={counts.get(name, 0)}"
        elif kind == "forbid_tool" and len(parts) == 2:
            name = parts[1]
            ok = counts.get(name, 0) == 0
            detail = f"{name}={counts.get(name, 0)}"
        elif kind in {"min_tool", "max_tool", "exact_tool"} and len(parts) == 3:
            name, n_s = parts[1], parts[2]
            n = int(n_s)
            got = counts.get(name, 0)
            if kind == "min_tool":
                ok = got >= n
            elif kind == "max_tool":
                ok = got <= n
            else:
                ok = got == n
            detail = f"{name}={got} (want {kind} {n})"
        else:
            detail = f"unknown assertion {raw!r}"
            ok = False
        results.append({"assertion": raw, "pass": ok, "detail": detail})
    return results


async def replay_browser_use(data: dict[str, Any], *, exact: bool) -> dict[str, Any]:
    config = data.get("config") if isinstance(data.get("config"), dict) else {}
    call_site = f"replicate_{data.get('call_site') or 'browser_use'}"
    client = RoseClient()
    gpt_auth = gpt_auth_from_dump(data)

    if exact:
        # Replay the call as recorded: its pool, tools, sampling params and
        # reasoning effort. A fixed browser pool without effort selects a
        # different model and cannot reproduce the original decision.
        effective = config.get("effective_params") if isinstance(config.get("effective_params"), dict) else {}
        requested = dict(config.get("requested_params") or {})
        for key in ("temperature", "max_tokens"):
            if requested.get(key) is None and effective.get(key) is not None:
                requested[key] = effective[key]
        requested.setdefault("tool_choice", config.get("tool_choice") or "any")
        recorded = {
            **data,
            "config": {
                **config,
                "requested_params": requested,
                "reasoning_effort": config.get("reasoning_effort") or effective.get("reasoning_effort"),
            },
        }
        result = await replay_generic(recorded)
        calls = result.get("tool_calls") or []
        result["action"] = normalize_browser_use_tool_call(calls[0]) if calls else None
        return result

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


async def replay_planner(data: dict[str, Any], *, mode: str, assertions: list[str]) -> dict[str, Any]:
    if mode == "rebuild-system":
        messages = rebuild_planner_messages(data)
        replication_mode = "rebuild-system"
    else:
        messages = data.get("messages") or []
        replication_mode = "exact"

    config = data.get("config") if isinstance(data.get("config"), dict) else {}
    requested = config.get("requested_params") if isinstance(config.get("requested_params"), dict) else {}
    client = RoseClient()
    response = await client.collect(
        pool=_pool_from_dump(data),  # type: ignore[arg-type]
        messages=messages,
        response_model=PlannerResponse,
        temperature=requested.get("temperature", 0.2),
        max_tokens=requested.get("max_tokens", 16384),
        agent_id=data.get("agent_id"),
        call_site=f"replicate_{data.get('call_site') or 'planner'}",
        dump_extra={
            "replicated_from": data.get("call_site"),
            "replication_mode": replication_mode,
        },
        skip_cache_write=True,
    )

    plan: dict[str, Any]
    try:
        plan = json.loads(response.content or "{}")
    except json.JSONDecodeError:
        plan = {"raw_content": response.content}

    summary = summarize_planner_plan(plan) if "tasks" in plan else {"parse_error": True, "raw": plan}
    assertion_results = evaluate_assertions(plan, assertions) if "tasks" in plan else []
    all_pass = all(r["pass"] for r in assertion_results) if assertion_results else None

    return {
        "call_site": data.get("call_site"),
        "replication_mode": replication_mode,
        "actual_model": response.actual_model,
        "usage": response.usage,
        "timing": response.timing,
        "request_id": response.request_id,
        "plan_summary": summary,
        "assertions": assertion_results,
        "assertions_pass": all_pass,
        "plan": plan,
    }


async def replay_generic(data: dict[str, Any]) -> dict[str, Any]:
    messages = data.get("messages") or []
    config = data.get("config") if isinstance(data.get("config"), dict) else {}
    requested = config.get("requested_params") if isinstance(config.get("requested_params"), dict) else {}
    client = RoseClient()
    kwargs = {
        "pool": _pool_from_dump(data),
        "messages": messages,
        "temperature": requested.get("temperature"),
        "max_tokens": requested.get("max_tokens") or 8192,
        "agent_id": data.get("agent_id"),
        "call_site": f"replicate_{data.get('call_site') or 'generic'}",
        "skip_cache_write": True,
    }
    if config.get("response_model") == "PlannerResponse" or data.get("call_site") == "planner":
        kwargs["response_model"] = PlannerResponse
    # Forward the dump's tool definitions. Without them the model is replayed
    # against a system prompt that advertises tools it cannot see, so it can
    # never emit a tool call and every tool-choice assertion fails for the
    # wrong reason (it narrates call syntax as prose instead).
    tools = data.get("tools") or config.get("tools") or []
    if tools:
        kwargs["tools"] = tools
        requested_choice = requested.get("tool_choice") or config.get("tool_choice")
        if requested_choice:
            kwargs["tool_choice"] = requested_choice
    # Replay on the transport the dump actually used. Falling through to the
    # OpenRouter waterfall silently swaps the provider, so a direct-auth
    # (claudeAuth/gptAuth) divergence cannot be reproduced at all.
    gpt_auth = gpt_auth_from_dump(data)
    if gpt_auth is not None:
        kwargs["gpt_auth"] = gpt_auth
    # Reasoning effort materially changes tool choice, so a replay that drops it
    # is not the same call. `collect()` cannot express it — it forwards a fixed
    # arg list to `complete()` — so stream `complete()` directly and accumulate
    # whenever the dump recorded an effort.
    effort = config.get("reasoning_effort")
    if effort:
        stream_kwargs = dict(kwargs)
        stream_kwargs.pop("skip_cache_write", None)
        stream_kwargs["effort"] = effort
        if requested.get("provider_fast_mode") is not None:
            stream_kwargs["provider_fast_mode"] = bool(requested["provider_fast_mode"])
        content_parts: list[str] = []
        tool_calls: list[dict[str, Any]] = []
        actual_model = None
        usage: dict[str, Any] = {}
        async for chunk in client.complete(**stream_kwargs):
            if chunk.kind == "metadata":
                actual_model = chunk.data.get("actual_model") or actual_model
            elif chunk.kind == "content":
                content_parts.append(str(chunk.data.get("text") or chunk.data.get("content") or ""))
            elif chunk.kind == "tool_call":
                tool_calls.append(chunk.data)
            elif chunk.kind == "usage":
                usage = chunk.data
        return {
            "call_site": data.get("call_site"),
            "actual_model": actual_model,
            "content": "".join(content_parts),
            "tool_calls": tool_calls,
            "usage": usage,
            "timing": {},
            "request_id": None,
        }
    response = await client.collect(**kwargs)  # type: ignore[arg-type]
    return {
        "call_site": data.get("call_site"),
        "actual_model": response.actual_model,
        "content": response.content,
        "tool_calls": response.tool_calls,
        "usage": response.usage,
        "timing": response.timing,
        "request_id": response.request_id,
    }


async def main_async(args: argparse.Namespace) -> int:
    data = load_dump(args.dump)
    remove_goal_text(data, args.remove_goal_text or [])
    call_site = str(data.get("call_site") or "")

    if "browser_use" in call_site:
        result = await replay_browser_use(data, exact=args.mode == "exact")
    elif call_site == "planner" or (isinstance(data.get("config"), dict) and data["config"].get("response_model") == "PlannerResponse"):
        result = await replay_planner(data, mode=args.mode, assertions=args.assert_ or [])
    else:
        if args.mode == "rebuild-system":
            raise SystemExit("--mode rebuild-system is only supported for planner dumps")
        result = await replay_generic(data)

    printable = json.loads(json.dumps(result, default=str))
    usage = printable.get("usage") if isinstance(printable, dict) else None
    token_used = usage.get("compute_token_used") if isinstance(usage, dict) else None
    if isinstance(token_used, dict) and token_used.get("accessToken"):
        token_used["accessToken"] = "[redacted]"

    # Human-friendly planner summary first when present.
    if isinstance(printable, dict) and printable.get("plan_summary"):
        print("=== PLAN SUMMARY ===")
        print(json.dumps(printable["plan_summary"], indent=2))
        if printable.get("assertions") is not None:
            print("=== ASSERTIONS ===")
            for row in printable["assertions"]:
                mark = "PASS" if row.get("pass") else "FAIL"
                print(f"  {mark}: {row.get('assertion')} ({row.get('detail')})")
            print(f"assertions_pass={printable.get('assertions_pass')}")
        print("=== RAW ===")
    print(json.dumps(printable, indent=2, default=str))

    if isinstance(printable, dict) and printable.get("assertions") and printable.get("assertions_pass") is False:
        return 2
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Replay a saved LLM dump.")
    parser.add_argument("dump", type=Path)
    parser.add_argument(
        "--mode",
        choices=("exact", "rebuild-system"),
        default="exact",
        help="exact = dump messages as stored; rebuild-system = current planner prompt builder (planner only)",
    )
    parser.add_argument(
        "--exact",
        action="store_true",
        help="Deprecated alias for --mode exact (browser_use).",
    )
    parser.add_argument(
        "--assert",
        dest="assert_",
        action="append",
        default=[],
        help="Planner assertion (repeatable): min_tool:NAME:N | max_tool:NAME:N | exact_tool:NAME:N | require_tool:NAME | forbid_tool:NAME",
    )
    parser.add_argument(
        "--remove-goal-text",
        action="append",
        default=[],
        help="Remove this exact text from the # Current Goal user message before replaying. Can be repeated.",
    )
    args = parser.parse_args()
    if args.exact:
        args.mode = "exact"
    return args


def main() -> int:
    return asyncio.run(main_async(parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
