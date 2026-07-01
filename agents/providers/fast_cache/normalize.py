"""Fast Mode cache — normalization + key building (Python side).

Mirror of back-end/src/domains/fast-cache/normalize.ts. Keep the two in sync:
identical rules → identical keys across the TS/Python split. The ONLY defense
against cache "busts" is normalization (we never validate freshness).
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

CACHE_KEY_VERSION = "v42"

# Query params that vary per-request and must never participate in a key.
_VOLATILE_QUERY_PARAMS = {
    "_", "cb", "cache", "cachebuster", "v", "ver", "version", "t", "ts", "time",
    "timestamp", "nonce", "rand", "random", "r", "_t", "gclid", "fbclid", "msclkid",
    "sid", "sessionid", "session_id", "token", "signature", "sig", "expires", "expiry",
}
_VOLATILE_QUERY_PREFIXES = ("utm_", "x-amz-", "x_amz_", "amp;")

# Field names that hold secrets — stripped before any value is written.
_SECRET_FIELDS = {
    "authorization", "cookie", "set-cookie", "x-api-key", "api-key",
    "anthropic-api-key", "x-anthropic-api-key", "proxy-authorization",
    "claude_token", "gpt_token", "apikey",
}
_REQUEST_PARTITION_HEADERS = {"authorization", "cookie", "proxy-authorization", "x-api-key"}
_SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\n"
_USER_CONTEXT_PREFIX = "# User Context"
_VOLATILE_OBJECT_FIELDS = {
    "agent_id",
    "agentid",
    "root_agent_id",
    "rootagentid",
    "span_id",
    "spanid",
    "parent_span_id",
    "parentspanid",
    "trace_id",
    "traceid",
    "request_id",
    "requestid",
    "run_id",
    "runid",
    "workflow_id",
    "workflowid",
    "message_id",
    "messageid",
    "conversation_id",
    "conversationid",
    "thread_id",
    "threadid",
    "turn_id",
    "turnid",
    "response_id",
    "responseid",
    "previous_response_id",
    "previousresponseid",
    "item_id",
    "itemid",
    "message_count",
    "messagecount",
    "task_id",
    "taskid",
    "sandbox_id",
    "sandboxid",
    "e2b_sandbox_id",
    "e2bsandboxid",
    "session_id",
    "sessionid",
    "tool_call_id",
    "toolcallid",
    "tool_use_id",
    "tooluseid",
    "created_at",
    "createdat",
    "updated_at",
    "updatedat",
    "started_at",
    "startedat",
    "ended_at",
    "endedat",
    "timestamp",
    "browser_recording_path",
    "browser_recording_manifest_path",
    "browser_recording_task_id",
    "cost_dollars",
    "costdollars",
    "duration_seconds",
    "durationseconds",
    "elapsed_seconds",
    "elapsedseconds",
    "elapsed_s",
    "tree_cost_cents",
    "treecostcents",
    "own_cost_cents",
    "owncostcents",
    "token_count",
    "tokencount",
    "tokens_in",
    "tokensin",
    "tokens_out",
    "tokensout",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "encrypted_content",
    "encryptedcontent",
    "encrypted_reasoning",
    "encryptedreasoning",
    "reasoning_encrypted_content",
    "reasoningencryptedcontent",
    "prompt_cache_key",
    "promptcachekey",
    "client_metadata",
    "clientmetadata",
    "x-codex-installation-id",
}
_UUID_RE = re.compile(
    r"(?<![0-9a-fA-F])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9a-fA-F])"
)
_TOOL_ID_RE = re.compile(r"\b(?:toolu|tool|call)_[A-Za-z0-9_-]{8,}\b")
_CODEX_ID_RE = re.compile(r"\b(?:resp|rs|msg|item|fc|reasoning)_[A-Za-z0-9_-]{8,}\b")
_ISO_TIMESTAMP_RE = re.compile(r"(?m)^Timestamp:\s*[^\n]+$")
_JSON_TIMESTAMP_FIELD_RE = re.compile(
    r'(?P<prefix>\\?"(?:timestamp|created_at|createdAt|updated_at|updatedAt|started_at|startedAt|ended_at|endedAt)\\?"\s*:\s*\\?")'
    r"\d{4}-\d{2}-\d{2}T[^\"\\]+"
    r"(?P<suffix>\\?\")"
)
_STATE_NOW_RE = re.compile(r"(?m)^\[STATE:\s*now=[^\]]+\]\s*")
_CLOCK_PREFIX_RE = re.compile(r"(?m)^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\s*")
_COMMAND_CHUNK_ID_RE = re.compile(r"(?m)^Chunk ID:\s*[^\n]+$")
_COMMAND_WALL_TIME_RE = re.compile(r"(?m)^Wall time:\s*[^\n]+$")
_COMMAND_TOKEN_COUNT_RE = re.compile(r"(?m)^Original token count:\s*\d+$")
_COMMAND_SESSION_ID_RE = re.compile(r"Process running with session ID\s+\d+")
_COMMAND_UNKNOWN_PROCESS_ID_RE = re.compile(r"write_stdin failed: Unknown process id\s+\d+")
_JSON_NUMERIC_VOLATILE_FIELD_RE = re.compile(
    r'(?P<prefix>\\?"(?:session_id|sessionId|yield_time_ms|yieldTimeMs)\\?"\s*:\s*)\d+'
)
_CODEX_SHELL_SNAPSHOT_RE = re.compile(
    r"(?:/+home/user/)?\.codex/shell_snapshots/[0-9a-fA-F-]{36}\.\d+\.sh"
)
_NPM_NOTICE_LINE_RE = re.compile(r"(?m)^npm notice.*(?:\n|$)")
_NPM_WARN_LINE_RE = re.compile(r"(?m)^npm warn.*(?:\n|$)")
_NPM_INSTALL_DURATION_RE = re.compile(
    r"\b((?:added|removed|changed) \d+ packages?, and audited \d+ packages|audited \d+ packages) in \d+(?:\.\d+)?(?:ms|s)\b"
)
_PIP_COLLECTING_LINE_RE = re.compile(r"(?im)^Collecting .*(?:\n|$)")
_PIP_DOWNLOADING_LINE_RE = re.compile(r"(?im)^\s*Downloading .*(?:\n|$)")
_PIP_INSTALLING_LINE_RE = re.compile(r"(?im)^\s*Installing collected packages: .*(?:\n|$)")
_PIP_PROGRESS_LINE_RE = re.compile(r"(?im)^.*(?:━{3,}|eta\s+0:00:00|[KMGT]?B/s).*$")
_PIP_SUCCESS_LINE_RE = re.compile(r"(?im)^Successfully installed (?P<packages>.*)$")
_LS_LONG_MTIME_RE = re.compile(
    r"(?m)^([bcdlps-][rwxStTs-]{9}[.+@]?\s+\d+\s+\S+\s+\S+\s+\S+\s+)"
    r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+(?:\d{2}:\d{2}|\d{4})(\s+)"
)
_FILE_TIMESTAMP_PATH_LINE_RE = re.compile(
    r"(?m)^\d+(?:\.\d+)?\s+((?:/|\./|\.\./|~/|[A-Za-z]:[\\/])\S+)"
)
_COMMAND_OUTPUT_ISO_TIMESTAMP_RE = re.compile(
    r"\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b"
)
_COMMAND_NORMALIZED_RUNNING_RE = re.compile(r"(^|\n)Process running with session ID <session_id>(?=\n|$)")
_COMMAND_EXIT_ZERO_RE = re.compile(r"(^|\n)Process exited with code 0(?=\n|$)")
_PACKAGE_DOWNLOAD_RATE_RE = re.compile(
    r"(\d+(?:\.\d+)?/\d+(?:\.\d+)?\s+[KMGT]?B\s+)\d+(?:\.\d+)?\s+[KMGT]?B/s(\s+eta\s+0:00:00)",
    re.IGNORECASE,
)
_STATUS_UPDATE_LINE_RE = re.compile(r"(?m)^\s*(?:•\s*)?Status update at \d+s\s*(?:\n|$)")
_ESCAPED_STATUS_UPDATE_RE = re.compile(r"\\n\s*(?:•\s*)?Status update at \d+s\s*(?=\\n)")
_CODE_AGENT_SANDBOX_ACTION_LINE_RE = re.compile(
    r"(?im)^\s*(?:•\s*)?Created E2B sandbox:\s*(?:<sandbox_id>|[a-z0-9]{10,64})\s*(?:\n|$)"
)
_ESCAPED_CODE_AGENT_SANDBOX_ACTION_RE = re.compile(
    r"(?i)\\n\s*(?:•\s*)?Created E2B sandbox:\s*(?:<sandbox_id>|[a-z0-9]{10,64})\s*(?=\\n)"
)
_ACTIONS_TAKEN_COUNT_RE = re.compile(r"\*\*Actions Taken\*\* \(\d+ total, showing last \d+\):")
_BROWSER_DOM_INDEX_RE = re.compile(r"(\|SHADOW\([^)]*\)\|)?\[\d+\](?=<)")
_BROWSER_ACTION_INDEX_RE = re.compile(r'(\\?"index\\?"\s*:\s*)\d+')
_BROWSER_TOKEN_LINE_RE = re.compile(r"(?m)^Token:\s*\S+$")
_RESOLVED_REF_RE = re.compile(r"<resolved-ref pointer=\"@ref:message:[^\"]+\"[^>]*>")
_AGENT_RECORDING_PATH_RE = re.compile(r"\.context/browser-agent-recordings/[^\s\"']+")
_GITHUB_CREDENTIAL_URL_RE = re.compile(r"https://[^@\s\"']+@github\.com/")
_ROSE_AGENT_REPO_URL_RE = re.compile(
    r"https://github\.com/rose-gh-agent/agent-[0-9a-fA-F]{8}(?:\.git)?"
)
_ROSE_AGENT_WORKDIR_RE = re.compile(r"/home/user/agent-[0-9a-fA-F]{8}\b")
_ROSE_AGENT_REPO_SLUG_RE = re.compile(r"\bagent-[0-9a-fA-F]{8}\b")
_E2B_SANDBOX_TEXT_RE = re.compile(r"(?i)(Created E2B sandbox:\s*)[a-z0-9]{10,64}\b")
_SANDBOX_FIELD_RE = re.compile(
    r'(?P<prefix>\\?"(?:sandbox_id|sandboxId|e2b_sandbox_id|e2bSandboxId)\\?"\s*:\s*\\?")'
    r"[A-Za-z0-9_-]{10,64}"
    r"(?P<suffix>\\?\")"
)
_BROWSER_STEP_CALLSITE_RE = re.compile(r"^browser_use_step_\d+$")
_BROWSER_SELECTOR_PREFIX_RE = re.compile(r"^\s*\[\d+\]\s*")
_PARALLEL_RESULT_MESSAGE_RE = re.compile(
    r"^\[timestamp\]\s+\[(?:spawn_agent|spawn_general_purpose_agent|web_search|web_fetch) result\]:"
)
_TIMESTAMPED_RESULT_BLOCK_RE = re.compile(
    r"(?ms)(^\[timestamp\]\s+\[(?:spawn_agent|spawn_general_purpose_agent|web_search|web_fetch) result\]:.*?)(?=^\[timestamp\]\s+\[(?:spawn_agent|spawn_general_purpose_agent|web_search|web_fetch) result\]:|\Z)"
)
_PARAM_BLOCK_RE = re.compile(
    r"(?ms)\*\*Params Passed:\*\*\s*(?P<params>.*?)\n\s*\*\*Result:\*\*\s*(?P<result>.*)\s*$"
)
_PARAM_LINE_RE = re.compile(r"(?m)^-\s+\*\*(?P<name>[^*]+)\*\*:\s*(?P<value>.*)$")
_PARALLEL_TOOL_RESULT_NAMES = (
    '"tool_name": "spawn_agent"',
    '"tool_name": "spawn_general_purpose_agent"',
    '"tool_name": "web_search"',
    '"tool_name": "web_fetch"',
)
_TOOL_RESULT_JSON_LINE_RE = re.compile(r"(?m)^TOOL_RESULT (\{.*\})$")
_CODE_AGENT_SDK_EVENTS_PREFIX = "Code-agent SDK event JSON:\n\n"
_CODE_AGENT_STATUS_UPDATE_RE = re.compile(r"^Status update at \d+s$")
_COMPLETION_SUMMARY_STRUCTURED_OUTPUT_RE = re.compile(
    r"(?s)(\n\nSTRUCTURED OUTPUT DELIVERED:\n).*?(\n\n\nWrite a BRIEF)"
)


def _looks_like_volatile_id(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    text = value.strip()
    return bool(
        _UUID_RE.fullmatch(text)
        or _TOOL_ID_RE.fullmatch(text)
        or _CODEX_ID_RE.fullmatch(text)
        or re.fullmatch(r"[0-9a-fA-F]{10,32}", text)
    )


def _normalize_volatile_text(text: str) -> str:
    """Remove run-local wrappers from provider-visible text without changing user prose."""
    text = _CLOCK_PREFIX_RE.sub("[timestamp] ", text)
    text = _COMMAND_CHUNK_ID_RE.sub("Chunk ID: <chunk_id>", text)
    text = _COMMAND_WALL_TIME_RE.sub("Wall time: <duration>", text)
    text = _COMMAND_TOKEN_COUNT_RE.sub("Original token count: <tokens>", text)
    text = _COMMAND_SESSION_ID_RE.sub("Process running with session ID <session_id>", text)
    text = _COMMAND_UNKNOWN_PROCESS_ID_RE.sub("write_stdin failed: Unknown process id <session_id>", text)
    text = _JSON_NUMERIC_VOLATILE_FIELD_RE.sub(r"\g<prefix><session_id>", text)
    text = _CODEX_SHELL_SNAPSHOT_RE.sub("/home/user/.codex/shell_snapshots/<snapshot>.sh", text)
    text = _NPM_NOTICE_LINE_RE.sub("", text)
    text = _NPM_WARN_LINE_RE.sub("", text)
    text = _NPM_INSTALL_DURATION_RE.sub(r"\1 in <duration>", text)
    text = _LS_LONG_MTIME_RE.sub(r"\g<1><mtime>\g<2>", text)
    text = _FILE_TIMESTAMP_PATH_LINE_RE.sub(r"\1", text)
    text = _PACKAGE_DOWNLOAD_RATE_RE.sub(r"\g<1><rate>\g<2>", text)
    text = _STATUS_UPDATE_LINE_RE.sub("", text)
    text = _ESCAPED_STATUS_UPDATE_RE.sub("", text)
    text = _ACTIONS_TAKEN_COUNT_RE.sub("**Actions Taken** (<actions>):", text)
    text = _BROWSER_DOM_INDEX_RE.sub(r"\g<1>[idx]", text)
    text = _BROWSER_ACTION_INDEX_RE.sub(r"\g<1><index>", text)
    text = _BROWSER_TOKEN_LINE_RE.sub("Token: <token>", text)
    text = _ISO_TIMESTAMP_RE.sub("Timestamp: <timestamp>", text)
    text = _JSON_TIMESTAMP_FIELD_RE.sub(r"\g<prefix><timestamp>\g<suffix>", text)
    text = _STATE_NOW_RE.sub("[STATE: now=<timestamp>]\n\n", text)
    text = _RESOLVED_REF_RE.sub("<resolved-ref>", text)
    text = re.sub(r"@ref:message:" + _UUID_RE.pattern, "@ref:message:<uuid>", text)
    text = _COMPLETION_SUMMARY_STRUCTURED_OUTPUT_RE.sub(
        r"\g<1><structured-output>\g<2>", text
    )
    text = _AGENT_RECORDING_PATH_RE.sub(".context/browser-agent-recordings/<recording>", text)
    text = _GITHUB_CREDENTIAL_URL_RE.sub("https://github.com/", text)
    text = _ROSE_AGENT_REPO_URL_RE.sub("https://github.com/rose-gh-agent/agent-<root>", text)
    text = _ROSE_AGENT_WORKDIR_RE.sub("/home/user/agent-<root>", text)
    text = _ROSE_AGENT_REPO_SLUG_RE.sub("agent-<root>", text)
    text = _E2B_SANDBOX_TEXT_RE.sub(r"\1<sandbox_id>", text)
    text = _CODE_AGENT_SANDBOX_ACTION_LINE_RE.sub("", text)
    text = _ESCAPED_CODE_AGENT_SANDBOX_ACTION_RE.sub("", text)
    text = _SANDBOX_FIELD_RE.sub(r"\g<prefix><sandbox_id>\g<suffix>", text)
    text = _UUID_RE.sub("<uuid>", text)
    text = _TOOL_ID_RE.sub("<tool_call_id>", text)
    text = _CODEX_ID_RE.sub("<codex_id>", text)
    text = _canonicalize_code_agent_sdk_events_text(text)
    text = _canonicalize_command_output_volatile_text(text)
    text = _canonicalize_running_command_output(text)
    text = _canonicalize_empty_or_running_command_output(text)
    text = _canonicalize_package_manager_output(text)
    text = _sort_path_listing_command_output(text)
    text = _canonicalize_provider_json_text(text)
    text = _canonicalize_provider_result_text(text)
    text = _sort_timestamped_result_blocks(text)
    text = _sort_parallel_tool_result_blocks(text)
    return text


def _canonicalize_dynamic_user_context(text: str) -> str:
    if not text.lstrip().startswith(_USER_CONTEXT_PREFIX):
        return text
    return f"{_USER_CONTEXT_PREFIX}\n<dynamic-user-context>"


def _canonicalize_package_manager_output(text: str) -> str:
    looks_like_pip_install = (
        "Successfully installed " in text
        or "Requirement already satisfied:" in text
        or (" Downloading " in text and "eta 0:00:00" in text)
    )
    if not looks_like_pip_install:
        return text
    text = _PIP_COLLECTING_LINE_RE.sub("", text)
    text = _PIP_DOWNLOADING_LINE_RE.sub("", text)
    text = _PIP_INSTALLING_LINE_RE.sub("", text)
    text = _PIP_PROGRESS_LINE_RE.sub("", text)
    text = _PIP_SUCCESS_LINE_RE.sub(lambda match: "Successfully installed " + match.group("packages").lower(), text)
    return text


def _canonicalize_running_command_output(text: str) -> str:
    if "Process running with session ID <session_id>" not in text:
        return text

    marker = "\nOutput:\n"
    idx = text.find(marker)
    if idx < 0:
        return text
    before_output = text[:idx]
    if "Process running with session ID <session_id>" not in before_output:
        return text
    return text[: idx + len(marker)] + "<running>\n"


def _canonicalize_empty_or_running_command_output(text: str) -> str:
    marker = "\nOutput:\n"
    idx = text.find(marker)
    if idx < 0:
        return text
    before_output = text[:idx]
    output = text[idx + len(marker):]
    is_running = "Process running with session ID <session_id>" in before_output
    is_exit_zero = bool(_COMMAND_EXIT_ZERO_RE.search(before_output))
    if not is_running and not is_exit_zero:
        return text
    stripped_output = output.strip()
    if stripped_output not in ("", "<running>"):
        return text
    before_output = _COMMAND_NORMALIZED_RUNNING_RE.sub(r"\1Process <empty-or-running>", before_output)
    before_output = _COMMAND_EXIT_ZERO_RE.sub(r"\1Process <empty-or-running>", before_output)
    return before_output + marker + "<empty-or-running>\n"


def _canonicalize_command_output_volatile_text(text: str) -> str:
    marker = "\nOutput:\n"
    idx = text.find(marker)
    if idx < 0:
        return text
    output_start = idx + len(marker)
    return text[:output_start] + _COMMAND_OUTPUT_ISO_TIMESTAMP_RE.sub("<timestamp>", text[output_start:])


def _parse_code_agent_sdk_payload_text(payload_text: str) -> Any | None:
    stripped = payload_text.strip()
    if not stripped:
        return None
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        pass

    # Verifier contexts cap long code-agent event JSON before normalization. If
    # the cap cuts off the wrapper or an event prefix, rebuild the payload from
    # the first complete event object and keep the stable tail summary.
    match = re.search(r'\{\s*"version"\s*:', stripped)
    if not match:
        return None
    candidate = '{"code_agent_events":[' + stripped[match.start():]
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        return None


def _canonicalize_raw_code_agent_sdk_events_text(text: str) -> str:
    prefix_idx = text.find(_CODE_AGENT_SDK_EVENTS_PREFIX)
    if prefix_idx < 0 or text[:prefix_idx].strip():
        return text

    payload = _parse_code_agent_sdk_payload_text(text[prefix_idx + len(_CODE_AGENT_SDK_EVENTS_PREFIX):])
    if payload is None:
        return text
    return (
        text[: prefix_idx + len(_CODE_AGENT_SDK_EVENTS_PREFIX)]
        + _stable_json(_canonicalize_code_agent_sdk_payload(payload))
    )


def _canonicalize_code_agent_sdk_events_text(text: str) -> str:
    def replace(match: re.Match[str]) -> str:
        try:
            outer = json.loads(match.group(1))
        except json.JSONDecodeError:
            return match.group(0)
        if not isinstance(outer, dict):
            return match.group(0)
        if outer.get("tool_name") != "code_agent_sdk_events" or not isinstance(outer.get("result"), str):
            return match.group(0)
        result = outer["result"]
        if not result.startswith(_CODE_AGENT_SDK_EVENTS_PREFIX):
            return match.group(0)
        payload = _parse_code_agent_sdk_payload_text(result[len(_CODE_AGENT_SDK_EVENTS_PREFIX):])
        if payload is None:
            return match.group(0)
        canonical = {
            "tool_name": "code_agent_sdk_events",
            "result": _CODE_AGENT_SDK_EVENTS_PREFIX + _stable_json(_canonicalize_code_agent_sdk_payload(payload)),
        }
        return "TOOL_RESULT " + _stable_json(canonical)

    return _canonicalize_raw_code_agent_sdk_events_text(_TOOL_RESULT_JSON_LINE_RE.sub(replace, text))


def _canonicalize_code_agent_sdk_payload(value: Any) -> Any:
    if isinstance(value, str):
        return _normalize_volatile_text(value)
    if isinstance(value, list):
        return [_canonicalize_code_agent_sdk_payload(item) for item in value]
    if not isinstance(value, dict):
        return value

    out: dict[str, Any] = {}
    for key, raw in value.items():
        if key == "code_agent_events" and isinstance(raw, list):
            events = []
            for event in raw:
                if isinstance(event, dict) and event.get("type") == "command" and (
                    event.get("raw_type") == "item.started" or event.get("status") == "started"
                ):
                    continue
                events.append(_canonicalize_code_agent_sdk_payload(event))
            out[key] = sorted(events, key=_stable_json)
            continue
        if key == "execution_summary" and isinstance(raw, list):
            out[key] = [
                _canonicalize_code_agent_sdk_payload(item)
                for item in raw
                if not (isinstance(item, str) and _CODE_AGENT_STATUS_UPDATE_RE.match(item.strip()))
            ]
            continue
        out[key] = _canonicalize_code_agent_sdk_payload(raw)
    return out


def _stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _is_path_listing_line(line: str) -> bool:
    return bool(re.match(r"^(?:/|\./|\.\./|~/|[A-Za-z]:[\\/])\S+", line.strip()))


def _sort_path_listing_command_output(text: str) -> str:
    marker = "\nOutput:\n"
    idx = text.find(marker)
    if idx < 0:
        return text
    output_start = idx + len(marker)
    before = text[:output_start]
    output = text[output_start:]
    trailing_newline = output.endswith("\n")
    lines = output.split("\n")
    if trailing_newline:
        lines.pop()
    non_empty = [line for line in lines if line.strip()]
    if len(non_empty) < 2 or not all((not line.strip()) or _is_path_listing_line(line) for line in lines):
        return text
    return before + "\n".join(sorted(non_empty)) + ("\n" if trailing_newline else "")


def _is_parallel_tool_result_block(part: str) -> bool:
    return part.startswith("TOOL_RESULT ") and any(name in part for name in _PARALLEL_TOOL_RESULT_NAMES)


def _sort_parallel_tool_result_blocks(text: str) -> str:
    if "TOOL_RESULT " not in text:
        return text

    parts = text.split("\n\n")
    out: list[str] = []
    i = 0
    while i < len(parts):
        if not _is_parallel_tool_result_block(parts[i]):
            out.append(parts[i])
            i += 1
            continue

        batch: list[str] = []
        while i < len(parts) and _is_parallel_tool_result_block(parts[i]):
            batch.append(parts[i])
            i += 1
        out.extend(sorted(batch))
    return "\n\n".join(out)


def _sort_timestamped_result_blocks(text: str) -> str:
    """Sort batched timestamped tool-result text while preserving surrounding prose."""
    if "[timestamp] [" not in text:
        return text

    matches = list(_TIMESTAMPED_RESULT_BLOCK_RE.finditer(text))
    if len(matches) < 2:
        return text

    out: list[str] = []
    last_end = 0
    i = 0
    while i < len(matches):
        m = matches[i]
        out.append(text[last_end:m.start()])

        batch = [m.group(1).strip()]
        batch_end = m.end()
        i += 1
        while i < len(matches) and matches[i].start() == batch_end:
            batch.append(matches[i].group(1).strip())
            batch_end = matches[i].end()
            i += 1
        out.append("\n\n".join(sorted(batch)))
        last_end = batch_end

    out.append(text[last_end:])
    return "".join(out)


def _canonicalize_provider_result_text(text: str) -> str:
    """Compact standard web_search/web_fetch result blocks to stable request
    params plus a normalized result digest.

    This avoids cache busts from run-local formatting while still changing the
    LLM fingerprint when the provider-visible result body changes.
    """
    if "**Params Passed:**" not in text or "**Result:**" not in text:
        return text

    match = _PARAM_BLOCK_RE.search(text)
    if not match:
        return text

    params: list[tuple[str, str]] = []
    for line_match in _PARAM_LINE_RE.finditer(match.group("params") or ""):
        name = " ".join(line_match.group("name").strip().lower().split())
        value = " ".join(line_match.group("value").strip().split())
        if name == "url":
            value = normalize_url(value)
        params.append((name, value))
    if not params:
        return text
    params.sort()

    result = match.group("result") or ""
    result_fingerprint = sha256(result.strip())[:32] if result.strip() else "empty"
    return json.dumps(
        {
            "provider_result": params,
            "result_hash": result_fingerprint,
        },
        sort_keys=True,
        separators=(",", ":"),
    )


def _parse_provider_json_payload(text: str) -> tuple[str, Any] | None:
    prefix = ""
    payload = text
    if payload.startswith("[timestamp] "):
        prefix = "[timestamp] "
        payload = payload[len("[timestamp] "):]

    stripped = payload.lstrip()
    prefix += payload[: len(payload) - len(stripped)]
    if not stripped:
        return None

    if stripped[0] not in "{[":
        starts = [idx for idx in (stripped.find("{"), stripped.find("[")) if idx >= 0]
        if not starts:
            return None
        start = min(starts)
        leading = stripped[:start]
        if "\n" in leading or len(leading) > 240 or ":" not in leading:
            return None
        prefix += leading
        stripped = stripped[start:]

    decoder = json.JSONDecoder()
    try:
        value, end = decoder.raw_decode(stripped)
    except json.JSONDecodeError:
        return None
    if stripped[end:].strip():
        return None
    return prefix, value


def _looks_like_provider_json(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    keys = {str(k).lower() for k in value.keys()}
    return (
        ("answer" in keys and bool(keys & {"query", "sources", "provider", "images"}))
        or ("markdown" in keys and bool(keys & {"links", "metadata"}))
        or ("content" in keys and bool(keys & {"links", "sources", "metadata", "provider", "url", "objective", "downloaded_files", "links_discovered"}))
    )


def _canonicalize_provider_json_text(text: str) -> str:
    parsed = _parse_provider_json_payload(text)
    if parsed is None:
        return text
    prefix, value = parsed
    if not _looks_like_provider_json(value):
        return text
    return prefix + canonical_messages(value)


def _is_volatile_param(name: str) -> bool:
    lower = name.lower()
    if lower in _VOLATILE_QUERY_PARAMS:
        return True
    return any(lower.startswith(p) for p in _VOLATILE_QUERY_PREFIXES)


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def normalize_url(raw_url: str) -> str:
    """Canonicalize a URL so trivially-varying forms collapse to one string."""
    try:
        parts = urlsplit(raw_url)
    except ValueError:
        return raw_url.strip()
    if not parts.scheme or not parts.netloc:
        return raw_url.strip()

    scheme = parts.scheme.lower()
    host = parts.hostname.lower() if parts.hostname else ""
    port = parts.port
    # Drop default ports.
    if (scheme == "http" and port == 80) or (scheme == "https" and port == 443):
        port = None
    netloc = f"{host}:{port}" if port else host

    kept = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if not _is_volatile_param(k)]
    kept.sort()
    query = urlencode(kept)

    path = parts.path
    if len(path) > 1 and path.endswith("/"):
        path = path[:-1]

    return urlunsplit((scheme, netloc, path, query, ""))


def goal_hash(goal: str) -> str:
    """Short, stable hash of a goal string. Exact-match (no goal normalization)."""
    return sha256(goal)[:16]


def strip_secrets(value: Any) -> Any:
    """Recursively drop secret-bearing fields before a value is cached."""
    if isinstance(value, list):
        return [strip_secrets(v) for v in value]
    if isinstance(value, dict):
        return {k: strip_secrets(v) for k, v in value.items() if k.lower() not in _SECRET_FIELDS}
    return value


def _canonical_request_body(body: Any) -> str:
    if body is None:
        return ""
    if isinstance(body, bytes):
        try:
            body = body.decode("utf-8")
        except UnicodeDecodeError:
            return body.hex()
    if isinstance(body, str):
        stripped = body.strip()
        if not stripped:
            return ""
        try:
            return canonical_messages(json.loads(stripped))
        except Exception:
            return _normalize_volatile_text(stripped)
    return canonical_messages(body)


def build_key(kind: str, goal: str, detail: str) -> str:
    return f"fastmode:{CACHE_KEY_VERSION}:{kind}:{goal_hash(goal)}:{detail}"


def build_global_key(kind: str, detail: str) -> str:
    return f"fastmode:{CACHE_KEY_VERSION}:{kind}:global:{detail}"


def normalize_call_site(call_site: str) -> str:
    """Collapse call-site labels that only encode trajectory position."""
    if _BROWSER_STEP_CALLSITE_RE.match(call_site):
        return "browser_use_step"
    return call_site


def canonical_messages(messages: Any) -> str:
    """Stable canonical form of a messages list for CONTENT keying. Strips volatile
    bits (image/base64 blobs collapsed to a marker) so the hash is stable across runs
    when the conversation replays deterministically. Used for leaf/DAG LLM calls that
    have no durable position index — their input is fully determined by upstream
    (cached) responses, so identical input → identical key → hit."""

    def _is_parallel_result_message(item: Any) -> bool:
        if not isinstance(item, dict):
            return False
        if item.get("role") == "tool":
            return True
        content = item.get("content")
        return item.get("role") == "user" and isinstance(content, str) and bool(_PARALLEL_RESULT_MESSAGE_RE.match(content))

    def _sort_parallel_tool_batches(items: list[Any]) -> list[Any]:
        """Parallel tool results can arrive in any order; sort only contiguous
        tool-result batches so equivalent fan-out trajectories share a key."""
        out: list[Any] = []
        i = 0
        while i < len(items):
            item = items[i]
            if not _is_parallel_result_message(item):
                out.append(item)
                i += 1
                continue

            batch: list[Any] = []
            while i < len(items) and _is_parallel_result_message(items[i]):
                batch.append(items[i])
                i += 1
            batch.sort(key=lambda value: json.dumps(value, sort_keys=True, separators=(",", ":"), default=str))
            out.extend(batch)
        return out

    def _clean(v: Any) -> Any:
        if isinstance(v, dict):
            out = {}
            for k, val in v.items():
                lk = str(k).lower()
                if lk in _SECRET_FIELDS or lk in _VOLATILE_OBJECT_FIELDS:
                    continue
                if lk == "id" and _looks_like_volatile_id(val):
                    continue
                if (
                    lk == "content"
                    and v.get("role") == "system"
                    and isinstance(val, str)
                    and val.lstrip().startswith(_USER_CONTEXT_PREFIX)
                ):
                    out[k] = _canonicalize_dynamic_user_context(val)
                    continue
                if (
                    lk == "content"
                    and v.get("role") == "system"
                    and isinstance(val, str)
                    and _SYSTEM_PROMPT_DYNAMIC_BOUNDARY in val
                ):
                    out[k] = val.split(_SYSTEM_PROMPT_DYNAMIC_BOUNDARY)[0] + _SYSTEM_PROMPT_DYNAMIC_BOUNDARY
                    continue
                # Collapse large base64/image payloads — they're stable but huge.
                if lk in ("image_url", "data", "source") and isinstance(val, (str, dict)):
                    out[k] = "<blob>"
                else:
                    out[k] = _clean(val)
            return out
        if isinstance(v, list):
            return _sort_parallel_tool_batches([_clean(x) for x in v])
        if isinstance(v, str):
            return _normalize_volatile_text(v)
        return v

    return json.dumps(_clean(messages), sort_keys=True, separators=(",", ":"), default=str)


def content_key(goal: str, call_site: str, messages: Any) -> str:
    """Content-addressed LLM key: (goal, call_site, hash(canonical messages))."""
    return build_key("llm", goal, f"{normalize_call_site(call_site)}:c:{sha256(canonical_messages(messages))[:32]}")


def position_request_fingerprint(request: Any) -> str:
    """Behavior-shaping request material for trajectory replay.

    This deliberately excludes prior assistant/tool history: during Fast Mode
    replay that history is the thing we are trying to avoid using as a volatile
    key. It keeps static system prompts, model/config/tool/schema settings, and
    an optional environment fingerprint so prompt/config changes still miss.
    """
    if not isinstance(request, dict):
        return sha256(canonical_messages(request))[:32]

    messages = request.get("messages")
    static_messages: list[Any] = []
    if isinstance(messages, list):
        for message in messages:
            if not isinstance(message, dict):
                continue
            role = message.get("role")
            if role == "system":
                static_messages.append(message)
                continue
            if static_messages:
                break

    material: dict[str, Any] = {
        "pool": request.get("pool"),
        "static_messages": static_messages,
        "tools": request.get("tools"),
        "tool_choice": request.get("tool_choice"),
        "temperature": request.get("temperature"),
        "max_tokens": request.get("max_tokens"),
        "seed": request.get("seed"),
        "thinking": request.get("thinking"),
        "effort": request.get("effort"),
        "provider_fast_mode": request.get("provider_fast_mode"),
        "response_schema": request.get("response_schema"),
        "env_fingerprint": request.get("env_fingerprint"),
    }
    return sha256(canonical_messages(material))[:32]


def position_key(goal: str, call_site: str, step: int, request: Any) -> str:
    detail = f"{normalize_call_site(call_site)}:p:{step}:c:{position_request_fingerprint(request)}"
    return build_key("llm", goal, detail)


def llm_key(goal: str, call_site: str, request: Any) -> str:
    """Default LLM key for callers without a durable trajectory position."""
    return content_key(goal, call_site, request)


def browser_use_key(goal: str, request: Any) -> str:
    return build_key("browser_use", goal, f"c:{sha256(canonical_messages(canonical_browser_use_request(request)))[:32]}")


def browser_http_key(goal: str, method: str, url: str, headers: Any = None, body: Any = None) -> str:
    auth_parts: list[tuple[str, str]] = []
    if isinstance(headers, dict):
        for k, v in headers.items():
            lower = str(k).lower()
            if lower in _REQUEST_PARTITION_HEADERS and v:
                auth_parts.append((lower, str(v)))
    auth_parts.sort()
    auth_scope = "public" if not auth_parts else f"auth:{sha256(canonical_messages(auth_parts))[:16]}"
    method_upper = method.upper()
    if method_upper in {"GET", "HEAD"}:
        return build_global_key(
            "browser_http",
            f"{method_upper}:{sha256(normalize_url(url))[:24]}:{auth_scope}:no-body",
        )
    # Browser POST bodies often contain one-time challenge/timing data. Scope by
    # goal and endpoint rather than body so the same browser goal can replay while
    # avoiding global cross-goal mutation collisions.
    return build_key(
        "browser_http",
        goal,
        f"{method_upper}:{sha256(normalize_url(url))[:24]}:{auth_scope}:body:any",
    )


def canonical_browser_use_request(request: Any) -> Any:
    """Fingerprint browser decisions by semantic trajectory, not volatile DOM noise."""
    if not isinstance(request, dict):
        return request

    def _clean_action_entry(entry: Any) -> Any:
        if not isinstance(entry, dict):
            return entry
        action = entry.get("action") or entry.get("type") or entry.get("name")
        params = entry.get("params") if isinstance(entry.get("params"), dict) else entry
        stable_params: dict[str, Any] = {}
        if isinstance(params, dict):
            for key in (
                "url",
                "text",
                "key",
                "time_ms",
                "direction",
                "amount",
                "tab_id",
                "filename",
                "files",
                "option",
                "value",
                "clear",
            ):
                if key in params:
                    stable_params[key] = normalize_url(params[key]) if key == "url" and isinstance(params[key], str) else params[key]
        out: dict[str, Any] = {}
        if action:
            out["action"] = action
        if stable_params:
            out["params"] = stable_params
        description = entry.get("element_description") or entry.get("target") or entry.get("description")
        if isinstance(description, str) and description.strip():
            out["element"] = _BROWSER_SELECTOR_PREFIX_RE.sub("", " ".join(description.split()))
        status = entry.get("status")
        if status:
            out["status"] = status
        return out

    browser_state = request.get("browser_state") if isinstance(request.get("browser_state"), dict) else {}
    stable_state: dict[str, Any] = {}
    url = browser_state.get("url")
    if isinstance(url, str) and url:
        stable_state["url"] = normalize_url(url)
    title = browser_state.get("title")
    if title:
        stable_state["title"] = title
    if browser_state.get("_extra_user_messages"):
        stable_state["_extra_user_messages"] = browser_state.get("_extra_user_messages")

    return {
        "task": request.get("task"),
        "dynamic_system_context": request.get("dynamic_system_context"),
        "turn_message_count": len(request.get("turn_messages") or []),
        "browser_state": stable_state,
        "action_entries": [_clean_action_entry(entry) for entry in (request.get("action_entries") or [])],
        "config": request.get("config"),
    }


def web_search_key(goal: str, query: str, max_results: int) -> str:
    norm = " ".join(query.strip().lower().split())
    del goal
    return build_global_key("web_search", f"{max_results}:{sha256(norm)[:24]}")


def web_fetch_key(goal: str, url: str) -> str:
    del goal
    return build_global_key("web_fetch", sha256(normalize_url(url))[:24])


def file_key(goal: str, url: str) -> str:
    return build_key("file", goal, sha256(normalize_url(url))[:24])


def codex_key_from_hash(goal_hash_value: str, request: Any) -> str:
    return f"fastmode:{CACHE_KEY_VERSION}:codex:{goal_hash_value}:c:{sha256(canonical_messages(request))[:32]}"
