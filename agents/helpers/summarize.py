"""Tool for compressing agent context and generating completion summaries."""

from typing import List, Dict, Any
from temporalio import activity
import structlog

logger = structlog.get_logger()


@activity.defn
async def compress_context(
    context: List[Dict],
    iteration_count: int,
    model: str = "anthropic/claude-sonnet-4.5"
) -> str:
    """
    Use LLM to compress context into key learnings.

    Args:
        context: Full message history (first USER message is the goal)
        iteration_count: Current iteration number
        model: LLM model to use for compression

    Returns:
        Compressed learnings as a string (for system message)
    """
    try:
        activity.heartbeat(f"Compressing {len(context)} messages into learnings")

        # Import here to avoid circular dependency
        from helpers.llm import call_llm

        # Build full context
        full_context = "\n".join([
            f"[{msg.get('role', 'unknown')}] {msg.get('text', '')}"
            for msg in context
        ])

        prompt = f"""You are analyzing an autonomous AI agent's execution history to extract key learnings.

EXECUTION HISTORY ({len(context)} messages, {iteration_count} iterations):
{full_context}

Analyze this execution and extract:

1. **What went RIGHT** - Successful strategies, good decisions, effective tools used
2. **What went WRONG** - Mistakes made, failed approaches, errors encountered

Be concise but specific. Focus on actionable insights that would help the agent continue more effectively.

Format your response as:
## Key Learnings After {iteration_count} Iterations

### ✅ What Worked
- [specific successful action/strategy]
- [another success]

### ❌ What Didn't Work
- [specific mistake/failure]
- [another mistake]

### 💡 Recommended Approach Going Forward
- [concrete next steps based on learnings]
"""

        # Use call_llm which handles Rose model routing automatically
        result = await call_llm(
            messages=[{"role": "user", "content": prompt}],
            model=model,
            temperature=0.3,
            max_tokens=1000,
        )

        learnings = result.get("content", "")

        logger.info(
            "Context compressed",
            original_messages=len(context),
            learnings_length=len(learnings),
            tokens_used=result.get("usage", {}).get("total_tokens", 0)
        )

        return learnings

    except Exception as e:
        logger.error("Failed to compress context", error=str(e))
        # Fallback: just return a simple summary
        return f"""## Context Reset After {iteration_count} Iterations

Previous execution had {len(context)} messages. Context has been reset to prevent memory overflow.
Continue working toward the task with a fresh start."""


@activity.defn
async def generate_completion_summary(
    context: List[Dict[str, Any]],
    goal: str,
    model: str = "anthropic/claude-sonnet-4.5",
    structured_response: Dict[str, Any] = None,
    output_schema: Dict[str, Any] = None,
) -> Dict[str, Any]:
    """
    Generate a summary of what the agent accomplished.

    Called when agent reaches 100% completion to create a comprehensive
    summary of the work done, findings, and results.

    Args:
        context: Full message history
        goal: Original agent goal
        model: LLM model to use
        structured_response: Extracted structured output values from verifier
        output_schema: Schema definition with field descriptions

    Returns:
        Dict with:
            - summary: Text summary of work completed (up to 1000 tokens)
            - usage: Token usage stats
    """
    try:
        activity.heartbeat("Generating completion summary")

        # Import here to avoid circular dependency
        from helpers.llm import convert_context_to_messages, call_llm

        # Build structured output section if available
        structured_output_section = ""
        if structured_response and isinstance(structured_response, dict) and len(structured_response) > 0:
            structured_output_section = "\n\n## EXTRACTED STRUCTURED OUTPUT (MUST BE INCLUDED IN SUMMARY):\n"
            for key, value in structured_response.items():
                # Convert snake_case to Title Case for display
                formatted_key = key.replace("_", " ").title()
                # Format value (handle arrays)
                if isinstance(value, list):
                    formatted_value = ", ".join(str(v) for v in value)
                else:
                    formatted_value = str(value) if value is not None else ""
                structured_output_section += f"- **{formatted_key}:** {formatted_value}\n"

            structured_output_section += "\nIMPORTANT: You MUST include ALL of the above structured output values in your summary. These are the key deliverables the user is expecting."

        system_prompt = f"""You are summarizing the work completed by an AI agent.

ORIGINAL GOAL: {goal}
{structured_output_section}

Review the conversation history and provide a clear, comprehensive summary of:
1. What the agent accomplished
2. Key findings, results, or outputs
3. Any important decisions or actions taken
4. Final status/outcome

{"CRITICAL: Your summary MUST prominently feature the EXTRACTED STRUCTURED OUTPUT values listed above. These are the primary deliverables." if structured_output_section else ""}

Be thorough but concise. Focus on actionable information and concrete results.
Maximum length: ~1000 tokens."""

        # Convert context to messages (exclude system messages like blueprints)
        # Summarization needs assistant messages to see what the agent accomplished
        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(convert_context_to_messages(context, include_system=False, include_assistant=True))
        messages.append({
            "role": "user",
            "content": "Provide a comprehensive summary of what was accomplished." + (
                " Make sure to prominently include the structured output values." if structured_output_section else ""
            )
        })

        # Use call_llm which handles Rose model routing automatically
        result = await call_llm(
            messages=messages,
            model=model,
            temperature=0.3,
            max_tokens=1500,
        )

        summary = result.get("content", "")
        usage = result.get("usage", {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0})

        logger.info(
            "Summary generated",
            goal=goal[:50],
            summary_length=len(summary),
            tokens=usage.get("total_tokens", 0),
            has_structured_output=bool(structured_response),
        )

        return {
            "summary": summary,
            "usage": usage
        }

    except Exception as e:
        logger.error("Failed to generate summary", error=str(e), goal=goal)
        # Return empty summary with zero usage on error
        return {
            "summary": f"Agent completed goal: {goal}",
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        }
