"""Tool for compressing agent context using LLM summarization."""

from typing import List, Dict
from temporalio import activity
import structlog
from openai import AsyncOpenAI

from config import load_config

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
        
        config = load_config()
        client = AsyncOpenAI(
            api_key=config.openrouter.api_key,
            base_url=config.openrouter.base_url
        )
        
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
        
        response = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "user", "content": prompt}
            ],
            temperature=0.3,  # Lower temp for consistent analysis
            max_tokens=1000
        )
        
        learnings = response.choices[0].message.content
        
        logger.info(
            "Context compressed",
            original_messages=len(context),
            learnings_length=len(learnings),
            tokens_used=response.usage.total_tokens
        )
        
        return learnings
        
    except Exception as e:
        logger.error("Failed to compress context", error=str(e))
        # Fallback: just return a simple summary
        return f"""## Context Reset After {iteration_count} Iterations

Previous execution had {len(context)} messages. Context has been reset to prevent memory overflow.
Continue working toward the task with a fresh start."""

