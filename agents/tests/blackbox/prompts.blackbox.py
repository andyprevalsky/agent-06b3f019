"""Blackbox tests for prompts domain."""

import asyncio

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    teardown_mock,
)


def test_build_system_prompt_plan():
    """build_system_prompt for PLAN phase returns non-empty string with identity section."""
    from utils.prompts import build_system_prompt

    result = build_system_prompt(
        phase="PLAN",
        enabled_tools=["spawn_agent", "set_plan", "attempt_completion"],
    )

    assert isinstance(result, str)
    assert len(result) > 100
    assert "You are a Rose Labs Agent" in result
    assert "RESEARCH phase" in result


def test_build_system_prompt_execute():
    """build_system_prompt for EXECUTE phase returns string with execute guidance."""
    from utils.prompts import build_system_prompt

    result = build_system_prompt(
        phase="EXECUTE",
        enabled_tools=["spawn_agent", "attempt_completion"],
    )

    assert isinstance(result, str)
    assert "You are a Rose Labs Agent" in result
    assert "EXECUTE phase" in result
    assert "attempt_completion" in result


def test_build_system_prompt_with_user_context():
    """build_system_prompt includes user context when provided."""
    from utils.prompts import build_system_prompt

    result = build_system_prompt(
        phase="PLAN",
        enabled_tools=["attempt_completion"],
        user_context_section="User name: Alice, Location: Portland",
    )

    assert "Alice" in result
    assert "Portland" in result


def test_build_verifier_prompt():
    """build_verifier_prompt returns the static verifier instructions when no schema."""
    from utils.prompts import build_verifier_prompt

    result = build_verifier_prompt()

    assert isinstance(result, str)
    assert len(result) > 100
    assert "impartial judge" in result or "ROLE" in result


def test_build_verifier_prompt_with_schema():
    """build_verifier_prompt includes schema info when response_schema is provided."""
    from utils.prompts import build_verifier_prompt

    schema = {
        "fields": [
            {"name": "address", "type": "str", "description": "Restaurant address"},
            {"name": "phone", "type": "str", "description": "Phone number"},
        ]
    }

    result = build_verifier_prompt(response_schema=schema)

    assert "address" in result
    assert "phone" in result
    assert "2 total" in result or "2" in result


async def run_all_tests():
    print("prompts blackbox tests:")
    r = BlackboxResult()
    r.record("build_system_prompt_plan", test_build_system_prompt_plan)
    r.record("build_system_prompt_execute", test_build_system_prompt_execute)
    r.record("build_system_prompt_with_user_context", test_build_system_prompt_with_user_context)
    r.record("build_verifier_prompt", test_build_verifier_prompt)
    r.record("build_verifier_prompt_with_schema", test_build_verifier_prompt_with_schema)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
