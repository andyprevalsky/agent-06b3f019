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
class AgentAction(BaseModel):
    """Schema for agent's next action decision."""
    tool: str = Field(description="Name of the tool to use (e.g., 'wait_seconds', 'web_search')")
    args: List[str] = Field(description="Arguments to pass to the tool")
    reasoning: str = Field(description="Explanation of why this action was chosen")


class ProgressScore(BaseModel):
    """Schema for progress evaluation."""
    score: float = Field(ge=0.0, le=1.0, description="Progress score from 0.0 (no progress) to 1.0 (complete)")
    reasoning: str = Field(description="Explanation of the score")


async def call_llm_structured(
    messages: List[Dict[str, str]],
    model: Optional[str],
    temperature: float,
    max_tokens: int,
    response_model: type[T]
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
    # Instructor automatically handles:
    # - Native structured outputs for models that support it (GPT-4o, etc)
    # - JSON mode + validation for models that don't (Claude, etc)
    # - Retry logic with validation errors
    # - Markdown stripping and parsing
    client = instructor.from_openai(base_client)
    
    # Call with structured output - Instructor handles everything
    # Use create_with_completion to get both the structured response and raw completion
    response, completion = await client.chat.completions.create_with_completion(
        model=model,
        messages=messages,
        temperature=temperature,
        max_tokens=max_tokens,
        response_model=response_model,
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
    goal: str,
    context: List[Dict],
    available_tools: List[Dict[str, str]],
    iteration: int,
    model: str = "anthropic/claude-sonnet-4.5"
) -> Dict[str, Any]:
    """
    Use LLM to decide what action to take next.
    
    Args:
        goal: The agent's goal
        context: Message history
        available_tools: List of dicts with 'name' and 'description' for each tool
        iteration: Current iteration number
        model: LLM model to use
        
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
        
        system_prompt = f"""You are an autonomous AI agent. Your goal is: {goal}

You have access to these tools:
{tools_list}

Your job is to decide the NEXT SINGLE ACTION to take toward the goal.

Respond in JSON format:
{{
  "tool": "tool_name",
  "args": ["arg1", "arg2"],
  "reasoning": "why you're taking this action"
}}

Be strategic, efficient, and focused on the goal."""
        
        # Convert full context to OpenAI message format (no truncation)
        # Role mapping: SYSTEM -> system, ASSISTANT -> assistant, USER -> user, TOOL -> assistant
        messages = [{"role": "system", "content": system_prompt}]
        
        for msg in context:
            role = msg.get('role', 'ASSISTANT')
            content = msg.get('text', '')
            
            # Map our roles to OpenAI/OpenRouter format
            if role == 'SYSTEM':
                messages.append({"role": "system", "content": content})
            elif role == 'USER':
                messages.append({"role": "user", "content": content})
            else:  # ASSISTANT or TOOL
                messages.append({"role": "assistant", "content": content})
        
        # Add final prompt
        messages.append({"role": "user", "content": "Based on everything so far, what should I do next?"})
        
        # Use structured output with Pydantic schema
        result, usage = await call_llm_structured(
            messages=messages,
            model=model,
            temperature=0.7,
            max_tokens=500,
            response_model=AgentAction
        )
        
        logger.info(
            "Action decided",
            tool=result.tool,
            reasoning=result.reasoning,
            tokens=usage.get("total_tokens", 0)
        )
        
        # Return as dict with usage for token tracking
        return {
            "tool": result.tool,
            "args": result.args,
            "reasoning": result.reasoning,
            "usage": usage
        }
        
    except Exception as e:
        logger.error("Failed to decide action", error=str(e))
        raise


@activity.defn
async def check_progress(
    goal: str,
    context: List[Dict],
    verifier_prompt: str,
    model: str = "anthropic/claude-sonnet-4.5"
) -> Dict[str, Any]:
    """
    Use LLM judge to check progress toward goal.
    
    Args:
        goal: The agent's goal
        context: Message history
        verifier_prompt: Custom LLM judge prompt
        
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
                "progress": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1,
                    "description": "Progress score from 0.0 (no progress) to 1.0 (complete)"
                },
                "reasoning": {
                    "type": "string",
                    "description": "Brief explanation of the score"
                }
            },
            "required": ["progress", "reasoning"],
            "additionalProperties": False
        }
        
        system_prompt = f"""You are an impartial judge evaluating an AI agent's progress.

Goal: {goal}

Evaluation criteria:
{verifier_prompt}

Based on the agent's actions so far, provide a progress score from 0.0 to 1.0:
- 0.0 = No progress at all
- 0.25 = Made some initial progress
- 0.5 = Halfway to goal
- 0.75 = Nearly complete
- 1.0 = Goal fully achieved

You MUST respond with valid JSON matching this exact schema:
{{
  "progress": <number between 0.0 and 1.0>,
  "reasoning": "<brief explanation>"
}}"""
        
        # Convert full context to OpenAI message format (no truncation)
        messages = [{"role": "system", "content": system_prompt}]
        
        for msg in context:
            role = msg.get('role', 'ASSISTANT')
            content = msg.get('text', '')
            
            # Map our roles to OpenAI/OpenRouter format
            if role == 'SYSTEM':
                messages.append({"role": "system", "content": content})
            elif role == 'USER':
                messages.append({"role": "user", "content": content})
            else:  # ASSISTANT or TOOL
                messages.append({"role": "assistant", "content": content})
        
        # Add final evaluation prompt
        messages.append({"role": "user", "content": "Evaluate the agent's progress toward the goal as JSON."})
        
        # Debug: Log context size to detect contamination
        logger.info(
            "Verifier context",
            total_messages=len(context),
            agent_messages=len([m for m in context if m.get('role') == 'ASSISTANT']),
            context_summary=[f"{m.get('role')}: {m.get('text', '')[:50]}..." for m in context[-5:]]  # Last 5 messages
        )
        
        # Use structured output with Pydantic schema
        result, usage = await call_llm_structured(
            messages=messages,
            model=model,
            temperature=0.3,
            max_tokens=300,
            response_model=ProgressScore
        )
        
        logger.info(
            "Progress checked",
            progress=result.score,
            reasoning=result.reasoning,
            tokens=usage.get("total_tokens", 0)
        )
        
        return {
            "score": result.score,
            "reasoning": result.reasoning,
            "usage": usage
        }
    except Exception as e:
        logger.error("Failed to check progress", error=str(e))
        # Return 0.5 on error to keep agent running, with empty usage
        return {
            "score": 0.5,
            "reasoning": f"Progress check failed: {str(e)}",
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        }

