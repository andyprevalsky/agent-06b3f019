"""Deterministic grounding checks over actual Lantern people tool transcripts."""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any

from tools.base import format_params
from tools.people_search.service import _normalize_person

DEFAULT_FORBIDDEN = frozenset(
    {
        "web_search",
        "web_fetch",
        "web_fetch_download",
        "api_request",
        "google_workspace_run",
        "spawn_browser_agent",
        "spawn_claude_code_agent",
        "spawn_code_agent",
        "deep_research",
    }
)
FINAL_FIELDS = (
    "name",
    "profile_url",
    "current_title",
    "current_company",
    "source_record_id",
    "retrieved_at",
    "generation",
)
CONSTRAINTS = ("query", "location", "location_kind", "country_code", "companies", "titles", "limit")


def _string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _config(check: dict) -> None:
    allowed = {
        "type",
        "scenario",
        "min_records",
        "page_size",
        "required_titles",
        "query",
        "required_fields",
        "forbidden_tools",
    }
    if check.keys() - allowed or check.get("scenario") not in {"discovery", "enrichment", "pagination"}:
        raise ValueError("Invalid Lantern scenario/configuration")
    if not _string(check.get("query")) or type(check.get("min_records")) is not int or check["min_records"] < 1:
        raise ValueError("Lantern query and positive min_records are required")
    for key in ("required_titles", "required_fields", "forbidden_tools"):
        if key in check and (not isinstance(check[key], list) or any(not _string(x) for x in check[key])):
            raise ValueError(f"Invalid Lantern {key}")
    if not check.get("required_titles"):
        raise ValueError("Scenario requires required_titles")
    if check["scenario"] == "enrichment" and not check.get("required_fields"):
        raise ValueError("Enrichment requires required_fields")
    if type(check.get("page_size")) is not int or check["page_size"] < 1:
        raise ValueError("Scenario requires positive page_size")
    if "page_size" in check and (type(check["page_size"]) is not int or check["page_size"] < 1):
        raise ValueError("Invalid page_size")


def _rows(data: dict) -> list[dict]:
    lists = [data.get("messages", [])]
    for container in (data.get("_benchmark"), data.get("logs")):
        if not isinstance(container, dict):
            continue
        lists.append(container.get("messages", []))
        tree = container.get("tree")
        if isinstance(tree, dict):
            lists.extend(node.get("messages", []) for node in tree.values() if isinstance(node, dict))
    rows: list[dict] = []
    seen: set[str] = set()
    for messages in lists:
        if not isinstance(messages, list):
            raise ValueError("Malformed trajectory messages")
        for row in messages:
            if not isinstance(row, dict):
                raise ValueError("Malformed trajectory row")
            fingerprint = json.dumps(row, sort_keys=True, default=str)
            if fingerprint not in seen:
                seen.add(fingerprint)
                rows.append(row)
    # Hydrated trees duplicate parent-visible explore rows. Timestamps establish
    # discovery-before-enrichment/page order across different transcript sections.
    rows.sort(key=lambda row: str(row.get("timestamp") or row.get("created_at") or ""))
    return rows


def _formatted(row: dict) -> tuple[dict, dict]:
    text = row.get("message") or row.get("text")
    if not isinstance(text, str) or not text.startswith("**Params Passed:**\n\n"):
        raise ValueError("People search lacks its owning formatter evidence")
    params_text, result_text = text[len("**Params Passed:**\n\n") :].split("\n\n**Result:**\n\n", 1)
    params: dict[str, Any] = {}
    matches = list(re.finditer(r"(?m)^- \*\*([a-z_]+)\*\*: ", params_text))
    for i, match in enumerate(matches):
        value = params_text[match.end() : matches[i + 1].start() if i + 1 < len(matches) else len(params_text)].rstrip(
            "\n"
        )
        key = match.group(1)
        if key in params:
            raise ValueError("Duplicate formatted parameter")
        if value == "None":
            params[key] = None
        elif key in {"fields", "companies", "titles", "limit"}:
            params[key] = json.loads(value)
        else:
            params[key] = value
    if format_params(params) != params_text:
        raise ValueError("Malformed owning parameter format")
    result, end = json.JSONDecoder().raw_decode(result_text)
    if not isinstance(result, dict) or not re.fullmatch(
        r"\n\n\*\*Time Elapsed:\*\* [^\n]+\n\n\*\*Cost:\*\* \$[0-9.]+", result_text[end:]
    ):
        raise ValueError("Malformed owning result format")
    return params, result


def _native(result: dict, params: dict) -> dict[str, dict]:
    records: dict[str, dict] = {}
    if not isinstance(result.get("results"), list):
        raise ValueError("Missing native results")
    if result["results"] and not _string(result.get("generation")):
        raise ValueError("Missing native generation")
    for person in result["results"]:
        if not isinstance(person, dict):
            raise ValueError("Malformed native person")
        profile = person.get("profile")
        if not isinstance(profile, dict):
            raise ValueError("Missing underlying native profile")
        normalized = _normalize_person(profile, params.get("fields") if params.get("mode") == "enrich" else None)
        if any(
            person.get(key) != normalized.get(key)
            for key in ("name", "profile_url", "title", "company", "location", "source", "attributes")
        ):
            raise ValueError("Normalized values differ from underlying native profile")
        source = person.get("source")
        if (
            not isinstance(source, dict)
            or source.get("provider") != "lantern"
            or not all(_string(source.get(k)) for k in ("record_id", "retrieved_at"))
        ):
            raise ValueError("Missing native source provenance")
        if datetime.fromisoformat(source["retrieved_at"].replace("Z", "+00:00")).utcoffset() is None:
            raise ValueError("Native retrieval time lacks timezone")
        if not _string(person.get("name")) or not _string(person.get("profile_url")):
            raise ValueError("Missing native identity/profile URL")
        record = {
            "name": person["name"],
            "profile_url": person["profile_url"],
            "current_title": person.get("title"),
            "current_company": person.get("company"),
            "source_record_id": source["record_id"],
            "retrieved_at": source["retrieved_at"],
            "generation": result["generation"],
            "location": person.get("location"),
        }
        if source["record_id"] in records:
            raise ValueError("Duplicate native source ID in page")
        records[source["record_id"]] = record
    return records


def _final_people(data: dict) -> tuple[list[dict], dict]:
    messages = data.get("messages")
    if not isinstance(messages, list):
        raise ValueError("Missing root completion transcript")
    cards: list[dict] = []
    for row in messages:
        if not isinstance(row, dict) or row.get("role") != "TOOL":
            continue
        meta = row.get("metadata")
        if not isinstance(meta, dict) or meta.get("subAgentId"):
            continue
        if meta.get("toolName") == "completion_summary" and meta.get("isFinalSummary") is True:
            cards.append(row)
    if cards:
        # A later empty/malformed final card supersedes earlier valid outputs.
        # Do not search backward until an old answer happens to match evidence.
        card = cards[-1]
        if card["metadata"].get("toolStatus") != "FINISHED":
            raise ValueError("Latest completion card is not finished")
        summary = card["metadata"].get("completionSummary")
        if not isinstance(summary, dict) or not isinstance(summary.get("outputs"), list):
            raise ValueError("Latest completion card lacks structured outputs")
        people = [
            item.get("value") for item in summary["outputs"] if isinstance(item, dict) and item.get("key") == "people"
        ]
        if len(people) != 1 or not isinstance(people[0], list):
            raise ValueError("Latest completion card lacks structured people")
        return people[0], card
    raise ValueError("No canonical final people output")


def check_lantern_people_trace(data: dict, check: dict) -> tuple[bool, str]:
    """Require native Lantern records, valid operation lineage, and grounded finals."""
    try:
        _config(check)
        final, final_row = _final_people(data)
        forbidden = DEFAULT_FORBIDDEN | set(check.get("forbidden_tools", []))
        traces: list[tuple[dict, dict, dict[str, dict]]] = []
        seen_calls: dict[str, str] = {}
        rows = _rows(data)
        final_position = rows.index(final_row)
        explore_actors = {
            meta["taskId"]
            for row in rows[:final_position]
            if row.get("role") == "TOOL"
            and isinstance(meta := row.get("metadata"), dict)
            and meta.get("toolName") == "spawn_agent"
            and meta.get("agentType") == "explore"
            and meta.get("toolStatus") == "FINISHED"
            and not meta.get("subAgentId")
            and _string(meta.get("taskId"))
            and _string(meta.get("toolCallId"))
        }
        for position, row in enumerate(rows):
            if row.get("role") != "TOOL":
                continue
            meta = row.get("metadata")
            if not isinstance(meta, dict):
                continue
            if meta.get("toolName") in forbidden:
                raise ValueError(f"Forbidden tool observed: {meta['toolName']}")
            if meta.get("toolName") != "people_search" or meta.get("toolStatus") != "FINISHED":
                continue
            if position >= final_position:
                continue
            actor = meta.get("subAgentId")
            if meta.get("agentType") != "explore" or actor not in explore_actors or meta.get("taskId") != actor:
                raise ValueError("People search lacks matching actual explore spawn")
            params, result = _formatted(row)
            if (
                any(result.get(key) for key in ("world_model_simulated", "_fast_cache_hit", "from_fast_cache", "error"))
                or result.get("provider_used") != "lantern"
                or result.get("providers_attempted") != ["lantern"]
                or result.get("mode_used") != params.get("mode")
                or result.get("query") != params.get("query")
            ):
                raise ValueError("People search provider/mode/query mismatch")
            call_id = meta.get("toolCallId")
            if not _string(call_id):
                raise ValueError("Missing actual tool call identity")
            signature = json.dumps([params, result], sort_keys=True)
            if call_id in seen_calls:
                if seen_calls[call_id] != signature:
                    raise ValueError("Conflicting tool call evidence")
                continue
            seen_calls[call_id] = signature
            traces.append((params, result, _native(result, params)))
        evidence: dict[str, dict] = {}
        scenario = check["scenario"]
        if scenario == "discovery":
            for params, _, records in traces:
                if (
                    params.get("mode") == "discover"
                    and params.get("query") == check["query"]
                    and params.get("limit") == check["page_size"]
                    and isinstance(params.get("titles"), list)
                    and params["titles"] == check["required_titles"]
                ):
                    if len(records) >= check["min_records"]:
                        evidence = records
        elif scenario == "enrichment":
            discovered: set[tuple[str, str]] = set()
            for params, result, records in traces:
                if (
                    params.get("mode") == "discover"
                    and params.get("query") == check["query"]
                    and params.get("limit") == check["page_size"]
                    and isinstance(params.get("titles"), list)
                    and params["titles"] == check["required_titles"]
                ):
                    discovered.update((key, record["generation"]) for key, record in records.items())
                if params.get("mode") != "enrich" or not records:
                    continue
                source_id = params.get("source_record_id")
                if (
                    len(records) != 1
                    or source_id not in records
                    or (source_id, params.get("generation")) not in discovered
                    or result.get("generation") != params.get("generation")
                ):
                    raise ValueError("Enrichment lacks prior native ID and matching generation")
                fields = params.get("fields")
                attrs = result["results"][0].get("attributes")
                if (
                    not isinstance(fields, list)
                    or not set(check["required_fields"]).issubset(fields)
                    or not isinstance(attrs, dict)
                ):
                    raise ValueError("Enrichment lacks requested-field evidence")
                aliases = {
                    "current_title": "current_title",
                    "current_company": "current_company",
                    "linkedin_url": "profile_url",
                }
                for field in check["required_fields"]:
                    if field not in attrs or field not in aliases or attrs[field] != records[source_id][aliases[field]]:
                        raise ValueError("Enrichment attributes do not match native profile")
                if len(records) >= check["min_records"]:
                    evidence = records
        else:
            for i, (params, result, records) in enumerate(traces):
                if (
                    params.get("mode") != "discover"
                    or params.get("query") != check["query"]
                    or params.get("limit") != check["page_size"]
                    or params.get("cursor") is not None
                    or len(records) != check["page_size"]
                ):
                    continue
                if check.get("required_titles") and (
                    not isinstance(params.get("titles"), list) or params["titles"] != check["required_titles"]
                ):
                    continue
                cursor = result.get("next_cursor")
                if not _string(cursor):
                    continue
                for following, next_result, next_records in traces[i + 1 :]:
                    if following.get("mode") != "discover" or following.get("cursor") != cursor:
                        continue
                    if (
                        any(following.get(key) != params.get(key) for key in CONSTRAINTS)
                        or next_result.get("generation") != result.get("generation")
                        or len(next_records) != check["page_size"]
                        or records.keys() & next_records.keys()
                    ):
                        raise ValueError("Pagination changed query/constraints/generation or repeated IDs")
                    evidence = {**records, **next_records}
                    break
                if evidence:
                    break
        if len(evidence) < check["min_records"]:
            raise ValueError("Insufficient native Lantern records for scenario")
        if len(final) != check["min_records"]:
            raise ValueError("Final people count differs from scenario width")
        ids: set[str] = set()
        for person in final:
            if not isinstance(person, dict) or any(key not in person for key in FINAL_FIELDS):
                raise ValueError("Final people lack required provenance columns")
            source_id = person["source_record_id"]
            if not _string(source_id) or source_id in ids or source_id not in evidence:
                raise ValueError("Final people contain duplicate/substituted source IDs")
            ids.add(source_id)
            if any(person[key] != evidence[source_id][key] for key in FINAL_FIELDS) or (
                "location" in person and person["location"] != evidence[source_id]["location"]
            ):
                raise ValueError("Final people values are not grounded in native Lantern records")
        return True, f"Lantern {scenario}: {len(ids)} grounded records"
    except (ValueError, TypeError, KeyError, AttributeError) as error:
        return False, str(error)
