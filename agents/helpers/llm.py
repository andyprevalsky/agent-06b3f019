"""LLM tool for agent reasoning and decision making."""

import asyncio
import base64
import contextlib
import json
import random
import re
import time  # Import at module level for Temporal workflow sandbox compatibility
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple, Type, TypeVar

import httpx  # Used with instructor
import instructor  # Import at module level for Temporal workflow sandbox compatibility
import structlog
from openai import AsyncOpenAI
from pydantic import BaseModel
from temporalio import activity

from config import load_config
from helpers.attachments import (
    FilePointer,
    build_attachment_metadata_text,
    get_cached_file,
    get_file_from_pointer,
)
from helpers.context_pointers import resolve_pointers_in_messages
from helpers.messages import stream_assistant_chunk, stream_plan_event, stream_tool_event
from helpers.observability import dump_llm_context
from helpers.tracing import backend_api_headers, current_request_id, traced
from providers.rose import (
    RoseClient,
    RoseError,
    claude_auth_from_token,
    pool_for_model,
)
from providers.rose.transforms import reconstruct_agent_response
from utils.error_utils import extract_error_message
from utils.tool_schemas import (
    create_agent_action_model,
)

logger = structlog.get_logger()

# Same-machine optimization: passes large LLM context without Temporal serialization.
# On cross-machine miss, call_llm_activity falls back to fetching from backend API.
_pending_llm_context: Dict[str, Any] = {}  # agent_id -> (context, system_prompt, pre_resolved_ids)


def _safe_heartbeat(message: str) -> None:
    """Call activity.heartbeat() if we're in an activity context, otherwise silently skip."""
    with contextlib.suppress(Exception):
        activity.heartbeat(message)


def _safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox where time.time() is restricted."""
    try:
        return time.time()
    except Exception:
        return 0.0  # Workflow sandbox - TTFT logging will show 0ms


T = TypeVar("T", bound=BaseModel)


def prepare_schema_for_openai(pydantic_model: Type[BaseModel]) -> Dict[str, Any]:  # noqa: C901
    """
    Convert a Pydantic model to a JSON schema ready for OpenAI strict structured outputs.

    OpenAI's strict mode requires:
    1. `additionalProperties: false` on EVERY object (root and nested)
    2. All properties must be in the `required` array (no optional fields)
    3. No $ref references (some providers like Azure don't resolve them properly)

    This function recursively transforms the schema to meet these requirements,
    including inlining all $ref references.

    Args:
        pydantic_model: A Pydantic BaseModel class

    Returns:
        JSON schema dict ready for OpenAI's response_format
    """
    schema = pydantic_model.model_json_schema()

    # Extract $defs for reference resolution
    defs = schema.get("$defs", {})

    def resolve_ref(ref: str) -> Dict[str, Any]:
        """Resolve a $ref string to its definition."""
        # Format: "#/$defs/DefinitionName"
        if ref.startswith("#/$defs/"):
            def_name = ref[8:]  # Remove "#/$defs/" prefix
            if def_name in defs:
                # Return a deep copy to avoid mutation issues
                import copy

                return copy.deepcopy(defs[def_name])
        raise ValueError(f"Cannot resolve reference: {ref}")

    def inline_refs(obj: Any) -> Any:
        """Recursively inline all $ref references."""
        if not isinstance(obj, dict):
            return obj

        # If this object contains a $ref, resolve it and merge with other properties
        if "$ref" in obj:
            resolved = resolve_ref(obj["$ref"])
            # Recursively inline any refs in the resolved definition
            resolved = inline_refs(resolved)

            # Merge other properties (like 'default') into the resolved schema
            for key, value in obj.items():
                if key != "$ref":
                    resolved[key] = inline_refs(value) if isinstance(value, (dict, list)) else value
            return resolved

        # Otherwise, recursively process all values
        result = {}
        for key, value in obj.items():
            if isinstance(value, dict):
                result[key] = inline_refs(value)
            elif isinstance(value, list):
                result[key] = [inline_refs(item) for item in value]
            else:
                result[key] = value
        return result

    def add_strict_properties(obj: Dict[str, Any]) -> None:
        """Recursively add additionalProperties: false to all objects."""
        if not isinstance(obj, dict):
            return

        # If this is an object type, handle additionalProperties
        if obj.get("type") == "object":
            existing_additional = obj.get("additionalProperties")

            # If additionalProperties is already a schema (dict), it's a Dict[K,V] type
            # Preserve it and recurse into the schema to add strict properties there
            if isinstance(existing_additional, dict):
                add_strict_properties(existing_additional)
            else:
                # For regular objects, set additionalProperties: false
                obj["additionalProperties"] = False

            # Ensure all properties are required
            if "properties" in obj:
                obj["required"] = list(obj["properties"].keys())

                # Recurse into each property
                for prop in obj["properties"].values():
                    add_strict_properties(prop)

        # Handle anyOf/oneOf/allOf (union types)
        for key in ["anyOf", "oneOf", "allOf"]:
            if key in obj:
                for item in obj[key]:
                    add_strict_properties(item)

        # Handle array items
        if obj.get("type") == "array" and "items" in obj:
            add_strict_properties(obj["items"])

        # Handle $defs (schema definitions for nested models)
        if "$defs" in obj:
            for definition in obj["$defs"].values():
                add_strict_properties(definition)

    # First, inline all $ref references
    schema = inline_refs(schema)

    # Remove $defs since all refs are now inlined
    if "$defs" in schema:
        del schema["$defs"]

    # Then add strict properties
    add_strict_properties(schema)
    return schema


def build_verifier_context_messages(
    context: List[Dict[str, Any]],
    system_prompt: str,
) -> List[Dict[str, Any]]:
    """Build verifier messages with compressed tool results and progressive cache.

    Strips ASSISTANT and SYSTEM messages. Compresses USER + TOOL messages into
    user-role batches, split by prior verifier responses (which become the
    assistant turns to maintain user/assistant alternation).

    Sequential verifier calls share a growing cached prefix:
      call N reads [sys, user_batch1, asst_v1, ..., user_batchN-1, asst_vN-1]
      and writes only user_batchN (the new tool results).
    """
    sorted_context = sorted(
        context,
        key=lambda m: m.get("timestamp", "1970-01-01"),
    )

    messages: List[Dict[str, Any]] = [{"role": "system", "content": system_prompt}]
    current_batch: List[str] = []

    for msg in sorted_context:
        role = msg.get("role", "")
        text = msg.get("text", "")
        metadata = msg.get("metadata", {}) or {}

        if metadata.get("subAgentId"):
            continue
        if role in ("SYSTEM", "ASSISTANT"):
            continue

        if role == "USER":
            current_batch.append(text)
            continue

        if role == "TOOL":
            if metadata.get("toolStatus") == "IN_PROGRESS":
                continue

            if metadata.get("verifierMessage"):
                if current_batch:
                    messages.append({"role": "user", "content": "\n\n".join(current_batch)})
                    current_batch = []
                verifier_text = text
                if metadata.get("title"):
                    verifier_text = f"{metadata['title']}: {text}"
                messages.append({"role": "assistant", "content": verifier_text})
                continue

            tool_name = metadata.get("toolName", "tool")
            title = metadata.get("title")
            prefix = f"[{tool_name}]" + (f" {title}:" if title else ":")
            tool_text = f"{prefix} {text}"
            if metadata.get("structured_response"):
                tool_text += f"\n\nStructured Response: {json.dumps(metadata['structured_response'])}"
            current_batch.append(tool_text)

    current_batch.append("Evaluate the agent's progress as JSON.")
    messages.append({"role": "user", "content": "\n\n".join(current_batch)})

    return messages


def convert_context_to_messages(  # noqa: C901
    context: List[Dict[str, Any]],
    include_system: bool = True,
    # Default False: including assistant messages is prone to reward hacking
    # (agent can bias verifier with its own reasoning)
    include_assistant: bool = False,
) -> List[Dict[str, Any]]:
    """
    Convert workflow context to OpenAI/OpenRouter message format.

    Handles:
    - SYSTEM messages (blueprints): included if include_system=True
    - ASSISTANT messages: included if include_assistant=True (default False to prevent reward hacking)
    - ASSISTANT messages with tool_calls metadata: converted to proper OpenAI format
    - TOOL messages with verifierMessage=True: converted to ASSISTANT role for conversation flow
    - TOOL messages: converted to tool role only if preceded by matching ASSISTANT tool_call,
      otherwise converted to SYSTEM role
    - Skips IN_PROGRESS tool messages (only sends FINISHED results)
    - Sorts messages by timestamp to ensure chronological order
    - FINISHED tool messages use their IN_PROGRESS timestamp for sorting, ensuring tool results
      stay grouped with their ASSISTANT tool_call even if USER messages arrive in between

    Args:
        context: List of message dicts with role/text/metadata
        include_system: Whether to include SYSTEM messages (e.g. blueprints)
        include_assistant: Whether to include ASSISTANT messages (default False to prevent reward hacking)

    Returns:
        List of OpenAI-formatted messages in chronological order
    """
    messages = []

    # Sort context by timestamp to ensure chronological order
    # This is critical after polling for new user messages or continue-as-new
    def parse_timestamp(ts: str) -> datetime:
        """Parse ISO timestamp, defaulting to epoch if missing/invalid."""
        if not ts:
            return datetime(1970, 1, 1)
        try:
            # Handle both with and without timezone
            if ts.endswith("Z"):
                ts = ts[:-1] + "+00:00"
            return datetime.fromisoformat(ts)
        except (ValueError, AttributeError):
            return datetime(1970, 1, 1)

    # Build map of tool_call_id -> IN_PROGRESS timestamp
    # This allows FINISHED messages to use the IN_PROGRESS timestamp for sorting,
    # ensuring tool results stay grouped with their declaring ASSISTANT message
    # even if a USER message arrives before the tool completes
    tool_start_times: Dict[str, str] = {}
    for msg in context:
        meta = msg.get("metadata", {}) or {}
        if msg.get("role") == "TOOL" and meta.get("toolStatus") == "IN_PROGRESS":
            tool_call_id = meta.get("toolCallId")
            if tool_call_id:
                tool_start_times[tool_call_id] = msg.get("timestamp", "")

    def get_timestamp(msg: Dict[str, Any]) -> datetime:
        """Get timestamp for sorting. FINISHED tool messages use their IN_PROGRESS timestamp."""
        meta = msg.get("metadata", {}) or {}

        # For FINISHED tool messages, use the IN_PROGRESS timestamp if available
        # This keeps tool results grouped with their ASSISTANT tool_call, not separated by USER messages
        if msg.get("role") == "TOOL" and meta.get("toolStatus") == "FINISHED":
            tool_call_id = meta.get("toolCallId")
            if tool_call_id and tool_call_id in tool_start_times:
                return parse_timestamp(tool_start_times[tool_call_id])

        return parse_timestamp(msg.get("timestamp", ""))

    # Sort with SYSTEM messages first (but chronological among themselves),
    # then all other messages chronologically
    def sort_key(msg: Dict[str, Any]) -> tuple:
        """Sort key: (is_not_system, timestamp) so SYSTEM messages come first."""
        is_system = msg.get("role") == "SYSTEM"
        timestamp = get_timestamp(msg)
        return (not is_system, timestamp)  # False sorts before True, so SYSTEM first

    sorted_context = sorted(context, key=sort_key)

    # Track which tool_call_ids have been declared by ASSISTANT messages
    declared_tool_ids = set()

    for msg in sorted_context:
        role = msg.get("role", "ASSISTANT")
        content = msg.get("text", "")
        metadata = msg.get("metadata", {}) or {}  # Handle explicit None values

        # Skip ALL sub-agent internal messages regardless of role
        if metadata.get("subAgentId"):
            continue

        if role == "SYSTEM":
            if include_system:
                messages.append({"role": "system", "content": content})

        elif role == "USER":
            messages.append({"role": "user", "content": content})

        elif role == "ASSISTANT":
            if not include_assistant:
                continue

            if metadata.get("tool_calls"):
                for tc in metadata["tool_calls"]:
                    tc_id = str(tc.get("tool_call_id", uuid.uuid4()))
                    declared_tool_ids.add(tc_id)

            # Include tool_calls if present in metadata
            assistant_msg = {"role": "assistant", "content": content}
            if metadata.get("tool_calls"):
                # Convert our tool call format to OpenAI format
                tool_calls = []
                for tc in metadata["tool_calls"]:
                    # Get or generate tool_call_id
                    tc_id = str(tc.get("tool_call_id", uuid.uuid4()))
                    tool_calls.append(
                        {
                            "id": tc_id,
                            "type": "function",
                            "function": {
                                "name": tc.get("tool"),
                                "arguments": json.dumps(
                                    {k: v for k, v in tc.items() if k not in ["tool", "tool_call_id"]}
                                ),
                            },
                        }
                    )
                assistant_msg["tool_calls"] = tool_calls

            messages.append(assistant_msg)

        elif role == "TOOL":
            # Skip IN_PROGRESS messages - only send FINISHED results to LLM
            if metadata.get("toolStatus") == "IN_PROGRESS":
                continue

            # Special handling for verifier messages: convert to ASSISTANT
            # These need to be in the conversation flow for the agent to see them
            if metadata.get("verifierMessage"):
                assistant_content = content
                if metadata.get("title"):
                    assistant_content = f"{metadata['title']}: {content}"
                messages.append({"role": "assistant", "content": assistant_content})
                continue

            tool_call_id = str(metadata.get("toolCallId", ""))

            # Only use tool role if this tool_call_id was declared by a preceding ASSISTANT message
            if tool_call_id and tool_call_id in declared_tool_ids:
                # Use proper tool role with tool_call_id and name
                # Prefix content with title (what user sees in UI) for context
                tool_content = content
                if metadata.get("title"):
                    tool_content = f"{metadata['title']}: {content}"
                # Include structured_response for verifier extraction of full FilePointers
                if metadata.get("structured_response"):
                    tool_content += f"\n\nStructured Response: {json.dumps(metadata['structured_response'])}"
                tool_msg = {"role": "tool", "content": tool_content}
                tool_msg["tool_call_id"] = tool_call_id
                if metadata.get("toolName"):
                    tool_msg["name"] = metadata["toolName"]
                messages.append(tool_msg)
            else:
                # No matching ASSISTANT tool_call - convert to SYSTEM message
                # This handles workflow activities like query_blueprints that post TOOL messages
                # but aren't user-declared tool calls
                system_content = content
                if metadata.get("title"):
                    system_content = f"{metadata['title']}: {content}"
                # Include structured_response for verifier extraction of full FilePointers
                if metadata.get("structured_response"):
                    system_content += f"\n\nStructured Response: {json.dumps(metadata['structured_response'])}"
                messages.append({"role": "system", "content": system_content})

    return messages


async def build_llm_messages(  # noqa: C901
    context: List[Dict],
    system_prompt: str,
    pre_resolved_ids: Optional[set] = None,
) -> List[Dict]:
    """Build messages list for LLM from context, with attachment support.

    This is the primary function for building LLM messages across the codebase.
    It handles:
    - System prompt injection
    - USER messages with file attachments (images, PDFs, text files)
    - ASSISTANT messages
    - TOOL/SYSTEM messages (converted to user role for context)
    - Filters TOOL messages: skips IN_PROGRESS, keeps only latest FINISHED per toolCallId

    For attachments:
    - Small files (<20MB) are downloaded from storage and resolved to multimodal content
    - Large files (>=20MB) are shown as metadata only (LLM can't process large files anyway)
    - Binary files are shown as metadata only

    Downloads are cached within the module to avoid re-downloading the same file.

    Args:
        context: List of message dicts from agent context (role, text, metadata, file_pointer)
        system_prompt: System prompt to prepend

    Returns:
        List of OpenAI-compatible messages ready for LLM
    """
    # Filter TOOL messages: skip IN_PROGRESS, keep only latest terminal message
    # (FINISHED/ERROR) per toolCallId.

    def parse_timestamp(ts) -> datetime:
        """Parse timestamp to datetime, return epoch for invalid/missing."""
        from datetime import timezone

        epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
        if not ts:
            return epoch
        if isinstance(ts, datetime):
            if ts.tzinfo is None:
                return ts.replace(tzinfo=timezone.utc)
            return ts
        try:
            # ISO format: 2024-01-15T10:30:00.000Z
            return datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            return epoch

    tool_messages_by_id: Dict[str, Dict] = {}  # toolCallId -> latest terminal message
    filtered_context = []

    for msg in context:
        role = msg.get("role", "").upper()
        metadata = msg.get("metadata", {}) or {}

        # Skip ALL sub-agent internal messages regardless of role
        if metadata.get("subAgentId"):
            continue

        if role == "TOOL":
            tool_status = metadata.get("toolStatus")
            tool_call_id = metadata.get("toolCallId")

            # Skip IN_PROGRESS messages
            if tool_status == "IN_PROGRESS":
                continue

            # For terminal tool messages, keep only the latest per toolCallId
            if tool_status in ("FINISHED", "ERROR") and tool_call_id:
                existing = tool_messages_by_id.get(tool_call_id)
                if existing:
                    # Compare timestamps properly, keep the later one
                    existing_ts = parse_timestamp(existing.get("timestamp"))
                    new_ts = parse_timestamp(msg.get("timestamp"))
                    if new_ts > existing_ts:
                        tool_messages_by_id[tool_call_id] = msg
                else:
                    tool_messages_by_id[tool_call_id] = msg
                continue

            # TOOL messages without toolCallId or non-FINISHED status - include as-is
            filtered_context.append(msg)
        else:
            # Non-TOOL messages - include as-is
            filtered_context.append(msg)

    # Add the deduplicated TOOL FINISHED messages back
    filtered_context.extend(tool_messages_by_id.values())

    # Sort by timestamp to maintain order (using proper parsing)
    filtered_context.sort(key=lambda x: parse_timestamp(x.get("timestamp")))

    # Use filtered context for the rest of the function
    context = filtered_context

    # NOTE: "Available Files" section was previously appended to system_prompt here,
    # but this mutated the system prompt every time a new file appeared, breaking
    # Anthropic prompt caching (cache is prefix-based, system prompt change = full miss).
    # Files are already embedded as multimodal content in their respective messages,
    # and the static system prompt already has guidance on passing files via attachments.

    def _ts_header(msg: Dict) -> str:
        """Format message timestamp as a short header the LLM can use for temporal context."""
        ts = msg.get("timestamp")
        if not ts:
            return ""
        dt = parse_timestamp(ts)
        if dt.year == 1970:
            return ""
        return f"[{dt.strftime('%Y-%m-%d %H:%M')}] "

    messages = [{"role": "system", "content": system_prompt}]
    declared_tool_call_ids: set[str] = set()

    for msg in context:
        role = msg.get("role", "").upper()
        text = msg.get("text", "")
        metadata = msg.get("metadata", {}) or {}

        # Check for file attachments in multiple places:
        # 1. file_pointer / filePointer - top-level field from DB (OAI-style: each file is a separate message)
        # 2. metadata.attachments - legacy format
        file_pointer = msg.get("file_pointer") or msg.get("filePointer")
        attachments_data = metadata.get("attachments", []) if isinstance(metadata, dict) else []

        # If this message has a file_pointer, treat it as an attachment
        if file_pointer and isinstance(file_pointer, dict):
            attachments_data = [file_pointer] + list(attachments_data)

        # Resolve file attachments (all roles — USER, ASSISTANT, TOOL, SYSTEM)
        content = []  # multimodal content blocks (images, PDFs)
        metadata_texts = []  # text-based content (inline text files, metadata fallbacks)

        for att_data in attachments_data:
            fp = FilePointer.from_dict(att_data) if isinstance(att_data, dict) else None
            if not fp:
                continue

            # Large files or binary files -> metadata only
            if not fp.is_small_enough_for_llm() or not fp.can_be_read_by_llm():
                metadata_texts.append(build_attachment_metadata_text(fp))
                continue

            # Resolve file content: cache first, then live download, then metadata fallback
            file_content = None
            cached = get_cached_file(fp.id) if (pre_resolved_ids and fp.id in pre_resolved_ids) else None
            if cached:
                file_content = cached[0]
            elif activity.in_activity():
                # Live download (activity context — e.g., reasoning, param_populator)
                try:
                    file_content, _ = await get_file_from_pointer(fp)
                except Exception as e:
                    logger.warning(f"Failed to download attachment {fp.original_filename}: {e}")
            else:
                logger.debug(f"Skipping attachment (not cached, not in activity): {fp.original_filename}")

            if file_content is None:
                metadata_texts.append(build_attachment_metadata_text(fp))
                continue

            try:
                base64_data = base64.b64encode(file_content).decode("utf-8")

                if fp.is_image():
                    content.append(
                        {"type": "image_url", "image_url": {"url": f"data:{fp.mime_type};base64,{base64_data}"}}
                    )
                elif fp.is_pdf():
                    content.append(
                        {
                            "type": "file",
                            "file": {
                                "filename": fp.original_filename,
                                "file_data": f"data:{fp.mime_type};base64,{base64_data}",
                            },
                        }
                    )
                elif fp.is_text():
                    try:
                        text_content = file_content.decode("utf-8")
                        metadata_texts.append(f"[File: {fp.original_filename}]\n```\n{text_content}\n```")
                    except UnicodeDecodeError:
                        metadata_texts.append(build_attachment_metadata_text(fp))
            except Exception as e:
                logger.warning(f"Failed to process attachment {fp.original_filename}: {e}")
                metadata_texts.append(build_attachment_metadata_text(fp))

        # Determine LLM role and base text
        ts_prefix = _ts_header(msg)
        if role == "USER":
            llm_role = "user"
            full_text = ts_prefix + text

            if metadata_texts:
                full_text = full_text + "\n\n" + "\n\n".join(metadata_texts)

            if content:
                # Has multimodal content - use content array format
                content.insert(0, {"type": "text", "text": full_text})
                messages.append({"role": llm_role, "content": content})
            else:
                messages.append({"role": llm_role, "content": full_text})
            continue

        if role == "ASSISTANT":
            llm_role = "assistant"
            full_text = ts_prefix + text

            if metadata_texts:
                full_text = full_text + "\n\n" + "\n\n".join(metadata_texts)

            if content:
                # LLM APIs reject multimodal blocks in assistant messages.
                # Convert image/PDF blocks to metadata text so content isn't silently lost.
                for block in content:
                    if block.get("type") == "image_url":
                        full_text += "\n\n[Attached image]"
                    elif block.get("type") == "file":
                        fname = block.get("file", {}).get("filename", "file")
                        full_text += f"\n\n[Attached file: {fname}]"

            assistant_msg: Dict[str, Any] = {"role": llm_role, "content": full_text}

            raw_tool_calls = metadata.get("tool_calls")
            if raw_tool_calls:
                if not isinstance(raw_tool_calls, list):
                    raise ValueError(
                        f"ASSISTANT message metadata.tool_calls must be a list (got {type(raw_tool_calls).__name__})"
                    )
                parsed_tool_calls = []
                for idx, tc in enumerate(raw_tool_calls):
                    if not isinstance(tc, dict):
                        raise ValueError(
                            f"ASSISTANT metadata.tool_calls[{idx}] must be an object (got {type(tc).__name__})"
                        )
                    tool_name = tc.get("tool")
                    tool_call_id = tc.get("tool_call_id")
                    if not tool_name:
                        raise ValueError(f"ASSISTANT metadata.tool_calls[{idx}] missing 'tool'")
                    if not tool_call_id:
                        raise ValueError(
                            f"ASSISTANT metadata.tool_calls[{idx}] missing 'tool_call_id' for tool '{tool_name}'"
                        )
                    declared_tool_call_ids.add(str(tool_call_id))
                    args = {k: v for k, v in tc.items() if k not in ("tool", "tool_call_id")}
                    parsed_tool_calls.append(
                        {
                            "id": str(tool_call_id),
                            "type": "function",
                            "function": {
                                "name": str(tool_name),
                                "arguments": json.dumps(args),
                            },
                        }
                    )
                assistant_msg["tool_calls"] = parsed_tool_calls

            messages.append(assistant_msg)
            continue

        if role == "TOOL":
            # Verifier messages are already mirrored back into context as SYSTEM text.
            # Skip raw verifier TOOL rows to avoid duplicate context.
            if metadata.get("verifierMessage"):
                continue

            tool_status = metadata.get("toolStatus")
            if tool_status == "IN_PROGRESS":
                continue

            tool_call_id = metadata.get("toolCallId")
            tool_name = metadata.get("toolName")

            # Terminal tool messages should match a declared assistant tool_call_id.
            # DAG-created tasks (spawn_agent, reasoning) produce TOOL results with
            # toolCallIds that no ASSISTANT message declares — these are converted to
            # user messages to preserve context without breaking tool_result pairing.
            if tool_status in ("FINISHED", "ERROR"):
                if not tool_call_id:
                    raise ValueError(
                        f"Terminal TOOL message missing toolCallId (toolName={tool_name}, message_id={msg.get('message_id')})"
                    )
                if str(tool_call_id) not in declared_tool_call_ids:
                    # DAG-created tool result — include as user message for context
                    tool_content = text
                    if metadata.get("title"):
                        tool_content = f"{metadata['title']}: {tool_content}"
                    if metadata.get("structured_response"):
                        tool_content += (
                            "\n\nStructured Response: "
                            + json.dumps(metadata["structured_response"])
                        )
                    if metadata_texts:
                        tool_content = tool_content + "\n\n" + "\n\n".join(metadata_texts)
                    if content:
                        for block in content:
                            if block.get("type") == "image_url":
                                tool_content += "\n\n[Attached image]"
                            elif block.get("type") == "file":
                                fname = block.get("file", {}).get("filename", "file")
                                tool_content += f"\n\n[Attached file: {fname}]"
                    label = tool_name or "tool"
                    messages.append({"role": "user", "content": f"{ts_prefix}[{label} result]: {tool_content}"})
                    continue

                tool_content = ts_prefix + text
                if metadata.get("title"):
                    tool_content = f"{ts_prefix}{metadata['title']}: {text}"
                if metadata.get("structured_response"):
                    tool_content += f"\n\nStructured Response: {json.dumps(metadata['structured_response'])}"
                if metadata_texts:
                    tool_content = tool_content + "\n\n" + "\n\n".join(metadata_texts)
                if content:
                    for block in content:
                        if block.get("type") == "image_url":
                            tool_content += "\n\n[Attached image]"
                        elif block.get("type") == "file":
                            fname = block.get("file", {}).get("filename", "file")
                            tool_content += f"\n\n[Attached file: {fname}]"

                tool_msg: Dict[str, Any] = {
                    "role": "tool",
                    "content": tool_content,
                    "tool_call_id": str(tool_call_id),
                }
                if tool_name:
                    tool_msg["name"] = tool_name
                messages.append(tool_msg)
                continue

            # Non-terminal TOOL messages are passed as context text.
            full_text = f"{ts_prefix}[TOOL]: {text}"
            if metadata_texts:
                full_text = full_text + "\n\n" + "\n\n".join(metadata_texts)
            if content:
                content.insert(0, {"type": "text", "text": full_text})
                messages.append({"role": "user", "content": content})
            else:
                messages.append({"role": "user", "content": full_text})
            continue

        if role == "SYSTEM":
            llm_role = "user"
            full_text = f"{ts_prefix}[SYSTEM]: {text}"
        else:
            llm_role = "user"
            full_text = ts_prefix + text

        if metadata_texts:
            full_text = full_text + "\n\n" + "\n\n".join(metadata_texts)

        if content:
            content.insert(0, {"type": "text", "text": full_text})
            messages.append({"role": llm_role, "content": content})
        else:
            messages.append({"role": llm_role, "content": full_text})

    # Merge consecutive assistant messages.  This can happen when the LLM
    # returns bare text (no tool_calls) in one iteration, then tool_calls in the
    # next — both get posted as separate ASSISTANT rows in the DB.
    i = 1
    while i < len(messages):
        if messages[i].get("role") == "assistant" and messages[i - 1].get("role") == "assistant":
            prev = messages[i - 1]
            curr = messages[i]
            merged = (prev.get("content", "") + "\n\n" + curr.get("content", "")).strip()
            prev["content"] = merged
            # Carry forward tool_calls, de-duplicating by ID to protect against
            # dual-write corruption (same tool_call_id in both rows → Anthropic 400).
            prev_tc = prev.get("tool_calls", [])
            curr_tc = curr.get("tool_calls", [])
            if prev_tc or curr_tc:
                seen_ids: set = set()
                merged_tc: list = []
                for tc in prev_tc + curr_tc:
                    tc_id = tc.get("id")
                    if tc_id and tc_id in seen_ids:
                        continue
                    if tc_id:
                        seen_ids.add(tc_id)
                    merged_tc.append(tc)
                prev["tool_calls"] = merged_tc
            messages.pop(i)
        else:
            i += 1

    # Resolve context pointers to <resolved-ref> blocks
    messages = await resolve_pointers_in_messages(messages, local_context=context)

    return messages


async def call_llm_structured_streaming(  # noqa: C901
    messages: List[Dict[str, Any]],
    model: Optional[str],
    temperature: float,
    max_tokens: int,
    response_model: type[T],
    on_chunk: Callable[[str, int], Awaitable[None]],
    reasoning_max_tokens: Optional[int] = None,
    model_preference: Optional[str] = None,
    model_seed: Optional[int] = None,  # Index into Rose model pool (bypasses racing)
    agent_id: Optional[str] = None,  # For cancellation checking
    on_tool_detected: Optional[
        Callable[[str, str], Awaitable[None]]
    ] = None,  # Called when any tool detected (tool_name, tool_call_id)
    on_attention_stream: Optional[
        Callable[[str, str, bool], Awaitable[None]]
    ] = None,  # Called with (tool_call_id, message, is_question) for send_message_to_user
    on_raw_progress: Optional[
        Callable[[int], Awaitable[None]]
    ] = None,  # Called with total accumulated bytes (reasoning + json)
    claude_token: Optional[str] = None,  # User's Claude OAuth token — passed to Rose endpoint for direct Anthropic call
    on_model_detected: Optional[Callable[[str], None]] = None,  # Called with actual_model when first chunk reveals it
    skip_cache_write: bool = False,  # Skip prompt caching (for single-use calls like planner)
    call_site: str = "unknown",  # Label identifying the caller (e.g., plan_loop, execute_loop, planner)
    _is_escalation: bool = False,  # Internal: prevents infinite recursion on max_tokens escalation
) -> Tuple[T, Dict, List[tuple]]:
    """
    Call LLM with structured outputs using streaming, emitting partial text via callback.

    This variant streams the response and calls `on_chunk` when 18+ new characters have
    accumulated since the last emit. A final flush is done at the end for any remaining content.

    Args:
        messages: List of message dicts with 'role' and 'content'
        model: Model to use
        temperature: Sampling temperature
        max_tokens: Maximum tokens
        response_model: Pydantic model class for response structure
        on_chunk: Async callback(text_so_far, token_count) called at streaming intervals
        reasoning_max_tokens: Optional max tokens for reasoning (default 256)
        model_preference: Optional Rose model preference ("SMART", "FAST", "CHEAP")
        agent_id: Optional agent ID for cancellation checking (stops streaming if agent is paused)
        on_tool_detected: Optional callback(tool_name, tool_call_id) when any tool is first detected
        on_raw_progress: Optional callback(total_bytes) called on every chunk with total accumulated bytes

    Returns:
        Tuple of (response_model instance, usage dict with token counts, plan_tool_call_id or None, detected_tools_ordered list)
        Usage dict includes 'cancelled': True if streaming was stopped early
        detected_tools_ordered: List of (tool_name, tool_call_id, timestamp) tuples in detection order
    """
    config = load_config()

    dump_llm_context(
        call_site=call_site,
        messages=messages,
        agent_id=agent_id,
        model=model,
        extra={
            "response_model": response_model.__name__ if response_model else None,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "reasoning_max_tokens": reasoning_max_tokens,
            "skip_cache_write": skip_cache_write,
            "has_claude_token": claude_token is not None,
        },
    )

    # Check if this is a Rose model — route in-process via RoseClient (replaces
    # the Supabase edge function).
    pool = pool_for_model(model) if model else None

    if pool is not None:
        # Prefer the request_id already bound to the trace context so research
        # spans nest under the caller; only mint when nothing is bound.
        request_id = current_request_id() or str(uuid.uuid4())[:8]
        logger.info(
            f"📤 [{request_id}] [{call_site}] Streaming Rose model in-process: {model} pool={pool} skip_cache_write={skip_cache_write}"
        )

        # Build JSON schema from Pydantic model
        schema = prepare_schema_for_openai(response_model)
        response_format = {
            "type": "json_schema",
            "json_schema": {"name": response_model.__name__, "schema": schema, "strict": True},
        }

        # Stream state
        accumulated_reasoning = ""  # Reasoning/thinking text (displayed before response)
        accumulated_json = ""  # JSON content for parsing (waterfall path) or filled at end (claudeAuth)
        last_emitted_text = ""  # Track last emitted text to avoid duplicate sends
        last_emitted_for_chunk = ""  # Track what we've actually sent to on_chunk (for 18-char batching)
        token_count = 0
        actual_model = "unknown"
        pool_name = "unknown"
        pool_size = 0  # No longer surfaced by RoseClient; preserved in usage shape for compat
        claude_token_error: Optional[str] = None  # Set when claudeAuth fell through to waterfall
        final_finish_reason = ""  # From usage chunk (parsers normalize to OpenAI vocabulary)
        was_cancelled = False
        chunk_count = 0
        stream_usage: Optional[Dict[str, Any]] = None

        # claudeAuth-vs-waterfall path tracking. When the active path is
        # claudeAuth (Anthropic native tools), `text_buffer` collects the raw
        # assistant text and `tool_use_blocks` collects native tool_use payloads;
        # we rebuild the {reasoning, response, tool_calls} envelope into
        # `accumulated_json` after the stream so the existing parser works.
        using_claude_auth = False
        text_buffer = ""
        tool_use_blocks: List[Dict[str, Any]] = []

        # Tool detection tracking (for early IN_PROGRESS messages)
        detected_tools_ordered: List[tuple] = []  # (tool_name, tool_call_id, timestamp)
        detected_tool_positions: Dict[str, int] = {}

        # State transition tracking for debugging
        first_reasoning_chunk: Optional[int] = None
        first_response_chunk: Optional[int] = None
        first_tool_calls_chunk: Optional[int] = None

        # Attention message streaming tracking (for send_message_to_user — waterfall only)
        attention_tool_call_id: Optional[str] = None
        last_attention_message = ""

        SKIP_EARLY_PROGRESS = {"send_message_to_user", "attempt_completion"}

        _safe_heartbeat("Starting Rose LLM stream...")
        request_start_time = _safe_time()
        ttft_logged = False

        rose_client = RoseClient()

        try:
            async for chunk in rose_client.complete(
                pool=pool,
                messages=messages,
                response_format=response_format,
                temperature=temperature,
                max_tokens=max_tokens,
                seed=model_seed,
                skip_cache_write=skip_cache_write,
                claude_auth=claude_auth_from_token(claude_token),
                agent_id=agent_id,
                request_id=request_id,
                call_site=call_site,
            ):
                chunk_count += 1

                if not ttft_logged:
                    ttft_ms = int((_safe_time() - request_start_time) * 1000)
                    logger.info(f"⏱️ Rose structured TTFT: {ttft_ms}ms")
                    ttft_logged = True

                kind = chunk.kind

                if kind == "metadata":
                    if chunk.data.get("actual_model"):
                        actual_model = chunk.data["actual_model"]
                        using_claude_auth = actual_model.endswith("-claude")
                        logger.info(
                            f"🎯 Rose model selected: {actual_model} (claudeAuth={using_claude_auth})"
                        )
                        if on_model_detected:
                            on_model_detected(actual_model)
                    if chunk.data.get("pool_name"):
                        pool_name = chunk.data["pool_name"]
                    if chunk.data.get("claude_token_error") and not claude_token_error:
                        claude_token_error = chunk.data["claude_token_error"]
                        logger.warning(f"⚠️ Claude token error from Rose: {claude_token_error}")
                    continue

                if kind == "usage":
                    stream_usage = dict(chunk.data)
                    final_finish_reason = stream_usage.get("finish_reason", "") or final_finish_reason
                    cache_read = stream_usage.get("cache_read_input_tokens", 0) or 0
                    cache_write = stream_usage.get("cache_creation_input_tokens", 0) or 0
                    prompt_tokens = stream_usage.get("prompt_tokens", 0) or 0
                    total_input = prompt_tokens + cache_read + cache_write
                    cache_pct = round(cache_read / total_input * 100) if total_input > 0 else 0
                    logger.info(
                        f"📊 Usage received: prompt={prompt_tokens} completion={stream_usage.get('completion_tokens', 0)} "
                        f"cache_read={cache_read} cache_write={cache_write} cache_hit={cache_pct}% "
                        f"finish={final_finish_reason}"
                    )
                    continue

                if kind == "done":
                    continue

                if kind == "tool_call":
                    # Native Anthropic tool from claudeAuth — buffer for envelope rebuild.
                    args_raw = chunk.data.get("arguments", "")
                    try:
                        parsed_args = json.loads(args_raw) if args_raw else {}
                    except json.JSONDecodeError:
                        parsed_args = {}
                    if not isinstance(parsed_args, dict):
                        parsed_args = {}
                    tool_name = chunk.data.get("name", "") or ""
                    tool_use_blocks.append({"name": tool_name, "input": parsed_args})

                    if first_tool_calls_chunk is None:
                        first_tool_calls_chunk = chunk_count
                        logger.info(f"🔧 C{chunk_count} TOOL_CALLS started (native)")

                    # Fire on_tool_detected for non-attention tools.
                    if on_tool_detected and tool_name and tool_name not in SKIP_EARLY_PROGRESS:
                        tool_call_id = chunk.data.get("id") or str(uuid.uuid4())
                        detected_tools_ordered.append((tool_name, tool_call_id, _safe_time()))
                        position = detected_tool_positions.get(tool_name, 0)
                        detected_tool_positions[tool_name] = position + 1
                        logger.info(
                            f"🔧 Tool detected (native): {tool_name} #{position + 1}, tool_call_id={tool_call_id}"
                        )
                        await on_tool_detected(tool_name, tool_call_id)

                    # send_message_to_user on the claudeAuth path arrives complete; emit
                    # the full message immediately rather than streaming partials.
                    if on_attention_stream and tool_name == "send_message_to_user":
                        attention_tool_call_id = chunk.data.get("id") or str(uuid.uuid4())
                        detected_tools_ordered.append(
                            ("send_message_to_user", attention_tool_call_id, _safe_time())
                        )
                        message_text = parsed_args.get("message", "") or ""
                        is_question = parsed_args.get("is_question", True)
                        if not isinstance(is_question, bool):
                            is_question = True
                        if message_text:
                            await on_attention_stream(attention_tool_call_id, message_text, is_question)
                            last_attention_message = message_text
                    continue

                reasoning_delta = chunk.data.get("text", "") if kind == "reasoning" else ""
                content = chunk.data.get("text", "") if kind == "content" else ""

                if reasoning_delta:
                    if first_reasoning_chunk is None:
                        first_reasoning_chunk = chunk_count
                        logger.info(f"🧠 C{chunk_count} REASONING started")
                    accumulated_reasoning += reasoning_delta

                if content:
                    if using_claude_auth:
                        # claudeAuth text precedes any tool_use blocks; treat as
                        # the eventual response text and emit incrementally.
                        text_buffer += content
                        if first_response_chunk is None:
                            first_response_chunk = chunk_count
                            logger.info(f"💬 C{chunk_count} RESPONSE started (native text)")
                    else:
                        accumulated_json += content
                        if first_response_chunk is None and '"response"' in accumulated_json:
                            first_response_chunk = chunk_count
                            logger.info(f"💬 C{chunk_count} RESPONSE started")
                        if first_tool_calls_chunk is None and '"tool_calls"' in accumulated_json:
                            first_tool_calls_chunk = chunk_count
                            logger.info(f"🔧 C{chunk_count} TOOL_CALLS started")

                token_count = (
                    len(accumulated_reasoning) + len(accumulated_json) + len(text_buffer)
                ) // 4

                # Periodic state log (every 50 chunks).
                if chunk_count % 50 == 0:
                    has_tool_calls = bool(tool_use_blocks) or '"tool_calls"' in accumulated_json
                    has_response = bool(text_buffer) or '"response"' in accumulated_json
                    state = (
                        "reasoning"
                        if reasoning_delta
                        else ("tool_call" if has_tool_calls else ("response" if has_response else "json"))
                    )
                    logger.info(
                        f"🔍 C{chunk_count} state={state} r_len={len(accumulated_reasoning)} "
                        f"json_len={len(accumulated_json)} text_buf={len(text_buffer)} "
                        f"has_tools={has_tool_calls}"
                    )

                # Tool detection on waterfall path — regex-scan accumulated_json.
                if (
                    not using_claude_auth
                    and on_tool_detected
                    and '"tool_calls"' in accumulated_json
                ):
                    tool_matches = re.findall(r'"tool"\s*:\s*"([^"]+)"', accumulated_json)
                    for tool_name in tool_matches:
                        if tool_name in SKIP_EARLY_PROGRESS:
                            continue
                        current_position = detected_tool_positions.get(tool_name, 0)
                        existing_count = sum(1 for t, _, _ in detected_tools_ordered if t == tool_name)
                        if (
                            existing_count < tool_matches.count(tool_name)
                            and existing_count == current_position
                        ):
                            if len(detected_tools_ordered) > 0:
                                completed_tools = _extract_completed_tool_calls(accumulated_json)
                                prev_tool_idx = len(detected_tools_ordered) - 1
                                if prev_tool_idx < len(completed_tools):
                                    prev_tool = completed_tools[prev_tool_idx]
                                    logger.info(
                                        f"📋 Tool #{prev_tool_idx + 1} params captured before tool "
                                        f"#{len(detected_tools_ordered) + 1} IN_PROGRESS: "
                                        f"name={prev_tool.get('tool')} params={prev_tool}"
                                    )
                                else:
                                    logger.warning(
                                        f"⚠️ Could not parse tool #{prev_tool_idx + 1} params "
                                        f"before tool #{len(detected_tools_ordered) + 1} detection. "
                                        f"accumulated_json_tail={accumulated_json[-500:] if len(accumulated_json) > 500 else accumulated_json}"
                                    )
                            tool_call_id = str(uuid.uuid4())
                            detected_tools_ordered.append((tool_name, tool_call_id, _safe_time()))
                            detected_tool_positions[tool_name] = current_position + 1
                            logger.info(
                                f"🔧 Tool detected: {tool_name} #{current_position + 1}, tool_call_id={tool_call_id}"
                            )
                            await on_tool_detected(tool_name, tool_call_id)

                # Attention streaming on waterfall path — progressive partial emit.
                if (
                    not using_claude_auth
                    and on_attention_stream
                    and '"send_message_to_user"' in accumulated_json
                ):
                    if not attention_tool_call_id:
                        attention_tool_call_id = str(uuid.uuid4())
                        detected_tools_ordered.append(
                            ("send_message_to_user", attention_tool_call_id, _safe_time())
                        )
                        logger.info(f"📢 Attention message detected, tool_call_id={attention_tool_call_id}")

                    msg_match = re.search(r'"message"\s*:\s*"((?:[^"\\]|\\.)*)"?', accumulated_json)
                    if msg_match:
                        try:
                            attention_message = json.loads(f'"{msg_match.group(1)}"')
                        except json.JSONDecodeError:
                            attention_message = msg_match.group(1)
                        is_question = True
                        iq_match = re.search(r'"is_question"\s*:\s*(true|false)', accumulated_json)
                        if iq_match:
                            is_question = iq_match.group(1) == "true"
                        if attention_message and attention_message != last_attention_message:
                            last_attention_message = attention_message
                            await on_attention_stream(
                                attention_tool_call_id, attention_message, is_question
                            )

                # Streaming text deltas to caller.
                if using_claude_auth:
                    # claudeAuth: text_buffer is the response text directly.
                    if text_buffer and text_buffer != last_emitted_text:
                        last_emitted_text = text_buffer
                        pending_delta = len(text_buffer) - len(last_emitted_for_chunk)
                        if pending_delta >= 18:
                            await on_chunk(text_buffer, token_count)
                            last_emitted_for_chunk = text_buffer
                else:
                    response_text = _extract_response_from_partial_json(
                        accumulated_reasoning, accumulated_json
                    )
                    if response_text and response_text != last_emitted_text:
                        last_emitted_text = response_text
                        pending_delta = len(response_text) - len(last_emitted_for_chunk)
                        if pending_delta >= 18:
                            await on_chunk(response_text, token_count)
                            last_emitted_for_chunk = response_text

                if chunk_count % 5 == 0:
                    if reasoning_delta:
                        phase = "reasoning"
                    elif detected_tools_ordered:
                        phase = f"tool:{detected_tools_ordered[-1][0]}"
                    elif using_claude_auth and text_buffer:
                        phase = "response"
                    elif '"response"' in accumulated_json:
                        phase = "response"
                    else:
                        phase = "json"
                    _safe_heartbeat(
                        f"C{chunk_count} [{phase}] r={len(accumulated_reasoning)} "
                        f"j={len(accumulated_json)} t={len(text_buffer)}"
                    )

                if on_raw_progress:
                    await on_raw_progress(
                        len(accumulated_reasoning) + len(accumulated_json) + len(text_buffer)
                    )
        except asyncio.CancelledError:
            logger.info("⏹️ Rose streaming cancelled (asyncio.CancelledError)")
            was_cancelled = True
        except RoseError as exc:
            logger.error(
                f"❌ [{request_id}] [{call_site}] Rose streaming failed: {type(exc).__name__}: {exc}"
            )
            raise ValueError(f"Rose streaming failed: {exc}") from exc

        # On the claudeAuth path, rebuild the response-model JSON once the
        # stream is fully drained. The shape depends on the caller's schema:
        #   - Agent envelope `{reasoning, response, tool_calls}`: merge native
        #     text + tool_use blocks via reconstruct_agent_response.
        #   - Any other schema (PlannerResponse, ReasoningResponse, etc.): serialize
        #     the first tool's `input` dict directly. The verifier path at
        #     `_call_llm_verifier` does the same.
        if not was_cancelled and using_claude_auth:
            model_fields = set(response_model.model_fields.keys())
            is_agent_envelope = {"response", "tool_calls"}.issubset(model_fields)
            if tool_use_blocks:
                if is_agent_envelope:
                    accumulated_json = reconstruct_agent_response(text_buffer, tool_use_blocks)
                else:
                    first_input = tool_use_blocks[0].get("input")
                    if not isinstance(first_input, dict):
                        raise ValueError(
                            "Native tool payload must be an object "
                            f"(got {type(first_input).__name__}) for non-envelope schema "
                            f"{response_model.__name__}"
                        )
                    accumulated_json = json.dumps(first_input)
            elif text_buffer:
                # Native text only (no tool_use) — treat as the JSON envelope
                # body; existing markdown/balanced-brace extraction handles it.
                accumulated_json = text_buffer

        if was_cancelled:
            logger.info(f"🛑 Rose streaming cancelled, returning partial usage: {token_count} tokens")
            # Return empty response with partial usage - workflow will handle the pause
            empty_response = response_model.model_validate(
                {"reasoning": "Streaming cancelled by user", "response": "", "tool_calls": []}
            )
            # Use stream_usage if captured before cancellation, otherwise estimate
            if stream_usage:
                usage = {
                    "prompt_tokens": stream_usage.get("prompt_tokens", 0),
                    "completion_tokens": stream_usage.get("completion_tokens", 0),
                    "total_tokens": stream_usage.get("total_tokens", 0),
                    "actual_model": actual_model,
                    "pool_name": pool_name,
                    "pool_size": pool_size,
                    "claude_token_error": claude_token_error,
                    "cancelled": True,
                }
            else:
                usage = {
                    "prompt_tokens": 0,
                    "completion_tokens": token_count,
                    "total_tokens": token_count,
                    "actual_model": actual_model,
                    "pool_name": pool_name,
                    "pool_size": pool_size,
                    "claude_token_error": claude_token_error,
                    "cancelled": True,
                }
            return empty_response, usage, detected_tools_ordered

        logger.info(
            f"🏁 [{call_site}] Rose streaming complete, received {chunk_count} chunks, "
            f"reasoning={len(accumulated_reasoning)} json={len(accumulated_json)} chars, "
            f"finish_reason={final_finish_reason}"
        )

        # Escalate max_tokens on truncation (finish_reason=length) — retry once with 32768
        # Guard: skip escalation if not enough time remains for another streaming call (need 120s headroom)
        elapsed = _safe_time() - request_start_time if request_start_time else 0
        if final_finish_reason == "length" and max_tokens < 32768 and not _is_escalation and elapsed < 180:
            logger.warning(f"⚠️ [{call_site}] Response truncated at max_tokens={max_tokens}, retrying with 32768 (elapsed={elapsed:.1f}s)")

            # Known limitation: the retry restarts text_so_far from "" but callers that
            # track delta state (e.g. last_text[0] in run_agent.py) still hold the first
            # attempt's accumulated text. This causes the caller to emit empty deltas until
            # the retry response exceeds the first attempt's length, then only the tail is
            # shown. The final parsed result is correct — only the live-streaming display
            # is affected. A proper fix requires a stream-reset signal in the on_chunk
            # callback contract (or buffering the first attempt and not calling on_chunk
            # until we know there's no escalation, which defeats streaming).
            first_attempt_chars = len(last_emitted_for_chunk)
            logger.info(
                f"⚠️ [{call_site}] Escalation retry starting — first attempt streamed "
                f"{first_attempt_chars} chars to caller; live-streaming of retry may show "
                f"a content jump on the frontend"
            )

            return await call_llm_structured_streaming(
                messages=messages,
                model=model,
                temperature=temperature,
                max_tokens=32768,
                response_model=response_model,
                on_chunk=on_chunk,
                reasoning_max_tokens=reasoning_max_tokens,
                model_preference=model_preference,
                model_seed=model_seed,
                agent_id=agent_id,
                on_tool_detected=on_tool_detected,
                on_attention_stream=on_attention_stream,
                on_raw_progress=on_raw_progress,
                claude_token=claude_token,
                on_model_detected=on_model_detected,
                skip_cache_write=skip_cache_write,
                call_site=call_site,
                _is_escalation=True,
            )
        elif final_finish_reason == "length" and max_tokens < 32768 and not _is_escalation and elapsed >= 180:
            logger.warning(
                f"⚠️ [{call_site}] Response truncated but skipping escalation — not enough time "
                f"(elapsed={elapsed:.1f}s, need <180s). Returning truncated result."
            )

        # Final emit - flush any remaining content that wasn't sent (under 18 chars)
        # The claudeAuth path streams text_buffer directly (no reasoning prefix),
        # so the final flush must match: otherwise delta-tracking consumers (e.g.
        # call_llm_activity) see the final chunk jump to "reasoning + text" and
        # compute the wrong slice offset.
        if using_claude_auth:
            response_text = text_buffer or None
        else:
            response_text = _extract_response_from_partial_json(
                accumulated_reasoning, accumulated_json
            )
        if response_text and response_text != last_emitted_for_chunk:
            await on_chunk(response_text, token_count)

        # Parse final JSON and validate with Pydantic
        # Rose models output: [explanation text]```json\n{...}\n```
        # We need to extract the JSON from within the markdown code block
        try:
            if not accumulated_json and accumulated_reasoning:
                # Thinking models (GPT-5.2, Kimi-K2.5) may put structured JSON
                # in reasoning tokens instead of content tokens.
                # Use balanced-brace extraction with JSON validation to skip
                # non-JSON brace blocks, then remove from reasoning to prevent leaking.
                search_pos = 0
                while search_pos < len(accumulated_reasoning) and not accumulated_json:
                    json_start = accumulated_reasoning.find("{", search_pos)
                    if json_start == -1:
                        break
                    depth = 0
                    in_string = False
                    escape_next = False
                    matched_end = -1
                    for i in range(json_start, len(accumulated_reasoning)):
                        ch = accumulated_reasoning[i]
                        if escape_next:
                            escape_next = False
                            continue
                        if ch == "\\" and in_string:
                            escape_next = True
                            continue
                        if ch == '"':
                            in_string = not in_string
                            continue
                        if in_string:
                            continue
                        if ch == "{":
                            depth += 1
                        elif ch == "}":
                            depth -= 1
                            if depth == 0:
                                matched_end = i
                                break
                    if matched_end == -1:
                        break
                    candidate = accumulated_reasoning[json_start : matched_end + 1]
                    try:
                        json.loads(candidate)
                        accumulated_json = candidate
                        accumulated_reasoning = (
                            accumulated_reasoning[:json_start] + accumulated_reasoning[matched_end + 1 :]
                        ).strip()
                        logger.info(f"📦 Extracted JSON from reasoning (thinking model, {len(accumulated_json)} chars)")
                    except json.JSONDecodeError:
                        search_pos = matched_end + 1

            if not accumulated_json:
                logger.error(
                    "❌ No JSON content received in Rose response",
                    chunk_count=chunk_count,
                    accumulated_reasoning_len=len(accumulated_reasoning),
                    actual_model=actual_model,
                    pool_name=pool_name,
                )
                raise ValueError(f"No JSON content received in response (chunks={chunk_count}, model={actual_model})")

            # Extract JSON from markdown code block if present
            # Look for ```json ... ``` pattern, or just raw JSON
            json_content = accumulated_json
            explanation_text = ""

            # Check for markdown code block: ```json ... ```
            code_block_match = re.search(r"```(?:json)?\s*(\{[\s\S]*\})\s*```", accumulated_json)
            if code_block_match:
                json_content = code_block_match.group(1)
                # Everything before the code block is explanation
                explanation_text = accumulated_json[: code_block_match.start()].strip()
                logger.info(f"📦 Extracted JSON from markdown code block, explanation={len(explanation_text)} chars")
            else:
                # No code block - try to find raw JSON object using balanced braces
                json_start = accumulated_json.find("{")
                if json_start != -1:
                    explanation_text = accumulated_json[:json_start].strip()
                    # Walk forward to find matching closing brace (handles nested braces)
                    depth = 0
                    in_string = False
                    escape_next = False
                    json_end = -1
                    for i in range(json_start, len(accumulated_json)):
                        c = accumulated_json[i]
                        if escape_next:
                            escape_next = False
                            continue
                        if c == "\\" and in_string:
                            escape_next = True
                            continue
                        if c == '"' and not escape_next:
                            in_string = not in_string
                            continue
                        if in_string:
                            continue
                        if c == "{":
                            depth += 1
                        elif c == "}":
                            depth -= 1
                            if depth == 0:
                                json_end = i
                                break
                    if json_end != -1:
                        json_content = accumulated_json[json_start : json_end + 1]
                        logger.info(f"📦 Extracted raw JSON, explanation={len(explanation_text)} chars")

            parsed_content = json.loads(json_content)

            # Defensive recovery path: malformed upstream streams can sometimes wrap
            # another agent JSON payload inside response text. If outer tool_calls are
            # empty but nested tool_calls exist, unwrap and recover them.
            outer_tool_calls = parsed_content.get("tool_calls")
            outer_response = parsed_content.get("response")
            if (not outer_tool_calls) and isinstance(outer_response, str):
                nested = _extract_nested_agent_json_blob(outer_response)
                if isinstance(nested, dict) and isinstance(nested.get("tool_calls"), list):
                    normalized_nested_tools = []
                    for tc in nested.get("tool_calls", []):
                        if not isinstance(tc, dict):
                            continue
                        if isinstance(tc.get("tool"), str):
                            normalized_nested_tools.append(tc)
                            continue
                        # Legacy/wrapped shape: {"name":"tool_name","arguments":{...}}
                        if isinstance(tc.get("name"), str):
                            args = tc.get("arguments")
                            if isinstance(args, dict):
                                normalized_nested_tools.append({"tool": tc["name"], **args})
                            else:
                                normalized_nested_tools.append({"tool": tc["name"]})

                    if normalized_nested_tools:
                        parsed_content["tool_calls"] = normalized_nested_tools
                        nested_response = nested.get("response")
                        if isinstance(nested_response, str):
                            parsed_content["response"] = nested_response
                        nested_reasoning = nested.get("reasoning")
                        if isinstance(nested_reasoning, str) and nested_reasoning.strip():
                            existing_reasoning = parsed_content.get("reasoning")
                            if not isinstance(existing_reasoning, str) or not existing_reasoning.strip():
                                parsed_content["reasoning"] = nested_reasoning
                        logger.warning(
                            f"Recovered nested tool_calls from wrapped response text: {len(normalized_nested_tools)} call(s)"
                        )

            # Prepend explanation/reasoning to response so it shows in the same section
            combined_reasoning_parts = []
            if accumulated_reasoning and accumulated_reasoning.strip():
                combined_reasoning_parts.append(accumulated_reasoning.strip())

            json_reasoning = parsed_content.get("reasoning")
            if (
                isinstance(json_reasoning, str)
                and json_reasoning.strip()
                and (not combined_reasoning_parts or json_reasoning.strip() != combined_reasoning_parts[0])
            ):
                combined_reasoning_parts.append(json_reasoning.strip())

            if explanation_text:
                combined_reasoning_parts.append(explanation_text)

            combined_reasoning = "\n\n".join(part for part in combined_reasoning_parts if part)

            if combined_reasoning and "response" in parsed_content:
                parsed_content["response"] = combined_reasoning + "\n\n" + parsed_content["response"]

            response = response_model.model_validate(parsed_content)
        except (json.JSONDecodeError, Exception) as e:
            logger.error(
                f"Failed to parse streaming Rose response: json={accumulated_json[:500]}",
                error=extract_error_message(e),
            )
            raise ValueError(f"Failed to parse streaming Rose response as {response_model.__name__}: {str(e)}") from e

        # Use captured stream usage if available, otherwise fall back to estimates
        if stream_usage:
            usage = {
                "prompt_tokens": stream_usage.get("prompt_tokens", 0),
                "completion_tokens": stream_usage.get("completion_tokens", 0),
                "total_tokens": stream_usage.get("total_tokens", 0),
                "actual_model": actual_model,
                "pool_name": pool_name,
                "pool_size": pool_size,
                "claude_token_error": claude_token_error,
                "cancelled": False,
                # Include racing-adjusted values if present
                "winner_prompt_tokens": stream_usage.get("winner_prompt_tokens"),
                "winner_completion_tokens": stream_usage.get("winner_completion_tokens"),
                # Cache metrics from Anthropic prompt caching
                "cache_creation_input_tokens": stream_usage.get("cache_creation_input_tokens", 0),
                "cache_read_input_tokens": stream_usage.get("cache_read_input_tokens", 0),
            }
        else:
            usage = {
                "prompt_tokens": 0,  # Fallback if stream_options not supported
                "completion_tokens": token_count,
                "total_tokens": token_count,
                "actual_model": actual_model,
                "pool_name": pool_name,
                "pool_size": pool_size,
                "claude_token_error": claude_token_error,
                "cancelled": False,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": 0,
            }

        # Deduplicate single-call-per-step tools (keep only first occurrence)
        # These tools should never be called more than once in the same response
        SINGLE_CALL_TOOLS = {"send_message_to_user", "send_message_to_user_execute_phase"}
        if hasattr(response, "tool_calls") and response.tool_calls:
            seen_single_call = set()
            deduplicated_tools = []
            for tc in response.tool_calls:
                if tc and tc.tool in SINGLE_CALL_TOOLS:
                    if tc.tool in seen_single_call:
                        logger.info(f"🔇 Deduplicated {tc.tool} (only one allowed per step)")
                        continue
                    seen_single_call.add(tc.tool)
                deduplicated_tools.append(tc)

            if len(deduplicated_tools) != len(response.tool_calls):
                # Also deduplicate from detected_tools_ordered
                seen_for_detection = set()
                new_detected = []
                for name, tid, ts in detected_tools_ordered:
                    if name in SINGLE_CALL_TOOLS:
                        if name in seen_for_detection:
                            continue
                        seen_for_detection.add(name)
                    new_detected.append((name, tid, ts))
                detected_tools_ordered = new_detected

            response.tool_calls = deduplicated_tools

        return response, usage, detected_tools_ordered

    # For OpenRouter models, use Instructor's partial streaming
    base_client = AsyncOpenAI(api_key=config.openrouter.api_key, base_url=config.openrouter.base_url)

    # Use Instructor's partial streaming mode
    client = instructor.from_openai(base_client, mode=instructor.Mode.JSON)

    extra_args = {}
    if reasoning_max_tokens:
        extra_args["extra_body"] = {"reasoning": {"max_tokens": reasoning_max_tokens}}

    last_emitted_text = ""
    last_emitted_for_chunk = ""  # Track what we've actually sent to on_chunk (for 18-char batching)
    accumulated_text = ""
    final_response = None
    was_cancelled = False
    chunk_count = 0

    # Use create_partial for streaming
    try:
        async for partial in client.chat.completions.create_partial(
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            response_model=response_model,
            **extra_args,
        ):
            chunk_count += 1

            # Heartbeat every 5 chunks - when activity is cancelled, this raises CancelledError
            if chunk_count % 5 == 0:
                _safe_heartbeat(f"OpenRouter streaming chunk {chunk_count}")

            # Extract response text from partial object
            if hasattr(partial, "response") and partial.response:
                current_text = partial.response
                if current_text != last_emitted_text:
                    accumulated_text = current_text
                    last_emitted_text = current_text

                    # Only emit when 18+ new chars since last emit
                    pending_delta = len(accumulated_text) - len(last_emitted_for_chunk)
                    if pending_delta >= 18:
                        token_count = len(accumulated_text) // 4
                        await on_chunk(accumulated_text, token_count)
                        last_emitted_for_chunk = accumulated_text

            final_response = partial

        # Final emit - flush any remaining content that wasn't sent (under 18 chars)
        if not was_cancelled and accumulated_text and accumulated_text != last_emitted_for_chunk:
            await on_chunk(accumulated_text, len(accumulated_text) // 4)

    except asyncio.CancelledError:
        logger.info("⏹️ OpenRouter streaming cancelled (asyncio.CancelledError)")
        was_cancelled = True
    except Exception as e:
        logger.error(f"Streaming LLM call failed: {str(e)}", model=model)
        raise

    # Handle cancellation
    if was_cancelled:
        logger.info("🛑 OpenRouter streaming cancelled, returning partial usage")
        empty_response = response_model.model_validate(
            {"reasoning": "Streaming cancelled by user", "response": "", "tool_calls": []}
        )
        estimated_tokens = len(accumulated_text) // 4
        usage = {
            "prompt_tokens": 0,
            "completion_tokens": estimated_tokens,
            "total_tokens": estimated_tokens,
            "cancelled": True,
        }
        return empty_response, usage, []  # No tool detection in OpenRouter path

    if final_response is None:
        raise ValueError(f"Streaming LLM returned no response (model={model})")

    # Deduplicate single-call-per-step tools (keep only first occurrence)
    # These tools should never be called more than once in the same response
    SINGLE_CALL_TOOLS = {"send_message_to_user", "send_message_to_user_execute_phase"}
    if hasattr(final_response, "tool_calls") and final_response.tool_calls:
        seen_single_call = set()
        deduplicated_tools = []
        for tc in final_response.tool_calls:
            if tc and tc.tool in SINGLE_CALL_TOOLS:
                if tc.tool in seen_single_call:
                    logger.info(f"🔇 Deduplicated {tc.tool} (only one allowed per step)")
                    continue
                seen_single_call.add(tc.tool)
            deduplicated_tools.append(tc)
        final_response.tool_calls = deduplicated_tools

    # Usage not available in Instructor streaming, estimate from content
    estimated_tokens = len(accumulated_text) // 4
    usage = {
        "prompt_tokens": 0,
        "completion_tokens": estimated_tokens,
        "total_tokens": estimated_tokens,
        "cancelled": False,
    }

    return final_response, usage, []  # No tool detection in OpenRouter path


def _extract_completed_tool_calls(accumulated_json: str) -> List[Dict[str, Any]]:
    """
    Extract fully-formed tool call objects from partial JSON stream.
    Returns list of tool calls that have complete params (closed braces).
    """
    completed = []

    # Find tool_calls array start
    tc_match = re.search(r'"tool_calls"\s*:\s*\[', accumulated_json)
    if not tc_match:
        return completed

    # Extract content after tool_calls: [
    array_start = tc_match.end()
    content = accumulated_json[array_start:]

    # Find complete objects by tracking brace depth
    depth = 0
    obj_start = None

    for i, char in enumerate(content):
        if char == "{":
            if depth == 0:
                obj_start = i
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0 and obj_start is not None:
                # Complete object found
                obj_str = content[obj_start : i + 1]
                try:
                    obj = json.loads(obj_str)
                    completed.append(obj)
                except json.JSONDecodeError:
                    pass  # Incomplete or malformed
                obj_start = None

    return completed


def _extract_response_from_partial_json(reasoning: str, json_content: str) -> Optional[str]:
    """
    Extract streamable text from reasoning and partial JSON content.

    Rose models output: [explanation text]```json\n{...}\n```
    We extract explanation text plus JSON `reasoning` and `response` fields.

    Note: send_message_to_user.message is NOT streamed here because it creates
    a separate TOOL message in the DB - streaming it would cause duplicate display.

    Args:
        reasoning: Accumulated reasoning/thinking text (may be empty for Rose)
        json_content: Accumulated content which may include explanation + markdown code block

    Returns:
        Combined text: "reasoning\n\nexplanation\n\nresponse" (whichever parts exist)
    """
    reasoning = reasoning.strip() if reasoning else ""

    # No content yet, just return reasoning
    if not json_content:
        return reasoning if reasoning else None

    # Extract explanation text (everything before the JSON/markdown block)
    explanation = ""
    json_only = json_content

    # Check for markdown code block start
    code_block_start = json_content.find("```")
    if code_block_start > 0:
        explanation = json_content[:code_block_start].strip()
        json_only = json_content[code_block_start:]
    else:
        # Look for raw JSON start
        json_start = json_content.find("{")
        if json_start > 0:
            explanation = json_content[:json_start].strip()
            json_only = json_content[json_start:]

    response_text = ""
    json_reasoning = ""

    # Try to extract response field from the JSON portion
    # First try complete JSON parse
    try:
        # Strip markdown delimiters if present
        clean_json = re.sub(r"^```(?:json)?\s*", "", json_only)
        clean_json = re.sub(r"\s*```$", "", clean_json)
        data = json.loads(clean_json)
        if isinstance(data, dict):
            json_reasoning = data.get("reasoning", "") or ""
            response_text = data.get("response", "") or ""
    except json.JSONDecodeError:
        # Try regex extraction for partial reasoning
        reasoning_match = re.search(r'"reasoning"\s*:\s*"((?:[^"\\]|\\.)*)"?', json_only)
        if reasoning_match:
            try:
                json_reasoning = json.loads(f'"{reasoning_match.group(1)}"')
            except json.JSONDecodeError:
                json_reasoning = reasoning_match.group(1)

        # Try regex extraction for partial JSON
        match = re.search(r'"response"\s*:\s*"((?:[^"\\]|\\.)*)"?', json_only)
        if match:
            try:
                response_text = json.loads(f'"{match.group(1)}"')
            except json.JSONDecodeError:
                response_text = match.group(1)

    # Combine all parts: stream reasoning + json reasoning + explanation + response
    parts = []
    if reasoning:
        parts.append(reasoning)
    if json_reasoning:
        json_reasoning_str = str(json_reasoning) if not isinstance(json_reasoning, str) else json_reasoning
        if not reasoning or json_reasoning_str.strip() != reasoning.strip():
            parts.append(json_reasoning_str)
    if explanation:
        parts.append(explanation)
    if response_text:
        # response_text may be a float (e.g., verifier score 0.0-1.0) - convert to string
        parts.append(str(response_text) if not isinstance(response_text, str) else response_text)

    return "\n\n".join(parts) if parts else None


def _extract_nested_agent_json_blob(text: str) -> Optional[Dict[str, Any]]:
    """
    Best-effort extraction of a nested agent JSON object from text.
    Handles raw JSON and markdown-fenced ```json blocks.
    """
    if not isinstance(text, str) or not text.strip():
        return None

    trimmed = text.strip()
    candidates: List[str] = [trimmed]

    fence_match = re.search(r"```(?:json)?\s*(\{[\s\S]*\})\s*```", trimmed)
    if fence_match:
        candidates.insert(0, fence_match.group(1))
    else:
        start = trimmed.find("{")
        end = trimmed.rfind("}")
        if start != -1 and end != -1 and end > start:
            candidates.append(trimmed[start : end + 1])

    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            continue

    return None


@activity.defn
@traced("call_llm")
async def call_llm(
    messages: List[Dict[str, Any]],
    model: Optional[str] = None,
    temperature: float = 0.7,
    max_tokens: int = 4096,
    response_format: Optional[Dict] = None,
    claude_token: Optional[str] = None,
    skip_cache_write: bool = False,
    call_site: str = "unknown",
    agent_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Call OpenRouter LLM for agent reasoning.

    Args:
        messages: List of message dicts with 'role' and 'content'
        model: Model to use (defaults to config)
        temperature: Sampling temperature (0-2)
        max_tokens: Maximum tokens to generate
        response_format: Optional response format (e.g., {"type": "json_object"})
        call_site: Label identifying the caller (e.g., message_person, context_compression)

    Returns:
        Dict with 'content', 'model', 'usage', etc.
    """
    try:
        _safe_heartbeat(f"Calling LLM with {len(messages)} messages")

        # Resolve context pointers
        messages = await resolve_pointers_in_messages(messages)

        config = load_config()
        model = model or config.openrouter.model

        dump_llm_context(
            call_site=call_site,
            messages=messages,
            agent_id=agent_id,
            model=model,
            response_format=response_format,
            extra={
                "temperature": temperature,
                "max_tokens": max_tokens,
                "skip_cache_write": skip_cache_write,
                "has_claude_token": claude_token is not None,
            },
        )

        # Check if this is a Rose model — route directly to Anthropic / OpenRouter
        # via the in-process RoseClient (replaces the Supabase edge function).
        pool = pool_for_model(model) if model else None

        if pool is not None:
            request_id = current_request_id() or str(uuid.uuid4())[:8]
            logger.info(
                f"📤 [{request_id}] [{call_site}] Routing Rose model in-process: {model} pool={pool} skip_cache_write={skip_cache_write}"
            )

            rose_client = RoseClient()
            try:
                rose_response = await rose_client.collect(
                    pool=pool,
                    messages=messages,
                    response_format=response_format,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    skip_cache_write=skip_cache_write,
                    claude_auth=claude_auth_from_token(claude_token),
                    agent_id=agent_id,
                    request_id=request_id,
                    call_site=call_site,
                )
            except RoseError as exc:
                logger.error(
                    f"❌ [{request_id}] Rose call failed: {type(exc).__name__}: {exc}",
                    request_id=request_id,
                    call_site=call_site,
                )
                raise ValueError(f"Rose call failed: {exc}") from exc

            content = rose_response.content
            usage = rose_response.usage or {}

            result = {
                "content": content,
                "model": rose_response.actual_model or model,
                # Preserve Rose's real finish signal so callers can detect
                # max_tokens truncation; prior code hardcoded "stop" and lost
                # that distinction.
                "finish_reason": usage.get("finish_reason", "stop"),
                "usage": {
                    "prompt_tokens": usage.get("prompt_tokens", 0),
                    "completion_tokens": usage.get("completion_tokens", 0),
                    "total_tokens": usage.get("total_tokens", 0),
                },
            }

            logger.info(
                f"📥 [{request_id}] LLM call complete (Rose)",
                request_id=request_id,
                model=rose_response.actual_model or model,
                pool=rose_response.pool_name or pool,
                tokens=result["usage"]["total_tokens"],
                content_length=len(content),
                content_preview=content[:100] if content else "EMPTY",
            )

            return result

        # Use OpenRouter for all other models
        client = AsyncOpenAI(api_key=config.openrouter.api_key, base_url=config.openrouter.base_url)

        # Call OpenRouter
        response = await client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            response_format=response_format,
        )

        # Log full response to debug
        logger.info(
            "Raw LLM response",
            has_choices=len(response.choices) > 0,
            message_dict=response.choices[0].message.model_dump() if response.choices else None,
            finish_reason=response.choices[0].finish_reason if response.choices else None,
        )

        content = response.choices[0].message.content or ""

        result = {
            "content": content,
            "model": response.model,
            "finish_reason": response.choices[0].finish_reason,
            "usage": {
                "prompt_tokens": response.usage.prompt_tokens,
                "completion_tokens": response.usage.completion_tokens,
                "total_tokens": response.usage.total_tokens,
            },
        }

        logger.info(
            "LLM call complete",
            model=model,
            tokens=result["usage"]["total_tokens"],
            content_length=len(content),
            content_preview=content[:100] if content else "EMPTY",
        )

        return result

    except Exception as e:
        logger.error("LLM call failed", error=extract_error_message(e))
        raise


# NOTE: decide_next_action was removed - it was dead code (never called)
# The run_agent loop handles LLM calls directly via call_llm_structured_streaming


async def _call_llm_verifier(  # noqa: C901
    messages: List[Dict[str, Any]],
    model: str,
    config: Any,
    response_schema: Optional[Dict[str, Any]] = None,
    claude_token: Optional[str] = None,
    call_site: str = "verifier",
    agent_id: Optional[str] = None,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """
    Simple LLM call for verifier - no streaming UI, no tool detection.

    Args:
        messages: Chat messages for the LLM
        model: Model to use
        config: Application config
        response_schema: Optional response schema to include output extraction
        claude_token: Optional Claude OAuth token for direct Anthropic calls

    Returns:
        Tuple of (parsed JSON dict with reasoning, score, and optionally output), usage dict)
    """
    pool = pool_for_model(model)
    if pool is None:
        raise ValueError(
            f"_call_llm_verifier requires a Rose model (got {model!r}); "
            f"non-Rose verifier path is not supported."
        )

    response_format = _build_verifier_json_schema(response_schema)

    dump_llm_context(
        call_site=call_site,
        messages=messages,
        agent_id=agent_id,
        model=model,
        response_format=response_format,
        extra={"pool": pool, "has_claude_token": claude_token is not None},
    )

    accumulated_reasoning = ""
    accumulated_json = ""
    actual_model = "unknown"
    pool_name = "unknown"
    claude_token_error: Optional[str] = None
    tool_use_blocks: List[Dict[str, Any]] = []
    chunk_count = 0
    stream_usage: Optional[Dict[str, Any]] = None

    stream_interrupted = False
    verifier_request_id = current_request_id() or str(uuid.uuid4())[:8]
    rose_client = RoseClient()
    try:
        async for chunk in rose_client.complete(
            pool=pool,
            messages=messages,
            response_format=response_format,
            temperature=0.3,
            max_tokens=4096,
            claude_auth=claude_auth_from_token(claude_token),
            agent_id=agent_id,
            request_id=verifier_request_id,
            call_site=call_site,
        ):
            chunk_count += 1
            if chunk_count % 10 == 0:
                _safe_heartbeat(f"Verifier streaming... {chunk_count} chunks")

            kind = chunk.kind
            if kind == "metadata":
                actual_model = chunk.data.get("actual_model", actual_model)
                pool_name = chunk.data.get("pool_name", pool_name)
                if chunk.data.get("claude_token_error") and not claude_token_error:
                    claude_token_error = chunk.data["claude_token_error"]
                    logger.warning(f"⚠️ Verifier claude token error: {claude_token_error}")
            elif kind == "content":
                accumulated_json += chunk.data.get("text", "")
            elif kind == "reasoning":
                accumulated_reasoning += chunk.data.get("text", "")
            elif kind == "tool_call":
                # claudeAuth path uses native tools — buffer them and rebuild
                # the {"reasoning","response","tool_calls"} envelope at the end.
                args_raw = chunk.data.get("arguments", "")
                try:
                    parsed_args = json.loads(args_raw) if args_raw else {}
                except json.JSONDecodeError:
                    parsed_args = {}
                if not isinstance(parsed_args, dict):
                    parsed_args = {}
                tool_use_blocks.append({
                    "name": chunk.data.get("name", ""),
                    "input": parsed_args,
                })
            elif kind == "usage":
                stream_usage = dict(chunk.data)
            elif kind == "done":
                pass
    except RoseError as e:
        stream_interrupted = True
        logger.warning(
            f"Verifier RoseClient error after {chunk_count} chunks, "
            f"accumulated json={len(accumulated_json)} chars, reasoning={len(accumulated_reasoning)} chars: {e}"
        )

    # Native tool_use blocks from claudeAuth → rebuild the verifier JSON envelope
    # so the existing parser (which expects a single {reasoning, score, ...} blob)
    # finds it via accumulated_json. Note the verifier schema is
    # {reasoning, score, ...}, NOT the agent-envelope shape
    # {reasoning, response, tool_calls} that `reconstruct_agent_response`
    # produces — serialize the first tool's `input` dict directly.
    if tool_use_blocks:
        first_input = tool_use_blocks[0].get("input")
        if not isinstance(first_input, dict):
            raise ValueError(
                "Verifier native tool payload must be an object "
                f"(got {type(first_input).__name__})"
            )
        accumulated_json = json.dumps(first_input)

    cache_read = stream_usage.get("cache_read_input_tokens", 0) if stream_usage else 0
    cache_write = stream_usage.get("cache_creation_input_tokens", 0) if stream_usage else 0
    prompt_toks = stream_usage.get("prompt_tokens", 0) if stream_usage else 0
    logger.info(
        f"🏁 [{call_site}] Verifier streaming complete: {chunk_count} chunks, reasoning={len(accumulated_reasoning)}, json={len(accumulated_json)}, interrupted={stream_interrupted}, cache_read={cache_read}, cache_write={cache_write}"
    )

    # Parse JSON - handle thinking models that put JSON in reasoning
    json_content = accumulated_json

    if not json_content and accumulated_reasoning:
        # Thinking models might put JSON in reasoning
        json_match = re.search(r"\{[\s\S]*\}", accumulated_reasoning)
        if json_match:
            json_content = json_match.group(0)
            logger.info("📦 Extracted JSON from reasoning (thinking model)")

    if not json_content:
        raise ValueError(f"No JSON content received (chunks={chunk_count}, model={actual_model})")

    parsed = json.loads(json_content)

    usage = {
        "prompt_tokens": prompt_toks,
        "completion_tokens": stream_usage.get("completion_tokens", chunk_count) if stream_usage else chunk_count,
        "total_tokens": stream_usage.get("total_tokens", chunk_count) if stream_usage else chunk_count,
        "actual_model": actual_model,
        "pool_name": pool_name,
        "claude_token_error": claude_token_error,
        "cache_creation_input_tokens": cache_write,
        "cache_read_input_tokens": cache_read,
    }

    return parsed, usage


def _build_verifier_json_schema(response_schema: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Build a JSON schema for the verifier response.

    If response_schema is provided, includes an 'output' field with the schema fields.
    The output is always included in the response, but should only be used when score >= 1.0.

    Args:
        response_schema: Optional response schema with fields definition

    Returns:
        JSON schema dict for use with OpenAI structured outputs
    """
    # Base schema always has reasoning and score
    properties = {"reasoning": {"type": "string"}, "score": {"type": "number", "minimum": 0, "maximum": 1}}
    required = ["reasoning", "score"]

    # If response_schema provided, add output field
    if response_schema and response_schema.get("fields"):
        output_properties = {}
        output_required = []

        for field in response_schema["fields"]:
            field_name = field["name"]
            field_type = field["type"]

            # Map our types to JSON schema types
            if field_type == "str":
                json_type = {"type": "string"}
            elif field_type == "int":
                json_type = {"type": "integer"}
            elif field_type == "float":
                json_type = {"type": "number"}
            elif field_type == "bool":
                json_type = {"type": "boolean"}
            elif field_type == "list[str]":
                json_type = {"type": "array", "items": {"type": "string"}}
            elif field_type == "list[int]":
                json_type = {"type": "array", "items": {"type": "integer"}}
            elif field_type == "file_pointer":
                # Full FilePointer schema - used by main agent and spawn_sub_agent verifiers
                # Expects context to contain full FilePointer with all fields populated
                file_pointer_schema = {
                    "type": "object",
                    "description": "Full file reference with all metadata. Copy ALL fields exactly from 'Structured Response' in context.",
                    "properties": {
                        "id": {
                            "type": "string",
                            "description": "File UUID. MUST copy exactly from Structured Response.",
                        },
                        "storage_path": {
                            "type": "string",
                            "description": "Supabase storage path. MUST copy exactly from Structured Response.",
                        },
                        "original_filename": {
                            "type": "string",
                            "description": "Original filename. MUST copy exactly from Structured Response.",
                        },
                        "mime_type": {
                            "type": "string",
                            "description": "MIME type (e.g., image/jpeg). MUST copy exactly from Structured Response.",
                        },
                        "size_bytes": {
                            "type": "integer",
                            "description": "File size in bytes. MUST copy exactly from Structured Response.",
                        },
                        "created_at": {
                            "type": "string",
                            "description": "ISO timestamp. MUST copy exactly from Structured Response.",
                        },
                    },
                    "required": ["id", "storage_path", "original_filename", "mime_type", "size_bytes", "created_at"],
                    "additionalProperties": False,
                }
                json_type = file_pointer_schema
            elif field_type == "list[file_pointer]":
                # List of full FilePointers
                file_pointer_schema = {
                    "type": "object",
                    "description": "Full file reference with all metadata. Copy ALL fields exactly from 'Structured Response' in context.",
                    "properties": {
                        "id": {
                            "type": "string",
                            "description": "File UUID. MUST copy exactly from Structured Response.",
                        },
                        "storage_path": {
                            "type": "string",
                            "description": "Supabase storage path. MUST copy exactly from Structured Response.",
                        },
                        "original_filename": {
                            "type": "string",
                            "description": "Original filename. MUST copy exactly from Structured Response.",
                        },
                        "mime_type": {
                            "type": "string",
                            "description": "MIME type (e.g., image/jpeg). MUST copy exactly from Structured Response.",
                        },
                        "size_bytes": {
                            "type": "integer",
                            "description": "File size in bytes. MUST copy exactly from Structured Response.",
                        },
                        "created_at": {
                            "type": "string",
                            "description": "ISO timestamp. MUST copy exactly from Structured Response.",
                        },
                    },
                    "required": ["id", "storage_path", "original_filename", "mime_type", "size_bytes", "created_at"],
                    "additionalProperties": False,
                }
                json_type = {"type": "array", "items": file_pointer_schema}
            elif field_type == "session_file_pointer":
                # Session file pointer - used by cloud agent verifiers (spawn_claude_code_agent, spawn_browser_agent)
                # Only extracts the path from terminal output - activity handles download/upload
                session_file_pointer_schema = {
                    "type": "object",
                    "description": "File reference from remote session. Extract the ABSOLUTE file path from terminal output.",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "ABSOLUTE file path starting with /. Example: '/home/user/output/report.pdf'. Extract the full path exactly as shown in terminal output.",
                        }
                    },
                    "required": ["path"],
                    "additionalProperties": False,
                }
                json_type = session_file_pointer_schema
            elif field_type == "list[session_file_pointer]":
                # List of session file pointers
                session_file_pointer_schema = {
                    "type": "object",
                    "description": "File reference from remote session. Extract the ABSOLUTE file path from terminal output.",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "ABSOLUTE file path starting with /. Example: '/home/user/output/report.pdf'. Extract the full path exactly as shown in terminal output.",
                        }
                    },
                    "required": ["path"],
                    "additionalProperties": False,
                }
                json_type = {"type": "array", "items": session_file_pointer_schema}
            else:
                json_type = {"type": "string"}  # Default fallback

            output_properties[field_name] = json_type

            # All fields are required in the output for strict mode
            output_required.append(field_name)

        properties["output"] = {
            "type": "object",
            "properties": output_properties,
            "required": output_required,
            "additionalProperties": False,
        }
        required.append("output")

    return {
        "type": "json_schema",
        "json_schema": {
            "name": "ProgressScoreWithOutput" if response_schema else "ProgressScore",
            "schema": {"type": "object", "properties": properties, "required": required, "additionalProperties": False},
            "strict": True,
        },
    }


@activity.defn
@traced("check_progress")
async def check_progress(
    context: List[Dict[str, Any]],
    verifier_system_prompt: str,
    model: str = "rose-labs/rose-1-lite",
    phase: str = "EXECUTE",  # Kept for backward compat but no longer used
    response_schema: Optional[Dict[str, Any]] = None,
    claude_token: Optional[str] = None,
    call_site: str = "verifier",
    agent_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Use LLM judge to check progress toward goal.

    Args:
        context: Message history (first USER message is the goal)
        verifier_system_prompt: Pre-built verifier system prompt (from build_verifier_prompt)
        model: LLM model to use
        phase: Deprecated - no longer used (prompt is pre-built by caller)
        response_schema: Response schema for structured output extraction
        claude_token: Optional Claude OAuth token for direct Anthropic calls

    Returns:
        Dict with 'score' (float 0.0-1.0), 'reasoning' (str), and optionally 'structured_response'
    """
    # If no schema provided, use empty schema for output extraction
    if not response_schema:
        response_schema = {"fields": []}

    try:
        # DEBUG: Log what we received
        logger.info(
            "🔍 DEBUG: check_progress received",
            context_type=type(context).__name__,
            context_len=len(context) if context else 0,
            none_count=sum(1 for m in context if m is None) if context else 0,
        )
        if context:
            for i, m in enumerate(context):
                if m is None:
                    logger.error(f"❌ context[{i}] is None!")
                elif not isinstance(m, dict):
                    logger.error(f"❌ context[{i}] is {type(m).__name__}, not dict: {str(m)[:200]}")

        _safe_heartbeat("Checking progress with LLM judge")

        config = load_config()
        system_prompt = verifier_system_prompt

        messages = build_verifier_context_messages(context, system_prompt)

        # Resolve context pointers
        messages = await resolve_pointers_in_messages(messages, local_context=context)

        # Debug: Log context size to detect contamination
        logger.info(
            "Verifier context",
            total_messages=len(context),
            agent_messages=len([m for m in context if m.get("role") == "ASSISTANT"]),
            system_messages_excluded=len([m for m in context if m.get("role") == "SYSTEM"]),
            context_summary=[f"{m.get('role')}: {m.get('text', '')[:50]}..." for m in context[-5:]],  # Last 5 messages
        )

        # === RAW CONTEXT LOG: Full original context for debugging ===
        logger.debug(
            "📦 Verifier raw context (pre-conversion)",
            raw_context_json=json.dumps(context, ensure_ascii=False, default=str),
        )

        # Use dedicated verifier LLM call (simple, no streaming UI)
        # Pass response_schema so the verifier includes output extraction in same call
        # Retry with exponential backoff + jitter on transient failures (e.g. malformed JSON from streaming)
        max_retries = 5
        base_delay = 0.2  # 0.2s -> 0.4s -> 0.8s -> 1.6s -> 3.2s
        last_error = None
        for attempt in range(max_retries + 1):
            try:
                result, usage = await _call_llm_verifier(
                    messages,
                    model,
                    config,
                    response_schema,
                    claude_token=claude_token,
                    call_site=call_site,
                    agent_id=agent_id,
                )
                break
            except Exception as e:
                last_error = e
                if attempt < max_retries:
                    delay = base_delay * (2**attempt)
                    jitter = random.uniform(0, delay * 0.5)
                    logger.warning(
                        "Verifier call failed, retrying",
                        attempt=attempt + 1,
                        max_retries=max_retries,
                        delay=round(delay + jitter, 3),
                        error=str(e)[:200],
                    )
                    await asyncio.sleep(delay + jitter)
                else:
                    raise last_error from last_error

        score = result["score"]
        reasoning = result["reasoning"]

        logger.info(
            "Progress checked",
            progress=score,
            reasoning=reasoning,
            tokens=usage.get("total_tokens", 0),
            actual_model=usage.get("actual_model"),
            pool_name=usage.get("pool_name"),
            has_output="output" in result,
        )

        # Only use output when score >= 1.0 (schema enforcement is handled by strict JSON schema)
        structured_response = result.get("output") if score >= 1.0 else None

        return {
            "score": score,
            "reasoning": reasoning,
            "message": f"{reasoning}\n\nScore: {score}",
            "usage": usage,
            "structured_response": structured_response,
        }
    except Exception as e:
        logger.error("Failed to check progress", error=extract_error_message(e))
        # Return 0.5 on error to keep agent running, with empty usage
        error_message = f"Progress check failed: {str(e)}"
        return {
            "score": 0.5,
            "reasoning": error_message,
            "message": f"{error_message}\n\nScore: 0.5",
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            "structured_response": None,
        }


@activity.defn
@traced("call_llm_activity")
async def call_llm_activity(  # noqa: C901
    messages_or_agent_id: Any,
    model: str,
    tool_names: List[str],
    reasoning_max_tokens: int = 256,
    agent_id: Optional[str] = None,
    stream_id: Optional[str] = None,
    task_id: Optional[str] = None,
    claude_token: Optional[str] = None,
    call_site: str = "unknown",
    system_prompt: Optional[str] = None,
    extra_user_message: Optional[str] = None,
    required_tool: Optional[str] = None,
    skip_cache_write: bool = False,
) -> Dict[str, Any]:
    """
    Activity wrapper for LLM calls with structured output and streaming.

    Used by run_agent when called from workflow context (not inside activity).
    Provides proper Temporal activity retries, heartbeating, and streaming to Supabase Realtime.

    Args:
        messages_or_agent_id: Either pre-built messages list OR an agent_id string.
            When agent_id string: reads context from _pending_llm_context shared state,
            builds messages inside the activity (so file downloads work and base64
            content never crosses the Temporal 2MB payload boundary).
            On cross-machine miss, falls back to fetching context from backend API.
        model: Model to use
        tool_names: List of tool names for dynamic AgentAction model
        reasoning_max_tokens: Max reasoning tokens (0 disables)
        agent_id: Agent ID for streaming (optional)
        stream_id: Stream session ID for ordering (optional)
        task_id: Sub-agent task ID for routing to browser panel (optional)
        system_prompt: System prompt for cross-machine fallback. When the activity
            runs on a different worker, _pending_llm_context is empty; the activity
            fetches messages from the backend API and uses this prompt.
        extra_user_message: Optional user message appended after building messages.
            Used for param population — prompts the LLM to call a specific tool
            without changing system prompt/tools (preserves cache prefix).
        required_tool: If set, validates the LLM called this tool. Raises ValueError
            if the tool is not in the response.
        skip_cache_write: If True, skips message-level cache breakpoint (avoids
            writing a cache entry for the unique trailing message) but keeps
            system+tools markers so the shared prefix can still be read from cache.

    Returns:
        Dict with:
        - response: Assistant response text
        - tool_calls: List of tool call dicts
        - usage: Token usage dict
    """
    try:
        _safe_heartbeat("Calling LLM for structured output")

        # Resolve messages: either pre-built or build from shared context
        _context_key = None
        if isinstance(messages_or_agent_id, str):
            _context_key = messages_or_agent_id
            pending = _pending_llm_context.get(_context_key)
            if pending is None:
                await asyncio.sleep(0.5)
                pending = _pending_llm_context.get(_context_key)
            if pending is not None:
                context, _sys_prompt, pre_resolved_ids = pending
                messages = await build_llm_messages(context, _sys_prompt, pre_resolved_ids=pre_resolved_ids)
            elif system_prompt:
                # Cross-machine fallback: activity landed on a different worker.
                # Fetch messages from backend; files download live via activity.in_activity().
                from helpers.fetch_config import _fetch_agent_data_impl

                logger.info("Cross-machine LLM context fallback", agent_id=_context_key)
                data = await _fetch_agent_data_impl(_context_key)
                context = data.get("messages", [])
                messages = await build_llm_messages(context, system_prompt, pre_resolved_ids=None)
                _pending_llm_context[_context_key] = (context, system_prompt, None)
            else:
                raise ValueError(
                    f"No pending LLM context for agent {_context_key} and no system_prompt provided"
                )
        else:
            # Legacy: pre-built messages list passed directly
            messages = messages_or_agent_id

        if extra_user_message:
            messages.append({"role": "user", "content": extra_user_message})

        # Create dynamic action model
        AgentActionModel = create_agent_action_model(tool_names)

        # _is_claude detected from actual_model in stream response, not from input model/token
        _is_claude = [False]  # Mutable list so closures can update it

        def on_model_detected(actual_model: str):
            # "-claude" suffix = user's own Claude token ($0, skipped racing)
            # e.g. "claude-sonnet-4-6-claude", "claude-opus-4-7-claude"
            is_user_claude = actual_model.endswith("-claude")
            _is_claude[0] = is_user_claude
            logger.info(f"🎨 Claude detection: actual_model={actual_model}, is_claude={is_user_claude}")

        # Streaming callback - posts directly to Supabase Realtime
        sequence = [0]
        last_text = [""]

        async def on_chunk(text_so_far: str, tokens: int):
            _safe_heartbeat(f"LLM streaming... {len(text_so_far)} chars")
            if agent_id and stream_id:
                delta = text_so_far[len(last_text[0]) :]
                if delta:
                    await stream_assistant_chunk(
                        agent_id=agent_id,
                        stream_id=stream_id,
                        delta=delta,
                        done=False,
                        sequence=sequence[0],
                        sub_agent_id=task_id,
                        is_claude=_is_claude[0],
                    )
                    sequence[0] += 1
                last_text[0] = text_so_far

        # Callback for early tool detection IN_PROGRESS messages
        async def on_tool_detected_callback(tool_name: str, tool_call_id: str):
            if agent_id and stream_id:
                await stream_tool_event(
                    agent_id=agent_id,
                    stream_id=stream_id,
                    tool_call_id=tool_call_id,
                    tool_name=tool_name,
                    title=f"Starting {tool_name}...",
                )

        result, usage, detected_tools_ordered = await call_llm_structured_streaming(
            messages=messages,
            model=model,
            temperature=1.0,
            max_tokens=8192,
            response_model=AgentActionModel,
            on_chunk=on_chunk,
            reasoning_max_tokens=reasoning_max_tokens if reasoning_max_tokens > 0 else None,
            agent_id=agent_id,
            on_tool_detected=on_tool_detected_callback,
            claude_token=claude_token,
            on_model_detected=on_model_detected,
            call_site=call_site,
            skip_cache_write=skip_cache_write,
        )

        # Send final done=True chunk
        if agent_id and stream_id:
            try:
                final_delta = ""
                if hasattr(result, "response") and result.response:
                    final_delta = result.response[len(last_text[0]) :]
                await stream_assistant_chunk(
                    agent_id=agent_id,
                    stream_id=stream_id,
                    delta=final_delta,
                    done=True,
                    sequence=sequence[0],
                    sub_agent_id=task_id,
                    is_claude=_is_claude[0],
                )
            except Exception as e:
                logger.warning(f"Final stream chunk failed (non-fatal): {e}")

        # Validate result
        if result is None:
            raise ValueError(f"LLM returned None result (model={model})")

        if not hasattr(result, "response") or not hasattr(result, "tool_calls"):
            raise ValueError(f"LLM result missing required fields (model={model})")

        # Convert tool calls to dicts
        tool_calls_dict = []
        if result.tool_calls:
            for tc in result.tool_calls:
                if tc is not None:
                    tc_dict = tc.model_dump() if hasattr(tc, "model_dump") else tc.dict()
                    tool_calls_dict.append(tc_dict)

        if required_tool:
            matching = [tc for tc in tool_calls_dict if tc.get("tool") == required_tool]
            if not matching:
                got = [tc.get("tool") for tc in tool_calls_dict]
                raise ValueError(
                    f"LLM did not call required tool '{required_tool}'. Got: {got}"
                )

        logger.info(
            "LLM activity completed",
            response_len=len(result.response) if result.response else 0,
            tool_calls=len(tool_calls_dict),
            tokens=usage.get("total_tokens", 0),
        )

        # Clean up shared state on success
        if _context_key:
            _pending_llm_context.pop(_context_key, None)

        return {
            "response": result.response if result.response else "",
            "tool_calls": tool_calls_dict,
            "usage": usage,
            "detected_tools_ordered": detected_tools_ordered,  # [(tool_name, tool_call_id, timestamp), ...]
        }

    except Exception as e:
        # Do NOT clean up _pending_llm_context here — Temporal may retry the activity,
        # and the retry needs the shared state to still be present.
        # Cleanup happens on success (above) or when the workflow finishes/cancels.
        logger.error("LLM activity failed", error=extract_error_message(e))
        raise


@activity.defn
@traced("set_response_schema_activity")
async def set_response_schema_activity(
    agent_id: str,
    user_messages: List[str],
) -> Optional[Dict[str, Any]]:
    """
    Generate and save a structured response schema for an agent.

    Takes all user messages from the conversation context and squashes them
    into a single goal string for schema generation.

    Args:
        agent_id: Agent ID to generate schema for
        user_messages: List of user message texts from conversation context

    Returns:
        The generated schema dict with 'fields' array, or None on failure
    """
    import time

    activity_start = time.perf_counter()

    config = load_config()
    backend_url = config.backend.api_url.rstrip("/")
    api_key = config.backend.api_key

    if not api_key:
        logger.error("BACKEND_API_KEY not configured - cannot generate response schema")
        return None

    # Squash all user messages into one goal string
    goal = "\n\n".join(user_messages) if user_messages else ""

    if not goal:
        logger.error("No user messages provided for schema generation", agent_id=agent_id)
        return None

    _safe_heartbeat("Generating response schema via backend API")
    logger.info(f"[TIMING] Starting response schema generation for agent {agent_id}")

    try:
        async with httpx.AsyncClient(timeout=90.0) as client:
            # 1. Generate schema using Rose Ultra
            api_start = time.perf_counter()
            schema_response = await client.post(
                f"{backend_url}/api/agents/generate-response-schema",
                headers=backend_api_headers(api_key),
                json={"goal": goal},
            )
            schema_response.raise_for_status()
            schema_data = schema_response.json()
            api_elapsed = time.perf_counter() - api_start
            logger.info(f"[TIMING] Schema generation API call: {api_elapsed * 1000:.1f}ms ({api_elapsed:.2f}s)")

            schema = schema_data.get("schema")
            tokens_in = schema_data.get("tokensIn", 0)
            tokens_out = schema_data.get("tokensOut", 0)

            if not schema:
                logger.error("No schema returned from generation", agent_id=agent_id)
                return None

            logger.info(
                "Generated response schema",
                agent_id=agent_id,
                field_count=len(schema.get("fields", [])),
                tokens_in=tokens_in,
                tokens_out=tokens_out,
            )

            # 2. Save schema to agent record
            save_start = time.perf_counter()
            save_response = await client.patch(
                f"{backend_url}/api/agents/{agent_id}",
                headers=backend_api_headers(api_key),
                json={"response_schema": schema},
            )
            save_elapsed = time.perf_counter() - save_start
            logger.info(f"[TIMING] Schema save API call: {save_elapsed * 1000:.1f}ms")

            if not save_response.is_success:
                logger.warning(
                    "Failed to save response schema", agent_id=agent_id, status_code=save_response.status_code
                )
            else:
                logger.info("Saved response schema to agent", agent_id=agent_id)

            activity_elapsed = time.perf_counter() - activity_start
            logger.info(
                f"[TIMING] Total response schema activity: {activity_elapsed * 1000:.1f}ms ({activity_elapsed:.2f}s)"
            )
            return {
                "schema": schema,
                "usage": {
                    "prompt_tokens": tokens_in,
                    "completion_tokens": tokens_out,
                    "total_tokens": tokens_in + tokens_out,
                },
            }

    except httpx.HTTPStatusError as e:
        logger.error(
            "Backend API error generating response schema",
            agent_id=agent_id,
            status_code=e.response.status_code,
            response_text=e.response.text[:500],
        )
        return None
    except Exception as e:
        logger.error("Failed to generate response schema", agent_id=agent_id, error=extract_error_message(e))
        return None


@activity.defn
async def fetch_claude_max_token_activity(user_id: str) -> Optional[Dict[str, Any]]:
    """
    Fetch Claude Max OAuth token for a user from the backend.

    Returns dict with {accessToken, source, poolTokenId} on success, None otherwise.
    - source: 'user' (personal token) or 'pool' (shared pool token)
    - poolTokenId: integration ID for pool tokens (used to mark rate-limited on failure)
    """
    config = load_config()
    _safe_heartbeat("Fetching Claude Max token")

    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{config.backend.api_url}/api/integrations/claude-code/credentials/token",
                headers={
                    "X-API-Key": config.backend.api_key or "",
                    "X-User-Id": user_id,
                },
                timeout=15.0,
            )
            if response.status_code == 200:
                data = response.json()
                token = data.get("accessToken")
                if token:
                    source = data.get("source", "user")
                    pool_token_id = data.get("poolTokenId")
                    logger.info(
                        f"✅ Claude Max token fetched for user {user_id} (source={source})"
                    )
                    return {
                        "accessToken": token,
                        "source": source,
                        "poolTokenId": pool_token_id,
                    }
            elif response.status_code == 404:
                logger.info(f"Claude Max credentials not found for user {user_id}")
            else:
                logger.warning(f"Claude Max token fetch failed: {response.status_code}")
    except Exception as e:
        logger.warning(f"Failed to fetch Claude Max token: {e}")

    return None


@activity.defn
async def mark_claude_token_rate_limited_activity(
    source: str,
    user_id: str,
    pool_token_id: Optional[str] = None,
    cooldown_seconds: int = 5 * 60,
) -> bool:
    """
    Mark the current Claude token as rate-limited in the backend for a cooldown period.

    This is the CRITICAL step that makes token rotation work. Without it, the next
    fetch returns the same rate-limited token and we loop forever. After this call:
      - If source='user': next getClaudeCodeToken falls back to the shared pool.
      - If source='pool': fetchPoolToken excludes this token (LRU rotates to next).

    The cooldown is time-windowed (default 5 min); the token auto-heals once
    rateLimitedUntil passes. This is NOT a permanent disable.
    """
    config = load_config()
    rate_limited_until = (
        datetime.now(timezone.utc) + timedelta(seconds=cooldown_seconds)
    ).isoformat().replace("+00:00", "Z")

    body: Dict[str, Any] = {
        "source": source,
        "rateLimitedUntil": rate_limited_until,
    }
    if source == "pool" and pool_token_id:
        body["poolTokenId"] = pool_token_id
    if source == "user":
        body["userId"] = user_id

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{config.backend.api_url}/api/integrations/claude-code/token/rate-limited",
                headers={
                    "X-API-Key": config.backend.api_key or "",
                    "X-User-Id": user_id,
                    "Content-Type": "application/json",
                },
                json=body,
                timeout=10.0,
            )
            if response.status_code == 200:
                logger.info(
                    f"✅ Marked {source} Claude token rate-limited until {rate_limited_until}"
                )
                return True
            logger.warning(
                f"Failed to mark token rate-limited: {response.status_code} {response.text[:200]}"
            )
    except Exception as e:
        logger.warning(f"Error marking token rate-limited: {e}")

    return False


@activity.defn
@traced("call_planner_llm_activity")
async def call_planner_llm_activity(
    messages: List[Dict[str, Any]],
    model: str,
    tools_description: str,
    user_context: str,
    response_schema: Optional[Dict[str, Any]] = None,
    claude_max_token: Optional[str] = None,
    agent_id: Optional[str] = None,
    tool_call_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Temporal activity for calling the dedicated planner LLM.

    The planner receives conversation context and generates an execution plan
    with tasks and dependencies. Streams char count to frontend via PLAN_STREAM.

    When claude_max_token is provided, it's passed to the Rose completions endpoint
    which calls Anthropic directly ($0 cost via user's Claude subscription).
    If that fails, the endpoint falls back to racing automatically.

    Args:
        messages: Conversation history (user/assistant messages)
        model: LLM model to use
        tools_description: Description of tools available in execute phase
        user_context: User context for personalization
        response_schema: Optional structured output schema the agent should return
        claude_max_token: Optional Claude OAuth token for direct Anthropic calls via Rose endpoint
        agent_id: Agent ID for streaming plan progress to frontend
        tool_call_id: Tool call ID for linking streaming to final plan

    Returns:
        Dict from PlannerResponse.model_dump() with title, content, tasks, dependencies_graph, join
    """
    import time

    from utils.prompts import build_planner_system_prompt
    from utils.tool_schemas import PlannerResponse

    activity_start = time.perf_counter()
    _safe_heartbeat("Calling planner LLM")

    # Build system prompt for planner
    prompt_start = time.perf_counter()
    system_prompt = build_planner_system_prompt(tools_description, user_context, response_schema=response_schema)
    prompt_elapsed = time.perf_counter() - prompt_start
    logger.info(f"[TIMING] Planner system prompt build: {prompt_elapsed * 1000:.1f}ms")

    # Prepend system message
    full_messages = [{"role": "system", "content": system_prompt}] + messages

    # Resolve context pointers
    full_messages = await resolve_pointers_in_messages(full_messages)

    total_chars = sum(len(m.get("content", "")) for m in full_messages)
    logger.info(f"[TIMING] Planner input: {len(full_messages)} messages, {total_chars} chars total")

    # Stream plan char count to frontend via PLAN_STREAM events
    # Use tool_call_id as stream_id so Temporal retries update the same chip (not create duplicates)
    plan_stream_id = tool_call_id or str(uuid.uuid4())
    last_broadcast_len = [0]

    async def on_plan_heartbeat(text: str, count: int):
        _safe_heartbeat(f"Planner thinking... {len(text)} chars")

    async def on_plan_progress(total_bytes: int):
        """Called every 5 chunks with total accumulated bytes (reasoning + json)."""
        # Only broadcast when 50+ new bytes since last broadcast
        if agent_id and tool_call_id and total_bytes - last_broadcast_len[0] >= 50:
            last_broadcast_len[0] = total_bytes
            await stream_plan_event(
                agent_id=agent_id,
                stream_id=plan_stream_id,
                tool_call_id=tool_call_id,
                title="Generating Plan",
                char_count=total_bytes,
            )

    try:
        llm_start = time.perf_counter()
        result, usage, _ = await call_llm_structured_streaming(
            messages=full_messages,
            model=model,
            # Keep planner sampling conservative to reduce tool-selection drift.
            temperature=0.2,
            max_tokens=16384,
            response_model=PlannerResponse,
            on_chunk=on_plan_heartbeat,
            on_raw_progress=on_plan_progress,
            agent_id=agent_id,
            claude_token=claude_max_token,
            skip_cache_write=True,  # Plan is generated once per iteration — no cache reuse
            call_site="planner",
        )
        llm_elapsed = time.perf_counter() - llm_start
        activity_elapsed = time.perf_counter() - activity_start

        tokens_in = usage.get("prompt_tokens", 0)
        tokens_out = usage.get("completion_tokens", 0)
        logger.info(
            "Planner LLM completed",
            title=result.title,
            task_count=len(result.tasks),
            join=result.join,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
        )
        logger.info(
            f"[TIMING] Planner LLM API call: {llm_elapsed * 1000:.1f}ms ({llm_elapsed:.2f}s), total activity: {activity_elapsed * 1000:.1f}ms"
        )

        # Return plan with usage for cost tracking
        # Use actual_model from Rose response (may be "claude-opus-4-7-claude" for $0 pricing)
        actual_model = usage.get("actual_model", model)
        return {
            "result": result.model_dump(),
            "usage": {
                "llm": [
                    {
                        "tokens_in": tokens_in,
                        "tokens_out": tokens_out,
                        "model": actual_model,
                        "provider": "Rose Planner",
                    }
                ],
                "service": [],
            },
        }

    except Exception as e:
        logger.error("Planner LLM failed", error=extract_error_message(e))
        raise
