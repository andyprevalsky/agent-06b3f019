"""Tool for compressing agent context and generating completion summaries."""

from typing import List, Dict, Any
from temporalio import activity
import structlog

logger = structlog.get_logger()

# Tool name → Human-readable label mapping for summary display
TOOL_DISPLAY_NAMES = {
    "web_search": "Web Searches",
    "spawn_sub_agent": "Sub Agent Spawned",
    "spawn_browser_agent": "Browser Agents Spawned",
    "spawn_claude_code_agent": "Code Agents Spawned",
    "deep_research": "Deep Research Runs",
    "find_all": "Find All Queries",
    "enrich": "Enrichments",
    "monitor": "Monitors Created",
    "check_monitor_events": "Monitor Checks",
    "message_person": "Messages Sent",
    "search_user_network_for_people": "Network Searches",
    "send_message_to_user": "User Messages",
    "wait_for": "Wait Operations",
    "set_plan": "Plans Set",
    "search_x402_bazaar": "Bazaar Searches",
    "pay_for_x402_bazaar_service": "Bazaar Payments",
}

# Tools to exclude from the summary (internal/meta tools)
EXCLUDED_TOOLS = {
    "check_progress",
    "completion_summary",
    "attempt_completion",
    "enable_write_permissions",
    "request_user_approval",
    "request_user_signup",
}


def _count_tool_usage(context: List[Dict[str, Any]]) -> Dict[str, int]:
    """
    Count tool usage from context messages.

    Only counts FINISHED tool messages to avoid double-counting
    IN_PROGRESS and FINISHED for the same tool call.

    Args:
        context: Full message history

    Returns:
        Dict mapping tool_name -> count
    """
    tool_counts: Dict[str, int] = {}
    for msg in context:
        if msg.get("role") == "TOOL":
            metadata = msg.get("metadata", {})
            tool_name = metadata.get("toolName")
            tool_status = metadata.get("toolStatus")
            if tool_name and tool_name not in EXCLUDED_TOOLS and tool_status == "FINISHED":
                tool_counts[tool_name] = tool_counts.get(tool_name, 0) + 1
    return tool_counts


def _merge_tool_counts(own_counts: Dict[str, int], sub_agent_counts: Dict[str, int]) -> Dict[str, int]:
    """
    Merge tool counts from this agent and sub-agents.

    Args:
        own_counts: Tool counts from this agent's context
        sub_agent_counts: Aggregated tool counts from sub-agents

    Returns:
        Merged dict with total counts per tool
    """
    merged = own_counts.copy()
    for tool_name, count in sub_agent_counts.items():
        merged[tool_name] = merged.get(tool_name, 0) + count
    return merged


def _format_tool_stats_footer(tool_counts: Dict[str, int]) -> str:
    """
    Format tool usage statistics as a markdown footer.

    Args:
        tool_counts: Dict mapping tool_name -> count

    Returns:
        Formatted markdown string
    """
    if not tool_counts:
        return ""

    total_calls = sum(tool_counts.values())
    footer = f"\n\n---\n### Tool Usage Statistics\n**Total:** {total_calls}\n\n"

    # Sort by count descending
    for tool_name, count in sorted(tool_counts.items(), key=lambda x: -x[1]):
        display_name = TOOL_DISPLAY_NAMES.get(tool_name, tool_name.replace("_", " ").title())
        footer += f"**{display_name}:** {count}\n"

    return footer


@activity.defn
async def compress_context(
    context: List[Dict],
    iteration_count: int,
    model: str = "rose-labs/rose-1-lite"
) -> Dict:
    """
    Use LLM to compress context into key learnings.

    Args:
        context: Full message history (first USER message is the goal)
        iteration_count: Current iteration number
        model: LLM model to use for compression

    Returns:
        Dict with 'learnings' string and 'usage' dict for cost tracking
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
            skip_cache=True,  # One-shot call — no cache reuse
            call_site="context_compression",
        )

        learnings = result.get("content", "")
        usage = result.get("usage", {})

        logger.info(
            "Context compressed",
            original_messages=len(context),
            learnings_length=len(learnings),
            tokens_used=usage.get("total_tokens", 0)
        )

        return {"learnings": learnings, "usage": usage}

    except Exception as e:
        logger.error("Failed to compress context", error=str(e))
        # Fallback: just return a simple summary
        return {
            "learnings": f"""## Context Reset After {iteration_count} Iterations

Previous execution had {len(context)} messages. Context has been reset to prevent memory overflow.
Continue working toward the task with a fresh start.""",
            "usage": {},
        }


@activity.defn
async def generate_completion_summary(
    context: List[Dict[str, Any]],
    goal: str,
    model: str = "rose-labs/rose-1-lite",
    structured_response: Dict[str, Any] = None,
    output_schema: Dict[str, Any] = None,
    sub_agent_tool_counts: Dict[str, int] = None,
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
        sub_agent_tool_counts: Aggregated tool counts from sub-agents

    Returns:
        Dict with:
            - summary: Text summary of work completed (up to 1000 tokens) + tool stats footer
            - usage: Token usage stats
            - tool_counts: Merged tool counts (for parent aggregation)
    """
    try:
        activity.heartbeat("Generating completion summary")

        # Import here to avoid circular dependency
        from helpers.llm import convert_context_to_messages, call_llm

        # Build context about structured output (for LLM awareness, not for formatting)
        structured_output_context = ""
        if structured_response and isinstance(structured_response, dict) and len(structured_response) > 0:
            structured_output_context = "\n\nSTRUCTURED OUTPUT DELIVERED:\n"
            for key, value in structured_response.items():
                formatted_key = key.replace("_", " ").title()
                if isinstance(value, list):
                    formatted_value = ", ".join(str(v) for v in value)
                else:
                    formatted_value = str(value) if value is not None else ""
                structured_output_context += f"- {formatted_key}: {formatted_value}\n"

        system_prompt = f"""You are summarizing the work completed by an AI agent.

ORIGINAL GOAL: {goal}
{structured_output_context}

Write a BRIEF 1-2 sentence summary of what was accomplished. Focus on the outcome and key result.
Do NOT use markdown formatting, bullet points, or section headers.
Do NOT list the structured output values - they are displayed separately in the UI.
Just write plain text describing what was done."""

        # Convert context to messages (exclude system messages like blueprints)
        # Summarization needs assistant messages to see what the agent accomplished
        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(convert_context_to_messages(context, include_system=False, include_assistant=True))
        messages.append({
            "role": "user",
            "content": "Provide a brief 1-2 sentence summary of what was accomplished. Plain text only, no markdown."
        })

        # Use call_llm which handles Rose model routing automatically
        result = await call_llm(
            messages=messages,
            model=model,
            temperature=0.3,
            max_tokens=200,  # Brief summary only needs ~50-100 tokens
            skip_cache=True,  # One-shot call — no cache reuse
            call_site="completion_summary",
        )

        summary = result.get("content", "")
        usage = result.get("usage", {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0})

        # Count this agent's tool usage and merge with sub-agent counts
        # (returned as structured data, not appended as text)
        own_tool_counts = _count_tool_usage(context)
        total_tool_counts = _merge_tool_counts(own_tool_counts, sub_agent_tool_counts or {})

        logger.info(
            "Summary generated",
            goal=goal[:50],
            summary_length=len(summary),
            tokens=usage.get("total_tokens", 0),
            has_structured_output=bool(structured_response),
            tool_count=sum(total_tool_counts.values()) if total_tool_counts else 0,
        )

        return {
            "summary": summary,
            "usage": usage,
            "tool_counts": total_tool_counts,
        }

    except Exception as e:
        logger.error("Failed to generate summary", error=str(e), goal=goal)
        # Return empty summary with zero usage on error
        return {
            "summary": f"Agent completed goal: {goal}",
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            "tool_counts": {},
        }
