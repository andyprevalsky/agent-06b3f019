"""Temporary cookie + browser-config tools for challenge A/B (DoorDash grocery).

Expose low-level primitives instead of ``recover_from_challenge`` so the model can
inspect/mutate cookie jar state and pick an allowlisted browser config.

Gate with ``BROWSER_EXPOSE_COOKIE_CONFIG_TOOLS`` (default ON on this experiment
branch). Pair with ``BROWSER_DISABLE_RECOVER_FROM_CHALLENGE=1``.
"""

from __future__ import annotations

import os
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence

COOKIE_CONFIG_TOOL_NAMES = (
    "read_cookies",
    "delete_cookies",
    "restore_cookies",
    "read_browser_config",
    "set_browser_config",
)

# Mirrors back-end challengeRecoveryCandidates.ts keys.
BROWSER_CONFIG_ALLOWLIST: tuple[str, ...] = (
    "steel_fixed",
    "kernel_mobile",
    "kernel_residential_city",
    "kernel_residential_state",
    "kernel_residential_country",
    "steel_managed",
    "kernel_isp",
)


def cookie_config_tools_enabled() -> bool:
    """Temp expose for cookie/config primitives (bench A/B). Default ON."""
    raw = (os.environ.get("BROWSER_EXPOSE_COOKIE_CONFIG_TOOLS") or "1").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def filter_actions_for_cookie_config_tools(actions: Sequence[str]) -> List[str]:
    """Drop cookie/config tools from an action list when the gate is off."""
    if cookie_config_tools_enabled():
        return list(actions)
    blocked = set(COOKIE_CONFIG_TOOL_NAMES)
    return [name for name in actions if name not in blocked]


def serialize_cookie(cookie: Mapping[str, Any]) -> Dict[str, Any]:
    """Return the full Playwright cookie dict — no truncation."""
    return {
        "name": cookie.get("name"),
        "value": cookie.get("value"),
        "domain": cookie.get("domain"),
        "path": cookie.get("path"),
        "expires": cookie.get("expires"),
        "httpOnly": cookie.get("httpOnly"),
        "secure": cookie.get("secure"),
        "sameSite": cookie.get("sameSite"),
    }


def cookies_match_filters(
    cookie: Mapping[str, Any],
    *,
    name: Optional[str] = None,
    domain: Optional[str] = None,
) -> bool:
    if name is not None and str(cookie.get("name") or "") != name:
        return False
    if domain is not None:
        cookie_domain = str(cookie.get("domain") or "").lstrip(".").lower()
        needle = domain.lstrip(".").lower()
        if cookie_domain != needle and not cookie_domain.endswith("." + needle):
            if needle != cookie_domain and not needle.endswith("." + cookie_domain):
                return False
    return True


def select_cookies_for_deletion(
    cookies: Iterable[Mapping[str, Any]],
    *,
    name: Optional[str] = None,
    domain: Optional[str] = None,
    protect_auth: bool = True,
) -> List[Dict[str, Any]]:
    """Select cookies to delete.

    When ``protect_auth`` is True (default), auth/session cookies are never
    selected — DoorDash grocery benches die when the model domain-wipes the jar
    or deletes login cookies while trying to clear Cloudflare.
    """
    from domains.spawn_browser_agent_v3.challenge_recovery import is_auth_cookie

    selected: List[Dict[str, Any]] = []
    for cookie in cookies:
        if not cookies_match_filters(cookie, name=name, domain=domain):
            continue
        if protect_auth and is_auth_cookie(cookie):
            continue
        selected.append(serialize_cookie(cookie))
    return selected


def auth_cookies_matching_filters(
    cookies: Iterable[Mapping[str, Any]],
    *,
    name: Optional[str] = None,
    domain: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Return auth cookies that would have matched the delete filters."""
    from domains.spawn_browser_agent_v3.challenge_recovery import is_auth_cookie

    return [
        serialize_cookie(cookie)
        for cookie in cookies
        if cookies_match_filters(cookie, name=name, domain=domain) and is_auth_cookie(cookie)
    ]


def blocked_config_keys_for_target(
    target_key: str,
    *,
    extra_blocked: Optional[Iterable[str]] = None,
) -> List[str]:
    """Allow only ``target_key`` by blocking every other allowlisted config."""
    if target_key not in BROWSER_CONFIG_ALLOWLIST:
        raise ValueError(
            f"browser config key {target_key!r} is not allowlisted; "
            f"choose one of {list(BROWSER_CONFIG_ALLOWLIST)}"
        )
    blocked = {key for key in BROWSER_CONFIG_ALLOWLIST if key != target_key}
    if extra_blocked:
        blocked.update(str(key) for key in extra_blocked if key and key != target_key)
    return sorted(blocked)


def describe_browser_config(
    *,
    browser_session_metadata: Optional[Mapping[str, Any]] = None,
    last_promoted_browser_config_key: Optional[str] = None,
    dead_browser_config_keys: Optional[Iterable[str]] = None,
) -> Dict[str, Any]:
    meta = dict(browser_session_metadata or {})
    return {
        "provider": meta.get("provider"),
        "proxy_tier": meta.get("proxy_tier") or meta.get("proxyTier"),
        "proxy_mode": meta.get("proxy_mode") or meta.get("proxyMode"),
        "session_id": meta.get("session_id") or meta.get("sessionId"),
        "config_key": meta.get("config_key")
        or meta.get("configKey")
        or last_promoted_browser_config_key,
        "last_promoted_browser_config_key": last_promoted_browser_config_key,
        "dead_browser_config_keys": sorted(
            {str(key) for key in (dead_browser_config_keys or []) if key}
        ),
        "allowlisted_browser_configs": list(BROWSER_CONFIG_ALLOWLIST),
        "browser_session_metadata": meta,
    }
