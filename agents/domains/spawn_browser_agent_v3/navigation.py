"""User history navigation through the worker's existing (including Tilion) CDP client."""
from __future__ import annotations

import asyncio
import time
from typing import Any

from .repo import get_http_client


async def consume_navigation(config: Any, task_id: str, session_id: str, dom_service: Any) -> None:
    client = get_http_client()
    base = f"{config.backend.api_url}/api/browser-session/task/{task_id}/navigation"
    headers = {"x-api-key": config.backend.api_key or ""}
    response = await client.post(base + "/claim", json={"sessionId": session_id}, headers=headers, timeout=5.0)
    response.raise_for_status()
    command = response.json().get("command")
    if not command:
        return
    # A replacement worker must never execute a predecessor's command.
    if command.get("sessionId") != session_id:
        raise RuntimeError("Navigation command does not belong to this browser session")
    remaining = command["deadline"] / 1000 - time.time()
    if remaining <= 0:
        return
    result: dict[str, Any] = {"sessionId": session_id, "id": command["id"], "url": None}
    try:
        result["url"] = await asyncio.wait_for(execute_navigation(dom_service, command["action"]), remaining)
    except Exception as exc:
        result["error"] = type(exc).__name__
    response = await client.post(base + "/complete", json=result, headers=headers, timeout=5.0)
    response.raise_for_status()


async def execute_navigation(dom_service: Any, action: str) -> str | None:
    """Navigate Chrome history entries, including same-document entries, without URL guessing."""
    async def send(method: str, params: dict | None = None):
        # Renderer swaps invalidate target sessions; resolve from the existing
        # browser-use client's event-driven session pool for every observation.
        for attempt in range(20):
            try:
                _, session = await dom_service._live_cdp_session()
                if session is None:
                    raise RuntimeError("Browser has no active target")
                return await dom_service._send_cdp_command(session, method, params)
            except Exception as exc:
                # Retry observations only: never dispatch a navigation twice.
                if method not in {"Page.getNavigationHistory", "Runtime.evaluate"} or attempt == 19 or not any(
                    text in str(exc).lower() for text in ("context", "detached", "not attached", "session")
                ):
                    raise
                await asyncio.sleep(0.05)

    if action in {"back", "forward"}:
        history = await send("Page.getNavigationHistory")
        index = history["currentIndex"] + (-1 if action == "back" else 1)
        if 0 <= index < len(history["entries"]):
            await send("Page.navigateToHistoryEntry", {"entryId": history["entries"][index]["id"]})
            while True:
                current = await send("Page.getNavigationHistory")
                if current["currentIndex"] == index:
                    break
                await asyncio.sleep(0.05)
    elif action == "reload":
        await send("Page.reload")
    else:
        raise ValueError("Invalid navigation action")
    # A reload can destroy the execution context while the command is in flight.
    for attempt in range(20):
        try:
            result = await send("Runtime.evaluate", {"expression": "window.location.href", "returnByValue": True})
            if result.get("exceptionDetails"):
                raise RuntimeError("Unable to read browser URL after navigation")
            url = result.get("result", {}).get("value")
            current = await send("Page.getNavigationHistory")
            current_url = current["entries"][current["currentIndex"]]["url"]
            if url != current_url:
                # History can commit before the execution context swaps. Never
                # return the predecessor document's URL as a successful result.
                await asyncio.sleep(0.05)
                continue
            return url
        except Exception as exc:
            if attempt == 19 or not any(text in str(exc).lower() for text in
                    ("context", "detached", "not attached", "session")):
                raise
            await asyncio.sleep(0.05)
    raise RuntimeError("Browser URL did not settle after navigation")
