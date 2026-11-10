"""Recover a code task's saved execution contract; never substitute a new schema."""

import copy
from typing import Any, Dict

from temporalio import activity
from temporalio.exceptions import ApplicationError

from helpers.attachments import extract_attachments_from_context
from helpers.fetch_config import _fetch_agent_data_impl


def _missing(message: str) -> ApplicationError:
    return ApplicationError(message, type="CODE_AGENT_RESUME_CONFIG_UNAVAILABLE", non_retryable=True)


@activity.defn
async def fetch_code_agent_resume_context(agent_id: str, tool_call_id: str) -> Dict[str, Any]:
    """Prefer the last task's launch snapshot; historical calls retain their exact declaration."""
    data = await _fetch_agent_data_impl(agent_id)
    messages = data.get("messages") or []
    effective_settings = None
    effective_provider = None
    for row in reversed(messages):
        metadata = row.get("metadata") or {}
        if not isinstance(metadata, dict):
            continue
        if row.get("role") != "TOOL" or metadata.get("toolCallId") != tool_call_id:
            continue
        effective = metadata.get("effective_settings")
        if effective_settings is None and isinstance(effective, dict) and all(
            isinstance(effective.get(key), str) and effective[key] for key in ("model", "effort", "speed")
        ):
            effective_settings = {
                "model": effective["model"], "reasoning_effort": effective["effort"], "speed": effective["speed"]
            }
            if metadata.get("code_provider") in ("claude", "codex"):
                effective_provider = metadata["code_provider"]
        saved = metadata.get("codeAgentResumeConfig")
        if isinstance(saved, dict):
            if saved.get("version") != 1:
                raise _missing("The saved code-task configuration version is unsupported; its parameters were not replaced.")
            if not isinstance(saved.get("spawn_args"), dict):
                raise _missing("The saved code task has no spawn arguments; refusing to invent a resume contract.")
            result = copy.deepcopy(saved)
            if effective_settings is not None:
                result["cli_settings"] = effective_settings
                if effective_provider is not None:
                    result["code_provider"] = effective_provider
            return result

    declarations = []
    context = []
    for index, row in enumerate(messages):
        metadata = row.get("metadata") or {}
        if row.get("role") != "ASSISTANT" or not isinstance(metadata, dict):
            continue
        for call in metadata.get("tool_calls") or []:
            if not isinstance(call, dict) or call.get("tool_call_id") != tool_call_id:
                continue
            if call.get("tool") != "spawn_claude_code_agent" and not (
                call.get("tool") == "spawn_agent" and call.get("type") == "code"
            ):
                continue
            declarations.append(call)
            if not context:
                context = messages[: index + 1]
    if not declarations:
        raise _missing("The original code-task parameters were not saved; refusing to resume with different defaults.")
    original = declarations[0]
    if any(item != original for item in declarations[1:]):
        raise _missing("Conflicting saved parameters for this code task; no resume configuration was selected.")
    pointers = [pointer.to_dict() for pointer in extract_attachments_from_context(context)]
    names = original.get("attachments")
    if isinstance(names, list) and names:
        by_name = {pointer["original_filename"]: pointer for pointer in pointers}
        if any(name not in by_name for name in names):
            raise _missing("An original code-task attachment could not be recovered; its files were not replaced.")
        pointers = [by_name[name] for name in names]
    result = {
        "version": 1,
        "spawn_args": copy.deepcopy(original),
        "attachments": pointers,
        "historical_settings_unrecorded": effective_settings is None,
    }
    if effective_settings is not None:
        result["cli_settings"] = effective_settings
        if effective_provider is not None:
            result["code_provider"] = effective_provider
    return result
