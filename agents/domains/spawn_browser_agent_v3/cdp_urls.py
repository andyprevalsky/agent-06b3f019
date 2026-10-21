"""Provider-specific CDP URL handling at the browser connection boundary."""

from __future__ import annotations

import os
from typing import Any, Awaitable, Callable, Optional, Tuple
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


def steel_cdp_connection_url(cdp_url: str) -> str:
    """Materialize a persisted Steel CDP URL without exposing its API key upstream."""
    configured = urlsplit(
        (os.environ.get("STEEL_CONNECT_URL") or "wss://connect.steel.dev").rstrip("/")
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


_TILION_DEFAULT_BASE_URL = "https://back.tilion.dev"
_SECRET_QUERY_KEYS = frozenset({"token", "apikey", "api_key", "jwt"})


def _tilion_hosts() -> set:
    configured = urlsplit((os.environ.get("TILION_BASE_URL") or _TILION_DEFAULT_BASE_URL).strip())
    hosts = {"back.tilion.dev"}
    if configured.hostname:
        hosts.add(configured.hostname.lower())
    return hosts


def is_tilion_cdp_url(cdp_url: str) -> bool:
    """Tilion session CDP endpoint: ``wss://<tilion host>/v1/session/<id>/cdp?token=...``."""
    parsed = urlsplit(cdp_url or "")
    return (
        parsed.scheme in {"ws", "wss"}
        and (parsed.hostname or "").lower() in _tilion_hosts()
        and parsed.path.startswith("/v1/session/")
        and parsed.path.endswith("/cdp")
    )


def redact_cdp_url(cdp_url: str) -> str:
    """Log-safe CDP URL: secret query values (Tilion ``token``, Steel ``apiKey``) are masked."""
    parsed = urlsplit(cdp_url or "")
    if not parsed.query:
        return cdp_url or ""
    query = [
        (key, "REDACTED" if key.lower() in _SECRET_QUERY_KEYS else value)
        for key, value in parse_qsl(parsed.query, keep_blank_values=True)
    ]
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), parsed.fragment))


async def open_browser_cdp_connection(
    cdp_url: str,
    *,
    label: str = "",
    refresh_url: Optional[Callable[[], Awaitable[Optional[str]]]] = None,
) -> Tuple[str, Optional[Any]]:
    """Return ``(url to connect local CDP clients to, multiplexer or None)``.

    Tilion admits one CDP client per session, so its URL (token intact) is held
    by one loopback multiplexer that browser-use and Playwright both attach to.
    The caller owns the returned multiplexer and closes it with its DOMService.
    ``refresh_url`` mints a fresh connect URL when a redial finds the token
    expired (Tilion tokens last 1800 s).
    Other providers connect directly, as before.
    """
    if not is_tilion_cdp_url(cdp_url):
        return steel_cdp_connection_url(cdp_url), None
    from browser_tools.cdp_multiplexer import SingleCdpConnectionMultiplexer

    multiplexer = SingleCdpConnectionMultiplexer(cdp_url, label=label, refresh_url=refresh_url)
    return await multiplexer.start(), multiplexer
