"""Blackbox tests for context_validator — well-formedness checks on agent message context."""

import asyncio
import sys
from pathlib import Path

# Setup path
AGENTS_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(AGENTS_ROOT))
sys.path.insert(0, str(AGENTS_ROOT / "benchmarks"))

from _test_utils import BlackboxResult


def _make_msg(role: str, text: str = "", tool_calls=None, metadata=None, ts="2024-01-01T00:00:00.000Z"):
    """Build a minimal DB-format message for validate_context."""
    m = {"role": role, "text": text, "timestamp": ts, "metadata": metadata or {}}
    if tool_calls:
        m["metadata"] = {**(metadata or {}), "tool_calls": tool_calls}
    return m


def _tc(tool_name: str, tc_id: str):
    """Build a tool_call entry in DB metadata format."""
    return {"tool": tool_name, "tool_call_id": tc_id}


def _tool_result(tc_id: str, text: str = "done", ts="2024-01-01T00:00:02.000Z"):
    """Build a TOOL FINISHED message for a given tool_call_id."""
    return {
        "role": "TOOL",
        "text": text,
        "timestamp": ts,
        "metadata": {
            "toolCallId": tc_id,
            "toolName": "web_search",
            "toolStatus": "FINISHED",
        },
    }


def test_no_violations_clean_conversation():
    """A clean USER → ASSISTANT(tool_calls) → TOOL → ASSISTANT path has no violations."""
    from context_validator import validate_context

    tc_id = "aaaa-1111"
    messages = [
        _make_msg("USER", "What is the capital of France?", ts="2024-01-01T00:00:00.000Z"),
        _make_msg("ASSISTANT", "Searching...", tool_calls=[_tc("web_search", tc_id)], ts="2024-01-01T00:00:01.000Z"),
        _tool_result(tc_id, "Paris is the capital of France."),
        _make_msg("ASSISTANT", "Paris is the capital of France.", ts="2024-01-01T00:00:03.000Z"),
    ]
    violations = validate_context(messages)
    errors = [v for v in violations if v.severity == "error"]
    assert not errors, f"Unexpected errors: {errors}"


def test_role_alternation_dual_write_flagged():
    """Two consecutive ASSISTANT messages that both have tool_calls = dual-write corruption."""
    from context_validator import validate_context

    tc_a = "aaaa-2222"
    tc_b = "bbbb-2222"
    messages = [
        _make_msg("USER", "Do a search.", ts="2024-01-01T00:00:00.000Z"),
        _make_msg("ASSISTANT", "Searching...", tool_calls=[_tc("web_search", tc_a)], ts="2024-01-01T00:00:01.000Z"),
        # Duplicate ASSISTANT with DIFFERENT tool_call_ids (e.g. retry wrote it again with new IDs)
        _make_msg("ASSISTANT", "Searching again...", tool_calls=[_tc("web_search", tc_b)], ts="2024-01-01T00:00:02.000Z"),
    ]
    violations = validate_context(messages)
    role_errors = [v for v in violations if v.rule == "role_alternation" and v.severity == "error"]
    assert role_errors, "Expected role_alternation error for dual consecutive tool-calling assistants"


def test_role_alternation_text_only_then_tools_exempt():
    """Text-only ASSISTANT followed by tool-calling ASSISTANT is NOT flagged.

    This is the 'think before acting' pattern: LLM writes a plain-text acknowledgement
    first, then makes the actual tool call. build_llm_messages merges these, so the
    LLM pipeline handles this correctly. The validator must NOT flag it as a corruption.
    """
    from context_validator import validate_context

    tc_id = "cccc-3333"
    messages = [
        _make_msg("USER", "Search for AI trends.", ts="2024-01-01T00:00:00.000Z"),
        # Iteration 1: LLM writes text-only (no tools) — the "distracted by context" case
        _make_msg("ASSISTANT", "I'll search the web for AI trends right now.", ts="2024-01-01T00:00:01.000Z"),
        # Iteration 2: LLM makes the actual tool call
        _make_msg("ASSISTANT", "", tool_calls=[_tc("web_search", tc_id)], ts="2024-01-01T00:00:02.000Z"),
        _tool_result(tc_id, "AI trends 2024..."),
    ]
    violations = validate_context(messages)
    role_errors = [v for v in violations if v.rule == "role_alternation" and v.severity == "error"]
    assert not role_errors, (
        f"text-only → tool-calling consecutive ASSISTANT pair should NOT be flagged, got: {role_errors}"
    )


def test_role_alternation_tools_then_text_only_flagged():
    """Tool-calling ASSISTANT followed by text-only ASSISTANT IS flagged.

    If the first ASSISTANT has tool_calls but the second doesn't, that means tool results
    are missing — the agent made a second LLM call without waiting for tool results.
    This IS suspicious and should be flagged.
    """
    from context_validator import validate_context

    tc_id = "dddd-4444"
    messages = [
        _make_msg("USER", "Do a search.", ts="2024-01-01T00:00:00.000Z"),
        # First ASSISTANT has tool_calls
        _make_msg("ASSISTANT", "Searching...", tool_calls=[_tc("web_search", tc_id)], ts="2024-01-01T00:00:01.000Z"),
        # Second ASSISTANT is text-only, no tool results in between — this IS suspicious
        _make_msg("ASSISTANT", "I think the answer is yes.", ts="2024-01-01T00:00:02.000Z"),
    ]
    violations = validate_context(messages)
    role_errors = [v for v in violations if v.rule == "role_alternation" and v.severity == "error"]
    assert role_errors, "Expected role_alternation error when tool-calling ASSISTANT is followed by text-only ASSISTANT"


def test_two_consecutive_text_only_assistants_exempt():
    """Two consecutive text-only ASSISTANT messages are NOT flagged.

    This happens when the LLM returns no tool calls for multiple iterations.
    run_agent handles it by injecting a nudge (in-memory, not posted to DB).
    build_llm_messages merges them. Not a dual-write bug.
    """
    from context_validator import validate_context

    messages = [
        _make_msg("USER", "Do something.", ts="2024-01-01T00:00:00.000Z"),
        _make_msg("ASSISTANT", "I understand.", ts="2024-01-01T00:00:01.000Z"),
        _make_msg("ASSISTANT", "Let me think more.", ts="2024-01-01T00:00:02.000Z"),
    ]
    violations = validate_context(messages)
    role_errors = [v for v in violations if v.rule == "role_alternation" and v.severity == "error"]
    assert not role_errors, (
        f"Two consecutive text-only ASSISTANTs should NOT be flagged, got: {role_errors}"
    )


async def run_all_tests():
    print("context_validator blackbox tests:")
    r = BlackboxResult()
    r.record("no_violations_clean_conversation", test_no_violations_clean_conversation)
    r.record("role_alternation_dual_write_flagged", test_role_alternation_dual_write_flagged)
    r.record("role_alternation_text_only_then_tools_exempt", test_role_alternation_text_only_then_tools_exempt)
    r.record("role_alternation_tools_then_text_only_flagged", test_role_alternation_tools_then_text_only_flagged)
    r.record("two_consecutive_text_only_assistants_exempt", test_two_consecutive_text_only_assistants_exempt)
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
