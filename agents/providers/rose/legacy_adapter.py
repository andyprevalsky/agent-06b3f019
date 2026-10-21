"""Adapter helpers used by `helpers/llm.py` while the legacy call sites
migrate onto `RoseClient`.

This file is the *only* place that knows about the legacy
`is_rose_model` / `claude_token` / `claude_token_error` shape. The rest of
the rose/ module sees nothing of the old contract — it just speaks
`PoolName` + `ClaudeAuthContext` + typed errors.

Everything here is synchronous + dependency-light so callers can use it
inside Temporal activities without dragging the workflow sandbox into the
rose/ package.
"""

from __future__ import annotations

from typing import Optional

from providers.rose.errors import (
    RoseAuthError,
    RoseError,
    RoseInvalidRequest,
    RoseRateLimitError,
    RoseRefusalError,
    RoseServerError,
    RoseStallError,
)
from providers.rose.pools import PoolName
from providers.rose.types import ClaudeAuthContext, GptAuthContext

# Map of every legacy model string the agent passes for "I want a Rose pool".
# The TS edge function accepted any of these and routed by pool name; we
# preserve that lookup here so call sites don't have to change strings.
_MODEL_TO_POOL: dict[str, PoolName] = {
    "rose-labs/rose-1-mini": "rose-1-mini",
    "rose-labs/rose-1-flash": "rose-1-flash",
    # Legacy lite → flash (persisted agents / older clients).
    "rose-labs/rose-1-lite": "rose-1-flash",
    "rose-labs/rose-1-ultra": "rose-1-ultra",
    "rose-labs/rose-1-browser-use": "rose-1-browser-use",
    "rose-labs/rose-1-oss": "rose-1-oss",
    "rose-labs/rose-local": "rose-local",
    "rose-local": "rose-local",
    "rose": "rose-1-flash",
    "rose-flash": "rose-1-flash",
    "rose-fast": "rose-1-flash",
    "rose-lite": "rose-1-flash",
    "rose-mini": "rose-1-mini",
    "rose-ultra": "rose-1-ultra",
    "rose-1-flash": "rose-1-flash",
    "rose-1-lite": "rose-1-flash",
}


def is_rose_model(model: Optional[str]) -> bool:
    """True when the legacy model string maps to a Rose pool.

    Mirrors the inline check that lived in every call site:
    `"rose-labs" in model.lower() or model.lower() in ["rose", "rose-ultra"]`.
    """
    if not model:
        return False
    return pool_for_model(model) is not None


def pool_for_model(model: str) -> Optional[PoolName]:
    """Return the Rose pool name for a legacy model string, or None."""
    if not model:
        return None
    lowered = model.lower()
    if lowered in _MODEL_TO_POOL:
        return _MODEL_TO_POOL[lowered]
    # Fuzzy fall-back: "rose-labs/..." with anything after mini/flash/lite/ultra.
    if "rose-labs" in lowered:
        if "local" in lowered:
            return "rose-local"
        if "browser-use" in lowered:
            return "rose-1-browser-use"
        if "oss" in lowered:
            return "rose-1-oss"
        if "ultra" in lowered:
            return "rose-1-ultra"
        if "mini" in lowered:
            return "rose-1-mini"
        if "flash" in lowered or "lite" in lowered:
            return "rose-1-flash"
        return "rose-1-flash"
    return None


def claude_auth_from_token(claude_token: Optional[str]) -> Optional[ClaudeAuthContext]:
    """Build a `ClaudeAuthContext` from the legacy `claude_token: str` arg.

    The workflow (agent_workflow.py) already owns rotation — it watches the
    `claude_token_error` field in the usage dict, marks the offending token
    rate-limited via `mark_claude_token_rate_limited_activity`, then refetches
    on the next call. So the activity-level context here intentionally has
    *no* rotation callbacks: a single attempt with the supplied token, then
    fall through to waterfall. `claude_auth.py` handles in-place 429/5xx
    retries inside that single attempt.

    The user_id="" + source="user" defaults are placeholders — they only
    matter when callbacks are wired, and they're not. Keeping them avoids
    a None branch inside `claude_auth.py`.
    """
    if not claude_token:
        return None
    return ClaudeAuthContext(
        token=claude_token,
        source="user",
        user_id="",
        pool_token_id=None,
        mark_rate_limited=None,
        fetch_fresh=None,
        max_rotations=0,  # workflow handles rotation; activity does one attempt
    )


def gpt_auth_from_token(
    gpt_token: Optional[str],
    account_id: Optional[str] = None,
) -> Optional[GptAuthContext]:
    """Build a `GptAuthContext` from a legacy GPT token string."""
    if not gpt_token:
        return None
    return GptAuthContext(
        token=gpt_token,
        source="user",
        user_id="",
        account_id=account_id,
        pool_token_id=None,
        max_rotations=0,
    )


def classify_claude_token_error(exc: RoseError) -> str:
    """Translate a typed `RoseError` from claude_auth into the string the
    workflow expects in `usage.claude_token_error`.

    Values match the strings the TS edge function emitted:
      - "auth_error"      -> 401/403, or rotation exhausted
      - "rate_limit"      -> 429 after retries
      - "stall"           -> TTFT miss (RoseStallError)
      - "invalid_request" -> 400 (does NOT trigger rotation upstream)
      - "refusal"         -> provider safety refusal
      - "server_error"    -> 5xx after retries
    """
    if isinstance(exc, RoseAuthError):
        return "auth_error"
    if isinstance(exc, RoseRateLimitError):
        return "rate_limit"
    if isinstance(exc, RoseStallError):
        return "stall"
    if isinstance(exc, RoseInvalidRequest):
        return "invalid_request"
    if isinstance(exc, RoseRefusalError):
        return "refusal"
    if isinstance(exc, RoseServerError):
        return "server_error"
    return "server_error"


def classify_gpt_token_error(exc: RoseError) -> str:
    """Translate a typed `RoseError` from gpt_auth into workflow metadata."""
    return classify_claude_token_error(exc)
