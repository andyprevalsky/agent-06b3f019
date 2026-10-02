"""Blackbox tests for error_utils domain."""

import asyncio

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    teardown_mock,
)


def test_simple_error():
    """extract_error_message returns message from plain ValueError."""
    from utils.error_utils import extract_error_message

    result = extract_error_message(ValueError("test error"))

    assert result == "test error"


def test_chained_error():
    """extract_error_message unwraps chained exceptions and returns inner message."""
    from utils.error_utils import extract_error_message

    inner = RuntimeError("root cause")
    outer = ValueError("wrapper")
    outer.__cause__ = inner

    result = extract_error_message(outer)

    assert result == "root cause"


def test_empty_error():
    """extract_error_message with empty message still returns something."""
    from utils.error_utils import extract_error_message

    result = extract_error_message(Exception(""))

    # Empty string exceptions: str(Exception("")) == "", so it falls through
    # to the final return: str(e) or "Unknown error"
    assert result == "Unknown error"


def test_activity_task_failed_wrapper():
    """extract_error_message skips 'Activity task failed' wrapper messages."""
    from utils.error_utils import extract_error_message

    inner = RuntimeError("actual failure reason")
    outer = Exception("Activity task failed")
    outer.__cause__ = inner

    result = extract_error_message(outer)

    assert result == "actual failure reason"


def test_self_referential_cause_does_not_loop():
    """extract_error_message handles accidental self-causation from `raise e from e`."""
    from utils.error_utils import extract_error_message

    error = RuntimeError("final verifier failure")
    error.__cause__ = error

    result = extract_error_message(error)

    assert result == "final verifier failure"


def test_pydantic_validation_error_omits_large_input():
    """extract_error_message summarizes validation errors without rendering huge inputs."""
    from pydantic import BaseModel, ValidationError
    from utils.error_utils import extract_error_message

    class Payload(BaseModel):
        count: int

    huge = "x" * 100_000
    try:
        Payload.model_validate({"count": huge})
    except ValidationError as exc:
        result = extract_error_message(exc)
    else:
        raise AssertionError("expected validation error")

    assert "validation error(s)" in result
    assert "count" in result
    assert len(result) < 1000
    assert huge[:1000] not in result


def test_tool_union_validation_feedback_names_selected_tool_field():
    """A bad tool argument must not hide behind errors from other union branches."""
    from pydantic import ValidationError
    from utils.error_utils import extract_error_message
    from utils.tool_schemas import create_agent_action_model

    action = create_agent_action_model(
        ["web_search", "people_search", "web_fetch", "grep", "attempt_completion_with_result"]
    )
    try:
        action.model_validate(
            {
                "response": "",
                "tool_calls": [
                    {
                        "tool": "web_fetch",
                        "url": "https://catalog.data.metro.tokyo.lg.jp/dataset/t000003d2000001142",
                        "objecive": "Extract the population and reference date",
                    }
                ],
            }
        )
    except ValidationError as exc:
        feedback = extract_error_message(exc)
    else:
        raise AssertionError("expected validation error")

    assert "WebFetchTool.objective: Field required" in feedback, feedback
    assert "WebSearchTool" not in feedback, feedback
    assert "PeopleSearchTool" not in feedback, feedback


def test_validation_feedback_covers_later_tool_call():
    """An earlier malformed call cannot consume every useful retry detail."""
    from pydantic import ValidationError
    from utils.error_utils import extract_error_message

    errors = [
        {"type": "missing", "loc": ("tool_calls", 0, "FirstTool", f"field{i}"), "input": {}}
        for i in range(5)
    ]
    errors.append(
        {"type": "missing", "loc": ("tool_calls", 1, "SecondTool", "objective"), "input": {}}
    )
    feedback = extract_error_message(ValidationError.from_exception_data("AgentAction", errors))
    assert "tool_calls.1.SecondTool.objective: Field required" in feedback, feedback


async def run_all_tests():
    print("error-utils blackbox tests:")
    r = BlackboxResult()
    r.record("simple_error", test_simple_error)
    r.record("chained_error", test_chained_error)
    r.record("empty_error", test_empty_error)
    r.record("activity_task_failed_wrapper", test_activity_task_failed_wrapper)
    r.record("self_referential_cause_does_not_loop", test_self_referential_cause_does_not_loop)
    r.record("pydantic_validation_error_omits_large_input", test_pydantic_validation_error_omits_large_input)
    r.record(
        "tool_union_validation_feedback_names_selected_tool_field",
        test_tool_union_validation_feedback_names_selected_tool_field,
    )
    r.record("validation_feedback_covers_later_tool_call", test_validation_feedback_covers_later_tool_call)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
