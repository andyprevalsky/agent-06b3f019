"""LLM tool for agent reasoning and decision making."""

from typing import List, Dict, Optional, Any, TypeVar, Union, Type, Literal
from temporalio import activity
import structlog
import json
from openai import AsyncOpenAI
from pydantic import BaseModel, Field, create_model

from config import load_config

logger = structlog.get_logger()

T = TypeVar('T', bound=BaseModel)


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
    def get_timestamp(msg: Dict[str, Any]) -> datetime:
        """Parse ISO timestamp, defaulting to epoch if missing/invalid."""
        ts = msg.get('timestamp', '1970-01-01T00:00:00Z')
        try:
            # Handle both with and without timezone
            if ts.endswith('Z'):
                ts = ts[:-1] + '+00:00'
            return datetime.fromisoformat(ts)
        except (ValueError, AttributeError):
            return datetime(1970, 1, 1)
    
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


# ============================================================================
# Individual Tool Pydantic Models
# ============================================================================

class VerifierConfig(BaseModel):
    """Verifier configuration for evaluating agent success."""
    type: Literal["FLOAT_LLM_JUDGE"] = Field(description="Must be 'FLOAT_LLM_JUDGE'")
    llm_judge_prompt: str = Field(description="Prompt for the LLM judge to evaluate the agent's performance")


class SubAgentConfig(BaseModel):
    """Configuration for a single sub-agent."""
    goal: str = Field(description="The goal/task for this sub-agent")
    model: Optional[str] = Field(None, description="LLM model to use (inherits from parent if not specified)")
    reasoning_effort: Optional[str] = Field(None, description="Reasoning effort: 'off', 'low', 'medium', 'high'")
    tool_ids: Optional[List[str]] = Field(default_factory=list, description="List of tool UUIDs this sub-agent can use")
    verifier: VerifierConfig = Field(description="Verifier config with type='FLOAT_LLM_JUDGE' and llm_judge_prompt")


class SpawnSubAgentsTool(BaseModel):
    """Tool call for spawning multiple sub-agents to work on parallel subtasks."""
    tool: Literal["spawn_sub_agents"]
    sub_agents: List[SubAgentConfig] = Field(description="List of sub-agent configurations to spawn")


class WaitSecondsTool(BaseModel):
    """Tool call for pausing execution."""
    tool: Literal["wait_seconds"]
    seconds: int = Field(ge=1, le=3600, description="Number of seconds to wait (1-3600)")


class WebSearchTool(BaseModel):
    """Tool call for searching the web with real-time information."""
    tool: Literal["web_search"]
    query: str = Field(description="Search query or question about current/recent information")


class DeepResearchTool(BaseModel):
    """Tool call for comprehensive multi-step research on complex topics."""
    tool: Literal["deep_research"]
    query: str = Field(description="Complex research topic or question requiring in-depth analysis")
    max_tokens: Optional[int] = Field(default=4000, description="Maximum tokens for response")


# Map tool names to their Pydantic models
TOOL_MODELS = {
    "spawn_sub_agents": SpawnSubAgentsTool,
    "wait_seconds": WaitSecondsTool,
    "web_search": WebSearchTool,
    "deep_research": DeepResearchTool,
}


# ============================================================================
# Dynamic Tool Documentation Generation
# ============================================================================

def generate_tool_parameter_docs(available_tool_names: List[str]) -> str:
    """
    Dynamically generate tool parameter documentation from Pydantic models.
    
    This ensures tool docs never get out of sync with actual implementations.
    
    Args:
        available_tool_names: List of tool names to document
        
    Returns:
        Formatted string documenting each tool's parameters
    """
    docs_lines = []
    
    for tool_name in available_tool_names:
        if tool_name not in TOOL_MODELS:
            continue
            
        model = TOOL_MODELS[tool_name]
        
        # Get field info from Pydantic model
        fields_info = []
        for field_name, field in model.model_fields.items():
            # Skip the 'tool' field (it's just the literal name)
            if field_name == 'tool':
                continue
                
            # Get description from Field metadata
            description = field.description or "No description"
            
            # Get type hint
            field_type = field.annotation
            
            # Format type name nicely
            type_name = str(field_type)
            if 'List[' in type_name:
                type_name = 'list'
            elif 'str' in type_name:
                type_name = 'string'
            elif 'int' in type_name:
                type_name = 'integer'
            elif 'float' in type_name:
                type_name = 'float'
            
            # Add constraints if present
            constraints = []
            if hasattr(field, 'ge') and field.ge is not None:
                constraints.append(f"min: {field.ge}")
            if hasattr(field, 'le') and field.le is not None:
                constraints.append(f"max: {field.le}")
            
            constraint_str = f" ({', '.join(constraints)})" if constraints else ""
            
            fields_info.append(f'"{field_name}" ({type_name}{constraint_str}): {description}')
        
        # Format documentation for this tool
        if fields_info:
            docs_lines.append(f"- {tool_name}: {', '.join(fields_info)}")
        else:
            docs_lines.append(f"- {tool_name}: no parameters needed")
    
    return "\n".join(docs_lines)


# ============================================================================
# Dynamic AgentAction Model Generation
# ============================================================================

def create_agent_action_model(available_tool_names: List[str]) -> Type[BaseModel]:
    """
    Dynamically create an AgentAction Pydantic model based on available tools.
    
    This ensures:
    - Only available tools are in the schema (better LLM guidance)
    - Type-safe tool calls (Pydantic validates structure)
    - No JSON string parsing hacks needed
    
    Args:
        available_tool_names: List of tool names this agent can use
        
    Returns:
        Pydantic model class for AgentAction with proper tool union
    """
    # Build list of tool models for available tools
    tool_types = []
    for name in available_tool_names:
        if name in TOOL_MODELS:
            tool_types.append(TOOL_MODELS[name])
        else:
            logger.warning(f"Tool '{name}' not found in TOOL_MODELS, skipping")
    
    # Create union type for tool calls
    if not tool_types:
        # No tools available - agent can only communicate
        ToolCallUnion = type(None)  # Empty type
        tool_calls_field = (List[ToolCallUnion], Field(default_factory=list, description="No tools available for this agent"))
    elif len(tool_types) == 1:
        # Single tool type - no union needed
        ToolCallUnion = tool_types[0]
        tool_calls_field = (List[ToolCallUnion], Field(default_factory=list, description="List of tools to call in sequence"))
    else:
        # Multiple tools - create union
        ToolCallUnion = Union[tuple(tool_types)]
        tool_calls_field = (List[ToolCallUnion], Field(default_factory=list, description="List of tools to call in sequence"))
    
    # Dynamically create the AgentAction model
    AgentAction = create_model(
        'AgentAction',
        reasoning=(Optional[str], Field(default=None, description="Your internal thinking process (not shown to user)")),
        response=(str, Field(description="Message to communicate to the user (REQUIRED - always explain what you're doing)")),
        tool_calls=tool_calls_field,
        __base__=BaseModel
    )
    
    return AgentAction


# ============================================================================
# Static Models (not tool-specific)
# ============================================================================

class ProgressScore(BaseModel):
    """Schema for progress evaluation."""
    reasoning: str = Field(description="Your internal thinking process about the progress")
    response: float = Field(ge=0.0, le=1.0, description="Progress score from 0.0 (no progress) to 1.0 (complete)")


async def call_llm_structured(
    messages: List[Dict[str, str]],
    model: Optional[str],
    temperature: float,
    max_tokens: int,
    response_model: type[T],
    reasoning_effort: Optional[str] = None
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
        
    Returns:
        Tuple of (response_model instance, usage dict with token counts)
    """
    # Lazy import instructor to avoid loading rich/threading.local in workflow sandbox
    # Instructor must only be imported in activities, not at module level
    import instructor
    from instructor import Instructor
    
    config = load_config()
    
    # Create OpenAI client
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
    response, completion = await client.chat.completions.create_with_completion(
        model=model,
        messages=messages,
        temperature=temperature,
        max_tokens=max_tokens,
        response_model=response_model,
        **extra_args
    )
    
    # Extract usage data from completion
    usage = {
        "prompt_tokens": completion.usage.prompt_tokens if completion.usage else 0,
        "completion_tokens": completion.usage.completion_tokens if completion.usage else 0,
        "total_tokens": completion.usage.total_tokens if completion.usage else 0
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
        client = AsyncOpenAI(
            api_key=config.openrouter.api_key,
            base_url=config.openrouter.base_url
        )
        
        model = model or config.openrouter.model
        
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
    available_tools: List[Dict[str, str]],
    available_tool_names: List[str],
    iteration: int,
    model: str = "anthropic/claude-sonnet-4.5",
    reasoning_effort: str = "low"
) -> Dict[str, Any]:
    """
    Use LLM to decide what action to take next.
    
    Args:
        context: Message history (first USER message is the goal)
        available_tools: List of dicts with 'name' and 'description' for each tool
        iteration: Current iteration number
        model: LLM model to use
        reasoning_effort: OpenRouter reasoning effort level (low, medium, high)
        
    Returns:
        Dict with 'tool', 'args', 'reasoning'
    """
    try:
        activity.heartbeat(f"Deciding next action (iteration {iteration})")
        
        # Build tool list from DB descriptions (including IDs for spawn_sub_agents)
        tools_list = "\n".join([
            f"- {tool['name']} (id: {tool['id']}): {tool['description']}"
            for tool in available_tools
        ])
        
        # Generate parameter documentation dynamically from Pydantic models
        tool_params_docs = generate_tool_parameter_docs(available_tool_names)
        
        system_prompt = f"""You are an autonomous AI agent working on the task described in the conversation history.

You have access to these tools:
{tools_list}

HOW THIS WORKS:
- You are in a continuous loop that will run until the task is complete (100% progress)
- Each turn, you think, respond, and/or use tools
- After EVERY response you make, a verifier evaluates your progress and gives you feedback
- The verifier provides a score (0-100%) and reasoning about what you've accomplished so far
- Use this feedback to guide your next actions and course-correct if needed
- This conversation continues until the verifier confirms you've reached 100%

YOUR RESPONSES:
- Use "reasoning" for your internal thinking (logged, not shown to user)
- Use "response" to communicate directly with the user
- You can call MULTIPLE tools in one turn (they'll execute sequentially)

ADDITIONAL CONTEXT:
- You may receive a blueprint in your system messages - a synthesis of key learnings from successful task completions for similar goals. Use them to inform your decision making.

Each tool has its own parameter structure - follow the schema exactly:
{tool_params_docs}

You can call multiple tools, or just communicate, or both.

Be strategic, efficient, and focused on accomplishing the task."""
        
        # Convert full context to OpenAI message format (no truncation)
        # NOTE: SYSTEM messages (like blueprints) ARE included for decide_next_action
        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(convert_context_to_messages(context, include_system=True))
        messages.append({"role": "user", "content": "Based on everything so far, what should I do next?"})
        
        # Create custom AgentAction model based on available tools
        AgentActionModel = create_agent_action_model(available_tool_names)
        
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
            reasoning_effort=effort
        )
        
        logger.info(
            "Action decided",
            reasoning=result.reasoning,
            response=result.response,
            tool_calls_count=len(result.tool_calls),
            tokens=usage.get("total_tokens", 0)
        )
        
        # Convert tool calls to dict format for workflow
        # Each tool model has different fields, so we serialize to dict
        tool_calls_dict = []
        for tc in result.tool_calls:
            # Convert Pydantic model to dict
            tc_dict = tc.model_dump() if hasattr(tc, 'model_dump') else tc.dict()
            tool_calls_dict.append(tc_dict)
        
        # Return as dict with usage for token tracking
        return {
            "reasoning": result.reasoning,
            "response": result.response,
            "tool_calls": tool_calls_dict,
            "usage": usage
        }
        
    except Exception as e:
        logger.error("Failed to decide action", error=str(e))
        raise


@activity.defn
async def check_progress(
    context: List[Dict[str, Any]],
    verifier_prompt: str,
    model: str = "anthropic/claude-sonnet-4.5"
) -> Dict[str, Any]:
    """
    Use LLM judge to check progress toward goal.
    
    Args:
        context: Message history (first USER message is the goal)
        verifier_prompt: Custom LLM judge prompt
        model: LLM model to use
        
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
        
        system_prompt = f"""You are an impartial judge evaluating an AI agent's progress toward completing the task described in the conversation history.

Evaluation criteria:
{verifier_prompt}

Based on the agent's actions and the conversation so far, provide a progress score from 0.0 to 1.0.

You MUST respond with valid JSON matching this exact schema:
{{
  "reasoning": "<your internal thinking process>",
  "response": <number between 0.0 and 1.0>
}}"""
        
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
            tokens=usage.get("total_tokens", 0)
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

