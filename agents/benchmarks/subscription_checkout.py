"""Complete a sandbox Stripe Checkout and deliver its verified event to a local bench stack."""

import asyncio
import hashlib
import hmac
import json
import os
import re
import time
from pathlib import Path
from urllib.parse import urlparse

import httpx
from playwright.async_api import async_playwright, expect


_SESSION_ID = re.compile(r"\bcs_test_[A-Za-z0-9]+\b")
_CHROME_PATHS = (
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
)


def _sandbox_session_id(checkout_url: str, stripe_key: str) -> str:
    parsed = urlparse(checkout_url)
    if parsed.scheme != "https" or parsed.hostname != "checkout.stripe.com":
        raise RuntimeError("Subscription gate did not provide a Stripe Checkout URL")
    if not stripe_key.startswith("sk_test_"):
        raise RuntimeError("Real subscription benchmark requires a Stripe test-mode secret key")
    match = _SESSION_ID.search(checkout_url)
    if match is None:
        raise RuntimeError("Stripe Checkout URL did not contain a test session ID")
    return match.group()


async def _fill_checkout_field(page, selectors: tuple[str, ...], value: str, label: str) -> None:
    deadline = time.monotonic() + 30
    observations = [dict(probes=0, matched_probes=0, visible_probes=0,
                         fill_attempts=0, last_exception_type=None) for _ in selectors]
    while time.monotonic() < deadline:
        for frame in page.frames:
            for index, selector in enumerate(selectors):
                locator = frame.locator(selector).first
                observed = observations[index]
                observed["probes"] += 1
                try:
                    if await locator.count():
                        observed["matched_probes"] += 1
                        if await locator.is_visible():
                            observed["visible_probes"] += 1
                            observed["fill_attempts"] += 1
                            await locator.fill(value, timeout=5000)
                            return
                except Exception as error:
                    observed["last_exception_type"] = type(error).__name__
                    continue
        await asyncio.sleep(0.5)
    raise RuntimeError(f"Stripe Checkout {label} field was not available; "
                       f"selector_diagnostics={json.dumps(observations, separators=(',', ':'))}")


async def _stripe_session(session_id: str, stripe_key: str) -> dict:
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(
            f"https://api.stripe.com/v1/checkout/sessions/{session_id}",
            auth=(stripe_key, ""),
        )
        response.raise_for_status()
        return response.json()


async def complete_test_subscription_checkout(
    base_url: str,
    checkout_url: str,
    user_id: str,
    *,
    stripe_key: str | None = None,
    webhook_secret: str | None = None,
) -> dict:
    """Pay through hosted Checkout, verify Stripe, then replay that real session locally.

    The isolated backend cannot receive Stripe's public webhook directly. The
    signed local delivery uses the actual completed session returned by Stripe.
    """
    stripe_key = stripe_key or os.environ.get("STRIPE_SECRET_KEY", "")
    webhook_secret = webhook_secret or os.environ.get("STRIPE_WEBHOOK_SECRET", "")
    if not webhook_secret:
        raise RuntimeError("STRIPE_WEBHOOK_SECRET is required for subscription Checkout")
    session_id = _sandbox_session_id(checkout_url, stripe_key)
    initial = await _stripe_session(session_id, stripe_key)
    if initial.get("status") != "open" or initial.get("client_reference_id") != user_id:
        raise RuntimeError("Checkout session is not open for the benchmark user")
    async with async_playwright() as playwright:
        executable = next((path for path in _CHROME_PATHS if Path(path).exists()), None)
        launch_options = {"headless": True}
        if executable is not None:
            launch_options["executable_path"] = executable
        browser = await playwright.chromium.launch(**launch_options)
        try:
            page = await browser.new_page()
            await page.goto(checkout_url, wait_until="domcontentloaded", timeout=60000)
            await _fill_checkout_field(page, ('input[type="email"]', 'input[name="email"]'),
                                       f"bench-{user_id[:8]}@example.test", "email")
            await page.get_by_text("Card", exact=True).last.click(force=True, timeout=10000)
            link_save = page.locator('input[name="enableStripePass"]')
            if await link_save.count() and await link_save.is_checked():
                await page.locator('label[for="enableStripePass"]').click(timeout=10000)
                await expect(link_save).not_to_be_checked(timeout=5000)
            await _fill_checkout_field(page, ('input[autocomplete="cc-number"]', 'input[name="cardNumber"]',
                                              'input[name="number"]', 'input[placeholder*="1234"]'),
                                       "4242424242424242", "card number")
            await _fill_checkout_field(page, ('input[autocomplete="cc-exp"]', 'input[name="cardExpiry"]',
                                              'input[name="expiry"]', 'input[placeholder*="MM"]'),
                                       "1234", "expiry")
            await _fill_checkout_field(page, ('input[autocomplete="cc-csc"]', 'input[name="cardCvc"]',
                                              'input[name="cvc"]', 'input[placeholder*="CVC"]'),
                                       "123", "CVC")
            await _fill_checkout_field(page, ('input[name="billingName"]', 'input[autocomplete="cc-name"]'),
                                       "Benchmark User", "billing name")
            await _fill_checkout_field(page, ('input[name="billingPostalCode"]', 'input[autocomplete="postal-code"]'),
                                       "94105", "ZIP")
            submit = page.locator('button[type="submit"]').last
            if not await submit.count():
                raise RuntimeError("Stripe Checkout submit button was not available")
            await submit.click(timeout=30000)
            completed = None
            for _ in range(45):
                await asyncio.sleep(2)
                completed = await _stripe_session(session_id, stripe_key)
                if (completed.get("status") == "complete" and completed.get("payment_status") == "paid"
                        and completed.get("subscription") and completed.get("customer")):
                    break
            if (not completed or completed.get("status") != "complete" or completed.get("payment_status") != "paid"
                    or not completed.get("subscription") or not completed.get("customer")):
                raise RuntimeError("Stripe Checkout did not finish a paid subscription after submitting the test card")
        finally:
            await browser.close()

    if (completed.get("payment_status") != "paid" or completed.get("livemode") is not False
            or completed.get("client_reference_id") != user_id
            or not completed.get("subscription") or not completed.get("customer")):
        raise RuntimeError("Completed Stripe Checkout lacks a paid test subscription for the user")

    payload = json.dumps({
        "id": f"evt_bench_checkout_{session_id}",
        "type": "checkout.session.completed",
        "data": {"object": completed},
    }, separators=(",", ":"))
    timestamp = int(time.time())
    digest = hmac.new(webhook_secret.encode(), f"{timestamp}.{payload}".encode(), hashlib.sha256).hexdigest()
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            f"{base_url}/webhooks/stripe",
            headers={"Content-Type": "application/json", "stripe-signature": f"t={timestamp},v1={digest}"},
            content=payload.encode(),
        )
        response.raise_for_status()
    return {
        "session_id": session_id,
        "status": completed["status"],
        "payment_status": completed["payment_status"],
        "subscription_id": completed["subscription"],
        "customer_id": completed["customer"],
        "webhook_delivered": True,
    }
