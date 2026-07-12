"""Blackbox tests for benchmark helpers."""

import json
from pathlib import Path

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


def test_toast_nopa_benchmark_routes_browser_to_toast_not_generic_search():
    """Toast checkout benchmark should not rely on model-discovered DoorDash/Google routing."""
    from benchmarks.benchmark_tasks import get_task_by_name

    task = get_task_by_name("browser-toast-nopa-write-lock")

    assert "https://order.toasttab.com/online/nopafish" in task.prompt
    assert "Do not use Google, DoorDash, Uber Eats" in task.prompt
    assert task.expected_attention_kind == "payment_approval"
    assert task.expected_payment_receipt["merchant"] == "Nopa Fish (Toast - order.toasttab.com)"
    assert task.success_on_payment_card_request is True
    assert task.expected_payment_receipt["lineItems"] == [
        {"name": "The Rocky Sandwich", "quantity": 1}
    ]


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

    assert _validate_payment_receipt(task, req) is None


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

    task = get_task_by_name("load-test-sias")

    assert task.timeout_seconds == 300
    assert _default_timeout_for_task(task) == 300


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

        assert (
            bench._delete_local_minted_accounts_for_user(
                "user-123", reset_agent_identity=True
            )
            == 1
        )
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
    assert "+18159823405" in queries[1]
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

    blocker = (
        "X forced phone auth. Final DOM showed: "
        "An unexpected error occurred. Please try again."
    )
    success = "Account creation completed and the account is signed in on the home timeline."

    assert bench._x_signup_has_terminal_phone_blocker(blocker) is True
    assert bench._x_signup_has_account_creation_evidence(blocker) is False
    assert bench._x_signup_has_terminal_phone_blocker(success) is False
    assert bench._x_signup_has_account_creation_evidence(success) is True


def test_browser_agent_cookie_bundle_bootstrap_upserts_active_bundle_from_cookies():
    """Amazon auth-assistance bench activates CookieBundle rows from existing local cookies."""
    import benchmarks.run_benchmark as bench

    queries = []
    original_run_sql = bench._run_local_victoria_sql

    try:
        bench._run_local_victoria_sql = lambda sql: queries.append(sql) or "1"

        assert bench._ensure_local_cookie_bundle_for_realm("user-123", "amazon.com") == 1
    finally:
        bench._run_local_victoria_sql = original_run_sql

    assert len(queries) == 1
    assert 'FROM "Cookie"' in queries[0]
    assert 'INSERT INTO "CookieBundle"' in queries[0]
    assert 'ON CONFLICT ("userId", "authRealm", "browserSource", "browserProfile") DO UPDATE' in queries[0]
    assert '"disabledAt" = NULL' in queries[0]
    assert '"disabledReason" = NULL' in queries[0]
    assert "amazon.com" in queries[0]


def test_browser_agent_cookie_bundle_bootstrap_can_be_skipped_with_env():
    """Local auth-assistance reruns can intentionally exercise password auth without cookies."""
    import os

    import benchmarks.run_benchmark as bench

    queries = []
    original_run_sql = bench._run_local_victoria_sql
    original_env = os.environ.get("BENCHMARK_SKIP_COOKIE_BUNDLE_BOOTSTRAP")

    try:
        bench._run_local_victoria_sql = lambda sql: queries.append(sql) or "1"
        os.environ["BENCHMARK_SKIP_COOKIE_BUNDLE_BOOTSTRAP"] = "true"

        assert bench._ensure_local_cookie_bundle_for_realm("user-123", "amazon.com") == 0
    finally:
        bench._run_local_victoria_sql = original_run_sql
        if original_env is None:
            os.environ.pop("BENCHMARK_SKIP_COOKIE_BUNDLE_BOOTSTRAP", None)
        else:
            os.environ["BENCHMARK_SKIP_COOKIE_BUNDLE_BOOTSTRAP"] = original_env

    assert queries == []


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

    previous_skip = os.environ.get("BENCHMARK_SKIP_COOKIE_BUNDLE_BOOTSTRAP")
    previous_clear = os.environ.get("BENCHMARK_MINTED_CLEAR_EXISTING_AUTH")
    previous_steel_profile = os.environ.get("BENCHMARK_ANON_STEEL_PROFILE")
    previous_disable_saved_auth = os.environ.get("BENCHMARK_DISABLE_SAVED_BROWSER_AUTH")
    try:
        os.environ.pop("BENCHMARK_SKIP_COOKIE_BUNDLE_BOOTSTRAP", None)
        os.environ.pop("BENCHMARK_MINTED_CLEAR_EXISTING_AUTH", None)
        os.environ.pop("BENCHMARK_ANON_STEEL_PROFILE", None)
        os.environ.pop("BENCHMARK_DISABLE_SAVED_BROWSER_AUTH", None)

        bench._apply_anon_benchmark_mode()

        assert os.environ["BENCHMARK_SKIP_COOKIE_BUNDLE_BOOTSTRAP"] == "true"
        assert os.environ["BENCHMARK_MINTED_CLEAR_EXISTING_AUTH"] == "true"
        assert os.environ["BENCHMARK_ANON_STEEL_PROFILE"] == "true"
        assert os.environ["BENCHMARK_DISABLE_SAVED_BROWSER_AUTH"] == "true"
    finally:
        if previous_skip is None:
            os.environ.pop("BENCHMARK_SKIP_COOKIE_BUNDLE_BOOTSTRAP", None)
        else:
            os.environ["BENCHMARK_SKIP_COOKIE_BUNDLE_BOOTSTRAP"] = previous_skip
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
    original_has_fallback = bench._has_anthropic_api_key_fallback_configured
    try:
        async def fake_headers():
            return {"X-API-Key": "test-key"}

        bench._api_headers = fake_headers
        bench.httpx.AsyncClient = FakeClient
        bench._has_anthropic_api_key_fallback_configured = lambda: False

        assert await bench._check_compute_code_credentials("http://localhost:55120") is False
    finally:
        bench._api_headers = original_headers
        bench.httpx.AsyncClient = original_client
        bench._has_anthropic_api_key_fallback_configured = original_has_fallback


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
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, url, *, headers, timeout):
            calls.append((url, headers, timeout))
            if url.endswith("/api/integrations/compute-code/credentials/token"):
                return FakeResponse(404, {"error": "NO_TOKENS_AVAILABLE"})
            if url.endswith("/api/integrations/compute-code/anthropic-key/cooldown"):
                return FakeResponse(200, {"onCooldown": False})
            raise AssertionError(f"unexpected URL {url}")

    original_headers = bench._api_headers
    original_client = bench.httpx.AsyncClient
    original_has_fallback = bench._has_anthropic_api_key_fallback_configured
    try:
        async def fake_headers():
            return {"X-API-Key": "test-key"}

        bench._api_headers = fake_headers
        bench.httpx.AsyncClient = FakeClient
        bench._has_anthropic_api_key_fallback_configured = lambda: True

        assert await bench._check_compute_code_credentials("http://localhost:55120") is True
    finally:
        bench._api_headers = original_headers
        bench.httpx.AsyncClient = original_client
        bench._has_anthropic_api_key_fallback_configured = original_has_fallback

    assert calls == [
        (
            "http://localhost:55120/api/integrations/compute-code/credentials/token",
            {"X-API-Key": "test-key"},
            10.0,
        ),
        (
            "http://localhost:55120/api/integrations/compute-code/anthropic-key/cooldown",
            {"X-API-Key": "test-key"},
            10.0,
        ),
    ]


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
        "metadata": {
            "requestUserApproval": {"attentionRequestId": "approval-1", "writePermission": True}
        }
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
                        "Entered benchmark-human@example.com in invisible mode and clicked Submit. "
                        + score_line
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

    assert _approval_mode_allows_open_tool_context(task, data, approvals_triggered=task.expected_approval_count or 0) is True


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


def test_local_plan_runs_load_tests_separately():
    """Local orchestrator separates load-test-sias from normal parallel batches."""
    from benchmarks.local import plan_invocations

    invocations = plan_invocations(["chat-mode", "load-test-sias", "browser-agent"])

    assert [(i.label, i.tasks, i.is_load) for i in invocations] == [
        ("non-load", ["chat-mode", "browser-agent"], False),
        ("load-test-sias", ["load-test-sias"], True),
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


def test_local_benchmark_args_for_multi_task_exclude_complement():
    """Multi-task local runs use one run_benchmark invocation with explicit exclusions."""
    from benchmarks.local import build_benchmark_args

    args = build_benchmark_args(
        ["chat-mode", "browser-agent"],
        port=55120,
        bootstrap=True,
        max_concurrency=5,
    )

    assert args[0].endswith("python") or Path(args[0]).name.startswith("python")
    assert args[1:3] == ["-u", "benchmarks/run_benchmark.py"]
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


def test_local_benchmark_args_pass_anon_to_run_benchmark():
    """Local --anon must reach the underlying benchmark harness."""
    from benchmarks.local import build_benchmark_args

    args = build_benchmark_args(["minted-agent-accounts-x"], port=55120, anon=True)

    assert args[args.index("--task") + 1] == "minted-agent-accounts-x"
    assert "--anon" in args


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


def test_local_extract_results_path_and_diagnostic_commands():
    """Local wrapper finds runner result paths and builds all three diagnostics."""
    from benchmarks.local import diagnostic_commands, extract_results_path

    output = "hello\n  Results saved: /tmp/bench.json\nbye\n"
    assert str(extract_results_path(output)) == "/tmp/bench.json"

    commands = diagnostic_commands("agent-123", task_name="browser-agent", port=55120)
    joined = [" ".join(command) for command in commands]
    assert any("agent_latency.py agent-123" in command for command in joined)
    assert any("agent_logs.py agent-123 --tree --diagnostics --url http://localhost:55120" in command for command in joined)
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

    no_final_failure = _validate_user_data_prod_grep_messages(
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
    assert no_final_failure is not None
    assert "provider_validation_checklist" in no_final_failure


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

    assert callee_check_failures({"payment_completed": True}, {}) == [
        "payment_completed: expected True, got None"
    ]


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
            data = payment_audit_structured_data_since(
                datetime(2026, 7, 2, 22, 0, 0, tzinfo=timezone.utc)
            )
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


def test_phone_auto_approval_requires_active_callee_number():
    """Phone tasks auto-approve only approval requests for the controlled callee number."""
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _phone_approval_matches_callee

    task = get_task_by_name("phone-call-client-intake")
    task._callee_phone_number = "+14155550123"

    assert _phone_approval_matches_callee(task, {"question": "Make a phone call to +1 (415) 555-0123?"})
    assert not _phone_approval_matches_callee(task, {"question": "Make a phone call to +1 (650) 555-0123?"})
def test_unified_catalog_validates_and_covers_all_runner_kinds():
    """tasks.json is the ONE catalog: valid contract, agent + vitest entries, holding set split."""
    from benchmarks.long_horizon import EVALUATION_METHODS, validate_catalog

    tasks = validate_catalog()

    assert len(tasks) >= 36
    statuses = {(t.get("runner", "agent"), t.get("status", "ready")) for t in tasks}
    assert ("agent", "ready") in statuses
    assert ("agent", "incomplete") in statuses
    assert ("vitest", "ready") in statuses
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


def test_suite_selection_excludes_incomplete_and_external_entries():
    """Suite runs execute only ready agent evals; incomplete + vitest entries are catalogued but skipped."""
    from benchmarks.benchmark_tasks import all_tasks, suite_tasks

    suite_names = {t.name for t in suite_tasks()}
    all_names = {t.name for t in all_tasks()}

    assert "wait-for-trigger" in all_names and "wait-for-trigger" not in suite_names
    assert "raise-my-round" not in all_names
    assert "smoke-backend-claude-code" in all_names and "smoke-backend-claude-code" not in suite_names
    # Main added three ready Plaid transaction benchmarks during this branch.
    assert "load-test-sias" in suite_names
    assert "browser-agent" in suite_names
    assert {
        "user-data-prod-grep",
        "plaid-transactions-monthly-spend",
        "plaid-transactions-doordash-count",
        "plaid-transactions-dead-subscriptions",
        "phone-call-client-intake",
        "phone-call-payment",
    } <= suite_names
    # This branch added four ready gate benchmarks (subscription free-credit,
    # subscription card-mint, kyc card-mint, source-connect gmail).
    assert {
        "gate-subscription-free-credit",
        "gate-subscription-card-mint",
        "gate-kyc-card-mint",
        "gate-source-connect-gmail",
    } <= suite_names
    assert len(suite_names) == 38


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
    assert by_name["load-test-sias"].environment["base_images"] == [DEFAULT_BASE_IMAGE]


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

    args = local_bench.parse_args(
        ["chat-mode", "--checkpoint", "2", "--checkpoint-boundary", "message-index"]
    )
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


async def run_all_tests():
    print("benchmark blackbox tests:")
    r = BlackboxResult()
    r.record("phone_call_tasks_two_sided_verification", test_phone_call_tasks_define_two_sided_verification)
    r.record("phone_callee_end_call_config", test_phone_callee_assistant_base_has_end_call_tool_and_duration_cap)
    r.record("phone_findings_matcher_squashes_separators", test_missing_call_findings_tolerates_spacing_and_punctuation)
    r.record("phone_search_text_includes_metadata", test_phone_search_text_includes_phone_call_metadata)
    r.record("phone_final_result_text_excludes_raw_transcript", test_phone_final_result_text_excludes_raw_transcript_evidence)
    r.record("phone_pinned_facts_flatten", test_flatten_pinned_call_findings_extracts_string_leaves)
    r.record("phone_callee_checks_coercion", test_callee_check_failures_coerce_bools_and_match_strings_loosely)
    r.record("phone_payment_audit_structured_data", test_payment_audit_structured_data_since_returns_latest_successful_payment)
    r.record("phone_callee_prompt_resolution", test_resolve_callee_prompt_requires_active_session)
    r.record("phone_public_base_url", test_benchmark_public_base_url_uses_env_override)
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
        "minted_x_default_target",
        test_minted_x_benchmark_uses_live_x_default_target,
    )
    r.record(
        "minted_x_signup_evidence_terminal_blocker",
        test_minted_x_signup_evidence_rejects_terminal_phone_blocker,
    )
    r.record(
        "browser_agent_cookie_bundle_bootstrap_upserts",
        test_browser_agent_cookie_bundle_bootstrap_upserts_active_bundle_from_cookies,
    )
    r.record(
        "browser_agent_cookie_bundle_bootstrap_skip_env",
        test_browser_agent_cookie_bundle_bootstrap_can_be_skipped_with_env,
    )
    r.record(
        "anon_benchmark_mode_disables_saved_auth",
        test_anon_benchmark_mode_disables_saved_auth_material,
    )
    r.record(
        "local_benchmark_task_queue_uses_workspace",
        test_local_benchmark_task_queue_uses_conductor_workspace_only_for_local_urls,
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
    await r.record_async("simulate_preflight_world_model_update", test_simulate_preflight_updates_world_model_and_records_progress)
    await r.record_async("code_agent_preflight_accepts_gpt_compute", test_code_agent_preflight_accepts_gpt_compute_token)
    await r.record_async("code_agent_preflight_rejects_missing_compute", test_code_agent_preflight_rejects_missing_compute_token)
    await r.record_async(
        "code_agent_preflight_accepts_anthropic_api_key_fallback",
        test_code_agent_preflight_accepts_anthropic_api_key_fallback,
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
    await r.record_async("create_agent_write_lock_override", test_create_agent_sends_write_lock_override_when_env_set)
    await r.record_async("create_agent_goal_override", test_create_agent_uses_goal_override_when_env_set)
    r.record("keep_failed_agents_cleanup_policy", test_keep_failed_agents_only_preserves_failures)
    r.record("keep_agents_cleanup_policy", test_keep_agents_preserves_passed_and_failed_runs)
    r.record("local_plan_load_separate", test_local_plan_runs_load_tests_separately)
    await r.record_async("tree_log_supabase_once", test_tree_log_collection_fetches_supabase_once)
    r.record("local_args_multi_exclude", test_local_benchmark_args_for_multi_task_exclude_complement)
    r.record("local_args_anon", test_local_benchmark_args_pass_anon_to_run_benchmark)
    r.record("local_args_single_load", test_local_benchmark_args_for_single_load_task_not_parallel)
    r.record("local_failed_tasks_from_run", test_local_failed_tasks_from_run_reads_result_json)
    r.record("local_services_manifest_validation", test_local_services_manifest_validation_requires_ports)
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
        "toast_nopa_routes_to_toast",
        test_toast_nopa_benchmark_routes_browser_to_toast_not_generic_search,
    )
    r.record(
        "success_on_payment_card_request",
        test_success_on_payment_card_request_passes_before_agent_completion,
    )
    r.record(
        "cached_sub_agent_child_tool_counts",
        test_cached_sub_agent_child_tool_counts_are_counted_once,
    )
    r.record("parallel_tool_calls_explore_sub_agents", test_parallel_tool_calls_smoke_requires_explore_sub_agents)
    r.record("spawn_sub_agents_no_browser_code_detours", test_spawn_sub_agents_smoke_forbids_browser_and_code_detours)
    r.record("unified_catalog_core_contract", test_unified_catalog_validates_and_covers_all_runner_kinds)
    r.record(
        "unified_catalog_bench_axes",
        test_unified_catalog_delineates_bench_axes,
    )
    r.record(
        "unified_catalog_multiple_evaluators",
        test_unified_catalog_supports_multiple_evaluators_per_eval,
    )
    r.record(
        "suite_selection_excludes_incomplete_external",
        test_suite_selection_excludes_incomplete_and_external_entries,
    )
    r.record("every_task_has_base_image_fixture", test_every_task_has_base_image_fixture_by_default)
    r.record("tag_slices_still_resolve", test_tag_slices_still_resolve)
    r.record("history_ledger_no_orphaned_task_names", test_history_ledger_task_names_still_exist_in_catalog)
    r.record("long_horizon_idea_bank", test_long_horizon_idea_bank_preserves_seed_ideas_with_safety_notes)
    return r.all_passed
