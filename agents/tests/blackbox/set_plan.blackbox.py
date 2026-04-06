"""Blackbox tests for set-plan domain."""

import asyncio
from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    teardown_mock,
)


def test_validate_dependencies_valid():
    """validate_dependencies returns None for a valid DAG."""
    from tools.set_plan import validate_dependencies

    tasks = ["Research", "Write report", "Send email"]
    deps = {"1": ["0"], "2": ["1"]}
    result = validate_dependencies(tasks, deps)
    assert result is None


def test_validate_dependencies_cycle():
    """validate_dependencies catches a dependency cycle."""
    from tools.set_plan import validate_dependencies

    tasks = ["A", "B", "C"]
    deps = {"0": ["2"], "1": ["0"], "2": ["1"]}
    result = validate_dependencies(tasks, deps)
    assert result is not None and "cycle" in result.lower()


def test_validate_planner_result_valid():
    """_validate_planner_result returns None for a well-formed plan."""
    from tools.set_plan import _validate_planner_result

    result = _validate_planner_result({
        "tasks": [
            {"goal": "Research", "tool_name": "spawn_explore_agent", "depends_on": []},
            {"goal": "Write", "tool_name": "reasoning", "depends_on": ["0"]},
        ],
        "dependencies_graph": [
            {"task_idx": "1", "depends_on": ["0"]},
        ],
        "join": "all",
        "title": "Test Plan",
        "content": "A plan",
    })
    assert result is None


def test_no_outbound_http_calls():
    """set_plan validation helpers make zero outbound HTTP calls."""
    from tools.set_plan import validate_dependencies

    validate_dependencies(["A", "B"], {"1": ["0"]})
    assert len(get_captured_requests()) == 0


async def run_all_tests():
    print("set-plan blackbox tests:")
    r = BlackboxResult()
    r.record("validate_deps_valid", test_validate_dependencies_valid)
    r.record("validate_deps_cycle", test_validate_dependencies_cycle)
    r.record("validate_planner_result", test_validate_planner_result_valid)
    r.record("no_outbound_http_calls", test_no_outbound_http_calls)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
