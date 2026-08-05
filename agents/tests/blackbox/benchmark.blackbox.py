"""Blackbox tests for benchmark helpers."""

import asyncio
import hashlib
import json
import importlib.util
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch
import time

from _test_utils import BlackboxResult


def test_every_benchmark_run_registers_in_app_hub_before_execution():
    """The Mac-app Hub is a fail-closed launch invariant, not best-effort save telemetry."""
    from benchmarks.hub_upload import HubVisibilityError, require_run_visible

    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            requests.append(("POST", self.path, body))
            payload = json.dumps({"run": {"run_id": body["run_id"]}}).encode()
            self.send_response(201)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            requests.append(("GET", self.path, None))
            run_id = self.path.rsplit("/", 1)[-1]
            payload = json.dumps({"run": {"run_id": run_id, "live": True}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    prior = {name: os.environ.get(name) for name in ("BENCHMARK_HUB_UPLOAD_URL", "BENCHMARK_HUB_API_KEY")}
    try:
        os.environ["BENCHMARK_HUB_UPLOAD_URL"] = f"http://127.0.0.1:{server.server_address[1]}"
        os.environ["BENCHMARK_HUB_API_KEY"] = "blackbox-key"
        bundle = {
            "run_id": "blackbox-visible-run",
            "suite": "blackbox",
            "tasks": [{"name": "task-a", "status": "starting"}],
        }
        require_run_visible(bundle, timeout=1)
        assert requests[0][0:2] == ("POST", "/api/benchmarks/runs?live=1")
        assert requests[1][0:2] == (
            "GET",
            "/api/benchmarks/runs/blackbox-visible-run",
        )

        os.environ["BENCHMARK_HUB_UPLOAD_URL"] = "http://127.0.0.1:1"
        try:
            require_run_visible(bundle, timeout=0.1)
            raise AssertionError("an invisible run was allowed to execute")
        except HubVisibilityError:
            pass
    finally:
        server.shutdown()
        server.server_close()
        for name, value in prior.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value

    repo_root = Path(__file__).resolve().parents[3]
    runner = (repo_root / "agents/benchmarks/run_benchmark.py").read_text()
    fleet = (repo_root / "scripts/run-bench-fleet").read_text()
    poller = (repo_root / "scripts/run-bench-hub-poller").read_text()
    assert "require_run_visible" in runner
    assert "BENCHMARK_HUB_PARENT_RUN_ID" in runner
    assert "--require-visible" in fleet
    assert "BENCHMARK_HUB_PARENT_RUN_ID" in fleet
    assert 'BENCHMARK_HUB_PARENT_RUN_ID="$hub_run_id"' in poller


def _load_cloudbench_result_module():
    module_path = Path(__file__).resolve().parents[3] / "scripts" / "cloudbench_result.py"
    spec = importlib.util.spec_from_file_location("cloudbench_result", module_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _cloudbench_run(task_name: str, *, passed: bool, timestamp: str) -> dict:
    return {
        "timestamp": timestamp,
        "summary": {
            "total": 1,
            "passed": 1 if passed else 0,
            "failed": 0 if passed else 1,
            "pass_rate": 1.0 if passed else 0.0,
        },
        "tasks": [{"name": task_name, "passed": passed, "agent_id": "agent-fixture"}],
    }


def test_cloudbench_result_rejects_stale_passing_artifact_from_another_task():
    validator = _load_cloudbench_result_module()
    stale_wrong_run = _cloudbench_run(
        "spawn-sub-agents",
        passed=True,
        timestamp="2026-07-08T17:49:44+00:00",
    )

    errors = validator.validate_run_document(
        stale_wrong_run,
        ["message-person-agent-sms"],
        require_pass=True,
        not_before_epoch=1783828800,
    )

    assert any("task identity mismatch" in error for error in errors)
    assert any("predates this invocation" in error for error in errors)


def test_cloudbench_result_accepts_only_fresh_exact_passing_task_set():
    validator = _load_cloudbench_result_module()
    fresh_run = _cloudbench_run(
        "message-person-agent-sms",
        passed=True,
        timestamp="2026-07-12T04:01:00+00:00",
    )

    errors = validator.validate_run_document(
        fresh_run,
        ["message-person-agent-sms"],
        require_pass=True,
        not_before_epoch=1783828800,
    )

    assert errors == []


def test_agent_payment_output_blob_is_key_agnostic():
    """The payment confirmation is now judged semantically (SEMANTIC_OUTPUT_EXPECTATIONS['agent-payment']
    via _judge_output_recovers_expected_fields), so the blob extractor must surface the browser agent's
    populated structured output regardless of the LLM-synthesized key name — the judge maps the grounded
    tp_<8hex> id by meaning. This pins the exact regression: a genuinely-successful run emitting the id
    under `order_id` (not `order_confirmation_id`) must still reach the judge."""
    from benchmarks.run_benchmark import _extract_agent_payment_output_blob

    def blob_for(structured):
        return _extract_agent_payment_output_blob(
            {
                "messages": [
                    {
                        "role": "TOOL",
                        "metadata": {
                            "toolName": "spawn_browser_agent",
                            "toolStatus": "FINISHED",
                            "structured_response": structured,
                        },
                    }
                ]
            }
        )

    # The regression: agent emitted `order_id`, not `order_confirmation_id`.
    assert "tp_c9123127" in blob_for({"order_id": "tp_c9123127", "total_amount_paid": 43.96})
    # Legacy/alternate key names surface too.
    assert "tp_c5053b1b" in blob_for(
        {"order_confirmation_id": "tp_c5053b1b", "total_price_paid": 43.96}
    )
    # No populated browser output → empty blob (the semantic gate fails closed on empty).
    assert _extract_agent_payment_output_blob({"messages": []}) == ""


def test_cloudbench_result_preserves_fresh_failure_but_never_counts_it_as_pass():
    validator = _load_cloudbench_result_module()
    failed_run = _cloudbench_run(
        "message-person-agent-sms",
        passed=False,
        timestamp="2026-07-12T04:01:00+00:00",
    )

    assert validator.validate_run_document(failed_run, ["message-person-agent-sms"]) == []
    pass_errors = validator.validate_run_document(
        failed_run,
        ["message-person-agent-sms"],
        require_pass=True,
    )
    assert any("not all passing" in error for error in pass_errors)


def test_cloudbench_shell_controllers_require_fresh_identity_and_child_success():
    repo_root = Path(__file__).resolve().parents[3]
    driver = (repo_root / "scripts" / "cloudbench-run.sh").read_text()
    controller = (repo_root / "scripts" / "run-bench-cloud").read_text()
    fleet = (repo_root / "scripts" / "run-bench-fleet").read_text()

    assert "CURRENT_RUN_ARTIFACT_SCRIPT" in driver
    assert "RUN_OUTPUT_MARKER" in driver
    assert 'git -C "$REPO_DIR" clean -fd' in driver
    assert driver.index('rm -rf "$CONTEXT_DIR"') < driver.index("applying uploaded local workspace patch")
    assert "cloudbench-sync-prisma-client.sh" in driver
    assert 'bash "$SYNC_PRISMA_SCRIPT" "$REPO_DIR" "$APP_USER"' in driver
    assert "NEEDS_IMESSAGE_RELAY" in controller
    assert "cloudbench-imessage-relay.ts" in controller
    assert 'BENCHMARK_IMESSAGE_API_KEY="$CLOUDBENCH_API_KEY"' in controller
    assert "bridge heartbeat established" in controller
    assert "IMESSAGE_RELAY_OK" in controller
    assert ".vm.${APP}.internal" in controller
    assert "cat '$REMOTE_REPO/.context/cloudbench/run.json'" in controller
    assert "BENCH_EXIT:-1" in controller
    assert 'RUN_PASS_OK" = "1' in controller
    assert "CHILD_EXIT_CODES" in fleet
    assert "declare -A" not in fleet
    assert "scripts/cloudbench_result.py" in fleet
    assert "create-worktree-patch.sh" in fleet
    assert "create-worktree-patch.sh" in controller
    assert "remote-logs/cloudbench-driver.log" in controller
    assert "logs/worker.log" in controller


def test_cloud_fleet_controller_detaches_by_default():
    """A launcher/session death must not bypass the paid fleet's EXIT cleanup."""
    repo_root = Path(__file__).resolve().parents[3]
    fleet = (repo_root / "scripts" / "run-bench-fleet").read_text()
    detach_default = next(
        line.strip() for line in fleet.splitlines() if line.startswith("DETACH=")
    )

    assert detach_default == 'DETACH="1"', (
        f"fleet launch mode was {detach_default}; paid runs must detach by default"
    )
    assert '--wait)           DETACH="1"; WAIT_FOR_DETACHED="1"' in fleet
    assert '--foreground)     DETACH="0"' in fleet
    assert "--recover-stale-owner)" in fleet
    assert "recover_exact_stale_fleet_owner" in fleet
    assert "volume_id=%s" in fleet
    assert "Never sweep app-global unattached" in fleet
    assert fleet.index(detach_default) < fleet.index("while [ $# -gt 0 ]")
    assert fleet.index("cloudbench_detach_reexec") < fleet.index(
        "cloudbench_controller_lock_acquire"
    )


def test_cloudbench_prisma_freshness_behavior_is_in_permanent_gate():
    repo_root = Path(__file__).resolve().parents[3]
    behavioral_suite = repo_root / "agents/benchmarks/cloudbench_dependency_sync_test.py"

    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", str(behavioral_suite), "-k", "prisma_client"],
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert "2 passed" in result.stdout


def test_cloudbench_dependency_rebuild_behavior_is_in_permanent_gate():
    repo_root = Path(__file__).resolve().parents[3]
    behavioral_suite = repo_root / "agents/benchmarks/cloudbench_dependency_sync_test.py"

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-q",
            str(behavioral_suite),
            "-k",
            "central_refresh_ or refresh_deps_ or warm_deps_preflight or isolated_backend or local_predeploy_skips_wmh",
        ],
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert "14 passed" in result.stdout


def test_cloudbench_worktree_patch_includes_tracked_and_untracked_files():
    repo_root = Path(__file__).resolve().parents[3]
    patch_script = repo_root / "scripts" / "create-worktree-patch.sh"
    with tempfile.TemporaryDirectory() as raw_dir:
        fixture = Path(raw_dir)
        subprocess.run(["git", "init", "-q", str(fixture)], check=True)
        subprocess.run(["git", "-C", str(fixture), "config", "user.email", "bench@example.com"], check=True)
        subprocess.run(["git", "-C", str(fixture), "config", "user.name", "Bench Test"], check=True)
        tracked = fixture / "tracked.txt"
        tracked.write_text("before\n")
        subprocess.run(["git", "-C", str(fixture), "add", "tracked.txt"], check=True)
        subprocess.run(["git", "-C", str(fixture), "commit", "-qm", "fixture"], check=True)

        tracked.write_text("after\n")
        staged = fixture / "staged.txt"
        staged.write_text("staged\n")
        subprocess.run(["git", "-C", str(fixture), "add", "staged.txt"], check=True)
        (fixture / "untracked.txt").write_text("new\n")
        patch = subprocess.run(
            ["bash", str(patch_script), str(fixture)],
            check=True,
            capture_output=True,
        ).stdout

        subprocess.run(["git", "-C", str(fixture), "reset", "--hard", "-q", "HEAD"], check=True)
        subprocess.run(["git", "-C", str(fixture), "clean", "-fdq"], check=True)
        subprocess.run(["git", "-C", str(fixture), "apply", "-"], input=patch, check=True)

        assert tracked.read_text() == "after\n"
        assert staged.read_text() == "staged\n"
        assert (fixture / "untracked.txt").read_text() == "new\n"


def test_run_context_normalization_keeps_absolute_workspace_path_single_rooted():
    repo_root = Path(__file__).resolve().parents[3]
    helper = repo_root / "scripts" / "lib" / "run-context.sh"
    command = (
        f"source {helper!s}; "
        "normalize_run_context_dir /data/repo /data/repo/.context/cloudbench; "
        "normalize_run_context_dir /data/repo .context/local"
    )

    output = subprocess.run(["bash", "-c", command], check=True, capture_output=True, text=True).stdout.splitlines()

    assert output == [".context/cloudbench", ".context/local"]


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


def test_worker_pids_for_workspace_filters_short_macos_commands_by_cwd():
    """Queue preflight ignores same-name workers from other Conductor workspaces."""
    from pathlib import Path
    from benchmarks.run_benchmark import _worker_pids_for_workspace

    ps_output = """
      111 python worker.py
      222 python worker.py
    """

    class Proc:
        def __init__(self, pid: int):
            self.pid = pid

        def cwd(self):
            return {
                111: "/Users/me/workspaces/current/agents",
                222: "/Users/me/workspaces/other/agents",
            }[self.pid]

    assert _worker_pids_for_workspace(ps_output, Path("/Users/me/workspaces/current"), Proc) == ["111"]


def test_benchmark_context_path_treats_root_context_as_repo_local():
    """A leading slash in /.context must not escape the repository root."""
    import os
    from benchmarks import run_benchmark

    previous = os.environ.get("BENCHMARK_CONTEXT_DIR")
    os.environ["BENCHMARK_CONTEXT_DIR"] = "/.context"
    try:
        assert run_benchmark._benchmark_context_path() == run_benchmark.REPO_ROOT / ".context"
    finally:
        if previous is None:
            os.environ.pop("BENCHMARK_CONTEXT_DIR", None)
        else:
            os.environ["BENCHMARK_CONTEXT_DIR"] = previous


def test_worker_queue_preflight_accepts_aligned_worker_among_other_local_queues():
    """Queue preflight must not require killing sibling benchmark workers."""
    import os
    from types import SimpleNamespace
    from unittest.mock import patch

    from benchmarks import run_benchmark

    queues = {
        "111": "navi-agent-tasks-other-local-run",
        "222": "navi-agent-tasks-nagoya-instagram-rerun2",
    }

    previous = os.environ.get("CONDUCTOR_WORKSPACE_NAME")
    os.environ["CONDUCTOR_WORKSPACE_NAME"] = "nagoya-instagram-rerun2"
    try:
        with patch("subprocess.run", return_value=SimpleNamespace(stdout="")):
            with patch.object(run_benchmark, "_worker_pids_for_workspace", return_value=["111", "222"]):
                with patch.object(run_benchmark, "_read_process_env_var", side_effect=lambda pid, _name: queues[pid]):
                    run_benchmark._verify_worker_queue_alignment()
    finally:
        if previous is None:
            os.environ.pop("CONDUCTOR_WORKSPACE_NAME", None)
        else:
            os.environ["CONDUCTOR_WORKSPACE_NAME"] = previous


def test_read_process_env_var_uses_portable_process_environ():
    """Queue preflight can verify env vars on macOS where /proc is unavailable."""
    from benchmarks.run_benchmark import _read_process_env_var

    class Proc:
        def __init__(self, _pid: int):
            pass

        def environ(self):
            return {"TEMPORAL_TASK_QUEUE": "navi-agent-tasks-quebec"}

    assert _read_process_env_var("111", "TEMPORAL_TASK_QUEUE", Proc) == "navi-agent-tasks-quebec"


def test_ci_should_fail_on_skipped_required_task():
    """CI treats skipped benchmark tasks as blocking failures."""
    from benchmarks.run_benchmark import _ci_should_fail

    assert _ci_should_fail({"failed": 0, "skipped": 1}) is True
    assert _ci_should_fail({"failed": 0}) is False


def test_outreach_batch_has_timeout_floor():
    """Outreach batch keeps enough time for root research before row fanout."""
    from benchmarks.benchmark_tasks import get_timeout_floor

    assert get_timeout_floor("outreach-batch") == 600
    assert get_timeout_floor("chat-mode") is None


def test_parallel_tool_calls_smoke_cap_allows_recent_fanout_tail():
    """Parallel web research smoke keeps a bounded but realistic timeout cap."""
    from benchmarks.benchmark_tasks import get_smoke_cap

    assert get_smoke_cap("parallel-tool-calls") == 600


async def test_parallel_benchmark_scheduler_overlaps_isolated_browser_profiles():
    """Per-agent browser profiles let local browser benchmarks use the full batch width."""
    from benchmarks.run_benchmark import _parallel_task_runners

    class Task:
        def __init__(self, name: str, requires_browser_agent: bool):
            self.name = name
            self.requires_browser_agent = requires_browser_agent

    active_browser_tasks = 0
    max_active_browser_tasks = 0
    two_browser_tasks_running = asyncio.Event()

    async def runner(task):
        nonlocal active_browser_tasks, max_active_browser_tasks
        if task.requires_browser_agent:
            active_browser_tasks += 1
            max_active_browser_tasks = max(max_active_browser_tasks, active_browser_tasks)
            if active_browser_tasks == 2:
                two_browser_tasks_running.set()
            try:
                await asyncio.wait_for(two_browser_tasks_running.wait(), timeout=0.05)
            except asyncio.TimeoutError:
                pass
            finally:
                active_browser_tasks -= 1
        else:
            await asyncio.sleep(0)
        return task.name

    tasks = [
        Task("browser-smoke", True),
        Task("browser-biometrics-webdecoy", True),
        Task("chat-mode", False),
    ]
    with patch.dict(os.environ, {"BENCHMARK_ISOLATED_BROWSER_PROFILES": "true"}):
        await asyncio.gather(*_parallel_task_runners(tasks, 2, runner))

    assert max_active_browser_tasks == 2, f"browser tasks did not overlap; observed concurrency={max_active_browser_tasks}"


async def test_parallel_benchmark_scheduler_serializes_shared_browser_profiles():
    """Shared/prod stacks retain one-writer protection for the user's saved profile."""
    from benchmarks.run_benchmark import _parallel_task_runners

    class Task:
        def __init__(self, name: str, requires_browser_agent: bool):
            self.name = name
            self.requires_browser_agent = requires_browser_agent

    active_browser_tasks = 0
    max_active_browser_tasks = 0

    async def runner(task):
        nonlocal active_browser_tasks, max_active_browser_tasks
        if task.requires_browser_agent:
            active_browser_tasks += 1
            max_active_browser_tasks = max(max_active_browser_tasks, active_browser_tasks)
        await asyncio.sleep(0.01)
        if task.requires_browser_agent:
            active_browser_tasks -= 1
        return task.name

    tasks = [Task("browser-smoke", True), Task("browser-biometrics-webdecoy", True)]
    with patch.dict(os.environ, {"BENCHMARK_ISOLATED_BROWSER_PROFILES": "false"}):
        await asyncio.gather(*_parallel_task_runners(tasks, 2, runner))

    assert max_active_browser_tasks == 1, (
        "shared browser profiles lost one-writer protection; "
        f"observed concurrency={max_active_browser_tasks}"
    )


def test_auth_independent_biometrics_fixture_joins_isolated_parallel_batch():
    """WebDecoy can overlap tasks that neither read nor inject saved browser auth."""
    from benchmarks import run_benchmark as bench

    class Task:
        def __init__(self, name: str, *, requires_browser_agent: bool = False, browser_auth_realm=None):
            self.name = name
            self.requires_browser_agent = requires_browser_agent
            self.browser_auth_realm = browser_auth_realm
            self.browser_profile_mode = "fresh" if name == "browser-biometrics-webdecoy" else "persistent"
            self.environment = {}

    with patch.dict(os.environ, {"BENCHMARK_ISOLATED_BROWSER_PROFILES": "true"}):
        phases = bench._parallel_task_phases(
            [
                Task("claude-code-agent"),
                Task("browser-biometrics-webdecoy", requires_browser_agent=True, browser_auth_realm="webdecoy.com"),
                Task("chat-mode"),
            ]
        )

    assert [(mode, [task.name for task in tasks]) for mode, tasks in phases] == [
        ("exclusive", []),
        ("parallel", ["claude-code-agent", "browser-biometrics-webdecoy", "chat-mode"]),
    ]


def test_biometrics_fixture_stays_exclusive_beside_shared_auth_task():
    """A saved-auth benchmark must not observe WebDecoy's temporary DB clearing."""
    from benchmarks import run_benchmark as bench

    class Task:
        def __init__(self, name: str, *, realm=None, profile_mode="persistent"):
            self.name = name
            self.requires_browser_agent = realm is not None
            self.browser_auth_realm = realm
            self.browser_profile_mode = profile_mode
            self.environment = {}

    with patch.dict(os.environ, {"BENCHMARK_ISOLATED_BROWSER_PROFILES": "true"}):
        phases = bench._parallel_task_phases(
            [
                Task("browser-biometrics-webdecoy", realm="webdecoy.com", profile_mode="fresh"),
                Task("browser-agent-amazon", realm="amazon.com"),
            ]
        )

    assert [(mode, [task.name for task in tasks]) for mode, tasks in phases] == [
        ("exclusive", ["browser-biometrics-webdecoy"]),
        ("parallel", ["browser-agent-amazon"]),
    ]


def test_response_schema_feedback_benchmark_declares_real_mid_run_message():
    """The regression benchmark must inject non-goal feedback into a live agent run."""
    from benchmarks.benchmark_tasks import get_task_by_name

    task = get_task_by_name("response-schema-non-goal-feedback")

    assert task.mid_run_feedback == {
        "after_root_message_count": 2,
        "message": "Please keep going. Keep the final prose concise and easy to scan.",
    }
    assert task.start_phase == "execute"
    assert task.runner == "agent"
    assert task.status == "ready"


def test_mid_run_feedback_schema_evaluator_requires_exact_stability():
    """Non-goal feedback passes only when schema and hidden schema context stay unchanged."""
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _validate_mid_run_feedback_schema

    task = get_task_by_name("response-schema-non-goal-feedback")
    initial_schema = {"fields": [{"name": "city_populations", "type": "list[object]", "required": True}]}
    task._mid_run_feedback_posted = True
    task._mid_run_feedback_initial_schema = initial_schema

    unchanged = {
        "agent": {"response_schema": initial_schema},
        "messages": [{"role": "USER", "text": task.mid_run_feedback["message"], "metadata": None}],
    }
    assert _validate_mid_run_feedback_schema(task, unchanged) is None

    changed = {
        "agent": {
            "response_schema": {
                "fields": [
                    {"name": "city_populations", "type": "list[object]", "required": True},
                    {"name": "concise_summary", "type": "str", "required": True},
                ]
            }
        },
        "messages": [
            {
                "role": "USER",
                "text": "generated update",
                "metadata": {"hidden": True, "isResponseSchemaUpdate": True},
            }
        ],
    }
    reason = _validate_mid_run_feedback_schema(task, changed)
    assert reason is not None
    assert "changed after non-goal feedback" in reason


def test_toast_nopa_benchmark_routes_browser_to_toast_not_generic_search():
    """Toast checkout benchmark should not rely on model-discovered DoorDash/Google routing."""
    from benchmarks.benchmark_tasks import get_task_by_name

    task = get_task_by_name("browser-toast-nopa-write-lock")

    assert "https://order.toasttab.com/online/nopafish" in task.prompt
    assert "Do not use Google, DoorDash, Uber Eats" in task.prompt
    assert task.expected_attention_kind == "payment_approval"
    assert task.expected_payment_receipt["merchant"] == "Nopa Fish (Toast - order.toasttab.com)"
    assert task.success_on_payment_card_request is True
    assert task.expected_payment_receipt["lineItems"] == [{"name": "The Rocky Sandwich", "quantity": 1}]
    assert task.expected_payment_receipt["requiredFields"] == [
        "merchant",
        "currency",
        "lineItems",
        "fees",
        "subtotalCents",
        "totalCents",
        "fingerprint",
        "userId",
        "agentId",
    ]
    assert task.expected_payment_receipt["requiredLineItemFields"] == [
        "name",
        "imageUrl",
        "productUrl",
        "rating",
        "reviewCount",
        "unitPriceCents",
        "quantity",
        "lineTotalCents",
    ]
    assert task.expected_payment_receipt["requiredFeeFields"] == ["label", "amountCents"]


def test_toast_payment_approval_requires_every_declared_receipt_field():
    """Toast cannot pass with a sparse or malformed payment approval payload."""
    from copy import deepcopy

    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _validate_payment_receipt

    task = get_task_by_name("browser-toast-nopa-write-lock")
    payload = {
        "merchant": "Nopa Fish via Toast",
        "currency": "USD",
        "lineItems": [
            {
                "name": "The Rocky Sandwich",
                "imageUrl": None,
                "productUrl": "https://toasttab.com/menu/nopafish/the-rocky-sandwich",
                "rating": "4.8 stars",
                "reviewCount": "125 reviews",
                "unitPriceCents": 2100,
                "quantity": 1,
                "lineTotalCents": 2100,
            }
        ],
        "fees": [{"label": "Taxes & Fees", "amountCents": 294}],
        "subtotalCents": 2100,
        "totalCents": 2394,
        "fingerprint": "a" * 64,
        "userId": "user-123",
        "agentId": "agent-123",
    }

    def request(value):
        return {"metadata": {"requestPaymentCard": value}}

    _, grounding_messages = _captured_toast_payment_approval()
    assert _validate_payment_receipt(task, request(payload), messages=grounding_messages) is None

    for field in task.expected_payment_receipt["requiredFields"]:
        sparse = deepcopy(payload)
        sparse.pop(field)
        reason = _validate_payment_receipt(task, request(sparse), messages=grounding_messages)
        assert reason is not None and field in reason

    for field in task.expected_payment_receipt["requiredLineItemFields"]:
        sparse = deepcopy(payload)
        sparse["lineItems"][0].pop(field)
        reason = _validate_payment_receipt(task, request(sparse), messages=grounding_messages)
        assert reason is not None and field in reason

    for field in task.expected_payment_receipt["requiredFeeFields"]:
        sparse = deepcopy(payload)
        sparse["fees"][0].pop(field)
        reason = _validate_payment_receipt(task, request(sparse), messages=grounding_messages)
        assert reason is not None and field in reason


def _captured_toast_payment_approval(
    *,
    merchant: str = "Nopa Fish via Toast",
) -> tuple[dict, list[dict]]:
    """Replay the grounded payment boundary captured from the Antibot descent."""
    browser_scope = "toast-browser-task"
    browser_session = "https://kernel.example/live/toast-session"
    receipt = {
        "merchant": merchant,
        "currency": "USD",
        "lineItems": [
            {
                "name": "The Rocky Sandwich",
                "imageUrl": "https://images.example/the-rocky-sandwich.jpg",
                "productUrl": "https://www.nopafish.com/menu?item=the-rocky-sandwich",
                "rating": "0 stars",
                "reviewCount": "0 reviews",
                "unitPriceCents": 2100,
                "quantity": 1,
                "lineTotalCents": 2100,
            }
        ],
        "fees": [{"label": "Taxes & Fees", "amountCents": 294}],
        "subtotalCents": 2100,
        "totalCents": 2394,
        "fingerprint": "a" * 64,
        "userId": "user-123",
        "agentId": "agent-123",
    }
    request = {
        "id": "toast-payment-attention",
        "agentId": "agent-123",
        "metadata": {
            "requestPaymentCard": receipt,
            "writePermission": True,
        },
    }
    messages = [
        {
            "role": "TOOL",
            "message": "",
            "metadata": {
                "toolName": "spawn_browser_agent",
                "toolStatus": "FINISHED",
                "action_type": "goto",
                "title": "Navigated → https://order.toasttab.com/online/nopafish",
                "subAgentId": browser_scope,
                "browser_url": browser_session,
            },
        },
        {
            "role": "TOOL",
            "message": "",
            "metadata": {
                "toolName": "spawn_browser_agent",
                "toolStatus": "FINISHED",
                "action_type": "request_payment_card",
                "title": "Payment card requested ($23.94)",
                "subAgentId": browser_scope,
                "browser_url": browser_session,
            },
        },
    ]
    return request, messages


def test_toast_payment_merchant_identity_accepts_grounded_connector_variant():
    """Merchant wording may vary only when its exact identity and runtime host agree."""
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _validate_payment_receipt

    task = get_task_by_name("browser-toast-nopa-write-lock")
    request, messages = _captured_toast_payment_approval()

    assert _validate_payment_receipt(task, request, messages=messages) is None


def test_toast_payment_merchant_identity_rejects_wrong_or_ungrounded_variants():
    """Semantic merchant matching must reject a wrong merchant, host, or browser flow."""
    from copy import deepcopy

    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _validate_payment_receipt

    task = get_task_by_name("browser-toast-nopa-write-lock")

    for merchant in ("Nopa Chips via Toast", "Nopa Fish via DoorDash"):
        request, messages = _captured_toast_payment_approval(merchant=merchant)
        assert _validate_payment_receipt(task, request, messages=messages) is not None

    wrong_host_request, wrong_host_messages = _captured_toast_payment_approval()
    wrong_host_messages[0]["metadata"]["title"] = "Navigated → https://order.doordash.com/nopafish"
    assert _validate_payment_receipt(task, wrong_host_request, messages=wrong_host_messages) is not None

    unobserved_request, unobserved_messages = _captured_toast_payment_approval()
    assert _validate_payment_receipt(task, unobserved_request, messages=unobserved_messages[1:]) is not None

    cross_session_request, cross_session_messages = _captured_toast_payment_approval()
    cross_session_messages[1] = deepcopy(cross_session_messages[1])
    cross_session_messages[1]["metadata"]["browser_url"] = "https://kernel.example/live/other-session"
    assert _validate_payment_receipt(task, cross_session_request, messages=cross_session_messages) is not None

    wrong_structured_request, wrong_structured_messages = _captured_toast_payment_approval(
        merchant="Nopa Fish (Toast - order.doordash.com)"
    )
    assert _validate_payment_receipt(
        task,
        wrong_structured_request,
        messages=wrong_structured_messages,
    ) is not None

    current_request, toast_messages = _captured_toast_payment_approval()
    _, doordash_messages = _captured_toast_payment_approval()
    for message in doordash_messages:
        message["metadata"]["subAgentId"] = "doordash-browser-task"
        message["metadata"]["browser_url"] = "https://kernel.example/live/doordash-session"
    doordash_messages[0]["metadata"]["title"] = "Navigated → https://order.doordash.com/nopafish"
    assert _validate_payment_receipt(
        task,
        current_request,
        messages=[*toast_messages, *doordash_messages],
    ) is not None


def test_payment_benchmark_enables_bundled_frontend_before_stack_start():
    """The ngrok payment surface must serve a bundle, not Vite's module graph."""
    import os
    from unittest.mock import patch

    from benchmarks import local

    with patch.dict(os.environ, {}, clear=False):
        os.environ.pop("BENCHMARK_BUNDLED_FRONTEND", None)
        local.configure_task_environment(["agent-payment-idempotent-abandonment"])
        assert os.environ["BENCHMARK_BUNDLED_FRONTEND"] == "true"


def test_purchase_gate_benchmarks_enable_bundled_frontend_before_stack_start():
    """Purchase-card gate benches also load the /test_payment frontend."""
    import os
    from unittest.mock import patch

    from benchmarks import local

    with patch.dict(os.environ, {}, clear=False):
        os.environ.pop("BENCHMARK_BUNDLED_FRONTEND", None)
        os.environ.pop("BENCHMARK_FRONTEND_URL", None)
        local.configure_task_environment(["gate-subscription-card-mint"])
        assert os.environ["BENCHMARK_BUNDLED_FRONTEND"] == "true"

    with patch.dict(os.environ, {}, clear=False):
        os.environ.pop("BENCHMARK_BUNDLED_FRONTEND", None)
        os.environ.pop("BENCHMARK_FRONTEND_URL", None)
        local.configure_task_environment(["gate-kyc-card-mint"])
        assert os.environ["BENCHMARK_BUNDLED_FRONTEND"] == "true"


def test_benchmark_bundled_frontend_build_has_cloud_heap_budget():
    """Cloud build hosts default near 2GB old-space, below the frontend bundle need."""
    script = (Path(__file__).resolve().parents[3] / "scripts" / "run.sh").read_text()

    assert "BENCHMARK_FRONTEND_BUILD_OLD_SPACE_MB:-3584" in script
    assert 'NODE_OPTIONS="$FRONTEND_BUILD_NODE_OPTIONS"' in script
    assert "--max-old-space-size=" in script


def test_payment_benchmark_preserves_lifecycle_stack_contract():
    """The consolidated local lane must retain the old lifecycle launcher's env."""
    import os
    from unittest.mock import patch

    from benchmarks import local

    keys = (
        "ALLOW_TEMPORAL_CLEANUP",
        "BENCHMARK_FAST_MODE_CACHE",
        "SEED_ALLOW_MISSING_GPT_CODE",
        "AGENTCARD_ONBOARDING_RETURN_URL",
    )
    with patch.dict(os.environ, {}, clear=False):
        for key in keys:
            os.environ.pop(key, None)
        local.configure_task_environment(["agent-payment-test-shop"])
        assert os.environ["ALLOW_TEMPORAL_CLEANUP"] == "true"
        assert os.environ["BENCHMARK_FAST_MODE_CACHE"] == "false"
        assert os.environ["SEED_ALLOW_MISSING_GPT_CODE"] == "1"
        assert (
            os.environ["AGENTCARD_ONBOARDING_RETURN_URL"]
            == "https://navi-j9a9.onrender.com/api/agentcard/onboarding/callback"
        )


def test_payment_benchmark_rejects_retired_agentcard_api_key(tmp_path):
    """A legacy sk_* key must fail before the expensive lifecycle stack starts."""
    import pytest

    from benchmarks import local

    env_path = tmp_path / ".env"
    env_path.write_text('AGENTCARD_API_KEY="sk_test_retired"\n')
    with pytest.raises(RuntimeError, match=r"API keys \(sk_\*\) are retired"):
        local.validate_agentcard_org_credentials(
            ["agent-payment-test-shop"],
            env={},
            env_path=env_path,
        )


def test_payment_benchmark_rejects_retired_direct_or_user_credentials(tmp_path):
    """Only explicit, non-retired organization credentials may start the gate."""
    import pytest

    from benchmarks import local

    env_path = tmp_path / ".env"
    env_path.write_text(
        'AGENTCARD_ORG_MCP_ACCESS_TOKEN="sk_test_retired"\n'
        'AGENTCARD_OAUTH_CLIENT_ID="user-client"\n'
        'AGENTCARD_OAUTH_CLIENT_SECRET="user-secret"\n'
    )
    with pytest.raises(RuntimeError, match=r"API keys \(sk_\*\) are retired"):
        local.validate_agentcard_org_credentials(
            ["agent-payment-test-shop"],
            env={},
            env_path=env_path,
        )


def test_payment_benchmark_accepts_org_client_credentials_from_dotenv(tmp_path):
    """Conductor's shared backend dotenv supplies the lifecycle OAuth client."""
    from benchmarks import local

    env_path = tmp_path / ".env"
    env_path.write_text(
        'AGENTCARD_ORG_OAUTH_CLIENT_ID="client-id"\n'
        'AGENTCARD_ORG_OAUTH_CLIENT_SECRET="acs_secret"\n'
    )
    local.validate_agentcard_org_credentials(
        ["agent-payment-test-shop"],
        env={},
        env_path=env_path,
    )


def test_isolated_benchmark_services_allow_slow_first_sync():
    """System-Postgres fallback must outlive a cold production-data sync."""
    from benchmarks import local

    timeout = local.wait_for_services.__kwdefaults__["timeout_seconds"]
    assert timeout >= 600


def test_claude_code_benchmark_forces_real_claude_provider_before_stack_start():
    """A task that requires Claude Code must not silently run through Codex."""
    import os
    from unittest.mock import patch

    from benchmarks import local

    with patch.dict(os.environ, {}, clear=False):
        os.environ.pop("ROSE_CODE_AGENT_PROVIDER", None)
        local.configure_task_environment(["claude-code-agent"])
        assert os.environ["ROSE_CODE_AGENT_PROVIDER"] == "claude"


async def test_edge_warmup_requires_explicit_research_port():
    """Retired research ports must not add a failing warmup to every local benchmark."""
    import os

    from benchmarks import run_benchmark as bench

    class UnexpectedClient:
        def __init__(self, *_args, **_kwargs):
            raise AssertionError("edge warmup must not derive the retired research port")

    previous_port = os.environ.pop("RESEARCH_PORT", None)
    original_client = bench.httpx.AsyncClient
    try:
        bench.httpx.AsyncClient = UnexpectedClient
        await bench._warmup_edge_functions("http://localhost:55100")
    finally:
        bench.httpx.AsyncClient = original_client
        if previous_port is not None:
            os.environ["RESEARCH_PORT"] = previous_port


def test_agentcard_lifecycle_bootstrap_provisions_sandbox_float():
    """The lifecycle helper provisions float without syncing unrelated browser auth."""
    helper = (Path(__file__).resolve().parents[3] / "scripts" / "run-agentcard-lifecycle-task.sh").read_text()

    assert 'if [ "$BOOTSTRAP_FLAG" = "--bootstrap" ]' in helper
    assert "scripts/setup-benchmark-payment.ts" in helper
    assert "DATABASE_URL=" in helper
    assert "export BENCHMARK_SKIP_BROWSER_AUTH_SYNC=1" in helper
    assert "unset FAST_MODE_CACHE_DATABASE_URL" in helper
    assert "export FAST_MODE_CACHE_USE_LOCAL=1" in helper


def test_payment_receipt_validation_allows_partial_live_receipts():
    """Live merchant receipts should validate stable fields without pinning tax/price drift."""
    from benchmarks.benchmark_tasks import BenchmarkTask
    from benchmarks.run_benchmark import _validate_payment_receipt

    task = BenchmarkTask(
        name="partial-receipt",
        title="Partial Receipt",
        prompt="",
        timeout_seconds=1,
        is_chat_mode=False,
        expected_tools=[],
        tags=[],
        price_limit_cents=100,
        requires_browser_agent=False,
        requires_claude_code=False,
        attachment=None,
        approval_handling="ignore",
        start_phase="execute",
        expected_payment_receipt={
            "merchant": "Nopa Fish (Toast - order.toasttab.com)",
            "currency": "USD",
            "lineItems": [{"name": "The Rocky Sandwich", "quantity": 1}],
        },
    )
    req = {
        "metadata": {
            "requestUserApproval": {
                "requestPaymentCard": {
                    "merchant": "Nopa Fish (Toast - order.toasttab.com)",
                    "currency": "USD",
                    "subtotalCents": 2100,
                    "totalCents": 2394,
                    "lineItems": [
                        {
                            "name": "The Rocky Sandwich",
                            "imageUrl": None,
                            "unitPriceCents": 2100,
                            "quantity": 1,
                            "lineTotalCents": 2100,
                        }
                    ],
                    "fees": [{"label": "Taxes & Fees", "amountCents": 294}],
                }
            }
        }
    }

    _, grounding_messages = _captured_toast_payment_approval()
    assert _validate_payment_receipt(task, req, messages=grounding_messages) is None


def test_success_on_payment_card_request_passes_before_agent_completion():
    """Checkout benchmarks can stop once a validated payment-card request is observed."""
    from benchmarks.benchmark_tasks import BenchmarkTask
    from benchmarks.run_benchmark import evaluate_task

    task = BenchmarkTask(
        name="payment-card-terminal",
        title="Payment Card Terminal",
        prompt="",
        timeout_seconds=1,
        is_chat_mode=False,
        expected_tools=[],
        tags=[],
        price_limit_cents=100,
        requires_browser_agent=False,
        requires_claude_code=False,
        attachment=None,
        approval_handling="prompt_user",
        start_phase="execute",
        expected_attention_kind="payment_approval",
        expected_payment_receipt={"lineItems": [{"name": "The Rocky Sandwich", "quantity": 1}]},
        success_on_payment_card_request=True,
    )
    data = {
        "agent": {"status": "ACTIVE", "progress": 0.01},
        "messages": [],
        "_benchmark": {"expected_payment_receipt_seen": True},
    }

    assert evaluate_task(task, data, approvals_triggered=1) == (True, None)


def test_timeout_early_fail_pauses_agent_before_payment_cleanup():
    """Timed-out prod benchmarks must stop agent work before long cleanup polling."""
    import inspect

    import benchmarks.run_benchmark as bench

    source = inspect.getsource(bench.run_single_task)
    poll_index = source.index("await poll_agent(")
    cleanup_index = source.index("ensure_payment_lifecycle_cleanup", poll_index)
    pause_index = source.index("pause_agent(base_url, agent_id)", poll_index)

    assert "_early_fail_should_pause_agent" in source[poll_index:cleanup_index]
    assert pause_index < cleanup_index
    assert bench._early_fail_should_pause_agent("Timeout after 900s (dynamic cap=900s)")
    assert bench._early_fail_should_pause_agent("Tree stalled after 240s")
    assert not bench._early_fail_should_pause_agent(None)
    assert not bench._early_fail_should_pause_agent("Expected validated payment-card request")


def test_payment_receipt_tax_rate_qualifier_preserves_exact_amount():
    """A displayed tax-rate qualifier is equivalent only when its amount is exact."""
    from benchmarks.benchmark_tasks import BenchmarkTask
    from benchmarks.run_benchmark import _validate_payment_receipt

    task = BenchmarkTask(
        name="tax-qualified-receipt",
        title="Tax Qualified Receipt",
        prompt="",
        timeout_seconds=1,
        is_chat_mode=False,
        expected_tools=[],
        tags=[],
        price_limit_cents=100,
        requires_browser_agent=False,
        requires_claude_code=False,
        attachment=None,
        approval_handling="auto_approve",
        start_phase="execute",
        expected_payment_receipt={"fees": [{"label": "Tax", "amountCents": 297}]},
    )
    request = {"metadata": {"requestPaymentCard": {"fees": [{"label": "Tax (8.25%)", "amountCents": 297}]}}}

    assert _validate_payment_receipt(task, request) is None
    request["metadata"]["requestPaymentCard"]["fees"][0]["amountCents"] = 298
    assert "expected 297, got 298" in _validate_payment_receipt(task, request)


def test_payment_lifecycle_validation_cross_checks_nested_provider_state():
    """Payment benchmarks fail when any cross-provider terminal state disagrees."""
    from benchmarks.benchmark_tasks import BenchmarkTask
    from benchmarks.run_benchmark import _validate_payment_lifecycle

    task = BenchmarkTask(
        name="payment-lifecycle",
        title="Payment Lifecycle",
        prompt="",
        timeout_seconds=1,
        is_chat_mode=False,
        expected_tools=[],
        tags=[],
        price_limit_cents=100,
        requires_browser_agent=False,
        requires_claude_code=False,
        attachment=None,
        approval_handling="auto_approve",
        start_phase="execute",
        expected_payment_lifecycle={
            "purchase": {"status": "CLEARED"},
            "stripeHold": {"status": "succeeded", "amountReceivedCents": 4396},
            "orgTransfer": {"status": "consumed", "releasedCents": 0},
            "attention": {"openKinds": []},
        },
    )
    lifecycle = {
        "purchase": {"status": "CLEARED", "id": "purchase-1"},
        "stripeHold": {"status": "succeeded", "amountReceivedCents": 4396},
        "orgTransfer": {"status": "consumed", "releasedCents": 0},
        "attention": {"openKinds": [], "resolvedKinds": []},
    }

    assert _validate_payment_lifecycle(task, {"_benchmark": {"payment_lifecycle": lifecycle}}) is None
    lifecycle["orgTransfer"]["releasedCents"] = 4396
    assert (
        _validate_payment_lifecycle(task, {"_benchmark": {"payment_lifecycle": lifecycle}})
        == "payment_lifecycle.orgTransfer.releasedCents mismatch: expected 0, got 4396"
    )


async def test_abandonment_waits_for_cron_reconciliation():
    """A delayed AgentCard release is observed through the same lifecycle endpoint cron updates."""
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _wait_for_expected_payment_lifecycle

    lifecycles = [
        {
            "purchase": {"status": "FUNDING_RECLAIM_FAILED"},
            "walletFunding": {"status": "RECLAIM_FAILED"},
        },
        {
            "purchase": {"status": "FUNDING_RECLAIM_FAILED"},
            "walletFunding": {"status": "RECLAIM_FAILED"},
        },
        get_task_by_name("agent-payment-abandonment").expected_payment_lifecycle,
    ]
    reads = 0

    async def fetch_lifecycle(_base_url: str, _agent_id: str) -> dict:
        nonlocal reads
        reads += 1
        return lifecycles.pop(0)

    result = await _wait_for_expected_payment_lifecycle(
        "http://localhost:55120",
        "agent-123",
        get_task_by_name("agent-payment-abandonment"),
        lifecycles.pop(0),
        timeout_seconds=1,
        poll_interval_seconds=0,
        fetch_lifecycle=fetch_lifecycle,
    )

    assert result["purchase"]["status"] == "VOIDED"
    assert reads == 2


async def test_abandonment_retries_a_pending_company_release():
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _wait_for_expected_payment_lifecycle

    task = get_task_by_name("agent-payment-abandonment")
    recoveries = 0

    async def recover_lifecycle(_base_url: str, _agent_id: str) -> dict:
        nonlocal recoveries
        recoveries += 1
        return task.expected_payment_lifecycle

    result = await _wait_for_expected_payment_lifecycle(
        "http://localhost:55120",
        "agent-123",
        task,
        {
            "purchase": {"status": "HELD"},
            "walletFunding": {"status": "RECLAIMING"},
        },
        timeout_seconds=1,
        poll_interval_seconds=0,
        recover_lifecycle=recover_lifecycle,
    )

    assert result["purchase"]["status"] == "VOIDED"
    assert recoveries == 1


async def test_abandonment_timeout_surfaces_the_last_durable_mismatch():
    """A bounded cleanup wait cannot report success while funding remains in flight."""
    import pytest

    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _wait_for_expected_payment_lifecycle

    lifecycle = {
        "purchase": {"status": "HELD"},
        "walletFunding": {"status": "RECLAIMING"},
    }

    with pytest.raises(
        RuntimeError,
        match=(
            "did not reach the expected terminal state before timeout: "
            "payment_lifecycle.purchase.status mismatch: expected 'VOIDED', got 'HELD'"
        ),
    ):
        await _wait_for_expected_payment_lifecycle(
            "http://localhost:55120",
            "agent-123",
            get_task_by_name("agent-payment-abandonment"),
            lifecycle,
            timeout_seconds=0,
            poll_interval_seconds=0,
        )


async def test_abandonment_waits_between_funding_reclaim_and_purchase_void():
    """The reconciler persists RECLAIMED before its refund and purchase-status updates."""
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _wait_for_expected_payment_lifecycle

    task = get_task_by_name("agent-payment-abandonment")
    reads = 0

    async def fetch_lifecycle(_base_url: str, _agent_id: str) -> dict:
        nonlocal reads
        reads += 1
        return task.expected_payment_lifecycle

    result = await _wait_for_expected_payment_lifecycle(
        "http://localhost:55120",
        "agent-123",
        task,
        {
            "purchase": {"status": "HELD"},
            "walletFunding": {"status": "RECLAIMED"},
        },
        timeout_seconds=1,
        poll_interval_seconds=0,
        fetch_lifecycle=fetch_lifecycle,
    )

    assert result["purchase"]["status"] == "VOIDED"
    assert reads == 1


async def test_abandonment_tolerates_provider_outage_beyond_three_lifecycle_reads():
    """AgentCard throttling can outlast the old three-read cutoff and still recover."""
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _wait_for_expected_payment_lifecycle

    task = get_task_by_name("agent-payment-abandonment")
    reads = 0

    async def fetch_lifecycle(_base_url: str, _agent_id: str) -> dict:
        nonlocal reads
        reads += 1
        if reads <= 4:
            raise RuntimeError('500 {"error":"Failed to read test payment lifecycle"}')
        return task.expected_payment_lifecycle

    result = await _wait_for_expected_payment_lifecycle(
        "http://localhost:55120",
        "agent-123",
        task,
        {
            "purchase": {"status": "FUNDING_RECLAIM_FAILED"},
            "walletFunding": {"status": "RECLAIM_FAILED"},
        },
        timeout_seconds=1,
        poll_interval_seconds=0,
        fetch_lifecycle=fetch_lifecycle,
    )

    assert result["purchase"]["status"] == "VOIDED"
    assert reads == 5


async def test_abandonment_surfaces_lifecycle_outage_at_reconciliation_deadline():
    """A persistent provider outage stays bounded by the reconciliation deadline."""
    from types import SimpleNamespace

    import pytest

    import benchmarks.run_benchmark as bench
    from benchmarks.benchmark_tasks import get_task_by_name

    reads = 0
    clock_reads = 0

    async def fetch_lifecycle(_base_url: str, _agent_id: str) -> dict:
        nonlocal reads
        reads += 1
        raise RuntimeError("upstream unavailable")

    def monotonic() -> float:
        nonlocal clock_reads
        clock_reads += 1
        return 0 if clock_reads < 7 else 1

    # Replace only the benchmark module's clock. Patching time.monotonic on the
    # shared stdlib module also changes asyncio's event-loop clock, making the
    # number of simulated reads scheduler-dependent.
    with patch.object(bench, "time", SimpleNamespace(monotonic=monotonic)):
        with pytest.raises(
            RuntimeError,
            match="unavailable at the reconciliation deadline after 3 consecutive reads",
        ):
            await bench._wait_for_expected_payment_lifecycle(
                "http://localhost:55120",
                "agent-123",
                get_task_by_name("agent-payment-abandonment"),
                {
                    "purchase": {"status": "FUNDING_RECLAIM_FAILED"},
                    "walletFunding": {"status": "RECLAIM_FAILED"},
                },
                timeout_seconds=1,
                poll_interval_seconds=0,
                fetch_lifecycle=fetch_lifecycle,
            )
    assert reads == 3


async def test_initial_payment_lifecycle_retries_one_transient_provider_failure():
    """The terminal snapshot gets the same bounded transient tolerance as cleanup reads."""
    from benchmarks.run_benchmark import _get_initial_payment_lifecycle_with_retry

    reads = 0

    async def fetch_lifecycle(_base_url: str, _agent_id: str) -> dict:
        nonlocal reads
        reads += 1
        if reads == 1:
            raise RuntimeError('500 {"error":"Failed to read test payment lifecycle"}')
        return {"purchase": {"status": "CLEARED"}}

    result = await _get_initial_payment_lifecycle_with_retry(
        "http://localhost:55120",
        "agent-123",
        retry_delay_seconds=0,
        fetch_lifecycle=fetch_lifecycle,
    )

    assert result["purchase"]["status"] == "CLEARED"
    assert reads == 2


async def test_initial_payment_lifecycle_bounds_persistent_provider_failure():
    """A real provider outage still fails closed after the bounded retry budget."""
    import pytest

    from benchmarks.run_benchmark import _get_initial_payment_lifecycle_with_retry

    reads = 0

    async def fetch_lifecycle(_base_url: str, _agent_id: str) -> dict:
        nonlocal reads
        reads += 1
        raise RuntimeError("upstream unavailable")

    with pytest.raises(RuntimeError, match="unavailable after 3 reads"):
        await _get_initial_payment_lifecycle_with_retry(
            "http://localhost:55120",
            "agent-123",
            retry_delay_seconds=0,
            fetch_lifecycle=fetch_lifecycle,
        )
    assert reads == 3


def test_agent_payment_catalog_requires_terminal_lifecycle_evidence():
    """Checkout text alone cannot pass the AgentCard lifecycle benchmark."""
    from benchmarks.benchmark_tasks import get_task_by_name, get_tasks_by_tag, suite_tasks
    from benchmarks.run_benchmark import _validate_payment_lifecycle

    task = get_task_by_name("agent-payment-test-shop")

    assert "visible Rose Labs Test Payment checkout" in task.prompt
    assert "do not navigate to source files or API endpoints" in task.prompt
    assert "preserve the merchant" not in task.prompt.lower()
    assert task.expected_payment_lifecycle["purchase"]["status"] == "CLEARED"
    assert task.expected_payment_lifecycle["walletFunding"]["status"] == "CONSUMED"
    assert task.expected_payment_lifecycle["orgTransfer"]["livemode"] is False
    assert _validate_payment_lifecycle(task, {"_benchmark": {}}) == ("missing payment lifecycle snapshot")

    idempotency = get_task_by_name("agent-payment-idempotent-abandonment")
    assert idempotency.expected_tools == ["spawn_browser_agent"]
    assert idempotency.expected_tool_counts["spawn_browser_agent"] == 2
    assert idempotency.min_tool_counts["request_payment_card"] == 2
    assert "invoke spawn_browser_agent exactly twice" in idempotency.prompt
    assert idempotency.expected_payment_lifecycle["purchase"]["status"] == "CLEARED"
    abandonment = get_task_by_name("agent-payment-abandonment")
    assert abandonment.payment_card_request_action == "abandon"
    assert abandonment.expected_payment_lifecycle["purchase"]["status"] == "VOIDED"
    assert abandonment.expected_payment_lifecycle["walletFunding"]["status"] == "RECLAIMED"
    assert abandonment.expected_payment_lifecycle["stripeRefund"]["status"] == "succeeded"

    setup = get_task_by_name("agent-payment-setup-resume")
    assert setup.expected_attention_kinds == [
        "payment_approval",
        "agentcard_user_cardholder_onboarding_required",
    ]
    assert setup.agentcard_setup_action == "complete"
    assert setup.expected_payment_lifecycle["purchase"]["status"] == "CLEARED"

    production = get_task_by_name("agent-payment-production-abandonment")
    assert production.production_only is True
    assert production.payment_card_request_action == "abandon"
    assert "exactly $1.00" in production.prompt
    assert production.expected_payment_receipt["totalCents"] == 100
    assert production.expected_payment_lifecycle["purchase"]["status"] == "VOIDED"
    assert production.expected_payment_lifecycle["integrity"]["stripePaymentIntentCount"] == 0
    assert production.expected_payment_lifecycle["integrity"]["stripeProviderPaymentIntentCount"] == 0
    assert production.expected_payment_lifecycle["stripeHold"] is None
    assert production.expected_payment_lifecycle["stripeRefund"] is None
    assert production.expected_payment_lifecycle["orgTransfer"]["amountCents"] == 100
    assert production.expected_payment_lifecycle["orgTransfer"]["transferredCents"] == 0
    assert production.expected_payment_lifecycle["orgTransfer"]["releasedCents"] == 100
    assert production.expected_payment_lifecycle["orgTransfer"]["livemode"] is True
    assert production.name not in {task.name for task in suite_tasks()}

    assert [task.name for task in get_tasks_by_tag("agentcard-lifecycle-sandbox")] == [
        "agent-payment-test-shop",
        "agent-payment-setup-resume",
        "agent-payment-idempotent-abandonment",
        "agent-payment-abandonment",
    ]
    assert "?benchmark=agentcard-abandonment" in abandonment.prompt


def test_agent_payment_accepts_grounded_structured_browser_confirmation():
    """A verified browser result must not depend on one exact prose inflection.

    Ported from the deleted `_evaluate_agent_payment_result` exact-key matcher to the
    current pipeline (c747ca4fd), which left these two cases importing a symbol that no
    longer exists — the agents `benchmark` domain has been red on main since. The pass/fail
    verdict now lives in the async semantic gate rather than a pure function, so the
    contract this case can still pin is that the grounded id REACHES that judge.
    """
    from benchmarks.run_benchmark import _extract_agent_payment_output_blob

    data = {
        "agent": {
            "status": "COMPLETED",
            "structured_output": {"order_confirmation_id": "tp_6faab326"},
        },
        "messages": [
            {
                "role": "TOOL",
                "message": "The final DOM shows the payment was confirmed.",
                "metadata": {
                    "phase": "EXECUTE",
                    "title": "Browser automation complete",
                    "toolName": "spawn_browser_agent",
                    "toolStatus": "FINISHED",
                    "structured_response": {"order_confirmation_id": "tp_6faab326"},
                },
            }
        ],
    }

    assert "tp_6faab326" in _extract_agent_payment_output_blob(data)


def test_agent_payment_accepts_current_payment_confirmation_schema_key():
    """The browser payment task currently asks for payment_confirmation_id.

    Same port as above: pins that this schema key's grounded id, alongside the
    purchased product names, survives extraction into the semantic judge's blob.
    """
    from benchmarks.run_benchmark import _extract_agent_payment_output_blob

    data = {
        "messages": [
            {
                "role": "TOOL",
                "message": "The final DOM shows Payment confirmed with order ID tp_058813d0.",
                "metadata": {
                    "phase": "EXECUTE",
                    "title": "Browser automation complete",
                    "toolName": "spawn_browser_agent",
                    "toolStatus": "FINISHED",
                    "structured_response": {
                        "payment_confirmation_id": "tp_058813d0",
                        "purchased_product_names": [
                            "Aurora Notebook",
                            "Ceramic Mug",
                            "Canvas Tote",
                        ],
                    },
                },
            }
        ],
    }

    blob = _extract_agent_payment_output_blob(data)
    assert "tp_058813d0" in blob
    assert "Aurora Notebook" in blob


def test_production_payment_lifecycle_refuses_sandbox_target():
    import pytest

    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _validate_task_target

    task = get_task_by_name("agent-payment-production-abandonment")
    with pytest.raises(RuntimeError, match="production-only"):
        _validate_task_target(task, "http://localhost:55120")
    _validate_task_target(task, "https://api.roselabs.ai")


def test_production_frontend_url_ignores_stale_local_services_manifest():
    """A stopped local stack must not redirect production browser agents to its tunnel."""
    from benchmarks.run_benchmark import _frontend_url_for_benchmark

    environment_names = (
        "BENCHMARK_CONTEXT_DIR",
        "BENCHMARK_FRONTEND_URL",
        "PUBLIC_BASE_URL",
        "CONDUCTOR_PORT",
    )
    prior = {name: os.environ.get(name) for name in environment_names}
    try:
        with tempfile.TemporaryDirectory() as context_dir:
            Path(context_dir, "services.json").write_text(
                json.dumps(
                    {
                        "status": "stopped",
                        "urls": {"public": "https://stale-workspace.ngrok.app"},
                    }
                ),
                encoding="utf-8",
            )
            os.environ["BENCHMARK_CONTEXT_DIR"] = context_dir
            for name in ("BENCHMARK_FRONTEND_URL", "PUBLIC_BASE_URL", "CONDUCTOR_PORT"):
                os.environ.pop(name, None)

            assert _frontend_url_for_benchmark("https://navi-j9a9.onrender.com") == "https://roselabs.ai"
    finally:
        for name, value in prior.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def test_system_postgres_fixture_sql_targets_manifest_database_name():
    """Fixture mutations must hit the isolated DB that serves the benchmark stack."""
    from benchmarks import run_benchmark as bench

    environment_names = ("BENCHMARK_CONTEXT_DIR", "DIRECT_URL", "DATABASE_URL")
    prior = {name: os.environ.get(name) for name in environment_names}
    original_run = bench.subprocess.run
    try:
        with tempfile.TemporaryDirectory() as context_dir:
            Path(context_dir, "services.json").write_text(
                json.dumps(
                    {
                        "status": "running",
                        "run_sh_pid": os.getpid(),
                        "database": {
                            "name": "victoria_bench_isolated_123",
                            "runtime_port": 5432,
                            "use_system_postgres": True,
                        },
                        "ports": {"local_db": 58145},
                    }
                ),
                encoding="utf-8",
            )
            os.environ["BENCHMARK_CONTEXT_DIR"] = context_dir
            os.environ.pop("DIRECT_URL", None)
            os.environ.pop("DATABASE_URL", None)

            probed_urls = []

            def fake_run(args, **_kwargs):
                probed_urls.append(args[1])
                return subprocess.CompletedProcess(args, 0, stdout="1\n", stderr="")

            bench.subprocess.run = fake_run
            assert bench._local_victoria_database_url() == (
                "postgresql://postgres:postgres@localhost:5432/victoria_bench_isolated_123"
            )
            assert probed_urls == ["postgresql://postgres:postgres@localhost:5432/victoria_bench_isolated_123"]

            probed_urls.clear()
            Path(context_dir, "services.json").write_text(
                json.dumps(
                    {
                        "status": "stopped",
                        "database": {
                            "name": "victoria_bench_stale_456",
                            "runtime_port": 5432,
                            "use_system_postgres": True,
                        },
                    }
                ),
                encoding="utf-8",
            )
            os.environ["DATABASE_URL"] = "postgresql://postgres:postgres@localhost:5432/victoria_env_explicit"
            assert bench._local_victoria_database_url() == (
                "postgresql://postgres:postgres@localhost:5432/victoria_env_explicit"
            )
            assert probed_urls == ["postgresql://postgres:postgres@localhost:5432/victoria_env_explicit"]

            probed_urls.clear()
            Path(context_dir, "services.json").write_text(
                json.dumps(
                    {
                        "status": "running",
                        "run_sh_pid": 999_999_999,
                        "database": {
                            "name": "victoria_bench_orphaned_789",
                            "runtime_port": 5432,
                            "use_system_postgres": True,
                        },
                    }
                ),
                encoding="utf-8",
            )
            assert bench._local_victoria_database_url() == (
                "postgresql://postgres:postgres@localhost:5432/victoria_env_explicit"
            )
            assert probed_urls == ["postgresql://postgres:postgres@localhost:5432/victoria_env_explicit"]
    finally:
        bench.subprocess.run = original_run
        for name, value in prior.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def test_agentcard_setup_fixture_skips_production_lifecycle():
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _agentcard_setup_fixture_action

    standard = get_task_by_name("agent-payment-test-shop")
    setup = get_task_by_name("agent-payment-setup-resume")
    production = get_task_by_name("agent-payment-production-abandonment")

    assert _agentcard_setup_fixture_action(standard, "http://localhost:55120") == "complete"
    assert _agentcard_setup_fixture_action(setup, "http://localhost:55120") == "reset"
    assert _agentcard_setup_fixture_action(production, "https://api.roselabs.ai") is None


def test_expected_attention_kind_uses_ordered_sequence():
    from types import SimpleNamespace

    from benchmarks.run_benchmark import _expected_attention_kind

    task = SimpleNamespace(
        expected_attention_kind=None,
        expected_attention_kinds=[
            "payment_approval",
            "agentcard_user_cardholder_onboarding_required",
        ],
    )
    assert _expected_attention_kind(task, 0) == "payment_approval"
    assert _expected_attention_kind(task, 1) == "agentcard_user_cardholder_onboarding_required"
    assert _expected_attention_kind(task, 2) is None


def test_agentcard_setup_attention_is_not_auto_approved():
    from types import SimpleNamespace

    from benchmarks.run_benchmark import _should_auto_approve_attention

    task = SimpleNamespace(agentcard_setup_action="complete")
    assert _should_auto_approve_attention(
        task,
        {"metadata": {"attentionKind": "payment_approval"}},
    )
    assert not _should_auto_approve_attention(
        task,
        {"metadata": {"attentionKind": "agentcard_user_cardholder_onboarding_required"}},
    )


async def test_expected_gate_auto_approve_task_returns_without_resolving_gate():
    """Expected-gate tasks pass when the matching open gate appears; they must not auto-resolve it."""
    import copy
    from unittest.mock import AsyncMock, patch

    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import evaluate_task, poll_agent

    task = copy.deepcopy(get_task_by_name("gate-subscription-card-mint"))
    task._resolved_timeout_seconds = 0.1
    agent_data = {
        "agent": {"status": "ACTIVE", "progress": 0.03},
        "messages": [{"id": "msg-1", "metadata": {}}],
    }
    gate_request = {
        "id": "gate-1",
        "agentId": "agent-1",
        "metadata": {
            "gate": {
                "type": "subscription",
                "gateKey": "subscription",
                "severity": "blocking",
                "status": "PENDING",
            }
        },
    }
    tree_stats = {
        "total_messages": 1,
        "agent_count": 1,
        "active_count": 1,
        "failed_count": 0,
        "error_agents": [],
        "total_cost_cents": 0,
        "all_agents": [{"agent_id": "agent-1", "status": "ACTIVE", "message_count": 1}],
    }
    respond = AsyncMock()

    with (
        patch("benchmarks.run_benchmark.get_agent", AsyncMock(return_value=agent_data)),
        patch("benchmarks.run_benchmark.get_attention_requests", AsyncMock(return_value=[gate_request])),
        patch("benchmarks.run_benchmark.respond_to_attention_request", respond),
        patch("benchmarks.run_benchmark._fetch_tree_stats", AsyncMock(return_value=tree_stats)),
        patch("benchmarks.run_benchmark._fetch_message_counts", AsyncMock(return_value={})),
        patch("benchmarks.run_benchmark._detect_infra_errors_from_fly", return_value=[]),
        patch("benchmarks.run_benchmark.asyncio.sleep", AsyncMock(return_value=None)),
        patch("benchmarks.run_benchmark.time.time", side_effect=[0, 0, 0, 1]),
    ):
        data, approvals_triggered, approvals_resolved, reason = await poll_agent(
            "http://bench.local",
            "agent-1",
            task,
        )

    assert reason is None
    assert approvals_triggered == 1
    assert approvals_resolved == 0
    assert data["_benchmark"]["expected_gate_seen"] is True
    assert data["_benchmark"]["expected_gate_request_id"] == "gate-1"
    respond.assert_not_awaited()
    assert evaluate_task(task, data, approvals_triggered) == (True, None)


def test_expected_gate_message_evidence_is_terminal_before_browser_min_steps():
    """Expected-gate tasks stop at the open gate even when checkout browser work is intentionally short."""
    import copy

    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import (
        _agent_class_step_counts,
        _validate_agent_class_min_steps,
        evaluate_task,
    )

    task = copy.deepcopy(get_task_by_name("gate-kyc-card-mint"))
    browser_task_id = "browser-kyc-short-trajectory"
    data = {
        "agent": {"status": "ACTIVE", "progress": 0.03},
        "messages": [
            {
                "role": "ASSISTANT",
                "metadata": {
                    "tool_calls": [
                        {
                            "tool": "spawn_agent",
                            "type": "browser",
                            "tool_call_id": "browser-root",
                        }
                    ]
                },
            },
            {
                "role": "TOOL",
                "metadata": {
                    "toolName": "spawn_browser_agent",
                    "toolCallId": "browser-root",
                    "task_id": browser_task_id,
                    "toolStatus": "IN_PROGRESS",
                },
            },
            {
                "role": "TOOL",
                "metadata": {
                    "toolName": "spawn_browser_agent",
                    "toolCallId": "browser-action-0",
                    "task_id": browser_task_id,
                    "subAgentId": browser_task_id,
                    "steps_taken": 0,
                    "toolStatus": "FINISHED",
                },
            },
            {
                "role": "TOOL",
                "metadata": {
                    "toolName": "spawn_browser_agent",
                    "toolCallId": "browser-action-1",
                    "task_id": browser_task_id,
                    "subAgentId": browser_task_id,
                    "steps_taken": 1,
                    "toolStatus": "FINISHED",
                },
            },
            {
                "role": "TOOL",
                "metadata": {
                    "toolName": "gate",
                    "toolCallId": "gate-kyc-1",
                    "attentionRequestId": "gate-kyc-1",
                    "toolStatus": "IN_PROGRESS",
                    "gate": {
                        "type": "kyc",
                        "gateKey": "kyc",
                        "severity": "blocking",
                        "status": "PENDING",
                        "detection": {
                            "method": "kyc_webhook",
                            "probeKey": "customers_needed_kyc",
                        },
                    },
                },
            },
        ],
    }

    counts = _agent_class_step_counts(data)
    assert counts == {"browser": {browser_task_id: 2}}
    assert task.min_steps == {"browser": 5}
    assert _validate_agent_class_min_steps(task.min_steps, counts) is not None

    passed, reason = evaluate_task(task, data, approvals_triggered=1)

    assert passed is True, reason
    assert data["_benchmark"]["expected_gate_seen"] is True
    assert data["_benchmark"]["expected_gate_request_id"] == "gate-kyc-1"


async def test_agentcard_setup_terminal_check_refreshes_stale_attention_poll():
    from benchmarks.run_benchmark import _agentcard_setup_attention_still_open_after_terminal

    reads = 0

    async def fetch_requests(_base_url: str) -> list:
        nonlocal reads
        reads += 1
        if reads == 1:
            return [
                {
                    "id": "stale-setup-from-another-agent",
                    "metadata": {"attentionKind": "agentcard_user_cardholder_onboarding_required"},
                },
                {
                    "id": "setup-1",
                    "metadata": {"attentionKind": "agentcard_user_cardholder_onboarding_required"},
                },
            ]
        return [
            {
                "id": "setup-1",
                "answered": True,
                "metadata": {"attentionKind": "agentcard_user_cardholder_onboarding_required"},
            }
        ]

    assert not await _agentcard_setup_attention_still_open_after_terminal(
        "http://localhost:55120",
        "setup-1",
        retry_delay_seconds=0,
        fetch_requests=fetch_requests,
    )
    assert reads == 2


async def test_agentcard_setup_terminal_check_fails_closed_for_open_attention():
    from benchmarks.run_benchmark import _agentcard_setup_attention_still_open_after_terminal

    async def fetch_requests(_base_url: str) -> list:
        return [
            {
                "id": "setup-1",
                "metadata": {"attentionKind": "agentcard_user_cardholder_onboarding_required"},
            }
        ]

    assert await _agentcard_setup_attention_still_open_after_terminal(
        "http://localhost:55120",
        "setup-1",
        retry_delay_seconds=0,
        fetch_requests=fetch_requests,
    )


def _required_ecommerce_judge_task():
    from benchmarks.benchmark_tasks import BenchmarkTask

    return BenchmarkTask(
        name="ecommerce-judge-test",
        title="Ecommerce Judge Test",
        prompt="Complete the purchase",
        timeout_seconds=60,
        is_chat_mode=False,
        expected_tools=["spawn_agent"],
        tags=["ecommerce"],
        price_limit_cents=100,
        requires_browser_agent=True,
        requires_claude_code=False,
        attachment=None,
        approval_handling="ignore",
        start_phase="execute",
        expected_attention_kinds=["write_lock", "payment_approval"],
        enforce_declared_evaluators=True,
        evaluators=[
            {
                "id": "commerce-outcome",
                "method": "single_turn_llm_judge",
                "criteria": ["The requested item and terminal checkout state are grounded"],
                "judge_prompt": "Fail unless the transaction outcome is grounded in tool evidence.",
                "pass_threshold": 1.0,
            }
        ],
    )


def test_ecommerce_attention_kind_rejects_auth_blocker():
    """A login handoff cannot masquerade as a terminal commerce write lock."""
    from benchmarks.run_benchmark import _attention_request_matches_task

    task = _required_ecommerce_judge_task()
    auth_request = {"metadata": {"attentionKind": "auth_assistance"}}
    write_lock_request = {"metadata": {"requestUserApproval": {"writePermission": True}}}

    assert _attention_request_matches_task(task, auth_request) is False
    assert _attention_request_matches_task(task, write_lock_request) is True


async def test_required_declared_evaluator_controls_pass_fail():
    """A required declared judge is executed and its score controls the run."""
    import benchmarks.run_benchmark as bench

    task = _required_ecommerce_judge_task()
    data = {
        "agent": {"agent_id": "agent-commerce", "status": "ACTIVE"},
        "messages": [
            {
                "role": "TOOL",
                "text": "Reached checkout",
                "metadata": {"toolName": "spawn_agent", "toolStatus": "FINISHED"},
            }
        ],
        "_benchmark": {"attention_request_kind_seen": "write_lock"},
    }
    scores = iter(
        [
            {"score": 0.0, "reasoning": "The requested item is not evidenced."},
            {"score": 1.0, "reasoning": "Every criterion is grounded."},
        ]
    )
    calls = []
    original_call = bench._call_declared_llm_judge

    async def fake_call(task_arg, evaluator_arg, data_arg):
        calls.append((task_arg.name, evaluator_arg["id"], data_arg["agent"]["agent_id"]))
        return next(scores)

    try:
        bench._call_declared_llm_judge = fake_call
        passed, reason, results = await bench._run_declared_evaluators(task, data)
        assert passed is False
        assert "requested item is not evidenced" in reason.lower()
        assert results[0]["passed"] is False

        passed, reason, results = await bench._run_declared_evaluators(task, data)
        assert passed is True
        assert reason is None
        assert results[0]["passed"] is True
    finally:
        bench._call_declared_llm_judge = original_call

    assert calls == [
        ("ecommerce-judge-test", "commerce-outcome", "agent-commerce"),
        ("ecommerce-judge-test", "commerce-outcome", "agent-commerce"),
    ]


def _opentable_static_evaluator():
    return {
        "id": "opentable-runtime-contract",
        "method": "static_check",
        "criteria": ["The browser and approval trajectory satisfies the deterministic contract"],
        "checks": [
            {"type": "no_browser_agent_failures"},
            {"type": "browser_agent_session_count", "min": 1, "max": 1},
            {"type": "agent_status", "value": "COMPLETED"},
            {"type": "approval_request_count", "value": 1},
            {
                "type": "approval_request_details",
                "required_strings": ["Prospect"],
                "require_time": True,
            },
        ],
    }


def _completed_opentable_evidence():
    return {
        "agent": {"status": "COMPLETED"},
        "messages": [
            {
                "role": "TOOL",
                "text": "Browser automation complete",
                "metadata": {
                    "toolName": "spawn_agent",
                    "agentType": "browser",
                    "toolStatus": "FINISHED",
                    "toolCallId": "browser-call-1",
                    "browser_url": "https://steel.example/session/one",
                },
            }
        ],
        "_benchmark": {
            "approvals_triggered": 1,
            "attention_requests_seen": [
                {
                    "kind": "write_lock",
                    "question": "Confirm reservation at Prospect for 7:00 PM?",
                }
            ],
        },
    }


def test_opentable_static_evaluator_checks_full_runtime_contract():
    """Code checks reject failed/retried browsers, incomplete roots, and weak approvals."""
    from copy import deepcopy

    from benchmarks.run_benchmark import _run_declared_static_check

    evaluator = _opentable_static_evaluator()
    good = _completed_opentable_evidence()
    assert _run_declared_static_check(evaluator, good)[0] is True

    failed_browser = deepcopy(good)
    failed_browser["messages"].append(
        {
            "role": "TOOL",
            "metadata": {
                "toolName": "spawn_agent",
                "agentType": "browser",
                "toolStatus": "FAILED",
                "toolCallId": "browser-call-1",
            },
        }
    )
    assert "browser agent failure" in _run_declared_static_check(evaluator, failed_browser)[1].lower()

    retried_browser = deepcopy(good)
    retried_browser["messages"].append(
        {
            "role": "TOOL",
            "metadata": {
                "toolName": "spawn_agent",
                "agentType": "browser",
                "toolStatus": "FINISHED",
                "toolCallId": "browser-call-2",
                "browser_url": "https://steel.example/session/two",
            },
        }
    )
    assert "browser agent session" in _run_declared_static_check(evaluator, retried_browser)[1].lower()

    incomplete = deepcopy(good)
    incomplete["agent"]["status"] = "ACTIVE"
    assert "agent status" in _run_declared_static_check(evaluator, incomplete)[1].lower()

    extra_approval = deepcopy(good)
    extra_approval["_benchmark"]["approvals_triggered"] = 2
    assert "approval request" in _run_declared_static_check(evaluator, extra_approval)[1].lower()

    missing_details = deepcopy(good)
    missing_details["_benchmark"]["attention_requests_seen"][0]["question"] = "Confirm reservation?"
    assert "prospect" in _run_declared_static_check(evaluator, missing_details)[1].lower()


def test_auto_approve_requires_exact_declared_approval_count():
    """Auto-approval tasks fail if the agent triggers more approvals than declared."""
    from dataclasses import replace

    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import evaluate_task

    task = replace(
        get_task_by_name("browser-opentable-reservation"),
        expected_tools=[],
        approval_handling="auto_approve",
        expected_approval_count=1,
        expected_tool_counts=None,
    )
    data = {"agent": {"status": "COMPLETED", "progress": 1.0}, "messages": []}

    assert evaluate_task(task, data, approvals_triggered=1) == (True, None)
    passed, reason = evaluate_task(task, data, approvals_triggered=2)
    assert passed is False
    assert "expected exactly 1 approval" in reason.lower()


def test_opentable_catalog_uses_auto_approved_mixed_evaluators():
    """The OpenTable task combines trajectory code checks with a semantic judge."""
    from benchmarks.benchmark_tasks import get_task_by_name

    task = get_task_by_name("browser-opentable-reservation")
    assert "prepaid experience" not in task.prompt.lower()
    assert "stop at the final write-lock" not in task.prompt.lower()
    assert task.approval_handling == "auto_approve"
    assert task.expected_approval_count == 1
    assert task.expected_tool_counts == {"spawn_browser_agent": 1}
    assert task.tool_count_scope == "root"
    assert [evaluator["method"] for evaluator in task.evaluators] == [
        "static_check",
        "single_turn_llm_judge",
    ]
    static_types = {check["type"] for check in task.evaluators[0]["checks"]}
    assert static_types == {
        "no_browser_agent_failures",
        "browser_agent_session_count",
        "agent_status",
        "approval_request_count",
        "approval_request_details",
    }
    semantic_criteria = " ".join(task.evaluators[1]["criteria"]).lower()
    assert "completed" in semantic_criteria
    assert "closest" in semantic_criteria


def test_instacart_catalog_uses_complete_weekly_grocery_basket():
    """The weekly Instacart task keeps the agreed basket and substitution policy exact."""
    from benchmarks.benchmark_tasks import get_task_by_name

    task = get_task_by_name("browser-instacart-grocery-order")
    prompt = task.prompt.lower()
    for product in (
        "blueberries",
        "strawberries",
        "16 oz cocojune yogurt",
        "pickles",
        "feta cheese",
        "olives",
        "12-pack of 1 l essentia ionized alkaline water",
    ):
        assert product in prompt
    assert prompt.count("pickles") == 1
    for retired_product in ("large eggs", "bananas", "whole milk"):
        assert retired_product not in prompt
    assert "$60" in task.prompt
    assert "do not substitute cocojune or essentia" in prompt

    evaluator = task.evaluators[0]
    assert evaluator["method"] == "single_turn_llm_judge"
    criteria = " ".join(evaluator["criteria"]).lower()
    for requirement in (
        "seven",
        "cocojune",
        "essentia",
        "single store",
        "$60",
        "earliest available delivery window",
    ):
        assert requirement in criteria


def test_no_tool_failures_static_check_rejects_any_failed_tool_event():
    """The reusable trajectory check fails closed on any grounded tool failure."""
    from benchmarks.run_benchmark import _run_declared_static_check

    evaluator = {
        "checks": [{"type": "no_tool_failures"}],
    }
    good = {
        "messages": [
            {
                "role": "TOOL",
                "metadata": {
                    "toolName": "spawn_agent",
                    "toolStatus": "FINISHED",
                    "data": {"success": True},
                },
            }
        ]
    }
    assert _run_declared_static_check(evaluator, good)[0] is True

    for status in ("FAILED", "ERROR", "CANCELLED"):
        failed = {
            "messages": [
                {
                    "role": "TOOL",
                    "metadata": {"toolName": "spawn_agent", "toolStatus": status},
                }
            ]
        }
        passed, reason = _run_declared_static_check(evaluator, failed)
        assert passed is False
        assert "tool failure" in reason.lower()

    unsuccessful = {
        "messages": [
            {
                "role": "TOOL",
                "metadata": {
                    "toolName": "spawn_browser_agent",
                    "toolStatus": "FINISHED",
                    "data": {"success": False},
                },
            }
        ]
    }
    assert _run_declared_static_check(evaluator, unsuccessful)[0] is False


def test_completion_summary_and_sms_static_checks_are_fail_closed():
    """Completion quality checks use the rendered summary and durable SMS receipt."""
    from copy import deepcopy

    from benchmarks.run_benchmark import _run_declared_static_check

    summary = "x" * 81
    outputs = [{"key": "pickup_time", "label": "Pickup Time", "value": "7:41 AM"}]
    evaluator = {
        "checks": [
            {"type": "completion_summary_length", "min_chars": 81},
            {
                "type": "completion_sms_event",
                "expected_count": 1,
                "allow_skipped_reasons": ["benchmark_agent"],
                "require_output_payload": True,
                "require_rendered_message": True,
                "max_lines": 8,
            },
        ],
    }
    good = {
        "agent": {"agent_id": "root-blue-bottle", "status": "COMPLETED"},
        "messages": [
            {
                "role": "TOOL",
                "metadata": {
                    "isFinalSummary": True,
                    "toolName": "completion_summary",
                    "toolStatus": "FINISHED",
                    "completionSummary": {"summary": summary, "outputs": outputs},
                },
            }
        ],
        "_benchmark": {
            "completion_sms_events": [
                {
                    "path": "provider/sms/notify/completion-root-blue-bottle.json.gz.enc",
                    "status_code": 200,
                    "request": {
                        "event_type": "completion",
                        "agent_id": "root-blue-bottle",
                        "payload": {"summary": summary, "outputs": outputs},
                    },
                    "response": {
                        "success": True,
                        "skipped": True,
                        "reason": "benchmark_agent",
                        "messagePreview": (
                            f"Done: {summary}\n"
                            "Pickup Time: 7:41 AM\n"
                            "View agent: https://roselabs.ai/?agent-id=root-blue-bottle"
                        ),
                    },
                }
            ]
        },
    }
    assert _run_declared_static_check(evaluator, good)[0] is True

    short = deepcopy(good)
    short["messages"][0]["metadata"]["completionSummary"]["summary"] = "x" * 80
    passed, reason = _run_declared_static_check(evaluator, short)
    assert passed is False
    assert "80 characters" in reason

    missing_output_payload = deepcopy(good)
    missing_output_payload["_benchmark"]["completion_sms_events"][0]["request"]["payload"]["outputs"] = []
    passed, reason = _run_declared_static_check(evaluator, missing_output_payload)
    assert passed is False
    assert "payload" in reason.lower()

    too_many_lines = deepcopy(good)
    too_many_lines["_benchmark"]["completion_sms_events"][0]["response"]["messagePreview"] = "\n".join(
        [f"Done: {summary}", *(f"Output {index}: value" for index in range(7)), "View agent: agent-id=root-blue-bottle"]
    )
    passed, reason = _run_declared_static_check(evaluator, too_many_lines)
    assert passed is False
    assert "at most 8" in reason

    child_notification = deepcopy(good)
    child_notification["_benchmark"]["completion_sms_events"].append(
        {
            "path": "provider/sms/notify/completion-child.json.gz.enc",
            "status_code": 200,
            "request": {
                "event_type": "completion",
                "agent_id": "child",
                "payload": {"summary": "child", "outputs": []},
            },
            "response": {"success": True},
        }
    )
    passed, reason = _run_declared_static_check(evaluator, child_notification)
    assert passed is False
    assert "exactly 1" in reason


def test_blue_bottle_catalog_enforces_summary_and_completion_sms():
    """The incident benchmark owns deterministic summary and SMS regressions."""
    from benchmarks.benchmark_tasks import get_task_by_name

    task = get_task_by_name("browser-blue-bottle-challenge-recovery")
    evaluator = next(item for item in task.evaluators if item["id"] == "blue_bottle_completion_delivery")
    checks = {check["type"]: check for check in evaluator["checks"]}

    assert evaluator["method"] == "static_check"
    assert checks["completion_summary_length"]["min_chars"] == 81
    assert checks["completion_sms_event"] == {
        "type": "completion_sms_event",
        "expected_count": 1,
        "allow_skipped_reasons": ["benchmark_agent"],
        "require_output_payload": True,
        "require_rendered_message": True,
        "max_lines": 8,
    }


async def test_declared_evaluator_hydrates_completion_sms_receipt():
    """The benchmark boundary reads the provider receipt before static grading."""
    from dataclasses import replace

    import benchmarks.run_benchmark as bench
    from benchmarks.benchmark_tasks import get_task_by_name

    summary = "Blue Bottle pickup was prepared through checkout without placing the order." + ("!" * 20)
    outputs = [{"key": "pickup_time", "label": "Pickup Time", "value": "7:41 AM"}]
    static_evaluator = next(
        item
        for item in get_task_by_name("browser-blue-bottle-challenge-recovery").evaluators
        if item["id"] == "blue_bottle_completion_delivery"
    )
    task = replace(
        get_task_by_name("browser-blue-bottle-challenge-recovery"),
        evaluators=[static_evaluator],
    )
    data = {
        "agent": {"agent_id": "root-blue-bottle", "status": "COMPLETED"},
        "messages": [
            {
                "role": "TOOL",
                "metadata": {
                    "toolName": "completion_summary",
                    "toolStatus": "FINISHED",
                    "completionSummary": {"summary": summary, "outputs": outputs},
                },
            }
        ],
    }
    path = "provider/sms/notify/completion-root-blue-bottle.json.gz.enc"
    original_paths = bench.archive_artifact_paths
    original_read = bench.read_archive_json
    try:
        bench.archive_artifact_paths = lambda agent_id: [path]
        bench.read_archive_json = lambda agent_id, artifact_path: {
            "status_code": 200,
            "request": {
                "event_type": "completion",
                "agent_id": "root-blue-bottle",
                "payload": {"summary": summary, "outputs": outputs},
            },
            "response": {
                "success": True,
                "skipped": True,
                "reason": "benchmark_agent",
                "messagePreview": (
                    f"Done: {summary}\n"
                    "Pickup Time: 7:41 AM\n"
                    "View agent: https://roselabs.ai/?agent-id=root-blue-bottle"
                ),
            },
        }
        passed, reason, results = await bench._run_declared_evaluators(task, data)
    finally:
        bench.archive_artifact_paths = original_paths
        bench.read_archive_json = original_read

    assert passed is True
    assert reason is None
    assert results[0]["passed"] is True
    assert data["_benchmark"]["completion_sms_events"][0]["path"] == path


def test_doordash_catalog_requires_single_clean_completed_browser_run():
    """DoorDash combines deterministic runtime invariants with product semantics."""
    from benchmarks.benchmark_tasks import get_task_by_name

    task = get_task_by_name("browser-doordash-usb-c-cable")
    assert "stop at the payment/write-lock" not in task.prompt.lower()
    assert task.prompt.endswith("Complete checkout.")
    assert task.approval_handling == "auto_approve"
    assert task.expected_approval_count == 1
    assert task.expected_tool_counts == {"spawn_browser_agent": 1}
    assert task.tool_count_scope == "root"
    assert [evaluator["method"] for evaluator in task.evaluators] == [
        "static_check",
        "single_turn_llm_judge",
    ]
    static_types = {check["type"] for check in task.evaluators[0]["checks"]}
    assert static_types == {
        "no_tool_failures",
        "browser_agent_session_count",
        "agent_status",
        "approval_request_count",
    }
    semantic_criteria = " ".join(task.evaluators[1]["criteria"]).lower()
    for requirement in ("usb-c to usb-c", "6 feet", "60w", "$30", "earliest"):
        assert requirement in semantic_criteria


def test_uber_catalog_is_normal_single_browser_task_not_stateful_minted_flow():
    """Uber uses live auth and the same one-agent runtime contract as other commerce tasks."""
    import benchmarks.run_benchmark as bench
    from benchmarks.benchmark_tasks import get_task_by_name

    task = get_task_by_name("minted-agent-accounts-uber")
    assert task.name not in bench.MINTED_AGENT_ACCOUNT_TASK_NAMES
    assert bench.MINTED_AGENT_ACCOUNT_TASK_NAMES == {bench.MINTED_AGENT_ACCOUNT_X_TASK_NAME}
    assert "minted" not in task.prompt.lower()
    assert "stop at the final write-lock" not in task.prompt.lower()
    assert task.prompt.endswith("Complete the ride request.")
    assert task.approval_handling == "auto_approve"
    assert task.expected_attention_kinds == ["write_lock"]
    assert task.expected_approval_count == 1
    assert task.expected_tool_counts == {"spawn_browser_agent": 1}
    assert task.tool_count_scope == "root"
    assert task.bench == "rose-bench"
    assert task.environment["live_fixtures"] == ["live"]
    assert [evaluator["method"] for evaluator in task.evaluators] == [
        "static_check",
        "single_turn_llm_judge",
    ]
    static_types = {check["type"] for check in task.evaluators[0]["checks"]}
    assert static_types == {
        "no_tool_failures",
        "browser_agent_session_count",
        "agent_status",
        "approval_request_count",
    }
    semantic_criteria = " ".join(task.evaluators[1]["criteria"]).lower()
    for requirement in ("88 howard", "425 mission", "uberx", "completed"):
        assert requirement in semantic_criteria


def test_approval_request_details_can_require_item_name_and_amount():
    """Commerce approvals must expose what is being purchased and its price."""
    from benchmarks.run_benchmark import _run_declared_static_check

    evaluator = {
        "checks": [
            {
                "type": "approval_request_details",
                "required_strings": ["beanie"],
                "require_amount": True,
            }
        ]
    }
    good = {"_benchmark": {"attention_requests_seen": [{"question": "Buy the Black Knit Beanie for $19.99?"}]}}
    assert _run_declared_static_check(evaluator, good)[0] is True

    missing_amount = {"_benchmark": {"attention_requests_seen": [{"question": "Buy the Black Knit Beanie?"}]}}
    passed, reason = _run_declared_static_check(evaluator, missing_amount)
    assert passed is False
    assert "amount" in reason.lower()


def test_amazon_beanie_catalog_requires_clean_completed_cart_purchase():
    """Amazon uses the standard completed-commerce runtime and preserves cart-path semantics."""
    from benchmarks.benchmark_tasks import get_task_by_name

    completed_purchase_prompt = (
        "Buy me a black beanie on Amazon that costs less than $35 and looks well-made. "
        "Use my saved/default Amazon payment method and shipping address; do not request or add a new "
        "payment card when a valid saved method is already selected. "
        "Avoid using the Buy Now button as the purchase path, but make sure purchase is completed."
    )
    auth_assistance_prompt = (
        "Buy me a black beanie on Amazon that costs less than $35 and looks well-made. "
        "Avoid using the Buy Now button as the purchase path, but make sure purchase is completed."
    )
    task = get_task_by_name("browser-agent-amazon-cookie-payment")
    assert task.description.endswith("complete the purchase.")
    assert task.prompt == completed_purchase_prompt
    assert get_task_by_name("browser-agent").prompt == auth_assistance_prompt
    assert task.approval_handling == "auto_approve"
    assert task.expected_attention_kind is None
    assert task.expected_attention_kind_any_of == ["payment_approval", "write_lock"]
    assert task.expected_approval_count == 1
    assert task.expected_tool_counts == {"spawn_browser_agent": 1}
    assert task.min_steps == {"browser": 5}
    assert task.tool_count_scope == "root"
    assert task.bench == "rose-bench"
    assert task.environment["live_fixtures"] == ["live"]
    response_fields = {field["name"]: field for field in task.response_schema["fields"]}
    assert set(response_fields) == {
        "selected_beanie_title",
        "selected_beanie_url",
        "selected_beanie_price_usd",
        "quality_evidence",
        "order_confirmation_id",
        "purchase_completed",
        "cart_checkout_used",
        "buy_now_used",
    }
    assert all(field["required"] is True for field in response_fields.values())
    assert [evaluator["method"] for evaluator in task.evaluators] == [
        "static_check",
        "single_turn_llm_judge",
    ]
    static_types = {check["type"] for check in task.evaluators[0]["checks"]}
    assert static_types == {
        "no_tool_failures",
        "browser_agent_session_count",
        "agent_status",
        "approval_request_count",
        "approval_request_details",
    }
    approval_check = next(
        check for check in task.evaluators[0]["checks"] if check["type"] == "approval_request_details"
    )
    assert approval_check["required_strings"] == ["beanie"]
    assert approval_check["require_amount"] is True
    runtime_criteria = " ".join(task.evaluators[0]["criteria"]).lower()
    assert "payment-card approval or final write approval" in runtime_criteria
    semantic_criteria = " ".join(task.evaluators[1]["criteria"]).lower()
    assert "payment-card approval or final write approval" in semantic_criteria
    for requirement in ("black", "under $35", "well-made", "buy now", "completed"):
        assert requirement in semantic_criteria


def test_amazon_beanie_accepts_exactly_one_payment_or_write_lock():
    """Either purchase approval is valid, but unrelated or duplicate approvals fail."""
    from dataclasses import replace

    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _attention_request_matches_task, evaluate_task

    task = replace(
        get_task_by_name("browser-agent-amazon-cookie-payment"),
        expected_tools=[],
        expected_tool_counts=None,
        enforce_declared_evaluators=False,
        evaluators=[],
    )
    payment = {"metadata": {"requestPaymentCard": {}}}
    write_lock = {"metadata": {"requestUserApproval": {"writePermission": True}}}
    auth = {"metadata": {"attentionKind": "auth_assistance"}}

    assert _attention_request_matches_task(task, payment) is True
    assert _attention_request_matches_task(task, write_lock) is True
    assert _attention_request_matches_task(task, auth) is False
    assert _attention_request_matches_task(task, write_lock, observed_count=1) is False

    payment_only = {
        "agent": {"status": "COMPLETED", "progress": 1.0},
        "messages": [],
        "_benchmark": {"attention_request_kind_seen": "payment_approval"},
    }
    write_lock_only = {
        "agent": {"status": "COMPLETED", "progress": 1.0},
        "messages": [],
        "_benchmark": {"attention_request_kind_seen": "write_lock"},
    }
    assert evaluate_task(task, payment_only, approvals_triggered=1) == (True, None)
    assert evaluate_task(task, write_lock_only, approvals_triggered=1) == (True, None)
    passed, reason = evaluate_task(task, payment_only, approvals_triggered=2)
    assert passed is False
    assert reason == "Expected exactly 1 approval request(s), observed 2"


def test_live_paid_bookings_stop_only_at_payment_approval():
    """Live purchases end at one pending card request, never a generic write lock."""
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _attention_request_matches_task

    payment = {"metadata": {"requestPaymentCard": {}}}
    write_lock = {"metadata": {"requestUserApproval": {"writePermission": True}}}
    auth = {"metadata": {"attentionKind": "auth_assistance"}}

    for task_name in ("browser-alchemy-springs-sauna", "browser-event-ticket"):
        task = get_task_by_name(task_name)
        assert task.expected_attention_kinds == []
        assert task.expected_attention_kind_any_of == []
        assert task.expected_attention_kind == "payment_approval"
        assert task.approval_handling == "ignore"
        assert task.success_on_payment_card_request is True
        assert task.expected_approval_count == 1
        assert _attention_request_matches_task(task, payment) is True
        assert _attention_request_matches_task(task, write_lock) is False
        assert _attention_request_matches_task(task, auth) is False


def _captured_live_paid_payment_approval(task_name: str) -> tuple[dict, list[dict]]:
    """Replay the two real payment boundaries captured in ecommerce epoch 12."""
    cases = {
        "browser-alchemy-springs-sauna": {
            "merchant": "Alchemy Springs / Momence",
            "host": "momence.com",
            "navigation_host": "alchemysprings.com",
            "item": "Sauna Sundays — Standard ticket (July 26, 2026, 12:00 PM)",
            "total": 6136,
        },
        "browser-event-ticket": {
            "merchant": "AMC Theatres",
            "host": "www.amctheatres.com",
            "navigation_host": "www.amctheatres.com",
            "item": "Moana — Adult Ticket, AMC Metreon 16, July 24 2026 7:15 PM, Seat D4",
            "total": 2368,
        },
    }
    case = cases[task_name]
    browser_scope = f"{task_name}-browser"
    browser_session = f"https://kernel.example/live/{task_name}"
    request = {
        "id": f"{task_name}-payment",
        "agentId": f"{task_name}-agent",
        "question": f"Approve {case['item']} from {case['merchant']} for ${case['total'] / 100:.2f}?",
        "metadata": {
            "requestUserApproval": {
                "url": f"https://{case['host']}/checkout/order-123",
                "requestPaymentCard": {
                    "merchant": case["merchant"],
                    "currency": "USD",
                    "lineItems": [
                        {
                            "name": case["item"],
                            "imageUrl": None,
                            "productUrl": f"https://{case['host']}/product",
                            "rating": "0 stars",
                            "reviewCount": "0 reviews",
                            "unitPriceCents": case["total"],
                            "quantity": 1,
                            "lineTotalCents": case["total"],
                        }
                    ],
                    "fees": [],
                    "subtotalCents": case["total"],
                    "totalCents": case["total"],
                    "fingerprint": "b" * 64,
                    "userId": "user-123",
                    "agentId": f"{task_name}-agent",
                },
            },
            "writePermission": True,
        },
    }
    messages = [
        {
            "role": "TOOL",
            "message": "",
            "metadata": {
                "toolName": "spawn_browser_agent",
                "toolStatus": "FINISHED",
                "action_type": "goto",
                "title": f"Navigated → https://{case['navigation_host']}/checkout",
                "subAgentId": browser_scope,
                "browser_url": browser_session,
            },
        },
        {
            "role": "TOOL",
            "message": "",
            "metadata": {
                "toolName": "spawn_browser_agent",
                "toolStatus": "FINISHED",
                "action_type": "request_payment_card",
                "title": f"Requesting payment card for {case['merchant']}",
                "subAgentId": browser_scope,
                "browser_url": browser_session,
            },
        },
    ]
    return request, messages


def test_live_paid_bookings_require_grounded_payment_site():
    """The pending payment approval itself must point at the expected checkout host."""
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _validate_payment_receipt

    for task_name in ("browser-alchemy-springs-sauna", "browser-event-ticket"):
        task = get_task_by_name(task_name)
        request, messages = _captured_live_paid_payment_approval(task_name)
        assert _validate_payment_receipt(task, request, messages=messages) is None

        if task_name == "browser-alchemy-springs-sauna":
            request["metadata"]["requestUserApproval"]["requestPaymentCard"]["merchant"] = (
                "Alchemy Sauna Garden via Momence"
            )
            assert _validate_payment_receipt(task, request, messages=messages) is None

        request["metadata"]["requestUserApproval"]["url"] = "https://checkout.attacker.example/order"
        reason = _validate_payment_receipt(task, request, messages=messages)
        assert reason is not None and "host" in reason


def _amazon_attention_poll_task():
    from dataclasses import replace

    from benchmarks.benchmark_tasks import get_task_by_name

    return replace(
        get_task_by_name("browser-agent-amazon-cookie-payment"),
        expected_tools=[],
        expected_tool_counts=None,
        enforce_declared_evaluators=False,
        evaluators=[],
        timeout_seconds=5,
    )


async def _run_attention_poll(task, requests: list[dict], *, messages: list[dict] | None = None):
    import benchmarks.run_benchmark as bench

    agent_reads = 0
    attention_reads = 0
    responses: list[tuple[str, str]] = []
    agent_id = next(
        (
            request.get("agentId") or request.get("agent_id")
            for request in requests
            if request.get("agentId") or request.get("agent_id")
        ),
        "agent-attention-test",
    )
    root_messages = list(messages or [])

    async def fake_get_agent(_base_url: str, _agent_id: str) -> dict:
        nonlocal agent_reads
        agent_reads += 1
        status = "COMPLETED" if agent_reads > len(requests) else "ACTIVE"
        return {
            "agent": {"status": status, "progress": 1.0},
            "messages": root_messages,
        }

    async def fake_get_attention_requests(_base_url: str) -> list[dict]:
        nonlocal attention_reads
        attention_reads += 1
        if attention_reads <= len(requests):
            return [requests[attention_reads - 1]]
        return []

    async def fake_respond(_base_url: str, request_id: str, response: str) -> None:
        responses.append((request_id, response))

    async def fake_tree_stats(_base_url: str, _agent_id: str) -> dict:
        return {
            "total_messages": len(root_messages),
            "agent_count": 1,
            "total_cost_cents": 0,
            "active_count": 1,
            "failed_count": 0,
            "error_agents": [],
            "all_agents": [
                {
                    "agent_id": agent_id,
                    "status": "ACTIVE",
                    "message_count": len(root_messages),
                }
            ],
        }

    async def fake_message_counts(_base_url: str, _agent_ids: list[str]) -> dict[str, int]:
        return {}

    originals = {
        "get_agent": bench.get_agent,
        "get_attention_requests": bench.get_attention_requests,
        "respond_to_attention_request": bench.respond_to_attention_request,
        "_fetch_tree_stats": bench._fetch_tree_stats,
        "_fetch_message_counts": bench._fetch_message_counts,
        "_detect_infra_errors_from_fly": bench._detect_infra_errors_from_fly,
        "validate_context": bench.validate_context,
        "POLL_INTERVAL": bench.POLL_INTERVAL,
    }
    try:
        bench.get_agent = fake_get_agent
        bench.get_attention_requests = fake_get_attention_requests
        bench.respond_to_attention_request = fake_respond
        bench._fetch_tree_stats = fake_tree_stats
        bench._fetch_message_counts = fake_message_counts
        bench._detect_infra_errors_from_fly = lambda _agent_ids: []
        bench.validate_context = lambda _messages: []
        bench.POLL_INTERVAL = 0
        result = await bench.poll_agent(
            "http://localhost:55120",
            agent_id,
            task,
        )
    finally:
        for name, value in originals.items():
            setattr(bench, name, value)
    return result, responses


async def test_amazon_beanie_poll_rejects_second_or_unrelated_approval_without_resolving_it():
    """The live poll boundary approves one allowed kind and fails closed on every other request."""
    payment = {
        "id": "payment-approval",
        "agentId": "agent-amazon",
        "metadata": {"requestPaymentCard": {}},
    }
    write_lock = {
        "id": "write-lock",
        "agentId": "agent-amazon",
        "metadata": {"requestUserApproval": {"writePermission": True}},
    }
    auth = {
        "id": "auth-assistance",
        "agentId": "agent-amazon",
        "metadata": {"attentionKind": "auth_assistance"},
    }

    (data, triggered, resolved, failure), responses = await _run_attention_poll(
        _amazon_attention_poll_task(),
        [payment, write_lock],
    )
    assert failure is not None and "Expected exactly one attention request" in failure
    assert data["_benchmark"]["attention_kinds_observed"] == [
        "payment_approval",
        "write_lock",
    ]
    assert (triggered, resolved) == (1, 1)
    assert responses == [("payment-approval", "approved")]

    (data, triggered, resolved, failure), responses = await _run_attention_poll(
        _amazon_attention_poll_task(),
        [auth],
    )
    assert failure is not None and "auth_assistance" in failure
    assert data["_benchmark"]["attention_kinds_observed"] == ["auth_assistance"]
    assert (triggered, resolved) == (0, 0)
    assert responses == []


async def test_invalid_payment_receipt_still_records_typed_attention_observation():
    """Receipt validation failures must retain the payment attention that carried them."""
    from dataclasses import replace

    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import evaluate_task

    request, messages = _captured_toast_payment_approval(merchant="Wrong Merchant via Toast")
    task = replace(get_task_by_name("browser-toast-nopa-write-lock"), timeout_seconds=5)

    (data, triggered, resolved, failure), responses = await _run_attention_poll(
        task,
        [request],
        messages=messages,
    )

    assert failure is not None and failure.startswith("merchant mismatch:")
    assert (triggered, resolved) == (1, 0)
    assert responses == []
    assert data["_benchmark"]["attention_request_kind_seen"] == "payment_approval"
    assert data["_benchmark"]["expected_attention_kind_seen"] == "payment_approval"
    assert len(data["_benchmark"]["attention_requests_seen"]) == 1
    assert "expected_payment_receipt_seen" not in data["_benchmark"]
    passed, reason = evaluate_task(task, data, triggered)
    assert passed is False
    assert reason == "Expected validated payment-card request but none was observed"


async def test_live_paid_booking_poll_stops_without_approving_payment():
    """The harness observes the real card gate and returns without answering it."""
    from dataclasses import replace

    from benchmarks.benchmark_tasks import get_task_by_name

    for task_name in ("browser-alchemy-springs-sauna", "browser-event-ticket"):
        request, messages = _captured_live_paid_payment_approval(task_name)
        task = replace(
            get_task_by_name(task_name),
            expected_tools=[],
            expected_tool_counts=None,
            enforce_declared_evaluators=False,
            evaluators=[],
            timeout_seconds=5,
        )

        (data, triggered, resolved, failure), responses = await _run_attention_poll(
            task,
            [request],
            messages=messages,
        )

        assert failure is None
        assert (triggered, resolved) == (1, 0)
        assert responses == []
        assert data["_benchmark"]["expected_attention_kind_seen"] == "payment_approval"
        assert data["_benchmark"]["expected_payment_receipt_seen"] is True

        write_lock = {
            "id": f"{task_name}-write-lock",
            "agentId": request["agentId"],
            "metadata": {"requestUserApproval": {"writePermission": True}},
        }
        (data, triggered, resolved, failure), responses = await _run_attention_poll(
            task,
            [write_lock],
            messages=messages,
        )
        assert failure == "Expected attention kind payment_approval, observed write_lock"
        assert (triggered, resolved) == (0, 0)
        assert responses == []


def test_alchemy_sauna_catalog_stops_at_grounded_payment_approval():
    """Alchemy passes at a detailed, unresolved card request on the right checkout."""
    from copy import deepcopy

    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _run_declared_static_check

    task = get_task_by_name("browser-alchemy-springs-sauna")
    assert "stop at the payment/write-lock" not in task.prompt.lower()
    assert task.prompt.endswith("Complete the booking.")
    assert task.approval_handling == "ignore"
    assert task.expected_attention_kinds == []
    assert task.expected_attention_kind_any_of == []
    assert task.expected_attention_kind == "payment_approval"
    assert task.expected_approval_count == 1
    assert task.success_on_payment_card_request is True
    assert task.expected_payment_receipt["merchant"] == "Alchemy Springs (Momence - momence.com)"
    assert task.expected_payment_receipt["merchantBusinessAliases"] == [
        "Alchemy Springs",
        "Alchemy Sauna Garden",
    ]
    assert task.expected_tool_counts == {"spawn_agent": 1}
    assert task.tool_count_scope == "root"
    assert [evaluator["method"] for evaluator in task.evaluators] == [
        "static_check",
        "single_turn_llm_judge",
    ]

    static_evaluator = task.evaluators[0]
    static_types = {check["type"] for check in static_evaluator["checks"]}
    assert static_types == {
        "no_tool_failures",
        "browser_agent_session_count",
        "expected_payment_receipt",
        "approval_request_count",
        "approval_request_details",
    }
    approval_check = next(check for check in static_evaluator["checks"] if check["type"] == "approval_request_details")
    assert approval_check["required_strings"] == ["Alchemy", "Sauna Garden"]
    assert approval_check["require_date"] is True
    assert approval_check["require_time"] is True
    assert approval_check["require_amount"] is True

    good = {
        "agent": {"status": "ACTIVE"},
        "messages": [
            {
                "role": "TOOL",
                "metadata": {
                    "toolName": "spawn_agent",
                    "agentType": "browser",
                    "toolStatus": "FINISHED",
                    "toolCallId": "alchemy-browser-1",
                },
            }
        ],
        "_benchmark": {
            "approvals_triggered": 1,
            "expected_payment_receipt_seen": True,
            "attention_requests_seen": [
                {
                    "kind": "payment_approval",
                    "question": (
                        "Approve one Alchemy Springs Sauna Garden session on "
                        "Sunday, July 19, 2026 at 10:00 AM for $45.00?"
                    ),
                }
            ],
        },
    }
    assert _run_declared_static_check(static_evaluator, good)[0] is True

    missing_date = deepcopy(good)
    missing_date["_benchmark"]["attention_requests_seen"][0]["question"] = (
        "Approve one Alchemy Springs Sauna Garden session at 10:00 AM for $45.00?"
    )
    passed, reason = _run_declared_static_check(static_evaluator, missing_date)
    assert passed is False
    assert "date" in reason.lower()

    semantic_criteria = " ".join(task.evaluators[1]["criteria"]).lower()
    for requirement in ("earliest available", "10:00 am", "2:00 pm", "payment approval", "unresolved"):
        assert requirement in semantic_criteria


def test_approval_request_details_support_multiple_dates_and_seat():
    """Booking approvals can require both stay dates and an assigned seat."""
    from benchmarks.run_benchmark import _run_declared_static_check

    stay_evaluator = {
        "checks": [
            {
                "type": "approval_request_details",
                "required_strings": ["Hotel Kabuki"],
                "minimum_date_count": 2,
            }
        ]
    }
    complete_stay = {
        "_benchmark": {
            "attention_requests_seen": [
                {
                    "question": "Book Hotel Kabuki?",
                    "checkIn": "2026-07-18",
                    "checkOut": "2026-07-19",
                }
            ]
        }
    }
    assert _run_declared_static_check(stay_evaluator, complete_stay)[0] is True

    incomplete_stay = {
        "_benchmark": {"attention_requests_seen": [{"question": "Book Hotel Kabuki?", "checkIn": "2026-07-18"}]}
    }
    passed, reason = _run_declared_static_check(stay_evaluator, incomplete_stay)
    assert passed is False
    assert "2 calendar dates" in reason.lower()

    seat_evaluator = {
        "checks": [
            {
                "type": "approval_request_details",
                "required_strings": ["AMC Metreon 16"],
                "require_seat": True,
            }
        ]
    }
    assigned_seat = {
        "_benchmark": {"attention_requests_seen": [{"question": "Buy one AMC Metreon 16 ticket in seat H10?"}]}
    }
    assert _run_declared_static_check(seat_evaluator, assigned_seat)[0] is True

    missing_seat = {"_benchmark": {"attention_requests_seen": [{"question": "Buy one AMC Metreon 16 ticket?"}]}}
    passed, reason = _run_declared_static_check(seat_evaluator, missing_seat)
    assert passed is False
    assert "seat" in reason.lower()


def test_hotel_catalog_requires_single_clean_completed_reservation():
    """Hotel booking uses one browser and a complete, grounded approval."""
    from benchmarks.benchmark_tasks import get_task_by_name

    task = get_task_by_name("browser-hotel-booking")
    assert "stop at the payment/write-lock" not in task.prompt.lower()
    assert task.prompt.endswith("Complete the reservation.")
    assert task.approval_handling == "auto_approve"
    assert task.expected_attention_kinds == ["write_lock"]
    assert task.expected_approval_count == 1
    assert task.expected_tool_counts == {"spawn_browser_agent": 1}
    assert task.tool_count_scope == "root"
    assert [evaluator["method"] for evaluator in task.evaluators] == [
        "static_check",
        "single_turn_llm_judge",
    ]
    static_types = {check["type"] for check in task.evaluators[0]["checks"]}
    assert static_types == {
        "no_tool_failures",
        "browser_agent_session_count",
        "agent_status",
        "approval_request_count",
        "approval_request_details",
    }
    approval_check = next(
        check for check in task.evaluators[0]["checks"] if check["type"] == "approval_request_details"
    )
    assert approval_check["required_strings"] == ["Hotel Kabuki", "free cancellation"]
    assert approval_check["minimum_date_count"] == 2
    assert approval_check["require_amount"] is True
    semantic_criteria = " ".join(task.evaluators[1]["criteria"]).lower()
    for requirement in ("lowest-priced", "free cancellation", "completed", "confirmation"):
        assert requirement in semantic_criteria


def test_event_ticket_catalog_stops_at_grounded_payment_approval():
    """Movie ticketing passes at a detailed, unresolved AMC card request."""
    from benchmarks.benchmark_tasks import get_task_by_name

    task = get_task_by_name("browser-event-ticket")
    assert "stop at the payment/write-lock" not in task.prompt.lower()
    assert task.prompt.endswith("Complete the ticket purchase.")
    assert task.approval_handling == "ignore"
    assert task.expected_attention_kinds == []
    assert task.expected_attention_kind_any_of == []
    assert task.expected_attention_kind == "payment_approval"
    assert task.expected_approval_count == 1
    assert task.success_on_payment_card_request is True
    assert task.expected_payment_receipt["merchant"] == "AMC Theatres (direct - amctheatres.com)"
    assert task.expected_tool_counts == {"spawn_agent": 1}
    assert task.tool_count_scope == "root"
    assert [evaluator["method"] for evaluator in task.evaluators] == [
        "static_check",
        "single_turn_llm_judge",
    ]
    approval_check = next(
        check for check in task.evaluators[0]["checks"] if check["type"] == "approval_request_details"
    )
    assert approval_check["required_strings"] == ["AMC Metreon 16"]
    assert approval_check["require_date"] is True
    assert approval_check["require_time"] is True
    assert approval_check["require_amount"] is True
    assert approval_check["require_seat"] is True
    static_types = {check["type"] for check in task.evaluators[0]["checks"]}
    assert "expected_payment_receipt" in static_types
    assert "agent_status" not in static_types
    semantic_criteria = " ".join(task.evaluators[1]["criteria"]).lower()
    for requirement in ("earliest", "center", "payment approval", "unresolved"):
        assert requirement in semantic_criteria


def test_amazon_return_catalog_requires_single_clean_completed_return():
    """Amazon returns complete after one approval instead of stopping at it."""
    from benchmarks.benchmark_tasks import get_task_by_name

    task = get_task_by_name("browser-amazon-return")
    assert "stop at the final write-lock" not in task.prompt.lower()
    assert task.prompt.endswith("Otherwise, complete the return.")
    assert task.approval_handling == "auto_approve"
    assert task.expected_attention_kinds == ["write_lock"]
    assert task.expected_approval_count == 1
    assert task.expected_tool_counts == {"spawn_browser_agent": 1}
    assert task.tool_count_scope == "root"
    assert [evaluator["method"] for evaluator in task.evaluators] == [
        "static_check",
        "single_turn_llm_judge",
    ]
    approval_check = next(
        check for check in task.evaluators[0]["checks"] if check["type"] == "approval_request_details"
    )
    assert approval_check["required_strings"] == [
        "return",
        "original payment method",
        "drop-off",
    ]
    assert approval_check["require_amount"] is True
    semantic_criteria = " ".join(task.evaluators[1]["criteria"]).lower()
    for requirement in ("most recent", "completed", "confirmation"):
        assert requirement in semantic_criteria


def test_live_fixture_fails_when_live_auth_refresh_fails():
    """A live benchmark never starts with missing/stale browser auth."""
    import os

    import benchmarks.run_benchmark as bench

    original_compute = bench._sync_compute_tokens
    original_browser = bench._sync_browser_credentials
    original_mode = os.environ.get("BENCHMARK_WORLD_MODEL_MODE")
    raised = False
    try:
        os.environ["BENCHMARK_WORLD_MODEL_MODE"] = "real"
        # Mirror the real signatures: _apply_live_fixture calls
        # _sync_compute_tokens(tolerate_gpt_code_unavailable=True) and
        # _sync_browser_credentials(ctx.cookie_domains).
        bench._sync_compute_tokens = lambda **_: True
        bench._sync_browser_credentials = lambda *_a, **_k: False
        bench._apply_live_fixture(
            bench.LiveFixtureContext(
                base_url="http://localhost:54121",
                user_id="user-123",
                auth_realm="amazon.com",
            )
        )
    except RuntimeError as exc:
        raised = "browser auth" in str(exc).lower()
    finally:
        bench._sync_compute_tokens = original_compute
        bench._sync_browser_credentials = original_browser
        if original_mode is None:
            os.environ.pop("BENCHMARK_WORLD_MODEL_MODE", None)
        else:
            os.environ["BENCHMARK_WORLD_MODEL_MODE"] = original_mode

    assert raised, "live fixture must fail closed when credential refresh fails"


def test_compute_token_sync_passes_explicit_prod_source_without_shared_workspace():
    """Cloud guests must pass seed-local an explicit production token source."""
    from unittest.mock import patch

    import benchmarks.run_benchmark as bench

    captured = {}

    def capture_seed(_command, **kwargs):
        captured["env"] = kwargs["env"]
        return subprocess.CompletedProcess(_command, 0, "", "")

    local_url = "postgresql://local/victoria"
    prod_url = "postgresql://prod/rose"
    with (
        patch.object(bench, "_local_victoria_database_url", return_value=local_url),
        patch.object(bench, "_shared_workspace_database_url", return_value=None),
        patch.object(bench, "load_env_var", return_value=prod_url),
        patch.object(bench, "_run_seed_subprocess", side_effect=capture_seed),
    ):
        assert bench._sync_compute_tokens(tolerate_gpt_code_unavailable=True) is True

    assert captured["env"]["DATABASE_URL"] == local_url
    assert captured["env"]["DIRECT_URL"] == local_url
    assert captured["env"]["SEED_COMPUTE_TOKEN_SOURCE_DATABASE_URL"] == prod_url


def test_shared_workspace_compute_source_requires_usable_claude_code():
    """A reachable shared DB without an agent token must not shadow prod."""
    from unittest.mock import patch

    import benchmarks.run_benchmark as bench

    with tempfile.TemporaryDirectory() as temp_dir:
        root = Path(temp_dir)
        shared_context = root / ".context"
        shared_context.mkdir()
        (shared_context / "services.json").write_text(
            '{"status":"running","database":{"port":55135,"use_system_postgres":false}}'
        )
        isolated_context = shared_context / "benchmarks" / "isolated"
        commands = []

        def fake_run(command, **_kwargs):
            commands.append(command)
            sql = command[-1]
            stdout = "f\n" if 'FROM "Integration"' in sql else "1\n"
            return subprocess.CompletedProcess(command, 0, stdout, "")

        with (
            patch.object(bench, "REPO_ROOT", root),
            patch.object(bench, "_benchmark_context_path", return_value=isolated_context),
            patch.object(bench.subprocess, "run", side_effect=fake_run),
        ):
            assert bench._shared_workspace_database_url() is None

        assert any('FROM "Integration"' in command[-1] for command in commands)


def test_compute_token_source_contract_preserves_prisma_dsn_and_rejects_self_source():
    """Source selection ignores ambient state and never rewrites or self-syncs a DSN."""
    from unittest.mock import patch

    import benchmarks.run_benchmark as bench

    captured = {}

    def capture_seed(_command, **kwargs):
        captured["env"] = kwargs["env"]
        return subprocess.CompletedProcess(_command, 0, "", "")

    with tempfile.TemporaryDirectory() as temp_dir:
        env_path = Path(temp_dir) / ".env"
        prisma_source = (
            "postgresql://prod-user:secret@pooler.example.com:6543/rose"
            "?pgbouncer=true&connection_limit=20&pool_timeout=30"
        )
        env_path.write_text(f"DATABASE_URL={prisma_source}\n")
        with (
            patch.dict(
                os.environ,
                {
                    "DATABASE_URL": "postgresql://ambient/local",
                    "SEED_COMPUTE_TOKEN_SOURCE_DATABASE_URL": "postgresql://stale/source",
                },
            ),
            patch.object(bench, "_BACKEND_ENV", str(env_path)),
            patch.object(
                bench,
                "_local_victoria_database_url",
                return_value="postgresql://local/victoria",
            ),
            patch.object(bench, "_shared_workspace_database_url", return_value=None),
            patch.object(bench, "_run_seed_subprocess", side_effect=capture_seed),
        ):
            assert bench._sync_compute_tokens(tolerate_gpt_code_unavailable=True) is True

        assert captured["env"]["SEED_COMPUTE_TOKEN_SOURCE_DATABASE_URL"] == prisma_source

        same_database_source = (
            "postgres://source-user:one@DB.EXAMPLE.COM/victoria"
            "?sslmode=require&application_name=seed&schema=public"
        )
        env_path.write_text(f"DATABASE_URL={same_database_source}\n")
        seed_called = False

        def reject_seed(*_args, **_kwargs):
            nonlocal seed_called
            seed_called = True
            raise AssertionError("self-source must be rejected before seed-local starts")

        with (
            patch.object(bench, "_BACKEND_ENV", str(env_path)),
            patch.object(
                bench,
                "_local_victoria_database_url",
                return_value=(
                    "postgresql://target-user:two@db.example.com:5432/victoria"
                    "?connection_limit=50&pool_timeout=30"
                ),
            ),
            patch.object(bench, "_shared_workspace_database_url", return_value=None),
            patch.object(bench, "_run_seed_subprocess", side_effect=reject_seed),
        ):
            assert bench._sync_compute_tokens(tolerate_gpt_code_unavailable=True) is False

        assert seed_called is False

    assert bench._database_urls_equivalent(
        "postgres://one:first@DB.EXAMPLE.COM/victoria?sslmode=require",
        "postgresql://two:second@db.example.com:5432/victoria?application_name=bench",
    )
    assert not bench._database_urls_equivalent(
        "postgresql://one:first@db.example.com:5432/victoria",
        "postgresql://two:second@db.example.com:5432/other",
    )


def test_expected_passkey_credential_ref_is_required_even_when_approval_is_terminal():
    """A passkey benchmark cannot pass from checkout state alone."""
    from benchmarks.benchmark_tasks import BenchmarkTask
    from benchmarks.run_benchmark import evaluate_task

    task = BenchmarkTask(
        name="amazon-passkey-terminal",
        title="Amazon Passkey Terminal",
        prompt="",
        timeout_seconds=1,
        is_chat_mode=False,
        expected_tools=[],
        tags=[],
        price_limit_cents=100,
        requires_browser_agent=True,
        requires_claude_code=False,
        attachment=None,
        approval_handling="ignore",
        start_phase="execute",
        expected_attention_kind="payment_approval",
        expected_credential_ref_kind="passkey",
        forbidden_credential_ref_kinds=["password", "email_otp", "sms_otp"],
        expected_browser_provider="kernel",
        expected_browser_session_metadata_values={
            "profile_source": "new_user_persistent",
            "auth_source": "none",
            "cookies_injected": False,
            "cookies_count": 0,
            "local_storage_origin_count": 0,
            "indexed_db_origin_count": 0,
            "permission_grant_count": 0,
            "cache_storage_origin_count": 0,
        },
        expected_pre_credential_message_contains=["Hello, sign in"],
        expected_post_credential_message_contains=["Hello, Andy"],
        success_on_browser_auth_evidence=True,
    )
    base_data = {
        "agent": {"status": "ACTIVE", "progress": 0.01},
        "_benchmark": {"expected_attention_kind_seen": "payment_approval"},
    }
    with_passkey = {
        **base_data,
        "messages": [
            {
                "role": "TOOL",
                "message": "",
                "metadata": {
                    "subAgentId": "browser-task-1",
                    "browser_url": "https://kernel.example/live/session-1",
                    "browser_session_metadata": {
                        "provider": "kernel",
                        "profile_source": "new_user_persistent",
                        "auth_source": "none",
                        "cookies_injected": False,
                        "cookies_count": 0,
                        "local_storage_origin_count": 0,
                        "indexed_db_origin_count": 0,
                        "permission_grant_count": 0,
                        "cache_storage_origin_count": 0,
                    },
                },
            },
            {
                "role": "TOOL",
                "message": "",
                "metadata": {
                    "subAgentId": "browser-task-1",
                    "title": 'Clicking <a "Hello, sign in Account & Lists">',
                    "toolStatus": "FINISHED",
                    "action_type": "click",
                    "browser_url": "https://kernel.example/live/session-1",
                },
            },
            {
                "role": "TOOL",
                "metadata": {
                    "subAgentId": "browser-task-1",
                    "toolName": "browser_session_auth",
                    "browser_url": "https://kernel.example/live/session-1",
                    "credential_ref": {"kind": "passkey", "id": "passkey-row"},
                },
            },
            {
                "role": "TOOL",
                "text": "DOM shows Hello, Andy / Account & Lists",
                "metadata": {
                    "subAgentId": "browser-task-1",
                    "title": 'Clicking <a "Hello, Andy Account & Lists">',
                    "toolStatus": "FINISHED",
                    "action_type": "click",
                    "browser_url": "https://kernel.example/live/session-1",
                },
            },
        ],
    }
    without_passkey = {**base_data, "messages": []}

    assert evaluate_task(task, with_passkey, approvals_triggered=1) == (True, None)
    passed, reason = evaluate_task(task, without_passkey, approvals_triggered=1)
    assert passed is False
    assert reason == "Expected credential_ref kind passkey but none was observed"

    wrong_provider = {
        **base_data,
        "messages": [
            {
                "role": "TOOL",
                "metadata": {
                    "subAgentId": "browser-task-1",
                    "credential_ref": {"kind": "passkey", "id": "passkey-row"},
                    "browser_session_metadata": {"provider": "steel"},
                },
            }
        ],
    }
    passed, reason = evaluate_task(task, wrong_provider, approvals_triggered=1)
    assert passed is False
    assert reason == "Expected browser provider kernel but observed: steel"

    split_browser_tasks = {
        **base_data,
        "messages": [
            {
                "role": "TOOL",
                "metadata": {
                    "subAgentId": "kernel-task",
                    "browser_url": "https://kernel.example/live/session-a",
                    "browser_session_metadata": {"provider": "kernel"},
                },
            },
            {
                "role": "TOOL",
                "metadata": {
                    "subAgentId": "passkey-task",
                    "browser_url": "https://kernel.example/live/session-b",
                    "credential_ref": {"kind": "passkey", "id": "passkey-row"},
                },
            },
        ],
    }
    passed, reason = evaluate_task(task, split_browser_tasks, approvals_triggered=1)
    assert passed is False
    assert reason == "Expected browser provider kernel and credential_ref kind passkey on the same browser session"

    password_fallback = {
        **with_passkey,
        "messages": [
            *with_passkey["messages"],
            {
                "role": "TOOL",
                "metadata": {
                    "subAgentId": "browser-task-1",
                    "browser_url": "https://kernel.example/live/session-1",
                    "credential_ref": {"kind": "password", "id": "password-row"},
                },
            },
        ],
    }
    passed, reason = evaluate_task(task, password_fallback, approvals_triggered=1)
    assert passed is False
    assert reason == "Observed forbidden credential_ref kind(s): password"

    no_authenticated_page = {
        **with_passkey,
        "messages": [
            with_passkey["messages"][0],
            with_passkey["messages"][1],
            with_passkey["messages"][2],
        ],
    }
    passed, reason = evaluate_task(task, no_authenticated_page, approvals_triggered=1)
    assert passed is False
    assert reason == "Expected authenticated page evidence after passkey use was not observed"

    typed_greeting_is_not_page_evidence = {
        **with_passkey,
        "messages": [
            with_passkey["messages"][0],
            with_passkey["messages"][1],
            with_passkey["messages"][2],
            {
                **with_passkey["messages"][3],
                "metadata": {
                    **with_passkey["messages"][3]["metadata"],
                    "title": "Typed 'Hello, Andy' into Amazon search",
                    "action_type": "input_text",
                },
            },
        ],
    }
    passed, reason = evaluate_task(task, typed_greeting_is_not_page_evidence, approvals_triggered=1)
    assert passed is False
    assert reason == "Expected authenticated page evidence after passkey use was not observed"

    detached_authenticated_result = {
        **with_passkey,
        "messages": [
            with_passkey["messages"][0],
            with_passkey["messages"][1],
            {
                "role": "TOOL",
                "metadata": with_passkey["messages"][2]["metadata"],
            },
            {
                "role": "TOOL",
                "text": "DOM shows Hello, Andy / Account & Lists",
                "metadata": {
                    "subAgentId": "browser-task-1",
                    "title": 'Clicking <a "Hello, Andy Account & Lists">',
                    "toolStatus": "FINISHED",
                    "action_type": "click",
                    "browser_url": "https://kernel.example/live/session-2",
                },
            },
        ],
    }
    passed, reason = evaluate_task(task, detached_authenticated_result, approvals_triggered=1)
    assert passed is False
    assert reason == "Expected authenticated page evidence after passkey use was not observed"

    reused_kernel_profile = {
        **with_passkey,
        "messages": [
            {
                **with_passkey["messages"][0],
                "metadata": {
                    **with_passkey["messages"][0]["metadata"],
                    "browser_session_metadata": {
                        **with_passkey["messages"][0]["metadata"]["browser_session_metadata"],
                        "profile_source": "user_persistent",
                    },
                },
            },
            with_passkey["messages"][1],
            with_passkey["messages"][2],
            with_passkey["messages"][3],
        ],
    }
    passed, reason = evaluate_task(task, reused_kernel_profile, approvals_triggered=1)
    assert passed is False
    assert reason == "Expected isolated browser session metadata was not observed"

    no_signed_out_precondition = {
        **with_passkey,
        "messages": [
            with_passkey["messages"][0],
            {
                **with_passkey["messages"][1],
                "metadata": {
                    **with_passkey["messages"][1]["metadata"],
                    "title": "Navigated to Amazon",
                },
            },
            with_passkey["messages"][2],
            with_passkey["messages"][3],
        ],
    }
    passed, reason = evaluate_task(task, no_signed_out_precondition, approvals_triggered=1)
    assert passed is False
    assert reason == "Expected signed-out evidence before passkey use was not observed"

    instruction_only_precondition = {
        **with_passkey,
        "messages": [
            with_passkey["messages"][0],
            {
                **with_passkey["messages"][1],
                "text": "Task: first confirm Hello, sign in, then authenticate",
                "metadata": {
                    **with_passkey["messages"][1]["metadata"],
                    "title": "Task Started",
                    "action_type": "task_started",
                },
            },
            with_passkey["messages"][2],
            with_passkey["messages"][3],
        ],
    }
    passed, reason = evaluate_task(task, instruction_only_precondition, approvals_triggered=1)
    assert passed is False
    assert reason == "Expected signed-out evidence before passkey use was not observed"

    fetched_but_unused_otp = {
        **with_passkey,
        "messages": [
            *with_passkey["messages"],
            {
                "role": "USER",
                "metadata": {
                    "subAgentId": "browser-task-1",
                    "credential_ref": {"kind": "email_otp", "id": "email-row"},
                },
            },
        ],
    }
    assert evaluate_task(task, fetched_but_unused_otp, approvals_triggered=1) == (True, None)


def test_cached_sub_agent_child_tool_counts_are_counted_once():
    """Fast Mode sub-agent result replay preserves logical child tool counts."""
    from benchmarks.run_benchmark import _count_logical_tool_calls_from_messages

    messages = [
        {
            "metadata": {
                "toolName": "spawn_general_purpose_agent",
                "toolStatus": "FINISHED",
                "toolCallId": "spawn-1",
                "fromFastCache": True,
                "childToolCounts": {"web_search": 2},
            }
        },
        {
            "metadata": {
                "toolName": "spawn_general_purpose_agent",
                "toolStatus": "FINISHED",
                "toolCallId": "spawn-2",
                "childToolCounts": {"web_search": 99},
            }
        },
    ]

    assert _count_logical_tool_calls_from_messages(messages) == {
        "spawn_general_purpose_agent": 2,
        "web_search": 2,
    }


def test_timeout_default_uses_task_config_when_history_is_missing():
    """Tasks without enough history still get a runnable configured timeout."""
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _default_timeout_for_task

    task = get_task_by_name("chat-mode")

    assert task.timeout_seconds == 120
    assert _default_timeout_for_task(task) == 120


def test_timeout_default_respects_explicit_floor():
    """Configured fallback timeouts still honor task-specific minimum floors."""
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _default_timeout_for_task

    task = get_task_by_name("outreach-batch")

    assert _default_timeout_for_task(task, max_seconds=120) == 600


def test_fast_mode_pass_does_not_seed_timeout_history():
    """Fast-mode smoke passes must not tighten cold-cache timeout pXX ranges."""
    import benchmarks.timeout_history as timeout_history
    from benchmarks.results import BenchmarkRun, TaskResult

    recorded = []
    attempts = []
    original_record_pass = timeout_history.record_pass
    original_record_attempt = timeout_history.record_attempt
    try:
        timeout_history.record_pass = lambda **kwargs: recorded.append(kwargs)
        timeout_history.record_attempt = lambda **kwargs: attempts.append(kwargs)

        run = BenchmarkRun(suite="smoke", base_url="https://navi-j9a9.onrender.com")
        run.task_results.append(
            TaskResult(
                name="chat-mode",
                passed=True,
                agent_id="agent-fast",
                status="COMPLETED",
                progress_score=1.0,
                duration_seconds=3.0,
                cost_cents=1.0,
                message_count=1,
                fast_mode_cache_enabled=True,
            )
        )

        run._record_history()
    finally:
        timeout_history.record_pass = original_record_pass
        timeout_history.record_attempt = original_record_attempt

    assert recorded == []
    # ...but the attempt is still recorded in the run-stats ledger
    assert len(attempts) == 1 and attempts[0]["fast_mode_cache_enabled"] is True


def test_non_fast_mode_pass_still_seeds_timeout_history():
    """Cold-cache passes still update the timeout pXX corpus."""
    import benchmarks.timeout_history as timeout_history
    from benchmarks.results import BenchmarkRun, TaskResult

    recorded = []
    attempts = []
    original_record_pass = timeout_history.record_pass
    original_record_attempt = timeout_history.record_attempt
    try:
        timeout_history.record_pass = lambda **kwargs: recorded.append(kwargs)
        timeout_history.record_attempt = lambda **kwargs: attempts.append(kwargs)

        run = BenchmarkRun(suite="smoke", base_url="https://navi-j9a9.onrender.com")
        run.task_results.append(
            TaskResult(
                name="chat-mode",
                passed=True,
                agent_id="agent-cold",
                status="COMPLETED",
                progress_score=1.0,
                duration_seconds=42.0,
                cost_cents=1.0,
                message_count=1,
                fast_mode_cache_enabled=False,
            )
        )

        run._record_history()
    finally:
        timeout_history.record_pass = original_record_pass
        timeout_history.record_attempt = original_record_attempt

    assert recorded == [
        {
            "task_name": "chat-mode",
            "duration_seconds": 42.0,
            "cost_cents": 1.0,
            "agent_id": "agent-cold",
            "timestamp": run.timestamp,
        }
    ]
    assert len(attempts) == 1 and attempts[0]["passed"] is True


def test_benchmark_run_serializes_world_model_fidelity_and_ignores_unknown_task_fields():
    """Run JSON keeps WMH fidelity reports and remains forward-compatible."""
    import json
    import tempfile
    from pathlib import Path

    from benchmarks.results import BenchmarkRun, TaskResult

    run = BenchmarkRun(suite="wmh", base_url="http://localhost:3001")
    run.task_results.append(
        TaskResult(
            name="chat-mode",
            passed=True,
            agent_id="agent-wmh",
            status="COMPLETED",
            progress_score=1.0,
            duration_seconds=1.0,
            cost_cents=0.0,
            message_count=1,
            archive_manifest_ref="trace-archive/agent-wmh/manifest.json.gz.enc",
            world_model_fidelity={
                "status": "scored",
                "mean_score": 0.9,
                "n_steps": 2,
                "dimensions": {"schema_validity": 1.0},
            },
            world_model_mode="simulate",
            payment_lifecycle={
                "purchase": {"status": "VOIDED"},
                "orgTransfer": {"status": "reclaimed", "releasedCents": 4396},
            },
        )
    )
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "run.json"
        path.write_text(json.dumps(run.to_dict()))
        data = json.loads(path.read_text())
        data["tasks"][0]["future_field"] = "ignored"
        path.write_text(json.dumps(data))
        loaded = BenchmarkRun.load(str(path))

    assert loaded.task_results[0].world_model_fidelity["status"] == "scored"
    assert loaded.task_results[0].world_model_fidelity["mean_score"] == 0.9
    assert loaded.task_results[0].world_model_mode == "simulate"
    assert loaded.task_results[0].archive_manifest_ref.endswith("manifest.json.gz.enc")
    assert loaded.task_results[0].payment_lifecycle["purchase"]["status"] == "VOIDED"
    assert loaded.task_results[0].payment_lifecycle["orgTransfer"]["releasedCents"] == 4396


def test_minted_benchmark_cleanup_preserves_cached_agent_identity_by_default():
    """Repeated live minted-account benchmarks should not buy a fresh AgentPhone number."""
    import benchmarks.run_benchmark as bench

    queries = []
    original_run_sql = bench._run_local_victoria_sql

    try:
        bench._run_local_victoria_sql = lambda sql: queries.append(sql) or "2"

        assert bench._delete_local_minted_accounts_for_user("user-123") == 2
    finally:
        bench._run_local_victoria_sql = original_run_sql

    assert len(queries) == 1
    assert 'DELETE FROM "MintedAccount"' in queries[0]
    assert 'DELETE FROM "AgentIdentity"' not in queries[0]


def test_minted_benchmark_cleanup_can_reset_agent_identity_when_explicit():
    """First-provisioning benchmark runs can opt into deleting the cached identity."""
    import benchmarks.run_benchmark as bench

    queries = []
    original_run_sql = bench._run_local_victoria_sql

    try:
        bench._run_local_victoria_sql = lambda sql: queries.append(sql) or "1"

        assert bench._delete_local_minted_accounts_for_user("user-123", reset_agent_identity=True) == 1
    finally:
        bench._run_local_victoria_sql = original_run_sql

    assert len(queries) == 1
    assert 'DELETE FROM "MintedAccount"' in queries[0]
    assert 'DELETE FROM "AgentIdentity"' in queries[0]


def test_minted_benchmark_seeds_cached_agent_identity_when_missing():
    """Fresh local DBs reuse the benchmark primitive inbox/AgentPhone instead of re-minting."""
    import benchmarks.run_benchmark as bench

    queries = []
    original_run_sql = bench._run_local_victoria_sql

    def fake_sql(sql):
        queries.append(sql)
        if 'SELECT 1 FROM "AgentIdentity"' in sql:
            return ""
        if 'INSERT INTO "AgentIdentity"' in sql:
            return "rose.harbor47@mail.roselabs.ai"
        raise AssertionError(f"unexpected SQL: {sql}")

    try:
        bench._run_local_victoria_sql = fake_sql
        seeded = bench._seed_local_benchmark_agent_identity_if_missing("user-123")
    finally:
        bench._run_local_victoria_sql = original_run_sql

    assert seeded == "rose.harbor47@mail.roselabs.ai"
    assert len(queries) == 2
    assert 'INSERT INTO "AgentIdentity"' in queries[1]
    assert "rose.harbor47@mail.roselabs.ai" in queries[1]
    assert "+19123613984" in queries[1]
    assert '"phoneProvider"' in queries[1]
    assert "agentphone" in queries[1]


def test_minted_benchmark_does_not_seed_cached_agent_identity_when_present():
    """Existing cached identities remain owned by the local DB."""
    import benchmarks.run_benchmark as bench

    queries = []
    original_run_sql = bench._run_local_victoria_sql

    def fake_sql(sql):
        queries.append(sql)
        if 'SELECT 1 FROM "AgentIdentity"' in sql:
            return "1"
        raise AssertionError(f"unexpected SQL: {sql}")

    try:
        bench._run_local_victoria_sql = fake_sql
        assert bench._seed_local_benchmark_agent_identity_if_missing("user-123") is None
    finally:
        bench._run_local_victoria_sql = original_run_sql

    assert len(queries) == 1
    assert 'SELECT 1 FROM "AgentIdentity"' in queries[0]


def test_agent_sms_benchmark_prepares_phone_only_agentphone_sender():
    """The real Agent SMS bench replaces stale selectors with its live from_number."""
    import benchmarks.run_benchmark as bench

    original_seed = bench._seed_local_benchmark_agent_identity_if_missing
    original_sql = bench._run_local_victoria_sql
    try:
        bench._seed_local_benchmark_agent_identity_if_missing = lambda user_id: "rose@example.test"
        queries = []
        bench._run_local_victoria_sql = lambda sql: queries.append(sql) or "ready"
        assert bench._prepare_local_agent_sms_sender("user-123") == "rose@example.test"
        assert len(queries) == 2
        assert "phone = '+19123613984'" in queries[0]
        assert '"phoneProviderAgentId" = NULL' in queries[0]
        assert '"phoneProviderNumberId" = NULL' in queries[0]
        assert "\"userId\" = 'user-123'" in queries[0]

        responses = iter(["1", "invalid"])
        bench._run_local_victoria_sql = lambda sql: next(responses)
        try:
            bench._prepare_local_agent_sms_sender("user-123")
        except RuntimeError as error:
            assert "sender selector" in str(error)
        else:
            raise AssertionError("missing AgentPhone sender selector was accepted")
    finally:
        bench._seed_local_benchmark_agent_identity_if_missing = original_seed
        bench._run_local_victoria_sql = original_sql


def test_minted_x_benchmark_uses_live_x_default_target():
    """The X minted-account benchmark points at the real site, not the local Uber fixture."""
    from benchmarks.benchmark_tasks import get_task_by_name
    import benchmarks.run_benchmark as bench

    task = get_task_by_name("minted-agent-accounts-x")

    assert task.name in bench.MINTED_AGENT_ACCOUNT_TASK_NAMES
    assert task.prompt == "Make a post on X.com that says, Hello World"
    assert bench.MINTED_AGENT_ACCOUNT_X_POST_GOAL == task.prompt
    assert bench._default_minted_target_url("http://localhost:56151", task.name) == "https://x.com"
    assert bench._auth_realm_from_target_url("https://x.com") == "x.com"
    assert bench._site_label_from_realm("x.com") == "X"


def test_minted_x_signup_evidence_rejects_terminal_phone_blocker():
    """X benchmark must not treat a minted row alone as account-creation proof."""
    import benchmarks.run_benchmark as bench

    blocker = "X forced phone auth. Final DOM showed: An unexpected error occurred. Please try again."
    success = "Account creation completed and the account is signed in on the home timeline."

    assert bench._x_signup_has_terminal_phone_blocker(blocker) is True
    assert bench._x_signup_has_account_creation_evidence(blocker) is False
    assert bench._x_signup_has_terminal_phone_blocker(success) is False
    assert bench._x_signup_has_account_creation_evidence(success) is True


def test_amazon_passkey_scenario_isolates_passkey_and_fresh_kernel_profile():
    """Passkey scenario setup syncs its key and snapshots destructive state."""
    import benchmarks.run_benchmark as bench

    queries = []
    sync_calls = []
    sql_results = iter(
        [
            '{"steel_ids": [], "bundle_ids": [], "password_ids": [], "profiles": []}',
            "1",
            "10",
        ]
    )
    original_run_sql = bench._run_local_victoria_sql
    original_sync_passkeys = bench._sync_passkeys
    original_subprocess_run = bench.subprocess.run
    try:
        bench._sync_passkeys = lambda: sync_calls.append("passkeys")
        bench.subprocess.run = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("fixture bypassed _sync_passkeys")
        )
        bench._run_local_victoria_sql = lambda sql: queries.append(sql) or next(sql_results)
        manifest = bench._apply_amazon_passkey_scenario(
            bench.LiveFixtureContext(
                base_url="http://localhost:54121",
                user_id="user-123",
                auth_realm="amazon.com",
            )
        )
    finally:
        bench._run_local_victoria_sql = original_run_sql
        bench._sync_passkeys = original_sync_passkeys
        bench.subprocess.run = original_subprocess_run

    assert manifest == {
        "scenario": "amazon_passkey",
        "passkey_count": 1,
        "cleared": 10,
        "user_id": "user-123",
        "auth_realm": "amazon.com",
        "restore_snapshot": {
            "steel_ids": [],
            "bundle_ids": [],
            "password_ids": [],
            "profiles": [],
        },
    }
    assert sync_calls == ["passkeys"]
    assert len(queries) == 3
    assert 'FROM "SteelSessionAuth"' in queries[0]
    assert 'FROM "CookieBundle"' in queries[0]
    assert 'FROM "BrowserPassword"' in queries[0]
    assert 'FROM "PasskeyCredential"' in queries[1]
    assert 'UPDATE "PasskeyCredential"' not in queries[1]
    cleanup_sql = queries[2]
    assert 'UPDATE "SteelSessionAuth"' in cleanup_sql
    assert 'UPDATE "CookieBundle"' in cleanup_sql
    assert 'UPDATE "BrowserPassword"' in cleanup_sql
    assert 'DELETE FROM "Cookie"' in cleanup_sql
    assert 'DELETE FROM "LocalStorageOrigin"' in cleanup_sql
    assert 'DELETE FROM "IndexedDBOrigin"' in cleanup_sql
    assert 'DELETE FROM "BrowserPermission"' in cleanup_sql
    assert 'DELETE FROM "CacheStorageOrigin"' in cleanup_sql
    assert 'DELETE FROM "BrowserProviderProfile"' in cleanup_sql
    assert "amazon.com" in cleanup_sql


def test_amazon_passkey_catalog_requires_live_passkey_kernel_evidence():
    """The catalog exposes a dedicated live Kernel/passkey Amazon benchmark."""
    from benchmarks.benchmark_tasks import get_task_by_name

    task = get_task_by_name("browser-agent-amazon-passkey")

    assert task.environment["live_fixtures"] == ["live"]
    assert task.expected_browser_provider == "kernel"
    assert task.expected_credential_ref_kind == "passkey"
    assert task.expected_browser_session_metadata_values == {
        "profile_source": "new_user_persistent",
        "auth_source": "none",
        "cookies_injected": False,
        "cookies_count": 0,
        "local_storage_origin_count": 0,
        "indexed_db_origin_count": 0,
        "permission_grant_count": 0,
        "cache_storage_origin_count": 0,
    }
    assert task.expected_pre_credential_message_contains == ["Hello, sign in"]
    assert task.expected_post_credential_message_contains == ["Hello, Andy"]
    assert task.success_on_browser_auth_evidence is True
    assert task.forbidden_credential_ref_kinds == ["password", "email_otp", "sms_otp"]
    assert task.expected_structured_response_values is None
    assert task.expected_structured_response_contains is None
    assert task.required_structured_response_fields == []
    assert task.evaluators[0]["method"] == "static_check"
    assert task.expected_attention_kind is None
    assert task.approval_handling is None
    assert "password" in task.prompt.lower()
    assert "otp" in task.prompt.lower()


def test_webdecoy_biometrics_uses_fresh_isolated_browser_state():
    """Public biometrics probes must not inherit the user's saved browser identity."""
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks import run_benchmark as bench

    task = get_task_by_name("browser-biometrics-webdecoy")
    assert getattr(task, "browser_profile_mode", None) == "fresh"
    assert getattr(task, "browser_auth_realm", None) == "webdecoy.com"
    assert task.name in bench.EXCLUSIVE_SHARED_DB_TASK_NAMES
    assert task.expected_browser_session_metadata_values == {
        "profile_source": "new_user_persistent",
        "auth_source": "none",
        "cookies_injected": False,
        "cookies_count": 0,
        "local_storage_origin_count": 0,
        "indexed_db_origin_count": 0,
        "permission_grant_count": 0,
        "cache_storage_origin_count": 0,
    }

    snapshot = {
        "steel_ids": ["steel-webdecoy"],
        "bundle_ids": ["bundle-webdecoy"],
        "password_ids": [],
        "profiles": [
            {
                "id": "profile-row",
                "contextId": "context-row",
                "provider": "kernel",
                "profileId": "persisted-kernel-profile",
            }
        ],
    }
    sql_calls = []
    responses = iter([json.dumps(snapshot), "7"])
    original_sql = bench._run_local_victoria_sql
    try:
        bench._run_local_victoria_sql = lambda sql: (sql_calls.append(sql), next(responses))[1]
        manifest = bench._apply_fresh_browser_state_scenario(
            bench.LiveFixtureContext(
                base_url="http://localhost:3001",
                user_id=bench.USER_ID,
                auth_realm="webdecoy.com",
            )
        )
    finally:
        bench._run_local_victoria_sql = original_sql

    assert manifest["scenario"] == "fresh_browser_state"
    assert manifest["auth_realm"] == "webdecoy.com"
    assert manifest["cleared"] == 7
    cleanup_sql = sql_calls[1]
    assert 'UPDATE "CookieBundle"' in cleanup_sql
    assert 'UPDATE "SteelSessionAuth"' in cleanup_sql
    assert 'DELETE FROM "Cookie"' in cleanup_sql
    assert 'DELETE FROM "LocalStorageOrigin"' in cleanup_sql
    assert 'DELETE FROM "IndexedDBOrigin"' in cleanup_sql
    assert 'DELETE FROM "CacheStorageOrigin"' in cleanup_sql
    assert 'DELETE FROM "BrowserProviderProfile"' in cleanup_sql

    restored = []
    original_restore = bench._restore_isolated_browser_state_scenario
    try:
        bench._restore_isolated_browser_state_scenario = lambda saved, *, label: restored.append((saved, label))
        bench._restore_live_fixture_scenarios([{"fixture": "live"}, manifest])
    finally:
        bench._restore_isolated_browser_state_scenario = original_restore
    assert restored == [(manifest, "fresh browser state")]


def test_benchmark_agent_source_override_validates_known_sources():
    """Benchmark source override accepts only real AgentSource values."""
    import os

    import pytest
    import benchmarks.run_benchmark as bench

    original_env = os.environ.get("BENCHMARK_AGENT_SOURCE")

    try:
        os.environ["BENCHMARK_AGENT_SOURCE"] = "sms"
        assert bench._benchmark_agent_source_override() == "SMS"

        os.environ["BENCHMARK_AGENT_SOURCE"] = "bogus"
        with pytest.raises(ValueError):
            bench._benchmark_agent_source_override()
    finally:
        if original_env is None:
            os.environ.pop("BENCHMARK_AGENT_SOURCE", None)
        else:
            os.environ["BENCHMARK_AGENT_SOURCE"] = original_env


def test_catalog_world_model_mode_is_optional_and_validated():
    """Per-bench world_model_mode is optional (absent = real/sim-off) and enum-checked."""
    import pytest

    from benchmarks.long_horizon import validate_task_contract

    base = {"name": "t", "bench": "pipeline-e2e"}

    # Absent → valid (defaults to real/sim-off at run time).
    validate_task_contract(dict(base))
    # Each allowed mode validates.
    for mode in ("real", "simulate", "shadow"):
        validate_task_contract({**base, "world_model_mode": mode})
    # A bogus mode is rejected.
    with pytest.raises(ValueError):
        validate_task_contract({**base, "world_model_mode": "sim"})


def test_local_benchmark_task_queue_uses_conductor_workspace_only_for_local_urls():
    """Local benchmark agents are scheduled onto the queue the harness preflights."""
    import os

    import benchmarks.run_benchmark as bench

    previous_workspace = os.environ.get("CONDUCTOR_WORKSPACE_NAME")
    try:
        os.environ["CONDUCTOR_WORKSPACE_NAME"] = "washington"

        assert bench._local_benchmark_task_queue("http://localhost:55020") == "navi-agent-tasks-washington"
        assert bench._local_benchmark_task_queue("http://127.0.0.1:55020") == "navi-agent-tasks-washington"
        assert bench._local_benchmark_task_queue("https://navi-j9a9.onrender.com") is None
    finally:
        if previous_workspace is None:
            os.environ.pop("CONDUCTOR_WORKSPACE_NAME", None)
        else:
            os.environ["CONDUCTOR_WORKSPACE_NAME"] = previous_workspace


def test_benchmark_sms_source_override_updates_local_agent_source():
    """Local SMS notification benchmarks can use normal create-agent auth bootstrap."""
    import benchmarks.run_benchmark as bench

    queries = []
    original_run_sql = bench._run_local_victoria_sql

    try:
        bench._run_local_victoria_sql = lambda sql: queries.append(sql) or "UPDATE 1"

        bench._apply_local_agent_source_override("agent-123", "SMS")
    finally:
        bench._run_local_victoria_sql = original_run_sql

    assert len(queries) == 1
    assert 'UPDATE "Agent"' in queries[0]
    assert "source = 'SMS'" in queries[0]
    assert "agent-123" in queries[0]


def test_anon_benchmark_mode_disables_saved_auth_material():
    """--anon should force minted auth benches through fresh account credentials."""
    import os

    import benchmarks.run_benchmark as bench

    previous_clear = os.environ.get("BENCHMARK_MINTED_CLEAR_EXISTING_AUTH")
    previous_steel_profile = os.environ.get("BENCHMARK_ANON_STEEL_PROFILE")
    previous_disable_saved_auth = os.environ.get("BENCHMARK_DISABLE_SAVED_BROWSER_AUTH")
    try:
        os.environ.pop("BENCHMARK_MINTED_CLEAR_EXISTING_AUTH", None)
        os.environ.pop("BENCHMARK_ANON_STEEL_PROFILE", None)
        os.environ.pop("BENCHMARK_DISABLE_SAVED_BROWSER_AUTH", None)

        bench._apply_anon_benchmark_mode()

        assert os.environ["BENCHMARK_MINTED_CLEAR_EXISTING_AUTH"] == "true"
        assert os.environ["BENCHMARK_ANON_STEEL_PROFILE"] == "true"
        assert os.environ["BENCHMARK_DISABLE_SAVED_BROWSER_AUTH"] == "true"
    finally:
        if previous_clear is None:
            os.environ.pop("BENCHMARK_MINTED_CLEAR_EXISTING_AUTH", None)
        else:
            os.environ["BENCHMARK_MINTED_CLEAR_EXISTING_AUTH"] = previous_clear
        if previous_steel_profile is None:
            os.environ.pop("BENCHMARK_ANON_STEEL_PROFILE", None)
        else:
            os.environ["BENCHMARK_ANON_STEEL_PROFILE"] = previous_steel_profile
        if previous_disable_saved_auth is None:
            os.environ.pop("BENCHMARK_DISABLE_SAVED_BROWSER_AUTH", None)
        else:
            os.environ["BENCHMARK_DISABLE_SAVED_BROWSER_AUTH"] = previous_disable_saved_auth


def test_x_post_prompt_keeps_goal_and_prefers_email_auth():
    """Fresh X benchmark profiles need explicit guidance away from the fragile phone-first path."""
    import benchmarks.run_benchmark as bench

    prompt = bench._x_post_prompt()

    assert prompt.startswith("Make a post on X.com that says, Hello World")
    assert "minted email" in prompt
    assert "Use email instead" in prompt
    assert "Do not choose the initial 'Continue with phone'" in prompt
    assert "terminal phone-auth blocker" in prompt


def test_browser_agent_cookie_bundle_bootstrap_is_local_only():
    """Amazon cookie-bundle bootstrap only runs for localhost benchmark targets."""
    from benchmarks.run_benchmark import _is_local_base_url

    assert _is_local_base_url("http://localhost:55120") is True
    assert _is_local_base_url("http://127.0.0.1:55120") is True
    assert _is_local_base_url("https://navi-j9a9.onrender.com") is False


async def test_primitive_cleanup_deletes_only_exact_recipients():
    """Minted benchmark cleanup must delete only mail for the exact minted recipient."""
    import benchmarks.run_benchmark as bench

    list_calls = []
    delete_calls = []

    class FakeListResponse:
        status_code = 200
        text = ""

        def json(self):
            return {
                "data": [
                    {"id": "em-1", "recipient": "rose.harbor22@mail.roselabs.test"},
                    # Different recipient under the same catch-all domain must be ignored.
                    {"id": "em-2", "recipient": "someone.else@mail.roselabs.test"},
                ]
            }

    class FakeDeleteResponse:
        status_code = 202
        text = ""

    class FakeClient:
        def __init__(self, timeout):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, url, *, params, headers):
            list_calls.append((url, params, headers))
            return FakeListResponse()

        async def delete(self, url, *, headers):
            delete_calls.append((url, headers))
            return FakeDeleteResponse()

    original_client = bench.httpx.AsyncClient
    original_load_env = bench.load_env_var
    try:

        def fake_load_env(name, *_paths):
            if name == "PRIMITIVE_API_KEY":
                return "primitive-key"
            if name == "PRIMITIVE_BASE_URL":
                return "https://primitive.test"
            return None

        bench.httpx.AsyncClient = FakeClient
        bench.load_env_var = fake_load_env

        deleted = await bench._delete_primitive_emails_by_recipient(
            ["rose.harbor22@mail.roselabs.test", "rose.harbor22@mail.roselabs.test", ""]
        )
    finally:
        bench.httpx.AsyncClient = original_client
        bench.load_env_var = original_load_env

    assert deleted == 1
    assert list_calls == [
        (
            "https://primitive.test/emails",
            {"search": "rose.harbor22@mail.roselabs.test", "limit": "100"},
            {"Authorization": "Bearer primitive-key"},
        )
    ]
    assert delete_calls == [
        (
            "https://primitive.test/emails/em-1",
            {"Authorization": "Bearer primitive-key"},
        )
    ]


async def test_primitive_uber_welcome_evidence_uses_exact_recipient():
    """Live Uber minted benchmark can prove account creation from exact primitive mail."""
    import benchmarks.run_benchmark as bench

    calls = []

    class FakeResponse:
        status_code = 200
        text = ""

        def json(self):
            return {
                "data": [
                    {
                        "recipient": "rose.harbor22@mail.roselabs.test",
                        "subject": "Welcome to Uber",
                        "sender": "admin@uber.com",
                    },
                    # Mail for another recipient under the same domain must be ignored.
                    {
                        "recipient": "someone.else@mail.roselabs.test",
                        "subject": "Welcome to Uber",
                        "sender": "admin@uber.com",
                    },
                ]
            }

    class FakeClient:
        def __init__(self, timeout):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, url, *, params, headers):
            calls.append((url, params, headers))
            return FakeResponse()

    original_client = bench.httpx.AsyncClient
    original_load_env = bench.load_env_var
    try:

        def fake_load_env(name, *_paths):
            if name == "PRIMITIVE_API_KEY":
                return "primitive-key"
            if name == "PRIMITIVE_BASE_URL":
                return "https://primitive.test"
            return None

        bench.httpx.AsyncClient = FakeClient
        bench.load_env_var = fake_load_env

        assert await bench._primitive_inbox_has_uber_welcome("rose.harbor22@mail.roselabs.test")
    finally:
        bench.httpx.AsyncClient = original_client
        bench.load_env_var = original_load_env

    assert calls == [
        (
            "https://primitive.test/emails",
            {"search": "rose.harbor22@mail.roselabs.test", "limit": "20"},
            {"Authorization": "Bearer primitive-key"},
        )
    ]


async def test_api_headers_honors_internal_api_key_auth():
    """Benchmark auth accepts the shared E2E helper's internal API-key mode."""
    import benchmarks.run_benchmark as bench

    original_authenticate = bench.authenticate
    original_cached_headers = bench._cached_headers
    original_cached_headers_user_id = bench._cached_headers_user_id
    original_auth_mode = bench._auth_mode
    original_api_key = bench.API_KEY
    original_user_id = bench.USER_ID
    # `_api_headers` now resolves the effective benchmark user via
    # `_current_benchmark_user_id()` (a BENCHMARK_RUN_USER_ID override used by the
    # gate fixtures). Pin it to USER_ID so a leaked override from another test
    # can't route this contract test down the user-override branch.
    original_current_user_id = bench._current_benchmark_user_id

    async def fake_authenticate():
        return {
            "access_token": None,
            "api_key": "live-api-key",
            "user_id": "user-123",
            "auth_mode": "internal_api_key",
        }

    try:
        bench.authenticate = fake_authenticate
        bench._cached_headers = None
        bench._cached_headers_user_id = None
        bench._auth_mode = None
        bench.API_KEY = "fallback-api-key"
        # USER_ID matches the authenticated user so the per-user header cache (keyed
        # on `_current_benchmark_user_id()`) hits on the second call, mirroring prod
        # where authenticate() resolves the same user _current_benchmark_user_id does.
        bench.USER_ID = "user-123"
        bench._current_benchmark_user_id = lambda: bench.USER_ID

        headers = await bench._api_headers()
        assert headers == {
            "X-API-Key": "live-api-key",
            "X-User-Id": "user-123",
            "Content-Type": "application/json",
        }
        assert await bench._api_headers() == headers
    finally:
        bench.authenticate = original_authenticate
        bench._cached_headers = original_cached_headers
        bench._cached_headers_user_id = original_cached_headers_user_id
        bench._auth_mode = original_auth_mode
        bench.API_KEY = original_api_key
        bench.USER_ID = original_user_id
        bench._current_benchmark_user_id = original_current_user_id


async def test_archive_agent_start_posts_agent_and_returns_fixture_ref():
    """Benchmark runs capture the start fixture immediately after agent setup."""
    import benchmarks.run_benchmark as bench

    calls = []

    class FakeResponse:
        status_code = 200
        text = ""

        def json(self):
            return {"fixture": {"ref": "trace-archive/root-1/db/start.fixture.json.gz.enc"}}

    class FakeClient:
        def __init__(self, timeout):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, *, headers, json):
            calls.append((self.timeout, url, headers, json))
            return FakeResponse()

    original_headers = bench._api_headers
    original_client = bench.httpx.AsyncClient
    try:

        async def fake_headers():
            return {"X-API-Key": "test-key"}

        bench._api_headers = fake_headers
        bench.httpx.AsyncClient = FakeClient

        fixture_ref = await bench.archive_agent_start("http://localhost:55120", "agent-root")
    finally:
        bench._api_headers = original_headers
        bench.httpx.AsyncClient = original_client

    assert fixture_ref == "trace-archive/root-1/db/start.fixture.json.gz.enc"
    assert calls == [
        (
            60,
            "http://localhost:55120/api/archive/agent-start",
            {"X-API-Key": "test-key"},
            {"agentId": "agent-root"},
        )
    ]


async def test_archive_agent_finalize_posts_task_and_returns_manifest_ref():
    """Benchmark task completion records the durable trace bundle manifest."""
    import benchmarks.run_benchmark as bench

    calls = []

    class FakeResponse:
        status_code = 200
        text = ""

        def json(self):
            return {"manifest": {"ref": "trace-archive/root-1/manifest.json.gz.enc"}}

    class FakeClient:
        def __init__(self, timeout):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, *, headers, json):
            calls.append((self.timeout, url, headers, json))
            return FakeResponse()

    original_headers = bench._api_headers
    original_client = bench.httpx.AsyncClient
    try:

        async def fake_headers():
            return {"X-API-Key": "test-key"}

        bench._api_headers = fake_headers
        bench.httpx.AsyncClient = FakeClient

        manifest_ref = await bench.archive_agent_finalize(
            "http://localhost:55120",
            "agent-root",
            "chat-mode",
            force=True,
            benchmark_passed=True,
            benchmark_status="PASSED",
        )
    finally:
        bench._api_headers = original_headers
        bench.httpx.AsyncClient = original_client

    assert manifest_ref == "trace-archive/root-1/manifest.json.gz.enc"
    assert calls == [
        (
            90,
            "http://localhost:55120/api/archive/agent-finalize",
            {"X-API-Key": "test-key"},
            {
                "rootAgentId": "agent-root",
                "benchmarkTaskName": "chat-mode",
                "force": True,
                "worldModelMode": "real",
                "benchmarkPassed": True,
                "benchmarkStatus": "PASSED",
            },
        )
    ]


async def test_archive_agent_finalize_failure_is_best_effort():
    """Archive failures should not fail the benchmark result path."""
    import benchmarks.run_benchmark as bench

    class FakeResponse:
        status_code = 503
        text = "archive unavailable"

        def json(self):
            raise AssertionError("json should not be called on failed archive response")

    class FakeClient:
        def __init__(self, timeout):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, _url, *, headers, json):
            return FakeResponse()

    original_headers = bench._api_headers
    original_client = bench.httpx.AsyncClient
    try:

        async def fake_headers():
            return {"X-API-Key": "test-key"}

        bench._api_headers = fake_headers
        bench.httpx.AsyncClient = FakeClient

        assert await bench.archive_agent_finalize("http://localhost:55120", "agent-root", "chat-mode") is None
    finally:
        bench._api_headers = original_headers
        bench.httpx.AsyncClient = original_client


def test_benchmark_run_json_preserves_archive_manifest_ref():
    """Run JSON keeps each task's archive manifest pointer for replay lookup."""
    from benchmarks.results import BenchmarkRun, TaskResult

    run = BenchmarkRun(suite="smoke", base_url="http://localhost:55120")
    run.task_results.append(
        TaskResult(
            name="chat-mode",
            passed=True,
            agent_id="agent-root",
            status="COMPLETED",
            progress_score=1.0,
            duration_seconds=4.0,
            cost_cents=2.0,
            message_count=3,
            archive_manifest_ref="trace-archive/root-1/manifest.json.gz.enc",
        )
    )

    assert run.to_dict()["tasks"][0]["archive_manifest_ref"] == "trace-archive/root-1/manifest.json.gz.enc"


def test_benchmark_run_summary_reports_wmh_prediction_accuracy():
    """Run summary exposes aggregate WMH prediction accuracy for scored tasks."""
    from benchmarks.results import BenchmarkRun, TaskResult

    run = BenchmarkRun(suite="wmh", base_url="http://localhost:55120")
    run.task_results.extend(
        [
            TaskResult(
                name="task-a",
                passed=True,
                agent_id="agent-a",
                status="COMPLETED",
                progress_score=1.0,
                duration_seconds=4.0,
                cost_cents=2.0,
                message_count=3,
                world_model_fidelity={"status": "scored", "mean_score": 0.8},
            ),
            TaskResult(
                name="task-b",
                passed=True,
                agent_id="agent-b",
                status="COMPLETED",
                progress_score=1.0,
                duration_seconds=5.0,
                cost_cents=3.0,
                message_count=4,
                world_model_fidelity={"status": "scored", "mean_score": 0.9},
            ),
            TaskResult(
                name="task-c",
                passed=True,
                agent_id="agent-c",
                status="COMPLETED",
                progress_score=1.0,
                duration_seconds=5.0,
                cost_cents=3.0,
                message_count=4,
                world_model_fidelity={"status": "not_configured"},
            ),
        ]
    )

    summary = run.to_dict()["summary"]
    assert summary["wmh_scored_tasks"] == 2
    assert summary["wmh_prediction_accuracy"] == 0.85


async def test_finalize_archive_and_score_world_model_lifecycle():
    """A benchmark completion finalizes storage, scores WMH, and returns both refs."""
    import benchmarks.run_benchmark as bench

    calls = []

    async def fake_finalize(base_url, agent_id, task_name, *, force=False, **kwargs):
        calls.append(("archive", base_url, agent_id, task_name, force, kwargs))
        return "trace-archive/root-1/manifest.json.gz.enc"

    async def fake_score(agent_id):
        calls.append(("wmh", agent_id))
        return {"status": "scored", "mean_score": 0.87, "n_steps": 3}

    original_finalize = bench.archive_agent_finalize
    original_score = bench.evaluate_world_model_fidelity
    try:
        bench.archive_agent_finalize = fake_finalize
        bench.evaluate_world_model_fidelity = fake_score

        manifest_ref, fidelity = await bench.finalize_archive_and_score_world_model(
            "http://localhost:55120",
            "root-1",
            "phone-call-client-intake",
            force=True,
        )
    finally:
        bench.archive_agent_finalize = original_finalize
        bench.evaluate_world_model_fidelity = original_score

    assert manifest_ref == "trace-archive/root-1/manifest.json.gz.enc"
    assert fidelity["status"] == "scored"
    assert fidelity["mean_score"] == 0.87
    assert calls == [
        (
            "archive",
            "http://localhost:55120",
            "root-1",
            "phone-call-client-intake",
            True,
            {"benchmark_passed": None, "benchmark_status": None, "failure_reason": None},
        ),
        ("wmh", "root-1"),
    ]


def test_world_model_cli_env_simulate_alias_does_not_enable_self_eval():
    """--simulate is the supported short flag for provider-boundary WMH simulation."""
    import os
    from types import SimpleNamespace

    import benchmarks.run_benchmark as bench

    class Parser:
        def error(self, message):
            raise AssertionError(message)

    old_env = {
        "BENCHMARK_WORLD_MODEL_MODE": os.environ.get("BENCHMARK_WORLD_MODEL_MODE"),
        "BENCHMARK_WMH_EVAL": os.environ.get("BENCHMARK_WMH_EVAL"),
        "WMH_BASE_URL": os.environ.get("WMH_BASE_URL"),
        "WMH_MODEL_NAME": os.environ.get("WMH_MODEL_NAME"),
        "WMH_SESSION_ID": os.environ.get("WMH_SESSION_ID"),
    }
    try:
        for key in old_env:
            os.environ.pop(key, None)
        bench._apply_world_model_cli_env(
            SimpleNamespace(
                simulate=True,
                world_model_mode=None,
                wmh_eval=False,
                world_model_url="http://wmh.local",
                world_model_name="rose-golden",
                world_model_session_id="session-1",
            ),
            Parser(),
        )
        assert os.environ["BENCHMARK_WORLD_MODEL_MODE"] == "simulate"
        assert os.environ.get("BENCHMARK_WMH_EVAL") is None
        assert os.environ["WMH_BASE_URL"] == "http://wmh.local"
        assert os.environ["WMH_MODEL_NAME"] == "rose-golden"
        assert os.environ["WMH_SESSION_ID"] == "session-1"
    finally:
        for key, value in old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def test_world_model_cli_env_wmh_eval_scores_real_runs():
    """--wmh-eval lets real benchmark runs produce prediction-accuracy reports."""
    import os
    from types import SimpleNamespace

    import benchmarks.run_benchmark as bench

    class Parser:
        def error(self, message):
            raise AssertionError(message)

    old_eval = os.environ.get("BENCHMARK_WMH_EVAL")
    old_mode = os.environ.get("BENCHMARK_WORLD_MODEL_MODE")
    try:
        os.environ.pop("BENCHMARK_WMH_EVAL", None)
        os.environ.pop("BENCHMARK_WORLD_MODEL_MODE", None)
        bench._apply_world_model_cli_env(
            SimpleNamespace(
                simulate=False,
                world_model_mode="real",
                wmh_eval=True,
                world_model_url=None,
                world_model_name=None,
                world_model_session_id=None,
            ),
            Parser(),
        )
        assert os.environ["BENCHMARK_WORLD_MODEL_MODE"] == "real"
        assert os.environ["BENCHMARK_WMH_EVAL"] == "1"
    finally:
        if old_eval is None:
            os.environ.pop("BENCHMARK_WMH_EVAL", None)
        else:
            os.environ["BENCHMARK_WMH_EVAL"] = old_eval
        if old_mode is None:
            os.environ.pop("BENCHMARK_WORLD_MODEL_MODE", None)
        else:
            os.environ["BENCHMARK_WORLD_MODEL_MODE"] = old_mode


async def test_simulate_preflight_updates_world_model_and_records_progress():
    """--simulate runs the delta builder before any benchmark agent starts."""
    import os
    from types import SimpleNamespace

    import benchmarks.run_benchmark as bench

    calls = []

    def fake_update(**kwargs):
        calls.append(kwargs)
        kwargs["progress"](
            {
                "title": "World Model Updating",
                "status": "IN_PROGRESS",
                "metadata": {"total_traces": 2, "traces_to_update": 1},
            }
        )
        kwargs["progress"](
            {
                "title": "World Model Ready",
                "status": "FINISHED",
                "metadata": {"total_traces": 2, "updated_traces": 1, "aggregate_trace_bytes": 123},
            }
        )
        return {
            "status": "ready",
            "model_name": "rose-delta",
            "total_traces": 2,
            "updated_traces": 1,
            "unchanged_traces": 1,
            "build_ran": True,
        }

    original_update = bench.update_world_model_for_simulation
    old_model_name = os.environ.get("WMH_MODEL_NAME")
    try:
        bench.update_world_model_for_simulation = fake_update
        os.environ.pop("WMH_MODEL_NAME", None)
        bench._WORLD_MODEL_UPDATE_EVENTS.clear()
        bench._WORLD_MODEL_UPDATE_RESULT = None
        await bench._update_world_model_before_simulation(
            SimpleNamespace(simulate=True, world_model_mode=None, world_model_name="rose-delta")
        )
        assert os.environ["WMH_MODEL_NAME"] == "rose-delta"
    finally:
        bench.update_world_model_for_simulation = original_update
        if old_model_name is None:
            os.environ.pop("WMH_MODEL_NAME", None)
        else:
            os.environ["WMH_MODEL_NAME"] = old_model_name

    assert len(calls) == 1
    assert calls[0]["name"] == "rose-delta"
    assert bench._WORLD_MODEL_UPDATE_RESULT["status"] == "ready"
    assert [event["title"] for event in bench._WORLD_MODEL_UPDATE_EVENTS] == [
        "World Model Updating",
        "World Model Ready",
    ]
    assert "text" not in bench._WORLD_MODEL_UPDATE_EVENTS[0]


async def test_code_agent_preflight_accepts_gpt_compute_token():
    """Code-agent benchmarks preflight against the workflow compute-token route."""
    import benchmarks.run_benchmark as bench

    calls = []

    class FakeResponse:
        status_code = 200

        def json(self):
            return {"type": "gpt", "accessToken": "gpt-token"}

    class FakeClient:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, url, *, headers, params=None, timeout):
            calls.append((url, headers, params, timeout))
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
            None,
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
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, _url, *, headers, params=None, timeout):
            assert params is None
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


async def test_code_agent_preflight_accepts_anthropic_api_key_fallback():
    """Code-agent benchmarks run when the Claude Code API-key fallback is configured and clear."""
    import benchmarks.run_benchmark as bench

    calls = []

    class FakeResponse:
        def __init__(self, status_code, body):
            self.status_code = status_code
            self._body = body

        def json(self):
            return self._body

    class FakeClient:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, url, *, headers, params=None, timeout):
            calls.append((url, headers, params, timeout))
            if url.endswith("/api/integrations/compute-code/credentials/token"):
                return FakeResponse(404, {"error": "NO_TOKENS_AVAILABLE"})
            if url.endswith("/api/integrations/compute-code/anthropic-key/cooldown"):
                return FakeResponse(200, {"configured": True, "onCooldown": False})
            raise AssertionError(f"unexpected URL {url}")

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
            None,
            10.0,
        ),
        (
            "http://localhost:55120/api/integrations/compute-code/anthropic-key/cooldown",
            {"X-API-Key": "test-key"},
            None,
            10.0,
        ),
    ]


async def test_claude_code_preflight_uses_runtime_credential_route():
    """Claude Code smoke gating must use the same credential route as session creation."""
    import benchmarks.run_benchmark as bench

    calls = []

    class FakeResponse:
        status_code = 200

        def json(self):
            return {"accessToken": "claude-token"}

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

        assert await bench._check_claude_code_credentials("http://localhost:55120") is True
    finally:
        bench._api_headers = original_headers
        bench.httpx.AsyncClient = original_client

    assert calls == [
        (
            "http://localhost:55120/api/integrations/claude-code/credentials/token",
            {"X-API-Key": "test-key"},
            10.0,
        )
    ]


async def test_claude_code_preflight_rejects_generic_claude_compute_token():
    """A generic Claude compute token cannot prove Claude Code session credentials exist."""
    import benchmarks.run_benchmark as bench

    calls = []

    class FakeResponse:
        status_code = 404

        def json(self):
            return {"error": "Claude Code credentials not found"}

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

        assert await bench._check_claude_code_credentials("http://localhost:55120") is False
    finally:
        bench._api_headers = original_headers
        bench.httpx.AsyncClient = original_client

    assert calls == [
        (
            "http://localhost:55120/api/integrations/claude-code/credentials/token",
            {"X-API-Key": "test-key"},
            10.0,
        )
    ]


async def test_local_compute_refresh_accepts_healthy_anthropic_api_key_fallback():
    """Blanket local refresh must accept the same funded fallback as runtime."""
    import benchmarks.run_benchmark as bench

    http_calls = []
    sync_options = []

    class FakeResponse:
        status_code = 200

        def json(self):
            return {"configured": True, "onCooldown": False}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, url, *, headers, timeout):
            http_calls.append((url, headers, timeout))
            return FakeResponse()

    original_headers = bench._api_headers
    original_client = bench.httpx.AsyncClient
    original_sync = bench._sync_compute_tokens
    try:

        async def fake_headers():
            return {"X-API-Key": "test-key"}

        def fake_sync(**options):
            sync_options.append(options)
            return options.get("tolerate_claude_code_unavailable") is True

        bench._api_headers = fake_headers
        bench.httpx.AsyncClient = FakeClient
        bench._sync_compute_tokens = fake_sync

        refresh = bench._refresh_local_compute_tokens_for_run("http://localhost:55120")
        if asyncio.iscoroutine(refresh):
            await refresh
    finally:
        bench._api_headers = original_headers
        bench.httpx.AsyncClient = original_client
        bench._sync_compute_tokens = original_sync

    assert sync_options == [
        {
            "tolerate_gpt_code_unavailable": True,
            "tolerate_claude_code_unavailable": True,
        }
    ]
    assert http_calls == [
        (
            "http://localhost:55120/api/integrations/compute-code/anthropic-key/cooldown",
            {"X-API-Key": "test-key"},
            10.0,
        )
    ]


def test_compute_token_sync_reads_source_file_not_isolated_process_target():
    """The isolated target DSN must not shadow the explicit production source."""
    from unittest.mock import patch

    import benchmarks.run_benchmark as bench

    class SeedResult:
        returncode = 0
        stdout = ""
        stderr = ""

    with tempfile.TemporaryDirectory() as temp_dir:
        env_file = Path(temp_dir) / ".env"
        env_file.write_text("DATABASE_URL=postgresql://prod/rose\n")
        with (
            patch.dict(os.environ, {"DATABASE_URL": "postgresql://local/victoria"}),
            patch.object(bench, "_BACKEND_ENV", str(env_file)),
            patch.object(
                bench,
                "_local_victoria_database_url",
                return_value="postgresql://local/victoria",
            ),
            patch.object(bench, "_shared_workspace_database_url", return_value=None),
            patch.object(bench, "_run_seed_subprocess", return_value=SeedResult()) as seed,
        ):
            assert bench._sync_compute_tokens() is True

    assert seed.call_args.kwargs["env"]["SEED_COMPUTE_TOKEN_SOURCE_DATABASE_URL"] == "postgresql://prod/rose"


async def test_anthropic_api_key_fallback_availability_fails_closed():
    """Only an explicitly configured, non-cooled backend runtime is usable."""
    import benchmarks.run_benchmark as bench

    cases = [
        ("missing-key", 200, {"configured": False, "onCooldown": False}, None),
        ("cooldown", 200, {"configured": True, "onCooldown": True}, None),
        ("malformed-empty", 200, {}, None),
        ("malformed-null", 200, None, None),
        ("non-200", 503, {"configured": True, "onCooldown": False}, None),
        ("unreachable", 0, None, RuntimeError("backend unavailable")),
    ]

    original_headers = bench._api_headers
    original_client = bench.httpx.AsyncClient
    try:

        async def fake_headers():
            return {"X-API-Key": "test-key"}

        bench._api_headers = fake_headers
        for name, status_code, body, error in cases:

            class FakeResponse:
                def __init__(self):
                    self.status_code = status_code

                def json(self):
                    return body

            class FakeClient:
                async def __aenter__(self):
                    return self

                async def __aexit__(self, *_args):
                    return None

                async def get(self, _url, *, headers, timeout):
                    if error is not None:
                        raise error
                    return FakeResponse()

            bench.httpx.AsyncClient = FakeClient
            assert await bench._has_usable_anthropic_api_key_fallback("http://localhost:55120") is False, name
    finally:
        bench._api_headers = original_headers
        bench.httpx.AsyncClient = original_client


def test_normalize_attention_requests_accepts_backend_contract():
    """Benchmark harness accepts the backend's {requests: [...]} list response."""
    from benchmarks.run_benchmark import _normalize_attention_requests_response

    req = {"id": "req-1", "question": "Approve?"}
    assert _normalize_attention_requests_response({"requests": [req]}) == [req]
    assert _normalize_attention_requests_response([req]) == [req]


def test_attention_request_kind_distinguishes_auth_from_write_lock():
    """Typed benchmark assertions must not pass auth checks on purchase approvals."""
    from benchmarks.run_benchmark import _attention_request_kind, _attention_request_matches_task
    from benchmarks.benchmark_tasks import get_task_by_name

    task = get_task_by_name("browser-agent")
    auth_req = {
        "metadata": {
            "attentionKind": "auth_assistance",
            "requestUserAuthentication": {"requestId": "auth-1"},
        }
    }
    write_lock_req = {
        "metadata": {"requestUserApproval": {"attentionRequestId": "approval-1", "writePermission": True}}
    }
    raw_write_lock_req = {"metadata": {"toolApproval": True, "writePermission": True}}

    assert task.expected_attention_kind == "auth_assistance"
    assert _attention_request_kind(auth_req) == "auth_assistance"
    assert _attention_request_matches_task(task, auth_req) is True
    assert _attention_request_kind(write_lock_req) == "write_lock"
    assert _attention_request_matches_task(task, write_lock_req) is False
    assert _attention_request_kind(raw_write_lock_req) == "write_lock"


def test_attention_request_open_check_honors_backend_answered_fields():
    """The benchmark should not recount answered attention requests."""
    from benchmarks.run_benchmark import _attention_request_is_open

    assert _attention_request_is_open({"id": "new", "answered": False, "user_response": None}) is True
    assert _attention_request_is_open({"id": "old", "answered": True, "user_response": None}) is False
    assert _attention_request_is_open({"id": "old", "user_response": "approved"}) is False
    assert _attention_request_is_open({"id": "old", "response": "approved"}) is False


def test_webdecoy_biometrics_evaluator_requires_interaction_and_low_score():
    """WebDecoy must be grounded in real interaction and score at/under the ratchet.

    The pass bar is a one-directional ratchet (currently 0.157) — literal 0.00 is
    unreachable while Steel's managed proxy injects x-forwarded-for-style headers.
    Scores at/under the ratchet pass; above it fail.
    """
    from benchmarks.run_benchmark import _evaluate_webdecoy_biometrics_result

    def _msg(score_line: str) -> dict:
        return {
            "messages": [
                {
                    "role": "TOOL",
                    "text": (
                        "Visited https://webdecoy.com/product/fcaptcha-demo/. "
                        "Clicked the checkbox mode verification control. "
                        "Entered benchmark-human@example.com in invisible mode and clicked Submit. " + score_line
                    ),
                }
            ]
        }

    # At/under the ratchet -> pass.
    assert _evaluate_webdecoy_biometrics_result(_msg("Final visible FCaptcha Risk Score: 0.00.")) == (True, None)
    assert _evaluate_webdecoy_biometrics_result(_msg("Final visible FCaptcha Risk Score: 0.157.")) == (True, None)
    assert _evaluate_webdecoy_biometrics_result(_msg("Final visible FCaptcha Risk Score: 0.10.")) == (True, None)

    # Above the ratchet -> fail.
    passed, reason = _evaluate_webdecoy_biometrics_result(_msg("Final visible FCaptcha Risk Score: 0.91."))
    assert passed is False
    assert "ratchet" in reason.lower()

    passed, reason = _evaluate_webdecoy_biometrics_result(_msg("Final visible FCaptcha Risk Score: 0.44."))
    assert passed is False
    assert "ratchet" in reason.lower()


def test_webdecoy_biometrics_evaluator_uses_exact_network_score_when_visible_is_rounded():
    """The ratchet should compare exact FCaptcha JSON, not the page's rounded display text."""
    import json
    import tempfile
    from pathlib import Path

    from benchmarks.run_benchmark import _evaluate_webdecoy_biometrics_result

    with tempfile.TemporaryDirectory() as tmp:
        network_dir = Path(tmp) / "recording" / "network"
        network_dir.mkdir(parents=True)
        body_file = network_dir / "0001_score.json"
        body_file.write_text(
            json.dumps(
                {
                    "action": "form_submit",
                    "recommendation": "allow",
                    "score": 0.1559512195121951,
                    "success": True,
                }
            )
        )
        (network_dir / "index.json").write_text(
            json.dumps(
                {
                    "entries": [
                        {
                            "method": "POST",
                            "url": "https://fcaptcha.webdecoy.com/api/score",
                            "response_ts_ms": 123,
                            "body_file": body_file.name,
                        }
                    ]
                }
            )
        )

        data = {
            "messages": [
                {
                    "role": "TOOL",
                    "text": (
                        "Visited https://webdecoy.com/product/fcaptcha-demo/. "
                        "Clicked the checkbox mode verification control. "
                        "Entered benchmark-human@example.com in invisible mode and clicked Submit. "
                        "Final visible FCaptcha Risk Score: 0.16."
                    ),
                    "metadata": {"network_recording_path": str(network_dir / "index.json")},
                }
            ]
        }

        assert _evaluate_webdecoy_biometrics_result(data) == (True, None)


def test_auth_bundle_biometrics_gate_defaults_on_and_can_be_disabled():
    """Minted auth-bundle probes should include the strict WebDecoy score gate by default."""
    import os

    import benchmarks.run_benchmark as bench

    original = os.environ.get(bench.AUTH_BUNDLE_BIOMETRICS_GATE_ENV)
    try:
        os.environ.pop(bench.AUTH_BUNDLE_BIOMETRICS_GATE_ENV, None)
        assert bench._auth_bundle_biometrics_gate_enabled() is True

        os.environ[bench.AUTH_BUNDLE_BIOMETRICS_GATE_ENV] = "false"
        assert bench._auth_bundle_biometrics_gate_enabled() is False

        os.environ[bench.AUTH_BUNDLE_BIOMETRICS_GATE_ENV] = "true"
        assert bench._auth_bundle_biometrics_gate_enabled() is True
    finally:
        if original is None:
            os.environ.pop(bench.AUTH_BUNDLE_BIOMETRICS_GATE_ENV, None)
        else:
            os.environ[bench.AUTH_BUNDLE_BIOMETRICS_GATE_ENV] = original


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

    assert (
        _approval_mode_allows_open_tool_context(task, data, approvals_triggered=task.expected_approval_count or 0)
        is True
    )


def test_open_approval_context_filters_expected_tool_pairing_violation():
    """Final artifacts should not report open approval waits as context corruption."""
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.context_validator import ContextViolation
    from benchmarks.run_benchmark import _final_context_violations_for_result

    task = get_task_by_name("browser-agent")
    data = {"agent": {"status": "ACTIVE"}, "messages": []}
    violations = [
        ContextViolation("tool_result_pairing", "error", "open tool is waiting for approval"),
        ContextViolation("role_alternation", "error", "real context issue"),
    ]

    filtered = _final_context_violations_for_result(task, data, approvals_triggered=1, violations=violations)

    assert [v.rule for v in filtered] == ["role_alternation"]


def test_count_only_releases_observed_approvals_by_denial():
    """count_only should unblock observed approvals without approving side effects."""
    from benchmarks.run_benchmark import _count_only_release_response

    assert _count_only_release_response() == "__REJECTED__"


def test_prompt_user_denial_uses_rejection_sentinel():
    """prompt_user denial must use the app's rejection sentinel, not free text."""
    from benchmarks.run_benchmark import _approval_rejection_response

    assert _approval_rejection_response() == "__REJECTED__"


def test_benchmark_env_bool_parses_optional_write_lock_override():
    """Benchmark env bools are optional and reject ambiguous values."""
    import os

    from benchmarks.run_benchmark import _benchmark_env_bool

    original = os.environ.get("BENCHMARK_WRITE_LOCK_ENABLED")
    try:
        os.environ.pop("BENCHMARK_WRITE_LOCK_ENABLED", None)
        assert _benchmark_env_bool("BENCHMARK_WRITE_LOCK_ENABLED") is None
        os.environ["BENCHMARK_WRITE_LOCK_ENABLED"] = "false"
        assert _benchmark_env_bool("BENCHMARK_WRITE_LOCK_ENABLED") is False
        os.environ["BENCHMARK_WRITE_LOCK_ENABLED"] = "yes"
        assert _benchmark_env_bool("BENCHMARK_WRITE_LOCK_ENABLED") is True
        os.environ["BENCHMARK_WRITE_LOCK_ENABLED"] = "maybe"
        try:
            _benchmark_env_bool("BENCHMARK_WRITE_LOCK_ENABLED")
        except ValueError as exc:
            assert "BENCHMARK_WRITE_LOCK_ENABLED" in str(exc)
        else:
            raise AssertionError("invalid bool should raise ValueError")
    finally:
        if original is None:
            os.environ.pop("BENCHMARK_WRITE_LOCK_ENABLED", None)
        else:
            os.environ["BENCHMARK_WRITE_LOCK_ENABLED"] = original


def test_benchmark_env_override_can_disable_approval_handling():
    """No-lock purchase benchmarks can require terminal completion instead of approval observation."""
    import os
    from dataclasses import replace

    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _apply_benchmark_env_overrides

    original = os.environ.get("BENCHMARK_APPROVAL_HANDLING_OVERRIDE")
    task = replace(get_task_by_name("browser-agent"))
    assert task.approval_handling == "ignore"
    try:
        os.environ["BENCHMARK_APPROVAL_HANDLING_OVERRIDE"] = "none"
        _apply_benchmark_env_overrides([task])
    finally:
        if original is None:
            os.environ.pop("BENCHMARK_APPROVAL_HANDLING_OVERRIDE", None)
        else:
            os.environ["BENCHMARK_APPROVAL_HANDLING_OVERRIDE"] = original

    assert task.approval_handling is None


def test_source_connect_gate_benchmark_enables_non_purchase_gates():
    """Any task whose canonical contract expects source_connect must enable its worker gate."""
    from dataclasses import replace

    from benchmarks import benchmark_tasks
    from benchmarks import local as local_bench

    previous = os.environ.get("NON_PURCHASE_GATES_ENABLED")
    original_tasks = benchmark_tasks._cached_tasks
    try:
        source_task = replace(
            benchmark_tasks.get_task_by_name("gate-source-connect-gmail"),
            name="future-source-connect-benchmark",
        )
        benchmark_tasks._cached_tasks = [source_task]
        os.environ.pop("NON_PURCHASE_GATES_ENABLED", None)
        local_bench.configure_task_environment(["future-source-connect-benchmark"])
        assert os.environ.get("NON_PURCHASE_GATES_ENABLED") == "1"
    finally:
        benchmark_tasks._cached_tasks = original_tasks
        if previous is None:
            os.environ.pop("NON_PURCHASE_GATES_ENABLED", None)
        else:
            os.environ["NON_PURCHASE_GATES_ENABLED"] = previous


def test_cloudbench_source_connect_gate_benchmark_enables_non_purchase_gates():
    """Cloudbench's task-env resolution exports gates and fails closed on resolver errors."""
    import subprocess

    repo_root = Path(__file__).resolve().parents[3]
    script = repo_root / "scripts" / "cloudbench-run.sh"
    base_env = {
        **os.environ,
        "CLOUDBENCH_REPO_DIR": str(repo_root),
        "CLOUDBENCH_SEED_BUDGET_LIB": str(repo_root / "scripts" / "lib" / "cloudbench-seed-budget.sh"),
        "CLOUDBENCH_PRINT_TASK_ENV": "1",
    }
    enabled = subprocess.run(
        ["bash", str(script)],
        env={**base_env, "BENCH_TASKS": "gate-source-connect-gmail"},
        capture_output=True,
        text=True,
        check=False,
    )
    disabled = subprocess.run(
        ["bash", str(script)],
        env={**base_env, "BENCH_TASKS": "chat-mode"},
        capture_output=True,
        text=True,
        check=False,
    )

    assert enabled.returncode == 0, enabled.stderr
    assert enabled.stdout.splitlines() == [
        "stack:NON_PURCHASE_GATES_ENABLED=1",
        "benchmark:export NON_PURCHASE_GATES_ENABLED=1",
    ]
    assert disabled.returncode == 0, disabled.stderr
    assert disabled.stdout == ""

    with tempfile.TemporaryDirectory() as fake_bin_dir:
        fake_python = Path(fake_bin_dir) / "python3"
        fake_python.write_text("#!/bin/sh\nexit 42\n")
        fake_python.chmod(0o755)
        resolver_failure = subprocess.run(
            ["bash", str(script)],
            env={
                **base_env,
                "BENCH_TASKS": "gate-source-connect-gmail",
                "CLOUDBENCH_TASK_GATE_PYTHON": str(fake_python),
            },
            capture_output=True,
            text=True,
            check=False,
        )

    assert resolver_failure.returncode == 42
    assert "task gate resolution failed (exit 42)" in resolver_failure.stderr


def test_cloudbench_test_payment_benchmarks_enable_bundled_frontend_env():
    """Cloudbench must build the payment frontend before public tunnel exposure."""
    script = (Path(__file__).resolve().parents[3] / "scripts" / "cloudbench-run.sh").read_text()

    assert "BENCH_NEEDS_BUNDLED_FRONTEND" in script
    assert "gate-subscription-card-mint|gate-kyc-card-mint" in script
    assert "BENCHMARK_BUNDLED_FRONTEND=true" in script
    assert "VITE_SUPABASE_URL=$FRONTEND_SUPABASE_URL" in script
    assert "VITE_SUPABASE_ANON_KEY=$FRONTEND_SUPABASE_ANON_KEY" in script


async def test_create_agent_sends_write_lock_override_when_env_set():
    """Agent creation includes write_lock_enabled only when explicitly requested by the benchmark."""
    import os

    import benchmarks.run_benchmark as bench
    from benchmarks.benchmark_tasks import get_task_by_name

    posts = []
    patches = []

    class FakeResponse:
        def __init__(self, status_code=201, payload=None):
            self.status_code = status_code
            self.text = ""
            self.payload = payload or {"agent_id": "agent-123"}

        def json(self):
            return self.payload

    class FakeClient:
        def __init__(self, timeout):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, _url, *, headers, json):
            posts.append(json)
            return FakeResponse()

        async def patch(self, _url, *, headers, json):
            patches.append(json)
            return FakeResponse(200, {"agent": {"write_lock_enabled": json["write_lock_enabled"]}})

    original_headers = bench._api_headers
    original_client = bench.httpx.AsyncClient
    original_env = os.environ.get("BENCHMARK_WRITE_LOCK_ENABLED")
    try:

        async def fake_headers():
            return {"X-API-Key": "test-key"}

        bench._api_headers = fake_headers
        bench.httpx.AsyncClient = FakeClient
        os.environ["BENCHMARK_WRITE_LOCK_ENABLED"] = "false"

        agent_id = await bench.create_agent("http://localhost:55120", get_task_by_name("browser-agent"))
    finally:
        bench._api_headers = original_headers
        bench.httpx.AsyncClient = original_client
        if original_env is None:
            os.environ.pop("BENCHMARK_WRITE_LOCK_ENABLED", None)
        else:
            os.environ["BENCHMARK_WRITE_LOCK_ENABLED"] = original_env

    assert agent_id == "agent-123"
    assert posts[0]["write_lock_enabled"] is False
    assert patches[0]["write_lock_enabled"] is False


async def test_create_agent_uses_goal_override_when_env_set():
    """Purchase-flow experiments can force a stricter task prompt without editing tasks.json."""
    import os

    import benchmarks.run_benchmark as bench
    from benchmarks.benchmark_tasks import get_task_by_name

    bodies = []

    class FakeResponse:
        status_code = 201
        text = ""

        def json(self):
            return {"agent_id": "agent-123"}

    class FakeClient:
        def __init__(self, timeout):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, _url, *, headers, json):
            bodies.append(json)
            return FakeResponse()

    original_headers = bench._api_headers
    original_client = bench.httpx.AsyncClient
    original_env = os.environ.get("BENCHMARK_GOAL_OVERRIDE")
    try:

        async def fake_headers():
            return {"X-API-Key": "test-key"}

        bench._api_headers = fake_headers
        bench.httpx.AsyncClient = FakeClient
        os.environ["BENCHMARK_GOAL_OVERRIDE"] = "Override benchmark goal"

        await bench.create_agent("http://localhost:55120", get_task_by_name("browser-agent"))
    finally:
        bench._api_headers = original_headers
        bench.httpx.AsyncClient = original_client
        if original_env is None:
            os.environ.pop("BENCHMARK_GOAL_OVERRIDE", None)
        else:
            os.environ["BENCHMARK_GOAL_OVERRIDE"] = original_env

    assert bodies[0]["goal"] == "Override benchmark goal"
    assert "model" not in bodies[0]


async def test_create_agent_sends_task_response_schema():
    """Lifecycle tasks can prevent an inferred verifier schema from contradicting the prompt."""
    import benchmarks.run_benchmark as bench
    from benchmarks.benchmark_tasks import get_task_by_name

    bodies = []

    class FakeResponse:
        status_code = 201
        text = ""

        def json(self):
            return {"agent_id": "agent-123"}

    class FakeClient:
        def __init__(self, timeout):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, _url, *, headers, json):
            bodies.append(json)
            return FakeResponse()

    original_headers = bench._api_headers
    original_client = bench.httpx.AsyncClient
    try:

        async def fake_headers():
            return {"X-API-Key": "test-key"}

        bench._api_headers = fake_headers
        bench.httpx.AsyncClient = FakeClient
        task = get_task_by_name("agent-payment-abandonment")
        await bench.create_agent("http://localhost:55120", task)
    finally:
        bench._api_headers = original_headers
        bench.httpx.AsyncClient = original_client

    fields = bodies[0]["response_schema"]["fields"]
    assert [field["name"] for field in fields] == [
        "selected_product_names",
        "one_time_payment_card_number",
        "order_not_placed",
    ]
    assert all(field["required"] is True for field in fields)


def test_keep_failed_agents_only_preserves_failures():
    """The diagnostic flag preserves failed agents but still cleans up passes."""
    import os

    from benchmarks.run_benchmark import _should_delete_agent_after_run

    original = os.environ.pop("BENCHMARK_KEEP_AGENTS", None)
    try:
        assert _should_delete_agent_after_run(passed=True, keep_failed_agents=True) is True
        assert _should_delete_agent_after_run(passed=False, keep_failed_agents=True) is False
        assert _should_delete_agent_after_run(passed=False, keep_failed_agents=False) is True
    finally:
        if original is not None:
            os.environ["BENCHMARK_KEEP_AGENTS"] = original


def test_keep_agents_preserves_passed_and_failed_runs():
    """The keep-agents cleanup override keeps frontend links viewable after a run."""
    import os

    from benchmarks.run_benchmark import _should_delete_agent_after_run

    original = os.environ.get("BENCHMARK_KEEP_AGENTS")
    os.environ["BENCHMARK_KEEP_AGENTS"] = "true"
    try:
        assert _should_delete_agent_after_run(passed=True, keep_failed_agents=False) is False
        assert _should_delete_agent_after_run(passed=False, keep_failed_agents=False) is False
    finally:
        if original is None:
            os.environ.pop("BENCHMARK_KEEP_AGENTS", None)
        else:
            os.environ["BENCHMARK_KEEP_AGENTS"] = original


def test_keep_agents_env_preserves_successes_and_failures():
    """BENCHMARK_KEEP_AGENTS keeps passed agents loadable for UI audit."""
    import os

    from benchmarks.run_benchmark import _should_delete_agent_after_run

    original_env = os.environ.get("BENCHMARK_KEEP_AGENTS")
    os.environ["BENCHMARK_KEEP_AGENTS"] = "true"
    try:
        assert _should_delete_agent_after_run(passed=True, keep_failed_agents=False) is False
        assert _should_delete_agent_after_run(passed=False, keep_failed_agents=False) is False
    finally:
        if original_env is None:
            os.environ.pop("BENCHMARK_KEEP_AGENTS", None)
        else:
            os.environ["BENCHMARK_KEEP_AGENTS"] = original_env


def test_local_plan_batches_selected_benchmarks_together():
    """Local orchestrator runs selected benchmarks as one managed batch."""
    from benchmarks.local import plan_invocations

    invocations = plan_invocations(["chat-mode", "test-mass-agent-run-0", "browser-agent"])

    assert [(i.label, i.tasks, i.is_load) for i in invocations] == [
        ("benchmarks", ["chat-mode", "test-mass-agent-run-0", "browser-agent"], False),
    ]


async def test_tree_log_collection_fetches_supabase_once():
    """Tree diagnostics reuse time-windowed Supabase gateway logs."""
    from datetime import datetime, timezone

    import benchmarks.logs as logs

    fetch_calls = []
    collect_calls = []

    async def fake_fetch_supabase_logs(agent_id, start_time, end_time=None, limit=200):
        fetch_calls.append((agent_id, start_time, end_time, limit))
        return ["root research log"]

    async def fake_collect_logs(agent_id, agent_data, start_time, research_logs=None):
        collect_calls.append((agent_id, research_logs))
        return {
            "messages": [],
            "backend_logs": [],
            "worker_logs": [],
            "research_logs": list(research_logs or []),
            "realtime_logs": [],
        }

    original_fetch = logs.fetch_supabase_logs
    original_collect = logs.collect_logs
    try:
        logs.fetch_supabase_logs = fake_fetch_supabase_logs
        logs.collect_logs = fake_collect_logs

        start_time = datetime(2026, 5, 9, tzinfo=timezone.utc)

        async def fake_get_agent(_aid):
            return {"agent": {}}

        result = await logs.collect_tree_logs(
            "root-agent-id",
            [
                {
                    "agent_id": "root-agent-id",
                    "parent_agent_id": None,
                    "goal": "root",
                    "status": "ACTIVE",
                },
                {
                    "agent_id": "child-agent-id",
                    "parent_agent_id": "root-agent-id",
                    "goal": "child",
                    "status": "ACTIVE",
                },
            ],
            start_time,
            get_agent_fn=fake_get_agent,
        )
    finally:
        logs.fetch_supabase_logs = original_fetch
        logs.collect_logs = original_collect

    assert [call[0] for call in fetch_calls] == ["root-agent-id"]
    assert collect_calls == [
        ("root-agent-id", ["root research log"]),
        (
            "child-agent-id",
            ["[supabase] Gateway logs are tree-scoped; see root agent root-agent-i research logs"],
        ),
    ]
    assert result["root-agent-id"]["logs"]["research_logs"] == ["root research log"]
    assert result["child-agent-id"]["logs"]["research_logs"] == [
        "[supabase] Gateway logs are tree-scoped; see root agent root-agent-i research logs"
    ]


def test_local_benchmark_args_for_multi_task_preserve_explicit_order():
    """Multi-task local runs pass an exact ordered task list to the harness."""
    from benchmarks.local import build_benchmark_args

    args = build_benchmark_args(
        ["chat-mode", "browser-agent"],
        port=55120,
        bootstrap=True,
        max_concurrency=5,
    )

    assert args[0].endswith("python") or Path(args[0]).name.startswith("python")
    assert args[1:3] == ["-u", "benchmarks/run_benchmark.py"]
    selected = [args[index + 1] for index, value in enumerate(args) if value == "--task"]
    assert selected == ["chat-mode", "browser-agent"]
    assert "--suite" not in args
    assert "--exclude-task" not in args
    assert args[args.index("--port") + 1] == "55120"
    assert "--bootstrap" in args
    assert "--keep-failed-agents" in args
    assert args[args.index("--max-concurrency") + 1] == "5"


def test_run_benchmark_resolves_explicit_tasks_in_requested_order():
    """The harness scheduler receives explicit tasks in wrapper order."""
    from argparse import Namespace

    from benchmarks.run_benchmark import resolve_tasks

    args = Namespace(
        task=["browser-biometrics-webdecoy", "spawn-sub-agents", "chat-mode"],
        suite=None,
        exclude_task=[],
        prod=False,
    )

    assert [task.name for task in resolve_tasks(args)] == [
        "browser-biometrics-webdecoy",
        "spawn-sub-agents",
        "chat-mode",
    ]


def test_local_benchmark_args_pass_anon_to_run_benchmark():
    """Local --anon must reach the underlying benchmark harness."""
    from benchmarks.local import build_benchmark_args

    args = build_benchmark_args(["minted-agent-accounts-x"], port=55120, anon=True)

    assert args[args.index("--task") + 1] == "minted-agent-accounts-x"
    assert "--anon" in args


def test_local_benchmark_args_for_single_task_not_parallel():
    """A single task invocation is not run with --parallel."""
    from benchmarks.local import build_benchmark_args

    args = build_benchmark_args(["test-mass-agent-run-0"], port=55120)

    assert args[args.index("--task") + 1] == "test-mass-agent-run-0"
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

    assert [(f.name, f.agent_id, f.failure_reason) for f in failures] == [("browser-agent", "b2", "verifier failed")]


def test_local_benchmark_invocation_propagates_cache_ratchet_exit():
    """A saved all-task-pass artifact must not swallow a post-run ratchet failure.

    Captured from isolated smoke run 1784687608-25918-44421: the runner
    printed ``CACHE RATCHET FAILED`` and exited 1 after saving a 5/5 task
    artifact, but local.py returned success because it only re-read task pass
    fields from that artifact.
    """
    from benchmarks import local

    original_popen = local.subprocess.Popen
    with tempfile.TemporaryDirectory() as raw_dir:
        result_path = Path(raw_dir) / "cache-ratchet-run.json"
        result_path.write_text(json.dumps({"tasks": [{"name": "browser-smoke", "passed": True}]}))

        class FailedRatchetProcess:
            def __init__(self):
                self.stdout = iter(
                    [
                        f"  Results saved: {result_path}\n",
                        "  ❌ CACHE RATCHET FAILED (per-task repeatable prompt-cache hit floor)\n",
                    ]
                )

            @staticmethod
            def wait():
                return 1

        try:
            local.subprocess.Popen = lambda *_args, **_kwargs: FailedRatchetProcess()
            try:
                local.run_benchmark_invocation(
                    local.BenchmarkInvocation("benchmarks", ["browser-smoke"]),
                    port=55120,
                    bootstrap=False,
                    anon=False,
                    max_concurrency=1,
                )
                raise AssertionError("local benchmark wrapper swallowed the runner's exit code 1")
            except RuntimeError as exc:
                assert "exit code 1" in str(exc)
                assert str(result_path) in str(exc)

            # A task-level failure must still return the artifact so main() can
            # run agent_latency, agent_logs, and agent_cache before exiting 1.
            result_path.write_text(
                json.dumps(
                    {
                        "tasks": [
                            {
                                "name": "browser-smoke",
                                "passed": False,
                                "agent_id": "failed-agent",
                                "failure_reason": "verifier failed",
                            }
                        ]
                    }
                )
            )
            returned = local.run_benchmark_invocation(
                local.BenchmarkInvocation("benchmarks", ["browser-smoke"]),
                port=55120,
                bootstrap=False,
                anon=False,
                max_concurrency=1,
            )
            assert returned == result_path
        finally:
            local.subprocess.Popen = original_popen


def test_run_sh_manifest_writer_publishes_wmh_when_served():
    """run.sh's manifest writer carries ports.wmh + urls.wmh + a wmh service entry.

    Drives the exact embedded manifest-writer python from scripts/run.sh with WMH
    env set (as start_world_model_harness exports once the server is confirmed up),
    and asserts the additive WMH fields land in services.json. When WMH is NOT
    served, ports.wmh is 0 and urls.wmh is empty (gated off).
    """
    import json
    import re
    import subprocess
    import sys
    import tempfile
    from pathlib import Path

    repo_root = Path(__file__).resolve().parents[3]
    run_sh = (repo_root / "scripts" / "run.sh").read_text(encoding="utf-8")
    # Extract the embedded manifest-writer python heredoc (the one that emits
    # services.json — identified by its schema_version key, not the ngrok probe).
    candidates = re.findall(r"python3 - <<'PY'\n(.*?)\nPY\n", run_sh, re.DOTALL)
    manifest_pys = [c for c in candidates if "schema_version" in c and '"wmh"' in c]
    assert len(manifest_pys) == 1, "could not uniquely locate manifest-writer heredoc in scripts/run.sh"
    manifest_py = manifest_pys[0]

    def _write_manifest(env_extra: dict) -> dict:
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / ".context").mkdir()
            env = {
                "SERVICE_NAMES": "back-end,agents,wmh",
                "SERVICE_PIDS": "111,222,333",
                "SERVICE_STATUS": "running",
                "BENCHMARK_MODE": "true",
                "BACKEND_PORT": "55020",
                "HEALTH_PORT": "55022",
                "LOCAL_DB_PORT": "55025",
                "NGROK_WEB_PORT": "55029",
                "RUN_SH_PID": "999",
                "RUN_CONTEXT_DIR": ".context",
                "PATH": os.environ.get("PATH", ""),
                **env_extra,
            }
            subprocess.run(
                # sys.executable, not PATH-resolved "python3": the child env is
                # minimal (no HOME), which breaks version-manager shims (asdf
                # exits 126) whenever the venv isn't first on the caller's PATH.
                [sys.executable, "-c", manifest_py],
                cwd=tmp,
                env=env,
                check=True,
            )
            return json.loads((Path(tmp) / ".context" / "services.json").read_text())

    # Served: WMH manifest env is exported by run.sh once /healthz answers.
    served = _write_manifest(
        {
            "WMH_MANIFEST_PORT": "55026",
            "WMH_MANIFEST_URL": "http://localhost:55026",
            "WMH_MANIFEST_MODEL_NAME": "rose-archive",
        }
    )
    assert served["ports"]["wmh"] == 55026
    assert served["urls"]["wmh"] == "http://localhost:55026"
    assert served["wmh_model_name"] == "rose-archive"
    assert any(s["name"] == "wmh" and s["pid"] == 333 for s in served["services"])

    # Not served (plain run.sh): gated off — wmh port 0, url empty.
    gated = _write_manifest({})
    assert gated["ports"]["wmh"] == 0
    assert gated["urls"]["wmh"] == ""


def test_apply_manifest_environment_injects_wmh_base_url_and_model():
    """local.py injects WMH_BASE_URL + WMH_MODEL_NAME from the served manifest."""
    import os

    from benchmarks.local import apply_manifest_environment

    saved = {k: os.environ.get(k) for k in ("WMH_BASE_URL", "WMH_MODEL_NAME")}
    for key in saved:
        os.environ.pop(key, None)
    try:
        apply_manifest_environment(
            {
                "ports": {"backend": 55020, "health": 55022, "local_db": 55025, "wmh": 55026},
                "database": {"name": "victoria_test_manifest"},
                "urls": {"wmh": "http://localhost:55026/"},
                "wmh_model_name": "rose-archive",
            }
        )
        assert os.environ["WMH_BASE_URL"] == "http://localhost:55026"
        assert os.environ["WMH_MODEL_NAME"] == "rose-archive"

        # No wmh url in the manifest (gated off) → WMH env is left unset.
        os.environ.pop("WMH_BASE_URL", None)
        os.environ.pop("WMH_MODEL_NAME", None)
        apply_manifest_environment({"ports": {"backend": 55020, "health": 55022}, "urls": {}})
        assert "WMH_BASE_URL" not in os.environ
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


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


def test_local_services_manifest_reports_anon_capability():
    """--use-existing --anon must only target a stack started with anon backend env."""
    from benchmarks.local import services_manifest_anon_enabled

    assert services_manifest_anon_enabled(
        {
            "env": {
                "benchmark_anon_steel_profile": True,
                "benchmark_disable_saved_browser_auth": True,
            }
        }
    )
    assert not services_manifest_anon_enabled({"env": {"benchmark_anon_steel_profile": True}})
    assert not services_manifest_anon_enabled({"ports": {"backend": 55120}})


def test_local_manifest_uses_isolated_system_database_identity():
    """System-Postgres benchmark fixtures must not share the blackbox `victoria` database."""
    from benchmarks.local import manifest_database_url

    manifest = {
        "ports": {"local_db": 60245},
        "database": {
            "use_system_postgres": True,
            "port": 5432,
            "name": "victoria_bench_1783809252_85375_82461",
        },
    }

    assert manifest_database_url(manifest) == (
        "postgresql://postgres:postgres@localhost:5432/victoria_bench_1783809252_85375_82461"
    )


def test_runner_fixtures_use_isolated_system_database_identity():
    """Fixture SQL must target the same isolated DB named by the service stack."""
    from types import SimpleNamespace
    from unittest.mock import patch

    from benchmarks import run_benchmark

    manifest = {
        "ports": {"local_db": 55435},
        "database": {
            "use_system_postgres": True,
            "port": 5432,
            "runtime_port": 5432,
            "name": "victoria_bench_1784586845_71851_68350",
        },
    }
    prior_context = os.environ.get("BENCHMARK_CONTEXT_DIR")
    try:
        with tempfile.TemporaryDirectory() as context_dir:
            Path(context_dir, "services.json").write_text(json.dumps(manifest), encoding="utf-8")
            os.environ["BENCHMARK_CONTEXT_DIR"] = context_dir
            with patch.object(
                run_benchmark.subprocess,
                "run",
                return_value=SimpleNamespace(returncode=0, stdout="1\n", stderr=""),
            ):
                assert run_benchmark._local_victoria_database_url() == (
                    "postgresql://postgres:postgres@localhost:5432/victoria_bench_1784586845_71851_68350"
                )
    finally:
        if prior_context is None:
            os.environ.pop("BENCHMARK_CONTEXT_DIR", None)
        else:
            os.environ["BENCHMARK_CONTEXT_DIR"] = prior_context


def test_runner_fixtures_retry_transient_local_database_probe_timeout():
    """One bounded psql stall must not abort the benchmark before agent creation."""
    from types import SimpleNamespace
    from unittest.mock import patch

    from benchmarks import run_benchmark

    manifest = {
        "ports": {"local_db": 55435},
        "database": {
            "use_system_postgres": True,
            "port": 5432,
            "name": "victoria_bench_transient_probe",
        },
    }
    database_url = "postgresql://postgres:postgres@localhost:5432/victoria_bench_transient_probe"
    timeout = subprocess.TimeoutExpired(["psql", database_url], 5)
    prior_context = os.environ.get("BENCHMARK_CONTEXT_DIR")
    try:
        with tempfile.TemporaryDirectory() as context_dir:
            Path(context_dir, "services.json").write_text(json.dumps(manifest), encoding="utf-8")
            os.environ["BENCHMARK_CONTEXT_DIR"] = context_dir
            with (
                patch.object(
                    run_benchmark.subprocess,
                    "run",
                    side_effect=[
                        timeout,
                        SimpleNamespace(returncode=0, stdout="1\n", stderr=""),
                    ],
                ) as probe,
                patch.object(run_benchmark.time, "sleep") as sleep,
            ):
                assert run_benchmark._local_victoria_database_url() == database_url
        assert probe.call_count == 2
        sleep.assert_called_once()
    finally:
        if prior_context is None:
            os.environ.pop("BENCHMARK_CONTEXT_DIR", None)
        else:
            os.environ["BENCHMARK_CONTEXT_DIR"] = prior_context


def test_compute_token_preflight_uses_credential_source_not_restored_guest_database():
    """A Fly guest must source live credentials from its verified backend env, not its restored target."""
    from types import SimpleNamespace
    from unittest.mock import patch

    from benchmarks import run_benchmark

    isolated_database = "postgresql://postgres:postgres@localhost:5432/victoria"
    credential_source = "postgresql://prod.example.test:6543/postgres?pgbouncer=true"
    captured = {}

    def replay_seed_contract(_command, **kwargs):
        env = kwargs["env"]
        captured["source"] = env.get("SEED_COMPUTE_TOKEN_SOURCE_DATABASE_URL")
        if not captured["source"] or captured["source"] == isolated_database:
            return SimpleNamespace(
                returncode=1,
                stdout="",
                stderr="No usable claude_code integrations after sync",
            )
        return SimpleNamespace(returncode=0, stdout="compute token sync complete", stderr="")

    with tempfile.TemporaryDirectory() as temp_dir:
        backend_env = Path(temp_dir, "backend.env")
        backend_env.write_text(f'DATABASE_URL="{credential_source}"\n', encoding="utf-8")
        with (
            patch.object(run_benchmark, "_BACKEND_ENV", str(backend_env)),
            patch.object(
                run_benchmark,
                "_local_victoria_database_url",
                return_value=isolated_database,
            ),
            patch.object(run_benchmark, "_shared_workspace_database_url", return_value=None),
            patch.object(run_benchmark, "_run_seed_subprocess", side_effect=replay_seed_contract),
        ):
            assert run_benchmark._sync_compute_tokens(tolerate_gpt_code_unavailable=True) is True

    assert captured["source"] == credential_source


def test_runner_fixtures_fail_closed_when_isolated_database_is_unavailable():
    """An unreachable isolated DB must never redirect fixture writes to a shared DB."""
    from types import SimpleNamespace
    from unittest.mock import patch

    from benchmarks import run_benchmark

    manifest = {
        "ports": {"local_db": 55435},
        "database": {
            "use_system_postgres": True,
            "port": 5432,
            "name": "victoria_bench_unavailable",
        },
    }
    probed_urls = []

    def probe(command, **_kwargs):
        database_url = command[1]
        probed_urls.append(database_url)
        return SimpleNamespace(
            returncode=1 if database_url.endswith("/victoria_bench_unavailable") else 0,
            stdout="",
            stderr="connection failed",
        )

    prior_context = os.environ.get("BENCHMARK_CONTEXT_DIR")
    try:
        with tempfile.TemporaryDirectory() as context_dir:
            Path(context_dir, "services.json").write_text(json.dumps(manifest), encoding="utf-8")
            os.environ["BENCHMARK_CONTEXT_DIR"] = context_dir
            with patch.object(run_benchmark.subprocess, "run", side_effect=probe):
                assert run_benchmark._local_victoria_database_url() is None
        assert probed_urls == ["postgresql://postgres:postgres@localhost:5432/victoria_bench_unavailable"]
    finally:
        if prior_context is None:
            os.environ.pop("BENCHMARK_CONTEXT_DIR", None)
        else:
            os.environ["BENCHMARK_CONTEXT_DIR"] = prior_context


def test_runner_fixtures_reject_manifest_without_database_identity():
    """A partial manifest must not default destructive fixture writes to `victoria`."""
    from types import SimpleNamespace
    from unittest.mock import patch

    from benchmarks import run_benchmark

    manifest = {
        "ports": {"local_db": 55435},
        "database": {
            "use_system_postgres": True,
            "port": 5432,
        },
    }
    prior_context = os.environ.get("BENCHMARK_CONTEXT_DIR")
    try:
        with tempfile.TemporaryDirectory() as context_dir:
            Path(context_dir, "services.json").write_text(json.dumps(manifest), encoding="utf-8")
            os.environ["BENCHMARK_CONTEXT_DIR"] = context_dir
            with patch.object(
                run_benchmark.subprocess,
                "run",
                return_value=SimpleNamespace(returncode=0, stdout="1\n", stderr=""),
            ) as probe:
                try:
                    run_benchmark._local_victoria_database_url()
                except RuntimeError as exc:
                    assert "database name" in str(exc).lower()
                else:
                    raise AssertionError("partial manifest was allowed to target a default database")
                probe.assert_not_called()
    finally:
        if prior_context is None:
            os.environ.pop("BENCHMARK_CONTEXT_DIR", None)
        else:
            os.environ["BENCHMARK_CONTEXT_DIR"] = prior_context


def test_local_isolated_stack_opts_into_fast_seed_dump():
    """An isolated stack must use its own tunnel and restore a cached seed."""
    from benchmarks import local as local_bench

    captured = {}

    class FakeProcess:
        pass

    def fake_popen(command, **kwargs):
        captured["command"] = command
        captured["env"] = kwargs["env"]
        return FakeProcess()

    original_popen = local_bench.subprocess.Popen
    original_wait = local_bench.wait_for_services
    original_prime = local_bench._prime_local_seed_dump_from_shared_stack
    prior_seed_dump = os.environ.pop("BENCHMARK_SEED_DUMP", None)
    prior_ephemeral_tunnel = os.environ.get("BENCHMARK_EPHEMERAL_PUBLIC_TUNNEL")
    os.environ["BENCHMARK_EPHEMERAL_PUBLIC_TUNNEL"] = "0"
    try:
        local_bench.subprocess.Popen = fake_popen
        local_bench.wait_for_services = lambda *_args, **_kwargs: {"ports": {}}
        local_bench._prime_local_seed_dump_from_shared_stack = (
            lambda path: captured.setdefault("primed_seed_dump", path) is path
        )
        with tempfile.TemporaryDirectory() as tmp:
            context_dir = Path(tmp) / "isolated-run"
            stack = local_bench.ServiceStack(
                run_id="isolated-run",
                context_dir=context_dir,
                manifest_path=context_dir / "services.json",
                service_log=context_dir / "services.log",
                isolated=True,
                workspace_name="blackbox-bench-isolated-run",
                base_port=55120,
            )
            local_bench.start_services(stack, clean_first=False)

            seed_dump = Path(captured["env"]["BENCHMARK_SEED_DUMP"])
            assert seed_dump.parent == local_bench.BENCHMARK_CONTEXT_ROOT / "seed-cache"
            assert seed_dump.name.endswith(".dump")
            assert seed_dump.parent.is_dir()
            assert captured["primed_seed_dump"] == seed_dump
            assert captured["env"]["BENCHMARK_REQUIRE_SEED_DUMP"] == "1"
            assert captured["env"]["BENCHMARK_EPHEMERAL_PUBLIC_TUNNEL"] == "1"
            assert captured["command"] == ["bash", "scripts/run.sh", "--benchmark"]
    finally:
        local_bench.subprocess.Popen = original_popen
        local_bench.wait_for_services = original_wait
        local_bench._prime_local_seed_dump_from_shared_stack = original_prime
        if prior_seed_dump is not None:
            os.environ["BENCHMARK_SEED_DUMP"] = prior_seed_dump
        if prior_ephemeral_tunnel is None:
            os.environ.pop("BENCHMARK_EPHEMERAL_PUBLIC_TUNNEL", None)
        else:
            os.environ["BENCHMARK_EPHEMERAL_PUBLIC_TUNNEL"] = prior_ephemeral_tunnel


def test_local_shared_stack_preserves_public_tunnel_mode():
    """The shared dev stack must retain its configured stable tunnel mode."""
    from benchmarks import local as local_bench

    captured = {}

    class FakeProcess:
        pass

    def fake_popen(_command, **kwargs):
        captured["env"] = kwargs["env"]
        return FakeProcess()

    prior_ephemeral_tunnel = os.environ.get("BENCHMARK_EPHEMERAL_PUBLIC_TUNNEL")
    os.environ["BENCHMARK_EPHEMERAL_PUBLIC_TUNNEL"] = "0"
    try:
        with tempfile.TemporaryDirectory() as tmp:
            context_dir = Path(tmp) / "shared-run"
            stack = local_bench.ServiceStack(
                run_id="shared-run",
                context_dir=context_dir,
                manifest_path=context_dir / "services.json",
                service_log=context_dir / "services.log",
                isolated=False,
            )
            with (
                patch.object(local_bench.subprocess, "Popen", side_effect=fake_popen),
                patch.object(local_bench, "wait_for_services", return_value={"ports": {}}),
            ):
                local_bench.start_services(stack, clean_first=False)
        assert captured["env"]["BENCHMARK_EPHEMERAL_PUBLIC_TUNNEL"] == "0"
    finally:
        if prior_ephemeral_tunnel is None:
            os.environ.pop("BENCHMARK_EPHEMERAL_PUBLIC_TUNNEL", None)
        else:
            os.environ["BENCHMARK_EPHEMERAL_PUBLIC_TUNNEL"] = prior_ephemeral_tunnel


def test_local_seed_dump_primes_once_from_healthy_shared_stack():
    """Concurrent isolated launches reuse one schema-matched shared-stack snapshot."""
    from unittest.mock import patch

    from benchmarks import local as local_bench

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        seed_dump = root / "seed-cache" / "current.dump"
        manifest_path = root / "services.json"
        manifest_path.write_text(
            json.dumps(
                {
                    "status": "running",
                    "worktree": str(local_bench.REPO_ROOT),
                    "ports": {"backend": 55100, "local_db": 55105},
                    "database": {
                        "container": "victoria-db-test",
                        "name": "victoria",
                        "port": 55105,
                        "use_system_postgres": False,
                    },
                }
            )
        )
        commands = []

        def save_dump(command, **_kwargs):
            commands.append(command)
            Path(command[2]).parent.mkdir(parents=True, exist_ok=True)
            Path(command[2]).write_bytes(b"seed-dump")
            return subprocess.CompletedProcess(command, 0)

        with (
            patch.object(local_bench, "SERVICES_MANIFEST", manifest_path),
            patch.object(local_bench, "http_ok", return_value=True),
            patch.object(local_bench.subprocess, "run", side_effect=save_dump),
        ):
            assert local_bench._prime_local_seed_dump_from_shared_stack(seed_dump)
            assert local_bench._prime_local_seed_dump_from_shared_stack(seed_dump)

        assert len(commands) == 1
        assert commands[0][-1] == "victoria-db-test"
        schema_hash = hashlib.sha1(
            (local_bench.REPO_ROOT / "back-end" / "prisma" / "schema.prisma").read_bytes()
        ).hexdigest()
        assert Path(f"{seed_dump}.schemahash").read_text() == schema_hash


def test_local_start_services_reaps_process_when_readiness_fails():
    """A partially initialized isolated stack must not outlive its launcher."""
    from unittest.mock import patch

    from benchmarks import local as local_bench

    class FakeProcess:
        pass

    process = FakeProcess()
    with tempfile.TemporaryDirectory() as tmp:
        context_dir = Path(tmp) / "isolated-run"
        stack = local_bench.ServiceStack(
            run_id="isolated-run",
            context_dir=context_dir,
            manifest_path=context_dir / "services.json",
            service_log=context_dir / "services.log",
            isolated=True,
            workspace_name="blackbox-bench-isolated-run",
            base_port=55120,
        )
        with (
            patch.object(local_bench.subprocess, "Popen", return_value=process),
            patch.object(
                local_bench,
                "wait_for_services",
                side_effect=TimeoutError("services never became ready"),
            ),
            patch.object(local_bench, "stop_services") as stop_services,
        ):
            try:
                local_bench.start_services(stack, clean_first=False)
            except TimeoutError as exc:
                assert str(exc) == "services never became ready"
            else:
                raise AssertionError("start_services unexpectedly ignored the readiness failure")

        stop_services.assert_called_once_with(process, stack=stack)


def test_local_start_services_preserves_readiness_failure_when_cleanup_fails():
    """Cleanup diagnostics must not mask the startup failure that triggered them."""
    from unittest.mock import patch

    from benchmarks import local as local_bench

    class FakeProcess:
        pass

    process = FakeProcess()
    with tempfile.TemporaryDirectory() as tmp:
        context_dir = Path(tmp) / "isolated-run"
        stack = local_bench.ServiceStack(
            run_id="isolated-run",
            context_dir=context_dir,
            manifest_path=context_dir / "services.json",
            service_log=context_dir / "services.log",
            isolated=True,
            workspace_name="blackbox-bench-isolated-run",
            base_port=55120,
        )
        with (
            patch.object(local_bench.subprocess, "Popen", return_value=process),
            patch.object(
                local_bench,
                "wait_for_services",
                side_effect=TimeoutError("services never became ready"),
            ),
            patch.object(
                local_bench,
                "stop_services",
                side_effect=RuntimeError("cleanup failed"),
            ) as stop_services,
        ):
            try:
                local_bench.start_services(stack, clean_first=False)
            except TimeoutError as exc:
                assert str(exc) == "services never became ready"
            else:
                raise AssertionError("cleanup failure replaced the readiness failure")

        stop_services.assert_called_once_with(process, stack=stack)


def test_local_start_services_reaps_only_its_real_process_group():
    """Readiness rollback kills its process tree without touching a sibling."""
    from unittest.mock import patch

    from benchmarks import local as local_bench

    real_popen = subprocess.Popen
    owned_process = None
    with tempfile.TemporaryDirectory() as process_tmp:
        child_pid_path = Path(process_tmp) / "child.pid"

        def launch_owned_process(_command, **kwargs):
            nonlocal owned_process
            owned_process = real_popen(
                [
                    sys.executable,
                    "-c",
                    (
                        "import pathlib, subprocess, sys, time; "
                        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']); "
                        "pid_path = pathlib.Path(sys.argv[1]); "
                        "pending_path = pid_path.with_suffix('.tmp'); "
                        "pid_file = pending_path.open('w'); "
                        "time.sleep(0.2); "
                        "pid_file.write(str(child.pid)); "
                        "pid_file.close(); "
                        "pending_path.replace(pid_path); "
                        "time.sleep(60)"
                    ),
                    str(child_pid_path),
                ],
                **kwargs,
            )
            deadline = time.monotonic() + 5
            while not child_pid_path.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            assert child_pid_path.exists(), "owned process did not launch its child"
            return owned_process

        class SubprocessFacade:
            DEVNULL = subprocess.DEVNULL
            STDOUT = subprocess.STDOUT
            TimeoutExpired = subprocess.TimeoutExpired
            Popen = staticmethod(launch_owned_process)
            run = staticmethod(subprocess.run)

        sibling_process = real_popen(
            [sys.executable, "-c", "import time; time.sleep(60)"],
            cwd=local_bench.REPO_ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        try:
            with tempfile.TemporaryDirectory() as tmp:
                context_dir = Path(tmp) / "cleanup-owned-unique"
                stack = local_bench.ServiceStack(
                    run_id="cleanup-owned-unique",
                    context_dir=context_dir,
                    manifest_path=context_dir / "services.json",
                    service_log=context_dir / "services.log",
                    isolated=True,
                    workspace_name="blackbox-bench-cleanup-owned-unique",
                    base_port=55120,
                )
                with (
                    patch.object(local_bench, "subprocess", SubprocessFacade),
                    patch.object(local_bench, "_stop_owned_db_from_stack_identity"),
                    patch.object(local_bench, "_release_port_range") as release_port_range,
                    patch.object(
                        local_bench,
                        "wait_for_services",
                        side_effect=TimeoutError("services never became ready"),
                    ),
                ):
                    try:
                        local_bench.start_services(stack, clean_first=False)
                    except TimeoutError:
                        pass
                    else:
                        raise AssertionError("start_services unexpectedly ignored the readiness failure")
                release_port_range.assert_called_once_with(stack.base_port)

            assert owned_process is not None
            child_pid = int(child_pid_path.read_text())
            assert owned_process.poll() is not None, "the partially started process group survived"
            deadline = time.monotonic() + 5
            while _pid_is_live(child_pid) and time.monotonic() < deadline:
                time.sleep(0.05)
            assert not _pid_is_live(child_pid), "a child of the partially started group survived"
            assert sibling_process.poll() is None, "cleanup terminated an unrelated sibling process"
        finally:
            for process in (owned_process, sibling_process):
                if process is not None and process.poll() is None:
                    process.terminate()
                    process.wait(timeout=5)


def _pid_is_live(pid: int) -> bool:
    result = subprocess.run(
        ["ps", "-p", str(pid), "-o", "stat="],
        capture_output=True,
        text=True,
        check=False,
    )
    status = result.stdout.strip()
    return bool(status) and not status.startswith("Z")


def test_local_stop_services_removes_pre_manifest_owned_database():
    """Pre-manifest rollback derives only the exact isolated DB resource names."""
    from unittest.mock import patch

    from benchmarks import local as local_bench

    class StoppedProcess:
        pid = 12345

        @staticmethod
        def poll():
            return 0

    with tempfile.TemporaryDirectory() as tmp:
        context_dir = Path(tmp) / "cleanup-owned-unique"
        stack = local_bench.ServiceStack(
            run_id="cleanup-owned-unique",
            context_dir=context_dir,
            manifest_path=context_dir / "services.json",
            service_log=context_dir / "services.log",
            isolated=True,
            workspace_name="blackbox-bench-cleanup-owned-unique",
            base_port=55120,
        )
        with (
            patch.object(local_bench.subprocess, "run") as run,
            patch.object(local_bench, "_kill_scoped_processes_by_run_id"),
        ):
            local_bench.stop_services(StoppedProcess(), stack=stack)

    commands = [call.args[0] for call in run.call_args_list]
    assert [
        "docker",
        "rm",
        "-f",
        "victoria-db-blackbox-bench-cleanup-owned-unique",
    ] in commands
    assert [
        "docker",
        "volume",
        "rm",
        "victoria-pgdata-blackbox-bench-cleanup-owned-unique",
    ] in commands


def test_local_port_range_allocation_is_reserved_across_processes():
    """Concurrent launchers must not select identical or overlapping ranges."""
    from benchmarks import local as local_bench

    child = subprocess.Popen(
        [
            sys.executable,
            "-c",
            (
                "import time; "
                "from benchmarks.local import allocate_port_range; "
                "print(allocate_port_range(62000), flush=True); "
                "time.sleep(60)"
            ),
        ],
        cwd=local_bench.AGENTS_DIR,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    parent_bases = []
    try:
        assert child.stdout is not None
        child_base_text = child.stdout.readline().strip()
        assert child_base_text.isdigit(), f"child port allocation failed: {child_base_text!r}"
        child_base = int(child_base_text)
        def occupied(base):
            return {base + offset for offset in local_bench.PORT_RANGE_OFFSETS}

        overlapping_base = local_bench.allocate_port_range(child_base - 1)
        parent_bases.append(overlapping_base)
        assert occupied(overlapping_base).isdisjoint(occupied(child_base)), (
            "concurrent launchers reserved overlapping port ranges"
        )

        exact_base = local_bench.allocate_port_range(child_base)
        parent_bases.append(exact_base)
        assert occupied(exact_base).isdisjoint(occupied(child_base)), (
            "concurrent launchers reserved the same port range"
        )
    finally:
        release = getattr(local_bench, "_release_port_range", None)
        if release is not None:
            for parent_base in parent_bases:
                release(parent_base)
        child.terminate()
        child.wait(timeout=5)

    assert local_bench.PORT_RANGE_LOCK_ROOT.parent == Path(tempfile.gettempdir()), (
        "port reservations must coordinate sibling worktrees on the same host"
    )


def test_local_start_services_releases_port_reservation_after_readiness():
    """A ready isolated stack must release its startup-only port reservation."""
    from unittest.mock import Mock, patch

    from benchmarks import local as local_bench

    with tempfile.TemporaryDirectory() as tmp:
        context_dir = Path(tmp) / "ready-port-release"
        stack = local_bench.ServiceStack(
            run_id="ready-port-release",
            context_dir=context_dir,
            manifest_path=context_dir / "services.json",
            service_log=context_dir / "services.log",
            isolated=True,
            workspace_name="blackbox-bench-ready-port-release",
            base_port=55130,
        )
        process = Mock()
        manifest = {"backend": "http://localhost:55130"}
        with (
            patch.object(local_bench.subprocess, "Popen", return_value=process),
            patch.object(local_bench, "wait_for_services", return_value=manifest),
            patch.object(local_bench, "_release_port_range") as release_port_range,
        ):
            result = local_bench.start_services(stack, clean_first=False)

    assert result == (process, manifest)
    release_port_range.assert_called_once_with(stack.base_port)


def test_run_sh_seed_dump_targets_isolated_database_atomically():
    """System-Postgres isolated runs must restore/dump their per-run DB safely."""
    scripts = Path(__file__).resolve().parents[3] / "scripts"
    run_script = (scripts / "run.sh").read_text()
    save_helper = (scripts / "save-seed-dump.sh").read_text()

    assert "bash scripts/restore-seed-dump.sh" in run_script
    assert '"$_SEED_RESTORE_CONTAINER" >/dev/null' in run_script
    assert '"$_SEED_RESTORE_CONTAINER" >/dev/null 2>&1' not in run_script
    assert '_SEED_DUMP_CONTAINER="$DB_CONTAINER"' in run_script
    assert '"$_SEED_DUMP_CONTAINER"; then' in run_script
    assert '"$LOCAL_DB_NAME"' in run_script
    assert 'docker exec "$DB_CONTAINER" pg_dump' in save_helper
    assert '-Fc "$DB_NAME"' in save_helper
    assert 'mv "$DUMP_TMP" "$DUMP_PATH"' in save_helper
    assert 'rm -f "$_SEED_DUMP" "${_SEED_DUMP}.schemahash"' in run_script
    required_guard = run_script.index('if [ "${BENCHMARK_REQUIRE_SEED_DUMP:-0}" = "1" ]')
    cold_sync = run_script.index('echo "🌱 Syncing production data to local database (first run)..."')
    assert required_guard < cold_sync
    assert "refusing a slow production cold-sync" in run_script


def test_seed_dump_restore_uses_target_container_pg_restore():
    """A newer host client must not restore into the older per-run DB server."""
    repo_root = Path(__file__).resolve().parents[3]
    helper = repo_root / "scripts" / "restore-seed-dump.sh"

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        command_log = tmp_path / "commands.log"
        dump = tmp_path / "seed.dump"
        dump.write_bytes(b"custom-archive-fixture")

        host_restore = tmp_path / "pg_restore"
        host_restore.write_text(
            "#!/bin/sh\n"
            'echo "host pg_restore $*" >> "$COMMAND_LOG"\n'
            "echo 'unrecognized configuration parameter \"transaction_timeout\"' >&2\n"
            "exit 1\n"
        )
        host_restore.chmod(0o755)

        docker = tmp_path / "docker"
        docker.write_text('#!/bin/sh\necho "docker $*" >> "$COMMAND_LOG"\ncat >/dev/null\nexit 0\n')
        docker.chmod(0o755)

        result = subprocess.run(
            [
                "bash",
                str(helper),
                str(dump),
                "localhost",
                "55395",
                "postgres",
                "victoria",
                "victoria-db-owned-run",
            ],
            cwd=repo_root,
            env={
                **os.environ,
                "PATH": f"{tmp_path}:{os.environ.get('PATH', '')}",
                "COMMAND_LOG": str(command_log),
            },
            text=True,
            capture_output=True,
            check=False,
        )

        assert result.returncode == 0, result.stdout + result.stderr
        calls = command_log.read_text()
        assert "docker exec -i victoria-db-owned-run pg_restore" in calls
        assert "host pg_restore" not in calls


def test_workspace_dependency_preflight_respects_hoisted_installs():
    """A healthy hoisted npm workspace must not reinstall on every stack boot."""
    repo_root = Path(__file__).resolve().parents[3]
    helper = repo_root / "scripts" / "ensure-workspace-dependencies.sh"

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        workspace = tmp_path / "back-end"
        workspace.mkdir()
        (workspace / "package.json").write_text('{"name":"test-back-end"}\n')
        command_log = tmp_path / "commands.log"
        installed_marker = tmp_path / "installed"
        fake_bin = tmp_path / "bin"
        fake_bin.mkdir()
        npm = fake_bin / "npm"
        npm.write_text(
            "#!/bin/sh\n"
            'echo "$*" >> "$COMMAND_LOG"\n'
            'if [ "$1" = "pkg" ]; then exit 0; fi\n'
            'if [ "$1" = "ls" ]; then [ "${NPM_GRAPH_READY:-0}" = 1 ] || [ -f "$INSTALLED_MARKER" ]; exit; fi\n'
            'if [ "$1" = "install" ]; then touch "$INSTALLED_MARKER"; exit 0; fi\n'
            "exit 1\n"
        )
        npm.chmod(0o755)
        common_env = {
            **os.environ,
            "PATH": f"{fake_bin}:{os.environ.get('PATH', '')}",
            "COMMAND_LOG": str(command_log),
            "INSTALLED_MARKER": str(installed_marker),
        }

        ready = subprocess.run(
            ["bash", str(helper), "back-end"],
            cwd=tmp_path,
            env={**common_env, "NPM_GRAPH_READY": "1"},
            text=True,
            capture_output=True,
            check=False,
        )
        assert ready.returncode == 0, ready.stdout + ready.stderr
        assert command_log.read_text().splitlines() == [
            "pkg get name --workspace=back-end --silent",
            "ls --workspace=back-end --depth=0 --silent",
        ]

        command_log.write_text("")
        missing = subprocess.run(
            ["bash", str(helper), "back-end"],
            cwd=tmp_path,
            env={**common_env, "NPM_GRAPH_READY": "0"},
            text=True,
            capture_output=True,
            check=False,
        )
        assert missing.returncode == 0, missing.stdout + missing.stderr
        assert command_log.read_text().splitlines() == [
            "pkg get name --workspace=back-end --silent",
            "ls --workspace=back-end --depth=0 --silent",
            "install --workspace=back-end --no-audit --no-fund",
            "ls --workspace=back-end --depth=0 --silent",
        ]


def test_workspace_dependency_preflight_supports_standalone_packages():
    """A package outside root workspaces must run npm in its own directory."""
    repo_root = Path(__file__).resolve().parents[3]
    helper = repo_root / "scripts" / "ensure-workspace-dependencies.sh"

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        (tmp_path / "package.json").write_text('{"name":"test-root","workspaces":["back-end"]}\n')
        standalone = tmp_path / "mac-app"
        standalone.mkdir()
        (standalone / "package.json").write_text('{"name":"test-mac-app"}\n')
        command_log = tmp_path / "commands.log"
        installed_marker = tmp_path / "installed"
        fake_bin = tmp_path / "bin"
        fake_bin.mkdir()
        npm = fake_bin / "npm"
        npm.write_text(
            "#!/bin/sh\n"
            'echo "$PWD::$*" >> "$COMMAND_LOG"\n'
            'if [ "$1" = "pkg" ]; then exit 1; fi\n'
            'if [ "$1" = "ls" ]; then [ -f "$INSTALLED_MARKER" ]; exit; fi\n'
            'if [ "$1" = "install" ]; then touch "$INSTALLED_MARKER"; exit 0; fi\n'
            "exit 1\n"
        )
        npm.chmod(0o755)

        result = subprocess.run(
            ["bash", str(helper), "mac-app"],
            cwd=tmp_path,
            env={
                **os.environ,
                "PATH": f"{fake_bin}:{os.environ.get('PATH', '')}",
                "COMMAND_LOG": str(command_log),
                "INSTALLED_MARKER": str(installed_marker),
            },
            text=True,
            capture_output=True,
            check=False,
        )

        assert result.returncode == 0, result.stdout + result.stderr
        commands = command_log.read_text().splitlines()
        assert commands == [
            f"{tmp_path.resolve()}::pkg get name --workspace=mac-app --silent",
            f"{standalone.resolve()}::ls --depth=0 --silent",
            f"{standalone.resolve()}::install --no-audit --no-fund",
            f"{standalone.resolve()}::ls --depth=0 --silent",
        ], commands


def test_workspace_dependency_preflight_rejects_missing_package_manifest():
    """A misspelled package path must fail instead of bypassing preflight."""
    repo_root = Path(__file__).resolve().parents[3]
    helper = repo_root / "scripts" / "ensure-workspace-dependencies.sh"

    with tempfile.TemporaryDirectory() as tmp:
        result = subprocess.run(
            ["bash", str(helper), "does-not-exist"],
            cwd=tmp,
            text=True,
            capture_output=True,
            check=False,
        )

        assert result.returncode != 0
        assert "does-not-exist/package.json" in result.stderr


def test_run_sh_reuses_reachable_workspace_db_before_docker_daemon_probe():
    """Only the expected workspace container may bypass a busy Docker probe."""
    run_script = (Path(__file__).resolve().parents[3] / "scripts" / "run.sh").read_text()

    reachable_probe = 'pg_isready -h localhost -p "$LOCAL_DB_PORT" -U postgres -d victoria -q'
    ownership_probe = "workspace_db_container_owns_port &&"
    assert 'docker inspect "$DB_CONTAINER"' in run_script
    assert 'container_port" = "$LOCAL_DB_PORT"' in run_script
    assert reachable_probe in run_script
    assert ownership_probe in run_script
    assert run_script.index(ownership_probe) < run_script.index(reachable_probe)
    assert run_script.index(reachable_probe) < run_script.index("docker_info_quick; then")
    assert "if $PRESTARTED_WORKSPACE_DB; then" in run_script

    function_start = run_script.index("workspace_db_container_owns_port() {")
    function_end = run_script.index("\n}\n", function_start) + 3
    ownership_function = run_script[function_start:function_end]
    with tempfile.TemporaryDirectory() as tmp:
        fake_docker = Path(tmp) / "docker"
        fake_docker.write_text('#!/bin/sh\nprintf "%s\\n" "$FAKE_CONTAINER_PORT"\n')
        fake_docker.chmod(0o755)
        env = {
            **os.environ,
            "PATH": f"{tmp}:{os.environ.get('PATH', '')}",
        }
        command = (
            ownership_function
            + "\nDB_CONTAINER=victoria-db-bamako\nLOCAL_DB_PORT=55235\n"
            + "workspace_db_container_owns_port\n"
        )
        owned = subprocess.run(
            ["bash", "-c", command],
            env={**env, "FAKE_CONTAINER_PORT": "55235"},
            check=False,
        )
        foreign = subprocess.run(
            ["bash", "-c", command],
            env={**env, "FAKE_CONTAINER_PORT": "55205"},
            check=False,
        )
        assert owned.returncode == 0
        assert foreign.returncode != 0


def test_run_sh_required_seed_failure_cleans_exact_owned_database():
    """Fail-fast seed preflight must reap only the DB resource this run created."""
    run_script = (Path(__file__).resolve().parents[3] / "scripts" / "run.sh").read_text()
    function_start = run_script.index("cleanup_seed_bootstrap_database() {")
    function_end = run_script.index("\n}\n", function_start) + 3
    cleanup_function = run_script[function_start:function_end]

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        command_log = tmp_path / "commands.log"
        for command in ("docker", "dropdb"):
            executable = tmp_path / command
            executable.write_text(f'#!/bin/sh\necho "{command} $*" >> "$COMMAND_LOG"\n')
            executable.chmod(0o755)

        common_env = {
            **os.environ,
            "PATH": f"{tmp_path}:{os.environ.get('PATH', '')}",
            "COMMAND_LOG": str(command_log),
        }
        subprocess.run(
            [
                "bash",
                "-c",
                cleanup_function
                + "\nUSE_SYSTEM_PG=true\nSYSTEM_DB_OWNED_BY_US=true\n"
                + "DB_OWNED_CONTAINER_ID=''\nLOCAL_DB_NAME=victoria_bench_owned\n"
                + "cleanup_seed_bootstrap_database\n",
            ],
            env=common_env,
            check=True,
        )
        subprocess.run(
            [
                "bash",
                "-c",
                cleanup_function
                + "\nUSE_SYSTEM_PG=false\nSYSTEM_DB_OWNED_BY_US=false\n"
                + "DB_OWNED_CONTAINER_ID=owned-id\nDB_CONTAINER=victoria-db-owned\n"
                + "DB_VOLUME=victoria-pgdata-owned\ncleanup_seed_bootstrap_database\n",
            ],
            env=common_env,
            check=True,
        )

        commands = command_log.read_text().splitlines()
        assert commands == [
            "dropdb -h localhost -p 5432 -U postgres --if-exists victoria_bench_owned",
            "docker rm -f victoria-db-owned",
            "docker volume rm victoria-pgdata-owned",
        ]


def test_local_extract_results_path_and_diagnostic_commands():
    """Local wrapper finds runner result paths and builds all three diagnostics."""
    from benchmarks.local import diagnostic_commands, extract_results_path

    output = "hello\n  Results saved: /tmp/bench.json\nbye\n"
    assert str(extract_results_path(output)) == "/tmp/bench.json"

    commands = diagnostic_commands("agent-123", task_name="browser-agent", port=55120)
    joined = [" ".join(command) for command in commands]
    assert any("agent_latency.py agent-123" in command for command in joined)
    assert any(
        "agent_logs.py agent-123 --tree --diagnostics --url http://localhost:55120" in command for command in joined
    )
    assert any("agent_cache.py agent-123" in command for command in joined)


def test_agent_cache_stats_respects_provider_accounting():
    """agent_cache reinterprets old llm.cache rows with provider-specific denominators."""
    from benchmarks.agent_cache import _cache_stats

    claude = _cache_stats(
        {
            "actual_model": "claude-sonnet-4-6-claude",
            "prompt_tokens": 500,
            "cache_read": 4500,
            "cache_write": 100,
        }
    )
    assert claude["cache_accounting"] == "exclusive"
    assert claude["cache_hit_pct"] == 88

    gpt = _cache_stats(
        {
            "actual_model": "gpt-5.5-gpt",
            "prompt_tokens": 9859,
            "cache_read": 9472,
            "cache_write": 0,
        }
    )
    assert gpt["cache_accounting"] == "inclusive"
    assert gpt["cache_hit_pct"] == 96


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

    def slow_command(_agent_id, *, task_name, port):
        assert task_name == "browser-agent"
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

    summary = _build_smoke_memory_summary(before, after, platform_name="linux")

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


def test_build_smoke_memory_summary_scales_end_cap_by_worker_count():
    """All-core local workers keep the absolute RSS cap proportional to process count."""
    from benchmarks.run_benchmark import _build_smoke_memory_summary

    before = {
        "available": True,
        "process_count": 12,
        "total_rss_mb": 1847.6,
        "playwright_driver_count": 0,
        "playwright_driver_rss_mb": 0.0,
    }
    after = {
        "available": True,
        "process_count": 12,
        "total_rss_mb": 1989.4,
        "playwright_driver_count": 0,
        "playwright_driver_rss_mb": 0.0,
    }

    summary = _build_smoke_memory_summary(
        before,
        after,
        baseline={"after": {"allocator_trimmed": False}},
        platform_name="darwin",
    )

    assert summary["thresholds"]["effective_max_end_mb"] == 2640.0
    assert summary["failures"] == []


def test_build_smoke_memory_summary_flags_scaled_end_cap_overage():
    """The scaled cap still fails genuinely high worker RSS."""
    from benchmarks.run_benchmark import _build_smoke_memory_summary

    before = {
        "available": True,
        "process_count": 12,
        "total_rss_mb": 1847.6,
        "playwright_driver_count": 0,
        "playwright_driver_rss_mb": 0.0,
    }
    after = {
        "available": True,
        "process_count": 12,
        "total_rss_mb": 3000.0,
        "playwright_driver_count": 0,
        "playwright_driver_rss_mb": 0.0,
    }

    summary = _build_smoke_memory_summary(
        before,
        after,
        baseline={"after": {"allocator_trimmed": False}},
        platform_name="darwin",
    )

    assert any("effective cap for 12 process" in failure for failure in summary["failures"])


def test_build_smoke_memory_summary_skips_darwin_growth_without_allocator_trim():
    """macOS RSS growth is a warning when allocator pressure relief cannot trim arenas."""
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
        "playwright_driver_count": 0,
        "playwright_driver_rss_mb": 0.0,
    }

    summary = _build_smoke_memory_summary(
        before,
        after,
        baseline={"after": {"allocator_trimmed": False}},
        platform_name="darwin",
    )

    assert summary["thresholds"]["growth_enforced"] is False
    assert summary["failures"] == []
    assert "RSS grew" in summary["growth_warning"]


def test_build_smoke_memory_summary_enforces_linux_growth():
    """Linux/glibc smoke keeps the RSS growth ratchet enforced."""
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
        "playwright_driver_count": 0,
        "playwright_driver_rss_mb": 0.0,
    }

    summary = _build_smoke_memory_summary(
        before,
        after,
        baseline={"after": {"allocator_trimmed": False}},
        platform_name="linux",
    )

    assert summary["thresholds"]["growth_enforced"] is True
    assert any("RSS grew" in failure for failure in summary["failures"])


def test_local_worker_health_url_prefers_explicit_smoke_url():
    """Smoke memory warmup uses the explicit health URL when the harness provides it."""
    import os

    from benchmarks.run_benchmark import _local_worker_health_url

    original = os.environ.get("SMOKE_HEALTH_URL")
    try:
        os.environ["SMOKE_HEALTH_URL"] = "http://localhost:55132/"
        assert _local_worker_health_url("http://localhost:55130") == "http://localhost:55132"
    finally:
        if original is None:
            os.environ.pop("SMOKE_HEALTH_URL", None)
        else:
            os.environ["SMOKE_HEALTH_URL"] = original


def test_local_worker_health_url_derives_from_backend_port():
    """Local smoke memory warmup pairs the worker health port with the backend port."""
    import os

    from benchmarks.run_benchmark import _local_worker_health_url

    original = os.environ.pop("SMOKE_HEALTH_URL", None)
    try:
        assert _local_worker_health_url("http://localhost:55130") == "http://localhost:55132"
        assert _local_worker_health_url("https://navi-j9a9.onrender.com") is None
    finally:
        if original is not None:
            os.environ["SMOKE_HEALTH_URL"] = original


def test_benchmark_memory_baseline_endpoint_is_guarded():
    """Worker memory warmup endpoint is unavailable unless benchmark mode enables it."""
    import os

    import health_server

    original_env = os.environ.pop("ENABLE_BENCHMARK_MEMORY_BASELINE", None)
    original_baseline = health_server._benchmark_memory_baseline
    health_server._benchmark_memory_baseline = lambda: {"ok": True}
    try:
        with health_server.app.test_client() as client:
            disabled = client.post("/benchmark/memory-baseline")
            assert disabled.status_code == 404

            os.environ["ENABLE_BENCHMARK_MEMORY_BASELINE"] = "1"
            enabled = client.post("/benchmark/memory-baseline")
            assert enabled.status_code == 200
            assert enabled.get_json() == {"ok": True}
    finally:
        health_server._benchmark_memory_baseline = original_baseline
        if original_env is None:
            os.environ.pop("ENABLE_BENCHMARK_MEMORY_BASELINE", None)
        else:
            os.environ["ENABLE_BENCHMARK_MEMORY_BASELINE"] = original_env


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
                "toolName": "spawn_agent",
                "toolStatus": "FINISHED",
                "toolCallId": "browser-via-spawn-agent",
                "agentType": "browser",
                "subAgentId": "browser-1",
            }
        },
        {
            "metadata": {
                "toolName": "spawn_general_purpose_agent",
                "toolStatus": "FINISHED",
                "toolCallId": "sub-1",
                "subAgentId": "agent-1",
            }
        },
        {
            "metadata": {
                "toolName": "spawn_general_purpose_agent",
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
                "toolName": "spawn_browser_agent",
                "toolStatus": "FINISHED",
                "toolCallId": "browser-current-complete",
                "title": "Browser automation complete",
            }
        },
        {
            "metadata": {
                "toolName": "spawn_browser_agent",
                "toolStatus": "FINISHED",
                "toolCallId": "browser-progress",
                "title": "Navigated -> https://example.com",
                "action_type": "goto",
                "subAgentId": "browser-1",
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
        "spawn_general_purpose_agent": 1,
        "spawn_browser_agent": 3,
        "spawn_claude_code_agent": 1,
        "message_person": 1,
    }


def test_logical_tool_counts_include_model_facing_routed_calls():
    """A model-facing spawn_agent call remains observable after browser routing."""
    from benchmarks.run_benchmark import _count_logical_tool_calls_from_messages

    messages = [
        {
            "role": "ASSISTANT",
            "metadata": {
                "tool_calls": [
                    {
                        "tool": "spawn_agent",
                        "type": "browser",
                        "tool_call_id": "browser-1",
                    },
                    {
                        "tool": "spawn_agent",
                        "type": "browser",
                        "tool_call_id": "browser-2",
                    },
                ]
            },
        },
        {
            "role": "TOOL",
            "metadata": {
                "toolName": "spawn_browser_agent",
                "toolStatus": "FINISHED",
                "toolCallId": "payment-request-1",
                "action_type": "request_payment_card",
                "subAgentId": "browser-task-1",
            },
        },
        {
            "role": "TOOL",
            "metadata": {
                "toolName": "spawn_browser_agent",
                "toolStatus": "FINISHED",
                "toolCallId": "payment-request-2",
                "action_type": "request_payment_card",
                "subAgentId": "browser-task-2",
            },
        },
        {
            "role": "TOOL",
            "metadata": {
                "toolName": "spawn_browser_agent",
                "toolStatus": "FINISHED",
                "toolCallId": "browser-1",
                "title": "Browser automation complete",
            },
        },
        {
            "role": "TOOL",
            "metadata": {
                "toolName": "spawn_browser_agent",
                "toolStatus": "FINISHED",
                "toolCallId": "browser-2",
                "title": "Browser automation complete",
            },
        },
    ]

    assert _count_logical_tool_calls_from_messages(messages) == {
        "spawn_agent": 2,
        "spawn_browser_agent": 2,
        "request_payment_card": 2,
    }


def test_cache_coverage_uses_root_scoped_tool_counts():
    """Cache coverage validates top-level path coverage, not child verifier internals."""
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _count_logical_tool_calls_from_messages

    task = get_task_by_name("cache-coverage")

    assert task.tool_count_scope == "root"
    assert task.expected_tool_counts == {
        "spawn_agent": 1,
        "spawn_general_purpose_agent": 1,
        "spawn_browser_agent": 1,
        "spawn_claude_code_agent": 1,
        "message_person": 1,
    }

    messages = [
        {
            "metadata": {
                "toolName": "spawn_general_purpose_agent",
                "toolStatus": "FINISHED",
                "toolCallId": "sias-1",
                "childToolCounts": {
                    "spawn_agent": 1,
                    "spawn_claude_code_agent": 1,
                },
            }
        },
    ]

    assert _count_logical_tool_calls_from_messages(messages) == {
        "spawn_general_purpose_agent": 1,
    }


def test_message_person_benchmark_requires_confirmed_send():
    """Neither FINISHED nor enqueue alone can satisfy the send benchmark."""
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _validate_message_person_confirmed_send

    task = get_task_by_name("message-person")
    assert task.expected_tool_counts == {"message_person": 1}
    assert task.tool_count_scope == "root"

    false_success = {
        "messages": [
            {
                "metadata": {
                    "toolName": "message_person",
                    "toolStatus": "FINISHED",
                    "title": "iMessage sent",
                }
            }
        ]
    }
    assert _validate_message_person_confirmed_send(false_success) is not None

    enqueue_only = {
        "messages": [
            {
                "metadata": {
                    "toolName": "message_person",
                    "toolStatus": "FINISHED",
                    "data": {
                        "delivery": {
                            "channel": "imessage",
                            "queue_id": "imq_receipt_1",
                        }
                    },
                }
            }
        ]
    }
    assert _validate_message_person_confirmed_send(enqueue_only) is not None

    confirmed_send = {
        "messages": [
            {
                "metadata": {
                    "toolName": "message_person",
                    "toolStatus": "FINISHED",
                    "data": {
                        "delivery": {
                            "channel": "imessage",
                            "queue_id": "imq_receipt_1",
                            "status": "sent",
                            "sent_at": "2026-07-11T22:00:00.000Z",
                        }
                    },
                }
            }
        ]
    }
    assert _validate_message_person_confirmed_send(confirmed_send) is None


def test_message_person_agent_sms_benchmark_requires_immediate_provider_receipt():
    """The Agent SMS bench cannot pass on queue metadata or a label-only FINISHED event."""
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _validate_message_person_agent_sms_send

    task = get_task_by_name("message-person-agent-sms")
    assert task.group == "daily"
    assert task.expected_tool_counts == {"message_person": 1}
    assert task.tool_count_scope == "root"

    wrong_transport = {
        "messages": [
            {
                "metadata": {
                    "toolName": "message_person",
                    "toolStatus": "FINISHED",
                    "data": {
                        "delivery": {
                            "channel": "imessage",
                            "status": "queued",
                            "queue_id": "imq-wrong",
                        }
                    },
                }
            }
        ]
    }
    assert _validate_message_person_agent_sms_send(wrong_transport) is not None

    provider_send = {
        "messages": [
            {
                "metadata": {
                    "toolName": "message_person",
                    "toolStatus": "FINISHED",
                    "data": {
                        "delivery": {
                            "channel": "agent_sms",
                            "status": "sent",
                            "provider": "agentphone",
                            "provider_channel": "sms",
                            "message_id": "msg-live-receipt",
                        }
                    },
                }
            }
        ]
    }
    assert _validate_message_person_agent_sms_send(provider_send) is None


async def test_message_person_bridge_preflight_requires_fresh_mac():
    """The live send bench cannot launch against a backend with no active Mac poller."""
    import benchmarks.run_benchmark as bench

    calls = []
    payload = {"connected": True, "last_seen_at": "2026-07-11T22:00:00.000Z"}

    class FakeResponse:
        status_code = 200
        text = ""

        @staticmethod
        def json():
            return payload

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url, headers):
            calls.append((url, headers))
            return FakeResponse()

    async def fake_headers():
        return {"X-API-Key": "bench-key", "X-User-Id": "bench-user"}

    original_client = bench.httpx.AsyncClient
    original_headers = bench._api_headers
    bench.httpx.AsyncClient = FakeClient
    bench._api_headers = fake_headers
    try:
        await bench._preflight_message_person_bridge("https://backend.example")
        assert calls == [
            (
                "https://backend.example/api/imessage/bridge/status",
                {"X-API-Key": "bench-key", "X-User-Id": "bench-user"},
            )
        ]

        payload = {"connected": False, "last_seen_at": None}
        try:
            await bench._preflight_message_person_bridge("https://backend.example")
            raise AssertionError("Disconnected Mac bridge should fail the preflight")
        except RuntimeError as exc:
            assert "authenticated Mac app polling this exact backend" in str(exc)
    finally:
        bench.httpx.AsyncClient = original_client
        bench._api_headers = original_headers


def test_tool_count_expectations_support_minimums_and_forbidden_tools():
    """Benchmark tasks can require direct tools and reject unintended sub-agents."""
    from benchmarks.run_benchmark import _validate_tool_count_expectations

    assert (
        _validate_tool_count_expectations(
            {"web_search": 3},
            {"web_search": 3},
            ["spawn_agent", "spawn_general_purpose_agent"],
        )
        is None
    )
    assert "expected at least 3" in _validate_tool_count_expectations(
        {"web_search": 2},
        {"web_search": 3},
        [],
    )
    assert "Forbidden tool 'spawn_agent'" in _validate_tool_count_expectations(
        {"web_search": 3, "spawn_agent": 1},
        {"web_search": 3},
        ["spawn_agent"],
    )


def test_user_data_prod_grep_requires_all_provider_filters():
    """Prod user-data benchmark cannot pass with generic document grep calls."""
    from benchmarks.run_benchmark import _validate_user_data_prod_grep_messages

    def grep_msg(provider: str, *, body_field: str = "text") -> dict:
        return {
            body_field: (
                "**Params Passed:**\n\n"
                "- **pattern**: project\n"
                "- **source**: documents\n"
                "- **filters**: {\n"
                f'  "document_source": "{provider}"\n'
                "}\n\n"
                "**Result:**\n\n**Grep Matches:** 1 shown / 1 total"
            ),
            "metadata": {
                "toolName": "grep",
                "toolStatus": "FINISHED",
                "toolCallId": f"grep-{provider}",
            },
        }

    def final_summary_msg(
        *,
        checklist_key: str = "provider_validation_checklist",
        verified_key: str = "appears_verified_from_prod_data",
    ) -> dict:
        return {
            "metadata": {
                "completionSummary": {
                    "outputs": [
                        {
                            "key": checklist_key,
                            "value": [
                                {
                                    "provider": "chatgpt",
                                    "grep_filters_used": 'source="documents", filters.document_source="chatgpt"',
                                    "exact_evidence_snippet": "no synced document evidence",
                                    "document_path": "none",
                                    verified_key: False,
                                },
                                {
                                    "provider": "claude",
                                    "grep_filters_used": 'source="documents", filters.document_source="claude"',
                                    "exact_evidence_snippet": "goal",
                                    "document_path": "documents/claude/session.json",
                                    verified_key: True,
                                },
                                {
                                    "provider": "apple_notes",
                                    "grep_filters_used": 'source="documents", filters.document_source="apple_notes"',
                                    "exact_evidence_snippet": "project",
                                    "document_path": "documents/apple_notes/Apple Note/apple-notes:1",
                                    verified_key: True,
                                },
                                {
                                    "provider": "obsidian",
                                    "grep_filters_used": 'source="documents", filters.document_source="obsidian"',
                                    "exact_evidence_snippet": "tool",
                                    "document_path": "documents/obsidian/vault/note.md",
                                    verified_key: True,
                                },
                            ],
                        }
                    ]
                }
            }
        }

    assert (
        _validate_user_data_prod_grep_messages(
            [
                {
                    "metadata": {
                        "toolName": "spawn_agent",
                        "toolStatus": "FINISHED",
                        "toolCallId": "spawn-explore",
                    },
                },
                grep_msg("chatgpt"),
                grep_msg("claude"),
                grep_msg("apple_notes"),
                grep_msg("obsidian"),
                final_summary_msg(),
            ]
        )
        is None
    )

    assert (
        _validate_user_data_prod_grep_messages(
            [
                {
                    "metadata": {
                        "toolName": "spawn_agent",
                        "toolStatus": "FINISHED",
                        "toolCallId": "spawn-explore",
                    },
                },
                grep_msg("chatgpt", body_field="message"),
                grep_msg("claude", body_field="message"),
                grep_msg("apple_notes", body_field="message"),
                grep_msg("obsidian", body_field="message"),
                final_summary_msg(
                    checklist_key="provider_verification_checklist",
                    verified_key="verified_from_prod_data",
                ),
            ]
        )
        is None
    )

    failure = _validate_user_data_prod_grep_messages(
        [
            {
                "text": (
                    "**Params Passed:**\n\n"
                    "- **pattern**: project\n"
                    "- **source**: documents\n\n"
                    "**Result:**\n\n**Grep Matches:** 4 shown / 4 total"
                ),
                "metadata": {
                    "toolName": "grep",
                    "toolStatus": "FINISHED",
                    "toolCallId": "grep-generic",
                },
            }
        ]
    )
    assert failure is not None
    assert "filters.document_source" in failure
    assert "chatgpt" in failure
    assert "obsidian" in failure

    no_spawn_failure = _validate_user_data_prod_grep_messages(
        [
            grep_msg("chatgpt"),
            grep_msg("claude"),
            grep_msg("apple_notes"),
            grep_msg("obsidian"),
            final_summary_msg(),
        ]
    )
    assert no_spawn_failure is not None
    assert "explore spawn_agent" in no_spawn_failure

    wrong_spawn_failure = _validate_user_data_prod_grep_messages(
        [
            {
                "metadata": {
                    "toolName": "spawn_general_purpose_agent",
                    "toolStatus": "FINISHED",
                    "toolCallId": "spawn-general",
                },
            },
            grep_msg("chatgpt"),
            grep_msg("claude"),
            grep_msg("apple_notes"),
            grep_msg("obsidian"),
            final_summary_msg(),
        ]
    )
    assert wrong_spawn_failure is not None
    assert "spawn_general_purpose_agent" in wrong_spawn_failure

    # Gate A no longer parses the final structured checklist (H-01): four completed
    # source='documents' greps via a completed explore spawn PASS the mechanical gate even without
    # a completionSummary. The final-answer PASS/VERIFY quality is judged semantically instead
    # (see test_user_data_prod_grep_final_answer_semantic_judge).
    no_final_pass = _validate_user_data_prod_grep_messages(
        [
            {
                "metadata": {
                    "toolName": "spawn_agent",
                    "toolStatus": "FINISHED",
                    "toolCallId": "spawn-explore",
                },
            },
            grep_msg("chatgpt"),
            grep_msg("claude"),
            grep_msg("apple_notes"),
            grep_msg("obsidian"),
        ]
    )
    assert no_final_pass is None


def test_user_data_prod_grep_final_answer_semantic_judge():
    """H-01: the final answer is judged by a REUSABLE, key-name-agnostic semantic output judge over
    the agent's POPULATED output schema (completion-summary outputs + generated response_schema), not
    a rigid structured parse and not free-text assistant prose.

    response_schema auto-generates at agent-create and its shape varies, so the old rigid parse
    produced false 'Seen: []' failures. The judge now asks only whether each required field is
    recoverable from the populated output regardless of key name."""
    import asyncio
    from unittest.mock import AsyncMock, patch
    from benchmarks.run_benchmark import (
        SEMANTIC_OUTPUT_EXPECTATIONS,
        _extract_agent_structured_output,
        _judge_output_recovers_expected_fields,
    )

    # The agent's POPULATED output (arbitrary key names) — NOT the four expected field names.
    messages = [
        {
            "role": "ASSISTANT",
            "text": "here is my summary",
            "metadata": {
                "completionSummary": {
                    "outputs": [
                        {
                            "key": "provider_audit",  # deliberately not our expected key names
                            "value": [
                                {"who": "chatgpt", "note": "no synced document evidence"},
                                {"who": "claude", "path": "documents/claude/session.json"},
                                {"who": "apple_notes", "path": "documents/apple_notes/note:1"},
                                {"who": "obsidian", "path": "documents/obsidian/vault/note.md"},
                            ],
                        }
                    ]
                }
            },
        },
    ]
    root_data = {"agent": {"response_schema": {"fields": [{"name": "provider_audit"}]}}}

    blob = _extract_agent_structured_output(messages, root_data)
    assert "provider_audit" in blob and "documents/claude/session.json" in blob
    # The extractor judges the populated output schema, not free-text prose.
    assert "here is my summary" not in blob

    schema = SEMANTIC_OUTPUT_EXPECTATIONS["user-data-prod-grep"]
    # The expectation is a response_schema the verifier must POPULATE before scoring.
    assert schema["fields"] and all("type" in f for f in schema["fields"])

    # The judge passes the expected schema to check_progress as response_schema (populate-first)
    # and uses the standard verifier prompt — assert that wiring, not just the score.
    def _assert_populate_then_score(**kwargs):
        assert kwargs["response_schema"] == schema  # verifier must populate THIS schema
        assert "grounded tool evidence" in kwargs["verifier_system_prompt"]  # approved verifier
        return {"score": 1.0, "reasoning": "all four recoverable", "output": {"chatgpt_evidence": "no data"}}

    with patch("helpers.llm.check_progress", new=AsyncMock(side_effect=_assert_populate_then_score)):
        result = asyncio.run(
            _judge_output_recovers_expected_fields("agent-1", blob, schema, "user-data-prod-grep")
        )
    assert result is None

    # Judge FAILS (score < 1.0) → failure carries the populated output + reason.
    with patch(
        "helpers.llm.check_progress",
        new=AsyncMock(
            return_value={
                "score": 0.5,
                "reasoning": "could not recover obsidian_evidence",
                "output": {"obsidian_evidence": None},
            }
        ),
    ):
        failure = asyncio.run(
            _judge_output_recovers_expected_fields("agent-1", blob, schema, "user-data-prod-grep")
        )
    assert failure is not None and "obsidian_evidence" in failure and "need 1.0" in failure

    # No populated output → judged as missing without an LLM call.
    empty = asyncio.run(
        _judge_output_recovers_expected_fields("agent-1", "{}", schema, "user-data-prod-grep")
    )
    assert empty is not None and "no populated output schema" in empty

    # REUSABLE / not overfitted: the same judge works for a totally different task's schema
    # (receipt id + cost) with arbitrary agent key names — proving it isn't pinned to one task.
    receipt_messages = [
        {
            "metadata": {
                "completionSummary": {
                    "outputs": [{"key": "order", "value": {"confirmation": "tp_c505", "paid": 43.96}}]
                }
            }
        }
    ]
    receipt_blob = _extract_agent_structured_output(receipt_messages, None)
    receipt_schema = {
        "fields": [
            {"name": "receipt_id", "type": "str", "description": "order/receipt/confirmation id"},
            {"name": "cost", "type": "float", "description": "total amount paid, any key name"},
        ]
    }
    with patch(
        "helpers.llm.check_progress",
        new=AsyncMock(
            return_value={"score": 1.0, "reasoning": "both present", "output": {"receipt_id": "tp_c505", "cost": 43.96}}
        ),
    ):
        receipt_ok = asyncio.run(
            _judge_output_recovers_expected_fields("a2", receipt_blob, receipt_schema, "receipt-task")
        )
    assert receipt_ok is None


def test_admin_bypass_card_mint_variant_wiring():
    """The admin-bypass card-mint benchmark inverts the gate contract: same depleted fixture, a
    synthetic ADMIN run user, and an assertion that a card is minted with NO subscription gate."""
    from benchmarks.run_benchmark import (
        GATE_FIXTURE_TASK_MODES,
        GATE_FIXTURE_TASK_USER_IDS,
        PURCHASE_SUBSCRIPTION_GATE_TASK_NAME,
        PURCHASE_SUBSCRIPTION_ADMIN_BYPASS_TASK_NAME,
        PURCHASE_SUBSCRIPTION_GATE_USER_ID,
        ADMIN_SUBSCRIPTION_BYPASS_USER_ID,
    )
    from benchmarks.benchmark_tasks import get_task_by_name

    # Both variants share the depleted purchase-subscription fixture...
    assert (
        GATE_FIXTURE_TASK_MODES[PURCHASE_SUBSCRIPTION_ADMIN_BYPASS_TASK_NAME]
        == "purchase-subscription"
    )
    assert GATE_FIXTURE_TASK_MODES[PURCHASE_SUBSCRIPTION_GATE_TASK_NAME] == "purchase-subscription"
    # ...but run as different users: a synthetic admin vs a plain non-admin.
    assert (
        GATE_FIXTURE_TASK_USER_IDS[PURCHASE_SUBSCRIPTION_ADMIN_BYPASS_TASK_NAME]
        == ADMIN_SUBSCRIPTION_BYPASS_USER_ID
    )
    assert (
        GATE_FIXTURE_TASK_USER_IDS[PURCHASE_SUBSCRIPTION_GATE_TASK_NAME]
        == PURCHASE_SUBSCRIPTION_GATE_USER_ID
    )
    assert ADMIN_SUBSCRIPTION_BYPASS_USER_ID != PURCHASE_SUBSCRIPTION_GATE_USER_ID

    non_admin = get_task_by_name(PURCHASE_SUBSCRIPTION_GATE_TASK_NAME)
    admin = get_task_by_name(PURCHASE_SUBSCRIPTION_ADMIN_BYPASS_TASK_NAME)

    # Non-admin still expects the blocking subscription gate.
    assert non_admin.expected_gate and non_admin.expected_gate.get("type") == "subscription"
    non_admin_checks = {c["type"] for e in non_admin.evaluators for c in e.get("checks", [])}
    assert "expected_gate" in non_admin_checks

    # Admin variant expects NO gate — instead a minted-card payment receipt.
    assert getattr(admin, "expected_gate", None) is None
    assert admin.expected_payment_receipt is True
    admin_checks = {c["type"] for e in admin.evaluators for c in e.get("checks", [])}
    assert "expected_gate" not in admin_checks
    assert "expected_payment_receipt" in admin_checks


def test_parallel_tool_calls_smoke_requires_explore_sub_agents():
    """The parallel search smoke should exercise execute-phase explore fanout."""
    from benchmarks.benchmark_tasks import get_task_by_name

    task = get_task_by_name("parallel-tool-calls")

    assert task.start_phase == "execute"
    assert task.expected_tools == ["spawn_agent"]
    assert task.min_tool_counts == {"spawn_agent": 3}
    assert "explore sub-agents" in task.prompt
    assert "spawn_agent" not in task.forbidden_tools
    assert "spawn_general_purpose_agent" in task.forbidden_tools


def test_user_data_prod_grep_prompt_avoids_nested_agent_instruction():
    """Prod user-data task should not tell provider agents to spawn more agents."""
    from benchmarks.benchmark_tasks import get_task_by_name

    task = get_task_by_name("user-data-prod-grep")

    assert task.min_tool_counts == {"grep": 4}
    assert 'spawn_agent with type="explore"' in task.prompt
    assert 'Do not use type="general_purpose"' in task.prompt
    assert "output_schema" in task.prompt
    assert "must call grep directly four times" in task.prompt
    assert "exactly one" not in task.prompt.lower()


def test_spawn_sub_agents_smoke_forbids_browser_and_code_detours():
    """Population smoke should exercise general-purpose fanout without slow browser/code paths."""
    from benchmarks.benchmark_tasks import get_task_by_name

    task = get_task_by_name("spawn-sub-agents")

    assert task.min_tool_counts == {"web_search": 2}
    assert task.expected_tool_counts["spawn_general_purpose_agent"] == 2
    assert task.expected_tool_counts["spawn_browser_agent"] == 0
    assert task.expected_tool_counts["spawn_claude_code_agent"] == 0
    assert "explore-agent web research" in task.prompt


def test_phone_call_tasks_define_two_sided_verification():
    """Both phone benchmarks pair a callee persona with agent- and callee-side checks."""
    from benchmarks.benchmark_tasks import get_task_by_name

    intake = get_task_by_name("phone-call-client-intake")
    assert intake.expected_tools == ["call_phone_number"]
    assert intake.expected_tool_counts == {"call_phone_number": 1}
    assert intake.approval_handling == "auto_approve"
    assert "{callee_phone_number}" in intake.prompt
    assert "exactly once" in intake.prompt
    assert intake.pinned_facts == {
        "client_full_name": "Jordan Miles",
        "client_mailing_address": "4821 Maplewood Drive, Austin, Texas 78731",
    }
    assert intake.phone_persona["system_prompt"]
    assert "first_message" not in intake.phone_persona
    assert "Wait for the caller to speak first" in intake.phone_persona["system_prompt"]
    assert "endCall tool" in intake.phone_persona["system_prompt"]
    assert intake.phone_persona["structured_data_schema"]["type"] == "object"
    assert "jordan" in intake.expected_call_findings
    assert intake.expected_final_findings == [
        "Jordan Miles",
        "4821 Maplewood Drive, Austin, Texas 78731",
    ]
    assert intake.callee_checks["caller_requested_name"] is True
    assert intake.callee_checks["provided_full_name"] == "Jordan Miles"
    assert intake.callee_checks["provided_mailing_address"] == "4821 Maplewood Drive, Austin, Texas 78731"

    payment = get_task_by_name("phone-call-payment")
    assert payment.expected_tools == ["call_phone_number"]
    assert payment.expected_tool_counts == {"call_phone_number": 1}
    assert "{callee_phone_number}" in payment.prompt
    assert "exactly once" in payment.prompt
    assert "4242 4242 4242 4242" in payment.prompt
    assert payment.pinned_facts == {
        "order_item": "Dozen red roses with delivery",
        "total_charged_usd": "34.20",
        "card_last_four": "4242",
        "confirmation_code": "ROSE-4471",
    }
    assert "first_message" not in payment.phone_persona
    assert "Wait for the caller to speak first" in payment.phone_persona["system_prompt"]
    assert payment.callee_checks["card_last_four"] == "4242"
    assert payment.callee_checks["payment_completed"] is True
    assert payment.callee_checks["payment_tool_succeeded"] is True
    assert payment.callee_checks["stripe_payment_intent_id"] == "pi_"
    assert payment.callee_checks["confirmation_code"] == "ROSE-4471"
    assert payment.callee_checks["total_charged_usd"] == "34.20"
    assert "4471" in payment.expected_call_findings
    assert payment.expected_final_findings == ["ROSE-4471", "34.20"]
    assert "Preserve spelled letters in alphanumeric confirmation codes exactly" in payment.prompt
    # The persona must gate the confirmation code behind full payment details.
    assert "ROSE-4471" in payment.phone_persona["system_prompt"]
    assert "Spell the confirmation code exactly as letters R O S E" in payment.phone_persona["system_prompt"]
    assert "do not pronounce ROSE as a word" in payment.phone_persona["system_prompt"]
    assert "complete_test_payment" in payment.phone_persona["tools"]
    assert "tool result status is succeeded" in payment.phone_persona["system_prompt"]
    assert "use the endCall tool" in payment.phone_persona["system_prompt"]


def test_phone_callee_assistant_base_has_end_call_tool_and_duration_cap():
    """Benchmark callees can end completed calls instead of waiting for max duration."""
    from benchmarks.phone_callee import _CALLEE_ASSISTANT_BASE

    assert _CALLEE_ASSISTANT_BASE["maxDurationSeconds"] == 150


def test_phone_callee_session_number_names_follow_provider_contract():
    """Transient number names remain unique within Vapi's documented API limit."""
    from benchmarks.phone_callee import PhoneCalleeSession, VAPI_PHONE_NUMBER_NAME_MAX_LENGTH

    first = PhoneCalleeSession("phone-a", {"system_prompt": "persona a"}, api_key="test")
    second = PhoneCalleeSession("phone-b", {"system_prompt": "persona b"}, api_key="test")

    assert VAPI_PHONE_NUMBER_NAME_MAX_LENGTH == 40
    assert first.phone_number_name != second.phone_number_name
    assert len(first.phone_number_name) <= 40
    assert len(second.phone_number_name) <= 40


async def test_phone_callee_waits_for_new_number_activation():
    """Fresh Vapi numbers wait out the provider's documented activation window."""
    from datetime import datetime, timedelta, timezone
    from unittest.mock import AsyncMock, patch

    from benchmarks.phone_callee import CALLEE_SESSION_NUMBER_ACTIVATION_DELAY, PhoneCalleeSession

    session = PhoneCalleeSession("phone-a", {"system_prompt": "persona"}, api_key="test")
    fresh = {"createdAt": datetime.now(timezone.utc).isoformat()}
    active = {
        "createdAt": (
            datetime.now(timezone.utc) - CALLEE_SESSION_NUMBER_ACTIVATION_DELAY - timedelta(seconds=1)
        ).isoformat()
    }

    sleep = AsyncMock()
    with patch("benchmarks.phone_callee.asyncio.sleep", sleep):
        await session._wait_for_number_activation(fresh)
        await session._wait_for_number_activation(active)

    sleep.assert_awaited_once()
    assert CALLEE_SESSION_NUMBER_ACTIVATION_DELAY.total_seconds() - 1 <= sleep.await_args.args[0]
    assert sleep.await_args.args[0] <= CALLEE_SESSION_NUMBER_ACTIVATION_DELAY.total_seconds()


async def test_phone_callee_activation_cancellation_deletes_owned_number():
    """Cancellation during activation cannot orphan a quota-limited Vapi number."""
    import asyncio
    from datetime import datetime, timezone
    from unittest.mock import AsyncMock, patch

    from benchmarks.phone_callee import PhoneCalleeSession

    class Response:
        def __init__(self, status_code, payload):
            self.status_code = status_code
            self._payload = payload
            self.text = json.dumps(payload)

        def json(self):
            return self._payload

        def raise_for_status(self):
            if self.status_code >= 400:
                raise AssertionError(f"unexpected response status {self.status_code}")

    class Client:
        def __init__(self):
            self.deleted = []

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        async def get(self, path):
            assert path == "/phone-number"
            return Response(200, [])

        async def post(self, path, json):
            assert path == "/phone-number"
            return Response(
                201,
                {
                    "id": "fresh-owned-number",
                    "name": json["name"],
                    "number": "+16195550109",
                    "createdAt": datetime.now(timezone.utc).isoformat(),
                },
            )

        async def delete(self, path):
            self.deleted.append(path)
            return Response(200, {})

    client = Client()
    session = PhoneCalleeSession("phone-a", {"system_prompt": "persona"}, api_key="test")
    with (
        patch("benchmarks.phone_callee._configured_number_id_for_task", return_value=""),
        patch("benchmarks.phone_callee.httpx.AsyncClient", return_value=client),
        patch("benchmarks.phone_callee.asyncio.sleep", AsyncMock(side_effect=asyncio.CancelledError)),
    ):
        try:
            await session.setup()
        except asyncio.CancelledError:
            pass
        else:
            raise AssertionError("activation cancellation must propagate")

    assert client.deleted == ["/phone-number/fresh-owned-number"]


async def test_phone_callee_sessions_isolate_distributed_phone_number_resources():
    """Independent benchmark processes must not attach personas to one shared number."""
    import asyncio
    from unittest.mock import patch

    from benchmarks.phone_callee import CALLEE_NUMBER_NAME, PhoneCalleeSession

    class Response:
        def __init__(self, status_code, payload):
            self.status_code = status_code
            self._payload = payload
            self.text = json.dumps(payload)

        def json(self):
            return self._payload

        def raise_for_status(self):
            if self.status_code >= 400:
                raise AssertionError(f"unexpected response status {self.status_code}")

    class Client:
        def __init__(self, suffix):
            self.suffix = suffix
            self.created = []

        async def get(self, path):
            assert path == "/phone-number"
            return Response(
                200,
                [
                    {
                        "id": "shared-number",
                        "name": CALLEE_NUMBER_NAME,
                        "number": "+16195550100",
                    }
                ],
            )

        async def post(self, path, json):
            assert path == "/phone-number"
            self.created.append(json)
            return Response(
                201,
                {
                    "id": f"isolated-{self.suffix}",
                    "name": json["name"],
                    "number": f"+1619555010{self.suffix}",
                    "createdAt": "2020-01-01T00:00:00Z",
                },
            )

    first = PhoneCalleeSession("phone-a", {"system_prompt": "persona a"}, api_key="test")
    second = PhoneCalleeSession("phone-b", {"system_prompt": "persona b"}, api_key="test")
    first_client = Client("1")
    second_client = Client("2")
    with patch("benchmarks.phone_callee._configured_number_id_for_task", return_value=""):
        await asyncio.gather(
            first._ensure_phone_number(first_client),
            second._ensure_phone_number(second_client),
        )

    assert first.phone_number_id != second.phone_number_id, (
        f"distributed sessions shared phone number {first.phone_number_id}"
    )
    assert len(first_client.created) == 1
    assert len(second_client.created) == 1


async def test_phone_callee_reclaims_only_stale_session_owned_numbers():
    """Orphan reclamation cannot delete persistent or currently live callee numbers."""
    from datetime import datetime, timedelta, timezone

    from benchmarks.phone_callee import CALLEE_NUMBER_NAME, CALLEE_SESSION_NUMBER_PREFIX, PhoneCalleeSession

    class Response:
        status_code = 200
        text = "ok"

    class Client:
        def __init__(self):
            self.deleted = []

        async def delete(self, path):
            self.deleted.append(path)
            return Response()

    now = datetime.now(timezone.utc)
    client = Client()
    session = PhoneCalleeSession("phone-a", {"system_prompt": "persona"}, api_key="test")
    await session._reclaim_stale_session_numbers(
        client,
        [
            {
                "id": "persistent",
                "name": CALLEE_NUMBER_NAME,
                "createdAt": (now - timedelta(days=1)).isoformat(),
            },
            {
                "id": "fresh-session",
                "name": f"{CALLEE_SESSION_NUMBER_PREFIX}fresh",
                "createdAt": now.isoformat(),
            },
            {
                "id": "stale-session",
                "name": f"{CALLEE_SESSION_NUMBER_PREFIX}stale",
                "createdAt": (now - timedelta(days=1)).isoformat(),
            },
        ],
    )

    assert client.deleted == ["/phone-number/stale-session"]


async def test_phone_callee_cleanup_deletes_only_explicitly_owned_number():
    """Cleanup deletes transient session numbers without touching configured overrides."""
    from benchmarks.phone_callee import PhoneCalleeSession

    class Response:
        status_code = 200
        text = "ok"

    class Client:
        def __init__(self):
            self.deleted = []

        async def delete(self, path):
            self.deleted.append(path)
            return Response()

    client = Client()
    owned = PhoneCalleeSession("phone-a", {"system_prompt": "persona"}, api_key="test")
    owned.phone_number_id = "owned-number"
    owned.phone_number = "+16195550101"
    owned._owns_phone_number = True
    await owned._delete_owned_phone_number(client)

    configured = PhoneCalleeSession("phone-b", {"system_prompt": "persona"}, api_key="test")
    configured.phone_number_id = "configured-number"
    configured.phone_number = "+16195550102"
    await configured._delete_owned_phone_number(client)

    assert client.deleted == ["/phone-number/owned-number"]
    assert owned.phone_number_id == ""
    assert configured.phone_number_id == "configured-number"


def test_missing_call_findings_tolerates_spacing_and_punctuation():
    """Finding matcher survives transcript formatting like '48 21' or 'rose 4471'."""
    from benchmarks.phone_callee import missing_call_findings

    haystack = "Client is Jordan Miles, at 48 21 Maplewood Drive. Confirmation: rose 4471."
    assert missing_call_findings(["jordan", "miles", "4821", "rose-4471"], haystack) == []
    assert missing_call_findings(["78731"], haystack) == ["78731"]

    spelled_code = "The confirmation code is R O S E dash four four seven one."
    assert missing_call_findings(["ROSE-4471"], spelled_code) == []
    assert missing_call_findings(["ROSE-4471"], "The confirmation code is Rosa-4471.") == ["ROSE-4471"]


def test_phone_search_text_includes_phone_call_metadata():
    """Agent-side haystack covers message text AND phoneCall metadata (transcript, structuredData)."""
    from benchmarks.phone_callee import phone_search_text

    data = {
        "messages": [
            {"message": "Call completed", "metadata": {"phoneCall": {"structuredData": {"zip": "78731"}}}},
            {"text": "The client is Jordan Miles."},
        ]
    }
    text = phone_search_text(data)
    assert "78731" in text


def test_phone_final_result_text_excludes_raw_transcript_evidence():
    """Returned-data checks cannot pass just because the raw call transcript had the right fact."""
    from benchmarks.phone_callee import missing_call_findings
    from benchmarks.run_benchmark import phone_final_result_text

    data = {
        "messages": [
            {
                "role": "TOOL",
                "text": "Call completed",
                "metadata": {
                    "toolName": "call_phone_number",
                    "phoneCall": {"transcript": "User: code is R O S E dash four four seven one"},
                },
            },
            {
                "role": "TOOL",
                "text": "Extracted Output:\n- Order Confirmation Code: Rosa-4471\n- Total: 34.20",
                "metadata": {"toolName": "attempt_completion", "toolStatus": "FINISHED"},
            },
        ]
    }

    final_text = phone_final_result_text(data)
    assert "Rosa-4471" in final_text
    assert "R O S E" not in final_text
    assert missing_call_findings(["ROSE-4471"], final_text) == ["ROSE-4471"]


def test_flatten_pinned_call_findings_extracts_string_leaves():
    """Pinned facts become agent-side evidence requirements."""
    from benchmarks.run_benchmark import _flatten_pinned_call_findings

    findings = _flatten_pinned_call_findings(
        {
            "client": {"name": "Jordan Miles", "address": "4821 Maplewood Drive"},
            "payment": {"total": 34.20, "confirmation": "ROSE-4471"},
        }
    )

    assert "Jordan Miles" in findings
    assert "4821 Maplewood Drive" in findings
    assert "34.2" in findings
    assert "ROSE-4471" in findings


def test_callee_check_failures_coerce_bools_and_match_strings_loosely():
    """Callee-side checks: lenient bool coercion, squashed string containment, exact otherwise."""
    from benchmarks.phone_callee import callee_check_failures

    expected = {
        "payment_completed": True,
        "card_last_four": "4242",
        "caller_requested_name": True,
        "provided_mailing_address": "4821 Maplewood Drive, Austin, Texas 78731",
    }
    actual = {
        "payment_completed": "true",
        "card_last_four": "ending in 42 42",
        "caller_requested_name": False,
        "provided_mailing_address": "four eight two one Maplewood Drive, Austin, Texas seven eight seven three one",
    }
    failures = callee_check_failures(expected, actual)
    assert len(failures) == 1
    assert failures[0].startswith("caller_requested_name")

    assert callee_check_failures({"payment_completed": True}, {}) == ["payment_completed: expected True, got None"]


def test_payment_audit_structured_data_since_returns_latest_successful_payment():
    """Callee-side payment checks use backend tool results newer than the active session."""
    import os
    import tempfile
    from datetime import datetime, timezone
    from pathlib import Path

    from benchmarks.phone_callee import payment_audit_structured_data_since

    previous = os.environ.get("PHONE_BENCHMARK_PAYMENT_AUDIT_PATH")
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "payments.jsonl"
        path.write_text(
            "\n".join(
                [
                    '{"createdAt":"2026-07-02T21:59:00Z","status":"succeeded","paymentIntentId":"pi_old"}',
                    '{"createdAt":"2026-07-02T22:01:00Z","status":"failed","error":"cvc is required"}',
                    (
                        '{"createdAt":"2026-07-02T22:02:00Z","status":"succeeded",'
                        '"paymentIntentId":"pi_new","amountCents":3420,"confirmationCode":"ROSE-4471"}'
                    ),
                ]
            )
            + "\n"
        )
        os.environ["PHONE_BENCHMARK_PAYMENT_AUDIT_PATH"] = str(path)
        try:
            data = payment_audit_structured_data_since(datetime(2026, 7, 2, 22, 0, 0, tzinfo=timezone.utc))
        finally:
            if previous is None:
                os.environ.pop("PHONE_BENCHMARK_PAYMENT_AUDIT_PATH", None)
            else:
                os.environ["PHONE_BENCHMARK_PAYMENT_AUDIT_PATH"] = previous

    assert data == {
        "payment_completed": True,
        "confirmation_code_given": True,
        "payment_tool_succeeded": True,
        "stripe_payment_intent_id": "pi_new",
        "confirmation_code": "ROSE-4471",
        "total_charged_usd": "34.20",
    }


def test_resolve_callee_prompt_requires_active_session():
    """{callee_phone_number} without a live callee session must fail loudly, not call a stale number."""
    from benchmarks.phone_callee import resolve_callee_prompt

    resolved = resolve_callee_prompt("Call the client at {callee_phone_number} now.", "+15551234567", "t")
    assert resolved == "Call the client at +15551234567 now."
    assert resolve_callee_prompt("No placeholder here.", "", "t") == "No placeholder here."

    try:
        resolve_callee_prompt("Call {callee_phone_number}.", "", "phone-call-client-intake")
        raise AssertionError("expected RuntimeError for missing callee session")
    except RuntimeError as exc:
        assert "phone-call-client-intake" in str(exc)


def test_benchmark_public_base_url_uses_env_override():
    """Phone payment tool webhooks can use an explicit public benchmark URL."""
    import os

    from benchmarks.phone_callee import benchmark_public_base_url

    previous = os.environ.get("BENCHMARK_PHONE_TOOL_BASE_URL")
    os.environ["BENCHMARK_PHONE_TOOL_BASE_URL"] = "https://benchmark.example"
    try:
        assert benchmark_public_base_url() == "https://benchmark.example"
    finally:
        if previous is None:
            os.environ.pop("BENCHMARK_PHONE_TOOL_BASE_URL", None)
        else:
            os.environ["BENCHMARK_PHONE_TOOL_BASE_URL"] = previous


def test_benchmark_public_base_url_uses_isolated_context_manifest_not_dashboard_url():
    """Vapi callbacks use the isolated stack's public origin, never controller-local UI metadata."""
    import os
    import tempfile
    from pathlib import Path

    from benchmarks.phone_callee import benchmark_public_base_url

    keys = (
        "BENCHMARK_PHONE_TOOL_BASE_URL",
        "PUBLIC_BASE_URL",
        "BENCHMARK_FRONTEND_URL",
        "BENCHMARK_CONTEXT_DIR",
    )
    previous = {key: os.environ.get(key) for key in keys}
    with tempfile.TemporaryDirectory() as tmp:
        Path(tmp, "services.json").write_text('{"urls":{"public":"https://isolated-phone.ngrok.app"}}\n')
        os.environ.pop("BENCHMARK_PHONE_TOOL_BASE_URL", None)
        os.environ.pop("PUBLIC_BASE_URL", None)
        os.environ["BENCHMARK_FRONTEND_URL"] = "http://localhost:8805"
        os.environ["BENCHMARK_CONTEXT_DIR"] = tmp
        try:
            assert benchmark_public_base_url() == "https://isolated-phone.ngrok.app"
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


def test_phone_auto_approval_requires_active_callee_number():
    """Phone tasks auto-approve only approval requests for the controlled callee number."""
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _phone_approval_matches_callee

    task = get_task_by_name("phone-call-client-intake")
    task._callee_phone_number = "+14155550123"

    assert _phone_approval_matches_callee(task, {"question": "Make a phone call to +1 (415) 555-0123?"})
    assert not _phone_approval_matches_callee(task, {"question": "Make a phone call to +1 (650) 555-0123?"})


def test_root_exact_tool_count_fails_fast_after_duplicate_call():
    """An irreversible exact-count violation must fail before the task timeout."""
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _root_exact_tool_count_exceeded

    task = get_task_by_name("message-person-agent-sms")
    messages = [
        {
            "metadata": {
                "toolName": "message_person",
                "toolCallId": "send-1",
                "toolStatus": "IN_PROGRESS",
            }
        },
        {
            "metadata": {
                "toolName": "message_person",
                "toolCallId": "send-1",
                "toolStatus": "ERROR",
            }
        },
        {
            "metadata": {
                "toolName": "message_person",
                "toolCallId": "send-2",
                "toolStatus": "IN_PROGRESS",
            }
        },
    ]

    error = _root_exact_tool_count_exceeded(task, messages)
    assert error is not None
    assert "expected 1, got 2" in error
    assert _root_exact_tool_count_exceeded(task, messages[:2]) is None


def test_message_side_effect_benchmarks_force_fast_cache_off():
    """Cached agent decisions cannot prove a live external side effect."""
    import os

    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _resolved_fast_mode_cache

    previous = os.environ.get("BENCHMARK_FAST_MODE_CACHE")
    os.environ["BENCHMARK_FAST_MODE_CACHE"] = "true"
    try:
        for name in ("message-person", "message-person-agent-sms"):
            task = get_task_by_name(name)
            assert task.fast_cache == "off"
            assert _resolved_fast_mode_cache(task) is False
    finally:
        if previous is None:
            os.environ.pop("BENCHMARK_FAST_MODE_CACHE", None)
        else:
            os.environ["BENCHMARK_FAST_MODE_CACHE"] = previous


def test_unified_catalog_validates_and_covers_benchmark_tasks():
    """tasks.json is the benchmark catalog: valid contract, ready entries, holding set split."""
    from benchmarks.long_horizon import EVALUATION_METHODS, validate_catalog

    tasks = validate_catalog()

    assert len(tasks) >= 36
    statuses = {(t.get("runner", "agent"), t.get("status", "ready")) for t in tasks}
    assert ("agent", "ready") in statuses
    assert ("agent", "incomplete") in statuses
    assert {runner for runner, _ in statuses} == {"agent"}
    methods = {e["method"] for t in tasks for e in t.get("evaluators", [])}
    assert methods == EVALUATION_METHODS
    # Enriched long-horizon migrations carry the full environment contract
    with_env = [t for t in tasks if t.get("environment")]
    assert len(with_env) >= 5
    for t in with_env:
        assert t["environment"]["mode"] in {"synthetic", "live", "hybrid"}
        assert "db_fixtures" in t["environment"]
        assert "base_images" in t["environment"]


def test_unified_catalog_delineates_bench_axes():
    """Every task declares its bench: pipeline-e2e (plumbing) vs rose-bench (capability).

    Rose Bench entries are harness-INDEPENDENT: fixture + prompt + evaluators
    must be portable to any harness (e.g. swap in Claude Code and measure).
    """
    from benchmarks.long_horizon import TASK_BENCHES, validate_catalog

    tasks = validate_catalog()
    by_name = {t["name"]: t for t in tasks}

    assert all(t.get("bench") in TASK_BENCHES for t in tasks)
    rose = {t["name"] for t in tasks if t["bench"] == "rose-bench"}
    # Founder-labeled anchors of each axis (2026-07-02)
    assert {"test-mass-agent-run-0", "browser-agent", "job-applications"} <= rose
    for name in ("chat-mode", "browser-smoke", "spawn-sub-agents", "single-creator-arm", "cache-coverage"):
        assert by_name[name]["bench"] == "pipeline-e2e"
    # Live capability eval keeps its live environment contract
    live = by_name["browser-agent"]
    assert live["environment"]["mode"] == "live"
    assert live["environment"]["db_fixtures"] == []
    assert live["environment"]["live_targets"] == ["https://www.amazon.com"]


def test_daily_ecommerce_v1_catalog_has_eleven_distinct_transaction_flows():
    """The daily ecommerce slice stays focused, complete, and stable."""
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.fixtures import DEFAULT_BASE_IMAGE
    from benchmarks.long_horizon import validate_catalog

    expected_names = {
        "browser-opentable-reservation",
        "browser-toast-nopa-write-lock",
        "browser-instacart-grocery-order",
        "browser-doordash-usb-c-cable",
        "minted-agent-accounts-uber",
        "browser-agent-amazon-cookie-payment",
        "browser-alchemy-springs-sauna",
        "browser-hotel-booking",
        "browser-event-ticket",
        "browser-imax-group-tickets",
        "browser-amazon-return",
    }
    tasks = validate_catalog()
    ecommerce = [task for task in tasks if "ecommerce" in task.get("tags", [])]

    assert {task["name"] for task in ecommerce} == expected_names
    assert len(ecommerce) == 11
    assert all(task.get("group", "").lower() == "daily" for task in ecommerce)
    assert all(task.get("status", "ready") == "ready" for task in ecommerce)
    assert all(task.get("enforce_declared_evaluators") is True for task in ecommerce)
    assert len({task["prompt"] for task in ecommerce}) == len(ecommerce)
    assert "browser-uber-ride" not in {task["name"] for task in tasks}
    for name in expected_names:
        loaded = get_task_by_name(name)
        assert DEFAULT_BASE_IMAGE in loaded.environment["base_images"]
        assert loaded.environment["live_fixtures"] == ["live"]


def test_browser_search_single_result_tasks_use_browser_only():
    """Google/Bing search benchmarks exercise browser search, not web_search."""
    from benchmarks.benchmark_tasks import get_task_by_name

    cases = [
        ("browser-google-search-single-result", "Google", "google.com"),
        ("browser-bing-search-single-result", "Bing", "bing.com"),
    ]
    for task_name, provider, domain in cases:
        task = get_task_by_name(task_name)
        assert task.title == f"Browser {provider} Search Single Result"
        assert task.start_phase == "execute"
        assert task.expected_tools == ["spawn_agent"]
        assert task.requires_browser_agent is True
        assert task.requires_claude_code is False
        assert "antibot" in task.tags
        assert task.world_model_mode == "real"
        assert task.forbidden_tools == ["web_search", "web_fetch", "spawn_claude_code_agent"]
        assert "Use a browser agent" in task.prompt
        assert "Return exactly one non-ad search result" in task.prompt
        assert task.environment["mode"] == "live"
        assert task.environment["services"] == [domain]
        assert domain in task.environment["live_targets"][0]
        assert task.evaluators[0]["method"] == "single_turn_llm_judge"
        assert f"exactly one {provider} search result" in task.evaluators[0]["criteria"][1]


def test_indeed_account_creation_benchmark_contract():
    """Indeed account creation is a live browser/auth/anti-bot capability eval."""
    from benchmarks.benchmark_tasks import get_task_by_name

    task = get_task_by_name("browser-indeed-account-create")
    assert task.title == "Browser Indeed Account Creation"
    assert task.bench == "rose-bench"
    assert task.start_phase == "execute"
    assert task.expected_tools == ["spawn_agent"]
    assert task.requires_browser_agent is True
    assert task.requires_claude_code is False
    assert {"browser", "auth", "antibot"} <= set(task.tags)
    assert task.forbidden_tools == ["web_search", "web_fetch", "spawn_claude_code_agent"]
    assert "create a new Indeed job-seeker account" in task.prompt
    assert "Do not apply for jobs" in task.prompt
    assert task.environment["mode"] == "live"
    assert task.environment["services"] == ["indeed.com", "email_verification", "antibot"]
    assert task.environment["live_targets"] == ["https://www.indeed.com/"]
    assert task.evaluators[0]["method"] == "agentic_llm_judge"
    assert "signed-in/account-created evidence" in task.evaluators[0]["criteria"][2]


def test_unified_catalog_supports_multiple_evaluators_per_eval():
    """The contract allows combining deterministic checks with an agentic judge."""
    from benchmarks.long_horizon import validate_task_contract

    validate_task_contract(
        {
            "name": "contract-fixture",
            "bench": "rose-bench",
            "environment": {
                "mode": "synthetic",
                "db_fixtures": ["digital_twin_store_v1"],
                "base_images": [],
                "services": ["synthetic_store"],
                "secrets": [],
                "live_targets": [],
                "context_notes": "contract fixture",
            },
            "evaluators": [
                {
                    "id": "db",
                    "method": "static_check",
                    "criteria": ["one confirmed order"],
                    "checks": [{"type": "db_row_count", "table": "orders", "expected": 1}],
                },
                {
                    "id": "judge",
                    "method": "agentic_llm_judge",
                    "criteria": ["qualifying purchase completed"],
                    "judge_prompt": "Inspect the transcript and order DB.",
                },
            ],
        }
    )


def test_agent_class_min_steps_contract_is_validated_and_defaulted():
    """Browser benchmarks default to five steps while explicit task contracts remain authoritative."""
    from benchmarks.benchmark_tasks import all_tasks, get_task_by_name
    from benchmarks.long_horizon import validate_task_contract

    browser_tasks = [task for task in all_tasks() if task.requires_browser_agent]
    assert browser_tasks
    assert all(task.min_steps.get("browser", 0) >= 1 for task in browser_tasks)
    assert get_task_by_name("browser-agent-amazon-cookie-payment").min_steps == {"browser": 5}
    assert get_task_by_name("browser-smoke").min_steps == {"browser": 1}
    assert get_task_by_name("chat-mode").min_steps == {}

    base = {"name": "min-steps-contract", "bench": "rose-bench"}
    validate_task_contract({**base, "min_steps": {"browser": 5, "explore": 3}})
    for invalid in ({}, {"browser": 0}, {"browser": True}, {"": 5}):
        try:
            validate_task_contract({**base, "min_steps": invalid})
        except ValueError:
            pass
        else:
            raise AssertionError(f"invalid min_steps contract was accepted: {invalid}")
    validate_task_contract({**base, "requires_browser_agent": True, "min_steps": {"browser": 1}})


def test_browser_smoke_accepts_captured_single_step_trajectory():
    """The page-read smoke's declared one-step contract accepts its captured runtime shape."""
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import (
        _agent_class_step_counts,
        _validate_agent_class_min_steps,
    )

    task = get_task_by_name("browser-smoke")
    messages = [
        {
            "role": "ASSISTANT",
            "metadata": {
                "tool_calls": [
                    {
                        "tool": "spawn_agent",
                        "type": "browser",
                        "tool_call_id": "browser-root",
                    }
                ]
            },
        },
        {
            "role": "TOOL",
            "metadata": {
                "toolName": "spawn_browser_agent",
                "toolCallId": "browser-root",
                "task_id": "browser-task",
                "subAgentId": "browser-task",
                "action_type": "goto",
                "steps_taken": 0,
                "toolStatus": "FINISHED",
            },
        },
        {
            "role": "TOOL",
            "metadata": {
                "toolName": "spawn_browser_agent",
                "toolCallId": "browser-root",
                "task_id": "browser-task",
                "toolStatus": "FINISHED",
                "structured_response": {"main_heading_text": "Example Domain"},
            },
        },
    ]

    counts = _agent_class_step_counts({"messages": messages})
    assert counts == {"browser": {"browser-task": 1}}
    assert task.min_steps == {"browser": 1}
    assert _validate_agent_class_min_steps(task.min_steps, counts) is None


def test_payment_abandonment_accepts_captured_two_step_trajectory():
    """The checkout-ready card-mint-and-abandon flow ends after its second browser action."""
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import (
        _agent_class_step_counts,
        _validate_agent_class_min_steps,
    )

    task = get_task_by_name("agent-payment-abandonment")
    root_call_id = "call_SV1B22HCOvtaIBDUgTfC8C1H"
    browser_task_id = "eb49400c-eaa0-40b2-ab7e-c25eaab9e5cc"
    messages = [
        {
            "role": "ASSISTANT",
            "metadata": {
                "tool_calls": [
                    {
                        "tool": "spawn_agent",
                        "type": "browser",
                        "tool_call_id": root_call_id,
                    }
                ]
            },
        },
        {
            "role": "TOOL",
            "metadata": {
                "toolName": "spawn_browser_agent",
                "toolCallId": root_call_id,
                "task_id": browser_task_id,
                "toolStatus": "IN_PROGRESS",
            },
        },
    ]
    captured_actions = (
        (0, "goto", "call_SV1B22HCOvtaIBDUgTfC8C1H"),
        (1, "request_payment_card", "call_504TlJ4rwJ8nmWMct75JUYJg"),
    )
    for step_number, action_type, action_call_id in captured_actions:
        messages.append(
            {
                "role": "TOOL",
                "metadata": {
                    "toolName": "spawn_browser_agent",
                    "toolCallId": action_call_id,
                    "task_id": browser_task_id,
                    "subAgentId": browser_task_id,
                    "action_type": action_type,
                    "steps_taken": step_number,
                    "toolStatus": "FINISHED",
                },
            }
        )

    counts = _agent_class_step_counts({"messages": messages})
    assert counts == {"browser": {browser_task_id: 2}}
    assert task.min_steps == {"browser": 2}
    assert _validate_agent_class_min_steps(task.min_steps, counts) is None


def test_production_payment_abandonment_accepts_checkout_ready_two_step_trajectory():
    """The preselected production fixture only requires navigation and card minting."""
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import (
        _agent_class_step_counts,
        _validate_agent_class_min_steps,
    )

    task = get_task_by_name("agent-payment-production-abandonment")
    root_call_id = "production-browser-root"
    browser_task_id = "production-browser-task"
    messages = [
        {
            "role": "ASSISTANT",
            "metadata": {
                "tool_calls": [
                    {
                        "tool": "spawn_agent",
                        "type": "browser",
                        "tool_call_id": root_call_id,
                    }
                ]
            },
        },
        {
            "role": "TOOL",
            "metadata": {
                "toolName": "spawn_browser_agent",
                "toolCallId": root_call_id,
                "task_id": browser_task_id,
                "toolStatus": "IN_PROGRESS",
            },
        },
    ]
    for step_number, action_type in enumerate(("goto", "request_payment_card")):
        messages.append(
            {
                "role": "TOOL",
                "metadata": {
                    "toolName": "spawn_browser_agent",
                    "toolCallId": f"production-action-{step_number}",
                    "task_id": browser_task_id,
                    "subAgentId": browser_task_id,
                    "action_type": action_type,
                    "steps_taken": step_number,
                    "toolStatus": "FINISHED",
                },
            }
        )

    counts = _agent_class_step_counts({"messages": messages})
    assert counts == {"browser": {browser_task_id: 2}}
    assert task.min_steps == {"browser": 2}
    assert _validate_agent_class_min_steps(task.min_steps, counts) is None


def test_browser_min_steps_rejects_terminal_claim_without_trajectory():
    """A synthetic terminal response and lifecycle messages prove zero browser work."""
    from benchmarks.run_benchmark import (
        _agent_class_step_counts,
        _validate_agent_class_min_steps,
    )

    messages = [
        {
            "role": "ASSISTANT",
            "metadata": {
                "tool_calls": [
                    {
                        "tool": "spawn_agent",
                        "type": "browser",
                        "tool_call_id": "browser-root",
                    }
                ]
            },
        },
        {
            "role": "TOOL",
            "message": "",
            "metadata": {
                "toolName": "spawn_browser_agent",
                "toolCallId": "browser-root",
                "toolStatus": "IN_PROGRESS",
                "title": "Starting up a browser",
            },
        },
        {
            "role": "TOOL",
            "message": '{"status":"completed","purchase_completed":true}',
            "metadata": {
                "toolName": "spawn_browser_agent",
                "toolCallId": "browser-root",
                "toolStatus": "FINISHED",
                "structured_response": {"purchase_completed": True},
            },
        },
    ]

    counts = _agent_class_step_counts({"messages": messages})
    assert counts == {"browser": {"browser-root": 0}}
    reason = _validate_agent_class_min_steps({"browser": 5}, counts)
    assert reason is not None
    assert "recorded 0 trajectory step(s)" in reason


def test_browser_min_steps_is_per_instance_not_aggregate():
    """Five steps on one browser cannot cover a second under-worked browser."""
    from benchmarks.run_benchmark import (
        _agent_class_step_counts,
        _validate_agent_class_min_steps,
    )

    messages = []
    for instance_number, step_count in ((1, 5), (2, 4)):
        root_id = f"browser-root-{instance_number}"
        task_id = f"browser-task-{instance_number}"
        messages.extend(
            [
                {
                    "role": "ASSISTANT",
                    "metadata": {
                        "tool_calls": [
                            {
                                "tool": "spawn_agent",
                                "type": "browser",
                                "tool_call_id": root_id,
                            }
                        ]
                    },
                },
                {
                    "role": "TOOL",
                    "metadata": {
                        "toolName": "spawn_browser_agent",
                        "toolCallId": root_id,
                        "task_id": task_id,
                        "action_type": "browser",
                    },
                },
            ]
        )
        for step in range(step_count):
            messages.append(
                {
                    "role": "TOOL",
                    "metadata": {
                        "toolName": "spawn_browser_agent",
                        "toolCallId": f"action-{instance_number}-{step}",
                        "task_id": task_id,
                        "subAgentId": task_id,
                        "action_type": "click",
                        "steps_taken": step,
                    },
                }
            )

    counts = _agent_class_step_counts({"messages": messages})
    assert counts == {
        "browser": {
            "browser-task-1": 5,
            "browser-task-2": 4,
        }
    }
    reason = _validate_agent_class_min_steps({"browser": 5}, counts)
    assert reason is not None
    assert "browser-task-2 recorded 4" in reason


def test_min_steps_supports_non_browser_agent_classes():
    """The same contract counts distinct leaf tool steps for explore agents."""
    from benchmarks.run_benchmark import (
        _agent_class_step_counts,
        _validate_agent_class_min_steps,
    )

    messages = [
        {
            "role": "ASSISTANT",
            "metadata": {
                "tool_calls": [
                    {
                        "tool": "spawn_agent",
                        "type": "explore",
                        "tool_call_id": "explore-root",
                    }
                ]
            },
        },
        {
            "role": "TOOL",
            "metadata": {
                "toolName": "spawn_agent",
                "toolCallId": "explore-root",
                "taskId": "explore-task",
                "agentType": "explore",
            },
        },
    ]
    for step in range(5):
        messages.append(
            {
                "role": "TOOL",
                "metadata": {
                    "toolName": "web_search",
                    "toolCallId": f"search-{step}",
                    "taskId": "explore-task",
                    "subAgentId": "explore-task",
                    "agentType": "explore",
                    "toolStatus": "FINISHED",
                },
            }
        )

    counts = _agent_class_step_counts({"messages": messages})
    assert counts == {"explore": {"explore-task": 5}}
    assert _validate_agent_class_min_steps({"explore": 5}, counts) is None


def test_suite_selection_excludes_incomplete_entries():
    """Suite runs execute only ready benchmark evals; incomplete entries are catalogued but skipped."""
    from benchmarks.benchmark_tasks import all_tasks, suite_tasks

    suite_names = {t.name for t in suite_tasks()}
    all_names = {t.name for t in all_tasks()}

    assert "wait-for-trigger" in suite_names
    assert "raise-my-round" not in all_names
    assert "smoke-backend-claude-code" not in all_names
    # Representative ready agent benchmarks stay in suite selection.
    assert "test-mass-agent-run-0" in suite_names
    assert "browser-agent" in suite_names
    assert {
        "user-data-prod-grep",
        "plaid-transactions-monthly-spend",
        "plaid-transactions-doordash-count",
        "plaid-transactions-dead-subscriptions",
        "browser-google-search-single-result",
        "browser-bing-search-single-result",
        "browser-indeed-account-create",
        "phone-call-client-intake",
        "phone-call-payment",
        "response-schema-non-goal-feedback",
    } <= suite_names
    # This branch added four ready gate benchmarks (subscription free-credit,
    # subscription card-mint, kyc card-mint, source-connect gmail).
    assert {
        "gate-subscription-free-credit",
        "gate-subscription-card-mint",
        "gate-kyc-card-mint",
        "gate-source-connect-gmail",
    } <= suite_names
    assert len(suite_names) == len([t for t in all_tasks() if t.status == "ready" and not t.production_only])


def test_dead_subscription_catalog_has_explicit_refund_candidate_contract():
    """Dead-subscription candidates must not be schema-inferred as exclusions."""
    from benchmarks.benchmark_tasks import get_task_by_name

    task = get_task_by_name("plaid-transactions-dead-subscriptions")
    fields = {field.get("name"): field for field in (task.response_schema or {}).get("fields", [])}

    assert "Stopped billing / dead candidates belong in refund_prep_candidates" in task.prompt
    assert "do not move them to excluded_subscription_candidates" in task.prompt
    assert fields["refund_prep_candidates"]["type"] == "list[str]"
    assert fields["refund_prep_candidates"]["required"] is True
    assert "stopped billing / dead candidates" in fields["refund_prep_candidates"]["description"]
    assert fields["refund_prep_evidence"]["type"] == "str"
    assert fields["excluded_subscription_candidates"]["type"] == "list[str]"
    assert "active/recent" in fields["excluded_subscription_candidates"]["description"]


def test_people_search_catalog_prompts_route_to_people_search_tool():
    """People-search benchmarks must name the tool required by their ratchet."""
    from benchmarks.benchmark_tasks import get_task_by_name

    expectations = {
        "people-search-criteria": 'mode="discover"',
        "people-search-targeted": 'mode="enrich"',
    }
    for task_name, expected_mode in expectations.items():
        task = get_task_by_name(task_name)
        assert (task.min_tool_counts or {}).get("people_search", 0) >= 1
        assert "dedicated people_search tool" in task.prompt
        assert expected_mode in task.prompt
        assert "do not satisfy this with plain web_search" in task.prompt


def test_people_search_targeted_finishes_after_people_search_enrichment():
    """Targeted people lookup should not drift into extra web research after enrichment."""
    from benchmarks.benchmark_tasks import get_task_by_name

    task = get_task_by_name("people-search-targeted")
    fields = {field.get("name"): field for field in (task.response_schema or {}).get("fields", [])}

    assert "After a successful people_search result, finish immediately" in task.prompt
    assert "do not run supplemental web_search or web_fetch" in task.prompt
    assert fields["current_title"]["type"] == "str"
    assert fields["current_company"]["type"] == "str"
    assert fields["location"]["type"] == "str"
    assert fields["linkedin_profile_url"]["type"] == "str"
    assert fields["source_url"]["type"] == "str"


def test_kyc_gate_benchmark_uses_canonical_detection_contract():
    """The KYC benchmark must assert the same durable contract the gate builder emits."""
    from benchmarks.benchmark_tasks import get_task_by_name
    from domains.gate.service import build_kyc_gate

    task = get_task_by_name("gate-kyc-card-mint")
    expected_gate = task.expected_gate or {}
    builder_gate = build_kyc_gate()

    assert expected_gate["type"] == "kyc"
    assert expected_gate["gateKey"] == "kyc"
    assert expected_gate["detection"] == {
        "method": "kyc_webhook",
        "probeKey": "customers_needed_kyc",
    }
    assert expected_gate["detection"] == builder_gate["detection"]


def test_every_task_has_base_image_fixture_by_default():
    """Every eval runs on a reproducible base image; undeclared environments inherit the default."""
    from benchmarks.benchmark_tasks import all_tasks
    from benchmarks.fixtures import BASE_IMAGES, DEFAULT_BASE_IMAGE

    assert DEFAULT_BASE_IMAGE in BASE_IMAGES
    for t in all_tasks():
        assert t.environment is not None, f"{t.name}: no effective environment"
        assert t.environment.get("base_images"), f"{t.name}: no base image fixture"
    # Tasks that don't declare an environment inherit the default base image verbatim
    by_name = {t.name: t for t in all_tasks()}
    assert by_name["chat-mode"].environment["base_images"] == [DEFAULT_BASE_IMAGE]
    # Declared environments with empty base_images also inherit it
    assert by_name["user-data-prod-grep"].environment["base_images"] == [DEFAULT_BASE_IMAGE]


def test_live_fixture_registry_appliers_stay_in_sync():
    """Every declared live fixture must have a runtime applier, and vice-versa.

    The metadata registry (live_fixtures.py) and the runtime dispatch table
    (run_benchmark.py) are asserted equal at import; this pins that contract so a
    fixture can never be declared without a way to apply it.
    """
    from benchmarks.live_fixtures import LIVE_FIXTURE_NAMES
    from benchmarks.run_benchmark import LIVE_FIXTURE_APPLIERS

    assert set(LIVE_FIXTURE_APPLIERS) == set(LIVE_FIXTURE_NAMES)
    assert LIVE_FIXTURE_NAMES == {"live"}


def test_amazon_passkey_scenario_is_exclusive_and_restorable():
    """Passkey-only state cannot race siblings and its shared mutations are undone."""
    import benchmarks.run_benchmark as bench

    assert bench.AMAZON_PASSKEY_TASK_NAME in bench.EXCLUSIVE_SHARED_DB_TASK_NAMES

    sql_calls = []
    deleted_profiles = []
    original_sync = bench._sync_browser_credentials
    original_sql = bench._run_local_victoria_sql
    original_delete_profile = bench._delete_kernel_profile
    try:
        bench._sync_browser_credentials = lambda: True
        sql_results = iter(['["run-created-profile"]', ""])
        bench._run_local_victoria_sql = lambda sql: sql_calls.append(sql) or next(sql_results)
        bench._delete_kernel_profile = lambda profile_id: deleted_profiles.append(profile_id)
        bench._restore_amazon_passkey_scenario(
            {
                "scenario": "amazon_passkey",
                "user_id": "user-1",
                "auth_realm": "amazon.com",
                "restore_snapshot": {
                    "steel_ids": ["steel-1"],
                    "bundle_ids": ["bundle-1"],
                    "password_ids": ["password-1"],
                    "profiles": [
                        {
                            "id": "profile-1",
                            "contextId": "context-1",
                            "provider": "kernel",
                            "profileId": "remote-profile-1",
                            "createdAt": "2026-07-13T00:00:00Z",
                            "updatedAt": "2026-07-13T00:00:00Z",
                        }
                    ],
                },
            }
        )
    finally:
        bench._sync_browser_credentials = original_sync
        bench._run_local_victoria_sql = original_sql
        bench._delete_kernel_profile = original_delete_profile

    assert deleted_profiles == ["run-created-profile"]
    assert len(sql_calls) == 2
    assert 'SELECT COALESCE(json_agg(profile."profileId")' in sql_calls[0]
    restore_sql = sql_calls[1]
    assert 'UPDATE "SteelSessionAuth"' in restore_sql and "'steel-1'" in restore_sql
    assert 'UPDATE "CookieBundle"' in restore_sql and "'bundle-1'" in restore_sql
    assert 'UPDATE "BrowserPassword"' in restore_sql and "'password-1'" in restore_sql
    assert 'DELETE FROM "BrowserProviderProfile"' in restore_sql
    assert 'INSERT INTO "BrowserProviderProfile"' in restore_sql


def test_live_fixture_is_single_and_explicit():
    """Only credential-dependent tasks opt into the single live overlay."""
    from benchmarks.benchmark_tasks import all_tasks
    from benchmarks.live_fixtures import resolve_live_fixtures

    # Pure resolver contract
    assert resolve_live_fixtures(None) == []
    assert resolve_live_fixtures({"mode": "live"}) == []
    assert resolve_live_fixtures({"mode": "hybrid"}) == []
    assert resolve_live_fixtures({"mode": "synthetic"}) == []
    assert resolve_live_fixtures({"mode": "live", "live_fixtures": []}) == []  # explicit wins
    assert resolve_live_fixtures({"mode": "live", "live_fixtures": ["live"]}) == ["live"]

    # Loaded catalog: every task has effective live_fixtures matching its mode
    for t in all_tasks():
        env = t.environment
        assert env is not None and "live_fixtures" in env, f"{t.name}: no effective live_fixtures"
        assert set(env["live_fixtures"]) <= {"live"}, f"{t.name}: noncanonical live fixture"
        if env.get("mode") == "synthetic":
            assert env["live_fixtures"] == [], f"{t.name}: synthetic must not carry live fixtures"

    by_name = {t.name: t for t in all_tasks()}
    assert by_name["browser-agent"].environment["live_fixtures"] == ["live"]
    assert by_name["browser-agent-amazon-cookie-payment"].environment["live_fixtures"] == ["live"]
    assert by_name["browser-agent-amazon-passkey"].environment["live_fixtures"] == ["live"]
    assert by_name["browser-agent-amazon-passkey"].expected_credential_ref_kind == "passkey"
    assert by_name["browser-agent-amazon-passkey"].forbidden_credential_ref_kinds == [
        "password",
        "email_otp",
        "sms_otp",
    ]
    # An undeclared-environment task does not import expiring credentials.
    assert by_name["chat-mode"].environment["live_fixtures"] == []


def test_live_fixture_validation_rejects_unknown_and_synthetic_declarations():
    """Catalog validation refuses live fixtures the harness can't satisfy."""
    from benchmarks.long_horizon import _validate_environment

    base_env = {
        "mode": "live",
        "db_fixtures": [],
        "base_images": [],
        "services": [],
        "secrets": [],
        "live_targets": [],
        "context_notes": "x",
    }

    # Unknown fixture name fails
    bad = {**base_env, "live_fixtures": ["does_not_exist"]}
    raised = False
    try:
        _validate_environment(bad, "t-unknown")
    except ValueError as e:
        raised = "unknown live_fixtures" in str(e)
    assert raised, "unknown live_fixture must fail validation"

    # Synthetic task declaring live fixtures fails
    syn = {**base_env, "mode": "synthetic", "live_fixtures": ["live"]}
    raised = False
    try:
        _validate_environment(syn, "t-synthetic")
    except ValueError as e:
        raised = "synthetic evals must not declare live_fixtures" in str(e)
    assert raised, "synthetic + live_fixtures must fail validation"

    # A valid declaration passes
    ok = {**base_env, "live_fixtures": ["live"]}
    assert _validate_environment(ok, "t-ok")["live_fixtures"] == ["live"]


def test_tag_slices_still_resolve():
    """Semantic tag slices (e.g. browser auth suite) survive catalog changes."""
    from benchmarks.benchmark_tasks import get_tasks_by_tag

    for tag, minimum in {
        "browser": 8,
        "auth": 5,
        "antibot": 1,
        "smoke": 5,
        "outreach": 3,
        "attachments": 5,
        "sub-agent-fan-out": 4,
        "code-agent": 3,
        "payment": 1,
        "load-test": 2,
        "grep": 3,
        "plaid": 2,
    }.items():
        assert len(get_tasks_by_tag(tag)) >= minimum, f"tag slice '{tag}' collapsed"


def test_antibot_slice_includes_daily_toast_and_amazon_commerce():
    """The curated anti-bot slice uses one canonical tag spelling."""
    from benchmarks.benchmark_tasks import all_tasks, get_tasks_by_tag

    tasks = get_tasks_by_tag("antibot")
    by_name = {task.name: task for task in tasks}
    assert set(by_name) == {
        "browser-indeed-account-create",
        "browser-google-search-single-result",
        "browser-bing-search-single-result",
        "browser-biometrics-webdecoy",
        "browser-toast-nopa-write-lock",
        "browser-agent-amazon-cookie-payment",
        "browser-blue-bottle-challenge-recovery",
    }
    assert "ecommerce" in by_name["browser-agent-amazon-cookie-payment"].tags
    assert all(task.tags.count("antibot") == 1 for task in tasks)
    all_tags = {tag for task in all_tasks() for tag in task.tags}
    assert not ({"anti-bot", "anti_bot", "bot-challenge"} & all_tags)


def test_history_ledger_task_names_still_exist_in_catalog():
    """History-orphan guard: renaming a catalog task orphans its pass ledger + p99 baselines.

    Every task name ever recorded in the success ledger must still exist in
    tasks.json. If this fails, a task was renamed or deleted — restore the name
    (CLAUDE.md "Eval Suite": task name is the cross-store primary key).
    """
    import json as _json
    from pathlib import Path

    from benchmarks.benchmark_tasks import all_tasks

    ledger = Path(__file__).resolve().parents[2] / "benchmarks" / "history" / "task_durations.jsonl"
    if not ledger.exists() or ledger.stat().st_size == 0:
        return  # fresh checkout — nothing recorded yet
    recorded = set()
    with ledger.open() as f:
        for line in f:
            line = line.strip()
            if line:
                recorded.add(_json.loads(line)["task"])
    catalog_names = {t.name for t in all_tasks()}
    orphaned = sorted(recorded - catalog_names)
    assert not orphaned, f"History-orphaning rename/delete detected for: {orphaned}"


def test_retired_tasks_hidden_from_suite_and_listing():
    """'retired' keeps a task name alive for ledger integrity but dead everywhere.

    load-test-sias is the canonical retiree: it must stay in tasks.json (the
    history-orphan guard depends on the name existing) yet never run in the
    eval suite and never appear in the suite listing.
    """
    import io
    from contextlib import redirect_stdout

    from benchmarks.benchmark_tasks import all_tasks
    from benchmarks.run_eval_suite import _print_holding_set

    tasks = all_tasks()
    sias = next((t for t in tasks if t.name == "load-test-sias"), None)
    assert sias is not None, "load-test-sias must remain in the catalog (history integrity)"
    assert sias.status == "retired"

    # never selected for a run (suite runs only status == "ready")
    ready_names = {t.name for t in tasks if t.status == "ready"}
    assert "load-test-sias" not in ready_names

    # never shown in the holding-set listing
    buf = io.StringIO()
    with redirect_stdout(buf):
        _print_holding_set(tasks)
    assert "load-test-sias" not in buf.getvalue(), "retired task leaked into --list output"


def test_agent_latency_reads_isolated_benchmark_stack_logs():
    """agent_latency.py must see isolated-stack logs, not just the shared ones.

    Every /deploy smoke failure runs on an isolated stack, which writes to
    .context/benchmarks/<run-id>/logs/{worker.N,backend}.log instead of
    agents/navi-worker-log.txt. Reading only the shared paths made the primary
    latency tool print "No log lines found" for exactly the failures it exists
    to explain, so all three 2026-07-28 smoke failures had to be diagnosed by
    hand.
    """
    import importlib
    import tempfile

    latency = importlib.import_module("benchmarks.agent_latency")

    with tempfile.TemporaryDirectory() as tmp:
        log_dir = os.path.join(tmp, "1785261402-99080-80974", "logs")
        os.makedirs(log_dir)
        # An isolated stack runs many worker processes, one file each.
        with open(os.path.join(log_dir, "worker.4.log"), "w") as handle:
            handle.write(
                json.dumps(
                    {
                        "timestamp": "2026-07-28T17:58:34.644000Z",
                        "event": "span.end",
                        "agent_id": "053a9066-28d1-4f34-a558-cc7cd402520d",
                        "span_name": "llm.attempt",
                    }
                )
                + "\n"
            )
        with open(os.path.join(log_dir, "backend.log"), "w") as handle:
            handle.write("[2026-07-28T17:58:34.647Z] WARN [ComputeCredentials] backed off reason=x\n")

        original_root = latency.ISOLATED_STACK_ROOT
        original_worker = latency.WORKER_LOG
        original_backend = latency.BACKEND_LOG
        try:
            latency.ISOLATED_STACK_ROOT = tmp
            # Point the shared paths at nonexistent files so the ONLY way these
            # events can be found is via isolated-stack discovery.
            latency.WORKER_LOG = os.path.join(tmp, "absent-worker.txt")
            latency.BACKEND_LOG = os.path.join(tmp, "absent-backend.log")

            assert latency.isolated_stack_log_dirs() == [log_dir]
            worker_events = latency._read_worker_raw()
            backend_events = latency._read_backend_raw()
        finally:
            latency.ISOLATED_STACK_ROOT = original_root
            latency.WORKER_LOG = original_worker
            latency.BACKEND_LOG = original_backend

    assert len(worker_events) == 1, "isolated-stack worker.N.log must be read"
    assert worker_events[0].data["agent_id"] == "053a9066-28d1-4f34-a558-cc7cd402520d"
    assert len(backend_events) == 1, "isolated-stack backend.log must be read"
    assert backend_events[0].source == "backend"


def test_long_horizon_idea_bank_preserves_seed_ideas_with_safety_notes():
    """Raw idea kernels have a home before they become runnable evals."""
    from benchmarks.long_horizon import load_idea_bank

    ideas = load_idea_bank()
    by_id = {idea.id: idea for idea in ideas}

    assert len(ideas) >= 25
    assert by_id["black-beanie"].status == "promoted"
    assert "Do not locate or deliver pirated" in by_id["lawful-book-access"].safety_notes
    assert "Do not collect private personal contact info" in by_id["world-power-ranking-public"].safety_notes
    assert "explicit approval" in by_id["create-100-person-event"].safety_notes


def test_local_benchmark_checkpoint_flags_parse_for_any_task():
    """Checkpointing is a benchmark-runner mode, not a Mass-Agent-only shell branch."""
    from benchmarks import local as local_bench

    args = local_bench.parse_args(
        [
            "chat-mode",
            "--checkpoint",
            "7",
            "--checkpoint-source-json",
            ".context/checkpoints/chat.json",
            "--checkpoint-no-start",
        ]
    )

    assert args.tasks == ["chat-mode"]
    assert args.checkpoint == 7
    assert args.checkpoint_source_json == ".context/checkpoints/chat.json"
    assert args.checkpoint_no_start is True
    assert args.checkpoint_boundary == "for-each-finished"
    assert local_bench.checkpoint_requested(args) is True


def test_local_benchmark_checkpoint_can_generate_source_from_task():
    """Default checkpoint mode runs the benchmark to a turn and exports source/tree JSON."""
    import tempfile
    from pathlib import Path

    from benchmarks import local as local_bench

    args = local_bench.parse_args(["chat-mode", "--checkpoint", "7"])
    with tempfile.TemporaryDirectory() as tmp:
        stack = local_bench.ServiceStack(
            run_id="checkpoint-test",
            context_dir=Path(tmp),
            manifest_path=Path(tmp) / "services.json",
            service_log=Path(tmp) / "services.log",
            isolated=True,
        )
        calls = []
        original = local_bench.run_streamed_command

        def fake_run_streamed_command(command, *, cwd, env=None, check=True):
            calls.append(command)
            source_out = Path(command[command.index("--checkpoint-source-out") + 1])
            source_out.parent.mkdir(parents=True, exist_ok=True)
            source_out.write_text("{}")
            tree_out = Path(command[command.index("--checkpoint-tree-out") + 1])
            tree_out.write_text("{}")
            return 0, ""

        try:
            local_bench.run_streamed_command = fake_run_streamed_command
            source_json, tree_json = local_bench.create_checkpoint_source_from_task(
                task_name="chat-mode",
                backend_port=55101,
                stack=stack,
                args=args,
            )
        finally:
            local_bench.run_streamed_command = original

    assert source_json.name == "chat-mode-source.json"
    assert tree_json is not None and tree_json.name == "chat-mode-tree.json"
    assert calls
    command = calls[0]
    assert "benchmarks/run_benchmark.py" in command
    assert command[command.index("--checkpoint-source-index") + 1] == "7"
    assert command[command.index("--checkpoint-source-boundary") + 1] == "for-each-finished"
    assert command[command.index("--checkpoint-source-price-limit-cents") + 1] == "5000"
    assert command[command.index("--timeout-seconds") + 1] == "900"
    assert "--checkpoint-source-out" in command


def test_local_benchmark_checkpoint_for_each_boundary_resolves_through_index():
    """A durable for_each boundary before a high requested index becomes the clone index."""
    import tempfile
    from pathlib import Path

    from benchmarks import local as local_bench

    args = local_bench.parse_args(["chat-mode", "--checkpoint", "500"])
    with tempfile.TemporaryDirectory() as tmp:
        source_json = Path(tmp) / "source.json"
        source_json.write_text(
            json.dumps(
                {
                    "messages": [
                        {"role": "TOOL", "metadata": {"toolName": "seed", "toolStatus": "FINISHED"}},
                        {
                            "role": "TOOL",
                            "metadata": {
                                "toolName": "spawn_general_purpose_agent_for_each",
                                "toolStatus": "FINISHED",
                            },
                        },
                        {"role": "TOOL", "metadata": {"toolName": "later", "toolStatus": "FINISHED"}},
                    ]
                }
            )
        )

        assert local_bench.checkpoint_through_index(source_json, args) == 1


def test_local_benchmark_checkpoint_message_index_can_bypass_for_each_boundary():
    """Raw index mode remains available for exact transcript cuts."""
    import tempfile
    from pathlib import Path

    from benchmarks import local as local_bench

    args = local_bench.parse_args(["chat-mode", "--checkpoint", "2", "--checkpoint-boundary", "message-index"])
    with tempfile.TemporaryDirectory() as tmp:
        source_json = Path(tmp) / "source.json"
        source_json.write_text(
            json.dumps(
                {
                    "messages": [
                        {
                            "role": "TOOL",
                            "metadata": {
                                "toolName": "spawn_general_purpose_agent_for_each",
                                "toolStatus": "FINISHED",
                            },
                        },
                        {"role": "TOOL", "metadata": {"toolName": "later", "toolStatus": "FINISHED"}},
                    ]
                }
            )
        )

        assert local_bench.checkpoint_through_index(source_json, args) == 2


def test_local_benchmark_checkpoint_accepts_legacy_aliases():
    """Old checkpoint aliases route to the same local runner fields."""
    from benchmarks import local as local_bench

    args = local_bench.parse_args(
        [
            "test-mass-agent-run-0",
            "--through-index",
            "42",
            "--source-json",
            ".context/source.json",
            "--tree-json",
            ".context/tree.json",
            "--no-start",
        ]
    )

    assert args.checkpoint == 42
    assert args.checkpoint_source_json == ".context/source.json"
    assert args.checkpoint_tree_json == ".context/tree.json"
    assert args.checkpoint_no_start is True


def test_local_benchmark_checkpoint_options_require_checkpoint_mode():
    """Source/tree checkpoint knobs cannot silently affect a normal benchmark run."""
    import contextlib
    import io
    import pytest
    from benchmarks import local as local_bench

    with pytest.raises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
        local_bench.parse_args(["chat-mode", "--checkpoint-source-json", ".context/source.json"])


def test_checkpoint_validation_generic_does_not_require_mass_agent_sequence():
    """Generic checkpoint resumes only enforce reasoning-row hygiene."""
    from benchmarks.run_checkpoint_agent import _validate_post_checkpoint

    data = {
        "messages": [
            {"role": "TOOL", "metadata": {"toolName": "seed", "toolStatus": "FINISHED"}},
            {
                "role": "ASSISTANT",
                "text": "A valid post-checkpoint thought",
                "metadata": {"plannedToolName": "reasoning"},
            },
        ]
    }

    clean, reason, visible = _validate_post_checkpoint(data, 1)

    assert clean is True
    assert reason is None
    assert visible == ["Thought"]


def test_checkpoint_validation_mass_agent_sequence_remains_strict():
    """Mass Agent 0 still guards the expected post-fanout card sequence."""
    from benchmarks.run_checkpoint_agent import EXPECTED_VISIBLE_SEQUENCE, _validate_post_checkpoint

    data = {
        "messages": [
            {"role": "TOOL", "metadata": {"toolName": "seed", "toolStatus": "FINISHED"}},
            {
                "role": "ASSISTANT",
                "text": "Only one thought",
                "metadata": {"plannedToolName": "reasoning"},
            },
        ]
    }

    clean, reason, visible = _validate_post_checkpoint(
        data,
        1,
        expected_visible_sequence=EXPECTED_VISIBLE_SEQUENCE,
    )

    assert clean is False
    assert "does not contain expected" in str(reason)
    assert visible == ["Thought"]


async def test_required_attachment_upload_failure_is_fatal():
    """Required benchmark attachments must fail fast instead of running agents without files."""
    from benchmarks import run_benchmark as bench

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            if length:
                self.rfile.read(length)
            payload = json.dumps({"error": "Node.js detected but native WebSocket not found"}).encode()
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    original_api_headers = bench._api_headers

    async def fake_api_headers():
        return {"Content-Type": "application/json"}

    try:
        bench._api_headers = fake_api_headers
        with tempfile.NamedTemporaryFile(suffix=".csv") as temp:
            temp.write(b"name\nAlpha\n")
            temp.flush()
            try:
                await bench.upload_attachment(
                    f"http://127.0.0.1:{server.server_address[1]}",
                    "agent-attachment-repro",
                    temp.name,
                )
                raise AssertionError("attachment upload failure was allowed to continue")
            except RuntimeError as exc:
                message = str(exc)
                assert "Attachment upload failed" in message
                assert "HTTP 500" in message
                assert "native WebSocket not found" in message
    finally:
        bench._api_headers = original_api_headers
        server.shutdown()
        server.server_close()


async def run_all_tests():
    print("benchmark blackbox tests:")
    r = BlackboxResult()
    r.record(
        "every_benchmark_run_registers_in_app_hub",
        test_every_benchmark_run_registers_in_app_hub_before_execution,
    )
    r.record(
        "cloudbench_rejects_stale_wrong_task",
        test_cloudbench_result_rejects_stale_passing_artifact_from_another_task,
    )
    r.record(
        "cloudbench_accepts_fresh_exact_pass",
        test_cloudbench_result_accepts_only_fresh_exact_passing_task_set,
    )
    r.record(
        "agent_payment_output_blob_is_key_agnostic",
        test_agent_payment_output_blob_is_key_agnostic,
    )
    r.record(
        "cloudbench_preserves_failure_without_passing",
        test_cloudbench_result_preserves_fresh_failure_but_never_counts_it_as_pass,
    )
    r.record(
        "cloudbench_shell_contract_requires_identity_and_exit",
        test_cloudbench_shell_controllers_require_fresh_identity_and_child_success,
    )
    await r.record_async(
        "required_attachment_upload_failure_is_fatal",
        test_required_attachment_upload_failure_is_fatal,
    )
    r.record(
        "cloud_fleet_controller_detaches_by_default",
        test_cloud_fleet_controller_detaches_by_default,
    )
    r.record(
        "cloudbench_prisma_freshness_permanent_gate",
        test_cloudbench_prisma_freshness_behavior_is_in_permanent_gate,
    )
    r.record(
        "cloudbench_dependency_rebuild_permanent_gate",
        test_cloudbench_dependency_rebuild_behavior_is_in_permanent_gate,
    )
    r.record(
        "cloudbench_patch_includes_untracked_files",
        test_cloudbench_worktree_patch_includes_tracked_and_untracked_files,
    )
    r.record(
        "run_context_absolute_path_single_rooted",
        test_run_context_normalization_keeps_absolute_workspace_path_single_rooted,
    )
    r.record("phone_call_tasks_two_sided_verification", test_phone_call_tasks_define_two_sided_verification)
    r.record("phone_callee_end_call_config", test_phone_callee_assistant_base_has_end_call_tool_and_duration_cap)
    r.record(
        "phone_callee_session_number_name_contract",
        test_phone_callee_session_number_names_follow_provider_contract,
    )
    await r.record_async(
        "phone_callee_number_activation_window",
        test_phone_callee_waits_for_new_number_activation,
    )
    await r.record_async(
        "phone_callee_activation_cancellation_cleanup",
        test_phone_callee_activation_cancellation_deletes_owned_number,
    )
    await r.record_async(
        "phone_callee_distributed_resource_isolation",
        test_phone_callee_sessions_isolate_distributed_phone_number_resources,
    )
    await r.record_async(
        "phone_callee_stale_resource_reclamation",
        test_phone_callee_reclaims_only_stale_session_owned_numbers,
    )
    await r.record_async(
        "phone_callee_owned_resource_cleanup",
        test_phone_callee_cleanup_deletes_only_explicitly_owned_number,
    )
    r.record("phone_findings_matcher_squashes_separators", test_missing_call_findings_tolerates_spacing_and_punctuation)
    r.record("phone_search_text_includes_metadata", test_phone_search_text_includes_phone_call_metadata)
    r.record(
        "phone_final_result_text_excludes_raw_transcript", test_phone_final_result_text_excludes_raw_transcript_evidence
    )
    r.record("phone_pinned_facts_flatten", test_flatten_pinned_call_findings_extracts_string_leaves)
    r.record("phone_callee_checks_coercion", test_callee_check_failures_coerce_bools_and_match_strings_loosely)
    r.record(
        "phone_payment_audit_structured_data",
        test_payment_audit_structured_data_since_returns_latest_successful_payment,
    )
    r.record("phone_callee_prompt_resolution", test_resolve_callee_prompt_requires_active_session)
    r.record("phone_public_base_url", test_benchmark_public_base_url_uses_env_override)
    r.record(
        "phone_public_base_url_isolated_manifest",
        test_benchmark_public_base_url_uses_isolated_context_manifest_not_dashboard_url,
    )
    r.record("phone_auto_approval_requires_callee", test_phone_auto_approval_requires_active_callee_number)
    r.record("extract_worker_pids_macos_python", test_extract_worker_pids_from_ps_matches_macos_python_executable)
    r.record("extract_worker_pids_lowercase_python", test_extract_worker_pids_from_ps_matches_lowercase_python)
    r.record("extract_worker_pids_workspace_filter", test_extract_worker_pids_from_ps_filters_to_workspace_root)
    r.record("process_cwd_workspace_filter", test_process_cwd_is_under_accepts_nested_paths)
    r.record("worker_pids_workspace_cwd_filter", test_worker_pids_for_workspace_filters_short_macos_commands_by_cwd)
    r.record("benchmark_context_root_path", test_benchmark_context_path_treats_root_context_as_repo_local)
    r.record(
        "worker_queue_preflight_accepts_sibling_workers",
        test_worker_queue_preflight_accepts_aligned_worker_among_other_local_queues,
    )
    r.record("read_process_env_var_portable", test_read_process_env_var_uses_portable_process_environ)
    r.record("ci_fails_on_skipped", test_ci_should_fail_on_skipped_required_task)
    r.record("outreach_batch_timeout_floor", test_outreach_batch_has_timeout_floor)
    r.record("timeout_default_uses_task_config", test_timeout_default_uses_task_config_when_history_is_missing)
    r.record("timeout_default_respects_floor", test_timeout_default_respects_explicit_floor)
    r.record("fast_mode_pass_skips_timeout_history", test_fast_mode_pass_does_not_seed_timeout_history)
    r.record("non_fast_mode_pass_records_timeout_history", test_non_fast_mode_pass_still_seeds_timeout_history)
    r.record(
        "benchmark_run_serializes_world_model_fidelity",
        test_benchmark_run_serializes_world_model_fidelity_and_ignores_unknown_task_fields,
    )
    r.record(
        "minted_cleanup_preserves_identity",
        test_minted_benchmark_cleanup_preserves_cached_agent_identity_by_default,
    )
    r.record(
        "minted_cleanup_can_reset_identity",
        test_minted_benchmark_cleanup_can_reset_agent_identity_when_explicit,
    )
    r.record(
        "minted_seed_identity_when_missing",
        test_minted_benchmark_seeds_cached_agent_identity_when_missing,
    )
    r.record(
        "minted_seed_identity_skips_existing",
        test_minted_benchmark_does_not_seed_cached_agent_identity_when_present,
    )
    r.record(
        "agent_sms_benchmark_prepares_phone_sender",
        test_agent_sms_benchmark_prepares_phone_only_agentphone_sender,
    )
    r.record(
        "minted_x_default_target",
        test_minted_x_benchmark_uses_live_x_default_target,
    )
    r.record(
        "minted_x_signup_evidence_terminal_blocker",
        test_minted_x_signup_evidence_rejects_terminal_phone_blocker,
    )
    r.record(
        "amazon_passkey_scenario_isolation",
        test_amazon_passkey_scenario_isolates_passkey_and_fresh_kernel_profile,
    )
    r.record(
        "amazon_passkey_catalog_contract",
        test_amazon_passkey_catalog_requires_live_passkey_kernel_evidence,
    )
    r.record(
        "webdecoy_fresh_browser_state",
        test_webdecoy_biometrics_uses_fresh_isolated_browser_state,
    )
    r.record(
        "anon_benchmark_mode_disables_saved_auth",
        test_anon_benchmark_mode_disables_saved_auth_material,
    )
    r.record(
        "local_benchmark_task_queue_uses_workspace",
        test_local_benchmark_task_queue_uses_conductor_workspace_only_for_local_urls,
    )
    await r.record_async(
        "parallel_scheduler_overlaps_isolated_browser_profiles",
        test_parallel_benchmark_scheduler_overlaps_isolated_browser_profiles,
    )
    await r.record_async(
        "parallel_scheduler_serializes_shared_browser_profiles",
        test_parallel_benchmark_scheduler_serializes_shared_browser_profiles,
    )
    r.record(
        "auth_independent_biometrics_joins_parallel_batch",
        test_auth_independent_biometrics_fixture_joins_isolated_parallel_batch,
    )
    r.record(
        "biometrics_fixture_exclusive_with_shared_auth",
        test_biometrics_fixture_stays_exclusive_beside_shared_auth_task,
    )
    r.record(
        "browser_agent_cookie_bundle_bootstrap_local_only",
        test_browser_agent_cookie_bundle_bootstrap_is_local_only,
    )
    await r.record_async(
        "primitive_cleanup_exact_only",
        test_primitive_cleanup_deletes_only_exact_recipients,
    )
    await r.record_async(
        "primitive_uber_welcome_evidence_exact_recipient",
        test_primitive_uber_welcome_evidence_uses_exact_recipient,
    )
    await r.record_async("api_headers_internal_api_key", test_api_headers_honors_internal_api_key_auth)
    await r.record_async("archive_agent_start", test_archive_agent_start_posts_agent_and_returns_fixture_ref)
    await r.record_async("archive_agent_finalize", test_archive_agent_finalize_posts_task_and_returns_manifest_ref)
    await r.record_async("archive_agent_finalize_best_effort", test_archive_agent_finalize_failure_is_best_effort)
    r.record("benchmark_run_archive_manifest_ref", test_benchmark_run_json_preserves_archive_manifest_ref)
    r.record("benchmark_run_wmh_prediction_accuracy", test_benchmark_run_summary_reports_wmh_prediction_accuracy)
    await r.record_async("archive_to_wmh_lifecycle", test_finalize_archive_and_score_world_model_lifecycle)
    r.record("world_model_cli_simulate_alias", test_world_model_cli_env_simulate_alias_does_not_enable_self_eval)
    r.record("world_model_cli_wmh_eval_real", test_world_model_cli_env_wmh_eval_scores_real_runs)
    await r.record_async(
        "simulate_preflight_world_model_update", test_simulate_preflight_updates_world_model_and_records_progress
    )
    await r.record_async(
        "code_agent_preflight_accepts_gpt_compute", test_code_agent_preflight_accepts_gpt_compute_token
    )
    await r.record_async(
        "code_agent_preflight_rejects_missing_compute", test_code_agent_preflight_rejects_missing_compute_token
    )
    await r.record_async(
        "code_agent_preflight_accepts_anthropic_api_key_fallback",
        test_code_agent_preflight_accepts_anthropic_api_key_fallback,
    )
    await r.record_async(
        "claude_code_preflight_uses_runtime_credential_route",
        test_claude_code_preflight_uses_runtime_credential_route,
    )
    await r.record_async(
        "claude_code_preflight_rejects_generic_claude_compute_token",
        test_claude_code_preflight_rejects_generic_claude_compute_token,
    )
    await r.record_async(
        "local_compute_refresh_accepts_anthropic_api_key_fallback",
        test_local_compute_refresh_accepts_healthy_anthropic_api_key_fallback,
    )
    r.record(
        "compute_token_source_ignores_isolated_process_target",
        test_compute_token_sync_reads_source_file_not_isolated_process_target,
    )
    await r.record_async(
        "anthropic_api_key_fallback_availability_fails_closed",
        test_anthropic_api_key_fallback_availability_fails_closed,
    )
    r.record("normalize_attention_requests", test_normalize_attention_requests_accepts_backend_contract)
    r.record("attention_kind_auth_vs_write_lock", test_attention_request_kind_distinguishes_auth_from_write_lock)
    r.record("attention_open_backend_fields", test_attention_request_open_check_honors_backend_answered_fields)
    r.record(
        "webdecoy_biometrics_evaluator",
        test_webdecoy_biometrics_evaluator_requires_interaction_and_low_score,
    )
    r.record(
        "webdecoy_biometrics_exact_network_score",
        test_webdecoy_biometrics_evaluator_uses_exact_network_score_when_visible_is_rounded,
    )
    r.record(
        "auth_bundle_biometrics_gate_env",
        test_auth_bundle_biometrics_gate_defaults_on_and_can_be_disabled,
    )
    r.record("calendly_passes_on_link_approval", test_calendly_benchmark_passes_on_link_approval_marker)
    r.record("count_only_passes_on_approval_count", test_count_only_benchmark_passes_on_expected_approval_count)
    r.record("count_only_allows_open_tool_context", test_count_only_approval_context_allows_open_tool_call)
    r.record(
        "open_approval_filters_tool_pairing_violation",
        test_open_approval_context_filters_expected_tool_pairing_violation,
    )
    r.record("count_only_releases_by_denial", test_count_only_releases_observed_approvals_by_denial)
    r.record("benchmark_env_bool", test_benchmark_env_bool_parses_optional_write_lock_override)
    r.record("benchmark_env_disable_approval", test_benchmark_env_override_can_disable_approval_handling)
    r.record(
        "source_connect_gate_benchmark_non_purchase_env",
        test_source_connect_gate_benchmark_enables_non_purchase_gates,
    )
    r.record(
        "cloudbench_source_connect_gate_benchmark_non_purchase_env",
        test_cloudbench_source_connect_gate_benchmark_enables_non_purchase_gates,
    )
    r.record(
        "cloudbench_test_payment_bundled_frontend_env",
        test_cloudbench_test_payment_benchmarks_enable_bundled_frontend_env,
    )
    await r.record_async("create_agent_write_lock_override", test_create_agent_sends_write_lock_override_when_env_set)
    await r.record_async("create_agent_goal_override", test_create_agent_uses_goal_override_when_env_set)
    await r.record_async("create_agent_response_schema", test_create_agent_sends_task_response_schema)
    r.record("keep_failed_agents_cleanup_policy", test_keep_failed_agents_only_preserves_failures)
    r.record("keep_agents_cleanup_policy", test_keep_agents_preserves_passed_and_failed_runs)
    r.record("local_plan_batches_together", test_local_plan_batches_selected_benchmarks_together)
    await r.record_async("tree_log_supabase_once", test_tree_log_collection_fetches_supabase_once)
    r.record("local_args_multi_order", test_local_benchmark_args_for_multi_task_preserve_explicit_order)
    r.record("harness_explicit_task_order", test_run_benchmark_resolves_explicit_tasks_in_requested_order)
    r.record("local_args_anon", test_local_benchmark_args_pass_anon_to_run_benchmark)
    r.record("local_args_single_task", test_local_benchmark_args_for_single_task_not_parallel)
    r.record("local_failed_tasks_from_run", test_local_failed_tasks_from_run_reads_result_json)
    r.record(
        "local_invocation_propagates_cache_ratchet_exit",
        test_local_benchmark_invocation_propagates_cache_ratchet_exit,
    )
    r.record("local_services_manifest_validation", test_local_services_manifest_validation_requires_ports)
    r.record(
        "local_manifest_system_database_identity",
        test_local_manifest_uses_isolated_system_database_identity,
    )
    r.record(
        "runner_fixture_system_database_identity",
        test_runner_fixtures_use_isolated_system_database_identity,
    )
    r.record(
        "compute_token_preflight_isolated_source",
        test_compute_token_preflight_uses_credential_source_not_restored_guest_database,
    )
    r.record(
        "runner_fixture_transient_database_probe_retry",
        test_runner_fixtures_retry_transient_local_database_probe_timeout,
    )
    r.record(
        "runner_fixture_isolated_database_fail_closed",
        test_runner_fixtures_fail_closed_when_isolated_database_is_unavailable,
    )
    r.record(
        "runner_fixture_manifest_database_identity_required",
        test_runner_fixtures_reject_manifest_without_database_identity,
    )
    r.record("local_isolated_fast_seed_dump", test_local_isolated_stack_opts_into_fast_seed_dump)
    r.record(
        "local_shared_public_tunnel_mode",
        test_local_shared_stack_preserves_public_tunnel_mode,
    )
    r.record(
        "local_start_services_readiness_cleanup",
        test_local_start_services_reaps_process_when_readiness_fails,
    )
    r.record(
        "local_seed_dump_primes_from_shared_stack",
        test_local_seed_dump_primes_once_from_healthy_shared_stack,
    )
    r.record(
        "local_start_services_cleanup_error_preserves_readiness_failure",
        test_local_start_services_preserves_readiness_failure_when_cleanup_fails,
    )
    r.record(
        "local_start_services_exact_process_group_cleanup",
        test_local_start_services_reaps_only_its_real_process_group,
    )
    r.record(
        "local_stop_services_pre_manifest_database_cleanup",
        test_local_stop_services_removes_pre_manifest_owned_database,
    )
    r.record(
        "local_port_range_cross_process_reservation",
        test_local_port_range_allocation_is_reserved_across_processes,
    )
    r.record(
        "local_start_services_ready_port_release",
        test_local_start_services_releases_port_reservation_after_readiness,
    )
    r.record(
        "run_sh_seed_dump_isolated_database",
        test_run_sh_seed_dump_targets_isolated_database_atomically,
    )
    r.record(
        "seed_dump_restore_target_client",
        test_seed_dump_restore_uses_target_container_pg_restore,
    )
    r.record(
        "workspace_dependency_preflight",
        test_workspace_dependency_preflight_respects_hoisted_installs,
    )
    r.record(
        "standalone_dependency_preflight",
        test_workspace_dependency_preflight_supports_standalone_packages,
    )
    r.record(
        "missing_package_dependency_preflight",
        test_workspace_dependency_preflight_rejects_missing_package_manifest,
    )
    r.record(
        "run_sh_reuses_reachable_workspace_db",
        test_run_sh_reuses_reachable_workspace_db_before_docker_daemon_probe,
    )
    r.record(
        "run_sh_required_seed_cleanup",
        test_run_sh_required_seed_failure_cleans_exact_owned_database,
    )
    r.record("run_sh_manifest_publishes_wmh", test_run_sh_manifest_writer_publishes_wmh_when_served)
    r.record("apply_manifest_env_injects_wmh", test_apply_manifest_environment_injects_wmh_base_url_and_model)
    r.record("local_results_and_diagnostics", test_local_extract_results_path_and_diagnostic_commands)
    r.record("agent_cache_provider_accounting", test_agent_cache_stats_respects_provider_accounting)
    r.record("local_parse_args_rejects_ambiguous_selection", test_local_parse_args_rejects_ambiguous_selection)
    r.record("local_parse_args_rejects_invalid_concurrency", test_local_parse_args_rejects_invalid_concurrency)
    r.record("local_checkpoint_flags_parse_for_any_task", test_local_benchmark_checkpoint_flags_parse_for_any_task)
    r.record("local_checkpoint_generates_source", test_local_benchmark_checkpoint_can_generate_source_from_task)
    r.record(
        "local_checkpoint_for_each_boundary_resolves_through_index",
        test_local_benchmark_checkpoint_for_each_boundary_resolves_through_index,
    )
    r.record(
        "local_checkpoint_message_index_can_bypass_for_each_boundary",
        test_local_benchmark_checkpoint_message_index_can_bypass_for_each_boundary,
    )
    r.record("local_checkpoint_accepts_legacy_aliases", test_local_benchmark_checkpoint_accepts_legacy_aliases)
    r.record(
        "local_checkpoint_options_require_checkpoint_mode",
        test_local_benchmark_checkpoint_options_require_checkpoint_mode,
    )
    r.record(
        "checkpoint_validation_generic_not_mass_sequence",
        test_checkpoint_validation_generic_does_not_require_mass_agent_sequence,
    )
    r.record("checkpoint_validation_mass_sequence", test_checkpoint_validation_mass_agent_sequence_remains_strict)
    r.record("local_diagnostics_timeout_recorded", test_local_diagnostics_timeout_is_recorded)
    r.record("smoke_memory_summary_flags_leak", test_build_smoke_memory_summary_flags_growth_and_playwright_driver)
    r.record("smoke_memory_summary_passes", test_build_smoke_memory_summary_passes_stable_worker)
    r.record(
        "smoke_memory_summary_scales_worker_count",
        test_build_smoke_memory_summary_scales_end_cap_by_worker_count,
    )
    r.record(
        "smoke_memory_summary_scaled_cap_overage",
        test_build_smoke_memory_summary_flags_scaled_end_cap_overage,
    )
    r.record(
        "smoke_memory_summary_darwin_growth_warning",
        test_build_smoke_memory_summary_skips_darwin_growth_without_allocator_trim,
    )
    r.record("smoke_memory_summary_linux_growth", test_build_smoke_memory_summary_enforces_linux_growth)
    r.record("local_worker_health_url_explicit", test_local_worker_health_url_prefers_explicit_smoke_url)
    r.record("local_worker_health_url_derived", test_local_worker_health_url_derives_from_backend_port)
    r.record("benchmark_memory_baseline_guarded", test_benchmark_memory_baseline_endpoint_is_guarded)
    r.record("logical_tool_counts_ignore_progress", test_logical_tool_counts_ignore_progress_messages)
    r.record(
        "logical_tool_counts_model_facing_routed_calls",
        test_logical_tool_counts_include_model_facing_routed_calls,
    )
    r.record("root_exact_tool_count_fail_fast", test_root_exact_tool_count_fails_fast_after_duplicate_call)
    r.record("message_side_effect_fast_cache_off", test_message_side_effect_benchmarks_force_fast_cache_off)
    r.record(
        "message_person_requires_confirmed_send",
        test_message_person_benchmark_requires_confirmed_send,
    )
    r.record(
        "message_person_agent_sms_requires_provider_receipt",
        test_message_person_agent_sms_benchmark_requires_immediate_provider_receipt,
    )
    await r.record_async(
        "message_person_requires_fresh_mac_bridge",
        test_message_person_bridge_preflight_requires_fresh_mac,
    )
    r.record("tool_count_expectations", test_tool_count_expectations_support_minimums_and_forbidden_tools)
    r.record(
        "user_data_prod_grep_provider_filters",
        test_user_data_prod_grep_requires_all_provider_filters,
    )
    r.record(
        "user_data_prod_grep_no_nested_agent_instruction",
        test_user_data_prod_grep_prompt_avoids_nested_agent_instruction,
    )
    r.record(
        "parallel_tool_calls_smoke_cap",
        test_parallel_tool_calls_smoke_cap_allows_recent_fanout_tail,
    )
    r.record(
        "response_schema_feedback_benchmark_mid_run",
        test_response_schema_feedback_benchmark_declares_real_mid_run_message,
    )
    r.record(
        "mid_run_feedback_schema_evaluator",
        test_mid_run_feedback_schema_evaluator_requires_exact_stability,
    )
    r.record(
        "toast_nopa_routes_to_toast",
        test_toast_nopa_benchmark_routes_browser_to_toast_not_generic_search,
    )
    r.record(
        "payment_benchmark_bundled_frontend",
        test_payment_benchmark_enables_bundled_frontend_before_stack_start,
    )
    r.record(
        "purchase_gate_benchmark_bundled_frontend",
        test_purchase_gate_benchmarks_enable_bundled_frontend_before_stack_start,
    )
    r.record(
        "benchmark_bundled_frontend_cloud_heap_budget",
        test_benchmark_bundled_frontend_build_has_cloud_heap_budget,
    )
    r.record(
        "payment_benchmark_lifecycle_stack_contract",
        test_payment_benchmark_preserves_lifecycle_stack_contract,
    )
    r.record(
        "isolated_benchmark_slow_first_sync",
        test_isolated_benchmark_services_allow_slow_first_sync,
    )
    r.record(
        "claude_code_benchmark_real_provider",
        test_claude_code_benchmark_forces_real_claude_provider_before_stack_start,
    )
    await r.record_async(
        "edge_warmup_explicit_research_port",
        test_edge_warmup_requires_explicit_research_port,
    )
    r.record(
        "agentcard_lifecycle_bootstrap_float",
        test_agentcard_lifecycle_bootstrap_provisions_sandbox_float,
    )
    r.record(
        "toast_payment_approval_complete_receipt",
        test_toast_payment_approval_requires_every_declared_receipt_field,
    )
    r.record(
        "toast_payment_merchant_grounded_connector_variant",
        test_toast_payment_merchant_identity_accepts_grounded_connector_variant,
    )
    r.record(
        "toast_payment_merchant_rejects_wrong_or_ungrounded",
        test_toast_payment_merchant_identity_rejects_wrong_or_ungrounded_variants,
    )
    r.record(
        "success_on_payment_card_request",
        test_success_on_payment_card_request_passes_before_agent_completion,
    )
    r.record(
        "payment_receipt_tax_rate_qualifier",
        test_payment_receipt_tax_rate_qualifier_preserves_exact_amount,
    )
    r.record(
        "payment_lifecycle_cross_provider_state",
        test_payment_lifecycle_validation_cross_checks_nested_provider_state,
    )
    await r.record_async(
        "abandonment_waits_for_cron_reconciliation",
        test_abandonment_waits_for_cron_reconciliation,
    )
    await r.record_async(
        "abandonment_retries_pending_company_release",
        test_abandonment_retries_a_pending_company_release,
    )
    await r.record_async(
        "abandonment_timeout_surfaces_durable_mismatch",
        test_abandonment_timeout_surfaces_the_last_durable_mismatch,
    )
    await r.record_async(
        "abandonment_waits_between_reclaim_and_void",
        test_abandonment_waits_between_funding_reclaim_and_purchase_void,
    )
    await r.record_async(
        "abandonment_tolerates_extended_lifecycle_outage",
        test_abandonment_tolerates_provider_outage_beyond_three_lifecycle_reads,
    )
    await r.record_async(
        "abandonment_bounds_persistent_lifecycle_outage",
        test_abandonment_surfaces_lifecycle_outage_at_reconciliation_deadline,
    )
    await r.record_async(
        "initial_payment_lifecycle_tolerates_transient_read",
        test_initial_payment_lifecycle_retries_one_transient_provider_failure,
    )
    await r.record_async(
        "initial_payment_lifecycle_bounds_persistent_outage",
        test_initial_payment_lifecycle_bounds_persistent_provider_failure,
    )
    r.record(
        "agent_payment_requires_lifecycle_evidence",
        test_agent_payment_catalog_requires_terminal_lifecycle_evidence,
    )
    r.record(
        "agent_payment_grounded_structured_confirmation",
        test_agent_payment_accepts_grounded_structured_browser_confirmation,
    )
    r.record(
        "agent_payment_current_payment_confirmation_key",
        test_agent_payment_accepts_current_payment_confirmation_schema_key,
    )
    r.record(
        "production_payment_rejects_sandbox_target",
        test_production_payment_lifecycle_refuses_sandbox_target,
    )
    r.record(
        "production_frontend_ignores_stale_local_manifest",
        test_production_frontend_url_ignores_stale_local_services_manifest,
    )
    r.record(
        "system_postgres_fixture_targets_manifest_db",
        test_system_postgres_fixture_sql_targets_manifest_database_name,
    )
    r.record(
        "agentcard_setup_fixture_skips_production_lifecycle",
        test_agentcard_setup_fixture_skips_production_lifecycle,
    )
    r.record(
        "ordered_attention_kind_sequence",
        test_expected_attention_kind_uses_ordered_sequence,
    )
    r.record(
        "agentcard_setup_attention_not_auto_approved",
        test_agentcard_setup_attention_is_not_auto_approved,
    )
    r.record(
        "kyc_gate_benchmark_uses_canonical_detection_contract",
        test_kyc_gate_benchmark_uses_canonical_detection_contract,
    )
    r.record(
        "expected_gate_message_evidence_terminal_before_browser_min_steps",
        test_expected_gate_message_evidence_is_terminal_before_browser_min_steps,
    )
    await r.record_async(
        "expected_gate_auto_approve_returns_without_resolving_gate",
        test_expected_gate_auto_approve_task_returns_without_resolving_gate,
    )
    await r.record_async(
        "agentcard_setup_terminal_refreshes_attention",
        test_agentcard_setup_terminal_check_refreshes_stale_attention_poll,
    )
    await r.record_async(
        "agentcard_setup_terminal_open_attention_fails_closed",
        test_agentcard_setup_terminal_check_fails_closed_for_open_attention,
    )
    r.record(
        "ecommerce_attention_rejects_auth_blocker",
        test_ecommerce_attention_kind_rejects_auth_blocker,
    )
    await r.record_async(
        "required_declared_evaluator_controls_pass_fail",
        test_required_declared_evaluator_controls_pass_fail,
    )
    r.record(
        "opentable_static_runtime_contract",
        test_opentable_static_evaluator_checks_full_runtime_contract,
    )
    r.record(
        "auto_approve_exact_approval_count",
        test_auto_approve_requires_exact_declared_approval_count,
    )
    r.record(
        "opentable_mixed_evaluator_catalog",
        test_opentable_catalog_uses_auto_approved_mixed_evaluators,
    )
    r.record(
        "instacart_weekly_grocery_catalog",
        test_instacart_catalog_uses_complete_weekly_grocery_basket,
    )
    r.record(
        "declared_static_no_tool_failures",
        test_no_tool_failures_static_check_rejects_any_failed_tool_event,
    )
    r.record(
        "declared_static_completion_summary_and_sms",
        test_completion_summary_and_sms_static_checks_are_fail_closed,
    )
    r.record(
        "blue_bottle_completion_delivery_contract",
        test_blue_bottle_catalog_enforces_summary_and_completion_sms,
    )
    await r.record_async(
        "blue_bottle_completion_sms_receipt_hydration",
        test_declared_evaluator_hydrates_completion_sms_receipt,
    )
    r.record(
        "doordash_single_clean_completed_browser_run",
        test_doordash_catalog_requires_single_clean_completed_browser_run,
    )
    r.record(
        "uber_normal_single_browser_task",
        test_uber_catalog_is_normal_single_browser_task_not_stateful_minted_flow,
    )
    r.record(
        "approval_details_item_and_amount",
        test_approval_request_details_can_require_item_name_and_amount,
    )
    r.record(
        "amazon_beanie_clean_completed_purchase",
        test_amazon_beanie_catalog_requires_clean_completed_cart_purchase,
    )
    r.record(
        "amazon_beanie_exactly_one_payment_or_write_lock",
        test_amazon_beanie_accepts_exactly_one_payment_or_write_lock,
    )
    r.record(
        "live_paid_bookings_payment_only",
        test_live_paid_bookings_stop_only_at_payment_approval,
    )
    r.record(
        "live_paid_bookings_grounded_site",
        test_live_paid_bookings_require_grounded_payment_site,
    )
    await r.record_async(
        "amazon_beanie_poll_rejects_second_or_unrelated_approval",
        test_amazon_beanie_poll_rejects_second_or_unrelated_approval_without_resolving_it,
    )
    await r.record_async(
        "invalid_payment_receipt_records_attention",
        test_invalid_payment_receipt_still_records_typed_attention_observation,
    )
    await r.record_async(
        "live_paid_booking_poll_stops_unapproved",
        test_live_paid_booking_poll_stops_without_approving_payment,
    )
    r.record(
        "alchemy_sauna_grounded_payment_approval",
        test_alchemy_sauna_catalog_stops_at_grounded_payment_approval,
    )
    r.record(
        "approval_details_multiple_dates_and_seat",
        test_approval_request_details_support_multiple_dates_and_seat,
    )
    r.record(
        "hotel_clean_completed_reservation",
        test_hotel_catalog_requires_single_clean_completed_reservation,
    )
    r.record(
        "event_ticket_grounded_payment_approval",
        test_event_ticket_catalog_stops_at_grounded_payment_approval,
    )
    r.record(
        "amazon_return_clean_completed_return",
        test_amazon_return_catalog_requires_single_clean_completed_return,
    )
    r.record(
        "live_fixture_auth_failure_is_fatal",
        test_live_fixture_fails_when_live_auth_refresh_fails,
    )
    r.record(
        "compute_token_explicit_prod_source",
        test_compute_token_sync_passes_explicit_prod_source_without_shared_workspace,
    )
    r.record(
        "compute_token_shared_source_requires_claude",
        test_shared_workspace_compute_source_requires_usable_claude_code,
    )
    r.record(
        "compute_token_source_contract",
        test_compute_token_source_contract_preserves_prisma_dsn_and_rejects_self_source,
    )
    r.record(
        "expected_passkey_credential_ref",
        test_expected_passkey_credential_ref_is_required_even_when_approval_is_terminal,
    )
    r.record(
        "cached_sub_agent_child_tool_counts",
        test_cached_sub_agent_child_tool_counts_are_counted_once,
    )
    r.record("parallel_tool_calls_explore_sub_agents", test_parallel_tool_calls_smoke_requires_explore_sub_agents)
    r.record("spawn_sub_agents_no_browser_code_detours", test_spawn_sub_agents_smoke_forbids_browser_and_code_detours)
    r.record("unified_catalog_core_contract", test_unified_catalog_validates_and_covers_benchmark_tasks)
    r.record(
        "unified_catalog_bench_axes",
        test_unified_catalog_delineates_bench_axes,
    )
    r.record(
        "daily_ecommerce_v1_catalog",
        test_daily_ecommerce_v1_catalog_has_eleven_distinct_transaction_flows,
    )
    r.record(
        "unified_catalog_multiple_evaluators",
        test_unified_catalog_supports_multiple_evaluators_per_eval,
    )
    r.record(
        "agent_class_min_steps_contract",
        test_agent_class_min_steps_contract_is_validated_and_defaulted,
    )
    r.record(
        "browser_smoke_single_step_trajectory",
        test_browser_smoke_accepts_captured_single_step_trajectory,
    )
    r.record(
        "payment_abandonment_two_step_trajectory",
        test_payment_abandonment_accepts_captured_two_step_trajectory,
    )
    r.record(
        "timeout_early_fail_pauses_before_payment_cleanup",
        test_timeout_early_fail_pauses_agent_before_payment_cleanup,
    )
    r.record(
        "production_payment_abandonment_two_step_trajectory",
        test_production_payment_abandonment_accepts_checkout_ready_two_step_trajectory,
    )
    r.record(
        "browser_min_steps_rejects_terminal_claim",
        test_browser_min_steps_rejects_terminal_claim_without_trajectory,
    )
    r.record(
        "browser_min_steps_per_instance",
        test_browser_min_steps_is_per_instance_not_aggregate,
    )
    r.record(
        "min_steps_non_browser_classes",
        test_min_steps_supports_non_browser_agent_classes,
    )
    r.record(
        "suite_selection_excludes_incomplete",
        test_suite_selection_excludes_incomplete_entries,
    )
    r.record(
        "dead_subscription_explicit_refund_candidate_contract",
        test_dead_subscription_catalog_has_explicit_refund_candidate_contract,
    )
    r.record(
        "people_search_prompts_route_to_people_search",
        test_people_search_catalog_prompts_route_to_people_search_tool,
    )
    r.record(
        "people_search_targeted_finishes_after_enrichment",
        test_people_search_targeted_finishes_after_people_search_enrichment,
    )
    r.record("every_task_has_base_image_fixture", test_every_task_has_base_image_fixture_by_default)
    r.record("live_fixture_registry_appliers_in_sync", test_live_fixture_registry_appliers_stay_in_sync)
    r.record(
        "amazon_passkey_scenario_is_exclusive_and_restorable",
        test_amazon_passkey_scenario_is_exclusive_and_restorable,
    )
    r.record("live_fixture_is_single_and_explicit", test_live_fixture_is_single_and_explicit)
    r.record("live_fixture_validation_guards", test_live_fixture_validation_rejects_unknown_and_synthetic_declarations)
    r.record("tag_slices_still_resolve", test_tag_slices_still_resolve)
    r.record("antibot_slice_daily_commerce", test_antibot_slice_includes_daily_toast_and_amazon_commerce)
    r.record("history_ledger_no_orphaned_task_names", test_history_ledger_task_names_still_exist_in_catalog)
    r.record("retired_tasks_hidden", test_retired_tasks_hidden_from_suite_and_listing)
    r.record("long_horizon_idea_bank", test_long_horizon_idea_bank_preserves_seed_ideas_with_safety_notes)
    r.record("agent_latency_reads_isolated_stack_logs", test_agent_latency_reads_isolated_benchmark_stack_logs)
    return r.all_passed
