"""User tools domain types - tool.json contract and pinned-spec normalization.

``tool.json`` (authored by the user's code agent under ``tools/<name>/``)::

    {
      "name": "<name>",                 # must match the manifest key, [a-z0-9_]+
      "description": "...",
      "input_schema": {...},            # JSON Schema object (no $ref)
      "output_schema": {...},           # optional JSON Schema for the handler result
      "render": {"view": "<inline key>"},   # optional inline view for the result
      "side_effects": false,
      "idempotency_key_field": "...",   # required when side_effects (v1 rejects side effects)
      "timeout_s": 60,                  # default 60, max 300
      "runtime": "node" | "python",
      "entry": "tools/<name>/handler.js",
      "files": ["lib.js"]               # optional extra handler files, relative to tools/<name>/
    }

The pinned spec stored in workflow state is small (schemas + metadata, never
handler bytes).
"""

import json
import posixpath
import re
from typing import Any, Dict, Iterable, List, Optional, Tuple, TypedDict

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError

from utils.user_tool_models import USER_TOOL_PREFIX

TOOL_NAME_RE = re.compile(r"^[a-z0-9_]{1,48}$")
VIEW_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
VERSION_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
RUNTIMES = ("node", "python")

USER_TOOL_DEFAULT_TIMEOUT_S = 60
USER_TOOL_MAX_TIMEOUT_S = 300
MAX_USER_TOOLS = 32
MAX_TOOL_JSON_BYTES = 32 * 1024
MAX_DESCRIPTION_CHARS = 4000
MAX_HANDLER_FILES = 64
# Total JSON size of all declarations (name+description+input_schema). They are
# passed to call_llm_activity every turn, so this bounds per-turn history growth.
MAX_DECLARATION_TOTAL_BYTES = 24 * 1024

# Handler process limits.
MAX_STDOUT_BYTES = 256 * 1024
STDERR_TAIL_BYTES = 4 * 1024
MAX_HANDLER_FILE_BYTES = 5 * 1024 * 1024
MAX_HANDLER_TOTAL_BYTES = 20 * 1024 * 1024
MAX_INPUT_BYTES = 256 * 1024

SIDE_EFFECTS_UNSUPPORTED = (
    "side_effects tools are not supported in v1: no backend idempotency record exists for "
    "(agent, tool, key) results, so a Temporal retry could repeat the side effect"
)


class UserToolSpecError(ValueError):
    """tool.json violates the contract; the tool is skipped (never declared)."""


class UserToolSpec(TypedDict, total=False):
    name: str  # declared name, user__<source_name>
    source_name: str
    description: str
    input_schema: Dict[str, Any]
    output_schema: Optional[Dict[str, Any]]
    render_view: Optional[str]
    side_effects: bool
    idempotency_key_field: Optional[str]
    timeout_s: int
    runtime: str
    entry: str
    files: List[str]  # manifest-relative paths, sorted, includes entry


class PinnedUserTools(TypedDict, total=False):
    version_id: Optional[str]
    base_url: Optional[str]
    tools: List[UserToolSpec]
    skipped: List[Dict[str, str]]
    disabled_reason: str


def empty_pinned(reason: str = "") -> PinnedUserTools:
    pinned: PinnedUserTools = {"version_id": None, "base_url": None, "tools": [], "skipped": []}
    if reason:
        pinned["disabled_reason"] = reason
    return pinned


def _walk_schema_refs(node: Any) -> bool:
    if isinstance(node, dict):
        if "$ref" in node or "$defs" in node or "definitions" in node:
            return True
        return any(_walk_schema_refs(value) for value in node.values())
    if isinstance(node, list):
        return any(_walk_schema_refs(item) for item in node)
    return False


def _check_schema(schema: Any, label: str, *, require_object: bool) -> Dict[str, Any]:
    if not isinstance(schema, dict):
        raise UserToolSpecError(f"{label} must be a JSON Schema object")
    if require_object and schema.get("type") != "object":
        raise UserToolSpecError(f"{label}.type must be 'object'")
    if _walk_schema_refs(schema):
        raise UserToolSpecError(f"{label} must be self-contained ($ref/$defs are not supported)")
    try:
        Draft202012Validator.check_schema(schema)
    except SchemaError as exc:
        raise UserToolSpecError(f"{label} is not a valid JSON Schema: {exc.message}") from exc
    return schema


def safe_relative_path(path: Any, *, prefix: str) -> str:
    """Normalize a manifest-relative path and require it under ``prefix``."""
    if not isinstance(path, str) or not path or path.startswith("/") or "\\" in path:
        raise UserToolSpecError(f"invalid handler path {path!r}")
    normalized = posixpath.normpath(path)
    if normalized.startswith("../") or normalized == ".." or "/../" in f"/{normalized}/":
        raise UserToolSpecError(f"handler path escapes the tool directory: {path!r}")
    if not normalized.startswith(prefix):
        raise UserToolSpecError(f"handler path {path!r} must be under {prefix}")
    return normalized


def normalize_tool_spec(
    raw: Any,
    *,
    source_name: str,
    manifest_files: Optional[Iterable[str]] = None,
) -> UserToolSpec:
    """Validate a parsed tool.json and return the pinned spec.

    Raises UserToolSpecError for any contract violation (including side effects in v1).
    """
    if not TOOL_NAME_RE.match(source_name or ""):
        raise UserToolSpecError(f"tool name {source_name!r} must match [a-z0-9_]+")
    if not isinstance(raw, dict):
        raise UserToolSpecError("tool.json must be a JSON object")
    if len(json.dumps(raw, default=str)) > MAX_TOOL_JSON_BYTES:
        raise UserToolSpecError(f"tool.json exceeds {MAX_TOOL_JSON_BYTES} bytes")
    if raw.get("name") != source_name:
        raise UserToolSpecError(f"tool.json name {raw.get('name')!r} must equal manifest key {source_name!r}")

    description = raw.get("description")
    if not isinstance(description, str) or not description.strip():
        raise UserToolSpecError("description is required")
    if len(description) > MAX_DESCRIPTION_CHARS:
        raise UserToolSpecError(f"description exceeds {MAX_DESCRIPTION_CHARS} characters")

    input_schema = _check_schema(raw.get("input_schema"), "input_schema", require_object=True)
    if "tool" in (input_schema.get("properties") or {}):
        raise UserToolSpecError("input_schema may not define the reserved property 'tool'")
    output_schema = raw.get("output_schema")
    if output_schema is not None:
        output_schema = _check_schema(output_schema, "output_schema", require_object=False)

    side_effects = raw.get("side_effects")
    if not isinstance(side_effects, bool):
        raise UserToolSpecError("side_effects must be a boolean")
    idempotency_key_field = raw.get("idempotency_key_field")
    if side_effects:
        if not isinstance(idempotency_key_field, str) or not idempotency_key_field:
            raise UserToolSpecError("side_effects tools must declare idempotency_key_field")
        raise UserToolSpecError(SIDE_EFFECTS_UNSUPPORTED)

    timeout_raw = raw.get("timeout_s", USER_TOOL_DEFAULT_TIMEOUT_S)
    if isinstance(timeout_raw, bool) or not isinstance(timeout_raw, (int, float)):
        raise UserToolSpecError("timeout_s must be a number")
    if timeout_raw <= 0 or timeout_raw > USER_TOOL_MAX_TIMEOUT_S:
        raise UserToolSpecError(f"timeout_s must be in (0, {USER_TOOL_MAX_TIMEOUT_S}]")
    timeout_s = max(1, int(timeout_raw))

    runtime = raw.get("runtime")
    if runtime not in RUNTIMES:
        raise UserToolSpecError(f"runtime must be one of {list(RUNTIMES)}")

    prefix = f"tools/{source_name}/"
    entry = safe_relative_path(raw.get("entry"), prefix=prefix)
    files = {entry}
    extra = raw.get("files") or []
    if not isinstance(extra, list):
        raise UserToolSpecError("files must be a list of paths relative to the tool directory")
    for rel in extra:
        files.add(safe_relative_path(posixpath.join(prefix, str(rel)), prefix=prefix))
    for path in manifest_files or []:
        if isinstance(path, str) and path.startswith(prefix):
            files.add(safe_relative_path(path, prefix=prefix))
    if len(files) > MAX_HANDLER_FILES:
        raise UserToolSpecError(f"a tool may ship at most {MAX_HANDLER_FILES} files")

    render = raw.get("render")
    render_view: Optional[str] = None
    if render is not None:
        if not isinstance(render, dict) or not VIEW_NAME_RE.match(str(render.get("view") or "")):
            raise UserToolSpecError("render.view must name an inline view")
        render_view = str(render["view"])

    spec: UserToolSpec = {
        "name": USER_TOOL_PREFIX + source_name,
        "source_name": source_name,
        "description": description.strip(),
        "input_schema": input_schema,
        "output_schema": output_schema,
        "render_view": render_view,
        "side_effects": False,
        "idempotency_key_field": None,
        "timeout_s": timeout_s,
        "runtime": runtime,
        "entry": entry,
        "files": sorted(files),
    }
    return spec


# ── Pure validation / result shaping (used by the run activity) ──


def _first_schema_error(schema: Dict[str, Any], value: Any) -> Optional[str]:
    errors = sorted(Draft202012Validator(schema).iter_errors(value), key=lambda e: list(e.absolute_path))
    if not errors:
        return None
    error = errors[0]
    where = "/".join(str(part) for part in error.absolute_path) or "<root>"
    return f"{where}: {error.message}"


def validate_tool_input(spec: UserToolSpec, tool_input: Any) -> Tuple[Optional[bytes], Optional[str]]:
    """Return ``(stdin_bytes, error)`` for the handler's JSON input."""
    if not isinstance(tool_input, dict):
        return None, "tool input must be a JSON object"
    error = _first_schema_error(spec.get("input_schema") or {}, tool_input)
    if error:
        return None, f"input does not match input_schema: {error}"
    encoded = json.dumps(tool_input, separators=(",", ":"), sort_keys=True).encode("utf-8")
    if len(encoded) > MAX_INPUT_BYTES:
        return None, f"tool input exceeds {MAX_INPUT_BYTES} bytes"
    return encoded, None


def parse_handler_output(spec: UserToolSpec, stdout: bytes) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Parse one JSON object from stdout and validate it against output_schema."""
    if len(stdout) > MAX_STDOUT_BYTES:
        return None, f"handler output exceeds {MAX_STDOUT_BYTES} bytes"
    text = stdout.decode("utf-8", errors="replace").strip()
    if not text:
        return None, "handler wrote no output (expected one JSON object on stdout)"
    try:
        result = json.loads(text)
    except json.JSONDecodeError as exc:
        return None, f"handler output is not valid JSON: {exc.msg} at char {exc.pos}"
    if not isinstance(result, dict):
        return None, "handler output must be a single JSON object"
    output_schema = spec.get("output_schema")
    if isinstance(output_schema, dict):
        error = _first_schema_error(output_schema, result)
        if error:
            return None, f"output does not match output_schema: {error}"
    return result, None


def build_inline_view(
    spec: UserToolSpec, version_id: Optional[str], result: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    """``metadata.inlineView`` for a successful result (same shape as send_message_to_user)."""
    view = spec.get("render_view")
    if not view or not version_id:
        return None
    return {"view": view, "versionId": version_id, "props": result}


def tail_text(data: bytes, limit: int) -> str:
    return data[-limit:].decode("utf-8", errors="replace").strip()
