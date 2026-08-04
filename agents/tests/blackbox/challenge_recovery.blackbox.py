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
    commit_cookie_removals,
    cookie_key,
    is_auth_cookie,
    page_looks_challenged,
    recover_from_challenge,
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
    assert config_inputs == [before], "auth, cookies, and origin storage must all survive"
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


def test_challenge_page_classifier_detects_bing_soft_verify_overlay():
    """Bing Cloudflare soft gates leave a Verify CTA over hidden organic results.

    Cookie recovery previously treated that DOM as clean (results + button, no
    classic "verify you are human" / cf-chl markers), falsely returned
    cookies_sanitized, skipped config search, and burned the benchmark budget
    in a Verify-click loop (browser-bing-search-single-result).
    """
    bing_results_html = (
        '<html><body class="b_respl">'
        '<div class="b_overlay"><button type="button">Verify</button></div>'
        '<ol id="b_results"><li class="b_algo">'
        '<h2><a href="https://openai.com">OpenAI | Research & Deployment</a></h2>'
        "<cite>https://openai.com</cite>"
        "</li></ol></body></html>"
    )
    assert page_looks_challenged(
        status=200,
        title="OpenAI official website - Search",
        body_text="Verify",
        html=bing_results_html,
    )
    assert page_looks_challenged(
        status=200,
        title="OpenAI official website - Search",
        body_text="Verification required\nVerify\n",
        html=bing_results_html,
    )
    # A normal Verify button on a non-results page must not trip the Bing gate.
    assert not page_looks_challenged(
        status=200,
        title="Checkout",
        body_text="Confirm your purchase",
        html='<form><button type="submit">Verify</button></form>',
    )


async def test_soft_verify_live_commit_escalates_to_config_search():
    """Isolated cookie probe may look clean; live soft-Verify must escalate."""
    source = _state(_cookie("cf_clearance", ".bing.com"), _cookie("authState", ".bing.com"))
    before = copy.deepcopy(source)

    async def probe(candidate):
        # Isolated probe falsely correlates cookie removal with a clean page.
        return "cf_clearance" not in {cookie["name"] for cookie in candidate["cookies"]}

    class FakeContext:
        async def clear_cookies(self, **_kwargs):
            return None

    class FakeResponse:
        status = 200

    class FakeBody:
        def __init__(self, page):
            self.page = page

        async def inner_text(self, timeout):
            assert timeout == 2_000
            return self.page.body_text

    class SoftVerifyPage:
        def __init__(self):
            self.context = FakeContext()
            self.body_text = "Verify"
            self.html = (
                '<html><body class="b_respl">'
                '<button type="button">Verify</button>'
                '<ol id="b_results"><li class="b_algo"><h2>OpenAI</h2></li></ol>'
                "</body></html>"
            )

        async def goto(self, *_args, **_kwargs):
            return FakeResponse()

        async def wait_for_timeout(self, _milliseconds):
            return None

        async def title(self):
            return "OpenAI official website - Search"

        def locator(self, selector):
            assert selector == "body"
            return FakeBody(self)

        async def content(self):
            return self.html

    events = []
    config_inputs = []

    async def wait_for_solver():
        return None

    async def progress(stage, message):
        events.append(stage)

    async def commit(keys):
        return await commit_cookie_removals(
            SoftVerifyPage(),
            keys,
            "https://www.bing.com/search?q=OpenAI+official+website",
            solver_timeout_seconds=0,
        )

    async def search_configs(state):
        config_inputs.append(state)
        return {"provider": "kernel", "proxy_mode": "isp_city", "ws_url": "wss://winner"}

    result = await recover_from_challenge(
        source_state=source,
        target_url="https://www.bing.com/search?q=OpenAI+official+website",
        wait_for_solver=wait_for_solver,
        probe=probe,
        commit_cookie_removals=commit,
        search_configs=search_configs,
        progress=progress,
    )

    assert result.recovery == "config_selected", result.recovery
    assert config_inputs, "soft Verify on the live tab must escalate to config search"
    assert "browser_config_search" in events
    assert source == before


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
        "live_cookie_fix_stability",
        test_isolated_cookie_pass_must_still_pass_in_the_live_context,
    )
    await result.record_async("target_cookie_scope", test_other_site_cookies_are_never_candidates)
    result.record("auth_classifier", test_auth_classifier_is_conservative)
    result.record("challenge_page_classifier", test_challenge_page_classifier_rejects_blank_and_known_walls)
    result.record(
        "bing_soft_verify_classifier",
        test_challenge_page_classifier_detects_bing_soft_verify_overlay,
    )
    await result.record_async(
        "soft_verify_live_commit_escalates",
        test_soft_verify_live_commit_escalates_to_config_search,
    )
    await result.record_async(
        "live_cookie_commit_two_passes",
        test_live_cookie_commit_requires_two_clean_loads,
    )
    return result.all_passed


if __name__ == "__main__":
    raise SystemExit(0 if asyncio.run(run_all_tests()) else 1)
