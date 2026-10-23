"""Auth-preserving recovery for persistent anti-bot challenges.

After the provider solver, cookie variants are probed in one parallel wave
(≤5) on **ephemeral** provider sessions — never via ``new_context`` on the live
Kernel desktop (that paints stacked Chromium windows into the debug view).

When a known anti-bot cookie strip (or guest ``all_target`` strip) probes clean,
recovery does **not** strip cookies on the live tab. It hands off through the
same config-search verifier + promote path used for proxy/IP recovery: an
ephemeral session carrying the stripped storage is classified with the same
LLM context and, if clean, atomically promoted. Opaque / auth-like cookies are
never deleted on signed-in paths — those cases escalate to config search with
auth_kept / stripped lanes.
"""

from __future__ import annotations

import asyncio
import contextlib
import copy
import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, Iterable, List, Mapping, Sequence, Tuple
from urllib.parse import urlparse

from domains.spawn_browser_agent_v3.challenge_urls import (
    blocked_resource_urls_for_verify,
    urls_cited_in_recovery_reason,
)

StorageState = Dict[str, Any]
CookieKey = Tuple[str, str, str]
Probe = Callable[[StorageState], Awaitable[bool]]
Progress = Callable[[str, str], Awaitable[None]]
CommitCookies = Callable[[Sequence[CookieKey]], Awaitable[bool]]
ConfigSearch = Callable[[Sequence[Mapping[str, Any]]], Awaitable[Mapping[str, Any]]]
WaitForSolver = Callable[[], Awaitable[None]]


_AUTH_COOKIE_RE = re.compile(
    r"(?:^|[_\-.])(?:auth|authenticated|credential|jwt|login|oauth|refresh|session|sso|token)(?:$|[_\-.])",
    re.IGNORECASE,
)
_AUTH_COOKIE_EXACT = {
    "access_token",
    "id_token",
    "remember_me",
    "sid",
    "ssid",
    "user",
    "userid",
    "user_id",
}
_AUTH_COOKIE_FRAGMENTS = ("auth", "credential", "jwt", "login", "oauth", "session", "sso", "token")
_CHALLENGE_COOKIE_RE = re.compile(
    r"^(?:"
    r"__cf_bm|__cflb|_cfuvid|cf_clearance|cf_chl_.+|"
    r"_abck|ak_bmsc|bm_mi|bm_sv|bm_sz|"
    r"datadome|captcha|"
    r"_px(?:2|3|de|ff_|hd|vid|mvid|cts)?|pxcts|"
    r"reese84|incap_ses_.+|visid_incap_.+|nlbi_.+"
    r")$",
    re.IGNORECASE,
)
# Match only against rendered title/body — never raw HTML. Generic phrases like
# "just a moment" / "access denied" appear in script/i18n bundles on clean
# commerce pages and false-positive the probe (stablePasses=0).
_CHALLENGE_RENDERED_TEXT_MARKERS = (
    "access denied",
    "attention required! | cloudflare",
    # Expedia/DataDome PWA interstitial (title "Bot or Not?"). Matched against
    # rendered title/body only — must stay out of raw HTML scans so merchant
    # pages that discuss bots in script bundles do not false-positive.
    "bot or not",
    "can't tell if you're a human or a bot",
    "checking your browser",
    "enable javascript and cookies to continue",
    "just a moment",
    "performing security verification",
    "please verify you are a human",
    "show us your human side",
    "sorry, you have been blocked",
    "this site can't be reached",
    "too many requests",
    "unusual traffic from your computer network",
    "verify you are human",
)
# Kernel proxy hard-blocks are safe in raw HTML: they never appear in merchant
# page bundles (checkout.stripe.com → provider_blacklisted).
_PROXY_ERROR_TEXT_MARKERS = (
    "provider_blacklisted",
    "x-kernel-proxy-error",
    "kernel-proxy-error",
)
# Backward-compatible alias for call sites / tests that still import the old name.
_CHALLENGE_TEXT_MARKERS = _CHALLENGE_RENDERED_TEXT_MARKERS + _PROXY_ERROR_TEXT_MARKERS
# Vendor fingerprints for interstitials that return HTTP 200 with benign text, so
# neither the status nor the text markers above can catch them. This list is kept
# at parity with `_CHALLENGE_COOKIE_RE`: that regex already recognises DataDome,
# PerimeterX, and Imperva/Incapsula cookies, but the page detector used to match
# Cloudflare only. A DataDome interstitial therefore read as a clean page, so
# `recover_from_challenge` reported success and the caller looped -- four cycles
# and 312s on one Expedia run, each "recovery" followed by the same challenge.
# Only challenge-specific tokens belong here. Vendor sensor/orchestration hosts
# (captcha-delivery.com, perimeterx.net, /cdn-cgi/challenge-platform) also load
# on ORDINARY pages, so matching them made page_looks_challenged() return True
# for a clean page — inverting the recovery contract, since the post-recovery
# clean-page wait could then never converge.
# Vendor sensor hosts are INTENTIONALLY included. CodeRabbit flagged them as a
# false-positive risk (they also load on ordinary pages), but
# `challenge_recovery.blackbox.py::test_challenge_page_classifier_detects_non_cloudflare_vendors`
# cements the opposite tradeoff from a measured incident: without them a
# DataDome/PerimeterX interstitial read as a clean page and one Expedia run
# burned four cycles / 312s looping on false recoveries. The false-negative cost
# here was paid for real; the false-positive one is theoretical. Incidental
# captcha PROSE is handled separately by the classifier's prose guard.
# A recovered page renders real content; interstitials are near-empty.
# Keep at parity with back-end SUBSTANTIVE_BODY_CHARS (80). Cleared Eventim
# ticket pages embed Turnstile next to short inventory copy (~80 chars) — a
# 600-char bar false-positived those as still challenged.
_CLEAN_PAGE_MIN_VISIBLE_CHARS = 80
# Soft-walls often keep navigation shells instead of a real document title while
# body HTML is already non-empty (meta/noscript). Structure-only — never a
# vendor or registrable-domain token.
_BARE_HOSTNAME_TITLE_RE = re.compile(r"^(www\.)?([a-z0-9-]+\.)+[a-z]{2,}$", re.IGNORECASE)
_LOADING_URL_TITLE_RE = re.compile(r"^loading\s+https?://", re.IGNORECASE)
_URL_TITLE_RE = re.compile(r"^https?://", re.IGNORECASE)
# Provider-native solvers need wall-clock room after a soft-wall starts hydrating.
DEFAULT_SOLVER_TIMEOUT_SECONDS = 60.0

# Sensor/orchestration hosts that also load on recovered pages. A match alone
# is not proof of an interstitial — `_has_substantive_content` must also fail.
_CHALLENGE_SENSOR_HTML_MARKERS = (
    "/cdn-cgi/challenge-platform",
    "challenges.cloudflare.com/turnstile",
    "captcha-delivery.com",
    "perimeterx.net",
)
# Interstitial containers / challenge widgets that do not remain after a wall
# clears. A match is definitive even when captcha instruction copy exceeds the
# substantive-content bar (Expedia Bot or Not + DataDome slide copy).
_CHALLENGE_INTERSTITIAL_HTML_MARKERS = (
    "app-captcha-pwa",
    "captcha__audio_",
    "captcha__puzzle",
    "cf-chl-",
    "ddchallengebody",
    "px-captcha",
    "_incapsula_resource",
    "incapsula incident id",
)
# Backward-compatible union for tests/callers that iterate every HTML marker.
_CHALLENGE_HTML_MARKERS = _CHALLENGE_SENSOR_HTML_MARKERS + _CHALLENGE_INTERSTITIAL_HTML_MARKERS


class ChallengeConfigSearchFailedError(RuntimeError):
    """Keep failed-search details without representing the result as a winner."""

    def __init__(self, result: Mapping[str, Any]):
        self.result = copy.deepcopy(dict(result))
        error = result.get("error")
        super().__init__(
            error if isinstance(error, str) and error else "Browser configuration search failed"
        )


@dataclass(frozen=True)
class ChallengeRecoveryResult:
    recovery: str
    removed_cookie_keys: Tuple[CookieKey, ...] = ()
    config_result: Mapping[str, Any] | None = None


def cookie_key(cookie: Mapping[str, Any]) -> CookieKey:
    return (
        str(cookie.get("name") or ""),
        str(cookie.get("domain") or "").lower(),
        str(cookie.get("path") or "/"),
    )


def is_auth_cookie(cookie: Mapping[str, Any]) -> bool:
    """Conservatively identify cookies that may carry authentication state."""
    name = str(cookie.get("name") or "").lower()
    return (
        name in _AUTH_COOKIE_EXACT
        or _AUTH_COOKIE_RE.search(name) is not None
        or any(fragment in name for fragment in _AUTH_COOKIE_FRAGMENTS)
    )


def is_known_challenge_cookie(cookie: Mapping[str, Any]) -> bool:
    return _CHALLENGE_COOKIE_RE.fullmatch(str(cookie.get("name") or "")) is not None


def cookie_applies_to_host(cookie: Mapping[str, Any], host: str) -> bool:
    domain = str(cookie.get("domain") or "").lower().lstrip(".")
    normalized_host = host.lower().rstrip(".")
    return bool(domain) and (normalized_host == domain or normalized_host.endswith(f".{domain}"))


def target_cookie_keys(storage_state: Mapping[str, Any], target_url: str) -> Tuple[CookieKey, ...]:
    host = (urlparse(target_url).hostname or "").lower()
    if not host:
        return ()
    return tuple(
        cookie_key(cookie)
        for cookie in storage_state.get("cookies") or []
        if isinstance(cookie, Mapping) and cookie_applies_to_host(cookie, host)
    )


def storage_without_cookies(storage_state: Mapping[str, Any], removed: Iterable[CookieKey]) -> StorageState:
    """Return a deep copy with only the identified cookies removed."""
    removed_set = set(removed)
    candidate = copy.deepcopy(dict(storage_state))
    candidate["cookies"] = [
        cookie
        for cookie in candidate.get("cookies") or []
        if not isinstance(cookie, Mapping) or cookie_key(cookie) not in removed_set
    ]
    return candidate


def build_config_search_lanes(
    source_state: StorageState,
    *,
    preserve_auth: bool,
    proven_safe_removals: Sequence[CookieKey] = (),
) -> List[Dict[str, Any]]:
    """Build parallel cookie-signature lanes for browser-config search.

    ``auth_kept`` strips known challenge cookies (plus any proven-safe removals)
    while retaining auth/opaque cookies. When ``preserve_auth`` is false, also
    include a fully ``stripped`` lane so guest recoveries can clear soft-blocks
    without transplanting poisoned session cookies onto new exits.
    """
    cookies_by_key = {
        cookie_key(cookie): cookie
        for cookie in source_state.get("cookies") or []
        if isinstance(cookie, Mapping)
    }
    challenge_keys = tuple(
        key
        for key, cookie in cookies_by_key.items()
        if is_known_challenge_cookie(cookie) and not is_auth_cookie(cookie)
    )
    strip_keys = tuple(dict.fromkeys((*proven_safe_removals, *challenge_keys)))
    lanes: List[Dict[str, Any]] = [
        {
            "key": "auth_kept",
            "storage_state": storage_without_cookies(source_state, strip_keys),
        }
    ]
    if not preserve_auth:
        all_keys = tuple(cookies_by_key.keys())
        lanes.append(
            {
                "key": "stripped",
                "storage_state": storage_without_cookies(source_state, all_keys),
            }
        )
    return lanes


def is_usable_document_title(title: str) -> bool:
    """True when title looks like a real document, not a navigation shell.

    Soft anti-bot walls (any vendor) commonly keep empty titles, bare hostnames,
    or Chromium "Loading https://..." titles while body text is already long.
    Candidate probes that treated those as clean reported stablePasses=2 in a
    few seconds, then live verify correctly failed on the promoted session.
    """
    trimmed = title.strip()
    if not trimmed:
        return False
    if _LOADING_URL_TITLE_RE.match(trimmed) or _URL_TITLE_RE.match(trimmed):
        return False
    if _BARE_HOSTNAME_TITLE_RE.match(trimmed):
        return False
    return True


def page_looks_challenged(*, status: int | None, title: str, body_text: str, html: str) -> bool:
    """Deprecated heuristic challenge detector.

    Prefer ``classify_page_after_settle`` / ``challenge_llm_classifier``
    (rose-1-mini). Retained for regression tests and historical RCA fixtures —
    do not use for probe / live-verify / auth-guard promotion decisions.
    """
    # 502: Kernel (and similar) proxy denials surface as Bad Gateway. Treating them
    # as challenged keeps a blacklisted Kernel exit from looking "recovered".
    if status in {403, 429, 502}:
        return True
    content = f"{title}\n{body_text}".lower()
    if any(marker in content for marker in _CHALLENGE_RENDERED_TEXT_MARKERS):
        return True
    if any(marker in content for marker in _PROXY_ERROR_TEXT_MARKERS):
        return True
    normalized_html = html.lower()
    # Proxy-error tokens only — generic challenge prose must not scan raw HTML.
    if any(marker in normalized_html for marker in _PROXY_ERROR_TEXT_MARKERS):
        return True
    # Drop script/style/noscript CONTENT before stripping tags. Tag-only
    # stripping leaves their text nodes in `visible_markup`, and a challenge
    # interstitial is precisely the page that ships a large inline script with
    # almost no rendered text — so it would clear the substantive-content bar
    # and read as clean.
    # Comments go FIRST. The unterminated-block pass below deletes from the
    # leftmost surviving opening tag to end-of-input, so a `<script` that only
    # ever appears inside a comment — `<!-- <script src="legacy.js"> -->` —
    # would wipe the entire rest of the page. `visible_markup` then collapses,
    # a recovered page fails the substantive-content bar, and the solver loops
    # to timeout on a page that was actually fine. An unterminated comment is
    # dropped through end-of-input for the same truncation reason as scripts.
    stripped_html = re.sub(r"<!--.*?-->", " ", normalized_html, flags=re.S)
    stripped_html = re.sub(r"<!--.*\Z", " ", stripped_html, flags=re.S)
    stripped_html = re.sub(
        r"<(script|style|noscript)\b[^>]*>.*?</\1>", " ", stripped_html, flags=re.S
    )
    # `_wait_for_clean_page` truncates to 100k chars, which can cut a large
    # interstitial mid-script. The opening tag then has no closing match, the
    # pattern above leaves it intact, and the raw script text counts as visible
    # content — clearing the substantive-content bar so a still-challenged page
    # reads as clean. Drop any unterminated block through end-of-input.
    stripped_html = re.sub(
        r"<(script|style|noscript)\b[^>]*>.*\Z", " ", stripped_html, flags=re.S
    )
    visible_markup = re.sub(r"<[^>]+>", "", stripped_html).strip()
    if not title.strip() and not body_text.strip() and not visible_markup:
        return True
    # Interstitial containers are definitive. Expedia's DataDome PWA ships
    # enough captcha instruction prose to clear the substantive-content bar
    # while #app-captcha-pwa is still mounted; treating that as "clean" made
    # recover_from_challenge report skipped_clean_page and the browser agent
    # misroute into request_user_assistance_for_authentication.
    if any(marker in normalized_html for marker in _CHALLENGE_INTERSTITIAL_HTML_MARKERS):
        return True
    # Hard gate shared with backend challengePageDetect: no usable document
    # title ⇒ still challenged, even with long body text from meta/noscript.
    if not is_usable_document_title(title):
        return True
    if not any(marker in normalized_html for marker in _CHALLENGE_SENSOR_HTML_MARKERS):
        return False
    # A sensor-host marker alone is not proof: those scripts stay loaded on the
    # real page AFTER a challenge clears. Without this, _wait_for_clean_page
    # could never converge on a site that keeps its sensor bundle, and recovery
    # would report failure for a page that already works. A page that has
    # recovered renders substantive content, so treat that as clean.
    if _has_substantive_content(title, body_text, visible_markup):
        return False
    return True


def _has_substantive_content(title: str, body_text: str, visible_markup: str) -> bool:
    """A challenge interstitial shows almost nothing; a recovered page does not."""
    visible = body_text.strip() or visible_markup
    return len(visible) >= _CLEAN_PAGE_MIN_VISIBLE_CHARS and is_usable_document_title(title)


def _response_network_entry(response: Any) -> Dict[str, Any] | None:
    """Best-effort Playwright Response → classifier network row (status, no body)."""
    try:
        url = str(getattr(response, "url", "") or "")
        status = getattr(response, "status", None)
        status_text = str(getattr(response, "status_text", "") or "")
        if not url and status is None:
            return None
        return {
            "url": url,
            "status": status,
            "status_text": status_text,
        }
    except Exception:
        return None


async def _wait_for_clean_page(
    page: Any,
    response: Any,
    solver_timeout_seconds: float,
    *,
    agent_id: str | None = None,
    user_id: str | None = None,
    claude_token: str | None = None,
    claude_token_source: str | None = None,
    claude_token_pool_id: str | None = None,
    gpt_token: str | None = None,
    gpt_account_id: str | None = None,
    gpt_token_source: str | None = None,
    gpt_token_pool_id: str | None = None,
    usage_collector: list | None = None,
    agent_dom_tree: str | None = None,
    network_recorder: Any = None,
    network_entries: list | None = None,
    recovery_reason: str | None = None,
) -> bool:
    """After DOM settle, ask rose-1-mini whether the page is still challenged."""
    from domains.spawn_browser_agent_v3.challenge_llm_classifier import classify_page_after_settle

    result = await classify_page_after_settle(
        page,
        response,
        settle_timeout_ms=max(1_000.0, float(solver_timeout_seconds) * 1000.0),
        agent_id=agent_id,
        user_id=user_id,
        claude_token=claude_token,
        claude_token_source=claude_token_source,
        claude_token_pool_id=claude_token_pool_id,
        gpt_token=gpt_token,
        gpt_account_id=gpt_account_id,
        gpt_token_source=gpt_token_source,
        gpt_token_pool_id=gpt_token_pool_id,
        usage_collector=usage_collector,
        agent_dom_tree=agent_dom_tree,
        network_recorder=network_recorder,
        network_entries=network_entries,
        recovery_reason=recovery_reason,
    )
    return bool(result.get("clean"))


def _registrable_host(hostname: str) -> str:
    host = (hostname or "").lower().strip(".")
    if host.startswith("www."):
        return host[4:]
    return host


def same_site_navigation_url(target_url: str, settled_url: str) -> str | None:
    """Return settled_url when it is a same-site http(s) sibling of target_url.

    Soft-block recoveries (Hotels.com) often clear on a same-host redirect away
    from a poisoned deep link. Later stability checks must re-nav that settled
    document — re-punching the original deep link re-triggers 429 / Bot or Not
    even though the promoted exit is usable.
    """
    settled = (settled_url or "").strip()
    if not settled.startswith(("http://", "https://")):
        return None
    target_host = _registrable_host(urlparse(target_url).hostname or "")
    settled_host = _registrable_host(urlparse(settled).hostname or "")
    if not target_host or not settled_host or target_host != settled_host:
        return None
    return settled


def settled_probe_url_after_clean(target_url: str, page: Any) -> str:
    """Pick the URL for the next probe attempt after a clean settle."""
    try:
        settled = str(getattr(page, "url", "") or "")
    except Exception:
        settled = ""
    return same_site_navigation_url(target_url, settled) or target_url


async def _probe_page(
    page: Any,
    target_url: str,
    *,
    attempts: int = 1,
    solver_timeout_seconds: float,
    agent_id: str | None = None,
    user_id: str | None = None,
    claude_token: str | None = None,
    claude_token_source: str | None = None,
    claude_token_pool_id: str | None = None,
    gpt_token: str | None = None,
    gpt_account_id: str | None = None,
    gpt_token_source: str | None = None,
    gpt_token_pool_id: str | None = None,
    usage_collector: list | None = None,
    agent_dom_tree: str | None = None,
    network_recorder: Any = None,
    recovery_reason: str | None = None,
) -> bool:
    """One goto + one classify by default.

    ``attempts`` is retained for call-site compatibility; values >1 still loop,
    but the hot path uses 1 (no soft-redirect re-nav / dual LLM).
    """
    collected: list[Dict[str, Any]] = []

    def _on_response(resp: Any) -> None:
        entry = _response_network_entry(resp)
        if entry is not None:
            collected.append(entry)

    on_fn = getattr(page, "on", None)
    off_fn = getattr(page, "remove_listener", None) or getattr(page, "off", None)
    if callable(on_fn):
        try:
            on_fn("response", _on_response)
        except Exception:
            on_fn = None
    try:
        navigate_url = target_url
        for _ in range(max(1, int(attempts))):
            response = None
            try:
                response = await page.goto(
                    navigate_url, wait_until="domcontentloaded", timeout=45_000
                )
            except Exception:
                pass
            if not await _wait_for_clean_page(
                page,
                response,
                solver_timeout_seconds,
                agent_id=agent_id,
                user_id=user_id,
                claude_token=claude_token,
                claude_token_source=claude_token_source,
                claude_token_pool_id=claude_token_pool_id,
                gpt_token=gpt_token,
                gpt_account_id=gpt_account_id,
                gpt_token_source=gpt_token_source,
                gpt_token_pool_id=gpt_token_pool_id,
                usage_collector=usage_collector,
                agent_dom_tree=agent_dom_tree,
                network_recorder=network_recorder,
                network_entries=list(collected),
                recovery_reason=recovery_reason,
            ):
                return False
            # Legacy multi-attempt path only: follow settled URL between loops.
            navigate_url = settled_probe_url_after_clean(target_url, page)
        return True
    finally:
        if callable(on_fn) and callable(off_fn):
            with contextlib.suppress(Exception):
                off_fn("response", _on_response)


async def probe_storage_state(
    playwright_browser: Any,
    storage_state: StorageState,
    target_url: str,
    *,
    attempts: int = 1,
    solver_timeout_seconds: float = DEFAULT_SOLVER_TIMEOUT_SECONDS,
    agent_id: str | None = None,
    user_id: str | None = None,
    claude_token: str | None = None,
    claude_token_source: str | None = None,
    claude_token_pool_id: str | None = None,
    gpt_token: str | None = None,
    gpt_account_id: str | None = None,
    gpt_token_source: str | None = None,
    gpt_token_pool_id: str | None = None,
    usage_collector: list | None = None,
    recovery_reason: str | None = None,
) -> bool:
    """Probe a storage variant in an isolated Playwright context.

    Do **not** call this on the live Kernel session: ``new_context``/``new_page``
    paint extra Chromium windows onto the debug-view desktop. Cookie experiments
    for recovery belong on ephemeral provider sessions (config-search lanes) or
    as known-challenge strips applied on the existing live tab.
    """
    context = await playwright_browser.new_context(storage_state=storage_state)
    try:
        page = await context.new_page()
        return await _probe_page(
            page,
            target_url,
            attempts=attempts,
            solver_timeout_seconds=solver_timeout_seconds,
            agent_id=agent_id,
            user_id=user_id,
            claude_token=claude_token,
            claude_token_source=claude_token_source,
            claude_token_pool_id=claude_token_pool_id,
            gpt_token=gpt_token,
            gpt_account_id=gpt_account_id,
            gpt_token_source=gpt_token_source,
            gpt_token_pool_id=gpt_token_pool_id,
            usage_collector=usage_collector,
            recovery_reason=recovery_reason,
        )
    finally:
        await context.close()



async def verify_live_page_cleared_challenge(
    page: Any,
    target_url: str,
    *,
    attempts: int = 1,
    solver_timeout_seconds: float = DEFAULT_SOLVER_TIMEOUT_SECONDS,
    agent_id: str | None = None,
    user_id: str | None = None,
    claude_token: str | None = None,
    claude_token_source: str | None = None,
    claude_token_pool_id: str | None = None,
    gpt_token: str | None = None,
    gpt_account_id: str | None = None,
    gpt_token_source: str | None = None,
    gpt_token_pool_id: str | None = None,
    usage_collector: list | None = None,
    agent_dom_tree: str | None = None,
    network_recorder: Any = None,
    recovery_reason: str | None = None,
) -> bool:
    """Require the canonical live tab to clear challenges after promote/restore.

    Default is a single navigation-probe + LLM classify. Preloaded config winners
    that already classified clean on the same remote session should skip this
    entirely at the call site.
    """
    return await _probe_page(
        page,
        target_url,
        attempts=attempts,
        solver_timeout_seconds=solver_timeout_seconds,
        agent_id=agent_id,
        user_id=user_id,
        claude_token=claude_token,
        claude_token_source=claude_token_source,
        claude_token_pool_id=claude_token_pool_id,
        gpt_token=gpt_token,
        gpt_account_id=gpt_account_id,
        gpt_token_source=gpt_token_source,
        gpt_token_pool_id=gpt_token_pool_id,
        usage_collector=usage_collector,
        agent_dom_tree=agent_dom_tree,
        network_recorder=network_recorder,
        recovery_reason=recovery_reason,
    )


async def live_tab_looks_challenged(
    page: Any,
    *,
    agent_id: str | None = None,
    user_id: str | None = None,
    claude_token: str | None = None,
    claude_token_source: str | None = None,
    claude_token_pool_id: str | None = None,
    gpt_token: str | None = None,
    gpt_account_id: str | None = None,
    gpt_token_source: str | None = None,
    gpt_token_pool_id: str | None = None,
    usage_collector: list | None = None,
    agent_dom_tree: str | None = None,
    network_recorder: Any = None,
    recovery_reason: str | None = None,
) -> bool:
    """True when the live tab's current document still looks challenged (LLM).

    Used to skip recover_from_challenge when the live document is already clean.
    """
    from domains.spawn_browser_agent_v3.challenge_llm_classifier import classify_page_after_settle

    page_url = str(getattr(page, "url", "") or "")
    if cited_first_party_transport_failure(page_url, network_recorder, recovery_reason):
        return True
    # The provider proxy served this document itself: the exit, not the site, failed.
    proxy_lookup = getattr(network_recorder, "provider_proxy_error_document", None)
    if page_url and callable(proxy_lookup) and proxy_lookup(page_url):
        return True

    try:
        result = await classify_page_after_settle(
            page,
            None,
            settle_timeout_ms=15_000,
            agent_id=agent_id,
            user_id=user_id,
            claude_token=claude_token,
            claude_token_source=claude_token_source,
            claude_token_pool_id=claude_token_pool_id,
            gpt_token=gpt_token,
            gpt_account_id=gpt_account_id,
            gpt_token_source=gpt_token_source,
            gpt_token_pool_id=gpt_token_pool_id,
            usage_collector=usage_collector,
            agent_dom_tree=agent_dom_tree,
            network_recorder=network_recorder,
            recovery_reason=recovery_reason,
        )
    except Exception:
        # Unknown page state — do not claim "clean".
        return True
    return not bool(result.get("clean"))


_NETWORK_ROUTE_FAILURE_MARKERS = (
    "err_tunnel_connection_failed",
    "err_proxy_connection_failed",
    "err_proxy_connection_refused",
)


def cited_first_party_transport_failure(
    page_url: str,
    network_recorder: Any,
    recovery_reason: str | None,
) -> bool:
    """Keep recovery available when a cited first-party request cannot route.

    A loaded document can be stale while a later fetch or form submit fails.
    The recorder is newest-first; a later success on the same method and URL
    resolves the failure without rotating the browser.
    """
    cited_urls = set(urls_cited_in_recovery_reason(recovery_reason))
    query = getattr(network_recorder, "query_requests", None)
    page_host = (urlparse(page_url).hostname or "").lower()
    if not cited_urls or not page_host or not callable(query):
        return False
    seen: set[tuple[str, str]] = set()
    for cited_url in cited_urls:
        try:
            rows = query(url_pattern=cited_url, limit=100)
        except Exception:
            return False
        if not isinstance(rows, list):
            return False
        for row in rows:
            if not isinstance(row, dict):
                continue
            raw_url = str(row.get("url") or "")
            parsed = urlparse(raw_url)
            if (parsed.hostname or "").lower() != page_host:
                continue
            normalized = blocked_resource_urls_for_verify((raw_url,))
            if not normalized or normalized[0] != cited_url:
                continue
            # An in-flight retry has not resolved the earlier failure.
            if row.get("status") is None and not row.get("failed"):
                continue
            key = (str(row.get("method") or "").upper(), normalized[0])
            if key in seen:
                continue
            seen.add(key)
            failure = str(row.get("failure") or "").lower()
            if row.get("failed") and any(marker in failure for marker in _NETWORK_ROUTE_FAILURE_MARKERS):
                return True
    return False


def target_looks_like_payment_document(_url: str) -> bool:
    """Deprecated: path allowlists are forbidden. Always False."""
    return False


def _url_looks_like_script(url: str) -> bool:
    path = (urlparse(url).path or "").lower()
    host = (urlparse(url).hostname or "").lower()
    if path.endswith(".js") or "/js/" in path or path.endswith("/v3") or path.endswith("/v3/"):
        return True
    # js.* CDN hosts almost always serve executable scripts (js.stripe.com, …).
    return host.startswith("js.")


async def verify_live_blocked_resources(
    page: Any,
    urls: Sequence[str],
    *,
    timeout_ms: int = 12_000,
) -> bool:
    """Re-verify that the resources which triggered recovery now load.

    Failure-driven and page-agnostic: only the blocked URLs from the provider-exit
    rejection are checked. Script-like URLs require a real <script> onload (fetch
    can succeed while ORB blocks script execution). Other URLs need no-cors fetch
    success. Empty list => vacuously true so plain CF recovery never false-negatives.
    """
    targets = blocked_resource_urls_for_verify(urls)
    if not targets:
        return True
    script_flags = [_url_looks_like_script(url) for url in targets]
    try:
        return bool(
            await page.evaluate(
                """async ({ targets, scriptFlags, timeoutMs }) => {
                  const probe = async (url, scriptLike) => {
                    try {
                      const controller = new AbortController();
                      const timer = setTimeout(() => controller.abort(), timeoutMs);
                      await fetch(url, {
                        method: 'GET',
                        mode: 'no-cors',
                        signal: controller.signal,
                        credentials: 'omit',
                      });
                      clearTimeout(timer);
                    } catch {
                      return false;
                    }
                    if (!scriptLike) return true;
                    // Fetch can succeed while <script> is ORB-blocked.
                    return await new Promise((resolve) => {
                      const script = document.createElement('script');
                      script.src = url;
                      script.async = true;
                      const timer = setTimeout(() => {
                        script.remove();
                        resolve(false);
                      }, timeoutMs);
                      script.onload = () => {
                        clearTimeout(timer);
                        script.remove();
                        resolve(true);
                      };
                      script.onerror = () => {
                        clearTimeout(timer);
                        script.remove();
                        resolve(false);
                      };
                      document.head.appendChild(script);
                    });
                  };
                  for (let i = 0; i < targets.length; i += 1) {
                    if (!(await probe(targets[i], scriptFlags[i]))) return false;
                  }
                  return true;
                }""",
                {
                    "targets": list(targets),
                    "scriptFlags": script_flags,
                    "timeoutMs": timeout_ms,
                },
            )
        )
    except Exception:
        return False


async def verify_live_stripe_js_loads(page: Any, *, timeout_ms: int = 12_000) -> bool:
    """Deprecated — prefer verify_live_blocked_resources with the blocked URL."""
    return await verify_live_blocked_resources(page, (), timeout_ms=timeout_ms)


async def commit_cookie_removals(
    page: Any,
    removed_cookie_keys: Sequence[CookieKey],
    target_url: str,
    *,
    attempts: int = 1,
    solver_timeout_seconds: float = 45.0,
    recovery_reason: str | None = None,
    network_recorder: Any = None,
    agent_dom_tree: str | None = None,
) -> bool:
    """Delete proven-safe keys and require one clean live-tab navigation."""
    context = page.context
    for name, domain, path in removed_cookie_keys:
        await context.clear_cookies(name=name, domain=domain, path=path)
    return await _probe_page(
        page,
        target_url,
        attempts=attempts,
        solver_timeout_seconds=solver_timeout_seconds,
        recovery_reason=recovery_reason,
        network_recorder=network_recorder,
        agent_dom_tree=agent_dom_tree,
    )


def _state_digest(storage_state: Mapping[str, Any]) -> str:
    encoded = json.dumps(storage_state, sort_keys=True, separators=(",", ":"), default=str).encode()
    return hashlib.sha256(encoded).hexdigest()


def _chunks(values: Sequence[CookieKey], count: int) -> List[Tuple[CookieKey, ...]]:
    size, remainder = divmod(len(values), count)
    chunks: List[Tuple[CookieKey, ...]] = []
    start = 0
    for index in range(count):
        width = size + (1 if index < remainder else 0)
        if width:
            chunks.append(tuple(values[start : start + width]))
        start += width
    return chunks


async def minimize_passing_cookie_removal(
    source_state: Mapping[str, Any],
    passing_removal: Sequence[CookieKey],
    probe: Probe,
    progress: Progress,
) -> Tuple[CookieKey, ...]:
    """Deprecated: multi-round cookie ddmin.

    Live cookie-probe waves are retired; recovery uses live known-cookie strips
    + ephemeral config search. Kept for call-site compatibility / offline
    experiments; do not wire into the hot recover path.
    """
    current = tuple(dict.fromkeys(passing_removal))
    granularity = 2
    round_number = 0

    while len(current) >= 2:
        round_number += 1
        await progress(
            "cookie_isolation",
            f"Isolating the non-auth cookie set (parallel reduction round {round_number}).",
        )
        parts = _chunks(current, min(granularity, len(current)))
        proposals: List[Tuple[CookieKey, ...]] = list(parts)
        proposals.extend(tuple(key for key in current if key not in set(part)) for part in parts)
        unique = sorted(set(proposals), key=lambda proposal: (len(proposal), proposal))
        results = await asyncio.gather(*(probe(storage_without_cookies(source_state, proposal)) for proposal in unique))
        passing = [proposal for proposal, clean in zip(unique, results) if clean]
        if passing:
            next_current = min(passing, key=lambda proposal: (len(proposal), proposal))
            if next_current == current:
                if granularity >= len(current):
                    break
                granularity = min(len(current), granularity * 2)
                continue
            current = next_current
            granularity = max(2, granularity - 1)
            continue
        if granularity >= len(current):
            break
        granularity = min(len(current), granularity * 2)

    return current


# Max concurrent cookie-variant probes in one recover wave (settle + LLM overlap).
# Probes MUST run on ephemeral provider sessions — never on the live Kernel desktop.
_COOKIE_PROBE_WAVE_CAP = 5


async def recover_from_challenge(
    *,
    source_state: StorageState,
    target_url: str,
    wait_for_solver: WaitForSolver,
    probe: Probe,
    commit_cookie_removals: CommitCookies,
    search_configs: ConfigSearch,
    progress: Progress,
    skip_cookie_probes: bool = False,
    allow_logged_out_cookie_commit: bool = False,
) -> ChallengeRecoveryResult:
    """Run solver → ephemeral cookie-probe wave → config-search promote (same verifier + handover).

    ``probe`` must hit ephemeral provider sessions (or a test double), **not**
    ``new_context`` on the live Kernel browser — that paints stacked Chromium
    windows into the debug view. Known anti-bot / guest strips that probe clean
    promote via the same config-search verifier and session handover as proxy
    recovery (not a live-tab cookie strip). When ``allow_logged_out_cookie_commit``
    is true (tool-call param for guest/anonymous tasks), prefer a clean
    ``all_target`` strip over a weaker known-challenge-only strip. Opaque cookie
    findings stay diagnostic and escalate to config search.
    """
    original_digest = _state_digest(source_state)

    async def search_with_preserved_auth_state(
        proven_safe_removals: Sequence[CookieKey] = (),
    ) -> ChallengeRecoveryResult:
        if _state_digest(source_state) != original_digest:
            raise RuntimeError("Challenge recovery mutated its source browser state")
        cookies_by_key = {
            cookie_key(cookie): cookie
            for cookie in source_state.get("cookies") or []
            if isinstance(cookie, Mapping)
        }
        if any(
            key not in cookies_by_key
            or is_auth_cookie(cookies_by_key[key])
            or not is_known_challenge_cookie(cookies_by_key[key])
            for key in proven_safe_removals
        ):
            raise RuntimeError("Challenge recovery refused an unproven cookie removal")
        await progress(
            "browser_config_search",
            "Searching permission-compatible Kernel and Steel browser/IP configurations "
            "across cookie lanes (configs sequential within each lane).",
        )
        preserve_auth = not allow_logged_out_cookie_commit
        lanes = build_config_search_lanes(
            source_state,
            preserve_auth=preserve_auth,
            proven_safe_removals=proven_safe_removals,
        )
        config_result = await search_configs(lanes)
        if config_result.get("success") is False:
            raise ChallengeConfigSearchFailedError(config_result)
        return ChallengeRecoveryResult(
            "config_selected",
            tuple(proven_safe_removals),
            config_result,
        )

    await progress(
        "captcha_solver",
        "Waiting for the browser provider's automatic CAPTCHA solver before changing state.",
    )
    await wait_for_solver()

    if skip_cookie_probes:
        return await search_with_preserved_auth_state()

    cookies = {
        cookie_key(cookie): cookie for cookie in source_state.get("cookies") or [] if isinstance(cookie, Mapping)
    }
    target_keys = target_cookie_keys(source_state, target_url)
    known_safe = tuple(
        key for key in target_keys if is_known_challenge_cookie(cookies[key]) and not is_auth_cookie(cookies[key])
    )
    diagnostic_keys = tuple(key for key in target_keys if not is_auth_cookie(cookies[key]))

    # One parallel wave: ≤5 distinct cookie variants on ephemeral sessions.
    wave: List[Tuple[str, Tuple[CookieKey, ...], StorageState]] = []
    if known_safe:
        wave.append(("known_challenge", known_safe, storage_without_cookies(source_state, known_safe)))
    if target_keys and tuple(target_keys) != known_safe:
        wave.append(("all_target", tuple(target_keys), storage_without_cookies(source_state, target_keys)))
    if diagnostic_keys and diagnostic_keys != known_safe and diagnostic_keys != tuple(target_keys):
        wave.append(
            ("diagnostic", diagnostic_keys, storage_without_cookies(source_state, diagnostic_keys))
        )
    # Fill remaining slots with coarse halves of the largest removable set so the
    # wave stays useful under the ≤5 parallel LLM budget without ddmin rounds.
    base_for_halves = diagnostic_keys or tuple(target_keys)
    if len(wave) < _COOKIE_PROBE_WAVE_CAP and len(base_for_halves) >= 4:
        mid = len(base_for_halves) // 2
        for label, keys in (
            ("diagnostic_half_a", base_for_halves[:mid]),
            ("diagnostic_half_b", base_for_halves[mid:]),
        ):
            if len(wave) >= _COOKIE_PROBE_WAVE_CAP or not keys:
                break
            if any(existing == keys for _label, existing, _state in wave):
                continue
            wave.append((label, keys, storage_without_cookies(source_state, keys)))
    wave = wave[:_COOKIE_PROBE_WAVE_CAP]

    clean_by_label: Dict[str, bool] = {}
    if wave:
        await progress(
            "cookie_probe_wave",
            f"Probing {len(wave)} cookie variant(s) in parallel on ephemeral browser "
            "sessions (not the live debug desktop; known challenge strips may commit, "
            "others are diagnostic).",
        )
        results = await asyncio.gather(
            *(probe(state) for _label, _keys, state in wave),
            return_exceptions=True,
        )
        clean_by_label = {
            label: False if isinstance(result, BaseException) else bool(result)
            for (label, _keys, _state), result in zip(wave, results)
        }

    if _state_digest(source_state) != original_digest:
        raise RuntimeError("Challenge recovery mutated its source browser state")

    # When fresh-cookie recovery is allowed, prefer the stronger all_target strip
    # over a known-challenge-only strip if both probed clean. Preferring the weak
    # strip first left poisoned non-challenge cookies on the live tab (Hotels.com
    # GraphQL 429 soft-blocks after Bot-or-Not clear). Promote via config-search
    # verifier + session handover (same path as proxy recovery) — never live-strip.
    all_target_keys = tuple(target_keys)
    if (
        allow_logged_out_cookie_commit
        and all_target_keys
        and clean_by_label.get("all_target")
    ):
        await progress(
            "browser_config_search",
            "Guest path: all-target cookie strip probed clean on an ephemeral session; "
            "promoting via the same config-search verifier and session handover "
            "(not a live-tab cookie strip).",
        )
        # Guest allow_logged_out already sets preserve_auth=False, which includes
        # the fully stripped lane — same promote handover as config search.
        return await search_with_preserved_auth_state()

    if known_safe and clean_by_label.get("known_challenge"):
        # Same verifier + handover as proxy config recovery: do not mutate the
        # live tab. Promote via config-search with the stripped cookie lane.
        await progress(
            "browser_config_search",
            "Known-challenge cookie strip probed clean on an ephemeral session; "
            "promoting via the same config-search verifier and session handover "
            "(not a live-tab cookie strip).",
        )
        return await search_with_preserved_auth_state(known_safe)

    diagnostic_clean = any(
        clean_by_label.get(label)
        for label in ("all_target", "diagnostic", "diagnostic_half_a", "diagnostic_half_b")
    )
    if diagnostic_clean:
        # Clean logged-out / stripped probes are diagnostic only — opaque cookies
        # may be auth credentials, so never commit unclassified removals on
        # signed-in / default paths. Fresh-cookie recoveries still escalate to
        # config search, but must not claim auth is being preserved.
        if allow_logged_out_cookie_commit:
            await progress(
                "fresh_cookie_config_search",
                "A cookie variant looked clean in isolation but is not a safe live commit; "
                "searching configs with a fresh cookie lane.",
            )
        else:
            await progress(
                "preserve_auth_state",
                "A cookie variant looked clean in isolation, but unknown cookies are preserved; "
                "continuing with browser/IP search.",
            )
        return await search_with_preserved_auth_state()

    return await search_with_preserved_auth_state()
