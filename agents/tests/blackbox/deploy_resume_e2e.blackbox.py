"""End-to-end proof that a deploy does not kill in-flight browser or Claude Code agents.

Prod agent 3efa7cae lost its browser task to a deploy: the worker machine was
stopped mid-task and the single-attempt activity died with it. Here real
Temporal workers run the real AgentWorkflow plus the real browser and Claude
Code activities. Only services outside the worker are faked: Steel/CDP, the
browser-use LLM, the backend's message and queue-pointer APIs, and the E2B
sandbox (the production ws-server.mjs on localhost with a scripted CLI).

Rolling deploy: a new machine starts polling the same queue and the old
worker is stopped the way worker.py's SIGTERM handler stops it,
``Worker.shutdown()`` with a grace period shorter than the remaining task.
Cooperative cutover: the backend's live queue pointer moves to the new
generation's queue while the old generation keeps running.

In both cases the task must finish on the new worker. It must continue from
the browser step or the sandbox where the deploy interrupted it, run each step
once, keep the same Steel session or sandbox, and never surface a pause,
cancellation, or DEPLOY_INTERRUPTED to the user.
"""

from __future__ import annotations

import asyncio
import contextlib
import copy
import contextvars
import importlib.util
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Awaitable, Callable, Optional
from unittest.mock import AsyncMock, patch

import httpx
from _test_utils import BlackboxResult, setup_mock_fn, teardown_mock
from temporalio import activity, workflow
from temporalio.client import Client
from temporalio.runtime import Runtime, TelemetryConfig
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import ActivityInboundInterceptor, ExecuteActivityInput, Interceptor, Worker

from domains.spawn_browser_agent_v3.handler import spawn_browser_agent_activity_v3
from domains.spawn_claude_code_agent.service import spawn_claude_code_activity
from helpers.activity_generation_drain import reset_live_queue_cache
from helpers.fetch_queue_pointer import fetch_agent_queue_pointer
from helpers.generation_handoff import DEPLOY_INTERRUPTED_TOOL_MESSAGE


def _load_sibling_suite(stem: str):
    path = Path(__file__).resolve().parent / f"{stem}.blackbox.py"
    spec = importlib.util.spec_from_file_location(f"deploy_resume_e2e_{stem}", path)
    assert spec is not None and spec.loader is not None, path
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# Workflow-side mocks (LLM turns, message rows, billing) and the local Claude
# Code sandbox are shared with the suites that test each boundary on its own.
wf = _load_sibling_suite("workflow")
cc = _load_sibling_suite("spawn_claude_code_agent")

ROLLING_QUEUE = "deploy-e2e-rolling"
OLD_GENERATION_QUEUE = "deploy-e2e-gen-old"
NEW_GENERATION_QUEUE = "deploy-e2e-gen-new"

BROWSER_STEPS = 16  # browser-use LLM turns; the last one is attempt_completion
DEPLOY_AT_STEP = 3
STEP_SECONDS = 0.4
# Shorter than the steps left after the deploy lands, the way Fly's stop
# timeout is shorter than a browser task.
BROWSER_DEPLOY_GRACE = timedelta(seconds=3)
# Claude Code checks for a drain once per DRAIN_CHECK_INTERVAL_S (1s).
CODE_DEPLOY_GRACE = timedelta(seconds=4)
STEP_PROMPT_TOKENS = 900

BROWSER_TOOL_CALL = {
    "tool": "spawn_agent",
    "type": "browser",
    "goal": "Buy the $12 item on shop.example.com and report the confirmation number",
    "start_url": "https://shop.example.com",
    "output_schema": {"fields": [{"name": "confirmation", "type": "str", "required": True}]},
}

ACTIVITIES = [
    mock
    for mock in wf.MOCK_ACTIVITIES
    if mock
    not in {
        wf.mock_spawn_browser_agent_activity_v3,
        wf.mock_spawn_claude_code_activity,
        wf.mock_fetch_agent_queue_pointer,
    }
] + [spawn_browser_agent_activity_v3, spawn_claude_code_activity, fetch_agent_queue_pointer]

_WORKER_LABEL: contextvars.ContextVar[str] = contextvars.ContextVar("deploy_e2e_worker", default="unlabeled")


class _LabeledActivities(Interceptor):
    """Tag every activity with the machine running it and record how it ended."""

    def __init__(self, label: str, outcomes: list[tuple[str, str, Any]]) -> None:
        self.label = label
        self.outcomes = outcomes

    def intercept_activity(self, next: ActivityInboundInterceptor) -> ActivityInboundInterceptor:
        return _LabeledInbound(next, self.label, self.outcomes)


class _LabeledInbound(ActivityInboundInterceptor):
    def __init__(self, next: ActivityInboundInterceptor, label: str, outcomes: list[tuple[str, str, Any]]) -> None:
        super().__init__(next)
        self._label = label
        self._outcomes = outcomes

    async def execute_activity(self, input: ExecuteActivityInput) -> Any:
        name = activity.info().activity_type
        token = _WORKER_LABEL.set(self._label)
        try:
            result = await super().execute_activity(input)
        except BaseException as exc:
            self._outcomes.append((self._label, name, f"raised {type(exc).__name__}: {exc}"))
            raise
        finally:
            _WORKER_LABEL.reset(token)
        self._outcomes.append((self._label, name, result.get("status") if isinstance(result, dict) else result))
        return result


def _long_activity_outcomes(outcomes: list[tuple[str, str, Any]], name: str) -> list[tuple[str, Any]]:
    return [(label, status) for label, activity_name, status in outcomes if activity_name == name]


class _Backend:
    """The backend and Supabase as the workers see them: live queue pointer, browser control, realtime."""

    def __init__(self, live_queue: str) -> None:
        self.live_queue = live_queue
        self.unexpected: list[str] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/api/agent-queue-pointer":
            return httpx.Response(200, json={"taskQueue": self.live_queue, "surfaceHash": "deploy-e2e"})
        if request.method == "GET" and path.startswith("/api/agents/"):
            agent_id = path.removeprefix("/api/agents/")
            if agent_id in wf.CUTOVER_MESSAGES:
                raw_since = request.url.params.get("since")
                since = datetime.fromisoformat(raw_since.replace("Z", "+00:00")) if raw_since else None
                rows = [
                    {key: value for key, value in row.items() if key != "task_queue"}
                    for row in wf.CUTOVER_MESSAGES[agent_id]
                    if since is None or datetime.fromisoformat(row["timestamp"].replace("Z", "+00:00")) > since
                ]
                rows.sort(key=lambda row: (row["timestamp"], row["id"]))
                return httpx.Response(200, json={"agent": {"id": agent_id}, "messages": rows})
        if request.method == "GET" and path.startswith("/api/browser-session/task/") and path.endswith("/control"):
            return httpx.Response(200, json={"state": "agent"})
        if request.method == "GET" and path == "/api/claude-code-session/credential-availability":
            # C15: a fresh code-agent spawn asks which provider has a leasable credential.
            return httpx.Response(200, json={"claude": True, "codex": True})
        if request.method == "POST" and path == "/realtime/v1/api/broadcast":
            return httpx.Response(202, json={})
        self.unexpected.append(f"{request.method} {request.url}")
        return httpx.Response(404, json={"error": "not served by the deploy e2e backend"})

    def move_pointer(self, queue: str) -> None:
        self.live_queue = queue
        # Workers cache the pointer for POINTER_CACHE_SECONDS; model that window elapsing.
        reset_live_queue_cache()


@contextlib.contextmanager
def _replay_stable_workflow_clock():
    """Give workflows Temporal's deterministic uuid4/now while machines replay each other's history.

    ``_test_utils`` stubs both process-wide so workflow helpers can run outside
    a worker. A new machine replays the old machine's history, and a random
    uuid4 on replay would mint a different tool call id than the one in flight.
    """
    outside_uuid4 = workflow.uuid4
    outside_now = workflow.now

    def uuid4() -> uuid.UUID:
        if workflow.in_workflow():
            return uuid.UUID(bytes=workflow.random().getrandbits(128).to_bytes(16, "big"), version=4)
        return outside_uuid4()

    def now() -> datetime:
        if workflow.in_workflow():
            return datetime.fromtimestamp(workflow.time(), timezone.utc)
        return outside_now()

    with patch.object(workflow, "uuid4", side_effect=uuid4), patch.object(workflow, "now", side_effect=now):
        yield


@contextlib.asynccontextmanager
async def _deploy_environment(backend: _Backend):
    reset_live_queue_cache()
    setup_mock_fn(backend.handle)
    try:
        with _replay_stable_workflow_clock():
            async with await WorkflowEnvironment.start_time_skipping() as env:
                yield env
    finally:
        reset_live_queue_cache()
        teardown_mock()


class _Machine:
    """One worker machine. ``sigterm`` stops it the way worker.py's SIGTERM handler does."""

    def __init__(self, worker: Worker) -> None:
        self.worker = worker
        self._task: Optional[asyncio.Task] = None

    @classmethod
    async def boot(
        cls, env: WorkflowEnvironment, queue: str, label: str, outcomes: list, **worker_kwargs: Any
    ) -> "_Machine":
        # A separate process per machine: its own SDK runtime and server connection.
        client = await Client.connect(
            env.client.service_client.config.target_host,
            namespace=env.client.namespace,
            runtime=Runtime(telemetry=TelemetryConfig()),
        )
        worker = Worker(
            client,
            task_queue=queue,
            workflows=[wf.AgentWorkflow],
            activities=ACTIVITIES,
            workflow_runner=wf._WORKFLOW_RUNNER,
            interceptors=[_LabeledActivities(label, outcomes)],
            **worker_kwargs,
        )
        return cls(worker)

    async def start(self) -> None:
        self._task = asyncio.create_task(self.worker.run())
        while not self.worker.is_running:
            if self._task.done():
                await self._task
            await asyncio.sleep(0.01)

    async def sigterm(self) -> float:
        """Stop polling, let in-flight activities finish within the grace, and return how long that took."""
        started = time.monotonic()
        await self.worker.shutdown()
        elapsed = time.monotonic() - started
        await self._join()
        return elapsed

    async def stop(self) -> None:
        if self._task is None:
            return
        if not self._task.done():
            await asyncio.wait_for(self.worker.shutdown(), timeout=30)
        await self._join()

    async def _join(self) -> None:
        if self._task is not None:
            with contextlib.suppress(asyncio.CancelledError):
                await asyncio.wait_for(self._task, timeout=10)


async def _until(predicate: Callable[[], bool], what: str, timeout: float = 30.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out after {timeout}s waiting for {what}")
        await asyncio.sleep(0.02)


def _opt_in_agent(agent_id: str, workflow_id: str, tool_call: dict) -> None:
    wf._opt_in_cutover_agent(agent_id, workflow_id, {}, tool_call=tool_call)


async def _start_agent(client, agent_id: str, workflow_id: str, task_queue: str):
    return await client.start_workflow(
        wf.AgentWorkflow.run,
        args=[
            agent_id,
            "user-test-1",
            "Finish the delegated task",
            "rose-labs/rose-1-flash",
            256,
            {"type": "FLOAT_LLM_JUDGE"},
            None,  # context
            None,  # parent_workflow_id
            None,  # parent_agent_id
            0,  # depth
            None,  # bus_id
            "execute",  # start_phase
        ],
        id=workflow_id,
        task_queue=task_queue,
    )


async def _run_to_completion(handle) -> dict:
    try:
        outcome = await asyncio.wait_for(handle.result(), timeout=90)
    except BaseException:
        await wf._cancel_workflow(handle)
        raise
    assert isinstance(outcome, dict) and outcome.get("status") == "completed", f"the agent did not complete: {outcome}"
    return outcome


def _tool_chips(agent_id: str) -> list[dict]:
    return wf.CUTOVER_MESSAGES[agent_id]


def _assert_no_deploy_interruption(agent_id: str) -> None:
    rows = _tool_chips(agent_id)
    assert not any(DEPLOY_INTERRUPTED_TOOL_MESSAGE in (row["text"] or "") for row in rows), (
        "the deploy closed the tool with DEPLOY_INTERRUPTED"
    )


# ── Browser ──────────────────────────────────────────────────────────────────


class _FakeHumanizer:
    def __init__(self, *args, **kwargs):
        self.cursor_observer = None

    def set_cursor_observer(self, observer):
        self.cursor_observer = observer

    async def initialize_cursor(self, *args, **kwargs):
        return None

    def start_idle_movement(self):
        return None

    async def close(self):
        return None


class _FakeAsyncPlaywright:
    def __init__(self, browser):
        self._instance = SimpleNamespace(
            chromium=SimpleNamespace(connect_over_cdp=AsyncMock(return_value=browser)),
            stop=AsyncMock(),
        )

    async def start(self):
        return self._instance


class _BrowserServices:
    """Steel, the CDP-driven page, and the browser-use LLM, shared by every machine like the real services."""

    SESSION = {
        "task_id": None,
        "session_id": "steel-session-1",
        "debug_url": "https://steel.example/debug/1",
        "ws_url": "wss://steel.example/cdp/1",
        "fingerprint_injection": None,
        "passwords": [],
        "auth_options": {"realm": "shop.example.com"},
        "browser_session_metadata": {"provider": "steel", "profile_id": "profile-1"},
        "user_settings": {},
    }

    def __init__(self, on_deploy_step: Callable[[], Awaitable[None]]) -> None:
        self.on_deploy_step = on_deploy_step
        self.llm_turns: list[str] = []
        self.llm_pools: list[str] = []
        self.steps: list[str] = []
        self.session_inits: list[str] = []
        self.session_lookups: list[tuple[str, str]] = []
        self.session_closes: list[tuple[str, str, bool]] = []
        self.cdp_connections: list[tuple[str, str]] = []
        self.verifications: list[str] = []

    async def init_session(self, config, user_id, agent_id, start_url, *, task_id=None):
        self.session_inits.append(_WORKER_LABEL.get())
        return {**copy.deepcopy(self.SESSION), "task_id": task_id}

    async def fetch_session_info(self, config, task_id, validate_live=False):
        self.session_lookups.append((_WORKER_LABEL.get(), task_id))
        return {
            **copy.deepcopy(self.SESSION),
            "task_id": task_id,
            "same_session_available": True,
            "browser_session_health": {
                "provider": "steel",
                "sessionId": self.SESSION["session_id"],
                "status": "live",
                "ttlMs": 3_600_000,
            },
        }

    async def close_session(self, config, session_id, pause=False, current_url=""):
        self.session_closes.append((_WORKER_LABEL.get(), session_id, pause))

    async def llm_step(self, *args, **kwargs):
        self.llm_turns.append(_WORKER_LABEL.get())
        self.llm_pools.append(kwargs.get("pool"))
        usage = {"prompt_tokens": STEP_PROMPT_TOKENS, "completion_tokens": 60, "actual_model": "rose-1-browser-use"}
        if len(self.llm_turns) >= BROWSER_STEPS:
            action = {
                "action": "attempt_completion",
                "thinking": "The order confirmation page shows SHOP-4242.",
                "params": {"reasoning": "Order placed, confirmation SHOP-4242"},
            }
        else:
            action = {"action": "scroll", "thinking": "Working through checkout", "params": {"direction": "down"}}
        return {"action": action, "usage": usage, "mode": "waterfall"}

    async def execute_action(self, *args, **kwargs):
        step = len(self.steps) + 1
        self.steps.append(_WORKER_LABEL.get())
        if step == DEPLOY_AT_STEP:
            await self.on_deploy_step()
        await asyncio.sleep(STEP_SECONDS)
        return {
            "success": True,
            "message": f"Checkout section {step}",
            "current_url": f"https://shop.example.com/checkout?section={step}",
        }

    async def verify(self, *args, **kwargs):
        self.verifications.append(_WORKER_LABEL.get())
        return {
            "score": 1.0,
            "reasoning": "Order SHOP-4242 is confirmed on the page",
            "structured_response": {"confirmation": "SHOP-4242"},
            "usage": {},
        }

    def dom_service_class(self):
        services = self

        class _DomService:
            def __init__(self, cdp_url, downloads_path="/tmp/downloads"):
                self.cdp_url = cdp_url
                self.downloads_path = downloads_path
                self.session = SimpleNamespace(get_current_page=AsyncMock(return_value=SimpleNamespace()))
                self._session = SimpleNamespace(
                    get_or_create_cdp_session=AsyncMock(side_effect=RuntimeError("no logo overlay"))
                )
                self.selector_map = {}
                self.disconnect = AsyncMock()

            async def connect(self):
                services.cdp_connections.append((_WORKER_LABEL.get(), self.cdp_url))

            async def get_browser_state(self, include_screenshot=False):
                return {"url": "https://shop.example.com/checkout", "screenshot": None}

            async def get_page_identity(self):
                return {"url": "https://shop.example.com/checkout", "title": ""}

            async def get_current_url(self, *, fallback: str = ""):
                return fallback or "https://shop.example.com/checkout"

            async def ensure_browser_overlays_suppressed(self):
                return None

            def start_captcha_telemetry_indicator(self, poll_phase):
                return None

        return _DomService

    @contextlib.contextmanager
    def patched(self):
        handler = "domains.spawn_browser_agent_v3.handler"
        browser = SimpleNamespace(contexts=[SimpleNamespace(pages=[SimpleNamespace()])], close=AsyncMock())
        config = SimpleNamespace(
            backend=SimpleNamespace(api_url="https://backend.example.com", api_key="test-backend-key"),
            rose=SimpleNamespace(api_url="https://rose.example.com", api_key="rose-key", supabase_anon_key="anon"),
            payment=SimpleNamespace(decryption_key=""),
            openrouter=SimpleNamespace(api_key="or-key", base_url="https://openrouter.example.com/api/v1"),
        )
        with contextlib.ExitStack() as stack:
            for target, replacement in [
                (f"{handler}.load_config", lambda *a, **kw: config),
                (f"{handler}.init_browser_session", self.init_session),
                (f"{handler}.fetch_session_info", self.fetch_session_info),
                (f"{handler}.resume_browser_session", AsyncMock(side_effect=AssertionError("Steel session replaced"))),
                (f"{handler}.close_browser_session", self.close_session),
                (f"{handler}._call_browser_use_with_rotation", self.llm_step),
                (f"{handler}.execute_action", self.execute_action),
                (f"{handler}.call_temporal_activity_from_activity", self.verify),
                (f"{handler}.fetch_recent_otps", AsyncMock(return_value=[])),
                (
                    f"{handler}.get_model_pricing_with_fallback",
                    AsyncMock(return_value={"input_cents_per_1k": 0, "output_cents_per_1k": 0}),
                ),
                (f"{handler}.build_browser_verifier_context", AsyncMock(return_value=[])),
                (f"{handler}.extract_session_files", AsyncMock(return_value=[])),
                (f"{handler}.disconnect_browser_after_passkey_capture", AsyncMock()),
                (
                    f"{handler}.propagate_browser_run_credentials",
                    AsyncMock(return_value={"outcome": "unknown", "refs": 0, "applied": 0}),
                ),
                (f"{handler}.save_browser_action_message", AsyncMock()),
                (f"{handler}.save_browser_assistant_message", AsyncMock()),
                (f"{handler}.live_tab_looks_challenged", AsyncMock(return_value=False)),
                ("browser_tools.dom_service.DOMService", self.dom_service_class()),
                ("browser_tools.humanizer.BrowserHumanizer", _FakeHumanizer),
                ("playwright.async_api.async_playwright", lambda: _FakeAsyncPlaywright(browser)),
            ]:
                stack.enter_context(patch(target, replacement))
            yield


def _assert_browser_task_resumed(agent_id: str, browser: _BrowserServices, old: str, new: str) -> None:
    rows = _tool_chips(agent_id)
    titles = [row["metadata"].get("title") for row in rows]
    complete = [row for row in rows if row["metadata"].get("title") == "Browser automation complete"]
    assert len(complete) == 1, f"the browser task must finish exactly once; chips={titles}"
    assert complete[0]["metadata"].get("toolStatus") == "FINISHED", complete[0]["metadata"]
    assert complete[0]["metadata"].get("structured_response") == {"confirmation": "SHOP-4242"}, complete[0]["metadata"]
    assert "Browser Session Paused" not in titles, f"the deploy paused the browser task; chips={titles}"
    _assert_no_deploy_interruption(agent_id)
    assert titles.count("Starting up a browser") == 1, f"the browser task started more than once; chips={titles}"

    executed = BROWSER_STEPS - 1
    assert browser.steps == [old] * DEPLOY_AT_STEP + [new] * (executed - DEPLOY_AT_STEP), (
        f"steps 1-{DEPLOY_AT_STEP} must run on {old} and steps {DEPLOY_AT_STEP + 1}-{executed} on {new}, "
        f"each exactly once; got {browser.steps}"
    )
    assert browser.llm_turns == [old] * DEPLOY_AT_STEP + [new] * (BROWSER_STEPS - DEPLOY_AT_STEP), (
        f"each browser-use turn must run once, none repeated after the deploy; got {browser.llm_turns}"
    )
    # The flash root's browser agent runs every step on the root's pool.
    assert browser.llm_pools == ["rose-1-flash"] * BROWSER_STEPS, browser.llm_pools
    assert browser.verifications == [new], browser.verifications
    assert browser.session_inits == [old], f"the task must keep its Steel session; inits={browser.session_inits}"
    task_ids = {task_id for _, task_id in browser.session_lookups}
    assert [label for label, _ in browser.session_lookups] == [new] and len(task_ids) == 1, browser.session_lookups
    session_cdp = _BrowserServices.SESSION["ws_url"]
    assert browser.cdp_connections == [(old, session_cdp), (new, session_cdp)], (
        f"{new} must reattach to the same live browser; got {browser.cdp_connections}"
    )
    session_id = _BrowserServices.SESSION["session_id"]
    assert browser.session_closes == [(new, session_id, False)], (
        f"the Steel session must close once, when the task finishes; got {browser.session_closes}"
    )

    billed_prompt_tokens = [
        item.get("tokens_in")
        for record in wf.CUTOVER_USAGE[agent_id]
        for item in record["usage_items"]
        # The fake steps report no transport model, so they bill at the inherited pool.
        if item.get("type") == "llm" and item.get("model") == "rose-1-flash"
    ]
    assert billed_prompt_tokens == [
        DEPLOY_AT_STEP * STEP_PROMPT_TOKENS,
        (BROWSER_STEPS - DEPLOY_AT_STEP) * STEP_PROMPT_TOKENS,
    ], (
        "each browser-use turn must be billed exactly once: the old worker's turns when it hands the task "
        f"back, the new worker's when it finishes; billed {billed_prompt_tokens}"
    )


def _assert_activity_handoff(outcomes: list, name: str, yielded_status: str, old: str, new: str) -> None:
    runs = _long_activity_outcomes(outcomes, name)
    assert runs == [(old, yielded_status), (new, "completed")], (
        f"{old} must hand the task back at a checkpoint and {new} must finish it; got {runs}"
    )


async def test_rolling_deploy_resumes_browser_task_on_the_new_machine() -> None:
    agent_id = "agent-deploy-rolling-browser"
    workflow_id = f"deploy-rolling-browser-{uuid.uuid4().hex[:8]}"
    backend = _Backend(ROLLING_QUEUE)
    outcomes: list = []
    deploy_landed = asyncio.Event()

    async def sigterm_lands_mid_step() -> None:
        deploy_landed.set()
        await _until(activity.is_worker_shutdown, "the old machine to begin graceful shutdown")

    browser = _BrowserServices(sigterm_lands_mid_step)
    _opt_in_agent(agent_id, workflow_id, BROWSER_TOOL_CALL)
    async with _deploy_environment(backend) as env:
        old = await _Machine.boot(
            env,
            ROLLING_QUEUE,
            "old-machine",
            outcomes,
            graceful_shutdown_timeout=BROWSER_DEPLOY_GRACE,
            max_cached_workflows=0,
        )
        new = await _Machine.boot(env, ROLLING_QUEUE, "new-machine", outcomes)
        with browser.patched():
            try:
                await old.start()
                handle = await _start_agent(env.client, agent_id, workflow_id, ROLLING_QUEUE)
                await asyncio.wait_for(deploy_landed.wait(), timeout=60)
                await new.start()
                drained_in = await old.sigterm()
                await _run_to_completion(handle)
            finally:
                await old.stop()
                await new.stop()

    print(
        f"    old machine stopped {drained_in:.2f}s after SIGTERM (grace {BROWSER_DEPLOY_GRACE.total_seconds():.0f}s)"
    )
    _assert_browser_task_resumed(agent_id, browser, "old-machine", "new-machine")
    # SDK shutdown also closes its polling/runtime machinery after activities
    # yield. Require the joined worker and exact handoff below; elapsed shutdown
    # time does not establish activity cancellation.
    assert old._task is not None and old._task.done(), "the old worker did not join"
    from domains.spawn_browser_agent_v3.config import BROWSER_DRAIN_YIELD_STATUS

    _assert_activity_handoff(
        outcomes, "spawn_browser_agent_activity_v3", BROWSER_DRAIN_YIELD_STATUS, "old-machine", "new-machine"
    )
    assert not backend.unexpected, f"unexpected backend calls: {backend.unexpected}"


async def test_cutover_resumes_browser_task_on_the_new_generation() -> None:
    agent_id = "agent-deploy-cutover-browser"
    workflow_id = f"deploy-cutover-browser-{uuid.uuid4().hex[:8]}"
    backend = _Backend(OLD_GENERATION_QUEUE)
    outcomes: list = []

    async def pointer_moves_mid_step() -> None:
        backend.move_pointer(NEW_GENERATION_QUEUE)

    browser = _BrowserServices(pointer_moves_mid_step)
    _opt_in_agent(agent_id, workflow_id, BROWSER_TOOL_CALL)
    async with _deploy_environment(backend) as env:
        old = await _Machine.boot(env, OLD_GENERATION_QUEUE, "old-generation", outcomes)
        new = await _Machine.boot(env, NEW_GENERATION_QUEUE, "new-generation", outcomes)
        with browser.patched():
            try:
                await old.start()
                await new.start()
                handle = await _start_agent(env.client, agent_id, workflow_id, OLD_GENERATION_QUEUE)
                await _run_to_completion(handle)
            finally:
                await old.stop()
                await new.stop()

    _assert_browser_task_resumed(agent_id, browser, "old-generation", "new-generation")
    rows = _tool_chips(agent_id)
    started = [row for row in rows if row["metadata"].get("title") == "Starting up a browser"]
    finished = [row for row in rows if row["metadata"].get("title") == "Browser automation complete"]
    assert started[0]["task_queue"] == OLD_GENERATION_QUEUE, started[0]
    assert finished[0]["task_queue"] == NEW_GENERATION_QUEUE, "the task must finish on the live generation"
    from domains.spawn_browser_agent_v3.config import BROWSER_DRAIN_YIELD_STATUS

    _assert_activity_handoff(
        outcomes, "spawn_browser_agent_activity_v3", BROWSER_DRAIN_YIELD_STATUS, "old-generation", "new-generation"
    )
    assert not backend.unexpected, f"unexpected backend calls: {backend.unexpected}"


# ── Claude Code ──────────────────────────────────────────────────────────────


@contextlib.contextmanager
def _code_sandbox_services(recorder):
    from domains.spawn_claude_code_agent import service

    with (
        patch.object(service, "create_e2b_session", side_effect=recorder.create_session),
        patch.object(service, "close_e2b_session", side_effect=recorder.close_session),
        patch.object(service, "save_claude_code_message", side_effect=recorder.save_message),
        patch.object(service, "save_code_transcript_batch", side_effect=recorder.save_transcript),
        patch.object(service, "persist_terminal_output", side_effect=recorder.persist_output),
        patch.object(service, "_run_verifier", side_effect=recorder.verifier),
        patch.object(service, "_log_code_agent_event", side_effect=lambda event, **kw: recorder.logged.append(event)),
        patch.object(service, "SandboxLogCollector", lambda *a, **kw: recorder.collector),
        patch.object(service, "_resolve_claude_token_for_activity", AsyncMock(return_value=None)),
        patch(
            "helpers.model_pricing.get_model_pricing_with_fallback",
            AsyncMock(return_value={"input_cents_per_1k": 0, "output_cents_per_1k": 0}),
        ),
    ):
        yield


def _claude_code_wrote_first_step(recorder) -> bool:
    return any(
        event.get("type") == "agent_message" and event.get("text") == cc._CC_STEP_TEXTS[0] for event in recorder.logged
    )


def _assert_code_task_reattached(agent_id: str, recorder) -> None:
    rows = _tool_chips(agent_id)
    titles = [row["metadata"].get("title") for row in rows]
    complete = [row for row in rows if row["metadata"].get("title") == "✓ Task Completed"]
    assert len(complete) == 1, f"the code task must finish exactly once; chips={titles}"
    assert complete[0]["metadata"].get("structured_response") == {"answer": "42"}, complete[0]["metadata"]
    assert not any(title in {"Task Incomplete", "Code session failed"} for title in titles), titles
    _assert_no_deploy_interruption(agent_id)
    assert titles.count("Starting Claude Code sandbox") == 1, titles

    assert len(recorder.created) == 1, f"the deploy must not start another sandbox; created={recorder.created}"
    assert "Session Cancelled" not in recorder.titles, recorder.titles
    assert recorder.titles.count("Claude Code Started") == 1, recorder.titles
    assert len(recorder.verified_events) == 1, recorder.verified_events
    cc._assert_full_run_seen_once(recorder.verified_events[0])
    assert [call["task_id"] for call in recorder.closed] == ["cc-task-1"], (
        f"the sandbox must close once, after the run finished; closed={recorder.closed}"
    )
    # The transcript survives the move: the new worker persists only the event
    # range the old one had not, and the rows end on the run's final records.
    ranges = [(batch["events_from"], batch["events_to"]) for batch in recorder.transcripts]
    assert ranges and ranges[0][0] == 0, ranges
    assert all(ranges[i][1] == ranges[i + 1][0] for i in range(len(ranges) - 1)), ranges
    latest: dict = {}
    for batch in recorder.transcripts:
        for record in batch["records"]:
            latest[record["id"]] = record
    texts = [r["text"] for r in sorted(latest.values(), key=lambda r: r["seq"]) if r["type"] == "message"]
    assert texts[-2:] == cc._CC_STEP_TEXTS, texts


async def test_rolling_deploy_reattaches_claude_code_on_the_new_machine() -> None:
    agent_id = "agent-deploy-rolling-code"
    workflow_id = f"deploy-rolling-code-{uuid.uuid4().hex[:8]}"
    backend = _Backend(ROLLING_QUEUE)
    outcomes: list = []
    sandbox = cc._LocalCodeSandbox()
    await sandbox.start()
    recorder = cc._CCBoundaryRecorder(sandbox.ws_url)
    _opt_in_agent(agent_id, workflow_id, wf.CUTOVER_CODE_TOOL_CALL)
    try:
        async with _deploy_environment(backend) as env:
            old = await _Machine.boot(
                env,
                ROLLING_QUEUE,
                "old-machine",
                outcomes,
                graceful_shutdown_timeout=CODE_DEPLOY_GRACE,
                max_cached_workflows=0,
            )
            new = await _Machine.boot(env, ROLLING_QUEUE, "new-machine", outcomes)
            with _code_sandbox_services(recorder):
                try:
                    await old.start()
                    handle = await _start_agent(env.client, agent_id, workflow_id, ROLLING_QUEUE)
                    await _until(lambda: _claude_code_wrote_first_step(recorder), "Claude Code's first step", 60)
                    await new.start()
                    drained_in = await old.sigterm()
                    # Claude Code keeps working in the sandbox whatever the workers do.
                    sandbox.release("continue")
                    sandbox.release("exit")
                    await _run_to_completion(handle)
                finally:
                    await old.stop()
                    await new.stop()
    finally:
        sandbox.stop()

    print(f"    old machine stopped {drained_in:.2f}s after SIGTERM (grace {CODE_DEPLOY_GRACE.total_seconds():.0f}s)")
    _assert_code_task_reattached(agent_id, recorder)
    # SDK shutdown also closes its polling/runtime machinery after activities
    # yield. Require the joined worker and exact handoff below; elapsed shutdown
    # time does not establish activity cancellation.
    assert old._task is not None and old._task.done(), "the old worker did not join"
    from domains.spawn_claude_code_agent.config import CODE_AGENT_DRAIN_YIELD_STATUS

    _assert_activity_handoff(
        outcomes, "spawn_claude_code_activity", CODE_AGENT_DRAIN_YIELD_STATUS, "old-machine", "new-machine"
    )
    assert not backend.unexpected, f"unexpected backend calls: {backend.unexpected}"


async def test_cutover_reattaches_claude_code_on_the_new_generation() -> None:
    agent_id = "agent-deploy-cutover-code"
    workflow_id = f"deploy-cutover-code-{uuid.uuid4().hex[:8]}"
    backend = _Backend(OLD_GENERATION_QUEUE)
    outcomes: list = []
    sandbox = cc._LocalCodeSandbox()
    await sandbox.start()
    recorder = cc._CCBoundaryRecorder(sandbox.ws_url)
    _opt_in_agent(agent_id, workflow_id, wf.CUTOVER_CODE_TOOL_CALL)
    try:
        async with _deploy_environment(backend) as env:
            old = await _Machine.boot(env, OLD_GENERATION_QUEUE, "old-generation", outcomes)
            new = await _Machine.boot(env, NEW_GENERATION_QUEUE, "new-generation", outcomes)
            with _code_sandbox_services(recorder):
                try:
                    await old.start()
                    await new.start()
                    handle = await _start_agent(env.client, agent_id, workflow_id, OLD_GENERATION_QUEUE)
                    await _until(lambda: _claude_code_wrote_first_step(recorder), "Claude Code's first step", 60)
                    backend.move_pointer(NEW_GENERATION_QUEUE)
                    await _until(
                        lambda: _long_activity_outcomes(outcomes, "spawn_claude_code_activity"),
                        "the old generation to release the Claude Code run after the pointer moved",
                        15,
                    )
                    sandbox.release("continue")
                    sandbox.release("exit")
                    await _run_to_completion(handle)
                finally:
                    await old.stop()
                    await new.stop()
    finally:
        sandbox.stop()

    _assert_code_task_reattached(agent_id, recorder)
    rows = _tool_chips(agent_id)
    started = [row for row in rows if row["metadata"].get("title") == "Starting Claude Code sandbox"]
    finished = [row for row in rows if row["metadata"].get("title") == "✓ Task Completed"]
    assert started[0]["task_queue"] == OLD_GENERATION_QUEUE, started[0]
    assert finished[0]["task_queue"] == NEW_GENERATION_QUEUE, "the code task must finish on the live generation"
    from domains.spawn_claude_code_agent.config import CODE_AGENT_DRAIN_YIELD_STATUS

    _assert_activity_handoff(
        outcomes, "spawn_claude_code_activity", CODE_AGENT_DRAIN_YIELD_STATUS, "old-generation", "new-generation"
    )
    assert not backend.unexpected, f"unexpected backend calls: {backend.unexpected}"


async def run_all_tests() -> bool:
    print("deploy-resume e2e blackbox tests:")
    result = BlackboxResult()
    await result.record_async(
        "rolling_deploy_resumes_browser_task_on_the_new_machine",
        test_rolling_deploy_resumes_browser_task_on_the_new_machine,
    )
    await result.record_async(
        "cutover_resumes_browser_task_on_the_new_generation",
        test_cutover_resumes_browser_task_on_the_new_generation,
    )
    await result.record_async(
        "rolling_deploy_reattaches_claude_code_on_the_new_machine",
        test_rolling_deploy_reattaches_claude_code_on_the_new_machine,
    )
    await result.record_async(
        "cutover_reattaches_claude_code_on_the_new_generation",
        test_cutover_reattaches_claude_code_on_the_new_generation,
    )
    teardown_mock()
    return result.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
