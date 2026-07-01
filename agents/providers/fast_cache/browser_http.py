"""Fast Mode — browser HTTPS record/replay.

The live browser session (Steel/CDP) still runs; only its NETWORK RESPONSES are
served from cache so page loads are instant + deterministic on replay. We attach a
CDP Fetch-domain route handler (Playwright `page.route`) only when Fast Mode is on:

  - record (miss): let the request continue, capture the response body, store it
  - replay (hit):  fulfill the request from cache without hitting the internet

Keyed by (method, normalized_url, auth-header fingerprint) so cache-buster query
drift never busts a hit (#15), public assets reuse across goals, and authenticated
requests stay partitioned. Auth headers are stripped before storage (#26). The
browser ACTIONS (click/scroll/navigate) and the session itself are never cached.

The decision core here is pure + unit-testable; the Playwright wiring is a thin shell.
"""

from __future__ import annotations

import base64
from typing import Any, Dict, Optional

import structlog

from . import client as cache_client
from . import normalize

logger = structlog.get_logger(__name__)

# Resource types whose responses we record/replay. Document/XHR/Fetch are the
# page's data; scripts/styles/images make the page render identically offline.
CACHEABLE_RESOURCE_TYPES = {
    "document",
    "xhr",
    "fetch",
    "script",
    "stylesheet",
    "image",
    "font",
}

# Methods replayed in Fast Mode. POST is limited to browser XHR/fetch and keyed
# by a canonical request-body hash, so read-like API calls (for example challenge
# scoring endpoints) replay without collapsing distinct mutations together.
CACHEABLE_METHODS = {"GET", "HEAD", "POST"}

_SECRET_HEADERS = {"authorization", "cookie", "set-cookie", "proxy-authorization", "x-api-key"}


def should_cache(method: str, resource_type: str) -> bool:
    method_upper = method.upper()
    resource_lower = resource_type.lower()
    if resource_lower not in CACHEABLE_RESOURCE_TYPES:
        return False
    if method_upper in {"GET", "HEAD"}:
        return True
    return method_upper == "POST" and resource_lower in {"xhr", "fetch"}


def _strip_headers(headers: Dict[str, str]) -> Dict[str, str]:
    return {k: v for k, v in headers.items() if k.lower() not in _SECRET_HEADERS}


class BrowserHttpCache:
    """Record/replay for one browser run."""

    def __init__(self, goal: str, *, read_enabled: bool = True, write_enabled: bool = True):
        self.goal = goal
        self.goal_hash = normalize.goal_hash(goal)
        self.read_enabled = read_enabled
        self.write_enabled = write_enabled
        self._fulfilled_keys: set[str] = set()

    async def lookup(
        self,
        method: str,
        url: str,
        resource_type: str,
        request_headers: Optional[Dict[str, str]] = None,
        request_body: Any = None,
    ) -> Optional[Dict[str, Any]]:
        """Return a Playwright fulfill() payload for a cache hit, else None."""
        if not self.read_enabled:
            return None
        if not should_cache(method, resource_type):
            return None
        key = normalize.browser_http_key(self.goal, method, url, request_headers, request_body)
        stored = await cache_client.cache_get(key)
        if stored is None:
            logger.info("fast_cache.browser_http_miss", url=url, key=key)
            return None
        self._fulfilled_keys.add(key)
        logger.info("fast_cache.browser_http_hit", url=url, key=key)
        return {
            "status": stored.get("status", 200),
            "headers": stored.get("headers", {}),
            "body": base64.b64decode(stored["body_b64"]) if stored.get("body_b64") else b"",
            "content_type": stored.get("content_type", ""),
        }

    async def record(
        self,
        method: str,
        url: str,
        resource_type: str,
        status: int,
        headers: Dict[str, str],
        body: bytes,
        request_headers: Optional[Dict[str, str]] = None,
        request_body: Any = None,
    ) -> bool:
        """Store a response body. Only successful, cacheable responses are kept (#8)."""
        if not self.write_enabled:
            return False
        if not should_cache(method, resource_type):
            return False
        if not (200 <= status < 300):
            return False
        key = normalize.browser_http_key(self.goal, method, url, request_headers, request_body)
        if key in self._fulfilled_keys:
            self._fulfilled_keys.discard(key)
            return False
        value = {
            "status": status,
            "headers": _strip_headers(headers),
            "content_type": headers.get("content-type", ""),
            "body_b64": base64.b64encode(body).decode("ascii"),
        }
        ok = await cache_client.cache_set(key, "browser_http", self.goal_hash, value)
        if ok:
            logger.info("fast_cache.browser_http_stored", url=url, key=key, bytes=len(body))
        return ok
