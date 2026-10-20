"""Plays the user for a sign-in-help request during a hosted-auth benchmark.

    auth_assistance request
        ├─ sign_in ─► attach to the agent's still-live browser over CDP ─► type the
        │             user's own email + password into the sign-in form the agent left
        │             open ─► POST /api/auth-assistance/:id/complete (the live view's
        │             "Done" button)
        ├─ approve_app ─► approve in a separate device browser ─► check the
        │                 agent's original browser is still live ─► complete
        └─ decline ─► POST /api/attention-requests/:id/reject

For sign_in, the password typed here is the one only the user knows. For
approve_app, the agent enters its saved password and this helper only acts on
the user's device; it never attaches to or changes the agent's login page.
"""

from __future__ import annotations

import asyncio
import time
from typing import Optional

import httpx

from domains.spawn_browser_agent_v3.cdp_urls import steel_cdp_connection_url

SIGN_IN_FORM_TIMEOUT_MS = 20_000
PAGE_WAIT_SECONDS = 20


class AuthAssistanceUserError(RuntimeError):
    """The stand-in user could not do what a real user would have done."""


_TASK_ID_KEYS = ("taskId", "task_id", "subAgentId", "sub_agent_id")


def browser_task_id(request: dict, messages: list[dict]) -> Optional[str]:
    """The browser task that raised the request.

    The request itself only names the browser session. The task id rides on the
    "Requesting User Assistance" message the agent posts for the same request,
    which can land a moment after the request does.
    """
    request_id = str(request.get("id") or "")
    for message in reversed(messages):
        metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
        block = metadata.get("requestUserAuthentication")
        if not isinstance(block, dict) or str(block.get("requestId") or "") != request_id:
            continue
        for key in _TASK_ID_KEYS:
            value = block.get(key) or metadata.get(key)
            if isinstance(value, str) and value:
                return value
    return None


async def _live_cdp_url(base_url: str, headers: dict, task_id: str) -> str:
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(
            f"{base_url.rstrip('/')}/api/browser-session/task/{task_id}",
            headers=headers,
            params={"validateLive": "true"},
        )
    if response.status_code != 200:
        raise AuthAssistanceUserError(f"browser session lookup failed {response.status_code}: {response.text[:200]}")
    info = response.json()
    if info.get("same_session_available") is not True:
        raise AuthAssistanceUserError(
            f"the agent's browser was not left running for the user: {info.get('same_session_unavailable_reason')}"
        )
    ws_url = info.get("ws_url")
    if not isinstance(ws_url, str) or not ws_url:
        raise AuthAssistanceUserError("the live browser session exposed no CDP URL")
    return steel_cdp_connection_url(ws_url)


async def _type_credentials(cdp_url: str, email: str, password: str, sign_in_url: Optional[str] = None) -> str:
    """Sign in as the user would. Returns the URL the browser landed on.

    The agent may leave the password form or a code-entry page open (the ladder
    allows either). A user who knows their password and sees a code page goes
    to the site's sign-in page themself.
    """
    from playwright.async_api import async_playwright

    async with async_playwright() as playwright:
        browser = await playwright.chromium.connect_over_cdp(cdp_url)
        deadline = time.monotonic() + PAGE_WAIT_SECONDS
        page = None
        while time.monotonic() < deadline and page is None:
            pages = [p for context in browser.contexts for p in context.pages]
            open_pages = [p for p in pages if p.url and p.url != "about:blank"]
            page = (open_pages or pages or [None])[-1]
            if page is None:
                await asyncio.sleep(0.25)
        if page is None:
            raise AuthAssistanceUserError("the live browser had no open page")
        password_input = page.locator("input[type=password]").first
        left_open = page.url
        try:
            await password_input.wait_for(state="visible", timeout=SIGN_IN_FORM_TIMEOUT_MS)
        except Exception as exc:
            if not sign_in_url:
                raise AuthAssistanceUserError(
                    f"the agent did not leave a sign-in form open for the user (page: {left_open})"
                ) from exc
            await page.goto(sign_in_url, wait_until="domcontentloaded")
            try:
                await password_input.wait_for(state="visible", timeout=SIGN_IN_FORM_TIMEOUT_MS)
            except Exception as retry_exc:
                raise AuthAssistanceUserError(
                    f"no password form on the page the agent left open ({left_open}) or on {sign_in_url}"
                ) from retry_exc
        email_input = page.locator("input[type=email]").first
        if await email_input.count() and await email_input.is_visible():
            await email_input.fill(email)
        await password_input.fill(password)
        await password_input.press("Enter")
        await page.wait_for_load_state("domcontentloaded")
        await asyncio.sleep(1)
        return page.url


async def sign_in_as_user(
    base_url: str,
    headers: dict,
    request: dict,
    task_id: str,
    credentials: dict,
    sign_in_url: Optional[str] = None,
) -> str:
    request_id = str(request.get("id") or "")
    if not request_id or not task_id:
        raise AuthAssistanceUserError("sign-in-help request is missing its id or browser task id")
    cdp_url = await _live_cdp_url(base_url, headers, task_id)
    landed = await _type_credentials(cdp_url, str(credentials["email"]), str(credentials["password"]), sign_in_url)
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(
            f"{base_url.rstrip('/')}/api/auth-assistance/{request_id}/complete", headers=headers, json={}
        )
    if response.status_code != 200:
        raise AuthAssistanceUserError(
            f"completing the sign-in-help request failed {response.status_code}: {response.text[:200]}"
        )
    return landed


async def _approve_on_device(device_url: str, expected_number: Optional[str]) -> None:
    """A separate browser represents the user's phone/app, with no login cookies."""
    from playwright.async_api import async_playwright

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        try:
            context = await browser.new_context()
            page = await context.new_page()
            response = await page.goto(device_url, wait_until="domcontentloaded", timeout=SIGN_IN_FORM_TIMEOUT_MS)
            if response is None or not response.ok:
                status = response.status if response is not None else "no response"
                raise AuthAssistanceUserError(f"the approval app did not open successfully ({status})")
            if expected_number is not None:
                await page.get_by_label("Sign-in number", exact=True).fill(expected_number)
            await page.get_by_role("button", name="Approve sign-in", exact=True).click()
            await page.locator("[data-app-approval-status='approved']").wait_for(
                state="visible", timeout=SIGN_IN_FORM_TIMEOUT_MS
            )
        except AuthAssistanceUserError:
            raise
        except Exception as exc:
            # Playwright errors can include the secret device URL. Keep it out
            # of benchmark logs, while retaining the exception for diagnosis.
            raise AuthAssistanceUserError("the approval app did not confirm the sign-in acknowledgment") from exc
        finally:
            await browser.close()


async def approve_app_as_user(
    base_url: str,
    headers: dict,
    request: dict,
    task_id: str,
    app_approval: dict,
) -> None:
    """Approve the challenge on the user's device before resuming the same browser."""
    request_id = str(request.get("id") or "")
    if not request_id or not task_id:
        raise AuthAssistanceUserError("app-approval request is missing its id or browser task id")
    device_url = app_approval.get("deviceUrl")
    if not isinstance(device_url, str) or not device_url:
        raise AuthAssistanceUserError("the site manifest carries no approval app URL")
    expected_number = app_approval.get("expectedNumber")
    if expected_number is not None:
        expected_number = str(expected_number)
        if len(expected_number) != 2 or not expected_number.isascii() or not expected_number.isdigit():
            raise AuthAssistanceUserError("the approval app number must be two digits")

    original_cdp_url = await _live_cdp_url(base_url, headers, task_id)
    await _approve_on_device(device_url, expected_number)
    if await _live_cdp_url(base_url, headers, task_id) != original_cdp_url:
        raise AuthAssistanceUserError("the browser session changed while the user approved in the app")
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(
            f"{base_url.rstrip('/')}/api/auth-assistance/{request_id}/complete", headers=headers, json={}
        )
    if response.status_code != 200:
        raise AuthAssistanceUserError(f"completing the app-approval request failed {response.status_code}")


async def decline(base_url: str, headers: dict, request: dict) -> None:
    request_id = str(request.get("id") or "")
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            f"{base_url.rstrip('/')}/api/attention-requests/{request_id}/reject", headers=headers, json={}
        )
    if response.status_code != 200:
        raise AuthAssistanceUserError(
            f"declining the sign-in-help request failed {response.status_code}: {response.text[:200]}"
        )
