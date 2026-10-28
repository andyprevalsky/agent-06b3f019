"""
Shared utilities for blackbox tests.

Sets up the import path, loads .env, installs the capture harness,
and provides mock response helpers.
"""

import inspect
import json
import contextlib
import os
import sys
import traceback
from pathlib import Path
from typing import Any, Callable

# Setup path so we can import from agents root
AGENTS_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(AGENTS_ROOT))

from dotenv import load_dotenv

load_dotenv(AGENTS_ROOT / ".env")

# Activate capture mode
os.environ["BLACKBOX_TEST_CAPTURE_OUTBOUND"] = "1"
# Most blackbox tests mock only the specific provider path they exercise. Do not
# let a developer's funded GPT fallback key from agents/.env alter route order
# process-wide; tests that cover that route set GPT_API_KEY explicitly.
os.environ["GPT_API_KEY"] = ""
# Likewise, only Foundry-specific tests opt into the funded Azure route; real
# provider replays (declared LLM judges) opt back in with live_funded_azure().
# Every regional key (AZURE_FOUNDRY_API_KEY and _2.._9) is blanked together.
_FOUNDRY_KEY_NAMES = ("AZURE_FOUNDRY_API_KEY", *(f"AZURE_FOUNDRY_API_KEY_{slot}" for slot in range(2, 10)))
_LIVE_AZURE_FOUNDRY_API_KEYS = {name: os.environ.get(name, "") for name in _FOUNDRY_KEY_NAMES}
for _name in _FOUNDRY_KEY_NAMES:
    os.environ[_name] = ""


@contextlib.contextmanager
def live_funded_azure():
    """Restore the developer's funded Azure Foundry keys for a real-provider replay.

    Production judges reach Foundry after direct credentials; a live replay must
    use the same funded route instead of depending on OpenRouter credit alone.
    """
    previous = {name: os.environ.get(name) for name in _FOUNDRY_KEY_NAMES}
    os.environ.update(_LIVE_AZURE_FOUNDRY_API_KEYS)
    try:
        yield
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


import httpx
from helpers.httpx_capture import (
    clear_captures,
    clear_mock_handler,
    get_captures,
    install_capture,
    set_mock_handler,
)

# Install capture harness once at import time
install_capture()

# Stub Temporal's replay-stable workflow clock (workflow.uuid4/workflow.now) so
# workflow-scope code — loop.run_agent, loop.dag_executor, workflows.agent_workflow —
# can be unit-tested outside a real workflow event loop. Those APIs raise
# "Not in workflow event loop" when called directly; production keeps the real
# deterministic implementations. Blackbox tests never execute inside a workflow,
# so a process-wide stub is correct. Started (not stopped) for the test process.
import uuid as _uuid
from datetime import datetime as _dt
from datetime import timezone as _tz
from unittest.mock import patch as _patch

import temporalio.workflow as _temporal_workflow

_real_workflow_uuid4 = _temporal_workflow.uuid4


def _replay_stable_uuid4() -> _uuid.UUID:
    # Inside a real test workflow keep Temporal's deterministic uuid4: a random
    # id there changes tool-call ids whenever the worker replays history (a
    # sticky-cache miss under load), so a resumed tool looks like a new call.
    if _temporal_workflow.in_workflow():
        return _real_workflow_uuid4()
    return _uuid.uuid4()


_patch.object(_temporal_workflow, "uuid4", side_effect=_replay_stable_uuid4).start()
_patch.object(_temporal_workflow, "now", return_value=_dt(2026, 1, 1, tzinfo=_tz.utc)).start()


def setup_mock(routes: dict[str, dict[str, Any]]) -> None:
    """
    Configure mock HTTP responses for outbound calls.

    routes: dict mapping URL substrings to response configs.
    Example:
        setup_mock({
            "supermemory.ai/v3/documents": {
                "status": 200,
                "json": {"document_id": "doc-123"}
            },
            "api.parallel.ai/v1/search": {
                "status": 200,
                "json": {"results": []}
            }
        })
    """

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        for pattern, config in routes.items():
            if pattern in url:
                return httpx.Response(
                    status_code=config.get("status", 200),
                    json=config.get("json"),
                    text=config.get("text"),
                    headers=config.get("headers", {}),
                )
        return httpx.Response(404, json={"error": f"No mock for {url}"})

    set_mock_handler(handler)


def setup_mock_fn(handler: Callable[[httpx.Request], httpx.Response]) -> None:
    """Configure a custom mock handler function for full control."""
    set_mock_handler(handler)


def teardown_mock() -> None:
    """Remove mock handler and clear captures."""
    clear_mock_handler()
    clear_captures()


def get_captured_requests() -> list[dict[str, Any]]:
    """Get all captured outbound HTTP calls."""
    return get_captures()


def assert_captured_call(
    index: int = 0,
    url_contains: str | None = None,
    method: str | None = None,
    body_contains: dict[str, Any] | None = None,
    header_present: str | None = None,
) -> dict[str, Any]:
    """Assert properties of a captured HTTP call."""
    captures = get_captures()
    assert len(captures) > index, f"Expected at least {index + 1} captures, got {len(captures)}"

    call = captures[index]

    if url_contains is not None:
        assert url_contains in call["url"], f"Expected URL to contain '{url_contains}', got '{call['url']}'"

    if method is not None:
        assert call["method"] == method, f"Expected method '{method}', got '{call['method']}'"

    if body_contains is not None and call["requestBody"]:
        body = json.loads(call["requestBody"])
        for key, value in body_contains.items():
            assert key in body, f"Expected key '{key}' in request body, got {list(body.keys())}"
            if value is not None:
                assert body[key] == value, f"Expected body['{key}'] = {value}, got {body[key]}"

    if header_present is not None:
        assert header_present.lower() in {k.lower() for k in call["requestHeaders"]}, (
            f"Expected header '{header_present}' in request"
        )

    return call


class BlackboxResult:
    """Accumulates pass/fail results for the test runner."""

    def __init__(self) -> None:
        self.passed = 0
        self.failed = 0
        self.errors: list[str] = []

    def record(self, name: str, fn: Callable) -> None:
        """Run a sync test function, record the result.

        Registering an `async def` test here used to pass silently: `fn()` just
        builds a coroutine, never runs a single assertion, and raises nothing —
        so a completely dead test reported ✅. Detect that and fail loudly.
        """
        clear_captures()
        try:
            returned = fn()
            if inspect.iscoroutine(returned):
                returned.close()
                raise AssertionError(
                    f"async test '{name}' was registered with record(); its assertions "
                    f"never ran. Use `await r.record_async(...)` instead."
                )
            self.record_result(name)
        except Exception as e:
            self.record_result(name, e)

    async def record_async(self, name: str, fn: Callable) -> None:
        """Run an async test function, record the result."""
        clear_captures()
        try:
            await fn()
            self.record_result(name)
        except Exception as e:
            self.record_result(name, e)

    def record_result(self, name: str, error: BaseException | None = None) -> None:
        """Record an immediate or deferred outcome without losing its traceback."""
        if error is None:
            self.passed += 1
            print(f"  ✅ {name}")
            return
        self.failed += 1
        detail = type(error).__name__
        if str(error):
            detail += f": {error}"
        self.errors.append(f"{name}: {detail}")
        print(f"  ❌ {name}: {detail}")
        traceback.print_exception(type(error), error, error.__traceback__)

    def summary(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "failed": self.failed,
            "total": self.passed + self.failed,
        }

    @property
    def all_passed(self) -> bool:
        return self.failed == 0


async def native_browser_start_source(timestamp: str, *, tool_call_id: str = "tool-1", mode: str = "real"):
    """Capture the actual manager/ToolEvent source before any activity is scheduled."""
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from domains.spawn_browser_agent_v3.handler import SpawnBrowserAgentManagerV3
    from helpers.handle_tool_event import handle_tool_event

    workflow = SimpleNamespace(user_id="user-1", agent_id="agent-1", world_model_mode=mode)
    events = SpawnBrowserAgentManagerV3().execute_tool(workflow, {"goal": "Read the shared calendar"}, tool_call_id)
    try:
        event = await anext(events)
    finally:
        await events.aclose()
    persistence = AsyncMock()
    await handle_tool_event(event, "agent-1", tool_call_id, "spawn_browser_agent", persistence)
    args = persistence.await_args.kwargs["args"]
    return {
        "id": "native-browser-origin",
        "role": args[2],
        "text": args[1],
        "metadata": args[3],
        "timestamp": timestamp,
    }
