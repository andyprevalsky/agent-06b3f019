"""Log- and persistence-safe URLs: mask credentials carried in query strings.

Pure (os + urllib only) so every layer may import it.
"""

from __future__ import annotations

import os
from typing import Optional
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

_TILION_DEFAULT_BASE_URL = "https://back.tilion.dev"
_SECRET_QUERY_KEYS = frozenset({"token", "apikey", "api_key", "jwt"})


def tilion_hosts() -> set:
    """Root hostnames of the Tilion deployment: production plus ``TILION_BASE_URL``."""
    configured = urlsplit((os.environ.get("TILION_BASE_URL") or _TILION_DEFAULT_BASE_URL).strip())
    hosts = {"back.tilion.dev"}
    if configured.hostname:
        hosts.add(configured.hostname.lower())
    return hosts


def is_tilion_host(hostname: Optional[str]) -> bool:
    """Whether ``hostname`` belongs to the Tilion deployment.

    Tilion serves a session's CDP and live-view URLs from a regional subdomain of
    its deployment (``east.back.tilion.dev``, ``oregon.back.tilion.dev``), so the
    deployment root and every subdomain of it count. A lookalike that merely
    contains the root (``evilback.tilion.dev``, ``back.tilion.dev.evil.example``)
    does not.
    """
    host = (hostname or "").lower().rstrip(".")
    if not host:
        return False
    return any(host == root or host.endswith("." + root) for root in tilion_hosts())


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


def redact_url_secrets(url: Optional[str]) -> Optional[str]:
    """Mask the credential in a Tilion URL (live view / CDP ``?token=``) before
    it is persisted or logged; other providers' URLs pass through unchanged
    (their live views are displayed from the persisted URL).

    The backend re-mints Tilion live-view URLs for display, so a persisted copy
    never needs its token.
    """
    if not url:
        return url
    host = (urlsplit(url).hostname or "").lower()
    return redact_cdp_url(url) if is_tilion_host(host) else url
