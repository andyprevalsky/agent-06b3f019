"""Cloud-only Rose phone boundary. No provider grants or process-local ownership.

Guidance adapted from Phone Harness 0.3.2; authorization is always server owned.
"""

import asyncio
import contextlib
import hashlib
import json
from typing import Any
from urllib.parse import quote

import httpx

PHONE_GUIDANCE = """Cloud iPhone skill (Phone Harness 0.3.2, Rose adaptation):
Use phone for authorized tasks where the account's dedicated cloud iPhone helps,
including authentication, OTPs, messages, and apps. Use mode=status to inspect
ownership/last receipt without allocating, mode=operation to ensure/reuse the
phone, and mode=release when finished. Observe with screen.text, act once, then
verify. iPhone coordinates are screen points; focus a field before input.text.
Use only supported cloud operations; no CLI, local bridge, Android, or shell.
In mode=operation, set operation to the wire name and args to its arguments:
- screen.text: {"min_confidence": 0.3} returns visible text and tap centers.
- screen.bounds: {} returns the coordinate space for this phone.
- apps.launch: {"name": "Settings", "fresh": false} opens an app; verify
  the foreground screen afterward, because a launch can silently miss.
- apps.list: {"include_system": true} lists installed app identifiers.
- input.tap: {"x": 100, "y": 200}; use centers from the latest screen.text.
- input.press: {"x": 100, "y": 200, "duration": 0.8} holds a point.
- input.drag: {"x1": 100, "y1": 400, "x2": 100, "y2": 200,
  "duration": 0.5, "steps": 10} moves a finger between screen points.
- input.scroll: {"x": 100, "y": 200, "dy": 200, "dx": 0, "steps": 10}
  uses content-space deltas. Observe the changed screen after scrolling.
- input.text: {"s": "text", "delay": 0.03, "keystrokes": false} types
  into the focused field; tap the field first and verify afterward.
- input.keys: {"combo": "enter"}; nav.home: {} presses the Home button.
The live host decides which operations are supported. An unsupported response
is a capability limit; do not repeat it or assume back/current-app/tree exists.
Queue/lease timeout is a tool outcome, not a request for user attention. Pending
or UNKNOWN input must never be blindly retried: inspect the durable receipt and
screen, and wait for confirmed cleanup when necessary. Private password refs
require verified phone app/account binding, which is not available yet.
"""


def phone_actions(actions: list[str], capability: dict) -> list[str]:
    return [name for name in actions if name != "phone" or capability.get("enabled") is True]


def _identity(*parts: Any) -> str:
    data = json.dumps(parts, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(data.encode()).hexdigest()


async def _request(client, config, user_id, method, path, payload=None):
    response = await client.request(
        method,
        f"{config.backend.api_url.rstrip('/')}/api/iphone/{path}",
        headers={"X-API-Key": config.backend.api_key or "", "X-User-Id": user_id},
        json=payload,
        timeout=105.0 if path.endswith("/operations") else 10.0,
    )
    if not response.is_success:
        # Never include response text, URL, headers, input, or exception strings.
        return {"_httpStatus": response.status_code}
    data = response.json()
    return data if isinstance(data, dict) else {"_httpStatus": 502}


async def fetch_phone_capability(config, user_id: str, *, client=None) -> dict:
    if client is None:
        async with httpx.AsyncClient() as owned:
            return await fetch_phone_capability(config, user_id, client=owned)
    try:
        data = await _request(client, config, user_id, "GET", "capability")
        return {
            "enabled": data.get("enabled") is True,
            "configured": data.get("configured") is True,
            "setupState": data.get("setupState") if isinstance(data.get("setupState"), str) else None,
        }
    except Exception:
        return {"enabled": False, "configured": False, "setupState": None}


async def observe_phone(config, user_id: str, task_id: str, *, client=None) -> dict:
    """A fresh owned observation before each decision; never use cached entitlement."""
    if client is None:
        async with httpx.AsyncClient() as owned:
            return await observe_phone(config, user_id, task_id, client=owned)
    capability = await fetch_phone_capability(config, user_id, client=client)
    if not capability["enabled"] or not task_id:
        return {"enabled": False}
    try:
        view = await _request(client, config, user_id, "GET", f"interactions/{quote(task_id, safe='')}")
        if "_httpStatus" in view:
            return {"enabled": False}
        # Renew only an already active claim, never allocate from observation.
        lease = view.get("lease") or {}
        if lease.get("status") == "ACTIVE":
            renewal = await _request(
                client, config, user_id, "POST", f"leases/{quote(lease['id'], safe='')}/heartbeat", {}
            )
            if renewal.get("_httpStatus") == 403:
                return {"enabled": False}
        return {"enabled": True, "interaction": view}
    except Exception:
        return {"enabled": False}


async def execute_phone(
    params: dict,
    *,
    config,
    user_id: str,
    agent_id: str,
    task_id: str,
    decision_id: str,
    snapshot: dict | None,
    client=None,
) -> dict:
    """Use the decision's cursor, not a newly fetched cursor, for the CAS fence."""
    if client is None:
        async with httpx.AsyncClient() as owned:
            return await execute_phone(
                params,
                config=config,
                user_id=user_id,
                agent_id=agent_id,
                task_id=task_id,
                decision_id=decision_id,
                snapshot=snapshot,
                client=owned,
            )
    if not all((user_id, agent_id, task_id)) or not (snapshot or {}).get("enabled"):
        return {"success": False, "error": "Phone unavailable for this decision"}
    if not (await fetch_phone_capability(config, user_id, client=client))["enabled"]:
        return {"success": False, "error": "Phone capability unavailable or revoked"}
    from browser_tools.schemas import validate_browser_tool_args

    try:
        params = validate_browser_tool_args("phone", params)
    except ValueError:
        return {"success": False, "error": "Invalid phone arguments"}
    view = (snapshot or {}).get("interaction") or {}
    path = f"interactions/{quote(task_id, safe='')}"
    operation_id = None
    lease_id = None
    try:
        if params["mode"] == "status":
            current = await _request(client, config, user_id, "GET", path)
            return {"success": "_httpStatus" not in current, "phone": current}
        if params["mode"] == "release":
            lease = view.get("lease") or {}
            if not lease.get("id"):
                return {"success": True, "phone": view}
            result = await _request(
                client, config, user_id, "POST", f"leases/{quote(lease['id'], safe='')}/release", {}
            )
            return {"success": "_httpStatus" not in result, "phone": result}
        cursor = view.get("cursor", 0)
        if not isinstance(cursor, int) or isinstance(cursor, bool) or cursor < 0:
            return {"success": False, "error": "Phone observation cursor invalid"}
        # Public identities contain only trusted routing/decision identity, never
        # command args (low-entropy secrets must not be dictionary-guessable).
        # The fallback is deterministic for the observed cursor, never
        # an activity attempt or a new random UUID on HTTP retry.
        intent = decision_id or _identity("cursor", task_id, cursor)
        acquired = await _request(
            client,
            config,
            user_id,
            "POST",
            path,
            {"requestKey": _identity("acquire", task_id, (view.get("lease") or {}).get("id"), intent)},
        )
        lease = acquired.get("lease") or {}
        lease_id = lease.get("id")
        if lease.get("status") != "ACTIVE" or not lease_id:
            return {"success": False, "phone": acquired, "error": "Phone lease is not active"}
        # A newly allocated lease starts at its own cursor. Reuse must keep the
        # decision's observed cursor to reject a concurrently superseded action.
        observed_lease = view.get("lease") or {}
        if observed_lease.get("id") != lease_id:
            if observed_lease.get("status") in ("ACTIVE", "WAITING"):
                return {"success": False, "error": "Phone lease changed; observe again"}
            cursor = 0
        operation_id = _identity("operation", task_id, lease_id, intent)
        result = await with_phone_heartbeat(
            _request(
                client,
                config,
                user_id,
                "POST",
                f"leases/{quote(lease_id, safe='')}/operations",
                {
                    "operationId": operation_id,
                    "operation": params["operation"],
                    "args": params.get("args", {}),
                    "expectedCursor": cursor,
                },
            ),
            config,
            user_id,
            {"enabled": True, "interaction": {"lease": lease}},
            client=client,
        )
        if result.get("_httpStatus", 0) >= 500:
            raise RuntimeError("Unconfirmed phone submission")
        return {
            "success": "_httpStatus" not in result and (result.get("operation") or {}).get("status") == "SUCCEEDED",
            **result,
        }
    except Exception:
        # Submission can have executed. Observe the SAME receipt, never replay.
        if lease_id and operation_id:
            try:
                receipt = await _request(
                    client,
                    config,
                    user_id,
                    "GET",
                    f"leases/{quote(lease_id, safe='')}/operations/{quote(operation_id, safe='')}",
                )
                if "_httpStatus" not in receipt:
                    return {"success": (receipt.get("operation") or {}).get("status") == "SUCCEEDED", **receipt}
            except Exception:
                pass
        return {"success": False, "status": "UNKNOWN", "error": "Phone outcome unconfirmed; observe before acting"}


async def retain_phone_for_auth(config, user_id: str, task_id: str, request_id: str) -> None:
    """Backend validates the pending attention's exact agent/account ownership."""
    async with httpx.AsyncClient() as client:
        state = await observe_phone(config, user_id, task_id, client=client)
        lease = (state.get("interaction") or {}).get("lease") or {}
        if lease.get("status") == "ACTIVE":
            try:
                await _request(
                    client,
                    config,
                    user_id,
                    "POST",
                    f"leases/{quote(lease['id'], safe='')}/awaiting-auth",
                    {"attentionRequestId": request_id},
                )
            except Exception:
                pass


async def with_phone_heartbeat(work, config, user_id: str, snapshot: dict, *, client=None):
    """Bounded keepalive owned/cancelled by the existing model/action lifecycle.

    No autonomous queue polling, allocation, or global ownership map. Pending
    authentication reservations survive activity shutdown in the backend.
    """
    lease = (snapshot.get("interaction") or {}).get("lease") or {}
    if not snapshot.get("enabled") or lease.get("status") != "ACTIVE":
        return await work

    async def renew():
        for _ in range(8):  # bounded to four minutes; caller has its own deadline
            await asyncio.sleep(30)
            try:
                if client is None:
                    async with httpx.AsyncClient() as owned:
                        result = await _request(
                            owned, config, user_id, "POST", f"leases/{quote(lease['id'], safe='')}/heartbeat", {}
                        )
                else:
                    result = await _request(
                        client, config, user_id, "POST", f"leases/{quote(lease['id'], safe='')}/heartbeat", {}
                    )
                if "_httpStatus" in result:
                    return
            except Exception:
                return

    keepalive = asyncio.create_task(renew())
    try:
        return await work
    finally:
        keepalive.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await keepalive
