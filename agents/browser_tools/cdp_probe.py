"""Read-only, request-owned CDP probes on an already attached native client.

No sessions are attached or detached here. Expiry removes only this request's
future; cdp-use ignores an eventual response whose ID is no longer pending.
"""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any, Callable, Optional


class ProbeBindingUnavailable(RuntimeError):
    pass


class ProbeReadTimeout(asyncio.TimeoutError):
    def __init__(self, sent: bool):
        super().__init__("CDP probe deadline")
        self.sent = sent


@dataclass(frozen=True)
class OwnedCdpProbe:
    client: Any
    is_current: Callable[[], bool]
    renderer_session_id: Optional[str] = None
    renderer_is_current: Optional[Callable[[], bool]] = None

    async def read(self, kind: str, timeout_s: float) -> dict[str, Any]:
        if kind not in {"renderer", "browser"}:
            raise ValueError("Unsupported CDP probe")
        renderer = kind == "renderer"
        if not self.is_current() or (renderer and (
            not self.renderer_session_id or self.renderer_is_current is None
            or not self.renderer_is_current()
        )):
            raise ProbeBindingUnavailable("CDP probe identity unavailable")
        client = self.client
        socket = getattr(client, "ws", None)
        pending = getattr(client, "pending_requests", None)
        previous_id = getattr(client, "msg_id", None)
        if socket is None or type(pending) is not dict or type(previous_id) is not int:
            raise ProbeBindingUnavailable("CDP request owner unavailable")
        request_id = previous_id + 1
        if request_id in pending or not 0 < request_id < 2**53:
            raise ProbeBindingUnavailable("CDP request ID unavailable")
        # Allocation and registration happen without yielding, like CDPClient.send_raw.
        client.msg_id = request_id
        future = asyncio.get_running_loop().create_future()
        pending[request_id] = future
        request: dict[str, Any] = {
            "id": request_id,
            "method": "Runtime.evaluate" if renderer else "Browser.getVersion",
            "params": {"expression": "1+1", "returnByValue": True} if renderer else {},
        }
        if renderer:
            request["sessionId"] = self.renderer_session_id
        sent = False
        try:
            async with asyncio.timeout(timeout_s):
                await socket.send(json.dumps(request))
                sent = True
                result = await future
            if (not self.is_current() or getattr(client, "ws", None) is not socket
                    or getattr(client, "pending_requests", None) is not pending
                    or (renderer and not self.renderer_is_current())):
                raise ProbeBindingUnavailable("CDP probe identity changed")
            if not isinstance(result, dict):
                raise ProbeBindingUnavailable("CDP probe response unavailable")
            if renderer and (result.get("exceptionDetails") or
                             (result.get("result") or {}).get("value") != 2):
                raise ProbeBindingUnavailable("CDP renderer probe response invalid")
            return result
        except asyncio.TimeoutError as error:
            if (not self.is_current() or getattr(client, "ws", None) is not socket
                    or getattr(client, "pending_requests", None) is not pending
                    or (renderer and not self.renderer_is_current())):
                raise ProbeBindingUnavailable("CDP probe identity changed") from error
            raise ProbeReadTimeout(sent) from error
        finally:
            if pending.get(request_id) is future:
                pending.pop(request_id)
            if not future.done():
                future.cancel()


def bind_native_cdp_probe(dom_service: Any, page: Any, focus_cache: Any, playwright_browser: Any) -> Optional[OwnedCdpProbe]:
    """Bind existing BrowserSession and target membership without native I/O."""
    try:
        target_id = focus_cache.target_ids.get(page)
    except (AttributeError, TypeError):
        target_id = None
    session = getattr(dom_service, "session", None)
    client = getattr(session, "_cdp_client_root", None)
    if client is None:
        return None
    manager = getattr(session, "session_manager", None)
    bound_socket = getattr(client, "ws", None)
    bound_pending = getattr(client, "pending_requests", None)

    def current() -> bool:
        return (getattr(dom_service, "session", None) is session
                and getattr(session, "_cdp_client_root", None) is client
                and bound_socket is not None
                and getattr(client, "ws", None) is bound_socket
                and getattr(client, "pending_requests", None) is bound_pending)

    ids = getattr(manager, "_target_sessions", {}).get(target_id, ())
    sessions = getattr(manager, "_sessions", {})
    attached = next((sessions.get(sid) for sid in ids
                     if getattr(sessions.get(sid), "target_id", None) == target_id
                     and getattr(sessions.get(sid), "cdp_client", None) is client), None)
    sid = getattr(attached, "session_id", None)
    target = getattr(manager, "_targets", {}).get(target_id)
    contexts = getattr(playwright_browser, "contexts", ()) or ()
    context = contexts[0] if contexts else None

    def renderer_current() -> bool:
        return (current() and isinstance(target_id, str) and bool(target_id)
                and getattr(session, "agent_focus_target_id", None) == target_id
                and getattr(session, "session_manager", None) is manager
                and getattr(manager, "_sessions", {}).get(sid) is attached
                and sid in getattr(manager, "_target_sessions", {}).get(target_id, ())
                and getattr(attached, "target_id", None) == target_id
                and getattr(attached, "session_id", None) == sid
                and focus_cache.target_ids.get(page) == target_id
                and getattr(attached, "cdp_client", None) is client
                and getattr(manager, "_targets", {}).get(target_id) is target
                and getattr(target, "target_id", None) == target_id
                and getattr(target, "target_type", None) in {"page", "tab"}
                and callable(getattr(playwright_browser, "is_connected", None))
                and playwright_browser.is_connected() is True
                and bool(getattr(playwright_browser, "contexts", ()))
                and playwright_browser.contexts[0] is context
                and any(member is page for member in (getattr(context, "pages", ()) or ()))
                and callable(getattr(page, "is_closed", None)) and page.is_closed() is False)

    return OwnedCdpProbe(client, current, sid, renderer_current)
