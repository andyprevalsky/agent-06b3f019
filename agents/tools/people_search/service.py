"""People search business logic -- (mode x provider) routing, fallback, normalization."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Optional

import structlog
from temporalio import activity

from config import load_config
from tools.people_search.config import (
    DISCOVER_DEFAULT_LIMIT,
    DISCOVER_MAX_LIMIT,
    DISCOVER_MIN_LIMIT,
    ENRICH_EXA_CANDIDATE_POOL,
    PARALLEL_MIN_MATCH_LIMIT,
    PROVIDER_FALLBACK,
)
from tools.people_search.repo import (
    build_exa_output_schema,
    fetch_exa_people,
    fetch_parallel_people,
)

if TYPE_CHECKING:
    from tools.people_search.types import PeopleSearchResult, PersonResult

logger = structlog.get_logger()


def clamp_discover_limit(limit: Any) -> int:
    """Clamp a discover ``limit`` into the public range, defaulting when unset."""
    if limit is None:
        return DISCOVER_DEFAULT_LIMIT
    try:
        value = int(limit)
    except (TypeError, ValueError):
        return DISCOVER_DEFAULT_LIMIT
    return max(DISCOVER_MIN_LIMIT, min(DISCOVER_MAX_LIMIT, value))


def _api_key_for(provider: str, app_config: Any) -> str:
    """Return the configured API key for a provider ('' if unset)."""
    if provider == "exa":
        return app_config.exa.api_key
    return app_config.parallel.api_key


# ---------------------------------------------------------------------------
# Exa normalization
# ---------------------------------------------------------------------------


def _exa_person_entity(result: dict[str, Any]) -> dict[str, Any]:
    """Return the first person entity's ``properties`` dict (or {})."""
    person = next(
        (e for e in (result.get("entities") or []) if e.get("type") == "person"),
        None,
    )
    return (person or {}).get("properties", {}) or {}


def _exa_base_fields(result: dict[str, Any], props: dict[str, Any]) -> dict[str, Any]:
    """Derive the standard profile fields from an Exa result + person props."""
    name = props.get("name")
    if not name:
        joined = " ".join(p for p in (props.get("firstName"), props.get("lastName")) if p)
        name = joined or result.get("title")

    work = props.get("workHistory") or []
    current = work[0] if work else {}
    company_obj = current.get("company") or {}
    company = company_obj.get("name") if isinstance(company_obj, dict) else None

    highlights = result.get("highlights") or []
    return {
        "name": name,
        "profile_url": result.get("url"),
        "title": current.get("title"),
        "company": company,
        "location": props.get("location"),
        "summary": " ".join(highlights) if highlights else None,
        "snippet": highlights[0] if highlights else None,
    }


def _exa_attributes(result: dict[str, Any], props: dict[str, Any], fields: list[str]) -> dict[str, Any]:
    """Build the requested enrich ``fields`` from Exa data, best-effort.

    Prefers Exa's synthesized ``outputSchema`` output when present, otherwise
    derives from the structured person entity. Missing fields resolve to None.
    """
    synthesized = result.get("output") if isinstance(result.get("output"), dict) else {}

    work = props.get("workHistory") or []
    current = work[0] if work else {}
    company_obj = current.get("company") or {}
    education = [
        " ".join(p for p in ((e.get("degree")), ((e.get("institution") or {}).get("name"))) if p)
        for e in (props.get("educationHistory") or [])
    ]
    url = result.get("url") or ""
    derivations = {
        "name": props.get("name"),
        "current_title": current.get("title"),
        "current_company": company_obj.get("name") if isinstance(company_obj, dict) else None,
        "title": current.get("title"),
        "company": company_obj.get("name") if isinstance(company_obj, dict) else None,
        "location": props.get("location"),
        "profile_url": result.get("url"),
        # Exa's people entity has no linkedin_url field, but the result URL is
        # often the person's LinkedIn profile -- surface it when so.
        "linkedin_url": url if "linkedin.com" in url else None,
        "education": education or None,
    }

    attrs: dict[str, Any] = {}
    for field in fields:
        if field in synthesized and synthesized[field] is not None:
            attrs[field] = synthesized[field]
        else:
            attrs[field] = derivations.get(field)
    return attrs


def _normalize_exa_discover(results: list[dict[str, Any]], limit: int) -> list[PersonResult]:
    people: list[PersonResult] = []
    for r in results[:limit]:
        props = _exa_person_entity(r)
        base = _exa_base_fields(r, props)
        has_entity = bool(props)
        people.append(
            {
                "name": base["name"],
                "profile_url": base["profile_url"],
                "title": base["title"],
                "company": base["company"],
                "location": base["location"],
                "summary": base["summary"],
                "source": {"provider": "exa", "url": base["profile_url"], "snippet": base["snippet"]},
                "confidence": "high" if (has_entity and base["name"]) else ("medium" if base["name"] else "low"),
            }
        )
    return people


def _normalize_exa_enrich(results: list[dict[str, Any]], fields: Optional[list[str]]) -> list[PersonResult]:
    if not results:
        return []
    r = results[0]
    props = _exa_person_entity(r)
    base = _exa_base_fields(r, props)
    person: PersonResult = {
        "name": base["name"],
        "profile_url": base["profile_url"],
        "title": base["title"],
        "company": base["company"],
        "location": base["location"],
        "summary": base["summary"],
        "source": {"provider": "exa", "url": base["profile_url"], "snippet": base["snippet"]},
        "confidence": "high" if (props and base["name"]) else ("medium" if base["name"] else "low"),
    }
    if fields:
        person["attributes"] = _exa_attributes(r, props, fields)
    return [person]


# ---------------------------------------------------------------------------
# Parallel normalization
# ---------------------------------------------------------------------------


def _normalize_parallel_discover(entities: list[dict[str, Any]], limit: int) -> list[PersonResult]:
    people: list[PersonResult] = []
    for e in entities[:limit]:
        name = e.get("name")
        url = e.get("url")
        description = e.get("description")
        people.append(
            {
                "name": name,
                "profile_url": url,
                "title": None,
                "company": None,
                "location": None,
                "summary": description,
                "source": {"provider": "parallel", "url": url, "snippet": description},
                "confidence": "medium" if name else "low",
            }
        )
    return people


def _normalize_parallel_enrich(
    entities: list[dict[str, Any]], fields: Optional[list[str]]
) -> tuple[list[PersonResult], list[str]]:
    """Best-effort enrich from Parallel Entity Search (no field-level data).

    Entity Search returns only name/url/description, so requested ``fields``
    cannot be guaranteed. We surface a warning steering toward Exa for depth.
    """
    warnings: list[str] = []
    if not entities:
        return [], warnings
    e = entities[0]
    name = e.get("name")
    description = e.get("description")
    person: PersonResult = {
        "name": name,
        "profile_url": e.get("url"),
        "title": None,
        "company": None,
        "location": None,
        "summary": description,
        "source": {"provider": "parallel", "url": e.get("url"), "snippet": description},
        "confidence": "medium" if name else "low",
    }
    if fields:
        # Only name/profile_url are reliably available from Entity Search.
        derivations = {"name": name, "profile_url": e.get("url")}
        person["attributes"] = {f: derivations.get(f) for f in fields}
        missing = [f for f in fields if person["attributes"][f] is None]
        if missing:
            warnings.append(
                "provider 'parallel' enrich returns limited fields; "
                f"{', '.join(missing)} unavailable (use provider='exa' for field-level enrichment)."
            )
    return [person], warnings


# ---------------------------------------------------------------------------
# Provider dispatch
# ---------------------------------------------------------------------------


async def _call_provider(
    provider: str,
    query: str,
    mode: str,
    limit: int,
    fields: Optional[list[str]],
    api_key: str,
) -> tuple[list[PersonResult], list[str]]:
    """Run one provider for one (mode) and return (results, warnings).

    Raises on HTTP/transport error so the caller can fall back.
    """
    if provider == "exa":
        if mode == "enrich":
            output_schema = build_exa_output_schema(fields) if fields else None
            raw = await fetch_exa_people(
                query=query, api_key=api_key, num_results=ENRICH_EXA_CANDIDATE_POOL, output_schema=output_schema
            )
            return _normalize_exa_enrich(raw, fields), []
        raw = await fetch_exa_people(query=query, api_key=api_key, num_results=limit)
        return _normalize_exa_discover(raw, limit), []

    # provider == "parallel"
    if mode == "enrich":
        raw = await fetch_parallel_people(
            objective=query, api_key=api_key, match_limit=PARALLEL_MIN_MATCH_LIMIT
        )
        return _normalize_parallel_enrich(raw, fields)
    match_limit = max(limit, PARALLEL_MIN_MATCH_LIMIT)
    raw = await fetch_parallel_people(objective=query, api_key=api_key, match_limit=match_limit)
    return _normalize_parallel_discover(raw, limit), []


async def execute_people_search(
    query: str,
    mode: str,
    provider: str,
    limit: Optional[int] = None,
    fields: Optional[list[str]] = None,
) -> PeopleSearchResult:
    """Run a people search via the chosen provider and normalize the output.

    Routing is (mode x provider): the model picks both explicitly. On a
    rate-limit or transport error from the chosen provider, the tool retries
    the OTHER provider once (data-quality-driven switching is the model's job,
    via an explicit re-call). Returns one normalized envelope.
    """
    activity.heartbeat(f"People search ({mode}/{provider}): {query}")

    effective_limit = clamp_discover_limit(limit) if mode == "discover" else 1
    app_config = load_config()

    warnings: list[str] = []
    providers_attempted: list[str] = []
    results: list[PersonResult] = []
    provider_used = provider

    order = [provider, PROVIDER_FALLBACK[provider]]
    for idx, prov in enumerate(order):
        api_key = _api_key_for(prov, app_config)
        if not api_key:
            warnings.append(f"{prov} API key not configured.")
            continue
        providers_attempted.append(prov)
        try:
            results, prov_warnings = await _call_provider(prov, query, mode, effective_limit, fields, api_key)
            warnings.extend(prov_warnings)
            provider_used = prov
            if idx > 0:
                warnings.append(f"Primary provider '{order[0]}' unavailable; fell back to '{prov}'.")
            break
        except Exception as err:  # noqa: BLE001 - surface + fall back to other provider
            logger.warning("People search provider failed", provider=prov, mode=mode, error=str(err))
            warnings.append(f"{prov} people search failed: {err}")
            continue

    result: PeopleSearchResult = {
        "query": query,
        "mode_used": mode,
        "provider_used": provider_used,
        "providers_attempted": providers_attempted,
        "results": results,
        "warnings": warnings,
    }

    logger.info(
        "People search completed",
        query=query,
        mode_used=mode,
        provider_used=provider_used,
        providers_attempted=providers_attempted,
        results_count=len(results),
        warnings_count=len(warnings),
    )
    return result
