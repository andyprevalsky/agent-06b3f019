"""Blackbox tests for user-authored tools (domains/user_tools).

The backend (`GET /api/user-ui/active` + published files under `baseUrl`) is
mocked through the httpx capture harness; handlers run as real subprocesses.
"""

import asyncio
import contextlib
import json
import os
import shutil
import tempfile
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from unittest.mock import AsyncMock, patch

import httpx
from _test_utils import BlackboxResult, setup_mock_fn, teardown_mock

# USER_A is a Rose Desktop account (utils.rose_desktop): user tools come from the
# Rose Desktop rose_user_ui, so only flagged root agents pin them.
USER_A = "1f85ff25-6e29-4c1b-8739-f917bd101a30"
USER_B = "user-b-2222"
STOCK_USER = "user-stock-3333"
CDN = "https://usercontent.test"

PY_ECHO = """
import json, sys
data = json.load(sys.stdin)
print(json.dumps({"city": data["city"], "temp_f": 71, "version": "v1"}))
"""
PY_ECHO_V2 = PY_ECHO.replace('"version": "v1"', '"version": "v2"')
PY_BAD_OUTPUT = """
import json, sys
json.load(sys.stdin)
print(json.dumps({"city": 42}))
"""
PY_SLEEP = """
import time
time.sleep(30)
"""
PY_ENV = """
import json, os, sys
json.load(sys.stdin)
print(json.dumps({"env": sorted(os.environ)}))
"""
PY_FAIL = """
import sys
sys.stderr.write("boom: upstream rejected request")
sys.exit(3)
"""
PY_HUGE = """
import json, sys
json.load(sys.stdin)
sys.stdout.write(json.dumps({"blob": "x" * (400 * 1024)}))
"""
PY_COUNTER = """
import json, os, sys
json.load(sys.stdin)
marker = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ran")
print(json.dumps({"ran_before": os.path.exists(marker)}))
open(marker, "w").close()
"""
JS_ECHO = """
let raw = '';
process.stdin.on('data', c => raw += c);
process.stdin.on('end', () => { const d = JSON.parse(raw); process.stdout.write(JSON.stringify({city: d.city, runtime: 'node'})); });
"""

WEATHER_INPUT = {
    "type": "object",
    "properties": {"city": {"type": "string"}},
    "required": ["city"],
}
WEATHER_OUTPUT = {
    "type": "object",
    "properties": {"city": {"type": "string"}, "temp_f": {"type": "number"}},
    "required": ["city", "temp_f"],
}


def _tool_json(name: str, *, runtime: str = "python", entry: Optional[str] = None, **overrides: Any) -> Dict[str, Any]:
    ext = "py" if runtime == "python" else "js"
    tool = {
        "name": name,
        "description": f"{name} tool",
        "input_schema": WEATHER_INPUT,
        "side_effects": False,
        "runtime": runtime,
        "entry": entry or f"tools/{name}/handler.{ext}",
    }
    tool.update(overrides)
    return tool


class FakeUserUiBackend:
    """Per-user active versions + immutable published files."""

    def __init__(self) -> None:
        self.active: Dict[str, Dict[str, Any]] = {}
        self.files: Dict[str, bytes] = {}
        self.requests: List[httpx.Request] = []

    def publish(self, user_id: str, version_id: str, tools: Dict[str, Dict[str, Any]], handlers: Dict[str, str]) -> str:
        base = f"{CDN}/{user_id}/{version_id}/"
        manifest = {"tools": {}, "inline": {"weather_card": {"entry": "inline/weather_card/index.html"}}}
        for name, tool in tools.items():
            path = f"tools/{name}/tool.json"
            manifest["tools"][name] = {"manifest": path}
            self.files[base + path] = json.dumps(tool).encode()
        for path, source in handlers.items():
            self.files[base + path] = source.encode()
        self.active[user_id] = {"versionId": version_id, "manifest": manifest, "baseUrl": base}
        return base

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        url = str(request.url)
        if url.endswith("/api/user-ui/active"):
            user_id = request.headers.get("X-User-Id", "")
            active = self.active.get(user_id)
            if active is None:
                return httpx.Response(404, json={"error": "no active version"})
            return httpx.Response(200, json=active)
        if url in self.files:
            return httpx.Response(200, content=self.files[url])
        return httpx.Response(404, json={"error": f"no file {url}"})


@contextlib.contextmanager
def _env(**values: Optional[str]):
    previous = {key: os.environ.get(key) for key in values}
    for key, value in values.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value
    try:
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


@contextlib.contextmanager
def _local_executor():
    cache = tempfile.mkdtemp(prefix="user-tools-cache-")
    try:
        with _env(USER_TOOLS_EXECUTOR="local", USER_TOOLS_CACHE_DIR=cache):
            yield cache
    finally:
        shutil.rmtree(cache, ignore_errors=True)


def _backend() -> FakeUserUiBackend:
    backend = FakeUserUiBackend()
    setup_mock_fn(backend.handler)
    return backend


def _weather_backend(handler_source: str = PY_ECHO, **tool_overrides: Any) -> FakeUserUiBackend:
    backend = _backend()
    backend.publish(
        USER_A,
        "v1",
        {"weather": _tool_json("weather", **tool_overrides)},
        {"tools/weather/handler.py": handler_source},
    )
    return backend


async def _resolve(user_id: str = USER_A) -> Dict[str, Any]:
    from domains.user_tools.repo import resolve_user_tools_activity

    return await resolve_user_tools_activity("agent-1", user_id)


async def _run(pinned: Dict[str, Any], name: str, tool_input: Dict[str, Any]) -> Dict[str, Any]:
    from domains.user_tools.repo import run_user_tool_activity
    from utils.user_tool_models import find_user_tool_spec

    spec = find_user_tool_spec(pinned["tools"], f"user__{name}")
    assert spec is not None, f"user__{name} not pinned: {pinned}"
    return await run_user_tool_activity(
        "agent-1", USER_A, pinned["version_id"], name, tool_input, pinned["base_url"], spec
    )


class _FakeWorkflow:
    """Minimal AgentWorkflow surface used by the user-tools handler."""

    def __init__(self, user_id: str = USER_A) -> None:
        self.agent_id = "agent-1"
        self.user_id = user_id
        self.user_tools: Dict[str, Any] = {}
        self.user_tools_pinned = False
        self.events: List[Dict[str, Any]] = []

    async def _handle_tool_event(self, event: Any, tool_call_id: str, tool_name: str) -> None:
        self.events.append(
            {
                "status": event.status.value if event.status else None,
                "title": event.title,
                "message": event.message,
                "metadata": dict(event.metadata or {}),
                "tool_call_id": tool_call_id,
                "tool_name": tool_name,
            }
        )


@contextlib.contextmanager
def _workflow_runtime(activity_calls: Optional[List[Any]] = None):
    """Run the handler's workflow calls in-process: activities execute directly."""
    from domains.user_tools import handler as handler_mod

    clock = [datetime(2026, 10, 20, tzinfo=timezone.utc)]

    def _now() -> datetime:
        clock[0] += timedelta(milliseconds=5)
        return clock[0]

    async def _execute_activity(fn: Any, *, args: List[Any], **kwargs: Any) -> Any:
        if activity_calls is not None:
            activity_calls.append({"fn": fn.__name__, "args": args, "kwargs": kwargs})
        return await fn(*args)

    with (
        patch.object(handler_mod.workflow, "now", new=_now),
        patch.object(handler_mod.workflow, "execute_activity", new=AsyncMock(side_effect=_execute_activity)),
    ):
        yield


# ── resolution / declaration ──


async def test_tools_declared_for_owning_user_only():
    """User A's published tool is pinned for A's root agent; user B's agent gets none."""
    with _local_executor():
        backend = _weather_backend()
        pinned_a = await _resolve(USER_A)
        pinned_b = await _resolve(USER_B)
    assert [tool["name"] for tool in pinned_a["tools"]] == ["user__weather"]
    assert pinned_a["version_id"] == "v1"
    assert pinned_b["tools"] == [] and pinned_b["version_id"] is None
    active_calls = [r for r in backend.requests if str(r.url).endswith("/api/user-ui/active")]
    assert [r.headers["X-User-Id"] for r in active_calls] == [USER_A, USER_B]
    assert all(r.headers.get("X-API-Key") for r in active_calls)
    # Credentials never go to the usercontent origin.
    cdn_calls = [r for r in backend.requests if str(r.url).startswith(CDN)]
    assert cdn_calls and all("X-API-Key" not in r.headers for r in cdn_calls)


async def test_declaration_is_sorted_and_stable():
    """Declared user tools follow the built-ins, sorted by name, byte-identical across builds."""
    from providers.rose.schema import build_anthropic_tools_from_response_model
    from utils.tool_schemas import create_agent_action_model, get_tool_models
    from utils.user_tool_models import build_user_tool_registry, llm_declarations

    with _local_executor():
        backend = _backend()
        backend.publish(
            USER_A,
            "v1",
            {name: _tool_json(name) for name in ("zeta", "alpha", "mid")},
            {f"tools/{n}/handler.py": PY_ECHO for n in ("zeta", "alpha", "mid")},
        )
        pinned = await _resolve()
    decls = llm_declarations(list(reversed(pinned["tools"])))
    assert [d["name"] for d in decls] == ["user__alpha", "user__mid", "user__zeta"]

    def _native_tools() -> List[Dict[str, Any]]:
        model = create_agent_action_model(
            ["send_message_to_user", "attempt_completion", *(d["name"] for d in decls)],
            tool_registry={**get_tool_models(), **build_user_tool_registry(decls)},
        )
        return build_anthropic_tools_from_response_model(model) or []

    first, second = _native_tools(), _native_tools()
    assert [t["name"] for t in first] == [
        "send_message_to_user",
        "attempt_completion",
        "user__alpha",
        "user__mid",
        "user__zeta",
    ]
    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)
    assert first[2]["input_schema"]["properties"] == {"city": {"type": "string"}}
    assert first[2]["input_schema"]["required"] == ["city"]


async def test_run_agent_declares_user_tools_and_dispatches_calls():
    """run_agent passes the sorted declarations to call_llm_activity and dispatches user__ calls."""
    from helpers.llm import call_llm_activity
    from loop import run_agent as run_mod

    decls = [
        {"name": "user__zeta", "description": "z", "input_schema": WEATHER_INPUT},
        {"name": "user__alpha", "description": "a", "input_schema": WEATHER_INPUT},
    ]
    llm_args: List[List[Any]] = []
    executed: List[Any] = []

    async def mock_execute_activity(fn: Any, args: Any = None, **_kwargs: Any) -> Any:
        if fn is call_llm_activity:
            llm_args.append(args)
            if len(llm_args) == 1:
                return {
                    "response": "",
                    "tool_calls": [{"tool": "user__alpha", "city": "Paris"}],
                    "usage": {},
                    "detected_tools_ordered": [],
                }
            return {"response": "", "tool_calls": [], "usage": {}, "detected_tools_ordered": []}
        return {}

    async def execute_tool(tool_name: str, tool_args: Dict[str, Any], tool_call_id: str) -> Dict[str, Any]:
        executed.append((tool_name, dict(tool_args)))
        return {"success": True, "message": "ok"}

    async def prompt() -> str:
        return "System prompt"

    with (
        patch.object(run_mod.workflow, "execute_activity", new=AsyncMock(side_effect=mock_execute_activity)),
        patch.object(run_mod.asyncio, "sleep", new=AsyncMock()),
    ):
        await run_mod.run_agent(
            agent_id="agent-1",
            user_id=USER_A,
            system_prompt=prompt,
            verifier_prompt_generator=prompt,
            model="rose-labs/rose-1-lite",
            tools=["attempt_completion"],
            initial_context=[{"role": "USER", "text": "Go", "timestamp": "2026-10-20T00:00:00Z"}],
            is_inside_temporal_activity=False,
            post_message=AsyncMock(),
            execute_tool=execute_tool,
            max_iterations=2,
            skip_verification=True,
            skip_status_updates=True,
            user_tools=decls,
        )

    import inspect

    index = list(inspect.signature(call_llm_activity).parameters).index("user_tools")
    assert llm_args, "call_llm_activity was never called"
    sent = llm_args[0][index]
    assert [d["name"] for d in sent] == ["user__alpha", "user__zeta"]
    assert llm_args[0][2] == ["attempt_completion"], "built-in tool list must stay unchanged"
    assert executed and executed[0][0] == "user__alpha" and executed[0][1].get("city") == "Paris"


async def test_sub_agent_and_disabled_executor_get_no_tools():
    """Sub-agents never resolve user tools; Fly without an explicit executor declares none."""
    from domains.user_tools.handler import declared_user_tools, pin_user_tools

    calls: List[Any] = []
    sub = _FakeWorkflow()
    with _workflow_runtime(calls):
        await pin_user_tools(sub, is_root=False)
    assert calls == [] and declared_user_tools(sub) == []

    with _env(USER_TOOLS_EXECUTOR=None, FLY_APP_NAME="navi-whisper-lux"):
        _weather_backend()
        pinned = await _resolve()
    assert pinned["tools"] == [] and "disabled in production" in pinned["disabled_reason"]

    with _env(USER_TOOLS_EXECUTOR="code_session"):
        pinned = await _resolve()
    assert pinned["tools"] == [] and "not implemented" in pinned["disabled_reason"]

    with _env(FLY_APP_NAME="navi-whisper-lux"), _local_executor():
        _weather_backend()
        pinned = await _resolve()
    assert [t["name"] for t in pinned["tools"]] == ["user__weather"]


async def test_unflagged_root_agent_pins_no_tools_without_resolving():
    """A stock (non-Rose Desktop) root agent never resolves or declares user tools.

    Even with a published version holding tools, the pin is empty, no resolve
    activity runs, and run_agent declares only the built-in tools.
    """
    from domains.user_tools.handler import declared_user_tools, pin_user_tools

    calls: List[Any] = []
    with _local_executor():
        backend = _weather_backend()
        backend.publish(STOCK_USER, "v1", {"weather": _tool_json("weather")}, {"tools/weather/handler.py": PY_ECHO})
        wf = _FakeWorkflow(user_id=STOCK_USER)
        with _workflow_runtime(calls):
            await pin_user_tools(wf, is_root=True)
    assert calls == [], "no resolve activity for a stock account"
    assert wf.user_tools_pinned and declared_user_tools(wf) == []
    assert wf.user_tools["tools"] == [] and "Rose Desktop" in wf.user_tools["disabled_reason"]
    assert not any(request.headers.get("X-User-Id") == STOCK_USER for request in backend.requests)


async def test_pinned_version_survives_mid_run_publish():
    """A version published mid-run changes neither the declared set nor the handler that runs."""
    from domains.user_tools.handler import declared_user_tools, pin_user_tools
    from workflows.agent_workflow import AgentWorkflow

    calls: List[Any] = []
    with _local_executor():
        backend = _weather_backend()
        wf = _FakeWorkflow()
        with _workflow_runtime(calls):
            await pin_user_tools(wf, is_root=True)
        assert wf.user_tools["version_id"] == "v1"

        # Publish v2 with a new tool and a changed handler.
        backend.publish(
            USER_A,
            "v2",
            {"weather": _tool_json("weather"), "stocks": _tool_json("stocks")},
            {"tools/weather/handler.py": PY_ECHO_V2, "tools/stocks/handler.py": PY_ECHO},
        )
        with _workflow_runtime(calls):
            await pin_user_tools(wf, is_root=True)
        assert len(calls) == 1, "pin must not re-resolve once pinned"
        assert [s["name"] for s in declared_user_tools(wf)] == ["user__weather"]
        outcome = await _run(wf.user_tools, "weather", {"city": "Oslo"})
        assert outcome["ok"] and outcome["result"]["version"] == "v1", outcome

        # continue_as_new carries the pin; the next run restores it without resolving.
        old = AgentWorkflow()
        old.max_iterations, old.context_gates = None, {}
        old.user_tools = wf.user_tools
        old.user_tools_pinned = True
        state = old._continuation_resume_state([])
        restored = AgentWorkflow()
        restored._restore_deployment_state(state)
        assert restored.user_tools_pinned and restored.user_tools["version_id"] == "v1"
        restored.agent_id, restored.user_id = "agent-1", USER_A
        with _workflow_runtime(calls):
            await pin_user_tools(restored, is_root=True)
        assert len(calls) == 1
        assert [s["name"] for s in declared_user_tools(restored)] == ["user__weather"]


# ── execution ──


async def test_handler_success_posts_result_with_inline_view():
    """A successful handler result is the tool result and carries metadata.inlineView."""
    from domains.user_tools.handler import pin_user_tools, run_user_tool

    with _local_executor():
        _weather_backend(output_schema=WEATHER_OUTPUT, render={"view": "weather_card"})
        wf = _FakeWorkflow()
        with _workflow_runtime():
            await pin_user_tools(wf, is_root=True)
            result = await run_user_tool(wf, "user__weather", {"city": "Lisbon"}, "tc-1")
    assert result["success"] is True and result["result"]["city"] == "Lisbon"
    assert [e["status"] for e in wf.events] == ["IN_PROGRESS", "FINISHED"]
    finished = wf.events[-1]
    assert finished["tool_name"] == "user__weather" and finished["tool_call_id"] == "tc-1"
    assert finished["metadata"]["inlineView"] == {
        "view": "weather_card",
        "versionId": "v1",
        "props": {"city": "Lisbon", "temp_f": 71, "version": "v1"},
    }
    assert "Lisbon" in finished["message"]


async def test_node_runtime_handler():
    """runtime=node runs the entry with node (or fails clearly when node is absent)."""
    with _local_executor():
        backend = _backend()
        backend.publish(
            USER_A,
            "v1",
            {"weather": _tool_json("weather", runtime="node")},
            {"tools/weather/handler.js": JS_ECHO},
        )
        pinned = await _resolve()
        outcome = await _run(pinned, "weather", {"city": "Rome"})
    if shutil.which("node"):
        assert outcome["ok"] and outcome["result"] == {"city": "Rome", "runtime": "node"}, outcome
    else:
        assert not outcome["ok"] and outcome["error_kind"] == "runtime"


async def test_bad_output_schema_is_tool_error():
    """Output that violates output_schema becomes an ERROR tool message, not a result."""
    from domains.user_tools.handler import pin_user_tools, run_user_tool

    with _local_executor():
        _weather_backend(PY_BAD_OUTPUT, output_schema=WEATHER_OUTPUT, render={"view": "weather_card"})
        wf = _FakeWorkflow()
        with _workflow_runtime():
            await pin_user_tools(wf, is_root=True)
            result = await run_user_tool(wf, "user__weather", {"city": "Lisbon"}, "tc-2")
    assert result["error"] is True and "output_schema" in result["message"]
    assert wf.events[-1]["status"] == "ERROR"
    assert "inlineView" not in wf.events[-1]["metadata"]


async def test_invalid_input_never_runs_handler():
    """Input failing input_schema is rejected before the handler starts."""
    with _local_executor():
        _weather_backend(PY_COUNTER)
        pinned = await _resolve()
        outcome = await _run(pinned, "weather", {"town": "nowhere"})
    assert not outcome["ok"] and outcome["error_kind"] == "input" and "city" in outcome["error"]


async def test_timeout_is_tool_error():
    """A handler exceeding timeout_s is killed and reported as a tool error."""
    with _local_executor():
        _weather_backend(PY_SLEEP, timeout_s=1)
        pinned = await _resolve()
        started = asyncio.get_running_loop().time()
        outcome = await _run(pinned, "weather", {"city": "Lima"})
        elapsed = asyncio.get_running_loop().time() - started
    assert not outcome["ok"] and outcome["error_kind"] == "timeout", outcome
    assert elapsed < 10, f"timeout took {elapsed:.1f}s"


async def test_nonzero_exit_and_oversized_output_are_tool_errors():
    """Non-zero exit returns the stderr tail; stdout over the cap is rejected."""
    with _local_executor():
        _weather_backend(PY_FAIL)
        failed = await _run(await _resolve(), "weather", {"city": "Kyiv"})
    assert not failed["ok"] and failed["error_kind"] == "exit"
    assert "code 3" in failed["error"] and "upstream rejected" in failed["error"]

    with _local_executor():
        _weather_backend(PY_HUGE)
        huge = await _run(await _resolve(), "weather", {"city": "Kyiv"})
    assert not huge["ok"] and huge["error_kind"] == "output_too_large"


async def test_handler_env_has_no_secrets():
    """The handler process sees a minimal environment: no worker secrets."""
    with _local_executor(), _env(BACKEND_API_KEY="secret-backend-key", USER_TOOLS_CANARY_SECRET="canary"):
        _weather_backend(PY_ENV)
        outcome = await _run(await _resolve(), "weather", {"city": "Quito"})
    assert outcome["ok"], outcome
    env_keys = set(outcome["result"]["env"])
    for secret in ("BACKEND_API_KEY", "USER_TOOLS_CANARY_SECRET", "TEMPORAL_API_KEY", "OPENROUTER_API_KEY"):
        assert secret not in env_keys, f"{secret} leaked to the handler"
    assert env_keys <= {"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "ROSE_USER_TOOL", "LC_CTYPE", "PWD"}, env_keys


async def test_side_effect_tools_rejected_in_v1():
    """side_effects tools are never declared and the run activity refuses them (no idempotency store yet)."""
    from domains.user_tools.repo import run_user_tool_activity

    with _local_executor():
        _weather_backend(PY_COUNTER, side_effects=True, idempotency_key_field="request_id")
        pinned = await _resolve()
    assert pinned["tools"] == []
    assert pinned["skipped"] and "not supported in v1" in pinned["skipped"][0]["reason"]

    forged_spec = {
        "name": "user__weather",
        "source_name": "weather",
        "input_schema": WEATHER_INPUT,
        "side_effects": True,
        "runtime": "python",
        "entry": "tools/weather/handler.py",
        "files": ["tools/weather/handler.py"],
        "timeout_s": 5,
    }
    with _local_executor():
        outcome = await run_user_tool_activity(
            "agent-1", USER_A, "v1", "weather", {"city": "X"}, f"{CDN}/{USER_A}/v1/", forged_spec
        )
    assert not outcome["ok"] and outcome["error_kind"] == "side_effects_unsupported"


async def test_invalid_tool_json_is_skipped_not_declared():
    """Contract violations skip the tool with a reason; valid siblings are still declared."""
    with _local_executor():
        backend = _backend()
        backend.publish(
            USER_A,
            "v1",
            {
                "good": _tool_json("good"),
                "escape": _tool_json("escape", entry="tools/other/handler.py"),
                "reserved": _tool_json(
                    "reserved", input_schema={"type": "object", "properties": {"tool": {"type": "string"}}}
                ),
                "noview": _tool_json("noview", render={"view": "missing_view"}),
            },
            {"tools/good/handler.py": PY_ECHO},
        )
        pinned = await _resolve()
    assert [t["name"] for t in pinned["tools"]] == ["user__good"]
    assert sorted(item["name"] for item in pinned["skipped"]) == ["escape", "noview", "reserved"]


async def test_pinned_tools_decode_in_production_sandbox():
    """A real resolve result decodes inside the production workflow sandbox.

    AgentWorkflow imports domains.user_tools.handler via imports_passed_through(),
    exactly like _user_tools_sandbox_wf. Regression: string annotations on the
    payload TypedDicts made Temporal's decode raise NameError ('Optional'), so
    every root agent hung at "Preparing Cloud Agent" (2026-10-20).
    """
    import uuid

    from _user_tools_sandbox_wf import UserToolsPinRepro
    from temporalio import activity
    from temporalio.testing import WorkflowEnvironment
    from temporalio.worker import Worker

    from helpers.workflow_sandbox import production_workflow_runner

    with _local_executor():
        _weather_backend()
        pinned = await _resolve(USER_A)
    assert pinned["tools"], "fixture must pin at least one tool"

    @activity.defn(name="resolve_user_tools_activity")
    async def resolve_fixture(agent_id: str, user_id: str) -> Dict[str, Any]:
        return pinned

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue="user-tools-sandbox",
            workflows=[UserToolsPinRepro],
            activities=[resolve_fixture],
            workflow_runner=production_workflow_runner(),
        ):
            handle = await env.client.start_workflow(
                UserToolsPinRepro.run,
                args=["agent-1", USER_A],
                id=f"user-tools-sandbox-{uuid.uuid4()}",
                task_queue="user-tools-sandbox",
                execution_timeout=timedelta(seconds=30),
            )
            assert await handle.result() == len(pinned["tools"])


async def run_all_tests():
    print("user-tools blackbox tests:")
    r = BlackboxResult()
    try:
        await r.record_async("tools_declared_for_owning_user_only", test_tools_declared_for_owning_user_only)
        await r.record_async("declaration_is_sorted_and_stable", test_declaration_is_sorted_and_stable)
        await r.record_async(
            "run_agent_declares_user_tools_and_dispatches_calls",
            test_run_agent_declares_user_tools_and_dispatches_calls,
        )
        await r.record_async(
            "sub_agent_and_disabled_executor_get_no_tools", test_sub_agent_and_disabled_executor_get_no_tools
        )
        await r.record_async(
            "unflagged_root_agent_pins_no_tools_without_resolving",
            test_unflagged_root_agent_pins_no_tools_without_resolving,
        )
        await r.record_async("pinned_version_survives_mid_run_publish", test_pinned_version_survives_mid_run_publish)
        await r.record_async(
            "handler_success_posts_result_with_inline_view", test_handler_success_posts_result_with_inline_view
        )
        await r.record_async("node_runtime_handler", test_node_runtime_handler)
        await r.record_async("bad_output_schema_is_tool_error", test_bad_output_schema_is_tool_error)
        await r.record_async("invalid_input_never_runs_handler", test_invalid_input_never_runs_handler)
        await r.record_async("timeout_is_tool_error", test_timeout_is_tool_error)
        await r.record_async(
            "nonzero_exit_and_oversized_output_are_tool_errors",
            test_nonzero_exit_and_oversized_output_are_tool_errors,
        )
        await r.record_async("handler_env_has_no_secrets", test_handler_env_has_no_secrets)
        await r.record_async("side_effect_tools_rejected_in_v1", test_side_effect_tools_rejected_in_v1)
        await r.record_async(
            "invalid_tool_json_is_skipped_not_declared", test_invalid_tool_json_is_skipped_not_declared
        )
        await r.record_async(
            "pinned_tools_decode_in_production_sandbox", test_pinned_tools_decode_in_production_sandbox
        )
    finally:
        teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
