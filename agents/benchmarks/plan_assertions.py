"""Plan-shape assertions shared by the memory scenarios runner and the `plan_shape` static check.

A plan is the accepted planner output: ``{"title", "tasks": [{"task_idx", "goal",
"tool_name", "depends_on"}], "join"}`` (or the benchmark's persisted
``plan_data`` with ``dependencies``). Assertions are declarative so a scenario
file and a tasks.json evaluator can state the same expectation.

Supported keys
    tools_exactly:      ["spawn_browser_agent"]            ordered tool_name sequence equality
    require_tools:      ["message_person"]                 every listed tool appears at least once
    no_tools:           ["spawn_explore_agent"]            none of the listed tools appear
    count:              {"spawn_browser_agent": 1}         exact per-tool counts
    min_count:          {"spawn_general_purpose_agent": 4} per-tool minimums
    max_tasks / min_tasks: int
    first_tool:         "spawn_browser_agent"
    any_goal_contains:  {"tool_name": "...", "any": [..]}  some task (optionally of that tool) mentions any substring
    all_goals_avoid:    ["buy now"]                        no task goal mentions any substring
    independent_tools:  "spawn_explore_agent"              tasks with that tool have no depends_on
    join:               "all" | "any"
    memories_retrieved: int                                exact number of memories injected (scenario runs only)
"""

from __future__ import annotations

from typing import Any, Optional


def _tasks(plan: dict[str, Any]) -> list[dict[str, Any]]:
    tasks = plan.get("tasks")
    return [t for t in tasks if isinstance(t, dict)] if isinstance(tasks, list) else []


def _tool(task: dict[str, Any]) -> str:
    raw = task.get("tool_name") or task.get("tool") or ""
    # PlannerResponse.model_dump() keeps the PlanToolName enum; persisted plan_data holds the string.
    return str(getattr(raw, "value", raw)).strip()


def _goal(task: dict[str, Any]) -> str:
    return str(task.get("goal") or "").lower()


def _depends_on(plan: dict[str, Any], task: dict[str, Any], index: int) -> list[str]:
    raw = task.get("depends_on")
    if isinstance(raw, list):
        return [str(d) for d in raw]
    deps = plan.get("dependencies")
    if isinstance(deps, dict):
        found = deps.get(str(task.get("task_idx", index)))
        return [str(d) for d in found] if isinstance(found, list) else []
    return []


def evaluate_plan_assertions(
    plan: Optional[dict[str, Any]],
    assertions: dict[str, Any],
    *,
    memories_retrieved: Optional[int] = None,
) -> tuple[bool, list[str]]:
    """Return ``(passed, failures)``; every failed assertion is reported."""
    failures: list[str] = []
    if plan is None:
        return False, ["no accepted plan"]
    tasks = _tasks(plan)
    tools = [_tool(t) for t in tasks]

    if "tools_exactly" in assertions and tools != list(assertions["tools_exactly"]):
        failures.append(f"tools_exactly expected {assertions['tools_exactly']}, got {tools}")
    for tool in assertions.get("require_tools", []):
        if tool not in tools:
            failures.append(f"require_tools: {tool} missing from {tools}")
    for tool in assertions.get("no_tools", []):
        if tool in tools:
            failures.append(f"no_tools: {tool} present in {tools}")
    for tool, expected in (assertions.get("count") or {}).items():
        if tools.count(tool) != int(expected):
            failures.append(f"count[{tool}] expected {expected}, got {tools.count(tool)}")
    for tool, expected in (assertions.get("min_count") or {}).items():
        if tools.count(tool) < int(expected):
            failures.append(f"min_count[{tool}] expected >= {expected}, got {tools.count(tool)}")
    if "max_tasks" in assertions and len(tasks) > int(assertions["max_tasks"]):
        failures.append(f"max_tasks {assertions['max_tasks']} exceeded: {len(tasks)} tasks")
    if "min_tasks" in assertions and len(tasks) < int(assertions["min_tasks"]):
        failures.append(f"min_tasks {assertions['min_tasks']} not met: {len(tasks)} tasks")
    if "first_tool" in assertions and (not tools or tools[0] != assertions["first_tool"]):
        failures.append(f"first_tool expected {assertions['first_tool']}, got {tools[:1]}")
    spec = assertions.get("any_goal_contains")
    if isinstance(spec, dict):
        needles = [str(n).lower() for n in spec.get("any", [])]
        wanted_tool = spec.get("tool_name")
        pool = [t for t in tasks if not wanted_tool or _tool(t) == wanted_tool]
        if not any(any(n in _goal(t) for n in needles) for t in pool):
            failures.append(
                f"any_goal_contains: none of {needles} in {'any ' + wanted_tool if wanted_tool else 'any'} task goal"
            )
    for needle in assertions.get("all_goals_avoid", []):
        offenders = [_tool(t) for t in tasks if str(needle).lower() in _goal(t)]
        if offenders:
            failures.append(f"all_goals_avoid: {needle!r} appears in {offenders}")
    independent = assertions.get("independent_tools")
    if independent:
        for index, task in enumerate(tasks):
            if _tool(task) == independent and _depends_on(plan, task, index):
                failures.append(
                    f"independent_tools: {independent} task {index} has depends_on {_depends_on(plan, task, index)}"
                )
                break
    if "join" in assertions and str(plan.get("join") or "all") != assertions["join"]:
        failures.append(f"join expected {assertions['join']}, got {plan.get('join')}")
    if "memories_retrieved" in assertions:
        if memories_retrieved is None:
            failures.append("memories_retrieved asserted but retrieval count unknown")
        elif int(memories_retrieved) != int(assertions["memories_retrieved"]):
            failures.append(f"memories_retrieved expected {assertions['memories_retrieved']}, got {memories_retrieved}")
    return not failures, failures


def find_accepted_plan(messages: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """The persisted set_plan result (``metadata.data``) from a benchmark agent's messages, newest first."""
    for message in reversed(messages):
        if not isinstance(message, dict):
            continue
        metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
        if metadata.get("toolName") != "set_plan" or metadata.get("toolStatus") != "FINISHED":
            continue
        plan = metadata.get("data")
        if isinstance(plan, dict) and isinstance(plan.get("tasks"), list):
            return plan
    return None
