"""Direct, bounded HTTP access to Lantern's read-only people operations."""

from __future__ import annotations

import json
from contextlib import suppress
from typing import Any
from urllib.parse import urlsplit

from temporalio.exceptions import ApplicationError

from helpers.http_client import get_http_client
from tools.people_search.config import AUTH_HTTP_TIMEOUT, HTTP_TIMEOUT


def lantern_error(code: str, details: Any = None) -> ApplicationError:
    message = f"Lantern People: {code}"
    if details:
        message += "\nRecovery details: " + json.dumps(details, ensure_ascii=False)
    return ApplicationError(
        message,
        details if details is not None else {},
        type="LanternPeopleError",
        non_retryable=True,
    )


def validate_api_origin(api_url: str) -> str:
    """Match the official client's HTTPS/loopback origin rules before sending auth."""
    try:
        parsed = urlsplit(api_url)
        valid_transport = parsed.scheme == "https" or (
            parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1")
        )
        valid = (
            valid_transport
            and parsed.hostname
            and not parsed.username
            and not parsed.password
            and parsed.path in ("", "/")
            and not parsed.query
            and not parsed.fragment
        )
        if not valid:
            raise lantern_error("INVALID_API_ORIGIN")
        return f"{parsed.scheme}://{parsed.netloc}"
    except ValueError as error:
        raise lantern_error("INVALID_API_ORIGIN") from error


async def fetch_lantern_people(
    *, api_url: str, api_token: str, operation: str, payload: dict[str, Any]
) -> dict[str, Any]:
    origin = validate_api_origin(api_url)
    if not api_token:
        raise lantern_error("MISSING_TOKEN", {"hint": "Configure PEOPLE_API_TOKEN for the worker's Lantern workspace."})
    if operation not in ("find_people", "people_profiles_get"):
        raise lantern_error("UNSUPPORTED_OPERATION")
    response = await get_http_client().post(
        f"{origin}/v1/operations/{operation}",
        headers={"Authorization": f"Bearer {api_token}", "Content-Type": "application/json"},
        json=payload,
        timeout=HTTP_TIMEOUT,
        follow_redirects=False,
    )
    try:
        body = response.json()
    except ValueError as error:
        raise lantern_error("INVALID_RESPONSE", {"http_status": response.status_code}) from error
    if not isinstance(body, dict) or not isinstance(body.get("ok"), bool):
        raise lantern_error("INVALID_RESPONSE", {"http_status": response.status_code})
    if body["ok"] is False:
        failure = body.get("error")
        if not isinstance(failure, dict) or not isinstance(failure.get("code"), str):
            raise lantern_error("INVALID_RESPONSE", {"http_status": response.status_code})
        details = failure.get("details") or {}
        retry_after = response.headers.get("retry-after")
        if isinstance(details, dict) and retry_after:
            with suppress(ValueError, TypeError):
                details = {**details, "retryAfterSeconds": max(float(retry_after), details.get("retryAfterSeconds", 0))}
        raise lantern_error(failure["code"], details)
    if not response.is_success or not isinstance(body.get("data"), dict):
        raise lantern_error("INVALID_RESPONSE", {"http_status": response.status_code})
    return body["data"]


async def fetch_lantern_connection(
    *, backend_url: str, backend_api_key: str | None, user_id: str | None, expected_origin: str
) -> tuple[str, str]:
    """Read this user's refreshable connection from Rose's protected token endpoint."""
    if not user_id or not backend_api_key:
        raise lantern_error("LANTERN_CONNECTION_REQUIRED", {"hint": "Connect Lantern for this Rose user."})
    response = await get_http_client().get(
        backend_url.rstrip("/") + "/api/integrations/lantern-people/credentials/token",
        headers={"X-API-Key": backend_api_key, "X-User-Id": user_id},
        timeout=AUTH_HTTP_TIMEOUT,
        follow_redirects=False,
    )
    try:
        body = response.json()
    except ValueError as error:
        raise lantern_error("INVALID_CREDENTIAL_RESPONSE") from error
    if not isinstance(body, dict):
        raise lantern_error("INVALID_CREDENTIAL_RESPONSE")
    if not response.is_success:
        code = body.get("code") if isinstance(body.get("code"), str) else "LANTERN_CONNECTION_REQUIRED"
        details = body.get("details") if isinstance(body.get("details"), dict) else {}
        hint = (
            "Wait for the indicated delay before trying this connection again."
            if response.status_code in (429, 503)
            else "Connect or reconnect Lantern for this Rose user."
        )
        raise lantern_error(code, {**details, "hint": hint})
    token = body.get("accessToken")
    origin = body.get("apiUrl")
    if not isinstance(token, str) or not token or len(token) > 4096 or not isinstance(origin, str):
        raise lantern_error("INVALID_CREDENTIAL_RESPONSE")
    validated = validate_api_origin(origin)
    if validated != validate_api_origin(expected_origin):
        raise lantern_error("CREDENTIAL_ORIGIN_MISMATCH")
    return validated, token
