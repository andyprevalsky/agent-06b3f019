"""User tools domain types - tool.json contract and pinned-spec normalization.

``tool.json`` (authored by the user's code agent under ``tools/<name>/``)::

    {
      "name": "<name>",                 # must match the manifest key, [a-z0-9_]+
      "description": "...",
      "input_schema": {...},            # JSON Schema object (no $ref)
      "output_schema": {...},           # optional JSON Schema for the handler result
      "render": {"view": "<inline key>"},   # optional inline view for the result
      "side_effects": false,            # true: the handler runs at most once per tool call
      "idempotency_key_field": "...",   # optional, side_effects only: input field Rose fills
                                        # with the call's idempotency key
      "timeout_s": 60,                  # default 60, max 300
      "runtime": "node" | "python",
      "entry": "tools/<name>/handler.js",
      "files": ["lib.js"]               # optional extra handler files, relative to tools/<name>/
    }

The pinned spec stored in workflow state is small (schemas + metadata, never
handler bytes).

Side-effecting tools (``side_effects: true``, CLAUDE.md rule 20): a call's
idempotency key is ``user_tool_call_key(root workflow id, tool call id)``. The
handler gets it as ``ROSE_IDEMPOTENCY_KEY`` (and in its input under
``idempotency_key_field`` when declared) to pass to downstream APIs. The run
activity claims the key in the backend's ToolSideEffect record before the
handler starts and stores the handler's run record before returning, so a
Temporal retry or a concurrent duplicate replays that record instead of running
the handler again. ``shape_handler_run`` turns a run record into the tool
outcome identically for a fresh run and a replay.
"""

import base64
import hashlib
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
IDEMPOTENCY_KEY_RE = re.compile(r"^[0-9a-f]{64}$")
INPUT_FIELD_RE = re.compile(r"^[a-z_][a-z0-9_]{0,63}$")
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

# Environment variable carrying a side-effecting call's idempotency key.
IDEMPOTENCY_KEY_ENV = "ROSE_IDEMPOTENCY_KEY"


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


def _side_effect_fields(raw: Dict[str, Any], input_schema: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
    side_effects = raw.get("side_effects")
    if not isinstance(side_effects, bool):
        raise UserToolSpecError("side_effects must be a boolean")
    field = raw.get("idempotency_key_field")
    if field is None:
        return side_effects, None
    if not side_effects:
        raise UserToolSpecError("idempotency_key_field is only valid with side_effects: true")
    if not isinstance(field, str) or not INPUT_FIELD_RE.match(field):
        raise UserToolSpecError("idempotency_key_field must match [a-z_][a-z0-9_]* (max 64 chars)")
    if field in (input_schema.get("properties") or {}) or field == "tool":
        raise UserToolSpecError(
            "idempotency_key_field must not be an input_schema property: Rose fills it, never the agent"
        )
    return side_effects, field


def _timeout_seconds(raw: Dict[str, Any]) -> int:
    timeout_raw = raw.get("timeout_s", USER_TOOL_DEFAULT_TIMEOUT_S)
    if isinstance(timeout_raw, bool) or not isinstance(timeout_raw, (int, float)):
        raise UserToolSpecError("timeout_s must be a number")
    if timeout_raw <= 0 or timeout_raw > USER_TOOL_MAX_TIMEOUT_S:
        raise UserToolSpecError(f"timeout_s must be in (0, {USER_TOOL_MAX_TIMEOUT_S}]")
    return max(1, int(timeout_raw))


def _handler_files(
    raw: Dict[str, Any], source_name: str, manifest_files: Optional[Iterable[str]]
) -> Tuple[str, List[str]]:
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
    return entry, sorted(files)


def normalize_tool_spec(
    raw: Any,
    *,
    source_name: str,
    manifest_files: Optional[Iterable[str]] = None,
) -> UserToolSpec:
    """Validate a parsed tool.json and return the pinned spec.

    Raises UserToolSpecError for any contract violation.
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

    side_effects, idempotency_key_field = _side_effect_fields(raw, input_schema)
    timeout_s = _timeout_seconds(raw)
    runtime = raw.get("runtime")
    if runtime not in RUNTIMES:
        raise UserToolSpecError(f"runtime must be one of {list(RUNTIMES)}")
    entry, files = _handler_files(raw, source_name, manifest_files)

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
        "side_effects": side_effects,
        "idempotency_key_field": idempotency_key_field,
        "timeout_s": timeout_s,
        "runtime": runtime,
        "entry": entry,
        "files": files,
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


def user_tool_call_key(root_workflow_id: str, tool_call_id: str) -> str:
    """Idempotency key of one user-tool call; stable across Temporal retries and replays."""
    return hashlib.sha256(f"user_tool\0{root_workflow_id}\0{tool_call_id}".encode("utf-8")).hexdigest()


def validate_tool_input(
    spec: UserToolSpec, tool_input: Any, idempotency_key: Optional[str] = None
) -> Tuple[Optional[bytes], Optional[str]]:
    """Return ``(stdin_bytes, error)`` for the handler's JSON input.

    The idempotency key is added under ``idempotency_key_field`` after
    validation: the agent never supplies it, so it is not in input_schema.
    """
    if not isinstance(tool_input, dict):
        return None, "tool input must be a JSON object"
    error = _first_schema_error(spec.get("input_schema") or {}, tool_input)
    if error:
        return None, f"input does not match input_schema: {error}"
    payload = dict(tool_input)
    field = spec.get("idempotency_key_field")
    if field and idempotency_key:
        payload[field] = idempotency_key
    encoded = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
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


# ── Handler run records: one shape for every executor, stored for side effects ──


class HandlerRun(TypedDict, total=False):
    """What one handler process did. JSON-safe; the stored side-effect record."""

    returncode: Optional[int]
    stdout_b64: str  # empty on overflow (the bytes are dropped)
    stderr_tail: str
    timed_out: bool
    overflow: bool
    executor: str
    code_session_id: Optional[str]


def handler_run_record(
    *,
    returncode: Optional[int],
    stdout: bytes,
    stderr_tail: str,
    timed_out: bool,
    overflow: bool,
    executor: str,
    code_session_id: Optional[str] = None,
) -> HandlerRun:
    overflow = bool(overflow) or len(stdout) > MAX_STDOUT_BYTES
    return {
        "returncode": returncode,
        "stdout_b64": "" if overflow else base64.b64encode(stdout).decode("ascii"),
        "stderr_tail": stderr_tail[-STDERR_TAIL_BYTES:],
        "timed_out": bool(timed_out),
        "overflow": overflow,
        "executor": executor,
        "code_session_id": code_session_id,
    }


def outcome_error(kind: str, message: str, **extra: Any) -> Dict[str, Any]:
    return {"ok": False, "error_kind": kind, "error": message, **extra}


def shape_handler_run(spec: UserToolSpec, version_id: Optional[str], run: Any) -> Dict[str, Any]:
    """The tool outcome for a run record (pure: a replayed record gives the same outcome)."""
    if not isinstance(run, dict):
        return outcome_error("executor", "handler run record is malformed")
    timeout_s = int(spec.get("timeout_s") or USER_TOOL_DEFAULT_TIMEOUT_S)
    stderr_tail = str(run.get("stderr_tail") or "")[-STDERR_TAIL_BYTES:]
    if run.get("timed_out"):
        return outcome_error("timeout", f"handler timed out after {timeout_s}s", stderr_tail=stderr_tail)
    if run.get("overflow"):
        return outcome_error("output_too_large", f"handler output exceeds {MAX_STDOUT_BYTES} bytes")
    returncode = run.get("returncode")
    if returncode != 0:
        message = f"handler exited with code {returncode}"
        if stderr_tail:
            message += f": {stderr_tail}"
        return outcome_error("exit", message, stderr_tail=stderr_tail)
    try:
        stdout = base64.b64decode(str(run.get("stdout_b64") or ""), validate=True)
    except ValueError:
        return outcome_error("executor", "handler run record has an invalid stdout encoding")
    result, output_error = parse_handler_output(spec, stdout)
    if output_error or result is None:
        return outcome_error("output", output_error or "invalid output")
    return {
        "ok": True,
        "result": result,
        "inline_view": build_inline_view(spec, version_id, result),
        "output_bytes": len(stdout),
    }
