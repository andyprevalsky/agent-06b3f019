"""Provider-specific CDP URL handling at the browser connection boundary."""

from __future__ import annotations

import os
import re
from typing import Any, Awaitable, Callable, Dict, Optional, Tuple
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# Pure, dependency-free redaction lives in utils (importable from every layer);
# re-exported here for existing callers.
from utils.url_redaction import is_tilion_host, redact_cdp_url, redact_url_secrets

__all__ = [
    "is_tilion_cdp_url",
    "open_browser_cdp_connection",
    "redact_cdp_url",
    "redact_url_secrets",
    "steel_cdp_connection_url",
    "tilion_live_view_session_id",
]


def steel_cdp_connection_url(cdp_url: str) -> str:
    """Materialize a persisted Steel CDP URL without exposing its API key upstream."""
    configured = urlsplit((os.environ.get("STEEL_CONNECT_URL") or "wss://connect.steel.dev").rstrip("/"))
    parsed = urlsplit(cdp_url)
    steel_hosts = {configured.netloc, "connect.steel.dev", "connect.steelbrowser.com"}
    if parsed.netloc not in steel_hosts:
        return cdp_url

    api_key = (os.environ.get("STEEL_API_KEY") or "").strip()
    if not api_key:
        raise RuntimeError("STEEL_API_KEY is required to connect to a Steel CDP session")

    query = [(key, value) for key, value in parse_qsl(parsed.query, keep_blank_values=True) if key.lower() != "apikey"]
    query.append(("apiKey", api_key))
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), parsed.fragment))


def is_tilion_cdp_url(cdp_url: str) -> bool:
    """Tilion session CDP endpoint: ``wss://<tilion host>/v1/session/<id>/cdp?token=...``.

    The host is the deployment or one of its regional subdomains (see ``is_tilion_host``).
    """
    parsed = urlsplit(cdp_url or "")
    return (
        parsed.scheme in {"ws", "wss"}
        and is_tilion_host(parsed.hostname)
        and parsed.path.startswith("/v1/session/")
        and parsed.path.endswith("/cdp")
    )


def tilion_live_view_session_id(url: str) -> Optional[str]:
    """Recover a native handle from Tilion's persisted live view, never its token.

    The provider mints /v1/session/sess_<32 hex>/live-view URLs. Recording start,
    save and deployment diagnostics retain that path even after token redaction
    or rotation. Only the configured deployment and production authorities count.
    """
    if not isinstance(url, str) or any(char.isspace() or ord(char) < 32 for char in url):
        return None
    try:
        parsed = urlsplit(url)
        configured = urlsplit((os.environ.get("TILION_BASE_URL") or "https://back.tilion.dev").strip())
        port = parsed.port if parsed.port is not None else 443
        configured_host = configured.hostname or ""
        on_configured = bool(configured_host) and (
            parsed.hostname == configured_host or (parsed.hostname or "").endswith("." + configured_host)
        )
        allowed_ports = {443}
        if on_configured:
            allowed_ports.add(configured.port if configured.port is not None else 443)
        if (parsed.scheme != "https" or not is_tilion_host(parsed.hostname)
                or parsed.username is not None or parsed.password is not None
                or parsed.fragment or port not in allowed_ports):
            return None
    except ValueError:
        return None
    match = re.fullmatch(r"/v1/session/(sess_[0-9a-f]{32})/live-view", parsed.path)
    return match.group(1) if match else None


async def open_browser_cdp_connection(
    cdp_url: str,
    *,
    label: str = "",
    refresh_url: Optional[Callable[[], Awaitable[Optional[str]]]] = None,
    emulation: Optional[Dict[str, Any]] = None,
) -> Tuple[str, Optional[Any]]:
    """Return ``(url to connect local CDP clients to, multiplexer or None)``.

    Tilion admits one CDP client per session, so its URL (token intact) is held
    by one loopback multiplexer that browser-use and Playwright both attach to.
    The caller owns the returned multiplexer and closes it with its DOMService.
    ``refresh_url`` mints a fresh connect URL when a redial finds the token
    expired (Tilion tokens last 1800 s). ``emulation`` (timezone/locale/UA) is
    applied by the multiplexer to every page/iframe target before it runs.
    Other providers connect directly, as before.
    """
    from domains.spawn_browser_agent_v3.service_activity_queue import get_browser_cleanup_owners

    owners = get_browser_cleanup_owners()
    if owners is not None:
        owners.ensure_acquisition_open()
    if not is_tilion_cdp_url(cdp_url):
        return steel_cdp_connection_url(cdp_url), None
    from browser_tools.cdp_multiplexer import SingleCdpConnectionMultiplexer

    multiplexer = SingleCdpConnectionMultiplexer(cdp_url, label=label, refresh_url=refresh_url, emulation=emulation)
    # Retain custody before start can await or fail, including setup that never
    # returns a DOMService to its activity's outer finally.
    if owners is not None:
        owners.multiplexers[id(multiplexer)] = multiplexer
    return await multiplexer.start(), multiplexer
