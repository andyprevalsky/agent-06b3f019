import asyncio
import fcntl
import multiprocessing
import os
import tempfile
from argparse import Namespace
from pathlib import Path

import pytest

import benchmarks.local as local_runner
import benchmarks.run_benchmark as rb

# Holders run fast polls/handoffs so the multi-process cases stay well under 10s.
_FAST_POLL_SECONDS = 0.05


def test_sandbox_payment_preflight_sweeps_residual_before_task(monkeypatch):
    calls = []

    async def setup(_base_url, action):
        calls.append(action)

    monkeypatch.setattr(rb, "configure_benchmark_agentcard_setup", setup)
    sandbox = next(task for task in rb.all_tasks() if task.name == "agent-payment-abandonment")
    production = next(
        task for task in rb.all_tasks() if task.name == "agent-payment-production-abandonment"
    )

    async def check():
        await rb.prepare_sandbox_payment_residual(sandbox, "http://localhost:3001")
        await rb.prepare_sandbox_payment_residual(production, "https://roselabs.ai")

    asyncio.run(check())
    assert calls == ["prepare-residual"]


def _hold_sandbox_payment_lock(ready, release):
    async def hold():
        async with rb._sandbox_agentcard_payment_lock(poll_seconds=_FAST_POLL_SECONDS) as slot:
            ready.send(slot)
            await asyncio.to_thread(release.recv)

    asyncio.run(hold())


class _SlotHolder:
    """A separate benchmark process holding one AgentCard sandbox slot.

    flock is per open file description, so cross-lane exclusion is only proven
    by holders in separate processes.
    """

    def __init__(self, context):
        self._ready_rx, ready_tx = context.Pipe(duplex=False)
        release_rx, self._release_tx = context.Pipe(duplex=False)
        self._process = context.Process(target=_hold_sandbox_payment_lock, args=(ready_tx, release_rx))
        self._released = False

    def start(self) -> "_SlotHolder":
        self._process.start()
        return self

    def slot(self) -> int:
        assert self._ready_rx.poll(15), "benchmark process did not acquire an AgentCard sandbox slot"
        return self._ready_rx.recv()

    def release(self) -> None:
        if not self._released:
            self._released = True
            self._release_tx.send(True)

    def join(self) -> None:
        self._process.join(timeout=10)
        assert self._process.exitcode == 0

    def cleanup(self) -> None:
        if self._process.is_alive():
            self.release()
            self._process.terminate()
            self._process.join(timeout=5)


async def _assert_waits_until_released(holder: _SlotHolder, *, expected_slot: int) -> None:
    async def acquire():
        async with rb._sandbox_agentcard_payment_lock(poll_seconds=_FAST_POLL_SECONDS) as slot:
            return slot

    waiter = asyncio.create_task(acquire())
    await asyncio.sleep(0.3)
    assert not waiter.done(), "benchmark lane entered while every AgentCard sandbox slot was held"
    holder.release()
    assert await asyncio.wait_for(waiter, timeout=10) == expected_slot


@pytest.fixture
def agentcard_lock_dir(monkeypatch):
    with tempfile.TemporaryDirectory() as directory:
        lock_path = Path(directory) / "payment.lock"
        monkeypatch.setenv("BENCHMARK_AGENTCARD_LOCK_PATH", str(lock_path))
        yield lock_path


def test_sandbox_payment_lock_slot0_is_the_legacy_lock_path(monkeypatch):
    monkeypatch.delenv("BENCHMARK_AGENTCARD_LOCK_PATH", raising=False)
    monkeypatch.delenv("BENCHMARK_AGENTCARD_SLOTS", raising=False)
    legacy = Path(tempfile.gettempdir()) / "rose-agentcard-sandbox-benchmark.lock"

    assert rb._agentcard_sandbox_slot_paths() == [legacy, legacy.with_name(f"{legacy.name}.slot1")]

    monkeypatch.setenv("BENCHMARK_AGENTCARD_LOCK_PATH", "/custom/payment.lock")
    monkeypatch.setenv("BENCHMARK_AGENTCARD_SLOTS", "3")
    assert rb._agentcard_sandbox_slot_paths() == [
        Path("/custom/payment.lock"),
        Path("/custom/payment.lock.slot1"),
        Path("/custom/payment.lock.slot2"),
    ]

    monkeypatch.setenv("BENCHMARK_AGENTCARD_SLOTS", "0")
    assert rb._agentcard_sandbox_slot_paths() == [Path("/custom/payment.lock")]

    monkeypatch.setenv("BENCHMARK_AGENTCARD_SLOTS", "two")
    with pytest.raises(ValueError, match="BENCHMARK_AGENTCARD_SLOTS"):
        rb._agentcard_sandbox_slot_paths()


def test_sandbox_payment_lock_single_slot_serializes_separate_benchmark_processes(monkeypatch, agentcard_lock_dir):
    monkeypatch.setenv("BENCHMARK_AGENTCARD_SLOTS", "1")
    holder = _SlotHolder(multiprocessing.get_context("spawn")).start()
    try:
        assert holder.slot() == 0
        asyncio.run(_assert_waits_until_released(holder, expected_slot=0))
        holder.join()
    finally:
        holder.cleanup()


def test_sandbox_payment_lock_two_slots_admit_two_processes_and_block_a_third(monkeypatch, agentcard_lock_dir):
    monkeypatch.setenv("BENCHMARK_AGENTCARD_SLOTS", "2")
    context = multiprocessing.get_context("spawn")
    first = _SlotHolder(context).start()
    second = _SlotHolder(context).start()
    try:
        first_slot, second_slot = first.slot(), second.slot()
        assert {first_slot, second_slot} == {0, 1}, "two lanes must hold the two slots concurrently"
        asyncio.run(_assert_waits_until_released(first, expected_slot=first_slot))
        first.join()
        second.release()
        second.join()
    finally:
        first.cleanup()
        second.cleanup()


def test_sandbox_payment_lock_legacy_holder_on_slot0_leaves_new_slots_free(monkeypatch, agentcard_lock_dir):
    """Old-code lanes flock only the legacy path; new code must count them as slot 0."""
    monkeypatch.setenv("BENCHMARK_AGENTCARD_SLOTS", "2")
    legacy_fd = os.open(agentcard_lock_dir, os.O_CREAT | os.O_RDWR, 0o600)
    fcntl.flock(legacy_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    entered = False

    async def fail_if_polled(seconds: float) -> None:
        # Only the post-release handoff may sleep; polling means slot 1 was missed.
        assert entered, "slot 1 was free but the new lock polled instead of taking it"

    async def acquire():
        nonlocal entered
        async with rb._sandbox_agentcard_payment_lock(sleep=fail_if_polled) as slot:
            entered = True
            return slot

    try:
        assert asyncio.run(acquire()) == 1
    finally:
        os.close(legacy_fd)


def test_sandbox_payment_lock_announces_wait_once_jitters_polls_and_hands_off(monkeypatch, capsys, agentcard_lock_dir):
    monkeypatch.setenv("BENCHMARK_AGENTCARD_SLOTS", "1")
    legacy_fd = os.open(agentcard_lock_dir, os.O_CREAT | os.O_RDWR, 0o600)
    fcntl.flock(legacy_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    jitters = iter([0.0, 1.0, 0.5])
    sleeps: list[float] = []

    async def record_sleep(seconds: float) -> None:
        sleeps.append(seconds)
        if len(sleeps) == 3:
            fcntl.flock(legacy_fd, fcntl.LOCK_UN)
        assert len(sleeps) <= 4, f"lock kept polling after slot 0 was released: {sleeps}"

    async def acquire():
        async with rb._sandbox_agentcard_payment_lock(
            "agentcard-task", poll_seconds=2.0, sleep=record_sleep, jitter=lambda: next(jitters)
        ) as slot:
            return slot

    try:
        assert asyncio.run(acquire()) == 0
    finally:
        os.close(legacy_fd)

    # Three jittered polls in [poll, 1.5 * poll), then a post-release handoff
    # longer than any waiter's poll so a back-to-back holder cannot re-take it.
    assert sleeps == [2.0, 3.0, 2.5, 4.0]
    out = capsys.readouterr().out
    assert out.count("waiting for AgentCard sandbox slot") == 1
    assert "[agentcard-task]" in out
    assert "acquired slot 0 of 1" in out


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

    local_runner.configure_task_environment(["parallel-tool-calls", "spawn-sub-agents"], isolated=True)

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


def test_local_timeout_override_reaches_benchmark_runner():
    options = local_runner.parse_args(
        ["raise-5m-rose-labs-brex", "--timeout-seconds", "1800"]
    )

    assert options.timeout_seconds == 1800
    args = local_runner.build_benchmark_args(
        options.tasks, port=3201, timeout_seconds=options.timeout_seconds
    )
    assert args[args.index("--timeout-seconds") + 1] == "1800"
def test_owner_interrupted_cloud_run_deletes_cancelled_root(monkeypatch):
    monkeypatch.delenv("BENCHMARK_KEEP_AGENTS", raising=False)
    monkeypatch.delenv("BENCHMARK_DELETE_CANCELLED_AGENTS_ON_INTERRUPT", raising=False)
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


def test_interrupt_cleanup_status_fails_closed_until_every_root_completes(monkeypatch, tmp_path: Path):
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


def test_parallel_benchmark_identities_keep_approval_headers_task_scoped(monkeypatch):
    """A sibling completing must not switch a payment task's attention polling user."""
    monkeypatch.delenv("BENCHMARK_RUN_USER_ID", raising=False)
    monkeypatch.setattr(rb, "API_KEY", "benchmark-test-key")
    payment_user = "00000000-0000-4000-8000-000000000111"
    sibling_user = "00000000-0000-4000-8000-000000000222"

    async def run_concurrently():
        payment_ready = asyncio.Event()
        sibling_done = asyncio.Event()

        async def payment():
            with rb._benchmark_run_user_scope(payment_user):
                payment_ready.set()
                await sibling_done.wait()
                return (await rb._api_headers())["X-User-Id"]

        async def sibling():
            await payment_ready.wait()
            try:
                with rb._benchmark_run_user_scope(sibling_user):
                    user_id = (await rb._api_headers())["X-User-Id"]
            finally:
                sibling_done.set()
            return user_id

        return await asyncio.gather(payment(), sibling())

    assert asyncio.run(run_concurrently()) == [payment_user, sibling_user]
    assert "BENCHMARK_RUN_USER_ID" not in os.environ


def test_payment_fixture_identity_is_shared_by_environment_and_seed(monkeypatch):
    monkeypatch.delenv("BENCHMARK_AGENT_PAYMENT_USER_ID", raising=False)
    monkeypatch.delenv("BENCHMARK_ISOLATED_RUN", raising=False)
    monkeypatch.delenv("SEED_POOL_DEV_COMPUTE_TOKENS_FOR_SYNTHETIC_USERS", raising=False)
    local_runner.configure_task_environment(["agent-payment-test-shop"], isolated=True)

    assert local_runner.AGENT_PAYMENT_BENCHMARK_USER_ID_ENV == "BENCHMARK_AGENT_PAYMENT_USER_ID"
    assert (
        local_runner.os.environ[local_runner.AGENT_PAYMENT_BENCHMARK_USER_ID_ENV]
        == local_runner.AGENT_PAYMENT_BENCHMARK_USER_ID
    )
    assert local_runner.os.environ["SEED_POOL_DEV_COMPUTE_TOKENS_FOR_SYNTHETIC_USERS"] == "1"
    assert local_runner.os.environ["BENCHMARK_ISOLATED_RUN"] == "true"

    calls = []
    monkeypatch.setattr(local_runner.subprocess, "run", lambda *args, **kwargs: calls.append((args, kwargs)))
    local_runner.seed_payment_fixture({"ports": {"local_db": 5432}, "database": {"name": "victoria"}})
    assert calls[0][0][0][-2:] == [
        "--user-id",
        local_runner.AGENT_PAYMENT_BENCHMARK_USER_ID,
    ]


def test_payment_compute_pool_requires_an_isolated_stack(monkeypatch):
    monkeypatch.setenv("BENCHMARK_ISOLATED_RUN", "true")
    monkeypatch.setenv("SEED_POOL_DEV_COMPUTE_TOKENS_FOR_SYNTHETIC_USERS", "1")

    local_runner.configure_task_environment(["agent-payment-test-shop"], isolated=False)

    assert "SEED_POOL_DEV_COMPUTE_TOKENS_FOR_SYNTHETIC_USERS" not in os.environ
    assert "BENCHMARK_ISOLATED_RUN" not in os.environ


def test_payment_fixture_guards_identity_and_funds_non_admin_credit():
    repo_root = Path(__file__).resolve().parents[2]
    fixture = (repo_root / "back-end" / "scripts" / "setup-benchmark-payment.ts").read_text()
    purchase_config = (repo_root / "back-end" / "src" / "domains" / "purchases" / "config.ts").read_text()

    assert "assertDedicatedBenchmarkUser(userId, mode)" in fixture
    assert "if (isAdminUser(userId))" in fixture
    assert "BENCHMARK_CREDIT_HEADROOM_CENTS" in fixture
    assert "pg_advisory_xact_lock" in fixture
    assert "WITH acquired AS MATERIALIZED" in fixture
    assert "SELECT 1 AS locked FROM acquired" in fixture
    assert "prisma.credit.deleteMany" not in fixture
    assert (
        "export const BENCHMARK_PAYMENT_LIFECYCLE_USER_ID = '00000000-0000-4000-8000-000000000106'" in purchase_config
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
