"""LLM tool for agent reasoning and decision making."""

import asyncio
import re
import uuid
from typing import List, Dict, Optional, Any, TypeVar, Type, AsyncIterator, Tuple, Callable, Awaitable
from temporalio import activity
import structlog
import json
from openai import AsyncOpenAI
from pydantic import BaseModel

from config import load_config
from helpers.get_user_context import fetch_user_context
from helpers.prompts import build_system_prompt, build_verifier_prompt
from helpers.tool_schemas import (
    ProgressScore,
    create_agent_action_model,
)
from tools.base import ToolSchema

logger = structlog.get_logger()

T = TypeVar('T', bound=BaseModel)
def prepare_schema_for_openai(pydantic_model: Type[BaseModel]) -> Dict[str, Any]:
    """
    Convert a Pydantic model to a JSON schema ready for OpenAI strict structured outputs.
    
    OpenAI's strict mode requires:
    1. `additionalProperties: false` on EVERY object (root and nested)
    2. All properties must be in the `required` array (no optional fields)
    
    This function recursively transforms the schema to meet these requirements.
    
    Args:
        pydantic_model: A Pydantic BaseModel class
        
    Returns:
        JSON schema dict ready for OpenAI's response_format
    """
    schema = pydantic_model.model_json_schema()
    
    def add_strict_properties(obj: Dict[str, Any]) -> None:
        """Recursively add additionalProperties: false to all objects."""
        if not isinstance(obj, dict):
            return
            
        # If this is an object type, add additionalProperties: false
        if obj.get("type") == "object":
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
    
    add_strict_properties(schema)
    return schema


def convert_context_to_messages(
    context: List[Dict[str, Any]], 
    include_system: bool = True
) -> List[Dict[str, Any]]:
    """
    Convert workflow context to OpenAI/OpenRouter message format.
    
    Handles:
    - SYSTEM messages (blueprints): included if include_system=True
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
        
    Returns:
        List of OpenAI-formatted messages in chronological order
    """
    messages = []
    
    # Sort context by timestamp to ensure chronological order
    # This is critical after polling for new user messages or continue-as-new
    from datetime import datetime
    
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
        metadata = msg.get('metadata', {})
        
        if role == 'SYSTEM':
            if include_system:
                messages.append({"role": "system", "content": content})
                
        elif role == 'USER':
            messages.append({"role": "user", "content": content})
            
        elif role == 'ASSISTANT':
            # Include tool_calls if present in metadata
            assistant_msg = {"role": "assistant", "content": content}
            if metadata.get('tool_calls'):
                # Convert our tool call format to OpenAI format
                import uuid
                tool_calls = []
                for tc in metadata['tool_calls']:
                    # Get or generate tool_call_id
                    tc_id = str(tc.get('tool_call_id', uuid.uuid4()))
                    declared_tool_ids.add(tc_id)  # Track this ID
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
                messages.append({"role": "system", "content": system_content})
    
    return messages


async def call_rose_streaming(
    messages: List[Dict[str, Any]],
    model: str = "rose-1-ultra",
    temperature: float = 1.0,
    max_tokens: int = 4096,
    tools: Optional[List[Dict[str, Any]]] = None,
    tool_choice: Optional[str] = "auto",
    response_format: Optional[Dict[str, Any]] = None,
    reasoning_max_tokens: Optional[int] = None,
    on_chunk: Optional[Callable[[str], Awaitable[None]]] = None,
    heartbeat_fn: Optional[Callable[[str], None]] = None,
) -> Dict[str, Any]:
    """
    Unified streaming LLM call for Rose models via Supabase edge function.
    
    This is the single entry point for all Rose API calls. It supports:
    - Simple text completion
    - Tool/function calling
    - Structured JSON output
    
    Args:
        messages: List of message dicts (role, content, tool_calls, tool_call_id, etc.)
        model: Model name (default: rose-1-ultra)
        temperature: Sampling temperature (default: 1.0)
        max_tokens: Maximum tokens to generate (default: 4096)
        tools: Optional list of tool definitions for function calling
        tool_choice: Tool choice mode ("auto", "none", "required", or specific tool)
        response_format: Optional response format (e.g., JSON schema)
        reasoning_max_tokens: Optional max tokens for reasoning
        on_chunk: Optional async callback for streaming text chunks
        heartbeat_fn: Optional heartbeat function for long-running calls
        
    Returns:
        Dict with:
        - content: str - Text content from the response (includes reasoning if enabled)
        - tool_calls: List[Dict] - Tool calls from the response (if any)
        - usage: Dict - Token usage info
        - actual_model: str - Actual model used
        - finish_reason: str - Why generation stopped
    """
    import httpx
    
    config = load_config()
    
    # Build request body
    request_body = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": True,
    }
    
    if tools:
        request_body["tools"] = tools
        request_body["tool_choice"] = tool_choice
    
    if response_format:
        request_body["response_format"] = response_format
    
    if reasoning_max_tokens:
        request_body["reasoning"] = {"max_tokens": reasoning_max_tokens}
    
    # Log outbound request summary for debugging 400s
    logger.info(
        "📤 Rose streaming request",
        model=model,
        message_count=len(messages),
        tool_count=len(tools) if tools else 0,
        has_response_format=bool(response_format),
        has_reasoning=bool(reasoning_max_tokens),
    )
    
    # Log FULL request for replay/debugging slow requests
    import json
    logger.info(
        "📋 Rose request FULL (for replay)",
        url=config.rose.api_url,
        request_body_json=json.dumps(request_body, default=str),
    )
    
    # Detailed debug logging for tool_calls in messages
    for i, msg in enumerate(messages):
        if msg.get("role") == "assistant" and "tool_calls" in msg:
            for j, tc in enumerate(msg.get("tool_calls", [])):
                func_data = tc.get("function", {})
                tool_args = func_data.get("arguments")
                has_valid_args = tool_args is not None and isinstance(tool_args, str)
                
                if not has_valid_args:
                    logger.error(
                        f"❌ Invalid tool_call in messages[{i}].tool_calls[{j}]",
                        tool_name=func_data.get("name", ""),
                        tool_call_id=tc.get("id", ""),
                        has_function=("function" in tc),
                        has_arguments=("arguments" in func_data),
                        arguments_type=type(tool_args).__name__ if tool_args is not None else "None",
                        arguments_value=str(tool_args)[:100] if tool_args else "MISSING",
                    )
    
    # Stream the response
    accumulated_content = ""
    tool_calls_data = []
    usage_data = {}
    actual_model = model
    actual_model_logged = False
    finish_reason = "stop"
    
    if heartbeat_fn:
        heartbeat_fn("Starting Rose API stream...")
    
    import time
    request_start_time = time.time()
    ttft_logged = False
    
    try:
        async with httpx.AsyncClient(timeout=120.0) as http_client:
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
                
                chunk_count = 0
                async for line in stream_response.aiter_lines():
                    # Log TTFT on first chunk
                    if not ttft_logged:
                        ttft_ms = int((time.time() - request_start_time) * 1000)
                        logger.info(f"⏱️ Rose TTFT: {ttft_ms}ms")
                        ttft_logged = True
                    chunk_count += 1
                    
                    # Heartbeat periodically
                    if heartbeat_fn and chunk_count % 5 == 0:
                        heartbeat_fn(f"Streaming chunk {chunk_count}")
                    
                    if not line or not line.startswith('data: '):
                        continue
                    
                    data_str = line[6:]  # Remove 'data: ' prefix
                    if data_str == '[DONE]':
                        break
                    
                    try:
                        chunk_data = json.loads(data_str)
                        
                        # Extract model info
                        if chunk_data.get("actual_model") and not actual_model_logged:
                            actual_model = chunk_data["actual_model"]
                            actual_model_logged = True
                            logger.info(f"🎯 Rose model selected: {actual_model}")
                        
                        # Extract usage
                        if chunk_data.get("usage"):
                            usage_data = chunk_data["usage"]
                        
                        # Process choices
                        choices = chunk_data.get("choices", [])
                        if not choices:
                            continue
                        
                        delta = choices[0].get("delta", {})
                        
                        # Only accumulate content, not reasoning
                        # Reasoning is internal model thinking, content is the actual response
                        content_delta = delta.get("content") or ""
                        
                        if content_delta:
                            accumulated_content += content_delta
                            if on_chunk:
                                await on_chunk(accumulated_content)
                        
                        # Accumulate tool calls
                        if delta.get("tool_calls"):
                            for tc_delta in delta["tool_calls"]:
                                tc_index = tc_delta.get("index", 0)
                                
                                # Ensure we have enough slots
                                while len(tool_calls_data) <= tc_index:
                                    tool_calls_data.append({
                                        "id": "",
                                        "type": "function",
                                        "function": {"name": "", "arguments": ""}
                                    })
                                
                                # Update the tool call
                                if tc_delta.get("id"):
                                    tool_calls_data[tc_index]["id"] = tc_delta["id"]
                                if tc_delta.get("function", {}).get("name"):
                                    tool_calls_data[tc_index]["function"]["name"] = tc_delta["function"]["name"]
                                if tc_delta.get("function", {}).get("arguments"):
                                    tool_calls_data[tc_index]["function"]["arguments"] += tc_delta["function"]["arguments"]
                        
                        # Check finish reason
                        if choices[0].get("finish_reason"):
                            finish_reason = choices[0]["finish_reason"]
                            
                    except json.JSONDecodeError:
                        continue
        
        logger.info(
            "✅ Rose streaming complete",
            actual_model=actual_model,
            content_length=len(accumulated_content),
            tool_calls_count=len(tool_calls_data),
            usage=usage_data,
        )
        
        return {
            "content": accumulated_content,
            "tool_calls": tool_calls_data if tool_calls_data else None,
            "usage": usage_data,
            "actual_model": actual_model,
            "finish_reason": finish_reason,
        }
        
    except httpx.HTTPStatusError as e:
        logger.error(
            "❌ Rose API call failed",
            status_code=e.response.status_code,
            response_body=e.response.text[:500] if e.response.text else "EMPTY",
        )
        raise


async def call_llm_structured_streaming(
    messages: List[Dict[str, str]],
    model: Optional[str],
    temperature: float,
    max_tokens: int,
    response_model: type[T],
    on_chunk: Callable[[str, int], Awaitable[None]],
    reasoning_max_tokens: Optional[int] = None,
    model_preference: Optional[str] = None,
    agent_id: Optional[str] = None,  # For cancellation checking
    on_plan_start: Optional[Callable[[str], Awaitable[None]]] = None,  # Called when set_plan detected
    on_plan_title: Optional[Callable[[str, str], Awaitable[None]]] = None,  # Called when plan title detected
) -> Tuple[T, Dict, Optional[str]]:
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
        on_plan_start: Optional callback(tool_call_id) when set_plan tool is first detected
        on_plan_title: Optional callback(tool_call_id, title) when plan title is detected
        
    Returns:
        Tuple of (response_model instance, usage dict with token counts, plan_tool_call_id or None)
        Usage dict includes 'cancelled': True if streaming was stopped early
    """
    import instructor
    import httpx
    
    config = load_config()
    
    # Check if this is a Rose model - route to Supabase edge function with streaming
    is_rose_model = model is not None and ('rose-labs' in model.lower() or model.lower() in ['rose', 'rose-ultra'])
    
    if is_rose_model:
        logger.info(f"🌹 Streaming Rose model via Supabase: {model} → {config.rose.api_url}")
        
        # Build JSON schema from Pydantic model
        schema = prepare_schema_for_openai(response_model)
        
        request_body = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": True,  # Enable SSE streaming
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
        
        # Add reasoning config for reasoning models (Gemini, Anthropic, etc.)
        if reasoning_max_tokens:
            request_body["reasoning"] = {"max_tokens": reasoning_max_tokens}
            logger.info(f"🧠 Streaming with reasoning max_tokens: {reasoning_max_tokens}")
        
        # Stream SSE from Rose endpoint
        accumulated_content = ""
        last_emitted_text = ""  # Track last emitted text to avoid duplicate sends
        last_emitted_for_chunk = ""  # Track what we've actually sent to on_chunk (for 18-char batching)
        token_count = 0
        actual_model = "unknown"
        actual_model_logged = False
        pool_name = "unknown"
        pool_size = 0
        was_cancelled = False
        chunk_count = 0
        
        # Plan streaming tracking
        plan_tool_call_id: Optional[str] = None
        plan_in_progress_emitted = False
        plan_title_emitted: Optional[str] = None
        
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
            import json
            logger.info(
                "📋 Rose structured request FULL (for replay)",
                url=config.rose.api_url,
                request_body_json=json.dumps(request_body, default=str),
            )
            
            # Heartbeat before starting - catches cancellation if pause was already clicked
            activity.heartbeat("Starting Rose LLM stream...")
            
            import time
            request_start_time = time.time()
            ttft_logged = False
            
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
                    
                    # Heartbeat after connection established - catches cancellation during initial request
                    activity.heartbeat("Rose stream connected, waiting for chunks...")
                    logger.info(f"🔄 Rose streaming response started, status={stream_response.status_code}")
                    
                    async for line in stream_response.aiter_lines():
                        chunk_count += 1
                        
                        # Log TTFT on first chunk
                        if not ttft_logged:
                            ttft_ms = int((time.time() - request_start_time) * 1000)
                            logger.info(f"⏱️ Rose structured TTFT: {ttft_ms}ms")
                            ttft_logged = True
                        
                        # Heartbeat every 5 chunks - when activity is cancelled, this raises CancelledError
                        if chunk_count % 5 == 0:
                            activity.heartbeat(f"Streaming chunk {chunk_count}")
                        
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
                            if chunk_data.get("pool_name"):
                                pool_name = chunk_data["pool_name"]
                            if chunk_data.get("pool_size"):
                                pool_size = chunk_data["pool_size"]
                            
                            # Extract delta content
                            delta = chunk_data.get("choices", [{}])[0].get("delta", {})
                            
                            # Extract reasoning from delta.reasoning (GPT-5.2, Gemini, DeepSeek use this)
                            # NOTE: For structured streaming, reasoning is logged but NOT added to accumulated_content
                            # because accumulated_content must be valid JSON for parsing at the end
                            reasoning_delta = delta.get("reasoning") or ""
                            content_only = delta.get("content") or ""
                            fin = chunk_data.get("choices", [{}])[0].get("finish_reason") or ""
                            
                            # DEBUG: Log chunk content (reasoning + content)
                            if reasoning_delta or content_only or fin:
                                logger.info(f"🔍 C{chunk_count} r={reasoning_delta[:50] if reasoning_delta else ''} c={content_only[:100] if content_only else ''} fin={fin}")
                            
                            # Only accumulate content (JSON) - reasoning is for logging/debugging only
                            # The JSON response is what gets parsed into AgentAction
                            content_delta = content_only
                            
                            if content_delta:
                                accumulated_content += content_delta
                                # Estimate tokens (rough: ~4 chars per token)
                                token_count = len(accumulated_content) // 4
                                
                                # Detect set_plan and emit IN_PROGRESS on first detection
                                if not plan_in_progress_emitted and '"set_plan"' in accumulated_content:
                                    plan_tool_call_id = str(uuid.uuid4())
                                    plan_in_progress_emitted = True
                                    if on_plan_start:
                                        logger.info(f"📋 Plan detected, emitting IN_PROGRESS with tool_call_id={plan_tool_call_id}")
                                        await on_plan_start(plan_tool_call_id)
                                
                                # Detect title and emit updated IN_PROGRESS
                                if plan_in_progress_emitted and plan_tool_call_id:
                                    title_match = re.search(r'"title"\s*:\s*"((?:[^"\\]|\\.)*)"', accumulated_content)
                                    if title_match:
                                        try:
                                            title = json.loads(f'"{title_match.group(1)}"')
                                        except json.JSONDecodeError:
                                            title = title_match.group(1)
                                        if title != plan_title_emitted and on_plan_title:
                                            plan_title_emitted = title
                                            logger.info(f"📋 Plan title detected: {title[:50]}...")
                                            await on_plan_title(plan_tool_call_id, title)
                                
                                # Extract response and track for deduplication
                                response_text = _extract_response_from_partial_json(accumulated_content)
                                if response_text and response_text != last_emitted_text:
                                    last_emitted_text = response_text
                                    
                                    # Only emit when 18+ new chars since last emit
                                    pending_delta = len(response_text) - len(last_emitted_for_chunk)
                                    if pending_delta >= 18:
                                        # logger.info(f"📤 Emitting to on_chunk: delta={pending_delta} chars, total_response_len={len(response_text)}")
                                        await on_chunk(response_text, token_count)
                                        last_emitted_for_chunk = response_text
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
            usage = {
                "prompt_tokens": 0,
                "completion_tokens": token_count,
                "total_tokens": token_count,
                "actual_model": actual_model,
                "pool_name": pool_name,
                "pool_size": pool_size,
                "cancelled": True
            }
            return empty_response, usage, plan_tool_call_id
        
        logger.info(f"🏁 Rose streaming complete, received {chunk_count} chunks, {len(accumulated_content)} chars")
        
        # Final emit - flush any remaining content that wasn't sent (under 18 chars)
        response_text = _extract_response_from_partial_json(accumulated_content)
        if response_text and response_text != last_emitted_for_chunk:
            await on_chunk(response_text, token_count)
        
        # Parse final JSON and validate with Pydantic
        try:
            parsed_content = json.loads(accumulated_content)
            response = response_model.model_validate(parsed_content)
        except (json.JSONDecodeError, Exception) as e:
            logger.error(f"Failed to parse streaming Rose response: {accumulated_content[:500]}", error=str(e))
            raise ValueError(f"Failed to parse streaming Rose response as {response_model.__name__}: {str(e)}")
        
        usage = {
            "prompt_tokens": 0,  # Not available in streaming mode
            "completion_tokens": token_count,
            "total_tokens": token_count,
            "actual_model": actual_model,
            "pool_name": pool_name,
            "pool_size": pool_size,
            "cancelled": False
        }
        
        return response, usage, plan_tool_call_id
    
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
                activity.heartbeat(f"OpenRouter streaming chunk {chunk_count}")
            
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
        return empty_response, usage, None  # No plan streaming in OpenRouter path
    
    if final_response is None:
        raise ValueError(f"Streaming LLM returned no response (model={model})")
    
    # Usage not available in Instructor streaming, estimate from content
    estimated_tokens = len(accumulated_text) // 4
    usage = {
        "prompt_tokens": 0,
        "completion_tokens": estimated_tokens,
        "total_tokens": estimated_tokens,
        "cancelled": False
    }
    
    return final_response, usage, None  # No plan streaming in OpenRouter path


def _extract_response_from_partial_json(partial_json: str) -> Optional[str]:
    """
    Try to extract streamable text from a partially streamed JSON string.
    
    Priority:
    1. 'response' field (main user-visible text)
    2. 'content' field inside set_plan tool calls (plan content)
    
    This handles incomplete JSON by looking for field patterns with regex.
    """
    import re
    
    # Try to parse as complete JSON first
    try:
        data = json.loads(partial_json)
        # Check response field
        if data.get("response"):
            return data["response"]
        # Check for set_plan content in tool_calls
        tool_calls = data.get("tool_calls", [])
        for tc in tool_calls:
            if tc.get("tool") == "set_plan" and tc.get("content"):
                return tc["content"]
        return ""
    except json.JSONDecodeError:
        pass
    
    # Try to extract 'response' field with regex
    match = re.search(r'"response"\s*:\s*"((?:[^"\\]|\\.)*)"?', partial_json)
    if match:
        try:
            return json.loads(f'"{match.group(1)}"')
        except json.JSONDecodeError:
            return match.group(1)
    
    # Try to extract 'content' field from set_plan tool call
    # Only match if we see set_plan context nearby
    if '"set_plan"' in partial_json:
        content_match = re.search(r'"content"\s*:\s*"((?:[^"\\]|\\.)*)"?', partial_json)
        if content_match:
            try:
                return json.loads(f'"{content_match.group(1)}"')
            except json.JSONDecodeError:
                return content_match.group(1)
    
    return None


@activity.defn
async def call_llm(
    messages: List[Dict[str, str]],
    model: Optional[str] = None,
    temperature: float = 0.7,
    max_tokens: int = 4000,
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
        activity.heartbeat(f"Calling LLM with {len(messages)} messages")
        
        config = load_config()
        model = model or config.openrouter.model
        
        # Check if this is a Rose model - route to Supabase edge function
        is_rose_model = model is not None and ('rose-labs' in model.lower() or model.lower() in ['rose', 'rose-ultra'])
        
        if is_rose_model:
            # Use httpx directly for Rose models (Supabase function is at /completions, not /chat/completions)
            import httpx
            
            logger.info(f"🌹 Routing Rose model to Supabase: {model} → {config.rose.api_url}")
            
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
                "📤 Rose non-streaming request payload",
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
            import json
            logger.info(
                "📋 Rose non-streaming request FULL (for replay)",
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
                "LLM call complete (Rose)",
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
        logger.error("LLM call failed", error=str(e))
        raise


@activity.defn
async def decide_next_action(
    context: List[Dict[str, Any]],
    enabled_tools: List[ToolSchema],
    enabled_tool_names: List[str],
    disabled_tools: List[Dict[str, Any]],
    iteration: int,
    model: str = "anthropic/claude-sonnet-4.5",
    reasoning_max_tokens: int = 256,
    user_id: Optional[str] = None,
    phase: str = "EXECUTE",
    model_preference: Optional[str] = None,
    agent_id: Optional[str] = None,
    stream_id: Optional[str] = None
) -> Dict[str, Any]:
    """
    Use LLM to decide what action to take next.
    
    Simplified 2-Phase Flow: PLAN → EXECUTE
    Phase is detected statelessly from user messages containing "execute".
    
    Args:
        context: Message history (first USER message is the goal)
        enabled_tools: List of tools available in current phase
        enabled_tool_names: Names of enabled tools
        disabled_tools: List of tools not available yet (shown in prompt for visibility)
        iteration: Current iteration number
        model: LLM model to use
        reasoning_max_tokens: Max tokens for reasoning (0 disables reasoning)
        user_id: Optional Supabase user ID
        phase: Current workflow phase (PLAN or EXECUTE)
        model_preference: Optional Rose model preference (SMART, FAST, CHEAP)
        agent_id: Optional agent ID for streaming (enables streaming when provided with stream_id)
        stream_id: Optional stream ID for streaming (enables streaming when provided with agent_id)
        
    Returns:
        Dict with 'tool', 'args'
    """
    try:
        activity.heartbeat(f"Deciding next action (iteration {iteration}, phase={phase})")
        
        # Fetch user context (authenticated sites, recent messages, contacts, phone)
        user_context_section = ""
        if user_id:
            try:
                user_context_section = await fetch_user_context(user_id)
                if user_context_section:
                    user_context_section = "\n" + user_context_section + "\n"
            except Exception as e:
                logger.warning("Failed to fetch user context", user_id=user_id[:8], error=str(e))
        
        # Detect if this is the first call (no enabled tools = thinking phase)
        is_first_call = len(enabled_tools) == 0
        
        # Build unified system prompt with phase-specific instructions and tool status
        system_prompt = build_system_prompt(
            phase=phase,
            enabled_tools=enabled_tools,
            disabled_tools=disabled_tools,
            user_context_section=user_context_section,
            is_first_call=is_first_call
        )
        
        # Convert full context to OpenAI message format (no truncation)
        # NOTE: SYSTEM messages (like blueprints) ARE included for decide_next_action
        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(convert_context_to_messages(context, include_system=True))
        messages.append({"role": "user", "content": "Based on everything so far, what should I do next?"})
        
        # Create custom AgentAction model based on enabled tools
        AgentActionModel = create_agent_action_model(enabled_tool_names)
        
        # Use structured output with Pydantic schema
        # Use the reasoning_max_tokens from agent settings (0 disables reasoning)
        effective_reasoning_tokens = reasoning_max_tokens if reasoning_max_tokens > 0 else None
        if effective_reasoning_tokens:
            logger.info(f"🧠 Using {effective_reasoning_tokens} max reasoning tokens for {model}")
        else:
            logger.info(f"💭 Reasoning disabled for {model}")
        
        # Track plan_tool_call_id for injecting into set_plan tool call
        plan_tool_call_id = None
        
        # Use streaming if agent_id and stream_id are provided
        if agent_id and stream_id:
            from helpers.messages import stream_assistant_chunk, stream_plan_event
            
            sequence_counter = [0]  # Use list to allow mutation in closure
            last_streamed_text = [""]  # Track what we've already sent to compute delta
            
            async def on_chunk(text_so_far: str, token_count: int):
                """Callback for streaming chunks - sends DELTA to frontend."""
                try:
                    # Compute delta (only the new text)
                    delta = text_so_far[len(last_streamed_text[0]):]
                    if delta:  # Only send if there's new content
                        await stream_assistant_chunk(
                            agent_id=agent_id,
                            stream_id=stream_id,
                            delta=delta,
                            done=False,
                            sequence=sequence_counter[0]
                        )
                        sequence_counter[0] += 1
                        last_streamed_text[0] = text_so_far
                except Exception as e:
                    # Don't fail on streaming errors - it's best-effort
                    logger.warning(f"Streaming chunk failed (non-fatal): {str(e)}")
            
            async def on_plan_start(tool_call_id: str):
                """Broadcast plan start via Realtime (no DB insert)."""
                try:
                    await stream_plan_event(
                        agent_id=agent_id,
                        stream_id=stream_id,
                        tool_call_id=tool_call_id,
                        title="Generating Plan...",
                    )
                except Exception as e:
                    logger.warning(f"Plan start notification failed (non-fatal): {str(e)}")
            
            async def on_plan_title(tool_call_id: str, title: str):
                """Broadcast plan title via Realtime (no DB insert)."""
                try:
                    await stream_plan_event(
                        agent_id=agent_id,
                        stream_id=stream_id,
                        tool_call_id=tool_call_id,
                        title='Building Plan: ' + title,
                    )
                except Exception as e:
                    logger.warning(f"Plan title notification failed (non-fatal): {str(e)}")
            
            logger.info(f"📡 Using streaming LLM call for agent {agent_id}")
            result, usage, plan_tool_call_id = await call_llm_structured_streaming(
                messages=messages,
                model=model,
                temperature=0.7,
                max_tokens=4096,
                response_model=AgentActionModel,
                on_chunk=on_chunk,
                reasoning_max_tokens=effective_reasoning_tokens,
                model_preference=model_preference,
                agent_id=agent_id,  # For cancellation checking
                on_plan_start=on_plan_start,
                on_plan_title=on_plan_title,
            )
            
            # Send final "done" chunk (delta may be empty if all content already streamed)
            try:
                final_delta = ""
                if hasattr(result, 'response') and result.response:
                    final_delta = result.response[len(last_streamed_text[0]):]
                await stream_assistant_chunk(
                    agent_id=agent_id,
                    stream_id=stream_id,
                    delta=final_delta,
                    done=True,
                    sequence=sequence_counter[0]
                )
            except Exception as e:
                logger.warning(f"Final stream chunk failed (non-fatal): {str(e)}")
        else:
            # Streaming is required - agent_id and stream_id must be provided
            raise ValueError("decide_next_action requires agent_id and stream_id for streaming")
        
        # Validate result - STRICT: no silent failures
        if result is None:
            raise ValueError(f"call_llm_structured returned None result (model={model})")
        
        # Note: reasoning field is optional/removed from schema - don't check for it
        
        if not hasattr(result, 'response'):
            raise ValueError(f"LLM result missing 'response' field (model={model}, result_type={type(result)})")
        
        if not hasattr(result, 'tool_calls'):
            raise ValueError(f"LLM result missing 'tool_calls' field (model={model}, result_type={type(result)})")
        
        if usage is None:
            raise ValueError(f"call_llm_structured returned None usage (model={model})")
        
        logger.info(
            "Action decided",
            reasoning=getattr(result, 'reasoning', None),
            response=result.response,
            tool_calls_count=len(result.tool_calls) if result.tool_calls else 0,
            tokens=usage.get("total_tokens", 0),
            actual_model=usage.get("actual_model"),  # Which model from pool was used
            pool_name=usage.get("pool_name")
        )
        
        # Convert tool calls to dict format for workflow
        # Each tool model has different fields, so we serialize to dict
        tool_calls_dict = []
        if result.tool_calls:
            for i, tc in enumerate(result.tool_calls):
                if tc is None:
                    logger.warning(f"Skipping None tool call at index {i}")
                    continue
                try:
                    # Convert Pydantic model to dict
                    tc_dict = tc.model_dump() if hasattr(tc, 'model_dump') else tc.dict()
                    tool_calls_dict.append(tc_dict)
                except Exception as e:
                    logger.error(f"Failed to serialize tool call {i}: {str(e)}, tc_type={type(tc)}")
                    raise ValueError(f"Failed to serialize tool call {i}: {str(e)}")
        
        # Inject pre-generated plan_tool_call_id into set_plan tool call
        # This ensures the IN_PROGRESS messages match the FINISHED message
        if plan_tool_call_id:
            for tc in tool_calls_dict:
                if tc.get("tool") == "set_plan":
                    tc["tool_call_id"] = plan_tool_call_id
                    logger.info(f"📋 Injected plan_tool_call_id={plan_tool_call_id} into set_plan tool call")
        
        # Return as dict with usage for token tracking
        # Allow empty strings/lists, but not None values
        # Note: reasoning field may not exist if schema removed it
        return {
            "reasoning": getattr(result, 'reasoning', None) or "",
            "response": result.response if result.response is not None else "",
            "tool_calls": tool_calls_dict,
            "usage": usage  # Already validated to not be None above
        }
        
    except Exception as e:
        logger.error("Failed to decide action", error=str(e))
        raise


@activity.defn
async def check_progress(
    context: List[Dict[str, Any]],
    verifier_prompt: str,
    model: str = "anthropic/claude-sonnet-4.5",
    phase: str = "EXECUTE"
) -> Dict[str, Any]:
    """
    Use LLM judge to check progress toward goal.
    
    Args:
        context: Message history (first USER message is the goal)
        verifier_prompt: Custom LLM judge prompt
        model: LLM model to use
        phase: Current workflow phase (PREPARE_RESEARCH, RESEARCH, ATOMIZE, PLAN, SPAWN, EXECUTE)
        
    Returns:
        Dict with 'score' (float 0.0-1.0) and 'reasoning' (str)
    """
    try:
        activity.heartbeat("Checking progress with LLM judge")
        
        config = load_config()
        client = AsyncOpenAI(
            api_key=config.openrouter.api_key,
            base_url=config.openrouter.base_url
        )
        
        # Zod schema for response validation (documented for OpenRouter)
        response_schema = {
            "type": "object",
            "properties": {
                "reasoning": {
                    "type": "string",
                    "description": "Your internal thinking process about the progress"
                },
                "response": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1,
                    "description": "Progress score from 0.0 (no progress) to 1.0 (complete)"
                }
            },
            "required": ["reasoning", "response"],
            "additionalProperties": False
        }
        
        system_prompt = build_verifier_prompt(phase, verifier_prompt)
        
        # Convert full context to OpenAI message format (no truncation)
        # NOTE: SYSTEM messages (like blueprints) are excluded from verifier - they're only for decide_next_action
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
        
        # Use streaming LLM call (no-op callback since we don't stream verifier output)
        async def noop_chunk(text_so_far: str, token_count: int):
            pass
        
        result, usage, _ = await call_llm_structured_streaming(
            messages=messages,
            model=model,
            temperature=0.3,
            max_tokens=4096,  # Generous limit for verifier reasoning
            response_model=ProgressScore,
            on_chunk=noop_chunk
        )
        
        logger.info(
            "Progress checked",
            progress=result.response,
            reasoning=result.reasoning,
            tokens=usage.get("total_tokens", 0),
            actual_model=usage.get("actual_model"),  # Which model from pool was used
            pool_name=usage.get("pool_name")
        )
        
        # For verifier: concatenate reasoning and response (score) in message
        return {
            "score": result.response,
            "reasoning": result.reasoning,
            "message": f"{result.reasoning}\n\nScore: {result.response}",
            "usage": usage
        }
    except Exception as e:
        logger.error("Failed to check progress", error=str(e))
        # Return 0.5 on error to keep agent running, with empty usage
        error_message = f"Progress check failed: {str(e)}"
        return {
            "score": 0.5,
            "reasoning": error_message,
            "message": f"{error_message}\n\nScore: 0.5",
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        }

