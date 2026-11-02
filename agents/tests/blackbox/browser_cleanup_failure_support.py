"""Execute the exact-session close helper with native HTTP effects mocked."""
import ast
import asyncio
from pathlib import Path
import socket
from types import SimpleNamespace
from typing import Any, Dict, List, Optional
from unittest.mock import patch


async def assert_browser_cleanup_failure_boundaries():
    source = Path(__file__).resolve().parents[3] / "agents/domains/spawn_browser_agent_v3/repo.py"
    tree = ast.parse(source.read_text())
    selected = [node for node in tree.body if isinstance(node, (ast.ClassDef, ast.AsyncFunctionDef))
                and node.name in ("BrowserSessionCloseError", "close_browser_session")]
    network = []
    calls = []
    mode = 200

    class Sealed(Exception):
        pass

    class Client:
        def __init__(self, **kwargs):
            assert kwargs == {"timeout": 60.0}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def post(self, url, **kwargs):
            calls.append((url, kwargs))
            if mode == "sealed":
                raise Sealed()
            if mode == "cancelled":
                raise asyncio.CancelledError()
            if mode == "transport":
                raise OSError("owned offline transport failure")
            return SimpleNamespace(status_code=mode)

    namespace = dict(Any=Any, Dict=Dict, List=List, Optional=Optional, httpx=SimpleNamespace(AsyncClient=Client),
                     WorkflowGenerationSealed=Sealed, logger=SimpleNamespace(warning=lambda *args: None))
    exec(compile(ast.fix_missing_locations(ast.Module(body=selected, type_ignores=[])), "exact-close-helper", "exec"), namespace)
    config = SimpleNamespace(backend=SimpleNamespace(api_url="http://offline.invalid", api_key="offline"))

    def forbidden(*args, **kwargs):
        network.append(True)
        raise AssertionError("unexpected network in close fixture")

    with patch.object(socket.socket, "connect", forbidden):
        for mode in (200, 500, 409, "transport", "sealed", "cancelled"):
            for pause in (False, True):
                calls.clear()
                error = None
                try:
                    await namespace["close_browser_session"](config, "exact-owned-session", pause, "https://page.invalid/")
                except BaseException as caught:
                    error = caught
                assert calls == [("http://offline.invalid/api/browser-session/close", {
                    "headers": {"x-api-key": "offline"},
                    "json": {"session_id": "exact-owned-session", "pause": pause, "current_url": "https://page.invalid/"},
                })], calls
                if mode == 200:
                    assert error is None
                elif mode == "sealed":
                    assert isinstance(error, Sealed)
                elif mode == "cancelled":
                    assert isinstance(error, asyncio.CancelledError)
                else:
                    assert error is not None and type(error).__name__ == "BrowserSessionCloseError"
                    assert error.receipt() == {"status": "failed", "session_id": "exact-owned-session", "pause": pause,
                                               "http_status": mode if isinstance(mode, int) else None}
    assert not network, "network attempted, including swallowed exceptions"
