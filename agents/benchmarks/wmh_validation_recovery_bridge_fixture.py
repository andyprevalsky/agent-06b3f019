"""Owning offline fixture: actual 3.11 bridge/provider, mock inference only."""

import json
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import uvicorn

from benchmarks import wmh_provider_capture as capture_module
from benchmarks import wmh_rose_provider as wmh
from benchmarks.experiential_bridge import build_provider_bridge
from providers.demo_cache import client as cache
from providers.rose.client import RoseClient
from providers.rose.types import StreamChunk

root, port = Path(sys.argv[1]), int(sys.argv[2])
cache.ensure_context = AsyncMock(return_value=None)
usage = wmh.RoseUsageAccumulator()
provider = wmh.RoseWMHProvider(pool="rose-1-flash", protocol=wmh.TIMED_DISTRIBUTION_PROTOCOL, usage=usage)
provider._lease_auth = AsyncMock(return_value=(None, None))
wmh._cost_usd_for_call = lambda model, prompt, completion: prompt * (2 if "luna" in model else 1)


async def once(self, **kwargs):
    fallback = bool(kwargs.get("_skip_models"))
    model = "qwen-3.8-27b" if fallback else "gpt-5.6-luna-foundry"
    call = wmh._prediction_call_ids(kwargs["messages"], wmh.TIMED_DISTRIBUTION_PROTOCOL)[0]
    if fallback:
        binding = capture_module.REJECTION_RECORDER.get().payload
        single = json.loads(
            (root / "native-predictions" / binding["session_id"] / (binding["prediction_id"] + ".json")).read_text()
        )
        assert single["schema"] == "rose.wmh_native_prediction.v1"
        assert single["capture_pending"] is True
        assert len(single["provider_attempts"]) == 1
        assert single["provider_attempts"][0]["content"] == '{"private-rejected-marker"'
    (root / "mock-provider-attempts.jsonl").open("a").write(json.dumps({"model": model, "fallback": fallback}) + "\n")
    text = '{"private-rejected-marker"'
    if fallback and not (root / "exhaust").exists():
        text = json.dumps(
            {
                "schema": "rose.wmh_timed_outcome_distribution.v1",
                "outcomes": [
                    {
                        "id": "valid",
                        "probability": 1,
                        "elapsed_ms": 1000,
                        "description": "offline result",
                        "tool_results": [
                            {
                                "call_id": call,
                                "content": "HTTP503 from offline observed result"
                                if (root / "replay-negative").exists()
                                else "valid observed result",
                                "is_error": (root / "replay-negative").exists(),
                            }
                        ],
                        "state_patch": [],
                    }
                ],
            }
        )
    yield StreamChunk(kind="metadata", data={"actual_model": model})
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


RoseClient._complete_once = once
_original_run = subprocess.run


def held_writer(command, **kwargs):
    if "benchmarks.wmh_provider_capture" in command:
        command = [
            "benchmarks.wmh_validation_recovery_writer_fixture" if value == "benchmarks.wmh_provider_capture" else value
            for value in command
        ]
    return _original_run(command, **kwargs)


capture_module.subprocess.run = held_writer
app = build_provider_bridge(
    provider,
    "offline-test-internal",
    execution_policy="rose-outcome-distribution-v3",
    runtime_config={
        "inference_pool": "rose-1-flash",
        "inference_pool_sha256": "b" * 64,
        "azure_first": True,
        "exclude_failed_tool_examples": True,
        "validation_recovery": True,
    },
    capture_root=root,
    capture_python=os.environ["WMH_TEST_NATIVE_PYTHON"],
)
uvicorn.run(app, host="127.0.0.1", port=port, log_level="error")
