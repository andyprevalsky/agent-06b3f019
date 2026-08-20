"""Blackbox tests for staged, auth-preserving browser challenge recovery."""

import asyncio
import copy
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _test_utils import BlackboxResult
from domains.spawn_browser_agent_v3.challenge_recovery import (
    blocked_resource_urls_for_verify,
    commit_cookie_removals,
    cookie_key,
    is_auth_cookie,
    is_usable_document_title,
    page_looks_challenged,
    recover_from_challenge,
    target_looks_like_payment_document,
    verify_live_blocked_resources,
    verify_live_page_cleared_challenge,
)


def _cookie(name, domain=".order.online"):
    return {"name": name, "value": f"value-{name}", "domain": domain, "path": "/"}


def _state(*cookies):
    return {
        "cookies": list(cookies),
        "origins": [
            {
                "origin": "https://order.online",
                "localStorage": [{"name": "signedInCart", "value": "keep-me"}],
                "indexedDB": [{"name": "account", "version": 1, "stores": []}],
            }
        ],
    }


async def _run(source, probe, *, live_commit_clean=True):
    events = []
    committed = []
    config_inputs = []
    solver_finished = False
    tool_call_id = "call-recovery-1"

    async def wait_for_solver():
        nonlocal solver_finished
        assert events[-1][1] == "captcha_solver"
        solver_finished = True

    async def guarded_probe(candidate):
        assert solver_finished, "cookie probes must never run before the provider solver"
        return await probe(candidate)

    async def progress(stage, message):
        events.append((tool_call_id, stage, message))

    async def commit(keys):
        committed.extend(keys)
        return live_commit_clean

    async def search_configs(state):
        config_inputs.append(state)
        return {"provider": "steel", "proxy_mode": "fixed", "ws_url": "wss://winner"}

    result = await recover_from_challenge(
        source_state=source,
        target_url="https://order.online/store/blue-bottle",
        wait_for_solver=wait_for_solver,
        probe=guarded_probe,
        commit_cookie_removals=commit,
        search_configs=search_configs,
        progress=progress,
    )
    return result, events, committed, config_inputs


async def test_known_challenge_cookie_is_removed_without_touching_auth():
    source = _state(_cookie("cf_clearance"), _cookie("authState"), _cookie("cart"))
    before = copy.deepcopy(source)

    async def probe(candidate):
        return "cf_clearance" not in {cookie["name"] for cookie in candidate["cookies"]}

    result, events, committed, config_inputs = await _run(source, probe)
    assert result.recovery == "cookies_sanitized"
    assert committed == [cookie_key(_cookie("cf_clearance"))]
    assert config_inputs == []
    assert source == before, "experimental probes must not mutate canonical state"
    assert {event[0] for event in events} == {"call-recovery-1"}
    assert [event[1] for event in events][:2] == ["captcha_solver", "known_challenge_cookies"]
    assert all("authState" not in event[2] for event in events)


async def test_explicit_provider_exit_rejection_skips_cookie_probes_but_not_solver():
    source = _state(_cookie("cf_clearance"), _cookie("authState"), _cookie("opaque_state"))
    before = copy.deepcopy(source)
    events = []
    config_inputs = []
    solver_calls = 0

    async def wait_for_solver():
        nonlocal solver_calls
        solver_calls += 1

    async def forbidden_probe(_candidate):
        raise AssertionError("an explicitly rejected IP must not trigger cookie experiments")

    async def forbidden_commit(_keys):
        raise AssertionError("an explicitly rejected IP must not mutate live cookies")

    async def search_configs(state):
        config_inputs.append(copy.deepcopy(state))
        return {"provider": "kernel", "proxy_mode": "isp_city", "ws_url": "wss://winner"}

    async def progress(stage, message):
        events.append((stage, message))

    result = await recover_from_challenge(
        source_state=source,
        target_url="https://order.online/store/blue-bottle",
        wait_for_solver=wait_for_solver,
        probe=forbidden_probe,
        commit_cookie_removals=forbidden_commit,
        search_configs=search_configs,
        progress=progress,
        provider_exit_rejected=True,
    )

    assert solver_calls == 1, "provider-native CAPTCHA solving must remain first"
    assert [stage for stage, _ in events] == ["captcha_solver", "browser_config_search"]
    assert config_inputs == [
        _state(_cookie("authState"), _cookie("opaque_state"))
    ], "auth/opaque survive; IP-bound cf_clearance must not be transplanted onto a new exit"
    assert source == before
    assert result.recovery == "config_selected"
    assert result.removed_cookie_keys == ()


async def test_unknown_cookie_isolated_with_parallel_delta_debugging():
    source = _state(*(_cookie(name) for name in ["prefs", "cart", "poison", "analytics", "theme", "ab"]))
    before = copy.deepcopy(source)
    active = 0
    max_active = 0

    async def probe(candidate):
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0)
        clean = "poison" not in {cookie["name"] for cookie in candidate["cookies"]}
        active -= 1
        return clean

    result, events, committed, config_inputs = await _run(source, probe)
    assert result.recovery == "config_selected"
    assert committed == [], "unclassified cookies are diagnostic-only and never deleted"
    assert config_inputs == [before], "config search must retain every opaque cookie"
    assert source == before
    assert max_active >= 2, "delta-debug rounds must probe cookie groups concurrently"
    assert "all_target_cookies" in [event[1] for event in events]
    assert "unclassified_cookies" in [event[1] for event in events]
    assert "cookie_isolation" in [event[1] for event in events]
    assert "preserve_auth_state" in [event[1] for event in events]


async def test_opaque_auth_cookie_that_looks_like_poison_is_never_committed():
    source = _state(_cookie("opaque_state"), _cookie("prefs"), _cookie("cart"))
    before = copy.deepcopy(source)

    async def probe(candidate):
        # This simulates the dangerous ambiguity: deleting the custom-named auth
        # cookie redirects to a visually clean logged-out page. A challenge-only
        # probe therefore reports success even though auth has been destroyed.
        return "opaque_state" not in {cookie["name"] for cookie in candidate["cookies"]}

    result, events, committed, config_inputs = await _run(source, probe)

    assert result.recovery == "config_selected"
    assert committed == []
    assert result.removed_cookie_keys == ()
    assert config_inputs == [before]
    assert source == before
    assert "preserve_auth_state" in [event[1] for event in events]
    assert all("opaque_state" not in event[2] for event in events)


async def test_auth_smelling_poison_is_preserved_and_silently_escalated():
    source = _state(_cookie("authState"), _cookie("cart"), _cookie("prefs"))
    before = copy.deepcopy(source)

    async def probe(candidate):
        return "authState" not in {cookie["name"] for cookie in candidate["cookies"]}

    result, events, committed, config_inputs = await _run(source, probe)
    assert result.recovery == "config_selected"
    assert committed == []
    assert config_inputs == [before], "config search must receive the complete auth-bearing state"
    assert source == before
    assert all("authState" not in event[2] for event in events), "auth suspects are not surfaced"
    assert [event[1] for event in events][-1] == "browser_config_search"


async def test_cookie_independent_challenge_goes_directly_to_config_search():
    source = _state(_cookie("prefs"), _cookie("cart"))

    async def probe(_candidate):
        return False

    result, events, committed, config_inputs = await _run(source, probe)
    assert result.recovery == "config_selected"
    assert committed == []
    assert config_inputs == [source]
    stages = [event[1] for event in events]
    assert stages == ["captcha_solver", "all_target_cookies", "browser_config_search"]


async def test_config_search_strips_challenge_cookies_even_when_cookie_probes_fail():
    """Fresh provider/IP probes must not inherit blocked-exit clearance cookies."""
    source = _state(
        _cookie("cf_clearance"),
        _cookie("__cf_bm"),
        _cookie("authState"),
        _cookie("cart"),
    )

    async def probe(_candidate):
        return False

    result, events, committed, config_inputs = await _run(source, probe)
    assert result.recovery == "config_selected"
    assert committed == []
    assert result.removed_cookie_keys == ()
    assert config_inputs == [_state(_cookie("authState"), _cookie("cart"))]
    assert "cf_clearance" not in {c["name"] for c in config_inputs[0]["cookies"]}
    assert "__cf_bm" not in {c["name"] for c in config_inputs[0]["cookies"]}
    assert [event[1] for event in events][-1] == "browser_config_search"


async def test_isolated_cookie_pass_must_still_pass_in_the_live_context():
    source = _state(_cookie("cf_clearance"), _cookie("authState"), _cookie("cart"))
    before = copy.deepcopy(source)

    async def probe(candidate):
        return "cf_clearance" not in {cookie["name"] for cookie in candidate["cookies"]}

    result, events, committed, config_inputs = await _run(
        source,
        probe,
        live_commit_clean=False,
    )
    assert result.recovery == "config_selected"
    assert committed == [cookie_key(_cookie("cf_clearance"))]
    assert config_inputs == [
        _state(_cookie("authState"), _cookie("cart"))
    ], "an unstable live fix must retain auth while keeping proven challenge poison filtered"
    assert result.removed_cookie_keys == (cookie_key(_cookie("cf_clearance")),)
    assert [event[1] for event in events][-1] == "browser_config_search"
    assert {event[0] for event in events} == {"call-recovery-1"}
    assert source == before


async def test_other_site_cookies_are_never_candidates():
    source = _state(_cookie("poison", ".unrelated.example"), _cookie("prefs"))

    async def probe(candidate):
        return "poison" not in {cookie["name"] for cookie in candidate["cookies"]}

    result, _events, committed, config_inputs = await _run(source, probe)
    assert result.recovery == "config_selected"
    assert committed == []
    assert config_inputs == [source]


def test_auth_classifier_is_conservative():
    for name in ["authState", "ddweb_token", "sessionid", "accessToken", "sid"]:
        assert is_auth_cookie(_cookie(name)), name
    for name in ["cf_clearance", "cart", "theme"]:
        assert not is_auth_cookie(_cookie(name)), name


def test_challenge_page_classifier_rejects_navigation_shell_titles():
    """Soft-wall shells must not win candidate probes without a real title.

    RCA (browser-hotel-booking 101e508c): backend probes marked stablePasses=2 on
    titles "", "www.<host>", and "Loading https://..." while the live tab was
    still challenged. Gate is structural (empty / bare-hostname / Loading-URL /
    raw-URL titles) — not a vendor or registrable-domain token list.
    """
    long_body = (
        "Boutique hotel description that already appears in meta/noscript while "
        "the anti-bot soft-wall has not yet produced a real document title. "
        "This text alone must not clear the probe."
    )
    assert not is_usable_document_title("")
    assert not is_usable_document_title("www.example.com")
    assert not is_usable_document_title("example.com")
    assert not is_usable_document_title("Loading https://www.example.com/rooms")
    assert not is_usable_document_title("https://www.example.com/rooms")
    assert is_usable_document_title("Boutique Hotel Near Downtown")

    assert page_looks_challenged(
        status=None, title="", body_text=long_body, html="<main>shell</main>"
    ), "empty title + long body must stay challenged"
    assert page_looks_challenged(
        status=None,
        title="www.example.com",
        body_text=long_body,
        html="<main>shell</main>",
    ), "bare-hostname title must stay challenged"
    assert page_looks_challenged(
        status=None,
        title="Loading https://www.example.com/path",
        body_text=long_body,
        html="<main>shell</main>",
    ), "Chromium Loading-URL title must stay challenged"
    assert not page_looks_challenged(
        status=200,
        title="Boutique Hotel Near Downtown",
        body_text=long_body,
        html="<main>Real inventory copy for rooms and rates.</main>",
    ), "usable title + substance must read clean"


def test_challenge_page_classifier_rejects_blank_and_known_walls():
    assert page_looks_challenged(status=403, title="", body_text="", html="")
    assert page_looks_challenged(
        status=200,
        title="Just a moment",
        body_text="Please verify you are human",
        html="",
    )
    assert page_looks_challenged(
        status=None,
        title="",
        body_text="",
        html="<html><head></head><body></body></html>",
    )
    assert not page_looks_challenged(
        status=200,
        title="Blue Bottle Coffee",
        body_text="Order drinks and pastries",
        html="<main>Menu</main>",
    )
    # Cleared Eventim ticket pages embed Turnstile/challenge-platform scripts
    # next to real inventory copy — those HTML markers alone must not fail.
    assert not page_looks_challenged(
        status=200,
        title="Buy tickets to LYNY in San Francisco on August 14, 2026",
        body_text=(
            "General Admission Tier 1 $25.00 Add to cart Select quantity and continue to checkout."
        ),
        html=(
            '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>'
            '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>'
            "<main>General Admission</main>"
        ),
    )
    assert page_looks_challenged(
        status=200,
        title="Access Denied",
        body_text="You have been blocked. Access Denied. Ray ID a2685f1cff22d940.",
        html='<script src="/cdn-cgi/challenge-platform/x.js"></script>',
    )
    # Sparse interstitial body + challenge script still counts as a wall.
    assert page_looks_challenged(
        status=200,
        title="Store",
        body_text="Coffee",
        html='<script src="/cdn-cgi/challenge-platform/x.js"></script>',
    )
    # "just a moment" / "access denied" in script/i18n bundles must not flag a
    # cleared page with substantive rendered body (probe false-positive).
    assert not page_looks_challenged(
        status=200,
        title="Buy tickets to LYNY in San Francisco on August 14, 2026",
        body_text=(
            "General Admission Tier 1 $25.00 Add to cart Select quantity and continue to checkout."
        ),
        html=(
            '<script>window.__i18n={"cf":"just a moment","deny":"access denied",'
            '"rate":"too many requests"}</script><main>General Admission</main>'
        ),
    )


async def test_live_tab_verify_accepts_clean_and_rejects_access_denied():
    class FakeBody:
        def __init__(self, page):
            self.page = page

        async def inner_text(self, timeout):
            assert timeout == 2_000
            return self.page.body_text

    class FakePage:
        def __init__(self, title, body_text, html, *, flip_to_denied_on_goto=False):
            self._title = title
            self.body_text = body_text
            self._html = html
            self.goto_count = 0
            self.flip_to_denied_on_goto = flip_to_denied_on_goto

        async def title(self):
            return self._title

        def locator(self, selector):
            assert selector == "body"
            return FakeBody(self)

        async def content(self):
            return self._html

        async def goto(self, *_args, **_kwargs):
            self.goto_count += 1
            if self.flip_to_denied_on_goto:
                self._title = "Access Denied"
                self.body_text = "Access Denied"
                self._html = "<h1>Access Denied</h1>"
            return None

        async def wait_for_timeout(self, _milliseconds):
            return None

    clean = FakePage("LYNY", "General Admission Tier 2", "<main>tickets</main>")
    assert await verify_live_page_cleared_challenge(
        clean, "https://wl.eventim.us/event/lyny/1", attempts=2, solver_timeout_seconds=0
    )
    # Must navigation-probe — static preloaded content is not enough.
    assert clean.goto_count == 2

    denied = FakePage("Access Denied", "Access Denied", "<h1>Access Denied</h1>")
    assert not await verify_live_page_cleared_challenge(
        denied, "https://wl.eventim.us/event/lyny/1", attempts=1, solver_timeout_seconds=0
    )
    assert denied.goto_count == 1

    # Eventim false-stable: already-loaded probe page looks clean, fresh goto denies.
    false_stable = FakePage(
        "LYNY",
        "General Admission Tier 2",
        "<main>tickets</main>",
        flip_to_denied_on_goto=True,
    )
    assert not await verify_live_page_cleared_challenge(
        false_stable,
        "https://wl.eventim.us/event/lyny/1",
        attempts=1,
        solver_timeout_seconds=0,
    )
    assert false_stable.goto_count == 1


def test_payment_document_url_detection():
    # Path allowlists removed — always False.
    assert not target_looks_like_payment_document("https://checkout.eventim.us/?afflky=1015Folsom")
    assert not target_looks_like_payment_document("https://shop.example/cart")
    assert not target_looks_like_payment_document("https://wl.eventim.us/event/lyny/692405")


def test_blocked_resource_requires_payment_cdn():
    from domains.spawn_browser_agent_v3.recording import blocked_resource_requires_payment_cdn

    # Any absolute http(s) URL latches — no vendor host allowlists.
    assert blocked_resource_requires_payment_cdn("https://js.cdn.example/v3")
    assert blocked_resource_requires_payment_cdn("https://cdn.example/widget.js")
    assert blocked_resource_requires_payment_cdn("https://api.example.com/v1/tokens")
    assert blocked_resource_requires_payment_cdn("https://wl.eventim.us/cdn-cgi/challenge")
    assert not blocked_resource_requires_payment_cdn(None)
    assert not blocked_resource_requires_payment_cdn("")
    assert not blocked_resource_requires_payment_cdn("not-a-url")


def test_blocked_resource_urls_for_verify_dedupes_and_strips_query():
    assert blocked_resource_urls_for_verify(
        [
            "https://js.stripe.com/v3?foo=1",
            "https://js.stripe.com/v3/",
            "not-a-url",
            "https://cdn.example/app.js#x",
        ]
    ) == (
        "https://js.stripe.com/v3",
        "https://js.stripe.com/v3/",
        "https://cdn.example/app.js",
    )


async def test_live_blocked_resource_verify_is_failure_driven():
    """Empty blocked list must not false-negative plain CF recovery."""

    class FakePage:
        def __init__(self, result: bool):
            self.result = result
            self.evaluate_calls = 0
            self.last_args = None

        async def evaluate(self, _script, args=None):
            self.evaluate_calls += 1
            self.last_args = args
            return self.result

    # No blocked URLs => vacuously OK, no page evaluate.
    assert await verify_live_blocked_resources(FakePage(False), [])
    ok = FakePage(True)
    bad = FakePage(False)
    assert await verify_live_blocked_resources(ok, ["https://js.stripe.com/v3"])
    assert not await verify_live_blocked_resources(bad, ["https://js.stripe.com/v3"])
    assert ok.evaluate_calls == 1
    assert bad.evaluate_calls == 1
    assert ok.last_args["targets"] == ["https://js.stripe.com/v3"]
    assert ok.last_args["scriptFlags"] == [True]


def test_challenge_page_classifier_detects_kernel_provider_blacklist():
    """Kernel 502 provider_blacklisted must not read as a clean recovered page.

    RCA cement for agent-payment-production-purchase (882509fd): checkout.stripe.com
    returns HTTP 502 with x-kernel-proxy-error: provider_blacklisted. Challenge
    recovery previously promoted another Kernel residential/ISP exit as "stable"
    because the classifier ignored 502 + blacklist markers, then the agent burned
    the $5 budget looping recoveries that could never clear a domain denylist.
    """
    assert page_looks_challenged(
        status=502,
        title="Bad Gateway",
        body_text="Proxy error",
        html="<html><body>Bad Gateway</body></html>",
    )
    assert page_looks_challenged(
        status=200,
        title="Error",
        body_text="Upstream refused: provider_blacklisted for this destination",
        html="",
    )
    assert page_looks_challenged(
        status=200,
        title="Proxy Error",
        body_text="Blocked",
        html="<html><body>x-kernel-proxy-error: provider_blacklisted</body></html>",
    )


def test_challenge_page_classifier_detects_non_cloudflare_vendors():
    """HTTP-200 interstitials from non-Cloudflare vendors are still challenges.

    These walls return 200 with benign title/body, so only the HTML fingerprint
    can catch them. When the classifier matched Cloudflare markers only, a
    DataDome interstitial read as a clean page: `recover_from_challenge` reported
    success, the caller re-probed, and one Expedia run burned four cycles / 312s
    looping on false recoveries. Vendor coverage here is kept at parity with
    `_CHALLENGE_COOKIE_RE`.
    """
    datadome = (
        '<html><head><title>expedia.com</title></head><body>'
        '<div id="ddchallengebody"></div>'
        '<iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=AHrl"></iframe>'
        "</body></html>"
    )
    assert page_looks_challenged(status=200, title="expedia.com", body_text="", html=datadome)
    assert page_looks_challenged(
        status=200,
        title="",
        body_text="loading",
        html='<script src="//client.perimeterx.net/px.js"></script>',
    )
    assert page_looks_challenged(
        status=200,
        title="",
        body_text="loading",
        html='<iframe src="/_Incapsula_Resource?SWKMTFSR=1"></iframe>',
    )


def test_challenge_page_classifier_detects_expedia_bot_or_not():
    """Expedia DataDome 'Bot or Not?' must classify as challenged.

    browser-hotel-booking (agent fead82a5-791a-43b8-b807-5e71226da866) landed on
    title "Bot or Not?" with #app-captcha-pwa. `live_tab_looks_challenged` returned
    False, so recover_from_challenge emitted skipped_clean_page and the model
    called request_user_assistance_for_authentication — evaluator then saw
    auth_assistance instead of write_lock.

    Three shapes from that dump must all read challenged:
    1. title + captcha instruction body with no vendor host in HTML
    2. #app-captcha-pwa shell without captcha-delivery.com
    3. captcha-delivery.com present but captcha prose clears the old 80-char
       substantive-content hatch (false-clean under the prior unified marker list)
    """
    title = "Bot or Not?"
    body = (
        "Show us your human side...\n"
        "We can't tell if you're a human or a bot.\n"
        "Slide right to secure your access. Press and hold the button.\n"
    )
    html_shell = (
        '<html><head><title>Bot or Not?</title></head><body>'
        '<div id="app-captcha-pwa">'
        '<iframe title="Verification"></iframe>'
        '<button id="captcha__audio_"></button>'
        '<button id="captcha__puzzle__button"></button>'
        f"{body}"
        "</div></body></html>"
    )
    html_with_vendor = html_shell.replace(
        '<iframe title="Verification"></iframe>',
        '<iframe title="Verification" '
        'src="https://geo.captcha-delivery.com/captcha/?cid=x"></iframe>',
    )

    assert page_looks_challenged(
        status=None, title=title, body_text=body, html="<html></html>"
    ), "title+body alone must match rendered text markers"
    assert page_looks_challenged(
        status=None, title=title, body_text=body, html=html_shell
    ), "#app-captcha-pwa interstitial container must be definitive"
    assert page_looks_challenged(
        status=None, title=title, body_text=body, html=html_with_vendor
    ), "captcha instruction prose must not clear an interstitial via substantive hatch"


def test_recovered_page_keeping_vendor_sensor_markup_reads_clean():
    """A vendor sensor bundle stays loaded AFTER a challenge clears.

    _CHALLENGE_HTML_MARKERS deliberately includes sensor hosts so a DataDome
    interstitial is caught (see the non-Cloudflare vendor test). But those same
    hosts remain on the real page once the wall lifts, so a marker alone must
    not mean "still challenged" - otherwise _wait_for_clean_page can never
    converge and recovery reports failure for a page that already works.
    """
    recovered = (
        '<html><head><title>Expedia - Hotels in San Francisco</title></head><body>'
        '<script src="//client.perimeterx.net/px.js"></script>'
        '<iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=AHrl"></iframe>'
        "<h1>Hotels in San Francisco</h1>"
        + ("<p>Book a room at one of 480 available San Francisco hotels tonight. </p>" * 20)
        + "</body></html>"
    )
    body = "Hotels in San Francisco " + ("Book a room at one of 480 available hotels. " * 20)
    assert not page_looks_challenged(
        status=200,
        title="Expedia - Hotels in San Francisco",
        body_text=body,
        html=recovered,
    ), "a recovered page that still loads sensor markup must read clean"

    # The interstitial form of the same vendor markup must still be caught.
    interstitial = (
        '<html><head><title>expedia.com</title></head><body>'
        '<div id="ddchallengebody"></div>'
        '<iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=AHrl"></iframe>'
        "</body></html>"
    )
    assert page_looks_challenged(status=200, title="expedia.com", body_text="", html=interstitial)


def test_commented_script_tag_does_not_delete_the_rest_of_the_page():
    """A `<script` that only appears inside an HTML comment must not blank the page.

    Script stripping runs two passes: complete blocks, then any UNTERMINATED
    opening tag through end-of-input (needed because `_wait_for_clean_page`
    truncates at 100k and can cut mid-script). That second pass deletes from the
    leftmost surviving `<script` onward — so a commented-out, unterminated tag
    like `<!-- <script src="legacy.js"> -->` took the whole rest of the document
    with it.

    This only bites when `body_text` is empty, because `_has_substantive_content`
    prefers body text and falls back to the stripped markup — exactly the state
    a browser reports when body-text extraction comes back blank but the DOM has
    content. The page still carries a vendor sensor marker, so with the markup
    gone it failed the 600-char bar, read as challenged, and the solver looped
    to timeout on a page that was already fine.
    """
    recovered = (
        "<html><head><title>Expedia - Hotels in San Francisco</title></head><body>"
        '<script src="//client.perimeterx.net/px.js"></script>'
        '<!-- legacy loader: <script src="legacy.js"> -->'
        "<h1>Hotels in San Francisco</h1>"
        + ("<p>Book a room at one of 480 available San Francisco hotels tonight. </p>" * 20)
        + "</body></html>"
    )
    # body_text empty on purpose: that is what makes visible_markup the deciding
    # signal, and it is the only state in which the tail-deletion bug is visible.
    assert not page_looks_challenged(
        status=200,
        title="Expedia - Hotels in San Francisco",
        body_text="",
        html=recovered,
    ), "a commented-out script tag must not wipe the visible markup after it"

    # A genuinely truncated inline script must STILL be stripped, so widening the
    # comment handling cannot re-open the hole the second pass exists to close.
    # A real interstitial: no rendered content, just the sensor div and a large
    # inline script the 100k truncation cut in half.
    truncated = (
        "<html><head><title>Just a moment...</title></head><body>"
        '<div id="ddchallengebody"></div>'
        '<script>var payload = "' + ("A" * 3000)
    )
    assert page_looks_challenged(
        status=200, title="Just a moment...", body_text="", html=truncated
    ), "raw text of a truncated inline script must not count as visible content"


def test_challenge_page_classifier_ignores_incidental_captcha_prose():
    """Widening vendor coverage must not flag pages that merely discuss captchas."""
    assert not page_looks_challenged(
        status=200,
        title="Help Center",
        body_text="How do I solve a captcha?",
        html="<article><p>How do I solve a captcha?</p></article>",
    )


async def test_live_cookie_commit_requires_two_clean_loads():
    class FakeContext:
        def __init__(self):
            self.cleared = []

        async def clear_cookies(self, **kwargs):
            self.cleared.append(kwargs)

    class FakeResponse:
        status = 200

    class FakeBody:
        def __init__(self, page):
            self.page = page

        async def inner_text(self, timeout):
            assert timeout == 2_000
            return self.page.body_text

    class FakePage:
        def __init__(self, body_text):
            self.context = FakeContext()
            self.body_text = body_text
            self.goto_count = 0

        async def goto(self, *_args, **_kwargs):
            self.goto_count += 1
            return FakeResponse()

        async def wait_for_timeout(self, _milliseconds):
            return None

        async def title(self):
            return "Blue Bottle Coffee"

        def locator(self, selector):
            assert selector == "body"
            return FakeBody(self)

        async def content(self):
            return f"<main>{self.body_text}</main>"

    key = cookie_key(_cookie("cf_clearance"))
    clean_page = FakePage("Order drinks and pastries")
    assert await commit_cookie_removals(
        clean_page,
        [key],
        "https://order.online/store/blue-bottle",
        solver_timeout_seconds=0,
    )
    assert clean_page.goto_count == 2
    assert clean_page.context.cleared == [
        {"name": "cf_clearance", "domain": ".order.online", "path": "/"}
    ]

    challenged_page = FakePage("Verify you are human")
    assert not await commit_cookie_removals(
        challenged_page,
        [key],
        "https://order.online/store/blue-bottle",
        solver_timeout_seconds=0,
    )
    assert challenged_page.goto_count == 1


async def run_all_tests():
    print("challenge-recovery blackbox tests:")
    result = BlackboxResult()
    await result.record_async("known_challenge_cookie", test_known_challenge_cookie_is_removed_without_touching_auth)
    await result.record_async(
        "explicit_provider_exit_rejection",
        test_explicit_provider_exit_rejection_skips_cookie_probes_but_not_solver,
    )
    await result.record_async(
        "unknown_cookie_parallel_ddmin", test_unknown_cookie_isolated_with_parallel_delta_debugging
    )
    await result.record_async(
        "opaque_auth_cookie_preserved",
        test_opaque_auth_cookie_that_looks_like_poison_is_never_committed,
    )
    await result.record_async("auth_poison_preserved", test_auth_smelling_poison_is_preserved_and_silently_escalated)
    await result.record_async(
        "cookie_independent_config_search", test_cookie_independent_challenge_goes_directly_to_config_search
    )
    await result.record_async(
        "config_search_strips_challenge_cookies",
        test_config_search_strips_challenge_cookies_even_when_cookie_probes_fail,
    )
    await result.record_async(
        "live_cookie_fix_stability",
        test_isolated_cookie_pass_must_still_pass_in_the_live_context,
    )
    await result.record_async("target_cookie_scope", test_other_site_cookies_are_never_candidates)
    result.record("auth_classifier", test_auth_classifier_is_conservative)
    result.record(
        "challenge_page_classifier_navigation_shell_titles",
        test_challenge_page_classifier_rejects_navigation_shell_titles,
    )
    result.record("challenge_page_classifier", test_challenge_page_classifier_rejects_blank_and_known_walls)
    result.record(
        "challenge_page_classifier_kernel_blacklist",
        test_challenge_page_classifier_detects_kernel_provider_blacklist,
    )
    result.record(
        "challenge_page_classifier_vendors",
        test_challenge_page_classifier_detects_non_cloudflare_vendors,
    )
    result.record(
        "challenge_page_classifier_expedia_bot_or_not",
        test_challenge_page_classifier_detects_expedia_bot_or_not,
    )
    result.record(
        "recovered_page_with_vendor_markup_reads_clean",
        test_recovered_page_keeping_vendor_sensor_markup_reads_clean,
    )
    result.record(
        "commented_script_does_not_delete_page",
        test_commented_script_tag_does_not_delete_the_rest_of_the_page,
    )
    result.record(
        "challenge_page_classifier_prose",
        test_challenge_page_classifier_ignores_incidental_captcha_prose,
    )
    await result.record_async(
        "live_tab_verify_access_denied",
        test_live_tab_verify_accepts_clean_and_rejects_access_denied,
    )
    result.record("payment_document_url_detection", test_payment_document_url_detection)
    result.record(
        "blocked_resource_requires_payment_cdn",
        test_blocked_resource_requires_payment_cdn,
    )
    result.record(
        "blocked_resource_url_normalize",
        test_blocked_resource_urls_for_verify_dedupes_and_strips_query,
    )
    await result.record_async(
        "live_blocked_resource_verify",
        test_live_blocked_resource_verify_is_failure_driven,
    )
    await result.record_async(
        "live_cookie_commit_two_passes",
        test_live_cookie_commit_requires_two_clean_loads,
    )
    return result.all_passed


if __name__ == "__main__":
    raise SystemExit(0 if asyncio.run(run_all_tests()) else 1)
