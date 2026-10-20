"""Blackbox tests for user-authored tools (domains/user_tools).

The backend is mocked through the httpx capture harness (FakeUserUiBackend):
`GET /api/user-ui/active`, published files under `baseUrl`, the side-effect
record (`POST /api/user-ui/tool-calls/{claim,complete,release}`, same contract as
the real ToolSideEffect-backed routes) and the code-session runner
(`POST /api/user-ui/tools/run`, a fake sandbox: one persistent HOME per user).
Handlers run as real subprocesses for both executors.
"""

import asyncio
import base64
import contextlib
import hashlib
import json
import os
import shutil
import sys
import tempfile
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from unittest.mock import AsyncMock, patch

import httpx
from _test_utils import BlackboxResult, setup_mock_fn, teardown_mock

USER_A = "user-a-1111"
USER_B = "user-b-2222"
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
    """Per-user active versions + immutable published files, the side-effect record
    and a code-session runner whose sandbox is one persistent HOME per user."""

    def __init__(self) -> None:
        self.active: Dict[str, Dict[str, Any]] = {}
        self.files: Dict[str, bytes] = {}
        self.requests: List[httpx.Request] = []
        # (user_id, key) -> {status, request, run, created}
        self.records: Dict[Any, Dict[str, Any]] = {}
        self.root = Path(tempfile.mkdtemp(prefix="user-tools-sessions-"))
        self.session_runs: List[Dict[str, Any]] = []
        self.run_bodies: List[Dict[str, Any]] = []
        self.hang_runs = False
        self.lose_run_responses = False
        self.busy_runs = 0

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

    def session_home(self, user_id: str) -> Path:
        home = self.root / hashlib.sha256(user_id.encode()).hexdigest()[:16] / "home"
        home.mkdir(parents=True, exist_ok=True)
        return home

    def calls(self, suffix: str) -> List[httpx.Request]:
        return [r for r in self.requests if str(r.url).endswith(suffix)]

    # ── /api/user-ui/tool-calls (mirrors back-end providers/userTools/callRecords.ts) ──

    def _claim(self, user_id: str, body: Dict[str, Any]) -> httpx.Response:
        key = body["idempotency_key"]
        request = {k: body.get(k) for k in ("agent_id", "tool", "version_id", "input_sha256")}
        record = self.records.get((user_id, key))
        if record is None or record["status"] == "FAILED":
            self.records[(user_id, key)] = {
                "status": "STARTED",
                "request": request,
                "run": None,
                "created": time.monotonic(),
            }
            return httpx.Response(200, json={"status": "claimed"})
        if record["request"] != request:
            return httpx.Response(409, json={"status": "conflict", "error": "key used by a different call"})
        if record["status"] == "SUCCEEDED":
            return httpx.Response(200, json={"status": "done", "run": record["run"]})
        age_ms = int((time.monotonic() - record["created"]) * 1000)
        return httpx.Response(200, json={"status": "running", "age_ms": age_ms})

    def _complete(self, user_id: str, key: str, run: Dict[str, Any]) -> Dict[str, Any]:
        record = self.records[(user_id, key)]
        if record["status"] == "STARTED":
            record["status"] = "SUCCEEDED"
            record["run"] = run
        return record["run"]

    # ── /api/user-ui/tools/run (fake sandbox: the user's persistent session HOME) ──

    async def _run_in_session(self, request: httpx.Request, user_id: str, body: Dict[str, Any]) -> httpx.Response:
        self.run_bodies.append(body)
        if self.hang_runs:
            # MockTransport ignores client timeouts: honour the configured read
            # timeout like a real socket would, then fail the way httpx does.
            read_timeout = (request.extensions.get("timeout") or {}).get("read")
            assert read_timeout is not None, "the code-session run call must carry a read timeout"
            await asyncio.sleep(float(read_timeout))
            raise httpx.ReadTimeout("backend never answered", request=request)
        if self.busy_runs > 0:
            self.busy_runs -= 1
            return httpx.Response(503, json={"error": "all tool sessions busy", "code": "USER_TOOL_SESSION_BUSY"})
        key = body.get("idempotency_key")
        if key:
            record = self.records.get((user_id, key))
            if record is None:
                return httpx.Response(409, json={"error": "claim the call first", "code": "TOOL_CALL_NOT_CLAIMED"})
            if record["status"] == "SUCCEEDED":
                return httpx.Response(200, json={"run": record["run"], "replayed": True})
        base = f"{CDN}/{user_id}/{body['version_id']}/"
        files = {path: self.files.get(base + path) for path in body["files"]}
        if any(content is None for content in files.values()):
            return httpx.Response(404, json={"error": "version not found", "code": "USER_UI_VERSION_NOT_FOUND"})
        home = self.session_home(user_id)
        run_dir = home / ".rose" / "user-tools" / "runs" / uuid.uuid4().hex
        for path, content in files.items():
            target = run_dir / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content or b"")
        env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(run_dir), "LANG": "C.UTF-8"}
        if key:
            env["ROSE_IDEMPOTENCY_KEY"] = key
        argv = [sys.executable, "-I", body["entry"]] if body["runtime"] == "python" else ["node", body["entry"]]
        self.session_runs.append({"user_id": user_id, "home": str(home), "tool": body["tool"]})
        proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=str(run_dir),
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        timed_out = False
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(body["input_json"].encode()), timeout=body["timeout_s"]
            )
        except asyncio.TimeoutError:
            timed_out = True
            proc.kill()
            stdout, stderr = await proc.communicate()
        overflow = len(stdout) > 256 * 1024
        run = {
            "returncode": proc.returncode,
            "stdout_b64": "" if overflow else base64.b64encode(stdout).decode(),
            "stderr_tail": stderr.decode(errors="replace")[-4096:],
            "timed_out": timed_out,
            "overflow": overflow,
            "executor": "code_session",
            "code_session_id": f"cs-{user_id}",
        }
        if key:
            run = self._complete(user_id, key, run)
        if self.lose_run_responses:
            raise httpx.ReadError("connection reset after the handler ran", request=request)
        return httpx.Response(200, json={"run": run, "code_session_id": f"cs-{user_id}", "resumed_from": "new"})

    async def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        url = str(request.url)
        user_id = request.headers.get("X-User-Id", "")
        if url.endswith("/api/user-ui/active"):
            active = self.active.get(user_id)
            if active is None:
                return httpx.Response(404, json={"error": "no active version"})
            return httpx.Response(200, json=active)
        if "/api/user-ui/" in url and request.method == "POST":
            assert request.headers.get("X-API-Key"), "internal user-ui calls carry the backend key"
            assert user_id, "internal user-ui calls name the user in X-User-Id"
            body = json.loads(request.content or b"{}")
            assert "user_id" not in body and "code_session_id" not in body, body
            if url.endswith("/api/user-ui/tools/run"):
                return await self._run_in_session(request, user_id, body)
            if url.endswith("/api/user-ui/tool-calls/claim"):
                return self._claim(user_id, body)
            if url.endswith("/api/user-ui/tool-calls/complete"):
                if (user_id, body["idempotency_key"]) not in self.records:
                    return httpx.Response(404, json={"error": "unknown call"})
                return httpx.Response(200, json={"run": self._complete(user_id, body["idempotency_key"], body["run"])})
            if url.endswith("/api/user-ui/tool-calls/release"):
                record = self.records.get((user_id, body["idempotency_key"]))
                if record is not None and record["status"] == "STARTED":
                    record["status"] = "FAILED"
                return httpx.Response(200, json={"status": "released"})
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


_BACKENDS: List[FakeUserUiBackend] = []


@contextlib.contextmanager
def _code_session_executor():
    with _env(USER_TOOLS_EXECUTOR="code_session"):
        yield


def _backend() -> FakeUserUiBackend:
    backend = FakeUserUiBackend()
    _BACKENDS.append(backend)
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


async def _run(
    pinned: Dict[str, Any],
    name: str,
    tool_input: Dict[str, Any],
    *,
    user_id: str = USER_A,
    key: Optional[str] = None,
) -> Dict[str, Any]:
    from domains.user_tools.repo import run_user_tool_activity
    from utils.user_tool_models import find_user_tool_spec

    spec = find_user_tool_spec(pinned["tools"], f"user__{name}")
    assert spec is not None, f"user__{name} not pinned: {pinned}"
    args: List[Any] = ["agent-1", user_id, pinned["version_id"], name, tool_input, pinned["base_url"], spec]
    if key is not None:
        args.append(key)
    return await run_user_tool_activity(*args)


def _call_key(tool_call_id: str = "tc-1") -> str:
    from domains.user_tools.types import user_tool_call_key

    return user_tool_call_key("wf-root-1", tool_call_id)


# Side-effecting handler: appends one line per run to a counter file outside the
# sandbox (an absolute path baked into the source), so a test can count runs.
PY_CHARGE = """
import json, os, sys, time
data = json.load(sys.stdin)
time.sleep(float(data.get("delay", 0)))
counter = {counter!r}
with open(counter, "a") as handle:
    handle.write("charge\\n")
with open(counter) as handle:
    runs = len(handle.read().splitlines())
print(json.dumps({{"charged": data["city"], "runs": runs, "key_env": os.environ.get("ROSE_IDEMPOTENCY_KEY"),
                  "key_input": data.get("request_id"), "cwd": os.getcwd()}}))
"""
CHARGE_INPUT = {
    "type": "object",
    "properties": {"city": {"type": "string"}, "delay": {"type": "number"}},
    "required": ["city"],
}


def _charge_backend(counter: Path, **tool_overrides: Any) -> FakeUserUiBackend:
    backend = _backend()
    tool = _tool_json(
        "charge",
        input_schema=CHARGE_INPUT,
        side_effects=True,
        idempotency_key_field="request_id",
        **tool_overrides,
    )
    backend.publish(USER_A, "v1", {"charge": tool}, {"tools/charge/handler.py": PY_CHARGE.format(counter=str(counter))})
    return backend


def _runs(counter: Path) -> int:
    return len(counter.read_text().splitlines()) if counter.exists() else 0


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

    from types import SimpleNamespace

    with (
        patch.object(handler_mod.workflow, "now", new=_now),
        patch.object(handler_mod.workflow, "execute_activity", new=AsyncMock(side_effect=_execute_activity)),
        patch.object(handler_mod.workflow, "info", new=lambda: SimpleNamespace(workflow_id="wf-root-1")),
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

    with _env(USER_TOOLS_EXECUTOR="off"):
        pinned = await _resolve()
    assert pinned["tools"] == [] and "disabled by USER_TOOLS_EXECUTOR=off" in pinned["disabled_reason"]

    # Production selects the code-session executor explicitly.
    with _env(FLY_APP_NAME="navi-whisper-lux", USER_TOOLS_EXECUTOR="code_session"):
        pinned = await _resolve()
    assert [t["name"] for t in pinned["tools"]] == ["user__weather"]

    with _env(FLY_APP_NAME="navi-whisper-lux"), _local_executor():
        _weather_backend()
        pinned = await _resolve()
    assert [t["name"] for t in pinned["tools"]] == ["user__weather"]


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


async def test_side_effect_tool_contract():
    """side_effects tools are declared; idempotency_key_field is validated; a call without its key never runs."""
    from domains.user_tools.repo import run_user_tool_activity

    counter = Path(tempfile.mkdtemp(prefix="user-tools-counter-")) / "runs.txt"
    with _local_executor():
        backend = _charge_backend(counter)
        backend.publish(
            USER_A,
            "v1",
            {
                "charge": json.loads(backend.files[f"{CDN}/{USER_A}/v1/tools/charge/tool.json"]),
                "in_schema": _tool_json(
                    "in_schema", input_schema=CHARGE_INPUT, side_effects=True, idempotency_key_field="city"
                ),
                "not_side": _tool_json("not_side", idempotency_key_field="request_id"),
                "bad_field": _tool_json("bad_field", side_effects=True, idempotency_key_field="Request-Id"),
            },
            {"tools/charge/handler.py": PY_CHARGE.format(counter=str(counter))},
        )
        pinned = await _resolve()
    assert [t["name"] for t in pinned["tools"]] == ["user__charge"]
    spec = pinned["tools"][0]
    assert spec["side_effects"] is True and spec["idempotency_key_field"] == "request_id"
    reasons = {item["name"]: item["reason"] for item in pinned["skipped"]}
    assert "must not be an input_schema property" in reasons["in_schema"]
    assert "only valid with side_effects" in reasons["not_side"]
    assert "must match" in reasons["bad_field"]
    # The LLM declaration never exposes the key field.
    from utils.user_tool_models import llm_declarations

    assert "request_id" not in json.dumps(llm_declarations(pinned["tools"]))

    with _local_executor():
        _charge_backend(counter)
        missing = await run_user_tool_activity(
            "agent-1", USER_A, "v1", "charge", {"city": "X"}, pinned["base_url"], spec
        )
        malformed = await _run(pinned, "charge", {"city": "X"}, key="not-a-key")
    for outcome in (missing, malformed):
        assert not outcome["ok"] and outcome["error_kind"] == "invalid", outcome
    assert _runs(counter) == 0


async def _side_effect_retry_runs_once(executor: Any) -> None:
    counter = Path(tempfile.mkdtemp(prefix="user-tools-counter-")) / "runs.txt"
    with executor():
        backend = _charge_backend(counter)
        pinned = await _resolve()
        key = _call_key("tc-retry")
        first = await _run(pinned, "charge", {"city": "Oslo"}, key=key)
        # Temporal lost the completion RPC and retries the same activity.
        second = await _run(pinned, "charge", {"city": "Oslo"}, key=key)
    assert first["ok"] and second["ok"], (first, second)
    assert _runs(counter) == 1, "the retry must not run the side-effecting handler again"
    assert second["result"] == first["result"] and second.get("replayed") is True
    assert first["result"]["key_env"] == key and first["result"]["key_input"] == key
    assert len(backend.calls("/tool-calls/claim")) == 2
    assert [r["status"] for r in backend.records.values()] == ["SUCCEEDED"]


async def test_side_effect_retry_after_lost_completion_runs_once():
    """A retried side-effecting call (same root workflow + tool call) replays the stored result, both executors."""
    await _side_effect_retry_runs_once(_local_executor)
    await _side_effect_retry_runs_once(_code_session_executor)


async def test_side_effect_lost_completion_under_temporal_runs_once():
    """Real Temporal retry: attempt 1 runs the handler, then its completion is lost; attempt 2 replays."""
    from _user_tools_sandbox_wf import UserToolsRunRepro
    from temporalio import activity
    from temporalio.testing import WorkflowEnvironment
    from temporalio.worker import Worker

    from domains.user_tools.repo import resolve_user_tools_activity, run_user_tool_activity
    from domains.user_tools.types import user_tool_call_key
    from helpers.workflow_sandbox import production_workflow_runner

    counter = Path(tempfile.mkdtemp(prefix="user-tools-counter-")) / "runs.txt"
    attempts: List[int] = []
    keys: List[Optional[str]] = []

    @activity.defn(name="run_user_tool_activity")
    async def lossy_run(
        agent_id: str,
        user_id: str,
        version_id: str,
        name: str,
        tool_input: Dict[str, Any],
        base_url: str,
        spec: Dict[str, Any],
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        outcome = await run_user_tool_activity(
            agent_id, user_id, version_id, name, tool_input, base_url, spec, idempotency_key
        )
        attempts.append(activity.info().attempt)
        keys.append(idempotency_key)
        if activity.info().attempt == 1:
            raise RuntimeError("completion RPC lost after the side effect ran")
        return outcome

    with _local_executor():
        backend = _charge_backend(counter)
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue="user-tools-run",
                workflows=[UserToolsRunRepro],
                activities=[resolve_user_tools_activity, lossy_run],
                workflow_runner=production_workflow_runner(),
            ):
                workflow_id = f"user-tools-run-{uuid.uuid4()}"
                out = await env.client.execute_workflow(
                    UserToolsRunRepro.run,
                    args=["agent-1", USER_A, "user__charge", {"city": "Rome"}, "tc-temporal"],
                    id=workflow_id,
                    task_queue="user-tools-run",
                    execution_timeout=timedelta(seconds=60),
                )
    assert attempts == [1, 2], attempts
    assert keys[0] == keys[1] == user_tool_call_key(workflow_id, "tc-temporal")
    assert _runs(counter) == 1, "the Temporal retry must not repeat the side effect"
    assert out["result"]["success"] is True and out["result"]["result"]["charged"] == "Rome", out
    assert out["statuses"] == ["IN_PROGRESS", "FINISHED"]
    assert [r["status"] for r in backend.records.values()] == ["SUCCEEDED"]


async def _concurrent_duplicates_run_once(executor: Any) -> None:
    counter = Path(tempfile.mkdtemp(prefix="user-tools-counter-")) / "runs.txt"
    with executor():
        _charge_backend(counter)
        pinned = await _resolve()
        key = _call_key("tc-dup")
        first, second = await asyncio.gather(
            _run(pinned, "charge", {"city": "Lima", "delay": 1}, key=key),
            _run(pinned, "charge", {"city": "Lima", "delay": 1}, key=key),
        )
    assert first["ok"] and second["ok"], (first, second)
    assert _runs(counter) == 1, "two concurrent duplicates must run the handler once"
    assert first["result"] == second["result"]
    assert sorted(bool(o.get("replayed")) for o in (first, second)) == [False, True]


async def test_concurrent_duplicate_side_effect_calls_run_once():
    """Two concurrent attempts of one call: one runs the handler, the other waits and gets its result."""
    await _concurrent_duplicates_run_once(_local_executor)
    await _concurrent_duplicates_run_once(_code_session_executor)


async def test_stale_side_effect_claim_is_outcome_unknown_not_rerun():
    """A claim left STARTED by an attempt that died mid-run is never re-run; the call reports outcome_unknown."""
    counter = Path(tempfile.mkdtemp(prefix="user-tools-counter-")) / "runs.txt"
    with _local_executor():
        backend = _charge_backend(counter, timeout_s=1)
        pinned = await _resolve()
        key = _call_key("tc-stale")
        backend.records[(USER_A, key)] = {
            "status": "STARTED",
            "request": {
                "agent_id": "agent-1",
                "tool": "charge",
                "version_id": "v1",
                "input_sha256": hashlib.sha256(
                    json.dumps({"city": "Kyiv", "request_id": key}, separators=(",", ":"), sort_keys=True).encode()
                ).hexdigest(),
            },
            "run": None,
            "created": time.monotonic() - 3600,
        }
        stale = await _run(pinned, "charge", {"city": "Kyiv"}, key=key)
        # A different input under the same key is a conflict, never a run.
        conflict = await _run(pinned, "charge", {"city": "Other"}, key=key)
    assert not stale["ok"] and stale["error_kind"] == "outcome_unknown", stale
    assert not conflict["ok"] and conflict["error_kind"] == "idempotency_conflict", conflict
    assert _runs(counter) == 0


async def test_lost_run_response_replays_the_stored_record():
    """The code-session run stored its record but the response was lost: the activity
    returns that record (no second run, no error) by consulting the claim."""
    counter = Path(tempfile.mkdtemp(prefix="user-tools-counter-")) / "runs.txt"
    with _code_session_executor():
        backend = _charge_backend(counter)
        backend.lose_run_responses = True
        pinned = await _resolve()
        key = _call_key("tc-lost-response")
        outcome = await _run(pinned, "charge", {"city": "Quito"}, key=key)
        again = await _run(pinned, "charge", {"city": "Quito"}, key=key)
    assert outcome["ok"] and outcome["result"]["charged"] == "Quito", outcome
    assert outcome.get("replayed") is True and again["result"] == outcome["result"]
    assert _runs(counter) == 1 and len(backend.run_bodies) == 1


async def test_code_session_busy_waits_then_reports_structured_error():
    """All of the user's tool sessions busy: the call waits for one; past the wait it is a
    structured session_busy error and a side-effect claim is released (never ran)."""
    from domains.user_tools import repo as repo_mod

    with _code_session_executor():
        backend = _weather_backend()
        backend.busy_runs = 2
        pinned = await _resolve()
        waited = await _run(pinned, "weather", {"city": "Bern"})
    assert waited["ok"] and waited["result"]["city"] == "Bern", waited
    assert len(backend.run_bodies) == 3

    counter = Path(tempfile.mkdtemp(prefix="user-tools-counter-")) / "runs.txt"
    with _code_session_executor(), patch.object(repo_mod, "CODE_SESSION_BUSY_WAIT_SECONDS", 0.5):
        backend = _charge_backend(counter)
        backend.busy_runs = 1000
        pinned = await _resolve()
        key = _call_key("tc-busy")
        busy = await _run(pinned, "charge", {"city": "Bern"}, key=key)
    assert not busy["ok"] and busy["error_kind"] == "session_busy", busy
    assert [r["status"] for r in backend.records.values()] == ["FAILED"], "never-started claim is released"
    assert _runs(counter) == 0


async def test_read_only_tools_unchanged_by_side_effect_path():
    """Read-only calls never touch the side-effect record and keep the 7-argument activity call."""
    from domains.user_tools.handler import pin_user_tools, run_user_tool

    for executor in (_local_executor, _code_session_executor):
        calls: List[Any] = []
        with executor():
            backend = _weather_backend()
            wf = _FakeWorkflow()
            with _workflow_runtime(calls):
                await pin_user_tools(wf, is_root=True)
                result = await run_user_tool(wf, "user__weather", {"city": "Lisbon"}, "tc-ro")
        assert result["success"] is True and result["result"]["city"] == "Lisbon", result
        run_calls = [c for c in calls if c["fn"] == "run_user_tool_activity"]
        assert len(run_calls) == 1 and len(run_calls[0]["args"]) == 7
        assert not [r for r in backend.requests if "/tool-calls/" in str(r.url)]
        assert [e["status"] for e in wf.events] == ["IN_PROGRESS", "FINISHED"]


async def test_side_effect_call_from_workflow_passes_stable_key():
    """The workflow handler derives the key from (root workflow id, tool call id) and passes it."""
    from domains.user_tools.handler import pin_user_tools, run_user_tool

    counter = Path(tempfile.mkdtemp(prefix="user-tools-counter-")) / "runs.txt"
    calls: List[Any] = []
    with _code_session_executor():
        _charge_backend(counter)
        wf = _FakeWorkflow()
        with _workflow_runtime(calls):
            await pin_user_tools(wf, is_root=True)
            first = await run_user_tool(wf, "user__charge", {"city": "Paris"}, "tc-wf")
            again = await run_user_tool(wf, "user__charge", {"city": "Paris"}, "tc-wf")
    run_calls = [c for c in calls if c["fn"] == "run_user_tool_activity"]
    assert [c["args"][7] for c in run_calls] == [_call_key("tc-wf")] * 2
    assert first["success"] and again["result"] == first["result"]
    assert _runs(counter) == 1


# ── code_session executor ──


async def test_code_session_executor_round_trip():
    """The handler runs in the user's code session (backend runner); the worker downloads no handler bytes."""
    from domains.user_tools.handler import pin_user_tools, run_user_tool

    with _code_session_executor():
        backend = _weather_backend(output_schema=WEATHER_OUTPUT, render={"view": "weather_card"})
        wf = _FakeWorkflow()
        with _workflow_runtime():
            await pin_user_tools(wf, is_root=True)
            result = await run_user_tool(wf, "user__weather", {"city": "Lisbon"}, "tc-cs")
    assert result["success"] is True and result["result"]["city"] == "Lisbon", result
    assert wf.events[-1]["metadata"]["inlineView"]["props"]["city"] == "Lisbon"
    (body,) = backend.run_bodies
    assert body["tool"] == "weather" and body["version_id"] == "v1" and body["runtime"] == "python"
    assert body["files"] == ["tools/weather/handler.py"] and body["timeout_s"] == 60
    assert json.loads(body["input_json"]) == {"city": "Lisbon"} and "idempotency_key" not in body
    (run_request,) = backend.calls("/api/user-ui/tools/run")
    assert run_request.headers["X-User-Id"] == USER_A
    assert not [r for r in backend.requests if str(r.url).endswith("handler.py")], "worker fetched handler bytes"
    assert [r["user_id"] for r in backend.session_runs] == [USER_A]


async def test_code_session_never_uses_another_users_session():
    """Each user's call runs in that user's session; the worker cannot name a session or another user's version."""
    with _code_session_executor():
        backend = _backend()
        where = 'import json, os, sys\njson.load(sys.stdin)\nprint(json.dumps({"cwd": os.getcwd(), "city": "x", "temp_f": 1}))\n'
        for user in (USER_A, USER_B):
            backend.publish(user, "v1", {"weather": _tool_json("weather")}, {"tools/weather/handler.py": where})
        pinned_a = await _resolve(USER_A)
        pinned_b = await _resolve(USER_B)
        out_a = await _run(pinned_a, "weather", {"city": "a"}, user_id=USER_A)
        out_b = await _run(pinned_b, "weather", {"city": "b"}, user_id=USER_B)
        # B's agent replaying A's pinned version id still runs as B: the backend
        # scopes the version to B, so A's files are never served to B's session.
        backend.files = {k: v for k, v in backend.files.items() if not k.startswith(f"{CDN}/{USER_B}/")}
        foreign = await _run(pinned_a, "weather", {"city": "b"}, user_id=USER_B)
    home_a, home_b = str(backend.session_home(USER_A)), str(backend.session_home(USER_B))
    assert out_a["ok"] and out_a["result"]["cwd"].startswith(home_a), out_a
    assert out_b["ok"] and out_b["result"]["cwd"].startswith(home_b), out_b
    assert home_a != home_b
    assert [r["user_id"] for r in backend.session_runs] == [USER_A, USER_B]
    assert [r.headers["X-User-Id"] for r in backend.calls("/api/user-ui/tools/run")] == [USER_A, USER_B, USER_B]
    assert not foreign["ok"] and foreign["error_kind"] == "invalid", foreign


async def test_code_session_timeout_is_structured_error():
    """The per-call handler timeout comes back as a tool error; an unresponsive backend too (never a crash)."""
    from domains.user_tools import repo as repo_mod
    from domains.user_tools.handler import pin_user_tools, run_user_tool

    with _code_session_executor():
        _weather_backend(PY_SLEEP, timeout_s=1)
        pinned = await _resolve()
        started = asyncio.get_running_loop().time()
        timed_out = await _run(pinned, "weather", {"city": "Lima"})
        elapsed = asyncio.get_running_loop().time() - started
    assert not timed_out["ok"] and timed_out["error_kind"] == "timeout", timed_out
    assert "timed out after 1s" in timed_out["error"] and elapsed < 10, elapsed

    with _code_session_executor(), patch.object(repo_mod, "CODE_SESSION_HTTP_MARGIN_SECONDS", 1):
        backend = _weather_backend(PY_ECHO, timeout_s=1)
        backend.hang_runs = True
        wf = _FakeWorkflow()
        with _workflow_runtime():
            await pin_user_tools(wf, is_root=True)
            result = await run_user_tool(wf, "user__weather", {"city": "Lima"}, "tc-hang")
    assert result["error"] is True and "code session run failed" in result["message"], result
    assert wf.events[-1]["status"] == "ERROR"
    assert wf.events[-1]["metadata"]["userTool"]["errorKind"] == "executor"


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
        await r.record_async("side_effect_tool_contract", test_side_effect_tool_contract)
        await r.record_async(
            "side_effect_retry_after_lost_completion_runs_once",
            test_side_effect_retry_after_lost_completion_runs_once,
        )
        await r.record_async(
            "side_effect_lost_completion_under_temporal_runs_once",
            test_side_effect_lost_completion_under_temporal_runs_once,
        )
        await r.record_async(
            "concurrent_duplicate_side_effect_calls_run_once", test_concurrent_duplicate_side_effect_calls_run_once
        )
        await r.record_async(
            "stale_side_effect_claim_is_outcome_unknown_not_rerun",
            test_stale_side_effect_claim_is_outcome_unknown_not_rerun,
        )
        await r.record_async(
            "lost_run_response_replays_the_stored_record", test_lost_run_response_replays_the_stored_record
        )
        await r.record_async(
            "read_only_tools_unchanged_by_side_effect_path", test_read_only_tools_unchanged_by_side_effect_path
        )
        await r.record_async(
            "side_effect_call_from_workflow_passes_stable_key", test_side_effect_call_from_workflow_passes_stable_key
        )
        await r.record_async("code_session_executor_round_trip", test_code_session_executor_round_trip)
        await r.record_async(
            "code_session_never_uses_another_users_session", test_code_session_never_uses_another_users_session
        )
        await r.record_async("code_session_timeout_is_structured_error", test_code_session_timeout_is_structured_error)
        await r.record_async(
            "code_session_busy_waits_then_reports_structured_error",
            test_code_session_busy_waits_then_reports_structured_error,
        )
        await r.record_async(
            "invalid_tool_json_is_skipped_not_declared", test_invalid_tool_json_is_skipped_not_declared
        )
        await r.record_async(
            "pinned_tools_decode_in_production_sandbox", test_pinned_tools_decode_in_production_sandbox
        )
    finally:
        teardown_mock()
        for backend in _BACKENDS:
            shutil.rmtree(backend.root, ignore_errors=True)
        _BACKENDS.clear()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
