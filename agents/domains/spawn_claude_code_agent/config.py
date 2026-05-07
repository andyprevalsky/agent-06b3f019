"""Spawn-claude-code-agent domain configuration — constants and defaults."""

from __future__ import annotations

from typing import Final

# Silence timeout — if no output for this long, Claude Code is "done talking"
SILENCE_TIMEOUT_S: Final[float] = 1.0

# Maximum runtime before timeout
MAX_RUNTIME_S: Final[int] = 1800  # 30 minutes (matches E2B SANDBOX_TIMEOUT_MS)

# Fatal error patterns in Claude Code output that should immediately abort the session.
# These are unrecoverable inside a headless sandbox (e.g., OAuth login can't be completed).
FATAL_ERROR_PATTERNS: Final[list[tuple[str, str]]] = [
    (
        "authentication_error",
        "Claude Code authentication failed (401). The user's Claude credentials are invalid or expired. "
        "They need to re-sync their Claude Code credentials.",
    ),
    (
        "Invalid authentication credentials",
        "Claude Code authentication failed. The user's API key or OAuth token is invalid.",
    ),
    (
        "API Error: 401",
        "Claude Code received a 401 from the Anthropic API. The user's credentials need to be refreshed.",
    ),
    (
        "Please run /login",
        "Claude Code is requesting interactive login, which cannot be completed in a sandbox.",
    ),
    (
        "You've hit your limit",
        "Claude Code OAuth credentials are rate-limited. The credential must be rotated until the reset time.",
    ),
    (
        "/rate-limit-options",
        "Claude Code OAuth credentials are rate-limited. The credential must be rotated instead of waiting in the sandbox.",
    ),
    (
        "Credit balance too low",
        "Claude Code API billing credit balance is too low. Configure healthy Claude Code OAuth credentials "
        "or refill the shared Anthropic API billing account.",
    ),
    (
        "Add funds: https://platform.claude.com/settings/billing",
        "Claude Code API billing credit balance is too low. Configure healthy Claude Code OAuth credentials "
        "or refill the shared Anthropic API billing account.",
    ),
]

# Suppress PTY echo from triggering silence detection for this window
ECHO_SUPPRESS_S: Final[float] = 1.0

# After this many unchanged outputs, stop calling LLM (output is stale)
MAX_UNCHANGED_OUTPUTS: Final[int] = 3

# E2B sandbox cost: $0.000028/second = 0.0028 cents/second
E2B_COST_CENTS_PER_SECOND: Final[float] = 0.0028
