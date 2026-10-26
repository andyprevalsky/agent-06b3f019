#!/usr/bin/env python3
"""Extract every prompt in catalog.json + 1-month-ago version + best matches → data.json.

Robust to slight catalog drift: each entry has a stable `anchor` (regex-able
substring or function/var name); we locate it with grep first, then walk
forward to capture the prompt body. Line ranges are NOT trusted.

Run:
    python3 prompt-review/build.py

Output:
    prompt-review/data.json    (consumed by server.py)
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from collections import Counter
from copy import deepcopy
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "prompt-review" / "catalog.json"
DATA_OUT = ROOT / "prompt-review" / "data.json"
EXTRACTS_DIR = ROOT / "prompt-review" / "extracts"
CLAUDE_TOOL_SCHEMAS = ROOT / "prompt-review" / "rendered" / "claude-code-src" / "claude_tool_schemas.json"

# How far back to fetch the historical version (git --before).
HISTORY_BEFORE = "1 month ago"

# Cap snippet length so we don't ship 50k-token blobs to the browser.
# Some prompts (claude_tool_agent, openclaw_buildAgentSystemPrompt) are big.
MAX_SNIPPET_CHARS = 30_000

RUNTIME_VISIBLE_CATEGORIES = {
    "system_prompt",
    "tool_description",
    "tool_param_description",
}


def sh(args: list[str], cwd: Path | None = None) -> str:
    """Run a shell command, return stdout (empty on failure)."""
    try:
        out = subprocess.run(
            args,
            cwd=cwd or ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=15,
        )
        if out.returncode != 0:
            return ""
        return out.stdout
    except Exception:
        return ""


_FUNC_ANCHOR_RX = re.compile(r"^\s*(?:async\s+)?(?:def|function)\s+\w+|^\s*(?:export\s+)?function\s+\w+")


def find_block(text: str, anchor: str | None, language: str) -> tuple[str, bool]:
    """Locate `anchor` in `text` and return (block, found).

    `found` is False when the anchor wasn't found at all (caller should warn).

    Two extraction modes, picked from the anchor shape:

    1. **function-anchor** (`def foo`, `function foo`) — capture the full
       function body. Stop only on a column-0 dedent (next top-level symbol).
       Triple-quoted docstrings inside the body do NOT terminate.

    2. **variable-anchor** (`FOO = `, `BAR_SCHEMA = {`) — capture the assigned
       value. Stop on the first balanced close of the value's enclosing
       string / dict literal.
    """
    if anchor is None:
        return text[:MAX_SNIPPET_CHARS], True

    idx = text.find(anchor)
    if idx == -1:
        return f"[anchor `{anchor}` not found in file]", False

    line_start = text.rfind("\n", 0, idx) + 1
    lines = text[line_start:].splitlines(keepends=True)

    is_func_anchor = bool(_FUNC_ANCHOR_RX.match(anchor))

    out: list[str] = []
    in_triple = False        # python triple-quoted string state
    triple_opened_then_closed = False
    in_backtick = False      # js template literal state
    backtick_opened_then_closed = False
    depth = 0                # ()[]{}
    depth_ever_opened = False
    accumulated_chars = 0

    # In function-anchor mode, ANY non-indented non-empty line ends the
    # function (including comments and the next def). Multi-line `def`
    # signatures have their continuation lines indented or starting with `)`,
    # so this is safe.
    def is_function_end(line: str) -> bool:
        if not line or not line.strip():
            return False
        if line[0] in (" ", "\t"):
            return False
        # multi-line def signature continuation: `)` or `) -> X:` at column 0
        if line.lstrip().startswith((")", "]", "}")):
            return False
        return True

    # In variable-anchor mode, only "real" new symbols terminate.
    new_var_rx = re.compile(r"^[A-Z_][A-Z0-9_]*\s*[:=]|^[a-z_][a-zA-Z0-9_]*\s*=\s*\{")
    new_top_level_starters = (
        "def ", "class ", "async def ", "@", "export ", "function ", "const ", "let ", "var ",
    )
    def is_new_var_anchor_top_level(line: str) -> bool:
        if not line or line[0] in (" ", "\t", "\n") or not line.strip():
            return False
        s = line.lstrip()
        return s.startswith(new_top_level_starters) or bool(new_var_rx.match(s))

    for i, line in enumerate(lines):
        # ----- pre-line termination check (uses pre-line state) -----
        if i > 0 and not in_triple and not in_backtick and depth <= 0:
            if is_func_anchor:
                if is_function_end(line):
                    break
            else:
                if is_new_var_anchor_top_level(line):
                    break

        # ----- incorporate line into state -----
        for triple in ('"""', "'''"):
            count = line.count(triple)
            for _ in range(count):
                in_triple = not in_triple
                if not in_triple and i > 0:
                    triple_opened_then_closed = True
        net_bt = line.count("`") - line.count("\\`")
        for _ in range(net_bt):
            in_backtick = not in_backtick
            if not in_backtick and i > 0:
                backtick_opened_then_closed = True
        if not in_triple and not in_backtick:
            for ch in line:
                if ch in "([{":
                    depth += 1
                    depth_ever_opened = True
                elif ch in ")]}":
                    depth -= 1

        out.append(line)
        accumulated_chars += len(line)

        # ----- post-line terminations (variable-anchor only) -----
        if not is_func_anchor and i > 0:
            # A: triple-string fully closed.
            if triple_opened_then_closed and not in_triple and depth <= 0:
                break
            # B: template literal fully closed.
            if backtick_opened_then_closed and not in_backtick and depth <= 0:
                break
            # C: dict/object literal closed (we did open one).
            if depth_ever_opened and depth <= 0 and not in_triple and not in_backtick:
                if line.rstrip().endswith(("}", "})", "});", "},")):
                    break

        # E: hard cap.
        if accumulated_chars > MAX_SNIPPET_CHARS:
            out.append("\n...[truncated]\n")
            break

    return "".join(out)[:MAX_SNIPPET_CHARS], True


RENDERED_DIR = ROOT / "prompt-review" / "rendered"


def strip_literal_syntax(text: str) -> str:
    # Strip Python/TS literal-assignment wrappers from extracted source.
    # Used on source-extracted (and historical) text so the user sees the
    # runtime prompt content rather than the language-level container. The
    # rendered/<id>.txt files don't go through this — they're already clean.
    #
    # Examples it cleans up:
    #   PROMPT = (triple-double-quote)...(triple-double-quote)  → ...
    #   let prompt = `...`                                       → ...
    #   export const X = `...`                                   → ...
    #   f"""..."""                                               → ...
    # Idempotent. If no recognizable wrapper, returns the text unchanged.
    s = text.strip()

    # We only strip the simple variable-assignment + literal pattern. Function
    # bodies are too varied to handle statically (multi-branch returns, dedent
    # wrappers, conditional concats) — historical views will show function
    # source as-is, with the `def` keyword serving as a visual cue.
    prev = None
    for _ in range(4):
        if s == prev:
            break
        prev = s

        # Drop a leading assignment header.
        s = re.sub(
            r"^\s*(?:export\s+)?(?:const|let|var)?\s*"
            r"[A-Za-z_][A-Za-z_0-9]*"
            r"(?:\s*:\s*[^=]+?)?"
            r"\s*=\s*",
            "",
            s,
            count=1,
        )

        # Drop a Python string prefix (f, r, b, fr, rb, etc.) immediately before
        # the opening quote.
        s = re.sub(r"^[rRbBfFuU]{1,2}(?=[\"'`])", "", s)

        # Strip the matching open/close quote pair if present.
        for opener in ('"""', "'''", "`", '"', "'"):
            if s.startswith(opener):
                # Allow trailing punctuation like `;` `,` `)` after closer.
                trimmed = s.rstrip(" \t\n;,)")
                if trimmed.endswith(opener) and len(trimmed) >= 2 * len(opener):
                    s = trimmed[len(opener):-len(opener)]
                break  # only one outer quote pair per pass

        s = s.strip()

    return s.strip("\n")


def try_parse_json_object(text: str) -> dict | None:
    s = (text or "").strip()
    if not (s.startswith("{") and s.endswith("}")):
        return None
    try:
        obj = json.loads(s)
        return obj if isinstance(obj, dict) else None
    except Exception:
        # Recover a common renderer artifact: literal newlines inside quoted strings.
        recovered: list[str] = []
        in_str = False
        escape = False
        for ch in s:
            if escape:
                recovered.append(ch)
                escape = False
                continue
            if ch == "\\":
                recovered.append(ch)
                escape = True
                continue
            if ch == "\"":
                in_str = not in_str
                recovered.append(ch)
                continue
            if in_str and ch == "\n":
                recovered.append("\\n")
                continue
            if in_str and ch == "\r":
                recovered.append("\\r")
                continue
            recovered.append(ch)
        try:
            obj = json.loads("".join(recovered))
            return obj if isinstance(obj, dict) else None
        except Exception:
            return None


def extract_first_json_object(text: str) -> tuple[dict | None, str, str]:
    s = text or ""
    n = len(s)
    for start in range(n):
        if s[start] != "{":
            continue
        depth = 0
        in_str = False
        escape = False
        for i in range(start, n):
            ch = s[i]
            if escape:
                escape = False
                continue
            if ch == "\\":
                escape = True
                continue
            if ch == "\"":
                in_str = not in_str
                continue
            if in_str:
                continue
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    chunk = s[start : i + 1]
                    obj = try_parse_json_object(chunk)
                    if obj is not None:
                        prefix = s[:start].strip()
                        suffix = s[i + 1 :].strip()
                        return obj, prefix, suffix
                    break
    return None, "", ""


def schema_type(schema: dict) -> str:
    if "$ref" in schema:
        return str(schema["$ref"]).rsplit("/", 1)[-1]
    if "const" in schema:
        return f"const {schema['const']!r}"
    if isinstance(schema.get("anyOf"), list):
        parts = [schema_type(item) for item in schema["anyOf"] if isinstance(item, dict)]
        return " | ".join(dict.fromkeys(parts)) or "any"
    if isinstance(schema.get("oneOf"), list):
        parts = [schema_type(item) for item in schema["oneOf"] if isinstance(item, dict)]
        return " | ".join(dict.fromkeys(parts)) or "any"
    t = schema.get("type")
    if isinstance(t, list):
        return " | ".join(str(x) for x in t)
    if isinstance(t, str):
        return t
    if isinstance(schema.get("enum"), list) and schema["enum"]:
        return "enum"
    if isinstance(schema.get("properties"), dict):
        return "object"
    if isinstance(schema.get("additionalProperties"), dict):
        return f"object<string, {schema_type(schema['additionalProperties'])}>"
    if schema.get("items") is not None:
        return "array"
    return "any"


def normalize_prompt_text(s: object) -> str:
    return str(s or "").replace("\\n", "\n").strip()


def compact_prompt_text(s: object) -> str:
    return re.sub(r"\s+", " ", normalize_prompt_text(s)).strip()


def unwrap_tool_schema_object(obj: dict) -> dict:
    fn = obj.get("function")
    if isinstance(fn, dict) and any(k in fn for k in ("name", "description", "parameters")):
        return fn
    return obj


def collect_schema_args(schema: dict, prefix: str = "") -> list[dict]:
    props = schema.get("properties")
    if not isinstance(props, dict):
        return []
    required = set(schema.get("required") or [])
    out: list[dict] = []
    for name, raw_def in props.items():
        item = raw_def if isinstance(raw_def, dict) else {}
        path = f"{prefix}.{name}" if prefix else name
        out.append(
            {
                "name": path,
                "required": name in required,
                "type": schema_type(item),
                "description": normalize_prompt_text(item.get("description", "")),
                "enum_values": item.get("enum") if isinstance(item.get("enum"), list) else [],
                "default_value": item.get("default"),
                "minimum": item.get("minimum"),
                "maximum": item.get("maximum"),
            }
        )
        if isinstance(item.get("properties"), dict):
            out.extend(collect_schema_args(item, path))
        elif isinstance(item.get("items"), dict) and isinstance(item["items"].get("properties"), dict):
            out.extend(collect_schema_args(item["items"], f"{path}[]"))
    return out


def format_tool_schema_prompt(obj: dict, guidance: str = "") -> str:
    obj = unwrap_tool_schema_object(obj)
    name = str(obj.get("name", "")).strip()
    description = normalize_prompt_text(obj.get("description", ""))
    params = obj.get("parameters") if isinstance(obj.get("parameters"), dict) else {}
    args = collect_schema_args(params)
    required_top = params.get("required") if isinstance(params.get("required"), list) else []

    lines: list[str] = ["## Tool Prompt", ""]
    if name:
        lines.extend(["### Name", f"`{name}`", ""])
    lines.extend(["### Description", description or "_No description provided._", "", "## Args"])
    if not args:
        lines.append("_No arguments defined._")
    else:
        if required_top:
            lines.append("Required: " + ", ".join(f"`{x}`" for x in required_top))
            lines.append("")
        for arg in args:
            constraints: list[str] = []
            if arg["enum_values"]:
                constraints.append(
                    "allowed: " + ", ".join(f"`{v}`" for v in arg["enum_values"])
                )
            if arg["default_value"] is not None:
                constraints.append(f"default: `{arg['default_value']}`")
            if isinstance(arg["minimum"], (int, float)):
                constraints.append(f"min: `{arg['minimum']}`")
            if isinstance(arg["maximum"], (int, float)):
                constraints.append(f"max: `{arg['maximum']}`")
            suffix = f" {'; '.join(constraints)}." if constraints else ""
            description_text = compact_prompt_text(arg["description"]) or "No description provided."
            lines.append(
                f"- `{arg['name']}` (`{arg['type']}`, {'required' if arg['required'] else 'optional'}): "
                f"{description_text}{suffix}"
            )
    if guidance:
        lines.extend(["", "## Guidance", guidance.strip()])
    return "\n".join(lines).strip()


def _inline_schema_refs(schema: dict[str, Any]) -> dict[str, Any]:
    """Return a copy of a JSON schema with local $defs/$ref entries inlined."""
    root = deepcopy(schema)
    defs = root.pop("$defs", {})

    def visit(value: Any) -> Any:
        if isinstance(value, list):
            return [visit(item) for item in value]
        if not isinstance(value, dict):
            return value
        ref = value.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/$defs/"):
            name = ref.rsplit("/", 1)[-1]
            resolved = deepcopy(defs.get(name, {}))
            merged = {**resolved, **{k: v for k, v in value.items() if k != "$ref"}}
            return visit(merged)
        return {k: visit(v) for k, v in value.items()}

    return visit(root)


def _without_tool_discriminator(schema: dict[str, Any]) -> dict[str, Any]:
    """Pydantic models include `tool` as an internal discriminator; hide it in review args."""
    out = deepcopy(schema)
    props = out.get("properties")
    if isinstance(props, dict):
        props.pop("tool", None)
    required = out.get("required")
    if isinstance(required, list):
        out["required"] = [item for item in required if item != "tool"]
    return out


def _tool_model_schema(tool_name: str) -> dict[str, Any] | None:
    try:
        agents_path = str(ROOT / "agents")
        if agents_path not in sys.path:
            sys.path.insert(0, agents_path)
        from utils.tool_schemas import TOOL_MODELS  # type: ignore
    except Exception:
        return None

    model = TOOL_MODELS.get(tool_name)
    if model is None:
        return None
    return _without_tool_discriminator(_inline_schema_refs(model.model_json_schema()))


def _schema_with_fields(base_schema: dict[str, Any], fields: list[str], required: list[str]) -> dict[str, Any]:
    props = base_schema.get("properties") if isinstance(base_schema.get("properties"), dict) else {}
    return {
        "type": "object",
        "properties": {name: deepcopy(props[name]) for name in fields if name in props},
        "required": [name for name in required if name in props],
        "additionalProperties": False,
    }


def _manual_tool_parameters(tool_name: str) -> dict[str, Any] | None:
    if tool_name == "reasoning":
        return {
            "type": "object",
            "properties": {
                "goal": {
                    "type": "string",
                    "description": "Self-contained reasoning or synthesis task to perform using prior tool results.",
                }
            },
            "required": ["goal"],
            "additionalProperties": False,
        }
    return None


CLAUDE_TOOL_ID_TO_NAME = {
    "claude_tool_agent": "Agent",
    "claude_tool_bash": "Bash",
    "claude_tool_edit": "Edit",
    "claude_tool_glob": "Glob",
    "claude_tool_grep": "Grep",
    "claude_tool_read": "Read",
    "claude_tool_skill": "Skill",
    "claude_tool_write": "Write",
}


def _claude_tool_schema(prompt_id: str | None) -> tuple[str, dict[str, Any]] | None:
    if not prompt_id:
        return None
    tool_name = CLAUDE_TOOL_ID_TO_NAME.get(prompt_id)
    if not tool_name:
        return None

    candidates = [CLAUDE_TOOL_SCHEMAS, ROOT / ".context" / "claude-request.json"]
    for path in candidates:
        if not path.exists():
            continue
        try:
            payload = json.loads(path.read_text())
        except Exception:
            continue

        if path.name == "claude-request.json":
            tools = payload.get("tools")
            if not isinstance(tools, list):
                continue
            for tool in tools:
                if (
                    isinstance(tool, dict)
                    and tool.get("name") == tool_name
                    and isinstance(tool.get("input_schema"), dict)
                ):
                    return tool_name, tool["input_schema"]
            continue

        tool = payload.get(tool_name)
        if isinstance(tool, dict) and isinstance(tool.get("parameters"), dict):
            return tool_name, tool["parameters"]
    return None


TOOL_ID_TO_NAME = {
    "tool_attempt_completion": "attempt_completion",
    "tool_call_phone_number": "call_phone_number",
    "tool_grep": "grep",
    "tool_message_person": "message_person",
    "tool_reasoning": "reasoning",
    "tool_send_message_to_user": "send_message_to_user",
    "tool_send_message_to_user_execute": "send_message_to_user_execute_phase",
    "tool_set_plan": "set_plan",
    "tool_spawn_agent": "spawn_agent",
    "tool_spawn_browser_agent": "spawn_browser_agent",
    "tool_spawn_code_agent": "spawn_code_agent",
    "tool_spawn_explore_agent": "spawn_explore_agent",
    "tool_spawn_sub_agent": "spawn_sub_agent",
    "tool_spawn_sub_agent_for_each": "spawn_sub_agent_for_each",
    "tool_wait_for": "wait_for",
    "tool_web_fetch": "web_fetch",
    "tool_web_search": "web_search",
}


SPAWN_ALIAS_FIELDS = {
    "spawn_explore_agent": {
        "fields": ["goal", "attachments", "context_gates"],
        "required": ["goal"],
    },
    "spawn_browser_agent": {
        "fields": ["goal", "start_url", "output_schema", "attachments", "context_gates"],
        "required": ["goal", "start_url", "output_schema"],
    },
    "spawn_code_agent": {
        "fields": ["goal", "output_schema", "attachments", "github_repo_link", "context_gates"],
        "required": ["goal", "output_schema"],
    },
    "spawn_sub_agent": {
        "fields": ["goal", "output_schema", "attachments", "read_only", "verifier", "start_phase", "context_gates"],
        "required": ["goal", "output_schema", "start_phase"],
    },
    "spawn_sub_agent_for_each": {
        "fields": [
            "goal",
            "output_schema",
            "attachments",
            "read_only",
            "verifier",
            "start_phase",
            "items",
            "items_csv",
            "context_gates",
        ],
        "required": ["goal", "output_schema", "start_phase"],
    },
}


def tool_parameters_for_prompt(prompt_id: str | None) -> tuple[str, dict[str, Any]] | None:
    if not prompt_id:
        return None

    claude = _claude_tool_schema(prompt_id)
    if claude is not None:
        return claude

    tool_name = TOOL_ID_TO_NAME.get(prompt_id)
    if not tool_name:
        return None

    manual = _manual_tool_parameters(tool_name)
    if manual is not None:
        return tool_name, manual

    if tool_name in SPAWN_ALIAS_FIELDS:
        spawn_schema = _tool_model_schema("spawn_agent")
        if not spawn_schema:
            return None
        spec = SPAWN_ALIAS_FIELDS[tool_name]
        return tool_name, _schema_with_fields(spawn_schema, spec["fields"], spec["required"])

    schema = _tool_model_schema(tool_name)
    if not schema:
        return None
    return tool_name, schema


def format_prompt_by_type(text: str, category: str, prompt_id: str | None = None) -> str:
    raw = (text or "").strip()
    if not raw:
        return ""

    if category in {"tool_description", "tool_param_description"}:
        parsed = try_parse_json_object(raw)
        prefix = suffix = ""
        if parsed is None:
            parsed, prefix, suffix = extract_first_json_object(raw)
        if parsed and any(k in unwrap_tool_schema_object(parsed) for k in ("name", "description", "parameters")):
            guidance = "\n\n".join(x for x in (prefix, suffix) if x).strip()
            return format_tool_schema_prompt(parsed, guidance)

        params = tool_parameters_for_prompt(prompt_id)
        if params:
            tool_name, parameters = params
            return format_tool_schema_prompt(
                {
                    "name": tool_name,
                    "description": raw,
                    "parameters": parameters,
                }
            )

        parts = [p.strip() for p in re.split(r"\n\s*\n", raw) if p.strip()]
        desc = parts[0] if parts else raw
        rest = "\n\n".join(parts[1:]).strip()
        lines = [
            "## Tool Prompt",
            "",
            "### Description",
            desc or "_No description provided._",
            "",
            "## Args",
            "_No explicit arguments defined._",
        ]
        if rest:
            lines.extend(["", "## Guidance", rest])
        return "\n".join(lines)

    if category == "system_prompt":
        return f"## System Prompt\n\n{raw}"
    if category == "instruction_block":
        return f"## Instruction Block\n\n{raw}"
    if category == "template":
        return f"## Template\n\n{raw}"
    return f"## Prompt\n\n{raw}"


def extract(repo_name: str, repo_path: Path, entry: dict, problems: list[str]) -> dict:
    """Extract prompt text + metadata for one catalog entry.

    Prefers `prompt-review/rendered/<repo>/<id>.txt` (the runtime-rendered
    version produced by render_*.py) over source extraction. Falls back to
    in-source `find_block` when no rendered file exists, so the tool stays
    usable even if a render hasn't been produced yet.
    """
    rel = entry["path"]
    abs_path = repo_path / rel
    out = {
        "id": entry["id"],
        "path": rel,
        "category": entry["category"],
        "summary": entry["summary"],
        "keywords": entry.get("keywords", []),
        "anchor": entry.get("anchor"),
        "exists": abs_path.exists(),
        "text": "",
        "formatted_text": "",
        "char_count": 0,
        "anchor_found": True,
        "source": "rendered",  # one of: rendered, source, missing
    }

    rendered_path = RENDERED_DIR / repo_name / f"{entry['id']}.txt"
    if rendered_path.exists():
        try:
            text = rendered_path.read_text(encoding="utf-8", errors="replace")
            out["text"] = text
            out["formatted_text"] = format_prompt_by_type(text, entry["category"], entry.get("id"))
            out["char_count"] = len(text)
            out["source"] = "rendered"
            return out
        except Exception as e:
            problems.append(f"  ⚠ {entry['id']}: rendered file read error ({e}); falling back to source")

    # ---- fallback: extract from source ----
    out["source"] = "source"
    if not abs_path.exists():
        out["text"] = f"[file not found: {rel}]"
        out["formatted_text"] = format_prompt_by_type(out["text"], entry["category"], entry.get("id"))
        out["anchor_found"] = False
        out["source"] = "missing"
        problems.append(f"  ✗ {entry['id']}: file not found ({rel})")
        return out

    try:
        raw = abs_path.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        out["text"] = f"[read error: {e}]"
        out["formatted_text"] = format_prompt_by_type(out["text"], entry["category"], entry.get("id"))
        out["anchor_found"] = False
        out["source"] = "missing"
        problems.append(f"  ✗ {entry['id']}: read error ({e})")
        return out

    lang = abs_path.suffix.lower()
    snippet, found = find_block(raw, entry.get("anchor"), lang)
    if found:
        snippet = strip_literal_syntax(snippet)
    out["text"] = snippet
    out["formatted_text"] = format_prompt_by_type(snippet, entry["category"], entry.get("id"))
    out["char_count"] = len(snippet)
    out["anchor_found"] = found
    if not found:
        problems.append(f"  ✗ {entry['id']}: anchor `{entry.get('anchor')}` not found in {rel}")
    elif snippet.endswith("\n...[truncated]\n"):
        problems.append(f"  ⚠ {entry['id']}: hit char cap ({MAX_SNIPPET_CHARS}) — prompt may be incomplete")
    return out


def fetch_historical(rel_path: str, anchor: str | None) -> tuple[str, str]:
    """Return (text, label) for the historical version.

    Strategy:
      1. If a commit ≤HISTORY_BEFORE touched this file: use that.
      2. Else: use the file's first-ever commit (so brand-new prompts still
         show *some* historical context vs. the current version).
      3. Else: report no history.

    `label` describes what we returned (date, "first commit", or "new").
    """
    # 1. most recent commit before cutoff that touched the file
    rev = sh([
        "git", "rev-list", "-1", f"--before={HISTORY_BEFORE}", "HEAD", "--", rel_path
    ]).strip()
    label_prefix = f"~{HISTORY_BEFORE}"
    fell_back = False

    # Verify the blob at that rev actually contains the anchor — if the prompt
    # was renamed/moved, the file may exist but the variable doesn't.
    if rev and anchor:
        check = sh(["git", "show", f"{rev}:{rel_path}"])
        if anchor not in check:
            rev = ""  # force fallback

    # 2. fall back: find oldest commit where this anchor exists in the file.
    if not rev and anchor:
        # `git log -S<anchor> --reverse` lists commits that added/removed
        # the literal string, oldest-first. The first one is the introduction.
        revs = sh([
            "git", "log", "-S", anchor, "--reverse", "--format=%H", "--", rel_path
        ]).strip().splitlines()
        # Skip until we find a rev where the blob CONTAINS the anchor (not a
        # removal). The introducing commit will be the first.
        for r in revs:
            blob = sh(["git", "show", f"{r}:{rel_path}"])
            if blob and anchor in blob:
                rev = r
                fell_back = True
                label_prefix = "introduced at"
                break

    # 3. final fall back: file's first-ever commit (anchor may not be there)
    if not rev:
        first_revs = sh([
            "git", "log", "--format=%H", "--diff-filter=A", "--follow", "--", rel_path
        ]).strip().splitlines()
        if first_revs:
            rev = first_revs[-1]
            fell_back = True
            label_prefix = "file added"

    if not rev:
        return "[no git history found for this file]", "no history"

    date = sh(["git", "show", "-s", "--format=%cs", rev]).strip()
    short = rev[:8]
    label = f"{label_prefix} · {date} ({short})" if date else f"{label_prefix} ({short})"
    if fell_back:
        label += " · NEW SINCE CUTOFF"

    blob = sh(["git", "show", f"{rev}:{rel_path}"])
    if not blob:
        return f"[file did not exist at {short}]", label
    text, _ = find_block(blob, anchor, Path(rel_path).suffix.lower())
    return strip_literal_syntax(text), label


# --- matching ----------------------------------------------------------------


def tokenize(s: str) -> list[str]:
    """Lowercase keyword tokens — split on non-alpha, drop short/common."""
    stop = {
        "the", "a", "an", "and", "or", "if", "of", "to", "in", "is", "it",
        "for", "on", "as", "with", "be", "by", "at", "this", "that", "are",
        "use", "get", "set", "tool", "from", "via",
    }
    toks = re.split(r"[^a-z0-9]+", s.lower())
    return [t for t in toks if len(t) > 2 and t not in stop]


def signature(entry: dict) -> Counter[str]:
    """Bag-of-words signature for matching."""
    bag: list[str] = []
    bag.extend(entry.get("keywords", []))
    bag.extend(tokenize(entry["id"]))
    bag.extend(tokenize(entry["summary"]))
    bag.extend(tokenize(Path(entry["path"]).stem))
    bag.append(entry["category"])
    return Counter(bag)


def overlap(a: Counter[str], b: Counter[str]) -> float:
    """Cosine-ish overlap on token bags. 0..1."""
    if not a or not b:
        return 0.0
    common = sum((a & b).values())
    if common == 0:
        return 0.0
    denom = (sum(a.values()) * sum(b.values())) ** 0.5
    return common / denom


def best_match(ours_entry: dict, candidates: list[dict]) -> tuple[dict | None, float]:
    """Return (best_entry, score)."""
    if not candidates:
        return None, 0.0
    sig_ours = signature(ours_entry)
    scored = [(overlap(sig_ours, signature(c)), c) for c in candidates]
    scored.sort(key=lambda x: x[0], reverse=True)
    return scored[0][1], scored[0][0]


# --- main --------------------------------------------------------------------


# Score below this counts as a "weak" match (teal flag in UI).
WEAK_THRESHOLD = 0.20


def main() -> int:
    catalog = json.loads(CATALOG.read_text())
    repos = {
        "ours": ROOT,
        "claude-code-src": ROOT,
        "openclaw": ROOT,
        "hermes-agent": ROOT,
        "codex": ROOT,
        "prime-agent": ROOT,
        "kimi-code": ROOT,
    }

    EXTRACTS_DIR.mkdir(exist_ok=True)
    problems: list[str] = []

    # Pre-extract reference repos so we can score against them.
    print(f"[build] extracting reference prompts...", file=sys.stderr)
    extracted: dict[str, list[dict]] = {}
    for repo_name in ("claude-code-src", "openclaw", "hermes-agent", "codex", "prime-agent", "kimi-code"):
        items = []
        for entry in catalog[repo_name]:
            if entry.get("category") not in RUNTIME_VISIBLE_CATEGORIES:
                continue
            x = extract(repo_name, repos[repo_name], entry, problems)
            x["repo"] = repo_name
            items.append(x)
        extracted[repo_name] = items
        print(f"  - {repo_name}: {len(items)} prompts", file=sys.stderr)

    # Now build per-our-prompt comparison rows.
    print(f"[build] extracting ours + matching + git history...", file=sys.stderr)
    rows = []
    # Index reference catalog entries by id for O(1) explicit lookups.
    by_id: dict[str, dict[str, dict]] = {}
    for repo_name in ("claude-code-src", "openclaw", "hermes-agent", "codex", "prime-agent", "kimi-code"):
        by_id[repo_name] = {
            e["id"]: e
            for e in catalog[repo_name]
            if e.get("category") in RUNTIME_VISIBLE_CATEGORIES
        }

    def hydrate(matched_entry: dict | None, repo_name: str) -> dict | None:
        if matched_entry is None:
            return None
        for x in extracted[repo_name]:
            if x["id"] == matched_entry["id"]:
                return x
        return None

    REPO_KEY_MAP = {
        "claude": "claude-code-src",
        "openclaw": "openclaw",
        "hermes": "hermes-agent",
        "codex": "codex",
        "prime": "prime-agent",
        "kimi": "kimi-code",
    }

    def resolve_match(ours_entry: dict, ui_key: str) -> tuple[dict | None, float, str]:
        """Resolve a match for a given reference repo column.

        Strategy (strict):
          1. If `entry.matches[ui_key]` is set explicitly:
             - string ID  → return that entry, score = 1.0 (manual), source = "explicit"
             - None       → return no candidate, score = 0.0, source = "explicit-none"
          2. Otherwise: return no candidate. We intentionally DO NOT auto-match.
        """
        repo_name = REPO_KEY_MAP[ui_key]
        explicit = (ours_entry.get("matches") or {})
        if ui_key in explicit:
            target_id = explicit[ui_key]
            if target_id is None:
                return None, 0.0, "explicit-none"
            target = by_id[repo_name].get(target_id)
            if target is None:
                # Mapping points at a non-existent ID — surface as a problem.
                problems.append(
                    f"  ✗ {ours_entry['id']} → matches.{ui_key} = {target_id!r} not in {repo_name} catalog"
                )
                return None, 0.0, "explicit-broken"
            return target, 1.0, "explicit"
        # Strict mode: unmapped means intentionally unpaired until reviewed.
        return None, 0.0, "explicit-unset"

    for entry in catalog["ours"]:
        if entry.get("category") not in RUNTIME_VISIBLE_CATEGORIES:
            continue
        cur = extract("ours", ROOT, entry, problems)
        cur["repo"] = "ours"
        hist_text, hist_label = fetch_historical(entry["path"], entry.get("anchor"))

        match_claude,  score_claude,  src_claude  = resolve_match(entry, "claude")
        match_open,    score_open,    src_open    = resolve_match(entry, "openclaw")
        match_hermes,  score_hermes,  src_hermes  = resolve_match(entry, "hermes")
        match_codex,   score_codex,   src_codex   = resolve_match(entry, "codex")
        match_prime,   score_prime,   src_prime   = resolve_match(entry, "prime")
        match_kimi,    score_kimi,    src_kimi    = resolve_match(entry, "kimi")

        rows.append({
            "id": entry["id"],
            "path": entry["path"],
            "category": entry["category"],
            "agent": entry.get("agent", "shared"),
            "summary": entry["summary"],
            "current": cur,
            "historical": {
                "text": hist_text,
                "formatted_text": format_prompt_by_type(hist_text, entry["category"], entry.get("id")),
                "label": hist_label,
            },
            "claude": {
                "entry": hydrate(match_claude, "claude-code-src"),
                "score": round(score_claude, 3),
                "weak": (src_claude == "auto" and score_claude < WEAK_THRESHOLD),
                "match_source": src_claude,
            },
            "openclaw": {
                "entry": hydrate(match_open, "openclaw"),
                "score": round(score_open, 3),
                "weak": (src_open == "auto" and score_open < WEAK_THRESHOLD),
                "match_source": src_open,
            },
            "hermes": {
                "entry": hydrate(match_hermes, "hermes-agent"),
                "score": round(score_hermes, 3),
                "weak": (src_hermes == "auto" and score_hermes < WEAK_THRESHOLD),
                "match_source": src_hermes,
            },
            "codex": {
                "entry": hydrate(match_codex, "codex"),
                "score": round(score_codex, 3),
                "weak": (src_codex == "auto" and score_codex < WEAK_THRESHOLD),
                "match_source": src_codex,
            },
            "prime": {
                "entry": hydrate(match_prime, "prime-agent"),
                "score": round(score_prime, 3),
                "weak": (src_prime == "auto" and score_prime < WEAK_THRESHOLD),
                "match_source": src_prime,
            },
            "kimi": {
                "entry": hydrate(match_kimi, "kimi-code"),
                "score": round(score_kimi, 3),
                "weak": (src_kimi == "auto" and score_kimi < WEAK_THRESHOLD),
                "match_source": src_kimi,
            },
        })

    out = {
        "rows": rows,
        "history_before_target": HISTORY_BEFORE,
        "weak_threshold": WEAK_THRESHOLD,
        "total": len(rows),
    }
    DATA_OUT.write_text(json.dumps(out, indent=2))
    print(f"[build] wrote {len(rows)} rows → {DATA_OUT}", file=sys.stderr)

    if problems:
        print(f"\n[build] {len(problems)} extraction problems — fix anchors in catalog.json:", file=sys.stderr)
        for p in problems:
            print(p, file=sys.stderr)
    else:
        print("[build] no extraction problems", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
