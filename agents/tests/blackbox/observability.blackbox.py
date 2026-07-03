"""Blackbox tests for LLM context dump observability."""

import base64
import gzip
import hashlib
import json
import os
import tempfile
from pathlib import Path

from _test_utils import BlackboxResult, teardown_mock


class _CaptureLogger:
    def __init__(self):
        self.events = []

    def info(self, event, **kwargs):
        self.events.append((event, kwargs))

    def warning(self, event, **kwargs):
        self.events.append((event, kwargs))


def _decode_event_payload(event):
    payload_bytes = gzip.decompress(base64.b64decode(event["payload_gzip_b64"]))
    assert hashlib.sha256(payload_bytes).hexdigest() == event["payload_sha256"]
    return json.loads(payload_bytes.decode("utf-8"))


def test_prod_llm_context_dump_emits_clickhouse_payload_and_update():
    import helpers.observability as observability

    old_logger = observability.logger
    old_is_prod = observability._IS_PRODUCTION
    old_env = {
        "LLM_CONTEXT_DUMP_PROD": os.environ.get("LLM_CONTEXT_DUMP_PROD"),
        "LLM_CONTEXT_DUMP_MAX_BYTES": os.environ.get("LLM_CONTEXT_DUMP_MAX_BYTES"),
    }
    capture = _CaptureLogger()
    try:
        observability.logger = capture
        observability._IS_PRODUCTION = True
        os.environ.pop("LLM_CONTEXT_DUMP_PROD", None)
        os.environ["LLM_CONTEXT_DUMP_MAX_BYTES"] = "100000"

        path = observability.dump_llm_context(
            "explore_agent",
            [{"role": "user", "content": "full repro prompt"}],
            agent_id="agent-1",
            model="rose-labs/rose-1-lite",
            config={"deadline_s": 170},
            tools=[{"name": "web_search"}],
        )

        assert path is not None
        assert path.startswith("clickhouse://llm-context/agent-1/")
        dumped = next(payload for event, payload in capture.events if event == "llm.context.dumped")
        decoded = _decode_event_payload(dumped)
        assert decoded["agent_id"] == "agent-1"
        assert decoded["call_site"] == "explore_agent"
        assert decoded["messages"][0]["content"] == "full repro prompt"
        assert decoded["config"]["deadline_s"] == 170

        observability.update_llm_dump(path, model="gpt-5.4-gpt", output={"error": {"type": "RoseDeadlineError"}})
        updated = next(payload for event, payload in capture.events if event == "llm.context.dump_updated")
        update_payload = _decode_event_payload(updated)
        assert update_payload["dump_id"] == decoded["dump_id"]
        assert update_payload["output"]["error"]["type"] == "RoseDeadlineError"
    finally:
        observability.logger = old_logger
        observability._IS_PRODUCTION = old_is_prod
        for key, value in old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def test_prod_llm_context_dump_kill_switch():
    import helpers.observability as observability
    import helpers.trace_archive as trace_archive

    old_logger = observability.logger
    old_is_prod = observability._IS_PRODUCTION
    old_archive_root = trace_archive._LOCAL_ROOT
    old_env = {
        "LLM_CONTEXT_DUMP_PROD": os.environ.get("LLM_CONTEXT_DUMP_PROD"),
        "TRACE_ARCHIVE_ENABLED": os.environ.get("TRACE_ARCHIVE_ENABLED"),
        "TRACE_ARCHIVE_BACKEND": os.environ.get("TRACE_ARCHIVE_BACKEND"),
    }
    capture = _CaptureLogger()
    with tempfile.TemporaryDirectory() as tmp:
        try:
            observability.logger = capture
            observability._IS_PRODUCTION = True
            trace_archive._LOCAL_ROOT = Path(tmp)
            os.environ["LLM_CONTEXT_DUMP_PROD"] = "0"
            os.environ["TRACE_ARCHIVE_ENABLED"] = "1"
            os.environ["TRACE_ARCHIVE_BACKEND"] = "local"

            path = observability.dump_llm_context(
                "explore_agent",
                [{"role": "user", "content": "sensitive prompt"}],
                agent_id="agent-1",
                model="rose-labs/rose-1-lite",
            )

            assert path is not None
            assert Path(path).exists()
            assert capture.events == []
        finally:
            observability.logger = old_logger
            observability._IS_PRODUCTION = old_is_prod
            trace_archive._LOCAL_ROOT = old_archive_root
            for key, value in old_env.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


def test_agent_context_materializes_clickhouse_dump_events():
    from benchmarks import agent_context

    agent_id = "agent-1"
    start_payload = {
        "agent_id": agent_id,
        "span_id": "span-1",
        "dump_id": "dump-1",
        "call_site": "explore_agent",
        "model": "rose-labs/rose-1-lite",
        "message_count": 1,
        "messages": [{"role": "user", "content": "prompt"}],
    }
    update_payload = {
        "agent_id": agent_id,
        "span_id": "span-1",
        "dump_id": "dump-1",
        "model": "gpt-5.4-gpt",
        "output": {"error": {"type": "RoseDeadlineError"}},
    }

    def event(name, payload):
        payload_bytes = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        return {
            "event": name,
            "payload_encoding": "gzip+base64",
            "payload_sha256": hashlib.sha256(payload_bytes).hexdigest(),
            "payload_gzip_b64": base64.b64encode(gzip.compress(payload_bytes)).decode("ascii"),
        }

    with tempfile.TemporaryDirectory() as tmp:
        old_dump_dir = agent_context.DUMP_DIR
        try:
            agent_context.DUMP_DIR = Path(tmp)
            count = agent_context.materialize_dump_events(
                agent_id,
                [
                    event("llm.context.dumped", start_payload),
                    event("llm.context.dump_updated", update_payload),
                ],
            )
            assert count == 1
            dumps = agent_context.find_dumps(agent_id)
            assert len(dumps) == 1
            parsed = json.loads(dumps[0].read_text())
            assert parsed["messages"][0]["content"] == "prompt"
            assert parsed["model"] == "gpt-5.4-gpt"
            assert parsed["output"]["error"]["type"] == "RoseDeadlineError"
        finally:
            agent_context.DUMP_DIR = old_dump_dir


async def run_all_tests():
    print("observability blackbox tests:")
    r = BlackboxResult()
    r.record("prod_llm_context_clickhouse_payload", test_prod_llm_context_dump_emits_clickhouse_payload_and_update)
    r.record("prod_llm_context_kill_switch", test_prod_llm_context_dump_kill_switch)
    r.record("agent_context_materializes_clickhouse_events", test_agent_context_materializes_clickhouse_dump_events)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    import asyncio

    asyncio.run(run_all_tests())
