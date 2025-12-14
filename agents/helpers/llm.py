"""LLM tool for agent reasoning and decision making."""

from typing import List, Dict, Optional, Any, TypeVar, Type
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


async def call_llm_structured(
    messages: List[Dict[str, str]],
    model: Optional[str],
    temperature: float,
    max_tokens: int,
    response_model: type[T],
    reasoning_effort: Optional[str] = None,
    model_preference: Optional[str] = None
) -> tuple[T, Dict]:
    """
    Call LLM with structured outputs using Instructor.
    
    Instructor handles all the complexity of different models' structured output
    capabilities and automatically falls back to appropriate methods.
    
    Args:
        messages: List of message dicts with 'role' and 'content'
        model: Model to use
        temperature: Sampling temperature
        max_tokens: Maximum tokens
        response_model: Pydantic model class for response structure
        reasoning_effort: Optional reasoning effort level ("high", "medium", "low")
        model_preference: Optional Rose model preference ("SMART", "FAST", "CHEAP")
        
    Returns:
        Tuple of (response_model instance, usage dict with token counts)
    """
    # Lazy import instructor to avoid loading rich/threading.local in workflow sandbox
    # Instructor must only be imported in activities, not at module level
    import instructor
    from instructor import Instructor
    
    config = load_config()
    
    # Check if this is a Rose model - route to Supabase edge function
    is_rose_model = model is not None and ('rose-labs' in model.lower() or model.lower() in ['rose', 'rose-ultra'])
    
    if is_rose_model:
        # Use httpx directly for Rose models (Supabase function is at /completions, not /chat/completions)
        import httpx
        
        logger.info(f"🌹 Routing Rose model to Supabase: {model} → {config.rose.api_url}")
        
        # Build JSON schema from Pydantic model for structured output
        # Use prepare_schema_for_openai to ensure strict mode compatibility
        # (adds additionalProperties: false to all objects, ensures all fields required)
        schema = prepare_schema_for_openai(response_model)
        schema_str = json.dumps(schema)
        logger.info(f"📋 Schema size: {len(schema_str)} chars (Cerebras limit: 5000)")
        if len(schema_str) > 5000:
            logger.warning(f"⚠️ Schema exceeds Cerebras 5000 char limit! May cause 400 error.")
        
        request_body = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": response_model.__name__,
                    "schema": schema,
                    "strict": True
                }
            }
        }
        
        # Add model_preference for Rose pool selection (SMART, FAST, CHEAP)
        if model_preference:
            request_body["model_preference"] = model_preference
            logger.info(f"🎯 Using model_preference: {model_preference}")
        
        # Make direct HTTP call to Supabase function
        async with httpx.AsyncClient(timeout=120.0) as http_client:
            for attempt in range(3):
                try:
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
                    break
                except httpx.HTTPStatusError as e:
                    error_body = e.response.text[:1000] if e.response.text else "No response body"
                    logger.warning(f"Rose API attempt {attempt + 1} failed: {e.response.status_code}", error_body=error_body)
                    if attempt == 2:
                        raise
                except Exception as e:
                    logger.warning(f"Rose API attempt {attempt + 1} failed: {str(e)}")
                    if attempt == 2:
                        raise
        
        data = http_response.json()
        
        # Log the actual model selected from the pool (for debugging tool call issues)
        actual_model = data.get("actual_model", "unknown")
        pool_name = data.get("pool_name", "unknown")
        pool_size = data.get("pool_size", 0)
        logger.info(f"🎯 Rose pool selection: {model} → {actual_model} (pool={pool_name}, size={pool_size})")
        
        # Parse the response content as JSON and validate with Pydantic
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "{}")
        try:
            parsed_content = json.loads(content)
            response = response_model.model_validate(parsed_content)
        except (json.JSONDecodeError, Exception) as e:
            logger.error(f"Failed to parse Rose response: {content[:500]}", error=str(e))
            raise ValueError(f"Failed to parse Rose response as {response_model.__name__}: {str(e)}")
        
        # Extract usage (include actual model for debugging)
        usage = {
            "prompt_tokens": data.get("usage", {}).get("prompt_tokens", 0),
            "completion_tokens": data.get("usage", {}).get("completion_tokens", 0),
            "total_tokens": data.get("usage", {}).get("total_tokens", 0),
            "actual_model": actual_model,
            "pool_name": pool_name,
            "pool_size": pool_size
        }
        
        return response, usage
    
    # Use OpenRouter for all other models
    base_client = AsyncOpenAI(
        api_key=config.openrouter.api_key,
        base_url=config.openrouter.base_url
    )
    
    # Patch client with Instructor for structured outputs
    # Force JSON mode instead of native function calling because:
    # - We have a LIST of tool calls in one response (not multiple function calls)
    # - Native function calling expects one function call per response
    # - JSON mode lets us have any structure we want
    client = instructor.from_openai(base_client, mode=instructor.Mode.JSON)
    
    # Build extra args for reasoning (OpenRouter reasoning tokens)
    extra_args = {}
    if reasoning_effort:
        extra_args["extra_body"] = {"reasoning": {"effort": reasoning_effort}}
    
    # Call with structured output - Instructor handles everything
    # Use create_with_completion to get both the structured response and raw completion
    try:
        response, completion = await client.chat.completions.create_with_completion(
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            response_model=response_model,
            max_retries=3,
            **extra_args
        )
    except Exception as e:
        logger.error(f"LLM call failed in create_with_completion: {str(e)}", model=model)
        raise
    
    # Validate response
    if response is None:
        raise ValueError(f"LLM returned None response (model={model})")
    
    if completion is None:
        raise ValueError(f"LLM returned None completion (model={model})")
    
    # Extract usage data from completion - STRICT: no silent failures
    if not hasattr(completion, 'usage'):
        raise ValueError(f"LLM completion missing 'usage' attribute (model={model}, completion_type={type(completion)})")
    
    if completion.usage is None:
        raise ValueError(f"LLM completion.usage is None (model={model})")
    
    if not hasattr(completion.usage, 'prompt_tokens'):
        raise ValueError(f"LLM completion.usage missing 'prompt_tokens' (model={model}, usage_type={type(completion.usage)})")
    
    if not hasattr(completion.usage, 'completion_tokens'):
        raise ValueError(f"LLM completion.usage missing 'completion_tokens' (model={model}, usage_type={type(completion.usage)})")
    
    if not hasattr(completion.usage, 'total_tokens'):
        raise ValueError(f"LLM completion.usage missing 'total_tokens' (model={model}, usage_type={type(completion.usage)})")
    
    usage = {
        "prompt_tokens": completion.usage.prompt_tokens,
        "completion_tokens": completion.usage.completion_tokens,
        "total_tokens": completion.usage.total_tokens
    }
    
    return response, usage


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
    reasoning_effort: str = "low",
    user_id: Optional[str] = None,
    phase: str = "EXECUTE",
    model_preference: Optional[str] = None
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
        reasoning_effort: OpenRouter reasoning effort level (low, medium, high)
        user_id: Optional Supabase user ID
        phase: Current workflow phase (PLAN or EXECUTE)
        model_preference: Optional Rose model preference (SMART, FAST, CHEAP)
        
    Returns:
        Dict with 'tool', 'args', 'reasoning'
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
        # Use the reasoning effort from agent settings (None if "off")
        effort = reasoning_effort if reasoning_effort != "off" else None
        if effort:
            logger.info(f"🧠 Using {effort} reasoning for {model}")
        else:
            logger.info(f"💭 Reasoning disabled for {model}")
        
        result, usage = await call_llm_structured(
            messages=messages,
            model=model,
            temperature=0.7,
            max_tokens=4096,
            response_model=AgentActionModel,
            reasoning_effort=effort,
            model_preference=model_preference
        )
        
        # Validate result - STRICT: no silent failures
        if result is None:
            raise ValueError(f"call_llm_structured returned None result (model={model})")
        
        if not hasattr(result, 'reasoning'):
            raise ValueError(f"LLM result missing 'reasoning' field (model={model}, result_type={type(result)})")
        
        if not hasattr(result, 'response'):
            raise ValueError(f"LLM result missing 'response' field (model={model}, result_type={type(result)})")
        
        if not hasattr(result, 'tool_calls'):
            raise ValueError(f"LLM result missing 'tool_calls' field (model={model}, result_type={type(result)})")
        
        if usage is None:
            raise ValueError(f"call_llm_structured returned None usage (model={model})")
        
        logger.info(
            "Action decided",
            reasoning=result.reasoning,
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
        
        # Return as dict with usage for token tracking
        # Allow empty strings/lists, but not None values
        return {
            "reasoning": result.reasoning if result.reasoning is not None else "",
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
        
        # Use structured output with Pydantic schema
        result, usage = await call_llm_structured(
            messages=messages,
            model=model,
            temperature=0.3,
            max_tokens=4096,  # Generous limit for verifier reasoning
            response_model=ProgressScore
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

