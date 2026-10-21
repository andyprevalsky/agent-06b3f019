"""A failed fixture must attempt release of every acknowledged owned child."""
import asyncio
from unittest.mock import patch

import httpx
import pytest

from benchmarks import kill_agent_fixture as fixture


def test_partial_prepare_releases_acknowledged_child():
    deleted = []
    posts = []

    def handle(request):
        if request.method == "DELETE":
            deleted.append(request.url.path)
            return httpx.Response(204)
        posts.append(request.url.path)
        return httpx.Response(200, json={"agent_id": "owned-first"}) if len(posts) == 1 else httpx.Response(500)

    client_type = httpx.AsyncClient
    with patch.object(fixture.httpx, "AsyncClient", side_effect=lambda **kw: client_type(transport=httpx.MockTransport(handle), **kw)):
        with pytest.raises(httpx.HTTPStatusError):
            asyncio.run(fixture.prepare("http://localhost:4700", "root", "owner", "test-key", None))
    assert deleted == ["/api/agents/owned-first"]


def test_release_failure_does_not_skip_other_owned_children():
    deleted = []

    def handle(request):
        deleted.append(request.url.path)
        return httpx.Response(500 if request.url.path.endswith("first") else 204)

    client_type = httpx.AsyncClient
    with patch.object(fixture.httpx, "AsyncClient", side_effect=lambda **kw: client_type(transport=httpx.MockTransport(handle), **kw)):
        with pytest.raises(RuntimeError, match="1 owned fixture releases"):
            asyncio.run(fixture.retire_fixture("http://localhost:4700", "test-key", {"agents": [{"agent_id": "first"}, {"agent_id": "second"}]}))
    assert deleted == ["/api/agents/first", "/api/agents/second"]
