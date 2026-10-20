"""Blackbox tests for spawn-claude-code-agent domain.

Complex orchestrator with many endpoints. We test the session
create and health-check boundaries, pure helpers, repo HTTP
behaviour, and the attachment-resolution logic in the handler.
"""

import asyncio
import contextlib
import dataclasses
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
from pathlib import Path
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


def test_codex_oauth_usage_limit_is_terminal_only_after_failed_fallback():
    """OAuth exhaustion may recover through the funded-key fallback."""
    from domains.spawn_claude_code_agent.service import (
        check_fatal_errors,
        check_terminal_fatal_error,
    )

    output = (
        "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage "
        "to purchase more credits or try again at Jul 30th, 2026 3:23 PM."
    )
    assert check_fatal_errors(output) is None
    assert check_terminal_fatal_error(output, code_provider="codex", exit_code=0) is None
    msg = check_terminal_fatal_error(output, code_provider="codex", exit_code=1)
    assert msg is not None and "runtime fallback" in msg


def test_check_fatal_errors_codex_funded_key_quota():
    """Quota wording may recover, but remains terminal after a failed process."""
    from domains.spawn_claude_code_agent.service import (
        check_fatal_errors,
        check_terminal_fatal_error,
    )

    output = "Quota exceeded. Check your plan and billing details."
    assert check_fatal_errors(output) is None
    assert check_terminal_fatal_error(output, code_provider="codex", exit_code=0) is None
    msg = check_terminal_fatal_error(output, code_provider="codex", exit_code=1)
    assert msg is not None and "out of quota" in msg


def test_build_codex_credential_feedback_preserves_fallback_order():
    """Structured feedback retains both sources independently of terminal rows."""
    from domains.spawn_claude_code_agent.service import build_codex_credential_feedback

    events = [
        {
            "provider": "codex",
            "type": "error",
            "message": "Quota exceeded. Check your plan and billing details.",
        },
        {
            "provider": "codex",
            "type": "auth_fallback",
            "from": "chatgpt_oauth",
            "to": "openai_api_key",
            "reason": "usage_limit_reached",
        },
        {
            "provider": "codex",
            "type": "error",
            "message": "insufficient_quota",
        },
    ]
    assert build_codex_credential_feedback(events) == [
        {
            "source": "oauth",
            "reason": "Quota exceeded. Check your plan and billing details.",
        },
        {"source": "funded_api_key", "reason": "insufficient_quota"},
    ]


def test_codex_feedback_captures_funding_errors_from_native_events():
    """Native funding failures survive structured feedback for either key source."""
    from domains.spawn_claude_code_agent.service import build_codex_credential_feedback

    fallback = {
        "provider": "codex", "type": "auth_fallback", "reason": "oauth_refresh_invalid"
    }
    for message in (
        "You have no credits remaining.",
        "Add credits to continue.",
        "credit_balance_exhausted",
        "Your credit balance is too low.",
    ):
        for nested in (False, True):
            error = {"provider": "codex", "type": "error"}
            error.update({"error": {"message": message}} if nested else {"message": message})
            assert build_codex_credential_feedback([error]) == [
                {"source": "initial", "reason": message}
            ]
            assert build_codex_credential_feedback([fallback, error]) == [
                {"source": "oauth", "reason": "oauth_refresh_invalid"},
                {"source": "funded_api_key", "reason": message},
            ]


def test_codex_feedback_ignores_printed_funding_text():
    """Only native Codex error events can authorize a funding cooldown."""
    from domains.spawn_claude_code_agent.service import build_codex_credential_feedback

    for kind in ("command_execution", "tool_result", "agent_message", "output"):
        assert build_codex_credential_feedback([
            {"provider": "codex", "type": kind, "message": "no credits remaining"}
        ]) == []
    assert build_codex_credential_feedback([
        {"provider": "claude", "type": "error", "message": "no credits remaining"}
    ]) == []
    assert build_codex_credential_feedback([
        {"provider": "codex", "type": "error", "message": "disk quota exceeded"}
    ]) == []


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
    """The deterministic shortcut returns nothing when a schema has no file fields."""
    from domains.spawn_claude_code_agent.service import _structured_response_from_output_files

    schema = {"fields": [{"name": "summary", "type": "string"}]}
    files = [{"original_filename": "report.txt"}]

    assert _structured_response_from_output_files(schema, files) is None


def test_structured_response_from_output_files_keeps_mixed_schema_file_fields():
    """Primitive fields do not prevent extracted files from satisfying file artifacts."""
    from domains.spawn_claude_code_agent.service import _structured_response_from_output_files

    schema = {
        "fields": [
            {"name": "summary", "type": "string"},
            {"name": "report", "type": "file_pointer"},
            {"name": "count", "type": "int"},
        ]
    }
    files = [{"original_filename": "report.txt"}]

    assert _structured_response_from_output_files(schema, files) == {
        "report": {"path": "/home/user/output/report.txt"}
    }


def test_code_evidence_omits_optional_sequence_outside_its_bounds():
    """An over-long optional sequence must not invalidate valid required fields."""
    from domains.spawn_claude_code_agent.service import (
        _structured_response_from_code_evidence,
        _structured_response_satisfies_declared_schema,
    )

    terminal = "\n".join(["3", "10", "5", "16", "8", "4", "2", "1", "Total steps: 7"])
    schema = {"fields": [
        {"name": "total_steps", "type": "int", "description": "total step count"},
        {"name": "collatz_sequence", "type": "list[int]", "description": "full sequence",
         "required": False, "maxItems": 3},
    ]}
    structured = _structured_response_from_code_evidence(schema, [], [], terminal)
    assert structured == {"total_steps": 7}, structured
    assert _structured_response_satisfies_declared_schema(schema, structured)
    unbounded = {"fields": [schema["fields"][0], {**schema["fields"][1], "maxItems": None}]}
    assert _structured_response_from_code_evidence(unbounded, [], [], terminal)["collatz_sequence"] == [
        3, 10, 5, 16, 8, 4, 2, 1,
    ]


def test_declared_schema_fast_path_enforces_bounds_and_nullable_fields():
    """Code child fast paths must honor the same contract as the verifier."""
    from domains.spawn_claude_code_agent.service import _structured_response_satisfies_declared_schema

    schema = {"fields": [
        {"name": "items", "type": "list[object]", "minItems": 2, "maxItems": 2,
         "properties": [{"name": "title", "type": "str", "minLength": 3}]},
        {"name": "note", "type": "str", "nullable": True},
    ]}
    valid = {"items": [{"title": "Desk"}, {"title": "Lamp"}], "note": None}
    assert _structured_response_satisfies_declared_schema(schema, valid)
    assert not _structured_response_satisfies_declared_schema(schema, {**valid, "items": valid["items"][:1]})
    assert not _structured_response_satisfies_declared_schema(schema, {**valid, "items": valid["items"] * 2})
    assert not _structured_response_satisfies_declared_schema(
        schema, {**valid, "items": [{"title": "No"}, valid["items"][1]]}
    )
    assert not _structured_response_satisfies_declared_schema(schema, {"items": valid["items"]})
    optional_integer = {"fields": [
        {"name": "items", "type": "list[str]", "required": True},
        {"name": "steps", "type": "int", "required": False},
    ]}
    assert _structured_response_satisfies_declared_schema(optional_integer, {"items": ["done"]})
    assert not _structured_response_satisfies_declared_schema(optional_integer, {"items": ["done"], "steps": None})
    assert not _structured_response_satisfies_declared_schema(optional_integer, {"items": ["done"], "steps": "three"})
    zero = {"fields": [{"name": "items", "type": "list[str]", "maxItems": 0}]}
    assert _structured_response_satisfies_declared_schema(zero, {"items": []})
    assert not _structured_response_satisfies_declared_schema(zero, {"items": ["extra"]})
    optional_empty = {"fields": [
        {"name": "items", "type": "list[str]", "required": True},
        {"name": "note", "type": "str", "required": False},
        {"name": "tags", "type": "list[str]", "required": False},
        {"name": "links", "type": "list[str]", "required": False, "minItems": 1},
    ]}
    assert _structured_response_satisfies_declared_schema(optional_empty, {"items": ["done"], "note": "", "tags": []})
    assert not _structured_response_satisfies_declared_schema(optional_empty, {"items": ["done"], "links": []})
    assert not _structured_response_satisfies_declared_schema(optional_empty, {"items": [], "note": ""})
    all_optional = {"fields": [{"name": "note", "type": "str", "required": False}]}
    assert _structured_response_satisfies_declared_schema(all_optional, None)
    assert _structured_response_satisfies_declared_schema(all_optional, {})
    assert not _structured_response_satisfies_declared_schema(optional_empty, None)


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
        model="rose-1-flash",
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
    assert llm["model"] == "rose-1-flash"
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
    """Non-init progress/chip messages include subAgentId=task_id."""
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


async def test_repo_save_message_task_complete_omits_subagent():
    """task_complete terminals omit subAgentId so parent context keeps the result.

    Cancel/DAG-cancel often leaves Session Cancelled (from save_claude_code_message)
    as the only terminal for the spawn toolCallId. Marking it subAgentId made
    is_internal_subagent_message drop it → unpaired ASSISTANT → role_alternation.
    """
    _setup()
    from domains.spawn_claude_code_agent.repo import save_claude_code_message
    from tools.base import MessageStatus

    await save_claude_code_message(
        agent_id="agent-x",
        title="Session Cancelled",
        message="Agent paused by user",
        status=MessageStatus.FINISHED,
        task_id="task-cancel",
        action_type="task_complete",
        tool_call_id="call_parent_spawn",
    )

    call = assert_captured_call(url_contains="/api/agents/", method="POST")
    body = json.loads(call["requestBody"])
    meta = body["metadata"]
    assert meta["action_type"] == "task_complete"
    assert meta["toolCallId"] == "call_parent_spawn"
    assert "subAgentId" not in meta


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
    """persist_terminal_output POSTs filtered output and compact credential feedback."""
    setup_mock({
        "/api/codex-code-session/": {"status": 200, "json": {"ok": True}},
    })
    from domains.spawn_claude_code_agent.repo import persist_terminal_output

    await persist_terminal_output(
        task_id="task-1",
        output="lots of logs",
        agent_id="agent-1",
        code_provider="codex",
        credential_feedback=[
            {
                "source": "oauth",
                "reason": "Quota exceeded. Check your plan and billing details.",
            }
        ],
    )
    call = assert_captured_call(url_contains="/api/codex-code-session/", method="POST")
    body = json.loads(call["requestBody"])
    assert body["output"] == "lots of logs"
    assert body["credential_feedback"] == [
        {
            "source": "oauth",
            "reason": "Quota exceeded. Check your plan and billing details.",
        }
    ]

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


def test_handler_select_code_provider_is_independent_of_process_environment():
    """Workflow provider selection must not change when an env override changes."""
    from domains.spawn_claude_code_agent.handler import _select_code_provider

    previous = os.environ.get("ROSE_CODE_AGENT_PROVIDER")
    os.environ["ROSE_CODE_AGENT_PROVIDER"] = "claude"
    try:
        wf = SimpleNamespace(compute_token_provider="gpt")
        assert _select_code_provider(wf, "gpt-token") == "codex"
    finally:
        if previous is None:
            os.environ.pop("ROSE_CODE_AGENT_PROVIDER", None)
        else:
            os.environ["ROSE_CODE_AGENT_PROVIDER"] = previous


def test_activity_provider_resolver_applies_valid_environment_override():
    """Activity-local resolution snapshots a valid provider override."""
    from domains.spawn_claude_code_agent.service import resolve_code_agent_provider

    with patch.dict(os.environ, {"ROSE_CODE_AGENT_PROVIDER": "claude"}):
        assert resolve_code_agent_provider("codex") == "claude"

    with patch.dict(os.environ, {"ROSE_CODE_AGENT_PROVIDER": "invalid"}):
        assert resolve_code_agent_provider("codex") == "codex"


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
            model="rose-labs/rose-1-flash",
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


async def test_run_verifier_disabled_by_env_flag():
    """ROSE_DISABLE_CODE_AGENT_VERIFIER skips the LLM verifier for claude and codex.

    Also persists non-orchestration SDK/history evidence chips so harness
    `_agent_class_step_counts` records grounded code-agent steps for judges.
    """
    from domains.spawn_claude_code_agent import service
    from utils.terminal_filter import TerminalFilter

    terminal = TerminalFilter(cols=80, rows=50)
    terminal.feed("done")
    called = {"check_progress": 0}

    async def fake_activity(*a, **kw):
        called["check_progress"] += 1
        raise AssertionError("verifier LLM must not be called when disabled")

    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    with (
        patch.dict("os.environ", {"ROSE_DISABLE_CODE_AGENT_VERIFIER": "1"}),
        patch("loop.activity_helper.call_temporal_activity_from_activity", side_effect=fake_activity),
        patch("temporalio.activity.heartbeat"),
    ):
        for provider in ("claude", "codex"):
            # A success exit cannot satisfy an unmaterialized primitive schema.
            score, reasoning, struct, itok, otok = await service._run_verifier(
                agent_id="a",
                task_id="t",
                goal="g",
                model="rose-labs/rose-1-flash",
                terminal=terminal,
                action_summary=["wrote output"],
                output_schema={"fields": [{"name": "summary", "type": "string"}]},
                claude_token=None,
                exit_code=0,
                code_provider=provider,
                output_files=[],
                code_events=[{"type": "tool_use", "name": "Bash"}],
            )
            assert score == 0.5, provider
            assert "verifier disabled" in reasoning.lower(), reasoning
            assert "incomplete" in reasoning.lower(), reasoning
            assert struct is None
            assert itok == 0 and otok == 0

            # With extracted artifacts → success without calling the LLM verifier
            score_ok, reasoning_ok, struct_ok, itok_ok, otok_ok = await service._run_verifier(
                agent_id="a",
                task_id="t",
                goal="g",
                model="rose-labs/rose-1-flash",
                terminal=terminal,
                action_summary=["wrote output", "fetched github repos"],
                output_schema={"fields": []},
                claude_token=None,
                exit_code=0,
                code_provider=provider,
                output_files=[{"path": "/home/user/output/result.json", "content": "{}"}],
                code_events=[
                    {"type": "tool_use", "name": "Bash", "input": {"command": "curl api.github.com"}},
                    {"type": "tool_result", "content": "items"},
                ],
            )
            assert score_ok == 1.0, provider
            assert "verifier disabled" in reasoning_ok.lower(), reasoning_ok
            assert struct_ok is None
            assert itok_ok == 0 and otok_ok == 0

            # Leftover artifacts from a failed process are evidence, not a
            # successful session.
            score_failed, _, _, _, _ = await service._run_verifier(
                agent_id="a",
                task_id="t",
                goal="g",
                model="rose-labs/rose-1-flash",
                terminal=terminal,
                action_summary=["process failed after writing"],
                output_schema={"fields": []},
                claude_token=None,
                exit_code=1,
                attempt_completion=False,
                code_provider=provider,
                output_files=[{"path": "/home/user/output/partial.json", "content": "{}"}],
            )
            assert score_failed == 0.5, provider

    assert called["check_progress"] == 0

    evidence_metas = []
    for call in get_captured_requests():
        if call.get("method") != "POST" or "/api/agents/" not in (call.get("url") or ""):
            continue
        body = json.loads(call["requestBody"])
        meta = body.get("metadata") or {}
        if meta.get("toolName") in {"code_agent_sdk_events", "claude_code_history"}:
            evidence_metas.append(meta)
    tool_names = {m["toolName"] for m in evidence_metas}
    assert "code_agent_sdk_events" in tool_names, evidence_metas
    assert "claude_code_history" in tool_names, evidence_metas
    assert all(m.get("agentType") == "code" for m in evidence_metas), evidence_metas
    assert all(m.get("task_id") == "t" for m in evidence_metas), evidence_metas
    assert all(m.get("subAgentId") == "t" for m in evidence_metas), evidence_metas
    assert all(int(m.get("steps_taken") or 0) > 0 for m in evidence_metas), evidence_metas
    # 2 providers × 1 schema-complete verifier call × 2 evidence chips = 4.
    assert len(evidence_metas) == 4, len(evidence_metas)



async def test_run_verifier_disabled_rejects_schema_incomplete_artifacts():
    """A partial file extraction cannot satisfy a multi-file response schema."""
    from domains.spawn_claude_code_agent import service
    from utils.terminal_filter import TerminalFilter

    terminal = TerminalFilter(cols=80, rows=50)
    terminal.feed("done")

    async def fake_activity(*_args, **_kwargs):
        raise AssertionError("disabled verifier must not call the verifier LLM")

    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    with (
        patch.dict("os.environ", {"ROSE_DISABLE_CODE_AGENT_VERIFIER": "1"}),
        patch("loop.activity_helper.call_temporal_activity_from_activity", side_effect=fake_activity),
        patch("temporalio.activity.heartbeat"),
        patch.object(
            service,
            "_persist_code_agent_judge_evidence",
            new_callable=AsyncMock,
        ) as persist_evidence,
    ):
        score, reasoning, structured, input_tokens, output_tokens = await service._run_verifier(
            agent_id="agent-partial-output",
            task_id="task-partial-output",
            goal="Write both requested output files",
            model="rose-labs/rose-1-flash",
            terminal=terminal,
            action_summary=["wrote only one requested file"],
            output_schema={
                "fields": [
                    {"name": "report", "type": "file_pointer", "required": True},
                    {"name": "manifest", "type": "file_pointer", "required": True},
                ]
            },
            claude_token=None,
            exit_code=0,
            code_provider="claude",
            output_files=[
                {
                    "original_filename": "report.txt",
                    "mime_type": "text/plain",
                    "size_bytes": 6,
                }
            ],
        )

    assert score == 0.5
    assert "incomplete" in reasoning.lower()
    assert structured is None
    assert input_tokens == 0 and output_tokens == 0
    persist_evidence.assert_not_awaited()


async def test_run_verifier_disabled_includes_sdk_event_stdout():
    """Disabled verifier must still hand Bash/Write stdout to the parent.

    Repro for smoke claude-code-agent 04977ce8 (2026-09-04): Claude Code wrote
    collatz_27.py and printed the sequence, but the skip path returned only
    'verifier disabled' with structured_response=null. The parent then spawned
    explore + two more CC sessions and hit the 164s cap.
    """
    from domains.spawn_claude_code_agent import service
    from utils.terminal_filter import TerminalFilter

    stdout = "27\n82\n41\n124\n62\n31\n94\n47\n142\n71\n214\n107\n322\n161\n484\n242\n121\n364\n182\n91\n274\n137\n412\n206\n103\n310\n155\n466\n233\n700\n350\n175\n526\n263\n790\n395\n1186\n593\n1780\n890\n445\n1336\n668\n334\n167\n502\n251\n754\n377\n1132\n566\n283\n850\n425\n1276\n638\n319\n958\n479\n1438\n719\n2158\n1079\n3238\n1619\n4858\n2429\n7288\n3644\n1822\n911\n2734\n1367\n4102\n2051\n6154\n3077\n9232\n4616\n2308\n1154\n577\n1732\n866\n433\n1300\n650\n325\n976\n488\n244\n122\n61\n184\n92\n46\n23\n70\n35\n106\n53\n160\n80\n40\n20\n10\n5\n16\n8\n4\n2\n1\nTotal steps: 111"
    terminal = TerminalFilter(cols=80, rows=50)
    terminal.feed("done")
    called = {"check_progress": 0}

    async def fake_activity(*a, **kw):
        called["check_progress"] += 1
        raise AssertionError("verifier LLM must not be called when disabled")

    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    with (
        patch.dict("os.environ", {"ROSE_DISABLE_CODE_AGENT_VERIFIER": "1"}),
        patch("loop.activity_helper.call_temporal_activity_from_activity", side_effect=fake_activity),
        patch("temporalio.activity.heartbeat"),
    ):
        score, reasoning, struct, itok, otok = await service._run_verifier(
            agent_id="04977ce8-c7e5-4334-ad44-faf4c47c0e62",
            task_id="6c70a926-7382-4afd-9538-d2d3a8039d70",
            goal="Using Claude Code, write and run a Python program that computes the Collatz sequence starting from 27.",
            model="rose-labs/rose-1-ultra",
            terminal=terminal,
            action_summary=["Created E2B sandbox", "Agentic loop finished: 0 interactions"],
            output_schema={
                "fields": [
                    {"name": "stdout", "type": "str", "required": True},
                    {"name": "collatz_sequence", "type": "list[int]", "required": True},
                    {"name": "total_steps", "type": "int", "required": True},
                    {"name": "python_script", "type": "file_pointer", "required": True},
                ]
            },
            claude_token=None,
            exit_code=0,
            code_provider="claude",
            code_events=[
                {"type": "tool_use", "provider": "claude", "tool": "Write", "input": {"path": "/home/user/output/collatz_27.py"}},
                {"type": "tool_result", "provider": "claude", "status": "completed"},
                {"type": "tool_use", "provider": "claude", "tool": "Bash", "input": {"command": "python collatz_27.py"}},
                {"type": "tool_result", "provider": "claude", "status": "completed"},
                {
                    "type": "agent_message",
                    "provider": "claude",
                    "status": "completed",
                    "message": stdout,
                },
            ],
            output_files=[{"original_filename": "collatz_27.py", "mime_type": "application/octet-stream", "size_bytes": 414}],
        )

    assert called["check_progress"] == 0
    assert score == 1.0
    assert "verifier disabled" in reasoning.lower(), reasoning
    assert "Total steps: 111" in reasoning, reasoning
    assert "code_agent_events" in reasoning, reasoning
    assert struct == {
        "stdout": stdout,
        "collatz_sequence": [int(value) for value in stdout.splitlines()[:-1]],
        "total_steps": 111,
        "python_script": {"path": "/home/user/output/collatz_27.py"},
    }
    assert itok == 0 and otok == 0


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
            model="rose-labs/rose-1-flash",
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
            model="rose-labs/rose-1-flash",
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


async def test_run_verifier_truncation_preserves_rejection():
    """A truncated terminal and parent completion claim cannot override the verifier."""
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
            model="rose-labs/rose-1-flash",
            terminal=terminal,
            action_summary=["Parent LLM signaled task completion"],
            output_schema={"fields": [{"name": "sequence_output", "type": "string"}]},
            claude_token=None,
            attempt_completion=True,
            exit_code=None,
        )
    assert score == 0.5
    assert reasoning == "Cannot ground sequence_output: only first 3 of ~113 lines visible."


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
            model="rose-labs/rose-1-flash",
            terminal=terminal,
            action_summary=[],
            output_schema={"fields": []},
            claude_token=None,
            attempt_completion=True,
            exit_code=None,
        )
    assert score == 0.5


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
            model="rose-labs/rose-1-flash",
            terminal=terminal,
            action_summary=[],
            output_schema={"fields": []},
            claude_token=None,
            attempt_completion=False,
            exit_code=None,
        )
    assert score == 0.5


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
            model="rose-labs/rose-1-flash",
            terminal=terminal,
            action_summary=[],
            output_schema={"fields": []},
            claude_token=None,
            attempt_completion=True,
            exit_code=None,
        )
    assert score == 1.0
    assert reasoning == "All fields populated."


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
        on_events_replay=None,
    ):
        self.on_output = on_output
        self.on_exit = on_exit
        self.on_event = on_event
        self.on_events_replay = on_events_replay
        self._reconnects_exhausted = False
        self._connected = True
        self._sent = []
        self.disconnected = False

    async def connect(self):
        return True

    async def disconnect(self):
        self.disconnected = True

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
            model="rose-labs/rose-1-flash",
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


async def test_run_agentic_loop_sdk_idle_timeout_breaks():
    """Hung CLI with no exit_code must break on SDK idle, not spin to MAX_RUNTIME.

    Repro shape from cuda-kernel k=3 r12: Bash/ScheduleWakeup then only progress
    chips (which do not refresh last_output_time). After silence flips
    pending_output=False, autonomous CC waits for SDK exit forever without the
    idle break.
    """
    import asyncio as aio

    from domains.spawn_claude_code_agent import service
    from utils.terminal_filter import TerminalFilter

    class HangAfterOutput(_FakeWsClient):
        async def listen(self):
            await self.on_output("partial work", True)
            # Stay connected with no further events and no on_exit.
            await aio.Event().wait()

    terminal = TerminalFilter(cols=80, rows=50)
    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    summary: list[str] = []

    with (
        patch.object(service, "ClaudeCodeWsClient", HangAfterOutput),
        patch.object(service, "SDK_IDLE_TIMEOUT_S", 0.05),
        patch.object(service, "SILENCE_TIMEOUT_S", 0.01),
        patch.object(service, "MAX_RUNTIME_S", 30),
        patch("temporalio.activity.heartbeat"),
    ):
        t0 = aio.get_event_loop().time()
        exit_code, attempt, history, itok, otok, events = await service._run_agentic_loop(
            agent_id="a",
            task_id="t",
            sandbox_id="sb",
            goal="g",
            ws_url="wss://x",
            terminal=terminal,
            model="rose-labs/rose-1-flash",
            claude_token=None,
            action_summary=summary,
            tool_call_id="tc",
        )
        elapsed = aio.get_event_loop().time() - t0

    assert exit_code == -1
    assert attempt is False
    assert elapsed < 5.0, f"idle break should be fast, took {elapsed:.2f}s"
    assert any("SDK idle timeout" in s for s in summary), summary


async def test_run_agentic_loop_wait_tool_extends_sdk_idle_timeout():
    """Monitor/ScheduleWakeup must stretch idle so productive waits aren't killed.

    Repro: cuda-kernel-github-top100-code-agent k=3 r21 agent ce189356 —
    ScheduleWakeup/Monitor then ~180s WebSocket silence while background work
    continued → SDK idle kill, 0 artifacts, score 0.5 under verifier-disabled.
    Progress chips do not refresh last_output_time; wait tools must.
    """
    import asyncio as aio

    from domains.spawn_claude_code_agent import service
    from utils.terminal_filter import TerminalFilter

    class HangAfterWaitTool(_FakeWsClient):
        async def listen(self):
            await self.on_output("partial work", True)
            if self.on_event:
                await self.on_event(
                    {
                        "version": 1,
                        "provider": "claude",
                        "type": "tool_use",
                        "name": "ScheduleWakeup",
                    }
                )
            await aio.Event().wait()

    terminal = TerminalFilter(cols=80, rows=50)
    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    summary: list[str] = []

    with (
        patch.object(service, "ClaudeCodeWsClient", HangAfterWaitTool),
        patch.object(service, "SDK_IDLE_TIMEOUT_S", 0.05),
        patch.object(service, "SDK_WAIT_TOOL_IDLE_TIMEOUT_S", 0.35),
        patch.object(service, "SILENCE_TIMEOUT_S", 0.01),
        patch.object(service, "MAX_RUNTIME_S", 30),
        patch("temporalio.activity.heartbeat"),
    ):
        t0 = aio.get_event_loop().time()
        exit_code, attempt, history, itok, otok, events = await service._run_agentic_loop(
            agent_id="a",
            task_id="t",
            sandbox_id="sb",
            goal="g",
            ws_url="wss://x",
            terminal=terminal,
            model="rose-labs/rose-1-flash",
            claude_token=None,
            action_summary=summary,
            tool_call_id="tc",
        )
        elapsed = aio.get_event_loop().time() - t0

    assert exit_code == -1
    assert attempt is False
    assert elapsed >= 0.25, (
        f"wait-tool idle extension should survive short 0.05s idle, took {elapsed:.2f}s"
    )
    assert elapsed < 2.0, f"wait-tool idle should still break, took {elapsed:.2f}s"
    assert any("SDK idle timeout" in s for s in summary), summary
    assert any(e.get("name") == "ScheduleWakeup" for e in events), events


async def test_run_agentic_loop_in_flight_bash_extends_sdk_idle_timeout():
    """Long-running Bash must stretch idle until tool_result, not die mid-command.

    Repro: cuda-kernel-github-top100-code-agent k=3 r22 CC#4 — Bash tool_use
    with no tool_result for >180s (command still running) → SDK idle kill while
    work was in flight. Progress chips do not refresh last_output_time.
    """
    import asyncio as aio

    from domains.spawn_claude_code_agent import service
    from utils.terminal_filter import TerminalFilter

    class HangDuringBash(_FakeWsClient):
        async def listen(self):
            await self.on_output("starting bash", True)
            if self.on_event:
                await self.on_event(
                    {
                        "version": 1,
                        "provider": "claude",
                        "type": "tool_use",
                        "name": "Bash",
                    }
                )
            # No tool_result — Bash still running. Stay connected.
            await aio.Event().wait()

    terminal = TerminalFilter(cols=80, rows=50)
    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    summary: list[str] = []

    with (
        patch.object(service, "ClaudeCodeWsClient", HangDuringBash),
        patch.object(service, "SDK_IDLE_TIMEOUT_S", 0.2),
        patch.object(service, "SDK_WAIT_TOOL_IDLE_TIMEOUT_S", 1.0),
        patch.object(service, "SILENCE_TIMEOUT_S", 0.01),
        patch.object(service, "MAX_RUNTIME_S", 30),
        patch("temporalio.activity.heartbeat"),
    ):
        t0 = aio.get_event_loop().time()
        exit_code, attempt, history, itok, otok, events = await service._run_agentic_loop(
            agent_id="a",
            task_id="t",
            sandbox_id="sb",
            goal="g",
            ws_url="wss://x",
            terminal=terminal,
            model="rose-labs/rose-1-flash",
            claude_token=None,
            action_summary=summary,
            tool_call_id="tc",
        )
        elapsed = aio.get_event_loop().time() - t0

    assert exit_code == -1
    assert attempt is False
    # Base idle is wide enough that a loaded event loop still delivers the Bash
    # tool_use before it can fire (0.05s flaked under the 30-way suite).
    assert elapsed >= 0.8, (
        f"in-flight Bash idle extension should survive short 0.2s idle, took {elapsed:.2f}s"
    )
    assert elapsed < 3.0, f"in-flight Bash idle should still break, took {elapsed:.2f}s"
    assert any("SDK idle timeout" in s for s in summary), summary
    assert any(e.get("name") == "Bash" for e in events), events


async def test_run_agentic_loop_bash_tool_result_keeps_stretched_sdk_idle():
    """Bash tool_result must NOT snap idle back to 180s (background work continues).

    Repro: cuda-kernel-github-top100-code-agent k=3 r24 — Bash tool_use stretched
    idle to 900s, then tool_result restored 180s while background Bash/network
    work continued with no WS events → SDK idle kill, 0 artifacts, score 0.5.
    Arm Bash like wait tools so post-result stretch survives until SDK `result`.
    """
    import asyncio as aio

    from domains.spawn_claude_code_agent import service
    from utils.terminal_filter import TerminalFilter

    class HangAfterBashResult(_FakeWsClient):
        async def listen(self):
            await self.on_output("running bash", True)
            if self.on_event:
                await self.on_event(
                    {
                        "version": 1,
                        "provider": "claude",
                        "type": "tool_use",
                        "name": "Bash",
                    }
                )
                await self.on_event(
                    {
                        "version": 1,
                        "provider": "claude",
                        "type": "tool_result",
                        "name": "Bash",
                    }
                )
            # Background work continues — no further WS events.
            await aio.Event().wait()

    terminal = TerminalFilter(cols=80, rows=50)
    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    summary: list[str] = []

    with (
        patch.object(service, "ClaudeCodeWsClient", HangAfterBashResult),
        patch.object(service, "SDK_IDLE_TIMEOUT_S", 0.05),
        patch.object(service, "SDK_WAIT_TOOL_IDLE_TIMEOUT_S", 0.35),
        patch.object(service, "SILENCE_TIMEOUT_S", 0.01),
        patch.object(service, "MAX_RUNTIME_S", 30),
        patch("temporalio.activity.heartbeat"),
    ):
        t0 = aio.get_event_loop().time()
        exit_code, attempt, history, itok, otok, events = await service._run_agentic_loop(
            agent_id="a",
            task_id="t",
            sandbox_id="sb",
            goal="g",
            ws_url="wss://x",
            terminal=terminal,
            model="rose-labs/rose-1-flash",
            claude_token=None,
            action_summary=summary,
            tool_call_id="tc",
        )
        elapsed = aio.get_event_loop().time() - t0

    assert exit_code == -1
    assert attempt is False
    assert elapsed >= 0.25, (
        f"post-Bash-result stretch should survive short 0.05s idle, took {elapsed:.2f}s"
    )
    assert elapsed < 2.0, f"post-Bash-result idle should still break, took {elapsed:.2f}s"
    assert any("SDK idle timeout" in s for s in summary), summary
    assert any(e.get("name") == "Bash" for e in events), events


async def test_run_agentic_loop_sdk_result_blocks_stretch_rearm():
    """After SDK result, Bash must not re-arm 900s stretch (r31 a2 repro).

    Repro: cuda-kernel-github-top100-code-agent k=3 r31 a2 — SDK emitted
    result=completed, then Bash/ScheduleWakeup re-armed the post-result stretch
    and the session burned Max runtime (1800s) with 0 artifacts. Healthy
    sessions (r31 a1) exit within ~1s of result. After result, stretch must
    stay disarmed so short idle ends the zombie CLI.
    """
    import asyncio as aio

    from domains.spawn_claude_code_agent import service
    from utils.terminal_filter import TerminalFilter

    class HangAfterResultThenBash(_FakeWsClient):
        async def listen(self):
            await self.on_output("working", True)
            if self.on_event:
                await self.on_event(
                    {
                        "version": 1,
                        "provider": "claude",
                        "type": "tool_use",
                        "name": "Bash",
                    }
                )
                await self.on_event(
                    {
                        "version": 1,
                        "provider": "claude",
                        "type": "tool_result",
                        "name": "Bash",
                    }
                )
                await self.on_event(
                    {
                        "version": 1,
                        "provider": "claude",
                        "type": "result",
                        "status": "completed",
                    }
                )
                # Zombie CLI continues tooling after result (r31 a2 pattern).
                await self.on_event(
                    {
                        "version": 1,
                        "provider": "claude",
                        "type": "tool_use",
                        "name": "Bash",
                    }
                )
                await self.on_event(
                    {
                        "version": 1,
                        "provider": "claude",
                        "type": "tool_result",
                        "name": "Bash",
                    }
                )
            await aio.Event().wait()

    terminal = TerminalFilter(cols=80, rows=50)
    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    summary: list[str] = []

    with (
        patch.object(service, "ClaudeCodeWsClient", HangAfterResultThenBash),
        patch.object(service, "SDK_IDLE_TIMEOUT_S", 0.05),
        patch.object(service, "SDK_WAIT_TOOL_IDLE_TIMEOUT_S", 0.35),
        patch.object(service, "SDK_POST_RESULT_EXIT_GRACE_S", 2.0),
        patch.object(service, "SILENCE_TIMEOUT_S", 0.01),
        patch.object(service, "MAX_RUNTIME_S", 30),
        patch("temporalio.activity.heartbeat"),
    ):
        t0 = aio.get_event_loop().time()
        exit_code, attempt, history, itok, otok, events = await service._run_agentic_loop(
            agent_id="a",
            task_id="t",
            sandbox_id="sb",
            goal="g",
            ws_url="wss://x",
            terminal=terminal,
            model="rose-labs/rose-1-flash",
            claude_token=None,
            action_summary=summary,
            tool_call_id="tc",
        )
        elapsed = aio.get_event_loop().time() - t0

    assert exit_code == -1
    assert attempt is False
    # Must end on short idle (~0.05s), NOT the 0.35s stretch window.
    assert elapsed < 0.25, (
        f"post-SDK-result Bash must not re-arm stretch; took {elapsed:.2f}s (summary={summary})"
    )
    assert any(
        "SDK idle timeout" in s or "Post-result exit grace" in s for s in summary
    ), summary
    assert any(e.get("type") == "result" for e in events), events


async def test_run_agentic_loop_post_result_exit_grace_breaks():
    """Stdout after SDK result that refreshes idle must still hit exit grace.

    If the zombie CLI keeps emitting PTY output after result, last_output_time
    never goes silent long enough for short idle — grace is the backstop so we
    do not burn MAX_RUNTIME_S.
    """
    import asyncio as aio

    from domains.spawn_claude_code_agent import service
    from utils.terminal_filter import TerminalFilter

    class ChattyAfterResult(_FakeWsClient):
        async def listen(self):
            await self.on_output("working", True)
            if self.on_event:
                await self.on_event(
                    {
                        "version": 1,
                        "provider": "claude",
                        "type": "result",
                        "status": "completed",
                    }
                )
            # Keep refreshing last_output_time so short idle never fires.
            while True:
                await aio.sleep(0.02)
                await self.on_output("chip\n", False)

    terminal = TerminalFilter(cols=80, rows=50)
    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    summary: list[str] = []

    with (
        patch.object(service, "ClaudeCodeWsClient", ChattyAfterResult),
        patch.object(service, "SDK_IDLE_TIMEOUT_S", 5.0),
        patch.object(service, "SDK_WAIT_TOOL_IDLE_TIMEOUT_S", 5.0),
        patch.object(service, "SDK_POST_RESULT_EXIT_GRACE_S", 0.15),
        patch.object(service, "SILENCE_TIMEOUT_S", 0.01),
        patch.object(service, "MAX_RUNTIME_S", 30),
        patch("temporalio.activity.heartbeat"),
    ):
        t0 = aio.get_event_loop().time()
        exit_code, attempt, history, itok, otok, events = await service._run_agentic_loop(
            agent_id="a",
            task_id="t",
            sandbox_id="sb",
            goal="g",
            ws_url="wss://x",
            terminal=terminal,
            model="rose-labs/rose-1-flash",
            claude_token=None,
            action_summary=summary,
            tool_call_id="tc",
        )
        elapsed = aio.get_event_loop().time() - t0

    assert exit_code == -1
    assert attempt is False
    assert elapsed < 1.0, f"grace should end chatty post-result session quickly, took {elapsed:.2f}s"
    assert any("Post-result exit grace" in s for s in summary), summary


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


def test_log_code_agent_event_promotes_claude_tool_use_to_info():
    """Claude tool_use/tool_result progress must be info-level so run JSON keeps it."""
    from domains.spawn_claude_code_agent import service

    fake_logger = MagicMock()
    with patch.object(service, "logger", fake_logger):
        service._log_code_agent_event(
            {
                "version": 1,
                "provider": "claude",
                "type": "tool_use",
                "name": "Bash",
                "status": "running",
            },
            agent_id="agent-1",
            task_id="task-1",
            sandbox_id="sandbox-1",
        )

    fake_logger.info.assert_called_once()
    args, kwargs = fake_logger.info.call_args
    assert args[0] == "[ClaudeCode] Code-agent event"
    assert kwargs["agent_id"] == "agent-1"
    assert kwargs["provider"] == "claude"
    assert kwargs["event_type"] == "tool_use"
    assert kwargs["tool_name"] == "Bash"
    fake_logger.debug.assert_not_called()


def test_log_code_agent_event_surfaces_claude_cli_rate_limit_and_api_retry():
    """CLI rate_limit_event + system.api_retry fields reach info logs (bounded, no session ids)."""
    from domains.spawn_claude_code_agent import service

    ids = {"agent_id": "agent-1", "task_id": "task-1", "sandbox_id": "sandbox-1"}
    rate_limit_event = {
        "version": 1,
        "provider": "claude",
        "type": "cli_message",
        "raw_type": "rate_limit_event",
        "cli_message": {
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "allowed_warning",
                "rateLimitType": "five_hour",
                "utilization": 0.91,
                "resetsAt": 1790988600,
                "overageStatus": "rejected",
                "overageDisabledReason": "out_of_credits",
                "isUsingOverage": False,
                "surpassedThreshold": 0.9,
            },
            "uuid": "11111111-1111-1111-1111-111111111111",
            "session_id": "cli-session-should-not-be-logged",
        },
    }
    api_retry_event = {
        "version": 1,
        "provider": "claude",
        "type": "cli_message",
        "raw_type": "system",
        "cli_message": {
            "type": "system",
            "subtype": "api_retry",
            "attempt": 2,
            "max_retries": 10,
            "retry_delay_ms": 1130,
            "error_status": 529,
            "error": "server_error" + "x" * 400,
            "uuid": "22222222-2222-2222-2222-222222222222",
            "session_id": "cli-session-should-not-be-logged",
        },
    }
    unrelated_cli_event = {
        "version": 1,
        "provider": "claude",
        "type": "cli_message",
        "raw_type": "system",
        "cli_message": {"type": "system", "subtype": "compact_boundary"},
    }

    fake_logger = MagicMock()
    with patch.object(service, "logger", fake_logger):
        service._log_code_agent_event(rate_limit_event, **ids)
        service._log_code_agent_event(api_retry_event, **ids)
        service._log_code_agent_event(unrelated_cli_event, **ids)

    assert fake_logger.info.call_count == 2, fake_logger.info.call_args_list
    (rl_args, rl_kwargs), (retry_args, retry_kwargs) = [(c.args, c.kwargs) for c in fake_logger.info.call_args_list]

    assert rl_args[0] == "[ClaudeCode] CLI rate-limit status"
    assert rl_kwargs == {
        **ids,
        "rate_limit_status": "allowed_warning",
        "rate_limit_type": "five_hour",
        "utilization": 0.91,
        "resets_at": 1790988600,
        "overage_status": "rejected",
        "overage_resets_at": None,
        "overage_disabled_reason": "out_of_credits",
        "is_using_overage": False,
        "surpassed_threshold": 0.9,
    }

    assert retry_args[0] == "[ClaudeCode] CLI API retry"
    assert retry_kwargs["attempt"] == 2
    assert retry_kwargs["max_retries"] == 10
    assert retry_kwargs["retry_delay_ms"] == 1130
    assert retry_kwargs["error_status"] == 529
    assert retry_kwargs["error"].startswith("server_error")
    assert len(retry_kwargs["error"]) == 200, "CLI-sourced log values must be truncated to 200 chars"
    assert {k: retry_kwargs[k] for k in ids} == ids

    logged = repr(fake_logger.info.call_args_list)
    assert "cli-session-should-not-be-logged" not in logged
    assert "compact_boundary" not in logged


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


async def test_spawn_activity_resolves_claude_credential_inside_activity():
    """Claude OAuth is fetched at the activity boundary, not supplied by workflow args."""
    from domains.spawn_claude_code_agent import service

    fetch = AsyncMock(return_value={"accessToken": "activity-secret", "source": "pool"})
    with patch("helpers.llm.fetch_claude_max_token", fetch):
        token = await service._resolve_claude_token_for_activity("u", "claude")

    assert token == "activity-secret"
    fetch.assert_awaited_once_with("u")


async def test_spawn_activity_does_not_fetch_claude_credential_for_codex():
    """Codex sessions never fetch or receive Claude OAuth material."""
    from domains.spawn_claude_code_agent import service

    fetch = AsyncMock(return_value={"accessToken": "unexpected"})
    with patch("helpers.llm.fetch_claude_max_token", fetch):
        token = await service._resolve_claude_token_for_activity("u", "codex")

    assert token is None
    fetch.assert_not_awaited()


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

    seen_loop = {}

    async def fake_loop(**kwargs):
        seen_loop.update(kwargs)
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
        patch.object(
            service,
            "_resolve_claude_token_for_activity",
            AsyncMock(return_value="activity-local-claude-token"),
        ),
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
            model="rose-labs/rose-1-flash",
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
    assert result["code_provider"] == "claude"
    assert seen_create_session["fast_mode_cache_enabled"] is True
    assert seen_loop["claude_token"] == "activity-local-claude-token"
    fake_collector.start.assert_awaited()
    fake_collector.stop.assert_awaited()


async def test_spawn_activity_fast_exit_auth_failure_is_terminal():
    """A fast CLI 401 is re-checked after exit and never reaches the verifier."""
    from temporalio.exceptions import ApplicationError

    from domains.spawn_claude_code_agent import service

    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})

    fake_collector = AsyncMock()
    fake_collector.start = AsyncMock()
    fake_collector.stop = AsyncMock()
    close_session = AsyncMock(return_value={})
    verifier = AsyncMock()

    async def fake_create_session(**_kwargs):
        return {
            "task_id": "revoked-task",
            "sandbox_id": "revoked-sandbox",
            "ws_url": "wss://x",
            "uploaded_files": [],
            "github_repo_url": None,
        }

    async def fake_loop(**kwargs):
        kwargs["terminal"].feed(
            "[Claude] Session started in /home/user\n"
            "[Claude] Failed to authenticate. API Error: 401 OAuth access token has been revoked.\n"
        )
        return (1, False, [], 0, 0, [])

    with (
        patch.object(service, "SandboxLogCollector", lambda *a, **kw: fake_collector),
        patch.object(service, "create_e2b_session", side_effect=fake_create_session),
        patch.object(service, "_run_agentic_loop", side_effect=fake_loop),
        patch.object(service, "_run_verifier", verifier),
        patch.object(service, "persist_terminal_output", AsyncMock()),
        patch.object(service, "close_e2b_session", close_session),
        patch.object(service, "_resolve_claude_token_for_activity", AsyncMock(return_value=None)),
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
            raise AssertionError("revoked OAuth must terminate the activity")
        except ApplicationError as error:
            assert error.non_retryable is True
            assert error.type == "CLAUDE_CODE_FATAL"
            assert "401" in str(error)

    verifier.assert_not_awaited()
    close_session.assert_awaited_once()
    fake_collector.stop.assert_awaited()


async def test_spawn_activity_codex_oauth_fallback_success_continues():
    """A successful funded-key fallback survives the retained OAuth error banner."""
    from domains.spawn_claude_code_agent import service

    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})

    fake_collector = AsyncMock()
    fake_collector.start = AsyncMock()
    fake_collector.stop = AsyncMock()
    persisted = AsyncMock()
    close_session = AsyncMock(return_value={"output_files": [], "usage": {}})
    verifier = AsyncMock(return_value=(1.0, "fallback completed", {}, 0, 0))

    async def fake_create_session(**_kwargs):
        return {
            "task_id": "codex-fallback-success",
            "sandbox_id": "codex-fallback-success-sandbox",
            "ws_url": "wss://x",
            "uploaded_files": [],
            "github_repo_url": None,
        }

    async def fake_loop(**kwargs):
        kwargs["terminal"].feed(
            "[Codex] Error: Quota exceeded. Check your plan and billing details.\n"
            "[Codex] ChatGPT OAuth unavailable — retrying with funded OpenAI API key\n"
            + "".join(f"normal fallback output {index}\n" for index in range(650))
            + "CODEX_E2B_DONE\n"
        )
        return (
            0,
            False,
            [],
            0,
            0,
            [
                {
                    "version": 1,
                    "provider": "codex",
                    "type": "error",
                    "message": "Quota exceeded. Check your plan and billing details.",
                },
                {
                    "version": 1,
                    "provider": "codex",
                    "type": "auth_fallback",
                    "from": "chatgpt_oauth",
                    "to": "openai_api_key",
                },
                {
                    "version": 1,
                    "provider": "codex",
                    "type": "final",
                    "status": "completed",
                    "exit_code": 0,
                },
            ],
        )

    with (
        patch.object(service, "SandboxLogCollector", lambda *a, **kw: fake_collector),
        patch.object(service, "create_e2b_session", side_effect=fake_create_session),
        patch.object(service, "_run_agentic_loop", side_effect=fake_loop),
        patch.object(service, "_run_verifier", verifier),
        patch.object(service, "persist_terminal_output", persisted),
        patch.object(service, "close_e2b_session", close_session),
        patch.object(service, "_resolve_claude_token_for_activity", AsyncMock(return_value=None)),
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
            code_provider="codex",
        )

    assert result["status"] == "completed"
    verifier.assert_awaited_once()
    persisted.assert_awaited_once()
    persisted_output = persisted.await_args.args[1]
    assert persisted_output.strip()
    assert "[Codex" in persisted_output
    assert "ChatGPT OAuth unavailable" not in persisted_output
    assert persisted.await_args.kwargs["credential_feedback"] == [
        {
            "source": "oauth",
            "reason": "Quota exceeded. Check your plan and billing details.",
        }
    ]
    close_session.assert_awaited_once()
    fake_collector.stop.assert_awaited()


async def test_spawn_activity_codex_double_exhaustion_is_terminal_and_persisted():
    """OAuth then funded-key exhaustion stops before verifier with both errors persisted."""
    from temporalio.exceptions import ApplicationError

    from domains.spawn_claude_code_agent import service

    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})

    fake_collector = AsyncMock()
    fake_collector.start = AsyncMock()
    fake_collector.stop = AsyncMock()
    persisted = AsyncMock()
    close_session = AsyncMock(return_value={})
    verifier = AsyncMock()

    async def fake_create_session(**_kwargs):
        return {
            "task_id": "codex-double-exhaustion",
            "sandbox_id": "codex-double-exhaustion-sandbox",
            "ws_url": "wss://x",
            "uploaded_files": [],
            "github_repo_url": None,
        }

    async def fake_loop(**kwargs):
        kwargs["terminal"].feed(
            "[Codex] Error: Quota exceeded. Check your plan and billing details.\n"
            "[Codex] ChatGPT OAuth unavailable — retrying with funded OpenAI API key\n"
            + "".join(f"normal fallback output {index}\n" for index in range(650))
            + "[Codex] Error code: insufficient_quota\n"
        )
        return (
            1,
            False,
            [],
            0,
            0,
            [
                {
                    "version": 1,
                    "provider": "codex",
                    "type": "error",
                    "message": "Quota exceeded. Check your plan and billing details.",
                },
                {
                    "version": 1,
                    "provider": "codex",
                    "type": "auth_fallback",
                    "from": "chatgpt_oauth",
                    "to": "openai_api_key",
                },
                {
                    "version": 1,
                    "provider": "codex",
                    "type": "error",
                    "message": "insufficient_quota",
                },
                {
                    "version": 1,
                    "provider": "codex",
                    "type": "final",
                    "status": "failed",
                    "exit_code": 1,
                },
            ],
        )

    with (
        patch.object(service, "SandboxLogCollector", lambda *a, **kw: fake_collector),
        patch.object(service, "create_e2b_session", side_effect=fake_create_session),
        patch.object(service, "_run_agentic_loop", side_effect=fake_loop),
        patch.object(service, "_run_verifier", verifier),
        patch.object(service, "persist_terminal_output", persisted),
        patch.object(service, "close_e2b_session", close_session),
        patch.object(service, "_resolve_claude_token_for_activity", AsyncMock(return_value=None)),
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
                code_provider="codex",
            )
            raise AssertionError("double credential exhaustion must terminate the activity")
        except ApplicationError as error:
            assert error.non_retryable is True
            assert error.type == "CLAUDE_CODE_FATAL"
            assert "out of quota" in str(error)

    verifier.assert_not_awaited()
    persisted.assert_awaited_once()
    persisted_output = persisted.await_args.args[1]
    assert "insufficient_quota" in persisted_output
    assert persisted.await_args.kwargs["credential_feedback"] == [
        {
            "source": "oauth",
            "reason": "Quota exceeded. Check your plan and billing details.",
        },
        {"source": "funded_api_key", "reason": "insufficient_quota"},
    ]
    close_session.assert_awaited_once()
    fake_collector.stop.assert_awaited()


async def test_spawn_activity_cancelled_cleanup():
    """A requested cancel triggers the cleanup path and returns 'cancelled' status."""
    from temporalio.testing import ActivityEnvironment

    from domains.spawn_claude_code_agent import service

    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})

    fake_collector = AsyncMock()
    fake_collector.start = AsyncMock()
    fake_collector.stop = AsyncMock()
    env = ActivityEnvironment()

    async def fake_create_session(**kwargs):
        return {
            "task_id": "t",
            "sandbox_id": "sb",
            "ws_url": "wss://x",
            "uploaded_files": [],
            "github_repo_url": None,
        }

    async def fake_loop(**kwargs):
        env.cancel()
        await asyncio.sleep(30)

    close_session = AsyncMock(return_value={})

    with (
        patch.object(service, "SandboxLogCollector", lambda *a, **kw: fake_collector),
        patch.object(service, "create_e2b_session", side_effect=fake_create_session),
        patch.object(service, "_run_agentic_loop", side_effect=fake_loop),
        patch.object(service, "close_e2b_session", close_session),
        patch.object(service, "persist_terminal_output", AsyncMock()),
        patch.object(service, "_resolve_claude_token_for_activity", AsyncMock(return_value=None)),
        patch(
            "helpers.model_pricing.get_model_pricing_with_fallback",
            AsyncMock(return_value={"input_cents_per_1k": 0, "output_cents_per_1k": 0}),
        ),
    ):
        result = await asyncio.wait_for(
            env.run(
                service.spawn_claude_code_activity,
                user_id="u",
                agent_id="a",
                goal="g",
                tool_call_id="tc",
                output_schema={"fields": []},
            ),
            timeout=10,
        )
    assert result["status"] == "cancelled"
    assert result["task_id"] == "t"
    close_session.assert_awaited_once()
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
        patch.object(service, "_resolve_claude_token_for_activity", AsyncMock(return_value=None)),
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
        WAIT_CANCELLATION_COMPLETED = "WAIT_CANCELLATION_COMPLETED"

    def __init__(self, activity_handle):
        self._handle = activity_handle
        self.started_activity_args = None

    def start_activity(self, fn, args=None, **kwargs):
        self.started_activity_args = args
        return self._handle

    async def wait_condition(self, predicate):
        return None

    async def execute_activity(self, fn, args=None, **kwargs):
        assert fn.__name__ == "resolve_code_agent_provider_activity"
        return args[0]


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
        self.model = "rose-labs/rose-1-flash"
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


async def test_cc_execute_tool_records_forced_provider_without_serializing_credential():
    """Forced Claude is recorded while OAuth material stays out of workflow history."""
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager

    handle = _FakeActivityHandle(
        result={
            "success": True,
            "message": "ok",
            "output_files": [],
            "code_provider": "claude",
        }
    )

    class _ForcedClaudeWorkflow(_FakeCCWorkflow):
        def __init__(self):
            super().__init__(handle)
            self.provider_resolutions = 0

        async def execute_activity(self, fn, args=None, **kwargs):
            self.provider_resolutions += 1
            assert fn.__name__ == "resolve_code_agent_provider_activity"
            assert args == ["codex"]
            return "claude"

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

    assert fake.provider_resolutions == 1
    assert fake.started_activity_args[8] is None
    assert fake.started_activity_args[9] == "claude"
    assert fake.started_activity_args[10] == "active-gpt-token"
    assert "fresh-claude-token" not in repr(fake.started_activity_args)


async def test_cc_execute_tool_non_boolean_success_is_incomplete():
    """Only the boolean True can yield a completed title and success metadata."""
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager
    from tools.base import MessageStatus

    handle = _FakeActivityHandle(
        result={
            "success": "false",
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
    """Activity status='cancelled' yields chip-terminal task_complete with task_id.

    ClaudeCodeChip only leaves spinning_up when a task-scoped message has
    action_type=task_complete. Pause/cancel must emit task_complete (not
    session_cancelled) and include task_id so the chip can match it.
    """
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager
    from tools.base import MessageStatus

    handle = _FakeActivityHandle(
        result={
            "status": "cancelled",
            "message": "cancelled",
            "task_id": "task-cancel-1",
            "code_provider": "claude",
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
                "tc-cancel",
            )
        )
    finally:
        restore()

    error = next(e for e in events if getattr(e, "status", None) == MessageStatus.ERROR)
    assert "Cancelled" in error.title or "cancelled" in error.title.lower()
    assert error.metadata.get("action_type") == "task_complete"
    assert error.metadata.get("task_id") == "task-cancel-1"
    assert error.metadata.get("success") is False
    assert error.metadata.get("toolName") == "spawn_claude_code_agent"


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
    # Await raised before activity returned task_id — still emit task_complete so
    # MessageBubble keeps routing through ClaudeCodeChip (session_cancelled does not).
    assert error.metadata.get("action_type") == "task_complete"
    assert error.metadata.get("success") is False


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


async def test_cc_execute_tool_github_access_denied_soft_fails_finished():
    """GITHUB_ACCESS_DENIED must FINISH (not ERROR) so no_tool_failures can pass.

    Ranking benches fail closed when spawn_claude_code_agent posts toolStatus=ERROR
    after a sandbox GitHub clone denial. Soft-fail lets the agent retry API-only.
    """
    from temporalio.exceptions import ActivityError

    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager
    from tools.base import MessageStatus

    activity_error = ActivityError(
        message=(
            "Failed to create code session (provider=claude): HTTP 403: "
            '{"error":"Access denied","code":"GITHUB_ACCESS_DENIED"}'
        ),
        scheduled_event_id=1,
        started_event_id=1,
        identity="worker",
        activity_type="spawn_claude_code_activity",
        activity_id="1",
        retry_state=None,
    )
    handle = _FakeActivityHandle(raise_exc=activity_error)
    fake = _FakeCCWorkflow(handle)
    restore = _patch_cc_workflow(fake)
    try:
        manager = SpawnClaudeCodeAgentManager()
        events = await _collect_cc_events(
            manager.execute_tool(
                _FakeCCWorkflowInstance(),
                {"goal": "g", "github_repo_link": "https://github.com/pytorch/pytorch"},
                "tc-github-denied",
            )
        )
    finally:
        restore()

    assert not any(getattr(e, "status", None) == MessageStatus.ERROR for e in events)
    finished = next(e for e in events if getattr(e, "status", None) == MessageStatus.FINISHED)
    assert finished.metadata.get("success") is False
    assert finished.metadata.get("action_type") == "task_complete"
    assert "GITHUB_ACCESS_DENIED" in finished.message or "denied cloning" in finished.message.lower()
    assert "github_repo_url" in finished.message or "API-only" in finished.message


async def _assert_cc_sandbox_infra_soft_fail(activity_message: str, tool_call_id: str) -> None:
    """Shared assertions for soft-failing recoverable E2B create failures."""
    from temporalio.exceptions import ActivityError

    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager
    from tools.base import MessageStatus

    activity_error = ActivityError(
        message=activity_message,
        scheduled_event_id=1,
        started_event_id=1,
        identity="worker",
        activity_type="spawn_claude_code_activity",
        activity_id="1",
        retry_state=None,
    )
    handle = _FakeActivityHandle(raise_exc=activity_error)
    fake = _FakeCCWorkflow(handle)
    restore = _patch_cc_workflow(fake)
    try:
        manager = SpawnClaudeCodeAgentManager()
        events = await _collect_cc_events(
            manager.execute_tool(
                _FakeCCWorkflowInstance(),
                {"goal": "rank cuda repos via GitHub API"},
                tool_call_id,
            )
        )
    finally:
        restore()

    assert not any(getattr(e, "status", None) == MessageStatus.ERROR for e in events)
    finished = next(e for e in events if getattr(e, "status", None) == MessageStatus.FINISHED)
    assert finished.metadata.get("success") is False
    assert finished.metadata.get("action_type") == "task_complete"
    msg = finished.message.lower()
    assert (
        "capacity" in msg
        or "sandbox" in msg
        or "billing" in msg
        or "payment" in msg
    ), finished.message
    assert "retry" in msg

async def test_cc_execute_tool_sandbox_infra_soft_fails_finished():
    """E2B redis/sandbox capacity flakes must FINISH (not ERROR) for no_tool_failures.

    Local repro (cuda-kernel k=3 r8): concurrent Claude Code spawns returned
    HTTP 500 redis connection-pool timeouts / sandbox-not-found. Soft-fail so
    the agent can retry spawn without tripping no_tool_failures.
    """
    await _assert_cc_sandbox_infra_soft_fail(
        (
            "Failed to create code session (provider=claude): HTTP 500: "
            '{"error":"500: Failed to create sandbox: failed to run reserve '
            'script: redis: connection pool timeout"}'
        ),
        "tc-sandbox-infra",
    )


async def test_cc_execute_tool_no_healthy_upstream_soft_fails_finished():
    """Gateway 503 no-healthy-upstream must soft-FINISH like other capacity flakes.

    Local repro (cuda-kernel k=3 r10 agent1 @ ~30m): create returned HTTP 500
    wrapping ``503: no healthy upstream``. Soft-fail after Temporal retries so
    no_tool_failures stays green; agent can re-spawn instead of hard-ERROR.
    """
    await _assert_cc_sandbox_infra_soft_fail(
        (
            "Failed to create code session (provider=claude): HTTP 500: "
            '{"error":"503: no healthy upstream"}'
        ),
        "tc-sandbox-503",
    )


async def test_cc_execute_tool_missing_payment_method_soft_fails_finished():
    """Anthropic team payment-method blocks must soft-FINISH like capacity flakes.

    Local repro (cuda-kernel k=3 r13): Claude OAuth works for Messages API, but
    session create returns ``403: team is blocked: missing payment method``.
    Soft-fail so no_tool_failures stays green while the agent continues.
    """
    await _assert_cc_sandbox_infra_soft_fail(
        (
            "Failed to create code session (provider=claude): HTTP 500: "
            '{"error":"403: team is blocked: missing payment method"}'
        ),
        "tc-missing-payment",
    )


async def test_cc_execute_tool_readtimeout_soft_fails_finished():
    """Empty httpx.ReadTimeout on E2B create must soft-FINISH (type-match).

    Local repro (cuda-kernel k=3 r16 agent2): session create hung past the 60s
    httpx timeout and raised ``ReadTimeout('')`` — message markers miss it, so
    Temporal exhausted retries and hard-ERRORed. Soft-fail via exception type.
    """
    import httpx
    from temporalio.exceptions import ActivityError

    from domains.spawn_claude_code_agent.handler import (
        SpawnClaudeCodeAgentManager,
        _is_recoverable_sandbox_infra_failure,
        _maybe_soft_fail_session_create_result,
    )
    from tools.base import MessageStatus

    read_timeout = httpx.ReadTimeout("")
    assert _is_recoverable_sandbox_infra_failure(read_timeout) is True
    soft = _maybe_soft_fail_session_create_result(
        code_provider="claude", error=read_timeout
    )
    assert soft is not None
    assert soft["success"] is False
    assert "capacity" in soft["message"].lower() or "sandbox" in soft["message"].lower()

    activity_error = ActivityError(
        message="ReadTimeout('')",
        scheduled_event_id=1,
        started_event_id=1,
        identity="worker",
        activity_type="spawn_claude_code_activity",
        activity_id="1",
        retry_state=None,
    )
    activity_error.__cause__ = read_timeout
    await _assert_cc_sandbox_infra_soft_fail("ReadTimeout('')", "tc-readtimeout")


def test_cc_spawn_activity_retries_capacity_flakes_before_soft_fail():
    """spawn_claude_code_activity must retry enough times for brief E2B 503s.

    r10 agent1 soft-failed after only 2 attempts, then DAG advanced into
    attempt_completion with incomplete verification and timed out at 4200s.
    """
    import inspect

    from domains.spawn_claude_code_agent import handler as cc_handler

    src = inspect.getsource(cc_handler.SpawnClaudeCodeAgentManager.execute_tool)
    assert "maximum_attempts=5" in src


async def test_cc_execute_tool_paused_cancels_activity():
    """is_paused=True triggers activity_handle.cancel() and chip-terminal cancel."""
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager
    from tools.base import MessageStatus

    class _PausedHandle(_FakeActivityHandle):
        def done(self):
            return False  # Not done, so the pause branch cancels it

    handle = _PausedHandle(
        result={
            "status": "cancelled",
            "message": "paused",
            "task_id": "task-pause-1",
            "code_provider": "codex",
        }
    )
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
    assert error.metadata.get("action_type") == "task_complete"
    assert error.metadata.get("task_id") == "task-pause-1"
    assert error.metadata.get("code_provider") == "codex"
    assert error.metadata.get("success") is False


async def _run_all_tests():
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
    r.record(
        "check_codex_oauth_terminal_after_failed_fallback",
        test_codex_oauth_usage_limit_is_terminal_only_after_failed_fallback,
    )
    r.record("check_fatal_codex_funded_key_quota", test_check_fatal_errors_codex_funded_key_quota)
    r.record(
        "codex_credential_feedback_order",
        test_build_codex_credential_feedback_preserves_fallback_order,
    )
    r.record("codex_feedback_native_funding", test_codex_feedback_captures_funding_errors_from_native_events)
    r.record("codex_feedback_printed_funding", test_codex_feedback_ignores_printed_funding_text)
    r.record("verifier_timeout_standard_llm_budget", test_verifier_activity_timeout_allows_llm_call)
    r.record("safe_time_ok", test_safe_time_returns_float)
    r.record("safe_time_fallback", test_safe_time_handles_exception)
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
    r.record(
        "structured_from_output_mixed_schema",
        test_structured_response_from_output_files_keeps_mixed_schema_file_fields,
    )
    r.record("declared_schema_fast_path_bounds", test_declared_schema_fast_path_enforces_bounds_and_nullable_fields)
    r.record("code_evidence_omits_out_of_bounds_sequence", test_code_evidence_omits_optional_sequence_outside_its_bounds)
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
    await r.record_async(
        "repo_save_msg_task_complete_omits_subagent",
        test_repo_save_message_task_complete_omits_subagent,
    )
    await r.record_async("repo_save_msg_error", test_repo_save_message_error_flag)
    await r.record_async("repo_save_msg_swallows", test_repo_save_message_swallows_http_errors)
    await r.record_async("repo_create_session_happy", test_repo_create_e2b_session_happy)
    await r.record_async("repo_create_session_codex", test_repo_create_e2b_session_codex_provider)
    await r.record_async("repo_create_session_raises", test_repo_create_e2b_session_raises_on_error)
    await r.record_async("repo_persist_output_happy", test_repo_persist_terminal_output_happy)
    await r.record_async("repo_persist_output_swallows", test_repo_persist_terminal_output_swallows_errors)
    r.record(
        "build_durable_terminal_transcript",
        test_build_durable_terminal_transcript_prefers_events_over_janky_pty,
    )
    r.record(
        "format_code_events_transcript",
        test_format_code_events_transcript_skips_empty_tool_results,
    )
    r.record(
        "format_code_events_transcript_failed_status",
        test_format_code_events_transcript_covers_failed_and_status_only_results,
    )
    r.record(
        "format_code_events_transcript_project_startup",
        test_format_code_events_transcript_reports_project_startup,
    )
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
    r.record(
        "handler_select_ignores_process_env",
        test_handler_select_code_provider_is_independent_of_process_environment,
    )
    r.record(
        "activity_provider_resolver_env_override",
        test_activity_provider_resolver_applies_valid_environment_override,
    )
    r.record("handler_select_claude_without_gpt", test_handler_select_code_provider_keeps_claude_without_gpt_token)
    # _handle_reconnect_exhausted
    await r.record_async("handle_reconnect_alive", test_handle_reconnect_exhausted_alive_sandbox)
    await r.record_async("handle_reconnect_dead", test_handle_reconnect_exhausted_dead_sandbox)
    await r.record_async("handle_reconnect_health_none", test_handle_reconnect_exhausted_health_none)
    # _run_verifier
    await r.record_async("run_verifier_happy", test_run_verifier_happy_path)
    await r.record_async("run_verifier_disabled_env", test_run_verifier_disabled_by_env_flag)
    await r.record_async(
        "run_verifier_disabled_schema_incomplete",
        test_run_verifier_disabled_rejects_schema_incomplete_artifacts,
    )
    await r.record_async(
        "run_verifier_disabled_includes_sdk_stdout",
        test_run_verifier_disabled_includes_sdk_event_stdout,
    )
    await r.record_async("run_verifier_exception", test_run_verifier_exception_fallback)
    await r.record_async(
        "run_verifier_codex_event_json",
        test_run_verifier_uses_code_event_json_for_codex_context,
    )
    await r.record_async(
        "run_verifier_truncation_preserves_rejection", test_run_verifier_truncation_preserves_rejection
    )
    await r.record_async("run_verifier_no_override_no_trunc", test_run_verifier_no_override_when_no_truncation)
    await r.record_async(
        "run_verifier_no_override_no_attempt", test_run_verifier_no_override_when_attempt_completion_false
    )
    await r.record_async("run_verifier_no_override_already_pass", test_run_verifier_no_override_when_already_passing)
    # _run_agentic_loop
    await r.record_async("run_agentic_loop_exit_zero", test_run_agentic_loop_exit_zero_completes)
    await r.record_async("run_agentic_loop_connect_fail", test_run_agentic_loop_connect_fail_raises)
    await r.record_async(
        "run_agentic_loop_sdk_idle_timeout",
        test_run_agentic_loop_sdk_idle_timeout_breaks,
    )
    await r.record_async(
        "run_agentic_loop_wait_tool_extends_sdk_idle",
        test_run_agentic_loop_wait_tool_extends_sdk_idle_timeout,
    )
    await r.record_async(
        "run_agentic_loop_in_flight_bash_extends_sdk_idle",
        test_run_agentic_loop_in_flight_bash_extends_sdk_idle_timeout,
    )
    await r.record_async(
        "run_agentic_loop_bash_tool_result_keeps_stretched_sdk_idle",
        test_run_agentic_loop_bash_tool_result_keeps_stretched_sdk_idle,
    )
    await r.record_async(
        "run_agentic_loop_sdk_result_blocks_stretch_rearm",
        test_run_agentic_loop_sdk_result_blocks_stretch_rearm,
    )
    await r.record_async(
        "run_agentic_loop_post_result_exit_grace_breaks",
        test_run_agentic_loop_post_result_exit_grace_breaks,
    )
    r.record("log_codex_fast_cache_event", test_log_code_agent_event_promotes_codex_fast_cache_request)
    r.record(
        "log_claude_tool_use_event",
        test_log_code_agent_event_promotes_claude_tool_use_to_info,
    )
    r.record(
        "log_claude_cli_rate_limit_and_api_retry",
        test_log_code_agent_event_surfaces_claude_cli_rate_limit_and_api_retry,
    )
    r.record("codex_completed_turn_count", test_codex_completed_turn_count_counts_unique_turn_completed_events)
    # spawn_claude_code_activity
    await r.record_async(
        "spawn_activity_resolves_claude_credential",
        test_spawn_activity_resolves_claude_credential_inside_activity,
    )
    await r.record_async(
        "spawn_activity_skips_claude_credential_for_codex",
        test_spawn_activity_does_not_fetch_claude_credential_for_codex,
    )
    await r.record_async("spawn_activity_requires_schema", test_spawn_activity_requires_output_schema)
    await r.record_async("spawn_activity_happy", test_spawn_activity_happy_path_end_to_end)
    await r.record_async(
        "spawn_activity_fast_exit_auth_failure",
        test_spawn_activity_fast_exit_auth_failure_is_terminal,
    )
    await r.record_async(
        "spawn_activity_codex_oauth_fallback_success",
        test_spawn_activity_codex_oauth_fallback_success_continues,
    )
    await r.record_async(
        "spawn_activity_codex_double_exhaustion",
        test_spawn_activity_codex_double_exhaustion_is_terminal_and_persisted,
    )
    await r.record_async("spawn_activity_cancelled", test_spawn_activity_cancelled_cleanup)
    await r.record_async("spawn_activity_error_reraises", test_spawn_activity_error_reraises_after_cleanup)
    # SpawnClaudeCodeAgentManager.execute_tool
    await r.record_async("cc_exec_happy", test_cc_execute_tool_happy_path_yields_finished)
    await r.record_async(
        "cc_exec_forced_claude_no_serialized_credential",
        test_cc_execute_tool_records_forced_provider_without_serializing_credential,
    )
    await r.record_async("cc_exec_incomplete", test_cc_execute_tool_non_boolean_success_is_incomplete)
    await r.record_async("cc_exec_files", test_cc_execute_tool_emits_assistant_events_for_files)
    await r.record_async("cc_exec_cancel_status", test_cc_execute_tool_cancelled_status_yields_error)
    await r.record_async("cc_exec_cancel_error", test_cc_execute_tool_cancelled_error_path)
    await r.record_async("cc_exec_generic_exc", test_cc_execute_tool_generic_exception_yields_error)
    await r.record_async(
        "cc_exec_github_access_denied_soft_fail",
        test_cc_execute_tool_github_access_denied_soft_fails_finished,
    )
    await r.record_async(
        "cc_exec_sandbox_infra_soft_fail",
        test_cc_execute_tool_sandbox_infra_soft_fails_finished,
    )
    await r.record_async(
        "cc_exec_no_healthy_upstream_soft_fail",
        test_cc_execute_tool_no_healthy_upstream_soft_fails_finished,
    )
    await r.record_async(
        "cc_exec_missing_payment_method_soft_fail",
        test_cc_execute_tool_missing_payment_method_soft_fails_finished,
    )
    await r.record_async(
        "cc_exec_readtimeout_soft_fail",
        test_cc_execute_tool_readtimeout_soft_fails_finished,
    )
    r.record(
        "cc_spawn_activity_retries_capacity_flakes",
        test_cc_spawn_activity_retries_capacity_flakes_before_soft_fail,
    )
    await r.record_async("cc_exec_paused", test_cc_execute_tool_paused_cancels_activity)
    r.record(
        "claude_code_max_runtime_cuda_kernel_headroom",
        test_claude_code_max_runtime_leaves_cuda_kernel_bench_headroom,
    )
    await r.record_async(
        "cc_local_sandbox_stop_ends_its_cli",
        test_local_code_sandbox_stop_ends_the_claude_cli_it_spawned,
    )
    await r.record_async(
        "cc_drain_detaches_and_reattaches_same_sandbox",
        test_claude_code_detaches_on_worker_drain_and_reattaches_same_sandbox,
    )
    await r.record_async(
        "cc_crash_retry_reattaches_from_heartbeat",
        test_claude_code_retry_after_worker_crash_reattaches_from_heartbeat,
    )
    await r.record_async(
        "cc_agent_message_delivered_once_and_answered",
        test_agent_message_to_running_code_agent_is_delivered_once_and_answered,
    )
    await r.record_async(
        "cc_unreachable_session_closed_before_fresh_start",
        test_claude_code_unreachable_session_is_closed_before_a_fresh_start,
    )
    await r.record_async(
        "cc_reattach_survives_transient_probe_failure",
        test_claude_code_reattach_survives_a_transient_probe_failure,
    )
    await r.record_async(
        "cc_cancel_during_drain_detach_closes_sandbox",
        test_claude_code_cancel_during_drain_detach_still_closes_the_sandbox,
    )
    await r.record_async(
        "cc_closes_sandbox_when_no_attempt_will_reattach",
        test_claude_code_closes_the_sandbox_when_no_attempt_will_reattach,
    )
    await r.record_async(
        "cc_pause_during_reattach_probe_closes_sandbox",
        test_claude_code_pause_during_reattach_probe_closes_the_sandbox,
    )
    await r.record_async(
        "cc_new_sandbox_rides_heartbeat_before_first_write",
        test_claude_code_new_sandbox_rides_the_heartbeat_before_anything_else_can_fail,
    )
    await r.record_async(
        "cc_llm_heartbeats_keep_code_session",
        test_llm_heartbeats_inside_a_code_session_keep_the_session,
    )
    await r.record_async(
        "cc_reconnect_replay_does_not_duplicate_events",
        test_run_agentic_loop_reconnect_replay_does_not_duplicate_events,
    )
    r.record(
        "cc_sandbox_ws_servers_linger_past_heartbeat_timeout",
        test_sandbox_ws_servers_linger_past_the_activity_heartbeat_timeout,
    )
    await r.record_async(
        "cc_manager_reattaches_after_worker_drain_on_same_queue",
        test_cc_manager_reattaches_after_worker_drain_on_same_queue,
    )
    await r.record_async(
        "cc_manager_parks_code_session_for_generation_handoff",
        test_cc_manager_parks_code_session_for_generation_handoff,
    )
    await r.record_async(
        "cc_manager_finishes_on_superseded_generation_without_parking",
        test_cc_manager_finishes_on_superseded_generation_when_parking_unavailable,
    )
    await r.record_async(
        "cc_manager_parked_reentry_reattaches_without_a_new_chip",
        test_cc_manager_parked_reentry_reattaches_without_a_new_chip,
    )
    await r.record_async(
        "cc_manager_pause_after_drain_closes_detached_sandbox",
        test_cc_manager_pause_after_drain_closes_the_detached_sandbox,
    )
    await r.record_async(
        "cc_manager_cancel_before_reattach_closes_detached_sandbox",
        test_cc_manager_cancel_before_reattach_closes_the_detached_sandbox,
    )
    await r.record_async(
        "cc_manager_leaves_cleanup_to_attached_activity",
        test_cc_manager_leaves_cleanup_to_an_activity_that_held_the_sandbox,
    )
    await r.record_async(
        "cc_manager_closes_sandbox_when_last_attempt_times_out",
        test_cc_manager_closes_the_sandbox_when_the_last_attempt_times_out,
    )
    teardown_mock()
    return r.all_passed


async def run_all_tests():
    # Suite fixtures must control this gate even when agents/.env disables the
    # production verifier. Individual disabled-path tests override it to "1".
    with patch.dict(os.environ, {"ROSE_DISABLE_CODE_AGENT_VERIFIER": "0"}):
        return await _run_all_tests()



def test_build_durable_terminal_transcript_prefers_events_over_janky_pty():
    """Structured code events win over raw PTY so the FE gets a coherent log."""
    from domains.spawn_claude_code_agent.service import build_durable_terminal_transcript

    # No timeline events → keep PTY display.
    assert build_durable_terminal_transcript("live pty\noutput", [], ["step"]) == "live pty\noutput"
    assert build_durable_terminal_transcript("   ", [], []) == ""

    janky_pty = (
        "[Claude] Session started in /home/user\n"
        "                                      [Claude] I'll start...\n"
        "                                                           [Claude tool] Bash\n"
    )
    transcript = build_durable_terminal_transcript(
        janky_pty,
        [
            {
                "provider": "claude",
                "type": "session",
                "cwd": "/home/user",
            },
            {
                "provider": "claude",
                "type": "agent_message",
                "text": "I'll start by checking GitHub access.",
            },
            {
                "provider": "claude",
                "type": "tool_use",
                "tool": "Bash",
                "input": {"command": "gh auth status"},
            },
            {
                "provider": "claude",
                "type": "tool_use",
                "name": "Write",
                "input": {"file_path": "/home/user/discovery.py"},
            },
            {
                "type": "assistant",
                "content": "Found 100 repos",
            },
            {"type": "result", "status": "completed", "text": "done"},
        ],
        ["Connected to Claude Code WebSocket", "Agentic loop finished"],
    )
    assert "[Claude] Session started in /home/user" in transcript
    assert "[Claude] I'll start by checking GitHub access." in transcript
    assert "[Claude tool] Bash · gh auth status" in transcript
    assert "[Claude tool] Write · /home/user/discovery.py" in transcript
    assert "[Claude] Found 100 repos" in transcript
    assert "[Claude result] done" in transcript
    assert "## Action Summary" in transcript
    assert "Connected to Claude Code WebSocket" in transcript
    # Must not prefer the staircase PTY once events exist.
    assert "                                      [Claude]" not in transcript


def test_format_code_events_transcript_skips_empty_tool_results():
    from domains.spawn_claude_code_agent.service import format_code_events_transcript

    transcript = format_code_events_transcript(
        [
            {"type": "tool_use", "tool": "Bash", "input": {"command": "ls"}},
            {"type": "tool_result", "status": "completed"},
            {"type": "tool_result", "error": "command failed"},
        ]
    )
    assert transcript.splitlines() == [
        "[Claude tool] Bash · ls",
        "[Claude result] command failed",
    ]


def test_format_code_events_transcript_reports_project_startup():
    """PJ3: a project's startup outcome (ws-server event) is visible in the transcript."""
    from domains.spawn_claude_code_agent.service import format_code_events_transcript

    transcript = format_code_events_transcript(
        [
            {"type": "project_startup", "status": "running", "project": "Rose"},
            {"type": "project_startup", "status": "ok", "project": "Rose", "durationMs": 12345},
            {"type": "project_startup", "status": "failed", "project": "Rose", "exitCode": 3, "durationMs": 400},
            {"type": "project_startup", "status": "timeout", "project": "Rose", "timeoutS": 120},
            {"type": "project_startup", "status": "skipped"},
        ]
    )
    assert transcript.splitlines() == [
        "[Claude] Project startup (Rose): ok in 12.3s",
        "[Claude] Project startup (Rose): failed (exit 3) in 0.4s",
        "[Claude] Project startup (Rose): timed out after 120s",
    ]


def test_format_code_events_transcript_covers_failed_and_status_only_results():
    from domains.spawn_claude_code_agent.service import format_code_events_transcript

    transcript = format_code_events_transcript(
        [
            {"type": "tool_use", "tool": "Write"},
            {"type": "result", "status": "failed", "text": "rank script exited 1"},
            {"type": "result", "status": "cancelled"},
        ]
    )
    assert transcript.splitlines() == [
        "[Claude tool] Write",
        "[Claude result] failed - rank script exited 1",
        "[Claude result] cancelled",
    ]


def test_claude_code_max_runtime_leaves_cuda_kernel_bench_headroom():
    """Hung Claude Code must return before the cuda-kernel bench budget is gone.

    Local repro (k=3, 2026-09-02): with MAX_RUNTIME_S=3600 and task timeout=4200,
    two roots waited 3009s/3721s on claude_code_activity_wait and timed out with
    no recovery. A completed code-agent path finished CC in ~947s. Cap CC at 30m
    so a hang still leaves ≥15m of parent budget inside the 70m task timeout.
    """
    import json
    from pathlib import Path

    from domains.spawn_claude_code_agent.config import MAX_RUNTIME_S

    tasks = json.loads(
        (Path(__file__).resolve().parents[2] / "benchmarks" / "tasks.json").read_text()
    )
    if isinstance(tasks, dict):
        tasks = tasks.get("tasks", tasks)
    cuda = next(t for t in tasks if t["name"] == "cuda-kernel-github-top100-code-agent")
    task_timeout = int(cuda["timeout_seconds"])

    assert MAX_RUNTIME_S == 1800
    assert task_timeout >= 4200
    assert task_timeout - MAX_RUNTIME_S >= 900


# ── Deploy drain: detach from the sandbox, reattach to the same run ──────────

_STUB_CLAUDE_CLI = r"""
import json
import os
import sys
import time

# stream-json input: one JSON user message per line. The ws-server keeps
# stdin open until every written turn has its result, then closes it.
gate = os.environ["STUB_CLAUDE_GATE"]


def emit(message):
    print(json.dumps(message), flush=True)


def record(line):
    text = "".join(part.get("text", "") for part in json.loads(line)["message"]["content"])
    with open(os.path.join(gate, "turns.jsonl"), "a") as turns:
        turns.write(json.dumps({"text": text}) + "\n")
    return text


record(sys.stdin.readline())


def wait_for(name):
    while not os.path.exists(os.path.join(gate, name)):
        time.sleep(0.05)


emit({"type": "system", "subtype": "init", "session_id": "stub", "cwd": os.getcwd(), "model": "stub",
      "tools": ["Write"], "permissionMode": "bypassPermissions"})
emit({"type": "assistant", "message": {"content": [{"type": "text", "text": "step 1: drafted half of answer.txt"}]}})
wait_for("continue")
emit({"type": "assistant", "message": {"content": [{"type": "text", "text": "step 2: finished answer.txt"}]}})
wait_for("exit")
emit({"type": "result", "subtype": "success", "result": "answer is 42", "usage": {}})
# Later turns (direct chat / agent-graph messages): answer each, exit on EOF.
while True:
    line = sys.stdin.readline()
    if not line:
        break
    text = record(line)
    time.sleep(float(os.environ.get("STUB_CLAUDE_TURN_DELAY_S", "0")))
    emit({"type": "assistant", "message": {"content": [{"type": "text", "text": "ack: " + text[-60:]}]}})
    emit({"type": "result", "subtype": "success", "result": "turn answered", "usage": {}})
"""

_CC_STEP_TEXTS = ["step 1: drafted half of answer.txt", "step 2: finished answer.txt"]
_CC_SCHEMA = {"fields": [{"name": "answer", "type": "str", "required": True}]}


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class _LocalCodeSandbox:
    """The production ws-server.mjs on localhost, running a scripted ``claude`` CLI.

    Like an E2B sandbox it outlives any single activity attempt, so a test can
    drop the activity mid-run and attach a new one to the same Claude Code run.
    The CLI blocks on gate files so the test decides when it continues/exits.
    """

    def __init__(self, extra_env: dict[str, str] | None = None) -> None:
        self._extra_env = dict(extra_env or {})
        self._tmp = Path(tempfile.mkdtemp(prefix="cc-sandbox-"))
        self.port = _free_port()
        self.ws_url = f"ws://127.0.0.1:{self.port}"
        self._log_path = self._tmp / "ws-server.log"
        self._process: subprocess.Popen | None = None

    async def start(self) -> None:
        node = shutil.which("node")
        assert node, "node is required to run the Claude Code ws-server under test"
        server = Path(__file__).resolve().parents[3] / "e2b-templates" / "claude-code" / "ws-server.mjs"
        bin_dir = self._tmp / "bin"
        home = self._tmp / "home"
        bin_dir.mkdir()
        home.mkdir()
        (self._tmp / "stub_claude.py").write_text(_STUB_CLAUDE_CLI)
        cli = bin_dir / "claude"
        cli.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{self._tmp / "stub_claude.py"}" "$@"\n')
        cli.chmod(0o755)
        env = {
            "PATH": f"{bin_dir}:{os.environ.get('PATH', '')}",
            "HOME": str(home),
            "PORT": str(self.port),
            "CLAUDE_CODE_GOAL": "Write answer.txt with the answer",
            "ANTHROPIC_API_KEY": "stub-key",
            "STUB_CLAUDE_GATE": str(self._tmp),
            **self._extra_env,
        }
        with self._log_path.open("w") as log:
            self._process = subprocess.Popen(
                [node, str(server)],
                cwd=home,
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        for _ in range(200):
            assert self._process.poll() is None, f"ws-server exited at startup:\n{self.log()}"
            with contextlib.suppress(OSError), socket.create_connection(("127.0.0.1", self.port), timeout=0.2):
                return
            await asyncio.sleep(0.05)
        raise AssertionError(f"ws-server never listened on {self.port}:\n{self.log()}")

    def release(self, gate: str) -> None:
        (self._tmp / gate).touch()

    def log(self) -> str:
        return self._log_path.read_text() if self._log_path.exists() else ""

    async def wait_for_log(self, needle: str, timeout: float = 15.0) -> None:
        for _ in range(int(timeout / 0.05)):
            if needle in self.log():
                return
            await asyncio.sleep(0.05)
        raise AssertionError(f"ws-server never logged {needle!r}:\n{self.log()}")

    def turns(self) -> list[str]:
        """Every user turn the scripted CLI read from stdin, in order."""
        path = self._tmp / "turns.jsonl"
        if not path.exists():
            return []
        return [json.loads(line)["text"] for line in path.read_text().splitlines() if line.strip()]

    @property
    def cli_script(self) -> Path:
        return self._tmp / "stub_claude.py"

    def stop(self) -> None:
        # The ws-server leaves its CLI running on SIGTERM; E2B kills the whole
        # sandbox, so the stand-in signals the server's entire process group.
        if self._process is not None:
            self._signal_sandbox(signal.SIGTERM)
            with contextlib.suppress(subprocess.TimeoutExpired):
                self._process.wait(timeout=5)
            self._signal_sandbox(signal.SIGKILL)
            self._process.wait()
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _signal_sandbox(self, sig: signal.Signals) -> None:
        # macOS answers EPERM rather than ESRCH once the group holds only
        # zombies awaiting reaping; either way nothing is left to signal, and
        # the test's own process listing proves the CLI actually ended.
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(self._process.pid, sig)


def _pids_running(marker: str) -> list[int]:
    listing = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True, check=True).stdout
    return [int(line.split(None, 1)[0]) for line in listing.splitlines() if marker in line]


async def test_local_code_sandbox_stop_ends_the_claude_cli_it_spawned():
    """Stopping the stand-in sandbox must end its CLI the way an E2B kill does.

    stop() terminated only the ws-server, so every test run orphaned its stub
    CLI, which then polled the deleted gate files forever (28 survivors had
    piled up on one dev VM).
    """
    sandbox = _LocalCodeSandbox()
    await sandbox.start()
    marker = str(sandbox.cli_script)
    try:
        await sandbox.wait_for_log("Starting Claude Code CLI")
        for _ in range(100):
            if _pids_running(marker):
                break
            await asyncio.sleep(0.05)
        assert _pids_running(marker), f"the stub CLI never started:\n{sandbox.log()}"
    finally:
        sandbox.stop()
    for _ in range(40):
        if not _pids_running(marker):
            return
        await asyncio.sleep(0.05)
    survivors = _pids_running(marker)
    for pid in survivors:
        with contextlib.suppress(ProcessLookupError):
            os.kill(pid, signal.SIGKILL)
    raise AssertionError(f"stop() left the sandbox's CLI running: pids={survivors}")


class _CCBoundaryRecorder:
    """Records every backend/sandbox boundary the Claude Code activity crosses."""

    def __init__(self, ws_url: str, live_queue: str = "test") -> None:
        self.ws_url = ws_url
        self.live_queue = live_queue
        self.created: list[dict] = []
        self.closed: list[dict] = []
        self.titles: list[str] = []
        self.persisted: list[str] = []
        self.verified_events: list[list[dict]] = []
        self.logged: list[dict] = []
        self.collector = AsyncMock()

    async def create_session(self, **kwargs):
        self.created.append(kwargs)
        return {"task_id": "cc-task-1", "sandbox_id": "sb-1", "ws_url": self.ws_url, "uploaded_files": []}

    async def close_session(self, **kwargs):
        self.closed.append(kwargs)
        return {"output_files": [], "usage": None}

    async def save_message(self, **kwargs):
        self.titles.append(kwargs.get("title"))

    async def persist_output(self, task_id, output, *args, **kwargs):
        self.persisted.append(output)

    async def verifier(self, **kwargs):
        self.verified_events.append([dict(event) for event in kwargs["code_events"]])
        return (1.0, "answer.txt contains 42", {"answer": "42"}, 0, 0)

    async def queue_pointer(self, **kwargs):
        return {"task_queue": self.live_queue}

    @contextlib.contextmanager
    def patched(self):
        from domains.spawn_claude_code_agent import service
        from helpers.activity_generation_drain import reset_live_queue_cache

        reset_live_queue_cache()
        with (
            patch.object(service, "create_e2b_session", side_effect=self.create_session),
            patch.object(service, "close_e2b_session", side_effect=self.close_session),
            patch.object(service, "save_claude_code_message", side_effect=self.save_message),
            patch.object(service, "persist_terminal_output", side_effect=self.persist_output),
            patch.object(service, "_run_verifier", side_effect=self.verifier),
            patch.object(service, "_log_code_agent_event", side_effect=lambda event, **kw: self.logged.append(event)),
            patch.object(service, "REATTACH_PROBE_BACKOFF_S", 0.05),
            patch.object(service, "SandboxLogCollector", lambda *a, **kw: self.collector),
            patch.object(service, "_resolve_claude_token_for_activity", AsyncMock(return_value=None)),
            patch(
                "helpers.model_pricing.get_model_pricing_with_fallback",
                AsyncMock(return_value={"input_cents_per_1k": 0, "output_cents_per_1k": 0}),
            ),
            patch("helpers.activity_generation_drain.read_agent_queue_pointer", side_effect=self.queue_pointer),
        ):
            yield
        reset_live_queue_cache()


def _cc_activity_args(*resume: dict) -> list:
    return [
        "user-cc",
        "agent-cc",
        "Write answer.txt with the answer",
        "tc-cc",
        _CC_SCHEMA,
        None,  # attachments
        "rose-labs/rose-1-flash",
        None,  # github_repo_url
        None,  # legacy credential slot
        "claude",
        None,
        None,
        None,
        None,
        False,  # fast_mode_cache_enabled
        *resume,
    ]


async def _wait_for_heartbeat(beats: list, predicate, what: str, timeout: float = 15.0) -> tuple:
    for _ in range(int(timeout / 0.05)):
        for beat in reversed(beats):
            if predicate(beat):
                return beat
        await asyncio.sleep(0.05)
    raise AssertionError(f"activity never heartbeated {what}; got {beats[-5:]}")


def _assert_full_run_seen_once(events: list[dict]) -> None:
    texts = [event.get("text") for event in events if event.get("type") == "agent_message"]
    assert texts == _CC_STEP_TEXTS, f"reattached run must see every step exactly once, got {texts}"
    results = [event for event in events if event.get("type") == "result"]
    assert len(results) == 1 and results[0].get("text") == "answer is 42", results
    finals = [event for event in events if event.get("type") == "final"]
    assert len(finals) == 1 and finals[0].get("exit_code") == 0, finals


async def test_claude_code_detaches_on_worker_drain_and_reattaches_same_sandbox():
    """A deploy drain must not end a Claude Code run that is still working.

    Rolling deploys SIGTERM the worker; the activity used to keep monitoring
    until the 5m grace expired, then took the pause path: close_e2b_session
    killed the sandbox and the parent read "cancelled by user". The run must
    instead detach (sandbox untouched) and a new activity must reattach to the
    same sandbox — even when Claude Code finished while nothing was attached —
    and see the whole run exactly once.
    """
    from temporalio.testing import ActivityEnvironment

    from domains.spawn_claude_code_agent import service

    sandbox = _LocalCodeSandbox()
    await sandbox.start()
    recorder = _CCBoundaryRecorder(sandbox.ws_url)
    try:
        with recorder.patched():
            beats: list = []
            draining = ActivityEnvironment()
            draining.on_heartbeat = lambda *details: beats.append(details)
            first = asyncio.create_task(draining.run(service.spawn_claude_code_activity, *_cc_activity_args()))
            await _wait_for_heartbeat(beats, lambda b: b[0] == "Processing Claude Code output", "a sandbox message")

            draining.worker_shutdown()
            done, _ = await asyncio.wait({first}, timeout=10)
            if not done:
                draining.cancel()  # the worker's shutdown grace ran out
                outcome = await first
                raise AssertionError(
                    "activity ignored the worker drain until its grace expired, then returned "
                    f"{outcome.get('status')!r} ({outcome.get('message')!r}) and closed the sandbox "
                    f"{len(recorder.closed)} time(s)"
                )
            yielded = first.result()

            from domains.spawn_claude_code_agent.config import CODE_AGENT_DRAIN_YIELD_STATUS
            from helpers.activity_generation_drain import WORKER_SHUTDOWN

            assert yielded["status"] == CODE_AGENT_DRAIN_YIELD_STATUS, yielded
            assert yielded["yield_reason"] == WORKER_SHUTDOWN, yielded
            assert recorder.closed == [], f"a drain must leave the sandbox running, closed={recorder.closed}"
            assert "Session Cancelled" not in recorder.titles, recorder.titles
            session = yielded["code_session"]
            assert session["task_id"] == "cc-task-1" and session["sandbox_id"] == "sb-1", session
            assert session["ws_url"] == sandbox.ws_url and session["code_provider"] == "claude", session

            # Claude Code keeps working and finishes while no activity is attached.
            sandbox.release("continue")
            sandbox.release("exit")
            await sandbox.wait_for_log("Claude Code CLI exited")
            await asyncio.sleep(0.5)

            resumed = ActivityEnvironment()
            outcome = await asyncio.wait_for(
                resumed.run(service.spawn_claude_code_activity, *_cc_activity_args(session)), timeout=30
            )
        assert len(recorder.created) == 1, f"reattach must not create another sandbox, created={recorder.created}"
        assert outcome["status"] == "completed" and outcome["success"] is True, outcome
        assert outcome["task_id"] == "cc-task-1", outcome
        assert outcome["structured_response"] == {"answer": "42"}, outcome
        assert len(recorder.verified_events) == 1
        _assert_full_run_seen_once(recorder.verified_events[0])
        # Events produced while nothing was attached reach the worker only in the
        # reattach replay; they must still land in retained logs, once.
        assert recorder.logged == recorder.verified_events[0], (
            f"every sandbox event must be logged exactly once, logged={[e.get('type') for e in recorder.logged]}"
        )
        assert recorder.titles.count("Claude Code Started") == 1, recorder.titles
        assert [call["task_id"] for call in recorder.closed] == ["cc-task-1"], recorder.closed
        assert recorder.persisted and all(text in recorder.persisted[-1] for text in _CC_STEP_TEXTS), recorder.persisted
    finally:
        sandbox.stop()


async def test_agent_message_to_running_code_agent_is_delivered_once_and_answered():
    """Root → running code agent (C6): one CLI user turn across a retried send.

    The message arrives mid-run, before the task's first `result`. The
    ws-server must hold stdin open until that turn is answered, the retried
    delivery (same turn id, as a Temporal retry of the sending activity) must
    not write a second turn, and the monitor must not take the task's result
    as the end of the session: with a short post-result grace, ending on the
    first result would drop the agent turn's answer.
    """
    from temporalio.testing import ActivityEnvironment

    from domains.spawn_claude_code_agent import service
    from helpers.agent_graph import a2a_message_id
    from helpers.code_session_turns import code_session_turn_token, deliver_user_turn_to_code_session

    secret = "a2a-blackbox-secret"
    token = code_session_turn_token("cc-task-1", secret=secret)
    sandbox = _LocalCodeSandbox({"CODE_SESSION_TURN_TOKEN": token, "STUB_CLAUDE_TURN_DELAY_S": "1.0"})
    await sandbox.start()
    recorder = _CCBoundaryRecorder(sandbox.ws_url)
    try:
        with recorder.patched(), patch.object(service, "SDK_POST_RESULT_EXIT_GRACE_S", 0.3):
            beats: list = []
            env = ActivityEnvironment()
            env.on_heartbeat = lambda *details: beats.append(details)
            run = asyncio.create_task(env.run(service.spawn_claude_code_activity, *_cc_activity_args()))
            await _wait_for_heartbeat(beats, lambda b: b[0] == "Processing Claude Code output", "a sandbox message")

            turn_id = a2a_message_id("wf-root", "tc-send-1")
            text = "[Message from Root agent, agent_id root-1.] Use port 4242."
            first = await deliver_user_turn_to_code_session(
                sandbox.ws_url, task_id="cc-task-1", text=text, turn_id=turn_id, sender="agent", token=token
            )
            retried = await deliver_user_turn_to_code_session(
                sandbox.ws_url, task_id="cc-task-1", text=text, turn_id=turn_id, sender="agent", token=token
            )
            assert first.status == "delivered", first
            assert retried.status == "duplicate", retried

            sandbox.release("continue")
            sandbox.release("exit")
            outcome = await asyncio.wait_for(run, timeout=30)

        assert outcome["status"] == "completed" and outcome["success"] is True, outcome
        turns = sandbox.turns()
        assert turns[0].startswith("Task:\n"), turns
        assert turns[1:] == [text], f"the CLI must read the agent turn exactly once, read {turns}"
        events = recorder.verified_events[0]
        user_turns = [event for event in events if event.get("type") == "user_turn"]
        assert [(event.get("turn_id"), event.get("sender")) for event in user_turns] == [(turn_id, "agent")], user_turns
        results = [event.get("text") for event in events if event.get("type") == "result"]
        assert results == ["answer is 42", "turn answered"], f"the monitor ended before the agent turn: {results}"
        finals = [event for event in events if event.get("type") == "final"]
        assert len(finals) == 1 and finals[0].get("exit_code") == 0, finals
        assert not any(
            event.get("type") == "direct_chat" for event in events
        ), "an agent message must not take the user's direct-chat hold"
        transcript = service.format_code_events_transcript(events)
        assert f"[Agent → Claude] {text}" in transcript, transcript
    finally:
        sandbox.stop()


def _carries_session(beat: tuple, task_id: str = "cc-task-1") -> bool:
    return any(
        isinstance(detail, dict)
        and any(isinstance(value, dict) and value.get("task_id") == task_id for value in detail.values())
        for detail in beat[1:]
    )


async def test_claude_code_retry_after_worker_crash_reattaches_from_heartbeat():
    """A Temporal retry after a dead worker resumes the sandbox it was attached to.

    SIGKILL/OOM gives the activity no chance to yield. Temporal retries after
    the heartbeat timeout, and the retry used to call create_e2b_session again:
    Claude Code restarted from scratch and the first sandbox leaked. Every
    heartbeat must carry the session so the retry reattaches instead; the
    timed-out attempt must not close the sandbox the retry is reattaching to;
    and the retry must prefer that heartbeat session over the scheduled
    resume_session, whose sandbox the first attempt had already replaced.
    """
    from temporalio.activity import ActivityCancellationDetails
    from temporalio.testing import ActivityEnvironment

    from domains.spawn_claude_code_agent import service

    stale = {
        "task_id": "cc-task-old",
        "sandbox_id": "sb-old",
        "ws_url": f"ws://127.0.0.1:{_free_port()}",
        "code_provider": "claude",
    }
    sandbox = _LocalCodeSandbox()
    await sandbox.start()
    recorder = _CCBoundaryRecorder(sandbox.ws_url)
    try:
        with recorder.patched():
            beats: list = []
            crashing = ActivityEnvironment()
            crashing.on_heartbeat = lambda *details: beats.append(details)
            first = asyncio.create_task(crashing.run(service.spawn_claude_code_activity, *_cc_activity_args(stale)))
            await _wait_for_heartbeat(beats, lambda b: b[0] == "Processing Claude Code output", "a sandbox message")
            # The first beat of an attempt is sent at once and later ones are
            # throttled, so a beat without the session can be the last one the
            # server holds when the worker dies.
            assert beats and all(_carries_session(beat) for beat in beats), (
                f"every heartbeat must carry the attached session, got {[b[0] for b in beats if not _carries_session(b)]}"
            )
            last_beat = beats[-1]

            crashing.cancel(cancellation_details=ActivityCancellationDetails(timed_out=True))
            first_outcome = None
            with contextlib.suppress(asyncio.CancelledError):
                first_outcome = await first
            assert first_outcome is None, f"a timed-out attempt must not report the run cancelled: {first_outcome}"
            assert [call["task_id"] for call in recorder.closed] == ["cc-task-old"], (
                f"a timed-out attempt must leave its sandbox for the retry, closed={recorder.closed}"
            )
            assert "Session Cancelled" not in recorder.titles, recorder.titles

            sandbox.release("continue")
            sandbox.release("exit")
            await sandbox.wait_for_log("Claude Code CLI exited")

            retry = ActivityEnvironment()
            retry.info = dataclasses.replace(retry.info, attempt=2, heartbeat_details=list(last_beat))
            outcome = await asyncio.wait_for(
                retry.run(service.spawn_claude_code_activity, *_cc_activity_args(stale)), timeout=30
            )
        assert len(recorder.created) == 1, f"retry must reattach, not create a sandbox: {recorder.created}"
        assert outcome["status"] == "completed" and outcome["task_id"] == "cc-task-1", outcome
        _assert_full_run_seen_once(recorder.verified_events[-1])
        assert [call["task_id"] for call in recorder.closed] == ["cc-task-old", "cc-task-1"], recorder.closed
    finally:
        sandbox.stop()


async def test_claude_code_reattach_survives_a_transient_probe_failure():
    """One failed handshake must not discard a live sandbox and rerun the task."""
    from aiohttp import web
    from temporalio.testing import ActivityEnvironment

    from domains.spawn_claude_code_agent import service

    requests = 0

    async def flaky(request):
        nonlocal requests
        ws = web.WebSocketResponse()
        if not ws.can_prepare(request).ok:
            # Count only the client's WebSocket handshakes; another local process
            # (e.g. a host port detector's `HEAD /`) must not take the 503 slot.
            return web.Response(status=400)
        requests += 1
        if requests == 1:
            return web.Response(status=503, text="proxy warming up")
        await ws.prepare(request)
        await ws.close()
        return ws

    app = web.Application()
    app.router.add_get("/", flaky)
    runner = web.AppRunner(app)
    await runner.setup()
    port = _free_port()
    await web.TCPSite(runner, "127.0.0.1", port).start()
    live = {
        "task_id": "cc-task-live",
        "sandbox_id": "sb-live",
        "ws_url": f"ws://127.0.0.1:{port}/",
        "code_provider": "claude",
    }

    async def attached_loop(**kwargs):
        assert kwargs["task_id"] == "cc-task-live", kwargs["task_id"]
        return (0, False, [], 0, 0, [{"type": "result", "status": "completed", "text": "answer is 42"}])

    recorder = _CCBoundaryRecorder(ws_url="ws://unused")
    try:
        with recorder.patched(), patch.object(service, "_run_agentic_loop", side_effect=attached_loop):
            outcome = await asyncio.wait_for(
                ActivityEnvironment().run(service.spawn_claude_code_activity, *_cc_activity_args(live)), timeout=30
            )
    finally:
        await runner.cleanup()
    assert requests >= 2, requests
    assert recorder.created == [], f"a reachable sandbox must be reattached, created={recorder.created}"
    assert [call["task_id"] for call in recorder.closed] == ["cc-task-live"], recorder.closed
    assert outcome["status"] == "completed" and outcome["task_id"] == "cc-task-live", outcome


async def test_claude_code_cancel_during_drain_detach_still_closes_the_sandbox():
    """A pause that lands while the activity is detaching still cleans up.

    The drain return used to sit in a sibling ``except`` of the cancel handler,
    so a cancel raised while it stopped the log collector escaped every
    cleanup: the sandbox stayed open and no task_id reached the chip.
    """
    from temporalio.testing import ActivityEnvironment

    from domains.spawn_claude_code_agent import service

    sandbox = _LocalCodeSandbox()
    await sandbox.start()
    recorder = _CCBoundaryRecorder(sandbox.ws_url)
    try:
        with recorder.patched():
            beats: list = []
            env = ActivityEnvironment()
            env.on_heartbeat = lambda *details: beats.append(details)
            running = asyncio.create_task(env.run(service.spawn_claude_code_activity, *_cc_activity_args()))
            await _wait_for_heartbeat(beats, lambda b: b[0] == "Processing Claude Code output", "a sandbox message")

            async def stop_then_get_paused():
                env.cancel()
                await asyncio.sleep(5)

            recorder.collector.stop.side_effect = stop_then_get_paused
            env.worker_shutdown()
            try:
                outcome = await asyncio.wait_for(running, timeout=15)
            except asyncio.CancelledError:
                raise AssertionError(
                    f"the cancel escaped the drain detach with no cleanup; closed={recorder.closed}"
                ) from None
        assert outcome["status"] == "cancelled" and outcome["task_id"] == "cc-task-1", outcome
        assert [call["task_id"] for call in recorder.closed] == ["cc-task-1"], recorder.closed
        assert "Session Cancelled" in recorder.titles, recorder.titles
    finally:
        sandbox.stop()


async def test_claude_code_closes_the_sandbox_when_no_attempt_will_reattach():
    """A cancel that no retry follows must not leave the sandbox running.

    Restart and deploy replacement terminate the workflow, which the attempt
    sees as a ``not_found`` cancel. Leaving the sandbox open for a retry that
    is never scheduled kept the old CLI working (and pushing to the same repo)
    next to the replacement run until E2B's own timeout. The same holds for
    the last attempt the retry policy allows. A paused activity or an attempt
    with retries left must still keep it for the reattach.
    """
    from temporalio.activity import ActivityCancellationDetails
    from temporalio.common import RetryPolicy
    from temporalio.testing import ActivityEnvironment

    from domains.spawn_claude_code_agent import service

    last_attempt = {"attempt": 5, "retry_policy": RetryPolicy(maximum_attempts=5)}
    cases = [
        ("workflow terminated", ActivityCancellationDetails(not_found=True), {}, True),
        ("activity reset", ActivityCancellationDetails(reset=True), {}, True),
        ("last attempt timed out", ActivityCancellationDetails(timed_out=True), last_attempt, True),
        ("last attempt's worker shut down", ActivityCancellationDetails(worker_shutdown=True), last_attempt, True),
        (
            "timed out with attempts left",
            ActivityCancellationDetails(timed_out=True),
            {"attempt": 2, "retry_policy": RetryPolicy(maximum_attempts=5)},
            False,
        ),
        ("paused on the last attempt", ActivityCancellationDetails(paused=True), last_attempt, False),
    ]
    for label, details, info_overrides, closes in cases:
        env = ActivityEnvironment()
        env.info = dataclasses.replace(env.info, **info_overrides)

        async def cancelled_loop(_env=env, _details=details, **kwargs):
            _env.cancel(cancellation_details=_details)
            await asyncio.sleep(30)

        recorder = _CCBoundaryRecorder(ws_url="ws://unused")
        outcome = None
        with recorder.patched(), patch.object(service, "_run_agentic_loop", side_effect=cancelled_loop):
            with contextlib.suppress(asyncio.CancelledError):
                outcome = await asyncio.wait_for(
                    env.run(service.spawn_claude_code_activity, *_cc_activity_args()), timeout=10
                )
        assert outcome is None, f"{label}: a cancel the workflow did not request is not a user cancel: {outcome}"
        assert "Session Cancelled" not in recorder.titles, (label, recorder.titles)
        expected = ["cc-task-1"] if closes else []
        assert [call["task_id"] for call in recorder.closed] == expected, (
            f"{label}: expected the sandbox {'closed' if closes else 'kept for the reattach'}, closed={recorder.closed}"
        )


async def test_claude_code_pause_during_reattach_probe_closes_the_sandbox():
    """A pause that lands while a retry probes its old sandbox still closes it.

    The retry only learned the task_id after the probe, so the cancel handler
    found nothing to close and the sandbox from the crashed attempt kept running.
    """
    from temporalio.testing import ActivityEnvironment

    from domains.spawn_claude_code_agent import service

    live = {"task_id": "cc-task-live", "sandbox_id": "sb-live", "ws_url": "ws://sb-live", "code_provider": "claude"}
    env = ActivityEnvironment()

    async def paused_during_probe(*args, **kwargs):
        env.cancel()
        await asyncio.sleep(30)

    recorder = _CCBoundaryRecorder(ws_url="ws://unused")
    with recorder.patched(), patch.object(service, "ws_endpoint_reachable", side_effect=paused_during_probe):
        outcome = await asyncio.wait_for(
            env.run(service.spawn_claude_code_activity, *_cc_activity_args(live)), timeout=10
        )
    assert outcome["status"] == "cancelled" and outcome["task_id"] == "cc-task-live", outcome
    assert [call["task_id"] for call in recorder.closed] == ["cc-task-live"], recorder.closed
    assert recorder.created == [], recorder.created


async def test_claude_code_new_sandbox_rides_the_heartbeat_before_anything_else_can_fail():
    """A crash right after the sandbox is created must not hide it from the retry.

    Two backend writes sat between create_e2b_session and the first heartbeat
    carrying the session; a worker that died inside them left the retry with
    no record of the sandbox, so it created a second one and the first leaked.
    """
    from temporalio.testing import ActivityEnvironment

    from domains.spawn_claude_code_agent import service

    beats: list = []
    env = ActivityEnvironment()
    env.on_heartbeat = lambda *details: beats.append(details)
    recorder = _CCBoundaryRecorder(ws_url="ws://unused")
    seen_at_first_write: list[bool] = []
    record_title = recorder.save_message

    async def save_message(**kwargs):
        if not seen_at_first_write:
            seen_at_first_write.append(any(_carries_session(beat) for beat in beats))
        await record_title(**kwargs)

    async def finished_loop(**kwargs):
        return (0, False, [], 0, 0, [{"type": "result", "status": "completed", "text": "answer is 42"}])

    with (
        recorder.patched(),
        patch.object(service, "save_claude_code_message", side_effect=save_message),
        patch.object(service, "_run_agentic_loop", side_effect=finished_loop),
    ):
        outcome = await asyncio.wait_for(env.run(service.spawn_claude_code_activity, *_cc_activity_args()), timeout=10)
    assert outcome["status"] == "completed", outcome
    assert seen_at_first_write == [True], (
        f"the session must be heartbeated before the first backend write, beats={[b[0] for b in beats]}"
    )


async def test_llm_heartbeats_inside_a_code_session_keep_the_session():
    """Heartbeats from LLM helpers the activity calls must not wipe its session.

    Each heartbeat replaces the details the retry reads. The parent-LLM call
    inside the Claude Code loop heartbeats through the Rose client and
    helpers.llm, which used to send no details at all.
    """
    from temporalio.testing import ActivityEnvironment

    from helpers.activity_heartbeat import heartbeat_resume_details
    from helpers.llm import _safe_heartbeat as llm_heartbeat
    from providers.rose.client import _safe_heartbeat as rose_heartbeat

    session = {"code_session": {"task_id": "cc-task-1"}}
    beats: list = []
    env = ActivityEnvironment()
    env.on_heartbeat = lambda *details: beats.append(details)

    async def beat_from_listener_task():
        rose_heartbeat("child task beat")

    async def body():
        with heartbeat_resume_details(session):
            rose_heartbeat("OpenRouter streaming chunk 3")
            llm_heartbeat("LLM streaming... 120 chars")
            await asyncio.create_task(beat_from_listener_task())
        llm_heartbeat("after the session closed")

    await env.run(body)
    assert [beat[1:] for beat in beats[:3]] == [(session,)] * 3, beats
    assert beats[3] == ("after the session closed",), beats[3]


async def test_claude_code_unreachable_session_is_closed_before_a_fresh_start():
    """When the old sandbox is gone, close it and start one fresh session."""
    from temporalio.testing import ActivityEnvironment

    from domains.spawn_claude_code_agent import service

    recorder = _CCBoundaryRecorder(ws_url=f"ws://127.0.0.1:{_free_port()}")
    stale = {
        "task_id": "cc-task-old",
        "sandbox_id": "sb-old",
        "ws_url": f"ws://127.0.0.1:{_free_port()}",
        "code_provider": "claude",
    }

    async def fresh_loop(**kwargs):
        return (0, False, [], 0, 0, [{"type": "result", "status": "completed", "text": "answer is 42"}])

    with recorder.patched(), patch.object(service, "_run_agentic_loop", side_effect=fresh_loop):
        outcome = await asyncio.wait_for(
            ActivityEnvironment().run(service.spawn_claude_code_activity, *_cc_activity_args(stale)), timeout=60
        )
    assert [call["task_id"] for call in recorder.closed] == ["cc-task-old", "cc-task-1"], recorder.closed
    assert len(recorder.created) == 1, recorder.created
    assert recorder.titles.count("Claude Code Started") == 1, recorder.titles
    assert outcome["status"] == "completed" and outcome["task_id"] == "cc-task-1", outcome


async def test_run_agentic_loop_reconnect_replay_does_not_duplicate_events():
    """ws-server resends its whole event buffer on every connect; keep one copy."""
    from aiohttp import web

    from domains.spawn_claude_code_agent import service
    from utils.terminal_filter import TerminalFilter

    first_events = [{"type": "agent_message", "text": "a"}, {"type": "agent_message", "text": "b"}]
    all_events = [*first_events, {"type": "result", "status": "completed", "text": "c"}]
    connections = 0

    async def handler(request):
        nonlocal connections
        ws = web.WebSocketResponse()
        if not ws.can_prepare(request).ok:
            # Dev-box port forwarders probe every new local listener (e.g. a
            # sprite-daemon `HEAD /`); only the client's WebSocket upgrades count.
            return web.Response(status=400)
        connections += 1
        await ws.prepare(request)
        if connections == 1:
            await ws.send_str(json.dumps({"type": "code_agent_events", "data": first_events}))
        else:
            await ws.send_str(json.dumps({"type": "code_agent_events", "data": all_events}))
            await ws.send_str(json.dumps({"type": "exit", "code": 0}))
        await ws.close()
        return ws

    app = web.Application()
    app.router.add_get("/", handler)
    runner = web.AppRunner(app)
    await runner.setup()
    port = _free_port()
    await web.TCPSite(runner, "127.0.0.1", port).start()
    try:
        with patch("temporalio.activity.heartbeat"):
            exit_code, _attempt, _history, _in, _out, events = await asyncio.wait_for(
                service._run_agentic_loop(
                    agent_id="a",
                    task_id="t",
                    sandbox_id="sb",
                    goal="g",
                    ws_url=f"ws://127.0.0.1:{port}/",
                    terminal=TerminalFilter(cols=80, rows=50),
                    model="rose-labs/rose-1-flash",
                    claude_token=None,
                    action_summary=[],
                    tool_call_id="tc",
                ),
                timeout=30,
            )
    finally:
        await runner.cleanup()
    assert connections == 2, connections
    assert exit_code == 0
    assert events == all_events, f"replayed events must replace, not append: {events}"


def test_sandbox_ws_servers_linger_past_the_activity_heartbeat_timeout():
    """Every code sandbox keeps its final result reachable for a crash retry.

    The retry after a dead worker starts only once the activity heartbeat
    timeout passes. If the ws-server exits sooner after the CLI finishes, the
    retry finds nothing to reattach to and reruns the task in a new sandbox.
    """
    import re

    from domains.spawn_claude_code_agent.config import CODE_ACTIVITY_HEARTBEAT_TIMEOUT_S, MAX_RUNTIME_S

    servers = sorted((Path(__file__).resolve().parents[3] / "e2b-templates").glob("*/ws-server.mjs"))
    assert len(servers) >= 2, f"expected the Claude Code and Codex ws-servers, found {servers}"
    for server in servers:
        src = server.read_text()
        match = re.search(r"const REATTACH_LINGER_MS = ([\d\s*]+);", src)
        assert match, f"{server.parent.name}/ws-server.mjs must define REATTACH_LINGER_MS"
        linger_ms = 1
        for factor in match.group(1).split("*"):
            linger_ms *= int(factor)
        assert (CODE_ACTIVITY_HEARTBEAT_TIMEOUT_S + 60) * 1000 <= linger_ms <= MAX_RUNTIME_S * 1000, (
            f"{server.parent.name} lingers {linger_ms}ms; a retry starts after {CODE_ACTIVITY_HEARTBEAT_TIMEOUT_S}s"
        )
        assert re.search(r"setTimeout\(\s*\(\)\s*=>\s*shutdown\([^)]*\),\s*REATTACH_LINGER_MS\s*\)", src), (
            f"{server.parent.name}/ws-server.mjs must shut down only after REATTACH_LINGER_MS"
        )


_DRAINED_SESSION = {
    "task_id": "cc-task-1",
    "sandbox_id": "sb-1",
    "ws_url": "wss://sb-1.e2b.app",
    "code_provider": "claude",
    "started_at": 100.0,
    "loop_started_at": 105.0,
}
_CC_COMPLETED = {
    "status": "completed",
    "success": True,
    "message": "done",
    "task_id": "cc-task-1",
    "output_files": [],
    "code_provider": "claude",
}


def _drain_yield(reason: str) -> dict:
    from domains.spawn_claude_code_agent.config import CODE_AGENT_DRAIN_YIELD_STATUS

    return {
        "status": CODE_AGENT_DRAIN_YIELD_STATUS,
        "yield_reason": reason,
        "code_session": dict(_DRAINED_SESSION),
        "task_id": "cc-task-1",
        "code_provider": "claude",
    }


class _SequencedCCWorkflow(_FakeCCWorkflow):
    """Each start_activity returns the next scripted activity result."""

    def __init__(self, *results):
        super().__init__(None)
        self._results = list(results)
        self.started: list[list] = []
        self.provider_resolutions = 0
        self.closed_sessions: list[dict] = []

    def start_activity(self, fn, args=None, **kwargs):
        assert self._results, f"unexpected activity start #{len(self.started) + 1}"
        self.started.append(list(args))
        result = self._results.pop(0)
        if isinstance(result, BaseException):
            return _FakeActivityHandle(raise_exc=result)
        return _FakeActivityHandle(result=result)

    async def execute_activity(self, fn, args=None, **kwargs):
        if fn.__name__ == "close_detached_code_session_activity":
            self.closed_sessions.append(args[1])
            return True
        self.provider_resolutions += 1
        return await super().execute_activity(fn, args=args, **kwargs)


class _HandoffCCWorkflowInstance(_FakeCCWorkflowInstance):
    def __init__(self, *, live_queue=None, can_park=True, resume=None):
        super().__init__()
        self._live_queue = live_queue
        self._can_park = can_park
        self._resume = resume
        self.parked: list[tuple[str, dict]] = []

    async def _check_generation_handoff(self):
        return self._live_queue

    def _park_pending_tool(self, tool_call_id, resume):
        if not self._can_park:
            return False
        self.parked.append((tool_call_id, resume))
        return True

    def _take_tool_resume(self, tool_call_id):
        resume, self._resume = self._resume, None
        return resume


def _cc_titles(events) -> list:
    return [getattr(event, "title", None) for event in events]


async def test_cc_manager_reattaches_after_worker_drain_on_same_queue():
    """A drained activity restarts against the same sandbox, not a new session."""
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager
    from helpers.activity_generation_drain import WORKER_SHUTDOWN

    fake = _SequencedCCWorkflow(_drain_yield(WORKER_SHUTDOWN), _CC_COMPLETED)
    restore = _patch_cc_workflow(fake)
    try:
        events = await _collect_cc_events(
            SpawnClaudeCodeAgentManager().execute_tool(_HandoffCCWorkflowInstance(), {"goal": "g"}, "tc-drain")
        )
    finally:
        restore()

    assert len(fake.started) == 2, fake.started
    assert len(fake.started[0]) == 16 and fake.started[0][15] is None, fake.started[0]
    assert fake.started[1][15] == _DRAINED_SESSION, fake.started[1][15]
    titles = _cc_titles(events)
    assert titles.count("Starting Claude Code sandbox") == 1, titles
    assert titles.count("\u2713 Task Completed") == 1, titles
    assert "Claude Code Session Cancelled" not in titles, titles


async def test_cc_manager_parks_code_session_for_generation_handoff():
    """A superseded generation parks the running session and hands off."""
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager
    from helpers.activity_generation_drain import GENERATION_SUPERSEDED
    from helpers.generation_handoff import GenerationHandoffRequested

    fake = _SequencedCCWorkflow(_drain_yield(GENERATION_SUPERSEDED))
    wf = _HandoffCCWorkflowInstance(live_queue="navi-agent-tasks-new")
    restore = _patch_cc_workflow(fake)
    events: list = []
    handoff = None
    try:
        async for event in SpawnClaudeCodeAgentManager().execute_tool(wf, {"goal": "g"}, "tc-park"):
            events.append(event)
    except GenerationHandoffRequested as exc:
        handoff = exc
    finally:
        restore()

    assert handoff is not None, f"expected a parked handoff, got {_cc_titles(events)}"
    assert handoff.parked is True and handoff.task_queue == "navi-agent-tasks-new", vars(handoff)
    assert wf.parked == [("tc-park", {"code_session": _DRAINED_SESSION})], wf.parked
    assert len(fake.started) == 1, fake.started
    assert _cc_titles(events) == ["Starting Claude Code sandbox"], _cc_titles(events)


async def test_cc_manager_finishes_on_superseded_generation_when_parking_unavailable():
    """Without parking (DAG turn) the run finishes here instead of yielding forever."""
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager
    from helpers.activity_generation_drain import GENERATION_SUPERSEDED

    fake = _SequencedCCWorkflow(_drain_yield(GENERATION_SUPERSEDED), _CC_COMPLETED)
    wf = _HandoffCCWorkflowInstance(live_queue="navi-agent-tasks-new", can_park=False)
    restore = _patch_cc_workflow(fake)
    try:
        events = await _collect_cc_events(SpawnClaudeCodeAgentManager().execute_tool(wf, {"goal": "g"}, "tc-dag"))
    finally:
        restore()

    assert len(fake.started) == 2, fake.started
    assert fake.started[1][15] == {**_DRAINED_SESSION, "generation_yield": False}, fake.started[1][15]
    assert _cc_titles(events).count("\u2713 Task Completed") == 1, _cc_titles(events)


async def test_cc_manager_parked_reentry_reattaches_without_a_new_chip():
    """The next generation re-enters the parked call and reattaches to its sandbox."""
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager

    fake = _SequencedCCWorkflow(_CC_COMPLETED)
    wf = _HandoffCCWorkflowInstance(resume={"code_session": dict(_DRAINED_SESSION)})
    wf.compute_token_provider = "gpt"
    wf.gpt_code_token = "gpt-token"
    restore = _patch_cc_workflow(fake)
    try:
        events = await _collect_cc_events(SpawnClaudeCodeAgentManager().execute_tool(wf, {"goal": "g"}, "tc-park"))
    finally:
        restore()

    assert fake.provider_resolutions == 0, "a parked session keeps the provider it started with"
    assert len(fake.started) == 1 and fake.started[0][15] == _DRAINED_SESSION, fake.started
    assert fake.started[0][9] == "claude", fake.started[0][9]
    titles = _cc_titles(events)
    assert "Starting Claude Code sandbox" not in titles, titles
    assert titles.count("\u2713 Task Completed") == 1, titles


def _cancelled_before_start():
    from temporalio.exceptions import ActivityError
    from temporalio.exceptions import CancelledError as TemporalCancelledError

    error = ActivityError(
        message="Activity cancelled",
        scheduled_event_id=1,
        started_event_id=0,
        identity="",
        activity_type="spawn_claude_code_activity",
        activity_id="2",
        retry_state=None,
    )
    error.__cause__ = TemporalCancelledError("Cancelled")
    return error


def _cancel_chip(events):
    return next(e for e in events if getattr(e, "title", None) == "Claude Code Session Cancelled")


async def test_cc_manager_pause_after_drain_closes_the_detached_sandbox():
    """Pausing while the run is detached for a deploy closes its sandbox.

    No activity is attached between the drain-yield and the reattach, so no
    activity cancel can close it: the sandbox kept running (and billing) until
    the E2B timeout, and the chip ended without its task_id.
    """
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager
    from helpers.activity_generation_drain import WORKER_SHUTDOWN

    fake = _SequencedCCWorkflow(_drain_yield(WORKER_SHUTDOWN))
    wf = _HandoffCCWorkflowInstance()
    wf.is_paused = True
    restore = _patch_cc_workflow(fake)
    try:
        events = await _collect_cc_events(SpawnClaudeCodeAgentManager().execute_tool(wf, {"goal": "g"}, "tc-pause"))
    finally:
        restore()

    assert len(fake.started) == 1, f"a paused run must not reattach, started={len(fake.started)}"
    assert fake.closed_sessions == [_DRAINED_SESSION], fake.closed_sessions
    chip = _cancel_chip(events)
    assert chip.metadata["task_id"] == "cc-task-1" and chip.metadata["action_type"] == "task_complete", chip.metadata
    assert "\u2713 Task Completed" not in _cc_titles(events), _cc_titles(events)


async def test_cc_manager_cancel_before_reattach_closes_the_detached_sandbox():
    """A pause that cancels a reattaching activity before it runs still closes the sandbox."""
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager

    fake = _SequencedCCWorkflow(_cancelled_before_start())
    wf = _HandoffCCWorkflowInstance(resume={"code_session": dict(_DRAINED_SESSION)})
    wf.is_paused = True
    restore = _patch_cc_workflow(fake)
    try:
        events = await _collect_cc_events(SpawnClaudeCodeAgentManager().execute_tool(wf, {"goal": "g"}, "tc-park"))
    finally:
        restore()

    assert fake.closed_sessions == [_DRAINED_SESSION], fake.closed_sessions
    assert _cancel_chip(events).metadata["task_id"] == "cc-task-1", _cancel_chip(events).metadata


async def test_cc_manager_leaves_cleanup_to_an_activity_that_held_the_sandbox():
    """An activity that was attached closes the sandbox itself; the workflow must not close it again."""
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager

    cancelled = {
        "status": "cancelled",
        "task_id": "cc-task-1",
        "message": "Claude Code agent cancelled by user",
        "code_provider": "claude",
    }
    fake = _SequencedCCWorkflow(cancelled)
    wf = _HandoffCCWorkflowInstance(resume={"code_session": dict(_DRAINED_SESSION)})
    wf.is_paused = True
    restore = _patch_cc_workflow(fake)
    try:
        events = await _collect_cc_events(SpawnClaudeCodeAgentManager().execute_tool(wf, {"goal": "g"}, "tc-park"))
    finally:
        restore()

    assert fake.closed_sessions == [], fake.closed_sessions
    assert _cancel_chip(events).metadata["task_id"] == "cc-task-1", _cancel_chip(events).metadata


def _timed_out_on_last_attempt(*heartbeat_details):
    from temporalio.exceptions import ActivityError
    from temporalio.exceptions import TimeoutError as TemporalTimeoutError
    from temporalio.exceptions import TimeoutType

    error = ActivityError(
        message="Activity task timed out",
        scheduled_event_id=1,
        started_event_id=2,
        identity="",
        activity_type="spawn_claude_code_activity",
        activity_id="2",
        retry_state=None,
    )
    error.__cause__ = TemporalTimeoutError(
        "activity Heartbeat timeout", type=TimeoutType.HEARTBEAT, last_heartbeat_details=heartbeat_details
    )
    return error


async def test_cc_manager_closes_the_sandbox_when_the_last_attempt_times_out():
    """Exhausted retries after a dead worker must not leave the sandbox running.

    The last attempt died with its worker, so it never ran its own cleanup,
    and no attempt will reattach. Its last heartbeat names the sandbox.
    """
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager

    beat_session = {**_DRAINED_SESSION, "task_id": "cc-task-2", "sandbox_id": "sb-2", "ws_url": "wss://sb-2.e2b.app"}
    cases = [
        ("heartbeat names the sandbox", (None,), ("Processing", {"code_session": beat_session}), beat_session),
        (
            "no session heartbeat; the scheduled one is still open",
            ({"code_session": dict(_DRAINED_SESSION)},),
            ("Verifying",),
            _DRAINED_SESSION,
        ),
        ("never attached", (None,), (), None),
    ]
    for label, resume, beat, expected in cases:
        fake = _SequencedCCWorkflow(_timed_out_on_last_attempt(*beat))
        wf = _HandoffCCWorkflowInstance(resume=resume[0])
        restore = _patch_cc_workflow(fake)
        try:
            events = await _collect_cc_events(SpawnClaudeCodeAgentManager().execute_tool(wf, {"goal": "g"}, "tc-to"))
        finally:
            restore()
        assert fake.closed_sessions == ([expected] if expected else []), (label, fake.closed_sessions)
        assert "Code session failed" in _cc_titles(events), (label, _cc_titles(events))


if __name__ == "__main__":
    asyncio.run(run_all_tests())
