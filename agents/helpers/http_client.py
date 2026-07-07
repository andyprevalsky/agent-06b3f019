"""Process-wide pooled HTTP client for agent-side backend/tool calls.

Opening a fresh ``httpx.AsyncClient`` per call builds a brand-new ``SSLContext``
every time — ``ssl.create_default_context`` parses the whole CA bundle on each
construction. py-spy on a live worker under load attributed **~13.6% of the
single core** to ``create_default_context`` alone, because the codebase opened a
client per HTTP call across ~168 sites. One shared client reuses a single
SSLContext + a keep-alive connection pool for every call, so the CA bundle is
parsed once per worker process instead of once per request. Callers pass
``timeout=`` / ``follow_redirects=`` per-request (httpx supports both on the
request call), so behaviour is unchanged — only the client/SSL setup is shared.

This mirrors the already-shared clients in ``providers/fast_cache/client.py``
(``_shared_client``) and ``helpers/messages.py`` (``_broadcast_client``); this
module generalises the pattern for the tool/domain repos.
"""

from __future__ import annotations

from typing import Optional

import httpx

_client: Optional[httpx.AsyncClient] = None


def get_http_client() -> httpx.AsyncClient:
    """Return the process-wide shared httpx.AsyncClient (lazily created).

    Reuses one SSLContext + connection pool across all callers. Never close it —
    it lives for the worker process lifetime. Pass per-request ``timeout=`` and
    ``follow_redirects=`` on the ``.get()``/``.post()`` call.
    """
    global _client  # noqa: PLW0603
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            # Bounded, keep-alive pool. One SSLContext is built here (once) and
            # reused for every connection this client makes.
            limits=httpx.Limits(max_connections=200, max_keepalive_connections=50),
            # Sensible default for callers that don't pass a per-request timeout;
            # hot callers override with their own timeout= on the request.
            timeout=30.0,
        )
    return _client
