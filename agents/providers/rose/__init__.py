"""Rose completions client — direct provider calls from agents.

Replaces the Supabase edge function at research/supabase/functions/completions/.
Both rose-1-lite and rose-1-ultra share one code path; the only difference is
which model pool they use (see pools.py).

Public API:

    from providers.rose import RoseClient, ClaudeAuthContext, GptAuthContext, Message, ToolSchema

    client = RoseClient()
    async for chunk in client.complete(
        pool="rose-1-lite",
        messages=[...],
        claude_auth=ClaudeAuthContext(...),  # optional
        agent_id=agent_id,
        request_id=request_id,
        call_site="my_call_site",
    ):
        ...

Failure modes raise typed errors from `errors.py`. The orchestration in
`client.py` is responsible for choosing claudeAuth -> waterfall ordering and
propagating typed errors through the deadline.
"""

from providers.rose.client import RoseClient
from providers.rose.errors import (
    RoseAllFailed,
    RoseAuthError,
    RoseDeadlineError,
    RoseError,
    RoseInvalidRequest,
    RoseRateLimitError,
    RoseRefusalError,
    RoseServerError,
    RoseStallError,
    RoseStepError,
)
from providers.rose.legacy_adapter import (
    classify_claude_token_error,
    classify_gpt_token_error,
    claude_auth_from_token,
    gpt_auth_from_token,
    is_rose_model,
    pool_for_model,
)
from providers.rose.pools import POOL_REGISTRY, PoolName, PoolSpec, all_pool_names, get_pool
from providers.rose.streaming import parse_anthropic_sse, parse_openai_sse, parse_responses_sse
from providers.rose.structured_output import StructuredOutputAccumulator, StructuredOutputCardinalityError
from providers.rose.types import (
    ChunkKind,
    ClaudeAuthContext,
    ClaudeTokenSource,
    ComputeAuthContext,
    FetchFreshTokenFn,
    GptAuthContext,
    GptTokenSource,
    MarkRateLimitedFn,
    Message,
    MessageRole,
    RoseResponse,
    StreamChunk,
    ToolSchema,
)

# RoseClient is exported once client.py lands (next task in P1).
# Until then, the type stubs above are sufficient for type-checking callers
# that are being prepared for migration.

__all__ = [
    # errors
    "RoseError",
    "RoseAuthError",
    "RoseRateLimitError",
    "RoseInvalidRequest",
    "RoseRefusalError",
    "RoseServerError",
    "RoseStallError",
    "RoseDeadlineError",
    "RoseAllFailed",
    "RoseStepError",
    # client
    "RoseClient",
    # legacy adapter
    "claude_auth_from_token",
    "classify_claude_token_error",
    "gpt_auth_from_token",
    "classify_gpt_token_error",
    "is_rose_model",
    "pool_for_model",
    # pools
    "POOL_REGISTRY",
    "PoolName",
    "PoolSpec",
    "all_pool_names",
    "get_pool",
    # streaming
    "parse_anthropic_sse",
    "parse_openai_sse",
    "parse_responses_sse",
    "StructuredOutputAccumulator",
    "StructuredOutputCardinalityError",
    # types
    "ChunkKind",
    "ClaudeAuthContext",
    "ClaudeTokenSource",
    "ComputeAuthContext",
    "GptAuthContext",
    "GptTokenSource",
    "FetchFreshTokenFn",
    "MarkRateLimitedFn",
    "Message",
    "MessageRole",
    "RoseResponse",
    "StreamChunk",
    "ToolSchema",
]
