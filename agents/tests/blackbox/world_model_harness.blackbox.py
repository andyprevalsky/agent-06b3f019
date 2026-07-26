"""Blackbox tests for Rose archive -> World Model Harness integration."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import types
import importlib.util
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import httpx

from _test_utils import BlackboxResult, setup_mock_fn, teardown_mock


def _with_archive_env(tmp: str):
    import benchmarks.world_model_harness as wmh_bridge
    import helpers.trace_archive as trace_archive

    old_trace_root = trace_archive._LOCAL_ROOT
    old_bridge_root = wmh_bridge._LOCAL_ARCHIVE_ROOT
    old_env = {key: os.environ.get(key) for key in ["TRACE_ARCHIVE_ENABLED", "TRACE_ARCHIVE_BACKEND"]}
    trace_archive._LOCAL_ROOT = Path(tmp)
    wmh_bridge._LOCAL_ARCHIVE_ROOT = Path(tmp)
    os.environ["TRACE_ARCHIVE_ENABLED"] = "1"
    os.environ["TRACE_ARCHIVE_BACKEND"] = "local"

    def restore():
        trace_archive._LOCAL_ROOT = old_trace_root
        wmh_bridge._LOCAL_ARCHIVE_ROOT = old_bridge_root
        for key, value in old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    return restore


def _load_upstream_otel_adapter_class():
    import enum

    if not hasattr(enum, "StrEnum"):

        class StrEnum(str, enum.Enum):
            def __str__(self) -> str:
                return str(self.value)

        enum.StrEnum = StrEnum
    if sys.version_info < (3, 11) and "tomllib" not in sys.modules:
        try:
            import tomli

            sys.modules["tomllib"] = tomli
        except ModuleNotFoundError:
            pass
    reference = Path(__file__).resolve().parents[3] / ".context" / "reference" / "world-model-harness"
    if not reference.exists():
        from wmh.ingest.otel_genai import OtelGenAIAdapter

        return OtelGenAIAdapter

    wmh_pkg = types.ModuleType("wmh")
    wmh_pkg.__path__ = [str(reference / "wmh")]
    core_pkg = types.ModuleType("wmh.core")
    core_pkg.__path__ = [str(reference / "wmh" / "core")]
    ingest_pkg = types.ModuleType("wmh.ingest")
    ingest_pkg.__path__ = [str(reference / "wmh" / "ingest")]
    sys.modules["wmh"] = wmh_pkg
    sys.modules["wmh.core"] = core_pkg
    sys.modules["wmh.ingest"] = ingest_pkg

    for name, file_path in [
        ("wmh.core.types", reference / "wmh" / "core" / "types.py"),
        ("wmh.ingest.adapter", reference / "wmh" / "ingest" / "adapter.py"),
        ("wmh.ingest.otel_genai", reference / "wmh" / "ingest" / "otel_genai.py"),
    ]:
        spec = importlib.util.spec_from_file_location(name, file_path)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)

    return sys.modules["wmh.ingest.otel_genai"].OtelGenAIAdapter


def _write_golden_bundle(root_agent_id: str, world_model_mode: str | None = None) -> None:
    from helpers.trace_archive import archive_bytes, archive_json

    start_fixture = {
        "schema_version": 1,
        "kind": "scoped-db-fixture",
        "phase": "start",
        "base_image": "base:victoria-prod-sync-v1",
        "root_agent_id": root_agent_id,
        "user_id": "user-golden",
        "agent_ids": [root_agent_id, "child-agent"],
        "restore": {
            "strategy": "delete-scoped-rows-then-insert-in-table-order",
            "scope": {"root_agent_id": root_agent_id, "user_id": "user-golden"},
        },
        "rows": {
            "User": [{"id": "user-row", "userId": "user-golden", "name": "Golden User"}],
            "Agent": [
                {
                    "id": root_agent_id,
                    "userId": "user-golden",
                    "goal": "Find the support phone number and verify browser checkout state",
                    "status": "COMPLETED",
                },
                {
                    "id": "child-agent",
                    "userId": "user-golden",
                    "parentAgentId": root_agent_id,
                    "goal": "Inspect browser state",
                    "status": "COMPLETED",
                },
            ],
            "Message": [{"id": "msg-1", "agentId": root_agent_id, "content": "hello"}],
            "Tool": [{"id": "browser", "name": "browser"}],
        },
    }
    end_fixture = {
        **start_fixture,
        "phase": "end",
        "rows": {
            **start_fixture["rows"],
            "ToolUsage": [{"id": "usage-1", "agentId": root_agent_id, "toolName": "vapi.poll_call"}],
        },
    }
    transitions = {
        "schema": "rose.transitions.v1",
        "transitions": [
            {
                "state_before": {
                    "browser": {
                        "url": "https://shop.example.test/checkout",
                        "dom_ref": "browser/dom/final.html.gz.enc",
                        "screenshot_ref": "browser/screens/final.png.enc",
                    },
                    "phone_call": {
                        "provider": "vapi",
                        "call_id": "call-ext-1",
                        "status": "queued",
                        "provider_ref": "provider/vapi/create/call-ext-1.json.gz.enc",
                        "recording_ref": "provider/vapi/recordings/call-ext-1.mp3.enc",
                    },
                    "db_fixture_ref": "db/start.fixture.json.gz.enc",
                },
                "scratchpad": "Checkout page loaded with one pending cart.",
                "action": {
                    "category": "browser",
                    "name": "click",
                    "arguments": {"selector": "#pay", "access_token": "sk-ant-thisShouldBeRedacted"},
                    "agent_id": root_agent_id,
                    "span_id": "span-browser",
                    "tool_call_id": "tool-browser-1",
                    "timestamp_ms": 1783000000000,
                },
                "observation": {
                    "category": "browser_dom",
                    "content": "Payment approval dialog opened with total $42.00.",
                    "metadata": {
                        "url": "https://shop.example.test/checkout",
                        "dom_ref": "browser/dom/after-click.html.gz.enc",
                        "screenshot_ref": "browser/screens/after-click.png.enc",
                    },
                    "artifact_refs": ["browser/dom/after-click.html.gz.enc", "browser/screens/after-click.png.enc"],
                    "timestamp_ms": 1783000000001,
                },
                "raw_span_ids": ["span-browser"],
            },
            {
                "state_before": {
                    "phone_call": {
                        "provider": "vapi",
                        "call_id": "call-ext-1",
                        "status": "in-progress",
                        "transcript_so_far": "Hi, this is the support desk.",
                    }
                },
                "scratchpad": "Phone call is active.",
                "action": {
                    "category": "vapi",
                    "name": "poll_call",
                    "arguments": {"call_id": "call-ext-1"},
                    "agent_id": root_agent_id,
                    "span_id": "span-vapi",
                    "tool_call_id": "tool-vapi-1",
                    "timestamp_ms": 1783000000100,
                },
                "observation": {
                    "category": "provider_response",
                    "content": "Call completed; transcript says the refund code is R-123.",
                    "metadata": {
                        "provider": "vapi",
                        "provider_external_id": "call-ext-1",
                        "recording_ref": "provider/vapi/recordings/call-ext-1.mp3.enc",
                        "provider_domain": "voice",
                    },
                    "artifact_refs": ["provider/vapi/poll/call-ext-1.json.gz.enc"],
                    "timestamp_ms": 1783000000101,
                },
                "raw_span_ids": ["span-vapi"],
            },
        ],
    }
    manifest = {
        "schema_version": 1,
        "root_agent_id": root_agent_id,
        "benchmark_task_name": "golden-wmh",
        "run": {
            "root_goal": "Find the support phone number and verify browser checkout state",
            "user_id": "user-golden",
            "agent_ids": [root_agent_id, "child-agent"],
            "base_image": "base:victoria-prod-sync-v1",
        },
    }
    if world_model_mode is not None:
        manifest["world_model_mode"] = world_model_mode
    archive_json(root_agent_id=root_agent_id, path="db/start.fixture.json.gz.enc", payload=start_fixture)
    archive_json(root_agent_id=root_agent_id, path="db/end.fixture.json.gz.enc", payload=end_fixture)
    archive_json(
        root_agent_id=root_agent_id,
        path="provider/vapi/create/call-ext-1.json.gz.enc",
        payload={
            "provider": "vapi",
            "external_id": "call-ext-1",
            "status": "queued",
            "api_key": "sk-ant-provider-secret",
        },
    )
    archive_bytes(
        root_agent_id=root_agent_id,
        path="provider/vapi/recordings/call-ext-1.mp3.enc",
        body=b"fake-mp3",
        content_type="audio/mpeg",
        compress=False,
    )
    archive_bytes(
        root_agent_id=root_agent_id,
        path="browser/screens/final.png.enc",
        body=b"fake-png",
        content_type="image/png",
        compress=False,
    )
    archive_json(root_agent_id=root_agent_id, path="trace/transitions.json.gz.enc", payload=transitions)
    archive_json(root_agent_id=root_agent_id, path="manifest.json.gz.enc", payload=manifest)


class _FakeR2Body:
    def __init__(self, body: bytes) -> None:
        self._body = body

    def read(self) -> bytes:
        return self._body


class _FakeR2Client:
    def __init__(self, objects: dict[str, bytes]) -> None:
        self.objects = objects

    def get_object(self, *, Bucket: str, Key: str) -> dict:
        if Key not in self.objects:
            error = Exception(f"NoSuchKey: {Key}")
            error.response = {"Error": {"Code": "NoSuchKey"}}
            raise error
        return {"Body": _FakeR2Body(self.objects[Key])}

    def list_objects_v2(self, **kwargs) -> dict:
        prefix = kwargs.get("Prefix", "")
        delimiter = kwargs.get("Delimiter")
        keys = sorted(key for key in self.objects if key.startswith(prefix))
        if delimiter == "/":
            prefixes = set()
            for key in keys:
                rest = key[len(prefix) :]
                if "/" in rest:
                    prefixes.add(prefix + rest.split("/", 1)[0] + "/")
            return {"IsTruncated": False, "CommonPrefixes": [{"Prefix": item} for item in sorted(prefixes)]}
        return {"IsTruncated": False, "Contents": [{"Key": key} for key in keys]}


def _local_bundle_to_fake_r2(tmp: str) -> dict[str, bytes]:
    root = Path(tmp)
    objects: dict[str, bytes] = {}
    for item in root.rglob("*"):
        if item.is_file():
            key = "trace-archive/" + item.relative_to(root).as_posix()
            objects[key] = item.read_bytes()
    return objects


def _with_fake_r2_archive(objects: dict[str, bytes]):
    import helpers.trace_archive as trace_archive

    old_client = trace_archive._R2_CLIENT
    old_env = {
        key: os.environ.get(key)
        for key in [
            "TRACE_ARCHIVE_BACKEND",
            "TRACE_ARCHIVE_ENABLED",
            "R2_ACCOUNT_ID",
            "R2_ACCESS_KEY_ID",
            "R2_SECRET_ACCESS_KEY",
            "R2_BUCKET_TRACE_ARCHIVE",
        ]
    }
    trace_archive._R2_CLIENT = _FakeR2Client(objects)
    os.environ["TRACE_ARCHIVE_ENABLED"] = "1"
    os.environ["TRACE_ARCHIVE_BACKEND"] = "r2"
    os.environ["R2_ACCOUNT_ID"] = "unit-account"
    os.environ["R2_ACCESS_KEY_ID"] = "unit-access"
    os.environ["R2_SECRET_ACCESS_KEY"] = "unit-secret"
    os.environ["R2_BUCKET_TRACE_ARCHIVE"] = "unit-bucket"

    def restore():
        trace_archive._R2_CLIENT = old_client
        for key, value in old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    return restore


def test_exported_otel_jsonl_ingests_with_upstream_wmh_and_preserves_state_refs():
    OtelGenAIAdapter = _load_upstream_otel_adapter_class()
    from benchmarks.world_model_harness import export_archive_to_otel_jsonl

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(tmp)
        try:
            root_agent_id = "root-wmh-golden"
            _write_golden_bundle(root_agent_id)
            out = Path(tmp) / "wmh" / "trace.otel.jsonl"
            export_archive_to_otel_jsonl(root_agent_id, out, redaction_mode="public")

            text = out.read_text(encoding="utf-8")
            assert "sk-ant-thisShouldBeRedacted" not in text
            assert "[REDACTED]" in text
            traces = OtelGenAIAdapter().from_file(str(out))
            assert len(traces) == 1
            trace = traces[0]
            assert trace.metadata["root_agent_id"] == root_agent_id
            assert trace.metadata["benchmark_task_name"] == "golden-wmh"
            assert trace.metadata["db_start_fixture_ref"]["path"] == "db/start.fixture.json.gz.enc"
            assert len(trace.steps) == 2

            browser_step = trace.steps[0]
            assert browser_step.action.kind == "tool_call"
            assert browser_step.action.name == "rose.browser.click"
            assert browser_step.state_before.structured["browser"]["dom_ref"] == "browser/dom/final.html.gz.enc"
            browser_obs = json.loads(browser_step.observation.content)
            assert browser_obs["category"] == "browser_dom"
            assert browser_obs["metadata"]["screenshot_ref"] == "browser/screens/after-click.png.enc"

            phone_step = trace.steps[1]
            assert phone_step.action.name == "rose.vapi.poll_call"
            assert phone_step.state_before.structured["phone_call"]["status"] == "in-progress"
            phone_obs = json.loads(phone_step.observation.content)
            assert phone_obs["metadata"]["recording_ref"] == "provider/vapi/recordings/call-ext-1.mp3.enc"
        finally:
            restore()


def test_bundle_signature_ignores_plaintext_public_manifest_but_rejects_untracked_ciphertext():
    from benchmarks.world_model_harness import _bundle_signature

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(tmp)
        try:
            root_agent_id = "root-public-manifest"
            _write_golden_bundle(root_agent_id)
            bundle_root = Path(tmp) / root_agent_id
            (bundle_root / "manifest.public.json").write_text(
                json.dumps({"root_agent_id": root_agent_id}), encoding="utf-8"
            )

            signature = _bundle_signature(root_agent_id)
            encrypted_paths = [path for path in bundle_root.rglob("*.enc") if path.is_file()]
            assert signature["artifact_count"] == len(encrypted_paths)

            (bundle_root / "untracked.enc").write_bytes(b"missing archive metadata")
            try:
                _bundle_signature(root_agent_id)
            except ValueError as exc:
                assert "Archive metadata missing for untracked.enc" in str(exc)
            else:
                raise AssertionError("Encrypted artifacts without metadata must fail closed")
        finally:
            restore()


def test_bundle_signature_r2_rejects_enumerated_ciphertext_without_metadata():
    from benchmarks.world_model_harness import _bundle_signature

    with tempfile.TemporaryDirectory() as tmp:
        local_restore = _with_archive_env(tmp)
        try:
            root_agent_id = "root-r2-public-manifest"
            _write_golden_bundle(root_agent_id)
            bundle_root = Path(tmp) / root_agent_id
            (bundle_root / "manifest.public.json").write_text(
                json.dumps({"root_agent_id": root_agent_id}), encoding="utf-8"
            )
            objects = _local_bundle_to_fake_r2(tmp)
        finally:
            local_restore()

        r2_restore = _with_fake_r2_archive(objects)
        try:
            signature = _bundle_signature(root_agent_id)
            encrypted_keys = [
                key for key in objects if key.startswith(f"trace-archive/{root_agent_id}/") and key.endswith(".enc")
            ]
            assert signature["artifact_count"] == len(encrypted_keys)

            objects[f"trace-archive/{root_agent_id}/untracked.enc"] = b"missing archive metadata"
            try:
                _bundle_signature(root_agent_id)
            except ValueError as exc:
                assert "Archive metadata missing for untracked.enc" in str(exc)
            else:
                raise AssertionError("R2 ciphertext listed without metadata must fail closed")
        finally:
            r2_restore()


def test_grounded_export_uses_real_browser_results_and_excludes_unavailable_llm_fallbacks():
    from benchmarks.world_model_harness import (
        export_archive_to_otel_jsonl,
        load_grounded_transitions,
        load_transitions,
    )
    from helpers.trace_archive import archive_json

    with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as out:
        restore = _with_archive_env(tmp)
        try:
            root = "root-grounded-fixtures"
            start_fixture = {
                "root_agent_id": root,
                "user_id": "user",
                "agent_ids": [root],
                "rows": {"Agent": [{"id": root, "goal": "Complete checkout"}]},
            }
            archive_json(
                root_agent_id=root,
                path="db/start.fixture.json.gz.enc",
                payload=start_fixture,
            )
            archive_json(
                root_agent_id=root,
                path="db/end.fixture.json.gz.enc",
                payload={
                    **start_fixture,
                    "rows": {
                        **start_fixture["rows"],
                        "Message": [
                            {
                                "id": "rich-finished",
                                "agentId": root,
                                "role": "TOOL",
                                "createdAt": "2026-07-20T00:00:02Z",
                                "metadata": {
                                    "toolName": "spawn_browser_agent",
                                    "toolCallId": "rich-call",
                                    "toolStatus": "FINISHED",
                                    "action_type": "click",
                                    "task_id": "task-rich",
                                    "title": "Clicked Place your order",
                                },
                            },
                            {
                                "id": "legacy-progress",
                                "agentId": root,
                                "role": "TOOL",
                                "createdAt": "2026-07-20T00:00:03Z",
                                "metadata": {
                                    "toolName": "spawn_browser_agent",
                                    "toolCallId": "legacy-call",
                                    "toolStatus": "IN_PROGRESS",
                                    "action_type": "goto",
                                    "task_id": "task-legacy",
                                    "title": "Navigating → https://amazon.com",
                                },
                            },
                            {
                                "id": "legacy-finished",
                                "agentId": root,
                                "role": "TOOL",
                                "createdAt": "2026-07-20T00:00:04Z",
                                "metadata": {
                                    "toolName": "spawn_browser_agent",
                                    "toolCallId": "legacy-call",
                                    "toolStatus": "FINISHED",
                                    "action_type": "goto",
                                    "task_id": "task-legacy",
                                    "title": "Navigated → https://amazon.com",
                                },
                            },
                            {
                                "id": "simulated-finished",
                                "agentId": root,
                                "role": "TOOL",
                                "createdAt": "2026-07-20T00:00:05Z",
                                "metadata": {
                                    "toolName": "spawn_browser_agent",
                                    "toolCallId": "simulated-call",
                                    "toolStatus": "FINISHED",
                                    "action_type": "click",
                                    "task_id": "task-simulated",
                                    "title": "Clicked synthetic result",
                                    "world_model_simulated": True,
                                },
                            },
                            {
                                "id": "lifecycle-finished",
                                "agentId": root,
                                "role": "TOOL",
                                "createdAt": "2026-07-20T00:00:06Z",
                                "metadata": {
                                    "toolName": "spawn_browser_agent",
                                    "toolCallId": "lifecycle-call",
                                    "toolStatus": "FINISHED",
                                    "action_type": "task_complete",
                                    "task_id": "task-legacy",
                                    "title": "Task complete",
                                },
                            },
                        ],
                    },
                },
            )
            archive_json(
                root_agent_id=root,
                path="manifest.json.gz.enc",
                payload={
                    "root_agent_id": root,
                    "world_model_mode": "real",
                    "run": {"root_goal": "Complete checkout", "agent_ids": [root]},
                },
            )
            archive_json(
                root_agent_id=root,
                path="llm/dump.json.gz.enc",
                payload={
                    "agent_id": root,
                    "dump_id": "dump",
                    "messages": [],
                    "output": {"tool_calls": [{"id": "call", "name": "web_search", "arguments": {"q": "unavailable"}}]},
                },
            )
            archive_json(
                root_agent_id=root,
                path="media/browser/task-rich/observations/iteration_0001.json",
                payload={
                    "iteration": 1,
                    "ts_ms": 1000,
                    "browser_state": {
                        "url": "https://amazon.com/checkout",
                        "title": "Checkout",
                        "dom_tree": "Place your order",
                    },
                    "action_entries": [],
                },
            )
            archive_json(
                root_agent_id=root,
                path="media/browser/task-rich/observations/iteration_0002.json",
                payload={
                    "iteration": 2,
                    "ts_ms": 2000,
                    "browser_state": {
                        "url": "https://amazon.com/confirmation",
                        "title": "Order confirmation",
                        "dom_tree": "Thank you, your order has been placed.",
                    },
                    "action_entries": [
                        {
                            "step": 1,
                            "action": "click",
                            "thinking": "Submit the visible checkout",
                            "index": 42,
                            "element_description": "Place your order button",
                            "result": {"success": True},
                        }
                    ],
                },
            )

            assert load_transitions(root)[0].action.category == "llm_tool_call"
            grounded = load_grounded_transitions(root)
            assert len(grounded) == 2
            assert all(step.action.to_wmh_tool_name() == "rose.browser.browser_action" for step in grounded)
            rich = next(step for step in grounded if step.observation.metadata["source"] == "browser_observation")
            legacy = next(step for step in grounded if step.observation.metadata["source"] == "message_fixture")
            assert rich.action.arguments["action"] == "click"
            assert rich.action.arguments["params"]["index"] == 42
            assert "Thank you, your order has been placed" in rich.observation.content
            assert legacy.action.arguments["action"] == "goto"
            assert legacy.action.arguments["params"]["url"] == "https://amazon.com"
            assert "synthetic result" not in json.dumps([step.observation.content for step in grounded])

            trace_path = Path(out) / "traces.otel.jsonl"
            export_archive_to_otel_jsonl(root, trace_path)
            exported = trace_path.read_text(encoding="utf-8")
            assert "rose.browser.browser_action" in exported
            assert "rose.llm_tool_call" not in exported
            exported_spans = [json.loads(line) for line in exported.splitlines() if line]
            outputs = []
            for span in exported_spans:
                for attribute in span.get("attributes", []):
                    if attribute.get("key") == "gen_ai.tool.output":
                        outputs.append(json.loads(attribute["value"]["stringValue"]))
            assert outputs
            assert all(output["metadata"]["result_unavailable"] is False for output in outputs)
        finally:
            restore()


def test_refresh_world_model_index_persists_retriever_index_without_gepa():
    OtelGenAIAdapter = _load_upstream_otel_adapter_class()  # skip when upstream wmh is unavailable
    from benchmarks.world_model_harness import export_archive_to_otel_jsonl, refresh_world_model_index

    with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as out:
        restore = _with_archive_env(tmp)
        try:
            _write_golden_bundle("root-index-refresh")
            trace_file = Path(out) / "traces.otel.jsonl"
            export_archive_to_otel_jsonl("root-index-refresh", trace_file, redaction_mode="public")

            model_root = Path(out) / "models" / "rose-refresh"
            result = refresh_world_model_index(trace_file, model_root, embed_dim=64)

            assert result["indexed_traces"] == 1
            assert result["indexed_steps"] == 2
            index_dir = Path(result["index_path"])
            assert index_dir == model_root / "index"
            assert (index_dir / "embeddings.npy").exists()
            assert (index_dir / "steps.jsonl").exists()
            steps_lines = (index_dir / "steps.jsonl").read_text(encoding="utf-8").strip().splitlines()
            assert len(steps_lines) == 2
            expected_steps = [
                step.model_dump(mode="json")
                for trace in OtelGenAIAdapter().from_file(str(trace_file))
                for step in trace.steps
            ]
            assert [json.loads(line) for line in steps_lines] == expected_steps
        finally:
            restore()


def test_refresh_world_model_index_streams_jsonl_in_bounded_batches():
    """Regression: a corpus refresh must not materialize the aggregate trace in memory.

    The upstream adapter's ``from_file`` reads the entire JSONL file and constructs every
    parsed span, trace, step, rendered embedding input, and vector before persistence. That
    multiplication OOM-killed the 8 GiB cloud maintenance machine for a 20-bundle delta refresh.
    """
    _load_upstream_otel_adapter_class()
    from benchmarks.world_model_harness import export_archive_to_otel_jsonl, refresh_world_model_index
    import wmh.ingest.otel_genai as otel_genai
    from wmh.ingest.otel_genai import OtelGenAIAdapter
    from wmh.retrieval import HashingEmbedder

    with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as out:
        restore = _with_archive_env(tmp)
        old_batch_size = os.environ.get("WMH_INDEX_BATCH_SIZE")
        try:
            _write_golden_bundle("root-index-streaming")
            trace_file = Path(out) / "traces.otel.jsonl"
            export_archive_to_otel_jsonl("root-index-streaming", trace_file, redaction_mode="public")

            os.environ.pop("WMH_INDEX_BATCH_SIZE", None)
            original_embed = HashingEmbedder.embed
            embed_batch_sizes: list[int] = []

            def bounded_embed(self, texts):
                embed_batch_sizes.append(len(texts))
                assert len(texts) <= 1
                return original_embed(self, texts)

            with (
                patch.object(
                    OtelGenAIAdapter,
                    "from_file",
                    side_effect=MemoryError("bulk aggregate loader crossed the memory boundary"),
                ),
                patch.object(
                    otel_genai,
                    "_spans_to_traces",
                    side_effect=MemoryError("one oversized trace crossed the memory boundary"),
                ),
                patch.object(HashingEmbedder, "embed", bounded_embed),
            ):
                result = refresh_world_model_index(
                    trace_file,
                    Path(out) / "models" / "rose-streaming",
                    embed_dim=64,
                )

            assert result["indexed_traces"] == 1
            assert result["indexed_steps"] == 2
            assert result["batch_size"] == 1
            assert embed_batch_sizes == [1, 1]
        finally:
            restore()
            if old_batch_size is None:
                os.environ.pop("WMH_INDEX_BATCH_SIZE", None)
            else:
                os.environ["WMH_INDEX_BATCH_SIZE"] = old_batch_size


def test_exported_otel_jsonl_reads_trace_bundle_from_r2_backend():
    OtelGenAIAdapter = _load_upstream_otel_adapter_class()
    from benchmarks.world_model_harness import export_archive_to_otel_jsonl, list_archive_bundle_ids

    with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as out:
        local_restore = _with_archive_env(tmp)
        try:
            root_agent_id = "root-wmh-r2"
            _write_golden_bundle(root_agent_id)
            objects = _local_bundle_to_fake_r2(tmp)
        finally:
            local_restore()

        r2_restore = _with_fake_r2_archive(objects)
        try:
            assert list_archive_bundle_ids() == [root_agent_id]
            target = Path(out) / "r2.otel.jsonl"
            export_archive_to_otel_jsonl(root_agent_id, target, redaction_mode="public")
            traces = OtelGenAIAdapter().from_file(str(target))
            assert len(traces) == 1
            assert traces[0].metadata["root_agent_id"] == root_agent_id
            assert traces[0].metadata["db_start_fixture_ref"]["path"] == "db/start.fixture.json.gz.enc"
            assert traces[0].steps[1].action.name == "rose.vapi.poll_call"
        finally:
            r2_restore()


def test_replay_corpus_split_and_initial_state_are_deterministic_and_public():
    from benchmarks.world_model_harness import build_replay_corpus, public_json_has_secret, reconstruct_initial_state

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(tmp)
        try:
            _write_golden_bundle("root-wmh-a")
            _write_golden_bundle("root-wmh-b")
            state = reconstruct_initial_state("root-wmh-a", redaction_mode="public")
            assert state["root_goal"] == "Find the support phone number and verify browser checkout state"
            assert state["row_counts"]["Agent"] == 2
            assert state["db_fixture_ref"]["path"] == "db/start.fixture.json.gz.enc"
            assert state["db_fixture"]["restore"]["strategy"] == "delete-scoped-rows-then-insert-in-table-order"
            assert state["db_fixture"]["rows"]["Agent"][0]["id"] == "root-wmh-a"
            assert state["state_before_first_action"]["phone_call"]["provider_ref"].startswith("provider/vapi/create/")
            assert state["provider_artifacts"][0]["path"] == "provider/vapi/create/call-ext-1.json.gz.enc"
            media_by_type = {item["content_type"]: item for item in state["media_artifacts"]}
            assert media_by_type["audio/mpeg"]["compression"] == "none"
            assert media_by_type["image/png"]["compression"] == "none"
            assert public_json_has_secret(state) is False

            out_dir = Path(tmp) / "corpus"
            corpus_1 = build_replay_corpus(["root-wmh-a", "root-wmh-b"], out_dir)
            corpus_2 = build_replay_corpus(["root-wmh-b", "root-wmh-a"], out_dir)
            by_id_1 = {s["root_agent_id"]: s for s in corpus_1["sessions"]}
            by_id_2 = {s["root_agent_id"]: s for s in corpus_2["sessions"]}
            assert by_id_1["root-wmh-a"]["split"] == by_id_2["root-wmh-a"]["split"]
            assert by_id_1["root-wmh-a"]["transition_count"] == 2
            assert by_id_1["root-wmh-a"]["similarity_keys"][1]["provider_domain"] == "voice"
            public = (out_dir / "sessions.json").read_text(encoding="utf-8")
            assert "sk-ant-thisShouldBeRedacted" not in public
            assert "sk-ant-provider-secret" not in public
        finally:
            restore()


def test_build_world_model_from_archives_uses_upstream_build_boundary():
    from benchmarks.world_model_harness import build_world_model_from_archives, public_json_has_secret

    with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as out:
        restore = _with_archive_env(tmp)
        try:
            _write_golden_bundle("root-build")
            calls = {}

            class FakeMetrics:
                def model_dump(self):
                    return {"held_out_accuracy": 0.88, "rollouts_used": 7}

            class FakeResult:
                metrics = FakeMetrics()

            def fake_config_factory(**kwargs):
                calls["config_kwargs"] = kwargs
                return {"config": kwargs}

            def fake_upstream_build(config, **kwargs):
                calls["config"] = config
                calls["build_kwargs"] = kwargs
                Path(kwargs["root"]).mkdir(parents=True, exist_ok=True)
                return FakeResult()

            manifest = build_world_model_from_archives(
                ["root-build"],
                out,
                name="rose-golden",
                provider="openai",
                model="gpt-5.5",
                gepa_budget=3,
                upstream_build=fake_upstream_build,
                config_factory=fake_config_factory,
                serve_provider=object(),
                judge_provider=object(),
                embedder=object(),
            )
            trace_file = Path(manifest["trace_file"])
            assert trace_file.exists()
            assert trace_file.read_text(encoding="utf-8").count("\n") >= 2
            assert calls["config_kwargs"]["provider"] == "openai"
            assert calls["config_kwargs"]["gepa_budget"] == 3
            assert calls["build_kwargs"]["file"] == str(trace_file)
            assert calls["build_kwargs"]["root"].endswith("models/rose-golden")
            assert manifest["metrics"]["held_out_accuracy"] == 0.88
            assert manifest["provider_abstraction"]["default"] == "upstream"
            assert (
                public_json_has_secret(json.loads(Path(manifest["manifest_path"]).read_text(encoding="utf-8"))) is False
            )
        finally:
            restore()


def test_update_world_model_for_simulation_uses_delta_exports_and_progress_events():
    from benchmarks.world_model_harness import update_world_model_for_simulation
    from helpers.trace_archive import archive_json

    with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as out:
        restore = _with_archive_env(tmp)
        try:
            _write_golden_bundle("root-delta-a")
            _write_golden_bundle("root-delta-b")
            calls = {"builds": 0, "index_refreshes": 0}
            progress_events: list[dict] = []

            class FakeMetrics:
                def model_dump(self):
                    return {"held_out_accuracy": 0.91}

            class FakeResult:
                metrics = FakeMetrics()

            def fake_config_factory(**kwargs):
                return {"config": kwargs}

            def fake_upstream_build(config, **kwargs):
                calls["builds"] += 1
                Path(kwargs["root"]).mkdir(parents=True, exist_ok=True)
                return FakeResult()

            def fake_index_refresher(trace_file, model_root, *, embed_dim):
                calls["index_refreshes"] += 1
                assert Path(trace_file).exists()
                return {
                    "indexed_traces": 2,
                    "indexed_steps": 4,
                    "index_path": str(Path(model_root) / "index"),
                }

            first = update_world_model_for_simulation(
                output_dir=out,
                root_agent_ids=["root-delta-a", "root-delta-b"],
                name="rose-delta",
                gepa_budget=0,
                progress=progress_events.append,
                upstream_build=fake_upstream_build,
                config_factory=fake_config_factory,
                index_refresher=fake_index_refresher,
            )
            assert first["status"] == "ready"
            assert first["total_traces"] == 2
            assert first["updated_traces"] == 2
            assert first["build_ran"] is True
            assert first["index_refreshed"] is False
            assert calls["builds"] == 1
            assert calls["index_refreshes"] == 0
            assert [event["title"] for event in progress_events] == [
                "World Model Updating",
                "World Model RAG Populating",
                "World Model Trace Export",
                "World Model Build",
                "World Model Ready",
            ]
            assert progress_events[-1]["status"] == "FINISHED"
            assert "metadata" in progress_events[-1]
            assert "text" not in progress_events[-1]

            progress_events.clear()
            second = update_world_model_for_simulation(
                output_dir=out,
                root_agent_ids=["root-delta-a", "root-delta-b"],
                name="rose-delta",
                gepa_budget=0,
                progress=progress_events.append,
                upstream_build=fake_upstream_build,
                config_factory=fake_config_factory,
                index_refresher=fake_index_refresher,
            )
            assert second["updated_traces"] == 0
            assert second["unchanged_traces"] == 2
            assert second["build_ran"] is False
            assert second["index_refreshed"] is False
            assert calls["builds"] == 1
            assert calls["index_refreshes"] == 0

            # Exporter changes must invalidate cached per-bundle OTel even when the encrypted
            # archive itself is unchanged. Otherwise a compacting/schema fix can never repair
            # already-cached retrieval examples.
            delta_index_path = Path(out) / "delta-index.json"
            stale_index = json.loads(delta_index_path.read_text(encoding="utf-8"))
            stale_index["bundles"]["root-delta-a"]["export_schema_version"] = -1
            delta_index_path.write_text(json.dumps(stale_index), encoding="utf-8")
            schema_refresh = update_world_model_for_simulation(
                output_dir=out,
                root_agent_ids=["root-delta-a", "root-delta-b"],
                name="rose-delta",
                gepa_budget=0,
                progress=lambda _event: None,
                upstream_build=fake_upstream_build,
                config_factory=fake_config_factory,
                index_refresher=fake_index_refresher,
            )
            assert schema_refresh["updated_traces"] == 1
            assert schema_refresh["index_refreshed"] is True
            assert calls["index_refreshes"] == 1

            archive_json(
                root_agent_id="root-delta-b",
                path="provider/vapi/poll/call-ext-2.json.gz.enc",
                payload={"provider": "vapi", "external_id": "call-ext-2", "status": "completed"},
            )
            third = update_world_model_for_simulation(
                output_dir=out,
                root_agent_ids=["root-delta-a", "root-delta-b"],
                name="rose-delta",
                gepa_budget=0,
                progress=lambda _event: None,
                upstream_build=fake_upstream_build,
                config_factory=fake_config_factory,
                index_refresher=fake_index_refresher,
            )
            assert third["updated_traces"] == 1
            assert third["unchanged_traces"] == 1
            # Archive deltas refresh the RAG index only — GEPA must not re-fire.
            assert third["build_ran"] is False
            assert third["index_refreshed"] is True
            assert third["index_refresh"]["indexed_traces"] == 2
            assert calls["builds"] == 1
            assert calls["index_refreshes"] == 2

            fourth = update_world_model_for_simulation(
                output_dir=out,
                root_agent_ids=["root-delta-a", "root-delta-b"],
                name="rose-delta",
                gepa_budget=0,
                force=True,
                progress=lambda _event: None,
                upstream_build=fake_upstream_build,
                config_factory=fake_config_factory,
                index_refresher=fake_index_refresher,
            )
            assert fourth["build_ran"] is True
            assert fourth["index_refreshed"] is False
            assert calls["builds"] == 2
            assert calls["index_refreshes"] == 2

            index = json.loads((Path(out) / "delta-index.json").read_text(encoding="utf-8"))
            assert set(index["bundles"]) == {"root-delta-a", "root-delta-b"}
            assert all(bundle["export_schema_version"] >= 1 for bundle in index["bundles"].values())
            assert Path(index["trace_file"]).exists()
            assert Path(index["replay_corpus_file"]).exists()
        finally:
            restore()


def test_update_world_model_excludes_simulated_bundles_from_corpus():
    from benchmarks.world_model_harness import (
        partition_real_world_bundles,
        update_world_model_for_simulation,
    )

    with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as out:
        restore = _with_archive_env(tmp)
        try:
            _write_golden_bundle("root-real")
            _write_golden_bundle("root-shadow", world_model_mode="shadow")
            _write_golden_bundle("root-simulated", world_model_mode="simulate")

            real, excluded = partition_real_world_bundles(["root-real", "root-shadow", "root-simulated"])
            assert real == ["root-real", "root-shadow"]
            assert excluded == {"root-simulated": "simulate"}

            progress_events: list[dict] = []

            class FakeMetrics:
                def model_dump(self):
                    return {"held_out_accuracy": 0.91}

            class FakeResult:
                metrics = FakeMetrics()

            def fake_upstream_build(config, **kwargs):
                Path(kwargs["root"]).mkdir(parents=True, exist_ok=True)
                return FakeResult()

            result = update_world_model_for_simulation(
                output_dir=out,
                root_agent_ids=["root-real", "root-shadow", "root-simulated"],
                name="rose-no-sim",
                gepa_budget=0,
                progress=progress_events.append,
                upstream_build=fake_upstream_build,
                config_factory=lambda **kwargs: {"config": kwargs},
            )
            assert result["status"] == "ready"
            assert result["total_traces"] == 2

            index = json.loads((Path(out) / "delta-index.json").read_text(encoding="utf-8"))
            assert set(index["bundles"]) == {"root-real", "root-shadow"}
            assert not (Path(out) / "otel" / "root-simulated.otel.jsonl").exists()

            rag_event = next(e for e in progress_events if e["title"] == "World Model RAG Populating")
            metadata = rag_event.get("metadata") or rag_event
            assert metadata.get("traces_excluded_non_real") == 1
        finally:
            restore()


def test_world_model_bundle_cap_preserves_existing_index_entries():
    import benchmarks.world_model_harness as world_model_harness

    update_world_model_for_simulation = world_model_harness.update_world_model_for_simulation

    with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as out:
        restore = _with_archive_env(tmp)
        prior_cap = os.environ.get("WMH_MAX_BUNDLES")
        original_mode = world_model_harness.bundle_world_model_mode
        try:
            for bundle_id in ("root-existing-z", "root-new-a", "root-new-b"):
                _write_golden_bundle(bundle_id)

            class FakeMetrics:
                def model_dump(self):
                    return {"held_out_accuracy": 0.91}

            class FakeResult:
                metrics = FakeMetrics()

            def fake_upstream_build(_config, **kwargs):
                Path(kwargs["root"]).mkdir(parents=True, exist_ok=True)
                return FakeResult()

            update_world_model_for_simulation(
                output_dir=out,
                root_agent_ids=["root-existing-z"],
                name="rose-capped",
                gepa_budget=0,
                upstream_build=fake_upstream_build,
                config_factory=lambda **kwargs: {"config": kwargs},
            )

            os.environ["WMH_MAX_BUNDLES"] = "2"
            classified: list[str] = []

            def recording_mode(bundle_id: str) -> str:
                classified.append(bundle_id)
                return original_mode(bundle_id)

            world_model_harness.bundle_world_model_mode = recording_mode
            result = update_world_model_for_simulation(
                output_dir=out,
                root_agent_ids=["root-existing-z", "root-new-a", "root-new-b"],
                name="rose-capped",
                gepa_budget=0,
                upstream_build=fake_upstream_build,
                config_factory=lambda **kwargs: {"config": kwargs},
                index_refresher=lambda *_args, **_kwargs: {
                    "indexed_traces": 2,
                    "indexed_steps": 2,
                    "index_path": str(Path(out) / "models" / "rose-capped" / "index"),
                },
            )

            assert result["total_traces"] == 2
            assert classified == ["root-existing-z", "root-new-a"]
            index = json.loads((Path(out) / "delta-index.json").read_text(encoding="utf-8"))
            assert set(index["bundles"]) == {"root-existing-z", "root-new-a"}
        finally:
            if prior_cap is None:
                os.environ.pop("WMH_MAX_BUNDLES", None)
            else:
                os.environ["WMH_MAX_BUNDLES"] = prior_cap
            world_model_harness.bundle_world_model_mode = original_mode
            restore()


def test_load_transitions_drops_fast_cache_replays_from_corpus():
    from benchmarks.world_model_harness import load_transitions
    from helpers.trace_archive import archive_json

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(tmp)
        try:
            # Trace-artifact path: replayed observations are marked and dropped.
            _write_golden_bundle("root-replay-trace")
            payload = {
                "schema": "rose.transitions.v1",
                "transitions": [
                    {
                        "state_before": {},
                        "scratchpad": "",
                        "action": {"category": "grep", "name": "web_search", "arguments": {"q": "fresh"}},
                        "observation": {"category": "provider_response", "content": "fresh result"},
                    },
                    {
                        "state_before": {},
                        "scratchpad": "",
                        "action": {"category": "grep", "name": "web_search", "arguments": {"q": "replayed"}},
                        "observation": {
                            "category": "provider_response",
                            "content": "replayed result",
                            "metadata": {"from_fast_cache": True},
                        },
                    },
                ],
            }
            archive_json(
                root_agent_id="root-replay-trace",
                path="trace/transitions.json.gz.enc",
                payload=payload,
            )
            transitions = load_transitions("root-replay-trace")
            assert len(transitions) == 1
            assert transitions[0].action.arguments == {"q": "fresh"}

            # LLM-dump path: dumps whose usage says from_fast_cache are dropped.
            root = "root-replay-dumps"
            archive_json(
                root_agent_id=root,
                path="db/start.fixture.json.gz.enc",
                payload={
                    "root_agent_id": root,
                    "user_id": "user-replay",
                    "agent_ids": [root],
                    "rows": {"Agent": [{"id": root, "goal": "goal"}]},
                },
            )
            archive_json(
                root_agent_id=root,
                path="manifest.json.gz.enc",
                payload={"root_agent_id": root, "run": {"agent_ids": [root]}},
            )
            archive_json(
                root_agent_id=root,
                path="llm/fresh-dump.json.gz.enc",
                payload={
                    "agent_id": root,
                    "dump_id": "fresh-dump",
                    "messages": [],
                    "output": {
                        "tool_calls": [{"id": "t1", "name": "web_search", "arguments": {"q": "fresh"}}],
                        "usage": {"prompt_tokens": 10},
                    },
                },
            )
            archive_json(
                root_agent_id=root,
                path="llm/replay-dump.json.gz.enc",
                payload={
                    "agent_id": root,
                    "dump_id": "replay-dump",
                    "messages": [],
                    "output": {
                        "tool_calls": [{"id": "t2", "name": "web_search", "arguments": {"q": "replayed"}}],
                        "usage": {"prompt_tokens": 0, "from_fast_cache": True},
                    },
                },
            )
            dump_transitions = load_transitions(root)
            assert len(dump_transitions) == 1
            assert dump_transitions[0].action.arguments == {"q": "fresh"}
        finally:
            restore()


def test_build_world_model_from_archives_runs_actual_upstream_build_with_fake_provider():
    for name in list(sys.modules):
        if name == "wmh" or name.startswith("wmh."):
            del sys.modules[name]

    from benchmarks.world_model_harness import build_world_model_from_archives
    from wmh.providers.base import Completion, Message, ProviderConfig, ProviderKind
    from wmh.retrieval import HashingEmbedder

    class FakeProvider:
        def __init__(self) -> None:
            self.config = ProviderConfig(kind=ProviderKind.BEDROCK, model="fake-model")

        def complete(
            self,
            system: str,
            messages: list[Message],
            *,
            temperature: float = 0.7,
            max_tokens: int = 8192,
        ) -> Completion:
            if "grade a world model" in system:
                return Completion(text='{"score": 1.0, "critique": "ok"}')
            if "improve the system prompt" in system:
                return Completion(text="IMPROVED")
            return Completion(text='{"output": "ok", "is_error": false}')

        def embed(self, texts: list[str]) -> list[list[float]]:
            return [[0.0] * 32 for _ in texts]

        def verify(self):
            raise NotImplementedError

    with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as out:
        restore = _with_archive_env(tmp)
        try:
            _write_golden_bundle("root-upstream-build")
            manifest = build_world_model_from_archives(
                ["root-upstream-build"],
                out,
                name="rose-upstream",
                provider="bedrock",
                model="fake-model",
                gepa_budget=0,
                train_split=0.5,
                embed_dim=32,
                serve_provider=FakeProvider(),
                embedder=HashingEmbedder(dim=32),
            )
            model_root = Path(manifest["model_root"])
            assert (model_root / "config.toml").exists()
            assert (model_root / "prompts" / "optimized.txt").read_text(encoding="utf-8")
            assert (model_root / "index").exists()
        finally:
            restore()


def test_compare_real_vs_world_model_benchmark_outcomes():
    from benchmarks.world_model_harness import compare_real_vs_world_model_benchmark

    real = {
        "name": "golden-wmh",
        "passed": True,
        "agent_id": "real-agent",
        "status": "COMPLETED",
        "progress_score": 95,
    }
    simulated = {
        "name": "golden-wmh",
        "passed": True,
        "agent_id": "sim-agent",
        "status": "COMPLETED",
        "progress_score": 91,
        "world_model_mode": "simulate",
        "world_model_fidelity": {"status": "scored", "mean_score": 0.82},
    }
    comparison = compare_real_vs_world_model_benchmark(real, simulated, min_fidelity_score=0.8)
    assert comparison["comparable"] is True
    assert comparison["checks"]["pass_outcome_match"] is True
    assert comparison["progress_delta"] == 4
    assert comparison["fidelity_score"] == 0.82

    mismatch = {**simulated, "passed": False}
    failed = compare_real_vs_world_model_benchmark(real, mismatch, min_fidelity_score=0.8)
    assert failed["comparable"] is False
    assert failed["checks"]["pass_outcome_match"] is False


def test_root_loader_keeps_child_llm_dumps_for_diagnostics_but_grounded_export_excludes_them():
    from benchmarks.world_model_harness import export_archive_to_otel_jsonl, load_transitions
    from helpers.trace_archive import archive_json

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(tmp)
        try:
            root_agent_id = "root-wmh-tree"
            child_agent_id = "child-wmh-tree"
            archive_json(
                root_agent_id=root_agent_id,
                path="db/start.fixture.json.gz.enc",
                payload={
                    "root_agent_id": root_agent_id,
                    "user_id": "user-tree",
                    "agent_ids": [root_agent_id, child_agent_id],
                    "base_image": "base:victoria-prod-sync-v1",
                    "rows": {
                        "Agent": [
                            {"id": root_agent_id, "goal": "delegate browser inspection"},
                            {"id": child_agent_id, "parentAgentId": root_agent_id},
                        ]
                    },
                },
            )
            archive_json(
                root_agent_id=root_agent_id,
                path="manifest.json.gz.enc",
                payload={
                    "root_agent_id": root_agent_id,
                    "benchmark_task_name": "tree-wmh",
                    "run": {
                        "root_goal": "delegate browser inspection",
                        "agent_ids": [root_agent_id, child_agent_id],
                    },
                },
            )
            archive_json(
                root_agent_id=child_agent_id,
                path="llm/child-dump.json.gz.enc",
                payload={
                    "call_site": "execute_loop",
                    "agent_id": child_agent_id,
                    "span_id": "child-span",
                    "dump_id": "child-dump",
                    "model": "rose-1-lite",
                    "messages": [],
                    "output": {
                        "tool_calls": [
                            {
                                "id": "tool-child-1",
                                "name": "spawn_browser_agent",
                                "arguments": {"url": "https://example.test"},
                            }
                        ]
                    },
                },
            )
            diagnostic = load_transitions(root_agent_id, redaction_mode="public")
            assert len(diagnostic) == 1
            assert diagnostic[0].action.to_wmh_tool_name() == "rose.llm_tool_call.spawn_browser_agent"
            assert diagnostic[0].action.agent_id == child_agent_id
            assert "child-wmh-tree/llm/child-dump.json.gz.enc" in diagnostic[0].action.artifact_refs
            assert diagnostic[0].observation.metadata["result_unavailable"] is True

            out = Path(tmp) / "tree.otel.jsonl"
            export_archive_to_otel_jsonl(root_agent_id, out, redaction_mode="public")
            assert not out.read_text(encoding="utf-8").strip()
        finally:
            restore()


async def test_wmh_http_client_matches_upstream_serving_routes():
    from benchmarks.world_model_harness import CanonicalAction, WMHHttpClient

    requests: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append({"method": request.method, "url": str(request.url), "body": request.content.decode("utf-8")})
        if request.method == "GET" and str(request.url).endswith("/world_models"):
            return httpx.Response(200, json={"world_models": ["rose-golden"]})
        if request.method == "POST" and str(request.url).endswith("/world_models/rose-golden/sessions"):
            return httpx.Response(200, json={"session_id": "session-1"})
        if request.method == "POST" and str(request.url).endswith("/world_models/rose-golden/sessions/session-1/step"):
            body = json.loads(request.content.decode("utf-8"))
            assert body["action"]["kind"] == "tool_call"
            assert body["action"]["name"] == "rose.vapi.poll_call"
            assert body["action"]["arguments"]["tool_call_id"] == "tool-vapi-1"
            return httpx.Response(
                200, json={"observation": {"content": "predicted", "metadata": {"state_note": "done"}}}
            )
        return httpx.Response(404, json={"error": "unexpected"})

    setup_mock_fn(handler)
    try:
        client = WMHHttpClient("https://wmh.example.test")
        assert await client.list_world_models() == ["rose-golden"]
        session_id = await client.start_session(
            "rose-golden",
            task="call support",
            seed_state={"structured": {"phone_call": {"status": "new"}}, "scratchpad": ""},
        )
        assert session_id == "session-1"
        obs = await client.step(
            "rose-golden",
            session_id,
            CanonicalAction(
                category="vapi",
                name="poll_call",
                arguments={"call_id": "call-ext-1"},
                tool_call_id="tool-vapi-1",
            ),
        )
        assert obs["content"] == "predicted"
        assert [r["method"] for r in requests] == ["GET", "POST", "POST"]
    finally:
        teardown_mock()


def test_wmh_http_clients_allow_slow_grounded_transitions():
    from benchmarks.world_model_harness import WMHHttpClient as BenchmarkClient
    from helpers.world_model_runtime import WMHHttpClient as RuntimeClient

    old_timeout = os.environ.get("WMH_HTTP_TIMEOUT_SECONDS")
    try:
        os.environ.pop("WMH_HTTP_TIMEOUT_SECONDS", None)
        for client_type in (BenchmarkClient, RuntimeClient):
            assert client_type("https://wmh.example.test").timeout == 180
            assert client_type("https://wmh.example.test", timeout=12).timeout == 12

        os.environ["WMH_HTTP_TIMEOUT_SECONDS"] = "95"
        for client_type in (BenchmarkClient, RuntimeClient):
            assert client_type("https://wmh.example.test").timeout == 95

        os.environ["WMH_HTTP_TIMEOUT_SECONDS"] = "0"
        for client_type in (BenchmarkClient, RuntimeClient):
            try:
                client_type("https://wmh.example.test")
                raise AssertionError("non-positive WMH timeout must fail")
            except ValueError as exc:
                assert "greater than zero" in str(exc)
    finally:
        if old_timeout is None:
            os.environ.pop("WMH_HTTP_TIMEOUT_SECONDS", None)
        else:
            os.environ["WMH_HTTP_TIMEOUT_SECONDS"] = old_timeout


async def test_evaluate_archive_with_world_model_scores_dimensions_and_redacts_public_result():
    from benchmarks.world_model_harness import evaluate_archive_with_world_model, public_json_has_secret

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(tmp)
        old_env = {
            "BENCHMARK_WMH_EVAL": os.environ.get("BENCHMARK_WMH_EVAL"),
            "WMH_BASE_URL": os.environ.get("WMH_BASE_URL"),
            "WMH_MODEL_NAME": os.environ.get("WMH_MODEL_NAME"),
        }
        requests: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(
                {"method": request.method, "url": str(request.url), "body": request.content.decode("utf-8")}
            )
            if str(request.url).endswith("/world_models/rose-golden/sessions"):
                return httpx.Response(200, json={"session_id": "session-fidelity"})
            if str(request.url).endswith("/world_models/rose-golden/sessions/session-fidelity/step"):
                body = json.loads(request.content.decode("utf-8"))
                name = body["action"]["name"]
                if name == "rose.browser.click":
                    return httpx.Response(
                        200,
                        json={
                            "observation": {
                                "content": "Payment approval dialog opened with total $42.00.",
                                "metadata": {
                                    "dom_ref": "browser/dom/after-click.html.gz.enc",
                                    "screenshot_ref": "browser/screens/after-click.png.enc",
                                },
                                "is_error": False,
                            }
                        },
                    )
                return httpx.Response(
                    200,
                    json={
                        "observation": {
                            "content": "Call completed; transcript says refund code R-123.",
                            "metadata": {
                                "recording_ref": "provider/vapi/recordings/call-ext-1.mp3.enc",
                                "state_note": "call completed",
                            },
                            "is_error": False,
                        }
                    },
                )
            return httpx.Response(404, json={"error": "unexpected"})

        setup_mock_fn(handler)
        try:
            os.environ["BENCHMARK_WMH_EVAL"] = "1"
            os.environ["WMH_BASE_URL"] = "https://wmh.example.test"
            os.environ["WMH_MODEL_NAME"] = "rose-golden"
            _write_golden_bundle("root-wmh-score")
            result = await evaluate_archive_with_world_model("root-wmh-score")
            assert result["status"] == "scored"
            assert result["session_id"] == "session-fidelity"
            assert result["n_steps"] == 2
            assert result["mean_score"] > 0.8
            assert result["dimensions"]["schema_validity"] == 1.0
            assert result["dimensions"]["error_behavior"] == 1.0
            assert not public_json_has_secret(result)
            assert len(requests) == 3
        finally:
            teardown_mock()
            restore()
            for key, value in old_env.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


async def test_evaluate_archives_with_world_model_scores_batch_mean():
    from benchmarks.world_model_harness import evaluate_archives_with_world_model, public_json_has_secret

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(tmp)
        old_env = {
            "BENCHMARK_WMH_EVAL": os.environ.get("BENCHMARK_WMH_EVAL"),
            "WMH_BASE_URL": os.environ.get("WMH_BASE_URL"),
            "WMH_MODEL_NAME": os.environ.get("WMH_MODEL_NAME"),
        }
        requests: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(
                {"method": request.method, "url": str(request.url), "body": request.content.decode("utf-8")}
            )
            if str(request.url).endswith("/world_models/rose-golden/sessions"):
                return httpx.Response(200, json={"session_id": f"session-{len(requests)}"})
            if "/world_models/rose-golden/sessions/" in str(request.url) and str(request.url).endswith("/step"):
                body = json.loads(request.content.decode("utf-8"))
                if body["action"]["name"] == "rose.browser.click":
                    return httpx.Response(
                        200,
                        json={
                            "observation": {
                                "content": "Payment approval dialog opened with total $42.00.",
                                "metadata": {
                                    "dom_ref": "browser/dom/after-click.html.gz.enc",
                                    "screenshot_ref": "browser/screens/after-click.png.enc",
                                },
                                "is_error": False,
                            }
                        },
                    )
                return httpx.Response(
                    200,
                    json={
                        "observation": {
                            "content": "Call completed; transcript says refund code R-123.",
                            "metadata": {"recording_ref": "provider/vapi/recordings/call-ext-1.mp3.enc"},
                            "is_error": False,
                        }
                    },
                )
            return httpx.Response(404, json={"error": "unexpected"})

        setup_mock_fn(handler)
        try:
            os.environ["BENCHMARK_WMH_EVAL"] = "1"
            os.environ["WMH_BASE_URL"] = "https://wmh.example.test"
            os.environ["WMH_MODEL_NAME"] = "rose-golden"
            _write_golden_bundle("root-wmh-batch-a")
            _write_golden_bundle("root-wmh-batch-b")
            result = await evaluate_archives_with_world_model()
            assert result["status"] == "scored"
            assert result["bundle_count"] == 2
            assert result["scored_bundle_count"] == 2
            assert result["n_steps"] == 4
            assert result["mean_score"] > 0.8
            assert len(result["results"]) == 2
            assert len(requests) == 6
            assert not public_json_has_secret(result)
        finally:
            teardown_mock()
            restore()
            for key, value in old_env.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


def test_canonical_action_categories_cover_agent_tool_families():
    from benchmarks.world_model_harness import canonical_action_from_tool_call

    cases = {
        "spawn_browser_agent": "browser",
        "spawn_claude_code_agent": "code",
        "message_person": "message",
        "request_payment_card": "payment",
        "call_phone_number": "vapi",
        "grep": "grep",
        "fast_cache_write": "fast_cache",
        "request_user_approval": "auth_approval",
    }
    for tool_name, category in cases.items():
        action = canonical_action_from_tool_call(tool_name, {"secret": "sk-ant-redact-me"}, "tool-1")
        assert action.category == category
        assert action.arguments["secret"] == "[REDACTED]"


def test_world_model_action_timestamp_uses_sim_clock_env_and_validates_it():
    from benchmarks.world_model_harness import canonical_action_from_tool_call
    from helpers.world_model_runtime import canonical_action_from_tool_call as runtime_action_from_tool_call

    old_env = {
        "WMH_SIM_TIME_MS": os.environ.get("WMH_SIM_TIME_MS"),
        "WORLD_MODEL_SIM_TIME_MS": os.environ.get("WORLD_MODEL_SIM_TIME_MS"),
    }
    try:
        os.environ["WMH_SIM_TIME_MS"] = "1893456000123"
        os.environ["WORLD_MODEL_SIM_TIME_MS"] = "111"
        bridge_action = canonical_action_from_tool_call("vapi_poll_call", {"call_id": "c"}, "tool-1")
        runtime_action = runtime_action_from_tool_call("vapi_poll_call", {"call_id": "c"}, "tool-1")
        assert bridge_action.timestamp_ms == 1893456000123
        assert runtime_action.timestamp_ms == 1893456000123

        os.environ["WMH_SIM_TIME_MS"] = "not-an-int"
        try:
            canonical_action_from_tool_call("vapi_poll_call", {}, "tool-2")
            raise AssertionError("invalid sim clock env should fail loudly")
        except ValueError as exc:
            assert "WMH_SIM_TIME_MS" in str(exc)
    finally:
        for key, value in old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def test_world_model_observation_latency_normalization_matches_runtime_helper():
    from benchmarks.world_model_harness import world_model_observation_to_tool_result
    from helpers.world_model_runtime import world_model_observation_to_tool_result as runtime_to_tool_result

    observation = {
        "content": "provider finished",
        "metadata": {"duration_ms": "2500", "state_note": "call completed"},
        "is_error": False,
    }

    bridge_result = world_model_observation_to_tool_result(observation, simulated=True, wall_elapsed_ms=17)
    runtime_result = runtime_to_tool_result(observation, simulated=True, wall_elapsed_ms=17)

    for result in (bridge_result, runtime_result):
        assert result["success"] is True
        assert result["world_model_simulated"] is True
        assert result["predicted_latency_ms"] == 2500
        assert result["world_model_wall_elapsed_ms"] == 17
        assert result["simulated_elapsed_ms"] == 2517
        assert result["result"] == observation


def test_world_model_observation_passes_through_activity_tool_result():
    from benchmarks.world_model_harness import world_model_observation_to_tool_result
    from helpers.world_model_runtime import world_model_observation_to_tool_result as runtime_to_tool_result

    observation = {
        "content": "search complete",
        "tool_result": {"answer": "42", "sources": [{"url": "https://example.test"}]},
        "predicted_latency_ms": 50,
    }

    for convert in (world_model_observation_to_tool_result, runtime_to_tool_result):
        result = convert(observation, simulated=True, wall_elapsed_ms=7)
        assert result["answer"] == "42"
        assert result["sources"] == [{"url": "https://example.test"}]
        assert result["success"] is True
        assert result["message"] == "search complete"
        assert result["world_model_observation"] == observation
        assert result["world_model_simulated"] is True
        assert result["simulated_elapsed_ms"] == 57


def test_world_model_observation_decodes_real_server_json_content():
    """WMH serves generated tool results inside Observation.content."""
    from benchmarks.world_model_harness import world_model_observation_to_tool_result
    from helpers.world_model_runtime import world_model_observation_to_tool_result as runtime_to_tool_result

    observation = {
        "content": json.dumps(
            {
                "status": "completed",
                "success": True,
                "structured_response": {"purchase_completed": True},
            }
        ),
        "is_error": False,
        "metadata": {},
    }

    for convert in (world_model_observation_to_tool_result, runtime_to_tool_result):
        result = convert(observation, simulated=True, wall_elapsed_ms=9)
        assert result["status"] == "completed"
        assert result["structured_response"] == {"purchase_completed": True}
        assert result["world_model_observation"] == observation
        assert result["world_model_simulated"] is True


def test_simulated_browser_transition_contract_requires_one_grounded_action():
    from domains.spawn_browser_agent_v3.handler import (
        _ground_simulated_browser_approval_question,
        _simulated_browser_frame_from_result,
        _simulated_browser_message_metadata,
        _simulated_browser_state_from_result,
        _simulated_browser_transition_contract,
    )
    from domains.spawn_browser_agent_v3.recording import normalize_simulated_browser_frame
    from providers.rose.browser_use import build_browser_state_message_content

    contract = _simulated_browser_transition_contract(
        action_name="click",
        approved=False,
        write_lock_enabled=True,
    )
    assert contract["boundary"] == "browser_environment_transition"
    assert contract["action_name"] == "click"
    assert "exactly this one action" in contract["instructions"]
    assert "Never return a whole browser-agent outcome" in contract["instructions"]

    result = {
        "browser_state": {
            "url": "https://shop.example.test/cart",
            "title": "Cart",
            "dom_tree": "[1]<button>Checkout</button>",
            "recent_events": [
                {"type": "navigation", "url": "https://shop.example.test/cart"},
                "Cart loaded",
            ],
            "tabs": ["https://shop.example.test/cart"],
            "screenshot": {"unexpected": "object"},
        },
        "frame": {"html": "<main>Cart</main>", "width": 1440, "height": 900},
    }
    state = _simulated_browser_state_from_result(result)
    frame = _simulated_browser_frame_from_result(result, state)
    metadata = _simulated_browser_message_metadata(
        frame=frame,
        world_model_session_id="wmh-session-1",
        world_model_name="rose-amazon",
    )
    assert state["dom_tree"] == "[1]<button>Checkout</button>"
    assert state["viewport"] == {"width": 1440, "height": 900}
    assert state["recent_events"] == [
        '{"type":"navigation","url":"https://shop.example.test/cart"}',
        "Cart loaded",
    ]
    assert state["tabs"] == [{"id": 0, "url": "https://shop.example.test/cart", "title": ""}]
    assert "screenshot" not in state
    assert "Recent Events:" in build_browser_state_message_content(
        task="Checkout",
        browser_state=state,
    )
    approval_question = _ground_simulated_browser_approval_question(
        transition={"question": "Rose wants to perform a payment action. Approve?"},
        browser_state={
            "dom_tree": (
                "<div>Carhartt Men's Knit Cuffed Beanie</div>"
                "<span class='price'>$19.99</span><div>Order total: $21.74</div>"
            )
        },
        system_name="Rose",
        approval_type="payment",
    )
    assert approval_question == "Approve purchasing the beanie for $19.99?"
    assert frame == {"kind": "html", "html": "<main>Cart</main>", "width": 1440, "height": 900}
    assert metadata["world_model_simulated"] is True
    assert metadata["simulated_browser_frame"] == frame

    # Production WMH returns an accessibility-tree object and a data:text/html
    # website frame. Both are normalized losslessly at the simulator boundary.
    production_result = {
        "browser_state": {
            "url": "about:blank",
            "title": "",
            "dom_tree": {"role": "WebArea", "name": "", "children": []},
            "viewport": {"width": 1280, "height": 800},
            "scroll_position": {"x": 0, "y": 0},
            "page_stats": {"total_elements": 0, "interactive_elements": 0},
            "tabs": [{"tab_id": 1, "url": "about:blank", "active": True}],
            "recent_events": [{"event": "navigation", "url": "about:blank", "status": 0}],
        },
        "frame": "data:text/html,%3Cmain%3EAmazon%20ready%3C%2Fmain%3E",
    }
    production_state = _simulated_browser_state_from_result(production_result)
    assert json.loads(production_state["dom_tree"]) == production_result["browser_state"]["dom_tree"]
    assert _simulated_browser_frame_from_result(production_result, production_state) == {
        "kind": "html",
        "html": "<main>Amazon ready</main>",
    }
    assert normalize_simulated_browser_frame("data:text/html;base64,PG1haW4+UmVhZHk8L21haW4+") == {
        "kind": "html",
        "html": "<main>Ready</main>",
    }
    assert normalize_simulated_browser_frame("https://www.amazon.com/dp/B002HLLM4C") is None
    assert normalize_simulated_browser_frame("https://frames.example.test/browser/step-1.png") == {
        "kind": "image",
        "src": "https://frames.example.test/browser/step-1.png",
    }
    synthesized = _simulated_browser_frame_from_result(
        {**production_result, "frame": "https://www.amazon.com/dp/B002HLLM4C"}, production_state
    )
    assert synthesized and synthesized["kind"] == "html"
    assert "Amazon ready" not in synthesized["html"]
    assert "about:blank" in synthesized["html"]
    assert "href=" not in synthesized["html"]


def test_simulated_browser_transition_normalizes_real_wmh_observation_shapes():
    """RCA for cloud run 20260720-163450-76118.

    The real WMH emitted the environment observation directly instead of nesting
    it under ``browser_state``.  The browser boundary retried three times, then
    rejected every otherwise-successful step as "omitted browser_state".
    """

    from domains.spawn_browser_agent_v3.handler import _simulated_browser_state_from_result

    previous = {
        "url": "https://www.amazon.com/s?k=black+beanie",
        "title": "Amazon.com",
        "dom_tree": "Initial page",
        "recent_events": ["initial_page_loaded"],
    }
    direct_state = _simulated_browser_state_from_result(
        {
            "success": True,
            "url": "https://www.amazon.com/s?k=black+beanie",
            "title": "Amazon.com : black beanie",
            "dom_tree": {
                "role": "main",
                "children": [{"role": "link", "name": "Carhartt Knit Cuffed Beanie $19.99"}],
            },
        },
        previous_state=previous,
    )
    assert direct_state["title"] == "Amazon.com : black beanie"
    assert "Carhartt Knit Cuffed Beanie $19.99" in direct_state["dom_tree"]

    text_state = _simulated_browser_state_from_result(
        {
            "success": True,
            "message": "Amazon search results: Carhartt Knit Cuffed Beanie, black, $19.99, 4.7 stars.",
            "world_model_observation": {
                "content": "Amazon search results: Carhartt Knit Cuffed Beanie, black, $19.99, 4.7 stars.",
                "is_error": False,
                "metadata": {},
            },
        },
        previous_state=previous,
    )
    assert text_state["url"] == previous["url"]
    assert "Carhartt Knit Cuffed Beanie" in text_state["dom_tree"]
    assert text_state["recent_events"][-1].startswith("Amazon search results")


async def test_simulated_browser_transition_calls_wmh_once_and_forbids_real_fallback():
    from domains.spawn_browser_agent_v3.handler import _execute_simulated_browser_transition

    class FakeWorldModel:
        world_model_name = "rose-amazon"

        def __init__(self):
            self.calls = []

        async def execute(
            self,
            tool_name,
            tool_args,
            tool_call_id,
            real_executor,
            *,
            allow_real_fallback=True,
        ):
            self.calls.append((tool_name, tool_args, tool_call_id, allow_real_fallback))
            assert allow_real_fallback is False
            assert tool_name == "browser_action"
            return {
                "success": True,
                "world_model_simulated": True,
                "world_model_session_id": "wmh-session-1",
                "browser_state": {
                    "url": "https://shop.example.test/cart",
                    "title": "Cart",
                    "dom_tree": "[1]<button>Checkout</button>",
                },
                "frame": {"kind": "html", "html": "<main>Cart</main>"},
            }

    world_model = FakeWorldModel()
    result, state, frame = await _execute_simulated_browser_transition(
        world_model=world_model,
        goal="Buy the saved item",
        action={"action": "click", "index": 1, "thinking": "Open checkout"},
        browser_state={"url": "https://shop.example.test", "dom_tree": "[1]<button>Cart</button>"},
        tool_call_id="browser-step-1",
        write_lock_enabled=True,
    )
    assert result["world_model_session_id"] == "wmh-session-1"
    assert state["url"].endswith("/cart")
    assert frame == {"kind": "html", "html": "<main>Cart</main>"}
    assert len(world_model.calls) == 1
    assert world_model.calls[0][1]["action"] == "click"
    assert world_model.calls[0][1]["params"] == {"index": 1}


async def test_simulated_browser_transition_retries_when_wmh_omits_browser_state():
    # RCA'd from a real cloud sim run: the WMH (an LLM) returned a transition missing
    # browser_state at step 3, which hard-failed the whole browser session; the root agent
    # then stalled in a wait_for loop until the timeout. A single malformed transition must
    # be retried, not fatal.
    from domains.spawn_browser_agent_v3.handler import _execute_simulated_browser_transition

    class FlakyWorldModel:
        world_model_name = "rose-amazon"

        def __init__(self):
            self.calls = []

        async def execute(self, tool_name, tool_args, tool_call_id, real_executor, *, allow_real_fallback=True):
            self.calls.append((tool_call_id, tool_args["simulation_contract"]["instructions"]))
            if len(self.calls) == 1:
                # Malformed: omit browser_state entirely.
                return {"success": True, "world_model_simulated": True, "world_model_session_id": "wmh-1"}
            return {
                "success": True,
                "world_model_simulated": True,
                "world_model_session_id": "wmh-1",
                "browser_state": {
                    "url": "https://shop.example.test/results",
                    "title": "Results",
                    "dom_tree": "[1]<a>Product</a>",
                },
                "frame": {"kind": "html", "html": "<main>Results</main>"},
            }

    world_model = FlakyWorldModel()
    _result, state, _frame = await _execute_simulated_browser_transition(
        world_model=world_model,
        goal="Find a black beanie",
        action={"action": "search", "text": "black beanie", "thinking": "search"},
        browser_state={"url": "https://shop.example.test", "dom_tree": "[1]<input>"},
        tool_call_id="browser-step-3",
        write_lock_enabled=False,
    )
    # Recovered instead of aborting the trajectory.
    assert state["url"].endswith("/results")
    assert len(world_model.calls) == 2
    # Retry must use a DISTINCT tool_call_id so a cached malformed transition is not replayed.
    assert world_model.calls[0][0] != world_model.calls[1][0]
    assert world_model.calls[1][0] == "browser-step-3:retry2"
    # And the retry contract must carry the corrective reminder.
    assert "RETRY" in world_model.calls[1][1]


async def test_simulated_browser_transition_retries_repeated_approval_after_grant():
    # RCA from Amazon WMH run 20260720-143503-46570: after the write lock was
    # approved, WMH repeated the same approval boundary. The workflow treated
    # each repetition as a fresh write and requested approval forever.
    from domains.spawn_browser_agent_v3.handler import _execute_simulated_browser_transition

    class FlakyApprovalWorldModel:
        world_model_name = "rose-amazon"

        def __init__(self):
            self.calls = []

        async def execute(self, tool_name, tool_args, tool_call_id, real_executor, *, allow_real_fallback=True):
            del tool_name, real_executor, allow_real_fallback
            self.calls.append((tool_call_id, tool_args))
            if len(self.calls) == 1:
                return {
                    "success": True,
                    "status": "awaiting_write_approval",
                    "requires_approval": True,
                    "approval_type": "purchase",
                    "world_model_simulated": True,
                    "world_model_session_id": "wmh-approval",
                    "browser_state": {
                        "url": "https://www.amazon.com/gp/buy/spc/handlers/display.html",
                        "title": "Checkout",
                        "dom_tree": "[1]<button>Place your order</button>",
                    },
                }
            return {
                "success": True,
                "status": "completed",
                "requires_approval": False,
                "world_model_simulated": True,
                "world_model_session_id": "wmh-approval",
                "browser_state": {
                    "url": "https://www.amazon.com/gp/buy/thankyou/handlers/display.html",
                    "title": "Order placed",
                    "dom_tree": "Order #111-2222222-3333333",
                },
            }

    world_model = FlakyApprovalWorldModel()
    result, state, _frame = await _execute_simulated_browser_transition(
        world_model=world_model,
        goal="Complete the Amazon order",
        action={"action": "click", "index": 1, "thinking": "Place the approved order"},
        browser_state={
            "url": "https://www.amazon.com/gp/buy/spc/handlers/display.html",
            "dom_tree": "[1]<button>Place your order</button>",
        },
        tool_call_id="place-order:approved",
        write_lock_enabled=True,
        approved=True,
        approval_type="purchase",
    )

    assert result["status"] == "completed"
    assert state["url"].endswith("/thankyou/handlers/display.html")
    assert len(world_model.calls) == 2
    assert world_model.calls[1][0] == "place-order:approved:retry2"
    assert "repeated approval" in world_model.calls[1][1]["simulation_contract"]["instructions"]


async def test_simulated_browser_transition_raises_after_exhausting_retries():
    from domains.spawn_browser_agent_v3.handler import _execute_simulated_browser_transition

    class BrokenWorldModel:
        world_model_name = "rose-amazon"

        def __init__(self):
            self.calls = 0

        async def execute(self, tool_name, tool_args, tool_call_id, real_executor, *, allow_real_fallback=True):
            self.calls += 1
            return {"success": True, "world_model_simulated": True, "world_model_session_id": "s"}

    world_model = BrokenWorldModel()
    raised = False
    try:
        await _execute_simulated_browser_transition(
            world_model=world_model,
            goal="g",
            action={"action": "click", "index": 1},
            browser_state={"url": "u", "dom_tree": "[1]<button>"},
            tool_call_id="browser-step-9",
            write_lock_enabled=False,
        )
    except ValueError as exc:
        raised = True
        assert "browser_state" in str(exc)
    assert raised
    # Bounded: exactly 3 attempts, no infinite loop.
    assert world_model.calls == 3


async def test_spawn_browser_routes_simulation_without_calling_real_browser():
    from domains.spawn_browser_agent_v3 import handler as browser_handler

    fake_world_model = types.SimpleNamespace(
        should_simulate=lambda tool_name: tool_name == "browser_action",
    )
    simulated_result = {
        "status": "completed",
        "world_model_simulated": True,
        "simulated_browser_steps": 6,
    }
    simulated = AsyncMock(return_value=simulated_result)
    real = AsyncMock(side_effect=AssertionError("real browser must not be connected in simulator mode"))
    from_env = Mock(return_value=fake_world_model)
    with (
        patch.object(browser_handler.WorldModelToolExecutionAdapter, "from_env", from_env),
        patch.object(browser_handler, "_spawn_browser_agent_activity_v3_simulated", simulated),
        patch.object(browser_handler, "_spawn_browser_agent_activity_v3_real", real),
    ):
        result = await browser_handler.spawn_browser_agent_activity_v3(
            "user-1",
            "agent-1",
            "Buy the saved item",
            "tool-browser",
            output_schema={
                "fields": [
                    {
                        "name": "order_id",
                        "type": "string",
                        "description": "Amazon order confirmation ID",
                        "required": True,
                    }
                ]
            },
            world_model_mode="simulate",
        )
    assert result == simulated_result
    from_env.assert_called_once_with(
        agent_id="agent-1:browser:tool-browser",
        inherit_explicit_session=False,
        mode="simulate",
    )
    simulated.assert_awaited_once()
    real.assert_not_awaited()


async def test_simulated_browser_recorder_exports_scriptless_wmh_frame_replay():
    from domains.spawn_browser_agent_v3 import recording

    with tempfile.TemporaryDirectory() as tmp:
        with (
            patch.object(recording, "browser_recordings_enabled", return_value=True),
            patch.object(recording, "archive_enabled", return_value=False),
            patch.object(recording, "_recording_root", return_value=Path(tmp)),
        ):
            recorder = await recording.SimulatedBrowserRecorder.create(
                agent_id="agent-1",
                task_id="task-1",
                session_id="wmh-session-1",
            )
            assert recorder is not None
            await recorder.record_frame(
                {"html": "<main>Checkout</main><script>window.BAD=true</script>"},
                iteration=1,
                label="Checkout loaded",
                action="click",
                browser_state={"url": "https://shop.example.test/checkout", "title": "Checkout"},
            )
            resumed_recorder = await recording.SimulatedBrowserRecorder.create(
                agent_id="agent-1",
                task_id="task-1",
                session_id="wmh-session-1",
            )
            assert resumed_recorder is not None
            assert len(resumed_recorder.frames) == 1
            await resumed_recorder.record_frame(
                {"html": "<main>Order confirmed</main>"},
                iteration=2,
                label="Order confirmed",
                action="evaluate",
                browser_state={"url": "https://shop.example.test/confirmation", "title": "Confirmed"},
            )
            html_bytes = resumed_recorder.export_inline_html_bytes()
            assert html_bytes is not None
            replay = html_bytes.decode("utf-8")
            assert "el.sandbox=''" in replay
            assert "el.srcdoc=frameCsp+(frame.html||'')" in replay
            assert "default-src 'none'" in replay
            assert "allow-scripts" not in replay
            output = await resumed_recorder.close()
            assert output is not None and output.exists()
            manifest = json.loads((output.parent / "manifest.json").read_text(encoding="utf-8"))
            assert manifest["recording_source"] == "wmh_frames"
            assert manifest["frame_count"] == 2


def test_simulated_browser_resume_payload_is_compact_and_media_free():
    from domains.spawn_browser_agent_v3.handler import _simulated_browser_resume_payload

    oversized_media = "data:image/png;base64," + ("A" * 1_000_000)
    payload = _simulated_browser_resume_payload(
        browser_state={
            "url": "https://shop.example.test/checkout",
            "dom_tree": "D" * 100_000,
            "screenshot": oversized_media,
            "frame": {"src": oversized_media},
        },
        action_entries=[{"step": step, "result": {"image_url": oversized_media, "ok": True}} for step in range(50)],
        turn_messages=[{"role": "TOOL", "content": oversized_media} for _ in range(40)],
        recording_ref="/tmp/recordings/agent/task/frames.checkpoint.json",
        frame_count=51,
        visited_urls=[f"https://shop.example.test/{step}" for step in range(80)],
        reasoning_messages=[f"reason-{step}" for step in range(30)],
        action_summary=[f"action-{step}" for step in range(30)],
        world_model_session_id="wmh-session-1",
        total_input_tokens=123,
        total_output_tokens=45,
        usage_by_model={"gpt-5.6-sol-gpt": {"input_tokens": 123, "output_tokens": 45}},
    )

    encoded = json.dumps(payload)
    assert "simulated_frames" not in payload
    assert "simulated_latest_frame" not in payload
    assert "data:image" not in encoded
    assert len(payload["simulated_action_entries"]) == 30
    assert len(payload["simulated_turn_messages"]) == 24
    assert len(payload["simulated_visited_urls"]) == 50
    assert payload["simulated_recording_frame_count"] == 51
    assert payload["simulated_action_entry_count"] == 50
    assert payload["simulated_usage_by_model"] == {"gpt-5.6-sol-gpt": {"input_tokens": 123, "output_tokens": 45}}
    assert len(encoded) < 100_000


async def test_simulated_browser_runs_five_policy_steps_then_verified_completion():
    from domains.spawn_browser_agent_v3 import handler as browser_handler

    class FakeWorldModel:
        world_model_name = "rose-amazon"
        session_id = None

        def __init__(self):
            self.actions = []
            self.session_tasks = []

        async def ensure_session(self, *, task=None, seed_state=None):
            self.session_tasks.append((task, seed_state))
            self.session_id = "wmh-session-trajectory"
            return self.session_id

        async def execute(
            self,
            tool_name,
            tool_args,
            tool_call_id,
            real_executor,
            *,
            allow_real_fallback=True,
        ):
            del real_executor
            assert tool_name == "browser_action"
            assert allow_real_fallback is False
            action_name = tool_args["action"]
            self.actions.append(action_name)
            step = len(self.actions)
            return {
                "success": True,
                "world_model_simulated": True,
                "world_model_session_id": "wmh-session-trajectory",
                "browser_state": {
                    "url": f"https://amazon.example.test/step-{step}",
                    "title": f"Checkout step {step}",
                    "dom_tree": f"[{step + 1}]<button>Continue</button>",
                },
                "frame": {"kind": "html", "html": f"<main>Checkout step {step}</main>"},
            }

    class FakeStream:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        async def start(self):
            return None

        async def finish(self):
            return None

        async def finish_tools(self, status):
            return status

    class FakeRoseClient:
        def set_thinking_stream(self, stream):
            self.stream = stream

    policy_results = [
        {
            "action": {"action": "click", "index": index, "thinking": f"Complete step {index}"},
            "tool_call_id": f"policy-step-{index}",
            "usage": {"prompt_tokens": 10, "completion_tokens": 2},
        }
        for index in range(1, 6)
    ]
    policy_results.append(
        {
            "action": {"action": "attempt_completion", "thinking": "The order is visibly confirmed"},
            "tool_call_id": "policy-complete",
            "usage": {"prompt_tokens": 10, "completion_tokens": 2},
        }
    )
    policy = AsyncMock(side_effect=policy_results)
    verifier = AsyncMock(
        return_value={
            "score": 1,
            "reasoning": "The final WMH state shows the order confirmation.",
            "structured_response": {"order_id": "111-2222222-3333333"},
        }
    )
    world_model = FakeWorldModel()
    with (
        patch.object(browser_handler, "load_config", return_value=types.SimpleNamespace()),
        patch.object(
            browser_handler,
            "get_model_pricing_with_fallback",
            AsyncMock(return_value={"input_cents_per_1k": 0, "output_cents_per_1k": 0}),
        ),
        patch.object(browser_handler, "BrowserThinkingStream", FakeStream),
        patch.object(browser_handler, "BrowserStreamingRoseClient", FakeRoseClient),
        patch.object(browser_handler, "_call_browser_use_with_rotation", policy),
        patch.object(browser_handler, "_verify_simulated_browser_completion", verifier),
        patch.object(browser_handler, "save_browser_action_message", AsyncMock()),
        patch.object(browser_handler, "save_browser_assistant_message", AsyncMock()),
        patch.object(browser_handler.SimulatedBrowserRecorder, "create", AsyncMock(return_value=None)),
        patch.object(browser_handler, "ACTION_LOOP_DELAY_SECONDS", 0),
    ):
        result = await browser_handler._spawn_browser_agent_activity_v3_simulated(
            user_id="user-1",
            agent_id="agent-1",
            goal="Complete the Amazon order",
            tool_call_id="tool-browser",
            task_id="browser-task",
            session_id=None,
            cdp_url=None,
            is_resume=False,
            output_schema={
                "fields": [
                    {
                        "name": "order_id",
                        "type": "string",
                        "description": "Amazon order confirmation ID",
                        "required": True,
                    }
                ]
            },
            attachments=None,
            write_lock_enabled=True,
            start_url="https://amazon.example.test",
            write_lock_resume_state=None,
            system_name="Rose",
            use_claude_mode=False,
            gpt_token=None,
            gpt_account_id=None,
            gpt_token_source=None,
            gpt_token_pool_id=None,
            world_model=world_model,
        )

    assert result["status"] == "completed"
    assert result["world_model_simulated"] is True
    assert result["simulated_browser_steps"] == 6
    assert result["structured_response"]["order_id"] == "111-2222222-3333333"
    assert len(world_model.session_tasks) == 1
    session_task, session_seed = world_model.session_tasks[0]
    assert session_task == "Complete the Amazon order"
    assert session_seed["url"] == "https://amazon.example.test"
    assert session_seed["title"] == "Amazon.com"
    assert "Initial page loaded" in session_seed["dom_tree"]
    assert world_model.actions == ["click", "click", "click", "click", "click"]
    assert policy.await_count == 6
    verifier.assert_awaited_once()
    verifier_actions = verifier.await_args.kwargs["action_entries"]
    assert [entry["step"] for entry in verifier_actions] == [1, 2, 3, 4, 5, 6]


async def test_simulated_browser_persists_post_approval_confirmation_state():
    from domains.spawn_browser_agent_v3 import handler as browser_handler

    confirmation_url = "https://amazon.example.test/gp/buy/thankyou/handlers/display.html"

    class FakeWorldModel:
        world_model_name = "rose-amazon"
        session_id = None

        async def execute(
            self,
            tool_name,
            tool_args,
            tool_call_id,
            real_executor,
            *,
            allow_real_fallback=True,
        ):
            del real_executor
            assert tool_name == "browser_action"
            assert allow_real_fallback is False
            assert tool_args["action"] == "evaluate"
            assert tool_args["approval"]["granted"] is True
            assert tool_call_id == "place-order:approved"
            return {
                "success": True,
                "status": "completed",
                "world_model_simulated": True,
                "world_model_session_id": "wmh-session-approval",
                "browser_state": {
                    "url": confirmation_url,
                    "title": "Amazon.com Order Confirmation",
                    "dom_tree": {
                        "role": "WebArea",
                        "name": "Order placed, thanks Aman!",
                        "children": [{"role": "text", "name": "Order #111-2222222-3333333"}],
                    },
                    "recent_events": [{"type": "order_placed", "order_id": "111-2222222-3333333"}],
                },
                "frame": {"kind": "html", "html": "<main>Order placed, thanks Aman!</main>"},
            }

    class FakeStream:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        async def start(self):
            return None

        async def finish(self):
            return None

        async def finish_tools(self, status):
            return status

    class FakeRoseClient:
        def set_thinking_stream(self, stream):
            self.stream = stream

    policy = AsyncMock(
        return_value={
            "action": {"action": "attempt_completion", "thinking": "Confirmation is visible"},
            "tool_call_id": "policy-complete",
            "usage": {"prompt_tokens": 10, "completion_tokens": 2},
        }
    )
    verifier = AsyncMock(
        return_value={
            "score": 1,
            "reasoning": "The WMH confirmation state grounds the completed order.",
            "structured_response": {"order_id": "111-2222222-3333333"},
        }
    )
    saved_actions = AsyncMock()
    checkout_state = {
        "url": "https://amazon.example.test/gp/buy/spc/handlers/display.html",
        "title": "Checkout",
        "dom_tree": "[1]<button>Place your order</button>",
    }
    resume_state = {
        "pending_action": {
            "action": "evaluate",
            "params": {"expression": "document.querySelector('#place-order').click()"},
        },
        "approval_type": "payment",
        "step_count": 6,
        "task_id": "browser-task",
        "world_model_session_id": "wmh-session-approval",
        "simulated_pending_tool_call_id": "place-order",
        "simulated_browser_state": checkout_state,
        "simulated_action_entries": [
            {
                "step": 6,
                "action": "evaluate",
                "result": {"requires_approval": True},
                "approval_required": True,
            }
        ],
        "simulated_turn_messages": [],
        "simulated_frames": [],
        "simulated_visited_urls": [checkout_state["url"]],
        "simulated_reasoning_messages": [],
        "simulated_action_summary": ["evaluate: place order"],
    }

    with (
        patch.object(browser_handler, "load_config", return_value=types.SimpleNamespace()),
        patch.object(
            browser_handler,
            "get_model_pricing_with_fallback",
            AsyncMock(return_value={"input_cents_per_1k": 0, "output_cents_per_1k": 0}),
        ),
        patch.object(browser_handler, "BrowserThinkingStream", FakeStream),
        patch.object(browser_handler, "BrowserStreamingRoseClient", FakeRoseClient),
        patch.object(browser_handler, "_call_browser_use_with_rotation", policy),
        patch.object(browser_handler, "_verify_simulated_browser_completion", verifier),
        patch.object(browser_handler, "save_browser_action_message", saved_actions),
        patch.object(browser_handler, "save_browser_assistant_message", AsyncMock()),
        patch.object(browser_handler.SimulatedBrowserRecorder, "create", AsyncMock(return_value=None)),
        patch.object(browser_handler, "ACTION_LOOP_DELAY_SECONDS", 0),
    ):
        result = await browser_handler._spawn_browser_agent_activity_v3_simulated(
            user_id="user-1",
            agent_id="agent-1",
            goal="Complete the Amazon order",
            tool_call_id="tool-browser",
            task_id="browser-task",
            session_id=None,
            cdp_url=None,
            is_resume=True,
            output_schema={
                "fields": [
                    {
                        "name": "order_id",
                        "type": "string",
                        "description": "Amazon order confirmation ID",
                        "required": True,
                    }
                ]
            },
            attachments=None,
            write_lock_enabled=True,
            start_url="https://amazon.example.test",
            write_lock_resume_state=resume_state,
            system_name="Rose",
            use_claude_mode=False,
            gpt_token=None,
            gpt_account_id=None,
            gpt_token_source=None,
            gpt_token_pool_id=None,
            world_model=FakeWorldModel(),
        )

    assert result["status"] == "completed"
    assert result["current_url"] == confirmation_url
    assert confirmation_url in result["message"]
    approval_event = next(
        call for call in saved_actions.await_args_list if call.kwargs.get("tool_call_id") == "place-order:approved"
    )
    approval_evidence = json.loads(approval_event.kwargs["message"])
    assert approval_evidence["approved"] is True
    assert approval_evidence["browser_state"]["url"] == confirmation_url
    assert "Order placed, thanks Aman!" in approval_evidence["browser_state"]["dom_tree"]
    assert approval_event.kwargs["steps_taken"] == 6


async def test_runtime_world_model_session_uses_first_tool_goal_as_task():
    from helpers import world_model_runtime as runtime

    requests: list[tuple[str, dict]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode("utf-8"))
        requests.append((str(request.url), body))
        if str(request.url).endswith("/world_models/rose-golden/sessions"):
            return httpx.Response(200, json={"session_id": "session-goal"})
        if str(request.url).endswith("/world_models/rose-golden/sessions/session-goal/step"):
            return httpx.Response(
                200,
                json={
                    "observation": {
                        "content": '{"status":"completed","success":true}',
                        "is_error": False,
                        "metadata": {},
                    }
                },
            )
        return httpx.Response(404, json={"error": "unexpected"})

    async def real_executor(_tool_name: str, _tool_args: dict, _tool_call_id: str) -> dict:
        raise AssertionError("simulate mode must not call the real executor")

    runtime._WMH_SESSION_CACHE.pop(("agent-goal-test", "rose-golden"), None)
    setup_mock_fn(handler)
    try:
        adapter = runtime.WorldModelToolExecutionAdapter(
            mode="simulate",
            client=runtime.WMHHttpClient("https://wmh.example.test"),
            world_model_name="rose-golden",
            agent_id="agent-goal-test",
        )
        result = await adapter.execute(
            "browser_action",
            {"goal": "Complete the Amazon checkout"},
            "tool-browser",
            real_executor,
        )
        assert result["status"] == "completed"
        assert requests[0][1]["task"] == "Complete the Amazon checkout"
    finally:
        runtime._WMH_SESSION_CACHE.pop(("agent-goal-test", "rose-golden"), None)
        teardown_mock()


async def test_runtime_world_model_session_forwards_seed_state():
    from helpers import world_model_runtime as runtime

    requests: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content.decode("utf-8")))
        return httpx.Response(200, json={"session_id": "session-seeded"})

    seed_state = {
        "url": "https://www.amazon.com/s?k=black+beanie",
        "title": "Amazon.com",
        "dom_tree": '{"role":"webarea","name":"Amazon.com"}',
    }
    runtime._WMH_SESSION_CACHE.pop(("agent-seed-test", "rose-golden"), None)
    setup_mock_fn(handler)
    try:
        adapter = runtime.WorldModelToolExecutionAdapter(
            mode="simulate",
            client=runtime.WMHHttpClient("https://wmh.example.test"),
            world_model_name="rose-golden",
            agent_id="agent-seed-test",
        )
        session_id = await adapter.ensure_session(
            task="Complete the Amazon checkout",
            seed_state=seed_state,
        )

        assert session_id == "session-seeded"
        assert requests == [
            {
                "task": "Complete the Amazon checkout",
                "seed_state": seed_state,
            }
        ]
    finally:
        runtime._WMH_SESSION_CACHE.pop(("agent-seed-test", "rose-golden"), None)
        teardown_mock()


def test_browser_adapter_can_ignore_run_wide_world_model_session():
    """Browser simulation must not inherit unrelated run-wide WMH history."""

    from helpers.world_model_runtime import WorldModelToolExecutionAdapter

    keys = [
        "BENCHMARK_WORLD_MODEL_MODE",
        "WMH_BASE_URL",
        "WMH_MODEL_NAME",
        "WMH_SESSION_ID",
        "WORLD_MODEL_SESSION_ID",
    ]
    old_env = {key: os.environ.get(key) for key in keys}
    try:
        os.environ["BENCHMARK_WORLD_MODEL_MODE"] = "simulate"
        os.environ["WMH_BASE_URL"] = "https://wmh.example.test"
        os.environ["WMH_MODEL_NAME"] = "rose-golden"
        os.environ["WMH_SESSION_ID"] = "run-wide-session"
        os.environ.pop("WORLD_MODEL_SESSION_ID", None)

        adapter = WorldModelToolExecutionAdapter.from_env(
            agent_id="browser-agent",
            inherit_explicit_session=False,
        )

        assert adapter.session_id is None
    finally:
        for key, value in old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def test_per_agent_world_model_mode_overrides_process_default():
    """A product agent's persisted mode wins over the worker-wide benchmark default."""

    from helpers.world_model_runtime import WorldModelToolExecutionAdapter

    old_mode = os.environ.get("BENCHMARK_WORLD_MODEL_MODE")
    try:
        os.environ["BENCHMARK_WORLD_MODEL_MODE"] = "real"
        adapter = WorldModelToolExecutionAdapter.from_env(
            agent_id="product-agent",
            mode="simulate",
        )
        assert adapter.mode == "simulate"
        assert adapter.should_simulate("web_search") is True
    finally:
        if old_mode is None:
            os.environ.pop("BENCHMARK_WORLD_MODEL_MODE", None)
        else:
            os.environ["BENCHMARK_WORLD_MODEL_MODE"] = old_mode


async def test_world_model_tool_execution_adapter_simulate_and_shadow_modes():
    from benchmarks.world_model_harness import (
        WMHHttpClient,
        WorldModelToolExecutionAdapter,
        is_world_model_environment_boundary,
    )

    calls: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append({"url": str(request.url), "body": request.content.decode("utf-8")})
        if str(request.url).endswith("/world_models/rose-golden/sessions/session-1/step"):
            body = json.loads(request.content.decode("utf-8"))
            assert body["action"]["name"] == "rose.vapi.vapi_poll_call"
            assert body["action"]["arguments"]["timestamp_ms"] == 1893456000123
            return httpx.Response(
                200,
                json={
                    "observation": {
                        "content": "simulated provider observation",
                        "metadata": {"provider_ref": "provider.enc"},
                        "predicted_latency_ms": 1234,
                    }
                },
            )
        return httpx.Response(404, json={"error": "unexpected"})

    real_calls: list[tuple[str, dict, str]] = []

    async def real_executor(tool_name: str, tool_args: dict, tool_call_id: str) -> dict:
        real_calls.append((tool_name, tool_args, tool_call_id))
        return {"success": True, "result": {"real": True}}

    setup_mock_fn(handler)
    old_env = os.environ.get("WMH_SIM_TIME_MS")
    try:
        os.environ["WMH_SIM_TIME_MS"] = "1893456000123"
        simulate = WorldModelToolExecutionAdapter(
            mode="simulate",
            client=WMHHttpClient("https://wmh.example.test"),
            world_model_name="rose-golden",
            session_id="session-1",
        )
        assert is_world_model_environment_boundary("vapi_poll_call") is True
        assert is_world_model_environment_boundary("web_search") is True
        assert is_world_model_environment_boundary("web_fetch") is True
        assert is_world_model_environment_boundary("people_search") is True
        assert is_world_model_environment_boundary("spawn_agent") is False
        assert is_world_model_environment_boundary("spawn_browser_agent") is False
        assert is_world_model_environment_boundary("browser_action") is True
        assert is_world_model_environment_boundary("call_phone_number") is True
        assert is_world_model_environment_boundary("payment_mint") is True
        assert is_world_model_environment_boundary("send_direct_sms") is True
        # Fast cache stays live under simulation — isolated by key scope
        # (world_model_cache_scope), never by WMH interception.
        assert is_world_model_environment_boundary("fast_cache_read") is False
        assert is_world_model_environment_boundary("fast_cache_write") is False
        assert simulate.should_simulate("vapi_poll_call") is True
        assert simulate.should_simulate("spawn_agent") is False

        simulated = await simulate.execute("vapi_poll_call", {"call_id": "call-1"}, "tool-vapi", real_executor)
        assert simulated["world_model_simulated"] is True
        assert simulated["result"]["content"] == "simulated provider observation"
        assert simulated["predicted_latency_ms"] == 1234
        assert simulated["world_model_wall_elapsed_ms"] >= 0
        assert simulated["simulated_elapsed_ms"] >= 1234
        assert real_calls == []

        agent_facing = await simulate.execute("spawn_agent", {"goal": "child task"}, "tool-agent", real_executor)
        assert agent_facing["result"] == {"real": True}
        assert real_calls == [("spawn_agent", {"goal": "child task"}, "tool-agent")]

        shadow = WorldModelToolExecutionAdapter(
            mode="shadow",
            client=WMHHttpClient("https://wmh.example.test"),
            world_model_name="rose-golden",
            session_id="session-1",
        )
        shadowed = await shadow.execute("vapi_poll_call", {"call_id": "call-1"}, "tool-vapi", real_executor)
        assert shadowed["result"] == {"real": True}
        assert shadowed["world_model_shadow"]["content"] == "simulated provider observation"
        assert shadowed["world_model_shadow_wall_elapsed_ms"] >= 0
        assert real_calls == [
            ("spawn_agent", {"goal": "child task"}, "tool-agent"),
            ("vapi_poll_call", {"call_id": "call-1"}, "tool-vapi"),
        ]
        assert len(calls) == 2
    finally:
        if old_env is None:
            os.environ.pop("WMH_SIM_TIME_MS", None)
        else:
            os.environ["WMH_SIM_TIME_MS"] = old_env
        teardown_mock()


async def test_world_model_simulate_can_fallback_on_unavailable_observation():
    from benchmarks.world_model_harness import WMHHttpClient, WorldModelToolExecutionAdapter

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url).endswith("/world_models/rose-golden/sessions/session-1/step"):
            return httpx.Response(
                200,
                json={
                    "observation": {
                        "content": json.dumps(
                            {
                                "content": "",
                                "metadata": {"result_unavailable": True, "source": "llm_dump"},
                            }
                        )
                    }
                },
            )
        return httpx.Response(404, json={"error": "unexpected"})

    real_calls: list[tuple[str, dict, str]] = []

    async def real_executor(tool_name: str, tool_args: dict, tool_call_id: str) -> dict:
        real_calls.append((tool_name, tool_args, tool_call_id))
        return {"success": True, "result": {"live": True}}

    setup_mock_fn(handler)
    old_env = os.environ.get("BENCHMARK_WMH_FALLBACK_ON_UNAVAILABLE")
    try:
        os.environ["BENCHMARK_WMH_FALLBACK_ON_UNAVAILABLE"] = "1"
        simulate = WorldModelToolExecutionAdapter(
            mode="simulate",
            client=WMHHttpClient("https://wmh.example.test"),
            world_model_name="rose-golden",
            session_id="session-1",
        )
        result = await simulate.execute("web_search", {"query": "Lisbon climate"}, "tool-web", real_executor)
        assert result["result"] == {"live": True}
        assert result["world_model_unavailable_fallback"] is True
        assert real_calls == [("web_search", {"query": "Lisbon climate"}, "tool-web")]

        no_fallback = await simulate.execute(
            "web_search",
            {"query": "Lisbon climate"},
            "tool-web-no-fallback",
            real_executor,
            allow_real_fallback=False,
        )
        assert no_fallback["world_model_simulated"] is True
        assert no_fallback.get("world_model_unavailable_fallback") is None
        assert real_calls == [("web_search", {"query": "Lisbon climate"}, "tool-web")]
    finally:
        if old_env is None:
            os.environ.pop("BENCHMARK_WMH_FALLBACK_ON_UNAVAILABLE", None)
        else:
            os.environ["BENCHMARK_WMH_FALLBACK_ON_UNAVAILABLE"] = old_env
        teardown_mock()


async def test_simulated_provider_activities_call_wmh_instead_of_live_services():
    from domains.call_phone_number.handler import call_phone_number_activity
    from domains.request_payment_card.repo import lookup_purchase_activity, mint_purchase_card_activity
    from domains.web_fetch.handler import web_fetch_activity
    from helpers.sms_activities import notify_sms_event_activity, send_direct_sms_activity
    from tools.people_search.handler import people_search_activity
    from tools.web_search.handler import web_search_activity

    actions: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if not str(request.url).endswith("/world_models/rose-golden/sessions/session-activity/step"):
            return httpx.Response(404, json={"error": "unexpected"})
        body = json.loads(request.content.decode("utf-8"))
        action_name = body["action"]["arguments"]["name"]
        actions.append(action_name)
        return httpx.Response(
            200,
            json={
                "observation": {
                    "content": f"simulated {action_name}",
                    "tool_result": {
                        "success": True,
                        "answer": f"answer from {action_name}",
                        "markdown": f"markdown from {action_name}",
                        "results": [{"name": action_name}],
                        "call_id": "sim-call",
                        "status": "completed",
                        "id": "sim-card",
                        "sms": "sent",
                    },
                }
            },
        )

    old_env = {
        "BENCHMARK_WORLD_MODEL_MODE": os.environ.get("BENCHMARK_WORLD_MODEL_MODE"),
        "WMH_BASE_URL": os.environ.get("WMH_BASE_URL"),
        "WMH_MODEL_NAME": os.environ.get("WMH_MODEL_NAME"),
        "WMH_SESSION_ID": os.environ.get("WMH_SESSION_ID"),
    }
    setup_mock_fn(handler)
    try:
        os.environ["BENCHMARK_WORLD_MODEL_MODE"] = "simulate"
        os.environ["WMH_BASE_URL"] = "https://wmh.example.test"
        os.environ["WMH_MODEL_NAME"] = "rose-golden"
        os.environ["WMH_SESSION_ID"] = "session-activity"

        assert (await web_search_activity("latest rose labs news"))["answer"] == "answer from web_search"
        assert (await web_fetch_activity("https://example.test"))["markdown"] == "markdown from web_fetch"
        assert (await people_search_activity("Ada Lovelace", "enrich", "exa"))["results"] == [{"name": "people_search"}]
        assert (await call_phone_number_activity("+15551234567", "ask", {}, "agent-1", "tool-call"))[
            "call_id"
        ] == "sim-call"
        assert (await lookup_purchase_activity("user-1", "fp-1"))["id"] == "sim-card"
        assert (
            await mint_purchase_card_activity(
                "user-1",
                {"fingerprint": "fp-2", "merchant": "Merchant", "agentId": "agent-1"},
            )
        )["id"] == "sim-card"
        assert (await send_direct_sms_activity("user-1", "hello"))["sms"] == "sent"
        assert (await notify_sms_event_activity("user-1", "completion", "agent-1", {"summary": "done"}))[
            "sms"
        ] == "sent"
        assert actions == [
            "web_search",
            "web_fetch",
            "people_search",
            "call_phone_number",
            "payment_lookup",
            "payment_mint",
            "send_direct_sms",
            "notify_sms_event",
        ]
    finally:
        teardown_mock()
        for key, value in old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def test_write_eval_suite_matches_wmh_examples_shape():
    from benchmarks.world_model_harness import write_eval_suite

    with tempfile.TemporaryDirectory() as tmp:
        trace = Path(tmp) / "traces.otel.jsonl"
        trace.write_text("{}", encoding="utf-8")
        suite = write_eval_suite(Path(tmp) / "evals", trace_file=trace, title="Rose WMH")
        text = suite.read_text(encoding="utf-8")
        assert 'title = "Rose WMH"' in text
        assert 'files = ["../traces.otel.jsonl"]' in text
        assert "train_split = 0.7" in text
        assert 'judge = "rubric"' in text


async def run_all_tests():
    print("world model harness blackbox tests:")
    r = BlackboxResult()
    r.record(
        "exported_otel_jsonl_ingests_with_upstream_wmh_and_preserves_state_refs",
        test_exported_otel_jsonl_ingests_with_upstream_wmh_and_preserves_state_refs,
    )
    r.record(
        "exported_otel_jsonl_reads_trace_bundle_from_r2_backend",
        test_exported_otel_jsonl_reads_trace_bundle_from_r2_backend,
    )
    r.record(
        "bundle_signature_ignores_plaintext_public_manifest_but_rejects_untracked_ciphertext",
        test_bundle_signature_ignores_plaintext_public_manifest_but_rejects_untracked_ciphertext,
    )
    r.record(
        "bundle_signature_r2_rejects_enumerated_ciphertext_without_metadata",
        test_bundle_signature_r2_rejects_enumerated_ciphertext_without_metadata,
    )
    r.record(
        "replay_corpus_split_and_initial_state_are_deterministic_and_public",
        test_replay_corpus_split_and_initial_state_are_deterministic_and_public,
    )
    r.record(
        "build_world_model_from_archives_uses_upstream_build_boundary",
        test_build_world_model_from_archives_uses_upstream_build_boundary,
    )
    r.record(
        "update_world_model_for_simulation_uses_delta_exports_and_progress_events",
        test_update_world_model_for_simulation_uses_delta_exports_and_progress_events,
    )
    r.record(
        "refresh_world_model_index_persists_retriever_index_without_gepa",
        test_refresh_world_model_index_persists_retriever_index_without_gepa,
    )
    r.record(
        "refresh_world_model_index_streams_jsonl_in_bounded_batches",
        test_refresh_world_model_index_streams_jsonl_in_bounded_batches,
    )
    r.record(
        "update_world_model_excludes_simulated_bundles_from_corpus",
        test_update_world_model_excludes_simulated_bundles_from_corpus,
    )
    r.record(
        "world_model_bundle_cap_preserves_existing_index_entries",
        test_world_model_bundle_cap_preserves_existing_index_entries,
    )
    r.record(
        "grounded_export_uses_real_browser_results_and_excludes_unavailable_llm_fallbacks",
        test_grounded_export_uses_real_browser_results_and_excludes_unavailable_llm_fallbacks,
    )
    r.record(
        "load_transitions_drops_fast_cache_replays_from_corpus",
        test_load_transitions_drops_fast_cache_replays_from_corpus,
    )
    r.record(
        "build_world_model_from_archives_runs_actual_upstream_build_with_fake_provider",
        test_build_world_model_from_archives_runs_actual_upstream_build_with_fake_provider,
    )
    r.record(
        "compare_real_vs_world_model_benchmark_outcomes",
        test_compare_real_vs_world_model_benchmark_outcomes,
    )
    r.record(
        "root_loader_keeps_child_llm_dumps_for_diagnostics_but_grounded_export_excludes_them",
        test_root_loader_keeps_child_llm_dumps_for_diagnostics_but_grounded_export_excludes_them,
    )
    r.record(
        "canonical_action_categories_cover_agent_tool_families",
        test_canonical_action_categories_cover_agent_tool_families,
    )
    r.record(
        "world_model_action_timestamp_uses_sim_clock_env_and_validates_it",
        test_world_model_action_timestamp_uses_sim_clock_env_and_validates_it,
    )
    r.record(
        "world_model_observation_latency_normalization_matches_runtime_helper",
        test_world_model_observation_latency_normalization_matches_runtime_helper,
    )
    r.record(
        "world_model_observation_passes_through_activity_tool_result",
        test_world_model_observation_passes_through_activity_tool_result,
    )
    r.record(
        "world_model_observation_decodes_real_server_json_content",
        test_world_model_observation_decodes_real_server_json_content,
    )
    r.record(
        "simulated_browser_transition_contract_requires_one_grounded_action",
        test_simulated_browser_transition_contract_requires_one_grounded_action,
    )
    r.record(
        "simulated_browser_transition_normalizes_real_wmh_observation_shapes",
        test_simulated_browser_transition_normalizes_real_wmh_observation_shapes,
    )
    r.record(
        "browser_adapter_can_ignore_run_wide_world_model_session",
        test_browser_adapter_can_ignore_run_wide_world_model_session,
    )
    r.record(
        "per_agent_world_model_mode_overrides_process_default",
        test_per_agent_world_model_mode_overrides_process_default,
    )
    r.record(
        "wmh_http_clients_allow_slow_grounded_transitions",
        test_wmh_http_clients_allow_slow_grounded_transitions,
    )
    r.record("write_eval_suite_matches_wmh_examples_shape", test_write_eval_suite_matches_wmh_examples_shape)
    await r.record_async(
        "wmh_http_client_matches_upstream_serving_routes", test_wmh_http_client_matches_upstream_serving_routes
    )
    await r.record_async(
        "evaluate_archive_with_world_model_scores_dimensions_and_redacts_public_result",
        test_evaluate_archive_with_world_model_scores_dimensions_and_redacts_public_result,
    )
    await r.record_async(
        "evaluate_archives_with_world_model_scores_batch_mean",
        test_evaluate_archives_with_world_model_scores_batch_mean,
    )
    await r.record_async(
        "world_model_tool_execution_adapter_simulate_and_shadow_modes",
        test_world_model_tool_execution_adapter_simulate_and_shadow_modes,
    )
    await r.record_async(
        "runtime_world_model_session_uses_first_tool_goal_as_task",
        test_runtime_world_model_session_uses_first_tool_goal_as_task,
    )
    await r.record_async(
        "runtime_world_model_session_forwards_seed_state",
        test_runtime_world_model_session_forwards_seed_state,
    )
    await r.record_async(
        "world_model_simulate_can_fallback_on_unavailable_observation",
        test_world_model_simulate_can_fallback_on_unavailable_observation,
    )
    await r.record_async(
        "simulated_browser_transition_calls_wmh_once_and_forbids_real_fallback",
        test_simulated_browser_transition_calls_wmh_once_and_forbids_real_fallback,
    )
    await r.record_async(
        "simulated_browser_transition_retries_when_wmh_omits_browser_state",
        test_simulated_browser_transition_retries_when_wmh_omits_browser_state,
    )
    await r.record_async(
        "simulated_browser_transition_retries_repeated_approval_after_grant",
        test_simulated_browser_transition_retries_repeated_approval_after_grant,
    )
    await r.record_async(
        "simulated_browser_transition_raises_after_exhausting_retries",
        test_simulated_browser_transition_raises_after_exhausting_retries,
    )
    await r.record_async(
        "spawn_browser_routes_simulation_without_calling_real_browser",
        test_spawn_browser_routes_simulation_without_calling_real_browser,
    )
    await r.record_async(
        "simulated_browser_recorder_exports_scriptless_wmh_frame_replay",
        test_simulated_browser_recorder_exports_scriptless_wmh_frame_replay,
    )
    r.record(
        "simulated_browser_resume_payload_is_compact_and_media_free",
        test_simulated_browser_resume_payload_is_compact_and_media_free,
    )
    await r.record_async(
        "simulated_browser_runs_five_policy_steps_then_verified_completion",
        test_simulated_browser_runs_five_policy_steps_then_verified_completion,
    )
    await r.record_async(
        "simulated_browser_persists_post_approval_confirmation_state",
        test_simulated_browser_persists_post_approval_confirmation_state,
    )
    await r.record_async(
        "simulated_provider_activities_call_wmh_instead_of_live_services",
        test_simulated_provider_activities_call_wmh_instead_of_live_services,
    )
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    import asyncio

    asyncio.run(run_all_tests())
