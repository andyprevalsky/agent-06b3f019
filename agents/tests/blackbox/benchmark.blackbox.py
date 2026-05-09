"""Blackbox tests for benchmark helpers."""

from _test_utils import BlackboxResult


def test_extract_worker_pids_from_ps_matches_macos_python_executable():
    """Worker detection matches macOS venv processes named Python."""
    from benchmarks.run_benchmark import _extract_worker_pids_from_ps

    ps_output = """
      111 /Users/me/project/agents/venv/bin/Python worker.py
      222 /usr/bin/python3 other.py
      333 node server.js
    """

    assert _extract_worker_pids_from_ps(ps_output) == ["111"]


def test_extract_worker_pids_from_ps_matches_lowercase_python():
    """Worker detection still matches the common python worker.py command."""
    from benchmarks.run_benchmark import _extract_worker_pids_from_ps

    ps_output = """
      444 python worker.py
      555 /usr/bin/python3 -m pytest
    """

    assert _extract_worker_pids_from_ps(ps_output) == ["444"]


def test_extract_worker_pids_from_ps_filters_to_workspace_root():
    """Local smoke memory sampling ignores workers from other workspaces."""
    from benchmarks.run_benchmark import _extract_worker_pids_from_ps

    ps_output = """
      111 /Users/me/workspaces/current/agents/venv/bin/python worker.py
      222 /Users/me/workspaces/other/agents/venv/bin/python worker.py
      333 python worker.py
    """

    assert _extract_worker_pids_from_ps(ps_output, "/Users/me/workspaces/current") == ["111"]


def test_process_cwd_is_under_accepts_nested_paths():
    """Worker memory filtering can match short ps commands via process cwd."""
    from pathlib import Path
    from benchmarks.run_benchmark import _process_cwd_is_under

    class Proc:
        def cwd(self):
            return "/Users/me/workspaces/current/agents"

    assert _process_cwd_is_under(Proc(), Path("/Users/me/workspaces/current/agents")) is True
    assert _process_cwd_is_under(Proc(), Path("/Users/me/workspaces/other/agents")) is False


def test_ci_should_fail_on_skipped_required_task():
    """CI treats skipped benchmark tasks as blocking failures."""
    from benchmarks.run_benchmark import _ci_should_fail

    assert _ci_should_fail({"failed": 0, "skipped": 1}) is True
    assert _ci_should_fail({"failed": 0}) is False


async def test_code_agent_preflight_accepts_gpt_compute_token():
    """Code-agent benchmarks preflight against the workflow compute-token route."""
    import benchmarks.run_benchmark as bench

    calls = []

    class FakeResponse:
        status_code = 200

        def json(self):
            return {"type": "gpt", "accessToken": "gpt-token"}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, url, *, headers, timeout):
            calls.append((url, headers, timeout))
            return FakeResponse()

    original_headers = bench._api_headers
    original_client = bench.httpx.AsyncClient
    try:
        async def fake_headers():
            return {"X-API-Key": "test-key"}

        bench._api_headers = fake_headers
        bench.httpx.AsyncClient = FakeClient

        assert await bench._check_compute_code_credentials("http://localhost:55120") is True
    finally:
        bench._api_headers = original_headers
        bench.httpx.AsyncClient = original_client

    assert calls == [
        (
            "http://localhost:55120/api/integrations/compute-code/credentials/token",
            {"X-API-Key": "test-key"},
            10.0,
        )
    ]


async def test_code_agent_preflight_rejects_missing_compute_token():
    """Code-agent benchmarks still fail fast when no compute token is available."""
    import benchmarks.run_benchmark as bench

    class FakeResponse:
        status_code = 404

        def json(self):
            return {"error": "NO_TOKENS_AVAILABLE"}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, _url, *, headers, timeout):
            return FakeResponse()

    original_headers = bench._api_headers
    original_client = bench.httpx.AsyncClient
    try:
        async def fake_headers():
            return {"X-API-Key": "test-key"}

        bench._api_headers = fake_headers
        bench.httpx.AsyncClient = FakeClient

        assert await bench._check_compute_code_credentials("http://localhost:55120") is False
    finally:
        bench._api_headers = original_headers
        bench.httpx.AsyncClient = original_client


def test_normalize_attention_requests_accepts_backend_contract():
    """Benchmark harness accepts the backend's {requests: [...]} list response."""
    from benchmarks.run_benchmark import _normalize_attention_requests_response

    req = {"id": "req-1", "question": "Approve?"}
    assert _normalize_attention_requests_response({"requests": [req]}) == [req]
    assert _normalize_attention_requests_response([req]) == [req]


def test_calendly_benchmark_passes_on_link_approval_marker():
    """Calendly task can pass before agent completion when approval has a link."""
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _contains_calendly_link, evaluate_task

    task = get_task_by_name("calendly-schedule-meeting")
    data = {
        "agent": {"status": "ACTIVE", "progress": 0},
        "messages": [],
        "_benchmark": {"calendly_link_approval_seen": True},
    }

    assert _contains_calendly_link({"question": "Send https://calendly.com/a/30-min?"}) is True
    assert evaluate_task(task, data, approvals_triggered=1) == (True, None)


def test_count_only_benchmark_passes_on_expected_approval_count():
    """count_only tasks pass when the configured number of approvals is observed."""
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import evaluate_task

    task = get_task_by_name("outreach-batch")
    data = {
        "agent": {"status": "ACTIVE", "progress": 0},
        "messages": [],
        "_benchmark": {"expected_approval_count_seen": task.expected_approval_count},
    }

    assert evaluate_task(task, data, approvals_triggered=task.expected_approval_count or 0) == (True, None)


def test_count_only_approval_context_allows_open_tool_call():
    """count_only tasks may stop while the approved tool call is still open."""
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _approval_mode_allows_open_tool_context

    task = get_task_by_name("outreach-batch")
    data = {"_benchmark": {"expected_approval_count_seen": task.expected_approval_count}}

    assert _approval_mode_allows_open_tool_context(task, data, approvals_triggered=task.expected_approval_count or 0) is True


def test_count_only_releases_observed_approvals_by_denial():
    """count_only should unblock observed approvals without approving side effects."""
    from benchmarks.run_benchmark import _count_only_release_response

    assert _count_only_release_response() == "denied"


def test_keep_failed_agents_only_preserves_failures():
    """The diagnostic flag preserves failed agents but still cleans up passes."""
    from benchmarks.run_benchmark import _should_delete_agent_after_run

    assert _should_delete_agent_after_run(passed=True, keep_failed_agents=True) is True
    assert _should_delete_agent_after_run(passed=False, keep_failed_agents=True) is False
    assert _should_delete_agent_after_run(passed=False, keep_failed_agents=False) is True


def test_local_plan_runs_load_tests_separately():
    """Local orchestrator separates load-test-sias from normal parallel batches."""
    from benchmarks.local import plan_invocations

    invocations = plan_invocations(["chat-mode", "load-test-sias", "browser-agent"])

    assert [(i.label, i.tasks, i.is_load) for i in invocations] == [
        ("non-load", ["chat-mode", "browser-agent"], False),
        ("load-test-sias", ["load-test-sias"], True),
    ]


def test_local_benchmark_args_for_multi_task_exclude_complement():
    """Multi-task local runs use one run_benchmark invocation with explicit exclusions."""
    from benchmarks.local import build_benchmark_args

    args = build_benchmark_args(
        ["chat-mode", "browser-agent"],
        port=55120,
        bootstrap=True,
        max_concurrency=5,
    )

    assert args[:2][-1] == "benchmarks/run_benchmark.py"
    assert "--suite" in args and "all" in args
    assert "--exclude-task" in args
    excluded = args[args.index("--exclude-task") + 1].split(",")
    assert "load-test-sias" in excluded
    assert "chat-mode" not in excluded
    assert "browser-agent" not in excluded
    assert args[args.index("--port") + 1] == "55120"
    assert "--bootstrap" in args
    assert "--keep-failed-agents" in args
    assert args[args.index("--max-concurrency") + 1] == "5"


def test_local_benchmark_args_for_single_load_task_not_parallel():
    """A single load-test invocation is not run with --parallel."""
    from benchmarks.local import build_benchmark_args

    args = build_benchmark_args(["load-test-sias"], port=55120)

    assert args[args.index("--task") + 1] == "load-test-sias"
    assert "--parallel" not in args
    assert "--max-concurrency" not in args


def test_local_failed_tasks_from_run_reads_result_json():
    """--rerun-failed can derive failed task names from saved benchmark JSON."""
    import json
    import tempfile
    from pathlib import Path

    from benchmarks.local import failed_tasks_from_run

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "run.json"
        path.write_text(
            json.dumps(
                {
                    "tasks": [
                        {"name": "chat-mode", "passed": True, "agent_id": "a1"},
                        {
                            "name": "browser-agent",
                            "passed": False,
                            "status": "FAILED",
                            "agent_id": "b2",
                            "failure_reason": "verifier failed",
                        },
                        {"name": "claude-code-agent", "passed": False, "status": "SKIPPED", "agent_id": ""},
                    ]
                }
            )
        )

        failures = failed_tasks_from_run(path)

    assert [(f.name, f.agent_id, f.failure_reason) for f in failures] == [
        ("browser-agent", "b2", "verifier failed")
    ]


def test_local_services_manifest_validation_requires_ports():
    """Service manifest parsing fails fast when run.sh has not published required ports."""
    import json
    import tempfile
    from pathlib import Path

    from benchmarks.local import load_services_manifest

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "services.json"
        path.write_text(json.dumps({"ports": {"backend": 55120, "health": 55122}}))
        assert load_services_manifest(path)["ports"]["backend"] == 55120

        bad = Path(tmp) / "bad-services.json"
        bad.write_text(json.dumps({"ports": {"backend": 55120}}))
        try:
            load_services_manifest(bad)
        except ValueError as exc:
            assert "backend/health" in str(exc)
        else:
            raise AssertionError("expected invalid manifest to fail")


def test_local_extract_results_path_and_diagnostic_commands():
    """Local wrapper finds runner result paths and builds all three diagnostics."""
    from benchmarks.local import diagnostic_commands, extract_results_path

    output = "hello\n  Results saved: /tmp/bench.json\nbye\n"
    assert str(extract_results_path(output)) == "/tmp/bench.json"

    commands = diagnostic_commands("agent-123", port=55120)
    joined = [" ".join(command) for command in commands]
    assert any("agent_latency.py agent-123" in command for command in joined)
    assert any("agent_logs.py agent-123 --tree --diagnostics --url http://localhost:55120" in command for command in joined)
    assert any("agent_cache.py agent-123" in command for command in joined)


def test_local_parse_args_rejects_ambiguous_selection():
    """Local wrapper accepts exactly one selection mode."""
    import contextlib
    import io

    from benchmarks.local import parse_args

    try:
        with contextlib.redirect_stderr(io.StringIO()):
            parse_args(["chat-mode", "--full"])
    except SystemExit as exc:
        assert exc.code == 2
    else:
        raise AssertionError("expected ambiguous local benchmark selection to fail")


def test_local_parse_args_rejects_invalid_concurrency():
    """Local wrapper refuses invalid concurrency before starting services."""
    import contextlib
    import io

    from benchmarks.local import parse_args

    try:
        with contextlib.redirect_stderr(io.StringIO()):
            parse_args(["chat-mode", "--max-concurrency", "0"])
    except SystemExit as exc:
        assert exc.code == 2
    else:
        raise AssertionError("expected invalid concurrency to fail")


def test_local_diagnostics_timeout_is_recorded():
    """Hung diagnostics are killed and recorded instead of blocking the wrapper."""
    import sys
    import tempfile
    from pathlib import Path

    import benchmarks.local as local

    original = local.diagnostic_commands

    def slow_command(_agent_id, *, port):
        assert port == 55120
        return [[sys.executable, "-c", "import time; time.sleep(5)"]]

    try:
        local.diagnostic_commands = slow_command
        with tempfile.TemporaryDirectory() as tmp:
            result_path = Path(tmp) / "run.json"
            result_path.write_text("{}")
            diag_dir = local.run_diagnostics(
                [local.FailedTask("browser-agent", "agent-1234567890", "timeout")],
                port=55120,
                result_path=result_path,
                timeout_seconds=0.1,
            )
            assert diag_dir is not None
            output_files = list(diag_dir.glob("browser-agent_agent-123456/*.txt"))
            assert len(output_files) == 1
            assert "diagnostic timed out after 0.1 seconds" in output_files[0].read_text()
    finally:
        local.diagnostic_commands = original


def test_build_smoke_memory_summary_flags_growth_and_playwright_driver():
    """Smoke memory gate fails on RSS growth and leaked Playwright drivers."""
    from benchmarks.run_benchmark import _build_smoke_memory_summary

    before = {
        "available": True,
        "total_rss_mb": 300.0,
        "playwright_driver_count": 0,
        "playwright_driver_rss_mb": 0.0,
    }
    after = {
        "available": True,
        "total_rss_mb": 700.0,
        "playwright_driver_count": 1,
        "playwright_driver_rss_mb": 120.0,
    }

    summary = _build_smoke_memory_summary(before, after)

    assert summary["growth_mb"] == 400.0
    assert any("RSS grew" in f for f in summary["failures"])
    assert any("Playwright driver" in f for f in summary["failures"])


def test_build_smoke_memory_summary_passes_stable_worker():
    """Smoke memory gate passes when RSS is stable and no Playwright driver remains."""
    from benchmarks.run_benchmark import _build_smoke_memory_summary

    before = {
        "available": True,
        "total_rss_mb": 300.0,
        "playwright_driver_count": 0,
        "playwright_driver_rss_mb": 0.0,
    }
    after = {
        "available": True,
        "total_rss_mb": 350.0,
        "playwright_driver_count": 0,
        "playwright_driver_rss_mb": 0.0,
    }

    summary = _build_smoke_memory_summary(before, after)

    assert summary["growth_mb"] == 50.0
    assert summary["failures"] == []


def test_logical_tool_counts_ignore_progress_messages():
    """Tool count checks count logical calls, not emitted progress updates."""
    from benchmarks.run_benchmark import _count_logical_tool_calls_from_messages

    messages = [
        {
            "metadata": {
                "toolName": "spawn_agent",
                "toolStatus": "FINISHED",
                "toolCallId": "child-thought",
                "subAgentId": "explore-1",
            }
        },
        {
            "metadata": {
                "toolName": "spawn_agent",
                "toolStatus": "FINISHED",
                "toolCallId": "root-explore",
            }
        },
        {
            "metadata": {
                "toolName": "spawn_sub_agent",
                "toolStatus": "FINISHED",
                "toolCallId": "sub-1",
                "subAgentId": "agent-1",
            }
        },
        {
            "metadata": {
                "toolName": "spawn_sub_agent",
                "toolStatus": "FINISHED",
                "toolCallId": "sub-1",
            }
        },
        {
            "metadata": {
                "toolName": "spawn_browser_agent",
                "toolStatus": "FINISHED",
                "toolCallId": "browser-1",
                "action_type": "goto",
            }
        },
        {
            "metadata": {
                "toolName": "spawn_browser_agent",
                "toolStatus": "FINISHED",
                "toolCallId": "browser-1",
                "action_type": "task_complete",
            }
        },
        {
            "metadata": {
                "toolName": "spawn_claude_code_agent",
                "toolStatus": "FINISHED",
                "toolCallId": "code-1",
                "action_type": "agent_observation",
                "subAgentId": "code-task",
            }
        },
        {
            "metadata": {
                "toolName": "spawn_claude_code_agent",
                "toolStatus": "FINISHED",
                "toolCallId": "code-1",
                "action_type": "task_complete",
            }
        },
        {
            "metadata": {
                "toolName": "message_person",
                "toolStatus": "IN_PROGRESS",
                "toolCallId": "msg-1",
            }
        },
        {
            "metadata": {
                "toolName": "message_person",
                "toolStatus": "IN_PROGRESS",
                "toolCallId": "msg-1",
            }
        },
        {
            "metadata": {
                "toolName": "message_person",
                "toolStatus": "FINISHED",
                "toolCallId": "msg-1",
            }
        },
    ]

    assert _count_logical_tool_calls_from_messages(messages) == {
        "spawn_agent": 1,
        "spawn_sub_agent": 1,
        "spawn_browser_agent": 1,
        "spawn_claude_code_agent": 1,
        "message_person": 1,
    }


async def run_all_tests():
    print("benchmark blackbox tests:")
    r = BlackboxResult()
    r.record("extract_worker_pids_macos_python", test_extract_worker_pids_from_ps_matches_macos_python_executable)
    r.record("extract_worker_pids_lowercase_python", test_extract_worker_pids_from_ps_matches_lowercase_python)
    r.record("extract_worker_pids_workspace_filter", test_extract_worker_pids_from_ps_filters_to_workspace_root)
    r.record("process_cwd_workspace_filter", test_process_cwd_is_under_accepts_nested_paths)
    r.record("ci_fails_on_skipped", test_ci_should_fail_on_skipped_required_task)
    await r.record_async("code_agent_preflight_accepts_gpt_compute", test_code_agent_preflight_accepts_gpt_compute_token)
    await r.record_async("code_agent_preflight_rejects_missing_compute", test_code_agent_preflight_rejects_missing_compute_token)
    r.record("normalize_attention_requests", test_normalize_attention_requests_accepts_backend_contract)
    r.record("calendly_passes_on_link_approval", test_calendly_benchmark_passes_on_link_approval_marker)
    r.record("count_only_passes_on_approval_count", test_count_only_benchmark_passes_on_expected_approval_count)
    r.record("count_only_allows_open_tool_context", test_count_only_approval_context_allows_open_tool_call)
    r.record("count_only_releases_by_denial", test_count_only_releases_observed_approvals_by_denial)
    r.record("keep_failed_agents_cleanup_policy", test_keep_failed_agents_only_preserves_failures)
    r.record("local_plan_load_separate", test_local_plan_runs_load_tests_separately)
    r.record("local_args_multi_exclude", test_local_benchmark_args_for_multi_task_exclude_complement)
    r.record("local_args_single_load", test_local_benchmark_args_for_single_load_task_not_parallel)
    r.record("local_failed_tasks_from_run", test_local_failed_tasks_from_run_reads_result_json)
    r.record("local_services_manifest_validation", test_local_services_manifest_validation_requires_ports)
    r.record("local_results_and_diagnostics", test_local_extract_results_path_and_diagnostic_commands)
    r.record("local_parse_args_rejects_ambiguous_selection", test_local_parse_args_rejects_ambiguous_selection)
    r.record("local_parse_args_rejects_invalid_concurrency", test_local_parse_args_rejects_invalid_concurrency)
    r.record("local_diagnostics_timeout_recorded", test_local_diagnostics_timeout_is_recorded)
    r.record("smoke_memory_summary_flags_leak", test_build_smoke_memory_summary_flags_growth_and_playwright_driver)
    r.record("smoke_memory_summary_passes", test_build_smoke_memory_summary_passes_stable_worker)
    r.record("logical_tool_counts_ignore_progress", test_logical_tool_counts_ignore_progress_messages)
    return r.all_passed
