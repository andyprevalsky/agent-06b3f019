"""Run with python3 -m unittest discover -s scripts/live_display -p 'test_*.py'."""

import base64
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from server import DisplayServer, update, endpoint


class LiveDisplayTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.state = Path(self.directory.name) / "state.json"
        update(self.state, {})
        self.server = DisplayServer(("127.0.0.1", 0), self.state, "http://127.0.0.1", token="fixture-capability")
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.directory.cleanup()

    def get(self, path):
        return urlopen(self.base + path, timeout=3)

    def test_read_only_capability_and_live_revision(self):
        with self.assertRaises(HTTPError) as error:
            self.get("/wrong/state")
        self.assertEqual(error.exception.code, 404)
        with self.get("/fixture-capability/state") as result:
            self.assertEqual(result.headers["Access-Control-Allow-Origin"], "*")
            before = json.load(result)
        update(self.state, {"prompt": "Rose changed the material", "hue": 37})
        with self.get("/fixture-capability/state") as result:
            after = json.load(result)
        self.assertEqual(after["revision"], before["revision"] + 1)
        self.assertEqual(after["hue"], 37)
        self.assertEqual(after["prompt"], "Rose changed the material")
        with self.assertRaises(HTTPError) as error:
            urlopen(Request(self.base + "/fixture-capability/state", data=b"{}", method="POST"))
        self.assertEqual(error.exception.code, 405)
        with self.assertRaises(HTTPError) as error:
            self.get("/fixture-capability/frame")
        self.assertEqual(error.exception.code, 503)

    def test_native_upstream_protocol_and_no_stale_frame(self):
        received = []
        state = self.state

        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                received.append((self.path, json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
                payload = json.dumps({"base64_image": base64.b64encode(b"\xff\xd8\xfffixture").decode()}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        thread.start()
        try:
            self.server.upstream = f"http://127.0.0.1:{upstream.server_port}"
            with self.get("/fixture-capability/frame") as response:
                frame = json.load(response)
            self.assertEqual(received, [("/api/predict", {"prompt": self.server.state()["prompt"]})])
            self.assertEqual(frame["revision"], self.server.state()["revision"])
            with self.get("/fixture-capability/frame"):
                pass
            self.assertEqual(len(received), 1, "duplicate viewer requests reuse the bounded cache")
            update(state, {"prompt": "new prompt"})
            original = self.server.state
            calls = 0

            def changing_state():
                nonlocal calls
                calls += 1
                if calls == 2:
                    update(state, {"hue": 90})
                return original()

            with patch.object(self.server, "state", changing_state):
                with self.assertRaises(HTTPError) as error:
                    self.get("/fixture-capability/frame")
                self.assertEqual(error.exception.code, 409)
        finally:
            upstream.shutdown()
            upstream.server_close()
            thread.join()

    def test_next_frame_request_never_sees_finished_generation_as_busy(self):
        # Under host load the handler thread can be descheduled after writing a
        # frame. The viewer's next request must not find that finished
        # generation still holding the lock (429).
        class SlowReleaseLock:
            def __init__(self):
                self.inner = threading.Lock()

            def acquire(self, blocking=True):
                return self.inner.acquire(blocking)

            def release(self):
                time.sleep(0.3)
                self.inner.release()

        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                payload = json.dumps({"base64_image": base64.b64encode(b"\xff\xd8\xfffixture").decode()}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        thread.start()
        try:
            self.server.upstream = f"http://127.0.0.1:{upstream.server_port}"
            self.server.predict_lock = SlowReleaseLock()
            for _ in range(2):
                with self.get("/fixture-capability/frame") as response:
                    self.assertEqual(response.status, 200)
        finally:
            upstream.shutdown()
            upstream.server_close()
            thread.join()

    def test_private_modal_provider_never_exposes_credentials(self):
        from types import SimpleNamespace
        import sys

        calls = []
        encoded = base64.b64encode(b"\xff\xd8\xfffixture").decode()
        worker = SimpleNamespace(predict=SimpleNamespace(remote=lambda prompt: {"base64_image": encoded}))
        provider = SimpleNamespace(
            Cls=SimpleNamespace(from_name=lambda app, cls: calls.append((app, cls)) or (lambda: worker))
        )
        self.server.modal_app = "private-display"
        with patch.dict(sys.modules, {"modal": provider}):
            with self.get("/fixture-capability/frame") as response:
                self.assertEqual(json.load(response)["base64_image"], encoded)
        self.assertEqual(calls, [("private-display", "StreamWorker")])
        with self.get("/fixture-capability/state") as response:
            public = json.load(response)
        self.assertTrue(public["diffusionConfigured"])
        self.assertNotIn("modal_app", public)

    def test_validation_keeps_previous_state(self):
        previous = self.state.read_text()
        for change in (
            {"speed": float("nan")},
            {"hue": 361},
            {"mode": "video"},
            {"upstream": "http://wrong"},
            {"prompt": ""},
        ):
            with self.assertRaises(ValueError):
                update(self.state, change)
            self.assertEqual(previous, self.state.read_text())
        for value in ("file:///x", "https://user:secret@host", "https://host/?token=secret"):
            with self.assertRaises(ValueError):
                endpoint(value)
        with self.get("/fixture-capability") as response:
            html = response.read().decode()
        self.assertIn("http://127.0.0.1/fixture-capability", html)
        self.assertNotIn("__DISPLAY_BASE__", html)
        self.assertNotIn("api_key", html)


if __name__ == "__main__":
    unittest.main()
