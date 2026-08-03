from argparse import Namespace
import asyncio
from pathlib import Path

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


def test_suite_label_for_repeated_task_args_is_readable():
    args = _args(task=["parallel-tool-calls", "spawn-sub-agents"])

    assert rb.suite_name_for_error(args) == "--task parallel-tool-calls,spawn-sub-agents"


def test_agent_payment_tasks_use_a_dedicated_non_admin_user():
    expected_user_id = "00000000-0000-4000-8000-000000000106"

    assert local_runner.AGENT_PAYMENT_BENCHMARK_USER_ID == expected_user_id
    assert rb.AGENT_PAYMENT_BENCHMARK_USER_ID == expected_user_id
    assert expected_user_id != rb.USER_ID
    for task_name in local_runner.AGENT_PAYMENT_TASK_NAMES:
        assert rb._benchmark_user_id_for_task(task_name) == expected_user_id
    assert rb._benchmark_user_id_for_task(rb.AGENT_PAYMENT_PRODUCTION_TASK_NAME) is None


def test_payment_fixture_identity_is_shared_by_environment_and_seed(monkeypatch):
    monkeypatch.delenv("BENCHMARK_AGENT_PAYMENT_USER_ID", raising=False)
    monkeypatch.delenv("SEED_POOL_DEV_COMPUTE_TOKENS_FOR_SYNTHETIC_USERS", raising=False)
    local_runner.configure_task_environment(["agent-payment-test-shop"])

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

    calls = []
    monkeypatch.setattr(local_runner.subprocess, "run", lambda *args, **kwargs: calls.append((args, kwargs)))
    local_runner.seed_payment_fixture(
        {"ports": {"local_db": 5432}, "database": {"name": "victoria"}}
    )
    assert calls[0][0][0][-2:] == [
        "--user-id",
        local_runner.AGENT_PAYMENT_BENCHMARK_USER_ID,
    ]


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

    assert "assertDedicatedBenchmarkUser(userId)" in fixture
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
