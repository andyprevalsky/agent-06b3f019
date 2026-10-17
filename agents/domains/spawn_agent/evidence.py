"""Bounded native grep record admission; researcher prose is never parsed."""
from __future__ import annotations
import hashlib
import json
from typing import Any, TypedDict

class EvidenceOwner(TypedDict):
    agent_id: str
    user_id: str
    task_id: str
    parent_tool_call_id: str

class NativeToolUnit(TypedDict):
    tool_name: str
    tool_call_id: str
    result: Any

def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)

def legacy_traces(units: list[NativeToolUnit], render) -> list[str]:
    return [f"[{u['tool_name']}] {render(u['tool_name'], u['result'])}" for u in units]

def admit_grep_records(owner: EvidenceOwner, units: list[NativeToolUnit], budget: int = 6000) -> dict:
    """Whole-record admission; omitted match display text never masquerades as records."""
    envelope = {"version": 1, "owner": owner, "units": [], "omitted_tool_units": 0}
    if len(_json(envelope)) > budget:
        return {"version": 1, "admission": "owner_metadata_omitted", "complete": False}
    unique = {}
    call_ids = {}
    for unit in units:
        if unit.get("tool_name") == "grep":
            call_id = unit.get("tool_call_id")
            if not isinstance(call_id, str) or not call_id or (call_id in call_ids and call_ids[call_id] != _json(unit["result"])):
                return {"version": 1, "admission": "invalid_tool_identity", "complete": False}
            call_ids[call_id] = _json(unit["result"])
            unique.setdefault(_json(unit['result']), unit)
    pending = []
    legacy = []
    envelope["omitted_tool_units"] = max(0, len(unique) - 3)
    # Reserve envelopes before bodies so early large text cannot consume later provenance.
    for unit in list(unique.values())[-3:]:
        result = unit['result']
        matches = result.get('matches') if isinstance(result, dict) else None
        entry = {"tool_call_id": unit['tool_call_id'],
                 "source_result_sha256": hashlib.sha256(_json(result).encode()).hexdigest(),
                 "matches": [], "omitted_matches": 0,
                 "unstructured": not isinstance(matches, list)}
        envelope['units'].append(entry)
        if len(_json(envelope)) > budget:
            envelope['units'].pop(); envelope['omitted_tool_units'] += 1
            continue
        if not isinstance(matches, list):
            # Legacy text stays in the old trace channel; native admission cannot
            # authenticate fields by parsing prose. Explicitly disclose omission.
            entry['legacy_text_admission'] = 'omitted_unstructured'
            legacy.append((entry, result))
            continue
        entry['omitted_matches'] = len(matches)
        for match in matches:
            if not isinstance(match, dict) or not isinstance(match.get('records'), list):
                entry['unstructured'] = True
                continue
            records = match['records']
            group = {"source_envelope": {k: v for k, v in match.items() if k not in {'records', 'content'}},
                     "records": [], "omitted_records": len(records),
                     "included_records_complete": True, "match_content_admission": "omitted"}
            entry['matches'].append(group); entry['omitted_matches'] -= 1
            if len(_json(envelope)) > budget:
                entry['matches'].pop(); entry['omitted_matches'] += 1
                continue
            pending.append((group, records))
    for group, records in pending:
        for record in records:
            if not isinstance(record, dict):
                continue
            group['records'].append(record); group['omitted_records'] -= 1
            if len(_json(envelope)) > budget:
                group['records'].pop(); group['omitted_records'] += 1
    for entry, result in legacy:
        from domains.spawn_agent.service import _bounded_explore_parts
        remaining = max(0, budget - len(_json(envelope)) - 64)
        text = result if isinstance(result, str) else _json(result)
        excerpt = _bounded_explore_parts([text], remaining)
        if excerpt:
            entry['legacy_text_admission'] = 'incomplete_excerpt'
            entry['unstructured_excerpt'] = excerpt
            while len(_json(envelope)) > budget and excerpt:
                excerpt = excerpt[:len(excerpt)//2]
                entry['unstructured_excerpt'] = excerpt
            if len(_json(envelope)) > budget:
                entry.pop('unstructured_excerpt', None)
                entry['legacy_text_admission'] = 'omitted_unstructured'
    # Counter-width changes or unknown-format markers cannot breach the hard cap.
    if len(_json(envelope)) > budget:
        return {"version": 1, "admission": "metadata_omitted", "complete": False}
    return envelope

def render_native_grep(envelope: Any, expected_owner: EvidenceOwner, budget: int = 6000) -> str:
    """Reject foreign/malformed typed transport without falling back to prose."""
    invalid = '[Native grep evidence incomplete: invalid or foreign producer envelope]'
    if not isinstance(envelope, dict) or envelope.get('version') != 1:
        return invalid[:max(0, budget)]
    if envelope.get('owner') != expected_owner:
        return invalid[:max(0, budget)]
    if not isinstance(envelope.get('units'), list):
        return invalid[:max(0, budget)]
    if not envelope['units'] and not envelope.get('omitted_tool_units'):
        return ''
    seen_calls = set()
    for unit in envelope['units']:
        if not isinstance(unit, dict) or not isinstance(unit.get('tool_call_id'), str) or not isinstance(unit.get('matches'), list):
            return invalid[:max(0, budget)]
        if unit['tool_call_id'] in seen_calls or not unit['tool_call_id'] or not isinstance(unit.get('source_result_sha256'), str) or len(unit['source_result_sha256']) != 64 or type(unit.get('omitted_matches')) is not int or unit['omitted_matches'] < 0:
            return invalid[:max(0, budget)]
        seen_calls.add(unit['tool_call_id'])
        for item in unit['matches']:
            if not isinstance(item, dict) or not isinstance(item.get('source_envelope'), dict) or not isinstance(item.get('records'), list) or any(not isinstance(r, dict) for r in item['records']):
                return invalid[:max(0, budget)]
            if item.get('included_records_complete') is not True or item.get('match_content_admission') != 'omitted' or type(item.get('omitted_records')) is not int or item['omitted_records'] < 0:
                return invalid[:max(0, budget)]
    rendered = _json(envelope)
    return rendered if len(rendered) <= budget else invalid[:max(0, budget)]
