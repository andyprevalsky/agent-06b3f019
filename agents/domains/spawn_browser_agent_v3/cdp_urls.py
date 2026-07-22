"""Provider-specific CDP URL handling at the browser connection boundary."""

from __future__ import annotations

import os
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


def steel_cdp_connection_url(cdp_url: str) -> str:
    """Materialize a persisted Steel CDP URL without exposing its API key upstream."""
    configured = urlsplit(
        (os.environ.get("STEEL_CONNECT_URL") or "wss://connect.steelbrowser.com").rstrip("/")
    )
    parsed = urlsplit(cdp_url)
    steel_hosts = {configured.netloc, "connect.steel.dev", "connect.steelbrowser.com"}
    if parsed.netloc not in steel_hosts:
        return cdp_url

    api_key = (os.environ.get("STEEL_API_KEY") or "").strip()
    if not api_key:
        raise RuntimeError("STEEL_API_KEY is required to connect to a Steel CDP session")

    query = [
        (key, value)
        for key, value in parse_qsl(parsed.query, keep_blank_values=True)
        if key.lower() != "apikey"
    ]
    query.append(("apiKey", api_key))
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), parsed.fragment))
