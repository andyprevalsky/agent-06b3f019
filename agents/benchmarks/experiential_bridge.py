"""Keep Rose credential leasing/inference in its existing Python 3.11 environment.

The owned Python 3.12 child uses a token-authenticated loopback provider bridge.
Only model messages and sanitized results cross it; provider credentials remain
inside RoseClient. The parent supervises and joins its exact child on shutdown.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import signal
import socket
import subprocess
import threading
from contextlib import contextmanager
from dataclasses import asdict
from pathlib import Path

# Bound for the native child to retire open sessions through the bridge on shutdown.
_CHILD_RETIRE_SECONDS = 60


def pool_sha256(pool):
    from providers.rose.pools import get_pool

    return hashlib.sha256(
        json.dumps(asdict(get_pool(pool)), sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def native_python():
    repo = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        ["bash", str(repo / "scripts/setup-world-model.sh")], capture_output=True, text=True, timeout=300
    )
    if result.returncode:
        raise RuntimeError(f"Native simulator setup failed: {result.stderr[-4000:]}")
    return result.stdout.strip()


def build_native(source_root, root, name, pool="rose-1-ultra", *, bind_only=False):
    return subprocess.run(
        [
            native_python(),
            "-m",
            "benchmarks.build_experiential_world_model",
            "--source-root",
            str(source_root),
            "--root",
            str(root),
            "--name",
            name,
            "--pool",
            pool,
            "--pool-sha256",
            pool_sha256(pool),
            *(["--bind-conformance-only"] if bind_only else []),
        ],
        cwd=Path(__file__).resolve().parents[1],
        check=True,
    )


def build_provider_bridge(provider, token, *, execution_policy=None):
    from fastapi import FastAPI, Header, HTTPException
    from wmh.providers.base import Message

    from benchmarks.wmh_execution_policy import validate_execution_identity
    from benchmarks.wmh_rose_provider import _WMHInvalidPrediction

    app = FastAPI()

    def authorize(value):
        if not value or not secrets.compare_digest(value, token):
            raise HTTPException(401, "Invalid internal provider token")

    @app.get("/rose_usage")
    def usage(x_rose_provider_token: str | None = Header(default=None)):
        authorize(x_rose_provider_token)
        return provider._usage.snapshot()

    @app.post("/complete")
    async def complete(payload: dict, x_rose_provider_token: str | None = Header(default=None)):
        authorize(x_rose_provider_token)
        messages = payload.get("messages")
        if (
            not isinstance(messages, list)
            or len(messages) < 2
            or messages[0].get("role") != "system"
            or any(m.get("role") != "user" for m in messages[1:])
        ):
            raise HTTPException(422, "Expected native system/user messages")
        if payload.get("maximum_output_tokens") != 16384:
            raise HTTPException(422, "Unexpected world-model output budget")
        session_id = payload.get("session_id")
        prediction_id = payload.get("prediction_id")
        if any(
            not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}", value)
            for value in (session_id, prediction_id)
        ):
            raise HTTPException(422, "Native completion requires exact session/prediction identity")
        try:
            if execution_policy is not None:
                validate_execution_identity(
                    payload.get("execution_identity"), execution_policy, system=messages[0]["content"]
                )
            result = await provider.complete_scoped(
                session_id,
                prediction_id,
                messages[0]["content"],
                [Message(role=m["role"], content=m["content"]) for m in messages[1:]],
                max_tokens=16384,
            )
        except _WMHInvalidPrediction as exc:
            raise HTTPException(422, {"kind": "invalid_prediction", "reason": str(exc)}) from exc
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        return {
            "content": result.text,
            "actual_model": getattr(result, "actual_model", None),
            "usage": result.usage.model_dump(),
            "execution_identity": payload.get("execution_identity") if execution_policy is not None else None,
        }

    @app.post("/sessions/{session_id}/retire")
    async def retire(session_id: str, x_rose_provider_token: str | None = Header(default=None)):
        authorize(x_rose_provider_token)
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}", session_id):
            raise HTTPException(422, "Invalid native session identity")
        try:
            return await provider.retire_scope(session_id)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    return app


def serve_native(name, root, pool, port):
    import uvicorn

    from benchmarks.wmh_execution_policy import DEFAULT_EXECUTION_POLICY, execution_policy
    from benchmarks.wmh_rose_provider import RoseWMHProvider

    policy = execution_policy(os.environ.get("WMH_EXECUTION_POLICY", DEFAULT_EXECUTION_POLICY))
    python = native_python()
    token = secrets.token_urlsafe(32)
    provider = RoseWMHProvider(pool=pool, protocol=policy.response_protocol)
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(128)
    bridge_port = listener.getsockname()[1]
    config = uvicorn.Config(
        build_provider_bridge(provider, token, execution_policy=policy.name),
        host="127.0.0.1",
        log_level="warning",
        timeout_graceful_shutdown=10,
    )

    class OwnedServer(uvicorn.Server):
        @contextmanager
        def capture_signals(self):
            # Uvicorn normally re-raises TERM before its caller's finally block.
            # The native child retires its open sessions through this provider
            # bridge, so stop the exact child first and keep serving until
            # supervise() observes its exit (bounded by a fallback).
            def stop_child_first(sig, frame):
                self._captured_signals.append(sig)
                if child.poll() is None and not self.should_exit:
                    child.terminate()
                    fallback = threading.Timer(_CHILD_RETIRE_SECONDS, setattr, (self, "should_exit", True))
                    fallback.daemon = True
                    fallback.start()
                else:
                    self.should_exit = True

            previous = {sig: signal.signal(sig, stop_child_first) for sig in (signal.SIGINT, signal.SIGTERM)}
            try:
                yield
            finally:
                for sig, handler in previous.items():
                    signal.signal(sig, handler)

    server = OwnedServer(config)
    env = {
        **os.environ,
        "WMH_PROVIDER_BRIDGE_TOKEN": token,
        "WMH_ROSE_POOL_SHA256": pool_sha256(pool),
        "WMH_EXECUTION_POLICY": policy.name,
    }
    child = subprocess.Popen(
        [
            python,
            "-m",
            "benchmarks.serve_experiential_world_model",
            "--name",
            name,
            "--root",
            str(root),
            "--pool",
            pool,
            "--port",
            str(port),
            "--provider-url",
            f"http://127.0.0.1:{bridge_port}",
        ],
        cwd=Path(__file__).resolve().parents[1],
        env=env,
    )

    def supervise():
        child.wait()
        server.should_exit = True

    threading.Thread(target=supervise, name="rose-native-wmh-owner", daemon=True).start()
    try:
        server.run(sockets=[listener])
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
        listener.close()
    if server._captured_signals:
        return 128 + server._captured_signals[0]
    return 128 - child.returncode if child.returncode and child.returncode < 0 else child.returncode or 0
