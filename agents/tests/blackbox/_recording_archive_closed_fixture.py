import asyncio
import base64
import importlib.util
import json
import logging
import os
import queue
import resource
import sys
import tempfile
import threading
import time
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

os.umask(0o077)
AGENTS = Path(os.environ.get("FIXTURE_AGENTS_PATH", str(Path(__file__).resolve().parents[2])))
REPO = AGENTS.parent
SOURCE = Path(sys.argv[1])
MODE = sys.argv[2]
ARCHIVE_WORKERS = int(sys.argv[3]) if len(sys.argv) > 3 else 4
assert ARCHIVE_WORKERS in (4, 5), "fixture worker controls are four or five"
sys.path.insert(0, str(REPO / "agents"))
from tests.env_defaults import apply_test_env_defaults  # noqa: E402

apply_test_env_defaults()
logging.disable(logging.CRITICAL)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


async def main():
    with tempfile.TemporaryDirectory(prefix="rose-eager-closed-control-") as tmp:
        root = Path(tmp)
        directory = root / "recording"
        (directory / "network").mkdir(parents=True)
        accepted = {}
        calls = Counter()
        errors = []
        first = threading.Event()
        allow_first = threading.Event()
        next_request = queue.Queue()
        allow = threading.Event()
        active = 0
        peak_active = 0
        server_active = 0
        request_count = 0
        four_started = threading.Event()
        lock = threading.Lock()
        if MODE not in ["backlog", "queued", "mutation", "byte_budget"]:
            allow.set()

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                nonlocal server_active, request_count
                with lock:
                    server_active += 1
                    request_count += 1
                    ordinal = request_count
                    if server_active == ARCHIVE_WORKERS:
                        four_started.set()
                try:
                    assert self.path in ["/api/archive/artifacts", "/api/archive/artifact"]
                    body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    assert body["rootAgentId"] == "offline-root"
                    artifacts = body["artifacts"] if self.path.endswith("/artifacts") else [body]
                    assert len(artifacts) <= 256
                    refs = []
                    for item in artifacts:
                        plaintext = archive.decrypt_and_validate_artifact(
                            base64.b64decode(item["ciphertextB64"]), item["metadata"]
                        )
                        with lock:
                            accepted[item["path"]] = plaintext
                            calls[item["path"]] += 1
                        refs.append({"path": item["path"], "ref": "fixture/" + item["path"]})
                    first.set()
                    if MODE == "backlog" and ordinal == 1:
                        assert allow_first.wait(60)
                    else:
                        if MODE == "backlog" and ordinal > ARCHIVE_WORKERS:
                            next_request.put(self.path)
                        assert allow.wait(60)
                    if MODE == "failed_ack" and sum(calls.values()) == 1:
                        self.send_response(500)
                        self.end_headers()
                        return
                    if MODE == "profile":
                        time.sleep(0.04 * ((len(artifacts) + 3) // 4))
                    if MODE in ["foreign_ack", "incomplete_ack"] and sum(calls.values()) == 1:
                        refs = (
                            [{"path": "media/browser/foreign-task/not-owned.json", "ref": "fixture/foreign"}]
                            if MODE == "foreign_ack"
                            else []
                        )
                    payload = json.dumps(
                        {"artifacts": refs} if self.path.endswith("/artifacts") else {"ref": refs[0]["ref"]}
                    ).encode()
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                except Exception as exc:
                    errors.append(type(exc).__name__)
                    self.send_response(500)
                    self.end_headers()
                finally:
                    with lock:
                        server_active -= 1

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        os.environ.update(
            {
                "TRACE_ARCHIVE_ENABLED": "1",
                "TRACE_ARCHIVE_BACKEND": "r2",
                "TRACE_ARCHIVE_ASYNC_WRITES": "1",
                "TRACE_ARCHIVE_WORKERS": str(ARCHIVE_WORKERS),
                "TRACE_ARCHIVE_MAX_IN_FLIGHT": "64",
                "TRACE_ARCHIVE_ENCRYPTION_KEY_B64": base64.b64encode(b"x" * 32).decode(),
                "TRACE_ARCHIVE_LOCAL_ROOT": str(root / "trace"),
                "BACKEND_API_URL": "http://127.0.0.1:" + str(server.server_port),
                "BACKEND_API_KEY": "offline-fixture-key",
            }
        )
        # A complete response lets a client worker proceed before the server
        # handler retires. Count the actual nonstreaming request lifetime,
        # rather than that asynchronously retiring handler's lifetime.
        import httpx
        native_send = httpx.Client.send

        def observed_send(client, request, *args, **kwargs):
            nonlocal active, peak_active
            assert not kwargs.get("stream", False), "fixture measures full response consumption"
            with lock:
                active += 1
                peak_active = max(peak_active, active)
            try:
                return native_send(client, request, *args, **kwargs)
            finally:
                with lock:
                    active -= 1

        httpx.Client.send = observed_send
        archive = load("helpers.trace_archive", SOURCE / "agents/helpers/trace_archive.py")
        recording = load(
            "domains.spawn_browser_agent_v3.recording", SOURCE / "agents/domains/spawn_browser_agent_v3/recording.py"
        )
        assert archive._BATCH_MAX_BYTES == 64 * 1024 * 1024
        assert archive._BATCH_MAX_RECORDS == 256
        if MODE in ["backlog", "queued", "mutation", "failed_ack", "foreign_ack", "incomplete_ack", "byte_budget"]:
            archive._BATCH_MAX_RECORDS = 1
        elif MODE == "profile":
            archive._BATCH_MAX_RECORDS = 4
        if MODE == "byte_budget":
            archive._BATCH_MAX_BYTES = 256 * 1024
        body = json.dumps({"value": "offline fixture " * (20 if MODE == "producer" else 3000)})
        cdp_calls = []

        async def getResponseBody(*, params, session_id):
            cdp_calls.append(params["requestId"])
            return {"body": body, "base64Encoded": False}

        client = SimpleNamespace(send=SimpleNamespace(Network=SimpleNamespace(getResponseBody=getResponseBody)))
        recorder = recording.BrowserNetworkRecorder(
            browser_session=SimpleNamespace(),
            agent_id="offline-root",
            task_id="offline-task",
            session_id="offline-session",
            output_dir=directory,
        )
        count = {
            "producer": 256,
            "backlog": 70,
            "queued": 8,
            "mutation": 1,
            "failed_ack": 1,
            "foreign_ack": 1,
            "incomplete_ack": 1,
            "byte_budget": 8,
            "profile": 24,
        }[MODE]
        started = time.monotonic()
        bytes_peak = 0
        terminal_task = None
        try:
            if MODE == "queued":
                for index in range(4):
                    assert (
                        archive.archive_json(
                            root_agent_id="offline-root",
                            path="llm/preexisting-" + str(index) + ".json.gz.enc",
                            payload={"fixture": True},
                        )
                        is not None
                    )
                assert await asyncio.to_thread(four_started.wait, 60)
                original_active = archive._pending_archive_futures("offline-root")
                assert len(original_active) == 4 and all(future.running() for future in original_active)
            for index in range(count):
                request = "request-" + str(index)
                recorder.entries[request] = {
                    "mime_type": "application/json",
                    "status": 200,
                    "resource_type": "XHR",
                    "url": "https://offline.invalid/data",
                    "browser_generation": 0,
                }
                await recorder._fetch_response_body(request, request, "offline-session", client)
                if hasattr(archive, "_ARCHIVE_WORKERS"):
                    assert len(archive._CLOSED_FILE_FUTURES) <= archive._ARCHIVE_WORKERS
                if MODE == "profile":
                    await asyncio.sleep(0.05)
            paths = sorted((directory / "network").iterdir())
            assert len(paths) == count and len(cdp_calls) == count
            assert all(recorder._bodies.get("request-" + str(index)) == body for index in range(count))
            if MODE == "producer":
                assert archive._pending_archive_futures("offline-root") or first.is_set(), (
                    "closed native producer must publish a full bounded batch while recording remains live"
                )
                assert await asyncio.to_thread(first.wait, 60)
                assert not recorder._closed and await asyncio.to_thread(
                    archive.flush_archive_writes, "offline-root", 60
                )
                assert request_count == 1 and sum(calls.values()) == 256, "native256 files must preserve one batch"
            elif MODE == "queued":
                queued = tuple(archive._CLOSED_FILE_FUTURES)
                assert queued and all(not future.running() for future in queued)
                assert (
                    archive.archive_json(
                        root_agent_id="offline-root",
                        path="llm/new-original-publisher.json.gz.enc",
                        payload={"fixture": True},
                    )
                    is not None
                )
                assert all(future.cancelled() for future in queued), (
                    "queued optional copies must yield before original work even when slots are free"
                )
                assert not any(future.cancelled() for future in original_active)
                allow.set()
                assert await asyncio.to_thread(archive.flush_archive_writes, "offline-root", 60)
            elif MODE == "backlog":
                assert await asyncio.to_thread(four_started.wait, 60)
                assert len(archive._pending_archive_futures("offline-root")) <= 64
                original = archive.archive_json(
                    root_agent_id="offline-root", path="llm/original-publisher.json.gz.enc", payload={"fixture": True}
                )
                assert original is not None
                allow_first.set()
                observed_next = await asyncio.to_thread(next_request.get, True, 60)
                assert observed_next == "/api/archive/artifact", (
                    "original publisher must execute next after currently active I/O, without queued eager batches ahead"
                )
                allow.set()
                assert await asyncio.to_thread(archive.flush_archive_writes, "offline-root", 60)
            elif MODE == "mutation":
                assert await asyncio.to_thread(first.wait, 60)
                paths[0].write_text(json.dumps({"value": "changed closed source fixture"}))
                terminal_task = asyncio.create_task(
                    asyncio.to_thread(recording._archive_recording_directory, directory, "offline-root", "offline-task")
                )
                await asyncio.sleep(0.05)
                assert not terminal_task.done(), "inflight publication must join before mutable fallback"
                allow.set()
                assert await terminal_task
                assert sum(calls.values()) == 2, (
                    "changed source requires a real final upload after original inflight ACK"
                )
            elif MODE == "byte_budget":
                assert await asyncio.to_thread(first.wait, 60)
                bytes_peak = archive._CLOSED_FILE_BYTES_IN_FLIGHT
                assert 0 < bytes_peak <= archive._BATCH_MAX_BYTES
                assert peak_active == 1, "scaled byte bound must block other existing workers before body allocation"
                allow.set()
                assert await asyncio.to_thread(archive.flush_archive_writes, "offline-root", 60)
                assert archive._CLOSED_FILE_BYTES_IN_FLIGHT == 0
            elif MODE in ["failed_ack", "foreign_ack", "incomplete_ack"]:
                pending = archive._pending_archive_futures("offline-root")
                for future in pending:
                    await asyncio.to_thread(future.result)
                assert archive._root_outbox_has_artifacts("offline-root"), (
                    "refused ACK leaves actual encrypted pairs durable"
                )
            before_close = time.monotonic()
            before = sum(calls.values())
            recorder._closed = True
            if MODE != "mutation":
                assert await asyncio.to_thread(
                    recording._archive_recording_directory, directory, "offline-root", "offline-task"
                )
            finished = time.monotonic()
            expected = {
                "media/browser/offline-task/" + path.relative_to(directory).as_posix(): path.read_bytes()
                for path in directory.rglob("*")
                if path.is_file()
            }
            for key, value in expected.items():
                assert accepted.get(key) == value
            assert (
                not archive._root_outbox_has_artifacts("offline-root")
                and not archive._pending_archive_futures("offline-root")
                and not errors
            )
            assert (
                not getattr(archive, "_CLOSED_FILE_FUTURES", ())
                and getattr(archive, "_CLOSED_FILE_BYTES_IN_FLIGHT", 0) == 0
            )
            restored = [archive._ARCHIVE_SLOTS.acquire(blocking=False) for _ in range(65)]
            assert restored == [True] * 64 + [False], "all64 original slots return exactly once"
            for _ in range(64):
                archive._ARCHIVE_SLOTS.release()
            if MODE in ["failed_ack", "foreign_ack", "incomplete_ack"]:
                assert sum(calls.values()) == 2, "unacknowledged source must follow ordinary terminal fallback"
            if MODE == "producer":
                assert request_count == 1 and sum(calls.values()) == 256 and sum(calls.values()) == before
            if MODE == "queued":
                assert len(calls) == 13 and sum(calls.values()) == 13, (
                    "all eight original source files and five original publishers retain exact publication"
                )
            if MODE in ("backlog"):
                assert sum(calls.values()) == 71, "backlog must not duplicate accepted artifacts"
                print(
                    "CONCURRENCY_CONTROL "
                    + json.dumps({"distinct_paths": len(calls), "attempts": sum(calls.values()), "client_peak": peak_active}),
                    flush=True,
                )
                assert len(calls) == 71 and peak_active <= 4, (
                    "unchanged4workers must retain all70 files and original publisher"
                )
            if MODE == "byte_budget":
                assert sum(calls.values()) == count
            if MODE == "profile":
                assert request_count == 6, "same24 files preserve existing four-record fixture batch cardinality"
            print(
                json.dumps(
                    {
                        "control": MODE,
                        "file_count": count,
                        "cdp_calls": len(cdp_calls),
                        "fixture_plaintext_bytes": sum(map(len, expected.values())),
                        "native_http_artifact_attempts": sum(calls.values()),
                        "native_http_peak_requests": peak_active,
                        "native_http_requests": request_count,
                        "scaled_wire_budget_peak_bytes": bytes_peak,
                        "max_rss_native_units": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                        "rss_units": "bytes onDarwin",
                        "generation_seconds": before_close - started,
                        "terminal_seconds": finished - before_close,
                        "whole_seconds": finished - started,
                        "attempts_before_close": before,
                        "terminal_attempts": sum(calls.values()) - before,
                        "full_plaintext_equal": True,
                        "outbox_empty": True,
                        "existing4workers64slots": True,
                        "original_next_after_active_io": MODE == "backlog",
                        "queued_cancellations": len(queued) if MODE == "queued" else 0,
                        "production_R2_latency_measured": False,
                        "fixture_transport_delay_only": MODE == "profile",
                        "models_tasks_provider_calls": 0,
                    }
                )
            )
        finally:
            allow_first.set()
            allow.set()
            if terminal_task:
                await asyncio.gather(terminal_task, return_exceptions=True)
            archive._ARCHIVE_EXECUTOR.shutdown(wait=True)
            server.shutdown()
            server.server_close()
            thread.join(timeout=60)


asyncio.run(main())
