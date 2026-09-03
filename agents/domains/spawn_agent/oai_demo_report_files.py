"""Turn OAi demo root deliverables into markdown FilePointers for Task Complete.

The July Fast Mode cache still produces string / list schema outputs. After
replay, the root Task Complete card should use the shipped file_pointer
rendering (download chips + markdown preview) instead of a wall of prose.

    structured_response (str / list fields)
            |
            v
    materialize_oai_demo_report_files_activity
            |-- skip values that are already FilePointers
            |-- upload markdown to Supabase attachments
            v
    structured_response (file_pointer fields)
            |
            +--> CompletionSummaryCard FilePointerDisplay
            +--> mark_finished persist
"""

from __future__ import annotations

import json
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

from temporalio import activity

from helpers.attachments import upload_to_storage

# Root assemble-final artifacts from the July OAi demo. Child creator schemas
# stay structured — only the end-of-run report becomes files.
OAI_DEMO_REPORT_FILES: Dict[str, Tuple[str, str]] = {
    "positioning_statement": ("positioning-statement.md", "text/markdown"),
    "top_creators_analysis": ("top-creators-analysis.md", "text/markdown"),
    "ninety_day_content_calendar": ("90-day-content-calendar.md", "text/markdown"),
    "hook_tested_video_script_openings": ("hook-tested-script-openings.md", "text/markdown"),
    "weekly_engagement_target_creators": ("weekly-engagement-targets.md", "text/markdown"),
}


def is_file_pointer_value(value: Any) -> bool:
    if not isinstance(value, Mapping):
        return False
    return bool(value.get("storage_path")) and bool(value.get("original_filename"))


def value_to_markdown(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        if all(isinstance(item, str) for item in value):
            return "\n".join(f"{index}. {item.strip()}" for index, item in enumerate(value, start=1) if item.strip())
        if all(isinstance(item, Mapping) for item in value):
            blocks: List[str] = []
            for index, item in enumerate(value, start=1):
                title = (
                    str(item.get("creator_name") or item.get("name") or item.get("title") or f"Item {index}").strip()
                )
                lines = [f"### {index}. {title}"]
                for key, nested in item.items():
                    if key in {"creator_name", "name", "title"}:
                        continue
                    rendered = value_to_markdown(nested)
                    if rendered:
                        lines.append(f"- **{key.replace('_', ' ')}:** {rendered}")
                blocks.append("\n".join(lines))
            return "\n\n".join(blocks)
        return json.dumps(value, indent=2, ensure_ascii=False)
    if isinstance(value, Mapping):
        return json.dumps(dict(value), indent=2, ensure_ascii=False)
    return str(value).strip()


def plan_oai_demo_report_files(structured_response: Optional[Mapping[str, Any]]) -> List[Dict[str, str]]:
    if not isinstance(structured_response, Mapping):
        return []
    planned: List[Dict[str, str]] = []
    for key, (filename, mime_type) in OAI_DEMO_REPORT_FILES.items():
        value = structured_response.get(key)
        if value in (None, "", [], {}):
            continue
        if is_file_pointer_value(value):
            continue
        if isinstance(value, list) and value and all(is_file_pointer_value(item) for item in value):
            continue
        content = value_to_markdown(value)
        if not content:
            continue
        planned.append({"key": key, "filename": filename, "mime_type": mime_type, "content": content})
    return planned


def rewrite_schema_file_pointer_fields(
    schema: Optional[Mapping[str, Any]],
    keys: Iterable[str],
) -> Optional[Dict[str, Any]]:
    if not isinstance(schema, Mapping):
        return dict(schema) if schema else None
    key_set = set(keys)
    rewritten = dict(schema)
    fields: List[Any] = []
    for field in rewritten.get("fields") or []:
        if not isinstance(field, Mapping):
            fields.append(field)
            continue
        next_field = dict(field)
        if next_field.get("name") in key_set:
            next_field["type"] = "file_pointer"
            next_field.pop("properties", None)
        fields.append(next_field)
    rewritten["fields"] = fields
    return rewritten


@activity.defn
async def materialize_oai_demo_report_files_activity(
    user_id: str,
    structured_response: Optional[Dict[str, Any]],
    output_schema: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Upload demo-root report fields as markdown FilePointers. Idempotent."""
    planned = plan_oai_demo_report_files(structured_response)
    if not planned or not user_id:
        return {
            "structured_response": structured_response,
            "output_schema": output_schema,
        }
    rewritten = dict(structured_response or {})
    for item in planned:
        rewritten[item["key"]] = await upload_to_storage(
            user_id,
            item["content"].encode("utf-8"),
            item["filename"],
            item["mime_type"],
        )
    return {
        "structured_response": rewritten,
        "output_schema": rewrite_schema_file_pointer_fields(
            output_schema,
            (item["key"] for item in planned),
        ),
    }
