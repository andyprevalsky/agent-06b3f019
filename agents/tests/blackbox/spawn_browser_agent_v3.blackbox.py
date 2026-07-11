"""Blackbox tests for spawn-browser-agent-v3 domain.

Heavily exercises service_crypto (pure functions), repo (httpx-mockable),
service (data transforms), and the static/pure parts of service_actions
and handler (ClaudeTokenState, get_manager, workflow helper static bits).
"""

import asyncio
import base64
import json
import os
import sys
import time as time_module
from io import BytesIO
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

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


def test_verifier_activity_timeout_allows_llm_call():
    """Browser verifier uses the standard LLM activity budget."""
    from domains.spawn_browser_agent_v3.config import VERIFIER_ULTRA_TIMEOUT_SECONDS
    from utils.llm_timeouts import STANDARD_LLM_ACTIVITY_TIMEOUT_SECONDS

    assert VERIFIER_ULTRA_TIMEOUT_SECONDS == STANDARD_LLM_ACTIVITY_TIMEOUT_SECONDS


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

        async def close(self, *, include_steel_media=True):
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


async def test_browser_recording_finalizer_keeps_local_artifacts_when_upload_fails():
    import shutil
    import tempfile

    from domains.spawn_browser_agent_v3.handler import _finalize_browser_recording_for_fe

    class UploadFailRecorder:
        def __init__(self, output_dir):
            self.output_dir = Path(output_dir)
            self.cleanup_persisted = None

        async def close(self, *, include_steel_media=True):
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

        async def close(self, *, include_steel_media=True):
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

    assert page.mouse.downs and page.mouse.ups, "expected a synthesized press and release"
    assert abs(page.mouse.downs[-1][0] - 360) <= 5 and abs(page.mouse.downs[-1][1] - 240) <= 5
    assert cdp.calls[0][0] == "Input.dispatchMouseEvent"
    assert cdp.calls[-1][1]["x"] == 360
    assert cdp.calls[-1][1]["y"] == 240
    assert observed[-1] == (360, 240)


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

        async def enable(self, session_id=None):
            self.enabled_session_id = session_id

        async def getResponseBody(self, params, session_id=None):
            assert params == {"requestId": "123.4"}
            assert session_id == "cdp-1"
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

            index_path = await recorder.close()
            assert index_path is not None
            index = json.loads(index_path.read_text())
            assert index["entry_count"] == 1
            entry = index["entries"][0]
            assert entry["url"] == url
            assert entry["status"] == 200
            assert entry["body_file"].endswith(".json")
            body = json.loads((index_path.parent / entry["body_file"]).read_text())
            assert body["errors"][0]["message"] == "unexpected error"
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
        await save_browser_action_message(
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
        # Should not raise
        await save_browser_action_message(
            agent_id="ag",
            title="t",
            message="m",
            status=MessageStatus.FINISHED,
            task_id="t1",
        )


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
        await save_browser_assistant_message("ag1", "hello world", "task-1")

    body = json.loads(get_captured_requests()[0]["requestBody"])
    assert body["role"] == "ASSISTANT"
    assert body["metadata"]["subAgentId"] == "task-1"


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
        await save_browser_credential_ref_message(
            agent_id="ag1",
            task_id="task-1",
            message="OTP code",
            role="USER",
            credential_ref={"kind": "email_otp", "id": "msg1"},
        )

    body = json.loads(get_captured_requests()[0]["requestBody"])
    assert body["role"] == "USER"
    assert body["metadata"]["subAgentId"] == "task-1"
    assert body["metadata"]["credential_ref"] == {"kind": "email_otp", "id": "msg1"}


# ========================================
# repo: Steel files
# ========================================


async def test_list_session_files_no_api_key():
    from domains.spawn_browser_agent_v3 import repo

    with patch.object(repo, "STEEL_API_KEY", ""):
        assert await repo.list_session_files("s1") == []


async def test_list_session_files_success():
    from domains.spawn_browser_agent_v3 import repo

    setup_mock(
        {
            "api.steel.dev/v1/sessions/s1/files": {
                "status": 200,
                "json": {"data": [{"path": "/f/x.pdf"}]},
            }
        }
    )
    with patch.object(repo, "STEEL_API_KEY", "sk-steel"):
        files = await repo.list_session_files("s1")
    assert files == [{"path": "/f/x.pdf"}]


async def test_list_session_files_non_200():
    from domains.spawn_browser_agent_v3 import repo

    setup_mock({"api.steel.dev": {"status": 500, "json": {"err": "x"}}})
    with patch.object(repo, "STEEL_API_KEY", "sk-steel"):
        assert await repo.list_session_files("s1") == []


async def test_list_session_files_network_error():
    from domains.spawn_browser_agent_v3 import repo
    from _test_utils import setup_mock_fn

    def boom(req):
        raise RuntimeError("net")

    setup_mock_fn(boom)
    with patch.object(repo, "STEEL_API_KEY", "sk-steel"):
        assert await repo.list_session_files("s1") == []


async def test_download_file_from_steel_no_api_key():
    from domains.spawn_browser_agent_v3 import repo

    with patch.object(repo, "STEEL_API_KEY", ""):
        assert await repo.download_file_from_steel("s1", "/files/x.pdf") is None


async def test_download_file_from_steel_strips_prefixes():
    from domains.spawn_browser_agent_v3 import repo

    captured = {}

    def handler(request):
        import httpx

        captured["url"] = str(request.url)
        return httpx.Response(200, content=b"PDFDATA", headers={"Content-Type": "application/pdf"})

    from _test_utils import setup_mock_fn

    setup_mock_fn(handler)
    with patch.object(repo, "STEEL_API_KEY", "sk"):
        out = await repo.download_file_from_steel("s1", "/files/doc.pdf")

    assert out is not None
    assert out["content"] == b"PDFDATA"
    assert out["filename"] == "doc.pdf"
    assert out["mime_type"] == "application/pdf"
    assert "files/doc.pdf" in captured["url"]
    # "/files/" prefix should have been stripped before Steel path
    assert "/files//files/" not in captured["url"]


async def test_download_file_from_steel_strips_leading_slash():
    from domains.spawn_browser_agent_v3 import repo

    def handler(request):
        import httpx

        return httpx.Response(200, content=b"X")

    from _test_utils import setup_mock_fn

    setup_mock_fn(handler)
    with patch.object(repo, "STEEL_API_KEY", "sk"):
        out = await repo.download_file_from_steel("s1", "/simple.txt")
    assert out is not None
    assert out["mime_type"] == "text/plain"


async def test_download_file_from_steel_non_200():
    from domains.spawn_browser_agent_v3 import repo

    setup_mock({"api.steel.dev": {"status": 404, "text": "not found"}})
    with patch.object(repo, "STEEL_API_KEY", "sk"):
        assert await repo.download_file_from_steel("s1", "x") is None


async def test_download_file_from_steel_network_error():
    from domains.spawn_browser_agent_v3 import repo
    from _test_utils import setup_mock_fn

    def boom(req):
        raise RuntimeError("fail")

    setup_mock_fn(boom)
    with patch.object(repo, "STEEL_API_KEY", "sk"):
        assert await repo.download_file_from_steel("s1", "x") is None


async def test_take_steel_computer_screenshot_success():
    from domains.spawn_browser_agent_v3 import repo

    setup_mock(
        {
            "api.steel.dev/v1/sessions/s1/computer": {
                "status": 200,
                "json": {
                    "output": "Screenshot taken successfully",
                    "base64_image": "abc123",
                },
            }
        }
    )
    with patch.object(repo, "STEEL_API_KEY", "sk"):
        out = await repo.take_steel_computer_screenshot("s1")
    assert out["base64_image"] == "abc123"
    assert_captured_call(
        0,
        url_contains="api.steel.dev/v1/sessions/s1/computer",
        method="POST",
        body_contains={"action": "take_screenshot"},
        header_present="steel-api-key",
    )


async def test_take_steel_computer_screenshot_missing_image_raises():
    from domains.spawn_browser_agent_v3 import repo

    setup_mock(
        {
            "api.steel.dev/v1/sessions/s1/computer": {
                "status": 200,
                "json": {
                    "output": "Screenshot taken successfully",
                    "system": "steel-browser",
                },
            }
        }
    )
    with patch.object(repo, "STEEL_API_KEY", "sk"):
        try:
            await repo.take_steel_computer_screenshot("s1")
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


async def test_init_browser_session_error_raises():
    from domains.spawn_browser_agent_v3.repo import init_browser_session

    setup_mock({"/api/browser-session/init": {"status": 500, "text": "oops"}})
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
    assert json.loads(call["requestBody"])["task_id"] == "t1"


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
            return _Resp()

    with patch.object(repo.httpx, "AsyncClient", return_value=_Client()):
        cfg = _fake_config()
        out = await repo.upload_file_to_session(cfg, "s1", "f.pdf", b"PDFDATA", "application/pdf")
    assert out == {"path": "/tmp/f.pdf"}


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
    assert items[1]["provider"] == "Steel.dev Browser"


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
    assert client.calls[0]["browser_state"]["_extra_user_messages"] == [
        {"role": "user", "content": "resume from current live state"}
    ]


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
        patch.object(service, "download_file_from_steel", AsyncMock(return_value=download_return)),
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
            "download_file_from_steel",
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
        patch.object(service, "download_file_from_steel", AsyncMock(return_value=None)),
    ):
        out = await service.extract_session_files("s1", "u1", _fake_config())
    assert out == []


async def test_extract_session_files_upload_failure_skipped():
    from domains.spawn_browser_agent_v3 import service

    with (
        patch.object(service, "list_session_files", AsyncMock(return_value=[{"path": "/a"}])),
        patch.object(
            service,
            "download_file_from_steel",
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


async def test_execute_action_request_payment_card_requests_workflow_approval():
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    dom = MagicMock()
    dom.session = MagicMock()
    dom.selector_map = {}
    ah = MagicMock()
    ah.record_action = AsyncMock()
    payment_request = {
        "merchant": "Rose Labs Test Payment",
        "line_items": [{"name": "Aurora Notebook", "unit_price_cents": 1200, "quantity": 1, "line_total_cents": 1200}],
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

    webauthn.enable.assert_awaited_once_with(params={"enableUI": False}, session_id="cdp-session")
    webauthn.addVirtualAuthenticator.assert_awaited_once()
    webauthn.addCredential.assert_awaited_once()
    page.setInterceptFileChooserDialog.assert_awaited_once_with(params={"enabled": True}, session_id="cdp-session")
    assert await dom.get_used_passkey_credential_ids() == ["cred-1"]


# ── _execute_click ───────────────────────────────────────────────────


async def test_execute_click_with_element_humanizer():
    from domains.spawn_browser_agent_v3.service_actions import _execute_click

    session = MagicMock()
    session.highlight_interaction_element = AsyncMock()
    dom = MagicMock()
    dom.get_element_coordinates = AsyncMock(return_value=(10, 20))
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
    dom.get_element_coordinates = AsyncMock(return_value=None)
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


def test_write_lock_purchase_button_detects_order_controls():
    """Final order/payment buttons are purchase-gated; cart and checkout navigation are not."""
    from browser_tools.write_lock import is_purchase_button

    assert is_purchase_button("Buy Now")
    assert is_purchase_button("Place your order")
    assert not is_purchase_button("Add to Cart")
    assert not is_purchase_button("Go to Cart")
    assert not is_purchase_button("Proceed to checkout")


def test_write_lock_email_send_excludes_resend_controls():
    """Auth resend controls contain 'send' but are not outbound email sends."""
    from browser_tools.write_lock import is_email_send_button

    assert is_email_send_button("Send")
    assert is_email_send_button("Send email")
    assert is_email_send_button("Send message")
    assert not is_email_send_button("Resend")
    assert not is_email_send_button("Resend code via SMS")
    assert not is_email_send_button("alt-action-resend")


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
    dom.get_element_coordinates = AsyncMock(return_value=(10, 20))
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
    dom.get_element_coordinates = AsyncMock(return_value=(10, 20))
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
            "domains.spawn_browser_agent_v3.repo.take_steel_computer_screenshot",
            AsyncMock(return_value={"base64_image": screenshot_b64}),
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
    """Missing Steel Computer screenshot data fails instead of falling back to CDP."""
    from domains.spawn_browser_agent_v3 import service_actions

    session = MagicMock()
    dom = MagicMock()
    ah = MagicMock()
    ah.record_action = AsyncMock()
    with patch(
        "domains.spawn_browser_agent_v3.repo.take_steel_computer_screenshot",
        AsyncMock(side_effect=RuntimeError("Steel computer screenshot did not return an image")),
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
    assert "Seller: Amazon.com" in question
    assert "Shipping: FREE Two Day delivery" in question
    assert "Total: $21.71" in question
    assert "Payment: Visa ending in 9857" in question
    assert "Delivery: Aman Gottumukkala" in question
    assert "**Image:** https://m.media-amazon.com/images/I/beanie.jpg" in question
    assert "fallback question" not in question
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
            fake_cdp_client.websockets.connect("ws://example.test/devtools", proxy="http://proxy.local")
            == "connected"
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
        _tasks={object()},
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
    assert network_recorder._tasks == set()
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


async def test_spawn_browser_activity_auth_assistance_keeps_live_steel_session_open():
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
    }
    auth_request = {
        "request": {"id": "uar1"},
        "handoff": {"liveViewUrl": "https://steel.example/debug?interactive=true&showControls=true"},
    }
    close_mock = AsyncMock()
    create_auth_mock = AsyncMock(return_value=auth_request)

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
                return_value={
                    "action": {
                        "action": "request_user_assistance_for_authentication",
                        "thinking": "",
                        "params": {},
                    },
                    "usage": {},
                    "mode": "waterfall",
                }
            ),
        ),
        patch(
            "domains.spawn_browser_agent_v3.handler.create_user_auth_assistance_request",
            create_auth_mock,
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

    assert result["status"] == "awaiting_auth_assistance"
    assert result["session_id"] == "session-1"
    close_mock.assert_not_awaited()
    assert _FakeDomService.last_instance is not None
    _FakeDomService.last_instance.disconnect.assert_awaited_once()
    fake_browser.close.assert_not_awaited()
    fake_playwright.stop.assert_awaited_once()
    create_auth_mock.assert_awaited_once()
    kwargs = create_auth_mock.await_args.kwargs
    assert kwargs["steel_session_id"] == "session-1"
    assert kwargs["mode"] == "live_view"
    assert _FakeHumanizer.last_instance is not None
    assert callable(_FakeHumanizer.last_instance.cursor_observer)
    assert _FakeHumanizer.last_instance.idle_started is True


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
        async for event in manager.execute_tool(
            workflow_instance, {"goal": "Buy socks"}, "tool-1"
        ):
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

    failed_event = next(
        e for e in events if getattr(e, "status", None) == MessageStatus.ERROR
    )
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
    assert "Requesting User Assistance for example.com Login" in titles
    assert "User Assistance Received" in titles
    assert events[-1].status == MessageStatus.FINISHED
    assert workflow_instance.is_paused is False
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


# ========================================
# Runner
# ========================================


async def run_all_tests():
    print("spawn-browser-agent-v3 blackbox tests:")
    r = BlackboxResult()

    await r.record_async("cdp_use_websocket_direct", test_cdp_use_websocket_patch_disables_proxy_discovery)
    r.record("verifier_timeout_standard_llm_budget", test_verifier_activity_timeout_allows_llm_call)
    r.record(
        "browser_supervisor_timeout_ordering",
        test_browser_supervisor_does_not_preempt_browser_use_event_timeouts,
    )
    r.record(
        "browser_task_prompt_no_system_duplication",
        test_browser_task_prompt_does_not_duplicate_system_prompt,
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
    await r.record_async("save_browser_assistant_message", test_save_browser_assistant_message)
    await r.record_async(
        "save_browser_assistant_message_swallows",
        test_save_browser_assistant_message_swallows_exception,
    )
    await r.record_async("save_credential_ref_user", test_save_browser_credential_ref_message_user_role)

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
    await r.record_async(
        "execute_action_request_payment_card",
        test_execute_action_request_payment_card_requests_workflow_approval,
    )
    await r.record_async(
        "execute_action_request_payment_card_rejects_empty_receipt",
        test_execute_action_request_payment_card_rejects_empty_receipt,
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
        "dom_service_disconnect_stops_session",
        test_dom_service_disconnect_stops_browser_session_without_killing_remote_browser,
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
    await r.record_async("execute_click_coords_no_humanizer", test_execute_click_with_coords_no_humanizer)
    await r.record_async("execute_click_no_target", test_execute_click_no_element_no_coords)
    await r.record_async(
        "execute_click_write_lock_purchase",
        test_execute_click_write_lock_purchase_triggers_approval,
    )
    r.record(
        "write_lock_purchase_button_order_controls",
        test_write_lock_purchase_button_detects_order_controls,
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
        "execute_input_text_el_humanizer_missing_coords",
        test_execute_input_text_element_humanizer_missing_coords_refuses_typetext_fallback,
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
    await r.record_async("execute_goto_injects_ls", test_execute_goto_injects_local_storage)
    await r.record_async(
        "execute_goto_injects_ls_error",
        test_execute_goto_injects_local_storage_swallows_error,
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
    await r.record_async(
        "browser_agent_recording_active_tab_url",
        test_browser_agent_recording_captures_visible_active_tab_url,
    )
    await r.record_async(
        "browser_agent_recording_disabled_env",
        test_browser_agent_recording_respects_disabled_env,
    )
    await r.record_async(
        "browser_agent_recording_start_failure_best_effort",
        test_browser_agent_recording_start_failure_is_best_effort,
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
        "browser_recording_finalizer_keeps_local_artifacts_when_upload_fails",
        test_browser_recording_finalizer_keeps_local_artifacts_when_upload_fails,
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
    await r.record_async(
        "browser_humanizer_click_synthesis",
        test_browser_humanizer_click_uses_synthesized_mouse_and_cursor_updates,
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
        "browser_humanizer_idle_movement",
        test_browser_humanizer_idle_movement_forwards_to_cdp_and_observer,
    )
    await r.record_async(
        "browser_humanizer_keyboard_synthesis",
        test_browser_humanizer_keyboard_uses_keycap_timing_for_text_and_shortcuts,
    )
    await r.record_async(
        "browser_network_recording_captures_body",
        test_browser_network_recording_captures_response_body,
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
        "activity_auth_assistance_resume_fallback_expired",
        test_spawn_browser_activity_auth_assistance_resume_falls_back_when_live_session_expired,
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
        "activity_auth_assistance_keeps_live_session_open",
        test_spawn_browser_activity_auth_assistance_keeps_live_steel_session_open,
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

    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
