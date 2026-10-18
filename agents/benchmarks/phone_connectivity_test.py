"""Owning offline contract tests for the explicit-only live iPhone benchmark."""

import asyncio
import json
from argparse import Namespace

import httpx
import pytest

from benchmarks import phone_connectivity as phone


@pytest.fixture(autouse=True)
def synthetic_backend_key_loader(monkeypatch):
    # Offline tests never open the real private backend env file.
    monkeypatch.setattr(phone, "load_env_var", lambda *a, **kw: "synthetic-envelope-key")


def test_catalog_is_explicit_only():
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import resolve_tasks

    task = get_task_by_name(phone.TASK_NAME)
    assert task.status == "incomplete" and task.fast_cache == "off"
    assert task.environment["mode"] == "live"
    assert "PHONE_HARNESS_API_KEY" in task.environment["secrets"]
    args = Namespace(task=None, tasks=None, suite="all", prod=False, exclude_task=[])
    assert task.name not in [t.name for t in resolve_tasks(args)]
    args.task = [task.name]
    assert [t.name for t in resolve_tasks(args)] == [task.name]
    import inspect

    from benchmarks import run_benchmark as runner

    source = inspect.getsource(runner)
    assert "await apply_fixture(base_url, _current_benchmark_user_id(), API_KEY)" in source
    assert "evaluate_persisted, base_url, _current_benchmark_user_id(), agent_id" in source


@pytest.mark.parametrize(
    "url,user",
    [
        ("https://roselabs.ai", phone.ANDY),
        ("http://localhost:3001", "foreign"),
        ("http://user:pass@localhost:3001", phone.ANDY),
    ],
)
def test_fixture_refuses_wrong_backend_or_user(monkeypatch, url, user):
    monkeypatch.setenv("BENCHMARK_ISOLATED_RUN", "true")
    with pytest.raises(ValueError):
        phone.guard(url, user)


def test_missing_device_is_explicit(monkeypatch):
    monkeypatch.delenv("PHONE_HARNESS_DEVICE_ID", raising=False)
    with pytest.raises(ValueError, match="PHONE_HARNESS_DEVICE_ID"):
        phone.device_id()


def test_fixture_same_mapping_idempotent_and_collision_denied(monkeypatch):
    monkeypatch.setenv("BENCHMARK_ISOLATED_RUN", "true")
    monkeypatch.setenv("PHONE_HARNESS_DEVICE_ID", "synthetic-device")
    bound = []

    def backend(request):
        assert request.headers["x-user-id"] == phone.ANDY
        assert request.headers["x-api-key"] == "synthetic-backend"
        assert "PHONE_HARNESS_API_KEY" not in request.content.decode()
        if request.method == "PUT":
            device = json.loads(request.content)["providerDeviceId"]
            if bound and bound[0] != device:
                return httpx.Response(409)
            if not bound:
                bound.append(device)
            return httpx.Response(200, json={"device": {"id": "private-device"}})
        return httpx.Response(200, json={"enabled": True, "configured": True})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(backend)) as client:
            for _ in range(2):
                await phone.apply_fixture("http://localhost:3001", phone.ANDY, "synthetic-backend", client=client)
            monkeypatch.setenv("PHONE_HARNESS_DEVICE_ID", "different")
            with pytest.raises(RuntimeError, match="409"):
                await phone.apply_fixture("http://localhost:3001", phone.ANDY, "synthetic-backend", client=client)

    asyncio.run(run())
    assert bound == ["synthetic-device"]


@pytest.mark.parametrize(
    "evidence",
    [
        {},
        {"passed": True},
        {
            "userId": "foreign",
            "launchId": "a",
            "readId": "b",
            "heading": "Settings",
            "ordered": True,
            "attentionCount": 0,
        },
        {
            "userId": phone.ANDY,
            "launchId": "a",
            "readId": "b",
            "heading": "Settings",
            "ordered": False,
            "attentionCount": 0,
        },
    ],
)
def test_evaluator_refuses_missing_fabricated_or_wrong_scope(evidence):
    assert phone.check_proof(evidence)[0] is False


def test_evaluator_accepts_only_sanitized_persisted_proof():
    proof = {
        "source": "persisted-iphone-commands-v1",
        "userId": phone.ANDY,
        "rootAgentId": "root",
        "launchId": "launch",
        "readId": "read",
        "heading": "Settings",
        "ordered": True,
        "attentionCount": 0,
        "allCommandsAllowed": True,
    }
    assert phone.check_proof(proof, "root")[0]
    for key, value in [
        ("attentionCount", 1),
        ("allCommandsAllowed", False),
        ("heading", ""),
        ("rootAgentId", "foreign"),
    ]:
        assert not phone.check_proof({**proof, key: value}, "root")[0]


def test_private_checker_failure_is_safe_and_provider_key_not_forwarded(monkeypatch):
    from types import SimpleNamespace

    monkeypatch.setenv("BENCHMARK_ISOLATED_RUN", "true")
    monkeypatch.setenv("PHONE_HARNESS_DEVICE_ID", "synthetic-device")
    monkeypatch.setenv("PHONE_HARNESS_API_KEY", "CANARY-KEY")

    def child(command, **kwargs):
        assert "PHONE_HARNESS_API_KEY" not in kwargs["env"]
        assert kwargs["env"]["PHONE_BENCH_AGENT_ID"] == "root"
        return SimpleNamespace(returncode=1, stdout="", stderr="CANARY-KEY private OCR")

    monkeypatch.setattr(phone.subprocess, "run", child)
    passed, reason, proof = phone.evaluate_persisted(
        "http://localhost:3001", phone.ANDY, "root", "postgresql://localhost/victoria_test"
    )
    assert not passed and proof is None and "CANARY" not in reason


def test_live_overlay_targets_selected_andy_before_phone_binding(monkeypatch):
    import inspect
    from unittest.mock import AsyncMock

    from benchmarks import run_benchmark as runner
    from benchmarks.benchmark_tasks import get_task_by_name

    task = get_task_by_name(phone.TASK_NAME)
    assert task.environment.get("live_fixtures") == ["live"]
    source = inspect.getsource(runner)
    bind = source.index("await apply_fixture(base_url, _current_benchmark_user_id(), API_KEY)")
    overlay = source.rfind("live_fixture_manifests = await _apply_live_fixtures(task, base_url)", 0, bind)
    assert overlay >= 0, "device binding must follow normal identity overlay"
    monkeypatch.setenv("BENCHMARK_RUN_USER_ID", phone.ANDY)
    monkeypatch.setattr(runner, "_has_usable_anthropic_api_key_fallback", AsyncMock(return_value=True))
    observed = []
    monkeypatch.setitem(
        runner.LIVE_FIXTURE_APPLIERS, "live", lambda ctx: observed.append(ctx.user_id) or {"identity_ready": True}
    )
    asyncio.run(runner._apply_live_fixtures(task, "http://localhost:3001"))
    assert observed == [phone.ANDY]


def test_documented_private_receipts_and_ocr_shapes():
    import subprocess
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]

    def check(rows, heading="Paired Computers"):
        script = "const fs=require('node:fs');const {checkReceipts}=require('../agents/benchmarks/phone_connectivity_receipts.ts');const x=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(checkReceipts(x.rows,x.scope,x.heading)))"
        scope = {"userId": phone.ANDY, "rootAgentId": "root", "agentIds": ["root"], "deviceId": "device"}
        result = subprocess.run(
            ["node", "--import", "tsx", "-e", script],
            cwd=root / "back-end",
            input=json.dumps({"rows": rows, "scope": scope, "heading": heading}),
            capture_output=True,
            text=True,
            check=True,
        )
        return json.loads(result.stdout)

    common = {
        "userId": phone.ANDY,
        "agentId": "root",
        "deviceId": "device",
        "leaseId": "lease",
        "actor": "agent",
        "state": "SUCCEEDED",
    }
    launch = {
        **common,
        "id": "launch",
        "cursor": 1,
        "operation": "apps.launch",
        "request": {"operation": "apps.launch", "actor": "agent", "args": {"name": "Settings"}},
        "result": "com.apple.Preferences",
        "createdAt": 1,
        "completedAt": 2,
    }
    read = {
        **common,
        "id": "read",
        "cursor": 2,
        "operation": "screen.text",
        "result": [
            {"text": "Paired Computers", "confidence": 0.99, "source": "pixels", "x": 190, "y": 90, "w": 170, "h": 24}
        ],
        "createdAt": 3,
        "completedAt": 4,
    }
    assert check([launch, read])["heading"] == "Paired Computers"
    assert check([{**launch, "result": False}, read])["heading"] is None
    assert check([launch, {**read, "result": {"error": {"text": "Settings"}}}], "Settings")["heading"] is None
    for key, value in [
        ("userId", "foreign"),
        ("leaseId", "foreign"),
        ("deviceId", "foreign"),
        ("cursor", 1),
        ("createdAt", 1),
        ("state", "FAILED"),
    ]:
        assert check([launch, {**read, key: value}])["heading"] is None
    home = {
        **common,
        "id": "home",
        "cursor": 0,
        "operation": "nav.home",
        "createdAt": 0,
        "completedAt": 1,
        "result": True,
    }
    assert check([home, launch, read])["heading"] == "Paired Computers"
    assert not check([launch, {**read, "operation": "input.text"}])["allCommandsAllowed"]


def test_final_report_matches_actual_ocr_heading_without_settings_assumption(monkeypatch):
    import inspect
    from types import SimpleNamespace

    from benchmarks import run_benchmark as runner

    data = {
        "messages": [
            {
                "text": "Task complete",
                "metadata": {
                    "toolName": "completion_summary",
                    "toolStatus": "FINISHED",
                    "completionSummary": {"summary": "Visible heading: Paired Computers", "outputs": []},
                },
            }
        ]
    }
    assert phone.reported_heading(data) == "Paired Computers"
    assert (
        phone.reported_heading({"messages": [{"role": "ASSISTANT", "text": "Visible heading: Paired Computers"}]}) == ""
    )
    assert "Final answer did not report the observed Settings heading" not in inspect.getsource(runner)
    monkeypatch.setenv("BENCHMARK_ISOLATED_RUN", "true")
    monkeypatch.setenv("PHONE_HARNESS_DEVICE_ID", "device")
    proof = {
        "source": "persisted-iphone-commands-v1",
        "userId": phone.ANDY,
        "rootAgentId": "root",
        "launchId": "launch",
        "readId": "read",
        "heading": "Paired Computers",
        "ordered": True,
        "attentionCount": 0,
        "allCommandsAllowed": True,
    }
    monkeypatch.setattr(
        phone.subprocess, "run", lambda *a, **kw: SimpleNamespace(returncode=0, stdout=json.dumps(proof))
    )
    assert phone.evaluate_persisted(
        "http://localhost:3001", phone.ANDY, "root", "postgresql://localhost/victoria_test", "Paired Computers"
    )[0]
    assert not phone.evaluate_persisted(
        "http://localhost:3001", phone.ANDY, "root", "postgresql://localhost/victoria_test", "Settings"
    )[0]


def test_checker_loads_only_backend_envelope_key(monkeypatch):
    from types import SimpleNamespace

    monkeypatch.setenv("BENCHMARK_ISOLATED_RUN", "true")
    monkeypatch.setenv("PHONE_HARNESS_DEVICE_ID", "device")
    monkeypatch.delenv("CLAUDE_CREDENTIAL_DECRYPTION_KEY", raising=False)
    seen = []
    monkeypatch.setattr(
        phone, "load_env_var", lambda name, *paths, **kw: seen.append((name, paths)) or "synthetic-envelope-key"
    )

    def child(*args, **kw):
        assert kw["env"]["CLAUDE_CREDENTIAL_DECRYPTION_KEY"] == "synthetic-envelope-key"
        assert "PHONE_HARNESS_API_KEY" not in kw["env"]
        return SimpleNamespace(returncode=1, stdout="", stderr="private")

    monkeypatch.setattr(phone.subprocess, "run", child)
    phone.evaluate_persisted("http://localhost:3001", phone.ANDY, "root", "postgresql://localhost/victoria_test")
    assert seen == [("CLAUDE_CREDENTIAL_DECRYPTION_KEY", (str(phone.ROOT / "back-end" / ".env"),))]


def test_cleanup_requires_idle_proof_and_owned_lease(monkeypatch):
    monkeypatch.setenv("BENCHMARK_ISOLATED_RUN", "true")
    monkeypatch.setenv("PHONE_HARNESS_DEVICE_ID", "device")
    states = iter(
        [
            {"owned": True, "leases": [{"id": "owned", "status": "ACTIVE"}], "idle": False, "foreignLive": False},
            {"owned": True, "leases": [{"id": "owned", "status": "RELEASED"}], "idle": False, "foreignLive": False},
            {"owned": True, "leases": [{"id": "owned", "status": "RELEASED"}], "idle": True, "foreignLive": False},
        ]
    )
    monkeypatch.setattr(phone, "cleanup_snapshot", lambda *args: next(states))
    calls = []

    def backend(request):
        calls.append((request.method, request.url.path))
        return httpx.Response(200, json={"lease": {"id": "owned", "status": "RELEASED"}})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(backend)) as client:
            result = await phone.cleanup_phone(
                "http://localhost:3001",
                phone.ANDY,
                "root",
                "postgresql://localhost/victoria_test",
                "key",
                client=client,
                poll_seconds=0,
            )
            assert result == {"cleanupComplete": True, "leaseCount": 1}

    asyncio.run(run())
    assert calls.count(("POST", "/api/iphone/leases/owned/release")) == 2


@pytest.mark.parametrize(
    "snapshot",
    [
        {"owned": False, "leases": [], "idle": True, "foreignLive": False},
        {"owned": True, "leases": [], "idle": False, "foreignLive": True},
    ],
)
def test_cleanup_never_releases_missing_or_foreign_root(monkeypatch, snapshot):
    monkeypatch.setenv("BENCHMARK_ISOLATED_RUN", "true")
    monkeypatch.setenv("PHONE_HARNESS_DEVICE_ID", "device")
    monkeypatch.setattr(phone, "cleanup_snapshot", lambda *args: snapshot)

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(lambda request: pytest.fail("foreign release"))
        ) as client:
            with pytest.raises(phone.PhoneCleanupBlocked):
                await phone.cleanup_phone(
                    "http://localhost:3001",
                    phone.ANDY,
                    "root",
                    "postgresql://localhost/victoria_test",
                    "key",
                    client=client,
                    poll_seconds=0,
                )

    asyncio.run(run())


def test_cleanup_hooks_precede_deletion_and_preserve_owner_receipt():
    import inspect

    from benchmarks import run_benchmark as runner
    from benchmarks.benchmark_tasks import get_task_by_name

    source = inspect.getsource(runner._run_single_task_as_run_user)
    assert "await ensure_phone_cleanup()\n        await delete_agent(base_url, agent_id)" in source
    assert source.count("await delete_agent(base_url, agent_id)") == 1
    assert "finally:\n        # Failure/cancellation/kept-agent paths" in source
    assert "phone_cleanup_receipt_started = _begin_interrupt_cleanup()" in source
    assert source.index("await ensure_phone_cleanup()\n\n        # Evaluation is complete") < source.index(
        "# Evaluation is complete"
    )
    assert "await cleanup_phone(base_url, ANDY, phone_root" in inspect.getsource(runner._finalize_owned_cloud_batch)
    assert get_task_by_name(phone.TASK_NAME).min_steps == {"browser": 3}


@pytest.mark.parametrize("status", [404, 403, 500])
def test_cleanup_refusal_is_blocked_not_acknowledged(monkeypatch, status):
    monkeypatch.setenv("BENCHMARK_ISOLATED_RUN", "true")
    monkeypatch.setenv("PHONE_HARNESS_DEVICE_ID", "device")
    monkeypatch.setattr(
        phone,
        "cleanup_snapshot",
        lambda *args: {
            "owned": True,
            "leases": [{"id": "owned", "status": "ACTIVE"}],
            "idle": False,
            "foreignLive": False,
        },
    )

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(status))) as client:
            with pytest.raises(phone.PhoneCleanupBlocked):
                await phone.cleanup_phone(
                    "http://localhost:3001",
                    phone.ANDY,
                    "root",
                    "postgresql://localhost/victoria_test",
                    "key",
                    client=client,
                    poll_seconds=0,
                )

    asyncio.run(run())


def test_injected_envelope_key_wins_without_opening_file(monkeypatch):
    from benchmarks.logs import load_env_var

    monkeypatch.setenv("CLAUDE_CREDENTIAL_DECRYPTION_KEY", "synthetic-injected")
    import builtins

    monkeypatch.setattr(
        builtins, "open", lambda *a, **kw: pytest.fail("must not read backend file for injected override")
    )
    assert (
        load_env_var("CLAUDE_CREDENTIAL_DECRYPTION_KEY", str(phone.ROOT / "back-end" / ".env")) == "synthetic-injected"
    )


def test_real_finished_completion_summary_card_parser():
    card = {
        "text": "Task complete",
        "role": "TOOL",
        "metadata": {
            "toolName": "completion_summary",
            "toolStatus": "FINISHED",
            "completionSummary": {"summary": "Visible heading: Paired Computers", "outputs": []},
        },
    }
    assert phone.reported_heading({"messages": [card]}) == "Paired Computers"
    for status in ("IN_PROGRESS", "ERROR", "REJECTED"):
        rejected = {**card, "metadata": {**card["metadata"], "toolStatus": status}}
        assert phone.reported_heading({"messages": [rejected]}) == ""
    attempt = {**card, "metadata": {**card["metadata"], "toolName": "attempt_completion"}}
    assert phone.reported_heading({"messages": [attempt]}) == ""
