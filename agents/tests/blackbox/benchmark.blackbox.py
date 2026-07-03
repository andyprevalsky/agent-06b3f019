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
    original_record_pass = timeout_history.record_pass
    try:
        timeout_history.record_pass = lambda **kwargs: recorded.append(kwargs)

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

    assert recorded == []


def test_non_fast_mode_pass_still_seeds_timeout_history():
    """Cold-cache passes still update the timeout pXX corpus."""
    import benchmarks.timeout_history as timeout_history
    from benchmarks.results import BenchmarkRun, TaskResult

    recorded = []
    original_record_pass = timeout_history.record_pass
    try:
        timeout_history.record_pass = lambda **kwargs: recorded.append(kwargs)

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

    assert recorded == [
        {
            "task_name": "chat-mode",
            "duration_seconds": 42.0,
            "cost_cents": 1.0,
            "agent_id": "agent-cold",
            "timestamp": run.timestamp,
        }
    ]


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
    original_auth_mode = bench._auth_mode
    original_api_key = bench.API_KEY
    original_user_id = bench.USER_ID

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
        bench._auth_mode = None
        bench.API_KEY = "fallback-api-key"
        bench.USER_ID = "fallback-user"

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
        bench._auth_mode = original_auth_mode
        bench.API_KEY = original_api_key
        bench.USER_ID = original_user_id


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


def test_webdecoy_biometrics_evaluator_uses_exact_network_score_when_visible_is_rounded(tmp_path):
    """The ratchet should compare exact FCaptcha JSON, not the page's rounded display text."""
    import json

    from benchmarks.run_benchmark import _evaluate_webdecoy_biometrics_result

    network_dir = tmp_path / "recording" / "network"
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

    assert _count_only_release_response() == "denied"


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
        "spawn_browser_agent": 1,
        "spawn_claude_code_agent": 1,
        "message_person": 1,
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


async def run_all_tests():
    print("benchmark blackbox tests:")
    r = BlackboxResult()
    r.record("extract_worker_pids_macos_python", test_extract_worker_pids_from_ps_matches_macos_python_executable)
    r.record("extract_worker_pids_lowercase_python", test_extract_worker_pids_from_ps_matches_lowercase_python)
    r.record("extract_worker_pids_workspace_filter", test_extract_worker_pids_from_ps_filters_to_workspace_root)
    r.record("process_cwd_workspace_filter", test_process_cwd_is_under_accepts_nested_paths)
    r.record("worker_pids_workspace_cwd_filter", test_worker_pids_for_workspace_filters_short_macos_commands_by_cwd)
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
    await r.record_async("code_agent_preflight_accepts_gpt_compute", test_code_agent_preflight_accepts_gpt_compute_token)
    await r.record_async("code_agent_preflight_rejects_missing_compute", test_code_agent_preflight_rejects_missing_compute_token)
    r.record("normalize_attention_requests", test_normalize_attention_requests_accepts_backend_contract)
    r.record("attention_kind_auth_vs_write_lock", test_attention_request_kind_distinguishes_auth_from_write_lock)
    r.record("attention_open_backend_fields", test_attention_request_open_check_honors_backend_answered_fields)
    r.record(
        "webdecoy_biometrics_evaluator",
        test_webdecoy_biometrics_evaluator_requires_interaction_and_low_score,
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
    r.record("local_diagnostics_timeout_recorded", test_local_diagnostics_timeout_is_recorded)
    r.record("smoke_memory_summary_flags_leak", test_build_smoke_memory_summary_flags_growth_and_playwright_driver)
    r.record("smoke_memory_summary_passes", test_build_smoke_memory_summary_passes_stable_worker)
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
        "cached_sub_agent_child_tool_counts",
        test_cached_sub_agent_child_tool_counts_are_counted_once,
    )
    r.record("parallel_tool_calls_explore_sub_agents", test_parallel_tool_calls_smoke_requires_explore_sub_agents)
    r.record("spawn_sub_agents_no_browser_code_detours", test_spawn_sub_agents_smoke_forbids_browser_and_code_detours)
    return r.all_passed
