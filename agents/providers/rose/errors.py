"""Typed error taxonomy for the Rose client.

Errors are classified by *cause*, not provider response code, so callers can
handle them uniformly across Anthropic / OpenRouter / Gemini / Kimi.

Classification rules (mirrors research/.../service/claude-token.ts:202-212
plus the agreed P1 contract change for 400):

    HTTP 401, 403           -> RoseAuthError      (rotates pooled token)
    HTTP 429                -> RoseRateLimitError (rotates pooled token)
    HTTP 400                -> RoseInvalidRequest (does NOT rotate; falls through)
    HTTP 5xx                -> RoseServerError    (retried in-place, then falls through)
    HTTP 404 / other        -> RoseServerError    (infra/edge unavailable; falls through —
                                                   never bare RoseError, which is NOT in
                                                   RoseClient._FALL_THROUGH_ERRORS)
    Stream stall / TTFT TO  -> RoseStallError     (does NOT rotate; falls through)
    Provider refusal        -> RoseRefusalError   (strict safety refusal; falls through)
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
    """Provider unavailable (5xx after retries, or infra/edge 404).

    5xx is retried in-place then falls through. Unexpected statuses such as a
    Cloudflare/edge 404 on Codex are raised immediately as this type so
    RoseClient falls through to openai-api-key / waterfall before first content.
    """


class RosePaymentRequiredError(RoseError):
    """402 from a provider — out of credits/quota (e.g. an exhausted Anthropic
    API key). Unlike a 429 it won't clear on a short retry, so the caller backs
    the credential off for a while instead of hammering it. Falls through."""


class RoseStallError(RoseError):
    """Provider opened the stream but produced no content within the TTFT window.

    No partial-stream recovery: the reader is closed and the call falls through
    to the next layer (waterfall, or terminal if waterfall is exhausted).
    """


class RoseRefusalError(RoseError):
    """Provider refused before producing content.

    This is treated as a fall-through condition so stricter primary models
    can defer to the pool waterfall instead of failing the user request.
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


class BrowserModelOutputValidationError(ValueError):
    """A completed response was received but did not describe a valid browser action."""

    def __init__(self, detail, *, response):
        super().__init__("Completed browser model response did not contain a valid action")
        self.private_detail = detail
        self.response = response
