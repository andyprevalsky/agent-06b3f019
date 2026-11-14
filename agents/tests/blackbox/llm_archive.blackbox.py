"""Blackbox tests: lossless schema-v2 LLM archive records (Python writer).

Contract: shared/llm-archive-record/record.schema.json. Every model call is
archived as an `llm/<dump_id>` start record and an `llm-updates/<dump_id>-…`
final record in the ROOT agent's bundle, regardless of payload size, the
ClickHouse log copy, queue pressure or caller context.

Regressions (RCA 2026-11-14, prod: 503/503 execute_loop, 35/35
verifier_browser and 28/28 explore_agent calls with >1 MB input lost their
output in 30 days; ~2,700 records/month landed in `trace-archive/unbound/`):
  - large_input_call_archives_final_output: the output record used to be
    coupled to the ClickHouse pointer, which is None above 1 MB.
  - kill_switch_keeps_final_output: LLM_CONTEXT_DUMP_PROD=0 dropped outputs.
  - unbound_records_are_refused: no `unbound` bundle, loud log + counter.
  - activity_records_land_in_workflow_root: Temporal activities had no root.
  - saturated_queue_spills_durably / compressed_size_limit_is_explicit.
"""

import asyncio
import base64
import json
import os
import tempfile
import uuid
from contextlib import contextmanager
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

import httpx
import structlog

from _test_utils import BlackboxResult, set_mock_handler, teardown_mock

REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_PATH = REPO_ROOT / "shared" / "llm-archive-record" / "record.schema.json"


class _CaptureLogger:
    def __init__(self):
        self.events = []

    def _log(self, level):
        def log(event, **kwargs):
            self.events.append((level, event, kwargs))

        return log

    def __getattr__(self, level):
        return self._log(level)


def _validator():
    from jsonschema import Draft202012Validator

    schema = json.loads(SCHEMA_PATH.read_text())
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


@contextmanager
def _archive(*, clickhouse=True, max_bytes=None):
    """Production observability writing to a private local archive directory."""
    import helpers.observability as observability
    import helpers.trace_archive as trace_archive

    keys = (
        "TRACE_ARCHIVE_ENABLED",
        "TRACE_ARCHIVE_BACKEND",
        "TRACE_ARCHIVE_ASYNC_WRITES",
        "TRACE_ARCHIVE_MAX_ARTIFACT_BYTES",
        "LLM_CONTEXT_DUMP_PROD",
        "LLM_CONTEXT_DUMP_MAX_BYTES",
        "FLY_APP_NAME",
        "ENVIRONMENT",
    )
    old_env = {key: os.environ.get(key) for key in keys}
    old_root, old_prod, old_logger = trace_archive._LOCAL_ROOT, observability._IS_PRODUCTION, observability.logger
    capture = _CaptureLogger()
    with tempfile.TemporaryDirectory() as tmp:
        try:
            trace_archive._LOCAL_ROOT = Path(tmp)
            observability._IS_PRODUCTION = True
            observability.logger = capture
            for key in ("FLY_APP_NAME", "ENVIRONMENT", "TRACE_ARCHIVE_ASYNC_WRITES", "LLM_CONTEXT_DUMP_MAX_BYTES"):
                os.environ.pop(key, None)
            os.environ.update({"TRACE_ARCHIVE_ENABLED": "1", "TRACE_ARCHIVE_BACKEND": "local"})
            if clickhouse:
                os.environ.pop("LLM_CONTEXT_DUMP_PROD", None)
            else:
                os.environ["LLM_CONTEXT_DUMP_PROD"] = "0"
            if max_bytes is not None:
                os.environ["TRACE_ARCHIVE_MAX_ARTIFACT_BYTES"] = str(max_bytes)
            else:
                os.environ.pop("TRACE_ARCHIVE_MAX_ARTIFACT_BYTES", None)
            structlog.contextvars.clear_contextvars()
            yield Path(tmp), capture
        finally:
            structlog.contextvars.clear_contextvars()
            trace_archive._LOCAL_ROOT, observability._IS_PRODUCTION = old_root, old_prod
            observability.logger = old_logger
            for key, value in old_env.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


def _read(root_dir: Path, root: str, folder: str) -> list[dict]:
    from helpers.trace_archive import decrypt_and_validate_artifact, read_local_artifact

    bundle = root_dir / root / folder
    out = []
    for item in sorted(bundle.glob("*.json.gz.enc")) if bundle.exists() else []:
        stored = read_local_artifact(root_agent_id=root, path=f"{folder}/{item.name}")
        assert stored is not None, item
        out.append(json.loads(decrypt_and_validate_artifact(*stored)))
    return out


def _sse(payloads):
    lines = []
    for payload in payloads:
        lines += [f"data: {json.dumps(payload)}", ""]
    return "\n".join(lines + ["data: [DONE]", ""])


async def test_large_input_call_archives_final_output():
    """>1 MB input: the start AND final (output) record land in the root bundle."""
    from providers.rose import RoseClient

    sse = _sse(
        [
            {"choices": [{"delta": {"content": "hello"}, "finish_reason": "stop"}]},
            {
                "usage": {
                    "prompt_tokens": 300_000,
                    "completion_tokens": 9,
                    "total_tokens": 300_009,
                    "completion_tokens_details": {"reasoning_tokens": 4},
                }
            },
        ]
    )
    set_mock_handler(lambda request: httpx.Response(200, text=sse, headers={"Content-Type": "text/event-stream"}))
    big = "x" * 1_200_000
    validator = _validator()
    with _archive() as (root_dir, capture), patch.dict(os.environ, {"CEREBRAS_API_KEY": ""}):
        os.environ.pop("CEREBRAS_API_KEY", None)
        structlog.contextvars.bind_contextvars(root_agent_id="root-agent")
        response = await RoseClient(openrouter_key="ork-x").collect(
            pool="rose-1-flash",
            messages=[{"role": "user", "content": big}],
            agent_id="explore-child",
            call_site="explore_agent",
        )
        assert response.content == "hello"
        skipped = [event for _, event, _ in capture.events if event == "llm.context.dump_skipped"]
        assert skipped, "fixture must exceed the 1 MB ClickHouse log cap"
        starts = _read(root_dir, "root-agent", "llm")
        finals = _read(root_dir, "root-agent", "llm-updates")
        assert not (root_dir / "explore-child").exists(), "sub-agent calls belong to the root bundle"
    teardown_mock()
    assert len(starts) == 1 and len(finals) == 1, (len(starts), len(finals))
    start, final = starts[0], finals[0]
    assert start["record"] == "start" and final["record"] == "final"
    assert start["messages"][0]["content"] == big
    assert start["dump_id"] == final["dump_id"] and start["span_id"] == final["span_id"]
    assert final["agent_id"] == "explore-child" and final["root_agent_id"] == "root-agent"
    assert final["output"]["content"] == "hello"
    usage = final["output"]["usage"]
    assert (usage["prompt"], usage["completion"], usage["total"], usage["reasoning"]) == (300_000, 9, 300_009, 4)
    for record in (start, final):
        errors = sorted(validator.iter_errors(record), key=str)
        assert not errors, [error.message for error in errors]


def test_kill_switch_keeps_final_output():
    """LLM_CONTEXT_DUMP_PROD=0 disables only the ClickHouse copy, never the archive."""
    import helpers.observability as observability

    with _archive(clickhouse=False) as (root_dir, capture):
        handle = observability.dump_llm_context(
            "execute_loop", [{"role": "user", "content": "go"}], agent_id="root-1", model="rose-1-ultra"
        )
        assert handle and handle.startswith("llm-archive://"), handle
        observability.update_llm_dump(handle, model="claude-opus-5-claude", output={"content": "done"})
        assert not [event for _, event, _ in capture.events if event.startswith("llm.context.dump")]
        finals = _read(root_dir, "root-1", "llm-updates")
    assert len(finals) == 1 and finals[0]["output"]["content"] == "done"
    assert finals[0]["model"] == "claude-opus-5-claude" and finals[0]["call_site"] == "execute_loop"


def test_records_match_shared_schema_with_reasoning_and_attempts():
    """Start/final records validate against the shared v2 schema, incl. reasoning fidelity."""
    import helpers.observability as observability

    validator = _validator()
    blocks = [
        {"type": "anthropic_thinking", "text": "think", "signature": "sig-1"},
        {"type": "anthropic_redacted_thinking", "data": "opaque"},
        {"type": "openrouter_reasoning_detail", "raw": {"type": "reasoning.encrypted", "data": "enc"}},
    ]
    with _archive() as (root_dir, _):
        structlog.contextvars.bind_contextvars(agent_id="child-1", root_agent_id="root-2", span_id="span-1")
        handle = observability.dump_llm_context(
            "planner",
            [{"role": "system", "content": "s"}, {"role": "user", "content": "u"}],
            model="rose-1-ultra",
            config={"pool": "rose-1-ultra"},
            tools=[{"name": "plan"}, {"name": "get_memories", "context_only": True}],
        )
        observability.update_llm_dump(
            handle,
            model="claude-opus-5-claude",
            output={
                "content": "",
                "reasoning": "think",
                "reasoning_blocks": blocks,
                "codex_reasoning_items": [{"type": "reasoning", "id": "rs_1", "encrypted_content": "e"}],
                "tool_calls": [{"id": "t1", "name": "plan", "arguments": {"steps": []}}],
                "usage": {"input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 7},
                "actual_model": "claude-opus-5-claude",
            },
            attempts=[{"model": "gpt-6-sol", "outcome": "lost_race", "output": {"content": "late"}}],
        )
        start = _read(root_dir, "root-2", "llm")[0]
        final = _read(root_dir, "root-2", "llm-updates")[0]
    assert start["tools"][1]["name"] == "get_memories"
    output = final["output"]
    assert output["reasoning_blocks"][:3] == blocks
    assert output["reasoning_blocks"][3]["type"] == "openai_reasoning_item"
    assert output["usage"]["prompt"] == 10 and output["usage"]["cache_read"] == 7
    assert final["attempts"][0]["output"]["content"] == "late"
    for record in (start, final):
        errors = sorted(validator.iter_errors(record), key=str)
        assert not errors, [error.message for error in errors]
    for bad in ({**final, "root_agent_id": "unbound"}, {**final, "output": None}, {**start, "schema_version": 1}):
        assert list(validator.iter_errors(bad)), "schema must reject unbound/incomplete records"


def test_legacy_and_v2_records_feed_the_wmh_reader():
    """The WMH corpus reader accepts v2 final records (tool calls from the update)."""
    import helpers.observability as observability
    from benchmarks import world_model_harness as wmh

    with _archive() as (root_dir, _):
        handle = observability.dump_llm_context("execute_loop", [{"role": "user", "content": "u"}], agent_id="root-3")
        observability.update_llm_dump(
            handle, output={"content": "", "tool_calls": [{"id": "c1", "name": "web_search", "arguments": "{}"}]}
        )
        with patch.object(wmh, "bundle_agent_ids", return_value=["root-3"]):
            transitions = wmh._transitions_from_llm_dumps("root-3", "none", {})
    names = [transition.action.name for transition in transitions]
    assert names == ["web_search"], names


def test_unbound_records_are_refused():
    """No agent identity: refused with an error log + counter, never `unbound/`."""
    import helpers.observability as observability
    import helpers.trace_archive as trace_archive
    from helpers.llm_archive_record import archive_counters

    with _archive() as (root_dir, capture):
        before = archive_counters().get("unbound_refused", 0)
        assert observability.dump_llm_context("wait_for_condition", [{"role": "user", "content": "?"}]) is None
        assert any(level == "error" and event == "llm.archive.unbound_refused" for level, event, _ in capture.events)
        assert trace_archive.archive_json(root_agent_id="unbound", path="llm/x.json.gz.enc", payload={}) is None
        assert trace_archive.archive_json(root_agent_id="", path="llm/y.json.gz.enc", payload={}) is None
        assert archive_counters().get("unbound_refused", 0) == before + 3
        assert not list(root_dir.iterdir()), list(root_dir.iterdir())


async def test_activity_records_land_in_workflow_root():
    """Activities inherit the workflow's agent and tree root through Temporal headers."""
    from temporalio import activity
    from temporalio.testing import WorkflowEnvironment
    from temporalio.worker import Worker

    import helpers.observability as observability
    from _archive_identity_wf import ArchiveIdentityProbe
    from helpers.archive_identity import production_worker_interceptors
    from helpers.tracing import current_bound_root_agent_id, traced
    from helpers.workflow_sandbox import production_workflow_runner

    @activity.defn(name="archive_identity_no_agent_activity")
    async def no_agent(label: str) -> dict:
        observability.dump_llm_context(
            f"probe_{label}", [{"role": "user", "content": label}], output={"content": label}
        )
        return {"root": current_bound_root_agent_id()}

    @activity.defn(name="archive_identity_sub_agent_activity")
    @traced("archive_identity_sub_agent")
    async def sub_agent(agent_id: str) -> dict:
        observability.dump_llm_context("probe_sub_agent", [{"role": "user", "content": "s"}], output={"content": "s"})
        return {"root": current_bound_root_agent_id()}

    with _archive(clickhouse=False) as (root_dir, _):
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue="archive-identity",
                workflows=[ArchiveIdentityProbe],
                activities=[no_agent, sub_agent],
                workflow_runner=production_workflow_runner(),
                interceptors=production_worker_interceptors(),
            ):
                result = await env.client.execute_workflow(
                    ArchiveIdentityProbe.run,
                    args=["child-agent", "root-agent"],
                    id=f"archive-identity-{uuid.uuid4()}",
                    task_queue="archive-identity",
                    execution_timeout=timedelta(seconds=60),
                )
        finals = _read(root_dir, "root-agent", "llm-updates")
        bundles = sorted(item.name for item in root_dir.iterdir())
    assert [row["root"] for row in result] == ["root-agent"] * 3, result
    assert bundles == ["root-agent"], bundles
    by_site = {final["call_site"]: final for final in finals}
    assert sorted(by_site) == ["probe_condition", "probe_local", "probe_sub_agent"], sorted(by_site)
    assert by_site["probe_condition"]["agent_id"] == "child-agent", "no-arg activities act as the workflow agent"
    assert by_site["probe_local"]["agent_id"] == "child-agent"
    assert by_site["probe_sub_agent"]["agent_id"] == "explore-child", "explicit activity agent ids still win"


async def test_saturated_queue_spills_durably():
    """A full async queue persists the artifact (local) or its encrypted outbox pair (R2)."""
    import helpers.trace_archive as trace_archive
    from helpers.llm_archive_record import archive_counters

    with _archive() as (root_dir, _):
        os.environ["TRACE_ARCHIVE_ASYNC_WRITES"] = "1"
        held = []
        while trace_archive._ARCHIVE_SLOTS.acquire(blocking=False):
            held.append(True)
        try:
            before = archive_counters().get("queue_spilled", 0)
            result = trace_archive.archive_json(root_agent_id="root-s", path="llm/spill.json.gz.enc", payload={"n": 1})
            assert result is not None
            assert trace_archive.read_local_artifact(root_agent_id="root-s", path="llm/spill.json.gz.enc") is not None

            posts = []

            class _Client:
                is_closed = False

                def __init__(self, *args, **kwargs):
                    pass

                def post(self, *args, **kwargs):
                    posts.append(kwargs)
                    raise AssertionError("a spill must not do network I/O on the caller thread")

            with (
                patch.dict(
                    os.environ,
                    {
                        "FLY_APP_NAME": "rose-agent-test",
                        "TRACE_ARCHIVE_BACKEND": "r2",
                        "TRACE_ARCHIVE_ENCRYPTION_KEY_B64": base64.b64encode(b"7" * 32).decode("ascii"),
                    },
                ),
                patch.object(trace_archive.httpx, "Client", _Client),
            ):
                trace_archive._BACKEND_CLIENTS.client = None
                result = trace_archive.archive_json(root_agent_id="root-s", path="llm/r2.json.gz.enc", payload={"n": 2})
            trace_archive._BACKEND_CLIENTS.client = None
            assert result is not None and posts == []
            outbox = root_dir.parent / "trace-archive-outbox" / "root-s" / "llm" / "r2.json.gz.enc"
            assert outbox.exists() and outbox.with_suffix(outbox.suffix + ".meta.json").exists()
            assert archive_counters().get("queue_spilled", 0) == before + 2
            outbox.unlink()
            outbox.with_suffix(outbox.suffix + ".meta.json").unlink()
        finally:
            for _ in held:
                trace_archive._ARCHIVE_SLOTS.release()


def test_compressed_size_limit_is_explicit():
    """The artifact limit bounds the encrypted body; overflow is an error + counter."""
    import helpers.trace_archive as trace_archive
    from helpers.llm_archive_record import archive_counters

    with _archive(max_bytes=4096) as (root_dir, _):
        old_logger = trace_archive.logger
        capture = _CaptureLogger()
        trace_archive.logger = capture
        try:
            before = archive_counters().get("artifact_too_large", 0)
            big_json = {"messages": [{"role": "user", "content": "repeat " * 20_000}]}
            assert trace_archive.archive_json(root_agent_id="root-z", path="llm/big.json.gz.enc", payload=big_json)
            noise = os.urandom(8192)
            assert trace_archive.archive_bytes(root_agent_id="root-z", path="media/noise.bin", body=noise) is None, (
                "an artifact above the encrypted limit must be rejected"
            )
            rejected = [kw for level, event, kw in capture.events if event == "trace_archive.artifact_too_large"]
            assert rejected and rejected[0]["limit"] == 4096 and rejected[0]["ciphertext_bytes"] > 4096
            assert [level for level, event, _ in capture.events if event == "trace_archive.artifact_too_large"] == [
                "error"
            ]
            assert archive_counters().get("artifact_too_large", 0) == before + 1
        finally:
            trace_archive.logger = old_logger


async def test_benchmark_warmup_records_land_in_the_created_root():
    """The pre-run cache warmup is archived under the root id the benchmark then creates."""
    import benchmarks.cache_warmup as cache_warmup
    import benchmarks.run_benchmark as run_benchmark
    import helpers.observability as observability
    from benchmarks.benchmark_tasks import BenchmarkTask

    task = BenchmarkTask(
        name="archive-warmup-probe",
        title="Archive warmup probe",
        prompt="goal",
        timeout_seconds=1,
        is_chat_mode=False,
        expected_tools=[],
        tags=[],
        price_limit_cents=100,
        requires_browser_agent=False,
        requires_claude_code=False,
        attachment=None,
        approval_handling="ignore",
        start_phase="execute",
    )

    async def fake_warmup(**kwargs):
        observability.dump_llm_context("cache_warmup", [{"role": "user", "content": "warm"}], output={"content": "ok"})
        return {"call_site": "cache_warmup"}

    async def no_headers():
        return {}

    posted = []

    def handler(request):
        if request.method == "POST" and request.url.path == "/api/agents":
            body = json.loads(request.content)
            posted.append(body)
            return httpx.Response(201, json={"agent_id": body.get("agent_id") or "server-assigned"})
        return httpx.Response(200, json={})

    with _archive(clickhouse=False) as (root_dir, _):
        assert run_benchmark._cache_warmup_root_id(task) is None, "ungated tasks keep server-assigned ids"
        set_mock_handler(handler)
        with (
            patch.dict(run_benchmark.PER_TASK_CACHE_HIT_RATCHET, {task.name: 1}),
            patch.object(cache_warmup, "warm_root_static_prefix", fake_warmup),
            patch.object(run_benchmark, "_benchmark_goal_for_task", lambda *_: "goal"),
            patch.object(run_benchmark, "_api_headers", no_headers),
            patch.dict(os.environ, {"BENCHMARK_AGENT_SOURCE": "", "BENCHMARK_MODEL": ""}),
        ):
            root_id = run_benchmark._cache_warmup_root_id(task)
            assert root_id
            await run_benchmark._warm_cache_gated_root("http://localhost:3999", task, root_id)
            with run_benchmark._preassigned_root(root_id):
                created = await run_benchmark.create_agent("http://localhost:3999", task)
        teardown_mock()
        finals = _read(root_dir, root_id, "llm-updates")
        bundles = sorted(item.name for item in root_dir.iterdir())
    assert created == root_id and posted and posted[0]["agent_id"] == root_id, posted
    assert bundles == [root_id], bundles
    assert len(finals) == 1 and finals[0]["call_site"] == "cache_warmup" and finals[0]["agent_id"] == root_id
    assert getattr(task, "_wmh_agent_admission", None) is None, "a warmup id is not a WMH admission"


class _Lines:
    def __init__(self, lines):
        self._lines = lines

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    async def aclose(self):
        return None


def _contract_case(name):
    fixtures = json.loads((REPO_ROOT / "shared" / "llm-stream-contract" / "fixtures.json").read_text())
    return next(case for case in fixtures["cases"] if case["name"] == name)


async def test_parsers_capture_reasoning_fidelity():
    """Signed thinking, redacted thinking, reasoning_details and reasoning token counts reach usage."""
    from providers.rose.streaming import (
        REASONING_BLOCKS_USAGE_KEY,
        parse_anthropic_sse,
        parse_openai_sse,
        parse_responses_sse,
    )

    def event(payload):
        return [f"data: {json.dumps(payload)}", ""]

    lines = list(_contract_case("anthropic_content_reasoning_and_tool")["sse_lines"])
    stop = next(i for i, line in enumerate(lines) if '"index":0' in line and "content_block_stop" in line)
    lines[stop:stop] = event(
        {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "sig-abc"}}
    )
    lines[-1:-1] = event(
        {"type": "content_block_start", "index": 9, "content_block": {"type": "redacted_thinking", "data": "opaque"}}
    )
    kwargs = {"actual_model": "m", "pool_name": "p", "request_id": "r"}
    chunks = [chunk async for chunk in parse_anthropic_sse(_Lines(lines), **kwargs)]
    usage = next(chunk.data for chunk in chunks if chunk.kind == "usage")
    assert usage[REASONING_BLOCKS_USAGE_KEY] == [
        {"type": "anthropic_thinking", "text": "think", "signature": "sig-abc"},
        {"type": "anthropic_redacted_thinking", "data": "opaque"},
    ], usage

    openai_lines = (
        event({"choices": [{"delta": {"reasoning_details": [{"type": "reasoning.text", "index": 0, "text": "a"}]}}]})
        + event(
            {
                "choices": [
                    {
                        "delta": {
                            "content": "ok",
                            "reasoning_details": [
                                {"type": "reasoning.text", "index": 0, "text": "b", "signature": "s1"},
                                {"type": "reasoning.encrypted", "index": 1, "data": "enc", "id": "rd_1"},
                            ],
                        },
                        "finish_reason": "stop",
                    }
                ]
            }
        )
        + event(
            {
                "usage": {
                    "prompt_tokens": 3,
                    "completion_tokens": 9,
                    "total_tokens": 12,
                    "completion_tokens_details": {"reasoning_tokens": 6},
                }
            }
        )
        + ["data: [DONE]", ""]
    )
    chunks = [chunk async for chunk in parse_openai_sse(_Lines(openai_lines), **kwargs)]
    usage = next(chunk.data for chunk in chunks if chunk.kind == "usage")
    assert usage["reasoning_tokens"] == 6
    blocks = usage[REASONING_BLOCKS_USAGE_KEY]
    assert [(b["type"], b["text"], b["signature"], b["data"]) for b in blocks] == [
        ("openrouter_reasoning_detail", "ab", "s1", None),
        ("openrouter_reasoning_detail", None, None, "enc"),
    ], blocks

    responses_lines = (
        event({"type": "response.output_text.delta", "delta": "hi"})
        + event(
            {
                "type": "response.completed",
                "response": {
                    "usage": {"input_tokens": 4, "output_tokens": 7, "output_tokens_details": {"reasoning_tokens": 5}}
                },
            }
        )
        + ["data: [DONE]", ""]
    )
    chunks = [chunk async for chunk in parse_responses_sse(_Lines(responses_lines), **kwargs)]
    usage = next(chunk.data for chunk in chunks if chunk.kind == "usage")
    assert usage["reasoning_tokens"] == 5 and REASONING_BLOCKS_USAGE_KEY not in usage


async def test_reasoning_blocks_are_archived_not_returned():
    """Callers' usage never carries archive-only blocks; the final record does."""
    from providers.rose import RoseClient
    from providers.rose.streaming import REASONING_BLOCKS_USAGE_KEY

    sse = _sse(
        [
            {
                "choices": [
                    {
                        "delta": {
                            "content": "hello",
                            "reasoning_details": [{"type": "reasoning.encrypted", "index": 0, "data": "enc"}],
                        },
                        "finish_reason": "stop",
                    }
                ]
            },
            {
                "usage": {
                    "prompt_tokens": 5,
                    "completion_tokens": 3,
                    "total_tokens": 8,
                    "completion_tokens_details": {"reasoning_tokens": 2},
                }
            },
        ]
    )
    set_mock_handler(lambda request: httpx.Response(200, text=sse, headers={"Content-Type": "text/event-stream"}))
    with _archive(clickhouse=False) as (root_dir, _), patch.dict(os.environ, {"CEREBRAS_API_KEY": ""}):
        os.environ.pop("CEREBRAS_API_KEY", None)
        chunks = [
            chunk
            async for chunk in RoseClient(openrouter_key="ork-x").complete(
                pool="rose-1-flash",
                messages=[{"role": "user", "content": "hi"}],
                agent_id="root-r",
                call_site="execute_loop",
                context_tools=[{"name": "get_memories", "description": "d", "parameters": {"type": "object"}}],
            )
        ]
        usage = next(chunk.data for chunk in chunks if chunk.kind == "usage")
        start = _read(root_dir, "root-r", "llm")[0]
        final = _read(root_dir, "root-r", "llm-updates")[0]
    teardown_mock()
    assert REASONING_BLOCKS_USAGE_KEY not in usage and usage["reasoning_tokens"] == 2
    assert final["output"]["reasoning_blocks"][0]["data"] == "enc"
    assert final["output"]["usage"]["reasoning"] == 2
    assert start["config"]["context_tool_names"] == ["get_memories"]
    assert [tool.get("name") for tool in start["tools"]] == ["get_memories"], start["tools"]


async def test_non_rose_fallback_call_is_archived():
    """Direct OpenRouter SDK calls (non-Rose models) write the same v2 start/final records."""
    from helpers.llm import call_llm

    def handler(request):
        assert request.url.path.endswith("/chat/completions"), request.url
        return httpx.Response(
            200,
            json={
                "id": "gen-1",
                "object": "chat.completion",
                "created": 1,
                "model": "google/gemini-3-flash",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": "direct answer",
                            "reasoning": "why",
                            "reasoning_details": [{"type": "reasoning.text", "text": "why", "signature": "sg"}],
                        },
                    }
                ],
                "usage": {
                    "prompt_tokens": 11,
                    "completion_tokens": 4,
                    "total_tokens": 15,
                    "completion_tokens_details": {"reasoning_tokens": 2},
                },
            },
        )

    set_mock_handler(handler)
    validator = _validator()
    with _archive(clickhouse=False) as (root_dir, _):
        structlog.contextvars.bind_contextvars(root_agent_id="root-d")
        result = await call_llm(
            messages=[{"role": "user", "content": "q"}],
            model="google/gemini-3-flash",
            max_tokens=64,
            call_site="message_person",
            agent_id="child-d",
        )
        start = _read(root_dir, "root-d", "llm")
        final = _read(root_dir, "root-d", "llm-updates")
    teardown_mock()
    assert result["content"] == "direct answer"
    assert len(start) == 1 and len(final) == 1, (start, final)
    output = final[0]["output"]
    assert final[0]["agent_id"] == "child-d" and output["content"] == "direct answer"
    assert output["reasoning"] == "why" and output["reasoning_blocks"][0]["raw"]["signature"] == "sg"
    assert output["usage"]["reasoning"] == 2 and output["usage"]["prompt"] == 11
    for record in (start[0], final[0]):
        assert not list(validator.iter_errors(record)), [error.message for error in validator.iter_errors(record)]


async def test_world_model_calls_bind_the_world_root():
    """WMH predictions are archived (dump_context on) under the world's root scope.

    Native path: the experiential server forwards its session scope over the
    provider bridge's /complete. Legacy path: serve_world_model binds the scope
    in the step thread; the provider carries it onto its bridge loop thread.
    """
    from fastapi.testclient import TestClient
    from wmh.providers.base import Message

    from benchmarks.experiential_bridge import build_provider_bridge
    from benchmarks.wmh_rose_provider import RoseUsageAccumulator, RoseWMHProvider
    from helpers.tracing import archive_scope, current_bound_root_agent_id

    seen = []

    class StopClient:
        async def collect(self, **kwargs):
            seen.append((kwargs.get("dump_context"), current_bound_root_agent_id()))
            raise RuntimeError("stop after request capture")

    async def no_auth():
        return None, None

    provider = RoseWMHProvider(client=StopClient(), usage=RoseUsageAccumulator())
    provider._lease_auth = no_auth
    go = [Message(role="user", content="go")]
    for call in (
        provider.complete_scoped("sess-1", "pred-1", "SYS", go, max_tokens=16384, archive_root_agent_id="root-w"),
        provider.complete_scoped("sess-2", "pred-1", "SYS", go, max_tokens=16384),
    ):
        try:
            await call
        except RuntimeError:
            pass

    def legacy_step():
        with archive_scope("root-l"):
            provider.complete("SYS", go, max_tokens=16)

    try:
        await asyncio.to_thread(legacy_step)
    except RuntimeError:
        pass
    assert seen == [(True, "root-w"), (False, None), (True, "root-l")], seen

    forwarded = []

    class BridgeProvider:
        _usage = RoseUsageAccumulator()

        async def complete_scoped(
            self, session_id, prediction_id, system, messages, *, max_tokens, archive_root_agent_id=None
        ):
            forwarded.append(archive_root_agent_id)

            class _Usage:
                def model_dump(self):
                    return {}

            class _Result:
                text, actual_model, usage = "{}", "m", _Usage()

            return _Result()

    http = TestClient(build_provider_bridge(BridgeProvider(), "bridge-token"))
    payload = {
        "messages": [{"role": "system", "content": "s"}, {"role": "user", "content": "u"}],
        "maximum_output_tokens": 16384,
        "session_id": "sess-1",
        "prediction_id": "pred-1",
    }
    headers = {"X-Rose-Provider-Token": "bridge-token"}
    assert (
        http.post("/complete", json={**payload, "archive_root_agent_id": "root-n"}, headers=headers).status_code == 200
    )
    assert http.post("/complete", json=payload, headers=headers).status_code == 200
    bad = http.post("/complete", json={**payload, "archive_root_agent_id": "../x"}, headers=headers)
    assert bad.status_code == 422 and forwarded == ["root-n", None], forwarded


def test_legacy_world_server_binds_session_root_in_step():
    """serve_world_model steps run with the session's root scope bound for archive records."""
    from fastapi import FastAPI
    from wmh.core.types import Action
    from wmh.engine.world_model import WorldModel
    from wmh.providers.base import Completion, ProviderConfig, ProviderKind, TokenUsage

    from benchmarks import serve_world_model as server
    from helpers.tracing import current_bound_root_agent_id
    from helpers.world_model_runtime import CanonicalAction

    roots = []

    class Retriever:
        def topk(self, state, action, k):
            return []

        def add(self, step):
            pass

    class Provider:
        config = ProviderConfig(kind=ProviderKind.OPENAI, model="gpt-5")

        def complete(self, system, messages, **kwargs):
            roots.append(current_bound_root_agent_id())
            return Completion(
                text=json.dumps({"output": "sent", "state_note": "ok"}),
                usage=TokenUsage(input_tokens=1, output_tokens=1),
            )

    with tempfile.TemporaryDirectory() as tmp:
        model = WorldModel(Provider(), Retriever(), telemetry_root=tmp)
        server._install_root_scoped_sessions(FastAPI(), "rose", model)
        token = server._ROSE_SESSION_SCOPE.set("root-legacy")
        try:
            session = model.new_session(task="Send a message")
        finally:
            server._ROSE_SESSION_SCOPE.reset(token)
        action = Action.model_validate(
            CanonicalAction(
                category="message",
                name="message_transport_send",
                arguments={"id": 1},
                agent_id="child-1",
                tool_call_id="send-1",
            ).to_wmh_action()
        )
        model.step(session.id, action)
    assert roots == ["root-legacy"], roots
    assert current_bound_root_agent_id() is None, "the step must not leak its root binding"


async def test_consumer_stopping_after_done_still_archives_output():
    """A caller that stops iterating at `done` must not lose the completed call's output."""
    from providers.rose import RoseClient

    sse = _sse(
        [
            {"choices": [{"delta": {"content": "complete"}, "finish_reason": "stop"}]},
            {"usage": {"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 3}},
        ]
    )
    set_mock_handler(lambda request: httpx.Response(200, text=sse, headers={"Content-Type": "text/event-stream"}))
    with _archive(clickhouse=False) as (root_dir, _), patch.dict(os.environ, {"CEREBRAS_API_KEY": ""}):
        os.environ.pop("CEREBRAS_API_KEY", None)
        stream = RoseClient(openrouter_key="ork-x").complete(
            pool="rose-1-flash",
            messages=[{"role": "user", "content": "hi"}],
            agent_id="root-c",
            call_site="verifier_browser",
        )
        async for chunk in stream:
            if chunk.kind == "done":
                break
        await stream.aclose()
        finals = _read(root_dir, "root-c", "llm-updates")
    teardown_mock()
    assert len(finals) == 1 and finals[0]["output"]["content"] == "complete", finals


def test_nonprod_r2_publication_requires_explicit_opt_in():
    """A dev/test process never publishes traces to R2 unless TRACE_ARCHIVE_ALLOW_NONPROD_R2=1."""
    import helpers.trace_archive as trace_archive
    from helpers.llm_archive_record import archive_counters, reset_archive_counters

    posts = []

    class _Response:
        status_code = 200
        text = ""

        @staticmethod
        def json():
            return {"ref": "r2://bucket/trace-archive/root-p/llm/x.json.gz.enc"}

    class _Client:
        is_closed = False

        def __init__(self, *args, **kwargs):
            pass

        def post(self, url, headers=None, json=None, **kwargs):
            posts.append(json["path"])
            return _Response()

    assert trace_archive._DEFAULT_MAX_ARTIFACT_BYTES == 72 * 1024 * 1024
    assert trace_archive._BATCH_MAX_BYTES == 96 * 1024 * 1024 + 64 * 1024
    assert trace_archive._BATCH_MAX_CIPHERTEXT_BYTES == trace_archive._DEFAULT_MAX_ARTIFACT_BYTES
    with _archive() as (root_dir, _):
        old_logger = trace_archive.logger
        capture = _CaptureLogger()
        trace_archive.logger = capture
        env = {
            "TRACE_ARCHIVE_BACKEND": "r2",
            "TRACE_ARCHIVE_ENCRYPTION_KEY_B64": base64.b64encode(b"5" * 32).decode("ascii"),
            "BACKEND_API_URL": "https://backend.example.test",
            "BACKEND_API_KEY": "test-key",
        }
        try:
            with patch.dict(os.environ, env), patch.object(trace_archive.httpx, "Client", _Client):
                for key in (
                    "FLY_APP_NAME",
                    "FLY_MACHINE_ID",
                    "ENVIRONMENT",
                    "NODE_ENV",
                    "TRACE_ARCHIVE_ALLOW_NONPROD_R2",
                ):
                    os.environ.pop(key, None)
                trace_archive._BACKEND_CLIENTS.client = None
                # The refusal log is rate-limited per process; start from a fresh count.
                reset_archive_counters()
                before = 0
                result = trace_archive.archive_json(
                    root_agent_id="root-p", path="llm/dev.json.gz.enc", payload={"n": 1}
                )
                assert result is not None and posts == [], posts
                assert trace_archive.read_local_artifact(root_agent_id="root-p", path="llm/dev.json.gz.enc")
                refused = [kw for level, event, kw in capture.events if event == "trace_archive.nonprod_r2_refused"]
                assert refused and "TRACE_ARCHIVE_ALLOW_NONPROD_R2=1" in refused[0]["reason"], capture.events
                assert archive_counters().get("nonprod_r2_refused", 0) == before + 1

                os.environ["TRACE_ARCHIVE_ALLOW_NONPROD_R2"] = "1"
                trace_archive.archive_json(root_agent_id="root-p", path="llm/opt-in.json.gz.enc", payload={"n": 2})
                assert posts == ["llm/opt-in.json.gz.enc"], posts
                os.environ.pop("TRACE_ARCHIVE_ALLOW_NONPROD_R2")
                os.environ["FLY_MACHINE_ID"] = "machine-1"
                trace_archive.archive_json(root_agent_id="root-p", path="llm/prod.json.gz.enc", payload={"n": 3})
                assert posts[-1] == "llm/prod.json.gz.enc", posts
        finally:
            trace_archive._BACKEND_CLIENTS.client = None
            trace_archive.logger = old_logger


async def run_all_tests():
    print("llm_archive blackbox tests:")
    r = BlackboxResult()
    await r.record_async("large_input_call_archives_final_output", test_large_input_call_archives_final_output)
    r.record("kill_switch_keeps_final_output", test_kill_switch_keeps_final_output)
    r.record("records_match_shared_schema", test_records_match_shared_schema_with_reasoning_and_attempts)
    r.record("v2_records_feed_wmh_reader", test_legacy_and_v2_records_feed_the_wmh_reader)
    r.record("unbound_records_are_refused", test_unbound_records_are_refused)
    await r.record_async("activity_records_land_in_workflow_root", test_activity_records_land_in_workflow_root)
    await r.record_async("saturated_queue_spills_durably", test_saturated_queue_spills_durably)
    r.record("compressed_size_limit_is_explicit", test_compressed_size_limit_is_explicit)
    await r.record_async(
        "benchmark_warmup_lands_in_created_root", test_benchmark_warmup_records_land_in_the_created_root
    )
    await r.record_async("parsers_capture_reasoning_fidelity", test_parsers_capture_reasoning_fidelity)
    await r.record_async("reasoning_blocks_archived_not_returned", test_reasoning_blocks_are_archived_not_returned)
    await r.record_async("non_rose_fallback_call_is_archived", test_non_rose_fallback_call_is_archived)
    await r.record_async("world_model_calls_bind_the_world_root", test_world_model_calls_bind_the_world_root)
    r.record("legacy_world_server_binds_session_root", test_legacy_world_server_binds_session_root_in_step)
    await r.record_async(
        "consumer_stop_after_done_keeps_output", test_consumer_stopping_after_done_still_archives_output
    )
    r.record("nonprod_r2_requires_opt_in", test_nonprod_r2_publication_requires_explicit_opt_in)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
