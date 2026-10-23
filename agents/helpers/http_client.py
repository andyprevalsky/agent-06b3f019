"""Process-wide pooled HTTP clients for agent-side backend/tool calls.

Opening a fresh ``httpx.AsyncClient`` per call builds a brand-new ``SSLContext``
every time — ``ssl.create_default_context`` parses the whole CA bundle on each
construction. py-spy on a live worker under load attributed **~13.6% of the
single core** to ``create_default_context`` alone, because the codebase opened a
client per HTTP call across ~168 sites. One shared client reuses a single
SSLContext + a keep-alive connection pool for every call, so the CA bundle is
parsed once per worker process instead of once per request. Callers pass
``timeout=`` / ``follow_redirects=`` per-request (httpx supports both on the
request call), so behaviour is unchanged — only the client/SSL setup is shared.

This mirrors the already-shared clients in ``providers/demo_cache/client.py``
(``_shared_client``) and ``helpers/messages.py`` (``_broadcast_client``); this
module generalises the pattern for the tool/domain repos.
"""

from __future__ import annotations

import asyncio
from http.cookiejar import DefaultCookiePolicy
from typing import Dict, Optional, Tuple

import httpx

_clients: Dict[str, Tuple[httpx.AsyncClient, Optional[asyncio.AbstractEventLoop]]] = {}


def _running_loop() -> Optional[asyncio.AbstractEventLoop]:
    try:
        return asyncio.get_running_loop()
    except RuntimeError:
        return None


def _pooled_client(name: str, limits: httpx.Limits) -> httpx.AsyncClient:
    # Pooled connections belong to the event loop that opened them, so a new
    # loop (e.g. a fresh ``asyncio.run``) gets its own client.
    loop = _running_loop()
    cached = _clients.get(name)
    if cached is not None:
        client, client_loop = cached
        if not client.is_closed and (loop is None or loop is client_loop):
            return client
    client = httpx.AsyncClient(limits=limits, timeout=30.0)
    # One client serves every user's and provider's credentials, so a Set-Cookie
    # from one account's response must never ride along on the next account's
    # request. AsyncClient copies a passed-in jar, so set the policy in place.
    client.cookies.jar.set_policy(DefaultCookiePolicy(allowed_domains=[]))
    _clients[name] = (client, loop)
    return client


def get_http_client() -> httpx.AsyncClient:
    """Return the process-wide shared httpx.AsyncClient (lazily created).

    Reuses one SSLContext + connection pool across all callers. Never close it —
    it lives for the worker process lifetime. Pass per-request ``timeout=`` and
    ``follow_redirects=`` on the ``.get()``/``.post()`` call.
    """
    return _pooled_client("default", httpx.Limits(max_connections=200, max_keepalive_connections=50))


def get_streaming_http_client() -> httpx.AsyncClient:
    """Shared client for long-lived streams (LLM completions).

    Streams hold a connection for their whole lifetime, so a bounded pool would
    turn concurrent races into pool-acquisition timeouts. Connections are
    unbounded; only keep-alive reuse is capped.
    """
    return _pooled_client("streaming", httpx.Limits(max_connections=None, max_keepalive_connections=100))
