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

# These cases exercise the same native entrypoints as a recording preparation;
# no model, database, browser, or provider is contacted.
def test_owned_preparation_explicit_bounds_and_normal_deadline(monkeypatch):
    import copy
    task = copy.copy(rb.get_task_by_name('test-mass-agent-run-0'))
    task._resolved_timeout_seconds = 900
    before = copy.deepcopy(vars(task))
    assert rb._execution_timeout_seconds(task) == 900
    task._owned_preparation_seconds = 3600
    assert rb._execution_timeout_seconds(task) == 3600
    assert rb.agent_execution_backstop_seconds(task) == 3600
    del task._owned_preparation_seconds
    assert vars(task) == before
    for seconds in (0, -1, 3601, True):
        with pytest.raises(ValueError):
            local_runner.validate_owned_preparation_options(
                Namespace(owned_recording_preparation_seconds=seconds), [task.name])
    args = local_runner.parse_args([task.name, '--owned-recording-preparation-seconds', '3600'])
    local_runner.validate_owned_preparation_options(args, [task.name])
    for flag in ('--simulate', '--shared-stack', '--use-existing', '--timeout-seconds'):
        extra = [flag, '1000'] if flag == '--timeout-seconds' else [flag]
        with pytest.raises((ValueError, SystemExit)):
            bad = local_runner.parse_args([task.name, '--owned-recording-preparation-seconds', '3600', *extra])
            local_runner.validate_owned_preparation_options(bad, [task.name])


@pytest.mark.parametrize('price, effective', [(None, 200), (1, 1), (1000, 1000)])
def test_owned_preparation_admission_checks_empty_real_cache(monkeypatch, tmp_path, price, effective):
    import hashlib
    import json
    from providers.demo_cache import context
    root = str(Path(__file__).resolve().parents[2])
    url = 'postgresql://test@localhost/victoria_wmh_recording_new'
    manifest = tmp_path / 'owner.json'
    manifest.write_text(json.dumps({'checkout': root, 'owner_workspace': 'isolated',
        'database': 'victoria_wmh_recording_new', 'host': 'localhost',
        'url_sha256': hashlib.sha256(url.encode()).hexdigest(), 'retained_across_iterations': True}))
    env = {'WMH_OWNED_RECORDING_CACHE_MANIFEST': str(manifest),
        'WMH_OWNED_RECORDING_CACHE_DATABASE_URL': url, 'DEMO_CACHE_DATABASE_URL': url,
        'FAST_MODE_CACHE_DATABASE_URL': url, 'DEMO_CACHE_RECORD_DEMO': '1',
        'FAST_MODE_CACHE_RECORD_DEMO': '1', 'DEMO_CACHE_DISABLE_WRITE_THROUGH': '0',
        'FAST_MODE_CACHE_DISABLE_WRITE_THROUGH': '0', 'BENCHMARK_ISOLATED_RUN': 'true',
        'BENCHMARK_WORLD_MODEL_MODE': 'real', 'CONDUCTOR_WORKSPACE_NAME': 'isolated',
        'DATABASE_URL': 'postgresql://test@localhost/victoria_fixture'}
    monkeypatch.setattr(os, 'environ', env)
    monkeypatch.setattr(rb.cloud_batch_cleanup, 'contract', lambda: (tmp_path / 'cleanup', 'token'))
    reads = []
    monkeypatch.setattr(rb, '_recording_cache_row_count', lambda value: reads.append(value) or 0)
    task = rb.get_task_by_name('test-mass-agent-run-0')
    from dataclasses import asdict
    original_hash = hashlib.sha256(json.dumps(asdict(task), sort_keys=True, default=str).encode()).hexdigest()
    admitted = rb._admit_owned_preparation('http://localhost:3100', [task], 100, tmp_path/'prep.json', price_limit_cents=price)
    assert admitted['cache_rows_before'] == 0
    assert admitted['original_catalog_price_limit_cents'] == 200
    assert admitted['effective_preparation_price_limit_cents'] == effective
    assert admitted['task_definition_sha256'] == original_hash
    assert task.price_limit_cents == 200
    assert reads == [url]
    assert context.DemoCacheContext(True, task.prompt).read_enabled is False
    assert context.DemoCacheContext(True, task.prompt).soft_complete_allowed is False
    for key, value in [('BENCHMARK_WORLD_MODEL_MODE', 'simulate'),
                       ('BENCHMARK_DEMO_CACHE_READ_ONLY', '1'),
                       ('FAST_MODE_CACHE_DATABASE_URL', 'postgresql://test@localhost/other')]:
        old = env.get(key)
        env[key] = value
        with pytest.raises(ValueError):
            rb._admit_owned_preparation('http://localhost:3100', [task], 100, tmp_path/(key+'.json'), price_limit_cents=price)
        if old is None: env.pop(key)
        else: env[key] = old
    monkeypatch.setattr(rb, '_recording_cache_row_count', lambda value: 1938)
    with pytest.raises(ValueError, match='empty'):
        rb._admit_owned_preparation('http://localhost:3100', [task], 100, tmp_path/'occupied.json', price_limit_cents=price)
    with pytest.raises(ValueError):
        rb._admit_owned_preparation('https://api.roselabs.ai', [task], 100, tmp_path/'remote.json')


@pytest.mark.parametrize('price, effective', [(None, 200), (1000, 1000)])
def test_owned_preparation_never_saves_benchmark_pass(monkeypatch, tmp_path, price, effective):
    import json
    from types import SimpleNamespace
    from benchmarks.results import TaskResult
    events = []
    async def run(base, task, **kwargs):
        assert kwargs['preparation_seconds'] == 100
        assert kwargs['preparation_price_limit_cents'] == price
        assert kwargs['keep_failed_agents'] is True
        kwargs['on_agent_created'](task.name, 'root')
        events.append('run')
        return TaskResult(name=task.name, passed=False, agent_id='root', status='COMPLETED',
            progress_score=1, duration_seconds=2, cost_cents=3, message_count=10,
            benchmark_status='UNSCORED', logs={'preparation': {'qualification': 'NOT_VALIDATION'}})
    async def cleanup(base, results, live, **kwargs):
        assert live == {'test-mass-agent-run-0': ['root']}
        assert results[0].passed is False
        events.append('cleanup')
    monkeypatch.setattr(rb, 'run_single_task', run)
    monkeypatch.setattr(rb, '_finalize_owned_cloud_batch', cleanup)
    monkeypatch.setattr(rb, '_begin_interrupt_cleanup', lambda: None)
    monkeypatch.setattr(rb, '_complete_interrupt_cleanup', lambda: events.append('clean'))
    monkeypatch.setattr(rb.BenchmarkRun, 'save', lambda *a: pytest.fail('preparation entered benchmark history'))
    monkeypatch.setattr(rb, 'evaluate_task', lambda *a: pytest.fail('preparation scored'))
    out = tmp_path/'prep.json'
    out.write_text(json.dumps({'original_catalog_price_limit_cents': 200,
                                    'effective_preparation_price_limit_cents': effective}))
    args = SimpleNamespace(owned_recording_preparation_seconds=100, owned_recording_preparation_out=str(out),
                           owned_recording_preparation_price_limit_cents=price)
    asyncio.run(rb._run_owned_preparation('http://localhost:3100', rb.get_task_by_name('test-mass-agent-run-0'), args))
    value = json.loads(out.read_text())
    assert value['qualification'] == 'NOT_VALIDATION'
    assert value['mode'] == 'UNSCORED_RECORDING_PREPARATION'
    assert value['original_catalog_price_limit_cents'] == 200
    assert value['effective_preparation_price_limit_cents'] == effective
    assert value['result']['passed'] is False
    assert value['result']['benchmark_status'] == 'UNSCORED'
    assert events == ['run', 'cleanup', 'clean']


def test_owned_preparation_abort_retains_original_error_and_custody(monkeypatch, tmp_path):
    import json
    from types import SimpleNamespace
    events = []
    async def run(base, task, **kwargs):
        kwargs['on_agent_created'](task.name, 'root')
        raise asyncio.CancelledError('original abort')
    async def cleanup(base, results, live, **kwargs):
        assert live["test-mass-agent-run-0"] == ['root']
        events.append('cleanup')
    monkeypatch.setattr(rb, 'run_single_task', run)
    monkeypatch.setattr(rb, '_finalize_owned_cloud_batch', cleanup)
    monkeypatch.setattr(rb, '_begin_interrupt_cleanup', lambda: None)
    monkeypatch.setattr(rb, '_complete_interrupt_cleanup', lambda: None)
    out = tmp_path/'prep.json'; out.write_text(json.dumps({'original_catalog_price_limit_cents': 200,
                                    'effective_preparation_price_limit_cents': 200}))
    args = SimpleNamespace(owned_recording_preparation_seconds=100, owned_recording_preparation_out=str(out))
    with pytest.raises(asyncio.CancelledError, match='original abort'):
        asyncio.run(rb._run_owned_preparation('http://localhost:3100', rb.get_task_by_name('test-mass-agent-run-0'), args))
    assert events == ['cleanup']
    assert 'original abort' in out.read_text()
    assert json.loads(out.read_text())['qualification'] == 'NOT_VALIDATION'


def test_owned_preparation_results_refuse_history_even_after_cleanup_error(tmp_path):
    from benchmarks.results import BenchmarkRun, TaskResult
    row = TaskResult(name='native', passed=False, agent_id='root', status='COMPLETED',
        progress_score=1, duration_seconds=2, cost_cents=3, message_count=10,
        benchmark_status='ERROR', stop_metadata={'purpose': 'owned_recording_preparation'})
    run = BenchmarkRun(task_results=[row])
    with pytest.raises(ValueError, match='Unscored preparation'):
        run.save(str(tmp_path/'normal-results'))
    assert not (tmp_path/'normal-results').exists()


def test_owned_preparation_owner_deadline_uses_existing_exact_abort(monkeypatch, tmp_path):
    import signal
    from types import SimpleNamespace
    events = []
    state = {'done': False}
    class Selector:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def register(self, *args): pass
        def select(self, *args): return []
    process = SimpleNamespace(pid=12345, stdout=SimpleNamespace(close=lambda: None),
        poll=lambda: 0 if state['done'] else None, wait=lambda: 130)
    stack = SimpleNamespace(context_dir=tmp_path, run_id='owned', isolated=True)
    owner = local_runner.LocalBenchmarkOwner(stack)
    owner.process = process
    owner.native_identity = 'exact-fixture-birth'
    owner.preparation_deadline = 0
    monkeypatch.setattr(local_runner.selectors, 'DefaultSelector', Selector)
    def stop(child, identity, signum):
        assert child is process and identity == 'exact-fixture-birth'
        events.append(signum)
        state['done'] = True
    monkeypatch.setattr(local_runner, '_signal_owned_process', stop)
    monkeypatch.setattr(local_runner, '_read_cleanup_receipt', lambda path, token: events.append('verified'))
    code, _ = owner.drain(echo=False)
    assert code == 130 and owner.signum == signal.SIGTERM
    assert owner.verified is True
    assert events == [signal.SIGINT, 'verified']


def test_owned_preparation_creation_is_identical_to_normal_route(monkeypatch):
    import copy
    import json
    import httpx
    requests = []
    original_client = httpx.AsyncClient
    def response(request):
        requests.append((request.method, request.url.path, json.loads(request.content)))
        return httpx.Response(201, json={'agent_id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'})
    transport = httpx.MockTransport(response)
    monkeypatch.setattr(rb.httpx, 'AsyncClient', lambda **kwargs: original_client(transport=transport, **kwargs))
    async def headers(): return {'Authorization': 'offline-fixture'}
    monkeypatch.setattr(rb, '_api_headers', headers)
    monkeypatch.setattr(rb, '_local_benchmark_task_queue', lambda base: 'owned-queue')
    monkeypatch.setattr(rb, '_resolve_write_lock_enabled', lambda task: None)
    monkeypatch.setattr(rb, '_benchmark_agent_source_override', lambda: None)
    task = copy.copy(rb.get_task_by_name('test-mass-agent-run-0'))
    original = copy.deepcopy(vars(task))
    async def check():
        await rb.create_agent('http://localhost:3100', task)
        preparation = copy.copy(task)
        preparation._owned_preparation_seconds = 3600
        await rb.create_agent('http://localhost:3100', preparation)
    asyncio.run(check())
    assert requests[0] == requests[1]
    body = requests[0][2]
    assert body['goal'] == task.prompt
    assert body['price_limit_cents'] == task.effective_price_limit_cents()
    assert body['verifier'] == {'type': 'FLOAT_LLM_JUDGE'}
    assert body['fast_mode_cache_enabled'] is True
    assert body['task_queue'] == 'owned-queue'
    assert 'start_phase' not in body  # preserve chat -> router/schema -> PLAN
    assert vars(task) == original


@pytest.mark.parametrize("outcome", ["normal", "error", "cancel"])
def test_owned_preparation_actual_runner_preserves_capture_without_evaluation(monkeypatch, outcome):
    import copy
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    task = copy.copy(rb.get_task_by_name('test-mass-agent-run-0'))
    task._resolved_timeout_seconds = 900
    original = copy.deepcopy(vars(task))
    root = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    snapshot = {'agent': {'id': root, 'status': 'COMPLETED', 'progress': 1, 'tree_cost_cents': 3},
                'messages': [{'role': 'USER', 'text': task.prompt},
                             {'role': 'ASSISTANT', 'text': 'partial informational answer'}]}
    created = []
    async def create(base, actual):
        assert actual._resolved_timeout_seconds == 900
        assert actual._owned_preparation_seconds == 100
        assert actual.prompt == task.prompt and actual.price_limit_cents == task.price_limit_cents
        created.append(root)
        return root
    async def poll(base, aid, actual, *args):
        assert rb._execution_timeout_seconds(actual) == 100
        if outcome == "error":
            raise RuntimeError("original offline execution error")
        if outcome == "cancel":
            raise asyncio.CancelledError("original offline cancellation")
        return snapshot, 0, 0, None
    monkeypatch.setattr(rb, 'create_agent', create)
    monkeypatch.setattr(rb, '_poll_agent', poll)
    archive = AsyncMock(return_value=('original-final-ref', {'status': 'not_applicable'}))
    monkeypatch.setattr(rb, 'finalize_archive_and_score_world_model', archive)
    monkeypatch.setattr(rb.cloud_batch_cleanup, 'contract', lambda: ('owned', 'token'))
    monkeypatch.setattr(rb, '_should_delete_cancelled_agent', lambda *a: False)
    for name, result in [('_apply_live_fixtures', []), ('_apply_memory_fixtures', []),
                         ('_apply_auth_test_site', None), ('_warm_cache_gated_root', None),
                         ('subscribe_supabase_realtime_agent', 'offline'),
                         ('post_world_model_update_events', None), ('archive_agent_start', 'original-start-ref'),
                         ('_restore_live_fixture_scenarios_async', None), ('_release_auth_test_site', None),
                         ('get_agent', snapshot), ('get_agent_tree', [{'agent_id': root}]),
                         ('collect_logs', {})]:
        monkeypatch.setattr(rb, name, AsyncMock(return_value=result))
    monkeypatch.setattr(rb, 'SupabaseRealtimeSmokeMonitor',
        lambda *args, **kwargs: SimpleNamespace(start=AsyncMock(), stop=AsyncMock()))
    monkeypatch.setattr(rb, 'evaluate_task', lambda *a: pytest.fail('preparation called evaluator'))
    observed = []
    result = asyncio.run(rb.run_single_task('http://localhost:3100', task,
        preparation_seconds=100, on_agent_created=lambda name, aid: observed.append(aid)))
    assert created == observed == [root]
    assert result.passed is False
    if outcome == 'normal':
        assert result.benchmark_status == 'UNSCORED'
        assert result.logs['preparation']['snapshot'] == snapshot
        assert result.logs['preparation']['qualification'] == 'NOT_VALIDATION'
        assert not archive.called
    else:
        assert outcome == 'cancel' or 'original offline execution error' in result.failure_reason
        assert 'original offline' in result.logs['preparation']['execution_error']
        assert archive.call_args.kwargs['unscored_preparation'] is True
    assert result.logs['messages']  # actual existing capture projection
    assert vars(task) == original


@pytest.mark.parametrize("url, expected", [
    ('postgresql://private-user:private-password@localhost/victoria_wmh_recording_new',
     {'PGHOST': 'localhost', 'PGPORT': '5432', 'PGUSER': 'private-user',
      'PGPASSWORD': 'private-password', 'PGDATABASE': 'victoria_wmh_recording_new'}),
    ('postgres://user%40name:pass%3A%2F%25%20word@127.0.0.1:5433/db%20with%2Fslash',
     {'PGHOST': '127.0.0.1', 'PGPORT': '5433', 'PGUSER': 'user@name',
      'PGPASSWORD': 'pass:/% word', 'PGDATABASE': 'db with/slash'}),
    ('postgresql://user:p%2Bass@[::1]:5434/cache',
     {'PGHOST': '::1', 'PGPORT': '5434', 'PGUSER': 'user', 'PGPASSWORD': 'p+ass', 'PGDATABASE': 'cache'}),
])
def test_owned_preparation_empty_cache_probe_is_read_only_and_private(monkeypatch, url, expected):
    from types import SimpleNamespace
    import subprocess
    calls = []
    monkeypatch.setenv('PGSERVICE', 'foreign-service')
    monkeypatch.setenv('PGHOSTADDR', '203.0.113.1')
    def execute(command, **kwargs):
        calls.append((command, kwargs))
        assert url not in repr(command)
        assert expected['PGPASSWORD'] not in repr(command)
        for key, value in expected.items():
            assert kwargs['env'][key] == value
        assert 'PGHOSTADDR' not in kwargs['env'] and 'PGSERVICE' not in kwargs['env']
        assert kwargs['env']['PGOPTIONS'] == '-c default_transaction_read_only=on -c statement_timeout=5000'
        assert kwargs['env']['PGCONNECT_TIMEOUT'] == '5'
        assert kwargs['timeout'] == 15
        assert command[-1] == 'SELECT COUNT(*) FROM "FastModeCacheEntry"'
        return SimpleNamespace(returncode=0, stdout='1938\n')
    monkeypatch.setattr(subprocess, 'run', execute)
    assert rb._recording_cache_row_count(url) == 1938
    assert len(calls) == 1


@pytest.mark.parametrize('url', [
    'postgresql://user:secret@remote.example/cache',
    'postgresql://user:secret@localhost/cache?options=-c%20default_transaction_read_only=off',
    'postgresql://user:secret@localhost/cache?sslmode=require',
    'postgresql://user:secret@localhost/cache?host=remote.example',
    'postgresql://user:secret@localhost/cache?connect_timeout=100',
    'postgresql://user:secret@localhost/cache#fragment',
    'postgresql://user:secret@localhost:99999/cache',
    'postgresql://user:secret@localhost:0/cache',
    'postgresql://localhost/cache',
    'postgresql://user:sec%FFret@localhost/cache',
    'postgresql://user:secret@localhost/',
    'postgresql://user:sec%00ret@localhost/cache',
])
def test_owned_preparation_cache_probe_rejects_unsupported_uri_before_connect(monkeypatch, url):
    import subprocess
    monkeypatch.setattr(subprocess, 'run', lambda *a, **k: pytest.fail('invalid connection attempted'))
    with pytest.raises(ValueError) as error:
        rb._recording_cache_row_count(url)
    assert 'secret' not in str(error.value) and url not in str(error.value)


def test_owned_preparation_abort_cleanup_failure_keeps_primary(monkeypatch, tmp_path):
    import json
    from types import SimpleNamespace
    async def run(*args, **kwargs):
        raise asyncio.CancelledError('primary cancellation')
    async def cleanup(*args, **kwargs):
        raise RuntimeError('unverified cleanup')
    monkeypatch.setattr(rb, 'run_single_task', run)
    monkeypatch.setattr(rb, '_finalize_owned_cloud_batch', cleanup)
    monkeypatch.setattr(rb, '_begin_interrupt_cleanup', lambda: None)
    monkeypatch.setattr(rb, '_complete_interrupt_cleanup', lambda: pytest.fail('must not mark clean'))
    out = tmp_path/'prep.json'; out.write_text(json.dumps({'original_catalog_price_limit_cents': 200,
                                    'effective_preparation_price_limit_cents': 200}))
    args = SimpleNamespace(owned_recording_preparation_seconds=100, owned_recording_preparation_out=str(out))
    with pytest.raises(asyncio.CancelledError, match='primary cancellation') as caught:
        asyncio.run(rb._run_owned_preparation('http://localhost:3100', rb.get_task_by_name('test-mass-agent-run-0'), args))
    assert 'unverified cleanup' in caught.value.__notes__[0]
    receipt = json.loads(out.read_text())
    assert receipt['state'] == 'INCOMPLETE' and 'unverified cleanup' in receipt['cleanup_error']


@pytest.mark.parametrize('price', [None, 1000])
def test_owned_preparation_local_dispatch_binds_native_owner_without_timeout_override(monkeypatch, tmp_path, price):
    import json
    from types import SimpleNamespace
    calls = []
    receipt = tmp_path/'recording-preparation.json'
    receipt.write_text(json.dumps({'mode': 'UNSCORED_RECORDING_PREPARATION', 'qualification': 'NOT_VALIDATION'}))
    stack = SimpleNamespace(isolated=True, context_dir=tmp_path, workspace_name='isolated')
    class Owner:
        signum = None
        def __init__(self): self.stack = stack
        def environment(self, env): calls.append(('owner', dict(env))); return env
        def bind(self, process): calls.append(('bound', process))
        def drain(self): return 0, 'Preparation evidence saved: '+str(receipt)
    owner = Owner()
    def recording(env, **kwargs):
        assert kwargs['isolated'] and not kwargs['simulate'] and kwargs['workspace'] == 'isolated'
        assert kwargs['fixture_database'] == 'fixture'
        env['BENCHMARK_WORLD_MODEL_MODE'] = 'real'
        calls.append(('recording', None))
        return True
    def spawn(command, **kwargs):
        assert '--owned-recording-preparation-seconds' in command
        assert ('--owned-recording-preparation-price-limit-cents' in command) == (price is not None)
        if price is not None:
            assert command[command.index('--owned-recording-preparation-price-limit-cents') + 1] == str(price)
        assert '--timeout-seconds' not in command and '--checkpoint' not in command
        assert kwargs['env']['BENCHMARK_WORLD_MODEL_MODE'] == 'real'
        assert kwargs['start_new_session'] is True
        return SimpleNamespace()
    monkeypatch.setattr(local_runner, 'benchmark_runner_env', lambda: {'DATABASE_URL': 'postgresql://test@localhost/fixture'})
    monkeypatch.setattr(local_runner, 'apply_owned_wmh_recording', recording)
    monkeypatch.setattr(local_runner.subprocess, 'Popen', spawn)
    result = local_runner.run_benchmark_invocation(
        local_runner.BenchmarkInvocation('preparation', ['test-mass-agent-run-0'], is_load=False),
        port=3100, bootstrap=True, anon=False, max_concurrency=1, owner=owner, preparation_seconds=100, preparation_price_limit_cents=price)
    assert result == receipt
    assert [event[0] for event in calls] == ['recording', 'owner', 'bound']
    assert owner.preparation_deadline > 0


def test_owned_preparation_archive_never_publishes_scored_metadata(monkeypatch):
    from unittest.mock import AsyncMock
    calls = []
    async def archive(*args, **kwargs):
        calls.append(kwargs)
        return 'original-archive-ref'
    monkeypatch.setattr(rb.cloud_batch_cleanup, 'contract', lambda: None)
    monkeypatch.setattr(rb, 'archive_agent_finalize', archive)
    monkeypatch.setattr(rb, 'evaluate_world_model_fidelity', AsyncMock(side_effect=AssertionError('preparation scored')))
    async def check():
        for status in ('ERROR', 'CANCELLED', 'PASSED'):
            ref, fidelity = await rb.finalize_archive_and_score_world_model(
                'http://localhost:3100', 'root', 'task', benchmark_passed=True,
                benchmark_status=status, failure_reason='original error', unscored_preparation=True)
            assert ref == 'original-archive-ref' and fidelity['status'] == 'not_applicable'
    asyncio.run(check())
    assert len(calls) == 3
    for call in calls:
        assert call['benchmark_passed'] is None
        assert call['benchmark_status'] == 'UNSCORED'
        assert call['failure_reason'] == 'original error'


def test_owned_preparation_missing_cost_is_not_zero():
    for data in ({}, {'agent': {}}, {'agent': {'tree_cost_cents': None}},
                 {'agent': {'tree_cost_cents': float('nan')}}, {'agent': {'tree_cost_cents': True}}):
        evidence = rb._preparation_cost_evidence(data)
        assert evidence['cents'] is None and evidence['coverage'] == 'unknown'
    assert rb._preparation_cost_evidence({'agent': {'tree_cost_cents': 0}}) == {
        'cents': 0, 'source': 'agent.tree_cost_cents', 'coverage': 'reported_snapshot'}


@pytest.mark.parametrize('price', [0, -1, 1001, True, False, 1.5, '1000'])
def test_preparation_price_rejects_invalid_bounds_before_launch(price):
    args = Namespace(owned_recording_preparation_seconds=3600,
                     owned_recording_preparation_price_limit_cents=price)
    with pytest.raises(ValueError):
        local_runner.validate_owned_preparation_options(args, ['test-mass-agent-run-0'])


def test_preparation_price_cli_requires_preparation_mode():
    args = local_runner.parse_args(['test-mass-agent-run-0',
        '--owned-recording-preparation-seconds', '3600',
        '--owned-recording-preparation-price-limit-cents', '1000'])
    local_runner.validate_owned_preparation_options(args, args.tasks)
    assert args.owned_recording_preparation_price_limit_cents == 1000
    args.owned_recording_preparation_seconds = None
    with pytest.raises(ValueError):
        local_runner.validate_owned_preparation_options(args, args.tasks)


@pytest.mark.parametrize('price, effective', [(None, 200), (1, 1), (1000, 1000)])
def test_preparation_price_reaches_actual_create_helper_without_mutating_task(monkeypatch, admitted_preparation_price, price, effective):
    import copy
    import json
    import httpx
    from benchmarks.results import TaskResult
    task = copy.copy(rb.get_task_by_name('test-mass-agent-run-0'))
    original = copy.deepcopy(vars(task))
    requests = []
    client = httpx.AsyncClient
    def response(request):
        requests.append(json.loads(request.content))
        return httpx.Response(201, json={'agent_id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'})
    transport = httpx.MockTransport(response)
    monkeypatch.setattr(rb.httpx, 'AsyncClient', lambda **kwargs: client(transport=transport, **kwargs))
    async def headers(): return {'Authorization': 'offline-fixture'}
    monkeypatch.setattr(rb, '_api_headers', headers)
    monkeypatch.setattr(rb, '_local_benchmark_task_queue', lambda base: 'owned-queue')
    monkeypatch.setattr(rb, '_resolve_write_lock_enabled', lambda task: None)
    monkeypatch.setattr(rb, '_benchmark_agent_source_override', lambda: None)
    async def execute(base, copied, *args):
        assert copied is not task
        aid = await rb.create_agent(base, copied)
        return TaskResult(name=copied.name, passed=False, agent_id=aid, status='COMPLETED',
            progress_score=1, duration_seconds=0, cost_cents=0, message_count=1, benchmark_status='UNSCORED')
    monkeypatch.setattr(rb, '_run_single_task_as_run_user', execute)
    scope = admitted_preparation_price(task, price=price) if price is not None else None
    asyncio.run(rb.run_single_task('http://localhost:3100', task,
        preparation_seconds=3600, preparation_price_limit_cents=price))
    if scope is not None:
        assert json.loads(scope.out.read_text())['state'] == 'EXECUTING'
        assert json.loads(scope.admission.read_text())['state'] == 'ADMITTED'
        with pytest.raises(ValueError, match='matching current native owned admission'):
            asyncio.run(rb.run_single_task('http://localhost:3100', task,
                preparation_seconds=3600, preparation_price_limit_cents=price))
    assert requests[0]['price_limit_cents'] == effective
    assert requests[0]['goal'] == task.prompt
    assert requests[0]['verifier'] == {'type': 'FLOAT_LLM_JUDGE'}
    assert 'start_phase' not in requests[0]
    assert vars(task) == original
    assert task.price_limit_cents == 200



def test_preparation_price_rejects_native_nonpreparation_and_changed_admission(monkeypatch, tmp_path):
    import json
    from types import SimpleNamespace
    task = rb.get_task_by_name('test-mass-agent-run-0')
    with pytest.raises(ValueError, match='explicit preparation mode'):
        asyncio.run(rb.run_single_task('http://localhost:3100', task, preparation_price_limit_cents=1000))
    out = tmp_path/'prep.json'
    out.write_text(json.dumps({'original_catalog_price_limit_cents': 200,
                              'effective_preparation_price_limit_cents': 1000}))
    args = SimpleNamespace(owned_recording_preparation_seconds=3600,
                           owned_recording_preparation_price_limit_cents=500,
                           owned_recording_preparation_out=str(out))
    async def unexpected(*args, **kwargs): pytest.fail('admission change reached task creation')
    monkeypatch.setattr(rb, 'run_single_task', unexpected)
    with pytest.raises(ValueError, match='differs from its admission receipt'):
        asyncio.run(rb._run_owned_preparation('http://localhost:3100', task, args))
    assert json.loads(out.read_text())['effective_preparation_price_limit_cents'] == 1000


@pytest.fixture
def admitted_preparation_price(monkeypatch, tmp_path):
    """Real manifest/receipt/native cleanup contract with only the DB read faked."""
    import hashlib
    import json
    from types import SimpleNamespace
    def admit(task, price=1000, seconds=3600):
        url = 'postgresql://test@localhost/victoria_wmh_recording_scope'
        manifest = tmp_path/'owner.json'
        manifest.write_text(json.dumps({'checkout': str(Path(__file__).resolve().parents[2]),
            'owner_workspace': 'isolated', 'database': 'victoria_wmh_recording_scope', 'host': 'localhost',
            'url_sha256': hashlib.sha256(url.encode()).hexdigest(), 'retained_across_iterations': True}))
        env = {'WMH_OWNED_RECORDING_CACHE_MANIFEST': str(manifest),
            'WMH_OWNED_RECORDING_CACHE_DATABASE_URL': url, 'DEMO_CACHE_DATABASE_URL': url,
            'FAST_MODE_CACHE_DATABASE_URL': url, 'DEMO_CACHE_RECORD_DEMO': '1',
            'FAST_MODE_CACHE_RECORD_DEMO': '1', 'DEMO_CACHE_DISABLE_WRITE_THROUGH': '0',
            'FAST_MODE_CACHE_DISABLE_WRITE_THROUGH': '0', 'BENCHMARK_ISOLATED_RUN': 'true',
            'BENCHMARK_WORLD_MODEL_MODE': 'real', 'CONDUCTOR_WORKSPACE_NAME': 'isolated',
            'DATABASE_URL': 'postgresql://test@localhost/victoria_fixture',
            'BENCHMARK_CLOUD_BATCH_CLEANUP': 'true', 'BENCHMARK_CONTEXT_DIR': str(tmp_path),
            'BENCHMARK_INTERRUPT_CLEANUP_TOKEN': 'native-owner-token',
            'BENCHMARK_INTERRUPT_CLEANUP_STATUS_FILE': str(tmp_path/'owner.status')}
        monkeypatch.setattr(os, 'environ', env)
        monkeypatch.setattr(rb, '_recording_cache_row_count', lambda url: 0)
        out = tmp_path/'recording-preparation.json'
        receipt = rb._admit_owned_preparation('http://localhost:3100', [task], seconds, out, price_limit_cents=price)
        monkeypatch.setattr(rb, '_INTERRUPT_CLEANUP_STARTED', 0)
        monkeypatch.setattr(rb, '_INTERRUPT_CLEANUP_COMPLETED', 0)
        rb._begin_interrupt_cleanup()
        # Point-of-use verification must not rerun one-use admission or a DB query.
        monkeypatch.setattr(rb, '_recording_cache_row_count', lambda url: pytest.fail('admission DB read repeated'))
        return SimpleNamespace(env=env, out=out, manifest=manifest,
            admission=Path(str(manifest)+'.preparation-admission.json'), receipt=receipt)
    return admit


@pytest.mark.parametrize('fault', ['unadmitted', 'remote', 'readonly', 'owner_token',
    'task', 'time', 'price', 'manifest', 'completed', 'missing_receipt',
    'owner_context', 'namespace', 'owner_finished', 'nonowned'])
def test_preparation_price_direct_entry_requires_matching_admission(monkeypatch, admitted_preparation_price, fault):
    import copy
    import json
    task = copy.copy(rb.get_task_by_name('test-mass-agent-run-0'))
    base = 'http://localhost:3100'
    if fault != 'unadmitted':
        scope = admitted_preparation_price(task)
        if fault == 'remote': base = 'https://api.roselabs.ai'
        elif fault == 'readonly': scope.env['BENCHMARK_DEMO_CACHE_READ_ONLY'] = '1'
        elif fault == 'owner_token': scope.env['BENCHMARK_INTERRUPT_CLEANUP_TOKEN'] = 'different-owner'
        elif fault == 'owner_context':
            scope.env['BENCHMARK_CONTEXT_DIR'] = str(scope.out.parent/'other-context')
            scope.env['BENCHMARK_INTERRUPT_CLEANUP_STATUS_FILE'] = str(scope.out.parent/'other-context'/'owner.status')
        elif fault == 'namespace':
            new_url = 'postgresql://test@localhost/victoria_wmh_recording_other'
            for key in ('WMH_OWNED_RECORDING_CACHE_DATABASE_URL', 'DEMO_CACHE_DATABASE_URL', 'FAST_MODE_CACHE_DATABASE_URL'):
                scope.env[key] = new_url
        elif fault == 'owner_finished':
            Path(scope.env['BENCHMARK_INTERRUPT_CLEANUP_STATUS_FILE']).write_text('version=1\ntoken=native-owner-token\nstate=clean\n')
        elif fault == 'nonowned': scope.env['BENCHMARK_CLOUD_BATCH_CLEANUP'] = 'false'
        elif fault == 'task': task.prompt += ' changed goal'
        elif fault == 'manifest': scope.manifest.write_text(scope.manifest.read_text()+'\n')
        elif fault == 'missing_receipt': scope.admission.unlink()
        elif fault == 'completed':
            saved=json.loads(scope.out.read_text()); saved['state']='FINISHED_UNQUALIFIED'; scope.out.write_text(json.dumps(saved))
        else:
            saved=json.loads(scope.admission.read_text())
            saved['budget_seconds' if fault == 'time' else 'effective_preparation_price_limit_cents'] = 100
            scope.admission.write_text(json.dumps(saved))
    else:
        monkeypatch.setattr(os, 'environ', {})
    async def execute(*args, **kwargs):
        pytest.fail('unadmitted direct entry reached the create-agent execution path')
    monkeypatch.setattr(rb, '_run_single_task_as_run_user', execute)
    with pytest.raises(ValueError):
        asyncio.run(rb.run_single_task(base, task, preparation_seconds=3600,
                                     preparation_price_limit_cents=1000))
