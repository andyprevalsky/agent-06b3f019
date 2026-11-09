"""Pure failure-message checks; no browser, provider, or process is launched."""
import ast
import asyncio
import inspect
import json
from pathlib import Path
from types import SimpleNamespace
import time
import unittest
from unittest.mock import patch


class ReleaseDiagnostic(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).resolve().parents[1] / "blackbox/browser_tilion.blackbox.py"
        tree = ast.parse(source.read_text())
        helper = next(n for n in tree.body if isinstance(n, ast.FunctionDef)
                      and n.name == "_multiplexer_release_failure")
        target = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef)
                      and n.name == "test_multiplexer_releases_upstream_when_clients_leave_and_reattaches")
        self.assertion = next(n for n in ast.walk(target) if isinstance(n, ast.Assert)
                              and isinstance(n.msg, ast.Call)
                              and getattr(n.msg.func, "id", None) == helper.name)
        self.namespace = {"asyncio": asyncio, "json": json, "time": time}
        exec(compile(ast.Module(body=[helper], type_ignores=[]), str(source), "exec"), self.namespace)
        self.observe = self.namespace[helper.name]
        ws = SimpleNamespace(state=SimpleNamespace(name="OPEN"), close_code=1000,
                             transport=SimpleNamespace(is_closing=lambda: False),
                             url="https://secret.invalid/token")
        self.gateway = SimpleNamespace(active=1, accepted=2, rejected_4409=0, _sockets=[ws])
        self.mux = SimpleNamespace(_upstream=ws, _upstream_lock=SimpleNamespace(locked=lambda: True),
                                   _clients=[SimpleNamespace(number=1, websocket=ws)])

    def test_failure_shape_uses_only_native_state_and_code_frames(self):
        frame = inspect.currentframe()
        class Task:
            def get_stack(self): return [frame]
            def get_name(self): raise AssertionError("secret URL task name must not be read")
            def get_coro(self): raise AssertionError("coroutine repr must not be read")
        with patch.object(asyncio, "all_tasks", return_value=[Task()]):
            message = self.observe(self.gateway, self.mux, 2)
        self.assertTrue(message.startswith("round 2: slot not released; "))
        data = json.loads(message.split("; ", 1)[1])
        self.assertEqual(data["gateway_sockets"][0]["state"], "OPEN")
        self.assertEqual(data["upstream"]["close_code"], 1000)
        self.assertTrue(data["upstream_lock"])
        self.assertEqual(data["clients"][0]["number"], 1)
        self.assertEqual(set(data["tasks"][0]["frames"][0]), {"function", "line"})
        self.assertNotIn("secret.invalid", message)
        self.assertNotIn("url", data)
        self.assertIsInstance(data["observed_at"], float)
        self.assertIsInstance(data["monotonic"], float)

    def test_failed_collection_retains_original_assertion(self):
        class Broken:
            @property
            def state(self): raise RuntimeError("do not log secrets from this exception")
        self.mux._upstream = Broken()
        code = compile(ast.Module(body=[self.assertion], type_ignores=[]), "original-release-assertion", "exec")
        with self.assertRaisesRegex(AssertionError, "^round 2: slot not released; diagnostic unavailable$"):
            exec(code, {**self.namespace, "gateway": self.gateway, "multiplexer": self.mux,
                        "round_number": 2})
        with patch.object(asyncio, "all_tasks", side_effect=KeyboardInterrupt("not logged")):
            self.mux._upstream = None
            self.assertEqual(self.observe(self.gateway, self.mux, 2),
                             "round 2: slot not released; diagnostic unavailable")

    def test_success_does_not_collect_diagnostics(self):
        self.gateway.active = 0
        code = compile(ast.Module(body=[self.assertion], type_ignores=[]), "original-release-assertion", "exec")
        def forbidden(*_args): raise AssertionError("success path collected diagnostics")
        exec(code, {**self.namespace, "gateway": self.gateway, "multiplexer": self.mux,
                    "round_number": 2, "_multiplexer_release_failure": forbidden})


if __name__ == "__main__":
    unittest.main()
