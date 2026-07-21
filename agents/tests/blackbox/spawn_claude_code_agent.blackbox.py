"""Blackbox tests for spawn-claude-code-agent domain.

Complex orchestrator with many endpoints. We test the session
create and health-check boundaries, pure helpers, repo HTTP
behaviour, and the attachment-resolution logic in the handler.
"""

import asyncio
import json
import os
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    get_captured_requests,
    setup_mock,
    teardown_mock,
)


def _setup():
    setup_mock({
        "/api/claude-code-session/create": {
            "status": 200,
            "json": {
                "sandbox_id": "sandbox-abc",
                "task_id": "cctask-123",
                "ws_url": "wss://example/ws",
                "status": "running",
                "uploaded_files": [],
            },
        },
        "/api/claude-code-session/close": {
            "status": 200,
            "json": {"output_files": [], "usage": {"inputTokens": 10, "outputTokens": 20}},
        },
        "/api/claude-code-session/": {
            "status": 200,
            "json": {"status": "healthy", "sandbox_id": "sandbox-abc", "alive": True},
        },
        "/api/codex-code-session/create": {
            "status": 200,
            "json": {
                "sandbox_id": "codex-sandbox-abc",
                "task_id": "codex-task-123",
                "ws_url": "wss://example/codex-ws",
                "status": "running",
                "uploaded_files": [],
            },
        },
        "/api/codex-code-session/close": {
            "status": 200,
            "json": {"output_files": [], "usage": {}},
        },
        "/api/codex-code-session/": {
            "status": 200,
            "json": {"status": "healthy", "sandbox_id": "codex-sandbox-abc", "alive": True},
        },
        "/api/agents/": {
            "status": 200,
            "json": {"saved": True},
        },
    })


async def test_claude_code_session_create_mock():
    """Mock verifies Claude Code session create endpoint returns sandbox_id."""
    _setup()
    import httpx
    async with httpx.AsyncClient(timeout=5.0) as client:
        response = await client.post(
            "https://test-backend.example.com/api/claude-code-session/create",
            json={"goal": "Fix the login bug", "agent_id": "agent-1"},
        )

    assert response.status_code == 200
    data = response.json()
    assert data["sandbox_id"] == "sandbox-abc"
    assert data["task_id"] == "cctask-123"

    assert_captured_call(
        url_contains="/api/claude-code-session/create",
        method="POST",
    )


async def test_claude_code_session_health_mock():
    """Mock verifies Claude Code session health endpoint."""
    _setup()
    import httpx
    async with httpx.AsyncClient(timeout=5.0) as client:
        response = await client.get(
            "https://test-backend.example.com/api/claude-code-session/sandbox-abc/health",
        )

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"

    assert_captured_call(
        url_contains="/api/claude-code-session/",
        method="GET",
    )


# ── Pure helpers: check_fatal_errors ─────────────────────────────────


def test_check_fatal_errors_none():
    """No fatal patterns returns None."""
    from domains.spawn_claude_code_agent.service import check_fatal_errors

    assert check_fatal_errors("normal terminal output") is None


def test_check_fatal_errors_auth_error():
    """authentication_error pattern yields a message."""
    from domains.spawn_claude_code_agent.service import check_fatal_errors

    msg = check_fatal_errors("got an authentication_error from anthropic")
    assert msg is not None
    assert "Claude" in msg


def test_check_fatal_errors_api_401():
    """API Error: 401 pattern yields a message."""
    from domains.spawn_claude_code_agent.service import check_fatal_errors

    msg = check_fatal_errors("API Error: 401 unauthorized")
    assert msg is not None


def test_check_fatal_errors_login_request():
    """Please run /login pattern yields a message."""
    from domains.spawn_claude_code_agent.service import check_fatal_errors

    msg = check_fatal_errors("Please run /login to continue")
    assert msg is not None


def test_check_fatal_errors_credit_balance():
    """Claude Code API billing banner aborts immediately instead of looping."""
    from domains.spawn_claude_code_agent.service import check_fatal_errors

    msg = check_fatal_errors("Credit balance too low · Add funds: https://platform.claude.com/settings/billing")
    assert msg is not None
    assert "billing" in msg.lower()


def test_check_fatal_errors_credit_balance_real_wording():
    """Regression: Anthropic's real banner says "Credit balance is too low" (with "is")
    and often arrives WITHOUT the "Add funds" URL on the same line. The exact
    production output below (agent 6d048fcf, /deploy smoke) previously matched no
    fatal pattern, so the sandbox looped through 4 retries over 333s instead of
    aborting immediately.
    """
    from domains.spawn_claude_code_agent.service import check_fatal_errors

    msg = check_fatal_errors("[Claude] Session started in /home/user\n[Claude] Credit balance is too low")
    assert msg is not None
    assert "billing" in msg.lower()


def test_check_fatal_errors_rate_limit_options():
    """Claude Code rate-limit prompts abort so the exhausted token can rotate."""
    from domains.spawn_claude_code_agent.service import check_fatal_errors

    output = "You've hit your limit - resets 10pm (UTC)\n> /rate-limit-options\n1. Stop and wait for limit to reset"
    msg = check_fatal_errors(output)

    assert msg is not None
    assert "rate-limited" in msg


def test_verifier_activity_timeout_allows_llm_call():
    """Claude Code verifier uses the standard LLM activity budget."""
    from domains.spawn_claude_code_agent.service import VERIFIER_ACTIVITY_TIMEOUT_SECONDS
    from utils.llm_timeouts import STANDARD_LLM_ACTIVITY_TIMEOUT_SECONDS

    assert VERIFIER_ACTIVITY_TIMEOUT_SECONDS == STANDARD_LLM_ACTIVITY_TIMEOUT_SECONDS


# ── safe_time ────────────────────────────────────────────────────────


def test_safe_time_returns_float():
    """safe_time returns a float from time.time."""
    from domains.spawn_claude_code_agent.service import safe_time

    t = safe_time()
    assert isinstance(t, float)
    assert t > 0


def test_safe_time_handles_exception():
    """safe_time returns 0.0 on exception."""
    from domains.spawn_claude_code_agent import service

    with patch.object(service, "time") as mock_time:
        mock_time.time.side_effect = RuntimeError("no time in sandbox")
        assert service.safe_time() == 0.0


# ── _terminal_output_is_truncated ────────────────────────────────────


def test_terminal_truncation_detects_collapse_marker():
    """Detects Claude Code's standard '+N lines (ctrl+o to expand)' marker."""
    from domains.spawn_claude_code_agent.service import _terminal_output_is_truncated

    sample = (
        "● Bash(python3 -c \"...\")\n"
        "  ⎿  27\n"
        "     82\n"
        "     41\n"
        "     … +110 lines (ctrl+o to expand)\n"
    )
    assert _terminal_output_is_truncated(sample) is True


def test_terminal_truncation_detects_high_line_count():
    """A larger '+225 lines' marker (the failing-smoke case) is also detected."""
    from domains.spawn_claude_code_agent.service import _terminal_output_is_truncated

    sample = "  ⎿  27\n     82\n     … +225 lines (ctrl+o to expand)\n"
    assert _terminal_output_is_truncated(sample) is True


def test_terminal_truncation_no_marker_returns_false():
    """Untruncated output (full sequence visible) yields False."""
    from domains.spawn_claude_code_agent.service import _terminal_output_is_truncated

    sample = "27\n82\n41\n124\n62\n31\nTotal steps: 6\n"
    assert _terminal_output_is_truncated(sample) is False


def test_terminal_truncation_handles_empty_output():
    """Empty/None output is not truncated (no false positives)."""
    from domains.spawn_claude_code_agent.service import _terminal_output_is_truncated

    assert _terminal_output_is_truncated("") is False
    assert _terminal_output_is_truncated(None) is False


# ── _build_codex_evidence_summary ───────────────────────────────────


def test_codex_evidence_summary_extracts_paths_and_commands():
    """Codex verifier summary exposes full paths even when the recent tail is noisy."""
    from domains.spawn_claude_code_agent.service import _build_codex_evidence_summary

    sample = (
        "[Codex file_change completed] add /home/user/collatz_27.py\n"
        "[Codex command completed] /bin/bash -lc 'python3 /home/user/collatz_27.py'\n"
        "[Codex command output]\n27\n82\n1\nTotal steps: 111\n"
        "[Codex exit_code] 0\n"
    )

    summary = _build_codex_evidence_summary(sample)
    assert "/home/user/collatz_27.py" in summary
    assert "python3 /home/user/collatz_27.py" in summary
    assert "Codex command exit codes: 0" in summary


def test_codex_structured_response_synthesizes_all_fields():
    """Codex verifier fallback only succeeds when terminal evidence covers the schema."""
    from domains.spawn_claude_code_agent.service import _synthesize_codex_structured_response

    sample = (
        "[Codex file_change completed] add /home/user/collatz_27.py\n"
        "[Codex command completed] /bin/bash -lc 'python3 /home/user/collatz_27.py'\n"
        "[Codex command output]\n3\n10\n5\n16\n8\n4\n2\n1\nTotal steps: 7\n"
        "[Codex exit_code] 0\n"
    )
    schema = {
        "fields": [
            {"name": "collatz_sequence", "type": "list[integer]", "description": "Collatz sequence"},
            {"name": "total_steps", "type": "integer", "description": "total step count"},
            {"name": "python_script", "type": "file_pointer", "description": "created script file"},
        ]
    }

    structured = _synthesize_codex_structured_response(sample, schema)
    assert structured == {
        "collatz_sequence": [3, 10, 5, 16, 8, 4, 2, 1],
        "total_steps": 7,
        "python_script": {"path": "/home/user/collatz_27.py"},
    }


def test_codex_structured_response_uses_json_step_field():
    """Codex fallback handles final answers that include total_steps as JSON text."""
    from domains.spawn_claude_code_agent.service import _synthesize_codex_structured_response

    sample = (
        "[Codex file_change completed] add /home/user/collatz_27.py\n"
        "[Codex command output]\n3\n10\n5\n16\n8\n4\n2\n1\n7\n[Codex exit_code] 0\n"
        '[Codex] {"total_steps": 7, "python_script": "[collatz_27.py](/home/user/collatz_27.py)"}\n'
    )
    schema = {
        "fields": [
            {"name": "collatz_sequence", "type": "list[integer]", "description": "Collatz sequence"},
            {"name": "total_steps", "type": "integer", "description": "total step count"},
            {"name": "python_script", "type": "file_pointer", "description": "created script file"},
        ]
    }

    structured = _synthesize_codex_structured_response(sample, schema)
    assert structured["collatz_sequence"] == [3, 10, 5, 16, 8, 4, 2, 1]
    assert structured["total_steps"] == 7
    assert structured["python_script"] == {"path": "/home/user/collatz_27.py"}


def test_codex_structured_response_prefers_unwrapped_final_sequence():
    """Codex fallback should not split terminal-wrapped sequence values."""
    from domains.spawn_claude_code_agent.service import _synthesize_codex_structured_response

    sample = (
        "[Codex file_change completed] add /home/user/collatz_27.py\n"
        "[Codex command output]\n"
        "377\n113\n2\n566\n283\n1\nTotal steps: 111\n[Codex exit_code] 0\n"
        "[Codex] Exact full sequence:\n"
        "```python\n"
        "[27, 82, 41, 124, 62, 31, 94, 47, 142, 71, 214, 107, 322, 161, 484, 242, 121, 364, 182, 91, 274, 137, 412, 206, 103, 310, 155, 466, 233, 700, 350, 175, 526, 263, 790, 395, 1186, 593, 1780, 890, 445, 1336, 668, 334, 167, 502, 251, 754, 377, 1132, 566, 283, 850, 425, 1276, 638, 319, 958, 479, 1438, 719, 2158, 1079, 3238, 1619, 4858, 2429, 7288, 3644, 1822, 911, 2734, 1367, 4102, 2051, 6154, 3077, 9232, 4616, 2308, 1154, 577, 1732, 866, 433, 1300, 650, 325, 976, 488, 244, 122, 61, 184, 92, 46, 23, 70, 35, 106, 53, 160, 80, 40, 20, 10, 5, 16, 8, 4, 2, 1]\n"
        "```\n"
        "Total steps: `111`\n"
    )
    schema = {
        "fields": [
            {"name": "collatz_sequence", "type": "list[int]", "description": "Exact Collatz sequence"},
            {"name": "total_steps", "type": "int", "description": "total step count"},
            {"name": "python_script_path", "type": "file_pointer", "description": "created script file"},
        ]
    }

    structured = _synthesize_codex_structured_response(sample, schema)
    assert structured is not None
    assert structured["collatz_sequence"][48:52] == [377, 1132, 566, 283]
    assert structured["total_steps"] == 111
    assert structured["python_script_path"] == {"path": "/home/user/collatz_27.py"}


def test_codex_structured_response_parses_printed_sequence_and_steps_label():
    """Regression for smoke output where Codex used a concise final answer."""
    from domains.spawn_claude_code_agent.service import _synthesize_codex_structured_response

    sample = (
        "[Codex file_change completed] add /home/user/collatz_27.py\n"
        "[Codex command completed] /bin/bash -lc 'python3 /home/user/collatz_27.py'\n"
        "[Codex command output]\n27\n82\n41\n124\n62\n31\n94\n47\n142\n71\n214\n107\n322\n161\n484\n242\n121\n364\n182\n91\n274\n137\n412\n206\n103\n310\n155\n466\n233\n700\n350\n175\n526\n263\n790\n395\n1186\n593\n1780\n890\n445\n1336\n668\n334\n167\n502\n251\n754\n377\n113\n2\n566\n283\n850\n425\n1276\n638\n319\n958\n479\n1438\n719\n2158\n1079\n3238\n1619\n4858\n2429\n7288\n3644\n1822\n911\n2734\n1367\n4102\n2051\n6154\n3077\n9232\n4616\n2308\n1154\n577\n1732\n866\n433\n1300\n650\n325\n976\n488\n244\n122\n61\n184\n92\n46\n23\n70\n35\n106\n53\n160\n80\n40\n20\n10\n5\n16\n8\n4\n2\n1\nsteps: 111\n[Codex exit_code] 0\n"
        "[Codex] [file pointer](/home/user/collatz_27.py:1)\n"
        "absolute path: `/home/user/collatz_27.py`\n"
        "printed Collatz integers:\n"
        "`27, 82, 41, 124, 62, 31, 94, 47, 142, 71, 214, 107, 322, 161, 484, 242, 121, 364, 182, 91, 274, 137, 412, 206, 103, 310, 155, 466, 233, 700, 350, 175, 526, 263, 790, 395, 1186, 593, 1780, 890, 445, 1336, 668, 334, 167, 502, 251, 754, 377, 1132, 566, 283, 850, 425, 1276, 638, 319, 958, 479, 1438, 719, 2158, 1079, 3238, 1619, 4858, 2429, 7288, 3644, 1822, 911, 2734, 1367, 4102, 2051, 6154, 3077, 9232, 4616, 2308, 1154, 577, 1732, 866, 433, 1300, 650, 325, 976, 488, 244, 122, 61, 184, 92, 46, 23, 70, 35, 106, 53, 160, 80, 40, 20, 10, 5, 16, 8, 4, 2, 1`\n"
        "total step count: `111`\n"
    )
    schema = {
        "fields": [
            {"name": "program_file", "type": "file_pointer", "description": "Created Python script file."},
            {"name": "program_absolute_path", "type": "str", "description": "Absolute session path to the Python script."},
            {"name": "collatz_sequence", "type": "list[int]", "description": "Ordered Collatz sequence"},
            {"name": "step_count", "type": "int", "description": "total step count"},
        ]
    }

    structured = _synthesize_codex_structured_response(sample, schema)
    assert structured is not None
    assert structured["program_file"] == {"path": "/home/user/collatz_27.py"}
    assert structured["program_absolute_path"] == "/home/user/collatz_27.py"
    assert structured["collatz_sequence"][48:52] == [377, 1132, 566, 283]
    assert structured["collatz_sequence"][-1] == 1
    assert structured["step_count"] == 111


# ── build_context_summary ────────────────────────────────────────────


def test_build_context_summary_success():
    """Success output includes the SUCCESS marker and reasoning."""
    from domains.spawn_claude_code_agent.service import build_context_summary

    out = build_context_summary(
        success=True, close_reasoning="All tests passed", action_summary=["step1", "step2"]
    )
    assert "SUCCESS" in out
    assert "All tests passed" in out
    assert "step1" in out


def test_build_context_summary_failure_with_error():
    """Failure path includes error_context and FAILED marker."""
    from domains.spawn_claude_code_agent.service import build_context_summary

    out = build_context_summary(
        success=False,
        close_reasoning="bad exit",
        action_summary=["did a", "did b"],
        error_context="Something broke",
    )
    assert "FAILED" in out
    assert "Something broke" in out
    assert "bad exit" in out


def test_build_context_summary_truncates_actions():
    """Action summary shows only last 10 actions."""
    from domains.spawn_claude_code_agent.service import build_context_summary

    actions = [f"action-{i}" for i in range(20)]
    out = build_context_summary(success=True, close_reasoning="", action_summary=actions)
    # action-0..9 should NOT appear, action-10..19 should
    assert "action-0\n" not in out and "action-19" in out


def test_build_context_summary_empty_actions():
    """Empty action list omits the Actions section."""
    from domains.spawn_claude_code_agent.service import build_context_summary

    out = build_context_summary(success=True, close_reasoning="done", action_summary=[])
    assert "Actions Taken" not in out


# ── extract_additional_paths ─────────────────────────────────────────


def test_extract_additional_paths_none_structured():
    """Missing structured_response or schema returns empty list."""
    from domains.spawn_claude_code_agent.service import extract_additional_paths

    assert extract_additional_paths(None, {"fields": [{"name": "a", "type": "file_pointer"}]}) == []
    assert extract_additional_paths({"a": {"path": "/x"}}, None) == []


def test_extract_additional_paths_file_pointer():
    """Single file_pointer field with absolute path extracted."""
    from domains.spawn_claude_code_agent.service import extract_additional_paths

    schema = {"fields": [{"name": "report", "type": "file_pointer"}]}
    structured = {"report": {"path": "/home/user/output/report.txt"}}
    assert extract_additional_paths(structured, schema) == ["/home/user/output/report.txt"]


def test_extract_additional_paths_list_file_pointer():
    """list[file_pointer] flattens to list of paths."""
    from domains.spawn_claude_code_agent.service import extract_additional_paths

    schema = {"fields": [{"name": "files", "type": "list[file_pointer]"}]}
    structured = {
        "files": [
            {"path": "/a.txt"},
            {"path": "/b.txt"},
            {"path": "relative-no.txt"},  # filtered
            "not-a-dict",  # filtered
        ]
    }
    paths = extract_additional_paths(structured, schema)
    assert paths == ["/a.txt", "/b.txt"]


def test_extract_additional_paths_skips_unknown_fields():
    """Fields missing from structured_response are skipped."""
    from domains.spawn_claude_code_agent.service import extract_additional_paths

    schema = {"fields": [{"name": "x", "type": "file_pointer"}, {"name": "y", "type": "string"}]}
    structured = {"y": "ignore"}
    assert extract_additional_paths(structured, schema) == []


def test_extract_additional_paths_missing_name_or_type():
    """Fields without name or type are skipped."""
    from domains.spawn_claude_code_agent.service import extract_additional_paths

    schema = {"fields": [{"type": "file_pointer"}, {"name": "a"}]}
    structured = {"a": {"path": "/x"}}
    assert extract_additional_paths(structured, schema) == []


def test_extract_additional_paths_non_dict_value():
    """file_pointer with non-dict value is skipped."""
    from domains.spawn_claude_code_agent.service import extract_additional_paths

    schema = {"fields": [{"name": "a", "type": "file_pointer"}]}
    structured = {"a": "/x"}  # not a dict
    assert extract_additional_paths(structured, schema) == []


def test_structured_response_from_output_files_single_pointer():
    """Extracted /home/user/output files populate file pointer schema paths deterministically."""
    from domains.spawn_claude_code_agent.service import _structured_response_from_output_files

    schema = {"fields": [{"name": "red_tinted_image", "type": "file_pointer"}]}
    files = [{"original_filename": "red_tinted.png", "mime_type": "image/png", "size_bytes": 123}]

    assert _structured_response_from_output_files(schema, files) == {
        "red_tinted_image": {"path": "/home/user/output/red_tinted.png"}
    }


def test_structured_response_from_output_files_rejects_non_file_schema():
    """The deterministic file path shortcut only handles pure file output schemas."""
    from domains.spawn_claude_code_agent.service import _structured_response_from_output_files

    schema = {"fields": [{"name": "summary", "type": "string"}]}
    files = [{"original_filename": "report.txt"}]

    assert _structured_response_from_output_files(schema, files) is None


def test_build_code_event_context_uses_json_and_extracted_files():
    """Verifier evidence is built from normalized SDK events plus extracted files."""
    from domains.spawn_claude_code_agent.service import _build_code_event_context

    context = _build_code_event_context(
        code_events=[{"provider": "claude", "type": "tool_use", "paths": ["/home/user/output/a.txt"]}],
        output_files=[{"original_filename": "a.txt", "mime_type": "text/plain", "size_bytes": 2}],
        action_summary=["done"],
    )

    assert '"code_agent_events"' in context
    assert '"/home/user/output/a.txt"' in context
    assert '"extracted_output_files"' in context


# ── build_usage_items ────────────────────────────────────────────────


def test_build_usage_items_both_llm_and_service():
    """Usage items include LLM cost + E2B service cost."""
    from domains.spawn_claude_code_agent.service import build_usage_items

    pricing = {"input_cents_per_1k": 0.3, "output_cents_per_1k": 1.5}
    items = build_usage_items(
        total_input_tokens=1000,
        total_output_tokens=500,
        model="rose-1-lite",
        model_pricing=pricing,
        execution_time_ms=10_000,
        claude_code_usage={
            "inputTokens": 5,
            "outputTokens": 7,
            "cacheReadInputTokens": 300,
            "cacheCreationInputTokens": 100,
        },
    )
    # Verifier LLM + Claude Code CLI usage + service
    assert len(items) == 3
    llm = items[0]
    assert llm["type"] == "llm"
    assert llm["model"] == "rose-1-lite"
    assert llm["input_tokens"] == 1000
    # 1000/1000 * 0.3 + 500/1000 * 1.5 = 0.3 + 0.75 = 1.05
    assert abs(llm["cost_cents"] - 1.05) < 1e-6
    claude_code = items[1]
    assert claude_code["type"] == "llm"
    assert claude_code["provider"] == "Claude Code CLI (user plan)"
    assert claude_code["cost_cents"] == 0
    assert claude_code["cache_read_input_tokens"] == 300
    assert claude_code["cache_creation_input_tokens"] == 100
    svc = items[2]
    assert svc["type"] == "service"
    # 10s * 0.0028 cents/s = 0.028
    assert abs(svc["cost_cents"] - 0.028) < 1e-4


def test_build_usage_items_no_tokens():
    """Zero tokens yields only the service item."""
    from domains.spawn_claude_code_agent.service import build_usage_items

    items = build_usage_items(
        total_input_tokens=0,
        total_output_tokens=0,
        model="x",
        model_pricing={"input_cents_per_1k": 0.0, "output_cents_per_1k": 0.0},
        execution_time_ms=1000,
    )
    assert len(items) == 1
    assert items[0]["type"] == "service"


# ── call_parent_llm ─────────────────────────────────────────────────


async def test_call_parent_llm_completion():
    """call_parent_llm attempt_completion=True returns None response."""
    from domains.spawn_claude_code_agent import service
    from domains.spawn_claude_code_agent.types import ClaudeCodeParentResponse

    mock_response = ClaudeCodeParentResponse(attempt_completion=True, response="")
    mock_usage = {"prompt_tokens": 100, "completion_tokens": 50}

    async def fake_streaming(**kwargs):
        return mock_response, mock_usage, {}

    async def noop_chunk(text, tokens):
        pass

    with patch("helpers.llm.call_llm_structured_streaming", side_effect=fake_streaming):
        result = await service.call_parent_llm(
            goal="do thing",
            filtered_output="output",
            conversation_history=[],
            agent_id="a1",
            on_chunk=noop_chunk,
        )

    assert result["attempt_completion"] is True
    assert result["response"] is None
    assert result["usage"] == mock_usage


async def test_call_parent_llm_continue():
    """call_parent_llm attempt_completion=False returns the response text."""
    from domains.spawn_claude_code_agent import service
    from domains.spawn_claude_code_agent.types import ClaudeCodeParentResponse

    mock_response = ClaudeCodeParentResponse(attempt_completion=False, response="1")
    mock_usage = {"prompt_tokens": 10, "completion_tokens": 5}

    async def fake_streaming(**kwargs):
        return mock_response, mock_usage, {}

    async def noop_chunk(text, tokens):
        pass

    with patch("helpers.llm.call_llm_structured_streaming", side_effect=fake_streaming):
        result = await service.call_parent_llm(
            goal="g",
            filtered_output="output",
            conversation_history=[{"role": "user", "content": "hello"}],
            agent_id="a1",
            on_chunk=noop_chunk,
        )

    assert result["attempt_completion"] is False
    assert result["response"] == "1"


async def test_call_parent_llm_exception_safe():
    """If LLM raises, call_parent_llm returns safe defaults (no raise)."""
    from domains.spawn_claude_code_agent import service

    async def fake_streaming(**kwargs):
        raise RuntimeError("boom")

    async def noop_chunk(text, tokens):
        pass

    with patch("helpers.llm.call_llm_structured_streaming", side_effect=fake_streaming):
        result = await service.call_parent_llm(
            goal="g",
            filtered_output="",
            conversation_history=[],
            agent_id="a1",
            on_chunk=noop_chunk,
        )

    assert result["attempt_completion"] is False
    assert result["response"] == ""
    assert result["usage"] == {"prompt_tokens": 0, "completion_tokens": 0}


async def test_call_parent_llm_with_attachments_history():
    """When history mentions attachments, file_info is injected in system prompt."""
    from domains.spawn_claude_code_agent import service
    from domains.spawn_claude_code_agent.types import ClaudeCodeParentResponse

    captured_messages = {}

    async def fake_streaming(**kwargs):
        captured_messages["messages"] = kwargs["messages"]
        return ClaudeCodeParentResponse(attempt_completion=True, response=""), {}, {}

    async def noop_chunk(text, tokens):
        pass

    with patch("helpers.llm.call_llm_structured_streaming", side_effect=fake_streaming):
        await service.call_parent_llm(
            goal="g",
            filtered_output="",
            conversation_history=[{"role": "user", "content": "see attachments X"}],
            agent_id="a1",
            on_chunk=noop_chunk,
        )

    # System prompt is the first message
    sys_msg = captured_messages["messages"][0]["content"]
    assert "Available Files" in sys_msg


# ── spawn_claude_code_agent REPO tests ──────────────────────────────


async def test_repo_save_message_posts_json():
    """save_claude_code_message POSTs JSON to the messages endpoint."""
    _setup()
    from domains.spawn_claude_code_agent.repo import save_claude_code_message
    from tools.base import MessageStatus

    await save_claude_code_message(
        agent_id="agent-1",
        title="hello",
        message="body",
        status=MessageStatus.IN_PROGRESS,
        task_id="task-1",
        action_type="system",
        tool_call_id="tc-1",
        is_init_message=True,
        ws_url="wss://x",
        output_schema={"fields": []},
        structured_response={"result": "ok"},
        github_repo_url="https://github.com/foo/bar",
        code_provider="codex",
        completed_turns=3,
    )

    call = assert_captured_call(url_contains="/api/agents/", method="POST")
    body = json.loads(call["requestBody"])
    assert body["role"] == "TOOL"
    assert body["message"] == "body"
    meta = body["metadata"]
    assert meta["toolName"] == "spawn_claude_code_agent"
    assert meta["ws_url"] == "wss://x"
    assert meta["output_schema"] == {"fields": []}
    assert meta["structured_response"] == {"result": "ok"}
    assert meta["github_repo_url"] == "https://github.com/foo/bar"
    assert meta["code_provider"] == "codex"
    assert meta["completed_turns"] == 3
    # Init messages omit subAgentId
    assert "subAgentId" not in meta


async def test_repo_save_message_non_init_has_subagent():
    """Non-init messages include subAgentId=task_id."""
    _setup()
    from domains.spawn_claude_code_agent.repo import save_claude_code_message
    from tools.base import MessageStatus

    await save_claude_code_message(
        agent_id="agent-x",
        title="t",
        message="",
        status=MessageStatus.FINISHED,
        task_id="task-99",
    )

    call = assert_captured_call(url_contains="/api/agents/", method="POST")
    body = json.loads(call["requestBody"])
    assert body["metadata"]["subAgentId"] == "task-99"


async def test_repo_save_message_error_flag():
    """ERROR status sets metadata.error=True."""
    _setup()
    from domains.spawn_claude_code_agent.repo import save_claude_code_message
    from tools.base import MessageStatus

    await save_claude_code_message(
        agent_id="agent-e",
        title="t",
        message="",
        status=MessageStatus.ERROR,
        task_id="task-e",
    )

    call = assert_captured_call(url_contains="/api/agents/", method="POST")
    body = json.loads(call["requestBody"])
    assert body["metadata"]["error"] is True


async def test_repo_save_message_swallows_http_errors():
    """Repo swallows HTTP exceptions so the loop continues."""
    setup_mock({
        "/api/agents/": {"status": 500, "json": {"error": "boom"}},
    })
    from domains.spawn_claude_code_agent.repo import save_claude_code_message
    from tools.base import MessageStatus

    # Should not raise
    await save_claude_code_message(
        agent_id="a", title="t", message="", status=MessageStatus.FINISHED, task_id="task-x"
    )


async def test_repo_create_e2b_session_happy():
    """create_e2b_session returns parsed JSON on 200."""
    _setup()
    from domains.spawn_claude_code_agent.repo import create_e2b_session

    data = await create_e2b_session(
        agent_id="agent-1",
        goal="fix",
        user_id="u1",
        attachments=[{"id": "f1", "storage_path": "p", "original_filename": "a.txt", "mime_type": "text/plain", "size_bytes": 10, "created_at": "2024-01-01"}],
        github_repo_url="https://github.com/a/b",
    )

    assert data["task_id"] == "cctask-123"
    call = assert_captured_call(url_contains="/api/claude-code-session/create", method="POST")
    body = json.loads(call["requestBody"])
    assert body["agent_id"] == "agent-1"
    assert body["user_id"] == "u1"
    assert body["github_repo_url"] == "https://github.com/a/b"
    assert body["attachments"][0]["original_filename"] == "a.txt"


async def test_repo_create_e2b_session_codex_provider():
    """create_e2b_session targets the Codex session endpoint when requested."""
    _setup()
    from domains.spawn_claude_code_agent.repo import create_e2b_session

    data = await create_e2b_session(
        agent_id="agent-1",
        goal="fix",
        user_id="u1",
        code_provider="codex",
        fast_mode_cache_enabled=True,
    )

    assert data["task_id"] == "codex-task-123"
    call = assert_captured_call(url_contains="/api/codex-code-session/create", method="POST")
    body = json.loads(call["requestBody"])
    assert body["agent_id"] == "agent-1"
    assert body["user_id"] == "u1"
    assert body["fast_mode_cache_enabled"] is True


async def test_repo_create_e2b_session_raises_on_error():
    """create_e2b_session raises provider-specific errors on non-2xx."""
    setup_mock({
        "/api/codex-code-session/create": {"status": 403, "text": '{"code":"GITHUB_ACCESS_DENIED"}'},
    })
    from domains.spawn_claude_code_agent.repo import create_e2b_session

    try:
        await create_e2b_session(agent_id="a", goal="g", user_id="u", code_provider="codex")
        raise AssertionError("Expected exception")
    except Exception as e:
        message = str(e)
        assert "Failed to create code session" in message
        assert "provider=codex" in message
        assert "HTTP 403" in message
        assert "GITHUB_ACCESS_DENIED" in message
        assert "Claude Code session" not in message


async def test_repo_persist_terminal_output_happy():
    """persist_terminal_output POSTs filtered output."""
    setup_mock({
        "/api/claude-code-session/": {"status": 200, "json": {"ok": True}},
    })
    from domains.spawn_claude_code_agent.repo import persist_terminal_output

    await persist_terminal_output(task_id="task-1", output="lots of logs", agent_id="agent-1")

    call = assert_captured_call(url_contains="/api/claude-code-session/task-1/output", method="POST")
    body = json.loads(call["requestBody"])
    assert body["output"] == "lots of logs"


async def test_repo_persist_terminal_output_swallows_errors():
    """Persist swallows HTTP errors."""
    # 500 on /output — ensure no exception
    setup_mock({
        "/api/claude-code-session/": {"status": 500, "json": {"error": "x"}},
    })
    from domains.spawn_claude_code_agent.repo import persist_terminal_output

    await persist_terminal_output(task_id="task-bad", output="x", agent_id="a")


async def test_repo_close_e2b_session_happy():
    """close_e2b_session returns JSON on 200 with all optional params."""
    setup_mock({
        "/api/claude-code-session/close": {
            "status": 200,
            "json": {"output_files": [{"id": "f1"}], "usage": {"inputTokens": 5}},
        },
    })
    from domains.spawn_claude_code_agent.repo import close_e2b_session

    data = await close_e2b_session(
        task_id="task-1",
        user_id="u-1",
        agent_id="a-1",
        additional_paths=["/foo"],
    )
    assert data["output_files"] == [{"id": "f1"}]
    call = assert_captured_call(url_contains="/api/claude-code-session/close", method="POST")
    body = json.loads(call["requestBody"])
    assert body["task_id"] == "task-1"
    assert body["user_id"] == "u-1"
    assert body["agent_id"] == "a-1"
    assert body["additional_paths"] == ["/foo"]


async def test_repo_close_e2b_session_non_200_returns_empty():
    """close_e2b_session returns {} on non-200."""
    setup_mock({
        "/api/claude-code-session/close": {"status": 500, "json": {"error": "x"}},
    })
    from domains.spawn_claude_code_agent.repo import close_e2b_session

    data = await close_e2b_session(task_id="t")
    assert data == {}


async def test_repo_check_sandbox_health_happy():
    """check_sandbox_health returns JSON body on 200."""
    setup_mock({
        "/api/claude-code-session/": {
            "status": 200,
            "json": {"alive": True, "ws_server_running": True},
        },
    })
    from domains.spawn_claude_code_agent.repo import check_sandbox_health

    data = await check_sandbox_health(sandbox_id="sb-1", agent_id="a-1")
    assert data is not None
    assert data["alive"] is True


async def test_repo_check_sandbox_health_non_200_returns_none():
    """Non-200 returns None."""
    setup_mock({
        "/api/claude-code-session/": {"status": 500, "json": {"err": "x"}},
    })
    from domains.spawn_claude_code_agent.repo import check_sandbox_health

    data = await check_sandbox_health(sandbox_id="sb-1", agent_id="a-1")
    assert data is None


async def test_repo_check_sandbox_health_http_exception_returns_none():
    """Transport exception returns None."""
    setup_mock({})  # No mock => 404 Mock response, treated as non-200 → None
    from domains.spawn_claude_code_agent.repo import check_sandbox_health

    data = await check_sandbox_health(sandbox_id="sb-1", agent_id="a-1")
    assert data is None


# ── handler attachment resolution ────────────────────────────────────


def _make_file_pointer(fid, filename="file.txt", mime="text/plain"):
    # Matches FilePointer dataclass
    from helpers.attachments import FilePointer

    return FilePointer(
        id=fid,
        storage_path=f"storage/{fid}",
        original_filename=filename,
        mime_type=mime,
        size_bytes=10,
        created_at="2024-01-01",
    )


def test_handler_fp_to_dict():
    """_fp_to_dict yields a serialisable dict."""
    from domains.spawn_claude_code_agent.handler import _fp_to_dict

    fp = _make_file_pointer("abc", "x.txt")
    d = _fp_to_dict(fp)
    assert d["id"] == "abc"
    assert d["original_filename"] == "x.txt"
    assert d["mime_type"] == "text/plain"


def test_handler_resolve_attachments_no_context():
    """No context attribute on workflow_instance => empty list."""
    from domains.spawn_claude_code_agent.handler import _resolve_attachments

    class FakeWF:
        pass

    result = _resolve_attachments(FakeWF(), ["x.txt"], agent_id="a")
    assert result == []


def test_handler_resolve_attachments_explicit_match():
    """Explicit requested attachment gets matched by filename."""
    from domains.spawn_claude_code_agent.handler import _resolve_attachments

    fp1 = _make_file_pointer("f1", "report.md")
    fp2 = _make_file_pointer("f2", "data.csv")

    workflow_instance = SimpleNamespace(
        context=[
            {"filePointer": fp1.__dict__},
            {"filePointer": fp2.__dict__},
        ]
    )

    result = _resolve_attachments(workflow_instance, ["data.csv"], agent_id="a")
    assert len(result) == 1
    assert result[0]["original_filename"] == "data.csv"


def test_handler_resolve_attachments_auto_forward_none_requested():
    """When requested is None and context has attachments, auto-forward all."""
    from domains.spawn_claude_code_agent.handler import _resolve_attachments

    fp = _make_file_pointer("f1", "auto.txt")
    workflow_instance = SimpleNamespace(context=[{"filePointer": fp.__dict__}])

    result = _resolve_attachments(workflow_instance, None, agent_id="a")
    assert len(result) == 1
    assert result[0]["original_filename"] == "auto.txt"


def test_handler_resolve_attachments_auto_forward_when_none_match():
    """When explicit match fails, fall back to auto-forward all parent attachments."""
    from domains.spawn_claude_code_agent.handler import _resolve_attachments

    fp = _make_file_pointer("f1", "keep.md")
    workflow_instance = SimpleNamespace(context=[{"filePointer": fp.__dict__}])

    result = _resolve_attachments(workflow_instance, ["nope.txt"], agent_id="a")
    # Fallback returns all parent attachments
    assert len(result) == 1
    assert result[0]["original_filename"] == "keep.md"


def test_handler_resolve_attachments_match_by_id():
    """Match by id when filename lookup fails."""
    from domains.spawn_claude_code_agent.handler import _resolve_attachments

    fp = _make_file_pointer("id-xyz", "a.txt")
    workflow_instance = SimpleNamespace(context=[{"filePointer": fp.__dict__}])

    result = _resolve_attachments(workflow_instance, ["id-xyz"], agent_id="a")
    assert len(result) == 1


# ── get_manager singleton ──────────────────────────────────────────


def test_handler_get_manager_singleton():
    """get_manager returns the same instance across calls."""
    from domains.spawn_claude_code_agent.handler import get_manager

    a = get_manager()
    b = get_manager()
    assert a is b
    assert a.tool_name == "spawn_claude_code_agent"


def test_handler_select_code_provider_uses_codex_for_gpt_compute():
    """GPT compute token means code tasks should use Codex, not Claude Code."""
    from domains.spawn_claude_code_agent.handler import _select_code_provider

    wf = SimpleNamespace(compute_token_provider="gpt")
    assert _select_code_provider(wf, "gpt-token") == "codex"


def test_handler_select_code_provider_env_override_forces_claude():
    """Benchmark/local verification can force the real Claude Code path."""
    from domains.spawn_claude_code_agent.handler import _select_code_provider

    previous = os.environ.get("ROSE_CODE_AGENT_PROVIDER")
    os.environ["ROSE_CODE_AGENT_PROVIDER"] = "claude"
    try:
        wf = SimpleNamespace(compute_token_provider="gpt")
        assert _select_code_provider(wf, "gpt-token") == "claude"
    finally:
        if previous is None:
            os.environ.pop("ROSE_CODE_AGENT_PROVIDER", None)
        else:
            os.environ["ROSE_CODE_AGENT_PROVIDER"] = previous


def test_handler_select_code_provider_keeps_claude_without_gpt_token():
    """Missing GPT token keeps the existing Claude Code path."""
    from domains.spawn_claude_code_agent.handler import _select_code_provider

    wf = SimpleNamespace(compute_token_provider="gpt")
    assert _select_code_provider(wf, None) == "claude"


# ── _handle_reconnect_exhausted ─────────────────────────────────────


async def test_handle_reconnect_exhausted_alive_sandbox():
    """Alive sandbox with ws/claude diagnostics raises with diagnosis message."""
    from domains.spawn_claude_code_agent import service

    with patch.object(
        service,
        "check_sandbox_health",
        AsyncMock(
            return_value={
                "alive": True,
                "ws_server_running": False,
                "claude_running": True,
                "diagnostics": {
                    "oom_check": "x" * 600,
                    "memory": "m",
                    "processes": "p",
                    "crash_files": "c",
                    "ws_log": "w",
                },
            }
        ),
    ):
        summary: list[str] = []
        try:
            await service._handle_reconnect_exhausted("sb", "a1", "t1", summary)
            raise AssertionError("should raise")
        except Exception as e:
            assert "WebSocket" in str(e)
        # DIAGNOSIS: alive path appended
        assert any("Sandbox alive" in s for s in summary)


async def test_handle_reconnect_exhausted_dead_sandbox():
    """Dead sandbox raises with DEAD diagnosis."""
    from domains.spawn_claude_code_agent import service

    with patch.object(
        service,
        "check_sandbox_health",
        AsyncMock(return_value={"alive": False, "error": "oom-killed"}),
    ):
        summary: list[str] = []
        try:
            await service._handle_reconnect_exhausted("sb", "a1", "t1", summary)
            raise AssertionError("should raise")
        except Exception:
            pass
        assert any("DEAD" in s for s in summary)


async def test_handle_reconnect_exhausted_health_none():
    """No health info at all still raises with could-not-determine summary."""
    from domains.spawn_claude_code_agent import service

    with patch.object(service, "check_sandbox_health", AsyncMock(return_value=None)):
        summary: list[str] = []
        try:
            await service._handle_reconnect_exhausted("sb", "a1", "t1", summary)
            raise AssertionError("should raise")
        except Exception:
            pass
        assert any("Could not determine" in s for s in summary)


# ── _run_verifier ────────────────────────────────────────────────────


async def test_run_verifier_happy_path():
    """Verifier returns progress score, reasoning, tokens, and structured_response."""
    from domains.spawn_claude_code_agent import service
    from utils.terminal_filter import TerminalFilter

    terminal = TerminalFilter(cols=80, rows=50)
    terminal.feed("Done output /home/user/output file")
    seen_args = {}

    async def fake_activity(fn, *, args, **_kwargs):
        seen_args["args"] = args
        return {
            "score": 0.9,
            "reasoning": "looks good",
            "structured_response": {"ok": True},
            "usage": {"prompt_tokens": 7, "completion_tokens": 3},
        }

    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    with (
        patch("loop.activity_helper.call_temporal_activity_from_activity", side_effect=fake_activity),
        patch("temporalio.activity.heartbeat"),
    ):
        score, reasoning, struct, itok, otok = await service._run_verifier(
            agent_id="a",
            task_id="t",
            goal="g",
            model="rose-labs/rose-1-lite",
            terminal=terminal,
            action_summary=["a1"],
            output_schema={"fields": []},
            claude_token=None,
            fast_mode_cache_enabled=True,
            fast_mode_goal="fast goal",
            fast_mode_step=3,
        )
    assert score == 0.9
    assert reasoning == "looks good"
    assert struct == {"ok": True}
    assert itok == 7 and otok == 3
    assert seen_args["args"][-3:] == [True, "fast goal", 3]


async def test_run_verifier_exception_fallback():
    """Exception returns 0.5 score and assumes partial completion."""
    from domains.spawn_claude_code_agent import service
    from utils.terminal_filter import TerminalFilter

    terminal = TerminalFilter(cols=80, rows=50)
    terminal.feed("x")

    async def fake_activity(*a, **kw):
        raise RuntimeError("verifier-blew-up")

    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    with (
        patch("loop.activity_helper.call_temporal_activity_from_activity", side_effect=fake_activity),
        patch("temporalio.activity.heartbeat"),
    ):
        score, reasoning, struct, itok, otok = await service._run_verifier(
            agent_id="a",
            task_id="t",
            goal="g",
            model="rose-labs/rose-1-lite",
            terminal=terminal,
            action_summary=[],
            output_schema={"fields": []},
            claude_token=None,
        )
    assert score == 0.5
    assert "Verification failed" in reasoning
    assert struct is None
    assert itok == 0 and otok == 0


async def test_run_verifier_uses_code_event_json_for_codex_context():
    """Codex verification uses normalized event JSON rather than terminal evidence shortcuts."""
    from domains.spawn_claude_code_agent import service
    from utils.terminal_filter import TerminalFilter

    terminal = TerminalFilter(cols=200, rows=50)
    terminal.feed(
        "[Codex file_change completed] add /home/user/collatz_3.py\n"
        "[Codex command output]\n3\n10\n5\n16\n8\n4\n2\n1\nsteps: 7\n[Codex exit_code] 0\n"
    )

    seen_context = {}

    async def fake_activity(fn, *, args, **_kwargs):
        seen_context["context"] = args[0]
        return {
            "score": 1.0,
            "reasoning": "grounded in sdk json",
            "structured_response": {"step_count": 7},
            "usage": {"prompt_tokens": 11, "completion_tokens": 5},
        }

    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    with (
        patch("loop.activity_helper.call_temporal_activity_from_activity", side_effect=fake_activity),
        patch("temporalio.activity.heartbeat"),
    ):
        score, reasoning, struct, itok, otok = await service._run_verifier(
            agent_id="a",
            task_id="t",
            goal="Compute Collatz from 3",
            model="rose-labs/rose-1-lite",
            terminal=terminal,
            action_summary=[],
            output_schema={
                "fields": [
                    {"name": "program_file", "type": "file_pointer", "description": "Created Python script file."},
                    {"name": "collatz_sequence", "type": "list[int]", "description": "Collatz sequence"},
                    {"name": "step_count", "type": "int", "description": "total step count"},
                ]
            },
            claude_token=None,
            code_provider="codex",
            exit_code=0,
            code_events=[
                {
                    "version": 1,
                    "provider": "codex",
                    "type": "command",
                    "output": "3\n10\n5\n16\n8\n4\n2\n1\nsteps: 7",
                }
            ],
        )
    assert score == 1.0
    assert reasoning == "grounded in sdk json"
    assert struct == {"step_count": 7}
    assert itok == 11 and otok == 5
    assert "code_agent_events" in seen_context["context"][1]["text"]


async def test_run_verifier_truncation_override_promotes_to_pass():
    """When parent LLM signals completion AND terminal output is truncated, partial score → 1.0.

    Regression for v11 smoke claude-code-agent failure: the verifier scored 0.5
    because Claude Code's TUI collapsed the Collatz sequence ('+225 lines (ctrl+o
    to expand)'), and the parent agent re-spawned spawn_claude_code_agent on
    every retry, blowing the 114s smoke cap. The override accepts the parent
    LLM's attempt_completion=True signal as proof of completion when the visible
    terminal evidence is mechanically truncated.
    """
    from domains.spawn_claude_code_agent import service
    from utils.terminal_filter import TerminalFilter

    terminal = TerminalFilter(cols=200, rows=50)
    terminal.feed(
        "● Bash(python3 -c \"...\")\r\n"
        "  ⎿  27\r\n"
        "     82\r\n"
        "     41\r\n"
        "     … +225 lines (ctrl+o to expand)\r\n"
    )

    async def fake_activity(fn, *, args, **_kwargs):
        return {
            "score": 0.5,
            "reasoning": "Cannot ground sequence_output: only first 3 of ~113 lines visible.",
            "structured_response": {},
            "usage": {"prompt_tokens": 100, "completion_tokens": 50},
        }

    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    with (
        patch("loop.activity_helper.call_temporal_activity_from_activity", side_effect=fake_activity),
        patch("temporalio.activity.heartbeat"),
    ):
        score, reasoning, _struct, _itok, _otok = await service._run_verifier(
            agent_id="a",
            task_id="t",
            goal="Compute Collatz from 27",
            model="rose-labs/rose-1-lite",
            terminal=terminal,
            action_summary=["Parent LLM signaled task completion"],
            output_schema={"fields": [{"name": "sequence_output", "type": "string"}]},
            claude_token=None,
            attempt_completion=True,
            exit_code=None,
        )
    assert score == 1.0, f"expected truncation override to 1.0, got {score}"
    assert "override" in reasoning.lower()
    assert "attempt_completion=True" in reasoning


async def test_run_verifier_no_override_when_no_truncation():
    """Score is NOT promoted to 1.0 when terminal output isn't truncated, even if parent signaled."""
    from domains.spawn_claude_code_agent import service
    from utils.terminal_filter import TerminalFilter

    terminal = TerminalFilter(cols=80, rows=50)
    terminal.feed("Some output without any truncation marker\r\nDone\r\n")

    async def fake_activity(fn, *, args, **_kwargs):
        return {
            "score": 0.5,
            "reasoning": "Schema field missing.",
            "structured_response": {},
            "usage": {"prompt_tokens": 10, "completion_tokens": 5},
        }

    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    with (
        patch("loop.activity_helper.call_temporal_activity_from_activity", side_effect=fake_activity),
        patch("temporalio.activity.heartbeat"),
    ):
        score, _r, _s, _i, _o = await service._run_verifier(
            agent_id="a",
            task_id="t",
            goal="g",
            model="rose-labs/rose-1-lite",
            terminal=terminal,
            action_summary=[],
            output_schema={"fields": []},
            claude_token=None,
            attempt_completion=True,
            exit_code=None,
        )
    assert score == 0.5, "no truncation marker → no override; verifier score preserved"


async def test_run_verifier_no_override_when_attempt_completion_false():
    """Score NOT promoted when attempt_completion is False, even with truncation."""
    from domains.spawn_claude_code_agent import service
    from utils.terminal_filter import TerminalFilter

    terminal = TerminalFilter(cols=200, rows=50)
    terminal.feed("  ⎿  … +110 lines (ctrl+o to expand)\r\n")

    async def fake_activity(fn, *, args, **_kwargs):
        return {
            "score": 0.5,
            "reasoning": "partial",
            "structured_response": {},
            "usage": {"prompt_tokens": 10, "completion_tokens": 5},
        }

    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    with (
        patch("loop.activity_helper.call_temporal_activity_from_activity", side_effect=fake_activity),
        patch("temporalio.activity.heartbeat"),
    ):
        score, _r, _s, _i, _o = await service._run_verifier(
            agent_id="a",
            task_id="t",
            goal="g",
            model="rose-labs/rose-1-lite",
            terminal=terminal,
            action_summary=[],
            output_schema={"fields": []},
            claude_token=None,
            attempt_completion=False,
            exit_code=None,
        )
    assert score == 0.5, "no attempt_completion signal → no override"


async def test_run_verifier_no_override_when_already_passing():
    """Score 1.0 stays 1.0; no double-rewrite of reasoning."""
    from domains.spawn_claude_code_agent import service
    from utils.terminal_filter import TerminalFilter

    terminal = TerminalFilter(cols=200, rows=50)
    terminal.feed("  ⎿  … +110 lines (ctrl+o to expand)\r\n")

    async def fake_activity(fn, *, args, **_kwargs):
        return {
            "score": 1.0,
            "reasoning": "All fields populated.",
            "structured_response": {},
            "usage": {"prompt_tokens": 10, "completion_tokens": 5},
        }

    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    with (
        patch("loop.activity_helper.call_temporal_activity_from_activity", side_effect=fake_activity),
        patch("temporalio.activity.heartbeat"),
    ):
        score, reasoning, _s, _i, _o = await service._run_verifier(
            agent_id="a",
            task_id="t",
            goal="g",
            model="rose-labs/rose-1-lite",
            terminal=terminal,
            action_summary=[],
            output_schema={"fields": []},
            claude_token=None,
            attempt_completion=True,
            exit_code=None,
        )
    assert score == 1.0
    assert "override" not in reasoning.lower(), "should not annotate already-passing reasoning"


# ── _run_agentic_loop ────────────────────────────────────────────────


class _FakeWsClient:
    """Minimal ClaudeCodeWsClient stand-in driven by the loop."""

    def __init__(
        self,
        ws_url,
        on_output,
        on_exit,
        on_connection_change,
        on_stdin_error,
        on_event=None,
        heartbeat_fn=None,
    ):
        self.on_output = on_output
        self.on_exit = on_exit
        self.on_event = on_event
        self._reconnects_exhausted = False
        self._connected = True
        self._sent = []

    async def connect(self):
        return True

    async def listen(self):
        # Feed output so silence detection kicks in, then exit immediately.
        await self.on_output("hello from terminal", True)
        if self.on_event:
            await self.on_event({"version": 1, "provider": "claude", "type": "session"})
        await self.on_exit(0)

    async def send_stdin(self, data):
        self._sent.append(data)
        return True

    @property
    def reconnects_exhausted(self):
        return self._reconnects_exhausted


async def test_run_agentic_loop_exit_zero_completes():
    """When process exits, the loop returns the exit code cleanly."""
    from domains.spawn_claude_code_agent import service
    from utils.terminal_filter import TerminalFilter

    terminal = TerminalFilter(cols=80, rows=50)
    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})

    with (
        patch.object(service, "ClaudeCodeWsClient", _FakeWsClient),
        patch("temporalio.activity.heartbeat"),
    ):
        exit_code, attempt, history, itok, otok, events = await service._run_agentic_loop(
            agent_id="a",
            task_id="t",
            sandbox_id="sb",
            goal="g",
            ws_url="wss://x",
            terminal=terminal,
            model="rose-labs/rose-1-lite",
            claude_token=None,
            action_summary=[],
            tool_call_id="tc",
        )
    assert exit_code == 0
    assert attempt is False
    assert itok == 0 and otok == 0
    assert events == [{"version": 1, "provider": "claude", "type": "session"}]


async def test_run_agentic_loop_connect_fail_raises():
    """If WS client fails to connect, loop raises."""
    from domains.spawn_claude_code_agent import service
    from utils.terminal_filter import TerminalFilter

    class BadClient(_FakeWsClient):
        async def connect(self):
            return False

    terminal = TerminalFilter(cols=80, rows=50)
    with (
        patch.object(service, "ClaudeCodeWsClient", BadClient),
        patch("temporalio.activity.heartbeat"),
    ):
        try:
            await service._run_agentic_loop(
                agent_id="a",
                task_id="t",
                sandbox_id="sb",
                goal="g",
                ws_url="wss://x",
                terminal=terminal,
                model="m",
                claude_token=None,
                action_summary=[],
                tool_call_id="tc",
            )
            raise AssertionError("should raise")
        except Exception as e:
            assert "Failed to connect" in str(e)


def test_log_code_agent_event_promotes_codex_fast_cache_request():
    """Codex proxy events are promoted into worker logs with cache details."""
    from domains.spawn_claude_code_agent import service

    fake_logger = MagicMock()
    with patch.object(service, "logger", fake_logger):
        service._log_code_agent_event(
            {
                "version": 1,
                "provider": "codex",
                "type": "fast_cache_proxy_request",
                "method": "POST",
                "path": "/backend-api/codex/responses",
                "status": 200,
                "cache": "miss",
            },
            agent_id="agent-1",
            task_id="task-1",
            sandbox_id="sandbox-1",
        )

    fake_logger.info.assert_called_once()
    args, kwargs = fake_logger.info.call_args
    assert args[0] == "[ClaudeCode] Codex Fast Mode proxy request"
    assert kwargs["agent_id"] == "agent-1"
    assert kwargs["task_id"] == "task-1"
    assert kwargs["sandbox_id"] == "sandbox-1"
    assert kwargs["path"] == "/backend-api/codex/responses"
    assert kwargs["cache"] == "miss"


def test_codex_completed_turn_count_counts_unique_turn_completed_events():
    """Codex completed turns come from turn.completed SDK events, not status heartbeats."""
    from domains.spawn_claude_code_agent import service

    events = [
        {"version": 1, "provider": "codex", "type": "usage", "raw_type": "turn.completed", "timestamp": "t1"},
        {"version": 1, "provider": "codex", "type": "usage", "raw_type": "turn.completed", "timestamp": "t1"},
        {"version": 1, "provider": "codex", "type": "usage", "raw_type": "turn.completed", "timestamp": "t2"},
        {"version": 1, "provider": "codex", "type": "turn", "status": "started", "timestamp": "t3"},
        {"version": 1, "provider": "claude", "type": "usage", "raw_type": "turn.completed", "timestamp": "t4"},
    ]

    assert service.codex_completed_turn_count(events) == 2


# ── spawn_claude_code_activity ───────────────────────────────────────


async def test_spawn_activity_requires_output_schema():
    """Missing output_schema raises ValueError before any sandbox work."""
    from domains.spawn_claude_code_agent import service

    try:
        await service.spawn_claude_code_activity(
            user_id="u",
            agent_id="a",
            goal="g",
            tool_call_id="tc",
            output_schema=None,
        )
        raise AssertionError("should raise")
    except ValueError as e:
        assert "output_schema is required" in str(e)


async def test_spawn_activity_happy_path_end_to_end():
    """Full happy path of spawn_claude_code_activity, mocking all I/O boundaries."""
    from domains.spawn_claude_code_agent import service
    from utils.terminal_filter import TerminalFilter

    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})

    # Avoid real SandboxLogCollector
    fake_collector = AsyncMock()
    fake_collector.start = AsyncMock()
    fake_collector.stop = AsyncMock()
    seen_create_session = {}

    async def fake_create_session(**kwargs):
        seen_create_session.update(kwargs)
        return {
            "task_id": "task-x",
            "sandbox_id": "sb",
            "ws_url": "wss://x",
            "uploaded_files": [{"name": "f.txt"}],
            "github_repo_url": "https://github.com/o/r",
        }

    # B2/C12: success requires score >= 1.0 (matching unified verifier semantics).
    async def fake_verifier(**kwargs):
        return (1.0, "great", {"out": {"path": "/home/user/output/a.txt"}}, 10, 4)

    async def fake_loop(**kwargs):
        return (0, False, [], 5, 3, [{"version": 1, "provider": "claude", "type": "session"}])

    async def fake_persist(*a, **kw):
        return None

    async def fake_close(**kwargs):
        return {
            "output_files": [{"id": "f1", "path": "/home/user/output/a.txt"}],
            "usage": {
                "inputTokens": 5,
                "outputTokens": 6,
                "cacheReadInputTokens": 0,
                "cacheCreationInputTokens": 0,
            },
        }

    fake_pricing = {"input_cents_per_1k": 0.1, "output_cents_per_1k": 0.2}

    with (
        patch.object(service, "SandboxLogCollector", lambda *a, **kw: fake_collector),
        patch.object(service, "create_e2b_session", side_effect=fake_create_session),
        patch.object(service, "_run_agentic_loop", side_effect=fake_loop),
        patch.object(service, "_run_verifier", side_effect=fake_verifier),
        patch.object(service, "persist_terminal_output", side_effect=fake_persist),
        patch.object(service, "close_e2b_session", side_effect=fake_close),
        patch(
            "helpers.model_pricing.get_model_pricing_with_fallback",
            AsyncMock(return_value=fake_pricing),
        ),
        patch(
            "helpers.file_resolution.resolve_file_pointers_from_extracted",
            lambda **kw: kw["structured_response"],
        ),
        patch("temporalio.activity.heartbeat"),
    ):
        result = await service.spawn_claude_code_activity(
            user_id="u",
            agent_id="a",
            goal="write hello",
            tool_call_id="tc",
            output_schema={"fields": [{"name": "out", "type": "file_pointer"}]},
            attachments=[{"id": "att-1"}],
            model="rose-labs/rose-1-lite",
            github_repo_url="https://github.com/o/r",
            fast_mode_cache_enabled=True,
        )
    assert result["status"] == "completed"
    assert result["success"] is True
    assert result["task_id"] == "task-x"
    assert result["structured_response"] == {"out": {"path": "/home/user/output/a.txt"}}
    # Usage items include LLM + service rows
    assert any(u["type"] == "llm" for u in result["usage_items"])
    assert any(u["type"] == "service" for u in result["usage_items"])
    assert result["output_files"] == [{"id": "f1", "path": "/home/user/output/a.txt"}]
    assert seen_create_session["fast_mode_cache_enabled"] is True
    fake_collector.start.assert_awaited()
    fake_collector.stop.assert_awaited()


async def test_spawn_activity_cancelled_cleanup():
    """CancelledError triggers cleanup path and returns 'cancelled' status."""
    from domains.spawn_claude_code_agent import service

    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})

    fake_collector = AsyncMock()
    fake_collector.start = AsyncMock()
    fake_collector.stop = AsyncMock()

    async def fake_create_session(**kwargs):
        return {
            "task_id": "t",
            "sandbox_id": "sb",
            "ws_url": "wss://x",
            "uploaded_files": [],
            "github_repo_url": None,
        }

    async def fake_loop(**kwargs):
        raise asyncio.CancelledError()

    async def fake_close(**kwargs):
        return {}

    with (
        patch.object(service, "SandboxLogCollector", lambda *a, **kw: fake_collector),
        patch.object(service, "create_e2b_session", side_effect=fake_create_session),
        patch.object(service, "_run_agentic_loop", side_effect=fake_loop),
        patch.object(service, "close_e2b_session", side_effect=fake_close),
        patch.object(service, "persist_terminal_output", AsyncMock()),
        patch(
            "helpers.model_pricing.get_model_pricing_with_fallback",
            AsyncMock(return_value={"input_cents_per_1k": 0, "output_cents_per_1k": 0}),
        ),
        patch("temporalio.activity.heartbeat"),
    ):
        result = await service.spawn_claude_code_activity(
            user_id="u",
            agent_id="a",
            goal="g",
            tool_call_id="tc",
            output_schema={"fields": []},
        )
    assert result["status"] == "cancelled"
    assert result["task_id"] == "t"
    fake_collector.stop.assert_awaited()


async def test_spawn_activity_error_reraises_after_cleanup():
    """On non-cancel exception, the activity re-raises after attempting cleanup."""
    from domains.spawn_claude_code_agent import service

    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})

    fake_collector = AsyncMock()
    fake_collector.start = AsyncMock()
    fake_collector.stop = AsyncMock()

    async def fake_create_session(**kwargs):
        return {
            "task_id": "tx",
            "sandbox_id": "sb",
            "ws_url": "wss://x",
            "uploaded_files": [],
            "github_repo_url": None,
        }

    async def fake_loop(**kwargs):
        raise RuntimeError("loop-fail")

    async def fake_close(**kwargs):
        return {}

    with (
        patch.object(service, "SandboxLogCollector", lambda *a, **kw: fake_collector),
        patch.object(service, "create_e2b_session", side_effect=fake_create_session),
        patch.object(service, "_run_agentic_loop", side_effect=fake_loop),
        patch.object(service, "close_e2b_session", side_effect=fake_close),
        patch(
            "helpers.model_pricing.get_model_pricing_with_fallback",
            AsyncMock(return_value={"input_cents_per_1k": 0, "output_cents_per_1k": 0}),
        ),
        patch("temporalio.activity.heartbeat"),
    ):
        try:
            await service.spawn_claude_code_activity(
                user_id="u",
                agent_id="a",
                goal="g",
                tool_call_id="tc",
                output_schema={"fields": []},
            )
            raise AssertionError("should raise")
        except RuntimeError as e:
            assert "loop-fail" in str(e)
    fake_collector.stop.assert_awaited()


# ── SpawnClaudeCodeAgentManager.execute_tool ──────────────────────────


class _FakeActivityHandle:
    """Stand-in for Temporal activity handle returned by start_activity."""

    def __init__(self, result=None, raise_exc=None):
        self._result = result
        self._raise_exc = raise_exc
        self._cancelled = False

    def done(self):
        return True  # Already done so wait_condition exits immediately

    def cancel(self):
        self._cancelled = True

    def __await__(self):
        async def _inner():
            if self._raise_exc is not None:
                raise self._raise_exc
            return self._result

        return _inner().__await__()


class _FakeCCWorkflow:
    """Stand-in for temporalio.workflow inside spawn_claude_code_agent handler."""

    class ActivityCancellationType:
        TRY_CANCEL = "TRY_CANCEL"

    def __init__(self, activity_handle):
        self._handle = activity_handle
        self.started_activity_args = None

    def start_activity(self, fn, args=None, **kwargs):
        self.started_activity_args = args
        return self._handle

    async def wait_condition(self, predicate):
        return None


def _patch_cc_workflow(fake):
    import domains.spawn_claude_code_agent.handler as h

    original = h.workflow
    h.workflow = fake

    def restore():
        h.workflow = original

    return restore


class _FakeCCWorkflowInstance:
    def __init__(self, is_paused=False):
        self.user_id = "u-1"
        self.agent_id = "agent-cc"
        self.model = "rose-labs/rose-1-lite"
        self.claude_max_token = None
        self.is_paused = is_paused


async def _collect_cc_events(gen):
    events = []
    async for e in gen:
        events.append(e)
    return events


async def test_cc_execute_tool_happy_path_yields_finished():
    """Successful activity yields IN_PROGRESS then FINISHED with usage data."""
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager
    from tools.base import MessageStatus

    handle = _FakeActivityHandle(
        result={
            "success": True,
            "message": "Completed refactor",
            "task_id": "t-1",
            "structured_response": {"ok": True},
            "output_files": [],
            "usage_items": [
                {
                    "type": "llm",
                    "input_tokens": 100,
                    "output_tokens": 50,
                    "model": "claude",
                    "provider": "anthropic",
                },
                {"type": "service", "cost_cents": 0.05, "provider": "e2b"},
            ],
        }
    )
    fake = _FakeCCWorkflow(handle)
    restore = _patch_cc_workflow(fake)
    try:
        manager = SpawnClaudeCodeAgentManager()
        events = await _collect_cc_events(
            manager.execute_tool(
                _FakeCCWorkflowInstance(),
                {"goal": "refactor foo", "attachments": None},
                "tc-cc",
            )
        )
    finally:
        restore()

    statuses = [getattr(e, "status", None) for e in events]
    assert MessageStatus.IN_PROGRESS in statuses
    assert MessageStatus.FINISHED in statuses
    finished = [e for e in events if getattr(e, "status", None) == MessageStatus.FINISHED][0]
    assert finished.title.startswith("\u2713")  # Checkmark
    assert finished.metadata["task_id"] == "t-1"
    assert finished.metadata["success"] is True
    assert finished.data["usage"]["llm"][0]["tokens_in"] == 100
    assert finished.data["usage"]["service"][0]["cost_cents"] == 0.05


async def test_cc_execute_tool_forced_claude_fetches_matching_credential():
    """Forced Claude must not send a GPT-only workflow through shared API billing."""
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager

    handle = _FakeActivityHandle(result={"success": True, "message": "ok", "output_files": []})

    class _ForcedClaudeWorkflow(_FakeCCWorkflow):
        def __init__(self):
            super().__init__(handle)
            self.credential_fetches = 0

        async def execute_activity(self, fn, args=None, **kwargs):
            self.credential_fetches += 1
            assert fn.__name__ == "fetch_claude_max_token_activity"
            assert args == ["u-1"]
            return {"accessToken": "fresh-claude-token", "source": "pool"}

    fake = _ForcedClaudeWorkflow()
    restore = _patch_cc_workflow(fake)
    wf = _FakeCCWorkflowInstance()
    wf.compute_token_provider = "gpt"
    wf.gpt_code_token = "active-gpt-token"

    try:
        with patch.dict(os.environ, {"ROSE_CODE_AGENT_PROVIDER": "claude"}):
            manager = SpawnClaudeCodeAgentManager()
            await _collect_cc_events(manager.execute_tool(wf, {"goal": "g"}, "tc-forced-claude"))
    finally:
        restore()

    assert fake.credential_fetches == 1
    assert fake.started_activity_args[8] == "fresh-claude-token"
    assert fake.started_activity_args[9] == "claude"
    assert fake.started_activity_args[10] == "active-gpt-token"


async def test_cc_execute_tool_incomplete_success_false_title():
    """success=False yields 'Task Incomplete' title."""
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager
    from tools.base import MessageStatus

    handle = _FakeActivityHandle(
        result={
            "success": False,
            "message": "Couldn't finish",
            "task_id": "t-2",
            "output_files": [],
        }
    )
    fake = _FakeCCWorkflow(handle)
    restore = _patch_cc_workflow(fake)
    try:
        manager = SpawnClaudeCodeAgentManager()
        events = await _collect_cc_events(
            manager.execute_tool(
                _FakeCCWorkflowInstance(),
                {"goal": "g"},
                "tc-inc",
            )
        )
    finally:
        restore()

    finished = [e for e in events if getattr(e, "status", None) == MessageStatus.FINISHED][0]
    assert finished.title == "Task Incomplete"
    assert finished.metadata["success"] is False


async def test_cc_execute_tool_emits_assistant_events_for_files():
    """output_files yield AssistantEvent only after FINISHED resolves the tool call."""
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager
    from tools.base import AssistantEvent, MessageStatus

    handle = _FakeActivityHandle(
        result={
            "success": True,
            "message": "ok",
            "output_files": [{"id": "fp1"}, {"id": "fp2"}],
        }
    )
    fake = _FakeCCWorkflow(handle)
    restore = _patch_cc_workflow(fake)
    try:
        manager = SpawnClaudeCodeAgentManager()
        events = await _collect_cc_events(
            manager.execute_tool(
                _FakeCCWorkflowInstance(),
                {"goal": "g"},
                "tc-files",
            )
        )
    finally:
        restore()

    assistant_events = [e for e in events if isinstance(e, AssistantEvent)]
    assert len(assistant_events) == 2
    assert {e.file_pointer["id"] for e in assistant_events} == {"fp1", "fp2"}
    finished_index = next(i for i, e in enumerate(events) if getattr(e, "status", None) == MessageStatus.FINISHED)
    first_assistant_index = next(i for i, e in enumerate(events) if isinstance(e, AssistantEvent))
    assert finished_index < first_assistant_index


async def test_cc_execute_tool_cancelled_status_yields_error():
    """Activity returning status='cancelled' yields an ERROR event."""
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager
    from tools.base import MessageStatus

    handle = _FakeActivityHandle(result={"status": "cancelled", "message": "cancelled"})
    fake = _FakeCCWorkflow(handle)
    restore = _patch_cc_workflow(fake)
    try:
        manager = SpawnClaudeCodeAgentManager()
        events = await _collect_cc_events(
            manager.execute_tool(
                _FakeCCWorkflowInstance(),
                {"goal": "g"},
                "tc-cancel",
            )
        )
    finally:
        restore()

    error = next(e for e in events if getattr(e, "status", None) == MessageStatus.ERROR)
    assert "Cancelled" in error.title or "cancelled" in error.title.lower()


async def test_cc_execute_tool_cancelled_error_path():
    """CancelledError on activity_handle await yields Cancelled Session ERROR."""
    import asyncio as asyncio_mod

    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager
    from tools.base import MessageStatus

    handle = _FakeActivityHandle(raise_exc=asyncio_mod.CancelledError())
    fake = _FakeCCWorkflow(handle)
    restore = _patch_cc_workflow(fake)
    try:
        manager = SpawnClaudeCodeAgentManager()
        events = await _collect_cc_events(
            manager.execute_tool(
                _FakeCCWorkflowInstance(),
                {"goal": "g"},
                "tc-cancelled-err",
            )
        )
    finally:
        restore()

    error = next(e for e in events if getattr(e, "status", None) == MessageStatus.ERROR)
    assert "Cancelled" in error.title


async def test_cc_execute_tool_generic_exception_yields_error():
    """Non-cancellation exception yields provider-specific code-session error event."""
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager
    from tools.base import MessageStatus

    handle = _FakeActivityHandle(raise_exc=RuntimeError("activity failed badly"))
    fake = _FakeCCWorkflow(handle)
    restore = _patch_cc_workflow(fake)
    try:
        manager = SpawnClaudeCodeAgentManager()
        events = await _collect_cc_events(
            manager.execute_tool(
                _FakeCCWorkflowInstance(),
                {"goal": "g"},
                "tc-exc",
            )
        )
    finally:
        restore()

    error = next(e for e in events if getattr(e, "status", None) == MessageStatus.ERROR)
    assert "Code session failed" in error.title
    assert "activity failed badly" in error.message
    assert error.metadata["code_provider"] == "claude"


async def test_cc_execute_tool_paused_cancels_activity():
    """is_paused=True triggers activity_handle.cancel() and cancelled path."""
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager
    from tools.base import MessageStatus

    class _PausedHandle(_FakeActivityHandle):
        def done(self):
            return False  # Not done, so the pause branch cancels it

    handle = _PausedHandle(result={"status": "cancelled", "message": "paused"})
    fake = _FakeCCWorkflow(handle)
    restore = _patch_cc_workflow(fake)
    try:
        wf = _FakeCCWorkflowInstance(is_paused=True)
        manager = SpawnClaudeCodeAgentManager()
        events = await _collect_cc_events(
            manager.execute_tool(wf, {"goal": "g"}, "tc-pause")
        )
    finally:
        restore()

    assert handle._cancelled is True
    error = next(e for e in events if getattr(e, "status", None) == MessageStatus.ERROR)
    assert "Cancelled" in error.title


async def run_all_tests():
    print("spawn-claude-code-agent blackbox tests:")
    r = BlackboxResult()
    await r.record_async("session_create_mock", test_claude_code_session_create_mock)
    await r.record_async("session_health_mock", test_claude_code_session_health_mock)
    # pure helpers
    r.record("check_fatal_none", test_check_fatal_errors_none)
    r.record("check_fatal_auth", test_check_fatal_errors_auth_error)
    r.record("check_fatal_401", test_check_fatal_errors_api_401)
    r.record("check_fatal_login", test_check_fatal_errors_login_request)
    r.record("check_fatal_credit_balance", test_check_fatal_errors_credit_balance)
    r.record("check_fatal_credit_balance_real_wording", test_check_fatal_errors_credit_balance_real_wording)
    r.record("check_fatal_rate_limit_options", test_check_fatal_errors_rate_limit_options)
    r.record("verifier_timeout_standard_llm_budget", test_verifier_activity_timeout_allows_llm_call)
    r.record("safe_time_ok", test_safe_time_returns_float)
    r.record("safe_time_fallback", test_safe_time_handles_exception)
    r.record("trunc_detect_marker", test_terminal_truncation_detects_collapse_marker)
    r.record("trunc_detect_high_count", test_terminal_truncation_detects_high_line_count)
    r.record("trunc_no_marker", test_terminal_truncation_no_marker_returns_false)
    r.record("trunc_handles_empty", test_terminal_truncation_handles_empty_output)
    r.record("codex_evidence_summary", test_codex_evidence_summary_extracts_paths_and_commands)
    r.record("codex_structured_fallback", test_codex_structured_response_synthesizes_all_fields)
    r.record("codex_structured_json_steps", test_codex_structured_response_uses_json_step_field)
    r.record(
        "codex_structured_prefers_final_sequence",
        test_codex_structured_response_prefers_unwrapped_final_sequence,
    )
    r.record(
        "codex_structured_printed_sequence",
        test_codex_structured_response_parses_printed_sequence_and_steps_label,
    )
    r.record("context_summary_success", test_build_context_summary_success)
    r.record("context_summary_failure", test_build_context_summary_failure_with_error)
    r.record("context_summary_truncates", test_build_context_summary_truncates_actions)
    r.record("context_summary_empty", test_build_context_summary_empty_actions)
    # extract_additional_paths
    r.record("extract_paths_none_inputs", test_extract_additional_paths_none_structured)
    r.record("extract_paths_file_pointer", test_extract_additional_paths_file_pointer)
    r.record("extract_paths_list", test_extract_additional_paths_list_file_pointer)
    r.record("extract_paths_skip_unknown", test_extract_additional_paths_skips_unknown_fields)
    r.record("extract_paths_missing_meta", test_extract_additional_paths_missing_name_or_type)
    r.record("extract_paths_non_dict", test_extract_additional_paths_non_dict_value)
    r.record("structured_from_output_single", test_structured_response_from_output_files_single_pointer)
    r.record("structured_from_output_rejects_non_file", test_structured_response_from_output_files_rejects_non_file_schema)
    r.record("code_event_context_json", test_build_code_event_context_uses_json_and_extracted_files)
    # build_usage_items
    r.record("usage_items_both", test_build_usage_items_both_llm_and_service)
    r.record("usage_items_no_tokens", test_build_usage_items_no_tokens)
    # call_parent_llm
    await r.record_async("call_parent_llm_completion", test_call_parent_llm_completion)
    await r.record_async("call_parent_llm_continue", test_call_parent_llm_continue)
    await r.record_async("call_parent_llm_exception_safe", test_call_parent_llm_exception_safe)
    await r.record_async("call_parent_llm_attachments_hint", test_call_parent_llm_with_attachments_history)
    # repo
    await r.record_async("repo_save_msg_init", test_repo_save_message_posts_json)
    await r.record_async("repo_save_msg_noninit", test_repo_save_message_non_init_has_subagent)
    await r.record_async("repo_save_msg_error", test_repo_save_message_error_flag)
    await r.record_async("repo_save_msg_swallows", test_repo_save_message_swallows_http_errors)
    await r.record_async("repo_create_session_happy", test_repo_create_e2b_session_happy)
    await r.record_async("repo_create_session_codex", test_repo_create_e2b_session_codex_provider)
    await r.record_async("repo_create_session_raises", test_repo_create_e2b_session_raises_on_error)
    await r.record_async("repo_persist_output_happy", test_repo_persist_terminal_output_happy)
    await r.record_async("repo_persist_output_swallows", test_repo_persist_terminal_output_swallows_errors)
    await r.record_async("repo_close_session_happy", test_repo_close_e2b_session_happy)
    await r.record_async("repo_close_session_non200", test_repo_close_e2b_session_non_200_returns_empty)
    await r.record_async("repo_health_happy", test_repo_check_sandbox_health_happy)
    await r.record_async("repo_health_non200", test_repo_check_sandbox_health_non_200_returns_none)
    await r.record_async("repo_health_exception", test_repo_check_sandbox_health_http_exception_returns_none)
    # handler
    r.record("handler_fp_to_dict", test_handler_fp_to_dict)
    r.record("handler_resolve_no_context", test_handler_resolve_attachments_no_context)
    r.record("handler_resolve_explicit", test_handler_resolve_attachments_explicit_match)
    r.record("handler_resolve_auto_forward_none", test_handler_resolve_attachments_auto_forward_none_requested)
    r.record("handler_resolve_fallback_all", test_handler_resolve_attachments_auto_forward_when_none_match)
    r.record("handler_resolve_match_by_id", test_handler_resolve_attachments_match_by_id)
    r.record("handler_get_manager_singleton", test_handler_get_manager_singleton)
    r.record("handler_select_codex_for_gpt", test_handler_select_code_provider_uses_codex_for_gpt_compute)
    r.record("handler_select_env_forces_claude", test_handler_select_code_provider_env_override_forces_claude)
    r.record("handler_select_claude_without_gpt", test_handler_select_code_provider_keeps_claude_without_gpt_token)
    # _handle_reconnect_exhausted
    await r.record_async("handle_reconnect_alive", test_handle_reconnect_exhausted_alive_sandbox)
    await r.record_async("handle_reconnect_dead", test_handle_reconnect_exhausted_dead_sandbox)
    await r.record_async("handle_reconnect_health_none", test_handle_reconnect_exhausted_health_none)
    # _run_verifier
    await r.record_async("run_verifier_happy", test_run_verifier_happy_path)
    await r.record_async("run_verifier_exception", test_run_verifier_exception_fallback)
    await r.record_async(
        "run_verifier_codex_event_json",
        test_run_verifier_uses_code_event_json_for_codex_context,
    )
    await r.record_async(
        "run_verifier_truncation_override", test_run_verifier_truncation_override_promotes_to_pass
    )
    await r.record_async("run_verifier_no_override_no_trunc", test_run_verifier_no_override_when_no_truncation)
    await r.record_async(
        "run_verifier_no_override_no_attempt", test_run_verifier_no_override_when_attempt_completion_false
    )
    await r.record_async("run_verifier_no_override_already_pass", test_run_verifier_no_override_when_already_passing)
    # _run_agentic_loop
    await r.record_async("run_agentic_loop_exit_zero", test_run_agentic_loop_exit_zero_completes)
    await r.record_async("run_agentic_loop_connect_fail", test_run_agentic_loop_connect_fail_raises)
    r.record("log_codex_fast_cache_event", test_log_code_agent_event_promotes_codex_fast_cache_request)
    r.record("codex_completed_turn_count", test_codex_completed_turn_count_counts_unique_turn_completed_events)
    # spawn_claude_code_activity
    await r.record_async("spawn_activity_requires_schema", test_spawn_activity_requires_output_schema)
    await r.record_async("spawn_activity_happy", test_spawn_activity_happy_path_end_to_end)
    await r.record_async("spawn_activity_cancelled", test_spawn_activity_cancelled_cleanup)
    await r.record_async("spawn_activity_error_reraises", test_spawn_activity_error_reraises_after_cleanup)
    # SpawnClaudeCodeAgentManager.execute_tool
    await r.record_async("cc_exec_happy", test_cc_execute_tool_happy_path_yields_finished)
    await r.record_async(
        "cc_exec_forced_claude_credential",
        test_cc_execute_tool_forced_claude_fetches_matching_credential,
    )
    await r.record_async("cc_exec_incomplete", test_cc_execute_tool_incomplete_success_false_title)
    await r.record_async("cc_exec_files", test_cc_execute_tool_emits_assistant_events_for_files)
    await r.record_async("cc_exec_cancel_status", test_cc_execute_tool_cancelled_status_yields_error)
    await r.record_async("cc_exec_cancel_error", test_cc_execute_tool_cancelled_error_path)
    await r.record_async("cc_exec_generic_exc", test_cc_execute_tool_generic_exception_yields_error)
    await r.record_async("cc_exec_paused", test_cc_execute_tool_paused_cancels_activity)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
