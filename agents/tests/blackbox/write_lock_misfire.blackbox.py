"""Real-browser blackbox tests for write-lock target resolution and classification.

Owns tests/fixtures/write_lock_misfire_corpus.json: each case is a distinct way
the browser agent's write-lock gate misread what an action would actually do
(wrong element text, wrong control, wrong key semantics, wrong field, wrong
grammar, wrong approval scope). Every case is served to headless Chromium and
driven through ``execute_action`` with the write lock enabled, using the real
DOMService / browser-use session and a recording humanizer, so the outcome is
the gate's real verdict for that page.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from _test_utils import BlackboxResult, teardown_mock

AGENTS_ROOT = Path(__file__).resolve().parent.parent.parent
FIXTURE = AGENTS_ROOT / "tests" / "fixtures" / "write_lock_misfire_corpus.json"
CLASSIFIER_SOURCES = (
    AGENTS_ROOT / "browser_tools" / "write_lock.py",
    AGENTS_ROOT / "browser_tools" / "write_lock_probe.py",
)
EXPECTED_CASE_COUNT = 23
OUTCOMES = {"none", "purchase", "return", "email_send", "social_post", "payment"}

_PAGE_SHELL = """<!doctype html>
<html><head><meta charset="utf-8"><title>{title}</title>
<style>body{{font-family:sans-serif;margin:24px}} button,a,input,textarea{{margin:8px;font-size:16px}}</style>
</head><body>{body}</body></html>"""

_DEEP_TARGET_JS = """
() => {
    const find = (root) => {
        const hit = root.querySelector('[data-wl-target]');
        if (hit) return hit;
        for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) {
                const inner = find(el.shadowRoot);
                if (inner) return inner;
            }
        }
        return null;
    };
    const el = find(document);
    if (!el) return JSON.stringify(null);
    el.scrollIntoView({block: 'center', inline: 'center'});
    const box = el.getBoundingClientRect();
    return JSON.stringify({x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2)});
}
"""

_FOCUS_TARGET_JS = """
() => {
    const find = (root) => {
        const hit = root.querySelector('[data-wl-target]');
        if (hit) return hit;
        for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) {
                const inner = find(el.shadowRoot);
                if (inner) return inner;
            }
        }
        return null;
    };
    const el = find(document);
    if (!el) return 'missing';
    el.focus();
    return 'focused';
}
"""


def _load_corpus() -> dict:
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    cases = data["cases"]
    assert len(cases) == EXPECTED_CASE_COUNT, len(cases)
    ids = [case["id"] for case in cases]
    assert len(set(ids)) == len(ids), "case ids must be unique"
    mistakes = [case["mistake"] for case in cases]
    assert len(set(mistakes)) == len(mistakes), "each case must describe a distinct mistake"
    for case in cases:
        assert case["expect"] in OUTCOMES, (case["id"], case["expect"])
        assert case["kind"] in {"false_positive", "false_negative"}, case["id"]
        assert (case["expect"] == "none") == (case["kind"] == "false_positive"), case["id"]
        assert "data-wl-target" in case["html"], case["id"]
    return data


class _RecordingHumanizer:
    """Stands in for BrowserHumanizer: records input instead of moving a mouse."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[Any, ...]]] = []

    async def click_at_coords(self, x: Any, y: Any) -> None:
        self.calls.append(("click_at_coords", (x, y)))

    async def type_text(self, text: str) -> None:
        self.calls.append(("type_text", (text,)))

    async def press_key(self, key: str) -> None:
        self.calls.append(("press_key", (key,)))

    async def scroll(self, delta_y: Any, at_coords: Any = None) -> None:
        self.calls.append(("scroll", (delta_y, at_coords)))


async def _chromium_executable() -> str:
    for name in ("CHROME_PATH", "CHROMIUM_PATH"):
        path = os.environ.get(name)
        if path and Path(path).exists():
            return path
    from playwright.async_api import async_playwright

    async with async_playwright() as playwright:
        path = playwright.chromium.executable_path
    if path and Path(path).exists():
        return path
    found = shutil.which("google-chrome") or shutil.which("chromium") or shutil.which("chromium-browser")
    if not found:
        raise RuntimeError("No Chromium executable found; run `python -m playwright install chromium`")
    return found


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class _CorpusServer:
    """Serves each case page; ``{frame_origin}`` in a case points at another origin's ``frame_html``.

    ``{frame_origin}`` differs only by port (same site, so Chromium renders the
    frame in-process); ``{cross_site_frame_origin}`` is another site (an
    out-of-process frame, like a payment provider's hosted field).
    """

    def __init__(self, cases: list[dict], *, frame_origin: str = "") -> None:
        pages = {}
        cross_site_frame_origin = frame_origin.replace("://127.0.0.1:", "://localhost:")
        for case in cases:
            body = (
                case["html"]
                .replace("{frame_origin}", frame_origin)
                .replace("{cross_site_frame_origin}", cross_site_frame_origin)
            )
            pages[f"/case/{case['id']}"] = _PAGE_SHELL.format(title=case["id"], body=body).encode("utf-8")
            if case.get("frame_html"):
                frame = _PAGE_SHELL.format(title=f"{case['id']} frame", body=case["frame_html"])
                pages[f"/frame/{case['id']}"] = frame.encode("utf-8")

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                body = pages.get(self.path.split("?", 1)[0])
                if body is None:
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args: Any) -> None:
                return

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


class _Browser:
    """Headless Chromium + the agent's real DOMService connected over CDP."""

    def __init__(self) -> None:
        self.port = _free_port()
        self.profile = tempfile.mkdtemp(prefix="wl-misfire-")
        self.proc: Any = None
        self.dom: Any = None

    async def start(self) -> None:
        from browser_tools.dom_service import DOMService

        self.proc = subprocess.Popen(
            [
                await _chromium_executable(),
                "--headless=new",
                f"--remote-debugging-port={self.port}",
                f"--user-data-dir={self.profile}",
                "--no-first-run",
                "--no-default-browser-check",
                "--no-sandbox",
                "--window-size=1280,900",
                "--use-mock-keychain",
                "about:blank",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        deadline = time.monotonic() + 30
        while True:
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{self.port}/json/version", timeout=1).read()
                break
            except Exception:
                if time.monotonic() > deadline or self.proc.poll() is not None:
                    raise RuntimeError("Chromium did not expose a CDP endpoint")
                await asyncio.sleep(0.2)
        self.dom = DOMService(cdp_url=f"http://127.0.0.1:{self.port}")
        await asyncio.wait_for(self.dom.connect(), 30)

    async def open(self, url: str) -> Any:
        page = await self.dom.session.get_current_page()
        await page.goto(url)
        for _ in range(100):
            if await page.evaluate("() => document.readyState") == "complete":
                break
            await asyncio.sleep(0.05)
        await asyncio.sleep(0.15)
        return page

    async def close(self) -> None:
        if self.dom is not None:
            try:
                await asyncio.wait_for(self.dom.disconnect(), 10)
            except Exception as error:
                print(f"    (DOMService disconnect failed: {error})")
        if self.proc is not None:
            self.proc.terminate()
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        shutil.rmtree(self.profile, ignore_errors=True)


def _target_index(dom: Any) -> int:
    matches = [
        index
        for index, node in dom.selector_map.items()
        if "data-wl-target" in (getattr(node, "attributes", None) or {})
    ]
    assert len(matches) == 1, f"expected exactly one data-wl-target in selector map, got {matches}"
    return matches[0]


def _outcome(result: dict) -> str:
    if result.get("status") == "needs_write_approval":
        return str(result.get("approval_type"))
    if result.get("success") is False and "field_description" in result:
        return "payment"
    return "none"


async def _run_case(browser: _Browser, server: _CorpusServer, case: dict) -> tuple[str, dict, list]:
    from browser_tools.dom_service import ActionHistory
    from domains.spawn_browser_agent_v3.service_actions import (
        apply_user_write_lock_grant,
        execute_action,
    )

    page = await browser.open(f"{server.base}/case/{case['id']}")
    spec = case["action"]
    action: dict[str, Any] = {"action": spec["action"], "params": dict(spec.get("params") or {})}

    await browser.dom.get_browser_state(include_screenshot=False)
    if spec.get("target") == "index":
        action["index"] = _target_index(browser.dom)
    elif spec.get("target") == "coordinates":
        coords = json.loads(await page.evaluate(_DEEP_TARGET_JS))
        assert coords, f"{case['id']}: target not rendered"
        action["coordinates"] = coords
    if spec.get("focus_target"):
        assert await page.evaluate(_FOCUS_TARGET_JS) == "focused", case["id"]

    approvals: dict = {}
    for grant in case.get("grants") or []:
        approvals = apply_user_write_lock_grant(approvals, grant["type"], grant["url"], time.time())

    humanizer = _RecordingHumanizer()
    result = await execute_action(
        browser.dom,
        ActionHistory(),
        action,
        humanizer=humanizer,
        current_url=case["url"],
        write_lock_enabled=True,
        write_lock_approvals=approvals or None,
        system_name="Rose",
    )
    return _outcome(result), result, humanizer.calls


# Real commits that sit next to the corpus exemptions (links, nameless
# controls, Enter in a field, a click the probe cannot see into). They locked
# before the fix and must still lock.
_EXEMPTION_GUARD_CASES = [
    {
        "id": "guard-link-styled-purchase-commit",
        "url": "https://www.example-shop.com/checkout/review",
        "html": '<p>Total $18.40</p><a href="/checkout/complete" class="btn" data-wl-target>Place order</a>',
        "action": {"action": "click", "target": "index"},
        "expect": "purchase",
    },
    {
        "id": "guard-link-styled-return-commit",
        "url": "https://www.example-shop.com/account/returns/42",
        "html": '<a href="/account/returns/42/submit" class="btn" data-wl-target>Submit return</a>',
        "action": {"action": "click", "target": "index"},
        "expect": "return",
    },
    {
        "id": "guard-nameless-icon-commit-reads-own-id",
        "url": "https://www.example-shop.com/checkout/review",
        "html": (
            '<button type="button" id="placeOrderBtn" data-wl-target>'
            '<svg aria-hidden="true" width="16" height="16"><rect width="16" height="16"/></svg></button>'
        ),
        "action": {"action": "click", "target": "index"},
        "expect": "purchase",
    },
    {
        "id": "guard-enter-in-field-submits-default-button",
        "url": "https://www.example-shop.com/checkout",
        "html": (
            '<form onsubmit="return false"><label for="pc">Promo code</label>'
            '<input id="pc" name="promo" data-wl-target><button type="submit">Place order</button></form>'
        ),
        "action": {"action": "press_key", "params": {"key": "Enter"}, "focus_target": True},
        "expect": "purchase",
    },
    {
        "id": "guard-link-click-on-coordinates-still-gates-purchase",
        "url": "https://www.example-shop.com/checkout/review",
        "html": '<a href="/checkout/complete" class="btn" data-wl-target>Place order</a>',
        "action": {"action": "click", "target": "coordinates"},
        "expect": "purchase",
    },
    {
        "id": "guard-enter-in-buttonless-form-reads-script-buttons",
        "url": "https://www.example-shop.com/messages/order-42",
        "html": (
            '<form onsubmit="return false"><input aria-label="Type a message" data-wl-target>'
            '<button type="button">Send</button></form>'
        ),
        "action": {"action": "press_key", "params": {"key": "Enter"}, "focus_target": True},
        "expect": "email_send",
    },
    {
        "id": "guard-click-into-cross-origin-frame-keeps-page-signal",
        "url": "https://www.example-shop.com/checkout/review",
        "html": (
            "<h2>Review and place order</h2><p>Total $42.10</p>"
            '<iframe title="PayPal" data-wl-target style="width:320px;height:80px;border:0" '
            'src="{frame_origin}/frame/guard-click-into-cross-origin-frame-keeps-page-signal"></iframe>'
        ),
        "frame_html": '<button type="button">Pay with PayPal</button>',
        "action": {"action": "click", "target": "coordinates"},
        "expect": "purchase",
    },
    {
        # The frame probe clears only text-field hits; a wallet button inside an
        # out-of-process frame keeps the page signal. The page is scrolled and a
        # field sits at the click's document-space point, so a frame probe that
        # mixed document and viewport coordinates would hit that field and unlock.
        "id": "guard-click-on-cross-site-wallet-button-keeps-page-signal",
        "url": "https://www.example-shop.com/checkout/review",
        "html": (
            '<input type="email" placeholder="Email" style="display:block;width:1200px;height:900px;margin:0">'
            '<div style="height:1500px"></div>'
            "<h2>Review and place order</h2><p>Total $42.10</p>"
            '<iframe title="Secure express checkout frame" data-wl-target style="width:320px;height:80px;border:0" '
            'src="{cross_site_frame_origin}/frame/guard-click-on-cross-site-wallet-button-keeps-page-signal"></iframe>'
        ),
        "frame_html": (
            "<style>body{margin:0}button{display:block;width:100%;height:80px;margin:0}</style>"
            '<button type="button">Pay with PayPal</button>'
        ),
        "action": {"action": "click", "target": "coordinates"},
        "expect": "purchase",
    },
]


async def _resolve_cases(cases: list[dict]) -> list[str]:
    frames = _CorpusServer(cases) if any(case.get("frame_html") for case in cases) else None
    server = _CorpusServer(cases, frame_origin=frames.base if frames else "")
    browser = _Browser()
    failures: list[str] = []
    try:
        await browser.start()
        for case in cases:
            try:
                outcome, result, calls = await _run_case(browser, server, case)
            except Exception as error:
                failures.append(f"{case['id']}: raised {type(error).__name__}: {error}")
                continue
            verdict = "ok" if outcome == case["expect"] else "MISFIRE"
            print(f"    {verdict:8} {case['id']}: expected={case['expect']} got={outcome}")
            if outcome != case["expect"]:
                failures.append(
                    f"{case['id']}: expected {case['expect']}, got {outcome} "
                    f"(element_text={str(result.get('element_text'))[:80]!r})"
                )
                continue
            # A gate that fires must fire BEFORE any input reaches the page.
            if case["expect"] != "none" and calls:
                failures.append(f"{case['id']}: input dispatched before the gate fired: {calls}")
    finally:
        await browser.close()
        server.close()
        if frames is not None:
            frames.close()
    return failures


async def test_corpus_cases_resolve_to_expected_write_lock():
    """Every misfire case must produce exactly its expected gate verdict in Chromium."""
    failures = await _resolve_cases(_load_corpus()["cases"])
    assert failures == [], f"{len(failures)} misfire(s):\n  " + "\n  ".join(failures)


async def test_exemptions_keep_real_commits_locked():
    """Link / nameless-control / Enter exemptions must not swallow real purchase or return commits."""
    failures = await _resolve_cases(_EXEMPTION_GUARD_CASES)
    assert failures == [], f"{len(failures)} guard regression(s):\n  " + "\n  ".join(failures)


def test_held_out_registrable_domains_stay_separate():
    """Site unlocks follow registrable domains under multi-label public suffixes."""
    from domains.spawn_browser_agent_v3.service_actions import _get_base_domain

    assert _get_base_domain("www.shop-one.com.au") == "shop-one.com.au"
    assert _get_base_domain("checkout.shop-one.co.jp") == "shop-one.co.jp"
    assert _get_base_domain("pay.store.org.uk") == "store.org.uk"
    assert _get_base_domain("auth.amazon.com") == "amazon.com"
    assert _get_base_domain("www.amazon.de") == "amazon.de"
    assert _get_base_domain("t.co") == "t.co"
    assert _get_base_domain("localhost") == "localhost"


def test_held_out_word_boundary_grammar():
    """Phrase and verb matches need word boundaries; joined ids and real commits still lock."""
    from browser_tools.write_lock import is_purchase_button, is_submit_button

    for label in ("Workplace orders", "Displace order history", "Showcase buy nowadays"):
        assert not is_purchase_button(label), label
    for label in ("Place order", "PLACE ORDER", "placeOrderButton", "Place\tPickup\tOrder", "Pay €18,00", "Pay USD 12"):
        assert is_purchase_button(label), label
    for label in ("Postal code", "12 Comments", "Shared with you", "Repository settings"):
        assert not is_submit_button(label), label
    for label in ("Post", "Reply all", "tweetButtonInline", "Repost", "Send"):
        assert is_submit_button(label), label


def test_held_out_auth_flow_routes():
    """Only a whole route segment or host label that is an auth step turns the social lock off."""
    from browser_tools.write_lock import is_social_domain

    for url in (
        "https://www.reddit.com/r/help/comments/abc123/i_cant_log_in/",
        "https://www.reddit.com/r/startups/comments/x1y2z3/how_to_register_an_llc/",
        "https://www.reddit.com/r/sysadmin/comments/q9w8e7/sso_setup_question/",
        "https://www.reddit.com/r/webdev/comments/k4j5h6/oauth2-authentication-flow-explained/",
        "https://www.linkedin.com/posts/jane-doe_why-i-stopped-using-sign-up-walls-activity-1234",
    ):
        assert is_social_domain(url), url
    for url in (
        "https://www.reddit.com/login/",
        "https://www.reddit.com/account/register/",
        "https://www.facebook.com/login.php",
        "https://x.com/i/flow/login",
        "https://www.instagram.com/accounts/emailsignup/",
        "https://www.linkedin.com/uas/user-sign-in",
        "https://www.tiktok.com/oauth2/authorize?client_key=abc",
        "https://login.discord.com/channels/@me",
    ):
        assert not is_social_domain(url), url


def test_anti_reward_hack_corpus_not_embedded_in_production():
    """Classifier/probe code must not import the fixture or paste its labels or ids."""
    from browser_tools.write_lock import PURCHASE_BUTTON_PHRASES, RETURN_BUTTON_PHRASES

    pre_existing_vocabulary = {p.lower() for p in PURCHASE_BUTTON_PHRASES + RETURN_BUTTON_PHRASES}
    probes: set[str] = set()
    for case in _load_corpus()["cases"]:
        if len(case["label"]) >= 12:
            probes.add(case["label"].lower())
        probes.update(v.lower() for v in re.findall(r'\bid="([^"]+)"', case["html"]) if len(v) >= 8)
    probes -= pre_existing_vocabulary

    embedded = []
    for source in CLASSIFIER_SOURCES:
        raw = source.read_text(encoding="utf-8")
        assert "write_lock_misfire_corpus" not in raw, source
        no_docs = re.sub(r'"""[\s\S]*?"""', "", raw)
        code_only = "\n".join(line.split("#", 1)[0] for line in no_docs.splitlines()).lower()
        embedded.extend(f"{source.name}:{p}" for p in sorted(probes) if p in code_only)
    assert embedded == [], f"corpus labels/ids embedded in production code: {embedded}"


async def run_all_tests():
    print("write-lock-misfire blackbox tests:")
    teardown_mock()
    r = BlackboxResult()
    await r.record_async(
        "corpus_cases_resolve_to_expected_write_lock",
        test_corpus_cases_resolve_to_expected_write_lock,
    )
    await r.record_async("exemptions_keep_real_commits_locked", test_exemptions_keep_real_commits_locked)
    r.record("held_out_registrable_domains_stay_separate", test_held_out_registrable_domains_stay_separate)
    r.record("held_out_word_boundary_grammar", test_held_out_word_boundary_grammar)
    r.record("held_out_auth_flow_routes", test_held_out_auth_flow_routes)
    r.record(
        "anti_reward_hack_corpus_not_embedded_in_production",
        test_anti_reward_hack_corpus_not_embedded_in_production,
    )
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
