"""Typed error taxonomy for the Rose client.

Errors are classified by *cause*, not provider response code, so callers can
handle them uniformly across Anthropic / OpenRouter / Gemini / Kimi.

Classification rules (mirrors research/.../service/claude-token.ts:202-212
plus the agreed P1 contract change for 400):

    HTTP 401, 403           -> RoseAuthError      (rotates pooled token)
    HTTP 429                -> RoseRateLimitError (rotates pooled token)
    HTTP 400                -> RoseInvalidRequest (does NOT rotate; falls through)
    HTTP 5xx                -> RoseServerError    (retried in-place, then falls through)
    Stream stall / TTFT TO  -> RoseStallError     (does NOT rotate; falls through)
    All pool models failed  -> RoseAllFailed      (terminal; carries per-step errors)
    Deadline exceeded       -> RoseDeadlineError  (terminal)
"""

from __future__ import annotations

from typing import List, Optional


class RoseError(Exception):
    """Base class for all Rose client errors."""

    def __init__(self, message: str, *, status: Optional[int] = None) -> None:
        super().__init__(message)
        self.status = status


class RoseAuthError(RoseError):
    """401/403 from a provider — pooled Claude tokens rotate, others propagate."""


class RoseRateLimitError(RoseError):
    """429 from a provider — pooled Claude tokens rotate after retry exhaustion."""


class RoseInvalidRequest(RoseError):
    """400 from a provider — request is malformed; do NOT rotate the token.

    Falls through claudeAuth -> waterfall (other providers may validate
    differently). Burning a token here would chain through the entire pool
    on the next request with the same payload.
    """


class RoseServerError(RoseError):
    """5xx from a provider — retried in-place with exponential backoff."""


class RoseStallError(RoseError):
    """Provider opened the stream but produced no content within the TTFT window,
    or went idle mid-stream past the idle timeout.

    No partial-stream recovery: the reader is closed and the call falls through
    to the next layer (waterfall, or terminal if waterfall is exhausted).
    """


class RoseDeadlineError(RoseError):
    """Top-level `deadline_s` for `RoseClient.complete()` exceeded.

    This is *terminal* — by the time it fires every inner attempt has already
    been cancelled.
    """


class RoseAllFailed(RoseError):
    """Every model in the waterfall returned an error.

    `step_errors` preserves the per-step failure (model name + error) so the
    caller can log a coherent picture of what went wrong end-to-end.
    """

    def __init__(self, message: str, *, step_errors: List["RoseStepError"]) -> None:
        super().__init__(message)
        self.step_errors = step_errors


class RoseStepError:
    """One step of a waterfall attempt — the model that was tried and the
    error it produced. Plain dataclass-like; not raised directly."""

    __slots__ = ("model", "error")

    def __init__(self, model: str, error: RoseError) -> None:
        self.model = model
        self.error = error

    def __repr__(self) -> str:
        return f"RoseStepError(model={self.model!r}, error={self.error!r})"
