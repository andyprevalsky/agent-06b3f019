"""Blackbox tests for encrypted durable trace archive helpers."""

import base64
import gzip
import hashlib
import json
import os
import tempfile
from pathlib import Path

import structlog.contextvars
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from _test_utils import BlackboxResult, teardown_mock


def _decrypt(ciphertext: bytes, metadata: dict) -> bytes:
    key = hashlib.sha256(b"rose-trace-archive-dev-key").digest()
    nonce = base64.b64decode(metadata["nonce_b64"])
    plaintext = AESGCM(key).decrypt(nonce, ciphertext, metadata["aad"].encode("utf-8"))
    if metadata["compression"] == "gzip":
        plaintext = gzip.decompress(plaintext)
    return plaintext


def _with_archive_env(tmp: str):
    import helpers.trace_archive as trace_archive

    old_root = trace_archive._LOCAL_ROOT
    old_env = {key: os.environ.get(key) for key in ["TRACE_ARCHIVE_ENABLED", "TRACE_ARCHIVE_BACKEND"]}
    trace_archive._LOCAL_ROOT = Path(tmp)
    os.environ["TRACE_ARCHIVE_ENABLED"] = "1"
    os.environ["TRACE_ARCHIVE_BACKEND"] = "local"

    def restore():
        trace_archive._LOCAL_ROOT = old_root
        for key, value in old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    return restore


def test_encrypt_json_gzip_roundtrip():
    from helpers.trace_archive import encrypt_artifact

    body = json.dumps({"hello": "world", "n": 3}).encode("utf-8")
    encrypted = encrypt_artifact(body, path="llm/demo.json.gz.enc", content_type="application/json")
    assert encrypted is not None
    ciphertext, metadata = encrypted
    assert metadata["compression"] == "gzip"
    assert metadata["encryption"] == "aes-256-gcm"
    assert metadata["plaintext_sha256"] == hashlib.sha256(body).hexdigest()
    assert metadata["ciphertext_sha256"] == hashlib.sha256(ciphertext).hexdigest()
    assert metadata["auth_tag_b64"]
    assert _decrypt(ciphertext, metadata) == body


def test_encrypt_media_skips_gzip():
    from helpers.trace_archive import encrypt_artifact

    body = b"\x00\x00\x00\x18ftypmp42already-compressed"
    encrypted = encrypt_artifact(body, path="media/browser/run.mp4", content_type="video/mp4")
    assert encrypted is not None
    ciphertext, metadata = encrypted
    assert metadata["compression"] == "none"
    assert _decrypt(ciphertext, metadata) == body


def test_local_store_writes_ciphertext_and_metadata():
    from helpers.trace_archive import archive_json, decrypt_and_validate_artifact, read_local_artifact

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(tmp)
        try:
            result = archive_json(root_agent_id="agent-1", path="llm/demo.json.gz.enc", payload={"ok": True})
            assert result is not None
            artifact_path = Path(result["ref"])
            assert artifact_path.exists()
            metadata = json.loads(Path(str(artifact_path) + ".meta.json").read_text())
            assert json.loads(decrypt_and_validate_artifact(artifact_path.read_bytes(), metadata).decode("utf-8")) == {"ok": True}
            stored = read_local_artifact(root_agent_id="agent-1", path="llm/demo.json.gz.enc")
            assert stored is not None
            stored_ciphertext, stored_metadata = stored
            assert stored_metadata == metadata
            assert json.loads(decrypt_and_validate_artifact(stored_ciphertext, stored_metadata).decode("utf-8")) == {"ok": True}
        finally:
            restore()


def test_local_store_gold_io_validates_integrity():
    from helpers.trace_archive import archive_bytes, decrypt_and_validate_artifact, read_local_artifact

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(tmp)
        try:
            body = b'{"kind":"gold","rows":[{"id":"row-1","value":"exact"}]}\n'
            result = archive_bytes(
                root_agent_id="gold-agent",
                path="db/gold.fixture.json.gz.enc",
                body=body,
                content_type="application/json",
            )
            assert result is not None
            stored = read_local_artifact(root_agent_id="gold-agent", path="db/gold.fixture.json.gz.enc")
            assert stored is not None
            ciphertext, metadata = stored
            assert metadata == result["metadata"]
            assert decrypt_and_validate_artifact(ciphertext, metadata) == body
            assert ciphertext != body

            tampered = bytearray(ciphertext)
            tampered[0] ^= 0xFF
            try:
                decrypt_and_validate_artifact(bytes(tampered), metadata)
                raise AssertionError("tampered ciphertext should be rejected")
            except ValueError as exc:
                assert "ciphertext SHA-256 mismatch" in str(exc)
        finally:
            restore()


def test_observability_writes_dev_dump_and_archive_updates():
    import helpers.observability as observability

    with tempfile.TemporaryDirectory() as tmp:
        restore_archive = _with_archive_env(str(Path(tmp) / "archive"))
        old_dump_root = observability._DUMP_ROOT
        old_is_prod = observability._IS_PRODUCTION
        try:
            observability._DUMP_ROOT = Path(tmp) / "llm-dumps"
            observability._IS_PRODUCTION = False
            path = observability.dump_llm_context(
                "unit_call",
                [{"role": "user", "content": "persist me"}],
                agent_id="agent-1",
                model="rose-labs/rose-1-lite",
            )
            assert path is not None
            assert Path(path).exists()
            observability.update_llm_dump(path, output={"text": "done"})
            archive_root = Path(tmp) / "archive" / "agent-1"
            assert len(list((archive_root / "llm").glob("*.enc"))) == 1
            assert len(list((archive_root / "llm-updates").glob("*.enc"))) == 1
            updated = json.loads(Path(path).read_text())
            assert updated["output"]["text"] == "done"
        finally:
            observability._DUMP_ROOT = old_dump_root
            observability._IS_PRODUCTION = old_is_prod
            restore_archive()


def test_prod_worker_posts_encrypted_artifact_to_backend():
    import helpers.trace_archive as trace_archive

    old_env = {
        "FLY_APP_NAME": os.environ.get("FLY_APP_NAME"),
        "TRACE_ARCHIVE_ENABLED": os.environ.get("TRACE_ARCHIVE_ENABLED"),
        "TRACE_ARCHIVE_BACKEND": os.environ.get("TRACE_ARCHIVE_BACKEND"),
        "TRACE_ARCHIVE_ENCRYPTION_KEY_B64": os.environ.get("TRACE_ARCHIVE_ENCRYPTION_KEY_B64"),
        "BACKEND_API_URL": os.environ.get("BACKEND_API_URL"),
        "BACKEND_API_KEY": os.environ.get("BACKEND_API_KEY"),
    }
    old_client = trace_archive.httpx.Client
    captured_posts = []

    class _Response:
        status_code = 200
        text = ""

        @staticmethod
        def json():
            return {"ref": "r2://bucket/trace-archive/prod-agent/llm/prod.json.gz.enc"}

    class _Client:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, url, headers, json):
            captured_posts.append({"url": url, "headers": headers, "json": json})
            return _Response()

    try:
        os.environ["FLY_APP_NAME"] = "rose-agent-prod"
        os.environ["TRACE_ARCHIVE_ENABLED"] = "1"
        os.environ["TRACE_ARCHIVE_BACKEND"] = "r2"
        os.environ["TRACE_ARCHIVE_ENCRYPTION_KEY_B64"] = base64.b64encode(b"1" * 32).decode("ascii")
        os.environ["BACKEND_API_URL"] = "https://backend.example.test"
        os.environ["BACKEND_API_KEY"] = "test-api-key"
        trace_archive.httpx.Client = _Client

        result = trace_archive.archive_json(root_agent_id="prod-agent", path="llm/prod.json.gz.enc", payload={"prod": True})
        assert result is not None
        assert result["ref"].startswith("r2://bucket/")
        assert len(captured_posts) == 1
        body = captured_posts[0]["json"]
        assert body["rootAgentId"] == "prod-agent"
        assert body["path"] == "llm/prod.json.gz.enc"
        assert body["metadata"]["compression"] == "gzip"
        assert body["metadata"]["auth_tag_b64"]
        assert captured_posts[0]["headers"]["X-API-Key"] == "test-api-key"
    finally:
        trace_archive.httpx.Client = old_client
        for key, value in old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        teardown_mock()


async def test_fast_cache_write_archives_without_replay_reads_or_backend_success():
    import providers.fast_cache.client as fast_cache_client
    from helpers.trace_archive import decrypt_and_validate_artifact, read_local_artifact

    class _Response:
        status_code = 503

        @staticmethod
        def json():
            return {"error": "backend unavailable"}

    class _Client:
        is_closed = False

        async def post(self, *args, **kwargs):
            return _Response()

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(tmp)
        old_client = fast_cache_client._client
        token = structlog.contextvars.bind_contextvars(agent_id="agent-fast-cache", span_id="span-fast-cache")
        try:
            fast_cache_client._client = _Client()
            ok = await fast_cache_client.cache_set(
                "provider-request-key",
                "browser_http",
                "goal-hash",
                {"request": {"url": "https://example.com"}, "response": {"status": 200}},
            )
            assert ok is False
            expected_hash = hashlib.sha256(b"provider-request-key").hexdigest()
            stored = read_local_artifact(
                root_agent_id="agent-fast-cache",
                path=f"provider/fast-cache/browser_http/{expected_hash}.json.gz.enc",
            )
            assert stored is not None
            ciphertext, metadata = stored
            payload = json.loads(decrypt_and_validate_artifact(ciphertext, metadata).decode("utf-8"))
            assert payload["key"] == "provider-request-key"
            assert payload["kind"] == "browser_http"
            assert payload["goal_hash"] == "goal-hash"
            assert payload["span_id"] == "span-fast-cache"
            assert payload["value"]["request"]["url"] == "https://example.com"
            assert payload["value"]["response"]["status"] == 200
        finally:
            structlog.contextvars.reset_contextvars(**token)
            fast_cache_client._client = old_client
            restore()


async def run_all_tests():
    print("trace archive blackbox tests:")
    r = BlackboxResult()
    r.record("encrypt_json_gzip_roundtrip", test_encrypt_json_gzip_roundtrip)
    r.record("encrypt_media_skips_gzip", test_encrypt_media_skips_gzip)
    r.record("local_store_writes_ciphertext_and_metadata", test_local_store_writes_ciphertext_and_metadata)
    r.record("local_store_gold_io_validates_integrity", test_local_store_gold_io_validates_integrity)
    r.record("observability_writes_dev_dump_and_archive_updates", test_observability_writes_dev_dump_and_archive_updates)
    r.record("prod_worker_posts_encrypted_artifact_to_backend", test_prod_worker_posts_encrypted_artifact_to_backend)
    await r.record_async("fast_cache_write_archives_without_replay_reads_or_backend_success", test_fast_cache_write_archives_without_replay_reads_or_backend_success)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    import asyncio

    asyncio.run(run_all_tests())
