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
    assert "PLAN phase" in result


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
    assert "The beginning of your context might have information generated from the PLAN phase" in result
    assert "real-world, long-horizon task execution" in result
    assert "no further actions required from the user" in result


def test_user_facing_style_is_attached_only_to_user_visible_outputs():
    """The humanizer belongs on prose fields and dedicated prose LLMs, not broad agent prompts."""
    import inspect

    from domains.message_person.repo import generate_message_activity
    from helpers.summarize import generate_completion_summary
    from providers.rose.browser_use import build_browser_use_system_prompt
    from utils.prompts import build_system_prompt
    from utils.tool_schemas import SendMessageToUserExecutePhaseTool, SendMessageToUserTool
    from utils.user_facing_writing_prompt import USER_FACING_WRITING_STYLE

    expected_rules = (
        "AVOID using em dashes",
        "AVOID rhetorical questions",
        "AVOID staccato, stop-start sentences",
        "AVOID markdown",
        "delve",
        "ever-evolving",
    )
    for rule in expected_rules:
        assert rule in USER_FACING_WRITING_STYLE

    plan_prompt = build_system_prompt(phase="PLAN", enabled_tools=["send_message_to_user"])
    execute_prompt = build_system_prompt(
        phase="EXECUTE",
        enabled_tools=["send_message_to_user_execute_phase"],
    )
    assert USER_FACING_WRITING_STYLE not in plan_prompt
    assert USER_FACING_WRITING_STYLE not in execute_prompt
    assert USER_FACING_WRITING_STYLE not in build_browser_use_system_prompt([])

    plan_message_description = SendMessageToUserTool.model_json_schema()["properties"]["message"]["description"]
    execute_message_description = SendMessageToUserExecutePhaseTool.model_json_schema()["properties"]["message"][
        "description"
    ]
    assert USER_FACING_WRITING_STYLE in plan_message_description
    assert USER_FACING_WRITING_STYLE in execute_message_description

    assert "USER_FACING_WRITING_STYLE" in inspect.getsource(generate_message_activity)
    assert "USER_FACING_WRITING_STYLE" in inspect.getsource(generate_completion_summary)


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


def test_schema_contracts_render_nested_field_descriptions():
    """Every structured-output filler sees nested field requirements and descriptions."""
    from domains.spawn_browser_agent_v3.service import format_required_output_schema_system_section
    from utils.prompts import build_system_prompt, build_verifier_prompt

    schema = {
        "fields": [
            {
                "name": "rounds",
                "type": "list[object]",
                "required": True,
                "minItems": 2,
                "description": "One entry per funding round",
                "properties": [
                    {
                        "name": "company",
                        "type": "str",
                        "required": True,
                        "description": "Startup that raised the round",
                    },
                    {
                        "name": "summary",
                        "type": "str",
                        "required": True,
                        "description": "One-sentence summary of the round",
                    },
                    {"name": "lead", "type": "str", "required": False},
                ],
            }
        ]
    }
    expected = (
        "properties={company (str, required): Startup that raised the round; "
        "summary (str, required): One-sentence summary of the round; lead (str, optional)}"
    )
    assert expected in build_verifier_prompt(schema)
    assert expected in build_system_prompt(phase="EXECUTE", enabled_tools=[], response_schema=schema)
    assert expected in format_required_output_schema_system_section(schema)
    # A stale description never outranks the user's later correction (tree-feedback-routing 8f344422).
    flat = " ".join(build_verifier_prompt(schema).split())
    assert "when a later user message changes a requirement, the later message wins." in flat


async def run_all_tests():
    print("prompts blackbox tests:")
    r = BlackboxResult()
    r.record("build_system_prompt_plan", test_build_system_prompt_plan)
    r.record("build_system_prompt_execute", test_build_system_prompt_execute)
    r.record(
        "user_facing_style_is_attached_only_to_user_visible_outputs",
        test_user_facing_style_is_attached_only_to_user_visible_outputs,
    )
    r.record("build_system_prompt_with_user_context", test_build_system_prompt_with_user_context)
    r.record("build_verifier_prompt", test_build_verifier_prompt)
    r.record("build_verifier_prompt_with_schema", test_build_verifier_prompt_with_schema)
    r.record(
        "schema_contracts_render_nested_field_descriptions",
        test_schema_contracts_render_nested_field_descriptions,
    )
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
