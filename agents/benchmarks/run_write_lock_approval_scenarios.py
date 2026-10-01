#!/usr/bin/env python3
"""Write-lock approval replay: does the agent reach the commit click that raises approval?

The browser write lock intercepts final commit clicks (Place order, Send, Post,
Confirm return) and asks the user before replaying them. That interception is
the only approval path; there is no approval tool. Prod agent 5c8b0ca4 stalled
because its goal said "request human approval before placing the order" and the
browser agent, not knowing the click is the request, stopped at the review page.

Each scenario in ``write_lock_approval_scenarios.json`` rebuilds that decision
point with production code (system prompt, dynamic context, turn history, the
rose-1-browser-use pool) and lets the real model act:

  * observe-only actions (read_browser_state, evaluate, screenshot, scroll, wait,
    ...) get canned results and the model continues, up to MAX_STEPS turns
  * the first state-changing action decides the trial: a click on a commit index
    passes; attempt_completion, other clicks, navigation, etc. fail
  * ``kind: planner`` scenarios first run the real planner on the root goal, and
    ``kind: execute`` scenarios first run the real EXECUTE main-loop call after a
    failed browser task; the browser goal that parent writes is then replayed
    at the checkout page
  * ``expect: no_commit`` scenarios are controls (write lock off): a commit click
    fails them, because nothing would ask the user before the order is placed

The browser pool samples at temperature 1.0 and its providers drift, so
per-scenario rates swing by 20+ points between 10-trial runs. The run passes
when the pooled pass rate over every trial is at least ``--min-pass-rate`` and
no scenario falls below ``--scenario-floor``. Pre- and post-fix prompts run
concurrently (10 trials per scenario): 14/60 pooled before the write-lock
prompts, 47/60 after; other post-fix runs pooled 0.78 to 0.87.

Usage:
    cd agents && python benchmarks/run_write_lock_approval_scenarios.py [--only name,name] [--trials 10]
        [--min-pass-rate 0.65] [--scenario-floor 0.4]
Outputs:
    agents/benchmarks/runs/write-lock-approval-<ts>.json
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

AGENTS_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(AGENTS_ROOT))

SCENARIOS_PATH = AGENTS_ROOT / "benchmarks" / "write_lock_approval_scenarios.json"
RUNS_DIR = AGENTS_ROOT / "benchmarks" / "runs"
PLANNER_MODEL = os.environ.get("WRITE_LOCK_SCENARIO_PLANNER_MODEL", "rose-labs/rose-1-ultra")
EXECUTE_MODEL = os.environ.get("WRITE_LOCK_SCENARIO_EXECUTE_MODEL", "rose-labs/rose-1-flash")
MAX_STEPS = 5
STEP_DEADLINE_S = 120.0
OBSERVE_ACTIONS = {
    "read_browser_state",
    "screenshot",
    "evaluate",
    "scroll",
    "wait",
    "read_logs",
    "read_network_requests",
    "dropdown_options",
}
PAGE_STATE_KEYS = ("url", "title", "timestamp", "viewport", "scroll_position", "page_stats", "tabs", "dom_tree")


def load_fixture() -> dict[str, Any]:
    data = json.loads(SCENARIOS_PATH.read_text(encoding="utf-8"))
    by_name = {scenario["name"]: scenario for scenario in data["scenarios"]}
    for scenario in data["scenarios"]:
        if "goal_from" in scenario:
            scenario["goal"] = by_name[scenario["goal_from"]]["goal"]
    return data


def check_fixture(data: dict[str, Any]) -> list[str]:
    """Every commit index must exist in its page and be a real write-lock purchase control."""
    from browser_tools.write_lock import is_purchase_button

    problems: list[str] = []
    for name, page in data["pages"].items():
        for index in page["commit_indexes"]:
            label = page["commit_labels"][str(index)]
            if f"[{index}]<" not in page["dom_tree"]:
                problems.append(f"{name}: commit index {index} missing from dom_tree")
            if not is_purchase_button(label):
                problems.append(f"{name}: commit label {label!r} is not write-locked by is_purchase_button")
    for scenario in data["scenarios"]:
        if scenario["page"] not in data["pages"]:
            problems.append(f"{scenario['name']}: unknown page {scenario['page']}")
        if scenario["kind"] == "execute" and not data.get("execute_context"):
            problems.append(f"{scenario['name']}: execute scenario needs execute_context")
    return problems


def _page_text(dom_tree: str) -> str:
    """Visible text of the fixture page, the closest static stand-in for an evaluate() result."""
    lines = (line.strip() for line in dom_tree.splitlines())
    return "\n".join(line for line in lines if line and not re.fullmatch(r"\*?(\[\d+\])?<[^>]*/>", line))


def _observe_result(action: dict[str, Any], page: dict[str, Any], formatted_state: str) -> dict[str, Any]:
    name = action.get("action")
    if name == "read_browser_state":
        return {"success": True, "message": "Browser state captured.", "formatted_state": formatted_state}
    if name == "evaluate":
        value = _page_text(page["dom_tree"])
        return {"success": True, "message": f"Executed JS, result: {value}", "value": value}
    if name == "screenshot":
        return {
            "success": False,
            "error": "Screenshot is unavailable in this replay; read_browser_state reflects the current page.",
        }
    if name == "dropdown_options":
        return {"success": False, "error": "No dropdown options for that element."}
    if name in {"read_logs", "read_network_requests"}:
        return {"success": True, "message": "No entries."}
    return {"success": True, "message": ""}


def _action_index(action: dict[str, Any]) -> Optional[int]:
    raw = action.get("index")
    if raw is None:
        raw = (action.get("params") or {}).get("index")
    try:
        return int(raw) if raw is not None else None
    except (TypeError, ValueError):
        return None


async def replay_browser(
    goal: str,
    page: dict[str, Any],
    *,
    custom_instructions: str,
    response_schema: dict[str, Any],
    write_lock_enabled: bool = True,
) -> dict[str, Any]:
    """Run the browser model from the checkout page until its first state-changing action."""
    from browser_tools.schemas import AVAILABLE_ACTIONS, BrowserToolArgsValidationError
    from domains.spawn_browser_agent_v3.handler import _append_browser_turn_messages
    from domains.spawn_browser_agent_v3.service import build_browser_dynamic_system_context, build_browser_task_prompt
    from providers.rose.browser_use import format_browser_state_for_tool
    from providers.rose.client import RoseClient

    formatted_state = format_browser_state_for_tool({key: page[key] for key in PAGE_STATE_KEYS})
    turns: list[dict[str, Any]] = []
    for prior in page["prior_turns"]:
        _append_browser_turn_messages(
            turns, unified_action=prior, result=prior["result"], tool_call_id=f"call_{uuid.uuid4().hex[:12]}"
        )
    _append_browser_turn_messages(
        turns,
        unified_action={"action": "read_browser_state", "thinking": "Let me check the current page.", "params": {}},
        result={"success": True, "message": "Browser state captured.", "formatted_state": formatted_state},
        tool_call_id=f"call_{uuid.uuid4().hex[:12]}",
    )
    dynamic_context = build_browser_dynamic_system_context(
        custom_instructions, response_schema=response_schema, write_lock_enabled=write_lock_enabled
    )
    task = build_browser_task_prompt(goal)
    client = RoseClient()
    commit_indexes = set(page["commit_indexes"])
    steps: list[dict[str, Any]] = []
    for _ in range(MAX_STEPS):
        try:
            llm = await client.complete_browser_use(
                task=task,
                browser_state={},
                action_history=[],
                available_actions=AVAILABLE_ACTIONS,
                dynamic_system_context=dynamic_context,
                turn_messages=turns,
                call_site="write_lock_approval_replay",
                deadline_s=STEP_DEADLINE_S,
                skip_cache_write=True,
            )
        except BrowserToolArgsValidationError as rejected:
            steps.append(
                {
                    "action": rejected.tool_name,
                    "index": None,
                    "params": rejected.tool_args,
                    "thinking": str(rejected.thinking or "")[:1500],
                    "rejected": rejected.detail,
                }
            )
            return {"verdict": f"stopped:{rejected.tool_name}", "steps": steps}
        action = llm["action"]
        name = str(action.get("action") or "")
        index = _action_index(action)
        steps.append(
            {
                "action": name,
                "index": index,
                "params": action.get("params"),
                "model": llm.get("actual_model"),
                "thinking": str(action.get("thinking") or "")[:1500],
            }
        )
        if name == "click" and index in commit_indexes:
            return {"verdict": "commit_click", "steps": steps}
        if name not in OBSERVE_ACTIONS:
            return {"verdict": f"stopped:{name}", "steps": steps}
        _append_browser_turn_messages(
            turns,
            unified_action=action,
            result=_observe_result(action, page, formatted_state),
            tool_call_id=f"call_{uuid.uuid4().hex[:12]}",
        )
    return {"verdict": "step_budget", "steps": steps}


def _checkout_browser_goal(plan: dict[str, Any]) -> Optional[str]:
    tasks = [t for t in plan.get("tasks") or [] if isinstance(t, dict)]
    browser = [
        str(t.get("goal") or "")
        for t in tasks
        if str(getattr(t.get("tool_name"), "value", t.get("tool_name")) or "") == "spawn_browser_agent"
    ]
    for goal in reversed(browser):
        if any(word in goal.lower() for word in ("checkout", "place the order", "place order", "purchase")):
            return goal
    return browser[-1] if browser else None


async def plan_browser_goal(goal: str, response_schema: dict[str, Any]) -> dict[str, Any]:
    """Real planner call (no Temporal); returns the checkout spawn_browser_agent goal it wrote."""
    from domains.set_plan.service import get_planner_tools_description
    from helpers.llm import call_planner_llm_activity

    result = await call_planner_llm_activity(
        [{"role": "user", "content": f"GOAL: {goal}\n\nPlan this goal into tasks."}],
        PLANNER_MODEL,
        get_planner_tools_description(),
        "",
        response_schema=response_schema,
    )
    plan = result.get("result") or {}
    return {"browser_goal": _checkout_browser_goal(plan), "plan": plan}


async def respawn_browser_goal(context: list[dict[str, Any]], response_schema: dict[str, Any]) -> dict[str, Any]:
    """Real EXECUTE main-loop call after a failed browser task; returns the browser goal it respawns with."""
    from helpers.llm import build_llm_messages, call_llm_activity
    from utils.prompts import build_system_prompt
    from utils.tool_schemas import EXECUTE_PHASE_TOOLS

    system_prompt = build_system_prompt("EXECUTE", list(EXECUTE_PHASE_TOOLS), response_schema=response_schema)
    messages = await build_llm_messages(context, system_prompt)
    result = await call_llm_activity(
        messages,
        EXECUTE_MODEL,
        list(EXECUTE_PHASE_TOOLS),
        reasoning_max_tokens=2048,
        call_site="write_lock_approval_execute_replay",
        skip_cache_write=True,
    )
    calls = [tc for tc in result.get("tool_calls") or [] if isinstance(tc, dict)]
    browser = [
        str(tc.get("goal") or "")
        for tc in calls
        if tc.get("tool") == "spawn_browser_agent" or (tc.get("tool") == "spawn_agent" and tc.get("type") == "browser")
    ]
    return {"browser_goal": browser[0] if browser else None, "tools": [tc.get("tool") for tc in calls]}


async def run_trial(scenario: dict[str, Any], data: dict[str, Any]) -> dict[str, Any]:
    page = data["pages"][scenario["page"]]
    expect = scenario.get("expect", "commit")
    started = time.perf_counter()
    trial: dict[str, Any] = {}
    try:
        goal = scenario["goal"]
        if scenario["kind"] == "planner":
            planned = await plan_browser_goal(goal, data["response_schema"])
            trial["parent_browser_goal"] = planned["browser_goal"]
            trial["parent_tools"] = [
                str(getattr(t.get("tool_name"), "value", t.get("tool_name")))
                for t in planned["plan"].get("tasks") or []
                if isinstance(t, dict)
            ]
            if not planned["browser_goal"]:
                trial.update(verdict="no_browser_task", passed=False)
                return trial
            goal = planned["browser_goal"]
        elif scenario["kind"] == "execute":
            respawn = await respawn_browser_goal(data["execute_context"], data["response_schema"])
            trial["parent_browser_goal"] = respawn["browser_goal"]
            trial["parent_tools"] = respawn["tools"]
            if not respawn["browser_goal"]:
                trial.update(verdict="no_browser_task", passed=False)
                return trial
            goal = respawn["browser_goal"]
        replay = await replay_browser(
            goal,
            page,
            custom_instructions=data["custom_instructions"],
            response_schema=data["response_schema"],
            write_lock_enabled=scenario.get("write_lock_enabled", True),
        )
        trial.update(replay)
        committed = replay["verdict"] == "commit_click"
        trial["passed"] = committed if expect == "commit" else not committed
    except Exception as exc:
        trial.update(verdict="error", passed=False, error=f"{type(exc).__name__}: {str(exc)[:300]}")
    finally:
        trial["elapsed_s"] = round(time.perf_counter() - started, 1)
    return trial


async def run_scenario(
    scenario: dict[str, Any],
    data: dict[str, Any],
    *,
    trials: int,
    scenario_floor: float,
    semaphore: asyncio.Semaphore,
) -> dict[str, Any]:
    async def one() -> dict[str, Any]:
        async with semaphore:
            return await run_trial(scenario, data)

    results = list(await asyncio.gather(*(one() for _ in range(max(1, trials)))))
    passes = sum(1 for r in results if r.get("passed"))
    passed = passes >= scenario_floor * len(results)
    verdicts = [r.get("verdict") for r in results]
    print(
        f"  {'✅' if passed else '❌'} {scenario['name']:34} {passes}/{len(results)} "
        f"expect={scenario.get('expect', 'commit')} verdicts={verdicts}",
        flush=True,
    )
    return {
        "name": scenario["name"],
        "kind": scenario["kind"],
        "page": scenario["page"],
        "expect": scenario.get("expect", "commit"),
        "write_lock_enabled": scenario.get("write_lock_enabled", True),
        "passed": passed,
        "passes": passes,
        "trials": results,
    }


def _browser_prompt_fingerprint() -> str:
    from browser_tools.schemas import AVAILABLE_ACTIONS
    from providers.rose.browser_use import build_browser_use_system_prompt

    return hashlib.sha256(build_browser_use_system_prompt(AVAILABLE_ACTIONS).encode("utf-8")).hexdigest()[:12]


async def main_async(args: argparse.Namespace) -> int:
    os.environ.setdefault("TRACE_ARCHIVE_ENABLED", "0")
    data = load_fixture()
    problems = check_fixture(data)
    if problems:
        for problem in problems:
            print(f"fixture error: {problem}")
        return 1
    scenarios = data["scenarios"]
    if args.only:
        wanted = set(args.only.split(","))
        scenarios = [s for s in scenarios if s["name"] in wanted]
    print(f"🔒 write-lock approval replay: {len(scenarios)} scenario(s) x {args.trials} trial(s)", flush=True)
    semaphore = asyncio.Semaphore(args.concurrency)
    results = list(
        await asyncio.gather(
            *(
                run_scenario(s, data, trials=args.trials, scenario_floor=args.scenario_floor, semaphore=semaphore)
                for s in scenarios
            )
        )
    )
    passed = sum(1 for r in results if r["passed"])
    trial_count = sum(len(r["trials"]) for r in results)
    pass_rate = sum(r["passes"] for r in results) / trial_count if trial_count else 0.0
    summary = {
        "total": len(results),
        "passed": passed,
        "trials_per_scenario": args.trials,
        "pass_rate": round(pass_rate, 3),
        "min_pass_rate": args.min_pass_rate,
        "scenario_floor": args.scenario_floor,
        "browser_prompt_sha": _browser_prompt_fingerprint(),
        "planner_model": PLANNER_MODEL,
    }
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    out = RUNS_DIR / f"write-lock-approval-{run_id}.json"
    out.write_text(
        json.dumps({"run_id": run_id, "summary": summary, "scenarios": results}, indent=1, ensure_ascii=False),
        encoding="utf-8",
    )
    print(json.dumps(summary, indent=1))
    print(f"📄 report: {out}")
    return 0 if results and passed == len(results) and pass_rate >= args.min_pass_rate else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", default="")
    parser.add_argument("--trials", type=int, default=10)
    parser.add_argument("--min-pass-rate", type=float, default=0.65)
    parser.add_argument("--scenario-floor", type=float, default=0.4)
    parser.add_argument("--concurrency", type=int, default=12)
    args = parser.parse_args()
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    raise SystemExit(main())
