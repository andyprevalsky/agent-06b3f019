"""Blackbox tests for encrypted durable trace archive helpers."""

import asyncio
import warnings
import base64
import gzip
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait
from pathlib import Path

import structlog.contextvars
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from _test_utils import BlackboxResult, teardown_mock


def _decrypt(ciphertext: bytes, metadata: dict) -> bytes:
    # Resolve the key the same way the module does: agents/.env (loaded by
    # _test_utils) may set a real TRACE_ARCHIVE_ENCRYPTION_KEY_B64, in which
    # case encrypt_artifact uses it instead of the hard-coded dev key.
    from helpers.trace_archive import _encryption_key

    key = _encryption_key() or hashlib.sha256(b"rose-trace-archive-dev-key").digest()
    nonce = base64.b64decode(metadata["nonce_b64"])
    plaintext = AESGCM(key).decrypt(nonce, ciphertext, metadata["aad"].encode("utf-8"))
    if metadata["compression"] == "gzip":
        plaintext = gzip.decompress(plaintext)
    return plaintext


def _with_archive_env(tmp: str):
    import helpers.trace_archive as trace_archive

    old_root = trace_archive._LOCAL_ROOT
    old_env = {
        key: os.environ.get(key)
        for key in [
            "TRACE_ARCHIVE_ENABLED",
            "TRACE_ARCHIVE_BACKEND",
            "FLY_APP_NAME",
            "ENVIRONMENT",
        ]
    }
    trace_archive._LOCAL_ROOT = Path(tmp)
    os.environ["TRACE_ARCHIVE_ENABLED"] = "1"
    os.environ["TRACE_ARCHIVE_BACKEND"] = "local"
    os.environ.pop("FLY_APP_NAME", None)
    os.environ.pop("ENVIRONMENT", None)

    def restore():
        trace_archive._LOCAL_ROOT = old_root
        for key, value in old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    return restore


def _without_archive_key():
    """Pin the dev-derived key so _decrypt's hardcoded key always matches."""
    old_key = os.environ.get("TRACE_ARCHIVE_ENCRYPTION_KEY_B64")
    os.environ.pop("TRACE_ARCHIVE_ENCRYPTION_KEY_B64", None)

    def restore():
        if old_key is None:
            os.environ.pop("TRACE_ARCHIVE_ENCRYPTION_KEY_B64", None)
        else:
            os.environ["TRACE_ARCHIVE_ENCRYPTION_KEY_B64"] = old_key

    return restore


def test_encrypt_json_gzip_roundtrip():
    from helpers.trace_archive import encrypt_artifact

    restore = _without_archive_key()
    try:
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
    finally:
        restore()


def test_encrypt_media_skips_gzip():
    from helpers.trace_archive import encrypt_artifact

    restore = _without_archive_key()
    try:
        body = b"\x00\x00\x00\x18ftypmp42already-compressed"
        encrypted = encrypt_artifact(body, path="media/browser/run.mp4", content_type="video/mp4")
        assert encrypted is not None
        ciphertext, metadata = encrypted
        assert metadata["compression"] == "none"
        assert _decrypt(ciphertext, metadata) == body
    finally:
        restore()


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
            assert json.loads(decrypt_and_validate_artifact(artifact_path.read_bytes(), metadata).decode("utf-8")) == {
                "ok": True
            }
            stored = read_local_artifact(root_agent_id="agent-1", path="llm/demo.json.gz.enc")
            assert stored is not None
            stored_ciphertext, stored_metadata = stored
            assert stored_metadata == metadata
            assert json.loads(decrypt_and_validate_artifact(stored_ciphertext, stored_metadata).decode("utf-8")) == {
                "ok": True
            }
        finally:
            restore()


def test_local_store_publishes_metadata_atomically():
    import helpers.trace_archive as trace_archive

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(tmp)
        target = Path(tmp) / "agent-atomic" / "llm" / "atomic.json.gz.enc"
        meta = Path(str(target) + ".meta.json")
        original_open = Path.open
        metadata_opened = threading.Event()
        release_metadata_write = threading.Event()
        errors = []

        def blocking_open(path: Path, *args, **kwargs):
            handle = original_open(path, *args, **kwargs)
            mode = args[0] if args else kwargs.get("mode", "r")
            if "w" in mode and path.name.startswith(meta.name):
                metadata_opened.set()
                # Deadlock guard only; the main thread releases right after its check.
                if not release_metadata_write.wait(timeout=30):
                    handle.close()
                    raise TimeoutError("metadata write was not released")
            return handle

        def write_artifact():
            try:
                trace_archive._write_local("agent-atomic", "llm/atomic.json.gz.enc", b"ciphertext", {"ok": True})
            except BaseException as exc:
                errors.append(exc)

        Path.open = blocking_open
        writer = threading.Thread(target=write_artifact)
        try:
            writer.start()
            # Wait for the open itself, not a fixed window: a loaded host can take
            # seconds to schedule the writer. A writer that exits without opening
            # the metadata stops the wait; the cap only prevents a hung test.
            deadline = time.monotonic() + 30
            while not metadata_opened.wait(timeout=0.05) and writer.is_alive() and time.monotonic() < deadline:
                pass
            assert metadata_opened.is_set(), "metadata writer never opened its output"
            assert not meta.exists(), "final metadata path became visible before its JSON was complete"
        finally:
            release_metadata_write.set()
            writer.join(timeout=30)
            Path.open = original_open
            restore()

        assert not writer.is_alive(), "metadata writer did not finish"
        assert not errors, errors
        assert json.loads(meta.read_text()) == {"ok": True}


def test_artifact_transaction_recovers_crash_between_pair_replacements():
    import helpers.trace_archive as trace_archive

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(tmp)
        target = Path(tmp) / "agent-recovery" / "llm" / "recover.json.gz.enc"
        meta_path = target.with_suffix(target.suffix + ".meta.json")
        transaction_path = trace_archive._artifact_transaction_path(target)
        old_ciphertext = b"old-ciphertext"
        new_ciphertext = b"new-ciphertext"
        old_metadata = {"ciphertext_sha256": hashlib.sha256(old_ciphertext).hexdigest()}
        new_metadata = {"ciphertext_sha256": hashlib.sha256(new_ciphertext).hexdigest()}
        original_replace = Path.replace
        interrupted = False

        def interrupt_metadata_replace(source: Path, destination: Path):
            nonlocal interrupted
            if Path(destination) == meta_path and not interrupted:
                interrupted = True
                raise OSError("simulated crash between pair replacements")
            return original_replace(source, destination)

        try:
            trace_archive._write_local("agent-recovery", "llm/recover.json.gz.enc", old_ciphertext, old_metadata)
            Path.replace = interrupt_metadata_replace
            try:
                trace_archive._write_local(
                    "agent-recovery",
                    "llm/recover.json.gz.enc",
                    new_ciphertext,
                    new_metadata,
                )
            except OSError as exc:
                assert "simulated crash" in str(exc)
            else:
                raise AssertionError("pair publication should have been interrupted")
            finally:
                Path.replace = original_replace

            assert transaction_path.exists(), "recoverable transaction was removed after interrupted commit"
            stored = trace_archive.read_local_artifact(
                root_agent_id="agent-recovery",
                path="llm/recover.json.gz.enc",
            )
            assert stored == (new_ciphertext, new_metadata)
            assert not transaction_path.exists(), "successful recovery did not clear the transaction"
            assert target.read_bytes() == new_ciphertext
            assert json.loads(meta_path.read_text()) == new_metadata
        finally:
            Path.replace = original_replace
            restore()


def test_local_artifact_listing_hides_transaction_and_temporary_files():
    from helpers.trace_archive import list_local_artifact_paths

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(tmp)
        bundle = Path(tmp) / "agent-listing" / "llm"
        bundle.mkdir(parents=True)
        try:
            (bundle / "visible.json.gz.enc").write_bytes(b"ciphertext")
            (bundle / "visible.json.gz.enc.meta.json").write_text("{}")
            (bundle / "trace.transaction.json").write_bytes(b"valid-artifact")
            (bundle / "trace.transaction.json.meta.json").write_text("{}")
            (bundle / "hidden.json.gz.enc.transaction").write_bytes(b"transaction")
            (bundle / "hidden.json.gz.enc.transaction.123.tmp").write_bytes(b"temporary")

            assert list_local_artifact_paths("agent-listing") == [
                "llm/trace.transaction.json",
                "llm/visible.json.gz.enc",
            ]
        finally:
            restore()


def test_artifact_lock_pool_is_bounded():
    import helpers.trace_archive as trace_archive

    assert trace_archive._ARTIFACT_LOCK_STRIPES == 256
    assert len(trace_archive._ARTIFACT_WRITE_LOCKS) == trace_archive._ARTIFACT_LOCK_STRIPES
    indexes = {
        trace_archive._artifact_lock_index(Path(f"/tmp/trace-archive/agent-{idx}/artifact.enc"))
        for idx in range(10_000)
    }
    assert indexes
    assert max(indexes) < trace_archive._ARTIFACT_LOCK_STRIPES


def test_cross_process_reader_waits_for_matched_artifact_pair():
    import helpers.trace_archive as trace_archive

    with tempfile.TemporaryDirectory() as tmp:
        archive_root = Path(tmp) / "archive"
        restore = _with_archive_env(str(archive_root))
        target = archive_root / "agent-process" / "llm" / "shared.json.gz.enc"
        marker = Path(tmp) / "ciphertext-published"
        release = Path(tmp) / "release-writer"
        ciphertext = b"cross-process-ciphertext"
        expected_sha = hashlib.sha256(ciphertext).hexdigest()
        worker_script = r"""
import hashlib
import sys
import time
from pathlib import Path

import helpers.trace_archive as trace_archive

target = Path(sys.argv[1])
marker = Path(sys.argv[2])
release = Path(sys.argv[3])
original_replace = Path.replace

def blocking_replace(source, destination):
    result = original_replace(source, destination)
    if Path(destination) == target:
        marker.write_text("ready", encoding="utf-8")
        deadline = time.monotonic() + 5
        while not release.exists():
            if time.monotonic() >= deadline:
                raise TimeoutError("reader never released cross-process writer")
            time.sleep(0.01)
    return result

Path.replace = blocking_replace
ciphertext = b"cross-process-ciphertext"
trace_archive._write_local(
    "agent-process",
    "llm/shared.json.gz.enc",
    ciphertext,
    {"ciphertext_sha256": hashlib.sha256(ciphertext).hexdigest()},
)
"""
        env = os.environ.copy()
        env["TRACE_ARCHIVE_LOCAL_ROOT"] = str(archive_root)
        worker = subprocess.Popen(
            [sys.executable, "-c", worker_script, str(target), str(marker), str(release)],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        reader_started = threading.Event()
        reader_finished = threading.Event()
        result = []
        errors = []
        reader_was_started = False

        def read_artifact():
            reader_started.set()
            try:
                result.append(
                    trace_archive.read_local_artifact(
                        root_agent_id="agent-process",
                        path="llm/shared.json.gz.enc",
                    )
                )
            except BaseException as exc:
                errors.append(exc)
            finally:
                reader_finished.set()

        reader = threading.Thread(target=read_artifact)
        try:
            deadline = time.monotonic() + 10
            while not marker.exists() and worker.poll() is None and time.monotonic() < deadline:
                time.sleep(0.01)
            worker_stdout = ""
            worker_stderr = ""
            if worker.poll() is not None:
                worker_stdout, worker_stderr = worker.communicate(timeout=1)
            assert marker.exists(), (
                "writer never paused between ciphertext and metadata publication "
                f"(returncode={worker.returncode}, stdout={worker_stdout!r}, stderr={worker_stderr!r})"
            )

            reader.start()
            reader_was_started = True
            assert reader_started.wait(timeout=1), "reader thread did not start"
            assert not reader_finished.wait(timeout=0.2), "reader bypassed the cross-process artifact lock"
            release.touch()
            worker.wait(timeout=5)
            reader.join(timeout=5)
            worker_stdout, worker_stderr = worker.communicate(timeout=1)
        finally:
            release.touch(exist_ok=True)
            if worker.poll() is None:
                worker.terminate()
                try:
                    worker.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    worker.kill()
                    worker.wait(timeout=5)
            if reader_was_started:
                reader.join(timeout=5)
            restore()

        assert worker.returncode == 0, f"stdout={worker_stdout!r}, stderr={worker_stderr!r}"
        assert not reader.is_alive(), "reader stayed blocked after writer released the lock"
        assert not errors, errors
        assert result == [(ciphertext, {"ciphertext_sha256": expected_sha})]


def test_outbox_drain_does_not_delete_newer_generation():
    import helpers.trace_archive as trace_archive

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(str(Path(tmp) / "archive"))
        original_post = trace_archive._post_backend_artifact
        path = "llm/retry.json.gz.enc"
        old_ciphertext = b"old-ciphertext"
        new_ciphertext = b"new-ciphertext"
        old_metadata = {"ciphertext_sha256": hashlib.sha256(old_ciphertext).hexdigest()}
        new_metadata = {"ciphertext_sha256": hashlib.sha256(new_ciphertext).hexdigest()}

        def post_then_replace(**kwargs):
            assert kwargs["ciphertext"] == old_ciphertext
            trace_archive._write_outbox("agent-generation", path, new_ciphertext, new_metadata)
            return "r2://bucket/retry"

        try:
            trace_archive._write_outbox("agent-generation", path, old_ciphertext, old_metadata)
            trace_archive._post_backend_artifact = post_then_replace
            trace_archive._drain_backend_outbox()

            target = trace_archive._outbox_root() / "agent-generation" / path
            with trace_archive._artifact_lock(target):
                stored = trace_archive._read_artifact_pair_unlocked(target)
            assert stored == (new_ciphertext, new_metadata)
        finally:
            trace_archive._post_backend_artifact = original_post
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
                model="rose-labs/rose-1-flash",
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


def test_observability_archives_subagent_dumps_under_root_bundle():
    import helpers.observability as observability

    with tempfile.TemporaryDirectory() as tmp:
        restore_archive = _with_archive_env(str(Path(tmp) / "archive"))
        old_dump_root = observability._DUMP_ROOT
        old_is_prod = observability._IS_PRODUCTION
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(agent_id="child-agent", root_agent_id="root-agent")
        try:
            observability._DUMP_ROOT = Path(tmp) / "llm-dumps"
            observability._IS_PRODUCTION = False
            path = observability.dump_llm_context(
                "subagent_call",
                [{"role": "user", "content": "persist me under root"}],
                agent_id="child-agent",
                model="rose-labs/rose-1-flash",
            )
            assert path is not None
            observability.update_llm_dump(path, output={"text": "done"})

            archive_root = Path(tmp) / "archive"
            assert len(list((archive_root / "root-agent" / "llm").glob("*.enc"))) == 1
            assert len(list((archive_root / "root-agent" / "llm-updates").glob("*.enc"))) == 1
            assert not (archive_root / "child-agent").exists()

            updated = json.loads(Path(path).read_text())
            assert updated["agent_id"] == "child-agent"
            assert updated["root_agent_id"] == "root-agent"
        finally:
            structlog.contextvars.clear_contextvars()
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
    old_cached_client = getattr(trace_archive._BACKEND_CLIENTS, "client", None)
    old_cached_factory = getattr(trace_archive._BACKEND_CLIENTS, "client_factory", None)
    old_local_root = trace_archive._LOCAL_ROOT
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
        with tempfile.TemporaryDirectory() as tmp:
            trace_archive._LOCAL_ROOT = Path(tmp) / "archive"
            os.environ["FLY_APP_NAME"] = "rose-agent-prod"
            os.environ["TRACE_ARCHIVE_ENABLED"] = "1"
            os.environ["TRACE_ARCHIVE_BACKEND"] = "r2"
            os.environ["TRACE_ARCHIVE_ENCRYPTION_KEY_B64"] = base64.b64encode(b"1" * 32).decode("ascii")
            os.environ["BACKEND_API_URL"] = "https://backend.example.test"
            os.environ["BACKEND_API_KEY"] = "test-api-key"
            trace_archive.httpx.Client = _Client
            trace_archive._BACKEND_CLIENTS.client = None
            trace_archive._BACKEND_CLIENTS.client_factory = None

            result = trace_archive.archive_json(
                root_agent_id="prod-agent", path="llm/prod.json.gz.enc", payload={"prod": True}
            )
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
        trace_archive._BACKEND_CLIENTS.client = old_cached_client
        trace_archive._BACKEND_CLIENTS.client_factory = old_cached_factory
        trace_archive._LOCAL_ROOT = old_local_root
        for key, value in old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        teardown_mock()


async def test_demo_cache_write_archives_without_replay_reads_or_backend_success():
    import providers.demo_cache.client as demo_cache_client
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
        old_client = demo_cache_client._client
        token = structlog.contextvars.bind_contextvars(agent_id="agent-demo-cache", span_id="span-demo-cache")
        try:
            demo_cache_client._client = _Client()
            ok = await demo_cache_client.cache_set(
                "provider-request-key",
                "web_fetch",
                "goal-hash",
                {"request": {"url": "https://example.com"}, "response": {"status": 200}},
            )
            assert ok is False
            expected_hash = hashlib.sha256(b"provider-request-key").hexdigest()
            stored = read_local_artifact(
                root_agent_id="agent-demo-cache",
                path=f"provider/fast-cache/web_fetch/{expected_hash}.json.gz.enc",
            )
            assert stored is not None
            ciphertext, metadata = stored
            payload = json.loads(decrypt_and_validate_artifact(ciphertext, metadata).decode("utf-8"))
            assert payload["key"] == "provider-request-key"
            assert payload["kind"] == "web_fetch"
            assert payload["goal_hash"] == "goal-hash"
            assert payload["span_id"] == "span-demo-cache"
            assert payload["value"]["request"]["url"] == "https://example.com"
            assert payload["value"]["response"]["status"] == 200
        finally:
            structlog.contextvars.reset_contextvars(**token)
            demo_cache_client._client = old_client
            restore()


async def test_demo_cache_read_archives_hit_response_for_replay():
    import providers.demo_cache.client as demo_cache_client
    from helpers.trace_archive import (
        decrypt_and_validate_artifact,
        list_local_artifact_paths,
        read_local_artifact,
    )

    class _Response:
        status_code = 200

        @staticmethod
        def json():
            return {
                "hit": True,
                "value": {"request": {"q": "smoke"}, "response": {"answer": "cached"}},
                "blobPath": None,
            }

    class _Client:
        is_closed = False

        async def post(self, *args, **kwargs):
            return _Response()

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(tmp)
        old_client = demo_cache_client._client
        token = structlog.contextvars.bind_contextvars(agent_id="agent-demo-cache", span_id="span-read")
        try:
            demo_cache_client._client = _Client()
            record = await demo_cache_client.cache_get_record("provider-read-key")
            assert record["hit"] is True
            expected_hash = hashlib.sha256(b"provider-read-key").hexdigest()
            paths = [
                path
                for path in list_local_artifact_paths("agent-demo-cache")
                if path.startswith(f"provider/fast-cache/read/{expected_hash}.")
            ]
            for _ in range(100):
                if paths and read_local_artifact(root_agent_id="agent-demo-cache", path=paths[0]) is not None:
                    break
                await asyncio.sleep(0.05)
                paths = [
                    path
                    for path in list_local_artifact_paths("agent-demo-cache")
                    if path.startswith(f"provider/fast-cache/read/{expected_hash}.")
                ]
            assert len(paths) == 1
            stored = read_local_artifact(root_agent_id="agent-demo-cache", path=paths[0])
            assert stored is not None
            ciphertext, metadata = stored
            payload = json.loads(decrypt_and_validate_artifact(ciphertext, metadata).decode("utf-8"))
            assert payload["key"] == "provider-read-key"
            assert payload["key_hash"] == expected_hash
            assert payload["operation"] == "read"
            assert payload["hit"] is True
            assert payload["span_id"] == "span-read"
            assert payload["value"]["response"]["answer"] == "cached"
        finally:
            structlog.contextvars.reset_contextvars(**token)
            demo_cache_client._client = old_client
            restore()


async def test_demo_cache_archive_uses_resolved_root_agent_id():
    import providers.demo_cache.client as demo_cache_client
    from helpers.trace_archive import list_local_artifact_paths

    class _Response:
        def __init__(self, status_code, payload):
            self.status_code = status_code
            self._payload = payload

        def json(self):
            return self._payload

    class _Client:
        is_closed = False

        async def post(self, url, *args, **kwargs):
            if url.endswith("/api/fast-cache/agent-flag"):
                return _Response(
                    200,
                    {
                        "enabled": True,
                        "goal": "child task",
                        "writeEnabled": True,
                        "rootAgentId": "root-agent-for-cache",
                    },
                )
            return _Response(200, {"ok": True, "stored": True})

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(tmp)
        old_client = demo_cache_client._client
        old_memo = dict(demo_cache_client._AGENT_FASTMODE)
        token = structlog.contextvars.bind_contextvars(agent_id="child-agent-for-cache", span_id="span-root")
        try:
            demo_cache_client._client = _Client()
            demo_cache_client._AGENT_FASTMODE.clear()
            ok = await demo_cache_client.cache_set(
                "root-resolved-key",
                "llm",
                "goal-hash",
                {"response": "stored under root"},
            )
            assert ok is True
            assert list_local_artifact_paths("child-agent-for-cache") == []
            root_paths = list_local_artifact_paths("root-agent-for-cache")
            assert any(path.startswith("provider/fast-cache/llm/") for path in root_paths)
        finally:
            structlog.contextvars.reset_contextvars(**token)
            demo_cache_client._client = old_client
            demo_cache_client._AGENT_FASTMODE.clear()
            demo_cache_client._AGENT_FASTMODE.update(old_memo)
            restore()


async def test_worker_async_writes_defer_off_event_loop_and_complete():
    """Worker opt-in (TRACE_ARCHIVE_ASYNC_WRITES) defers the gzip/encrypt/store work
    off the event-loop thread — the loop-stall root cause — while still landing the
    artifact; without the opt-in, in-loop callers keep read-after-write semantics."""
    import asyncio
    import time as time_mod

    import helpers.trace_archive as trace_archive
    from helpers.trace_archive import archive_json, decrypt_and_validate_artifact

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(tmp)
        old_flag = os.environ.get("TRACE_ARCHIVE_ASYNC_WRITES")
        try:
            # Default (no opt-in): synchronous even inside a running loop.
            result = archive_json(root_agent_id="agent-sync", path="llm/sync.json.gz.enc", payload={"mode": "sync"})
            assert result is not None and result["metadata"] is not None
            assert Path(result["ref"]).exists()

            # Worker opt-in: returns immediately with the expected ref, no metadata,
            # and the write lands via the executor shortly after.
            os.environ["TRACE_ARCHIVE_ASYNC_WRITES"] = "1"
            slow_calls: list[float] = []
            original_store = trace_archive.store_encrypted_artifact

            def _slow_store(**kwargs):
                slow_calls.append(time_mod.monotonic())
                time_mod.sleep(0.3)
                return original_store(**kwargs)

            trace_archive.store_encrypted_artifact = _slow_store
            try:
                started = time_mod.monotonic()
                deferred = archive_json(
                    root_agent_id="agent-async", path="llm/deferred.json.gz.enc", payload={"mode": "async"}
                )
                elapsed = time_mod.monotonic() - started
            finally:
                trace_archive.store_encrypted_artifact = original_store
            assert deferred is not None
            assert deferred["metadata"] is None
            if elapsed >= 0.25:
                warnings.warn(f"archive_json blocked the loop for {elapsed:.3f}s", RuntimeWarning, stacklevel=2)
            expected = Path(tmp) / "agent-async" / "llm" / "deferred.json.gz.enc"
            assert deferred["ref"] == str(expected)
            meta = Path(str(expected) + ".meta.json")
            for _ in range(100):
                if expected.exists() and meta.exists():
                    break
                await asyncio.sleep(0.05)
            assert expected.exists(), "deferred archive write never landed"
            assert meta.exists(), "deferred archive metadata never landed"
            metadata = json.loads(meta.read_text())
            assert json.loads(decrypt_and_validate_artifact(expected.read_bytes(), metadata).decode("utf-8")) == {
                "mode": "async"
            }
        finally:
            if old_flag is None:
                os.environ.pop("TRACE_ARCHIVE_ASYNC_WRITES", None)
            else:
                os.environ["TRACE_ARCHIVE_ASYNC_WRITES"] = old_flag
            restore()


async def test_terminal_flush_waits_for_accepted_root_writes():
    """A terminal snapshot cannot overtake jobs already accepted for its root."""
    import helpers.trace_archive as trace_archive
    from helpers.trace_archive import archive_json, flush_archive_writes

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(tmp)
        old_flag = os.environ.get("TRACE_ARCHIVE_ASYNC_WRITES")
        old_executor = trace_archive._ARCHIVE_EXECUTOR
        original_store = trace_archive.store_encrypted_artifact
        executor = ThreadPoolExecutor(max_workers=1)
        entered = threading.Event()
        release = threading.Event()

        def _blocked_store(**kwargs):
            entered.set()
            assert release.wait(timeout=5), "test did not release the archive store"
            return original_store(**kwargs)

        try:
            os.environ["TRACE_ARCHIVE_ASYNC_WRITES"] = "1"
            trace_archive._ARCHIVE_EXECUTOR = executor
            trace_archive.store_encrypted_artifact = _blocked_store
            accepted = archive_json(
                root_agent_id="agent-terminal-flush",
                path="llm/late.json.gz.enc",
                payload={"late": True},
            )
            assert accepted is not None
            assert await asyncio.to_thread(entered.wait, 2)

            flush_task = asyncio.create_task(asyncio.to_thread(flush_archive_writes, "agent-terminal-flush", 3.0))
            await asyncio.sleep(0.05)
            assert not flush_task.done(), "terminal flush returned before the accepted write settled"
            release.set()
            assert await flush_task is True

            artifact = Path(tmp) / "agent-terminal-flush" / "llm" / "late.json.gz.enc"
            assert artifact.exists(), "terminal snapshot boundary did not wait for the artifact"
        finally:
            release.set()
            executor.shutdown(wait=True)
            trace_archive.store_encrypted_artifact = original_store
            trace_archive._ARCHIVE_EXECUTOR = old_executor
            if old_flag is None:
                os.environ.pop("TRACE_ARCHIVE_ASYNC_WRITES", None)
            else:
                os.environ["TRACE_ARCHIVE_ASYNC_WRITES"] = old_flag
            restore()


def test_terminal_flush_ignores_transaction_temporary_files():
    """Crash-recovery bookkeeping is not a pending upload artifact."""
    import helpers.trace_archive as trace_archive

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(str(Path(tmp) / "archive"))
        try:
            transaction = (
                trace_archive._outbox_root()
                / "agent-transaction-only"
                / "llm"
                / "late.json.gz.enc.transaction.123.456.tmp"
            )
            transaction.parent.mkdir(parents=True, exist_ok=True)
            transaction.write_text("temporary recovery state")
            assert not trace_archive._root_outbox_has_artifacts("agent-transaction-only")
        finally:
            restore()


def test_outbox_drain_recovers_interrupted_artifact_transactions():
    """Durable transactions survive crashes before either pair member exists."""
    import helpers.trace_archive as trace_archive

    for state in ("transaction-only", "ciphertext-only"):
        with tempfile.TemporaryDirectory() as tmp:
            restore = _with_archive_env(str(Path(tmp) / "archive"))
            original_post = trace_archive._post_backend_artifact
            posts = []
            try:
                ciphertext = f"pending-{state}".encode()
                metadata = {"ciphertext_sha256": hashlib.sha256(ciphertext).hexdigest()}
                target = trace_archive._outbox_root() / f"agent-{state}" / "llm" / "pending.json.gz.enc"
                target.parent.mkdir(parents=True, exist_ok=True)
                transaction = trace_archive._artifact_transaction_path(target)
                transaction.write_bytes(trace_archive._encode_artifact_transaction(ciphertext, metadata))
                if state == "ciphertext-only":
                    target.write_bytes(ciphertext)

                trace_archive._post_backend_artifact = lambda **kwargs: posts.append(kwargs) or "r2://stored"
                assert trace_archive._root_outbox_has_artifacts(f"agent-{state}")
                assert (
                    trace_archive._drain_backend_outbox(
                        root_agent_id=f"agent-{state}",
                    )
                    == 1
                )
                assert len(posts) == 1
                assert posts[0]["ciphertext"] == ciphertext
                assert not target.exists()
                assert not transaction.exists()
                assert not target.with_suffix(target.suffix + ".meta.json").exists()
                assert not trace_archive._root_outbox_has_artifacts(f"agent-{state}")
            finally:
                trace_archive._post_backend_artifact = original_post
                restore()


def test_outbox_drain_preserves_transaction_in_valid_artifact_name():
    import helpers.trace_archive as trace_archive

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(str(Path(tmp) / "archive"))
        original_post = trace_archive._post_backend_artifact
        posts = []
        try:
            ciphertext = b"valid-transaction-name"
            trace_archive._write_outbox(
                "agent-valid-name",
                "llm/trace.transaction.json",
                ciphertext,
                {"ciphertext_sha256": hashlib.sha256(ciphertext).hexdigest()},
            )
            trace_archive._post_backend_artifact = lambda **kwargs: posts.append(kwargs) or "r2://stored"
            assert trace_archive._drain_backend_outbox(root_agent_id="agent-valid-name") == 1
            assert len(posts) == 1
            assert posts[0]["path"] == "llm/trace.transaction.json"
        finally:
            trace_archive._post_backend_artifact = original_post
            restore()


def test_outbox_drain_bounds_failed_posts_and_reaches_later_artifacts():
    """Repeated 400s cannot trigger an unbounded replay or starve valid work."""
    import helpers.trace_archive as trace_archive

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(str(Path(tmp) / "archive"))
        original_post = trace_archive._post_backend_artifact
        posts = []
        try:
            for index in range(3):
                path = f"llm/{index}.json.gz.enc"
                ciphertext = f"pending-{index}".encode()
                target = Path(
                    trace_archive._write_outbox(
                        "agent-replay-budget",
                        path,
                        ciphertext,
                        {"ciphertext_sha256": hashlib.sha256(ciphertext).hexdigest()},
                    )
                )
                os.utime(target, (1_000 + index, 1_000 + index))

            def post(**kwargs):
                posts.append(kwargs["path"])
                return "r2://stored" if kwargs["path"].endswith("/2.json.gz.enc") else None

            trace_archive._post_backend_artifact = post
            assert trace_archive._drain_backend_outbox(limit=2) == 0
            assert posts == ["llm/0.json.gz.enc", "llm/1.json.gz.enc"]
            assert trace_archive._drain_backend_outbox(limit=1) == 1
            assert posts[-1] == "llm/2.json.gz.enc"
            assert trace_archive._root_outbox_has_artifacts("agent-replay-budget")

            posts.clear()
            assert trace_archive._drain_backend_outbox(limit=8, stop_after_failure=True) == 0
            assert len(posts) == 1, "automatic recovery continued after a failed post"

            ciphertext = b"other-root-pending"
            trace_archive._write_outbox(
                "other-root",
                "llm/pending.json.gz.enc",
                ciphertext,
                {"ciphertext_sha256": hashlib.sha256(ciphertext).hexdigest()},
            )
            posts.clear()
            assert trace_archive._drain_backend_outbox(limit=1) == 0
            assert len(posts) == 1, "failed posts exceeded the shared cross-root attempt budget"
            assert trace_archive._root_outbox_has_artifacts("other-root")
        finally:
            trace_archive._post_backend_artifact = original_post
            restore()


def test_automatic_outbox_replay_is_throttled():
    import helpers.trace_archive as trace_archive

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(str(Path(tmp) / "archive"))
        original_drain = trace_archive._drain_backend_outbox
        calls = []
        try:
            trace_archive._drain_backend_outbox = lambda **kwargs: calls.append(kwargs)
            trace_archive._drain_backend_outbox_periodically()
            trace_archive._drain_backend_outbox_periodically()
            assert calls == [{"limit": 8, "stop_after_failure": True}]
            marker = trace_archive._outbox_root() / ".automatic-drain"
            marker.write_text(str(time.time() - 61))
            trace_archive._drain_backend_outbox_periodically()
            assert len(calls) == 2
        finally:
            trace_archive._drain_backend_outbox = original_drain
            restore()


def test_outbox_drain_honors_expired_terminal_deadline():
    """A terminal flush cannot begin another HTTP upload after its deadline."""
    import helpers.trace_archive as trace_archive

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(str(Path(tmp) / "archive"))
        original_post = trace_archive._post_backend_artifact
        posts = []
        try:
            ciphertext = b"pending"
            trace_archive._write_outbox(
                "agent-expired-flush",
                "llm/pending.json.gz.enc",
                ciphertext,
                {"ciphertext_sha256": hashlib.sha256(ciphertext).hexdigest()},
            )
            trace_archive._post_backend_artifact = lambda **kwargs: posts.append(kwargs) or "r2://unexpected"
            drained = trace_archive._drain_backend_outbox(
                limit=64,
                root_agent_id="agent-expired-flush",
                deadline=time.monotonic() - 1.0,
            )
            assert drained == 0
            assert posts == []
        finally:
            trace_archive._post_backend_artifact = original_post
            restore()


def test_outbox_drain_bounds_upload_by_remaining_terminal_deadline():
    """Each upload receives only the terminal flush budget that remains."""
    import helpers.trace_archive as trace_archive

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(str(Path(tmp) / "archive"))
        original_post = trace_archive._post_backend_artifact
        upload_budgets = []
        try:
            ciphertext = b"pending"
            trace_archive._write_outbox(
                "agent-bounded-flush",
                "llm/pending.json.gz.enc",
                ciphertext,
                {"ciphertext_sha256": hashlib.sha256(ciphertext).hexdigest()},
            )
            trace_archive._post_backend_artifact = lambda **kwargs: (
                upload_budgets.append(kwargs["timeout_s"]) or "r2://stored"
            )
            deadline = time.monotonic() + 1.0
            assert (
                trace_archive._drain_backend_outbox(
                    limit=64,
                    root_agent_id="agent-bounded-flush",
                    deadline=deadline,
                )
                == 1
            )
            assert len(upload_budgets) == 1
            assert 0 < upload_budgets[0] <= 1.0
        finally:
            trace_archive._post_backend_artifact = original_post
            restore()


async def test_deferred_json_payload_factory_runs_off_event_loop():
    import asyncio
    import time as time_mod

    from helpers.trace_archive import archive_json_deferred, decrypt_and_validate_artifact

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(tmp)
        old_flag = os.environ.get("TRACE_ARCHIVE_ASYNC_WRITES")
        os.environ["TRACE_ARCHIVE_ASYNC_WRITES"] = "1"
        try:
            calls = []

            def payload():
                calls.append(time_mod.monotonic())
                time_mod.sleep(0.3)
                return {"mode": "deferred"}

            started = time_mod.monotonic()
            result = archive_json_deferred(
                root_agent_id="agent-deferred",
                path="provider/fast-cache/read/deferred.json.gz.enc",
                payload_factory=payload,
            )
            elapsed = time_mod.monotonic() - started
            assert result is not None
            assert result["metadata"] is None
            if elapsed >= 0.25:
                warnings.warn(f"payload factory ran on the event loop for {elapsed:.3f}s", RuntimeWarning, stacklevel=2)
            expected = Path(tmp) / "agent-deferred" / "provider" / "fast-cache" / "read" / "deferred.json.gz.enc"
            meta = Path(str(expected) + ".meta.json")
            for _ in range(100):
                if expected.exists() and meta.exists():
                    break
                await asyncio.sleep(0.05)
            assert expected.exists(), "deferred JSON archive never landed"
            assert meta.exists(), "deferred JSON archive metadata never landed"
            metadata = json.loads(meta.read_text())
            assert json.loads(decrypt_and_validate_artifact(expected.read_bytes(), metadata).decode("utf-8")) == {
                "mode": "deferred"
            }
            assert len(calls) == 1
        finally:
            if old_flag is None:
                os.environ.pop("TRACE_ARCHIVE_ASYNC_WRITES", None)
            else:
                os.environ["TRACE_ARCHIVE_ASYNC_WRITES"] = old_flag
            restore()


async def test_async_archive_burst_is_bounded_without_blocking_event_loop():
    import asyncio
    import time as time_mod

    import helpers.trace_archive as trace_archive
    from helpers.trace_archive import archive_json

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(tmp)
        old_flag = os.environ.get("TRACE_ARCHIVE_ASYNC_WRITES")
        os.environ["TRACE_ARCHIVE_ASYNC_WRITES"] = "1"
        original_store = trace_archive.store_encrypted_artifact
        original_executor = trace_archive._ARCHIVE_EXECUTOR
        executor = ThreadPoolExecutor(max_workers=4)
        try:

            def _slow_store(**kwargs):
                time_mod.sleep(0.2)
                return original_store(**kwargs)

            trace_archive.store_encrypted_artifact = _slow_store
            trace_archive._ARCHIVE_EXECUTOR = executor
            count = 96
            accepted = 0
            started = time_mod.monotonic()
            for idx in range(count):
                result = archive_json(
                    root_agent_id="agent-burst",
                    path=f"llm/burst-{idx}.json.gz.enc",
                    payload={"idx": idx},
                )
                accepted += result is not None
            elapsed = time_mod.monotonic() - started

            if elapsed >= 0.25:
                warnings.warn(f"archive admission blocked the event loop for {elapsed:.3f}s", RuntimeWarning, stacklevel=2)
            # In-flight jobs stay bounded by the slot limit; overflow is spilled
            # durably instead of dropped, so every write is accepted.
            assert accepted == count, f"overflow must spill, not drop: accepted={accepted}"

            bundle = Path(tmp) / "agent-burst" / "llm"
            for _ in range(200):
                files = list(bundle.glob("burst-*.json.gz.enc")) if bundle.exists() else []
                metas = list(bundle.glob("burst-*.json.gz.enc.meta.json")) if bundle.exists() else []
                if len(files) == accepted and len(metas) == accepted:
                    break
                await asyncio.sleep(0.05)
            assert bundle.exists()
            assert len(list(bundle.glob("burst-*.json.gz.enc"))) == accepted
            assert len(list(bundle.glob("burst-*.json.gz.enc.meta.json"))) == accepted
        finally:
            executor.shutdown(wait=True)
            trace_archive._ARCHIVE_EXECUTOR = original_executor
            trace_archive.store_encrypted_artifact = original_store
            if old_flag is None:
                os.environ.pop("TRACE_ARCHIVE_ASYNC_WRITES", None)
            else:
                os.environ["TRACE_ARCHIVE_ASYNC_WRITES"] = old_flag
            restore()


async def test_backend_failure_spools_encrypted_outbox_and_async_drain():
    import asyncio

    import helpers.trace_archive as trace_archive
    from helpers.trace_archive import archive_json

    with tempfile.TemporaryDirectory() as tmp:
        archive_root = Path(tmp) / "archive"
        restore = _with_archive_env(str(archive_root))
        old_env = {
            "FLY_APP_NAME": os.environ.get("FLY_APP_NAME"),
            "TRACE_ARCHIVE_BACKEND": os.environ.get("TRACE_ARCHIVE_BACKEND"),
            "TRACE_ARCHIVE_ASYNC_WRITES": os.environ.get("TRACE_ARCHIVE_ASYNC_WRITES"),
            "TRACE_ARCHIVE_ENCRYPTION_KEY_B64": os.environ.get("TRACE_ARCHIVE_ENCRYPTION_KEY_B64"),
            "BACKEND_API_URL": os.environ.get("BACKEND_API_URL"),
            "BACKEND_API_KEY": os.environ.get("BACKEND_API_KEY"),
        }
        old_client = trace_archive.httpx.Client
        posts: list[str] = []

        class _Response:
            text = ""

            def __init__(self, status_code: int, path: str):
                self.status_code = status_code
                self._path = path

            def json(self):
                return {"ref": f"r2://bucket/trace-archive/agent-outbox/{self._path}"}

        class _Client:
            is_closed = False

            def __init__(self, *args, **kwargs):
                pass

            def post(self, url, headers, json):
                posts.append(json["path"])
                status = 500 if len(posts) == 1 else 200
                return _Response(status, json["path"])

        try:
            os.environ["FLY_APP_NAME"] = "rose-agent-prod"
            os.environ["TRACE_ARCHIVE_BACKEND"] = "r2"
            os.environ["TRACE_ARCHIVE_ENCRYPTION_KEY_B64"] = base64.b64encode(b"2" * 32).decode("ascii")
            os.environ["BACKEND_API_URL"] = "https://backend.example.test"
            os.environ["BACKEND_API_KEY"] = "test-api-key"
            trace_archive.httpx.Client = _Client
            trace_archive._BACKEND_CLIENTS.client = None
            trace_archive._BACKEND_CLIENTS.client_factory = None

            failed = archive_json(root_agent_id="agent-outbox", path="llm/failed.json.gz.enc", payload={"n": 1})
            assert failed is None
            pending = archive_root.parent / "trace-archive-outbox" / "agent-outbox" / "llm" / "failed.json.gz.enc"
            assert pending.exists()
            assert pending.with_suffix(pending.suffix + ".meta.json").exists()

            stale_path = "llm/stale.json.gz.enc"
            stale_pair = trace_archive.encrypt_artifact(
                b'{"stale": true}', path=stale_path, content_type="application/json"
            )
            assert stale_pair is not None
            trace_archive._write_outbox("agent-stale", stale_path, *stale_pair)
            stale_pending = archive_root.parent / "trace-archive-outbox" / "agent-stale" / stale_path
            assert stale_pending.exists()

            os.environ["TRACE_ARCHIVE_ASYNC_WRITES"] = "1"
            current = archive_json(root_agent_id="agent-outbox", path="llm/current.json.gz.enc", payload={"n": 2})
            assert current is not None
            for _ in range(100):
                if not pending.exists():
                    break
                await asyncio.sleep(0.05)
            assert not pending.exists(), "successful async archive job did not drain pending outbox artifact"
            assert stale_pending.exists(), "current agent archive write drained an unrelated root's outbox"
            assert posts == ["llm/failed.json.gz.enc", "llm/current.json.gz.enc", "llm/failed.json.gz.enc"]
        finally:
            trace_archive.httpx.Client = old_client
            trace_archive._BACKEND_CLIENTS.client = None
            trace_archive._BACKEND_CLIENTS.client_factory = None
            for key, value in old_env.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
            restore()


async def test_async_archive_burst_retires_jobs_after_assertion():
    """A failed admission assertion must not leak writes into the next fixture."""
    import helpers.trace_archive as archive

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(tmp)
        original_json = archive.archive_json
        admitted = 0
        failure = AssertionError("controlled failure after archive admission")

        def fail_after_admission(**kwargs):
            nonlocal admitted
            if admitted == 8:
                raise failure
            result = original_json(**kwargs)
            admitted += result is not None
            return result

        try:
            archive.archive_json = fail_after_admission
            caught = None
            try:
                await test_async_archive_burst_is_bounded_without_blocking_event_loop()
            except Exception as exc:
                caught = exc
            pending = archive._pending_archive_futures("agent-burst")
            assert not pending, "failed fixture restored its globals with archive jobs still alive"
            assert caught is failure, "fixture cleanup replaced the original assertion"
        finally:
            archive.archive_json = original_json
            # Keep this outer safety fixture alive even when testing broken cleanup.
            await asyncio.to_thread(wait, archive._pending_archive_futures("agent-burst"))
            restore()


async def test_successful_archive_write_drains_only_its_root():
    """A current run must not deliver a retired run's backlog to its own backend."""
    import helpers.trace_archive as archive

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(str(Path(tmp) / "archive"))
        old_env = {key: os.environ.get(key) for key in (
            "TRACE_ARCHIVE_ASYNC_WRITES", "BACKEND_API_URL", "BACKEND_API_KEY", "TRACE_ARCHIVE_ALLOW_NONPROD_R2",
        )}
        old_client, old_executor = archive.httpx.Client, archive._ARCHIVE_EXECUTOR
        executor = ThreadPoolExecutor(max_workers=1)
        posts = []
        accepting = False

        class Client:
            is_closed = False

            def __init__(self, *args, **kwargs):
                pass

            def post(self, url, headers, json, **kwargs):
                posts.append((json["rootAgentId"], json["path"]))
                class Response:
                    status_code = 200 if accepting else 503
                    text = "fixture unavailable" if not accepting else ""
                    def json(self):
                        return {"ref": "fixture://stored"}
                return Response()

        try:
            # A non-production fixture publishing to its fake R2 backend opts in explicitly.
            os.environ.update(TRACE_ARCHIVE_BACKEND="r2", TRACE_ARCHIVE_ASYNC_WRITES="0",
                              TRACE_ARCHIVE_ALLOW_NONPROD_R2="1",
                              BACKEND_API_URL="https://archive.example.test", BACKEND_API_KEY="fixture-key")
            archive.httpx.Client = Client
            archive._BACKEND_CLIENTS.client = None
            archive._BACKEND_CLIENTS.client_factory = None
            archive._ARCHIVE_EXECUTOR = executor
            for agent in ("a-retired-root", "z-current-root"):
                assert archive.archive_json(root_agent_id=agent, path="llm/pending.json.gz.enc",
                                            payload={"owner": agent}) is None
            retired = archive._outbox_root() / "a-retired-root" / "llm/pending.json.gz.enc"
            current = archive._outbox_root() / "z-current-root" / "llm/pending.json.gz.enc"
            retained = retired.read_bytes()
            retained_meta = Path(str(retired) + ".meta.json").read_bytes()
            posts.clear()
            accepting = True
            os.environ["TRACE_ARCHIVE_ASYNC_WRITES"] = "1"
            assert archive.archive_json(root_agent_id="z-current-root", path="llm/current.json.gz.enc",
                                        payload={"current": True}) is not None
            await asyncio.to_thread(executor.shutdown, True)
            assert posts == [("z-current-root", "llm/current.json.gz.enc"),
                             ("z-current-root", "llm/pending.json.gz.enc")], posts
            assert not current.exists(), "the current root's own backlog must still drain"
            assert retired.read_bytes() == retained, "another run's encrypted payload must remain untouched"
            assert Path(str(retired) + ".meta.json").read_bytes() == retained_meta
            posts.clear()
            assert archive._drain_backend_outbox(root_agent_id="a-retired-root") == 1
            assert posts == [("a-retired-root", "llm/pending.json.gz.enc")]
            assert not retired.exists(), "explicit recovery of the retired root must still work"
        finally:
            executor.shutdown(wait=True)
            archive._ARCHIVE_EXECUTOR = old_executor
            archive.httpx.Client = old_client
            archive._BACKEND_CLIENTS.client = None
            archive._BACKEND_CLIENTS.client_factory = None
            for key, value in old_env.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
            restore()


async def test_async_local_submission_does_not_adopt_later_r2_config():
    import helpers.trace_archive as trace_archive
    from helpers.trace_archive import archive_json

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(str(Path(tmp) / "archive"))
        old_flag = os.environ.get("TRACE_ARCHIVE_ASYNC_WRITES")
        old_archive_now = trace_archive._archive_bytes_now
        old_drain = trace_archive._drain_backend_outbox
        old_executor = trace_archive._ARCHIVE_EXECUTOR
        stored = threading.Event()
        release = threading.Event()
        drain_calls: list[bool] = []
        executor = ThreadPoolExecutor(max_workers=1)

        def controlled_archive_now(**kwargs):
            result = old_archive_now(**kwargs)
            stored.set()
            assert release.wait(timeout=2)
            return result

        try:
            os.environ["TRACE_ARCHIVE_ASYNC_WRITES"] = "1"
            trace_archive._ARCHIVE_EXECUTOR = executor
            trace_archive._archive_bytes_now = controlled_archive_now
            trace_archive._drain_backend_outbox = lambda limit=8: drain_calls.append(True)

            result = archive_json(
                root_agent_id="agent-config-snapshot",
                path="llm/local.json.gz.enc",
                payload={"local": True},
            )
            assert result is not None
            assert await asyncio.to_thread(stored.wait, 2)

            os.environ["TRACE_ARCHIVE_BACKEND"] = "r2"
            release.set()
            await asyncio.to_thread(executor.shutdown, True)

            assert drain_calls == []
        finally:
            release.set()
            executor.shutdown(wait=True)
            trace_archive._ARCHIVE_EXECUTOR = old_executor
            trace_archive._archive_bytes_now = old_archive_now
            trace_archive._drain_backend_outbox = old_drain
            if old_flag is None:
                os.environ.pop("TRACE_ARCHIVE_ASYNC_WRITES", None)
            else:
                os.environ["TRACE_ARCHIVE_ASYNC_WRITES"] = old_flag
            restore()


def test_prod_backend_failure_outbox_avoids_filesystem_root_context():
    import shutil

    import helpers.trace_archive as trace_archive
    from helpers.trace_archive import archive_json

    agent_id = "agent-root-context-outbox"
    old_env = {
        "FLY_APP_NAME": os.environ.get("FLY_APP_NAME"),
        "TRACE_ARCHIVE_BACKEND": os.environ.get("TRACE_ARCHIVE_BACKEND"),
        "TRACE_ARCHIVE_ENABLED": os.environ.get("TRACE_ARCHIVE_ENABLED"),
        "TRACE_ARCHIVE_ENCRYPTION_KEY_B64": os.environ.get("TRACE_ARCHIVE_ENCRYPTION_KEY_B64"),
        "TRACE_ARCHIVE_LOCAL_ROOT": os.environ.get("TRACE_ARCHIVE_LOCAL_ROOT"),
        "BACKEND_API_URL": os.environ.get("BACKEND_API_URL"),
        "BACKEND_API_KEY": os.environ.get("BACKEND_API_KEY"),
        "CONDUCTOR_WORKSPACE_NAME": os.environ.get("CONDUCTOR_WORKSPACE_NAME"),
    }
    old_root = trace_archive._LOCAL_ROOT
    old_client = trace_archive.httpx.Client

    class _Response:
        status_code = 500
        text = "backend unavailable"

    class _Client:
        is_closed = False

        def __init__(self, *args, **kwargs):
            pass

        def post(self, *args, **kwargs):
            return _Response()

    try:
        os.environ["FLY_APP_NAME"] = "rose-agent-prod"
        os.environ["TRACE_ARCHIVE_BACKEND"] = "r2"
        os.environ["TRACE_ARCHIVE_ENABLED"] = "1"
        os.environ["TRACE_ARCHIVE_ENCRYPTION_KEY_B64"] = base64.b64encode(b"3" * 32).decode("ascii")
        os.environ["BACKEND_API_URL"] = "https://backend.example.test"
        os.environ["BACKEND_API_KEY"] = "test-api-key"
        os.environ.pop("CONDUCTOR_WORKSPACE_NAME", None)
        os.environ.pop("TRACE_ARCHIVE_LOCAL_ROOT", None)
        trace_archive._LOCAL_ROOT = Path("/.context/trace-archive")
        trace_archive.httpx.Client = _Client
        trace_archive._BACKEND_CLIENTS.client = None
        trace_archive._BACKEND_CLIENTS.client_factory = None

        result = archive_json(root_agent_id=agent_id, path="llm/root-context.json.gz.enc", payload={"ok": True})
        assert result is None
        expected = (
            trace_archive._PROD_FALLBACK_LOCAL_ROOT.parent
            / "trace-archive-outbox"
            / agent_id
            / "llm"
            / "root-context.json.gz.enc"
        )
        assert expected.exists()
        assert expected.with_suffix(expected.suffix + ".meta.json").exists()
        assert not str(expected).startswith("/.context/")
    finally:
        trace_archive.httpx.Client = old_client
        trace_archive._BACKEND_CLIENTS.client = None
        trace_archive._BACKEND_CLIENTS.client_factory = None
        trace_archive._LOCAL_ROOT = old_root
        for key, value in old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        shutil.rmtree(
            trace_archive._PROD_FALLBACK_LOCAL_ROOT.parent / "trace-archive-outbox" / agent_id, ignore_errors=True
        )
        teardown_mock()


def test_prod_local_root_uses_fallback_for_repo_context_path():
    import helpers.trace_archive as trace_archive

    old_env = {
        "FLY_APP_NAME": os.environ.get("FLY_APP_NAME"),
        "TRACE_ARCHIVE_LOCAL_ROOT": os.environ.get("TRACE_ARCHIVE_LOCAL_ROOT"),
        "CONDUCTOR_WORKSPACE_NAME": os.environ.get("CONDUCTOR_WORKSPACE_NAME"),
    }
    old_repo_root = trace_archive._REPO_ROOT
    old_local_root = trace_archive._LOCAL_ROOT

    try:
        with tempfile.TemporaryDirectory() as tmp:
            trace_archive._REPO_ROOT = Path(tmp) / "repo"
            trace_archive._LOCAL_ROOT = trace_archive._REPO_ROOT / ".context" / "trace-archive"
            os.environ["FLY_APP_NAME"] = "rose-agent-prod"
            os.environ.pop("TRACE_ARCHIVE_LOCAL_ROOT", None)
            os.environ.pop("CONDUCTOR_WORKSPACE_NAME", None)

            assert trace_archive._local_root() == trace_archive._PROD_FALLBACK_LOCAL_ROOT
    finally:
        trace_archive._REPO_ROOT = old_repo_root
        trace_archive._LOCAL_ROOT = old_local_root
        for key, value in old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        teardown_mock()


async def test_browser_http_cache_ops_do_not_archive():
    """browser_http cache ops fire per page subresource (thousands/session) and
    must never hit the archive endpoint; llm-kind ops keep archiving."""
    from providers.demo_cache import client as demo_cache_client

    calls: list[str] = []

    def fake_archive_json_deferred(**kwargs):
        calls.append(kwargs["path"])
        return {"ref": kwargs["path"], "metadata": None}

    old_deferred_archive = demo_cache_client.archive_json_deferred
    old_resolver = demo_cache_client.resolve_archive_root_agent_id

    async def fake_resolver():
        return "root-agent"

    demo_cache_client.archive_json_deferred = fake_archive_json_deferred
    demo_cache_client.resolve_archive_root_agent_id = fake_resolver
    try:
        await demo_cache_client._archive_cache_write(
            "fastmode:v42:browser_http:global:GET:abc:public:no-body", "browser_http", "gh", {"v": 1}, None
        )
        await demo_cache_client._archive_cache_read(
            "fastmode:v42:browser_http:global:GET:abc:public:no-body", hit=True, value={"v": 1}, blob_path=None
        )
        assert calls == []
        await demo_cache_client._archive_cache_write("fastmode:v42:llm:gh:site:c:abc", "llm", "gh", {"v": 1}, None)
        await demo_cache_client._archive_cache_read(
            "fastmode:v42:llm:gh:site:c:abc", hit=True, value={"v": 1}, blob_path=None
        )
        assert len(calls) == 2
    finally:
        demo_cache_client.archive_json_deferred = old_deferred_archive
        demo_cache_client.resolve_archive_root_agent_id = old_resolver


def test_oversized_artifact_is_dropped_with_warning():
    """A single oversized encrypted body (e.g. browser session video) must never
    reach the backend — giant base64-in-JSON uploads freeze the Node event loop.
    The limit applies after compression, so compressible traces stay archived."""
    from helpers.trace_archive import archive_bytes

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(tmp)
        old_limit = os.environ.get("TRACE_ARCHIVE_MAX_ARTIFACT_BYTES")
        os.environ["TRACE_ARCHIVE_MAX_ARTIFACT_BYTES"] = "1024"
        try:
            result = archive_bytes(
                root_agent_id="agent-big",
                path="media/browser/huge.bin",
                body=os.urandom(2048),
                content_type="application/octet-stream",
            )
            assert result is None
            assert not (Path(tmp) / "agent-big").exists()
            compressible = archive_bytes(
                root_agent_id="agent-big",
                path="media/browser/compressible.bin",
                body=b"x" * 2048,
                content_type="application/octet-stream",
            )
            assert compressible is not None
            ok = archive_bytes(
                root_agent_id="agent-big",
                path="media/browser/small.bin",
                body=b"x" * 512,
                content_type="application/octet-stream",
            )
            assert ok is not None
        finally:
            if old_limit is None:
                os.environ.pop("TRACE_ARCHIVE_MAX_ARTIFACT_BYTES", None)
            else:
                os.environ["TRACE_ARCHIVE_MAX_ARTIFACT_BYTES"] = old_limit
            restore()


def test_read_archive_artifact_metadata_never_reads_ciphertext():
    """Metadata-only reads share the artifact contract but skip the body.

    Local: metadata from the sidecar; None when the artifact is absent;
    ValueError when ciphertext exists without its sidecar. R2: only the
    ``.meta.json`` object is fetched on the hit path, and the miss path probes
    existence without reading a body.
    """
    from helpers.trace_archive import (
        archive_json,
        read_archive_artifact,
        read_archive_artifact_metadata,
    )
    import helpers.trace_archive as trace_archive

    with tempfile.TemporaryDirectory() as tmp:
        restore = _with_archive_env(tmp)
        try:
            root_agent_id = "root-meta-only"
            archive_json(root_agent_id=root_agent_id, path="trace/transitions.json.gz.enc", payload={"steps": [1, 2, 3]})
            full = read_archive_artifact(root_agent_id=root_agent_id, path="trace/transitions.json.gz.enc")
            assert full is not None
            _, full_metadata = full
            metadata = read_archive_artifact_metadata(root_agent_id=root_agent_id, path="trace/transitions.json.gz.enc")
            assert metadata == full_metadata
            assert read_archive_artifact_metadata(root_agent_id=root_agent_id, path="missing.json.gz.enc") is None
            target = Path(tmp) / root_agent_id / "trace" / "transitions.json.gz.enc"
            (target.with_suffix(target.suffix + ".meta.json")).unlink()
            try:
                read_archive_artifact_metadata(root_agent_id=root_agent_id, path="trace/transitions.json.gz.enc")
            except ValueError as exc:
                assert "Archive metadata missing" in str(exc)
            else:
                raise AssertionError("ciphertext without metadata must fail closed")

            objects: dict[str, bytes] = {}
            for item in Path(tmp).rglob("*"):
                if item.is_file():
                    objects["trace-archive/" + item.relative_to(tmp).as_posix()] = item.read_bytes()
        finally:
            restore()

    meta_key = f"trace-archive/{root_agent_id}/trace/transitions.json.gz.enc.meta.json"
    objects[meta_key] = json.dumps(full_metadata).encode("utf-8")
    fetched: list[str] = []

    class _Body:
        def __init__(self, data: bytes) -> None:
            self._data = data

        def read(self) -> bytes:
            return self._data

    class _Client:
        def get_object(self, *, Bucket: str, Key: str) -> dict:
            fetched.append(Key)
            if Key not in objects:
                error = Exception(f"NoSuchKey: {Key}")
                error.response = {"Error": {"Code": "NoSuchKey"}}
                raise error
            return {"Body": _Body(objects[Key])}

        def head_object(self, *, Bucket: str, Key: str) -> dict:
            fetched.append(Key)
            if Key not in objects:
                error = Exception(f"NoSuchKey: {Key}")
                error.response = {"Error": {"Code": "NoSuchKey"}}
                raise error
            return {}

    old_client = trace_archive._R2_CLIENT
    old_env = {key: os.environ.get(key) for key in ["TRACE_ARCHIVE_BACKEND", "R2_BUCKET_TRACE_ARCHIVE"]}
    trace_archive._R2_CLIENT = _Client()
    os.environ["TRACE_ARCHIVE_BACKEND"] = "r2"
    os.environ["R2_BUCKET_TRACE_ARCHIVE"] = "unit-bucket"
    try:
        assert read_archive_artifact_metadata(root_agent_id=root_agent_id, path="trace/transitions.json.gz.enc") == full_metadata
        assert fetched == [meta_key[:-len(".meta.json")], meta_key]
        fetched.clear()
        assert read_archive_artifact_metadata(root_agent_id=root_agent_id, path="nope.json.gz.enc") is None
        assert fetched == [f"trace-archive/{root_agent_id}/nope.json.gz.enc"]
        objects[f"trace-archive/{root_agent_id}/orphan.enc"] = b"ciphertext without sidecar"
        try:
            read_archive_artifact_metadata(root_agent_id=root_agent_id, path="orphan.enc")
        except ValueError as exc:
            assert "Archive metadata missing for orphan.enc" in str(exc)
        else:
            raise AssertionError("R2 ciphertext without metadata must fail closed")
    finally:
        trace_archive._R2_CLIENT = old_client
        for key, value in old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def test_r2_metadata_requires_ciphertext_and_preserves_head_errors():
    """A sidecar is not an artifact; existence never opens a ciphertext body."""
    import helpers.trace_archive as archive
    from unittest.mock import patch

    metadata = {"plaintext_sha256": "test-digest", "plaintext_bytes": 7}
    key = archive._object_key("root-sidecar-contract", "trace/example.enc")
    sidecar = key + ".meta.json"

    class R2Error(Exception):
        def __init__(self, code):
            super().__init__(code)
            self.response = {"Error": {"Code": code}}

    class Body:
        def read(self):
            return json.dumps(metadata).encode()

    class Client:
        def __init__(self, ciphertext, meta, head_error=None):
            self.ciphertext = ciphertext
            self.meta = meta
            self.head_error = head_error
            self.gets = []
            self.heads = []

        def get_object(self, *, Bucket, Key):
            self.gets.append(Key)
            assert Key == sidecar, "metadata reader opened a ciphertext body"
            if not self.meta:
                raise R2Error("NoSuchKey")
            return {"Body": Body()}

        def head_object(self, *, Bucket, Key):
            self.heads.append(Key)
            assert Key == key
            if self.head_error:
                raise self.head_error
            if not self.ciphertext:
                raise R2Error("NoSuchKey")
            return {"ContentLength": 7}

    cases = [(False, True, None), (True, True, metadata), (False, False, None)]
    for ciphertext, meta, expected in cases:
        client = Client(ciphertext, meta)
        with patch.object(archive, "_r2_client", return_value=client), patch.object(archive, "_r2_bucket", return_value="test-bucket"):
            assert archive.read_r2_artifact_metadata(root_agent_id="root-sidecar-contract", path="trace/example.enc") == expected
        assert client.heads == [key], "every metadata result must establish ciphertext existence"
        assert key not in client.gets

    client = Client(True, False)
    with patch.object(archive, "_r2_client", return_value=client), patch.object(archive, "_r2_bucket", return_value="test-bucket"):
        try:
            archive.read_r2_artifact_metadata(root_agent_id="root-sidecar-contract", path="trace/example.enc")
        except ValueError as exc:
            assert "Archive metadata missing for trace/example.enc" in str(exc)
        else:
            raise AssertionError("ciphertext without metadata was accepted")
    assert client.heads == [key] and key not in client.gets

    for code in ["AccessDenied", "InternalError"]:
        failure = R2Error(code)
        client = Client(True, True, failure)
        with patch.object(archive, "_r2_client", return_value=client), patch.object(archive, "_r2_bucket", return_value="test-bucket"):
            try:
                archive.read_r2_artifact_metadata(root_agent_id="root-sidecar-contract", path="trace/example.enc")
            except R2Error as exc:
                assert exc is failure
            else:
                raise AssertionError("nonmissing HEAD error was swallowed")
        assert client.heads == [key] and key not in client.gets


async def run_all_tests():
    print("trace archive blackbox tests:")
    r = BlackboxResult()
    r.record("encrypt_json_gzip_roundtrip", test_encrypt_json_gzip_roundtrip)
    r.record("encrypt_media_skips_gzip", test_encrypt_media_skips_gzip)
    r.record("local_store_writes_ciphertext_and_metadata", test_local_store_writes_ciphertext_and_metadata)
    r.record("read_archive_artifact_metadata_never_reads_ciphertext", test_read_archive_artifact_metadata_never_reads_ciphertext)
    r.record("r2_metadata_requires_ciphertext_and_preserves_head_errors", test_r2_metadata_requires_ciphertext_and_preserves_head_errors)
    r.record("local_store_publishes_metadata_atomically", test_local_store_publishes_metadata_atomically)
    r.record(
        "artifact_transaction_recovers_crash_between_pair_replacements",
        test_artifact_transaction_recovers_crash_between_pair_replacements,
    )
    r.record(
        "local_artifact_listing_hides_transaction_and_temporary_files",
        test_local_artifact_listing_hides_transaction_and_temporary_files,
    )
    r.record("artifact_lock_pool_is_bounded", test_artifact_lock_pool_is_bounded)
    r.record(
        "cross_process_reader_waits_for_matched_artifact_pair",
        test_cross_process_reader_waits_for_matched_artifact_pair,
    )
    r.record("outbox_drain_does_not_delete_newer_generation", test_outbox_drain_does_not_delete_newer_generation)
    r.record("local_store_gold_io_validates_integrity", test_local_store_gold_io_validates_integrity)
    r.record(
        "observability_writes_dev_dump_and_archive_updates", test_observability_writes_dev_dump_and_archive_updates
    )
    r.record(
        "observability_archives_subagent_dumps_under_root_bundle",
        test_observability_archives_subagent_dumps_under_root_bundle,
    )
    r.record("prod_worker_posts_encrypted_artifact_to_backend", test_prod_worker_posts_encrypted_artifact_to_backend)
    await r.record_async(
        "demo_cache_write_archives_without_replay_reads_or_backend_success",
        test_demo_cache_write_archives_without_replay_reads_or_backend_success,
    )
    await r.record_async(
        "demo_cache_read_archives_hit_response_for_replay", test_demo_cache_read_archives_hit_response_for_replay
    )
    await r.record_async(
        "demo_cache_archive_uses_resolved_root_agent_id", test_demo_cache_archive_uses_resolved_root_agent_id
    )
    await r.record_async(
        "worker_async_writes_defer_off_event_loop_and_complete",
        test_worker_async_writes_defer_off_event_loop_and_complete,
    )
    await r.record_async(
        "terminal_flush_waits_for_accepted_root_writes",
        test_terminal_flush_waits_for_accepted_root_writes,
    )
    r.record(
        "terminal_flush_ignores_transaction_temporary_files",
        test_terminal_flush_ignores_transaction_temporary_files,
    )
    r.record(
        "outbox_drain_recovers_interrupted_artifact_transactions",
        test_outbox_drain_recovers_interrupted_artifact_transactions,
    )
    r.record(
        "outbox_drain_preserves_transaction_in_valid_artifact_name",
        test_outbox_drain_preserves_transaction_in_valid_artifact_name,
    )
    r.record(
        "outbox_drain_bounds_failed_posts_and_reaches_later_artifacts",
        test_outbox_drain_bounds_failed_posts_and_reaches_later_artifacts,
    )
    r.record("automatic_outbox_replay_is_throttled", test_automatic_outbox_replay_is_throttled)
    r.record(
        "outbox_drain_honors_expired_terminal_deadline",
        test_outbox_drain_honors_expired_terminal_deadline,
    )
    r.record(
        "outbox_drain_bounds_upload_by_remaining_terminal_deadline",
        test_outbox_drain_bounds_upload_by_remaining_terminal_deadline,
    )
    await r.record_async(
        "deferred_json_payload_factory_runs_off_event_loop",
        test_deferred_json_payload_factory_runs_off_event_loop,
    )
    await r.record_async(
        "async_archive_burst_bounded_nonblocking",
        test_async_archive_burst_is_bounded_without_blocking_event_loop,
    )
    await r.record_async(
        "async_archive_burst_retires_jobs_after_assertion",
        test_async_archive_burst_retires_jobs_after_assertion,
    )
    await r.record_async(
        "backend_failure_spools_encrypted_outbox_and_async_drain",
        test_backend_failure_spools_encrypted_outbox_and_async_drain,
    )
    await r.record_async(
        "successful_archive_write_drains_only_its_root",
        test_successful_archive_write_drains_only_its_root,
    )
    await r.record_async(
        "async_local_submission_does_not_adopt_later_r2_config",
        test_async_local_submission_does_not_adopt_later_r2_config,
    )
    r.record(
        "prod_backend_failure_outbox_avoids_filesystem_root_context",
        test_prod_backend_failure_outbox_avoids_filesystem_root_context,
    )
    r.record(
        "prod_local_root_uses_fallback_for_repo_context_path",
        test_prod_local_root_uses_fallback_for_repo_context_path,
    )
    r.record("oversized_artifact_is_dropped_with_warning", test_oversized_artifact_is_dropped_with_warning)
    await r.record_async("browser_http_cache_ops_do_not_archive", test_browser_http_cache_ops_do_not_archive)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    import asyncio

    asyncio.run(run_all_tests())
