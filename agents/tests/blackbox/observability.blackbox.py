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

    def error(self, event, **kwargs):
        self.events.append((event, kwargs))


def _decode_event_payload(event):
    payload_bytes = gzip.decompress(base64.b64decode(event["payload_gzip_b64"]))
    assert hashlib.sha256(payload_bytes).hexdigest() == event["payload_sha256"]
    return json.loads(payload_bytes.decode("utf-8"))


def _prod_archive_env(tmp, **env):
    """Production observability with a private local archive; returns restore()."""
    import helpers.observability as observability
    import helpers.trace_archive as trace_archive

    keys = ("LLM_CONTEXT_DUMP_PROD", "LLM_CONTEXT_DUMP_MAX_BYTES", "TRACE_ARCHIVE_ENABLED", "TRACE_ARCHIVE_BACKEND")
    old_env = {key: os.environ.get(key) for key in keys}
    old = (observability.logger, observability._IS_PRODUCTION, trace_archive._LOCAL_ROOT)
    capture = _CaptureLogger()
    observability.logger = capture
    observability._IS_PRODUCTION = True
    trace_archive._LOCAL_ROOT = Path(tmp)
    os.environ.pop("LLM_CONTEXT_DUMP_PROD", None)
    os.environ.pop("LLM_CONTEXT_DUMP_MAX_BYTES", None)
    os.environ.update({"TRACE_ARCHIVE_ENABLED": "1", "TRACE_ARCHIVE_BACKEND": "local", **env})

    def restore():
        observability.logger, observability._IS_PRODUCTION, trace_archive._LOCAL_ROOT = old
        for key, value in old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    return capture, restore


def test_prod_llm_context_dump_emits_clickhouse_payload_and_update():
    """The size-capped ClickHouse copy mirrors the archived v2 start/final records."""
    import helpers.observability as observability

    with tempfile.TemporaryDirectory() as tmp:
        capture, restore = _prod_archive_env(tmp, LLM_CONTEXT_DUMP_MAX_BYTES="100000")
        try:
            path = observability.dump_llm_context(
                "explore_agent",
                [{"role": "user", "content": "full repro prompt"}],
                agent_id="agent-1",
                model="rose-labs/rose-1-flash",
                config={"deadline_s": 170},
                tools=[{"name": "web_search"}],
            )

            assert path is not None
            assert path.startswith("llm-archive://agent-1/agent-1/"), path
            dumped = next(payload for event, payload in capture.events if event == "llm.context.dumped")
            decoded = _decode_event_payload(dumped)
            assert decoded["agent_id"] == "agent-1" and decoded["record"] == "start"
            assert decoded["call_site"] == "explore_agent"
            assert decoded["messages"][0]["content"] == "full repro prompt"
            assert decoded["config"]["deadline_s"] == 170

            observability.update_llm_dump(path, model="gpt-5.4-gpt", output={"error": {"type": "RoseDeadlineError"}})
            updated = next(payload for event, payload in capture.events if event == "llm.context.dump_updated")
            update_payload = _decode_event_payload(updated)
            assert update_payload["dump_id"] == decoded["dump_id"] and update_payload["record"] == "final"
            assert update_payload["output"]["error"]["type"] == "RoseDeadlineError"
            assert len(list((Path(tmp) / "agent-1" / "llm-updates").glob("*.enc"))) == 1
        finally:
            restore()


def test_prod_llm_context_dump_kill_switch():
    """LLM_CONTEXT_DUMP_PROD=0 silences the ClickHouse copy; the archive still records both sides."""
    import helpers.observability as observability

    with tempfile.TemporaryDirectory() as tmp:
        capture, restore = _prod_archive_env(tmp, LLM_CONTEXT_DUMP_PROD="0")
        try:
            path = observability.dump_llm_context(
                "explore_agent",
                [{"role": "user", "content": "sensitive prompt"}],
                agent_id="agent-1",
                model="rose-labs/rose-1-flash",
            )
            assert path is not None and path.startswith("llm-archive://"), path
            observability.update_llm_dump(path, output={"content": "done"})
            assert not [event for event, _ in capture.events if event.startswith("llm.context.dump")]
            assert len(list((Path(tmp) / "agent-1" / "llm").glob("*.enc"))) == 1
            assert len(list((Path(tmp) / "agent-1" / "llm-updates").glob("*.enc"))) == 1
        finally:
            restore()


def test_agent_context_materializes_clickhouse_dump_events():
    from benchmarks import agent_context

    agent_id = "agent-1"
    start_payload = {
        "agent_id": agent_id,
        "span_id": "span-1",
        "dump_id": "dump-1",
        "call_site": "explore_agent",
        "model": "rose-labs/rose-1-flash",
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


def test_prod_llm_context_dump_skips_oversize_payload():
    """An oversize payload skips only the ClickHouse log copy, never the archive handle."""
    import helpers.observability as observability

    with tempfile.TemporaryDirectory() as tmp:
        # Floor is clamped to 10_000, so exceed that with a large message body.
        capture, restore = _prod_archive_env(tmp, LLM_CONTEXT_DUMP_MAX_BYTES="10000")
        try:
            path = observability.dump_llm_context(
                "explore_agent",
                [{"role": "user", "content": "x" * 20_000}],
                agent_id="agent-1",
                model="rose-labs/rose-1-flash",
            )

            assert path is not None and path.startswith("llm-archive://"), path
            skipped = next(payload for event, payload in capture.events if event == "llm.context.dump_skipped")
            assert skipped["reason"] == "payload_too_large"
            assert skipped["agent_id"] == "agent-1"
            assert skipped["payload_bytes"] > skipped["max_bytes"]
            assert len(list((Path(tmp) / "agent-1" / "llm").glob("*.enc"))) == 1
        finally:
            restore()


def test_same_millisecond_local_dumps_keep_distinct_handles():
    """CodeRabbit 4576377086: two calls sharing agent, span, call site and millisecond must not
    share a local handle, or the second start overwrites the first call's dump_id."""
    from unittest.mock import patch

    import structlog

    import helpers.observability as observability
    import helpers.trace_archive as trace_archive

    old = (observability.logger, observability._IS_PRODUCTION, observability._DUMP_ROOT, trace_archive._LOCAL_ROOT)
    old_env = {key: os.environ.get(key) for key in ("TRACE_ARCHIVE_ENABLED", "TRACE_ARCHIVE_BACKEND")}
    with tempfile.TemporaryDirectory() as tmp:
        tokens = structlog.contextvars.bind_contextvars(
            root_agent_id="root-ms", agent_id="root-ms", span_id="span0000ms01"
        )
        try:
            observability.logger = _CaptureLogger()
            observability._IS_PRODUCTION = False
            observability._DUMP_ROOT = Path(tmp) / "dumps"
            trace_archive._LOCAL_ROOT = Path(tmp) / "archive"
            os.environ.update({"TRACE_ARCHIVE_ENABLED": "1", "TRACE_ARCHIVE_BACKEND": "local"})
            with patch.object(observability.time, "time", return_value=1_800_000_000.123):
                first = observability.dump_llm_context("planner", [{"role": "user", "content": "one"}], model="m")
                second = observability.dump_llm_context("planner", [{"role": "user", "content": "two"}], model="m")
            assert first and second and first != second, (first, second)
            first_doc, second_doc = json.loads(Path(first).read_text()), json.loads(Path(second).read_text())
            assert first_doc["messages"][0]["content"] == "one" and second_doc["messages"][0]["content"] == "two"
            assert first_doc["dump_id"] != second_doc["dump_id"]
            # The span prefix and call_site segment still parse for agent_context filters.
            from benchmarks.agent_context import parse_dump_filename

            meta = parse_dump_filename(Path(first))
            assert meta["span_id"].startswith("span0000ms01") and meta["call_site"] == "planner", meta
            assert meta["dump_id"] == first_doc["dump_id"], meta
        finally:
            structlog.contextvars.reset_contextvars(**tokens)
            observability.logger, observability._IS_PRODUCTION, observability._DUMP_ROOT, trace_archive._LOCAL_ROOT = (
                old
            )
            for key, value in old_env.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


def test_update_llm_dump_merges_local_file_and_handles_edge_paths():
    import helpers.observability as observability
    import helpers.trace_archive as trace_archive

    old_logger = observability.logger
    old_is_prod = observability._IS_PRODUCTION
    old_archive_root = trace_archive._LOCAL_ROOT
    old_env = {
        "TRACE_ARCHIVE_ENABLED": os.environ.get("TRACE_ARCHIVE_ENABLED"),
        "TRACE_ARCHIVE_BACKEND": os.environ.get("TRACE_ARCHIVE_BACKEND"),
    }
    capture = _CaptureLogger()
    with tempfile.TemporaryDirectory() as tmp:
        try:
            observability.logger = capture
            observability._IS_PRODUCTION = False
            trace_archive._LOCAL_ROOT = Path(tmp)
            os.environ["TRACE_ARCHIVE_ENABLED"] = "1"
            os.environ["TRACE_ARCHIVE_BACKEND"] = "local"

            # A falsy path is a no-op (never raises, never logs).
            observability.update_llm_dump(None, model="ignored")
            observability.update_llm_dump("", model="ignored")
            assert capture.events == []

            # Seed a local dump, then merge late-arriving Rose response details.
            dump_path = Path(tmp) / "dump-1.json"
            dump_path.write_text(
                json.dumps(
                    {
                        "agent_id": "agent-1",
                        "dump_id": "dump-1",
                        "call_site": "planner",
                        "config": {"temperature": 0.2},
                        "messages": [{"role": "user", "content": "hi"}],
                    }
                )
            )
            observability.update_llm_dump(
                str(dump_path),
                model="rose-labs/rose-1-ultra",
                config={"max_tokens": 1024},
                response_format={"type": "json_object"},
                tools=[{"name": "web_search"}],
                output={"text": "done"},
                extra={"call_site": "planner", "actual_model": "claude-sonnet-5-claude"},
            )
            merged = json.loads(dump_path.read_text())
            assert merged["model"] == "rose-labs/rose-1-ultra"
            # config is merged, not replaced.
            assert merged["config"] == {"temperature": 0.2, "max_tokens": 1024}
            assert merged["response_format"] == {"type": "json_object"}
            assert merged["tools"] == [{"name": "web_search"}]
            assert merged["output"] == {"text": "done"}
            assert merged["extra"]["actual_model"] == "claude-sonnet-5-claude"
            # Local archive is enabled, so the update records an archive ref.
            assert merged["archive_updates"]

            # A missing file is swallowed best-effort and logs a warning.
            observability.update_llm_dump(str(Path(tmp) / "missing.json"), model="x")
            assert any(e[0] == "llm.context.dump_update_failed" for e in capture.events)
        finally:
            observability.logger = old_logger
            observability._IS_PRODUCTION = old_is_prod
            trace_archive._LOCAL_ROOT = old_archive_root
            for key, value in old_env.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


async def run_all_tests():
    print("observability blackbox tests:")
    r = BlackboxResult()
    r.record("prod_llm_context_clickhouse_payload", test_prod_llm_context_dump_emits_clickhouse_payload_and_update)
    r.record("prod_llm_context_kill_switch", test_prod_llm_context_dump_kill_switch)
    r.record("agent_context_materializes_clickhouse_events", test_agent_context_materializes_clickhouse_dump_events)
    r.record("prod_llm_context_skips_oversize", test_prod_llm_context_dump_skips_oversize_payload)
    r.record("update_llm_dump_merges_local_file", test_update_llm_dump_merges_local_file_and_handles_edge_paths)
    r.record("same_millisecond_local_dumps_distinct", test_same_millisecond_local_dumps_keep_distinct_handles)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    import asyncio

    asyncio.run(run_all_tests())
