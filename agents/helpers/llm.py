"""LLM tool for agent reasoning and decision making."""

import asyncio
import base64
import re
import uuid
import time  # Import at module level for Temporal workflow sandbox compatibility
from datetime import datetime
from typing import List, Dict, Optional, Any, TypeVar, Type, AsyncIterator, Tuple, Callable, Awaitable
from temporalio import activity
import structlog
import json
from openai import AsyncOpenAI
from pydantic import BaseModel
import instructor  # Import at module level for Temporal workflow sandbox compatibility
import httpx  # Used with instructor

from config import load_config
from helpers.get_user_context import fetch_user_context
from helpers.error_utils import extract_error_message
from helpers.prompts import build_system_prompt, build_verifier_prompt
from helpers.tool_schemas import (
    ProgressScore,
    create_agent_action_model,
)
from helpers.messages import stream_assistant_chunk, stream_tool_event, stream_attention_event, stream_plan_event
from tools.base import ToolSchema
from helpers.attachments import (
    FilePointer,
    build_attachment_metadata_text,
    get_file_from_pointer,
)

logger = structlog.get_logger()


def _safe_heartbeat(message: str) -> None:
    """Call activity.heartbeat() if we're in an activity context, otherwise silently skip."""
    try:
        activity.heartbeat(message)
    except Exception:
        pass  # Not in activity context - running from workflow


def _safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox where time.time() is restricted."""
    try:
        return time.time()
    except Exception:
        return 0.0  # Workflow sandbox - TTFT logging will show 0ms

T = TypeVar('T', bound=BaseModel)
def prepare_schema_for_openai(pydantic_model: Type[BaseModel]) -> Dict[str, Any]:
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


def convert_context_to_messages(
    context: List[Dict[str, Any]],
    include_system: bool = True,
    # Default False: including assistant messages is prone to reward hacking
    # (agent can bias verifier with its own reasoning)
    include_assistant: bool = False
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
            if ts.endswith('Z'):
                ts = ts[:-1] + '+00:00'
            return datetime.fromisoformat(ts)
        except (ValueError, AttributeError):
            return datetime(1970, 1, 1)
    
    # Build map of tool_call_id -> IN_PROGRESS timestamp
    # This allows FINISHED messages to use the IN_PROGRESS timestamp for sorting,
    # ensuring tool results stay grouped with their declaring ASSISTANT message
    # even if a USER message arrives before the tool completes
    tool_start_times: Dict[str, str] = {}
    for msg in context:
        meta = msg.get('metadata', {}) or {}
        if msg.get('role') == 'TOOL' and meta.get('toolStatus') == 'IN_PROGRESS':
            tool_call_id = meta.get('toolCallId')
            if tool_call_id:
                tool_start_times[tool_call_id] = msg.get('timestamp', '')
    
    def get_timestamp(msg: Dict[str, Any]) -> datetime:
        """Get timestamp for sorting. FINISHED tool messages use their IN_PROGRESS timestamp."""
        meta = msg.get('metadata', {}) or {}
        
        # For FINISHED tool messages, use the IN_PROGRESS timestamp if available
        # This keeps tool results grouped with their ASSISTANT tool_call, not separated by USER messages
        if msg.get('role') == 'TOOL' and meta.get('toolStatus') == 'FINISHED':
            tool_call_id = meta.get('toolCallId')
            if tool_call_id and tool_call_id in tool_start_times:
                return parse_timestamp(tool_start_times[tool_call_id])
        
        return parse_timestamp(msg.get('timestamp', ''))
    
    # Sort with SYSTEM messages first (but chronological among themselves),
    # then all other messages chronologically
    def sort_key(msg: Dict[str, Any]) -> tuple:
        """Sort key: (is_not_system, timestamp) so SYSTEM messages come first."""
        is_system = msg.get('role') == 'SYSTEM'
        timestamp = get_timestamp(msg)
        return (not is_system, timestamp)  # False sorts before True, so SYSTEM first
    
    sorted_context = sorted(context, key=sort_key)
    
    # Track which tool_call_ids have been declared by ASSISTANT messages
    declared_tool_ids = set()
    
    for msg in sorted_context:
        role = msg.get('role', 'ASSISTANT')
        content = msg.get('text', '')
        metadata = msg.get('metadata', {}) or {}  # Handle explicit None values
        
        if role == 'SYSTEM':
            if include_system:
                messages.append({"role": "system", "content": content})
                
        elif role == 'USER':
            messages.append({"role": "user", "content": content})
            
        elif role == 'ASSISTANT':
            # Still track declared tool IDs even if not including assistant messages
            # This ensures TOOL messages can be properly matched
            if metadata.get('tool_calls'):
                for tc in metadata['tool_calls']:
                    tc_id = str(tc.get('tool_call_id', uuid.uuid4()))
                    declared_tool_ids.add(tc_id)

            if not include_assistant:
                continue

            # Include tool_calls if present in metadata
            assistant_msg = {"role": "assistant", "content": content}
            if metadata.get('tool_calls'):
                # Convert our tool call format to OpenAI format
                tool_calls = []
                for tc in metadata['tool_calls']:
                    # Get or generate tool_call_id
                    tc_id = str(tc.get('tool_call_id', uuid.uuid4()))
                    tool_calls.append({
                        "id": tc_id,
                        "type": "function",
                        "function": {
                            "name": tc.get('tool'),
                            "arguments": json.dumps({k: v for k, v in tc.items() if k not in ['tool', 'tool_call_id']})
                        }
                    })
                assistant_msg["tool_calls"] = tool_calls

            messages.append(assistant_msg)
            
        elif role == 'TOOL':
            # Skip IN_PROGRESS messages - only send FINISHED results to LLM
            if metadata.get('toolStatus') == 'IN_PROGRESS':
                continue
            
            # Special handling for verifier messages: convert to ASSISTANT
            # These need to be in the conversation flow for the agent to see them
            if metadata.get('verifierMessage'):
                assistant_content = content
                if metadata.get('title'):
                    assistant_content = f"{metadata['title']}: {content}"
                messages.append({"role": "assistant", "content": assistant_content})
                continue
            
            tool_call_id = str(metadata.get('toolCallId', ''))
            
            # Only use tool role if this tool_call_id was declared by a preceding ASSISTANT message
            if tool_call_id and tool_call_id in declared_tool_ids:
                # Use proper tool role with tool_call_id and name
                # Prefix content with title (what user sees in UI) for context
                tool_content = content
                if metadata.get('title'):
                    tool_content = f"{metadata['title']}: {content}"
                # Include structured_response for verifier extraction of full FilePointers
                if metadata.get('structured_response'):
                    tool_content += f"\n\nStructured Response: {json.dumps(metadata['structured_response'])}"
                tool_msg = {"role": "tool", "content": tool_content}
                tool_msg["tool_call_id"] = tool_call_id
                if metadata.get('toolName'):
                    tool_msg["name"] = metadata['toolName']
                messages.append(tool_msg)
            else:
                # No matching ASSISTANT tool_call - convert to SYSTEM message
                # This handles workflow activities like query_blueprints that post TOOL messages
                # but aren't user-declared tool calls
                system_content = content
                if metadata.get('title'):
                    system_content = f"{metadata['title']}: {content}"
                # Include structured_response for verifier extraction of full FilePointers
                if metadata.get('structured_response'):
                    system_content += f"\n\nStructured Response: {json.dumps(metadata['structured_response'])}"
                messages.append({"role": "system", "content": system_content})

    return messages


async def build_llm_messages(context: List[Dict], system_prompt: str) -> List[Dict]:
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
    # Filter TOOL messages: skip IN_PROGRESS, keep only latest FINISHED per toolCallId
    # This ensures condensed results replace full results in context

    def parse_timestamp(ts) -> datetime:
        """Parse timestamp to datetime, return epoch for invalid/missing."""
        if not ts:
            return datetime.min
        if isinstance(ts, datetime):
            return ts
        try:
            # ISO format: 2024-01-15T10:30:00.000Z
            return datetime.fromisoformat(ts.replace('Z', '+00:00'))
        except (ValueError, AttributeError):
            return datetime.min

    tool_messages_by_id: Dict[str, Dict] = {}  # toolCallId -> latest FINISHED message
    filtered_context = []

    for msg in context:
        role = msg.get("role", "").upper()
        metadata = msg.get("metadata", {}) or {}

        if role == "TOOL":
            tool_status = metadata.get("toolStatus")
            tool_call_id = metadata.get("toolCallId")

            # Skip IN_PROGRESS messages
            if tool_status == "IN_PROGRESS":
                continue

            # For FINISHED messages, keep only the latest per toolCallId
            if tool_status == "FINISHED" and tool_call_id:
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

    # First pass: collect all unique file_pointers from context
    # This builds an explicit list of available files for the LLM
    available_files: Dict[str, str] = {}  # filename -> mime_type
    for msg in context:
        file_pointer = msg.get("file_pointer") or msg.get("filePointer")
        if file_pointer and isinstance(file_pointer, dict):
            fp = FilePointer.from_dict(file_pointer)
            if fp.original_filename and fp.original_filename not in available_files:
                available_files[fp.original_filename] = fp.mime_type

    # Append "Available Files" section to system prompt if files exist
    # This ensures the LLM knows exactly what files it can pass to sub-agents
    if available_files:
        files_list = "\n".join([f"- {name} ({mime})" for name, mime in available_files.items()])
        system_prompt = system_prompt + f"""

## Available Files
Files in your context (use exact filenames):
{files_list}

To pass files to spawn_browser_agent, spawn_claude_code_agent, or spawn_sub_agent:
  attachments: [{", ".join([f'"{name}"' for name in available_files.keys()])}]"""

    messages = [{"role": "system", "content": system_prompt}]

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

        if role == "USER":
            if attachments_data:
                # Build multimodal message with attachments
                content = []
                metadata_texts = []

                for att_data in attachments_data:
                    fp = FilePointer.from_dict(att_data) if isinstance(att_data, dict) else None
                    if not fp:
                        continue

                    # Large files or binary files -> metadata only
                    if not fp.is_small_enough_for_llm() or not fp.can_be_read_by_llm():
                        metadata_texts.append(build_attachment_metadata_text(fp))
                        continue

                    # Skip downloads in workflow context (httpx uses threading.local which Temporal sandbox blocks)
                    # Downloads only work inside activity context
                    if not activity.in_activity():
                        logger.debug(f"Skipping attachment download in workflow context: {fp.original_filename}")
                        metadata_texts.append(build_attachment_metadata_text(fp))
                        continue

                    # Download file from storage (uses module-level cache)
                    try:
                        file_content, file_metadata = await get_file_from_pointer(fp)
                        base64_data = base64.b64encode(file_content).decode("utf-8")

                        if fp.is_image():
                            # Image: inject as image_url content block
                            content.append({
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:{fp.mime_type};base64,{base64_data}"
                                }
                            })
                        elif fp.is_pdf():
                            # PDF: inject as file content block (for capable models)
                            content.append({
                                "type": "file",
                                "file": {
                                    "filename": fp.original_filename,
                                    "file_data": f"data:{fp.mime_type};base64,{base64_data}"
                                }
                            })
                        elif fp.is_text():
                            # Text: inject as text content
                            try:
                                text_content = file_content.decode("utf-8")
                                metadata_texts.append(f"[File: {fp.original_filename}]\n```\n{text_content}\n```")
                            except UnicodeDecodeError:
                                metadata_texts.append(build_attachment_metadata_text(fp))
                    except Exception as e:
                        logger.warning(f"Failed to download/process attachment {fp.original_filename}: {e}")
                        metadata_texts.append(build_attachment_metadata_text(fp))

                # Build final content
                full_text = text
                if metadata_texts:
                    full_text = text + "\n\n" + "\n\n".join(metadata_texts)

                if content:
                    # Has multimodal content - use content array format
                    content.insert(0, {"type": "text", "text": full_text})
                    messages.append({"role": "user", "content": content})
                else:
                    # No multimodal content - just text
                    messages.append({"role": "user", "content": full_text})
            else:
                messages.append({"role": "user", "content": text})
        elif role == "ASSISTANT":
            messages.append({"role": "assistant", "content": text})
        elif role in ("TOOL", "SYSTEM"):
            messages.append({"role": "user", "content": f"[{role}]: {text}"})

    return messages


async def call_llm_structured_streaming(
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
    on_tool_detected: Optional[Callable[[str, str], Awaitable[None]]] = None,  # Called when any tool detected (tool_name, tool_call_id)
    on_attention_stream: Optional[Callable[[str, str, bool], Awaitable[None]]] = None,  # Called with (tool_call_id, message, is_question) for send_message_to_user
    on_raw_progress: Optional[Callable[[int], Awaitable[None]]] = None,  # Called with total accumulated bytes (reasoning + json)
    claude_token: Optional[str] = None,  # User's Claude OAuth token — passed to Rose endpoint for direct Anthropic call
    on_model_detected: Optional[Callable[[str], None]] = None,  # Called with actual_model when first chunk reveals it
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
    
    # Check if this is a Rose model - route to Supabase edge function with streaming
    is_rose_model = model is not None and ('rose-labs' in model.lower() or model.lower() in ['rose', 'rose-ultra'])
    
    if is_rose_model:
        # Generate unique request ID for tracing
        request_id = str(uuid.uuid4())[:8]
        logger.info(f"📤 [{request_id}] Streaming Rose model via Supabase: {model} → {config.rose.api_url}")

        # Build JSON schema from Pydantic model
        schema = prepare_schema_for_openai(response_model)
        
        request_body = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": True,  # Enable SSE streaming
            "stream_options": {"include_usage": True},  # Get token usage in final chunk
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": response_model.__name__,
                    "schema": schema,
                    "strict": True
                }
            }
        }
        
        if model_preference:
            request_body["model_preference"] = model_preference
            logger.info(f"🎯 Streaming with model_preference: {model_preference}")

        if model_seed is not None:
            request_body["model_seed"] = model_seed
            logger.info(f"🎯 Streaming with model_seed: {model_seed}")

        if claude_token:
            request_body["claude_token"] = claude_token
            logger.info("🔑 Passing claude_token to Rose endpoint for direct Anthropic call")

        # Add reasoning config for reasoning models (Gemini, Anthropic, etc.)
        if reasoning_max_tokens:
            request_body["reasoning"] = {"max_tokens": reasoning_max_tokens}
            logger.info(f"🧠 Streaming with reasoning max_tokens: {reasoning_max_tokens}")
        
        # Stream SSE from Rose endpoint
        accumulated_reasoning = ""  # Reasoning/thinking text (displayed before response)
        accumulated_json = ""  # JSON content for parsing
        last_emitted_text = ""  # Track last emitted text to avoid duplicate sends
        last_emitted_for_chunk = ""  # Track what we've actually sent to on_chunk (for 18-char batching)
        token_count = 0
        actual_model = "unknown"
        actual_model_logged = False
        pool_name = "unknown"
        pool_size = 0
        was_cancelled = False
        chunk_count = 0
        stream_usage = None  # Captured from final chunk with stream_options
        
        # Tool detection tracking (for early IN_PROGRESS messages)
        detected_tools_ordered: List[tuple] = []  # (tool_name, tool_call_id, timestamp)
        detected_tool_positions: Dict[str, int] = {}  # tool_name -> count detected (for tracking multiple same-name tools)
        
        # State transition tracking for debugging
        first_reasoning_chunk: Optional[int] = None
        first_response_chunk: Optional[int] = None
        first_tool_calls_chunk: Optional[int] = None
        
        # Attention message streaming tracking (for send_message_to_user)
        attention_tool_call_id: Optional[str] = None
        last_attention_message = ""
        
        try:
            # Log outbound request summary for debugging 400s
            logger.debug(
                "📤 Rose streaming request payload",
                model=request_body.get("model"),
                message_count=len(messages),
                has_response_format=bool(request_body.get("response_format")),
                has_reasoning=bool(request_body.get("reasoning")),
                messages_summary=[
                    {
                        "index": i,
                        "role": m.get("role"),
                        "has_content": bool(m.get("content")),
                        "tool_calls": [
                            {
                                "id": tc.get("id"),
                                "name": tc.get("function", {}).get("name"),
                                "has_arguments": "arguments" in tc.get("function", {}),
                                "arguments_type": type(tc.get("function", {}).get("arguments")).__name__,
                                "arguments_preview": str(tc.get("function", {}).get("arguments"))[:50] if tc.get("function", {}).get("arguments") else "MISSING"
                            }
                            for tc in m.get("tool_calls", [])
                        ] if m.get("tool_calls") else None,
                        "tool_call_id": m.get("tool_call_id") if m.get("role") == "tool" else None
                    }
                    for i, m in enumerate(messages)
                ]
            )
            
            # Log FULL request for replay/debugging slow requests
            log_body = {k: v for k, v in request_body.items() if k != "claude_token"}
            logger.info(
                "📋 Rose structured request FULL (for replay)",
                url=config.rose.api_url,
                request_body_json=json.dumps(log_body, default=str),
            )
            
            # Heartbeat before starting - catches cancellation if pause was already clicked
            _safe_heartbeat("Starting Rose LLM stream...")
            
            request_start_time = _safe_time()
            ttft_logged = False
            
            async with httpx.AsyncClient(timeout=300.0) as http_client:
                async with http_client.stream(
                    'POST',
                    config.rose.api_url,
                    json=request_body,
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {config.rose.supabase_anon_key}",
                        "x-api-key": config.rose.api_key,
                        "x-request-id": request_id,
                    }
                ) as stream_response:
                    stream_response.raise_for_status()
                    
                    # Heartbeat after connection established - catches cancellation during initial request
                    _safe_heartbeat("Rose stream connected, waiting for chunks...")
                    logger.info(f"🔄 [{request_id}] Rose streaming response started, status={stream_response.status_code}")
                    
                    async for line in stream_response.aiter_lines():
                        chunk_count += 1
                        
                        # Log TTFT on first chunk
                        if not ttft_logged:
                            ttft_ms = int((_safe_time() - request_start_time) * 1000)
                            logger.info(f"⏱️ Rose structured TTFT: {ttft_ms}ms")
                            ttft_logged = True
                        
                        # Heartbeat moved to after content processing (see below)
                        
                        if chunk_count == 1:
                            logger.info(f"📦 First streaming line received")
                        
                        if not line or not line.startswith('data: '):
                            continue
                        
                        data_str = line[6:]  # Remove 'data: ' prefix
                        if data_str == '[DONE]':
                            break
                        try:
                            chunk_data = json.loads(data_str)
                            # logger.info(f"📊 Streaming chunk data: {chunk_data}")
                            # Extract model info from first chunk
                            if chunk_data.get("actual_model") and not actual_model_logged:
                                actual_model = chunk_data["actual_model"]
                                actual_model_logged = True
                                logger.info(f"🎯 Rose model selected: {actual_model}")
                                if on_model_detected:
                                    on_model_detected(actual_model)
                            if chunk_data.get("pool_name"):
                                pool_name = chunk_data["pool_name"]
                            if chunk_data.get("pool_size"):
                                pool_size = chunk_data["pool_size"]

                            # Capture usage from final chunk (sent when stream_options.include_usage=true)
                            if chunk_data.get("usage"):
                                stream_usage = chunk_data["usage"]
                                logger.info(f"📊 Usage received: prompt={stream_usage.get('prompt_tokens', 0)} completion={stream_usage.get('completion_tokens', 0)}")

                            # Extract delta content
                            delta = chunk_data.get("choices", [{}])[0].get("delta", {})
                            
                            # Extract reasoning from delta.reasoning (GPT-5.2, Gemini, DeepSeek use this)
                            # NOTE: For structured streaming, reasoning is logged but NOT added to accumulated_content
                            # because accumulated_content must be valid JSON for parsing at the end
                            reasoning_delta = delta.get("reasoning") or ""
                            content = delta.get("content") or ""
                            fin = chunk_data.get("choices", [{}])[0].get("finish_reason") or ""
                            
                            # DEBUG: Log every 50 chunks with state info
                            if chunk_count % 50 == 0 or fin:
                                # Determine current state based on content
                                has_tool_calls = '"tool_calls"' in accumulated_json
                                has_response = '"response"' in accumulated_json
                                state = "reasoning" if reasoning_delta else ("tool_call" if has_tool_calls else ("response" if has_response else "json"))
                                logger.info(f"🔍 C{chunk_count} state={state} r_len={len(accumulated_reasoning)} json_len={len(accumulated_json)} has_tools={has_tool_calls} fin={fin}")
                            
                            # Accumulate reasoning and JSON separately
                            if reasoning_delta:
                                if first_reasoning_chunk is None:
                                    first_reasoning_chunk = chunk_count
                                    logger.info(f"🧠 C{chunk_count} REASONING started")
                                accumulated_reasoning += reasoning_delta
                            if content:
                                accumulated_json += content
                                # Track state transitions
                                if first_response_chunk is None and '"response"' in accumulated_json:
                                    first_response_chunk = chunk_count
                                    logger.info(f"💬 C{chunk_count} RESPONSE started")
                                if first_tool_calls_chunk is None and '"tool_calls"' in accumulated_json:
                                    first_tool_calls_chunk = chunk_count
                                    logger.info(f"🔧 C{chunk_count} TOOL_CALLS started")
                            
                            # Estimate tokens (rough: ~4 chars per token)
                            token_count = (len(accumulated_reasoning) + len(accumulated_json)) // 4
                            
                            # Detect any tool calls and emit early IN_PROGRESS
                            # Look for "tool": "tool_name" patterns in the JSON content
                            # Skip tools that shouldn't show early IN_PROGRESS (direct user communication)
                            SKIP_EARLY_PROGRESS = {"send_message_to_user", "attempt_completion"}
                            
                            if on_tool_detected and '"tool_calls"' in accumulated_json:
                                tool_matches = re.findall(r'"tool"\s*:\s*"([^"]+)"', accumulated_json)
                                for tool_name in tool_matches:
                                    # Skip tools that shouldn't have early progress messages
                                    if tool_name in SKIP_EARLY_PROGRESS:
                                        continue
                                    
                                    # Track position for this tool name (handles multiple same-name tools)
                                    current_position = detected_tool_positions.get(tool_name, 0)
                                    # Count how many of this tool we've already detected
                                    existing_count = sum(1 for t, _, _ in detected_tools_ordered if t == tool_name)
                                    
                                    # Only detect if this is a new occurrence
                                    if existing_count < tool_matches.count(tool_name) and existing_count == current_position:
                                        # Log previous tool's params before emitting IN_PROGRESS for this tool
                                        if len(detected_tools_ordered) > 0:
                                            completed_tools = _extract_completed_tool_calls(accumulated_json)
                                            prev_tool_idx = len(detected_tools_ordered) - 1
                                            if prev_tool_idx < len(completed_tools):
                                                prev_tool = completed_tools[prev_tool_idx]
                                                logger.info(
                                                    f"📋 Tool #{prev_tool_idx + 1} params captured before tool #{len(detected_tools_ordered) + 1} IN_PROGRESS: "
                                                    f"name={prev_tool.get('tool')} params={prev_tool}"
                                                )
                                            else:
                                                logger.warning(
                                                    f"⚠️ Could not parse tool #{prev_tool_idx + 1} params before tool #{len(detected_tools_ordered) + 1} detection. "
                                                    f"accumulated_json_tail={accumulated_json[-500:] if len(accumulated_json) > 500 else accumulated_json}"
                                                )

                                        tool_call_id = str(uuid.uuid4())
                                        detected_tools_ordered.append((tool_name, tool_call_id, _safe_time()))
                                        detected_tool_positions[tool_name] = current_position + 1
                                        logger.info(f"🔧 Tool detected: {tool_name} #{current_position + 1}, tool_call_id={tool_call_id}")
                                        await on_tool_detected(tool_name, tool_call_id)
                            
                            # Stream send_message_to_user content progressively
                            if on_attention_stream and '"send_message_to_user"' in accumulated_json:
                                # Assign tool_call_id if not yet assigned
                                if not attention_tool_call_id:
                                    attention_tool_call_id = str(uuid.uuid4())
                                    detected_tools_ordered.append(("send_message_to_user", attention_tool_call_id, _safe_time()))
                                    logger.info(f"📢 Attention message detected, tool_call_id={attention_tool_call_id}")
                                
                                # Extract message content
                                msg_match = re.search(r'"message"\s*:\s*"((?:[^"\\]|\\.)*)"?', accumulated_json)
                                if msg_match:
                                    try:
                                        attention_message = json.loads(f'"{msg_match.group(1)}"')
                                    except json.JSONDecodeError:
                                        attention_message = msg_match.group(1)
                                    
                                    # Extract is_question (default True)
                                    is_question = True
                                    iq_match = re.search(r'"is_question"\s*:\s*(true|false)', accumulated_json)
                                    if iq_match:
                                        is_question = iq_match.group(1) == "true"
                                    
                                    # Stream if message has grown
                                    if attention_message and attention_message != last_attention_message:
                                        last_attention_message = attention_message
                                        await on_attention_stream(attention_tool_call_id, attention_message, is_question)
                            
                            # Extract response and track for deduplication
                            response_text = _extract_response_from_partial_json(accumulated_reasoning, accumulated_json)
                            if response_text and response_text != last_emitted_text:
                                last_emitted_text = response_text
                                
                                # Only emit when 18+ new chars since last emit
                                pending_delta = len(response_text) - len(last_emitted_for_chunk)
                                if pending_delta >= 18:
                                    # logger.info(f"📤 Emitting to on_chunk: delta={pending_delta} chars, total_response_len={len(response_text)}")
                                    await on_chunk(response_text, token_count)
                                    last_emitted_for_chunk = response_text
                            
                            # Heartbeat every 5 chunks with state info
                            if chunk_count % 5 == 0:
                                # Determine current phase
                                if reasoning_delta:
                                    phase = "reasoning"
                                elif detected_tools_ordered:
                                    # Get the most recently detected tool
                                    last_tool = detected_tools_ordered[-1][0]
                                    phase = f"tool:{last_tool}"
                                elif '"response"' in accumulated_json:
                                    phase = "response"
                                else:
                                    phase = "json"
                                _safe_heartbeat(f"C{chunk_count} [{phase}] r={len(accumulated_reasoning)} j={len(accumulated_json)}")

                            # Raw progress callback (every chunk)
                            if on_raw_progress:
                                await on_raw_progress(len(accumulated_reasoning) + len(accumulated_json))
                        except json.JSONDecodeError:
                            logger.error(f"Failed to parse chunk: {data_str}")
                            continue
        except asyncio.CancelledError:
            logger.info(f"⏹️ Rose streaming cancelled (asyncio.CancelledError)")
            was_cancelled = True
        
        if was_cancelled:
            logger.info(f"🛑 Rose streaming cancelled, returning partial usage: {token_count} tokens")
            # Return empty response with partial usage - workflow will handle the pause
            empty_response = response_model.model_validate({
                "reasoning": "Streaming cancelled by user",
                "response": "",
                "tool_calls": []
            })
            # Use stream_usage if captured before cancellation, otherwise estimate
            if stream_usage:
                usage = {
                    "prompt_tokens": stream_usage.get("prompt_tokens", 0),
                    "completion_tokens": stream_usage.get("completion_tokens", 0),
                    "total_tokens": stream_usage.get("total_tokens", 0),
                    "actual_model": actual_model,
                    "pool_name": pool_name,
                    "pool_size": pool_size,
                    "cancelled": True
                }
            else:
                usage = {
                    "prompt_tokens": 0,
                    "completion_tokens": token_count,
                    "total_tokens": token_count,
                    "actual_model": actual_model,
                    "pool_name": pool_name,
                    "pool_size": pool_size,
                    "cancelled": True
                }
            return empty_response, usage, detected_tools_ordered
        
        logger.info(f"🏁 Rose streaming complete, received {chunk_count} chunks, reasoning={len(accumulated_reasoning)} json={len(accumulated_json)} chars")
        
        # Final emit - flush any remaining content that wasn't sent (under 18 chars)
        response_text = _extract_response_from_partial_json(accumulated_reasoning, accumulated_json)
        if response_text and response_text != last_emitted_for_chunk:
            await on_chunk(response_text, token_count)
        
        # Parse final JSON and validate with Pydantic
        # Rose models output: [explanation text]```json\n{...}\n``` 
        # We need to extract the JSON from within the markdown code block
        try:
            if not accumulated_json:
                # Log diagnostic info to help debug this intermittent issue
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
            code_block_match = re.search(r'```(?:json)?\s*(\{[\s\S]*\})\s*```', accumulated_json)
            if code_block_match:
                json_content = code_block_match.group(1)
                # Everything before the code block is explanation
                explanation_text = accumulated_json[:code_block_match.start()].strip()
                logger.info(f"📦 Extracted JSON from markdown code block, explanation={len(explanation_text)} chars")
            else:
                # No code block - try to find raw JSON object using balanced braces
                json_start = accumulated_json.find('{')
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
                        if c == '\\' and in_string:
                            escape_next = True
                            continue
                        if c == '"' and not escape_next:
                            in_string = not in_string
                            continue
                        if in_string:
                            continue
                        if c == '{':
                            depth += 1
                        elif c == '}':
                            depth -= 1
                            if depth == 0:
                                json_end = i
                                break
                    if json_end != -1:
                        json_content = accumulated_json[json_start:json_end + 1]
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
            if isinstance(json_reasoning, str) and json_reasoning.strip():
                if not combined_reasoning_parts or json_reasoning.strip() != combined_reasoning_parts[0]:
                    combined_reasoning_parts.append(json_reasoning.strip())

            if explanation_text:
                combined_reasoning_parts.append(explanation_text)

            combined_reasoning = "\n\n".join(part for part in combined_reasoning_parts if part)
            
            if combined_reasoning and "response" in parsed_content:
                parsed_content["response"] = combined_reasoning + "\n\n" + parsed_content["response"]
            
            response = response_model.model_validate(parsed_content)
        except (json.JSONDecodeError, Exception) as e:
            logger.error(f"Failed to parse streaming Rose response: json={accumulated_json[:500]}", error=extract_error_message(e))
            raise ValueError(f"Failed to parse streaming Rose response as {response_model.__name__}: {str(e)}")
        
        # Use captured stream usage if available, otherwise fall back to estimates
        if stream_usage:
            usage = {
                "prompt_tokens": stream_usage.get("prompt_tokens", 0),
                "completion_tokens": stream_usage.get("completion_tokens", 0),
                "total_tokens": stream_usage.get("total_tokens", 0),
                "actual_model": actual_model,
                "pool_name": pool_name,
                "pool_size": pool_size,
                "cancelled": False,
                # Include racing-adjusted values if present
                "winner_prompt_tokens": stream_usage.get("winner_prompt_tokens"),
                "winner_completion_tokens": stream_usage.get("winner_completion_tokens"),
            }
        else:
            usage = {
                "prompt_tokens": 0,  # Fallback if stream_options not supported
                "completion_tokens": token_count,
                "total_tokens": token_count,
                "actual_model": actual_model,
                "pool_name": pool_name,
                "pool_size": pool_size,
                "cancelled": False
            }

        # Filter out attempt_completion if grouped with other tools (silently drop it)
        # This ensures it never gets an IN_PROGRESS message or executes when batched
        # Only applies to models with tool_calls (e.g., AgentAction, not PlannerResponse)
        if hasattr(response, 'tool_calls') and response.tool_calls:
            has_other_tools = any(
                tc.tool != "attempt_completion"
                for tc in response.tool_calls if tc
            )
            if has_other_tools:
                original_count = len(response.tool_calls)
                response.tool_calls = [
                    tc for tc in response.tool_calls
                    if tc and tc.tool != "attempt_completion"
                ]
                # Also filter from detected_tools_ordered
                detected_tools_ordered = [
                    (name, tid, ts) for name, tid, ts in detected_tools_ordered
                    if name != "attempt_completion"
                ]
                if original_count != len(response.tool_calls):
                    logger.info(f"🔇 Silently dropped attempt_completion (was grouped with {original_count - 1} other tools)")

        # Deduplicate single-call-per-step tools (keep only first occurrence)
        # These tools should never be called more than once in the same response
        SINGLE_CALL_TOOLS = {"send_message_to_user", "send_message_to_user_execute_phase"}
        if hasattr(response, 'tool_calls') and response.tool_calls:
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
    base_client = AsyncOpenAI(
        api_key=config.openrouter.api_key,
        base_url=config.openrouter.base_url
    )
    
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
            **extra_args
        ):
            chunk_count += 1
            
            # Heartbeat every 5 chunks - when activity is cancelled, this raises CancelledError
            if chunk_count % 5 == 0:
                _safe_heartbeat(f"OpenRouter streaming chunk {chunk_count}")
            
            # Extract response text from partial object
            if hasattr(partial, 'response') and partial.response:
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
        logger.info(f"⏹️ OpenRouter streaming cancelled (asyncio.CancelledError)")
        was_cancelled = True
    except Exception as e:
        logger.error(f"Streaming LLM call failed: {str(e)}", model=model)
        raise
    
    # Handle cancellation
    if was_cancelled:
        logger.info(f"🛑 OpenRouter streaming cancelled, returning partial usage")
        empty_response = response_model.model_validate({
            "reasoning": "Streaming cancelled by user",
            "response": "",
            "tool_calls": []
        })
        estimated_tokens = len(accumulated_text) // 4
        usage = {
            "prompt_tokens": 0,
            "completion_tokens": estimated_tokens,
            "total_tokens": estimated_tokens,
            "cancelled": True
        }
        return empty_response, usage, []  # No tool detection in OpenRouter path
    
    if final_response is None:
        raise ValueError(f"Streaming LLM returned no response (model={model})")

    # Filter out attempt_completion if grouped with other tools (silently drop it)
    # Only applies to models with tool_calls (e.g., AgentAction, not PlannerResponse)
    if hasattr(final_response, 'tool_calls') and final_response.tool_calls:
        has_other_tools = any(
            tc.tool != "attempt_completion"
            for tc in final_response.tool_calls if tc
        )
        if has_other_tools:
            original_count = len(final_response.tool_calls)
            final_response.tool_calls = [
                tc for tc in final_response.tool_calls
                if tc and tc.tool != "attempt_completion"
            ]
            if original_count != len(final_response.tool_calls):
                logger.info(f"🔇 Silently dropped attempt_completion (was grouped with {original_count - 1} other tools)")

    # Deduplicate single-call-per-step tools (keep only first occurrence)
    # These tools should never be called more than once in the same response
    SINGLE_CALL_TOOLS = {"send_message_to_user", "send_message_to_user_execute_phase"}
    if hasattr(final_response, 'tool_calls') and final_response.tool_calls:
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
        "cancelled": False
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
        if char == '{':
            if depth == 0:
                obj_start = i
            depth += 1
        elif char == '}':
            depth -= 1
            if depth == 0 and obj_start is not None:
                # Complete object found
                obj_str = content[obj_start:i+1]
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
    code_block_start = json_content.find('```')
    if code_block_start > 0:
        explanation = json_content[:code_block_start].strip()
        json_only = json_content[code_block_start:]
    else:
        # Look for raw JSON start
        json_start = json_content.find('{')
        if json_start > 0:
            explanation = json_content[:json_start].strip()
            json_only = json_content[json_start:]
    
    response_text = ""
    json_reasoning = ""
    
    # Try to extract response field from the JSON portion
    # First try complete JSON parse
    try:
        # Strip markdown delimiters if present
        clean_json = re.sub(r'^```(?:json)?\s*', '', json_only)
        clean_json = re.sub(r'\s*```$', '', clean_json)
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

    fence_match = re.search(r'```(?:json)?\s*(\{[\s\S]*\})\s*```', trimmed)
    if fence_match:
        candidates.insert(0, fence_match.group(1))
    else:
        start = trimmed.find('{')
        end = trimmed.rfind('}')
        if start != -1 and end != -1 and end > start:
            candidates.append(trimmed[start:end + 1])

    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            continue

    return None


@activity.defn
async def call_llm(
    messages: List[Dict[str, Any]],
    model: Optional[str] = None,
    temperature: float = 0.7,
    max_tokens: int = 4096,
    response_format: Optional[Dict] = None
) -> Dict[str, Any]:
    """
    Call OpenRouter LLM for agent reasoning.
    
    Args:
        messages: List of message dicts with 'role' and 'content'
        model: Model to use (defaults to config)
        temperature: Sampling temperature (0-2)
        max_tokens: Maximum tokens to generate
        response_format: Optional response format (e.g., {"type": "json_object"})
        
    Returns:
        Dict with 'content', 'model', 'usage', etc.
    """
    try:
        _safe_heartbeat(f"Calling LLM with {len(messages)} messages")
        
        config = load_config()
        model = model or config.openrouter.model
        
        # Check if this is a Rose model - route to Supabase edge function
        is_rose_model = model is not None and ('rose-labs' in model.lower() or model.lower() in ['rose', 'rose-ultra'])
        
        if is_rose_model:
            # Generate unique request ID for tracing
            request_id = str(uuid.uuid4())[:8]
            # Use httpx directly for Rose models (Supabase function is at /completions, not /chat/completions)
            logger.info(f"📤 [{request_id}] Routing Rose model to Supabase: {model} → {config.rose.api_url}")

            request_body = {
                "model": model,
                "messages": messages,
                "temperature": temperature,
                "max_tokens": max_tokens,
            }
            if response_format:
                request_body["response_format"] = response_format

            # Log outbound request summary for debugging 400s
            logger.debug(
                f"📤 [{request_id}] Rose non-streaming request payload",
                request_id=request_id,
                model=request_body.get("model"),
                message_count=len(messages),
                has_response_format=bool(response_format),
                messages_summary=[
                    {
                        "index": i,
                        "role": m.get("role"),
                        "has_content": bool(m.get("content")),
                        "tool_calls": [
                            {
                                "id": tc.get("id"),
                                "name": tc.get("function", {}).get("name"),
                                "has_arguments": "arguments" in tc.get("function", {}),
                                "arguments_type": type(tc.get("function", {}).get("arguments")).__name__,
                                "arguments_preview": str(tc.get("function", {}).get("arguments"))[:50] if tc.get("function", {}).get("arguments") else "MISSING"
                            }
                            for tc in m.get("tool_calls", [])
                        ] if m.get("tool_calls") else None,
                        "tool_call_id": m.get("tool_call_id") if m.get("role") == "tool" else None
                    }
                    for i, m in enumerate(messages)
                ]
            )

            # Log FULL request for replay/debugging slow requests
            logger.info(
                f"📋 [{request_id}] Rose non-streaming request FULL (for replay)",
                request_id=request_id,
                url=config.rose.api_url,
                request_body_json=json.dumps(request_body, default=str),
            )

            async with httpx.AsyncClient(timeout=120.0) as http_client:
                http_response = await http_client.post(
                    config.rose.api_url,
                    json=request_body,
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {config.rose.supabase_anon_key}",
                        "x-api-key": config.rose.api_key,
                        "x-request-id": request_id,
                    }
                )
                http_response.raise_for_status()

            data = http_response.json()
            content = data.get("choices", [{}])[0].get("message", {}).get("content", "")

            result = {
                "content": content,
                "model": data.get("model", model),
                "finish_reason": data.get("choices", [{}])[0].get("finish_reason", "stop"),
                "usage": {
                    "prompt_tokens": data.get("usage", {}).get("prompt_tokens", 0),
                    "completion_tokens": data.get("usage", {}).get("completion_tokens", 0),
                    "total_tokens": data.get("usage", {}).get("total_tokens", 0)
                }
            }

            logger.info(
                f"📥 [{request_id}] LLM call complete (Rose)",
                request_id=request_id,
                model=model,
                tokens=result["usage"]["total_tokens"],
                content_length=len(content),
                content_preview=content[:100] if content else "EMPTY"
            )

            return result
        
        # Use OpenRouter for all other models
        client = AsyncOpenAI(
            api_key=config.openrouter.api_key,
            base_url=config.openrouter.base_url
        )
        
        # Call OpenRouter
        response = await client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            response_format=response_format
        )
        
        # Log full response to debug
        logger.info(
            "Raw LLM response",
            has_choices=len(response.choices) > 0,
            message_dict=response.choices[0].message.model_dump() if response.choices else None,
            finish_reason=response.choices[0].finish_reason if response.choices else None
        )
        
        content = response.choices[0].message.content or ""
        
        result = {
            "content": content,
            "model": response.model,
            "finish_reason": response.choices[0].finish_reason,
            "usage": {
                "prompt_tokens": response.usage.prompt_tokens,
                "completion_tokens": response.usage.completion_tokens,
                "total_tokens": response.usage.total_tokens
            }
        }
        
        logger.info(
            "LLM call complete",
            model=model,
            tokens=result["usage"]["total_tokens"],
            content_length=len(content),
            content_preview=content[:100] if content else "EMPTY"
        )
        
        return result
        
    except Exception as e:
        logger.error("LLM call failed", error=extract_error_message(e))
        raise


# NOTE: decide_next_action was removed - it was dead code (never called)
# The run_agent loop handles LLM calls directly via call_llm_structured_streaming


async def _call_llm_verifier(
    messages: List[Dict[str, Any]],
    model: str,
    config: Any,
    response_schema: Optional[Dict[str, Any]] = None,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """
    Simple LLM call for verifier - no streaming UI, no tool detection.

    Args:
        messages: Chat messages for the LLM
        model: Model to use
        config: Application config
        response_schema: Optional response schema to include output extraction

    Returns:
        Tuple of (parsed JSON dict with reasoning, score, and optionally output), usage dict)
    """
    request_body = {
        "model": model,
        "messages": messages,
        "temperature": 0.3,
        "max_tokens": 4096,
        "stream": True,
        "response_format": _build_verifier_json_schema(response_schema)
    }
    
    accumulated_reasoning = ""
    accumulated_json = ""
    actual_model = "unknown"
    pool_name = "unknown"
    chunk_count = 0
    
    async with httpx.AsyncClient(timeout=60.0) as http_client:
        async with http_client.stream(
            'POST',
            config.rose.api_url,
            json=request_body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {config.rose.supabase_anon_key}",
                "x-api-key": config.rose.api_key,
            }
        ) as stream_response:
            stream_response.raise_for_status()
            
            async for line in stream_response.aiter_lines():
                chunk_count += 1
                
                if chunk_count % 10 == 0:
                    _safe_heartbeat(f"Verifier streaming... {chunk_count} chunks")
                
                if not line or not line.startswith('data: '):
                    continue
                
                data_str = line[6:]
                if data_str == '[DONE]':
                    break
                
                try:
                    chunk_data = json.loads(data_str)
                    
                    if chunk_data.get("actual_model"):
                        actual_model = chunk_data["actual_model"]
                    if chunk_data.get("pool_name"):
                        pool_name = chunk_data["pool_name"]
                    
                    delta = chunk_data.get("choices", [{}])[0].get("delta", {})
                    
                    # Accumulate both reasoning and content
                    if delta.get("reasoning"):
                        accumulated_reasoning += delta["reasoning"]
                    if delta.get("content"):
                        accumulated_json += delta["content"]
                        
                except json.JSONDecodeError:
                    continue
    
    logger.info(f"🏁 Verifier streaming complete: {chunk_count} chunks, reasoning={len(accumulated_reasoning)}, json={len(accumulated_json)}")
    
    # Parse JSON - handle thinking models that put JSON in reasoning
    json_content = accumulated_json
    
    if not json_content and accumulated_reasoning:
        # Thinking models might put JSON in reasoning
        json_match = re.search(r'\{[\s\S]*\}', accumulated_reasoning)
        if json_match:
            json_content = json_match.group(0)
            logger.info("📦 Extracted JSON from reasoning (thinking model)")
    
    if not json_content:
        raise ValueError(f"No JSON content received (chunks={chunk_count}, model={actual_model})")

    parsed = json.loads(json_content)

    usage = {
        "prompt_tokens": 0,
        "completion_tokens": chunk_count,
        "total_tokens": chunk_count,
        "actual_model": actual_model,
        "pool_name": pool_name,
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
    properties = {
        "reasoning": {"type": "string"},
        "score": {"type": "number", "minimum": 0, "maximum": 1}
    }
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
                        "id": {"type": "string", "description": "File UUID. MUST copy exactly from Structured Response."},
                        "storage_path": {"type": "string", "description": "Supabase storage path. MUST copy exactly from Structured Response."},
                        "original_filename": {"type": "string", "description": "Original filename. MUST copy exactly from Structured Response."},
                        "mime_type": {"type": "string", "description": "MIME type (e.g., image/jpeg). MUST copy exactly from Structured Response."},
                        "size_bytes": {"type": "integer", "description": "File size in bytes. MUST copy exactly from Structured Response."},
                        "created_at": {"type": "string", "description": "ISO timestamp. MUST copy exactly from Structured Response."}
                    },
                    "required": ["id", "storage_path", "original_filename", "mime_type", "size_bytes", "created_at"],
                    "additionalProperties": False
                }
                json_type = file_pointer_schema
            elif field_type == "list[file_pointer]":
                # List of full FilePointers
                file_pointer_schema = {
                    "type": "object",
                    "description": "Full file reference with all metadata. Copy ALL fields exactly from 'Structured Response' in context.",
                    "properties": {
                        "id": {"type": "string", "description": "File UUID. MUST copy exactly from Structured Response."},
                        "storage_path": {"type": "string", "description": "Supabase storage path. MUST copy exactly from Structured Response."},
                        "original_filename": {"type": "string", "description": "Original filename. MUST copy exactly from Structured Response."},
                        "mime_type": {"type": "string", "description": "MIME type (e.g., image/jpeg). MUST copy exactly from Structured Response."},
                        "size_bytes": {"type": "integer", "description": "File size in bytes. MUST copy exactly from Structured Response."},
                        "created_at": {"type": "string", "description": "ISO timestamp. MUST copy exactly from Structured Response."}
                    },
                    "required": ["id", "storage_path", "original_filename", "mime_type", "size_bytes", "created_at"],
                    "additionalProperties": False
                }
                json_type = {
                    "type": "array",
                    "items": file_pointer_schema
                }
            elif field_type == "session_file_pointer":
                # Session file pointer - used by cloud agent verifiers (spawn_claude_code_agent, spawn_browser_agent)
                # Only extracts the path from terminal output - activity handles download/upload
                session_file_pointer_schema = {
                    "type": "object",
                    "description": "File reference from remote session. Extract the ABSOLUTE file path from terminal output.",
                    "properties": {
                        "path": {"type": "string", "description": "ABSOLUTE file path starting with /. Example: '/home/user/output/report.pdf'. Extract the full path exactly as shown in terminal output."}
                    },
                    "required": ["path"],
                    "additionalProperties": False
                }
                json_type = session_file_pointer_schema
            elif field_type == "list[session_file_pointer]":
                # List of session file pointers
                session_file_pointer_schema = {
                    "type": "object",
                    "description": "File reference from remote session. Extract the ABSOLUTE file path from terminal output.",
                    "properties": {
                        "path": {"type": "string", "description": "ABSOLUTE file path starting with /. Example: '/home/user/output/report.pdf'. Extract the full path exactly as shown in terminal output."}
                    },
                    "required": ["path"],
                    "additionalProperties": False
                }
                json_type = {
                    "type": "array",
                    "items": session_file_pointer_schema
                }
            else:
                json_type = {"type": "string"}  # Default fallback

            output_properties[field_name] = json_type

            # All fields are required in the output for strict mode
            output_required.append(field_name)

        properties["output"] = {
            "type": "object",
            "properties": output_properties,
            "required": output_required,
            "additionalProperties": False
        }
        required.append("output")

    return {
        "type": "json_schema",
        "json_schema": {
            "name": "ProgressScoreWithOutput" if response_schema else "ProgressScore",
            "schema": {
                "type": "object",
                "properties": properties,
                "required": required,
                "additionalProperties": False
            },
            "strict": True
        }
    }


@activity.defn
async def check_progress(
    context: List[Dict[str, Any]],
    verifier_system_prompt: str,
    model: str = "anthropic/claude-sonnet-4.5",
    phase: str = "EXECUTE",  # Kept for backward compat but no longer used
    response_schema: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Use LLM judge to check progress toward goal.

    Args:
        context: Message history (first USER message is the goal)
        verifier_system_prompt: Pre-built verifier system prompt (from build_verifier_prompt)
        model: LLM model to use
        phase: Deprecated - no longer used (prompt is pre-built by caller)
        response_schema: Response schema for structured output extraction

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
        # Use the pre-built verifier prompt directly (no double-building)
        system_prompt = verifier_system_prompt
        
        # Convert full context to OpenAI message format (no truncation)
        # NOTE: SYSTEM and ASSISTANT messages are excluded from verifier (default)
        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(convert_context_to_messages(context, include_system=False))
        messages.append({"role": "user", "content": "Evaluate the agent's progress as JSON."})
        
        # Debug: Log context size to detect contamination
        logger.info(
            "Verifier context",
            total_messages=len(context),
            agent_messages=len([m for m in context if m.get('role') == 'ASSISTANT']),
            system_messages_excluded=len([m for m in context if m.get('role') == 'SYSTEM']),
            context_summary=[f"{m.get('role')}: {m.get('text', '')[:50]}..." for m in context[-5:]]  # Last 5 messages
        )
        
        # === RAW CONTEXT LOG: Full original context for debugging ===
        logger.debug(
            "📦 Verifier raw context (pre-conversion)",
            raw_context_json=json.dumps(context, ensure_ascii=False, default=str)
        )
        
        # Use dedicated verifier LLM call (simple, no streaming UI)
        # Pass response_schema so the verifier includes output extraction in same call
        result, usage = await _call_llm_verifier(messages, model, config, response_schema)

        score = result["score"]
        reasoning = result["reasoning"]

        logger.info(
            "Progress checked",
            progress=score,
            reasoning=reasoning,
            tokens=usage.get("total_tokens", 0),
            actual_model=usage.get("actual_model"),
            pool_name=usage.get("pool_name"),
            has_output="output" in result
        )

        # Only use output when score >= 1.0 (schema enforcement is handled by strict JSON schema)
        structured_response = result.get("output") if score >= 1.0 else None

        return {
            "score": score,
            "reasoning": reasoning,
            "message": f"{reasoning}\n\nScore: {score}",
            "usage": usage,
            "structured_response": structured_response
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
            "structured_response": None
        }


@activity.defn
async def call_llm_activity(
    messages: List[Dict[str, Any]],
    model: str,
    tool_names: List[str],
    reasoning_max_tokens: int = 256,
    agent_id: Optional[str] = None,
    stream_id: Optional[str] = None,
    task_id: Optional[str] = None,
    claude_token: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Activity wrapper for LLM calls with structured output and streaming.
    
    Used by run_agent when called from workflow context (not inside activity).
    Provides proper Temporal activity retries, heartbeating, and streaming to Supabase Realtime.
    
    Args:
        messages: Pre-built messages list (system prompt + context)
        model: Model to use
        tool_names: List of tool names for dynamic AgentAction model
        reasoning_max_tokens: Max reasoning tokens (0 disables)
        agent_id: Agent ID for streaming (optional)
        stream_id: Stream session ID for ordering (optional)
        task_id: Sub-agent task ID for routing to browser panel (optional)
        
    Returns:
        Dict with:
        - response: Assistant response text
        - tool_calls: List of tool call dicts
        - usage: Token usage dict
    """
    try:
        _safe_heartbeat("Calling LLM for structured output")
        
        # Create dynamic action model
        AgentActionModel = create_agent_action_model(tool_names)
        
        # _is_claude detected from actual_model in stream response, not from input model/token
        _is_claude = [False]  # Mutable list so closures can update it

        def on_model_detected(actual_model: str):
            # "-claude" suffix = user's own Claude token ($0, skipped racing)
            # e.g. "claude-sonnet-4-6-claude", "claude-opus-4-6-claude"
            is_user_claude = actual_model.endswith("-claude")
            _is_claude[0] = is_user_claude
            logger.info(f"🎨 Claude detection: actual_model={actual_model}, is_claude={is_user_claude}")

        # Streaming callback - posts directly to Supabase Realtime
        sequence = [0]
        last_text = [""]

        async def on_chunk(text_so_far: str, tokens: int):
            _safe_heartbeat(f"LLM streaming... {len(text_so_far)} chars")
            if agent_id and stream_id:
                delta = text_so_far[len(last_text[0]):]
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
            max_tokens=4096,
            response_model=AgentActionModel,
            on_chunk=on_chunk,
            reasoning_max_tokens=reasoning_max_tokens if reasoning_max_tokens > 0 else None,
            agent_id=agent_id,
            on_tool_detected=on_tool_detected_callback,
            claude_token=claude_token,
            on_model_detected=on_model_detected,
        )
        
        # Send final done=True chunk
        if agent_id and stream_id:
            try:
                final_delta = ""
                if hasattr(result, 'response') and result.response:
                    final_delta = result.response[len(last_text[0]):]
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
        
        if not hasattr(result, 'response') or not hasattr(result, 'tool_calls'):
            raise ValueError(f"LLM result missing required fields (model={model})")
        
        # Convert tool calls to dicts
        tool_calls_dict = []
        if result.tool_calls:
            for tc in result.tool_calls:
                if tc is not None:
                    tc_dict = tc.model_dump() if hasattr(tc, 'model_dump') else tc.dict()
                    tool_calls_dict.append(tc_dict)
        
        logger.info(
            "LLM activity completed",
            response_len=len(result.response) if result.response else 0,
            tool_calls=len(tool_calls_dict),
            tokens=usage.get("total_tokens", 0)
        )
        
        return {
            "response": result.response if result.response else "",
            "tool_calls": tool_calls_dict,
            "usage": usage,
            "detected_tools_ordered": detected_tools_ordered,  # [(tool_name, tool_call_id, timestamp), ...]
        }
        
    except Exception as e:
        logger.error("LLM activity failed", error=extract_error_message(e))
        raise


@activity.defn
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
    backend_url = config.backend.api_url.rstrip('/')
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
                headers={
                    "X-API-Key": api_key,
                    "Content-Type": "application/json"
                },
                json={"goal": goal}
            )
            schema_response.raise_for_status()
            schema_data = schema_response.json()
            api_elapsed = time.perf_counter() - api_start
            logger.info(f"[TIMING] Schema generation API call: {api_elapsed*1000:.1f}ms ({api_elapsed:.2f}s)")

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
                tokens_out=tokens_out
            )

            # 2. Save schema to agent record
            save_start = time.perf_counter()
            save_response = await client.patch(
                f"{backend_url}/api/agents/{agent_id}",
                headers={
                    "X-API-Key": api_key,
                    "Content-Type": "application/json"
                },
                json={"response_schema": schema}
            )
            save_elapsed = time.perf_counter() - save_start
            logger.info(f"[TIMING] Schema save API call: {save_elapsed*1000:.1f}ms")

            if not save_response.is_success:
                logger.warning(
                    "Failed to save response schema",
                    agent_id=agent_id,
                    status_code=save_response.status_code
                )
            else:
                logger.info("Saved response schema to agent", agent_id=agent_id)

            activity_elapsed = time.perf_counter() - activity_start
            logger.info(f"[TIMING] Total response schema activity: {activity_elapsed*1000:.1f}ms ({activity_elapsed:.2f}s)")
            return schema

    except httpx.HTTPStatusError as e:
        logger.error(
            "Backend API error generating response schema",
            agent_id=agent_id,
            status_code=e.response.status_code,
            response_text=e.response.text[:500]
        )
        return None
    except Exception as e:
        logger.error(
            "Failed to generate response schema",
            agent_id=agent_id,
            error=extract_error_message(e)
        )
        return None


@activity.defn
async def fetch_claude_max_token_activity(user_id: str) -> Optional[str]:
    """
    Fetch Claude Max OAuth token for a user from the backend.

    Returns the access token string, or None if unavailable.
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
                token = response.json().get("accessToken")
                if token:
                    logger.info(f"✅ Claude Max token fetched for user {user_id}")
                    return token
            elif response.status_code == 404:
                logger.info(f"Claude Max credentials not found for user {user_id}")
            else:
                logger.warning(f"Claude Max token fetch failed: {response.status_code}")
    except Exception as e:
        logger.warning(f"Failed to fetch Claude Max token: {e}")

    return None


@activity.defn
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
    from helpers.prompts import build_planner_system_prompt
    from helpers.tool_schemas import PlannerResponse

    activity_start = time.perf_counter()
    _safe_heartbeat("Calling planner LLM")

    # Build system prompt for planner
    prompt_start = time.perf_counter()
    system_prompt = build_planner_system_prompt(tools_description, user_context, response_schema=response_schema)
    prompt_elapsed = time.perf_counter() - prompt_start
    logger.info(f"[TIMING] Planner system prompt build: {prompt_elapsed*1000:.1f}ms")

    # Prepend system message
    full_messages = [{"role": "system", "content": system_prompt}] + messages
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
        if agent_id and tool_call_id:
            # Only broadcast when 50+ new bytes since last broadcast
            if total_bytes - last_broadcast_len[0] >= 50:
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
            temperature=0.7,
            max_tokens=4096,
            response_model=PlannerResponse,
            on_chunk=on_plan_heartbeat,
            on_raw_progress=on_plan_progress,
            claude_token=claude_max_token,
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
        logger.info(f"[TIMING] Planner LLM API call: {llm_elapsed*1000:.1f}ms ({llm_elapsed:.2f}s), total activity: {activity_elapsed*1000:.1f}ms")

        # Return plan with usage for cost tracking
        # Use actual_model from Rose response (may be "claude-opus-4-6-claude" for $0 pricing)
        actual_model = usage.get("actual_model", model)
        return {
            "result": result.model_dump(),
            "usage": {
                "llm": [{
                    "tokens_in": tokens_in,
                    "tokens_out": tokens_out,
                    "model": actual_model,
                    "provider": "Rose Planner",
                }],
                "service": [],
            }
        }

    except Exception as e:
        logger.error("Planner LLM failed", error=extract_error_message(e))
        raise
