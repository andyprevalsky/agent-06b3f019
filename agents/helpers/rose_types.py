"""
RoseCompletionChunk — canonical SSE shape from Rose completions endpoint.

Source of truth: research/supabase/functions/completions/index.ts
TypeScript mirror: back-end/src/lib/chat/supabaseCompletions.ts (CompletionChunk)

All streaming paths (Anthropic direct, OpenRouter passthrough, claude-auth)
produce chunks conforming to this shape.
"""

from typing import List, Optional
from typing_extensions import TypedDict


class ChunkDelta(TypedDict, total=False):
    content: str       # Text or JSON tokens
    reasoning: str     # Thinking/reasoning from reasoning-capable models
    role: str          # Only on first chunk (OpenRouter includes this)


class ChunkChoice(TypedDict, total=False):
    index: int
    delta: ChunkDelta
    finish_reason: Optional[str]  # 'stop' on final content chunk


class ChunkUsage(TypedDict, total=False):
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


class RoseCompletionChunk(TypedDict, total=False):
    # Always present
    choices: List[ChunkChoice]
    requested_model: str
    actual_model: str
    pool_name: str
    pool_size: int
    # Only on final chunk (when stream_options.include_usage=true)
    usage: ChunkUsage
