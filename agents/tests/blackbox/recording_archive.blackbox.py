"""Recorder archive publication must not leave a per-file tail at worker exit."""

import asyncio
import base64
import gzip
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from _test_utils import BlackboxResult
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

AGENTS = Path(__file__).resolve().parents[2]
FIXTURE_KEY = b"x" * 32
WORKER = """
import asyncio, json, logging, os, signal, sys, time
from pathlib import Path
sys.path.insert(0, os.environ["FIXTURE_AGENTS_PATH"])
from tests.env_defaults import apply_test_env_defaults
apply_test_env_defaults()
from domains.spawn_browser_agent_v3.recording import BrowserAgentRecorder
logging.disable(logging.CRITICAL)

async def main():
    recorder = object.__new__(BrowserAgentRecorder)
    recorder.agent_id = "offline-root"
    recorder.task_id = "offline-task"
    recorder.output_dir = Path("artifacts")
    stopped = asyncio.Event()
    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, stopped.set)
    assert recorder.archive_recording_artifacts_in_background(cleanup_after=False)
    await stopped.wait()
    returned = Path("main-returned")
    pending = returned.with_suffix(".tmp")
    with pending.open("w") as handle:
        # Make premature existence-based readiness fail deterministically.
        time.sleep(0.2)
        handle.write(json.dumps({"at": time.monotonic()}))
    pending.replace(returned)

asyncio.run(main())
Path("asyncio-run-returned").touch()
"""


def _worker_startup_failure(root: Path, process: subprocess.Popen) -> str:
    diagnostics = {}
    for name in ("worker.log", "supervisor.log"):
        path = root / name
        if not path.exists():
            continue
        with path.open("rb") as stream:
            stream.seek(0, os.SEEK_END)
            stream.seek(max(0, stream.tell() - 8192))
            tail = stream.read(8192)
        diagnostics[name] = tail.decode(errors="replace")
        artifact_dir = os.environ.get("BLACKBOX_TEST_ARTIFACT_DIR")
        if artifact_dir:
            retained = Path(artifact_dir) / "recording-worker-startup" / root.name / name
            retained.parent.mkdir(parents=True, exist_ok=True)
            retained.write_bytes(tail)
            retained.chmod(0o600)
    return (
        f"recorder never reached the loopback archive; supervisor exit={process.poll()}; "
        f"startup logs={json.dumps(diagnostics)}"
    )


def test_recording_archive_worker_exit_has_no_serial_publication_tail():
    """Real recorder/encryption/HTTP/supervisor retain every artifact during cancellation."""
    with tempfile.TemporaryDirectory(prefix="rose-recording-exit-") as temporary:
        root = Path(temporary)
        (root / "worker.py").write_text(WORKER)
        (root / "artifacts").mkdir()
        expected = {}
        for index in range(6):
            name = f"frame-{index:03}.txt"
            value = f"offline frame {index}".encode()
            (root / "artifacts" / name).write_bytes(value)
            expected[f"media/browser/offline-task/{name}"] = value
        requests = []
        accepted = {}
        failures = []
        first_request = threading.Event()
        release_response = threading.Event()

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                try:
                    assert self.headers["X-API-Key"] == "offline-fixture-key"
                    body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    assert body["rootAgentId"] == "offline-root"
                    assert self.path in {"/api/archive/artifact", "/api/archive/artifacts"}
                    artifacts = body["artifacts"] if self.path.endswith("/artifacts") else [body]
                    requests.append(time.monotonic())
                    for artifact in artifacts:
                        metadata = artifact["metadata"]
                        path = artifact["path"]
                        assert metadata["path"] == metadata["aad"] == path
                        cleartext = AESGCM(FIXTURE_KEY).decrypt(
                            base64.b64decode(metadata["nonce_b64"]),
                            base64.b64decode(artifact["ciphertextB64"]),
                            path.encode(),
                        )
                        if metadata["compression"] == "gzip":
                            cleartext = gzip.decompress(cleartext)
                        assert path not in accepted
                        accepted[path] = cleartext
                    first_request.set()
                    assert release_response.wait(5)
                    # Each round trip models fixed backend manifest publication work.
                    time.sleep(0.15)
                    refs = [{"path": a["path"], "ref": f"fixture/{a['path']}"} for a in artifacts]
                    payload = json.dumps(
                        {"artifacts": refs} if self.path.endswith("/artifacts") else {"ref": refs[0]["ref"]}
                    ).encode()
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                except Exception as exc:
                    failures.append(type(exc).__name__)
                    first_request.set()

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        # Allowlisted child environment excludes real provider credentials and endpoints.
        env = {
            "PATH": os.environ.get("PATH", ""),
            "PYTHON_DOTENV_DISABLED": "1",
            "FIXTURE_AGENTS_PATH": str(AGENTS),
            "WORKER_PROCESSES": "1",
            "NAVI_WORKER_LOG_STREAM": "false",
            "NAVI_WORKER_LOG_FILE": str(root / "worker.log"),
            "TRACE_ARCHIVE_ENABLED": "1",
            "TRACE_ARCHIVE_ASYNC_WRITES": "1",
            "TRACE_ARCHIVE_BACKEND": "r2",
            "TRACE_ARCHIVE_ALLOW_NONPROD_R2": "1",
            "TRACE_ARCHIVE_ENCRYPTION_KEY_B64": base64.b64encode(FIXTURE_KEY).decode(),
            "TRACE_ARCHIVE_LOCAL_ROOT": str(root / "archive"),
            "BACKEND_API_KEY": "offline-fixture-key",
            "BACKEND_API_URL": f"http://127.0.0.1:{server.server_port}",
            "NO_PROXY": "*",
            "no_proxy": "*",
            "ANONYMIZED_TELEMETRY": "false",
        }
        with (root / "supervisor.log").open("wb") as output:
            process = subprocess.Popen(
                [sys.executable, str(AGENTS / "scripts/local_worker_supervisor.py")],
                cwd=root,
                env=env,
                stdout=output,
                stderr=subprocess.STDOUT,
            )
        try:
            assert first_request.wait(15), _worker_startup_failure(root, process)
            assert not failures, failures
            process.send_signal(signal.SIGTERM)
            deadline = time.monotonic() + 5
            while not (root / "main-returned").exists():
                assert process.poll() is None and time.monotonic() < deadline
                time.sleep(0.01)
            main_returned = json.loads((root / "main-returned").read_text())["at"]
            assert process.poll() is None, "supervisor must wait for accepted archive work"
            assert not (root / "asyncio-run-returned").exists()
            assert len(list((root / "artifacts").iterdir())) == 6
            release_response.set()
            assert process.wait(timeout=10) == 0
            assert not failures, failures
            assert accepted == expected, "all original paths and encrypted bytes must survive"
            assert (root / "asyncio-run-returned").exists()
            later_requests = sum(start > main_returned for start in requests)
            assert later_requests == 0, f"worker began {later_requests} serial artifact requests after main returned"
            assert len(requests) == 1, "a small recording needs one manifest publication"
        finally:
            release_response.set()
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)
                process.wait(timeout=10)
            server.shutdown()
            server.server_close()
            thread.join(timeout=10)


async def test_recording_batch_failure_retains_sources_and_retryable_envelopes():
    from unittest.mock import patch
    import httpx
    import helpers.trace_archive as archive
    import domains.spawn_browser_agent_v3.recording as recording

    for mode in ("partial_failure", "malformed_ack", "foreign_ack", "delayed_complete_ack", "success"):
        with tempfile.TemporaryDirectory(prefix="rose-recording-batch-") as temporary:
            root = Path(temporary)
            source = root / "sources"
            source.mkdir()
            expected = {}
            for index in range(3):
                path = source / f"frame-{index}.txt"
                path.write_bytes(f"frame {index}".encode())
                expected[f"media/browser/offline-task/{path.name}"] = path.read_bytes()
            batches = []
            accepted = {}
            ciphertexts = {}

            class Client:
                def post(self, url, **kwargs):
                    body = kwargs["json"]
                    assert body["rootAgentId"] == "offline-root"
                    if url.endswith("/artifacts"):
                        batch = body["artifacts"]
                        batches.append(batch)
                        for item in batch:
                            target = archive._outbox_root() / "offline-root" / item["path"]
                            assert target.read_bytes() == base64.b64decode(item["ciphertextB64"])
                            ciphertexts[item["path"]] = item["ciphertextB64"]
                        if mode == "partial_failure":
                            # The remote store accepted the first file but the batch failed.
                            accepted[batch[0]["path"]] = batch[0]["ciphertextB64"]
                            return httpx.Response(503)
                        if mode == "delayed_complete_ack":
                            # The archived native HTTP control proves a valid ACK
                            # can arrive after the ordinary client's 30s window.
                            # Model that wire boundary without a sleeping test.
                            timeout = kwargs.get("timeout", httpx.Timeout(30.0))
                            if timeout.read < 35.0:
                                raise httpx.ReadTimeout("offline valid delayed batch ACK")
                        refs = [{"path": item["path"], "ref": "fixture/ref"} for item in batch]
                        if mode == "malformed_ack":
                            refs = refs[:-1]
                        if mode == "foreign_ack":
                            refs[0] = {"path": "media/browser/foreign-task/not-owned.txt", "ref": "fixture/ref"}
                        return httpx.Response(200, json={"artifacts": refs})
                    assert url.endswith("/artifact")
                    assert body["ciphertextB64"] == ciphertexts[body["path"]]
                    accepted[body["path"]] = body["ciphertextB64"]
                    return httpx.Response(200, json={"ref": "fixture/ref"})

            env = {
                "TRACE_ARCHIVE_ENABLED": "1",
                "TRACE_ARCHIVE_BACKEND": "r2",
                "TRACE_ARCHIVE_ALLOW_NONPROD_R2": "1",
                "TRACE_ARCHIVE_LOCAL_ROOT": str(root / "archive"),
                "TRACE_ARCHIVE_ENCRYPTION_KEY_B64": base64.b64encode(FIXTURE_KEY).decode(),
                "BACKEND_API_URL": "http://127.0.0.1:1",
                "BACKEND_API_KEY": "fixture",
                "BROWSER_AGENT_RECORDINGS_CLEANUP_LOCAL": "true",
            }

            async def run():
                recorder = object.__new__(recording.BrowserAgentRecorder)
                recorder.agent_id = "offline-root"
                recorder.task_id = "offline-task"
                recorder.output_dir = source
                assert recorder.archive_recording_artifacts_in_background(cleanup_after=True)
                await asyncio.gather(*list(recording._BACKGROUND_RECORDING_ARCHIVE_TASKS))
                await asyncio.sleep(0)

            with patch.dict(os.environ, env), patch.object(archive, "_backend_http_client", return_value=Client()):
                await run()
                assert len(batches) == 1
                if mode in ("success", "delayed_complete_ack"):
                    assert not source.exists(), "acknowledged source files should be cleaned"
                    assert not archive._root_outbox_has_artifacts("offline-root")
                else:
                    assert source.exists() and len(list(source.iterdir())) == 3
                    assert archive._root_outbox_has_artifacts("offline-root")
                    assert archive._drain_backend_outbox(root_agent_id="offline-root") == 3
                    assert set(accepted) == set(expected)
                    assert not archive._root_outbox_has_artifacts("offline-root")
                for item in batches[0]:
                    cleartext = archive.decrypt_and_validate_artifact(
                        base64.b64decode(item["ciphertextB64"]), item["metadata"]
                    )
                    assert cleartext == expected[item["path"]]


def test_recording_batches_bound_count_bytes_and_preserve_large_sources():
    from unittest.mock import patch

    import helpers.trace_archive as archive

    with tempfile.TemporaryDirectory(prefix="rose-recording-chunks-") as temporary:
        root = Path(temporary)
        entries = []
        for index in range(5):
            path = root / f"frame-{index}.txt"
            path.write_bytes(b"frame data")
            entries.append((f"media/browser/task/{path.name}", path, "text/plain", False))
        batches = []

        def publish(root_agent_id, artifacts):
            assert root_agent_id == "offline-root"
            batches.append(artifacts)
            assert (
                len(json.dumps({"rootAgentId": root_agent_id, "artifacts": artifacts}, separators=(",", ":")).encode())
                <= archive._BATCH_MAX_BYTES
            )
            return True

        env = {
            "TRACE_ARCHIVE_ENABLED": "1",
            "TRACE_ARCHIVE_BACKEND": "r2",
            "TRACE_ARCHIVE_ALLOW_NONPROD_R2": "1",
            "TRACE_ARCHIVE_ENCRYPTION_KEY_B64": base64.b64encode(FIXTURE_KEY).decode(),
        }
        with patch.dict(os.environ, env), patch.object(archive, "_publish_artifact_batch", side_effect=publish):
            with patch.object(archive, "_BATCH_MAX_RECORDS", 2):
                assert archive.archive_files(root_agent_id="offline-root", artifacts=iter(entries))
                assert [len(batch) for batch in batches] == [2, 2, 1]
            batches.clear()
            with patch.object(archive, "_BATCH_MAX_BYTES", 1600):
                assert archive.archive_files(root_agent_id="offline-root", artifacts=iter(entries))
                assert len(batches) > 1 and sum(map(len, batches)) == 5
            batches.clear()
            with patch.dict(os.environ, {"TRACE_ARCHIVE_MAX_ARTIFACT_BYTES": "1"}):
                assert not archive.archive_files(root_agent_id="offline-root", artifacts=iter(entries))
                assert not batches
                assert all(path.exists() for _, path, _, _ in entries)
            entries[0][1].write_bytes(b"x" * 1000)
            with patch.dict(os.environ, {"TRACE_ARCHIVE_MAX_ARTIFACT_BYTES": "11"}):
                assert not archive.archive_files(root_agent_id="offline-root", artifacts=iter(entries))
                assert sum(map(len, batches)) == 4, "one oversized source must not discard other valid files"
                assert all(path.exists() for _, path, _, _ in entries)


def test_recording_batch_lease_blocks_foreign_process_drain_and_recovers_after_crash():
    from unittest.mock import patch

    import httpx

    import helpers.trace_archive as archive

    with tempfile.TemporaryDirectory(prefix="rose-recording-lease-") as temporary:
        root = Path(temporary)
        source = root / "sources"
        source.mkdir()
        for index in range(3):
            (source / f"frame-{index}.txt").write_bytes(f"frame {index}".encode())
        entered = threading.Event()
        release = threading.Event()
        batch = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                assert self.path == "/api/archive/artifacts"
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                batch.extend(body["artifacts"])
                entered.set()
                release.wait(10)
                self.close_connection = True

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        env = {
            "PATH": os.environ.get("PATH", ""),
            "PYTHONPATH": str(AGENTS),
            "TRACE_ARCHIVE_ENABLED": "1",
            "TRACE_ARCHIVE_BACKEND": "r2",
            "TRACE_ARCHIVE_ALLOW_NONPROD_R2": "1",
            "TRACE_ARCHIVE_LOCAL_ROOT": str(root / "archive"),
            "TRACE_ARCHIVE_ENCRYPTION_KEY_B64": base64.b64encode(FIXTURE_KEY).decode(),
            "BACKEND_API_URL": f"http://127.0.0.1:{server.server_port}",
            "BACKEND_API_KEY": "fixture",
            "NO_PROXY": "*",
            "no_proxy": "*",
        }
        child = """from pathlib import Path
from tests.env_defaults import apply_test_env_defaults
apply_test_env_defaults()
from helpers.trace_archive import archive_files
archive_files(root_agent_id='offline-root', artifacts=(
    ('media/browser/task/'+p.name,p,'text/plain',None) for p in Path('sources').iterdir()))
"""
        process = subprocess.Popen(
            [sys.executable, "-c", child], cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        singles = []

        class Client:
            def post(self, url, **kwargs):
                assert url.endswith("/artifact")
                singles.append(kwargs["json"])
                return httpx.Response(200, json={"ref": "fixture/ref"})

        try:
            if not entered.wait(10):
                assert process.poll() is None, process.communicate(timeout=10)
                raise AssertionError("fixture child did not enter batch HTTP request")
            with patch.dict(os.environ, env), patch.object(archive, "_backend_http_client", return_value=Client()):
                assert archive._pending_archive_futures("offline-root") == set(), "owner must be another process"
                flushed = archive.flush_archive_writes("offline-root", timeout_s=0.05)
                assert not singles, "foreign flush adopted an in-flight batch as individual requests"
                assert not flushed, "flush acknowledged a batch whose remote response is still blocked"
                process.kill()
                process.wait(timeout=5)
                release.set()
                assert archive.flush_archive_writes("offline-root", timeout_s=10)
                assert len(singles) == len(batch) == 3
                assert {item["path"]: item["ciphertextB64"] for item in singles} == {
                    item["path"]: item["ciphertextB64"] for item in batch
                }, "crash recovery must publish the originally accepted ciphertext"
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            release.set()
            server.shutdown()
            server.server_close()
            thread.join(timeout=10)


def test_failed_recording_batch_still_publishes_later_files():
    from unittest.mock import patch

    import httpx

    import helpers.trace_archive as archive

    with tempfile.TemporaryDirectory(prefix="rose-recording-partial-") as temporary:
        root = Path(temporary)
        entries = []
        for index in range(5):
            source = root / f"frame-{index}.txt"
            source.write_bytes(f"frame {index}".encode())
            entries.append((f"media/browser/task/{source.name}", source, "text/plain", None))
        batches = []
        accepted = set()

        class Client:
            def post(self, url, **kwargs):
                body = kwargs["json"]
                if url.endswith("/artifacts"):
                    batches.append(body["artifacts"])
                    if len(batches) == 1:
                        return httpx.Response(503)
                    accepted.update(item["path"] for item in body["artifacts"])
                    return httpx.Response(
                        200,
                        json={
                            "artifacts": [{"path": item["path"], "ref": "fixture/ref"} for item in body["artifacts"]]
                        },
                    )
                assert url.endswith("/artifact")
                accepted.add(body["path"])
                return httpx.Response(200, json={"ref": "fixture/ref"})

        env = {
            "TRACE_ARCHIVE_ENABLED": "1",
            "TRACE_ARCHIVE_BACKEND": "r2",
            "TRACE_ARCHIVE_ALLOW_NONPROD_R2": "1",
            "TRACE_ARCHIVE_LOCAL_ROOT": str(root / "archive"),
            "TRACE_ARCHIVE_ENCRYPTION_KEY_B64": base64.b64encode(FIXTURE_KEY).decode(),
            "BACKEND_API_URL": "http://127.0.0.1:1",
            "BACKEND_API_KEY": "fixture",
        }
        with (
            patch.dict(os.environ, env),
            patch.object(archive, "_BATCH_MAX_RECORDS", 2),
            patch.object(archive, "_backend_http_client", return_value=Client()),
        ):
            assert not archive.archive_files(root_agent_id="offline-root", artifacts=iter(entries))
            assert [len(batch) for batch in batches] == [2, 2, 1]
            assert archive.flush_archive_writes("offline-root", timeout_s=10)
            assert accepted == {path for path, _, _, _ in entries}
            assert all(source.exists() for _, source, _, _ in entries)


def test_closed_recording_archive_owner(mode: str, *, workers: int = 4):
    """Native producer/encryption/HTTP proofs in an isolated credential-free child."""
    fixture = Path(__file__).with_name("_recording_archive_closed_fixture.py")
    with tempfile.TemporaryDirectory(prefix="rose-closed-archive-owner-") as temporary:
        root = Path(temporary)
        env = {
            "PATH": os.environ.get("PATH", ""),
            "PYTHON_DOTENV_DISABLED": "1",
            "FIXTURE_AGENTS_PATH": str(AGENTS),
            "ANONYMIZED_TELEMETRY": "false",
        }
        for name in (
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
            "no_proxy",
        ):
            if name in os.environ:
                env[name] = os.environ[name]
        completed = subprocess.run(
            [sys.executable, str(fixture), str(AGENTS.parent), mode, str(workers)],
            cwd=root,
            env=env,
            capture_output=True,
            timeout=180,
        )
        artifact_dir = os.environ.get("BLACKBOX_TEST_ARTIFACT_DIR")
        if artifact_dir:
            label = mode if workers == 4 else f"{mode}-workers-{workers}"
            retained = Path(artifact_dir) / "closed-recording-archive" / f"{label}.private.log"
            retained.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            retained.write_bytes(completed.stdout + completed.stderr)
            retained.chmod(0o600)
        if workers == 5:
            controls = [
                json.loads(line.split(" ", 1)[1])
                for line in completed.stdout.decode().splitlines()
                if line.startswith("CONCURRENCY_CONTROL ")
            ]
            assert len(controls) == 1 and controls[0] == {"distinct_paths": 71, "attempts": 71, "client_peak": 5}
            assert completed.returncode != 0 and b"unchanged4workers must retain all70 files and original publisher" in completed.stderr
            return
        assert completed.returncode == 0, f"closed recording archive {mode} child failed; private diagnostics retained"
        reports = [json.loads(line) for line in completed.stdout.decode().splitlines() if line.startswith("{")]
        assert len(reports) == 1 and reports[0]["models_tasks_provider_calls"] == 0


async def run_all_tests():
    result = BlackboxResult()
    for mode in (
        "producer",
        "backlog",
        "queued",
        "mutation",
        "failed_ack",
        "foreign_ack",
        "incomplete_ack",
        "byte_budget",
    ):
        result.record(f"closed_recording_archive_{mode}", lambda mode=mode: test_closed_recording_archive_owner(mode))
    result.record(
        "failed_recording_batch_still_publishes_later_files", test_failed_recording_batch_still_publishes_later_files
    )
    result.record(
        "recording_batch_lease_blocks_foreign_process_drain_and_recovers_after_crash",
        test_recording_batch_lease_blocks_foreign_process_drain_and_recovers_after_crash,
    )
    await result.record_async(
        "recording_batch_failure_retains_sources_and_retryable_envelopes",
        test_recording_batch_failure_retains_sources_and_retryable_envelopes,
    )
    result.record(
        "recording_batches_bound_count_bytes_and_preserve_large_sources",
        test_recording_batches_bound_count_bytes_and_preserve_large_sources,
    )
    result.record(
        "recording_archive_worker_exit_has_no_serial_publication_tail",
        test_recording_archive_worker_exit_has_no_serial_publication_tail,
    )
    result.record(
        "closed_recording_archive_rejects_five_client_requests",
        lambda: test_closed_recording_archive_owner("backlog", workers=5),
    )
    return result.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
