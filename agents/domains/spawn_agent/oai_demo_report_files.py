"""Turn OAI demo root deliverables into readable files for Task Complete.

Narrative reports render as self-contained HTML documents; schedules and
record sets render as CSV. The root Task Complete card can therefore use the
file_pointer preview/download UI instead of displaying a wall of prose.

    structured_response (str / list fields)
            |
            v
    materialize_oai_demo_report_files_activity
            |-- skip values that are already FilePointers
            |-- render HTML or CSV according to the information shape
            |-- upload to deterministic, retry-safe storage paths
            v
    structured_response (file_pointer fields)
            |
            +--> CompletionSummaryCard FilePointerDisplay
            +--> mark_finished persist
"""

from __future__ import annotations

import csv
import hashlib
import html
import io
import json
import re
from typing import Any, Dict, List, Mapping, Optional, Tuple

import httpx
from markdown_it import MarkdownIt
from temporalio import activity

from config import load_config
from helpers.attachments import upload_to_storage
from helpers.workflow_generation import workflow_generation_headers

# filename, MIME type, display title, renderer
ReportFileSpec = Tuple[str, str, str, str]

# Root assemble-final artifacts from the July OAI demo. Child creator schemas
# stay structured — only the end-of-run report becomes files.
OAI_DEMO_REPORT_FILES: Dict[str, ReportFileSpec] = {
    "positioning_statement": (
        "positioning-statement.html",
        "text/html",
        "Positioning statement",
        "html",
    ),
    "top_creators_analysis": (
        "top-creators-analysis.html",
        "text/html",
        "Top creators analysis",
        "html",
    ),
    "ninety_day_content_calendar": (
        "90-day-content-calendar.csv",
        "text/csv",
        "90-day content calendar",
        "calendar_csv",
    ),
    "hook_tested_video_script_openings": (
        "hook-tested-script-openings.html",
        "text/html",
        "Hook-tested video script openings",
        "html",
    ),
    "weekly_engagement_target_creators": (
        "weekly-engagement-targets.csv",
        "text/csv",
        "Weekly engagement targets",
        "records_csv",
    ),
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
                title = str(
                    item.get("creator_name") or item.get("name") or item.get("title") or f"Item {index}"
                ).strip()
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


def render_html_document(title: str, markdown: str) -> str:
    """Render trusted report text as a portable, human-readable HTML file."""
    body = MarkdownIt("commonmark", {"html": False}).render(markdown)
    safe_title = html.escape(title)
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{safe_title}</title>
  <style>
    :root {{ color-scheme: light dark; }}
    body {{ font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.6; max-width: 900px; margin: 0 auto; padding: 48px 28px;
      color: #1f2937; background: #ffffff; }}
    h1 {{ font-size: 2rem; line-height: 1.2; margin: 0 0 2rem; }}
    h2 {{ margin-top: 2.25rem; border-bottom: 1px solid #e5e7eb; padding-bottom: .45rem; }}
    h3 {{ margin-top: 1.75rem; }}
    p, li {{ max-width: 78ch; }}
    li + li {{ margin-top: .35rem; }}
    blockquote {{ border-left: 4px solid #8b5cf6; margin-left: 0; padding-left: 1rem; color: #4b5563; }}
    code {{ background: #f3f4f6; border-radius: 4px; padding: .12rem .3rem; }}
    @media (prefers-color-scheme: dark) {{
      body {{ color: #e5e7eb; background: #111827; }}
      h2 {{ border-color: #374151; }}
      blockquote {{ color: #d1d5db; }}
      code {{ background: #1f2937; }}
    }}
  </style>
</head>
<body>
  <h1>{safe_title}</h1>
  <main>{body}</main>
</body>
</html>
"""


def _safe_csv_cell(value: Any) -> Any:
    """Neutralize spreadsheet formulas before a value reaches a CSV cell.

    CSV quoting stops delimiter injection but not formula evaluation: a cell
    beginning with =, +, - or @ is executed when the file is opened in Excel or
    Sheets. Report text and record keys are model- and web-derived, so prefix
    those cells with an apostrophe to force literal text.
    """
    if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")):
        return "'" + value
    return value


def _csv_text(fieldnames: List[str], rows: List[Mapping[str, Any]]) -> str:
    output = io.StringIO(newline="")
    safe_fieldnames = [str(_safe_csv_cell(name)) for name in fieldnames]
    writer = csv.DictWriter(output, fieldnames=safe_fieldnames, lineterminator="\n")
    writer.writeheader()
    for row in rows:
        writer.writerow(
            {safe_name: _safe_csv_cell(row.get(name, "")) for name, safe_name in zip(fieldnames, safe_fieldnames)}
        )
    return output.getvalue()


def _plain_markdown(text: str) -> str:
    return re.sub(r"[*_`]", "", text).strip()


def render_calendar_csv(value: Any) -> str:
    """Turn the cached calendar prose into an explicit, filterable table."""
    text = value_to_markdown(value)
    rows: List[Dict[str, str]] = []
    recurring = False
    calendar_pattern = re.compile(
        r"^-?\s*Week\s+(\d+)\s*\(([^)]+)\)\s*/\s*([^/]+?)\s*/\s*([^:]+):\s*"
        r"(?:\*\*)?(.+?)(?:\*\*)?\s*[—–-]\s*(.+)$",
        re.IGNORECASE,
    )
    recurring_pattern = re.compile(r"^-\s*(.+?)\s*\(([^,]+),\s*([^)]+)\)\s*:\s*(.+)$")

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        plain_line = _plain_markdown(line)
        if re.match(r"^strategy\s*:", plain_line, re.IGNORECASE):
            rows.append(
                {
                    "section": "strategy",
                    "details": plain_line.split(":", 1)[1].strip(),
                }
            )
            recurring = False
            continue
        if "recurring series" in plain_line.lower():
            recurring = True
            continue
        calendar_match = calendar_pattern.match(line)
        if calendar_match:
            week, dates, platform, format_name, title, details = calendar_match.groups()
            rows.append(
                {
                    "section": "calendar",
                    "week": week.strip(),
                    "dates": dates.strip(),
                    "platform": platform.strip(),
                    "format": format_name.strip(),
                    "title": _plain_markdown(title),
                    "details": _plain_markdown(details),
                }
            )
            recurring = False
            continue
        recurring_match = recurring_pattern.match(line) if recurring else None
        if recurring_match:
            title, platform, cadence, details = recurring_match.groups()
            rows.append(
                {
                    "section": "recurring_series",
                    "platform": platform.strip(),
                    "format": cadence.strip(),
                    "title": _plain_markdown(title),
                    "details": _plain_markdown(details),
                }
            )
            continue
        # Preserve every unparsed line instead of silently dropping prose.
        rows.append({"section": "notes", "details": _plain_markdown(line.lstrip("- "))})

    if not rows and text:
        rows.append({"section": "notes", "details": text})
    return _csv_text(
        ["section", "week", "dates", "platform", "format", "title", "details"],
        rows,
    )


def _csv_cell(value: Any) -> Any:
    if isinstance(value, (Mapping, list)):
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    if value is None:
        return ""
    return value


def render_records_csv(value: Any) -> str:
    """Render a JSON/list record set as CSV while retaining all source fields."""
    parsed = value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            parsed = [{"details": value.strip()}]
    if isinstance(parsed, Mapping):
        records: List[Mapping[str, Any]] = [parsed]
    elif isinstance(parsed, list):
        records = [item if isinstance(item, Mapping) else {"item": item} for item in parsed]
    else:
        records = [{"details": parsed}]

    fieldnames: List[str] = []
    for record in records:
        for key in record:
            name = str(key)
            if name not in fieldnames:
                fieldnames.append(name)
    if not fieldnames:
        fieldnames = ["details"]
    normalized = [{str(key): _csv_cell(nested) for key, nested in record.items()} for record in records]
    return _csv_text(fieldnames, normalized)


def _render_report(value: Any, title: str, renderer: str) -> str:
    if renderer == "html":
        return render_html_document(title, value_to_markdown(value))
    if renderer == "calendar_csv":
        return render_calendar_csv(value)
    if renderer == "records_csv":
        return render_records_csv(value)
    raise ValueError(f"Unknown OAI demo report renderer: {renderer}")


def plan_oai_demo_report_files(structured_response: Optional[Mapping[str, Any]]) -> List[Dict[str, str]]:
    if not isinstance(structured_response, Mapping):
        return []
    planned: List[Dict[str, str]] = []
    for key, (filename, mime_type, title, renderer) in OAI_DEMO_REPORT_FILES.items():
        value = structured_response.get(key)
        if value in (None, "", [], {}):
            continue
        if is_file_pointer_value(value):
            continue
        if isinstance(value, list) and value and all(is_file_pointer_value(item) for item in value):
            continue
        content = _render_report(value, title, renderer)
        if not content:
            continue
        planned.append({"key": key, "filename": filename, "mime_type": mime_type, "content": content})
    return planned


def passthrough_file_pointer_specs(
    structured_response: Optional[Mapping[str, Any]],
) -> Dict[str, ReportFileSpec]:
    """Specs for report fields that already arrived as FilePointers.

    `plan_oai_demo_report_files` deliberately skips these (there is nothing to
    upload), but the response still carries a file pointer for them. Their
    schema fields must be rewritten to the file type anyway, or the declared
    schema contradicts the value it describes.
    """
    specs: Dict[str, ReportFileSpec] = {}
    if not isinstance(structured_response, Mapping):
        return specs
    for key, spec in OAI_DEMO_REPORT_FILES.items():
        value = structured_response.get(key)
        if value in (None, "", [], {}):
            continue
        if is_file_pointer_value(value) or (
            isinstance(value, list) and value and all(is_file_pointer_value(item) for item in value)
        ):
            specs[key] = spec
    return specs


def rewrite_schema_file_pointer_fields(
    schema: Optional[Mapping[str, Any]],
    specs: Mapping[str, ReportFileSpec],
) -> Optional[Dict[str, Any]]:
    if not isinstance(schema, Mapping):
        return dict(schema) if schema else None
    rewritten = dict(schema)
    fields: List[Any] = []
    for field in rewritten.get("fields") or []:
        if not isinstance(field, Mapping):
            fields.append(field)
            continue
        next_field = dict(field)
        spec = specs.get(str(next_field.get("name")))
        if spec:
            filename = spec[0]
            extension = filename.rsplit(".", 1)[-1].lower()
            next_field["type"] = "file_pointer"
            next_field["file_types"] = [extension]
            next_field.pop("properties", None)
        fields.append(next_field)
    rewritten["fields"] = fields
    return rewritten


async def _persist_rewritten_schema(agent_id: str, schema: Optional[Dict[str, Any]]) -> None:
    """Durably store the file-pointer schema alongside the response it describes.

    `mark_finished` carries `structured_response` but not the schema, so without
    this the DB keeps the pre-rewrite field types while the stored response holds
    FilePointers, and the UI renders a file value against a text schema. Uses the
    existing `PATCH /api/agents/:id` `response_schema` field. Best effort: the
    reports themselves are already uploaded, so a persistence failure must not
    fail completion.
    """
    if not agent_id or not isinstance(schema, dict):
        return
    try:
        config = load_config()
        async with httpx.AsyncClient() as client:
            response = await client.patch(
                f"{config.backend.api_url}/api/agents/{agent_id}",
                json={"response_schema": schema},
                headers={
                    "X-API-Key": config.backend.api_key,
                    "Content-Type": "application/json",
                    **workflow_generation_headers(),
                },
                timeout=30.0,
            )
            response.raise_for_status()
    except Exception as exc:  # noqa: BLE001 - completion must survive this
        activity.logger.warning(f"[oai-demo] failed to persist rewritten output schema for {agent_id}: {exc}")


@activity.defn
async def materialize_oai_demo_report_files_activity(
    user_id: str,
    structured_response: Optional[Dict[str, Any]],
    output_schema: Optional[Dict[str, Any]] = None,
    agent_id: str = "",
) -> Dict[str, Any]:
    """Upload demo-root report fields as retry-safe HTML/CSV FilePointers."""
    planned = plan_oai_demo_report_files(structured_response)
    passthrough_specs = passthrough_file_pointer_specs(structured_response)
    if not planned or not user_id:
        if not passthrough_specs:
            return {
                "structured_response": structured_response,
                "output_schema": output_schema,
            }
        passthrough_schema = rewrite_schema_file_pointer_fields(output_schema, passthrough_specs)
        await _persist_rewritten_schema(agent_id, passthrough_schema)
        return {
            "structured_response": structured_response,
            "output_schema": passthrough_schema,
        }
    rewritten = dict(structured_response or {})
    planned_specs: Dict[str, ReportFileSpec] = {}
    for item in planned:
        content = item["content"].encode("utf-8")
        retry_scope = agent_id or hashlib.sha256(content).hexdigest()
        rewritten[item["key"]] = await upload_to_storage(
            user_id,
            content,
            item["filename"],
            item["mime_type"],
            idempotency_key=f"oai-demo-report:{retry_scope}:{item['filename']}",
        )
        planned_specs[item["key"]] = OAI_DEMO_REPORT_FILES[item["key"]]
    rewritten_schema = rewrite_schema_file_pointer_fields(output_schema, {**passthrough_specs, **planned_specs})
    await _persist_rewritten_schema(agent_id, rewritten_schema)
    return {
        "structured_response": rewritten,
        "output_schema": rewritten_schema,
    }
