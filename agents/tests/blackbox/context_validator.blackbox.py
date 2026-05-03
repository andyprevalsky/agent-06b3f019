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


def test_file_output_assistant_does_not_break_tool_result_pairing():
    """File-output ASSISTANT rows (empty text + file_pointer, no tool_calls) must not
    split a parallel tool_result run.

    Repro for the spawn-sub-agents smoke failure (agent 0600ee93...): when a parent
    agent issues two parallel spawn_browser_agent calls, each browser tool emits an
    AssistantEvent(file_pointer=screenshot) between its '✓ Task Completed' and
    'Browser automation complete' POST_MESSAGE rows. After dedup keeps only the latest
    FINISHED TOOL per toolCallId, the message sequence becomes
    [TOOL_A_finished, ASSISTANT_screenshot_A, ASSISTANT_screenshot_B, TOOL_B_finished],
    and the empty assistant rows split the tool_result run — the second tool_use no
    longer has a tool_result in the next user message, and Anthropic returns a 400.

    The fix is to skip empty file-output ASSISTANT rows in the OAI converter, mirroring
    the production build_llm_messages behavior.
    """
    from context_validator import validate_context

    tc_a = "toolu_browser_A"
    tc_b = "toolu_browser_B"
    fp = {
        "id": "fp-1",
        "mime_type": "image/png",
        "storage_path": "x/y/screenshot.png",
        "original_filename": "screenshot.png",
        "size_bytes": 1024,
    }
    messages = [
        _make_msg("USER", "Find populations of Tokyo and NYC.", ts="2024-01-01T00:00:00.000Z"),
        # Parent issues two parallel browser tool calls
        _make_msg(
            "ASSISTANT", "",
            tool_calls=[_tc("spawn_agent", tc_a), _tc("spawn_agent", tc_b)],
            ts="2024-01-01T00:00:01.000Z",
        ),
        # Browser A: ✓ Task Completed (early FINISHED)
        {
            "role": "TOOL", "text": "ok A", "timestamp": "2024-01-01T00:00:02.000Z",
            "metadata": {"toolCallId": tc_a, "toolName": "spawn_browser_agent", "toolStatus": "FINISHED", "title": "✓ Task Completed"},
        },
        # Screenshot for A (between two FINISHED rows for tc_a)
        {"role": "ASSISTANT", "text": "", "timestamp": "2024-01-01T00:00:03.000Z", "metadata": {}, "file_pointer": fp},
        # Browser A: Browser automation complete (late FINISHED — wins dedup)
        {
            "role": "TOOL", "text": "ok A final", "timestamp": "2024-01-01T00:00:04.000Z",
            "metadata": {"toolCallId": tc_a, "toolName": "spawn_browser_agent", "toolStatus": "FINISHED", "title": "Browser automation complete"},
        },
        # Browser B: ✓ Task Completed
        {
            "role": "TOOL", "text": "ok B", "timestamp": "2024-01-01T00:00:05.000Z",
            "metadata": {"toolCallId": tc_b, "toolName": "spawn_browser_agent", "toolStatus": "FINISHED", "title": "✓ Task Completed"},
        },
        # Screenshot for B
        {"role": "ASSISTANT", "text": "", "timestamp": "2024-01-01T00:00:06.000Z", "metadata": {}, "file_pointer": fp},
        # Browser B: Browser automation complete
        {
            "role": "TOOL", "text": "ok B final", "timestamp": "2024-01-01T00:00:07.000Z",
            "metadata": {"toolCallId": tc_b, "toolName": "spawn_browser_agent", "toolStatus": "FINISHED", "title": "Browser automation complete"},
        },
    ]
    violations = validate_context(messages)
    pairing_errors = [
        v for v in violations
        if v.rule == "tool_result_pairing" and v.severity == "error"
    ]
    assert not pairing_errors, (
        "Empty file-output ASSISTANT rows must not split parallel tool_result run; "
        f"got pairing errors: {[v.message for v in pairing_errors]}"
    )


async def run_all_tests():
    print("context_validator blackbox tests:")
    r = BlackboxResult()
    r.record("no_violations_clean_conversation", test_no_violations_clean_conversation)
    r.record("role_alternation_dual_write_flagged", test_role_alternation_dual_write_flagged)
    r.record("role_alternation_text_only_then_tools_exempt", test_role_alternation_text_only_then_tools_exempt)
    r.record("role_alternation_tools_then_text_only_flagged", test_role_alternation_tools_then_text_only_flagged)
    r.record("two_consecutive_text_only_assistants_exempt", test_two_consecutive_text_only_assistants_exempt)
    r.record("file_output_assistant_does_not_break_tool_result_pairing", test_file_output_assistant_does_not_break_tool_result_pairing)
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
