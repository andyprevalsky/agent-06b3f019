"""Compact real HTTP control for publication before exact-owner cleanup."""

import asyncio
import json
import os
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from benchmarks import hub_upload
from benchmarks import outcome_publication as publication


def test_outcome_publication_http_ownership_and_terminal_fence(tmp_path, monkeypatch):
    root = Path(__file__).resolve().parents[2]
    context = tmp_path / "guest/repo/.context/cloudbench"
    context.mkdir(parents=True)
    token, machine, bearer, parent = "fixture-token", "a" * 14, "fixture-bearer", "fixture-parent"
    monkeypatch.setenv("BENCHMARK_HUB_PARENT_RUN_ID", parent)
    monkeypatch.setenv("FLY_MACHINE_ID", machine)
    monkeypatch.setenv("CLOUDBENCH_BARRIER_TOKEN", bearer)
    result = SimpleNamespace(name="fixture-task", passed=True, agent_id="00000000-0000-4000-8000-000000000001")
    prepared = publication.prepare(result, context, token)
    assert prepared is not None
    ack, signature = prepared
    pending = context / f"cloudbench-outcome-{token}.pending.json"
    packet = json.loads(pending.read_text())
    ready = tmp_path / "ready.json"
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    server = subprocess.Popen(
        [
            sys.executable,
            str(root / "scripts/cloudbench-status-server.py"),
            "--directory",
            str(tmp_path / "guest"),
            "--bind",
            "127.0.0.1",
            "--port",
            str(port),
            "--run-token",
            token,
            "--ready-file",
            str(ready),
        ],
        env=dict(os.environ),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    stored_live = False

    class Hub(BaseHTTPRequestHandler):
        def do_POST(self):
            import gzip

            raw = self.rfile.read(int(self.headers["Content-Length"]))
            bundle = json.loads(gzip.decompress(raw))
            # The supported Hub summary preserves immutable run/campaign identity.
            body = json.dumps({"run": {**bundle, "run_id": parent, "live": stored_live}}).encode()
            self.send_response(201)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    hub = ThreadingHTTPServer(("127.0.0.1", 0), Hub)
    thread = threading.Thread(target=hub.serve_forever, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 10
        while not ready.exists():
            assert server.poll() is None and time.monotonic() < deadline, "status server never became ready"
            time.sleep(0.05)
        assert int(ready.read_text()) == port

        def request(value, *, auth=bearer, owner=token, guest=machine):
            req = Request(
                f"http://127.0.0.1:{port}/outcome-published",
                data=json.dumps(value).encode(),
                headers={
                    "Authorization": "Bearer " + auth,
                    "X-Cloudbench-Run-Token": owner,
                    "X-Cloudbench-Machine-Id": guest,
                },
                method="POST",
            )
            try:
                with urlopen(req, timeout=5) as response:
                    return response.status
            except HTTPError as error:
                error.close()
                return error.code

        for changes in ({"auth": "foreign"}, {"owner": "foreign"}, {"guest": "b" * 14}):
            assert request(packet, **changes) in (403, 409)
            assert not ack.exists()
        assert request(dict(packet, status="failed")) == 409 and not ack.exists()
        for version in (True, 1.0):
            assert request(dict(packet, version=version)) == 409 and not ack.exists()
        pending.write_text(json.dumps(dict(packet, agent_id="foreign-agent")))
        assert request(packet) == 409 and not ack.exists()
        pending.write_text(json.dumps(packet))
        out = tmp_path / result.name
        out.mkdir()
        (out / "runtime-evidence.owner.json").write_text(json.dumps({"run_token": token, "machine_id": machine}))
        (out / "status-proxy.port").write_text(str(port))
        card = {
            "per_task": [
                {
                    "name": result.name,
                    "status": "passed",
                    "agent_url": f"https://www.roselabs.ai/?agent-id={result.agent_id}&view=bench",
                    "outcome_sha256": signature,
                }
            ]
        }
        monkeypatch.setenv("BENCHMARK_HUB_API_KEY", "fixture-key")
        monkeypatch.setenv("BENCHMARK_HUB_UPLOAD_URL", f"http://127.0.0.1:{hub.server_port}")
        state = tmp_path / "published.json"
        assert not hub_upload.publish_live_report_card(card, run_id=parent, state_path=state)
        assert not state.exists() and not ack.exists(), "a fenced terminal no-op cannot acknowledge publication"
        stored_live = True
        assert hub_upload.publish_live_report_card(card, run_id=parent, state_path=state)
        assert not ack.exists(), "Hub storage must precede the guest acknowledgment"
        publication.acknowledge_published(card, run_id=parent, fleet_dir=tmp_path)
        assert ack.read_text().strip() == signature
        assert (out / "hub-outcome-published.ack").read_text().strip() == signature
        asyncio.run(publication.wait_for_publication(prepared))
    finally:
        server.terminate()
        server.wait(timeout=10)
        hub.shutdown()
        hub.server_close()
        thread.join(timeout=10)
        assert server.poll() is not None and not thread.is_alive()


def test_outcome_wait_preserves_cancellation_and_warning(tmp_path, monkeypatch, capsys):
    pending = (tmp_path / "absent.ack", "expected")

    async def cancelled(_seconds):
        raise asyncio.CancelledError

    monkeypatch.setattr(publication.asyncio, "sleep", cancelled)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(publication.wait_for_publication(pending))
    clock = iter((0, 61))
    monkeypatch.setattr(publication, "time", SimpleNamespace(monotonic=lambda: next(clock, 61)))
    asyncio.run(publication.wait_for_publication(pending))
    assert "continuing exact resource cleanup" in capsys.readouterr().out
