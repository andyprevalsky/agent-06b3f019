"""
Shared utilities for blackbox tests.

Sets up the import path, loads .env, installs the capture harness,
and provides mock response helpers.
"""

import json
import os
import sys
from pathlib import Path
from typing import Any, Callable

# Setup path so we can import from agents root
AGENTS_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(AGENTS_ROOT))

from dotenv import load_dotenv

load_dotenv(AGENTS_ROOT / ".env")

# Activate capture mode
os.environ["BLACKBOX_TEST_CAPTURE_OUTBOUND"] = "1"

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

_patch.object(_temporal_workflow, "uuid4", side_effect=_uuid.uuid4).start()
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
            "api.parallel.ai/v1beta/search": {
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
    assert len(captures) > index, (
        f"Expected at least {index + 1} captures, got {len(captures)}"
    )

    call = captures[index]

    if url_contains is not None:
        assert url_contains in call["url"], (
            f"Expected URL to contain '{url_contains}', got '{call['url']}'"
        )

    if method is not None:
        assert call["method"] == method, (
            f"Expected method '{method}', got '{call['method']}'"
        )

    if body_contains is not None and call["requestBody"]:
        body = json.loads(call["requestBody"])
        for key, value in body_contains.items():
            assert key in body, f"Expected key '{key}' in request body, got {list(body.keys())}"
            if value is not None:
                assert body[key] == value, (
                    f"Expected body['{key}'] = {value}, got {body[key]}"
                )

    if header_present is not None:
        assert header_present.lower() in {
            k.lower() for k in call["requestHeaders"]
        }, f"Expected header '{header_present}' in request"

    return call


class BlackboxResult:
    """Accumulates pass/fail results for the test runner."""

    def __init__(self) -> None:
        self.passed = 0
        self.failed = 0
        self.errors: list[str] = []

    def record(self, name: str, fn: Callable) -> None:
        """Run a sync test function, record the result."""
        clear_captures()
        try:
            fn()
            self.passed += 1
            print(f"  ✅ {name}")
        except Exception as e:
            self.failed += 1
            self.errors.append(f"{name}: {e}")
            print(f"  ❌ {name}: {e}")

    async def record_async(self, name: str, fn: Callable) -> None:
        """Run an async test function, record the result."""
        clear_captures()
        try:
            await fn()
            self.passed += 1
            print(f"  ✅ {name}")
        except Exception as e:
            self.failed += 1
            self.errors.append(f"{name}: {e}")
            print(f"  ❌ {name}: {e}")

    def summary(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "failed": self.failed,
            "total": self.passed + self.failed,
        }

    @property
    def all_passed(self) -> bool:
        return self.failed == 0
