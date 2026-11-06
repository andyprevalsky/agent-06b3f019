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
    setup_mock_fn,
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


async def test_session_create_outwaits_a_slow_backend_and_heartbeats():
    """A create the backend needs minutes for completes in one attempt (RCA
    2026-11-06-code-spawn-create-retry-duplicated-sessions): its 60 s read timed
    out at 150 s, the activity retried, and the retries started 3 tasks.

    The client read outlasts the backend's own create budget (the shared E2B
    create slot waits up to 15 min, plus the start itself) and the activity
    heartbeats while it waits, so the heartbeat timeout never starts a second
    attempt beside it.
    """
    import httpx

    import domains.spawn_claude_code_agent.repo as repo

    seen: dict = {}

    async def slow_backend(request):
        seen["timeout"] = request.extensions.get("timeout")
        await asyncio.sleep(0.35)
        return httpx.Response(
            200,
            json={"success": True, "task_id": "task-slow", "sandbox_id": "sb-slow", "ws_url": "wss://x"},
        )

    setup_mock_fn(slow_backend)
    beats: list = []
    try:
        with (
            patch.object(repo, "CODE_SESSION_CREATE_HEARTBEAT_S", 0.05),
            patch.object(repo, "safe_heartbeat", lambda message, *details: beats.append(message)),
        ):
            data = await repo.create_e2b_session(agent_id="agent-slow", goal="status", user_id="u-1")
    finally:
        teardown_mock()
    assert data["task_id"] == "task-slow"
    read_timeout = (seen["timeout"] or {}).get("read")
    # Backend bound: 15 min create-slot wait + the 150 s start observed in prod.
    assert read_timeout is not None and read_timeout >= 15 * 60 + 150, seen["timeout"]
    assert len(beats) >= 3, beats
    assert set(beats) == {"Starting the code-agent sandbox"}, beats


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


# ── Pure helpers: check_terminal_fatal_error (structured signals only) ──


def test_terminal_fatal_ignores_banner_text():
    """No credential classification from terminal text: the Claude banners (and an
    agent printing them) are not fatal; structured events pause the session instead."""
    from domains.spawn_claude_code_agent.service import check_terminal_fatal_error

    for provider in ("claude", "codex"):
        assert check_terminal_fatal_error(code_provider=provider, exit_code=1, credential_feedback=[]) is None
        assert check_terminal_fatal_error(code_provider=provider, exit_code=1) is None


def test_codex_structured_exhaustion_is_terminal_only_after_failed_fallback():
    """Structured Codex exhaustion may recover through the funded-key fallback."""
    from domains.spawn_claude_code_agent.service import check_terminal_fatal_error

    feedback = [{"source": "initial", "reason": "Quota exceeded. Check your plan and billing details."}]
    assert check_terminal_fatal_error(code_provider="codex", exit_code=0, credential_feedback=feedback) is None
    msg = check_terminal_fatal_error(code_provider="codex", exit_code=1, credential_feedback=feedback)
    assert msg is not None and "out of quota" in msg and "runtime fallback" in msg


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


# ── handoff JSON contract (R3b, Andy 2026-10-24) ─────────────────────

# The output_schema the parent declared for claude-code-agent 31f51d25
# (descend-full69 j0026), verbatim.
COLLATZ_OUTPUT_SCHEMA = {
    "fields": [
        {"name": "source_code", "type": "str", "required": True, "nullable": False, "properties": [],
         "description": "Full Python source code of the program"},
        {"name": "stdout", "type": "str", "required": True, "nullable": False, "properties": [],
         "description": "Complete verbatim stdout of running the program"},
        {"name": "collatz_sequence", "type": "list[int]", "required": True, "nullable": False, "properties": [],
         "description": "Every number in the sequence from 27 to 1 in order"},
        {"name": "total_steps", "type": "int", "required": True, "nullable": False, "properties": [],
         "description": "Total steps from 27 to 1"},
    ]
}


def _collatz_27() -> list[int]:
    seq = [27]
    while seq[-1] != 1:
        n = seq[-1]
        seq.append(n // 2 if n % 2 == 0 else 3 * n + 1)
    return seq


def _collatz_stream_events() -> list[dict]:
    """Replay the 31f51d25 SDK stream shape: cumulative partial snapshots, then the final message."""
    seq = _collatz_27()
    final = (
        "Program runs correctly, producing 112 numbers and 111 steps as expected.\n\n"
        "**Verbatim stdout:**\n```\n" + ",".join(map(str, seq)) + "\nSteps: 111\n```\n\n"
        "**Sequence as a list of integers** (112 numbers):\n```python\n" + repr(seq) + "\n```"
    )
    step = max(1, len(final) // 125)
    partials = [
        {"type": "agent_message", "item_id": "msg_1:0", "seq": i, "text": final[:end], "delta": "x", "partial": True}
        for i, end in enumerate(range(step, len(final), step))
    ]
    return [
        {"type": "tool_use", "name": "Bash", "input": {"command": "python3 collatz.py"}},
        *partials,
        {"type": "agent_message", "item_id": "msg_1:0", "raw_type": "assistant", "text": final},
        {"type": "result", "status": "completed"},
    ]


def _collatz_handoff() -> dict:
    seq = _collatz_27()
    return {
        "source_code": "n = 27\n...",
        "stdout": ",".join(map(str, seq)) + "\nSteps: 111\n",
        "collatz_sequence": seq,
        "total_steps": 111,
    }


async def _run_verifier_with_handoff(handoff, *, events=None, output_schema=None, output_files=None):
    from domains.spawn_claude_code_agent import service
    from utils.terminal_filter import TerminalFilter

    terminal = TerminalFilter(cols=200, rows=50)
    terminal.feed("[Claude] Program runs correctly, producing 112 numbers and 111 steps as expected.")
    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    with (
        patch("loop.activity_helper.call_temporal_activity_from_activity", side_effect=AssertionError("no verifier")),
        patch("temporalio.activity.heartbeat"),
    ):
        return await service._run_verifier(
            agent_id="a",
            task_id="t",
            goal="g",
            model="rose-labs/rose-1-flash",
            terminal=terminal,
            action_summary=["ran collatz.py"],
            output_schema=output_schema or COLLATZ_OUTPUT_SCHEMA,
            claude_token=None,
            exit_code=0,
            code_provider="claude",
            output_files=output_files or [],
            code_events=_collatz_stream_events() if events is None else events,
            handoff=handoff,
        )


def test_handoff_json_schema_is_fixed_by_output_schema():
    """The declared output_schema fixes the handoff JSON structure; file fields are sandbox paths."""
    from domains.spawn_claude_code_agent.service import CODE_AGENT_HANDOFF_PATH, handoff_json_schema, handoff_task_text

    schema = handoff_json_schema(
        {
            "fields": [
                *COLLATZ_OUTPUT_SCHEMA["fields"],
                {"name": "report", "type": "file_pointer", "required": False},
            ]
        }
    )
    assert schema["type"] == "object" and schema["additionalProperties"] is False
    assert schema["required"] == ["source_code", "stdout", "collatz_sequence", "total_steps"]
    assert schema["properties"]["collatz_sequence"] == {
        "type": "array",
        "items": {"type": "integer"},
        "description": "Every number in the sequence from 27 to 1 in order",
    }
    assert schema["properties"]["report"]["properties"]["path"]["type"] == "string"

    text = handoff_task_text("Compute Collatz from 27.", COLLATZ_OUTPUT_SCHEMA)
    assert text.startswith("Compute Collatz from 27.")
    assert CODE_AGENT_HANDOFF_PATH == "/home/user/.rose/handoff.json"
    assert CODE_AGENT_HANDOFF_PATH in text
    assert json.dumps(handoff_json_schema(COLLATZ_OUTPUT_SCHEMA), sort_keys=True) in text


def test_handoff_json_schema_carries_declared_field_descriptions():
    """The code agent must see what each field means, not just its type.

    R3c: a real Claude Code CLI filled an undescribed ``sentinel`` field with its
    reply token instead of the file content; the worker schema dropped every
    declared description (31f51d25's "Complete verbatim stdout ...").
    """
    from domains.spawn_claude_code_agent.service import handoff_json_schema

    nested = {
        "name": "receipt",
        "type": "object",
        "description": "Proof the task ran",
        "properties": [{"name": "exit_code", "type": "int", "description": "Process exit code"}],
    }
    schema = handoff_json_schema({"fields": [*COLLATZ_OUTPUT_SCHEMA["fields"], nested]})
    for field in COLLATZ_OUTPUT_SCHEMA["fields"]:
        assert schema["properties"][field["name"]]["description"] == field["description"], field["name"]
    assert schema["properties"]["receipt"]["description"] == "Proof the task ran"
    assert schema["properties"]["receipt"]["properties"]["exit_code"]["description"] == "Process exit code"


async def test_handoff_valid_json_is_the_tool_result():
    """A schema-valid handoff is returned as the structured response and the tool result; no event log."""
    handoff = _collatz_handoff()
    score, reasoning, struct, _i, _o = await _run_verifier_with_handoff(
        {"status": "present", "content": json.dumps(handoff)}
    )
    assert struct == handoff, struct
    assert score == 1.0, reasoning
    assert json.dumps(handoff, ensure_ascii=False, indent=2) in reasoning, reasoning
    assert "code_agent_events" not in reasoning and "Terminal output" not in reasoning, reasoning


async def test_handoff_missing_or_invalid_is_reported_truthfully():
    """No handoff, unparseable JSON or a schema violation is stated plainly; nothing is inferred."""
    cases = [
        ({"status": "missing"}, "no handoff file"),
        ({"status": "present", "content": "{not json"}, "not valid json"),
        ({"status": "present", "content": json.dumps({**_collatz_handoff(), "total_steps": "111"})}, "total_steps"),
        (None, "no handoff file"),
    ]
    for handoff, expected in cases:
        score, reasoning, struct, _i, _o = await _run_verifier_with_handoff(handoff)
        assert struct is None, (handoff, struct)
        assert score < 1.0, (handoff, score)
        assert "/home/user/.rose/handoff.json" in reasoning, reasoning
        assert expected in reasoning.lower(), (expected, reasoning)
        assert "code_agent_events" not in reasoning and "Terminal output" not in reasoning, reasoning


async def test_handoff_replay_31f51d25_result_is_bounded():
    """Replay of j0026/31f51d25: the 125-snapshot stream used to make a 180k-char result."""
    events = _collatz_stream_events()
    raw = json.dumps(events, indent=2)
    assert len(raw) > 80_000, len(raw)  # the replay reproduces the quadratic stream
    for handoff in ({"status": "present", "content": json.dumps(_collatz_handoff())}, {"status": "missing"}):
        _score, reasoning, _s, _i, _o = await _run_verifier_with_handoff(handoff, events=events)
        assert len(reasoning) < 5_000, len(reasoning)


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


async def test_repo_close_e2b_session_non_200_is_unconfirmed():
    """An unconfirmed close cannot masquerade as an empty completed result."""
    setup_mock({
        "/api/claude-code-session/close": {"status": 500, "json": {"error": "x"}},
    })
    from domains.spawn_claude_code_agent.repo import close_e2b_session

    from temporalio.exceptions import ApplicationError

    try:
        await close_e2b_session(task_id="t")
    except ApplicationError as error:
        assert error.type == "CodeSessionCloseUnconfirmed"
        assert error.non_retryable is True, "generic activity retry would rerun the CLI"
    else:
        raise AssertionError("unconfirmed close returned as a completed result")


async def test_close_timeout_reconciles_same_task_before_activity_completion():
    """Replay the production ReadTimeout while the backend still holds the old lease."""
    import httpx
    from domains.spawn_claude_code_agent import repo, service

    backend_done = asyncio.Event()
    request_lost = asyncio.Event()
    close_requests = []
    beats = []
    handoff = _collatz_handoff()
    receipt = {"output_files": [], "handoff": {"status": "present", "content": json.dumps(handoff)},
               "code_session": {"code_session_id": "session-close", "state": "PAUSED"}}

    async def backend(request):
        if request.url.path.endswith("/close"):
            close_requests.append(json.loads(request.content))
            assert request.extensions["timeout"]["read"] == 180.0
            if len(close_requests) == 1:
                request_lost.set()
                raise httpx.ReadTimeout("production close response lost while lease held", request=request)
            await backend_done.wait()
            return httpx.Response(200, json=receipt)
        return httpx.Response(200, json={"saved": True})

    setup_mock_fn(backend)
    create = AsyncMock(return_value={"task_id": "task-close", "sandbox_id": "sb-close",
                                    "ws_url": "wss://fixture", "uploaded_files": []})
    loop = AsyncMock(return_value=(0, True, [], 0, 0, _collatz_stream_events()))
    activity_task = None
    try:
        with (
            patch.dict("os.environ", {"ROSE_ENABLE_CODE_AGENT_VERIFIER": ""}),
            patch.object(service, "SandboxLogCollector", lambda *a, **kw: AsyncMock()),
            patch.object(service, "create_e2b_session", create),
            patch.object(service, "_run_agentic_loop", loop),
            patch.object(service, "persist_terminal_output", AsyncMock(return_value=None)),
            patch.object(service, "_resolve_claude_token_for_activity", AsyncMock(return_value="fixture")),
            patch("helpers.model_pricing.get_model_pricing_with_fallback",
                  AsyncMock(return_value={"input_cents_per_1k": 0.1, "output_cents_per_1k": 0.2})),
            patch("temporalio.activity.heartbeat"),
            patch.object(repo, "CODE_SESSION_CREATE_HEARTBEAT_S", 0.01),
            patch.object(repo, "safe_heartbeat", lambda *args: beats.append(args)),
        ):
            activity_task = asyncio.create_task(service.spawn_claude_code_activity(
                user_id="u", agent_id="a", goal="Compute Collatz from 27.",
                tool_call_id="tc-close", output_schema=COLLATZ_OUTPUT_SCHEMA, model="rose-labs/rose-1-flash"))
            await asyncio.wait_for(request_lost.wait(), 5)
            await asyncio.sleep(0.05)
            assert not activity_task.done(), "activity completed before the backend released its lease"
            backend_done.set()
            result = await asyncio.wait_for(activity_task, 5)
            assert result["success"] is True, result["message"]
            assert result["structured_response"] == handoff
            assert create.await_count == 1 and loop.await_count == 1, "close retry must not re-enter the CLI"
            assert len(close_requests) == 2 and close_requests[0] == close_requests[1]
            assert beats, "a closing activity keeps heartbeating while its backend finishes"
    finally:
        backend_done.set()
        if activity_task is not None:
            await asyncio.gather(activity_task, return_exceptions=True)
        teardown_mock()


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


async def test_run_verifier_off_by_default():
    """With no opt-in env, the LLM verifier never runs for claude or codex.

    W2 (descend-full69-20261023, Andy): the verifier is off globally, so prod,
    local and cloud benchmarks share this path; only
    ROSE_ENABLE_CODE_AGENT_VERIFIER opts back in. A legacy
    ROSE_DISABLE_CODE_AGENT_VERIFIER=0 does not re-enable it.

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
        # A legacy opt-out value must not turn the verifier back on.
        patch.dict("os.environ", {"ROSE_DISABLE_CODE_AGENT_VERIFIER": "0"}),
        patch("loop.activity_helper.call_temporal_activity_from_activity", side_effect=fake_activity),
        patch("temporalio.activity.heartbeat"),
    ):
        for provider in ("claude", "codex"):
            # A success exit cannot satisfy an unmaterialized primitive schema,
            # but nothing checked that field, so it is unverified, not missing.
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
            assert "verifier off" in reasoning.lower(), reasoning
            assert "not verified: summary." in reasoning, reasoning
            assert "incomplete" not in reasoning.lower(), reasoning
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
            assert "verifier off" in reasoning_ok.lower(), reasoning_ok
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
    assert "verifier off" in reasoning.lower(), reasoning
    assert "Total steps: 111" in reasoning, reasoning
    assert "code_agent_events" in reasoning, reasoning
    assert struct == {
        "stdout": stdout,
        "collatz_sequence": [int(value) for value in stdout.splitlines()[:-1]],
        "total_steps": 111,
        "python_script": {"path": "/home/user/output/collatz_27.py"},
    }
    assert itok == 0 and otok == 0


async def test_disabled_verifier_reports_successful_session_truthfully():
    """A completed session is never labelled FAILED for fields nobody checked.

    Repro for /descend descend-full69-20261023 claude-code-agent (all five
    copies, e.g. agent d5def233 task c07d4462): Claude Code exited 0, wrote
    /home/user/output/collatz.py and returned the whole program and stdout,
    but the parent read "**Status**: ❌ FAILED ... Required output artifacts
    were not completely extracted - incomplete." The schema's required
    ``status`` string has no mechanical extractor while the LLM verifier is
    disabled, so it was unverified, not missing. A session whose required
    file was not extracted, or whose process failed, still reports FAILED.
    """
    from domains.spawn_claude_code_agent import service

    result_text = (
        "**Command:** `python3 collatz.py`\n**Script path:** `/home/user/output/collatz.py`\n"
        "**Step count:** 111\nOutput file for the user: `/home/user/output/collatz.py`"
    )
    retry_schema = {
        "fields": [
            {"name": "status", "type": "str", "required": True, "nullable": False},
            {"name": "stdout", "type": "str", "required": False, "nullable": False},
            {"name": "program_source", "type": "str", "required": False, "nullable": False},
            {"name": "program_path", "type": "str", "required": False, "nullable": False},
            {"name": "run_command", "type": "str", "required": False, "nullable": False},
            {"name": "sequence", "type": "list[int]", "required": False, "nullable": False},
            {"name": "total_steps", "type": "int", "required": False, "nullable": False},
        ]
    }
    collatz_file = {"id": "f1", "original_filename": "collatz.py", "mime_type": "text/x-python", "size_bytes": 300}

    async def run(output_schema, exit_code, output_files):
        events = [
            {"version": 1, "provider": "claude", "type": "tool_use", "tool": "Write"},
            {"version": 1, "provider": "claude", "type": "result", "status": "completed", "text": result_text},
        ]

        async def fake_loop(**_kwargs):
            return (exit_code, False, [], 0, 0, events)

        async def fake_close(**_kwargs):
            return {"output_files": output_files, "usage": None}

        collector = AsyncMock()
        setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
        with (
            patch.object(service, "SandboxLogCollector", lambda *a, **kw: collector),
            patch.object(
                service,
                "create_e2b_session",
                AsyncMock(return_value={"task_id": "c07d4462", "sandbox_id": "sb", "ws_url": "wss://x"}),
            ),
            patch.object(service, "_run_agentic_loop", side_effect=fake_loop),
            patch.object(service, "persist_terminal_output", AsyncMock(return_value=None)),
            patch.object(service, "close_e2b_session", side_effect=fake_close),
            patch.object(service, "_resolve_claude_token_for_activity", AsyncMock(return_value="tok")),
            patch(
                "helpers.model_pricing.get_model_pricing_with_fallback",
                AsyncMock(return_value={"input_cents_per_1k": 0.1, "output_cents_per_1k": 0.2}),
            ),
            patch(
                "loop.activity_helper.call_temporal_activity_from_activity",
                AsyncMock(side_effect=AssertionError("disabled verifier must not call the LLM")),
            ),
            patch("temporalio.activity.heartbeat"),
        ):
            result = await service.spawn_claude_code_activity(
                user_id="u",
                agent_id="d5def233",
                goal="Write and run a Collatz program from 27",
                tool_call_id="tc",
                output_schema=output_schema,
                model="rose-labs/rose-1-flash",
            )
        teardown_mock()
        return result

    completed = await run(retry_schema, 0, [collatz_file])
    message = completed["message"]
    assert "❌ FAILED" not in message, message
    assert "not completely extracted" not in message and "incomplete" not in message.lower(), message
    assert "**Status**: ⚠️ UNVERIFIED" in message, message
    assert "not verified: status." in message, message
    assert completed["success"] is False

    missing_file = await run(
        {"fields": [{"name": "script", "type": "file_pointer", "required": True}]}, 0, []
    )
    assert "**Status**: ❌ FAILED" in missing_file["message"], missing_file["message"]
    assert "incomplete" in missing_file["message"].lower(), missing_file["message"]

    crashed = await run(retry_schema, 1, [collatz_file])
    assert "**Status**: ❌ FAILED" in crashed["message"], crashed["message"]
    assert "UNVERIFIED" not in crashed["message"], crashed["message"]


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


_PARTIAL_VERDICT_FIXTURE = (
    Path(__file__).parent / "fixtures" / "spawn_claude_code_agent" / "partial-verdict-missing-required-field.json"
)


async def test_run_verifier_partial_verdict_missing_required_field_reaches_parent():
    """A recorded partial verdict reaches the parent instead of a judge parse error.

    Replays agent 9698df4f's first Codex game run: the verifier scored 0.5,
    returned ``game_file`` and ``view_name``, and explained that the required
    ``description`` was not grounded. Every recorded call was rejected with
    ``output.description: Field required`` until the activity reported
    ``Progress check failed``. The real ``check_progress`` parser runs here;
    only the Rose stream is replayed from the recorded verifier output.
    """
    from domains.spawn_claude_code_agent import service
    from providers.rose.schema import build_openai_response_format
    from providers.rose.types import StreamChunk
    from utils.terminal_filter import TerminalFilter

    fixture = json.loads(_PARTIAL_VERDICT_FIXTURE.read_text())
    recorded = fixture["verifier_responses"]
    assert {response["actual_model"] for response in recorded} == {"gpt-6-sol-gpt"}
    first_verdict = json.loads(recorded[0]["content"])
    assert first_verdict["score"] == 0.5
    assert "description" not in first_verdict["output"]

    verifier_requests: list[dict] = []

    class RecordedVerifierRose:
        async def complete(self, **kwargs):
            response = recorded[min(len(verifier_requests), len(recorded) - 1)]
            verifier_requests.append(kwargs)
            yield StreamChunk(
                kind="metadata",
                data={"actual_model": response["actual_model"], "pool_name": response["pool_name"]},
            )
            yield StreamChunk(kind="content", data={"text": response["content"]})
            yield StreamChunk(
                kind="usage",
                data={"prompt_tokens": 5841, "completion_tokens": 571, "total_tokens": 6412},
            )
            yield StreamChunk(kind="done", data={"finish_reason": response["finish_reason"]})

    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    terminal = TerminalFilter(cols=200, rows=50)
    try:
        with patch("temporalio.activity.heartbeat"), patch("helpers.llm.RoseClient", RecordedVerifierRose):
            score, reasoning, struct, _itok, _otok = await service._run_verifier(
                agent_id="9698df4f-0492-415d-962d-a0dbb3b0bf92",
                task_id="6c26a13d-fac3-4743-b74b-a659a29c6d42",
                goal=fixture["goal"],
                model="rose-labs/rose-1-ultra",
                terminal=terminal,
                action_summary=["Agentic loop finished: 0 interactions", "Extracted 1 output files"],
                output_schema=fixture["output_schema"],
                claude_token=None,
                code_provider=fixture["code_provider"],
                exit_code=fixture["exit_code"],
                code_events=fixture["code_events"],
                output_files=fixture["output_files"],
            )
    finally:
        teardown_mock()

    assert not reasoning.startswith("Progress check failed"), reasoning
    assert reasoning == first_verdict["reasoning"]
    assert score == 0.5
    assert struct == {
        "game_file": {"path": "/home/user/output/neon-orbit-run.html"},
        "view_name": "neon-orbit-run",
    }
    # A well-formed verdict is consumed once; it is not regenerated as malformed.
    assert len(verifier_requests) == 1
    # The provider-facing contract is unchanged: completion still requires
    # both required fields, and the optional view keeps strict mode off.
    request_format = build_openai_response_format(verifier_requests[0]["response_model"])["json_schema"]
    assert request_format["strict"] is False
    assert request_format["schema"]["properties"]["output"]["required"] == ["game_file", "description"]


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


def _loop_kwargs(summary, **extra):
    from utils.terminal_filter import TerminalFilter

    return {
        "agent_id": "a",
        "task_id": "t",
        "sandbox_id": "sb",
        "goal": "g",
        "ws_url": "wss://x",
        "terminal": TerminalFilter(cols=80, rows=50),
        "model": "rose-labs/rose-1-flash",
        "claude_token": None,
        "action_summary": summary,
        "tool_call_id": "tc",
        **extra,
    }


async def test_run_agentic_loop_idle_cli_is_paused_not_failed():
    """A CLI with nothing in flight that goes quiet is paused (resumable), not killed.

    C11: the old SDK_IDLE_TIMEOUT_S=180 broke the loop and the run was judged
    incomplete. Now the loop ends with loop_outcome["idle_paused"] so the
    activity pauses the session and reports status "paused".
    """
    import asyncio as aio

    from domains.spawn_claude_code_agent import service

    class HangAfterOutput(_FakeWsClient):
        async def listen(self):
            await self.on_output("partial work", True)
            await aio.Event().wait()

    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    summary: list[str] = []
    outcome: dict = {}
    with (
        patch.object(service, "ClaudeCodeWsClient", HangAfterOutput),
        patch.object(service, "CODE_SESSION_IDLE_PAUSE_S", 0.05),
        patch.object(service, "SILENCE_TIMEOUT_S", 0.01),
        patch("temporalio.activity.heartbeat"),
    ):
        t0 = aio.get_event_loop().time()
        exit_code, attempt, *_ = await service._run_agentic_loop(**_loop_kwargs(summary, loop_outcome=outcome))
        elapsed = aio.get_event_loop().time() - t0

    assert exit_code == -1 and attempt is False
    assert elapsed < 5.0, f"idle pause should be prompt, took {elapsed:.2f}s"
    assert outcome.get("idle_paused") is True, outcome
    assert any("pausing it (resumable)" in line for line in summary), summary
    assert not any("timeout" in line.lower() for line in summary), summary


async def _assert_session_stays_attached(events: list, *, hold_s: float, end_with_exit: bool = True):
    """Drive the loop with `events`, stay silent for hold_s (past the idle window), then exit."""
    import asyncio as aio

    from domains.spawn_claude_code_agent import service

    class Scripted(_FakeWsClient):
        async def listen(self):
            await self.on_output("working", True)
            for event in events:
                await self.on_event({"version": 1, "provider": "claude", **event})
            await aio.sleep(hold_s)
            if end_with_exit:
                await self.on_exit(0)
            await aio.Event().wait()

    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    summary: list[str] = []
    outcome: dict = {}
    with (
        patch.object(service, "ClaudeCodeWsClient", Scripted),
        patch.object(service, "CODE_SESSION_IDLE_PAUSE_S", 0.1),
        patch.object(service, "SILENCE_TIMEOUT_S", 0.01),
        patch("temporalio.activity.heartbeat"),
    ):
        t0 = aio.get_event_loop().time()
        exit_code, attempt, _history, _i, _o, seen = await service._run_agentic_loop(
            **_loop_kwargs(summary, loop_outcome=outcome)
        )
        elapsed = aio.get_event_loop().time() - t0
    return exit_code, elapsed, outcome, summary, seen


async def test_run_agentic_loop_in_flight_tool_has_no_idle_limit():
    """A long Bash (tool_use with no tool_result) is work: never paused or killed.

    Repro: cuda-kernel k=3 r22 CC#4 was idle-killed mid-Bash. With no runtime
    limit the loop waits past 10x the idle window and returns on the CLI's exit.
    """
    exit_code, elapsed, outcome, summary, seen = await _assert_session_stays_attached(
        [{"type": "tool_use", "name": "Bash"}], hold_s=1.0
    )
    assert exit_code == 0, (exit_code, summary)
    assert elapsed >= 0.9, f"in-flight Bash must hold the session past the idle window, took {elapsed:.2f}s"
    assert "idle_paused" not in outcome, outcome
    assert any(e.get("name") == "Bash" for e in seen), seen


async def test_run_agentic_loop_nameless_in_flight_tool_has_no_idle_limit():
    """tool_use without a name still counts as in flight (CodeRabbit #1260 symmetry)."""
    exit_code, elapsed, outcome, summary, _seen = await _assert_session_stays_attached(
        [{"type": "tool_use"}], hold_s=0.8
    )
    assert exit_code == 0 and elapsed >= 0.7 and "idle_paused" not in outcome, (exit_code, elapsed, outcome)


async def test_run_agentic_loop_finished_tool_then_quiet_cli_is_paused():
    """After tool_result with nothing in flight, a quiet CLI pauses (resumable)."""
    exit_code, elapsed, outcome, summary, _seen = await _assert_session_stays_attached(
        [{"type": "tool_use", "name": "Bash"}, {"type": "tool_result", "name": "Bash"}],
        hold_s=5.0,
        end_with_exit=False,
    )
    assert exit_code == -1 and outcome.get("idle_paused") is True, (exit_code, outcome, summary)
    assert elapsed < 3.0, f"idle pause should fire on the idle window, took {elapsed:.2f}s"


async def test_run_agentic_loop_sdk_result_zombie_ends_on_exit_grace():
    """After SDK result, a zombie CLI that keeps tooling ends on the exit grace (r31 a2).

    Not a failure: the run is verified on its result and the session pauses.
    """
    import asyncio as aio

    from domains.spawn_claude_code_agent import service

    class HangAfterResultThenBash(_FakeWsClient):
        async def listen(self):
            await self.on_output("working", True)
            for event in (
                {"type": "tool_use", "name": "Bash"},
                {"type": "tool_result", "name": "Bash"},
                {"type": "result", "status": "completed"},
                {"type": "tool_use", "name": "Bash"},
            ):
                await self.on_event({"version": 1, "provider": "claude", **event})
            await aio.Event().wait()

    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    summary: list[str] = []
    outcome: dict = {}
    with (
        patch.object(service, "ClaudeCodeWsClient", HangAfterResultThenBash),
        patch.object(service, "CODE_SESSION_IDLE_PAUSE_S", 0.05),
        patch.object(service, "SDK_POST_RESULT_EXIT_GRACE_S", 0.2),
        patch.object(service, "SILENCE_TIMEOUT_S", 0.01),
        patch("temporalio.activity.heartbeat"),
    ):
        t0 = aio.get_event_loop().time()
        exit_code, attempt, _h, _i, _o, events = await service._run_agentic_loop(
            **_loop_kwargs(summary, loop_outcome=outcome)
        )
        elapsed = aio.get_event_loop().time() - t0

    assert exit_code == -1 and attempt is False
    assert elapsed < 2.0, f"post-result zombie must end on the grace, took {elapsed:.2f}s ({summary})"
    assert any("Post-result exit grace" in line for line in summary), summary
    assert "idle_paused" not in outcome, "a declared result is verified, not paused"
    assert any(e.get("type") == "result" for e in events), events


async def test_run_agentic_loop_post_result_exit_grace_breaks():
    """Stdout after SDK result that keeps refreshing silence must still hit exit grace."""
    import asyncio as aio

    from domains.spawn_claude_code_agent import service

    class ChattyAfterResult(_FakeWsClient):
        async def listen(self):
            await self.on_output("working", True)
            await self.on_event({"version": 1, "provider": "claude", "type": "result", "status": "completed"})
            while True:
                await aio.sleep(0.02)
                await self.on_output("chip\n", False)

    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    summary: list[str] = []
    with (
        patch.object(service, "ClaudeCodeWsClient", ChattyAfterResult),
        patch.object(service, "SDK_POST_RESULT_EXIT_GRACE_S", 0.15),
        patch.object(service, "SILENCE_TIMEOUT_S", 0.01),
        # The elapsed bound measures the grace, not the transcript write: a
        # loaded host took 3s to open that HTTP client (run 3 of 5, 2026-10-20).
        patch.object(service, "save_code_transcript_batch", AsyncMock(return_value=True)),
        patch("temporalio.activity.heartbeat"),
    ):
        t0 = aio.get_event_loop().time()
        exit_code, attempt, *_ = await service._run_agentic_loop(**_loop_kwargs(summary))
        elapsed = aio.get_event_loop().time() - t0

    assert exit_code == -1 and attempt is False
    assert elapsed < 1.0, f"grace should end chatty post-result session quickly, took {elapsed:.2f}s"
    assert any("Post-result exit grace" in line for line in summary), summary


async def test_run_agentic_loop_keepalive_extends_attached_sandbox():
    """While attached, the loop keeps the sandbox's idle window open (no auto-pause)."""
    import asyncio as aio

    from domains.spawn_claude_code_agent import service

    class Working(_FakeWsClient):
        async def listen(self):
            await self.on_output("working", True)
            await self.on_event({"version": 1, "provider": "claude", "type": "tool_use", "name": "Bash"})
            await aio.sleep(0.6)
            await self.on_exit(0)

    keepalives: list = []

    async def record_keepalive(task_id, code_provider="claude"):
        keepalives.append((task_id, code_provider))
        return True

    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    with (
        patch.object(service, "ClaudeCodeWsClient", Working),
        patch.object(service, "CODE_SESSION_KEEPALIVE_INTERVAL_S", 0.1),
        patch.object(service, "keepalive_e2b_session", side_effect=record_keepalive),
        patch.object(service, "SILENCE_TIMEOUT_S", 0.01),
        patch("temporalio.activity.heartbeat"),
    ):
        exit_code, *_ = await service._run_agentic_loop(**_loop_kwargs([]))
    assert exit_code == 0
    assert len(keepalives) >= 3 and all(call == ("t", "claude") for call in keepalives), keepalives


def test_log_code_agent_event_promotes_codex_demo_cache_request():
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


async def test_spawn_activity_returns_close_handoff_as_result():
    """End to end: the task carries the handoff schema and the close response's handoff is the result."""
    from domains.spawn_claude_code_agent import service

    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    fake_collector = AsyncMock()
    seen_create_session = {}
    handoff = _collatz_handoff()

    async def fake_create_session(**kwargs):
        seen_create_session.update(kwargs)
        return {"task_id": "task-h", "sandbox_id": "sb", "ws_url": "wss://x", "uploaded_files": []}

    async def fake_loop(**kwargs):
        return (0, True, [], 0, 0, _collatz_stream_events())

    async def fake_close(**kwargs):
        return {"output_files": [], "usage": {}, "handoff": {"status": "present", "content": json.dumps(handoff)}}

    with (
        patch.dict("os.environ", {"ROSE_ENABLE_CODE_AGENT_VERIFIER": ""}),
        patch.object(service, "SandboxLogCollector", lambda *a, **kw: fake_collector),
        patch.object(service, "create_e2b_session", side_effect=fake_create_session),
        patch.object(service, "_run_agentic_loop", side_effect=fake_loop),
        patch.object(service, "persist_terminal_output", AsyncMock(return_value=None)),
        patch.object(service, "close_e2b_session", side_effect=fake_close),
        patch.object(service, "_resolve_claude_token_for_activity", AsyncMock(return_value="tok")),
        patch(
            "helpers.model_pricing.get_model_pricing_with_fallback",
            AsyncMock(return_value={"input_cents_per_1k": 0.1, "output_cents_per_1k": 0.2}),
        ),
        patch("temporalio.activity.heartbeat"),
    ):
        result = await service.spawn_claude_code_activity(
            user_id="u",
            agent_id="a",
            goal="Compute Collatz from 27.",
            tool_call_id="tc",
            output_schema=COLLATZ_OUTPUT_SCHEMA,
            model="rose-labs/rose-1-flash",
        )
    assert seen_create_session["goal"].startswith("Compute Collatz from 27.")
    assert service.CODE_AGENT_HANDOFF_PATH in seen_create_session["goal"]
    assert result["success"] is True, result["message"]
    assert result["structured_response"] == handoff
    assert json.dumps(handoff, ensure_ascii=False, indent=2) in result["message"]
    assert "code_agent_events" not in result["message"]
    assert len(result["message"]) < 5_000, len(result["message"])


async def test_spawn_activity_fast_exit_auth_failure_pauses_for_a_retry():
    """A fast CLI 401 never reaches the verifier: the structured rejection pauses the
    session for a re-leased retry; the printed banner alone classifies nothing."""
    from domains.spawn_claude_code_agent import service

    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})

    fake_collector = AsyncMock()
    fake_collector.start = AsyncMock()
    fake_collector.stop = AsyncMock()
    close_session = AsyncMock(return_value={})
    verifier = AsyncMock()
    persisted = AsyncMock()
    rejection = {
        "type": "cli_message",
        "raw_type": "assistant.api_error",
        "cli_message": {"type": "assistant_api_error", "error": "authentication_failed"},
        "credential": "0123456789abcdef",
    }

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
        kwargs["code_events"].append(rejection)
        kwargs["loop_outcome"]["login_unusable"] = service.login_unusable_from_event(rejection)
        return (1, False, [], 0, 0, kwargs["code_events"])

    with (
        patch.object(service, "SandboxLogCollector", lambda *a, **kw: fake_collector),
        patch.object(service, "create_e2b_session", side_effect=fake_create_session),
        patch.object(service, "_run_agentic_loop", side_effect=fake_loop),
        patch.object(service, "_run_verifier", verifier),
        patch.object(service, "persist_terminal_output", persisted),
        patch.object(service, "close_e2b_session", close_session),
        patch.object(service, "fetch_code_credential_availability", AsyncMock(return_value=None)),
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
        )

    assert result["status"] == "usage_limit" and result["failure_kind"] == "login_unusable", result
    assert result["retryable"] is True, result
    verifier.assert_not_awaited()
    close_session.assert_awaited_once()
    assert close_session.await_args.kwargs["reason"] == "usage_limit"
    assert persisted.await_args.kwargs["credential_feedback"] == [
        {"source": "initial", "reason": "authentication_failed", "credential": "0123456789abcdef"}
    ]
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
            "[Codex] ChatGPT OAuth unusable — continuing on the funded Azure OpenAI deployment\n"
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
    assert "ChatGPT OAuth unusable" not in persisted_output
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
            "[Codex] ChatGPT OAuth unusable — continuing on the funded Azure OpenAI deployment\n"
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
    # The workflow's chip row reuses this block: a user pause is resumable.
    assert (result["code_agent"]["task_id"], result["code_agent"]["state"]) == ("t", "paused"), result
    assert result["code_agent"]["ended_at"], result["code_agent"]
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

    @staticmethod
    def now():
        from datetime import datetime, timezone

        return datetime(2026, 10, 20, tzinfo=timezone.utc)

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


def _paused_row(events):
    """The single user-pause row: FINISHED, resumable, never an ERROR (W5b contract)."""
    from tools.base import MessageStatus

    assert not any(getattr(e, "status", None) == MessageStatus.ERROR for e in events), _cc_titles(events)
    rows = [e for e in events if getattr(e, "title", None) == "Code session paused"]
    assert len(rows) == 1, _cc_titles(events)
    row = rows[0]
    assert row.status == MessageStatus.FINISHED, row.status
    assert row.metadata.get("session_paused") is True, row.metadata
    assert row.metadata["code_agent"]["state"] == "paused", row.metadata["code_agent"]
    assert row.metadata["code_agent"]["ended_at"], row.metadata["code_agent"]
    return row


async def test_cc_execute_tool_cancelled_status_yields_paused_row():
    """Activity status='cancelled' yields a chip-terminal paused task_complete with task_id.

    ClaudeCodeChip only leaves spinning_up when a task-scoped message has
    action_type=task_complete. Pause/cancel must emit task_complete (not
    session_cancelled) and include task_id so the chip can match it. A user
    pause is resumable, so the row is FINISHED with code_agent.state 'paused'.
    """
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager

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

    row = _paused_row(events)
    assert row.metadata.get("action_type") == "task_complete"
    assert row.metadata.get("task_id") == "task-cancel-1"
    assert row.metadata.get("success") is False
    assert row.metadata.get("toolName") == "spawn_claude_code_agent"
    assert row.metadata["code_agent"]["task_id"] == "task-cancel-1", row.metadata["code_agent"]
    assert row.metadata["code_agent"]["provider"] == "claude", row.metadata["code_agent"]


async def test_cc_execute_tool_cancelled_error_path():
    """CancelledError on activity_handle await yields the paused task_complete row."""
    import asyncio as asyncio_mod

    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager

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

    row = _paused_row(events)
    # Await raised before activity returned task_id — still emit task_complete so
    # MessageBubble keeps routing through ClaudeCodeChip (session_cancelled does not).
    assert row.metadata.get("action_type") == "task_complete"
    assert row.metadata.get("success") is False


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


async def test_cc_execute_tool_invalid_code_session_id_is_not_sent_or_called_capacity():
    """RCA 942d8562 (2026-10-27): code_session_id="null" must not reach the backend.

    The model sent the literal string "null" for an omitted optional. The
    backend's uuid schema rejected it (HTTP 500 zod invalid_string) and the
    tool reported "a transient sandbox capacity error". A non-UUID id is an
    invalid argument: say so truthfully, without scheduling a session create.
    """
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager
    from tools.base import MessageStatus

    handle = _FakeActivityHandle(result={"success": True})
    fake = _FakeCCWorkflow(handle)
    restore = _patch_cc_workflow(fake)
    try:
        events = await _collect_cc_events(
            SpawnClaudeCodeAgentManager().execute_tool(
                _FakeCCWorkflowInstance(),
                {"goal": "g", "code_session_id": "null"},
                "tc-bad-session-id",
            )
        )
    finally:
        restore()

    assert fake.started_activity_args is None, "invalid code_session_id was forwarded to session create"
    finished = next(e for e in events if getattr(e, "status", None) == MessageStatus.FINISHED)
    assert finished.metadata.get("success") is False
    assert "code_session_id" in finished.message
    assert "capacity" not in finished.message.lower()


def test_cc_validation_failure_is_not_classified_as_sandbox_capacity():
    """RCA 942d8562: a 4xx request-validation failure is not a transient capacity flake."""
    from domains.spawn_claude_code_agent.handler import _maybe_soft_fail_session_create_result

    validation = Exception(
        "Failed to create code session (provider=codex): HTTP 400: "
        '{"error":"Invalid request","code":"INVALID_REQUEST","issues":[{"path":["code_session_id"],"message":"Invalid uuid"}]}'
    )
    assert _maybe_soft_fail_session_create_result(code_provider="codex", error=validation) is None
    capacity = Exception(
        "Failed to create code session (provider=codex): HTTP 500: "
        '{"error":"500: Failed to create sandbox: redis: connection pool timeout"}'
    )
    soft = _maybe_soft_fail_session_create_result(code_provider="codex", error=capacity)
    assert soft is not None and "capacity" in soft["message"].lower()


def test_code_agent_activity_has_no_deadline_and_no_attempt_cap():
    """C11 structural check: the code-agent activity's only liveness limit is its heartbeat.

    Temporal requires start_to_close or schedule_to_close, so the call passes
    CODE_AGENT_ACTIVITY_NO_DEADLINE (>= 10 years), never schedule_to_close, and
    an unlimited retry policy. Capacity flakes still get bounded in-activity
    retries before the soft-fail path (cuda-kernel k=3 r10 agent1) through
    CODE_AGENT_ERROR_RETRY_LIMIT.
    """
    import ast
    import inspect
    import textwrap
    from datetime import timedelta

    from domains.spawn_claude_code_agent import config
    from domains.spawn_claude_code_agent import handler as cc_handler

    tree = ast.parse(textwrap.dedent(inspect.getsource(cc_handler.SpawnClaudeCodeAgentManager.execute_tool)))
    calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr in {"start_activity", "execute_activity"}
        and node.args
        and isinstance(node.args[0], ast.Name)
        and node.args[0].id == "spawn_claude_code_activity"
    ]
    assert len(calls) == 1, f"expected one spawn_claude_code_activity schedule, found {len(calls)}"
    keywords = {kw.arg: kw.value for kw in calls[0].keywords}
    assert "schedule_to_close_timeout" not in keywords, "code-agent activity must not have a schedule_to_close limit"
    deadline = keywords.get("start_to_close_timeout")
    assert isinstance(deadline, ast.Name) and deadline.id == "CODE_AGENT_ACTIVITY_NO_DEADLINE", ast.dump(deadline)
    assert config.CODE_AGENT_ACTIVITY_NO_DEADLINE >= timedelta(days=3650)
    assert "heartbeat_timeout" in keywords, "liveness must stay heartbeat-based"
    retry = keywords.get("retry_policy")
    assert isinstance(retry, ast.Call), ast.dump(retry) if retry else "retry_policy missing"
    attempts = {kw.arg: kw.value for kw in retry.keywords}.get("maximum_attempts")
    assert attempts is None or (isinstance(attempts, ast.Constant) and attempts.value == 0), (
        "code-agent retries must be unlimited (maximum_attempts=0)"
    )
    assert config.CODE_AGENT_ERROR_RETRY_LIMIT >= 5
    for removed in ("MAX_RUNTIME_S", "SDK_IDLE_TIMEOUT_S", "SDK_WAIT_TOOL_IDLE_TIMEOUT_S"):
        assert not hasattr(config, removed), f"{removed} is a code-agent runtime limit (C11)"


async def test_cc_execute_tool_paused_cancels_activity():
    """is_paused=True triggers activity_handle.cancel() and a chip-terminal paused row."""
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager

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
    row = _paused_row(events)
    assert row.metadata.get("action_type") == "task_complete"
    assert row.metadata.get("task_id") == "task-pause-1"
    assert row.metadata.get("code_provider") == "codex"
    assert row.metadata.get("success") is False
    assert row.metadata["code_agent"]["provider"] == "codex", row.metadata["code_agent"]


async def _run_all_tests():
    print("spawn-claude-code-agent blackbox tests:")
    r = BlackboxResult()
    await r.record_async("session_create_mock", test_claude_code_session_create_mock)
    await r.record_async(
        "session_create_outwaits_slow_backend_and_heartbeats",
        test_session_create_outwaits_a_slow_backend_and_heartbeats,
    )
    await r.record_async("session_health_mock", test_claude_code_session_health_mock)
    # pure helpers
    r.record("terminal_fatal_ignores_banner_text", test_terminal_fatal_ignores_banner_text)
    r.record(
        "codex_structured_exhaustion_terminal_after_failed_fallback",
        test_codex_structured_exhaustion_is_terminal_only_after_failed_fallback,
    )
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
    await r.record_async("repo_close_session_non200", test_repo_close_e2b_session_non_200_is_unconfirmed)
    await r.record_async("close_timeout_reconciles_same_task", test_close_timeout_reconciles_same_task_before_activity_completion)
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
    await r.record_async("run_verifier_happy", _with_verifier_opt_in(test_run_verifier_happy_path))
    await r.record_async("run_verifier_off_by_default", test_run_verifier_off_by_default)
    r.record("handoff_json_schema_fixed_by_output_schema", test_handoff_json_schema_is_fixed_by_output_schema)
    r.record("handoff_json_schema_field_descriptions", test_handoff_json_schema_carries_declared_field_descriptions)
    await r.record_async("handoff_valid_json_is_tool_result", test_handoff_valid_json_is_the_tool_result)
    await r.record_async("handoff_missing_or_invalid_truthful", test_handoff_missing_or_invalid_is_reported_truthfully)
    await r.record_async("handoff_replay_31f51d25_bounded", test_handoff_replay_31f51d25_result_is_bounded)
    await r.record_async("handoff_spawn_activity_end_to_end", test_spawn_activity_returns_close_handoff_as_result)
    await r.record_async(
        "run_verifier_disabled_schema_incomplete",
        test_run_verifier_disabled_rejects_schema_incomplete_artifacts,
    )
    await r.record_async(
        "run_verifier_disabled_includes_sdk_stdout",
        test_run_verifier_disabled_includes_sdk_event_stdout,
    )
    await r.record_async(
        "disabled_verifier_truthful_session_outcome",
        test_disabled_verifier_reports_successful_session_truthfully,
    )
    await r.record_async("run_verifier_exception", _with_verifier_opt_in(test_run_verifier_exception_fallback))
    await r.record_async(
        "run_verifier_partial_verdict_missing_required_field",
        _with_verifier_opt_in(test_run_verifier_partial_verdict_missing_required_field_reaches_parent),
    )
    await r.record_async(
        "run_verifier_codex_event_json",
        _with_verifier_opt_in(test_run_verifier_uses_code_event_json_for_codex_context),
    )
    await r.record_async(
        "run_verifier_truncation_preserves_rejection",
        _with_verifier_opt_in(test_run_verifier_truncation_preserves_rejection),
    )
    await r.record_async(
        "run_verifier_no_override_no_trunc",
        _with_verifier_opt_in(test_run_verifier_no_override_when_no_truncation),
    )
    await r.record_async(
        "run_verifier_no_override_no_attempt",
        _with_verifier_opt_in(test_run_verifier_no_override_when_attempt_completion_false),
    )
    await r.record_async(
        "run_verifier_no_override_already_pass",
        _with_verifier_opt_in(test_run_verifier_no_override_when_already_passing),
    )
    # _run_agentic_loop
    await r.record_async("run_agentic_loop_exit_zero", test_run_agentic_loop_exit_zero_completes)
    await r.record_async("run_agentic_loop_connect_fail", test_run_agentic_loop_connect_fail_raises)
    await r.record_async("run_agentic_loop_idle_cli_paused", test_run_agentic_loop_idle_cli_is_paused_not_failed)
    await r.record_async(
        "run_agentic_loop_in_flight_tool_no_idle_limit",
        test_run_agentic_loop_in_flight_tool_has_no_idle_limit,
    )
    await r.record_async(
        "run_agentic_loop_nameless_in_flight_tool_no_idle_limit",
        test_run_agentic_loop_nameless_in_flight_tool_has_no_idle_limit,
    )
    await r.record_async(
        "run_agentic_loop_finished_tool_then_quiet_paused",
        test_run_agentic_loop_finished_tool_then_quiet_cli_is_paused,
    )
    await r.record_async(
        "run_agentic_loop_sdk_result_zombie_exit_grace",
        test_run_agentic_loop_sdk_result_zombie_ends_on_exit_grace,
    )
    await r.record_async(
        "run_agentic_loop_post_result_exit_grace_breaks",
        test_run_agentic_loop_post_result_exit_grace_breaks,
    )
    await r.record_async(
        "run_agentic_loop_keepalive_extends_sandbox",
        test_run_agentic_loop_keepalive_extends_attached_sandbox,
    )
    r.record("log_codex_demo_cache_event", test_log_code_agent_event_promotes_codex_demo_cache_request)
    r.record(
        "log_claude_tool_use_event",
        test_log_code_agent_event_promotes_claude_tool_use_to_info,
    )
    r.record(
        "log_claude_cli_rate_limit_and_api_retry",
        test_log_code_agent_event_surfaces_claude_cli_rate_limit_and_api_retry,
    )
    r.record("codex_completed_turn_count", test_codex_completed_turn_count_counts_unique_turn_completed_events)
    r.record("native_codex_usage_retains_session_scope", test_native_codex_usage_retains_session_scope)
    await r.record_async(
        "judge_evidence_streamed_claude_session_native_process_trace",
        test_judge_evidence_of_streamed_claude_session_satisfies_native_process_trace,
    )
    await r.record_async("native_codex_terminal_finishes_idle_app_server", test_native_codex_terminal_event_finishes_idle_app_server)
    await r.record_async("native_codex_terminal_respects_hold_and_newer_active_turn", test_native_codex_terminal_respects_hold_and_newer_active_turn)
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
        test_spawn_activity_fast_exit_auth_failure_pauses_for_a_retry,
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
    await r.record_async("cc_exec_cancel_status", test_cc_execute_tool_cancelled_status_yields_paused_row)
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
    await r.record_async(
        "cc_exec_invalid_code_session_id_not_sent",
        test_cc_execute_tool_invalid_code_session_id_is_not_sent_or_called_capacity,
    )
    r.record(
        "cc_validation_failure_not_capacity",
        test_cc_validation_failure_is_not_classified_as_sandbox_capacity,
    )
    r.record(
        "cc_activity_no_deadline_no_attempt_cap",
        test_code_agent_activity_has_no_deadline_and_no_attempt_cap,
    )
    await r.record_async("cc_exec_paused", test_cc_execute_tool_paused_cancels_activity)
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
    await r.record_async(
        "cc_reattach_after_replay_exceeds_frame_limit",
        test_run_agentic_loop_reattaches_after_replay_exceeds_one_frame_limit,
    )
    await r.record_async("cc_sandbox_replay_frames_fit_client_limit", test_sandbox_replay_frames_fit_a_default_client_limit)
    await r.record_async(
        "cc_finished_real_tool_calls_then_hung_cli_paused",
        test_run_agentic_loop_finished_real_tool_calls_then_hung_cli_is_paused,
    )
    await r.record_async(
        "cc_codex_item_lifecycle_tracks_tools_in_flight",
        test_run_agentic_loop_codex_item_lifecycle_tracks_tools_in_flight,
    )
    await r.record_async(
        "cc_retains_linear_text_for_streamed_answer",
        test_run_agentic_loop_retains_linear_text_for_streamed_answer,
    )
    r.record("cc_durable_transcript_each_message_once", test_durable_transcript_writes_each_streamed_message_once)
    await r.record_async("cc_chunked_replay_applied_as_one_history", test_run_agentic_loop_applies_a_chunked_replay_as_one_history)
    r.record("cc_transcript_rev_rises_across_compacted_replay", test_transcript_revision_keeps_rising_across_a_compacted_replay)
    r.record("cc_empty_final_thinking_keeps_streamed_text", test_empty_final_thinking_keeps_the_streamed_thinking_text)
    r.record(
        "cc_sandbox_ws_servers_linger_past_heartbeat_timeout",
        test_sandbox_ws_servers_linger_past_the_activity_heartbeat_timeout,
    )
    await r.record_async(
        "cc_manager_reattaches_after_worker_drain_on_same_queue",
        test_cc_manager_reattaches_after_worker_drain_on_same_queue,
    )
    await r.record_async(
        "cc_fresh_conversation_resume_keeps_session_drops_cli_resume",
        test_cc_fresh_conversation_resume_keeps_session_and_drops_cli_resume,
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
        "cc_manager_pause_after_drain_names_detached_code_session",
        test_cc_manager_pause_after_drain_names_the_detached_code_session,
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
    await r.record_async(
        "cc_manager_user_pause_row_carries_activity_code_agent",
        test_cc_manager_user_pause_row_carries_activity_code_agent,
    )
    await r.record_async(
        "cc_manager_user_pause_result_names_resumable_code_session",
        test_cc_manager_user_pause_result_names_its_resumable_code_session,
    )
    await r.record_async(
        "cc_manager_usage_limit_row_is_paused_with_user_text",
        test_cc_manager_usage_limit_row_is_paused_with_user_text,
    )
    await r.record_async("cc_error_budget_ignores_worker_deaths", test_claude_code_error_budget_ignores_worker_deaths)
    await r.record_async(
        "cc_cancelled_run_tracks_its_sandbox_usage", test_cc_execute_tool_cancelled_run_tracks_its_sandbox_usage
    )
    await r.record_async(
        "cc_every_run_end_reports_sandbox_usage_by_size",
        test_claude_code_every_end_of_a_run_reports_sandbox_usage_by_size,
    )
    await r.record_async(
        "cc_long_run_writes_no_repeated_status_rows",
        test_run_agentic_loop_long_run_writes_no_repeated_status_rows,
    )
    await r.record_async(
        "cc_codex_status_rows_follow_completed_turns",
        test_run_agentic_loop_codex_status_rows_follow_completed_turns,
    )
    await r.record_async(
        "cc_retryable_error_keeps_live_sandbox_for_retry",
        test_claude_code_retryable_error_keeps_the_live_sandbox_for_the_retry,
    )
    teardown_mock()
    return r.all_passed


def _with_verifier_opt_in(test):
    """Run an LLM-verifier-path test with the explicit opt-in set."""

    async def wrapped():
        with patch.dict(os.environ, {"ROSE_ENABLE_CODE_AGENT_VERIFIER": "1"}):
            await test()

    return wrapped


async def run_all_tests():
    # The suite runs on the production default (verifier off) regardless of
    # the caller's environment; LLM-verifier tests opt in individually.
    with patch.dict(os.environ, {}):
        os.environ.pop("ROSE_ENABLE_CODE_AGENT_VERIFIER", None)
        os.environ.pop("ROSE_DISABLE_CODE_AGENT_VERIFIER", None)
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

    # The Codex ws-server emits the same event stamped provider "codex".
    codex = format_code_events_transcript(
        [
            {"type": "project_startup", "provider": "codex", "status": "ok", "project": "Rose", "durationMs": 2000},
            {"type": "project_startup", "provider": "codex", "status": "failed", "project": "Rose", "exitCode": 1},
        ]
    )
    assert codex.splitlines() == [
        "[Codex] Project startup (Rose): ok in 2.0s",
        "[Codex] Project startup (Rose): failed (exit 1)",
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


def read_user_line():
    # Next user-message line; native settings control requests are answered like the real CLI.
    while True:
        line = sys.stdin.readline()
        if not line:
            return line
        if not line.strip():
            continue
        incoming = json.loads(line)
        if incoming.get("type") != "control_request":
            return line
        subtype = incoming["request"]["subtype"]
        models = []
        if subtype == "initialize":
            models = [{"value": sys.argv[sys.argv.index("--model") + 1] if "--model" in sys.argv else "stub",
                       "supportedEffortLevels": [], "supportsFastMode": False}]
        emit({"type": "control_response",
              "response": {"request_id": incoming["request_id"],
                           "subtype": "success" if subtype in ("initialize", "apply_flag_settings", "set_model") else "error",
                           "response": {"models": models} if subtype == "initialize" else {}}})


record(read_user_line())


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
    line = read_user_line()
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

    def __init__(self, extra_env: dict[str, str] | None = None, cli_script: str = "") -> None:
        self._extra_env = dict(extra_env or {})
        self._cli_script = cli_script or _STUB_CLAUDE_CLI
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
        (self._tmp / "stub_claude.py").write_text(self._cli_script)
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
        self.transcripts: list[dict] = []
        self.collector = AsyncMock()

    async def create_session(self, **kwargs):
        self.created.append(kwargs)
        return {"task_id": "cc-task-1", "sandbox_id": "sb-1", "ws_url": self.ws_url, "uploaded_files": []}

    async def close_session(self, **kwargs):
        self.closed.append(kwargs)
        return {"output_files": [], "usage": None}

    async def save_message(self, **kwargs):
        self.titles.append(kwargs.get("title"))

    async def save_transcript(self, **kwargs):
        self.transcripts.append(kwargs)
        return True

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
            patch.object(service, "save_code_transcript_batch", side_effect=self.save_transcript),
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
        assert [(event.get("client_message_id"), event.get("sender")) for event in user_turns] == [(turn_id, "agent")], user_turns
        started_turn_ids = {event.get("turn_id") for event in events if event.get("type") == "turn_started"}
        assert user_turns[0].get("turn_id") in started_turn_ids, user_turns
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


_STREAMING_STUB_PRELUDE = r"""
import json
import os
import sys
import time


def emit(message):
    print(json.dumps(message), flush=True)


def read_user_line():
    # Answer native-settings control requests like the real CLI; return the next user turn.
    while True:
        line = sys.stdin.readline()
        if not line:
            return line
        if not line.strip():
            continue
        incoming = json.loads(line)
        if incoming.get("type") != "control_request":
            return line
        subtype = incoming["request"]["subtype"]
        emit({"type": "control_response",
              "response": {"request_id": incoming["request_id"],
                           "subtype": "success" if subtype in ("initialize", "apply_flag_settings", "set_model") else "error",
                           "response": {"models": [{"value": "stub", "supportedEffortLevels": [], "supportsFastMode": False}]}
                           if subtype == "initialize" else {}}})


def stream(event):
    emit({"type": "stream_event", "event": event})


read_user_line()
emit({"type": "system", "subtype": "init", "session_id": "stub", "cwd": os.getcwd(), "model": "stub",
      "tools": ["Bash"], "permissionMode": "bypassPermissions"})
"""

# One long streamed answer, token by token, the way `--include-partial-messages`
# delivers it: 120 deltas of 1,000 characters (a 120 kB message).
_LONG_STREAM_STUB_CLI = _STREAMING_STUB_PRELUDE + r"""
chunk = "x" * 999 + "\n"
stream({"type": "message_start", "message": {"id": "msg-long", "usage": {}}})
stream({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})
for _ in range(120):
    stream({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": chunk}})
stream({"type": "content_block_stop", "index": 0})
emit({"type": "assistant", "message": {"id": "msg-long", "content": [{"type": "text", "text": chunk * 120}]}})
emit({"type": "result", "subtype": "success", "result": "long answer written", "usage": {}})
while read_user_line():
    pass
"""

# A long session of finished answers: 50 messages of 120 kB (6 MB of history
# that no compaction can shrink).
_MANY_ANSWERS_STUB_CLI = _STREAMING_STUB_PRELUDE + r"""
for n in range(50):
    emit({"type": "assistant", "message": {"id": f"msg-{n}", "content": [{"type": "text", "text": "z" * 120_000}]}})
emit({"type": "result", "subtype": "success", "result": "long answer written", "usage": {}})
while read_user_line():
    pass
"""


async def _reattach_after_cli_exit(cli_script: str) -> tuple[int, int, list[dict]]:
    """Attach the real loop to a real ws-server whose CLI already exited."""
    from domains.spawn_claude_code_agent import service
    from utils.terminal_filter import TerminalFilter

    sandbox = _LocalCodeSandbox(cli_script=cli_script)
    await sandbox.start()
    try:
        await sandbox.wait_for_log("Serving final buffer for reattach until closed", timeout=30)
        with (
            patch("temporalio.activity.heartbeat"),
            patch.object(service, "save_code_transcript_batch", AsyncMock(return_value=True)),
            patch.object(service, "_log_code_agent_event"),
        ):
            try:
                exit_code, _attempt, _history, _in, _out, events = await asyncio.wait_for(
                    service._run_agentic_loop(
                        agent_id="a",
                        task_id="t",
                        sandbox_id="sb",
                        goal="g",
                        ws_url=sandbox.ws_url,
                        terminal=TerminalFilter(cols=80, rows=50),
                        model="rose-labs/rose-1-flash",
                        claude_token=None,
                        action_summary=[],
                        tool_call_id="tc",
                    ),
                    timeout=30,
                )
            except asyncio.TimeoutError:
                attaches = sandbox.log().count("Served final buffer to reattaching client")
                raise AssertionError(f"reattach never read the exit; {attaches} replays served in 30s") from None
        return exit_code, sandbox.log().count("Served final buffer to reattaching client"), events
    finally:
        sandbox.stop()


async def test_run_agentic_loop_reattaches_after_replay_exceeds_one_frame_limit():
    """A long streamed session must stay reattachable (multi-day RCA T1 #1).

    Every partial text delta stored the whole message so far, and every connect
    replayed the full history in one frame. One 120 kB answer made that frame
    larger than aiohttp's 4 MiB receive limit: the client closed with 1009,
    reconnected (each handshake reset the reconnect budget) and looped forever,
    never reading the exit queued behind the replay. A reattach after a deploy
    drain, a network blip or a worker retry must read the result and return.
    """
    exit_code, attaches, events = await _reattach_after_cli_exit(_LONG_STREAM_STUB_CLI)
    assert exit_code == 0, exit_code
    assert attaches == 1, f"one reattach must suffice, served {attaches}"
    final = [e for e in events if e.get("type") == "agent_message" and e.get("partial") is False]
    assert len(final) == 1 and len(final[0]["text"]) == 120_000, [len(e.get("text") or "") for e in final]
    assert [e["seq"] for e in events] == list(range(len(events))), "replay must keep the sandbox's event order"
    assert any(e.get("type") == "result" for e in events), events[-3:]

    # History that stays larger than one frame after compaction replays too.
    exit_code, attaches, events = await _reattach_after_cli_exit(_MANY_ANSWERS_STUB_CLI)
    answers = [e for e in events if e.get("type") == "agent_message"]
    assert exit_code == 0 and attaches == 1, (exit_code, attaches)
    assert len(answers) == 50 and all(len(e["text"]) == 120_000 for e in answers), len(answers)
    assert [e["seq"] for e in events] == list(range(len(events))), "chunked replay must keep the event order"


async def test_sandbox_replay_frames_fit_a_default_client_limit():
    """The real ws-server bounds every replay frame for a chunk-aware client (T1 #1).

    The client reads with aiohttp's default 4 MiB limit here, so a single
    oversized history frame fails exactly as it did in production.
    """
    import aiohttp

    sandbox = _LocalCodeSandbox(cli_script=_MANY_ANSWERS_STUB_CLI)
    await sandbox.start()
    sizes: list[int] = []
    events: list[dict] = []
    output = ""
    try:
        await sandbox.wait_for_log("Serving final buffer for reattach until closed", timeout=30)
        async with aiohttp.ClientSession() as session:
            async with session.ws_connect(f"{sandbox.ws_url}/?replay_chunks=1") as ws:
                async for msg in ws:
                    assert msg.type == aiohttp.WSMsgType.TEXT, (msg.type, ws.exception())
                    sizes.append(len(msg.data.encode()))
                    frame = json.loads(msg.data)
                    if frame["type"] == "code_agent_events":
                        events = frame["data"] if frame.get("chunk", 0) == 0 else [*events, *frame["data"]]
                    elif frame["type"] in ("buffer", "stdout"):
                        output = frame["data"] if frame["type"] == "buffer" else output + frame["data"]
                    elif frame["type"] == "exit":
                        break
    finally:
        sandbox.stop()
    assert max(sizes) <= 1.5 * 1024 * 1024, f"largest replay frame {max(sizes)} bytes"
    assert len([e for e in events if e.get("type") == "agent_message"]) == 50, len(events)
    assert output.count("[Claude] zzz") == 50, output.count("[Claude] zzz")


# The real event sequence of tool calls: Claude streams each tool_use at
# content_block_start (partial) and again in the assistant envelope, and merges
# the results of parallel calls into one user message. Then the CLI hangs.
_TOOLS_THEN_HANG_STUB_CLI = _STREAMING_STUB_PRELUDE + r"""
stream({"type": "message_start", "message": {"id": "msg-1", "usage": {}}})
stream({"type": "content_block_start", "index": 0,
        "content_block": {"type": "tool_use", "id": "tu-1", "name": "Bash", "input": {}}})
stream({"type": "content_block_stop", "index": 0})
emit({"type": "assistant", "message": {"id": "msg-1", "content": [
    {"type": "tool_use", "id": "tu-1", "name": "Bash", "input": {"command": "ls"}}]}})
emit({"type": "user", "tool_use_result": {"stdout": "ok"}, "message": {"content": [
    {"type": "tool_result", "tool_use_id": "tu-1", "content": "ok"}]}})
stream({"type": "message_start", "message": {"id": "msg-2", "usage": {}}})
for index, tool_id in enumerate(("tu-2", "tu-3")):
    stream({"type": "content_block_start", "index": index,
            "content_block": {"type": "tool_use", "id": tool_id, "name": "Read", "input": {}}})
    stream({"type": "content_block_stop", "index": index})
emit({"type": "assistant", "message": {"id": "msg-2", "content": [
    {"type": "tool_use", "id": "tu-2", "name": "Read", "input": {"file_path": "a"}},
    {"type": "tool_use", "id": "tu-3", "name": "Read", "input": {"file_path": "b"}}]}})
emit({"type": "user", "tool_use_result": [{"file": "a"}, {"file": "b"}], "message": {"content": [
    {"type": "tool_result", "tool_use_id": "tu-2", "content": "a"},
    {"type": "tool_result", "tool_use_id": "tu-3", "content": "b"}]}})
# Every tool finished; the CLI now hangs without a result.
while True:
    time.sleep(1)
"""


async def test_run_agentic_loop_finished_real_tool_calls_then_hung_cli_is_paused():
    """Finished tool calls must not count as in flight (multi-day RCA T1 #2).

    The loop counted +1 per tool_use event and -1 per tool_result event. The
    real ws-server emits each Claude tool_use twice (partial block start, then
    the assistant envelope) and one tool_result for parallel calls, so the
    count only climbed and a hung CLI was never idle-paused.
    """
    from domains.spawn_claude_code_agent import service

    sandbox = _LocalCodeSandbox(cli_script=_TOOLS_THEN_HANG_STUB_CLI)
    await sandbox.start()
    outcome: dict = {}
    summary: list[str] = []
    try:
        with (
            patch("temporalio.activity.heartbeat"),
            patch.object(service, "save_code_transcript_batch", AsyncMock(return_value=True)),
            patch.object(service, "_log_code_agent_event"),
            patch.object(service, "keepalive_e2b_session", AsyncMock(return_value={})),
            patch.object(service, "CODE_SESSION_IDLE_PAUSE_S", 1.0),
        ):
            try:
                exit_code, *_rest, events = await asyncio.wait_for(
                    service._run_agentic_loop(**_loop_kwargs(summary, ws_url=sandbox.ws_url, loop_outcome=outcome)),
                    timeout=15,
                )
            except asyncio.TimeoutError:
                raise AssertionError(f"finished tools kept the hung CLI attached: {summary}") from None
    finally:
        sandbox.stop()
    tool_events = [(e["type"], e.get("tool_use_id")) for e in events if e.get("type") in ("tool_use", "tool_result")]
    assert ("tool_use", "tu-1") in tool_events and tool_events.count(("tool_use", "tu-1")) == 2, tool_events
    assert exit_code == -1 and outcome.get("idle_paused") is True, (exit_code, outcome, summary)


async def test_run_agentic_loop_codex_item_lifecycle_tracks_tools_in_flight():
    """Codex items are in flight from item/started until item/completed (T1 #2).

    Event shapes are the ones codex-code/ws-server.mjs emits: mcpToolCall emits
    tool_use on start AND completion (plus a tool_result), webSearch emits
    tool_use twice and never a tool_result, a shell command is a `command` item.
    """
    from domains.spawn_claude_code_agent import service

    base = {"version": 1, "provider": "codex", "turn_id": "t1"}
    finished = [
        {**base, "type": "tool_use", "item_id": "mcp-1", "tool_use_id": "mcp-1", "status": "started", "partial": True, "tool": "s.t"},
        {**base, "type": "tool_use", "item_id": "mcp-1", "tool_use_id": "mcp-1", "status": "completed", "partial": False, "tool": "s.t"},
        {**base, "type": "tool_result", "item_id": "mcp-1", "tool_use_id": "mcp-1", "status": "completed", "partial": False},
        {**base, "type": "tool_use", "item_id": "ws-1", "status": "started", "partial": True, "name": "web_search"},
        {**base, "type": "tool_use", "item_id": "ws-1", "status": "completed", "partial": False, "name": "web_search"},
    ]
    try:
        exit_code, elapsed, outcome, summary, _seen = await asyncio.wait_for(
            _assert_session_stays_attached(finished, hold_s=5.0, end_with_exit=False), timeout=10
        )
    except asyncio.TimeoutError:
        raise AssertionError("finished Codex tools kept a quiet session attached") from None
    assert exit_code == -1 and outcome.get("idle_paused") is True, (exit_code, outcome, summary)
    assert elapsed < 3.0, f"finished Codex tools must not hold the session, took {elapsed:.2f}s"

    running = [{**base, "type": "command", "item_id": "cmd-1", "status": "started", "partial": True, "command": "make"}]
    exit_code, elapsed, outcome, summary, _seen = await _assert_session_stays_attached(running, hold_s=1.0)
    assert exit_code == 0 and elapsed >= 0.9 and "idle_paused" not in outcome, (exit_code, elapsed, outcome)


def _cumulative_stream_events(chunks: int = 120, size: int = 1000) -> list[dict]:
    """A streamed Claude answer as the ws-server emits it live: cumulative partials, then the final block."""
    piece = "y" * (size - 1) + "\n"
    events = [
        {"version": 1, "provider": "claude", "type": "agent_message", "item_id": "msg-1:0",
         "text": piece * (n + 1), "delta": piece, "partial": True}
        for n in range(chunks)
    ]
    events.append({"version": 1, "provider": "claude", "type": "agent_message", "item_id": "msg-1:0",
                   "text": piece * chunks, "partial": False})
    return events


async def test_run_agentic_loop_retains_linear_text_for_streamed_answer():
    """Superseded partial snapshots must not stay in activity memory (T1 #4).

    Each partial carries the whole message so far; keeping every one made the
    activity's code_events grow with the square of the streamed output on a
    shared 2 GB worker.
    """
    from domains.spawn_claude_code_agent import service

    streamed = _cumulative_stream_events()

    class Streaming(_FakeWsClient):
        async def listen(self):
            for event in streamed:
                await self.on_event(dict(event))
            await self.on_exit(0)
            await asyncio.Event().wait()

    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    with (
        patch.object(service, "ClaudeCodeWsClient", Streaming),
        patch.object(service, "save_code_transcript_batch", AsyncMock(return_value=True)),
        patch("temporalio.activity.heartbeat"),
    ):
        exit_code, *_rest, events = await asyncio.wait_for(service._run_agentic_loop(**_loop_kwargs([])), timeout=10)
    final_len = len(streamed[-1]["text"])
    retained = sum(len(e.get("text") or "") for e in events)
    assert exit_code == 0 and len(events) == len(streamed), (exit_code, len(events))
    assert events[-1]["text"] == streamed[-1]["text"]
    assert retained <= 2 * final_len, f"retained {retained} chars of text for a {final_len}-char answer"


def test_durable_transcript_writes_each_streamed_message_once():
    """The durable transcript must hold one line per message, not per partial (T1 #5)."""
    from domains.spawn_claude_code_agent import service

    streamed = _cumulative_stream_events()
    transcript = service.build_durable_terminal_transcript("", streamed)
    final_len = len(streamed[-1]["text"].strip())
    assert transcript.count("[Claude]") == 1, transcript.count("[Claude]")
    assert len(transcript) < 2 * final_len, f"{len(transcript)} chars for a {final_len}-char answer"


async def test_run_agentic_loop_applies_a_chunked_replay_as_one_history():
    """The monitor must never act on half of a chunked replay (T1 #1 review).

    Chunk 0 ends with turn "first" completed and chunk 1 starts turn "second";
    acting between the frames ended the Codex attachment mid-turn.
    """
    from aiohttp import web

    from domains.spawn_claude_code_agent import service

    def codex(**fields):
        return {"version": 1, "provider": "codex", **fields}

    chunk0 = [
        codex(type="turn_started", turn_id="first"),
        codex(type="turn_ended", raw_type="turn/completed", turn_id="first", status="completed", turn_outcome="completed"),
    ]
    chunk1 = [codex(type="turn_started", turn_id="second"), codex(type="user_turn", turn_id="second", text="continue")]

    async def handler(request):
        ws = web.WebSocketResponse()
        if not ws.can_prepare(request).ok:
            return web.Response(status=400)
        await ws.prepare(request)
        await ws.send_str(json.dumps({"type": "code_agent_events", "chunk": 0, "last": False, "data": chunk0}))
        await asyncio.sleep(0.5)  # the next 1 MiB frame is still on the wire
        await ws.send_str(json.dumps({"type": "code_agent_events", "chunk": 1, "last": True, "data": chunk1}))
        await asyncio.sleep(3)
        return ws

    app = web.Application()
    app.router.add_get("/", handler)
    runner = web.AppRunner(app)
    await runner.setup()
    port = _free_port()
    await web.TCPSite(runner, "127.0.0.1", port).start()
    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    try:
        with (
            patch.object(service, "save_code_transcript_batch", AsyncMock(return_value=True)),
            patch("temporalio.activity.heartbeat"),
        ):
            result = None
            with contextlib.suppress(asyncio.TimeoutError):
                result = await asyncio.wait_for(
                    service._run_agentic_loop(
                        **_loop_kwargs([], code_provider="codex", ws_url=f"ws://127.0.0.1:{port}/")
                    ),
                    timeout=2.0,
                )
    finally:
        await runner.cleanup()
    assert result is None, f"loop ended mid-turn on half a replay: exit_code={result[0]}"


def test_transcript_revision_keeps_rising_across_a_compacted_replay():
    """A reattach must not persist a streamed answer at a lower revision (T1 #4/#5 review).

    Replayed superseded partials carry no text. If they add no revision, the
    final answer replays at a lower rev than the partial already persisted, and
    readers that keep the highest rev show the truncated partial forever.
    """
    from domains.spawn_claude_code_agent import service
    from utils.code_transcript import CodeTranscriptBuilder

    streamed = _cumulative_stream_events(chunks=5, size=10)
    live = CodeTranscriptBuilder("claude")
    persisted = None
    for index, event in enumerate(streamed[:-1]):
        for record in live.feed(dict(event), index):
            persisted = record
    assert persisted is not None and persisted["partial"] is True

    history: list[dict] = []
    latest: dict = {}
    for event in streamed:
        history.append(dict(event))
        service._supersede_partial_snapshot(history, latest, len(history) - 1)
    replayed = CodeTranscriptBuilder("claude")
    final = None
    for index, event in enumerate(history):
        for record in replayed.feed(event, index):
            final = record
    assert final is not None and final["text"] == streamed[-1]["text"] and final["partial"] is False
    assert final["rev"] > persisted["rev"], (final["rev"], persisted["rev"])


def test_empty_final_thinking_keeps_the_streamed_thinking_text():
    """A redacted/empty final thinking block must not erase streamed thinking (T1 review)."""
    from domains.spawn_claude_code_agent import service

    events = [
        {"type": "thinking", "item_id": "m:0", "turn_id": "t", "text": "plan the fix", "partial": True},
        {"type": "thinking", "item_id": "m:0", "turn_id": "t", "text": "", "redacted": True},
    ]
    history: list[dict] = []
    latest: dict = {}
    for event in events:
        history.append(dict(event))
        service._supersede_partial_snapshot(history, latest, len(history) - 1)
    assert history[0].get("text") == "plan the fix", history


def test_sandbox_ws_servers_linger_past_the_activity_heartbeat_timeout():
    """Every code sandbox keeps its final result reachable for a crash retry.

    The retry after a dead worker starts only once the activity heartbeat
    timeout passes. If the ws-server exits after the CLI finishes, the retry
    finds nothing to reattach to and reruns the task. With no timeouts (C11)
    the servers serve the final buffer until the session is closed: no linger
    deadline may shut them down.
    """
    import re

    servers = sorted((Path(__file__).resolve().parents[3] / "e2b-templates").glob("*/ws-server.mjs"))
    assert len(servers) >= 2, f"expected the Claude Code and Codex ws-servers, found {servers}"
    for server in servers:
        src = server.read_text()
        assert "REATTACH_LINGER_MS" not in src, f"{server.parent.name}/ws-server.mjs must not time out its linger"
        assert not re.search(r"setTimeout\(\s*\(\)\s*=>\s*shutdown\(", src), (
            f"{server.parent.name}/ws-server.mjs must shut down only when the session is closed"
        )
        assert "Serving final buffer for reattach until closed" in src, server


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


async def test_cc_fresh_conversation_resume_keeps_session_and_drops_cli_resume():
    """W3: continue_conversation=false resumes a paused code agent in a new CLI conversation.

    The workflow's internal ``_fresh_conversation`` flag reaches the session
    create request; the code session (sandbox, files) is still resumed, only
    the backend's CLI ``--resume`` is skipped. Without the flag the request is
    unchanged (continue=true keeps the CLI conversation).
    """
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager
    from domains.spawn_claude_code_agent.repo import create_e2b_session

    for tool_call, expected in (
        ({"goal": "g", "_fresh_conversation": True}, {"fresh_conversation": True}),
        ({"goal": "g"}, None),
    ):
        fake = _SequencedCCWorkflow(_CC_COMPLETED)
        restore = _patch_cc_workflow(fake)
        try:
            await _collect_cc_events(
                SpawnClaudeCodeAgentManager().execute_tool(_HandoffCCWorkflowInstance(), tool_call, "tc-fresh")
            )
        finally:
            restore()
        assert fake.started[0][16] == expected, fake.started[0][16]

    _setup()
    await create_e2b_session(agent_id="agent-1", goal="fix", user_id="u1", fresh_conversation=True)
    body = json.loads(assert_captured_call(url_contains="/api/claude-code-session/create", method="POST")["requestBody"])
    assert body["fresh_conversation"] is True, body
    from helpers.httpx_capture import clear_captures

    clear_captures()
    _setup()
    await create_e2b_session(agent_id="agent-1", goal="fix", user_id="u1")
    body = json.loads(assert_captured_call(url_contains="/api/claude-code-session/create", method="POST")["requestBody"])
    assert "fresh_conversation" not in body, body

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
    # 17 args: ..., resume_session (15), code_session_request (16).
    assert len(fake.started[0]) == 17 and fake.started[0][15] is None, fake.started[0]
    assert fake.started[0][16] is None, "no code_session_id requested"
    assert fake.started[1][15] == _DRAINED_SESSION, fake.started[1][15]
    titles = _cc_titles(events)
    assert titles.count("Starting Claude Code sandbox") == 1, titles
    assert titles.count("\u2713 Task Completed") == 1, titles
    assert "Code session paused" not in titles, titles


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
    return _paused_row(events)


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
    # No activity returned a block: the detached session supplies the identity.
    code_agent = chip.metadata["code_agent"]
    assert (code_agent["task_id"], code_agent["provider"], code_agent["started_at"]) == (
        "cc-task-1",
        "claude",
        "1970-01-01T00:01:40Z",
    ), code_agent
    assert code_agent["ended_at"] == "2026-10-20T00:00:00Z", code_agent
    assert "\u2713 Task Completed" not in _cc_titles(events), _cc_titles(events)


async def test_cc_manager_pause_after_drain_names_the_detached_code_session():
    """A pause while detached for a deploy still names the paused code session (CodeRabbit 4475152946).

    The cancel result built on this path carried no code_session, so the pause
    text lost its code_session_id and a resume could pick the repo's latest
    session. Only the session's identity is reported, never its reattach
    record (ws_url, sandbox id, event cursors).
    """
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager
    from helpers.activity_generation_drain import WORKER_SHUTDOWN

    session_id = "6c1d6f1e-0000-4000-8000-0000000000bb"
    drained = {**_drain_yield(WORKER_SHUTDOWN), "code_session": {**_DRAINED_SESSION, "code_session_id": session_id}}
    fake = _SequencedCCWorkflow(drained)
    wf = _HandoffCCWorkflowInstance()
    wf.is_paused = True
    restore = _patch_cc_workflow(fake)
    try:
        events = await _collect_cc_events(SpawnClaudeCodeAgentManager().execute_tool(wf, {"goal": "g"}, "tc-pause2"))
    finally:
        restore()

    chip = _cancel_chip(events)
    assert chip.metadata["code_session"] == {"code_session_id": session_id, "state": "paused"}, chip.metadata
    assert f"spawn the code agent again with code_session_id='{session_id}' to resume it." in chip.message, chip.message
    assert f"Code session: {session_id} (paused)" in chip.message, chip.message


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


async def test_cc_manager_user_pause_row_carries_activity_code_agent():
    """A user pause ends the chip paused with the activity's own code_agent block.

    The row was an ERROR "Claude Code Session Cancelled" whose code_agent held
    only the target, so the UI rendered a resumable pause as a failure with no
    task id, branch or start time.
    """
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager

    activity_block = {
        "task_id": "cc-task-1",
        "provider": "codex",
        "target": "cloud",
        "branch": "rose/fix-header-0a1b2c3d",
        "base_branch": "main",
        "state": "paused",
        "started_at": "2026-10-19T23:00:00Z",
        "ended_at": "2026-10-19T23:30:00Z",
    }
    cancelled = {
        "status": "cancelled",
        "task_id": "cc-task-1",
        "message": "Claude Code agent cancelled by user",
        "code_provider": "codex",
        "code_agent": dict(activity_block),
    }
    fake = _SequencedCCWorkflow(cancelled)
    wf = _HandoffCCWorkflowInstance()
    wf.is_paused = True
    restore = _patch_cc_workflow(fake)
    try:
        events = await _collect_cc_events(SpawnClaudeCodeAgentManager().execute_tool(wf, {"goal": "g"}, "tc-up"))
    finally:
        restore()

    row = _paused_row(events)
    assert row.metadata["code_agent"] == activity_block, row.metadata["code_agent"]
    assert row.metadata["task_id"] == "cc-task-1" and row.metadata["action_type"] == "task_complete", row.metadata
    assert row.metadata["success"] is False and row.metadata["code_provider"] == "codex", row.metadata
    assert row.message == (
        "Code session paused by the user (not failed). Its files, commits and "
        "conversation are kept; spawn the code agent again to resume it."
    ), row.message


async def test_cc_manager_user_pause_result_names_its_resumable_code_session():
    """A user pause tells the parent which code session is paused and that it resumes.

    The tool result was only "User paused the agent": no code_session_id, so a
    resume picked "the latest session for the repo" (wrong with parallel code
    agents in one repo) and the parent treated the run as finished. Live repro
    (2026-11-04, root c4eaace9): after resume the root spawned an explore agent
    to inspect the paused agent instead of resuming it.
    """
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager

    facts = {"code_session_id": "6c1d6f1e-0000-4000-8000-0000000000aa", "state": "paused", "branch": "rose/counter"}
    cancelled = {
        "status": "cancelled",
        "task_id": "cc-task-2",
        "message": "Claude Code agent cancelled by user",
        "code_provider": "claude",
        "code_session": dict(facts),
    }
    fake = _SequencedCCWorkflow(cancelled)
    wf = _HandoffCCWorkflowInstance()
    wf.is_paused = True
    restore = _patch_cc_workflow(fake)
    try:
        events = await _collect_cc_events(SpawnClaudeCodeAgentManager().execute_tool(wf, {"goal": "g"}, "tc-up2"))
    finally:
        restore()

    row = _paused_row(events)
    assert row.status.value == "FINISHED" and row.metadata["session_paused"] is True, row.metadata
    assert row.metadata["code_session"] == facts, row.metadata
    assert "Code session: 6c1d6f1e-0000-4000-8000-0000000000aa (paused)" in row.message, row.message
    assert row.message.startswith(
        "Code session paused by the user (not failed). Its files, commits and conversation are kept; "
        "spawn the code agent again with code_session_id='6c1d6f1e-0000-4000-8000-0000000000aa' to resume it."
    ), row.message

    # A Mac session keeps its work in the user's folder and continues with target='local'.
    local = {**cancelled, "code_agent": {"target": "local", "device_name": "Andy's MacBook", "folder": "~/dev/app"}}
    fake = _SequencedCCWorkflow(local)
    wf = _HandoffCCWorkflowInstance()
    wf.is_paused = True
    restore = _patch_cc_workflow(fake)
    try:
        events = await _collect_cc_events(SpawnClaudeCodeAgentManager().execute_tool(wf, {"goal": "g"}, "tc-up3"))
    finally:
        restore()
    row = _paused_row(events)
    assert row.message.startswith(
        "Code session paused by the user (not failed). Its files and commits stay in ~/dev/app on "
        "Andy's MacBook; spawn the code agent again with target='local' to continue there."
    ), row.message


async def test_cc_manager_usage_limit_row_is_paused_with_user_text():
    """The usage-limit row is a resumable pause: user text for the UI, the retry for the parent.

    The row carried code_agent.state 'failed' with the parent's retry
    instruction as failure_message, and no session_paused flag.
    """
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager
    from tools.base import MessageStatus

    user_text = "Paused: Claude usage limit reached (resets 4:50 PM UTC). Work is saved."
    instruction = (
        "Code agent stopped: the Claude Code usage limit was reached (resets 2026-10-20T16:50:00.000Z). "
        "Its work is saved on branch rose/a-1.\nRespawn with spawn_agent(type='code', code_session_id='cs-1', "
        "goal=<the same goal>) to continue: ..."
    )
    usage_limit = {"provider": "claude", "resets_at": "2026-10-20T16:50:00.000Z", "limit_type": "five_hour"}
    retry = {"tool": "spawn_agent", "type": "code", "code_session_id": "cs-1"}
    limited = {
        "status": "usage_limit",
        "success": False,
        "failure_kind": "usage_limit",
        "retryable": True,
        "message": instruction,
        "usage_limit": usage_limit,
        "retry": retry,
        "task_id": "cc-task-1",
        "output_files": [],
        "code_provider": "claude",
        "code_agent": {
            "task_id": "cc-task-1",
            "provider": "claude",
            "target": "cloud",
            "branch": "rose/a-1",
            "base_branch": "main",
            "state": "paused",
            "started_at": "2026-10-20T12:00:00Z",
            "ended_at": "2026-10-20T12:30:00Z",
            "failure_message": user_text,
        },
    }
    fake = _SequencedCCWorkflow(limited)
    restore = _patch_cc_workflow(fake)
    try:
        events = await _collect_cc_events(
            SpawnClaudeCodeAgentManager().execute_tool(_HandoffCCWorkflowInstance(), {"goal": "g"}, "tc-ul")
        )
    finally:
        restore()

    assert not any(getattr(e, "status", None) == MessageStatus.ERROR for e in events), _cc_titles(events)
    row = next(e for e in events if getattr(e, "title", None) == "Code agent hit a usage limit")
    assert row.status == MessageStatus.FINISHED, row.status
    assert row.message == instruction, "the parent still reads the exact retry"
    meta = row.metadata
    assert meta["session_paused"] is True, meta
    assert (meta["failure_kind"], meta["retryable"], meta["usage_limit"], meta["retry"]) == (
        "usage_limit",
        True,
        usage_limit,
        retry,
    ), meta
    assert meta["code_agent"]["state"] == "paused", meta["code_agent"]
    assert meta["code_agent"]["failure_message"] == user_text, meta["code_agent"]


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


# ---------------------------------------------------------------------------
# Multi-day robustness (T5): the activity's own error budget and live-session
# retries. A multi-day run sees worker deaths (OOM, deploy SIGKILL) and network
# blips; neither may end it.
# ---------------------------------------------------------------------------


def _activity_error_is_final(error: BaseException) -> bool:
    from temporalio.exceptions import ApplicationError

    return isinstance(error, ApplicationError) and error.non_retryable


async def test_claude_code_error_budget_ignores_worker_deaths():
    """Only errors the activity raised count toward CODE_AGENT_ERROR_RETRY_LIMIT.

    The limit read ``activity.info().attempt``, which Temporal also increments
    for every heartbeat-timeout retry after a dead worker. A weekend with two
    worker deaths and two network blips made the next blip non-retryable and
    ended the multi-day run. Here two attempts die without raising, then the
    create call fails transiently on every later attempt: the first four
    errors must stay retryable and the fifth must stop the retries.
    """
    from temporalio.testing import ActivityEnvironment

    from domains.spawn_claude_code_agent import config, service

    async def backend_blip(**kwargs):
        raise Exception("Failed to create code session (provider=claude): HTTP 502: bad gateway")

    recorder = _CCBoundaryRecorder(ws_url="ws://unused")
    details: list = []
    attempt = 2  # attempts 1 and 2 died with the worker before heartbeating
    outcomes: list[bool] = []
    with (
        recorder.patched(),
        patch.object(service, "create_e2b_session", side_effect=backend_blip),
        patch.object(service, "fetch_code_credential_availability", AsyncMock(return_value=None)),
    ):
        for _ in range(config.CODE_AGENT_ERROR_RETRY_LIMIT):
            attempt += 1
            beats: list = []
            env = ActivityEnvironment()
            env.info = dataclasses.replace(env.info, attempt=attempt, heartbeat_details=list(details))
            env.on_heartbeat = lambda *beat, _beats=beats: _beats.append(beat)
            try:
                await asyncio.wait_for(env.run(service.spawn_claude_code_activity, *_cc_activity_args()), timeout=10)
            except Exception as error:
                assert not isinstance(error, asyncio.TimeoutError), "the failing attempt hung"
                outcomes.append(_activity_error_is_final(error))
            else:
                raise AssertionError("the failing create must raise")
            # Temporal hands the next attempt the last heartbeat this one sent.
            if beats:
                details = list(beats[-1][1:])
    limit = config.CODE_AGENT_ERROR_RETRY_LIMIT
    assert outcomes == [False] * (limit - 1) + [True], (
        f"after 2 worker deaths, errors 1..{limit - 1} must stay retryable and error {limit} must be final; "
        f"final flags per error={outcomes}"
    )


async def test_claude_code_retryable_error_keeps_the_live_sandbox_for_the_retry():
    """A retryable error leaves the live sandbox for the next attempt to reattach.

    The generic error path posted "Task Failed" and closed (checkpoint + pause)
    the sandbox even when Temporal was about to retry. The retry's reattach
    probe then failed against the paused sandbox, so it created a new session
    and restarted the CLI with the original goal. A lost WebSocket
    (``_handle_reconnect_exhausted``) is the common trigger. Only the attempt
    whose error is final may report failure and close the sandbox.
    """
    from temporalio.testing import ActivityEnvironment

    from domains.spawn_claude_code_agent import config, service

    sandbox = _LocalCodeSandbox()
    await sandbox.start()
    recorder = _CCBoundaryRecorder(sandbox.ws_url)
    real_loop = service._run_agentic_loop
    lost = {"armed": True}

    async def loop_loses_the_socket(**kwargs):
        if lost["armed"]:
            lost["armed"] = False
            await service._handle_reconnect_exhausted(
                kwargs["sandbox_id"], kwargs["agent_id"], kwargs["task_id"], kwargs["action_summary"]
            )
        return await real_loop(**kwargs)

    try:
        with (
            recorder.patched(),
            patch.object(service, "_run_agentic_loop", side_effect=loop_loses_the_socket),
            patch.object(service, "check_sandbox_health", AsyncMock(return_value=None)),
            patch.object(service, "fetch_code_credential_availability", AsyncMock(return_value=None)),
        ):
            beats: list = []
            first = ActivityEnvironment()
            first.on_heartbeat = lambda *beat: beats.append(beat)
            with contextlib.suppress(Exception):
                await asyncio.wait_for(first.run(service.spawn_claude_code_activity, *_cc_activity_args()), timeout=15)
            assert recorder.closed == [], f"a retryable error must not close the live sandbox: {recorder.closed}"
            assert "Task Failed" not in recorder.titles, f"a retried error is not a failure: {recorder.titles}"
            assert beats and _carries_session(beats[-1]), "the retry must find the live session in the heartbeat"

            sandbox.release("continue")
            sandbox.release("exit")
            retry = ActivityEnvironment()
            retry.info = dataclasses.replace(retry.info, attempt=2, heartbeat_details=list(beats[-1][1:]))
            outcome = await asyncio.wait_for(
                retry.run(service.spawn_claude_code_activity, *_cc_activity_args()), timeout=30
            )
        assert len(recorder.created) == 1, f"the retry must reattach, not create: {recorder.created}"
        assert outcome["status"] == "completed" and outcome["task_id"] == "cc-task-1", outcome
        assert [call["task_id"] for call in recorder.closed] == ["cc-task-1"], recorder.closed

        # The error that ends the run still reports failure and closes the sandbox.
        final_recorder = _CCBoundaryRecorder(ws_url="ws://unused")
        spent = {"code_agent_errors": config.CODE_AGENT_ERROR_RETRY_LIMIT - 1}
        last = ActivityEnvironment()
        last.info = dataclasses.replace(last.info, attempt=9, heartbeat_details=[spent])

        async def socket_lost(**kwargs):
            raise Exception("WebSocket connection to Claude Code sandbox lost after all reconnect attempts")

        with final_recorder.patched(), patch.object(service, "_run_agentic_loop", side_effect=socket_lost):
            try:
                await asyncio.wait_for(last.run(service.spawn_claude_code_activity, *_cc_activity_args()), timeout=10)
            except Exception as error:
                assert _activity_error_is_final(error), f"the last budgeted error must be final: {error!r}"
            else:
                raise AssertionError("the lost socket must raise")
        assert "Task Failed" in final_recorder.titles, final_recorder.titles
        assert [call.get("reason") for call in final_recorder.closed] == ["failure"], final_recorder.closed
    finally:
        sandbox.stop()


async def test_run_agentic_loop_long_run_writes_no_repeated_status_rows():
    """A multi-day run must not add a lifecycle row (or a summary line) per 30s.

    The loop wrote a "Claude Code working (Ns)" TOOL row every 30 seconds
    (~2,880 rows/day per session) under the spawn's toolCallId, and appended
    "Status update at Ns" to the action summary. Each row is a lifecycle write
    that scans every row of the tool call under its lock, so by day 2-3 the
    writes, including the final task_complete, time out; and the parent's
    "last 10 actions" became ten status lines. Elapsed time is derivable from
    started_at: a status row is only written when the reported progress
    (interactions, completed turns) changes.
    """
    import asyncio as aio

    from domains.spawn_claude_code_agent import service

    class LongBash(_FakeWsClient):
        async def listen(self):
            await self.on_output("working", True)
            await self.on_event({"version": 1, "provider": "claude", "type": "tool_use", "name": "Bash"})
            await aio.sleep(1.5)
            await self.on_exit(0)
            await aio.Event().wait()

    clock = {"now": 1_000_000.0}

    def fake_time() -> float:
        # Each read advances 60s: 1.5s of real loop time spans hours of run time.
        clock["now"] += 60.0
        return clock["now"]

    rows: list[dict] = []

    async def record_row(**kwargs):
        rows.append(kwargs)

    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    summary: list[str] = []
    with (
        patch.object(service, "ClaudeCodeWsClient", LongBash),
        patch.object(service, "safe_time", fake_time),
        patch.object(service, "save_claude_code_message", side_effect=record_row),
        patch.object(service, "save_code_transcript_batch", AsyncMock(return_value=True)),
        patch.object(service, "keepalive_e2b_session", AsyncMock(return_value=None)),
        patch("temporalio.activity.heartbeat"),
    ):
        exit_code, *_ = await service._run_agentic_loop(**_loop_kwargs(summary, loop_outcome={}))
    teardown_mock()

    simulated_s = clock["now"] - 1_000_000.0
    assert exit_code == 0, (exit_code, summary)
    assert simulated_s > 3600, f"the run must span hours of loop time, spanned {simulated_s:.0f}s"
    status_rows = [row for row in rows if row.get("action_type") == "agent_observation"]
    assert len(status_rows) <= 1, (
        f"{len(status_rows)} status rows over {simulated_s:.0f}s with no progress change: "
        f"{[row.get('title') for row in status_rows[:3]]}"
    )
    status_lines = [line for line in summary if line.startswith("Status update at")]
    assert status_lines == [], f"the parent's action summary filled with {len(status_lines)} status lines"


async def test_run_agentic_loop_codex_status_rows_follow_completed_turns():
    """Codex status rows track completed turns, never the 30s clock.

    For Codex the "working" row reports ``completed_turns`` (the chip's turn
    counter), so it is written once per completed-turn increase with
    ``Completed turns: N`` and never while the count is unchanged, however long
    the run; the parent's action summary gets no "Status update at" lines.
    """
    import asyncio as aio

    from domains.spawn_claude_code_agent import service

    def completed(turn_id: str) -> dict:
        return {"version": 1, "provider": "codex", "type": "turn", "status": "completed", "turn_id": turn_id}

    phases: list[int] = []

    class LongCodexRun(_FakeWsClient):
        async def listen(self):
            await self.on_output("working", True)
            await self.on_event({"version": 1, "provider": "codex", "type": "tool_use", "name": "shell"})
            phases.append(len(rows))
            await aio.sleep(0.6)
            phases.append(len(rows))
            await self.on_event(completed("turn-1"))
            await aio.sleep(0.6)
            phases.append(len(rows))
            await self.on_event(completed("turn-2"))
            await aio.sleep(0.6)
            phases.append(len(rows))
            await self.on_exit(0)
            await aio.Event().wait()

    clock = {"now": 1_000_000.0}

    def fake_time() -> float:
        # Each read advances 60s: each 0.6s phase spans many 30s status windows.
        clock["now"] += 60.0
        return clock["now"]

    rows: list[dict] = []

    async def record_row(**kwargs):
        if kwargs.get("action_type") == "agent_observation":
            rows.append(kwargs)

    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    summary: list[str] = []
    with (
        patch.object(service, "ClaudeCodeWsClient", LongCodexRun),
        patch.object(service, "safe_time", fake_time),
        patch.object(service, "save_claude_code_message", side_effect=record_row),
        patch.object(service, "save_code_transcript_batch", AsyncMock(return_value=True)),
        patch.object(service, "keepalive_e2b_session", AsyncMock(return_value=None)),
        patch("temporalio.activity.heartbeat"),
    ):
        exit_code, *_ = await service._run_agentic_loop(
            **_loop_kwargs(summary, loop_outcome={}, code_provider="codex")
        )
    teardown_mock()

    simulated_s = clock["now"] - 1_000_000.0
    assert exit_code == 0, (exit_code, summary)
    assert simulated_s > 3600, f"the run must span hours of loop time, spanned {simulated_s:.0f}s"
    assert phases[1] == 0, f"{phases[1]} status rows while no Codex turn had completed: {rows[:3]}"
    assert [row.get("message") for row in rows] == ["Completed turns: 1", "Completed turns: 2"], (
        f"expected one row per completed-turn increase, got {[row.get('message') for row in rows[:5]]} "
        f"({len(rows)} rows, counts per phase {phases})"
    )
    assert [row.get("completed_turns") for row in rows] == [1, 2], rows
    status_lines = [line for line in summary if line.startswith("Status update at")]
    assert status_lines == [], f"the parent's action summary filled with {len(status_lines)} status lines"


def _e2b_cost(result: dict) -> float:
    return sum(
        item.get("cost_cents", 0)
        for item in result.get("usage_items") or []
        if item.get("provider") == "E2B Desktop Sandbox"
    )


async def test_claude_code_every_end_of_a_run_reports_sandbox_usage_by_size():
    """Sandbox time is billed on every way a run ends, at the sandbox's size.

    A multi-day run normally goes idle pause -> respawn, yet the idle-pause,
    usage-limit and user-cancel results carried ``usage_items: []`` (or none),
    so most E2B seconds were never recorded. The rate was a fixed 2-vCPU rate
    even for an 8-vCPU sandbox, and a run on the user's own Mac was billed as
    an E2B sandbox.
    """
    from temporalio.testing import ActivityEnvironment

    from domains.spawn_claude_code_agent import service

    clock = {"now": 1_000_000.0}

    def fake_time() -> float:
        clock["now"] += 300.0
        return clock["now"]

    def recorder_with(size, target_meta=None):
        recorder = _CCBoundaryRecorder(ws_url="ws://unused")
        create = recorder.create_session

        async def sized_create(**kwargs):
            session = await create(**kwargs)
            return {**session, "sandbox_size": size} if size else session

        recorder.create_session = sized_create
        return recorder

    async def idle_loop(**kwargs):
        kwargs["loop_outcome"]["idle_paused"] = True
        kwargs["loop_outcome"]["idle_s"] = 600
        return (-1, False, [], 0, 0, [])

    async def run(size, loop, env=None):
        recorder = recorder_with(size)
        env = env or ActivityEnvironment()
        with (
            recorder.patched(),
            patch.object(service, "safe_time", fake_time),
            patch.object(service, "_run_agentic_loop", side_effect=loop),
            patch.object(service, "fetch_code_credential_availability", AsyncMock(return_value=None)),
        ):
            return await asyncio.wait_for(env.run(service.spawn_claude_code_activity, *_cc_activity_args()), 10)

    small = await run({"cpu": 2, "memory_gb": 4}, idle_loop)
    assert small["status"] == service.CODE_AGENT_PAUSED_STATUS, small["status"]
    assert _e2b_cost(small) > 0, f"an idle-paused run must bill its sandbox time: {small.get('usage_items')}"

    large = await run({"cpu": 8, "memory_gb": 16}, idle_loop)
    ratio = _e2b_cost(large) / _e2b_cost(small)
    seconds_ratio = large["execution_time_ms"] / small["execution_time_ms"]
    assert abs(ratio / seconds_ratio - 4) < 0.01, f"an 8-vCPU sandbox must cost 4x a 2-vCPU one per second, got {ratio}"

    cancel_env = ActivityEnvironment()

    async def user_cancel(**kwargs):
        cancel_env.cancel()
        await asyncio.sleep(30)

    cancelled = await run({"cpu": 2, "memory_gb": 4}, user_cancel, cancel_env)
    assert cancelled["status"] == "cancelled", cancelled
    assert _e2b_cost(cancelled) > 0, f"a user-cancelled run must bill its sandbox time: {cancelled}"


async def test_cc_execute_tool_cancelled_run_tracks_its_sandbox_usage():
    """A paused/cancelled code agent's sandbox time reaches the workflow's cost ledger.

    The cancel branch returned before the usage block, so a user pause never
    billed the sandbox seconds the activity reported.
    """
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager

    handle = _FakeActivityHandle(
        result={
            "status": "cancelled",
            "message": "cancelled",
            "task_id": "task-cancel-usage",
            "code_provider": "claude",
            "usage_items": [{"type": "service", "cost_cents": 12.5, "provider": "E2B Desktop Sandbox"}],
        }
    )
    fake = _FakeCCWorkflow(handle)
    restore = _patch_cc_workflow(fake)
    try:
        events = await _collect_cc_events(
            SpawnClaudeCodeAgentManager().execute_tool(_FakeCCWorkflowInstance(), {"goal": "g"}, "tc-cancel-usage")
        )
    finally:
        restore()
    row = _paused_row(events)
    usage = (row.data or {}).get("usage") or {}
    assert usage.get("service") == [{"cost_cents": 12.5, "provider": "E2B Desktop Sandbox"}], row.data


async def test_native_codex_terminal_event_finishes_idle_app_server():
    """The live app-server turn/completed shape is terminal even while stdio stays open."""
    from domains.spawn_claude_code_agent import service

    for outcome, expected_code in (("completed", 0), ("failed", 1), ("interrupted", 1)):
        class NativeTerminal(_FakeWsClient):
            async def listen(self):
                await self.on_event({"version": 1, "provider": "codex", "type": "turn_started", "turn_id": "game-turn"})
                terminal = {"version": 1, "provider": "codex", "type": "turn_ended", "raw_type": "turn/completed", "turn_id": "game-turn", "status": outcome, "turn_outcome": outcome, "timestamp": "2026-10-21T00:05:19.295Z"}
                await self.on_event(terminal)
                await self.on_event({**terminal, "type": "final", "exit_code": expected_code})
                await asyncio.Event().wait()

        setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
        with (
            patch.object(service, "ClaudeCodeWsClient", NativeTerminal),
            patch.object(service, "save_code_transcript_batch", AsyncMock(return_value=True)),
            patch("temporalio.activity.heartbeat"),
        ):
            result = await asyncio.wait_for(service._run_agentic_loop(**_loop_kwargs([], code_provider="codex")), timeout=1.0)
        assert result[0] == expected_code, (outcome, result[0])
        assert service.codex_completed_turn_count(result[-1]) == (1 if outcome == "completed" else 0)
        teardown_mock()


async def test_native_codex_terminal_respects_hold_and_newer_active_turn():
    """A held session or a later native turn must outlive an earlier completion."""
    from domains.spawn_claude_code_agent import service

    for guard in ("held", "newer_turn"):
        released = False
        class NativeWithMoreWork(_FakeWsClient):
            async def listen(self):
                nonlocal released
                if guard == "held":
                    await self.on_event({"provider": "codex", "type": "direct_chat", "status": "held"})
                await self.on_event({"provider": "codex", "type": "turn_ended", "raw_type": "turn/completed", "turn_id": "first", "status": "completed", "turn_outcome": "completed"})
                if guard == "newer_turn":
                    await self.on_event({"provider": "codex", "type": "turn_started", "turn_id": "second"})
                    await self.on_event({"provider": "codex", "type": "user_turn", "turn_id": "second", "text": "continue"})
                await asyncio.sleep(0.2)
                released = True
                if guard == "held":
                    await self.on_event({"provider": "codex", "type": "direct_chat", "status": "released"})
                else:
                    await self.on_event({"provider": "codex", "type": "turn_ended", "raw_type": "turn/completed", "turn_id": "second", "status": "completed", "turn_outcome": "completed"})
                await asyncio.Event().wait()
        setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
        with (
            patch.object(service, "ClaudeCodeWsClient", NativeWithMoreWork),
            patch.object(service, "save_code_transcript_batch", AsyncMock(return_value=True)),
            patch("temporalio.activity.heartbeat"),
        ):
            result = await asyncio.wait_for(service._run_agentic_loop(**_loop_kwargs([], code_provider="codex")), timeout=1.0)
        assert released and result[0] == 0, (guard, released, result[0])
        teardown_mock()


def _process_session_stream(task, *, provider="claude", filler_events=0, forbidden_write=False):
    """Native SDK stream for a real Process Bench fixture session.

    Claude codec shapes captured from process-meeting-scheduling r001-j0015
    (agent 4fc14e8a, task f67005e9, 333 raw events): every narrated message
    streams cumulative ``agent_message`` snapshots keyed by ``item_id`` before
    its final block, and every Bash call streams a partial ``tool_use`` block
    start (empty input) before the assistant envelope with the same
    ``tool_use_id``. Codex shapes are e2b-templates/codex-code/ws-server.mjs:
    agent_message deltas, then ``item/started`` (``partial: true``) and
    ``item/completed`` events sharing the item's ``item_id``.
    """
    import hashlib
    import importlib.util
    import shlex

    from benchmarks.process_bench import ASSETS, FIXTURE_PATH

    module_spec = importlib.util.spec_from_file_location("process_fixture", ASSETS / "process-fixture.py")
    fixture_module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(fixture_module)
    fixture_path = ASSETS / "process-fixtures.json"
    fingerprint = hashlib.sha256(fixture_path.read_bytes()).hexdigest()
    spec = task.process_spec
    outcomes = json.loads(fixture_path.read_text())[spec["case"]]
    samples = json.loads(
        (Path(__file__).resolve().parents[2] / "benchmarks/fixtures/process-positive-inputs.json").read_text()
    )
    events: list[dict] = [{"provider": provider, "type": "session", "status": "starting"}]
    events += [{"provider": provider, "type": "cli_message", "text": f"hook {i}"} for i in range(filler_events)]

    def narrate(item_id, text, snapshots):
        for size in range(1, snapshots + 1):
            prefix = text[: max(1, len(text) * size // (snapshots + 1))]
            events.append({"provider": provider, "type": "agent_message", "item_id": item_id, "text": prefix, "partial": True})
        completed = {"status": "completed"} if provider == "codex" else {}
        events.append({"provider": provider, "type": "agent_message", "item_id": item_id, "text": text, "partial": False, **completed})

    def bash(tool_use_id, tool_input, stdout, tool="Bash"):
        if provider == "codex":
            item = {"provider": "codex", "item_id": tool_use_id}
            if tool == "Write":
                change = {"type": "file_change", "tool_kind": "file", "changes": [{"path": tool_input["file_path"]}]}
                events.append({**item, **change, "status": "started", "partial": True})
                events.append({**item, **change, "status": "completed", "partial": False})
                return
            command = shlex.join(["/bin/bash", "-lc", tool_input["command"]])
            shell = {"type": "command", "tool_kind": "shell", "command": command}
            events.append({**item, **shell, "status": "started", "partial": True, "output": "", "exit_code": None})
            events.append({"provider": "codex", "type": "usage", "usage_scope": "turn", "output_tokens": 10})
            events.append({**item, **shell, "status": "completed", "partial": False, "output": stdout, "exit_code": 0})
            return
        events.append({"provider": "claude", "type": "tool_use", "tool": tool, "tool_use_id": tool_use_id, "input": {}, "partial": True})
        events.append({"provider": "claude", "type": "tool_use", "tool": tool, "tool_use_id": tool_use_id, "input": tool_input})
        events.append({"provider": "claude", "type": "usage", "usage_scope": "turn", "output_tokens": 10})
        events.append({"provider": "claude", "type": "tool_result", "tool_use_id": tool_use_id, "is_error": False,
                       "tool_use_result": {"stdout": stdout, "stderr": "", "interrupted": False}})

    if forbidden_write:
        bash("toolu_forbidden", {"file_path": FIXTURE_PATH, "content": "print('ok')"}, "", tool="Write")
    with tempfile.TemporaryDirectory() as directory:
        for index, step in enumerate(spec["steps"]):
            condition = step.get("when")
            if condition:
                source = next(s for s in spec["steps"] if s["id"] == condition["step"])
                if outcomes[source["action"]][condition["field"]] != condition["equals"]:
                    continue
            data = {
                key: (samples[spec["case"]][step["id"]][key] if values == ["*"] else values[0])
                for key, values in step["inputs"].items()
            }
            args = [spec["case"], step["action"], step["actor"], step["entity"], str(step["day"]), json.dumps(data), fingerprint]
            receipt = fixture_module.execute(*args, fixture_path=fixture_path, output_dir=Path(directory))
            narrate(f"msg_{index}:1", f"Next I am running {step['action']} for {step['entity']}.", 10)
            bash(f"toolu_{index}", {"command": shlex.join(["python3", FIXTURE_PATH, *args])}, json.dumps(receipt))
    narrate("msg_final:1", "The process is complete; every step returned its fixture receipt. " * 4, 205)
    events += [{"provider": provider, "type": "result", "status": "completed"},
               {"provider": provider, "type": "turn_ended"}, {"provider": provider, "type": "final", "status": "completed"}]
    return events


async def _persisted_judge_evidence_rows(code_events, provider="claude"):
    """Run the real producer and repo; return the TOOL rows the backend received."""
    from domains.spawn_claude_code_agent import service

    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    try:
        await service._persist_code_agent_judge_evidence(
            agent_id="root", task_id="code-session-1", code_provider=provider,
            code_events=code_events, output_files=[], action_summary=["ran the process"],
        )
        rows = []
        for call in get_captured_requests():
            if call.get("method") == "POST" and "/api/agents/root/messages" in (call.get("url") or ""):
                body = json.loads(call["requestBody"])
                if (body.get("metadata") or {}).get("toolName") == "code_agent_sdk_events":
                    rows.append({"role": body["role"], "message": body["message"], "metadata": body["metadata"]})
        return rows
    finally:
        teardown_mock()


async def test_judge_evidence_of_streamed_claude_session_satisfies_native_process_trace():
    """H-18 (descend 2026-11-06): a streamed session's judge evidence is complete and counted.

    Observed: process-meeting-scheduling r001-j0015 persisted 84 events with
    steps_taken=333 (raw events incl. superseded agent_message snapshots), and
    the partial tool_use block starts duplicated every native tool identity;
    sessions over 200 retained events were cut to their last 200. Every
    process-* task failed process-native-trace "missing/truncated SDK evidence count".
    The same collapse dropped every Codex ``command`` start (``partial: true``,
    same ``item_id`` as its completion): "missing native command start".
    """
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.process_bench import check_process_trace
    from domains.spawn_claude_code_agent import service

    task = get_task_by_name("process-meeting-scheduling")

    def trace(rows):
        return {"agent": {"agent_id": "root"}, "messages": rows, "_benchmark": {}}

    def row_events(rows):
        return [e for r in rows for e in json.loads(r["message"].split("\n\n", 1)[1])["code_agent_events"]]

    for provider in ("claude", "codex"):
        # Model-visible context (parent tool result / verifier): one tool_use per
        # Claude call, and Codex item starts collapsed into their completions as
        # before; the judge evidence alone keeps the Codex starts.
        stream = _process_session_stream(task, provider=provider)
        context = json.loads(service._build_code_event_context(code_events=stream, output_files=[], action_summary=[]))
        tool_ids = [e["tool_use_id"] for e in context["code_agent_events"] if e.get("type") == "tool_use"]
        assert len(tool_ids) == len(set(tool_ids)), (provider, tool_ids)
        assert not any(e.get("status") == "started" for e in context["code_agent_events"]), provider
        judged = row_events(await _persisted_judge_evidence_rows(stream, provider))
        commands = [e.get("status") for e in judged if e.get("type") == "command"]
        if provider == "codex":
            assert commands and commands.count("started") == commands.count("completed"), commands
        else:
            assert not commands, commands

        # The j0015 shape: well under any page bound once superseded snapshots go.
        rows = await _persisted_judge_evidence_rows(_process_session_stream(task, provider=provider), provider)
        passed, reason = check_process_trace(task.process_spec, trace(rows))
        assert passed, (provider, reason)

        # A long session keeps every retained event, so nothing is cut from its head.
        long_stream = _process_session_stream(task, provider=provider, filler_events=450)
        rows = await _persisted_judge_evidence_rows(long_stream, provider)
        passed, reason = check_process_trace(task.process_spec, trace(rows))
        assert passed, (provider, reason)
        assert len(rows) > 1, "the long session must span more than one bounded evidence row"
        assert all(len(json.loads(r["message"].split("\n\n", 1)[1])["code_agent_events"]) <= 200 for r in rows)
        # A missing evidence row is still detected as truncated evidence.
        passed, reason = check_process_trace(task.process_spec, trace(rows[1:]))
        assert not passed and "truncated SDK evidence count" in reason, (provider, reason)

        # A forbidden fixture edit at the head of a long session stays visible.
        rows = await _persisted_judge_evidence_rows(
            _process_session_stream(task, provider=provider, filler_events=450, forbidden_write=True), provider
        )
        passed, reason = check_process_trace(task.process_spec, trace(rows))
        assert not passed and "protected fixture was modified" in reason, (provider, reason)


def test_native_codex_usage_retains_session_scope():
    from domains.spawn_claude_code_agent import service
    logger = MagicMock()
    with patch.object(service, "logger", logger):
        service._log_code_agent_event({"provider": "codex", "type": "usage", "usage_scope": "session", "usage": {"input_tokens": 200, "output_tokens": 50, "cached_input_tokens": 150}}, agent_id="agent", task_id="task", sandbox_id="sandbox")
    assert logger.info.call_args.kwargs["usage_scope"] == "session"
    assert logger.info.call_args.kwargs["output_tokens"] == 50


if __name__ == "__main__":
    asyncio.run(run_all_tests())
