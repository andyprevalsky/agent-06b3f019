"""
Reasoning Activity - Execute reasoning tasks from DAG.

Called when a DAG task has tool_name="reasoning". Uses call_llm_structured_streaming
to stream content back to the frontend like the main agent loop does.
"""

from typing import Dict, List, Optional
from temporalio import activity
from pydantic import BaseModel, Field
import structlog

from helpers.llm import call_llm_structured_streaming, build_llm_messages
from helpers.messages import stream_assistant_chunk

logger = structlog.get_logger()


def _safe_heartbeat(msg: str):
    """Safe heartbeat that only calls when in activity context."""
    try:
        activity.heartbeat(msg)
    except Exception:
        pass  # Not in activity context


class ReasoningResponse(BaseModel):
    """Output from a reasoning task - simple response only, no tools."""
    response: str = Field(description="Your reasoning, analysis, and conclusions")


@activity.defn
async def execute_reasoning_activity(
    goal: str,
    context: List[Dict],
    model: str,
    agent_id: Optional[str] = None,
    stream_id: Optional[str] = None,
) -> Dict:
    """
    Execute a reasoning task using LLM with streaming.

    Streams content back to the frontend via Supabase Realtime,
    following the same pattern as call_llm_activity.

    Args:
        goal: The reasoning task goal
        context: Full message context
        model: Model to use (same as execute loop)
        agent_id: Agent ID for streaming (optional)
        stream_id: Stream session ID for ordering (optional)

    Returns:
        Dict with 'content' string and 'usage' dict for cost tracking
    """
    system_prompt = f"""You are an AI assistant performing a reasoning task as part of a larger plan.

TASK:
{goal}

INSTRUCTIONS:
1. Analyze the conversation context and any previous results
2. Think through the task step by step
3. Provide your analysis, insights, or conclusions
4. Be thorough but concise
5. Focus on information that will be useful for subsequent tasks

Provide your reasoning and conclusions directly."""

    # Use build_llm_messages which handles file attachments (images, PDFs, etc.)
    # This ensures the LLM can see attached files when reasoning
    messages = await build_llm_messages(context, system_prompt)

    # Keep last N messages to stay within context limits (preserve system prompt at index 0)
    max_context_messages = 30
    if len(messages) > max_context_messages + 1:  # +1 for system prompt
        messages = [messages[0]] + messages[-(max_context_messages):]

    # Append final instruction
    messages.append({"role": "user", "content": f"Please complete this reasoning task: {goal}"})

    _safe_heartbeat("Starting reasoning task")

    # Streaming state
    sequence = [0]
    last_text = [""]

    async def on_chunk(text_so_far: str, tokens: int):
        """Stream chunks to frontend via Supabase Realtime."""
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
                )
                sequence[0] += 1
            last_text[0] = text_so_far

    try:
        # Use call_llm_structured_streaming with simple ReasoningResponse model (no tools)
        result, usage, _ = await call_llm_structured_streaming(
            messages=messages,
            model=model,
            temperature=0.7,
            max_tokens=4000,
            response_model=ReasoningResponse,
            on_chunk=on_chunk,
            agent_id=agent_id,
            call_site="dag_reasoning",
        )

        content = result.response if result and result.response else ""

        # Send final done=True chunk
        if agent_id and stream_id:
            try:
                final_delta = content[len(last_text[0]):] if content else ""
                await stream_assistant_chunk(
                    agent_id=agent_id,
                    stream_id=stream_id,
                    delta=final_delta,
                    done=True,
                    sequence=sequence[0],
                )
            except Exception as e:
                logger.warning(f"Final stream chunk failed (non-fatal): {e}")

        if not content:
            logger.error("[Reasoning] Empty response from LLM")
            return {"content": "Unable to complete reasoning task.", "usage": usage}

        logger.info(f"[Reasoning] Completed task, output length: {len(content)} chars")
        return {"content": content, "usage": usage}

    except Exception as e:
        logger.error(f"[Reasoning] Error calling LLM: {e}")
        raise
