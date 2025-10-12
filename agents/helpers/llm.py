"""LLM tool for agent reasoning and decision making."""

from typing import List, Dict, Optional, Any, TypeVar
from temporalio import activity
import structlog
import json
from openai import AsyncOpenAI
from pydantic import BaseModel, Field

from config import load_config

logger = structlog.get_logger()

T = TypeVar('T', bound=BaseModel)


# Pydantic models for structured LLM outputs
class ToolCall(BaseModel):
    """Single tool call."""
    tool: str = Field(description="Name of the tool to use (e.g., 'wait_seconds', 'web_search')")
    args: List[str] = Field(description="Arguments to pass to the tool")


class AgentAction(BaseModel):
    """Schema for agent's next action decision."""
    reasoning: str = Field(description="Your internal thinking process (not shown to user)")
    response: str = Field(description="Message to communicate to the user (REQUIRED - always explain what you're doing)")
    tool_calls: List[ToolCall] = Field(default_factory=list, description="List of tools to call in sequence. Can be empty if you're just communicating without taking action.")


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
        
        # Build tool list from DB descriptions
        tools_list = "\n".join([
            f"- {tool['name']}: {tool['description']}"
            for tool in available_tools
        ])
        
        system_prompt = f"""You are an autonomous AI agent working on the task described in the conversation history.

You have access to these tools:
{tools_list}

IMPORTANT:
- Use "reasoning" for your internal thinking (logged, not shown to user)
- Use "response" to communicate directly with the user
- You can call MULTIPLE tools in one turn (they'll execute sequentially)
- As you work, you'll receive messages from a verifier who will check your progress and give you reasoning for the score you are at.
- you may also receive a blueprint in your system messages, a blueprint synthesizes key learnings from successful task completions for related goals. Use them to inform your decision making.
- Your goal is to get to 100% progress.

Respond in JSON format:
{{
  "reasoning": "your internal thinking (for logging)",
  "response": "message to show the user explaining what you're doing (REQUIRED)",
  "tool_calls": [
    {{"tool": "tool_name", "args": ["arg1", "arg2"]}},
    {{"tool": "another_tool", "args": ["arg"]}}
  ]
}}

You can call multiple tools, or just communicate, or both.

Be strategic, efficient, and focused on accomplishing the task."""
        
        # Convert full context to OpenAI message format (no truncation)
        # NOTE: SYSTEM messages (like blueprints) ARE included for decide_next_action
        # Role mapping: SYSTEM -> system, ASSISTANT -> assistant, USER -> user, TOOL -> assistant
        messages = [{"role": "system", "content": system_prompt}]
        
        for msg in context:
            role = msg.get('role', 'ASSISTANT')
            content = msg.get('text', '')
            
            # Map our roles to OpenAI/OpenRouter format (includes system messages like blueprints)
            if role == 'SYSTEM':
                messages.append({"role": "system", "content": content})
            elif role == 'USER':
                messages.append({"role": "user", "content": content})
            else:  # ASSISTANT or TOOL
                messages.append({"role": "assistant", "content": content})
        
        # Add final prompt
        messages.append({"role": "user", "content": "Based on everything so far, what should I do next?"})
        
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
            max_tokens=500,
            response_model=AgentAction,
            reasoning_effort=effort
        )
        
        logger.info(
            "Action decided",
            reasoning=result.reasoning,
            response=result.response,
            tool_calls_count=len(result.tool_calls),
            tokens=usage.get("total_tokens", 0)
        )
        
        # Return as dict with usage for token tracking
        return {
            "reasoning": result.reasoning,
            "response": result.response,
            "tool_calls": [{"tool": tc.tool, "args": tc.args} for tc in result.tool_calls],
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
        
        for msg in context:
            role = msg.get('role', 'ASSISTANT')
            content = msg.get('text', '')
            
            # Map our roles to OpenAI/OpenRouter format (SKIP system messages like blueprints)
            if role == 'SYSTEM':
                continue  # Don't send blueprints or other system messages to verifier
            elif role == 'USER':
                messages.append({"role": "user", "content": content})
            else:  # ASSISTANT or TOOL
                messages.append({"role": "assistant", "content": content})
        
        # Add final evaluation prompt
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

