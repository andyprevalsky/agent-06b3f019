"""Blackbox tests for Rose archive -> World Model Harness integration."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import types
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import httpx

from _test_utils import BlackboxResult, native_browser_start_source, setup_mock_fn, teardown_mock


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
    if not (reference / "wmh" / "core" / "types.py").is_file():
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
        # Mirrors the terminal lifecycle write (traceArchiveLifecycle.ts): a
        # finalized manifest with the root's terminal status is what makes a
        # bundle corpus-eligible.
        "finalized": True,
        "run": {
            "root_goal": "Find the support phone number and verify browser checkout state",
            "root_status": "COMPLETED",
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

    def head_object(self, *, Bucket: str, Key: str) -> dict:
        if Key not in self.objects:
            error = Exception(f"NoSuchKey: {Key}")
            error.response = {"Error": {"Code": "NoSuchKey"}}
            raise error
        return {
            "ContentLength": len(self.objects[Key]),
            "ETag": f'"{hashlib.md5(self.objects[Key]).hexdigest()}"',
        }

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
        return {
            "IsTruncated": False,
            "Contents": [
                {"Key": key, "Size": len(self.objects[key]), "ETag": f'"{hashlib.md5(self.objects[key]).hexdigest()}"'}
                for key in keys
            ],
        }


def test_fake_r2_head_preserves_metadata_only_contract():
    client = _FakeR2Client({"present.enc": b"ciphertext"})
    # HEAD must not delegate to GET or expose a body, including an orphan hit.
    def forbidden_get(**kwargs):
        raise AssertionError("HEAD must not perform GET")

    client.get_object = forbidden_get
    metadata = client.head_object(Bucket="unit-bucket", Key="present.enc")
    assert metadata["ContentLength"] == len(b"ciphertext")
    assert metadata["ETag"] == f'"{hashlib.md5(b"ciphertext").hexdigest()}"'
    assert "Body" not in metadata
    try:
        client.head_object(Bucket="unit-bucket", Key="absent.enc")
    except Exception as exc:
        assert exc.response["Error"]["Code"] == "NoSuchKey"
    else:
        raise AssertionError("absent HEAD must report missing object")


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


def test_bundle_signature_ignores_plaintext_public_manifest_and_tracks_unrelated_orphan():
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

            old_sha = signature["sha256"]
            (bundle_root / "untracked.enc").write_bytes(b"missing archive metadata")
            signature = _bundle_signature(root_agent_id)
            assert signature["artifact_count"] == len(encrypted_paths) + 1
            assert signature["sha256"] != old_sha
        finally:
            restore()


def test_bundle_signature_and_refs_read_metadata_only_under_r2():
    """Corpus signatures and artifact refs must never download ciphertext bodies.

    A 20-bundle World Model build previously fetched every encrypted artifact
    (screenshots, multi-MB DB fixtures) just to read its sidecar metadata, at
    ~100ms per sequential R2 round trip, and the local stack's readiness budget
    killed the build. Only ``.meta.json`` objects may be fetched here.
    """
    from benchmarks.world_model_harness import _artifact_meta_ref, _bundle_signature, _fixture_ref

    with tempfile.TemporaryDirectory() as tmp:
        local_restore = _with_archive_env(tmp)
        try:
            root_agent_id = "root-r2-metadata-only"
            _write_golden_bundle(root_agent_id)
            objects = _local_bundle_to_fake_r2(tmp)
        finally:
            local_restore()

        fetched: list[str] = []
        headed: list[str] = []
        client = _FakeR2Client(objects)
        original_get = client.get_object
        original_head = getattr(client, "head_object", None)

        def recording_get(*, Bucket: str, Key: str) -> dict:
            fetched.append(Key)
            return original_get(Bucket=Bucket, Key=Key)

        def recording_head(*, Bucket: str, Key: str) -> dict:
            headed.append(Key)
            assert original_head is not None, "fake R2 client must implement HEAD"
            return original_head(Bucket=Bucket, Key=Key)

        client.get_object = recording_get
        client.head_object = recording_head
        import helpers.trace_archive as trace_archive

        r2_restore = _with_fake_r2_archive(objects)
        trace_archive._R2_CLIENT = client
        try:
            signature = _bundle_signature(root_agent_id)
            # Under R2 the signature comes from the listing (size + ETag): no GETs at all.
            assert fetched == [], fetched
            fixture = _fixture_ref(root_agent_id, "db/start.fixture.json.gz.enc")
            meta_ref = _artifact_meta_ref(root_agent_id, "db/start.fixture.json.gz.enc")
            missing = _artifact_meta_ref(root_agent_id, "does/not/exist.json.gz.enc")
        finally:
            r2_restore()

        encrypted_keys = [
            key for key in objects if key.startswith(f"trace-archive/{root_agent_id}/") and key.endswith(".enc")
        ]
        assert signature["artifact_count"] == len(encrypted_keys)
        assert signature["ciphertext_bytes"] > 0
        assert fixture and fixture["plaintext_sha256"]
        assert meta_ref and meta_ref["plaintext_sha256"] == fixture["plaintext_sha256"]
        assert missing is None
        bodies = [key for key in fetched if not key.endswith(".meta.json")]
        # A missing artifact is probed by HEAD; no ciphertext GET is allowed.
        assert bodies == [], bodies
        assert headed == [
            f"trace-archive/{root_agent_id}/db/start.fixture.json.gz.enc",
            f"trace-archive/{root_agent_id}/db/start.fixture.json.gz.enc",
            f"trace-archive/{root_agent_id}/does/not/exist.json.gz.enc",
        ], headed


def test_bundle_signature_r2_tracks_enumerated_ciphertext_without_metadata():
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

            old_sha = signature["sha256"]
            objects[f"trace-archive/{root_agent_id}/untracked.enc"] = b"missing archive metadata"
            signature = _bundle_signature(root_agent_id)
            assert signature["artifact_count"] == len(encrypted_keys) + 1
            assert signature["sha256"] != old_sha
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
                                "id": "spawn-args",
                                "agentId": root,
                                "role": "ASSISTANT",
                                "createdAt": "2026-07-20T00:00:00Z",
                                "metadata": {
                                    "tool_calls": [
                                        {
                                            "tool": "spawn_agent",
                                            "type": "explore",
                                            "goal": "Research the market",
                                            "depth": "quick",
                                            "tool_call_id": "explore-call",
                                        },
                                        {
                                            "tool": "spawn_agent",
                                            "type": "for_each",
                                            "goal": "Contact each investor",
                                            "items": [{"name": "A"}],
                                            "tool_call_id": "for-each-call",
                                        },
                                        {
                                            "tool": "spawn_browser_agent",
                                            "goal": "Complete checkout",
                                            "tool_call_id": "lifecycle-call",
                                        },
                                        {
                                            "tool": "attempt_completion",
                                            "tool_call_id": "phase-marker-call",
                                        },
                                    ]
                                },
                            },
                            {
                                "id": "explore-started",
                                "agentId": root,
                                "role": "TOOL",
                                "text": "Research started.",
                                "createdAt": "2026-07-20T00:00:00.500Z",
                                "metadata": {
                                    "toolName": "spawn_agent",
                                    "agentType": "explore",
                                    "toolCallId": "explore-call",
                                    "toolStatus": "FINISHED",
                                    "title": "Market research",
                                },
                            },
                            {
                                "id": "explore-thinking",
                                "agentId": root,
                                "role": "TOOL",
                                "text": "",
                                "createdAt": "2026-07-20T00:00:00.750Z",
                                "metadata": {
                                    "toolName": "spawn_agent",
                                    "agentType": "explore",
                                    "subAgentId": "child-explore",
                                    "toolCallId": "explore-thinking-call",
                                    "toolStatus": "FINISHED",
                                    "title": "Explore agent thinking",
                                },
                            },
                            {
                                "id": "explore-finished",
                                "agentId": root,
                                "role": "TOOL",
                                "text": "Grounded terminal explore result from Message.text",
                                "createdAt": "2026-07-20T00:00:01Z",
                                "metadata": {
                                    "toolName": "spawn_agent",
                                    "agentType": "explore",
                                    "toolCallId": "explore-call",
                                    "toolStatus": "FINISHED",
                                    "title": "Market research complete",
                                },
                            },
                            {
                                "id": "for-each-finished",
                                "agentId": root,
                                "role": "TOOL",
                                "text": "Real general-purpose batch result",
                                "createdAt": "2026-07-20T00:00:01.500Z",
                                "metadata": {
                                    "toolName": "spawn_agent",
                                    "agentType": "for_each",
                                    "toolCallId": "for-each-call",
                                    "toolStatus": "FINISHED",
                                    "title": "Batch complete",
                                },
                            },
                            {
                                "id": "dag-explore-started",
                                "agentId": root,
                                "role": "TOOL",
                                "text": "Investigate the supplier",
                                "createdAt": "2026-07-20T00:00:01.600Z",
                                "metadata": {
                                    "toolName": "spawn_agent",
                                    "agentType": "explore",
                                    "toolCallId": "dag-explore-call",
                                    "toolStatus": "IN_PROGRESS",
                                    "fullGoal": "Investigate the supplier",
                                    "dagTaskIndex": 2,
                                },
                            },
                            {
                                "id": "dag-explore-finished",
                                "agentId": root,
                                "role": "TOOL",
                                "text": "Supplier has a verified public catalog",
                                "createdAt": "2026-07-20T00:00:01.700Z",
                                "metadata": {
                                    "toolName": "spawn_agent",
                                    "agentType": "explore",
                                    "toolCallId": "dag-explore-call",
                                    "toolStatus": "FINISHED",
                                },
                            },
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
                                "id": "lifecycle-started",
                                "agentId": root,
                                "role": "TOOL",
                                "text": "Browser agent started",
                                "createdAt": "2026-07-20T00:00:05.500Z",
                                "metadata": {
                                    "toolName": "spawn_browser_agent",
                                    "toolCallId": "lifecycle-call",
                                    "toolStatus": "FINISHED",
                                    "title": "Browser agent",
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
                            {
                                "id": "excluded-lifecycle",
                                "agentId": root,
                                "role": "TOOL",
                                "text": "Browser session closed",
                                "createdAt": "2026-07-20T00:00:07Z",
                                "metadata": {
                                    "toolName": "spawn_browser_agent",
                                    "toolCallId": "lifecycle-call",
                                    "toolStatus": "FINISHED",
                                    "action_type": "task_complete",
                                    "excludeFromModel": True,
                                },
                            },
                            {
                                "id": "agent-init",
                                "agentId": root,
                                "role": "TOOL",
                                "text": "Agent initialization complete.",
                                "createdAt": "2026-07-20T00:00:08Z",
                                "metadata": {
                                    "toolName": "agent_init",
                                    "toolCallId": "tc-agent-init",
                                    "toolStatus": "FINISHED",
                                    "title": "Initialized",
                                },
                            },
                            {
                                "id": "completion-summary",
                                "agentId": root,
                                "role": "TOOL",
                                "text": "Task Complete",
                                "createdAt": "2026-07-20T00:00:09Z",
                                "metadata": {
                                    "toolName": "completion_summary",
                                    "toolCallId": "summary-call",
                                    "toolStatus": "FINISHED",
                                    "title": "Task Complete",
                                },
                            },
                            {
                                "id": "unpaired-phase-marker",
                                "agentId": root,
                                "role": "TOOL",
                                "text": "",
                                "createdAt": "2026-07-20T00:00:10Z",
                                "metadata": {
                                    "toolName": "attempt_completion",
                                    "toolCallId": "phase-marker-call",
                                    "toolStatus": "FINISHED",
                                    "title": "Beginning Execute Phase",
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
            assert len(grounded) == 6
            # The build corpus learns every grounded tool result even though
            # runtime simulation deliberately leaves general-purpose work real.
            for_each = next(step for step in grounded if step.action.name == "spawn_general_purpose_agent_for_each")
            assert for_each.action.arguments == {
                "type": "for_each",
                "goal": "Contact each investor",
                "items": [{"name": "A"}],
            }
            assert for_each.observation.content == "Real general-purpose batch result"
            specialized = next(step for step in grounded if step.action.name == "spawn_explore_agent")
            assert specialized.action.arguments == {
                "type": "explore",
                "goal": "Research the market",
                "depth": "quick",
            }
            assert specialized.observation.content == "Grounded terminal explore result from Message.text"
            dag_specialized = next(
                step
                for step in grounded
                if step.action.name == "spawn_explore_agent" and step.action.tool_call_id == "dag-explore-call"
            )
            assert dag_specialized.action.arguments == {
                "type": "explore",
                "goal": "Investigate the supplier",
            }
            assert dag_specialized.observation.content == "Supplier has a verified public catalog"
            rich = next(step for step in grounded if step.observation.metadata["source"] == "browser_observation")
            legacy = next(
                step
                for step in grounded
                if step.observation.metadata["source"] == "message_fixture" and step.action.name == "browser_action"
            )
            browser_terminal = next(
                step
                for step in grounded
                if step.observation.metadata["source"] == "message_fixture"
                and step.action.name == "spawn_browser_agent"
            )
            assert rich.action.arguments["action"] == "click"
            assert rich.action.arguments["params"]["index"] == 42
            assert "Thank you, your order has been placed" in rich.observation.content
            assert legacy.action.arguments["action"] == "goto"
            assert legacy.action.arguments["params"]["url"] == "https://amazon.com"
            assert browser_terminal.observation.content == "Task complete"
            grounded_content = json.dumps([step.observation.content for step in grounded])
            assert "synthetic result" not in grounded_content
            assert "Research started" not in grounded_content
            assert "Browser agent started" not in grounded_content
            assert "Explore agent thinking" not in grounded_content
            assert "Agent initialization complete" not in grounded_content
            assert "Browser session closed" not in grounded_content
            assert "Beginning Execute Phase" not in grounded_content

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


def test_grounded_export_and_conformance_suite_cover_100_real_terminal_tool_results():
    """Every terminal tool shape is corpus data; the runtime allowlist is separate."""
    from benchmarks.world_model_harness import (
        export_archive_to_otel_jsonl,
        is_world_model_environment_boundary,
        load_grounded_transitions,
        write_world_model_conformance_suite,
    )
    from helpers.trace_archive import archive_json

    tool_names = [
        "set_plan",
        "attempt_completion",
        "spawn_general_purpose_agent",
        "spawn_general_purpose_agent_for_each",
        "spawn_explore_agent",
        "spawn_browser_agent",
        "spawn_code_agent",
        "message_person",
        "request_payment_card",
        "call_phone_number",
        "grep",
        "fast_cache_write",
        "custom_provider_tool",
    ]
    with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as out:
        restore = _with_archive_env(tmp)
        try:
            root = "root-100-real-tool-results"
            start_fixture = {
                "root_agent_id": root,
                "user_id": "user",
                "agent_ids": [root],
                "rows": {"Agent": [{"id": root, "goal": "Exercise real tools"}]},
            }
            messages = []
            for index in range(100):
                call_id = f"call-{index:03d}"
                tool_name = tool_names[index % len(tool_names)]
                messages.extend(
                    [
                        {
                            "id": f"assistant-{index:03d}",
                            "agentId": root,
                            "role": "ASSISTANT",
                            "createdAt": f"2026-07-20T00:{index // 60:02d}:{index % 60:02d}.000Z",
                            "metadata": {
                                "tool_calls": [
                                    {
                                        "tool": tool_name,
                                        "tool_call_id": call_id,
                                        "arguments": {"example": index},
                                    }
                                ]
                            },
                        },
                        {
                            "id": f"tool-{index:03d}",
                            "agentId": root,
                            "role": "TOOL",
                            "text": f"grounded result {index}",
                            "createdAt": f"2026-07-20T01:{index // 60:02d}:{index % 60:02d}.000Z",
                            "metadata": {
                                "toolName": tool_name,
                                "toolCallId": call_id,
                                "toolStatus": "ERROR" if index % 17 == 0 else "FINISHED",
                                "title": f"Terminal {tool_name} result",
                            },
                        },
                    ]
                )
            archive_json(
                root_agent_id=root,
                path="db/start.fixture.json.gz.enc",
                payload=start_fixture,
            )
            archive_json(
                root_agent_id=root,
                path="db/end.fixture.json.gz.enc",
                payload={**start_fixture, "rows": {**start_fixture["rows"], "Message": messages}},
            )
            archive_json(
                root_agent_id=root,
                path="manifest.json.gz.enc",
                payload={
                    "root_agent_id": root,
                    "world_model_mode": "real",
                    "run": {"root_goal": "Exercise real tools", "agent_ids": [root]},
                },
            )
            # An explicit provider transition must not cause the other 99 DB
            # tool results to disappear, and its Message projection is deduped.
            archive_json(
                root_agent_id=root,
                path="trace/transitions.json.gz.enc",
                payload={
                    "transitions": [
                        {
                            "state_before": {},
                            "action": {
                                "category": "tool",
                                "name": "set_plan",
                                "arguments": {"example": 0},
                                "agent_id": root,
                                "tool_call_id": "call-000",
                                "timestamp_ms": 1784509200000,
                            },
                            "observation": {
                                "category": "tool_result",
                                "content": "grounded result 0",
                                "is_error": True,
                                "metadata": {"source": "provider", "result_unavailable": False},
                                "timestamp_ms": 1784509200001,
                            },
                        }
                    ]
                },
            )

            grounded = load_grounded_transitions(root)
            assert len(grounded) == 100
            assert {step.action.name for step in grounded} == set(tool_names)
            assert all(step.action.arguments == {"example": index} for index, step in enumerate(grounded))
            assert sum(step.observation.is_error for step in grounded) == 6
            assert not is_world_model_environment_boundary("spawn_general_purpose_agent")
            assert not is_world_model_environment_boundary("spawn_general_purpose_agent_for_each")

            trace_path = Path(out) / "traces.otel.jsonl"
            export_archive_to_otel_jsonl(root, trace_path)
            suite_path = Path(out) / "conformance.json"
            report = write_world_model_conformance_suite(
                trace_path,
                suite_path,
                example_count=100,
                min_trajectories=1,
            )
            assert report["status"] == "passed"
            assert report["requested_examples"] == 100
            assert report["sampled_examples"] == 100
            assert report["eligible_examples"] == 100
            assert report["trajectory_count"] == 1
            assert report["category_count"] >= 8
            assert report["tool_name_count"] == len(tool_names)
            assert report["sampled_category_count"] == report["category_count"]
            assert report["invalid_examples"] == []
            assert len(report["examples"]) == 100
            assert json.loads(suite_path.read_text(encoding="utf-8")) == report
        finally:
            restore()


def test_public_export_redacts_root_goal_and_scratchpad_secrets():
    """Public OTel already redacted arguments, observations and state, but wrote
    the root goal (gen_ai.prompt / trace metadata) and scratchpads verbatim; a
    real archived goal carried a Bearer JWT into the local corpus."""
    from benchmarks.world_model_harness import export_archive_to_otel_jsonl
    from helpers.trace_archive import archive_json

    bearer = "Bearer eyJhbGciOiJIUzI1NiJ9.e30.c2lnbmF0dXJl"
    api_key = "sk-ant-api03-" + "A" * 24
    with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as out:
        restore = _with_archive_env(tmp)
        try:
            root = "root-public-goal-redaction"
            fixture = {"root_agent_id": root, "user_id": "user", "agent_ids": [root], "rows": {"Agent": [{"id": root}]}}
            archive_json(root_agent_id=root, path="db/start.fixture.json.gz.enc", payload=fixture)
            archive_json(
                root_agent_id=root,
                path="manifest.json.gz.enc",
                payload={"root_agent_id": root, "world_model_mode": "real", "run": {"root_goal": f"Log in with {bearer}"}},
            )
            archive_json(
                root_agent_id=root,
                path="trace/transitions.json.gz.enc",
                payload={
                    "transitions": [
                        {
                            "state_before": {},
                            "scratchpad": f"remember {api_key}",
                            "action": {
                                "category": "tool",
                                "name": "web_search",
                                "arguments": {"query": "public"},
                                "agent_id": root,
                                "tool_call_id": "call-1",
                                "timestamp_ms": 1784509200000,
                            },
                            "observation": {
                                "category": "tool_result",
                                "content": "result",
                                "is_error": False,
                                "metadata": {"source": "provider"},
                                "timestamp_ms": 1784509200001,
                            },
                        }
                    ]
                },
            )
            text = export_archive_to_otel_jsonl(root, Path(out) / "trace.otel.jsonl").read_text(encoding="utf-8")
            assert "eyJhbGciOiJIUzI1NiJ9" not in text and api_key not in text
            assert "Log in with [REDACTED]" in text and "remember [REDACTED]" in text
        finally:
            restore()


def _raw_conformance_otel(path, examples, *, task="Exercise exact conformance"):
    """Write canonical action/observation span pairs exactly as export lays them out."""
    from benchmarks.world_model_harness import _otel_attr

    lines = []
    for index, (root, action, observation) in enumerate(examples):
        trace_id, span_id = f"{index:032x}", f"{index:016x}"
        lines.append({
            "traceId": trace_id,
            "spanId": span_id,
            "name": f"chat {action['name']}",
            "attributes": [
                _otel_attr("gen_ai.tool.call.arguments", action),
                _otel_attr("gen_ai.prompt", task),
                _otel_attr("rose.root_agent_id", root),
            ],
        })
        lines.append({
            "traceId": trace_id,
            "spanId": f"{index + 1000:016x}",
            "parentSpanId": span_id,
            "name": f"execute_tool {action['name']}",
            "attributes": [
                _otel_attr("gen_ai.tool.output", observation),
                _otel_attr("rose.root_agent_id", root),
            ],
        })
    path.write_text("".join(json.dumps(line) + "\n" for line in lines), encoding="utf-8")


def _conformance_pair(index, *, arguments=None, content="observed page", refs=()):
    action = {
        "schema": "rose.canonical_action.v1",
        "category": "browser",
        "name": f"browser_action_{index}",
        "arguments": arguments if arguments is not None else {"step": index},
        "artifact_refs": list(refs),
    }
    observation = {
        "schema": "rose.canonical_observation.v1",
        "category": "browser",
        "content": content,
        "metadata": {"source": "browser"},
        "artifact_refs": list(refs),
    }
    return f"root-{index}", action, observation


def test_conformance_suite_examples_stay_exact_public_corpus_records():
    """Native binding hashes suite examples against the corpus. A second broad
    value redaction rewrote non-secret artifact paths (>=32 base64-like chars)
    into [REDACTED], so the real case had no matching native record."""
    from benchmarks.world_model_harness import _iter_canonical_otel_examples, write_world_model_conformance_suite

    long_path = "media/browser/b54ab168-4963-5f2e-bc08-0b2711f62737/observations/iteration_0010.json"
    pairs = [
        _conformance_pair(0, refs=[long_path]),
        _conformance_pair(1, arguments={"password": "[REDACTED]", "step": 1}),
        _conformance_pair(2),
    ]
    with tempfile.TemporaryDirectory() as tmp:
        trace = Path(tmp) / "traces.otel.jsonl"
        _raw_conformance_otel(trace, pairs, task="Use Bearer eyJhbGciOiJIUzI1NiJ9.e30.signature to log in")
        corpus = {example["fingerprint"]: example for example, _ in _iter_canonical_otel_examples(trace)}
        report = write_world_model_conformance_suite(
            trace, Path(tmp) / "conformance.json", example_count=3, min_trajectories=1, min_categories=1, min_tool_names=1
        )
        assert report["status"] == "passed"
        for example in report["examples"]:
            source = corpus[example["fingerprint"]]
            assert example["action"] == source["action"] and example["observation"] == source["observation"]
        assert any(long_path in example["action"]["artifact_refs"] for example in report["examples"])
        # Non-binding request context keeps the public redaction.
        assert all("eyJ" not in example["task"] and "[REDACTED]" in example["task"] for example in report["examples"])


def test_conformance_suite_fails_closed_on_unredacted_secrets():
    from benchmarks.world_model_harness import write_world_model_conformance_suite

    for pair in (
        _conformance_pair(0, content="key sk-ant-api03-AAAAAAAAAAAAAAAAAAAA"),
        _conformance_pair(0, arguments={"password": "hunter2"}),
    ):
        with tempfile.TemporaryDirectory() as tmp:
            trace = Path(tmp) / "traces.otel.jsonl"
            _raw_conformance_otel(trace, [pair])
            try:
                write_world_model_conformance_suite(
                    trace, Path(tmp) / "conformance.json", example_count=1, min_trajectories=1, min_categories=1, min_tool_names=1
                )
            except ValueError as exc:
                assert "secret" in str(exc)
            else:
                raise AssertionError("conformance suite admitted an unredacted secret")
            assert not (Path(tmp) / "conformance.json").exists()


async def test_prediction_conformance_replays_expected_observations_and_fails_on_low_fidelity():
    from benchmarks.world_model_harness import evaluate_world_model_conformance_suite

    examples = []
    for index in range(3):
        examples.append(
            {
                "fingerprint": f"fingerprint-{index}",
                "root_agent_id": f"root-{index}",
                "tool_name": "custom_tool",
                "category": "tool",
                "task": "Exercise prediction fidelity",
                "state_before": {"root_agent_id": f"root-{index}", "step": index},
                "scratchpad": "",
                "action": {
                    "schema": "rose.canonical_action.v1",
                    "category": "tool",
                    "name": "custom_tool",
                    "arguments": {"example": index},
                },
                "observation": {
                    "schema": "rose.canonical_observation.v1",
                    "category": "tool_result",
                    "content": f"grounded result {index}",
                    "is_error": index == 2,
                    "metadata": {"result_unavailable": False},
                },
            }
        )

    class PerfectClient:
        async def start_session(self, _model, *, task, seed_state):
            assert task == "Exercise prediction fidelity"
            return str(seed_state["structured"]["step"])

        async def step(self, _model, session_id, _action):
            index = int(session_id)
            return {"content": f"grounded result {index}", "is_error": index == 2, "metadata": {}}

    class WrongClient(PerfectClient):
        async def step(self, _model, session_id, _action):
            return {"content": "unrelated prediction", "is_error": False, "metadata": {}}

    with tempfile.TemporaryDirectory() as tmp:
        suite_path = Path(tmp) / "conformance.json"
        output_path = Path(tmp) / "prediction.json"
        suite_path.write_text(
            json.dumps(
                {
                    "schema": "rose.wmh_conformance_suite.v1",
                    "status": "passed",
                    "requested_examples": 3,
                    "examples": examples,
                }
            ),
            encoding="utf-8",
        )
        passed = await evaluate_world_model_conformance_suite(
            suite_path,
            world_model_name="rose-test",
            output_path=output_path,
            client=PerfectClient(),
        )
        assert passed["status"] == "passed"
        assert passed["mean_score"] == 1.0
        assert passed["dimensions"]["content_accuracy"] == 1.0
        assert json.loads(output_path.read_text(encoding="utf-8")) == passed

        failed = await evaluate_world_model_conformance_suite(
            suite_path,
            world_model_name="rose-test",
            client=WrongClient(),
        )
        assert failed["status"] == "failed"
        assert failed["dimensions"]["content_accuracy"] == 0.0

        # Exercise native execution qualification through the actual evaluator,
        # preserving the legacy/default case and all original scoring assertions.
        from benchmarks.wmh_execution_policy import bind_execution_suite, execution_identity

        class NativeClient(PerfectClient):
            predictions = 0

            def __init__(self, descriptor):
                self.descriptor = descriptor

            async def model_identity(self, name):
                return {
                    "world_model_id": "artifact-a",
                    "world_model_manifest_sha256": "a" * 64,
                    "execution_identity": self.descriptor,
                }

            async def start_session(self, *args, **kwargs):
                self.predictions += 1
                return await super().start_session(*args, **kwargs)

        native_suite = {
            **json.loads(suite_path.read_text()),
            "native_world_model_id": "artifact-a",
            "native_world_model_manifest_sha256": "a" * 64,
        }
        native_path = Path(tmp) / "native.base.json"
        native_path.write_text(json.dumps(native_suite))
        upstream = execution_identity("upstream", "artifact-a", "a" * 64)
        candidate = execution_identity("rose-virtual-public-affordances-v1", "artifact-a", "a" * 64)
        base_client = NativeClient(upstream)
        baseline = await evaluate_world_model_conformance_suite(
            native_path, world_model_name="rose-test", client=base_client
        )
        assert baseline["status"] == "passed" and base_client.predictions == 3
        assert baseline["native_execution_identity"] == upstream
        bound_path = Path(tmp) / "native.candidate.json"
        native_bytes = native_path.read_bytes()
        bound = bind_execution_suite(native_path, bound_path, "rose-virtual-public-affordances-v1")
        assert native_path.read_bytes() == native_bytes and bound["examples"] == native_suite["examples"]
        candidate_client = NativeClient(candidate)
        candidate_report = await evaluate_world_model_conformance_suite(
            bound_path,
            world_model_name="rose-test",
            client=candidate_client,
            execution_policy="rose-virtual-public-affordances-v1",
        )
        assert candidate_report["status"] == "passed" and candidate_client.predictions == 3
        assert candidate_report["native_execution_identity"] == candidate
        for case_suite, served_descriptor, expected_policy in (
            (native_path, candidate, "rose-virtual-public-affordances-v1"),
            (bound_path, upstream, "rose-virtual-public-affordances-v1"),
            (bound_path, None, "rose-virtual-public-affordances-v1"),
            (bound_path, {**candidate, "effective_system_sha256": "b" * 64}, "rose-virtual-public-affordances-v1"),
            (bound_path, candidate, "upstream"),
        ):
            reject_client = NativeClient(served_descriptor)
            try:
                await evaluate_world_model_conformance_suite(
                    case_suite, world_model_name="rose-test", client=reject_client, execution_policy=expected_policy
                )
            except ValueError:
                pass
            else:
                raise AssertionError("Missing/wrong execution expectation qualified a native prediction")
            assert reject_client.predictions == 0
        malformed_path = Path(tmp) / "native.wrong-policy.json"
        malformed_path.write_text(json.dumps({**bound, "native_execution_identity": upstream}))
        reject_client = NativeClient(candidate)
        try:
            await evaluate_world_model_conformance_suite(
                malformed_path,
                world_model_name="rose-test",
                client=reject_client,
                execution_policy="rose-virtual-public-affordances-v1",
            )
        except ValueError:
            pass
        else:
            raise AssertionError("Wrong bound policy qualified a native prediction")
        assert reject_client.predictions == 0


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
    import wmh.ingest.otel_genai as otel_genai
    from wmh.ingest.otel_genai import OtelGenAIAdapter
    from wmh.retrieval import HashingEmbedder

    from benchmarks.world_model_harness import export_archive_to_otel_jsonl, refresh_world_model_index

    with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as out:
        restore = _with_archive_env(tmp)
        old_batch_size = os.environ.get("WMH_INDEX_BATCH_SIZE")
        try:
            _write_golden_bundle("root-index-streaming")
            trace_file = Path(out) / "traces.otel.jsonl"
            export_archive_to_otel_jsonl("root-index-streaming", trace_file, redaction_mode="public")

            os.environ["WMH_INDEX_BATCH_SIZE"] = "1"
            os.environ["WMH_EMBED_WORKERS"] = "1"  # in-process so the patched embedder is observed
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
            os.environ.pop("WMH_EMBED_WORKERS", None)
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
            # Rows stay in the archive: the state carries their reference, never the ~MBs of rows.
            assert "rows" not in state["db_fixture"]
            assert state["db_fixture"]["rows_ref"]["path"] == "db/start.fixture.json.gz.enc"
            assert state["db_fixture"]["rows_ref"]["plaintext_sha256"] == state["db_fixture_ref"]["plaintext_sha256"]
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
            assert first["total_steps"] == 4
            assert first["updated_traces"] == 2
            assert first["build_ran"] is True
            assert first["index_refreshed"] is False
            assert calls["builds"] == 1
            assert calls["index_refreshes"] == 0
            assert [event["title"] for event in progress_events] == [
                "World Model Updating",
                "World Model Corpus Screening",
                "World Model RAG Populating",
                "World Model Trace Export",
                "World Model Corpus Conformance",
                "World Model Build",
                "World Model Ready",
            ]
            assert first["conformance"]["status"] == "failed"
            assert first["conformance"]["eligible_examples"] == 4
            assert progress_events[-1]["status"] == "FINISHED"
            assert progress_events[-1]["metadata"]["total_steps"] == 4
            assert "metadata" in progress_events[-1]
            assert "text" not in progress_events[-1]

            try:
                update_world_model_for_simulation(
                    output_dir=out,
                    root_agent_ids=["root-delta-a", "root-delta-b"],
                    name="rose-delta",
                    gepa_budget=0,
                    conformance_examples=100,
                    require_conformance=True,
                    upstream_build=fake_upstream_build,
                    config_factory=fake_config_factory,
                    index_refresher=fake_index_refresher,
                )
            except RuntimeError as exc:
                assert "requested=100, eligible=4" in str(exc)
            else:
                raise AssertionError("required conformance must fail closed on fewer than 100 examples")

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
        read_archive_json,
        update_world_model_for_simulation,
    )

    with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as out:
        restore = _with_archive_env(tmp)
        try:
            _write_golden_bundle("root-real")
            _write_golden_bundle("root-shadow", world_model_mode="shadow")
            _write_golden_bundle("root-simulated", world_model_mode="simulate")
            _write_golden_bundle("root-stale-manifest", world_model_mode="real")

            # Historical manifests can disagree with the launch snapshot. The
            # conservative preliminary gate must honor the explicit simulated
            # mode before any transitions reach embedding.
            from helpers.trace_archive import archive_json

            stale_start = read_archive_json("root-stale-manifest", "db/start.fixture.json.gz.enc")
            stale_start["rows"]["Agent"][0]["worldModelMode"] = "simulate"
            archive_json(
                root_agent_id="root-stale-manifest",
                path="db/start.fixture.json.gz.enc",
                payload=stale_start,
            )

            real, excluded = partition_real_world_bundles(
                ["root-real", "root-shadow", "root-simulated", "root-stale-manifest"]
            )
            assert real == ["root-real", "root-shadow"]
            assert excluded == {
                "root-simulated": "simulate",
                "root-stale-manifest": "simulate",
            }

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
                root_agent_ids=["root-real", "root-shadow", "root-simulated", "root-stale-manifest"],
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

            assert result["excluded_reasons"]["simulated-run"] == 2
            export_event = [event for event in progress_events if event["title"] == "World Model Trace Export"][-1]
            assert export_event["metadata"]["filtered_before_export"] == 1
        finally:
            restore()


def test_corpus_screening_admits_only_exportable_bundles_and_caches_verdicts():
    """The corpus takes bundles the exporter can turn into steps; verdicts persist across refreshes.

    Sampled 2026-09-08: ~94% of the ~80k R2 bundles are STARTING_UP shells from
    test stacks. Terminal status and an end fixture are NOT required: a run
    killed mid-flight still contributes every completed observation already
    present in its incremental provider/browser/trace artifacts.
    """
    import benchmarks.world_model_harness as wmh
    from benchmarks.world_model_harness import (
        bundle_corpus_eligibility,
        select_corpus_bundles,
        update_world_model_for_simulation,
    )

    with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as out:
        restore = _with_archive_env(tmp)
        try:
            _write_golden_bundle("root-gold")
            _write_golden_bundle("root-shell")  # will lose everything but manifest + start fixture
            _write_golden_bundle("root-partial")  # will lose only its end fixture
            _write_golden_bundle("root-missing-start")
            _write_golden_bundle("root-active")  # non-terminal root status: still exportable
            _write_golden_bundle("root-legacy")  # legacy migrated marker
            _write_golden_bundle("root-benchmark-generated")  # real non-DEMO benchmark result
            _write_golden_bundle("root-demo")  # catalog-tagged DEMO task: never a real-world result
            _write_golden_bundle("root-noproviders")  # fixtures only; may contain sub-agent terminal rows
            _write_golden_bundle("root-sim", world_model_mode="simulate")

            shell = Path(tmp) / "root-shell"
            for item in list(shell.rglob("*")):
                if item.is_file() and not (
                    item.name.startswith("manifest.json.gz.enc") or item.name.startswith("start.fixture.json.gz.enc")
                ):
                    item.unlink()
            partial = Path(tmp) / "root-partial"
            for item in list(partial.rglob("*")):
                if item.is_file() and item.name.startswith("end.fixture.json.gz.enc"):
                    item.unlink()
            missing_start = Path(tmp) / "root-missing-start"
            for item in list(missing_start.rglob("*")):
                if item.is_file() and item.name.startswith("start.fixture.json.gz.enc"):
                    item.unlink()
            noproviders = Path(tmp) / "root-noproviders"
            for item in list(noproviders.rglob("*")):
                rel = item.relative_to(noproviders).as_posix()
                if item.is_file() and rel.startswith(
                    ("provider/", "media/", "browser/", "otel/", "transitions/", "wmh/")
                ):
                    item.unlink()

            def rewrite_manifest(root_agent_id: str, **fields) -> None:
                from helpers.trace_archive import archive_json

                manifest = wmh.read_archive_json(root_agent_id, "manifest.json.gz.enc")
                for key, value in fields.items():
                    if key == "root_status":
                        manifest["run"]["root_status"] = value
                    else:
                        manifest[key] = value
                archive_json(root_agent_id=root_agent_id, path="manifest.json.gz.enc", payload=manifest)

            rewrite_manifest("root-active", root_status="ACTIVE")
            rewrite_manifest("root-legacy", legacy_migrated=True)
            rewrite_manifest("root-benchmark-generated", source_kind="benchmark-task")
            rewrite_manifest("root-demo", benchmark_task_name="test-mass-agent-run-0")

            assert bundle_corpus_eligibility("root-gold") == (True, "eligible")
            assert bundle_corpus_eligibility("root-shell") == (False, "no-result-artifacts")
            assert bundle_corpus_eligibility("root-partial") == (True, "eligible")
            assert bundle_corpus_eligibility("root-missing-start")[1].startswith("missing:")
            assert bundle_corpus_eligibility("root-active") == (True, "eligible")
            assert bundle_corpus_eligibility("root-legacy") == (False, "legacy-migrated")
            assert bundle_corpus_eligibility("root-benchmark-generated") == (True, "eligible")
            assert bundle_corpus_eligibility("root-demo") == (
                False,
                "demo-task:test-mass-agent-run-0",
            )
            assert bundle_corpus_eligibility("root-noproviders") == (True, "eligible")
            assert bundle_corpus_eligibility("root-sim") == (False, "simulated-run:simulate")

            class FakeMetrics:
                def model_dump(self):
                    return {"held_out_accuracy": 0.5}

            class FakeResult:
                metrics = FakeMetrics()

            def fake_upstream_build(config, **kwargs):
                Path(kwargs["root"]).mkdir(parents=True, exist_ok=True)
                return FakeResult()

            roots = [
                "root-active",
                "root-demo",
                "root-gold",
                "root-legacy",
                "root-missing-start",
                "root-noproviders",
                "root-partial",
                "root-shell",
                "root-sim",
            ]
            first = update_world_model_for_simulation(
                output_dir=out,
                root_agent_ids=roots,
                name="rose-gold-only",
                gepa_budget=0,
                upstream_build=fake_upstream_build,
                config_factory=lambda **kwargs: {"config": kwargs},
            )
            assert first["total_traces"] == 4
            assert first["excluded_bundles"] == 5
            assert first["excluded_reasons"] == {
                "demo-task": 1,
                "legacy-migrated": 1,
                "missing": 1,
                "no-result-artifacts": 1,
                "simulated-run": 1,
            }
            assert first["screening_cache_hits"] == 0
            index = json.loads((Path(out) / "delta-index.json").read_text(encoding="utf-8"))
            assert set(index["bundles"]) == {
                "root-active",
                "root-gold",
                "root-noproviders",
                "root-partial",
            }
            assert index["bundles"]["root-partial"]["steps"] == 2
            assert index["screening"]["root-gold"]["eligible"] is True
            assert index["screening"]["root-active"]["eligible"] is True
            assert index["screening"]["root-demo"]["eligible"] is False
            assert index["screening"]["root-demo"]["reason"] == "demo-task:test-mass-agent-run-0"
            # Two spans per transition; the index records steps (transitions) for the caps.
            gold_otel = (Path(out) / "otel" / "root-gold.otel.jsonl").read_text(encoding="utf-8")
            assert sum(1 for line in gold_otel.splitlines() if line.strip()) == 4
            assert index["bundles"]["root-gold"]["steps"] == 2

            # Final verdicts replay from the cache; a bundle missing launch
            # metadata is re-checked only after its recheck window.
            calls: list[str] = []
            original = wmh.bundle_corpus_eligibility

            def counting(root_agent_id: str):
                calls.append(root_agent_id)
                return original(root_agent_id)

            wmh.bundle_corpus_eligibility = counting
            try:
                second = update_world_model_for_simulation(
                    output_dir=out,
                    root_agent_ids=roots,
                    name="rose-gold-only",
                    gepa_budget=0,
                    upstream_build=fake_upstream_build,
                    config_factory=lambda **kwargs: {"config": kwargs},
                )
            finally:
                wmh.bundle_corpus_eligibility = original
            assert second["total_traces"] == 4
            assert second["screening_cache_hits"] == 9, second["screening_cache_hits"]
            assert calls == []

            # A changed screening criterion invalidates every cached verdict: the
            # old "gold" policy had rejected non-terminal runs for a day at a time.
            index = json.loads((Path(out) / "delta-index.json").read_text(encoding="utf-8"))
            assert index["screening_policy"] == wmh._SCREENING_POLICY_VERSION
            index["screening_policy"] = "gold-v1"
            (Path(out) / "delta-index.json").write_text(json.dumps(index), encoding="utf-8")
            third = update_world_model_for_simulation(
                output_dir=out,
                root_agent_ids=roots,
                name="rose-gold-only",
                gepa_budget=0,
                upstream_build=fake_upstream_build,
                config_factory=lambda **kwargs: {"config": kwargs},
            )
            assert third["screening_cache_hits"] == 0
            assert third["total_traces"] == 4

            # One bundle export reads each fixture once: the memo serves the repeats.
            reads: list[str] = []
            original_read = wmh.read_archive_artifact

            def counting_read(*, root_agent_id: str, path: str):
                reads.append(f"{root_agent_id}/{path}")
                return original_read(root_agent_id=root_agent_id, path=path)

            wmh.read_archive_artifact = counting_read
            try:
                with wmh.archive_json_memo():
                    wmh.export_archive_to_otel_jsonl("root-gold", Path(out) / "memo.otel.jsonl")
                    wmh._build_replay_session("root-gold", "train")
            finally:
                wmh.read_archive_artifact = original_read
            fixture_reads = [r for r in reads if r.endswith(".fixture.json.gz.enc")]
            assert fixture_reads.count("root-gold/db/start.fixture.json.gz.enc") == 1, fixture_reads
            assert len(fixture_reads) == len(set(fixture_reads)), fixture_reads

            # A capped selection screens in cap-sized batches and still finds an exportable one.
            cache: dict = {}
            selected, excluded, _ = select_corpus_bundles(
                ["root-missing-start", "root-gold", "root-active"],
                {},
                max_bundles=1,
                cache=cache,
                now_ms=0,
                policy="gold",
            )
            assert selected == ["root-gold"]
            assert set(excluded) == {"root-missing-start"}
            assert "root-active" not in cache  # never screened: cap already satisfied

            # The legacy loose policy may bypass artifact/legacy checks, but it
            # must not bypass the real-results-only DEMO exclusion.
            selected, excluded, _ = select_corpus_bundles(
                ["root-demo", "root-gold"], {}, max_bundles=0, cache={}, now_ms=0, policy="any-real"
            )
            assert selected == ["root-gold"]
            assert excluded == {"root-demo": "demo-task:test-mass-agent-run-0"}
        finally:
            restore()


def test_corpus_screening_retries_transient_r2_throttles():
    import benchmarks.world_model_harness as wmh

    throttle = RuntimeError("Reduce your concurrent request rate for the same object")
    throttle.response = {
        "Error": {"Code": "ServiceUnavailable"},
        "ResponseMetadata": {"HTTPStatusCode": 503},
    }
    paths = [
        "manifest.json.gz.enc",
        "db/start.fixture.json.gz.enc",
        "trace/transitions.json.gz.enc",
    ]
    with (
        patch.object(wmh, "archive_artifact_paths", side_effect=[throttle, paths]) as listing,
        patch.object(wmh.time, "sleep") as sleep,
    ):
        assert wmh.prescreen_bundle_artifacts("root-throttled") == (True, "artifacts-present")
    assert listing.call_count == 2
    sleep.assert_called_once()


def test_bundle_signature_retries_transient_r2_throttles():
    import benchmarks.world_model_harness as wmh

    throttle = RuntimeError("Reduce your concurrent request rate for the same object")
    throttle.response = {
        "Error": {"Code": "ServiceUnavailable"},
        "ResponseMetadata": {"HTTPStatusCode": 503},
    }
    entries = [
        {"path": "manifest.json.gz.enc", "etag": "manifest", "size": 10},
        {"path": "manifest.json.gz.enc.meta.json", "etag": "metadata", "size": 20},
    ]
    with (
        patch.object(wmh, "archive_backend_is_r2", return_value=True),
        patch.object(wmh, "list_r2_artifact_entries", side_effect=[throttle, entries]) as listing,
        patch.object(wmh.time, "sleep") as sleep,
    ):
        signature = wmh._bundle_signature("root-throttled")
    assert signature["artifact_count"] == 1
    assert listing.call_count == 2
    sleep.assert_called_once()


def test_export_worker_filters_bundles_without_completed_results():
    import benchmarks.world_model_harness as wmh

    with tempfile.TemporaryDirectory() as out:
        otel = Path(out) / "empty.otel.jsonl"
        session = Path(out) / "empty.session.json"
        otel.write_text("stale", encoding="utf-8")
        session.write_text("stale", encoding="utf-8")
        with (
            patch.object(wmh, "_prefetch_bundle_fixtures"),
            patch.object(wmh, "bundle_world_model_mode", return_value="real"),
            patch.object(wmh, "load_grounded_transitions", return_value=[]),
        ):
            result = wmh._export_bundle_worker(("root-empty", str(otel), str(session), "train", 0))
        assert result == ("root-empty", 0, "filtered:no-completed-results")
        assert not otel.exists()
        assert not session.exists()


def test_export_worker_retries_transient_r2_stream_failures():
    import benchmarks.world_model_harness as wmh

    stream_failure = RuntimeError("ResponseStreamingError: IncompleteRead(1048576 bytes read, 2097152 more expected)")

    with tempfile.TemporaryDirectory() as out:
        otel = Path(out) / "retry.otel.jsonl"
        session = Path(out) / "retry.session.json"

        def fake_export(_root_agent_id, output_path, **_kwargs):
            Path(output_path).write_text(
                json.dumps({"name": "execute_tool browser", "attributes": {}}) + "\n",
                encoding="utf-8",
            )

        with (
            patch.object(
                wmh,
                "_prefetch_bundle_fixtures",
                side_effect=[stream_failure, None],
            ) as prefetch,
            patch.object(wmh, "bundle_world_model_mode", return_value="real"),
            patch.object(wmh, "load_grounded_transitions", return_value=[object()]),
            patch.object(wmh, "export_archive_to_otel_jsonl", side_effect=fake_export),
            patch.object(wmh, "_build_replay_session", return_value={"transition_count": 1}),
            patch.object(wmh.time, "sleep") as sleep,
        ):
            result = wmh._export_bundle_worker(("root-stream-retry", str(otel), str(session), "train", 0))

        assert result == ("root-stream-retry", 1, None)
        assert prefetch.call_count == 2
        sleep.assert_called_once()
        assert otel.exists()
        assert json.loads(session.read_text(encoding="utf-8"))["transition_count"] == 1


def test_index_refresh_parallel_embeddings_match_in_process():
    """Forked embedding workers must reproduce the single-process index byte for byte.

    The hashing embedder is pure Python (~4.6 ms/step), so a 132k-step corpus
    spent 10 of its 11 index-refresh minutes embedding on one core.
    """
    import numpy as np

    from benchmarks.world_model_harness import export_archive_to_otel_jsonl, refresh_world_model_index

    with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as out:
        restore = _with_archive_env(tmp)
        try:
            for root in ("root-par-a", "root-par-b", "root-par-c"):
                _write_golden_bundle(root)
            trace_file = Path(out) / "traces.otel.jsonl"
            with trace_file.open("w", encoding="utf-8") as combined:
                for root in ("root-par-a", "root-par-b", "root-par-c"):
                    per_trace = Path(out) / f"{root}.otel.jsonl"
                    export_archive_to_otel_jsonl(root, per_trace, redaction_mode="public")
                    combined.write(per_trace.read_text(encoding="utf-8"))
            results = {}
            for workers in ("1", "3"):
                os.environ["WMH_EMBED_WORKERS"] = workers
                os.environ["WMH_INDEX_BATCH_SIZE"] = "2"
                model_root = Path(out) / "models" / f"rose-par-{workers}"
                results[workers] = refresh_world_model_index(trace_file, model_root, embed_dim=64)
            assert results["1"]["indexed_steps"] == results["3"]["indexed_steps"] == 6
            one = np.load(Path(out) / "models" / "rose-par-1" / "index" / "embeddings.npy")
            three = np.load(Path(out) / "models" / "rose-par-3" / "index" / "embeddings.npy")
            assert one.shape == three.shape == (6, 64)
            assert np.array_equal(one, three)
            assert (Path(out) / "models" / "rose-par-1" / "index" / "steps.jsonl").read_bytes() == (
                Path(out) / "models" / "rose-par-3" / "index" / "steps.jsonl"
            ).read_bytes()
        finally:
            os.environ.pop("WMH_EMBED_WORKERS", None)
            os.environ.pop("WMH_INDEX_BATCH_SIZE", None)
            restore()


def test_partial_run_recovers_completed_tool_results_from_llm_contexts(extra_messages=0):
    """Missing-end runs still export completed tool pairs captured by later LLM calls."""

    from benchmarks.world_model_harness import load_grounded_transitions
    from helpers.trace_archive import archive_json

    # Real archive writes can share a millisecond. Freeze that clock so the
    # corpus must preserve observed context order without wall-clock spacing.
    with tempfile.TemporaryDirectory() as tmp, patch("helpers.trace_archive.time.time", return_value=1700000000.0):
        restore = _with_archive_env(tmp)
        try:
            root = "root-partial-llm"
            _write_golden_bundle(root, world_model_mode="real")
            bundle = Path(tmp) / root
            for item in list(bundle.rglob("*")):
                if item.is_file() and (
                    item.name.startswith("end.fixture.json.gz.enc") or item.name.startswith("transitions.json.gz.enc")
                ):
                    item.unlink()

            first_pair = [
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call-search",
                            "type": "function",
                            "function": {"name": "web_search", "arguments": '{"q":"Rose Labs"}'},
                        }
                    ],
                },
                {
                    "role": "tool",
                    "name": "web_search",
                    "tool_call_id": "call-search",
                    "content": "real search result",
                },
            ]
            archive_json(
                root_agent_id=root,
                path="llm/partial-a.json.gz.enc",
                payload={
                    "agent_id": root,
                    "span_id": "span-a",
                    "call_site": "execute_loop",
                    "messages": first_pair,
                },
            )
            archive_json(
                root_agent_id=root,
                path="llm/partial-b.json.gz.enc",
                payload={
                    "agent_id": root,
                    "span_id": "span-b",
                    "call_site": "execute_loop",
                    "messages": [
                        *first_pair,  # cumulative duplicate must not produce another step
                        {
                            "role": "assistant",
                            "content": "",
                            "tool_calls": [
                                {
                                    "id": "call-explore",
                                    "name": "spawn_agent",
                                    "arguments": {"type": "explore", "prompt": "inspect evidence"},
                                },
                                {
                                    "id": "call-pending",
                                    "name": "web_fetch",
                                    "arguments": {"url": "https://pending.test"},
                                },
                            ],
                        },
                        {
                            "role": "tool",
                            "name": "spawn_agent",
                            "tool_call_id": "call-explore",
                            "content": "real explore result",
                        },
                        *[{"role": "user", "content": "unrelated later turn"}] * extra_messages,
                    ],
                },
            )

            transitions = load_grounded_transitions(root)
            assert [transition.action.name for transition in transitions] == [
                "web_search",
                "spawn_explore_agent",
            ]
            assert transitions[0].action.arguments == {"q": "Rose Labs"}
            assert transitions[1].action.arguments == {"type": "explore", "prompt": "inspect evidence"}
            assert [transition.observation.content for transition in transitions] == [
                "real search result",
                "real explore result",
            ]
            assert all(
                transition.observation.metadata["source"] == "llm_context_tool_result" for transition in transitions
            )
        finally:
            restore()


def test_partial_context_growth_preserves_observed_tool_result_order():
    test_partial_run_recovers_completed_tool_results_from_llm_contexts(extra_messages=10)


def test_index_records_survive_unicode_line_breaks_in_observations():
    """A U+2028 inside a scraped page must not split a JSONL record.

    The upstream retriever loads ``steps.jsonl`` with ``read_text().splitlines()``,
    which also breaks on U+2028/U+2029/U+0085. Four of the 132k steps in the
    2026-09-09 corpus carried a raw U+2028 and the rebuilt model refused to
    serve ("EOF while parsing a string"). Both JSONL writers escape them.
    """
    import dataclasses

    from wmh.retrieval import EmbeddingRetriever, HashingEmbedder

    from benchmarks.world_model_harness import (
        export_archive_to_otel_jsonl,
        load_grounded_transitions,
        refresh_world_model_index,
    )

    with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as out:
        restore = _with_archive_env(tmp)
        try:
            _write_golden_bundle("root-u2028")
            transitions = load_grounded_transitions("root-u2028", redaction_mode="public")
            assert transitions
            poisoned = "Trusted by\u2028everyone\u2029and\u0085more"
            transitions[0] = dataclasses.replace(
                transitions[0],
                observation=dataclasses.replace(transitions[0].observation, content=poisoned),
            )
            trace_file = Path(out) / "traces.otel.jsonl"
            export_archive_to_otel_jsonl("root-u2028", trace_file, redaction_mode="public", transitions=transitions)
            otel_text = trace_file.read_text(encoding="utf-8")
            assert len(otel_text.splitlines()) == otel_text.count("\n") == 2 * len(transitions)

            result = refresh_world_model_index(trace_file, Path(out) / "models" / "rose-u2028", embed_dim=64)
            assert result["indexed_steps"] == len(transitions)
            steps_text = (Path(out) / "models" / "rose-u2028" / "index" / "steps.jsonl").read_text(encoding="utf-8")
            assert len(steps_text.splitlines()) == steps_text.count("\n") == len(transitions)
            assert poisoned not in steps_text and json.loads(steps_text.splitlines()[0])

            retriever = EmbeddingRetriever(HashingEmbedder(dim=64))
            retriever.load(Path(out) / "models" / "rose-u2028" / "index")
            assert len(retriever._steps) == len(transitions)
            assert any(poisoned in step.model_dump_json() for step in retriever._steps)
        finally:
            restore()


def test_update_world_model_skips_bundles_that_fail_export():
    """One malformed bundle must not abort the whole corpus refresh.

    The R2 archive holds ~80k bundles of mixed provenance; a bundle with a
    corrupt transition artifact must not kill the build for every bench.
    """
    from benchmarks.world_model_harness import update_world_model_for_simulation

    with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as out:
        restore = _with_archive_env(tmp)
        try:
            _write_golden_bundle("root-ok")
            _write_golden_bundle("root-broken")
            # Screening intentionally validates only launch metadata and mode;
            # corrupt transition ciphertext fails later inside export.
            broken_trace = Path(tmp) / "root-broken" / "trace" / "transitions.json.gz.enc"
            broken_trace.write_bytes(b"not the archived ciphertext")

            progress_events: list[dict] = []

            class FakeMetrics:
                def model_dump(self):
                    return {"held_out_accuracy": 0.5}

            class FakeResult:
                metrics = FakeMetrics()

            def fake_upstream_build(config, **kwargs):
                Path(kwargs["root"]).mkdir(parents=True, exist_ok=True)
                return FakeResult()

            result = update_world_model_for_simulation(
                output_dir=out,
                root_agent_ids=["root-ok", "root-broken"],
                name="rose-skip-broken",
                gepa_budget=0,
                progress=progress_events.append,
                upstream_build=fake_upstream_build,
                config_factory=lambda **kwargs: {"config": kwargs},
            )
            assert result["status"] == "ready"
            assert result["total_traces"] == 1
            assert list(result["export_failed"]) == ["root-broken"]
            assert result["export_failed"]["root-broken"].startswith("export-failed:")

            index = json.loads((Path(out) / "delta-index.json").read_text(encoding="utf-8"))
            assert set(index["bundles"]) == {"root-ok"}
            assert not (Path(out) / "otel" / "root-broken.otel.jsonl").exists()
            assert not (Path(out) / "sessions" / "root-broken.session.json").exists()
            assert (Path(out) / "sessions" / "root-ok.session.json").exists()

            export_event = next(e for e in progress_events if e["title"] == "World Model Trace Export")
            metadata = export_event.get("metadata") or export_event
            assert metadata.get("export_failed") == 1
            assert metadata.get("exported_sessions") == 1
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
            # The retained bundle's eligible verdict is final and replays from the
            # delta index's screening cache; only the admitted new bundle is read.
            assert classified == ["root-new-a"], classified
            assert result["screening_cache_hits"] == 1
            index = json.loads((Path(out) / "delta-index.json").read_text(encoding="utf-8"))
            assert set(index["bundles"]) == {"root-existing-z", "root-new-a"}
        finally:
            if prior_cap is None:
                os.environ.pop("WMH_MAX_BUNDLES", None)
            else:
                os.environ["WMH_MAX_BUNDLES"] = prior_cap
            world_model_harness.bundle_world_model_mode = original_mode
            restore()


def test_demo_filter_purges_previously_indexed_steps_without_ingestion_failure():
    import benchmarks.world_model_harness as wmh

    with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as out:
        restore = _with_archive_env(tmp)
        original_demo_task_names = wmh._DEMO_BENCHMARK_TASK_NAMES
        try:
            _write_golden_bundle("root-real")
            _write_golden_bundle("root-demo")
            from helpers.trace_archive import archive_json

            demo_manifest = wmh.read_archive_json("root-demo", "manifest.json.gz.enc")
            demo_manifest["benchmark_task_name"] = "test-mass-agent-run-0"
            archive_json(
                root_agent_id="root-demo",
                path="manifest.json.gz.enc",
                payload=demo_manifest,
            )

            class FakeMetrics:
                def model_dump(self):
                    return {"held_out_accuracy": 0.5}

            class FakeResult:
                metrics = FakeMetrics()

            def fake_upstream_build(config, **kwargs):
                Path(kwargs["root"]).mkdir(parents=True, exist_ok=True)
                return FakeResult()

            # Reproduce a corpus and cached verdict created before the DEMO
            # screen existed, then mark its delta index with the old policy.
            wmh._DEMO_BENCHMARK_TASK_NAMES = frozenset()
            initial = wmh.update_world_model_for_simulation(
                output_dir=out,
                root_agent_ids=["root-real", "root-demo"],
                name="rose-demo-purge",
                gepa_budget=0,
                upstream_build=fake_upstream_build,
                config_factory=lambda **kwargs: {"config": kwargs},
            )
            assert initial["total_traces"] == 2
            wmh._DEMO_BENCHMARK_TASK_NAMES = original_demo_task_names
            index_path = Path(out) / "delta-index.json"
            stale_index = json.loads(index_path.read_text(encoding="utf-8"))
            stale_index["screening_policy"] = "exportable-v3"
            index_path.write_text(json.dumps(stale_index), encoding="utf-8")

            refreshed_corpora: list[str] = []

            def fake_index_refresh(trace_file, _model_root, **_kwargs):
                corpus = Path(trace_file).read_text(encoding="utf-8")
                refreshed_corpora.append(corpus)
                return {"indexed_traces": 1, "indexed_steps": 2, "index_path": "fake-index"}

            filtered = wmh.update_world_model_for_simulation(
                output_dir=out,
                root_agent_ids=["root-real", "root-demo"],
                name="rose-demo-purge",
                gepa_budget=0,
                upstream_build=fake_upstream_build,
                config_factory=lambda **kwargs: {"config": kwargs},
                index_refresher=fake_index_refresh,
            )

            assert filtered["status"] == "ready"
            assert filtered["total_traces"] == 1
            assert filtered["updated_traces"] == 0
            assert filtered["excluded_reasons"] == {"demo-task": 1}
            assert filtered["index_refreshed"] is True
            assert len(refreshed_corpora) == 1
            assert "root-real" in refreshed_corpora[0]
            assert "root-demo" not in refreshed_corpora[0]
            index = json.loads(index_path.read_text(encoding="utf-8"))
            assert set(index["bundles"]) == {"root-real"}
            assert filtered["purged_staging_files"] == 2
            assert not (Path(out) / "otel" / "root-demo.otel.jsonl").exists()
            assert not (Path(out) / "sessions" / "root-demo.session.json").exists()
        finally:
            wmh._DEMO_BENCHMARK_TASK_NAMES = original_demo_task_names
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
    import dataclasses

    for name in list(sys.modules):
        if name == "wmh" or name.startswith("wmh."):
            del sys.modules[name]

    import numpy as np
    from wmh.engine.build import build as native_build
    from wmh.providers.base import Completion, Message, ProviderConfig, ProviderKind
    from wmh.retrieval import EmbeddingRetriever, HashingEmbedder

    from benchmarks.world_model_harness import (
        build_world_model_from_archives,
        load_grounded_transitions,
        normalize_world_model_index_records,
    )

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
            observation = "Trusted by\u2028everyone\u2029and\u0085more — café"
            transitions = load_grounded_transitions("root-upstream-build")
            transitions = [
                dataclasses.replace(
                    transition,
                    observation=dataclasses.replace(transition.observation, content=f"{row}: {observation}"),
                )
                for row, transition in enumerate(transitions)
            ]
            original_rows = []
            original_matrix = None

            def capture_native_build(config, **kwargs):
                nonlocal original_matrix
                result = native_build(config, **kwargs)
                index = Path(kwargs["root"]) / "index"
                with (index / "steps.jsonl").open(encoding="utf-8") as source:
                    original_rows.extend(json.loads(line) for line in source)
                original_matrix = (index / "embeddings.npy").read_bytes()
                return result

            with patch("benchmarks.world_model_harness.load_grounded_transitions", return_value=transitions):
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
                    upstream_build=capture_native_build,
                )
            model_root = Path(manifest["model_root"])
            assert (model_root / "config.toml").exists()
            assert (model_root / "prompts" / "optimized.txt").read_text(encoding="utf-8")
            assert (model_root / "index").exists()
            retriever = EmbeddingRetriever(HashingEmbedder(dim=32))
            retriever.load(model_root / "index")
            assert len(retriever._steps) == len(transitions)
            assert [step.model_dump(mode="json") for step in retriever._steps] == original_rows
            assert [json.loads(step.observation.content)["content"] for step in retriever._steps] == [
                f"{row}: {observation}" for row in range(len(transitions))
            ]
            assert retriever._matrix.shape == (len(transitions), 32)
            index = model_root / "index"
            assert (index / "embeddings.npy").read_bytes() == original_matrix
            normalized_bytes = (index / "steps.jsonl").read_bytes()
            assert normalize_world_model_index_records(model_root)["escaped_records"] == 0
            assert (index / "steps.jsonl").read_bytes() == normalized_bytes

            malformed_bytes = normalized_bytes + b'{"action":'
            (index / "steps.jsonl").write_bytes(malformed_bytes)
            try:
                normalize_world_model_index_records(model_root)
                raise AssertionError("malformed Step was accepted")
            except ValueError as exc:
                assert "Invalid JSON" in str(exc)
            assert (index / "steps.jsonl").read_bytes() == malformed_bytes
            assert (index / "embeddings.npy").read_bytes() == original_matrix

            (index / "steps.jsonl").write_bytes(normalized_bytes)
            np.save(index / "embeddings.npy", np.zeros((len(transitions) + 1, 32)))
            mismatched_matrix = (index / "embeddings.npy").read_bytes()
            try:
                normalize_world_model_index_records(model_root)
                raise AssertionError("mismatched matrix was accepted")
            except ValueError as exc:
                assert "matrix shape" in str(exc)
            assert (index / "steps.jsonl").read_bytes() == normalized_bytes
            assert (index / "embeddings.npy").read_bytes() == mismatched_matrix
        finally:
            restore()


def test_native_wmh_ingestion_preserves_completed_pairs_with_equal_or_regressing_clocks():
    from wmh.ingest.otel_genai import OtelGenAIAdapter

    from benchmarks.world_model_harness import (
        CanonicalAction,
        CanonicalObservation,
        RoseTransition,
        jsonl_line,
        transitions_to_otel_spans,
    )

    timestamps = [1783099905246] * 16 + list(range(1783099905245, 1783099905237, -1)) + [None, None, 0]
    transitions = [
        RoseTransition(
            state_before={"root_agent_id": "equal-clock-root", "row": row},
            scratchpad=f"state-{row}",
            action=CanonicalAction(
                category="explore",
                name="spawn_explore_agent",
                arguments={"goal": f"request-{row}"},
                tool_call_id=f"call-{row}",
                timestamp_ms=timestamp,
            ),
            observation=CanonicalObservation(
                category="explore",
                content=f"completed-result-{row}",
                timestamp_ms=timestamp,
            ),
        )
        for row, timestamp in enumerate(timestamps)
    ]
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "paired.otel.jsonl"
        spans = transitions_to_otel_spans("equal-clock-root", transitions)
        path.write_text("\n".join(jsonl_line(json.dumps(span)) for span in spans) + "\n")
        traces = OtelGenAIAdapter().from_file(str(path))
        assert len(traces) == 1
        steps = traces[0].steps
        assert len(steps) == len(transitions), "native ingestion fabricated unmatched empty Steps"
        for step, transition in zip(steps, transitions):
            assert step.action.arguments == transition.action.to_arguments()
            assert json.loads(step.observation.content) == json.loads(transition.observation.to_output_text())
            assert step.state_before.structured == transition.state_before
            assert step.state_before.scratchpad == transition.scratchpad


def test_grounded_export_preserves_each_real_tool_call_measured_duration():
    """Demos carry the real measured time-to-complete, independent of the ordinal span clocks."""
    from benchmarks.world_model_harness import export_archive_to_otel_jsonl, load_grounded_transitions
    from helpers.trace_archive import archive_json

    with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as out:
        restore = _with_archive_env(tmp)
        try:
            root = "root-measured-durations"
            start_fixture = {
                "root_agent_id": root,
                "user_id": "user",
                "agent_ids": [root],
                "rows": {"Agent": [{"id": root, "goal": "Research a vendor"}]},
            }

            def assistant(call_id, tool, created):
                return {"id": f"assistant-{call_id}", "agentId": root, "role": "ASSISTANT", "createdAt": created,
                        "metadata": {"tool_calls": [{"tool": tool, "tool_call_id": call_id, "arguments": {"q": call_id}}]}}

            def tool_row(call_id, tool, status, created, text=""):
                return {"id": f"tool-{call_id}-{status}", "agentId": root, "role": "TOOL", "text": text,
                        "createdAt": created,
                        "metadata": {"toolName": tool, "toolCallId": call_id, "toolStatus": status, "title": tool}}

            messages = [
                # IN_PROGRESS marks the tool's own start: 00:00:01 -> 00:02:15 is 2m 14s.
                assistant("call-explore", "spawn_explore_agent", "2026-07-20T00:00:00.000Z"),
                tool_row("call-explore", "spawn_explore_agent", "IN_PROGRESS", "2026-07-20T00:00:01.000Z"),
                tool_row("call-explore", "spawn_explore_agent", "FINISHED", "2026-07-20T00:02:15.000Z", "found it"),
                # Without IN_PROGRESS, the issuing ASSISTANT row is the measured start: 850 ms.
                assistant("call-grep", "grep", "2026-07-20T00:03:00.000Z"),
                tool_row("call-grep", "grep", "FINISHED", "2026-07-20T00:03:00.850Z", "3 matches"),
            ]
            archive_json(root_agent_id=root, path="db/start.fixture.json.gz.enc", payload=start_fixture)
            archive_json(
                root_agent_id=root,
                path="db/end.fixture.json.gz.enc",
                payload={**start_fixture, "rows": {**start_fixture["rows"], "Message": messages}},
            )
            archive_json(
                root_agent_id=root,
                path="manifest.json.gz.enc",
                payload={"root_agent_id": root, "world_model_mode": "real",
                         "run": {"root_goal": "Research a vendor", "agent_ids": [root]}},
            )
            grounded = {step.action.name: step for step in load_grounded_transitions(root)}
            assert grounded["spawn_explore_agent"].observation.elapsed_ms == 134_000
            assert grounded["grep"].observation.elapsed_ms == 850
            # The duration is grounding evidence, not observation text the model should echo.
            for step in grounded.values():
                assert "elapsed" not in step.observation.to_output_text()
                assert "started_at_ms" not in step.observation.to_output_text()

            trace_path = Path(out) / "traces.otel.jsonl"
            export_archive_to_otel_jsonl(root, trace_path)
            spans = [json.loads(line) for line in trace_path.read_text().splitlines() if line.strip()]
            measured = {}
            for span in spans:
                if not span["name"].startswith("execute_tool "):
                    continue
                attrs = {a["key"]: next(iter(a["value"].values())) for a in span["attributes"]}
                # Span clocks are ordinal pairing slots (a few ns wide), not the call's duration.
                assert int(span["endTimeUnixNano"]) - int(span["startTimeUnixNano"]) == 1
                measured[attrs["gen_ai.tool.name"]] = int(attrs["rose.tool.completed_at_ms"]) - int(
                    attrs["rose.tool.started_at_ms"]
                )
            assert measured == {"rose.explore.spawn_explore_agent": 134_000, "rose.grep.grep": 850}, measured
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
                    "model": "rose-1-flash",
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


async def test_runtime_wmh_retirement_uses_exact_session_and_preserves_join_receipt():
    from helpers.world_model_runtime import WMHHttpClient

    receipt = {
        "ended": "session-owned",
        "session_id": "session-owned",
        "session_scope_id": "root-owned",
        "engine": "experiential",
        "join_verified": True,
        "revision": 7,
        "state": {"counter": 7},
        "history": [{"revision": 7}],
        "usage": {"calls": 9, "total_cost_usd": 0.42},
    }
    responses = [
        httpx.Response(200, json=receipt),
        httpx.Response(200, json={**receipt, "ended": "session-foreign"}),
        httpx.Response(409, json={"detail": "provider cleanup not joined"}),
    ]
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.method == "DELETE"
        assert str(request.url) == "https://wmh.example.test/world_models/rose-native/sessions/session-owned"
        assert not request.content
        return responses.pop(0)

    setup_mock_fn(handler)
    try:
        client = WMHHttpClient("https://wmh.example.test")
        assert await client.end_session("rose-native", "session-owned") == receipt
        try:
            await client.end_session("rose-native", "session-owned")
            raise AssertionError("a foreign receipt must not acknowledge owned retirement")
        except ValueError:
            pass
        try:
            await client.end_session("rose-native", "session-owned")
            raise AssertionError("an unjoined HTTP error must not acknowledge retirement")
        except httpx.HTTPStatusError as exc:
            assert exc.response.status_code == 409
        assert len(requests) == 3
    finally:
        teardown_mock()


async def test_runtime_world_clock_long_polls_waits_and_skips_without_a_world():
    from unittest.mock import AsyncMock

    import helpers.world_model_runtime as runtime

    day = 86_400_000
    polls = [
        {"resumed": False, "time_ms": 0, "deadline_ms": day},
        {"resumed": True, "time_ms": day, "deadline_ms": day},
    ]
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append((request.url.path, json.loads(request.content or b"{}")))
        if "/scopes/root-1/clock/agents/child-1/" not in request.url.path:
            return httpx.Response(404, json={"detail": "Unknown world scope"})
        if request.url.path.endswith("/wait"):
            return httpx.Response(200, json=polls.pop(0))
        return httpx.Response(200, json={"agent_id": "child-1", "time_ms": 0})

    setup_mock_fn(handler)
    heartbeats = []
    resolve = AsyncMock(return_value=(False, None, False, "root-1", None, False))
    try:
        with (
            patch.dict(os.environ, {"WMH_BASE_URL": "https://wmh.example.test", "WMH_MODEL_NAME": "rose-archive"}),
            patch.object(runtime.activity, "heartbeat", lambda *args: heartbeats.append(args)),
            patch("providers.fast_cache.client.resolve_agent_fast_mode", resolve),
        ):
            assert (await runtime.world_clock_activity("register", "child-1", "root-1"))["time_ms"] == 0
            waited = await runtime.world_clock_activity("wait", "child-1", None, {"wait_id": "w1", "duration_ms": day})
            assert waited == {"resumed": True, "time_ms": day, "deadline_ms": day} and len(heartbeats) == 1
            assert (await runtime.world_clock_activity("finish", "child-1"))["agent_id"] == "child-1"
            assert requests[0] == ("/world_models/rose-archive/scopes/root-1/clock/agents/child-1/register", {"parent": "root-1"})
            assert requests[1][1] == {"wait_id": "w1", "duration_ms": day, "poll_seconds": 50}
            # A parent blocked awaiting child results holds, then releases with the delivered children.
            assert (await runtime.world_clock_activity("hold", "child-1", None, {"hold_id": "spawn-1:c"}))["time_ms"] == 0
            await runtime.world_clock_activity("release", "child-1", None, {"hold_id": "spawn-1:c", "children": ["c"]})
            assert requests[-2] == ("/world_models/rose-archive/scopes/root-1/clock/agents/child-1/hold", {"hold_id": "spawn-1:c"})
            assert requests[-1] == (
                "/world_models/rose-archive/scopes/root-1/clock/agents/child-1/release",
                {"hold_id": "spawn-1:c", "children": ["c"]},
            )
            resolve.return_value = (False, None, False, "root-without-world", None, False)
            assert await runtime.world_clock_activity("wait", "child-1", None, {"wait_id": "w2", "duration_ms": day}) == {
                "skipped": "no_world_session"
            }
            # A transient root lookup failure retries instead of using the child's own scope.
            resolve.return_value = (False, None, False, None, None, False)
            request_count = len(requests)
            try:
                await runtime.world_clock_activity("register", "child-1", "root-1")
                raise AssertionError("an unresolved root must fail the activity so it retries")
            except RuntimeError as exc:
                assert "durable root agent" in str(exc)
            assert len(requests) == request_count
        with patch.dict(os.environ, {"WMH_BASE_URL": "", "WORLD_MODEL_HARNESS_URL": ""}):
            assert await runtime.world_clock_activity("finish", "child-1") == {"skipped": "no_world_model"}
    finally:
        teardown_mock()


async def test_runtime_world_time_reads_the_agent_clock_or_reports_no_world():
    from unittest.mock import AsyncMock

    import helpers.world_model_runtime as runtime

    snapshot = {
        "start_ms": 1_000,
        "shared_time_ms": 5_000,
        "agents": [{"agent_id": "child-1", "time_ms": 7_000, "parent": "root-1", "state": "running"}],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/world_models/rose-archive/scopes/root-1/clock":
            return httpx.Response(200, json=snapshot)
        return httpx.Response(404, json={"detail": "Unknown world scope"})

    setup_mock_fn(handler)
    resolve = AsyncMock(return_value=(False, None, False, "root-1", None, False))
    try:
        with (
            patch.dict(os.environ, {"WMH_BASE_URL": "https://wmh.example.test", "WMH_MODEL_NAME": "rose-archive"}),
            patch("providers.fast_cache.client.resolve_agent_fast_mode", resolve),
        ):
            assert await runtime.world_time_ms("child-1") == 7_000
            # An agent the clock has not seen yet starts at shared time.
            assert await runtime.world_time_ms("new-agent") == 5_000
            resolve.return_value = (False, None, False, "no-world", None, False)
            assert await runtime.world_time_ms("child-1") is None
        with patch.dict(os.environ, {"WMH_BASE_URL": "", "WORLD_MODEL_HARNESS_URL": ""}):
            assert await runtime.world_time_ms("child-1") is None
    finally:
        teardown_mock()


async def test_runtime_world_time_nonobject_clock_is_unavailable():
    import helpers.world_model_runtime as runtime

    payload = None
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request.url.path)
        return httpx.Response(200, content=json.dumps(payload), headers={"content-type": "application/json"})

    setup_mock_fn(handler)
    resolve = AsyncMock(return_value=(False, None, False, "root-1", None, False))
    try:
        with (
            patch.dict(os.environ, {"WMH_BASE_URL": "https://wmh.example.test", "WMH_MODEL_NAME": "rose-archive"}),
            patch("providers.fast_cache.client.resolve_agent_fast_mode", resolve),
        ):
            # A world that answers with an unusable clock is unavailable, not "no world":
            # the planner must not fall back to the real date.
            for value in [[], None, 0, -3, 1.5, True, "clock", {"agents": []}, {"start_ms": "x"}]:
                payload = value
                try:
                    await runtime.world_time_ms("child-1")
                    raise AssertionError(f"unusable clock {value!r} must raise")
                except runtime.WorldClockUnavailable:
                    pass
            for value in [-1_000, 0, 7_000]:
                payload = {"agents": [{"agent_id": "child-1", "time_ms": value}], "shared_time_ms": 5_000}
                assert await runtime.world_time_ms("child-1") == value
            payload = {"agents": [], "shared_time_ms": -1_000}
            assert await runtime.world_time_ms("child-1") == -1_000
            payload = {"start_ms": 0}
            assert await runtime.world_time_ms("child-1") == 0
            # A world pinned at epoch 0 reports shared time 0, not its start.
            payload = {"agents": [], "shared_time_ms": 0, "start_ms": 1_000}
            assert await runtime.world_time_ms("child-1") == 0
            assert all(p == "/world_models/rose-archive/scopes/root-1/clock" for p in requests)
            assert resolve.await_count == len(requests)
    finally:
        teardown_mock()


async def test_runtime_world_time_retries_then_fails_instead_of_wall_clock():
    import helpers.world_model_runtime as runtime

    responses: list = []
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request.url.path)
        outcome = responses.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    setup_mock_fn(handler)
    resolve = AsyncMock(return_value=(False, None, False, "root-1", None, False))
    try:
        with (
            patch.dict(os.environ, {"WMH_BASE_URL": "https://wmh.example.test", "WMH_MODEL_NAME": "rose-archive"}),
            patch("providers.fast_cache.client.resolve_agent_fast_mode", resolve),
            patch.object(runtime, "_WORLD_TIME_RETRY_DELAY_S", 0),
        ):
            # Transient transport and server errors retry the same clock read.
            responses[:] = [
                httpx.ConnectError("offline clock blip"),
                httpx.Response(503, json={"detail": "busy"}),
                httpx.Response(200, json={"agents": [], "shared_time_ms": 9_000}),
            ]
            assert await runtime.world_time_ms("child-1") == 9_000
            assert len(requests) == 3
            # A clock that stays unavailable raises rather than reporting no world.
            responses[:] = [httpx.Response(503, json={"detail": "busy"})] * 3
            try:
                await runtime.world_time_ms("child-1")
                raise AssertionError("an unavailable world clock must raise")
            except runtime.WorldClockUnavailable as exc:
                assert "HTTP 503" in str(exc)
            assert len(requests) == 6
            # A failed root lookup cannot fall back to the agent's own scope.
            resolve.return_value = (False, None, False, None, None, False)
            try:
                await runtime.world_time_ms("child-1")
                raise AssertionError("an unresolved root must raise")
            except runtime.WorldClockUnavailable:
                pass
            assert len(requests) == 6
    finally:
        teardown_mock()


def test_wmh_http_clients_allow_slow_grounded_transitions():
    from benchmarks.world_model_harness import WMHHttpClient as BenchmarkClient
    from helpers.world_model_runtime import WMHHttpClient as RuntimeClient

    old_timeout = os.environ.get("WMH_HTTP_TIMEOUT_SECONDS")
    try:
        os.environ.pop("WMH_HTTP_TIMEOUT_SECONDS", None)
        for client_type in (BenchmarkClient, RuntimeClient):
            assert client_type("https://wmh.example.test").timeout == 660
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
        "spawn_explore_agent": "explore",
        "spawn_browser_agent": "browser",
        "spawn_claude_code_agent": "code",
        "spawn_general_purpose_agent_for_each": "for_each",
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
    from helpers.world_model_runtime import (
        WorldModelToolExecutionAdapter,
    )
    from helpers.world_model_runtime import (
        canonical_action_from_tool_call as runtime_action_from_tool_call,
    )

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
        adapter_action = WorldModelToolExecutionAdapter(
            mode="simulate",
            timestamp_ms=1893542400123,
        ).action_for_tool("spawn_explore_agent", {"goal": "check again"}, "tool-3")
        assert adapter_action.timestamp_ms == 1893542400123

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


async def test_demo_wmh_cache_reuses_equivalent_actions_across_run_ids():
    """Run-local action IDs and timestamps must not bust identical DEMO predictions."""
    from wmh.core.render import build_env_prompt
    from wmh.core.types import Action, ActionKind, EnvState
    from wmh.providers.base import Message

    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.wmh_rose_provider import RoseUsageAccumulator, RoseWMHProvider
    from providers.fast_cache.context import current_context
    from providers.fast_cache.normalize import demo_cache_allowed
    from providers.fast_cache.rose_cache import request_key_material
    from providers.rose import RoseResponse

    # The DEMO allowlist is the hash of each DEMO-tagged catalog prompt, so read
    # the current fundraiser prompt instead of pinning a copy that drifts.
    goal = get_task_by_name("raise-5m-rose-labs-brex").prompt
    assert demo_cache_allowed(goal), "The fundraiser catalog prompt must stay a DEMO cache goal"
    from benchmarks.wmh_rose_provider import _wmh_cache_key_material
    from providers.fast_cache.normalize import canonical_messages

    keys = []
    key_inputs = []
    sent_prompts = []

    class RecordingClient:
        async def collect(self, **kwargs):
            context = current_context()
            assert context is not None and context.read_enabled
            material = request_key_material({**kwargs, "provider_fast_mode": context.provider_fast_mode})
            keys.append(context.llm_key("wmh_world_model", material))
            # T56: this failed once under 99-domain load and never reproduced;
            # keep what was keyed so the next occurrence names the differing input.
            key_inputs.append(
                {
                    "base_step": context.base_step,
                    "goal_hash": hashlib.sha256(str(context.goal).encode()).hexdigest()[:12],
                    "canonical": canonical_messages(_wmh_cache_key_material(material)),
                }
            )
            sent_prompts.append(kwargs["messages"][1]["content"])
            response = RoseResponse()
            response.content = '{"output":"ok","is_error":false,"state_note":""}'
            response.actual_model = "gpt-5.6-terra-gpt"
            return response

    provider = RoseWMHProvider(client=RecordingClient(), usage=RoseUsageAccumulator())

    async def no_auth():
        return None, None

    with patch.object(provider, "_lease_auth", no_auth):
        for root_id, tool_id, timestamp_ms, phase in (
            ("5ef8d350-deab-46b7-9077-5ebe64c94c41", "call_abcdefghijklmnop", 1790596437171, "plan"),
            ("944a1e33-c63a-4e2f-a896-0fcdde85b526", "call_qrstuvwxyzabcdef", 1790601558171, "plan"),
            ("944a1e33-c63a-4e2f-a896-0fcdde85b526", "call_qrstuvwxyzabcdef", 1790601558171, "execute"),
        ):
            state = EnvState(
                structured={"schema": "rose.runtime_initial_state.v1", "root_agent_id": root_id, "root_goal": goal}
            )
            action = Action(
                kind=ActionKind.TOOL_CALL,
                name="rose.message.notify_sms_event",
                arguments={
                    "schema": "rose.canonical_action.v1",
                    "category": "message",
                    "name": "notify_sms_event",
                    "arguments": {"event_type": "agent_started", "payload": {"goal": goal, "phase": phase}},
                    "agent_id": root_id,
                    "tool_call_id": tool_id,
                    "timestamp_ms": timestamp_ms,
                },
            )
            system, user = build_env_prompt("SYS", goal, state, action)
            await provider._complete_async(system, [Message(role="user", content=user)], max_tokens=16384)

    assert sent_prompts[0] != sent_prompts[1], "The provider must see the unmodified WMH prompt"
    if keys[0] != keys[1]:
        import difflib

        first, second = (
            [f"base_step={item['base_step']} goal={item['goal_hash']}", *str(item["canonical"]).split("\\n")]
            for item in key_inputs[:2]
        )
        diff = "\n".join(list(difflib.unified_diff(first, second, "call-1", "call-2", lineterm=""))[:80])
        raise AssertionError(f"Equivalent DEMO actions must reuse the same WHM cache entry; keyed inputs differ:\n{diff}")
    assert keys[1] != keys[2], "A meaningful action change must still produce a new key"


def test_world_model_observation_ignores_non_object_metadata():
    from utils.world_model_observation import normalize_world_model_observation

    for metadata in (["unexpected"], "unexpected", 3):
        envelope = {
            "content": json.dumps({"output": "done", "state_note": "cart saved"}),
            "metadata": metadata,
        }
        decoded = normalize_world_model_observation(envelope)
        assert decoded["content"] == "done"
        assert decoded["metadata"] == {"state_note": "cart saved"}
        canonical = {
            "content": json.dumps(
                {"schema": "rose.canonical_observation.v1", "content": "ok", "metadata": {"step": 1}}
            ),
            "metadata": metadata,
        }
        decoded = normalize_world_model_observation(canonical, canonical=True)
        assert decoded["content"] == "ok"
        assert decoded["metadata"] == {"step": 1}


def test_world_model_observation_ignores_non_finite_latency():
    from utils.world_model_observation import predicted_latency_ms_from_observation

    for value in (float("nan"), float("inf"), float("-inf"), "inf", "NaN", "Infinity"):
        assert predicted_latency_ms_from_observation({"latency_ms": value}) is None, repr(value)
        assert predicted_latency_ms_from_observation({"metadata": {"duration_ms": value}}) is None, repr(value)
    decoded = json.loads('{"latency_ms": NaN, "metadata": {"elapsed_ms": 250}}')
    assert predicted_latency_ms_from_observation(decoded) == 250


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


def test_world_model_observation_unwraps_archived_prod_result_shape():
    """Archive OTel envelopes are training format, not parent-agent tool output."""
    from benchmarks.world_model_harness import world_model_observation_to_tool_result
    from helpers.world_model_runtime import world_model_observation_to_tool_result as runtime_to_tool_result

    observation = {
        "content": json.dumps(
            {
                "schema": "rose.canonical_observation.v1",
                "category": "explore_result",
                "content": "Found three investors and verified their contact details.",
                "is_error": False,
                "metadata": {"source": "agent_message", "tool_status": "FINISHED"},
            }
        ),
        "is_error": False,
        "metadata": {},
    }

    for convert in (world_model_observation_to_tool_result, runtime_to_tool_result):
        result = convert(observation, simulated=True)
        assert result["success"] is True
        assert result["message"] == "Found three investors and verified their contact details."
        assert result["result"] == "Found three investors and verified their contact details."
        assert result["world_model_observation"] == observation


def test_world_model_observation_preserves_archived_browser_state_shape():
    """Browser transitions in the real corpus contain action_result + browser_state."""
    from benchmarks.world_model_harness import world_model_observation_to_tool_result
    from helpers.world_model_runtime import world_model_observation_to_tool_result as runtime_to_tool_result

    browser_result = {
        "action_result": {"success": True},
        "browser_state": {"url": "https://example.test/dashboard", "title": "Dashboard"},
    }
    observation = {
        "content": json.dumps(
            {
                "schema": "rose.canonical_observation.v1",
                "category": "browser_state",
                "content": json.dumps(browser_result),
                "is_error": False,
                "metadata": {"source": "browser"},
            }
        ),
        "is_error": False,
        "metadata": {},
    }

    for convert in (world_model_observation_to_tool_result, runtime_to_tool_result):
        result = convert(observation, simulated=True)
        assert result["action_result"] == browser_result["action_result"]
        assert result["browser_state"] == browser_result["browser_state"]
        assert result["success"] is True
        assert result["world_model_observation"] == observation


def test_world_model_observation_unwraps_nested_output_envelope():
    """An off-contract extra WMH output wrapper must not leak archive JSON."""
    from wmh.core.parsing import parse_observation

    from benchmarks.world_model_harness import world_model_observation_to_tool_result
    from domains.spawn_agent.handler import _world_model_specialized_result_text
    from helpers.world_model_runtime import world_model_observation_to_tool_result as runtime_to_tool_result

    canonical = json.dumps(
        {
            "schema": "rose.canonical_observation.v1",
            "category": "explore_result",
            "content": "Thirty investor candidates found.",
            "is_error": False,
            "metadata": {"source": "agent_message"},
        }
    )
    observation = {
        "content": json.dumps({"output": canonical, "is_error": False}),
        "is_error": False,
        "metadata": {},
    }

    for convert in (world_model_observation_to_tool_result, runtime_to_tool_result):
        result = convert(observation, simulated=True)
        assert result["message"] == "Thirty investor candidates found."
        assert result["result"] == "Thirty investor candidates found."
        assert "output" not in result

        terminal = {"status": "success", "structured_response": {"account_accessed": True, "balance_usd": 0}}
        object_observation = parse_observation(json.dumps({"output": terminal, "is_error": False})).model_dump(
            mode="json"
        )
        object_result = convert(object_observation, simulated=True)
        assert json.loads(_world_model_specialized_result_text(object_result)) == terminal, (
            "object-valued WMH output must expose the terminal result"
        )

        production_result = {"success": True, "output": {"rows": []}, "metadata": {"source": "query"}}
        direct_result = convert({"content": json.dumps(production_result), "is_error": False}, simulated=True)
        assert direct_result["output"] == production_result["output"]
        assert direct_result["metadata"] == production_result["metadata"], (
            "production output fields must retain their result envelope"
        )


def test_world_model_observation_keeps_error_text_for_temporal_messages():
    """A WMH error must never become a boolean post_agent_message argument."""
    from benchmarks.world_model_harness import world_model_observation_to_tool_result
    from helpers.world_model_runtime import world_model_observation_to_tool_result as runtime_to_tool_result

    observation = {
        "content": json.dumps(
            {
                "error": True,
                "message": "The approved transport was rejected by the provider.",
                "is_error": True,
            }
        ),
        "is_error": True,
        "metadata": {},
    }

    for convert in (world_model_observation_to_tool_result, runtime_to_tool_result):
        result = convert(observation, simulated=True)
        assert result["success"] is False
        assert result["error"] == "The approved transport was rejected by the provider."
        assert isinstance(result["error"], str)


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
        agent_id="agent-1",
        session_scope_id="agent-1:browser:tool-browser",
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


async def test_simulated_payment_card_approval_finishes_pending_tool_for_resumed_policy():
    from domains.spawn_browser_agent_v3 import handler as browser_handler

    class FakeWorldModel:
        world_model_name = "payment-test"
        session_id = None

        async def ensure_session(self, *, task, seed_state):
            self.session_id = "wmh-payment-session"
            return self.session_id

    class FakeStream:
        def __init__(self, **kwargs):
            pass

        async def start(self):
            pass

        async def finish(self):
            pass

        async def finish_tools(self, status):
            pass

    class FakeRoseClient:
        def set_thinking_stream(self, stream):
            pass

    policy = AsyncMock(
        side_effect=[
            {
                "action": {
                    "action": "request_payment_card",
                    "params": {
                        "merchant": "Rose Labs Test Payment",
                        "line_items": [
                            {
                                "name": "Aurora Notebook",
                                "product_url": "https://shop.example.test/products/aurora-notebook",
                                "rating": "4.9 stars",
                                "review_count": "217 reviews",
                                "unit_price_cents": 1200,
                                "quantity": 1,
                                "line_total_cents": 1200,
                            }
                        ],
                        "subtotal_cents": 1200,
                        "total_cents": 4396,
                        "currency": "USD",
                    },
                },
                "tool_call_id": "payment-call",
                "usage": {},
            },
            {"action": {"action": "attempt_completion"}, "tool_call_id": "completion-call", "usage": {}},
        ]
    )
    verifier = AsyncMock(return_value={"score": 1, "reasoning": "Confirmed", "structured_response": {}})
    kwargs = dict(
        user_id="user-1",
        agent_id="agent-1",
        goal="Complete checkout",
        tool_call_id="browser-call",
        task_id="browser-task",
        session_id=None,
        cdp_url=None,
        is_resume=False,
        output_schema={"fields": []},
        attachments=None,
        write_lock_enabled=True,
        start_url="https://shop.example.test",
        write_lock_resume_state=None,
        system_name="Rose",
        use_claude_mode=False,
        gpt_token=None,
        gpt_account_id=None,
        gpt_token_source=None,
        gpt_token_pool_id=None,
        world_model=FakeWorldModel(),
        browser_pool="rose-1-ultra",
    )
    pricing = AsyncMock(return_value={})
    native_start = await native_browser_start_source("2026-01-01T00:00:00+00:00", tool_call_id="browser-call", mode="simulate")
    with (
        patch.object(browser_handler.activity, "info", return_value=types.SimpleNamespace(
            scheduled_time=browser_handler.datetime.now(browser_handler.timezone.utc))),
        patch.object(browser_handler, "load_config", return_value=types.SimpleNamespace()),
        patch.object(browser_handler, "get_model_pricing_with_fallback", pricing),
        patch.object(browser_handler, "BrowserThinkingStream", FakeStream),
        patch.object(browser_handler, "BrowserStreamingRoseClient", FakeRoseClient),
        patch.object(browser_handler, "_call_browser_use_with_rotation", policy),
        patch.object(browser_handler, "_verify_simulated_browser_completion", verifier),
        patch.object(browser_handler, "poll_new_messages", AsyncMock(return_value=[native_start])),
        patch.object(browser_handler, "save_browser_action_message", AsyncMock()),
        patch.object(browser_handler, "save_browser_assistant_message", AsyncMock()),
        patch.object(browser_handler.SimulatedBrowserRecorder, "create", AsyncMock(return_value=None)),
    ):
        pending = await browser_handler._spawn_browser_agent_activity_v3_simulated(**kwargs)
        assert pending["status"] == "awaiting_payment_card_approval"
        assert (
            json.loads(pending["simulated_turn_messages"][-1]["content"])["status"] == "awaiting_payment_card_approval"
        )
        kwargs["is_resume"] = True
        kwargs["write_lock_resume_state"] = {
            **pending,
            "approval_type": "payment",
            "payment_card_refs": {
                "card_number": "4111111111111111",
                "card_name": "Rose Labs",
                "card_expiry": "12/30",
                "card_cvv": "123",
            },
            "payment_card_last4": "1111",
        }
        completed = await browser_handler._spawn_browser_agent_activity_v3_simulated(**kwargs)

    assert completed["status"] == "completed"
    # Simulated browser steps run and price on the spawning agent's pool.
    assert {call.kwargs["pool"] for call in policy.await_args_list} == {"rose-1-ultra"}
    assert {call.args[0] for call in pricing.await_args_list} == {"rose-1-ultra"}
    resumed_turns = policy.await_args_list[1].kwargs["turn_messages"]
    assert json.loads(resumed_turns[-1]["content"])["status"] == "payment_card_ready"
    assert "4111111111111111" not in resumed_turns[-1]["content"]


async def _exercise_simulated_browser_policy(*, active_feedback=False, startup_feedback=False, poll_failure_calls=(), schema_failures=0, permanent_schema_failure=False, schema_invalid=False, return_replay=False, emit_tool_stream=False):
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
    import copy
    from datetime import datetime, timedelta, timezone
    correction = "Use the existing signed-in account, preserving the order ID deliverable."
    scheduled_time = datetime.now(timezone.utc) - timedelta(seconds=30)
    rows = [{"id": "prior-task", "role": "USER", "text": "Historical task input",
             "timestamp": (scheduled_time - timedelta(seconds=1)).isoformat()}]
    rows.append(await native_browser_start_source(scheduled_time.isoformat(), tool_call_id="tool-browser", mode="simulate"))
    if startup_feedback:
        rows.append({"id": "queued-correction", "role": "USER", "text": correction,
                     "timestamp": (scheduled_time + timedelta(seconds=1)).isoformat()})
    model_inputs = []
    async def decide(**kwargs):
        model_inputs.append(copy.deepcopy(kwargs["turn_messages"]))
        if emit_tool_stream:
            from providers.rose import StreamChunk
            await kwargs["rose_client"].stream.on_chunk(StreamChunk(kind="tool_call", data={
                "id": f"native-action-{len(model_inputs)}", "name": "attempt_completion" if len(model_inputs) == 6 else "click", "arguments": {},
            }))
        if active_feedback and len(model_inputs) == 1:
            rows.append({"id": "active-correction", "role": "USER", "text": correction,
                         "timestamp": datetime.now(timezone.utc).isoformat()})
        return policy_results[len(model_inputs) - 1]
    poll_calls = 0
    async def poll(_agent_id, since, **kwargs):
        nonlocal poll_calls
        poll_calls += 1
        if poll_calls in poll_failure_calls:
            raise TimeoutError("instruction backend unavailable")
        return [row for row in rows if datetime.fromisoformat(row["timestamp"]) >= since]
    schema = {"fields": [{"name": "order_id", "type": "string",
                          "description": "Amazon order confirmation ID", "required": True}]}
    async def generate_schema(*args, **kwargs):
        if schema_invalid:
            return {"fields": []}, None, {"prompt_tokens": 7, "completion_tokens": 2, "actual_model": "schema-test-model"}
        if permanent_schema_failure or generator.await_count <= schema_failures:
            raise TimeoutError("schema provider unavailable")
        return schema, None, {}
    generator = AsyncMock(side_effect=generate_schema)
    policy = AsyncMock(side_effect=decide)
    verifier = AsyncMock(
        return_value={
            "score": 1,
            "reasoning": "The final WMH state shows the order confirmation.",
            "structured_response": {"order_id": "111-2222222-3333333"},
        }
    )
    world_model = FakeWorldModel()
    tool_events = AsyncMock()
    native_stream = browser_handler.BrowserThinkingStream
    with (
        patch.object(browser_handler.activity, "info", return_value=types.SimpleNamespace(scheduled_time=scheduled_time)),
        patch.object(browser_handler, "load_config", return_value=types.SimpleNamespace()),
        patch.object(
            browser_handler,
            "get_model_pricing_with_fallback",
            AsyncMock(return_value={"input_cents_per_1k": 0, "output_cents_per_1k": 0}),
        ),
        patch.object(browser_handler, "BrowserThinkingStream", native_stream if emit_tool_stream else FakeStream),
        patch("domains.spawn_browser_agent_v3.streaming.stream_assistant_chunk", AsyncMock()),
        patch("domains.spawn_browser_agent_v3.streaming.stream_tool_event", tool_events),
        patch.object(browser_handler, "BrowserStreamingRoseClient", FakeRoseClient),
        patch.object(browser_handler, "_call_browser_use_with_rotation", policy),
        patch.object(browser_handler, "_verify_simulated_browser_completion", verifier),
        patch.object(browser_handler, "poll_new_messages", AsyncMock(side_effect=poll)),
        patch("helpers.llm._generate_response_schema_with_rose", generator),
        patch.object(browser_handler, "save_browser_action_message", AsyncMock()),
        patch.object(browser_handler, "save_browser_assistant_message", AsyncMock()),
        patch.object(browser_handler.SimulatedBrowserRecorder, "create", AsyncMock(return_value=None)),
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

    if return_replay:
        return {"result": result, "model_inputs": model_inputs, "policy": policy,
                "generator": generator, "verifier": verifier, "correction": correction,
                "actions": world_model.actions, "poll_calls": poll_calls, "tool_events": tool_events}
    assert result["status"] == "completed"
    assert result["world_model_simulated"] is True
    assert result["simulated_browser_steps"] == 6
    assert result["structured_response"]["order_id"] == "111-2222222-3333333"
    assert result["message"].startswith(
        "**Goal**: Complete the Amazon order\n\n**Status**: \u2705 SUCCESS"
    ), result["message"]
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

    assert all("Historical task input" not in json.dumps(turns) for turns in model_inputs), "fresh browser replayed prior history"
    if active_feedback or startup_feedback:
        assert {"role": "user", "content": correction} in model_inputs[0 if startup_feedback else 1], "active simulated browser lost the actual USER correction"
        assert verifier.await_args.kwargs.get("user_instruction_messages") == [{"role": "user", "content": correction}], "simulated verifier omitted the actual USER correction"
        generator.assert_awaited_once()
        assert all("Output schema revised" not in json.dumps(turns) for turns in model_inputs)
    else:
        generator.assert_not_awaited()


async def test_simulated_browser_publishes_native_task_start_for_resume_scope():
    from _test_utils import native_browser_start_source
    for mode in ("real", "simulate"):
        row = await native_browser_start_source("2026-10-14T17:00:00+00:00", mode=mode)
        assert row["role"] == "TOOL"
        assert row["metadata"]["toolCallId"] == "tool-1"
        assert row["metadata"]["toolName"] == "spawn_browser_agent"
        assert row["metadata"]["action_type"] == "session_starting"
        assert row["metadata"]["toolStatus"] == "IN_PROGRESS"


async def test_simulated_browser_runs_five_policy_steps_then_verified_completion():
    await _exercise_simulated_browser_policy()


async def test_simulated_browser_instruction_poll_recovers_before_actor():
    replay = await _exercise_simulated_browser_policy(active_feedback=True, poll_failure_calls=(2,), return_replay=True)
    assert replay["result"]["status"] == "completed"
    assert replay["policy"].await_count == 6
    assert [m["content"] for m in replay["model_inputs"][-1] if m.get("role") == "user"] == [replay["correction"]]
    assert replay["verifier"].await_args.kwargs["user_instruction_messages"] == [{"role": "user", "content": replay["correction"]}]


async def test_simulated_browser_failed_schema_retries_at_completion():
    replay = await _exercise_simulated_browser_policy(active_feedback=True, schema_failures=1, return_replay=True)
    assert replay["result"]["status"] == "completed"
    assert replay["generator"].await_count == 2
    assert replay["policy"].await_count == 6
    assert replay["verifier"].await_args.kwargs["user_instruction_messages"] == [{"role": "user", "content": replay["correction"]}]


async def test_simulated_browser_permanent_schema_failure_exits_without_iteration_burn():
    replay = await _exercise_simulated_browser_policy(active_feedback=True, permanent_schema_failure=True, return_replay=True, emit_tool_stream=True)
    assert replay["result"]["status"] == "failed"
    assert replay["result"].get("browser_error_type") == "TimeoutError"
    assert "schema provider unavailable" in replay["result"]["message"]
    assert replay["policy"].await_count == 6
    replay["verifier"].assert_not_awaited()
    assert any(call.kwargs.get("tool_call_id") == "native-action-6" and call.kwargs.get("status") == "ERROR" for call in replay["tool_events"].await_args_list), "actual announced simulated completion tool remained unresolved"


async def test_simulated_browser_unconfirmed_input_blocks_actual_click_transition():
    replay = await _exercise_simulated_browser_policy(active_feedback=True, poll_failure_calls=(2, 3), return_replay=True)
    assert replay["result"]["status"] == "failed" and replay["result"].get("browser_error_type") == "TimeoutError"
    assert replay["actions"] == []
    replay["policy"].assert_not_awaited()
    replay["verifier"].assert_not_awaited()


async def test_simulated_browser_failed_schema_keeps_known_usage():
    replay = await _exercise_simulated_browser_policy(active_feedback=True, schema_invalid=True, return_replay=True)
    assert replay["result"]["status"] == "failed"
    assert replay["policy"].await_count == 6 and replay["generator"].await_count == 2
    llm = [row for row in replay["result"]["usage_items"] if row["type"] == "llm"]
    assert sum(row["input_tokens"] for row in llm) == 74
    assert sum(row["output_tokens"] for row in llm) == 16


async def test_simulated_browser_preserves_active_user_input_without_narration():
    await _exercise_simulated_browser_policy(active_feedback=True)


async def test_simulated_browser_preserves_user_input_queued_before_activity_execution():
    await _exercise_simulated_browser_policy(startup_feedback=True)


async def _exercise_simulated_browser_pending_approval(*, user_feedback=False, legacy_resume=False, initial_poll_failure=False):
    from domains.spawn_browser_agent_v3 import handler as browser_handler
    from datetime import datetime, timedelta, timezone

    confirmation_url = "https://amazon.example.test/gp/buy/thankyou/handlers/display.html"
    executed_actions = []

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
            executed_actions.append(tool_args["action"])
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
    correction = "Do not place this order. Inspect the checkout instead."
    now = datetime.now(timezone.utc)
    if not legacy_resume:
        resume_state["user_message_cursor"] = (now - timedelta(minutes=1)).isoformat()
        resume_state["user_message_cursor_is_task_start"] = True
    rows = [{"id": "cancel-pending-order", "role": "USER", "text": correction,
             "timestamp": (now - timedelta(seconds=30) if legacy_resume else now).isoformat()}] if user_feedback else []

    if legacy_resume:
        from _test_utils import native_browser_start_source
        rows.insert(0, await native_browser_start_source((now - timedelta(minutes=1)).isoformat(), tool_call_id="tool-browser", mode="simulate"))

    pending_poll_calls = 0
    async def poll(_agent_id, since, **kwargs):
        nonlocal pending_poll_calls
        pending_poll_calls += 1
        if initial_poll_failure and pending_poll_calls == 1:
            raise TimeoutError("resume input backend unavailable")
        return [row for row in rows if datetime.fromisoformat(row["timestamp"]) >= since]

    schema = {"fields": [{"name": "order_id", "type": "string",
                          "description": "Amazon order confirmation ID", "required": True}]}
    generation = AsyncMock(return_value=(schema, None, {}))

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
        patch.object(browser_handler, "poll_new_messages", AsyncMock(side_effect=poll)),
        patch("helpers.llm._generate_response_schema_with_rose", generation),
        patch.object(browser_handler, "save_browser_action_message", saved_actions),
        patch.object(browser_handler, "save_browser_assistant_message", AsyncMock()),
        patch.object(browser_handler.SimulatedBrowserRecorder, "create", AsyncMock(return_value=None)),
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
    if user_feedback:
        assert executed_actions == [], "resumed approval executed the queued write before reconsidering real USER feedback"
        assert [message for message in policy.await_args.kwargs["turn_messages"] if message.get("role") == "user"] == [
            {"role": "user", "content": correction}
        ], "resumed policy lost or duplicated the authored correction"
        assert verifier.await_args.kwargs["user_instruction_messages"] == [{"role": "user", "content": correction}]
        assert result["browser_output_schema"] == schema, "unchanged deliverable changed the output contract"
        generation.assert_awaited_once()
        return
    assert executed_actions == ["evaluate"], "ordinary approval omitted its authorized queued action"
    generation.assert_not_awaited()
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


async def test_simulated_browser_persists_post_approval_confirmation_state():
    await _exercise_simulated_browser_pending_approval()


async def test_simulated_browser_user_feedback_invalidates_pending_approved_action():
    await _exercise_simulated_browser_pending_approval(user_feedback=True)


async def test_simulated_browser_resume_poll_miss_disqualifies_pending_write():
    await _exercise_simulated_browser_pending_approval(user_feedback=True, initial_poll_failure=True)


async def test_fresh_simulated_browser_uses_native_manager_input_boundary():
    from datetime import datetime, timezone
    from types import SimpleNamespace
    from domains.spawn_browser_agent_v3 import handler
    from _test_utils import native_browser_start_source

    class StoppedBeforeExternalPricing(Exception):
        pass

    scheduled = datetime(2026, 10, 14, 17, 2, tzinfo=timezone.utc)
    initial_state = None
    with (
        patch.object(handler.activity, "info", return_value=SimpleNamespace(scheduled_time=scheduled)),
        patch.object(handler, "load_config", return_value=SimpleNamespace()),
        patch.object(handler, "get_model_pricing_with_fallback", AsyncMock(side_effect=StoppedBeforeExternalPricing)),
    ):
        try:
            await handler._spawn_browser_agent_activity_v3_simulated(
                user_id="user-1", agent_id="agent-1", goal="Read calendar", tool_call_id="tool-1", task_id="task-1",
                session_id=None, cdp_url=None, is_resume=False, output_schema={"fields": [{"name": "events", "type": "str"}]},
                attachments=None, write_lock_enabled=True, start_url="about:blank", write_lock_resume_state=None,
                system_name="Rose", use_claude_mode=False, gpt_token=None, gpt_account_id=None,
                gpt_token_source=None, gpt_token_pool_id=None, world_model=SimpleNamespace(),
            )
        except StoppedBeforeExternalPricing as error:
            frame = error.__traceback__
            while frame:
                if frame.tb_frame.f_code.co_name == "_spawn_browser_agent_activity_v3_simulated":
                    initial_state = dict(frame.tb_frame.f_locals["instruction_state"])
                frame = frame.tb_next
    assert initial_state is not None
    rows = [await native_browser_start_source("2026-10-14T17:00:00+00:00", mode="simulate"),
            {"id": "prior", "role": "USER", "text": "Previous task", "timestamp": "2026-10-14T16:59:00+00:00"},
            {"id": "actual", "role": "USER", "text": "Use Andy account instead", "timestamp": "2026-10-14T17:01:00+00:00"}]
    async def poll(_agent, since, **options):
        assert options["browser_tool_call_id"] == "tool-1"
        return [row for row in rows if datetime.fromisoformat(row["timestamp"]) > since]
    with patch.object(handler, "poll_new_messages", AsyncMock(side_effect=poll)):
        state = await handler._load_browser_resume_user_instructions("agent-1", initial_state)
    assert state["user_instruction_messages"] == [{"role": "user", "content": "Use Andy account instead"}], "fresh simulated activity dropped actual pre-scheduling feedback"
    assert state["user_message_cursor"] == "2026-10-14T17:00:00+00:00"


async def test_simulated_browser_transient_read_retains_approved_write():
    await _exercise_simulated_browser_pending_approval(initial_poll_failure=True)


async def test_simulated_browser_legacy_resume_reads_feedback_sent_during_pause():
    await _exercise_simulated_browser_pending_approval(user_feedback=True, legacy_resume=True)


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


async def test_runtime_world_model_session_locks_per_scope():
    """A slow create for one tree must not block another tree; one key creates once."""
    import asyncio

    from helpers import world_model_runtime as runtime

    release_slow = asyncio.Event()
    creates: list[str | None] = []

    class _Client:
        async def create_session(self, _name, *, task=None, seed_state=None, session_scope_id=None):
            creates.append(session_scope_id)
            if session_scope_id == "root-slow":
                await release_slow.wait()
            return f"session-{session_scope_id}"

    keys = [("root-slow", "rose-golden"), ("root-fast", "rose-golden")]
    for key in keys:
        runtime._WMH_SESSION_CACHE.pop(key, None)
        runtime._WMH_SESSION_LOCKS.pop(key, None)
    client = _Client()
    try:
        slow = [
            asyncio.create_task(runtime.ensure_world_model_session(client, "rose-golden", "root-slow"))
            for _ in range(3)
        ]
        await asyncio.sleep(0)
        fast = await asyncio.wait_for(
            runtime.ensure_world_model_session(client, "rose-golden", "root-fast"), timeout=5
        )
        assert fast == "session-root-fast"
        assert not any(task.done() for task in slow)
        release_slow.set()
        assert await asyncio.gather(*slow) == ["session-root-slow"] * 3
        assert sorted(creates) == ["root-fast", "root-slow"]
        assert not any(key in runtime._WMH_SESSION_LOCKS for key in keys)
    finally:
        release_slow.set()
        for key in keys:
            runtime._WMH_SESSION_CACHE.pop(key, None)
            runtime._WMH_SESSION_LOCKS.pop(key, None)


async def test_runtime_world_model_session_prioritizes_root_and_delegated_goals():
    from helpers import world_model_runtime as runtime

    requests: list[tuple[str, dict]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode("utf-8"))
        requests.append((str(request.url), body))
        if str(request.url).endswith("/world_models/rose-golden/sessions"):
            return httpx.Response(200, json={"session_id": "session-root-goal"})
        if str(request.url).endswith("/world_models/rose-golden/sessions/session-root-goal/step"):
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

    cache_key = ("agent-root-goal-test", "rose-golden")
    runtime._WMH_SESSION_CACHE.pop(cache_key, None)
    setup_mock_fn(handler)
    try:
        adapter = runtime.WorldModelToolExecutionAdapter(
            mode="simulate",
            client=runtime.WMHHttpClient("https://wmh.example.test"),
            world_model_name="rose-golden",
            agent_id="agent-root-goal-test",
        )
        await adapter.execute(
            "spawn_explore_agent",
            {
                "root_goal": "Raise $5M for Rose Labs",
                "goal": "Check for replies to the latest outreach wave",
            },
            "tool-explore",
            real_executor,
        )
        assert requests[0][1]["task"] == (
            "ROOT OBJECTIVE:\nRaise $5M for Rose Labs\n\n"
            "CURRENT DELEGATION:\nCheck for replies to the latest outreach wave"
        )
        assert requests[0][1]["seed_state"] == {
            "structured": {
                "schema": "rose.runtime_initial_state.v1",
                "root_agent_id": "agent-root-goal-test",
                "root_goal": "Raise $5M for Rose Labs",
            },
            "scratchpad": "",
        }
    finally:
        runtime._WMH_SESSION_CACHE.pop(cache_key, None)
        teardown_mock()


async def test_startup_sms_seeds_wmh_with_demo_root_goal():
    """The first lifecycle notification must not label the shared WMH session as SMS."""
    from helpers import world_model_runtime as runtime

    created: list[dict] = []
    actions: list[str] = []

    class FakeClient:
        async def create_session(self, _model, *, task=None, seed_state=None, session_scope_id=None):
            created.append({"task": task, "seed_state": seed_state, "scope": session_scope_id})
            return "session-startup"

        async def step(self, _model, _session_id, action):
            actions.append(action.name)
            return {"content": '{"success":true}', "is_error": False, "metadata": {}}

    async def forbidden_real(_tool_name, _tool_args, _tool_call_id):
        raise AssertionError("simulate mode must not send an actual SMS")

    root_goal = "Raise me 5m dollars for my company Rose Labs\nNo questions asked"
    cache_key = ("agent-startup-test", "rose-golden")
    runtime._WMH_SESSION_CACHE.pop(cache_key, None)
    try:
        adapter = runtime.WorldModelToolExecutionAdapter(
            mode="simulate",
            client=FakeClient(),
            world_model_name="rose-golden",
            agent_id="agent-startup-test",
        )
        await adapter.execute(
            "notify_sms_event",
            {
                "event_type": "agent_started",
                "agent_id": "agent-startup-test",
                "payload": {"goal": root_goal},
            },
            "startup-sms",
            forbidden_real,
            allow_real_fallback=False,
        )
        await adapter.execute(
            "spawn_browser_agent",
            {"root_goal": root_goal, "goal": "Inspect Brex"},
            "browser-tool",
            forbidden_real,
            allow_real_fallback=False,
        )
        assert created == [
            {
                "task": root_goal,
                "seed_state": {
                    "structured": {
                        "schema": "rose.runtime_initial_state.v1",
                        "root_agent_id": "agent-startup-test",
                        "root_goal": root_goal,
                    },
                    "scratchpad": "",
                },
                "scope": "agent-startup-test",
            }
        ]
        assert actions == ["notify_sms_event", "spawn_browser_agent"]
    finally:
        runtime._WMH_SESSION_CACHE.pop(cache_key, None)


async def test_runtime_world_model_session_is_shared_by_root_agent_tree():
    """Root and real GP children share WMH state; separate roots stay isolated."""
    from domains.call_phone_number.handler import call_phone_number_activity
    from helpers import world_model_runtime as runtime

    created: list[str] = []
    stepped: list[tuple[str, str]] = []

    class FakeClient:
        async def create_session(self, _model, *, task=None, seed_state=None, session_scope_id=None):
            session_id = f"session-{len(created) + 1}"
            created.append(session_id)
            assert seed_state["structured"]["root_agent_id"] == session_scope_id
            return session_id

        async def step(self, _model, session_id, action):
            stepped.append((session_id, action.agent_id))
            return {"content": "ok", "is_error": False}

    async def forbidden_real(_tool_name, _tool_args, _tool_call_id):
        raise AssertionError("simulate mode must not call the real executor")

    keys = [("root-tree-1", "rose-golden"), ("root-tree-2", "rose-golden")]
    for key in keys:
        runtime._WMH_SESSION_CACHE.pop(key, None)
    try:
        for agent_id, scope_id in (
            ("root-tree-1", "root-tree-1"),
            ("gp-child-1", "root-tree-1"),
            ("root-tree-2", "root-tree-2"),
        ):
            adapter = runtime.WorldModelToolExecutionAdapter(
                mode="simulate",
                client=FakeClient(),
                world_model_name="rose-golden",
                agent_id=agent_id,
                session_scope_id=scope_id,
            )
            await adapter.execute(
                "browser_action",
                {"goal": "inspect shared state"},
                f"tool-{agent_id}",
                forbidden_real,
            )

        assert created == ["session-1", "session-2"]
        assert stepped == [
            ("session-1", "root-tree-1"),
            ("session-1", "gp-child-1"),
            ("session-2", "root-tree-2"),
        ]
        # Activities do not inherit workflow contextvars. Resolve the actual
        # phone caller's durable tree without prebinding root tracing context.
        with (
            patch.dict(os.environ, {"WMH_BASE_URL": "https://wmh.example.test", "WMH_MODEL_NAME": "rose-golden"}),
            patch.object(runtime, "WMHHttpClient", return_value=FakeClient()),
            patch.object(runtime.activity, "in_activity", return_value=True),
            patch(
                "providers.fast_cache.client.resolve_agent_fast_mode",
                new=AsyncMock(return_value=(False, "child goal", False, "root-tree-1", "root goal", True)),
            ),
        ):
            await call_phone_number_activity(
                "+15551234567", "ask", {}, "gp-child-phone", "phone-call", world_model_mode="simulate"
            )
        assert created == ["session-1", "session-2"], "an implicit activity caller split the root world"
        assert stepped[-1] == ("session-1", "gp-child-phone")
    finally:
        for key in keys:
            runtime._WMH_SESSION_CACHE.pop(key, None)


async def test_runtime_wmh_http_retries_preserve_native_invocation_identity():
    from helpers import world_model_runtime as runtime

    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={"observation": {"content": "ok"}})

    info = types.SimpleNamespace(
        workflow_id="workflow-root", workflow_run_id="run-1", activity_id="activity-1", attempt=1
    )
    setup_mock_fn(handler)
    try:
        with (
            patch.object(runtime.activity, "in_activity", return_value=True),
            patch.object(runtime.activity, "info", return_value=info),
        ):
            client = runtime.WMHHttpClient("https://wmh.example.test")
            for activity_id, attempt, timestamp in [
                ("activity-1", 1, 100),
                ("activity-1", 2, 200),
                ("activity-2", 1, 300),
            ]:
                info.activity_id, info.attempt = activity_id, attempt
                action = runtime.CanonicalAction(
                    category="browser",
                    name="browser_action",
                    arguments={"query": "check balance"},
                    agent_id="child",
                    tool_call_id="poll",
                    timestamp_ms=timestamp,
                )
                await client.step("rose", "session-1", action)
        identities = [request.headers.get("X-Rose-WMH-Invocation") for request in requests]
        assert identities[0] and identities[0] == identities[1], "native retries lost their operation identity"
        assert identities[2] != identities[0], "a new funding check reused a prior receipt"
        assert [json.loads(request.content)["action"]["arguments"]["timestamp_ms"] for request in requests] == [
            100,
            200,
            300,
        ]
    finally:
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
                "session_scope_id": "agent-seed-test",
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

    from helpers.world_model_runtime import (
        WorldModelToolExecutionAdapter,
        is_world_model_environment_boundary,
    )

    old_mode = os.environ.get("BENCHMARK_WORLD_MODEL_MODE")
    try:
        os.environ["BENCHMARK_WORLD_MODEL_MODE"] = "real"
        adapter = WorldModelToolExecutionAdapter.from_env(
            agent_id="product-agent",
            mode="simulate",
        )
        assert adapter.mode == "simulate"
        assert adapter.should_simulate("web_search") is True
        assert adapter.should_simulate("spawn_explore_agent") is True
        assert adapter.should_simulate("spawn_browser_agent") is True
        assert adapter.should_simulate("browser_action") is True
        assert adapter.should_simulate("spawn_code_agent") is True
        assert adapter.should_simulate("spawn_general_purpose_agent") is False
        assert adapter.should_simulate("spawn_general_purpose_agent_for_each") is False
        assert is_world_model_environment_boundary("spawn_agent") is False
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
        assert is_world_model_environment_boundary("spawn_explore_agent") is True
        assert is_world_model_environment_boundary("spawn_browser_agent") is True
        assert is_world_model_environment_boundary("spawn_code_agent") is True
        assert is_world_model_environment_boundary("spawn_general_purpose_agent") is False
        assert is_world_model_environment_boundary("spawn_general_purpose_agent_for_each") is False
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
        assert simulate.should_simulate("spawn_explore_agent") is True
        assert simulate.should_simulate("spawn_general_purpose_agent") is False
        assert simulate.should_simulate("spawn_general_purpose_agent_for_each") is False

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


def test_served_wmh_parallelizes_same_session_llm_calls_and_keeps_both_steps():
    """Parallel child actions may predict together without losing session writes."""
    import threading
    from concurrent.futures import ThreadPoolExecutor
    from unittest.mock import patch

    from fastapi import FastAPI
    from wmh.core.types import Action
    from wmh.engine.world_model import WorldModel
    from wmh.providers.base import Completion, ProviderConfig, ProviderKind, TokenUsage

    from benchmarks import serve_world_model as server
    from benchmarks.serve_world_model import _install_root_scoped_sessions
    from helpers.world_model_runtime import CanonicalAction

    logged = []

    def log_event(event, **fields):
        logged.append({"event": event, **fields})

    class Retriever:
        def topk(self, state, action, k):
            return []

        def add(self, step):
            pass

    class Provider:
        config = ProviderConfig(kind=ProviderKind.OPENAI, model="gpt-5")

        def __init__(self):
            self.barrier = threading.Barrier(2)
            self.lock = threading.Lock()
            self.active = 0
            self.peak_active = 0

        def complete(self, system, messages, **kwargs):
            with self.lock:
                self.active += 1
                self.peak_active = max(self.peak_active, self.active)
            try:
                try:
                    self.barrier.wait(timeout=3)
                except threading.BrokenBarrierError:
                    pass
                return Completion(
                    text=json.dumps({"output": "sent", "state_note": "delivery recorded"}),
                    usage=TokenUsage(input_tokens=1, output_tokens=1),
                )
            finally:
                with self.lock:
                    self.active -= 1

    with tempfile.TemporaryDirectory() as tmp:
        provider = Provider()
        model = WorldModel(provider, Retriever(), telemetry_root=tmp)
        session = model.new_session(task="Send two independent messages")
        _install_root_scoped_sessions(FastAPI(), "rose", model)
        actions = [
            Action.model_validate(
                CanonicalAction(
                    category="message",
                    name="message_transport_send",
                    arguments={"id": n},
                    agent_id=f"child-{n}",
                    tool_call_id=f"send-{n}",
                ).to_wmh_action()
            )
            for n in (1, 2)
        ]

        def invoke(action, invocation):
            context = getattr(server, "_ROSE_STEP_INVOCATION", None)
            token = context.set(invocation) if context is not None else None
            try:
                return model.step(session.id, action)
            finally:
                if context is not None:
                    context.reset(token)

        with (
            patch("benchmarks.serve_world_model.logger.info", side_effect=log_event),
            ThreadPoolExecutor(max_workers=4) as pool,
        ):
            futures = [
                pool.submit(invoke, action, f"native-activity-{n}")
                for n, action in enumerate(actions)
                for _ in range(2)
            ]
            observations = [future.result(timeout=5) for future in futures]

        assert provider.peak_active == 2, "same-session WMH predictions must overlap"
        assert [observation.content for observation in observations] == ["sent"] * 4
        assert len(session.history) == 2
        assert session.state.scratchpad.count("delivery recorded") == 2
        assert model.session_usage(session.id).total.calls == 2
        for event in ("wmh_step_prediction_started", "wmh_step_committed"):
            assert {
                (entry.get("agent_id"), entry.get("tool_call_id")) for entry in logged if entry["event"] == event
            } == {
                ("child-1", "send-1"),
                ("child-2", "send-2"),
            }, "WMH timing events must retain the canonical agent and tool-call identities"


def test_wmh_rose_provider_shares_one_event_loop_across_parallel_calls():
    """WMH cache batches use asyncio futures, which require one owning event loop."""
    import asyncio
    import threading
    from concurrent.futures import ThreadPoolExecutor

    from wmh.providers.base import Message

    from benchmarks.wmh_rose_provider import RoseUsageAccumulator, RoseWMHProvider
    from providers.rose import RoseResponse

    class Client:
        def __init__(self):
            self.lock = threading.Lock()
            self.active = 0
            self.peak_active = 0
            self.loops = []

        async def collect(self, **kwargs):
            with self.lock:
                self.active += 1
                self.peak_active = max(self.peak_active, self.active)
                self.loops.append(asyncio.get_running_loop())
            try:
                await asyncio.sleep(0.05)
                response = RoseResponse()
                response.content = '{"output":"ok"}'
                response.actual_model = "gpt-5"
                response.usage = {"prompt_tokens": 1, "completion_tokens": 1}
                return response
            finally:
                with self.lock:
                    self.active -= 1

    class NoLeaseProvider(RoseWMHProvider):
        async def _lease_auth(self):
            return None, None

    client = Client()
    provider = NoLeaseProvider(client=client, usage=RoseUsageAccumulator())
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(provider.complete, "SYS", [Message(role="user", content="go")]) for _ in range(2)]
        observations = [future.result(timeout=5) for future in futures]

    assert client.peak_active == 2, "WMH LLM calls must overlap"
    assert len(client.loops) == 2 and client.loops[0] is client.loops[1], (
        "parallel WMH cache lookups must share the event loop that owns their futures"
    )
    assert [observation.text for observation in observations] == ['{"output":"ok"}'] * 2


def test_wmh_parallel_calls_finish_real_fast_cache_batch_lookups():
    """Two served LLM calls must both leave the actual Fast Cache future queue."""
    import itertools
    import threading

    from wmh.providers.base import Message

    from benchmarks.wmh_rose_provider import RoseUsageAccumulator, RoseWMHProvider
    from providers.fast_cache import client as cache_client
    from providers.rose import RoseResponse

    async def fake_fetch(keys):
        return {key: {"hit": False, "value": None, "blobPath": None} for key in keys}

    class Client:
        keys = itertools.count()

        async def collect(self, **kwargs):
            record = await cache_client._cache_get_record_batched(f"wmh-parallel-{next(self.keys)}")
            assert record["hit"] is False
            response = RoseResponse()
            response.content = '{"output":"ok"}'
            response.actual_model = "gpt-5"
            response.usage = {"prompt_tokens": 1, "completion_tokens": 1}
            return response

    class NoLeaseProvider(RoseWMHProvider):
        async def _lease_auth(self):
            return None, None

    provider = NoLeaseProvider(client=Client(), usage=RoseUsageAccumulator())
    finished = []
    errors = []

    def call():
        try:
            finished.append(provider.complete("SYS", [Message(role="user", content="go")]).text)
        except BaseException as exc:
            errors.append(exc)

    with (
        patch.object(cache_client, "_fetch_cache_records_many", fake_fetch),
        patch.object(cache_client, "_GET_BATCH_DELAY_S", 0.05),
    ):
        threads = [threading.Thread(target=call, daemon=True) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=2)
        assert not errors
        assert finished == ['{"output":"ok"}'] * 2, "a WMH cache future was left pending"


def test_served_wmh_rejects_empty_and_truncated_rose_predictions_without_committing():
    """Replay reasoning-only output through Rose and the actual WMH HTTP step."""
    from fastapi.testclient import TestClient
    from wmh.engine.world_model import WorldModel
    from wmh.serving.server import create_app

    from benchmarks.serve_world_model import _install_root_scoped_sessions
    from benchmarks.wmh_rose_provider import RoseUsageAccumulator, RoseWMHProvider
    from providers.rose import RoseResponse

    class Retriever:
        def __init__(self):
            self.added = []

        def topk(self, state, action, k):
            return []

        def add(self, step):
            self.added.append(step)

    class Client:
        content = ""
        finish_reason = "length"

        async def collect(self, **kwargs):
            response = RoseResponse()
            response.content = self.content
            response.actual_model = "qwen-3.8-27b"
            response.usage = {
                "prompt_tokens": 100,
                "completion_tokens": 16384,
                "finish_reason": self.finish_reason,
            }
            return response

    class NoLeaseProvider(RoseWMHProvider):
        async def _lease_auth(self):
            return None, None

    with tempfile.TemporaryDirectory() as tmp:
        client = Client()
        usage = RoseUsageAccumulator()
        retriever = Retriever()
        model = WorldModel(NoLeaseProvider(client=client, usage=usage), retriever, telemetry_root=tmp)
        app = create_app(world_models={"rose": model})
        _install_root_scoped_sessions(app, "rose", model)
        http = TestClient(app, raise_server_exceptions=False)
        session = model.new_session(task="Research investor prospects")
        before = session.model_dump(mode="json")
        url = f"/world_models/rose/sessions/{session.id}/step"
        action = {"kind": "tool_call", "name": "rose.explore.spawn_explore_agent", "arguments": {}}

        for content, finish in [
            ("", "length"),
            (" \n\t", "stop"),
            ('{"output":"unfinished', "length"),
            ('{"output":"","is_error":false,"state_note":"research complete"}', "stop"),
            ('{"output":"","is_error":false}', "stop"),
            ('{"state_note":"research complete"}', "stop"),
        ]:
            client.content, client.finish_reason = content, finish
            response = http.post(url, json={"action": action}, headers={"X-Rose-WMH-Invocation": "native-step-1"})
            assert response.status_code == 500, (
                "blank or truncated WMH completion must not become successful tool output"
            )
            assert session.model_dump(mode="json") == before, "failed prediction changed WMH state"
            assert not retriever.added, "failed prediction polluted retrieval"

        client.content, client.finish_reason = (
            '{"output":"verified prospects","state_note":"research complete"}',
            "stop",
        )
        response = http.post(url, json={"action": action}, headers={"X-Rose-WMH-Invocation": "native-step-1"})
        assert response.status_code == 200
        assert response.json()["observation"]["content"] == "verified prospects"
        assert len(session.history) == len(retriever.added) == 1
        assert "research complete" in session.state.scratchpad
        retry = http.post(url, json={"action": action}, headers={"X-Rose-WMH-Invocation": "native-step-1"})
        assert retry.json() == response.json()
        assert len(session.history) == len(retriever.added) == 1, "HTTP activity retry duplicated a commit"
        client.content = json.dumps(
            {"output": {"status": "declined", "balance_usd": 0}, "is_error": True, "state_note": "no funding deposited"}
        )
        response = http.post(url, json={"action": action})
        assert response.status_code == 200
        observation = response.json()["observation"]
        assert json.loads(observation["content"]) == {"status": "declined", "balance_usd": 0}
        assert observation["is_error"] is True
        assert observation["metadata"]["state_note"] == "no funding deposited"
        assert "no funding deposited" in session.state.scratchpad
        assert len(session.history) == len(retriever.added) == 2
        assert usage.snapshot().calls == 8, "rejected completions must still be metered"
        client.content = '{"output":"sent","state_note":"delivery committed"}'

        def fail_after_commit(event, **fields):
            if event == "wmh_step_committed":
                raise RuntimeError("post-commit telemetry failed")

        with patch("benchmarks.serve_world_model.logger.info", side_effect=fail_after_commit):
            failed_ack = http.post(url, json={"action": action}, headers={"X-Rose-WMH-Invocation": "native-step-3"})
        assert failed_ack.status_code == 500
        assert len(session.history) == 3
        retried_ack = http.post(url, json={"action": action}, headers={"X-Rose-WMH-Invocation": "native-step-3"})
        assert retried_ack.status_code == 200
        assert len(session.history) == 3, "post-commit failure lost its receipt and repeated the mutation"
        assert session.state.scratchpad.count("delivery committed") == 1
        assert usage.snapshot().calls == 9
        client.content = '{"output":"declined","is_error":true,"receipt_id":"payment-1"}'
        response = http.post(url, json={"action": action})
        observation = response.json()["observation"]
        assert observation["is_error"] is True, "production receipt discarded explicit error truth"
        from helpers.world_model_runtime import world_model_observation_to_tool_result

        assert world_model_observation_to_tool_result(observation, simulated=True)["success"] is False
        for text in [
            "A valid observation with {unstructured braces}.",
            json.dumps({"success": False, "output": "declined", "metadata": {"source": "payment"}}),
        ]:
            client.content = text
            response = http.post(url, json={"action": action})
            assert response.status_code == 200
            assert response.json()["observation"]["content"] == text, "the parser discarded production receipt fields"


def test_native_upstream_shared_world_regressions():
    """The recurring WMH gate must exercise the real isolated upstream package."""
    import subprocess

    from benchmarks.experiential_bridge import native_python

    root = Path(__file__).resolve().parents[3]
    result = subprocess.run(
        [
            native_python(),
            "-m",
            "pytest",
            "-c",
            "/dev/null",
            "--confcutdir",
            str(root / "agents/benchmarks"),
            "-o",
            f"cache_dir={root}/.context/native-pytest-cache",
            "-q",
            str(root / "agents/benchmarks/experiential_world_model_checks.py"),
        ],
        cwd=root,
        env={**os.environ, "PYTHONPATH": str(root / "agents")},
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    print(result.stdout.strip())


def test_native_delta_reuses_unchanged_artifact_and_reports_actual_builds():
    from benchmarks.world_model_harness import update_world_model_for_simulation

    with tempfile.TemporaryDirectory() as archive, tempfile.TemporaryDirectory() as out:
        restore = _with_archive_env(archive)
        calls = []
        try:
            _write_golden_bundle("root-native-delta")

            def native(source, output, name, pool, *, bind_only=False):
                calls.append(bind_only)
                (Path(output) / "build.manifest.json").write_text(json.dumps({"engine": "experiential"}))
                (Path(output) / "conformance.native.json").write_text((Path(source) / "conformance.json").read_text())

            with (
                patch.dict(os.environ, {"WMH_ENGINE": "experiential", "WMH_EXPORT_WORKERS": "1"}),
                patch("benchmarks.experiential_bridge.build_native", native),
            ):
                options = dict(
                    output_dir=out,
                    root_agent_ids=["root-native-delta"],
                    name="rose-native-delta",
                    gepa_budget=0,
                    require_conformance=False,
                )
                first = update_world_model_for_simulation(**options)
                second = update_world_model_for_simulation(**options)
                forced = update_world_model_for_simulation(**options, force=True)
            assert calls == [False, True, False], calls
            assert first["build_ran"] is True
            assert second["build_ran"] is False and second["updated_traces"] == 0
            assert forced["build_ran"] is True
            assert Path(second["conformance_path"]).name == "conformance.native.json"
        finally:
            restore()


def test_native_rose_provider_regressions():
    import subprocess
    import sys

    root = Path(__file__).resolve().parents[3]
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-q",
            str(root / "agents/benchmarks/wmh_rose_provider_test.py"),
            str(root / "agents/benchmarks/wmh_structured_cache_test.py"),
            str(root / "agents/benchmarks/wmh_reliability_test.py"),
            str(root / "agents/benchmarks/wmh_validation_recovery_test.py"),
            str(root / "agents/benchmarks/wmh_recording_test.py"),
            str(root / "agents/benchmarks/run_benchmark_wmh_initial_state_test.py"),
            str(root / "agents/benchmarks/wmh_world_clock_test.py"),
            str(root / "agents/benchmarks/wmh_wire_stream_test.py"),
            str(root / "agents/benchmarks/world_model_vendor_test.py"),
            str(root / "agents/benchmarks/wmh_build_cache_test.py"),
            str(root / "agents/benchmarks/wmh_outcome_policy_v4_test.py"),
        ],
        cwd=root,
        env={**os.environ, "PYTHONPATH": str(root / "agents")},
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    print(result.stdout.strip())


def test_simulated_resume_preserves_full_user_instruction_tail():
    from domains.spawn_browser_agent_v3.handler import _simulated_browser_resume_payload
    correction = {"role": "user", "content": "A" * 8000}
    turns = [correction] + [{"role": "tool", "content": "actual result"} for _ in range(30)]
    state = _simulated_browser_resume_payload(
        browser_state={}, action_entries=[], turn_messages=turns, recording_ref=None,
        frame_count=0, visited_urls=[], reasoning_messages=[], action_summary=[],
        world_model_session_id="simulated", total_input_tokens=0, total_output_tokens=0, usage_by_model={},
    )
    assert correction in state["simulated_turn_messages"], "resume discarded or truncated real USER input"


async def run_all_tests():
    print("world model harness blackbox tests:")
    r = BlackboxResult()
    r.record("native_upstream_shared_world_regressions", test_native_upstream_shared_world_regressions)
    r.record(
        "native_delta_reuses_unchanged_artifact_and_reports_actual_builds",
        test_native_delta_reuses_unchanged_artifact_and_reports_actual_builds,
    )
    r.record("native_rose_provider_regressions", test_native_rose_provider_regressions)
    await r.record_async(
        "runtime_wmh_http_retries_preserve_native_invocation_identity",
        test_runtime_wmh_http_retries_preserve_native_invocation_identity,
    )
    r.record(
        "served_wmh_rejects_empty_and_truncated_rose_predictions_without_committing",
        test_served_wmh_rejects_empty_and_truncated_rose_predictions_without_committing,
    )
    r.record(
        "served_wmh_parallelizes_same_session_llm_calls_and_keeps_both_steps",
        test_served_wmh_parallelizes_same_session_llm_calls_and_keeps_both_steps,
    )
    r.record(
        "wmh_rose_provider_shares_one_event_loop_across_parallel_calls",
        test_wmh_rose_provider_shares_one_event_loop_across_parallel_calls,
    )


    await r.record_async("simulated_browser_transient_read_retains_approved_write", test_simulated_browser_transient_read_retains_approved_write)
    await r.record_async("fresh_simulated_browser_uses_native_manager_input_boundary", test_fresh_simulated_browser_uses_native_manager_input_boundary)
    await r.record_async("simulated_browser_publishes_native_task_start_for_resume_scope", test_simulated_browser_publishes_native_task_start_for_resume_scope)
    await r.record_async("simulated_browser_resume_poll_miss_disqualifies_pending_write", test_simulated_browser_resume_poll_miss_disqualifies_pending_write)
    await r.record_async("simulated_browser_unconfirmed_input_blocks_actual_click_transition", test_simulated_browser_unconfirmed_input_blocks_actual_click_transition)
    await r.record_async("simulated_browser_failed_schema_keeps_known_usage", test_simulated_browser_failed_schema_keeps_known_usage)
    await r.record_async("simulated_browser_instruction_poll_recovers_before_actor", test_simulated_browser_instruction_poll_recovers_before_actor)
    await r.record_async("simulated_browser_failed_schema_retries_at_completion", test_simulated_browser_failed_schema_retries_at_completion)
    await r.record_async("simulated_browser_permanent_schema_failure_exits_without_iteration_burn", test_simulated_browser_permanent_schema_failure_exits_without_iteration_burn)
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
        test_bundle_signature_ignores_plaintext_public_manifest_and_tracks_unrelated_orphan,
    )
    r.record(
        "bundle_signature_r2_rejects_enumerated_ciphertext_without_metadata",
        test_bundle_signature_r2_tracks_enumerated_ciphertext_without_metadata,
    )
    r.record(
        "fake_r2_head_preserves_metadata_only_contract",
        test_fake_r2_head_preserves_metadata_only_contract,
    )
    r.record(
        "bundle_signature_and_refs_read_metadata_only_under_r2",
        test_bundle_signature_and_refs_read_metadata_only_under_r2,
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
        "index_refresh_parallel_embeddings_match_in_process",
        test_index_refresh_parallel_embeddings_match_in_process,
    )
    r.record(
        "partial_run_recovers_completed_tool_results_from_llm_contexts",
        test_partial_run_recovers_completed_tool_results_from_llm_contexts,
    )
    r.record(
        "partial_context_growth_preserves_observed_tool_result_order",
        test_partial_context_growth_preserves_observed_tool_result_order,
    )
    r.record(
        "index_records_survive_unicode_line_breaks_in_observations",
        test_index_records_survive_unicode_line_breaks_in_observations,
    )
    r.record(
        "update_world_model_skips_bundles_that_fail_export",
        test_update_world_model_skips_bundles_that_fail_export,
    )
    r.record(
        "corpus_screening_admits_only_exportable_bundles_and_caches_verdicts",
        test_corpus_screening_admits_only_exportable_bundles_and_caches_verdicts,
    )
    r.record(
        "corpus_screening_retries_transient_r2_throttles",
        test_corpus_screening_retries_transient_r2_throttles,
    )
    r.record(
        "bundle_signature_retries_transient_r2_throttles",
        test_bundle_signature_retries_transient_r2_throttles,
    )
    r.record(
        "export_worker_filters_bundles_without_completed_results",
        test_export_worker_filters_bundles_without_completed_results,
    )
    r.record(
        "export_worker_retries_transient_r2_stream_failures",
        test_export_worker_retries_transient_r2_stream_failures,
    )
    r.record(
        "world_model_bundle_cap_preserves_existing_index_entries",
        test_world_model_bundle_cap_preserves_existing_index_entries,
    )
    r.record(
        "demo_filter_purges_previously_indexed_steps_without_ingestion_failure",
        test_demo_filter_purges_previously_indexed_steps_without_ingestion_failure,
    )
    r.record(
        "grounded_export_uses_real_browser_results_and_excludes_unavailable_llm_fallbacks",
        test_grounded_export_uses_real_browser_results_and_excludes_unavailable_llm_fallbacks,
    )
    r.record(
        "grounded_export_and_conformance_suite_cover_100_real_terminal_tool_results",
        test_grounded_export_and_conformance_suite_cover_100_real_terminal_tool_results,
    )
    r.record(
        "grounded_export_preserves_each_real_tool_call_measured_duration",
        test_grounded_export_preserves_each_real_tool_call_measured_duration,
    )
    r.record(
        "public_export_redacts_root_goal_and_scratchpad_secrets",
        test_public_export_redacts_root_goal_and_scratchpad_secrets,
    )
    r.record(
        "conformance_suite_examples_stay_exact_public_corpus_records",
        test_conformance_suite_examples_stay_exact_public_corpus_records,
    )
    r.record(
        "conformance_suite_fails_closed_on_unredacted_secrets",
        test_conformance_suite_fails_closed_on_unredacted_secrets,
    )
    await r.record_async(
        "prediction_conformance_replays_expected_observations_and_fails_on_low_fidelity",
        test_prediction_conformance_replays_expected_observations_and_fails_on_low_fidelity,
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
        "native_wmh_ingestion_preserves_completed_pairs_with_equal_or_regressing_clocks",
        test_native_wmh_ingestion_preserves_completed_pairs_with_equal_or_regressing_clocks,
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
    await r.record_async(
        "demo_wmh_cache_reuses_equivalent_actions_across_run_ids",
        test_demo_wmh_cache_reuses_equivalent_actions_across_run_ids,
    )
    r.record(
        "world_model_observation_latency_normalization_matches_runtime_helper",
        test_world_model_observation_latency_normalization_matches_runtime_helper,
    )
    r.record(
        "world_model_observation_ignores_non_object_metadata",
        test_world_model_observation_ignores_non_object_metadata,
    )
    r.record(
        "world_model_observation_ignores_non_finite_latency",
        test_world_model_observation_ignores_non_finite_latency,
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
        "world_model_observation_unwraps_archived_prod_result_shape",
        test_world_model_observation_unwraps_archived_prod_result_shape,
    )
    r.record(
        "world_model_observation_preserves_archived_browser_state_shape",
        test_world_model_observation_preserves_archived_browser_state_shape,
    )
    r.record(
        "world_model_observation_unwraps_nested_output_envelope",
        test_world_model_observation_unwraps_nested_output_envelope,
    )
    r.record(
        "world_model_observation_keeps_error_text_for_temporal_messages",
        test_world_model_observation_keeps_error_text_for_temporal_messages,
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
    await r.record_async("simulated_browser_preserves_active_user_input_without_narration", test_simulated_browser_preserves_active_user_input_without_narration)
    await r.record_async("simulated_browser_preserves_user_input_queued_before_activity_execution", test_simulated_browser_preserves_user_input_queued_before_activity_execution)
    r.record("simulated_resume_preserves_full_user_instruction_tail", test_simulated_resume_preserves_full_user_instruction_tail)
    await r.record_async(
        "wmh_http_client_matches_upstream_serving_routes", test_wmh_http_client_matches_upstream_serving_routes
    )
    await r.record_async(
        "runtime_wmh_retirement_uses_exact_session_and_preserves_join_receipt",
        test_runtime_wmh_retirement_uses_exact_session_and_preserves_join_receipt,
    )
    await r.record_async(
        "runtime_world_clock_long_polls_waits_and_skips_without_a_world",
        test_runtime_world_clock_long_polls_waits_and_skips_without_a_world,
    )
    await r.record_async(
        "runtime_world_time_reads_the_agent_clock_or_reports_no_world",
        test_runtime_world_time_reads_the_agent_clock_or_reports_no_world,
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
        "runtime_world_model_session_prioritizes_root_and_delegated_goals",
        test_runtime_world_model_session_prioritizes_root_and_delegated_goals,
    )
    await r.record_async(
        "runtime_world_model_session_locks_per_scope",
        test_runtime_world_model_session_locks_per_scope,
    )
    await r.record_async(
        "startup_sms_seeds_wmh_with_demo_root_goal",
        test_startup_sms_seeds_wmh_with_demo_root_goal,
    )
    await r.record_async(
        "runtime_world_model_session_is_shared_by_root_agent_tree",
        test_runtime_world_model_session_is_shared_by_root_agent_tree,
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
        "simulated_browser_user_feedback_invalidates_pending_approved_action",
        test_simulated_browser_user_feedback_invalidates_pending_approved_action,
    )
    await r.record_async(
        "simulated_browser_legacy_resume_reads_feedback_sent_during_pause",
        test_simulated_browser_legacy_resume_reads_feedback_sent_during_pause,
    )
    await r.record_async(
        "simulated_provider_activities_call_wmh_instead_of_live_services",
        test_simulated_provider_activities_call_wmh_instead_of_live_services,
    )
    r.record(
        "wmh_parallel_calls_finish_real_fast_cache_batch_lookups",
        test_wmh_parallel_calls_finish_real_fast_cache_batch_lookups,
    )
    await r.record_async(
        "simulated_payment_approval_finishes_pending_tool",
        test_simulated_payment_card_approval_finishes_pending_tool_for_resumed_policy,
    )
    await r.record_async(
        "runtime_world_time_nonobject_clock_is_unavailable",
        test_runtime_world_time_nonobject_clock_is_unavailable,
    )
    await r.record_async(
        "runtime_world_time_retries_then_fails_instead_of_wall_clock",
        test_runtime_world_time_retries_then_fails_instead_of_wall_clock,
    )
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    import asyncio

    asyncio.run(run_all_tests())
