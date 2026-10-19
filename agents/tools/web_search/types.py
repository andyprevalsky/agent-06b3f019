"""Web search domain types."""

from dataclasses import dataclass
from enum import Enum
from typing import Any, Awaitable, Callable, Optional, TypedDict

# Type alias for execute_activity callable
ExecuteActivityCallable = Callable[..., Awaitable[Any]]


class SearchResult(TypedDict):
    """Structured result from a web search."""

    answer: str
    sources: list[str]
    query: str
    provider: str


class ProviderFailureKind(str, Enum):
    """Structured outcome of a failed provider request (from HTTP status / exception type)."""

    RATE_LIMITED = "rate_limited"  # HTTP 429 or the provider's typed rate-limit error
    UNAVAILABLE = "unavailable"  # HTTP 5xx
    TIMEOUT = "timeout"
    TRANSPORT = "transport"  # connection-level failure before a response
    REJECTED = "rejected"  # other HTTP 4xx (auth, plan, bad request): not retried
    NO_RESULTS = "no_results"  # keyless metasearch: no engine returned results
    ERROR = "error"  # unexpected exception type


TRANSIENT_FAILURE_KINDS = frozenset(
    {
        ProviderFailureKind.RATE_LIMITED,
        ProviderFailureKind.UNAVAILABLE,
        ProviderFailureKind.TIMEOUT,
        ProviderFailureKind.TRANSPORT,
    }
)


@dataclass
class ProviderFailure:
    """One provider's final failure for a web search call."""

    provider: str
    kind: ProviderFailureKind
    http_status: Optional[int] = None
    retry_after_seconds: Optional[float] = None
    error_type: str = ""
    attempts: int = 1

    @property
    def transient(self) -> bool:
        return self.kind in TRANSIENT_FAILURE_KINDS

    def to_detail(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "kind": self.kind.value,
            "http_status": self.http_status,
            "retry_after_seconds": self.retry_after_seconds,
            "error_type": self.error_type,
            "attempts": self.attempts,
        }

    def describe(self) -> str:
        """Truthful one-line summary shown to the model and in the FE chip."""
        status = f"HTTP {self.http_status}" if self.http_status is not None else self.error_type
        if self.kind is ProviderFailureKind.RATE_LIMITED:
            parts = [part for part in (status, self._retry_after_text()) if part]
            text = f"{self.provider} rate-limited" + (f" ({', '.join(parts)})" if parts else "")
        elif self.kind is ProviderFailureKind.UNAVAILABLE:
            text = f"{self.provider} unavailable ({status})"
        elif self.kind is ProviderFailureKind.TIMEOUT:
            text = f"{self.provider} timed out"
        elif self.kind is ProviderFailureKind.TRANSPORT:
            text = f"{self.provider} connection failed ({status})"
        elif self.kind is ProviderFailureKind.REJECTED:
            text = f"{self.provider} rejected the request ({status})"
        elif self.kind is ProviderFailureKind.NO_RESULTS:
            text = (
                f"{self.provider} keyless metasearch: no engine returned results "
                "(engines that block or rate-limit this host are indistinguishable from empty results)"
            )
        else:
            text = f"{self.provider} failed ({status})"
        if self.attempts > 1:
            text += f" after {self.attempts} attempts"
        return text

    def _retry_after_text(self) -> str:
        if self.retry_after_seconds is None:
            return ""
        return f"Retry-After {self.retry_after_seconds:g}s"
