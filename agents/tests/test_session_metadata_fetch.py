"""Exercise the actual repo HTTP function without importing live provider clients."""
import ast
import os
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict

import httpx
import pytest


@pytest.mark.asyncio
async def test_metadata_query_preserves_live_check_and_legacy_default(monkeypatch):
    source = Path(os.environ.get('SESSION_REPO_SOURCE', str(Path(__file__).resolve().parents[1] / 'domains/spawn_browser_agent_v3/repo.py')))
    tree = ast.parse(source.read_text())
    node = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == 'fetch_session_info')
    namespace = {'Any': Any, 'Dict': Dict, 'httpx': httpx}
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(source), 'exec'), namespace)
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={'session_id': 'same-session', 'passwords': [], 'passkeys': []})

    real_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kw: real_client(transport=httpx.MockTransport(respond), **kw))
    config = SimpleNamespace(backend=SimpleNamespace(api_url='https://offline.invalid', api_key='test-key'))
    fetch = namespace['fetch_session_info']
    assert (await fetch(config, 'task', validate_live=True, include_credentials=False))['session_id'] == 'same-session'
    assert dict(requests[-1].url.params) == {'validateLive': 'true', 'includeCredentials': 'false'}
    assert requests[-1].headers['x-api-key'] == 'test-key'
    await fetch(config, 'task')
    assert not requests[-1].url.params
    await fetch(config, 'task', validate_live=True)
    assert dict(requests[-1].url.params) == {'validateLive': 'true'}
