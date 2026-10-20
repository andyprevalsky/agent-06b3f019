"""Blackbox tests for the code-agent run target (C14: cloud vs the user's Mac).

Observable surface:
  - spawn_agent(type='code') declares ``target: 'cloud' | 'local'`` (default cloud)
    and forwards it to the code-agent manager.
  - Cloud (default) is unchanged: no target lookup, the pre-C14 activity args.
  - Local resolves the Mac once, then schedules the same activity with the Mac's
    identity; chip metadata carries ``code_agent.target`` / ``device_name``.
  - A closed/disconnected Mac, or an agent not started from the Mac app, fails
    the tool call immediately with the exact C14 text: no activity, no retry,
    no cloud fallback. A Mac lost between check and create maps to the same text.
"""

import asyncio
import json
import re
from pathlib import Path
from unittest.mock import AsyncMock, patch

from _test_utils import BlackboxResult, assert_captured_call, get_captured_requests, setup_mock, teardown_mock
from temporalio.exceptions import ActivityError, ApplicationError, RetryState

REPO_ROOT = Path(__file__).resolve().parents[3]
DEVICE = "Andy's MacBook Pro"
DISCONNECTED = (
    "Can't run locally: the Rose Mac app on Andy's MacBook Pro is closed or disconnected. "
    "Open the Rose Mac app and retry, or run this agent in the cloud."
)
WEB_ORIGIN = (
    "Local runs need an agent started from the Rose Mac app. "
    "Start this agent from the Mac app, or run it in the cloud."
)
SCHEMA = {"fields": [{"name": "summary", "type": "str", "description": "What changed", "required": True}]}


class _Handle:
    def __init__(self, result=None, raise_exc=None):
        self._result = result
        self._raise_exc = raise_exc

    def done(self):
        return True

    def cancel(self):
        pass

    def __await__(self):
        async def _inner():
            if self._raise_exc is not None:
                raise self._raise_exc
            return self._result

        return _inner().__await__()


class _Workflow:
    """Stand-in for temporalio.workflow inside the code-agent handler."""

    class ActivityCancellationType:
        TRY_CANCEL = "TRY_CANCEL"
        WAIT_CANCELLATION_COMPLETED = "WAIT_CANCELLATION_COMPLETED"

    def __init__(self, handle, target_result=None):
        self._handle = handle
        self._target_result = target_result
        self.started = []
        self.executed = []

    def start_activity(self, fn, args=None, **kwargs):
        self.started.append((fn.__name__, list(args or []), kwargs))
        return self._handle

    async def wait_condition(self, predicate):
        return None

    async def execute_activity(self, fn, args=None, **kwargs):
        self.executed.append((fn.__name__, list(args or []), kwargs))
        if fn.__name__ == "resolve_code_agent_provider_activity":
            return args[0]
        if fn.__name__ == "resolve_code_agent_target_activity":
            assert self._target_result is not None, "cloud runs must never look up a local target"
            return self._target_result
        raise AssertionError(f"unexpected activity {fn.__name__}")


class _Instance:
    def __init__(self):
        self.user_id = "u-1"
        self.agent_id = "agent-local"
        self.model = "rose-labs/rose-1-flash"
        self.is_paused = False


def _patch_workflow(fake):
    import domains.spawn_claude_code_agent.handler as handler

    original = handler.workflow
    handler.workflow = fake
    return lambda: setattr(handler, "workflow", original)


async def _run(tool_call, fake):
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager

    restore = _patch_workflow(fake)
    try:
        return [e async for e in SpawnClaudeCodeAgentManager().execute_tool(_Instance(), tool_call, "tc-local")]
    finally:
        restore()


def _ok_result(**extra):
    return {"success": True, "message": "done", "task_id": "t-1", "output_files": [], **extra}


def _available(device_id="dev-1", device_name=DEVICE):
    return {
        "target": "local",
        "available": True,
        "reason": None,
        "device_id": device_id,
        "device_name": device_name,
        "error": None,
    }


def _unavailable(reason, device_name=None, device_id=None):
    from domains.spawn_claude_code_agent.service_target import local_target_error

    return {
        "target": "local",
        "available": False,
        "reason": reason,
        "device_id": device_id,
        "device_name": device_name,
        "error": local_target_error(reason, device_name),
    }


# ── tool schema ─────────────────────────────────────────────────────────


def test_spawn_agent_schemas_declare_target_default_cloud():
    """Both code-capable spawn_agent schemas take target cloud|local, default cloud, one sentence."""
    from utils.tool_schemas import SpawnAgentTool, SpawnAgentToolNoGP

    for model in (SpawnAgentTool, SpawnAgentToolNoGP):
        field = model.model_fields["target"]
        assert field.default == "cloud", model.__name__
        schema = model.model_json_schema()["properties"]["target"]
        enum = next(option["enum"] for option in schema["anyOf"] if "enum" in option)
        assert enum == ["cloud", "local"], (model.__name__, schema)
        sentences = [s for s in re.split(r"(?<=\.)\s+", field.description.strip()) if s]
        assert len(sentences) == 1, field.description
        parsed = model.model_validate(
            {"tool": "spawn_agent", "type": "code", "goal": "g", "output_schema": SCHEMA, "target": "local"}
        )
        assert parsed.target == "local"
        assert model.model_validate({"tool": "spawn_agent", "type": "code", "goal": "g", "output_schema": SCHEMA}).target == "cloud"


async def test_spawn_agent_forwards_target_to_code_manager():
    """spawn_agent(type='code', target='local') hands target to the code-agent manager."""
    from domains.spawn_agent import handler as spawn_handler

    seen = {}

    class _Manager:
        async def execute_tool(self, workflow_instance, tool_call, tool_call_id):
            seen.update(tool_call)
            if False:
                yield None

    instance = _Instance()
    instance.world_model_mode = "real"
    with patch.object(spawn_handler, "get_code_manager", lambda: _Manager()):
        manager = spawn_handler.SpawnAgentManager()
        async for _ in manager._spawn_code(
            instance, {"type": "code", "goal": "g", "output_schema": SCHEMA, "target": "local"}, "tc"
        ):
            pass
    assert seen["target"] == "local", seen
    assert seen["tool"] == "spawn_claude_code_agent"


# ── routing ─────────────────────────────────────────────────────────────


async def test_cloud_default_is_unchanged():
    """No target: no Mac lookup, the exact pre-C14 activity arguments, cloud metadata."""
    from tools.base import MessageStatus

    fake = _Workflow(_Handle(result=_ok_result()))
    events = await _run({"goal": "fix", "output_schema": SCHEMA}, fake)

    assert [name for name, _, _ in fake.executed] == ["resolve_code_agent_provider_activity"]
    assert len(fake.started) == 1
    name, args, _ = fake.started[0]
    assert name == "spawn_claude_code_activity"
    assert len(args) == 16 and args[15] is None, args
    starting = events[0]
    assert starting.title == "Starting Claude Code sandbox"
    assert starting.metadata["code_agent"] == {"target": "cloud"}
    finished = [e for e in events if getattr(e, "status", None) == MessageStatus.FINISHED][0]
    assert finished.metadata["code_agent"] == {"target": "cloud"}


async def test_explicit_cloud_target_matches_default():
    fake = _Workflow(_Handle(result=_ok_result()))
    await _run({"goal": "fix", "output_schema": SCHEMA, "target": "cloud"}, fake)
    assert [name for name, _, _ in fake.executed] == ["resolve_code_agent_provider_activity"]
    assert len(fake.started[0][1]) == 16


async def test_local_routes_to_the_mac():
    """target='local' resolves the Mac once and runs the same activity with its identity."""
    from tools.base import MessageStatus

    folder_meta = {"target": "local", "device_name": DEVICE, "folder": "~/Developer/rose"}
    fake = _Workflow(_Handle(result=_ok_result(code_agent=folder_meta)), target_result=_available())
    events = await _run({"goal": "fix", "output_schema": SCHEMA, "target": "local"}, fake)

    lookups = [args for name, args, _ in fake.executed if name == "resolve_code_agent_target_activity"]
    assert lookups == [["agent-local", "local"]]
    target_kwargs = [kw for name, _, kw in fake.executed if name == "resolve_code_agent_target_activity"][0]
    assert target_kwargs["retry_policy"].maximum_attempts == 2
    name, args, _ = fake.started[0]
    assert name == "spawn_claude_code_activity"
    assert args[16:] == ["local", "dev-1", DEVICE], args
    assert events[0].title == f"Starting code agent on {DEVICE}"
    assert events[0].metadata["code_agent"] == {"target": "local", "device_name": DEVICE}
    finished = [e for e in events if getattr(e, "status", None) == MessageStatus.FINISHED][0]
    assert finished.metadata["code_agent"] == folder_meta


async def test_disconnected_mac_fails_immediately_with_exact_error():
    """A closed Mac app: one ERROR event with the exact text; nothing scheduled, no fallback."""
    from tools.base import MessageStatus

    fake = _Workflow(_Handle(result=_ok_result()), target_result=_unavailable("device_disconnected", DEVICE, "dev-1"))
    events = await _run({"goal": "fix", "output_schema": SCHEMA, "target": "local"}, fake)

    assert fake.started == [], "a disconnected Mac must not start any code session"
    assert [name for name, _, _ in fake.executed] == ["resolve_code_agent_target_activity"]
    assert len(events) == 1
    event = events[0]
    assert event.status == MessageStatus.ERROR
    assert event.message == DISCONNECTED
    assert event.metadata["code_agent"] == {"target": "local", "device_name": DEVICE}
    assert event.metadata["error_code"] == "LOCAL_TARGET_UNAVAILABLE"


async def test_web_started_agent_asking_local_gets_exact_error():
    from tools.base import MessageStatus

    fake = _Workflow(_Handle(result=_ok_result()), target_result=_unavailable("not_mac_origin"))
    events = await _run({"goal": "fix", "output_schema": SCHEMA, "target": "local"}, fake)

    assert fake.started == []
    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert events[0].message == WEB_ORIGIN
    assert events[0].metadata["code_agent"] == {"target": "local"}


async def test_mac_lost_between_check_and_create_maps_to_exact_error():
    """The create path's non-retryable 409 surfaces verbatim, never soft-failed or retried."""
    from tools.base import MessageStatus

    cause = ApplicationError(
        DISCONNECTED,
        {"reason": "device_disconnected", "device_name": DEVICE},
        type="LOCAL_TARGET_UNAVAILABLE",
        non_retryable=True,
    )
    error = ActivityError(
        "Activity task failed",
        scheduled_event_id=1,
        started_event_id=2,
        identity="w",
        activity_type="spawn_claude_code_activity",
        activity_id="1",
        retry_state=RetryState.NON_RETRYABLE_FAILURE,
    )
    error.__cause__ = cause
    fake = _Workflow(_Handle(raise_exc=error), target_result=_available())
    events = await _run({"goal": "fix", "output_schema": SCHEMA, "target": "local"}, fake)

    terminal = events[-1]
    assert terminal.status == MessageStatus.ERROR
    assert terminal.message == DISCONNECTED
    assert terminal.metadata["code_agent"] == {"target": "local", "device_name": DEVICE}
    assert len(fake.started) == 1


async def test_reattach_keeps_the_mac_without_a_new_lookup():
    """A parked local session reattaches to the same Mac; the target is not re-resolved."""
    from domains.spawn_claude_code_agent import handler

    session = {
        "task_id": "t-9",
        "sandbox_id": "mac-dev-1-t-9",
        "ws_url": "wss://backend/api/local-code-relay/t-9?token=x",
        "code_provider": "claude",
        "target": "local",
        "device_id": "dev-1",
        "device_name": DEVICE,
    }
    fake = _Workflow(_Handle(result=_ok_result()))
    with patch.object(handler, "take_tool_resume", lambda wf, tc: {"code_session": session}):
        await _run({"goal": "fix", "output_schema": SCHEMA, "target": "local"}, fake)
    assert [name for name, _, _ in fake.executed] == []
    args = fake.started[0][1]
    assert args[15] == session
    assert args[16:] == ["local", "dev-1", DEVICE]


# ── target activity + backend mapping ───────────────────────────────────


def test_exact_strings_and_reason_mapping():
    from domains.spawn_claude_code_agent.service_target import local_target_error, target_from_backend

    assert local_target_error("device_disconnected", DEVICE) == DISCONNECTED
    assert local_target_error("not_mac_origin", None) == WEB_ORIGIN
    ok = target_from_backend({"available": True, "device_id": "dev-1", "device_name": DEVICE})
    assert ok == _available()
    down = target_from_backend({"available": False, "reason": "device_disconnected", "device_id": "dev-1", "device_name": DEVICE})
    assert down["error"] == DISCONNECTED and down["available"] is False
    web = target_from_backend({"available": False, "reason": "not_mac_origin"})
    assert web["error"] == WEB_ORIGIN


async def test_target_activity_cloud_skips_backend():
    from domains.spawn_claude_code_agent.service_target import resolve_code_agent_target_activity

    setup_mock({})
    result = await resolve_code_agent_target_activity("agent-1", "cloud")
    assert result["target"] == "cloud" and result["available"] is True
    assert get_captured_requests() == []


async def test_target_activity_asks_backend_for_local():
    from domains.spawn_claude_code_agent.service_target import resolve_code_agent_target_activity

    setup_mock(
        {
            "/api/local-devices/agent-target/agent-1": {
                "status": 200,
                "json": {"available": False, "reason": "device_disconnected", "device_id": "dev-1", "device_name": DEVICE},
            }
        }
    )
    result = await resolve_code_agent_target_activity("agent-1", "local")
    assert result["error"] == DISCONNECTED
    assert_captured_call(url_contains="/api/local-devices/agent-target/agent-1", method="GET", header_present="x-api-key")


async def test_repo_local_create_sends_target_and_maps_409():
    """Local create sends target + device and never forwards a clone URL; 409 is non-retryable."""
    from domains.spawn_claude_code_agent.repo import create_e2b_session

    setup_mock(
        {
            "/api/claude-code-session/create": {
                "status": 409,
                "json": {
                    "code": "LOCAL_TARGET_UNAVAILABLE",
                    "reason": "device_disconnected",
                    "device_name": DEVICE,
                    "error": DISCONNECTED,
                },
            }
        }
    )
    try:
        await create_e2b_session(
            agent_id="agent-1",
            goal="fix",
            user_id="u1",
            github_repo_url="https://github.com/a/b",
            target="local",
            local_device_id="dev-1",
        )
        raise AssertionError("expected LOCAL_TARGET_UNAVAILABLE")
    except ApplicationError as error:
        assert error.type == "LOCAL_TARGET_UNAVAILABLE"
        assert error.non_retryable is True
        assert error.message == DISCONNECTED
    body = json.loads(get_captured_requests()[0]["requestBody"])
    assert body["target"] == "local" and body["device_id"] == "dev-1"
    assert "github_repo_url" not in body


async def test_activity_records_local_target_on_session_and_messages():
    """The activity passes the Mac to session create and tags chip messages with code_agent."""
    from domains.spawn_claude_code_agent import service

    seen_create = {}
    saved = []

    async def fake_create(**kwargs):
        seen_create.update(kwargs)
        return {
            "task_id": "t-1",
            "sandbox_id": "mac-dev-1-t-1",
            "ws_url": "wss://relay",
            "uploaded_files": [],
            "folder": "~/Developer/rose",
        }

    async def fake_save(**kwargs):
        saved.append(kwargs)

    collector = AsyncMock()
    with (
        patch.object(service, "SandboxLogCollector", lambda *a, **kw: collector),
        patch.object(service, "create_e2b_session", side_effect=fake_create),
        patch.object(service, "save_claude_code_message", side_effect=fake_save),
        patch.object(service, "_run_agentic_loop", AsyncMock(return_value=(0, False, [], 0, 0, []))),
        patch.object(service, "_run_verifier", AsyncMock(return_value=(1.0, "ok", {"summary": "x"}, 0, 0))),
        patch.object(service, "persist_terminal_output", AsyncMock()),
        patch.object(service, "close_e2b_session", AsyncMock(return_value={"output_files": []})),
        patch.object(service, "_resolve_claude_token_for_activity", AsyncMock(return_value=None)),
        patch("helpers.model_pricing.get_model_pricing_with_fallback", AsyncMock(return_value={})),
        patch("temporalio.activity.heartbeat"),
    ):
        result = await service.spawn_claude_code_activity(
            user_id="u",
            agent_id="a",
            goal="fix",
            tool_call_id="tc",
            output_schema=SCHEMA,
            target="local",
            local_device_id="dev-1",
            local_device_name=DEVICE,
        )
    assert result["status"] == "completed"
    assert seen_create["target"] == "local" and seen_create["local_device_id"] == "dev-1"
    expected_meta = {"target": "local", "device_name": DEVICE, "folder": "~/Developer/rose"}
    assert saved and all(s["code_agent"] == expected_meta for s in saved), saved
    assert result["code_agent"] == expected_meta


async def test_save_message_merges_code_agent_metadata():
    from domains.spawn_claude_code_agent.repo import save_claude_code_message
    from tools.base import MessageStatus

    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    await save_claude_code_message(
        agent_id="a",
        title="t",
        message="m",
        status=MessageStatus.IN_PROGRESS,
        task_id="t-1",
        is_init_message=True,
        code_agent={"target": "local", "device_name": DEVICE},
    )
    body = json.loads(get_captured_requests()[0]["requestBody"])
    assert body["metadata"]["code_agent"] == {"target": "local", "device_name": DEVICE}


# ── cross-language + registration guards ────────────────────────────────


def test_messages_match_backend_templates():
    """The worker's exact strings equal the backend's (one product text, two runtimes)."""
    from domains.spawn_claude_code_agent import config

    source = (REPO_ROOT / "back-end" / "src" / "providers" / "localDevices" / "messages.ts").read_text()
    assert f"'{config.LOCAL_TARGET_NOT_MAC_ORIGIN_MESSAGE}'" in source.replace('"', "'") or (
        config.LOCAL_TARGET_NOT_MAC_ORIGIN_MESSAGE in source
    )
    disconnected_ts = config.LOCAL_TARGET_DISCONNECTED_TEMPLATE.replace("{device_name}", "${deviceName}")
    assert disconnected_ts in source, disconnected_ts
    assert f"'{config.LOCAL_TARGET_NOT_MAC_ORIGIN}'" in source
    assert f"'{config.LOCAL_TARGET_DEVICE_DISCONNECTED}'" in source


def test_target_activity_registered_with_worker():
    worker = (REPO_ROOT / "agents" / "worker.py").read_text()
    assert worker.count("resolve_code_agent_target_activity") >= 2


async def run_all_tests():
    print("code-agent-local-target blackbox tests:")
    r = BlackboxResult()
    r.record("spawn_agent_schemas_declare_target", test_spawn_agent_schemas_declare_target_default_cloud)
    await r.record_async("spawn_agent_forwards_target", test_spawn_agent_forwards_target_to_code_manager)
    await r.record_async("cloud_default_unchanged", test_cloud_default_is_unchanged)
    await r.record_async("explicit_cloud_matches_default", test_explicit_cloud_target_matches_default)
    await r.record_async("local_routes_to_mac", test_local_routes_to_the_mac)
    await r.record_async("disconnected_mac_exact_error", test_disconnected_mac_fails_immediately_with_exact_error)
    await r.record_async("web_origin_exact_error", test_web_started_agent_asking_local_gets_exact_error)
    await r.record_async("mac_lost_before_create_exact_error", test_mac_lost_between_check_and_create_maps_to_exact_error)
    await r.record_async("reattach_keeps_mac", test_reattach_keeps_the_mac_without_a_new_lookup)
    r.record("exact_strings_and_mapping", test_exact_strings_and_reason_mapping)
    await r.record_async("target_activity_cloud_skips_backend", test_target_activity_cloud_skips_backend)
    await r.record_async("target_activity_local_asks_backend", test_target_activity_asks_backend_for_local)
    await r.record_async("repo_local_create_and_409", test_repo_local_create_sends_target_and_maps_409)
    await r.record_async("activity_records_local_target", test_activity_records_local_target_on_session_and_messages)
    await r.record_async("save_message_code_agent_metadata", test_save_message_merges_code_agent_metadata)
    r.record("messages_match_backend", test_messages_match_backend_templates)
    r.record("target_activity_registered", test_target_activity_registered_with_worker)
    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
