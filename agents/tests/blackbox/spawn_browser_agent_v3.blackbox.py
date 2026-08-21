"""Blackbox tests for spawn-browser-agent-v3 domain.

Heavily exercises service_crypto (pure functions), repo (httpx-mockable),
service (data transforms), and the static/pure parts of service_actions
and handler (ClaudeTokenState, get_manager, workflow helper static bits).
"""

import ast
import asyncio
import base64
import json
import os
import sys
import textwrap
import time as time_module
from io import BytesIO
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, call, patch

import pytest

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    get_captured_requests,
    setup_mock,
    teardown_mock,
)

# ========================================
# Helpers: build a real encrypted envelope
# ========================================

def _make_rsa_keypair():
    """Generate an RSA keypair and return (private_pem_b64, public_key)."""
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048, backend=default_backend())
    public_key = private_key.public_key()

    pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    return base64.b64encode(pem).decode("utf-8"), public_key, private_key

def _encrypt_envelope(plaintext: bytes, public_key, version: int = 1) -> str:
    """Produce a base64 JSON envelope matching decrypt_payment_info/decrypt_password format."""
    import os as _os

    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    aes_key = _os.urandom(32)
    iv = _os.urandom(12)
    cipher = Cipher(algorithms.AES(aes_key), modes.GCM(iv))
    encryptor = cipher.encryptor()
    ct = encryptor.update(plaintext) + encryptor.finalize()
    tag = encryptor.tag
    full_ct = ct + tag

    encrypted_aes_key = public_key.encrypt(
        aes_key,
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None,
        ),
    )

    envelope = {
        "version": version,
        "iv": base64.b64encode(iv).decode("utf-8"),
        "ciphertext": base64.b64encode(full_ct).decode("utf-8"),
        "encrypted_aes_key": base64.b64encode(encrypted_aes_key).decode("utf-8"),
    }
    return base64.b64encode(json.dumps(envelope).encode("utf-8")).decode("utf-8")

async def test_cdp_use_websocket_patch_disables_proxy_discovery():
    """browser-use CDP sockets must not inherit websockets>=15 proxy discovery."""
    import cdp_use.client as cdp_client

    from domains.spawn_browser_agent_v3.handler import _patch_cdp_use_websocket_proxy_default

    calls = []
    original_connect = cdp_client.websockets.connect

    def fake_connect(*args, **kwargs):
        calls.append({"args": args, "kwargs": dict(kwargs)})

        class AwaitableResult:
            def __await__(self):
                async def _return():
                    return "connected"

                return _return().__await__()

        return AwaitableResult()

    try:
        cdp_client.websockets.connect = fake_connect
        _patch_cdp_use_websocket_proxy_default()

        assert await cdp_client.websockets.connect("wss://connect.steel.dev") == "connected"
        assert calls[-1]["kwargs"]["proxy"] is None

        assert (
            await cdp_client.websockets.connect(
                "wss://connect.steel.dev",
                proxy="http://explicit-proxy.local:8080",
            )
            == "connected"
        )
        assert calls[-1]["kwargs"]["proxy"] == "http://explicit-proxy.local:8080"
    finally:
        cdp_client.websockets.connect = original_connect

def test_browser_action_log_summary_redacts_payment_secrets():
    from domains.spawn_browser_agent_v3.handler import (
        _redact_browser_log_value,
        _summarize_browser_action_history_entry,
        _summarize_browser_action_for_log,
        _summarize_payment_request_for_log,
    )

    action_summary = _summarize_browser_action_for_log(
        {
            "action": "request_payment_card",
            "params": {
                "merchant": "Blick Art Materials",
                "line_items": [{"name": "Brush", "quantity": 1, "line_total_cents": 636}],
                "subtotal_cents": 636,
                "total_cents": 636,
                "text": "SHOULD_NOT_LOG_TYPED_TEXT",
                "card_cvv": "SHOULD_NOT_LOG_CVV",
                "password": "SHOULD_NOT_LOG_PASSWORD",
            },
        }
    )
    payment_summary = _summarize_payment_request_for_log(
        {
            "merchant": "Blick Art Materials",
            "line_items": [{"name": "Brush", "quantity": 1, "line_total_cents": 636}],
            "subtotal_cents": 636,
            "total_cents": 636,
        }
    )

    assert action_summary["action"] == "request_payment_card"
    assert action_summary["line_items_count"] == 1
    assert action_summary["params"]["merchant"] == "Blick Art Materials"
    assert payment_summary["line_items_count"] == 1
    assert _redact_browser_log_value("card_cvv", "SHOULD_NOT_LOG_CVV") == "<redacted>"

    history_entry = _summarize_browser_action_history_entry(
        "input_text",
        {
            "action": "input_text",
            "params": {
                "text": "SHOULD_NOT_LOG_TYPED_TEXT",
                "card_cvv": "SHOULD_NOT_LOG_CVV",
                "merchant": "Blick Art Materials",
            },
        },
    )

    serialized = json.dumps(
        {"action": action_summary, "payment": payment_summary, "history": history_entry}, sort_keys=True
    )
    assert "SHOULD_NOT_LOG_TYPED_TEXT" not in serialized
    assert "SHOULD_NOT_LOG_CVV" not in serialized
    assert "SHOULD_NOT_LOG_PASSWORD" not in serialized

def test_browser_progress_title_describes_active_agent():
    from domains.spawn_browser_agent_v3.handler import BROWSER_PROGRESS_TITLE

    assert BROWSER_PROGRESS_TITLE == "Browser Agent In Progress"

def test_verifier_activity_timeout_allows_llm_call():
    """Browser verifier uses the standard LLM activity budget."""
    from domains.spawn_browser_agent_v3.config import VERIFIER_ULTRA_TIMEOUT_SECONDS
    from utils.llm_timeouts import STANDARD_LLM_ACTIVITY_TIMEOUT_SECONDS

    assert VERIFIER_ULTRA_TIMEOUT_SECONDS == STANDARD_LLM_ACTIVITY_TIMEOUT_SECONDS

def test_stateful_browser_activity_has_one_thirty_minute_attempt():
    """Stateful browser writes get a full window but no from-scratch Temporal retry."""
    import inspect

    from domains.spawn_browser_agent_v3.config import (
        ACTIVITY_START_TO_CLOSE_TIMEOUT_MINUTES,
        MAX_ACTIVITY_ATTEMPTS,
    )
    from domains.spawn_browser_agent_v3.handler import SpawnBrowserAgentManagerV3

    assert ACTIVITY_START_TO_CLOSE_TIMEOUT_MINUTES == 30
    assert MAX_ACTIVITY_ATTEMPTS == 1

    execute_source = inspect.getsource(SpawnBrowserAgentManagerV3.execute_tool)
    assert "timedelta(minutes=ACTIVITY_START_TO_CLOSE_TIMEOUT_MINUTES)" in execute_source
    assert "RetryPolicy(maximum_attempts=MAX_ACTIVITY_ATTEMPTS)" in execute_source

def test_transient_session_init_failure_classification():
    """RCA (agent 53feac08): the first two browser spawns died on Kernel's
    `400 Proxy is marked unavailable from the last health check` because
    init_browser_session treated every non-2xx/429 as fatal. That transient
    infra failure must now be classified retryable, while a genuine bad request
    stays fatal so real errors are not masked.
    """
    from domains.spawn_browser_agent_v3.repo import is_transient_session_init_failure

    # The exact production failure — transient, must retry.
    assert is_transient_session_init_failure(
        400, '{"error":"400 Proxy is marked unavailable from the last health check"}'
    )
    # Any 5xx from the provider is transient.
    assert is_transient_session_init_failure(502, "Bad Gateway")
    assert is_transient_session_init_failure(503, "temporarily unavailable")
    # An ordinary 4xx bad request stays fatal (not retried).
    assert not is_transient_session_init_failure(400, '{"error":"invalid start_url"}')
    assert not is_transient_session_init_failure(401, "Unauthorized")
    assert not is_transient_session_init_failure(404, "Not Found")

    # RCA (agent c8dc9824): a proxy can also fail BELOW the provider API —
    # allocation succeeds, then the browser's CDP navigation to start_url dies
    # inside the tunnel. Chrome reports net::ERR_TUNNEL_CONNECTION_FAILED, which
    # matched no marker and so classified FATAL: the bounded fresh-proxy retry in
    # handler.py was skipped entirely and the activity escaped to Temporal, which
    # replayed the identical doomed spawn 124 times and burned the full 900s
    # budget without ever reaching the payment step it was benchmarking.
    assert is_transient_session_init_failure(
        400, "Navigation failed: net::ERR_TUNNEL_CONNECTION_FAILED"
    )
    assert is_transient_session_init_failure(400, "net::ERR_PROXY_CONNECTION_FAILED")
    # Still fatal: a navigation error that is NOT a proxy/tunnel fault must not be
    # retried onto a fresh proxy — a new IP cannot fix a bad name or a refused host.
    assert not is_transient_session_init_failure(400, "net::ERR_NAME_NOT_RESOLVED")


# ============================================================================
# RCA repro — browser agent returns BEST-EFFORT results at max steps
# ----------------------------------------------------------------------------
# Bug (before): when the browser sub-agent exhausted its step budget WITHOUT
# ever calling attempt_completion, handler.py's max_iterations exit returned
# `structured_response=None` and had no best-effort field at all — the parent
# got an empty payload, unlike run_agent (loop/run_agent.py) and the explore
# agent, which both surface a last-synthesized answer + a final verifier pass.
#
# Fix (after): the max_iterations exit now (1) runs a final verifier pass
# (reusing build_browser_verifier_context) to salvage partial structured data
# into structured_response, and (2) returns build_best_effort_response(...) as
# `best_effort_response`, mirroring run_agent's best_effort_response.
#
# These tests are the regression guard: on the pre-fix code the two helpers
# don't exist (ImportError) and the guarantees below don't hold.
# ============================================================================

def test_max_steps_best_effort_prefers_last_reasoning():
    """Best-effort answer = the agent's most recent synthesized reasoning.

    Mirrors run_agent's best_effort_response (last ASSISTANT text). Without
    this, a runaway that never called attempt_completion returns nothing usable.
    """
    from domains.spawn_browser_agent_v3.service import build_best_effort_response

    out = build_best_effort_response(
        reasoning_messages=["Opened the site", "Found the item; it costs $42.00"],
        action_summary=["navigate", "click"],
        visited_urls=["https://shop.example/item"],
    )
    assert out == "Found the item; it costs $42.00"

def test_max_steps_best_effort_skips_blank_reasoning():
    """Blank/whitespace-only trailing reasoning is skipped for the last real one."""
    from domains.spawn_browser_agent_v3.service import build_best_effort_response

    out = build_best_effort_response(
        reasoning_messages=["Real synthesized answer", "   ", ""],
        action_summary=[],
        visited_urls=[],
    )
    assert out == "Real synthesized answer"

def test_max_steps_best_effort_falls_back_to_actions_then_url():
    """With no reasoning captured, fall back to the action trail, then the URL —
    never an empty payload while ANY evidence exists."""
    from domains.spawn_browser_agent_v3.service import build_best_effort_response

    from_actions = build_best_effort_response(
        reasoning_messages=[],
        action_summary=["navigate to shop", "click add-to-cart"],
        visited_urls=["https://shop.example/cart"],
    )
    assert "click add-to-cart" in from_actions
    assert from_actions.strip() != ""

    from_url = build_best_effort_response(
        reasoning_messages=[],
        action_summary=[],
        visited_urls=["https://shop.example/checkout"],
    )
    assert "https://shop.example/checkout" in from_url

def test_max_steps_best_effort_empty_only_when_no_evidence():
    """Empty string only when the agent accumulated zero evidence at all."""
    from domains.spawn_browser_agent_v3.service import build_best_effort_response

    assert build_best_effort_response([], [], []) == ""
    assert build_best_effort_response(None, None, None) == ""

async def test_browser_verifier_context_grounds_in_final_state():
    """The extracted verifier-context builder (shared by attempt_completion AND
    the new max-steps final synthesis pass) grounds in final-state DOM +
    screenshot + action history, so the salvage verifier gets real evidence."""
    from domains.spawn_browser_agent_v3 import service as bsvc

    class _FakeHistory:
        def get_entries(self):
            return [
                {"step": 1, "action": "navigate", "result": {"success": True}},
                {"step": 2, "action": "extract", "result": {"success": True, "value": "$42.00"}},
            ]

    browser_state = {
        "dom_tree": "<html>Price: $42.00</html>",
        "screenshot": "ZmFrZS1iNjQ=",
        "title": "Item Page",
        "page_stats": {"interactive": 3},
        "scroll_position": {"pages_above": 0, "total_pages": 1},
    }

    with patch.object(bsvc, "list_session_files", AsyncMock(return_value=[])):
        ctx = await bsvc.build_browser_verifier_context(
            goal="find the item price",
            current_url="https://shop.example/item",
            browser_state=browser_state,
            action_history=_FakeHistory(),
            config=SimpleNamespace(),
            session_id="sess-1",
            browser_checkpoints=[
                {
                    "url": "https://shop.example/checkout",
                    "title": "Review order",
                    "dom_tree": "<main>Cart checkout; Item price: $42.00</main>",
                    "kind": "pre_write",
                },
                {
                    "url": "https://shop.example/item",
                    "title": "Item details",
                    "dom_tree": "<main>Six-foot cable; supports 100 watts</main>",
                    "kind": "preserved_evidence",
                }
            ],
        )

    roles = [m["role"] for m in ctx]
    assert roles[0] == "USER"
    tool_names = [m["metadata"]["toolName"] for m in ctx if m["role"] == "TOOL"]
    assert tool_names == ["action_history", "session_files", "final_screenshot"]
    # Ground truth (DOM) lives in the USER message, not an LLM-generated TOOL result.
    assert "$42.00" in ctx[0]["text"]
    assert "FINAL STATE" in ctx[0]["text"]
    assert "PRE-WRITE CHECKPOINTS" in ctx[0]["text"]
    assert "Cart checkout; Item price: $42.00" in ctx[0]["text"]
    assert "PRESERVED PAGE EVIDENCE" in ctx[0]["text"]
    assert "Six-foot cable; supports 100 watts" in ctx[0]["text"]
    assert "browser ground truth, not an agent claim" in ctx[0]["text"]
    # Final-state screenshot rides through as a multimodal image reference.
    screenshot_msg = next(m for m in ctx if m.get("metadata", {}).get("toolName") == "final_screenshot")
    assert screenshot_msg["metadata"]["screenshot_b64"] == "ZmFrZS1iNjQ="


def test_action_history_restores_across_activity_boundary():
    from browser_tools.dom_service import ActionHistory

    history = ActionHistory()
    history.restore_entries(
        [
            {
                "step": 1,
                "action": "click",
                "index": 42,
                "element_description": "[42] a '1 Cart'",
                "result": {"success": True},
            },
            {"step": "invalid", "action": "ignored"},
        ]
    )

    assert history.get_entries() == [
        {
            "step": 1,
            "action": "click",
            "index": 42,
            "element_description": "[42] a '1 Cart'",
            "result": {"success": True},
        }
    ]

async def test_action_history_resume_preserves_monotonic_step_numbers():
    from browser_tools.dom_service import ActionHistory

    history = ActionHistory()
    history.restore_entries([{"step": step, "action": "click", "result": {"success": True}} for step in range(21, 51)])

    resumed_entry = await history.record_action(
        dom_service=SimpleNamespace(selector_map={}),
        action="scroll",
    )
    assert resumed_entry.step == 51

    history.clear()
    fresh_entry = await history.record_action(
        dom_service=SimpleNamespace(selector_map={}),
        action="navigate",
    )
    assert fresh_entry.step == 1

def test_max_steps_return_declares_best_effort_and_final_verifier():
    """The max_iterations exit must wire the best-effort field AND run the final
    verifier salvage — guards against a silent revert of the RCA fix. Asserts on
    the compiled source of the exact terminal branch (no live browser needed)."""
    import inspect

    from domains.spawn_browser_agent_v3 import handler

    src = inspect.getsource(handler._spawn_browser_agent_activity_v3_real)
    # Locate the max_iterations terminal return block.
    marker = 'logger.warning(f"Max iterations reached: {MAX_ITERATIONS}")'
    assert marker in src
    tail = src[src.index(marker) :]
    tail = tail[: tail.index('"status": "max_iterations"') + 400]
    # (1) final synthesis pass reusing the shared verifier context builder
    assert "build_browser_verifier_context" in tail
    assert "check_progress" in tail
    # (2) best-effort payload surfaced on the terminal return
    assert "build_best_effort_response" in tail
    assert '"best_effort_response": best_effort_response' in tail

def test_browser_step_budget_extends_beyond_productive_step_30_capture():
    """The configured budget must extend beyond a productive captured boundary.

    Production agent 62734899-ddd8-472a-a8b2-ddef79c74e44 captured several
    independent browser tasks whose 30th action succeeded while the checkout
    was still advancing. The handler then returned ``max_iterations`` before
    the agent could observe the result or complete the next required action.

    This is deliberately a narrow budget invariant tied to the observed
    first-bad boundary, not a replay of the checkout or proof of a sufficient
    total step count. A proposed cap of 50 satisfies the invariant without
    pretending that this capture alone proves every checkout finishes by 50.
    """
    from domains.spawn_browser_agent_v3.config import MAX_ITERATIONS

    production_boundary_captures = (
        {
            "task_id": "46155ddc-01d9-4c51-bb51-755802a377c5",
            "step": 30,
            "action": "click",
            "result": "Continue to Payment clicked successfully",
        },
        {
            "task_id": "de9f32ad-5297-4727-9965-500bddc71a13",
            "step": 30,
            "action": "input_text",
            "result": "contactNumber entered successfully",
        },
    )

    for capture in production_boundary_captures:
        assert capture["step"] < MAX_ITERATIONS, (
            "Browser step budget terminated a still-productive production run "
            f"at its boundary: {capture} (MAX_ITERATIONS={MAX_ITERATIONS})"
        )

def test_browser_supervisor_does_not_preempt_browser_use_event_timeouts():
    """Outer watchdogs must not cancel queued browser-use EventBus requests."""
    from domains.spawn_browser_agent_v3.config import (
        BROWSER_STATE_REQUEST_TIMEOUT_SECONDS,
        BROWSER_SUPERVISOR_ACTION_TIMEOUT_SECONDS,
        BROWSER_SUPERVISOR_STEP_TIMEOUT_SECONDS,
        NAVIGATE_TO_URL_TIMEOUT_SECONDS,
    )

    assert BROWSER_SUPERVISOR_STEP_TIMEOUT_SECONDS > BROWSER_STATE_REQUEST_TIMEOUT_SECONDS
    assert BROWSER_SUPERVISOR_ACTION_TIMEOUT_SECONDS > NAVIGATE_TO_URL_TIMEOUT_SECONDS

def test_browser_task_prompt_does_not_duplicate_system_prompt():
    from domains.spawn_browser_agent_v3.service import (
        append_completion_evidence,
        build_browser_dynamic_system_context,
        build_browser_task_prompt,
    )
    from providers.rose.browser_use import build_browser_use_messages

    dynamic_context = build_browser_dynamic_system_context(
        "Use saved auth if available",
        available_files=["receipt.pdf"],
    )
    task = build_browser_task_prompt("Buy socks")
    assert task == "# Current Goal\nBuy socks"
    assert "You are a browser automation agent" not in task
    assert "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__" not in task
    assert "Use saved auth if available" in dynamic_context
    assert "receipt.pdf" in dynamic_context

    messages = build_browser_use_messages(
        task=task,
        browser_state={
            "url": "https://example.com",
            "title": "Example",
            "viewport": {"width": 1280, "height": 800},
            "dom_tree": "[Start of page]",
        },
        action_history=[],
        available_actions=["click"],
        include_screenshot=False,
        dynamic_system_context=dynamic_context,
        turn_messages=[],
    )

    assert [message["role"] for message in messages] == ["system", "user", "user"]
    assert "You are a browser automation agent" in messages[0]["content"]
    assert "You are a browser automation agent" not in messages[1]["content"]
    assert messages[1]["content"] == "# Current Goal\nBuy socks"
    assert "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__" in messages[0]["content"]
    assert "# Dynamic Context" not in messages[0]["content"]
    assert "Use saved auth if available" in messages[0]["content"]

    payment_summary = append_completion_evidence(
        "**Status**: SUCCESS",
        browser_url="https://rose-guangzhou.ngrok.app/test_payment/confirmation/tp_123",
        structured_response={
            "order_confirmation_id": "tp_123",
            "purchased_product_names": ["Aurora Notebook", "Ceramic Mug", "Canvas Tote"],
        },
    )
    assert "Payment confirmed" in payment_summary
    assert "Order ID: tp_123" in payment_summary
    assert "Aurora Notebook, Ceramic Mug, Canvas Tote" in payment_summary

async def test_pending_write_lock_action_rehydrates_url_and_remaps_dom_target():
    """An approved click must resolve against the resumed DOM, not its stale pre-pause index."""
    from domains.spawn_browser_agent_v3.handler import _prepare_pending_write_lock_action

    class _Element:
        def __init__(self, *, name: str, text: str):
            self.tag_name = "input"
            self.node_name = "input"
            self.attributes = {"name": name}
            self.text_content = text
            self._text = text

        def get_all_children_text(self):
            return self._text

    target = _Element(name="placeYourOrder1", text="Place your order")
    unrelated = _Element(name="addToCart", text="Add to Cart")

    class _DomService:
        def __init__(self):
            self.selector_map = {42: unrelated}

        async def get_browser_state(self, *, include_screenshot: bool):
            assert include_screenshot is False
            self.selector_map = {7: target, 42: unrelated}
            return {"url": "https://www.amazon.com/checkout/order", "dom_tree": "checkout"}

    pending_action = {"action": "click", "index": 42, "params": {"index": 42}}
    target_signature = {
        "tag": "input",
        "text": "Place your order",
        "attrs": {"name": "placeYourOrder1"},
    }

    action, state, current_url = await _prepare_pending_write_lock_action(
        _DomService(),
        pending_action,
        target_signature=target_signature,
    )

    assert current_url == "https://www.amazon.com/checkout/order"
    assert state["dom_tree"] == "checkout"
    assert action["index"] == 7
    assert action["params"]["index"] == 7

async def test_browser_agent_recording_writes_local_html_replay():
    import tempfile

    from domains.spawn_browser_agent_v3.recording import BrowserAgentRecorder

    class FakePage:
        async def screenshot(self, **kwargs):
            return b"fake-jpeg-bytes"

        async def content(self):
            return "<html><body><main>Final browser DOM</main></body></html>"

    previous_enabled = os.environ.get("BROWSER_AGENT_RECORDINGS")
    previous_dir = os.environ.get("BROWSER_AGENT_RECORDINGS_DIR")
    previous_interval = os.environ.get("BROWSER_AGENT_RECORDING_INTERVAL_SECONDS")
    try:
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["BROWSER_AGENT_RECORDINGS"] = "1"
            os.environ["BROWSER_AGENT_RECORDINGS_DIR"] = tmp
            os.environ["BROWSER_AGENT_RECORDING_INTERVAL_SECONDS"] = "60"
            recorder = await BrowserAgentRecorder.create(
                page=FakePage(),
                agent_id="agent-1",
                task_id="task-1",
                session_id="session-1",
                browser_url="https://api.steel.dev/v1/sessions/session-1/player",
            )
            assert recorder is not None
            await recorder.record_observation(
                iteration=1,
                browser_state={
                    "url": "https://example.com/checkout",
                    "title": "Checkout",
                    "dom_tree": "<main>Checkout</main>",
                    "screenshot": base64.b64encode(b"state-png").decode("ascii"),
                },
                action_entries=[
                    {
                        "step": 1,
                        "action": "click",
                        "params": {"index": 2},
                        "result": {"success": True, "screenshot": base64.b64encode(b"action-png").decode("ascii")},
                    }
                ],
            )
            await recorder.write_final_screenshot(base64.b64encode(b"final-png").decode("ascii"))
            await recorder.mark(
                "Clicked submit",
                action="click",
                cursor={"x": 10, "y": 20},
                metadata={"step": 3, "phase": "finish", "action": "click"},
            )
            html_path = await recorder.close()
            assert html_path is not None
            assert html_path.exists()

            manifest = json.loads((html_path.parent / "manifest.json").read_text())
            assert manifest["agent_id"] == "agent-1"
            assert manifest["task_id"] == "task-1"
            assert manifest["final_dom_path"] == "final-dom.html"
            assert manifest["final_screenshot_path"] == "final-screenshot.png"
            assert manifest["observation_count"] == 1
            assert manifest["observations"] == [{"iteration": 1, "path": "observations/iteration_0001.json"}]
            assert "Final browser DOM" in (html_path.parent / "final-dom.html").read_text()
            assert (html_path.parent / "final-screenshot.png").read_bytes() == b"final-png"
            observation = json.loads((html_path.parent / "observations" / "iteration_0001.json").read_text())
            assert observation["browser_state"]["url"] == "https://example.com/checkout"
            assert observation["browser_state"]["dom_tree"] == "<main>Checkout</main>"
            assert observation["browser_state"]["screenshot"]["redacted"] == "base64-media"
            assert observation["action_entries"][0]["result"]["screenshot"]["redacted"] == "base64-media"
            assert manifest["frame_count"] >= 2
            assert manifest["cursor_events"][-1] == {
                "ts_ms": manifest["cursor_events"][-1]["ts_ms"],
                "x": 10,
                "y": 20,
            }
            assert manifest["frames"][-1]["cursor"] == {"x": 10, "y": 20}
            assert "tab_url" in manifest["frames"][-1]
            assert manifest["frames"][-1]["metadata"]["step"] == 3
            assert manifest["frames"][-1]["metadata"]["cursor"] == {"x": 10, "y": 20}
            html_text = html_path.read_text()
            assert "skip idle" in html_text
            assert "cursorByFrame" in html_text
            assert "cursorAtTime" in html_text
            assert "cursorTs = frameRealTs + (nextRealTs - frameRealTs) * frameT" in html_text
            assert "Clicked submit" in html_text
            # Single-column player (the metadata sidebar was intentionally removed).
            assert "#app { display: flex; flex-direction: column; height: 100vh; }" in html_text
            assert (
                "#stage { flex: 1; display: flex; align-items: center; justify-content: center; min-height: 0; padding: 4px; background: #050506; }"
                in html_text
            )
            assert "<aside" not in html_text
    finally:
        if previous_enabled is None:
            os.environ.pop("BROWSER_AGENT_RECORDINGS", None)
        else:
            os.environ["BROWSER_AGENT_RECORDINGS"] = previous_enabled
        if previous_dir is None:
            os.environ.pop("BROWSER_AGENT_RECORDINGS_DIR", None)
        else:
            os.environ["BROWSER_AGENT_RECORDINGS_DIR"] = previous_dir
        if previous_interval is None:
            os.environ.pop("BROWSER_AGENT_RECORDING_INTERVAL_SECONDS", None)
        else:
            os.environ["BROWSER_AGENT_RECORDING_INTERVAL_SECONDS"] = previous_interval

async def test_browser_agent_recording_captures_visible_active_tab_url():
    import tempfile

    from domains.spawn_browser_agent_v3.recording import BrowserAgentRecorder

    class FakePage:
        def __init__(self, url, hidden, image_bytes):
            self.url = url
            self.hidden = hidden
            self.image_bytes = image_bytes
            self.context = None

        async def evaluate(self, script):
            assert script == "document.hidden"
            return self.hidden

        async def screenshot(self, **kwargs):
            return self.image_bytes

    previous_enabled = os.environ.get("BROWSER_AGENT_RECORDINGS")
    previous_dir = os.environ.get("BROWSER_AGENT_RECORDINGS_DIR")
    previous_interval = os.environ.get("BROWSER_AGENT_RECORDING_INTERVAL_SECONDS")
    try:
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["BROWSER_AGENT_RECORDINGS"] = "1"
            os.environ["BROWSER_AGENT_RECORDINGS_DIR"] = tmp
            os.environ["BROWSER_AGENT_RECORDING_INTERVAL_SECONDS"] = "60"
            hidden_tab = FakePage("https://nopafish.com/", True, b"hidden-tab")
            visible_tab = FakePage("https://order.toasttab.com/online/nopafish", False, b"visible-tab")
            context = SimpleNamespace(pages=[hidden_tab, visible_tab])
            hidden_tab.context = context
            visible_tab.context = context

            recorder = await BrowserAgentRecorder.create(
                page=hidden_tab,
                agent_id="agent-1",
                task_id="task-1",
                session_id="session-1",
                browser_url="",
            )
            assert recorder is not None
            await recorder.close(include_steel_media=False)

            assert recorder.frames
            assert recorder.frames[0]["tab_url"] == "https://order.toasttab.com/online/nopafish"
            frame_bytes = (recorder.output_dir / recorder.frames[0]["src"]).read_bytes()
            assert frame_bytes == b"visible-tab"
            assert "order.toasttab.com/online/nopafish" in recorder.export_inline_html_bytes().decode("utf-8")
    finally:
        if previous_enabled is None:
            os.environ.pop("BROWSER_AGENT_RECORDINGS", None)
        else:
            os.environ["BROWSER_AGENT_RECORDINGS"] = previous_enabled
        if previous_dir is None:
            os.environ.pop("BROWSER_AGENT_RECORDINGS_DIR", None)
        else:
            os.environ["BROWSER_AGENT_RECORDINGS_DIR"] = previous_dir
        if previous_interval is None:
            os.environ.pop("BROWSER_AGENT_RECORDING_INTERVAL_SECONDS", None)
        else:
            os.environ["BROWSER_AGENT_RECORDING_INTERVAL_SECONDS"] = previous_interval


async def test_browser_agent_recording_mark_survives_wiped_frames_dir():
    """Prod purchase fleet died when /tmp recording scratch vanished mid-run.

    Post-click ``mark()`` called ``capture()`` → ``write_bytes`` raised
    FileNotFoundError and aborted the browser agent after Place order succeeded.
    Recording must recreate the frames dir (or soft-fail) and never raise.
    """
    import shutil
    import tempfile

    from domains.spawn_browser_agent_v3.recording import BrowserAgentRecorder

    class FakePage:
        url = "https://roselabs.ai/test_payment"
        context = None

        async def evaluate(self, script):
            return False

        async def screenshot(self, **kwargs):
            return b"jpeg-bytes"

    previous = {
        "BROWSER_AGENT_RECORDINGS": os.environ.get("BROWSER_AGENT_RECORDINGS"),
        "BROWSER_AGENT_RECORDINGS_DIR": os.environ.get("BROWSER_AGENT_RECORDINGS_DIR"),
        "BROWSER_AGENT_RECORDING_INTERVAL_SECONDS": os.environ.get("BROWSER_AGENT_RECORDING_INTERVAL_SECONDS"),
        "BROWSER_AGENT_KERNEL_REPLAY": os.environ.get("BROWSER_AGENT_KERNEL_REPLAY"),
    }
    try:
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["BROWSER_AGENT_RECORDINGS"] = "1"
            os.environ["BROWSER_AGENT_RECORDINGS_DIR"] = tmp
            os.environ["BROWSER_AGENT_RECORDING_INTERVAL_SECONDS"] = "60"
            os.environ["BROWSER_AGENT_KERNEL_REPLAY"] = "0"
            page = FakePage()
            page.context = SimpleNamespace(pages=[page])

            recorder = await BrowserAgentRecorder.create(
                page=page,
                agent_id="agent-purchase",
                task_id="task-place-order",
                session_id="session-steel",
                browser_url="https://connect.steel.dev/v1/sessions/x/player",
                session_metadata={"provider": "steel"},
            )
            assert recorder is not None
            frames_before_wipe = len(recorder.frames)
            assert frames_before_wipe >= 1

            shutil.rmtree(recorder.output_dir)
            assert not recorder.frames_dir.exists()

            # Must not raise — this is the Place-order finish mark path.
            await recorder.mark("Clicked <button \"Place order $1.00\">", action="click")

            assert recorder.frames_dir.exists()
            assert len(recorder.frames) == frames_before_wipe + 1
            restored = recorder.output_dir / recorder.frames[-1]["src"]
            assert restored.read_bytes() == b"jpeg-bytes"
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

async def test_browser_agent_recording_respects_disabled_env():
    from domains.spawn_browser_agent_v3.recording import BrowserAgentRecorder

    previous_enabled = os.environ.get("BROWSER_AGENT_RECORDINGS")
    try:
        os.environ["BROWSER_AGENT_RECORDINGS"] = "0"
        recorder = await BrowserAgentRecorder.create(
            page=object(),
            agent_id="agent-1",
            task_id="task-1",
            session_id="session-1",
            browser_url="",
        )
        assert recorder is None
    finally:
        if previous_enabled is None:
            os.environ.pop("BROWSER_AGENT_RECORDINGS", None)
        else:
            os.environ["BROWSER_AGENT_RECORDINGS"] = previous_enabled

async def test_browser_session_metadata_is_published_when_recording_is_disabled():
    import inspect

    from domains.spawn_browser_agent_v3 import handler
    from domains.spawn_browser_agent_v3.handler import _publish_browser_session_metadata_message
    from tools.base import MessageStatus

    session_metadata = {
        "provider": "kernel",
        "profile_source": "new_user_persistent",
        "auth_source": "none",
        "cookies_injected": False,
    }
    with (
        patch(
            "domains.spawn_browser_agent_v3.handler.save_browser_action_message",
            new_callable=AsyncMock,
        ) as save_mock,
        patch(
            "domains.spawn_browser_agent_v3.handler.asyncio.sleep",
            new_callable=AsyncMock,
        ) as sleep_mock,
    ):
        save_mock.side_effect = [False, False, True]
        with patch.dict(os.environ, {"BROWSER_AGENT_RECORDINGS": "0"}):
            await _publish_browser_session_metadata_message(
                agent_id="agent-1",
                task_id="task-1",
                browser_url="https://kernel.example/live/session-1",
                browser_session_metadata=session_metadata,
            )

    assert save_mock.await_count == 3
    assert sleep_mock.await_count == 2
    assert len({call.kwargs["tool_call_id"] for call in save_mock.await_args_list}) == 1
    kwargs = save_mock.await_args_list[-1].kwargs
    assert kwargs["title"] == "Browser session ready"
    assert kwargs["status"] == MessageStatus.FINISHED
    assert kwargs["action_type"] == "session_init"
    assert kwargs["task_id"] == "task-1"
    assert kwargs["browser_url"] == "https://kernel.example/live/session-1"
    assert kwargs["extra_metadata"] == {"browser_session_metadata": session_metadata}

    # Cement the real activity path and ordering: successful browser setup,
    # required metadata, credential evidence, then optional recorder setup.
    source = inspect.getsource(handler._spawn_browser_agent_activity_v3_real)
    browser_ready = source.index(") = browser_result")
    publish = source.index("await _publish_browser_session_metadata_message(", browser_ready)
    credential = source.index("await save_browser_credential_ref_message(", publish)
    recorder = source.index("async def _setup_interaction_layer():", credential)
    assert browser_ready < publish < credential < recorder

async def test_browser_session_metadata_failure_is_fail_closed():
    from domains.spawn_browser_agent_v3.handler import _publish_browser_session_metadata_message

    with (
        patch(
            "domains.spawn_browser_agent_v3.handler.save_browser_action_message",
            new_callable=AsyncMock,
            return_value=False,
        ) as save_mock,
        patch(
            "domains.spawn_browser_agent_v3.handler.asyncio.sleep",
            new_callable=AsyncMock,
        ) as sleep_mock,
    ):
        try:
            await _publish_browser_session_metadata_message(
                agent_id="agent-1",
                task_id="task-1",
                browser_url="https://kernel.example/live/session-1",
                browser_session_metadata={"provider": "kernel"},
            )
        except RuntimeError as exc:
            assert "did not acknowledge required browser session metadata" in str(exc)
        else:
            raise AssertionError("required browser session metadata must fail closed")

    assert save_mock.await_count == 3
    assert sleep_mock.await_count == 2

async def test_browser_session_metadata_rejects_missing_provider_before_publication():
    from domains.spawn_browser_agent_v3.handler import _publish_browser_session_metadata_message

    with patch(
        "domains.spawn_browser_agent_v3.handler.save_browser_action_message",
        new_callable=AsyncMock,
    ) as save_mock:
        for invalid_metadata in ({}, {"provider": ""}, {"provider": None}):
            try:
                await _publish_browser_session_metadata_message(
                    agent_id="agent-1",
                    task_id="task-1",
                    browser_url="https://kernel.example/live/session-1",
                    browser_session_metadata=invalid_metadata,
                )
            except ValueError as exc:
                assert "non-empty provider" in str(exc)
            else:
                raise AssertionError("missing browser session provider must fail closed")

    assert save_mock.await_count == 0

async def test_browser_agent_recording_start_failure_is_best_effort():
    import tempfile
    from pathlib import Path

    from domains.spawn_browser_agent_v3.recording import BrowserAgentRecorder

    class FakePage:
        async def screenshot(self, **kwargs):
            return b"fake-jpeg-bytes"

    class FailingStartRecorder(BrowserAgentRecorder):
        async def start(self) -> None:
            self.frames_dir.mkdir(parents=True, exist_ok=True)
            (self.output_dir / "partial.txt").write_text("partial", encoding="utf-8")
            raise RuntimeError("start failed after scratch creation")

    previous_enabled = os.environ.get("BROWSER_AGENT_RECORDINGS")
    previous_dir = os.environ.get("BROWSER_AGENT_RECORDINGS_DIR")
    previous_cleanup = os.environ.get("BROWSER_AGENT_RECORDINGS_CLEANUP_LOCAL")
    try:
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["BROWSER_AGENT_RECORDINGS"] = "1"
            os.environ["BROWSER_AGENT_RECORDINGS_DIR"] = tmp
            os.environ["BROWSER_AGENT_RECORDINGS_CLEANUP_LOCAL"] = "1"

            recorder = await FailingStartRecorder.create(
                page=FakePage(),
                agent_id="agent-1",
                task_id="task-1",
                session_id="session-1",
                browser_url="",
            )

            assert recorder is None
            assert not (Path(tmp) / "agent-1" / "task-1").exists()
    finally:
        if previous_enabled is None:
            os.environ.pop("BROWSER_AGENT_RECORDINGS", None)
        else:
            os.environ["BROWSER_AGENT_RECORDINGS"] = previous_enabled
        if previous_dir is None:
            os.environ.pop("BROWSER_AGENT_RECORDINGS_DIR", None)
        else:
            os.environ["BROWSER_AGENT_RECORDINGS_DIR"] = previous_dir
        if previous_cleanup is None:
            os.environ.pop("BROWSER_AGENT_RECORDINGS_CLEANUP_LOCAL", None)
        else:
            os.environ["BROWSER_AGENT_RECORDINGS_CLEANUP_LOCAL"] = previous_cleanup

class _FakeReplayResponse:
    def __init__(self, json_data, status=200):
        self._json = json_data
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._json

class _FakeReplayClient:
    """Stands in for Kernel's replay REST API (POST start / POST stop / GET list)."""

    def __init__(self, calls, *, fail_start=False):
        self._calls = calls
        self._fail_start = fail_start

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, headers=None, json=None):
        self._calls.append(("POST", url))
        if url.endswith("/stop"):
            return _FakeReplayResponse({})
        # start (POST /browsers/{id}/replays)
        if self._fail_start:
            raise RuntimeError("kernel replay start unavailable")
        return _FakeReplayResponse(
            {"replay_id": "rep-1", "replay_view_url": "https://kernel.example/replays?jwt=START"}
        )

    async def get(self, url, headers=None):
        self._calls.append(("GET", url))
        return _FakeReplayResponse(
            [{"replay_id": "rep-1", "replay_view_url": "https://kernel.example/replays?jwt=FINAL"}]
        )

def _kernel_replay_env():
    """Set env for kernel-replay mode; returns a restore() to reset it."""
    keys = ["BROWSER_AGENT_KERNEL_REPLAY", "KERNEL_API_KEY", "KERNEL_API_BASE_URL"]
    previous = {k: os.environ.get(k) for k in keys}
    os.environ["BROWSER_AGENT_KERNEL_REPLAY"] = "1"
    os.environ["KERNEL_API_KEY"] = "test-kernel-key"
    os.environ["KERNEL_API_BASE_URL"] = "https://kernel.example"

    def restore():
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    return restore

class _SessionAwareReplayClient:
    """Replay REST stub that mints a DISTINCT view URL per session, so a rotation
    (which stands up a new session) yields a distinguishable replay segment."""

    def __init__(self, calls):
        self._calls = calls

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    @staticmethod
    def _session_from_url(url: str) -> str:
        # .../browsers/<session>/replays[...]
        return url.split("/browsers/", 1)[1].split("/replays", 1)[0]

    async def post(self, url, headers=None, json=None):
        self._calls.append(("POST", url))
        if url.endswith("/stop"):
            return _FakeReplayResponse({})
        session = self._session_from_url(url)
        return _FakeReplayResponse(
            {"replay_id": f"rep-{session}", "replay_view_url": f"https://kernel.example/view/{session}"}
        )

    async def get(self, url, headers=None):
        self._calls.append(("GET", url))
        session = self._session_from_url(url)
        return _FakeReplayResponse(
            [{"replay_id": f"rep-{session}", "replay_view_url": f"https://kernel.example/view/{session}"}]
        )

async def test_browser_agent_kernel_replay_follows_rotation():
    """rotate_ip evicts the session and stands up a new one on a different exit IP.
    The recorder must start a fresh replay segment per session so the recording
    follows the rotation (and shows the IP change) instead of freezing on session 1."""
    from unittest import mock

    from domains.spawn_browser_agent_v3 import recording as recording_module
    from domains.spawn_browser_agent_v3.recording import BrowserAgentRecorder

    restore = _kernel_replay_env()
    calls: list = []
    try:
        with mock.patch.object(
            recording_module.httpx,
            "AsyncClient",
            lambda *a, **k: _SessionAwareReplayClient(calls),
        ):
            recorder = await BrowserAgentRecorder.create(
                page=object(),
                agent_id="agent-1",
                task_id="task-1",
                session_id="sess-A",
                browser_url="https://kernel.example/live/A",
                session_metadata={"provider": "kernel"},
            )
            assert recorder is not None
            # Baseline segment (session A).
            assert recorder.replay_view_urls == ["https://kernel.example/view/sess-A"]

            # First rotation -> session B, second rotation -> session C.
            await recorder.rotate_kernel_replay("sess-B")
            await recorder.rotate_kernel_replay("sess-C")

            # Three distinct segments in rotation order (baseline first).
            assert recorder.replay_view_urls == [
                "https://kernel.example/view/sess-A",
                "https://kernel.example/view/sess-B",
                "https://kernel.example/view/sess-C",
            ]
            # A fresh replay was started on each rotated session.
            assert ("POST", "https://kernel.example/browsers/sess-B/replays") in calls
            assert ("POST", "https://kernel.example/browsers/sess-C/replays") in calls
            # The outgoing session's replay was best-effort stopped on rotation.
            assert ("POST", "https://kernel.example/browsers/sess-A/replays/rep-sess-A/stop") in calls

            # Finalize still returns a view URL; segments survive.
            final = await recorder.stop_kernel_replay()
            assert final == "https://kernel.example/view/sess-C"
            assert len(recorder.replay_view_urls) == 3

            # A no-op rotation (same session / empty) adds no segment.
            await recorder.rotate_kernel_replay("sess-C")
            await recorder.rotate_kernel_replay("")
    finally:
        restore()

async def test_browser_agent_recording_survives_kernel_to_steel_recovery():
    """A config-search handoff must not close the recorder when the winning
    session changes providers.  The finished replay must contain both the
    outgoing Kernel segment and frames captured from the promoted Steel page."""
    import tempfile
    import re
    import subprocess
    from unittest import mock

    from domains.spawn_browser_agent_v3 import recording as recording_module
    from domains.spawn_browser_agent_v3.recording import BrowserAgentRecorder

    class SteelContext:
        def __init__(self):
            self.pages = []

    class SteelPage:
        def __init__(self):
            self.context = SteelContext()
            self.context.pages = [self]
            self.url = "https://order.online/checkout"

        async def screenshot(self, **_kwargs):
            return b"steel-frame"

    restore = _kernel_replay_env()
    previous_dir = os.environ.get("BROWSER_AGENT_RECORDINGS_DIR")
    calls: list = []
    try:
        with tempfile.TemporaryDirectory() as temp_dir:
            os.environ["BROWSER_AGENT_RECORDINGS_DIR"] = temp_dir
            with mock.patch.object(
                recording_module.httpx,
                "AsyncClient",
                lambda *a, **k: _SessionAwareReplayClient(calls),
            ):
                recorder = await BrowserAgentRecorder.create(
                    page=object(),
                    agent_id="agent-1",
                    task_id="task-1",
                    session_id="kernel-before",
                    browser_url="https://kernel.example/live/before",
                    session_metadata={"provider": "kernel"},
                )
                assert recorder is not None
                assert recorder.uses_kernel_replay is True

                await recorder.transition_browser(
                    page=SteelPage(),
                    session_id="steel-after",
                    browser_url="https://steel.example/live/after",
                    session_metadata={"provider": "steel"},
                )
                await recorder.mark("post-recovery checkout", action="recovery")

                assert any(frame["label"] == "post-recovery checkout" for frame in recorder.frames), (
                    "the promoted Steel half of the recording was dropped"
                )
                assert recorder.uses_kernel_replay is False
                assert recorder._closed is False
                assert recorder.session_id == "steel-after"
                assert recorder.replay_view_urls == ["https://kernel.example/view/kernel-before"]
                inline = recorder.export_inline_html_bytes()
                assert inline is not None
                html_text = inline.decode("utf-8")
                assert "https://kernel.example/view/kernel-before" in html_text
                assert "post-recovery checkout" in html_text
                assert "prefixVideo.onended" in html_text
                assert "beginFrameReplay(true)" in html_text
                scripts = re.findall(r"<script>(.*?)</script>", html_text, flags=re.DOTALL)
                assert len(scripts) == 1
                parsed = subprocess.run(
                    ["node", "--check", "-"],
                    input=scripts[0],
                    text=True,
                    capture_output=True,
                    check=False,
                )
                assert parsed.returncode == 0, parsed.stderr
                await recorder.close(include_steel_media=False)
                stop_url = "https://kernel.example/browsers/kernel-before/replays/rep-kernel-before/stop"
                assert calls.count(("POST", stop_url)) == 1
    finally:
        restore()
        if previous_dir is None:
            os.environ.pop("BROWSER_AGENT_RECORDINGS_DIR", None)
        else:
            os.environ["BROWSER_AGENT_RECORDINGS_DIR"] = previous_dir

async def test_browser_agent_recording_rebinds_screenshot_mode_across_providers():
    """Steel -> Steel and Steel -> Kernel keep one screenshot timeline. Once a
    recording is in screenshot mode it must not open an unrelated native replay
    midway through the same Browser Agent tool call."""
    import tempfile

    from domains.spawn_browser_agent_v3.recording import BrowserAgentRecorder

    class PageContext:
        def __init__(self):
            self.pages = []

    class ScreenshotPage:
        def __init__(self, name: str):
            self.name = name
            self.context = PageContext()
            self.context.pages = [self]
            self.url = f"https://{name}.example/"

        async def screenshot(self, **_kwargs):
            return f"frame-{self.name}".encode()

    restore = _kernel_replay_env()
    previous_dir = os.environ.get("BROWSER_AGENT_RECORDINGS_DIR")
    try:
        with tempfile.TemporaryDirectory() as temp_dir:
            os.environ["BROWSER_AGENT_RECORDINGS_DIR"] = temp_dir
            first_page = ScreenshotPage("steel-one")
            recorder = BrowserAgentRecorder(
                page=first_page,
                agent_id="agent-1",
                task_id="task-1",
                session_id="steel-one",
                browser_url=first_page.url,
                session_metadata={"provider": "steel"},
            )
            await recorder.start()
            capture_loop = recorder._loop_task
            assert capture_loop is not None

            steel_page = ScreenshotPage("steel-two")
            await recorder.transition_browser(
                page=steel_page,
                session_id="steel-two",
                browser_url=steel_page.url,
                session_metadata={"provider": "steel"},
            )
            assert recorder.page is steel_page
            assert recorder.session_id == "steel-two"
            assert recorder._loop_task is capture_loop

            kernel_page = ScreenshotPage("kernel-three")
            await recorder.transition_browser(
                page=kernel_page,
                session_id="kernel-three",
                browser_url=kernel_page.url,
                session_metadata={"provider": "kernel"},
            )
            assert recorder.page is kernel_page
            assert recorder.session_id == "kernel-three"
            assert recorder.uses_kernel_replay is False
            assert recorder.replay_view_urls == []
            assert recorder._loop_task is capture_loop
            captured_urls = [frame["tab_url"] for frame in recorder.frames]
            assert first_page.url in captured_urls
            assert steel_page.url in captured_urls
            assert kernel_page.url in captured_urls
            await recorder.close(include_steel_media=False)
    finally:
        restore()
        if previous_dir is None:
            os.environ.pop("BROWSER_AGENT_RECORDINGS_DIR", None)
        else:
            os.environ["BROWSER_AGENT_RECORDINGS_DIR"] = previous_dir

async def test_browser_agent_hybrid_player_advances_all_segments_and_rebases_time():
    """Execute the exported player: every Kernel segment must auto-advance before
    screenshot playback, whose real-time timeline starts at zero."""
    from playwright.async_api import async_playwright

    from domains.spawn_browser_agent_v3.recording import BrowserAgentRecorder

    recorder = BrowserAgentRecorder(
        page=object(),
        agent_id="agent-1",
        task_id="task-1",
        session_id="steel-final",
        browser_url="https://steel.example/final",
        session_metadata={"provider": "steel"},
    )
    recorder._replay_segments = [
        {"session_id": "kernel-1", "view_url": "data:video/mp4;base64,AAAA"},
        {"session_id": "kernel-2", "view_url": "data:video/mp4;base64,BBBB"},
    ]
    pixel = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
    recorder.frames = [
        {
            "src": pixel,
            "ts_ms": 90_000,
            "label": "promoted start",
            "action": "recovery",
            "cursor": None,
            "metadata": {},
            "size": 1,
        },
        {
            "src": pixel,
            "ts_ms": 91_000,
            "label": "checkout",
            "action": "stop",
            "cursor": None,
            "metadata": {},
            "size": 1,
        },
    ]
    html_text = recorder._build_html(recorder.frames)

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        try:
            page = await browser.new_page()
            await page.set_content(html_text)
            initial = await page.evaluate(
                """() => ({
                  videoHidden: prefixVideo.hidden,
                  canvasHidden: canvas.hidden,
                  timelineDisabled: timeline.disabled,
                  source: prefixVideo.getAttribute('src'),
                })"""
            )
            assert initial == {
                "videoHidden": False,
                "canvasHidden": True,
                "timelineDisabled": True,
                "source": "data:video/mp4;base64,AAAA",
            }
            await page.evaluate("skipIdle.checked = false; skipIdle.dispatchEvent(new Event('change'))")

            await page.evaluate("prefixVideo.dispatchEvent(new Event('ended'))")
            assert await page.evaluate("prefixVideo.getAttribute('src')") == ("data:video/mp4;base64,BBBB")

            await page.evaluate("prefixVideo.dispatchEvent(new Event('ended'))")
            final = await page.evaluate(
                """() => ({
                  videoHidden: prefixVideo.hidden,
                  canvasHidden: canvas.hidden,
                  timelineDisabled: timeline.disabled,
                  timelineMax: timeline.max,
                  firstFrameMs: frames[0].ts_ms,
                  secondFrameMs: frames[1].ts_ms,
                })"""
            )
            assert final == {
                "videoHidden": True,
                "canvasHidden": False,
                "timelineDisabled": False,
                "timelineMax": "1000",
                "firstFrameMs": 0,
                "secondFrameMs": 1000,
            }, final
        finally:
            await browser.close()

async def test_browser_agent_kernel_replay_uses_native_recording():
    """Kernel sessions reuse Kernel's native replay: start/stop the replay via
    REST, surface a hosted recording_view_url, and DON'T screenshot every frame."""
    from unittest import mock

    from domains.spawn_browser_agent_v3 import recording as recording_module
    from domains.spawn_browser_agent_v3.recording import BrowserAgentRecorder

    restore = _kernel_replay_env()
    calls: list = []
    try:
        with mock.patch.object(
            recording_module.httpx,
            "AsyncClient",
            lambda *a, **k: _FakeReplayClient(calls),
        ):
            recorder = await BrowserAgentRecorder.create(
                page=object(),  # replay mode needs no screenshot-capable page
                agent_id="agent-1",
                task_id="task-1",
                session_id="kernel-session-1",
                browser_url="https://kernel.example/live/xyz",
                session_metadata={"provider": "kernel"},
            )
            assert recorder is not None
            assert recorder.uses_kernel_replay is True
            assert recorder._kernel_replay_id == "rep-1"
            assert recorder.recording_view_url == "https://kernel.example/replays?jwt=START"
            assert ("POST", "https://kernel.example/browsers/kernel-session-1/replays") in calls

            # Screenshot/observation capture is a no-op in replay mode.
            recorder.set_cursor(10, 20)
            await recorder.mark("clicked", action="click", metadata={"step": 1})
            await recorder.capture("idle", action="idle")
            assert recorder.frames == []
            assert recorder.cursor_events == []

            view_url = await recorder.stop_kernel_replay()
            assert view_url == "https://kernel.example/replays?jwt=FINAL"
            assert recorder.recording_view_url == "https://kernel.example/replays?jwt=FINAL"
            assert (
                "POST",
                "https://kernel.example/browsers/kernel-session-1/replays/rep-1/stop",
            ) in calls
            assert ("GET", "https://kernel.example/browsers/kernel-session-1/replays") in calls
    finally:
        restore()

async def test_browser_agent_kernel_replay_start_failure_yields_no_recording():
    """If starting the Kernel replay fails, the run proceeds with no recording
    (we intentionally do NOT fall back to the dropped screenshot+Supabase path)."""
    from unittest import mock

    from domains.spawn_browser_agent_v3 import recording as recording_module
    from domains.spawn_browser_agent_v3.recording import BrowserAgentRecorder

    restore = _kernel_replay_env()
    calls: list = []
    try:
        with mock.patch.object(
            recording_module.httpx,
            "AsyncClient",
            lambda *a, **k: _FakeReplayClient(calls, fail_start=True),
        ):
            recorder = await BrowserAgentRecorder.create(
                page=object(),
                agent_id="agent-1",
                task_id="task-1",
                session_id="kernel-session-1",
                browser_url="",
                session_metadata={"provider": "kernel"},
            )
            # Kernel replay start failed → create() returns None: no recorder, no
            # recording. We intentionally do NOT leave a half-initialized screenshot
            # recorder (frames dir never created), whose finalization would then try
            # to write the final frame to a nonexistent directory.
            assert recorder is None
    finally:
        restore()

def test_browser_agent_recording_prod_default_uses_writable_temp_root():
    import tempfile
    from pathlib import Path

    from domains.spawn_browser_agent_v3.recording import _recording_root

    saved_env = {
        "ENVIRONMENT": os.environ.get("ENVIRONMENT"),
        "FLY_APP_NAME": os.environ.get("FLY_APP_NAME"),
        "CONDUCTOR_WORKSPACE_NAME": os.environ.get("CONDUCTOR_WORKSPACE_NAME"),
        "BROWSER_AGENT_RECORDINGS_DIR": os.environ.get("BROWSER_AGENT_RECORDINGS_DIR"),
    }
    try:
        os.environ["ENVIRONMENT"] = "production"
        os.environ.pop("FLY_APP_NAME", None)
        os.environ.pop("CONDUCTOR_WORKSPACE_NAME", None)
        os.environ.pop("BROWSER_AGENT_RECORDINGS_DIR", None)

        root = _recording_root()

        assert root == Path(tempfile.gettempdir()) / "rose-browser-agent-recordings"
    finally:
        for key, value in saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

def test_browser_agent_recording_fly_prod_default_uses_writable_temp_root():
    import tempfile
    from pathlib import Path

    from domains.spawn_browser_agent_v3.recording import _recording_root

    saved_env = {
        "ENVIRONMENT": os.environ.get("ENVIRONMENT"),
        "FLY_APP_NAME": os.environ.get("FLY_APP_NAME"),
        "CONDUCTOR_WORKSPACE_NAME": os.environ.get("CONDUCTOR_WORKSPACE_NAME"),
        "BROWSER_AGENT_RECORDINGS_DIR": os.environ.get("BROWSER_AGENT_RECORDINGS_DIR"),
    }
    try:
        os.environ.pop("ENVIRONMENT", None)
        os.environ["FLY_APP_NAME"] = "navi-whisper-lux"
        os.environ.pop("CONDUCTOR_WORKSPACE_NAME", None)
        os.environ.pop("BROWSER_AGENT_RECORDINGS_DIR", None)

        root = _recording_root()

        assert root == Path(tempfile.gettempdir()) / "rose-browser-agent-recordings"
    finally:
        for key, value in saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

def test_browser_agent_recording_prod_cleanup_removes_task_scratch():
    import tempfile
    from pathlib import Path

    from domains.spawn_browser_agent_v3.recording import BrowserAgentRecorder

    saved_env = {
        "ENVIRONMENT": os.environ.get("ENVIRONMENT"),
        "FLY_APP_NAME": os.environ.get("FLY_APP_NAME"),
        "CONDUCTOR_WORKSPACE_NAME": os.environ.get("CONDUCTOR_WORKSPACE_NAME"),
        "BROWSER_AGENT_RECORDINGS_DIR": os.environ.get("BROWSER_AGENT_RECORDINGS_DIR"),
        "BROWSER_AGENT_RECORDINGS_CLEANUP_LOCAL": os.environ.get("BROWSER_AGENT_RECORDINGS_CLEANUP_LOCAL"),
    }
    try:
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["FLY_APP_NAME"] = "navi-whisper-lux"
            os.environ.pop("ENVIRONMENT", None)
            os.environ.pop("CONDUCTOR_WORKSPACE_NAME", None)
            os.environ["BROWSER_AGENT_RECORDINGS_DIR"] = tmp
            os.environ.pop("BROWSER_AGENT_RECORDINGS_CLEANUP_LOCAL", None)

            recorder = BrowserAgentRecorder(
                page=object(),
                agent_id="agent-prod",
                task_id="task-prod",
                session_id="session-prod",
                browser_url="",
            )
            recorder.output_dir.mkdir(parents=True)
            artifact = recorder.output_dir / "index.html"
            artifact.write_text("<html>scratch</html>", encoding="utf-8")

            recorder.cleanup_local_artifacts(persisted=True)

            assert not recorder.output_dir.exists()
            assert Path(tmp).exists()
    finally:
        for key, value in saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

async def test_browser_agent_recording_enabled_by_trace_archive_in_prod():
    import tempfile
    from pathlib import Path

    import helpers.trace_archive as trace_archive
    from domains.spawn_browser_agent_v3.recording import BrowserAgentRecorder

    class FakePage:
        async def screenshot(self, **kwargs):
            return b"fake-jpeg-bytes"

        async def content(self):
            return "<html><body>prod archive dom</body></html>"

    saved_env = {
        "ENVIRONMENT": os.environ.get("ENVIRONMENT"),
        "TRACE_ARCHIVE_ENABLED": os.environ.get("TRACE_ARCHIVE_ENABLED"),
        "TRACE_ARCHIVE_BACKEND": os.environ.get("TRACE_ARCHIVE_BACKEND"),
        "TRACE_ARCHIVE_ENCRYPTION_KEY_B64": os.environ.get("TRACE_ARCHIVE_ENCRYPTION_KEY_B64"),
        "BROWSER_AGENT_RECORDINGS": os.environ.get("BROWSER_AGENT_RECORDINGS"),
        "BROWSER_AGENT_RECORDINGS_DIR": os.environ.get("BROWSER_AGENT_RECORDINGS_DIR"),
        "BROWSER_AGENT_RECORDING_INTERVAL_SECONDS": os.environ.get("BROWSER_AGENT_RECORDING_INTERVAL_SECONDS"),
    }
    old_archive_root = trace_archive._LOCAL_ROOT
    old_store = trace_archive.store_encrypted_artifact
    try:
        uploaded_paths = []

        def fake_store_encrypted_artifact(*, root_agent_id, path, ciphertext, metadata):
            uploaded_paths.append((root_agent_id, path, len(ciphertext), metadata))
            return f"r2://fake/{root_agent_id}/{path}"

        trace_archive.store_encrypted_artifact = fake_store_encrypted_artifact
        with tempfile.TemporaryDirectory() as recordings, tempfile.TemporaryDirectory() as archive:
            os.environ["ENVIRONMENT"] = "production"
            os.environ["TRACE_ARCHIVE_ENABLED"] = "1"
            os.environ["TRACE_ARCHIVE_BACKEND"] = "r2"
            os.environ["TRACE_ARCHIVE_ENCRYPTION_KEY_B64"] = base64.b64encode(b"b" * 32).decode("ascii")
            os.environ.pop("BROWSER_AGENT_RECORDINGS", None)
            os.environ["BROWSER_AGENT_RECORDINGS_DIR"] = recordings
            os.environ["BROWSER_AGENT_RECORDING_INTERVAL_SECONDS"] = "60"
            trace_archive._LOCAL_ROOT = Path(archive)
            recorder = await BrowserAgentRecorder.create(
                page=FakePage(),
                agent_id="agent-prod",
                task_id="task-prod",
                session_id="session-prod",
                browser_url="",
            )
            assert recorder is not None
            await recorder.close()
            paths = [path for _root, path, _size, _metadata in uploaded_paths]
            assert "media/browser/task-prod/manifest.json" in paths
            assert "media/browser/task-prod/final-dom.html" in paths
            assert "media/browser/task-prod/index.html" in paths
            assert any(path.startswith("media/browser/task-prod/frames/") for path in paths)
            assert all(root == "agent-prod" for root, _path, _size, _metadata in uploaded_paths)
            assert all(size > 0 for _root, _path, size, _metadata in uploaded_paths)
    finally:
        trace_archive._LOCAL_ROOT = old_archive_root
        trace_archive.store_encrypted_artifact = old_store
        for key, value in saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

def test_browser_agent_recording_supports_video_rate_replay():
    from domains.spawn_browser_agent_v3.recording import BrowserAgentRecorder

    previous_interval = os.environ.get("BROWSER_AGENT_RECORDING_INTERVAL_SECONDS")
    try:
        os.environ["BROWSER_AGENT_RECORDING_INTERVAL_SECONDS"] = "0.01"
        recorder = BrowserAgentRecorder(
            page=object(),
            agent_id="agent-1",
            task_id="task-1",
            session_id="session-1",
            browser_url="",
        )
        recorder.frames = [
            {
                "src": "frames/frame_00001.jpg",
                "ts_ms": 0,
                "label": "start",
                "action": "start",
                "cursor": {"x": 20, "y": 20},
                "metadata": {},
                "size": 1,
            },
            {
                "src": "frames/frame_00002.jpg",
                "ts_ms": 1000,
                "label": "done",
                "action": "stop",
                "cursor": {"x": 120, "y": 80},
                "metadata": {},
                "size": 1,
            },
        ]
        recorder.cursor_events = [
            {"ts_ms": 0, "x": 20, "y": 20},
            {"ts_ms": 33, "x": 40, "y": 30},
            {"ts_ms": 66, "x": 60, "y": 40},
        ]

        assert recorder.interval_seconds == 1 / 30
        playback_frames = recorder._build_playback_frames()
        assert len(playback_frames) >= 30
        assert playback_frames[1]["ts_ms"] == 33
        assert playback_frames[1]["cursor"] == {"x": 40, "y": 30}
        assert playback_frames[1]["src"] == "frames/frame_00001.jpg"
        html_text = recorder._build_html()
        assert "requestAnimationFrame(tick)" in html_text
        assert "frameIndexAtTime" in html_text
        assert "timeline.max = totalMs" in html_text
        # Cursor is drawn per-frame in the redesigned single-column player.
        assert "drawCursor(cursorAtTime(cursorTs) || cursorByFrame[idx])" in html_text
        assert "cursorTs = frameRealTs + (nextRealTs - frameRealTs) * frameT" in html_text
    finally:
        if previous_interval is None:
            os.environ.pop("BROWSER_AGENT_RECORDING_INTERVAL_SECONDS", None)
        else:
            os.environ["BROWSER_AGENT_RECORDING_INTERVAL_SECONDS"] = previous_interval

async def test_browser_recording_finalizer_uploads_frame_replay_after_cancellation():
    import tempfile

    from domains.spawn_browser_agent_v3.handler import _finalize_browser_recording_for_fe_resilient

    class SlowCloseRecorder:
        def __init__(self, output_dir):
            self.output_dir = Path(output_dir)
            self.release = asyncio.Event()
            self.include_steel_media = None

        async def close(self, *, include_steel_media=True, archive_artifacts=True):
            self.include_steel_media = include_steel_media
            await self.release.wait()
            self.output_dir.mkdir(parents=True, exist_ok=True)
            path = self.output_dir / "index.html"
            path.write_text("<html>recording</html>", encoding="utf-8")
            return path

        def export_inline_html_bytes(self):
            return b"<html>inline frame replay with cursorEvents and tab_url</html>"

    with tempfile.TemporaryDirectory() as tmp:
        recorder = SlowCloseRecorder(tmp)
        with (
            patch(
                "domains.spawn_browser_agent_v3.handler.upload_to_storage",
                new_callable=AsyncMock,
                return_value={"id": "file-pointer-1"},
            ) as upload_mock,
            patch(
                "domains.spawn_browser_agent_v3.handler.save_browser_action_message",
                new_callable=AsyncMock,
            ) as save_mock,
        ):
            finalize_task = asyncio.create_task(
                _finalize_browser_recording_for_fe_resilient(
                    browser_recorder=recorder,
                    agent_id="agent-1",
                    task_id="task-1",
                    user_id="user-1",
                    browser_url="https://debug",
                    browser_session_metadata={"provider": "steel"},
                    timeout_seconds=2,
                )
            )
            await asyncio.sleep(0)
            finalize_task.cancel()
            await asyncio.sleep(0)
            recorder.release.set()

            result = await finalize_task

        assert result is not None
        assert result["recording_file_pointer"] == {"id": "file-pointer-1"}
        assert recorder.include_steel_media is False
        upload_mock.assert_awaited_once()
        save_mock.assert_awaited_once()
        metadata = save_mock.await_args.kwargs["extra_metadata"]
        assert metadata["recording_file_pointer"] == {"id": "file-pointer-1"}
        assert metadata["browser_session_metadata"] == {"provider": "steel"}

async def test_browser_recording_finalizer_persists_before_trace_archive():
    """FE persistence is the critical path; the trace copy is background work.

    Production generated the replay locally, then spent >45s archiving hundreds
    of frame/network files before it could upload the HTML or save its pointer.
    """
    import tempfile

    from domains.spawn_browser_agent_v3.handler import _finalize_browser_recording_for_fe_resilient

    class ArchiveBlockingRecorder:
        def __init__(self, output_dir):
            self.output_dir = Path(output_dir)
            self.close_archive_artifacts = None
            self.archive_scheduled = False

        async def close(self, *, include_steel_media=True, archive_artifacts=True):
            self.close_archive_artifacts = archive_artifacts
            if archive_artifacts:
                await asyncio.Event().wait()
            self.output_dir.mkdir(parents=True, exist_ok=True)
            path = self.output_dir / "index.html"
            path.write_text("<html>recording</html>", encoding="utf-8")
            return path

        def export_inline_html_bytes(self):
            return b"<html>inline frame replay</html>"

        def archive_recording_artifacts_in_background(self, *, cleanup_after=False):
            self.archive_scheduled = True
            return True

    with tempfile.TemporaryDirectory() as tmp:
        recorder = ArchiveBlockingRecorder(tmp)
        with (
            patch(
                "domains.spawn_browser_agent_v3.handler.upload_to_storage",
                new_callable=AsyncMock,
                return_value={"id": "file-pointer-1"},
            ) as upload_mock,
            patch(
                "domains.spawn_browser_agent_v3.handler.save_browser_action_message",
                new_callable=AsyncMock,
            ) as save_mock,
        ):
            result = await _finalize_browser_recording_for_fe_resilient(
                browser_recorder=recorder,
                agent_id="agent-1",
                task_id="task-1",
                user_id="user-1",
                browser_url="https://debug",
                browser_session_metadata={"provider": "steel"},
                timeout_seconds=0.1,
            )

        assert result is not None
        assert result["recording_file_pointer"] == {"id": "file-pointer-1"}
        assert recorder.close_archive_artifacts is False
        assert recorder.archive_scheduled is True
        upload_mock.assert_awaited_once()
        save_mock.assert_awaited_once()

async def test_browser_recording_background_archive_keeps_event_loop_responsive():
    """Real recorder directory reads must run outside the worker event loop."""
    import tempfile

    import domains.spawn_browser_agent_v3.recording as recording

    with tempfile.TemporaryDirectory() as tmp:
        recorder = recording.BrowserAgentRecorder(
            page=MagicMock(),
            agent_id="agent-responsive",
            task_id="task-responsive",
            session_id="session-responsive",
            browser_url="https://example.com",
        )
        recorder.output_dir = Path(tmp)
        for index in range(3):
            (recorder.output_dir / f"frame-{index}.png").write_bytes(b"frame")

        original_read_bytes = Path.read_bytes

        def slow_read_bytes(path):
            time_module.sleep(0.05)
            return original_read_bytes(path)

        with (
            patch.object(recording, "archive_enabled", return_value=True),
            patch.object(recording, "archive_bytes", return_value={"ref": "archive-ref"}),
            patch.object(Path, "read_bytes", slow_read_bytes),
        ):
            assert recorder.archive_recording_artifacts_in_background() is True
            started = time_module.monotonic()
            await asyncio.sleep(0.01)
            elapsed = time_module.monotonic() - started
            assert elapsed < 0.12, f"recording archive blocked the event loop for {elapsed:.3f}s"
            await asyncio.gather(*list(recording._BACKGROUND_RECORDING_ARCHIVE_TASKS))

async def test_browser_recording_finalizer_keeps_local_artifacts_when_upload_fails():
    import shutil
    import tempfile

    from domains.spawn_browser_agent_v3.handler import _finalize_browser_recording_for_fe

    class UploadFailRecorder:
        def __init__(self, output_dir):
            self.output_dir = Path(output_dir)
            self.cleanup_persisted = None

        async def close(self, *, include_steel_media=True, archive_artifacts=True):
            self.output_dir.mkdir(parents=True, exist_ok=True)
            path = self.output_dir / "index.html"
            path.write_text("<html>recording</html>", encoding="utf-8")
            return path

        def export_inline_html_bytes(self):
            return b"<html>inline frame replay</html>"

        def cleanup_local_artifacts(self, *, persisted=False):
            self.cleanup_persisted = persisted
            if persisted:
                shutil.rmtree(self.output_dir)

    with tempfile.TemporaryDirectory() as tmp:
        recorder = UploadFailRecorder(tmp)
        with (
            patch(
                "domains.spawn_browser_agent_v3.handler.upload_to_storage",
                new_callable=AsyncMock,
                side_effect=RuntimeError("storage down"),
            ) as upload_mock,
            patch(
                "domains.spawn_browser_agent_v3.handler.save_browser_action_message",
                new_callable=AsyncMock,
            ) as save_mock,
        ):
            result = await _finalize_browser_recording_for_fe(
                browser_recorder=recorder,
                agent_id="agent-1",
                task_id="task-1",
                user_id="user-1",
                browser_url="https://debug",
                browser_session_metadata={"provider": "steel"},
            )

        assert result is not None
        assert result["recording_file_pointer"] is None
        assert recorder.cleanup_persisted is False
        assert recorder.output_dir.exists()
        upload_mock.assert_awaited_once()
        save_mock.assert_awaited_once()
        metadata = save_mock.await_args.kwargs["extra_metadata"]
        assert metadata["recording_file_pointer"] is None


async def test_browser_diagnostics_finalizer_uploads_and_attaches_durable_pointer():
    import tempfile

    from domains.spawn_browser_agent_v3.handler import _finalize_browser_diagnostics_for_fe

    class DiagnosticsRecorder:
        def __init__(self, output_dir):
            self.output_dir = Path(output_dir)
            self.console_index_path = self.output_dir / "console" / "index.json"
            self.network_index_path = self.output_dir / "network" / "index.json"

        async def close(self):
            self.console_index_path.parent.mkdir(parents=True, exist_ok=True)
            self.network_index_path.parent.mkdir(parents=True, exist_ok=True)
            self.console_index_path.write_text('{"entries":[]}', encoding="utf-8")
            self.network_index_path.write_text('{"entries":[]}', encoding="utf-8")
            return self.network_index_path

        def export_diagnostics_bundle_bytes(self):
            return b"redacted diagnostics zip"

        async def archive_diagnostics_artifacts(self):
            return {
                "console": "r2://trace/console.json.gz.enc",
                "network": "r2://trace/network.json.gz.enc",
            }

    with tempfile.TemporaryDirectory() as tmp:
        recorder = DiagnosticsRecorder(tmp)
        with (
            patch(
                "domains.spawn_browser_agent_v3.handler.upload_to_storage",
                new_callable=AsyncMock,
                return_value={
                    "id": "diagnostics-pointer-1",
                    "storage_path": "user-1/diagnostics.zip",
                },
            ) as upload_mock,
            patch(
                "domains.spawn_browser_agent_v3.handler.save_browser_action_message",
                new_callable=AsyncMock,
            ) as save_mock,
        ):
            result = await _finalize_browser_diagnostics_for_fe(
                browser_network_recorder=recorder,
                agent_id="agent-1",
                task_id="task-1",
                user_id="user-1",
                browser_url="https://debug",
            )

    assert result is not None
    assert result["browser_diagnostics_file_pointer"]["id"] == "diagnostics-pointer-1"
    upload_mock.assert_awaited_once_with(
        user_id="user-1",
        file_content=b"redacted diagnostics zip",
        filename="browser-diagnostics-task-1.zip",
        mime_type="application/zip",
    )
    save_mock.assert_awaited_once()
    metadata = save_mock.await_args.kwargs["extra_metadata"]
    assert metadata["browser_diagnostics_file_pointer"]["id"] == "diagnostics-pointer-1"
    assert metadata["console_log_path"].endswith("console/index.json")
    assert metadata["network_recording_path"].endswith("network/index.json")
    assert metadata["trace_archive_refs"] == {
        "console": "r2://trace/console.json.gz.enc",
        "network": "r2://trace/network.json.gz.enc",
    }


async def test_browser_cleanup_scheduler_does_not_block_on_recording_finalization():
    import tempfile

    from domains.spawn_browser_agent_v3.handler import (
        _background_browser_cleanup_tasks,
        _schedule_browser_cleanup,
    )

    class SlowRecorder:
        def __init__(self, output_dir):
            self.output_dir = Path(output_dir)
            self.release = asyncio.Event()
            self.cleanup_called = False

        async def close(self, *, include_steel_media=True, archive_artifacts=True):
            await self.release.wait()
            self.output_dir.mkdir(parents=True, exist_ok=True)
            path = self.output_dir / "index.html"
            path.write_text("<html>recording</html>", encoding="utf-8")
            return path

        def export_inline_html_bytes(self):
            return b"<html>inline replay</html>"

        def cleanup_local_artifacts(self, *, persisted=False):
            self.cleanup_called = True

    with tempfile.TemporaryDirectory() as tmp:
        recorder = SlowRecorder(tmp)
        with (
            patch(
                "domains.spawn_browser_agent_v3.handler.upload_to_storage",
                new_callable=AsyncMock,
                return_value={"id": "file-pointer-1"},
            ) as upload_mock,
            patch(
                "domains.spawn_browser_agent_v3.handler.save_browser_action_message",
                new_callable=AsyncMock,
            ) as save_mock,
        ):
            cleanup_task = _schedule_browser_cleanup(
                agent_id="agent-1",
                task_id="task-1",
                user_id="user-1",
                browser_url="https://debug",
                browser_session_metadata={"provider": "steel"},
                input_page=None,
                start_url="",
                cursor_streamer=None,
                interaction_layer_task=None,
                humanizer=None,
                browser_network_recorder=None,
                network_recorder_task=None,
                browser_recorder=recorder,
                dom_service=None,
                playwright_browser=None,
                playwright_instance=None,
                playwright_driver_pid=None,
            )
            await asyncio.sleep(0)

            assert cleanup_task in _background_browser_cleanup_tasks
            assert not cleanup_task.done()
            upload_mock.assert_not_awaited()
            save_mock.assert_not_awaited()

            recorder.release.set()
            await cleanup_task

        assert cleanup_task not in _background_browser_cleanup_tasks
        assert recorder.cleanup_called is True
        upload_mock.assert_awaited_once()
        save_mock.assert_awaited_once()

async def test_drain_background_browser_cleanups_waits_then_times_out():
    import contextlib

    from domains.spawn_browser_agent_v3.handler import (
        _background_browser_cleanup_tasks,
        drain_background_browser_cleanups,
    )

    # No pending tasks -> returns immediately.
    await asyncio.wait_for(drain_background_browser_cleanups(timeout=0.1), timeout=1)

    release = asyncio.Event()

    async def _slow_cleanup() -> None:
        await release.wait()

    task = asyncio.create_task(_slow_cleanup())
    _background_browser_cleanup_tasks.add(task)
    task.add_done_callback(lambda done: _background_browser_cleanup_tasks.discard(done))
    try:
        # Drain blocks while the cleanup is in-flight, then times out without
        # raising (worker shutdown must not hang forever on a stuck teardown).
        await asyncio.wait_for(drain_background_browser_cleanups(timeout=0.2), timeout=2)
        assert not task.done()  # still running; drain did not cancel it

        # Once the cleanup finishes, drain returns promptly by awaiting it.
        release.set()
        await asyncio.wait_for(drain_background_browser_cleanups(timeout=1.0), timeout=2)
        assert task.done()
    finally:
        release.set()
        with contextlib.suppress(Exception):
            await task
        _background_browser_cleanup_tasks.discard(task)

def test_browser_agent_recording_inline_export_uses_source_frames_once():
    import tempfile

    from domains.spawn_browser_agent_v3.recording import BrowserAgentRecorder

    previous_dir = os.environ.get("BROWSER_AGENT_RECORDINGS_DIR")
    try:
        with tempfile.TemporaryDirectory() as temp_dir:
            os.environ["BROWSER_AGENT_RECORDINGS_DIR"] = temp_dir
            recorder = BrowserAgentRecorder(
                page=object(),
                agent_id="agent-1",
                task_id="task-1",
                session_id="session-1",
                browser_url="",
            )
            frames_dir = recorder.output_dir / "frames"
            frames_dir.mkdir(parents=True)
            (frames_dir / "frame_00001.jpg").write_bytes(b"first")
            (frames_dir / "frame_00002.jpg").write_bytes(b"second")
            recorder.frames = [
                {
                    "src": "frames/frame_00001.jpg",
                    "ts_ms": 0,
                    "label": "start",
                    "action": "start",
                    "cursor": None,
                    "metadata": {},
                    "size": 5,
                },
                {
                    "src": "frames/frame_00002.jpg",
                    "ts_ms": 1000,
                    "label": "stop",
                    "action": "stop",
                    "cursor": None,
                    "metadata": {},
                    "size": 6,
                },
            ]

            html_bytes = recorder.export_inline_html_bytes()
    finally:
        if previous_dir is None:
            os.environ.pop("BROWSER_AGENT_RECORDINGS_DIR", None)
        else:
            os.environ["BROWSER_AGENT_RECORDINGS_DIR"] = previous_dir

    assert html_bytes is not None
    html_text = html_bytes.decode("utf-8")
    assert html_text.count("data:image/jpeg;base64,") == 2
    assert html_text.count("Zmlyc3Q=") == 1
    assert html_text.count("c2Vjb25k") == 1

def test_browser_agent_recording_uses_live_steel_api_origin():
    from domains.spawn_browser_agent_v3.recording import steel_api_url

    previous_base_url = os.environ.pop("STEEL_BASE_URL", None)
    try:
        assert steel_api_url("/v1/sessions/session-1/hls") == (
            "https://api.steel.dev/v1/sessions/session-1/hls"
        )
    finally:
        if previous_base_url is not None:
            os.environ["STEEL_BASE_URL"] = previous_base_url

def test_simulated_browser_recording_player_script_is_valid_javascript():
    import re
    import subprocess

    from domains.spawn_browser_agent_v3.recording import SimulatedBrowserRecorder

    recorder = SimulatedBrowserRecorder(
        agent_id="agent-1",
        task_id="task-1",
        session_id="session-1",
        frames=[
            {
                "kind": "html",
                "html": "<!doctype html><title>Checkout</title><p>Order complete</p>",
                "width": 1440,
                "height": 900,
                "ts_ms": 0,
                "label": "Order complete",
                "action": "evaluate",
                "metadata": {},
            }
        ],
    )

    html_bytes = recorder.export_inline_html_bytes()
    assert html_bytes is not None
    html_text = html_bytes.decode("utf-8")
    scripts = re.findall(r"<script>(.*?)</script>", html_text, flags=re.DOTALL)
    assert len(scripts) == 1
    parsed = subprocess.run(
        ["node", "--check", "-"],
        input=scripts[0],
        text=True,
        capture_output=True,
        check=False,
    )
    assert parsed.returncode == 0, parsed.stderr
    assert "default-src 'none'" in html_text
    assert "style-src 'unsafe-inline'" in html_text

def test_browser_agent_recording_steel_video_player_uses_debug_recording_and_window_offsets():
    from domains.spawn_browser_agent_v3.recording import BrowserAgentRecorder

    recorder = BrowserAgentRecorder(
        page=object(),
        agent_id="agent-1",
        task_id="task-1",
        session_id="session-1",
        browser_url="https://api.steel.dev/v1/sessions/session-1/player",
        session_metadata={"provider": "steel"},
    )
    recorder.cursor_events = [
        {"ts_ms": 0, "x": 20, "y": 20},
        {"ts_ms": 1000, "x": 360, "y": 240},
    ]

    html_text = recorder._build_steel_video_html(
        {
            "kind": "steel_hls",
            "hls_src": "media/recording.m3u8",
            "mp4_src": "media/recording.mp4",
            "hls_js_src": "media/hls.min.js",
        }
    )

    assert "Source: Steel MP4/HLS debug recording" in html_text
    assert 'const mp4Src = "media/recording.mp4"' in html_text
    assert "const BROWSER_WINDOW_WIDTH = 1288" in html_text
    assert "const CONTENT_OFFSET_Y = 91" in html_text
    assert "cursorAtTime(video.currentTime * 1000)" in html_text
    assert "cursor.innerHTML" in html_text
    assert "scaleX = video.clientWidth / BROWSER_WINDOW_WIDTH" in html_text

def test_browser_humanizer_visual_cursor_defaults_off_but_keeps_cursor_observer():
    from browser_tools.humanizer import BrowserHumanizer

    class FakeMouse:
        async def move(self, *args, **kwargs):
            return None

    class FakeKeyboard:
        async def press(self, *args, **kwargs):
            return None

    page = SimpleNamespace(
        mouse=FakeMouse(),
        keyboard=FakeKeyboard(),
        viewport_size={"width": 1280, "height": 800},
    )
    observed = []

    previous = os.environ.pop("BROWSER_AGENT_VISUAL_CURSOR_ENABLED", None)
    try:
        humanizer = BrowserHumanizer(dom_page=None, input_page=page, fast=True)
        humanizer.set_cursor_observer(lambda x, y: observed.append((x, y)))
    finally:
        if previous is not None:
            os.environ["BROWSER_AGENT_VISUAL_CURSOR_ENABLED"] = previous

    assert humanizer._visual_cursor_enabled is False
    assert humanizer._cursor_observer is not None

def test_mouse_input_synthesis_generates_bounded_non_linear_path():
    import random

    from browser_tools.input_synthesis import synthesize_mouse_path

    path = synthesize_mouse_path(
        (20, 30),
        (620, 410),
        screen=(800, 600),
        frequency_hz=90,
        duration_s=0.45,
        stop_count=1,
        rng=random.Random(7),
    )

    assert (path[0].x, path[0].y) == (20, 30)
    assert len(path) > 20
    assert (path[-1].x, path[-1].y) == (620, 410)
    assert all(0 <= sample.x < 800 and 0 <= sample.y < 600 for sample in path)
    assert all(sample.delay_s > 0 for sample in path)

    start = (20, 30)
    end = (620, 410)
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    line_len = (dx * dx + dy * dy) ** 0.5
    max_line_error = max(
        abs(dy * sample.x - dx * sample.y + end[0] * start[1] - end[1] * start[0]) / line_len for sample in path[2:-2]
    )
    assert max_line_error > 3
    assert max_line_error < line_len * 0.14

    projections = [((sample.x - start[0]) * dx + (sample.y - start[1]) * dy) / (line_len * line_len) for sample in path]
    assert min(projections) >= -0.08
    assert max(projections) <= 1.08

def test_mouse_input_synthesis_rejects_unrealistic_sample_jumps():
    import math
    import random

    from browser_tools.input_synthesis import (
        MIMIC_MAX_VELOCITY_PX_PER_S,
        synthesize_mouse_path,
    )

    start = (20, 20)
    end = (610, 332)
    distance = math.hypot(end[0] - start[0], end[1] - start[1])
    duration_s = max(0.08, min(0.72, 0.05 + distance / 1600))

    for seed in range(1, 31):
        path = synthesize_mouse_path(
            start,
            end,
            screen=(1280, 800),
            frequency_hz=75,
            duration_s=duration_s,
            snr=65,
            rng=random.Random(seed),
        )
        steps = [
            math.hypot(current.x - previous.x, current.y - previous.y) for previous, current in zip(path, path[1:])
        ]
        velocities = [
            math.hypot(current.x - previous.x, current.y - previous.y) / max(1e-6, current.delay_s)
            for previous, current in zip(path, path[1:])
        ]
        assert max(steps) <= 62
        assert max(velocities) <= MIMIC_MAX_VELOCITY_PX_PER_S + 60

def test_idle_mouse_drift_stays_near_anchor_and_inside_viewport():
    import random

    from browser_tools.input_synthesis import (
        IDLE_MOUSE_RADIUS_PX,
        synthesize_idle_mouse_drift,
    )

    anchor = (400, 250)
    current = anchor
    samples = []
    for seed in range(40):
        sample = synthesize_idle_mouse_drift(
            current,
            anchor=anchor,
            screen=(800, 600),
            rng=random.Random(seed),
        )
        samples.append(sample)
        current = (sample.x, sample.y)

    assert all(0 <= sample.x < 800 and 0 <= sample.y < 600 for sample in samples)
    assert all(
        ((sample.x - anchor[0]) ** 2 + (sample.y - anchor[1]) ** 2) ** 0.5 <= IDLE_MOUSE_RADIUS_PX + 1
        for sample in samples
    )
    assert len({(sample.x, sample.y) for sample in samples}) > 3

def test_keycap_input_synthesis_generates_variable_key_timings():
    import random

    from browser_tools.input_synthesis import KeycapTimingSynthesizer

    synth = KeycapTimingSynthesizer(rng=random.Random(11), basis_count=48)
    timings = [synth.next(char) for char in "hello world."]
    intervals = [round(timing.interval_s, 4) for timing in timings]

    assert len(set(intervals)) > 5
    assert all(timing.interval_s > 0 for timing in timings)
    assert all(0.03 <= timing.dwell_s <= 0.15 for timing in timings)

def test_keycap_input_synthesis_rng_isolated_from_global_numpy_state():
    import random

    import numpy as np

    from browser_tools.input_synthesis import KeycapTimingSynthesizer

    numpy_state = np.random.get_state()
    try:
        sequences = []
        for numpy_seed in (17, 229):
            np.random.seed(numpy_seed)
            synth = KeycapTimingSynthesizer(rng=random.Random(11), basis_count=48)
            sequences.append([synth.next(char) for char in "hello world."])
    finally:
        np.random.set_state(numpy_state)

    assert sequences[0] == sequences[1]
    for timings in sequences:
        intervals = [round(timing.interval_s, 4) for timing in timings]
        assert len(set(intervals)) > 5

def test_keycap_controller_generate_n_uses_injected_rng():
    import random

    import numpy as np

    from keycap import Controller

    random_state = random.getstate()
    try:
        generated = []
        for global_seed in (17, 229):
            random.seed(global_seed)
            controller = Controller(
                n=None,
                D=[],
                alpha=[],
                w=[],
                rng=np.random.default_rng(11),
            )
            generated.append(controller.n)
    finally:
        random.setstate(random_state)

    assert generated[0] == generated[1]
    assert 500 <= generated[0] <= 5000

def test_mouse_click_synthesis_uses_paper_duration_distribution():
    import random

    from browser_tools.input_synthesis import synthesize_click_delay_ms

    samples = [synthesize_click_delay_ms(random.Random(seed)) for seed in range(60)]

    assert all(55 <= sample <= 135 for sample in samples)
    assert 75 <= sum(samples) / len(samples) <= 95
    assert len(set(samples)) > 12

def test_idle_mouse_drift_generates_visible_tremor_samples():
    import random

    from browser_tools.input_synthesis import synthesize_idle_mouse_drift

    current = (400, 250)
    samples = [
        synthesize_idle_mouse_drift(
            current,
            anchor=current,
            screen=(1280, 800),
            radius_px=7,
            rng=random.Random(seed),
        )
        for seed in range(80)
    ]

    assert all((sample.x, sample.y) != current for sample in samples)
    assert all(((sample.x - current[0]) ** 2 + (sample.y - current[1]) ** 2) ** 0.5 <= 7.5 for sample in samples)
    assert all(0.015 <= sample.delay_s <= 0.04 for sample in samples)

def test_agent_anti_detection_normalizes_fcaptcha_behavioral_payload():
    from browser_tools.dom_service import DOMService

    script = DOMService._ANTI_DETECTION_SCRIPT

    assert "/api/score" in script
    assert "/api/verify" in script
    assert "typeof body.signalsJson === 'string'" in script
    assert "body.signalsJson = JSON.stringify(serializedSignals)" in script
    assert "body.indexOf('\"signalsJson\"')" in script
    assert "body.indexOf('\"powTiming\"')" in script
    assert "overshootCorrections = 1" in script
    assert "mouseEventRate = 18 + Math.random() * 6" in script
    assert "body.powTiming.duration = expectedMax * (1.4 + Math.random() * 0.7)" in script
    assert "signals.temporal.pageLoadToFirstInteraction = 350 + Math.random() * 450" in script
    assert "signals.formAnalysis.pageLoadToFirstInteraction = 350 + Math.random() * 450" in script
    assert "b.velocityVariance = 0.08 + Math.random() * 0.12" in script
    assert "env.canvasHash = env.canvasHash.hash" in script
    assert "JSON.stringify = function" in script
    assert "XMLHttpRequest.prototype.send" in script
    assert "Navigator.prototype, 'sendBeacon'" in script
    assert "window.fetch = wrappedFetch" in script

async def test_browser_humanizer_click_uses_synthesized_mouse_and_cursor_updates():
    from browser_tools.humanizer import BrowserHumanizer

    class FakeMouse:
        def __init__(self):
            self.moves = []
            self.downs = []
            self.ups = []
            self._pos = (0, 0)

        async def move(self, x, y):
            self._pos = (x, y)
            self.moves.append((x, y))

        async def down(self, **kwargs):
            self.downs.append(self._pos)

        async def up(self, **kwargs):
            self.ups.append(self._pos)

    class FakeKeyboard:
        async def press(self, *args, **kwargs):
            return None

    fake_mouse = FakeMouse()
    page = SimpleNamespace(
        mouse=fake_mouse,
        keyboard=FakeKeyboard(),
        viewport_size={"width": 1280, "height": 800},
    )
    observed = []

    with (
        patch.dict(
            os.environ,
            {
                "BROWSER_AGENT_HUMAN_INPUT_ENABLED": "1",
                "BROWSER_AGENT_HUMAN_MOUSE_SYNTHESIS": "1",
                "BROWSER_AGENT_HUMAN_KEYBOARD_SYNTHESIS": "1",
            },
            clear=False,
        ),
        patch("browser_tools.humanizer.asyncio.sleep", AsyncMock()),
    ):
        humanizer = BrowserHumanizer(dom_page=None, input_page=page, fast=True)
        humanizer.set_cursor_observer(lambda x, y: observed.append((x, y)))
        await humanizer.initialize_cursor((100, 100))
        await humanizer.click_at_coords(360, 240, pre_hover=False, overshoot=False)

    # Click is a decoupled press/release with sub-pixel motor noise (defeats
    # "unnaturally accurate click precision"), not a single pixel-perfect click().
    assert fake_mouse.downs and fake_mouse.ups, "expected a synthesized press and release"
    assert abs(fake_mouse.downs[-1][0] - 360) <= 5 and abs(fake_mouse.downs[-1][1] - 240) <= 5
    assert len(fake_mouse.moves) > 8
    assert observed[-1] == (360, 240)
    assert set(fake_mouse.moves[1:-1]) != {(360, 240)}

async def test_click_press_holds_no_remote_round_trip_between_down_and_up():
    """RCA (browser-biometrics-webdecoy, FCaptcha 0.183 > ratchet 0.163).

    Every mouse call is a round trip to a REMOTE browser. The release-drift move
    used to sit BETWEEN mousedown and mouseup, so that latency landed inside the
    press: we sampled an ~85ms human dwell but the page observed 621.5ms. A
    submit whose mousedown is older than FCaptcha's 500ms RECENT_GESTURE_MS is
    scored as `programmatic_click` (bot 0.8x0.85 -> +0.0884), which was the
    entire gap over the ratchet.

    Assert the ORDER: no move may be dispatched while the button is held. This
    is latency-independent, so it holds no matter how slow the transport is.
    """
    from browser_tools.humanizer import BrowserHumanizer

    events = []

    class OrderTrackingMouse:
        def __init__(self):
            self._pos = (0, 0)

        async def move(self, x, y):
            self._pos = (x, y)
            events.append("move")

        async def down(self, **kwargs):
            events.append("down")

        async def up(self, **kwargs):
            events.append("up")

    class FakeKeyboard:
        async def press(self, *args, **kwargs):
            return None

    page = SimpleNamespace(
        mouse=OrderTrackingMouse(),
        keyboard=FakeKeyboard(),
        viewport_size={"width": 1280, "height": 800},
    )

    with (
        patch.dict(
            os.environ,
            {
                "BROWSER_AGENT_HUMAN_INPUT_ENABLED": "1",
                "BROWSER_AGENT_HUMAN_MOUSE_SYNTHESIS": "1",
            },
            clear=False,
        ),
        patch("browser_tools.humanizer.asyncio.sleep", AsyncMock()),
    ):
        humanizer = BrowserHumanizer(dom_page=None, input_page=page, fast=True)
        await humanizer.initialize_cursor((100, 100))
        await humanizer.click_at_coords(360, 240, pre_hover=False, overshoot=False)

    assert "down" in events and "up" in events, events
    held = events[events.index("down") + 1 : events.index("up")]
    assert held == [], f"no remote call may sit inside the press; found {held}"
    # This page exposes no CDP session, so this is the Playwright FALLBACK path.
    # It releases in place: keeping the press inside the sampled dwell matters
    # more than the sub-pixel offset, because an over-long press is scored as a
    # programmatic click. Nothing may follow the release either — a post-click
    # move races navigation the click itself triggers and can raise "Target
    # closed", turning a successful click into a failure.
    assert events[events.index("up") + 1 :] == [], (
        f"nothing may follow the release; found {events[events.index('up') + 1 :]}"
    )
    # The drifted release (motor noise without a longer press) is the CDP path's
    # job and is asserted by test_humanized_click_presses_and_releases_via_cdp_*.

async def test_browser_humanizer_cursor_observer_runs_after_visual_cursor_update():
    from browser_tools.humanizer import BrowserHumanizer

    class FakeMouse:
        async def move(self, *args, **kwargs):
            return None

        async def click(self, *args, **kwargs):
            return None

        async def down(self, *args, **kwargs):
            return None

        async def up(self, *args, **kwargs):
            return None

    class FakeKeyboard:
        async def press(self, *args, **kwargs):
            return None

    class FakePage:
        def __init__(self):
            self.mouse = FakeMouse()
            self.keyboard = FakeKeyboard()
            self.viewport_size = {"width": 1280, "height": 800}
            self.visual_cursor = None

        async def evaluate(self, _script, payload):
            self.visual_cursor = (payload["x"], payload["y"])

    page = FakePage()
    observed = []

    def observe(x, y):
        observed.append({"observer": (x, y), "visual": page.visual_cursor})

    with (
        patch.dict(
            os.environ,
            {
                "BROWSER_AGENT_HUMAN_INPUT_ENABLED": "1",
                "BROWSER_AGENT_HUMAN_MOUSE_SYNTHESIS": "1",
                "BROWSER_AGENT_VISUAL_CURSOR_ENABLED": "1",
            },
            clear=False,
        ),
        patch("browser_tools.humanizer.asyncio.sleep", AsyncMock()),
    ):
        humanizer = BrowserHumanizer(dom_page=None, input_page=page, fast=True)
        humanizer.set_cursor_observer(observe)
        await humanizer.initialize_cursor((20, 20))
        await humanizer.click_at_coords(360, 240, pre_hover=False, overshoot=False)

    assert observed, "expected cursor observer events"
    assert all(event["observer"] == event["visual"] for event in observed)
    assert observed[0]["observer"] == (20, 20)
    assert observed[-1]["observer"] == (360, 240)

async def test_browser_humanizer_cdp_mouse_transport_queues_full_path_before_drain():
    from browser_tools.humanizer import BrowserHumanizer

    real_sleep = asyncio.sleep

    class FakeCDPSession:
        def __init__(self):
            self.calls = []
            self.release = asyncio.Event()

        async def send(self, method, payload):
            self.calls.append((method, payload))
            await self.release.wait()

    class FakeContext:
        def __init__(self, cdp):
            self.cdp = cdp
            self.pages = []

        async def new_cdp_session(self, page):
            return self.cdp

    class FakeMouse:
        def __init__(self):
            self.moves = []
            self.downs = []
            self.ups = []
            self._pos = (0, 0)

        async def move(self, x, y):
            self._pos = (x, y)
            self.moves.append((x, y))

        async def down(self, **kwargs):
            self.downs.append(self._pos)

        async def up(self, **kwargs):
            self.ups.append(self._pos)

    class FakeKeyboard:
        async def press(self, *args, **kwargs):
            return None

    class FakePage:
        def __init__(self, cdp):
            self.mouse = FakeMouse()
            self.keyboard = FakeKeyboard()
            self.viewport_size = {"width": 1280, "height": 800}
            self.context = FakeContext(cdp)
            self.visual_batches = []

        async def evaluate(self, _script, payload):
            if "points" in payload:
                self.visual_batches.append(payload["points"])

    cdp = FakeCDPSession()
    page = FakePage(cdp)
    observed = []

    with (
        patch.dict(
            os.environ,
            {
                "BROWSER_AGENT_HUMAN_INPUT_ENABLED": "1",
                "BROWSER_AGENT_HUMAN_MOUSE_SYNTHESIS": "1",
                "BROWSER_AGENT_CDP_MOUSE_TRANSPORT": "1",
                "BROWSER_AGENT_VISUAL_CURSOR_ENABLED": "1",
            },
            clear=False,
        ),
        patch("browser_tools.humanizer.asyncio.sleep", AsyncMock()),
        patch("browser_tools.humanizer.random.random", return_value=1.0),
    ):
        humanizer = BrowserHumanizer(dom_page=None, input_page=page, fast=True)
        humanizer.set_cursor_observer(lambda x, y: observed.append((x, y)))
        await humanizer.initialize_cursor((100, 100))
        task = asyncio.create_task(humanizer.click_at_coords(360, 240, pre_hover=False, overshoot=False))
        try:
            for _ in range(20):
                await real_sleep(0)
                if len(cdp.calls) > 20:
                    break

            assert len(cdp.calls) > 20
            assert not task.done()
            assert len(page.mouse.moves) == 1
            assert page.visual_batches
            assert len(page.visual_batches[-1]) == len(cdp.calls)
        finally:
            cdp.release.set()

        await asyncio.wait_for(task, timeout=1)

    # When CDP is available the press AND release ride it, so the release can
    # carry motor noise without a Playwright move between down and up inflating
    # the hold the page observes (the programmatic_click RCA). Playwright's
    # mouse must stay untouched on this path.
    assert not page.mouse.downs and not page.mouse.ups, "press/release must use CDP when available"
    assert cdp.calls[0][0] == "Input.dispatchMouseEvent"
    presses = [payload for method, payload in cdp.calls if payload.get("type") == "mousePressed"]
    releases = [payload for method, payload in cdp.calls if payload.get("type") == "mouseReleased"]
    assert len(presses) == 1 and len(releases) == 1, (len(presses), len(releases))
    press_index = next(i for i, (_, p) in enumerate(cdp.calls) if p.get("type") == "mousePressed")
    release_index = next(i for i, (_, p) in enumerate(cdp.calls) if p.get("type") == "mouseReleased")
    assert press_index < release_index, "release must follow the press"
    # No further input may be dispatched after the release: a post-click move
    # races navigation the click itself triggers.
    assert release_index == len(cdp.calls) - 1, "release must be the final dispatched input"
    # Press lands on target; release drifts within motor-noise range of it.
    assert abs(presses[0]["x"] - 360) <= 5 and abs(presses[0]["y"] - 240) <= 5
    assert abs(releases[0]["x"] - presses[0]["x"]) <= 3 and abs(releases[0]["y"] - presses[0]["y"]) <= 3
    assert observed[-1] == (360, 240)

async def test_browser_humanizer_cdp_mouse_drain_timeout_uses_fallback():
    """A stalled CDP mouse drain is bounded and falls back to Playwright input."""
    from browser_tools.humanizer import BrowserHumanizer

    class StalledCDPSession:
        async def send(self, method, payload):
            await asyncio.Event().wait()

    class FakeContext:
        async def new_cdp_session(self, page):
            return StalledCDPSession()

    class FakeMouse:
        def __init__(self):
            self.moves = []

        async def move(self, x, y):
            self.moves.append((x, y))

    mouse = FakeMouse()
    page = SimpleNamespace(
        mouse=mouse,
        keyboard=SimpleNamespace(),
        viewport_size={"width": 1280, "height": 800},
        context=FakeContext(),
    )
    humanizer = BrowserHumanizer(dom_page=None, input_page=page, fast=True)
    sample = SimpleNamespace(x=25, y=40, delay_s=0)

    with patch("browser_tools.humanizer.CDP_INPUT_DRAIN_TIMEOUT_SECONDS", 0.01, create=True):
        used_cdp = await asyncio.wait_for(
            humanizer._move_path_with_cdp_fire_and_drain([sample]),
            timeout=5,
        )

    assert used_cdp is False
    assert humanizer._cdp_session is None
    assert not humanizer._cdp_mouse_transport_enabled

async def test_browser_humanizer_idle_movement_forwards_to_cdp_and_observer():
    from browser_tools.humanizer import BrowserHumanizer

    class FakeCDPSession:
        def __init__(self):
            self.calls = []

        async def send(self, method, payload):
            self.calls.append((method, payload))

    class FakeContext:
        def __init__(self, cdp):
            self.cdp = cdp
            self.pages = []

        async def new_cdp_session(self, page):
            return self.cdp

    class FakeMouse:
        def __init__(self):
            self.moves = []

        async def move(self, x, y):
            self.moves.append((x, y))

    class FakeKeyboard:
        async def press(self, *args, **kwargs):
            return None

    cdp = FakeCDPSession()
    page = SimpleNamespace(
        mouse=FakeMouse(),
        keyboard=FakeKeyboard(),
        viewport_size={"width": 1280, "height": 800},
        context=FakeContext(cdp),
    )
    observed = []

    with patch.dict(
        os.environ,
        {
            "BROWSER_AGENT_HUMAN_INPUT_ENABLED": "1",
            "BROWSER_AGENT_CDP_MOUSE_TRANSPORT": "1",
            "BROWSER_AGENT_IDLE_MOUSE_ENABLED": "1",
            "BROWSER_AGENT_IDLE_MOUSE_RADIUS_PX": "4",
            "BROWSER_AGENT_VISUAL_CURSOR_ENABLED": "0",
        },
        clear=False,
    ):
        humanizer = BrowserHumanizer(dom_page=None, input_page=page, fast=True)
        humanizer.set_cursor_observer(lambda x, y: observed.append((x, y)))
        await humanizer.initialize_cursor((400, 250))
        delay_s = await humanizer._idle_mouse_step()
        await humanizer.close()

    assert delay_s is not None and delay_s > 0
    assert cdp.calls[-1][0] == "Input.dispatchMouseEvent"
    payload = cdp.calls[-1][1]
    assert payload["type"] == "mouseMoved"
    assert ((payload["x"] - 400) ** 2 + (payload["y"] - 250) ** 2) ** 0.5 <= 5
    assert observed[-1] == (payload["x"], payload["y"])

async def test_browser_humanizer_keyboard_uses_keycap_timing_for_text_and_shortcuts():
    from browser_tools.humanizer import BrowserHumanizer

    class FakeMouse:
        async def move(self, *args, **kwargs):
            return None

    class FakeKeyboard:
        def __init__(self):
            self.events = []

        async def press(self, key, **kwargs):
            self.events.append(("press", key, kwargs.get("delay")))

        async def down(self, key):
            self.events.append(("down", key, None))

        async def up(self, key):
            self.events.append(("up", key, None))

    keyboard = FakeKeyboard()
    page = SimpleNamespace(
        mouse=FakeMouse(),
        keyboard=keyboard,
        viewport_size={"width": 1280, "height": 800},
    )

    with (
        patch.dict(
            os.environ,
            {
                "BROWSER_AGENT_HUMAN_INPUT_ENABLED": "1",
                "BROWSER_AGENT_HUMAN_MOUSE_SYNTHESIS": "1",
                "BROWSER_AGENT_HUMAN_KEYBOARD_SYNTHESIS": "1",
            },
            clear=False,
        ),
        patch("browser_tools.humanizer.asyncio.sleep", AsyncMock()),
    ):
        humanizer = BrowserHumanizer(dom_page=None, input_page=page, fast=True)
        await humanizer.type_text("a b")
        await humanizer.press_key("Control+a")

    assert [event[0:2] for event in keyboard.events[:6]] == [
        ("down", "a"),
        ("up", "a"),
        ("down", "Space"),
        ("up", "Space"),
        ("down", "b"),
        ("up", "b"),
    ]
    assert not any(event[0] == "press" for event in keyboard.events[:6])
    assert [event[0:2] for event in keyboard.events[-3:]] == [
        ("down", "Control"),
        ("press", "a"),
        ("up", "Control"),
    ]
    assert isinstance(keyboard.events[-2][2], int) and keyboard.events[-2][2] > 0

async def test_browser_humanizer_cdp_keyboard_transport_queues_text_before_drain():
    from browser_tools.humanizer import BrowserHumanizer

    real_sleep = asyncio.sleep

    class FakeCDPSession:
        def __init__(self):
            self.calls = []
            self.release = asyncio.Event()

        async def send(self, method, payload):
            self.calls.append((method, payload))
            await self.release.wait()

    class FakeContext:
        def __init__(self, cdp):
            self.cdp = cdp

        async def new_cdp_session(self, page):
            return self.cdp

    class FakeMouse:
        async def move(self, *args, **kwargs):
            return None

    class FakeKeyboard:
        def __init__(self):
            self.events = []

        async def down(self, key):
            self.events.append(("down", key))

        async def up(self, key):
            self.events.append(("up", key))

    class FakeKeycap:
        @staticmethod
        def next(char):
            return SimpleNamespace(dwell_s=0, interval_s=0)

    cdp = FakeCDPSession()
    keyboard = FakeKeyboard()
    page = SimpleNamespace(
        mouse=FakeMouse(),
        keyboard=keyboard,
        viewport_size={"width": 1280, "height": 800},
        context=FakeContext(cdp),
    )

    with patch.dict(
        os.environ,
        {
            "BROWSER_AGENT_HUMAN_INPUT_ENABLED": "1",
            "BROWSER_AGENT_HUMAN_KEYBOARD_SYNTHESIS": "1",
            "BROWSER_AGENT_CDP_KEYBOARD_TRANSPORT": "1",
            "BROWSER_AGENT_CDP_MOUSE_TRANSPORT": "1",
        },
        clear=False,
    ):
        humanizer = BrowserHumanizer(dom_page=None, input_page=page, fast=True)
        humanizer._keycap = FakeKeycap()
        task = asyncio.create_task(humanizer.type_text("Ab"))
        try:
            for _ in range(20):
                await real_sleep(0)
                if len(cdp.calls) == 6:
                    break

            assert len(cdp.calls) == 6
            assert not task.done()
            assert keyboard.events == []
        finally:
            cdp.release.set()

        await asyncio.wait_for(task, timeout=1)

    assert [method for method, _ in cdp.calls] == ["Input.dispatchKeyEvent"] * 6
    assert cdp.calls[1][1]["type"] == "char"
    assert cdp.calls[1][1]["text"] == "A"
    assert cdp.calls[4][1]["text"] == "b"

async def test_browser_humanizer_cdp_keyboard_drain_timeout_is_bounded():
    """A stalled CDP key dispatch cannot consume minutes of the browser task budget."""
    from browser_tools.humanizer import BrowserHumanizer

    class StalledCDPSession:
        async def send(self, method, payload):
            await asyncio.Event().wait()

    class FakeContext:
        async def new_cdp_session(self, page):
            return StalledCDPSession()

    class FakeKeycap:
        @staticmethod
        def next(char):
            return SimpleNamespace(dwell_s=0, interval_s=0)

    page = SimpleNamespace(
        mouse=SimpleNamespace(),
        keyboard=SimpleNamespace(),
        viewport_size={"width": 1280, "height": 800},
        context=FakeContext(),
    )
    humanizer = BrowserHumanizer(dom_page=None, input_page=page, fast=True)
    humanizer._keycap = FakeKeycap()

    with patch("browser_tools.humanizer.CDP_INPUT_DRAIN_TIMEOUT_SECONDS", 0.01, create=True):
        try:
            await asyncio.wait_for(humanizer.type_text("A"), timeout=0.5)
            raise AssertionError("Expected stalled CDP keyboard dispatch to time out")
        except asyncio.TimeoutError as exc:
            assert "CDP keyboard input drain timed out" in str(exc)

    assert humanizer._cdp_session is None
    assert not humanizer._cdp_keyboard_transport_enabled

async def test_browser_humanizer_cdp_session_initialization_is_serialized():
    from browser_tools.humanizer import BrowserHumanizer

    session = SimpleNamespace(send=AsyncMock())

    class FakeContext:
        def __init__(self):
            self.calls = 0
            self.release = asyncio.Event()

        async def new_cdp_session(self, page):
            self.calls += 1
            await self.release.wait()
            return session

    context = FakeContext()
    page = SimpleNamespace(
        mouse=SimpleNamespace(),
        keyboard=SimpleNamespace(),
        viewport_size={"width": 1280, "height": 800},
        context=context,
    )
    humanizer = BrowserHumanizer(dom_page=None, input_page=page, fast=True)

    first = asyncio.create_task(humanizer._get_cdp_session())
    second = asyncio.create_task(humanizer._get_cdp_session())
    await asyncio.sleep(0)
    assert context.calls == 1

    context.release.set()
    first_session, second_session = await asyncio.gather(first, second)

    assert first_session is session
    assert second_session is session
    assert context.calls == 1

async def test_browser_humanizer_cdp_send_failure_enables_keyboard_fallback():
    from browser_tools.humanizer import BrowserHumanizer

    class FailingCDPSession:
        async def send(self, method, payload):
            raise RuntimeError("CDP transport closed")

    class FakeContext:
        def __init__(self):
            self.calls = 0

        async def new_cdp_session(self, page):
            self.calls += 1
            return FailingCDPSession()

    class FakeKeyboard:
        def __init__(self):
            self.events = []

        async def down(self, key):
            self.events.append(("down", key))

        async def up(self, key):
            self.events.append(("up", key))

    class FakeKeycap:
        @staticmethod
        def next(char):
            return SimpleNamespace(dwell_s=0, interval_s=0)

    context = FakeContext()
    keyboard = FakeKeyboard()
    page = SimpleNamespace(
        mouse=SimpleNamespace(),
        keyboard=keyboard,
        viewport_size={"width": 1280, "height": 800},
        context=context,
    )
    humanizer = BrowserHumanizer(dom_page=None, input_page=page, fast=True)
    humanizer._keycap = FakeKeycap()

    try:
        await humanizer.type_text("A")
        raise AssertionError("Expected the failed CDP send to propagate")
    except RuntimeError as exc:
        assert str(exc) == "CDP transport closed"

    assert humanizer._cdp_session is None
    assert not humanizer._cdp_mouse_transport_enabled
    assert not humanizer._cdp_keyboard_transport_enabled

    await humanizer.type_text("B")

    assert context.calls == 1
    assert keyboard.events == [("down", "B"), ("up", "B")]

async def test_browser_humanizer_cdp_mouse_path_failure_enables_fallback():
    from browser_tools.humanizer import BrowserHumanizer

    class FailingCDPSession:
        async def send(self, method, payload):
            raise RuntimeError("CDP mouse transport closed")

    class FakeContext:
        async def new_cdp_session(self, page):
            return FailingCDPSession()

    class FakeMouse:
        def __init__(self):
            self.moves = []

        async def move(self, x, y):
            self.moves.append((x, y))

    mouse = FakeMouse()
    page = SimpleNamespace(
        mouse=mouse,
        keyboard=SimpleNamespace(),
        viewport_size={"width": 1280, "height": 800},
        context=FakeContext(),
    )
    humanizer = BrowserHumanizer(dom_page=None, input_page=page, fast=True)
    sample = SimpleNamespace(x=25, y=40, delay_s=0)

    used_cdp = await humanizer._move_path_with_cdp_fire_and_drain([sample])

    assert not used_cdp
    assert humanizer._cdp_session is None
    assert not humanizer._cdp_mouse_transport_enabled
    assert not humanizer._cdp_keyboard_transport_enabled

    await humanizer._move_to_unlocked(25, 40)

    assert mouse.moves
    assert mouse.moves[-1] == (25, 40)

async def test_browser_humanizer_cdp_idle_mouse_failure_enables_fallback():
    from browser_tools.humanizer import BrowserHumanizer

    class FailingCDPSession:
        async def send(self, method, payload):
            raise RuntimeError("CDP idle transport closed")

    class FakeContext:
        async def new_cdp_session(self, page):
            return FailingCDPSession()

    class FakeMouse:
        def __init__(self):
            self.moves = []

        async def move(self, x, y):
            self.moves.append((x, y))

    mouse = FakeMouse()
    page = SimpleNamespace(
        mouse=mouse,
        keyboard=SimpleNamespace(),
        viewport_size={"width": 1280, "height": 800},
        context=FakeContext(),
    )
    humanizer = BrowserHumanizer(dom_page=None, input_page=page, fast=True)

    await humanizer._dispatch_mouse_position(15, 30)

    assert mouse.moves == [(15, 30)]
    assert humanizer._cdp_session is None
    assert not humanizer._cdp_mouse_transport_enabled
    assert not humanizer._cdp_keyboard_transport_enabled

async def test_browser_network_recording_captures_response_body():
    import tempfile

    from domains.spawn_browser_agent_v3.recording import BrowserNetworkRecorder

    class FakeNetworkRegister:
        def __init__(self):
            self.request_handler = None
            self.response_handler = None
            self.finished_handler = None
            self.failed_handler = None

        def requestWillBeSent(self, handler):
            self.request_handler = handler

        def responseReceived(self, handler):
            self.response_handler = handler

        def loadingFinished(self, handler):
            self.finished_handler = handler

        def loadingFailed(self, handler):
            self.failed_handler = handler

    class FakeNetworkSend:
        def __init__(self):
            self.enabled_session_id = None
            self.body_started = asyncio.Event()
            self.release_body = asyncio.Event()

        async def enable(self, session_id=None):
            self.enabled_session_id = session_id

        async def getResponseBody(self, params, session_id=None):
            assert params == {"requestId": "123.4"}
            assert session_id == "cdp-1"
            self.body_started.set()
            await self.release_body.wait()
            return {
                "base64Encoded": False,
                "body": json.dumps({"errors": [{"message": "unexpected error"}]}),
            }

    previous_enabled = os.environ.get("BROWSER_AGENT_RECORDINGS")
    previous_network_enabled = os.environ.get("BROWSER_AGENT_NETWORK_RECORDING")
    previous_dir = os.environ.get("BROWSER_AGENT_RECORDINGS_DIR")
    previous_patterns = os.environ.get("BROWSER_AGENT_NETWORK_CAPTURE_URL_PATTERNS")
    try:
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["BROWSER_AGENT_RECORDINGS"] = "1"
            os.environ["BROWSER_AGENT_NETWORK_RECORDING"] = "1"
            os.environ["BROWSER_AGENT_RECORDINGS_DIR"] = tmp
            os.environ["BROWSER_AGENT_NETWORK_CAPTURE_URL_PATTERNS"] = "api.x.com/1.1/graphql/user_flow.json"

            network_register = FakeNetworkRegister()
            network_send = FakeNetworkSend()
            cdp_client = SimpleNamespace(
                register=SimpleNamespace(Network=network_register),
                send=SimpleNamespace(Network=network_send),
            )
            browser_session = SimpleNamespace(
                cdp_client=cdp_client,
                get_or_create_cdp_session=AsyncMock(return_value=SimpleNamespace(session_id="cdp-1")),
            )

            recorder = await BrowserNetworkRecorder.create(
                browser_session=browser_session,
                agent_id="agent-1",
                task_id="task-1",
                session_id="steel-1",
                output_dir=Path(tmp) / "agent-1" / "task-1",
            )
            assert recorder is not None
            assert network_send.enabled_session_id == "cdp-1"
            assert network_register.request_handler is not None
            assert network_register.response_handler is not None
            assert network_register.finished_handler is not None

            url = "https://api.x.com/1.1/graphql/user_flow.json"
            network_register.request_handler(
                {
                    "requestId": "123.4",
                    "type": "Fetch",
                    "request": {"method": "POST", "url": url},
                },
                "cdp-1",
            )
            network_register.response_handler(
                {
                    "requestId": "123.4",
                    "type": "Fetch",
                    "response": {
                        "url": url,
                        "status": 200,
                        "mimeType": "application/json",
                    },
                },
                "cdp-1",
            )
            network_register.finished_handler({"requestId": "123.4", "encodedDataLength": 48}, "cdp-1")
            await network_send.body_started.wait()

            class SecondFakeNetworkSend(FakeNetworkSend):
                def __init__(self):
                    super().__init__()
                    self.release_body.set()

                async def getResponseBody(self, params, session_id=None):
                    assert params == {"requestId": "123.4"}
                    assert session_id == "cdp-2"
                    return {"base64Encoded": False, "body": '{"phase":"promoted"}'}

            second_register = FakeNetworkRegister()
            second_send = SecondFakeNetworkSend()
            second_client = SimpleNamespace(
                register=SimpleNamespace(Network=second_register),
                send=SimpleNamespace(Network=second_send),
            )
            second_session = SimpleNamespace(
                cdp_client=second_client,
                get_or_create_cdp_session=AsyncMock(return_value=SimpleNamespace(session_id="cdp-2")),
            )
            await recorder.transition_browser(
                browser_session=second_session,
                session_id="kernel-2",
            )
            assert recorder.session_id == "kernel-2"
            assert second_send.enabled_session_id == "cdp-2"

            promoted_url = "https://api.x.com/1.1/graphql/user_flow.json?phase=promoted"
            second_register.request_handler(
                {
                    "requestId": "123.4",
                    "type": "Fetch",
                    "request": {"method": "GET", "url": promoted_url},
                },
                "cdp-2",
            )
            second_register.response_handler(
                {
                    "requestId": "123.4",
                    "type": "Fetch",
                    "response": {
                        "url": promoted_url,
                        "status": 200,
                        "mimeType": "application/json",
                    },
                },
                "cdp-2",
            )
            second_register.finished_handler(
                {"requestId": "123.4", "encodedDataLength": 20},
                "cdp-2",
            )
            # Complete the outgoing browser's body only after the winner has
            # reused the exact same CDP requestId. Both entries must survive and
            # each body fetch must stay bound to its originating CDP client.
            network_send.release_body.set()

            index_path = await recorder.close()
            assert index_path is not None
            index = json.loads(index_path.read_text())
            assert index["session_id"] == "kernel-2"
            assert index["entry_count"] == 2
            same_id_entries = [item for item in index["entries"] if item["request_id"] == "123.4"]
            assert len(same_id_entries) == 2
            # Durable index URLs are query-redacted; distinguish the reused
            # CDP requestId across browser generations by generation, not URL.
            entry = next(item for item in same_id_entries if item["browser_generation"] == 1)
            assert entry["url"] == url
            assert entry["status"] == 200
            assert entry["body_file"].endswith(".json")
            body = json.loads((index_path.parent / entry["body_file"]).read_text())
            assert body["errors"][0]["message"] == "unexpected error"
            promoted = next(
                item for item in same_id_entries if item["browser_generation"] == 2
            )
            assert promoted["url"] == promoted_url.split("?", 1)[0]
            promoted_body = json.loads(
                (index_path.parent / promoted["body_file"]).read_text()
            )
            assert promoted_body == {"phase": "promoted"}
    finally:
        if previous_enabled is None:
            os.environ.pop("BROWSER_AGENT_RECORDINGS", None)
        else:
            os.environ["BROWSER_AGENT_RECORDINGS"] = previous_enabled
        if previous_network_enabled is None:
            os.environ.pop("BROWSER_AGENT_NETWORK_RECORDING", None)
        else:
            os.environ["BROWSER_AGENT_NETWORK_RECORDING"] = previous_network_enabled
        if previous_dir is None:
            os.environ.pop("BROWSER_AGENT_RECORDINGS_DIR", None)
        else:
            os.environ["BROWSER_AGENT_RECORDINGS_DIR"] = previous_dir
        if previous_patterns is None:
            os.environ.pop("BROWSER_AGENT_NETWORK_CAPTURE_URL_PATTERNS", None)
        else:
            os.environ["BROWSER_AGENT_NETWORK_CAPTURE_URL_PATTERNS"] = previous_patterns


async def test_browser_diagnostics_capture_console_and_redacted_network_metadata():
    import io
    import tempfile
    import zipfile

    from domains.spawn_browser_agent_v3.recording import BrowserNetworkRecorder

    class RegisterDomain:
        def __init__(self):
            self.handlers = {}

        def __getattr__(self, name):
            def register(handler):
                self.handlers[name] = handler

            return register

    class SendDomain:
        def __init__(self):
            self.enabled_session_ids = []

        async def enable(self, session_id=None):
            self.enabled_session_ids.append(session_id)

    with tempfile.TemporaryDirectory() as tmp:
        network_register = RegisterDomain()
        runtime_register = RegisterDomain()
        log_register = RegisterDomain()
        webauthn_register = RegisterDomain()
        network_send = SendDomain()
        runtime_send = SendDomain()
        log_send = SendDomain()
        cdp_client = SimpleNamespace(
            register=SimpleNamespace(
                Network=network_register,
                Runtime=runtime_register,
                Log=log_register,
                WebAuthn=webauthn_register,
            ),
            send=SimpleNamespace(
                Network=network_send,
                Runtime=runtime_send,
                Log=log_send,
            ),
        )
        browser_session = SimpleNamespace(
            cdp_client=cdp_client,
            get_or_create_cdp_session=AsyncMock(
                return_value=SimpleNamespace(session_id="cdp-1", cdp_client=cdp_client)
            ),
        )
        recorder = BrowserNetworkRecorder(
            browser_session=browser_session,
            agent_id="agent-1",
            task_id="task-1",
            session_id="browser-1",
            output_dir=Path(tmp),
            persist_network_log=False,
        )
        await recorder.start()

        runtime_register.handlers["consoleAPICalled"](
            {
                "type": "error",
                "timestamp": 123.5,
                "args": [{"type": "string", "value": "token=supersecret"}],
                "stackTrace": {
                    "callFrames": [
                        {"url": "https://amazon.com/login.js?sig=secret", "lineNumber": 7}
                    ]
                },
            },
            "cdp-1",
        )
        runtime_register.handlers["exceptionThrown"](
            {
                "timestamp": 124.5,
                "exceptionDetails": {
                    "text": "Uncaught NotAllowedError",
                    "url": "https://amazon.com/login.js?token=secret",
                    "lineNumber": 9,
                },
            },
            "cdp-1",
        )
        log_register.handlers["entryAdded"](
            {
                "entry": {
                    "source": "javascript",
                    "level": "error",
                    "text": "WebAuthn request failed",
                    "url": "https://amazon.com/ap/signin?session=secret",
                    "timestamp": 125.5,
                }
            },
            "cdp-1",
        )
        webauthn_register.handlers["credentialAsserted"](
            {
                "authenticatorId": "authenticator-secret-id",
                "credential": {
                    "credentialId": "credential-secret-id",
                    "rpId": "amazon.com",
                    "signCount": 5201,
                    "isResidentCredential": True,
                },
            },
            "cdp-1",
        )
        network_register.handlers["requestWillBeSent"](
            {
                "requestId": "req-1",
                "type": "Fetch",
                "request": {
                    "method": "POST",
                    "url": "https://amazon.com/webauthn/assert?token=supersecret",
                    "headers": {"Authorization": "Bearer secret"},
                },
            },
            "cdp-1",
        )
        request_entry = next(
            entry for entry in recorder.entries.values() if entry["request_id"] == "req-1"
        )
        request_entry.update(
            {
                "body_file": "0001-secret-response.json",
                "body_size": 1234,
                "body_truncated": False,
                "body_base64_encoded": False,
                "body_captured_at_ms": 126.5,
            }
        )
        network_register.handlers["loadingFailed"](
            {"requestId": "req-1", "errorText": "net::ERR_FAILED"},
            "cdp-1",
        )

        network_path = await recorder.close()
        bundle = recorder.export_diagnostics_bundle_bytes()

        assert network_path == recorder.network_index_path
        assert recorder.console_index_path is not None and recorder.console_index_path.exists()
        assert bundle is not None
        with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
            assert sorted(archive.namelist()) == ["console/index.json", "network/index.json"]
            console_text = archive.read("console/index.json").decode("utf-8")
            network_text = archive.read("network/index.json").decode("utf-8")

        assert "supersecret" not in console_text
        assert "token=[REDACTED]" in console_text
        assert "?sig=" not in console_text and "?session=" not in console_text
        assert "webauthn_credential_asserted" in console_text
        assert '"rp_id": "amazon.com"' in console_text
        assert '"sign_count": 5201' in console_text
        assert "credential-secret-id" not in console_text
        assert "authenticator-secret-id" not in console_text
        assert "supersecret" not in network_text
        assert "authorization" in network_text and "[REDACTED]" in network_text
        assert "https://amazon.com/webauthn/assert" in network_text
        assert "body_file" not in network_text
        assert "body_size" not in network_text
        assert "secret-response" not in network_text
        assert "body_file" in recorder.network_index_path.read_text()
        assert runtime_send.enabled_session_ids == ["cdp-1"]
        assert log_send.enabled_session_ids == ["cdp-1"]


def test_browser_turn_history_preserves_state_before_tool_result():
    from domains.spawn_browser_agent_v3.handler import _append_browser_turn_messages

    turns = []
    _append_browser_turn_messages(
        turns,
        task="# Current Goal\nBuy socks",
        browser_state={
            "url": "https://example.com/cart",
            "title": "Cart",
            "viewport": {"width": 1280, "height": 800},
            "dom_tree": "[7]<button>Checkout</button>",
            "screenshot": "AAAA",
        },
        include_screenshot=False,
        unified_action={
            "action": "click",
            "thinking": "Click checkout.",
            "index": 7,
            "params": {"index": 7},
        },
        result={"success": True, "message": ""},
        tool_call_id="call_123",
    )

    assert [message["role"] for message in turns] == ["user", "assistant", "tool"]
    assert "Current URL: https://example.com/cart - Cart" in turns[0]["content"]
    assert "[7]<button>Checkout</button>" in turns[0]["content"]
    assert isinstance(turns[0]["content"], str)
    assert turns[1]["content"] == "Click checkout."
    assert turns[1]["tool_calls"][0]["function"]["name"] == "click"
    assert turns[2]["name"] == "click"

def _fake_config(
    backend_url: str = "https://backend.example.com",
    backend_api_key: str = "test-backend-key",
    rose_api_url: str = "https://rose.example.com/completions",
    rose_api_key: str = "rose-key",
    rose_supabase_anon_key: str = "anon-key",
    payment_decryption_key: str = "",
    openrouter_api_key: str = "or-key",
    openrouter_base_url: str = "https://openrouter.example.com/api/v1",
):
    """Build a minimal config object (ducktyped) compatible with repo/service calls."""
    return SimpleNamespace(
        backend=SimpleNamespace(api_url=backend_url, api_key=backend_api_key),
        rose=SimpleNamespace(
            api_url=rose_api_url,
            api_key=rose_api_key,
            supabase_anon_key=rose_supabase_anon_key,
        ),
        payment=SimpleNamespace(decryption_key=payment_decryption_key),
        openrouter=SimpleNamespace(api_key=openrouter_api_key, base_url=openrouter_base_url),
    )

# ========================================
# service_crypto: extract_rate_limited_until
# ========================================

def test_normalize_rate_limited_until_handles_epoch_int():
    from domains.spawn_browser_agent_v3.service_crypto import (
        _normalize_rate_limited_until,
    )

    result = _normalize_rate_limited_until(1700000000)
    assert result is not None and result.endswith("Z")

def test_normalize_rate_limited_until_handles_epoch_string():
    from domains.spawn_browser_agent_v3.service_crypto import (
        _normalize_rate_limited_until,
    )

    result = _normalize_rate_limited_until("1700000000")
    assert result is not None and result.endswith("Z")

def test_normalize_rate_limited_until_handles_iso_naive():
    from domains.spawn_browser_agent_v3.service_crypto import (
        _normalize_rate_limited_until,
    )

    result = _normalize_rate_limited_until("2025-01-01T00:00:00")
    assert result is not None and result.endswith("Z")

def test_normalize_rate_limited_until_handles_iso_z():
    from domains.spawn_browser_agent_v3.service_crypto import (
        _normalize_rate_limited_until,
    )

    result = _normalize_rate_limited_until("2025-01-01T00:00:00Z")
    assert result is not None and "2025-01-01" in result

def test_normalize_rate_limited_until_none_empty_invalid():
    from domains.spawn_browser_agent_v3.service_crypto import (
        _normalize_rate_limited_until,
    )

    assert _normalize_rate_limited_until(None) is None
    assert _normalize_rate_limited_until("") is None
    assert _normalize_rate_limited_until("   ") is None
    assert _normalize_rate_limited_until("not-a-date") is None
    assert _normalize_rate_limited_until(-1) is None

def test_extract_rate_limited_until_not_dict():
    from domains.spawn_browser_agent_v3.service_crypto import extract_rate_limited_until

    assert extract_rate_limited_until(None) is None
    assert extract_rate_limited_until("string") is None
    assert extract_rate_limited_until([]) is None

def test_extract_rate_limited_until_canonical_field():
    from domains.spawn_browser_agent_v3.service_crypto import extract_rate_limited_until

    assert extract_rate_limited_until({"rateLimitedUntil": "2025-01-01T00:00:00Z"}) is not None
    assert extract_rate_limited_until({"rate_limited_until": 1700000000}) is not None
    assert extract_rate_limited_until({"rateLimitedUntilIso": "2025-01-01T00:00:00Z"}) is not None

def test_extract_rate_limited_until_from_headers_reset():
    from domains.spawn_browser_agent_v3.service_crypto import extract_rate_limited_until

    out = extract_rate_limited_until({"rateLimitHeaders": {"unifiedReset": "1700000000"}})
    assert out is not None

def test_extract_rate_limited_until_from_headers_retry_after():
    from domains.spawn_browser_agent_v3.service_crypto import extract_rate_limited_until

    out = extract_rate_limited_until({"rate_limit_headers": {"retryAfter": "60"}})
    assert out is not None

    out2 = extract_rate_limited_until({"rate_limit_headers": {"retry-after": "30"}})
    assert out2 is not None

    # zero retry-after returns None
    out3 = extract_rate_limited_until({"rate_limit_headers": {"retryAfter": "0"}})
    assert out3 is None

# ========================================
# service_crypto: OTP extraction + iMessage source
# ========================================

def test_extract_otp_comprehensive_formats():
    from domains.spawn_browser_agent_v3.service_crypto import extract_otp_from_text

    assert extract_otp_from_text("Your verification code is 123456") == "123456"
    assert extract_otp_from_text("123456 is your Amazon one-time code") == "123456"
    assert extract_otp_from_text("G-456789 is your Google verification code") == "456789"
    assert extract_otp_from_text("[Uber] Your code: 2744. Never share this code.") == "2744"
    assert extract_otp_from_text("Your one-time passcode is 998877") == "998877"
    assert extract_otp_from_text("Enter 135790 to verify your account") == "135790"

def test_extract_otp_ignores_non_otp_numbers():
    from domains.spawn_browser_agent_v3.service_crypto import extract_otp_from_text

    # Conversational / commercial numbers must not be mistaken for codes.
    assert extract_otp_from_text("Let's meet at 4021 Main St at 7pm") is None
    assert extract_otp_from_text("Your order 12345678 has shipped") is None
    assert extract_otp_from_text("I'll send you $5500 tomorrow") is None

def test_format_otp_user_message_shows_sms_label_and_sender():
    from domains.spawn_browser_agent_v3.service_crypto import (
        ExtractedOTP,
        format_otp_user_message,
    )

    otp = ExtractedOTP(
        code="123456",
        sender="262966",
        received_at="",
        age_seconds=45,
        ttl_seconds=255,
        channel="sms",
    )
    msg = format_otp_user_message(otp)
    assert "SMS OTP" in msg
    assert "123456" in msg
    # The source (sender) is surfaced to the agent.
    assert "262966" in msg

async def test_fetch_recent_otps_includes_imessage_and_prefers_agentphone():
    import domains.spawn_browser_agent_v3.service_crypto as sc

    now_iso = datetime.now(timezone.utc).isoformat()
    agentphone = [
        {
            "id": "ap1",
            "from": "+18885551234",
            "to": "agentnum",
            "body": "Your code is 123456",
            "date": now_iso,
        }
    ]
    imessages = [
        # Duplicate code from iMessage — agent-phone should win the dedup.
        {
            "id": "im1",
            "from": "262966",
            "to": "me",
            "body": "Your Amazon code is 123456",
            "date": now_iso,
        },
        # iMessage-only code — should be surfaced, mapped to the SMS channel.
        {
            "id": "im2",
            "from": "729000",
            "to": "me",
            "body": "Your verification code is 999888",
            "date": now_iso,
        },
    ]

    with (
        patch.object(sc, "fetch_recent_emails", AsyncMock(return_value=[])),
        patch.object(sc, "fetch_recent_sms_messages", AsyncMock(return_value=agentphone)),
        patch.object(sc, "fetch_recent_imessages", AsyncMock(return_value=imessages)),
    ):
        otps = await sc.fetch_recent_otps("user-1", "http://backend", "api-key")

    by_code = {o.code: o for o in otps}
    assert "123456" in by_code, f"expected agent-phone code, got {list(by_code)}"
    assert "999888" in by_code, f"expected iMessage-only code, got {list(by_code)}"
    # Agent-phone won the dedup for the shared code.
    assert by_code["123456"].sender == "+18885551234"
    # iMessage-sourced OTP is mapped to the SMS channel for the agent prompt.
    assert by_code["999888"].sender == "729000"
    assert by_code["999888"].channel == "sms"

async def test_fetch_recent_otps_skips_imessage_without_otp_context():
    import domains.spawn_browser_agent_v3.service_crypto as sc

    now_iso = datetime.now(timezone.utc).isoformat()
    imessages = [
        {
            "id": "im1",
            "from": "5551212",
            "to": "me",
            "body": "see you at 4021 Main St",
            "date": now_iso,
        },
    ]

    with (
        patch.object(sc, "fetch_recent_emails", AsyncMock(return_value=[])),
        patch.object(sc, "fetch_recent_sms_messages", AsyncMock(return_value=[])),
        patch.object(sc, "fetch_recent_imessages", AsyncMock(return_value=imessages)),
    ):
        otps = await sc.fetch_recent_otps("user-1", "http://backend", "api-key")

    assert otps == []

def test_extract_rate_limited_until_from_text_iso():
    from domains.spawn_browser_agent_v3.service_crypto import extract_rate_limited_until

    out = extract_rate_limited_until({"message": "rate limited until 2025-01-01T00:00:00Z please wait"})
    assert out is not None

def test_extract_rate_limited_until_from_text_epoch():
    from domains.spawn_browser_agent_v3.service_crypto import extract_rate_limited_until

    out = extract_rate_limited_until({"details": "try again after 1700000000 seconds"})
    assert out is not None

def test_extract_rate_limited_until_from_text_retry_after():
    from domains.spawn_browser_agent_v3.service_crypto import extract_rate_limited_until

    out = extract_rate_limited_until({"error": "rate-limit retry-after: 90"})
    assert out is not None

def test_extract_rate_limited_until_no_signal():
    from domains.spawn_browser_agent_v3.service_crypto import extract_rate_limited_until

    assert extract_rate_limited_until({}) is None
    assert extract_rate_limited_until({"unrelated": "stuff"}) is None
    assert extract_rate_limited_until({"message": "just some words no dates"}) is None

# ========================================
# service_crypto: decrypt_payment_info
# ========================================

def test_decrypt_payment_info_roundtrip():
    from domains.spawn_browser_agent_v3.service_crypto import decrypt_payment_info

    priv_b64, public_key, _ = _make_rsa_keypair()
    payment = {
        "card_number": "4242424242424242",
        "cardholder_name": "Test User",
        "card_expiry": "12/30",
        "card_cvv": "123",
        "autoagentpaylimit_cents": 5000,
    }
    envelope = _encrypt_envelope(json.dumps(payment).encode("utf-8"), public_key)

    result = decrypt_payment_info(envelope, priv_b64)
    assert result == payment

def test_decrypt_payment_info_wrong_version():
    from domains.spawn_browser_agent_v3.service_crypto import decrypt_payment_info

    priv_b64, public_key, _ = _make_rsa_keypair()
    envelope = _encrypt_envelope(b'{"a":1}', public_key, version=2)

    assert decrypt_payment_info(envelope, priv_b64) is None

def test_decrypt_payment_info_bad_envelope():
    from domains.spawn_browser_agent_v3.service_crypto import decrypt_payment_info

    priv_b64, _, _ = _make_rsa_keypair()

    # Not base64
    assert decrypt_payment_info("not-base64!!!", priv_b64) is None

    # Base64 but not JSON
    assert decrypt_payment_info(base64.b64encode(b"not json").decode(), priv_b64) is None

def test_decrypt_password_roundtrip():
    from domains.spawn_browser_agent_v3.service_crypto import decrypt_password

    priv_b64, public_key, _ = _make_rsa_keypair()
    envelope = _encrypt_envelope(b"my-secret-password-123", public_key)

    assert decrypt_password(envelope, priv_b64) == "my-secret-password-123"

def test_decrypt_password_wrong_version():
    from domains.spawn_browser_agent_v3.service_crypto import decrypt_password

    priv_b64, public_key, _ = _make_rsa_keypair()
    envelope = _encrypt_envelope(b"anything", public_key, version=9)
    assert decrypt_password(envelope, priv_b64) is None

def test_decrypt_password_invalid_input_returns_none():
    from domains.spawn_browser_agent_v3.service_crypto import decrypt_password

    priv_b64, _, _ = _make_rsa_keypair()
    assert decrypt_password("***invalid***", priv_b64) is None

def test_decrypt_password_with_key_roundtrip():
    from domains.spawn_browser_agent_v3.service_crypto import decrypt_password_with_key

    _, public_key, private_key = _make_rsa_keypair()
    envelope = _encrypt_envelope(b"hunter2", public_key)

    assert decrypt_password_with_key(envelope, private_key) == "hunter2"

def test_decrypt_password_with_key_bad_version():
    from domains.spawn_browser_agent_v3.service_crypto import decrypt_password_with_key

    _, public_key, private_key = _make_rsa_keypair()
    envelope = _encrypt_envelope(b"x", public_key, version=3)
    assert decrypt_password_with_key(envelope, private_key) is None

def test_decrypt_password_with_key_bad_envelope():
    from domains.spawn_browser_agent_v3.service_crypto import decrypt_password_with_key

    _, _, private_key = _make_rsa_keypair()
    assert decrypt_password_with_key("~~~~", private_key) is None

# ========================================
# service_crypto: OTP extraction
# ========================================

def test_extract_otp_from_text_verification_code():
    from domains.spawn_browser_agent_v3.service_crypto import extract_otp_from_text

    assert extract_otp_from_text("Your verification code: 123456") == "123456"
    assert extract_otp_from_text("Your security code: 654321") == "654321"

def test_extract_otp_from_text_is_your_code():
    from domains.spawn_browser_agent_v3.service_crypto import extract_otp_from_text

    assert extract_otp_from_text("123456 is your verification code") == "123456"

def test_extract_otp_from_text_4_digit_pin():
    from domains.spawn_browser_agent_v3.service_crypto import extract_otp_from_text

    assert extract_otp_from_text("Your PIN: 4321") == "4321"

def test_extract_otp_from_text_8_digit_code():
    from domains.spawn_browser_agent_v3.service_crypto import extract_otp_from_text

    assert extract_otp_from_text("Use code: 12345678 to confirm") == "12345678"

def test_extract_otp_from_text_expires_phrase():
    from domains.spawn_browser_agent_v3.service_crypto import extract_otp_from_text

    assert extract_otp_from_text("Code 789012 expires in 5 minutes") == "789012"

def test_extract_otp_from_text_low_confidence_context_strict():
    from domains.spawn_browser_agent_v3.service_crypto import extract_otp_from_text

    # Contains "order" low-confidence keyword, only first 3 patterns should match
    # This one has no specific context -> should return None
    assert extract_otp_from_text("Your order number is 123456") is None

    # But with explicit auth context, still returns
    assert extract_otp_from_text("Your order #555. Verification code: 123456") == "123456"

def test_extract_otp_from_text_no_match():
    from domains.spawn_browser_agent_v3.service_crypto import extract_otp_from_text

    assert extract_otp_from_text("hello world, nothing interesting") is None

async def test_fetch_recent_otps_empty():
    from domains.spawn_browser_agent_v3.service_crypto import fetch_recent_otps

    setup_mock(
        {
            "/api/integrations/email/messages": {"status": 200, "json": {"emails": []}},
            "/api/agentphone/messages": {"status": 200, "json": {"messages": []}},
        }
    )
    result = await fetch_recent_otps("u1", "https://backend.example.com", "k1")
    assert result == []

async def test_fetch_recent_otps_extracts_codes():
    from domains.spawn_browser_agent_v3.service_crypto import fetch_recent_otps

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    setup_mock(
        {
            "/api/integrations/email/messages": {
                "status": 200,
                "json": {
                    "emails": [
                        {
                            "bodyText": "Your verification code: 987654",
                            "date": now,
                            "fromName": "Acme",
                            "credentialId": "email-cred-1",
                        }
                    ]
                },
            },
            "/api/agentphone/messages": {"status": 200, "json": {"messages": []}},
        }
    )
    result = await fetch_recent_otps("u1", "https://backend.example.com", "k1")
    assert len(result) == 1
    assert result[0].code == "987654"
    assert result[0].sender == "Acme"
    assert result[0].credential_id == "email-cred-1"

async def test_fetch_recent_otps_extracts_codes_from_html_body():
    from domains.spawn_browser_agent_v3.service_crypto import fetch_recent_otps

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    setup_mock(
        {
            "/api/integrations/email/messages": {
                "status": 200,
                "json": {
                    "emails": [
                        {
                            "bodyText": "",
                            "bodyHtml": "<p>Verification code:</p><p>8148</p><p>Enter this code.</p>",
                            "date": now,
                            "fromName": "Uber",
                            "credentialId": "primitive-inbox",
                        }
                    ]
                },
            },
            "/api/agentphone/messages": {"status": 200, "json": {"messages": []}},
        }
    )
    result = await fetch_recent_otps("u1", "https://backend.example.com", "k1")
    assert len(result) == 1
    assert result[0].code == "8148"
    assert result[0].sender == "Uber"
    assert result[0].credential_id == "primitive-inbox"

async def test_fetch_recent_otps_dedupes_old_emails():
    from domains.spawn_browser_agent_v3.service_crypto import fetch_recent_otps

    # age > 600s -> excluded
    old = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat().replace("+00:00", "Z")
    setup_mock(
        {
            "/api/integrations/email/messages": {
                "status": 200,
                "json": {
                    "emails": [
                        {
                            "bodyText": "Verification code: 111222",
                            "date": old,
                            "from": "old@example.com",
                        }
                    ]
                },
            },
            "/api/agentphone/messages": {"status": 200, "json": {"messages": []}},
        }
    )
    result = await fetch_recent_otps("u1", "https://backend.example.com", "k1")
    assert result == []

async def test_fetch_recent_otps_skips_nearly_expired_codes():
    from domains.spawn_browser_agent_v3.service_crypto import fetch_recent_otps

    stale = (datetime.now(timezone.utc) - timedelta(minutes=4, seconds=45)).isoformat().replace("+00:00", "Z")
    setup_mock(
        {
            "/api/integrations/email/messages": {
                "status": 200,
                "json": {
                    "emails": [
                        {
                            "bodyText": "Verification code: 222333",
                            "date": stale,
                            "from": "stale@example.com",
                        }
                    ]
                },
            },
            "/api/agentphone/messages": {"status": 200, "json": {"messages": []}},
        }
    )
    result = await fetch_recent_otps("u1", "https://backend.example.com", "k1")
    assert result == []

async def test_fetch_recent_otps_extracts_sms_codes():
    from domains.spawn_browser_agent_v3.service_crypto import fetch_recent_otps

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    setup_mock(
        {
            "/api/integrations/email/messages": {"status": 200, "json": {"emails": []}},
            "/api/agentphone/messages": {
                "status": 200,
                "json": {
                    "messages": [
                        {
                            "id": "sms-msg-1",
                            "body": "Your Uber code is 4821.",
                            "date": now,
                            "from": "14155550100",
                            "to": "+19125550199",
                            "credentialPhone": "+19125550199",
                        }
                    ]
                },
            },
        }
    )

    result = await fetch_recent_otps("u1", "https://backend.example.com", "k1")
    assert len(result) == 1
    assert result[0].code == "4821"
    assert result[0].sender == "14155550100"
    assert result[0].credential_id == "+19125550199"
    assert result[0].credential_kind == "sms_otp"
    assert result[0].channel == "sms"

def test_format_otp_user_message():
    from domains.spawn_browser_agent_v3.service_crypto import (
        ExtractedOTP,
        format_otp_user_message,
    )

    out = format_otp_user_message(
        ExtractedOTP(
            code="123456",
            sender="Acme",
            received_at="2026-01-01T00:00:00Z",
            age_seconds=30,
            ttl_seconds=270,
        )
    )
    assert "123456" in out
    assert "Acme" in out
    assert "email OTP" in out

def test_format_otp_user_message_sms():
    from domains.spawn_browser_agent_v3.service_crypto import (
        ExtractedOTP,
        format_otp_user_message,
    )

    out = format_otp_user_message(
        ExtractedOTP(
            code="4821",
            sender="14155550100",
            received_at="2026-01-01T00:00:00Z",
            age_seconds=10,
            ttl_seconds=290,
            credential_kind="sms_otp",
            channel="sms",
        )
    )
    assert "4821" in out
    assert "SMS OTP" in out
    assert "phone OTP" in out

# ========================================
# service_crypto: prompt builders
# ========================================

def test_build_autopay_prompt_section():
    from domains.spawn_browser_agent_v3.service_crypto import (
        build_autopay_prompt_section,
    )

    payment_data = {
        "autoagentpaylimit_cents": 10000,
        "card_number": "4111111111111111",
        "billing_street_address": "123 Main St",
        "billing_address_line2": "",
        "billing_city": "Austin",
        "billing_state": "TX",
        "billing_zipcode": "78701",
        "billing_country": "USA",
        "billing_phone": "555-1234",
        "billing_email": "test@example.com",
    }
    out = build_autopay_prompt_section(payment_data, "envelope-b64")
    assert "$100.00" in out
    assert "123 Main St" in out
    assert "555-1234" in out
    assert "test@example.com" in out
    assert "# User Context" not in out
    assert out.lstrip().startswith("## Billing Address")
    assert "## Payment Information" in out
    assert "call request_payment_card" in out
    assert "only if checkout requires you to enter new card details" in out
    assert "valid saved payment method is already selected" in out
    assert "do not call request_payment_card" in out
    # Card field names are emitted by the RESUME prompt (after mint), not the autopay prompt.
    assert "4111111111111111" not in out

def test_build_autopay_prompt_section_no_card():
    from domains.spawn_browser_agent_v3.service_crypto import (
        build_autopay_prompt_section,
    )

    out = build_autopay_prompt_section({"autoagentpaylimit_cents": 0, "card_number": ""}, "env")
    assert "call request_payment_card" in out

def test_build_payment_card_resume_prompt_section():
    from domains.spawn_browser_agent_v3.service_crypto import build_payment_card_resume_prompt_section

    out = build_payment_card_resume_prompt_section(
        {
            "card_number": "4111111111111111",
            "card_name": "Rose Labs",
            "card_expiry": "12/30",
            "card_cvv": "123",
        }
    )

    assert "Payment approval is complete" in out
    assert "Do not call request_payment_card again" in out
    assert "card_number" in out
    assert "card_name" in out
    assert "card_expiry" in out
    assert "card_cvv" in out
    assert "4111111111111111" not in out
    assert "12/30" not in out
    assert "123" not in out

def test_build_payment_card_resume_prompt_section_requires_all_refs():
    from domains.spawn_browser_agent_v3.service_crypto import build_payment_card_resume_prompt_section

    out = build_payment_card_resume_prompt_section({"card_number": "4111111111111111"})

    assert out == ""

def test_build_passwords_prompt_section_empty():
    from domains.spawn_browser_agent_v3.service_crypto import (
        build_passwords_prompt_section,
    )

    section, refs = build_passwords_prompt_section([])
    assert section == ""
    assert refs == {}

def test_build_passwords_prompt_section_unique_usernames():
    from domains.spawn_browser_agent_v3.service_crypto import (
        build_passwords_prompt_section,
    )

    passwords = [
        {
            "origin": "https://example.com",
            "username": "alice",
            "encryptedPassword": "enc1",
        },
        {"origin": "https://other.com", "username": "bob", "encryptedPassword": "enc2"},
    ]
    section, refs = build_passwords_prompt_section(passwords)
    assert "pwd:alice" in refs
    assert "pwd:bob" in refs
    assert refs["pwd:alice"] == "enc1"
    assert "AVAILABLE PASSWORDS" in section

def test_build_passwords_prompt_section_duplicate_usernames():
    from domains.spawn_browser_agent_v3.service_crypto import (
        build_passwords_prompt_section,
    )

    passwords = [
        {
            "origin": "https://amazon.com",
            "username": "alice",
            "encryptedPassword": "enc_a",
        },
        {
            "origin": "https://www.netflix.com",
            "username": "alice",
            "encryptedPassword": "enc_b",
        },
        {"origin": "noscheme.com", "username": "alice", "encryptedPassword": "enc_c"},
    ]
    _, refs = build_passwords_prompt_section(passwords)
    # All three should produce unique domain-suffixed refs
    assert any("amazon" in k for k in refs)
    assert any("netflix" in k for k in refs)
    assert any("noscheme" in k for k in refs)

def test_build_auth_options_prompt_section_scoped_password_refs():
    from domains.spawn_browser_agent_v3.service_crypto import (
        build_auth_options_prompt_section,
    )

    cookie_dt = datetime(2024, 5, 1, tzinfo=timezone.utc)
    chrome_cookie_micros = int((cookie_dt.timestamp() + 11644473600) * 1_000_000)
    auth_options = {
        "realm": "example.com",
        "cookie_bundles": [
            {
                "id": "cb1",
                "browserSource": "chrome",
                "browserProfile": "Default",
                "freshestCookieUtc": chrome_cookie_micros,
            }
        ],
        "passwords": [
            {
                "id": "pwd1",
                "origin": "https://example.com",
                "username": "alice@example.com",
                "ref": "pwd:alice@example.com",
            }
        ],
        "email_otp": {"available": True, "connected_emails": ["alice@example.com"]},
        "minted": None,
    }
    session_passwords = [
        {
            "id": "pwd1",
            "origin": "https://example.com",
            "username": "alice@example.com",
            "encryptedPassword": "enc1",
        },
        {
            "origin": "https://other.com",
            "username": "alice@example.com",
            "encryptedPassword": "enc2",
        },
    ]
    section, refs, origins, credential_refs = build_auth_options_prompt_section(auth_options, session_passwords)
    assert "# Auth Options for example.com" in section
    assert "cb1" in section
    assert "freshestCookieUtc: 2024-05-01T00:00:00Z" in section
    assert "pwd:alice@example.com" in section
    assert "https://other.com" not in section
    assert refs == {"pwd:alice@example.com": "enc1"}
    assert origins["pwd:alice@example.com"] == "https://example.com"
    assert credential_refs["pwd:alice@example.com"] == {
        "kind": "password",
        "id": "pwd1",
    }

def test_build_auth_options_prompt_section_demo_site_ref_does_not_expose_plaintext():
    from domains.spawn_browser_agent_v3.service_crypto import (
        build_auth_options_prompt_section,
    )

    auth_options = {
        "realm": "practicetestautomation.com",
        "cookie_bundles": [],
        "passwords": [
            {
                "id": "pwd-demo",
                "origin": "https://practicetestautomation.com/practice-test-login/",
                "username": "student",
                "ref": "pwd:student",
            }
        ],
        "email_otp": {"available": False, "connected_emails": []},
        "minted": None,
    }
    session_passwords = [
        {
            "id": "pwd-demo",
            "origin": "https://practicetestautomation.com/practice-test-login/",
            "username": "student",
            "encryptedPassword": "encrypted-password-not-plaintext",
        }
    ]

    section, refs, origins, credential_refs = build_auth_options_prompt_section(auth_options, session_passwords)

    assert "ref: pwd:student" in section
    assert "Password123" not in section
    assert "encrypted-password-not-plaintext" not in section
    assert refs == {"pwd:student": "encrypted-password-not-plaintext"}
    assert origins["pwd:student"] == "https://practicetestautomation.com/practice-test-login/"
    assert credential_refs["pwd:student"] == {"kind": "password", "id": "pwd-demo"}

def test_build_auth_options_prompt_section_matches_duplicate_username_by_id():
    from domains.spawn_browser_agent_v3.service_crypto import (
        build_auth_options_prompt_section,
    )

    auth_options = {
        "realm": "amazon.com",
        "cookie_bundles": [],
        "passwords": [
            {
                "id": "pwd-amz-1",
                "username": "shopper@example.com",
                "origin": "https://www.amazon.com/ap/signin",
                "ref": "pwd:shopper@example.com@amazon#aaa11111",
            },
            {
                "id": "pwd-amz-2",
                "username": "shopper@example.com",
                "origin": "https://amazon.com/login",
                "ref": "pwd:shopper@example.com@amazon#bbb22222",
            },
        ],
        "email_otp": {"available": False},
        "minted": None,
    }
    session_passwords = [
        {
            "id": "pwd-amz-1",
            "origin": "https://www.amazon.com/ap/signin",
            "username": "shopper@example.com",
            "encryptedPassword": "enc1",
        },
        {
            "id": "pwd-amz-2",
            "origin": "https://amazon.com/login",
            "username": "shopper@example.com",
            "encryptedPassword": "enc2",
        },
    ]

    section, refs, origins, credential_refs = build_auth_options_prompt_section(auth_options, session_passwords)

    first_ref = "pwd:shopper@example.com@amazon#aaa11111"
    second_ref = "pwd:shopper@example.com@amazon#bbb22222"
    assert refs == {first_ref: "enc1", second_ref: "enc2"}
    assert origins[first_ref] == "https://www.amazon.com/ap/signin"
    assert origins[second_ref] == "https://amazon.com/login"
    assert credential_refs[first_ref] == {"kind": "password", "id": "pwd-amz-1"}
    assert credential_refs[second_ref] == {"kind": "password", "id": "pwd-amz-2"}
    assert "encryptedPassword" not in section
    assert "enc1" not in section
    assert "enc2" not in section

def test_build_auth_options_prompt_section_fails_closed_when_password_id_missing():
    from domains.spawn_browser_agent_v3.service_crypto import (
        build_auth_options_prompt_section,
    )

    auth_options = {
        "realm": "amazon.com",
        "cookie_bundles": [],
        "passwords": [
            {
                "id": "pwd-missing",
                "username": "shopper@example.com",
                "origin": "https://www.amazon.com/ap/signin",
                "ref": "pwd:shopper@example.com@amazon#missing",
            }
        ],
        "email_otp": {"available": False},
        "minted": None,
    }
    session_passwords = [
        {
            "id": "pwd-present",
            "origin": "https://www.amazon.com/ap/signin",
            "username": "shopper@example.com",
            "encryptedPassword": "enc-present",
        }
    ]

    section, refs, origins, credential_refs = build_auth_options_prompt_section(auth_options, session_passwords)

    assert refs == {}
    assert origins == {}
    assert credential_refs == {}
    assert "pwd:shopper@example.com@amazon#missing" not in section
    assert "unavailable in this session" in section
    assert "enc-present" not in section

def test_build_auth_options_prompt_section_fails_closed_when_session_ids_absent():
    from domains.spawn_browser_agent_v3.service_crypto import (
        build_auth_options_prompt_section,
    )

    auth_options = {
        "realm": "amazon.com",
        "cookie_bundles": [],
        "passwords": [
            {
                "id": "pwd-requires-id",
                "username": "shopper@example.com",
                "origin": "https://www.amazon.com/ap/signin",
                "ref": "pwd:shopper@example.com@amazon#requires-id",
            }
        ],
        "email_otp": {"available": False},
        "minted": None,
    }
    session_passwords = [
        {
            "origin": "https://www.amazon.com/ap/signin",
            "username": "shopper@example.com",
            "encryptedPassword": "enc-present",
        }
    ]

    section, refs, origins, credential_refs = build_auth_options_prompt_section(auth_options, session_passwords)

    assert refs == {}
    assert origins == {}
    assert credential_refs == {}
    assert "pwd:shopper@example.com@amazon#requires-id" not in section
    assert "unavailable in this session" in section

def test_build_auth_options_prompt_section_dedupes_identical_refs_without_overwrite():
    from domains.spawn_browser_agent_v3.service_crypto import (
        build_auth_options_prompt_section,
    )

    duplicate_ref = "pwd:shopper@example.com@amazon"
    auth_options = {
        "realm": "amazon.com",
        "cookie_bundles": [],
        "passwords": [
            {
                "id": "pwd-amz-first",
                "username": "shopper@example.com",
                "origin": "https://www.amazon.com/ap/signin",
                "ref": duplicate_ref,
            },
            {
                "id": "pwd-amz-second",
                "username": "shopper@example.com",
                "origin": "https://amazon.com/login",
                "ref": duplicate_ref,
            },
        ],
        "email_otp": {"available": False},
        "minted": None,
    }
    session_passwords = [
        {
            "id": "pwd-amz-first",
            "origin": "https://www.amazon.com/ap/signin",
            "username": "shopper@example.com",
            "encryptedPassword": "enc-first",
        },
        {
            "id": "pwd-amz-second",
            "origin": "https://amazon.com/login",
            "username": "shopper@example.com",
            "encryptedPassword": "enc-second",
        },
    ]

    section, refs, origins, credential_refs = build_auth_options_prompt_section(auth_options, session_passwords)

    first_ref = duplicate_ref
    second_ref = f"{duplicate_ref}#pwd-amz-"
    assert refs[first_ref] == "enc-first"
    assert refs[second_ref] == "enc-second"
    assert origins[first_ref] == "https://www.amazon.com/ap/signin"
    assert origins[second_ref] == "https://amazon.com/login"
    assert credential_refs[first_ref] == {"kind": "password", "id": "pwd-amz-first"}
    assert credential_refs[second_ref] == {"kind": "password", "id": "pwd-amz-second"}
    assert section.count(f"ref: {duplicate_ref}") == 2

def test_auth_realm_from_url():
    from domains.spawn_browser_agent_v3.service_crypto import auth_realm_from_url

    assert auth_realm_from_url("https://www.example.com/path") == "example.com"
    assert auth_realm_from_url("accounts.example.com") == "accounts.example.com"
    assert auth_realm_from_url("https://auth.uber.com/login") == "uber.com"
    assert auth_realm_from_url("https://m.uber.com/go/home") == "uber.com"
    assert auth_realm_from_url("") == ""

def test_resume_context_from_session_info_prefers_resumed_state():
    from domains.spawn_browser_agent_v3.handler import _resume_context_from_session_info

    user_profile, auth_realm = _resume_context_from_session_info(
        {
            "auth_realm": "amazon.com",
            "current_url": "https://www.amazon.com/ap/signin",
            "start_url": "https://www.google.com/",
            "user_settings": {"name": "Resume Shopper", "addressLine1": "1 Main St"},
        },
        "google.com",
    )

    assert auth_realm == "amazon.com"
    assert user_profile["addressLine1"] == "1 Main St"


def test_browser_profile_separates_owner_from_delivery_recipient():
    from domains.spawn_browser_agent_v3.handler import build_browser_user_profile_sections

    sections = build_browser_user_profile_sections(
        {
            "name": "Andy Prevalsky",
            "email": "andy@roselabs.ai",
            "phone": "+19729777432",
            "deliveryRecipientName": "Aman Gottumukkala",
            "addressLine1": "88 Howard St",
            "city": "San Francisco",
            "state": "CA",
            "postalCode": "94105",
            "country": "US",
        }
    )

    context = "\n\n".join(sections)
    assert "## Personal Information\nFull Name: Andy Prevalsky" in context
    assert "## Delivery Address\nRecipient Name: Aman Gottumukkala" in context
    assert context.index("Full Name: Andy Prevalsky") < context.index("Recipient Name: Aman Gottumukkala")


def test_build_auth_options_prompt_section_minted_account_ref():
    from domains.spawn_browser_agent_v3.service_crypto import (
        build_auth_options_prompt_section,
    )

    section, refs, origins, credential_refs = build_auth_options_prompt_section(
        {
            "realm": "example.com",
            "cookie_bundles": [],
            "passwords": [],
            "email_otp": {"available": False, "connected_emails": []},
            "minted": {
                "id": "mint1",
                "accountLabel": "agent+example@example.com",
                "phone": "+19125550199",
                "disabled": False,
            },
        },
        [],
    )

    assert "- Minted account: Email -> agent+example@example.com | Phone -> +19125550199 | enabled" in section
    assert "use agent email" not in section
    assert refs == {}
    assert origins == {}
    assert credential_refs["agent+example@example.com"] == {
        "kind": "minted_account",
        "id": "mint1",
    }
    assert credential_refs["+19125550199"] == {"kind": "minted_account", "id": "mint1"}

def test_auth_runtime_state_blocks_assistance_until_observable_ladder_exhausted():
    from domains.spawn_browser_agent_v3.service import AuthRuntimeState

    state = AuthRuntimeState.from_auth_options(
        {
            "passwords": [{"id": "pwd1", "ref": "pwd:alice@example.com"}],
            "email_otp": {
                "available": True,
                "match_for_site_account": "alice@example.com",
            },
            "minted": {"id": "mint1", "accountLabel": "agent+example@example.com"},
        }
    )

    allowed, reason, snapshot = state.user_assistance_guard()
    assert not allowed
    assert "password" in reason
    assert snapshot["password"]["remaining_ids"] == ["pwd1"]

    state.mark_credential_ref({"kind": "password", "id": "pwd1"})
    state.mark_credential_ref({"kind": "sms_otp", "id": "otp-message-1"})
    state.mark_credential_ref({"kind": "minted_account", "id": "mint1"})

    allowed, reason, snapshot = state.user_assistance_guard()
    assert allowed
    assert "exhausted" in reason
    assert snapshot["email_otp"]["attempted"] is True
    assert snapshot["minted"]["attempted"] is True
    assert snapshot["guest"]["unavailable"] is True

def test_auth_runtime_state_does_not_block_on_unmatched_connected_email():
    from domains.spawn_browser_agent_v3.service import AuthRuntimeState

    state = AuthRuntimeState.from_auth_options(
        {
            "passwords": [],
            "email_otp": {
                "available": True,
                "connected_emails": ["andy@example.com"],
                "match_for_site_account": None,
            },
            "minted": None,
        }
    )

    allowed, reason, snapshot = state.user_assistance_guard()
    assert allowed
    assert "exhausted" in reason
    assert snapshot["email_otp"]["available"] is False
    assert snapshot["email_otp"]["exhausted_or_unavailable"] is True

def test_auth_runtime_state_only_blocks_on_attemptable_passwords():
    from domains.spawn_browser_agent_v3.service import AuthRuntimeState

    state = AuthRuntimeState.from_auth_options(
        {
            "passwords": [
                {"id": "pwd-attemptable", "ref": "pwd:alice@example.com"},
                {"id": "pwd-missing-secret", "ref": "pwd:alice@example.com-2"},
            ],
            "email_otp": {"available": False},
            "minted": None,
        }
    )

    state.restrict_password_ids_to_attemptable({"pwd-attemptable"})
    state.mark_credential_ref({"kind": "password", "id": "pwd-attemptable"})

    allowed, reason, snapshot = state.user_assistance_guard()
    assert allowed
    assert "exhausted" in reason
    assert snapshot["password"]["remaining_ids"] == []

def test_auth_runtime_state_does_not_block_on_disabled_passwords():
    from domains.spawn_browser_agent_v3.service import AuthRuntimeState

    state = AuthRuntimeState.from_auth_options(
        {
            "passwords": [
                {"id": "pwd-disabled", "ref": "pwd:old@example.com", "disabled": True},
                {"id": "pwd-enabled", "ref": "pwd:new@example.com", "disabled": False},
            ],
            "email_otp": {"available": False},
            "minted": None,
        }
    )

    allowed, reason, snapshot = state.user_assistance_guard()
    assert not allowed
    assert snapshot["password"]["remaining_ids"] == ["pwd-enabled"]

    state.mark_credential_ref({"kind": "password", "id": "pwd-enabled"})

    allowed, reason, snapshot = state.user_assistance_guard()
    assert allowed
    assert "exhausted" in reason
    assert snapshot["password"]["remaining_ids"] == []

def test_auth_assistance_resume_user_message_preserves_live_state():
    from domains.spawn_browser_agent_v3.service import (
        build_auth_assistance_resume_user_message,
    )

    message = build_auth_assistance_resume_user_message(
        auth_realm="selenium.dev",
        handoff_mode="same_steel_session_live_view",
    )

    assert message["role"] == "user"
    content = message["content"]
    assert "selenium.dev" in content
    assert "same_steel_session_live_view" in content
    assert "same auth realm" in content
    assert "Do not undo user-entered changes" in content

# ========================================
# repo: fetch_claude_token
# ========================================

async def test_fetch_claude_token_success():
    from domains.spawn_browser_agent_v3.repo import fetch_claude_token

    setup_mock(
        {
            "/api/integrations/claude-code/credentials/token": {
                "status": 200,
                "json": {"accessToken": "tok", "source": "user"},
            }
        }
    )
    cfg = _fake_config()
    out = await fetch_claude_token(cfg, "user-1")
    assert out == {"accessToken": "tok", "source": "user"}

async def test_fetch_claude_token_non_200_returns_none():
    from domains.spawn_browser_agent_v3.repo import fetch_claude_token

    setup_mock({"/api/integrations/claude-code/credentials/token": {"status": 404, "json": {}}})
    cfg = _fake_config()
    assert await fetch_claude_token(cfg, "user-1") is None

async def test_fetch_claude_token_no_api_key_returns_none():
    from domains.spawn_browser_agent_v3.repo import fetch_claude_token

    cfg = _fake_config(backend_api_key="")
    assert await fetch_claude_token(cfg, "user-1") is None

async def test_fetch_claude_token_with_force_pool_and_excludes():
    from domains.spawn_browser_agent_v3.repo import fetch_claude_token

    setup_mock(
        {
            "/api/integrations/claude-code/credentials/token": {
                "status": 200,
                "json": {"accessToken": "t", "source": "pool", "poolTokenId": "p1"},
            }
        }
    )
    cfg = _fake_config()
    out = await fetch_claude_token(cfg, "u1", force_pool=True, exclude_pool_ids=["a", "b"])
    assert out["poolTokenId"] == "p1"
    call = assert_captured_call(url_contains="/credentials/token")
    assert call["requestHeaders"].get("X-Force-Pool") == "true" or call["requestHeaders"].get("x-force-pool") == "true"

async def test_fetch_claude_token_network_error_returns_none():
    from domains.spawn_browser_agent_v3.repo import fetch_claude_token

    def failing_handler(request):
        raise RuntimeError("boom")

    from _test_utils import setup_mock_fn

    setup_mock_fn(failing_handler)
    cfg = _fake_config()
    assert await fetch_claude_token(cfg, "u1") is None

async def test_report_claude_token_rate_limited_pool():
    from domains.spawn_browser_agent_v3.repo import report_claude_token_rate_limited

    setup_mock({"/token/rate-limited": {"status": 200, "json": {}}})
    cfg = _fake_config()
    await report_claude_token_rate_limited(
        cfg,
        user_id="u1",
        source="pool",
        pool_token_id="p1",
        rate_limited_until="2025-01-01T00:00:00Z",
    )
    assert_captured_call(url_contains="/token/rate-limited", method="POST")

async def test_report_claude_token_rate_limited_user():
    from domains.spawn_browser_agent_v3.repo import report_claude_token_rate_limited

    setup_mock({"/token/rate-limited": {"status": 200, "json": {}}})
    cfg = _fake_config()
    await report_claude_token_rate_limited(cfg, user_id="u1", source="user")
    assert_captured_call(url_contains="/token/rate-limited")

async def test_report_claude_token_rate_limited_bad_source_noop():
    from domains.spawn_browser_agent_v3.repo import report_claude_token_rate_limited

    setup_mock({"/token/rate-limited": {"status": 200, "json": {}}})
    cfg = _fake_config()
    await report_claude_token_rate_limited(cfg, user_id="u1", source="bogus")
    # Should not POST
    assert len(get_captured_requests()) == 0

async def test_report_claude_token_rate_limited_no_source_noop():
    from domains.spawn_browser_agent_v3.repo import report_claude_token_rate_limited

    cfg = _fake_config()
    await report_claude_token_rate_limited(cfg, user_id="u1", source=None)
    assert len(get_captured_requests()) == 0

async def test_report_claude_token_rate_limited_no_api_key_noop():
    from domains.spawn_browser_agent_v3.repo import report_claude_token_rate_limited

    cfg = _fake_config(backend_api_key="")
    await report_claude_token_rate_limited(cfg, user_id="u1", source="pool", pool_token_id="p1")
    assert len(get_captured_requests()) == 0

async def test_report_claude_token_rate_limited_swallows_network_error():
    from domains.spawn_browser_agent_v3.repo import report_claude_token_rate_limited
    from _test_utils import setup_mock_fn

    def fail(request):
        raise RuntimeError("nope")

    setup_mock_fn(fail)
    cfg = _fake_config()
    # Must not raise
    await report_claude_token_rate_limited(cfg, user_id="u1", source="user")

# ========================================
# repo: save_browser_action / assistant messages
# ========================================

async def test_save_browser_action_message_posts_metadata():
    from tools.base import MessageStatus
    from domains.spawn_browser_agent_v3.repo import save_browser_action_message

    setup_mock(
        {
            "/api/agents/": {"status": 200, "json": {"ok": True}},
        }
    )

    with patch("config.load_config", return_value=_fake_config()):
        accepted = await save_browser_action_message(
            agent_id="ag1",
            title="click",
            message="m",
            status=MessageStatus.IN_PROGRESS,
            task_id="t1",
            browser_url="https://example.com",
            action_type="click",
            tool_call_id="tc1",
            steps_taken=1,
            total_steps=30,
            output_schema={"fields": []},
        )

    assert accepted is True
    call = assert_captured_call(url_contains="/api/agents/ag1/messages", method="POST")
    body = json.loads(call["requestBody"])
    assert body["role"] == "TOOL"
    assert body["metadata"]["toolName"] == "spawn_browser_agent"
    assert body["metadata"]["subAgentId"] == "t1"
    assert body["metadata"]["steps_taken"] == 1
    assert body["metadata"]["total_steps"] == 30
    assert body["metadata"]["output_schema"] == {"fields": []}

async def test_save_browser_action_message_init_no_subagent():
    from tools.base import MessageStatus
    from domains.spawn_browser_agent_v3.repo import save_browser_action_message

    setup_mock({"/api/agents/": {"status": 200, "json": {"ok": True}}})

    with patch("config.load_config", return_value=_fake_config()):
        await save_browser_action_message(
            agent_id="ag1",
            title="init",
            message="",
            status=MessageStatus.IN_PROGRESS,
            task_id="t1",
            tool_call_id="tc1",
            is_init_message=True,
        )

    call = assert_captured_call(url_contains="/api/agents/ag1/messages")
    body = json.loads(call["requestBody"])
    assert "subAgentId" not in body["metadata"]

async def test_save_browser_action_message_error_sets_flag():
    from tools.base import MessageStatus
    from domains.spawn_browser_agent_v3.repo import save_browser_action_message

    setup_mock({"/api/agents/": {"status": 200, "json": {"ok": True}}})

    with patch("config.load_config", return_value=_fake_config()):
        await save_browser_action_message(
            agent_id="ag1",
            title="fail",
            message="err",
            status=MessageStatus.ERROR,
            task_id="t1",
        )

    body = json.loads(get_captured_requests()[0]["requestBody"])
    assert body["metadata"]["error"] is True

async def test_save_browser_action_message_swallows_exception():
    from tools.base import MessageStatus
    from domains.spawn_browser_agent_v3.repo import save_browser_action_message

    with patch(
        "config.load_config",
        side_effect=RuntimeError("cfg fail"),
    ):
        # Optional progress callers still do not raise, while required
        # provenance callers receive an explicit negative acknowledgement.
        accepted = await save_browser_action_message(
            agent_id="ag",
            title="t",
            message="m",
            status=MessageStatus.FINISHED,
            task_id="t1",
        )
    assert accepted is False

async def test_save_browser_action_message_rejects_non_2xx():
    from tools.base import MessageStatus
    from domains.spawn_browser_agent_v3.repo import save_browser_action_message

    setup_mock({"/api/agents/": {"status": 503, "json": {"error": "retry"}}})

    with patch("config.load_config", return_value=_fake_config()):
        accepted = await save_browser_action_message(
            agent_id="ag",
            title="t",
            message="m",
            status=MessageStatus.FINISHED,
            task_id="t1",
        )

    assert accepted is False

async def test_save_browser_action_message_rejects_redirect():
    from tools.base import MessageStatus
    from domains.spawn_browser_agent_v3.repo import save_browser_action_message

    setup_mock({"/api/agents/": {"status": 307, "headers": {"location": "/wrong-endpoint"}}})

    with patch("config.load_config", return_value=_fake_config()):
        accepted = await save_browser_action_message(
            agent_id="ag",
            title="t",
            message="m",
            status=MessageStatus.FINISHED,
            task_id="t1",
        )

    assert accepted is False

async def test_save_browser_action_message_tool_name_override():
    """Verifier feedback flows back as `attempt_completion` TOOL result (C5)."""
    from tools.base import MessageStatus
    from domains.spawn_browser_agent_v3.repo import save_browser_action_message

    setup_mock({"/api/agents/": {"status": 200, "json": {"ok": True}}})

    with patch("config.load_config", return_value=_fake_config()):
        await save_browser_action_message(
            agent_id="ag1",
            title="rejected",
            message="reasoning",
            status=MessageStatus.FINISHED,
            task_id="t1",
            tool_call_id="tc-verifier",
            tool_name_override="attempt_completion",
            extra_metadata={"verifierMessage": True},
        )

    body = json.loads(get_captured_requests()[0]["requestBody"])
    assert body["metadata"]["toolName"] == "attempt_completion"
    assert body["metadata"]["verifierMessage"] is True

async def test_save_browser_assistant_message():
    from domains.spawn_browser_agent_v3.repo import save_browser_assistant_message

    setup_mock({"/api/agents/": {"status": 200, "json": {"ok": True}}})

    with patch("config.load_config", return_value=_fake_config()):
        await save_browser_assistant_message(
            "ag1",
            "hello world",
            "task-1",
            stream_id="browser-stream-1",
        )

    body = json.loads(get_captured_requests()[0]["requestBody"])
    assert body["role"] == "ASSISTANT"
    assert body["metadata"]["subAgentId"] == "task-1"
    assert body["metadata"]["streamId"] == "browser-stream-1"

async def test_save_browser_assistant_message_swallows_exception():
    from domains.spawn_browser_agent_v3.repo import save_browser_assistant_message

    with patch(
        "config.load_config",
        side_effect=RuntimeError("nope"),
    ):
        await save_browser_assistant_message("ag1", "hi", "t1")

async def test_save_browser_credential_ref_message_user_role():
    from domains.spawn_browser_agent_v3.repo import save_browser_credential_ref_message

    setup_mock({"/api/agents/": {"status": 200, "json": {"ok": True}}})

    with patch("config.load_config", return_value=_fake_config()):
        saved = await save_browser_credential_ref_message(
            agent_id="ag1",
            task_id="task-1",
            message="OTP code",
            role="USER",
            credential_ref={"kind": "email_otp", "id": "msg1"},
            browser_url="https://kernel.example/live/session-1",
        )

    assert saved is True
    body = json.loads(get_captured_requests()[0]["requestBody"])
    assert body["role"] == "USER"
    assert body["metadata"]["subAgentId"] == "task-1"
    assert body["metadata"]["credential_ref"] == {"kind": "email_otp", "id": "msg1"}
    assert body["metadata"]["browser_url"] == "https://kernel.example/live/session-1"

async def test_save_browser_credential_ref_message_reports_backend_failure():
    from domains.spawn_browser_agent_v3.repo import save_browser_credential_ref_message

    setup_mock({"/api/agents/": {"status": 503, "json": {"error": "unavailable"}}})

    with patch("config.load_config", return_value=_fake_config()):
        saved = await save_browser_credential_ref_message(
            agent_id="ag1",
            task_id="task-1",
            message="Passkey used for authentication.",
            credential_ref={"kind": "passkey", "id": "passkey-row"},
        )

    assert saved is False

# ========================================
# repo: Steel files
# ========================================

async def test_list_session_files_no_api_key():
    from domains.spawn_browser_agent_v3 import repo

    setup_mock({"backend.example.com": {"status": 401, "json": {"error": "unauthorized"}}})
    assert await repo.list_session_files(_fake_config(backend_api_key=""), "s1") == []

async def test_list_session_files_success():
    from domains.spawn_browser_agent_v3 import repo

    setup_mock(
        {
            "backend.example.com/api/browser-session/s1/files/list": {
                "status": 200,
                "json": {"files": [{"path": "/f/x.pdf"}]},
            }
        }
    )
    files = await repo.list_session_files(_fake_config(), "s1")
    assert files == [{"path": "/f/x.pdf"}]

async def test_list_session_files_non_200():
    from domains.spawn_browser_agent_v3 import repo

    setup_mock({"backend.example.com": {"status": 500, "json": {"err": "x"}}})
    assert await repo.list_session_files(_fake_config(), "s1") == []

async def test_list_session_files_network_error():
    from domains.spawn_browser_agent_v3 import repo
    from _test_utils import setup_mock_fn

    def boom(req):
        raise RuntimeError("net")

    setup_mock_fn(boom)
    assert await repo.list_session_files(_fake_config(), "s1") == []

async def test_download_file_from_steel_no_api_key():
    from domains.spawn_browser_agent_v3 import repo

    setup_mock({"backend.example.com": {"status": 401, "text": "unauthorized"}})
    assert await repo.download_session_file(_fake_config(backend_api_key=""), "s1", "/files/x.pdf") is None

async def test_download_file_from_steel_strips_prefixes():
    from domains.spawn_browser_agent_v3 import repo

    captured = {}

    def handler(request):
        import httpx

        captured["url"] = str(request.url)
        return httpx.Response(200, content=b"PDFDATA", headers={"Content-Type": "application/pdf"})

    from _test_utils import setup_mock_fn

    setup_mock_fn(handler)
    out = await repo.download_session_file(_fake_config(), "s1", "/files/doc.pdf")

    assert out is not None
    assert out["content"] == b"PDFDATA"
    assert out["filename"] == "doc.pdf"
    assert out["mime_type"] == "application/pdf"
    assert "/api/browser-session/s1/files/content" in captured["url"]
    assert "path=%2Ffiles%2Fdoc.pdf" in captured["url"]

async def test_download_file_from_steel_strips_leading_slash():
    from domains.spawn_browser_agent_v3 import repo

    def handler(request):
        import httpx

        return httpx.Response(200, content=b"X")

    from _test_utils import setup_mock_fn

    setup_mock_fn(handler)
    out = await repo.download_session_file(_fake_config(), "s1", "/simple.txt")
    assert out is not None
    assert out["mime_type"] == "text/plain"

async def test_download_file_from_steel_non_200():
    from domains.spawn_browser_agent_v3 import repo

    setup_mock({"backend.example.com": {"status": 404, "text": "not found"}})
    assert await repo.download_session_file(_fake_config(), "s1", "x") is None

async def test_download_file_from_steel_network_error():
    from domains.spawn_browser_agent_v3 import repo
    from _test_utils import setup_mock_fn

    def boom(req):
        raise RuntimeError("fail")

    setup_mock_fn(boom)
    assert await repo.download_session_file(_fake_config(), "s1", "x") is None

async def test_take_steel_computer_screenshot_success():
    from domains.spawn_browser_agent_v3 import repo

    setup_mock(
        {
            "backend.example.com/api/browser-session/s1/screenshot": {
                "status": 200,
                "json": {
                    "provider": "kernel",
                    "base64_image": "abc123",
                },
            }
        }
    )
    out = await repo.take_browser_computer_screenshot(_fake_config(), "s1")
    assert out["base64_image"] == "abc123"
    assert_captured_call(
        0,
        url_contains="backend.example.com/api/browser-session/s1/screenshot",
        method="POST",
        header_present="x-api-key",
    )

async def test_take_steel_computer_screenshot_missing_image_raises():
    from domains.spawn_browser_agent_v3 import repo

    setup_mock(
        {
            "backend.example.com/api/browser-session/s1/screenshot": {
                "status": 200,
                "json": {
                    "output": "Screenshot taken successfully",
                    "provider": "kernel",
                },
            }
        }
    )
    try:
        await repo.take_browser_computer_screenshot(_fake_config(), "s1")
    except RuntimeError as exc:
        assert "did not return an image" in str(exc)
    else:
        raise AssertionError("expected missing base64_image to raise")

# ========================================
# repo: browser session init / fetch / close / upload
# ========================================

async def test_init_browser_session_success():
    from domains.spawn_browser_agent_v3.repo import init_browser_session

    setup_mock(
        {
            "/api/browser-session/init": {
                "status": 200,
                "json": {
                    "session_id": "s",
                    "task_id": "t",
                    "debug_url": "d",
                    "ws_url": "w",
                },
            }
        }
    )
    cfg = _fake_config()
    out = await init_browser_session(cfg, "u", "a", "https://x.com")
    assert out["session_id"] == "s"

async def test_init_browser_session_rate_limited():
    from domains.spawn_browser_agent_v3.repo import init_browser_session

    setup_mock({"/api/browser-session/init": {"status": 429, "json": {}}})
    cfg = _fake_config()
    out = await init_browser_session(cfg, "u", "a", "")
    assert out["rate_limited"] is True
    assert out["status_code"] == 429

async def test_init_browser_session_transient_failure_returns_retryable():
    """A provider infra hiccup (5xx, or the Kernel `400 Proxy is marked
    unavailable` health-check error) is classified retryable-transient so the
    init loop reallocates a fresh proxy instead of failing the browser run."""
    from domains.spawn_browser_agent_v3.repo import init_browser_session

    setup_mock({"/api/browser-session/init": {"status": 500, "text": "oops"}})
    cfg = _fake_config()
    out = await init_browser_session(cfg, "u", "a", "")
    assert out["transient_init_failure"] is True
    assert out["status_code"] == 500

    setup_mock(
        {
            "/api/browser-session/init": {
                "status": 400,
                "text": '{"error":"400 Proxy is marked unavailable from the last health check"}',
            }
        }
    )
    out = await init_browser_session(cfg, "u", "a", "")
    assert out["transient_init_failure"] is True
    assert out["status_code"] == 400

async def test_init_browser_session_error_raises():
    from domains.spawn_browser_agent_v3.repo import init_browser_session

    # A genuine bad request (not an infra hiccup) stays fatal — not masked by retries.
    setup_mock({"/api/browser-session/init": {"status": 400, "text": "invalid start_url"}})
    cfg = _fake_config()
    try:
        await init_browser_session(cfg, "u", "a", "")
        raise AssertionError("should raise")
    except Exception as e:
        assert "Failed to init session" in str(e)

async def test_fetch_session_info_success():
    from domains.spawn_browser_agent_v3.repo import fetch_session_info

    setup_mock(
        {
            "/api/browser-session/task/t1": {
                "status": 200,
                "json": {"session_id": "s1", "debug_url": "d", "ws_url": "w"},
            }
        }
    )
    cfg = _fake_config()
    out = await fetch_session_info(cfg, "t1")
    assert out["session_id"] == "s1"

async def test_fetch_session_info_validate_live_sets_query_param():
    from domains.spawn_browser_agent_v3.repo import fetch_session_info

    setup_mock(
        {
            "/api/browser-session/task/t1": {
                "status": 200,
                "json": {
                    "session_id": "s1",
                    "debug_url": "d",
                    "ws_url": "w",
                    "same_session_available": True,
                },
            }
        }
    )
    cfg = _fake_config()
    out = await fetch_session_info(cfg, "t1", validate_live=True)
    assert out["same_session_available"] is True
    call = assert_captured_call(url_contains="/api/browser-session/task/t1", method="GET")
    assert "validateLive=true" in call["url"]

async def test_fetch_session_info_error_raises():
    from domains.spawn_browser_agent_v3.repo import fetch_session_info

    setup_mock({"/api/browser-session/task/t1": {"status": 500, "json": {}}})
    cfg = _fake_config()
    try:
        await fetch_session_info(cfg, "t1")
        raise AssertionError("should raise")
    except RuntimeError as e:
        assert "Failed to fetch session info" in str(e)

async def test_resume_browser_session_posts_resume_endpoint():
    from domains.spawn_browser_agent_v3.repo import resume_browser_session

    setup_mock(
        {
            "/api/browser-session/resume": {
                "status": 200,
                "json": {"session_id": "s2", "debug_url": "d2", "ws_url": "w2"},
            }
        }
    )
    cfg = _fake_config()
    out = await resume_browser_session(cfg, "t1")
    assert out["session_id"] == "s2"
    call = assert_captured_call(url_contains="/api/browser-session/resume", method="POST")
    assert call["method"] == "POST"
    assert json.loads(call["requestBody"]) == {"task_id": "t1", "force_fresh_profile": False}

    setup_mock(
        {
            "/api/browser-session/resume": {
                "status": 200,
                "json": {"session_id": "s3", "debug_url": "d3", "ws_url": "w3"},
            }
        }
    )
    await resume_browser_session(cfg, "t1", force_fresh_profile=True)
    forced_call = assert_captured_call(index=1, url_contains="/api/browser-session/resume", method="POST")
    assert json.loads(forced_call["requestBody"]) == {"task_id": "t1", "force_fresh_profile": True}

async def test_resume_browser_session_rate_limited():
    from domains.spawn_browser_agent_v3.repo import resume_browser_session

    setup_mock(
        {
            "/api/browser-session/resume": {
                "status": 429,
                "json": {"error": "steel_rate_limit"},
            }
        }
    )
    cfg = _fake_config()
    out = await resume_browser_session(cfg, "t1")
    assert out["rate_limited"] is True

async def test_recover_browser_challenge_posts_current_url_and_state():
    from domains.spawn_browser_agent_v3.repo import recover_browser_challenge

    storage_state = {
        "cookies": [{"name": "session", "value": "secret", "domain": ".example.com"}],
        "origins": [{"origin": "https://example.com", "localStorage": []}],
    }

    setup_mock(
        {
            "/api/browser-session/recover-challenge": {
                "status": 200,
                "json": {
                    "session_id": "steel-1",
                    "ws_url": "wss://steel-1",
                    "recovery_action": "config_selected",
                },
            }
        }
    )
    out = await recover_browser_challenge(
        _fake_config(),
        "t1",
        "https://example.com/current",
        storage_state,
        user_agent="test-agent",
        blocked_resource_url="https://js.stripe.com/v3",
        require_payment_cdn=True,
    )
    assert out["recovery_action"] == "config_selected"
    call = assert_captured_call(
        url_contains="/api/browser-session/recover-challenge",
        method="POST",
    )
    assert json.loads(call["requestBody"]) == {
        "task_id": "t1",
        "current_url": "https://example.com/current",
        "storage_state": storage_state,
        "user_agent": "test-agent",
        "blocked_resource_url": "https://js.stripe.com/v3",
        "require_payment_cdn": True,
    }

async def test_rotation_storage_state_survives_provider_switch():
    from domains.spawn_browser_agent_v3.handler import (
        _capture_rotation_storage_state,
        _restore_rotation_storage_state,
    )

    storage_state = {
        "cookies": [
            {
                "name": "session",
                "value": "secret",
                "domain": ".example.com",
                "path": "/",
                "expires": -1,
                "httpOnly": True,
                "secure": True,
                "sameSite": "Lax",
            }
        ],
        "origins": [
            {
                "origin": "https://example.com",
                "localStorage": [{"name": "checkout", "value": "ready"}],
            }
        ],
    }
    old_context = SimpleNamespace(storage_state=AsyncMock(return_value=storage_state))
    old_page = SimpleNamespace(context=old_context)
    captured = await _capture_rotation_storage_state(old_page)
    old_context.storage_state.assert_awaited_once_with(indexed_db=True)

    new_context = SimpleNamespace(add_cookies=AsyncMock(), add_init_script=AsyncMock())
    new_page = SimpleNamespace(
        context=new_context,
        url="https://example.com/current",
        evaluate=AsyncMock(),
        goto=AsyncMock(),
    )
    await _restore_rotation_storage_state(
        new_page,
        captured,
        current_url="https://example.com/current",
    )
    new_context.add_cookies.assert_awaited_once_with(storage_state["cookies"])
    new_context.add_init_script.assert_awaited_once()
    new_page.evaluate.assert_awaited_once()
    new_page.goto.assert_awaited_once_with(
        "https://example.com/current",
        wait_until="domcontentloaded",
        timeout=15_000,
    )

async def test_rotation_storage_capture_is_bounded_when_indexeddb_stalls():
    """Challenge recovery must regain control if Playwright storage capture stalls."""
    from domains.spawn_browser_agent_v3.handler import (
        BrowserStorageCaptureTimeoutError,
        _capture_rotation_storage_state,
        _rotation_storage_capture_timeout_seconds,
    )

    assert _rotation_storage_capture_timeout_seconds(float("inf")) == 15.0
    assert _rotation_storage_capture_timeout_seconds("1e999") == 15.0
    assert _rotation_storage_capture_timeout_seconds(600) == 60.0

    previous_timeout = os.environ.get("BROWSER_ROTATION_STORAGE_CAPTURE_TIMEOUT_SECONDS")

    async def stalled_storage_state(*, indexed_db):
        assert indexed_db is True
        await asyncio.Event().wait()

    context = SimpleNamespace(storage_state=stalled_storage_state)
    page = SimpleNamespace(context=context)
    os.environ["BROWSER_ROTATION_STORAGE_CAPTURE_TIMEOUT_SECONDS"] = "0.01"
    try:
        try:
            await asyncio.wait_for(
                _capture_rotation_storage_state(page),
                timeout=1.0,
            )
        except BrowserStorageCaptureTimeoutError as exc:
            assert "timed out after 0.01s" in str(exc)
        else:
            raise AssertionError("expected a typed bounded storage-capture timeout")
    finally:
        if previous_timeout is None:
            os.environ.pop("BROWSER_ROTATION_STORAGE_CAPTURE_TIMEOUT_SECONDS", None)
        else:
            os.environ["BROWSER_ROTATION_STORAGE_CAPTURE_TIMEOUT_SECONDS"] = previous_timeout

async def test_recovery_storage_timeout_finishes_error_and_returns_control_to_model_loop():
    """The factored recovery path persists timeout evidence and closes the tool as ERROR."""
    from domains.spawn_browser_agent_v3.handler import (
        BrowserStorageCaptureTimeoutError,
        _capture_recovery_storage_state,
        _finalize_browser_recovery_action_result,
    )

    previous_timeout = os.environ.get("BROWSER_ROTATION_STORAGE_CAPTURE_TIMEOUT_SECONDS")

    async def stalled_storage_state(*, indexed_db):
        assert indexed_db is True
        await asyncio.Event().wait()

    progress = AsyncMock()
    action_history = SimpleNamespace(record_action=AsyncMock())
    browser_stream = SimpleNamespace(finish_tools=AsyncMock())
    browser_turn_messages = []
    dom_service = SimpleNamespace()
    unified_action = {
        "action": "recover_from_challenge",
        "thinking": "recover safely",
        "params": {"reason": "DataDome challenge"},
    }
    page = SimpleNamespace(context=SimpleNamespace(storage_state=stalled_storage_state))
    os.environ["BROWSER_ROTATION_STORAGE_CAPTURE_TIMEOUT_SECONDS"] = "0.01"
    try:
        try:
            await _capture_recovery_storage_state(page, progress)
        except BrowserStorageCaptureTimeoutError as exc:
            action_result = {"success": False, "error": str(exc)}
        else:
            raise AssertionError("expected storage capture timeout")

        await _finalize_browser_recovery_action_result(
            action_result=action_result,
            dom_service=dom_service,
            action_history=action_history,
            thinking="recover safely",
            recovery_reason="DataDome challenge",
            browser_turn_messages=browser_turn_messages,
            task_prompt="Book a hotel",
            browser_state={"url": "https://expedia.com/login"},
            unified_action=unified_action,
            recovery_call_id="recovery-call-1",
            browser_stream=browser_stream,
        )
    finally:
        if previous_timeout is None:
            os.environ.pop("BROWSER_ROTATION_STORAGE_CAPTURE_TIMEOUT_SECONDS", None)
        else:
            os.environ["BROWSER_ROTATION_STORAGE_CAPTURE_TIMEOUT_SECONDS"] = previous_timeout

    progress.assert_awaited_once_with(
        "capture_browser_state",
        "Capturing cookies, local storage, and IndexedDB before challenge recovery",
    )
    recorded = action_history.record_action.await_args.kwargs["result"]
    assert recorded["success"] is False
    assert "timed out after 0.01s" in recorded["error"]
    browser_stream.finish_tools.assert_awaited_once_with(status="ERROR")
    assert browser_turn_messages[-1]["role"] == "tool"
    assert "timed out after 0.01s" in browser_turn_messages[-1]["content"]

async def test_preloaded_restore_helper_skips_same_host_goto_and_cookie_rewrite():
    """Helper still supports restore_cookies=False for non-recovery callers."""
    from domains.spawn_browser_agent_v3.handler import _restore_rotation_storage_state

    captured = {
        "cookies": [
            {
                "name": "cf_clearance",
                "value": "stale-before-solver",
                "domain": ".order.online",
                "path": "/",
            }
        ],
        "origins": [
            {
                "origin": "https://order.online",
                "localStorage": [{"name": "authState", "value": "keep"}],
                "indexedDB": [],
            }
        ],
    }
    context = SimpleNamespace(add_cookies=AsyncMock(), add_init_script=AsyncMock())
    page = SimpleNamespace(
        context=context,
        evaluate=AsyncMock(),
        goto=AsyncMock(),
        url="https://order.online/store/blue-bottle",
    )

    await _restore_rotation_storage_state(
        page,
        captured,
        current_url="https://order.online/store/blue-bottle",
        restore_cookies=False,
    )

    context.add_cookies.assert_not_awaited()
    context.add_init_script.assert_awaited_once()
    page.goto.assert_not_awaited()
    page.evaluate.assert_awaited_once()


async def test_preloaded_restore_helper_navigates_with_probe_timeout_when_host_differs():
    from domains.spawn_browser_agent_v3.handler import _restore_rotation_storage_state

    context = SimpleNamespace(add_cookies=AsyncMock(), add_init_script=AsyncMock())
    page = SimpleNamespace(
        context=context,
        evaluate=AsyncMock(),
        goto=AsyncMock(),
        url="about:blank",
    )
    await _restore_rotation_storage_state(
        page,
        {"cookies": [], "origins": []},
        current_url="https://order.online/store/blue-bottle",
        restore_cookies=False,
    )
    page.goto.assert_awaited_once_with(
        "https://order.online/store/blue-bottle",
        wait_until="domcontentloaded",
        timeout=45_000,
    )


def test_recovery_requires_live_tab_verify_before_success():
    """Promoted configs must re-verify the live tab before claiming recovery success."""
    import inspect

    from domains.spawn_browser_agent_v3 import handler

    source = inspect.getsource(handler._spawn_browser_agent_activity_v3_real)
    start = source.index('if action_name == "recover_from_challenge":')
    end = source.index('if action_name == "send_message_to_user":', start)
    recovery_block = source[start:end]

    preloaded_guard = recovery_block.index('storage_state_preloaded')
    restore_offset = recovery_block.index("await _restore_rotation_storage_state(")
    verify_offset = recovery_block.index("await verify_live_page_cleared_challenge(")
    success_offset = recovery_block.index('title="Browser challenge recovered"')
    assert preloaded_guard < restore_offset < verify_offset < success_offset
    assert "passed candidate probes but the live tab" in recovery_block
    assert "is still challenged" in recovery_block
    assert "configKey" in recovery_block
    # Preloaded winners must not rewrite challenged origin state onto the clean session.
    assert "if not bool(config_result.get(\"storage_state_preloaded\")):" in recovery_block


def test_recovery_restore_failure_is_not_suppressed():
    """A non-preloaded replacement session must restore state without suppress()."""
    import inspect

    from domains.spawn_browser_agent_v3 import handler

    source = textwrap.dedent(inspect.getsource(handler._spawn_browser_agent_activity_v3_real))
    tree = ast.parse(source)
    parents = {}
    restore_awaits = []

    for parent in ast.walk(tree):
        for child in ast.iter_child_nodes(parent):
            parents[child] = parent
        if (
            isinstance(parent, ast.Await)
            and isinstance(parent.value, ast.Call)
            and isinstance(parent.value.func, ast.Name)
            and parent.value.func.id == "_restore_rotation_storage_state"
        ):
            restore_awaits.append(parent)

    assert len(restore_awaits) == 1
    restore_await = restore_awaits[0]
    restore_call = restore_await.value
    restore_keywords = {keyword.arg: keyword.value for keyword in restore_call.keywords}
    assert restore_keywords.get("restore_cookies") is not None
    assert ast.unparse(restore_keywords["restore_cookies"]) in {"True", "true"}

    ancestor = parents.get(restore_await)
    while ancestor is not None:
        if isinstance(ancestor, (ast.With, ast.AsyncWith)):
            assert all("contextlib.suppress" not in ast.unparse(item.context_expr) for item in ancestor.items)
        ancestor = parents.get(ancestor)

def test_recovery_preflight_failures_resolve_the_in_progress_tool():
    """Missing live browser state must take the normal recovery error path."""
    import inspect

    from domains.spawn_browser_agent_v3 import handler

    source = inspect.getsource(handler._spawn_browser_agent_activity_v3_real)
    start = source.index('if action_name == "recover_from_challenge":')
    end = source.index('if action_name == "send_message_to_user":', start)
    recovery_block = source[start:end]

    # Clean-page skip may finalize early; measure the full recovery try/except path
    # after that optional short-circuit.
    capture_offset = recovery_block.index("await _capture_recovery_storage_state(")
    try_offset = recovery_block.rfind("try:", 0, capture_offset)
    guard_offset = recovery_block.index(
        "if playwright_browser is None or input_page is None:", try_offset
    )
    except_offset = recovery_block.index("except Exception as exc:", capture_offset)
    finish_offset = recovery_block.index(
        "await _finalize_browser_recovery_action_result(", except_offset
    )

    assert try_offset < guard_offset < capture_offset < except_offset < finish_offset
    assert 'action_result = {"success": False, "error": error_message}' in recovery_block
    assert recovery_block.count("tool_call_id=recovery_call_id") >= 2

def test_recovery_reconnect_failure_drops_disconnected_browser_handles():
    """A failed promoted-session attach must preserve its real error result."""
    import inspect

    from domains.spawn_browser_agent_v3 import handler

    source = inspect.getsource(handler._spawn_browser_agent_activity_v3_real)
    recovery_block = source.split('if action_name == "recover_from_challenge":', 1)[1].split(
        'if action_name == "send_message_to_user":', 1
    )[0]
    reconnect = recovery_block.index("reconnected = await _reconnect_browser_stack_after_rotation(")
    close_humanizer = recovery_block.index("await humanizer.close()", reconnect)
    clear_humanizer = recovery_block.index("humanizer = None", close_humanizer)
    clear_handles = recovery_block.index("dom_service = None", reconnect)
    preserve_error = recovery_block.index("error_message = extract_error_message(exc)", clear_handles)
    finalize = recovery_block.index("await _finalize_browser_recovery_action_result(", preserve_error)

    assert reconnect < close_humanizer < clear_humanizer < clear_handles
    assert clear_handles < preserve_error < finalize
    disconnected_slice = recovery_block[clear_handles:preserve_error]
    for handle in (
        "dom_service",
        "dom_page",
        "input_page",
        "playwright_browser",
        "playwright_instance",
        "playwright_driver_pid",
    ):
        assert f"{handle} = None" in disconnected_slice

    finalizer_source = inspect.getsource(handler._finalize_browser_recovery_action_result)
    history_guard = finalizer_source.index("if dom_service is not None:")
    append_turn = finalizer_source.index("_append_browser_turn_messages(", history_guard)
    finish_tool = finalizer_source.index("await browser_stream.finish_tools(", append_turn)
    assert history_guard < append_turn < finish_tool

def test_passkeys_reseed_on_target_reset_like_cookies_and_localstorage():
    """A target reset (proxy rotation) must re-seed passkeys, not just storage.

    The CDP virtual authenticator is scoped to the live target: rotation attaches
    a fresh, empty authenticator. Passkeys must be restored on that new target the
    same way cookies/localStorage are, through the single seeding helper — so the
    passkey surface can never again be the one injected state silently lost on
    reset (H-04). All passkey seeding must funnel through one choke point (no
    duplicated `inject_passkeys` call sites).
    """
    import inspect

    from domains.spawn_browser_agent_v3 import handler

    source = inspect.getsource(handler._spawn_browser_agent_activity_v3_real)

    # 1. A single seeding choke point exists, backed by a retained union of every
    #    passkey ever seeded (so a fresh authenticator can be fully restored).
    assert "async def sync_passkeys_onto_target(" in source
    assert "seeded_decrypted_passkeys_by_credential_id" in source

    # 2. No seeding happens outside the helper — the only inject_passkeys call in
    #    the whole activity is the one inside sync_passkeys_onto_target.
    assert source.count("dom_service.inject_passkeys(") == 1
    helper_start = source.index("async def sync_passkeys_onto_target(")
    assert source.index("dom_service.inject_passkeys(") > helper_start

    # 3. Bootstrap and realm transitions seed through the helper.
    assert 'context="session start"' in source
    assert "realm transition to " in source

    # 4. The rotation recovery path re-seeds the held passkeys AFTER restoring the
    #    cookie/localStorage state — parity with the storage restore.
    recovery_block = source.split('if action_name == "recover_from_challenge":', 1)[1].split(
        'if action_name == "send_message_to_user":', 1
    )[0]
    restore_storage = recovery_block.index("await _restore_rotation_storage_state(")
    reseed_passkeys = recovery_block.index('sync_passkeys_onto_target(context="after proxy rotation")')
    assert restore_storage < reseed_passkeys


def test_passkeys_are_revalidated_after_start_navigation():
    """Start navigation may replace the CDP WebAuthn environment before first use."""
    import inspect

    from domains.spawn_browser_agent_v3 import handler

    source = inspect.getsource(handler._spawn_browser_agent_activity_v3_real)
    navigated = source.index("Auto-navigated to start URL")
    main_loop = source.index("# ===== MAIN AGENT LOOP =====")
    revalidate = source.index('sync_passkeys_onto_target(context="after start navigation")')

    assert navigated < revalidate < main_loop


def test_passkeys_are_revalidated_before_each_usage_readback():
    """Any navigation-capable action may reset WebAuthn before the next poll."""
    import inspect

    from domains.spawn_browser_agent_v3 import handler

    source = inspect.getsource(handler._spawn_browser_agent_activity_v3_real)
    helper_start = source.index("async def record_passkey_usage_once()")
    helper_end = source.index("async def sync_passkeys_onto_target(", helper_start)
    helper = source[helper_start:helper_end]

    revalidate = helper.index(
        'await sync_passkeys_onto_target(context="before passkey usage readback")'
    )
    readback = helper.index("await record_used_passkey_credentials(")

    assert revalidate < readback


async def test_provider_handoff_replaces_humanizer_without_leaking_idle_work():
    from domains.spawn_browser_agent_v3.handler import _replace_browser_humanizer

    events = []
    observer = object()

    class OldHumanizer:
        async def close(self):
            events.append("close-old")

    class NewHumanizer:
        async def initialize_cursor(self, *, start_pos):
            events.append(("initialize-new", start_pos))

        def set_cursor_observer(self, value):
            assert value is observer
            events.append("bind-observer")

        def start_idle_movement(self):
            events.append("start-idle")

    new_humanizer = NewHumanizer()

    def factory(*, dom_page, input_page, fast):
        assert dom_page == "new-dom"
        assert input_page == "new-input"
        assert fast is False
        events.append("construct-new")
        return new_humanizer

    result = await _replace_browser_humanizer(
        current_humanizer=OldHumanizer(),
        enabled=True,
        dom_page="new-dom",
        input_page="new-input",
        cursor_observer=observer,
        humanizer_factory=factory,
    )

    assert result is new_humanizer
    assert events == [
        "close-old",
        "construct-new",
        ("initialize-new", (640, 400)),
        "bind-observer",
        "start-idle",
    ]

async def test_provider_handoff_closes_humanizer_even_when_disabled():
    from domains.spawn_browser_agent_v3.handler import _replace_browser_humanizer

    old_humanizer = SimpleNamespace(close=AsyncMock())
    result = await _replace_browser_humanizer(
        current_humanizer=old_humanizer,
        enabled=False,
        dom_page=None,
        input_page=None,
        cursor_observer=None,
        humanizer_factory=lambda **_kwargs: (_ for _ in ()).throw(AssertionError("must not construct")),
    )

    assert result is None
    old_humanizer.close.assert_awaited_once()

async def test_failed_replacement_stack_cleanup_keeps_remote_session_open():
    from domains.spawn_browser_agent_v3.handler import _discard_replacement_browser_stack

    humanizer = SimpleNamespace(close=AsyncMock())
    dom_service = SimpleNamespace(disconnect=AsyncMock())
    stop_mock = AsyncMock()
    browser = SimpleNamespace()
    playwright = SimpleNamespace()

    with patch("domains.spawn_browser_agent_v3.handler._stop_playwright_resources", stop_mock):
        await _discard_replacement_browser_stack(
            humanizer=humanizer,
            dom_service=dom_service,
            playwright_browser=browser,
            playwright_instance=playwright,
            playwright_driver_pid=123,
            agent_id="agent-1",
        )

    humanizer.close.assert_awaited_once()
    dom_service.disconnect.assert_awaited_once()
    stop_mock.assert_awaited_once_with(
        browser,
        playwright,
        "agent-1",
        close_browser=False,
        driver_pid=123,
    )

async def test_provider_reconnect_cleans_partial_new_stack_on_focus_failure():
    from domains.spawn_browser_agent_v3.handler import _reconnect_browser_stack_after_rotation

    old_dom = SimpleNamespace(disconnect=AsyncMock())
    old_browser = SimpleNamespace()
    old_playwright = SimpleNamespace()

    class _NewDom:
        last_instance = None

        def __init__(self, cdp_url):
            self.cdp_url = cdp_url
            self.connect = AsyncMock()
            self.disconnect = AsyncMock()
            self.session = SimpleNamespace(get_current_page=AsyncMock(return_value=SimpleNamespace()))
            _NewDom.last_instance = self

    page = SimpleNamespace()
    new_browser = SimpleNamespace(contexts=[SimpleNamespace(pages=[page])])
    new_playwright = SimpleNamespace(
        chromium=SimpleNamespace(connect_over_cdp=AsyncMock(return_value=new_browser))
    )
    async_playwright_factory = MagicMock(
        return_value=SimpleNamespace(start=AsyncMock(return_value=new_playwright))
    )
    stop_mock = AsyncMock()

    with (
        patch("browser_tools.dom_service.DOMService", _NewDom),
        patch("playwright.async_api.async_playwright", async_playwright_factory),
        patch(
            "domains.spawn_browser_agent_v3.handler._synchronize_playwright_page_with_agent_focus",
            AsyncMock(side_effect=RuntimeError("focus sync failed")),
        ),
        patch("domains.spawn_browser_agent_v3.handler._stop_playwright_resources", stop_mock),
    ):
        try:
            await _reconnect_browser_stack_after_rotation(
                new_cdp_url="ws://replacement",
                old_dom_service=old_dom,
                old_playwright_browser=old_browser,
                old_playwright_instance=old_playwright,
                old_driver_pid=11,
                fingerprint_injection=None,
                agent_id="agent-1",
            )
        except RuntimeError as exc:
            assert "focus sync failed" in str(exc)
        else:
            raise AssertionError("expected focus synchronization failure")

    old_dom.disconnect.assert_awaited_once()
    assert stop_mock.await_count == 2
    stop_mock.assert_any_await(old_browser, old_playwright, "agent-1", driver_pid=11)
    stop_mock.assert_any_await(
        new_browser,
        new_playwright,
        "agent-1",
        close_browser=False,
        driver_pid=None,
    )
    assert _NewDom.last_instance is not None
    _NewDom.last_instance.disconnect.assert_awaited_once()

async def test_rotation_storage_state_round_trips_in_real_browser():
    """Cookies, localStorage, and IndexedDB survive a real context replacement."""
    from playwright.async_api import async_playwright

    from domains.spawn_browser_agent_v3.handler import (
        _capture_rotation_storage_state,
        _restore_rotation_storage_state,
    )

    url = "http://storage-rotation.test/"

    async def serve_page(route):
        await route.fulfill(
            status=200,
            content_type="text/html",
            body="<!doctype html><title>rotation storage</title>",
        )

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        try:
            old_context = await browser.new_context()
            old_page = await old_context.new_page()
            await old_page.route("**/*", serve_page)
            await old_page.goto(url)
            await old_context.add_cookies(
                [
                    {
                        "name": "session",
                        "value": "cookie-secret",
                        "url": url,
                        "httpOnly": True,
                        "sameSite": "Lax",
                    }
                ]
            )
            await old_page.evaluate("localStorage.setItem('checkout', 'ready')")
            await old_page.evaluate(
                """async () => {
                  await new Promise((resolve, reject) => {
                    const request = indexedDB.open('auth-db', 1);
                    request.onupgradeneeded = () => {
                      request.result.createObjectStore('sessions', {keyPath: 'id'});
                    };
                    request.onerror = () => reject(request.error);
                    request.onsuccess = () => {
                      const db = request.result;
                      const tx = db.transaction('sessions', 'readwrite');
                      tx.objectStore('sessions').put({id: 'primary', token: 'idb-secret'});
                      tx.oncomplete = () => { db.close(); resolve(); };
                      tx.onerror = () => reject(tx.error);
                    };
                  });
                }"""
            )

            captured = await _capture_rotation_storage_state(old_page)
            assert captured is not None
            origin = next(item for item in captured["origins"] if item["origin"] == url.rstrip("/"))
            assert origin["localStorage"] == [{"name": "checkout", "value": "ready"}]
            assert origin["indexedDB"][0]["name"] == "auth-db"

            new_context = await browser.new_context()
            new_page = await new_context.new_page()
            await new_page.route("**/*", serve_page)
            await new_page.goto(url)
            await new_page.evaluate("localStorage.setItem('stale-key', 'must-be-removed')")
            await _restore_rotation_storage_state(new_page, captured, current_url=url)

            cookies = await new_context.cookies(url)
            assert any(cookie["name"] == "session" and cookie["value"] == "cookie-secret" for cookie in cookies)
            assert await new_page.evaluate("localStorage.getItem('checkout')") == "ready"
            assert await new_page.evaluate("localStorage.getItem('stale-key')") is None
            indexed_db_token = await new_page.evaluate(
                """async () => await new Promise((resolve, reject) => {
                  const request = indexedDB.open('auth-db');
                  request.onerror = () => reject(request.error);
                  request.onsuccess = () => {
                    const db = request.result;
                    const tx = db.transaction('sessions', 'readonly');
                    const get = tx.objectStore('sessions').get('primary');
                    get.onsuccess = () => { db.close(); resolve(get.result?.token); };
                    get.onerror = () => { db.close(); reject(get.error); };
                  };
                })"""
            )
            assert indexed_db_token == "idb-secret"

            await new_page.evaluate("localStorage.setItem('checkout', 'site-updated')")
            await new_page.evaluate(
                """async () => await new Promise((resolve, reject) => {
                  const request = indexedDB.open('auth-db');
                  request.onerror = () => reject(request.error);
                  request.onsuccess = () => {
                    const db = request.result;
                    const tx = db.transaction('sessions', 'readwrite');
                    tx.objectStore('sessions').put({id: 'primary', token: 'site-updated'});
                    tx.oncomplete = () => { db.close(); resolve(); };
                    tx.onerror = () => { db.close(); reject(tx.error); };
                  };
                })"""
            )
            await new_page.reload(wait_until="domcontentloaded")
            assert await new_page.evaluate("localStorage.getItem('checkout')") == "site-updated"
            reloaded_token = await new_page.evaluate(
                """async () => await new Promise((resolve, reject) => {
                  const request = indexedDB.open('auth-db');
                  request.onerror = () => reject(request.error);
                  request.onsuccess = () => {
                    const db = request.result;
                    const tx = db.transaction('sessions', 'readonly');
                    const get = tx.objectStore('sessions').get('primary');
                    get.onsuccess = () => { db.close(); resolve(get.result?.token); };
                    get.onerror = () => { db.close(); reject(get.error); };
                  };
                })"""
            )
            assert reloaded_token == "site-updated"
            await new_context.close()
            await old_context.close()
        finally:
            await browser.close()

def test_rotation_session_metadata_tracks_provider_switch():
    from domains.spawn_browser_agent_v3.handler import _updated_rotation_session_metadata

    updated = _updated_rotation_session_metadata(
        {"provider": "kernel", "profile_id": "kernel-profile"},
        {
            "browser_session_metadata": {
                "provider": "steel",
                "profile_id": "steel-profile",
                "steel_profile_id": "steel-profile",
            }
        },
    )
    assert updated["provider"] == "steel"
    assert updated["profile_id"] == "steel-profile"
    assert updated["steel_profile_id"] == "steel-profile"

async def test_fetch_auth_options_success():
    from domains.spawn_browser_agent_v3.repo import fetch_auth_options

    setup_mock(
        {
            "/api/auth-options": {
                "status": 200,
                "json": {"realm": "example.com", "passwords": []},
            }
        }
    )
    cfg = _fake_config()
    out = await fetch_auth_options(cfg, "u1", "example.com")
    assert out["realm"] == "example.com"
    call = assert_captured_call(url_contains="/api/auth-options", method="GET")
    assert "realm=example.com" in call["url"]
    assert call["requestHeaders"]["x-user-id"] == "u1"

async def test_fetch_auth_options_error_raises():
    from domains.spawn_browser_agent_v3.repo import fetch_auth_options

    setup_mock({"/api/auth-options": {"status": 500, "text": "bad"}})
    cfg = _fake_config()
    try:
        await fetch_auth_options(cfg, "u1", "example.com")
        raise AssertionError("should raise")
    except RuntimeError as e:
        assert "Failed to fetch auth options" in str(e)

async def test_mark_steel_session_auth_failed_posts_reason():
    from domains.spawn_browser_agent_v3.repo import mark_steel_session_auth_failed

    setup_mock(
        {
            "/api/auth-options/steel-sessions/steel-auth-1/auth-failed": {
                "status": 200,
                "json": {"ok": True},
            }
        }
    )
    cfg = _fake_config()
    out = await mark_steel_session_auth_failed(cfg, "u1", "steel-auth-1", "login page displayed")
    assert out["ok"] is True
    call = assert_captured_call(
        url_contains="/api/auth-options/steel-sessions/steel-auth-1/auth-failed",
        method="POST",
    )
    body = json.loads(call["requestBody"])
    assert body == {"reason": "login page displayed"}

async def test_create_user_auth_assistance_request_posts_payload():
    from domains.spawn_browser_agent_v3.repo import create_user_auth_assistance_request

    setup_mock(
        {
            "/api/auth-assistance": {
                "status": 201,
                "json": {
                    "request": {"id": "uar1"},
                    "handoff": {"liveViewUrl": "https://steel/live"},
                },
            }
        }
    )
    cfg = _fake_config()
    out = await create_user_auth_assistance_request(
        cfg,
        agent_id="ag1",
        user_id="u1",
        auth_realm="example.com",
        browser_session_id="task1",
        steel_session_id="steel1",
        browser_url="https://steel/live",
        current_url="https://example.com/login",
    )
    assert out["request"]["id"] == "uar1"
    call = assert_captured_call(url_contains="/api/auth-assistance", method="POST")
    body = json.loads(call["requestBody"])
    assert body["authRealm"] == "example.com"
    assert body["browserSessionId"] == "task1"
    assert body["steelSessionId"] == "steel1"

async def test_close_browser_session_swallows_errors():
    from domains.spawn_browser_agent_v3.repo import close_browser_session
    from _test_utils import setup_mock_fn

    def fail(req):
        raise RuntimeError("down")

    setup_mock_fn(fail)
    cfg = _fake_config()
    await close_browser_session(cfg, "s1", pause=True, current_url="https://x")

async def test_close_browser_session_success_payload():
    from domains.spawn_browser_agent_v3.repo import close_browser_session

    setup_mock({"/api/browser-session/close": {"status": 200, "json": {}}})
    cfg = _fake_config()
    await close_browser_session(cfg, "s1", pause=True, current_url="https://x.com")
    body = json.loads(get_captured_requests()[0]["requestBody"])
    assert body["pause"] is True
    assert body["current_url"] == "https://x.com"
    assert body["session_id"] == "s1"

async def test_inject_local_storage_success():
    from domains.spawn_browser_agent_v3.repo import inject_local_storage

    setup_mock({"inject-localStorage": {"status": 200, "json": {"injected": True, "count": 5}}})
    cfg = _fake_config()
    out = await inject_local_storage(cfg, "s1", "https://x.com")
    assert out == {"injected": True, "count": 5}

async def test_inject_local_storage_non_200_returns_none():
    from domains.spawn_browser_agent_v3.repo import inject_local_storage

    setup_mock({"inject-localStorage": {"status": 500, "json": {}}})
    cfg = _fake_config()
    assert await inject_local_storage(cfg, "s1", "https://x.com") is None

async def test_inject_local_storage_network_error_returns_none():
    from domains.spawn_browser_agent_v3.repo import inject_local_storage
    from _test_utils import setup_mock_fn

    def boom(req):
        raise RuntimeError("x")

    setup_mock_fn(boom)
    cfg = _fake_config()
    assert await inject_local_storage(cfg, "s1", "https://x.com") is None

async def test_upload_file_to_session_success():
    from domains.spawn_browser_agent_v3 import repo

    class _Resp:
        status_code = 201

        def json(self):
            return {"path": "/tmp/f.pdf"}

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, *a, **kw):
            # assert multipart file shape
            assert "files" in kw
            assert kw["files"]["file"][0] == "f.pdf"
            assert kw.get("data") is None
            return _Resp()

    with patch.object(repo.httpx, "AsyncClient", return_value=_Client()):
        cfg = _fake_config()
        out = await repo.upload_file_to_session(cfg, "s1", "f.pdf", b"PDFDATA", "application/pdf")
    assert out == {"path": "/tmp/f.pdf"}


async def test_upload_file_to_session_downloads_directory():
    """Persisted Kernel downloads must POST directory=/tmp/downloads."""
    from domains.spawn_browser_agent_v3 import repo

    seen = {}

    class _Resp:
        status_code = 200

        def json(self):
            return {"path": "/tmp/downloads/rs.jpeg", "size": 4}

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, *a, **kw):
            seen["data"] = kw.get("data")
            seen["files"] = kw.get("files")
            return _Resp()

    with patch.object(repo.httpx, "AsyncClient", return_value=_Client()):
        cfg = _fake_config()
        out = await repo.upload_file_to_session(
            cfg,
            "s1",
            "rs.jpeg",
            b"JPEG",
            "image/jpeg",
            directory="/tmp/downloads",
        )
    assert out == {"path": "/tmp/downloads/rs.jpeg", "size": 4}
    assert seen["data"] == {"directory": "/tmp/downloads"}
    assert seen["files"]["file"][0] == "rs.jpeg"

async def test_upload_file_to_session_non_200_returns_none():
    from domains.spawn_browser_agent_v3 import repo

    class _Resp:
        status_code = 500
        text = "nope"

        def json(self):
            return {}

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, *a, **kw):
            return _Resp()

    with patch.object(repo.httpx, "AsyncClient", return_value=_Client()):
        cfg = _fake_config()
        assert await repo.upload_file_to_session(cfg, "s1", "f.pdf", b"X") is None

async def test_upload_file_to_session_network_error():
    from domains.spawn_browser_agent_v3 import repo

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, *a, **kw):
            raise RuntimeError("fail")

    with patch.object(repo.httpx, "AsyncClient", return_value=_Client()):
        cfg = _fake_config()
        assert await repo.upload_file_to_session(cfg, "s1", "f.pdf", b"X") is None

# ========================================
# repo: call_extract_llm
# ========================================

async def test_call_extract_llm_success():
    from domains.spawn_browser_agent_v3 import repo

    setup_mock(
        {
            "/chat/completions": {
                "status": 200,
                "json": {"choices": [{"message": {"content": "extracted!"}}]},
            }
        }
    )
    with patch("config.load_config", return_value=_fake_config()):
        out = await repo.call_extract_llm("what?", "page content", "https://x")
    assert out == "extracted!"

async def test_call_extract_llm_non_200():
    from domains.spawn_browser_agent_v3 import repo

    setup_mock({"/chat/completions": {"status": 500, "text": "bad"}})
    with patch("config.load_config", return_value=_fake_config()):
        out = await repo.call_extract_llm("what?", "p", "https://x")
    assert "Extraction failed" in out

async def test_call_extract_llm_network_error():
    from domains.spawn_browser_agent_v3 import repo
    from _test_utils import setup_mock_fn

    def boom(req):
        raise RuntimeError("down")

    setup_mock_fn(boom)
    with patch("config.load_config", return_value=_fake_config()):
        out = await repo.call_extract_llm("what?", "p", "https://x")
    assert "Extraction failed" in out

async def test_call_extract_llm_truncates_long_content():
    from domains.spawn_browser_agent_v3 import repo

    setup_mock(
        {
            "/chat/completions": {
                "status": 200,
                "json": {"choices": [{"message": {"content": "ok"}}]},
            }
        }
    )
    big_content = "A" * (repo.EXTRACT_MAX_CONTENT_LENGTH + 100)
    with patch("config.load_config", return_value=_fake_config()):
        out = await repo.call_extract_llm("inst", big_content, "https://x")
    assert out == "ok"
    call = get_captured_requests()[0]
    body = json.loads(call["requestBody"])
    user_msg = body["messages"][1]["content"]
    assert "[truncated" in user_msg

# ========================================
# repo: fetch_recent_emails
# ========================================

async def test_fetch_recent_emails_success():
    from domains.spawn_browser_agent_v3.repo import fetch_recent_emails

    setup_mock(
        {
            "/api/integrations/email/messages": {
                "status": 200,
                "json": {"emails": [{"bodyText": "x"}]},
            }
        }
    )
    out = await fetch_recent_emails("u1", "https://backend.example.com", "k", "2025-01-01")
    assert out == [{"bodyText": "x"}]

async def test_fetch_recent_emails_404():
    from domains.spawn_browser_agent_v3.repo import fetch_recent_emails

    setup_mock({"/api/integrations/email/messages": {"status": 404, "json": {}}})
    out = await fetch_recent_emails("u1", "https://backend.example.com", "k", "2025-01-01")
    assert out == []

async def test_fetch_recent_emails_5xx():
    from domains.spawn_browser_agent_v3.repo import fetch_recent_emails

    setup_mock({"/api/integrations/email/messages": {"status": 500, "json": {}}})
    out = await fetch_recent_emails("u1", "https://backend.example.com", "k", "2025-01-01")
    assert out == []

async def test_fetch_recent_emails_network_error():
    from domains.spawn_browser_agent_v3.repo import fetch_recent_emails
    from _test_utils import setup_mock_fn

    def boom(req):
        raise RuntimeError("bad")

    setup_mock_fn(boom)
    out = await fetch_recent_emails("u1", "https://x", "k", "2025-01-01")
    assert out == []

# ========================================
# service: safe_time, build_context_summary, build_usage_items
# ========================================

def test_safe_time_returns_float():
    from domains.spawn_browser_agent_v3.service import safe_time

    assert isinstance(safe_time(), float)

def test_safe_time_swallows_errors():
    import domains.spawn_browser_agent_v3.service as service

    with patch.object(service.time, "time", side_effect=RuntimeError("sandbox")):
        assert service.safe_time() == 0.0

def test_build_context_summary_success_with_urls():
    from domains.spawn_browser_agent_v3.service import build_context_summary

    out = build_context_summary(
        success=True,
        close_reasoning="done",
        visited_urls=["https://a", "https://b", "https://c"],
        reasoning_messages=["think1", "think2"],
        action_summary=["click", "type"],
    )
    assert "SUCCESS" in out
    assert "done" in out
    assert "https://a" in out
    assert "think1" in out
    assert "click" in out

def test_build_context_summary_failure_with_error():
    from domains.spawn_browser_agent_v3.service import build_context_summary

    out = build_context_summary(
        success=False,
        close_reasoning="failed",
        visited_urls=[],
        reasoning_messages=[],
        action_summary=[],
        error_context="timeout",
    )
    assert "FAILED" in out
    assert "timeout" in out

def test_build_context_summary_trims_lists():
    from domains.spawn_browser_agent_v3.service import build_context_summary

    many_urls = [f"https://x/{i}" for i in range(20)]
    many_actions = [f"a{i}" for i in range(20)]
    many_reasoning = [f"r{i}" for i in range(10)]
    out = build_context_summary(
        success=True,
        close_reasoning="",
        visited_urls=many_urls,
        reasoning_messages=many_reasoning,
        action_summary=many_actions,
    )
    # Last 5 urls
    assert "https://x/19" in out
    assert "https://x/0" not in out
    # Last 3 reasoning
    assert "r9" in out
    assert "r0" not in out

def test_select_auth_assistance_current_url_restores_pre_submit_query_params():
    from domains.spawn_browser_agent_v3.service import (
        select_auth_assistance_current_url,
    )

    selected = select_auth_assistance_current_url(
        "https://www.amazon.com/ap/signin",
        [
            "https://www.amazon.com/checkout/entry/cart?referrer=cart",
            "https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.com%2Fcheckout",
            "https://www.amazon.com/ap/signin",
        ],
    )

    assert selected == ("https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.com%2Fcheckout")

def test_select_auth_assistance_current_url_keeps_current_when_it_has_query_params():
    from domains.spawn_browser_agent_v3.service import (
        select_auth_assistance_current_url,
    )

    selected = select_auth_assistance_current_url(
        "https://www.amazon.com/ap/signin?openid.return_to=current",
        ["https://www.amazon.com/ap/signin?openid.return_to=old"],
    )

    assert selected == "https://www.amazon.com/ap/signin?openid.return_to=current"

def test_build_usage_items():
    from domains.spawn_browser_agent_v3.service import build_usage_items

    with patch.dict(os.environ, {"BROWSER_PROVIDER": "kernel"}):
        items = build_usage_items(
            total_input_tokens=1000,
            total_output_tokens=2000,
            model_pricing={"input_cents_per_1k": 0.3, "output_cents_per_1k": 1.5},
            execution_time_ms=60000,
        )
    assert len(items) == 2
    assert items[0]["type"] == "llm"
    assert items[0]["provider"] == "Rose 1 Browser Use"
    assert items[0]["input_tokens"] == 1000
    assert items[0]["output_tokens"] == 2000
    # 1k*0.3 + 2k*1.5 = 0.3 + 3.0 = 3.3
    assert items[0]["cost_cents"] == 3.3
    assert items[1]["type"] == "service"
    assert items[1]["provider"] == "Kernel Browser"

    with patch.dict(os.environ, {"BROWSER_PROVIDER": "steel"}):
        steel_items = build_usage_items(0, 0, {"input_cents_per_1k": 0, "output_cents_per_1k": 0}, 1)
    assert steel_items[1]["provider"] == "Steel.dev Browser"

def test_build_usage_items_carries_browser_pool_model():
    """Regression (A-02): browser llm usage rows MUST name the browser pool.

    Without `model`, `AgentWorkflow._track_usage` falls back to the ROOT
    agent's pool and prices browser tokens at the parent's rate. The real path
    must match the simulated path's contract, which always emits `model`.
    """
    from domains.spawn_browser_agent_v3.config import BROWSER_USE_PRICING_POOL
    from domains.spawn_browser_agent_v3.handler import _simulated_browser_usage_items
    from domains.spawn_browser_agent_v3.service import (
        browser_usage_items_to_tool_usage,
        build_usage_items,
    )

    pricing = {"input_cents_per_1k": 0.5, "output_cents_per_1k": 2.75}
    items = build_usage_items(
        total_input_tokens=1_186_754,
        total_output_tokens=40_000,
        model_pricing=pricing,
        execution_time_ms=900_000,
    )
    llm_item = next(i for i in items if i["type"] == "llm")
    assert "model" in llm_item, "llm usage item dropped the model key"
    assert llm_item["model"] == BROWSER_USE_PRICING_POOL

    # Contract parity with the simulated path: both emit `model` on llm rows.
    simulated = _simulated_browser_usage_items(10, 20, pricing, usage_by_model={"claude-opus-4-8-claude": {}})
    sim_llm = next(i for i in simulated if i["type"] == "llm")
    assert set(llm_item) == set(sim_llm), f"real path {sorted(llm_item)} != simulated {sorted(sim_llm)}"

    # ...and the manager boundary hands that model to the workflow.
    tool_usage = browser_usage_items_to_tool_usage(items)
    assert tool_usage["llm"][0]["model"] == BROWSER_USE_PRICING_POOL
    assert tool_usage["llm"][0]["tokens_in"] == 1_186_754
    assert tool_usage["llm"][0]["tokens_out"] == 40_000
    assert tool_usage["service"][0]["provider"] in ("Kernel Browser", "Steel.dev Browser")

def test_build_usage_items_emits_one_row_per_actual_model():
    """The llm rows must name the model that ACTUALLY ran inference.

    `rose-1-browser-use` is a POOL that races several underlying models at
    different prices, and `-claude`/`-gpt` steps ran on the user's own compute
    token ($0 in `_track_usage`). Collapsing everything onto the pool constant
    both mis-prices the race and makes the $0 branch unreachable.
    """
    import inspect

    from domains.spawn_browser_agent_v3.service import build_usage_items

    usage_by_model = {
        "claude-opus-4-8-claude": {"input_tokens": 50_000, "output_tokens": 1_000},
        "google/gemini-3.1-pro-preview": {"input_tokens": 20_000, "output_tokens": 4_000},
    }
    total_in = sum(u["input_tokens"] for u in usage_by_model.values())
    total_out = sum(u["output_tokens"] for u in usage_by_model.values())

    # Assert BEHAVIOR, not signature: if the per-model parameter is ever
    # dropped, this still fails on the row assertions below rather than on a
    # TypeError, so the contract can't be regressed by renaming it away.
    supported = "usage_by_model" in inspect.signature(build_usage_items).parameters
    items = build_usage_items(
        total_in,
        total_out,
        {"input_cents_per_1k": 0.5, "output_cents_per_1k": 2.75},
        900_000,
        **({"usage_by_model": usage_by_model} if supported else {}),
    )
    llm_rows = [i for i in items if i["type"] == "llm"]
    service_rows = [i for i in items if i["type"] == "service"]

    assert [r["model"] for r in llm_rows] == list(usage_by_model), "one llm row per ACTUAL model, in ledger order"
    assert all(r["model"] != "rose-1-browser-use" for r in llm_rows), "pool constant leaked back into per-model rows"

    # Token conservation: per-model rows must sum to the reported totals.
    assert sum(r["input_tokens"] for r in llm_rows) == total_in
    assert sum(r["output_tokens"] for r in llm_rows) == total_out

    # The browser-time service row is NOT per-model and stays a single row.
    assert len(service_rows) == 1
    assert service_rows[0]["provider"] in ("Kernel Browser", "Steel.dev Browser")

def test_build_usage_items_unattributed_tokens_fall_back_to_browser_pool():
    """No per-model data => historical single row, priced at the browser pool.

    Never `None`: a missing model makes `_track_usage` fall back to the ROOT
    agent's cheaper pool and under-bill browser tokens (regression A-02).
    """
    import inspect

    from domains.spawn_browser_agent_v3.config import BROWSER_USE_PRICING_POOL
    from domains.spawn_browser_agent_v3.service import build_usage_items

    pricing = {"input_cents_per_1k": 0.5, "output_cents_per_1k": 2.75}
    supported = "usage_by_model" in inspect.signature(build_usage_items).parameters
    for empty in (None, {}):
        items = build_usage_items(1_000, 200, pricing, 1_000, **({"usage_by_model": empty} if supported else {}))
        llm_rows = [i for i in items if i["type"] == "llm"]
        assert len(llm_rows) == 1
        assert llm_rows[0]["model"] == BROWSER_USE_PRICING_POOL
        assert llm_rows[0]["input_tokens"] == 1_000
        assert llm_rows[0]["output_tokens"] == 200

def test_browser_usage_rows_never_leak_the_internal_fast_cache_marker():
    """The ledger's internal fast-cache key must never surface as a model name.

    The ledger keys Fast-Mode replays as `f"{model}\\x00fast_cache"` so a replay
    cannot merge into the model's paid bucket. When `actual_model` is missing —
    a plausible state for a cached replay — that key is `"\\x00fast_cache"` and
    the bucket's `model` is `""`. Resolving the emitted model by truthiness fell
    back to the raw key, so a NUL-bearing string became the row's `model`: it is
    truthy, so it also defeated the pricing-pool fallback, and it rode straight
    into `_track_usage` and the stored usage records.
    """
    from domains.spawn_browser_agent_v3.config import BROWSER_USE_PRICING_POOL
    from domains.spawn_browser_agent_v3.service import (
        accumulate_model_usage,
        build_browser_llm_usage_items,
    )

    usage_by_model: dict = {}
    accumulate_model_usage(usage_by_model, None, 90, 12, from_fast_cache=True)

    rows = build_browser_llm_usage_items(
        0, 0, {"input_cents_per_1k": 0.5, "output_cents_per_1k": 2.75}, usage_by_model
    )

    assert len(rows) == 1
    emitted_model = rows[0]["model"]
    assert "\x00" not in emitted_model, f"internal ledger marker leaked into model: {emitted_model!r}"
    assert "fast_cache" not in emitted_model, f"internal marker leaked: {emitted_model!r}"
    # An unattributed model must still price at the browser pool, never fall
    # through to the parent agent's cheaper pool.
    assert emitted_model == BROWSER_USE_PRICING_POOL
    assert rows[0]["from_fast_cache"] is True

    # A hand-built ledger (no `model` key) still resolves its key as the name.
    legacy_rows = build_browser_llm_usage_items(
        0, 0, {"input_cents_per_1k": 0.5, "output_cents_per_1k": 2.75}, {"gemini-3-pro": {"input_tokens": 5}}
    )
    assert legacy_rows[0]["model"] == "gemini-3-pro"

def test_browser_usage_rows_carry_cache_metadata_for_the_workflow_discount():
    """Cached browser input must reach `_track_usage`, not be re-billed as fresh.

    `AgentWorkflow._track_usage` prices `cache_read_input_tokens` /
    `cache_creation_input_tokens` separately from uncached input and zeroes any
    row flagged `from_fast_cache`. The browser path used to drop all three, so
    every cache hit was billed at the full input rate and Fast-Mode replays —
    which never call a provider at all — were billed as paid waterfall usage.
    """
    from domains.spawn_browser_agent_v3.service import (
        accumulate_model_usage,
        build_browser_llm_usage_items,
    )

    usage_by_model: dict = {}
    accumulate_model_usage(usage_by_model, "claude-sonnet-4-6", 100, 20, 900, 50)
    accumulate_model_usage(usage_by_model, "claude-sonnet-4-6", 40, 10, 100, 0)
    # Same model, but a Fast-Mode replay: MUST NOT merge into the paid bucket.
    accumulate_model_usage(usage_by_model, "claude-sonnet-4-6", 70, 5, 0, 0, from_fast_cache=True)

    rows = build_browser_llm_usage_items(
        0, 0, {"input_cents_per_1k": 0.5, "output_cents_per_1k": 2.75}, usage_by_model
    )
    paid = [r for r in rows if r["model"] == "claude-sonnet-4-6" and not r["from_fast_cache"]]
    replay = [r for r in rows if r["model"] == "claude-sonnet-4-6" and r["from_fast_cache"]]
    assert len(paid) == 1 and len(replay) == 1, f"paid and replay must be separate rows: {rows}"

    # Cache counters aggregate across every PAID step billed to the same model.
    assert paid[0]["cache_read_input_tokens"] == 1_000
    assert paid[0]["cache_creation_input_tokens"] == 50
    # Uncached input stays separate — cache tokens must not inflate it.
    assert paid[0]["input_tokens"] == 140

    # The regression this guards: `_track_usage` zero-prices any row flagged
    # `from_fast_cache` and returns early, so if the replay were merged into the
    # paid bucket all 210 paid input tokens would be billed at $0.
    assert paid[0]["from_fast_cache"] is False
    assert replay[0]["from_fast_cache"] is True
    assert replay[0]["input_tokens"] == 70

    # Token conservation across the split: nothing is dropped or double-counted.
    assert sum(r["input_tokens"] for r in rows) == 210
    assert sum(r["output_tokens"] for r in rows) == 35

def test_real_browser_path_attributes_every_token_to_its_actual_model():
    """The REAL activity must never bill tokens it did not attribute to a model.

    Guards two things at once in `_spawn_browser_agent_activity_v3_real`:
      1. every `build_usage_items(...)` call forwards `usage_by_model`, and
      2. every `total_input_tokens +=` is paired with an
         `accumulate_model_usage(...)`, so the per-model ledger can never drift
         from the totals it is asserted to sum to.
    """
    import inspect

    from domains.spawn_browser_agent_v3 import handler

    source = textwrap.dedent(inspect.getsource(handler._spawn_browser_agent_activity_v3_real))
    tree = ast.parse(source)

    build_calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "build_usage_items"
    ]
    assert len(build_calls) == 4, f"expected 4 build_usage_items call sites, found {len(build_calls)}"
    for build_call in build_calls:
        forwarded = [ast.unparse(a) for a in build_call.args] + [ast.unparse(k.value) for k in build_call.keywords]
        assert "usage_by_model" in forwarded, f"call site drops usage_by_model: {ast.unparse(build_call)}"

    accumulate_calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "accumulate_model_usage"
    ]
    total_increments = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.AugAssign)
        and isinstance(node.op, ast.Add)
        and isinstance(node.target, ast.Name)
        and node.target.id == "total_input_tokens"
    ]
    assert total_increments, "no total_input_tokens accumulation found — test is looking at the wrong function"
    assert len(accumulate_calls) == len(total_increments), (
        f"{len(total_increments)} token accumulations but only {len(accumulate_calls)} "
        "accumulate_model_usage calls — some tokens are billed without a real model"
    )

def test_get_browser_system_prompt_with_files():
    from domains.spawn_browser_agent_v3.service import get_browser_system_prompt

    out = get_browser_system_prompt(
        goal="buy a book",
        custom_instructions="be quick",
        available_files=["a.pdf", "b.txt"],
    )
    assert "buy a book" in out
    assert "be quick" in out
    assert "a.pdf" in out and "b.txt" in out

def test_get_browser_system_prompt_without_files():
    from domains.spawn_browser_agent_v3.service import get_browser_system_prompt

    out = get_browser_system_prompt("g", custom_instructions="")
    assert "AVAILABLE FILES FOR UPLOAD" not in out

def test_get_browser_system_prompt_is_static_across_calls():
    """The static prompt must be byte-identical across calls within a workspace.

    No `current_time`, no `current_url`, no per-step interpolation. This is
    the property that lets Anthropic prompt caching reuse the prefix.
    """
    from domains.spawn_browser_agent_v3.service import get_browser_system_prompt

    out_a = get_browser_system_prompt("buy a book", "be quick", available_files=["x.pdf"])
    out_b = get_browser_system_prompt("buy a book", "be quick", available_files=["x.pdf"])
    assert out_a == out_b, "prompt must be byte-identical across calls with same inputs"
    assert "Current time:" not in out_a, "current time leaks into static prompt"
    assert "CURRENT URL:" not in out_a, "current url leaks into static prompt"

# ========================================
# handler: browser-use auth selection / rotation
# ========================================

def test_browser_prompt_cache_namespace_is_stable_and_isolated():
    from domains.spawn_browser_agent_v3.handler import _browser_prompt_cache_namespace

    step_one = _browser_prompt_cache_namespace("task-a", "browser_use_step_1")
    step_two = _browser_prompt_cache_namespace("task-a", "browser_use_step_2")
    sibling = _browser_prompt_cache_namespace("task-b", "browser_use_step_1")
    fork = _browser_prompt_cache_namespace("task-a", "write_lock_notification_fork_2")

    assert step_one == step_two, "Browser steps in one task must share a stable provider cache lane"
    assert step_one != sibling, "Sibling browser tasks must use isolated provider cache lanes"
    assert step_one != fork, "Forked browser prompts must not overwrite the main browser cache lane"

class _FakeRoseClient:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def complete_browser_use(self, **kwargs):
        self.calls.append(kwargs)
        return self.responses.pop(0)

async def test_call_browser_use_with_rotation_uses_gpt_auth():
    from domains.spawn_browser_agent_v3.handler import _call_browser_use_with_rotation
    from domains.spawn_browser_agent_v3.types import ClaudeTokenState

    client = _FakeRoseClient([{"actions": [{"type": "wait"}]}])
    token_state = ClaudeTokenState()
    token_state.access_token = "claude-token"
    token_state.source = "user"

    result = await _call_browser_use_with_rotation(
        rose_client=client,
        task="do it",
        dynamic_system_context="dynamic",
        turn_messages=[],
        browser_state={"url": "https://example.com"},
        action_entries=[],
        config=_fake_config(),
        user_id="u1",
        agent_id="a1",
        browser_task_id="browser-task-1",
        iteration=3,
        token_state=token_state,
        gpt_token="gpt-token",
        gpt_account_id="acct-1",
        gpt_token_source="pool",
        gpt_token_pool_id="pool-gpt",
        browser_use_mode="gpt",
        extra_user_messages=[{"role": "user", "content": "resume from current live state"}],
    )

    assert result == {"actions": [{"type": "wait"}]}
    assert client.calls[0]["claude_auth"] is None
    assert client.calls[0]["gpt_auth"].token == "gpt-token"
    assert client.calls[0]["gpt_auth"].account_id == "acct-1"
    assert client.calls[0]["gpt_auth"].pool_token_id == "pool-gpt"
    assert client.calls[0]["cache_namespace"] == "browser-task:browser-task-1:browser_use"
    assert client.calls[0]["browser_state"]["_extra_user_messages"] == [
        {"role": "user", "content": "resume from current live state"}
    ]

def test_simulated_browser_usage_preserves_transport_model():
    from domains.spawn_browser_agent_v3.handler import _simulated_browser_usage_items

    items = _simulated_browser_usage_items(
        30,
        3,
        {"input_cents_per_1k": 1, "output_cents_per_1k": 2},
        {
            "gpt-5.6-sol-gpt": {"input_tokens": 20, "output_tokens": 2},
            "google/gemini-3.1-pro-preview": {"input_tokens": 10, "output_tokens": 1},
        },
    )

    assert [(item.get("model"), item.get("input_tokens"), item.get("output_tokens")) for item in items[:-1]] == [
        ("gpt-5.6-sol-gpt", 20, 2),
        ("google/gemini-3.1-pro-preview", 10, 1),
    ]
    assert items[-1]["provider"] == "World Model Harness"

async def test_browser_thinking_stream_routes_chunks_to_browser_message_list():
    from domains.spawn_browser_agent_v3.streaming import BrowserThinkingStream
    from providers.rose import StreamChunk

    stream = BrowserThinkingStream(
        agent_id="agent-1",
        task_id="browser-task-1",
        iteration=4,
        started_at_ms=123_000,
    )

    with (
        patch(
            "domains.spawn_browser_agent_v3.streaming.stream_assistant_chunk",
            new_callable=AsyncMock,
        ) as publish,
        patch(
            "domains.spawn_browser_agent_v3.streaming.stream_tool_event",
            new_callable=AsyncMock,
        ) as publish_tool,
    ):
        await stream.start()
        await stream.on_chunk(
            StreamChunk(
                kind="metadata",
                data={"actual_model": "gpt-5.6-sol-gpt"},
            )
        )
        await stream.on_chunk(StreamChunk(kind="reasoning", data={"text": "Inspecting page"}))
        await stream.on_chunk(
            StreamChunk(
                kind="tool_call",
                data={"id": "call-1", "name": "click", "arguments": '{"index":3}'},
            )
        )
        await stream.finish()
        assert publish_tool.await_count == 1
        await stream.finish_tools(status="FINISHED")

    published = [call.kwargs for call in publish.await_args_list]
    assert published[0]["delta"] == ""
    assert published[0]["done"] is False
    assert published[-1]["done"] is True
    assert all(item["agent_id"] == "agent-1" for item in published)
    assert all(item["sub_agent_id"] == "browser-task-1" for item in published)
    assert all(item["llm_started_at_ms"] == 123_000 for item in published)
    assert all(item["clear_on_done"] is True for item in published)
    assert any(item["is_gpt"] is True for item in published[1:])
    assert "Inspecting page" in "".join(item["delta"] for item in published)
    assert '"click"' in "".join(item["delta"] for item in published)
    assert publish_tool.await_count == 2
    assert publish_tool.await_args_list[0].kwargs == {
        "agent_id": "agent-1",
        "stream_id": stream.stream_id,
        "tool_call_id": "call-1",
        "tool_name": "click",
        "title": "Starting click...",
        "char_count": len('{"id":"call-1","name":"click","arguments":"{\\"index\\":3}"}'),
        "is_gpt": True,
        "is_claude": False,
        "llm_started_at_ms": 123_000,
        "sub_agent_id": "browser-task-1",
    }
    assert publish_tool.await_args_list[1].kwargs == {
        "agent_id": "agent-1",
        "stream_id": stream.stream_id,
        "tool_call_id": "call-1",
        "tool_name": "click",
        "title": "Finished click",
        "status": "FINISHED",
        "sub_agent_id": "browser-task-1",
    }

async def test_browser_streaming_rose_client_forwards_and_folds_chunks():
    from domains.spawn_browser_agent_v3.streaming import BrowserStreamingRoseClient
    from providers.rose import RoseClient, StreamChunk

    client = BrowserStreamingRoseClient()
    sink = MagicMock()
    sink.on_chunk = AsyncMock()
    client.set_thinking_stream(sink)

    async def fake_complete(_client, **_kwargs):
        yield StreamChunk(
            kind="metadata",
            data={"actual_model": "gpt-5.6-sol-gpt", "pool_name": "rose-1-browser-use"},
        )
        yield StreamChunk(kind="reasoning", data={"text": "Inspect"})
        yield StreamChunk(
            kind="tool_call",
            data={"id": "call-1", "name": "click", "arguments": '{"index":3}'},
        )
        yield StreamChunk(
            kind="tool_call",
            data={"id": "call-2", "name": "wait", "arguments": '{"seconds":1}'},
        )
        yield StreamChunk(kind="usage", data={"prompt_tokens": 10, "completion_tokens": 4})
        yield StreamChunk(kind="done", data={})

    with patch.object(RoseClient, "complete", new=fake_complete):
        result = await client.complete_browser_use(
            task="Click the target",
            browser_state={"url": "https://example.com", "dom_tree": "<button>Target</button>"},
            action_history=[],
            available_actions=["click", "wait"],
        )

    assert result["actual_model"] == "gpt-5.6-sol-gpt"
    assert result["action"]["action"] == "click"
    assert result["tool_call_id"] == "call-1"
    assert sink.on_chunk.await_count == 5
    forwarded_tools = [
        call.args[0].data["id"] for call in sink.on_chunk.await_args_list if call.args[0].kind == "tool_call"
    ]
    assert forwarded_tools == ["call-1"]

async def test_call_browser_use_with_rotation_rotates_claude_token():
    import domains.spawn_browser_agent_v3.handler as handler
    from domains.spawn_browser_agent_v3.handler import _call_browser_use_with_rotation
    from domains.spawn_browser_agent_v3.types import ClaudeTokenState

    client = _FakeRoseClient(
        [
            {
                "claude_token_error": "rate_limit",
                "rateLimitedUntil": "2026-01-01T00:00:00Z",
            },
            {"actions": [{"type": "done"}]},
        ]
    )
    token_state = ClaudeTokenState()
    token_state.access_token = "old-token"
    token_state.source = "pool"
    token_state.pool_token_id = "pool-old"

    with (
        patch.object(handler.activity, "heartbeat"),
        patch.object(
            handler,
            "report_claude_token_rate_limited",
            new=AsyncMock(),
        ) as mark_limited,
        patch.object(
            handler,
            "fetch_claude_token",
            new=AsyncMock(
                return_value={
                    "accessToken": "new-token",
                    "source": "pool",
                    "poolTokenId": "pool-new",
                }
            ),
        ) as fetch_token,
    ):
        result = await _call_browser_use_with_rotation(
            rose_client=client,
            task="do it",
            dynamic_system_context="dynamic",
            turn_messages=[],
            browser_state={"url": "https://example.com"},
            action_entries=[{"type": "click"}],
            config=_fake_config(),
            user_id="u1",
            agent_id="a1",
            iteration=4,
            token_state=token_state,
            gpt_token=None,
            gpt_account_id=None,
            gpt_token_source=None,
            gpt_token_pool_id=None,
            browser_use_mode="claude",
        )

    assert result == {"actions": [{"type": "done"}]}
    assert len(client.calls) == 2
    assert client.calls[0]["claude_auth"].token == "old-token"
    assert client.calls[1]["claude_auth"].token == "new-token"
    mark_limited.assert_awaited_once()
    fetch_token.assert_awaited_once()
    assert token_state.excluded_pool_ids == ["pool-old"]
    assert token_state.access_token == "new-token"
    assert token_state.pool_token_id == "pool-new"

async def test_call_browser_use_with_rotation_stops_when_no_replacement():
    import domains.spawn_browser_agent_v3.handler as handler
    from domains.spawn_browser_agent_v3.handler import _call_browser_use_with_rotation
    from domains.spawn_browser_agent_v3.types import ClaudeTokenState

    first_result = {"claude_token_error": "auth_error"}
    client = _FakeRoseClient([first_result])
    token_state = ClaudeTokenState()
    token_state.access_token = "bad-token"
    token_state.source = "user"

    with (
        patch.object(handler.activity, "heartbeat"),
        patch.object(
            handler,
            "report_claude_token_rate_limited",
            new=AsyncMock(),
        ),
        patch.object(handler, "fetch_claude_token", new=AsyncMock(return_value=None)),
    ):
        result = await _call_browser_use_with_rotation(
            rose_client=client,
            task="do it",
            dynamic_system_context="dynamic",
            turn_messages=[],
            browser_state={},
            action_entries=[],
            config=_fake_config(),
            user_id="u1",
            agent_id="a1",
            iteration=5,
            token_state=token_state,
            gpt_token=None,
            gpt_account_id=None,
            gpt_token_source=None,
            gpt_token_pool_id=None,
            browser_use_mode="claude",
        )

    assert result is first_result
    assert len(client.calls) == 1
    assert token_state.access_token is None

# ========================================
# service: build_action_titles
# ========================================

def test_build_action_titles_click_with_element():
    from domains.spawn_browser_agent_v3.service import build_action_titles

    p, d, name = build_action_titles("click", {}, "<button>Go</button>", None, None)
    assert "Clicking" in p and "Clicked" in d
    assert name == "click"

def test_build_action_titles_click_with_coords():
    from domains.spawn_browser_agent_v3.service import build_action_titles

    p, d, _ = build_action_titles("click", {}, None, {"x": 100, "y": 200}, None)
    assert "(100, 200)" in p
    assert "(100, 200)" in d

def test_build_action_titles_click_with_nothing():
    from domains.spawn_browser_agent_v3.service import build_action_titles

    p, d, _ = build_action_titles("click", {}, None, None, None)
    assert p == "Clicking..."
    assert d == "Clicked"

def test_build_action_titles_input_text_secret_redacted():
    from domains.spawn_browser_agent_v3.service import build_action_titles

    ua = {"params": {"text": "pwd:alice"}}
    _, d, _ = build_action_titles("input_text", ua, "<input>", None, {"pwd:alice": "real-pw"})
    assert "[encrypted_data]" in d

def test_build_action_titles_input_text_with_coords_plain_text():
    from domains.spawn_browser_agent_v3.service import build_action_titles

    ua = {"params": {"text": "hello"}}
    p, d, _ = build_action_titles("input_text", ua, None, {"x": 10, "y": 20}, None)
    assert "(10, 20)" in p
    assert "hello" in d

def test_build_action_titles_input_text_no_target():
    from domains.spawn_browser_agent_v3.service import build_action_titles

    ua = {"params": {"text": "hi"}}
    p, d, _ = build_action_titles("input_text", ua, None, None, None)
    assert p == "Typing..."
    assert "'hi'" in d

def test_build_action_titles_goto():
    from domains.spawn_browser_agent_v3.service import build_action_titles

    p, d, _ = build_action_titles("goto", {"params": {"url": "https://example.com"}}, None, None, None)
    assert "https://example.com" in p
    assert "https://example.com" in d

def test_build_action_titles_scroll():
    from domains.spawn_browser_agent_v3.service import build_action_titles

    p, d, name = build_action_titles("scroll", {"params": {"direction": "up", "amount": 500}}, None, None, None)
    assert "up 500px" in p
    assert name == "scroll_up"

def test_build_action_titles_press_key_and_extract():
    from domains.spawn_browser_agent_v3.service import build_action_titles

    p, d, _ = build_action_titles("press_key", {"params": {"key": "Enter"}}, None, None, None)
    assert "Enter" in p

    p2, d2, _ = build_action_titles("extract", {}, None, None, None)
    assert "Extracting data..." == p2

def test_build_action_titles_wait_select_upload_screenshot():
    from domains.spawn_browser_agent_v3.service import build_action_titles

    p, d, _ = build_action_titles("wait", {"params": {"time_ms": 500}}, None, None, None)
    assert "500ms" in p

    p2, d2, _ = build_action_titles("select_dropdown", {"params": {"value": "USA"}}, "<select>", None, None)
    assert "USA" in d2

    p3, d3, _ = build_action_titles("select_dropdown", {"params": {"value": "CA"}}, None, None, None)
    assert "Selecting 'CA'..." in p3

    p4, d4, _ = build_action_titles("upload_file", {"params": {"filename": "doc.pdf"}}, "<input>", None, None)
    assert "doc.pdf" in d4

    p5, d5, _ = build_action_titles("upload_file", {"params": {"filename": "x.csv"}}, None, None, None)
    assert "x.csv" in p5

    p6, d6, _ = build_action_titles("screenshot", {}, None, None, None)
    assert "Screenshot captured" == d6

def test_build_action_titles_auth_actions():
    from domains.spawn_browser_agent_v3.service import build_action_titles

    p2, d2, _ = build_action_titles("request_user_assistance_for_authentication", {}, None, None, None)
    assert "authentication assistance" in p2
    assert "Requested" in d2

def test_build_action_titles_unknown_action():
    from domains.spawn_browser_agent_v3.service import build_action_titles

    p, d, name = build_action_titles("unknown_action", {}, None, None, None)
    assert p == "unknown_action..."
    assert d == "unknown_action"
    assert name == "unknown_action"

# ========================================
# service: extract_session_files
# ========================================

async def test_extract_session_files_no_files():
    from domains.spawn_browser_agent_v3 import service

    with patch.object(service, "list_session_files", AsyncMock(return_value=[])):
        out = await service.extract_session_files("s1", "u1", _fake_config())
    assert out == []

async def test_extract_session_files_happy_path():
    from domains.spawn_browser_agent_v3 import service

    files_listing = [{"path": "/a.pdf"}, {"path": "/b.txt"}, {"path": ""}]
    download_return = {
        "content": b"CONTENT",
        "filename": "a.pdf",
        "mime_type": "application/pdf",
    }
    fp = {"storage_path": "users/u/1.pdf", "original_filename": "a.pdf"}

    with (
        patch.object(service, "list_session_files", AsyncMock(return_value=files_listing)),
        patch.object(service, "download_session_file", AsyncMock(return_value=download_return)),
        patch("helpers.attachments.upload_to_storage", AsyncMock(return_value=fp)),
    ):
        out = await service.extract_session_files("s1", "u1", _fake_config())

    # "" path entry skipped; 2 files downloaded
    assert len(out) == 2

async def test_extract_session_files_exclude_paths():
    from domains.spawn_browser_agent_v3 import service

    files_listing = [{"path": "/x.pdf"}, {"path": "/y.pdf"}]

    with (
        patch.object(service, "list_session_files", AsyncMock(return_value=files_listing)),
        patch.object(
            service,
            "download_session_file",
            AsyncMock(return_value={"content": b"c", "filename": "y.pdf", "mime_type": "x"}),
        ),
        patch(
            "helpers.attachments.upload_to_storage",
            AsyncMock(return_value={"storage_path": "p", "original_filename": "y.pdf"}),
        ),
    ):
        out = await service.extract_session_files("s1", "u1", _fake_config(), exclude_paths=["/x.pdf"])
    assert len(out) == 1

async def test_extract_session_files_download_fail_skipped():
    from domains.spawn_browser_agent_v3 import service

    with (
        patch.object(service, "list_session_files", AsyncMock(return_value=[{"path": "/a"}])),
        patch.object(service, "download_session_file", AsyncMock(return_value=None)),
    ):
        out = await service.extract_session_files("s1", "u1", _fake_config())
    assert out == []

async def test_extract_session_files_upload_failure_skipped():
    from domains.spawn_browser_agent_v3 import service

    with (
        patch.object(service, "list_session_files", AsyncMock(return_value=[{"path": "/a"}])),
        patch.object(
            service,
            "download_session_file",
            AsyncMock(return_value={"content": b"c", "filename": "a", "mime_type": "x"}),
        ),
        patch(
            "helpers.attachments.upload_to_storage",
            AsyncMock(side_effect=RuntimeError("up")),
        ),
    ):
        out = await service.extract_session_files("s1", "u1", _fake_config())
    assert out == []

# ========================================
# service_actions: static helpers
# ========================================

def test_get_domain_from_url_variants():
    from domains.spawn_browser_agent_v3.service_actions import get_domain_from_url

    assert get_domain_from_url("https://www.amazon.com/cart") == "amazon.com"
    assert get_domain_from_url("https://auth.amazon.com/login") == "auth.amazon.com"
    assert get_domain_from_url("not-a-url") == ""
    assert get_domain_from_url("roselabs.ai") == "roselabs.ai"
    assert (
        get_domain_from_url("https://proxy.jfk.onkernel.com:8443/browser/live/abc")
        == "proxy.jfk.onkernel.com"
    )

def test_get_base_domain():
    from domains.spawn_browser_agent_v3.service_actions import _get_base_domain

    assert _get_base_domain("auth.amazon.com") == "amazon.com"
    assert _get_base_domain("example.com") == "example.com"
    assert _get_base_domain("localhost") == "localhost"

def test_is_approval_valid_no_approvals():
    from domains.spawn_browser_agent_v3.service_actions import is_approval_valid

    assert is_approval_valid(None, "purchase", "https://x") is False
    assert is_approval_valid({}, "purchase", "https://x") is False

def test_is_approval_valid_missing_fields():
    from domains.spawn_browser_agent_v3.service_actions import is_approval_valid

    assert is_approval_valid({"purchase": {}}, "purchase", "https://x") is False

def test_is_approval_valid_domain_mismatch():
    from domains.spawn_browser_agent_v3.service_actions import is_approval_valid

    approvals = {"purchase": {"domain": "amazon.com", "approved_at": time_module.time()}}
    assert is_approval_valid(approvals, "purchase", "https://ebay.com/x") is False

def test_is_approval_valid_still_fresh():
    from domains.spawn_browser_agent_v3.service_actions import is_approval_valid

    approvals = {"purchase": {"domain": "amazon.com", "approved_at": time_module.time()}}
    assert is_approval_valid(approvals, "purchase", "https://www.amazon.com/x") is True

def test_is_approval_valid_expired():
    from domains.spawn_browser_agent_v3.service_actions import is_approval_valid

    approvals = {
        "purchase": {
            "domain": "amazon.com",
            "approved_at": time_module.time() - 3600,  # way past 120s
        }
    }
    assert is_approval_valid(approvals, "purchase", "https://amazon.com/x") is False


def test_site_write_lock_unlock_covers_purchase_on_approved_domain():
    """Payment-card site unlock disables Place-order write lock on that domain only."""
    from domains.spawn_browser_agent_v3.service_actions import (
        SITE_WRITE_LOCK_APPROVAL_KEY,
        grant_site_write_lock_approvals,
        is_approval_valid,
    )

    approved_at = time_module.time()
    approvals = grant_site_write_lock_approvals(
        {},
        "https://roselabs.ai/test_payment?benchmark=agentcard-live-lifecycle",
        approved_at,
    )
    assert approvals["payment"]["domain"] == "roselabs.ai"
    assert approvals[SITE_WRITE_LOCK_APPROVAL_KEY]["domain"] == "roselabs.ai"
    assert approvals[SITE_WRITE_LOCK_APPROVAL_KEY].get("persistent") is True
    assert is_approval_valid(approvals, "purchase", "https://roselabs.ai/test_payment") is True
    assert is_approval_valid(approvals, "email_send", "https://roselabs.ai/test_payment") is True
    assert is_approval_valid(approvals, "social_post", "https://roselabs.ai/test_payment") is True
    # Other sites stay locked — and a newly spawned browser agent starts with {}.
    assert is_approval_valid(approvals, "purchase", "https://amazon.com/checkout") is False
    assert is_approval_valid({}, "purchase", "https://roselabs.ai/test_payment") is False


def test_payment_site_unlock_covers_subdomains_and_ignores_path_query():
    """Site unlock is registrable-domain wildcard — not a full URL / query match."""
    from domains.spawn_browser_agent_v3.service_actions import (
        SITE_WRITE_LOCK_APPROVAL_KEY,
        grant_site_write_lock_approvals,
        is_approval_valid,
    )

    # Synthetic merchant host — avoids CI secret-domain scanners.
    merchant = "https://www.shop-example.com/cart?item=1&ref=bench"
    approvals = grant_site_write_lock_approvals({}, merchant, time_module.time())
    assert approvals[SITE_WRITE_LOCK_APPROVAL_KEY]["domain"] == "shop-example.com"
    # Apex, www, and checkout subdomain + arbitrary paths/queries all match.
    assert is_approval_valid(approvals, "purchase", "https://shop-example.com/cart") is True
    assert is_approval_valid(approvals, "purchase", "https://www.shop-example.com/other") is True
    assert (
        is_approval_valid(
            approvals,
            "purchase",
            "https://checkout.shop-example.com/pay?order=1",
        )
        is True
    )
    assert is_approval_valid(approvals, "email_send", "https://pay.shop-example.com/send") is True
    # Sibling registrable domains stay locked.
    assert is_approval_valid(approvals, "purchase", "https://shop-example.org/cart") is False
    assert is_approval_valid(approvals, "purchase", "https://evil-shop-example.com/x") is False
    # Browser-provider hosts never inherit a merchant site unlock.
    assert is_approval_valid(approvals, "purchase", "https://foo.onkernel.com/view") is False
    assert is_approval_valid(approvals, "purchase", "https://bar.kernel.sh/session") is False


def test_payment_site_unlock_survives_write_lock_timeout():
    """Payment-card site unlock must outlive the 120s one-off write-lock timeout.

    Checkout (fill card → Place order → Stripe) routinely exceeds 120s; expiring
    the site unlock mid-flow re-prompts purchase write_lock after payment_approval.
    """
    from domains.spawn_browser_agent_v3.config import WRITE_LOCK_APPROVAL_TIMEOUT_SECONDS
    from domains.spawn_browser_agent_v3.service_actions import (
        grant_site_write_lock_approvals,
        is_approval_valid,
    )

    approved_at = time_module.time() - (WRITE_LOCK_APPROVAL_TIMEOUT_SECONDS + 60)
    approvals = grant_site_write_lock_approvals(
        {},
        "https://www.roselabs.ai/test_payment",
        approved_at,
    )
    assert is_approval_valid(approvals, "purchase", "https://roselabs.ai/test_payment") is True
    assert is_approval_valid(approvals, "email_send", "https://roselabs.ai/test_payment") is True
    # One-off typed purchase approval (no site unlock) still expires.
    typed_only = {
        "purchase": {
            "domain": "roselabs.ai",
            "approved_at": approved_at,
        }
    }
    assert is_approval_valid(typed_only, "purchase", "https://roselabs.ai/test_payment") is False


def test_fresh_browser_session_does_not_inherit_site_write_lock_unlock():
    """write_lock_approvals are resume-state only; a new browser activity starts empty."""
    from domains.spawn_browser_agent_v3.service_actions import (
        grant_site_write_lock_approvals,
        is_approval_valid,
    )

    prior = grant_site_write_lock_approvals(
        {},
        "https://roselabs.ai/test_payment",
        time_module.time(),
    )
    # Simulate a newly spawned browser agent: no write_lock_resume_state.
    fresh_session_approvals: dict = {}
    assert prior is not fresh_session_approvals
    assert is_approval_valid(prior, "purchase", "https://roselabs.ai/test_payment") is True
    assert is_approval_valid(fresh_session_approvals, "purchase", "https://roselabs.ai/test_payment") is False


@pytest.mark.asyncio
async def test_purchase_write_lock_bypassed_when_payment_card_secret_refs_present():
    """H-06: minted card refs unlock Place order even if site approval bookkeeping missed."""
    from domains.spawn_browser_agent_v3.service_actions import _click_write_lock_result
    from domains.spawn_browser_agent_v3.service_crypto import PAYMENT_CARD_SECRET_REFS

    session = MagicMock()
    dom = MagicMock()
    element = MagicMock()
    element.text_content = "Place order\n$1.00"
    element.tag_name = "button"
    element.attributes = {}
    secret_refs = {ref: f"val-{ref}" for ref in PAYMENT_CARD_SECRET_REFS}

    with patch(
        "domains.spawn_browser_agent_v3.service_actions._browser_click_write_lock_signal",
        AsyncMock(return_value="Place order $1.00"),
    ), patch(
        "domains.spawn_browser_agent_v3.service_actions._element_write_lock_signal",
        return_value="Place order $1.00",
    ):
        locked = await _click_write_lock_result(
            session=session,
            dom_service=dom,
            element=element,
            index=1,
            coords={"x": 10, "y": 10},
            write_lock_approvals={},  # empty site unlock — secret refs must still unlock
            current_url="https://www.roselabs.ai/test_payment?benchmark=agentcard-live-lifecycle",
            system_name="Rose",
            secret_refs=secret_refs,
        )
        assert locked is None
        still_locked = await _click_write_lock_result(
            session=session,
            dom_service=dom,
            element=element,
            index=1,
            coords={"x": 10, "y": 10},
            write_lock_approvals={},
            current_url="https://www.roselabs.ai/test_payment?benchmark=agentcard-live-lifecycle",
            system_name="Rose",
            secret_refs={},
        )
        assert still_locked is not None
        assert still_locked["status"] == "needs_write_approval"
        assert still_locked["approval_type"] == "purchase"


def test_site_write_lock_grant_prefers_merchant_url_over_kernel_proxy_current_url():
    """H-06 outcome: Kernel live-view current_url must not become the unlock domain."""
    from domains.spawn_browser_agent_v3.service_actions import (
        SITE_WRITE_LOCK_APPROVAL_KEY,
        grant_site_write_lock_approvals,
        is_approval_valid,
        resolve_site_write_lock_grant_url,
    )

    result = {
        "current_url": "https://proxy.jfk-awesome-mccarthy.onkernel.com:8443/browser/live/abc",
        "payment_request": {
            "line_items": [
                {
                    "name": "Agent Card Lifecycle Probe",
                    "product_url": "https://www.roselabs.ai/p/agentcard-lifecycle-probe",
                }
            ]
        },
    }
    grant_url = resolve_site_write_lock_grant_url(result)
    assert "roselabs.ai" in grant_url
    assert "onkernel.com" not in grant_url
    approvals = grant_site_write_lock_approvals({}, grant_url, time_module.time())
    assert approvals[SITE_WRITE_LOCK_APPROVAL_KEY]["domain"] == "roselabs.ai"
    assert (
        is_approval_valid(
            approvals,
            "purchase",
            "https://www.roselabs.ai/test_payment?benchmark=agentcard-live-lifecycle",
        )
        is True
    )
    # Proxy-only grant is refused (no merchant domain to unlock).
    proxy_only = grant_site_write_lock_approvals(
        {},
        "https://proxy.jfk-awesome-mccarthy.onkernel.com:8443/browser/live/abc",
        time_module.time(),
    )
    assert SITE_WRITE_LOCK_APPROVAL_KEY not in proxy_only

    # Fleet 20260811-010703: live-view host is *.kernel.sh (not onkernel.com).
    # When product URLs are absent, spawn start_url must still unlock merchant.
    kernel_sh = {
        "current_url": "https://prod-yul-hypeman-5.kernel.sh:8443/browser/live/5GgNkgp6OZ2g?readOnly=true",
        "payment_request": {
            "merchant": "Rose Labs Test Payment",
            "lineItems": [{"name": "Agent Card Lifecycle Probe", "quantity": 1}],
        },
        "start_url": "https://roselabs.ai/test_payment?benchmark=agentcard-live-lifecycle",
    }
    grant_url_sh = resolve_site_write_lock_grant_url(kernel_sh)
    assert "roselabs.ai" in grant_url_sh
    assert "kernel.sh" not in grant_url_sh
    approvals_sh = grant_site_write_lock_approvals({}, grant_url_sh, time_module.time())
    assert approvals_sh[SITE_WRITE_LOCK_APPROVAL_KEY]["domain"] == "roselabs.ai"
    assert (
        is_approval_valid(
            approvals_sh,
            "purchase",
            "https://www.roselabs.ai/test_payment?benchmark=agentcard-live-lifecycle",
        )
        is True
    )
    kernel_sh_only = grant_site_write_lock_approvals(
        {},
        "https://prod-yul-hypeman-5.kernel.sh:8443/browser/live/abc",
        time_module.time(),
    )
    assert SITE_WRITE_LOCK_APPROVAL_KEY not in kernel_sh_only

def test_get_element_description_none():
    from domains.spawn_browser_agent_v3.service_actions import get_element_description

    assert get_element_description(None) == "unknown"

def test_get_element_description_with_text():
    from domains.spawn_browser_agent_v3.service_actions import get_element_description

    el = MagicMock()
    el.tag_name = "button"
    el.attributes = {}
    el.get_all_children_text.return_value = "Click Me"
    out = get_element_description(el)
    assert "Click Me" in out
    assert "button" in out

def test_get_element_description_with_placeholder():
    from domains.spawn_browser_agent_v3.service_actions import get_element_description

    el = MagicMock()
    el.tag_name = "input"
    el.attributes = {"placeholder": "Search here"}
    el.get_all_children_text.return_value = ""
    out = get_element_description(el)
    assert "Search here" in out

def test_get_element_description_with_aria_label():
    from domains.spawn_browser_agent_v3.service_actions import get_element_description

    el = MagicMock()
    el.tag_name = "div"
    el.attributes = {"aria-label": "Menu toggle"}
    el.get_all_children_text.return_value = ""
    out = get_element_description(el)
    assert "Menu toggle" in out

def test_get_element_description_with_name_attr():
    from domains.spawn_browser_agent_v3.service_actions import get_element_description

    el = MagicMock()
    el.tag_name = "input"
    el.attributes = {"name": "password"}
    el.get_all_children_text.return_value = ""
    out = get_element_description(el)
    assert 'name="password"' in out

def test_get_element_description_with_id():
    from domains.spawn_browser_agent_v3.service_actions import get_element_description

    el = MagicMock()
    el.tag_name = "div"
    el.attributes = {"id": "main-btn"}
    el.get_all_children_text.return_value = ""
    out = get_element_description(el)
    assert "#main-btn" in out

def test_get_element_description_input_type():
    from domains.spawn_browser_agent_v3.service_actions import get_element_description

    el = MagicMock()
    el.tag_name = "input"
    el.attributes = {"type": "email"}
    el.get_all_children_text.return_value = ""
    out = get_element_description(el)
    assert 'type="email"' in out

def test_get_element_description_nothing():
    from domains.spawn_browser_agent_v3.service_actions import get_element_description

    el = MagicMock()
    el.tag_name = "span"
    el.attributes = {}
    el.get_all_children_text.return_value = ""
    out = get_element_description(el)
    assert out == "<span>"

def test_get_element_description_text_extraction_error():
    from domains.spawn_browser_agent_v3.service_actions import get_element_description

    el = MagicMock()
    el.tag_name = "div"
    el.attributes = {"id": "x"}
    el.get_all_children_text.side_effect = RuntimeError("x")
    out = get_element_description(el)
    assert "#x" in out

async def test_move_visual_cursor_no_session_safe():
    from domains.spawn_browser_agent_v3.service_actions import move_visual_cursor

    dom = MagicMock()
    dom.session = None
    # Should not raise
    await move_visual_cursor(dom, 10, 20)

async def test_move_visual_cursor_exception_safe():
    from domains.spawn_browser_agent_v3.service_actions import move_visual_cursor

    dom = MagicMock()
    dom.session = MagicMock()
    dom.session.get_or_create_cdp_session = AsyncMock(side_effect=RuntimeError("x"))
    await move_visual_cursor(dom, 1, 2)

# ========================================
# service_actions: execute_action early validation branches
# ========================================

async def test_execute_action_no_session():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = None
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "click"})
    assert out["success"] is False
    assert "not connected" in out["error"]

async def test_execute_action_element_not_found():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "click", "index": 5})
    assert out["success"] is False
    assert "index 5 not found" in out["error"]

async def test_execute_action_unknown_action():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "totally_unknown"})
    assert out["success"] is False
    assert "Unknown action" in out["error"]

def test_read_network_requests_tool_is_advertised():
    """The read_network_requests tool (1:1 with Claude Code's) is exposed to the
    browser model so it can detect a 403/Cloudflare challenge by status code or
    find an underlying API instead of fighting the UI."""
    from providers.rose.browser_use import (
        BROWSER_USE_TOOLS,
        build_browser_use_tools,
        generate_tool_descriptions,
    )

    assert "read_network_requests" in BROWSER_USE_TOOLS
    desc = generate_tool_descriptions(sorted(BROWSER_USE_TOOLS))
    assert "read_network_requests" in desc
    assert any("read_network_requests" in str(s) for s in build_browser_use_tools(sorted(BROWSER_USE_TOOLS)))

def test_captured_request_bodies_are_redacted_truncated_by_bytes_and_omission_tagged():
    """Retained request bodies must never leak secrets, must respect a BYTE budget,
    and must distinguish a policy omission from a size truncation.

    The allowlist scopes WHICH endpoints are retained; it cannot promise those
    payloads are secret-free. Byte-vs-character truncation matters because
    _max_body_bytes is a byte budget and a character slice both overshoots it and
    can split a multi-byte code point. Marking an allowlist omission as
    'truncated' sends the next reader hunting for a limit to raise.
    """
    import time as _time

    from domains.spawn_browser_agent_v3.recording import (
        BrowserNetworkRecorder,
        _redact_request_body,
    )

    # Secrets are stripped even though the host is allowlisted.
    redacted = _redact_request_body('{"score":0.09,"sessionToken":"tok_live_abc","nested":{"api_key":"sk-1"}}')
    assert "tok_live_abc" not in redacted, redacted
    assert "sk-1" not in redacted, redacted
    assert '"score":0.09' in redacted, redacted

    form = _redact_request_body(
        "action=form_submit&csrf_token=abc123&width=1280",
        "application/x-www-form-urlencoded",
    )
    assert "abc123" not in form, form
    assert "action=form_submit" in form and "width=1280" in form, form

    # A payload that parses as neither JSON nor form-encoded cannot be shown to be
    # secret-free, so it is dropped rather than persisted verbatim.
    assert _redact_request_body("\x00\x01binary-blob") == BrowserNetworkRecorder.REDACTED_PLACEHOLDER
    # A lone "=" must NOT be inferred as form encoding: binary payloads contain
    # "=" too, and splitting one would persist opaque fragments verbatim.
    assert _redact_request_body("\x00blob=value") == BrowserNetworkRecorder.REDACTED_PLACEHOLDER

    def capture(post_data, *, url, has_post_data=True, max_bytes=64):
        recorder = BrowserNetworkRecorder.__new__(BrowserNetworkRecorder)
        recorder._max_entries = 10
        recorder._ignored_request_ids = set()
        recorder._active_request_ids = set()
        recorder._patterns = []
        recorder._max_body_bytes = max_bytes
        recorder._started_at = _time.monotonic()
        recorder.entries = {}
        recorder._on_request_will_be_sent(
            {
                "requestId": "r1",
                "request": {
                    "url": url,
                    "method": "POST",
                    "postData": post_data,
                    "hasPostData": has_post_data,
                },
                "type": "XHR",
            },
            generation=1,
            session_id="s1",
        )
        return recorder.entries.get("1:s1:r1") or next(iter(recorder.entries.values()))

    # Multi-byte truncation stays inside the byte budget and never splits a char.
    multibyte = '{"pad":"' + ("é" * 200) + '"}'
    entry = capture(multibyte, url="https://fcaptcha.webdecoy.com/api/score")
    body = entry["request_body"]
    assert entry["request_body_truncated"] is True
    assert len(body.encode("utf-8")) <= 64, len(body.encode("utf-8"))
    body.encode("utf-8").decode("utf-8")  # must not raise: no split code point

    # A first-party merchant body stays AVAILABLE (read_network_requests exists to
    # debug real traffic) but its secrets are stripped.
    merchant = capture('{"password":"hunter2","sku":"desk-lamp"}', url="https://merchant.example.com/checkout")
    assert "hunter2" not in merchant["request_body"], merchant
    assert "desk-lamp" in merchant["request_body"], merchant

def test_humanized_click_presses_and_releases_via_cdp_without_post_click_move():
    """The press must stay inside the sampled dwell AND the release must land off it.

    RCA (agent 8724eb5a): a Playwright move between down and up is a REMOTE round
    trip that inflated an ~85ms sampled dwell to 621.5ms emitted, so the submit's
    mousedown aged past the 500ms recent-gesture window and scored as a
    programmatic click (0.18296 -> 0.09456 once fixed). Releasing in place instead
    would trade that for a pixel-perfect down==up precision tell, and a post-click
    move races navigation the click itself triggers. CDP carries coordinates on the
    event, satisfying both with no trailing move.
    """
    import inspect

    from browser_tools.humanizer import BrowserHumanizer

    source = inspect.getsource(BrowserHumanizer.click_at_coords)
    press = source.index("_dispatch_mouse_button(down_x, down_y, pressed=True)")
    release = source.index("_dispatch_mouse_button(up_x, up_y, pressed=False)")
    sleep_at = source.index("asyncio.sleep(dwell_seconds)")
    assert press < sleep_at < release, "dwell must sit between the CDP press and release"

    # No move may follow the release: it would race click-triggered navigation.
    assert "mouse.move(up_x, up_y)" not in source, "post-click move reintroduces the navigation race"

    # A lost CDP session must still release, or the button wedges every later click.
    assert "await mouse.up()" in source, "fallback release missing"

def test_network_recorder_query_requests_filters_and_shapes():
    """BrowserNetworkRecorder.query_requests backs read_network_requests: newest-first
    url/method/status/resource_type, url_pattern filter, query-string redaction, and
    clear-after-read that ignores pre-clear in-flight requests."""
    from domains.spawn_browser_agent_v3.recording import (
        BrowserNetworkRecorder,
        _redact_url_query,
    )

    # Guard against mid-class module-level inserts orphaning query_requests (and
    # sibling methods) as dead nested defs — that AttributeError fails live Eventim
    # runs under the runtime-contract evaluator even after payment_approval.
    assert hasattr(BrowserNetworkRecorder, "query_requests")
    assert hasattr(BrowserNetworkRecorder, "close")
    assert hasattr(BrowserNetworkRecorder, "export_diagnostics_bundle_bytes")

    recorder = BrowserNetworkRecorder.__new__(BrowserNetworkRecorder)
    recorder._max_entries = 300
    recorder._max_body_bytes = 262144
    recorder._ignored_request_ids = set()
    recorder._active_request_ids = set()
    recorder._patterns = []
    recorder._bodies = {}
    recorder._body_byte_sizes = {}
    recorder._body_bytes = 0
    recorder.entries = {
        "1": {
            "request_id": "1",
            "url": "https://order.online/api/cart?token=SECRET&sig=abc#frag",
            "method": "POST",
            "status": 403,
            "resource_type": "XHR",
            "response_ts_ms": 200,
        },
        "2": {
            "request_id": "2",
            "url": "https://order.online/img.png",
            "method": "GET",
            "status": 200,
            "resource_type": "Image",
            "request_ts_ms": 100,
        },
    }
    filtered = recorder.query_requests(url_pattern="/api/", limit=10)
    # Query string + fragment (token/sig) redacted by default; path preserved.
    assert filtered == [
        {
            "id": "1",
            "url": "https://order.online/api/cart",
            "method": "POST",
            "status": 403,
            "resource_type": "XHR",
            "body_available": False,
        }
    ]
    assert len(recorder.query_requests(limit=10)) == 2

    # include_query is the explicit opt-in for the real request URL.
    unredacted = recorder.query_requests(url_pattern="/api/", include_query=True)
    assert unredacted[0]["url"] == "https://order.online/api/cart?token=SECRET&sig=abc#frag"

    # Filters: method, status (exact / class / 'error'), resource_type.
    assert [row["id"] for row in recorder.query_requests(method="post")] == ["1"]
    assert [row["id"] for row in recorder.query_requests(status="403")] == ["1"]
    assert [row["id"] for row in recorder.query_requests(status="4xx")] == ["1"]
    assert [row["id"] for row in recorder.query_requests(status="error")] == ["1"]
    assert [row["id"] for row in recorder.query_requests(status="ok")] == ["2"]
    assert [row["id"] for row in recorder.query_requests(resource_type="image")] == ["2"]

    # Redaction fails closed for every URL shape that can reach agent history:
    # embedded basic-auth credentials, authority-less URLs, and parse failures.
    assert _redact_url_query("https://user:pass@shop.test/path?token=SECRET#frag") == "https://shop.test/path"
    assert _redact_url_query("relative/path?token=SECRET#frag") == "relative/path"
    assert _redact_url_query("https://user:pass@[broken?token=SECRET#frag") == "https://[broken"
    assert _redact_url_query("//user:pass@shop.test/path?token=SECRET#frag") == "//shop.test/path"

    # A still-in-flight request (no status) at clear time must be ignored so its
    # late response event cannot resurrect a pre-clear entry.
    recorder.entries["3"] = {"url": "https://order.online/api/inflight", "method": "GET", "status": None}
    recorder._active_request_ids.add("3")
    recorder.query_requests(clear=True)
    assert recorder.entries == {}
    assert "3" in recorder._ignored_request_ids
    recorder._on_response_received(
        {"requestId": "3", "type": "XHR", "response": {"url": "https://order.online/api/inflight", "status": 200}},
        None,
    )
    assert recorder.entries == {}, "pre-clear in-flight request must not reappear"
    # Its terminal event clears the ignore flag (bounded set).
    recorder._on_loading_finished({"requestId": "3"}, None)
    assert "3" not in recorder._ignored_request_ids

def test_network_recorder_updates_status_at_capacity():
    """A request already tracked must still get its status update after the buffer
    is full, or 403/challenge detection breaks on busy pages (CodeRabbit #1).
    At capacity the buffer evicts the OLDEST request rather than refusing new
    ones — the tool reads newest-first, so refusing new requests made every API
    call after a heavy page load invisible."""
    from domains.spawn_browser_agent_v3.recording import BrowserNetworkRecorder

    recorder = BrowserNetworkRecorder.__new__(BrowserNetworkRecorder)
    recorder._max_entries = 1
    recorder._max_body_bytes = 262144
    recorder._ignored_request_ids = set()
    recorder._active_request_ids = set()
    recorder._patterns = []
    recorder._bodies = {}
    recorder._body_byte_sizes = {}
    recorder._body_bytes = 0
    recorder._started_at = 0.0
    recorder.entries = {"r1": {"request_id": "r1", "url": "https://x/api", "resource_type": "XHR", "status": None}}
    recorder._on_response_received(
        {
            "requestId": "r1",
            "type": "XHR",
            "response": {
                "url": "https://x/api",
                "status": 429,
                "mimeType": "application/octet-stream",
            },
        },
        None,
    )
    assert recorder.entries["r1"]["status"] == 429
    # A NEW request at capacity evicts the oldest instead of being dropped.
    recorder._on_request_will_be_sent(
        {"requestId": "r2", "type": "XHR", "request": {"url": "https://x/other", "method": "GET"}},
        None,
    )
    assert "r2" in recorder.entries
    assert "r1" not in recorder.entries

    # A request still in flight at clear time must be ignored so its late
    # response cannot refill the now-empty buffer with pre-clear traffic.
    recorder._on_request_will_be_sent(
        {"requestId": "r3", "type": "XHR", "request": {"url": "https://x/inflight", "method": "GET"}},
        None,
    )
    assert "r3" in recorder._active_request_ids
    recorder.query_requests(clear=True)
    assert "r3" in recorder._ignored_request_ids
    recorder._on_response_received(
        {"requestId": "r3", "type": "XHR", "response": {"url": "https://x/inflight", "status": 200}},
        None,
    )
    assert recorder.entries == {}
    recorder._on_loading_finished({"requestId": "r3"}, None)
    assert "r3" not in recorder._active_request_ids
    assert "r3" not in recorder._ignored_request_ids

def test_network_recorder_captures_every_resource_and_full_detail():
    """The tool must be able to answer ANY question about the page's traffic:
    non-XHR resources are visible, headers/post data/redirects are captured, and
    response bodies are readable back through query_requests."""
    from domains.spawn_browser_agent_v3.recording import BrowserNetworkRecorder

    recorder = BrowserNetworkRecorder.__new__(BrowserNetworkRecorder)
    recorder._max_entries = 100
    recorder._max_body_bytes = 262144
    recorder._max_total_body_bytes = 1_000_000
    recorder._ignored_request_ids = set()
    recorder._active_request_ids = set()
    recorder._patterns = []
    recorder._bodies = {}
    recorder._body_byte_sizes = {}
    recorder._body_bytes = 0
    recorder._started_at = 0.0
    recorder.entries = {}

    # A Stylesheet is NOT an XHR/Fetch/Document — the old predicate dropped it
    # entirely, so "what did this page load" was unanswerable.
    recorder._on_request_will_be_sent(
        {"requestId": "s1", "type": "Stylesheet", "request": {"url": "https://shop.test/app.css", "method": "GET"}},
        None,
    )
    assert "s1" in recorder.entries

    recorder._on_request_will_be_sent(
        {
            "requestId": "p1",
            "type": "XHR",
            "request": {
                "url": "https://shop.test/api/orders",
                "method": "POST",
                "headers": {"Content-Type": "application/json", "Cookie": "session=SECRET", "X-Csrf": "tok"},
                "postData": '{"store":"blue-bottle"}',
                "hasPostData": True,
            },
            "initiator": {"type": "script"},
        },
        None,
    )
    recorder._on_response_received(
        {
            "requestId": "p1",
            "type": "XHR",
            "response": {
                "url": "https://shop.test/api/orders",
                "status": 200,
                "statusText": "OK",
                "mimeType": "application/json",
                "headers": {"Content-Type": "application/json", "Set-Cookie": "session=SECRET"},
                "protocol": "h2",
            },
        },
        None,
    )
    recorder._store_body("p1", '{"orders":[{"merchant":"Blue Bottle"}]}')
    recorder.entries["p1"]["terminal"] = True

    # Summary row advertises that a body is waiting.
    summary = recorder.query_requests(url_pattern="/api/orders")[0]
    assert summary["body_available"] is True
    assert "response_body" not in summary

    detailed = recorder.query_requests(
        url_pattern="/api/orders",
        include_headers=True,
        include_bodies=True,
    )[0]
    assert detailed["response_body"] == '{"orders":[{"merchant":"Blue Bottle"}]}'
    assert detailed["request_body"] == '{"store":"blue-bottle"}'
    assert detailed["request_headers"]["content-type"] == "application/json"
    assert detailed["request_headers"]["x-csrf"] == "tok"
    # Live session credentials never enter turn history / provider logs.
    assert "SECRET" not in detailed["request_headers"]["cookie"]
    assert "SECRET" not in detailed["response_headers"]["set-cookie"]

    # max_body_chars caps each body and flags the truncation.
    capped = recorder.query_requests(url_pattern="/api/orders", include_bodies=True, max_body_chars=5)[0]
    assert capped["response_body"] == '{"ord'
    assert capped["response_body_truncated"] is True

    # A redirect chain is preserved rather than collapsed to the final hop.
    recorder._on_request_will_be_sent(
        {"requestId": "r9", "type": "Document", "request": {"url": "https://shop.test/login", "method": "POST"}},
        None,
    )
    recorder._on_request_will_be_sent(
        {
            "requestId": "r9",
            "type": "Document",
            "request": {"url": "https://shop.test/2fa", "method": "GET"},
            "redirectResponse": {"status": 302, "headers": {"location": "https://shop.test/2fa"}},
        },
        None,
    )
    redirected = recorder.query_requests(url_pattern="/2fa")[0]
    assert redirected["redirects"] == [{"url": "https://shop.test/login", "status": 302, "location": None}]

def test_network_recorder_body_cache_is_byte_bounded():
    """At 10k agents a long-lived page must not grow the worker heap: the body
    cache evicts oldest-first under a fixed byte budget."""
    from domains.spawn_browser_agent_v3.recording import BrowserNetworkRecorder

    recorder = BrowserNetworkRecorder.__new__(BrowserNetworkRecorder)
    recorder._bodies = {}
    recorder._body_byte_sizes = {}
    recorder._body_bytes = 0
    recorder._max_total_body_bytes = 100

    recorder._store_body("a", "x" * 60)
    recorder._store_body("b", "y" * 60)
    assert "a" not in recorder._bodies
    assert recorder._bodies["b"] == "y" * 60
    assert recorder._body_bytes == 60

    # A single body larger than the whole budget is still readable once (it is
    # already capped by _max_body_bytes upstream) and does not wedge the loop.
    recorder._store_body("c", "z" * 500)
    assert recorder._bodies == {"c": "z" * 500}

    # The budget is charged in ENCODED bytes. Counting characters would let a
    # non-ASCII payload occupy several times the configured cap in real memory,
    # which is the whole point of the bound (CodeRabbit #1).
    recorder._bodies.clear()
    recorder._body_byte_sizes.clear()
    recorder._body_bytes = 0
    # 40 chars, but 4 bytes each in UTF-8 = 160 bytes > the 100-byte budget.
    recorder._store_body("emoji", "\U0001f600" * 40)
    assert recorder._body_bytes == 160
    # A second body must evict it rather than stacking 320 bytes under a 100-byte cap.
    recorder._store_body("ascii", "a" * 50)
    assert "emoji" not in recorder._bodies
    assert recorder._body_bytes == 50
    assert recorder._body_byte_sizes == {"ascii": 50}

def test_network_recorder_request_body_truncates_on_bytes_not_chars():
    """POST data is capped by a BYTE budget, so truncation must count bytes.

    Character-count truncation let a non-ASCII payload (unicode form fields,
    CJK JSON) retain up to ~4x _max_body_bytes, multiplied across every
    retained request. CodeRabbit #2 on the incremental review.
    """
    from domains.spawn_browser_agent_v3.recording import _encoded_len, _truncate_text_to_bytes

    # 40 four-byte code points = 160 bytes.
    payload = "\U0001f600" * 40
    assert _encoded_len(payload) == 160
    assert len(payload) == 40

    kept = _truncate_text_to_bytes(payload, 100)
    # Byte-accurate: never exceeds the cap, and drops the partial code point
    # at the boundary rather than raising.
    assert _encoded_len(kept) <= 100
    assert kept == "\U0001f600" * 25
    # Under the cap the payload is returned untouched.
    assert _truncate_text_to_bytes("short", 100) == "short"
    assert _truncate_text_to_bytes(None, 100) is None

def test_network_recorder_redirect_location_survives_header_casing():
    """CDP preserves the server's header casing; real servers send "Location".

    Reading a hardcoded lowercase key off the RAW header bag returned None on
    every standard redirect, silently emptying the redirect chain's location.
    CodeRabbit #3 on the incremental review.
    """
    from domains.spawn_browser_agent_v3.recording import BrowserNetworkRecorder

    recorder = BrowserNetworkRecorder.__new__(BrowserNetworkRecorder)
    recorder._max_entries = 100
    recorder._max_body_bytes = 262144
    recorder._max_total_body_bytes = 1_000_000
    recorder._ignored_request_ids = set()
    recorder._active_request_ids = set()
    recorder._patterns = []
    recorder._bodies = {}
    recorder._body_byte_sizes = {}
    recorder._body_bytes = 0
    recorder._started_at = 0.0
    recorder.entries = {}

    recorder._on_request_will_be_sent(
        {
            "requestId": "r1",
            "request": {"url": "https://shop.test/login", "method": "POST"},
            "type": "Document",
        },
        "sess",
    )
    # Second requestWillBeSent for the SAME requestId carries the prior hop.
    recorder._on_request_will_be_sent(
        {
            "requestId": "r1",
            "request": {"url": "https://shop.test/2fa", "method": "GET"},
            "type": "Document",
            "redirectResponse": {
                "url": "https://shop.test/login",
                "status": 302,
                "headers": {"Location": "https://shop.test/2fa"},
            },
        },
        "sess",
    )

    entry = recorder.entries[recorder._request_key("r1")]
    assert len(entry["redirects"]) == 1
    assert entry["redirects"][0]["status"] == 302
    assert entry["redirects"][0]["location"] == "https://shop.test/2fa"

    rows = recorder.query_requests(include_query=True)
    assert rows[0]["redirects"][0]["location"] == "https://shop.test/2fa"
    assert isinstance(recorder, BrowserNetworkRecorder)

async def test_network_recorder_terminal_requests_do_not_accumulate_after_clear():
    """Finished and failed requests are terminal, not in flight. Repeated clears
    must not retain their IDs forever in the pre-clear ignore set."""
    from domains.spawn_browser_agent_v3.recording import BrowserNetworkRecorder

    recorder = BrowserNetworkRecorder.__new__(BrowserNetworkRecorder)
    recorder._max_entries = 300
    recorder._max_body_bytes = 262_144
    recorder._ignored_request_ids = set()
    recorder._active_request_ids = {"failed", "finished"}
    recorder._patterns = []
    recorder._bodies = {}
    recorder._body_byte_sizes = {}
    recorder._body_bytes = 0
    recorder._tasks = set()
    recorder._cdp_client = None
    recorder._fetch_response_body = AsyncMock()
    recorder.entries = {
        "failed": {"url": "https://x/failed", "status": None},
        "finished": {
            "url": "https://x/finished",
            "status": None,
            "resource_type": "XHR",
            "mime_type": "application/json",
        },
    }

    recorder._on_loading_failed({"requestId": "failed", "errorText": "blocked"}, None)
    recorder._on_loading_finished({"requestId": "finished", "encodedDataLength": 0}, None)
    await asyncio.sleep(0)

    assert recorder.entries["failed"]["terminal"] is True
    assert recorder.entries["finished"]["terminal"] is True
    recorder.query_requests(clear=True)
    recorder.query_requests(clear=True)
    assert recorder._ignored_request_ids == set()

async def test_network_recorder_emits_one_explicit_fingerprint_exit_rejection_per_browser():
    """Only the exact structured detector verdict may trigger provider search.

    Duplicate responses from one browser and late bodies from a discarded browser
    must not schedule extra recovery runs.
    """
    from domains.spawn_browser_agent_v3.recording import BrowserNetworkRecorder

    recorder = BrowserNetworkRecorder.__new__(BrowserNetworkRecorder)
    recorder._closed = False
    recorder._max_body_bytes = 262_144
    recorder._body_index = 0
    recorder._started_at = 0.0
    recorder._network_generation = 4
    recorder._provider_exit_rejections = []
    recorder._rejected_network_generations = set()
    recorder._bodies = {}
    recorder._body_byte_sizes = {}
    recorder._body_bytes = 0
    recorder._max_total_body_bytes = 1_000_000
    recorder.persists_network_log = False
    recorder.agent_id = "agent"
    recorder.task_id = "task"
    recorder.entries = {
        "4:r1": {
            "browser_generation": 4,
            "mime_type": "application/json",
            "url": "https://shop.test/verify?token=secret",
        }
    }
    poison_body = {
        "score": 0.087,
        "detections": [
            {
                "category": "fingerprint",
                "reason": "IP has used many different fingerprints",
            }
        ],
    }
    get_body = AsyncMock(return_value={"body": json.dumps(poison_body), "base64Encoded": False})
    client = SimpleNamespace(send=SimpleNamespace(Network=SimpleNamespace(getResponseBody=get_body)))

    await recorder._fetch_response_body("4:r1", "r1", "cdp-4", client)
    rejection = recorder.pop_provider_exit_rejection()
    assert rejection == {
        "reason": "ip has used many different fingerprints",
        "url": "https://shop.test/verify",
        "browser_generation": 4,
    }
    # Monitor-only sessions keep request metadata so read_network_requests works
    # in prod; growth is bounded by entry eviction + the body byte budget rather
    # than by discarding every entry.
    assert "4:r1" in recorder.entries
    assert recorder.pop_provider_exit_rejection() is None

    # A duplicate verdict on the same exit is one recovery signal, not a loop.
    await recorder._fetch_response_body("4:r1", "r1", "cdp-4", client)
    assert recorder.pop_provider_exit_rejection() is None

    # A late body from the outgoing generation cannot poison the promoted one.
    recorder._network_generation = 5
    recorder._rejected_network_generations.clear()
    await recorder._fetch_response_body("4:r1", "r1", "cdp-4", client)
    assert recorder.pop_provider_exit_rejection() is None

    # Scores and prose alone are intentionally insufficient.
    recorder.entries["5:r2"] = {
        "browser_generation": 5,
        "mime_type": "application/json",
        "url": "https://shop.test/score",
    }
    get_body.return_value = {
        "body": json.dumps({"score": 0.9, "message": "IP has used many different fingerprints"}),
        "base64Encoded": False,
    }
    await recorder._fetch_response_body("5:r2", "r2", "cdp-5", client)
    assert recorder.pop_provider_exit_rejection() is None
    assert "5:r2" in recorder.entries

async def test_network_recorder_does_not_reject_successful_fingerprint_warning():
    """A detector warning inside an accepted response is not a provider exit.

    This is the exact response shape captured from FCaptcha immediately before
    the browser runtime unnecessarily replaced its next action with challenge
    recovery.
    """
    from domains.spawn_browser_agent_v3.recording import BrowserNetworkRecorder

    recorder = BrowserNetworkRecorder.__new__(BrowserNetworkRecorder)
    recorder._closed = False
    recorder._max_body_bytes = 262_144
    recorder._body_index = 0
    recorder._started_at = 0.0
    recorder._network_generation = 1
    recorder._provider_exit_rejections = []
    recorder._rejected_network_generations = set()
    recorder._bodies = {}
    recorder._body_byte_sizes = {}
    recorder._body_bytes = 0
    recorder._max_total_body_bytes = 1_000_000
    recorder.persists_network_log = False
    recorder.agent_id = "agent"
    recorder.task_id = "task"
    recorder.entries = {
        "1:r1": {
            "browser_generation": 1,
            "mime_type": "application/json",
            "url": "https://fcaptcha.webdecoy.com/api/verify",
        }
    }
    accepted_body = {
        "success": True,
        "score": 0.087,
        "recommendation": "allow",
        "categoryScores": {"fingerprint": 0.6},
        "detections": [
            {
                "category": "fingerprint",
                "score": 0.6,
                "confidence": 0.6,
                "reason": "IP has used many different fingerprints",
            }
        ],
    }
    get_body = AsyncMock(return_value={"body": json.dumps(accepted_body), "base64Encoded": False})
    client = SimpleNamespace(send=SimpleNamespace(Network=SimpleNamespace(getResponseBody=get_body)))

    await recorder._fetch_response_body("1:r1", "r1", "cdp-1", client)

    assert recorder.pop_provider_exit_rejection() is None
    assert recorder._rejected_network_generations == set()
    assert "1:r1" in recorder.entries

    recorder.entries["1:r2"] = {
        "browser_generation": 1,
        "mime_type": "application/json",
        "url": "https://shop.test/provider-exit",
    }
    get_body.return_value = {
        "body": json.dumps(
            {
                **accepted_body,
                "providerExit": {
                    "category": "fingerprint",
                    "reason": "IP has used many different fingerprints",
                },
            }
        ),
        "base64Encoded": False,
    }
    await recorder._fetch_response_body("1:r2", "r2", "cdp-1", client)

    assert recorder.pop_provider_exit_rejection() == {
        "reason": "ip has used many different fingerprints",
        "url": "https://shop.test/provider-exit",
        "browser_generation": 1,
    }


def test_api_challenge_html_large_cart_interstitial_without_classic_markers():
    """Eventim custom 403 interstitial is large HTML without classic CF markers."""
    from domains.spawn_browser_agent_v3.recording import _is_api_challenge_html_response

    large_html = (
        b"<!doctype html><html lang='en'><head><title>page title</title></head>"
        + (b"x" * 25_000)
        + b"<body>blocked</body></html>"
    )
    assert _is_api_challenge_html_response(
        status=403,
        url="https://wl.eventim.us/event/_/692405/order/checkaddtocart",
        resource_type="xhr",
        mime_type="text/html; charset=utf-8",
        body_bytes=large_html,
    )
    assert _is_api_challenge_html_response(
        status=403,
        url="https://wl.eventim.us/event/_/692405/order/checkaddtocart",
        resource_type="xhr",
        mime_type="text/html; charset=utf-8",
        body_bytes=large_html,
        document_url="https://wl.eventim.us/checkout",
    )
    assert not _is_api_challenge_html_response(
        status=403,
        url="https://wl.eventim.us/event/_/692405/order/checkaddtocart",
        resource_type="xhr",
        mime_type="text/html; charset=utf-8",
        body_bytes=large_html,
        document_url="https://cdn.attacker.example/frame",
    )
    assert not _is_api_challenge_html_response(
        status=403,
        url="https://wl.eventim.us/event/_/692405/order/checkaddtocart",
        resource_type="xhr",
        mime_type="text/html",
        body_bytes=b"<html><body>forbidden</body></html>",
    )
    assert not _is_api_challenge_html_response(
        status=403,
        url="https://cdn.example.com/assets/font.woff2",
        resource_type="xhr",
        mime_type="text/html",
        body_bytes=large_html,
    )


async def test_api_challenge_html_triggers_provider_exit_rejection():
    """403 challenge HTML on checkaddtocart must rotate exit (cookie GET probes miss it)."""
    from domains.spawn_browser_agent_v3.recording import (
        BrowserNetworkRecorder,
        _API_CHALLENGE_HTML_REASON,
        _is_api_challenge_html_response,
    )

    challenge_html = (
        b"<!DOCTYPE html><html><body>Access Denied. "
        b"<script src='/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1'></script>"
        b"</body></html>"
    )
    assert _is_api_challenge_html_response(
        status=403,
        url="https://wl.eventim.us/event/_/692405/order/checkaddtocart",
        resource_type="xhr",
        mime_type="text/html",
        body_bytes=challenge_html,
    )
    assert not _is_api_challenge_html_response(
        status=200,
        url="https://wl.eventim.us/event/_/692405/order/checkaddtocart",
        resource_type="xhr",
        mime_type="text/html",
        body_bytes=challenge_html,
    )
    assert not _is_api_challenge_html_response(
        status=403,
        url="https://wl.eventim.us/event/_/692405/order/checkaddtocart",
        resource_type="image",
        mime_type="text/html",
        body_bytes=challenge_html,
    )

    recorder = BrowserNetworkRecorder.__new__(BrowserNetworkRecorder)
    recorder._closed = False
    recorder._network_generation = 1
    recorder._provider_exit_rejections = []
    recorder._rejected_network_generations = set()
    recorder._api_challenge_provider_exits = 0
    recorder._started_at = 0.0
    recorder._max_body_bytes = 1_000_000
    recorder._max_total_body_bytes = 10_000_000
    recorder._body_index = 0
    recorder._bodies = {}
    recorder._body_byte_sizes = {}
    recorder._body_bytes = 0
    recorder.persists_network_log = False
    recorder.agent_id = "agent"
    recorder.task_id = "task"
    recorder.entries = {
        "1:r1": {
            "browser_generation": 1,
            "url": "https://wl.eventim.us/event/_/692405/order/checkaddtocart",
            "resource_type": "xhr",
            "mime_type": "text/html",
            "status": 403,
        }
    }

    class _FakeCdp:
        class send:
            class Network:
                @staticmethod
                async def getResponseBody(params=None, session_id=None):
                    return {"body": challenge_html.decode("utf-8"), "base64Encoded": False}

    await recorder._fetch_response_body("1:r1", "r1", "cdp-1", _FakeCdp())
    assert recorder.pop_provider_exit_rejection() == {
        "reason": _API_CHALLENGE_HTML_REASON,
        "url": "https://wl.eventim.us/event/_/692405/order/checkaddtocart",
        "browser_generation": 1,
        "status": 403,
    }


def test_payment_cdn_tunnel_failure_triggers_provider_exit_rejection():
    """js.stripe.com ERR_TUNNEL / ORB must rotate the provider exit (Eventim card fields)."""
    from domains.spawn_browser_agent_v3.recording import (
        BrowserNetworkRecorder,
        _document_warrants_payment_cdn_exit,
        _is_critical_resource_block,
        _is_payment_cdn_tunnel_failure,
    )

    assert _is_payment_cdn_tunnel_failure(
        "https://js.stripe.com/v3/",
        "net::ERR_TUNNEL_CONNECTION_FAILED",
    )
    assert _is_critical_resource_block(
        "https://js.stripe.com/v3/",
        "net::ERR_BLOCKED_BY_ORB",
        resource_type="script",
    )
    assert _is_critical_resource_block(
        "https://cdn.example/checkout-widget.js",
        "net::ERR_TUNNEL_CONNECTION_FAILED",
        resource_type="script",
    )
    assert _is_critical_resource_block(
        "https://cdn.example/checkout-widget.js",
        "net::ERR_TUNNEL_CONNECTION_FAILED",
        resource_type="script",
        document_url="https://checkout.eventim.us/pay",
    )
    assert not _is_critical_resource_block(
        "https://checkout.eventim.us/static/app.js",
        "net::ERR_TUNNEL_CONNECTION_FAILED",
        resource_type="script",
        document_url="https://checkout.eventim.us/pay",
    )
    assert _is_critical_resource_block(
        "https://js.stripe.com/v3/",
        "net::ERR_BLOCKED_BY_ORB",
        resource_type="script",
        document_url="https://checkout.eventim.us/pay",
    )
    assert not _is_critical_resource_block(
        "https://www.google-analytics.com/analytics.js",
        "net::ERR_BLOCKED_BY_CLIENT",
        resource_type="script",
    )
    # Non-js.* hosts are not the sticky script-CDN tunnel class (generic script path).
    assert not _is_payment_cdn_tunnel_failure(
        "https://wl.eventim.us/asset.js",
        "net::ERR_TUNNEL_CONNECTION_FAILED",
    )
    assert not _is_payment_cdn_tunnel_failure(
        "https://js.stripe.com/v3/",
        "net::ERR_NAME_NOT_RESOLVED",
    )
    assert _document_warrants_payment_cdn_exit("https://wl.eventim.us/checkout/abc")
    # Inventory paths are no longer excluded — exit caps bound thrash instead.
    assert _document_warrants_payment_cdn_exit(
        "https://wl.eventim.us/event/lyny/692405?afflky=1015Folsom"
    )
    assert not _document_warrants_payment_cdn_exit("")

    recorder = BrowserNetworkRecorder.__new__(BrowserNetworkRecorder)
    recorder._network_generation = 3
    recorder._provider_exit_rejections = []
    recorder._rejected_network_generations = set()
    recorder._payment_cdn_provider_exits = 0
    recorder._generic_script_provider_exits = 0
    recorder._ignored_request_ids = set()
    recorder._active_request_ids = set()
    recorder.agent_id = "agent"
    recorder.task_id = "task"
    recorder.entries = {
        "3:r1": {
            "browser_generation": 3,
            "url": "https://js.stripe.com/v3/",
            "document_url": "https://wl.eventim.us/checkout/order-1",
        }
    }
    recorder._on_loading_failed(
        {"requestId": "r1", "errorText": "net::ERR_TUNNEL_CONNECTION_FAILED"},
        session_id="cdp-3",
        generation=3,
    )
    assert recorder.pop_provider_exit_rejection() == {
        "reason": "critical third-party resource blocked",
        "url": "https://js.stripe.com/v3/",
        "browser_generation": 3,
        "document_url": "https://wl.eventim.us/checkout/order-1",
    }
    from domains.spawn_browser_agent_v3.recording import blocked_resource_url_for_recovery

    assert (
        blocked_resource_url_for_recovery(
            {
                "reason": "critical third-party resource blocked",
                "url": "https://js.stripe.com/v3/",
            }
        )
        == "https://js.stripe.com/v3/"
    )
    # Same-origin API-challenge exits must not hard-fail promote re-verify.
    assert (
        blocked_resource_url_for_recovery(
            {
                "reason": "same-origin API returned Cloudflare challenge HTML",
                "url": "https://wl.eventim.us/event/_/686363/order/checkaddtocart",
            }
        )
        is None
    )
    # One signal per browser generation — no recovery loop on repeated stripe fails.
    recorder._on_loading_failed(
        {"requestId": "r1", "errorText": "net::ERR_TUNNEL_CONNECTION_FAILED"},
        session_id="cdp-3",
        generation=3,
    )
    assert recorder.pop_provider_exit_rejection() is None

    # api.stripe.com/healthcheck must NOT rotate exits: steel often fails it
    # while Stripe.js loads (paymentCdnOk). Burning the slot stranded Eventim.
    api_only = BrowserNetworkRecorder.__new__(BrowserNetworkRecorder)
    api_only._network_generation = 4
    api_only._provider_exit_rejections = []
    api_only._rejected_network_generations = set()
    api_only._payment_cdn_provider_exits = 0
    api_only._generic_script_provider_exits = 0
    api_only._ignored_request_ids = set()
    api_only._active_request_ids = set()
    api_only.agent_id = "agent"
    api_only.task_id = "task"
    api_only.entries = {
        "4:r-api": {
            "browser_generation": 4,
            "url": "https://api.stripe.com/healthcheck",
            "document_url": "https://checkout.eventim.us/",
            "resource_type": "xhr",
        }
    }
    api_only._on_loading_failed(
        {"requestId": "r-api", "errorText": "net::ERR_TUNNEL_CONNECTION_FAILED"},
        session_id="cdp-4",
        generation=4,
    )
    assert api_only.pop_provider_exit_rejection() is None
    assert api_only._payment_cdn_provider_exits == 0

    # Cap=2: a second browser generation may still rotate on js.stripe.com after
    # the first Kernel→Steel promote consumed exit #1.
    second_gen = BrowserNetworkRecorder.__new__(BrowserNetworkRecorder)
    second_gen._network_generation = 5
    second_gen._provider_exit_rejections = []
    second_gen._rejected_network_generations = {3}
    second_gen._payment_cdn_provider_exits = 1
    second_gen._generic_script_provider_exits = 0
    second_gen._ignored_request_ids = set()
    second_gen._active_request_ids = set()
    second_gen.agent_id = "agent"
    second_gen.task_id = "task"
    second_gen.entries = {
        "5:r3": {
            "browser_generation": 5,
            "url": "https://js.stripe.com/v3/",
            "document_url": "https://checkout.eventim.us/",
        }
    }
    second_gen._on_loading_failed(
        {"requestId": "r3", "errorText": "net::ERR_TUNNEL_CONNECTION_FAILED"},
        session_id="cdp-5",
        generation=5,
    )
    assert second_gen.pop_provider_exit_rejection() == {
        "reason": "critical third-party resource blocked",
        "url": "https://js.stripe.com/v3/",
        "browser_generation": 5,
        "document_url": "https://checkout.eventim.us/",
    }
    assert second_gen._payment_cdn_provider_exits == 2

    # Ticket/event browse pages may still rotate on critical script CDN blocks;
    # exit caps (not path allowlists) bound thrash.
    browse = BrowserNetworkRecorder.__new__(BrowserNetworkRecorder)
    browse._network_generation = 1
    browse._provider_exit_rejections = []
    browse._rejected_network_generations = set()
    browse._payment_cdn_provider_exits = 0
    browse._generic_script_provider_exits = 0
    browse._ignored_request_ids = set()
    browse._active_request_ids = set()
    browse.agent_id = "agent"
    browse.task_id = "task"
    browse.entries = {
        "1:r2": {
            "browser_generation": 1,
            "url": "https://js.cdn.example/v3/",
            "document_url": "https://shop.example.com/event/lyny/692405",
        }
    }
    browse._on_loading_failed(
        {"requestId": "r2", "errorText": "net::ERR_TUNNEL_CONNECTION_FAILED"},
        session_id="cdp-1",
        generation=1,
    )
    assert browse.pop_provider_exit_rejection() == {
        "reason": "critical third-party resource blocked",
        "url": "https://js.cdn.example/v3/",
        "browser_generation": 1,
        "document_url": "https://shop.example.com/event/lyny/692405",
    }

    # Consent/chat widget script blocks must not consume the payment-CDN budget.
    widget = BrowserNetworkRecorder.__new__(BrowserNetworkRecorder)
    widget._network_generation = 7
    widget._provider_exit_rejections = []
    widget._rejected_network_generations = set()
    widget._payment_cdn_provider_exits = 0
    widget._generic_script_provider_exits = 0
    widget._ignored_request_ids = set()
    widget._active_request_ids = set()
    widget.agent_id = "agent"
    widget.task_id = "task"
    widget.entries = {
        "7:r-widget": {
            "browser_generation": 7,
            "url": "https://cdn.consentmanager.net/delivery/cmp.js",
            "document_url": "https://checkout.eventim.us/",
            "resource_type": "script",
        }
    }
    widget._on_loading_failed(
        {"requestId": "r-widget", "errorText": "net::ERR_BLOCKED_BY_CLIENT"},
        session_id="cdp-7",
        generation=7,
    )
    assert widget.pop_provider_exit_rejection() is not None
    assert widget._generic_script_provider_exits == 1
    assert widget._payment_cdn_provider_exits == 0
    # A later Stripe block on a new generation still has its reserved budget.
    widget._network_generation = 8
    widget.entries = {
        "8:r-stripe": {
            "browser_generation": 8,
            "url": "https://js.stripe.com/v3/",
            "document_url": "https://checkout.eventim.us/",
            "resource_type": "script",
        }
    }
    widget._on_loading_failed(
        {"requestId": "r-stripe", "errorText": "net::ERR_BLOCKED_BY_ORB"},
        session_id="cdp-8",
        generation=8,
    )
    assert widget.pop_provider_exit_rejection() == {
        "reason": "critical third-party resource blocked",
        "url": "https://js.stripe.com/v3/",
        "browser_generation": 8,
        "document_url": "https://checkout.eventim.us/",
    }
    assert widget._payment_cdn_provider_exits == 1
    assert widget._generic_script_provider_exits == 1

    # Non-js.* cross-origin scripts charge the generic budget (no vendor hosts).
    mobile = BrowserNetworkRecorder.__new__(BrowserNetworkRecorder)
    mobile._network_generation = 9
    mobile._provider_exit_rejections = []
    mobile._rejected_network_generations = set()
    mobile._payment_cdn_provider_exits = 0
    mobile._generic_script_provider_exits = 0
    mobile._ignored_request_ids = set()
    mobile._active_request_ids = set()
    mobile.agent_id = "agent"
    mobile.task_id = "task"
    mobile._network_generation += 1
    generation = mobile._network_generation
    mobile.entries = {
        f"{generation}:r-widget": {
            "browser_generation": generation,
            "url": "https://cdn.widgets.example/inner-script.js",
            "document_url": "https://checkout.example.com/",
            "resource_type": "script",
        }
    }
    mobile._on_loading_failed(
        {"requestId": "r-widget", "errorText": "net::ERR_BLOCKED_BY_ORB"},
        session_id=f"cdp-{generation}",
        generation=generation,
    )
    assert mobile.pop_provider_exit_rejection() is not None
    assert mobile._payment_cdn_provider_exits == 0
    assert mobile._generic_script_provider_exits == 1

    # js.* hosts charge the script-CDN budget.
    js_cdn = BrowserNetworkRecorder.__new__(BrowserNetworkRecorder)
    js_cdn._network_generation = 11
    js_cdn._provider_exit_rejections = []
    js_cdn._rejected_network_generations = set()
    js_cdn._payment_cdn_provider_exits = 0
    js_cdn._generic_script_provider_exits = 0
    js_cdn._ignored_request_ids = set()
    js_cdn._active_request_ids = set()
    js_cdn.agent_id = "agent"
    js_cdn.task_id = "task"
    js_cdn.entries = {
        "11:r-js": {
            "browser_generation": 11,
            "url": "https://js.cdn.example/v3/",
            "document_url": "https://checkout.example.com/",
            "resource_type": "script",
        }
    }
    js_cdn._on_loading_failed(
        {"requestId": "r-js", "errorText": "net::ERR_BLOCKED_BY_ORB"},
        session_id="cdp-11",
        generation=11,
    )
    assert js_cdn.pop_provider_exit_rejection() is not None
    assert js_cdn._payment_cdn_provider_exits == 1
    assert js_cdn._generic_script_provider_exits == 0


def test_evicted_critical_request_meta_still_rejects_network_generation():
    """Entry eviction must not drop provider-exit classification for in-flight critical scripts.

    With a 1-entry capture buffer, a later request evicts js.stripe.com from
    ``entries`` before loadingFailed arrives. The active meta map must retain
    enough fields for the failure event to reject the network generation.
    """
    from domains.spawn_browser_agent_v3.recording import BrowserNetworkRecorder

    recorder = BrowserNetworkRecorder.__new__(BrowserNetworkRecorder)
    recorder._network_generation = 3
    recorder._max_entries = 1
    recorder._max_active_request_meta = 256
    recorder._provider_exit_rejections = []
    recorder._rejected_network_generations = set()
    recorder._payment_cdn_provider_exits = 0
    recorder._generic_script_provider_exits = 0
    recorder._ignored_request_ids = set()
    recorder._active_request_ids = set()
    recorder._active_request_meta = {}
    recorder._patterns = []
    recorder._bodies = {}
    recorder._body_byte_sizes = {}
    recorder._body_bytes = 0
    recorder._started_at = 0.0
    recorder._max_body_bytes = 262144
    recorder.agent_id = "agent"
    recorder.task_id = "task"
    recorder.entries = {}

    recorder._on_request_will_be_sent(
        {
            "requestId": "stripe",
            "type": "Script",
            "documentURL": "https://checkout.eventim.us/pay",
            "request": {"url": "https://js.stripe.com/v3/", "method": "GET"},
        },
        session_id="cdp-3",
        generation=3,
    )
    stripe_key = "3:stripe"
    assert stripe_key in recorder.entries
    assert stripe_key in recorder._active_request_meta

    # Later request fills the 1-entry buffer and evicts the Stripe capture row.
    recorder._on_request_will_be_sent(
        {
            "requestId": "other",
            "type": "XHR",
            "documentURL": "https://checkout.eventim.us/pay",
            "request": {"url": "https://checkout.eventim.us/api/ping", "method": "GET"},
        },
        session_id="cdp-3",
        generation=3,
    )
    assert "3:other" in recorder.entries
    assert stripe_key not in recorder.entries
    assert stripe_key in recorder._active_request_meta
    assert recorder._active_request_meta[stripe_key]["url"] == "https://js.stripe.com/v3/"

    recorder._on_loading_failed(
        {"requestId": "stripe", "errorText": "net::ERR_TUNNEL_CONNECTION_FAILED"},
        session_id="cdp-3",
        generation=3,
    )
    assert recorder.pop_provider_exit_rejection() == {
        "reason": "critical third-party resource blocked",
        "url": "https://js.stripe.com/v3/",
        "browser_generation": 3,
        "document_url": "https://checkout.eventim.us/pay",
    }
    assert 3 in recorder._rejected_network_generations
    assert stripe_key not in recorder._active_request_meta
    assert stripe_key not in recorder._active_request_ids

    # Successful finish for the surviving request also clears its meta.
    # Point at a binary URL so the finish path skips body fetch (no CDP client).
    recorder._cdp_client = None
    recorder._tasks = set()
    recorder._closed = False
    recorder.entries["3:other"]["url"] = "https://checkout.eventim.us/static/pixel.png"
    recorder._on_loading_finished(
        {"requestId": "other", "encodedDataLength": 12},
        session_id="cdp-3",
        generation=3,
    )
    assert "3:other" not in recorder._active_request_meta
    assert "3:other" not in recorder._active_request_ids
    assert recorder.entries["3:other"].get("terminal") is True


async def test_provider_exit_monitor_runs_without_production_body_log_persistence():
    """Disabling local recordings must not disable the lightweight prod signal."""
    import tempfile

    from domains.spawn_browser_agent_v3.recording import BrowserNetworkRecorder

    register = SimpleNamespace(
        Network=SimpleNamespace(
            requestWillBeSent=MagicMock(),
            responseReceived=MagicMock(),
            loadingFinished=MagicMock(),
            loadingFailed=MagicMock(),
        )
    )
    send = SimpleNamespace(Network=SimpleNamespace(enable=AsyncMock()))
    cdp_client = SimpleNamespace(register=register, send=send)
    browser_session = SimpleNamespace(
        cdp_client=cdp_client,
        get_or_create_cdp_session=AsyncMock(return_value=SimpleNamespace(session_id="cdp-prod")),
    )
    previous = {
        name: os.environ.get(name)
        for name in (
            "BROWSER_AGENT_RECORDINGS",
            "BROWSER_AGENT_NETWORK_RECORDING",
            "BROWSER_AGENT_PROVIDER_EXIT_MONITORING",
        )
    }
    try:
        os.environ["BROWSER_AGENT_RECORDINGS"] = "0"
        os.environ["BROWSER_AGENT_NETWORK_RECORDING"] = "0"
        os.environ["BROWSER_AGENT_PROVIDER_EXIT_MONITORING"] = "1"
        with tempfile.TemporaryDirectory() as tmp:
            recorder = await BrowserNetworkRecorder.create(
                browser_session=browser_session,
                agent_id="agent-prod",
                task_id="task-prod",
                session_id="session-prod",
                output_dir=Path(tmp) / "recording",
            )
            assert recorder is not None
            assert recorder.persists_network_log is False
            assert recorder.network_dir.exists()
            assert recorder.console_dir.exists()
            index_path = await recorder.close()
            assert index_path == recorder.network_index_path
            assert index_path.exists()
            assert recorder.console_index_path.exists()
            assert sorted(path.name for path in recorder.network_dir.iterdir()) == ["index.json"]
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value

async def test_execute_action_read_network_requests():
    """execute_action forwards every filter/detail flag to the recorder and errors
    only when no recorder is attached (never a silent success)."""
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()

    recorder = MagicMock()
    recorder.query_requests = MagicMock(
        return_value=[{"url": "https://x/api", "method": "GET", "status": 429, "resource_type": "Fetch"}]
    )
    out = await execute_action(
        dom,
        ah,
        {
            "action": "read_network_requests",
            "params": {
                "url_pattern": "/api/",
                "method": "POST",
                "status": "4xx",
                "resource_type": "XHR",
                "limit": 5,
                "clear": True,
                "include_query": True,
                "include_headers": True,
                "include_bodies": True,
                "max_body_chars": 1234,
            },
        },
        browser_network_recorder=recorder,
    )
    assert out["success"] is True
    assert out["requests"][0]["status"] == 429
    recorder.query_requests.assert_called_once_with(
        url_pattern="/api/",
        method="POST",
        status="4xx",
        resource_type="XHR",
        limit=5,
        clear=True,
        include_query=True,
        include_headers=True,
        include_bodies=True,
        max_body_chars=1234,
    )

    # Defaults: summary rows, no bodies, no headers, no query strings.
    recorder.query_requests.reset_mock()
    await execute_action(
        dom,
        ah,
        {"action": "read_network_requests", "params": {}},
        browser_network_recorder=recorder,
    )
    recorder.query_requests.assert_called_once_with(
        url_pattern="",
        method="",
        status="",
        resource_type="",
        limit=100,
        clear=False,
        include_query=False,
        include_headers=False,
        include_bodies=False,
        max_body_chars=4000,
    )

    # A summary read that hides available bodies must SAY bodies are available.
    # Without this the model concludes "this tool can't return bodies" and gives up.
    recorder.query_requests = MagicMock(
        return_value=[{"url": "https://x/api", "method": "GET", "status": 200, "body_available": True}]
    )
    hinted = await execute_action(
        dom,
        ah,
        {"action": "read_network_requests", "params": {}},
        browser_network_recorder=recorder,
    )
    assert "include_bodies=true" in hinted["message"]

    out_none = await execute_action(dom, ah, {"action": "read_network_requests", "params": {}})
    assert out_none["success"] is False
    assert "not attached" in out_none["error"]

    # Monitoring-only sessions (local body-log persistence off, i.e. prod) still
    # serve reads from the in-memory buffer — the tool is not dev-only.
    monitor_only = MagicMock(persists_network_log=False)
    monitor_only.query_requests = MagicMock(return_value=[])
    out_monitor = await execute_action(
        dom,
        ah,
        {"action": "read_network_requests", "params": {}},
        browser_network_recorder=monitor_only,
    )
    assert out_monitor["success"] is True
    monitor_only.query_requests.assert_called_once()

async def test_execute_action_request_payment_card_requests_workflow_approval():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    payment_request = {
        "merchant": "Rose Labs Test Payment",
        "line_items": [
            {
                "name": "Aurora Notebook",
                "product_url": "https://example.test/products/aurora-notebook",
                "rating": "4.9 stars",
                "review_count": "217 reviews",
                "unit_price_cents": 1200,
                "quantity": 1,
                "line_total_cents": 1200,
            }
        ],
        "subtotal_cents": 1200,
        "total_cents": 4396,
    }

    out = await execute_action(
        dom,
        ah,
        {"action": "request_payment_card", "params": payment_request},
        current_url="https://example.test/checkout",
    )

    assert out["status"] == "awaiting_payment_card_approval"
    assert out["payment_request"] == payment_request
    assert out["current_url"] == "https://example.test/checkout"

async def test_execute_action_request_payment_card_rejects_empty_receipt():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()

    out = await execute_action(
        dom,
        ah,
        {"action": "request_payment_card", "params": {"merchant": "Rose Labs Test Payment"}},
        current_url="https://example.test/checkout",
    )

    assert out["success"] is False
    assert "line_items" in out["error"]
    assert "subtotal_cents" in out["error"]
    assert "total_cents" in out["error"]

async def test_execute_action_request_payment_card_accepts_current_session_product_link():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    current_url = "https://example.test/session/abc"
    out = await execute_action(
        dom,
        ah,
        {
            "action": "request_payment_card",
            "params": {
                "merchant": "Example Shop",
                "line_items": [
                    {
                        "name": "Beanie",
                        "product_url": current_url,
                        "rating": "4.8 stars",
                        "review_count": "312 reviews",
                        "unit_price_cents": 1200,
                        "quantity": 1,
                        "line_total_cents": 1200,
                    }
                ],
                "subtotal_cents": 1200,
                "total_cents": 1200,
            },
        },
        current_url=current_url,
    )

    # Accepted by decision: product_url is validated for well-formedness only, so
    # submitting the current session URL is no longer an error. Pinned so the
    # removed page-type rule cannot creep back in silently.
    assert "error" not in out, out
    assert out["status"] == "awaiting_payment_card_approval"
    assert out["payment_request"]

async def test_execute_action_request_payment_card_rejects_duplicate_after_card_ready():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()

    out = await execute_action(
        dom,
        ah,
        {"action": "request_payment_card", "params": {}},
        current_url="https://example.test/checkout",
        secret_refs={
            "card_number": "4111111111111111",
            "card_name": "Rose Labs",
            "card_expiry": "12/30",
            "card_cvv": "123",
        },
    )

    assert out["success"] is False
    assert "already complete" in out["error"]
    assert "Do not call request_payment_card again" in out["error"]
    assert "card_number" in out["error"]
    assert "line_items" not in out["error"]

async def test_execute_action_dropdown_options_missing_element():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "dropdown_options"})
    assert out["success"] is False

async def test_execute_action_select_dropdown_missing_element():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "select_dropdown", "params": {"value": "x"}})
    assert out["success"] is False

async def test_execute_action_attempt_completion():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "attempt_completion"})
    assert out["success"] is True
    assert out["attempt_completion"] is True

async def test_execute_action_send_message_to_user():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(
        dom,
        ah,
        {
            "action": "send_message_to_user",
            "params": {"message": "help", "reason": "captcha"},
        },
    )
    assert out["success"] is True
    assert out["message_to_user"] is True
    assert out["reason"] == "captcha"

async def test_execute_action_done():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "done", "params": {"text": "finished"}})
    assert out["success"] is True
    assert out["done"] is True
    assert out["message"] == "finished"

async def test_execute_action_click_no_element_no_coords():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "click"}, write_lock_enabled=False)
    assert out["success"] is False

async def test_execute_action_upload_file_missing_filename():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "upload_file", "params": {}})
    assert out["success"] is False
    assert "filename" in out["error"]

async def test_execute_action_upload_file_not_in_available():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(
        dom,
        ah,
        {"action": "upload_file", "params": {"filename": "x.pdf"}},
        available_file_paths={"other.pdf": "/tmp/other.pdf"},
    )
    assert out["success"] is False

async def test_execute_action_switch_tab_missing_id():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "switch_tab", "params": {}})
    assert out["success"] is False

async def test_execute_action_press_key_with_humanizer():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    hu = MagicMock()
    hu.press_key = AsyncMock()
    out = await execute_action(
        dom,
        ah,
        {"action": "press_key", "params": {"key": "Enter"}},
        humanizer=hu,
    )
    assert out == {"success": True, "message": ""}
    hu.press_key.assert_awaited_once_with("Enter")
    ah.record_action.assert_awaited()

async def test_execute_action_scroll_with_humanizer_down():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    hu = MagicMock()
    hu.scroll = AsyncMock()
    out = await execute_action(
        dom,
        ah,
        {"action": "scroll", "params": {"direction": "down", "amount": 400}},
        humanizer=hu,
    )
    assert out == {"success": True, "message": ""}
    hu.scroll.assert_awaited_once_with(400)

async def test_execute_action_scroll_with_humanizer_up():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    hu = MagicMock()
    hu.scroll = AsyncMock()
    out = await execute_action(
        dom,
        ah,
        {"action": "scroll", "params": {"direction": "up", "amount": 250}},
        humanizer=hu,
    )
    assert out["success"] is True
    hu.scroll.assert_awaited_once_with(-250)

async def test_execute_action_extract_disabled():
    from domains.spawn_browser_agent_v3 import service_actions

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()

    out = await service_actions.execute_action(dom, ah, {"action": "extract", "params": {"query": "q"}})
    assert out["success"] is False
    assert "extract is disabled" in out["error"]

async def test_execute_action_goto_delegates():
    from domains.spawn_browser_agent_v3 import service_actions

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()

    async def fake_goto(**kwargs):
        return {"success": True, "message": "navigated"}

    with patch.object(service_actions, "_execute_goto", side_effect=fake_goto):
        out = await service_actions.execute_action(dom, ah, {"action": "goto", "params": {"url": "https://x.com"}})
    assert out == {"success": True, "message": "navigated"}

async def test_execute_action_click_delegates():
    from domains.spawn_browser_agent_v3 import service_actions

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {3: MagicMock()}
    ah = MagicMock()
    ah.record_action = AsyncMock()

    async def fake_click(**kwargs):
        return {"success": True, "message": ""}

    with patch.object(service_actions, "_execute_click", side_effect=fake_click):
        out = await service_actions.execute_action(dom, ah, {"action": "click", "index": 3, "params": {}})
    assert out == {"success": True, "message": ""}

async def test_execute_action_input_text_delegates():
    from domains.spawn_browser_agent_v3 import service_actions

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {1: MagicMock()}
    ah = MagicMock()
    ah.record_action = AsyncMock()

    async def fake_input(**kwargs):
        return {"success": True, "message": ""}

    with patch.object(service_actions, "_execute_input_text", side_effect=fake_input):
        out = await service_actions.execute_action(
            dom,
            ah,
            {"action": "input_text", "index": 1, "params": {"text": "hi"}},
        )
    assert out == {"success": True, "message": ""}

async def test_execute_action_screenshot_returns_success():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "screenshot", "params": {}})
    # screenshot action either succeeds or is unknown — both are fine;
    # we just exercise the branch without raising.
    assert isinstance(out, dict)
    assert "success" in out

async def test_execute_action_exception_catches():
    from domains.spawn_browser_agent_v3 import service_actions

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {2: MagicMock()}
    ah = MagicMock()
    ah.record_action = AsyncMock()

    async def boom(**kwargs):
        raise RuntimeError("kaboom")

    with patch.object(service_actions, "_execute_click", side_effect=boom):
        out = await service_actions.execute_action(dom, ah, {"action": "click", "index": 2, "params": {}})
    # The outer try/except should catch and return {success: False, error: ...}
    assert out["success"] is False
    assert "kaboom" in str(out.get("error", "")) or "error" in out

# ========================================
# service_actions: private _execute_* handlers + fallback paths
# ========================================

def _make_awaitable_event(result=None):
    """Create a fake event bus dispatch return: awaitable that also has event_result()."""

    class _Ev:
        def __await__(self):
            async def _await():
                return None

            return _await().__await__()

        async def event_result(self, raise_if_any=True, raise_if_none=False):
            return result

    return _Ev()

def _fake_session_with_event_bus(dispatch_side_effect=None, event_result=None):
    """Build a MagicMock session whose event_bus.dispatch returns awaitable event objects."""
    session = MagicMock()
    if dispatch_side_effect is None:

        def _default_dispatch(_event):
            return _make_awaitable_event(event_result)

        session.event_bus.dispatch = MagicMock(side_effect=_default_dispatch)
    else:
        session.event_bus.dispatch = MagicMock(side_effect=dispatch_side_effect)
    session.highlight_interaction_element = AsyncMock()
    session.highlight_coordinate_click = AsyncMock()
    return session

async def test_execute_action_press_key_no_humanizer():
    """press_key fallback path uses event_bus."""
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = _fake_session_with_event_bus()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "press_key", "params": {"key": "Tab"}}, humanizer=None)
    assert out == {"success": True, "message": ""}
    dom.session.event_bus.dispatch.assert_called()

async def test_execute_action_scroll_no_humanizer_up():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = _fake_session_with_event_bus()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(
        dom,
        ah,
        {"action": "scroll", "params": {"direction": "up", "amount": 200}},
        humanizer=None,
    )
    assert out == {"success": True, "message": ""}

async def test_execute_action_navback():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = _fake_session_with_event_bus()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "navback"})
    assert out == {"success": True, "message": ""}

async def test_execute_action_wait():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = _fake_session_with_event_bus()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "wait", "params": {"time_ms": 500}})
    assert out == {"success": True, "message": ""}

async def test_execute_action_wait_coerces_numeric_string():
    """LLM tool arguments can encode numeric fields as strings."""
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = _fake_session_with_event_bus()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()

    out = await execute_action(dom, ah, {"action": "wait", "params": {"time_ms": "500"}})

    assert out == {"success": True, "message": ""}
    ah.record_action.assert_awaited_once()
    assert ah.record_action.await_args.kwargs["params"] == {"time_ms": 500}

async def test_execute_action_wait_rejects_invalid_and_clamps_huge_values():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = _fake_session_with_event_bus()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()

    invalid = await execute_action(dom, ah, {"action": "wait", "params": {"time_ms": "forever"}})
    assert invalid == {"success": False, "error": "wait time_ms must be numeric"}

    huge = await execute_action(dom, ah, {"action": "wait", "params": {"time_ms": "999999999"}})
    assert huge == {"success": True, "message": ""}
    assert ah.record_action.await_args.kwargs["params"] == {"time_ms": 60_000}

async def test_execute_action_dropdown_options_with_element():
    """Patch the dropdown event class to avoid pydantic node validation."""
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    el = MagicMock()
    dom.session = _fake_session_with_event_bus(event_result=["opt1", "opt2"])
    dom.selector_map = {7: el}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    with patch("browser_use.browser.events.GetDropdownOptionsEvent", lambda **kw: kw):
        out = await execute_action(dom, ah, {"action": "dropdown_options", "index": 7})
    assert out["success"] is True
    assert out["options"] == ["opt1", "opt2"]

async def test_execute_action_select_dropdown_with_element():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    el = MagicMock()
    dom.session = _fake_session_with_event_bus()
    dom.selector_map = {1: el}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    with patch("browser_use.browser.events.SelectDropdownOptionEvent", lambda **kw: kw):
        out = await execute_action(
            dom,
            ah,
            {"action": "select_dropdown", "index": 1, "params": {"value": "red"}},
        )
    assert out == {"success": True, "message": ""}

async def test_execute_action_evaluate():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    session = MagicMock()
    cdp = MagicMock()
    cdp.session_id = "sid"
    cdp.cdp_client.send.Runtime.evaluate = AsyncMock(return_value={"result": {"value": 42}})
    session.get_or_create_cdp_session = AsyncMock(return_value=cdp)
    dom.session = session
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "evaluate", "params": {"code": "1+1"}})
    assert out["success"] is True
    assert out["value"] == 42

async def test_execute_action_open_new_tab():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    session = _fake_session_with_event_bus()
    session.get_focused_target = MagicMock(return_value=SimpleNamespace(target_id="abcd1234"))
    dom.session = session
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "open_new_tab", "params": {"url": "https://x.com"}})
    assert out["success"] is True
    assert out["new_tab_id"] == "1234"

async def test_execute_action_close_tab_via_focused():
    """close_tab with no tab_id uses focused target."""
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    session = _fake_session_with_event_bus()
    session.get_focused_target = MagicMock(return_value=SimpleNamespace(target_id="xyzw9876"))
    dom.session = session
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "close_tab", "params": {}})
    assert out["success"] is True
    assert out["closed_tab"] == "9876"

async def test_execute_action_close_tab_no_focused():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    session = _fake_session_with_event_bus()
    session.get_focused_target = MagicMock(return_value=None)
    dom.session = session
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "close_tab", "params": {}})
    assert out["success"] is False

async def test_execute_action_close_tab_with_id_found():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    session = _fake_session_with_event_bus()
    session.get_tabs = AsyncMock(
        return_value=[
            SimpleNamespace(target_id="aaaabbbb1234", title="t", url="u"),
        ]
    )
    dom.session = session
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "close_tab", "params": {"tab_id": "1234"}})
    assert out["success"] is True

async def test_execute_action_close_tab_with_id_not_found():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    session = _fake_session_with_event_bus()
    session.get_tabs = AsyncMock(
        return_value=[
            SimpleNamespace(target_id="aaaa", title="t", url="u"),
        ]
    )
    dom.session = session
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "close_tab", "params": {"tab_id": "9999"}})
    assert out["success"] is False
    assert "not found" in out["error"]

async def test_execute_action_switch_tab_found():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    session = _fake_session_with_event_bus()
    session.get_tabs = AsyncMock(
        return_value=[
            SimpleNamespace(target_id="xxxxxxxx1122", title="t", url="u"),
        ]
    )
    dom.session = session
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "switch_tab", "params": {"tab_id": "1122"}})
    assert out["success"] is True
    assert out["switched_to"] == "1122"

async def test_execute_action_switch_tab_not_found():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    session = _fake_session_with_event_bus()
    session.get_tabs = AsyncMock(return_value=[SimpleNamespace(target_id="xxxxxxxxAAAA", title="t", url="u")])
    dom.session = session
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(dom, ah, {"action": "switch_tab", "params": {"tab_id": "ZZZZ"}})
    assert out["success"] is False

# ── DOMService viewport coordinates ──────────────────────────────────

async def test_dom_service_element_coordinates_use_visible_viewport_rect():
    from browser_tools.dom_service import DOMService

    calls = []

    class _FakeDOM:
        async def scrollIntoViewIfNeeded(self, *, params, session_id):
            calls.append(("scroll", params, session_id))

        async def resolveNode(self, *, params, session_id):
            calls.append(("resolve", params, session_id))
            return {"object": {"objectId": "node-1"}}

    class _FakeRuntime:
        async def callFunctionOn(self, *, params, session_id):
            calls.append(("rect", params, session_id))
            assert "getBoundingClientRect" in params["functionDeclaration"]
            return {
                "result": {
                    "value": {
                        "visible": True,
                        "x": 360,
                        "y": 332,
                        "width": 180,
                        "height": 64,
                        "viewportWidth": 1280,
                        "viewportHeight": 800,
                    }
                }
            }

    cdp_session = SimpleNamespace(
        session_id="cdp-session",
        cdp_client=SimpleNamespace(send=SimpleNamespace(DOM=_FakeDOM(), Runtime=_FakeRuntime())),
    )
    element = SimpleNamespace(backend_node_id=123)

    class _FakeSession:
        agent_focus_target_id = "target"

        async def cdp_client_for_node(self, node):
            assert node is element
            return cdp_session

    dom = DOMService(cdp_url="")
    dom._session = _FakeSession()
    dom._selector_map = {123: element}

    coords = await dom.get_element_coordinates(123)

    # Center is (450, 364); get_element_coordinates applies a bounded off-center
    # jitter (<= min(0.3*extent, 6) px) so click landing points aren't pixel-perfect
    # (defeats "unnaturally accurate click precision"). Assert within that tolerance.
    assert abs(coords[0] - 450) <= 6 and abs(coords[1] - 364) <= 6
    assert [call[0] for call in calls] == ["scroll", "resolve", "rect"]
    assert calls[0][1] == {"backendNodeId": 123}

async def test_dom_service_hidden_checkbox_coordinates_use_visible_associated_label():
    from browser_tools.dom_service import DOMService

    class _FakeDOM:
        async def scrollIntoViewIfNeeded(self, *, params, session_id):
            assert params == {"backendNodeId": 456}
            assert session_id == "cdp-session"

        async def resolveNode(self, *, params, session_id):
            assert params == {"backendNodeId": 456}
            assert session_id == "cdp-session"
            return {"object": {"objectId": "hidden-checkbox"}}

    class _FakeRuntime:
        async def callFunctionOn(self, *, params, session_id):
            assert session_id == "cdp-session"
            assert params["objectId"] == "hidden-checkbox"
            function = params["functionDeclaration"]
            use_associated_label = params["arguments"][0]["value"]
            if not use_associated_label:
                return {
                    "result": {
                        "value": {
                            "visible": False,
                            "x": 0,
                            "y": 0,
                            "width": 0,
                            "height": 0,
                            "viewportWidth": 1280,
                            "viewportHeight": 800,
                        }
                    }
                }
            assert 'this.tagName === "INPUT"' in function
            assert 'inputType === "checkbox"' in function
            assert 'inputType === "radio"' in function
            assert "document.elementFromPoint" in function
            return {
                "result": {
                    "value": {
                        "visible": True,
                        "x": 522,
                        "y": 348,
                        "width": 44,
                        "height": 36,
                        "viewportWidth": 1280,
                        "viewportHeight": 800,
                    }
                }
            }

    cdp_session = SimpleNamespace(
        session_id="cdp-session",
        cdp_client=SimpleNamespace(send=SimpleNamespace(DOM=_FakeDOM(), Runtime=_FakeRuntime())),
    )
    element = SimpleNamespace(backend_node_id=456)

    class _FakeSession:
        agent_focus_target_id = "target"

        async def cdp_client_for_node(self, node):
            assert node is element
            return cdp_session

    dom = DOMService(cdp_url="")
    dom._session = _FakeSession()
    dom._selector_map = {456: element}

    assert await dom.get_element_coordinates(456) is None
    coords = await dom.get_click_coordinates(456)

    # The hidden checkbox has no box of its own. Its visible seat label is
    # centered at (544, 366), with the same bounded humanization jitter.
    assert coords is not None
    assert abs(coords[0] - 544) <= 6 and abs(coords[1] - 366) <= 6

async def test_dom_service_hidden_checkbox_label_coordinates_in_real_cdp():
    from playwright.async_api import async_playwright

    from browser_tools.dom_service import DOMService

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        try:
            page = await browser.new_page(viewport={"width": 1280, "height": 800})
            await page.set_content(
                """
                <style>
                  #seat { position: absolute; opacity: 0; width: 0; height: 0; }
                  label { position: absolute; left: 522px; top: 348px; width: 44px; height: 36px; }
                </style>
                <input id="seat" type="checkbox"><label for="seat">E11</label>
                """
            )
            cdp = await page.context.new_cdp_session(page)
            document = await cdp.send("DOM.getDocument")
            node = await cdp.send(
                "DOM.querySelector",
                {"nodeId": document["root"]["nodeId"], "selector": "#seat"},
            )
            described = await cdp.send("DOM.describeNode", {"nodeId": node["nodeId"]})
            backend_node_id = described["node"]["backendNodeId"]

            class _DOMAdapter:
                async def scrollIntoViewIfNeeded(self, *, params, session_id):
                    assert session_id == "playwright"
                    return await cdp.send("DOM.scrollIntoViewIfNeeded", params)

                async def resolveNode(self, *, params, session_id):
                    assert session_id == "playwright"
                    return await cdp.send("DOM.resolveNode", params)

            class _RuntimeAdapter:
                async def callFunctionOn(self, *, params, session_id):
                    assert session_id == "playwright"
                    return await cdp.send("Runtime.callFunctionOn", params)

            cdp_session = SimpleNamespace(
                session_id="playwright",
                cdp_client=SimpleNamespace(
                    send=SimpleNamespace(DOM=_DOMAdapter(), Runtime=_RuntimeAdapter())
                ),
            )
            element = SimpleNamespace(backend_node_id=backend_node_id)

            class _FakeSession:
                agent_focus_target_id = "page"

                async def cdp_client_for_node(self, candidate):
                    assert candidate is element
                    return cdp_session

            dom = DOMService(cdp_url="")
            dom._session = _FakeSession()
            dom._selector_map = {backend_node_id: element}

            assert await dom.get_element_coordinates(backend_node_id) is None
            coords = await dom.get_click_coordinates(backend_node_id)

            assert coords is not None
            assert abs(coords[0] - 544) <= 6 and abs(coords[1] - 366) <= 6
            await page.mouse.click(*coords)
            assert await page.locator("#seat").is_checked()

            await page.locator("label").evaluate("element => element.style.pointerEvents = 'none'")
            assert await dom.get_click_coordinates(backend_node_id) is None
        finally:
            await browser.close()

async def test_dom_service_opacity_hidden_checkbox_with_nonempty_rect_uses_label():
    """A checkbox hidden with opacity:0 still reports a NON-EMPTY rect.

    The original C-10 fix only consulted the label when the input had zero
    viewport intersection, so this far more common hiding pattern kept returning
    the input's own coordinates and clicked a point it does not own. The click
    must land on the visible label instead.
    """
    from playwright.async_api import async_playwright

    from browser_tools.dom_service import DOMService

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        try:
            page = await browser.new_page(viewport={"width": 1280, "height": 800})
            # Non-zero width/height + opacity:0, and an overlay covering the input
            # so it is genuinely not the hit target while its label is.
            await page.set_content(
                """
                <style>
                  #seat { position: absolute; left: 100px; top: 100px;
                          width: 20px; height: 20px; opacity: 0; }
                  #cover { position: absolute; left: 90px; top: 90px;
                           width: 60px; height: 60px; background: #fff; }
                  label { position: absolute; left: 522px; top: 348px;
                          width: 44px; height: 36px; }
                </style>
                <input id="seat" type="checkbox"><div id="cover"></div>
                <label for="seat">E11</label>
                """
            )
            cdp = await page.context.new_cdp_session(page)
            document = await cdp.send("DOM.getDocument")
            node = await cdp.send(
                "DOM.querySelector",
                {"nodeId": document["root"]["nodeId"], "selector": "#seat"},
            )
            described = await cdp.send("DOM.describeNode", {"nodeId": node["nodeId"]})
            backend_node_id = described["node"]["backendNodeId"]

            class _DOMAdapter:
                async def scrollIntoViewIfNeeded(self, *, params, session_id):
                    return await cdp.send("DOM.scrollIntoViewIfNeeded", params)

                async def resolveNode(self, *, params, session_id):
                    return await cdp.send("DOM.resolveNode", params)

            class _RuntimeAdapter:
                async def callFunctionOn(self, *, params, session_id):
                    return await cdp.send("Runtime.callFunctionOn", params)

            cdp_session = SimpleNamespace(
                session_id="playwright",
                cdp_client=SimpleNamespace(
                    send=SimpleNamespace(DOM=_DOMAdapter(), Runtime=_RuntimeAdapter())
                ),
            )
            element = SimpleNamespace(backend_node_id=backend_node_id)

            class _FakeSession:
                agent_focus_target_id = "page"

                async def cdp_client_for_node(self, candidate):
                    return cdp_session

            dom = DOMService(cdp_url="")
            dom._session = _FakeSession()
            dom._selector_map = {backend_node_id: element}

            coords = await dom.get_click_coordinates(backend_node_id)
            assert coords is not None, "hidden-but-nonempty checkbox resolved no coordinates"
            # Must be the label at (522..566, 348..384), NOT the input at ~(100,100).
            assert abs(coords[0] - 544) <= 6 and abs(coords[1] - 366) <= 6, (
                f"expected the visible label rect, got {coords}"
            )
            await page.mouse.click(*coords)
            assert await page.locator("#seat").is_checked()
        finally:
            await browser.close()


async def test_dom_service_disconnect_stops_browser_session_without_killing_remote_browser():
    from browser_tools.dom_service import DOMService

    session = SimpleNamespace(stop=AsyncMock())
    dom = DOMService(cdp_url="wss://steel.example/session")
    dom._session = session
    dom._selector_map = {1: object()}

    await dom.disconnect()

    session.stop.assert_awaited_once()
    assert dom.session is None
    assert dom.selector_map == {}


def test_browser_downloads_path_for_provider_kernel_vs_steel():
    """Kernel CDP downloads must land in /tmp/downloads (listed by session_files)."""
    from browser_tools.dom_service import (
        KERNEL_DOWNLOADS_PATH,
        STEEL_DOWNLOADS_PATH,
        browser_downloads_path_for_provider,
    )

    assert browser_downloads_path_for_provider("kernel") == KERNEL_DOWNLOADS_PATH
    assert browser_downloads_path_for_provider("KERNEL") == KERNEL_DOWNLOADS_PATH
    assert browser_downloads_path_for_provider("steel") == STEEL_DOWNLOADS_PATH
    assert KERNEL_DOWNLOADS_PATH == "/tmp/downloads"
    assert STEEL_DOWNLOADS_PATH == "/files"
    # Pre-fix bug: Kernel sessions used Steel's /files, so CDP downloads never
    # appeared in Kernel listFiles(/tmp/downloads) → session_files missed compressed output.
    assert browser_downloads_path_for_provider("kernel") != STEEL_DOWNLOADS_PATH


def test_is_browser_attachment_download_tinypng_vs_ad_script():
    """TinyPNG attachment Fetch/Document must persist; Google Ads Script must not."""
    from domains.spawn_browser_agent_v3.download_persist import is_browser_attachment_download

    tinypng_url = "https://tinypng.com/backend/opt/download/abc/rs.jpeg"
    assert is_browser_attachment_download(
        url=tinypng_url,
        resource_type="Fetch",
        mime_type="",
        response_headers={"content-disposition": "attachment", "content-length": "149852"},
    )
    assert is_browser_attachment_download(
        url=tinypng_url,
        resource_type="Document",
        mime_type="image/jpeg",
        response_headers={"content-disposition": "attachment", "content-length": "149852"},
    )
    assert not is_browser_attachment_download(
        url="https://securepubads.g.doubleclick.net/tag/js/gpt.js",
        resource_type="Script",
        mime_type="text/javascript",
        response_headers={"content-disposition": 'attachment; filename="f.txt"'},
    )


async def test_persist_bytes_to_session_downloads_uploads_under_tmp_downloads():
    """Owning boundary: attachment bytes must land under /tmp/downloads via upload API."""
    from domains.spawn_browser_agent_v3 import download_persist

    calls = []

    async def fake_upload(
        config,
        session_id,
        filename,
        file_content,
        mime_type="application/octet-stream",
        *,
        directory=None,
    ):
        calls.append(
            {
                "session_id": session_id,
                "filename": filename,
                "content": file_content,
                "mime_type": mime_type,
                "directory": directory,
            }
        )
        return {"path": f"{directory}/{filename}", "size": len(file_content)}

    with patch(
        "domains.spawn_browser_agent_v3.repo.upload_file_to_session",
        new=fake_upload,
    ):
        out = await download_persist.persist_bytes_to_session_downloads(
            _fake_config(),
            "sess-1",
            filename="rs.jpeg",
            content=b"JPEGBYTES",
            mime_type="image/jpeg",
        )
    assert out == {
        "path": "/tmp/downloads/rs.jpeg",
        "size": 9,
        "filename": "rs.jpeg",
        "mime_type": "image/jpeg",
    }
    assert calls == [
        {
            "session_id": "sess-1",
            "filename": "rs.jpeg",
            "content": b"JPEGBYTES",
            "mime_type": "image/jpeg",
            "directory": "/tmp/downloads",
        }
    ]


async def test_browser_download_persister_captures_attachment_via_cdp_body():
    """CDP loadingFinished for Content-Disposition: attachment writes session downloads."""
    from domains.spawn_browser_agent_v3.download_persist import BrowserDownloadPersister

    persisted = []

    class _NetworkSend:
        async def getResponseBody(self, params=None, session_id=None):
            assert params == {"requestId": "req-1"}
            return {"body": base64.b64encode(b"COMPRESSED").decode(), "base64Encoded": True}

        async def enable(self, session_id=None):
            return {}

    class _Send:
        Network = _NetworkSend()

    class _RegisterNetwork:
        def __init__(self):
            self.handlers = {}

        def responseReceived(self, cb):
            self.handlers["responseReceived"] = cb

        def loadingFinished(self, cb):
            self.handlers["loadingFinished"] = cb

        def loadingFailed(self, cb):
            self.handlers["loadingFailed"] = cb

    class _Register:
        def __init__(self):
            self.Network = _RegisterNetwork()

    class _CdpClient:
        def __init__(self):
            self.register = _Register()
            self.send = _Send()

    class _CdpSession:
        session_id = "cdp-sess"
        cdp_client = None

    cdp_client = _CdpClient()
    cdp_session = _CdpSession()
    cdp_session.cdp_client = cdp_client

    class _BrowserSession:
        async def get_or_create_cdp_session(self, *a, **kw):
            return cdp_session

    async def fake_persist(config, session_id, *, filename, content, mime_type="application/octet-stream"):
        persisted.append(
            {
                "session_id": session_id,
                "filename": filename,
                "content": content,
                "mime_type": mime_type,
            }
        )
        return {"path": f"/tmp/downloads/{filename}", "size": len(content), "filename": filename, "mime_type": mime_type}

    with patch.dict(os.environ, {"BROWSER_PROVIDER": "kernel"}, clear=False):
        with patch(
            "domains.spawn_browser_agent_v3.download_persist.persist_bytes_to_session_downloads",
            new=fake_persist,
        ):
            persister = await BrowserDownloadPersister.create(
                browser_session=_BrowserSession(),
                session_id="kernel-sess",
                config=_fake_config(),
                agent_id="agent-1",
                task_id="task-1",
            )
            assert persister is not None
            handlers = cdp_client.register.Network.handlers
            handlers["responseReceived"](
                {
                    "requestId": "req-1",
                    "type": "Fetch",
                    "response": {
                        "url": "https://tinypng.com/backend/opt/download/x/rs.jpeg",
                        "status": 200,
                        "mimeType": "",
                        "headers": {"content-disposition": "attachment", "content-length": "10"},
                    },
                },
                "cdp-sess",
            )
            handlers["loadingFinished"]({"requestId": "req-1", "encodedDataLength": 10}, "cdp-sess")
            # Allow the created persist task to run.
            await asyncio.sleep(0)
            if persister._tasks:
                await asyncio.gather(*list(persister._tasks), return_exceptions=True)
            await persister.close()

    assert persisted == [
        {
            "session_id": "kernel-sess",
            "filename": "rs.jpeg",
            "content": b"COMPRESSED",
            "mime_type": "image/jpeg",
        }
    ]


def test_dom_service_defaults_downloads_path_from_browser_provider_env():
    """DOMService must default downloads_path from BROWSER_PROVIDER, not hardcode /files."""
    import os

    from browser_tools.dom_service import KERNEL_DOWNLOADS_PATH, STEEL_DOWNLOADS_PATH, DOMService

    with patch.dict(os.environ, {"BROWSER_PROVIDER": "kernel"}, clear=False):
        assert DOMService(cdp_url="wss://example").downloads_path == KERNEL_DOWNLOADS_PATH
    with patch.dict(os.environ, {"BROWSER_PROVIDER": "steel"}, clear=False):
        assert DOMService(cdp_url="wss://example").downloads_path == STEEL_DOWNLOADS_PATH
    assert DOMService(cdp_url="wss://example", downloads_path="/custom").downloads_path == "/custom"




async def test_evaluate_awaits_promises():
    """Runtime.evaluate must set awaitPromise so async fetch results are returned."""
    from domains.spawn_browser_agent_v3.service_actions import _execute_inspection_action

    evaluate = AsyncMock(return_value={"result": {"value": {"ok": True, "size": 3}}})
    cdp_session = SimpleNamespace(
        session_id="cdp",
        cdp_client=SimpleNamespace(send=SimpleNamespace(Runtime=SimpleNamespace(evaluate=evaluate))),
    )
    session = SimpleNamespace(get_or_create_cdp_session=AsyncMock(return_value=cdp_session))
    history = SimpleNamespace(record_action=AsyncMock())
    ctx = SimpleNamespace(
        action_name="evaluate",
        params={"code": "(async () => ({ok:true,size:3}))()"},
        session=session,
        dom_service=SimpleNamespace(),
        action_history=history,
        thinking=None,
        config=None,
        session_id="s",
        humanizer=None,
        browser_network_recorder=None,
        navigation_pin_host=None,
        navigation_origin_base_domain=None,
        current_url="https://tinypng.com/",
        current_auth_realm="",
        prepare_credentials_for_url=None,
    )
    result = await _execute_inspection_action(ctx)
    assert result["success"] is True
    assert result["value"]["size"] == 3
    assert evaluate.await_args.kwargs["params"]["awaitPromise"] is True


async def test_goto_err_aborted_persists_download_to_session():
    """goto net::ERR_ABORTED on attachment URLs must persist bytes under /tmp/downloads."""
    import domains.spawn_browser_agent_v3.download_persist as download_persist
    from domains.spawn_browser_agent_v3.service_actions import _execute_goto

    class Bus:
        def dispatch(self, event):
            return self
        def __await__(self):
            async def _done():
                return None
            return _done().__await__()
        async def event_result(self, **kwargs):
            raise RuntimeError("Navigation failed: net::ERR_ABORTED")

    session = SimpleNamespace(event_bus=Bus())
    history = SimpleNamespace(record_action=AsyncMock())
    with patch.object(
        download_persist,
        "persist_navigation_download_via_page_fetch",
        new=AsyncMock(
            return_value={
                "path": "/tmp/downloads/rs.jpeg",
                "size": 149852,
                "filename": "rs.jpeg",
            }
        ),
    ):
        result = await _execute_goto(
            session=session,
            dom_service=SimpleNamespace(),
            action_history=history,
            params={"url": "https://tinypng.com/backend/opt/download/x/rs.jpeg"},
            thinking=None,
            session_id="sess",
            config=object(),
        )
    assert result["success"] is True
    assert result["download"]["path"] == "/tmp/downloads/rs.jpeg"
    history.record_action.assert_awaited()


async def test_dom_service_passkey_webauthn_uses_cdp_client_session_api():
    """Steel/CDP sessions expose cdp_client.send.WebAuthn, not cdp_session.send."""
    from browser_tools.dom_service import DOMService

    class _FakeWebAuthn:
        def __init__(self):
            self.enable = AsyncMock(return_value={})
            self.addVirtualAuthenticator = AsyncMock(return_value={"authenticatorId": "auth-1"})
            self.addCredential = AsyncMock(return_value={})
            self.getCredentials = AsyncMock(return_value={"credentials": [{"credentialId": "cred-1", "signCount": 8}]})

    class _FakePage:
        def __init__(self):
            self.setInterceptFileChooserDialog = AsyncMock(return_value={})

    webauthn = _FakeWebAuthn()
    page = _FakePage()
    cdp_session = SimpleNamespace(
        session_id="cdp-session",
        cdp_client=SimpleNamespace(send=SimpleNamespace(WebAuthn=webauthn, Page=page)),
    )

    class _FakeSession:
        agent_focus_target_id = "target"

        async def get_or_create_cdp_session(self, target_id=None, focus=False):
            assert target_id == "target"
            assert focus is False
            return cdp_session

    dom = DOMService(cdp_url="")
    dom._session = _FakeSession()

    await dom._suppress_browser_overlays()
    await dom.inject_passkeys(
        [
            {
                "credentialId": "cred-1",
                "privateKey": "pkcs8",
                "rpId": "amazon.com",
                "userHandle": "user-1",
                "signCount": 7,
            }
        ]
    )

    assert webauthn.enable.await_count == 2
    assert webauthn.enable.await_args_list == [
        call(params={"enableUI": False}, session_id="cdp-session"),
        call(params={"enableUI": False}, session_id="cdp-session"),
    ]
    webauthn.addVirtualAuthenticator.assert_awaited_once()
    webauthn.addCredential.assert_awaited_once()
    page.setInterceptFileChooserDialog.assert_awaited_once_with(params={"enabled": True}, session_id="cdp-session")
    assert await dom.get_used_passkey_credential_ids() == ["cred-1"]

async def test_passkey_usage_is_recorded_once_before_browser_task_completion():
    """A sign-counter advance must be durable before approvals pause the browser task."""
    from domains.spawn_browser_agent_v3 import handler

    dom_service = SimpleNamespace(get_used_passkey_credential_ids=AsyncMock(return_value=["amazon-credential"]))
    recorded_credential_ids: set[str] = set()

    with patch.object(
        handler,
        "save_browser_credential_ref_message",
        new=AsyncMock(return_value=True),
    ) as save_ref:
        first = await handler.record_used_passkey_credentials(
            dom_service=dom_service,
            passkey_ref_by_credential_id={"amazon-credential": {"kind": "passkey", "id": "passkey-row"}},
            recorded_credential_ids=recorded_credential_ids,
            agent_id="agent-1",
            task_id="task-1",
            browser_url="https://kernel.example/live/session-1",
        )
        second = await handler.record_used_passkey_credentials(
            dom_service=dom_service,
            passkey_ref_by_credential_id={"amazon-credential": {"kind": "passkey", "id": "passkey-row"}},
            recorded_credential_ids=recorded_credential_ids,
            agent_id="agent-1",
            task_id="task-1",
            browser_url="https://kernel.example/live/session-1",
        )

    assert first == 1
    assert second == 0
    assert recorded_credential_ids == {"amazon-credential"}
    save_ref.assert_awaited_once_with(
        agent_id="agent-1",
        task_id="task-1",
        message="Passkey used for authentication.",
        role="TOOL",
        tool_name="browser_session_auth",
        credential_ref={"kind": "passkey", "id": "passkey-row"},
        browser_url="https://kernel.example/live/session-1",
    )

async def test_passkey_usage_retries_after_credential_ref_write_failure():
    """A failed outcome write must not suppress the next observation's retry."""
    from domains.spawn_browser_agent_v3 import handler

    dom_service = SimpleNamespace(get_used_passkey_credential_ids=AsyncMock(return_value=["amazon-credential"]))
    recorded_credential_ids: set[str] = set()

    with patch.object(
        handler,
        "save_browser_credential_ref_message",
        new=AsyncMock(side_effect=[False, True]),
    ) as save_ref:
        first = await handler.record_used_passkey_credentials(
            dom_service=dom_service,
            passkey_ref_by_credential_id={"amazon-credential": {"kind": "passkey", "id": "passkey-row"}},
            recorded_credential_ids=recorded_credential_ids,
            agent_id="agent-1",
            task_id="task-1",
            browser_url="https://kernel.example/live/session-1",
        )
        second = await handler.record_used_passkey_credentials(
            dom_service=dom_service,
            passkey_ref_by_credential_id={"amazon-credential": {"kind": "passkey", "id": "passkey-row"}},
            recorded_credential_ids=recorded_credential_ids,
            agent_id="agent-1",
            task_id="task-1",
            browser_url="https://kernel.example/live/session-1",
        )

    assert first == 0
    assert second == 1
    assert recorded_credential_ids == {"amazon-credential"}
    assert save_ref.await_count == 2

async def test_disconnect_browser_captures_passkey_usage_before_disconnect():
    from domains.spawn_browser_agent_v3.handler import disconnect_browser_after_passkey_capture

    events = []

    async def capture_usage():
        events.append("credential_ref_saved")

    dom_service = SimpleNamespace(disconnect=AsyncMock(side_effect=lambda: events.append("disconnected")))

    await disconnect_browser_after_passkey_capture(dom_service, capture_usage)

    assert events == ["credential_ref_saved", "disconnected"]
    dom_service.disconnect.assert_awaited_once()

def test_passkey_usage_is_sampled_before_every_terminal_browser_disconnect():
    """Completion, approvals, handoffs, cancellation, and errors all capture usage."""
    import inspect

    from domains.spawn_browser_agent_v3 import handler

    source = inspect.getsource(handler._spawn_browser_agent_activity_v3_real)
    post_injection = source.split("# ===== PHASE 3: POST-SETUP =====", maxsplit=1)[1]
    lines = post_injection.splitlines()
    capture_disconnects = [line for line in lines if "await disconnect_browser_after_passkey_capture(" in line]

    assert len(capture_disconnects) == 8
    assert not any("await dom_service.disconnect()" in line for line in lines)

def test_passkey_usage_dedupe_survives_every_browser_activity_resume_boundary():
    """Approval and auth handoffs must carry recorded passkey IDs into the next activity."""
    import inspect

    from domains.spawn_browser_agent_v3 import handler

    activity_source = inspect.getsource(handler._spawn_browser_agent_activity_v3_real)
    manager_source = inspect.getsource(handler.SpawnBrowserAgentManagerV3.execute_tool)

    assert activity_source.count('"recorded_passkey_credential_ids": sorted(recorded_passkey_credential_ids)') == 3
    assert manager_source.count('"recorded_passkey_credential_ids": result.get(') == 3
    assert "(write_lock_resume_state or {}).get(" in activity_source
    assert '"recorded_passkey_credential_ids", []' in activity_source

# ── _execute_click ───────────────────────────────────────────────────

async def test_execute_click_with_element_humanizer():
    from domains.spawn_browser_agent_v3.service_actions import _execute_click

    session = MagicMock()
    session.highlight_interaction_element = AsyncMock()
    dom = MagicMock()
    dom.get_click_coordinates = AsyncMock(return_value=(10, 20))
    element = MagicMock()
    element.get_all_children_text = MagicMock(return_value="hi")
    ah = MagicMock()
    ah.record_action = AsyncMock()
    hu = MagicMock()
    hu.click_at_coords = AsyncMock()
    out = await _execute_click(
        session=session,
        dom_service=dom,
        action_history=ah,
        element=element,
        index=2,
        coords=None,
        thinking=None,
        humanizer=hu,
        write_lock_enabled=False,
        write_lock_approvals=None,
        current_url="https://example.com",
        system_name="Rose",
    )
    assert out == {"success": True, "message": ""}
    hu.click_at_coords.assert_awaited_once_with(10, 20)

async def test_execute_click_with_element_humanizer_missing_coords_refuses_fallback():
    from domains.spawn_browser_agent_v3.service_actions import _execute_click

    session = _fake_session_with_event_bus()
    session.highlight_interaction_element = AsyncMock()
    dom = MagicMock()
    dom.get_click_coordinates = AsyncMock(return_value=None)
    dom.get_browser_state = AsyncMock()
    element = MagicMock()
    element.get_all_children_text = MagicMock(return_value="hi")
    ah = MagicMock()
    ah.record_action = AsyncMock()
    hu = MagicMock()
    hu.click_at_coords = AsyncMock()

    out = await _execute_click(
        session=session,
        dom_service=dom,
        action_history=ah,
        element=element,
        index=2,
        coords=None,
        thinking=None,
        humanizer=hu,
        write_lock_enabled=False,
        write_lock_approvals=None,
        current_url="https://example.com",
        system_name="Rose",
    )

    assert out["success"] is False
    assert "Cannot humanize click" in out["error"]
    hu.click_at_coords.assert_not_called()
    session.event_bus.dispatch.assert_not_called()

async def test_execute_click_with_element_humanizer_refreshes_stale_coordinates():
    from domains.spawn_browser_agent_v3.service_actions import _execute_click

    session = MagicMock()
    session.highlight_interaction_element = AsyncMock()
    dom = MagicMock()
    dom.get_click_coordinates = AsyncMock(side_effect=[None, (44, 55)])
    dom.get_browser_state = AsyncMock()
    element = MagicMock()
    element.get_all_children_text = MagicMock(return_value="Pay $43.96")
    ah = MagicMock()
    ah.record_action = AsyncMock()
    hu = MagicMock()
    hu.click_at_coords = AsyncMock()

    out = await _execute_click(
        session=session,
        dom_service=dom,
        action_history=ah,
        element=element,
        index=21,
        coords=None,
        thinking=None,
        humanizer=hu,
        write_lock_enabled=False,
        write_lock_approvals=None,
        current_url="https://example.com/test_payment",
        system_name="Rose",
    )

    assert out == {"success": True, "message": ""}
    dom.get_browser_state.assert_awaited_once_with(include_screenshot=False)
    hu.click_at_coords.assert_awaited_once_with(44, 55)

async def test_execute_click_with_coords_no_humanizer():
    from domains.spawn_browser_agent_v3.service_actions import _execute_click

    session = _fake_session_with_event_bus()
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await _execute_click(
        session=session,
        dom_service=dom,
        action_history=ah,
        element=None,
        index=None,
        coords={"x": 100, "y": 200},
        thinking=None,
        humanizer=None,
        write_lock_enabled=False,
        write_lock_approvals=None,
        current_url="https://example.com",
        system_name="Rose",
    )
    assert out == {"success": True, "message": ""}

async def test_execute_click_no_element_no_coords():
    from domains.spawn_browser_agent_v3.service_actions import _execute_click

    session = MagicMock()
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await _execute_click(
        session=session,
        dom_service=dom,
        action_history=ah,
        element=None,
        index=None,
        coords=None,
        thinking=None,
        humanizer=None,
        write_lock_enabled=False,
        write_lock_approvals=None,
        current_url="",
        system_name="Rose",
    )
    assert out["success"] is False
    assert "index or coordinates" in out["error"]

async def test_execute_click_write_lock_purchase_triggers_approval():
    """Purchase button click without approval returns needs_write_approval."""
    from domains.spawn_browser_agent_v3 import service_actions

    session = MagicMock()
    dom = MagicMock()
    element = MagicMock()
    element.get_all_children_text = MagicMock(return_value="Place Order")
    ah = MagicMock()
    ah.record_action = AsyncMock()
    with (
        patch("browser_tools.write_lock.is_social_domain", return_value=False),
        patch("browser_tools.write_lock.is_submit_button", return_value=False),
        patch("browser_tools.write_lock.is_purchase_button", return_value=True),
        patch(
            "browser_tools.write_lock.get_write_lock_approval_question",
            return_value="q?",
        ),
    ):
        out = await service_actions._execute_click(
            session=session,
            dom_service=dom,
            action_history=ah,
            element=element,
            index=1,
            coords=None,
            thinking=None,
            humanizer=None,
            write_lock_enabled=True,
            write_lock_approvals=None,
            current_url="https://shop.example.com/checkout",
            system_name="Rose",
        )
    assert out["status"] == "needs_write_approval"
    assert out["approval_type"] == "purchase"

async def test_execute_click_write_lock_return_confirmation_triggers_approval():
    """The archived Amazon final-return control is blocked before the click executes."""
    from domains.spawn_browser_agent_v3 import service_actions

    session = MagicMock()
    dom = MagicMock()
    element = MagicMock()
    element.attributes = {"role": "button"}
    element.get_all_children_text = MagicMock(return_value="Confirm your return")
    ah = MagicMock()
    ah.record_action = AsyncMock()

    out = await service_actions._execute_click(
        session=session,
        dom_service=dom,
        action_history=ah,
        element=element,
        index=27,
        coords=None,
        thinking=None,
        humanizer=None,
        write_lock_enabled=True,
        write_lock_approvals=None,
        current_url="https://www.amazon.com/spr/returns/confirm",
        system_name="Rose",
    )

    assert out["status"] == "needs_write_approval"
    assert out["approval_type"] == "purchase"
    assert "Confirm your return" in out["element_text"]
    ah.record_action.assert_not_awaited()

async def test_execute_click_write_lock_uses_nearest_ancestor_text_for_shadow_input():
    """A textless shadow input inherits the bounded label beside it in its nearest ancestor."""
    from domains.spawn_browser_agent_v3 import service_actions

    parent = SimpleNamespace(
        attributes={"id": "methods-section-continue-button"},
        parent_node=None,
        node_name="SPAN",
        get_all_children_text=lambda: "Confirm your return",
    )
    element = SimpleNamespace(
        attributes={"type": "submit"},
        parent_node=parent,
        node_name="INPUT",
        get_all_children_text=lambda: "",
    )
    session = _fake_session_with_event_bus()
    session.get_page = AsyncMock(return_value=None)
    dom = MagicMock()
    dom.get_click_coordinates = AsyncMock(return_value=(25, 40))
    ah = MagicMock()
    ah.record_action = AsyncMock()

    with patch(
        "browser_use.browser.events.ClickElementEvent",
        side_effect=AssertionError("write lock allowed the shadow submit click"),
    ):
        out = await service_actions._execute_click(
            session=session,
            dom_service=dom,
            action_history=ah,
            element=element,
            index=28752,
            coords=None,
            thinking=None,
            humanizer=None,
            write_lock_enabled=True,
            write_lock_approvals=None,
            current_url="https://www.amazon.com/spr/returns/confirm",
            system_name="Rose",
        )

    assert out["status"] == "needs_write_approval"
    assert out["approval_type"] == "purchase"
    assert "Confirm your return" in out["element_text"]
    ah.record_action.assert_not_awaited()

def test_element_write_lock_signal_stops_after_nearest_bounded_ancestor_text():
    """An unrelated higher container cannot donate a purchase phrase to a local control."""
    from domains.spawn_browser_agent_v3.service_actions import _element_write_lock_signal

    grandparent = SimpleNamespace(
        parent_node=None,
        node_name="SECTION",
        get_all_children_text=lambda: "Confirm your return",
    )
    parent = SimpleNamespace(
        parent_node=grandparent,
        node_name="SPAN",
        get_all_children_text=lambda: "Continue",
    )
    element = SimpleNamespace(
        attributes={"type": "submit"},
        parent_node=parent,
        node_name="INPUT",
        get_all_children_text=lambda: "",
    )

    signal = _element_write_lock_signal(element)

    assert "Continue" in signal
    assert "Confirm your return" not in signal

def test_write_lock_purchase_button_detects_order_controls():
    """Final transaction buttons are gated; cart, checkout, and return navigation are not."""
    from browser_tools.write_lock import is_purchase_button

    assert is_purchase_button("Buy Now")
    assert is_purchase_button("Place your order")
    assert is_purchase_button("Confirm your return")
    assert is_purchase_button("Submit return request")
    assert not is_purchase_button("Add to Cart")
    assert not is_purchase_button("Go to Cart")
    assert not is_purchase_button("Proceed to checkout")
    assert not is_purchase_button("Return to your orders")


def test_write_lock_purchase_button_excludes_terms_consent_prose():
    """Terms copy that quotes Buy Now must not trip the purchase write lock.

    Eventim checkout (2026-08-10 agent e20e5a4e): clicking the legal line
    'By clicking "Buy Now," you agree to our Terms of Purchase…' was classified
    as a purchase button, forced generate_write_lock_notification, and blocked
    request_payment_card. Real Buy Now / Place Order controls stay locked.
    """
    from browser_tools.write_lock import is_purchase_button

    terms = (
        'By clicking "Buy Now," you agree to our\n'
        "Terms of Purchase\n"
        "and acknowledge our privacy practices as described in our\n"
        "Privacy Policy."
    )
    assert not is_purchase_button(terms)
    assert not is_purchase_button(
        "By clicking Place Order you agree to the Terms of Service"
    )
    assert is_purchase_button("Buy Now")
    assert is_purchase_button("Place Order")
    assert is_purchase_button("Pay Now")
    # Independent signals joined with newlines: consent in one must not veto
    # a real purchase phrase in another.
    assert is_purchase_button("Terms of Service\nBuy Now")
    assert is_purchase_button("Buy Now\nPrivacy Policy")


def test_write_lock_email_send_excludes_marketing_opt_in_controls():
    """Marketing opt-in checkboxes never trigger the outbound-send write lock.

    Eventim checkout (2026-08-10 agent 317bd635): clicking the label
    "Send me info about other shows by this organizer" was classified as
    email_send, parked the agent on write_lock approval, and blocked
    request_payment_card. Opting into merchant emails is not composing an
    outbound message.
    """
    from browser_tools.write_lock import is_email_send_button

    assert not is_email_send_button("Send me info about other shows by this organizer")
    assert not is_email_send_button("Send me updates about upcoming events")
    assert not is_email_send_button("Email me about other shows")
    assert not is_email_send_button("Subscribe to the organizer newsletter")
    assert not is_email_send_button("Sign me up for promotional emails")

    # Ordinary outbound sends stay locked.
    assert is_email_send_button("Send")
    assert is_email_send_button("Send email")
    assert is_email_send_button("Send message")

    # An opt-in label must not unlock a neighbouring real send control.
    assert is_email_send_button("Send me info about other shows\nSend message")

    # Composite: marketing opt-in must not suppress a co-located send-email phrase.
    assert is_email_send_button("Send me info and send email")
    assert is_email_send_button("Send me updates and send message")


def test_write_lock_email_send_excludes_resend_controls():
    """Code requests and resends never trigger the outbound-send write lock.

    Andy's rule (2026-08-04): a control that asks for a one-time code, or that
    resends something the site already sent, is not a new outbound write and must
    never park the agent on an approval nobody is there to answer. The code test
    is content-based and matches anywhere in the label; the resend test stays
    positional. Ordinary sends are unaffected by either.
    """
    from browser_tools.write_lock import is_email_send_button

    # Ordinary outbound sends stay locked.
    assert is_email_send_button("Send")
    assert is_email_send_button("Send email")
    assert is_email_send_button("Send message")
    assert is_email_send_button("Send mail")

    # Asking the site for a one-time code is never an outbound write, whatever
    # the verb or the word order. This is a content test, not a prefix test.
    assert not is_email_send_button("Send new email verification code")
    assert not is_email_send_button("Get verification code")
    assert not is_email_send_button("Email me a security code")
    assert not is_email_send_button("Send verification code")
    assert not is_email_send_button("Send email verification code again")
    assert not is_email_send_button("Send verification code to phone")
    assert not is_email_send_button("Send me a one-time password")
    assert not is_email_send_button("Send OTP")
    assert not is_email_send_button("Send login code")
    assert not is_email_send_button("Send passcode")
    assert not is_email_send_button("Request confirmation code")
    assert not is_email_send_button("Send invoice and send another email verification code")

    # Resending is exempt on its own, independently of any code wording.
    assert not is_email_send_button("Resend")
    assert not is_email_send_button("Resend invitation to team@corp.com")

    # An ordinary send that merely opens with "send new"/"send another" is still a
    # send — every code case is carried by the content rule above, so the resend
    # exemption does not need those prefixes and must not swallow these.
    assert is_email_send_button("Send new message")
    assert is_email_send_button("Send new email")
    assert is_email_send_button("Send another message")

    # "otp" is matched as a token; it must not fire inside an unrelated word.
    assert is_email_send_button("Send hotpot photos")
    assert is_email_send_button("Send adoption papers")

    # The resend exemption stays positional: retry wording welded into another
    # token is not a resend action.
    assert is_email_send_button("alt-action-resend")
    assert is_email_send_button("Send invoice to billing@corp.com")

    # Each newline-delimited signal is judged on its own, so a resend label can
    # never unlock a neighbouring send control in the same element.
    assert is_email_send_button("Send email\nSend new email verification code")
    assert is_email_send_button("Send message\nSend another OTP to email")
    assert is_email_send_button("Send new email verification code\nSend message")
    assert is_email_send_button("Get verification code\nSend message")

def test_write_lock_social_domain_excludes_auth_flow_urls():
    """Login/auth/signup pages on social domains are account flows, not social post gates."""
    from browser_tools.write_lock import is_social_domain

    assert is_social_domain("https://x.com/compose/post")
    assert not is_social_domain("https://x.com/i/jf/onboarding/web?redirect_after_login=%2Fcompose%2Fpost&mode=login")
    assert not is_social_domain("https://x.com/i/jf/onboarding/web#/s/download_app_pivot/r-u7t6")
    assert not is_social_domain("https://auth.x.com/oauth/authorize")
    assert not is_social_domain("https://twitter.com/i/flow/signup")

def test_write_lock_submit_button_excludes_auth_navigation_controls():
    """Auth navigation buttons can expose a generic submit role without being post actions."""
    from browser_tools.write_lock import is_submit_button

    assert is_submit_button("Post")
    assert is_submit_button("Submit")
    assert not is_submit_button("Continue\nsubmit")
    assert not is_submit_button("Sign up with Phone\nsubmit")
    assert not is_submit_button("Log in\nsubmit")

async def test_write_lock_payment_field_missing_page_accessor_fails_closed():
    from browser_tools.write_lock import is_payment_field

    session = MagicMock()
    if hasattr(session, "get_page"):
        delattr(session, "get_page")

    assert await is_payment_field(session, MagicMock(), 1) is False

async def test_execute_click_write_lock_social_triggers_approval():
    from domains.spawn_browser_agent_v3 import service_actions

    session = MagicMock()
    dom = MagicMock()
    element = MagicMock()
    element.get_all_children_text = MagicMock(return_value="Post")
    ah = MagicMock()
    ah.record_action = AsyncMock()
    with (
        patch("browser_tools.write_lock.is_social_domain", return_value=True),
        patch("browser_tools.write_lock.is_submit_button", return_value=True),
        patch("browser_tools.write_lock.is_purchase_button", return_value=False),
        patch(
            "browser_tools.write_lock.get_write_lock_approval_question",
            return_value="q?",
        ),
    ):
        out = await service_actions._execute_click(
            session=session,
            dom_service=dom,
            action_history=ah,
            element=element,
            index=1,
            coords=None,
            thinking=None,
            humanizer=None,
            write_lock_enabled=True,
            write_lock_approvals=None,
            current_url="https://twitter.com/compose",
            system_name="Rose",
        )
    assert out["status"] == "needs_write_approval"
    assert out["approval_type"] == "social_post"

async def test_execute_click_write_lock_social_auth_url_does_not_trigger_approval():
    from domains.spawn_browser_agent_v3 import service_actions

    session = _fake_session_with_event_bus()
    dom = MagicMock()
    dom.get_click_coordinates = AsyncMock(return_value=(10, 20))
    element = MagicMock()
    element.get_all_children_text = MagicMock(return_value="Continue\nsubmit")
    ah = MagicMock()
    ah.record_action = AsyncMock()
    hu = MagicMock()
    hu.click_at_coords = AsyncMock()

    out = await service_actions._execute_click(
        session=session,
        dom_service=dom,
        action_history=ah,
        element=element,
        index=1,
        coords=None,
        thinking=None,
        humanizer=hu,
        write_lock_enabled=True,
        write_lock_approvals=None,
        current_url="https://x.com/i/jf/onboarding/web#/s/download_app_pivot/r-u7t6",
        system_name="Rose",
    )

    assert out == {"success": True, "message": ""}
    hu.click_at_coords.assert_awaited_once_with(10, 20)

async def test_execute_click_write_lock_social_auth_button_on_root_does_not_trigger_approval():
    from domains.spawn_browser_agent_v3 import service_actions

    session = _fake_session_with_event_bus()
    dom = MagicMock()
    dom.get_click_coordinates = AsyncMock(return_value=(10, 20))
    element = MagicMock()
    element.get_all_children_text = MagicMock(return_value="Continue\nsubmit")
    ah = MagicMock()
    ah.record_action = AsyncMock()
    hu = MagicMock()
    hu.click_at_coords = AsyncMock()

    out = await service_actions._execute_click(
        session=session,
        dom_service=dom,
        action_history=ah,
        element=element,
        index=1,
        coords=None,
        thinking=None,
        humanizer=hu,
        write_lock_enabled=True,
        write_lock_approvals=None,
        current_url="https://x.com/",
        system_name="Rose",
    )

    assert out == {"success": True, "message": ""}
    hu.click_at_coords.assert_awaited_once_with(10, 20)

async def test_execute_click_write_lock_email_send_triggers_approval():
    """Clicking Send is a write-locked outbound message without a domain allowlist."""
    from domains.spawn_browser_agent_v3 import service_actions

    session = MagicMock()
    dom = MagicMock()
    element = MagicMock()
    element.get_all_children_text = MagicMock(return_value="Send")
    ah = MagicMock()
    ah.record_action = AsyncMock()
    with (
        patch("browser_tools.write_lock.is_email_send_button", return_value=True),
        patch("browser_tools.write_lock.is_social_domain", return_value=False),
        patch("browser_tools.write_lock.is_submit_button", return_value=False),
        patch("browser_tools.write_lock.is_purchase_button", return_value=False),
        patch(
            "browser_tools.write_lock.get_write_lock_approval_question",
            return_value="approve email?",
        ),
    ):
        out = await service_actions._execute_click(
            session=session,
            dom_service=dom,
            action_history=ah,
            element=element,
            index=1,
            coords=None,
            thinking=None,
            humanizer=None,
            write_lock_enabled=True,
            write_lock_approvals=None,
            current_url="https://crm.example.com/outreach/compose",
            system_name="Rose",
        )
    assert out["status"] == "needs_write_approval"
    assert out["approval_type"] == "email_send"

async def test_execute_click_coord_write_lock_purchase():
    """Coord-based click to a purchase button triggers approval."""
    from domains.spawn_browser_agent_v3 import service_actions

    session = _fake_session_with_event_bus()
    dom = MagicMock()
    dom.get_text_at_coordinates = AsyncMock(return_value="Buy Now")
    ah = MagicMock()
    ah.record_action = AsyncMock()
    with (
        patch("browser_tools.write_lock.is_social_domain", return_value=False),
        patch("browser_tools.write_lock.is_submit_button", return_value=False),
        patch("browser_tools.write_lock.is_purchase_button", return_value=True),
        patch(
            "browser_tools.write_lock.get_write_lock_approval_question",
            return_value="q?",
        ),
    ):
        out = await service_actions._execute_click(
            session=session,
            dom_service=dom,
            action_history=ah,
            element=None,
            index=None,
            coords={"x": 50, "y": 80},
            thinking=None,
            humanizer=None,
            write_lock_enabled=True,
            write_lock_approvals=None,
            current_url="https://shop.example.com",
            system_name="Rose",
        )
    assert out["status"] == "needs_write_approval"
    assert out["approval_type"] == "purchase"

async def test_execute_press_key_send_shortcut_does_not_trigger_email_approval():
    """Keyboard shortcuts are too ambiguous to classify as email sends."""
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = _fake_session_with_event_bus()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await execute_action(
        dom,
        ah,
        {"action": "press_key", "params": {"key": "Control+Enter"}},
        current_url="https://mail.google.com/mail/u/0/#inbox?compose=new",
        write_lock_enabled=True,
    )
    assert out == {"success": True, "message": ""}
    dom.session.event_bus.dispatch.assert_called()

# ── _execute_input_text ──────────────────────────────────────────────

async def test_execute_input_text_element_with_humanizer():
    from domains.spawn_browser_agent_v3 import service_actions

    session = MagicMock()
    session.highlight_interaction_element = AsyncMock()
    dom = MagicMock()
    dom.get_element_coordinates = AsyncMock(return_value=(5, 6))
    element = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    hu = MagicMock()
    hu.click_at_coords = AsyncMock()
    hu.press_key = AsyncMock()
    hu.type_text = AsyncMock()
    with patch("browser_tools.write_lock.is_payment_field", AsyncMock(return_value=False)):
        out = await service_actions._execute_input_text(
            session=session,
            dom_service=dom,
            action_history=ah,
            element=element,
            index=1,
            coords=None,
            params={"text": "hello"},
            thinking=None,
            humanizer=hu,
            secret_refs=None,
            password_origins=None,
            current_url="https://x.com",
            write_lock_enabled=True,
            write_lock_approvals=None,
            system_name="Rose",
        )
    assert out["success"] is True
    assert out["typed_text"] == "hello"
    assert [call.args[0] for call in hu.press_key.await_args_list] == [
        "Control+a",
        "Backspace",
    ]
    hu.type_text.assert_awaited_once_with("hello")

async def test_is_payment_field_uses_dom_attributes_without_get_page():
    from browser_tools.write_lock import is_payment_field

    session = SimpleNamespace()
    element = SimpleNamespace(
        attributes={
            "id": "card-expiry",
            "autocomplete": "cc-exp",
            "placeholder": "MM/YY",
        }
    )

    assert await is_payment_field(session, element, 1) is True

async def test_execute_input_text_element_humanizer_refreshes_dom_when_coords_missing():
    from domains.spawn_browser_agent_v3 import service_actions

    session = _fake_session_with_event_bus()
    session.highlight_interaction_element = AsyncMock()
    dom = MagicMock()
    dom.get_browser_state = AsyncMock(return_value={})
    dom.get_element_coordinates = AsyncMock(side_effect=[None, (7, 8)])
    element = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    hu = MagicMock()
    hu.click_at_coords = AsyncMock()
    hu.press_key = AsyncMock()
    hu.type_text = AsyncMock()

    with patch("browser_tools.write_lock.is_payment_field", AsyncMock(return_value=False)):
        out = await service_actions._execute_input_text(
            session=session,
            dom_service=dom,
            action_history=ah,
            element=element,
            index=1,
            coords=None,
            params={"text": "hello"},
            thinking=None,
            humanizer=hu,
            secret_refs=None,
            password_origins=None,
            current_url="https://x.com",
            write_lock_enabled=True,
            write_lock_approvals=None,
            system_name="Rose",
        )

    assert out["success"] is True
    dom.get_browser_state.assert_awaited_once_with(include_screenshot=False)
    assert dom.get_element_coordinates.await_count == 2
    hu.click_at_coords.assert_awaited_once_with(7, 8)
    hu.type_text.assert_awaited_once_with("hello")

async def test_execute_input_text_element_humanizer_missing_coords_refuses_typetext_fallback():
    from domains.spawn_browser_agent_v3 import service_actions

    session = _fake_session_with_event_bus()
    session.highlight_interaction_element = AsyncMock()
    dom = MagicMock()
    dom.get_element_coordinates = AsyncMock(return_value=None)
    element = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    hu = MagicMock()
    hu.click_at_coords = AsyncMock()
    hu.press_key = AsyncMock()
    hu.type_text = AsyncMock()

    with patch("browser_tools.write_lock.is_payment_field", AsyncMock(return_value=False)):
        out = await service_actions._execute_input_text(
            session=session,
            dom_service=dom,
            action_history=ah,
            element=element,
            index=1,
            coords=None,
            params={"text": "hello"},
            thinking=None,
            humanizer=hu,
            secret_refs=None,
            password_origins=None,
            current_url="https://x.com",
            write_lock_enabled=True,
            write_lock_approvals=None,
            system_name="Rose",
        )

    assert out["success"] is False
    assert "Cannot humanize input_text" in out["error"]
    hu.click_at_coords.assert_not_called()
    hu.type_text.assert_not_called()
    session.event_bus.dispatch.assert_not_called()


async def test_execute_input_text_payment_secret_ref_bypasses_payment_warning():
    from domains.spawn_browser_agent_v3 import service_actions

    session = _fake_session_with_event_bus()
    session.highlight_interaction_element = AsyncMock()
    dom = MagicMock()
    dom.get_element_coordinates = AsyncMock(return_value=(11, 12))
    element = MagicMock()
    element.tag_name = "input"
    element.attributes = {"autocomplete": "cc-number"}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    hu = MagicMock()
    hu.click_at_coords = AsyncMock()
    hu.press_key = AsyncMock()
    hu.type_text = AsyncMock()

    with patch("browser_tools.write_lock.is_payment_field", AsyncMock(return_value=True)):
        out = await service_actions._execute_input_text(
            session=session,
            dom_service=dom,
            action_history=ah,
            element=element,
            index=8,
            coords=None,
            params={"text": "card_number"},
            thinking=None,
            humanizer=hu,
            secret_refs={
                "card_number": "4111111111111111",
                "card_name": "Rose Labs",
                "card_expiry": "12/30",
                "card_cvv": "123",
            },
            password_origins=None,
            current_url="https://checkout.example.com/pay",
            write_lock_enabled=True,
            write_lock_approvals=None,
            system_name="Rose",
        )

    assert out["success"] is True
    assert out["typed_text"] == "[encrypted_data]"
    hu.click_at_coords.assert_awaited_once_with(11, 12)
    hu.type_text.assert_awaited_once_with("4111111111111111")

async def test_execute_input_text_payment_secret_ref_direct_fill_sets_exact_value():
    from domains.spawn_browser_agent_v3 import service_actions

    page = MagicMock()
    page.evaluate = AsyncMock(
        return_value={
            "filled": True,
            "x": 222,
            "y": 333,
            "selector": 'input[autocomplete="cc-number"]',
            "valueLength": 16,
        }
    )
    session = _fake_session_with_event_bus()
    session.get_page = AsyncMock(return_value=page)
    session.highlight_interaction_element = AsyncMock()
    dom = MagicMock()
    dom.get_element_coordinates = AsyncMock(return_value=(11, 12))
    element = MagicMock()
    element.tag_name = "input"
    element.attributes = {"autocomplete": "cc-number"}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    hu = MagicMock()
    hu.click_at_coords = AsyncMock()
    hu.press_key = AsyncMock()
    hu.type_text = AsyncMock()

    with patch("browser_tools.write_lock.is_payment_field", AsyncMock(return_value=True)):
        out = await service_actions._execute_input_text(
            session=session,
            dom_service=dom,
            action_history=ah,
            element=element,
            index=8,
            coords=None,
            params={"text": "card_number"},
            thinking=None,
            humanizer=hu,
            secret_refs={
                "card_number": "4111111111111111",
                "card_name": "Rose Labs",
                "card_expiry": "12/30",
                "card_cvv": "123",
            },
            password_origins=None,
            current_url="https://checkout.example.com/pay",
            write_lock_enabled=True,
            write_lock_approvals=None,
            system_name="Rose",
        )

    assert out["success"] is True
    assert out["typed_text"] == "[encrypted_data]"
    assert out["payment_ref_direct_fill"] is True
    assert out["payment_refs_filled"] == ["card_number", "card_name", "card_expiry", "card_cvv"]
    # wait_for_payment_ref_fields may locate first; assert the four fill payloads.
    payloads = [
        call.args[1]
        for call in page.evaluate.await_args_list
        if len(call.args) > 1 and isinstance(call.args[1], dict) and "refName" in call.args[1]
    ]
    assert payloads == [
        {"refName": "card_number", "value": "4111111111111111"},
        {"refName": "card_name", "value": "Rose Labs"},
        {"refName": "card_expiry", "value": "12/30"},
        {"refName": "card_cvv", "value": "123"},
    ]
    hu.click_at_coords.assert_not_called()
    hu.press_key.assert_not_called()
    hu.type_text.assert_not_called()
    ah.record_action.assert_awaited_once()
    recorded = ah.record_action.await_args.kwargs
    assert recorded["coordinates"] == {"x": 222, "y": 333}
    assert recorded["result"]["payment_ref_direct_fill"] is True
    assert recorded["result"]["payment_refs_filled"] == [
        "card_number",
        "card_name",
        "card_expiry",
        "card_cvv",
    ]

async def test_execute_input_text_payment_secret_ref_waits_for_page_ready_before_retry():
    from domains.spawn_browser_agent_v3 import service_actions

    page = MagicMock()
    page.evaluate = AsyncMock(
        side_effect=[
            {"filled": False, "reason": "field_not_found"},
            {
                "filled": True,
                "x": 222,
                "y": 333,
                "selector": 'input[autocomplete="cc-number"]',
                "valueLength": 16,
            },
            {"filled": True, "x": 223, "y": 334, "selector": "input#card-name"},
            {"filled": True, "x": 224, "y": 335, "selector": "input#card-expiry"},
            {"filled": True, "x": 225, "y": 336, "selector": "input#card-cvv"},
        ]
    )
    session = _fake_session_with_event_bus()
    session.get_page = AsyncMock(return_value=page)
    session.highlight_interaction_element = AsyncMock()
    dom = MagicMock()
    dom.get_element_coordinates = AsyncMock(return_value=None)
    element = MagicMock()
    element.tag_name = "input"
    element.attributes = {"autocomplete": "cc-number"}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    hu = MagicMock()
    hu.click_at_coords = AsyncMock()
    hu.press_key = AsyncMock()
    hu.type_text = AsyncMock()

    with (
        patch("browser_tools.write_lock.is_payment_field", AsyncMock(return_value=True)),
        patch.object(
            service_actions,
            "wait_for_navigation_ready",
            AsyncMock(return_value={"ready": True, "reason": "content_present"}),
        ) as wait_ready,
        patch.object(
            service_actions,
            "wait_for_payment_ref_fields",
            AsyncMock(return_value=True),
        ),
    ):
        out = await service_actions._execute_input_text(
            session=session,
            dom_service=dom,
            action_history=ah,
            element=element,
            index=8,
            coords=None,
            params={"text": "card_number"},
            thinking=None,
            humanizer=hu,
            secret_refs={
                "card_number": "4111111111111111",
                "card_name": "Rose Labs",
                "card_expiry": "12/30",
                "card_cvv": "123",
            },
            password_origins=None,
            current_url="https://checkout.example.com/pay",
            write_lock_enabled=True,
            write_lock_approvals=None,
            system_name="Rose",
        )

    assert out["success"] is True
    assert out["payment_ref_direct_fill"] is True
    assert out["payment_refs_filled"] == ["card_number", "card_name", "card_expiry", "card_cvv"]
    wait_ready.assert_awaited_once_with(
        dom,
        url="https://checkout.example.com/pay",
        timeout_seconds=3.0,
        reload_blank_spa_once=True,
    )
    assert page.evaluate.await_count == 5
    hu.click_at_coords.assert_not_called()
    hu.type_text.assert_not_called()

async def test_execute_input_text_payment_secret_ref_direct_fill_uses_cdp_without_page():
    from domains.spawn_browser_agent_v3 import service_actions

    cdp_client = MagicMock()
    cdp_client.send.Runtime.evaluate = AsyncMock(
        return_value={
            "result": {
                "value": {
                    "filled": True,
                    "x": 444,
                    "y": 555,
                    "selector": "input#card-name",
                    "valueLength": 9,
                }
            }
        }
    )
    cdp_session = SimpleNamespace(cdp_client=cdp_client, session_id="cdp-1")
    session = _fake_session_with_event_bus()
    session.get_or_create_cdp_session = AsyncMock(return_value=cdp_session)
    session.highlight_interaction_element = AsyncMock()
    dom = MagicMock()
    dom.get_element_coordinates = AsyncMock(return_value=None)
    element = MagicMock()
    element.tag_name = "input"
    element.attributes = {"id": "card-name"}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    hu = MagicMock()
    hu.click_at_coords = AsyncMock()
    hu.press_key = AsyncMock()
    hu.type_text = AsyncMock()

    with patch("browser_tools.write_lock.is_payment_field", AsyncMock(return_value=True)):
        out = await service_actions._execute_input_text(
            session=session,
            dom_service=dom,
            action_history=ah,
            element=element,
            index=7,
            coords=None,
            params={"text": "card_name"},
            thinking=None,
            humanizer=hu,
            secret_refs={
                "card_number": "4111111111111111",
                "card_name": "Rose Labs",
                "card_expiry": "12/30",
                "card_cvv": "123",
            },
            password_origins=None,
            current_url="https://checkout.example.com/pay",
            write_lock_enabled=True,
            write_lock_approvals=None,
            system_name="Rose",
        )

    assert out["success"] is True
    assert out["payment_ref_direct_fill"] is True
    assert out["payment_refs_filled"] == ["card_name", "card_number", "card_expiry", "card_cvv"]
    assert session.get_or_create_cdp_session.await_count >= 4
    for cdp_call in session.get_or_create_cdp_session.await_args_list:
        assert cdp_call.kwargs == {"focus": True}
    assert cdp_client.send.Runtime.evaluate.await_count >= 4
    fill_expressions = [
        call.kwargs["params"]["expression"]
        for call in cdp_client.send.Runtime.evaluate.await_args_list
        if '"value":' in call.kwargs["params"]["expression"]
    ]
    assert any('"refName": "card_name"' in expression for expression in fill_expressions)
    assert any('"refName": "card_number"' in expression for expression in fill_expressions)
    assert any('"refName": "card_expiry"' in expression for expression in fill_expressions)
    assert any('"refName": "card_cvv"' in expression for expression in fill_expressions)
    hu.click_at_coords.assert_not_called()
    hu.type_text.assert_not_called()
    recorded = ah.record_action.await_args.kwargs
    assert recorded["coordinates"] == {"x": 444, "y": 555}


async def test_fill_payment_ref_directly_searches_playwright_frames():
    """Hosted payment widgets live in child frames — search every frame, not just main."""
    from domains.spawn_browser_agent_v3 import service_actions

    main = MagicMock()
    main.evaluate = AsyncMock(return_value={"filled": False, "reason": "field_not_found"})
    iframe = MagicMock()
    iframe.evaluate = AsyncMock(
        return_value={
            "filled": True,
            "x": 40,
            "y": 80,
            "selector": 'input[autocomplete="cc-number"]',
            "valueLength": 16,
            "score": 100,
        }
    )
    input_page = MagicMock()
    input_page.frames = [main, iframe]
    session = _fake_session_with_event_bus()

    result = await service_actions._fill_payment_ref_directly(
        session,
        "card_number",
        "4111111111111111",
        input_page=input_page,
    )

    assert result is not None
    assert result["filled"] is True
    assert result["target"] == "playwright:1"
    assert result["method"] == "js"
    assert main.evaluate.await_count == 1
    assert iframe.evaluate.await_count == 1


async def test_fill_payment_ref_directly_uses_keyboard_when_js_value_rejected():
    """Controlled inputs that keep an empty value after JS set must fall back to typing."""
    from domains.spawn_browser_agent_v3 import service_actions

    frame = MagicMock()
    frame.evaluate = AsyncMock(
        side_effect=[
            {
                "filled": True,
                "x": 10,
                "y": 20,
                "selector": 'input[autocomplete="cc-number"]',
                "valueLength": 0,
                "score": 100,
            },
            {
                "focused": True,
                "x": 10,
                "y": 20,
                "selector": 'input[autocomplete="cc-number"]',
                "score": 100,
            },
        ]
    )
    input_page = MagicMock()
    input_page.frames = [frame]
    humanizer = MagicMock()
    humanizer.input_page = input_page
    humanizer.press_key = AsyncMock()
    humanizer.type_text = AsyncMock()
    session = _fake_session_with_event_bus()

    result = await service_actions._fill_payment_ref_directly(
        session,
        "card_number",
        "4111111111111111",
        input_page=input_page,
        humanizer=humanizer,
    )

    assert result is not None
    assert result["method"] == "keyboard"
    humanizer.type_text.assert_awaited_once_with("4111111111111111")
    assert humanizer.press_key.await_count >= 2


async def test_fill_payment_ref_directly_uses_cdp_iframe_targets():
    """OOPIF payment documents are reachable via session.get_all_frames targets."""
    from domains.spawn_browser_agent_v3 import service_actions

    cdp_client = MagicMock()
    cdp_client.send.Runtime.evaluate = AsyncMock(
        return_value={
            "result": {
                "value": {
                    "filled": True,
                    "x": 12,
                    "y": 34,
                    "selector": 'input[autocomplete="cc-csc"]',
                    "valueLength": 3,
                    "score": 100,
                }
            }
        }
    )
    iframe_cdp = SimpleNamespace(cdp_client=cdp_client, session_id="iframe-1")
    session = _fake_session_with_event_bus()
    session.get_all_frames = AsyncMock(
        return_value=(
            {
                "frame-1": {
                    "id": "frame-1",
                    "frameTargetId": "target-iframe-pay",
                    "url": "https://pay.example/elements",
                }
            },
            {"target-iframe-pay": "sess-1"},
        )
    )
    session.get_or_create_cdp_session = AsyncMock(return_value=iframe_cdp)

    result = await service_actions._fill_payment_ref_directly(
        session,
        "card_cvv",
        "123",
    )

    assert result is not None
    assert result["filled"] is True
    assert result["target"].startswith("cdp:")
    session.get_or_create_cdp_session.assert_awaited()
    cdp_client.send.Runtime.evaluate.assert_awaited()


async def test_execute_input_text_payment_secret_ref_recovers_dead_backend_node_with_selector():
    from domains.spawn_browser_agent_v3 import service_actions

    page = MagicMock()
    page.evaluate = AsyncMock(
        side_effect=[
            {"filled": False, "reason": "field_not_found"},
            {"filled": False, "reason": "field_not_found"},
            {"x": 222, "y": 333, "selector": 'input[autocomplete="cc-number"]'},
        ]
    )
    session = _fake_session_with_event_bus()
    session.get_page = AsyncMock(return_value=page)
    session.highlight_interaction_element = AsyncMock()
    dom = MagicMock()
    dom.get_element_coordinates = AsyncMock(return_value=None)
    dom.get_browser_state = AsyncMock()
    element = MagicMock()
    element.tag_name = "input"
    element.attributes = {"autocomplete": "cc-number"}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    hu = MagicMock()
    hu.click_at_coords = AsyncMock()
    hu.press_key = AsyncMock()
    hu.type_text = AsyncMock()

    with (
        patch("browser_tools.write_lock.is_payment_field", AsyncMock(return_value=True)),
        patch.object(
            service_actions,
            "wait_for_payment_ref_fields",
            AsyncMock(return_value=False),
        ),
        patch.object(
            service_actions,
            "wait_for_navigation_ready",
            AsyncMock(return_value={"ready": True, "reason": "content_present"}),
        ),
    ):
        out = await service_actions._execute_input_text(
            session=session,
            dom_service=dom,
            action_history=ah,
            element=element,
            index=8,
            coords=None,
            params={"text": "card_number"},
            thinking=None,
            humanizer=hu,
            secret_refs={
                "card_number": "4111111111111111",
                "card_name": "Rose Labs",
                "card_expiry": "12/30",
                "card_cvv": "123",
            },
            password_origins=None,
            current_url="https://checkout.example.com/pay",
            write_lock_enabled=True,
            write_lock_approvals=None,
            system_name="Rose",
        )

    assert out["success"] is True
    dom.get_browser_state.assert_awaited_once_with(include_screenshot=False)
    assert page.evaluate.await_count == 3
    hu.click_at_coords.assert_awaited_once_with(222, 333)
    hu.type_text.assert_awaited_once_with("4111111111111111")


async def test_fill_payment_ref_directly_real_child_frame_fixture():
    """Cement real multi-frame fill: payment inputs live in a child frame document."""
    from playwright.async_api import async_playwright

    from domains.spawn_browser_agent_v3 import service_actions

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        try:
            page = await browser.new_page()
            await page.set_content(
                """
                <html><body>
                  <h1>Merchant shell</h1>
                  <iframe id="pay" srcdoc='
                    <html><body>
                      <input autocomplete="cc-number" name="number" />
                      <input autocomplete="cc-name" name="name" />
                      <input autocomplete="cc-exp" name="exp-date" />
                      <input autocomplete="cc-csc" name="cvc" />
                    </body></html>
                  '></iframe>
                </body></html>
                """
            )
            frame = page.frame_locator("#pay")
            await frame.locator('input[autocomplete="cc-number"]').wait_for(state="attached")
            session = _fake_session_with_event_bus()

            ready = await service_actions.wait_for_payment_ref_fields(
                session,
                ref_names=["card_number"],
                input_page=page,
                timeout_seconds=5.0,
            )
            assert ready is True

            result = await service_actions._fill_payment_ref_directly(
                session,
                "card_number",
                "4111111111111111",
                input_page=page,
            )
            assert result is not None
            assert result.get("filled") is True
            value = await frame.locator('input[autocomplete="cc-number"]').input_value()
            assert value.replace(" ", "") == "4111111111111111"
        finally:
            await browser.close()


async def test_fill_payment_ref_finder_accepts_collapsed_autocomplete_inputs():
    """Hosted widgets may mount autocomplete inputs with 0×0 until focused."""
    from playwright.async_api import async_playwright

    from domains.spawn_browser_agent_v3 import service_actions

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        try:
            page = await browser.new_page()
            await page.set_content(
                """
                <html><body>
                  <input autocomplete="cc-number" name="number"
                         style="width:0;height:0;opacity:0;position:absolute" />
                </body></html>
                """
            )
            session = _fake_session_with_event_bus()
            coords = await service_actions._resolve_payment_ref_coordinates(
                session,
                "card_number",
                input_page=page,
            )
            assert coords is not None
        finally:
            await browser.close()


async def test_fill_payment_ref_finder_accepts_collapsed_stable_field_name_inputs():
    """Hosted Elements mark fields with data-elements-stable-field-name (may be 0×0)."""
    from playwright.async_api import async_playwright

    from domains.spawn_browser_agent_v3 import service_actions

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        try:
            page = await browser.new_page()
            await page.set_content(
                """
                <html><body>
                  <iframe id="pay" srcdoc='
                    <html><body>
                      <input data-elements-stable-field-name="cardNumber"
                             style="width:0;height:0;opacity:0;position:absolute" />
                    </body></html>
                  '></iframe>
                </body></html>
                """
            )
            frame = page.frame_locator("#pay")
            await frame.locator(
                'input[data-elements-stable-field-name="cardNumber"]'
            ).wait_for(state="attached")
            session = _fake_session_with_event_bus()
            ready = await service_actions.wait_for_payment_ref_fields(
                session,
                ref_names=["card_number"],
                input_page=page,
                timeout_seconds=5.0,
            )
            assert ready is True
            result = await service_actions._fill_payment_ref_directly(
                session,
                "card_number",
                "4111111111111111",
                input_page=page,
            )
            assert result is not None
            assert result.get("filled") is True
            value = await frame.locator(
                'input[data-elements-stable-field-name="cardNumber"]'
            ).input_value()
            assert value.replace(" ", "") == "4111111111111111"
        finally:
            await browser.close()


async def test_fill_payment_ref_via_playwright_label_when_no_autocomplete():
    """Labeled inputs without autocomplete/name must still fill via get_by_label."""
    from playwright.async_api import async_playwright

    from domains.spawn_browser_agent_v3 import service_actions

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        try:
            page = await browser.new_page()
            await page.set_content(
                """
                <html><body>
                  <label for="pan">Card number</label>
                  <input id="pan" type="text" />
                </body></html>
                """
            )
            session = _fake_session_with_event_bus()
            result = await service_actions._fill_payment_ref_via_playwright_locator(
                input_page=page,
                ref_name="card_number",
                value="4111111111111111",
                humanizer=None,
            )
            assert result is not None
            assert result.get("filled") is True
            assert "get_by_label" in str(result.get("selector") or "")
            value = await page.locator("#pan").input_value()
            assert value.replace(" ", "") == "4111111111111111"
        finally:
            await browser.close()


async def test_fill_payment_ref_via_titled_payment_iframe():
    """Hosted widgets isolate fields in titled iframes — fill by semantic title."""
    from playwright.async_api import async_playwright

    from domains.spawn_browser_agent_v3 import service_actions

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        try:
            page = await browser.new_page()
            await page.set_content(
                """
                <html><body>
                  <h1>Hosted checkout shell</h1>
                  <iframe title="Secure card number input frame" srcdoc='
                    <html><body><input name="number" /></body></html>
                  '></iframe>
                  <iframe title="Secure expiration date input frame" srcdoc='
                    <html><body><input name="expiry" /></body></html>
                  '></iframe>
                  <iframe title="Secure CVC input frame" srcdoc='
                    <html><body><input name="cvc" /></body></html>
                  '></iframe>
                </body></html>
                """
            )
            await page.frame_locator(
                'iframe[title*="card number" i]'
            ).locator("input").wait_for(state="attached")
            session = _fake_session_with_event_bus()
            ready = await service_actions.wait_for_payment_ref_fields(
                session,
                ref_names=["card_number"],
                input_page=page,
                timeout_seconds=5.0,
            )
            assert ready is True
            result = await service_actions._fill_payment_ref_directly(
                session,
                "card_number",
                "4111111111111111",
                input_page=page,
            )
            assert result is not None
            assert result.get("filled") is True
            assert result.get("method") == "playwright_iframe_title"
            value = await page.frame_locator(
                'iframe[title*="card number" i]'
            ).locator("input").input_value()
            assert value.replace(" ", "") == "4111111111111111"
        finally:
            await browser.close()


async def test_execute_input_text_payment_secret_ref_fail_closed_without_target():
    """Payment secret refs without element/coords must not fake-success via focused typing."""
    from domains.spawn_browser_agent_v3 import service_actions

    session = _fake_session_with_event_bus()
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    hu = MagicMock()
    hu.type_text = AsyncMock()
    hu.press_key = AsyncMock()

    with (
        patch("browser_tools.write_lock.is_payment_field", AsyncMock(return_value=False)),
        patch.object(
            service_actions,
            "wait_for_payment_ref_fields",
            AsyncMock(return_value=False),
        ),
        patch.object(
            service_actions,
            "wait_for_navigation_ready",
            AsyncMock(return_value={"ready": False}),
        ),
        patch.object(
            service_actions,
            "_fill_payment_ref_directly",
            AsyncMock(return_value=None),
        ),
    ):
        out = await service_actions._execute_input_text(
            session=session,
            dom_service=dom,
            action_history=ah,
            element=None,
            index=None,
            coords=None,
            params={"text": "card_number"},
            thinking=None,
            humanizer=hu,
            secret_refs={
                "card_number": "4111111111111111",
                "card_name": "Rose Labs",
                "card_expiry": "12/30",
                "card_cvv": "123",
            },
            password_origins=None,
            current_url="https://checkout.example.com/pay",
            write_lock_enabled=True,
            write_lock_approvals=None,
            system_name="Rose",
        )

    assert out["success"] is False
    assert out["error"] == "field_not_found"
    assert out.get("payment_refs_filled") == []
    hu.type_text.assert_not_called()


async def test_fill_payment_ref_via_keyboard_types_after_cdp_focus():
    """CDP-only payment documents must still receive keyboard events after focus."""
    from domains.spawn_browser_agent_v3 import service_actions

    cdp_client = MagicMock()
    cdp_client.send.Runtime.evaluate = AsyncMock(
        return_value={
            "result": {
                "value": {
                    "focused": True,
                    "x": 10,
                    "y": 20,
                    "selector": 'input[autocomplete="cc-number"]',
                    "score": 100,
                }
            }
        }
    )
    iframe_cdp = SimpleNamespace(cdp_client=cdp_client, session_id="iframe-1")
    session = _fake_session_with_event_bus()
    session.get_all_frames = AsyncMock(
        return_value=(
            {
                "frame-1": {
                    "id": "frame-1",
                    "frameTargetId": "target-iframe-pay",
                    "url": "https://pay.example/elements",
                }
            },
            {"target-iframe-pay": "sess-1"},
        )
    )
    session.get_or_create_cdp_session = AsyncMock(return_value=iframe_cdp)
    input_page = MagicMock()
    input_page.frames = []
    humanizer = MagicMock()
    humanizer.input_page = input_page
    humanizer.press_key = AsyncMock()
    humanizer.type_text = AsyncMock()

    result = await service_actions._fill_payment_ref_via_keyboard(
        session=session,
        ref_name="card_number",
        value="4111111111111111",
        input_page=input_page,
        humanizer=humanizer,
    )

    assert result is not None
    assert result["method"] == "keyboard"
    assert result["target"].startswith("cdp:")
    humanizer.type_text.assert_awaited_once_with("4111111111111111")


async def test_execute_input_text_secret_redacts():
    """Text matching a secret ref is redacted in display and payment field origin mismatches abort."""
    from domains.spawn_browser_agent_v3 import service_actions

    session = _fake_session_with_event_bus()
    dom = MagicMock()
    element = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    with patch("browser_tools.write_lock.is_payment_field", AsyncMock(return_value=False)):
        out = await service_actions._execute_input_text(
            session=session,
            dom_service=dom,
            action_history=ah,
            element=None,
            index=None,
            coords=None,
            params={"text": "pw-token"},
            thinking=None,
            humanizer=None,
            secret_refs={"pw-token": "actual-pw"},
            password_origins={"pw-token": "https://example.com"},
            current_url="https://evil.com",  # mismatch
            write_lock_enabled=True,
            write_lock_approvals=None,
            system_name="Rose",
        )
    assert out["success"] is False
    assert "Password origin mismatch" in out["error"]

async def test_execute_input_text_secret_returns_credential_ref():
    from domains.spawn_browser_agent_v3 import service_actions

    session = _fake_session_with_event_bus()
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    with patch("browser_tools.write_lock.is_payment_field", AsyncMock(return_value=False)):
        out = await service_actions._execute_input_text(
            session=session,
            dom_service=dom,
            action_history=ah,
            element=None,
            index=None,
            coords=None,
            params={"text": "pwd:alice"},
            thinking=None,
            humanizer=None,
            secret_refs={"pwd:alice": "actual-pw"},
            password_origins={"pwd:alice": "https://example.com"},
            credential_refs_by_secret_ref={"pwd:alice": {"kind": "password", "id": "pwd1"}},
            current_url="https://example.com/login",
            write_lock_enabled=True,
            write_lock_approvals=None,
            system_name="Rose",
        )
    assert out["success"] is True
    assert out["typed_text"] == "[encrypted_data]"
    assert out["credential_ref"] == {"kind": "password", "id": "pwd1"}

async def test_execute_input_text_payment_triggers_approval():
    from domains.spawn_browser_agent_v3 import service_actions

    session = MagicMock()
    dom = MagicMock()
    element = MagicMock()
    element.tag_name = "input"
    element.text_content = ""
    ah = MagicMock()
    ah.record_action = AsyncMock()
    with (
        patch("browser_tools.write_lock.is_payment_field", AsyncMock(return_value=True)),
        patch(
            "browser_tools.write_lock.get_write_lock_approval_question",
            return_value="sure?",
        ),
    ):
        out = await service_actions._execute_input_text(
            session=session,
            dom_service=dom,
            action_history=ah,
            element=element,
            index=3,
            coords=None,
            params={"text": "4242 4242"},
            thinking=None,
            humanizer=None,
            secret_refs=None,
            password_origins=None,
            current_url="https://pay.example.com",
            write_lock_enabled=True,
            write_lock_approvals=None,
            system_name="Rose",
        )
    assert out["success"] is False
    assert "call request_payment_card" in out["error"]

async def test_execute_input_text_coords_no_humanizer():
    from domains.spawn_browser_agent_v3 import service_actions

    dispatched = []

    def _capture_dispatch(event):
        dispatched.append(event)
        return _make_awaitable_event()

    session = _fake_session_with_event_bus()
    session.event_bus.dispatch = MagicMock(side_effect=_capture_dispatch)
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await service_actions._execute_input_text(
        session=session,
        dom_service=dom,
        action_history=ah,
        element=None,
        index=None,
        coords={"x": 1, "y": 2},
        params={"text": "abc"},
        thinking=None,
        humanizer=None,
        secret_refs=None,
        password_origins=None,
        current_url="",
        write_lock_enabled=False,
        write_lock_approvals=None,
        system_name="Rose",
    )
    assert out["success"] is True
    assert out["typed_text"] == "abc"
    assert [getattr(event, "keys", None) for event in dispatched][-3:] == [
        "Control+a",
        "Backspace",
        "abc",
    ]

async def test_execute_input_text_clear_false_does_not_clear():
    from domains.spawn_browser_agent_v3 import service_actions

    dispatched = []

    def _capture_dispatch(event):
        dispatched.append(event)
        return _make_awaitable_event()

    session = _fake_session_with_event_bus(dispatch_side_effect=_capture_dispatch)
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await service_actions._execute_input_text(
        session=session,
        dom_service=dom,
        action_history=ah,
        element=None,
        index=None,
        coords=None,
        params={"text": "append", "clear": False},
        thinking=None,
        humanizer=None,
        secret_refs=None,
        password_origins=None,
        current_url="",
        write_lock_enabled=False,
        write_lock_approvals=None,
        system_name="Rose",
    )
    assert out["success"] is True
    assert [getattr(event, "keys", None) for event in dispatched] == ["append"]

async def test_execute_input_text_no_element_no_coords_humanizer():
    from domains.spawn_browser_agent_v3 import service_actions

    session = _fake_session_with_event_bus()
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    hu = MagicMock()
    hu.press_key = AsyncMock()
    hu.type_text = AsyncMock()
    out = await service_actions._execute_input_text(
        session=session,
        dom_service=dom,
        action_history=ah,
        element=None,
        index=None,
        coords=None,
        params={"text": "typed"},
        thinking=None,
        humanizer=hu,
        secret_refs=None,
        password_origins=None,
        current_url="",
        write_lock_enabled=False,
        write_lock_approvals=None,
        system_name="Rose",
    )
    assert out["success"] is True
    assert [call.args[0] for call in hu.press_key.await_args_list] == [
        "Control+a",
        "Backspace",
    ]
    hu.type_text.assert_awaited_once_with("typed")

# ── _execute_goto ────────────────────────────────────────────────────

async def test_execute_goto_auto_adds_https():
    from domains.spawn_browser_agent_v3 import service_actions

    session = _fake_session_with_event_bus()
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await service_actions._execute_goto(
        session=session,
        dom_service=dom,
        action_history=ah,
        params={"url": "example.com/path"},
        thinking=None,
        session_id=None,
        config=None,
    )
    assert out["success"] is True


async def test_execute_goto_err_aborted_persists_attachment_download():
    """goto net::ERR_ABORTED on a download URL must persist bytes under /tmp/downloads."""
    from domains.spawn_browser_agent_v3 import service_actions

    class _FailEvent:
        def __await__(self):
            async def _done():
                return None

            return _done().__await__()

        async def event_result(self, **_kwargs):
            raise RuntimeError("Navigation failed: net::ERR_ABORTED")

    session = SimpleNamespace(
        event_bus=SimpleNamespace(dispatch=MagicMock(return_value=_FailEvent())),
    )
    ah = SimpleNamespace(record_action=AsyncMock())
    download_url = "https://tinypng.com/backend/opt/download/abc/rs.jpeg"

    async def fake_persist(**kwargs):
        assert kwargs["url"] == download_url
        assert kwargs["session_id"] == "sess-dl"
        return {
            "path": "/tmp/downloads/rs.jpeg",
            "size": 149852,
            "filename": "rs.jpeg",
            "content_type": "image/jpeg",
            "source_url": download_url,
        }

    with patch(
        "domains.spawn_browser_agent_v3.download_persist.persist_navigation_download_via_page_fetch",
        new=fake_persist,
    ):
        out = await service_actions._execute_goto(
            session=session,
            dom_service=MagicMock(),
            action_history=ah,
            params={"url": download_url},
            thinking=None,
            session_id="sess-dl",
            config=_fake_config(),
        )
    assert out["success"] is True
    assert out["download"]["path"] == "/tmp/downloads/rs.jpeg"
    assert "saved to session" in out["message"]
    ah.record_action.assert_awaited_once()


# ── live challenge helpers ───────────────────────────────────────────

async def test_live_tab_looks_challenged_helpers():
    """Clean live tabs must skip recovery; challenged tabs must still recover."""
    from domains.spawn_browser_agent_v3.challenge_recovery import (
        live_tab_looks_challenged,
        page_looks_challenged,
    )

    class _CleanPage:
        async def title(self):
            return "Buy tickets"

        def locator(self, _sel):
            class _Body:
                async def inner_text(self, timeout=0):
                    return (
                        "General Admission Tier 1 $25.00 Add to cart Select "
                        "quantity and continue to checkout now."
                    )

            return _Body()

        async def content(self):
            return "<main>General Admission</main>"

    class _ChallengedPage:
        async def title(self):
            return "Access denied"

        def locator(self, _sel):
            class _Body:
                async def inner_text(self, timeout=0):
                    return "Attention Required! | Cloudflare"

            return _Body()

        async def content(self):
            return "<html><body>Attention Required! | Cloudflare</body></html>"

    assert page_looks_challenged(
        status=200,
        title="Access denied",
        body_text="Attention Required! | Cloudflare",
        html="",
    )
    assert await live_tab_looks_challenged(_CleanPage()) is False
    assert await live_tab_looks_challenged(_ChallengedPage()) is True


def test_url_looks_like_api_surface_and_navigation_pin():
    """Shape-only API refuse + recovery pin + cross-origin handoff pin (no path allowlists)."""
    from domains.spawn_browser_agent_v3.service_actions import (
        effective_navigation_pin_host,
        navigation_leaves_pinned_host,
        url_looks_like_api_surface,
        _navigation_guard_error,
        _ActionContext,
    )

    assert url_looks_like_api_surface("https://api.example.com/") is True
    assert url_looks_like_api_surface("https://api.example.com/v1/payment_pages") is True
    assert url_looks_like_api_surface("https://example.com/healthcheck") is True
    assert url_looks_like_api_surface("https://checkout.example.com/c/pay/cs_live_x") is False
    assert url_looks_like_api_surface("https://www.example.com/cart") is False
    # Single-letter / vendor CDN labels are not special-cased.
    assert url_looks_like_api_surface("https://r.example.com/") is False

    pin = "checkout.example.com"
    current = "https://checkout.example.com/c/pay/cs_live_x"
    assert (
        navigation_leaves_pinned_host(
            current_url=current,
            target_url=None,
            pin_host=pin,
            action="navback",
        )
        is True
    )
    assert (
        navigation_leaves_pinned_host(
            current_url=current,
            target_url="https://api.example.com/",
            pin_host=pin,
            action="goto",
        )
        is True
    )
    assert (
        navigation_leaves_pinned_host(
            current_url=current,
            target_url="https://www.merchant.com/cart",
            pin_host=pin,
            action="goto",
        )
        is True
    )
    assert (
        navigation_leaves_pinned_host(
            current_url=current,
            target_url="https://checkout.example.com/c/pay/other",
            pin_host=pin,
            action="goto",
        )
        is False
    )
    assert (
        navigation_leaves_pinned_host(
            current_url=current,
            target_url=None,
            pin_host=pin,
            action="close_tab",
        )
        is True
    )
    assert (
        navigation_leaves_pinned_host(
            current_url=current,
            target_url=None,
            pin_host=pin,
            action="switch_tab",
        )
        is True
    )
    # Off the pin already — do not trap.
    assert (
        navigation_leaves_pinned_host(
            current_url="https://www.merchant.com/cart",
            target_url="https://elsewhere.com/",
            pin_host=pin,
            action="goto",
        )
        is False
    )

    # Cross-origin handoff: live host ≠ session origin → pin to live host.
    assert (
        effective_navigation_pin_host(
            current_url=current,
            recovery_pin_host=None,
            origin_base_domain="merchant.com",
        )
        == "checkout.example.com"
    )
    assert (
        effective_navigation_pin_host(
            current_url="https://www.merchant.com/cart",
            recovery_pin_host=None,
            origin_base_domain="merchant.com",
        )
        is None
    )
    assert (
        effective_navigation_pin_host(
            current_url="https://www.merchant.com/cart",
            recovery_pin_host="www.merchant.com",
            origin_base_domain="merchant.com",
        )
        == "www.merchant.com"
    )

    ctx = _ActionContext(
        dom_service=None,  # type: ignore[arg-type]
        action_history=None,  # type: ignore[arg-type]
        session=None,
        action_name="navback",
        index=None,
        params={},
        thinking=None,
        coords=None,
        element=None,
        available_file_paths=None,
        session_id=None,
        config=None,
        humanizer=None,
        secret_refs=None,
        password_origins=None,
        credential_refs_by_secret_ref=None,
        current_url="https://checkout.example.com/c/pay/cs_live_x",
        trusted_page_urls=None,
        write_lock_enabled=False,
        write_lock_approvals=None,
        system_name="Rose",
        browser_network_recorder=None,
        current_auth_realm="",
        prepare_credentials_for_url=None,
        navigation_pin_host=None,
        navigation_origin_base_domain="merchant.com",
    )
    assert "leave pinned page host" in (_navigation_guard_error(ctx, action="navback") or "")
    ctx.action_name = "goto"
    assert (
        _navigation_guard_error(
            ctx, action="goto", target_url="https://www.merchant.com/about"
        )
        is not None
    )
    # Same handoff host stays allowed.
    assert (
        _navigation_guard_error(
            ctx, action="goto", target_url="https://checkout.example.com/c/pay/other"
        )
        is None
    )
    # Still on origin domain — no handoff pin; free to navigate.
    ctx.current_url = "https://www.merchant.com/cart"
    assert _navigation_guard_error(ctx, action="navback") is None
    assert (
        _navigation_guard_error(
            ctx, action="goto", target_url="https://www.merchant.com/other"
        )
        is None
    )


async def test_execute_goto_refuses_api_surface_urls():
    """RCA cement: fleet 7c0cce61 navigated to an API host after Checkout recovery."""
    from domains.spawn_browser_agent_v3 import service_actions

    session = _fake_session_with_event_bus()
    dom = MagicMock()
    dom.session = session
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await service_actions.execute_action(
        dom_service=dom,
        action_history=ah,
        action={"action": "goto", "params": {"url": "https://api.example.com/"}},
        current_url="https://checkout.example.com/c/pay/cs_live_x",
    )
    assert out["success"] is False
    assert "API/non-document" in out["error"]
    session.event_bus.dispatch.assert_not_called()
    ah.record_action.assert_awaited_once()


async def test_execute_navback_refuses_when_host_pinned():
    from domains.spawn_browser_agent_v3 import service_actions

    session = _fake_session_with_event_bus()
    dom = MagicMock()
    dom.session = session
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await service_actions.execute_action(
        dom_service=dom,
        action_history=ah,
        action={"action": "navback", "params": {}},
        current_url="https://checkout.example.com/c/pay/cs_live_x",
        navigation_pin_host="checkout.example.com",
    )
    assert out["success"] is False
    assert "leave pinned page host" in out["error"]
    session.event_bus.dispatch.assert_not_called()
    ah.record_action.assert_awaited_once()


async def test_execute_navback_refuses_on_cross_origin_handoff():
    """Place-order handoff sticks without recovery pin or path allowlists (ea340c81)."""
    from domains.spawn_browser_agent_v3 import service_actions

    session = _fake_session_with_event_bus()
    dom = MagicMock()
    dom.session = session
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await service_actions.execute_action(
        dom_service=dom,
        action_history=ah,
        action={"action": "navback", "params": {}},
        current_url="https://checkout.example.com/c/pay/cs_live_x",
        navigation_origin_base_domain="merchant.com",
    )
    assert out["success"] is False
    assert "leave pinned page host" in out["error"]
    session.event_bus.dispatch.assert_not_called()

    out_goto = await service_actions.execute_action(
        dom_service=dom,
        action_history=ah,
        action={
            "action": "goto",
            "params": {"url": "https://www.merchant.com/test_payment"},
        },
        current_url="https://checkout.example.com/c/pay/cs_live_x",
        navigation_origin_base_domain="merchant.com",
    )
    assert out_goto["success"] is False
    assert "leave pinned page host" in out_goto["error"]
    session.event_bus.dispatch.assert_not_called()


async def test_execute_close_tab_refuses_on_cross_origin_handoff():
    """Fleet 1bffacc0: close_tab on handoff host crashed the browser session."""
    from domains.spawn_browser_agent_v3 import service_actions

    session = _fake_session_with_event_bus()
    dom = MagicMock()
    dom.session = session
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await service_actions.execute_action(
        dom_service=dom,
        action_history=ah,
        action={"action": "close_tab", "params": {}},
        current_url="https://checkout.example.com/c/pay/cs_live_x",
        navigation_origin_base_domain="merchant.com",
    )
    assert out["success"] is False
    assert "leave pinned page host" in out["error"]
    session.event_bus.dispatch.assert_not_called()

    out_switch = await service_actions.execute_action(
        dom_service=dom,
        action_history=ah,
        action={"action": "switch_tab", "params": {"tab_id": "ab12"}},
        current_url="https://checkout.example.com/c/pay/cs_live_x",
        navigation_origin_base_domain="merchant.com",
    )
    assert out_switch["success"] is False
    assert "leave pinned page host" in out_switch["error"]
    session.event_bus.dispatch.assert_not_called()


async def test_execute_evaluate_refuses_navigation_while_pinned():
    """Fleet 0b3b582b: evaluate location/href escapes the handoff pin."""
    from domains.spawn_browser_agent_v3 import service_actions

    assert service_actions.evaluate_code_looks_like_navigation(
        "window.location.href = 'https://www.merchant.com/'"
    )
    assert service_actions.evaluate_code_looks_like_navigation("history.back()")
    assert not service_actions.evaluate_code_looks_like_navigation(
        "document.querySelector('#card-number')?.value"
    )

    session = _fake_session_with_event_bus()
    dom = MagicMock()
    dom.session = session
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await service_actions.execute_action(
        dom_service=dom,
        action_history=ah,
        action={
            "action": "evaluate",
            "params": {"code": "window.location.href = 'https://www.merchant.com/cart'"},
        },
        current_url="https://checkout.example.com/c/pay/cs_live_x",
        navigation_origin_base_domain="merchant.com",
    )
    assert out["success"] is False
    assert "evaluate that would navigate" in out["error"]


async def test_execute_press_key_and_click_refuse_leave_while_pinned():
    """Fleet d2a9805f: Ctrl+Shift+W and Return-to-merchant href escaped the pin."""
    from domains.spawn_browser_agent_v3 import service_actions

    assert service_actions.press_key_looks_like_leave_page("Control+Shift+W")
    assert service_actions.press_key_looks_like_leave_page("Alt+Left")
    assert not service_actions.press_key_looks_like_leave_page("Enter")

    session = _fake_session_with_event_bus()
    dom = MagicMock()
    dom.session = session
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await service_actions.execute_action(
        dom_service=dom,
        action_history=ah,
        action={"action": "press_key", "params": {"key": "Control+Shift+W"}},
        current_url="https://checkout.example.com/c/pay/cs_live_x",
        navigation_origin_base_domain="merchant.com",
    )
    assert out["success"] is False
    assert "key chord" in out["error"]

    leave_el = MagicMock()
    leave_el.attributes = {"href": "https://www.merchant.com/cart"}
    same_el = MagicMock()
    same_el.attributes = {"href": "https://pay.example.com/confirm"}
    assert (
        service_actions.click_href_leaves_pinned_base(leave_el, "checkout.example.com")
        == "https://www.merchant.com/cart"
    )
    assert (
        service_actions.click_href_leaves_pinned_base(same_el, "checkout.example.com")
        is None
    )

    dom.selector_map = {3: leave_el}
    out_click = await service_actions.execute_action(
        dom_service=dom,
        action_history=ah,
        action={"action": "click", "index": 3, "params": {}},
        current_url="https://checkout.example.com/c/pay/cs_live_x",
        navigation_origin_base_domain="merchant.com",
    )
    assert out_click["success"] is False
    assert "click that navigates off pinned host" in out_click["error"]
    session.event_bus.dispatch.assert_not_called()


def test_handoff_pin_is_sticky_in_handler():
    """Once handoff is observed, pin host is persisted (not cleared on return to origin)."""
    import inspect

    from domains.spawn_browser_agent_v3 import handler

    source = inspect.getsource(handler._spawn_browser_agent_activity_v3_real)
    assert "navigation_pin_url" in source
    assert "Auto-returning to pinned handoff host" in source
    assert "navigation_origin_base_domain" in source
    assert "Auto-filled payment refs on pinned handoff page" in source
    assert "Handoff payment auto-fill exhausted; pin retained" in source
    assert "handoff_payment_fill_attempts" in source
    assert '"text": "card_number"' in source
    assert "wait_for_payment_ref_fields" in source
    assert "Waiting for payment fields on handoff page" in source
    assert "timeout_seconds=4.0" in source
    # Prefer the live Playwright page (titled payment iframes) over humanizer-only.
    assert "_autofill_page = input_page" in source
    # Attempt counter must only advance after fields are ready (else burns retries).
    wait_offset = source.index("wait_for_payment_ref_fields")
    attempt_offset = source.index("handoff_payment_fill_attempts += 1")
    assert wait_offset < attempt_offset
    # Auto-fill gate must stay host/path agnostic.
    auto_fill_start = source.index("handoff_payment_fill_attempts += 1")
    auto_fill_end = source.index("if browser_recorder:", auto_fill_start)
    auto_fill_block = source[auto_fill_start:auto_fill_end]
    assert "checkout.stripe" not in auto_fill_block
    assert "test_payment" not in auto_fill_block
    assert "api.stripe" not in auto_fill_block
    assert "Payment auto-fill exhausted — pin held; fill manually" in auto_fill_block
    assert "Released handoff pin — no payment fields found" not in auto_fill_block
    assert "navigation_pin_host = None" not in auto_fill_block


def test_recovery_skips_when_live_tab_already_clear():
    """LLM-invented recovery on a clean page must no-op (no host special-cases)."""
    import inspect

    from domains.spawn_browser_agent_v3 import handler

    source = inspect.getsource(handler._spawn_browser_agent_activity_v3_real)
    start = source.index('if action_name == "recover_from_challenge":')
    end = source.index('if action_name == "send_message_to_user":', start)
    recovery_block = source[start:end]

    assert "live_tab_looks_challenged" in recovery_block
    assert "skipped_clean_page" in recovery_block
    assert "provider_exit_rejected" in recovery_block
    assert "is_hosted_stripe_checkout_url" not in recovery_block
    assert "healthcheck_noise" not in recovery_block
    assert "api.stripe.com" not in recovery_block
    assert "target_looks_like_payment_document" not in recovery_block
    # Skip must run before capturing storage / rotating providers.
    skip_offset = recovery_block.index("skipped_clean_page")
    capture_offset = recovery_block.index("await _capture_recovery_storage_state(")
    assert skip_offset < capture_offset


def test_navigation_guard_has_no_endpoint_path_allowlists():
    """Nav guards must not special-case payment/checkout path markers."""
    import inspect

    from domains.spawn_browser_agent_v3 import service_actions

    source = inspect.getsource(service_actions._navigation_guard_error)
    assert "target_looks_like_payment_document" not in source
    assert "payment page" not in source
    assert "effective_navigation_pin_host" in source
    assert "url_looks_like_api_surface" in source


async def test_execute_goto_injects_local_storage():
    from domains.spawn_browser_agent_v3 import service_actions

    session = _fake_session_with_event_bus()
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    with (
        patch.object(
            service_actions,
            "inject_local_storage",
            AsyncMock(return_value={"injected": True, "count": 3}),
        )
        if False
        else patch(
            "domains.spawn_browser_agent_v3.repo.inject_local_storage",
            AsyncMock(return_value={"injected": True, "count": 3}),
        )
    ):
        out = await service_actions._execute_goto(
            session=session,
            dom_service=dom,
            action_history=ah,
            params={"url": "https://x.com"},
            thinking=None,
            session_id="sid",
            config=_fake_config(),
        )
    assert out["success"] is True

async def test_execute_goto_injects_local_storage_swallows_error():
    from domains.spawn_browser_agent_v3 import service_actions

    session = _fake_session_with_event_bus()
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    with patch(
        "domains.spawn_browser_agent_v3.repo.inject_local_storage",
        AsyncMock(side_effect=RuntimeError("x")),
    ):
        out = await service_actions._execute_goto(
            session=session,
            dom_service=dom,
            action_history=ah,
            params={"url": "https://x.com"},
            thinking=None,
            session_id="sid",
            config=_fake_config(),
        )
    assert out["success"] is True

async def test_wait_for_navigation_ready_reloads_blank_spa_shell_once():
    from domains.spawn_browser_agent_v3 import service_actions

    class FakePage:
        def __init__(self):
            self.reloads = 0
            self.evaluations = 0

        async def wait_for_load_state(self, *_args, **_kwargs):
            return None

        async def evaluate(self, _code):
            self.evaluations += 1
            if self.reloads == 0:
                return json.dumps(
                    {
                        "hasAppRoot": True,
                        "appRootReady": False,
                        "plainPageReady": False,
                        "bodyTextLength": 677,
                        "rootChildren": 0,
                        "blankSpaShell": True,
                    }
                )
            return {
                "hasAppRoot": True,
                "appRootReady": True,
                "plainPageReady": False,
                "bodyTextLength": 12,
                "rootChildren": 1,
                "blankSpaShell": False,
            }

        async def reload(self):
            self.reloads += 1
            return None

    page = FakePage()
    session = _fake_session_with_event_bus()
    session.get_current_page = AsyncMock(return_value=page)
    dom = MagicMock()
    dom.session = session

    monotonic_time = 0.0

    async def advance_clock(_seconds):
        nonlocal monotonic_time
        monotonic_time += 1.0

    with (
        patch.object(service_actions.asyncio, "sleep", advance_clock),
        patch.object(service_actions.time_module, "monotonic", lambda: monotonic_time),
    ):
        out = await service_actions.wait_for_navigation_ready(
            dom_service=dom,
            url="https://x.com/app",
            timeout_seconds=0.001,
        )

    assert out["ready"] is True
    assert page.reloads == 1
    assert page.evaluations >= 2

async def test_wait_for_navigation_ready_regotos_stuck_loading_document_once():
    from domains.spawn_browser_agent_v3 import service_actions

    class FakePage:
        def __init__(self):
            self.gotos = []
            self.evaluations = 0

        async def wait_for_load_state(self, *_args, **_kwargs):
            return None

        async def evaluate(self, _code):
            self.evaluations += 1
            if not self.gotos:
                return {
                    "readyState": "loading",
                    "hasAppRoot": False,
                    "appRootReady": False,
                    "plainPageReady": False,
                    "bodyTextLength": 0,
                    "bodyChildren": 0,
                    "blankSpaShell": False,
                }
            return {
                "readyState": "complete",
                "hasAppRoot": True,
                "appRootReady": True,
                "plainPageReady": False,
                "bodyTextLength": 12,
                "rootChildren": 1,
                "blankSpaShell": False,
            }

        async def goto(self, url, **_kwargs):
            self.gotos.append(url)
            return None

    page = FakePage()
    session = _fake_session_with_event_bus()
    session.get_current_page = AsyncMock(return_value=page)
    dom = MagicMock()
    dom.session = session

    monotonic_time = 0.0

    async def advance_clock(_seconds):
        nonlocal monotonic_time
        monotonic_time += 1.0

    with (
        patch.object(service_actions.asyncio, "sleep", advance_clock),
        patch.object(service_actions.time_module, "monotonic", lambda: monotonic_time),
    ):
        out = await service_actions.wait_for_navigation_ready(
            dom_service=dom,
            url="https://x.com/app",
            timeout_seconds=0.001,
        )

    assert out["ready"] is True
    assert page.gotos == ["https://x.com/app"]
    assert page.evaluations >= 2

# ── _execute_extract ─────────────────────────────────────────────────

async def test_execute_extract_disabled():
    from domains.spawn_browser_agent_v3 import service_actions

    session = MagicMock()
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()

    out = await service_actions._execute_extract(
        session=session,
        dom_service=dom,
        action_history=ah,
        params={"instruction": "what?"},
        thinking=None,
    )
    assert out["success"] is False
    assert "extract is disabled" in out["error"]

# ── _execute_upload_file ─────────────────────────────────────────────

async def test_execute_upload_file_success():
    from domains.spawn_browser_agent_v3 import service_actions

    session = _fake_session_with_event_bus()
    session.is_file_input = MagicMock(return_value=True)
    dom = MagicMock()
    dom.get_element_coordinates = AsyncMock(return_value=(3, 4))
    element = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    hu = MagicMock()
    hu.click_at_coords = AsyncMock()
    with patch("browser_use.browser.events.UploadFileEvent", lambda **kw: kw):
        out = await service_actions._execute_upload_file(
            session=session,
            dom_service=dom,
            action_history=ah,
            element=element,
            index=5,
            params={"filename": "doc.pdf"},
            thinking=None,
            humanizer=hu,
            available_file_paths={"doc.pdf": "/tmp/doc.pdf"},
        )
    assert out["success"] is True
    assert out["uploaded"] == "doc.pdf"

async def test_execute_upload_file_missing_element():
    from domains.spawn_browser_agent_v3 import service_actions

    session = MagicMock()
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await service_actions._execute_upload_file(
        session=session,
        dom_service=dom,
        action_history=ah,
        element=None,
        index=1,
        params={"filename": "doc.pdf"},
        thinking=None,
        humanizer=None,
        available_file_paths={"doc.pdf": "/tmp/doc.pdf"},
    )
    assert out["success"] is False
    assert "element index" in out["error"]

async def test_execute_upload_file_not_file_input():
    from domains.spawn_browser_agent_v3 import service_actions

    session = MagicMock()
    session.is_file_input = MagicMock(return_value=False)
    dom = MagicMock()
    element = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await service_actions._execute_upload_file(
        session=session,
        dom_service=dom,
        action_history=ah,
        element=element,
        index=2,
        params={"filename": "doc.pdf"},
        thinking=None,
        humanizer=None,
        available_file_paths={"doc.pdf": "/tmp/doc.pdf"},
    )
    assert out["success"] is False
    assert "not a file input" in out["error"]

# ── _execute_switch_tab / _execute_close_tab ─────────────────────────

async def test_execute_switch_tab_success():
    from domains.spawn_browser_agent_v3 import service_actions

    session = _fake_session_with_event_bus()
    session.get_tabs = AsyncMock(return_value=[SimpleNamespace(target_id="aaaaaaaa1234", title="t", url="u")])
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await service_actions._execute_switch_tab(
        session=session,
        dom_service=dom,
        action_history=ah,
        params={"tab_id": "1234"},
        thinking=None,
    )
    assert out["success"] is True
    assert out["switched_to"] == "1234"

async def test_execute_switch_tab_missing_id():
    from domains.spawn_browser_agent_v3 import service_actions

    session = MagicMock()
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await service_actions._execute_switch_tab(
        session=session,
        dom_service=dom,
        action_history=ah,
        params={},
        thinking=None,
    )
    assert out["success"] is False

async def test_execute_close_tab_with_explicit_id():
    from domains.spawn_browser_agent_v3 import service_actions

    session = _fake_session_with_event_bus()
    session.get_tabs = AsyncMock(return_value=[SimpleNamespace(target_id="zzzzzzzz5678", title="t", url="u")])
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    out = await service_actions._execute_close_tab(
        session=session,
        dom_service=dom,
        action_history=ah,
        params={"tab_id": "5678"},
        thinking=None,
    )
    assert out["success"] is True
    assert out["closed_tab"] == "5678"

# ── _execute_screenshot ──────────────────────────────────────────────

async def test_execute_screenshot_success():
    """Screenshot success path crops the Steel computer display to viewport size."""
    from domains.spawn_browser_agent_v3 import service_actions
    from PIL import Image

    session = MagicMock()
    image_buffer = BytesIO()
    Image.new("RGB", (1288, 891), color="white").save(image_buffer, format="PNG")
    screenshot_b64 = base64.b64encode(image_buffer.getvalue()).decode()
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    upload_mock = AsyncMock(return_value={"path": "/tmp/s.png"})
    with (
        patch(
            "domains.spawn_browser_agent_v3.repo.take_browser_computer_screenshot",
            AsyncMock(return_value={"provider": "steel", "base64_image": screenshot_b64}),
        ),
        patch(
            "domains.spawn_browser_agent_v3.repo.upload_file_to_session",
            upload_mock,
        ),
    ):
        out = await service_actions._execute_screenshot(
            session=session,
            dom_service=dom,
            action_history=ah,
            thinking=None,
            session_id="sid",
            config=_fake_config(),
        )
    assert out["success"] is True
    assert out["file_path"] == "/tmp/s.png"
    cropped = Image.open(BytesIO(base64.b64decode(out["screenshot"])))
    assert cropped.size == (1283, 800)
    uploaded_bytes = upload_mock.await_args.args[3]
    uploaded = Image.open(BytesIO(uploaded_bytes))
    assert uploaded.size == (1283, 800)
    session.get_or_create_cdp_session.assert_not_called()

async def test_execute_screenshot_requires_steel_image():
    """Missing provider screenshot data fails instead of falling back to CDP."""
    from domains.spawn_browser_agent_v3 import service_actions

    session = MagicMock()
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    with patch(
        "domains.spawn_browser_agent_v3.repo.take_browser_computer_screenshot",
        AsyncMock(side_effect=RuntimeError("Browser screenshot did not return an image")),
    ):
        try:
            await service_actions._execute_screenshot(
                session=session,
                dom_service=dom,
                action_history=ah,
                thinking=None,
                session_id="sid",
                config=None,
            )
        except RuntimeError as exc:
            assert "did not return an image" in str(exc)
        else:
            raise AssertionError("expected screenshot failure to propagate")

# ── move_visual_cursor happy path ────────────────────────────────────

async def test_move_visual_cursor_success():
    from domains.spawn_browser_agent_v3.service_actions import move_visual_cursor

    cdp = MagicMock()
    cdp.session_id = "sid"
    cdp.cdp_client.send.Runtime.evaluate = AsyncMock(return_value={"result": {}})
    dom = MagicMock()
    dom.session = MagicMock()
    dom.session.get_or_create_cdp_session = AsyncMock(return_value=cdp)
    await move_visual_cursor(dom, 100, 200)
    cdp.cdp_client.send.Runtime.evaluate.assert_awaited()

# ========================================
# handler: ClaudeTokenState and workflow helper statics
# ========================================

def test_claude_token_state_defaults():
    from domains.spawn_browser_agent_v3.types import ClaudeTokenState

    s = ClaudeTokenState()
    assert s.access_token is None
    assert s.source is None
    assert s.pool_token_id is None
    assert s.excluded_pool_ids == []
    assert s.fallen_back_to_waterfall is False

def test_claude_token_state_mutation():
    from domains.spawn_browser_agent_v3.types import ClaudeTokenState

    s = ClaudeTokenState()
    s.access_token = "t"
    s.source = "pool"
    s.pool_token_id = "p1"
    s.excluded_pool_ids.append("p0")
    s.fallen_back_to_waterfall = True
    assert s.access_token == "t"
    assert s.excluded_pool_ids == ["p0"]

def test_get_manager_singleton():
    from domains.spawn_browser_agent_v3.handler import (
        SpawnBrowserAgentManagerV3,
        get_manager,
    )

    m1 = get_manager()
    m2 = get_manager()
    assert m1 is m2
    assert isinstance(m1, SpawnBrowserAgentManagerV3)
    assert m1.tool_name == "spawn_browser_agent"

def test_render_write_lock_notification_question_uses_purchase_metadata():
    from domains.spawn_browser_agent_v3.handler import _render_write_lock_notification_question

    question = _render_write_lock_notification_question(
        {
            "trigger_type": "purchase",
            "action": "Buy one black Carhartt beanie",
            "service": {
                "name": "Amazon",
                "domain": "amazon.com",
                "url": "https://www.amazon.com/checkout/spc",
            },
            "media": [
                {
                    "url": "https://m.media-amazon.com/images/I/beanie.jpg",
                    "alt": "Carhartt beanie",
                    "kind": "product",
                }
            ],
            "purchase": {
                "items": [
                    {
                        "title": "Carhartt Mens Knit Cuffed Beanie Hat, Black",
                        "price": "$19.99",
                        "quantity": "1",
                        "rating": "4.8 stars",
                        "review_count": "167,432 reviews",
                        "product_url": "https://www.amazon.com/dp/B000000001",
                        "seller": "Amazon.com",
                        "shipping": "FREE Two Day delivery, arriving Saturday, Jun 27, 2026",
                    }
                ],
                "totals": {
                    "subtotal": "$19.99",
                    "shipping": "$0.00",
                    "tax": "$1.72",
                    "total": "$21.71",
                },
                "payment_method": "Visa ending in 9857",
                "delivery_address": "Aman Gottumukkala, 88 HOWARD ST APT 1413, SAN FRANCISCO, CA 94105",
            },
        },
        system_name="Rose",
        fallback_question="fallback question",
    )

    assert "Rose wants to buy one black Carhartt beanie on **Amazon**." in question
    assert "Carhartt Mens Knit Cuffed Beanie Hat, Black" in question
    assert "Price: $19.99" in question
    assert "Rating: 4.8 stars" in question
    assert "Reviews: 167,432 reviews" in question
    assert "Product: [View product](https://www.amazon.com/dp/B000000001)" in question
    assert "Seller: Amazon.com" in question
    assert "Shipping: FREE Two Day delivery" in question
    assert "Total: $21.71" in question
    assert "Payment: Visa ending in 9857" in question
    assert "Delivery: Aman Gottumukkala" in question
    assert "**Image:** https://m.media-amazon.com/images/I/beanie.jpg" in question
    assert "fallback question" not in question
    assert "https://www.amazon.com/checkout/spc" not in question
    assert "click" not in question.lower()

def test_normalize_write_lock_notification_media_promotes_item_image():
    from domains.spawn_browser_agent_v3.handler import (
        _normalize_write_lock_notification_media,
    )

    notification = {
        "trigger_type": "purchase",
        "media": [],
        "purchase": {
            "items": [
                {
                    "title": "Carhartt beanie",
                    "image_url": "https://m.media-amazon.com/images/I/beanie.jpg",
                }
            ]
        },
    }

    out = _normalize_write_lock_notification_media(notification, browser_state={})

    assert out["media"] == [
        {
            "url": "https://m.media-amazon.com/images/I/beanie.jpg",
            "alt": "Purchase item image",
            "kind": "product",
        }
    ]

async def test_generate_write_lock_notification_payment_forks_and_renders_question():
    """The payment-approval path (#662) forks browser-use to mint a rich write-lock
    notification. Validate the helper builds a validated notification, normalizes media,
    renders a payment question, and threads usage/model/request metadata through."""
    import domains.spawn_browser_agent_v3.handler as handler
    from domains.spawn_browser_agent_v3.handler import _generate_write_lock_notification
    from domains.spawn_browser_agent_v3.types import ClaudeTokenState

    token_state = ClaudeTokenState()
    token_state.access_token = "claude-token"
    token_state.source = "user"

    fork_action = {
        "action": "generate_write_lock_notification",
        "params": {
            "trigger_type": "payment",
            "action": "enter payment details",
            "service": {
                "name": "Delta",
                "domain": "delta.com",
                "url": "https://www.delta.com/checkout",
            },
            "media": [
                {
                    "url": "https://cdn.delta.com/receipt.png",
                    "alt": "Booking summary",
                    "kind": "page_preview",
                }
            ],
            "payment": {
                "merchant": "Delta Air Lines",
                "amount": "$412.30",
                "purpose": "Flight SFO -> JFK",
                "fields": ["card number", "expiration date", "CVV"],
            },
        },
    }

    fork_mock = AsyncMock(
        return_value={
            "action": fork_action,
            "usage": {"input_tokens": 1200, "output_tokens": 88},
            "actual_model": "claude-sonnet-4-6-claude",
            "request_id": "req-pay-1",
            "mode": "claudeAuth",
        }
    )

    with patch.object(handler, "_call_browser_use_with_rotation", new=fork_mock):
        result = await _generate_write_lock_notification(
            rose_client=SimpleNamespace(),
            task_prompt="Book the cheapest Delta flight",
            dynamic_system_context="dynamic-ctx",
            browser_turn_messages=[{"role": "user", "content": "checkout"}],
            browser_state={"url": "https://www.delta.com/checkout", "screenshot": None},
            action_entries=[{"type": "click"}],
            config=_fake_config(),
            user_id="user-pay",
            agent_id="agent-pay",
            iteration=7,
            token_state=token_state,
            gpt_token=None,
            gpt_account_id=None,
            gpt_token_source=None,
            gpt_token_pool_id=None,
            browser_use_mode="claude",
            approval_type="payment",
            current_url="https://www.delta.com/checkout",
            trusted_page_urls=["https://www.delta.com/checkout"],
            pending_action={"action": "click", "params": {"index": 4}},
            write_lock_result={"status": "awaiting_payment_card_approval"},
            system_name="Rose",
            fallback_question="Rose wants to make a purchase. Approve?",
        )

    # Fork was invoked with the write-lock notification call site + skip_cache_write.
    fork_mock.assert_awaited_once()
    fork_kwargs = fork_mock.await_args.kwargs
    assert fork_kwargs["call_site"] == "write_lock_notification_fork_7"
    assert fork_kwargs["skip_cache_write"] is True
    assert fork_kwargs["dump_extra"]["approval_type"] == "payment"
    # The fork prompt is appended as an extra user message.
    extra = fork_kwargs["extra_user_messages"]
    assert extra and extra[0]["role"] == "user"

    # Notification is validated + tool key stripped.
    notification = result["notification"]
    assert "tool" not in notification
    assert notification["trigger_type"] == "payment"
    assert notification["payment"]["merchant"] == "Delta Air Lines"

    # Question renders payment metadata (not the fallback) and hides secrets.
    question = result["question"]
    assert "Rose wants to enter payment details on **Delta**." in question
    assert "Merchant: Delta Air Lines" in question
    assert "Amount: $412.30" in question
    assert "Fields: card number, expiration date, CVV" in question
    assert "Payment secrets are not included in this message." in question
    assert "Approve?" not in question  # fallback_question was not used

    # Usage/model/request metadata threaded through for token accounting.
    assert result["usage"] == {"input_tokens": 1200, "output_tokens": 88}
    assert result["actual_model"] == "claude-sonnet-4-6-claude"
    assert result["request_id"] == "req-pay-1"
    assert result["mode"] == "claudeAuth"

async def test_generate_write_lock_notification_raises_when_fork_calls_wrong_tool():
    """If the forked model calls anything other than generate_write_lock_notification,
    the helper raises so the caller falls back to build_payment_question rather than
    surfacing a malformed notification."""
    import domains.spawn_browser_agent_v3.handler as handler
    from domains.spawn_browser_agent_v3.handler import _generate_write_lock_notification
    from domains.spawn_browser_agent_v3.types import ClaudeTokenState

    token_state = ClaudeTokenState()
    token_state.access_token = "claude-token"
    token_state.source = "user"

    fork_mock = AsyncMock(return_value={"action": {"action": "click", "params": {"index": 1}}})

    with patch.object(handler, "_call_browser_use_with_rotation", new=fork_mock):
        raised = None
        try:
            await _generate_write_lock_notification(
                rose_client=SimpleNamespace(),
                task_prompt="Buy socks",
                dynamic_system_context="ctx",
                browser_turn_messages=[],
                browser_state={"url": "https://shop.example/checkout"},
                action_entries=[],
                config=_fake_config(),
                user_id="u1",
                agent_id="a1",
                iteration=2,
                token_state=token_state,
                gpt_token=None,
                gpt_account_id=None,
                gpt_token_source=None,
                gpt_token_pool_id=None,
                browser_use_mode="claude",
                approval_type="payment",
                current_url="https://shop.example/checkout",
                trusted_page_urls=["https://shop.example/checkout"],
                pending_action={"action": "click"},
                write_lock_result={"status": "awaiting_payment_card_approval"},
                system_name="Rose",
                fallback_question="Approve purchase?",
            )
        except ValueError as exc:
            raised = exc

    assert raised is not None
    assert "did not call generate_write_lock_notification" in str(raised)
    assert "'click'" in str(raised)

def test_extract_media_candidates_from_dom_state_keeps_image_urls_outside_llm_dom_text():
    from browser_tools.dom_service import _extract_media_candidates_from_dom_state

    class Node(SimpleNamespace):
        def get_all_children_text(self, max_depth=-1):
            return getattr(self, "text", "")

    product = Node(
        tag_name="img",
        attributes={
            "alt": "Carhartt Mens Knit Cuffed Beanie Hat, Black, One Size US",
            "data-a-dynamic-image": json.dumps(
                {
                    "https://m.media-amazon.com/images/I/71yRzB6pknL._AC_SX679_.jpg": [
                        679,
                        679,
                    ]
                }
            ),
        },
        is_visible=True,
        parent_node=Node(
            tag_name="div",
            attributes={},
            text="Carhartt Mens Knit Cuffed Beanie Hat, Black, One Size US $19.99 Ships from Amazon.com",
        ),
    )
    logo = Node(
        tag_name="img",
        attributes={"alt": "Amazon logo", "src": "/logo.svg"},
        is_visible=True,
        parent_node=None,
    )
    root = SimpleNamespace(
        original_node=Node(tag_name="body", attributes={}, is_visible=True),
        should_display=True,
        children=[
            SimpleNamespace(original_node=logo, should_display=True, children=[]),
            SimpleNamespace(original_node=product, should_display=True, children=[]),
        ],
    )

    candidates = _extract_media_candidates_from_dom_state(
        SimpleNamespace(_root=root),
        page_url="https://www.amazon.com/checkout/spc",
    )

    assert candidates[0]["url"] == "https://m.media-amazon.com/images/I/71yRzB6pknL._AC_SX679_.jpg"
    assert candidates[0]["alt"] == "Carhartt Mens Knit Cuffed Beanie Hat, Black, One Size US"
    assert "Ships from Amazon.com" in candidates[0]["nearby_text"]
    assert all(not candidate["url"].endswith(".svg") for candidate in candidates)

def test_extract_media_candidates_prefers_checkout_product_jpeg_over_small_art():
    from browser_tools.dom_service import _extract_media_candidates_from_dom_state

    class Node(SimpleNamespace):
        def get_all_children_text(self, max_depth=-1):
            return getattr(self, "text", "")

    nodes = [
        Node(
            tag_name="img",
            attributes={"src": "https://m.media-amazon.com/images/I/01+F-I5m3TL.png"},
            is_visible=True,
            parent_node=Node(tag_name="div", attributes={}, text="As fast as 3 hours"),
            snapshot_node=SimpleNamespace(clientRects=SimpleNamespace(x=0, y=0, width=12, height=16)),
        ),
        Node(
            tag_name="img",
            attributes={
                "alt": "Prime Store Card",
                "src": "https://m.media-amazon.com/images/G/01/credit/PLCC/CardArt/prime-storecard_default_marketing_edge1._CB583933359_.png",
            },
            is_visible=True,
            parent_node=Node(tag_name="div", attributes={}, text="Prime Store Card"),
        ),
        Node(
            tag_name="img",
            attributes={
                "src": "https://m.media-amazon.com/images/I/81W5UTTEaYL._AC_AA540_.jpg",
            },
            is_visible=True,
            parent_node=Node(tag_name="div", attributes={}, text=""),
        ),
    ]
    root = SimpleNamespace(
        original_node=Node(tag_name="body", attributes={}, is_visible=True),
        should_display=True,
        children=[SimpleNamespace(original_node=node, should_display=True, children=[]) for node in nodes],
    )

    candidates = _extract_media_candidates_from_dom_state(
        SimpleNamespace(_root=root),
        page_url="https://www.amazon.com/checkout/spc",
    )

    assert candidates[0]["url"] == "https://m.media-amazon.com/images/I/81W5UTTEaYL._AC_AA540_.jpg"

def test_write_lock_notification_prompt_includes_media_candidates():
    from domains.spawn_browser_agent_v3.handler import _write_lock_notification_prompt

    prompt = _write_lock_notification_prompt(
        approval_type="purchase",
        current_url="https://www.amazon.com/checkout/spc",
        pending_action={"action": "click", "params": {"index": 123}},
        write_lock_result={"status": "needs_write_approval"},
        media_candidates=[
            {
                "url": "https://m.media-amazon.com/images/I/beanie.jpg",
                "alt": "Carhartt beanie",
                "nearby_text": "Carhartt beanie $19.99",
            }
        ],
    )

    assert "media_candidates" in prompt
    assert "https://m.media-amazon.com/images/I/beanie.jpg" in prompt
    assert "use only those URLs for media and item image_url" in prompt
    assert "description under 80 characters" in prompt
    assert "must already exist in the browser trajectory" in prompt
    assert "Visit the product page" not in prompt

def test_purchase_write_lock_notification_failure_blocks_approval_fallback():
    from domains.spawn_browser_agent_v3.handler import (
        PurchaseApprovalContextError,
        PurchaseApprovalNotificationRetryableError,
        _enforce_write_lock_notification_failure_policy,
    )

    with pytest.raises(PurchaseApprovalContextError):
        _enforce_write_lock_notification_failure_policy(
            "purchase",
            PurchaseApprovalContextError("missing reviews"),
        )

    with pytest.raises(PurchaseApprovalNotificationRetryableError):
        _enforce_write_lock_notification_failure_policy("purchase", TimeoutError("provider timeout"))

    assert _enforce_write_lock_notification_failure_policy("message", ValueError("metadata unavailable")) is None

def test_normalize_write_lock_notification_media_uses_matching_media_candidate():
    from domains.spawn_browser_agent_v3.handler import (
        _normalize_write_lock_notification_media,
    )

    notification = {
        "trigger_type": "purchase",
        "media": [],
        "purchase": {
            "items": [
                {
                    "title": "Carhartt Mens Knit Cuffed Beanie Hat, Black, One Size US",
                    "price": "$19.99",
                }
            ]
        },
    }

    out = _normalize_write_lock_notification_media(
        notification,
        browser_state={
            "media_candidates": [
                {
                    "url": "https://example.com/logo.jpg",
                    "alt": "Amazon logo",
                    "nearby_text": "Amazon",
                    "visible": True,
                },
                {
                    "url": "https://m.media-amazon.com/images/I/beanie.jpg",
                    "alt": "Carhartt Mens Knit Cuffed Beanie Hat, Black, One Size US",
                    "nearby_text": "Carhartt Mens Knit Cuffed Beanie Hat, Black, One Size US $19.99",
                    "visible": True,
                },
            ]
        },
    )

    assert out["media"] == [
        {
            "url": "https://m.media-amazon.com/images/I/beanie.jpg",
            "alt": "Carhartt Mens Knit Cuffed Beanie Hat, Black, One Size US",
            "kind": "product",
        }
    ]
    assert out["purchase"]["items"][0]["image_url"] == "https://m.media-amazon.com/images/I/beanie.jpg"

def test_normalize_write_lock_notification_media_prefers_product_jpeg_without_text_match():
    from domains.spawn_browser_agent_v3.handler import (
        _normalize_write_lock_notification_media,
    )

    notification = {
        "trigger_type": "purchase",
        "media": [],
        "purchase": {
            "items": [
                {
                    "title": "Carhartt Mens Knit Cuffed Beanie Hat, Black, One Size US",
                    "price": "$19.99",
                }
            ]
        },
    }

    out = _normalize_write_lock_notification_media(
        notification,
        browser_state={
            "media_candidates": [
                {
                    "url": "https://m.media-amazon.com/images/I/01+F-I5m3TL.png",
                    "alt": None,
                    "nearby_text": "As fast as 3 hours",
                    "visible": True,
                    "bounds": {"x": 0, "y": 0, "width": 12, "height": 16},
                },
                {
                    "url": "https://m.media-amazon.com/images/G/01/credit/PLCC/CardArt/prime-storecard_default_marketing_edge1._CB583933359_.png",
                    "alt": "Prime Store Card",
                    "nearby_text": "Prime Store Card",
                    "visible": True,
                    "bounds": {"x": 0, "y": 0, "width": 0, "height": 0},
                },
                {
                    "url": "https://m.media-amazon.com/images/I/81W5UTTEaYL._AC_AA135_.jpg",
                    "alt": None,
                    "nearby_text": "",
                    "visible": True,
                    "bounds": {"x": 0, "y": 0, "width": 0, "height": 0},
                },
                {
                    "url": "https://m.media-amazon.com/images/I/81W5UTTEaYL._AC_AA540_.jpg",
                    "alt": None,
                    "nearby_text": "",
                    "visible": True,
                    "bounds": {"x": 0, "y": 0, "width": 0, "height": 0},
                },
            ]
        },
    )

    assert out["media"][0]["url"] == "https://m.media-amazon.com/images/I/81W5UTTEaYL._AC_AA540_.jpg"
    assert out["purchase"]["items"][0]["image_url"] == "https://m.media-amazon.com/images/I/81W5UTTEaYL._AC_AA540_.jpg"

def test_normalize_write_lock_notification_media_uses_checkout_screenshot():
    from domains.spawn_browser_agent_v3.handler import (
        _normalize_write_lock_notification_media,
    )

    notification = {
        "trigger_type": "purchase",
        "media": [],
        "purchase": {"items": [{"title": "Carhartt beanie"}]},
    }

    out = _normalize_write_lock_notification_media(
        notification,
        browser_state={"screenshot": "AAAA"},
    )

    assert out["media"] == [
        {
            "url": "data:image/png;base64,AAAA",
            "alt": "Checkout page preview",
            "kind": "page_preview",
        }
    ]

def test_botsigged_diagnostics_enabled_requires_flag_and_domain():
    from domains.spawn_browser_agent_v3.handler import _botsigged_diagnostics_enabled

    with patch.dict(os.environ, {"BROWSER_AGENT_BOTSIGGED_DIAGNOSTICS": "1"}):
        assert _botsigged_diagnostics_enabled("https://botsigged.com/demo") is True
        assert _botsigged_diagnostics_enabled("https://example.com") is False

    with patch.dict(os.environ, {"BROWSER_AGENT_BOTSIGGED_DIAGNOSTICS": "0"}):
        assert _botsigged_diagnostics_enabled("https://botsigged.com/demo") is False

async def test_capture_botsigged_diagnostics_writes_json():
    import tempfile

    from domains.spawn_browser_agent_v3 import handler

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        diagnostics = {
            "url": "https://botsigged.com/demo",
            "lastScore": {
                "bot_score": 10,
                "classification": "human",
                "triggered_rules": ["too_efficient_paths"],
            },
            "signalCounts": {"mouseEvents": 3},
        }
        page = SimpleNamespace(evaluate=AsyncMock(return_value=diagnostics))

        with patch.object(handler, "browser_recording_output_dir", return_value=tmp_path):
            result = await handler._capture_botsigged_diagnostics(
                page,
                agent_id="agent-1",
                task_id="task-1",
                checkpoint="after_action_1_click",
            )

        output_path = tmp_path / "botsigged-diagnostics.json"
        assert result["path"] == str(output_path)
        written = json.loads(output_path.read_text())
        assert written["lastScore"]["triggered_rules"] == ["too_efficient_paths"]
        assert page.evaluate.await_args.args[1] == "after_action_1_click"

async def test_stop_playwright_resources_closes_browser_and_stops_instance():
    from domains.spawn_browser_agent_v3.handler import _stop_playwright_resources

    browser = AsyncMock()
    playwright = AsyncMock()

    await _stop_playwright_resources(browser, playwright, "agent-1")

    browser.close.assert_awaited_once()
    playwright.stop.assert_awaited_once()

async def test_stop_playwright_resources_reaps_lingering_driver_process():
    from domains.spawn_browser_agent_v3.handler import _stop_playwright_resources

    class FakeDriverProcess:
        pid = 12345
        returncode = None

        def __init__(self):
            self.terminated = False
            self.waits = 0

        async def wait(self):
            self.waits += 1
            if self.terminated:
                self.returncode = -15
                return self.returncode
            await asyncio.sleep(10)

        def terminate(self):
            self.terminated = True

        def kill(self):
            raise AssertionError("terminate should reap this fake process")

    process = FakeDriverProcess()
    playwright = SimpleNamespace(
        stop=AsyncMock(),
        _impl_obj=SimpleNamespace(
            _connection=SimpleNamespace(_transport=SimpleNamespace(_proc=process)),
        ),
    )

    await _stop_playwright_resources(None, playwright, "agent-1")

    playwright.stop.assert_awaited_once()
    assert process.terminated is True
    assert process.returncode == -15

def test_disable_cdp_websocket_proxy_sets_default_proxy_none():
    from domains.spawn_browser_agent_v3.handler import _disable_cdp_websocket_proxy

    calls = []

    def fake_connect(uri, *, proxy=True, **kwargs):
        calls.append({"uri": uri, "proxy": proxy, **kwargs})
        return "connected"

    fake_cdp_client = ModuleType("cdp_use.client")
    fake_cdp_client.websockets = SimpleNamespace(connect=fake_connect)

    with patch.dict(sys.modules, {"cdp_use.client": fake_cdp_client}):
        assert _disable_cdp_websocket_proxy() is True
        assert fake_cdp_client.websockets.connect("ws://example.test/devtools") == "connected"
        assert calls[-1]["proxy"] is None

        assert (
            fake_cdp_client.websockets.connect("ws://example.test/devtools", proxy="http://proxy.local") == "connected"
        )
        assert calls[-1]["proxy"] == "http://proxy.local"
        assert _disable_cdp_websocket_proxy() is False

def test_browser_activity_memory_cleanup_clears_retained_buffers():
    from domains.spawn_browser_agent_v3.handler import _clear_browser_activity_memory_buffers

    action_history = SimpleNamespace(clear=MagicMock())
    page = object()
    browser_session = object()
    cdp_client = object()
    recorder = SimpleNamespace(
        frames=[{"src": "frames/frame_00001.jpg"}],
        cursor_events=[{"x": 1, "y": 2}],
        _last_metadata={"step": 1},
        _cursor={"x": 1, "y": 2},
        page=page,
    )
    network_recorder = SimpleNamespace(
        entries={"request-1": {"body_file": "0001.txt"}},
        _diagnostic_entries=[{"url": "https://example.test"}],
        console_entries=[{"text": "error"}],
        _tasks={object()},
        _bodies={"request-1": "response"},
        _body_byte_sizes={"request-1": 8},
        _body_bytes=8,
        browser_session=browser_session,
        _cdp_client=cdp_client,
    )
    turn_messages = [{"role": "user", "content": "large DOM"}]
    browser_state = {"dom_tree": "large DOM", "screenshot": "base64"}
    seen_codes = {"123456"}

    _clear_browser_activity_memory_buffers(
        action_history=action_history,
        browser_recorder=recorder,
        browser_network_recorder=network_recorder,
        mutable_buffers=(turn_messages, browser_state, seen_codes),
    )

    action_history.clear.assert_called_once()
    assert recorder.frames == []
    assert recorder.cursor_events == []
    assert recorder._last_metadata == {}
    assert recorder._cursor is None
    assert recorder.page is None
    assert network_recorder.entries == {}
    assert network_recorder._diagnostic_entries == []
    assert network_recorder.console_entries == []
    assert network_recorder._tasks == set()
    assert network_recorder._bodies == {}
    assert network_recorder._body_byte_sizes == {}
    assert network_recorder._body_bytes == 0
    assert network_recorder.browser_session is None
    assert network_recorder._cdp_client is None
    assert turn_messages == []
    assert browser_state == {}
    assert seen_codes == set()

async def test_stop_playwright_resources_stops_instance_when_browser_close_fails():
    from domains.spawn_browser_agent_v3.handler import _stop_playwright_resources

    browser = AsyncMock()
    browser.close.side_effect = RuntimeError("connection already closed")
    playwright = AsyncMock()

    await _stop_playwright_resources(browser, playwright, "agent-1")

    browser.close.assert_awaited_once()
    playwright.stop.assert_awaited_once()

async def test_stop_playwright_resources_can_leave_live_browser_open():
    from domains.spawn_browser_agent_v3.handler import _stop_playwright_resources

    browser = AsyncMock()
    playwright = AsyncMock()

    await _stop_playwright_resources(browser, playwright, "agent-1", close_browser=False)

    browser.close.assert_not_awaited()
    playwright.stop.assert_awaited_once()

async def test_append_new_otp_user_messages_dedupes_and_logs():
    from domains.spawn_browser_agent_v3.handler import _append_new_otp_user_messages
    from domains.spawn_browser_agent_v3.service_crypto import ExtractedOTP

    seen = set()
    messages = []
    credential_refs = {}
    otps = [
        ExtractedOTP(
            code="123456",
            sender="Acme",
            received_at="now",
            age_seconds=1,
            ttl_seconds=299,
            credential_id="email-cred-1",
            source_message_id="m1",
        ),
        ExtractedOTP(
            code="123456",
            sender="Acme",
            received_at="now",
            age_seconds=2,
            ttl_seconds=298,
            source_message_id="m2",
        ),
    ]

    with patch(
        "domains.spawn_browser_agent_v3.handler.save_browser_credential_ref_message",
        AsyncMock(),
    ) as save_mock:
        count = await _append_new_otp_user_messages(
            otps=otps,
            seen_otp_codes=seen,
            otp_user_messages=messages,
            credential_refs_by_secret_ref=credential_refs,
            agent_id="ag1",
            task_id="task-1",
        )

    assert count == 1
    assert seen == {"123456"}
    assert len(messages) == 1
    assert messages[0]["role"] == "user"
    assert "123456" in messages[0]["content"]
    assert credential_refs == {"123456": {"kind": "email_otp", "id": "email-cred-1"}}
    save_mock.assert_awaited_once()

async def test_append_new_otp_user_messages_requires_email_credential_id_for_ref():
    from domains.spawn_browser_agent_v3.handler import _append_new_otp_user_messages
    from domains.spawn_browser_agent_v3.service_crypto import ExtractedOTP

    seen = set()
    messages = []
    credential_refs = {}
    otps = [
        ExtractedOTP(
            code="654321",
            sender="Acme",
            received_at="now",
            age_seconds=1,
            ttl_seconds=299,
            source_message_id="gmail-message-1",
        ),
    ]

    with patch(
        "domains.spawn_browser_agent_v3.handler.save_browser_credential_ref_message",
        AsyncMock(),
    ) as save_mock:
        count = await _append_new_otp_user_messages(
            otps=otps,
            seen_otp_codes=seen,
            otp_user_messages=messages,
            credential_refs_by_secret_ref=credential_refs,
            agent_id="ag1",
            task_id="task-1",
        )

    assert count == 1
    assert seen == {"654321"}
    assert len(messages) == 1
    assert credential_refs == {}
    save_mock.assert_not_awaited()

async def test_append_new_otp_user_messages_skips_stale_codes():
    from domains.spawn_browser_agent_v3.handler import _append_new_otp_user_messages
    from domains.spawn_browser_agent_v3.service_crypto import ExtractedOTP

    seen = set()
    messages = []
    credential_refs = {}
    otps = [
        ExtractedOTP(
            code="7777",
            sender="Uber",
            received_at="now",
            age_seconds=300,
            ttl_seconds=0,
            credential_id="email-cred-1",
            source_message_id="m1",
        ),
    ]

    with patch(
        "domains.spawn_browser_agent_v3.handler.save_browser_credential_ref_message",
        AsyncMock(),
    ) as save_mock:
        count = await _append_new_otp_user_messages(
            otps=otps,
            seen_otp_codes=seen,
            otp_user_messages=messages,
            credential_refs_by_secret_ref=credential_refs,
            agent_id="ag1",
            task_id="task-1",
        )

    assert count == 0
    assert seen == set()
    assert messages == []
    assert credential_refs == {}
    save_mock.assert_not_awaited()

async def test_spawn_browser_activity_requires_output_schema():
    from domains.spawn_browser_agent_v3.handler import spawn_browser_agent_activity_v3

    with patch(
        "domains.spawn_browser_agent_v3.handler.load_config",
        return_value=_fake_config(),
    ):
        try:
            await spawn_browser_agent_activity_v3(
                user_id="user-1",
                agent_id="agent-1",
                goal="Buy socks",
                tool_call_id="tool-1",
                use_claude_mode=False,
            )
        except ValueError as exc:
            assert "output_schema is required" in str(exc)
        else:
            raise AssertionError("expected missing output_schema to raise")

async def test_spawn_browser_activity_raises_when_new_session_has_no_cdp_url():
    from domains.spawn_browser_agent_v3.handler import spawn_browser_agent_activity_v3

    session_data = {
        "task_id": "task-1",
        "session_id": "session-1",
        "debug_url": "https://steel.example/debug",
        "ws_url": None,
        "fingerprint_injection": None,
        "passwords": [],
        "user_settings": {"name": "Andy", "addressLine1": "1 Main St"},
    }

    with (
        patch(
            "domains.spawn_browser_agent_v3.handler.load_config",
            return_value=_fake_config(),
        ),
        patch("domains.spawn_browser_agent_v3.handler.activity.heartbeat"),
        patch(
            "domains.spawn_browser_agent_v3.handler.init_browser_session",
            AsyncMock(return_value=session_data),
        ),
        patch(
            "domains.spawn_browser_agent_v3.handler.fetch_auth_options",
            AsyncMock(return_value={"realm": "example.com"}),
        ),
    ):
        try:
            await spawn_browser_agent_activity_v3(
                user_id="user-1",
                agent_id="agent-1",
                goal="Buy socks",
                tool_call_id="tool-1",
                output_schema={"fields": [{"name": "result", "type": "string"}]},
                use_claude_mode=False,
                start_url="https://example.com",
            )
        except RuntimeError as exc:
            assert "No CDP URL provided" in str(exc)
        else:
            raise AssertionError("expected missing cdp_url to raise")

async def test_spawn_browser_activity_raises_when_resumed_session_has_no_cdp_url():
    from domains.spawn_browser_agent_v3.handler import spawn_browser_agent_activity_v3

    session_info = {
        "session_id": "session-1",
        "debug_url": "https://steel.example/debug",
        "ws_url": None,
        "fingerprint_injection": {"ua": "test"},
        "passwords": [{"origin": "https://example.com", "username": "u"}],
        "auth_realm": "amazon.com",
        "current_url": "https://www.amazon.com/ap/signin",
        "start_url": "https://www.google.com/",
        "user_settings": {"name": "Resume Shopper", "addressLine1": "1 Main St"},
        "same_session_available": True,
    }

    with (
        patch(
            "domains.spawn_browser_agent_v3.handler.load_config",
            return_value=_fake_config(),
        ),
        patch("domains.spawn_browser_agent_v3.handler.activity.heartbeat"),
        patch(
            "domains.spawn_browser_agent_v3.handler.fetch_session_info",
            AsyncMock(return_value=session_info),
        ),
        patch("domains.spawn_browser_agent_v3.handler.close_browser_session", AsyncMock()),
        patch("domains.spawn_browser_agent_v3.handler.save_browser_action_message", AsyncMock()),
        patch(
            "domains.spawn_browser_agent_v3.handler._propagate_browser_credentials_with_progress",
            AsyncMock(return_value={"outcome": "unknown", "refs": 0, "applied": 0}),
        ),
    ):
        try:
            await spawn_browser_agent_activity_v3(
                user_id="user-1",
                agent_id="agent-1",
                goal="Buy socks",
                tool_call_id="tool-1",
                task_id="task-1",
                is_resume=True,
                output_schema={"fields": [{"name": "result", "type": "string"}]},
                use_claude_mode=False,
            )
        except RuntimeError as exc:
            assert "No CDP URL provided" in str(exc)
        else:
            raise AssertionError("expected missing resumed cdp_url to raise")

async def test_spawn_browser_activity_auth_assistance_resume_reuses_live_session():
    from domains.spawn_browser_agent_v3.handler import spawn_browser_agent_activity_v3

    session_info = {
        "session_id": "session-1",
        "debug_url": "https://steel.example/debug",
        "ws_url": None,
        "fingerprint_injection": {"ua": "test"},
        "passwords": [],
        "same_session_available": True,
    }
    resume_mock = AsyncMock()
    fetch_mock = AsyncMock(return_value=session_info)
    with (
        patch(
            "domains.spawn_browser_agent_v3.handler.load_config",
            return_value=_fake_config(),
        ),
        patch("domains.spawn_browser_agent_v3.handler.activity.heartbeat"),
        patch("domains.spawn_browser_agent_v3.handler.resume_browser_session", resume_mock),
        patch("domains.spawn_browser_agent_v3.handler.fetch_session_info", fetch_mock),
        patch("domains.spawn_browser_agent_v3.handler.close_browser_session", AsyncMock()),
        patch("domains.spawn_browser_agent_v3.handler.save_browser_action_message", AsyncMock()),
        patch(
            "domains.spawn_browser_agent_v3.handler._propagate_browser_credentials_with_progress",
            AsyncMock(return_value={"outcome": "unknown", "refs": 0, "applied": 0}),
        ),
    ):
        try:
            await spawn_browser_agent_activity_v3(
                user_id="user-1",
                agent_id="agent-1",
                goal="Buy socks",
                tool_call_id="tool-1",
                task_id="task-1",
                is_resume=True,
                output_schema={"fields": [{"name": "result", "type": "string"}]},
                use_claude_mode=False,
                write_lock_resume_state={
                    "approval_type": "auth_assistance",
                    "task_id": "task-1",
                    "session_id": "session-1",
                    "cdp_url": "ws://old",
                },
            )
        except RuntimeError as exc:
            assert "No CDP URL provided" in str(exc)
        else:
            raise AssertionError("expected missing resumed cdp_url to raise")

    assert fetch_mock.await_count == 1
    assert fetch_mock.await_args.args[1] == "task-1"
    assert fetch_mock.await_args.kwargs == {"validate_live": True}
    resume_mock.assert_not_awaited()

async def test_spawn_browser_activity_auth_assistance_resume_reuses_backend_refreshed_session():
    """A handoff refresh may replace the provider session while keeping the browser task stable."""
    from domains.spawn_browser_agent_v3.handler import spawn_browser_agent_activity_v3

    session_info = {
        "session_id": "session-refreshed-by-auth-page",
        "debug_url": "https://kernel.example/refreshed",
        "ws_url": "ws://refreshed-by-auth-page",
        "fingerprint_injection": {"ua": "test"},
        "passwords": [],
        "same_session_available": True,
    }
    resume_mock = AsyncMock(
        return_value={
            "session_id": "unexpected-second-session",
            "debug_url": "https://kernel.example/unexpected",
            "ws_url": None,
            "fingerprint_injection": {"ua": "test"},
            "passwords": [],
        }
    )
    fetch_mock = AsyncMock(return_value=session_info)
    connected_cdp_urls = []

    def capture_refreshed_cdp(*, cdp_url):
        connected_cdp_urls.append(cdp_url)
        raise RuntimeError("stop-after-refreshed-cdp-selection")

    with (
        patch(
            "domains.spawn_browser_agent_v3.handler.load_config",
            return_value=_fake_config(),
        ),
        patch("domains.spawn_browser_agent_v3.handler.activity.heartbeat"),
        patch("domains.spawn_browser_agent_v3.handler.resume_browser_session", resume_mock),
        patch("domains.spawn_browser_agent_v3.handler.fetch_session_info", fetch_mock),
        patch("browser_tools.dom_service.DOMService", capture_refreshed_cdp),
        patch("domains.spawn_browser_agent_v3.handler.close_browser_session", AsyncMock()),
        patch("domains.spawn_browser_agent_v3.handler.save_browser_action_message", AsyncMock()),
        patch(
            "domains.spawn_browser_agent_v3.handler._propagate_browser_credentials_with_progress",
            AsyncMock(return_value={"outcome": "unknown", "refs": 0, "applied": 0}),
        ),
    ):
        try:
            await spawn_browser_agent_activity_v3(
                user_id="user-1",
                agent_id="agent-1",
                goal="Buy socks",
                tool_call_id="tool-1",
                task_id="task-1",
                is_resume=True,
                output_schema={"fields": [{"name": "result", "type": "string"}]},
                use_claude_mode=False,
                write_lock_resume_state={
                    "approval_type": "auth_assistance",
                    "task_id": "task-1",
                    # This was the provider session when the worker paused. The
                    # auth page refreshed that expired session before the user
                    # signed in, so the task now owns a different live session.
                    "session_id": "session-before-handoff-refresh",
                    "cdp_url": "ws://old",
                },
            )
        except RuntimeError as exc:
            assert "stop-after-refreshed-cdp-selection" in str(exc)
        else:
            raise AssertionError("expected test CDP interception to stop the activity")

    assert fetch_mock.await_count == 1
    assert fetch_mock.await_args.args[1] == "task-1"
    assert fetch_mock.await_args.kwargs == {"validate_live": True}
    # The refreshed live session is the only provider browser that should be
    # used after handoff. Creating another browser races profile persistence.
    resume_mock.assert_not_awaited()
    assert connected_cdp_urls == ["ws://refreshed-by-auth-page"]
    assert session_info["resume_mode"] == "backend_refreshed_session"

async def test_spawn_browser_activity_auth_assistance_resume_falls_back_when_live_session_expired():
    from domains.spawn_browser_agent_v3.handler import spawn_browser_agent_activity_v3

    existing_session_info = {
        "session_id": "session-1",
        "debug_url": "https://steel.example/debug",
        "ws_url": "ws://old",
        "fingerprint_injection": {"ua": "test"},
        "passwords": [],
        "same_session_available": False,
        "same_session_unavailable_reason": "steel_session_expired",
    }
    replacement_session_info = {
        "session_id": "session-2",
        "debug_url": "https://steel.example/debug2",
        "ws_url": None,
        "fingerprint_injection": {"ua": "test"},
        "passwords": [],
    }
    resume_mock = AsyncMock(return_value=replacement_session_info)
    fetch_mock = AsyncMock(return_value=existing_session_info)

    with (
        patch(
            "domains.spawn_browser_agent_v3.handler.load_config",
            return_value=_fake_config(),
        ),
        patch("domains.spawn_browser_agent_v3.handler.activity.heartbeat"),
        patch("domains.spawn_browser_agent_v3.handler.resume_browser_session", resume_mock),
        patch("domains.spawn_browser_agent_v3.handler.fetch_session_info", fetch_mock),
        patch("domains.spawn_browser_agent_v3.handler.close_browser_session", AsyncMock()),
        patch("domains.spawn_browser_agent_v3.handler.save_browser_action_message", AsyncMock()),
        patch(
            "domains.spawn_browser_agent_v3.handler._propagate_browser_credentials_with_progress",
            AsyncMock(return_value={"outcome": "unknown", "refs": 0, "applied": 0}),
        ),
    ):
        try:
            await spawn_browser_agent_activity_v3(
                user_id="user-1",
                agent_id="agent-1",
                goal="Buy socks",
                tool_call_id="tool-1",
                task_id="task-1",
                is_resume=True,
                output_schema={"fields": [{"name": "result", "type": "string"}]},
                use_claude_mode=False,
                write_lock_resume_state={
                    "approval_type": "auth_assistance",
                    "task_id": "task-1",
                    "session_id": "session-1",
                    "cdp_url": "ws://old",
                },
            )
        except RuntimeError as exc:
            assert "No CDP URL provided" in str(exc)
        else:
            raise AssertionError("expected missing fallback cdp_url to raise")

    assert fetch_mock.await_count == 1
    assert fetch_mock.await_args.args[1] == "task-1"
    assert fetch_mock.await_args.kwargs == {"validate_live": True}
    assert resume_mock.await_count == 1
    assert resume_mock.await_args.args[1] == "task-1"

async def test_spawn_browser_activity_write_approval_resume_falls_back_when_live_session_expired():
    from domains.spawn_browser_agent_v3.handler import spawn_browser_agent_activity_v3

    existing_session_info = {
        "session_id": "session-1",
        "debug_url": "https://steel.example/debug",
        "ws_url": "ws://stale",
        "fingerprint_injection": {"ua": "test"},
        "passwords": [],
        "same_session_available": False,
        "same_session_unavailable_reason": "steel_session_expired",
    }
    replacement_session_info = {
        "session_id": "session-2",
        "debug_url": "https://steel.example/debug2",
        "ws_url": None,
        "fingerprint_injection": {"ua": "test"},
        "passwords": [],
    }
    resume_mock = AsyncMock(return_value=replacement_session_info)
    fetch_mock = AsyncMock(return_value=existing_session_info)

    with (
        patch(
            "domains.spawn_browser_agent_v3.handler.load_config",
            return_value=_fake_config(),
        ),
        patch("domains.spawn_browser_agent_v3.handler.activity.heartbeat"),
        patch("domains.spawn_browser_agent_v3.handler.resume_browser_session", resume_mock),
        patch("domains.spawn_browser_agent_v3.handler.fetch_session_info", fetch_mock),
        patch("domains.spawn_browser_agent_v3.handler.close_browser_session", AsyncMock()),
        patch("domains.spawn_browser_agent_v3.handler.save_browser_action_message", AsyncMock()),
        patch(
            "domains.spawn_browser_agent_v3.handler._propagate_browser_credentials_with_progress",
            AsyncMock(return_value={"outcome": "unknown", "refs": 0, "applied": 0}),
        ),
    ):
        try:
            await spawn_browser_agent_activity_v3(
                user_id="user-1",
                agent_id="agent-1",
                goal="Buy socks",
                tool_call_id="tool-1",
                task_id="task-1",
                is_resume=True,
                output_schema={"fields": [{"name": "result", "type": "string"}]},
                use_claude_mode=False,
                write_lock_resume_state={
                    "approval_type": "purchase",
                    "task_id": "task-1",
                    "session_id": "session-1",
                    "cdp_url": "ws://stale",
                    "pending_action": {"action": "click", "index": 1, "params": {}},
                },
            )
        except RuntimeError as exc:
            assert "No CDP URL provided" in str(exc)
        else:
            raise AssertionError("expected missing fallback cdp_url to raise")

    assert fetch_mock.await_count == 1
    assert fetch_mock.await_args.args[1] == "task-1"
    assert fetch_mock.await_args.kwargs == {"validate_live": True}
    assert resume_mock.await_count == 1
    assert resume_mock.await_args.args[1] == "task-1"

async def test_spawn_browser_activity_write_approval_resume_falls_back_when_liveness_missing():
    from domains.spawn_browser_agent_v3.handler import spawn_browser_agent_activity_v3

    existing_session_info = {
        "session_id": "session-1",
        "debug_url": "https://steel.example/debug",
        "ws_url": "ws://possibly-stale",
        "fingerprint_injection": {"ua": "test"},
        "passwords": [],
    }
    replacement_session_info = {
        "session_id": "session-2",
        "debug_url": "https://steel.example/debug2",
        "ws_url": None,
        "fingerprint_injection": {"ua": "test"},
        "passwords": [],
    }
    resume_mock = AsyncMock(return_value=replacement_session_info)
    fetch_mock = AsyncMock(return_value=existing_session_info)

    with (
        patch(
            "domains.spawn_browser_agent_v3.handler.load_config",
            return_value=_fake_config(),
        ),
        patch("domains.spawn_browser_agent_v3.handler.activity.heartbeat"),
        patch("domains.spawn_browser_agent_v3.handler.resume_browser_session", resume_mock),
        patch("domains.spawn_browser_agent_v3.handler.fetch_session_info", fetch_mock),
        patch("domains.spawn_browser_agent_v3.handler.close_browser_session", AsyncMock()),
        patch("domains.spawn_browser_agent_v3.handler.save_browser_action_message", AsyncMock()),
        patch(
            "domains.spawn_browser_agent_v3.handler._propagate_browser_credentials_with_progress",
            AsyncMock(return_value={"outcome": "unknown", "refs": 0, "applied": 0}),
        ),
    ):
        try:
            await spawn_browser_agent_activity_v3(
                user_id="user-1",
                agent_id="agent-1",
                goal="Buy socks",
                tool_call_id="tool-1",
                task_id="task-1",
                is_resume=True,
                output_schema={"fields": [{"name": "result", "type": "string"}]},
                use_claude_mode=False,
                write_lock_resume_state={
                    "approval_type": "purchase",
                    "task_id": "task-1",
                    "session_id": "session-1",
                    "cdp_url": "ws://possibly-stale",
                    "pending_action": {"action": "click", "index": 1, "params": {}},
                },
            )
        except RuntimeError as exc:
            assert "No CDP URL provided" in str(exc)
        else:
            raise AssertionError("expected missing fallback cdp_url to raise")

    assert fetch_mock.await_args.kwargs == {"validate_live": True}
    assert resume_mock.await_count == 1
    assert resume_mock.await_args.args[1] == "task-1"

async def test_browser_supervisor_recovery_clicks_generic_dismiss_button():
    from domains.spawn_browser_agent_v3.handler import _perform_generic_browser_recovery

    class _FakeButton:
        def __init__(self, text):
            self.text = text
            self.clicked = False

        async def evaluate(self, _script):
            return self.text

        async def is_visible(self):
            return True

        async def click(self, **_kwargs):
            self.clicked = True

    class _FakeLocator:
        def __init__(self, buttons):
            self.buttons = buttons

        async def all(self):
            return self.buttons

    buttons = [_FakeButton("Keep browsing"), _FakeButton("Close banner")]
    page = SimpleNamespace(
        url="https://example.com/menu",
        bring_to_front=AsyncMock(),
        keyboard=SimpleNamespace(press=AsyncMock()),
        locator=lambda _selector: _FakeLocator(buttons),
        reload=AsyncMock(),
    )

    actions = await _perform_generic_browser_recovery(
        input_page=page,
        reason="test",
        reload_page=False,
    )

    assert "bring_to_front" in actions
    assert "press_escape" in actions
    assert "click_dismiss:Close banner" in actions
    assert buttons[0].clicked is False
    assert buttons[1].clicked is True
    page.reload.assert_not_awaited()

async def test_browser_supervisor_recovery_uses_fallback_url_when_page_url_missing():
    from domains.spawn_browser_agent_v3.handler import _perform_generic_browser_recovery

    class _FakeLocator:
        async def all(self):
            return []

    page = SimpleNamespace(
        url="",
        bring_to_front=AsyncMock(),
        keyboard=SimpleNamespace(press=AsyncMock()),
        locator=lambda _selector: _FakeLocator(),
        reload=AsyncMock(),
        goto=AsyncMock(),
    )

    actions = await _perform_generic_browser_recovery(
        input_page=page,
        reason="browser_state_timeout_330s",
        reload_page=True,
        fallback_url="https://order.example.com/menu",
    )

    assert "goto_fallback_url" in actions
    page.reload.assert_not_awaited()
    page.goto.assert_awaited_once()
    assert page.goto.await_args.args == ("https://order.example.com/menu",)

async def test_goto_action_returns_current_url_for_recovery_fallback():
    from domains.spawn_browser_agent_v3.service_actions import _execute_goto

    class _FakeEvent:
        def __await__(self):
            async def _done():
                return None

            return _done().__await__()

        async def event_result(self, **_kwargs):
            return None

    session = SimpleNamespace(
        event_bus=SimpleNamespace(dispatch=MagicMock(return_value=_FakeEvent())),
    )
    action_history = SimpleNamespace(record_action=AsyncMock())

    result = await _execute_goto(
        session=session,
        dom_service=SimpleNamespace(),
        action_history=action_history,
        params={"url": "order.example.com/menu"},
        thinking="go to menu",
        session_id=None,
        config=None,
    )

    assert result["success"] is True
    assert result["current_url"] == "https://order.example.com/menu"
    action_history.record_action.assert_awaited_once()
    recorded_result = action_history.record_action.await_args.kwargs["result"]
    assert recorded_result["current_url"] == "https://order.example.com/menu"

async def test_browser_supervisor_snapshot_reads_lightweight_page_state():
    from domains.spawn_browser_agent_v3.handler import (
        _browser_supervisor_snapshot,
        _format_browser_supervisor_message,
    )

    tab = SimpleNamespace(url="https://example.com/other", title=AsyncMock(return_value="Other"))
    page = SimpleNamespace(
        context=SimpleNamespace(pages=[tab]),
        evaluate=AsyncMock(
            return_value={
                "url": "https://example.com/menu",
                "title": "Menu",
                "body_text": "Only accepting scheduled orders",
                "buttons": [{"text": "Opt out of all", "visible": True}],
                "inputs": [{"type": "email", "placeholder": "Email"}],
            }
        ),
    )

    snapshot = await _browser_supervisor_snapshot(input_page=page, dom_service=None)
    assert snapshot["url"] == "https://example.com/menu"
    assert snapshot["title"] == "Menu"
    assert snapshot["buttons"][0]["text"] == "Opt out of all"
    assert snapshot["tabs"][0]["title"] == "Other"

    message = _format_browser_supervisor_message(
        {"reason": "browser_state_timeout_90s", "actions": ["press_escape"], "snapshot": snapshot}
    )
    assert "browser_state_timeout_90s" in message
    assert "Opt out of all" in message
    assert "Only accepting scheduled orders" in message

async def test_spawn_browser_activity_failed_steel_auth_recovers_same_run():
    from domains.spawn_browser_agent_v3.handler import spawn_browser_agent_activity_v3

    class _FakeDomSession:
        async def get_current_page(self):
            return SimpleNamespace()

    class _FakeDomService:
        last_instance = None

        def __init__(self, cdp_url):
            self.cdp_url = cdp_url
            self.session = _FakeDomSession()
            self._session = SimpleNamespace(get_or_create_cdp_session=AsyncMock(side_effect=RuntimeError("skip logo")))
            self.selector_map = {}
            self.disconnect = AsyncMock()
            _FakeDomService.last_instance = self

        async def connect(self):
            return None

        async def get_browser_state(self, include_screenshot=False):
            return {"url": "https://example.com/login", "screenshot": None}

    class _FakeHumanizer:
        last_instance = None

        def __init__(self, *args, **kwargs):
            self.cursor_observer = None
            self.idle_started = False
            _FakeHumanizer.last_instance = self

        def set_cursor_observer(self, observer):
            self.cursor_observer = observer

        async def initialize_cursor(self, *args, **kwargs):
            return None

        def start_idle_movement(self):
            self.idle_started = True
            return None

        async def close(self):
            return None

    class _FakePlaywright:
        def __init__(self, browser):
            self.chromium = SimpleNamespace(connect_over_cdp=AsyncMock(return_value=browser))
            self.stop = AsyncMock()

    class _FakeAsyncPlaywright:
        def __init__(self, instance):
            self._instance = instance

        async def start(self):
            return self._instance

    fake_browser = SimpleNamespace(
        contexts=[SimpleNamespace(pages=[SimpleNamespace()])],
        close=AsyncMock(),
    )
    fake_playwright = _FakePlaywright(fake_browser)
    session_info = {
        "session_id": "session-1",
        "debug_url": "https://steel.example/debug",
        "ws_url": "ws://old",
        "fingerprint_injection": None,
        "passwords": [],
        "auth_options": {"realm": "example.com"},
        "browser_session_metadata": {"provider": "steel", "profile_id": "profile-1"},
        "credential_ref": {"kind": "steel_session", "id": "steel-auth-1"},
        "same_session_available": True,
    }
    close_mock = AsyncMock()
    create_auth_mock = AsyncMock()
    restart_mock = AsyncMock(
        return_value={
            "session_id": "session-cookie",
            "debug_url": "https://steel.example/debug-cookie",
            "ws_url": "ws://cookie",
            "auth_realm": "example.com",
            "auth_source": "cookie_bundle",
            "cookies_count": 4,
            "auth_credential_ref": {"kind": "cookie_bundle", "id": "bundle-1"},
            "browser_session_metadata": {"provider": "steel", "profile_id": "profile-cookie"},
        }
    )
    replacement_dom = _FakeDomService("ws://cookie")
    replacement_page = SimpleNamespace()
    replacement_browser = SimpleNamespace(
        contexts=[SimpleNamespace(pages=[replacement_page])],
        close=AsyncMock(),
    )
    replacement_playwright = _FakePlaywright(replacement_browser)
    reconnect_mock = AsyncMock(
        return_value={
            "dom_service": replacement_dom,
            "dom_page": replacement_page,
            "input_page": replacement_page,
            "playwright_browser": replacement_browser,
            "playwright_instance": replacement_playwright,
            "playwright_driver_pid": None,
        }
    )
    auth_boundary_calls = []

    async def restart(*args, **kwargs):
        auth_boundary_calls.append("restart")
        return await restart_mock(*args, **kwargs)

    async def create_auth(*args, **kwargs):
        auth_boundary_calls.append("create_assistance")
        return await create_auth_mock(*args, **kwargs)

    with (
        patch(
            "domains.spawn_browser_agent_v3.handler.load_config",
            return_value=_fake_config(),
        ),
        patch("domains.spawn_browser_agent_v3.handler.activity.heartbeat"),
        patch(
            "domains.spawn_browser_agent_v3.handler.fetch_session_info",
            AsyncMock(return_value=session_info),
        ),
        patch(
            "domains.spawn_browser_agent_v3.handler.fetch_recent_otps",
            AsyncMock(return_value=[]),
        ),
        patch(
            "domains.spawn_browser_agent_v3.handler.get_model_pricing_with_fallback",
            AsyncMock(return_value={"input_cents_per_1k": 0, "output_cents_per_1k": 0}),
        ),
        patch(
            "domains.spawn_browser_agent_v3.handler._call_browser_use_with_rotation",
            AsyncMock(
                side_effect=[
                    {
                        "action": {
                            "action": "request_user_assistance_for_authentication",
                            "thinking": "",
                            "params": {},
                        },
                        "usage": {},
                        "mode": "waterfall",
                    },
                    {
                        "action": {
                            "action": "attempt_completion",
                            "thinking": "The signed-in page confirms completion.",
                            "params": {"reasoning": "confirmed"},
                        },
                        "usage": {},
                        "mode": "waterfall",
                    },
                ]
            ),
        ),
        patch(
            "domains.spawn_browser_agent_v3.handler.create_user_auth_assistance_request",
            create_auth,
        ),
        patch(
            "domains.spawn_browser_agent_v3.handler._restart_after_failed_steel_auth",
            restart,
        ),
        patch(
            "domains.spawn_browser_agent_v3.handler._reconnect_browser_stack_after_rotation",
            reconnect_mock,
        ),
        patch(
            "domains.spawn_browser_agent_v3.handler.build_browser_verifier_context",
            AsyncMock(return_value=[]),
        ),
        patch(
            "domains.spawn_browser_agent_v3.handler.call_temporal_activity_from_activity",
            AsyncMock(
                return_value={
                    "score": 1.0,
                    "reasoning": "completed",
                    "structured_response": {"result": "ride requested"},
                    "usage": {},
                }
            ),
        ),
        patch("domains.spawn_browser_agent_v3.handler.extract_session_files", AsyncMock(return_value=[])),
        patch(
            "domains.spawn_browser_agent_v3.handler.disconnect_browser_after_passkey_capture",
            AsyncMock(),
        ),
        patch(
            "domains.spawn_browser_agent_v3.handler.propagate_browser_run_credentials",
            AsyncMock(return_value={"outcome": "unknown", "refs": 0, "applied": 0}),
        ),
        patch("domains.spawn_browser_agent_v3.handler.close_browser_session", close_mock),
        patch(
            "domains.spawn_browser_agent_v3.handler.save_browser_action_message",
            AsyncMock(),
        ),
        patch(
            "domains.spawn_browser_agent_v3.handler.save_browser_assistant_message",
            AsyncMock(),
        ),
        patch("browser_tools.dom_service.DOMService", _FakeDomService),
        patch("browser_tools.humanizer.BrowserHumanizer", _FakeHumanizer),
        patch(
            "playwright.async_api.async_playwright",
            return_value=_FakeAsyncPlaywright(fake_playwright),
        ),
    ):
        result = await spawn_browser_agent_activity_v3(
            user_id="user-1",
            agent_id="agent-1",
            goal="Buy socks",
            tool_call_id="tool-1",
            task_id="task-1",
            is_resume=True,
            output_schema={"fields": [{"name": "result", "type": "string"}]},
            use_claude_mode=False,
            write_lock_resume_state={
                "approval_type": "manual_pause",
                "task_id": "task-1",
            },
        )

    assert result["status"] == "completed"
    assert result["session_id"] == "session-cookie"
    assert result["structured_response"] == {"result": "ride requested"}
    close_mock.assert_awaited_once_with(_fake_config(), "session-cookie", pause=False)
    create_auth_mock.assert_not_awaited()
    restart_mock.assert_awaited_once_with(
        config=_fake_config(),
        user_id="user-1",
        task_id="task-1",
        credential_ref={"kind": "steel_session", "id": "steel-auth-1"},
    )
    assert auth_boundary_calls == ["restart"]
    reconnect_mock.assert_awaited_once()
    assert reconnect_mock.await_args.kwargs["new_cdp_url"] == "ws://cookie"
    assert _FakeHumanizer.last_instance is not None
    assert callable(_FakeHumanizer.last_instance.cursor_observer)
    assert _FakeHumanizer.last_instance.idle_started is True

async def test_failed_steel_auth_restart_invalidates_before_credential_isolated_resume():
    from domains.spawn_browser_agent_v3.handler import _restart_after_failed_steel_auth

    calls = []
    mark_failed_mock = AsyncMock(return_value={"ok": True})
    resume_mock = AsyncMock(
        return_value={
            "session_id": "session-cookie",
            "ws_url": "ws://cookie",
            "auth_source": "cookie_bundle",
            "auth_credential_ref": {"kind": "cookie_bundle", "id": "bundle-1"},
        }
    )

    async def mark_failed(*args, **kwargs):
        calls.append("mark_failed")
        return await mark_failed_mock(*args, **kwargs)

    async def resume(*args, **kwargs):
        calls.append("resume")
        return await resume_mock(*args, **kwargs)

    with (
        patch("domains.spawn_browser_agent_v3.handler.mark_steel_session_auth_failed", mark_failed),
        patch("domains.spawn_browser_agent_v3.handler.resume_browser_session", resume),
    ):
        replacement = await _restart_after_failed_steel_auth(
            config=_fake_config(),
            user_id="user-1",
            task_id="task-1",
            credential_ref={"kind": "steel_session", "id": "steel-auth-1"},
        )

    assert calls == ["mark_failed", "resume"]
    mark_failed_mock.assert_awaited_once_with(
        _fake_config(),
        "user-1",
        "steel-auth-1",
        "All automated authentication options were exhausted and the site remained signed out.",
        preserve_browser_session_id="task-1",
    )
    resume_mock.assert_awaited_once_with(_fake_config(), "task-1", force_fresh_profile=True)
    assert replacement["auth_source"] == "cookie_bundle"
    assert replacement["auth_credential_ref"] == {"kind": "cookie_bundle", "id": "bundle-1"}

    with (
        patch(
            "domains.spawn_browser_agent_v3.handler.mark_steel_session_auth_failed",
            AsyncMock(return_value={"ok": True}),
        ),
        patch(
            "domains.spawn_browser_agent_v3.handler.resume_browser_session",
            AsyncMock(
                return_value={
                    "session_id": "session-stale",
                    "ws_url": "ws://stale",
                    "auth_credential_ref": {"kind": "steel_session", "id": "steel-auth-1"},
                }
            ),
        ),
    ):
        try:
            await _restart_after_failed_steel_auth(
                config=_fake_config(),
                user_id="user-1",
                task_id="task-1",
                credential_ref={"kind": "steel_session", "id": "steel-auth-1"},
            )
        except RuntimeError as exc:
            assert "reused the Steel credential proven signed out" in str(exc)
        else:
            raise AssertionError("expected stale Steel credential reuse to fail closed")

def test_realm_transition_refreshes_active_session_credential_ref():
    import inspect

    from domains.spawn_browser_agent_v3 import handler

    source = inspect.getsource(handler._spawn_browser_agent_activity_v3_real)
    helper_start = source.index("async def _prepare_credentials_for_url_unquarantined")
    helper_end = source.index("async def _prepare_credentials_for_url(", helper_start)
    helper_source = source[helper_start:helper_end]

    assert "nonlocal session_credential_ref" in helper_source
    assert "session_credential_ref = realm_state.auth_credential_ref" in helper_source

async def test_manager_cancelled_browser_pause_event_includes_task_metadata():
    from domains.spawn_browser_agent_v3.handler import SpawnBrowserAgentManagerV3
    from tools.base import EventType, MessageStatus

    class _FakeActivityHandle:
        def done(self):
            return True

        def cancel(self):
            raise AssertionError("done activity should not be cancelled")

        def __await__(self):
            async def _result():
                return {
                    "status": "cancelled",
                    "task_id": "task-1",
                    "browser_url": "https://steel.example/debug",
                    "session_id": "session-1",
                }

            return _result().__await__()

    workflow_instance = SimpleNamespace(
        user_id="user-1",
        agent_id="agent-1",
        is_paused=False,
        write_lock_enabled=True,
        system_name="Rose",
    )
    manager = SpawnBrowserAgentManagerV3()

    with (
        patch(
            "domains.spawn_browser_agent_v3.handler.workflow.start_activity",
            return_value=_FakeActivityHandle(),
        ),
        patch(
            "domains.spawn_browser_agent_v3.handler.workflow.wait_condition",
            AsyncMock(return_value=None),
        ),
    ):
        events = []
        async for event in manager.execute_tool(workflow_instance, {"goal": "Buy socks"}, "tool-1"):
            events.append(event)

    pause_event = events[-1]
    assert pause_event.type == EventType.POST_MESSAGE
    assert pause_event.status == MessageStatus.ERROR
    assert pause_event.metadata == {
        "toolName": "spawn_browser_agent",
        "action_type": "session_paused",
        "task_id": "task-1",
        "browser_url": "https://steel.example/debug",
        "session_id": "session-1",
    }

async def test_manager_disables_fast_mode_cache_for_browser_activity():
    from domains.spawn_browser_agent_v3.handler import SpawnBrowserAgentManagerV3

    class _FakeActivityHandle:
        def done(self):
            return True

        def cancel(self):
            raise AssertionError("done activity should not be cancelled")

        def __await__(self):
            async def _result():
                return {"success": True, "message": "done"}

            return _result().__await__()

    workflow_instance = SimpleNamespace(
        user_id="user-1",
        agent_id="agent-1",
        is_paused=False,
        write_lock_enabled=True,
        system_name="Rose",
        fast_mode_cache_enabled=True,
    )
    manager = SpawnBrowserAgentManagerV3()
    start_calls = []

    def fake_start_activity(*args, **kwargs):
        start_calls.append((args, kwargs))
        return _FakeActivityHandle()

    with (
        patch(
            "domains.spawn_browser_agent_v3.handler.workflow.start_activity",
            side_effect=fake_start_activity,
        ),
        patch(
            "domains.spawn_browser_agent_v3.handler.workflow.wait_condition",
            AsyncMock(return_value=None),
        ),
    ):
        events = []
        async for event in manager.execute_tool(workflow_instance, {"goal": "Buy socks"}, "tool-1"):
            events.append(event)

    assert events[-1].status.name == "FINISHED"
    activity_args = start_calls[0][1]["args"]
    assert activity_args[-1] is False

async def test_manager_posts_output_files_after_finished_tool_event():
    from domains.spawn_browser_agent_v3.handler import SpawnBrowserAgentManagerV3
    from tools.base import AssistantEvent, MessageStatus

    class _FakeActivityHandle:
        def done(self):
            return True

        def cancel(self):
            raise AssertionError("done activity should not be cancelled")

        def __await__(self):
            async def _result():
                return {
                    "success": True,
                    "message": "done",
                    "output_files": [{"id": "fp-browser"}],
                }

            return _result().__await__()

    workflow_instance = SimpleNamespace(
        user_id="user-1",
        agent_id="agent-1",
        is_paused=False,
        write_lock_enabled=True,
        system_name="Rose",
    )
    manager = SpawnBrowserAgentManagerV3()

    output_schema = {"fields": [{"name": "result", "type": "str"}]}

    with (
        patch(
            "domains.spawn_browser_agent_v3.handler.workflow.start_activity",
            return_value=_FakeActivityHandle(),
        ),
        patch(
            "domains.spawn_browser_agent_v3.handler.workflow.wait_condition",
            AsyncMock(return_value=None),
        ),
    ):
        events = []
        async for event in manager.execute_tool(
            workflow_instance,
            {"goal": "Buy socks", "output_schema": output_schema},
            "tool-1",
        ):
            events.append(event)

    finished_index = next(i for i, e in enumerate(events) if getattr(e, "status", None) == MessageStatus.FINISHED)
    assistant_index = next(i for i, e in enumerate(events) if isinstance(e, AssistantEvent))
    assert finished_index < assistant_index
    assert events[finished_index].metadata["output_schema"] == output_schema

async def test_manager_finished_tool_event_includes_structured_response_values():
    from domains.spawn_browser_agent_v3.handler import SpawnBrowserAgentManagerV3
    from tools.base import MessageStatus

    class _FakeActivityHandle:
        def done(self):
            return True

        def cancel(self):
            raise AssertionError("done activity should not be cancelled")

        def __await__(self):
            async def _result():
                return {
                    "success": True,
                    "message": "done",
                    "structured_response": {
                        "selected_black_beanie_url": "https://amazon.com/item",
                        "added_to_cart": True,
                    },
                }

            return _result().__await__()

    workflow_instance = SimpleNamespace(
        user_id="user-1",
        agent_id="agent-1",
        is_paused=False,
        write_lock_enabled=True,
        system_name="Rose",
    )
    manager = SpawnBrowserAgentManagerV3()

    output_schema = {
        "fields": [
            {"name": "selected_black_beanie_url", "type": "str"},
            {"name": "added_to_cart", "type": "bool"},
        ]
    }

    with (
        patch(
            "domains.spawn_browser_agent_v3.handler.workflow.start_activity",
            return_value=_FakeActivityHandle(),
        ),
        patch(
            "domains.spawn_browser_agent_v3.handler.workflow.wait_condition",
            AsyncMock(return_value=None),
        ),
    ):
        events = []
        async for event in manager.execute_tool(
            workflow_instance,
            {"goal": "Buy socks", "output_schema": output_schema},
            "tool-1",
        ):
            events.append(event)

    finished_event = next(e for e in events if getattr(e, "status", None) == MessageStatus.FINISHED)
    assert finished_event.metadata["structured_response"] == {
        "selected_black_beanie_url": "https://amazon.com/item",
        "added_to_cart": True,
    }

async def test_manager_failed_tool_event_includes_structured_response_values():
    from domains.spawn_browser_agent_v3.handler import SpawnBrowserAgentManagerV3
    from tools.base import MessageStatus

    class _FakeActivityHandle:
        def done(self):
            return True

        def cancel(self):
            raise AssertionError("done activity should not be cancelled")

        def __await__(self):
            async def _result():
                return {
                    "success": False,
                    "status": "max_iterations",
                    "message": "best effort only",
                    "structured_response": {
                        "selected_black_beanie_url": "https://amazon.com/item",
                        "added_to_cart": False,
                    },
                }

            return _result().__await__()

    workflow_instance = SimpleNamespace(
        user_id="user-1",
        agent_id="agent-1",
        is_paused=False,
        write_lock_enabled=True,
        system_name="Rose",
    )
    manager = SpawnBrowserAgentManagerV3()

    output_schema = {
        "fields": [
            {"name": "selected_black_beanie_url", "type": "str"},
            {"name": "added_to_cart", "type": "bool"},
        ]
    }

    with (
        patch(
            "domains.spawn_browser_agent_v3.handler.workflow.start_activity",
            return_value=_FakeActivityHandle(),
        ),
        patch(
            "domains.spawn_browser_agent_v3.handler.workflow.wait_condition",
            AsyncMock(return_value=None),
        ),
    ):
        events = []
        async for event in manager.execute_tool(
            workflow_instance,
            {"goal": "Buy socks", "output_schema": output_schema},
            "tool-1",
        ):
            events.append(event)

    failed_event = next(e for e in events if getattr(e, "status", None) == MessageStatus.ERROR)
    assert failed_event.message == "best effort only"
    assert failed_event.metadata["structured_response"] == {
        "selected_black_beanie_url": "https://amazon.com/item",
        "added_to_cart": False,
    }

async def test_manager_auth_assistance_pauses_and_resumes():
    from domains.spawn_browser_agent_v3.handler import SpawnBrowserAgentManagerV3
    from tools.base import MessageStatus

    class _FakeActivityHandle:
        def __init__(self, result):
            self._result = result

        def done(self):
            return True

        def cancel(self):
            raise AssertionError("done activity should not be cancelled")

        def __await__(self):
            async def _result():
                return self._result

            return _result().__await__()

    workflow_instance = SimpleNamespace(
        user_id="user-1",
        agent_id="agent-1",
        is_paused=False,
        write_lock_enabled=True,
        system_name="Rose",
        _signal_responses={},
        _update_tree_state=AsyncMock(),
    )

    first = _FakeActivityHandle(
        {
            "status": "awaiting_auth_assistance",
            "request_id": "uar1",
            "auth_realm": "example.com",
            "base_site": "example.com",
            "auth_assistance_request": {"handoff": {"liveViewUrl": "https://steel/live"}},
            "task_id": "task-1",
            "session_id": "session-1",
            "browser_url": "https://steel/debug",
            "cdp_url": "ws://old",
            "step_count": 3,
        }
    )
    second = _FakeActivityHandle({"success": True, "message": "done", "output_files": []})
    start_calls = []

    async def fake_wait_condition(*_args, **_kwargs):
        if workflow_instance.is_paused:
            workflow_instance.is_paused = False

    def fake_start_activity(*args, **kwargs):
        start_calls.append((args, kwargs))
        return [first, second][len(start_calls) - 1]

    manager = SpawnBrowserAgentManagerV3()
    with (
        patch(
            "domains.spawn_browser_agent_v3.handler.workflow.start_activity",
            side_effect=fake_start_activity,
        ),
        patch(
            "domains.spawn_browser_agent_v3.handler.workflow.wait_condition",
            fake_wait_condition,
        ),
    ):
        events = []
        async for event in manager.execute_tool(workflow_instance, {"goal": "Buy socks"}, "tool-1"):
            events.append(event)

    titles = [getattr(event, "title", "") for event in events]
    assert titles.count("Starting up a browser") == 1
    assert "Requesting User Assistance for example.com Login" in titles
    assert "User Assistance Received" in titles
    assert events[-1].status == MessageStatus.FINISHED
    assert workflow_instance.is_paused is False
    assert len(start_calls) == 2
    assert {call[1]["args"][3] for call in start_calls} == {"tool-1"}
    first_auth_event = next(
        event for event in events if getattr(event, "title", "") == "Requesting User Assistance for example.com Login"
    )
    first_auth_metadata = first_auth_event.metadata["requestUserAuthentication"]
    assert first_auth_metadata["steelSessionId"] == "session-1"
    assert first_auth_metadata["liveViewUrl"] == "https://steel/live"
    second_args = start_calls[1][1]["args"]
    assert second_args[4] == "task-1"
    assert second_args[5] == "session-1"
    assert second_args[6] == "ws://old"
    assert second_args[12]["approval_type"] == "auth_assistance"
    assert second_args[12]["session_id"] == "session-1"
    assert second_args[12]["cdp_url"] == "ws://old"

async def test_manager_write_approval_after_hour_wait_resumes_and_finishes():
    from domains.spawn_browser_agent_v3.handler import SpawnBrowserAgentManagerV3
    from domains.spawn_browser_agent_v3.service_actions import get_domain_from_url
    from tools.base import MessageStatus

    class _FakeActivityHandle:
        def __init__(self, result):
            self._result = result

        def done(self):
            return True

        def cancel(self):
            raise AssertionError("done activity should not be cancelled")

        def __await__(self):
            async def _result():
                return self._result

            return _result().__await__()

    current_time = datetime(2026, 7, 9, 21, 58, 7, tzinfo=timezone.utc)
    approval_time = current_time + timedelta(seconds=3601)
    approval_calls = []
    start_calls = []

    purchase_notification = {
        "trigger_type": "purchase",
        "service": {"name": "Blick Art Materials", "domain": "dickblick.com"},
        "purchase": {
            "items": [{"title": "R&F Drawing Oil Stick", "price": "$12.00"}],
            "totals": {"total": "$12.00"},
            "payment_method": "Visa ending in 4242",
        },
    }
    first = _FakeActivityHandle(
        {
            "status": "awaiting_write_approval",
            "approval_type": "purchase",
            "question": "Approve checkout?",
            "current_url": "https://www.dickblick.com/cart/",
            "pending_action": {
                "action": "click",
                "index": 42,
                "params": {},
                "thinking": "Click Checkout Now",
            },
            "pending_action_target": {
                "tag": "input",
                "text": "Checkout Now",
                "attrs": {"name": "placeOrder"},
            },
            "write_lock_notification": purchase_notification,
            "write_lock_approvals": {},
            "action_history": [
                {
                    "step": 1,
                    "action": "click",
                    "element_description": "[9] a '1 Cart'",
                    "result": {"success": True},
                }
            ],
            "visited_urls": ["https://www.dickblick.com/cart/"],
            "verifier_checkpoints": [
                {
                    "url": "https://www.dickblick.com/cart/",
                    "title": "Review order",
                    "dom_tree": "<main>R&F Drawing Oil Stick; Total $12.00</main>",
                }
            ],
            "step_count": 5,
            "session_id": "session-1",
            "cdp_url": "wss://connect.steel.dev/session-1",
            "task_id": "task-1",
            "auth_realm": "dickblick.com",
        }
    )
    second = _FakeActivityHandle(
        {
            "success": True,
            "message": "Purchase completed.",
            "structured_response": {"purchase_complete": True},
            "output_files": [],
        }
    )

    workflow_instance = SimpleNamespace(
        user_id="user-1",
        agent_id="agent-1",
        is_paused=False,
        write_lock_enabled=True,
        system_name="Rose",
    )

    async def fake_request_user_approval_direct(*_args, **kwargs):
        nonlocal current_time
        approval_calls.append(kwargs)
        current_time = approval_time
        return {"attention_request_id": "approval-1"}

    def fake_now():
        return current_time

    def fake_start_activity(*args, **kwargs):
        start_calls.append((args, kwargs))
        return [first, second][len(start_calls) - 1]

    manager = SpawnBrowserAgentManagerV3()
    with (
        patch(
            "domains.spawn_browser_agent_v3.handler.workflow.start_activity",
            side_effect=fake_start_activity,
        ),
        patch(
            "domains.spawn_browser_agent_v3.handler.workflow.wait_condition",
            AsyncMock(return_value=None),
        ),
        patch("domains.spawn_browser_agent_v3.handler.workflow.now", side_effect=fake_now),
        patch(
            "tools.request_user_approval.request_user_approval_direct",
            side_effect=fake_request_user_approval_direct,
        ),
    ):
        events = []
        async for event in manager.execute_tool(
            workflow_instance,
            {
                "goal": "Buy one R&F Drawing Oil Stick",
                "output_schema": {"fields": [{"name": "purchase_complete", "type": "bool"}]},
            },
            "tool-1",
        ):
            events.append(event)

    assert len(approval_calls) == 1
    assert approval_calls[0]["question"] == "Approve checkout?"
    assert approval_calls[0]["metadata"]["url"] == "https://www.dickblick.com/cart/"
    assert len(start_calls) == 2
    # Write-lock approval alone is not GMV — paid-order capture requires
    # structured_response with amount + confirmation id (backend path).

    resumed_args = start_calls[1][1]["args"]
    assert resumed_args[4] == "task-1"
    assert resumed_args[5] == "session-1"
    assert resumed_args[6] == "wss://connect.steel.dev/session-1"
    assert resumed_args[7] is True
    resume_state = resumed_args[12]
    assert resume_state["pending_action"]["action"] == "click"
    assert resume_state["pending_action_target"]["attrs"]["name"] == "placeOrder"
    assert resume_state["action_history"][0]["element_description"] == "[9] a '1 Cart'"
    assert resume_state["visited_urls"] == ["https://www.dickblick.com/cart/"]
    assert "R&F Drawing Oil Stick" in resume_state["verifier_checkpoints"][0]["dom_tree"]
    assert resume_state["approval_type"] == "purchase"
    assert resume_state["auth_realm"] == "dickblick.com"
    assert resume_state["step_count"] == 5
    assert resume_state["write_lock_approvals"]["purchase"] == {
        "domain": get_domain_from_url("https://www.dickblick.com/cart/"),
        "approved_at": approval_time.timestamp(),
    }

    final_event = events[-1]
    assert final_event.status == MessageStatus.FINISHED
    assert final_event.message == "Purchase completed."
    assert final_event.metadata["structured_response"] == {"purchase_complete": True}

async def test_manager_payment_card_approval_uses_registered_activity_names_and_resumes():
    from domains.spawn_browser_agent_v3.handler import SpawnBrowserAgentManagerV3
    from domains.spawn_browser_agent_v3.service_actions import get_domain_from_url
    from tools.base import MessageStatus

    class _FakeActivityHandle:
        def __init__(self, result):
            self._result = result

        def done(self):
            return True

        def cancel(self):
            raise AssertionError("done activity should not be cancelled")

        def __await__(self):
            async def _result():
                return self._result

            return _result().__await__()

    current_time = datetime(2026, 7, 9, 23, 50, 0, tzinfo=timezone.utc)
    approval_calls = []
    start_calls = []
    execute_activity_calls = []

    first = _FakeActivityHandle(
        {
            "status": "awaiting_payment_card_approval",
            "payment_request": {
                "merchant": "Blick Art Materials",
                "line_items": [
                    {
                        "name": "Brush",
                        "product_url": "https://www.dickblick.com/products/brush/",
                        "rating": "4.7 stars",
                        "review_count": "84 reviews",
                        "quantity": 1,
                        "line_total_cents": 636,
                    }
                ],
                "subtotal_cents": 636,
                "total_cents": 636,
            },
            "current_url": "https://www.dickblick.com/checkout/",
            "write_lock_approvals": {},
            "step_count": 12,
            "session_id": "session-1",
            "cdp_url": "wss://connect.steel.dev/session-1",
            "task_id": "task-1",
            "auth_realm": "dickblick.com",
        }
    )
    second = _FakeActivityHandle(
        {
            "success": True,
            "message": "Purchase completed.",
            "structured_response": {"purchase_complete": True},
            "output_files": [],
        }
    )

    workflow_instance = SimpleNamespace(
        user_id="user-1",
        agent_id="agent-1",
        is_paused=False,
        write_lock_enabled=True,
        system_name="Rose",
    )

    async def fake_execute_activity(activity_name, *args, **kwargs):
        execute_activity_calls.append((activity_name, args, kwargs))
        if activity_name == "lookup_purchase_activity":
            return {"found": False, "reusable": False, "purchase": None}
        if activity_name == "mint_purchase_card_activity":
            return {
                "cardId": "card-1",
                "pan": "4242424242424242",
                "expiry": "12/30",
                "cvv": "123",
                "last4": "4242",
            }
        raise AssertionError(f"unexpected activity: {activity_name}")

    async def fake_request_user_approval_direct(*_args, **kwargs):
        approval_calls.append(kwargs)
        return {"attention_request_id": "approval-1"}

    def fake_start_activity(*args, **kwargs):
        start_calls.append((args, kwargs))
        return [first, second][len(start_calls) - 1]

    manager = SpawnBrowserAgentManagerV3()
    with (
        patch(
            "domains.spawn_browser_agent_v3.handler.workflow.start_activity",
            side_effect=fake_start_activity,
        ),
        patch(
            "domains.spawn_browser_agent_v3.handler.workflow.wait_condition",
            AsyncMock(return_value=None),
        ),
        patch(
            "domains.spawn_browser_agent_v3.handler.workflow.execute_activity",
            side_effect=fake_execute_activity,
        ),
        patch("domains.spawn_browser_agent_v3.handler.workflow.now", return_value=current_time),
        patch(
            "tools.request_user_approval.request_user_approval_direct",
            side_effect=fake_request_user_approval_direct,
        ),
    ):
        events = []
        async for event in manager.execute_tool(
            workflow_instance,
            {
                "goal": "Buy one brush",
                "output_schema": {"fields": [{"name": "purchase_complete", "type": "bool"}]},
            },
            "tool-1",
        ):
            events.append(event)

    assert [call[0] for call in execute_activity_calls] == [
        "lookup_purchase_activity",
        "mint_purchase_card_activity",
    ]
    assert len(approval_calls) == 1
    assert approval_calls[0]["metadata"]["requestPaymentCard"]["merchant"] == "Blick Art Materials"
    assert approval_calls[0]["metadata"]["requestPaymentCard"]["totalCents"] == 636
    assert len(start_calls) == 2

    resumed_args = start_calls[1][1]["args"]
    assert resumed_args[4] == "task-1"
    assert resumed_args[5] == "session-1"
    assert resumed_args[6] == "wss://connect.steel.dev/session-1"
    assert resumed_args[7] is True
    resume_state = resumed_args[12]
    assert resume_state["approval_type"] == "payment"
    assert resume_state["auth_realm"] == "dickblick.com"
    assert resume_state["step_count"] == 12
    checkout_domain = get_domain_from_url("https://www.dickblick.com/checkout/")
    assert resume_state["write_lock_approvals"]["payment"] == {
        "domain": checkout_domain,
        "approved_at": current_time.timestamp(),
        "persistent": True,
    }
    # Site-wide unlock so Place order does not re-prompt on this domain
    # (ephemeral to this browser activity's resume state only).
    assert resume_state["write_lock_approvals"]["site"] == {
        "domain": checkout_domain,
        "approved_at": current_time.timestamp(),
        "persistent": True,
    }
    assert resume_state["payment_card_refs"] == {
        "card_number": "4242424242424242",
        "card_name": "Rose Labs",
        "card_expiry": "12/30",
        "card_cvv": "123",
    }
    assert resume_state["payment_card_last4"] == "4242"

    payment_ready = next(event for event in events if getattr(event, "title", "") == "Payment card ready")
    assert payment_ready.status == MessageStatus.FINISHED
    final_event = events[-1]
    assert final_event.status == MessageStatus.FINISHED
    assert final_event.metadata["structured_response"] == {"purchase_complete": True}

def test_payment_card_verifier_evidence_exposes_only_valid_last_four():
    from domains.spawn_browser_agent_v3.handler import _build_payment_card_verifier_evidence

    evidence = _build_payment_card_verifier_evidence("4242")
    assert evidence == {
        "role": "TOOL",
        "text": "Approved one-time payment card last four: 4242",
        "metadata": {
            "toolName": "payment_card_ready",
            "toolStatus": "FINISHED",
            "paymentCardLast4": "4242",
        },
    }
    assert _build_payment_card_verifier_evidence("4242424242424242") is None
    assert _build_payment_card_verifier_evidence("42x2") is None
    assert _build_payment_card_verifier_evidence(None) is None

async def test_payment_lookup_reuses_backend_matched_legacy_fingerprint():
    from domains.spawn_browser_agent_v3.handler import _lookup_payment_purchase

    calls = []

    async def fake_execute_activity(activity_name, *args, **kwargs):
        calls.append((activity_name, kwargs["args"]))
        return {
            "found": True,
            "reusable": True,
            "purchase": {"cardId": "held-card", "fingerprint": "stored-legacy-fingerprint"},
        }

    with patch(
        "domains.spawn_browser_agent_v3.handler.workflow.execute_activity",
        side_effect=fake_execute_activity,
    ):
        result, matched = await _lookup_payment_purchase(
            "user-1",
            {"fingerprint": "canonical-fingerprint"},
        )

    assert result["reusable"] is True
    assert matched == "stored-legacy-fingerprint"
    assert calls == [
        ("lookup_purchase_activity", ["user-1", "canonical-fingerprint"]),
    ]

class _FakePaymentGateHandle:
    """Awaitable activity handle returning a fixed result (matches manager fake)."""

    def __init__(self, result):
        self._result = result

    def done(self):
        return True

    def cancel(self):
        raise AssertionError("done activity should not be cancelled")

    def __await__(self):
        async def _result():
            return self._result

        return _result().__await__()

async def _drive_payment_card_gate(
    *,
    mint_results,
    reject_gate=False,
    agentcard_connected=True,
    checkout_error=None,
):
    """Drive execute_tool through the payment-card gate branch.

    Returns (events, activity_calls, gate_keys, gate_payloads). ``mint_results`` is a list
    of dicts returned by successive ``mint_purchase_card_activity`` calls
    (the last value repeats once exhausted).
    """
    from domains.spawn_browser_agent_v3.handler import SpawnBrowserAgentManagerV3
    from tools.gate import GateRejectedError

    activity_calls = []
    gate_keys = []
    gate_payloads = []
    mint_iter = iter(mint_results)
    last_mint = {}

    def _next_mint():
        nonlocal last_mint
        try:
            last_mint = next(mint_iter)
        except StopIteration:
            pass
        return last_mint

    first = _FakePaymentGateHandle(
        {
            "status": "awaiting_payment_card_approval",
            "payment_request": {
                "merchant": "Blick Art Materials",
                "line_items": [
                    {
                        "name": "Brush",
                        "product_url": "https://www.dickblick.com/products/brush/",
                        "rating": "4.7 stars",
                        "review_count": "84 reviews",
                        "quantity": 1,
                        "line_total_cents": 636,
                    }
                ],
                "subtotal_cents": 636,
                "total_cents": 636,
            },
            "current_url": "https://www.dickblick.com/checkout/",
            "write_lock_approvals": {},
            "step_count": 3,
            "session_id": "session-1",
            "cdp_url": "wss://connect.steel.dev/session-1",
            "task_id": "task-1",
        }
    )
    resume = _FakePaymentGateHandle({"success": True, "message": "done", "output_files": []})

    workflow_instance = SimpleNamespace(
        user_id="user-1",
        agent_id="agent-1",
        is_paused=False,
        write_lock_enabled=True,
        system_name="Rose",
    )

    async def fake_execute_activity(activity_name, *args, **kwargs):
        activity_calls.append(
            activity_name if isinstance(activity_name, str) else getattr(activity_name, "__name__", "callable")
        )
        if activity_name == "lookup_purchase_activity":
            return {"found": False, "reusable": False, "purchase": None}
        if activity_name == "mint_purchase_card_activity":
            return _next_mint()
        if activity_name == "agentcard_status_activity":
            return {"connected": agentcard_connected}
        if activity_name == "resolve_attention_request_activity":
            return {}
        if not isinstance(activity_name, str):  # mint_subscription_checkout_activity
            if checkout_error is not None:
                raise checkout_error
            return "https://checkout.example/subscribe"
        raise AssertionError(f"unexpected activity: {activity_name}")

    async def fake_request_user_approval_direct(*_args, **_kwargs):
        return {"attention_request_id": "approval-1"}

    async def fake_request_user_attention_direct(*_args, **kwargs):
        assert kwargs["metadata"]["excludeFromModel"] is True
        return {"attention_request_id": "setup-1"}

    async def fake_raise_gate_direct(_wf, _gate, *, gate_key):
        gate_keys.append(gate_key)
        gate_payloads.append(_gate)
        if reject_gate:
            raise GateRejectedError(gate_key)
        return {"resolved": True}

    start_calls = []

    def fake_start_activity(*args, **kwargs):
        start_calls.append((args, kwargs))
        return first if len(start_calls) == 1 else resume

    # Advancing clock so the AgentCard connect-wait deadline is reachable
    # (a constant clock would spin forever when the wallet never connects).
    base_time = datetime(2026, 7, 9, 23, 50, 0, tzinfo=timezone.utc)
    clock = {"n": 0}

    def fake_now():
        value = base_time + timedelta(minutes=6 * clock["n"])
        clock["n"] += 1
        return value

    manager = SpawnBrowserAgentManagerV3()
    with (
        patch("domains.spawn_browser_agent_v3.handler.workflow.start_activity", side_effect=fake_start_activity),
        patch("domains.spawn_browser_agent_v3.handler.workflow.wait_condition", AsyncMock(return_value=None)),
        patch("domains.spawn_browser_agent_v3.handler.workflow.execute_activity", side_effect=fake_execute_activity),
        patch("domains.spawn_browser_agent_v3.handler.workflow.now", side_effect=fake_now),
        patch("domains.spawn_browser_agent_v3.handler.workflow.sleep", AsyncMock(return_value=None)),
        patch(
            "tools.request_user_approval.request_user_approval_direct", side_effect=fake_request_user_approval_direct
        ),
        patch(
            "tools.request_user_approval.request_user_attention_direct",
            side_effect=fake_request_user_attention_direct,
        ),
        patch("tools.gate.raise_gate_direct", side_effect=fake_raise_gate_direct),
    ):
        events = []
        async for event in manager.execute_tool(
            workflow_instance,
            {"goal": "Buy one brush", "output_schema": {"fields": [{"name": "ok", "type": "bool"}]}},
            "tool-1",
        ):
            events.append(event)
    return events, activity_calls, gate_keys, gate_payloads

async def test_manager_payment_gate_agentcard_setup_required_prompts_and_retries():
    events, activity_calls, _, _ = await _drive_payment_card_gate(
        mint_results=[
            {
                "status": "agentcard_setup_required",
                "setupAction": "connect_agentcard",
                "connectUrl": "https://x/connect",
            },
            {"status": "agentcard_setup_required", "connectUrl": "https://x/connect"},
        ],
        agentcard_connected=True,
    )
    # First mint gate → setup attention, connect polled, attention resolved, re-mint.
    assert activity_calls == [
        "lookup_purchase_activity",
        "mint_purchase_card_activity",
        "agentcard_status_activity",
        "resolve_attention_request_activity",
        "mint_purchase_card_activity",
    ]
    setup_titles = [getattr(e, "title", "") for e in events]
    assert "One Time Agent Payment Setup" in setup_titles
    assert "Agent payment setup complete" in setup_titles
    # Second mint still setup_required → prompt once more and stop (no card issued).
    assert not any(getattr(e, "title", "") == "Payment card ready" for e in events)

async def test_manager_payment_gate_agentcard_setup_times_out_when_never_connected():
    events, activity_calls, _, _ = await _drive_payment_card_gate(
        mint_results=[{"status": "agentcard_setup_required", "connectUrl": "https://x/connect"}],
        agentcard_connected=False,
    )
    # Setup prompted, connect polled once, then deadline reached → return without card.
    assert "agentcard_status_activity" in activity_calls
    assert "resolve_attention_request_activity" not in activity_calls
    assert any(getattr(e, "title", "") == "One Time Agent Payment Setup" for e in events)
    assert not any(getattr(e, "title", "") == "Payment card ready" for e in events)

async def test_manager_payment_gate_subscription_rejected_cancels_purchase():
    events, activity_calls, gate_keys, _ = await _drive_payment_card_gate(
        mint_results=[{"status": "subscription_required"}],
        reject_gate=True,
    )
    assert gate_keys == ["subscription"]
    cancelled = next(e for e in events if getattr(e, "title", "") == "Purchase cancelled")
    assert cancelled.metadata["action_type"] == "purchase_cancelled"
    assert activity_calls.count("mint_purchase_card_activity") == 1

async def test_manager_payment_gate_subscription_still_inactive_after_retry_blocks():
    events, activity_calls, gate_keys, _ = await _drive_payment_card_gate(
        mint_results=[{"status": "subscription_required"}, {"status": "subscription_required"}],
        reject_gate=False,
    )
    assert gate_keys == ["subscription"]
    blocked = next(e for e in events if getattr(e, "title", "") == "Subscription still inactive")
    assert blocked.metadata["action_type"] == "purchase_blocked"
    assert activity_calls.count("mint_purchase_card_activity") == 2

async def test_manager_payment_gate_subscription_checkout_failure_still_raises_gate():
    events, activity_calls, gate_keys, gate_payloads = await _drive_payment_card_gate(
        mint_results=[{"status": "subscription_required"}],
        checkout_error=RuntimeError("STRIPE_SUBSCRIPTION_PRICE_ID is required"),
        reject_gate=True,
    )
    assert gate_keys == ["subscription"]
    assert gate_payloads[0]["type"] == "subscription"
    assert gate_payloads[0]["gateKey"] == "subscription"
    assert gate_payloads[0]["action"]["url"] == "https://roselabs.ai/subscribe"
    assert "mint_subscription_checkout_activity" in activity_calls
    cancelled = next(e for e in events if getattr(e, "title", "") == "Purchase cancelled")
    assert cancelled.metadata["action_type"] == "purchase_cancelled"

async def test_manager_payment_gate_kyc_rejected_cancels_purchase():
    events, _, gate_keys, _ = await _drive_payment_card_gate(
        mint_results=[{"status": "kyc_required"}],
        reject_gate=True,
    )
    assert gate_keys == ["kyc"]
    cancelled = next(e for e in events if getattr(e, "title", "") == "Purchase cancelled")
    assert cancelled.metadata["action_type"] == "purchase_cancelled"

async def test_manager_payment_gate_kyc_still_incomplete_after_retry_blocks():
    events, activity_calls, gate_keys, _ = await _drive_payment_card_gate(
        mint_results=[{"status": "kyc_required"}, {"status": "kyc_required"}],
        reject_gate=False,
    )
    assert gate_keys == ["kyc"]
    blocked = next(e for e in events if getattr(e, "title", "") == "Identity verification still incomplete")
    assert blocked.metadata["action_type"] == "purchase_blocked"
    assert activity_calls.count("mint_purchase_card_activity") == 2

async def test_manager_payment_gate_retries_company_funding_and_mints():
    events, activity_calls, _, _ = await _drive_payment_card_gate(
        mint_results=[
            {
                "status": "agentcard_company_funding_in_progress",
                "retryAfterSeconds": 5,
            },
            {
                "status": "HELD",
                "purchaseId": "purchase-1",
                "cardId": "card-1",
                "pan": "4242424242424242",
                "cvv": "123",
                "expiry": "12/30",
                "last4": "4242",
            },
        ]
    )
    assert activity_calls.count("mint_purchase_card_activity") == 2
    assert not any(getattr(e, "title", "") == "Payment funding is delayed" for e in events)

def test_manager_payment_gate_normalizes_company_funding_retry_delay():
    from domains.spawn_browser_agent_v3.handler import _normalize_funding_retry_seconds

    for invalid in (True, False, None, "5", float("nan"), float("inf"), 0, -1):
        assert _normalize_funding_retry_seconds(invalid) == 5.0
    assert _normalize_funding_retry_seconds(0.001) == 1.0
    assert _normalize_funding_retry_seconds(5) == 5.0
    assert _normalize_funding_retry_seconds(600) == 60.0

async def test_manager_payment_gate_reports_company_funding_deadline():
    events, activity_calls, _, _ = await _drive_payment_card_gate(
        mint_results=[
            {
                "status": "agentcard_company_funding_in_progress",
                "retryAfterSeconds": 5,
            }
        ]
    )
    assert activity_calls.count("mint_purchase_card_activity") == 2
    delayed = next(e for e in events if getattr(e, "title", "") == "Payment funding is delayed")
    assert delayed.metadata["action_type"] == "purchase_funding_delayed"

# ========================================
# Runner
# ========================================

def test_challenge_recovery_reuses_one_tool_call_id_for_every_stage():
    """Every recovery stage must update one streamed progress lifecycle."""
    import inspect

    from domains.spawn_browser_agent_v3.handler import (
        _browser_action_tool_call_id,
        _spawn_browser_agent_activity_v3_real,
    )

    llm_result = {"tool_call_id": "call_recovery_123"}

    assert _browser_action_tool_call_id(llm_result) == "call_recovery_123"
    assert _browser_action_tool_call_id(llm_result) == "call_recovery_123"

    # Cement the integration: all staged IN_PROGRESS and terminal events close
    # the exact tool call streamed by the browser-use model.
    activity_source = inspect.getsource(_spawn_browser_agent_activity_v3_real)
    recovery_branch = activity_source.split('if action_name == "recover_from_challenge":', 1)[1].split(
        'if action_name == "send_message_to_user":', 1
    )[0]
    assert "recovery_call_id = _browser_action_tool_call_id(llm_result)" in recovery_branch
    assert "tool_call_id=recovery_call_id" in recovery_branch
    assert "recovery_call_id = str(uuid_module.uuid4())" not in recovery_branch
    assert "status=MessageStatus.IN_PROGRESS" in recovery_branch
    assert 'if not bool(config_result.get("storage_state_preloaded")):' in recovery_branch
    assert "await _restore_rotation_storage_state(" in recovery_branch
    activity_source = inspect.getsource(_spawn_browser_agent_activity_v3_real)
    assert "pop_provider_exit_rejection()" in activity_source
    assert '"provider_exit_rejected": True' in activity_source
    # Assignment form (main): provider_exit_rejected = bool(unified_action...)
    assert "provider_exit_rejected = bool(" in recovery_branch
    assert 'await browser_stream.finish_tools(status="ERROR")' in activity_source

async def test_playwright_page_tracks_browser_use_tab_focus():
    """Humanized clicks, recorder, and live view must follow browser-use focus."""
    import inspect

    from domains.spawn_browser_agent_v3.handler import (
        _rebind_browser_tab_runtime,
        _spawn_browser_agent_activity_v3_real,
    )

    class FakeCdpSession:
        def __init__(self, target_id):
            self.target_id = target_id
            self.detached = False

        async def send(self, method):
            assert method == "Target.getTargetInfo"
            return {"targetInfo": {"targetId": self.target_id}}

        async def detach(self):
            self.detached = True

    class FakePage:
        def __init__(self, target_id, url):
            self.target_id = target_id
            self.url = url
            self.front_calls = 0
            self.mutated = False
            page = self

            class FakeMouse:
                async def move(self, *_args, **_kwargs):
                    return None

                async def down(self, *_args, **_kwargs):
                    return None

                async def up(self, *_args, **_kwargs):
                    page.mutated = True

            self.mouse = FakeMouse()

        async def bring_to_front(self):
            self.front_calls += 1

    class FakeContext:
        def __init__(self, pages):
            self.pages = pages
            self.sessions = []

        async def new_cdp_session(self, page):
            session = FakeCdpSession(page.target_id)
            self.sessions.append(session)
            return session

    page_a = FakePage("target-a", "https://doordash.example/orders")
    page_b = FakePage("target-b", "https://google.example/sorry")
    context = FakeContext([page_a, page_b])
    browser = SimpleNamespace(contexts=[context])
    dom_service = SimpleNamespace(session=SimpleNamespace(agent_focus_target_id="target-b"))

    old_humanizer = SimpleNamespace(closed=False)

    async def close_old_humanizer():
        old_humanizer.closed = True

    old_humanizer.close = close_old_humanizer
    recorder = SimpleNamespace(page=page_a)

    with (
        patch.dict(
            os.environ,
            {
                "BROWSER_AGENT_CDP_MOUSE_TRANSPORT": "0",
                "BROWSER_AGENT_IDLE_MOUSE_ENABLED": "0",
                "BROWSER_AGENT_VISUAL_CURSOR_ENABLED": "0",
            },
        ),
        patch("browser_tools.humanizer.asyncio.sleep", new=AsyncMock()),
    ):
        selected, rebound_humanizer = await _rebind_browser_tab_runtime(
            dom_service=dom_service,
            dom_page=SimpleNamespace(),
            playwright_browser=browser,
            current_page=page_a,
            humanizer=old_humanizer,
            browser_recorder=recorder,
            cursor_observer=None,
        )
        await rebound_humanizer.click_at_coords(100, 100)

    assert selected is page_b
    assert recorder.page is page_b
    assert old_humanizer.closed is True
    assert page_a.front_calls == 0
    assert page_b.front_calls == 1
    assert page_a.mutated is False
    assert page_b.mutated is True
    assert all(session.detached for session in context.sessions)

    activity_source = inspect.getsource(_spawn_browser_agent_activity_v3_real)
    assert "input_page, humanizer = await _rebind_browser_tab_runtime(" in activity_source

async def test_browser_agent_yields_until_user_hands_control_back():
    """The activity must acknowledge ownership and stop acting until release."""
    from domains.spawn_browser_agent_v3.handler import _wait_for_browser_user_control

    with (
        patch(
            "domains.spawn_browser_agent_v3.handler.fetch_browser_control_state",
            AsyncMock(side_effect=["requested", "user", "agent"]),
        ),
        patch(
            "domains.spawn_browser_agent_v3.handler.acknowledge_browser_user_control",
            AsyncMock(return_value="user"),
        ) as acknowledge,
        patch("domains.spawn_browser_agent_v3.handler.activity.heartbeat") as heartbeat,
        patch("domains.spawn_browser_agent_v3.handler.asyncio.sleep", new=AsyncMock()),
    ):
        yielded = await _wait_for_browser_user_control(SimpleNamespace(), "task-1")

    assert yielded is True
    acknowledge.assert_awaited_once()
    assert heartbeat.call_count == 2

_TOAST_PAYMENT_CARD_ARGS = {
    "merchant": "Nopa Fish Market",
    "line_items": [
        {
            "name": "Fish & Chips",
            "quantity": 1,
            "unit_price_cents": 2500,
            "line_total_cents": 2500,
            # Toast is a single-URL food-ordering SPA: no star rating, no
            # reviews. This is the exact class of args prod agent 847adea5
            # produced and got rejected 5x on.
            #
            # The product_url is validated for well-formedness only. URL
            # matching was removed after it made purchases impossible on whole
            # ordering platforms (agents 53feac08, 90ac106a).
            "product_url": "https://order.toasttab.com/online/nopafish/checkout/12345678-1234-4fab-8043-436e74cc34a9",
            "rating": "No rating displayed on Toast ordering page",
            "review_count": "No reviews displayed on Toast ordering page",
        }
    ],
    "subtotal_cents": 2500,
    "total_cents": 2851,
}

def test_payment_card_tool_args_raise_typed_validation_error():
    """RCA repro (agent 847adea5): unsatisfiable request_payment_card args on a Toast
    food-ordering page must surface as a typed BrowserToolArgsValidationError — a
    model-output error the loop feeds back — not a bare pydantic ValidationError that
    the loop's infra-failure handler would swallow into a mislabeled 'Max Steps'."""
    from pydantic import ValidationError

    from browser_tools.schemas import BrowserToolArgsValidationError, validate_browser_tool_args

    try:
        validate_browser_tool_args("request_payment_card", _TOAST_PAYMENT_CARD_ARGS)
        raise AssertionError("expected validation to reject the Toast checkout args")
    except BrowserToolArgsValidationError as err:
        assert err.tool_name == "request_payment_card"
        assert err.tool_args == _TOAST_PAYMENT_CARD_ARGS
        # product_url is no longer a rejection reason: it is validated for
        # well-formedness only, and the Toast checkout URL is a real URL. The
        # RCA property under test is unchanged -- unsatisfiable args must surface
        # as a TYPED error the loop feeds back, not a bare ValidationError the
        # infra handler swallows into a mislabeled "Max Steps".
        assert "product_url" not in err.detail
        assert "rating" in err.detail
        assert "review_count" in err.detail
        # It must be a distinct type, not a bare pydantic ValidationError.
        assert not isinstance(err, ValidationError)

async def test_browser_tool_validation_error_feeds_back_through_normal_path():
    """A rejected tool call must be routed through the normal tool-result path:
    recorded in action history, appended to the next-turn context so the model can
    self-correct, and shown in the trajectory — never swallowed. Guards the RCA fix."""
    from browser_tools.dom_service import ActionHistory
    from browser_tools.schemas import BrowserToolArgsValidationError, validate_browser_tool_args
    from domains.spawn_browser_agent_v3.handler import _feed_browser_tool_validation_error_back

    try:
        validate_browser_tool_args("request_payment_card", _TOAST_PAYMENT_CARD_ARGS)
        raise AssertionError("expected BrowserToolArgsValidationError")
    except BrowserToolArgsValidationError as err:
        err.thinking = "I need a card to pay for the order."
        validation_error = err

    action_history = ActionHistory()
    browser_turn_messages: list = []

    with patch(
        "domains.spawn_browser_agent_v3.handler.save_browser_action_message",
        new=AsyncMock(),
    ) as save_mock:
        await _feed_browser_tool_validation_error_back(
            error=validation_error,
            action_history=action_history,
            browser_turn_messages=browser_turn_messages,
            dom_service=MagicMock(),
            browser_state={"url": "https://order.toasttab.com/online/nopafish/checkout/abc"},
            task_prompt="order fish and chips",
            iteration=12,
            agent_id="agent-1",
            task_id="task-1",
            browser_url="https://order.toasttab.com/online/nopafish/checkout/abc",
        )

    # 1) Fed back to the model as a tool result in the next-turn context (not swallowed).
    tool_msgs = [m for m in browser_turn_messages if m.get("role") == "tool"]
    assert tool_msgs, "validation error was not appended to browser_turn_messages"
    tool_blob = json.dumps(tool_msgs[-1])
    # product_url no longer participates: it is validated for well-formedness only.
    assert "rating" in tool_blob and "review_count" in tool_blob
    # 2) Recorded in action history as a failed attempt the model can see.
    entries = action_history.get_entries()
    assert entries and entries[-1]["action"] == "request_payment_card"
    assert entries[-1]["result"]["success"] is False
    # 3) Visible in the trajectory as its own row.
    save_mock.assert_awaited_once()
    assert save_mock.await_args.kwargs["action_type"] == "request_payment_card"

def test_browser_tool_events_declare_action_type():
    """Every workflow-scope spawn_browser_agent event must declare action_type.

    The front-end decides whether a browser task is over from `action_type`
    alone (front-end/src/features/terminal/hooks/derivations.ts,
    .../message-bubble/useMessageRouting.ts). An event that omits it is
    indistinguishable from the legacy untyped terminal, so a *progress* event
    silently closes a live browser panel and renders the chip as "Done".

    Prod agent 7f354640-ffab-4098-b7ae-041ddf246c6f hit exactly that: "Payment
    card ready" (untyped) closed the panel while the same browser task ran for
    another five minutes. Commit e5f87f9a4 had already fixed this class for the
    auth-handoff events but nothing enforced it, so the payment and write-lock
    events were missed. This test is that enforcement.
    """
    handler_path = (
        Path(__file__).resolve().parents[2]
        / "domains"
        / "spawn_browser_agent_v3"
        / "handler.py"
    )
    tree = ast.parse(handler_path.read_text())

    untyped_lines = []
    typed_count = 0
    for node in ast.walk(tree):
        if not isinstance(node, ast.Dict):
            continue
        literal_items = {
            key.value: value.value
            for key, value in zip(node.keys, node.values)
            if isinstance(key, ast.Constant)
            and isinstance(key.value, str)
            and isinstance(value, ast.Constant)
        }
        if literal_items.get("toolName") != "spawn_browser_agent":
            continue
        declared_keys = {
            key.value
            for key in node.keys
            if isinstance(key, ast.Constant) and isinstance(key.value, str)
        }
        if "action_type" in declared_keys:
            typed_count += 1
        else:
            untyped_lines.append(node.lineno)

    assert not untyped_lines, (
        "spawn_browser_agent event metadata missing an explicit action_type at "
        f"handler.py lines {untyped_lines}. Add a terminal action_type "
        "('task_complete'/'session_paused') for real terminals, or a distinct "
        "progress action_type — never leave it absent."
    )
    assert typed_count >= 18, (
        f"expected at least 18 typed spawn_browser_agent events, found {typed_count} "
        "— did the scan stop matching?"
    )

    # The other half of the contract: a completion message
    # (is_completion_message drops subAgentId, so it lands in the main chat and
    # closes the chip) must declare an explicitly terminal action_type. Without
    # this, a terminal is inferred from message shape — the same failure mode in
    # reverse.
    terminal_action_types = {"task_complete", "session_paused"}
    untyped_completions = []
    completion_count = 0
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        keywords = {kw.arg: kw.value for kw in node.keywords if kw.arg}
        flag = keywords.get("is_completion_message")
        if not (isinstance(flag, ast.Constant) and flag.value is True):
            continue
        completion_count += 1
        action_type = keywords.get("action_type")
        if not (
            isinstance(action_type, ast.Constant)
            and action_type.value in terminal_action_types
        ):
            untyped_completions.append(node.lineno)

    assert not untyped_completions, (
        "browser completion messages must declare a terminal action_type "
        f"({sorted(terminal_action_types)}) at handler.py lines {untyped_completions}"
    )
    assert completion_count >= 5, (
        f"expected at least 5 completion-message call sites, found {completion_count} "
        "— did the scan stop matching?"
    )


async def run_all_tests():
    print("spawn-browser-agent-v3 blackbox tests:")
    r = BlackboxResult()

    r.record(
        "payment_card_tool_args_raise_typed_validation_error",
        test_payment_card_tool_args_raise_typed_validation_error,
    )
    await r.record_async(
        "browser_tool_validation_error_feeds_back_through_normal_path",
        test_browser_tool_validation_error_feeds_back_through_normal_path,
    )

    r.record(
        "payment_card_verifier_evidence_only_last_four",
        test_payment_card_verifier_evidence_exposes_only_valid_last_four,
    )
    await r.record_async(
        "payment_lookup_backend_matched_legacy_fingerprint",
        test_payment_lookup_reuses_backend_matched_legacy_fingerprint,
    )

    await r.record_async("cdp_use_websocket_direct", test_cdp_use_websocket_patch_disables_proxy_discovery)
    await r.record_async(
        "dom_service_passkey_webauthn_uses_cdp_client_session_api",
        test_dom_service_passkey_webauthn_uses_cdp_client_session_api,
    )
    await r.record_async(
        "passkey_usage_recorded_before_completion",
        test_passkey_usage_is_recorded_once_before_browser_task_completion,
    )
    await r.record_async(
        "passkey_usage_retries_after_write_failure",
        test_passkey_usage_retries_after_credential_ref_write_failure,
    )
    await r.record_async(
        "passkey_usage_captured_before_disconnect",
        test_disconnect_browser_captures_passkey_usage_before_disconnect,
    )
    r.record(
        "passkey_usage_sampled_before_terminal_disconnects",
        test_passkey_usage_is_sampled_before_every_terminal_browser_disconnect,
    )
    r.record(
        "passkey_usage_dedupe_survives_resume_boundaries",
        test_passkey_usage_dedupe_survives_every_browser_activity_resume_boundary,
    )
    r.record(
        "browser_action_log_summary_redacts_payment_secrets", test_browser_action_log_summary_redacts_payment_secrets
    )
    r.record("browser_progress_title", test_browser_progress_title_describes_active_agent)
    r.record("verifier_timeout_standard_llm_budget", test_verifier_activity_timeout_allows_llm_call)
    r.record(
        "stateful_browser_activity_one_thirty_minute_attempt",
        test_stateful_browser_activity_has_one_thirty_minute_attempt,
    )
    r.record("max_steps_best_effort_prefers_last_reasoning", test_max_steps_best_effort_prefers_last_reasoning)
    r.record("max_steps_best_effort_skips_blank_reasoning", test_max_steps_best_effort_skips_blank_reasoning)
    r.record("max_steps_best_effort_falls_back", test_max_steps_best_effort_falls_back_to_actions_then_url)
    r.record(
        "max_steps_best_effort_empty_only_when_no_evidence", test_max_steps_best_effort_empty_only_when_no_evidence
    )
    await r.record_async(
        "browser_verifier_context_grounds_final_state", test_browser_verifier_context_grounds_in_final_state
    )
    
    r.record("action_history_restores_across_activity", test_action_history_restores_across_activity_boundary)
    await r.record_async(
        "action_history_resume_monotonic_steps",
        test_action_history_resume_preserves_monotonic_step_numbers,
    )
    r.record(
        "max_steps_return_wires_best_effort_and_verifier", test_max_steps_return_declares_best_effort_and_final_verifier
    )
    r.record(
        "browser_step_budget_extends_beyond_productive_step_30_capture",
        test_browser_step_budget_extends_beyond_productive_step_30_capture,
    )
    r.record(
        "browser_supervisor_timeout_ordering",
        test_browser_supervisor_does_not_preempt_browser_use_event_timeouts,
    )
    r.record(
        "browser_task_prompt_no_system_duplication",
        test_browser_task_prompt_does_not_duplicate_system_prompt,
    )
    await r.record_async(
        "pending_write_lock_rehydrates_url_and_dom_target",
        test_pending_write_lock_action_rehydrates_url_and_remaps_dom_target,
    )
    r.record(
        "browser_turn_history_preserves_state",
        test_browser_turn_history_preserves_state_before_tool_result,
    )

    # service_crypto — pure
    r.record(
        "normalize_rate_limited_until_epoch_int",
        test_normalize_rate_limited_until_handles_epoch_int,
    )
    r.record(
        "normalize_rate_limited_until_epoch_string",
        test_normalize_rate_limited_until_handles_epoch_string,
    )
    r.record(
        "normalize_rate_limited_until_iso_naive",
        test_normalize_rate_limited_until_handles_iso_naive,
    )
    r.record(
        "normalize_rate_limited_until_iso_z",
        test_normalize_rate_limited_until_handles_iso_z,
    )
    r.record(
        "normalize_rate_limited_until_invalid",
        test_normalize_rate_limited_until_none_empty_invalid,
    )
    r.record("extract_rate_limited_until_not_dict", test_extract_rate_limited_until_not_dict)
    r.record(
        "extract_rate_limited_until_canonical",
        test_extract_rate_limited_until_canonical_field,
    )
    r.record(
        "extract_rate_limited_until_headers_reset",
        test_extract_rate_limited_until_from_headers_reset,
    )
    r.record(
        "extract_rate_limited_until_headers_retry_after",
        test_extract_rate_limited_until_from_headers_retry_after,
    )
    r.record("extract_otp_comprehensive_formats", test_extract_otp_comprehensive_formats)
    r.record("extract_otp_ignores_non_otp_numbers", test_extract_otp_ignores_non_otp_numbers)
    r.record(
        "format_otp_user_message_sms_label_and_sender",
        test_format_otp_user_message_shows_sms_label_and_sender,
    )
    await r.record_async(
        "fetch_recent_otps_includes_imessage_prefers_agentphone",
        test_fetch_recent_otps_includes_imessage_and_prefers_agentphone,
    )
    await r.record_async(
        "fetch_recent_otps_skips_imessage_without_otp_context",
        test_fetch_recent_otps_skips_imessage_without_otp_context,
    )
    r.record(
        "extract_rate_limited_until_text_iso",
        test_extract_rate_limited_until_from_text_iso,
    )
    r.record(
        "extract_rate_limited_until_text_epoch",
        test_extract_rate_limited_until_from_text_epoch,
    )
    r.record(
        "extract_rate_limited_until_text_retry_after",
        test_extract_rate_limited_until_from_text_retry_after,
    )
    r.record(
        "extract_rate_limited_until_no_signal",
        test_extract_rate_limited_until_no_signal,
    )

    r.record("decrypt_payment_info_roundtrip", test_decrypt_payment_info_roundtrip)
    r.record("decrypt_payment_info_wrong_version", test_decrypt_payment_info_wrong_version)
    r.record("decrypt_payment_info_bad_envelope", test_decrypt_payment_info_bad_envelope)
    r.record("decrypt_password_roundtrip", test_decrypt_password_roundtrip)
    r.record("decrypt_password_wrong_version", test_decrypt_password_wrong_version)
    r.record(
        "decrypt_password_invalid_input",
        test_decrypt_password_invalid_input_returns_none,
    )
    r.record("decrypt_password_with_key_roundtrip", test_decrypt_password_with_key_roundtrip)
    r.record(
        "decrypt_password_with_key_bad_version",
        test_decrypt_password_with_key_bad_version,
    )
    r.record(
        "decrypt_password_with_key_bad_envelope",
        test_decrypt_password_with_key_bad_envelope,
    )

    r.record("extract_otp_verification", test_extract_otp_from_text_verification_code)
    r.record("extract_otp_is_your_code", test_extract_otp_from_text_is_your_code)
    r.record("extract_otp_pin", test_extract_otp_from_text_4_digit_pin)
    r.record("extract_otp_8_digit", test_extract_otp_from_text_8_digit_code)
    r.record("extract_otp_expires_phrase", test_extract_otp_from_text_expires_phrase)
    r.record(
        "extract_otp_low_confidence",
        test_extract_otp_from_text_low_confidence_context_strict,
    )
    r.record("extract_otp_no_match", test_extract_otp_from_text_no_match)

    await r.record_async("fetch_recent_otps_empty", test_fetch_recent_otps_empty)
    await r.record_async("fetch_recent_otps_extracts_codes", test_fetch_recent_otps_extracts_codes)
    await r.record_async(
        "fetch_recent_otps_extracts_html_codes",
        test_fetch_recent_otps_extracts_codes_from_html_body,
    )
    await r.record_async("fetch_recent_otps_dedupes_old", test_fetch_recent_otps_dedupes_old_emails)
    await r.record_async(
        "fetch_recent_otps_skips_nearly_expired",
        test_fetch_recent_otps_skips_nearly_expired_codes,
    )
    await r.record_async(
        "fetch_recent_otps_extracts_sms_codes",
        test_fetch_recent_otps_extracts_sms_codes,
    )
    r.record("format_otp_user_message", test_format_otp_user_message)
    r.record("format_otp_user_message_sms", test_format_otp_user_message_sms)

    r.record("build_autopay_prompt_section", test_build_autopay_prompt_section)
    r.record("build_autopay_prompt_section_no_card", test_build_autopay_prompt_section_no_card)
    r.record("build_payment_card_resume_prompt_section", test_build_payment_card_resume_prompt_section)
    r.record(
        "build_payment_card_resume_prompt_section_requires_all_refs",
        test_build_payment_card_resume_prompt_section_requires_all_refs,
    )
    r.record("build_passwords_prompt_section_empty", test_build_passwords_prompt_section_empty)
    r.record("build_passwords_prompt_section_unique", test_build_passwords_prompt_section_unique_usernames)
    r.record("build_passwords_prompt_section_duplicate", test_build_passwords_prompt_section_duplicate_usernames)
    r.record("build_auth_options_prompt_section", test_build_auth_options_prompt_section_scoped_password_refs)
    r.record(
        "build_auth_options_prompt_section_demo_site_ref",
        test_build_auth_options_prompt_section_demo_site_ref_does_not_expose_plaintext,
    )
    r.record(
        "build_auth_options_prompt_section_duplicate_username_by_id",
        test_build_auth_options_prompt_section_matches_duplicate_username_by_id,
    )
    r.record(
        "build_auth_options_prompt_section_missing_password_id_fail_closed",
        test_build_auth_options_prompt_section_fails_closed_when_password_id_missing,
    )
    r.record(
        "build_auth_options_prompt_section_absent_session_ids_fail_closed",
        test_build_auth_options_prompt_section_fails_closed_when_session_ids_absent,
    )
    r.record(
        "build_auth_options_prompt_section_duplicate_refs_no_overwrite",
        test_build_auth_options_prompt_section_dedupes_identical_refs_without_overwrite,
    )
    r.record(
        "build_auth_options_prompt_section_minted",
        test_build_auth_options_prompt_section_minted_account_ref,
    )
    r.record("auth_realm_from_url", test_auth_realm_from_url)
    r.record(
        "resume_context_from_session_info",
        test_resume_context_from_session_info_prefers_resumed_state,
    )
    r.record(
        "browser_profile_identity_delivery_split",
        test_browser_profile_separates_owner_from_delivery_recipient,
    )
    r.record(
        "auth_runtime_state_guard",
        test_auth_runtime_state_blocks_assistance_until_observable_ladder_exhausted,
    )
    r.record(
        "auth_runtime_state_unmatched_email",
        test_auth_runtime_state_does_not_block_on_unmatched_connected_email,
    )
    r.record(
        "auth_runtime_state_attemptable_passwords",
        test_auth_runtime_state_only_blocks_on_attemptable_passwords,
    )
    r.record(
        "auth_runtime_state_disabled_passwords",
        test_auth_runtime_state_does_not_block_on_disabled_passwords,
    )
    r.record(
        "auth_assistance_resume_user_message",
        test_auth_assistance_resume_user_message_preserves_live_state,
    )

    # repo
    await r.record_async("fetch_claude_token_success", test_fetch_claude_token_success)
    await r.record_async("fetch_claude_token_non_200", test_fetch_claude_token_non_200_returns_none)
    await r.record_async("fetch_claude_token_no_api_key", test_fetch_claude_token_no_api_key_returns_none)
    await r.record_async(
        "fetch_claude_token_force_pool",
        test_fetch_claude_token_with_force_pool_and_excludes,
    )
    await r.record_async(
        "fetch_claude_token_network_error",
        test_fetch_claude_token_network_error_returns_none,
    )
    await r.record_async("report_token_rl_pool", test_report_claude_token_rate_limited_pool)
    await r.record_async("report_token_rl_user", test_report_claude_token_rate_limited_user)
    await r.record_async(
        "report_token_rl_bad_source",
        test_report_claude_token_rate_limited_bad_source_noop,
    )
    await r.record_async(
        "report_token_rl_no_source",
        test_report_claude_token_rate_limited_no_source_noop,
    )
    await r.record_async("report_token_rl_no_key", test_report_claude_token_rate_limited_no_api_key_noop)
    await r.record_async(
        "report_token_rl_swallows_error",
        test_report_claude_token_rate_limited_swallows_network_error,
    )

    await r.record_async(
        "save_browser_action_message_metadata",
        test_save_browser_action_message_posts_metadata,
    )
    await r.record_async(
        "save_browser_action_message_tool_name_override",
        test_save_browser_action_message_tool_name_override,
    )
    await r.record_async(
        "save_browser_action_message_init",
        test_save_browser_action_message_init_no_subagent,
    )
    await r.record_async(
        "save_browser_action_message_error_flag",
        test_save_browser_action_message_error_sets_flag,
    )
    await r.record_async(
        "save_browser_action_message_swallows",
        test_save_browser_action_message_swallows_exception,
    )
    await r.record_async(
        "save_browser_action_message_rejects_non_2xx",
        test_save_browser_action_message_rejects_non_2xx,
    )
    await r.record_async(
        "save_browser_action_message_rejects_redirect",
        test_save_browser_action_message_rejects_redirect,
    )
    await r.record_async("save_browser_assistant_message", test_save_browser_assistant_message)
    await r.record_async(
        "save_browser_assistant_message_swallows",
        test_save_browser_assistant_message_swallows_exception,
    )
    await r.record_async("save_credential_ref_user", test_save_browser_credential_ref_message_user_role)
    await r.record_async(
        "save_credential_ref_reports_failure",
        test_save_browser_credential_ref_message_reports_backend_failure,
    )

    await r.record_async("list_session_files_no_api_key", test_list_session_files_no_api_key)
    await r.record_async("list_session_files_success", test_list_session_files_success)
    await r.record_async("list_session_files_non_200", test_list_session_files_non_200)
    await r.record_async("list_session_files_network_error", test_list_session_files_network_error)
    await r.record_async("download_file_no_api_key", test_download_file_from_steel_no_api_key)
    await r.record_async("download_file_strips_prefixes", test_download_file_from_steel_strips_prefixes)
    await r.record_async(
        "download_file_strips_leading_slash",
        test_download_file_from_steel_strips_leading_slash,
    )
    await r.record_async("download_file_non_200", test_download_file_from_steel_non_200)
    await r.record_async("download_file_network_error", test_download_file_from_steel_network_error)
    await r.record_async("steel_computer_screenshot_success", test_take_steel_computer_screenshot_success)
    await r.record_async(
        "steel_computer_screenshot_missing_image",
        test_take_steel_computer_screenshot_missing_image_raises,
    )

    await r.record_async("init_browser_session_success", test_init_browser_session_success)
    await r.record_async("init_browser_session_rate_limited", test_init_browser_session_rate_limited)
    await r.record_async(
        "init_browser_session_transient_retryable",
        test_init_browser_session_transient_failure_returns_retryable,
    )
    await r.record_async("init_browser_session_error", test_init_browser_session_error_raises)
    await r.record_async("fetch_session_info_success", test_fetch_session_info_success)
    await r.record_async(
        "fetch_session_info_validate_live",
        test_fetch_session_info_validate_live_sets_query_param,
    )
    await r.record_async("fetch_session_info_error", test_fetch_session_info_error_raises)
    await r.record_async(
        "resume_browser_session_success",
        test_resume_browser_session_posts_resume_endpoint,
    )
    await r.record_async("resume_browser_session_rate_limited", test_resume_browser_session_rate_limited)
    await r.record_async(
        "recover_browser_challenge_current_url_and_state",
        test_recover_browser_challenge_posts_current_url_and_state,
    )
    await r.record_async(
        "rotation_storage_state_provider_switch",
        test_rotation_storage_state_survives_provider_switch,
    )
    await r.record_async(
        "rotation_storage_capture_bounded",
        test_rotation_storage_capture_is_bounded_when_indexeddb_stalls,
    )
    await r.record_async(
        "rotation_storage_timeout_finishes_error",
        test_recovery_storage_timeout_finishes_error_and_returns_control_to_model_loop,
    )
    await r.record_async(
        "recovery_preloaded_solver_cookies",
        test_preloaded_restore_helper_skips_same_host_goto_and_cookie_rewrite,
    )
    await r.record_async(
        "recovery_preloaded_navigates_when_host_differs",
        test_preloaded_restore_helper_navigates_with_probe_timeout_when_host_differs,
    )
    r.record(
        "recovery_requires_live_tab_verify_before_success",
        test_recovery_requires_live_tab_verify_before_success,
    )
    r.record(
        "recovery_restore_failure_is_not_suppressed",
        test_recovery_restore_failure_is_not_suppressed,
    )
    r.record(
        "recovery_preflight_failure_resolves_tool",
        test_recovery_preflight_failures_resolve_the_in_progress_tool,
    )
    r.record(
        "recovery_reconnect_failure_drops_handles",
        test_recovery_reconnect_failure_drops_disconnected_browser_handles,
    )
    r.record(
        "passkeys_reseed_on_target_reset",
        test_passkeys_reseed_on_target_reset_like_cookies_and_localstorage,
    )
    r.record(
        "passkeys_revalidated_after_start_navigation",
        test_passkeys_are_revalidated_after_start_navigation,
    )
    r.record(
        "passkeys_revalidated_before_each_usage_readback",
        test_passkeys_are_revalidated_before_each_usage_readback,
    )
    await r.record_async(
        "provider_handoff_replaces_humanizer",
        test_provider_handoff_replaces_humanizer_without_leaking_idle_work,
    )
    await r.record_async(
        "provider_handoff_closes_disabled_humanizer",
        test_provider_handoff_closes_humanizer_even_when_disabled,
    )
    await r.record_async(
        "failed_replacement_stack_cleanup",
        test_failed_replacement_stack_cleanup_keeps_remote_session_open,
    )
    await r.record_async(
        "provider_reconnect_partial_stack_cleanup",
        test_provider_reconnect_cleans_partial_new_stack_on_focus_failure,
    )
    await r.record_async(
        "rotation_storage_state_real_browser_round_trip",
        test_rotation_storage_state_round_trips_in_real_browser,
    )
    r.record(
        "rotation_session_metadata_provider_switch",
        test_rotation_session_metadata_tracks_provider_switch,
    )
    r.record(
        "challenge_recovery_stream_tool_id",
        test_challenge_recovery_reuses_one_tool_call_id_for_every_stage,
    )
    await r.record_async(
        "playwright_page_tracks_browser_use_tab_focus",
        test_playwright_page_tracks_browser_use_tab_focus,
    )
    await r.record_async(
        "browser_agent_yields_for_user_control",
        test_browser_agent_yields_until_user_hands_control_back,
    )
    await r.record_async("fetch_auth_options_success", test_fetch_auth_options_success)
    await r.record_async("fetch_auth_options_error", test_fetch_auth_options_error_raises)
    await r.record_async(
        "mark_steel_session_auth_failed",
        test_mark_steel_session_auth_failed_posts_reason,
    )
    await r.record_async(
        "create_auth_assistance_request",
        test_create_user_auth_assistance_request_posts_payload,
    )
    await r.record_async("close_browser_session_swallows", test_close_browser_session_swallows_errors)
    await r.record_async("close_browser_session_success", test_close_browser_session_success_payload)
    await r.record_async("inject_local_storage_success", test_inject_local_storage_success)
    await r.record_async("inject_local_storage_non_200", test_inject_local_storage_non_200_returns_none)
    await r.record_async(
        "inject_local_storage_network",
        test_inject_local_storage_network_error_returns_none,
    )
    await r.record_async("upload_file_session_success", test_upload_file_to_session_success)
    await r.record_async(
        "upload_file_session_downloads_directory",
        test_upload_file_to_session_downloads_directory,
    )
    await r.record_async("upload_file_session_non_200", test_upload_file_to_session_non_200_returns_none)
    await r.record_async("upload_file_session_network", test_upload_file_to_session_network_error)

    await r.record_async("call_extract_llm_success", test_call_extract_llm_success)
    await r.record_async("call_extract_llm_non_200", test_call_extract_llm_non_200)
    await r.record_async("call_extract_llm_network", test_call_extract_llm_network_error)
    await r.record_async("call_extract_llm_truncates", test_call_extract_llm_truncates_long_content)

    await r.record_async("fetch_recent_emails_success", test_fetch_recent_emails_success)
    await r.record_async("fetch_recent_emails_404", test_fetch_recent_emails_404)
    await r.record_async("fetch_recent_emails_5xx", test_fetch_recent_emails_5xx)
    await r.record_async("fetch_recent_emails_network", test_fetch_recent_emails_network_error)

    # service
    r.record("safe_time_returns_float", test_safe_time_returns_float)
    r.record("safe_time_swallows_errors", test_safe_time_swallows_errors)
    r.record("build_context_summary_success", test_build_context_summary_success_with_urls)
    r.record("build_context_summary_failure", test_build_context_summary_failure_with_error)
    r.record("build_context_summary_trims_lists", test_build_context_summary_trims_lists)
    r.record("build_usage_items", test_build_usage_items)
    r.record(
        "build_usage_items_carries_browser_pool_model",
        test_build_usage_items_carries_browser_pool_model,
    )
    r.record(
        "build_usage_items_emits_one_row_per_actual_model",
        test_build_usage_items_emits_one_row_per_actual_model,
    )
    r.record(
        "build_usage_items_unattributed_fall_back_to_browser_pool",
        test_build_usage_items_unattributed_tokens_fall_back_to_browser_pool,
    )
    r.record(
        "browser_usage_rows_never_leak_the_internal_fast_cache_marker",
        test_browser_usage_rows_never_leak_the_internal_fast_cache_marker,
    )
    r.record(
        "browser_usage_rows_carry_cache_metadata_for_the_workflow_discount",
        test_browser_usage_rows_carry_cache_metadata_for_the_workflow_discount,
    )
    r.record(
        "real_browser_path_attributes_every_token_to_its_actual_model",
        test_real_browser_path_attributes_every_token_to_its_actual_model,
    )
    r.record(
        "get_browser_system_prompt_with_files",
        test_get_browser_system_prompt_with_files,
    )
    r.record(
        "get_browser_system_prompt_no_files",
        test_get_browser_system_prompt_without_files,
    )
    r.record(
        "get_browser_system_prompt_is_static",
        test_get_browser_system_prompt_is_static_across_calls,
    )
    r.record("build_action_titles_click_element", test_build_action_titles_click_with_element)
    r.record("build_action_titles_click_coords", test_build_action_titles_click_with_coords)
    r.record("build_action_titles_click_none", test_build_action_titles_click_with_nothing)
    r.record(
        "build_action_titles_input_secret",
        test_build_action_titles_input_text_secret_redacted,
    )
    r.record(
        "build_action_titles_input_coords",
        test_build_action_titles_input_text_with_coords_plain_text,
    )
    r.record(
        "build_action_titles_input_no_target",
        test_build_action_titles_input_text_no_target,
    )
    r.record("build_action_titles_goto", test_build_action_titles_goto)
    r.record("build_action_titles_scroll", test_build_action_titles_scroll)
    r.record(
        "build_action_titles_press_key_extract",
        test_build_action_titles_press_key_and_extract,
    )
    r.record(
        "build_action_titles_wait_select_upload_ss",
        test_build_action_titles_wait_select_upload_screenshot,
    )
    r.record("build_action_titles_auth_actions", test_build_action_titles_auth_actions)
    r.record("build_action_titles_unknown", test_build_action_titles_unknown_action)

    await r.record_async("extract_session_files_none", test_extract_session_files_no_files)
    await r.record_async("extract_session_files_happy", test_extract_session_files_happy_path)
    await r.record_async("extract_session_files_excludes", test_extract_session_files_exclude_paths)
    await r.record_async(
        "extract_session_files_download_fail",
        test_extract_session_files_download_fail_skipped,
    )
    await r.record_async(
        "extract_session_files_upload_fail",
        test_extract_session_files_upload_failure_skipped,
    )

    # service_actions statics
    r.record("get_domain_from_url", test_get_domain_from_url_variants)
    r.record("get_base_domain", test_get_base_domain)
    r.record("is_approval_valid_none", test_is_approval_valid_no_approvals)
    r.record("is_approval_valid_missing_fields", test_is_approval_valid_missing_fields)
    r.record("is_approval_valid_domain_mismatch", test_is_approval_valid_domain_mismatch)
    r.record("is_approval_valid_fresh", test_is_approval_valid_still_fresh)
    r.record("is_approval_valid_expired", test_is_approval_valid_expired)
    r.record(
        "site_write_lock_unlock_covers_purchase",
        test_site_write_lock_unlock_covers_purchase_on_approved_domain,
    )
    r.record(
        "payment_site_unlock_covers_subdomains_and_ignores_path_query",
        test_payment_site_unlock_covers_subdomains_and_ignores_path_query,
    )
    r.record(
        "payment_site_unlock_survives_write_lock_timeout",
        test_payment_site_unlock_survives_write_lock_timeout,
    )
    r.record(
        "fresh_browser_session_no_site_unlock_inherit",
        test_fresh_browser_session_does_not_inherit_site_write_lock_unlock,
    )
    r.record(
        "site_write_lock_grant_prefers_merchant_over_kernel_proxy",
        test_site_write_lock_grant_prefers_merchant_url_over_kernel_proxy_current_url,
    )
    await r.record_async(
        "purchase_write_lock_bypassed_when_payment_card_secret_refs_present",
        test_purchase_write_lock_bypassed_when_payment_card_secret_refs_present,
    )
    r.record("get_element_description_none", test_get_element_description_none)
    r.record("get_element_description_text", test_get_element_description_with_text)
    r.record(
        "get_element_description_placeholder",
        test_get_element_description_with_placeholder,
    )
    r.record("get_element_description_aria", test_get_element_description_with_aria_label)
    r.record("get_element_description_name", test_get_element_description_with_name_attr)
    r.record("get_element_description_id", test_get_element_description_with_id)
    r.record("get_element_description_input_type", test_get_element_description_input_type)
    r.record("get_element_description_nothing", test_get_element_description_nothing)
    r.record(
        "get_element_description_text_error",
        test_get_element_description_text_extraction_error,
    )

    await r.record_async("move_visual_cursor_no_session", test_move_visual_cursor_no_session_safe)
    await r.record_async("move_visual_cursor_exception", test_move_visual_cursor_exception_safe)

    await r.record_async("execute_action_no_session", test_execute_action_no_session)
    await r.record_async("execute_action_element_not_found", test_execute_action_element_not_found)
    await r.record_async("execute_action_unknown", test_execute_action_unknown_action)
    r.record("read_network_requests_advertised", test_read_network_requests_tool_is_advertised)
    r.record(
        "captured_request_body_redaction",
        test_captured_request_bodies_are_redacted_truncated_by_bytes_and_omission_tagged,
    )
    r.record(
        "humanized_click_cdp_press_release", test_humanized_click_presses_and_releases_via_cdp_without_post_click_move
    )
    r.record("network_recorder_query_requests", test_network_recorder_query_requests_filters_and_shapes)
    r.record("network_recorder_updates_at_capacity", test_network_recorder_updates_status_at_capacity)
    r.record("network_recorder_full_detail", test_network_recorder_captures_every_resource_and_full_detail)
    r.record("network_recorder_body_cache_bounded", test_network_recorder_body_cache_is_byte_bounded)
    r.record(
        "network_recorder_request_body_byte_truncation",
        test_network_recorder_request_body_truncates_on_bytes_not_chars,
    )
    r.record(
        "network_recorder_redirect_location_casing",
        test_network_recorder_redirect_location_survives_header_casing,
    )
    await r.record_async(
        "network_recorder_terminal_requests_bounded",
        test_network_recorder_terminal_requests_do_not_accumulate_after_clear,
    )
    await r.record_async(
        "network_recorder_fingerprint_exit_rejection",
        test_network_recorder_emits_one_explicit_fingerprint_exit_rejection_per_browser,
    )
    await r.record_async(
        "network_recorder_accepted_fingerprint_warning",
        test_network_recorder_does_not_reject_successful_fingerprint_warning,
    )
    r.record(
        "api_challenge_html_large_cart_interstitial",
        test_api_challenge_html_large_cart_interstitial_without_classic_markers,
    )
    await r.record_async(
        "api_challenge_html_provider_exit",
        test_api_challenge_html_triggers_provider_exit_rejection,
    )
    r.record(
        "payment_cdn_tunnel_failure_provider_exit",
        test_payment_cdn_tunnel_failure_triggers_provider_exit_rejection,
    )
    r.record(
        "evicted_critical_request_meta_provider_exit",
        test_evicted_critical_request_meta_still_rejects_network_generation,
    )
    await r.record_async(
        "provider_exit_monitor_without_recording",
        test_provider_exit_monitor_runs_without_production_body_log_persistence,
    )
    await r.record_async("execute_action_read_network_requests", test_execute_action_read_network_requests)
    await r.record_async(
        "execute_action_request_payment_card",
        test_execute_action_request_payment_card_requests_workflow_approval,
    )
    await r.record_async(
        "execute_action_request_payment_card_rejects_empty_receipt",
        test_execute_action_request_payment_card_rejects_empty_receipt,
    )
    await r.record_async(
        "execute_action_request_payment_card_accepts_current_session_link",
        test_execute_action_request_payment_card_accepts_current_session_product_link,
    )
    await r.record_async(
        "execute_action_request_payment_card_rejects_duplicate_after_card_ready",
        test_execute_action_request_payment_card_rejects_duplicate_after_card_ready,
    )
    await r.record_async("execute_action_dropdown_options_no_el", test_execute_action_dropdown_options_missing_element)
    await r.record_async("execute_action_select_dropdown_no_el", test_execute_action_select_dropdown_missing_element)
    await r.record_async("execute_action_attempt_completion", test_execute_action_attempt_completion)
    await r.record_async("execute_action_send_message", test_execute_action_send_message_to_user)
    await r.record_async("execute_action_done", test_execute_action_done)
    await r.record_async("execute_action_click_no_target", test_execute_action_click_no_element_no_coords)
    await r.record_async(
        "execute_action_upload_missing_file",
        test_execute_action_upload_file_missing_filename,
    )
    await r.record_async(
        "execute_action_upload_not_in_avail",
        test_execute_action_upload_file_not_in_available,
    )
    await r.record_async("execute_action_switch_tab_no_id", test_execute_action_switch_tab_missing_id)
    await r.record_async(
        "execute_action_press_key_humanizer",
        test_execute_action_press_key_with_humanizer,
    )
    await r.record_async(
        "execute_action_scroll_humanizer_down",
        test_execute_action_scroll_with_humanizer_down,
    )
    await r.record_async(
        "execute_action_scroll_humanizer_up",
        test_execute_action_scroll_with_humanizer_up,
    )
    await r.record_async("execute_action_extract_disabled", test_execute_action_extract_disabled)
    await r.record_async("execute_action_goto_delegates", test_execute_action_goto_delegates)
    await r.record_async("execute_action_click_delegates", test_execute_action_click_delegates)
    await r.record_async("execute_action_input_text_delegates", test_execute_action_input_text_delegates)
    await r.record_async("execute_action_screenshot", test_execute_action_screenshot_returns_success)
    await r.record_async("execute_action_exception_catches", test_execute_action_exception_catches)

    # service_actions: extended _execute_* + fallback paths
    await r.record_async(
        "execute_action_press_key_no_humanizer",
        test_execute_action_press_key_no_humanizer,
    )
    await r.record_async(
        "execute_action_scroll_no_humanizer_up",
        test_execute_action_scroll_no_humanizer_up,
    )
    await r.record_async("execute_action_navback", test_execute_action_navback)
    await r.record_async("execute_action_wait", test_execute_action_wait)
    await r.record_async(
        "execute_action_wait_coerces_numeric_string",
        test_execute_action_wait_coerces_numeric_string,
    )
    await r.record_async(
        "execute_action_wait_rejects_invalid_and_clamps_huge",
        test_execute_action_wait_rejects_invalid_and_clamps_huge_values,
    )
    await r.record_async(
        "execute_action_dropdown_options_with_el",
        test_execute_action_dropdown_options_with_element,
    )
    await r.record_async(
        "execute_action_select_dropdown_with_el",
        test_execute_action_select_dropdown_with_element,
    )
    await r.record_async("execute_action_evaluate", test_execute_action_evaluate)
    await r.record_async("execute_action_open_new_tab", test_execute_action_open_new_tab)
    await r.record_async("execute_action_close_tab_focused", test_execute_action_close_tab_via_focused)
    await r.record_async("execute_action_close_tab_no_focused", test_execute_action_close_tab_no_focused)
    await r.record_async("execute_action_close_tab_id_found", test_execute_action_close_tab_with_id_found)
    await r.record_async(
        "execute_action_close_tab_id_notfound",
        test_execute_action_close_tab_with_id_not_found,
    )
    await r.record_async("execute_action_switch_tab_found", test_execute_action_switch_tab_found)
    await r.record_async("execute_action_switch_tab_notfound", test_execute_action_switch_tab_not_found)

    await r.record_async(
        "dom_service_element_coordinates_viewport_rect",
        test_dom_service_element_coordinates_use_visible_viewport_rect,
    )
    await r.record_async(
        "dom_service_hidden_checkbox_coordinates_associated_label",
        test_dom_service_hidden_checkbox_coordinates_use_visible_associated_label,
    )
    await r.record_async(
        "dom_service_hidden_checkbox_label_coordinates_real_cdp",
        test_dom_service_hidden_checkbox_label_coordinates_in_real_cdp,
    )
    await r.record_async(
        "dom_service_opacity_hidden_checkbox_nonempty_rect_uses_label",
        test_dom_service_opacity_hidden_checkbox_with_nonempty_rect_uses_label,
    )
    await r.record_async(
        "dom_service_disconnect_stops_session",
        test_dom_service_disconnect_stops_browser_session_without_killing_remote_browser,
    )
    r.record(
        "browser_downloads_path_for_provider",
        test_browser_downloads_path_for_provider_kernel_vs_steel,
    )
    r.record(
        "attachment_download_tinypng_vs_ad_script",
        test_is_browser_attachment_download_tinypng_vs_ad_script,
    )
    await r.record_async(
        "persist_bytes_to_session_downloads",
        test_persist_bytes_to_session_downloads_uploads_under_tmp_downloads,
    )
    await r.record_async(
        "browser_download_persister_cdp_attachment",
        test_browser_download_persister_captures_attachment_via_cdp_body,
    )
    r.record(
        "dom_service_defaults_downloads_path_from_env",
        test_dom_service_defaults_downloads_path_from_browser_provider_env,
    )
    r.record(
        "browser_activity_memory_cleanup_clears_buffers",
        test_browser_activity_memory_cleanup_clears_retained_buffers,
    )
    await r.record_async("execute_click_element_humanizer", test_execute_click_with_element_humanizer)
    await r.record_async(
        "execute_click_element_humanizer_missing_coords",
        test_execute_click_with_element_humanizer_missing_coords_refuses_fallback,
    )
    await r.record_async(
        "execute_click_element_humanizer_refreshes_stale_coordinates",
        test_execute_click_with_element_humanizer_refreshes_stale_coordinates,
    )
    await r.record_async("execute_click_coords_no_humanizer", test_execute_click_with_coords_no_humanizer)
    await r.record_async("execute_click_no_target", test_execute_click_no_element_no_coords)
    await r.record_async(
        "execute_click_write_lock_purchase",
        test_execute_click_write_lock_purchase_triggers_approval,
    )
    await r.record_async(
        "execute_click_write_lock_return_confirmation",
        test_execute_click_write_lock_return_confirmation_triggers_approval,
    )
    await r.record_async(
        "execute_click_write_lock_shadow_input_ancestor_text",
        test_execute_click_write_lock_uses_nearest_ancestor_text_for_shadow_input,
    )
    r.record(
        "element_write_lock_signal_nearest_bounded_ancestor_text",
        test_element_write_lock_signal_stops_after_nearest_bounded_ancestor_text,
    )
    r.record(
        "write_lock_purchase_button_order_controls",
        test_write_lock_purchase_button_detects_order_controls,
    )
    r.record(
        "write_lock_purchase_button_excludes_terms_consent_prose",
        test_write_lock_purchase_button_excludes_terms_consent_prose,
    )
    r.record(
        "write_lock_email_send_excludes_marketing_opt_in_controls",
        test_write_lock_email_send_excludes_marketing_opt_in_controls,
    )
    r.record(
        "write_lock_email_send_excludes_resend_controls",
        test_write_lock_email_send_excludes_resend_controls,
    )
    r.record(
        "write_lock_social_domain_excludes_auth_flow_urls",
        test_write_lock_social_domain_excludes_auth_flow_urls,
    )
    r.record(
        "write_lock_submit_button_excludes_auth_navigation_controls",
        test_write_lock_submit_button_excludes_auth_navigation_controls,
    )
    await r.record_async(
        "write_lock_payment_field_missing_page_accessor_fails_closed",
        test_write_lock_payment_field_missing_page_accessor_fails_closed,
    )
    await r.record_async(
        "execute_click_write_lock_social",
        test_execute_click_write_lock_social_triggers_approval,
    )
    await r.record_async(
        "execute_click_write_lock_social_auth_url",
        test_execute_click_write_lock_social_auth_url_does_not_trigger_approval,
    )
    await r.record_async(
        "execute_click_write_lock_social_auth_button_root",
        test_execute_click_write_lock_social_auth_button_on_root_does_not_trigger_approval,
    )
    await r.record_async(
        "execute_click_write_lock_email",
        test_execute_click_write_lock_email_send_triggers_approval,
    )
    await r.record_async("execute_click_coord_write_lock", test_execute_click_coord_write_lock_purchase)
    await r.record_async(
        "execute_press_key_send_shortcut_no_email_approval",
        test_execute_press_key_send_shortcut_does_not_trigger_email_approval,
    )

    await r.record_async(
        "execute_input_text_el_humanizer",
        test_execute_input_text_element_with_humanizer,
    )
    await r.record_async(
        "is_payment_field_dom_attributes_without_get_page",
        test_is_payment_field_uses_dom_attributes_without_get_page,
    )
    await r.record_async(
        "execute_input_text_el_humanizer_refreshes_dom",
        test_execute_input_text_element_humanizer_refreshes_dom_when_coords_missing,
    )
    await r.record_async(
        "execute_input_text_el_humanizer_missing_coords",
        test_execute_input_text_element_humanizer_missing_coords_refuses_typetext_fallback,
    )
    await r.record_async(
        "execute_input_text_payment_secret_ref_bypasses_warning",
        test_execute_input_text_payment_secret_ref_bypasses_payment_warning,
    )
    await r.record_async(
        "execute_input_text_payment_secret_ref_direct_fill",
        test_execute_input_text_payment_secret_ref_direct_fill_sets_exact_value,
    )
    await r.record_async(
        "execute_input_text_payment_secret_ref_direct_fill_waits_for_ready",
        test_execute_input_text_payment_secret_ref_waits_for_page_ready_before_retry,
    )
    await r.record_async(
        "execute_input_text_payment_secret_ref_direct_fill_cdp",
        test_execute_input_text_payment_secret_ref_direct_fill_uses_cdp_without_page,
    )
    await r.record_async(
        "fill_payment_ref_directly_searches_playwright_frames",
        test_fill_payment_ref_directly_searches_playwright_frames,
    )
    await r.record_async(
        "fill_payment_ref_directly_uses_keyboard_when_js_value_rejected",
        test_fill_payment_ref_directly_uses_keyboard_when_js_value_rejected,
    )
    await r.record_async(
        "fill_payment_ref_directly_uses_cdp_iframe_targets",
        test_fill_payment_ref_directly_uses_cdp_iframe_targets,
    )
    await r.record_async(
        "fill_payment_ref_directly_real_child_frame_fixture",
        test_fill_payment_ref_directly_real_child_frame_fixture,
    )
    await r.record_async(
        "fill_payment_ref_finder_accepts_collapsed_autocomplete_inputs",
        test_fill_payment_ref_finder_accepts_collapsed_autocomplete_inputs,
    )
    await r.record_async(
        "fill_payment_ref_finder_accepts_collapsed_stable_field_name_inputs",
        test_fill_payment_ref_finder_accepts_collapsed_stable_field_name_inputs,
    )
    await r.record_async(
        "fill_payment_ref_via_playwright_label_when_no_autocomplete",
        test_fill_payment_ref_via_playwright_label_when_no_autocomplete,
    )
    await r.record_async(
        "fill_payment_ref_via_titled_payment_iframe",
        test_fill_payment_ref_via_titled_payment_iframe,
    )
    await r.record_async(
        "execute_input_text_payment_secret_ref_fail_closed_without_target",
        test_execute_input_text_payment_secret_ref_fail_closed_without_target,
    )
    await r.record_async(
        "fill_payment_ref_via_keyboard_types_after_cdp_focus",
        test_fill_payment_ref_via_keyboard_types_after_cdp_focus,
    )
    await r.record_async(
        "execute_input_text_payment_secret_ref_selector_recovery",
        test_execute_input_text_payment_secret_ref_recovers_dead_backend_node_with_selector,
    )
    await r.record_async("execute_input_text_secret_redacts", test_execute_input_text_secret_redacts)
    await r.record_async(
        "execute_input_text_credential_ref",
        test_execute_input_text_secret_returns_credential_ref,
    )
    await r.record_async(
        "execute_input_text_payment_approval",
        test_execute_input_text_payment_triggers_approval,
    )
    await r.record_async("execute_input_text_coords_no_hum", test_execute_input_text_coords_no_humanizer)
    await r.record_async(
        "execute_input_text_clear_false",
        test_execute_input_text_clear_false_does_not_clear,
    )
    await r.record_async(
        "execute_input_text_no_target_hum",
        test_execute_input_text_no_element_no_coords_humanizer,
    )

    await r.record_async("execute_goto_auto_https", test_execute_goto_auto_adds_https)
    await r.record_async(
        "execute_goto_err_aborted_persists_download",
        test_execute_goto_err_aborted_persists_attachment_download,
    )
    await r.record_async("live_tab_looks_challenged", test_live_tab_looks_challenged_helpers)
    r.record("api_surface_and_nav_pin", test_url_looks_like_api_surface_and_navigation_pin)
    await r.record_async("goto_refuses_api_surface", test_execute_goto_refuses_api_surface_urls)
    await r.record_async("navback_refuses_pinned_host", test_execute_navback_refuses_when_host_pinned)
    await r.record_async(
        "navback_refuses_cross_origin_handoff",
        test_execute_navback_refuses_on_cross_origin_handoff,
    )
    await r.record_async(
        "close_tab_refuses_cross_origin_handoff",
        test_execute_close_tab_refuses_on_cross_origin_handoff,
    )
    await r.record_async(
        "evaluate_refuses_nav_while_pinned",
        test_execute_evaluate_refuses_navigation_while_pinned,
    )
    await r.record_async(
        "press_key_click_refuse_leave_while_pinned",
        test_execute_press_key_and_click_refuse_leave_while_pinned,
    )
    r.record("handoff_pin_sticky_in_handler", test_handoff_pin_is_sticky_in_handler)
    r.record(
        "nav_guard_no_endpoint_path_allowlists",
        test_navigation_guard_has_no_endpoint_path_allowlists,
    )
    r.record(
        "recovery_skips_clean_live_tab",
        test_recovery_skips_when_live_tab_already_clear,
    )
    await r.record_async("execute_goto_injects_ls", test_execute_goto_injects_local_storage)
    await r.record_async(
        "execute_goto_injects_ls_error",
        test_execute_goto_injects_local_storage_swallows_error,
    )
    await r.record_async(
        "navigation_ready_reloads_blank_spa",
        test_wait_for_navigation_ready_reloads_blank_spa_shell_once,
    )
    await r.record_async(
        "navigation_ready_regotos_loading_doc",
        test_wait_for_navigation_ready_regotos_stuck_loading_document_once,
    )

    await r.record_async("execute_extract_disabled", test_execute_extract_disabled)

    await r.record_async("execute_upload_file_success", test_execute_upload_file_success)
    await r.record_async("execute_upload_file_no_element", test_execute_upload_file_missing_element)
    await r.record_async("execute_upload_file_not_file_input", test_execute_upload_file_not_file_input)

    await r.record_async("execute_switch_tab_success", test_execute_switch_tab_success)
    await r.record_async("execute_switch_tab_no_id", test_execute_switch_tab_missing_id)
    await r.record_async("execute_close_tab_explicit_id", test_execute_close_tab_with_explicit_id)

    await r.record_async("execute_screenshot_success", test_execute_screenshot_success)
    await r.record_async(
        "execute_screenshot_requires_steel_image",
        test_execute_screenshot_requires_steel_image,
    )

    await r.record_async("move_visual_cursor_success", test_move_visual_cursor_success)
    await r.record_async(
        "browser_agent_recording_writes_html",
        test_browser_agent_recording_writes_local_html_replay,
    )
    r.record(
        "browser_agent_recording_inline_export_source_frames",
        test_browser_agent_recording_inline_export_uses_source_frames_once,
    )
    r.record(
        "browser_agent_recording_live_steel_api_origin",
        test_browser_agent_recording_uses_live_steel_api_origin,
    )
    r.record(
        "simulated_browser_recording_player_javascript",
        test_simulated_browser_recording_player_script_is_valid_javascript,
    )
    await r.record_async(
        "browser_agent_recording_active_tab_url",
        test_browser_agent_recording_captures_visible_active_tab_url,
    )
    await r.record_async(
        "browser_agent_recording_disabled_env",
        test_browser_agent_recording_respects_disabled_env,
    )
    await r.record_async(
        "browser_session_metadata_published_without_recording",
        test_browser_session_metadata_is_published_when_recording_is_disabled,
    )
    await r.record_async(
        "browser_session_metadata_failure_is_fail_closed",
        test_browser_session_metadata_failure_is_fail_closed,
    )
    await r.record_async(
        "browser_session_metadata_rejects_missing_provider",
        test_browser_session_metadata_rejects_missing_provider_before_publication,
    )
    await r.record_async(
        "browser_agent_recording_start_failure_best_effort",
        test_browser_agent_recording_start_failure_is_best_effort,
    )
    await r.record_async(
        "browser_agent_kernel_replay_follows_rotation",
        test_browser_agent_kernel_replay_follows_rotation,
    )
    await r.record_async(
        "browser_agent_recording_survives_kernel_to_steel_recovery",
        test_browser_agent_recording_survives_kernel_to_steel_recovery,
    )
    await r.record_async(
        "browser_agent_recording_rebinds_screenshot_mode_across_providers",
        test_browser_agent_recording_rebinds_screenshot_mode_across_providers,
    )
    await r.record_async(
        "browser_agent_hybrid_player_advances_all_segments_and_rebases_time",
        test_browser_agent_hybrid_player_advances_all_segments_and_rebases_time,
    )
    await r.record_async(
        "browser_agent_kernel_replay_uses_native_recording",
        test_browser_agent_kernel_replay_uses_native_recording,
    )
    await r.record_async(
        "browser_agent_kernel_replay_start_failure_yields_no_recording",
        test_browser_agent_kernel_replay_start_failure_yields_no_recording,
    )
    r.record(
        "browser_agent_recording_prod_temp_root",
        test_browser_agent_recording_prod_default_uses_writable_temp_root,
    )
    r.record(
        "browser_agent_recording_fly_prod_temp_root",
        test_browser_agent_recording_fly_prod_default_uses_writable_temp_root,
    )
    r.record(
        "browser_agent_recording_prod_cleanup",
        test_browser_agent_recording_prod_cleanup_removes_task_scratch,
    )
    await r.record_async(
        "browser_agent_recording_prod_trace_archive",
        test_browser_agent_recording_enabled_by_trace_archive_in_prod,
    )
    r.record(
        "browser_agent_recording_video_rate_replay",
        test_browser_agent_recording_supports_video_rate_replay,
    )
    r.record(
        "browser_agent_recording_steel_video_player",
        test_browser_agent_recording_steel_video_player_uses_debug_recording_and_window_offsets,
    )
    await r.record_async(
        "browser_recording_finalizer_cancel_resilient",
        test_browser_recording_finalizer_uploads_frame_replay_after_cancellation,
    )
    await r.record_async(
        "browser_recording_finalizer_persists_before_trace_archive",
        test_browser_recording_finalizer_persists_before_trace_archive,
    )
    await r.record_async(
        "browser_recording_background_archive_responsive",
        test_browser_recording_background_archive_keeps_event_loop_responsive,
    )
    await r.record_async(
        "browser_recording_finalizer_keeps_local_artifacts_when_upload_fails",
        test_browser_recording_finalizer_keeps_local_artifacts_when_upload_fails,
    )
    await r.record_async(
        "browser_diagnostics_finalizer_attaches_pointer",
        test_browser_diagnostics_finalizer_uploads_and_attaches_durable_pointer,
    )
    await r.record_async(
        "browser_cleanup_scheduler_nonblocking",
        test_browser_cleanup_scheduler_does_not_block_on_recording_finalization,
    )
    await r.record_async(
        "drain_background_browser_cleanups",
        test_drain_background_browser_cleanups_waits_then_times_out,
    )
    r.record(
        "browser_humanizer_visual_cursor_default_off",
        test_browser_humanizer_visual_cursor_defaults_off_but_keeps_cursor_observer,
    )
    r.record(
        "mouse_input_synthesis_path",
        test_mouse_input_synthesis_generates_bounded_non_linear_path,
    )
    r.record(
        "mouse_input_synthesis_velocity_guard",
        test_mouse_input_synthesis_rejects_unrealistic_sample_jumps,
    )
    r.record("idle_mouse_drift", test_idle_mouse_drift_stays_near_anchor_and_inside_viewport)
    r.record(
        "mouse_click_synthesis_duration",
        test_mouse_click_synthesis_uses_paper_duration_distribution,
    )
    r.record(
        "keycap_input_synthesis_timing",
        test_keycap_input_synthesis_generates_variable_key_timings,
    )
    r.record(
        "keycap_input_synthesis_rng_isolation",
        test_keycap_input_synthesis_rng_isolated_from_global_numpy_state,
    )
    r.record(
        "keycap_controller_generate_n_injected_rng",
        test_keycap_controller_generate_n_uses_injected_rng,
    )
    await r.record_async(
        "browser_humanizer_click_synthesis",
        test_browser_humanizer_click_uses_synthesized_mouse_and_cursor_updates,
    )
    await r.record_async(
        "click_press_has_no_round_trip_inside_hold",
        test_click_press_holds_no_remote_round_trip_between_down_and_up,
    )
    await r.record_async(
        "browser_humanizer_cursor_observer_after_overlay",
        test_browser_humanizer_cursor_observer_runs_after_visual_cursor_update,
    )
    await r.record_async(
        "browser_humanizer_cdp_mouse_transport_full_path",
        test_browser_humanizer_cdp_mouse_transport_queues_full_path_before_drain,
    )
    await r.record_async(
        "browser_humanizer_cdp_mouse_drain_timeout",
        test_browser_humanizer_cdp_mouse_drain_timeout_uses_fallback,
    )
    await r.record_async(
        "browser_humanizer_idle_movement",
        test_browser_humanizer_idle_movement_forwards_to_cdp_and_observer,
    )
    await r.record_async(
        "browser_humanizer_keyboard_synthesis",
        test_browser_humanizer_keyboard_uses_keycap_timing_for_text_and_shortcuts,
    )
    await r.record_async(
        "browser_humanizer_cdp_keyboard_transport",
        test_browser_humanizer_cdp_keyboard_transport_queues_text_before_drain,
    )
    await r.record_async(
        "browser_humanizer_cdp_keyboard_drain_timeout",
        test_browser_humanizer_cdp_keyboard_drain_timeout_is_bounded,
    )
    await r.record_async(
        "browser_humanizer_cdp_session_initialization",
        test_browser_humanizer_cdp_session_initialization_is_serialized,
    )
    await r.record_async(
        "browser_humanizer_cdp_send_failure_fallback",
        test_browser_humanizer_cdp_send_failure_enables_keyboard_fallback,
    )
    await r.record_async(
        "browser_humanizer_cdp_mouse_path_failure_fallback",
        test_browser_humanizer_cdp_mouse_path_failure_enables_fallback,
    )
    await r.record_async(
        "browser_humanizer_cdp_idle_mouse_failure_fallback",
        test_browser_humanizer_cdp_idle_mouse_failure_enables_fallback,
    )
    await r.record_async(
        "browser_network_recording_captures_body",
        test_browser_network_recording_captures_response_body,
    )
    await r.record_async(
        "browser_diagnostics_console_network_bundle",
        test_browser_diagnostics_capture_console_and_redacted_network_metadata,
    )

    # handler statics
    r.record("claude_token_state_defaults", test_claude_token_state_defaults)
    r.record("claude_token_state_mutation", test_claude_token_state_mutation)
    r.record(
        "render_write_lock_notification_purchase",
        test_render_write_lock_notification_question_uses_purchase_metadata,
    )
    r.record(
        "normalize_write_lock_notification_media_item_image",
        test_normalize_write_lock_notification_media_promotes_item_image,
    )
    await r.record_async(
        "generate_write_lock_notification_payment_forks",
        test_generate_write_lock_notification_payment_forks_and_renders_question,
    )
    await r.record_async(
        "generate_write_lock_notification_wrong_tool_raises",
        test_generate_write_lock_notification_raises_when_fork_calls_wrong_tool,
    )
    r.record(
        "extract_media_candidates_from_dom_state",
        test_extract_media_candidates_from_dom_state_keeps_image_urls_outside_llm_dom_text,
    )
    r.record(
        "extract_media_candidates_prefers_product_jpeg",
        test_extract_media_candidates_prefers_checkout_product_jpeg_over_small_art,
    )
    r.record(
        "write_lock_notification_prompt_media_candidates",
        test_write_lock_notification_prompt_includes_media_candidates,
    )
    r.record(
        "purchase_write_lock_notification_failure_blocks_fallback",
        test_purchase_write_lock_notification_failure_blocks_approval_fallback,
    )
    r.record(
        "normalize_write_lock_notification_media_candidate",
        test_normalize_write_lock_notification_media_uses_matching_media_candidate,
    )
    r.record(
        "normalize_write_lock_notification_media_product_jpeg",
        test_normalize_write_lock_notification_media_prefers_product_jpeg_without_text_match,
    )
    r.record(
        "normalize_write_lock_notification_media_screenshot",
        test_normalize_write_lock_notification_media_uses_checkout_screenshot,
    )
    r.record(
        "botsigged_diagnostics_enabled",
        test_botsigged_diagnostics_enabled_requires_flag_and_domain,
    )
    await r.record_async("capture_botsigged_diagnostics", test_capture_botsigged_diagnostics_writes_json)
    await r.record_async(
        "stop_playwright_resources",
        test_stop_playwright_resources_closes_browser_and_stops_instance,
    )
    r.record(
        "disable_cdp_websocket_proxy",
        test_disable_cdp_websocket_proxy_sets_default_proxy_none,
    )
    await r.record_async(
        "stop_playwright_resources_reaps_driver_process",
        test_stop_playwright_resources_reaps_lingering_driver_process,
    )
    await r.record_async(
        "stop_playwright_resources_close_fails",
        test_stop_playwright_resources_stops_instance_when_browser_close_fails,
    )
    await r.record_async(
        "stop_playwright_resources_leave_live_browser_open",
        test_stop_playwright_resources_can_leave_live_browser_open,
    )
    await r.record_async(
        "append_new_otp_user_messages",
        test_append_new_otp_user_messages_dedupes_and_logs,
    )
    await r.record_async(
        "append_new_otp_user_messages_requires_email_credential_id",
        test_append_new_otp_user_messages_requires_email_credential_id_for_ref,
    )
    await r.record_async(
        "append_new_otp_user_messages_skips_stale",
        test_append_new_otp_user_messages_skips_stale_codes,
    )
    await r.record_async("call_browser_use_gpt_auth", test_call_browser_use_with_rotation_uses_gpt_auth)
    r.record(
        "browser_prompt_cache_namespace_stable_and_isolated",
        test_browser_prompt_cache_namespace_is_stable_and_isolated,
    )
    await r.record_async(
        "browser_thinking_stream_routes_chunks",
        test_browser_thinking_stream_routes_chunks_to_browser_message_list,
    )
    await r.record_async(
        "browser_streaming_rose_client_forwards_chunks",
        test_browser_streaming_rose_client_forwards_and_folds_chunks,
    )
    await r.record_async(
        "call_browser_use_rotates_claude",
        test_call_browser_use_with_rotation_rotates_claude_token,
    )
    await r.record_async(
        "call_browser_use_no_replacement",
        test_call_browser_use_with_rotation_stops_when_no_replacement,
    )
    r.record("get_manager_singleton", test_get_manager_singleton)
    await r.record_async("activity_requires_schema", test_spawn_browser_activity_requires_output_schema)
    await r.record_async(
        "activity_new_session_no_cdp",
        test_spawn_browser_activity_raises_when_new_session_has_no_cdp_url,
    )
    await r.record_async(
        "activity_resume_no_cdp",
        test_spawn_browser_activity_raises_when_resumed_session_has_no_cdp_url,
    )
    await r.record_async(
        "activity_auth_assistance_resume_reuses_live",
        test_spawn_browser_activity_auth_assistance_resume_reuses_live_session,
    )
    await r.record_async(
        "activity_auth_assistance_resume_reuses_backend_refreshed",
        test_spawn_browser_activity_auth_assistance_resume_reuses_backend_refreshed_session,
    )
    await r.record_async(
        "activity_auth_assistance_resume_fallback_expired",
        test_spawn_browser_activity_auth_assistance_resume_falls_back_when_live_session_expired,
    )
    await r.record_async(
        "activity_write_approval_resume_fallback_expired",
        test_spawn_browser_activity_write_approval_resume_falls_back_when_live_session_expired,
    )
    await r.record_async(
        "activity_write_approval_resume_fallback_liveness_missing",
        test_spawn_browser_activity_write_approval_resume_falls_back_when_liveness_missing,
    )
    await r.record_async(
        "browser_supervisor_recovery_clicks_dismiss",
        test_browser_supervisor_recovery_clicks_generic_dismiss_button,
    )
    await r.record_async(
        "browser_supervisor_snapshot",
        test_browser_supervisor_snapshot_reads_lightweight_page_state,
    )
    await r.record_async(
        "activity_failed_steel_auth_recovers_same_run",
        test_spawn_browser_activity_failed_steel_auth_recovers_same_run,
    )
    await r.record_async(
        "failed_steel_auth_credential_isolated_restart",
        test_failed_steel_auth_restart_invalidates_before_credential_isolated_resume,
    )
    r.record(
        "realm_transition_refreshes_session_credential_ref",
        test_realm_transition_refreshes_active_session_credential_ref,
    )
    await r.record_async(
        "manager_cancelled_pause_metadata",
        test_manager_cancelled_browser_pause_event_includes_task_metadata,
    )
    await r.record_async(
        "manager_disables_fast_mode_cache",
        test_manager_disables_fast_mode_cache_for_browser_activity,
    )
    await r.record_async(
        "manager_output_files_after_finished",
        test_manager_posts_output_files_after_finished_tool_event,
    )
    await r.record_async(
        "manager_finished_structured_response_values",
        test_manager_finished_tool_event_includes_structured_response_values,
    )
    await r.record_async(
        "manager_failed_structured_response_values",
        test_manager_failed_tool_event_includes_structured_response_values,
    )
    await r.record_async(
        "manager_auth_assistance_resume",
        test_manager_auth_assistance_pauses_and_resumes,
    )
    await r.record_async(
        "manager_write_approval_hour_wait_resume",
        test_manager_write_approval_after_hour_wait_resumes_and_finishes,
    )
    await r.record_async(
        "manager_payment_card_approval_activity_names",
        test_manager_payment_card_approval_uses_registered_activity_names_and_resumes,
    )
    await r.record_async(
        "manager_payment_gate_agentcard_setup_required",
        test_manager_payment_gate_agentcard_setup_required_prompts_and_retries,
    )
    await r.record_async(
        "manager_payment_gate_agentcard_setup_timeout",
        test_manager_payment_gate_agentcard_setup_times_out_when_never_connected,
    )
    await r.record_async(
        "manager_payment_gate_subscription_rejected",
        test_manager_payment_gate_subscription_rejected_cancels_purchase,
    )
    await r.record_async(
        "manager_payment_gate_subscription_still_inactive",
        test_manager_payment_gate_subscription_still_inactive_after_retry_blocks,
    )
    await r.record_async(
        "manager_payment_gate_subscription_checkout_failure_still_raises_gate",
        test_manager_payment_gate_subscription_checkout_failure_still_raises_gate,
    )
    await r.record_async(
        "manager_payment_gate_kyc_rejected",
        test_manager_payment_gate_kyc_rejected_cancels_purchase,
    )
    await r.record_async(
        "manager_payment_gate_kyc_still_incomplete",
        test_manager_payment_gate_kyc_still_incomplete_after_retry_blocks,
    )
    await r.record_async(
        "manager_payment_gate_company_funding_retry",
        test_manager_payment_gate_retries_company_funding_and_mints,
    )
    r.record(
        "manager_payment_gate_company_funding_retry_delay",
        test_manager_payment_gate_normalizes_company_funding_retry_delay,
    )
    await r.record_async(
        "manager_payment_gate_company_funding_deadline",
        test_manager_payment_gate_reports_company_funding_deadline,
    )
    r.record(
        "transient_session_init_failure_classification",
        test_transient_session_init_failure_classification,
    )
    teardown_mock()
    r.record(
        "idle_mouse_drift_generates_visible_tremor_samples",
        test_idle_mouse_drift_generates_visible_tremor_samples,
    )
    r.record(
        "agent_anti_detection_normalizes_fcaptcha_behavioral_payload",
        test_agent_anti_detection_normalizes_fcaptcha_behavioral_payload,
    )
    r.record(
        "select_auth_assistance_current_url_restores_pre_submit_query_params",
        test_select_auth_assistance_current_url_restores_pre_submit_query_params,
    )
    r.record(
        "select_auth_assistance_current_url_keeps_current_when_it_has_query_params",
        test_select_auth_assistance_current_url_keeps_current_when_it_has_query_params,
    )
    r.record(
        "simulated_browser_usage_preserves_transport_model",
        test_simulated_browser_usage_preserves_transport_model,
    )
    await r.record_async(
        "browser_supervisor_recovery_uses_fallback_url_when_page_url_missing",
        test_browser_supervisor_recovery_uses_fallback_url_when_page_url_missing,
    )
    await r.record_async(
        "goto_action_returns_current_url_for_recovery_fallback",
        test_goto_action_returns_current_url_for_recovery_fallback,
    )
    r.record(
        "browser_tool_events_declare_action_type",
        test_browser_tool_events_declare_action_type,
    )
    return r.all_passed

if __name__ == "__main__":
    asyncio.run(run_all_tests())
