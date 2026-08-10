"""Auth-preserving, staged recovery for persistent anti-bot challenges.

The canonical browser context is never used for experiments. Cookie variants are
passed to an injected probe (normally an isolated Playwright context), and only a
known anti-bot cookie reduction may be committed to the live context. Cookie-name
heuristics are useful for diagnosis but can never prove that an opaque cookie is
not authentication state. Unknown-cookie findings therefore keep the source state
byte-for-byte intact and move to a provider/proxy configuration search.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, Iterable, List, Mapping, Sequence, Tuple
from urllib.parse import urlparse

StorageState = Dict[str, Any]
CookieKey = Tuple[str, str, str]
Probe = Callable[[StorageState], Awaitable[bool]]
Progress = Callable[[str, str], Awaitable[None]]
CommitCookies = Callable[[Sequence[CookieKey]], Awaitable[bool]]
ConfigSearch = Callable[[StorageState], Awaitable[Mapping[str, Any]]]
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
_CHALLENGE_TEXT_MARKERS = (
    "access denied",
    "attention required! | cloudflare",
    "checking your browser",
    "enable javascript and cookies to continue",
    "just a moment",
    "performing security verification",
    "please verify you are a human",
    "sorry, you have been blocked",
    "this site can't be reached",
    "too many requests",
    "unusual traffic from your computer network",
    "verify you are human",
)
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
_CLEAN_PAGE_MIN_VISIBLE_CHARS = 600

_CHALLENGE_HTML_MARKERS = (
    # Cloudflare
    "/cdn-cgi/challenge-platform",
    "cf-chl-",
    "challenges.cloudflare.com/turnstile",
    # DataDome
    "captcha-delivery.com",
    "ddchallengebody",
    # PerimeterX
    "perimeterx.net",
    "px-captcha",
    # Imperva / Incapsula
    "_incapsula_resource",
    "incapsula incident id",
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


def page_looks_challenged(*, status: int | None, title: str, body_text: str, html: str) -> bool:
    if status in {403, 429}:
        return True
    content = f"{title}\n{body_text}".lower()
    if any(marker in content for marker in _CHALLENGE_TEXT_MARKERS):
        return True
    normalized_html = html.lower()
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
    if not any(marker in normalized_html for marker in _CHALLENGE_HTML_MARKERS):
        return False
    # A vendor marker alone is not proof: sensor scripts (perimeterx.net,
    # captcha-delivery.com, /cdn-cgi/challenge-platform) stay loaded on the real
    # page AFTER a challenge clears. Without this, _wait_for_clean_page could
    # never converge on a site that keeps its sensor bundle, and recovery would
    # report failure for a page that already works. A page that has recovered
    # renders substantive content, so treat that as clean.
    if _has_substantive_content(title, body_text, visible_markup):
        return False
    return True


def _has_substantive_content(title: str, body_text: str, visible_markup: str) -> bool:
    """A challenge interstitial shows almost nothing; a recovered page does not."""
    visible = body_text.strip() or visible_markup
    return len(visible) >= _CLEAN_PAGE_MIN_VISIBLE_CHARS and bool(title.strip())


async def _wait_for_clean_page(page: Any, response: Any, solver_timeout_seconds: float) -> bool:
    deadline = asyncio.get_running_loop().time() + solver_timeout_seconds
    current_response = response
    while True:
        await page.wait_for_timeout(2_000)
        snapshot = await asyncio.gather(
            page.title(),
            page.locator("body").inner_text(timeout=2_000),
            page.content(),
            return_exceptions=True,
        )
        title = snapshot[0] if isinstance(snapshot[0], str) else ""
        body_text = snapshot[1] if isinstance(snapshot[1], str) else ""
        html = snapshot[2] if isinstance(snapshot[2], str) else ""
        status = current_response.status if current_response is not None else None
        if not page_looks_challenged(
            status=status,
            title=title[:1_000],
            body_text=body_text[:20_000],
            html=html[:100_000],
        ):
            return True
        if asyncio.get_running_loop().time() >= deadline:
            return False
        current_response = None


async def _probe_page(
    page: Any,
    target_url: str,
    *,
    attempts: int,
    solver_timeout_seconds: float,
) -> bool:
    for _ in range(attempts):
        response = None
        try:
            response = await page.goto(target_url, wait_until="domcontentloaded", timeout=45_000)
        except Exception:
            pass
        if not await _wait_for_clean_page(page, response, solver_timeout_seconds):
            return False
    return True


async def probe_storage_state(
    playwright_browser: Any,
    storage_state: StorageState,
    target_url: str,
    *,
    attempts: int = 2,
    solver_timeout_seconds: float = 45.0,
) -> bool:
    """Probe a storage variant in an isolated remote-browser context."""
    context = await playwright_browser.new_context(storage_state=storage_state)
    try:
        page = await context.new_page()
        return await _probe_page(
            page,
            target_url,
            attempts=attempts,
            solver_timeout_seconds=solver_timeout_seconds,
        )
    finally:
        await context.close()



async def verify_live_page_cleared_challenge(
    page: Any,
    target_url: str,
    *,
    attempts: int = 2,
    solver_timeout_seconds: float = 45.0,
) -> bool:
    """Require the canonical live tab to clear challenge markers after promote/restore.

    Candidate probes can false-stable: a remote session's already-loaded probe
    content looks clean, then a fresh same-host navigation lands on Access Denied
    (Eventim Cloudflare). Never accept a static snapshot of preloaded content —
    always navigation-probe the target URL on the live tab.
    """
    return await _probe_page(
        page,
        target_url,
        attempts=attempts,
        solver_timeout_seconds=solver_timeout_seconds,
    )


async def commit_cookie_removals(
    page: Any,
    removed_cookie_keys: Sequence[CookieKey],
    target_url: str,
    *,
    attempts: int = 2,
    solver_timeout_seconds: float = 45.0,
) -> bool:
    """Delete proven-safe keys and require the canonical tab to pass twice."""
    context = page.context
    for name, domain, path in removed_cookie_keys:
        await context.clear_cookies(name=name, domain=domain, path=path)
    return await _probe_page(
        page,
        target_url,
        attempts=attempts,
        solver_timeout_seconds=solver_timeout_seconds,
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
    """Parallel delta-debug a passing removal down to a 1-minimal subset."""
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


async def recover_from_challenge(
    *,
    source_state: StorageState,
    target_url: str,
    wait_for_solver: WaitForSolver,
    probe: Probe,
    commit_cookie_removals: CommitCookies,
    search_configs: ConfigSearch,
    progress: Progress,
    provider_exit_rejected: bool = False,
) -> ChallengeRecoveryResult:
    """Run solver -> cookie isolation -> parallel provider/config recovery.

    The config search always receives the full auth-bearing state unless the only
    removals are from the explicit anti-bot-cookie allowlist. Auth-like and opaque
    cookies are never removed from the canonical context or named in progress.
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
            "Searching permission-compatible Kernel and Steel browser/IP configurations in parallel.",
        )
        # Never transplant IP-bound clearance cookies onto a new provider/proxy.
        # Keep auth + opaque cookies; strip every known challenge cookie even when
        # cookie-stage probes did not prove a live commit.
        challenge_keys = tuple(
            key
            for key, cookie in cookies_by_key.items()
            if is_known_challenge_cookie(cookie) and not is_auth_cookie(cookie)
        )
        config_state = storage_without_cookies(
            source_state,
            tuple(dict.fromkeys((*proven_safe_removals, *challenge_keys))),
        )
        config_result = await search_configs(config_state)
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

    # A detector can sometimes identify the network exit itself as the cause
    # (for example, an IP observed with many unrelated browser fingerprints).
    # In that case cookie experiments cannot improve the exit's reputation and
    # only risk wasting time around auth-bearing state. Still give the native
    # provider solver its normal first chance, then preserve the entire source
    # state and search fresh provider/IP configurations directly.
    if provider_exit_rejected:
        return await search_with_preserved_auth_state()

    cookies = {
        cookie_key(cookie): cookie for cookie in source_state.get("cookies") or [] if isinstance(cookie, Mapping)
    }
    target_keys = target_cookie_keys(source_state, target_url)
    known_safe = tuple(
        key for key in target_keys if is_known_challenge_cookie(cookies[key]) and not is_auth_cookie(cookies[key])
    )

    if known_safe:
        await progress(
            "known_challenge_cookies",
            "Testing an isolated copy without known challenge cookies; the signed-in context is unchanged.",
        )
        if await probe(storage_without_cookies(source_state, known_safe)):
            minimal = await minimize_passing_cookie_removal(source_state, known_safe, probe, progress)
            if _state_digest(source_state) != original_digest:
                raise RuntimeError("Challenge recovery mutated its source browser state")
            await progress(
                "apply_cookie_fix",
                "Applying the proven non-auth cookie fix and requiring two clean live-page probes.",
            )
            if await commit_cookie_removals(minimal):
                return ChallengeRecoveryResult("cookies_sanitized", minimal)
            return await search_with_preserved_auth_state(minimal)

    await progress(
        "all_target_cookies",
        "Testing an isolated copy without target-site cookies to distinguish state from network reputation.",
    )
    all_cookie_probe_clean = await probe(storage_without_cookies(source_state, target_keys))

    diagnostic_keys = tuple(key for key in target_keys if not is_auth_cookie(cookies[key]))
    if all_cookie_probe_clean and diagnostic_keys:
        await progress(
            "unclassified_cookies",
            "Testing unclassified target cookies in isolation; unknown cookies remain protected auth state.",
        )
        if await probe(storage_without_cookies(source_state, diagnostic_keys)):
            # This narrows the likely poison for diagnosis, but a clean logged-out
            # page is indistinguishable from a clean authenticated page here. Do
            # not commit or carry the removal into config search: an arbitrary
            # name such as ``opaque_state`` may be the site's auth credential.
            await minimize_passing_cookie_removal(
                source_state,
                diagnostic_keys,
                probe,
                progress,
            )
            if _state_digest(source_state) != original_digest:
                raise RuntimeError("Challenge recovery mutated its source browser state")
            await progress(
                "preserve_auth_state",
                "A cookie-specific cause was isolated, but unknown cookies are preserved; continuing with browser/IP search.",
            )
            return await search_with_preserved_auth_state()

    if _state_digest(source_state) != original_digest:
        raise RuntimeError("Challenge recovery mutated its source browser state")

    return await search_with_preserved_auth_state()
