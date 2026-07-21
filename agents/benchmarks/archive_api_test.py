import json
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote

from benchmarks import archive_api
from benchmarks.archive_api import (
    ArchiveHandler,
    configure_archive_handler,
    load_archive,
    load_archive_safe,
)


def test_load_archive_maps_benchmark_run_to_agent_detail(tmp_path):
    run_path = tmp_path / "run.json"
    run_path.write_text(
        json.dumps(
            {
                "timestamp": "2026-07-07T23:00:00+00:00",
                "tasks": [
                    {
                        "name": "chat-mode",
                        "passed": True,
                        "agent_id": "agent-1",
                        "duration_seconds": 12.5,
                        "cost_cents": 3.0,
                        "progress_score": 1,
                        "fast_mode_cache_enabled": False,
                        "world_model_mode": "simulate",
                        "logs": {
                            "messages": [
                                {
                                    "role": "USER",
                                    "message": "hello",
                                    "created_at": "2026-07-07T23:00:01Z",
                                },
                                {
                                    "role": "ASSISTANT",
                                    "message": "hi",
                                    "created_at": "2026-07-07T23:00:02Z",
                                    "metadata": {"title": "response"},
                                },
                            ]
                        },
                    }
                ],
            }
        )
    )

    archive = load_archive(run_path)
    entry = archive["agent-1"]

    assert entry.agent["agent_id"] == "agent-1"
    assert entry.agent["status"] == "COMPLETED"
    assert entry.agent["goal"] == "hello"
    assert entry.agent["temporal_workflow_id"] == "benchmark-archive-agent-1"
    assert entry.messages == [
        {
            "message_id": "agent-1-archive-message-0000",
            "timestamp": "2026-07-07T23:00:01Z",
            "text": "hello",
            "role": "USER",
            "metadata": {},
            "file_pointer": None,
        },
        {
            "message_id": "agent-1-archive-message-0001",
            "timestamp": "2026-07-07T23:00:02Z",
            "text": "hi",
            "role": "ASSISTANT",
            "metadata": {"title": "response"},
            "file_pointer": None,
        },
    ]


def test_load_archive_safe_tolerates_missing_and_broken(tmp_path):
    assert load_archive_safe(None) == {}
    assert load_archive_safe(tmp_path / "nope.json") == {}
    broken = tmp_path / "broken.json"
    broken.write_text("{not json")
    assert load_archive_safe(broken) == {}


# --- live upstream proxy -----------------------------------------------------


def _serve(handler_cls) -> tuple[ThreadingHTTPServer, str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def _make_upstream(record: list[dict]):
    class Upstream(BaseHTTPRequestHandler):
        def _handle(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b""
            record.append(
                {
                    "method": self.command,
                    "path": self.path,
                    "api_key": self.headers.get("X-API-Key"),
                    "user_id": self.headers.get("X-User-Id"),
                    "body": body.decode() if body else "",
                }
            )
            payload = json.dumps({"agent": {"agent_id": "live-agent", "status": "ACTIVE"}, "messages": []}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        do_GET = _handle
        do_POST = _handle

        def log_message(self, *_args):
            return

    return Upstream


_DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _get(base: str, path: str) -> tuple[int, dict]:
    try:
        with _DIRECT.open(base + path, timeout=5) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b"{}")


def test_archive_signer_resolves_supabase_storage_relative_url(monkeypatch):
    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self):
            return json.dumps({"signedURL": "/object/sign/attachments/user/replay.html?token=t"}).encode()

    requests = []

    def fake_urlopen(request, timeout):
        requests.append((request, timeout))
        return Response()

    monkeypatch.setenv("SUPABASE_URL", "https://project.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-key")
    monkeypatch.setattr(archive_api.urllib.request, "urlopen", fake_urlopen)

    signed_url = archive_api._create_attachment_signed_url("user/replay.html")

    assert signed_url == ("https://project.supabase.co/storage/v1/object/sign/attachments/user/replay.html?token=t")
    request, timeout = requests[0]
    assert request.full_url == ("https://project.supabase.co/storage/v1/object/sign/attachments/user/replay.html")
    assert timeout == 30


def test_static_archive_signs_captured_wmh_recording_pointer(tmp_path, monkeypatch):
    """A finished run must keep its generated-frame recording playable.

    This pointer shape comes from the captured WMH ecommerce run. The live
    backend is intentionally absent: archive playback has to survive teardown.
    """
    pointer = {
        "id": "61990e52-54cf-421d-adae-4a495089703e",
        "storage_path": (
            "1f85ff25-6e29-4c1b-8739-f917bd101a30/"
            "61990e52-54cf-421d-adae-4a495089703e_browser-recording-"
            "wmh-browser-call_YOZsYPXbhIGlcAopZAC3jbqk.html"
        ),
        "original_filename": "browser-recording-wmh-browser-call_YOZsYPXbhIGlcAopZAC3jbqk.html",
        "mime_type": "text/html",
        "size_bytes": 8236,
    }
    run_path = tmp_path / "run.json"
    run_path.write_text(
        json.dumps(
            {
                "timestamp": "2026-07-20T18:07:34Z",
                "tasks": [
                    {
                        "name": "wmh-browser-call_YOZsYPXbhIGlcAopZAC3jbqk",
                        "passed": True,
                        "agent_id": "2ad9c417-b556-40a7-ab37-02ebf60554ab",
                        "logs": {
                            "messages": [
                                {
                                    "role": "ASSISTANT",
                                    "message": "Browser recording saved",
                                    "metadata": {"recording_file_pointer": pointer},
                                }
                            ]
                        },
                    }
                ],
            }
        )
    )
    signed_paths: list[str] = []

    def fake_sign(storage_path: str) -> str:
        signed_paths.append(storage_path)
        return "https://storage.example/signed/wmh-recording.html?token=test"

    monkeypatch.setattr(archive_api, "_create_attachment_signed_url", fake_sign, raising=False)
    configure_archive_handler(run_path)
    archive, archive_url = _serve(ArchiveHandler)
    try:
        path = (
            "/api/agents/2ad9c417-b556-40a7-ab37-02ebf60554ab/attachments/"
            f"{pointer['id']}/url?storage_path={quote(pointer['storage_path'], safe='')}"
        )
        status, body = _get(archive_url, path)
        assert status == 200
        assert body == {
            "signed_url": "https://storage.example/signed/wmh-recording.html?token=test",
            "expires_in": 3600,
        }
        assert signed_paths == [pointer["storage_path"]]

        wrong_path = path.split("?", 1)[0] + f"?storage_path={quote('another-user/private.html', safe='')}"
        status, body = _get(archive_url, wrong_path)
        assert status == 404
        assert body == {"error": "Archived attachment not found"}
        assert signed_paths == [pointer["storage_path"]]
    finally:
        archive.shutdown()
        configure_archive_handler(None)



def test_upstream_proxy_forwards_agent_reads_with_auth(tmp_path):
    record: list[dict] = []
    upstream, upstream_url = _serve(_make_upstream(record))
    try:
        configure_archive_handler(
            None,
            upstream_url=upstream_url,
            upstream_api_key="test-key",
            upstream_user_id="user-xyz",
        )
        archive, archive_url = _serve(ArchiveHandler)
        try:
            status, body = _get(archive_url, "/api/agents/live-agent")
            assert status == 200
            assert body["agent"]["agent_id"] == "live-agent"
            assert record and record[-1]["path"] == "/api/agents/live-agent"
            assert record[-1]["api_key"] == "test-key"
            assert record[-1]["user_id"] == "user-xyz"
        finally:
            archive.shutdown()
    finally:
        upstream.shutdown()
        configure_archive_handler(None)


def test_upstream_failure_falls_back_to_static_archive(tmp_path):
    run_path = tmp_path / "run.json"
    run_path.write_text(
        json.dumps(
            {
                "timestamp": "2026-07-07T23:00:00+00:00",
                "tasks": [{"name": "chat", "passed": True, "agent_id": "agent-1", "logs": {"messages": []}}],
            }
        )
    )
    # Upstream points at a closed port → connection fails → static archive answers.
    configure_archive_handler(run_path, upstream_url="http://127.0.0.1:1", upstream_api_key="k", upstream_user_id="u")
    archive, archive_url = _serve(ArchiveHandler)
    try:
        status, body = _get(archive_url, "/api/agents/agent-1")
        assert status == 200
        assert body["agent"]["agent_id"] == "agent-1"
    finally:
        archive.shutdown()
        configure_archive_handler(None)


def test_static_stubs_served_without_upstream():
    configure_archive_handler(None, upstream_url="http://127.0.0.1:1")
    archive, archive_url = _serve(ArchiveHandler)
    try:
        status, body = _get(archive_url, "/api/models")
        assert status == 200
        assert body == {"models": []}
        status, health = _get(archive_url, "/health")
        assert health["live"] is True
    finally:
        archive.shutdown()
        configure_archive_handler(None)


def _run_with_tree(agent_root: str = "root-1") -> dict:
    """A benchmark run.json where the root fanned out to 2 sub-agents (logs.tree)."""
    return {
        "timestamp": "2026-07-10T00:00:00+00:00",
        "tasks": [
            {
                "name": "test-mass-agent-run-0",
                "passed": False,
                "agent_id": agent_root,
                "world_model_mode": "real",
                "fast_mode_cache_enabled": True,
                "logs": {
                    "messages": [{"role": "USER", "message": "fan out and research", "created_at": "t0"}],
                    "tree": {
                        agent_root: {
                            "parent_agent_id": None,
                            "goal": "fan out and research",
                            "status": "FAILED",
                            "messages": [{"role": "USER", "message": "fan out and research", "created_at": "t0"}],
                        },
                        "child-a": {
                            "parent_agent_id": agent_root,
                            "goal": "research creator A",
                            "status": "COMPLETED",
                            "messages": [{"role": "ASSISTANT", "message": "A done", "created_at": "t1"}],
                        },
                        "child-b": {
                            "parent_agent_id": agent_root,
                            "goal": "research creator B",
                            "status": "COMPLETED",
                            "messages": [
                                {"role": "ASSISTANT", "message": "B step 1", "created_at": "t2"},
                                {"role": "ASSISTANT", "message": "B step 2", "created_at": "t3"},
                            ],
                        },
                    },
                },
            }
        ],
    }


def test_load_archive_indexes_full_tree(tmp_path):
    run_path = tmp_path / "run.json"
    run_path.write_text(json.dumps(_run_with_tree()))

    archive = load_archive(run_path)
    # root + 2 sub-agents all indexed
    assert set(archive.keys()) == {"root-1", "child-a", "child-b"}
    assert archive["root-1"].agent["parent_agent_id"] is None
    assert archive["root-1"].agent["busId"] == "root-1"
    # sub-agents carry the parent link + the root busId so the FE builds the tree
    assert archive["child-a"].agent["parent_agent_id"] == "root-1"
    assert archive["child-a"].agent["busId"] == "root-1"
    assert archive["child-a"].agent["goal"] == "research creator A"
    # sub-agent transcripts are preserved (this is the whole point of the fix)
    assert [m["text"] for m in archive["child-b"].messages] == ["B step 1", "B step 2"]


def test_tree_endpoint_returns_full_fanout(tmp_path):
    run_path = tmp_path / "run.json"
    run_path.write_text(json.dumps(_run_with_tree()))
    configure_archive_handler(run_path)  # static, no upstream
    archive, archive_url = _serve(ArchiveHandler)
    try:
        # /api/agents/tree?busId=root → the WHOLE tree (root + both children)
        status, body = _get(archive_url, "/api/agents/tree?busId=root-1")
        assert status == 200
        ids = {a["agent_id"] for a in body["agents"]}
        assert ids == {"root-1", "child-a", "child-b"}, ids
        # each sub-agent's messages are reachable (the fan-out renders)
        status, body = _get(archive_url, "/api/agents/child-b")
        assert status == 200
        assert [m["text"] for m in body["messages"]] == ["B step 1", "B step 2"]
    finally:
        archive.shutdown()
        configure_archive_handler(None)


def test_tree_endpoint_backward_compat_root_only(tmp_path):
    # A run.json WITHOUT logs.tree (predates the fix) still serves the lone root.
    run_path = tmp_path / "run.json"
    run_path.write_text(
        json.dumps(
            {
                "timestamp": "t",
                "tasks": [{"name": "x", "passed": True, "agent_id": "solo", "logs": {"messages": []}}],
            }
        )
    )
    configure_archive_handler(run_path)
    archive, archive_url = _serve(ArchiveHandler)
    try:
        status, body = _get(archive_url, "/api/agents/tree?busId=solo")
        assert status == 200
        assert [a["agent_id"] for a in body["agents"]] == ["solo"]
    finally:
        archive.shutdown()
        configure_archive_handler(None)


def test_run_json_hot_reload_promotes_new_agents(tmp_path):
    run_path = tmp_path / "run.json"
    run_path.write_text(json.dumps({"timestamp": "t", "tasks": []}))
    configure_archive_handler(run_path)  # no upstream → pure static
    archive, archive_url = _serve(ArchiveHandler)
    try:
        status, _ = _get(archive_url, "/api/agents/agent-9")
        assert status == 404
        run_path.write_text(
            json.dumps(
                {
                    "timestamp": "t",
                    "tasks": [{"name": "x", "passed": True, "agent_id": "agent-9", "logs": {"messages": []}}],
                }
            )
        )
        status, body = _get(archive_url, "/api/agents/agent-9")
        assert status == 200
        assert body["agent"]["agent_id"] == "agent-9"
    finally:
        archive.shutdown()
        configure_archive_handler(None)
