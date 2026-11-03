"""Unchanged offline owning boundary assertions, executed on baseline/candidate."""

import asyncio
import json
import os
import socket
import subprocess
import sys
import time
from unittest.mock import AsyncMock

import httpx
import pytest

from benchmarks import wmh_rose_provider as wmh
from benchmarks.experiential_bridge import native_python
from benchmarks.wmh_provider_capture import REJECTION_RECORDER
from providers.demo_cache import client as cache
from providers.demo_cache.context import DemoCacheContext
from providers.rose.client import RoseClient
from providers.rose.types import StreamChunk


def _test_native_python():
    return os.environ.get("WMH_TEST_NATIVE_PYTHON") or native_python()


@pytest.fixture(autouse=True)
def restore_validation_recovery_context():
    token = REJECTION_RECORDER.set(None)
    try:
        yield
    finally:
        REJECTION_RECORDER.reset(token)


Client = wmh._WMHCacheSafeRoseClient

VALID = json.dumps(
    {
        "schema": "rose.wmh_timed_outcome_distribution.v1",
        "outcomes": [
            {
                "id": "observed",
                "probability": 1,
                "elapsed_ms": 1000,
                "description": "offline",
                "tool_results": [{"call_id": "call-1", "content": "valid observed result", "is_error": False}],
                "state_patch": [],
            }
        ],
    }
)
BAD = '{"private-rejected-marker"'
MESSAGES = [
    {"role": "system", "content": "unchanged offline system"},
    {
        "role": "user",
        "content": json.dumps(
            {
                "environment_state": {},
                "candidate_response": {"tool_calls": [{"call_id": "call-1"}]},
            }
        ),
    },
]


def _setup_validation_recovery(monkeypatch, mode, tmp_path):
    attempts, captured, chunks, writes = [], [], [], []
    monkeypatch.setenv("FAST_MODE_CACHE_DISABLE_WRITE_THROUGH", "0")
    monkeypatch.setattr(
        cache,
        "ensure_context",
        AsyncMock(return_value=DemoCacheContext(enabled=False, goal="offline source boundary", write_enabled=True)),
    )

    async def store(*args):
        writes.append(args[-1])
        return True

    monkeypatch.setattr(cache, "cache_set", store)

    async def record(capture):
        assert "private-lease-marker" not in json.dumps(capture)
        path = tmp_path / f"{mode}-attempt-{capture['attempt_ordinal']}.json"
        process = await asyncio.create_subprocess_exec(
            _test_native_python(),
            "-m",
            "benchmarks.wmh_validation_recovery_private_capture_fixture",
            str(path),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=dict(os.environ),
        )
        _, error = await process.communicate(json.dumps(capture).encode())
        assert process.returncode == 0, "Existing private redacted writer failed"
        assert json.loads(path.read_text())["content"] == capture["content"]
        captured.append(capture)

    async def once(self, **kwargs):
        if attempts and mode in {"recover", "exhaust", "capture_fail"}:
            assert len(captured) == 1, "Recovery began before private rejected-response capture"
        attempts.append(kwargs)
        model = "gpt-5.6-luna-foundry" if len(attempts) == 1 else "qwen-3.8-27b"
        yield StreamChunk(kind="metadata", data={"actual_model": model})
        if mode == "cancel":
            raise asyncio.CancelledError()
        text = BAD if len(attempts) == 1 or mode == "exhaust" else VALID
        yield StreamChunk(kind="content", data={"text": text})
        yield StreamChunk(
            kind="usage",
            data={
                "prompt_tokens": 10,
                "completion_tokens": 3,
                "finish_reason": "stop",
                "compute_token_used": {"accessToken": "private-lease-marker"},
            },
        )
        yield StreamChunk(kind="done", data={})

    monkeypatch.setattr(RoseClient, "_complete_once", once)
    REJECTION_RECORDER.set(record)
    client = Client(openrouter_key="offline")
    return client, attempts, captured, chunks, writes


def test_validation_retries_via_existing_rose_and_captures_before_recovery(monkeypatch, tmp_path):
    client, attempts, captured, _, writes = _setup_validation_recovery(monkeypatch, "recover", tmp_path)
    response = asyncio.run(
        client.collect(
            pool="rose-1-flash",
            messages=MESSAGES,
            max_tokens=16384,
            call_site="wmh_world_model_timed_distribution_v1",
            result_required=True,
            retry_partial_errors=True,
            dump_context=False,
            deadline_s=590,
        )
    )
    assert len(attempts) == 2 and len(captured) == 1
    assert response.content == VALID and "private-rejected-marker" not in response.content
    assert response.usage["prompt_tokens"] == 20 and response.usage["completion_tokens"] == 6
    assert response.usage["abandoned_attempts"][0]["usage_complete"] is True
    assert "private-rejected-marker" not in json.dumps(response.usage)
    assert "gpt56luna" in attempts[1]["_skip_models"]
    assert attempts[1]["messages"] == attempts[0]["messages"] == MESSAGES
    assert attempts[1]["deadline_s"] <= attempts[0]["deadline_s"] == 360
    assert len(writes) == 1 and "private-rejected-marker" not in json.dumps(writes)


def test_schema_exhaustion_is_two_attempts_no_done_with_all_known_usage(monkeypatch, tmp_path):
    client, attempts, captured, seen, writes = _setup_validation_recovery(monkeypatch, "exhaust", tmp_path)

    async def run():
        with pytest.raises(wmh._WMHInvalidPrediction) as error:
            async for chunk in client.complete(
                pool="rose-1-flash",
                messages=MESSAGES,
                max_tokens=16384,
                call_site="wmh_world_model_timed_distribution_v1",
                recover_truncation=True,
                result_required=True,
                retry_partial_errors=True,
                dump_context=False,
                deadline_s=590,
            ):
                seen.append(chunk)
        assert error.value.usage["prompt_tokens"] == 20
        assert error.value.usage["completion_tokens"] == 6

    asyncio.run(run())
    assert len(attempts) == len(captured) == 2
    assert not any(chunk.kind == "done" for chunk in seen)
    assert sum(chunk.kind == "restart" for chunk in seen) == 1
    assert writes == []
    assert all("private-rejected-marker" not in json.dumps(chunk.data) for chunk in seen if chunk.kind != "content")


def test_ordinary_call_and_cancellation_do_not_enter_whm_recovery(monkeypatch, tmp_path):
    client, attempts, captured, _, _ = _setup_validation_recovery(monkeypatch, "ordinary", tmp_path)
    response = asyncio.run(
        client.collect(
            pool="rose-1-flash",
            messages=MESSAGES,
            call_site="execute_loop",
            result_required=True,
            retry_partial_errors=True,
            dump_context=False,
        )
    )
    assert response.content == BAD and len(attempts) == 1 and not captured
    client, attempts, captured, _, _ = _setup_validation_recovery(monkeypatch, "cancel", tmp_path)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(
            client.collect(
                pool="rose-1-flash",
                messages=MESSAGES,
                call_site="wmh_world_model_timed_distribution_v1",
                result_required=True,
                retry_partial_errors=True,
                dump_context=False,
            )
        )
    assert len(attempts) == 1 and not captured


def test_failed_private_capture_fails_closed_without_retry_or_cache(monkeypatch, tmp_path):
    client, attempts, captured, seen, writes = _setup_validation_recovery(monkeypatch, "capture_fail", tmp_path)

    async def fail(_capture):
        raise OSError("offline private capture unavailable")

    REJECTION_RECORDER.set(fail)

    async def run():
        with pytest.raises(OSError, match="private capture unavailable"):
            async for chunk in client.complete(
                pool="rose-1-flash",
                messages=MESSAGES,
                call_site="wmh_world_model_timed_distribution_v1",
                result_required=True,
                retry_partial_errors=True,
                recover_truncation=True,
                dump_context=False,
            ):
                seen.append(chunk)

    asyncio.run(run())
    assert len(attempts) == 1 and not captured and not writes
    assert not any(chunk.kind == "done" for chunk in seen)


def test_provider_aggregate_cost_uses_each_actual_model(monkeypatch, tmp_path):
    monkeypatch.setattr(
        wmh, "_cost_usd_for_call", lambda model, prompt, completion: prompt * (2 if "luna" in model else 1)
    )
    usage = wmh.RoseUsageAccumulator()
    provider = wmh.RoseWMHProvider(client=object(), usage=usage)
    provider._record_usage(
        {
            "prompt_tokens": 20,
            "completion_tokens": 6,
            "abandoned_attempts": [{"model": "gpt-5.6-luna-foundry", "prompt_tokens": 10, "completion_tokens": 3}],
        },
        "qwen-3.8-27b",
    )
    assert usage.snapshot().total_cost_usd == 30


def test_validation_error_preserves_numeric_metering_without_authentication_payload():
    values = {
        "prompt_tokens": 20,
        "completion_tokens": 6,
        "total_tokens": 26,
        "cache_read_input_tokens": 12,
        "cache_creation_input_tokens": 3,
        "finish_reason": "stop",
        "compute_token_used": {"accessToken": "private-lease-marker"},
        "abandoned_attempts": [
            {
                "model": "gpt-5.6-luna-foundry",
                "prompt_tokens": 10,
                "completion_tokens": 3,
                "total_tokens": 13,
                "cache_read_input_tokens": 6,
                "cache_creation_input_tokens": 1,
                "usage_complete": True,
                "compute_token_used": {"accessToken": "private-lease-marker"},
            }
        ],
    }
    error = wmh._WMHInvalidPrediction("synthetic validation", values, "qwen-3.8-27b")
    assert {
        key: error.usage[key]
        for key in (
            "prompt_tokens",
            "completion_tokens",
            "total_tokens",
            "cache_read_input_tokens",
            "cache_creation_input_tokens",
        )
    } == {
        key: values[key]
        for key in (
            "prompt_tokens",
            "completion_tokens",
            "total_tokens",
            "cache_read_input_tokens",
            "cache_creation_input_tokens",
        )
    }
    assert error.usage["abandoned_attempts"][0]["cache_read_input_tokens"] == 6
    assert "private-lease-marker" not in json.dumps(error.usage)


def test_actual_native_bridge_recovery_capture_auth_scope_and_cancellation(tmp_path):
    """Only inference is mocked; the pinned runtimes and native state owner are real."""
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    listener.close()
    environment = {**os.environ, "WMH_TEST_NATIVE_PYTHON": _test_native_python()}
    with (tmp_path / "bridge.log").open("w") as log:
        bridge = subprocess.Popen(
            [sys.executable, "-m", "benchmarks.wmh_validation_recovery_bridge_fixture", str(tmp_path), str(port)],
            env=environment,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        try:
            for _ in range(100):
                assert bridge.poll() is None, "Offline bridge exited before health"
                try:
                    response = httpx.get(
                        f"http://127.0.0.1:{port}/rose_usage",
                        trust_env=False,
                        headers={"X-Rose-Provider-Token": "offline-test-internal"},
                    )
                    if response.status_code == 200:
                        break
                except httpx.HTTPError:
                    pass
                time.sleep(0.05)
            else:
                pytest.fail("Offline bridge did not become healthy")
            result = subprocess.run(
                [
                    _test_native_python(),
                    "-m",
                    "benchmarks.wmh_validation_recovery_native_checks",
                    str(tmp_path),
                    str(port),
                ],
                env=environment,
                capture_output=True,
                text=True,
                timeout=30,
            )
            (tmp_path / "native.log").write_text(result.stdout + result.stderr)
            assert result.returncode == 0, result.stdout + result.stderr
        finally:
            if bridge.poll() is None:
                bridge.terminate()
                try:
                    bridge.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    bridge.kill()
                    bridge.wait(timeout=10)


def test_private_attempt_request_keeps_exact_fallback_and_timeout_configuration_without_auth():
    request = wmh._wmh_prediction_request(
        {
            "pool": "rose-1-flash",
            "messages": MESSAGES,
            "_skip_models": frozenset({"qwen38", "gpt56luna"}),
            "deadline_s": 512.25,
            "ttft_timeout_s": 90,
            "idle_timeout_s": 120,
            "gpt_auth": {"accessToken": "private-lease-marker"},
            "openrouter_key": "private-key-marker",
        }
    )
    assert request == {
        "pool": "rose-1-flash",
        "messages": MESSAGES,
        "_skip_models": ["gpt56luna", "qwen38"],
        "deadline_s": 512.25,
        "ttft_timeout_s": 90,
        "idle_timeout_s": 120,
    }
    assert "private-lease-marker" not in json.dumps(request)
    assert "private-key-marker" not in json.dumps(request)


def test_native_private_writer_keeps_capture_io_free_of_build_imports(tmp_path):
    """Fresh rejection writers must not initialize unrelated artifact/RAG builders."""
    code = r'''
import hashlib,json,sys
from pathlib import Path
from benchmarks.wmh_native_prediction_writer import NativePredictionWriter
root=Path(sys.argv[1]);path=root/'capture.json'
writer=NativePredictionWriter(root,'offline-artifact','a'*64)
receipt=writer._write(path,{'content':'unchanged offline observation','api_key':'private-credential-marker'})
raw=path.read_bytes();record=json.loads(raw)
assert record['content']=='unchanged offline observation'
assert 'api_key' not in record and b'private-credential-marker' not in raw
assert record['world_model_id']=='offline-artifact' and record['prompt_sha256']=='a'*64
assert record['redaction_count']>=1
assert receipt['path']=='capture.json' and receipt['sha256_at_write']==hashlib.sha256(raw).hexdigest()
assert raw.endswith(b'\n')
assert 'benchmarks.build_experiential_world_model' not in sys.modules, 'Private capture loaded unrelated model-build/RAG import stack'
'''
    result = subprocess.run(
        [_test_native_python(), "-B", "-c", code, str(tmp_path)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
