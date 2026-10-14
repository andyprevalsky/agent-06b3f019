"""WHM-only private rejection capture, bound to the native request's active owner."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import subprocess
import sys
from contextvars import ContextVar
from copy import deepcopy
from pathlib import Path

REJECTION_RECORDER = ContextVar("wmh_rejection_recorder", default=None)
NATIVE_CAPTURE_TEMPLATE = ContextVar("wmh_native_capture_template", default=None)


def owner_path(root, session_id, prediction_id):
    for value in (session_id, prediction_id):
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}", value):
            raise ValueError("Invalid native capture identity")
    return Path(root) / "native-provider-capture-owners" / session_id / (prediction_id + ".json")


def wire_sha256(payload):
    wire = {key: payload[key] for key in ("messages", "maximum_output_tokens")}
    return hashlib.sha256(
        json.dumps(wire, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()


def open_owner(root, session_id, prediction_id, request_sha256, execution_identity, wire=None, template=None):
    from benchmarks.build_experiential_world_model import atomic_json

    path = owner_path(root, session_id, prediction_id)
    if path.exists():
        raise ValueError("Native capture owner already exists")
    from benchmarks.wmh_native_prediction_writer import NativePredictionWriter

    template = NATIVE_CAPTURE_TEMPLATE.get() if template is None else template
    if not isinstance(template, dict):
        raise ValueError("Native capture requires the real prediction context")
    for key, value in (
        ("session_id", session_id),
        ("prediction_id", prediction_id),
        ("request_sha256", request_sha256),
        ("execution_identity", execution_identity),
    ):
        if template.get(key) != value:
            raise ValueError("Native capture template differs from request owner")
    writer = NativePredictionWriter(
        root, execution_identity["base_world_model_id"], execution_identity["base_protocol_sha256"]
    )
    writer.begin(template)
    atomic_json(
        path,
        {
            "session_id": session_id,
            "prediction_id": prediction_id,
            "request_sha256": request_sha256,
            "execution_identity": execution_identity,
            "wire_request_sha256": wire_sha256(wire) if wire is not None else None,
            "active": True,
        },
    )


def close_owner(root, session_id, prediction_id):
    from benchmarks.build_experiential_world_model import atomic_json

    path = owner_path(root, session_id, prediction_id)
    owner = json.loads(path.read_text())
    owner["active"] = False
    atomic_json(path, owner)


def verified_owner(root, payload, *, require_active=True):
    try:
        owner = json.loads(owner_path(root, payload["session_id"], payload["prediction_id"]).read_text())
    except (OSError, ValueError) as error:
        raise ValueError("Native capture owner unavailable") from error
    for key in ("session_id", "prediction_id", "request_sha256", "execution_identity"):
        if owner.get(key) != payload.get(key):
            raise ValueError("Native capture ownership differs")
    if owner.get("wire_request_sha256") is not None:
        actual_wire = wire_sha256(payload) if "messages" in payload else payload.get("wire_request_sha256")
        if actual_wire != owner["wire_request_sha256"]:
            raise ValueError("Native capture wire request differs")
    if require_active and owner.get("active") is not True:
        raise ValueError("Native capture owner is closed")
    return owner


class PrivateRejectionRecorder:
    def __init__(self, root, native_python, payload):
        verified_owner(root, payload)
        self.root, self.native_python, self.payload = root, native_python, dict(payload)
        self.receipts = []

    async def __call__(self, rejected):
        # Admission occurs while this exact native owner is active. Retirement
        # can close it after admission, but must join this already-owned writer.
        # The child verifies the same immutable request/identity binding while
        # allowing closure; no later recorder or endpoint admission is allowed.
        verified_owner(self.root, self.payload)
        operation = asyncio.create_task(
            asyncio.to_thread(
                subprocess.run,
                [self.native_python, "-m", "benchmarks.wmh_provider_capture", str(self.root)],
                input=json.dumps(
                    {
                        "owner": {
                            key: self.payload[key]
                            for key in ("session_id", "prediction_id", "request_sha256", "execution_identity")
                        },
                        "rejected": rejected,
                        "capture_admitted": True,
                        "wire_request_sha256": wire_sha256(self.payload) if "messages" in self.payload else None,
                    }
                ).encode(),
                capture_output=True,
            )
        )
        cancelled = False
        while True:
            try:
                result = await asyncio.shield(operation)
                break
            except asyncio.CancelledError:
                # Repeated caller cancellation cannot cancel the exact writer
                # task or abandon its synchronous allocation/communicate/wait owner.
                if operation.cancelled():
                    raise OSError("Native private writer owner was cancelled")
                cancelled = True
        if cancelled:
            raise asyncio.CancelledError()
        if result.returncode:
            raise OSError("Native private rejection capture failed")
        receipt = json.loads(result.stdout)
        self.receipts.append(receipt)


def write_capture(root, packet):
    os.umask(0o077)
    binding = {**packet["owner"], "wire_request_sha256": packet.get("wire_request_sha256")}
    if packet.get("capture_admitted") is not True:
        raise ValueError("Private capture requires an admitted provider writer")
    owner = verified_owner(root, binding, require_active=False)
    from benchmarks.wmh_native_prediction_writer import NativePredictionWriter

    writer = NativePredictionWriter(
        root, owner["execution_identity"]["base_world_model_id"], owner["execution_identity"]["base_protocol_sha256"]
    )
    receipt = writer.append_rejected(owner["session_id"], owner["prediction_id"], packet["rejected"])
    return {**receipt, "session_id": owner["session_id"], "prediction_id": owner["prediction_id"]}


if __name__ == "__main__":
    try:
        print(json.dumps(write_capture(sys.argv[1], json.load(sys.stdin))))
    except Exception:
        print("Native private capture rejected", file=sys.stderr)
        raise SystemExit(1)


def prediction_request(kwargs: dict) -> dict:
    """Private replay input; auth objects and credentials never enter the capture."""
    fields = (
        "pool",
        "messages",
        "max_tokens",
        "call_site",
        "dump_context",
        "cache_namespace",
        "result_required",
        "prefer_azure",
        "retry_partial_errors",
        "json_mode",
        "model",
        "tools",
        "tool_choice",
        "temperature",
        "reasoning_effort",
        "reasoning_max_tokens",
        "skip_models",
        "deadline_s",
        "ttft_timeout_s",
        "idle_timeout_s",
    )
    request = deepcopy({key: kwargs[key] for key in fields if key in kwargs})
    response_model = kwargs.get("response_model")
    if response_model is not None:
        request["response_model"] = {"name": response_model.__name__, "schema": response_model.model_json_schema(), "rose_openai_strict": bool(getattr(response_model, "rose_openai_strict", True))}
    if "_skip_models" in kwargs:
        request["_skip_models"] = sorted(kwargs["_skip_models"])
    return request
