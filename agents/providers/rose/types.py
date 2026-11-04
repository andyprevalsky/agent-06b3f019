"""Shared types for the Rose client — request inputs, stream chunks, and the
ClaudeAuthContext that carries pool-rotation metadata through the call.

Kept intentionally small and dataclass-based. No business logic here; that
lives in the per-layer modules (claude_auth.py, waterfall.py, client.py).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Literal, Optional

# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------


# Roles the Rose client accepts. We normalize to OpenAI-style roles in
# transforms.py before dispatching to provider-specific shapes.
MessageRole = Literal["system", "user", "assistant", "tool"]


@dataclass
class Message:
    """A normalized chat message — the input format every Rose call accepts.

    `content` is left as Any to support multimodal content arrays
    (text + image_url blocks); the transform layer is responsible for
    converting to provider-specific shapes.
    """

    role: MessageRole
    content: Any
    name: Optional[str] = None
    tool_call_id: Optional[str] = None


@dataclass
class ToolSchema:
    """OpenAI-style tool schema. Transform layer maps to Anthropic native
    tools or OpenRouter tool calling depending on the destination provider."""

    name: str
    description: str
    parameters: Dict[str, Any]


# ---------------------------------------------------------------------------
# claudeAuth context
# ---------------------------------------------------------------------------


# Source of a direct compute token, as returned by the backend.
#   - "user": the user's own subscription token
#   - "pool": one of the shared pooled tokens (LRU-rotated by the backend)
ComputeTokenType = Literal["claude", "gpt"]
ComputeTokenSource = Literal["user", "pool"]
ClaudeTokenSource = ComputeTokenSource
GptTokenSource = ComputeTokenSource


# Async callback the client invokes on a rotation-worthy failure (401/403/429
# after retry exhaustion). Implementation lives in helpers/llm.py and wraps
# the existing `mark_claude_token_rate_limited_activity` so we don't
# re-implement backend-side state.
MarkRateLimitedFn = Callable[
    ["ComputeAuthContext", int, Optional[str], Optional[str]],  # context, cooldown, until, reason
    Awaitable[bool],
]


# Async callback the client invokes to fetch a fresh token after rotation.
# Returns None if no token is available (claudeAuth disabled for the rest of
# this request — fall straight to waterfall). Implementation wraps
# `fetch_claude_max_token_activity`.
FetchFreshTokenFn = Callable[
    [str],  # user_id
    Awaitable[Optional["ComputeAuthContext"]],
]


HeartbeatTokenLeaseFn = Callable[
    ["ComputeAuthContext"],
    Awaitable[None],
]


@dataclass
class ComputeAuthContext:
    """Everything the Rose client needs to make a direct compute-token call
    and rotate the token if it fails.

    The backend owns the actual pool storage + LRU + cooldown tracking
    (see back-end/.../integrations/compute-code/token/*). The agents-side
    Rose client just routes by `token_type` and calls the two callbacks at
    the right moments.
    """

    token_type: ComputeTokenType
    token: str
    source: ComputeTokenSource
    user_id: str
    account_id: Optional[str] = None  # GPT/Codex account id when token_type == "gpt"
    pool_token_id: Optional[str] = None  # set when source == "pool"
    lineage_key: Optional[str] = None

    # Callbacks (injected by the caller in helpers/llm.py — kept out of the
    # client so we don't take a Temporal dependency in this module).
    mark_rate_limited: Optional[MarkRateLimitedFn] = None
    fetch_fresh: Optional[FetchFreshTokenFn] = None
    heartbeat_lease: Optional[HeartbeatTokenLeaseFn] = None

    # Per-request budget for rotations after a stall. Usage-limit and auth
    # failures rotate through every subscription the backend can still lease
    # (bounded by the call deadline and never repeating a lease) before any
    # funded key. 0 disables client rotation: the caller owns it.
    max_rotations: int = 2


class ClaudeAuthContext(ComputeAuthContext):
    """Back-compat constructor for Claude direct-token callers.

    Runtime behavior is the generic `ComputeAuthContext`; only provider routing
    in RoseClient/transport cares that `token_type == "claude"`.
    """

    def __init__(
        self,
        token: str,
        source: ClaudeTokenSource,
        user_id: str,
        pool_token_id: Optional[str] = None,
        lineage_key: Optional[str] = None,
        mark_rate_limited: Optional[MarkRateLimitedFn] = None,
        fetch_fresh: Optional[FetchFreshTokenFn] = None,
        heartbeat_lease: Optional[HeartbeatTokenLeaseFn] = None,
        max_rotations: int = 2,
    ) -> None:
        super().__init__(
            token_type="claude",
            token=token,
            source=source,
            user_id=user_id,
            account_id=None,
            pool_token_id=pool_token_id,
            lineage_key=lineage_key,
            mark_rate_limited=mark_rate_limited,
            fetch_fresh=fetch_fresh,
            heartbeat_lease=heartbeat_lease,
            max_rotations=max_rotations,
        )


class GptAuthContext(ComputeAuthContext):
    """Back-compat constructor for GPT/Codex direct-token callers."""

    def __init__(
        self,
        token: str,
        source: GptTokenSource,
        user_id: str,
        account_id: Optional[str] = None,
        pool_token_id: Optional[str] = None,
        lineage_key: Optional[str] = None,
        mark_rate_limited: Optional[MarkRateLimitedFn] = None,
        fetch_fresh: Optional[FetchFreshTokenFn] = None,
        heartbeat_lease: Optional[HeartbeatTokenLeaseFn] = None,
        max_rotations: int = 2,
    ) -> None:
        super().__init__(
            token_type="gpt",
            token=token,
            source=source,
            user_id=user_id,
            account_id=account_id,
            pool_token_id=pool_token_id,
            lineage_key=lineage_key,
            mark_rate_limited=mark_rate_limited,
            fetch_fresh=fetch_fresh,
            heartbeat_lease=heartbeat_lease,
            max_rotations=max_rotations,
        )


# ---------------------------------------------------------------------------
# Stream chunks (output)
# ---------------------------------------------------------------------------


# What kind of chunk this is. Callers iterating the stream switch on `kind`.
ChunkKind = Literal[
    "metadata",  # first chunk: actual_model, pool_name, request_id
    "content",  # text delta
    "tool_call",  # complete tool-call (name + arguments JSON)
    "reasoning",  # reasoning_content delta (extended thinking models)
    "codex_reasoning_item",  # GPT Responses reasoning item with encrypted_content
    "usage",  # final chunk: token counts + cache stats
    "restart",  # the attempt so far was abandoned (see truncation.py); drop accumulated output
    "done",  # stream finished cleanly
]


@dataclass
class StreamChunk:
    """One unit of output from `RoseClient.complete()`.

    The order is always: one `metadata` chunk first, then any number of
    `content` / `tool_call` / `reasoning` chunks, then exactly one `usage`
    chunk, then exactly one `done` chunk. Failures raise instead of
    yielding an error chunk. Callers that opt into cut-off recovery may also
    see `restart` chunks, each followed by a fresh attempt in the same order.
    """

    kind: ChunkKind
    data: Dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Result envelope (helper)
# ---------------------------------------------------------------------------


@dataclass
class RoseResponse:
    """Convenience accumulator for callers that don't want to iterate the
    stream — call `RoseClient.collect()` to get one of these populated."""

    content: str = ""
    reasoning: str = ""
    tool_calls: List[Dict[str, Any]] = field(default_factory=list)
    codex_reasoning_items: List[Dict[str, Any]] = field(default_factory=list)
    actual_model: str = ""
    pool_name: str = ""
    usage: Dict[str, Any] = field(default_factory=dict)
    timing: Dict[str, Any] = field(default_factory=dict)
    request_id: str = ""
    # Set when claudeAuth failed before first content and we fell through to
    # the waterfall — one of the strings classify_claude_token_error returns
    # ("invalid_request" | "auth_error" | "rate_limit" | "server_error").
    # The workflow uses this to decide whether to rotate the token.
    claude_token_error: Optional[str] = None
    gpt_token_error: Optional[str] = None
