"""Blackbox tests for the display tool and the in-sandbox Rose agent tools.

Two surfaces, one backend contract (/api/agent-tools/:agentId, see
back-end/src/domains/agent-tools; its own suites run against a real DB):

1. ``domains/display`` — the ``display`` tool for root and sub-agents. The
   backend is mocked through the httpx capture harness; the handler runs its
   real validation and activity. One case runs it inside a real Temporal
   production workflow sandbox (payload decode).
2. ``rose`` (back-end/src/assets/rose-tools/rose.cjs) — the CLI and MCP stdio
   server a code agent uses. Real ``node`` subprocesses talk to an in-process
   fake of the agent-tools HTTP API that dedupes by content hash.

Neither surface can ask the user (or a spawning agent) a question: display is
inline only, and there is no approval, pinned question or wait.
"""

import asyncio
import base64
import contextlib
import hashlib
import json
import os
import shutil
import tempfile
import threading
import time
import uuid
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional
from unittest.mock import AsyncMock, patch
from urllib.parse import urlparse

import httpx
from _test_utils import BlackboxResult, get_captured_requests, setup_mock_fn, teardown_mock

AGENTS_ROOT = Path(__file__).resolve().parents[2]
ROSE_CLI = AGENTS_ROOT.parent / "back-end" / "src" / "assets" / "rose-tools" / "rose.cjs"
TOKEN = "rtt.test-token"
PNG = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) + b"pixels"
CARD_HTML = "<!doctype html><html><body><h1>Revenue</h1><p>$2,342.78</p></body></html>"

# ── 1. display tool (root / sub-agents) ──


# The fake agents belong to the Rose Desktop account (utils.rose_desktop) unless
# a test says otherwise.
ROSE_DESKTOP_USER = "1f85ff25-6e29-4c1b-8739-f917bd101a30"
STOCK_USER = "user-stock-3333"


class _FakeAgent:
    """Minimal AgentWorkflow surface used by the display handler."""

    def __init__(self, agent_id: str = "agent-root", depth: int = 0, user_id: str = ROSE_DESKTOP_USER) -> None:
        self.agent_id = agent_id
        self.user_id = user_id
        self.depth = depth
        self.events: List[Dict[str, Any]] = []

    async def _handle_tool_event(self, event: Any, tool_call_id: str, tool_name: str) -> None:
        self.events.append(
            {
                "status": event.status.value if event.status else None,
                "title": event.title,
                "message": event.message,
                "metadata": dict(event.metadata or {}),
            }
        )


class _Backend:
    """Mock /api/agent-tools/:agentId/display; records every request body."""

    def __init__(self, responses: List[httpx.Response]) -> None:
        self.responses = list(responses)
        self.bodies: List[Dict[str, Any]] = []
        self.headers: List[Dict[str, str]] = []
        self.urls: List[str] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.urls.append(str(request.url))
        self.headers.append(dict(request.headers))
        self.bodies.append(json.loads(request.content or b"{}"))
        return self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]


@contextlib.contextmanager
def _workflow_runtime():
    """Run the handler's workflow calls in-process: activities execute directly."""
    from domains.display import handler as handler_mod

    async def _execute_activity(fn: Any, *, args: List[Any], **_kwargs: Any) -> Any:
        return await fn(*args)

    with (
        patch.object(handler_mod.workflow, "execute_activity", new=AsyncMock(side_effect=_execute_activity)),
        patch.object(handler_mod.workflow, "info", return_value=SimpleNamespace(workflow_id="wf-root")),
    ):
        yield


async def _run_tool(agent: _FakeAgent, tool_call: Dict[str, Any], tool_call_id: str = "call-1") -> None:
    from domains.display.handler import display

    with _workflow_runtime():
        await display(agent, tool_call, tool_call_id)


async def test_validation_errors_never_reach_the_backend():
    """Type/limit errors are tool errors and never call the backend."""
    backend = _Backend([httpx.Response(201, json={})])
    setup_mock_fn(backend.handler)
    cases = {
        "too many items": {"paths": [f"f{i}.png" for i in range(21)]},
        "non-http url": {"urls": ["ftp://example.com/a.png"]},
        "nothing to show": {"caption": "hi"},
        "pinned without question": {"placement": "pinned", "options": [{"label": "A"}]},
        "too many options": {
            "placement": "pinned",
            "caption": "Q?",
            "options": [{"label": f"o{i}"} for i in range(10)],
        },
        "options on inline": {"paths": ["a.png"], "options": [{"label": "A"}]},
        "no way to answer": {"placement": "pinned", "caption": "Q?", "allow_other": False},
        "bad placement": {"paths": ["a.png"], "placement": "sideways"},
        "html not a string": {"html": ["<p>x</p>"]},
        "html over the cap": {"html": "<!doctype html><p>" + "x" * 1_000_000 + "</p>"},
        "html counts as an item": {"html": CARD_HTML, "paths": [f"f{i}.png" for i in range(20)]},
    }
    for label, call in cases.items():
        agent = _FakeAgent()
        await _run_tool(agent, {"tool": "display", **call})
        assert [e["status"] for e in agent.events] == ["ERROR"], f"{label}: {agent.events}"
    assert backend.bodies == [], f"validation must not call the backend: {backend.bodies}"


async def test_display_refuses_questions_for_every_agent_and_account():
    """display never asks a question: pinned arguments are a tool error and never reach the backend.

    Root and sub-agents, Rose Desktop and stock accounts, with or without media.
    """
    backend = _Backend([httpx.Response(201, json={})])
    setup_mock_fn(backend.handler)
    question = {"caption": "Which layout?", "placement": "pinned", "options": [{"label": "Grid"}, {"label": "List"}]}
    calls = [
        question,
        {**question, "paths": ["shot.png"]},
        {"paths": ["shot.png"], "options": [{"label": "Grid"}]},
        {"paths": ["shot.png"], "allow_other": True},
    ]
    for user_id in (ROSE_DESKTOP_USER, STOCK_USER):
        for depth in (0, 1, 2):
            for call in calls:
                agent = _FakeAgent(f"agent-{depth}", depth=depth, user_id=user_id)
                await asyncio.wait_for(_run_tool(agent, {"tool": "display", **call}), timeout=5)
                [event] = agent.events
                assert event["status"] == "ERROR", (user_id, depth, call, agent.events)
                assert "display cannot ask questions" in event["message"], event
    assert backend.bodies == [], f"a question must never reach the backend: {backend.bodies}"


async def test_inline_display_sends_items_and_reports_duplicates():
    """paths → file items, urls → url items; duplicates (same content hash) are reported."""
    backend = _Backend(
        [
            httpx.Response(
                201,
                json={
                    "placement": "inline",
                    "posted_count": 1,
                    "duplicate_count": 1,
                    "items": [
                        {"status": "posted", "mime_type": "image/png", "message_id": "m1"},
                        {"status": "duplicate", "mime_type": "image/png", "message_id": "m0"},
                    ],
                },
            )
        ]
    )
    setup_mock_fn(backend.handler)
    agent = _FakeAgent("agent-child", depth=1)
    await _run_tool(
        agent,
        {"tool": "display", "paths": ["shot.png"], "urls": ["https://example.com/a.png"], "caption": "Before"},
    )
    assert len(backend.bodies) == 1
    body = backend.bodies[0]
    assert body == {
        "items": [{"file": "shot.png"}, {"url": "https://example.com/a.png"}],
        "placement": "inline",
        "caption": "Before",
    }, body
    assert backend.urls[0].endswith("/api/agent-tools/agent-child/display")
    assert backend.headers[0].get("x-user-id") == ROSE_DESKTOP_USER
    [event] = agent.events
    assert event["status"] == "FINISHED", event
    assert "Displayed 1 item(s)" in event["message"] and "1 already shown" in event["message"], event


async def test_root_inline_html_is_displayed_as_one_page():
    """A root writes the page itself: `html` becomes one .html item, deduped by the backend's content hash."""
    backend = _Backend(
        [
            httpx.Response(
                201,
                json={
                    "placement": "inline",
                    "posted_count": 1,
                    "items": [{"status": "posted", "mime_type": "text/html"}],
                },
            ),
            httpx.Response(
                200,
                json={
                    "placement": "inline",
                    "duplicate_count": 1,
                    "items": [{"status": "duplicate", "mime_type": "text/html"}],
                },
            ),
        ]
    )
    setup_mock_fn(backend.handler)
    root = _FakeAgent("agent-root", depth=0)
    await _run_tool(root, {"tool": "display", "html": f"  {CARD_HTML}\n", "caption": "Revenue"})
    await _run_tool(root, {"tool": "display", "html": CARD_HTML}, tool_call_id="call-2")
    page = {"content_base64": base64.b64encode(CARD_HTML.encode()).decode(), "filename": "display.html"}
    assert backend.bodies == [
        {"items": [page], "placement": "inline", "caption": "Revenue"},
        {"items": [page], "placement": "inline"},
    ], backend.bodies
    assert backend.urls[0].endswith("/api/agent-tools/agent-root/display")
    assert [e["status"] for e in root.events] == ["FINISHED", "FINISHED"], root.events
    assert "Displayed 1 item(s)" in root.events[0]["message"] and "text/html" in root.events[0]["message"]
    assert "1 already shown" in root.events[1]["message"], root.events


async def test_backend_type_errors_surface_as_tool_errors():
    """A 400 (disallowed type) is a definitive tool error with the backend's details."""
    backend = _Backend(
        [
            httpx.Response(
                400,
                json={
                    "error": "Invalid media",
                    "details": ["#1 logo.svg: is not an image, video or HTML page (SVG excluded)"],
                },
            )
        ]
    )
    setup_mock_fn(backend.handler)
    agent = _FakeAgent()
    await _run_tool(agent, {"tool": "display", "paths": ["logo.svg"]})
    [event] = agent.events
    assert event["status"] == "ERROR" and "logo.svg: is not an image" in event["message"], event
    assert len(backend.bodies) == 1, "a 4xx answer is never retried"


async def test_inline_display_runs_in_production_sandbox():
    """The display payloads decode inside the real workflow sandbox and the tool finishes at once."""
    from _display_sandbox_wf import DisplaySandboxRepro
    from temporalio import activity
    from temporalio.testing import WorkflowEnvironment
    from temporalio.worker import Worker

    from domains.display.types import DisplayActivityInput, DisplayActivityResult
    from helpers.workflow_sandbox import production_workflow_runner

    seen: List[DisplayActivityInput] = []
    body = {"placement": "inline", "posted_count": 1, "items": [{"status": "posted", "mime_type": "image/png"}]}

    @activity.defn(name="display_media_activity")
    async def display_fixture(payload: DisplayActivityInput) -> DisplayActivityResult:
        seen.append(payload)
        return {"ok": True, "status_code": 201, "body": body}

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue="display-sandbox",
            workflows=[DisplaySandboxRepro],
            activities=[display_fixture],
            workflow_runner=production_workflow_runner(),
        ):
            events = await env.client.execute_workflow(
                DisplaySandboxRepro.run,
                args=["agent-root", ROSE_DESKTOP_USER, {"tool": "display", "paths": ["shot.png"], "caption": "Layout"}],
                id=f"display-sandbox-{uuid.uuid4()}",
                task_queue="display-sandbox",
                execution_timeout=timedelta(seconds=60),
            )
    assert [e["status"] for e in events] == ["FINISHED"], events
    assert "Displayed 1 item(s)" in events[0]["message"], events
    assert seen and seen[0]["tool_call_id"] == "call-display-1" and seen[0]["items"] == [{"file": "shot.png"}], seen


# ── 2. rose CLI + MCP server (code-agent sandbox) ──


class FakeAgentTools:
    """In-process fake of /api/agent-tools/:agentId for the sandbox client."""

    def __init__(self) -> None:
        self.seen_hashes: set[str] = set()
        self.calls: List[Dict[str, Any]] = []
        self.lock = threading.Lock()
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args: Any) -> None:
                return

            def _send(self, status: int, payload: Dict[str, Any]) -> None:
                data = json.dumps(payload).encode()
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    return

            def _authorized(self) -> bool:
                if self.headers.get("Authorization") == f"Bearer {TOKEN}":
                    return True
                self._send(401, {"error": "Invalid agent tools token (signature)"})
                return False

            def do_POST(self) -> None:  # noqa: N802 - http.server API
                if not self._authorized():
                    return
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                path = urlparse(self.path).path
                with fake.lock:
                    fake.calls.append({"method": "POST", "path": path, "body": body})
                    status, payload = fake.post(path, body)
                self._send(status, payload)

            def do_GET(self) -> None:  # noqa: N802 - http.server API
                if not self._authorized():
                    return
                with fake.lock:
                    fake.calls.append({"method": "GET", "path": urlparse(self.path).path})
                self._send(404, {"error": "no route"})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}/api/agent-tools/agent-1"

    def post(self, path: str, body: Dict[str, Any]) -> tuple[int, Dict[str, Any]]:
        if path.endswith("/display"):
            results = []
            for item in body["items"]:
                if str(item.get("filename", "")).endswith(".svg"):
                    return 400, {
                        "error": "Invalid media",
                        "details": [f"#1 {item['filename']}: is not an image, video or HTML page (SVG excluded)"],
                    }
                sha = hashlib.sha256(base64.b64decode(item["content_base64"])).hexdigest()
                status = "duplicate" if sha in self.seen_hashes else "posted"
                self.seen_hashes.add(sha)
                results.append(
                    {"status": status, "mime_type": "image/png", "message_id": f"m-{sha[:8]}", "sha256": sha}
                )
            return 201, {"items": results, "posted_count": sum(r["status"] == "posted" for r in results)}
        if path.endswith("/messages"):
            return 201, {"message_id": f"msg-{body['idempotency_key'][:8]}"}
        return 404, {"error": "no route"}

    def __enter__(self) -> "FakeAgentTools":
        self.thread.start()
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.server.shutdown()
        self.server.server_close()


def _cli_env(fake: FakeAgentTools, home: str, rose_desktop: bool = True) -> Dict[str, str]:
    """Session env; Rose Desktop by default (inline views on)."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("ROSE_TOOLS")}
    env.update({"HOME": home, "ROSE_TOOLS_URL": fake.url, "ROSE_TOOLS_TOKEN": TOKEN})
    if rose_desktop:
        env["ROSE_TOOLS_ROSE_DESKTOP"] = "1"
    return env


async def _cli(
    fake: FakeAgentTools, home: str, *args: str, timeout: float = 20, rose_desktop: bool = True
) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        shutil.which("node") or "node",
        str(ROSE_CLI),
        *args,
        env=_cli_env(fake, home, rose_desktop),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    return proc.returncode or 0, out.decode(), err.decode()


class _Mcp:
    """JSON-RPC over stdio against `rose mcp`."""

    def __init__(self, proc: asyncio.subprocess.Process) -> None:
        self.proc = proc
        self.next_id = 0

    async def send(self, method: str, params: Optional[Dict[str, Any]] = None) -> int:
        self.next_id += 1
        message = {"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params or {}}
        assert self.proc.stdin is not None
        self.proc.stdin.write((json.dumps(message) + "\n").encode())
        await self.proc.stdin.drain()
        return self.next_id

    async def response(self, request_id: int, timeout: float = 20) -> Dict[str, Any]:
        assert self.proc.stdout is not None
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            line = await asyncio.wait_for(self.proc.stdout.readline(), timeout=max(0.1, deadline - time.monotonic()))
            if not line:
                raise AssertionError("MCP server exited")
            message = json.loads(line)
            if message.get("id") == request_id:
                return message
        raise AssertionError(f"no MCP response for {request_id}")


@contextlib.asynccontextmanager
async def _mcp_server(fake: FakeAgentTools, home: str, rose_desktop: bool = True):
    env = _cli_env(fake, home)
    # The MCP server reads ~/.rose/tools.json when its parent passes no env.
    for key in ("ROSE_TOOLS_URL", "ROSE_TOOLS_TOKEN", "ROSE_TOOLS_ROSE_DESKTOP"):
        env.pop(key)
    rose_dir = Path(home) / ".rose"
    rose_dir.mkdir(parents=True, exist_ok=True)
    saved: Dict[str, Any] = {"url": fake.url, "token": TOKEN}
    if rose_desktop:
        saved["rose_desktop"] = True
    (rose_dir / "tools.json").write_text(json.dumps(saved))
    proc = await asyncio.create_subprocess_exec(
        shutil.which("node") or "node",
        str(ROSE_CLI),
        "mcp",
        env=env,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    client = _Mcp(proc)
    try:
        init = await client.response(await client.send("initialize", {"protocolVersion": "2025-06-18"}))
        assert init["result"]["serverInfo"]["name"] == "rose", init
        yield client
    finally:
        if proc.returncode is None:
            proc.kill()
        await proc.wait()


@contextlib.contextmanager
def _home():
    home = tempfile.mkdtemp(prefix="rose-tools-home-")
    try:
        yield home
    finally:
        shutil.rmtree(home, ignore_errors=True)


async def test_mcp_server_lists_the_rose_tools():
    with FakeAgentTools() as fake, _home() as home:
        async with _mcp_server(fake, home) as mcp:
            listed = await mcp.response(await mcp.send("tools/list"))
            names = sorted(tool["name"] for tool in listed["result"]["tools"])
            assert names == ["change_environment_size", "cli", "display", "send_message_to_user"], names
            unknown = await mcp.response(await mcp.send("tools/call", {"name": "nope", "arguments": {}}))
            assert "error" in unknown, unknown


async def test_code_agent_cannot_ask_a_question():
    """No user approval, pinned question or wait; CLI auth coordinates with its parent."""
    with FakeAgentTools() as fake, _home() as home:
        for rose_desktop in (True, False):
            async with _mcp_server(fake, home, rose_desktop=rose_desktop) as mcp:
                listed = await mcp.response(await mcp.send("tools/list"))
                blob = json.dumps(listed)
                assert "pinned" not in blob and "request_user_approval" not in blob, blob
                approval = await mcp.response(
                    await mcp.send(
                        "tools/call", {"name": "request_user_approval", "arguments": {"question": "Deploy?"}}
                    )
                )
                assert "unknown tool request_user_approval" in approval["error"]["message"], approval
                pinned = await mcp.response(
                    await mcp.send(
                        "tools/call",
                        {
                            "name": "display",
                            "arguments": {"caption": "Proceed?", "placement": "pinned", "options": [{"label": "Yes"}]},
                        },
                    )
                )
                assert pinned["result"]["isError"] is True, pinned
                assert "at least one path or url" in pinned["result"]["content"][0]["text"], pinned
            for args in (["approve", "Delete the staging branch?"], ["wait", "atq_1"]):
                code, out, err = await _cli(fake, home, *args, rose_desktop=rose_desktop)
                assert code == 1 and f"unknown command {args[0]}" in err, (args, code, out, err)
            code, out, err = await _cli(
                fake, home, "display", "--pinned", "--caption", "Which?", "--option", "A", rose_desktop=rose_desktop
            )
            assert code == 1 and "unknown option --pinned" in err, (code, out, err)
            code, out, err = await _cli(fake, home, "--help", rose_desktop=rose_desktop)
            assert code == 0 and not any(word in out for word in ("approve", "wait", "--pinned", "--option")), out
        # The MCP server's tool listing reads the user's connected MCP servers (GET .../mcp);
        # nothing else may reach Rose: no question, approval or wait request.
        assert all(c["method"] == "GET" and c["path"].endswith("/mcp") for c in fake.calls), (
            f"no question request reached Rose: {fake.calls}"
        )


async def test_cli_display_dedupes_by_content_hash():
    """The same bytes displayed twice are posted once; the CLI reports the duplicate."""
    with FakeAgentTools() as fake, _home() as home:
        shot = Path(home) / "shot.png"
        shot.write_bytes(PNG)
        code, out, err = await _cli(fake, home, "display", str(shot), "--caption", "First")
        assert code == 0 and "displayed image/png" in out, (code, out, err)
        code, out, err = await _cli(fake, home, "display", str(shot))
        assert code == 0 and "already displayed image/png" in out, (code, out, err)
        posts = [c for c in fake.calls if c["path"].endswith("/display")]
        assert len(posts) == 2 and posts[0]["body"]["caption"] == "First" and "caption" not in posts[1]["body"]
        assert len(fake.seen_hashes) == 1


async def test_cli_and_mcp_display_inline_html():
    """`rose display --html` and the MCP `html` argument post one display.html page, deduped by content hash."""
    with FakeAgentTools() as fake, _home() as home:
        code, out, err = await _cli(fake, home, "display", "--html", CARD_HTML, "--caption", "Card")
        assert code == 0 and "displayed" in out and "already" not in out, (code, out, err)
        async with _mcp_server(fake, home) as mcp:
            result = await mcp.response(
                await mcp.send("tools/call", {"name": "display", "arguments": {"html": CARD_HTML}})
            )
            assert result["result"]["isError"] is False, result
            assert "already displayed" in result["result"]["content"][0]["text"], result
            too_big = await mcp.response(
                await mcp.send("tools/call", {"name": "display", "arguments": {"html": "x" * (20 * 1024 * 1024 + 1)}})
            )
            assert too_big["result"]["isError"] is True, too_big
            assert "html: larger than 20 MB" in too_big["result"]["content"][0]["text"], too_big
        posts = [c["body"] for c in fake.calls if c["path"].endswith("/display")]
        page = {"content_base64": base64.b64encode(CARD_HTML.encode()).decode(), "filename": "display.html"}
        assert posts == [
            {"items": [page], "caption": "Card", "placement": "inline"},
            {"items": [page], "placement": "inline"},
        ], posts
        assert len(fake.seen_hashes) == 1, "the cap fails locally; the same page twice is one hash"


async def test_cli_type_and_limit_errors():
    """> 20 items and missing files fail locally (no request); a backend type error shows its details."""
    with FakeAgentTools() as fake, _home() as home:
        shot = Path(home) / "shot.png"
        shot.write_bytes(PNG)
        code, _out, err = await _cli(fake, home, "display", *([str(shot)] * 21))
        assert code == 1 and "at most 20 items" in err, (code, err)
        code, _out, err = await _cli(fake, home, "display", str(Path(home) / "missing.png"))
        assert code == 1 and "no such file" in err, (code, err)
        assert fake.calls == [], fake.calls
        svg = Path(home) / "logo.svg"
        svg.write_text("<svg/>")
        code, _out, err = await _cli(fake, home, "display", str(svg))
        assert code == 1 and "logo.svg: is not an image" in err, (code, err)


async def test_cli_message_sends_inline_view():
    with FakeAgentTools() as fake, _home() as home:
        code, out, err = await _cli(
            fake, home, "message", "Scorecard ready", "--inline-view", "scorecard", "--props", '{"passed": 3}'
        )
        assert code == 0 and "sent (message msg-" in out, (code, out, err)
        [post] = [c for c in fake.calls if c["path"].endswith("/messages")]
        assert post["body"]["inline_view"] == {"view": "scorecard", "props": {"passed": 3}}, post
        assert post["body"]["idempotency_key"], post


async def test_stock_session_tools_have_no_pinned_questions_or_inline_views():
    """A stock (non-Rose Desktop) session: MCP lists the stock tools; pinned/inline-view arguments are dropped."""
    with FakeAgentTools() as fake, _home() as home:
        async with _mcp_server(fake, home, rose_desktop=False) as mcp:
            listed = await mcp.response(await mcp.send("tools/list"))
            tools = {tool["name"]: tool for tool in listed["result"]["tools"]}
            assert sorted(tools) == ["change_environment_size", "cli", "display", "send_message_to_user"], tools
            assert set(tools["change_environment_size"]["inputSchema"]["properties"]) == {"cpu", "memory_gb", "reason"}
            assert tools["cli"]["inputSchema"]["properties"]["action"]["enum"] == ["list", "run", "publish"]
            assert "immediate parent Rose agent" in tools["cli"]["description"]
            assert "question" not in tools["cli"]["inputSchema"]["properties"]
            assert list(tools["display"]["inputSchema"]["properties"]) == ["paths", "urls", "html", "caption"]
            assert list(tools["send_message_to_user"]["inputSchema"]["properties"]) == ["message"]
            blob = json.dumps(listed)
            assert "pinned" not in blob and "inline_view" not in blob, blob

        code, out, err = await _cli(fake, home, "--help", rose_desktop=False)
        assert code == 0 and "--pinned" not in out and "--inline-view" not in out, (code, out, err)

        code, out, err = await _cli(
            fake, home, "message", "Scorecard ready", "--inline-view", "scorecard", rose_desktop=False
        )
        assert code == 0 and "sent (message msg-" in out, (code, out, err)
        [post] = [c for c in fake.calls if c["path"].endswith("/messages")]
        assert "inline_view" not in post["body"], post

        code, out, err = await _cli(
            fake, home, "display", "--pinned", "--caption", "Which?", "--option", "A", rose_desktop=False
        )
        assert code == 1 and "unknown option --pinned" in err, (code, out, err)
        assert not [c for c in fake.calls if c["path"].endswith("/display")], fake.calls


async def run_all_tests():
    print("display blackbox tests:")
    r = BlackboxResult()
    try:
        await r.record_async(
            "validation_errors_never_reach_the_backend", test_validation_errors_never_reach_the_backend
        )
        await r.record_async(
            "display_refuses_questions_for_every_agent_and_account",
            test_display_refuses_questions_for_every_agent_and_account,
        )
        await r.record_async(
            "inline_display_sends_items_and_reports_duplicates", test_inline_display_sends_items_and_reports_duplicates
        )
        await r.record_async(
            "root_inline_html_is_displayed_as_one_page", test_root_inline_html_is_displayed_as_one_page
        )
        await r.record_async(
            "backend_type_errors_surface_as_tool_errors", test_backend_type_errors_surface_as_tool_errors
        )
        await r.record_async(
            "inline_display_runs_in_production_sandbox", test_inline_display_runs_in_production_sandbox
        )
        await r.record_async("mcp_server_lists_the_rose_tools", test_mcp_server_lists_the_rose_tools)
        await r.record_async("code_agent_cannot_ask_a_question", test_code_agent_cannot_ask_a_question)
        await r.record_async("cli_display_dedupes_by_content_hash", test_cli_display_dedupes_by_content_hash)
        await r.record_async("cli_and_mcp_display_inline_html", test_cli_and_mcp_display_inline_html)
        await r.record_async("cli_type_and_limit_errors", test_cli_type_and_limit_errors)
        await r.record_async("cli_message_sends_inline_view", test_cli_message_sends_inline_view)
        await r.record_async(
            "stock_session_tools_have_no_pinned_questions_or_inline_views",
            test_stock_session_tools_have_no_pinned_questions_or_inline_views,
        )
    finally:
        teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
