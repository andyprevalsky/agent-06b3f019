"""Lantern people search and source-profile normalization."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

import structlog
from temporalio import activity

from config import load_config
from tools.people_search.config import (
    DISCOVER_DEFAULT_LIMIT,
    DISCOVER_MAX_LIMIT,
    DISCOVER_MIN_LIMIT,
    HTTP_TIMEOUT,
    MODES,
    PROVIDERS,
    SEARCH_SESSION_MIN_LIFETIME_SECONDS,
    SEARCH_SESSION_REFRESH_RESERVE_SECONDS,
)
from tools.people_search.repo import fetch_lantern_connection, fetch_lantern_people, lantern_error, validate_api_origin

if TYPE_CHECKING:
    from tools.people_search.types import PeopleSearchResult, PersonResult

logger = structlog.get_logger()


def _credential_broker_origin(value: str) -> str:
    """Validate the separate credential authority before sending machine auth."""
    try:
        parsed = urlsplit(value)
        if (
            parsed.username is not None
            or parsed.password is not None
            or parsed.path not in ("", "/")
            or "?" in value
            or "#" in value
            or "\\" in value
            or any(character.isspace() or ord(character) < 32 for character in value)
            or parsed.port == 0
            or parsed.netloc.endswith(":")
        ):
            raise lantern_error("INVALID_CREDENTIAL_BROKER_ORIGIN")
    except ValueError:
        raise lantern_error("INVALID_CREDENTIAL_BROKER_ORIGIN") from None
    return validate_api_origin(value)


def clamp_discover_limit(limit: Any) -> int:
    if limit is None:
        return DISCOVER_DEFAULT_LIMIT
    try:
        value = int(limit)
    except (TypeError, ValueError):
        return DISCOVER_DEFAULT_LIMIT
    return max(DISCOVER_MIN_LIMIT, min(DISCOVER_MAX_LIMIT, value))


def _normalize_person(row: dict[str, Any], fields: list[str] | None) -> PersonResult:
    for key in ("reachOut", "person", "profile"):
        if row.get(key) is not None and not isinstance(row[key], dict):
            raise lantern_error("INVALID_RESPONSE")
    reach_out = row.get("reachOut") or {}
    if reach_out.get("person") is not None and not isinstance(reach_out["person"], dict):
        raise lantern_error("INVALID_RESPONSE")
    native = row.get("person") or reach_out.get("person") or row
    profile = row.get("profile") or {}
    for container in (row, native):
        roles_value = container.get("currentRoles")
        if roles_value is not None and (
            not isinstance(roles_value, list) or any(not isinstance(role, dict) for role in roles_value)
        ):
            raise lantern_error("INVALID_RESPONSE")
    roles = row.get("currentRoles") or native.get("currentRoles") or []
    current = roles[0] if roles else {}
    name = row.get("name") or native.get("name")
    url = row.get("linkedinUrl") or native.get("linkedinUrl")
    summary = (
        row.get("summary")
        or native.get("summary")
        or profile.get("summary")
        or row.get("matchReason")
        or row.get("whyMatched")
        or row.get("headline")
    )
    person: PersonResult = {
        "name": name,
        "profile_url": url,
        "title": row.get("title") or native.get("title") or current.get("title"),
        "company": row.get("company") or native.get("company") or current.get("company"),
        "location": row.get("location") or native.get("location"),
        "summary": summary,
        "source": {
            "provider": "lantern",
            "url": url,
            "snippet": summary,
            "record_id": row.get("sourceRecordId") or native.get("sourceRecordId"),
            "retrieved_at": row.get("sourceRetrievedAt") or native.get("sourceRetrievedAt"),
        },
        "confidence": "medium" if name else "low",
        "profile": row,
    }
    if fields:
        derivations = {
            **profile,
            **native,
            **row,
            **person,
            "current_title": person["title"],
            "current_company": person["company"],
            "linkedin_url": url,
            "education": row.get("education") or native.get("education") or profile.get("education"),
            "work_history": row.get("employment") or native.get("employment"),
        }
        person["attributes"] = {field: derivations.get(field) for field in fields}
    return person


def _session_seconds_left(data: dict[str, Any]) -> float | None:
    """Remaining lifetime of the session behind a page's next_cursor, when stated."""
    expires_at = data.get("expiresAt")
    if not isinstance(data.get("nextCursor"), str) or not isinstance(expires_at, str):
        return None
    try:
        expires = datetime.fromisoformat(expires_at)
    except ValueError:
        return None
    return (expires - datetime.now(UTC)).total_seconds() if expires.tzinfo else None


def _build_request(
    query: str,
    mode: str,
    limit: int | None,
    search_options: dict[str, Any] | None,
) -> tuple[str, dict[str, Any]]:
    options = dict(search_options or {})
    source_id = options.pop("sourceRecordId", None)
    generation = options.pop("generation", None)
    if mode == "enrich":
        if not source_id:
            raise lantern_error(
                "PERSON_RESOLUTION_REQUIRED", {"hint": "Discover candidates, then enrich with source_record_id."}
            )
        if options:
            raise lantern_error(
                "INVALID_SEARCH_OPTIONS",
                {"hint": "Exact profile retrieval accepts source_record_id and generation only."},
            )
        operation = "people_profiles_get"
        payload = {"ids": [source_id]}
        if generation:
            payload["generation"] = generation
    else:
        if source_id or generation:
            raise lantern_error("INVALID_SEARCH_OPTIONS")
        operation = "find_people"
        allowed = {"location", "locationKind", "countryCode", "companies", "titles", "cursor"}
        if options.keys() - allowed:
            raise lantern_error("INVALID_SEARCH_OPTIONS")
        payload = {
            "request": query,
            "limit": clamp_discover_limit(limit),
            "includeContacts": False,
            **options,
        }
    return operation, payload


async def execute_people_search(
    query: str,
    mode: str,
    provider: str = "lantern",
    limit: int | None = None,
    fields: list[str] | None = None,
    search_options: dict[str, Any] | None = None,
    user_id: str | None = None,
) -> PeopleSearchResult:
    if mode not in MODES or provider not in PROVIDERS:
        raise lantern_error("INVALID_SEARCH_MODE_OR_PROVIDER")
    activity.heartbeat(f"People search ({mode}/lantern)")
    operation, payload = _build_request(query, mode, limit, search_options)
    source_id = (search_options or {}).get("sourceRecordId")
    app_config = load_config()
    async with asyncio.timeout(HTTP_TIMEOUT) as budget:
        origin = validate_api_origin(app_config.lantern.api_url)
        token = app_config.lantern.api_token
        broker_url = getattr(app_config.lantern, "credential_broker_url", "").strip()
        broker_origin = _credential_broker_origin(broker_url) if broker_url else None
        if broker_origin or not token:
            origin, token = await fetch_lantern_connection(
                backend_url=broker_origin or app_config.backend.api_url,
                backend_api_key=app_config.backend.api_key,
                user_id=user_id,
                expected_origin=origin,
            )
        data = await fetch_lantern_people(api_url=origin, api_token=token, operation=operation, payload=payload)
        seconds_left = _session_seconds_left(data) if "cursor" not in payload else None
        # A first page whose session is about to expire keeps its results but never forwards a dead cursor.
        cursor_unusable = False
        if seconds_left is not None and seconds_left < SEARCH_SESSION_MIN_LIFETIME_SECONDS:
            wait = max(seconds_left, 0.0) + 1.0
            budget_left = (budget.when() or 0.0) - asyncio.get_running_loop().time()
            if wait + SEARCH_SESSION_REFRESH_RESERVE_SECONDS <= budget_left:
                logger.info("Refreshing reused Lantern search session", seconds_left=round(seconds_left, 1))
                await asyncio.sleep(wait)
                try:
                    data = await fetch_lantern_people(
                        api_url=origin, api_token=token, operation=operation, payload=payload
                    )
                except Exception as exc:  # cancellation is a BaseException and still propagates
                    logger.warning(
                        "Lantern search session refresh failed; returning the first page without its cursor",
                        error=type(exc).__name__,
                    )
                    cursor_unusable = True
            else:
                logger.info(
                    "Lantern search session expires before a refresh fits; returning the first page without its cursor",
                    seconds_left=round(seconds_left, 1),
                )
                cursor_unusable = True
    rows = data.get("items" if operation == "people_profiles_get" else "people")
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise lantern_error("INVALID_RESPONSE")
    if mode == "enrich" and not rows:
        raise lantern_error("SOURCE_RECORD_NOT_FOUND")
    if mode == "enrich" and len(rows) > 1:
        raise lantern_error(
            "PERSON_RESOLUTION_REQUIRED", {"hint": "Discover candidates, then enrich with source_record_id."}
        )
    effective_limit = clamp_discover_limit(limit) if mode == "discover" else 1
    people = [_normalize_person(row, fields if mode == "enrich" else None) for row in rows[:effective_limit]]
    if source_id and people and people[0]["source"]["record_id"] != source_id:
        raise lantern_error("SOURCE_RECORD_MISMATCH")
    warnings = data.get("warnings") or []
    if not isinstance(warnings, list):
        raise lantern_error("INVALID_RESPONSE")
    warnings = [str(warning) for warning in warnings]
    if fields and people:
        missing = [field for field, value in people[0]["attributes"].items() if value is None]
        if missing:
            warnings.append(
                f"Lantern profile has no values for: {', '.join(missing)}. Contact reveals are a separate operation."
            )
    result: PeopleSearchResult = {
        "query": query,
        "mode_used": mode,
        "provider_used": "lantern",
        "providers_attempted": ["lantern"],
        "results": people,
        "warnings": warnings,
    }
    for source_key, key in (("nextCursor", "next_cursor"), ("generation", "generation"), ("source", "source_metadata")):
        if source_key in data and not (cursor_unusable and source_key == "nextCursor"):
            result[key] = data[source_key]
    if "generation" not in result and isinstance(data.get("source"), dict) and data["source"].get("index"):
        result["generation"] = data["source"]["index"]
    result["search_metadata"] = {
        key: data[key]
        for key in (
            "total",
            "totalRelation",
            "truncated",
            "returned",
            "cachedWindow",
            "windowExhausted",
            "expiresAt",
            "interpretation",
        )
        if key in data
    }
    logger.info(
        "People search completed",
        mode_used=mode,
        provider_used="lantern",
        results_count=len(people),
        warnings_count=len(warnings),
    )
    return result
