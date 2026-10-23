"""Blackbox tests for the display tool and the in-sandbox Rose agent tools.

Two surfaces, one backend contract (/api/agent-tools/:agentId, see
back-end/src/domains/agent-tools; its own suites run against a real DB):

1. ``domains/display`` — the ``display`` tool for root and sub-agents. The
   backend is mocked through the httpx capture harness; the handler runs its
   real validation, activity and wait. One case runs the pinned path inside a
   real Temporal production workflow sandbox (payload decode + block/resume).
2. ``rose`` (back-end/src/assets/rose-tools/rose.cjs) — the CLI and MCP stdio
   server a code agent uses. Real ``node`` subprocesses talk to an in-process
   fake of the agent-tools HTTP API that dedupes by content hash, routes pinned
   questions, and long-polls answers.
"""

import asyncio
import base64
import contextlib
import hashlib
import json
import os
import shutil
import signal
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
from urllib.parse import parse_qs, urlparse

import httpx
from _test_utils import BlackboxResult, get_captured_requests, setup_mock_fn, teardown_mock

AGENTS_ROOT = Path(__file__).resolve().parents[2]
ROSE_CLI = AGENTS_ROOT.parent / "back-end" / "src" / "assets" / "rose-tools" / "rose.cjs"
TOKEN = "rtt.test-token"
# A long-lived agent-graph token (exp far ahead → no refresh call).
AGENTS_TOKEN = "rag." + base64.urlsafe_b64encode(json.dumps({"exp": 4102444800}).encode()).decode().rstrip("=") + ".sig"
PNG = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) + b"pixels"

# ── 1. display tool (root / sub-agents) ──


# Pinned questions are a Rose Desktop surface (utils.rose_desktop); the fake
# agents belong to the flagged account unless a test says otherwise.
ROSE_DESKTOP_USER = "1f85ff25-6e29-4c1b-8739-f917bd101a30"
STOCK_USER = "user-stock-3333"


class _FakeAgent:
    """Minimal AgentWorkflow surface used by the display handler."""

    def __init__(self, agent_id: str = "agent-root", depth: int = 0, user_id: str = ROSE_DESKTOP_USER) -> None:
        self.agent_id = agent_id
        self.user_id = user_id
        self.depth = depth
        self._signal_responses: Dict[str, str] = {}
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

        self.graph: List[Dict[str, Any]] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        if "/api/agent-graph/" in str(request.url):
            body = json.loads(request.content or b"{}")
            self.graph.append({"url": str(request.url), "headers": dict(request.headers), "body": body})
            return httpx.Response(200, json={"status": "delivered", "message_id": body.get("message_id")})
        self.urls.append(str(request.url))
        self.headers.append(dict(request.headers))
        self.bodies.append(json.loads(request.content or b"{}"))
        return self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]


def _agent_route_response() -> httpx.Response:
    return httpx.Response(
        201,
        json={
            "placement": "pinned",
            "items": [],
            "question": {
                "request_id": None,
                "status": "route_to_agent",
                "deliver_to": "agent",
                "agent_id": "agent-child",
                "message_id": None,
                "response": None,
                "message_metadata": {},
            },
        },
    )


def _pinned_response(request_id: str, deliver_to: str, *, status: str = "pending", response: Optional[str] = None):
    return httpx.Response(
        201,
        json={
            "agent_id": "agent-root",
            "placement": "pinned",
            "posted_count": 0,
            "duplicate_count": 0,
            "items": [],
            "question": {
                "request_id": request_id,
                "status": status,
                "deliver_to": deliver_to,
                "agent_id": "agent-parent" if deliver_to == "parent" else "agent-root",
                "message_id": None,
                "response": response,
                "message_metadata": {
                    "isUserAttentionMessage": deliver_to == "user",
                    "attentionRequestId": request_id,
                    "display": {
                        "placement": "pinned",
                        "kind": "question",
                        "question": "Which layout?",
                        "options": [{"label": "Grid"}, {"label": "List"}],
                        "allow_other": True,
                        "question_id": request_id,
                    },
                },
            },
        },
    )


@contextlib.contextmanager
def _workflow_runtime():
    """Run the handler's workflow calls in-process: activities execute directly."""
    from domains.display import handler as handler_mod

    async def _execute_activity(fn: Any, *, args: List[Any], **_kwargs: Any) -> Any:
        return await fn(*args)

    async def _wait_condition(predicate: Any, timeout: Any = None) -> None:
        deadline = time.monotonic() + (timeout.total_seconds() if isinstance(timeout, timedelta) else 3600)
        while not predicate():
            if time.monotonic() > deadline:
                raise asyncio.TimeoutError()
            await asyncio.sleep(0.01)

    with (
        patch.object(handler_mod.workflow, "execute_activity", new=AsyncMock(side_effect=_execute_activity)),
        patch.object(handler_mod.workflow, "info", return_value=SimpleNamespace(workflow_id="wf-root")),
        patch.object(handler_mod.workflow, "wait_condition", new=_wait_condition),
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
    }
    for label, call in cases.items():
        agent = _FakeAgent()
        await _run_tool(agent, {"tool": "display", **call})
        assert [e["status"] for e in agent.events] == ["ERROR"], f"{label}: {agent.events}"
    assert backend.bodies == [], f"validation must not call the backend: {backend.bodies}"


@patch("utils.rose_desktop.ROSE_DESKTOP_ENABLED_BY_DEFAULT", False)
async def test_stock_account_gets_inline_media_only():
    """A stock account's display call never pins a question: pinned arguments are dropped.

    With media, the call is plain inline media (the backend body has no pinned
    fields); without media, it is the stock "nothing to show" tool error and
    never reaches the backend.
    """
    backend = _Backend(
        [httpx.Response(201, json={"placement": "inline", "items": [{"status": "posted", "message_id": "m1"}]})]
    )
    setup_mock_fn(backend.handler)
    agent = _FakeAgent(user_id=STOCK_USER)
    await _run_tool(
        agent,
        {
            "tool": "display",
            "paths": ["shot.png"],
            "caption": "Which layout?",
            "placement": "pinned",
            "options": [{"label": "Grid"}],
            "allow_other": False,
        },
    )
    assert backend.bodies == [{"items": [{"file": "shot.png"}], "placement": "inline", "caption": "Which layout?"}]
    assert [e["status"] for e in agent.events] == ["FINISHED"], agent.events

    question_only = _FakeAgent(user_id=STOCK_USER)
    await _run_tool(
        question_only, {"tool": "display", "caption": "Which?", "placement": "pinned", "options": [{"label": "A"}]}
    )
    assert [e["status"] for e in question_only.events] == ["ERROR"], question_only.events
    assert "at least one entry" in question_only.events[0]["message"]
    assert len(backend.bodies) == 1, "a stock question never reaches the backend"


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


async def test_pinned_question_from_root_spawned_caller_goes_to_user_and_resumes():
    """Route user: IN_PROGRESS carries the UI pin metadata, blocks, resumes with the user's choice."""
    backend = _Backend([_pinned_response("atq_layout", "user")])
    setup_mock_fn(backend.handler)
    agent = _FakeAgent("agent-child", depth=1)
    call = {
        "tool": "display",
        "caption": "Which layout?",
        "placement": "pinned",
        "options": [{"label": "Grid", "recommended": True}, {"label": "List"}],
    }
    task = asyncio.create_task(_run_tool(agent, call, "call-pinned"))
    for _ in range(200):
        if agent.events:
            break
        await asyncio.sleep(0.01)
    assert [e["status"] for e in agent.events] == ["IN_PROGRESS"], agent.events
    await asyncio.sleep(0.2)
    assert not task.done() and len(agent.events) == 1, "pinned display blocks until answered"
    body = backend.bodies[0]
    assert body["request_key"] == "call-pinned" and body["workflow_id"] == "wf-root", body
    assert body["options"][0] == {"label": "Grid", "recommended": True}, body
    agent._signal_responses["atq_layout"] = "List"
    await asyncio.wait_for(task, timeout=5)
    opening, closing = agent.events
    pin = opening["metadata"]["display"]
    assert pin["placement"] == "pinned" and pin["kind"] == "question" and pin["question_id"] == "atq_layout", pin
    assert opening["metadata"]["isUserAttentionMessage"] is True
    assert opening["title"] == "Asking the user"
    assert closing["status"] == "FINISHED", closing
    assert "The user chose option 2: List" in closing["message"], closing
    assert backend.graph == [], "a user-routed question never goes through the agent graph"


async def test_pinned_question_from_deeper_caller_asks_spawning_agent():
    """Route agent: the question goes to the spawner through L-A2A and the tool returns at once."""
    backend = _Backend([_agent_route_response()])
    setup_mock_fn(backend.handler)
    agent = _FakeAgent("agent-grandchild", depth=2)
    call = {
        "tool": "display",
        "caption": "Proceed with migration?",
        "placement": "pinned",
        "options": [{"label": "Yes", "recommended": True}, {"label": "No", "description": "Keep the old schema"}],
    }
    await asyncio.wait_for(_run_tool(agent, call, "call-ask"), timeout=5)
    [event] = agent.events
    assert event["status"] == "FINISHED" and "Asked agent agent-child" in event["message"], event
    assert event["metadata"]["display"]["deliver_to"] == "agent", event
    [sent] = backend.graph
    assert sent["url"].endswith("/api/agent-graph/messages"), sent
    assert sent["headers"].get("x-agent-id") == "agent-grandchild", sent["headers"]
    assert sent["body"]["to"] == "agent-child", sent
    assert sent["body"]["message_id"] == "wf-root:call-ask", sent
    text = sent["body"]["text"]
    assert text.startswith("Proceed with migration?") and "1. Yes (recommended)" in text, text
    assert "2. No — Keep the old schema" in text and "3. Other (free text)" in text, text


async def test_pinned_retry_after_answer_returns_stored_answer():
    """A retried call whose question is already answered returns the stored answer without waiting."""
    backend = _Backend([_pinned_response("atq_done", "user", status="answered", response="Grid")])
    setup_mock_fn(backend.handler)
    agent = _FakeAgent()
    await asyncio.wait_for(
        _run_tool(agent, {"tool": "display", "caption": "Which layout?", "placement": "pinned", "options": [{"label": "Grid"}, {"label": "List"}]}),
        timeout=5,
    )
    assert [e["status"] for e in agent.events] == ["IN_PROGRESS", "FINISHED"], agent.events
    assert "option 1: Grid" in agent.events[1]["message"]


async def test_pinned_question_blocks_and_resumes_in_production_sandbox():
    """The pinned path decodes its payloads and parks/resumes inside the real workflow sandbox."""
    from _display_sandbox_wf import DisplayPinnedRepro
    from temporalio import activity
    from temporalio.testing import WorkflowEnvironment
    from temporalio.worker import Worker

    from domains.display.types import DisplayActivityInput, DisplayActivityResult
    from helpers.workflow_sandbox import production_workflow_runner

    seen: List[DisplayActivityInput] = []
    body = _pinned_response("atq_sandbox", "user").json()

    @activity.defn(name="display_media_activity")
    async def display_fixture(payload: DisplayActivityInput) -> DisplayActivityResult:
        seen.append(payload)
        return {"ok": True, "status_code": 201, "body": body}

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue="display-sandbox",
            workflows=[DisplayPinnedRepro],
            activities=[display_fixture],
            workflow_runner=production_workflow_runner(),
        ):
            handle = await env.client.start_workflow(
                DisplayPinnedRepro.run,
                args=[
                    "agent-root",
                    ROSE_DESKTOP_USER,
                    {"tool": "display", "caption": "Which layout?", "placement": "pinned", "options": [{"label": "Grid"}, {"label": "List"}]},
                ],
                id=f"display-sandbox-{uuid.uuid4()}",
                task_queue="display-sandbox",
                execution_timeout=timedelta(seconds=60),
            )
            statuses: List[str] = []
            for _ in range(100):
                statuses = await handle.query(DisplayPinnedRepro.statuses)
                if statuses:
                    break
                await asyncio.sleep(0.05)
            assert statuses == ["IN_PROGRESS"], statuses
            await asyncio.sleep(0.3)
            assert await handle.query(DisplayPinnedRepro.statuses) == ["IN_PROGRESS"], "blocks until answered"
            await handle.signal(
                DisplayPinnedRepro.receive_user_response,
                json.dumps({"request_id": "atq_sandbox", "response": "Grid"}),
            )
            events = await handle.result()
    assert [e["status"] for e in events] == ["IN_PROGRESS", "FINISHED"], events
    assert "option 1: Grid" in events[1]["message"], events
    assert seen and seen[0]["tool_call_id"] == "call-pinned-1"
    assert seen[0]["placement"] == "pinned" and seen[0]["workflow_id"], seen


# ── 2. rose CLI + MCP server (code-agent sandbox) ──


class FakeAgentTools:
    """In-process fake of /api/agent-tools/:agentId for the sandbox client."""

    def __init__(self, deliver_to: str = "user") -> None:
        self.deliver_to = deliver_to
        self.seen_hashes: set[str] = set()
        self.requests: Dict[str, Dict[str, Any]] = {}
        self.creations: Dict[str, int] = {}
        self.calls: List[Dict[str, Any]] = []
        self.graph_questions: List[Dict[str, Any]] = []
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
                    # A CLI killed mid long-poll (the interrupt case) closed its socket.
                    return

            def _authorized(self) -> bool:
                if self.headers.get("Authorization") in (f"Bearer {TOKEN}", f"Bearer {AGENTS_TOKEN}"):
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
                parsed = urlparse(self.path)
                request_id = parsed.path.rsplit("/", 1)[-1]
                wait = float(parse_qs(parsed.query).get("wait", ["0"])[0])
                with fake.lock:
                    fake.calls.append({"method": "GET", "path": parsed.path})
                    entry = fake.requests.get(request_id)
                    if entry is not None:
                        entry["polls"] += 1
                if entry is None:
                    return self._send(404, {"error": "Request not found"})
                deadline = time.monotonic() + min(wait, 0.3)
                while entry["answer"] is None and time.monotonic() < deadline:
                    time.sleep(0.02)
                self._send(200, fake.state(request_id))

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}/api/agent-tools/agent-1"

    @property
    def agents_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}/api/agent-graph"

    def post(self, path: str, body: Dict[str, Any]) -> tuple[int, Dict[str, Any]]:
        if path.endswith("/agent-graph/questions"):
            self.graph_questions.append(body)
            return 200, {"deliver_to": "agent", "agent_id": "agent-parent", "status": "delivered", "message_id": body["message_id"]}
        if path.endswith("/display") and body.get("placement") == "pinned" and self.deliver_to == "agent":
            return 201, {
                "placement": "pinned",
                "items": [],
                "question": {"request_id": None, "status": "route_to_agent", "deliver_to": "agent", "agent_id": "agent-parent"},
            }
        if path.endswith("/display") and body.get("placement") == "pinned":
            request_id = self._open("question", body["request_key"], body)
            return 201, {
                "placement": "pinned",
                "items": [],
                "question": {"request_id": request_id, "status": "pending", "deliver_to": self.deliver_to},
            }
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
                results.append({"status": status, "mime_type": "image/png", "message_id": f"m-{sha[:8]}", "sha256": sha})
            return 201, {"items": results, "posted_count": sum(r["status"] == "posted" for r in results)}
        if path.endswith("/approvals"):
            return 201, {"request_id": self._open("approval", body["request_key"], body), "status": "pending"}
        if path.endswith("/messages"):
            return 201, {"message_id": f"msg-{body['idempotency_key'][:8]}"}
        return 404, {"error": "no route"}

    def _open(self, kind: str, key: str, body: Dict[str, Any]) -> str:
        request_id = f"atq_{hashlib.sha256(f'{kind}:{key}'.encode()).hexdigest()[:10]}"
        if request_id not in self.requests:
            self.requests[request_id] = {"kind": kind, "answer": None, "polls": 0, "body": body}
        self.creations[request_id] = self.creations.get(request_id, 0) + 1
        return request_id

    def answer(self, request_id: str, answer: str) -> None:
        with self.lock:
            self.requests[request_id]["answer"] = answer

    def state(self, request_id: str) -> Dict[str, Any]:
        entry = self.requests[request_id]
        answer = entry["answer"]
        if answer is None:
            return {"id": request_id, "kind": entry["kind"], "status": "pending"}
        options = [o["label"] for o in entry["body"].get("options", [])]
        selected = None
        if answer in options:
            selected = {"index": options.index(answer), "label": answer}
        elif answer.isdigit() and 1 <= int(answer) <= len(options):
            selected = {"index": int(answer) - 1, "label": options[int(answer) - 1]}
        return {
            "id": request_id,
            "kind": entry["kind"],
            "status": "rejected" if answer == "__REJECTED__" else "answered",
            "response": selected["label"] if selected else answer,
            "selected_option": selected,
            "answered_by": "user",
        }

    def __enter__(self) -> "FakeAgentTools":
        self.thread.start()
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.server.shutdown()
        self.server.server_close()


def _cli_env(fake: FakeAgentTools, home: str, rose_desktop: bool = True) -> Dict[str, str]:
    """Session env; Rose Desktop by default (pinned questions and inline views on)."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("ROSE_TOOLS")}
    env.update({"HOME": home, "ROSE_TOOLS_URL": fake.url, "ROSE_TOOLS_TOKEN": TOKEN, "ROSE_TOOLS_WAIT_SECONDS": "1"})
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
        self.notifications: List[Dict[str, Any]] = []

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
            self.notifications.append(message)
        raise AssertionError(f"no MCP response for {request_id}")


@contextlib.asynccontextmanager
async def _mcp_server(fake: FakeAgentTools, home: str, rose_desktop: bool = True):
    env = _cli_env(fake, home)
    # The MCP server reads ~/.rose/tools.json when its parent passes no env.
    for key in ("ROSE_TOOLS_URL", "ROSE_TOOLS_TOKEN", "ROSE_TOOLS_ROSE_DESKTOP"):
        env.pop(key)
    rose_dir = Path(home) / ".rose"
    rose_dir.mkdir(parents=True, exist_ok=True)
    saved = {"url": fake.url, "token": TOKEN, "agents_url": fake.agents_url, "agents_token": AGENTS_TOKEN}
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


async def _wait_for(predicate: Any, timeout: float = 10) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("condition not reached")
        await asyncio.sleep(0.05)


async def test_mcp_server_lists_the_four_rose_tools():
    with FakeAgentTools() as fake, _home() as home:
        async with _mcp_server(fake, home) as mcp:
            listed = await mcp.response(await mcp.send("tools/list"))
            names = sorted(tool["name"] for tool in listed["result"]["tools"])
            assert names == ["change_environment_size", "display", "request_user_approval", "send_message_to_user"], names
            unknown = await mcp.response(await mcp.send("tools/call", {"name": "nope", "arguments": {}}))
            assert "error" in unknown, unknown


async def test_mcp_approval_blocks_across_long_polls_then_resumes():
    """request_user_approval waits with no deadline (progress per poll) and returns the answer."""
    with FakeAgentTools() as fake, _home() as home:
        async with _mcp_server(fake, home) as mcp:
            call_id = await mcp.send(
                "tools/call",
                {"name": "request_user_approval", "arguments": {"question": "Deploy to prod?"}, "_meta": {"progressToken": "p1"}},
            )
            await _wait_for(lambda: fake.requests and next(iter(fake.requests.values()))["polls"] >= 3)
            [request_id] = list(fake.requests)
            assert fake.requests[request_id]["kind"] == "approval"
            fake.answer(request_id, "Approved")
            result = await mcp.response(call_id)
            content = result["result"]["content"][0]["text"]
            assert result["result"]["isError"] is False and "The user approved" in content, result
            progress = [n for n in mcp.notifications if n.get("method") == "notifications/progress"]
            assert len(progress) >= 2, f"each pending poll is a liveness heartbeat: {mcp.notifications}"


async def test_mcp_pinned_question_from_non_root_spawn_asks_spawning_agent():
    """Route agent: the MCP tool asks via POST /api/agent-graph/questions and returns at once."""
    with FakeAgentTools(deliver_to="agent") as fake, _home() as home:
        async with _mcp_server(fake, home) as mcp:
            call_id = await mcp.send(
                "tools/call",
                {
                    "name": "display",
                    "arguments": {
                        "caption": "Proceed with migration?",
                        "placement": "pinned",
                        "options": [{"label": "Yes", "recommended": True}, {"label": "No"}],
                    },
                },
            )
            result = await mcp.response(call_id)
            text = result["result"]["content"][0]["text"]
            assert result["result"]["isError"] is False, result
            assert "Asked agent agent-parent" in text and "next message" in text, text
            [asked] = fake.graph_questions
            assert asked["question"] == "Proceed with migration?" and asked["allow_other"] is True, asked
            assert asked["options"][0] == {"label": "Yes", "recommended": True}, asked
            assert asked["message_id"].startswith("q-"), asked
            assert fake.requests == {}, "nothing pinned for the user"


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


async def test_cli_approve_resumes_same_request_after_interrupt():
    """A Bash-timeout kill mid-wait does not re-ask: re-running resumes the same request."""
    with FakeAgentTools() as fake, _home() as home:
        proc = await asyncio.create_subprocess_exec(
            shutil.which("node") or "node",
            str(ROSE_CLI),
            "approve",
            "Delete the staging branch?",
            env=_cli_env(fake, home),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await _wait_for(lambda: fake.requests and next(iter(fake.requests.values()))["polls"] >= 1)
        proc.send_signal(signal.SIGTERM)
        await proc.wait()
        [request_id] = list(fake.requests)
        rerun = asyncio.create_task(_cli(fake, home, "approve", "Delete the staging branch?"))
        await _wait_for(lambda: fake.creations[request_id] >= 2)
        await asyncio.sleep(0.3)
        assert not rerun.done(), "re-run blocks on the same request"
        fake.answer(request_id, "__REJECTED__")
        code, out, _err = await rerun
        assert list(fake.requests) == [request_id], "no second approval request"
        assert code == 2 and "rejected" in out, (code, out)


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
            assert sorted(tools) == ["change_environment_size", "display", "request_user_approval", "send_message_to_user"], tools
            assert set(tools["change_environment_size"]["inputSchema"]["properties"]) == {"cpu", "memory_gb", "reason"}
            assert list(tools["display"]["inputSchema"]["properties"]) == ["paths", "urls", "caption"]
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
        assert code == 1 and "at least one path or url" in err, (code, out, err)
        assert not [c for c in fake.calls if c["path"].endswith("/display")], fake.calls


async def run_all_tests():
    print("display blackbox tests:")
    r = BlackboxResult()
    try:
        await r.record_async("validation_errors_never_reach_the_backend", test_validation_errors_never_reach_the_backend)
        await r.record_async("stock_account_gets_inline_media_only", test_stock_account_gets_inline_media_only)
        await r.record_async(
            "inline_display_sends_items_and_reports_duplicates", test_inline_display_sends_items_and_reports_duplicates
        )
        await r.record_async("backend_type_errors_surface_as_tool_errors", test_backend_type_errors_surface_as_tool_errors)
        await r.record_async(
            "pinned_question_from_root_spawned_caller_goes_to_user_and_resumes",
            test_pinned_question_from_root_spawned_caller_goes_to_user_and_resumes,
        )
        await r.record_async(
            "pinned_question_from_deeper_caller_asks_spawning_agent",
            test_pinned_question_from_deeper_caller_asks_spawning_agent,
        )
        await r.record_async("pinned_retry_after_answer_returns_stored_answer", test_pinned_retry_after_answer_returns_stored_answer)
        await r.record_async(
            "pinned_question_blocks_and_resumes_in_production_sandbox",
            test_pinned_question_blocks_and_resumes_in_production_sandbox,
        )
        await r.record_async("mcp_server_lists_the_four_rose_tools", test_mcp_server_lists_the_four_rose_tools)
        await r.record_async(
            "mcp_approval_blocks_across_long_polls_then_resumes", test_mcp_approval_blocks_across_long_polls_then_resumes
        )
        await r.record_async(
            "mcp_pinned_question_from_non_root_spawn_asks_spawning_agent",
            test_mcp_pinned_question_from_non_root_spawn_asks_spawning_agent,
        )
        await r.record_async("cli_display_dedupes_by_content_hash", test_cli_display_dedupes_by_content_hash)
        await r.record_async("cli_type_and_limit_errors", test_cli_type_and_limit_errors)
        await r.record_async(
            "cli_approve_resumes_same_request_after_interrupt", test_cli_approve_resumes_same_request_after_interrupt
        )
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
