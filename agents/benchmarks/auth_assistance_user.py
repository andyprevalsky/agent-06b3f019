"""Plays the user for a sign-in-help request during a hosted-auth benchmark.

    auth_assistance request
        ├─ sign_in ─► attach to the agent's still-live browser over CDP ─► type the
        │             user's own email + password into the sign-in form the agent left
        │             open ─► POST /api/auth-assistance/:id/complete (the live view's
        │             "Done" button)
        └─ decline ─► POST /api/attention-requests/:id/reject

The password typed here is the one only the user knows; the fixture never offers
it to the agent, so a session under it proves the user (not the agent) signed in.
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


def _browser_task_id(request: dict) -> Optional[str]:
    metadata = request.get("metadata") if isinstance(request.get("metadata"), dict) else {}
    for block_name in ("requestUserAuthentication", "authAssistance"):
        block = metadata.get(block_name)
        if not isinstance(block, dict):
            continue
        for key in ("taskId", "task_id", "subAgentId", "sub_agent_id"):
            value = block.get(key)
            if isinstance(value, str) and value:
                return value
    for key in ("taskId", "task_id", "subAgentId", "sub_agent_id"):
        value = metadata.get(key)
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
        raise AuthAssistanceUserError(
            f"browser session lookup failed {response.status_code}: {response.text[:200]}"
        )
    info = response.json()
    if info.get("same_session_available") is not True:
        raise AuthAssistanceUserError(
            "the agent's browser was not left running for the user: "
            f"{info.get('same_session_unavailable_reason')}"
        )
    ws_url = info.get("ws_url")
    if not isinstance(ws_url, str) or not ws_url:
        raise AuthAssistanceUserError("the live browser session exposed no CDP URL")
    return steel_cdp_connection_url(ws_url)


async def _type_credentials(cdp_url: str, email: str, password: str) -> str:
    """Sign in through the form the agent left open. Returns the URL the browser landed on."""
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
        try:
            await password_input.wait_for(state="visible", timeout=SIGN_IN_FORM_TIMEOUT_MS)
        except Exception as exc:
            raise AuthAssistanceUserError(
                f"the agent did not leave a sign-in form open for the user (page: {page.url})"
            ) from exc
        email_input = page.locator("input[type=email]").first
        if await email_input.count() and await email_input.is_visible():
            await email_input.fill(email)
        await password_input.fill(password)
        await password_input.press("Enter")
        await page.wait_for_load_state("domcontentloaded")
        await asyncio.sleep(1)
        return page.url


async def sign_in_as_user(base_url: str, headers: dict, request: dict, credentials: dict) -> str:
    request_id = str(request.get("id") or "")
    task_id = _browser_task_id(request)
    if not request_id or not task_id:
        raise AuthAssistanceUserError("sign-in-help request is missing its id or browser task id")
    cdp_url = await _live_cdp_url(base_url, headers, task_id)
    landed = await _type_credentials(cdp_url, str(credentials["email"]), str(credentials["password"]))
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(
            f"{base_url.rstrip('/')}/api/auth-assistance/{request_id}/complete", headers=headers, json={}
        )
    if response.status_code != 200:
        raise AuthAssistanceUserError(
            f"completing the sign-in-help request failed {response.status_code}: {response.text[:200]}"
        )
    return landed


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
