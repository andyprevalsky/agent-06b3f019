from argparse import Namespace
import asyncio
import os
from pathlib import Path

import pytest

import benchmarks.local as local_runner
import benchmarks.run_benchmark as rb


def _args(*, task=None, suite=None, exclude_task=None):
    return Namespace(
        task=task or [],
        suite=suite,
        anon=False,
        exclude_task=exclude_task or [],
    )


def test_repeated_task_selects_exact_tasks_in_order():
    args = _args(task=["parallel-tool-calls", "spawn-sub-agents"])

    tasks = rb.resolve_tasks(args)

    assert [task.name for task in tasks] == ["parallel-tool-calls", "spawn-sub-agents"]


def test_comma_separated_task_selects_exact_tasks_in_order():
    args = _args(task=["parallel-tool-calls,spawn-sub-agents"])

    tasks = rb.resolve_tasks(args)

    assert [task.name for task in tasks] == ["parallel-tool-calls", "spawn-sub-agents"]


def test_mixed_gpa_forbidden_and_required_tasks_keep_gp_tools_enabled(monkeypatch):
    monkeypatch.delenv("ROSE_DISABLE_GENERAL_PURPOSE_AGENT", raising=False)

    local_runner.configure_task_environment(
        ["parallel-tool-calls", "spawn-sub-agents"], isolated=True
    )

    assert os.environ.get("ROSE_DISABLE_GENERAL_PURPOSE_AGENT") == "0"


def test_gpa_forbidden_only_tasks_disable_gp_tools(monkeypatch):
    monkeypatch.delenv("ROSE_DISABLE_GENERAL_PURPOSE_AGENT", raising=False)

    local_runner.configure_task_environment(["parallel-tool-calls"], isolated=True)

    assert os.environ.get("ROSE_DISABLE_GENERAL_PURPOSE_AGENT") == "1"


def test_suite_label_for_repeated_task_args_is_readable():
    args = _args(task=["parallel-tool-calls", "spawn-sub-agents"])

    assert rb.suite_name_for_error(args) == "--task parallel-tool-calls,spawn-sub-agents"


def test_local_validate_task_names_preserves_intentional_repeats():
    """k=N trials pass the same task name N times; local must not silently dedupe."""
    names = ["browser-amazon-return"] * 5
    assert local_runner.validate_task_names(names) == names
    args = local_runner.build_benchmark_args(names, port=3201, max_concurrency=5)
    assert args.count("--task") == 5
    assert "--parallel" in args
    assert args[args.index("--max-concurrency") + 1] == "5"


def test_owner_interrupted_cloud_run_deletes_cancelled_root(monkeypatch):
    monkeypatch.delenv("BENCHMARK_KEEP_AGENTS", raising=False)
    monkeypatch.delenv(
        "BENCHMARK_DELETE_CANCELLED_AGENTS_ON_INTERRUPT", raising=False
    )
    assert rb._should_delete_cancelled_agent(keep_failed_agents=True) is False

    monkeypatch.setenv("BENCHMARK_DELETE_CANCELLED_AGENTS_ON_INTERRUPT", "true")
    assert rb._should_delete_cancelled_agent(keep_failed_agents=True) is True

    monkeypatch.setenv("BENCHMARK_KEEP_AGENTS", "true")
    assert rb._should_delete_cancelled_agent(keep_failed_agents=True) is False


def test_delete_agent_rejects_failed_canonical_cleanup(monkeypatch):
    class FakeResponse:
        status_code = 503

    class FakeClient:
        def __init__(self, timeout):
            assert timeout == 30

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def delete(self, _url, *, headers):
            assert headers == {"X-API-Key": "test"}
            return FakeResponse()

    async def fake_headers():
        return {"X-API-Key": "test"}

    monkeypatch.setattr(rb, "_api_headers", fake_headers)
    monkeypatch.setattr(rb.httpx, "AsyncClient", FakeClient)

    with pytest.raises(RuntimeError, match="Failed to delete agent root-agent: HTTP 503"):
        asyncio.run(rb.delete_agent("http://backend", "root-agent"))


def test_interrupt_cleanup_status_fails_closed_until_every_root_completes(
    monkeypatch, tmp_path: Path
):
    status_file = tmp_path / "interrupt-cleanup.status"
    monkeypatch.setenv("BENCHMARK_INTERRUPT_CLEANUP_STATUS_FILE", str(status_file))
    monkeypatch.setenv("BENCHMARK_INTERRUPT_CLEANUP_TOKEN", "guest-run-token")
    monkeypatch.setattr(rb, "_INTERRUPT_CLEANUP_STARTED", 0)
    monkeypatch.setattr(rb, "_INTERRUPT_CLEANUP_COMPLETED", 0)

    assert rb._begin_interrupt_cleanup() is True
    rb._finalize_interrupt_cleanup_status()
    assert "state=failed" in status_file.read_text()

    rb._complete_interrupt_cleanup()
    rb._finalize_interrupt_cleanup_status()
    status = status_file.read_text()
    assert "token=guest-run-token" in status
    assert "state=clean" in status


def test_agent_payment_tasks_use_the_admin_account_with_forced_customer_path():
    expected_user_id = "1f85ff25-6e29-4c1b-8739-f917bd101a30"

    assert local_runner.AGENT_PAYMENT_BENCHMARK_USER_ID == expected_user_id
    assert rb.AGENT_PAYMENT_BENCHMARK_USER_ID == expected_user_id
    assert expected_user_id == rb.USER_ID
    for task_name in local_runner.AGENT_PAYMENT_TASK_NAMES:
        assert rb._benchmark_user_id_for_task(task_name) == expected_user_id
    assert rb._benchmark_user_id_for_task(rb.AGENT_PAYMENT_PRODUCTION_TASK_NAME) is None
    local_runner.configure_task_environment(["agent-payment-test-shop"], isolated=True)
    assert os.environ["BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH"] == "1"


def test_payment_fixture_identity_is_shared_by_environment_and_seed(monkeypatch):
    monkeypatch.delenv("BENCHMARK_AGENT_PAYMENT_USER_ID", raising=False)
    monkeypatch.delenv("BENCHMARK_ISOLATED_RUN", raising=False)
    monkeypatch.delenv("SEED_POOL_DEV_COMPUTE_TOKENS_FOR_SYNTHETIC_USERS", raising=False)
    local_runner.configure_task_environment(
        ["agent-payment-test-shop"], isolated=True
    )

    assert (
        local_runner.AGENT_PAYMENT_BENCHMARK_USER_ID_ENV
        == "BENCHMARK_AGENT_PAYMENT_USER_ID"
    )
    assert (
        local_runner.os.environ[local_runner.AGENT_PAYMENT_BENCHMARK_USER_ID_ENV]
        == local_runner.AGENT_PAYMENT_BENCHMARK_USER_ID
    )
    assert (
        local_runner.os.environ["SEED_POOL_DEV_COMPUTE_TOKENS_FOR_SYNTHETIC_USERS"]
        == "1"
    )
    assert local_runner.os.environ["BENCHMARK_ISOLATED_RUN"] == "true"

    calls = []
    monkeypatch.setattr(local_runner.subprocess, "run", lambda *args, **kwargs: calls.append((args, kwargs)))
    local_runner.seed_payment_fixture(
        {"ports": {"local_db": 5432}, "database": {"name": "victoria"}}
    )
    assert calls[0][0][0][-2:] == [
        "--user-id",
        local_runner.AGENT_PAYMENT_BENCHMARK_USER_ID,
    ]


def test_payment_compute_pool_requires_an_isolated_stack(monkeypatch):
    monkeypatch.setenv("BENCHMARK_ISOLATED_RUN", "true")
    monkeypatch.setenv("SEED_POOL_DEV_COMPUTE_TOKENS_FOR_SYNTHETIC_USERS", "1")

    local_runner.configure_task_environment(
        ["agent-payment-test-shop"], isolated=False
    )

    assert "SEED_POOL_DEV_COMPUTE_TOKENS_FOR_SYNTHETIC_USERS" not in os.environ
    assert "BENCHMARK_ISOLATED_RUN" not in os.environ


def test_payment_fixture_guards_identity_and_funds_non_admin_credit():
    repo_root = Path(__file__).resolve().parents[2]
    fixture = (
        repo_root
        / "back-end"
        / "scripts"
        / "setup-benchmark-payment.ts"
    ).read_text()
    purchase_config = (
        repo_root / "back-end" / "src" / "domains" / "purchases" / "config.ts"
    ).read_text()

    assert "assertDedicatedBenchmarkUser(userId, mode)" in fixture
    assert "if (isAdminUser(userId))" in fixture
    assert "BENCHMARK_CREDIT_HEADROOM_CENTS" in fixture
    assert "pg_advisory_xact_lock" in fixture
    assert "WITH acquired AS MATERIALIZED" in fixture
    assert "SELECT 1 AS locked FROM acquired" in fixture
    assert "prisma.credit.deleteMany" not in fixture
    assert (
        "export const BENCHMARK_PAYMENT_LIFECYCLE_USER_ID = "
        "'00000000-0000-4000-8000-000000000106'" in purchase_config
    )
    assert "BENCHMARK_PAYMENT_LIFECYCLE_ADMIN_RUN_USER_ID" in purchase_config
    assert "1f85ff25-6e29-4c1b-8739-f917bd101a30" in purchase_config
    assert "BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH" in purchase_config
    assert "function benchmarkForceCustomerPurchasePath()" in purchase_config


def test_agentcard_setup_targets_the_effective_payment_user(monkeypatch):
    requests = []

    class FakeResponse:
        status_code = 200
        text = ""

        def json(self):
            return {"status": "connected"}

    class FakeClient:
        def __init__(self, timeout):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, *, headers, json):
            requests.append((url, headers, json))
            return FakeResponse()

    async def fake_headers():
        return {"X-API-Key": "test"}

    monkeypatch.setenv("BENCHMARK_RUN_USER_ID", rb.AGENT_PAYMENT_BENCHMARK_USER_ID)
    monkeypatch.setattr(rb, "_api_headers", fake_headers)
    monkeypatch.setattr(rb.httpx, "AsyncClient", FakeClient)

    asyncio.run(rb.configure_benchmark_agentcard_setup("http://localhost:3001", "complete"))

    assert requests[0][2] == {
        "userId": rb.AGENT_PAYMENT_BENCHMARK_USER_ID,
        "action": "complete",
    }
